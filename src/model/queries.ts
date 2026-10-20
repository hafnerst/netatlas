/**
 * Pure queries over the network model: reference parsing, existence checks,
 * "what belongs to this object" (used for highlighting) and text search.
 * No layout, rendering or YAML knowledge.
 */
import { appProfile } from './applications';
import { cnetRef, guestsOf, hostOf, portGroupRef, virtRefTarget, virtualRelated, vnicPortGroup, vswitchRef } from './virtual';
import { addressOwners, associatedInterfaces, deviceNetworks, endNetworks, endVlans, interfaceNetworks, isBridgePort, linkNetworks, networkMembers, portBadgeText, portL2, vlanRangesText } from './derive';
import { Device, Model, Route, deviceInterfaces, ifaceKey, relationDevices, routeKey } from './types';
import { capabilities } from './capabilities';
import { deviceTypeLabel, kindLabel, roleLabel, modesOf, purposeDef } from './device-types';
import { deviceServices } from './service-registry';

export function splitRef(ref: string): [string, string] {
  const i = ref.indexOf(':');
  return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

/** The ref of a route ("route:<device>:<index>"). */
export function routeRefOf(r: Route): string {
  return 'route:' + routeKey(r.device, r.index);
}

/**
 * What a route points at, as refs: its exit interface and the interfaces
 * that own its next-hop address (the address configured on them), with
 * their devices. A next hop no interface has points at nothing.
 */
export function routeTargets(model: Model, r: Route): string[] {
  const out: string[] = [];
  if (r.iface !== undefined) out.push(`iface:${r.device}:${r.iface}`);
  if (r.via !== undefined) {
    for (const o of addressOwners(model, r.via)) {
      if (out.indexOf(`iface:${o.device}:${o.iface}`) < 0) out.push(`iface:${o.device}:${o.iface}`);
      if (o.device !== r.device && out.indexOf('device:' + o.device) < 0) out.push('device:' + o.device);
    }
  }
  return out;
}

/** The routes of the model whose exit interface is `iface`, or whose next hop is an address of it. */
export function routesUsing(model: Model, device: string, iface: string): Route[] {
  const out: Route[] = [];
  for (const d of model.devices) {
    for (const r of d.routes) {
      if (r.device === device && r.iface === iface) out.push(r);
      else if (r.via !== undefined && addressOwners(model, r.via).some((o) => o.device === device && o.iface === iface)) out.push(r);
    }
  }
  return out;
}

export function refExists(model: Model, ref: string): boolean {
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  switch (kind) {
    case 'device':
      return ix.devices.has(id);
    case 'link':
      return ix.links.has(id);
    case 'relation':
    case 'hub':
      return ix.relations.has(id);
    case 'network':
      return ix.networks.has(id);
    case 'group':
      return ix.groups.has(id);
    case 'iface':
      // (a device's interface, or one of its opaque ports)
      return ix.interfaces.has(id) || ix.opaquePorts.has(id);
    case 'interconnect':
      return ix.interconnects.has(id);
    case 'route':
      return ix.routes.has(id);
    case 'protocol':
      return model.protocols.has(id);
    case 'vswitch':
    case 'portgroup':
    case 'cnet':
      return !!virtRefTarget(model, ref);
    default:
      return false;
  }
}

/**
 * What is attached to an interface, relation or link, by binding: shown
 * while the pointer is on it (the selection shows the wider relatedRefs).
 *
 *   interface  itself (its entry, port and end label), every relation bound
 *              to it and the cable plugged into it; an aggregate also the
 *              cables of its member ports, a member port its aggregate;
 *   relation   itself (lanes, hub, label) and the interfaces it is bound to
 *              at every end (the device, where it is bound to the device);
 *   link       itself and the ports at both ends, with their aggregates;
 *   route      itself, its exit interface and the interface its next hop
 *              is an address of.
 *
 * Null for anything else (devices, networks, groups …): nothing to show.
 */
export function attachedRefs(model: Model, ref: string): Set<string> | null {
  const ix = model.index;
  let [kind, id] = splitRef(ref);
  if (kind === 'hub') kind = 'relation';
  const out = new Set<string>();
  const endRef = (device: string, iface: string | undefined): string => (iface === undefined ? 'device:' + device : `iface:${device}:${iface}`);
  const aggregates = (device: string, iface: string): string[] => {
    const d = ix.devices.get(device);
    return d ? d.logical.filter((i) => i.members.indexOf(iface) >= 0).map((i) => `iface:${device}:${i.id}`) : [];
  };
  const addLink = (lid: string): void => {
    const l = ix.links.get(lid);
    if (!l) return;
    out.add('link:' + lid);
    for (const e of [l.a, l.b]) {
      out.add(endRef(e.device, e.iface));
      if (e.iface !== undefined) for (const a of aggregates(e.device, e.iface)) out.add(a);
    }
  };
  switch (kind) {
    case 'interconnect': {
      const ic = ix.interconnects.get(id);
      if (!ic) return null;
      out.add(ref);
      for (const e of ic.endpoints) out.add(`iface:${e.device}:${e.port}`);
      return out;
    }
    case 'iface': {
      // an opaque port: its interconnect (and the interconnect's other ports)
      if (ix.opaquePorts.has(id)) {
        out.add('iface:' + id);
        const ic = ix.portInterconnect.get(id);
        if (ic) out.add('interconnect:' + ic);
        return out;
      }
      const inf = ix.interfaces.get(id);
      if (!inf) return null;
      out.add('iface:' + id);
      for (const r of model.relations) {
        if (!r.endpoints.some((e) => e.device === inf.device && e.iface === inf.id)) continue;
        out.add('relation:' + r.id);
        out.add('hub:' + r.id);
      }
      const lid = ix.ifaceLink.get(id);
      if (lid) addLink(lid);
      for (const m of inf.members) {
        const ml = ix.ifaceLink.get(ifaceKey(inf.device, m));
        if (ml) addLink(ml);
      }
      for (const a of aggregates(inf.device, inf.id)) out.add(a);
      return out;
    }
    case 'relation': {
      const r = ix.relations.get(id);
      if (!r) return null;
      out.add('relation:' + id);
      out.add('hub:' + id);
      for (const e of r.endpoints) out.add(endRef(e.device, e.iface));
      return out;
    }
    case 'link':
      if (!ix.links.has(id)) return null;
      addLink(id);
      return out;
    case 'route': {
      const r = ix.routes.get(id);
      if (!r) return null;
      out.add(ref);
      for (const t of routeTargets(model, r)) if (t.indexOf('iface:') === 0) out.add(t);
      return out;
    }
    default:
      return null;
  }
}

/** Everything that should stay highlighted when `ref` is selected. */
export function relatedRefs(model: Model, ref: string): Set<string> {
  const out = new Set<string>([ref]);
  const ix = model.index;
  const [kind, id] = splitRef(ref);
  const addDevice = (d: string): void => {
    out.add('device:' + d);
  };
  const addLink = (lid: string): void => {
    const l = ix.links.get(lid);
    if (!l) return;
    out.add('link:' + lid);
    addDevice(l.a.device);
    addDevice(l.b.device);
    if (l.a.iface) out.add(`iface:${l.a.device}:${l.a.iface}`);
    if (l.b.iface) out.add(`iface:${l.b.device}:${l.b.iface}`);
  };
  // relations carried (directly or transitively) over something
  const carriedOver = (target: string): string[] => {
    const res: string[] = [];
    const queue = [target];
    const seen = new Set<string>();
    while (queue.length) {
      const t = queue.shift() as string;
      for (const r of model.relations) {
        if (r.over.indexOf(t) >= 0 && !seen.has(r.id)) {
          seen.add(r.id);
          res.push(r.id);
          queue.push(r.id);
        }
      }
    }
    return res;
  };
  const addRelation = (rid: string, withUnderlay: boolean): void => {
    const r = ix.relations.get(rid);
    if (!r) return;
    out.add('relation:' + rid);
    out.add('hub:' + rid);
    for (const d of relationDevices(r)) addDevice(d);
    for (const e of r.endpoints) if (e.iface) out.add(`iface:${e.device}:${e.iface}`);
    if (!withUnderlay) return;
    // walk the underlay chain: carriers and the links/networks they ride on
    const stack = r.over.slice();
    const seen = new Set<string>();
    while (stack.length) {
      const o = stack.pop() as string;
      if (seen.has(o)) continue;
      seen.add(o);
      if (ix.links.has(o)) addLink(o);
      else if (ix.networks.has(o)) out.add('network:' + o);
      else if (ix.relations.has(o)) {
        addRelation(o, false);
        stack.push(...(ix.relations.get(o) as { over: string[] }).over);
      }
    }
  };

  switch (kind) {
    case 'device': {
      const dv = ix.devices.get(id);
      if (!dv) break;
      if (dv.group) {
        let g = ix.groups.get(dv.group);
        while (g) {
          out.add('group:' + g.id);
          g = g.parent ? ix.groups.get(g.parent) : undefined;
        }
      }
      for (const i of deviceInterfaces(dv)) out.add(`iface:${id}:${i.id}`);
      for (const p of dv.opaquePorts) out.add(`iface:${id}:${p.id}`);
      for (const r of dv.routes) out.add(routeRefOf(r));
      for (const l of model.links) if (l.a.device === id || l.b.device === id) addLink(l.id);
      for (const ic of model.interconnects) if (ic.endpoints.some((e) => e.device === id)) out.add('interconnect:' + ic.id);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === id)) addRelation(r.id, false);
      for (const n of deviceNetworks(model, id)) out.add('network:' + n);
      break;
    }
    case 'route': {
      const r = ix.routes.get(id);
      if (!r) break;
      addDevice(r.device);
      for (const t of routeTargets(model, r)) out.add(t);
      break;
    }
    case 'iface': {
      const inf = ix.interfaces.get(id);
      if (!inf) break;
      addDevice(inf.device);
      // what the interface is associated with on its device: member ports, a VLAN interface's bridge ports, a
      // subinterface's port, a tunnel's source (and, from the other side, the aggregates, VLAN interfaces,
      // subinterfaces and tunnels that use this interface)
      for (const other of associatedInterfaces(model, inf)) {
        out.add(`iface:${inf.device}:${other}`);
        if (inf.type === 'physical') continue;
        // a logical interface shows the cables of the ports it uses (a bridge port that is an aggregate: its members and theirs)
        const oi = ix.interfaces.get(ifaceKey(inf.device, other));
        for (const p of oi && oi.members.length && !inf.members.length ? oi.members : [other]) {
          if (p !== other) out.add(`iface:${inf.device}:${p}`);
          const plid = ix.ifaceLink.get(ifaceKey(inf.device, p));
          if (plid) addLink(plid);
        }
      }
      // a tunnel's destination, when it is part of the model
      if (inf.destination && inf.destination.device) {
        addDevice(inf.destination.device);
        if (inf.destination.iface) out.add(`iface:${inf.destination.device}:${inf.destination.iface}`);
      }
      const lid = ix.ifaceLink.get(id);
      if (lid) {
        addLink(lid);
        for (const r of carriedOver(lid)) addRelation(r, false);
      }
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === inf.device && e.iface === inf.id)) addRelation(r.id, true);
      for (const n of interfaceNetworks(model, inf.device, inf.id)) out.add('network:' + n);
      // the routes leaving through it or pointing at one of its addresses
      for (const r of routesUsing(model, inf.device, inf.id)) out.add(routeRefOf(r));
      break;
    }
    case 'link': {
      addLink(id);
      for (const r of carriedOver(id)) addRelation(r, false);
      // the networks of the VLANs the cable carries at its ends
      const l = ix.links.get(id);
      if (l) for (const n of linkNetworks(model, l)) out.add('network:' + n);
      break;
    }
    case 'interconnect': {
      const ic = ix.interconnects.get(id);
      if (ic)
        for (const e of ic.endpoints) {
          addDevice(e.device);
          out.add(`iface:${e.device}:${e.port}`);
        }
      break;
    }
    case 'hub':
    case 'relation': {
      addRelation(id, true);
      const r = ix.relations.get(id);
      if (r) out.add('protocol:' + r.protocol);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    }
    case 'network': {
      const n = ix.networks.get(id);
      if (!n) break;
      for (const m of networkMembers(model, id)) {
        addDevice(m.device);
        for (const x of m.matches) out.add(`iface:${x.device}:${x.iface}`);
      }
      // the cables that carry its VLAN at an end, with their ports
      for (const l of model.links) if (endNetworks(model, l.a).indexOf(id) >= 0 || endNetworks(model, l.b).indexOf(id) >= 0) addLink(l.id);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    }
    case 'group': {
      const inGroup = (gid: string | undefined): boolean => {
        let g = gid ? ix.groups.get(gid) : undefined;
        while (g) {
          if (g.id === id) return true;
          g = g.parent ? ix.groups.get(g.parent) : undefined;
        }
        return false;
      };
      for (const g of model.groups) if (inGroup(g.id)) out.add('group:' + g.id);
      for (const d of model.devices) if (inGroup(d.group)) {
        addDevice(d.id);
        for (const i of deviceInterfaces(d)) out.add(`iface:${d.id}:${i.id}`);
      }
      for (const l of model.links) if (out.has('device:' + l.a.device) && out.has('device:' + l.b.device)) addLink(l.id);
      // the enclosing groups, as for a device
      let up = ix.groups.get(id);
      while (up && up.parent) {
        out.add('group:' + up.parent);
        up = ix.groups.get(up.parent);
      }
      break;
    }
    case 'protocol':
      for (const r of model.relations) if (r.protocol === id) addRelation(r.id, false);
      break;
  }
  // virtualization: a guest and its host, its port groups, virtual switches and container networks, both ways
  if (kind === 'device' || kind === 'iface' || kind === 'vswitch' || kind === 'portgroup' || kind === 'cnet') {
    for (const r of virtualRelated(model, ref)) {
      out.add(r);
      // a host port named here (an uplink, a passthrough port): with its cable
      if (r.indexOf('iface:') === 0 && (kind !== 'iface' || r !== ref)) {
        const lid = ix.ifaceLink.get(r.slice(6));
        if (lid && kind !== 'device') addLink(lid);
      }
    }
  }
  return out;
}

export interface SearchHit {
  ref: string;
  label: string;
  kind: string;
}

/**
 * Case-insensitive search over ids, labels, protocols, addresses, DNS names,
 * route prefixes and next hops, and the VLANs of ports ("vlan 20" or "20"
 * finds the ports in VLAN 20 and the cables carrying it; "trunk port",
 * "access port", "routed port" their kind).
 */
export function search(model: Model, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<SearchHit & { score: number }> = [];
  const consider = (ref: string, kind: string, label: string, hay: string[]): void => {
    let best = -1;
    for (const s of hay) {
      const t = s.toLowerCase();
      const i = t.indexOf(q);
      if (i < 0) continue;
      const score = t === q ? 3 : i === 0 ? 2 : 1;
      if (score > best) best = score;
    }
    if (best >= 0) hits.push({ ref, kind, label, score: best });
  };
  for (const d of model.devices) {
    const addrs: string[] = [];
    for (const i of deviceInterfaces(d)) addrs.push(...i.addresses);
    // a switch is found (and listed) with its layer: "l3", "layer 3 switch"; every device by its type, kind, role, mode and purpose
    const sw = capabilities(d).switchFeatures;
    const layer = sw ? (d.layer3 ? ['layer 3 switch', 'l3 switch', 'l3'] : ['layer 2 switch', 'l2 switch', 'l2']) : [];
    consider('device:' + d.id, sw ? layer[0] : 'device', d.label, [d.id, d.label, d.type, deviceTypeLabel(d.type), ...layer, ...modelWords(d), ...addrs, ...d.dnsNames.map((x) => x.name), ...serviceWords(model, d), ...virtualWords(model, d)]);
  }
  // the Wi-Fi networks, by SSID and VLAN ("Guest", "ssid guest", "vlan 20"): their device is what is selected
  for (const d of model.devices) {
    for (const n of d.wireless ? d.wireless.networks : []) {
      const vlan = n.vlan !== undefined ? `VLAN ${n.vlan}` : 'untagged';
      consider('device:' + d.id, 'Wi-Fi network', `${n.ssid || n.id} on ${d.label} (${vlan})`, [n.ssid || '', n.id, `ssid ${n.ssid || ''}`, `wifi ${n.ssid || ''}`, n.vlan !== undefined ? `vlan ${n.vlan}` : 'untagged', `${n.ssid || n.id} ${d.id}`]);
    }
  }
  // the virtual networking: a host's virtual switches, port groups and container networks
  for (const h of model.devices) {
    if (h.hypervisor) {
      for (const vs of h.hypervisor.vswitches) {
        if (vs.name) consider(vswitchRef(h.id, vs.name), 'virtual switch', `${h.id} · ${vs.name}`, [vs.name, `${h.id} ${vs.name}`, vs.type || '', 'vswitch', 'virtual switch']);
        for (const pg of vs.portGroups) if (pg.name) consider(portGroupRef(h.id, pg.name), 'port group', `${h.id} · ${pg.name}`, [pg.name, `${h.id} ${pg.name}`, 'port group']);
      }
    }
    if (h.containerEngine) for (const n of h.containerEngine.networks) if (n.name) consider(cnetRef(h.id, n.name), 'container network', `${h.id} · ${n.name}`, [n.name, `${h.id} ${n.name}`, n.iface || '', n.subnet || '', n.driver || '', 'container network']);
  }
  // the virtual gateway addresses of interfaces (VRRP …)
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      const words: string[] = [];
      for (const s of i.services) s.values.forEach((v, k) => words.push(v, `${s.id} ${k === 'group' ? 'group ' : ''}${v}`));
      if (words.length) consider(`iface:${d.id}:${i.id}`, 'interface', `${d.id}:${i.id}`, words);
    }
  }
  for (const n of model.networks) consider('network:' + n.id, 'network', n.label, [n.id, n.label, n.vlan !== undefined ? 'vlan ' + n.vlan : '', n.cidr || '']);
  for (const r of model.relations) consider('relation:' + r.id, r.protocol, r.label || r.id, [r.id, r.protocol, r.label || '']);
  for (const d of model.devices) {
    for (const r of d.routes) consider(routeRefOf(r), 'route', `${d.label}: ${r.prefix}${r.via !== undefined ? ' via ' + r.via : ''}${r.iface !== undefined ? ' dev ' + r.iface : ''}${r.blackhole ? ' blackhole' : ''}`, [r.prefix, r.via || '', r.iface || '', r.name || '', r.vrf ? 'vrf ' + r.vrf : '']);
  }
  const vlanQ = /^(?:vlan\s*)?([0-9]{1,4})$/.exec(q);
  // the ports (and aggregates) in a VLAN: "vlan 20" or "20" finds every port of VLAN 20; their mode words too
  for (const d of model.devices) {
    for (const i of d.interfaces.concat(d.logical.filter((x) => x.members.length > 0))) {
      const l2 = portL2(model, d.id, i.id);
      if (!l2 || (!isBridgePort(l2) && !(l2.kind === 'routed' && i.routed))) continue;
      const hay = [portBadgeText(l2).toLowerCase(), l2.kind === 'access' || l2.kind === 'trunk' ? l2.kind + ' port' : 'routed port'];
      if (vlanQ) {
        if (l2.vlans.indexOf(Number(vlanQ[1])) >= 0) hay.push('vlan ' + vlanQ[1], vlanQ[1]);
      } else if (l2.vlans.length) hay.push('vlan ' + vlanRangesText(l2.vlans));
      consider(`iface:${d.id}:${i.id}`, 'port', `${d.id}:${i.id} · ${portBadgeText(l2)}`, hay);
    }
  }
  for (const l of model.links) {
    const vlans = vlanQ ? endVlans(model, l.a).concat(endVlans(model, l.b)) : [];
    const hay = [l.id, l.label || '', l.cable || ''];
    // a VLAN number matches the cables carrying exactly that VLAN (also inside a range); other text their VLAN list
    if (vlanQ) {
      if (vlans.indexOf(Number(vlanQ[1])) >= 0) hay.push('vlan ' + vlanQ[1], vlanQ[1]);
    } else {
      const all = endVlans(model, l.a).concat(endVlans(model, l.b));
      if (all.length) hay.push('vlan ' + vlanRangesText(all));
    }
    consider('link:' + l.id, 'link', l.label || l.id, hay);
  }
  for (const g of model.groups) consider('group:' + g.id, g.kind || 'group', g.label, [g.id, g.label]);
  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return hits.slice(0, limit).map(({ ref, label, kind }) => ({ ref, label, kind }));
}

/**
 * The selection context shown in the element lists: the selected model
 * entity and the entities *directly* related to it, as refs ("device:x",
 * "link:l", "network:n", "relation:r", "group:g", "protocol:p").
 *
 * Direct means one reference in the model, in either direction:
 * * device   — its own group (not the enclosing ones), links with an end on it,
 *              networks that contain one of its addresses (derived membership), relations
 *              with it or one of its interfaces as an endpoint;
 * * link     — its two end devices, relations carried directly over it (`over`);
 * * network  — its member devices, relations whose `network` is it or that
 *              are carried directly over it;
 * * relation — its endpoint devices, its `network`, the links / networks /
 *              relations in its `over`, relations carried directly over it,
 *              and the protocol defined in the file (`protocols:`) with exactly
 *              its protocol id (built-in definitions have no list entry;
 *              aliases such as ebgp → bgp don't count);
 * * group    — its parent group, its child groups, devices placed directly in it;
 * * protocol — relations using exactly that protocol id.
 * A route selects its device; its context is its device, the link of its
 * exit interface and the device its next hop is an address of.
 * An interface (a port selected in the diagram) selects its device, and its
 * context is that of the port: the link cabled to it, networks containing one
 * of its addresses, and relations that name exactly that interface. A
 * logical interface additionally has the links cabled to the ports it uses
 * (member ports, ports carrying its VLAN, a tunnel's source) and the device
 * a tunnel's destination names.
 * The relation is symmetric for entities, and a subset of relatedRefs(), which
 * the diagram additionally extends along underlay paths and nested groups.
 */
export interface SelectionContext {
  /** the selected entity (a hub or port is mapped to its relation or device) */
  selected: string;
  /** directly related entities, without `selected` */
  related: Set<string>;
}

export function selectionContext(model: Model, ref: string): SelectionContext | null {
  if (!refExists(model, ref)) return null;
  const ix = model.index;
  let [kind, id] = splitRef(ref);
  if (kind === 'hub') kind = 'relation';
  const rel = new Set<string>();
  const add = (k: string, v: string | undefined): void => {
    if (v !== undefined) rel.add(k + ':' + v);
  };
  const overTarget = (o: string): void => {
    if (ix.links.has(o)) add('link', o);
    else if (ix.networks.has(o)) add('network', o);
    else if (ix.relations.has(o)) add('relation', o);
  };
  let selected = kind + ':' + id;
  switch (kind) {
    case 'device': {
      const d = ix.devices.get(id);
      if (!d) break;
      add('group', d.group);
      // a guest and its host, both ways
      const h = hostOf(model, d);
      if (h) add('device', h.id);
      for (const g of guestsOf(model, id)) add('device', g.id);
      for (const l of model.links) if (l.a.device === id || l.b.device === id) add('link', l.id);
      for (const n of deviceNetworks(model, id)) add('network', n);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === id)) add('relation', r.id);
      break;
    }
    case 'iface': {
      const inf = ix.interfaces.get(id);
      if (!inf) break;
      selected = 'device:' + inf.device;
      add('link', ix.ifaceLink.get(id));
      // a logical interface: the cables of its member ports, of its bridge ports (an aggregate's: its members'), of its tunnel source
      if (inf.type !== 'physical') {
        for (const other of associatedInterfaces(model, inf)) {
          const oi = ix.interfaces.get(ifaceKey(inf.device, other));
          for (const p of oi && oi.members.length && !inf.members.length ? oi.members : [other]) add('link', ix.ifaceLink.get(ifaceKey(inf.device, p)));
        }
      }
      if (inf.destination && inf.destination.device && inf.destination.device !== inf.device) add('device', inf.destination.device);
      // a guest's vnic or veth: its host
      for (const r of virtualRelated(model, ref)) if (r.indexOf('device:') === 0 && r !== 'device:' + inf.device) rel.add(r);
      for (const n of interfaceNetworks(model, inf.device, inf.id)) add('network', n);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === inf.device && e.iface === inf.id)) add('relation', r.id);
      break;
    }
    case 'route': {
      const r = ix.routes.get(id);
      if (!r) break;
      selected = 'device:' + r.device;
      if (r.iface !== undefined) add('link', ix.ifaceLink.get(ifaceKey(r.device, r.iface)));
      for (const t of routeTargets(model, r)) if (t.indexOf('device:') === 0) rel.add(t);
      break;
    }
    case 'link': {
      const l = ix.links.get(id);
      if (!l) break;
      add('device', l.a.device);
      add('device', l.b.device);
      for (const n of linkNetworks(model, l)) add('network', n);
      for (const r of model.relations) if (r.over.indexOf(id) >= 0) add('relation', r.id);
      break;
    }
    case 'network': {
      const n = ix.networks.get(id);
      if (!n) break;
      for (const m of networkMembers(model, id)) add('device', m.device);
      for (const l of model.links) if (endNetworks(model, l.a).indexOf(id) >= 0 || endNetworks(model, l.b).indexOf(id) >= 0) add('link', l.id);
      for (const r of model.relations) if (r.over.indexOf(id) >= 0) add('relation', r.id);
      break;
    }
    case 'relation': {
      const r = ix.relations.get(id);
      if (!r) break;
      for (const e of r.endpoints) add('device', e.device);
      for (const o of r.over) overTarget(o);
      for (const x of model.relations) if (x.over.indexOf(id) >= 0) add('relation', x.id);
      const def = model.protocols.get(r.protocol);
      if (def && def.custom) add('protocol', r.protocol);
      break;
    }
    case 'group': {
      const g = ix.groups.get(id);
      if (!g) break;
      add('group', g.parent);
      for (const x of model.groups) if (x.parent === id) add('group', x.id);
      for (const d of model.devices) if (d.group === id) add('device', d.id);
      break;
    }
    case 'protocol':
      for (const r of model.relations) if (r.protocol === id) add('relation', r.id);
      break;
    case 'vswitch':
    case 'portgroup':
    case 'cnet': {
      // a virtual switch, port group or container network is its host's: the host is selected, the guests on it are related
      const t = virtRefTarget(model, ref);
      if (!t) break;
      selected = 'device:' + t.host.id;
      for (const r of virtualRelated(model, ref)) if (r.indexOf('device:') === 0) rel.add(r);
      break;
    }
  }
  rel.delete(selected);
  return { selected, related: rel };
}

export type ContextState = 'selected' | 'related' | 'unrelated';

/** How an entity's list entry is shown for a selection context (null: no selection). */
export function contextState(ctx: SelectionContext | null, ref: string): ContextState | null {
  if (!ctx) return null;
  if (ref === ctx.selected) return 'selected';
  return ctx.related.has(ref) ? 'related' : 'unrelated';
}

/**
 * The words a guest is found by: its host ("on esx-01", the host's id and
 * label), its port groups and container networks.
 */
export function virtualWords(model: Model, d: Device): string[] {
  const out: string[] = [];
  const h = hostOf(model, d);
  if (h) out.push(`on ${h.id}`, `on ${h.label}`, h.id, h.label);
  for (const i of d.logical) {
    if (i.type === 'vnic') {
      const x = vnicPortGroup(model, i);
      if (x) out.push(x.pg.name, x.vswitch.name);
    }
    if (i.type === 'veth' && i.network) out.push(i.network);
  }
  if (d.hypervisor) out.push('hypervisor');
  if (d.containerEngine) out.push('container engine', 'container host');
  return out;
}

/**
 * The words a device's routing services are found by: the protocols it
 * enables ("bgp", "BGP"), its AS numbers ("65010", "as 65010"), NETs, and
 * its router IDs ("10.255.0.1", "router-id 10.255.0.1", the loopback).
 */
export function serviceWords(model: Model, d: Device): string[] {
  const out: string[] = [];
  for (const s of d.services) {
    const def = model.services.get(s.id);
    out.push(s.id, def ? def.label : s.id);
    s.values.forEach((v, k) => {
      out.push(v);
      if (k === 'asn') out.push('as ' + v, 'as' + v);
    });
    if (s.routerId) out.push(s.routerId.text, s.routerId.address || '', 'router-id ' + (s.routerId.address || s.routerId.text));
  }
  if (d.routerId) out.push(d.routerId.text, d.routerId.address || '', 'router-id ' + (d.routerId.address || d.routerId.text));
  // the services of the registry it runs, by name and badge ("ntp", "Wireless access", "wifi")
  for (const x of deviceServices(d)) out.push(x.id, x.label, x.badge.toLowerCase());
  // its applications, by id, name, profile and topics ("registers", "Modbus TCP", "MQTT", "sensors/room1")
  for (const a of d.applications || []) {
    const p = appProfile(a.profile);
    out.push(a.id, a.name, `${d.id}/${a.id}`, p ? p.short : '', ...a.publish, ...a.subscribe);
  }
  return out.filter((x) => x !== '');
}

/** What Find finds a device by besides its names: its kind, its role (with "role"), its mode and a System's purpose. */
export function modelWords(d: Device): string[] {
  const out: string[] = [];
  const k = kindLabel(d);
  if (k) out.push(k, d.kind || '');
  if (d.role) out.push(roleLabel(d.role), d.role, `role ${roleLabel(d.role)}`, `role ${d.role}`);
  if (d.mode) out.push(d.mode, (modesOf(d.type).find((m) => m.id === d.mode) || { label: '' }).label);
  if (d.purpose) out.push(d.purpose, (purposeDef(d.purpose) || { label: '' }).label);
  return out.filter((x) => !!x);
}

/**
 * A device's services (`services:`) by the service registry
 * (model/service-registry.ts): which it may run (an error with the reason
 * otherwise), the built-in functions its type requires, and the services
 * without editors of their own read from their parameters' definitions.
 * DHCP and DNS (netservices.ts), the Hypervisor and the Container engine
 * (virtual.ts), the VPN gateway and Domain separation (device-model.ts)
 * have their own readers; Wireless access is read here.
 *
 * With the whole model (checkServices): the devices and interfaces the
 * services name exist, a Wi-Fi network's VLAN is carried by the device's
 * uplink (or, on a router, is one of its VLANs), a wireless connection names
 * a network of its access point on the radio it ends on, a
 * controller-managed access point and its controller list each other.
 */
import { formatAddr } from '../analysis/ipmath';
import { parsePorts, parseValue } from '../analysis/sim/params';
import { capabilities } from '../model/capabilities';
import { portL2, isBridgePort } from '../model/derive';
import { parseAddress, parsePrefix } from '../model/ip';
import { SERVICES, SvcDef, SvcParam, SvcValues, isBuiltIn, serviceDef, serviceEligibility } from '../model/service-registry';
import { Device, Interface, Model, ServiceInstance, WIFI_SECURITY, WirelessNetwork, WirelessService, deviceInterfaces, ifaceKey } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, Reader, get, isNull, suggest } from './reader';

/** Where a device's services were written (for the checks with the whole model). */
export interface ServiceNodes {
  device: string;
  map?: YMap;
  path: string;
  /** a parameter that names devices or interfaces, to check once all are known */
  refs: Array<{ kind: 'devices' | 'interface' | 'interfaces'; values: string[]; node: YNode; path: string }>;
  wireless?: { node: YMap; path: string; networks: Array<{ net: WirelessNetwork; node: YMap; path: string }> };
}

/** A placeholder for a secret: `<name>` or `${NAME}` (never the secret itself). */
export const SECRET_RE = /^(<[^<>\s][^<>]*>|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/**
 * Read a device's services by the registry. The services with readers of
 * their own are only checked for eligibility here; the others are read into
 * `dev.appServices`, Wireless access into `dev.wireless`.
 */
export function readServiceBlock(r: Reader, c: Ctx, n: YNode | undefined, path: string, dev: Device, devNode: YMap): ServiceNodes {
  const nodes: ServiceNodes = { device: dev.id, path, refs: [] };
  const m = !isNull(n) ? r.map(n as YNode, path) : null;
  if (m) {
    nodes.map = m;
    r.keys(m, SCHEMA.netServices, path);
    for (const key of Array.from(m.entries.keys())) {
      const def = serviceDef(key);
      if (!def) continue;
      const why = serviceEligibility(def, dev);
      if (why) {
        // (the Hypervisor's and the Container engine's own readers say it in their words)
        if (key !== 'hypervisor' && key !== 'container_engine') c.error(get(m, key) as YNode, `${path}.${key}`, `"${dev.id}" can't run ${def.label}: ${why}`);
        continue;
      }
      if (def.id === 'wireless') readWireless(r, c, get(m, key) as YNode, `${path}.${key}`, dev, nodes);
      else if (!def.custom) {
        const inst = readGeneric(r, c, def, get(m, key) as YNode, `${path}.${key}`, nodes);
        if (inst) {
          if (!dev.appServices) dev.appServices = new Map();
          dev.appServices.set(def.id, inst);
        }
      }
    }
  }
  // the built-in functions whose configuration must be written (the VPN gateway and Domain separation say it themselves)
  for (const def of SERVICES) {
    if (!def.required || !isBuiltIn(def, dev) || def.id === 'vpn' || def.id === 'separation') continue;
    if (m && get(m, def.id) !== undefined) continue;
    c.error(m || devNode, `${path}.${def.id}`, `${def.label} is built into "${dev.id}" and needs its configuration: ${def.id === 'wireless' ? 'its Wi-Fi networks, each with its SSID, its VLAN (or untagged) and its radio' : 'its required fields'}`, { key: def.id });
  }
  return nodes;
}

/** A service read from its parameters' definitions. */
function readGeneric(r: Reader, c: Ctx, def: SvcDef, n: YNode, path: string, nodes: ServiceNodes): ServiceInstance | null {
  const m = isNull(n) ? null : r.map(n, path);
  const inst: ServiceInstance = { id: def.id, values: {}, lists: {}, line: n.line };
  const keys = def.params.map((p) => p.key).concat((def.lists || []).map((l) => l.key));
  if (m) r.keys(m, keys, path);
  inst.values = readParams(r, c, def.params, m, n, path, nodes, def.label);
  for (const l of def.lists || []) {
    const ln = m ? get(m, l.key) : undefined;
    const items = isNull(ln) ? [] : r.list(ln, `${path}.${l.key}`);
    if (!items.length && l.required) c.error(m || n, `${path}.${l.key}`, `${def.label} needs its ${l.label.toLowerCase()}: at least one ${l.item}`, { key: l.key });
    inst.lists[l.key] = [];
    items.forEach((it, k) => {
      const ip = `${path}.${l.key}[${k}]`;
      const im = r.map(it, ip);
      if (!im) return;
      r.keys(im, l.params.map((p) => p.key), ip);
      inst.lists[l.key].push(readParams(r, c, l.params, im, it, ip, nodes, `${l.item} ${k + 1}`));
    });
  }
  return inst;
}

/** The parameters of a service (or one entry), checked by type; required ones (always, or by the others' values) are errors when missing. */
function readParams(r: Reader, c: Ctx, params: SvcParam[], m: YMap | null, owner: YNode, path: string, nodes: ServiceNodes, what: string): SvcValues {
  const v: SvcValues = {};
  for (const p of params) {
    const node = m ? get(m, p.key) : undefined;
    if (isNull(node)) continue;
    const val = readValue(r, c, p, node as YNode, `${path}.${p.key}`, nodes);
    if (val !== undefined) v[p.key] = val;
  }
  for (const p of params) {
    const node = m ? get(m, p.key) : undefined;
    const need = typeof p.required === 'function' ? p.required(v) : !!p.required;
    if (need && isNull(node)) c.error(m || owner, `${path}.${p.key}`, `${what} needs its ${p.label.toLowerCase()}: ${p.help.replace(/\.$/, '')}`, { key: p.key });
    if (p.when && !isNull(node) && !p.when(v)) c.error(node as YNode, `${path}.${p.key}`, `"${p.key}" does not apply here: ${p.help.replace(/\.$/, '')} — delete it`);
  }
  return v;
}

function readValue(r: Reader, c: Ctx, p: SvcParam, n: YNode, path: string, nodes: ServiceNodes): unknown {
  const text = (): string | undefined => r.str(n, path, 300);
  const list = (): string[] => r.list(n, path, true).map((x, k) => r.str(x, `${path}[${k}]`, 200)).filter((x): x is string => x !== undefined);
  switch (p.type) {
    case 'text':
      return text();
    case 'int':
    case 'port':
      return r.int(n, path, p.min !== undefined ? p.min : -1e9, p.max !== undefined ? p.max : 1e9, p.type === 'port' ? 'port' : p.label.toLowerCase());
    case 'bool':
      return r.bool(n, path);
    case 'enum': {
      const t = text();
      if (t === undefined) return undefined;
      const opts = (p.options || []).map((o) => o.id);
      if (opts.indexOf(t) < 0) {
        c.error(n, path, `"${t}" is not a ${p.label.toLowerCase()}${suggest(t, opts)}: use ${opts.join(', ')}`);
        return undefined;
      }
      return t;
    }
    case 'address': {
      const t = text();
      if (t === undefined) return undefined;
      const a = parseAddress(t.trim());
      if (!a) c.error(n, path, `"${t}" is not an IP address`);
      return a ? formatAddr(a) : undefined;
    }
    case 'prefix': {
      const t = text();
      if (t === undefined) return undefined;
      if (t !== 'any' && !parsePrefix(t, false)) {
        c.error(n, path, `"${t}" is not an address or prefix (or any)`);
        return undefined;
      }
      return t;
    }
    case 'addresses': {
      const out: string[] = [];
      for (const t of list()) {
        const a = parseAddress(t.trim());
        if (!a) c.error(n, path, `"${t}" is not an IP address`);
        else out.push(formatAddr(a));
      }
      return out;
    }
    case 'devices':
    case 'interfaces': {
      const out = list();
      nodes.refs.push({ kind: p.type, values: out, node: n, path });
      return out;
    }
    case 'interface': {
      const t = text();
      if (t !== undefined) nodes.refs.push({ kind: 'interface', values: [t], node: n, path });
      return t;
    }
    case 'secret': {
      const t = text();
      if (t !== undefined && !SECRET_RE.test(t.trim())) c.warn(n, path, `write a placeholder for the ${p.label.toLowerCase()} (e.g. "<name>" or "\${NAME}"), never the secret itself: a model file is shared`);
      return t;
    }
    case 'portlist': {
      const raw = list();
      if (p.options) {
        const opts = p.options.map((o) => o.id);
        const bad = raw.filter((x) => opts.indexOf(x) < 0);
        if (bad.length) c.error(n, path, `${bad.map((x) => `"${x}"`).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not one of ${opts.join(', ')}`);
        return raw.filter((x) => opts.indexOf(x) >= 0);
      }
      const pr = parsePorts(raw.join(', '));
      if ('error' in pr) {
        c.error(n, path, `the ${p.label.toLowerCase()} ${pr.error}: write tcp/443, udp/53 or icmp`);
        return undefined;
      }
      return raw;
    }
    case 'duration': {
      const t = text();
      if (t === undefined) return undefined;
      const pv = parseValue({ key: p.key, yaml: p.key, label: p.label, layer: 0, kind: 'duration', base: 's', dflt: 0, min: 100, max: 86400000, source: '', help: '' }, t);
      if ('error' in pv) {
        c.error(n, path, `${p.label} ${pv.error}`);
        return undefined;
      }
      return pv.value;
    }
  }
  return undefined;
}

/** Wireless access: its Wi-Fi networks (and a controller-managed access point's controller). */
function readWireless(r: Reader, c: Ctx, n: YNode, path: string, dev: Device, nodes: ServiceNodes): void {
  const m = isNull(n) ? null : r.map(n, path);
  const w: WirelessService = { networks: [], line: n.line };
  dev.wireless = w;
  nodes.wireless = { node: (m || n) as YMap, path, networks: [] };
  if (m) r.keys(m, SCHEMA.wireless, path);
  const ctl = m ? r.field(m, 'controller', path, 200) : undefined;
  const controllerMode = dev.mode === 'controller';
  if (ctl !== undefined) {
    if (!controllerMode) c.error(get(m as YMap, 'controller') as YNode, path + '.controller', `"controller" is a controller-managed access point's (mode: controller); "${dev.id}" is ${dev.mode === undefined || dev.mode === 'standalone' ? 'not controller-managed' : 'not one'} — delete it or set its mode`);
    else {
      w.controller = ctl;
      nodes.refs.push({ kind: 'devices', values: [ctl], node: get(m as YMap, 'controller') as YNode, path: path + '.controller' });
    }
  } else if (controllerMode) c.error(m || n, path + '.controller', `"${dev.id}" is controller-managed: write its controller (a device with the Wireless controller service)`, { key: 'controller' });
  const nl = m ? get(m, 'networks') : undefined;
  const items = isNull(nl) ? [] : r.list(nl, path + '.networks');
  if (!items.length) c.error(m || n, path + '.networks', `Wireless access on "${dev.id}" needs its Wi-Fi networks: each with its SSID, its VLAN (or untagged: true) and its radio`, { key: 'networks' });
  items.forEach((it, k) => {
    const np = `${path}.networks[${k}]`;
    const nm = r.map(it, np);
    if (!nm) return;
    r.keys(nm, SCHEMA.wirelessNetwork, np);
    const id = r.id(nm, np);
    if (!id) return;
    if (w.networks.some((x) => x.id === id)) {
      c.error(get(nm, 'id') as YNode, np + '.id', `duplicate Wi-Fi network "${id}" on "${dev.id}"`);
      return;
    }
    const net: WirelessNetwork = { id, line: nm.line };
    net.ssid = r.reqStr(nm, 'ssid', np, 32);
    if (net.ssid !== undefined && net.ssid.length > 32) c.error(get(nm, 'ssid') as YNode, np + '.ssid', 'an SSID has at most 32 characters');
    const vn = get(nm, 'vlan');
    const un = get(nm, 'untagged');
    if (!isNull(vn)) net.vlan = r.int(vn, np + '.vlan', 1, 4094, 'VLAN ID');
    if (!isNull(un)) net.untagged = r.bool(un, np + '.untagged') === true;
    if (net.vlan !== undefined && net.untagged) c.error(un as YNode, np + '.untagged', `network "${id}" is bridged to VLAN ${net.vlan}: "untagged" is for a network bridged to the untagged domain — keep one of them`);
    if (isNull(vn) && !net.untagged) c.error(nm, np + '.vlan', `Wi-Fi network "${id}" needs its VLAN (the one it is bridged to), or untagged: true for the untagged domain — none is chosen for it`, { key: 'vlan' });
    net.radio = r.reqStr(nm, 'radio', np, 200);
    if (net.radio !== undefined) nodes.refs.push({ kind: 'interface', values: [net.radio], node: get(nm, 'radio') as YNode, path: np + '.radio' });
    const sec = r.field(nm, 'security', np, 30);
    if (sec === undefined) c.error(nm, np + '.security', `Wi-Fi network "${id}" needs its security: ${WIFI_SECURITY.map((x) => x.id).join(', ')}`, { key: 'security' });
    else if (!WIFI_SECURITY.some((x) => x.id === sec)) c.error(get(nm, 'security') as YNode, np + '.security', `"${sec}" is not a Wi-Fi security${suggest(sec, WIFI_SECURITY.map((x) => x.id))}: use ${WIFI_SECURITY.map((x) => x.id).join(', ')}`);
    else net.security = sec;
    const sd = WIFI_SECURITY.find((x) => x.id === net.security);
    const pn = get(nm, 'passphrase');
    if (!isNull(pn)) {
      net.passphrase = r.str(pn, np + '.passphrase', 200);
      if (sd && !sd.secret) c.error(pn as YNode, np + '.passphrase', `${sd.label} has no passphrase — delete it`);
      else if (net.passphrase !== undefined && !SECRET_RE.test(net.passphrase)) c.warn(pn as YNode, np + '.passphrase', `write a placeholder for the passphrase (e.g. "<guest-psk>"), never the passphrase itself: a model file is shared`);
    } else if (sd && sd.secret) c.error(nm, np + '.passphrase', `${sd.label} needs its passphrase: a placeholder such as "<guest-psk>"`, { key: 'passphrase' });
    const fw = r.field(nm, 'forwarding', np, 20);
    if (fw !== undefined) {
      if (!controllerMode) c.error(get(nm, 'forwarding') as YNode, np + '.forwarding', `"forwarding" is a controller-managed access point's choice (local or tunneled) — delete it`);
      else if (fw !== 'local' && fw !== 'tunneled') c.error(get(nm, 'forwarding') as YNode, np + '.forwarding', `"${fw}" is not a forwarding: use local or tunneled`);
      else net.forwarding = fw;
    }
    w.networks.push(net);
    (nodes.wireless as NonNullable<ServiceNodes['wireless']>).networks.push({ net, node: nm, path: np });
  });
  // an SSID is unique on its radio (the same SSID on two radios is one network on both bands: write it twice, once per radio)
  const seen = new Map<string, string>();
  for (const x of w.networks) {
    const k = `${x.radio}|${x.ssid}`;
    const other = seen.get(k);
    if (x.ssid !== undefined && x.radio !== undefined && other) c.error(nm(nodes, x), `${path}.networks`, `networks "${other}" and "${x.id}" both have the SSID "${x.ssid}" on ${x.radio}: one SSID per radio`);
    else seen.set(k, x.id);
  }
}

function nm(nodes: ServiceNodes, x: WirelessNetwork): YMap {
  const w = nodes.wireless as NonNullable<ServiceNodes['wireless']>;
  return (w.networks.find((y) => y.net === x) || w.networks[0]).node;
}

/** The radios of a device's Wireless access: the interfaces its networks are on. */
export function radiosOf(d: Device): string[] {
  return d.wireless ? Array.from(new Set(d.wireless.networks.map((x) => x.radio).filter((x): x is string => !!x))) : [];
}

/**
 * The checks with the whole model: the references of the services, Wi-Fi
 * networks against the uplink and the device's VLANs, wireless connections
 * against the networks, controllers against their access points.
 */
export function checkServices(c: Ctx, model: Model, all: ServiceNodes[], linkNodes: Map<string, YMap>): void {
  const devs = model.index.devices;
  for (const sn of all) {
    const d = devs.get(sn.device);
    if (!d) continue;
    const ifIds = deviceInterfaces(d).map((i) => i.id);
    for (const ref of sn.refs) {
      for (const v of ref.values) {
        if (ref.kind === 'devices' && !devs.has(v)) c.error(ref.node, ref.path, `"${v}" is not a device of the model${suggest(v, Array.from(devs.keys()))}`);
        if (ref.kind !== 'devices' && ifIds.indexOf(v) < 0) c.error(ref.node, ref.path, `"${d.id}" has no interface "${v}"${suggest(v, ifIds)}`);
      }
    }
    if (sn.wireless) checkWireless(c, model, d, sn.wireless);
  }
  // a controller and its access points name each other
  for (const d of model.devices) {
    const wc = d.appServices ? d.appServices.get('wireless_controller') : undefined;
    const aps = wc && Array.isArray(wc.values.aps) ? (wc.values.aps as string[]) : [];
    const sn = all.find((x) => x.device === d.id);
    for (const ap of aps) {
      const a = devs.get(ap);
      if (!a) continue;
      if (!capabilities(a).wirelessAccess || a.mode !== 'controller') c.error((sn && sn.map ? get(sn.map, 'wireless_controller') : undefined) as YNode, `devices.${d.id}.services.wireless_controller.aps`, `"${ap}" is not a controller-managed access point (an access point with mode: controller)`);
      else if (a.wireless && a.wireless.controller !== d.id) c.error((sn && sn.map ? get(sn.map, 'wireless_controller') : undefined) as YNode, `devices.${d.id}.services.wireless_controller.aps`, `"${ap}" names ${a.wireless.controller ? `"${a.wireless.controller}"` : 'no controller'} as its controller, not "${d.id}"`);
    }
  }
  for (const d of model.devices) {
    if (!d.wireless || !d.wireless.controller) continue;
    const ctl = devs.get(d.wireless.controller);
    if (!ctl) continue;
    const wc = ctl.appServices ? ctl.appServices.get('wireless_controller') : undefined;
    const sn = all.find((x) => x.device === d.id);
    if (!wc) c.error((sn && sn.wireless ? get(sn.wireless.node, 'controller') : undefined) as YNode, `devices.${d.id}.services.wireless.controller`, `"${ctl.id}" runs no Wireless controller service`);
    else if (!(Array.isArray(wc.values.aps) && (wc.values.aps as string[]).indexOf(d.id) >= 0)) c.error((sn && sn.wireless ? get(sn.wireless.node, 'controller') : undefined) as YNode, `devices.${d.id}.services.wireless.controller`, `the Wireless controller of "${ctl.id}" does not list "${d.id}" among its access points`);
  }
  // wireless connections: at a radio of a Wireless access, they name one of its networks on that radio
  for (const l of model.links) {
    const ln = linkNodes.get(l.id);
    if (!ln) continue;
    const wn = get(ln, 'wireless_network');
    const prov = providerEnd(model, l);
    if (!prov) {
      if (!isNull(wn)) c.error(wn as YNode, `links.${l.id}.wireless_network`, l.medium !== 'wireless' ? `"wireless_network" is a wireless connection's: this cable is ${l.medium}` : `neither end of "${l.id}" is a radio of a Wireless access with Wi-Fi networks — delete "wireless_network"`);
      continue;
    }
    const nets = (prov.dev.wireless as WirelessService).networks.filter((x) => x.radio === prov.iface);
    if (isNull(wn)) {
      c.error(ln, `links.${l.id}.wireless_network`, `"${l.id}" is a wireless connection to ${prov.dev.id}:${prov.iface}: write the Wi-Fi network it is associated with (${nets.map((x) => `${x.id} "${x.ssid || ''}"`).join(', ')})`, { key: 'wireless_network' });
      continue;
    }
    if (!nets.some((x) => x.id === l.wirelessNetwork)) c.error(wn as YNode, `links.${l.id}.wireless_network`, `"${l.wirelessNetwork}" is not a Wi-Fi network of ${prov.dev.id} on ${prov.iface}${suggest(l.wirelessNetwork || '', nets.map((x) => x.id))} (its networks there: ${nets.map((x) => x.id).join(', ') || 'none'})`);
  }
}

/** The end of a link at a radio of a Wireless access (with networks on it), when it is a wireless connection. */
export function providerEnd(model: Model, l: { a: { device: string; iface?: string }; b: { device: string; iface?: string }; medium: string }): { dev: Device; iface: string; side: 'a' | 'b' } | null {
  if (l.medium !== 'wireless') return null;
  for (const side of ['a', 'b'] as const) {
    const e = l[side];
    const d = model.index.devices.get(e.device);
    if (d && d.wireless && e.iface !== undefined && d.wireless.networks.some((x) => x.radio === e.iface)) return { dev: d, iface: e.iface, side };
  }
  return null;
}

/**
 * A Wi-Fi network against its device: its radio is a physical interface
 * that no cable but wireless connections uses; a VLAN-backed network's VLAN
 * is carried by the uplink (an access point: one of its wired bridge ports
 * carries it, tagged or untagged; a router: it has a VLAN interface or a
 * bridge port in that VLAN); an untagged one needs an uplink with an
 * untagged VLAN. Nothing is added to a port for it.
 */
function checkWireless(c: Ctx, model: Model, d: Device, w: NonNullable<ServiceNodes['wireless']>): void {
  const radios = radiosOf(d);
  for (const x of w.networks) {
    const net = x.net;
    if (net.radio !== undefined) {
      const i = model.index.interfaces.get(ifaceKey(d.id, net.radio)) as Interface | undefined;
      if (i && i.type !== 'physical') c.error(get(x.node, 'radio') as YNode, x.path + '.radio', `"${net.radio}" is ${i.type === 'virtual' ? 'a virtual' : 'a ' + i.type} interface: a radio is a physical interface of the device`);
      const lid = model.index.ifaceLink.get(ifaceKey(d.id, net.radio));
      const l = lid ? model.index.links.get(lid) : undefined;
      if (l && l.medium !== 'wireless') c.error(get(x.node, 'radio') as YNode, x.path + '.radio', `"${net.radio}" is cabled (${l.id}, ${l.medium}): a radio has wireless connections only`);
    }
    // the wired side: the device's bridge ports that are not radios
    const wired = d.interfaces.filter((i) => radios.indexOf(i.id) < 0).map((i) => ({ i, l2: portL2(model, d.id, i.id) })).filter((p) => isBridgePort(p.l2));
    const routerVlan = (v: number): boolean => d.logical.some((li) => li.type === 'virtual' && li.vlan === v);
    if (net.vlan !== undefined) {
      const carried = wired.some((p) => (p.l2 as NonNullable<typeof p.l2>).vlans.indexOf(net.vlan as number) >= 0);
      if (!carried && !routerVlan(net.vlan)) {
        const ports = wired.map((p) => `${p.i.id} (${(p.l2 as NonNullable<typeof p.l2>).vlans.join(', ') || 'no VLANs'})`).join(', ');
        c.error(get(x.node, 'vlan') as YNode, x.path + '.vlan', `VLAN ${net.vlan} of Wi-Fi network "${net.id}" is carried by none of ${d.id}'s wired ports (${ports || 'it has none with VLANs'})${capabilities(d).l3Forward ? ' and it has no VLAN interface for it' : ''}: add VLAN ${net.vlan} to its uplink — nothing is added for you`);
      }
    } else if (net.untagged) {
      const untagged = wired.some((p) => (p.l2 as NonNullable<typeof p.l2>).untagged !== undefined);
      if (!untagged && !wired.some((p) => !p.l2) && wired.length) c.error(get(x.node, 'untagged') as YNode, x.path + '.untagged', `Wi-Fi network "${net.id}" is bridged to the untagged domain, but no wired port of ${d.id} has an untagged (native or access) VLAN`);
    }
  }
}

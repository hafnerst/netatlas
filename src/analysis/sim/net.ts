/**
 * The network the protocol simulation runs on, built once from the model:
 * which devices bridge frames and which route; the bridge ports of every
 * bridge with the VLANs they carry (from the link ends' tagging); the
 * layer-3 interfaces (routed ports, VLAN interfaces, subinterfaces,
 * aggregates) with their addresses, VLAN and MAC address; the cables
 * between ports; and, for a set of failed cables, the spanning tree of
 * every VLAN that keeps layer 2 loop-free. Pure and deterministic.
 *
 * Bridges: switches (Layer 2 and Layer 3), access points, IDS / IPS and
 * clouds, the devices the path tracer passes at layer 2. A port with an
 * address is a routed port, never bridged. A Layer 3 switch's VLAN
 * interfaces route between its VLANs; a Layer 2 switch has at most one
 * (its management interface), which is a host on its bridge.
 *
 * VLANs (0 stands for "untagged, no VLAN known"):
 *   access  carries its untagged VLAN;
 *   trunk   its tagged VLANs, and its native (untagged) VLAN;
 *   none    a link end without a mode carries every VLAN tagged, and
 *           untagged frames in the VLAN of the network the far end's
 *           addresses are in (when that is one VLAN), else 0.
 */
import { interfaceVlans, portsCarryingVlans, vlanIds } from '../../model/derive';
import { deviceRoutingRole, isLayer2Switch } from '../../model/device-types';
import { parsePrefix, IpAddr } from '../../model/ip';
import { Device, Interface, Link, LinkEnd, Model, deviceInterfaces, ifaceKey } from '../../model/types';
import { networkOf } from '../ipmath';
import { IfaceMac, interfaceMacs } from './mac';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Device types that bridge frames between their ports. */
export const BRIDGE_TYPES: readonly string[] = ['switch', 'ap', 'ids_ips', 'cloud'];

/** One end of a cable at a port. `port` is the interface id, or "@<link>" for a cable end that names no interface. */
export interface CableEnd {
  link: string;
  end: 'a' | 'b';
  device: string;
  port: string;
}

/** The VLANs of a port: its untagged VLAN (0: none known) and its tagged VLANs ('all': a link end without a mode). */
export interface PortVlans {
  mode: 'access' | 'trunk' | 'none';
  untagged: number | null;
  tagged: number[] | 'all';
}

/** A bridge port: a cabled port, or an aggregate of member ports (one port for forwarding and learning). */
export interface BridgePort {
  /** the port's id: the interface, or "@<link>", or the aggregate's id */
  id: string;
  /** its physical ports (one, or the aggregate's members) */
  members: string[];
  vlans: PortVlans;
}

/** An address of a layer-3 interface. */
export interface SimAddr {
  addr: IpAddr;
  /** the network (host bits cleared), with its prefix length */
  net: IpAddr & { prefix: number };
  text: string;
}

/** An address a DHCP client leased (or its link-local fallback): the simulation's, never the model's. */
export interface Lease {
  dev: string;
  iface: string;
  addr: SimAddr;
  vrf: string;
  /** the default gateway and DNS servers it got */
  gateway?: IpAddr;
  dns: IpAddr[];
  domain?: string;
  /** the server that leased it (its address) */
  server?: IpAddr;
  kind: 'dhcp' | 'link-local';
  /** when it was bound, and when it ends (ms; a link-local address: never) */
  bound: number;
  expires: number;
}

export interface L3Iface {
  device: string;
  id: string;
  kind: 'routed' | 'svi' | 'subif' | 'aggregate' | 'loopback' | 'tunnel';
  addrs: SimAddr[];
  vrf: string;
  /** the VLAN it lives in: an SVI's VLAN, a subinterface's tag (0: untagged) */
  vlan: number;
  /** the physical ports it sends out of (routed / subif / aggregate), none for an SVI (its bridge) or a loopback / tunnel */
  ports: string[];
  mac: string;
  macSimulated: boolean;
}

export interface SimDevice {
  id: string;
  dev: Device;
  bridge: boolean;
  /** forwards IP between its interfaces (a router, firewall, Layer 3 switch …) */
  routes: boolean;
  /** has an IP stack at all (routers and hosts; a Layer 2 switch for its management interface) */
  ip: boolean;
  l2switch: boolean;
  /** the bridge's ports by id */
  bridgePorts: Map<string, BridgePort>;
  /** physical port → the bridge port it belongs to */
  portOf: Map<string, string>;
  l3: Map<string, L3Iface>;
  /** the bridge's id for the spanning tree with the default priority (32768), then its lowest MAC (StpConfig gives the priority in effect) */
  bridgeId: string;
}

export interface SimNet {
  model: Model;
  devices: Map<string, SimDevice>;
  /** "device:port" → the cable end there */
  ends: Map<string, CableEnd>;
  links: Map<string, Link>;
  macs: Map<string, IfaceMac>;
  /** every VLAN in use, ascending (0 first when it is) */
  vlans: number[];
}

export function portKey(device: string, port: string): string {
  return device + '|' + port;
}

/** The other end of a cable. */
export function otherEnd(net: SimNet, e: CableEnd): CableEnd {
  const l = net.links.get(e.link) as Link;
  const o = e.end === 'a' ? l.b : l.a;
  return { link: e.link, end: e.end === 'a' ? 'b' : 'a', device: o.device, port: o.iface || '@' + e.link };
}

/** The VLAN of the network an interface's addresses are in, when they are in exactly one. */
function addrVlan(model: Model, device: string, iface: string | undefined): number | null {
  if (!iface) return null;
  const i = model.index.interfaces.get(ifaceKey(device, iface));
  if (!i || !i.addresses.length) return null;
  const vlans = new Set<number>();
  for (const a of i.addresses) {
    const p = parsePrefix(a, false);
    if (!p) continue;
    for (const n of model.networks) {
      if (n.vlan === undefined || !n.cidr) continue;
      const np = parsePrefix(n.cidr);
      if (np && np.version === p.version && inNet(networkOf(np), p)) vlans.add(n.vlan);
    }
  }
  return vlans.size === 1 ? Array.from(vlans)[0] : null;
}

function inNet(n: IpAddr & { prefix: number }, a: IpAddr): boolean {
  if (n.version !== a.version) return false;
  let bits = n.prefix;
  for (let i = 0; i < n.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((n.bytes[i] & mask) !== (a.bytes[i] & mask)) return false;
  }
  return true;
}

/** The VLANs a link end carries at its port (see the module comment). */
export function endPortVlans(model: Model, l: Link, e: LinkEnd): PortVlans {
  if (e.mode === 'access') return { mode: 'access', untagged: e.untagged !== undefined ? e.untagged : 0, tagged: [] };
  if (e.mode === 'trunk') return { mode: 'trunk', untagged: e.untagged !== undefined ? e.untagged : null, tagged: vlanIds(e.tagged) };
  const far = e === l.a ? l.b : l.a;
  const v = addrVlan(model, far.device, far.iface);
  return { mode: 'none', untagged: v !== null ? v : 0, tagged: 'all' };
}

/** Does a port carry a VLAN, and is it untagged there? null: not carried. */
export function carries(pv: PortVlans, vlan: number): 'untagged' | 'tagged' | null {
  if (pv.untagged === vlan) return 'untagged';
  if (vlan === 0) return null;
  if (pv.tagged === 'all' || pv.tagged.indexOf(vlan) >= 0) return 'tagged';
  return null;
}

/** The VLAN of a frame arriving at a port: its tag when the port carries it, else the untagged VLAN; null: dropped. */
export function ingressVlan(pv: PortVlans, tag: number | null): number | null {
  if (tag === null || tag === 0) return pv.untagged;
  if (pv.untagged === tag && pv.mode !== 'access') return tag;
  if (pv.tagged === 'all' || (pv.tagged as number[]).indexOf(tag) >= 0) return tag;
  return null;
}

function simAddrs(i: Interface): SimAddr[] {
  const out: SimAddr[] = [];
  for (const text of i.addresses) {
    const p = parsePrefix(text, false);
    if (!p) continue;
    const prefix = text.indexOf('/') >= 0 ? p.prefix : p.version === 4 ? 32 : 128;
    const net = networkOf({ ...p, prefix });
    out.push({ addr: { version: p.version, bytes: p.bytes }, net: { version: net.version, bytes: net.bytes, prefix }, text });
  }
  return out;
}

/** Build the simulated network of a model. */
export function buildNet(model: Model): SimNet {
  const macs = interfaceMacs(model);
  const ends = new Map<string, CableEnd>();
  const links = new Map<string, Link>();
  for (const l of model.links) {
    links.set(l.id, l);
    for (const [end, e] of [['a', l.a], ['b', l.b]] as Array<['a' | 'b', LinkEnd]>) {
      const port = e.iface || '@' + l.id;
      ends.set(portKey(e.device, port), { link: l.id, end, device: e.device, port });
    }
  }
  const devices = new Map<string, SimDevice>();
  const vlanSet = new Set<number>();
  for (const d of model.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
    // a device with a VLAN interface over two or more cabled ports switches between them (a firewall's switch group): it bridges like a Layer 3 switch
    const switchGroup = d.logical.some((i) => {
      if (i.type !== 'virtual' || i.members.length || !(i.addresses.length || i.dhcp)) return false;
      const vs = interfaceVlans(model, i);
      return vs.length > 0 && new Set(portsCarryingVlans(model, d.id, vs).map((p) => p.iface)).size >= 2;
    });
    const bridge = BRIDGE_TYPES.indexOf(d.type) >= 0 || switchGroup;
    const role = deviceRoutingRole(d);
    const sd: SimDevice = { id: d.id, dev: d, bridge, routes: role === 'router', ip: role !== null || bridge, l2switch: isLayer2Switch(d), bridgePorts: new Map(), portOf: new Map(), l3: new Map(), bridgeId: '' };
    const all = deviceInterfaces(d);
    const macOf = (id: string): { mac: string; simulated: boolean } => macs.get(d.id + ':' + id) || { mac: '00:00:00:00:00:00', simulated: true };
    // the aggregates and their members
    const memberOf = new Map<string, Interface>();
    for (const i of all) if (i.type === 'virtual' && i.members.length) for (const m of i.members) memberOf.set(m, i);
    for (const i of all) {
      const addrs = simAddrs(i);
      const base = { device: d.id, id: i.id, addrs, vrf: i.vrf || '', ...((): { mac: string; macSimulated: boolean } => {
        const m = macOf(i.id);
        return { mac: m.mac, macSimulated: m.simulated };
      })() };
      if (i.type === 'loopback') {
        if (addrs.length) sd.l3.set(i.id, { ...base, kind: 'loopback', vlan: 0, ports: [], mac: '', macSimulated: false });
        continue;
      }
      if (i.type === 'tunnel') {
        sd.l3.set(i.id, { ...base, kind: 'tunnel', vlan: 0, ports: [], mac: '', macSimulated: false });
        continue;
      }
      if (i.type === 'virtual' && i.members.length) {
        if (addrs.length || i.dhcp) sd.l3.set(i.id, { ...base, kind: 'aggregate', vlan: 0, ports: i.members.slice().sort(cmp) });
        continue;
      }
      if (i.type === 'virtual') {
        const vs = interfaceVlans(model, i);
        const vlan = vs.length ? vs[0] : 0;
        if (!addrs.length && !i.dhcp) continue;
        if (bridge) sd.l3.set(i.id, { ...base, kind: 'svi', vlan, ports: [] });
        else {
          // a subinterface: on the ports whose link end carries its VLAN, else its parent port ("ge-0/0/2.10")
          const dot = i.id.lastIndexOf('.');
          const parent = dot > 0 ? d.interfaces.find((p) => p.id === i.id.slice(0, dot)) : undefined;
          const carrying = vlan ? portsCarryingVlans(model, d.id, [vlan]).map((p) => p.iface) : [];
          const ports = carrying.length ? Array.from(new Set(carrying)).sort(cmp) : parent ? [parent.id] : [];
          sd.l3.set(i.id, { ...base, kind: 'subif', vlan, ports });
        }
        if (vlan) vlanSet.add(vlan);
        continue;
      }
      // a physical port: routed when it has an address (or DHCP), or on a device that does not bridge
      if (memberOf.has(i.id)) continue;
      if (addrs.length || i.dhcp || !bridge) sd.l3.set(i.id, { ...base, kind: 'routed', vlan: 0, ports: [i.id] });
    }
    if (bridge) {
      // bridge ports: cabled ports without addresses; an aggregate without addresses is one port
      const seen = new Set<string>();
      const add = (id: string, members: string[]): void => {
        const first = members.map((m) => ends.get(portKey(d.id, m))).find((x) => !!x);
        if (!first) return;
        const l = links.get(first.link) as Link;
        const pv = endPortVlans(model, l, first.end === 'a' ? l.a : l.b);
        if (pv.untagged) vlanSet.add(pv.untagged);
        if (pv.tagged !== 'all') for (const v of pv.tagged) vlanSet.add(v);
        sd.bridgePorts.set(id, { id, members, vlans: pv });
        for (const m of members) sd.portOf.set(m, id);
      };
      for (const i of all) {
        if (i.type === 'virtual' && i.members.length && !sd.l3.has(i.id)) {
          add(i.id, i.members.slice().sort(cmp));
          for (const m of i.members) seen.add(m);
        }
      }
      for (const i of d.interfaces) if (!seen.has(i.id) && !sd.l3.has(i.id) && ends.has(portKey(d.id, i.id))) add(i.id, [i.id]);
      // cable ends at the device that name no interface
      for (const [k, e] of ends) if (e.device === d.id && e.port.charAt(0) === '@' && k === portKey(d.id, e.port)) add(e.port, [e.port]);
      const macsHere = all.map((i) => macs.get(d.id + ':' + i.id)).filter((m): m is IfaceMac => !!m).map((m) => m.mac).sort();
      // (its priority is a simulation attribute, bridge_priority: the spanning tree reads it with StpConfig)
      sd.bridgeId = `32768.${macsHere[0] || '00:00:00:00:00:00'}`;
    }
    devices.set(d.id, sd);
  }
  // non-bridges: the cable ends that name no interface are their ports too (a routed port without an address)
  for (const [, e] of ends) {
    const sd = devices.get(e.device);
    if (sd && !sd.bridge && e.port.charAt(0) === '@' && !sd.l3.has(e.port)) {
      sd.l3.set(e.port, { device: e.device, id: e.port, kind: 'routed', addrs: [], vrf: '', vlan: 0, ports: [e.port], mac: macs.get(e.device + ':' + e.port) ? (macs.get(e.device + ':' + e.port) as IfaceMac).mac : '02:00:00:00:00:00', macSimulated: true });
    }
  }
  return { model, devices, ends, links, macs, vlans: Array.from(vlanSet).sort((a, b) => a - b) };
}

/** What the spanning tree reads of each bridge and port (the simulation's attributes; defaults without them). */
export interface StpConfig {
  /** the bridge priority of a switch in a VLAN (0–61440) */
  priority(dev: string, vlan: number): number;
  /** a bridge port's path cost */
  cost(dev: string, bp: string): number;
  /** a bridge port's priority (0–240) */
  portPriority(dev: string, bp: string): number;
  /** does the port take part in the spanning tree (send BPDUs, may be blocked)? */
  enabled(dev: string, bp: string): boolean;
  /** may the port never become the root port (root guard)? */
  rootGuard(dev: string, bp: string): boolean;
}

/** Without attributes: priority 32768, cost 20 000 (1 Gbit/s), port priority 128, every port in the tree, no root guard. */
export const STP_DEFAULTS: StpConfig = { priority: () => 32768, cost: () => 20000, portPriority: () => 128, enabled: () => true, rootGuard: () => false };

/**
 * The spanning tree of one VLAN, as IEEE 802.1D-2004 elects it: the root is
 * the bridge with the lowest bridge id (priority, then its MAC); every
 * other bridge's root port is the one with the lowest root path cost (the
 * sum of the receiving ports' path costs), then the lowest designated
 * bridge id, then the lowest designated port id (port priority, then
 * port); on each cable between two bridges the end with the better
 * priority vector is the designated port. Every other bridge port is an
 * alternate (blocked: frames of the VLAN neither leave nor enter there). A
 * port with root guard never becomes the root port: when the root lies
 * behind it, it is blocked (root-inconsistent). A port without spanning
 * tree takes no part (never blocked; a loop over it is not broken). Only
 * cables between two bridges matter (a router never forwards frames); each
 * connected part of the VLAN has its own root. Keys: "device|bridgePort".
 */
export function spanningTree(net: SimNet, vlan: number, linkDown: (id: string) => boolean, cfg: StpConfig = STP_DEFAULTS): { root: string; blocked: Set<string>; ports: Set<string>; inconsistent: Set<string>; rootPorts: Set<string> } {
  type Edge = { from: string; fromPort: string; to: string; toPort: string; link: string };
  const edges = new Map<string, Edge[]>();
  const bridges = Array.from(net.devices.values()).filter((d) => d.bridge);
  const mac = (d: SimDevice): string => d.bridgeId.split('.')[1] || '00:00:00:00:00:00';
  const bid = (id: string): string => `${String(cfg.priority(id, vlan)).padStart(5, '0')}.${mac(net.devices.get(id) as SimDevice)}`;
  const pid = (dev: string, bp: string): string => `${String(cfg.portPriority(dev, bp)).padStart(3, '0')}.${bp}`;
  for (const b of bridges) {
    const out: Edge[] = [];
    for (const bp of Array.from(b.bridgePorts.values()).sort((x, y) => cmp(x.id, y.id))) {
      if (!carries(bp.vlans, vlan) || !cfg.enabled(b.id, bp.id)) continue;
      for (const m of bp.members) {
        const e = net.ends.get(portKey(b.id, m));
        if (!e || linkDown(e.link)) continue;
        const o = otherEnd(net, e);
        const ob = net.devices.get(o.device);
        if (!ob || !ob.bridge) continue;
        const obp = ob.portOf.get(o.port);
        if (!obp || !carries((ob.bridgePorts.get(obp) as BridgePort).vlans, vlan) || !cfg.enabled(ob.id, obp)) continue;
        if (!out.some((x) => x.fromPort === bp.id && x.toPort === obp && x.to === ob.id)) out.push({ from: b.id, fromPort: bp.id, to: ob.id, toPort: obp, link: e.link });
      }
    }
    edges.set(b.id, out);
  }
  // each bridge's best vector to its part's root: [root id, cost, designated bridge, designated port, own port]
  type Vec = { root: string; cost: number; dBridge: string; dPort: string; port: string };
  const better = (x: Vec, y: Vec): boolean => {
    for (const [a, b] of [[x.root, y.root], [x.cost, y.cost], [x.dBridge, y.dBridge], [x.dPort, y.dPort], [x.port, y.port]] as Array<[string | number, string | number]>) {
      if (a === b) continue;
      return typeof a === 'number' ? a < (b as number) : cmp(a, b as string) < 0;
    }
    return false;
  };
  const best = new Map<string, Vec>();
  for (const b of bridges) if ((edges.get(b.id) as Edge[]).length) best.set(b.id, { root: bid(b.id), cost: 0, dBridge: bid(b.id), dPort: '', port: '' });
  const inconsistent = new Set<string>();
  // relax until stable (Bellman-Ford over the bridges: a few rounds for any real network)
  for (let round = 0; round < bridges.length + 1; round++) {
    let changed = false;
    for (const b of bridges) {
      const own: Vec = { root: bid(b.id), cost: 0, dBridge: bid(b.id), dPort: '', port: '' };
      let pick = own;
      for (const e of edges.get(b.id) as Edge[]) {
        const nb = best.get(e.to);
        if (!nb) continue;
        const v: Vec = { root: nb.root, cost: nb.cost + cfg.cost(b.id, e.fromPort), dBridge: bid(e.to), dPort: pid(e.to, e.toPort), port: pid(b.id, e.fromPort) };
        if (!better(v, pick)) continue;
        // root guard: a superior root behind the port is not taken (the port is root-inconsistent)
        if (cfg.rootGuard(b.id, e.fromPort) && cmp(v.root, own.root) < 0) {
          inconsistent.add(portKey(b.id, e.fromPort));
          continue;
        }
        pick = v;
      }
      const was = best.get(b.id);
      if (was && (edges.get(b.id) as Edge[]).length && (was.root !== pick.root || was.cost !== pick.cost || was.dBridge !== pick.dBridge || was.dPort !== pick.dPort || was.port !== pick.port)) {
        best.set(b.id, pick);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const ports = new Set<string>();
  const rootPorts = new Set<string>();
  const designated = new Set<string>();
  for (const b of bridges) {
    const v = best.get(b.id);
    if (!v) continue;
    for (const e of edges.get(b.id) as Edge[]) {
      ports.add(portKey(b.id, e.fromPort));
      if (v.port && v.port === pid(b.id, e.fromPort) && v.dBridge === bid(e.to) && v.dPort === pid(e.to, e.toPort)) rootPorts.add(portKey(b.id, e.fromPort));
      // the designated end of the cable: the better vector offered on it (its root, cost, bridge, port)
      const nb = best.get(e.to) as Vec;
      const mine = { root: v.root, cost: v.cost, dBridge: bid(b.id), dPort: pid(b.id, e.fromPort), port: '' };
      const theirs = { root: nb.root, cost: nb.cost, dBridge: bid(e.to), dPort: pid(e.to, e.toPort), port: '' };
      if (better(mine, theirs)) designated.add(portKey(b.id, e.fromPort));
    }
  }
  const blocked = new Set<string>();
  for (const k of ports) if (!rootPorts.has(k) && !designated.has(k)) blocked.add(k);
  for (const k of inconsistent) if (ports.has(k)) {
    blocked.add(k);
    rootPorts.delete(k);
  }
  // the root of the first part (the lowest id)
  let root = '';
  for (const b of bridges.slice().sort((x, y) => cmp(bid(x.id), bid(y.id)) || cmp(x.id, y.id))) {
    const v = best.get(b.id);
    if (v && v.root === bid(b.id)) {
      root = b.id;
      break;
    }
  }
  return { root, blocked, ports, inconsistent, rootPorts };
}

/**
 * The layer-3 interfaces in the broadcast domain of one (static: every
 * cable up, no spanning tree): out of its ports, through the bridges in the
 * VLAN the frames have there, to the routed interfaces, subinterfaces and
 * VLAN interfaces they reach. What a DHCP broadcast from it reaches (the
 * consistency checks). Its own interface is left out.
 */
export function broadcastPeers(net: SimNet, dev: string, iface: string): Array<{ dev: string; l3: L3Iface }> {
  const out: Array<{ dev: string; l3: L3Iface }> = [];
  const sd = net.devices.get(dev);
  const me = sd ? sd.l3.get(iface) : undefined;
  if (!sd || !me) return out;
  const seen = new Set<string>();
  const done = new Set<string>();
  const add = (d: string, l: L3Iface): void => {
    const k = d + ':' + l.id;
    if (seen.has(k) || (d === dev && l.id === iface)) return;
    seen.add(k);
    out.push({ dev: d, l3: l });
  };
  const l3At = (od: SimDevice, port: string, tag: number | null): L3Iface | undefined => {
    const cands = Array.from(od.l3.values()).filter((l) => l.ports.indexOf(port) >= 0).sort((a, b) => cmp(a.id, b.id));
    if (tag) return cands.find((l) => l.kind === 'subif' && l.vlan === tag);
    return cands.find((l) => l.kind === 'routed' || l.kind === 'aggregate' || l.kind === 'subif');
  };
  const bridge = (b: SimDevice, from: string | null, vlan: number): void => {
    const key = b.id + '|' + vlan;
    if (done.has(key)) return;
    done.add(key);
    for (const l of b.l3.values()) if (l.kind === 'svi' && l.vlan === vlan) add(b.id, l);
    for (const bp of Array.from(b.bridgePorts.values()).sort((x, y) => cmp(x.id, y.id))) {
      if (bp.id === from) continue;
      const c = carries(bp.vlans, vlan);
      if (!c) continue;
      for (const m of bp.members) cross(b.id, m, c === 'untagged' ? null : vlan);
    }
  };
  const cross = (d: string, port: string, tag: number | null): void => {
    const e = net.ends.get(portKey(d, port));
    if (!e) return;
    const o = otherEnd(net, e);
    const od = net.devices.get(o.device);
    if (!od) return;
    const bp = od.bridge ? od.portOf.get(o.port) : undefined;
    if (bp !== undefined) {
      const v = ingressVlan((od.bridgePorts.get(bp) as BridgePort).vlans, tag);
      if (v !== null) bridge(od, bp, v);
      return;
    }
    const l = l3At(od, o.port, tag);
    if (l) add(od.id, l);
  };
  if (me.kind === 'svi' && sd.bridge) bridge(sd, null, me.vlan);
  else for (const p of me.ports) cross(dev, p, me.kind === 'subif' && me.vlan ? me.vlan : null);
  return out;
}

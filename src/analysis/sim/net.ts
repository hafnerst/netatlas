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
  /** the bridge's id for the spanning tree: priority, then its lowest MAC */
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
      const prio = d.attrs.find(([k]) => k === 'stp-priority' || k === 'stp.priority');
      sd.bridgeId = `${String(prio && /^[0-9]+$/.test(prio[1]) ? Number(prio[1]) : 32768).padStart(5, '0')}.${macsHere[0] || '00:00:00:00:00:00'}`;
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

/**
 * The spanning tree of one VLAN: the bridge ports that are blocked (an
 * alternate port; frames of the VLAN neither leave nor enter there), for a
 * set of cables that are down. The root is the bridge with the lowest id
 * (priority, then MAC); every other bridge reaches it by the fewest
 * bridge-to-bridge hops (ties: the lower bridge id, then the lower port).
 * Only links between two bridges matter (a router never forwards frames).
 * `blocked` keys: "device|bridgePort".
 */
export function spanningTree(net: SimNet, vlan: number, linkDown: (id: string) => boolean): { root: string; blocked: Set<string>; ports: Set<string> } {
  type Edge = { from: string; fromPort: string; to: string; toPort: string; link: string };
  const edges = new Map<string, Edge[]>();
  const bridges = Array.from(net.devices.values()).filter((d) => d.bridge);
  for (const b of bridges) {
    const out: Edge[] = [];
    for (const bp of Array.from(b.bridgePorts.values()).sort((x, y) => cmp(x.id, y.id))) {
      if (!carries(bp.vlans, vlan)) continue;
      for (const m of bp.members) {
        const e = net.ends.get(portKey(b.id, m));
        if (!e || linkDown(e.link)) continue;
        const o = otherEnd(net, e);
        const ob = net.devices.get(o.device);
        if (!ob || !ob.bridge) continue;
        const obp = ob.portOf.get(o.port);
        if (!obp || !carries((ob.bridgePorts.get(obp) as BridgePort).vlans, vlan)) continue;
        if (!out.some((x) => x.fromPort === bp.id && x.toPort === obp && x.to === ob.id)) out.push({ from: b.id, fromPort: bp.id, to: ob.id, toPort: obp, link: e.link });
      }
    }
    edges.set(b.id, out);
  }
  const blocked = new Set<string>();
  const order = bridges.slice().sort((x, y) => cmp(x.bridgeId, y.bridgeId) || cmp(x.id, y.id));
  const tree = new Set<string>();
  const seen = new Set<string>();
  let root = '';
  // every connected part of the VLAN gets its own root (the lowest id in it)
  for (const r of order) {
    if (seen.has(r.id) || !(edges.get(r.id) as Edge[]).length) {
      seen.add(r.id);
      continue;
    }
    if (!root) root = r.id;
    seen.add(r.id);
    let frontier = [r.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const f of frontier) {
        const out = (edges.get(f) as Edge[]).slice().sort((x, y) => cmp((net.devices.get(x.to) as SimDevice).bridgeId, (net.devices.get(y.to) as SimDevice).bridgeId) || cmp(x.fromPort, y.fromPort));
        for (const e of out) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          tree.add(portKey(e.from, e.fromPort));
          tree.add(portKey(e.to, e.toPort));
          next.push(e.to);
        }
      }
      frontier = next;
    }
  }
  const ports = new Set<string>();
  for (const [b, out] of edges) for (const e of out) {
    ports.add(portKey(b, e.fromPort));
    if (!tree.has(portKey(b, e.fromPort))) blocked.add(portKey(b, e.fromPort));
  }
  return { root, blocked, ports };
}

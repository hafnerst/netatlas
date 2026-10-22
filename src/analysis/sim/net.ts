/**
 * The network the protocol simulation runs on, built once from the model:
 * which devices bridge frames and which route; the bridge ports of every
 * bridge with the VLANs they carry (from the ports' VLANs); the
 * layer-3 interfaces (routed ports, VLAN interfaces, subinterfaces,
 * aggregates) with their addresses, VLAN and MAC address; the cables
 * between ports; and, for a set of failed cables, the spanning tree of
 * every VLAN that keeps layer 2 loop-free. Pure and deterministic.
 *
 * Bridges: switches (Layer 2 and Layer 3), access points, IDS / IPS and
 * clouds, the devices the path tracer passes at layer 2, and every device
 * with a bridge port (a router with switch ports or an IRB / BVI). A routed
 * port (a router's port without VLANs, a Layer 3 switch's port set to
 * routed) is a layer-3 interface, never bridged. A Layer 3 switch's VLAN
 * interfaces route between its VLANs; a Layer 2 switch has at most one
 * (its management interface), which is a host on its bridge.
 *
 * Virtual networking (expandVirtual): each virtual switch of a Hypervisor
 * service is a bridge of its own ("hv1/vSwitch0") with the host's uplink
 * ports (their cables end there) and a port per vNIC on its port groups,
 * joined to the vNIC by a virtual link; it takes no part in the spanning
 * tree (the engine forwards with split horizon and its teaming). A vNIC in
 * passthrough takes the host port's cable. Each bridge and overlay
 * container network is a bridge too, with its host's bridge interface
 * (docker0) and the veths on it; a macvlan or ipvlan network takes its
 * parent port's cable, its host's own port joins it apart (the host can't
 * reach its children). A VM in an HA cluster has parked links to the same
 * port groups on the other members (where it may be restarted).
 *
 * VLANs of a bridge port (0 stands for "untagged, no VLAN known"), from
 * the port's `vlans` and `native` (an aggregate's for its members):
 *   access  carries its VLAN, untagged;
 *   trunk   its VLANs 802.1Q-tagged, the native one (if any) untagged;
 *   none    a port of an access point, IDS / IPS or cloud without VLANs is
 *           transparent: it carries every VLAN tagged, and untagged frames
 *           in the VLAN of the network the far end's addresses are in (when
 *           that is one VLAN), else 0.
 */
import { interfaceVlans, isBridgePort, portL2, subinterfaceParent, endL2 } from '../../model/derive';
import { deviceRoutingRole, isLayer2Switch, Capabilities, capabilities } from '../../model/capabilities';
import { parsePrefix, IpAddr } from '../../model/ip';
import { Device, Interface, Link, LinkEnd, Model, PortGroup, deviceInterfaces, ifaceKey } from '../../model/types';
import { cnetRef, clusterMembers, networkAttachments, portGroupAttachments, portGroupL2, portGroupOf, virtBridgeId, virtLinkId, vswitchRef, isVm } from '../../model/virtual';
import { networkOf } from '../ipmath';
import { ipConfigured } from '../../model/ipv6';
import { IfaceMac, interfaceMacs } from './mac';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);


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
  /** its IPv6 link-local address once duplicate address detection passed (ipv6.ts) */
  ll?: SimAddr;
  /** its written IPv6 addresses not usable now (tentative until duplicate address detection passes, or duplicates; ipv6.ts) */
  unusable?: string[];
}

export interface SimDevice {
  id: string;
  dev: Device;
  /** what it can do (model/capabilities.ts) */
  caps: Capabilities;
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
  /** a virtual switch or a container network run as a bridge (see the module comment) */
  virt?: VirtBridge;
}

/** A virtual switch or container network the simulation runs as a bridge of its own. */
export interface VirtBridge {
  kind: 'vswitch' | 'cnet';
  /** the device it runs on (a hypervisor; a container host or VM) */
  owner: string;
  name: string;
  /** vswitch:… / cnet:… */
  ref: string;
  driver?: string;
  /** its uplink bridge ports (to the host's ports), in teaming order */
  uplinks: string[];
  teaming?: string;
  /** a macvlan / ipvlan network: the bridge port of its host's own interface (never joined to the containers) */
  hostPort?: string;
}

/** A virtual link: the guest interface (or host interface) it joins to its virtual switch or network. */
export interface VirtLink {
  guest: string;
  iface: string;
  /** the bridge at its other end */
  bridge: string;
  /** an HA standby: where the VM would run (parked until it is restarted there) */
  at?: string;
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
  /** the virtual links by id */
  vlinks: Map<string, VirtLink>;
  /** an HA cluster's VMs: for each other member, its parked links (by the port key at the VM's end: the link) */
  standby: Map<string, Map<string, Map<string, string>>>;
  /** a host port whose cable ends elsewhere now (an uplink at its virtual switch, a passthrough port at its VM): model port key → where */
  moved: Map<string, { device: string; port: string }>;
}

/** The model's "device:port" of a port key: its first "|" (the end of the device part) becomes ":". */
export function portRefOf(key: string): string {
  const i = key.indexOf('|');
  return i < 0 ? key : key.slice(0, i) + ':' + key.slice(i + 1);
}

export function portKey(device: string, port: string): string {
  return device + '|' + port;
}

/** The other end of a cable. */
export function otherEnd(net: SimNet, e: CableEnd): CableEnd {
  const l = net.links.get(e.link) as Link;
  const o = e.end === 'a' ? l.b : l.a;
  return { link: e.link, end: e.end === 'a' ? 'b' : 'a', device: o.device, port: linkPort(net.model, l, o) };
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
  const p = endL2(model, e);
  if (p && p.kind === 'access') return { mode: 'access', untagged: p.untagged as number, tagged: [] };
  if (p && p.kind === 'trunk') return { mode: 'trunk', untagged: p.native !== undefined ? p.native : null, tagged: p.tagged };
  const far = e === l.a ? l.b : l.a;
  const v = addrVlan(model, far.device, far.iface);
  return { mode: 'none', untagged: v !== null ? v : 0, tagged: 'all' };
}

/** A bridge port's VLANs in words: "access port, VLAN 10", "trunk of VLANs 10,20 (native 10)". */
export function portVlansText(pv: PortVlans): string {
  if (pv.mode === 'access') return `access port, VLAN ${pv.untagged}`;
  const t = pv.tagged === 'all' ? 'every VLAN' : (pv.untagged !== null ? pv.tagged.concat([pv.untagged]) : pv.tagged).sort((x, y) => x - y).join(',');
  if (pv.mode === 'trunk') return `trunk of VLANs ${t}${pv.untagged !== null ? ` (native ${pv.untagged})` : ', no native VLAN'}`;
  return 'carries every VLAN';
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

/**
 * The simulation's port of a link end: its interface; a cable end that names
 * none, "@<link>"; a wireless connection's end at a radio of a Wireless
 * access, its association "<radio>~<link>" (several share a radio, each a
 * bridge port of its own in its Wi-Fi network's VLAN).
 */
export function linkPort(model: Model, l: Link, e: LinkEnd): string {
  if (e.iface === undefined) return '@' + l.id;
  if (l.medium === 'wireless' && l.wirelessNetwork !== undefined) {
    const d = model.index.devices.get(e.device);
    if (d && d.wireless && d.wireless.networks.some((x) => x.radio === e.iface)) return e.iface + '~' + l.id;
  }
  return e.iface;
}

/** Build the simulated network of a model. */
export function buildNet(model: Model): SimNet {
  const macs = interfaceMacs(model);
  const ends = new Map<string, CableEnd>();
  const links = new Map<string, Link>();
  for (const l of model.links) {
    links.set(l.id, l);
    for (const [end, e] of [['a', l.a], ['b', l.b]] as Array<['a' | 'b', LinkEnd]>) {
      const port = linkPort(model, l, e);
      ends.set(portKey(e.device, port), { link: l.id, end, device: e.device, port });
    }
  }
  const devices = new Map<string, SimDevice>();
  const vlanSet = new Set<number>();
  for (const d of model.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
    // a device with a bridge port (a router's switch ports, an IRB / BVI, a firewall's switch group) bridges like a Layer 3 switch
    const bridgeKind = (id: string): boolean => isBridgePort(portL2(model, d.id, id));
    const hasBridgePort = d.interfaces.some((i) => bridgeKind(i.id)) || d.logical.some((i) => i.type === 'virtual' && i.members.length > 0 && bridgeKind(i.id));
    // a device carries frames by what it can do: a switch, a transparent firewall, an access point, a filtering bridge, a Layer 2 System;
    // an inline device and a pass-through between their paired ports only (the engine keeps to the pairs); a cloud (external transit)
    // carries them between its attachments as one opaque Layer 3 hop (the engine counts the hop)
    const caps = capabilities(d);
    // (a router with Wireless access bridges its Wi-Fi networks to their VLANs)
    const bridge = caps.l2Forward || caps.inline || caps.passThrough || caps.externalTransit || hasBridgePort || (!!d.wireless && d.wireless.networks.length > 0);
    const routedPort = (id: string): boolean => {
      const p = portL2(model, d.id, id);
      return !!p && p.kind === 'routed';
    };
    const role = deviceRoutingRole(d);
    const sd: SimDevice = { id: d.id, dev: d, caps, bridge, routes: role === 'router', ip: (role !== null || bridge) && !caps.passThrough, l2switch: isLayer2Switch(d), bridgePorts: new Map(), portOf: new Map(), l3: new Map(), bridgeId: '' };
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
        // a routed aggregate (no VLANs): one layer-3 interface over its members
        if (!bridgeKind(i.id) && (addrs.length || ipConfigured(i) || routedPort(i.id) || !bridge)) sd.l3.set(i.id, { ...base, kind: 'aggregate', vlan: 0, ports: i.members.slice().sort(cmp) });
        continue;
      }
      if (i.type === 'virtual') {
        const vs = interfaceVlans(model, i);
        const vlan = vs.length ? vs[0] : 0;
        if (!addrs.length && !ipConfigured(i)) continue;
        const parent = subinterfaceParent(model, i);
        if (parent !== undefined) {
          // a subinterface ("ge-0/0/2.10"): its VLAN 802.1Q-tagged on its port (an aggregate: on its members)
          const pi = model.index.interfaces.get(ifaceKey(d.id, parent));
          sd.l3.set(i.id, { ...base, kind: 'subif', vlan, ports: pi && pi.members.length ? pi.members.slice().sort(cmp) : [parent] });
        } else if (bridge) sd.l3.set(i.id, { ...base, kind: 'svi', vlan, ports: [] });
        else sd.l3.set(i.id, { ...base, kind: 'subif', vlan, ports: [] });
        if (vlan) vlanSet.add(vlan);
        continue;
      }
      // a physical port: routed (a router's port without VLANs, a Layer 3 switch's routed port), or on a device that does not bridge
      if (memberOf.has(i.id)) continue;
      if (routedPort(i.id) || ((addrs.length || ipConfigured(i)) && !bridgeKind(i.id)) || !bridge) sd.l3.set(i.id, { ...base, kind: 'routed', vlan: 0, ports: [i.id] });
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
      // (a management interface is never a bridge port: nothing is forwarded to or from it)
      for (const i of d.interfaces) if (!seen.has(i.id) && !sd.l3.has(i.id) && ends.has(portKey(d.id, i.id)) && d.management.indexOf(i.id) < 0) add(i.id, [i.id]);
      // cable ends at the device that name no interface; the associations on its radios (one bridge port each, in its Wi-Fi network's VLAN)
      for (const [k, e] of ends) if (e.device === d.id && (e.port.charAt(0) === '@' || e.port.indexOf('~') > 0) && k === portKey(d.id, e.port)) add(e.port, [e.port]);
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
  const v = expandVirtual(model, devices, ends, links, vlanSet);
  return { model, devices, ends, links, macs, vlans: Array.from(vlanSet).sort((a, b) => a - b), vlinks: v.vlinks, standby: v.standby, moved: v.moved };
}

/** The VLANs a virtual switch's port carries for a port group (its port at a vNIC). */
function pgPortVlans(pg: PortGroup): PortVlans {
  const l2 = portGroupL2(pg);
  if (l2.kind === 'guest') return { mode: 'trunk', untagged: 0, tagged: 'all' };
  if (l2.kind === 'access') return { mode: 'access', untagged: l2.untagged as number, tagged: [] };
  return { mode: 'trunk', untagged: l2.native !== undefined ? l2.native : null, tagged: l2.vlans.filter((x) => x !== l2.native) };
}

/** The virtual networking of a model as bridges and virtual links (see the module comment). */
function expandVirtual(
  model: Model,
  devices: Map<string, SimDevice>,
  ends: Map<string, CableEnd>,
  links: Map<string, Link>,
  vlanSet: Set<number>,
): { vlinks: Map<string, VirtLink>; standby: Map<string, Map<string, Map<string, string>>>; moved: Map<string, { device: string; port: string }> } {
  const vlinks = new Map<string, VirtLink>();
  const standby = new Map<string, Map<string, Map<string, string>>>();
  const moved = new Map<string, { device: string; port: string }>();
  if (!model.devices.some((d) => !!d.hypervisor || !!d.containerEngine)) return { vlinks, standby, moved };
  const synth = (owner: Device, id: string, label: string, virt: VirtBridge): SimDevice => {
    const dev: Device = { ...owner, id, label, type: virt.kind === 'vswitch' ? 'virtual_switch' : 'container_network', interfaces: [], logical: [], routes: [], dnsNames: [], hypervisor: undefined, containerEngine: undefined, host: undefined };
    const sd: SimDevice = { id, dev, caps: capabilities({ type: '' }), bridge: true, routes: false, ip: false, l2switch: false, bridgePorts: new Map(), portOf: new Map(), l3: new Map(), bridgeId: '32768.00:00:00:00:00:00', virt };
    devices.set(id, sd);
    return sd;
  };
  const addPort = (sd: SimDevice, id: string, members: string[], vlans: PortVlans): void => {
    sd.bridgePorts.set(id, { id, members, vlans });
    for (const m of members) sd.portOf.set(m, id);
    if (vlans.untagged) vlanSet.add(vlans.untagged);
    if (vlans.tagged !== 'all') for (const x of vlans.tagged) vlanSet.add(x);
  };
  const link = (id: string, a: LinkEnd, b: LinkEnd, endsToo = true): void => {
    links.set(id, { id, a, b, medium: 'virtual', direction: 'bidirectional', attrs: [], line: 0 });
    if (!endsToo) return;
    ends.set(portKey(a.device, a.iface as string), { link: id, end: 'a', device: a.device, port: a.iface as string });
    ends.set(portKey(b.device, b.iface as string), { link: id, end: 'b', device: b.device, port: b.iface as string });
  };
  // a cable end moves from a port to another device's port (the link keeps its id)
  const repoint = (device: string, port: string, to: string, toPort: string): boolean => {
    const e = ends.get(portKey(device, port));
    if (!e) return false;
    const l = links.get(e.link) as Link;
    const ne: LinkEnd = { device: to, iface: toPort };
    links.set(l.id, e.end === 'a' ? { ...l, a: ne } : { ...l, b: ne });
    ends.delete(portKey(device, port));
    ends.set(portKey(to, toPort), { link: l.id, end: e.end, device: to, port: toPort });
    moved.set(portKey(device, port), { device: to, port: toPort });
    return true;
  };
  const membersOf = (d: Device, id: string): string[] => {
    const i = model.index.interfaces.get(ifaceKey(d.id, id));
    return i && i.type === 'virtual' && i.members.length ? i.members.slice().sort(cmp) : [id];
  };
  const ownerSd = (id: string): SimDevice | undefined => devices.get(id);
  // virtual switches
  for (const h of model.devices) {
    if (!h.hypervisor) continue;
    const hs = ownerSd(h.id);
    for (const vs of h.hypervisor.vswitches) {
      if (!vs.name) continue;
      const id = virtBridgeId(h.id, vs.name);
      const sd = synth(h, id, `${h.label} ${vs.name}`, { kind: 'vswitch', owner: h.id, name: vs.name, ref: vswitchRef(h.id, vs.name), uplinks: [], teaming: vs.teaming });
      // the uplinks carry every port group's VLAN tagged (guest tagging: every VLAN), a port group without a VLAN untagged
      const tagged = new Set<number>();
      let all = false;
      let untagged: number | null = null;
      for (const pg of vs.portGroups) {
        const l2 = portGroupL2(pg);
        if (l2.kind === 'guest') all = true;
        else if (!l2.vlans.length) untagged = 0;
        else for (const x of l2.vlans) tagged.add(x);
      }
      const upVlans: PortVlans = { mode: 'trunk', untagged, tagged: all ? 'all' : Array.from(tagged).sort((a, b) => a - b) };
      for (const u of vs.uplinks) {
        const ms = membersOf(h, u).filter((m) => repoint(h.id, m, id, m));
        if (!ms.length) continue;
        addPort(sd, u, ms, upVlans);
        (sd.virt as VirtBridge).uplinks.push(u);
        if (hs) {
          hs.l3.delete(u);
          for (const m of ms) hs.l3.delete(m);
        }
      }
      for (const pg of vs.portGroups) {
        for (const i of portGroupAttachments(model, h, pg.name)) {
          const port = `${i.device}.${i.id}`;
          addPort(sd, port, [port], pgPortVlans(pg));
          const lid = virtLinkId(i.device, i.id);
          link(lid, { device: id, iface: port }, { device: i.device, iface: i.id });
          vlinks.set(lid, { guest: i.device, iface: i.id, bridge: id });
        }
      }
    }
    // passthrough: the vNIC takes the host port's cable
    for (const g of model.devices) {
      if (!isVm(g) || g.host !== h.id) continue;
      for (const i of g.logical) {
        if (i.type !== 'vnic' || i.passthrough === undefined) continue;
        if (repoint(h.id, i.passthrough, g.id, i.id) && hs) hs.l3.delete(i.passthrough);
      }
    }
  }
  // an HA cluster's VMs: parked links to the same port groups on the other members
  for (const g of model.devices) {
    if (!isVm(g) || g.host === undefined) continue;
    const h = model.index.devices.get(g.host);
    const cluster = h && h.hypervisor ? h.hypervisor.cluster : undefined;
    if (!h || cluster === undefined || g.logical.some((i) => i.type === 'vnic' && i.passthrough !== undefined)) continue;
    for (const m of clusterMembers(model, cluster)) {
      if (m.id === h.id) continue;
      const byPort = new Map<string, string>();
      for (const i of g.logical) {
        if (i.type !== 'vnic' || i.portGroup === undefined) continue;
        const x = portGroupOf(m, i.portGroup);
        const bid = x ? virtBridgeId(m.id, x.vswitch.name) : '';
        const sd = devices.get(bid);
        if (!x || !sd) continue;
        const port = `${g.id}.${i.id}`;
        addPort(sd, port, [port], pgPortVlans(x.pg));
        const lid = virtLinkId(g.id, i.id, m.id);
        // only the switch's end is in place: the VM's end joins when it is restarted there
        link(lid, { device: bid, iface: port }, { device: g.id, iface: i.id }, false);
        ends.set(portKey(bid, port), { link: lid, end: 'a', device: bid, port });
        vlinks.set(lid, { guest: g.id, iface: i.id, bridge: bid, at: m.id });
        byPort.set(portKey(g.id, i.id), lid);
      }
      if (byPort.size) {
        if (!standby.has(g.id)) standby.set(g.id, new Map());
        (standby.get(g.id) as Map<string, Map<string, string>>).set(m.id, byPort);
      }
    }
  }
  // container networks
  for (const o of model.devices) {
    if (!o.containerEngine) continue;
    const os = ownerSd(o.id);
    for (const net of o.containerEngine.networks) {
      if (!net.name || net.driver === 'host' || net.driver === 'none' || !net.driver) continue;
      const id = virtBridgeId(o.id, net.name);
      const sd = synth(o, id, `${o.label} ${net.name}`, { kind: 'cnet', owner: o.id, name: net.name, ref: cnetRef(o.id, net.name), driver: net.driver, uplinks: [] });
      let vlan = 0;
      if ((net.driver === 'macvlan' || net.driver === 'ipvlan') && net.parent !== undefined) {
        const pi = model.index.interfaces.get(ifaceKey(o.id, net.parent));
        let phys = net.parent;
        let pv: PortVlans = { mode: 'access', untagged: 0, tagged: [] };
        if (pi && pi.type === 'virtual' && !pi.members.length) {
          const p = subinterfaceParent(model, pi);
          const vs = interfaceVlans(model, pi);
          if (p !== undefined && vs.length) {
            phys = p;
            vlan = vs[0];
            pv = { mode: 'trunk', untagged: null, tagged: [vlan] };
          }
        }
        const ms = membersOf(o, phys);
        const moved = ms.filter((m) => repoint(o.id, m, id, m));
        if (moved.length) {
          addPort(sd, phys, moved, pv);
          (sd.virt as VirtBridge).uplinks.push(phys);
          // the host's own port joins the network apart (it never reaches the containers)
          const hp = `${o.id}.${phys}`;
          addPort(sd, hp, moved.map((m) => `${o.id}.${m}`), pv);
          (sd.virt as VirtBridge).hostPort = hp;
          for (const m of moved) {
            const lid = virtLinkId(o.id, m);
            link(lid, { device: id, iface: `${o.id}.${m}` }, { device: o.id, iface: m });
            vlinks.set(lid, { guest: o.id, iface: m, bridge: id });
          }
          // an HA standby link that ended at the parent (a VM's vNIC) ends at the network's port now
          for (const [, byHost] of standby) {
            for (const [, byPort] of byHost) {
              const lid = byPort.get(portKey(o.id, phys));
              if (lid === undefined) continue;
              const l = links.get(lid) as Link;
              links.set(lid, { ...l, b: { device: id, iface: phys } });
              byPort.delete(portKey(o.id, phys));
              byPort.set(portKey(id, phys), lid);
            }
          }
        }
      }
      const access: PortVlans = vlan ? { mode: 'access', untagged: vlan, tagged: [] } : { mode: 'access', untagged: 0, tagged: [] };
      // a bridge network: its interface on the host (docker0) is on it
      if (net.driver === 'bridge' && net.iface !== undefined && model.index.interfaces.has(ifaceKey(o.id, net.iface))) {
        const port = `${o.id}.${net.iface}`;
        addPort(sd, port, [port], access);
        const lid = virtLinkId(o.id, net.iface);
        link(lid, { device: id, iface: port }, { device: o.id, iface: net.iface });
        vlinks.set(lid, { guest: o.id, iface: net.iface, bridge: id });
        // the host forwards between its bridge networks and the rest (with NAT, when set)
        if (os && net.gateway !== undefined) os.routes = true;
      }
      for (const i of networkAttachments(model, o, net)) {
        const port = `${i.device}.${i.id}`;
        addPort(sd, port, [port], access);
        const lid = virtLinkId(i.device, i.id);
        link(lid, { device: id, iface: port }, { device: i.device, iface: i.id });
        vlinks.set(lid, { guest: i.device, iface: i.id, bridge: id });
      }
    }
  }
  return { vlinks, standby, moved };
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
  // (a virtual switch or container network takes no part: it never loops, see the engine)
  const bridges = Array.from(net.devices.values()).filter((d) => d.bridge && !d.virt);
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
        if (!ob || !ob.bridge || ob.virt) continue;
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
 * The state a broadcast domain is taken in. Static analysis passes nothing
 * (every cable and port up, no spanning tree) or a failure's state; the
 * engine passes its live state.
 */
export interface L2State {
  /** is a cable up */
  cableUp?(link: string): boolean;
  /** is a port up (a device that is off: none of its ports) */
  portUp?(dev: string, port: string): boolean;
  /** does a device forward frames (a device that is off does not; a failed-open inline one does, as a wire) */
  forwards?(dev: string): boolean;
  /** is a bridge port blocked in a VLAN (the spanning tree, a port still learning) */
  blocked?(dev: string, bp: string, vlan: number): boolean;
  /** may an aggregate's member port distribute (LACP) */
  memberReady?(dev: string, port: string): boolean;
}

/** One layer-3 interface a broadcast domain reaches. */
export interface L2Reach {
  dev: string;
  /** the layer-3 interface */
  l3: L3Iface;
  /** the port it was reached at (its own port; for a VLAN interface, its own id) */
  port: string;
}

/** A broadcast domain: what a broadcast from an interface (or within a cable's VLAN) reaches at layer 2. */
export interface L2Domain {
  /** the VLAN it starts in (0: untagged, no VLAN known); null: no VLAN context could be determined (see `ambiguous`) */
  vlan: number | null;
  /** the layer-3 interfaces reached, its own included */
  reached: L2Reach[];
  /** the bridges it crosses, with the VLAN it has in each */
  bridges: Array<{ dev: string; vlan: number }>;
  /** the bridge ports it enters a bridge at, and leaves it by ("device|bridgePort") */
  entered: string[];
  left: string[];
  /** the physical ports it leaves a device by ("device|port") */
  out: string[];
  /** the cables it crosses */
  links: string[];
  /** the start names no VLAN context (a trunk port, a radio with several Wi-Fi networks, an interface without a cable): why */
  ambiguous?: string;
  /** the start has no cable: the model says nothing about its segment */
  uncabled?: boolean;
}

/**
 * The broadcast domain of an interface (or of a cable in one VLAN), one
 * definition for the simulation, the consistency checks and the static
 * analysis: out of the interface's ports, through the bridges in the VLAN
 * the frames have there (a port's access VLAN, a trunk's tag or native
 * VLAN, a Wi-Fi network's VLAN, a port group's VLAN, a container network),
 * to the routed interfaces, subinterfaces and VLAN interfaces it reaches.
 * No router passes it on. An inline or pass-through device passes it
 * between its paired ports only (a one-way pair: from a to b); a filtering
 * bridge into its other domain only; a Wi-Fi network tunneled to its
 * controller ends at its access point. A start that names no VLAN context
 * (a trunk port, a radio with several networks, without `vlan`) is
 * ambiguous: nothing is reached, and `ambiguous` says why — an unknown VLAN
 * never means every VLAN.
 */
export function l2Domain(net: SimNet, from: { dev: string; iface: string; vlan?: number } | { link: string; vlan: number }, st: L2State = {}): L2Domain {
  const out: L2Domain = { vlan: null, reached: [], bridges: [], entered: [], left: [], out: [], links: [] };
  const cableUp = (id: string): boolean => !st.cableUp || st.cableUp(id);
  const portUp = (d: string, p: string): boolean => !st.portUp || st.portUp(d, p);
  const forwards = (d: SimDevice): boolean => !st.forwards || st.forwards(d.virt ? d.virt.owner : d.id);
  const blocked = (d: string, bp: string, v: number): boolean => !!st.blocked && st.blocked(d, bp, v);
  const ready = (d: string, p: string): boolean => !st.memberReady || st.memberReady(d, p);
  const seenL3 = new Set<string>();
  const seenLink = new Set<string>();
  const done = new Set<string>();
  const reach = (d: SimDevice, l3: L3Iface, port: string): void => {
    const k = d.id + ':' + l3.id;
    if (seenL3.has(k)) return;
    seenL3.add(k);
    out.reached.push({ dev: d.id, l3, port });
  };
  const l3At = (od: SimDevice, port: string, tag: number | null): L3Iface | undefined => {
    const cands = Array.from(od.l3.values()).filter((l) => l.ports.indexOf(port) >= 0).sort((a, b) => cmp(a.id, b.id));
    if (tag) return cands.find((l) => l.kind === 'subif' && l.vlan === tag);
    return cands.find((l) => l.kind === 'routed' || l.kind === 'aggregate' || (l.kind === 'subif' && !l.vlan));
  };
  // what may leave a bridge after entering at a port (see the function comment); null: any port
  const onlyTo = (sd: SimDevice, from: string | null): string[] | null => {
    if (from === null) return null;
    const c = sd.caps;
    const d = sd.dev;
    if (c.inline || c.passThrough) {
      const pair = d.portPairs.find((p) => p.a === from || p.b === from);
      if (!pair || (pair.direction === 'a_to_b' && pair.a !== from)) return [];
      return [pair.a === from ? pair.b : pair.a];
    }
    if (c.securityGateway && d.separation && c.separation === 'filtering_bridge') {
      const fromD = d.separation.domains.find((x) => x.interfaces.indexOf(from) >= 0);
      const toD = fromD ? d.separation.domains.find((x) => x.name !== fromD.name) : undefined;
      return toD ? toD.interfaces.slice() : [];
    }
    return null;
  };
  const tunneled = (sd: SimDevice, port: string): boolean => {
    const k = port.indexOf('~');
    if (k < 0 || !sd.dev.wireless) return false;
    const l = net.links.get(port.slice(k + 1));
    const w = l ? sd.dev.wireless.networks.find((x) => x.id === l.wirelessNetwork) : undefined;
    return !!w && w.forwarding === 'tunneled';
  };
  const cross = (dev: string, port: string, tag: number | null): void => {
    const e = net.ends.get(portKey(dev, port));
    if (!e || !cableUp(e.link) || !portUp(dev, port)) return;
    const o = otherEnd(net, e);
    const od = net.devices.get(o.device);
    const bpId = od && od.bridge ? od.portOf.get(o.port) : undefined;
    // a cable whose far end discards (a VLAN it does not carry, an alternate port of the spanning tree) is not in the domain
    const v = od && bpId !== undefined ? ingressVlan((od.bridgePorts.get(bpId) as BridgePort).vlans, tag) : null;
    if (od && bpId !== undefined && (v === null || blocked(od.id, bpId, v))) return;
    out.out.push(portKey(dev, port));
    if (!seenLink.has(e.link)) {
      seenLink.add(e.link);
      out.links.push(e.link);
    }
    if (!od || !portUp(o.device, o.port)) return;
    if (bpId !== undefined) {
      bridge(od, bpId, v as number);
      return;
    }
    const l3 = l3At(od, o.port, tag);
    if (l3) reach(od, l3, o.port);
  };
  const bridge = (sd: SimDevice, fromBp: string | null, v: number): void => {
    if (fromBp !== null) out.entered.push(portKey(sd.id, fromBp));
    const key = sd.id + '|' + v + '|' + (fromBp !== null && onlyTo(sd, fromBp) ? fromBp : '');
    if (done.has(key)) return;
    done.add(key);
    if (!out.bridges.some((b) => b.dev === sd.id && b.vlan === v)) out.bridges.push({ dev: sd.id, vlan: v });
    if (!forwards(sd)) return;
    if (fromBp !== null && tunneled(sd, fromBp)) return;
    for (const l3 of sd.l3.values()) if (l3.kind === 'svi' && l3.vlan === v) reach(sd, l3, l3.id);
    const only = onlyTo(sd, fromBp);
    for (const bp of Array.from(sd.bridgePorts.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (bp.id === fromBp || (only && only.indexOf(bp.id) < 0 && !bp.members.some((m) => only.indexOf(m) >= 0))) continue;
      const c = carries(bp.vlans, v);
      if (!c || blocked(sd.id, bp.id, v) || tunneled(sd, bp.id)) continue;
      const up = bp.members.filter((m) => portUp(sd.id, m) && ready(sd.id, m) && net.ends.has(portKey(sd.id, m))).sort(cmp);
      if (!up.length) continue;
      out.left.push(portKey(sd.id, bp.id));
      cross(sd.id, up[0], c === 'untagged' ? null : v);
    }
  };
  if ('link' in from) {
    out.vlan = from.vlan;
    const l = net.links.get(from.link);
    if (!l) return out;
    for (const e of [l.a, l.b]) {
      const sd = net.devices.get(e.device);
      const p = linkPort(net.model, l, e);
      const bpId = sd && sd.bridge ? sd.portOf.get(p) : undefined;
      if (sd && bpId !== undefined && carries((sd.bridgePorts.get(bpId) as BridgePort).vlans, from.vlan) && !blocked(sd.id, bpId, from.vlan)) bridge(sd, null, from.vlan);
      else if (sd) {
        const l3 = l3At(sd, p, from.vlan || null) || l3At(sd, p, null);
        if (l3) reach(sd, l3, p);
      }
    }
    if (cableUp(from.link) && !seenLink.has(from.link)) out.links.push(from.link);
    return out;
  }
  const sd = net.devices.get(from.dev);
  if (!sd) return out;
  const own = sd.l3.get(from.iface);
  if (own) {
    if (own.kind === 'loopback' || own.kind === 'tunnel') {
      out.ambiguous = `${from.dev}:${from.iface} is a ${own.kind}: it is on no switched segment`;
      return out;
    }
    reach(sd, own, own.kind === 'svi' ? own.id : own.ports[0] || own.id);
    if (own.kind === 'svi') {
      out.vlan = own.vlan;
      bridge(sd, null, own.vlan);
      return out;
    }
    out.vlan = own.kind === 'subif' ? own.vlan : 0;
    const cabled = own.ports.some((p) => net.ends.has(portKey(sd.id, p)));
    if (!cabled) out.uncabled = true;
    for (const p of own.ports) {
      if (!portUp(sd.id, p) || !net.ends.has(portKey(sd.id, p))) continue;
      cross(sd.id, p, own.kind === 'subif' && own.vlan ? own.vlan : null);
      break;
    }
    return out;
  }
  // a bridge port (a switch port, a radio): the VLAN it says, or the one given
  const bpId = sd.bridge ? sd.portOf.get(from.iface) : undefined;
  if (bpId !== undefined || (sd.bridge && sd.dev.wireless && sd.dev.wireless.networks.some((w) => w.radio === from.iface))) {
    const pvs = bpId !== undefined ? [(sd.bridgePorts.get(bpId) as BridgePort).vlans] : Array.from(sd.bridgePorts.values()).filter((b) => b.id.indexOf(from.iface + '~') === 0).map((b) => b.vlans);
    const known = new Set<number>();
    for (const pv of pvs) {
      if (pv.untagged !== null && pv.mode !== 'trunk') known.add(pv.untagged);
      else if (pv.mode === 'trunk') known.add(-1);
    }
    let v: number | undefined = from.vlan;
    if (v === undefined && known.size === 1 && !known.has(-1)) v = Array.from(known)[0];
    if (v === undefined) {
      out.ambiguous = `${from.dev}:${from.iface} ${bpId !== undefined ? `is a ${portVlansText(pvs[0])}` : 'is a radio with several Wi-Fi networks'}: name the VLAN to take its segment`;
      return out;
    }
    if (!pvs.some((pv) => carries(pv, v as number))) {
      out.ambiguous = `${from.dev}:${from.iface} does not carry VLAN ${v}`;
      return out;
    }
    out.vlan = v;
    bridge(sd, null, v);
    return out;
  }
  // a cabled port of a device that neither bridges nor has a layer-3 interface there
  if (net.ends.has(portKey(sd.id, from.iface))) {
    out.vlan = from.vlan !== undefined ? from.vlan : 0;
    cross(sd.id, from.iface, from.vlan ? from.vlan : null);
    return out;
  }
  out.uncabled = true;
  return out;
}

/**
 * The layer-3 interfaces in the broadcast domain of one (static: every
 * cable up, no spanning tree; l2Domain). What a DHCP broadcast from it
 * reaches (the consistency checks). Its own interface is left out.
 */
export function broadcastPeers(net: SimNet, dev: string, iface: string): Array<{ dev: string; l3: L3Iface }> {
  const sd = net.devices.get(dev);
  if (!sd || !sd.l3.get(iface)) return [];
  return l2Domain(net, { dev, iface })
    .reached.filter((r) => !(r.dev === dev && r.l3.id === iface))
    .map((r) => ({ dev: r.dev, l3: r.l3 }));
}

const netCache = new WeakMap<Model, SimNet>();

/** The simulated network of a model, built once per model (for the static analysis; the engine builds its own). */
export function netOf(model: Model): SimNet {
  let n = netCache.get(model);
  if (!n) {
    n = buildNet(model);
    netCache.set(model, n);
  }
  return n;
}

/**
 * Derived, read-only facts. Each is configured once in the YAML file and
 * computed here for every other view; none of it is ever written back:
 *
 *   configured (authoritative)            derived
 *   ------------------------------------  ------------------------------------
 *   network `cidr`, interface `ip`        members of a network (IP containment)
 *   network `vlan` (+ the two above)      VLAN of an interface address
 *   a port's `vlans`/`native`/`routed`   what it is at layer 2 (access, trunk,
 *     (an aggregate's for its members)    routed), the VLANs a cable carries at
 *     + network `vlan`                    each end, the networks of those
 *                                         VLANs, and how the two ends differ
 *   the VLAN of a VLAN interface          its bridge ports: every port of the
 *     (its `vlan`, or the VLAN of the     device in that VLAN
 *     network of its address)
 *     + the ports' VLANs
 *   interface `ip`                        which interfaces own an address
 *
 * Membership rule: an address belongs to a network when the network's prefix
 * contains it. The network's prefix is the authority; the prefix length
 * written on the interface is ignored. IPv4 and IPv6 never match each other.
 * An address that is not a valid IPv4/IPv6 address (with an optional, valid
 * prefix length) belongs to no network, and an interface with DHCP on has no
 * configured address, so it makes its device a member of nothing.
 *
 * Overlapping networks: an address inside the prefixes of several networks
 * (e.g. a /24 inside a /16) belongs to every one of them; nothing is chosen.
 * Where the distinction matters, the result is reported instead of guessed:
 * the VLAN of such an address is derived only when all those networks agree
 * on it, otherwise it is "ambiguous" (with a validation warning).
 *
 * Membership (containment) and the ports' VLANs (layer-2 carriage) are
 * separate facts: neither is derived from the other. The networks a cable
 * carries follow from its ports' VLANs and the networks' VLANs.
 */
import { IpPrefix, addrKey, parsePrefix, prefixContains } from './ip';
import { Interface, Link, LinkEnd, Model, Network, PortKind, VLAN_MAX, VlanRange, deviceInterfaces, ifaceKey, isLoopback } from './types';
import { deviceRoutingRole, capabilities } from './capabilities';
import { compareNames } from './order';

/** One assigned address that lies inside a network. */
export interface AddressMatch {
  device: string;
  iface: string;
  loopback: boolean;
  /** as written on the interface */
  address: string;
}

/** A device that is a member of a network, with every address that makes it one. */
export interface NetworkMember {
  device: string;
  matches: AddressMatch[];
}

export type DerivedVlan =
  /** no containing network defines a VLAN */
  | { state: 'none' }
  | { state: 'vlan'; vlan: number }
  /** containing networks define different VLANs: nothing is chosen */
  | { state: 'ambiguous'; vlans: number[] };

/** What one interface address is associated with. */
export interface AddressAssoc {
  /** as written */
  address: string;
  /** false: not a usable IPv4/IPv6 address, so it matches nothing */
  valid: boolean;
  /** ids of all networks containing the address, in model order */
  networks: string[];
  vlan: DerivedVlan;
}

/** An interface that has an address configured. */
export interface AddressOwner {
  device: string;
  iface: string;
}

export interface Derived {
  /** network id -> member devices, in device order (each device once) */
  members: Map<string, NetworkMember[]>;
  /** "device:iface" -> one entry per assigned address, in address order */
  addresses: Map<string, AddressAssoc[]>;
  /** canonical address (ip.addrKey, prefix length ignored) -> the interfaces that have it, in model order */
  owners: Map<string, AddressOwner[]>;
}

/** The valid prefix of a network as a list: empty while it is missing or invalid. */
export function networkPrefixes(n: Network): IpPrefix[] {
  const p = n.cidr !== undefined ? parsePrefix(n.cidr) : null;
  return p ? [p] : [];
}

/** Networks whose prefix contains `address` ("a.b.c.d", "a.b.c.d/len", IPv6 likewise). */
export function containingNetworks(address: string, networks: Network[]): Network[] {
  const a = parsePrefix(address, false);
  if (!a) return [];
  return networks.filter((n) => networkPrefixes(n).some((p) => prefixContains(p, a)));
}

/** The VLAN that follows from a set of containing networks. */
export function derivedVlan(networks: Network[]): DerivedVlan {
  const vlans: number[] = [];
  for (const n of networks) if (n.vlan !== undefined && vlans.indexOf(n.vlan) < 0) vlans.push(n.vlan);
  if (!vlans.length) return { state: 'none' };
  if (vlans.length === 1) return { state: 'vlan', vlan: vlans[0] };
  return { state: 'ambiguous', vlans: vlans.sort((p, q) => p - q) };
}

const cache = new WeakMap<Model, Derived>();

/** All derived facts of a model (computed once per model object). */
export function derive(model: Model): Derived {
  const known = cache.get(model);
  if (known) return known;
  const nets = model.networks.map((n) => ({ n, prefixes: networkPrefixes(n) }));
  const members = new Map<string, NetworkMember[]>();
  for (const { n } of nets) members.set(n.id, []);
  const addresses = new Map<string, AddressAssoc[]>();
  const owners = new Map<string, AddressOwner[]>();
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      const assocs: AddressAssoc[] = [];
      for (const address of i.addresses) {
        const a = parsePrefix(address, false);
        if (a) {
          const k = addrKey(a);
          const list = owners.get(k) || [];
          if (!list.some((o) => o.device === d.id && o.iface === i.id)) list.push({ device: d.id, iface: i.id });
          owners.set(k, list);
        }
        // (a container network's members are only the devices behind its host)
        const inside = a ? nets.filter((x) => (!x.n.scope || x.n.scope.indexOf(d.id) >= 0) && x.prefixes.some((p) => prefixContains(p, a))).map((x) => x.n) : [];
        assocs.push({ address, valid: !!a, networks: inside.map((n) => n.id), vlan: derivedVlan(inside) });
        for (const n of inside) {
          const list = members.get(n.id) as NetworkMember[];
          let m = list[list.length - 1];
          if (!m || m.device !== d.id) {
            m = { device: d.id, matches: [] };
            list.push(m);
          }
          m.matches.push({ device: d.id, iface: i.id, loopback: isLoopback(i), address });
        }
      }
      addresses.set(ifaceKey(d.id, i.id), assocs);
    }
  }
  const out = { members, addresses, owners };
  cache.set(model, out);
  return out;
}

/** The interfaces that have `address` configured (a prefix length on it is ignored), in model order. */
export function addressOwners(model: Model, address: string): AddressOwner[] {
  const a = parsePrefix(address, false);
  return a ? derive(model).owners.get(addrKey(a)) || [] : [];
}

export function networkMembers(model: Model, networkId: string): NetworkMember[] {
  return derive(model).members.get(networkId) || [];
}

export function interfaceAddresses(model: Model, device: string, iface: string): AddressAssoc[] {
  return derive(model).addresses.get(ifaceKey(device, iface)) || [];
}

/** Ids of the networks a device is a member of, in model order. */
export function deviceNetworks(model: Model, device: string): string[] {
  const d = derive(model);
  return model.networks.filter((n) => (d.members.get(n.id) as NetworkMember[]).some((m) => m.device === device)).map((n) => n.id);
}

/** Ids of the networks containing an address of one interface, in model order. */
export function interfaceNetworks(model: Model, device: string, iface: string): string[] {
  const ids = new Set<string>();
  for (const a of interfaceAddresses(model, device, iface)) for (const n of a.networks) ids.add(n);
  return model.networks.filter((n) => ids.has(n.id)).map((n) => n.id);
}

/** Read-only text of a derived VLAN; an ambiguity is spelled out, never resolved. */
export function derivedVlanText(v: DerivedVlan): string {
  if (v.state === 'vlan') return 'VLAN ' + v.vlan;
  if (v.state === 'ambiguous') return 'ambiguous: VLAN ' + v.vlans.join(' or ');
  return '';
}

/** Short VLAN text of a whole interface: every distinct result of its addresses. */
export function interfaceVlanText(assocs: AddressAssoc[]): string {
  const parts: string[] = [];
  for (const a of assocs) {
    const t = derivedVlanText(a.vlan);
    if (t && parts.indexOf(t) < 0) parts.push(t);
  }
  return parts.join(', ');
}

// ------------------------------------------------------- ports at layer 2

/** The VLAN IDs of a list of ranges, each once, ascending. */
export function vlanIds(ranges: VlanRange[]): number[] {
  const seen = new Set<number>();
  for (const r of ranges) for (let v = Math.max(1, r.from); v <= Math.min(VLAN_MAX, r.to); v++) seen.add(v);
  return Array.from(seen).sort((p, q) => p - q);
}

/** IDs as the shortest list of ranges: "20,30,100-199" (ascending; adjacent IDs merged) — as written in the file. */
export function vlanRangesText(ids: number[]): string {
  return vlanRuns(ids)
    .map(([a, b]) => (b > a ? `${a}-${b}` : String(a)))
    .join(',');
}

/** IDs for the screen: "10,20,30–39" (compact) or "10, 20, 30–39" (spaced). */
export function vlanRangesShown(ids: number[], spaced = false): string {
  return vlanRuns(ids)
    .map(([a, b]) => (b > a ? `${a}–${b}` : String(a)))
    .join(spaced ? ', ' : ',');
}

function vlanRuns(ids: number[]): Array<[number, number]> {
  const xs = Array.from(new Set(ids)).sort((p, q) => p - q);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push([xs[i], xs[j]]);
    i = j + 1;
  }
  return out;
}

/**
 * A port at layer 2, derived from its `vlans`, `native` and `routed` (an
 * aggregate's member ports take them from the aggregate) and its device:
 *
 *   one VLAN                      access: untagged in that VLAN
 *   several VLANs                 trunk: 802.1Q-tagged, except the native
 *                                 VLAN (untagged) if one is written; without
 *                                 one, every VLAN is tagged
 *   `routed: true` (a Layer 3     routed: a Layer 3 interface
 *     switch), or no VLANs on a
 *     router or another Layer 3
 *     device
 *   no VLANs on a host            host: untagged, no VLAN of its own
 *   no VLANs on a switch          unset (validation reports it: a switch
 *                                 port says what it carries)
 *
 * A routed port's subinterfaces (`<port>.<n>` with a VLAN) are tagged on it
 * (router-on-a-stick): `tagged` lists their VLANs.
 */
export interface PortL2 {
  kind: PortKind;
  /** every VLAN it carries, ascending (a routed port: its subinterfaces' VLANs) */
  vlans: number[];
  /** a trunk's native VLAN, when written (and one of its VLANs) */
  native?: number;
  /** the untagged VLAN: an access port's VLAN, a trunk's native VLAN */
  untagged?: number;
  /** the 802.1Q-tagged VLANs */
  tagged: number[];
  /** the aggregate it takes its VLANs from (a member port) */
  lag?: string;
}

interface PortCache {
  l2: Map<string, PortL2>;
  /** "device:port" -> the aggregate that lists it as a member (the first one) */
  lagOf: Map<string, string>;
  /** "device:port" -> its subinterfaces */
  subs: Map<string, Interface[]>;
}

const portCache = new WeakMap<Model, PortCache>();

function ports(model: Model): PortCache {
  const known = portCache.get(model);
  if (known) return known;
  const lagOf = new Map<string, string>();
  const subs = new Map<string, Interface[]>();
  for (const d of model.devices) {
    for (const i of d.logical) {
      for (const m of i.members) if (!lagOf.has(ifaceKey(d.id, m))) lagOf.set(ifaceKey(d.id, m), i.id);
      const parent = subinterfaceParentIn(model, i);
      if (parent !== undefined) {
        const k = ifaceKey(d.id, parent);
        subs.set(k, (subs.get(k) || []).concat([i]));
      }
    }
  }
  const out: PortCache = { l2: new Map(), lagOf, subs };
  portCache.set(model, out);
  return out;
}

/**
 * The port a virtual interface is a subinterface of: its id is
 * "<port>.<n>" (Gi0/0.10, ge-0/0/2.10, eth0.10) and <port> is a physical
 * interface or an aggregate of the same device. Derived from the name, as
 * every vendor writes it; nothing else is written for it.
 */
function subinterfaceParentIn(model: Model, i: Interface): string | undefined {
  if (i.type !== 'virtual' || i.members.length) return undefined;
  const dot = i.id.lastIndexOf('.');
  if (dot <= 0 || dot === i.id.length - 1) return undefined;
  const p = model.index.interfaces.get(ifaceKey(i.device, i.id.slice(0, dot)));
  // a port, an aggregate, or a VM's virtual NIC (whose port group passes the guest's tags)
  return p && (p.type === 'physical' || p.type === 'vnic' || (p.type === 'virtual' && p.members.length > 0)) ? p.id : undefined;
}

/** The port a subinterface belongs to (see PortL2), or undefined. */
export function subinterfaceParent(model: Model, i: Interface): string | undefined {
  return subinterfaceParentIn(model, i);
}

/** The subinterfaces of a port, in model order. */
export function subinterfacesOf(model: Model, device: string, port: string): Interface[] {
  return ports(model).subs.get(ifaceKey(device, port)) || [];
}

/** The aggregate a physical port is a member of (the first that lists it), or undefined. */
export function lagOf(model: Model, device: string, port: string): string | undefined {
  return ports(model).lagOf.get(ifaceKey(device, port));
}

/** A port's (or an aggregate's) layer-2 role; undefined for an unknown interface or one that is no port (a loopback, a tunnel, a VLAN interface). */
export function portL2(model: Model, device: string, iface: string): PortL2 | undefined {
  const pc = ports(model);
  const key = ifaceKey(device, iface);
  const known = pc.l2.get(key);
  if (known) return known;
  const i = model.index.interfaces.get(key);
  const d = model.index.devices.get(device);
  if (!i || !d || !(i.type === 'physical' || (i.type === 'virtual' && i.members.length > 0))) return undefined;
  const lag = i.type === 'physical' ? pc.lagOf.get(key) : undefined;
  const cfg = lag !== undefined ? (model.index.interfaces.get(ifaceKey(device, lag)) as Interface) : i;
  const ids = vlanIds(cfg.vlans);
  let out: PortL2;
  if (ids.length === 1) out = { kind: 'access', vlans: ids, untagged: ids[0], tagged: [] };
  else if (ids.length > 1) {
    const native = cfg.native !== undefined && ids.indexOf(cfg.native) >= 0 ? cfg.native : undefined;
    out = { kind: 'trunk', vlans: ids, native, untagged: native, tagged: ids.filter((v) => v !== native) };
  } else {
    const kind: PortKind = cfg.routed ? 'routed' : capabilities(d).switchFeatures ? 'unset' : deviceRoutingRole(d) === 'router' ? 'routed' : 'host';
    // a routed port carries its subinterfaces' VLANs, tagged
    const sv: number[] = [];
    if (kind === 'routed') {
      // (its own subinterfaces, and a member port's: its aggregate's too)
      const subs = (pc.subs.get(ifaceKey(device, iface)) || []).concat(lag !== undefined ? pc.subs.get(ifaceKey(device, lag)) || [] : []);
      for (const s of subs) for (const v of interfaceVlans(model, s)) if (sv.indexOf(v) < 0) sv.push(v);
      sv.sort((p, q) => p - q);
    }
    out = { kind, vlans: sv, tagged: sv };
  }
  if (lag !== undefined) out.lag = lag;
  pc.l2.set(key, out);
  return out;
}

/** Is a port a Layer 2 switch port (access or trunk)? */
export function isBridgePort(l: PortL2 | undefined): boolean {
  return !!l && (l.kind === 'access' || l.kind === 'trunk');
}

/**
 * A port's role as its badge says it: "Access · VLAN 10", "Trunk · 10, 20,
 * 30–39 (native 10)", "Routed" (with its subinterfaces' tagged VLANs), and
 * for a switch port without VLANs "No VLANs"; '' for a host's port.
 */
export function portBadgeText(l: PortL2 | undefined): string {
  if (!l) return '';
  if (l.kind === 'access') return `Access · VLAN ${l.untagged}`;
  if (l.kind === 'trunk') return `Trunk · ${vlanRangesShown(l.vlans, true)}${l.native !== undefined ? ` (native ${l.native})` : ''}`;
  if (l.kind === 'routed') return l.tagged.length ? `Routed · tagged ${vlanRangesShown(l.tagged, true)}` : 'Routed';
  if (l.kind === 'unset') return 'No VLANs';
  return '';
}

/**
 * A port's layer 2 as the physical view writes it under the port's name:
 * "A 10" (access), "T 10,20,30–39 · N 10" (a trunk, with its native VLAN),
 * "R · T 10,20" for a routed port with subinterfaces; '' for a plain routed
 * port and a host's port (they carry no VLAN: the editor's badge says
 * "Routed").
 */
export function portTagText(l: PortL2 | undefined): string {
  if (!l) return '';
  if (l.kind === 'access') return `A ${l.untagged}`;
  if (l.kind === 'trunk') return `T ${vlanRangesShown(l.vlans)}${l.native !== undefined ? ` · N ${l.native}` : ''}`;
  if (l.kind === 'routed') return l.tagged.length ? `R · T ${vlanRangesShown(l.tagged)}` : '';
  if (l.kind === 'unset') return 'no VLANs';
  return '';
}

/** The port at a link end, at layer 2 (undefined: the end names no interface, or one that is no port). */
export function endL2(model: Model, e: LinkEnd): PortL2 | undefined {
  return e.iface !== undefined ? portL2(model, e.device, e.iface) : undefined;
}

/** The VLANs a cable carries at one end: those of the port there, ascending. */
export function endVlans(model: Model, e: LinkEnd): number[] {
  const l = endL2(model, e);
  return l ? l.vlans : [];
}

/** The tagging at a link end as the physical view writes it (see portTagText), after what the port is for (its domain, management, its pair). */
export function endTagText(model: Model, e: LinkEnd): string {
  return [endRoleText(model, e), portTagText(endL2(model, e))].filter((x) => !!x).join(' · ');
}

/**
 * What a port is for, in words, where its device gives it a part: a
 * Separation gateway's domain ("domain Red"), a management interface, an
 * inline or pass-through device's pair ("pair 1") or a TAP's copy port
 * ("copy of pair 1"). Text, not colour, carries it.
 */
export function endRoleText(model: Model, e: LinkEnd): string {
  const d = model.index.devices.get(e.device);
  if (!d || e.iface === undefined) return '';
  const port = e.iface;
  if (d.management.indexOf(port) >= 0) return 'management';
  if (d.separation) {
    const dom = d.separation.domains.find((x) => x.interfaces.indexOf(port) >= 0);
    if (dom) return 'domain ' + dom.name;
  }
  const k = d.portPairs.findIndex((p) => p.a === port || p.b === port);
  if (k >= 0) return d.portPairs.length > 1 ? `pair ${k + 1}` : 'pair';
  const c = d.portPairs.findIndex((p) => p.copy.indexOf(port) >= 0);
  if (c >= 0) return d.portPairs.length > 1 ? `copy of pair ${c + 1}` : 'copy';
  return '';
}

/** The networks of the VLANs a link end carries (derived: the networks whose `vlan` is one of them), in model order. */
export function endNetworks(model: Model, e: LinkEnd): string[] {
  const vlans = endVlans(model, e);
  if (!vlans.length) return [];
  return model.networks.filter((n) => n.vlan !== undefined && vlans.indexOf(n.vlan) >= 0).map((n) => n.id);
}

/** The networks a cable carries at either end, in model order. */
export function linkNetworks(model: Model, l: Link): string[] {
  const ids = new Set(endNetworks(model, l.a).concat(endNetworks(model, l.b)));
  return model.networks.filter((n) => ids.has(n.id)).map((n) => n.id);
}

/**
 * How the two ports of a cable disagree at layer 2 (null: they agree, or a
 * side says nothing about VLANs: a host's port, a plain routed port, an
 * unset switch port). A routed port with subinterfaces counts as a trunk of
 * their VLANs, compared on the tagged VLANs only (its own untagged traffic
 * is in the other end's native VLAN, whatever that is).
 */
export interface TagMismatch {
  /** both access ports, in different VLANs */
  access: [number, number] | null;
  /** both trunks, with different native VLANs (undefined: none) */
  native: [number | undefined, number | undefined] | null;
  /** both trunks: VLANs only one end carries */
  onlyA: number[];
  onlyB: number[];
  /** an access port to a trunk whose native VLAN is not the access VLAN */
  accessTrunk: { side: 'a' | 'b'; vlan: number; native?: number } | null;
}

function trunkLike(l: PortL2 | undefined): PortL2 | undefined {
  if (!l) return undefined;
  if (l.kind === 'trunk' || l.kind === 'access') return l;
  if (l.kind === 'routed' && l.tagged.length) return { kind: 'trunk', vlans: l.tagged, tagged: l.tagged };
  return undefined;
}

export function tagMismatch(model: Model, link: Link): TagMismatch | null {
  const a = trunkLike(endL2(model, link.a));
  const b = trunkLike(endL2(model, link.b));
  if (!a || !b) return null;
  const m: TagMismatch = { access: null, native: null, onlyA: [], onlyB: [], accessTrunk: null };
  if (a.kind === 'access' && b.kind === 'access') {
    if (a.untagged !== b.untagged) m.access = [a.untagged as number, b.untagged as number];
  } else if (a.kind === 'trunk' && b.kind === 'trunk') {
    // a routed port's own (untagged) traffic is in the other trunk's native VLAN, whatever it is: only the tagged VLANs are compared
    const routedA = (endL2(model, link.a) as PortL2).kind === 'routed';
    const routedB = (endL2(model, link.b) as PortL2).kind === 'routed';
    if (!routedA && !routedB && a.native !== b.native) m.native = [a.native, b.native];
    const va = routedB ? a.tagged : a.vlans;
    const vb = routedA ? b.tagged : b.vlans;
    m.onlyA = va.filter((v) => vb.indexOf(v) < 0);
    m.onlyB = vb.filter((v) => va.indexOf(v) < 0);
  } else {
    const acc = a.kind === 'access' ? a : b;
    const tr = a.kind === 'access' ? b : a;
    if (acc.untagged !== tr.native) m.accessTrunk = { side: a.kind === 'access' ? 'a' : 'b', vlan: acc.untagged as number, native: tr.native };
  }
  return m.access || m.native || m.onlyA.length || m.onlyB.length || m.accessTrunk ? m : null;
}

/** The differences of a TagMismatch in words, separated by "; ". */
export function tagMismatchText(m: TagMismatch): string {
  const out: string[] = [];
  if (m.access) out.push(`access VLAN ${m.access[0]} at end A, ${m.access[1]} at end B`);
  if (m.native) out.push(`native VLAN ${m.native[0] !== undefined ? m.native[0] : 'none'} at end A, ${m.native[1] !== undefined ? m.native[1] : 'none'} at end B`);
  if (m.onlyA.length) out.push(`only at end A: ${vlanRangesText(m.onlyA)}`);
  if (m.onlyB.length) out.push(`only at end B: ${vlanRangesText(m.onlyB)}`);
  if (m.accessTrunk) out.push(`access VLAN ${m.accessTrunk.vlan} at end ${m.accessTrunk.side.toUpperCase()}, the trunk's native VLAN ${m.accessTrunk.native !== undefined ? m.accessTrunk.native : 'none'}`);
  return out.join('; ');
}

/** Display name of a network id (its label; the id when it is unknown). */
export function networkName(model: Model, id: string): string {
  const n = model.index.networks.get(id);
  return n ? n.label : id;
}

// --------------------------------------------- associations of logical interfaces

/** The VLAN IDs of a virtual interface: the `vlan` written on it, or else those of the networks containing its addresses (an aggregate has none). */
export function interfaceVlans(model: Model, i: Interface): number[] {
  if (i.type !== 'virtual' || i.members.length) return [];
  if (i.vlan !== undefined) return [i.vlan];
  const out: number[] = [];
  for (const a of interfaceAddresses(model, i.device, i.id)) if (a.vlan.state === 'vlan' && out.indexOf(a.vlan.vlan) < 0) out.push(a.vlan.vlan);
  return out.sort((p, q) => p - q);
}

/**
 * Is a virtual interface the interface of a VLAN (an SVI, an IRB or BVI):
 * it has a VLAN, no member ports, and is no port's subinterface?
 */
export function isVlanInterface(model: Model, i: Interface): boolean {
  return i.type === 'virtual' && !i.members.length && interfaceVlans(model, i).length > 0 && subinterfaceParentIn(model, i) === undefined;
}

/** A port that carries a VLAN of a logical interface. */
export interface VlanPort {
  iface: string;
  /** its cable, when it has one */
  link?: string;
  vlan: number;
  /** the VLAN is 802.1Q-tagged on it */
  tagged: boolean;
  /** access, trunk, or routed (the parent of a subinterface) */
  kind: PortKind;
}

/**
 * The bridge ports of a device in a VLAN: every port (a physical port that
 * is no aggregate member, or an aggregate) that is an access port or a
 * trunk of that VLAN. In the device's order: physical ports, then
 * aggregates.
 */
export function bridgePorts(model: Model, device: string, vlan: number): VlanPort[] {
  const d = model.index.devices.get(device);
  if (!d) return [];
  const out: VlanPort[] = [];
  for (const i of d.interfaces.concat(d.logical.filter((x) => x.type === 'virtual' && x.members.length > 0))) {
    if (i.type === 'physical' && lagOf(model, device, i.id) !== undefined) continue;
    const l = portL2(model, device, i.id);
    if (!l || !isBridgePort(l) || l.vlans.indexOf(vlan) < 0) continue;
    const link = model.index.ifaceLink.get(ifaceKey(device, i.id));
    out.push({ iface: i.id, link, vlan, tagged: l.tagged.indexOf(vlan) >= 0, kind: l.kind });
  }
  return out;
}

/**
 * The ports a logical interface reaches its VLAN through (read-only;
 * nothing is configured for it): a VLAN interface's bridge ports, a
 * subinterface's port (tagged).
 */
export function interfaceVlanPorts(model: Model, i: Interface): VlanPort[] {
  const parent = subinterfaceParentIn(model, i);
  const vlans = interfaceVlans(model, i);
  if (parent !== undefined) return vlans.map((v) => ({ iface: parent, link: model.index.ifaceLink.get(ifaceKey(i.device, parent)), vlan: v, tagged: true, kind: 'routed' as PortKind }));
  if (!isVlanInterface(model, i)) return [];
  const out: VlanPort[] = [];
  for (const v of vlans) out.push(...bridgePorts(model, i.device, v));
  return out;
}

/** The VLAN interfaces of a device for a VLAN, in model order (more than one is an error). */
export function vlanInterfacesOf(model: Model, device: string, vlan: number): Interface[] {
  const d = model.index.devices.get(device);
  return d ? d.logical.filter((i) => isVlanInterface(model, i) && interfaceVlans(model, i).indexOf(vlan) >= 0) : [];
}

/**
 * Interfaces of the same device that an interface is associated with, in
 * either direction, as ids:
 *   a virtual interface  -> its member ports, its bridge ports (a VLAN
 *                           interface), its port (a subinterface);
 *   a tunnel             -> the interface it is sourced from;
 *   any interface        -> the aggregates it is a member of, the VLAN
 *                           interfaces it is a bridge port of, its
 *                           subinterfaces, the tunnels sourced from it.
 */
export function associatedInterfaces(model: Model, i: Interface): string[] {
  const d = model.index.devices.get(i.device);
  if (!d) return [];
  const out: string[] = [];
  const add = (id: string | undefined): void => {
    if (id !== undefined && id !== i.id && out.indexOf(id) < 0 && model.index.interfaces.has(ifaceKey(i.device, id))) out.push(id);
  };
  for (const m of i.members) add(m);
  for (const p of interfaceVlanPorts(model, i)) add(p.iface);
  if (i.source) add(i.source.iface);
  for (const o of d.logical) {
    if (o.id === i.id) continue;
    if (o.members.indexOf(i.id) >= 0) add(o.id);
    if (o.source && o.source.iface === i.id) add(o.id);
    if ((i.type === 'physical' || i.members.length > 0) && interfaceVlanPorts(model, o).some((p) => p.iface === i.id || p.iface === lagOf(model, i.device, i.id))) add(o.id);
  }
  return out;
}

/**
 * Port names with runs compressed: "Gi1/0/1–10, Gi1/0/48, Po1" (names that
 * differ only in a trailing number, consecutive, three or more). Sorted
 * as the editor sorts names.
 */
export function portRuns(ids: string[]): Array<{ first: string; last?: string; text: string }> {
  const sorted = Array.from(new Set(ids)).sort(compareNames);
  const out: Array<{ first: string; last?: string; text: string }> = [];
  const split = (id: string): { head: string; n: number } | null => {
    const m = /^(.*?)([0-9]+)$/.exec(id);
    return m && !/^0[0-9]/.test(m[2]) ? { head: m[1], n: Number(m[2]) } : null;
  };
  for (let i = 0; i < sorted.length; ) {
    const a = split(sorted[i]);
    let j = i;
    while (a && j + 1 < sorted.length) {
      const b = split(sorted[j + 1]);
      if (!b || b.head !== a.head || b.n !== a.n + (j + 1 - i)) break;
      j++;
    }
    if (a && j - i >= 2) {
      out.push({ first: sorted[i], last: sorted[j], text: `${sorted[i]}–${(split(sorted[j]) as { n: number }).n}` });
      i = j + 1;
    } else {
      out.push({ first: sorted[i], text: sorted[i] });
      i++;
    }
  }
  return out;
}

/** A logical interface's ports by mode (a VLAN interface's bridge ports, a subinterface's port as routed), each list sorted by name. */
export function vlanPortsByMode(model: Model, i: Interface): { access: string[]; trunk: string[]; routed: string[] } {
  const out = { access: [] as string[], trunk: [] as string[], routed: [] as string[] };
  for (const p of interfaceVlanPorts(model, i)) {
    const list = p.kind === 'access' ? out.access : p.kind === 'trunk' ? out.trunk : out.routed;
    if (list.indexOf(p.iface) < 0) list.push(p.iface);
  }
  out.access.sort(compareNames);
  out.trunk.sort(compareNames);
  out.routed.sort(compareNames);
  return out;
}

/** "Access: Gi1/0/1–10 · Trunk: Gi1/0/48, Po1" ('' without bridge ports). */
export function bridgePortsText(model: Model, i: Interface): string {
  const g = vlanPortsByMode(model, i);
  const part = (label: string, ids: string[]): string => (ids.length ? `${label}: ${portRuns(ids).map((r) => r.text).join(', ')}` : '');
  return [part('Access', g.access), part('Trunk', g.trunk), part('Tagged on', g.routed)].filter((x) => x).join(' · ');
}

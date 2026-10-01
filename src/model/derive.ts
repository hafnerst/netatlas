/**
 * Derived, read-only facts. Each is configured once in the YAML file and
 * computed here for every other view; none of it is ever written back:
 *
 *   configured (authoritative)            derived
 *   ------------------------------------  ------------------------------------
 *   network `cidr`, interface `ip`        members of a network (IP containment)
 *   network `vlan` (+ the two above)      VLAN of an interface address
 *   link end `networks`                   the networks a cable carries at each
 *                                         end, and whether the two ends differ
 *   the networks of a virtual interface   the physical ports carrying them
 *     (from its addresses, or the
 *     networks of its `vlan`)
 *     + link end `networks`
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
 * Membership (containment) and link-end assignment (carriage) are separate
 * facts: neither is derived from the other.
 */
import { IpPrefix, parsePrefix, prefixContains } from './ip';
import { Interface, Model, Network, deviceInterfaces, ifaceKey, isLoopback } from './types';

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

export interface Derived {
  /** network id -> member devices, in device order (each device once) */
  members: Map<string, NetworkMember[]>;
  /** "device:iface" -> one entry per assigned address, in address order */
  addresses: Map<string, AddressAssoc[]>;
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
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      const assocs: AddressAssoc[] = [];
      for (const address of i.addresses) {
        const a = parsePrefix(address, false);
        const inside = a ? nets.filter((x) => x.prefixes.some((p) => prefixContains(p, a))).map((x) => x.n) : [];
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
  const out = { members, addresses };
  cache.set(model, out);
  return out;
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

// ---------------------------------------------------- link-end networks

/** Networks assigned to one end of a link but not to the other (null: the ends agree). */
export interface NetworkMismatch {
  onlyA: string[];
  onlyB: string[];
}

export function networkMismatch(a: string[], b: string[]): NetworkMismatch | null {
  const onlyA = a.filter((v) => b.indexOf(v) < 0);
  const onlyB = b.filter((v) => a.indexOf(v) < 0);
  return onlyA.length || onlyB.length ? { onlyA, onlyB } : null;
}

/** Display name of a network id (its label; the id when it is unknown). */
export function networkName(model: Model, id: string): string {
  const n = model.index.networks.get(id);
  return n ? n.label : id;
}

export function networkMismatchText(m: NetworkMismatch, name: (id: string) => string): string {
  const side = (end: string, only: string[]): string => (only.length ? `only at end ${end}: ${only.map(name).join(', ')}` : '');
  return [side('A', m.onlyA), side('B', m.onlyB)].filter((x) => x).join('; ');
}

/** "No network" or the names of the networks one end carries. Several networks are just several networks: no tagging is implied. */
export function linkEndNetworksText(model: Model, ids: string[]): string {
  if (!ids.length) return 'No network';
  return ids.map((id) => networkName(model, id)).join(', ');
}

// --------------------------------------------- associations of logical interfaces

/**
 * The networks a virtual interface is in: the networks containing its
 * addresses, and (when `vlan` is written on it) the networks of that VLAN.
 * Empty for every other kind of interface. A virtual interface that has no
 * address and no VLAN (e.g. a plain bond or a VTEP) is in no network.
 */
export function interfaceCarriedNetworks(model: Model, i: Interface): string[] {
  if (i.type !== 'virtual') return [];
  const ids = new Set(interfaceNetworks(model, i.device, i.id));
  if (i.vlan !== undefined) for (const n of model.networks) if (n.vlan === i.vlan) ids.add(n.id);
  return model.networks.filter((n) => ids.has(n.id)).map((n) => n.id);
}

/** The VLAN IDs of a virtual interface: the `vlan` written on it, or else those of the networks containing its addresses. */
export function interfaceVlans(model: Model, i: Interface): number[] {
  if (i.type !== 'virtual') return [];
  if (i.vlan !== undefined) return [i.vlan];
  const out: number[] = [];
  for (const a of interfaceAddresses(model, i.device, i.id)) if (a.vlan.state === 'vlan' && out.indexOf(a.vlan.vlan) < 0) out.push(a.vlan.vlan);
  return out.sort((p, q) => p - q);
}

/** A physical port whose link end carries a network. */
export interface NetworkPort {
  iface: string;
  link: string;
  network: string;
}

/**
 * The physical ports of a device that carry one of `networks`: the ports
 * whose end of a link lists the network. Derived from the links; in link order.
 */
export function portsCarryingNetworks(model: Model, device: string, networks: string[]): NetworkPort[] {
  const out: NetworkPort[] = [];
  if (!networks.length) return out;
  for (const l of model.links) {
    for (const e of [l.a, l.b]) {
      if (e.device !== device || !e.iface) continue;
      for (const n of networks) if (e.networks.indexOf(n) >= 0) out.push({ iface: e.iface, link: l.id, network: n });
    }
  }
  return out;
}

/** The ports carrying the networks of a virtual interface (read-only; nothing is configured for it). */
export function interfaceNetworkPorts(model: Model, i: Interface): NetworkPort[] {
  return portsCarryingNetworks(model, i.device, interfaceCarriedNetworks(model, i));
}

/**
 * Interfaces of the same device that an interface is associated with, in
 * either direction, as ids:
 *   a virtual interface  -> its member ports and the ports carrying its networks;
 *   a tunnel             -> the interface it is sourced from;
 *   any interface        -> the aggregates it is a member of, the virtual
 *                           interfaces whose networks it carries, the tunnels
 *                           sourced from it.
 */
export function associatedInterfaces(model: Model, i: Interface): string[] {
  const d = model.index.devices.get(i.device);
  if (!d) return [];
  const out: string[] = [];
  const add = (id: string | undefined): void => {
    if (id !== undefined && id !== i.id && out.indexOf(id) < 0 && model.index.interfaces.has(ifaceKey(i.device, id))) out.push(id);
  };
  for (const m of i.members) add(m);
  for (const p of interfaceNetworkPorts(model, i)) add(p.iface);
  if (i.source) add(i.source.iface);
  for (const o of d.logical) {
    if (o.id === i.id) continue;
    if (o.members.indexOf(i.id) >= 0) add(o.id);
    if (o.source && o.source.iface === i.id) add(o.id);
    if (i.type === 'physical' && interfaceNetworkPorts(model, o).some((p) => p.iface === i.id)) add(o.id);
  }
  return out;
}

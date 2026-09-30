/**
 * Derived, read-only facts. Each is configured once in the YAML file and
 * computed here for every other view; none of it is ever written back:
 *
 *   configured (authoritative)            derived
 *   ------------------------------------  ------------------------------------
 *   network `cidr`, interface `ip`        members of a network
 *   network `vlan` (+ the two above)      VLAN of an interface address
 *   link end `vlans`                      "Trunk" / single / no VLAN, mismatch
 *
 * Membership rule: an address belongs to a network when one of the network's
 * prefixes contains it. The network's prefix is the authority; the prefix
 * length written on the interface is ignored. IPv4 and IPv6 never match each
 * other. An address that is not a valid IPv4/IPv6 address (with an optional,
 * valid prefix length) belongs to no network.
 */
import { IpPrefix, parsePrefix, prefixContains } from './ip';
import { Model, Network, ifaceKey, isLoopback } from './types';

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

/** The valid prefixes of a network (invalid entries define nothing). */
export function networkPrefixes(n: Network): IpPrefix[] {
  return n.cidr.map((c) => parsePrefix(c)).filter((p): p is IpPrefix => !!p);
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
    for (const i of d.interfaces) {
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

// ------------------------------------------------------------ link-end VLANs

/** How one end of a link is labelled: no VLAN, a single VLAN, or a trunk. */
export function linkEndVlanText(vlans: number[]): string {
  if (!vlans.length) return 'No VLAN';
  if (vlans.length === 1) return 'VLAN ' + vlans[0];
  return 'Trunk · VLANs ' + vlans.join(', ');
}

export interface VlanMismatch {
  onlyA: number[];
  onlyB: number[];
}

/** VLANs permitted at one end of a link but not at the other (null: the ends agree). */
export function vlanMismatch(a: number[], b: number[]): VlanMismatch | null {
  const onlyA = a.filter((v) => b.indexOf(v) < 0);
  const onlyB = b.filter((v) => a.indexOf(v) < 0);
  return onlyA.length || onlyB.length ? { onlyA, onlyB } : null;
}

export function vlanMismatchText(m: VlanMismatch): string {
  const side = (name: string, only: number[]): string => (only.length ? `only on end ${name}: ${only.join(', ')}` : '');
  return [side('A', m.onlyA), side('B', m.onlyB)].filter((s) => s).join('; ');
}

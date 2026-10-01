/** Validated, typed network model produced from the YAML input. */

/**
 * How a logical relation is drawn. Protocols are open-ended; categories are the
 * small, fixed set of visual semantics a protocol maps onto.
 */
export type Category = 'tunnel' | 'adjacency' | 'overlay' | 'redundancy' | 'service' | 'other';
export const CATEGORIES: readonly Category[] = ['tunnel', 'adjacency', 'overlay', 'redundancy', 'service', 'other'];

export type LineStyle = 'tube' | 'solid' | 'dashed' | 'dotted' | 'dashdot';
export const LINE_STYLES: readonly LineStyle[] = ['tube', 'solid', 'dashed', 'dotted', 'dashdot'];

/** Free-form, display-only key/value pairs (flattened, e.g. "tunnel.key"). */
export type Attrs = Array<[string, string]>;

export interface Endpoint {
  device: string;
  /** Interface id within the device, if the endpoint is interface-specific. */
  iface?: string;
}

/** A relation endpoint: a device, or one interface of it. Nothing else is stored on an endpoint. */
export type RelEndpoint = Endpoint;

export interface Group {
  id: string;
  label: string;
  kind: string;
  parent?: string;
  description?: string;
  attrs: Attrs;
  line: number;
}

/** Valid VLAN IDs (IEEE 802.1Q). */
export const VLAN_MIN = 1;
export const VLAN_MAX = 4094;

/**
 * What an interface is. A device stores its interfaces once, in two lists:
 *   physical  an entry of `interfaces`: a port, the only kind that can be cabled (no type to choose);
 *   loopback  \
 *   virtual    } an entry of `logical_interfaces`, with the type written there.
 *   tunnel    /
 * A logical interface has no generic parent. What it is associated with
 * depends on what it is: an aggregate lists its member ports, a VLAN
 * interface names its VLAN (the ports carrying it are derived from the
 * links), a tunnel names its source and destination.
 */
export type InterfaceKind = 'physical' | 'loopback' | 'virtual' | 'tunnel';

/** The types a logical interface can have (the only interface type written in a file). */
export const LOGICAL_IFACE_TYPES: readonly InterfaceKind[] = ['loopback', 'virtual', 'tunnel'];

/** Source or destination of a tunnel interface: an address, or a reference to a device / interface of the model. */
export interface TunnelEnd {
  /** as written */
  text: string;
  /** set when it is an IP address */
  address?: string;
  /** set when it names a device (for a source: always the interface's own device) */
  device?: string;
  /** set when it names an interface of `device` */
  iface?: string;
}

export interface Interface {
  id: string;
  device: string;
  label?: string;
  type: InterfaceKind;
  /**
   * The interface obtains its address by DHCP (`dhcp: true`; omitted = false).
   * It is a configuration flag, not an address: nothing about the address it
   * may obtain is known, so it is in no network until an address is written.
   */
  dhcp: boolean;
  /** manually configured addresses; always empty when `dhcp` is true in a valid model */
  addresses: string[];
  /** name of the VRF this interface is assigned to (display only) */
  vrf?: string;
  mac?: string;
  /** virtual: ids of the physical interfaces of the same device that are its members (a bond / aggregate); in file order */
  members: string[];
  /** virtual: the VLAN it is the interface of, when written on the interface (see derive.interfaceVlans) */
  vlan?: number;
  /** tunnel: the local interface or address the tunnel is sourced from */
  source?: TunnelEnd;
  /** tunnel: the remote address, device or interface */
  destination?: TunnelEnd;
  description?: string;
  attrs: Attrs;
  line: number;
}

export interface Device {
  id: string;
  label: string;
  type: string;
  group?: string;
  tier?: number;
  description?: string;
  attrs: Attrs;
  /** physical interfaces (ports), in file order */
  interfaces: Interface[];
  /** loopback, virtual and tunnel interfaces, in file order */
  logical: Interface[];
  /** DNS names configured for the device, in file order */
  dnsNames: DnsName[];
  line: number;
}

/**
 * A DNS name of a device, associated with one or more of its interfaces
 * (physical or logical), each named by its interface id. The association is
 * to the interface as a whole, not to one of its addresses, and it states
 * only what is configured: no A/AAAA record is derived from it.
 */
export interface DnsName {
  /** as written (trailing dot included, if any) */
  name: string;
  /** ids of interfaces of the same device, in file order */
  interfaces: string[];
  line: number;
}

/** One end of a physical link, with the VLAN IDs that end permits on the cable. */
/**
 * One end of a physical link, with the networks the cable carries at that
 * end (physical / layer-2 carriage). Configured per end: the two ends may
 * differ, and nothing is copied from one to the other. An assignment is not
 * membership (that follows from addresses) and says nothing about tagging.
 */
export interface LinkEnd extends Endpoint {
  /** ids of networks, in file order; empty = none assigned */
  networks: string[];
}

export interface Link {
  id: string;
  a: LinkEnd;
  b: LinkEnd;
  /** medium and speed of the physical connection: configured here and nowhere else */
  medium: string;
  speed?: string;
  label?: string;
  cable?: string;
  description?: string;
  attrs: Attrs;
  line: number;
}

/**
 * An IP network. Its prefixes decide which devices are members (see
 * model/derive.ts); there is no configured member list.
 */
export interface Network {
  id: string;
  label: string;
  /** the network's one IPv4 or IPv6 prefix, as written (undefined while missing or invalid in a draft) */
  cidr?: string;
  /** the VLAN this IP network lives in, if any */
  vlan?: number;
  description?: string;
  attrs: Attrs;
  line: number;
}

export interface Relation {
  id: string;
  protocol: string;
  category: Category;
  label?: string;
  endpoints: RelEndpoint[];
  /** ids of links, relations or networks this relation is carried over (its underlay). */
  over: string[];
  directed: boolean;
  description?: string;
  attrs: Attrs;
  line: number;
}

export interface ProtocolDef {
  id: string;
  label: string;
  category: Category;
  color: string;
  style: LineStyle;
  description?: string;
  /** true if defined or overridden by the input file */
  custom: boolean;
}

/** Node centers per view, keyed by entity id (see layout-auto.ts). */
export interface ModelLayout {
  physical: Map<string, { x: number; y: number }>;
  logical: Map<string, { x: number; y: number }>;
  /** ids of nodes the user positioned by hand, per view (for the layout status only) */
  manual: { physical: Set<string>; logical: Set<string> };
}

export interface Model {
  version: number;
  title: string;
  description?: string;
  groups: Group[];
  devices: Device[];
  links: Link[];
  networks: Network[];
  relations: Relation[];
  /** Protocol registry (built-ins merged with input definitions). */
  protocols: Map<string, ProtocolDef>;
  /** stored diagram positions (presentation only; never affects the network semantics) */
  layout: ModelLayout;
  index: ModelIndex;
}

export type EntityKind = 'group' | 'device' | 'interface' | 'link' | 'network' | 'relation';

export interface ModelIndex {
  groups: Map<string, Group>;
  devices: Map<string, Device>;
  /** key: "device:iface" */
  interfaces: Map<string, Interface>;
  links: Map<string, Link>;
  networks: Map<string, Network>;
  relations: Map<string, Relation>;
  /** "device:iface" -> link id */
  ifaceLink: Map<string, string>;
}

export function ifaceKey(device: string, iface: string): string {
  return device + ':' + iface;
}

export function endpointText(e: Endpoint): string {
  return e.iface ? e.device + ':' + e.iface : e.device;
}

/** Distinct devices touched by a relation, in endpoint order. */
export function relationDevices(r: Relation): string[] {
  const out: string[] = [];
  for (const e of r.endpoints) if (out.indexOf(e.device) < 0) out.push(e.device);
  return out;
}

export function isLoopback(i: Interface): boolean {
  return i.type === 'loopback';
}

/** Every interface of a device in file order: the physical ones, then the logical ones. */
export function deviceInterfaces(d: Device): Interface[] {
  return d.interfaces.concat(d.logical);
}

/** Loopbacks of a device, in file order. */
export function loopbacks(d: Device): Interface[] {
  return d.logical.filter(isLoopback);
}

/** Display name of an interface kind. */
export function interfaceKindLabel(k: InterfaceKind): string {
  return k === 'physical' ? 'Physical' : k === 'virtual' ? 'Virtual' : k === 'tunnel' ? 'Tunnel' : 'Loopback';
}

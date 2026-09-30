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

export interface RelEndpoint extends Endpoint {
  role?: string;
  address?: string;
  attrs: Attrs;
}

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
 * What an interface is. The kind follows from where it is declared:
 *   physical  an entry of the device's `interfaces` list: a port, the only kind that can be cabled;
 *   logical   a child of a physical interface (`children`), e.g. a subinterface or an SVI;
 *   tunnel    a child of a physical interface that is a tunnel endpoint;
 *   loopback  an entry of the device's `loopbacks` list: a device-level logical endpoint.
 */
export type InterfaceKind = 'physical' | 'logical' | 'tunnel' | 'loopback';

/** The types a child interface can have (the only interface type written in a file). */
export const CHILD_IFACE_TYPES: readonly InterfaceKind[] = ['logical', 'tunnel'];

export interface Interface {
  id: string;
  device: string;
  label?: string;
  type: InterfaceKind;
  /** id of the physical interface a logical or tunnel interface belongs to */
  parent?: string;
  /** logical and tunnel interfaces of a physical interface, in file order (empty for every other kind) */
  children: Interface[];
  addresses: string[];
  /** name of the VRF this interface is assigned to (display only) */
  vrf?: string;
  mac?: string;
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
  /** physical interfaces only, in file order; each holds its children */
  interfaces: Interface[];
  /** device-level logical endpoints, in file order */
  loopbacks: Interface[];
  line: number;
}

/** One end of a physical link, with the VLAN IDs that end permits on the cable. */
export interface LinkEnd extends Endpoint {
  /** as configured for this end, ascending; empty = no VLAN configured */
  vlans: number[];
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
  /** prefixes as written */
  cidr: string[];
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
  network?: string;
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

/** Every interface of a device in file order: each physical interface followed by its children, then the loopbacks. */
export function deviceInterfaces(d: Device): Interface[] {
  const out: Interface[] = [];
  for (const i of d.interfaces) {
    out.push(i);
    for (const c of i.children) out.push(c);
  }
  return out.concat(d.loopbacks);
}

/** Display name of an interface kind. */
export function interfaceKindLabel(k: InterfaceKind): string {
  return k === 'physical' ? 'Physical' : k === 'logical' ? 'Logical' : k === 'tunnel' ? 'Tunnel' : 'Loopback';
}

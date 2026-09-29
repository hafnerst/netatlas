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

/** Interface types that are not physical ports and therefore cannot terminate a cable. */
export const LOGICAL_IFACE_TYPES = ['loopback', 'tunnel', 'vlan', 'svi', 'subinterface', 'virtual', 'lag', 'bundle', 'irb', 'bvi', 'vti'];

export interface Interface {
  id: string;
  device: string;
  label?: string;
  type: string;
  speed?: string;
  media?: string;
  addresses: string[];
  vlan?: string;
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
  vendor?: string;
  model?: string;
  role?: string;
  mgmt?: string;
  /** id of the loopback interface whose (IPv4) address is the router ID */
  routerId?: string;
  tier?: number;
  description?: string;
  attrs: Attrs;
  interfaces: Interface[];
  line: number;
}

export interface Link {
  id: string;
  a: Endpoint;
  b: Endpoint;
  medium: string;
  speed?: string;
  label?: string;
  cable?: string;
  description?: string;
  attrs: Attrs;
  line: number;
}

export interface Network {
  id: string;
  label: string;
  kind: string;
  cidr: string[];
  vlan?: string;
  vrf?: string;
  members: RelEndpoint[];
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

/** Loopback interfaces of a device, in declaration order. */
export function loopbacks(d: Device): Interface[] {
  return d.interfaces.filter(isLoopback);
}

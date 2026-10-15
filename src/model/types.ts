/** Validated, typed network model produced from the YAML input. */
import type { ServiceRegistry } from './services';

/**
 * How a logical relation is drawn. Protocols are open-ended; categories are the
 * small, fixed set of visual semantics a protocol maps onto.
 */
export type Category = 'tunnel' | 'adjacency' | 'overlay' | 'redundancy' | 'service' | 'other';
export const CATEGORIES: readonly Category[] = ['tunnel', 'adjacency', 'overlay', 'redundancy', 'service', 'other'];

export type LineStyle = 'tube' | 'solid' | 'dashed' | 'dotted' | 'dashdot';
export const LINE_STYLES: readonly LineStyle[] = ['tube', 'solid', 'dashed', 'dotted', 'dashdot'];

/**
 * Whether a relation flows both ways or one way. Unidirectional: from the
 * first endpoint to the last (drawn with an arrow), so the endpoint order
 * carries meaning. Bidirectional is the default when nothing is written.
 */
export type Direction = 'bidirectional' | 'unidirectional';
export const DIRECTIONS: readonly Direction[] = ['bidirectional', 'unidirectional'];

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
  /** configured MTU in bytes (68–65535), when written */
  mtu?: number;
  /** the interface's settings of services its device enables (a VRRP group …), by service id */
  services: ServiceConfig[];
  /** the multicast groups the device joins on this interface and the streams it sends from it (the protocol simulation) */
  multicast?: MulticastConfig;
  /** the interface's simulation attributes (its `simulation:` block), by registry key: only what it overrides */
  simulation?: Map<string, number | string>;
  /**
   * A DHCP relay (helper address) on a routed interface: the DHCP servers
   * (their addresses) it forwards its subnet's DHCP broadcasts to, as unicast
   * with its own address as the gateway address (giaddr). `dhcp_relay:`.
   */
  dhcpRelay?: string[];
  /** virtual: ids of the physical interfaces of the same device that are its members (a bond / aggregate); in file order */
  members: string[];
  /** virtual with members: how many member links must be up for the aggregate to be up, when written */
  minLinks?: number;
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

/** A group an interface joins: any source (ASM), or only the sources listed (SSM; IGMPv3 / MLDv2). */
export interface McJoin {
  group: string;
  /** the sources it accepts (none: any) */
  sources: string[];
  line: number;
}

/** A multicast stream an interface sends: UDP to a group and port, a datagram of `size` bytes every `interval` ms. */
export interface McStream {
  group: string;
  port: number;
  interval: number;
  size: number;
  line: number;
}

export interface MulticastConfig {
  joins: McJoin[];
  streams: McStream[];
}

export interface Device {
  id: string;
  label: string;
  type: string;
  /**
   * A switch that routes (`layer3: true`): a Layer 3 switch with the full
   * Layer 3+ feature set. Without it a switch is a Layer 2 switch: it
   * forwards frames, has one management interface and static routes, and
   * routes nothing (see model/device-types.ts deviceRoutingRole). Only
   * switches have it.
   */
  layer3?: boolean;
  group?: string;
  tier?: number;
  /**
   * The device's simulation attributes (its `simulation:` block), by the
   * registry key of analysis/sim/params.ts (durations in ms): only what it
   * overrides; everything else it inherits from the simulation's values or
   * the defaults.
   */
  simulation?: Map<string, number | string>;
  /** the router ID the device's protocols share (a loopback or an IPv4 address), when written */
  routerId?: RouterIdValue;
  /** the routing services the device enables (its `protocols:`), sorted by id; empty unless the type is Layer 3+ */
  services: ServiceConfig[];
  description?: string;
  attrs: Attrs;
  /** physical interfaces (ports), in file order */
  interfaces: Interface[];
  /** loopback, virtual and tunnel interfaces, in file order */
  logical: Interface[];
  /** DNS names configured for the device, in file order */
  dnsNames: DnsName[];
  /** the DNS servers a host is configured with (`dns_servers:`, static); a DHCP client also gets them from its lease */
  dnsServers?: string[];
  /** a server's network services (`services:`): a DHCP server and / or a DNS server */
  netServices?: NetServices;
  /** static routes, in file order (empty unless the device type may route; see analysis/routing.ts) */
  routes: Route[];
  line: number;
}

/** A router ID as written: an IPv4 address, or the id of a loopback of the device (whose IPv4 address it is). */
export interface RouterIdValue {
  text: string;
  /** the IPv4 address it stands for (none while it can't be resolved) */
  address?: string;
  /** set when it names a loopback */
  iface?: string;
}

/**
 * A service enabled on a device (or its settings on one interface): the
 * parameter values as written, by key, and an own router ID that overrides
 * the device's. Which keys exist is the registry's (model/services.ts).
 */
export interface ServiceConfig {
  id: string;
  values: Map<string, string>;
  routerId?: RouterIdValue;
  line: number;
}

/**
 * A static route of a device: a destination prefix and where traffic to it
 * goes. The next hop is an address (`via`), an exit interface, both, or a
 * black hole. Several routes may share a prefix (equal-cost, or floating
 * backups with a higher distance). Identified by its position in the
 * device's list ("route:<device>:<index>").
 */
export interface Route {
  device: string;
  /** position in the device's `routes` list (file order) */
  index: number;
  /** the destination prefix as written (always a valid prefix in a model) */
  prefix: string;
  /** next-hop address as written (no prefix length) */
  via?: string;
  /** exit interface: an interface id of the same device */
  iface?: string;
  /** traffic to the prefix is dropped (a null route); never together with via or an interface */
  blackhole: boolean;
  /** administrative distance as written (1–255); route selection takes a missing one as 1 */
  distance?: number;
  metric?: number;
  /** VRF of the route; none: the default (global) table */
  vrf?: string;
  name?: string;
  description?: string;
  attrs: Attrs;
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

/**
 * A DHCP scope of a server: the network it leases addresses in, the range it
 * leases from, the default gateway and DNS servers it gives, the lease time;
 * optionally excluded addresses, reservations and a domain name. Missing
 * mandatory values are validation errors (nothing is chosen for the user).
 */
export interface DhcpScope {
  /** a network id of the model (IPv4) */
  network?: string;
  /** the range as written ("10.1.1.100-10.1.1.199"), and its two ends */
  range?: string;
  start?: string;
  end?: string;
  gateway?: string;
  dns: string[];
  /** the lease time (ms) when written; else 1 day */
  lease?: number;
  exclude: string[];
  reservations: Array<{ mac: string; ip: string; line: number }>;
  domain?: string;
  /** the scope's simulation attributes (offer delay, ping check) */
  simulation?: Map<string, number | string>;
  line: number;
}

/** A DNS record written in a zone: A, AAAA or CNAME (a relative name or a name in the zone). */
export interface DnsRecord {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME';
  value: string;
  line: number;
}

/** A DNS zone of a server: its name, its own records (the model's DNS names in it add A / AAAA records), its record TTL. */
export interface DnsZone {
  name: string;
  records: DnsRecord[];
  simulation?: Map<string, number | string>;
  line: number;
}

/** A server's network services: a DHCP server (scopes) and / or a DNS server (zones). */
export interface NetServices {
  dhcp?: { scopes: DhcpScope[]; line: number };
  dns?: {
    zones: DnsZone[];
    /** reverse zones (PTR records): IPv4 or IPv6 prefixes */
    reverse: string[];
    forwarders: string[];
    /** the address it listens on (one of its own; none: all) */
    listen?: string;
    line: number;
  };
}

/** Layer-2 port mode of a link end: an access port (one untagged VLAN) or a trunk (tagged VLANs, plus a native one). */
export type PortMode = 'access' | 'trunk';
export const PORT_MODES: readonly PortMode[] = ['access', 'trunk'];

/** A run of VLAN IDs, `from` to `to` inclusive (one ID: from === to). */
export interface VlanRange {
  from: number;
  to: number;
}

/**
 * One end of a physical link, with the layer-2 tagging of the port there:
 * its mode, the untagged VLAN (the access VLAN, or a trunk's native VLAN)
 * and the tagged VLANs. Configured per end: the two ends may differ, and
 * nothing is copied from one to the other. The networks the cable carries
 * there are derived from it (the networks whose `vlan` is carried; see
 * model/derive.ts). An end without a mode says nothing about layer 2.
 */
export type Duplex = 'full' | 'half' | 'auto';
export const DUPLEXES: readonly Duplex[] = ['full', 'half', 'auto'];

export interface LinkEnd extends Endpoint {
  /** the port's configured speed as written ("1G", "100M"); the connection's own speed is Link.speed */
  speed?: string;
  /** the port's configured duplex */
  duplex?: Duplex;
  mode?: PortMode;
  untagged?: number;
  /** tagged VLANs as written (file order), each an ID or a range */
  tagged: VlanRange[];
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
  /**
   * Unidirectional: traffic only from end a to end b (simplex fibre, a data
   * diode, a TAP or SPAN feed); the path tracer never sends traffic the
   * other way. Bidirectional (the default) is not written.
   */
  direction: Direction;
  /** the cable's simulation settings (its `simulation:` block), when written */
  simulation?: LinkSimulation;
  description?: string;
  attrs: Attrs;
  line: number;
}

/** A cable's settings for the protocol simulation: explicit, they win over the simulation's values. */
export interface LinkSimulation {
  /** propagation delay in ms */
  latency?: number;
  /** share of frames lost, in percent */
  loss?: number;
  /** it flaps from the start (with the simulation's flapping times) */
  flapping?: boolean;
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
  /** the VLAN's simulation attributes (its `simulation:` block; only with a VLAN), by registry key */
  simulation?: Map<string, number | string>;
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
  direction: Direction;
  /** the relation's simulation attributes (its `simulation:` block: a session's, a tunnel's, a service's), by registry key */
  simulation?: Map<string, number | string>;
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

/**
 * A traffic demand (the `demands:` section): traffic of a given bandwidth
 * from a source to a destination, each a device, an interface
 * ("device:interface") or an IP address, as the path tracer takes them.
 * Analysis data: it is traced, never changes the network objects.
 */
export interface Demand {
  id: string;
  label: string;
  source: string;
  destination: string;
  /** as written ("200M", "1G") */
  bandwidth: string;
  /** bits per second */
  bps: number;
  /** a traffic class, free text ("voice", "backup") */
  class?: string;
  description?: string;
  line: number;
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
  /** The routing services devices can enable (built-ins and the protocols that declare params). */
  services: ServiceRegistry;
  /** stored diagram positions (presentation only; never affects the network semantics) */
  layout: ModelLayout;
  /** the `checks:` section: a check switched off or given another severity, by check id */
  checks: Map<string, 'off' | 'error' | 'warning' | 'info'>;
  /** traffic demands (analysis data: traced, never change the network objects) */
  demands: Demand[];
  index: ModelIndex;
}

export type EntityKind = 'group' | 'device' | 'interface' | 'route' | 'link' | 'network' | 'relation';

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
  /** "device:index" -> static route */
  routes: Map<string, Route>;
}

export function ifaceKey(device: string, iface: string): string {
  return device + ':' + iface;
}

/** Key of a route in ModelIndex.routes and in its ref ("route:" + key). */
export function routeKey(device: string, index: number): string {
  return device + ':' + index;
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

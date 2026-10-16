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
/**
 * What an interface is. `physical`: a port (the `interfaces:` list). The
 * logical ones (`logical_interfaces:`, with their `type`): `loopback`,
 * `virtual`, `tunnel`; a guest's network interfaces `vnic` (a VM's virtual
 * NIC on a port group of its host, or bound to a host port by passthrough;
 * also a hypervisor's own host interfaces) and `veth` (a container's
 * attachment to a container network of its host). `bridge` is never
 * written: it is a container bridge network's interface on its host
 * (docker0), derived from the network (Interface.derived).
 */
export type InterfaceKind = 'physical' | 'loopback' | 'virtual' | 'tunnel' | 'vnic' | 'veth' | 'bridge';

/** The types a logical interface can have (the only interface type written in a file). */
export const LOGICAL_IFACE_TYPES: readonly InterfaceKind[] = ['loopback', 'virtual', 'tunnel', 'vnic', 'veth'];

/** A port a container publishes on its host (a bridge network's DNAT): host address (none: all), host port → container port. */
export interface PublishedPort {
  hostIp?: string;
  hostPort: number;
  port: number;
  protocol: 'tcp' | 'udp';
  line: number;
}

/** What a hypervisor's own vnic (a host interface) is for. */
export type HostIfaceRole = 'management' | 'migration' | 'storage';
export const HOST_IFACE_ROLES: readonly HostIfaceRole[] = ['management', 'migration', 'storage'];

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
  /**
   * A port's (or an aggregate's) VLANs as written, each an ID or a range: one
   * VLAN makes it an access port, several a trunk. Empty: none written.
   */
  vlans: VlanRange[];
  /** a trunk's native (untagged) VLAN, one of its `vlans` */
  native?: number;
  /** a Layer 3 switch's port (or aggregate) set to routed: no VLANs, it may have addresses */
  routed?: boolean;
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
  /** vnic: the port group (by name) on a virtual switch of its host (a VM's host, or the hypervisor itself) */
  portGroup?: string;
  /** vnic: the host's physical port it is bound to directly (passthrough / SR-IOV), instead of a port group */
  passthrough?: string;
  /** vnic with passthrough: the port's SR-IOV virtual function (none: the whole port) */
  vf?: number;
  /** vnic of a hypervisor (a host interface): what the host uses it for */
  role?: HostIfaceRole;
  /** veth: the container network (by name) of its host it is attached to */
  network?: string;
  /** veth: further names of the container on that network */
  aliases?: string[];
  /** veth: the ports published on the host (a bridge network only) */
  publish?: PublishedPort[];
  /** bridge: derived from a container bridge network, never written (its network's name) */
  derived?: string;
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
  /** a server's Hypervisor service (`services.hypervisor`): its virtual switches and port groups; it runs VMs */
  hypervisor?: HypervisorService;
  /** a server's (or a VM's) Container engine service (`services.container_engine`): its container networks; it runs containers */
  containerEngine?: ContainerEngine;
  /**
   * A guest's host (a VM or a container; required for them, nothing else
   * has one): a server with the Hypervisor service for a VM, a server or a
   * VM with the Container engine service for a container. A guest has no
   * ports and no cables, and its location is its host's (model/virtual.ts).
   */
  host?: string;
  /** a VM: its guest operating system, virtual CPUs and memory (as written, "16G"), all informational */
  guestOs?: string;
  vcpu?: number;
  ram?: string;
  /** a container: its image (informational) */
  image?: string;
  /** static routes, in file order (empty unless the device type may route; see analysis/routing.ts) */
  routes: Route[];
  line: number;
}

/** The hypervisor platforms. */
export const HV_PLATFORMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'kvm', label: 'KVM' },
  { id: 'esxi', label: 'VMware ESXi' },
  { id: 'hyperv', label: 'Hyper-V' },
  { id: 'proxmox', label: 'Proxmox VE' },
  { id: 'xen', label: 'Xen' },
  { id: 'other', label: 'Other' },
];
export const VSWITCH_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'standard', label: 'Standard vSwitch' },
  { id: 'distributed', label: 'Distributed switch' },
  { id: 'linux_bridge', label: 'Linux bridge' },
  { id: 'ovs', label: 'Open vSwitch' },
];
export const TEAMINGS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'active_standby', label: 'Active / standby (in uplink order)' },
  { id: 'load_based', label: 'Load-based' },
  { id: 'source_based', label: 'Source-based (by virtual port)' },
  { id: 'lacp', label: 'LACP (an aggregate)' },
];
export const CONTAINER_ENGINES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'docker', label: 'Docker' },
  { id: 'podman', label: 'Podman' },
  { id: 'containerd', label: 'containerd / Kubernetes node' },
  { id: 'lxc', label: 'LXC / Incus' },
  { id: 'other', label: 'Other' },
];
export const CONTAINER_DRIVERS: ReadonlyArray<{ id: ContainerDriver; label: string }> = [
  { id: 'bridge', label: 'Bridge (NAT on the host)' },
  { id: 'host', label: 'Host (the host’s interfaces)' },
  { id: 'macvlan', label: 'macvlan (own MAC on the LAN)' },
  { id: 'ipvlan', label: 'ipvlan (the parent’s MAC)' },
  { id: 'overlay', label: 'Overlay (across hosts)' },
  { id: 'none', label: 'None (no network)' },
];
/** a macvlan network's mode, and an ipvlan network's */
export const MACVLAN_MODES: readonly string[] = ['bridge', 'private', 'vepa', 'passthru'];
export const IPVLAN_MODES: readonly string[] = ['l2', 'l3'];

/**
 * A port group of a virtual switch: its name and VLAN mode, as on a
 * physical port (one VLAN: access; several: trunk with an optional native
 * VLAN), or guest tagging (VGT: the guest tags; every VLAN of the uplinks
 * passes).
 */
export interface PortGroup {
  name: string;
  vlans: VlanRange[];
  native?: number;
  guestTagging: boolean;
  line: number;
}

/** A virtual switch of a hypervisor: its uplinks (host ports or aggregates, in order), teaming, MTU and port groups. */
export interface VSwitch {
  name: string;
  type?: string;
  /** host ports or aggregates; with active / standby teaming the first is active, the others stand by in order */
  uplinks: string[];
  teaming?: string;
  mtu?: number;
  portGroups: PortGroup[];
  /** its simulation attributes (teaming failover detection) */
  simulation?: Map<string, number | string>;
  line: number;
}

/** A server's Hypervisor service. */
export interface HypervisorService {
  platform?: string;
  /** the HA cluster it belongs to (hypervisors with the same name form it) */
  cluster?: string;
  /** inventory: CPU cores and memory (as written), informational */
  cpu?: number;
  ram?: string;
  vswitches: VSwitch[];
  /** the service's simulation attributes (VM restart time) */
  simulation?: Map<string, number | string>;
  line: number;
}

export type ContainerDriver = 'bridge' | 'host' | 'macvlan' | 'ipvlan' | 'overlay' | 'none';

/** A container network of a container engine. */
export interface ContainerNetwork {
  name: string;
  driver?: ContainerDriver;
  /** bridge: the bridge interface it creates on the host (docker0) */
  iface?: string;
  /** bridge, macvlan, ipvlan, overlay: its subnet and gateway */
  subnet?: string;
  gateway?: string;
  /** bridge: NAT (masquerade) to the host's address */
  nat?: boolean;
  /** macvlan, ipvlan: the host interface it sits on (a port, an aggregate, a VLAN subinterface; on a VM: a vnic) */
  parent?: string;
  /** macvlan: bridge / private / vepa / passthru; ipvlan: l2 / l3 */
  mode?: string;
  /** overlay: the other container engines that take part (their containers can attach to it too) */
  hosts: string[];
  /** IPAM: the range addresses are given from, and its two ends */
  range?: string;
  start?: string;
  end?: string;
  line: number;
}

/** A server's (or a VM's) Container engine service. */
export interface ContainerEngine {
  engine?: string;
  networks: ContainerNetwork[];
  /** the engine's simulation attributes (container start time) */
  simulation?: Map<string, number | string>;
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

/**
 * What a port is at layer 2 (derived from its `vlans`, `native` and `routed`
 * and its device; see model/derive.ts portL2):
 *   access   one VLAN, untagged;
 *   trunk    several VLANs, 802.1Q-tagged except the native one (if any);
 *   routed   a Layer 3 interface (a router's port, a Layer 3 switch's port
 *            set to routed); its subinterfaces' VLANs are tagged on it;
 *   host     a host's port without VLANs: untagged, no VLAN of its own;
 *   unset    a switch port without VLANs that is not routed (an error).
 */
export type PortKind = 'access' | 'trunk' | 'routed' | 'host' | 'unset';

/** A run of VLAN IDs, `from` to `to` inclusive (one ID: from === to). */
export interface VlanRange {
  from: number;
  to: number;
}

/**
 * One end of a physical link: the port it is plugged into, and what that
 * port is set to (speed, duplex). What the cable carries at layer 2 is not
 * written here: it follows from the port's VLANs (model/derive.ts).
 */
export type Duplex = 'full' | 'half' | 'auto';
export const DUPLEXES: readonly Duplex[] = ['full', 'half', 'auto'];

export interface LinkEnd extends Endpoint {
  /** the port's configured speed as written ("1G", "100M"); the connection's own speed is Link.speed */
  speed?: string;
  /** the port's configured duplex */
  duplex?: Duplex;
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
  /**
   * Only on a container network drawn as a network in the logical view
   * (model/virtual.ts withVirtualNetworks; never in the file): the devices
   * that can be its members (its own host's, not every address in the
   * prefix: the same subnet behind two hosts is two networks) …
   */
  scope?: string[];
  /** … the container network it stands for (its cnet: ref) … */
  cnet?: string;
  /** … and, for a bridge with NAT, the host it is hidden behind */
  nat?: string;
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
  return k === 'physical'
    ? 'Physical'
    : k === 'virtual'
      ? 'Virtual'
      : k === 'tunnel'
        ? 'Tunnel'
        : k === 'vnic'
          ? 'Virtual NIC'
          : k === 'veth'
            ? 'Container network attachment'
            : k === 'bridge'
              ? 'Container bridge'
              : 'Loopback';
}

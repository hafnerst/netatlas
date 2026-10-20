/**
 * What a device can do, resolved from its type (the registry of
 * model/device-types.ts), its mode, its "Supports Layer 3", a System's
 * purpose and a Security gateway's implementation: the one place that
 * turns a type into behaviour. Validation, Connect, the Layer 3+ rules, the
 * path tracer, the single points of failure, the simulation, Auto-arrange
 * and the input helpers ask this resolver (and the shared policy queries),
 * never a type's name. Pure.
 *
 * A capability is what the device can do, not what it will carry: a VPN
 * Gateway can terminate VPNs, but carries nothing until its tunnels are
 * configured; a filtering bridge forwards only what its policy permits; a
 * switch bridges only between ports that share a VLAN. `readiness` says
 * what is still missing for the device to do its part at all.
 */
import { DEVICE_TYPE_IDS, DeviceTypeDef, ROLES, modeOf, purposeDef, roleDef, typeDef } from './device-types';

/** How a device takes part in the network (and how it is configured). */
export interface Capabilities {
  /** an end system: sends and receives with an IP stack, forwards nothing for others */
  host: boolean;
  /** bridges frames between its ports (by VLAN where they have VLANs) */
  l2Forward: boolean;
  /** routes packets between its interfaces */
  l3Forward: boolean;
  /** applies a policy to what it forwards (a firewall's, a security gateway's) */
  policy: boolean;
  /** passes traffic between explicitly paired ports (an inline IDS/IPS, an inline System) */
  inline: boolean;
  /** receives copies of traffic and never forwards them */
  passiveCopy: boolean;
  /** an opaque external network that carries traffic between its attachments as one hop */
  externalTransit: boolean;
  /** physical continuity between paired ports, without an IP stack (a patch panel, a TAP) */
  passThrough: boolean;
  /** may run guests: VMs (the Hypervisor service) and / or containers (the Container engine) */
  canHostGuests: { vms: boolean; containers: boolean };
  /** is a guest: it needs a host and has no ports of its own */
  canBeGuest: 'vm' | 'container' | null;
  /** terminates VPN tunnels (its built-in VPN gateway function) */
  vpnTermination: boolean;
  /** forwards only to and from its VPN tunnels (never plain transit) */
  vpnOnlyTransit: boolean;
  /** separates two security domains: how it transfers between them (null: not a security gateway, or no implementation chosen) */
  separation: 'filtering_bridge' | 'filtering_router' | 'protocol_break' | null;
  /** a security gateway (whatever its implementation): only its Domain separation decides what crosses */
  securityGateway: boolean;
  /** ends a session on one side and starts its own on the other (a load balancer, a protocol break) */
  sessionBreak: boolean;
  /** provides wireless access (an access point's built-in function) */
  wirelessAccess: boolean;
  /** has an IP stack (an address of its own, at least for management) */
  ipStack: boolean;
  /** may carry static routes (a routing table) */
  routingTable: boolean;
  /** may run the Layer 3 control-plane protocols (routing, BFD, first-hop redundancy …) */
  routingProtocols: boolean;
  /** forwards for the path tracer and the simulation as a Layer 2 device between two hops */
  l2Transit: boolean;
  /** generates the simulation's endpoint test traffic */
  testTraffic: boolean;
  /** balances its virtual services over pool members (a load balancer) */
  loadBalancing: boolean;
  /** has paired ports (port_pairs) that must be configured */
  needsPortPairs: boolean;
  /** may have management interfaces kept out of the data path */
  managementInterfaces: boolean;
  /** a firewall's policy (default action, sessions, allow list) */
  firewallPolicy: boolean;
  /** an IDS/IPS's inspection (latency, fail open / closed) */
  inspection: boolean;
  /** monitors others (SNMP polling, ICMP probes) */
  monitoring: boolean;
  /** serves applications to others (a server, storage, a VM or a container: listening services, response time) */
  serviceHost: boolean;
  /** may run network services for others: a DHCP server, a DNS server (a server, a VM, a container) */
  networkServices: boolean;
  /** runs the spanning tree and the switches' features (MAC table, IGMP snooping, storm control) */
  switchFeatures: boolean;
  /**
   * may pass illustrative data between explicitly grouped opaque ports
   * (`opaque_transit:`, model/interconnect.ts): a System as a fabric
   * switch module or an active hub — the one generic transit of the
   * non-IP side, never per technology, never implied
   */
  opaqueTransit: boolean;
}

const NONE: Capabilities = {
  host: false,
  l2Forward: false,
  l3Forward: false,
  policy: false,
  inline: false,
  passiveCopy: false,
  externalTransit: false,
  passThrough: false,
  canHostGuests: { vms: false, containers: false },
  canBeGuest: null,
  vpnTermination: false,
  vpnOnlyTransit: false,
  separation: null,
  securityGateway: false,
  sessionBreak: false,
  wirelessAccess: false,
  ipStack: false,
  routingTable: false,
  routingProtocols: false,
  l2Transit: false,
  testTraffic: false,
  loadBalancing: false,
  needsPortPairs: false,
  managementInterfaces: false,
  firewallPolicy: false,
  inspection: false,
  monitoring: false,
  serviceHost: false,
  networkServices: false,
  switchFeatures: false,
  opaqueTransit: false,
};

/** What a resolver needs to know of a device. */
export interface DeviceLike {
  type: string;
  layer3?: boolean;
  mode?: string;
  purpose?: string;
  separation?: { implementation?: string };
  /** its Wireless access, when configured (a router with it bridges its Wi-Fi networks too) */
  wireless?: unknown;
  /** the registry's services it runs (a server with Load balancing balances like a load balancer) */
  appServices?: Map<string, unknown>;
}

const HOST: Partial<Capabilities> = { host: true, ipStack: true, routingTable: true };
const ROUTER: Partial<Capabilities> = { l3Forward: true, ipStack: true, routingTable: true, routingProtocols: true };

/** The capabilities of a device (see the module comment): its type's, then what the services it runs add. */
export function capabilities(d: DeviceLike): Capabilities {
  const c = baseCapabilities(d);
  if (d.appServices && d.appServices.has('load_balancing') && !c.loadBalancing) return { ...c, loadBalancing: true, sessionBreak: true };
  return c;
}

function baseCapabilities(d: DeviceLike): Capabilities {
  const t = typeDef(d.type);
  if (!t) return { ...NONE };
  return { ...NONE, ...resolve(t, d) };
}

function resolve(t: DeviceTypeDef, d: DeviceLike): Partial<Capabilities> {
  const mode = modeOf(d);
  switch (t.behaviour) {
    case 'router':
      return d.wireless ? { ...ROUTER, wirelessAccess: true } : { ...ROUTER };
    case 'switch':
      // a Layer 2 switch has a management address and static routes, and routes nothing; "Supports Layer 3" makes it route
      return d.layer3 ? { ...ROUTER, l2Forward: true, l2Transit: true, switchFeatures: true } : { l2Forward: true, l2Transit: true, switchFeatures: true, ipStack: true, routingTable: true };
    case 'firewall':
      return mode === 'transparent'
        ? { l2Forward: true, l2Transit: true, policy: true, firewallPolicy: true, managementInterfaces: true, ipStack: true, routingTable: true }
        : { ...ROUTER, policy: true, firewallPolicy: true, managementInterfaces: true };
    case 'access_point':
      // (its management address may have its default gateway, as a Layer 2 switch's may: it routes nothing)
      return { l2Forward: true, l2Transit: true, wirelessAccess: true, ipStack: true, routingTable: true };
    case 'load_balancer':
      return { ...ROUTER, sessionBreak: true, loadBalancing: true };
    case 'ids_ips':
      return mode === 'passive' ? { passiveCopy: true, inspection: true, managementInterfaces: true } : { inline: true, l2Transit: true, needsPortPairs: true, inspection: true, managementInterfaces: true };
    case 'vpn_gateway':
      return { ...ROUTER, vpnTermination: true, vpnOnlyTransit: true };
    case 'security_gateway':
      return separationCaps(d);
    case 'host':
      return { ...HOST, serviceHost: true, networkServices: d.type === 'server', canHostGuests: { vms: d.type === 'server', containers: d.type === 'server' } };
    case 'guest_vm':
      // a VM with "Supports Layer 3" is a virtual router or firewall
      return d.layer3 ? { ...ROUTER, serviceHost: true, networkServices: true, canBeGuest: 'vm', canHostGuests: { vms: false, containers: true } } : { ...HOST, serviceHost: true, networkServices: true, canBeGuest: 'vm', canHostGuests: { vms: false, containers: true } };
    case 'guest_container':
      return { ...HOST, serviceHost: true, networkServices: true, canBeGuest: 'container' };
    case 'endpoint':
      return { ...HOST, testTraffic: true };
    case 'cloud':
      return { externalTransit: true };
    case 'system':
      return { ...systemCaps(d.purpose), opaqueTransit: true };
  }
  return {};
}

/** A Security gateway: what crosses is only what its Domain separation permits, the way its implementation does it. */
function separationCaps(d: DeviceLike): Partial<Capabilities> {
  const impl = d.separation && d.separation.implementation;
  const base: Partial<Capabilities> = { securityGateway: true, policy: true, managementInterfaces: true, ipStack: true };
  if (impl === 'filtering_bridge') return { ...base, separation: impl, l2Forward: true, l2Transit: true, routingTable: true };
  if (impl === 'filtering_router') return { ...base, separation: impl, l3Forward: true, routingTable: true };
  if (impl === 'protocol_break') return { ...base, separation: impl, sessionBreak: true, routingTable: true };
  // no implementation chosen: it transfers nothing at all
  return { ...base, routingTable: true };
}

/** A System: what its declared purpose says (without one it does nothing). */
function systemCaps(purpose: string | undefined): Partial<Capabilities> {
  switch (purposeDef(purpose) ? purpose : '') {
    case 'host':
      return { ...HOST, monitoring: true };
    case 'l2_forwarder':
      return { l2Forward: true, l2Transit: true, ipStack: true, routingTable: true };
    case 'l3_forwarder':
      return { ...ROUTER };
    case 'inline':
      return { inline: true, l2Transit: true, needsPortPairs: true };
    case 'passive_monitor':
      return { passiveCopy: true, monitoring: true, ipStack: true, managementInterfaces: true };
    case 'pass_through':
      return { passThrough: true, l2Transit: true, needsPortPairs: true };
    case 'external_network':
      return { externalTransit: true };
  }
  return {};
}

// ------------------------------------------------------------ what follows from the capabilities

/**
 * What a device does at layer 3, for static routes and the path tracer:
 *   router  forwards traffic between its interfaces (Layer 3+);
 *   host    has its own IP stack and may have routes (a default gateway is
 *           a static default route), but never forwards for others;
 *   null    no routing table in the model.
 */
export type RoutingRole = 'router' | 'host';

export function deviceRoutingRole(d: DeviceLike): RoutingRole | null {
  const c = capabilities(d);
  if (c.l3Forward) return 'router';
  return c.routingTable ? 'host' : null;
}

/** Does the device route (a Layer 3+ device, a Layer 3 switch included)? */
export function isLayer3Device(d: DeviceLike): boolean {
  return capabilities(d).l3Forward;
}

/** Is the device a Layer 2 switch: a switch's features without routing? */
export function isLayer2Switch(d: DeviceLike): boolean {
  const c = capabilities(d);
  return c.switchFeatures && !c.l3Forward;
}

/** May a device of this type carry static routes at all (whatever its mode or purpose)? Used for the format's documentation. */
export function typeMayRoute(type: string): boolean {
  const t = typeDef(type);
  if (!t) return false;
  if (t.behaviour === 'system') return true;
  return capabilities({ type, layer3: true }).routingTable || capabilities({ type }).routingTable;
}

/**
 * The protocols (base ids) whose relations need a Layer 3 device at every
 * end (besides tunnels and overlays): routing, multicast routing, label
 * distribution, BFD and the first-hop redundancy groups.
 */
export const LAYER3_PROTOCOLS: readonly string[] = ['bgp', 'ospf', 'isis', 'eigrp', 'rip', 'ldp', 'pim', 'bfd', 'vrrp', 'hsrp', 'glbp', 'carp'];

/** Does a relation of this protocol (base id) and category need Layer 3 at every end? */
export function relationNeedsLayer3(base: string, category: string): boolean {
  return category === 'tunnel' || category === 'overlay' || LAYER3_PROTOCOLS.indexOf(base) >= 0;
}

/**
 * The physical view's row of a device (Auto-arrange): its role's row when it
 * has a known role, else what it does — external networks on top, routers
 * (and VPN gateways), policy and inline devices, switches, wireless access,
 * hosts; a custom role has no row of its own and falls back the same way.
 */
export function deviceTier(d: DeviceLike & { role?: string }): number {
  const r = roleDef(d.role);
  if (r) return r.tier;
  const c = capabilities(d);
  if (c.externalTransit) return 0;
  if (c.canBeGuest) return 6;
  if (c.wirelessAccess) return 5;
  if (c.switchFeatures || c.passThrough) return 4;
  if (c.policy || c.inline || c.securityGateway) return 2;
  if (c.l3Forward) return 1;
  if (c.host || c.passiveCopy) return 6;
  return 4;
}

/** the role ids, for lists */
export const ROLE_IDS: readonly string[] = ROLES.map((r) => r.id);

/** Does "Supports Layer 3" (`layer3:`) change what a device of this type does (a switch, a VM)? */
export function layer3Option(type: string): boolean {
  return capabilities({ type, layer3: true }).l3Forward && !capabilities({ type }).l3Forward;
}

/** The types that may carry static routes (in some mode or purpose), in the order of the registry. */
export const ROUTE_DEVICE_TYPES: ReadonlyArray<string> = DEVICE_TYPE_IDS.filter((t) => typeMayRoute(t));

/** The types that run routing protocols as they are (without "Supports Layer 3", in their default mode). */
export const ROUTING_PROTOCOL_TYPES: ReadonlyArray<string> = DEVICE_TYPE_IDS.filter((t) => capabilities({ type: t }).routingProtocols);

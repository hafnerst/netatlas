/**
 * The device types of the format. A device's `type` must be one of these
 * identifiers (or be absent); anything else is a validation error.
 */
export interface DeviceTypeDef {
  /** identifier used in YAML */
  id: string;
  /** name shown in the UI */
  label: string;
}

export const DEVICE_TYPES: ReadonlyArray<DeviceTypeDef> = [
  { id: 'router', label: 'Router' },
  { id: 'switch', label: 'Switch' },
  { id: 'firewall', label: 'Firewall' },
  { id: 'ap', label: 'Access point' },
  { id: 'server', label: 'Server' },
  { id: 'vm', label: 'Virtual machine' },
  { id: 'container', label: 'Container' },
  { id: 'storage', label: 'Storage' },
  { id: 'load_balancer', label: 'Load balancer' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'ids_ips', label: 'IDS/IPS' },
  { id: 'gateway', label: 'Gateway' },
  { id: 'endpoint', label: 'Endpoint' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'system', label: 'System' },
];

export const DEVICE_TYPE_IDS: ReadonlyArray<string> = DEVICE_TYPES.map((t) => t.id);

/** Model value of a device without a (valid) type. */
export const NO_DEVICE_TYPE = 'generic';

export function isDeviceType(id: string): boolean {
  return DEVICE_TYPE_IDS.indexOf(id) >= 0;
}

/** Display name of a device type; '' for a device without a valid type. */
/**
 * The key of a device in the Device types filter: its type, and for a
 * switch whether it is a Layer 2 or a Layer 3 one ("switch:l2",
 * "switch:l3"), so that the two can be shown or hidden apart.
 */
export function typeKey(d: { type: string; layer3?: boolean }): string {
  return d.type === 'switch' ? (d.layer3 ? 'switch:l3' : 'switch:l2') : d.type;
}

/** The name of a Device types key ("Server", "Layer 2 switch"). */
export function typeKeyLabel(key: string): string {
  if (key === 'switch:l2') return 'Layer 2 switch';
  if (key === 'switch:l3') return 'Layer 3 switch';
  return deviceTypeLabel(key) || key;
}

export function deviceTypeLabel(id: string): string {
  for (const t of DEVICE_TYPES) if (t.id === id) return t.label;
  return '';
}

/** Second line of a device box: the display name of its type ("Layer 2 switch" / "Layer 3 switch" for a switch). */
export function deviceSubtitle(type: string, layer3?: boolean): string {
  if (type === 'switch') return layer3 ? 'Layer 3 switch' : 'Layer 2 switch';
  return deviceTypeLabel(type);
}

/** The type's name for a device, with the switch's layer ("Layer 3 switch"). */
export function deviceKindLabel(d: { type: string; layer3?: boolean }): string {
  return deviceSubtitle(d.type, d.layer3);
}

/** Is the device a Layer 2 switch (a switch without `layer3: true`)? */
export function isLayer2Switch(d: { type: string; layer3?: boolean }): boolean {
  return d.type === 'switch' && !d.layer3;
}

/**
 * What a device of a type does at layer 3, for static routes and the path
 * tracer:
 *   router  forwards traffic between its interfaces (Layer 3+): router,
 *           switch (as a type; a device is one only with layer3: true, see
 *           deviceRoutingRole), firewall, load balancer, proxy,
 *           gateway;
 *   host    an end system with its own IP stack: it may have routes (a
 *           default gateway is a static default route), but it never
 *           forwards traffic for others: server, VM, container, storage,
 *           endpoint, system;
 *   null    no routing table in the model: access point and IDS/IPS (drawn
 *           as layer-2 / transparent devices), cloud (a network outside the
 *           model) and a device without a type.
 * Routes are allowed on `router` and `host` devices only.
 */
export type RoutingRole = 'router' | 'host';

const ROUTING: { [type: string]: RoutingRole } = {
  router: 'router',
  switch: 'router',
  firewall: 'router',
  load_balancer: 'router',
  proxy: 'router',
  gateway: 'router',
  server: 'host',
  vm: 'host',
  container: 'host',
  storage: 'host',
  endpoint: 'host',
  system: 'host',
};

export function routingRole(type: string): RoutingRole | null {
  return Object.prototype.hasOwnProperty.call(ROUTING, type) ? ROUTING[type] : null;
}

/**
 * What a device does at layer 3, with its switch layer: a Layer 3 switch
 * (`layer3: true`) is a router; a Layer 2 switch is like a host (a
 * management address and static routes, e.g. a default gateway towards
 * management) and never forwards traffic between subnets or VLANs. Every
 * other type: routingRole(type). The Inspector, the Protocols card, the
 * checks, the path tracer, the single points of failure and the simulation
 * all use this rule.
 */
export function deviceRoutingRole(d: { type: string; layer3?: boolean }): RoutingRole | null {
  if (isLayer2Switch(d)) return 'host';
  return routingRole(d.type);
}

/**
 * The protocols (base ids) whose relations need a Layer 3 device at every
 * end (besides tunnels and overlays): routing, multicast routing, label
 * distribution, BFD and the first-hop redundancy groups. A Layer 2 switch
 * (without "Supports Layer 3") can't be an endpoint of one; its Layer 2
 * protocols (STP, LACP, LLDP, IGMP / MLD snooping) and its management
 * routes stay available.
 */
export const LAYER3_PROTOCOLS: readonly string[] = ['bgp', 'ospf', 'isis', 'eigrp', 'rip', 'ldp', 'pim', 'bfd', 'vrrp', 'hsrp', 'glbp', 'carp'];

/** Does a relation of this protocol (base id) and category need Layer 3 at every end? */
export function relationNeedsLayer3(base: string, category: string): boolean {
  return category === 'tunnel' || category === 'overlay' || LAYER3_PROTOCOLS.indexOf(base) >= 0;
}

/** Does the device route (a Layer 3+ device, a Layer 3 switch included)? */
export function isLayer3Device(d: { type: string; layer3?: boolean }): boolean {
  return deviceRoutingRole(d) === 'router';
}

/** The device types that may carry static routes, in the order of DEVICE_TYPES. */
export const ROUTE_DEVICE_TYPES: ReadonlyArray<string> = DEVICE_TYPE_IDS.filter((t) => routingRole(t) !== null);

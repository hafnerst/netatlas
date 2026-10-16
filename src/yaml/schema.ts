/**
 * The netatlas YAML format: which keys each kind of mapping may contain, in
 * canonical order. This is the single definition used by
 *   - validation (unknown keys are errors),
 *   - the editing core (new keys are inserted in this order),
 *   - the inspector (keys outside the schema are shown as "other properties").
 * Any other key is an error ("unknown key", with a suggestion).
 * The prose reference is docs/FORMAT.md.
 */

export const FORMAT_VERSION = 1;

export const SCHEMA = {
  top: ['netatlas', 'title', 'description', 'protocols', 'groups', 'devices', 'links', 'networks', 'relations', 'demands', 'checks', 'layout'],
  protocol: ['id', 'label', 'category', 'color', 'style', 'router_id', 'params', 'description'],
  /** a parameter a protocol of the model declares: an entry of its `params` */
  param: ['key', 'label', 'type', 'scope', 'required', 'min', 'max', 'values', 'suggest', 'description'],
  group: ['id', 'label', 'kind', 'provider', 'parent', 'description', 'attrs'],
  device: ['id', 'label', 'type', 'kind', 'kind_label', 'role', 'mode', 'purpose', 'icon', 'host', 'layer3', 'group', 'tier', 'guest_os', 'vcpu', 'ram', 'image', 'router_id', 'protocols', 'services', 'port_pairs', 'management', 'simulation', 'description', 'attrs', 'interfaces', 'logical_interfaces', 'dns_names', 'dns_servers', 'routes'],
  /** a device's services (its `services:`): a DHCP server, a DNS server, the Hypervisor and the Container engine; a VPN Gateway's VPN gateway, a Separation gateway's Domain separation */
  netServices: ['vpn', 'separation', 'dhcp', 'dns', 'hypervisor', 'container_engine'],
  /** two ports a device passes traffic between: an entry of `port_pairs` */
  portPair: ['a', 'b', 'direction', 'copy'],
  /** a VPN Gateway's VPN gateway function (`services.vpn`) */
  vpn: ['operation', 'technology', 'tunnels', 'listener', 'pool', 'protected'],
  /** a Separation gateway's Domain separation (`services.separation`) */
  separation: ['implementation', 'domains', 'directions', 'rules', 'profiles', 'simulation'],
  /** a security domain: an entry of `services.separation.domains` */
  sepDomain: ['name', 'interfaces'],
  /** a permitted direction of transfer: an entry of `services.separation.directions` */
  sepDirection: ['from', 'to'],
  /** a permitted transfer: an entry of `services.separation.rules` */
  sepRule: ['id', 'description', 'from', 'to', 'source', 'destination', 'protocol', 'ports', 'profile'],
  /** a protocol break's transfer profile: an entry of `services.separation.profiles` */
  transferProfile: ['id', 'type', 'listen', 'forward'],
  /** where a transfer profile listens */
  profileListen: ['interface', 'port'],
  /** where a transfer profile sends the new transfer */
  profileForward: ['address', 'port'],
  /** a server's Hypervisor service */
  hypervisor: ['platform', 'cluster', 'cpu', 'ram', 'vswitches', 'simulation'],
  /** a virtual switch: an entry of `services.hypervisor.vswitches` */
  vswitch: ['name', 'type', 'uplinks', 'teaming', 'mtu', 'port_groups', 'simulation'],
  /** a port group: an entry of a virtual switch's `port_groups` */
  portGroup: ['name', 'vlans', 'native', 'guest_tagging'],
  /** a server's (or a VM's) Container engine service */
  containerEngine: ['engine', 'networks', 'simulation'],
  /** a container network: an entry of `services.container_engine.networks` */
  containerNetwork: ['name', 'driver', 'interface', 'subnet', 'gateway', 'nat', 'parent', 'mode', 'hosts', 'range'],
  /** a port a container publishes on its host: an entry of a veth's `publish` */
  published: ['host_ip', 'host_port', 'port', 'protocol'],
  dhcpService: ['scopes'],
  /** a DHCP scope: an entry of `services.dhcp.scopes` */
  dhcpScope: ['network', 'range', 'gateway', 'dns', 'lease', 'exclude', 'reservations', 'domain', 'simulation'],
  dhcpReservation: ['mac', 'ip'],
  dnsService: ['listen', 'zones', 'reverse_zones', 'forwarders'],
  /** a DNS zone: an entry of `services.dns.zones` */
  dnsZone: ['name', 'records', 'simulation'],
  dnsRecord: ['name', 'type', 'value'],
  /** a physical interface (a port): an entry of a device's `interfaces` */
  interface: ['id', 'label', 'vlans', 'native', 'routed', 'dhcp', 'ip', 'vrf', 'mac', 'mtu', 'dhcp_relay', 'protocols', 'multicast', 'simulation', 'description', 'attrs'],
  /** a loopback, virtual or tunnel interface: an entry of a device's `logical_interfaces` */
  logical: ['id', 'type', 'label', 'port_group', 'passthrough', 'vf', 'role', 'network', 'aliases', 'dhcp', 'ip', 'vrf', 'mac', 'mtu', 'dhcp_relay', 'members', 'min_links', 'vlans', 'native', 'routed', 'vlan', 'source', 'destination', 'publish', 'protocols', 'multicast', 'simulation', 'description', 'attrs'],
  /** an interface's `multicast:` block, a group it joins written as a mapping, a stream it sends */
  multicast: ['join', 'streams'],
  mcJoin: ['group', 'sources'],
  mcStream: ['group', 'port', 'interval', 'size'],
  /** a DNS name of a device: an entry of a device's `dns_names` */
  dnsName: ['name', 'interfaces'],
  /** a static route of a device: an entry of a device's `routes` */
  route: ['prefix', 'via', 'interface', 'blackhole', 'distance', 'metric', 'vrf', 'name', 'description', 'attrs'],
  link: ['id', 'a', 'b', 'medium', 'speed', 'label', 'cable', 'direction', 'simulation', 'description', 'attrs'],
  /** one end of a link written as a mapping */
  linkEnd: ['device', 'interface', 'speed', 'duplex'],
  network: ['id', 'label', 'cidr', 'vlan', 'simulation', 'description', 'attrs'],
  relation: ['id', 'protocol', 'category', 'label', 'endpoints', 'over', 'direction', 'simulation', 'description', 'attrs'],
  /** a relation endpoint written as a mapping (the same as "device:interface") */
  endpoint: ['device', 'interface'],
  /** a traffic demand: an entry of `demands` */
  demand: ['id', 'label', 'source', 'destination', 'bandwidth', 'class', 'description'],
  /** the presentation-only layout section */
  layout: ['physical', 'logical', 'manual'],
};

export type SchemaKind = keyof typeof SCHEMA;

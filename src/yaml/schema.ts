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
  group: ['id', 'label', 'kind', 'parent', 'description', 'attrs'],
  device: ['id', 'label', 'type', 'layer3', 'group', 'tier', 'router_id', 'protocols', 'services', 'simulation', 'description', 'attrs', 'interfaces', 'logical_interfaces', 'dns_names', 'dns_servers', 'routes'],
  /** a server's network services (its `services:`): a DHCP server, a DNS server */
  netServices: ['dhcp', 'dns'],
  dhcpService: ['scopes'],
  /** a DHCP scope: an entry of `services.dhcp.scopes` */
  dhcpScope: ['network', 'range', 'gateway', 'dns', 'lease', 'exclude', 'reservations', 'domain', 'simulation'],
  dhcpReservation: ['mac', 'ip'],
  dnsService: ['listen', 'zones', 'reverse_zones', 'forwarders'],
  /** a DNS zone: an entry of `services.dns.zones` */
  dnsZone: ['name', 'records', 'simulation'],
  dnsRecord: ['name', 'type', 'value'],
  /** a physical interface (a port): an entry of a device's `interfaces` */
  interface: ['id', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'mtu', 'dhcp_relay', 'protocols', 'multicast', 'simulation', 'description', 'attrs'],
  /** a loopback, virtual or tunnel interface: an entry of a device's `logical_interfaces` */
  logical: ['id', 'type', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'mtu', 'dhcp_relay', 'members', 'min_links', 'vlan', 'source', 'destination', 'protocols', 'multicast', 'simulation', 'description', 'attrs'],
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
  linkEnd: ['device', 'interface', 'speed', 'duplex', 'mode', 'untagged', 'tagged'],
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

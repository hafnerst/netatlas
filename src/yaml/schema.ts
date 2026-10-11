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
  top: ['netatlas', 'title', 'description', 'protocols', 'groups', 'devices', 'links', 'networks', 'relations', 'checks', 'layout'],
  protocol: ['id', 'label', 'category', 'color', 'style', 'description'],
  group: ['id', 'label', 'kind', 'parent', 'description', 'attrs'],
  device: ['id', 'label', 'type', 'group', 'tier', 'router_id', 'asn', 'description', 'attrs', 'interfaces', 'logical_interfaces', 'dns_names', 'routes'],
  /** a physical interface (a port): an entry of a device's `interfaces` */
  interface: ['id', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'mtu', 'description', 'attrs'],
  /** a loopback, virtual or tunnel interface: an entry of a device's `logical_interfaces` */
  logical: ['id', 'type', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'mtu', 'members', 'min_links', 'vlan', 'source', 'destination', 'description', 'attrs'],
  /** a DNS name of a device: an entry of a device's `dns_names` */
  dnsName: ['name', 'interfaces'],
  /** a static route of a device: an entry of a device's `routes` */
  route: ['prefix', 'via', 'interface', 'blackhole', 'distance', 'metric', 'vrf', 'name', 'description', 'attrs'],
  link: ['id', 'a', 'b', 'medium', 'speed', 'label', 'cable', 'description', 'attrs'],
  /** one end of a link written as a mapping */
  linkEnd: ['device', 'interface', 'speed', 'duplex', 'mode', 'untagged', 'tagged'],
  network: ['id', 'label', 'cidr', 'vlan', 'description', 'attrs'],
  relation: ['id', 'protocol', 'category', 'label', 'endpoints', 'over', 'direction', 'description', 'attrs'],
  /** a relation endpoint written as a mapping (the same as "device:interface") */
  endpoint: ['device', 'interface'],
  /** the presentation-only layout section */
  layout: ['physical', 'logical', 'manual'],
};

export type SchemaKind = keyof typeof SCHEMA;

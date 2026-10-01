/**
 * The netatlas YAML format: which keys each kind of mapping may contain, in
 * canonical order. This is the single definition used by
 *   - validation (unknown keys are errors),
 *   - the editing core (new keys are inserted in this order),
 *   - the inspector (keys outside the schema are shown as "other properties").
 * The prose reference is docs/FORMAT.md.
 */

export const FORMAT_VERSION = 1;

export const SCHEMA = {
  top: ['netatlas', 'title', 'description', 'protocols', 'groups', 'devices', 'links', 'networks', 'relations', 'layout'],
  protocol: ['id', 'label', 'category', 'color', 'style', 'description'],
  group: ['id', 'label', 'kind', 'parent', 'description', 'attrs'],
  device: ['id', 'label', 'type', 'group', 'tier', 'description', 'attrs', 'interfaces', 'logical_interfaces', 'dns_names'],
  /** a physical interface (a port): an entry of a device's `interfaces` */
  interface: ['id', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'description', 'attrs'],
  /** a loopback, virtual or tunnel interface: an entry of a device's `logical_interfaces` */
  logical: ['id', 'type', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'members', 'vlan', 'source', 'destination', 'description', 'attrs'],
  /** a DNS name of a device: an entry of a device's `dns_names` */
  dnsName: ['name', 'interfaces'],
  link: ['id', 'a', 'b', 'medium', 'speed', 'label', 'cable', 'description', 'attrs'],
  /** one end of a link written as a mapping */
  linkEnd: ['device', 'interface', 'vlans'],
  network: ['id', 'label', 'cidr', 'vlan', 'description', 'attrs'],
  relation: ['id', 'protocol', 'category', 'label', 'endpoints', 'over', 'network', 'directed', 'description', 'attrs'],
  /** a relation endpoint written as a mapping */
  endpoint: ['device', 'interface', 'role', 'address', 'attrs'],
  /** the presentation-only layout section */
  layout: ['physical', 'logical', 'manual'],
};

export type SchemaKind = keyof typeof SCHEMA;

/**
 * Keys that aren't part of the format but are easily expected in a place, with
 * what to write instead. They are rejected like any unknown key (never read,
 * converted or written); the error says where the fact belongs.
 */
const IFACE_VLAN =
  'the VLAN of a physical interface is derived from the network whose "cidr" contains its address: set "vlan:" on that network and delete it here ' +
  '(VLANs permitted on a cable are "vlans:" on the end of the link; a VLAN interface is a virtual interface under "logical_interfaces:")';
const NOT_A_PORT = 'speed and medium belong to the physical link, and only a physical interface can be cabled: delete this key';
const NO_NESTING =
  'interfaces are not nested: move each entry into "logical_interfaces:" of the device and give it "type: virtual" or "type: tunnel". ' +
  'A tunnel names the interface it is sourced from with "source:"; an aggregate lists its ports under "members:"; a VLAN interface names its VLAN with "vlan:"';

export const RETIRED: { [kind: string]: { [key: string]: string } } = {
  device: {
    vendor: 'a device has no vendor field: delete this key (custom data can be kept under "attrs:")',
    model: 'a device has no model field: delete this key (custom data can be kept under "attrs:")',
    role: 'a device has no role field: delete this key (custom data can be kept under "attrs:")',
    mgmt: 'a device has no management-address field: delete this key (custom data can be kept under "attrs:")',
    router_id: 'a device has no router-ID field: delete this key. Loopbacks and their addresses are declared under "logical_interfaces:" with "type: loopback"',
    loopbacks: 'loopbacks are logical interfaces: move each entry into "logical_interfaces:" of the device and add "type: loopback" to it',
  },
  interface: {
    type:
      'an entry of "interfaces:" is always a physical interface and has no type: delete this key. ' +
      'A loopback, virtual or tunnel interface belongs in the "logical_interfaces:" list of the device, with its "type:"',
    children: NO_NESTING,
    members: 'only a virtual interface (an aggregate) has member ports: declare the aggregate under "logical_interfaces:" with "type: virtual" and list this port in its "members:"',
    source: 'only a tunnel interface has a source: declare the tunnel under "logical_interfaces:" with "type: tunnel"',
    destination: 'only a tunnel interface has a destination: declare the tunnel under "logical_interfaces:" with "type: tunnel"',
    speed: 'speed is configured once, on the physical link: set "speed:" on the link cabled to this port and delete it here',
    media: 'the medium is configured once, on the physical link: set "medium:" on the link cabled to this port and delete it here',
    vlan: IFACE_VLAN,
  },
  logical: {
    children: NO_NESTING,
    parent: 'a logical interface has no generic parent: use "members:" (aggregate), "vlan:" (VLAN interface) or "source:" (tunnel) for the association that applies, or delete this key',
    speed: NOT_A_PORT,
    media: NOT_A_PORT,
  },
  network: {
    kind: 'a network is always an IP network: delete this key',
    vrf: 'a VRF is assigned on the interfaces that belong to it: set "vrf:" on those interfaces and delete it here',
    members:
      'members are derived from the interface and loopback addresses inside the "cidr" of the network: delete this key ' +
      'and give each member interface an address in the prefix',
  },
};

/** Group kinds that are rejected, with the kind to write instead. */
export const RENAMED_GROUP_KINDS: { [kind: string]: string } = { row: 'floor' };

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
  device: ['id', 'label', 'type', 'group', 'tier', 'description', 'attrs', 'loopbacks', 'interfaces'],
  /** a physical interface: an entry of a device's `interfaces` */
  interface: ['id', 'label', 'ip', 'vrf', 'mac', 'description', 'attrs', 'children'],
  /** a logical or tunnel interface: an entry of a physical interface's `children` */
  child: ['id', 'label', 'type', 'ip', 'vrf', 'mac', 'description', 'attrs'],
  /** a loopback: an entry of a device's `loopbacks` */
  loopback: ['id', 'label', 'ip', 'vrf', 'description', 'attrs'],
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
 * Keys that earlier files used and the format no longer has, with what to do
 * instead. They are rejected (never read, converted or written), and the
 * error says how to update the file by hand.
 */
const IFACE_VLAN =
  'the VLAN of an interface is derived from the network whose "cidr" contains its address: set "vlan:" on that network and delete it here ' +
  '(VLANs permitted on a cable are "vlans:" on the end of the link)';
const NOT_A_PORT = 'speed and medium belong to the physical link, and only a physical interface can be cabled: delete this key';

export const RETIRED: { [kind: string]: { [key: string]: string } } = {
  device: {
    vendor: 'a device has no vendor field: delete this key (custom data can be kept under "attrs:")',
    model: 'a device has no model field: delete this key (custom data can be kept under "attrs:")',
    role: 'a device has no role field: delete this key (custom data can be kept under "attrs:")',
    mgmt: 'a device has no management-address field: delete this key (custom data can be kept under "attrs:")',
    router_id: 'a device has no router-ID field: delete this key. Loopbacks and their addresses are declared under "loopbacks:"',
  },
  interface: {
    type:
      'an entry of "interfaces:" is always a physical interface and has no type: delete this key. ' +
      'A loopback belongs in the "loopbacks:" list of the device; a logical or tunnel interface belongs in "children:" of the physical interface it runs on',
    speed: 'speed is configured once, on the physical link: set "speed:" on the link cabled to this port and delete it here',
    media: 'the medium is configured once, on the physical link: set "medium:" on the link cabled to this port and delete it here',
    vlan: IFACE_VLAN,
  },
  child: {
    children: 'a child interface cannot have children of its own: list it directly under "children:" of the physical interface',
    speed: NOT_A_PORT,
    media: NOT_A_PORT,
    vlan: IFACE_VLAN,
  },
  loopback: {
    type: 'an entry of "loopbacks:" is a loopback by definition: delete this key',
    mac: 'a loopback is not a port and has no MAC address: delete this key',
    children: 'a loopback has no child interfaces: delete this key',
    speed: NOT_A_PORT,
    media: NOT_A_PORT,
    vlan: IFACE_VLAN,
  },
  network: {
    kind: 'a network is always an IP network: delete this key',
    vrf: 'a VRF is assigned on the interfaces that belong to it: set "vrf:" on those interfaces and delete it here',
    members:
      'members are derived from the interface and loopback addresses inside the "cidr" of the network: delete this key ' +
      'and give each member interface an address in the prefix',
  },
};

/** Group kinds that were renamed (old -> new). */
export const RENAMED_GROUP_KINDS: { [kind: string]: string } = { row: 'floor' };

/**
 * The netatlas YAML format: which keys each kind of mapping may contain, in
 * canonical order. This is the single definition used by
 *   - validation (unknown keys are errors),
 *   - the editing core (new keys are inserted in this order),
 *   - the inspector (keys outside the schema are shown as "other properties").
 * The prose reference is docs/FORMAT.md.
 */

/**
 * Version 2 replaced version 1 (one authoritative place per fact; see "Changes
 * from version 1" in docs/FORMAT.md). Version 1 files are not read.
 */
export const FORMAT_VERSION = 2;

export const SCHEMA = {
  top: ['netatlas', 'title', 'description', 'protocols', 'groups', 'devices', 'links', 'networks', 'relations', 'layout'],
  protocol: ['id', 'label', 'category', 'color', 'style', 'description'],
  group: ['id', 'label', 'kind', 'parent', 'description', 'attrs'],
  device: ['id', 'label', 'type', 'group', 'vendor', 'model', 'role', 'mgmt', 'router_id', 'tier', 'description', 'attrs', 'interfaces'],
  interface: ['id', 'label', 'type', 'ip', 'vrf', 'mac', 'description', 'attrs'],
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
export const RETIRED: { [kind: string]: { [key: string]: string } } = {
  interface: {
    speed: 'speed is configured once, on the physical link: set "speed:" on the link cabled to this port and delete it here',
    media: 'the medium is configured once, on the physical link: set "medium:" on the link cabled to this port and delete it here',
    vlan:
      'the VLAN of an interface is derived from the network whose "cidr" contains its address: set "vlan:" on that network and delete it here ' +
      '(VLANs permitted on a cable are "vlans:" on the end of the link)',
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

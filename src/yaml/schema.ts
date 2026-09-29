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
  device: ['id', 'label', 'type', 'group', 'vendor', 'model', 'role', 'mgmt', 'router_id', 'tier', 'description', 'attrs', 'interfaces'],
  interface: ['id', 'label', 'type', 'speed', 'media', 'ip', 'vlan', 'mac', 'description', 'attrs'],
  link: ['id', 'a', 'b', 'medium', 'speed', 'label', 'cable', 'description', 'attrs'],
  network: ['id', 'label', 'kind', 'cidr', 'vlan', 'vrf', 'members', 'description', 'attrs'],
  relation: ['id', 'protocol', 'category', 'label', 'endpoints', 'over', 'network', 'directed', 'description', 'attrs'],
  /** an endpoint written as a mapping (links accept only device/interface) */
  endpoint: ['device', 'interface', 'role', 'address', 'attrs'],
  /** the presentation-only layout section */
  layout: ['physical', 'logical', 'manual'],
};

export type SchemaKind = keyof typeof SCHEMA;

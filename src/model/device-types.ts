/**
 * The device types of the format, and everything that is decided per type:
 * the one place where a type's identifier stands for what the device does.
 * A device's `type` must be one of these identifiers (or be absent);
 * anything else is a validation error. What a device of a type does (its
 * capabilities: forwarding, policy, hosting, transit …) is resolved from
 * this registry with its mode, its "Supports Layer 3", its purpose and its
 * functions by model/capabilities.ts; the rest of the program asks that
 * resolver, never the type's name.
 *
 * Every type has its **kinds** (a subtype, optional: an icon variant at
 * most, never a different behaviour) and accepts `other` with a name of its
 * own; a System has only that (a free subtype label). **Roles** are an
 * architectural position (Core, Leaf, WAN edge …, or a custom one).
 */

/** What a device of a type does before its mode, layer and purpose are applied (model/capabilities.ts). */
export type BaseBehaviour =
  | 'router'
  | 'switch'
  | 'firewall'
  | 'access_point'
  | 'load_balancer'
  | 'ids_ips'
  | 'vpn_gateway'
  | 'security_gateway'
  | 'host'
  | 'guest_vm'
  | 'guest_container'
  | 'endpoint'
  | 'cloud'
  | 'system';

export interface KindDef {
  id: string;
  label: string;
  /** an icon variant (diagram/icons.ts), else the type's */
  icon?: string;
}

export interface ModeDef {
  id: string;
  label: string;
  help: string;
}

export interface DeviceTypeDef {
  /** identifier used in YAML */
  id: string;
  /** name shown in the UI */
  label: string;
  behaviour: BaseBehaviour;
  kinds: ReadonlyArray<KindDef>;
  /** its modes (`mode:`), the first one being the one in effect when none is written; none: the type has no mode */
  modes?: ReadonlyArray<ModeDef>;
  /** its plural, for lists ("Routers") */
  plural: string;
}

const OTHER: KindDef = { id: 'other', label: 'Other' };

export const DEVICE_TYPES: ReadonlyArray<DeviceTypeDef> = [
  {
    id: 'router',
    label: 'Router',
    plural: 'Routers',
    behaviour: 'router',
    kinds: [{ id: 'router', label: 'Router' }, { id: 'cpe', label: 'CPE / modem router' }, { id: 'sd_wan', label: 'SD-WAN edge' }, { id: 'cloud_gateway', label: 'Cloud gateway', icon: 'cloud_gateway' }, OTHER],
  },
  { id: 'switch', label: 'Switch', plural: 'Switches', behaviour: 'switch', kinds: [{ id: 'campus', label: 'Campus' }, { id: 'data_center', label: 'Data center' }, { id: 'industrial', label: 'Industrial' }, OTHER] },
  {
    id: 'firewall',
    label: 'Firewall',
    plural: 'Firewalls',
    behaviour: 'firewall',
    kinds: [{ id: 'ngfw', label: 'Next-generation firewall' }, { id: 'utm', label: 'UTM' }, { id: 'cloud_firewall', label: 'Cloud firewall' }, OTHER],
    modes: [
      { id: 'routed', label: 'Routed', help: 'Routes between its interfaces and applies its policy to what it forwards.' },
      { id: 'transparent', label: 'Transparent', help: 'Bridges its data ports (no addresses on them) and applies its policy to what passes.' },
    ],
  },
  {
    id: 'ap',
    label: 'Access point',
    plural: 'Access points',
    behaviour: 'access_point',
    kinds: [{ id: 'indoor', label: 'Indoor' }, { id: 'outdoor', label: 'Outdoor' }, { id: 'mesh', label: 'Mesh node' }, { id: 'bridge', label: 'Wireless bridge (point-to-point)' }, OTHER],
    modes: [
      { id: 'standalone', label: 'Standalone', help: 'Configured on its own.' },
      { id: 'controller', label: 'Controller-managed', help: 'Managed by a wireless controller.' },
    ],
  },
  { id: 'load_balancer', label: 'Load balancer', plural: 'Load balancers', behaviour: 'load_balancer', kinds: [{ id: 'hardware', label: 'Hardware appliance' }, { id: 'virtual', label: 'Virtual appliance' }, OTHER] },
  {
    id: 'ids_ips',
    label: 'IDS/IPS',
    plural: 'IDS/IPS',
    behaviour: 'ids_ips',
    kinds: [{ id: 'appliance', label: 'Network appliance' }, { id: 'virtual', label: 'Virtual appliance' }, OTHER],
    modes: [
      { id: 'inline', label: 'Inline', help: 'Traffic passes through it between its paired ports; it may drop what it inspects.' },
      { id: 'passive', label: 'Passive', help: 'Receives copies of traffic (from a TAP) and forwards nothing.' },
    ],
  },
  {
    id: 'vpn_gateway',
    label: 'VPN gateway',
    plural: 'VPN gateways',
    behaviour: 'vpn_gateway',
    kinds: [{ id: 'hardware', label: 'Hardware appliance' }, { id: 'virtual', label: 'Virtual appliance' }, { id: 'remote_access', label: 'Remote-access concentrator' }, OTHER],
  },
  {
    id: 'security_gateway',
    label: 'Security gateway',
    plural: 'Security gateways',
    behaviour: 'security_gateway',
    kinds: [{ id: 'cross_domain', label: 'Cross-domain gateway' }, { id: 'red_black', label: 'Red–black gateway' }, { id: 'it_ot', label: 'IT/OT security gateway' }, OTHER],
  },
  { id: 'server', label: 'Server', plural: 'Servers', behaviour: 'host', kinds: [{ id: 'physical', label: 'Physical server' }, { id: 'appliance', label: 'Appliance' }, OTHER] },
  { id: 'vm', label: 'Virtual machine', plural: 'Virtual machines', behaviour: 'guest_vm', kinds: [{ id: 'general', label: 'General-purpose VM' }, { id: 'virtual_appliance', label: 'Virtual appliance' }, OTHER] },
  { id: 'container', label: 'Container', plural: 'Containers', behaviour: 'guest_container', kinds: [{ id: 'application', label: 'Application container' }, { id: 'infrastructure', label: 'Infrastructure container' }, OTHER] },
  { id: 'storage', label: 'Storage', plural: 'Storage', behaviour: 'host', kinds: [{ id: 'nas', label: 'NAS' }, { id: 'san', label: 'SAN array' }, { id: 'backup', label: 'Backup' }, OTHER] },
  {
    id: 'endpoint',
    label: 'Endpoint',
    plural: 'Endpoints',
    behaviour: 'endpoint',
    kinds: [
      { id: 'pc', label: 'Laptop / PC' },
      { id: 'mobile', label: 'Phone / Tablet', icon: 'mobile' },
      { id: 'printer', label: 'Printer', icon: 'printer' },
      { id: 'camera', label: 'IP camera', icon: 'camera' },
      { id: 'voip', label: 'VoIP phone', icon: 'voip' },
      { id: 'iot', label: 'IoT sensor', icon: 'iot' },
      { id: 'media', label: 'Media device', icon: 'media' },
      { id: 'plc', label: 'PLC', icon: 'plc' },
      { id: 'hmi', label: 'HMI', icon: 'hmi' },
      OTHER,
    ],
  },
  { id: 'cloud', label: 'Cloud', plural: 'Clouds', behaviour: 'cloud', kinds: [{ id: 'internet', label: 'Internet' }, { id: 'carrier', label: 'ISP / carrier' }, { id: 'mpls', label: 'MPLS / VPN service' }, { id: 'mobile', label: 'LTE / 5G mobile', icon: 'mobile_network' }, OTHER] },
  { id: 'system', label: 'System', plural: 'Systems', behaviour: 'system', kinds: [OTHER] },
];

export const DEVICE_TYPE_IDS: ReadonlyArray<string> = DEVICE_TYPES.map((t) => t.id);

/** Model value of a device without a (valid) type. */
export const NO_DEVICE_TYPE = 'generic';

export function isDeviceType(id: string): boolean {
  return DEVICE_TYPE_IDS.indexOf(id) >= 0;
}

/** The registry entry of a type (undefined: no valid type). */
export function typeDef(id: string): DeviceTypeDef | undefined {
  return DEVICE_TYPES.find((t) => t.id === id);
}

/** The kinds of a type ([] for an unknown type). */
export function kindsOf(type: string): ReadonlyArray<KindDef> {
  const t = typeDef(type);
  return t ? t.kinds : [];
}

/** The name of a device's kind ("Cloud gateway", or its own name for `other`); '' without a kind. */
export function kindLabel(d: { type: string; kind?: string; kindLabel?: string }): string {
  if (!d.kind) return '';
  if (d.kind === 'other') return d.kindLabel || '';
  const k = kindsOf(d.type).find((x) => x.id === d.kind);
  return k ? k.label : '';
}

/** The modes of a type ([] when it has none). */
export function modesOf(type: string): ReadonlyArray<ModeDef> {
  const t = typeDef(type);
  return t && t.modes ? t.modes : [];
}

/** The mode in effect: as written, else the type's first (the documented default); '' for a type without modes. */
export function modeOf(d: { type: string; mode?: string }): string {
  const ms = modesOf(d.type);
  if (!ms.length) return '';
  return d.mode && ms.some((m) => m.id === d.mode) ? d.mode : ms[0].id;
}

// ------------------------------------------------------------ roles

export interface RoleDef {
  id: string;
  label: string;
  /** its row in the physical view (Auto-arrange) */
  tier: number;
}

/** The roles NetAtlas suggests (any other text is a custom role, placed by what the device does). */
export const ROLES: ReadonlyArray<RoleDef> = [
  { id: 'border', label: 'Border / Edge', tier: 1 },
  { id: 'wan_edge', label: 'WAN edge', tier: 1 },
  { id: 'pe', label: 'PE', tier: 1 },
  { id: 'ce', label: 'CE', tier: 1 },
  { id: 'p', label: 'P', tier: 1 },
  { id: 'dmz', label: 'DMZ', tier: 2 },
  { id: 'core', label: 'Core', tier: 3 },
  { id: 'spine', label: 'Spine', tier: 3 },
  { id: 'distribution', label: 'Distribution', tier: 4 },
  { id: 'leaf', label: 'Leaf', tier: 4 },
  { id: 'access', label: 'Access', tier: 5 },
  { id: 'management', label: 'Management / OOB', tier: 6 },
];

export function roleDef(role: string | undefined): RoleDef | undefined {
  return role ? ROLES.find((r) => r.id === role) : undefined;
}

/** A role's name: a known role's label, a custom role as written. */
export function roleLabel(role: string | undefined): string {
  if (!role) return '';
  const r = roleDef(role);
  return r ? r.label : role;
}

// ------------------------------------------------------------ System purposes

export interface PurposeDef {
  id: string;
  label: string;
  help: string;
  /** its icons (the first is the default) */
  icons: ReadonlyArray<{ id: string; label: string }>;
}

/** A System's purposes: what it does is declared, never guessed from its name. */
export const SYSTEM_PURPOSES: ReadonlyArray<PurposeDef> = [
  { id: 'host', label: 'Host', help: 'Sends and receives, forwards nothing (a console server, a controller, a BMS).', icons: [{ id: 'system', label: 'System' }, { id: 'console', label: 'Console' }, { id: 'controller', label: 'Controller' }] },
  { id: 'l2_forwarder', label: 'Layer 2 forwarder', help: 'Bridges its ports, by VLAN where they have VLANs (a media converter, a radio link).', icons: [{ id: 'bridge', label: 'Bridge' }, { id: 'radio', label: 'Radio' }, { id: 'converter', label: 'Media converter' }] },
  { id: 'l3_forwarder', label: 'Layer 3 forwarder', help: 'Routes between its interfaces (a protocol gateway, a routed WAN optimizer).', icons: [{ id: 'protocol_gateway', label: 'Protocol gateway' }, { id: 'router', label: 'Router' }] },
  { id: 'inline', label: 'Inline', help: 'Passes traffic between paired ports, may delay or drop it (a WAN optimizer, a diode).', icons: [{ id: 'inline', label: 'Inline' }, { id: 'diode', label: 'Data diode' }] },
  { id: 'passive_monitor', label: 'Passive monitor', help: 'Receives copies of traffic and forwards nothing (a sensor, a monitoring probe).', icons: [{ id: 'sensor', label: 'Sensor' }] },
  { id: 'pass_through', label: 'Pass-through', help: 'Joins paired ports physically, no IP stack; may copy to monitor ports (a TAP).', icons: [{ id: 'patch', label: 'Patch panel' }, { id: 'tap', label: 'TAP' }] },
  { id: 'external_network', label: 'External network', help: 'A network outside the model, crossed as one hop (a private carrier, a partner network).', icons: [{ id: 'cloud', label: 'Cloud' }] },
];

/** Does a type say what it does by a purpose (a System)? */
export function hasPurpose(type: string): boolean {
  const t = typeDef(type);
  return !!t && t.behaviour === 'system';
}

export function purposeDef(id: string | undefined): PurposeDef | undefined {
  return id ? SYSTEM_PURPOSES.find((p) => p.id === id) : undefined;
}

// ------------------------------------------------------------ names and keys

/**
 * The key of a device in the Device types filter: its type, and for a
 * switch whether it is a Layer 2 or a Layer 3 one ("switch:l2",
 * "switch:l3"), and for a server whether it runs guests ("server:hypervisor",
 * "server:container"), so that these can be shown or hidden apart.
 */
export function typeKey(d: { type: string; layer3?: boolean; hypervisor?: unknown; containerEngine?: unknown }): string {
  if (d.type === 'switch') return d.layer3 ? 'switch:l3' : 'switch:l2';
  // a server by the service it runs guests with (one with both counts as a hypervisor)
  if (d.type === 'server' && d.hypervisor) return 'server:hypervisor';
  if (d.type === 'server' && d.containerEngine) return 'server:container';
  return d.type;
}

/** The keys a type's entry of the Device types filter may have, in the order they are listed. */
export function typeKeysOf(type: string): string[] {
  if (type === 'switch') return ['switch:l2', 'switch:l3'];
  if (type === 'server') return ['server:hypervisor', 'server:container', 'server'];
  return [type];
}

/** A sub-entry's name under its type in the Device types filter ("Layer 2", "Hypervisor"). */
export function typeKeySubLabel(key: string): string {
  const subs: Record<string, string> = { 'switch:l2': 'Layer 2', 'switch:l3': 'Layer 3', 'server:hypervisor': 'Hypervisor', 'server:container': 'Container host', server: 'Other' };
  return subs[key] || typeKeyLabel(key);
}

/** The name of a Device types key ("Server", "Layer 2 switch", "Hypervisor server"). */
export function typeKeyLabel(key: string): string {
  if (key === 'switch:l2') return 'Layer 2 switch';
  if (key === 'switch:l3') return 'Layer 3 switch';
  if (key === 'server:hypervisor') return 'Hypervisor server';
  if (key === 'server:container') return 'Container host server';
  return deviceTypeLabel(key) || key;
}

export function deviceTypeLabel(id: string): string {
  const t = typeDef(id);
  return t ? t.label : '';
}

/**
 * A type's display name inside a sentence ("… on access points and VPN gateways"): the label (or the
 * plural) in sentence case with its first word lowercased, acronyms (VPN, IDS/IPS) kept as they are.
 */
export function deviceTypeInText(id: string, plural = false): string {
  const t = typeDef(id);
  if (!t) return id;
  const words = (plural ? t.plural : t.label).split(' ');
  const acronym = (w: string): boolean => /^[A-Z0-9/]{2,}$/.test(w.replace(/[^A-Za-z0-9/]/g, ''));
  return words.map((w, i) => (i === 0 && !acronym(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w)).join(' ');
}

/**
 * Second line of a device box: the display name of its type ("Layer 2
 * switch" / "Layer 3 switch" for a switch, the mode where it matters),
 * then its kind ("Router · Cloud gateway").
 */
export function deviceSubtitle(type: string, layer3?: boolean, extra?: { kind?: string; kindLabel?: string; mode?: string; purpose?: string }): string {
  let t = deviceTypeLabel(type);
  if (type === 'switch') t = layer3 ? 'Layer 3 switch' : 'Layer 2 switch';
  else if (type === 'vm' && layer3) t = 'Virtual machine · Layer 3';
  const x = extra || {};
  const parts = [t];
  if (x.mode !== undefined && modesOf(type).length > 1 && x.mode !== modesOf(type)[0].id) {
    const m = modesOf(type).find((y) => y.id === x.mode);
    if (m) parts.push(m.label);
  }
  if (type === 'system' && x.purpose) {
    const p = purposeDef(x.purpose);
    if (p) parts.push(p.label);
  }
  const k = kindLabel({ type, kind: x.kind, kindLabel: x.kindLabel });
  if (k && k !== t) parts.push(k);
  return parts.join(' · ');
}

/** A device's line under its name: its type (with the switch's layer), its mode, a System's purpose and its kind ("Firewall · Transparent · NGFW"). */
export function deviceTypeLine(d: { type: string; layer3?: boolean; kind?: string; kindLabel?: string; mode?: string; purpose?: string }): string {
  return deviceSubtitle(d.type, d.layer3, { kind: d.kind, kindLabel: d.kindLabel, mode: d.mode, purpose: d.purpose });
}

/** The type's name for a device, with the switch's layer ("Layer 3 switch"). */
export function deviceKindLabel(d: { type: string; layer3?: boolean }): string {
  return deviceTypeLine(d);
}

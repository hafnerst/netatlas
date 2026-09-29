import { Category, LineStyle, ProtocolDef } from './model';

/**
 * Built-in protocol registry. This is a convenience, not a whitelist: any
 * protocol name is accepted in the input. Unknown protocols get the category
 * given on the relation (or "other") and a deterministic color. Input files
 * can add or override entries via the top-level `protocols:` section.
 */
type Builtin = [id: string, label: string, category: Category, color: string, aliases?: string[]];

const BUILTINS: Builtin[] = [
  // tunnels / encapsulations
  ['gre', 'GRE', 'tunnel', '#e8590c', ['mgre', 'gretap']],
  ['ipsec', 'IPsec', 'tunnel', '#7048e8', ['ikev2', 'ike']],
  ['ipip', 'IP-in-IP', 'tunnel', '#c2255c', ['ip-in-ip']],
  ['wireguard', 'WireGuard', 'tunnel', '#88171a', ['wg']],
  ['openvpn', 'OpenVPN', 'tunnel', '#e67700'],
  ['l2tp', 'L2TP', 'tunnel', '#5f3dc4', ['l2tpv3']],
  ['dmvpn', 'DMVPN', 'tunnel', '#9c36b5'],
  ['gtp', 'GTP', 'tunnel', '#a61e4d', ['gtp-u']],
  ['rsvp-te', 'RSVP-TE LSP', 'tunnel', '#364fc7', ['mpls-te', 'te-tunnel']],
  ['sr-te', 'SR-TE policy', 'tunnel', '#1864ab', ['sr-policy']],
  ['pseudowire', 'Pseudowire', 'tunnel', '#0b7285', ['pw', 'vpws']],
  ['ssl-vpn', 'SSL VPN', 'tunnel', '#d6336c'],
  // overlays
  ['vxlan', 'VXLAN', 'overlay', '#0c8599'],
  ['geneve', 'Geneve', 'overlay', '#099268'],
  ['evpn', 'EVPN', 'overlay', '#1098ad', ['bgp-evpn']],
  ['l3vpn', 'MPLS L3VPN', 'overlay', '#3b5bdb', ['mpls-l3vpn', 'vrf-lite']],
  ['vpls', 'VPLS', 'overlay', '#4263eb'],
  ['sd-wan', 'SD-WAN', 'overlay', '#ae3ec9', ['sdwan']],
  ['otv', 'OTV', 'overlay', '#15aabf'],
  // routing / control-plane adjacencies
  ['bgp', 'BGP', 'adjacency', '#1971c2', ['ebgp', 'ibgp', 'mp-bgp']],
  ['ospf', 'OSPF', 'adjacency', '#2f9e44', ['ospfv2', 'ospfv3']],
  ['isis', 'IS-IS', 'adjacency', '#5c940d', ['is-is']],
  ['eigrp', 'EIGRP', 'adjacency', '#087f5b'],
  ['rip', 'RIP', 'adjacency', '#74b816', ['ripng']],
  ['ldp', 'LDP', 'adjacency', '#495057'],
  ['pim', 'PIM', 'adjacency', '#d9480f'],
  ['bfd', 'BFD', 'adjacency', '#868e96'],
  ['static', 'Static route', 'adjacency', '#343a40'],
  // redundancy / bundling
  ['lacp', 'LACP / LAG', 'redundancy', '#f08c00', ['lag', 'port-channel', 'etherchannel']],
  ['mlag', 'MLAG / vPC', 'redundancy', '#f59f00', ['vpc', 'mc-lag']],
  ['vrrp', 'VRRP', 'redundancy', '#e64980'],
  ['hsrp', 'HSRP', 'redundancy', '#d6336c'],
  ['glbp', 'GLBP', 'redundancy', '#c2255c'],
  ['carp', 'CARP', 'redundancy', '#a61e4d'],
  ['ha-sync', 'HA sync', 'redundancy', '#fd7e14', ['ha', 'cluster']],
  // services
  ['dns', 'DNS', 'service', '#6741d9'],
  ['ntp', 'NTP', 'service', '#5f3dc4'],
  ['syslog', 'Syslog', 'service', '#7950f2'],
  ['snmp', 'SNMP', 'service', '#845ef7'],
  ['radius', 'RADIUS', 'service', '#9775fa', ['tacacs', 'tacacs+']],
  ['dhcp', 'DHCP relay', 'service', '#6c5ce7', ['dhcp-relay']],
  ['https', 'HTTPS', 'service', '#1c7ed6', ['http']],
  ['netflow', 'NetFlow / IPFIX', 'service', '#4c6ef5', ['ipfix', 'sflow']],
];

export const DEFAULT_STYLE: { [c in Category]: LineStyle } = {
  tunnel: 'tube',
  adjacency: 'solid',
  overlay: 'dashed',
  redundancy: 'dotted',
  service: 'dashdot',
  other: 'dashdot',
};

export function builtinProtocols(): Map<string, ProtocolDef> {
  const m = new Map<string, ProtocolDef>();
  for (const [id, label, category, color] of BUILTINS) {
    m.set(id, { id, label, category, color, style: DEFAULT_STYLE[category], custom: false });
  }
  return m;
}

const ALIASES = new Map<string, string>();
for (const b of BUILTINS) for (const a of b[4] || []) ALIASES.set(a, b[0]);

/** Canonical registry key for a protocol name ("eBGP" -> "bgp" only via aliases, never silently otherwise). */
export function normalizeProtocol(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Look up the definition for a protocol name. Exact match wins (so a user
 * definition of "ebgp" overrides the alias to "bgp"); then aliases; then a
 * generated definition for unknown protocols.
 */
export function lookupProtocol(
  registry: Map<string, ProtocolDef>,
  name: string,
  fallbackCategory?: Category,
): ProtocolDef {
  const key = normalizeProtocol(name);
  const exact = registry.get(key);
  if (exact) return exact;
  const alias = ALIASES.get(key);
  if (alias && registry.has(alias)) {
    const base = registry.get(alias) as ProtocolDef;
    return { ...base, id: key, label: aliasLabel(key, base.label) };
  }
  const category = fallbackCategory || 'other';
  return {
    id: key,
    label: name.trim().toUpperCase().length <= 5 ? name.trim().toUpperCase() : name.trim(),
    category,
    color: hashColor(key),
    style: DEFAULT_STYLE[category],
    custom: false,
  };
}

function aliasLabel(alias: string, baseLabel: string): string {
  const special: { [k: string]: string } = { ebgp: 'eBGP', ibgp: 'iBGP', 'mp-bgp': 'MP-BGP', ospfv3: 'OSPFv3', ospfv2: 'OSPFv2' };
  return special[alias] || (alias.length <= 6 ? alias.toUpperCase() : baseLabel);
}

/** Deterministic, readable color for an unknown protocol name. */
export function hashColor(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return hslToHex(hue, 0.62, 0.42);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
}

export const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

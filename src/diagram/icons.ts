import { VNode, h } from './scene';
import { kindsOf, purposeDef } from '../model/device-types';

/** Simple built-in line-art glyphs (24×24 design grid); no external icon library. */
const GLYPHS: { [name: string]: Array<[string, { [k: string]: string | number }]> } = {
  router: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['path', { d: 'M6 9.5h8M12 7.5l2 2-2 2M18 14.5h-8M12 12.5l-2 2 2 2' }],
  ],
  switch: [
    ['rect', { x: 2, y: 6, width: 20, height: 12, rx: 2 }],
    ['path', { d: 'M6 10h10M14 8l2 2-2 2M18 14H8M10 12l-2 2 2 2' }],
  ],
  // a Layer 3 switch: the switch's box with a router's circle in it (a Layer 2 switch keeps the plain switch glyph)
  'switch-l3': [
    ['rect', { x: 2, y: 6, width: 20, height: 12, rx: 2 }],
    ['circle', { cx: 12, cy: 12, r: 3.4 }],
    ['path', { d: 'M4.5 12h4.1M15.4 12h4.1M12 8.6V7M12 15.4V17' }],
  ],
  firewall: [
    ['rect', { x: 2, y: 4, width: 20, height: 16, rx: 1 }],
    ['path', { d: 'M2 9.3h20M2 14.6h20M8 4v5.3M16 4v5.3M12 9.3v5.3M6 14.6V20M18 14.6V20' }],
  ],
  server: [
    ['rect', { x: 4, y: 3, width: 16, height: 7.5, rx: 1.5 }],
    ['rect', { x: 4, y: 13.5, width: 16, height: 7.5, rx: 1.5 }],
    ['path', { d: 'M7.5 6.75h.01M7.5 17.25h.01M11 6.75h6M11 17.25h6' }],
  ],
  vm: [
    ['rect', { x: 3, y: 3.5, width: 18, height: 17, rx: 2 }],
    ['path', { d: 'M3 8h18M7 12l3 2.5-3 2.5M12 17.5h5' }],
  ],
  container: [['path', { d: 'M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5zM3.5 7.25L12 12l8.5-4.75M12 12v9.5' }]],
  system: [
    ['rect', { x: 2.5, y: 3, width: 19, height: 18, rx: 2 }],
    ['rect', { x: 5.5, y: 6, width: 5.5, height: 5 }],
    ['rect', { x: 13, y: 6, width: 5.5, height: 5 }],
    ['rect', { x: 5.5, y: 13, width: 5.5, height: 5 }],
    ['rect', { x: 13, y: 13, width: 5.5, height: 5 }],
  ],
  cloud: [['path', { d: 'M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6.5 6.5 0 0 0 5.6 9.7 4.7 4.7 0 0 0 7 19z' }]],
  ap: [
    ['path', { d: 'M4.5 10a10.6 10.6 0 0 1 15 0M7.5 13a6.4 6.4 0 0 1 9 0M10.5 16a2.2 2.2 0 0 1 3 0' }],
    ['circle', { cx: 12, cy: 19, r: 1.2 }],
  ],
  storage: [
    ['ellipse', { cx: 12, cy: 5.5, rx: 8, ry: 3 }],
    ['path', { d: 'M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3' }],
  ],
  load_balancer: [
    ['circle', { cx: 5, cy: 12, r: 2.5 }],
    ['path', { d: 'M7.5 12h4M11.5 12l7-6.5M11.5 12l7 6.5M11.5 12h7M16.5 4.5l2 1-1 2M16.5 19.5l2-1-1-2M17 10l2 2-2 2' }],
  ],
  ids_ips: [
    ['path', { d: 'M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6zM6.5 12s2-3.2 5.5-3.2 5.5 3.2 5.5 3.2-2 3.2-5.5 3.2-5.5-3.2-5.5-3.2z' }],
    ['circle', { cx: 12, cy: 12, r: 1.3 }],
  ],
  // a VPN gateway: a padlock between the two ends of a tunnel
  vpn_gateway: [
    ['rect', { x: 6, y: 11, width: 12, height: 9, rx: 1.5 }],
    ['path', { d: 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.5v2M1.5 15.5h4.5M18 15.5h4.5' }],
  ],
  // a Security gateway: two domains on either side of a boundary (a double wall); transfers pass the boundary one way
  security_gateway: [
    ['rect', { x: 1.5, y: 6, width: 6, height: 12, rx: 1 }],
    ['rect', { x: 16.5, y: 6, width: 6, height: 12, rx: 1 }],
    ['path', { d: 'M10.5 2.5v19M13.5 2.5v19M7.5 12h9M14.5 10l2 2-2 2' }],
  ],
  endpoint: [
    ['rect', { x: 2.5, y: 4, width: 19, height: 12.5, rx: 1.5 }],
    ['path', { d: 'M8.5 20.5h7M12 16.5v4' }],
  ],
  // kinds' variants
  cloud_gateway: [
    ['path', { d: 'M7 13.5h10a3.5 3.5 0 0 0 .5-6.97A5 5 0 0 0 7.8 6.1 3.6 3.6 0 0 0 7 13.5z' }],
    ['path', { d: 'M12 13.5v8M9.5 19 12 21.5l2.5-2.5' }],
  ],
  mobile: [
    ['rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2 }],
    ['path', { d: 'M11 18.5h2' }],
  ],
  printer: [
    ['path', { d: 'M7 9V3.5h10V9M7 17.5H4.5A1.5 1.5 0 0 1 3 16v-5.5A1.5 1.5 0 0 1 4.5 9h15a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5H17' }],
    ['rect', { x: 7, y: 14, width: 10, height: 6.5 }],
  ],
  camera: [
    ['rect', { x: 2, y: 7, width: 13, height: 10, rx: 1.5 }],
    ['path', { d: 'M15 10.5l6.5-3.5v10L15 13.5' }],
    ['circle', { cx: 8.5, cy: 12, r: 2.5 }],
  ],
  voip: [
    ['path', { d: 'M6 3.5h3l1.2 4-2 1.3a10 10 0 0 0 4 4l1.3-2 4 1.2v3a1.5 1.5 0 0 1-1.6 1.5C9.5 16 4.5 11 4.5 5.1A1.5 1.5 0 0 1 6 3.5z' }],
    ['path', { d: 'M15 3.5a5.5 5.5 0 0 1 5.5 5.5M15 6.5A2.5 2.5 0 0 1 17.5 9' }],
  ],
  iot: [
    ['rect', { x: 7, y: 10, width: 10, height: 10, rx: 1.5 }],
    ['path', { d: 'M12 10V6.5M9.3 4.5a3.8 3.8 0 0 1 5.4 0M10 15h4M4.5 13h2.5M4.5 17h2.5M17 13h2.5M17 17h2.5' }],
  ],
  media: [
    ['rect', { x: 2.5, y: 4.5, width: 19, height: 13, rx: 1.5 }],
    ['path', { d: 'M10 8v6l5-3zM8 20.5h8' }],
  ],
  plc: [
    ['rect', { x: 4, y: 3, width: 16, height: 18, rx: 1 }],
    ['path', { d: 'M4 7.5h16M4 16.5h16M7.5 10.5h3v3h-3zM13.5 10.5h3v3h-3zM7 19h1M10 19h1M13 19h1M16 19h1' }],
  ],
  hmi: [
    ['rect', { x: 2.5, y: 3.5, width: 19, height: 13, rx: 1.5 }],
    ['rect', { x: 5, y: 6, width: 9, height: 8 }],
    ['path', { d: 'M17 7.5h2M17 10.5h2M17 13.5h2M8 20.5h8M12 16.5v4' }],
  ],
  mobile_network: [
    ['path', { d: 'M12 10.5v11M8.5 21.5 12 10.5l3.5 11M9.6 17h4.8M7 6a7 7 0 0 1 10 0M9.1 8.1a4 4 0 0 1 5.8 0' }],
    ['circle', { cx: 12, cy: 10.5, r: 1 }],
  ],
  // a System's icons, by purpose
  console: [
    ['rect', { x: 2.5, y: 3, width: 19, height: 11, rx: 1.5 }],
    ['path', { d: 'M6 6.5l2.5 2-2.5 2M10.5 10.5h4M4 18.5h3M9 18.5h3M14 18.5h3M19 18.5h1.5' }],
  ],
  controller: [
    ['circle', { cx: 12, cy: 6.5, r: 3.5 }],
    ['path', { d: 'M12 10v4.5M5 20.5v-6h14v6M12 14.5v6M3.5 20.5h3M10.5 20.5h3M17.5 20.5h3' }],
  ],
  bridge: [
    ['rect', { x: 2, y: 8, width: 20, height: 8, rx: 2 }],
    ['path', { d: 'M6 12h12M8 10l-2 2 2 2M16 10l2 2-2 2' }],
  ],
  radio: [
    ['path', { d: 'M12 10v11.5M8.5 21.5h7M8.6 6.6a4.8 4.8 0 0 0 0 6.8M15.4 6.6a4.8 4.8 0 0 1 0 6.8M5.8 3.8a8.8 8.8 0 0 0 0 12.4M18.2 3.8a8.8 8.8 0 0 1 0 12.4' }],
    ['circle', { cx: 12, cy: 10, r: 1.3 }],
  ],
  converter: [
    ['rect', { x: 6, y: 7, width: 12, height: 10, rx: 1.5 }],
    ['path', { d: 'M1.5 12H6M18 12h4.5M2.5 10h2v4h-2M10 12h4M12.5 10.5 14 12l-1.5 1.5' }],
  ],
  protocol_gateway: [
    ['rect', { x: 2.5, y: 3.5, width: 8, height: 6, rx: 1 }],
    ['rect', { x: 13.5, y: 14.5, width: 8, height: 6, rx: 1 }],
    ['path', { d: 'M10.5 6.5h5a2 2 0 0 1 2 2v6M15.5 12.5l2 2 2-2M13.5 17.5h-5a2 2 0 0 1-2-2v-6M8.5 11.5l-2-2-2 2' }],
  ],
  inline: [
    ['rect', { x: 7, y: 6, width: 10, height: 12, rx: 1.5 }],
    ['path', { d: 'M1.5 12H7M17 12h5.5M20 9.5l2.5 2.5-2.5 2.5M10 12h4' }],
  ],
  diode: [['path', { d: 'M2 12h6M16 12h6M8 6v12l8-6zM16 6v12' }]],
  sensor: [
    ['circle', { cx: 10, cy: 10, r: 6.5 }],
    ['path', { d: 'M15 15l6 6M6.5 10h1.5l1-2.5 2 5 1-2.5h1.5' }],
  ],
  patch: [
    ['rect', { x: 2, y: 7, width: 20, height: 10, rx: 1 }],
    ['path', { d: 'M4.5 10.5h3v3h-3zM9 10.5h3v3H9zM13.5 10.5h3v3h-3zM18 10.5h1.5v3H18' }],
  ],
  tap: [
    ['rect', { x: 8, y: 5, width: 8, height: 6, rx: 1 }],
    ['path', { d: 'M1.5 8h20M12 11v9M9.5 17.5 12 20l2.5-2.5' }],
  ],
  generic: [
    ['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4 }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
};

/** Glyph name for a device type; devices without a valid type get the generic glyph; a Layer 3 switch its own variant. */
export function iconName(type: string, layer3?: boolean): string {
  if (type === 'switch' && layer3) return 'switch-l3';
  return type !== 'generic' && type !== 'switch-l3' && Object.prototype.hasOwnProperty.call(GLYPHS, type) ? type : 'generic';
}

/**
 * A device's glyph: a System's chosen icon (else its purpose's first), the
 * variant of its kind (a PLC, a camera, a Cloud gateway), else its type's.
 */
export function glyphFor(d: { type: string; layer3?: boolean; kind?: string; icon?: string; purpose?: string }): string {
  const has = (n: string | undefined): n is string => !!n && Object.prototype.hasOwnProperty.call(GLYPHS, n);
  if (d.type === 'system') {
    if (has(d.icon)) return d.icon;
    const p = purposeDef(d.purpose);
    if (p && has(p.icons[0].id)) return p.icons[0].id;
  }
  const k = d.kind ? kindsOf(d.type).find((x) => x.id === d.kind) : undefined;
  if (k && has(k.icon)) return k.icon;
  return iconName(d.type, d.layer3);
}

/** Every glyph a System of a purpose may have (in its picker), with its label. */
export function purposeIcons(purpose: string | undefined): ReadonlyArray<{ id: string; label: string }> {
  const p = purposeDef(purpose);
  return p ? p.icons.filter((x) => Object.prototype.hasOwnProperty.call(GLYPHS, x.id)) : [];
}

export const ICON_NAMES = Object.keys(GLYPHS);

/** Glyph for a device type (or a glyph by its name, from glyphFor), scaled to `size` px with its top-left at (x, y). */
export function deviceIcon(type: string, x: number, y: number, size: number, layer3?: boolean): VNode {
  const name = type === 'switch-l3' || (Object.prototype.hasOwnProperty.call(GLYPHS, type) && type !== 'switch') ? type : iconName(type, layer3);
  const s = size / 24;
  return h(
    'g',
    { class: 'icon icon-' + name, transform: `translate(${x} ${y}) scale(${Math.round(s * 1000) / 1000})` },
    GLYPHS[name].map(([tag, attrs]) => h(tag, attrs)),
  );
}

/** Width of a server's service badge ("DHCP", "DNS"): the icon's column. */
export const SVC_BADGE_W = 26;

/**
 * A server's network service as a badge ("DHCP" over the icon's upper part,
 * "DNS" over its lower part), in the icon's column (never near the label or
 * an address); its long form is the tooltip. Text and frame carry it.
 */
export function serviceBadge(svc: 'dhcp' | 'dns', x: number, y: number): VNode {
  const text = svc === 'dhcp' ? 'DHCP' : 'DNS';
  return h('g', { class: 'dev-badge svc-' + svc }, [
    h('title', {}, svc === 'dhcp' ? 'DHCP server: leases addresses to the clients of its scopes' : 'DNS server: answers queries for its zones'),
    h('rect', { x, y, width: SVC_BADGE_W, height: BADGE_H, rx: 3 }),
    h('text', { x: x + SVC_BADGE_W / 2, y: y + BADGE_H - 3, 'text-anchor': 'middle' }, text),
  ]);
}

/** Width and height of a switch's layer badge ("L2" / "L3"). */
export const BADGE_W = 19;
export const BADGE_H = 12;

/**
 * A switch's layer as a badge: "L2" or "L3" in a small framed box, with the
 * long form as its tooltip. Drawn over the lower right corner of the icon,
 * inside the icon's column, so it never touches the label or an address.
 * Text and frame, not colour, carry the meaning.
 */
export function layerBadge(layer3: boolean, x: number, y: number): VNode {
  const text = layer3 ? 'L3' : 'L2';
  return h('g', { class: 'dev-badge ' + (layer3 ? 'l3' : 'l2') }, [
    h('title', {}, layer3 ? 'Layer 3 switch: routes between its VLANs and subnets' : 'Layer 2 switch: forwards frames, routes nothing'),
    h('rect', { x, y, width: BADGE_W, height: BADGE_H, rx: 3 }),
    h('text', { x: x + BADGE_W / 2, y: y + BADGE_H - 3, 'text-anchor': 'middle' }, text),
  ]);
}

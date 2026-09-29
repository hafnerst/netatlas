import { VNode, h } from './scene';

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
  l3switch: [
    ['rect', { x: 2, y: 6, width: 20, height: 12, rx: 2 }],
    ['path', { d: 'M6 10h10M14 8l2 2-2 2M18 14H8M10 12l-2 2 2 2M12 2v4M12 18v4' }],
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
  hypervisor: [
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
  loadbalancer: [
    ['circle', { cx: 5, cy: 12, r: 2.5 }],
    ['path', { d: 'M7.5 12h4M11.5 12l7-6.5M11.5 12l7 6.5M11.5 12h7M16.5 4.5l2 1-1 2M16.5 19.5l2-1-1-2M17 10l2 2-2 2' }],
  ],
  host: [
    ['rect', { x: 2.5, y: 4, width: 19, height: 12.5, rx: 1.5 }],
    ['path', { d: 'M8.5 20.5h7M12 16.5v4' }],
  ],
  generic: [
    ['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4 }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
};

const ALIASES: { [type: string]: string } = {
  gateway: 'router',
  pe: 'router',
  ce: 'router',
  vpn: 'router',
  bng: 'router',
  sdwan: 'router',
  'sd-wan': 'router',
  l2switch: 'switch',
  leaf: 'switch',
  spine: 'l3switch',
  tor: 'switch',
  access: 'switch',
  multilayer: 'l3switch',
  core: 'l3switch',
  fw: 'firewall',
  ngfw: 'firewall',
  utm: 'firewall',
  waf: 'firewall',
  ids: 'firewall',
  ips: 'firewall',
  internet: 'cloud',
  wan: 'cloud',
  isp: 'cloud',
  provider: 'cloud',
  wireless: 'ap',
  accesspoint: 'ap',
  wlc: 'ap',
  vm: 'hypervisor',
  container: 'hypervisor',
  nas: 'storage',
  san: 'storage',
  lb: 'loadbalancer',
  adc: 'loadbalancer',
  pc: 'host',
  workstation: 'host',
  laptop: 'host',
  client: 'host',
};

export function iconName(type: string): string {
  const t = type.toLowerCase();
  if (GLYPHS[t]) return t;
  return ALIASES[t] || 'generic';
}

export const ICON_NAMES = Object.keys(GLYPHS);

/** Glyph for a device type, scaled to `size` px with its top-left at (x, y). */
export function deviceIcon(type: string, x: number, y: number, size: number): VNode {
  const name = iconName(type);
  const s = size / 24;
  return h(
    'g',
    { class: 'icon icon-' + name, transform: `translate(${x} ${y}) scale(${Math.round(s * 1000) / 1000})` },
    GLYPHS[name].map(([tag, attrs]) => h(tag, attrs)),
  );
}

/** Visual vocabulary shared by renderers and the legend. */
import { hashColor } from '../model/protocols';

export interface MediumStyle {
  key: string;
  label: string;
  color: string;
  dash?: string;
}

const MEDIA: Array<[string[], MediumStyle]> = [
  [['fiber', 'fibre', 'smf', 'mmf', 'optical', 'sfp', 'qsfp'], { key: 'fiber', label: 'Fiber', color: '#e67700' }],
  [['copper', 'utp', 'stp', 'cat5', 'cat5e', 'cat6', 'cat6a', 'rj45', 'ethernet'], { key: 'copper', label: 'Copper', color: '#1c7ed6' }],
  [['dac', 'twinax'], { key: 'dac', label: 'DAC / twinax', color: '#0b7285' }],
  [['aoc'], { key: 'aoc', label: 'AOC', color: '#d9480f' }],
  [['wireless', 'wifi', 'radio', 'microwave', 'lte', '4g', '5g', 'satellite'], { key: 'wireless', label: 'Wireless / radio', color: '#862e9c', dash: '7 4' }],
  [['serial', 't1', 'e1'], { key: 'serial', label: 'Serial', color: '#5c940d', dash: '2 3' }],
  [['virtual', 'vswitch', 'internal'], { key: 'virtual', label: 'Virtual', color: '#868e96', dash: '4 4' }],
  [['unspecified'], { key: 'unspecified', label: 'Unspecified', color: '#495057' }],
];

export function mediumStyle(medium: string): MediumStyle {
  const m = medium.toLowerCase();
  for (const [names, st] of MEDIA) if (names.indexOf(m) >= 0) return st;
  return { key: m, label: medium, color: hashColor('medium:' + m) };
}

/** Parse "10G", "100M", "1 Gbps", "400GbE" into bits per second. */
export function parseSpeed(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgGtT]?)(?:b(?:ps|it\/s|e)?|bps)?\s*$/i.exec(s.replace(/gbe$/i, 'G'));
  if (!m) return null;
  const mult: { [k: string]: number } = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return parseFloat(m[1]) * mult[m[2].toLowerCase()];
}

export function speedWidth(speed: string | undefined): number {
  const bps = parseSpeed(speed);
  if (!bps) return 2;
  return 1.4 + Math.max(0, Math.min(3.8, Math.log10(bps / 1e8))) * 0.95;
}

/** Fill colors for network kinds in the logical view. */
export function networkColor(kind: string): string {
  const k = kind.toLowerCase();
  const table: { [k: string]: string } = {
    subnet: '#1c7ed6',
    vlan: '#2f9e44',
    vni: '#0c8599',
    vrf: '#7048e8',
    zone: '#e8590c',
    segment: '#1098ad',
    'l2-domain': '#2b8a3e',
  };
  return table[k] || hashColor('net:' + k);
}

export function groupKindStyle(kind: string): { dash?: string; strong: boolean } {
  const k = kind.toLowerCase();
  if (k === 'site' || k === 'region' || k === 'campus' || k === 'datacenter' || k === 'building') return { strong: true };
  if (k === 'provider' || k === 'cloud' || k === 'external') return { dash: '6 4', strong: false };
  return { strong: false };
}

/**
 * Sizes of diagram elements, derived from their text. Shared by the layout
 * (which needs the sizes to space things) and the renderers (which draw the
 * same lines at the same sizes), so what Auto-arrange reserves is what gets
 * drawn. Every element grows to fit its full text; nothing is shortened.
 */
import { TextBlock, lineHeight, textBlock, textWidth } from './text';

export const HUB_R = 12;
export const CHIP_H = 16;

// ------------------------------------------------------------------ devices

export const DEVICE_LABEL_SIZE = 13;
export const DEVICE_SUB_SIZE = 10.5;
/** widest line of a device label or subtitle; longer text wraps */
export const DEVICE_TEXT_MAX_W = 220;
export const DEVICE_ICON = 26;
/** left padding + icon + gap: where the text starts */
export const DEVICE_TEXT_X = 12 + DEVICE_ICON + 10;
const DEVICE_PAD_R = 14;
const DEVICE_PAD_Y = 10;
/** gap between label and subtitle */
const DEVICE_SUB_GAP = 2;

export interface DeviceBody {
  label: TextBlock;
  sub: TextBlock;
  /** height of label + subtitle */
  textH: number;
  w: number;
  h: number;
}

/** The device box for its text: label and subtitle wrapped, the box grown around them. */
export function deviceBody(label: string, sub: string, minW: number, minH: number): DeviceBody {
  const l = textBlock(label, DEVICE_LABEL_SIZE, DEVICE_TEXT_MAX_W);
  const s = textBlock(sub, DEVICE_SUB_SIZE, DEVICE_TEXT_MAX_W);
  const textH = l.h + (s.lines.length ? s.h + DEVICE_SUB_GAP : 0);
  return {
    label: l,
    sub: s,
    textH,
    w: Math.max(minW, Math.ceil(DEVICE_TEXT_X + Math.max(l.w, s.w) + DEVICE_PAD_R)),
    h: Math.max(minH, textH + 2 * DEVICE_PAD_Y),
  };
}

export const LOGICAL_DEVICE_MIN_W = 140;
export const LOGICAL_DEVICE_MIN_H = 50;
export const CHIP_FONT = 9.5;

/** Chips use a monospace font. */
export function chipTextWidth(s: string): number {
  return s.length * CHIP_FONT * 0.62;
}

/** Text of a loopback chip: id, first address, number of further addresses. */
export function loopbackChipText(id: string, addresses: string[]): string {
  return id + '  ' + (addresses[0] || '(no address)') + (addresses.length > 1 ? ' +' + (addresses.length - 1) : '');
}

/** Number of chip rows below the device box: one per loopback (every one is shown). */
export function chipRows(loopbackCount: number): number {
  return loopbackCount;
}

/** DNS names shown under a device in the logical view; more are summed up in a "+N more names" row */
export const MAX_DNS = 2;
/** a DNS name longer than this many characters continues on a further line, broken after a dot */
export const DNS_LINE_CHARS = 30;

/** The lines a DNS name is written on: whole when it is short, else broken after dots (never shortened). */
export function dnsNameLines(name: string): string[] {
  if (name.length <= DNS_LINE_CHARS) return [name];
  const lines: string[] = [];
  let cur = '';
  // the labels of the name, each with the dot that ends it
  for (const part of name.match(/[^.]*\.|[^.]+$/g) || [name]) {
    if (cur && cur.length + part.length > DNS_LINE_CHARS) {
      lines.push(cur);
      cur = '';
    }
    cur += part;
    // a single label longer than a line is broken where it has to be
    while (cur.length > DNS_LINE_CHARS) {
      lines.push(cur.slice(0, DNS_LINE_CHARS));
      cur = cur.slice(DNS_LINE_CHARS);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The DNS names of a device as the logical view shows them: each name once
 * (however many interfaces it belongs to), in a fixed order, at most
 * MAX_DNS of them, and how many more there are.
 */
export function dnsShown(names: string[]): { names: string[]; more: number } {
  const all = Array.from(new Set(names)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { names: all.slice(0, MAX_DNS), more: Math.max(0, all.length - MAX_DNS) };
}

/** Rows (of CHIP_H) and width the DNS names of a device take under it. */
export function dnsSize(names: string[]): { rows: number; w: number } {
  const s = dnsShown(names);
  let rows = s.more ? 1 : 0;
  let w = 0;
  for (const n of s.names) {
    const lines = dnsNameLines(n);
    rows += lines.length;
    for (const l of lines) w = Math.max(w, Math.ceil(chipTextWidth(l)));
  }
  return { rows, w };
}

/**
 * A device in the logical view: its body, plus what hangs under it: a row per
 * loopback, the chips of its other logical interfaces (virtual, tunnel) and
 * its DNS names. The node is as wide as its widest row needs.
 */
export function logicalDeviceSize(label: string, sub: string, chipW: number, loopbackCount: number, dnsNames: string[] = [], logicalIds: string[] = []): { w: number; h: number; bodyH: number } {
  const body = deviceBody(label, sub, LOGICAL_DEVICE_MIN_W, LOGICAL_DEVICE_MIN_H);
  const dns = dnsSize(dnsNames);
  const rows = chipRows(loopbackCount) + dns.rows;
  const need = Math.max(chipW, dns.w);
  let w = Math.max(body.w, need ? need + 16 + 12 : 0);
  const flow = logicalChipFlow(logicalIds, w);
  w = Math.max(w, flow.w + 16);
  const under = (rows ? rows * CHIP_H : 0) + (flow.items.length ? flow.h + IFCHIP_GAP : 0);
  return { w, h: body.h + (under ? under + 6 : 0), bodyH: body.h };
}

/** The chips of a logical-view device's virtual and tunnel interfaces, for a node `w` wide. */
export function logicalChipFlow(ids: string[], w: number): ChipFlow {
  return chipFlow(ids, Math.max(60, w - 16));
}

// ----------------------------------------------------------------- networks

export const NET_LABEL_SIZE = 12;
export const NET_SUB_SIZE = 10;
export const NET_TEXT_MAX_W = 210;

export interface NetworkBody {
  label: TextBlock;
  sub: TextBlock;
  w: number;
  h: number;
}

export function networkBody(label: string, sub: string): NetworkBody {
  const l = textBlock(label, NET_LABEL_SIZE, NET_TEXT_MAX_W);
  const s = textBlock(sub, NET_SUB_SIZE, NET_TEXT_MAX_W);
  return { label: l, sub: s, w: Math.max(120, Math.ceil(Math.max(l.w, s.w) + 36)), h: Math.max(32, l.h + s.h + 14) };
}

/** Second line of a network: its VLAN and all of its prefixes (in a fixed order). */
export function networkSubtitle(cidr: string | undefined, vlan?: number): string {
  const parts: string[] = [];
  if (vlan !== undefined) parts.push('VLAN ' + vlan);
  if (cidr) parts.push(cidr);
  return parts.join(' · ');
}

// ------------------------------------------------------------------- groups

export const GROUP_PAD = 26;
export const GROUP_TITLE_SIZE = 13;
export const GROUP_KIND_SIZE = 9.5;

export interface GroupHeader {
  title: TextBlock;
  kind: string;
  /** height of the title area above the group's content */
  h: number;
  /** the group box must be at least this wide for its title and kind */
  minW: number;
}

/**
 * Title area of a group box whose content is `innerW` wide. The title wraps
 * at the width the content gives it (at least 260), and the kind keeps its
 * place at the right of the first line.
 */
export function groupHeader(label: string, kind: string, innerW: number): GroupHeader {
  const kindText = kind.toUpperCase();
  const kindW = kindText ? textWidth(kindText, GROUP_KIND_SIZE) * 1.1 + 18 : 0;
  const boxW = innerW + 2 * GROUP_PAD;
  const avail = Math.max(260, boxW - 28 - kindW);
  const title = textBlock(label, GROUP_TITLE_SIZE, avail);
  return { title, kind: kindText, h: Math.max(30, title.h + 14), minW: Math.ceil(title.w + 28 + kindW) };
}

// ------------------------------------------------------------------- labels

export const PILL_SIZE = 10;
export const PILL_MAX_W = 240;

/** A relation label ("pill"): its wrapped text and outer size. */
export function pillBox(text: string): { block: TextBlock; w: number; h: number } {
  const block = textBlock(text, PILL_SIZE, PILL_MAX_W);
  return { block, w: Math.ceil(block.w + 16), h: Math.max(18, block.h + 6) };
}

export const LINK_LABEL_SIZE = 10.5;
export const LINK_LABEL_MAX_W = 190;

export function linkLabelBox(text: string): { block: TextBlock; w: number; h: number } {
  const block = textBlock(text, LINK_LABEL_SIZE, LINK_LABEL_MAX_W);
  return { block, w: Math.ceil(block.w + 8), h: block.h + 2 };
}

export const MEMBER_LABEL_SIZE = 10;

export { lineHeight };

// ---------------------------------------------------------- interface chips

/**
 * Interfaces that have no line of their own in a view are drawn as small
 * chips: in the physical view the ports without a cable (a strip at the
 * bottom of the device box), in the logical view the virtual and tunnel
 * interfaces (under the loopbacks). Each chip is one interface, so it can be
 * found, selected and right-clicked by itself.
 */
export const IFCHIP_FONT = 9;
export const IFCHIP_H = 13;
export const IFCHIP_GAP = 3;
/** padding of a chip strip inside its device box (left, right, bottom) */
export const IFCHIP_PAD = 8;
/** from this many chips on, a prefix that all of them share is written once and each chip shows the rest */
export const IFCHIP_SHORTEN_FROM = 6;

export interface ChipItem {
  /** the interface id ('' for the shared-prefix caption) */
  id: string;
  text: string;
  /** top-left corner, relative to the flow's top-left */
  x: number;
  y: number;
  w: number;
}
export interface ChipFlow {
  items: ChipItem[];
  w: number;
  h: number;
}

function ifChipW(text: string): number {
  return Math.ceil(text.length * IFCHIP_FONT * 0.62) + 8;
}

/**
 * The texts of a row of interface chips: the ids, or, for a long run of
 * similarly named ports (ge-0/0/1 … ge-0/0/24), the shared prefix once
 * (ending before the trailing number, followed by "▸") and each chip with its own end.
 */
export function chipTexts(ids: string[]): { prefix: string; texts: string[] } {
  if (ids.length < IFCHIP_SHORTEN_FROM) return { prefix: '', texts: ids.slice() };
  let lcp = ids[0];
  for (const id of ids) {
    let k = 0;
    while (k < lcp.length && k < id.length && lcp.charCodeAt(k) === id.charCodeAt(k)) k++;
    lcp = lcp.slice(0, k);
  }
  const prefix = lcp.replace(/[0-9]+$/, '');
  // only worth it when the prefix is substantial and every chip keeps some text of its own
  if (prefix.length < 2 || ids.some((id) => id.length === prefix.length)) return { prefix: '', texts: ids.slice() };
  return { prefix, texts: ids.map((id) => id.slice(prefix.length)) };
}

/** Chips flowed into rows no wider than `maxW` (a chip wider than that gets a row of its own). */
export function chipFlow(ids: string[], maxW: number): ChipFlow {
  if (!ids.length) return { items: [], w: 0, h: 0 };
  const t = chipTexts(ids);
  // the caption: the shared prefix and a marker that the chips continue it (nothing is cut off: each chip is the rest of one id)
  const all: Array<{ id: string; text: string }> = (t.prefix ? [{ id: '', text: t.prefix + ' ▸' }] : []).concat(ids.map((id, i) => ({ id, text: t.texts[i] })));
  const items: ChipItem[] = [];
  let x = 0;
  let y = 0;
  let w = 0;
  for (const c of all) {
    const cw = ifChipW(c.text);
    if (x > 0 && x + cw > maxW) {
      x = 0;
      y += IFCHIP_H + IFCHIP_GAP;
    }
    items.push({ id: c.id, text: c.text, x, y, w: cw });
    x += cw + IFCHIP_GAP;
    w = Math.max(w, x - IFCHIP_GAP);
  }
  return { items, w, h: y + IFCHIP_H };
}

/** Height a chip strip adds to a device box (0 without chips). */
export function chipStripH(flow: ChipFlow): number {
  return flow.items.length ? flow.h + IFCHIP_PAD : 0;
}

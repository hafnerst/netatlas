/**
 * Sizes of diagram elements, derived from their text. Shared by the layout
 * (which needs the sizes to space things) and the renderers (which draw the
 * same lines at the same sizes), so what Auto-arrange reserves is what gets
 * drawn. Every element grows to fit its full text; nothing is shortened.
 */
import { TextBlock, labelWithAddresses, lineHeight, monoWidth, textBlock, textWidth } from './text';

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
  return monoWidth(s, CHIP_FONT);
}

/** A DNS name longer than this many characters continues on a further line, broken after a dot */
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

/** The DNS names of a device as the logical view shows them: every one, each once, in a fixed order. */
export function dnsShown(names: string[]): string[] {
  return Array.from(new Set(names)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Rows (of CHIP_H) and width the DNS names of a device take in its box. */
export function dnsSize(names: string[]): { rows: number; w: number } {
  let rows = 0;
  let w = 0;
  for (const n of dnsShown(names)) {
    const lines = dnsNameLines(n);
    rows += lines.length;
    for (const l of lines) w = Math.max(w, Math.ceil(chipTextWidth(l)));
  }
  return { rows, w };
}

// -------------------------------------------------------- interface entries

/**
 * An interface's addresses and identifiers are an entry in its device's box
 * (model/addresses.ts says which): a name line, then one line per fact, in
 * the monospace font, never wrapped or shortened. The entries of a device
 * are stacked under its label; the box is as wide as the widest line needs.
 */
export const ENTRY_FONT = 10;
export const ENTRY_LH = lineHeight(ENTRY_FONT);
export const ENTRY_PAD_X = 5;
export const ENTRY_PAD_Y = 3;
export const ENTRY_GAP = 3;
/** distance of the entries from the sides of the device box */
export const ENTRY_MARGIN = 8;

/** What an entry shows: its name line ('' for none) and its lines. */
export interface EntryText {
  header: string;
  lines: string[];
}

export function entryBox(e: EntryText): { w: number; h: number } {
  const all = e.header ? [e.header].concat(e.lines) : e.lines;
  const w = all.reduce((m, l) => Math.max(m, monoWidth(l, ENTRY_FONT)), 0);
  return { w: Math.ceil(w) + 2 * ENTRY_PAD_X, h: all.length * ENTRY_LH + 2 * ENTRY_PAD_Y };
}

/** Width and height of a device's stacked entries ([0, 0] without any). */
export function entriesSize(es: EntryText[]): [number, number] {
  if (!es.length) return [0, 0];
  let w = 0;
  let h = 0;
  for (const e of es) {
    const b = entryBox(e);
    w = Math.max(w, b.w);
    h += b.h;
  }
  return [w, h + ENTRY_GAP * (es.length - 1)];
}

/**
 * A device in the logical view: its label, the entries of its interfaces
 * and its DNS names, all inside its box. `list` is entriesSize() of its
 * entries. `bodyH` is the height of the label part (icon and name).
 */
export function logicalDeviceSize(label: string, sub: string, list: [number, number], dnsNames: string[] = []): { w: number; h: number; bodyH: number } {
  const body = deviceBody(label, sub, LOGICAL_DEVICE_MIN_W, LOGICAL_DEVICE_MIN_H);
  const dns = dnsSize(dnsNames);
  const w = Math.max(body.w, list[0] ? list[0] + 2 * ENTRY_MARGIN : 0, dns.w ? dns.w + 16 + 12 : 0);
  return { w, h: body.h + underBody(list[1], dns.rows), bodyH: body.h };
}

/** Height under a device's label: its entries, then its DNS names, then a margin. */
export function underBody(listH: number, dnsRows: number): number {
  if (!listH && !dnsRows) return 0;
  return listH + (listH && dnsRows ? ENTRY_GAP : 0) + dnsRows * CHIP_H + ENTRY_MARGIN;
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

/**
 * A network node: its name (wrapped), its prefix and VLAN on one line that
 * is never broken (the prefix is an address), and address-like attrs.
 */
export function networkBody(label: string, sub: string, extra: string[] = []): NetworkBody {
  const l = textBlock(label, NET_LABEL_SIZE, NET_TEXT_MAX_W);
  const lines = (sub ? [sub] : []).concat(extra);
  const w = lines.reduce((m, x, i) => Math.max(m, i >= (sub ? 1 : 0) ? monoWidth(x, NET_SUB_SIZE) : textWidth(x, NET_SUB_SIZE)), 0);
  const s: TextBlock = { lines, size: NET_SUB_SIZE, w, h: lines.length * lineHeight(NET_SUB_SIZE), mono: extra.length ? (sub ? 1 : 0) : undefined };
  if (s.mono === undefined) delete s.mono;
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
 * place at the right of the first line. Address-like attrs of the group
 * follow the title, each on a line of its own.
 */
export function groupHeader(label: string, kind: string, innerW: number, extra: string[] = []): GroupHeader {
  const kindText = kind.toUpperCase();
  const kindW = kindText ? textWidth(kindText, GROUP_KIND_SIZE) * 1.1 + 18 : 0;
  const boxW = innerW + 2 * GROUP_PAD;
  const avail = Math.max(260, boxW - 28 - kindW);
  const title = labelWithAddresses(label, extra, GROUP_TITLE_SIZE, avail);
  return { title, kind: kindText, h: Math.max(30, title.h + 14), minW: Math.ceil(title.w + 28 + kindW) };
}

// ------------------------------------------------------------------- labels

export const PILL_SIZE = 10;
export const PILL_MAX_W = 240;

/** A relation label ("pill"): its wrapped text, then its address lines (kept whole), and its outer size. */
export function pillBox(text: string, extra: string[] = []): { block: TextBlock; w: number; h: number } {
  const block = labelWithAddresses(text, extra, PILL_SIZE, PILL_MAX_W);
  return { block, w: Math.ceil(block.w + 16), h: Math.max(18, block.h + 6) };
}

export const LINK_LABEL_SIZE = 10.5;
export const LINK_LABEL_MAX_W = 190;

/** A cable label: speed, networks and label (wrapped), then its cable id and address lines (kept whole). */
export function linkLabelBox(text: string, extra: string[] = []): { block: TextBlock; w: number; h: number } {
  const block = labelWithAddresses(text, extra, LINK_LABEL_SIZE, LINK_LABEL_MAX_W);
  return { block, w: Math.ceil(block.w + 8), h: block.h + 2 };
}

export const MEMBER_LABEL_SIZE = 10;

/** The addresses on a membership line: every address of the device inside the network, one per line, whole. */
export function memberLabelBox(addresses: string[]): { block: TextBlock; w: number; h: number } {
  const block = labelWithAddresses('', addresses, MEMBER_LABEL_SIZE, Infinity);
  return { block, w: Math.ceil(block.w + 4), h: block.h };
}

export { lineHeight };

// ---------------------------------------------------------- interface chips

/**
 * The physical view draws the ports without a cable as small chips (a strip
 * at the bottom of the device box). Each chip is one interface, written with
 * its full name (an identifier is never shortened), so it can be found,
 * selected and right-clicked by itself.
 */
export const IFCHIP_FONT = 9;
export const IFCHIP_H = 13;
export const IFCHIP_GAP = 3;
/** padding of a chip strip inside its device box (left, right, bottom) */
export const IFCHIP_PAD = 8;

export interface ChipItem {
  /** the interface id */
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

/** Chips flowed into rows no wider than `maxW` (a chip wider than that gets a row of its own), each with its interface's full name. */
export function chipFlow(ids: string[], maxW: number): ChipFlow {
  if (!ids.length) return { items: [], w: 0, h: 0 };
  const all = ids.map((id) => ({ id, text: id }));
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

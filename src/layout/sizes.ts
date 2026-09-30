/**
 * Sizes of diagram elements, derived from their text. Shared by the layout
 * (which needs the sizes to space things) and the renderers (which draw the
 * same lines at the same sizes), so what Auto-arrange reserves is what gets
 * drawn. Every element grows to fit its full text; nothing is shortened.
 */
import { TextBlock, lineHeight, textBlock, textWidth } from './text';

export const HUB_R = 12;
export const CHIP_H = 16;
/** loopback chips shown under a device in the logical view */
export const MAX_CHIPS = 3;

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

/** Number of chip rows below the device box (loopbacks, plus a "+N more" row). */
export function chipRows(loopbackCount: number): number {
  return loopbackCount === 0 ? 0 : Math.min(loopbackCount, MAX_CHIPS) + (loopbackCount > MAX_CHIPS ? 1 : 0);
}

/**
 * A device in the logical view: its body, plus the loopback chips hanging
 * under it. The node is as wide as its widest chip needs.
 */
export function logicalDeviceSize(label: string, sub: string, chipW: number, loopbackCount: number): { w: number; h: number; bodyH: number } {
  const body = deviceBody(label, sub, LOGICAL_DEVICE_MIN_W, LOGICAL_DEVICE_MIN_H);
  const rows = chipRows(loopbackCount);
  return { w: Math.max(body.w, chipW ? chipW + 16 + 12 : 0), h: body.h + (rows ? rows * CHIP_H + 6 : 0), bodyH: body.h };
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
export function networkSubtitle(cidr: string[], vlan?: number): string {
  const parts: string[] = [];
  if (vlan !== undefined) parts.push('VLAN ' + vlan);
  // sorted, so the order of the list in the file affects neither text nor size
  const sorted = cidr.slice().sort();
  if (sorted.length) parts.push(sorted.join(', '));
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

/**
 * Physical view layout.
 *
 * Auto-arrange (`autoPhysical`) is a deterministic, compound "tiered block"
 * layout computed only from the canonical LayoutInput:
 *   - every group is a box; child groups are packed inside their parent;
 *   - inside a group, devices are arranged in rows by tier (cloud/WAN on top,
 *     routers, firewalls, core, access, endpoints at the bottom);
 *   - ungrouped devices are split into connected components, each packed as
 *     its own block (higher-tier and larger components first);
 *   - rows and sibling groups are reordered with barycenter sweeps to reduce
 *     crossings; every tie is broken by id;
 *   - device boxes are as large as their full (wrapped) label needs and grow
 *     further to fit their ports and port labels;
 *   - the gap between two devices of a row is widened for the port labels on
 *     the facing sides and for the label of a cable between them; group boxes
 *     are at least as wide as their title;
 *   - ports of the two ends of a cable are lined up where the boxes face each
 *     other, so such cables are straight.
 * Only + - * / and Math.sqrt are used, and results are rounded to integers,
 * so every browser computes the same positions.
 *
 * Group boxes are never stored: they are derived from their devices.
 */
import { CBox, Pt, textWidth } from './geometry';
import { LDev, LEnd, LayoutInput, cmp } from './input';
import { GROUP_PAD, deviceBody, groupHeader, linkLabelBox } from './sizes';

export { GROUP_PAD };

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface PortPos {
  /** "<linkId>:a" or "<linkId>:b" */
  key: string;
  linkId: string;
  device: string;
  iface?: string;
  side: Side;
  x: number;
  y: number;
  /** outward unit normal of the side */
  nx: number;
  ny: number;
}

export interface PortLink {
  id: string;
  a: LEnd;
  b: LEnd;
}

export interface PhysicalLayout {
  boxes: Map<string, CBox>;
}

const HGAP = 76;
const VGAP = 110;
const BLOCK_GAP = 48;
const MAX_PER_ROW = 6;
const BASE_W = 150;
const BASE_H = 54;
export const PORT_FONT = 10;
/** a box grows for its ports up to this size; beyond it the ports share the side */
const MAX_PORT_W = 1200;
const MAX_PORT_H = 800;
/** distance from a side port to the start of its label */
export const PORT_LABEL_GAP = 7;

interface GNode {
  id: string | null;
  label: string;
  kind: string;
  tiers: string[][];
  children: GNode[];
  /** root only: ungrouped devices, tier rows per connected component */
  comps: string[][][];
}

interface Block {
  w: number;
  h: number;
  place(x: number, y: number): void;
}

/** Size of a device box for its label and subtitle alone (ports may enlarge it). */
export function physicalBaseSize(d: LDev): { w: number; h: number } {
  const b = deviceBody(d.label, d.sub, BASE_W, BASE_H);
  return { w: b.w, h: b.h };
}

/** Stable sort by numeric key; equal keys keep their current order. */
function stableSortBy<T>(xs: T[], key: (x: T) => number): void {
  const idx = new Map<T, number>();
  xs.forEach((x, i) => idx.set(x, i));
  const k = new Map<T, number>();
  for (const x of xs) k.set(x, key(x));
  xs.sort((a, b) => (k.get(a) as number) - (k.get(b) as number) || (idx.get(a) as number) - (idx.get(b) as number));
}

function tiersOf(ids: string[], tier: Map<string, number>): string[][] {
  const tm = new Map<number, string[]>();
  for (const id of ids) {
    const t = tier.get(id) as number;
    if (!tm.has(t)) tm.set(t, []);
    (tm.get(t) as string[]).push(id);
  }
  return Array.from(tm.keys())
    .sort((a, b) => a - b)
    .map((t) => (tm.get(t) as string[]).slice().sort(cmp));
}

/** Auto-arranged device centers for the physical view. */
export function autoPhysical(input: LayoutInput): Map<string, Pt> {
  const size = new Map<string, { w: number; h: number }>();
  const tier = new Map<string, number>();
  for (const d of input.devices) {
    size.set(d.id, physicalBaseSize(d));
    tier.set(d.id, d.tier);
  }
  const groupIds = new Set(input.groups.map((g) => g.id));

  // neighbor lists (sorted, so floating-point sums do not depend on input order)
  const nbrs = new Map<string, string[]>();
  for (const d of input.devices) nbrs.set(d.id, []);
  for (const l of input.links) {
    if (l.a.device === l.b.device || !nbrs.has(l.a.device) || !nbrs.has(l.b.device)) continue;
    (nbrs.get(l.a.device) as string[]).push(l.b.device);
    (nbrs.get(l.b.device) as string[]).push(l.a.device);
  }
  nbrs.forEach((v) => v.sort(cmp));

  // --- group tree
  const nodes = new Map<string, GNode>();
  const root: GNode = { id: null, label: '', kind: '', tiers: [], children: [], comps: [] };
  for (const g of input.groups) nodes.set(g.id, { id: g.id, label: g.label, kind: g.kind, tiers: [], children: [], comps: [] });
  for (const g of input.groups) {
    const parent = g.parent && nodes.has(g.parent) ? (nodes.get(g.parent) as GNode) : root;
    parent.children.push(nodes.get(g.id) as GNode);
  }
  const byGroup = new Map<GNode, string[]>();
  for (const d of input.devices) {
    const n = d.group && groupIds.has(d.group) ? (nodes.get(d.group) as GNode) : root;
    if (!byGroup.has(n)) byGroup.set(n, []);
    (byGroup.get(n) as string[]).push(d.id);
  }
  byGroup.forEach((ids, n) => {
    if (n !== root) n.tiers = tiersOf(ids, tier);
  });
  // ungrouped devices: connected components over links between ungrouped devices
  const ungrouped = (byGroup.get(root) || []).slice().sort(cmp);
  const ug = new Set(ungrouped);
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const start of ungrouped) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const x = stack.pop() as string;
      comp.push(x);
      for (const y of nbrs.get(x) as string[]) {
        if (ug.has(y) && !seen.has(y)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    comps.push(comp.sort(cmp));
  }
  const minTier = (ids: string[]): number => ids.reduce((m, id) => Math.min(m, tier.get(id) as number), 99);
  comps.sort((a, b) => minTier(a) - minTier(b) || b.length - a.length || cmp(a[0], b[0]));
  root.comps = comps.map((c) => tiersOf(c, tier));

  const subtreeDevices = new Map<GNode, string[]>();
  const collect = (n: GNode): string[] => {
    const own: string[] = [];
    for (const t of n.tiers) own.push(...t);
    for (const c of n.children) own.push(...collect(c));
    own.sort(cmp);
    subtreeDevices.set(n, own);
    return own;
  };
  collect(root);
  const allNodes: GNode[] = [root];
  for (let i = 0; i < allNodes.length; i++) allNodes.push(...allNodes[i].children);
  for (const n of allNodes) {
    n.children.sort(
      (a, b) =>
        minTier(subtreeDevices.get(a) as string[]) - minTier(subtreeDevices.get(b) as string[]) ||
        (subtreeDevices.get(b) as string[]).length - (subtreeDevices.get(a) as string[]).length ||
        cmp(a.id as string, b.id as string),
    );
  }

  const pos = new Map<string, Pt>();

  // room the labels need between two neighbors of a row: port labels on the
  // facing sides (known once ports are assigned) and the label of a cable
  // that joins the two directly
  const sidePad = new Map<string, { left: number; right: number }>();
  const labelW = new Map(input.linkLabels.map((l) => [l.id, linkLabelBox(l.text).w] as [string, number]));
  const between = new Map<string, number>();
  for (const l of input.links) {
    const w = labelW.get(l.id);
    if (w === undefined || l.a.device === l.b.device) continue;
    const k = cmp(l.a.device, l.b.device) <= 0 ? l.a.device + '\u0000' + l.b.device : l.b.device + '\u0000' + l.a.device;
    between.set(k, Math.max(between.get(k) || 0, w));
  }
  const gap = (a: string, b: string): number => {
    const pa = sidePad.get(a);
    const pb = sidePad.get(b);
    const lw = between.get(cmp(a, b) <= 0 ? a + '\u0000' + b : b + '\u0000' + a) || 0;
    return Math.max(HGAP, (pa ? pa.right : 0) + (pb ? pb.left : 0) + (lw ? lw + 24 : 16));
  };
  const rowWidth = (r: string[]): number => r.reduce((s, id, i) => s + (size.get(id) as { w: number }).w + (i ? gap(r[i - 1], id) : 0), 0);

  const rowsBlock = (tiers: string[][]): Block => {
    const rows: string[][] = [];
    for (const t of tiers) for (let i = 0; i < t.length; i += MAX_PER_ROW) rows.push(t.slice(i, i + MAX_PER_ROW));
    const rw = rows.map(rowWidth);
    const rh = rows.map((r) => r.reduce((m, id) => Math.max(m, (size.get(id) as { h: number }).h), 0));
    const w = rows.length ? rw.reduce((m, x) => Math.max(m, x), 0) : 0;
    const h = rh.reduce((s, x) => s + x, 0) + VGAP * Math.max(0, rows.length - 1);
    return {
      w,
      h,
      place(x, y) {
        let cy = y;
        rows.forEach((r, i) => {
          let cx = x + (w - rw[i]) / 2;
          r.forEach((id, k) => {
            const s = size.get(id) as { w: number; h: number };
            if (k) cx += gap(r[k - 1], id);
            pos.set(id, { x: cx + s.w / 2, y: cy + rh[i] / 2 });
            cx += s.w;
          });
          cy += rh[i] + VGAP;
        });
      },
    };
  };

  const packBlocks = (blocks: Block[], minW: number): Block => {
    if (!blocks.length) return { w: 0, h: 0, place() {} };
    const area = blocks.reduce((s, b) => s + b.w * b.h, 0);
    const maxW = Math.max(minW, blocks.reduce((m, b) => Math.max(m, b.w), 0), Math.sqrt(area * 3.2));
    const lines: Block[][] = [[]];
    let lw = 0;
    for (const b of blocks) {
      const cur = lines[lines.length - 1];
      if (cur.length && lw + BLOCK_GAP + b.w > maxW) {
        lines.push([b]);
        lw = b.w;
      } else {
        lw += (cur.length ? BLOCK_GAP : 0) + b.w;
        cur.push(b);
      }
    }
    const lineW = lines.map((l) => l.reduce((s, b) => s + b.w, 0) + BLOCK_GAP * (l.length - 1));
    const lineH = lines.map((l) => l.reduce((m, b) => Math.max(m, b.h), 0));
    const w = lineW.reduce((m, x) => Math.max(m, x), 0);
    const h = lineH.reduce((s, x) => s + x, 0) + BLOCK_GAP * (lines.length - 1);
    return {
      w,
      h,
      place(x, y) {
        let cy = y;
        lines.forEach((l, i) => {
          let cx = x + (w - lineW[i]) / 2;
          for (const b of l) {
            b.place(cx, cy);
            cx += b.w + BLOCK_GAP;
          }
          cy += lineH[i] + BLOCK_GAP;
        });
      },
    };
  };

  const groupBlock = (n: GNode): Block => {
    const rows = rowsBlock(n.tiers);
    const kids = packBlocks(n.children.map(groupBlock), rows.w);
    // at least as wide as the group's title needs; the title area grows with its lines
    const contentW = Math.max(rows.w, kids.w, 140);
    const head = groupHeader(n.label, n.kind, contentW);
    const innerW = Math.max(contentW, head.minW - 2 * GROUP_PAD);
    const innerH = rows.h + kids.h + (rows.h && kids.h ? BLOCK_GAP : 0);
    return {
      w: innerW + 2 * GROUP_PAD,
      h: innerH + 2 * GROUP_PAD + head.h,
      place(x, y) {
        const ix = x + GROUP_PAD;
        const iy = y + GROUP_PAD + head.h;
        rows.place(ix + (innerW - rows.w) / 2, iy);
        kids.place(ix + (innerW - kids.w) / 2, iy + rows.h + (rows.h && kids.h ? BLOCK_GAP : 0));
      },
    };
  };

  const rootBlock = (): Block => {
    const top = packBlocks(root.comps.map(rowsBlock), 0);
    const groups = packBlocks(root.children.map(groupBlock), top.w);
    const w = Math.max(top.w, groups.w);
    const gap = top.h && groups.h ? VGAP : 0;
    return {
      w,
      h: top.h + gap + groups.h,
      place(x, y) {
        top.place(x + (w - top.w) / 2, y);
        groups.place(x + (w - groups.w) / 2, y + top.h + gap);
      },
    };
  };

  const meanX = (ids: string[], fallback: number): number => {
    if (!ids.length) return fallback;
    let s = 0;
    for (const id of ids) s += (pos.get(id) as Pt).x;
    return s / ids.length;
  };
  const externalNbrs = (inside: Set<string>): string[] => {
    const ext: string[] = [];
    Array.from(inside)
      .sort(cmp)
      .forEach((id) => {
        for (const o of nbrs.get(id) as string[]) if (!inside.has(o)) ext.push(o);
      });
    return ext.sort(cmp);
  };

  const sweep = (): void => {
    // device rows: order by mean x of neighbors outside the row
    const rowLists: string[][] = [];
    for (const n of allNodes) for (const t of n.tiers) rowLists.push(t);
    for (const c of root.comps) for (const t of c) rowLists.push(t);
    for (const t of rowLists) {
      const inRow = new Set(t);
      stableSortBy(t, (id) => meanX((nbrs.get(id) as string[]).filter((o) => !inRow.has(o)), (pos.get(id) as Pt).x));
    }
    // sibling groups: order by mean x of their external neighbors; groups
    // without any connection outside themselves (separate components) go last
    for (const n of allNodes) {
      if (n.children.length < 2) continue;
      stableSortBy(n.children, (c) => {
        const ext = externalNbrs(new Set(subtreeDevices.get(c) as string[]));
        return ext.length ? meanX(ext, 0) : Number.MAX_SAFE_INTEGER;
      });
    }
    // ungrouped components: next to what they connect to; unconnected ones last
    if (root.comps.length > 1) {
      stableSortBy(root.comps, (c) => {
        const inside = new Set<string>();
        for (const t of c) for (const id of t) inside.add(id);
        const ext = externalNbrs(inside);
        return ext.length ? meanX(ext, 0) : Number.MAX_SAFE_INTEGER;
      });
    }
  };

  rootBlock().place(0, 0);
  for (let i = 0; i < 4; i++) {
    sweep();
    rootBlock().place(0, 0);
  }

  // grow boxes to fit their ports, then place again
  const boxesNow = (): Map<string, CBox> => {
    const m = new Map<string, CBox>();
    for (const d of input.devices) {
      const p = pos.get(d.id) as Pt;
      const s = size.get(d.id) as { w: number; h: number };
      m.set(d.id, { cx: p.x, cy: p.y, w: s.w, h: s.h });
    }
    return m;
  };
  const { ports, need } = layoutPorts(input.links, boxesNow());
  for (const d of input.devices) {
    const s = size.get(d.id) as { w: number; h: number };
    const n = need.get(d.id);
    if (n) {
      s.w = Math.max(s.w, Math.min(MAX_PORT_W, n.w));
      s.h = Math.max(s.h, Math.min(MAX_PORT_H, n.h));
    }
  }
  for (const p of ports) {
    if (p.side !== 'left' && p.side !== 'right') continue;
    let pad = sidePad.get(p.device);
    if (!pad) sidePad.set(p.device, (pad = { left: 0, right: 0 }));
    pad[p.side] = Math.max(pad[p.side], sideLabelWidth(p.iface));
  }
  rootBlock().place(0, 0);
  const out = new Map<string, Pt>();
  for (const d of input.devices) {
    const p = pos.get(d.id) as Pt;
    out.set(d.id, { x: Math.round(p.x), y: Math.round(p.y) });
  }
  return out;
}

/** Device boxes: sizes from labels and ports, centers from `positions`. */
export function physicalBoxes(input: LayoutInput, positions: Map<string, Pt>): Map<string, CBox> {
  const boxes = new Map<string, CBox>();
  for (const d of input.devices) {
    const p = positions.get(d.id) || { x: 0, y: 0 };
    boxes.set(d.id, { cx: p.x, cy: p.y, ...physicalBaseSize(d) });
  }
  layoutPorts(input.links, boxes).need.forEach((n, id) => {
    const b = boxes.get(id);
    if (!b) return;
    b.w = Math.max(b.w, Math.min(MAX_PORT_W, n.w));
    b.h = Math.max(b.h, Math.min(MAX_PORT_H, n.h));
  });
  return boxes;
}

/** Room a label of a left/right port takes beside its device. */
function sideLabelWidth(iface: string | undefined): number {
  return iface ? PORT_LABEL_GAP + textWidth(iface, PORT_FONT) + 4 : 0;
}

function portLabelWidth(iface: string | undefined): number {
  return iface ? textWidth(iface, PORT_FONT) + 12 : 14;
}

/**
 * Place a port for every link end on the side of its device facing the peer.
 *
 * Along a side, each port is put as close as possible to the point opposite
 * its peer's center, in the order of the peers (ties: link id), keeping a
 * slot per port wide enough for its label. Then the two ports of a cable
 * that sit on sides facing each other are moved onto one line where both
 * sides have room, which makes that cable a single straight segment.
 *
 * `need` is the size each device must have for its ports to sit where they
 * want to be (opposite their peers) with their labels; the layout grows the
 * boxes to it.
 */
export function assignPorts(links: PortLink[], boxes: Map<string, CBox>): PortPos[] {
  return layoutPorts(links, boxes).ports;
}

function layoutPorts(links: PortLink[], boxes: Map<string, CBox>): { ports: PortPos[]; need: Map<string, { w: number; h: number }> } {
  const need = new Map<string, { w: number; h: number }>();
  const needs = (device: string, horiz: boolean, size: number): void => {
    let n = need.get(device);
    if (!n) need.set(device, (n = { w: 0, h: 0 }));
    if (horiz) n.w = Math.max(n.w, size);
    else n.h = Math.max(n.h, size);
  };
  interface Pending {
    p: PortPos;
    /** peer center */
    peer: Pt;
    /** room the port needs along its side */
    slot: number;
    /** position along the side (x for top/bottom, y for left/right), absolute */
    at: number;
    list: Pending[];
  }
  const bySide = new Map<string, Pending[]>();
  const byKey = new Map<string, Pending>();
  const out: PortPos[] = [];
  const sorted = links.slice().sort((a, b) => cmp(a.id, b.id));
  for (const l of sorted) {
    for (const end of ['a', 'b'] as const) {
      const me = end === 'a' ? l.a : l.b;
      const other = end === 'a' ? l.b : l.a;
      const b = boxes.get(me.device);
      const ob = boxes.get(other.device);
      if (!b || !ob) continue;
      let dx = ob.cx - b.cx;
      let dy = ob.cy - b.cy;
      if (me.device === other.device) {
        dx = 0;
        dy = end === 'a' ? 1 : -1;
      }
      const vertical = Math.abs(dy) >= 0.35 * Math.abs(dx) && Math.abs(dy) > b.h / 2;
      const side: Side = vertical ? (dy > 0 ? 'bottom' : 'top') : dx > 0 ? 'right' : 'left';
      const p: PortPos = {
        key: l.id + ':' + end,
        linkId: l.id,
        device: me.device,
        iface: me.iface,
        side,
        x: 0,
        y: 0,
        nx: side === 'left' ? -1 : side === 'right' ? 1 : 0,
        ny: side === 'top' ? -1 : side === 'bottom' ? 1 : 0,
      };
      const k = me.device + '|' + side;
      if (!bySide.has(k)) bySide.set(k, []);
      const list = bySide.get(k) as Pending[];
      const e: Pending = { p, peer: { x: ob.cx, y: ob.cy }, slot: vertical ? portLabelWidth(me.iface) : 22, at: 0, list };
      list.push(e);
      byKey.set(p.key, e);
      out.push(p);
    }
  }
  const isHoriz = (e: Pending): boolean => e.p.side === 'top' || e.p.side === 'bottom';
  /** how close a port may come to the end of its side (a label under a top/bottom port needs half its slot) */
  const endGap = (e: Pending): number => (isHoriz(e) ? e.slot / 2 : 6);
  /** usable range along the side of a port's device */
  const range = (e: Pending): [number, number] => {
    const b = boxes.get(e.p.device) as CBox;
    return isHoriz(e) ? [b.cx - b.w / 2 + 8, b.cx + b.w / 2 - 8] : [b.cy - b.h / 2 + 8, b.cy + b.h / 2 - 8];
  };
  bySide.forEach((list) => {
    const horiz = isHoriz(list[0]);
    const [lo, hi] = range(list[0]);
    list.sort((u, v) => (horiz ? u.peer.x - v.peer.x : u.peer.y - v.peer.y) || cmp(u.p.key, v.p.key));
    const total = list.reduce((s, e) => s + e.slot, 0);
    const n = list.length;
    const sep = (i: number): number => (list[i].slot + list[i + 1].slot) / 2;
    /** nearest positions to `want` that keep the slots apart: the mean of pushing right and pushing left */
    const spread = (want: number[]): number[] => {
      const f = want.slice();
      for (let i = 1; i < n; i++) f[i] = Math.max(f[i], f[i - 1] + sep(i - 1));
      const g = want.slice();
      for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] - sep(i));
      return f.map((v, i) => (v + g[i]) / 2);
    };
    const peerAt = (e: Pending): number => (horiz ? e.peer.x : e.peer.y);
    // The size the side should have: enough for every port to sit opposite
    // its peer (peers far to one side count as "at that end"). Measured on a
    // side just long enough for all slots, so it doesn't depend on the box's
    // current size.
    const center = (lo + hi) / 2;
    const ideal = spread(list.map((e) => Math.max(center - total / 2 + e.slot / 2, Math.min(center + total / 2 - e.slot / 2, peerAt(e)))));
    const reach = ideal.reduce((m, v, i) => Math.max(m, Math.abs(v - center) + list[i].slot / 2), 0);
    needs(list[0].p.device, horiz, 2 * reach + (horiz ? 24 : 16));
    if (total > hi - lo) {
      // more ports than the side has room for: share the side in proportion
      const scale = (hi - lo) / total;
      let cur = lo;
      for (const e of list) {
        e.at = cur + (e.slot * scale) / 2;
        cur += e.slot * scale;
      }
      return;
    }
    const at = spread(list.map((e) => Math.max(lo + endGap(e), Math.min(hi - endGap(e), peerAt(e)))));
    // back inside the side
    at[0] = Math.max(at[0], lo + endGap(list[0]));
    for (let i = 1; i < n; i++) at[i] = Math.max(at[i], at[i - 1] + sep(i - 1));
    at[n - 1] = Math.min(at[n - 1], hi - endGap(list[n - 1]));
    for (let i = n - 2; i >= 0; i--) at[i] = Math.min(at[i], at[i + 1] - sep(i));
    list.forEach((e, i) => (e.at = at[i]));
  });
  // line up the two ports of a cable whose sides face each other
  const opposite: { [s in Side]: Side } = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const canMove = (e: Pending, to: number): boolean => {
    const [lo, hi] = range(e);
    if (to < lo + endGap(e) - 0.01 || to > hi - endGap(e) + 0.01) return false;
    const i = e.list.indexOf(e);
    if (i > 0 && to < e.list[i - 1].at + (e.list[i - 1].slot + e.slot) / 2 - 0.01) return false;
    if (i < e.list.length - 1 && to > e.list[i + 1].at - (e.list[i + 1].slot + e.slot) / 2 + 0.01) return false;
    return true;
  };
  for (let round = 0; round < 2; round++) {
    for (const l of sorted) {
      const a = byKey.get(l.id + ':a');
      const b = byKey.get(l.id + ':b');
      if (!a || !b || a.p.device === b.p.device || opposite[a.p.side] !== b.p.side || a.at === b.at) continue;
      const mid = Math.round((a.at + b.at) / 2);
      for (const to of [mid, a.at, b.at]) {
        if ((to === a.at || canMove(a, to)) && (to === b.at || canMove(b, to))) {
          a.at = to;
          b.at = to;
          break;
        }
      }
    }
  }
  bySide.forEach((list) => {
    for (const e of list) {
      const b = boxes.get(e.p.device) as CBox;
      if (isHoriz(e)) {
        e.p.x = e.at;
        e.p.y = b.cy + (e.p.side === 'top' ? -b.h / 2 : b.h / 2);
      } else {
        e.p.x = b.cx + (e.p.side === 'left' ? -b.w / 2 : b.w / 2);
        e.p.y = e.at;
      }
    }
  });
  return { ports: out, need };
}

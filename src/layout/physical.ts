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
 *   - device boxes grow to fit their ports, leaving room for port labels.
 * Only + - * / and Math.sqrt are used, and results are rounded to integers,
 * so every browser computes the same positions.
 *
 * Group boxes are never stored: they are derived from their devices.
 */
import { CBox, Pt, textWidth } from './geometry';
import { LEnd, LayoutInput, cmp } from './input';

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

export const GROUP_PAD = 26;
export const GROUP_TITLE = 30;
const HGAP = 76;
const VGAP = 96;
const BLOCK_GAP = 48;
const MAX_PER_ROW = 6;
const BASE_H = 54;
export const PORT_FONT = 10;

interface GNode {
  id: string | null;
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

export function deviceBaseWidth(label: string): number {
  return Math.max(150, Math.min(260, textWidth(label, 13) + 64));
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
    size.set(d.id, { w: deviceBaseWidth(d.label), h: BASE_H });
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
  const root: GNode = { id: null, tiers: [], children: [], comps: [] };
  for (const g of input.groups) nodes.set(g.id, { id: g.id, tiers: [], children: [], comps: [] });
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

  const rowsBlock = (tiers: string[][]): Block => {
    const rows: string[][] = [];
    for (const t of tiers) for (let i = 0; i < t.length; i += MAX_PER_ROW) rows.push(t.slice(i, i + MAX_PER_ROW));
    const rw = rows.map((r) => r.reduce((s, id) => s + (size.get(id) as { w: number }).w, 0) + HGAP * Math.max(0, r.length - 1));
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
          for (const id of r) {
            const s = size.get(id) as { w: number; h: number };
            pos.set(id, { x: cx + s.w / 2, y: cy + rh[i] / 2 });
            cx += s.w + HGAP;
          }
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
    const innerW = Math.max(rows.w, kids.w, 140);
    const innerH = rows.h + kids.h + (rows.h && kids.h ? BLOCK_GAP : 0);
    return {
      w: innerW + 2 * GROUP_PAD,
      h: innerH + 2 * GROUP_PAD + GROUP_TITLE,
      place(x, y) {
        const ix = x + GROUP_PAD;
        const iy = y + GROUP_PAD + GROUP_TITLE;
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
  const need = portSpaceNeeds(assignPorts(input.links, boxesNow()));
  for (const d of input.devices) {
    const s = size.get(d.id) as { w: number; h: number };
    const n = need.get(d.id);
    if (n) {
      s.w = Math.max(s.w, Math.min(1200, n.horizontal + 24));
      s.h = Math.max(s.h, Math.min(800, n.vertical + 16));
    }
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
    boxes.set(d.id, { cx: p.x, cy: p.y, w: deviceBaseWidth(d.label), h: BASE_H });
  }
  const need = portSpaceNeeds(assignPorts(input.links, boxes));
  need.forEach((n, id) => {
    const b = boxes.get(id);
    if (!b) return;
    b.w = Math.max(b.w, Math.min(1200, n.horizontal + 24));
    b.h = Math.max(b.h, Math.min(800, n.vertical + 16));
  });
  return boxes;
}

/** Base (un-grown) device size, used when placing new devices. */
export function physicalBaseSize(label: string): { w: number; h: number } {
  return { w: deviceBaseWidth(label), h: BASE_H };
}

function portLabelWidth(iface: string | undefined): number {
  return iface ? textWidth(iface, PORT_FONT) + 12 : 14;
}

function portSpaceNeeds(ports: PortPos[]): Map<string, { horizontal: number; vertical: number }> {
  const acc = new Map<string, { top: number; bottom: number; left: number; right: number }>();
  for (const p of ports) {
    let a = acc.get(p.device);
    if (!a) acc.set(p.device, (a = { top: 0, bottom: 0, left: 0, right: 0 }));
    a[p.side] += p.side === 'top' || p.side === 'bottom' ? portLabelWidth(p.iface) : 22;
  }
  const out = new Map<string, { horizontal: number; vertical: number }>();
  acc.forEach((a, id) => out.set(id, { horizontal: Math.max(a.top, a.bottom), vertical: Math.max(a.left, a.right) }));
  return out;
}

/**
 * Place a port for every link end on the side of its device facing the peer,
 * spread along that side in the order of the peers (ties: link id).
 */
export function assignPorts(links: PortLink[], boxes: Map<string, CBox>): PortPos[] {
  interface Pending {
    p: PortPos;
    peer: Pt;
  }
  const bySide = new Map<string, Pending[]>();
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
      (bySide.get(k) as Pending[]).push({ p, peer: { x: ob.cx, y: ob.cy } });
      out.push(p);
    }
  }
  bySide.forEach((list) => {
    const p0 = list[0].p;
    const b = boxes.get(p0.device) as CBox;
    const horiz = p0.side === 'top' || p0.side === 'bottom';
    list.sort((u, v) => (horiz ? u.peer.x - v.peer.x : u.peer.y - v.peer.y) || cmp(u.p.key, v.p.key));
    const len = (horiz ? b.w : b.h) - 16;
    const slots = list.map((e) => (horiz ? portLabelWidth(e.p.iface) : 22));
    const total = slots.reduce((s, x) => s + x, 0);
    const scale = total > len ? len / total : 1;
    let cur = (len - total * scale) / 2 + 8 - (horiz ? b.w : b.h) / 2;
    list.forEach((e, i) => {
      const off = cur + (slots[i] * scale) / 2;
      cur += slots[i] * scale;
      if (horiz) {
        e.p.x = b.cx + off;
        e.p.y = b.cy + (p0.side === 'top' ? -b.h / 2 : b.h / 2);
      } else {
        e.p.x = b.cx + (p0.side === 'left' ? -b.w / 2 : b.w / 2);
        e.p.y = b.cy + off;
      }
    });
  });
  return out;
}

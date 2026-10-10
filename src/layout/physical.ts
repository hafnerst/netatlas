/**
 * Physical view layout.
 *
 * Auto-arrange (`autoPhysical`) is a deterministic, compound "tiered block"
 * layout computed only from the canonical LayoutInput:
 *   - every group is a box; child groups are arranged inside their parent;
 *   - the blocks of one container (its own devices, its child groups and, at
 *     the top level, the components of ungrouped devices) are placed by how
 *     they are cabled: blocks that are connected form a stack of layers, a
 *     block sits one layer below the block it is connected to, starting from
 *     the block with the highest-ranking devices (lowest tier), and within a
 *     layer each block is moved as close as possible to the point above or
 *     below the devices it is cabled to. Blocks without any connection to the
 *     others are packed beside these stacks;
 *   - inside a group, devices are arranged in rows by tier (cloud/WAN on top,
 *     routers, firewalls, core, access, endpoints at the bottom);
 *   - ungrouped devices are split into connected components, each packed as
 *     its own block (higher-tier and larger components first);
 *   - device rows are reordered with barycenter sweeps to reduce crossings;
 *     every tie is broken by id;
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
import { ChipFlow, ENTRY_MARGIN, GROUP_PAD, IFCHIP_PAD, chipFlow, chipStripH, deviceBody, groupHeader, linkLabelBox } from './sizes';

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
/** vertical gap between two layers of connected blocks: room for the cables and their labels */
const LAYER_GAP = 96;
/** rounds of reordering, and what one crossing of two cables costs compared with cable length (px) */
const ROUNDS = 6;
const CROSSING_COST = 160;
const MAX_EXCHANGES = 300;
/** a layer below the top one may be at least this wide before it continues on a second line */
const LOWER_LAYER_W = 1800;
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
  /** address lines under the title */
  extra: string[];
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

/**
 * Size of a device box for its label and subtitle, the entries with its
 * interfaces' addresses and identifiers under them, and the strip of chips
 * of its ports without a cable at its bottom (cabled ports may enlarge it).
 */
export function physicalBaseSize(d: LDev): { w: number; h: number } {
  const b = deviceBody(d.label, d.sub, BASE_W, BASE_H);
  const w = Math.max(b.w, d.physList[0] ? d.physList[0] + 2 * ENTRY_MARGIN : 0);
  const flow = spareChipFlow(d.spare, w);
  return { w: Math.max(w, flow.w + 2 * IFCHIP_PAD), h: b.h + physicalListH(d.physList) + chipStripH(flow) };
}

/** Height a device's address entries take in its physical box (0 without any). */
export function physicalListH(list: [number, number]): number {
  return list[1] ? list[1] + ENTRY_MARGIN : 0;
}

/** The chips of a device's uncabled ports, for a box `w` wide. */
export function spareChipFlow(ids: string[], w: number): ChipFlow {
  return chipFlow(ids, Math.max(60, w - 2 * IFCHIP_PAD));
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
  const root: GNode = { id: null, label: '', kind: '', extra: [], tiers: [], children: [], comps: [] };
  for (const g of input.groups) nodes.set(g.id, { id: g.id, label: g.label, kind: g.kind, extra: g.extra, tiers: [], children: [], comps: [] });
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
  const labelW = new Map(input.linkLabels.map((l) => [l.id, linkLabelBox(l.text, l.extra).w] as [string, number]));
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

  // ---- blocks of one container, placed by their cabling
  /** order of the blocks of every layer ("container|stack|layer" -> block keys), as last placed or as fixed */
  let orders = new Map<string, string[]>();
  let frozen = false;
  /** One block of a container: its own device rows, a child group, or a component of ungrouped devices. */
  interface Unit {
    key: string;
    devices: string[];
    /** the container's own device rows: always on top of what is connected to them */
    own: boolean;
    block: Block;
  }

  /** Mean x of the devices outside `inside` that are cabled to it (undefined before the first placement, or without any). */
  const pullX = (inside: string[]): number | undefined => {
    if (!pos.size) return undefined;
    const set = new Set(inside);
    let sum = 0;
    let n = 0;
    for (const id of inside) {
      for (const o of nbrs.get(id) as string[]) {
        if (set.has(o)) continue;
        sum += (pos.get(o) as Pt).x;
        n++;
      }
    }
    return n ? sum / n : undefined;
  };

  /**
   * Centers along a line for blocks of the given widths, in the given order:
   * as close as possible to `want`, at least GAP apart, inside [0, total].
   */
  const spreadLine = (want: number[], widths: number[], total: number): number[] => {
    const n = want.length;
    const sep = (i: number): number => (widths[i] + widths[i + 1]) / 2 + BLOCK_GAP;
    const f = want.slice();
    for (let i = 1; i < n; i++) f[i] = Math.max(f[i], f[i - 1] + sep(i - 1));
    const g = want.slice();
    for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] - sep(i));
    const at = f.map((v, i) => (v + g[i]) / 2);
    at[0] = Math.max(at[0], widths[0] / 2);
    for (let i = 1; i < n; i++) at[i] = Math.max(at[i], at[i - 1] + sep(i - 1));
    at[n - 1] = Math.min(at[n - 1], total - widths[n - 1] / 2);
    for (let i = n - 2; i >= 0; i--) at[i] = Math.min(at[i], at[i + 1] - sep(i));
    return at;
  };

  /** A stack of layers of connected blocks. */
  const layeredBlock = (layers: Unit[][], minW: number, linked: (a: Unit, b: Unit) => boolean, where: string): Block => {
    const all: Unit[] = [];
    for (const l of layers) all.push(...l);
    const maxW = Math.max(minW, all.reduce((m, u) => Math.max(m, u.block.w), 0));
    // where each block is pulled by its cables, from the previous placement
    const pull = new Map<Unit, number | undefined>();
    for (const u of all) pull.set(u, pullX(u.devices));
    let center = 0;
    let count = 0;
    if (pos.size) {
      for (const u of all) {
        for (const id of u.devices) {
          center += (pos.get(id) as Pt).x;
          count++;
        }
      }
    }
    center = count ? center / count : 0;
    // lines: a layer that is too wide is continued on the next line
    const lines: Array<{ units: Unit[]; first: boolean; top: boolean }> = [];
    layers.forEach((layer, depth) => {
      // in the order of the pulls; blocks without any go last. Once the
      // order of a layer has been fixed (see below), that order is used.
      const ordered = layer.slice();
      const fixed = frozen ? orders.get(where + '|' + depth) : undefined;
      if (fixed) stableSortBy(ordered, (u) => (fixed.indexOf(u.key) + fixed.length + 1) % (fixed.length + 1));
      else {
        stableSortBy(ordered, (u) => {
          const v = pull.get(u);
          return v === undefined ? Number.MAX_SAFE_INTEGER : v;
        });
        orders.set(where + '|' + depth, ordered.map((u) => u.key));
      }
      let cur: Unit[] = [];
      let lw = 0;
      let first = true;
      // Below the top layer a continuation line lies under its own layer, so
      // the cables from above would have to cross that layer: such layers
      // are allowed to get considerably wider before they are continued.
      const limit = depth === 0 ? maxW : Math.max(maxW * 1.6, LOWER_LAYER_W);
      for (const u of ordered) {
        if (cur.length && lw + BLOCK_GAP + u.block.w > limit) {
          lines.push({ units: cur, first, top: depth === 0 });
          first = false;
          cur = [u];
          lw = u.block.w;
        } else {
          lw += (cur.length ? BLOCK_GAP : 0) + u.block.w;
          cur.push(u);
        }
      }
      lines.push({ units: cur, first, top: depth === 0 });
    });
    const lineW = lines.map((l) => l.units.reduce((sum, u) => sum + u.block.w, 0) + BLOCK_GAP * (l.units.length - 1));
    const w = lineW.reduce((m, x) => Math.max(m, x), 0);
    // Place line by line. Along its line a block goes as near to its pull as
    // the others allow (centered without one). Vertically it goes as high as
    // it can: below every block it is cabled to, with room for the cables and
    // their labels, and below whatever already lies above its own width.
    const spots: Array<{ u: Unit; x: number; y: number }> = [];
    lines.forEach((l, i) => {
      const widths = l.units.map((u) => u.block.w);
      let cx = (w - lineW[i]) / 2;
      const want = l.units.map((u) => {
        const packed = cx + u.block.w / 2;
        cx += u.block.w + BLOCK_GAP;
        const v = pull.get(u);
        // the top layer has nothing above it to line up with: it stays packed, in the order of the pulls
        return v === undefined || l.top ? packed : v - center + w / 2;
      });
      const at = spreadLine(want, widths, w);
      const row = l.units.map((u, k) => {
        const x = at[k] - u.block.w / 2;
        let y = 0;
        for (const sp of spots) {
          const bottom = sp.y + sp.u.block.h;
          if (linked(sp.u, u)) y = Math.max(y, bottom + LAYER_GAP);
          else if (sp.x < x + u.block.w + BLOCK_GAP && x < sp.x + sp.u.block.w + BLOCK_GAP) y = Math.max(y, bottom + BLOCK_GAP);
        }
        return { u, x, y };
      });
      spots.push(...row);
    });
    const h = spots.reduce((m, sp) => Math.max(m, sp.y + sp.u.block.h), 0);
    return {
      w,
      h,
      place(x, y) {
        for (const sp of spots) sp.u.block.place(x + sp.x, y + sp.y);
      },
    };
  };

  /**
   * Arrange the blocks of one container. Blocks that are cabled to each
   * other (directly or through other blocks) form one stack of layers; the
   * stacks, and blocks cabled to nothing in this container, are packed side
   * by side.
   */
  const arrange = (units: Unit[], minW: number, where: string): Block => {
    // fixed starting order: own rows, then by rank (lowest tier first), size, id
    const base = units.slice().sort((a, b) => Number(b.own) - Number(a.own) || minTier(a.devices) - minTier(b.devices) || b.devices.length - a.devices.length || cmp(a.key, b.key));
    const unitOf = new Map<string, number>();
    base.forEach((u, i) => u.devices.forEach((d) => unitOf.set(d, i)));
    const adj: number[][] = base.map(() => []);
    base.forEach((u, i) => {
      const seen = new Set<number>();
      for (const d of u.devices) {
        for (const o of nbrs.get(d) as string[]) {
          const j = unitOf.get(o);
          if (j !== undefined && j !== i) seen.add(j);
        }
      }
      adj[i] = Array.from(seen).sort((p, q) => p - q);
    });
    // a layer wider than this continues on the next line (from the area of everything in the container)
    const wrapW = Math.max(minW, Math.sqrt(base.reduce((sum, u) => sum + u.block.w * u.block.h, 0) * 3.2));
    const done = new Set<number>();
    const stacks: Block[] = [];
    for (let start = 0; start < base.length; start++) {
      if (done.has(start)) continue;
      // the connected blocks
      const comp: number[] = [];
      const queue = [start];
      done.add(start);
      while (queue.length) {
        const i = queue.shift() as number;
        comp.push(i);
        for (const j of adj[i]) {
          if (!done.has(j)) {
            done.add(j);
            queue.push(j);
          }
        }
      }
      comp.sort((p, q) => p - q);
      // top layer: the container's own rows, else the blocks with the highest-ranking devices
      const top = comp.some((i) => base[i].own) ? comp.filter((i) => base[i].own) : comp.filter((i) => minTier(base[i].devices) === minTier(base[comp[0]].devices));
      const layerOf = new Map<number, number>();
      let frontier = top;
      for (const i of top) layerOf.set(i, 0);
      for (let depth = 1; frontier.length; depth++) {
        const next: number[] = [];
        for (const i of frontier) {
          for (const j of adj[i]) {
            if (!layerOf.has(j)) {
              layerOf.set(j, depth);
              next.push(j);
            }
          }
        }
        frontier = next.sort((p, q) => p - q);
      }
      const layers: Unit[][] = [];
      for (const i of comp) {
        const k = layerOf.get(i) as number;
        while (layers.length <= k) layers.push([]);
        layers[k].push(base[i]);
      }
      const index = new Map(base.map((u, i) => [u, i] as [Unit, number]));
      stacks.push(layeredBlock(layers, wrapW, (p, q) => adj[index.get(p) as number].indexOf(index.get(q) as number) >= 0, where + '|' + stacks.length));
    }
    return stacks.length === 1 ? stacks[0] : packBlocks(stacks, minW);
  };

  const groupBlock = (n: GNode): Block => {
    const units: Unit[] = n.children.map((c) => ({ key: c.id as string, devices: subtreeDevices.get(c) as string[], own: false, block: groupBlock(c) }));
    if (n.tiers.length) {
      const own: string[] = [];
      for (const t of n.tiers) own.push(...t);
      units.push({ key: '', devices: own.sort(cmp), own: true, block: rowsBlock(n.tiers) });
    }
    const content = arrange(units, 0, 'g:' + (n.id as string));
    // at least as wide as the group's title needs; the title area grows with its lines
    const contentW = Math.max(content.w, 140);
    const head = groupHeader(n.label, n.kind, contentW, n.extra);
    const innerW = Math.max(contentW, head.minW - 2 * GROUP_PAD);
    return {
      w: innerW + 2 * GROUP_PAD,
      h: content.h + 2 * GROUP_PAD + head.h,
      place(x, y) {
        content.place(x + GROUP_PAD + (innerW - content.w) / 2, y + GROUP_PAD + head.h);
      },
    };
  };

  /** Top level: the components of ungrouped devices and the top-level groups, arranged together. */
  const rootBlock = (): Block => {
    const units: Unit[] = root.children.map((c) => ({ key: 'g:' + (c.id as string), devices: subtreeDevices.get(c) as string[], own: false, block: groupBlock(c) }));
    for (const c of root.comps) {
      const ids: string[] = [];
      for (const t of c) ids.push(...t);
      ids.sort(cmp);
      units.push({ key: 'c:' + ids[0], devices: ids, own: false, block: rowsBlock(c) });
    }
    return arrange(units, 0, '');
  };

  const meanX = (ids: string[], fallback: number): number => {
    if (!ids.length) return fallback;
    let s = 0;
    for (const id of ids) s += (pos.get(id) as Pt).x;
    return s / ids.length;
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
    // (groups and components are ordered where they are arranged, by the pull of their cables)
  };

  // Each round reorders the rows and lets the blocks follow their cables,
  // starting from the previous round's placement. The rounds don't always
  // improve (rings pull both ways), so the round with the shortest, least
  // crossing cabling is the one that is used.
  const rowLists = (): string[][] => {
    const out: string[][] = [];
    for (const n of allNodes) for (const t of n.tiers) out.push(t);
    for (const c of root.comps) for (const t of c) out.push(t);
    return out;
  };
  const cables = input.links.filter((l) => l.a.device !== l.b.device && nbrs.has(l.a.device) && nbrs.has(l.b.device));
  const cost = (): number => {
    let total = 0;
    const seg = cables.map((l) => [pos.get(l.a.device) as Pt, pos.get(l.b.device) as Pt]);
    for (const [a, b] of seg) total += Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
    if (seg.length <= 600) {
      const side = (p: Pt, q: Pt, r: Pt): number => {
        const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        return v > 0 ? 1 : v < 0 ? -1 : 0;
      };
      for (let i = 0; i < seg.length; i++) {
        for (let j = i + 1; j < seg.length; j++) {
          const [a, b] = seg[i];
          const [c, d] = seg[j];
          if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) total += CROSSING_COST;
        }
      }
    }
    return total;
  };
  /** what a round is built from: the placement before it and the order of every row */
  let best: { before: Map<string, Pt>; rows: string[][]; orders: Map<string, string[]> } = { before: new Map(), rows: rowLists().map((r) => r.slice()), orders: new Map() };
  const restore = (): void => {
    pos.clear();
    best.before.forEach((p, id) => pos.set(id, p));
    rowLists().forEach((r, i) => r.splice(0, r.length, ...best.rows[i]));
  };
  rootBlock().place(0, 0);
  let bestCost = cost();
  best.orders = orders;
  for (let i = 0; i < ROUNDS; i++) {
    const before = new Map(pos);
    sweep();
    const rows = rowLists().map((r) => r.slice());
    orders = new Map();
    rootBlock().place(0, 0);
    const c = cost();
    if (c < bestCost - 0.5) {
      bestCost = c;
      best = { before, rows, orders };
    }
  }
  // From the best round on, the order of the blocks in every layer is fixed.
  // Then try exchanging two blocks of a layer: a ring, for instance, has no
  // order that every cable agrees with, and an exchange can still shorten or
  // uncross the cabling. (Bounded, and skipped for very large models.)
  orders = best.orders;
  frozen = true;
  const place = (): number => {
    restore();
    rootBlock().place(0, 0);
    return cost();
  };
  place();
  if (input.devices.length <= 400) {
    let tries = 0;
    const keys = Array.from(orders.keys()).sort(cmp);
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      for (const k of keys) {
        const list = orders.get(k) as string[];
        for (let i = 0; i < list.length && tries < MAX_EXCHANGES; i++) {
          for (let j = i + 1; j < list.length && tries < MAX_EXCHANGES; j++) {
            tries++;
            [list[i], list[j]] = [list[j], list[i]];
            const c = place();
            if (c < bestCost - 0.5) {
              bestCost = c;
              improved = true;
            } else [list[i], list[j]] = [list[j], list[i]];
          }
        }
      }
      if (!improved) break;
    }
    place();
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
  // the same arrangement again, with the grown boxes
  restore();
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
export function sideLabelWidth(iface: string | undefined): number {
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
    /** the aggregate the port is a member of ('' for none) */
    lag: string;
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
      const e: Pending = { p, peer: { x: ob.cx, y: ob.cy }, slot: vertical ? portLabelWidth(me.iface) : 22, at: 0, list, lag: me.lag || '' };
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
    // (the members of an aggregate to the same peer next to each other)
    list.sort((u, v) => (horiz ? u.peer.x - v.peer.x : u.peer.y - v.peer.y) || cmp(u.lag, v.lag) || cmp(u.p.key, v.p.key));
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

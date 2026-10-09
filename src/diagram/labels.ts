/**
 * Drawing text and placing labels.
 *
 * Text is drawn in full, as one <text> with a <tspan> per line when it
 * wraps. Labels that float over the diagram (cable labels, relation labels,
 * addresses on membership lines) are placed by a LabelPlacer: each label has
 * a list of candidate positions in order of preference and takes the first
 * one that is free of nodes and of labels placed before it. Labels are
 * processed in a fixed order, so the result depends only on the model and
 * the node positions.
 */
import { Pt, Rect, rectsOverlap } from '../layout/geometry';
import { TextBlock, lineHeight } from '../layout/text';
import { VNode, h } from './scene';

type Attrs = { [name: string]: string | number | undefined | null | false };

/**
 * A block of text lines starting at `top`. One line is a plain <text>;
 * several lines are <tspan>s with absolute positions, so the file renders
 * the same in every SVG viewer.
 */
export function textLines(attrs: Attrs, block: TextBlock, x: number, top: number): VNode {
  const lh = lineHeight(block.size);
  // baseline of a line inside its line box
  const base = lh / 2 + block.size * 0.35;
  // address lines (from block.mono on) are drawn in the monospace font
  const mono = block.mono === undefined ? Infinity : block.mono;
  if (block.lines.length === 1) {
    const cls = mono === 0 ? ((attrs.class ? attrs.class + ' ' : '') + 'addr') : attrs.class;
    return h('text', { ...attrs, class: cls, x, y: top + base }, block.lines[0]);
  }
  return h(
    'text',
    { ...attrs, x, y: top + base },
    block.lines.map((l, i) => h('tspan', { class: i >= mono ? 'addr' : undefined, x, y: top + i * lh + base }, l)),
  );
}

export function centerRect(c: Pt, w: number, hgt: number): Rect {
  return { x: c.x - w / 2, y: c.y - hgt / 2, w, h: hgt };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const hgt = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && hgt > 0 ? w * hgt : 0;
}

export class LabelPlacer {
  /** rectangles labels must keep clear of: nodes, and labels placed so far */
  private taken: Rect[] = [];
  /** rectangles of the labels placed so far */
  readonly labels: Rect[] = [];

  /** Reserve a rectangle (a node, fixed text). */
  block(r: Rect): void {
    this.taken.push(r);
  }

  /** labels that could not be placed without covering something (see `place`) */
  conflicts = 0;
  /** where the last placed label was moved away from its candidates: the point it belongs to (draw a leader line) */
  leaderFrom: Pt | null = null;

  private area(c: Pt, w: number, hgt: number): number {
    const r = centerRect(c, w + 4, hgt + 4);
    let area = 0;
    for (const t of this.taken) {
      if (rectsOverlap(r, t)) area += overlapArea(r, t);
    }
    return area;
  }

  /**
   * Place a label of size w × h at the first candidate center that overlaps
   * nothing. If none is free, the nearest free spot around the first
   * candidate is searched for (rings of growing radius, fixed directions:
   * deterministic); the label is then connected to its place by a leader
   * line (`leaderFrom`). Only when even that finds nothing is the candidate
   * with the smallest overlap used, and counted in `conflicts`: a label is
   * never dropped.
   */
  place(candidates: Pt[], w: number, hgt: number): Pt {
    let best = candidates[0];
    let bestArea = Infinity;
    this.leaderFrom = null;
    for (const c of candidates) {
      const area = this.area(c, w, hgt);
      if (area === 0) {
        bestArea = 0;
        best = c;
        break;
      }
      if (area < bestArea) {
        bestArea = area;
        best = c;
      }
    }
    if (bestArea > 0) {
      const c0 = candidates[0];
      search: for (let r = 16; r <= 480; r += 16) {
        for (const [dx, dy] of RING) {
          const c = { x: c0.x + dx * (r + w / 2), y: c0.y + dy * (r + hgt / 2) };
          if (this.area(c, w, hgt) === 0) {
            best = c;
            bestArea = 0;
            this.leaderFrom = c0;
            break search;
          }
        }
      }
      if (bestArea > 0) this.conflicts++;
    }
    const r = centerRect(best, w, hgt);
    this.taken.push(r);
    this.labels.push(r);
    return best;
  }
}

/** 16 unit directions (k · 22.5°) as constants: no trigonometry, the same result in every browser. */
const RING: Array<[number, number]> = [
  [0, -1], [0, 1], [1, 0], [-1, 0],
  [0.7071067812, -0.7071067812], [-0.7071067812, -0.7071067812], [0.7071067812, 0.7071067812], [-0.7071067812, 0.7071067812],
  [0.3826834324, -0.9238795325], [-0.3826834324, -0.9238795325], [0.3826834324, 0.9238795325], [-0.3826834324, 0.9238795325],
  [0.9238795325, -0.3826834324], [-0.9238795325, -0.3826834324], [0.9238795325, 0.3826834324], [-0.9238795325, 0.3826834324],
];

/**
 * A thin line from the point a label belongs to, to the nearest point of
 * the label's rectangle (for a label that had to be placed further away).
 */
export function leaderLine(from: Pt, label: Rect, ref: string): VNode {
  const x = Math.max(label.x, Math.min(label.x + label.w, from.x));
  const y = Math.max(label.y, Math.min(label.y + label.h, from.y));
  return h('path', { class: 'leader', 'data-ref': ref, d: `M${Math.round(from.x * 10) / 10} ${Math.round(from.y * 10) / 10}L${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}` });
}

/**
 * Candidate label centers on the segment a->b: around the preferred point
 * first, then further along the segment in both directions, then beside it.
 */
export function alongSegment(a: Pt, b: Pt, at: number, along: number[], across: number[]): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const out: Pt[] = [];
  for (const k of across) {
    for (const t of along) {
      const d = Math.max(0, Math.min(len, at * len + t));
      out.push({ x: a.x + ux * d - uy * k, y: a.y + uy * d + ux * k });
    }
  }
  return out;
}

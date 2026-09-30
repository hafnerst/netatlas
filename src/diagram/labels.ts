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
  if (block.lines.length === 1) return h('text', { ...attrs, x, y: top + base }, block.lines[0]);
  return h(
    'text',
    { ...attrs, x, y: top + base },
    block.lines.map((l, i) => h('tspan', { x, y: top + i * lh + base }, l)),
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

  /**
   * Place a label of size w × h at the first candidate center that overlaps
   * nothing. If none is free, the candidate with the smallest overlap is
   * used: a label is never dropped.
   */
  place(candidates: Pt[], w: number, hgt: number): Pt {
    let best = candidates[0];
    let bestArea = Infinity;
    for (const c of candidates) {
      const r = centerRect(c, w + 4, hgt + 4);
      let area = 0;
      for (const t of this.taken) {
        if (rectsOverlap(r, t)) area += overlapArea(r, t);
      }
      if (area === 0) {
        best = c;
        break;
      }
      if (area < bestArea) {
        bestArea = area;
        best = c;
      }
    }
    const r = centerRect(best, w, hgt);
    this.taken.push(r);
    this.labels.push(r);
    return best;
  }
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

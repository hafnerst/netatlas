export interface Pt {
  x: number;
  y: number;
}

/** Axis-aligned box given by its center and size. */
export interface CBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Point where the ray from the box center toward `t` leaves the box. */
export function clipToBox(b: CBox, t: Pt, pad = 0): Pt {
  const dx = t.x - b.cx;
  const dy = t.y - b.cy;
  if (dx === 0 && dy === 0) return { x: b.cx, y: b.cy };
  const hw = b.w / 2 + pad;
  const hh = b.h / 2 + pad;
  const s = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return { x: b.cx + dx * s, y: b.cy + dy * s };
}

export function clipToCircle(c: Pt, r: number, t: Pt): Pt {
  const dx = t.x - c.x;
  const dy = t.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: c.x + (dx / d) * r, y: c.y + (dy / d) * r };
}

/**
 * Clip the infinite line through p->q against box b; returns the parameter t
 * (along p->q) where the segment leaves (fromStart=true) or enters the box.
 */
export function lineBoxExit(b: CBox, p: Pt, q: Pt, pad = 0): number | null {
  const x0 = b.cx - b.w / 2 - pad;
  const x1 = b.cx + b.w / 2 + pad;
  const y0 = b.cy - b.h / 2 - pad;
  const y1 = b.cy + b.h / 2 + pad;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let tmin = -Infinity;
  let tmax = Infinity;
  const clip = (d: number, a: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return a >= lo && a <= hi;
    let t0 = (lo - a) / d;
    let t1 = (hi - a) / d;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    return tmin <= tmax;
  };
  if (!clip(dx, p.x, x0, x1) || !clip(dy, p.y, y0, y1)) return null;
  return tmax;
}

export function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Unit normal (rotated +90°) of the direction a->b. */
export function normal(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: -dy / d, y: dx / d };
}

export function unionRect(rs: Rect[]): Rect {
  if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export { textWidth } from './text';

/** Do two rectangles overlap (touching edges don't count)? */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function boxRect(b: CBox, pad = 0): Rect {
  return { x: b.cx - b.w / 2 - pad, y: b.cy - b.h / 2 - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}

/** Does the segment a->b pass through the rectangle? (Liang-Barsky clipping) */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 <= t1;
}

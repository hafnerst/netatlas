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

/** Rough text width for the UI font at a given size (no DOM measuring needed). */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    w += /[ilj.,:;|!'\/1]/.test(c) ? 0.32 : /[mwMW@]/.test(c) ? 0.86 : /[A-Z0-9]/.test(c) ? 0.64 : 0.55;
  }
  return w * size;
}

export function ellipsize(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, m) + '…', size) <= maxW) lo = m;
    else hi = m - 1;
  }
  return s.slice(0, Math.max(1, lo)) + '…';
}

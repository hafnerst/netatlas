/**
 * The splitter between the diagram and the side panel: a visible handle on
 * the panel's left edge that sets the panel's width. Pointer: drag it (a
 * double-click resets the width). Keyboard: it is a focusable separator
 * (role="separator", aria-orientation vertical, its value the width in
 * pixels): ← widens the panel, → narrows it (Shift: in bigger steps), Home
 * and End go to the narrowest and widest, Enter resets. The width is kept
 * in this browser's local storage (never in the model) and limited so the
 * diagram keeps room: the stylesheet caps the column too, so a smaller
 * window never scrolls sideways. Below 860 px the panel is under the
 * diagram and the splitter is hidden.
 */

/** The default width of the side panel, and the narrower window's (≤ 1100 px). */
export const SIDE_DEFAULT = 480;
export const SIDE_DEFAULT_NARROW = 400;
/** The narrowest side panel, and the least room the diagram keeps beside it and the object list. */
export const SIDE_MIN = 320;
export const DIAGRAM_MIN = 360;
const STEP = 16;
const BIG_STEP = 64;
const KEY = 'netatlas.sideWidth';

/** The widest the side panel may be in a window this wide, with the object list this wide. */
export function sideMax(windowWidth: number, outlineWidth: number): number {
  return Math.max(SIDE_MIN, Math.floor(windowWidth - outlineWidth - DIAGRAM_MIN));
}

/** A width kept within its limits (whole pixels). */
export function clampSide(w: number, windowWidth: number, outlineWidth: number): number {
  return Math.max(SIDE_MIN, Math.min(sideMax(windowWidth, outlineWidth), Math.round(w)));
}

/** A stored width ('' or garbage: none). */
export function parseStoredWidth(v: string | null): number | null {
  if (!v || !/^\d{3,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= SIDE_MIN && n <= 4000 ? n : null;
}

export class Splitter {
  /** the width chosen by the user (null: the default) */
  private chosen: number | null = null;

  constructor(
    private doc: Document,
    private main: HTMLElement,
    private handle: HTMLElement,
    private side: HTMLElement,
    private outline: HTMLElement,
  ) {
    this.chosen = parseStoredWidth(this.read());
    this.apply();
    this.wire();
  }

  private win(): Window | null {
    return this.doc.defaultView;
  }

  private read(): string | null {
    try {
      const w = this.win();
      return w && w.localStorage ? w.localStorage.getItem(KEY) : null;
    } catch {
      return null;
    }
  }

  private store(v: number | null): void {
    try {
      const w = this.win();
      if (!w || !w.localStorage) return;
      if (v === null) w.localStorage.removeItem(KEY);
      else w.localStorage.setItem(KEY, String(v));
    } catch {
      /* no storage (file:// in some browsers, private windows): the width lasts for the session */
    }
  }

  /** The default for this window. */
  private defaultWidth(): number {
    const w = this.win();
    return w && w.innerWidth <= 1100 ? SIDE_DEFAULT_NARROW : SIDE_DEFAULT;
  }

  /** The width in effect (what the panel is, within the limits). */
  width(): number {
    const r = this.side.getBoundingClientRect();
    return r.width ? Math.round(r.width) : this.chosen || this.defaultWidth();
  }

  private limits(): { min: number; max: number } {
    const w = this.win();
    return { min: SIDE_MIN, max: sideMax(w ? w.innerWidth : 1440, this.outline.getBoundingClientRect().width || 250) };
  }

  /** Set the width (null: the default) and remember it. */
  set(w: number | null): void {
    if (w === null) this.chosen = null;
    else {
      const l = this.limits();
      this.chosen = Math.max(l.min, Math.min(l.max, Math.round(w)));
    }
    this.store(this.chosen);
    this.apply();
  }

  /** The column's width (the stylesheet caps it to the window) and the separator's value. */
  apply(): void {
    if (this.chosen === null) this.main.style.removeProperty('--side-w');
    else this.main.style.setProperty('--side-w', this.chosen + 'px');
    this.sync();
  }

  /** The separator's value and limits as they are now (after a resize of the window too). */
  sync(): void {
    const l = this.limits();
    const now = this.width();
    this.handle.setAttribute('aria-valuemin', String(l.min));
    this.handle.setAttribute('aria-valuemax', String(l.max));
    this.handle.setAttribute('aria-valuenow', String(now));
    this.handle.setAttribute('aria-valuetext', `${now} pixels wide`);
  }

  private wire(): void {
    const h = this.handle;
    h.addEventListener('keydown', (e) => {
      const l = this.limits();
      const cur = this.width();
      const step = e.shiftKey ? BIG_STEP : STEP;
      let next: number | null | undefined;
      if (e.key === 'ArrowLeft') next = cur + step;
      else if (e.key === 'ArrowRight') next = cur - step;
      else if (e.key === 'Home') next = l.min;
      else if (e.key === 'End') next = l.max;
      else if (e.key === 'Enter') next = null;
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.set(next);
    });
    h.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.set(null);
    });
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      h.focus();
      h.setPointerCapture(e.pointerId);
      // relative to where the drag began: grabbing the handle anywhere never makes the panel jump
      const startW = this.width();
      const startX = e.clientX;
      h.classList.add('dragging');
      const move = (ev: PointerEvent): void => this.set(startW + (startX - ev.clientX));
      const up = (): void => {
        h.classList.remove('dragging');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    const w = this.win();
    if (w) w.addEventListener('resize', () => this.sync());
  }
}

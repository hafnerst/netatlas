/**
 * Tool windows: the non-modal windows of Analyze and Simulate (the
 * addressing overview, focus, trace path, single points of failure, the
 * simulation). One is open at a time; opening another replaces it. The
 * diagram stays visible and usable beside it.
 *
 *   * role="dialog" without aria-modal, labelled by its title; the rest of
 *     the page stays reachable. F6 moves the keyboard focus between the
 *     window and where it was in the main window. Esc inside it, or ×,
 *     closes it; the focus goes back to where it came from.
 *   * Floating: moved by dragging its title bar, or with the arrow keys on
 *     its move handle (Shift: bigger steps); resized by the grip in its
 *     corner, or with the arrow keys on the grip. Docked: a full-width panel
 *     at the bottom of the window, above the status bar, part of the page's
 *     layout (it takes room, it never covers it); its height is changed the
 *     same way. Narrow windows (860 px or less) always dock.
 *   * Collapse folds it to its title bar.
 *   * Size, position, docking and collapsing are remembered per window in
 *     this browser's local storage (never in the model), and kept inside
 *     the browser window whatever its size: nothing scrolls the page.
 */
import { el } from './dom';

export interface ToolWindowOpts {
  /** names the window: its remembered geometry, data-window */
  id: string;
  title: string;
  body: HTMLElement;
  /** the default size (floating) */
  width: number;
  height: number;
  /** the element (a selector inside the body) that gets the focus on opening; default: the first control */
  focus?: string;
  /** called once when it closes (closed by the user, or replaced by another window) */
  onClose?: () => void;
}

interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
  docked: boolean;
  collapsed: boolean;
  /** the height when docked */
  dh: number;
}

/** Windows narrower than this always dock at the bottom. */
export const DOCK_BELOW = 860;
const MIN_W = 300;
const MIN_H = 160;
const STEP = 16;
const BIG = 64;
const KEY = 'netatlas.window.';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class ToolWindows {
  private win: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private dockBtn: HTMLButtonElement;
  private collapseBtn: HTMLButtonElement;
  private moveBtn: HTMLButtonElement;
  private grip: HTMLButtonElement;
  private opts: ToolWindowOpts | null = null;
  private geo: Geometry | null = null;
  /** where the focus was in the main window (F6 and closing return there) */
  private mainFocus: Element | null = null;
  /** where it was in the tool window (F6 returns there) */
  private winFocus: Element | null = null;

  constructor(
    private doc: Document,
    /** after the window opens, closes, docks or changes size: the app lays out again (the diagram's room changes when docked) */
    private onLayout: () => void,
  ) {
    const d = doc;
    this.titleEl = el(d, 'h2', { id: 'tw-title', class: 'tw-title' });
    this.moveBtn = el(d, 'button', { type: 'button', class: 'tw-btn tw-move', 'aria-label': 'Move the window (arrow keys)', title: 'Move: drag the title bar, or focus this and use the arrow keys (Shift: faster)' }, ['⠿']) as HTMLButtonElement;
    this.dockBtn = el(d, 'button', { type: 'button', class: 'tw-btn tw-dock', 'aria-pressed': 'false' }, ['Dock']) as HTMLButtonElement;
    this.collapseBtn = el(d, 'button', { type: 'button', class: 'tw-btn tw-collapse', 'aria-expanded': 'true', 'aria-controls': 'tw-body' }, ['▾']) as HTMLButtonElement;
    const close = el(d, 'button', { type: 'button', class: 'tw-btn tw-close', 'aria-label': 'Close the window', title: 'Close (Esc)' }, ['×']) as HTMLButtonElement;
    const head = el(d, 'div', { class: 'tw-head' }, [this.moveBtn, this.titleEl, el(d, 'span', { class: 'tw-tools' }, [this.dockBtn, this.collapseBtn, close])]);
    this.bodyEl = el(d, 'div', { id: 'tw-body', class: 'tw-body' });
    this.grip = el(d, 'button', { type: 'button', class: 'tw-grip', 'aria-label': 'Resize the window (arrow keys)', title: 'Resize: drag, or focus this and use the arrow keys (Shift: faster)' }, ['◢']) as HTMLButtonElement;
    this.win = el(d, 'section', { id: 'toolwin', class: 'toolwin', role: 'dialog', 'aria-labelledby': 'tw-title', hidden: '' }, [head, this.bodyEl, this.grip]);
    const status = d.getElementById('status');
    d.body.insertBefore(this.win, status);
    close.addEventListener('click', () => this.close());
    this.dockBtn.addEventListener('click', () => this.setDocked(!(this.geo as Geometry).docked));
    this.collapseBtn.addEventListener('click', () => this.setCollapsed(!(this.geo as Geometry).collapsed));
    this.win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.win.addEventListener('focusin', (e) => {
      this.winFocus = e.target as Element;
    });
    // where the focus is in the main window, for F6 and for closing
    d.addEventListener('focusin', (e) => {
      const t = e.target as Element;
      if (!this.win.contains(t) && t !== d.body && !t.closest('dialog')) this.mainFocus = t;
    });
    this.wireMove();
    this.wireResize();
    const w = d.defaultView;
    if (w) w.addEventListener('resize', () => this.place());
  }

  /** The open window's id ('' = none). */
  current(): string {
    return this.opts ? this.opts.id : '';
  }

  /** The open window's body (to update its content), or null. */
  body(): HTMLElement | null {
    return this.opts ? this.bodyEl : null;
  }

  /** Open a window (replacing the one that is open). */
  open(o: ToolWindowOpts): void {
    const active = this.doc.activeElement;
    const fromMain = !!active && !this.win.contains(active) && active !== this.doc.body;
    this.closeQuietly();
    if (fromMain) this.mainFocus = active;
    this.opts = o;
    this.geo = this.load(o);
    this.win.setAttribute('data-window', o.id);
    this.titleEl.textContent = o.title;
    while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
    this.bodyEl.appendChild(o.body);
    this.win.hidden = false;
    this.place();
    this.focusInside(o.focus);
  }

  /** Replace the body of the open window (keeps its place and the focus where it can). */
  setBody(body: HTMLElement): void {
    if (!this.opts) return;
    while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
    this.bodyEl.appendChild(body);
  }

  private focusInside(sel?: string): void {
    const g = this.geo as Geometry;
    const target = (g.collapsed ? null : sel ? (this.bodyEl.querySelector(sel) as HTMLElement | null) : null) || (g.collapsed ? null : (this.bodyEl.querySelector(FOCUSABLE) as HTMLElement | null)) || this.collapseBtn;
    target.focus({ preventScroll: true });
  }

  /** Close the open window; the focus goes back to where it was in the main window. */
  close(): void {
    if (!this.opts) return;
    const inside = this.win.contains(this.doc.activeElement);
    this.closeQuietly();
    if (inside || this.doc.activeElement === this.doc.body) this.returnFocus();
  }

  private closeQuietly(): void {
    const o = this.opts;
    if (!o) return;
    this.opts = null;
    this.geo = null;
    this.win.hidden = true;
    this.win.removeAttribute('data-window');
    this.doc.body.classList.remove('tw-docked');
    while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
    this.onLayout();
    if (o.onClose) o.onClose();
  }

  private returnFocus(): void {
    const m = this.mainFocus as HTMLElement | null;
    if (m && this.doc.contains(m) && typeof m.focus === 'function' && !(m as HTMLButtonElement).disabled) m.focus();
    else {
      const c = this.doc.getElementById('canvas') as unknown as HTMLElement | null;
      if (c) c.focus();
    }
  }

  /** F6: from the main window into the tool window (where the focus was), or back. Returns whether a window is open. */
  toggleFocus(): boolean {
    if (!this.opts) return false;
    if (this.win.contains(this.doc.activeElement)) this.returnFocus();
    else {
      const w = this.winFocus as HTMLElement | null;
      if (w && this.win.contains(w) && w.getClientRects().length) w.focus();
      else this.focusInside(this.opts.focus);
    }
    return true;
  }

  // ------------------------------------------------------------ geometry

  private narrow(): boolean {
    const w = this.doc.defaultView;
    return !!w && w.innerWidth <= DOCK_BELOW;
  }

  private load(o: ToolWindowOpts): Geometry {
    const w = this.doc.defaultView;
    const vw = w ? w.innerWidth : 1440;
    const vh = w ? w.innerHeight : 900;
    const def: Geometry = { w: o.width, h: o.height, x: Math.max(8, vw - o.width - 24), y: 120, docked: false, collapsed: false, dh: Math.round(vh * 0.38) };
    try {
      const raw = w && w.localStorage ? w.localStorage.getItem(KEY + o.id) : null;
      const g = raw ? JSON.parse(raw) : null;
      if (g && ['x', 'y', 'w', 'h', 'dh'].every((k) => typeof g[k] === 'number' && isFinite(g[k]))) return { x: g.x, y: g.y, w: g.w, h: g.h, dh: g.dh, docked: !!g.docked, collapsed: !!g.collapsed };
    } catch {
      /* no storage, or something else stored: the default */
    }
    return def;
  }

  private save(): void {
    if (!this.opts || !this.geo) return;
    try {
      const w = this.doc.defaultView;
      if (w && w.localStorage) w.localStorage.setItem(KEY + this.opts.id, JSON.stringify(this.geo));
    } catch {
      /* no storage: it lasts for the session */
    }
  }

  /** Is the window docked now (chosen, or a narrow browser window)? */
  docked(): boolean {
    return !!this.geo && (this.geo.docked || this.narrow());
  }

  /** Apply the geometry, kept inside the browser window. */
  private place(): void {
    const g = this.geo;
    if (!g || !this.opts) return;
    const w = this.doc.defaultView;
    const vw = w ? this.doc.documentElement.clientWidth : 1440;
    const vh = w ? this.doc.documentElement.clientHeight : 900;
    const dock = this.docked();
    this.doc.body.classList.toggle('tw-docked', dock);
    this.win.classList.toggle('docked', dock);
    this.win.classList.toggle('collapsed', g.collapsed);
    this.bodyEl.hidden = g.collapsed;
    this.collapseBtn.setAttribute('aria-expanded', g.collapsed ? 'false' : 'true');
    this.collapseBtn.setAttribute('aria-label', g.collapsed ? 'Expand the window' : 'Collapse the window to its title bar');
    this.collapseBtn.title = g.collapsed ? 'Expand' : 'Collapse to the title bar';
    this.collapseBtn.textContent = g.collapsed ? '▸' : '▾';
    this.dockBtn.setAttribute('aria-pressed', dock ? 'true' : 'false');
    this.dockBtn.disabled = this.narrow();
    this.dockBtn.textContent = dock ? 'Float' : 'Dock';
    this.dockBtn.title = this.narrow() ? 'In a narrow window it is always docked at the bottom' : dock ? 'Float the window over the diagram' : 'Dock the window at the bottom, under the diagram';
    this.dockBtn.setAttribute('aria-label', dock ? 'Float the window' : 'Dock the window at the bottom');
    this.moveBtn.hidden = dock;
    const st = this.win.style;
    if (dock) {
      // part of the page's layout: under the diagram, never more than half the browser window, and never so tall that
      // the toolbar (which wraps onto more rows in a small window), the diagram (90 px at least) and the status bar don't fit
      const bar = this.doc.querySelector('.topbar') as HTMLElement | null;
      const status = this.doc.getElementById('status');
      const room = vh - (bar ? bar.offsetHeight : 0) - (status ? status.offsetHeight : 0) - 90;
      g.dh = Math.max(120, Math.min(Math.round(vh * 0.5), g.dh));
      st.left = st.top = st.width = '';
      st.height = g.collapsed ? '' : Math.max(60, Math.min(g.dh, room)) + 'px';
    } else {
      g.w = Math.max(MIN_W, Math.min(vw - 16, g.w));
      g.h = Math.max(MIN_H, Math.min(vh - 16, g.h));
      g.x = Math.max(8, Math.min(vw - g.w - 8, g.x));
      g.y = Math.max(8, Math.min(vh - (g.collapsed ? 40 : g.h) - 8, g.y));
      st.left = g.x + 'px';
      st.top = g.y + 'px';
      st.width = g.w + 'px';
      st.height = g.collapsed ? '' : g.h + 'px';
    }
    this.save();
    this.onLayout();
  }

  setDocked(on: boolean): void {
    if (!this.geo) return;
    this.geo.docked = on;
    this.place();
    this.dockBtn.focus();
  }

  setCollapsed(on: boolean): void {
    if (!this.geo) return;
    this.geo.collapsed = on;
    this.place();
    this.collapseBtn.focus();
  }

  /** Move by (dx, dy) (floating). */
  moveBy(dx: number, dy: number): void {
    const g = this.geo;
    if (!g || this.docked()) return;
    g.x += dx;
    g.y += dy;
    this.place();
  }

  /** Resize by (dw, dh): floating its width and height; docked its height (growing upwards). */
  resizeBy(dw: number, dh: number): void {
    const g = this.geo;
    if (!g) return;
    if (this.docked()) g.dh -= dh;
    else {
      g.w += dw;
      g.h += dh;
    }
    this.place();
  }

  /** The geometry in effect (tests). */
  geometry(): Geometry | null {
    return this.geo ? { ...this.geo } : null;
  }

  private wireMove(): void {
    const arrows = (e: KeyboardEvent, fn: (dx: number, dy: number) => void): boolean => {
      const s = e.shiftKey ? BIG : STEP;
      const d: { [k: string]: [number, number] } = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] };
      const v = d[e.key];
      if (!v) return false;
      e.preventDefault();
      e.stopPropagation();
      fn(v[0], v[1]);
      return true;
    };
    this.moveBtn.addEventListener('keydown', (e) => void arrows(e, (dx, dy) => this.moveBy(dx, dy)));
    this.grip.addEventListener('keydown', (e) => void arrows(e, (dx, dy) => this.resizeBy(dx, dy)));
    // dragging the title bar (not its buttons)
    const head = this.win.querySelector('.tw-head') as HTMLElement;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.docked() || (e.target as Element).closest('.tw-tools')) return;
      const g = this.geo as Geometry;
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = g.x;
      const oy = g.y;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        g.x = ox + ev.clientX - sx;
        g.y = oy + ev.clientY - sy;
        this.place();
      };
      const up = (): void => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  private wireResize(): void {
    this.grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const g = this.geo as Geometry;
      const sx = e.clientX;
      const sy = e.clientY;
      const ow = g.w;
      const oh = g.h;
      const odh = g.dh;
      this.grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        if (this.docked()) g.dh = odh - (ev.clientY - sy);
        else {
          g.w = ow + ev.clientX - sx;
          g.h = oh + ev.clientY - sy;
        }
        this.place();
      };
      const up = (): void => {
        this.grip.removeEventListener('pointermove', move);
        this.grip.removeEventListener('pointerup', up);
        this.grip.removeEventListener('pointercancel', up);
      };
      this.grip.addEventListener('pointermove', move);
      this.grip.addEventListener('pointerup', up);
      this.grip.addEventListener('pointercancel', up);
    });
  }
}

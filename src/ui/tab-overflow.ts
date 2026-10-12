/**
 * The side panel's tabs in a very short window (400 px high or less: a
 * small or strongly zoomed window). There the panel has too little height
 * for the tabs to wrap onto a second row, so they stay on one row, and the
 * tabs that don't fit move into a **More ▾** menu at the row's end. The
 * active tab always stays on the row. Elsewhere the tabs wrap (CSS) and the
 * menu is hidden. The menu hangs in the page, outside the panel (which clips
 * what overflows it), positioned under its button and kept in the window;
 * ↑ ↓ Home End move through it, Enter picks, Esc and Tab close it.
 */
import { el } from './dom';

/** The window is short enough for one row of tabs. */
export const SHORT_QUERY = '(max-height: 400px)';

export class TabOverflow {
  private wrap: HTMLElement;
  private btn: HTMLButtonElement;
  private menu: HTMLElement;

  constructor(
    private doc: Document,
    private nav: HTMLElement,
    private pick: (tab: string) => void,
  ) {
    this.btn = el(doc, 'button', { type: 'button', id: 'tabs-more-btn', class: 'tabs-more-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'tabs-more-menu' }, ['More', el(doc, 'span', { class: 'caret', 'aria-hidden': 'true' }, [' ▾'])]) as HTMLButtonElement;
    this.wrap = el(doc, 'div', { class: 'tabs-more', hidden: '' }, [this.btn]);
    nav.appendChild(this.wrap);
    this.menu = el(doc, 'div', { id: 'tabs-more-menu', class: 'dropdown menu tabs-more-menu', role: 'menu', 'aria-label': 'More tabs', hidden: '' });
    doc.body.appendChild(this.menu);
    this.wire();
  }

  private open(focus: boolean): void {
    this.menu.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    const r = this.btn.getBoundingClientRect();
    const vw = this.doc.documentElement.clientWidth;
    const vh = this.doc.documentElement.clientHeight;
    const m = this.menu.getBoundingClientRect();
    // under the button, else above it; never past the window's edges
    const below = r.bottom + 2;
    const top = below + m.height <= vh - 4 ? below : Math.max(4, r.top - 2 - m.height);
    this.menu.style.top = Math.round(top) + 'px';
    this.menu.style.left = Math.round(Math.max(4, Math.min(r.right - m.width, vw - 4 - m.width))) + 'px';
    if (focus) {
      const first = this.menu.querySelector('button') as HTMLElement | null;
      if (first) first.focus();
    }
  }

  close(back = false): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    if (back) this.btn.focus();
  }

  private wire(): void {
    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.menu.hidden) this.open((e as MouseEvent).detail === 0);
      else this.close();
    });
    this.btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.open(true);
      }
    });
    this.menu.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('[data-tab-pick]');
      if (!b) return;
      this.close();
      this.pick(b.getAttribute('data-tab-pick') as string);
    });
    this.menu.addEventListener('keydown', (e) => {
      const items = Array.prototype.slice.call(this.menu.querySelectorAll('button')) as HTMLElement[];
      const at = items.indexOf(this.doc.activeElement as HTMLElement);
      let to: HTMLElement | undefined;
      if (e.key === 'ArrowDown') to = items[(at + 1) % items.length];
      else if (e.key === 'ArrowUp') to = items[(at - 1 + items.length) % items.length];
      else if (e.key === 'Home') to = items[0];
      else if (e.key === 'End') to = items[items.length - 1];
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
        return;
      } else if (e.key === 'Tab') {
        this.close();
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (to) to.focus();
    });
    this.doc.addEventListener('pointerdown', (e) => {
      const t = e.target as Element;
      if (!this.menu.contains(t) && !this.wrap.contains(t)) this.close();
    });
  }

  /**
   * Lay out the tabs for the window as it is: wrapping rows (normal), or
   * one row with the rest in More ▾ (short). `active`: the tab shown.
   */
  layout(active: string): void {
    const win = this.doc.defaultView;
    const tabs = (Array.prototype.slice.call(this.nav.querySelectorAll('button[data-tab]')) as HTMLButtonElement[]);
    for (const t of tabs) t.hidden = false;
    const short = !!win && typeof win.matchMedia === 'function' && win.matchMedia(SHORT_QUERY).matches && this.nav.getClientRects().length > 0;
    this.nav.classList.toggle('one-row', short);
    this.wrap.hidden = true;
    if (!short) {
      this.close();
      return;
    }
    const avail = this.nav.clientWidth - (parseFloat(win!.getComputedStyle(this.nav).paddingLeft) || 0) - 1;
    const widths = tabs.map((t) => t.getBoundingClientRect().width);
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum <= avail) {
      this.close();
      return;
    }
    this.wrap.hidden = false;
    const room = avail - this.wrap.getBoundingClientRect().width;
    // the active tab first, then the others in their order, while they fit
    const keep = new Set<number>();
    let used = 0;
    const ai = tabs.findIndex((t) => t.getAttribute('data-tab') === active);
    if (ai >= 0) {
      keep.add(ai);
      used += widths[ai];
    }
    // (in their order up to the first that doesn't fit: the row is always the first tabs, plus the active one)
    let full = false;
    tabs.forEach((_, i) => {
      if (full || keep.has(i)) return;
      if (used + widths[i] > room) {
        full = true;
        return;
      }
      keep.add(i);
      used += widths[i];
    });
    const hidden: HTMLButtonElement[] = [];
    tabs.forEach((t, i) => {
      if (keep.has(i)) return;
      t.hidden = true;
      hidden.push(t);
    });
    while (this.menu.firstChild) this.menu.removeChild(this.menu.firstChild);
    for (const t of hidden) this.menu.appendChild(el(this.doc, 'button', { type: 'button', role: 'menuitem', 'data-tab-pick': t.getAttribute('data-tab') as string }, [t.textContent || '']));
    this.btn.setAttribute('aria-label', `More tabs: ${hidden.map((t) => t.textContent).join(', ')}`);
  }
}

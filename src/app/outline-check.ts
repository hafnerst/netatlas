/**
 * The Objects list's section headings stay where they are when a section is
 * folded or unfolded (by the pointer, by the keyboard, all at once): the
 * heading keeps its position, height, width, padding, caret, title and count;
 * the sections above it don't move; the sections below it move only up or
 * down. Focus styling takes no room and the keyboard focus stays on the
 * heading. Used by the self-test (public and full) and the viewport check,
 * which runs it at every window size and zoom factor.
 */
import { App } from '../ui/app';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A small model with every kind of section: several devices (populated), one
 * cable with an error (a folded section shows its badge), no networks (empty),
 * a relation, a group and a protocol of the model.
 */
export const OUTLINE_MODEL = `netatlas: 1
title: Objects list check
groups:
  - {id: site, label: Site}
devices:
${Array.from({ length: 14 }, (_, i) => `  - {id: d${i + 1}, type: router, group: site, interfaces: [{id: e0, ip: 10.0.${i}.1/24}]}`).join('\n')}
links:
  - {id: l1, a: "d1:e0", b: "d2:nope"}
relations:
  - {id: r1, protocol: ospf, endpoints: [d1, d2]}
protocols:
  - {id: macsec, label: MACsec, layer: 2}
`;

interface Geo {
  y: number;
  x: number;
  h: number;
  w: number;
  toggleH: number;
  toggleW: number;
  pad: string;
  caretX: number;
  caretW: number;
  titleX: number;
  addX: number;
  outlineW: number;
}

/** The layout box of a section's heading (transforms, such as the folded caret's turn, are not layout). */
function geo(doc: Document, kind: string): Geo | null {
  const sec = doc.querySelector(`#outline [data-section="${kind}"]`) as HTMLElement | null;
  if (!sec) return null;
  const head = sec.querySelector('.ol-head') as HTMLElement;
  const toggle = sec.querySelector('.ol-toggle') as HTMLElement;
  const caret = sec.querySelector('.ol-caret') as HTMLElement;
  const title = sec.querySelector('.ol-title') as HTMLElement;
  const add = sec.querySelector('[data-act="add-entity"]') as HTMLElement;
  const outline = doc.getElementById('outline') as HTMLElement;
  const r = head.getBoundingClientRect();
  const t = toggle.getBoundingClientRect();
  const cs = doc.defaultView!.getComputedStyle(head);
  return {
    y: r.top,
    x: r.left,
    h: r.height,
    w: r.width,
    toggleH: t.height,
    toggleW: t.width,
    pad: cs.padding,
    caretX: caret.offsetLeft,
    caretW: caret.offsetWidth,
    titleX: title.offsetLeft,
    addX: add.getBoundingClientRect().left - r.left,
    outlineW: outline.clientWidth,
  };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5;

/** What differs between two headings' geometry; with `moveY`, a vertical move is allowed. */
function diff(a: Geo, b: Geo, moveY: boolean): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as Array<keyof Geo>) {
    if (k === 'y' && moveY) continue;
    const va = a[k];
    const vb = b[k];
    if (typeof va === 'number' ? !near(va, vb as number) : va !== vb) out.push(`${k} ${typeof va === 'number' ? (va as number).toFixed(1) : va} → ${typeof vb === 'number' ? (vb as number).toFixed(1) : vb}`);
  }
  return out;
}

/**
 * Fold and unfold each section of the Objects list, by a click and by the keyboard, and fold all;
 * returns the problems found (empty: the headings stand still). The caller loads nothing: this
 * loads its own small model and leaves it loaded.
 */
export async function outlineStability(app: App, doc: Document): Promise<string[]> {
  const why: string[] = [];
  app.loadText(OUTLINE_MODEL, 'outline-check.yaml', 'example');
  app.select(null);
  await tick(20);
  const kinds = Array.prototype.map.call(doc.querySelectorAll('#outline [data-section]'), (s: Element) => s.getAttribute('data-section') || '') as string[];
  if (kinds.length < 6) why.push(`only ${kinds.length} sections`);
  const all = (): Map<string, Geo> => {
    const m = new Map<string, Geo>();
    for (const k of kinds) {
      const g = geo(doc, k);
      if (g) m.set(k, g);
    }
    return m;
  };
  const outline = doc.getElementById('outline') as HTMLElement;
  // every section starts open, the list at its top
  app.setOutlineFolded([]);
  outline.scrollTop = 0;
  await tick(10);
  const toggle = (kind: string, keyboard: boolean): void => {
    const b = doc.querySelector(`#outline [data-act="fold"][data-kind="${kind}"]`) as HTMLElement | null;
    if (!b) return;
    // (focusing scrolls a small list to the heading: what is compared is the layout, at the same scroll position)
    if (keyboard) b.focus({ preventScroll: true });
    b.click();
  };
  for (const keyboard of [false, true]) {
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      outline.scrollTop = 0;
      await tick(5);
      const before = all();
      const n = (doc.querySelector(`#outline [data-section="${kind}"] .ol-title`) as HTMLElement).textContent || '';
      for (const step of ['fold', 'unfold']) {
        toggle(kind, keyboard);
        await tick(10);
        outline.scrollTop = 0;
        await tick(5);
        const after = all();
        const sec = doc.querySelector(`#outline [data-section="${kind}"]`) as HTMLElement;
        const btn = sec.querySelector('.ol-toggle') as HTMLElement;
        const folded = step === 'fold';
        const how = `${n} ${step}ed ${keyboard ? 'by the keyboard' : 'by a click'}`;
        if (btn.getAttribute('aria-expanded') !== (folded ? 'false' : 'true')) why.push(`${how}: aria-expanded is ${btn.getAttribute('aria-expanded')}`);
        if (keyboard && doc.activeElement !== btn) why.push(`${how}: the keyboard focus left the heading`);
        for (let j = 0; j < kinds.length; j++) {
          const a = before.get(kinds[j]);
          const b = after.get(kinds[j]);
          if (!a || !b) continue;
          // the toggled heading and those above it stand still; those below may move up or down only
          const d = diff(a, b, j > i && folded);
          if (step === 'unfold' && j > i) d.push(...(near(a.y, b.y) ? [] : [`y ${a.y.toFixed(1)} → ${b.y.toFixed(1)}`]));
          if (d.length) why.push(`${how}: the heading of ${kinds[j]} changed: ${d.join(', ')}`);
        }
      }
    }
  }
  // focus styling takes no room
  {
    const kind = kinds[0];
    const b = doc.querySelector(`#outline [data-act="fold"][data-kind="${kind}"]`) as HTMLElement;
    (doc.activeElement as HTMLElement | null)?.blur?.();
    await tick(5);
    const plain = all();
    b.focus({ preventScroll: true });
    outline.scrollTop = 0;
    await tick(5);
    const focused = all();
    for (const k of kinds) {
      const d = diff(plain.get(k)!, focused.get(k)!, false);
      if (d.length) why.push(`focus on the ${kind} heading changed the heading of ${k}: ${d.join(', ')}`);
    }
    const st = doc.defaultView!.getComputedStyle(b);
    if (st.outlineStyle === 'none' && st.boxShadow === 'none') why.push('the focused heading shows no focus');
    b.blur();
  }
  // fold all, then expand all: every heading back where it was; the list's width (its scrollbar) unchanged
  {
    outline.scrollTop = 0;
    await tick(5);
    const open = all();
    const foldAll = doc.querySelector('#outline [data-act="fold-all"]') as HTMLElement;
    foldAll.focus({ preventScroll: true });
    foldAll.click();
    await tick(10);
    const closed = all();
    for (const k of kinds) {
      const d = diff(open.get(k)!, closed.get(k)!, true).filter((x) => !/^y /.test(x));
      if (d.length) why.push(`Collapse all changed the heading of ${k}: ${d.join(', ')}`);
    }
    if (doc.activeElement !== doc.querySelector('#outline [data-act="fold-all"]')) why.push('Collapse all: the keyboard focus left the button');
    (doc.querySelector('#outline [data-act="fold-all"]') as HTMLElement).click();
    await tick(10);
    outline.scrollTop = 0;
    await tick(5);
    const again = all();
    for (const k of kinds) {
      const d = diff(open.get(k)!, again.get(k)!, false);
      if (d.length) why.push(`Expand all left the heading of ${k} changed: ${d.join(', ')}`);
    }
  }
  return why;
}

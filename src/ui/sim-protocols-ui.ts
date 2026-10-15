/**
 * The protocol checkboxes of a simulation, grouped by layer (Layer 2,
 * Routing, Redundancy, Tunnels and overlays, Multicast, Services, Traffic,
 * Custom): one checkbox per protocol the model uses, with how many devices,
 * relations, demands or streams use it; each group's header says how many
 * of its protocols are selected ("Routing (3 of 4)") and has Select all
 * and Clear; Select all and Clear for every protocol head the list. The
 * same list is the Start simulation dialog's and the Simulation setup
 * panel's (the protocols shown: their dots and log lines). Only the list
 * scrolls; the headers stay put.
 */
import { ENTRY_GROUPS, SimEntryGroup, SimProtocolEntry, usesText } from '../analysis/sim/simulation';
import { el } from './dom';

export interface ProtocolPickerOpts {
  /** a prefix for the element ids (the dialog's and the panel's lists can be on the page together) */
  id: string;
  entries: SimProtocolEntry[];
  /** the protocols checked at first */
  shown: Set<string>;
  color: (protocol: string) => string;
  /** the selection changed (a box, a group's or the list's Select all / Clear) */
  onChange?: (shown: Set<string>) => void;
  /** a heading level for the title ("h2" in a panel, "h3" in the dialog) */
  heading?: 'h2' | 'h3';
}

export interface ProtocolPicker {
  el: HTMLElement;
  /** the protocols checked */
  selected(): Set<string>;
  /** check exactly these (a change elsewhere) */
  set(shown: Set<string>): void;
  /** the first protocol's checkbox */
  first(): HTMLInputElement | null;
}

/** The checkbox id of a protocol in a list. */
export function protoBoxId(prefix: string, protocol: string): string {
  return prefix + '-p-' + protocol.replace(/[^a-z0-9-]/gi, '_');
}

export function protocolPicker(doc: Document, o: ProtocolPickerOpts): ProtocolPicker {
  const sel = new Set(Array.from(o.shown).filter((p) => o.entries.some((e) => e.id === p)));
  const titleId = o.id + '-title';
  const count = el(doc, 'span', { class: 'pp-count' }, ['']);
  const all = el(doc, 'button', { type: 'button', class: 'mini', id: o.id + '-all' }, ['Select all']) as HTMLButtonElement;
  const none = el(doc, 'button', { type: 'button', class: 'mini', id: o.id + '-none' }, ['Clear']) as HTMLButtonElement;
  const head = el(doc, 'div', { class: 'pp-head' }, [el(doc, o.heading || 'h3', { class: 'pp-title', id: titleId }, ['Protocols ', count]), el(doc, 'span', { class: 'pp-tools' }, [all, none])]);
  const list = el(doc, 'div', { class: 'pp-list', role: 'group', 'aria-labelledby': titleId, id: o.id + '-list' });
  const groups: Array<{ g: SimEntryGroup; ids: string[]; count: HTMLElement; all: HTMLButtonElement; none: HTMLButtonElement }> = [];
  const boxes = new Map<string, HTMLInputElement>();
  for (const g of ENTRY_GROUPS) {
    const es = o.entries.filter((e) => e.group === g);
    if (!es.length) continue;
    const gid = `${o.id}-g-${g.replace(/[^a-z0-9]/gi, '_')}`;
    const gc = el(doc, 'span', { class: 'pp-gcount' }, ['']);
    const ga = el(doc, 'button', { type: 'button', class: 'mini pp-gbtn', 'data-group-all': g }, ['Select all']) as HTMLButtonElement;
    const gn = el(doc, 'button', { type: 'button', class: 'mini pp-gbtn', 'data-group-none': g }, ['Clear']) as HTMLButtonElement;
    const fs = el(doc, 'div', { class: 'pp-group', role: 'group', 'aria-labelledby': gid, 'data-group': g }, [
      el(doc, 'div', { class: 'pp-ghead' }, [el(doc, 'span', { class: 'pp-gname', id: gid }, [g + ' ', gc]), el(doc, 'span', { class: 'pp-gtools' }, [ga, gn])]),
    ]);
    for (const e of es) {
      const cb = el(doc, 'input', { type: 'checkbox', 'data-sim-proto': e.id, id: protoBoxId(o.id, e.id) }) as HTMLInputElement;
      boxes.set(e.id, cb);
      fs.appendChild(
        el(doc, 'label', { class: 'check pp-item', for: cb.id }, [
          cb,
          el(doc, 'span', { class: 'sim-swatch', 'aria-hidden': 'true', style: `background:${o.color(e.id)}` }),
          el(doc, 'span', { class: 'pp-name' }, [e.label]),
          el(doc, 'span', { class: 'pp-uses' }, [usesText(e)]),
        ]),
      );
    }
    list.appendChild(fs);
    groups.push({ g, ids: es.map((e) => e.id), count: gc, all: ga, none: gn });
  }
  const root = el(doc, 'section', { class: 'pp', id: o.id, 'aria-labelledby': titleId }, [head, list]);

  const sync = (): void => {
    for (const [id, cb] of boxes) cb.checked = sel.has(id);
    count.textContent = `(${sel.size} of ${o.entries.length})`;
    all.disabled = sel.size === o.entries.length;
    none.disabled = sel.size === 0;
    for (const gr of groups) {
      const n = gr.ids.filter((id) => sel.has(id)).length;
      gr.count.textContent = `(${n} of ${gr.ids.length})`;
      gr.all.disabled = n === gr.ids.length;
      gr.none.disabled = n === 0;
      gr.all.setAttribute('aria-label', `Select all ${gr.g} protocols`);
      gr.none.setAttribute('aria-label', `Clear the ${gr.g} protocols`);
    }
  };
  const changed = (): void => {
    sync();
    if (o.onChange) o.onChange(new Set(sel));
  };
  list.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const id = t.getAttribute('data-sim-proto');
    if (!id) return;
    if (t.checked) sel.add(id);
    else sel.delete(id);
    changed();
  });
  const setMany = (ids: string[], on: boolean): void => {
    for (const id of ids) {
      if (on) sel.add(id);
      else sel.delete(id);
    }
    changed();
  };
  // a button that gets disabled by its own click hands the focus to its partner, so the keyboard stays in the list
  const keep = (b: HTMLButtonElement, other: HTMLButtonElement, act: () => void): void => {
    b.addEventListener('click', () => {
      act();
      if (b.disabled && doc.activeElement !== other) other.focus();
    });
  };
  keep(all, none, () => setMany(o.entries.map((e) => e.id), true));
  keep(none, all, () => setMany(o.entries.map((e) => e.id), false));
  for (const gr of groups) {
    keep(gr.all, gr.none, () => setMany(gr.ids, true));
    keep(gr.none, gr.all, () => setMany(gr.ids, false));
  }
  sync();
  return {
    el: root,
    selected: () => new Set(sel),
    set(shown) {
      sel.clear();
      for (const id of shown) if (boxes.has(id)) sel.add(id);
      sync();
    },
    first: () => (list.querySelector('input[data-sim-proto]') as HTMLInputElement | null),
  };
}

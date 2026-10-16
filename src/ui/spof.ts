/**
 * The Single points of failure window (Analyze → Single points of
 * failure…): what counts as one, then a table of them with the element,
 * its type, what it cuts off, the relations that go down and the impact,
 * most impact first; sortable by any column (aria-sort) and filtered by
 * text; each row with Show in diagram. The table as CSV or as text (copy or
 * save). A report of the model as written: it never changes the model.
 * spofRows, spofCsv and spofText are pure (no DOM); the body is built from
 * elements and text nodes only.
 */
import { Spof, refLabel } from '../analysis/failure';
import { Model } from '../model/types';
import { el } from './dom';

export type SpofSort = 'element' | 'type' | 'cuts' | 'relations' | 'impact';

export interface SpofViewState {
  sort: SpofSort;
  desc: boolean;
  filter: string;
}

export function newSpofViewState(): SpofViewState {
  return { sort: 'impact', desc: true, filter: '' };
}

/** One row of the table. */
export interface SpofRow {
  /** the object it stands for (a device, cable or aggregate interface) */
  ref: string;
  element: string;
  type: string;
  /** the devices cut off, in groups ("a, b; c"), then the guests that go down ("guests: web1, db1") ('' none) */
  cuts: string;
  relations: string;
  devicesCut: number;
  relationsDown: number;
  /** devices cut off (guests that go down included) + relations down */
  impact: number;
  /** the order of the report (most impact first) */
  rank: number;
}

const TYPE: { [k in Spof['kind']]: string } = { device: 'Device', cable: 'Cable', lag: 'LAG', vswitch: 'Virtual switch', passthrough: 'Passthrough port' };

/** "esx-01 vSwitch0" for a virtual switch ref. */
function vswitchName(ref: string): string {
  const p = ref.split(':');
  return `${p[1]} ${p.slice(2).join(':')}`;
}

/** The rows of a report, in its order (most impact first). */
export function spofRows(model: Model, list: Spof[]): SpofRow[] {
  return list.map((s, i) => {
    const devicesCut = s.isolated.reduce((n, g) => n + g.length, 0) + s.guests.length;
    const cuts = s.isolated.map((g) => g.join(', ')).join('; ');
    return {
      ref: s.ref,
      // the Type column says what it is: a cable by its id alone (not "cable l-1"); a virtual switch with why it is one
      element:
        s.kind === 'lag'
          ? `${refLabel(model, s.ref)} (${s.fail.length} cables)`
          : s.kind === 'cable'
            ? s.ref.slice(s.ref.indexOf(':') + 1)
            : s.kind === 'vswitch'
              ? `${vswitchName(s.ref)}${s.note ? ' (' + s.note + ')' : ''}`
              : refLabel(model, s.ref),
      type: TYPE[s.kind],
      cuts: [cuts, s.guests.length ? 'guests: ' + s.guests.join(', ') : ''].filter((x) => x).join('; '),
      relations: s.relations.join(', '),
      devicesCut,
      relationsDown: s.relations.length,
      impact: devicesCut + s.relations.length,
      rank: i,
    };
  });
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rows shown: filtered (every word must occur in the row's text) and sorted; ties keep the report's order. */
export function shownSpofRows(rows: SpofRow[], st: SpofViewState): SpofRow[] {
  const words = st.filter.toLowerCase().split(/\s+/).filter((w) => w);
  const hit = (r: SpofRow): boolean => {
    const text = `${r.element} ${r.type} ${r.cuts} ${r.relations}`.toLowerCase();
    return words.every((w) => text.indexOf(w) >= 0);
  };
  const key = (r: SpofRow): number | string => (st.sort === 'impact' ? r.impact : st.sort === 'element' ? r.element.toLowerCase() : st.sort === 'type' ? r.type : st.sort === 'cuts' ? r.devicesCut : r.relationsDown);
  const out = rows.filter(hit);
  out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = typeof ka === 'number' ? (ka as number) - (kb as number) : cmpStr(ka as string, kb as string);
    return (st.desc ? -c : c) || a.rank - b.rank;
  });
  return out;
}

const csvCell = (v: string | number): string => {
  const t = String(v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

/** The rows as CSV (a header row, then one line per row). */
export function spofCsv(rows: SpofRow[]): string {
  const head = ['element', 'type', 'cuts_off', 'relations_down', 'devices_cut_off', 'relations_down_count', 'impact'];
  return [head.join(',')].concat(rows.map((r) => [r.element, r.type, r.cuts, r.relations, r.devicesCut, r.relationsDown, r.impact].map(csvCell).join(','))).join('\n') + '\n';
}

/** The rows as plain text, one block per row. */
export function spofText(model: Model, rows: SpofRow[]): string {
  const lines = [`Single points of failure — ${model.title}`, `${rows.length} single point${rows.length === 1 ? '' : 's'} of failure, most impact first.`, ''];
  for (const r of rows) {
    lines.push(`${r.type} ${r.element} (impact ${r.impact})`);
    lines.push(`  cuts off: ${r.cuts || 'nothing'}`);
    lines.push(`  relations down: ${r.relations || 'none'}`);
  }
  return lines.join('\n') + '\n';
}

const COLS: Array<[SpofSort, string]> = [
  ['element', 'Element'],
  ['type', 'Type'],
  ['cuts', 'Cuts off'],
  ['relations', 'Relations down'],
  ['impact', 'Impact'],
];

/** The window's content. Its buttons carry data-spof-sort, data-spof-show, data-spof-out (csv-copy, csv-save, text-copy, text-save). */
export function spofBody(doc: Document, rows: SpofRow[], st: SpofViewState, simulated: boolean): HTMLElement {
  const box = el(doc, 'div', { class: 'spof-body' });
  box.appendChild(
    el(doc, 'p', { class: 'small' }, [
      'A single point of failure is one cable, device or LAG (all its member cables at once) whose failure alone cuts devices off from the rest of the physical network, or brings down relations although their endpoints are still up (they have no redundant underlay); for virtual machines and containers also a host (unless its HA cluster has a member left to restart them on), a virtual switch with one uplink or with its uplinks to one switch, and a passthrough port. A device joins only what it passes traffic between: an inline or pass-through device its paired ports, a Security gateway its two domains only when its policy permits a transfer, a passive monitor and a management interface nothing. Impact: the devices cut off (guests that go down included) plus the relations that go down. ',
      el(doc, 'span', { class: 'muted' }, [simulated ? 'Computed from the model as written (not the simulated state that is on).' : 'Computed from the model as written.']),
    ]),
  );
  const filter = el(doc, 'input', { type: 'search', id: 'spof-filter', 'data-spof-filter': '', placeholder: 'Filter: element, type, device, relation', 'aria-label': 'Filter the single points of failure', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  filter.value = st.filter;
  const out = (k: string, label: string): HTMLElement => el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-out': k }, [label]);
  box.appendChild(el(doc, 'div', { class: 'spof-tools' }, [filter, el(doc, 'span', { class: 'spof-out', role: 'group', 'aria-label': 'Export the table' }, [out('csv-copy', 'Copy CSV'), out('csv-save', 'Save CSV'), out('text-copy', 'Copy text'), out('text-save', 'Save text')])]));
  box.appendChild(spofTable(doc, rows, st));
  return box;
}

/** The status line and the table (redrawn on sorting and filtering). */
export function spofTable(doc: Document, rows: SpofRow[], st: SpofViewState): HTMLElement {
  const shown = shownSpofRows(rows, st);
  const wrap = el(doc, 'div', { class: 'spof-tables' });
  wrap.appendChild(el(doc, 'p', { id: 'spof-status', class: 'spof-count small', role: 'status' }, [rows.length ? (shown.length === rows.length ? `${rows.length} single point${rows.length === 1 ? '' : 's'} of failure.` : `${shown.length} of ${rows.length} single points of failure shown.`) : 'No single point of failure: every cable, device and LAG can fail without cutting the network or bringing a relation down.']));
  if (!rows.length) return wrap;
  const table = el(doc, 'table', { class: 'spof-table' });
  table.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Single points of failure; the column headers sort the table']));
  const head = el(doc, 'tr', {}, [
    ...COLS.map(([k, label]) => {
      const sorted = st.sort === k;
      return el(doc, 'th', { scope: 'col', 'aria-sort': sorted ? (st.desc ? 'descending' : 'ascending') : 'none' }, [
        el(doc, 'button', { type: 'button', class: 'th-sort', 'data-spof-sort': k, title: `Sort by ${label.toLowerCase()}` }, [label, el(doc, 'span', { class: 'sort-mark', 'aria-hidden': 'true' }, [sorted ? (st.desc ? ' ▼' : ' ▲') : ''])]),
      ]);
    }),
    el(doc, 'th', { scope: 'col' }, [el(doc, 'span', { class: 'sr-only' }, ['Actions'])]),
  ]);
  table.appendChild(el(doc, 'thead', {}, [head]));
  const tb = el(doc, 'tbody');
  for (const r of shown) {
    tb.appendChild(
      el(doc, 'tr', { 'data-spof': r.ref }, [
        el(doc, 'th', { scope: 'row' }, [r.element]),
        el(doc, 'td', { class: 'nowrap' }, [r.type]),
        el(doc, 'td', {}, [r.cuts || '—']),
        el(doc, 'td', {}, [r.relations || '—']),
        el(doc, 'td', { class: 'num' }, [`${r.impact}`, el(doc, 'span', { class: 'muted small' }, [` (${r.devicesCut} device${r.devicesCut === 1 ? '' : 's'}, ${r.relationsDown} relation${r.relationsDown === 1 ? '' : 's'})`])]),
        el(doc, 'td', { class: 'nowrap' }, [el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-show': r.ref, 'aria-label': `Show ${r.element} in the diagram` }, ['Show in diagram'])]),
      ]),
    );
  }
  table.appendChild(tb);
  wrap.appendChild(el(doc, 'div', { class: 'table-wrap' }, [table]));
  return wrap;
}

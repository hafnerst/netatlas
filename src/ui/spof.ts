/**
 * Resilience (Analyze → Resilience): what stops working when components
 * become unavailable, in three modes that share the question / results /
 * evidence layout of the Analyze workspace.
 *
 *   Single-component failures  every cable, device and LAG (and for guests
 *       their hosts, a virtual switch with one uplink, a passthrough port)
 *       failing alone, with separate measures — the saved requirements no
 *       longer satisfied, the configured dependencies unavailable, the
 *       devices disconnected, the relations down — and a status. No measure
 *       is added to another: none is a business criticality. Each value is
 *       explicit: None affected, Not evaluated, Checking, Indeterminate.
 *       The service and requirement impact is checked progressively and
 *       cancellably; the table can be sorted and filtered, and a selected
 *       row stays selected (by its object) while the check goes on.
 *   Failure scenario  a failure domain or a few components failing
 *       together, compared with the same baseline: the condition, what
 *       becomes unavailable, what survives through an alternative, the
 *       requirements affected, the structure, device pairs, capacity, the
 *       limits. Failure domains are administered in an explicit editor.
 *   Capacity  the stated demands against the stated capacity (the existing
 *       capacity analysis), with or without a failure condition: demand,
 *       capacity, the resource and direction that decide, the bounds of an
 *       equal split and of all on one path, what is missing.
 *
 * spofRows, spofCsv, spofText and whatIfText are pure (no DOM); the parts
 * are built from elements and text nodes only.
 */
import { DEP_CHANGE_TEXT, DEP_LABEL, DepChange } from '../analysis/dependencies';
import { Spof, SpofCandidate, refLabel } from '../analysis/failure';
import { Coverage, ResultInfo, coverageText, exportFooter, exportHeader } from '../analysis/result';
import { EXP_CHANGE_TEXT, ExpChangeKind, WhatIf } from '../analysis/whatif';
import { CapacityChange, CapacityResult, DemandResult, ResourceLoad, bpsText } from '../analysis/capacity';
import { FAILURE_DOMAIN_KINDS, Model } from '../model/types';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, coverageLine, limitsDetails } from './analysis-ui';
import { EvidenceAction, EvidenceView } from './evidence';

/** How a failure changes a demand's capacity, in words. */
const CAP_CHANGE_TEXT: { [k: string]: string } = { overload: 'Overloaded although still carried', lost: 'No longer carried', distribution: 'Now depends on the distribution', unknown: 'Insufficient information', relieved: 'Fits again', unchanged: 'Unchanged' };

export type SpofSort = 'element' | 'type' | 'reqs' | 'service' | 'cuts' | 'relations';

export interface SpofViewState {
  sort: SpofSort;
  desc: boolean;
  filter: string;
}

export function newSpofViewState(): SpofViewState {
  return { sort: 'reqs', desc: true, filter: '' };
}

/** A requirement a failure affects: its id and name, and how it fares. */
export interface ReqHit {
  id: string;
  name: string;
  change: ExpChangeKind;
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
  /** devices cut off (guests that go down included) + relations down: kept for the CSV export only, never shown as a measure */
  impact: number;
  /** the configured dependencies that become unavailable (null: not checked yet) */
  service: number | null;
  /** the dependencies whose state can't be determined under it (null: not checked yet) */
  serviceIndet: number | null;
  /** what becomes unavailable, in words */
  serviceText: string;
  /** the saved requirements no longer satisfied (null: not checked yet), and those indeterminate under it */
  reqs: number | null;
  reqsIndet: number | null;
  reqText: string;
  /** the failure it stands for */
  fail: string[];
  /** the order of the report (structural first) */
  rank: number;
}

const TYPE: { [k in Spof['kind']]: string } = { device: 'Device', cable: 'Cable', lag: 'LAG', vswitch: 'Virtual switch', passthrough: 'Passthrough port' };

/** "esx-01 vSwitch0" for a virtual switch ref. */
function vswitchName(ref: string): string {
  const p = ref.split(':');
  return `${p[1]} ${p.slice(2).join(':')}`;
}

function elementText(model: Model, s: { kind: Spof['kind']; ref: string; fail: string[]; note?: string }): string {
  return s.kind === 'lag'
    ? `${refLabel(model, s.ref)} (${s.fail.length} cables)`
    : s.kind === 'cable'
      ? s.ref.slice(s.ref.indexOf(':') + 1)
      : s.kind === 'vswitch'
        ? `${vswitchName(s.ref)}${s.note ? ' (' + s.note + ')' : ''}`
        : refLabel(model, s.ref);
}

/** The service impact of a candidate, in words: "DNS: tv, laptop; DHCP: tv:wlan0". */
export function serviceText(changes: DepChange[]): string {
  const lost = changes.filter((c) => c.change === 'unavailable');
  const by = new Map<string, string[]>();
  for (const c of lost) {
    const k = DEP_LABEL[c.dep.kind];
    if (!by.has(k)) by.set(k, []);
    (by.get(k) as string[]).push(c.dep.kind === 'dhcp' ? c.dep.consumerRef.replace(/^iface:/, '') : c.dep.kind === 'application' || c.dep.kind === 'mqtt' ? c.dep.text.split(' → ')[0] : c.dep.consumer);
  }
  return Array.from(by.entries())
    .map(([k, v]) => `${k}: ${v.join(', ')}`)
    .join('; ');
}

/** A requirement change that means it is no longer satisfied. */
export const REQ_LOST: ExpChangeKind[] = ['isolation-violated', 'availability-lost'];

/**
 * The rows of a report: the structural single points (in their order), and
 * the candidates whose failure makes a configured dependency unavailable or
 * a saved requirement no longer satisfied although it cuts nothing off;
 * with each one's service and requirement impact once checked (by
 * candidate ref).
 */
export function spofRows(model: Model, list: Spof[], service: Map<string, DepChange[]> | null = null, cands: SpofCandidate[] = [], reqs: Map<string, ReqHit[]> | null = null): SpofRow[] {
  const fill = (ref: string): Pick<SpofRow, 'service' | 'serviceIndet' | 'serviceText' | 'reqs' | 'reqsIndet' | 'reqText'> => {
    const ch = service ? service.get(ref) : undefined;
    const rq = reqs ? reqs.get(ref) : undefined;
    const lost = rq ? rq.filter((x) => REQ_LOST.indexOf(x.change) >= 0) : [];
    return {
      service: ch ? ch.filter((c) => c.change === 'unavailable').length : null,
      serviceIndet: ch ? ch.filter((c) => c.change === 'indeterminate').length : null,
      serviceText: ch ? serviceText(ch) : '',
      reqs: rq ? lost.length : null,
      reqsIndet: rq ? rq.filter((x) => x.change === 'indeterminate').length : null,
      reqText: lost.map((x) => x.name).join(', '),
    };
  };
  const rows: SpofRow[] = list.map((s, i) => {
    const devicesCut = s.isolated.reduce((n, g) => n + g.length, 0) + s.guests.length;
    const cuts = s.isolated.map((g) => g.join(', ')).join('; ');
    return {
      ref: s.ref,
      // the Type column says what it is: a cable by its id alone (not "cable l-1"); a virtual switch with why it is one
      element: elementText(model, s),
      type: TYPE[s.kind],
      cuts: [cuts, s.guests.length ? 'guests: ' + s.guests.join(', ') : ''].filter((x) => x).join('; '),
      relations: s.relations.join(', '),
      devicesCut,
      relationsDown: s.relations.length,
      impact: devicesCut + s.relations.length,
      ...fill(s.ref),
      fail: s.fail,
      rank: i,
    };
  });
  if (service || reqs) {
    for (const c of cands) {
      if (rows.some((r) => r.ref === c.ref)) continue;
      const f = fill(c.ref);
      if (!f.service && !f.reqs) continue;
      rows.push({ ref: c.ref, element: elementText(model, c), type: TYPE[c.kind], cuts: '', relations: '', devicesCut: 0, relationsDown: 0, impact: 0, ...f, fail: c.fail, rank: rows.length });
    }
  }
  return rows;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rows shown: filtered (every word must occur in the row's text) and sorted; ties keep the report's order. */
export function shownSpofRows(rows: SpofRow[], st: SpofViewState): SpofRow[] {
  const words = st.filter.toLowerCase().split(/\s+/).filter((w) => w);
  const hit = (r: SpofRow): boolean => {
    const text = `${r.element} ${r.type} ${r.cuts} ${r.relations} ${r.serviceText} ${r.reqText}`.toLowerCase();
    return words.every((w) => text.indexOf(w) >= 0);
  };
  const num = (v: number | null): number => (v === null ? -1 : v);
  const key = (r: SpofRow): number | string => (st.sort === 'reqs' ? num(r.reqs) : st.sort === 'service' ? num(r.service) : st.sort === 'element' ? r.element.toLowerCase() : st.sort === 'type' ? r.type : st.sort === 'cuts' ? r.devicesCut : r.relationsDown);
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

/** The rows as CSV (a header row, then one line per row; the context in every line). */
export function spofCsv(rows: SpofRow[], context = 'Configured model · Entire architecture'): string {
  const head = ['element', 'type', 'cuts_off', 'relations_down', 'devices_cut_off', 'relations_down_count', 'structural_impact', 'services_unavailable', 'service_impact', 'requirements_unsatisfied', 'requirements', 'context'];
  return [head.join(',')].concat(rows.map((r) => [r.element, r.type, r.cuts, r.relations, r.devicesCut, r.relationsDown, r.impact, r.service === null ? '' : r.service, r.serviceText, r.reqs === null ? '' : r.reqs, r.reqText, context].map(csvCell).join(','))).join('\n') + '\n';
}

/** A measure as an explicit value: a count, None affected, Checking, Not evaluated, with what is indeterminate. */
export function measureText(n: number | null, indet: number | null, running: boolean, unit: [string, string]): string {
  if (n === null) return running ? 'Checking' : 'Not evaluated';
  const base = n ? `${n} ${n === 1 ? unit[0] : unit[1]}` : 'None affected';
  return indet ? `${base}; ${indet} indeterminate` : base;
}

/** The rows as plain text, one block per row, with the context and coverage. */
export function spofText(model: Model, rows: SpofRow[], o: { info?: ResultInfo; version?: string; outdated?: boolean } = {}): string {
  const lines = o.info ? exportHeader({ analysis: 'Resilience: single-component failures', title: model.title, info: o.info, version: o.version, outdated: o.outdated }) : [`Resilience: single-component failures — ${model.title}`];
  lines.push(`${rows.length} single-component failure${rows.length === 1 ? '' : 's'} with an effect.`, '');
  for (const r of rows) {
    lines.push(`${r.type} ${r.element}`);
    lines.push(`  requirements no longer satisfied: ${measureText(r.reqs, r.reqsIndet, false, ['requirement', 'requirements'])}${r.reqText ? ' (' + r.reqText + ')' : ''}`);
    lines.push(`  configured dependencies unavailable: ${measureText(r.service, r.serviceIndet, false, ['dependency', 'dependencies'])}${r.serviceText ? ' (' + r.serviceText + ')' : ''}`);
    lines.push(`  devices disconnected: ${r.devicesCut ? `${r.devicesCut} (${r.cuts})` : 'none'}`);
    lines.push(`  relations unavailable: ${r.relations || 'none'}`);
  }
  if (o.info) {
    lines.push('');
    for (const l of exportFooter(o.info)) lines.push(l);
  }
  return lines.join('\n') + '\n';
}

const COLS: Array<[SpofSort | '', string]> = [
  ['element', 'Element'],
  ['type', 'Type'],
  ['reqs', 'Requirements no longer satisfied'],
  ['service', 'Configured dependencies unavailable'],
  ['cuts', 'Devices disconnected'],
  ['relations', 'Relations unavailable'],
  ['', 'Status'],
];

/** The service check's progress (null: not started). */
export interface SpofProgress {
  checked: number;
  total: number;
  running: boolean;
  cancelled: boolean;
  /** the configured dependencies checked for each candidate, and how many of them can't be determined in the configured model */
  deps: number;
  indeterminate: number;
  /** the saved requirements checked for each candidate */
  reqs: number;
}

/** The candidates in words: "40 cables, 30 devices, 2 LAGs". */
export function candidatesText(cands: SpofCandidate[]): string {
  const c: { [k: string]: number } = {};
  for (const x of cands) c[x.kind] = (c[x.kind] || 0) + 1;
  const names: { [k: string]: [string, string] } = { cable: ['cable', 'cables'], device: ['device', 'devices'], lag: ['LAG', 'LAGs'], vswitch: ['virtual switch', 'virtual switches'], passthrough: ['passthrough port', 'passthrough ports'] };
  return ['cable', 'device', 'lag', 'vswitch', 'passthrough'].filter((k) => c[k]).map((k) => `${c[k]} ${names[k][c[k] === 1 ? 0 : 1]}`).join(', ');
}

export interface SpofView {
  bar: ContextBarState;
  progress: SpofProgress | null;
  cands: SpofCandidate[];
  info: ResultInfo;
  /** the selected row's object ('' none) */
  sel: string;
}

/** The question of Single-component failures (left): the context, what is evaluated, the filter. */
export function spofRequest(doc: Document, st: SpofViewState, view: SpofView, act: ContextBarActions): HTMLElement {
  const box = el(doc, 'div', { class: 'spof-body' });
  box.appendChild(contextBar(doc, view.bar, act));
  box.appendChild(el(doc, 'p', { class: 'small' }, ['Each cable, device and LAG (all its member cables at once) failing alone — for virtual machines and containers also a host, a virtual switch with one uplink or with its uplinks to one switch, and a passthrough port. Each measure is counted on its own; none is a business criticality or a probability.']));
  const filter = el(doc, 'input', { type: 'search', id: 'spof-filter', 'data-spof-filter': '', placeholder: 'element, type, device, relation, requirement', 'aria-label': 'Filter the single-component failures', 'aria-describedby': 'spof-status', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  filter.value = st.filter;
  box.appendChild(el(doc, 'div', { class: 'an-filters' }, [el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'spof-filter' }, ['Filter']), filter])]));
  return box;
}

/** The service and requirement check's progress, with Stop while it runs. */
export function progressLine(doc: Document, p: SpofProgress | null, act: { stop(): void }): HTMLElement {
  const line = el(doc, 'p', { class: 'small spof-progress', id: 'spof-progress', role: 'status', 'aria-live': 'polite' });
  if (!p) return line;
  if (p.running) {
    line.appendChild(doc.createTextNode(`Checking the configured dependencies and requirements: ${p.checked} of ${p.total} candidates… `));
    const stop = el(doc, 'button', { type: 'button', class: 'mini', id: 'spof-stop' }, ['Stop']);
    stop.addEventListener('click', () => act.stop());
    line.appendChild(stop);
  } else {
    const cov: Coverage = { checked: p.checked, eligible: p.total, unit: 'candidates', cancelled: p.cancelled };
    const against = [p.deps ? `${p.deps} configured dependenc${p.deps === 1 ? 'y' : 'ies'}${p.indeterminate ? ` (${p.indeterminate} not determinable in the configured model)` : ''}` : 'no configured dependency', p.reqs ? `${p.reqs} saved requirement${p.reqs === 1 ? '' : 's'}` : 'no saved requirement'];
    line.appendChild(doc.createTextNode(`Service and requirement impact: ${coverageText(cov)}, against ${against.join(' and ')}.`));
  }
  return line;
}

/** The status line, the exports and the table (redrawn on sorting, filtering and progress). The selected row stays selected by its object. */
export function spofTable(doc: Document, rows: SpofRow[], st: SpofViewState, view: SpofView): HTMLElement {
  const shown = shownSpofRows(rows, st);
  const wrap = el(doc, 'div', { class: 'spof-tables' });
  const p = view.progress;
  const running = !!p && p.running;
  const done = !!p && !p.running && !p.cancelled;
  const empty = done
    ? 'No single component’s failure has an effect under the structural, service and requirement checks.'
    : p && p.cancelled
      ? 'No effect found among the candidates checked: the check was stopped before the end.'
      : 'No structural effect; the service and requirement impact is being checked.';
  wrap.appendChild(el(doc, 'p', { id: 'spof-status', class: 'spof-count small', role: 'status' }, [rows.length ? (shown.length === rows.length ? `${rows.length} single-component failure${rows.length === 1 ? '' : 's'} with an effect.` : `${shown.length} of ${rows.length} single-component failures shown.`) : empty]));
  if (!rows.length) {
    const d = el(doc, 'details', { class: 'an-limits' }, [el(doc, 'summary', {}, ['What was checked'])]);
    d.appendChild(el(doc, 'p', { class: 'small' }, [`Candidates: ${candidatesText(view.cands) || 'none'}, each failing alone.`]));
    if (p) d.appendChild(el(doc, 'p', { class: 'small' }, [`Service checks: ${p.deps} configured dependenc${p.deps === 1 ? 'y' : 'ies'}${p.indeterminate ? `, ${p.indeterminate} of them not determinable in the configured model (their consumers take their addresses at runtime: a simulation snapshot can tell)` : ''}; ${p.reqs} saved requirement${p.reqs === 1 ? '' : 's'}.`]));
    d.appendChild(el(doc, 'p', { class: 'small' }, ['Not checked: relations or interfaces failing alone, combinations of failures (Failure scenario), dependencies the model does not configure, runtime behaviour.']));
    wrap.appendChild(d);
    return wrap;
  }
  const table = el(doc, 'table', { class: 'spof-table' });
  table.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Single-component failures; the column headers sort the table; a row shows its evidence']));
  const head = el(doc, 'tr', {}, [
    ...COLS.map(([k, label]) => {
      if (!k) return el(doc, 'th', { scope: 'col' }, [label]);
      const sorted = st.sort === k;
      return el(doc, 'th', { scope: 'col', 'aria-sort': sorted ? (st.desc ? 'descending' : 'ascending') : 'none' }, [
        el(doc, 'button', { type: 'button', class: 'th-sort', 'data-spof-sort': k, title: `Sort by ${label.toLowerCase()}` }, [label, el(doc, 'span', { class: 'sort-mark', 'aria-hidden': 'true' }, [sorted ? (st.desc ? ' ▼' : ' ▲') : ''])]),
      ]);
    }),
    el(doc, 'th', { scope: 'col' }, [el(doc, 'span', { class: 'sr-only' }, ['Actions'])]),
  ]);
  table.appendChild(el(doc, 'thead', {}, [head]));
  const tb = el(doc, 'tbody');
  const cell = (n: number | null, indet: number | null, unit: [string, string], text: string): HTMLElement =>
    el(doc, 'td', { 'data-measure': n === null ? (running ? 'checking' : 'not-evaluated') : n ? 'affected' : indet ? 'indeterminate' : 'none' }, [measureText(n, indet, running, unit), text ? el(doc, 'div', { class: 'muted small' }, [text]) : null]);
  for (const r of shown) {
    const status = r.service === null || r.reqs === null ? (running ? 'Checking' : 'Not evaluated') : r.serviceIndet || r.reqsIndet ? 'Indeterminate in part' : 'Evaluated';
    const on = view.sel === r.ref;
    tb.appendChild(
      el(doc, 'tr', { 'data-spof': r.ref, 'data-an-item': 'spof:' + r.ref, tabindex: '0', class: on ? 'an-selected' : '', ...(on ? { 'aria-current': 'true' } : {}) }, [
        el(doc, 'th', { scope: 'row' }, [r.element]),
        el(doc, 'td', { class: 'nowrap' }, [r.type]),
        cell(r.reqs, r.reqsIndet, ['requirement', 'requirements'], r.reqText),
        cell(r.service, r.serviceIndet, ['dependency', 'dependencies'], r.serviceText),
        el(doc, 'td', { 'data-measure': r.devicesCut ? 'affected' : 'none' }, [r.devicesCut ? `${r.devicesCut}` : 'None affected', r.cuts ? el(doc, 'div', { class: 'muted small' }, [r.cuts]) : null]),
        el(doc, 'td', { 'data-measure': r.relationsDown ? 'affected' : 'none' }, [r.relationsDown ? `${r.relationsDown}` : 'None affected', r.relations ? el(doc, 'div', { class: 'muted small' }, [r.relations]) : null]),
        el(doc, 'td', { class: 'nowrap small' }, [status]),
        el(doc, 'td', { class: 'nowrap' }, [
          el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-show': r.ref, 'aria-label': `Show ${r.element} in the diagram` }, ['Show']),
          el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-whatif': r.fail.join(' '), 'aria-label': `Investigate ${r.element} failing as a failure scenario` }, ['Scenario']),
        ]),
      ]),
    );
  }
  table.appendChild(tb);
  wrap.appendChild(el(doc, 'div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Single-component failures' }, [table]));
  return wrap;
}

/** The results of Single-component failures (bottom): the exports, the progress, the table, the limits. */
export function spofResults(doc: Document, rows: SpofRow[], st: SpofViewState, view: SpofView, act: { stop(): void }): HTMLElement {
  const box = el(doc, 'div', { class: 'spof-results' });
  const out = (k: string, label: string): HTMLElement => el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-out': k }, [label]);
  box.appendChild(el(doc, 'div', { class: 'an-res-tools spof-out', role: 'group', 'aria-label': 'Export the table' }, [out('csv-copy', 'Copy CSV'), out('csv-save', 'Save CSV'), out('text-copy', 'Copy text'), out('text-save', 'Save text')]));
  box.appendChild(progressLine(doc, view.progress, act));
  box.appendChild(spofTable(doc, rows, st, view));
  box.appendChild(limitsDetails(doc, view.info));
  return box;
}

/** The evidence of a single-component failure (its row). `changes`: its dependency changes, once checked. */
export function spofEvidence(doc: Document, r: SpofRow, changes: DepChange[] | null, reqs: ReqHit[] | null, context: string, running: boolean): EvidenceView {
  const ex: Node[] = [];
  const line = (k: string, v: string): void => {
    ex.push(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [k + ': ']), v]));
  };
  line('Requirements no longer satisfied', measureText(r.reqs, r.reqsIndet, running, ['requirement', 'requirements']) + (r.reqText ? ` — ${r.reqText}` : ''));
  line('Configured dependencies unavailable', measureText(r.service, r.serviceIndet, running, ['dependency', 'dependencies']) + (r.serviceText ? ` — ${r.serviceText}` : ''));
  line('Devices disconnected', r.devicesCut ? `${r.devicesCut}: ${r.cuts}` : 'None affected');
  line('Relations unavailable', r.relations || 'None affected');
  const evidence: Node[] = [];
  const next: EvidenceAction[] = [{ id: 'scenario', label: 'Investigate as failure scenario', why: 'The same failure in Failure scenario: what survives through an alternative, the requirements before and after, capacity', ref: r.fail.join(' ') }];
  if (changes) {
    const lost = changes.filter((c) => c.change === 'unavailable' || c.change === 'indeterminate' || c.change === 'degraded');
    if (lost.length) {
      const ul = el(doc, 'ul', { class: 'small' });
      lost.forEach((c, k) => {
        ul.appendChild(el(doc, 'li', { 'data-change': c.change }, [el(doc, 'strong', {}, [DEP_CHANGE_TEXT[c.change] + ': ']), `${DEP_LABEL[c.dep.kind]} · ${c.dep.text}`, el(doc, 'div', { class: 'muted' }, [c.text])]));
        const o = c.dep.options.find((x) => !!x.request);
        if (o && o.request && k < 6) next.push({ id: 'communication', label: `Check ${c.dep.text}`, why: 'This dependency’s communication, in Communication (under no failure: the configured model as it is)', ref: JSON.stringify(o.request) });
      });
      evidence.push(el(doc, 'p', { class: 'small' }, ['Configured dependencies, compared with the baseline:']), ul);
    }
  }
  if (reqs && reqs.some((x) => x.change !== 'unchanged')) {
    const ul = el(doc, 'ul', { class: 'small' });
    for (const x of reqs.filter((y) => y.change !== 'unchanged')) ul.appendChild(el(doc, 'li', { 'data-exp-change': x.change }, [el(doc, 'strong', {}, [EXP_CHANGE_TEXT[x.change] + ': ']), x.name]));
    evidence.push(el(doc, 'p', { class: 'small' }, ['Saved requirements under this failure:']), ul);
  }
  const objs = [{ ref: r.ref, label: r.element }].concat(r.cuts.split(/[;,]\s*/).map((x) => x.replace(/^guests: /, '').trim()).filter((x) => !!x).map((x) => ({ ref: 'device:' + x, label: x })));
  return { kind: 'Failure impact', title: `${r.type} ${r.element} fails alone`, context, explanation: ex, evidence, objects: objs, next };
}

// ------------------------------------------------------------ failure scenario

export interface WhatIfForm {
  /** none: no failure (Capacity only) */
  mode: 'none' | 'domain' | 'components';
  domain: string;
  components: string;
  /** device pairs too: '' none, 'entire', 'group:<id>' */
  reach: string;
}

export function newWhatIfForm(): WhatIfForm {
  return { mode: 'domain', domain: '', components: '', reach: '' };
}

export interface DomainForm {
  /** the index edited (-1: new) */
  index: number;
  label: string;
  kind: string;
  members: string;
  error: string;
}

export interface WhatIfView {
  model: Model;
  form: WhatIfForm;
  result: WhatIf | null;
  outdated: boolean;
  locked: string;
  bar: ContextBarState;
  /** the selected item ('' none) */
  sel: string;
}

export interface WhatIfActions extends ContextBarActions {
  wiInput(k: keyof WhatIfForm, v: string): void;
  wiRun(): void;
  wiOut(kind: 'copy' | 'save'): void;
  /** open the failure domains' editor */
  domains(): void;
}

/** The condition of a scenario (or a capacity question): a failure domain, or components (Capacity: also none). Its controls carry ids with `prefix`. */
function conditionForm(doc: Document, m: Model, f: WhatIfForm, act: WhatIfActions, prefix: string, none: boolean): HTMLElement {
  const box = el(doc, 'div', { class: 'wi-cond' });
  const seg = el(doc, 'div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Failure condition' });
  const modes: Array<[WhatIfForm['mode'], string]> = (none ? ([['none', 'No failure']] as Array<[WhatIfForm['mode'], string]>) : []).concat([
    ['domain', 'Failure domain'],
    ['components', 'Components'],
  ]);
  const cur = !none && f.mode === 'none' ? 'domain' : f.mode;
  for (const [k, label] of modes) {
    const on = cur === k;
    const b = el(doc, 'button', { type: 'button', role: 'radio', class: 'mini' + (on ? ' active' : ''), 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-wi-mode': k, id: `${prefix}-mode-${k}` }, [label]);
    b.addEventListener('click', () => act.wiInput('mode', k));
    seg.appendChild(b);
  }
  seg.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(k) < 0) return;
    e.preventDefault();
    const i = modes.findIndex((x) => x[0] === cur);
    const n = modes[(i + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : modes.length - 1)) % modes.length][0];
    act.wiInput('mode', n);
  });
  box.appendChild(seg);
  const grid = el(doc, 'div', { class: 'tf-grid' });
  if (cur === 'domain') {
    const s = el(doc, 'select', { id: prefix + '-domain' }) as HTMLSelectElement;
    s.appendChild(el(doc, 'option', { value: '' }, [m.failureDomains.length ? 'Choose a failure domain…' : 'The model has no failure domain']));
    for (const d of m.failureDomains) s.appendChild(el(doc, 'option', { value: d.id }, [`${d.label} (${(FAILURE_DOMAIN_KINDS.find((k) => k.id === d.kind) || { label: d.kind }).label}, ${d.members.length} member${d.members.length === 1 ? '' : 's'})`]));
    s.value = f.domain;
    s.addEventListener('change', () => act.wiInput('domain', s.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: prefix + '-domain' }, ['Domain']), s]));
  } else if (cur === 'components') {
    const list = el(doc, 'datalist', { id: prefix + '-parts' });
    for (const d of m.devices) list.appendChild(el(doc, 'option', { value: d.id }, ['Device']));
    for (const l of m.links) list.appendChild(el(doc, 'option', { value: l.id }, ['Cable']));
    for (const r of m.relations) list.appendChild(el(doc, 'option', { value: r.id }, ['Relation']));
    box.appendChild(list);
    const i = el(doc, 'input', { id: prefix + '-components', type: 'text', list: prefix + '-parts', autocomplete: 'off', spellcheck: 'false', placeholder: 'devices, cables, relations, device:interface (comma-separated)' }) as HTMLInputElement;
    i.value = f.components;
    i.addEventListener('input', () => act.wiInput('components', i.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: prefix + '-components' }, ['Fail']), i]));
  }
  box.appendChild(grid);
  return box;
}

/** The entries a condition form names (none: no failure). */
export function conditionEntries(f: WhatIfForm): string[] {
  return f.mode === 'domain' ? (f.domain ? [f.domain] : []) : f.mode === 'components' ? f.components.split(/[\s,]+/).filter((x) => x) : [];
}

/** The question of Failure scenario (left): the context, the condition, what else to check, Analyze; the failure domains' editor behind its own action. */
export function scenarioRequest(doc: Document, v: WhatIfView, act: WhatIfActions): HTMLElement {
  const sec = el(doc, 'div', { class: 'wi-section' });
  sec.appendChild(contextBar(doc, v.bar, act));
  sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['A failure domain or a few components fail together; the result is compared with the same baseline. A hypothetical condition, not a probability; no convergence time is claimed.']));
  const m = v.model;
  const f = v.form;
  const form = el(doc, 'form', { class: 'trace-form', 'aria-label': 'Failure scenario' }) as HTMLFormElement;
  form.appendChild(conditionForm(doc, m, f, act, 'wi', false));
  const g = el(doc, 'details', { class: 'dc-adv' }, [el(doc, 'summary', {}, ['Advanced options: device pairs'])]);
  if (f.reach) g.setAttribute('open', '');
  const r = el(doc, 'select', { id: 'wi-reach' }) as HTMLSelectElement;
  r.appendChild(el(doc, 'option', { value: '' }, ['Services and requirements only']));
  r.appendChild(el(doc, 'option', { value: 'entire' }, ['Also device pairs: entire architecture (bounded)']));
  for (const gr of m.groups) r.appendChild(el(doc, 'option', { value: 'group:' + gr.id }, [`Also device pairs: ${gr.label}`]));
  r.value = f.reach;
  r.addEventListener('change', () => act.wiInput('reach', r.value));
  g.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'wi-reach' }, ['Check']), r]));
  form.appendChild(g);
  form.appendChild(el(doc, 'div', { class: 'tf-actions' }, [el(doc, 'button', { type: 'submit', class: 'primary', id: 'wi-go' }, ['Analyze scenario'])]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act.wiRun();
  });
  sec.appendChild(form);
  const n = m.failureDomains.length;
  const cfg = el(doc, 'button', { type: 'button', class: 'mini', id: 'dom-config', title: 'Add, change or delete the model’s failure domains (an editor in the right panel)' }, ['Configure failure domains…']);
  cfg.addEventListener('click', () => act.domains());
  sec.appendChild(el(doc, 'p', { class: 'small muted' }, [`${n ? n + ' failure domain' + (n === 1 ? '' : 's') : 'No failure domain'} in the model. `, cfg]));
  return sec;
}

const CHANGE_ORDER: Array<DepChange['change']> = ['unavailable', 'degraded', 'indeterminate', 'alternative', 'consumer-down', 'not-before'];

/** A selectable row of a result list (its evidence on the right). */
function pickItem(doc: Document, key: string, sel: string, kids: Array<Node | string>, attrs: { [k: string]: string } = {}): HTMLElement {
  const on = key === sel;
  return el(doc, 'li', { ...attrs, class: (attrs.class ? attrs.class + ' ' : '') + 'an-pickrow' + (on ? ' an-selected' : '') }, [...kids, ' ', el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': on ? 'true' : 'false', 'aria-controls': 'an-detail' }, ['Evidence'])]);
}

/** The scenario's results (bottom): the condition and its counts, the changes, the surviving alternatives, the requirements, the structure, pairs, capacity, limits. */
export function scenarioResults(doc: Document, v: WhatIfView, act: WhatIfActions): HTMLElement {
  const w = v.result;
  const box = el(doc, 'div', { class: 'wi-result', id: 'wi-result' });
  if (!w) {
    box.appendChild(el(doc, 'p', { class: 'muted' }, ['Choose a failure domain or name the components that fail, then Analyze scenario: the comparison with the baseline appears here.']));
    return box;
  }
  const copy = el(doc, 'button', { type: 'button', class: 'mini', id: 'wi-copy' }, ['Copy as text']);
  copy.addEventListener('click', () => act.wiOut('copy'));
  const save = el(doc, 'button', { type: 'button', class: 'mini', id: 'wi-save' }, ['Save as text']);
  save.addEventListener('click', () => act.wiOut('save'));
  box.appendChild(el(doc, 'div', { class: 'an-res-tools', role: 'group', 'aria-label': 'Export the result' }, [copy, save]));
  if (w.unknown.length) box.appendChild(el(doc, 'p', { class: 'trace-error', role: 'alert' }, [`Not in the model: ${w.unknown.join(', ')}.`]));
  if (w.tooLarge || !w.result) {
    box.appendChild(el(doc, 'p', { class: 'small', id: 'wi-summary', tabindex: '-1' }, [w.info.limits[w.info.limits.length - 1] || 'Nothing was evaluated.']));
    return box;
  }
  const n = (k: string): number => w.deps.filter((d) => d.change === k).length;
  const lostExp = w.expectations.filter((x) => REQ_LOST.indexOf(x.change) >= 0).length;
  const sel = v.sel;
  box.appendChild(
    el(doc, 'p', { class: 'an-verdict ' + (n('unavailable') || lostExp ? 'v-violated' : n('indeterminate') ? 'v-indeterminate' : 'v-satisfied'), role: 'status', id: 'wi-summary', tabindex: '-1' }, [
      el(doc, 'strong', {}, [`Failure of ${w.entries.join(', ')}`]),
      ` (${w.refs.length} component${w.refs.length === 1 ? '' : 's'}): ${lostExp} saved requirement${lostExp === 1 ? '' : 's'} no longer satisfied; ${n('unavailable')} configured dependenc${n('unavailable') === 1 ? 'y becomes' : 'ies become'} unavailable, ${n('alternative')} survive${n('alternative') === 1 ? 's' : ''} through an alternative, ${n('degraded')} degraded, ${n('indeterminate')} cannot be determined.`,
    ]),
  );
  box.appendChild(el(doc, 'p', { class: 'small muted' }, [`Baseline: the configured model with nothing failed. Condition: ${w.refs.map((r) => r.replace(/^[a-z]+:/, '')).join(', ')}${w.domains.length ? ` (failure domain${w.domains.length === 1 ? '' : 's'} ${w.domains.join(', ')})` : ''}.`]));
  // the requirements first: what the user saved as must-hold
  if (w.expectations.length) {
    const sec = el(doc, 'section', { class: 'wi-group', 'aria-labelledby': 'wi-exp-h' }, [el(doc, 'h4', { id: 'wi-exp-h' }, [`Saved requirements (${w.expectations.length})`])]);
    const ul = el(doc, 'ul', { class: 'small' });
    for (const x of w.expectations) ul.appendChild(pickItem(doc, 'wexp:' + x.after.id, sel, [el(doc, 'strong', {}, [`${EXP_CHANGE_TEXT[x.change]}: `]), `${x.after.name} (${x.after.expect === 'blocked' ? 'must be blocked' : x.after.expect === 'available' ? 'must be available' : x.after.expect}; before ${x.before.verdict}, after ${x.after.verdict})`], { class: 'v-' + x.after.verdict, 'data-exp-change': x.change }));
    sec.appendChild(ul);
    box.appendChild(sec);
  }
  // the dependencies, by change (the alternatives are what survives)
  for (const k of CHANGE_ORDER) {
    const list = w.deps.filter((d) => d.change === k);
    if (!list.length) continue;
    const d = el(doc, 'details', { class: 'wi-group', 'data-change': k }, [el(doc, 'summary', {}, [`${k === 'alternative' ? 'Surviving alternatives — ' : ''}${DEP_CHANGE_TEXT[k]} (${list.length})`])]);
    if (k === 'unavailable' || k === 'degraded' || k === 'alternative' || list.some((c) => 'dep:' + c.dep.key === sel)) d.setAttribute('open', '');
    const ul = el(doc, 'ul', { class: 'small' });
    for (const c of list) ul.appendChild(pickItem(doc, 'dep:' + c.dep.key, sel, [el(doc, 'span', { class: 'muted' }, [DEP_LABEL[c.dep.kind] + ': ']), el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': c.dep.consumerRef }, [c.dep.text]), el(doc, 'div', { class: 'muted' }, [c.text])]));
    d.appendChild(ul);
    box.appendChild(d);
  }
  // capacity: the stated traffic against the stated capacity, before and after
  if (w.capacity) {
    const c = w.capacity;
    const d = el(doc, 'details', { class: 'wi-group', id: 'wi-capacity', 'data-evaluated': c.after.evaluated ? 'yes' : 'no' }, [el(doc, 'summary', {}, [c.after.evaluated ? `Capacity: ${c.after.text}` : 'Capacity: not evaluated'])]);
    if (!c.after.evaluated) d.appendChild(el(doc, 'p', { class: 'small muted' }, [c.after.text]));
    else {
      const ul = el(doc, 'ul', { class: 'small' });
      for (const x of c.changes.filter((y) => y.change !== 'unchanged')) ul.appendChild(pickItem(doc, 'cap:' + x.demand.id, sel, [el(doc, 'strong', {}, [CAP_CHANGE_TEXT[x.change] + ': ']), x.demand.label, el(doc, 'div', { class: 'muted' }, [x.after.connectivity === 'retained' ? x.after.text : 'not carried: ' + x.after.text])], { 'data-cap-change': x.change }));
      if (!ul.childNodes.length) ul.appendChild(el(doc, 'li', { class: 'muted' }, ['No demand changes: the stated traffic fits as it did.']));
      d.appendChild(ul);
      d.appendChild(el(doc, 'p', { class: 'small muted' }, ['Each resource, before and after: Resilience → Capacity with this condition.']));
    }
    box.appendChild(d);
  }
  // the structure
  const s = w.summary;
  if (s) {
    const part = (label: string, list: Array<{ ref: string; state: string }>): string => (list.length ? `${label}: ${list.map((x) => x.ref.replace(/^[a-z]+:/, '') + (x.state === 'degraded' || x.state === 'takeover' ? ' (degraded)' : '')).join(', ')}` : '');
    const lines = [part('Devices', s.devices), part('Cables', s.links), part('Relations', s.relations), part('Tunnels', s.tunnels), part('Networks', s.networks), part('Routes', s.routes)].filter((x) => x);
    const d = el(doc, 'details', { class: 'wi-group' }, [el(doc, 'summary', {}, [`Structure: down or degraded (${lines.length ? s.devices.length + s.links.length + s.relations.length + s.tunnels.length + s.networks.length + s.routes.length : 0})`])]);
    if (w.structural && w.structural.isolated.length) d.appendChild(el(doc, 'p', { class: 'small' }, [`Disconnected: ${w.structural.isolated.map((g) => g.join(', ')).join('; ')}`]));
    for (const l of lines) d.appendChild(el(doc, 'p', { class: 'small' }, [l]));
    box.appendChild(d);
  }
  if (w.reach) {
    const d = el(doc, 'details', { class: 'wi-group', open: '' }, [el(doc, 'summary', {}, [`Device pairs that lose reachability (${w.reach.pairs.length})`])]);
    d.appendChild(coverageLine(doc, w.reach.coverage));
    const ul = el(doc, 'ul', { class: 'small' });
    for (const p of w.reach.pairs.slice(0, 50)) ul.appendChild(el(doc, 'li', {}, [`${p.from} → ${p.to}${p.partial ? ' (some equal-cost paths)' : ''}: ${p.detail}`]));
    if (w.reach.pairs.length > 50) ul.appendChild(el(doc, 'li', { class: 'muted' }, [`… ${w.reach.pairs.length - 50} more (in the text export)`]));
    d.appendChild(ul);
    box.appendChild(d);
  }
  box.appendChild(limitsDetails(doc, w.info));
  return box;
}

/** The evidence of an item of a scenario: a dependency, a requirement, a demand. */
export function scenarioEvidence(doc: Document, w: WhatIf, key: string, context: string): EvidenceView | null {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === 'dep') {
    const c = w.deps.find((x) => x.dep.key === id);
    if (!c) return null;
    const next: EvidenceAction[] = [];
    for (const o of c.dep.options) if (o.request) next.push({ id: 'communication', label: `Check ${o.text} in Communication`, why: 'This option’s communication, in Communication (on the configured model as it is: no failure applied)', ref: JSON.stringify(o.request) });
    if (c.dep.kind === 'timing') next.push({ id: 'focus-timing', label: 'Focus on its timing context', ref: c.dep.consumer });
    return {
      kind: 'Dependency',
      title: c.dep.text,
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [DEP_CHANGE_TEXT[c.change] + ': ']), c.text]), el(doc, 'p', { class: 'small muted' }, [`When unavailable: ${c.dep.consequence}.`])],
      evidence: [el(doc, 'dl', { class: 'trace-ends small' }, [el(doc, 'dt', {}, ['Before']), el(doc, 'dd', {}, [c.before.text]), el(doc, 'dt', {}, ['Under the condition']), el(doc, 'dd', {}, [c.after.text]), el(doc, 'dt', {}, ['Options']), el(doc, 'dd', {}, [c.dep.options.map((o) => o.text).join('; ') || '—'])])],
      objects: [{ ref: c.dep.consumerRef, label: c.dep.consumerRef.replace(/^[a-z]+:/, '') }].concat(c.dep.options.filter((o) => !!o.provider).map((o) => ({ ref: 'device:' + o.provider, label: o.provider as string }))),
      next,
    };
  }
  if (kind === 'wexp') {
    const x = w.expectations.find((y) => y.after.id === id);
    if (!x) return null;
    return {
      kind: 'Requirement',
      title: x.after.name,
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [EXP_CHANGE_TEXT[x.change] + ': ']), x.after.reason])],
      evidence: [el(doc, 'dl', { class: 'trace-ends small' }, [el(doc, 'dt', {}, ['Before']), el(doc, 'dd', {}, [`${x.before.verdict} — ${x.before.reason}`]), el(doc, 'dt', {}, ['Under the condition']), el(doc, 'dd', {}, [`${x.after.verdict} — ${x.after.reason}`])])],
      objects: x.after.refs.filter((r) => /^(device|iface|link|relation):/.test(r)).slice(0, 24).map((r) => ({ ref: r, label: r.replace(/^[a-z]+:/, '') })),
      next: [{ id: 'requirement', label: 'Open in Design review', ref: x.after.id }],
    };
  }
  if (kind === 'cap' && w.capacity) {
    const x = w.capacity.changes.find((y) => y.demand.id === id);
    if (!x) return null;
    return capChangeEvidence(doc, x, context);
  }
  return null;
}

// ------------------------------------------------------------ capacity

export interface CapacityView {
  model: Model;
  form: WhatIfForm;
  /** the baseline, and the state under the condition when one was given */
  result: { before: CapacityResult; after: CapacityResult | null; changes: CapacityChange[]; condition: string[] } | null;
  bar: ContextBarState;
  sel: string;
}

/** The question of Capacity (left): the context, an optional failure condition, Evaluate. */
export function capacityRequest(doc: Document, v: CapacityView, act: WhatIfActions & { capRun(): void }): HTMLElement {
  const sec = el(doc, 'div', { class: 'cap-section' });
  sec.appendChild(contextBar(doc, v.bar, act));
  sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['The traffic the model states (demands, applications with an interval) against the stated speeds of the cables, aggregates and radios on its way. Not measured throughput, not hardware performance.']));
  const form = el(doc, 'form', { class: 'trace-form', 'aria-label': 'Capacity' }) as HTMLFormElement;
  form.appendChild(el(doc, 'p', { class: 'small' }, ['Under a failure condition (optional):']));
  form.appendChild(conditionForm(doc, v.model, v.form, act, 'cap', true));
  form.appendChild(el(doc, 'div', { class: 'tf-actions' }, [el(doc, 'button', { type: 'submit', class: 'primary', id: 'cap-go' }, ['Evaluate capacity'])]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act.capRun();
  });
  sec.appendChild(form);
  return sec;
}

const CAP_VERDICT: { [k: string]: string } = { fits: 'Fits', exceeds: 'Exceeds', distribution: 'Depends on the distribution', unknown: 'Insufficient information', 'not-applicable': 'Not carried' };

/** The capacity results (bottom): the demands, then each resource and direction with its bounds; under a condition, what changes. */
export function capacityResults(doc: Document, v: CapacityView): HTMLElement {
  const box = el(doc, 'div', { class: 'cap-result', id: 'cap-result' });
  const r = v.result;
  if (!r) {
    box.appendChild(el(doc, 'p', { class: 'muted' }, ['Evaluate capacity: the stated demands and the resources they cross appear here.']));
    return box;
  }
  const res = r.after || r.before;
  const sel = v.sel;
  box.appendChild(el(doc, 'p', { class: 'an-verdict', role: 'status', id: 'cap-summary', tabindex: '-1' }, [el(doc, 'strong', {}, [r.condition.length ? `Under the failure of ${r.condition.join(', ')}: ` : 'Configured model: ']), res.text]));
  if (!res.evaluated) {
    box.appendChild(el(doc, 'p', { class: 'small muted' }, ['State traffic in the model to evaluate capacity: a demand (from, to, rate) or an application with an interval and sizes.']));
    return box;
  }
  if (r.after && r.changes.some((x) => x.change !== 'unchanged')) {
    const sec = el(doc, 'section', { class: 'wi-group', 'aria-labelledby': 'cap-ch-h' }, [el(doc, 'h4', { id: 'cap-ch-h' }, ['Changes under the condition'])]);
    const ul = el(doc, 'ul', { class: 'small' });
    for (const x of r.changes.filter((y) => y.change !== 'unchanged')) ul.appendChild(pickItem(doc, 'cap:' + x.demand.id, sel, [el(doc, 'strong', {}, [CAP_CHANGE_TEXT[x.change] + ': ']), x.demand.label], { 'data-cap-change': x.change }));
    sec.appendChild(ul);
    box.appendChild(sec);
  }
  // the demands
  const t = el(doc, 'table', { class: 'spof-table cap-table' });
  t.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Stated demands; a row shows its evidence']));
  t.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, ['Demand', 'From → To', 'Stated demand', 'Deciding resource', 'Verdict'].map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
  const tb = el(doc, 'tbody');
  for (const d of res.demands) {
    const key = 'cap:' + d.demand.id;
    const on = key === sel;
    tb.appendChild(
      el(doc, 'tr', { 'data-an-item': key, tabindex: '0', 'data-cap': d.verdict, class: on ? 'an-selected' : '', ...(on ? { 'aria-current': 'true' } : {}) }, [
        el(doc, 'th', { scope: 'row' }, [d.demand.label]),
        el(doc, 'td', {}, [`${d.demand.from} → ${d.demand.to}`]),
        el(doc, 'td', { class: 'num' }, [bpsText(d.demand.bps), el(doc, 'div', { class: 'muted small' }, [d.demand.source === 'demand' ? 'a demand' : 'an application'])]),
        el(doc, 'td', {}, [d.text]),
        el(doc, 'td', { class: 'nowrap' }, [CAP_VERDICT[d.verdict] || d.verdict]),
      ]),
    );
  }
  t.appendChild(tb);
  box.appendChild(el(doc, 'div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Stated demands' }, [t]));
  // the resources and directions, with the bounds
  const rd = el(doc, 'details', { class: 'wi-group', id: 'cap-resources' }, [el(doc, 'summary', {}, [`Resources and directions (${res.loads.length})`])]);
  const rl = el(doc, 'ul', { class: 'small' });
  for (const l of res.loads.slice(0, 80)) rl.appendChild(el(doc, 'li', { 'data-cap': l.verdict }, [loadText(l)]));
  if (res.loads.length > 80) rl.appendChild(el(doc, 'li', { class: 'muted' }, [`… ${res.loads.length - 80} more`]));
  rd.appendChild(rl);
  box.appendChild(rd);
  const missing = res.loads.filter((l) => l.verdict === 'unknown');
  if (missing.length) box.appendChild(el(doc, 'p', { class: 'small', id: 'cap-missing' }, [el(doc, 'strong', {}, ['Missing information: ']), missing.map((l) => l.resource.what).join(', '), ' — no speed written.']));
  const lim = el(doc, 'details', { class: 'an-limits' }, [el(doc, 'summary', {}, ['Assumptions and limits'])]);
  lim.appendChild(el(doc, 'ul', { class: 'small' }, res.assumptions.map((a) => el(doc, 'li', {}, [a]))));
  lim.appendChild(el(doc, 'p', { class: 'small muted' }, ['Stated rates against stated speeds: no measured throughput, queues, delay or hardware forwarding limits, and no claim of wire-rate accuracy.']));
  box.appendChild(lim);
  return box;
}

const loadText = (l: ResourceLoad): string => `${l.resource.what}${l.resource.direction ? ` (${l.resource.direction})` : ''}: ${l.resource.capacity === null ? 'no speed written' : bpsText(l.resource.capacity)}; ${bpsText(l.equal)} split equally, ${bpsText(l.worst)} on one path — ${CAP_VERDICT[l.verdict]}`;

function capChangeEvidence(doc: Document, x: CapacityChange, context: string): EvidenceView {
  const row = (k: string, d: DemandResult): Node[] => [el(doc, 'dt', {}, [k]), el(doc, 'dd', {}, [`${CAP_VERDICT[d.verdict] || d.verdict} — ${d.text}${d.perFlow ? ' · ' + d.perFlow : ''}`])];
  return {
    kind: 'Demand',
    title: x.demand.label,
    context,
    explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [CAP_CHANGE_TEXT[x.change] + ': ']), `${bpsText(x.demand.bps)} stated, ${x.demand.from} → ${x.demand.to}`])],
    evidence: [el(doc, 'dl', { class: 'trace-ends small' }, [...row('Before', x.before), ...row('Under the condition', x.after)])],
    objects: [x.demand.from, x.demand.to].filter((d) => !!d && d.indexOf('/') < 0).map((d) => ({ ref: 'device:' + d.split(':')[0], label: d })),
    next: [{ id: 'communication', label: 'Check this demand’s communication', ref: JSON.stringify({ from: x.demand.from, to: x.demand.to }) }],
  };
}

/** The evidence of a demand in Capacity. */
export function capacityEvidence(doc: Document, v: CapacityView, key: string, context: string): EvidenceView | null {
  const r = v.result;
  if (!r || key.indexOf('cap:') !== 0) return null;
  const id = key.slice(4);
  const ch = r.changes.find((x) => x.demand.id === id);
  if (ch && r.after) return capChangeEvidence(doc, ch, context);
  const res = r.after || r.before;
  const d = res.demands.find((x) => x.demand.id === id);
  if (!d) return null;
  const loads = res.loads.filter((l) => l.demands.indexOf(id) >= 0);
  return {
    kind: 'Demand',
    title: d.demand.label,
    context,
    explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [(CAP_VERDICT[d.verdict] || d.verdict) + ': ']), d.text]), el(doc, 'p', { class: 'small muted' }, [`${bpsText(d.demand.bps)} stated (${d.demand.source === 'demand' ? 'a demand' : 'an application with an interval'})${d.ends ? '; traced between ' + d.ends : ''}; ${d.paths} evaluated path${d.paths === 1 ? '' : 's'}${d.demand.note ? '; assumed: ' + d.demand.note : ''}.`])],
    evidence: [el(doc, 'ul', { class: 'small' }, loads.map((l) => el(doc, 'li', { 'data-cap': l.verdict }, [loadText(l)]))), ...(d.perFlow ? [el(doc, 'p', { class: 'small' }, [d.perFlow])] : [])],
    objects: Array.from(new Set(loads.flatMap((l) => l.resource.refs))).slice(0, 24).map((x) => ({ ref: x, label: x.replace(/^[a-z]+:/, '') })),
    next: [{ id: 'communication', label: 'Check this demand’s communication', ref: JSON.stringify({ from: d.demand.from, to: d.demand.to }) }],
  };
}

// ------------------------------------------------------------ failure domains (an explicit editor)

/** The failure domains' editor body: the list with Edit and Delete, and the add / edit fields. */
export function domainsEditorBody(doc: Document, model: Model, f: DomainForm | null, locked: string, act: { edit(id: string): void; remove(id: string): void; add(): void; input(k: keyof DomainForm, v: string): void }): HTMLElement {
  const box = el(doc, 'div', { class: 'wi-domains' });
  box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Components that fail together (a rack, a room, shared power, a conduit, a provider), by explicit membership. A group of the diagram is no failure domain unless one names it.']));
  const ul = el(doc, 'ul', { class: 'small wi-dom-list' });
  for (const d of model.failureDomains) {
    const edit = el(doc, 'button', { type: 'button', class: 'mini', 'data-dom-edit': d.id, title: locked || 'Edit the failure domain' }, ['Edit']) as HTMLButtonElement;
    edit.disabled = !!locked;
    edit.addEventListener('click', () => act.edit(d.id));
    const del = el(doc, 'button', { type: 'button', class: 'mini', 'data-dom-del': d.id, title: locked || 'Delete the failure domain' }, ['Delete']) as HTMLButtonElement;
    del.disabled = !!locked;
    del.addEventListener('click', () => act.remove(d.id));
    ul.appendChild(el(doc, 'li', { 'data-domain': d.id }, [el(doc, 'strong', {}, [d.label]), ` (${(FAILURE_DOMAIN_KINDS.find((k) => k.id === d.kind) || { label: d.kind }).label}): ${d.members.join(', ')} `, edit, del]));
  }
  if (!model.failureDomains.length) ul.appendChild(el(doc, 'li', { class: 'muted' }, ['None yet.']));
  box.appendChild(ul);
  if (!f) {
    const add = el(doc, 'button', { type: 'button', class: 'mini', id: 'dom-add', title: locked || 'Add a failure domain to the model' }, ['Add failure domain']) as HTMLButtonElement;
    add.disabled = !!locked;
    add.addEventListener('click', () => act.add());
    box.appendChild(add);
    return box;
  }
  box.appendChild(el(doc, 'h4', {}, [f.index < 0 ? 'New failure domain' : `Failure domain ${model.failureDomains[f.index] ? model.failureDomains[f.index].label : ''}`]));
  const list = el(doc, 'datalist', { id: 'dom-parts' });
  for (const d of model.devices) list.appendChild(el(doc, 'option', { value: d.id }, ['Device']));
  for (const l of model.links) list.appendChild(el(doc, 'option', { value: l.id }, ['Cable']));
  for (const r of model.relations) list.appendChild(el(doc, 'option', { value: r.id }, ['Relation']));
  for (const g of model.groups) list.appendChild(el(doc, 'option', { value: g.id }, ['Group']));
  box.appendChild(list);
  const grid = el(doc, 'div', { class: 'tf-grid' });
  const name = el(doc, 'input', { id: 'dom-f-label', type: 'text', autocomplete: 'off', placeholder: 'Rack A' }) as HTMLInputElement;
  name.value = f.label;
  name.addEventListener('input', () => act.input('label', name.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dom-f-label' }, ['Name']), name]));
  const kind = el(doc, 'select', { id: 'dom-f-kind' }) as HTMLSelectElement;
  for (const k of FAILURE_DOMAIN_KINDS) kind.appendChild(el(doc, 'option', { value: k.id }, [k.label]));
  kind.value = f.kind;
  kind.addEventListener('change', () => act.input('kind', kind.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dom-f-kind' }, ['Kind']), kind]));
  const mem = el(doc, 'input', { id: 'dom-f-members', type: 'text', list: 'dom-parts', autocomplete: 'off', spellcheck: 'false', placeholder: 'devices, cables, relations, groups (comma-separated)' }) as HTMLInputElement;
  mem.value = f.members;
  mem.addEventListener('input', () => act.input('members', mem.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dom-f-members' }, ['Members']), mem]));
  box.appendChild(grid);
  return box;
}

/** A what-if as text. */
export function whatIfText(o: { title: string; version?: string; outdated: boolean }, w: WhatIf): string {
  const lines = exportHeader({ analysis: 'Resilience: failure scenario', title: o.title, info: w.info, version: o.version, outdated: o.outdated });
  lines.push(`Failure of ${w.entries.join(', ')}: ${w.refs.join(', ')}`);
  if (w.unknown.length) lines.push(`Not in the model: ${w.unknown.join(', ')}`);
  lines.push('');
  for (const k of CHANGE_ORDER) {
    const list = w.deps.filter((d) => d.change === k);
    if (!list.length) continue;
    lines.push(`${DEP_CHANGE_TEXT[k]} (${list.length}):`);
    for (const c of list) lines.push(`  ${DEP_LABEL[c.dep.kind]}: ${c.dep.text} — ${c.text}`);
  }
  for (const x of w.expectations) lines.push(`Requirement ${x.after.name} (${x.after.expect}): ${EXP_CHANGE_TEXT[x.change]} — before ${x.before.verdict}, after ${x.after.verdict} — ${x.after.reason}`);
  if (w.capacity) {
    lines.push(`Capacity: ${w.capacity.after.text}`);
    for (const x of w.capacity.changes.filter((y) => y.change !== 'unchanged')) lines.push(`  ${CAP_CHANGE_TEXT[x.change]}: ${x.demand.label} — ${x.after.text}`);
  }
  if (w.structural && w.structural.isolated.length) lines.push(`Disconnected: ${w.structural.isolated.map((g) => g.join(', ')).join('; ')}`);
  if (w.reach) {
    lines.push(`Device pairs that lose reachability (${w.reach.pairs.length}); ${coverageText(w.reach.coverage)}:`);
    for (const p of w.reach.pairs) lines.push(`  ${p.from} → ${p.to}${p.partial ? ' (some equal-cost paths)' : ''}: ${p.detail}`);
  }
  lines.push('');
  for (const l of exportFooter(w.info)) lines.push(l);
  return lines.join('\n') + '\n';
}


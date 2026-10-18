/**
 * The Single points of failure window (Analyze → Single points of
 * failure…): what counts as one, then a table of them with the element,
 * its type, what it cuts off, the relations that go down and its structural
 * impact (an object count, not a business criticality or a probability),
 * and, checked progressively and cancellably, its service impact (the
 * configured dependencies that become unavailable); sortable by any column
 * (aria-sort) and filtered by text; each row with Show in diagram and What
 * if. Below it the what-if check of a failure domain or a small explicit
 * set of components against the same baseline, and the model's failure
 * domains. The table as CSV or as text (copy or save), with the context and
 * coverage. spofRows, spofCsv and spofText are pure (no DOM); the body is
 * built from elements and text nodes only.
 */
import { DEP_CHANGE_TEXT, DEP_LABEL, DepChange } from '../analysis/dependencies';
import { Spof, SpofCandidate, refLabel } from '../analysis/failure';
import { Coverage, ResultInfo, contextText, coverageText, exportFooter, exportHeader } from '../analysis/result';
import { WhatIf } from '../analysis/whatif';
import { FAILURE_DOMAIN_KINDS, Model } from '../model/types';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, coverageLine, limitsDetails } from './analysis-ui';

export type SpofSort = 'element' | 'type' | 'cuts' | 'relations' | 'impact' | 'service';

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
  /** structural impact: devices cut off (guests that go down included) + relations down */
  impact: number;
  /** the configured dependencies that become unavailable (null: not checked yet) */
  service: number | null;
  /** what becomes unavailable, in words */
  serviceText: string;
  /** the failure it stands for */
  fail: string[];
  /** the order of the report (most impact first) */
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

/**
 * The rows of a report: the structural single points (in their order), and
 * the candidates whose failure makes a configured dependency unavailable
 * although it cuts nothing off; with each one's service impact once it is
 * checked (`service`, by candidate ref).
 */
export function spofRows(model: Model, list: Spof[], service: Map<string, DepChange[]> | null = null, cands: SpofCandidate[] = []): SpofRow[] {
  const rows: SpofRow[] = list.map((s, i) => {
    const devicesCut = s.isolated.reduce((n, g) => n + g.length, 0) + s.guests.length;
    const cuts = s.isolated.map((g) => g.join(', ')).join('; ');
    const ch = service ? service.get(s.ref) : undefined;
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
      service: ch ? ch.filter((c) => c.change === 'unavailable').length : null,
      serviceText: ch ? serviceText(ch) : '',
      fail: s.fail,
      rank: i,
    };
  });
  if (service) {
    for (const c of cands) {
      if (rows.some((r) => r.ref === c.ref)) continue;
      const ch = service.get(c.ref);
      const n = ch ? ch.filter((x) => x.change === 'unavailable').length : 0;
      if (!n) continue;
      rows.push({ ref: c.ref, element: elementText(model, c), type: TYPE[c.kind], cuts: '', relations: '', devicesCut: 0, relationsDown: 0, impact: 0, service: n, serviceText: serviceText(ch as DepChange[]), fail: c.fail, rank: rows.length });
    }
  }
  return rows;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rows shown: filtered (every word must occur in the row's text) and sorted; ties keep the report's order. */
export function shownSpofRows(rows: SpofRow[], st: SpofViewState): SpofRow[] {
  const words = st.filter.toLowerCase().split(/\s+/).filter((w) => w);
  const hit = (r: SpofRow): boolean => {
    const text = `${r.element} ${r.type} ${r.cuts} ${r.relations} ${r.serviceText}`.toLowerCase();
    return words.every((w) => text.indexOf(w) >= 0);
  };
  const key = (r: SpofRow): number | string => (st.sort === 'impact' ? r.impact : st.sort === 'service' ? (r.service === null ? -1 : r.service) : st.sort === 'element' ? r.element.toLowerCase() : st.sort === 'type' ? r.type : st.sort === 'cuts' ? r.devicesCut : r.relationsDown);
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
  const head = ['element', 'type', 'cuts_off', 'relations_down', 'devices_cut_off', 'relations_down_count', 'structural_impact', 'services_unavailable', 'service_impact', 'context'];
  return [head.join(',')].concat(rows.map((r) => [r.element, r.type, r.cuts, r.relations, r.devicesCut, r.relationsDown, r.impact, r.service === null ? '' : r.service, r.serviceText, context].map(csvCell).join(','))).join('\n') + '\n';
}

/** The rows as plain text, one block per row, with the context and coverage. */
export function spofText(model: Model, rows: SpofRow[], o: { info?: ResultInfo; version?: string; outdated?: boolean } = {}): string {
  const lines = o.info ? exportHeader({ analysis: 'Single points of failure', title: model.title, info: o.info, version: o.version, outdated: o.outdated }) : [`Single points of failure — ${model.title}`];
  lines.push(`${rows.length} single point${rows.length === 1 ? '' : 's'} of failure, most structural impact first.`, '');
  for (const r of rows) {
    lines.push(`${r.type} ${r.element} (structural impact ${r.impact})`);
    lines.push(`  cuts off: ${r.cuts || 'nothing'}`);
    lines.push(`  relations down: ${r.relations || 'none'}`);
    lines.push(`  services unavailable: ${r.service === null ? 'not checked' : r.service ? `${r.service} (${r.serviceText})` : 'none'}`);
  }
  if (o.info) {
    lines.push('');
    for (const l of exportFooter(o.info)) lines.push(l);
  }
  return lines.join('\n') + '\n';
}

const COLS: Array<[SpofSort, string]> = [
  ['element', 'Element'],
  ['type', 'Type'],
  ['cuts', 'Cuts off'],
  ['relations', 'Relations down'],
  ['impact', 'Structural impact'],
  ['service', 'Service impact'],
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
  whatif: WhatIfView;
  info: ResultInfo;
}

export interface SpofActions extends ContextBarActions {
  stop(): void;
  whatIf(entries: string[]): void;
}

/** The window's content. Its buttons carry data-spof-sort, data-spof-show, data-spof-out (csv-copy, csv-save, text-copy, text-save), data-spof-whatif. */
export function spofBody(doc: Document, rows: SpofRow[], st: SpofViewState, view: SpofView, act: SpofActions & WhatIfActions): HTMLElement {
  const box = el(doc, 'div', { class: 'spof-body' });
  box.appendChild(contextBar(doc, view.bar, act));
  box.appendChild(
    el(doc, 'p', { class: 'small' }, [
      'A single point of failure is one cable, device or LAG (all its member cables at once) whose failure alone cuts devices off, brings down relations although their endpoints are still up, or makes a configured service dependency unavailable (an application’s peer, an MQTT broker, DNS, DHCP, a timing source, syslog, AAA); for virtual machines and containers also a host, a virtual switch with one uplink or with its uplinks to one switch, and a passthrough port. ',
      el(doc, 'strong', {}, ['Structural impact']),
      ' counts the devices cut off (guests that go down included) and the relations that go down: an object count, not a business criticality or a probability.',
    ]),
  );
  const filter = el(doc, 'input', { type: 'search', id: 'spof-filter', 'data-spof-filter': '', placeholder: 'Filter: element, type, device, relation, service', 'aria-label': 'Filter the single points of failure', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  filter.value = st.filter;
  const out = (k: string, label: string): HTMLElement => el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-out': k }, [label]);
  box.appendChild(el(doc, 'div', { class: 'spof-tools' }, [filter, el(doc, 'span', { class: 'spof-out', role: 'group', 'aria-label': 'Export the table' }, [out('csv-copy', 'Copy CSV'), out('csv-save', 'Save CSV'), out('text-copy', 'Copy text'), out('text-save', 'Save text')])]));
  box.appendChild(progressLine(doc, view.progress, act));
  box.appendChild(spofTable(doc, rows, st, view));
  box.appendChild(limitsDetails(doc, view.info));
  box.appendChild(whatIfSection(doc, view.whatif, act));
  return box;
}

/** The service check's progress, with Stop while it runs. */
export function progressLine(doc: Document, p: SpofProgress | null, act: { stop(): void }): HTMLElement {
  const line = el(doc, 'p', { class: 'small spof-progress', id: 'spof-progress', role: 'status', 'aria-live': 'polite' });
  if (!p) return line;
  if (p.running) {
    line.appendChild(doc.createTextNode(`Checking the service impact: ${p.checked} of ${p.total} candidates… `));
    const stop = el(doc, 'button', { type: 'button', class: 'mini', id: 'spof-stop' }, ['Stop']);
    stop.addEventListener('click', () => act.stop());
    line.appendChild(stop);
  } else {
    const cov: Coverage = { checked: p.checked, eligible: p.total, unit: 'candidates', cancelled: p.cancelled };
    line.appendChild(doc.createTextNode(p.deps ? `Service impact: ${coverageText(cov)}, against ${p.deps} configured dependenc${p.deps === 1 ? 'y' : 'ies'}${p.indeterminate ? ` (${p.indeterminate} not determinable in the configured model)` : ''}.` : `Service impact: the model configures no service dependency (application peers, brokers, resolvers, DHCP, timing, syslog or AAA senders): ${coverageText(cov)}, none affected.`));
  }
  return line;
}

/** The status line and the table (redrawn on sorting, filtering and progress). */
export function spofTable(doc: Document, rows: SpofRow[], st: SpofViewState, view: SpofView): HTMLElement {
  const shown = shownSpofRows(rows, st);
  const wrap = el(doc, 'div', { class: 'spof-tables' });
  const done = !!view.progress && !view.progress.running && !view.progress.cancelled;
  const empty = done
    ? 'No single point of failure found under the selected structural and service checks.'
    : view.progress && view.progress.cancelled
      ? 'No single point of failure found among the candidates checked: the service check was stopped before the end.'
      : 'No structural single point of failure; the service impact is being checked.';
  wrap.appendChild(el(doc, 'p', { id: 'spof-status', class: 'spof-count small', role: 'status' }, [rows.length ? (shown.length === rows.length ? `${rows.length} single point${rows.length === 1 ? '' : 's'} of failure.` : `${shown.length} of ${rows.length} single points of failure shown.`) : empty]));
  if (!rows.length) {
    const d = el(doc, 'details', { class: 'an-limits' }, [el(doc, 'summary', {}, ['What was checked'])]);
    d.appendChild(el(doc, 'p', { class: 'small' }, [`Candidates: ${candidatesText(view.cands) || 'none'}, each failing alone.`]));
    if (view.progress) d.appendChild(el(doc, 'p', { class: 'small' }, [`Service checks: ${view.progress.deps} configured dependenc${view.progress.deps === 1 ? 'y' : 'ies'}${view.progress.indeterminate ? `, ${view.progress.indeterminate} of them not determinable in the configured model (their consumers take their addresses at runtime: a simulation snapshot can tell)` : ''}.`]));
    d.appendChild(el(doc, 'p', { class: 'small' }, ['Not checked: relations or interfaces failing alone, combinations of failures (What if below), dependencies the model does not configure, runtime behaviour.']));
    wrap.appendChild(d);
    return wrap;
  }
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
        el(doc, 'td', {}, r.service === null ? [el(doc, 'span', { class: 'muted' }, ['…'])] : r.service ? [`${r.service} unavailable`, el(doc, 'div', { class: 'muted small' }, [r.serviceText])] : ['—']),
        el(doc, 'td', { class: 'nowrap' }, [
          el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-show': r.ref, 'aria-label': `Show ${r.element} in the diagram` }, ['Show']),
          el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-whatif': r.fail.join(' '), 'aria-label': `What if ${r.element} fails` }, ['What if']),
        ]),
      ]),
    );
  }
  table.appendChild(tb);
  wrap.appendChild(el(doc, 'div', { class: 'table-wrap' }, [table]));
  return wrap;
}

// ------------------------------------------------------------ what if

export interface WhatIfForm {
  mode: 'domain' | 'components';
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
  /** the failure domain form, when one is open */
  domain: DomainForm | null;
  locked: string;
}

export interface WhatIfActions {
  wiInput(k: keyof WhatIfForm, v: string): void;
  wiRun(): void;
  wiOut(kind: 'copy' | 'save'): void;
  domAdd(): void;
  domEdit(id: string): void;
  domRemove(id: string): void;
  domInput(k: keyof DomainForm, v: string): void;
  domSave(): void;
  domCancel(): void;
  goto(ref: string): void;
}

function whatIfSection(doc: Document, v: WhatIfView, act: WhatIfActions): HTMLElement {
  const sec = el(doc, 'section', { class: 'trace-section wi-section', 'aria-labelledby': 'wi-h' });
  sec.appendChild(el(doc, 'h3', { id: 'wi-h' }, ['What if…']));
  sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['A failure domain or a few components fail together; the result is compared with the same baseline. A what-if condition, not a probability; no convergence time is claimed.']));
  const m = v.model;
  const f = v.form;
  const form = el(doc, 'form', { class: 'trace-form', 'aria-label': 'What if' }) as HTMLFormElement;
  const seg = el(doc, 'div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Condition' });
  for (const [k, label] of [['domain', 'Failure domain'], ['components', 'Components']] as Array<['domain' | 'components', string]>) {
    const on = f.mode === k;
    const b = el(doc, 'button', { type: 'button', role: 'radio', class: 'mini' + (on ? ' active' : ''), 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-wi-mode': k }, [label]);
    b.addEventListener('click', () => act.wiInput('mode', k));
    seg.appendChild(b);
  }
  form.appendChild(seg);
  const grid = el(doc, 'div', { class: 'tf-grid' });
  if (f.mode === 'domain') {
    const s = el(doc, 'select', { id: 'wi-domain' }) as HTMLSelectElement;
    s.appendChild(el(doc, 'option', { value: '' }, [m.failureDomains.length ? 'Choose a failure domain…' : 'The model has no failure domain']));
    for (const d of m.failureDomains) s.appendChild(el(doc, 'option', { value: d.id }, [`${d.label} (${(FAILURE_DOMAIN_KINDS.find((k) => k.id === d.kind) || { label: d.kind }).label}, ${d.members.length} member${d.members.length === 1 ? '' : 's'})`]));
    s.value = f.domain;
    s.addEventListener('change', () => act.wiInput('domain', s.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'wi-domain' }, ['Domain']), s]));
  } else {
    const list = el(doc, 'datalist', { id: 'wi-parts' });
    for (const d of m.devices) list.appendChild(el(doc, 'option', { value: d.id }));
    for (const l of m.links) list.appendChild(el(doc, 'option', { value: l.id }, ['cable']));
    for (const r of m.relations) list.appendChild(el(doc, 'option', { value: r.id }, ['relation']));
    form.appendChild(list);
    const i = el(doc, 'input', { id: 'wi-components', type: 'text', list: 'wi-parts', autocomplete: 'off', spellcheck: 'false', placeholder: 'devices, cables, relations, device:interface (comma-separated)' }) as HTMLInputElement;
    i.value = f.components;
    i.addEventListener('input', () => act.wiInput('components', i.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'wi-components' }, ['Fail']), i]));
  }
  const r = el(doc, 'select', { id: 'wi-reach' }) as HTMLSelectElement;
  r.appendChild(el(doc, 'option', { value: '' }, ['Services and expectations only']));
  r.appendChild(el(doc, 'option', { value: 'entire' }, ['Also device pairs: entire architecture (bounded)']));
  for (const g of m.groups) r.appendChild(el(doc, 'option', { value: 'group:' + g.id }, [`Also device pairs: ${g.label}`]));
  r.value = f.reach;
  r.addEventListener('change', () => act.wiInput('reach', r.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'wi-reach' }, ['Check']), r]));
  form.appendChild(grid);
  form.appendChild(el(doc, 'div', { class: 'tf-actions' }, [el(doc, 'button', { type: 'submit', class: 'primary', id: 'wi-go' }, ['Analyze'])]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act.wiRun();
  });
  sec.appendChild(form);
  if (v.result) sec.appendChild(whatIfResult(doc, v, act));
  sec.appendChild(domainsBox(doc, v, act));
  return sec;
}

const CHANGE_ORDER: Array<DepChange['change']> = ['unavailable', 'degraded', 'indeterminate', 'alternative', 'consumer-down', 'not-before'];

/** The what-if result: the verdict counts, the dependencies by change, the expectations, structure, pairs, limits. */
function whatIfResult(doc: Document, v: WhatIfView, act: WhatIfActions): HTMLElement {
  const w = v.result as WhatIf;
  const box = el(doc, 'div', { class: 'wi-result', id: 'wi-result' });
  if (v.outdated) box.appendChild(el(doc, 'p', { class: 'an-outdated small', role: 'status' }, ['⟳ Outdated: the model changed after this result; Analyze again.']));
  box.appendChild(el(doc, 'p', { class: 'an-ctx-line small' }, [el(doc, 'span', { class: 'an-ctx-k' }, ['Context: ']), contextText(w.info.context)]));
  if (w.unknown.length) box.appendChild(el(doc, 'p', { class: 'trace-error', role: 'alert' }, [`Not in the model: ${w.unknown.join(', ')}.`]));
  if (w.tooLarge || !w.result) {
    box.appendChild(el(doc, 'p', { class: 'small' }, [w.info.limits[w.info.limits.length - 1] || 'Nothing was evaluated.']));
    return box;
  }
  const n = (k: string): number => w.deps.filter((d) => d.change === k).length;
  const lostExp = w.expectations.filter((x) => x.before.verdict === 'satisfied' && x.after.verdict !== 'satisfied').length;
  box.appendChild(
    el(doc, 'p', { class: 'an-verdict ' + (n('unavailable') || lostExp ? 'v-violated' : n('indeterminate') ? 'v-indeterminate' : 'v-satisfied'), role: 'status', id: 'wi-summary' }, [
      el(doc, 'strong', {}, [`Failure of ${w.entries.join(', ')}`]),
      ` (${w.refs.length} component${w.refs.length === 1 ? '' : 's'}): ${n('unavailable')} dependenc${n('unavailable') === 1 ? 'y becomes' : 'ies become'} unavailable, ${n('alternative')} through an alternative, ${n('degraded')} degraded, ${n('indeterminate')} cannot be determined; ${lostExp} saved expectation${lostExp === 1 ? '' : 's'} no longer satisfied.`,
    ]),
  );
  // the dependencies, by change
  for (const k of CHANGE_ORDER) {
    const list = w.deps.filter((d) => d.change === k);
    if (!list.length) continue;
    const d = el(doc, 'details', { class: 'wi-group', 'data-change': k }, [el(doc, 'summary', {}, [`${DEP_CHANGE_TEXT[k]} (${list.length})`])]);
    if (k === 'unavailable' || k === 'degraded') d.setAttribute('open', '');
    const ul = el(doc, 'ul', { class: 'small' });
    for (const c of list) {
      const b = el(doc, 'button', { type: 'button', class: 'ref' }, [c.dep.text]);
      b.addEventListener('click', () => act.goto(c.dep.consumerRef));
      ul.appendChild(el(doc, 'li', {}, [el(doc, 'span', { class: 'muted' }, [DEP_LABEL[c.dep.kind] + ': ']), b, el(doc, 'div', { class: 'muted' }, [c.text])]));
    }
    d.appendChild(ul);
    box.appendChild(d);
  }
  // the expectations that must stay available
  if (w.expectations.length) {
    const d = el(doc, 'details', { class: 'wi-group', open: '' }, [el(doc, 'summary', {}, [`Saved expectations (${w.expectations.length})`])]);
    const ul = el(doc, 'ul', { class: 'small' });
    for (const x of w.expectations) ul.appendChild(el(doc, 'li', { class: 'v-' + x.after.verdict }, [el(doc, 'strong', {}, [x.after.name + ': ']), `before ${x.before.verdict}, after ${x.after.verdict}${x.alternative ? ' (through an alternative path)' : ''}`, el(doc, 'div', { class: 'muted' }, [x.after.reason])]));
    d.appendChild(ul);
    box.appendChild(d);
  }
  // the structure
  const s = w.summary;
  if (s) {
    const part = (label: string, list: Array<{ ref: string; state: string }>): string => (list.length ? `${label}: ${list.map((x) => x.ref.replace(/^[a-z]+:/, '') + (x.state === 'degraded' || x.state === 'takeover' ? ' (degraded)' : '')).join(', ')}` : '');
    const lines = [part('Devices', s.devices), part('Cables', s.links), part('Relations', s.relations), part('Tunnels', s.tunnels), part('Networks', s.networks), part('Routes', s.routes)].filter((x) => x);
    const d = el(doc, 'details', { class: 'wi-group' }, [el(doc, 'summary', {}, [`Structure: down or degraded (${lines.length ? s.devices.length + s.links.length + s.relations.length + s.tunnels.length + s.networks.length + s.routes.length : 0})`])]);
    if (w.structural && w.structural.isolated.length) d.appendChild(el(doc, 'p', { class: 'small' }, [`Cut off: ${w.structural.isolated.map((g) => g.join(', ')).join('; ')}`]));
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
  const copy = el(doc, 'button', { type: 'button', class: 'mini', id: 'wi-copy' }, ['Copy as text']);
  copy.addEventListener('click', () => act.wiOut('copy'));
  const save = el(doc, 'button', { type: 'button', class: 'mini', id: 'wi-save' }, ['Save as text']);
  save.addEventListener('click', () => act.wiOut('save'));
  box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [copy, save]));
  box.appendChild(limitsDetails(doc, w.info));
  return box;
}

/** The model's failure domains: a list with Edit and Delete, and the add / edit form. */
function domainsBox(doc: Document, v: WhatIfView, act: WhatIfActions): HTMLElement {
  const box = el(doc, 'div', { class: 'wi-domains' });
  box.appendChild(el(doc, 'h4', {}, ['Failure domains of the model']));
  box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Components that fail together (a rack, a room, shared power, a conduit, a provider), by explicit membership. A group of the diagram is no failure domain unless one names it.']));
  const ul = el(doc, 'ul', { class: 'small wi-dom-list' });
  for (const d of v.model.failureDomains) {
    const edit = el(doc, 'button', { type: 'button', class: 'mini', 'data-dom-edit': d.id, title: v.locked || 'Edit the failure domain' }, ['Edit']) as HTMLButtonElement;
    edit.disabled = !!v.locked;
    edit.addEventListener('click', () => act.domEdit(d.id));
    const del = el(doc, 'button', { type: 'button', class: 'mini', 'data-dom-del': d.id, title: v.locked || 'Delete the failure domain' }, ['Delete']) as HTMLButtonElement;
    del.disabled = !!v.locked;
    del.addEventListener('click', () => act.domRemove(d.id));
    ul.appendChild(el(doc, 'li', { 'data-domain': d.id }, [el(doc, 'strong', {}, [d.label]), ` (${(FAILURE_DOMAIN_KINDS.find((k) => k.id === d.kind) || { label: d.kind }).label}): ${d.members.join(', ')} `, edit, del]));
  }
  if (!v.model.failureDomains.length) ul.appendChild(el(doc, 'li', { class: 'muted' }, ['None yet.']));
  box.appendChild(ul);
  if (v.domain) {
    const f = v.domain;
    const form = el(doc, 'form', { class: 'trace-form', 'aria-label': f.index < 0 ? 'Add failure domain' : 'Edit failure domain' }) as HTMLFormElement;
    const list = el(doc, 'datalist', { id: 'dom-parts' });
    for (const d of v.model.devices) list.appendChild(el(doc, 'option', { value: d.id }));
    for (const l of v.model.links) list.appendChild(el(doc, 'option', { value: l.id }, ['cable']));
    for (const r of v.model.relations) list.appendChild(el(doc, 'option', { value: r.id }, ['relation']));
    for (const g of v.model.groups) list.appendChild(el(doc, 'option', { value: g.id }, ['group']));
    form.appendChild(list);
    const grid = el(doc, 'div', { class: 'tf-grid' });
    const name = el(doc, 'input', { id: 'dom-f-label', type: 'text', autocomplete: 'off', placeholder: 'Rack A' }) as HTMLInputElement;
    name.value = f.label;
    name.addEventListener('input', () => act.domInput('label', name.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dom-f-label' }, ['Name']), name]));
    const kind = el(doc, 'select', { id: 'dom-f-kind' }) as HTMLSelectElement;
    for (const k of FAILURE_DOMAIN_KINDS) kind.appendChild(el(doc, 'option', { value: k.id }, [k.label]));
    kind.value = f.kind;
    kind.addEventListener('change', () => act.domInput('kind', kind.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dom-f-kind' }, ['Kind']), kind]));
    const mem = el(doc, 'input', { id: 'dom-f-members', type: 'text', list: 'dom-parts', autocomplete: 'off', spellcheck: 'false', placeholder: 'devices, cables, relations, groups (comma-separated)' }) as HTMLInputElement;
    mem.value = f.members;
    mem.addEventListener('input', () => act.domInput('members', mem.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dom-f-members' }, ['Members']), mem]));
    form.appendChild(grid);
    if (f.error) form.appendChild(el(doc, 'p', { class: 'trace-error', id: 'dom-f-error', role: 'alert' }, [f.error]));
    const cancel = el(doc, 'button', { type: 'button', id: 'dom-f-cancel' }, ['Cancel']);
    cancel.addEventListener('click', () => act.domCancel());
    form.appendChild(el(doc, 'div', { class: 'tf-actions' }, [el(doc, 'button', { type: 'submit', class: 'primary', id: 'dom-f-save' }, [f.index < 0 ? 'Add' : 'Save']), cancel]));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      act.domSave();
    });
    box.appendChild(form);
  } else {
    const add = el(doc, 'button', { type: 'button', id: 'dom-add', title: v.locked || 'Add a failure domain to the model' }, ['Add failure domain']) as HTMLButtonElement;
    add.disabled = !!v.locked;
    add.addEventListener('click', () => act.domAdd());
    box.appendChild(add);
  }
  return box;
}

/** A what-if as text. */
export function whatIfText(o: { title: string; version?: string; outdated: boolean }, w: WhatIf): string {
  const lines = exportHeader({ analysis: 'What if', title: o.title, info: w.info, version: o.version, outdated: o.outdated });
  lines.push(`Failure of ${w.entries.join(', ')}: ${w.refs.join(', ')}`);
  if (w.unknown.length) lines.push(`Not in the model: ${w.unknown.join(', ')}`);
  lines.push('');
  for (const k of CHANGE_ORDER) {
    const list = w.deps.filter((d) => d.change === k);
    if (!list.length) continue;
    lines.push(`${DEP_CHANGE_TEXT[k]} (${list.length}):`);
    for (const c of list) lines.push(`  ${DEP_LABEL[c.dep.kind]}: ${c.dep.text} — ${c.text}`);
  }
  for (const x of w.expectations) lines.push(`Expectation ${x.after.name}: before ${x.before.verdict}, after ${x.after.verdict}${x.alternative ? ' (through an alternative path)' : ''} — ${x.after.reason}`);
  if (w.structural && w.structural.isolated.length) lines.push(`Cut off: ${w.structural.isolated.map((g) => g.join(', ')).join('; ')}`);
  if (w.reach) {
    lines.push(`Device pairs that lose reachability (${w.reach.pairs.length}); ${coverageText(w.reach.coverage)}:`);
    for (const p of w.reach.pairs) lines.push(`  ${p.from} → ${p.to}${p.partial ? ' (some equal-cost paths)' : ''}: ${p.detail}`);
  }
  lines.push('');
  for (const l of exportFooter(w.info)) lines.push(l);
  return lines.join('\n') + '\n';
}

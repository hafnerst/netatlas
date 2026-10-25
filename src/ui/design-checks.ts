/**
 * Design review (Analyze → Design review): Findings (the consistency checks'
 * catalog, invalid model input apart, filters, coverage; findings at one
 * place are related, not an established shared cause) and Requirements (the
 * saved expectations, evaluated only when asked, with an explicit editor in
 * which an isolation requirement says how it must be enforced). Text and CSV
 * exports carry the context.
 */
import { ExpectationResult, ExpectationRun, sharedStops } from '../analysis/expectations';
import { CLASS_TEXT, FindingClass, FindingGroup, PresentedFinding } from '../analysis/findings';
import { LAYER_LABEL } from '../analysis/communication';
import { Verdict, contextText, exportFooter, exportHeader, verdictMark, verdictText } from '../analysis/result';
import { STOP_LABEL } from '../analysis/trace';
import { ENFORCE_KINDS, EXPECT_KINDS, Expectation, Model, TIMING_METHODS } from '../model/types';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, limitsDetails, verdictChip } from './analysis-ui';
import { EvidenceAction, EvidenceView } from './evidence';

/** The add / edit form (a session setting until saved). */
export interface ExpectForm {
  /** the index of the expectation edited (-1: a new one) */
  index: number;
  name: string;
  expect: string;
  from: string;
  to: string;
  failure: string;
  service: string;
  vrf: string;
  /** '' (the ends'), '4' or '6' */
  family: string;
  /** blocked: '' (unreachable), 'unreachable', 'policy' or 'boundary', and the boundary device */
  enforce: string;
  boundary: string;
  /** timing: '' (not chosen yet), 'ptp', 'ntp' or 'either' */
  method: string;
  description: string;
  error: string;
}

export function newExpectForm(): ExpectForm {
  return { index: -1, name: '', expect: 'available', from: '', to: '', failure: '', service: '', vrf: '', family: '', enforce: '', boundary: '', method: '', description: '', error: '' };
}

export function formOf(e: Expectation, index: number): ExpectForm {
  return { index, name: e.name, expect: e.expect, from: e.from, to: e.to || '', failure: e.failure.join(', '), service: e.service || '', vrf: e.vrf || '', family: e.family ? String(e.family) : '', enforce: e.enforce || '', boundary: e.boundary || '', method: e.method || '', description: e.description || '', error: '' };
}

/** A finding of the review: as presented, and its index in the Problems list (for Go to). */
export interface ShownFinding {
  p: PresentedFinding;
  n: number;
}

/** A problem of the model's input (a validation error or warning): not a consistency finding. */
export interface InputIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path: string;
  n: number;
}

/** What the findings' filters keep. */
export interface FindingFilter {
  /** '' every category, 'input' invalid model input, or a finding class */
  cls: string;
  /** '' every severity */
  severity: string;
  /** words that must occur in the finding or its objects */
  text: string;
}

export function newFindingFilter(): FindingFilter {
  return { cls: '', severity: '', text: '' };
}

export interface DesignView {
  bar: ContextBarState;
  run: ExpectationRun | null;
  /** why the model can't be edited now ('' = it can) */
  locked: string;
  findings: { groups: Array<{ g: FindingGroup; n: number[] }>; singles: ShownFinding[]; counts: { [c in FindingClass]: number }; input: InputIssue[] };
  /** the checks that ran and those the model switches off */
  coverage: { total: number; off: string[] };
  filter: FindingFilter;
  /** findings related to an expectation's stop point (by its id) */
  related: Map<string, ShownFinding[]>;
  /** the selected item ('' none) */
  sel: string;
}

export interface DesignActions extends ContextBarActions {
  evaluate(): void;
  add(): void;
  edit(id: string): void;
  remove(id: string): void;
  trace(id: string): void;
  goto(n: number): void;
  show(ref: string): void;
  out(kind: 'text-copy' | 'text-save' | 'csv-copy' | 'csv-save'): void;
  filter(k: keyof FindingFilter, v: string): void;
}

const EV: { [v: string]: Verdict } = { satisfied: 'satisfied', violated: 'violated', indeterminate: 'indeterminate', unsupported: 'unsupported' };

export function expectLine(e: Expectation): string {
  const k = EXPECT_KINDS.find((x) => x.id === e.expect);
  const what = k ? k.label.toLowerCase() : e.expect;
  const to = e.to ? ` → ${e.to}` : e.expect === 'timing' ? '' : ' → its configured peer';
  const enf = e.enforce && e.enforce !== 'unreachable' ? (e.enforce === 'policy' ? ' (denied by policy)' : ` (denied at ${e.boundary || '?'})`) : e.method ? ` by ${e.method === 'either' ? 'PTP or NTP' : e.method.toUpperCase()}` : '';
  return `${e.from}${to}${e.service ? ' · ' + e.service : ''}: ${what}${enf}${e.failure.length ? ` after the failure of ${e.failure.join(', ')}` : ''}`;
}

/** The counts of a run, in words: "5 requirements: 3 satisfied, 1 violated, 1 indeterminate". */
export function runSummary(run: ExpectationRun): string {
  const n = run.results.length;
  const c: { [k: string]: number } = {};
  for (const r of run.results) c[r.verdict] = (c[r.verdict] || 0) + 1;
  const parts = ['satisfied', 'violated', 'indeterminate', 'unsupported'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`);
  return `${n} requirement${n === 1 ? '' : 's'}${parts.length ? ': ' + parts.join(', ') : ''}`;
}

// ------------------------------------------------------------ requirements

/** The question of Requirements (left): the context, Evaluate (the one primary action), Add requirement. */
export function requirementsRequest(doc: Document, model: Model, v: DesignView, act: DesignActions): HTMLElement {
  const box = el(doc, 'div', { class: 'design-body' });
  box.appendChild(contextBar(doc, v.bar, act));
  box.appendChild(el(doc, 'p', { class: 'muted small' }, [`${model.expectations.length} requirement${model.expectations.length === 1 ? '' : 's'} saved with the model. Evaluating reads the model (or a snapshot) when you ask; it never sends anything.`]));
  const tools = el(doc, 'div', { class: 'tf-actions' });
  const evalBtn = el(doc, 'button', { type: 'button', class: 'primary', id: 'dc-evaluate', title: model.expectations.length ? 'Evaluate every saved requirement now' : 'The model has no saved requirement' }, [v.run ? 'Evaluate again' : 'Evaluate']) as HTMLButtonElement;
  evalBtn.disabled = !model.expectations.length;
  evalBtn.addEventListener('click', () => act.evaluate());
  tools.appendChild(evalBtn);
  const add = el(doc, 'button', { type: 'button', id: 'dc-add', title: v.locked || 'Add a requirement to the model (an editor in the right panel)' }, ['Add requirement…']) as HTMLButtonElement;
  add.disabled = !!v.locked;
  add.addEventListener('click', () => act.add());
  tools.appendChild(add);
  box.appendChild(tools);
  if (v.locked) box.appendChild(el(doc, 'p', { class: 'small muted', id: 'dc-locked' }, [v.locked]));
  return box;
}

/** The requirements' results (bottom): the status, the shared stop points, the table (a row shows its evidence), the exports, the limits. */
export function requirementsResults(doc: Document, model: Model, v: DesignView, act: DesignActions): HTMLElement {
  const sec = el(doc, 'section', { class: 'dc-section', 'aria-labelledby': 'dc-exp-h' });
  const h = el(doc, 'h3', { id: 'dc-exp-h' }, ['Requirements']);
  sec.appendChild(h);
  const out = (k: 'text-copy' | 'text-save' | 'csv-copy' | 'csv-save', label: string): HTMLElement => {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc-out': k, title: v.run ? label : 'Evaluate first' }, [label]) as HTMLButtonElement;
    b.disabled = !v.run;
    b.addEventListener('click', () => act.out(k));
    return b;
  };
  sec.appendChild(el(doc, 'div', { class: 'an-res-tools spof-out', role: 'group', 'aria-label': 'Export the evaluation' }, [out('text-copy', 'Copy text'), out('text-save', 'Save text'), out('csv-copy', 'Copy CSV'), out('csv-save', 'Save CSV')]));
  if (!model.expectations.length) {
    sec.appendChild(el(doc, 'p', { class: 'muted small', id: 'dc-status', role: 'status' }, ['The model has no saved requirements. Add one to keep a requirement with the model: a communication that must be available or blocked (also after a failure), a dependency that must be viable, a timing-source path that must exist.']));
    return sec;
  }
  if (!v.run) sec.appendChild(el(doc, 'p', { class: 'muted small', id: 'dc-status', role: 'status' }, [`${model.expectations.length} saved requirement${model.expectations.length === 1 ? '' : 's'}, not evaluated yet.`]));
  else {
    sec.appendChild(el(doc, 'p', { class: 'small', id: 'dc-status', role: 'status' }, [runSummary(v.run) + '.']));
    // shared stop points: several fail at one place for one reason
    const shared = sharedStops(v.run.results);
    if (shared.length) {
      const ul = el(doc, 'ul', { class: 'dc-shared small' });
      for (const s of shared) ul.appendChild(el(doc, 'li', {}, [`${s.ids.length} requirements stop at `, el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + s.device }, [s.device]), ` (${STOP_LABEL[s.reason as keyof typeof STOP_LABEL] || s.reason}): ${s.ids.join(', ')}`, el(doc, 'div', { class: 'muted' }, [s.detail])]));
      sec.appendChild(el(doc, 'div', { class: 'dc-shared-box' }, [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['A shared stop: ']), 'the requirements below each stop at the same place for the same reason.']), ul]));
    }
  }
  const table = el(doc, 'table', { class: 'spof-table dc-table' });
  table.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Saved requirements and their verdicts; a row shows its evidence']));
  table.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, ['Verdict', 'Requirement', 'Reason', ''].map((t, k) => el(doc, 'th', { scope: 'col' }, k === 3 ? [el(doc, 'span', { class: 'sr-only' }, ['Actions'])] : [t])))]));
  const tb = el(doc, 'tbody');
  for (const e of model.expectations) {
    const r = v.run ? v.run.results.find((x) => x.id === e.id) : undefined;
    const key = 'exp:' + e.id;
    const on = key === v.sel;
    const acts = el(doc, 'td', { class: 'nowrap' });
    const btn = (label: string, k: string, f: () => void, dis = ''): void => {
      const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc': k, 'data-id': e.id, title: dis || label, 'aria-label': `${label}: ${e.name}` }, [label]) as HTMLButtonElement;
      if (dis) b.disabled = true;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        f();
      });
      acts.appendChild(b);
    };
    if (e.expect !== 'timing') btn('Communication', 'trace', () => act.trace(e.id));
    btn('Edit', 'edit', () => act.edit(e.id), v.locked);
    btn('Delete', 'delete', () => act.remove(e.id), v.locked);
    tb.appendChild(
      el(doc, 'tr', { 'data-exp': e.id, 'data-an-item': key, tabindex: '0', class: (r ? 'v-row v-' + r.verdict : '') + (on ? ' an-selected' : ''), ...(on ? { 'aria-current': 'true' } : {}) }, [
        el(doc, 'td', { class: 'nowrap' }, [r ? verdictChip(doc, EV[r.verdict], 'check') : el(doc, 'span', { class: 'muted' }, ['Not evaluated'])]),
        el(doc, 'th', { scope: 'row' }, [el(doc, 'span', { class: 'dc-name' }, [e.name]), el(doc, 'div', { class: 'muted small' }, [expectLine(e)])]),
        el(doc, 'td', {}, [r ? r.reason : v.run ? 'Added after this evaluation: evaluate again' : '—']),
        acts,
      ]),
    );
  }
  table.appendChild(tb);
  sec.appendChild(el(doc, 'div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Requirements' }, [table]));
  if (v.run) sec.appendChild(limitsDetails(doc, v.run.info));
  return sec;
}

/** The evidence of a requirement: its verdict and reason, its layers, the failure applied, the enforcement, the findings where it stops. */
export function requirementEvidence(doc: Document, model: Model, e: Expectation, r: ExpectationResult | undefined, related: ShownFinding[], context: string, locked: string): EvidenceView {
  const ex: Node[] = [el(doc, 'p', { class: 'small muted' }, [expectLine(e)])];
  if (e.description) ex.push(el(doc, 'p', { class: 'small' }, [e.description]));
  const evidence: Node[] = [];
  if (!r) ex.push(el(doc, 'p', { class: 'small' }, ['Not evaluated: Evaluate checks it (nothing is evaluated on its own).']));
  else {
    ex.unshift(el(doc, 'p', { class: 'small' }, [verdictChip(doc, EV[r.verdict], 'check'), ' ', r.reason]));
    for (const d of r.detail) evidence.push(el(doc, 'p', { class: 'small' }, [d]));
    if (r.check && !r.check.error) evidence.push(el(doc, 'ul', { class: 'comm-layers small' }, r.check.layers.map((l) => el(doc, 'li', { class: 'v-' + l.verdict }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(l.verdict) + ' ']), el(doc, 'strong', {}, [LAYER_LABEL[l.id] + ': ']), l.text]))));
    if (r.timing && r.timing.chain.length > 1) evidence.push(el(doc, 'p', { class: 'small' }, ['Source path: ', r.timing.chain.join(' ← ')]));
    if (r.enforcement) {
      const en = r.enforcement;
      const k = ENFORCE_KINDS.find((x) => x.id === en.kind);
      evidence.push(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Enforcement: ']), `${k ? k.label : en.kind}${en.boundary ? ' (' + en.boundary + ')' : ''}, path by path:`]));
      evidence.push(el(doc, 'ul', { class: 'dc-enf small' }, en.paths.map((p, i) => el(doc, 'li', { 'data-outcome': p.outcome }, [`Path ${i + 1}: ${p.outcome === 'denied' ? 'denied' : p.outcome === 'reached' ? 'reaches' : p.outcome === 'beyond' ? 'leaves the model' : 'stops'} at ${p.at}${p.detail ? ' — ' + p.detail : ''}${p.permittedBy.length ? ` (permitted before by ${p.permittedBy.join(', ')})` : ''}`]))));
    }
    if (related.length) {
      evidence.push(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Findings where it stops ']), '(related: they may explain it):']));
      evidence.push(el(doc, 'ul', { class: 'small' }, related.map((f) => el(doc, 'li', {}, [f.p.problem]))));
    }
  }
  const next: EvidenceAction[] = [];
  if (e.expect !== 'timing') next.push({ id: 'trace', label: 'Check in Communication', ref: e.id, why: 'Its communication, checked in Communication' });
  for (const f of related.slice(0, 3)) next.push({ id: 'finding', label: `Inspect finding: ${f.p.check}`, ref: String(f.n) });
  next.push({ id: 'edit', label: 'Edit requirement…', ref: e.id, disabled: locked });
  const refs = r ? r.refs : [];
  return { kind: 'Requirement', title: e.name, context, explanation: ex, evidence, objects: refs.filter((x) => /^(device|iface|link|relation|network):/.test(x)).slice(0, 24).map((x) => ({ ref: x, label: x.replace(/^[a-z]+:/, '') })), next };
}

/** The requirement editor's fields: outcome first; for an isolation requirement how it must be enforced, in the primary fields; the rest under Advanced options. */
export function requirementEditorBody(doc: Document, model: Model, f: ExpectForm, act: { input(k: keyof ExpectForm, v: string): void }): HTMLElement {
  const box = el(doc, 'div', { class: 'dc-form' });
  const list = el(doc, 'datalist', { id: 'dc-ends' });
  for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    list.appendChild(el(doc, 'option', { value: d.id }, ['Device']));
    for (const a of d.applications || []) list.appendChild(el(doc, 'option', { value: `${d.id}/${a.id}` }, ['Application · ' + a.name]));
  }
  const flist = el(doc, 'datalist', { id: 'dc-fail' });
  for (const fd of model.failureDomains) flist.appendChild(el(doc, 'option', { value: fd.id }, [`${fd.label} (failure domain)`]));
  for (const d of model.devices) flist.appendChild(el(doc, 'option', { value: d.id }, ['Device']));
  for (const l of model.links) flist.appendChild(el(doc, 'option', { value: l.id }, ['Cable']));
  box.appendChild(list);
  box.appendChild(flist);
  const grid = el(doc, 'div', { class: 'tf-grid' });
  const field = (g: HTMLElement, k: keyof ExpectForm, label: string, attrs: { [a: string]: string } = {}): HTMLInputElement => {
    const i = el(doc, 'input', { id: 'dc-f-' + k, type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs }) as HTMLInputElement;
    i.value = String(f[k]);
    i.addEventListener('input', () => act.input(k, i.value));
    g.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-' + k }, [label]), i]));
    return i;
  };
  field(grid, 'name', 'Name', { placeholder: 'Guests can’t reach management' });
  const sel = el(doc, 'select', { id: 'dc-f-expect' }) as HTMLSelectElement;
  for (const k of EXPECT_KINDS) sel.appendChild(el(doc, 'option', { value: k.id, title: k.help }, [k.label]));
  sel.value = f.expect;
  sel.addEventListener('change', () => act.input('expect', sel.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-expect' }, ['Outcome']), sel]));
  // a timing requirement: the method it accepts (none is chosen for it)
  if (f.expect === 'timing') {
    const ms = el(doc, 'select', { id: 'dc-f-method', 'aria-describedby': 'dc-f-method-help' }) as HTMLSelectElement;
    ms.appendChild(el(doc, 'option', { value: '' }, ['Select…']));
    for (const k of TIMING_METHODS) ms.appendChild(el(doc, 'option', { value: k.id }, [k.label]));
    ms.value = f.method;
    ms.addEventListener('change', () => act.input('method', ms.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-method' }, ['Method']), ms]));
    grid.appendChild(el(doc, 'p', { class: 'help tf-help', id: 'dc-f-method-help' }, ['Which timing source is accepted. Either: both are evaluated and reported, and one is enough; no precedence between them is assumed.']));
  }
  field(grid, 'from', 'Source', { list: 'dc-ends', placeholder: 'device, interface, address or device/application' });
  field(grid, 'to', 'Destination', { list: 'dc-ends', placeholder: f.expect === 'timing' ? 'optional: the timing source' : 'device, address, device/application or device/service' });
  box.appendChild(grid);
  // an isolation requirement: how it must be enforced, in the primary fields (a missing route is no policy)
  if (f.expect === 'blocked') {
    const cur = f.enforce || 'unreachable';
    const fs = el(doc, 'fieldset', { class: 'dc-enforce', id: 'dc-f-enforce', 'aria-describedby': 'dc-f-enforce-help' }, [el(doc, 'legend', {}, ['Isolation is met when'])]);
    const opts: Array<[string, string]> = [
      ['unreachable', 'No communication is possible (any prevention: no route, no listener, a policy)'],
      ['policy', 'A modeled policy must deny the communication'],
      ['boundary', 'A specified boundary must deny the communication'],
    ];
    for (const [id, label] of opts) {
      const r = el(doc, 'input', { type: 'radio', name: 'dc-f-enforce', id: 'dc-f-enforce-' + id, value: id }) as HTMLInputElement;
      r.checked = cur === id;
      r.addEventListener('change', () => {
        if (r.checked) act.input('enforce', id === 'unreachable' ? '' : id);
      });
      fs.appendChild(el(doc, 'div', { class: 'tf-check' }, [r, el(doc, 'label', { for: 'dc-f-enforce-' + id }, [label])]));
    }
    const k = ENFORCE_KINDS.find((x) => x.id === cur);
    fs.appendChild(el(doc, 'p', { class: 'help tf-help', id: 'dc-f-enforce-help' }, [k ? k.help : '']));
    if (cur === 'boundary') {
      const blist = el(doc, 'datalist', { id: 'dc-boundaries' });
      for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) blist.appendChild(el(doc, 'option', { value: d.id }));
      fs.appendChild(blist);
      const g3 = el(doc, 'div', { class: 'tf-grid' });
      field(g3, 'boundary', 'Boundary', { list: 'dc-boundaries', placeholder: 'the device that must deny it (a firewall, a gateway)' });
      fs.appendChild(g3);
    }
    box.appendChild(fs);
  }
  const g1 = el(doc, 'div', { class: 'tf-grid' });
  field(g1, 'failure', 'After failure of', { list: 'dc-fail', placeholder: 'optional: failure domain, devices, cables (comma-separated)' });
  box.appendChild(g1);
  const adv = el(doc, 'details', { class: 'dc-adv' }, [el(doc, 'summary', {}, ['Advanced options: service, VRF, family, note'])]);
  const g2 = el(doc, 'div', { class: 'tf-grid' });
  field(g2, 'service', 'Service', { placeholder: 'from the application, or tcp/22, udp/53, icmp' });
  field(g2, 'vrf', 'VRF', { placeholder: 'the source interface’s' });
  const fam = el(doc, 'select', { id: 'dc-f-family' }) as HTMLSelectElement;
  for (const [v, t] of [['', 'Automatic family (the ends’, or the application’s)'], ['4', 'IPv4'], ['6', 'IPv6']]) fam.appendChild(el(doc, 'option', { value: v }, [t]));
  fam.value = f.family;
  fam.addEventListener('change', () => act.input('family', fam.value));
  g2.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-family' }, ['Family']), fam]));
  field(g2, 'description', 'Note', { placeholder: 'why it is required' });
  adv.appendChild(g2);
  if (f.service || f.vrf || f.family || f.description) adv.setAttribute('open', '');
  box.appendChild(adv);
  return box;
}

// ------------------------------------------------------------ findings

const SEVERITY_TEXT: { [k: string]: string } = { error: 'Error', warning: 'Warning', info: 'Information' };

/** Does a finding pass the filters? */
function keep(f: FindingFilter, cls: string, severity: string, text: string): boolean {
  if (f.cls && f.cls !== cls) return false;
  if (f.severity && f.severity !== severity) return false;
  const words = f.text.toLowerCase().split(/\s+/).filter((w) => !!w);
  const hay = text.toLowerCase();
  return words.every((w) => hay.indexOf(w) >= 0);
}

const findingText = (p: PresentedFinding): string => `${p.problem} ${p.check} ${p.finding.check} ${p.finding.refs.join(' ')}`;

/** The question of Findings (left): the context, the filters, what was checked. */
export function findingsRequest(doc: Document, v: DesignView, act: DesignActions): HTMLElement {
  const box = el(doc, 'div', { class: 'design-body' });
  box.appendChild(contextBar(doc, v.bar, act));
  const grid = el(doc, 'div', { class: 'an-filters', role: 'group', 'aria-label': 'Filter the findings' });
  const cls = el(doc, 'select', { id: 'dc-find-cls' }) as HTMLSelectElement;
  cls.appendChild(el(doc, 'option', { value: '' }, ['Every category']));
  cls.appendChild(el(doc, 'option', { value: 'input' }, ['Invalid model input']));
  for (const k of Object.keys(CLASS_TEXT) as FindingClass[]) cls.appendChild(el(doc, 'option', { value: k }, [CLASS_TEXT[k]]));
  cls.value = v.filter.cls;
  cls.addEventListener('change', () => act.filter('cls', cls.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'dc-find-cls' }, ['Category']), cls]));
  const sev = el(doc, 'select', { id: 'dc-find-sev' }) as HTMLSelectElement;
  for (const [k, t] of [['', 'Every severity'], ['error', 'Errors'], ['warning', 'Warnings'], ['info', 'Information']]) sev.appendChild(el(doc, 'option', { value: k }, [t]));
  sev.value = v.filter.severity;
  sev.addEventListener('change', () => act.filter('severity', sev.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'dc-find-sev' }, ['Severity']), sev]));
  const txt = el(doc, 'input', { type: 'search', id: 'dc-find-filter', 'data-dc-filter': '', placeholder: 'object, check or words', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'dc-find-status' }) as HTMLInputElement;
  txt.value = v.filter.text;
  txt.addEventListener('input', () => act.filter('text', txt.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'dc-find-filter' }, ['Object']), txt]));
  box.appendChild(grid);
  box.appendChild(el(doc, 'p', { class: 'small muted', id: 'dc-coverage' }, [`${v.coverage.total - v.coverage.off.length} of ${v.coverage.total} consistency checks ran on the model as it is${v.coverage.off.length ? `; switched off by the model’s checks: section: ${v.coverage.off.join(', ')}` : ''}. The checks run with every edit; nothing else is evaluated here.`]));
  return box;
}

/** The findings' results (bottom): the counts, the invalid model input, the findings at the same place (possibly one cause), the others; each shows its evidence. */
export function findingsResults(doc: Document, v: DesignView): HTMLElement {
  const sec = el(doc, 'section', { class: 'dc-section', 'aria-labelledby': 'dc-find-h' });
  sec.appendChild(el(doc, 'h3', { id: 'dc-find-h' }, ['Findings']));
  const f = v.filter;
  const input = v.findings.input.filter((x) => keep(f, 'input', x.severity, `${x.message} ${x.path}`));
  const groups = v.findings.groups.map((g) => ({ g: g.g, items: g.g.findings.map((p, k) => ({ p, n: g.n[k] })).filter((x) => keep(f, x.p.cls, x.p.finding.severity, findingText(x.p))) })).filter((g) => g.items.length);
  const singles = v.findings.singles.filter((x) => keep(f, x.p.cls, x.p.finding.severity, findingText(x.p)));
  const total = v.findings.singles.length + v.findings.groups.reduce((s, g) => s + g.g.findings.length, 0) + v.findings.input.length;
  const shown = input.length + singles.length + groups.reduce((s, g) => s + g.items.length, 0);
  const c = v.findings.counts;
  const counts = (Object.keys(CLASS_TEXT) as FindingClass[]).filter((k) => c[k]).map((k) => `${c[k]} ${CLASS_TEXT[k].toLowerCase()}`);
  if (v.findings.input.length) counts.unshift(`${v.findings.input.length} invalid model input`);
  sec.appendChild(el(doc, 'p', { class: 'small', id: 'dc-find-status', role: 'status' }, [total ? `${shown === total ? total : `${shown} of ${total}`} finding${total === 1 ? '' : 's'}${shown === total ? '' : ' shown'}: ${counts.join(', ')}.` : `No findings from the ${v.coverage.total - v.coverage.off.length} checks that ran${v.coverage.off.length ? ` (${v.coverage.off.length} switched off by the model)` : ''}: this does not mean every possible problem was checked.`]));
  const item = (key: string, kids: Array<Node | string>, attrs: { [k: string]: string }): HTMLElement => {
    const on = key === v.sel;
    return el(doc, 'li', { ...attrs, class: (attrs.class || '') + ' an-pickrow' + (on ? ' an-selected' : ''), 'data-an-item': key, tabindex: '0' }, [...kids, ' ', el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': on ? 'true' : 'false', 'aria-controls': 'an-detail' }, ['Evidence'])]);
  };
  const row = (x: ShownFinding): HTMLElement => item('finding:' + x.n, [el(doc, 'span', { class: 'dc-class' }, [CLASS_TEXT[x.p.cls]]), el(doc, 'span', { class: 'sev' }, [' ' + x.p.finding.severity + ' ']), x.p.problem], { class: 'dc-finding sev-' + x.p.finding.severity, 'data-check': x.p.finding.check });
  if (input.length) {
    const h = el(doc, 'h4', {}, [`Invalid model input (${input.length})`]);
    sec.appendChild(h);
    sec.appendChild(el(doc, 'ul', { class: 'dc-findings', 'data-dc-list': 'input' }, input.map((x) => item('finding:' + x.n, [el(doc, 'span', { class: 'dc-class' }, ['Invalid model input']), el(doc, 'span', { class: 'sev' }, [' ' + x.severity + ' ']), x.message, el(doc, 'span', { class: 'muted small' }, [' · ' + x.path])], { class: 'dc-finding sev-' + x.severity, 'data-check': '' }))));
  }
  for (const g of groups) {
    const d = el(doc, 'details', { class: 'dc-group', open: '' }, [el(doc, 'summary', {}, [el(doc, 'strong', {}, ['Same place, possibly one cause: ']), g.g.cause.replace(/: one change there may resolve them$/, ''), el(doc, 'span', { class: 'muted small' }, [' — related findings; one change there may resolve them (not established as one cause)'])])]);
    d.appendChild(el(doc, 'ul', { class: 'dc-findings' }, g.items.map(row)));
    sec.appendChild(d);
  }
  if (singles.length) sec.appendChild(el(doc, 'ul', { class: 'dc-findings', 'data-dc-list': 'singles' }, singles.map(row)));
  if (total && !shown) sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['No finding matches the filters.']));
  return sec;
}

/** The evidence of a finding (or of an input problem): its consequence, evidence and next step. */
export function findingEvidence(doc: Document, v: DesignView, n: number, context: string): EvidenceView | null {
  const inp = v.findings.input.find((x) => x.n === n);
  if (inp) return { kind: 'Invalid model input', title: inp.message.charAt(0).toUpperCase() + inp.message.slice(1), context, explanation: [el(doc, 'p', { class: 'small' }, [`${SEVERITY_TEXT[inp.severity]} of the model’s input at ${inp.path || 'the document'}: the format’s rules are not met, so what depends on it is not analysed as intended.`])], evidence: [], objects: [], next: [{ id: 'goto-field', label: 'Go to the field', ref: String(n) }] };
  const all = v.findings.singles.concat(...v.findings.groups.map((g) => g.g.findings.map((p, k) => ({ p, n: g.n[k] }))));
  const f = all.find((x) => x.n === n);
  if (!f) return null;
  const group = v.findings.groups.find((g) => g.n.indexOf(n) >= 0);
  const ex: Node[] = [el(doc, 'p', { class: 'small' }, [el(doc, 'span', { class: 'dc-class' }, [CLASS_TEXT[f.p.cls]]), ` · ${SEVERITY_TEXT[f.p.finding.severity]}`]), el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Possible consequence: ']), f.p.consequence || 'Not stated for this check: go to the field it is about.'])];
  const evidence: Node[] = [el(doc, 'p', { class: 'small' }, [f.p.evidence[0]]), el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Next step: ']), f.p.action])];
  if (group) evidence.push(el(doc, 'p', { class: 'small muted' }, [`Related: ${group.g.findings.length - 1} other finding${group.g.findings.length === 2 ? '' : 's'} name the same place (${group.g.ref.replace(/^[a-z]+:/, '')}${group.g.field ? ' · ' + group.g.field : ''}); one change there may resolve them — not established as one cause.`]));
  return { kind: 'Consistency finding', title: f.p.problem, context, explanation: ex, evidence, objects: f.p.finding.refs.map((r) => ({ ref: r, label: r.replace(/^[a-z]+:/, '') })), next: [{ id: 'goto-field', label: 'Go to the field', ref: String(n) }] };
}

/** The evaluation as text (Copy and Save as text). */
export function designText(o: { title: string; version?: string; outdated: boolean }, model: Model, run: ExpectationRun): string {
  const lines = exportHeader({ analysis: 'Design review: requirements', title: o.title, info: run.info, version: o.version, outdated: o.outdated });
  lines.push(runSummary(run) + '.');
  lines.push('');
  for (const r of run.results) {
    const e = model.expectations.find((x) => x.id === r.id);
    lines.push(`[${verdictText(EV[r.verdict], 'check')}] ${r.name} (${r.id})`);
    if (e) lines.push(`  ${expectLine(e)}`);
    lines.push(`  ${r.reason}`);
    for (const d of r.detail) lines.push(`  ${d}`);
    if (r.check && !r.check.error) for (const l of r.check.layers) lines.push(`    ${LAYER_LABEL[l.id]}: ${l.verdict} — ${l.text}`);
  }
  lines.push('');
  for (const l of exportFooter(run.info)) lines.push(l);
  return lines.join('\n') + '\n';
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

/** The evaluation as CSV: one line per requirement, the context in every line. */
export function designCsv(model: Model, run: ExpectationRun, outdated: boolean): string {
  const head = ['id', 'name', 'expect', 'from', 'to', 'service', 'failure', 'verdict', 'reason', 'context'];
  const ctx = contextText(run.info.context) + (outdated ? ' (outdated)' : '');
  const lines = [head.join(',')];
  for (const r of run.results) {
    const e = model.expectations.find((x) => x.id === r.id);
    lines.push([r.id, r.name, r.expect, e ? e.from : '', e && e.to ? e.to : '', e && e.service ? e.service : '', e ? e.failure.join('; ') : '', r.verdict, r.reason, ctx].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

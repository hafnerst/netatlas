/**
 * The Design checks window (Analyze → Design checks…): the model's saved
 * expectations with their verdicts and actual reasons, the shared stop
 * points of the ones that fail, a compact form to add or change one, and
 * the consistency findings grouped by class and by a shared cause, each
 * with its consequence, evidence and next step behind an expansion.
 * Nothing runs the simulation; evaluating reads the model (or a snapshot).
 * The text and CSV exports carry the context. Built from elements and text
 * nodes only; the data comes from analysis/expectations.ts and
 * analysis/findings.ts.
 */
import { ExpectationResult, ExpectationRun, sharedStops } from '../analysis/expectations';
import { CLASS_TEXT, FindingClass, FindingGroup, PresentedFinding } from '../analysis/findings';
import { LAYER_LABEL } from '../analysis/communication';
import { Verdict, contextText, exportFooter, exportHeader, verdictMark, verdictText } from '../analysis/result';
import { STOP_LABEL } from '../analysis/trace';
import { ENFORCE_KINDS, EXPECT_KINDS, Expectation, Model, TIMING_METHODS } from '../model/types';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, limitsDetails, verdictChip } from './analysis-ui';

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

/** A finding of the window: as presented, and its index in the Problems list (for Go to). */
export interface ShownFinding {
  p: PresentedFinding;
  n: number;
}

export interface DesignView {
  bar: ContextBarState;
  run: ExpectationRun | null;
  /** the expectations' ids whose details are open */
  open: Set<string>;
  /** the form, when one is open */
  form: ExpectForm | null;
  /** why the model can't be edited now ('' = it can) */
  locked: string;
  findings: { groups: Array<{ g: FindingGroup; n: number[] }>; singles: ShownFinding[]; counts: { [c in FindingClass]: number } };
  /** findings related to an expectation's stop point (by its id) */
  related: Map<string, ShownFinding[]>;
}

export interface DesignActions extends ContextBarActions {
  evaluate(): void;
  add(): void;
  edit(id: string): void;
  remove(id: string): void;
  toggle(id: string): void;
  trace(id: string): void;
  formInput(k: keyof ExpectForm, v: string): void;
  formSave(): void;
  formCancel(): void;
  goto(n: number): void;
  show(ref: string): void;
  out(kind: 'text-copy' | 'text-save' | 'csv-copy' | 'csv-save'): void;
}

const EV: { [v: string]: Verdict } = { satisfied: 'satisfied', violated: 'violated', indeterminate: 'indeterminate', unsupported: 'unsupported' };

function expectLine(e: Expectation): string {
  const k = EXPECT_KINDS.find((x) => x.id === e.expect);
  const what = k ? k.label.toLowerCase() : e.expect;
  const to = e.to ? ` → ${e.to}` : e.expect === 'timing' ? '' : ' → its configured peer';
  const enf = e.enforce && e.enforce !== 'unreachable' ? (e.enforce === 'policy' ? ' (denied by policy)' : ` (denied at ${e.boundary || '?'})`) : e.method ? ` by ${e.method === 'either' ? 'PTP or NTP' : e.method.toUpperCase()}` : '';
  return `${e.from}${to}${e.service ? ' · ' + e.service : ''}: ${what}${enf}${e.failure.length ? ` after the failure of ${e.failure.join(', ')}` : ''}`;
}

/** The counts of a run, in words: "5 expectations: 3 satisfied, 1 violated, 1 indeterminate". */
export function runSummary(run: ExpectationRun): string {
  const n = run.results.length;
  const c: { [k: string]: number } = {};
  for (const r of run.results) c[r.verdict] = (c[r.verdict] || 0) + 1;
  const parts = ['satisfied', 'violated', 'indeterminate', 'unsupported'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`);
  return `${n} expectation${n === 1 ? '' : 's'}${parts.length ? ': ' + parts.join(', ') : ''}`;
}

export function designBody(doc: Document, model: Model, v: DesignView, act: DesignActions): HTMLElement {
  const box = el(doc, 'div', { class: 'design-body' });
  box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Saved design requirements, checked against the model, and the consistency findings with what follows from them. Evaluating reads the model; it never sends anything.']));
  box.appendChild(contextBar(doc, v.bar, act));
  // ---- the expectations
  const sec = el(doc, 'section', { class: 'dc-section', 'aria-labelledby': 'dc-exp-h' });
  sec.appendChild(el(doc, 'h3', { id: 'dc-exp-h' }, ['Saved expectations']));
  const tools = el(doc, 'div', { class: 'tf-actions' });
  const evalBtn = el(doc, 'button', { type: 'button', class: 'primary', id: 'dc-evaluate' }, [v.run ? 'Evaluate again' : 'Evaluate']);
  evalBtn.addEventListener('click', () => act.evaluate());
  tools.appendChild(evalBtn);
  const add = el(doc, 'button', { type: 'button', id: 'dc-add', title: v.locked || 'Add a design requirement to the model' }, ['Add expectation']) as HTMLButtonElement;
  add.disabled = !!v.locked;
  add.addEventListener('click', () => act.add());
  tools.appendChild(add);
  const out = (k: 'text-copy' | 'text-save' | 'csv-copy' | 'csv-save', label: string): HTMLElement => {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc-out': k }, [label]) as HTMLButtonElement;
    b.disabled = !v.run;
    b.addEventListener('click', () => act.out(k));
    return b;
  };
  tools.appendChild(el(doc, 'span', { class: 'spof-out', role: 'group', 'aria-label': 'Export the evaluation' }, [out('text-copy', 'Copy text'), out('text-save', 'Save text'), out('csv-copy', 'Copy CSV'), out('csv-save', 'Save CSV')]));
  sec.appendChild(tools);
  if (v.form) sec.appendChild(formBox(doc, model, v.form, act));
  if (!model.expectations.length) {
    sec.appendChild(el(doc, 'p', { class: 'muted small', id: 'dc-status', role: 'status' }, ['The model has no saved expectations. Add one to keep a requirement with the model: a communication that must be available or blocked (also after a failure), a dependency that must be viable, a timing-source path that must exist.']));
  } else if (!v.run) {
    sec.appendChild(el(doc, 'p', { class: 'muted small', id: 'dc-status', role: 'status' }, [`${model.expectations.length} saved expectation${model.expectations.length === 1 ? '' : 's'}, not evaluated yet.`]));
  } else {
    sec.appendChild(el(doc, 'p', { class: 'small', id: 'dc-status', role: 'status' }, [runSummary(v.run) + '.']));
    // shared stop points: several fail at one place for one reason
    const shared = sharedStops(v.run.results);
    if (shared.length) {
      const ul = el(doc, 'ul', { class: 'dc-shared small' });
      for (const s of shared) ul.appendChild(el(doc, 'li', {}, [`${s.ids.length} expectations stop at `, el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + s.device }, [s.device]), ` (${STOP_LABEL[s.reason as keyof typeof STOP_LABEL] || s.reason}): ${s.ids.join(', ')}`, el(doc, 'div', { class: 'muted' }, [s.detail])]));
      sec.appendChild(el(doc, 'div', { class: 'dc-shared-box' }, [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['A shared cause: ']), 'the expectations below each stop at the same place for the same reason.']), ul]));
    }
  }
  if (model.expectations.length) {
    const table = el(doc, 'table', { class: 'spof-table dc-table' });
    table.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Saved expectations and their verdicts']));
    table.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, ['Verdict', 'Expectation', 'Reason', ''].map((h, k) => el(doc, 'th', { scope: 'col' }, k === 3 ? [el(doc, 'span', { class: 'sr-only' }, ['Actions'])] : [h])))]));
    const tb = el(doc, 'tbody');
    model.expectations.forEach((e) => {
      const r = v.run ? v.run.results.find((x) => x.id === e.id) : undefined;
      const open = v.open.has(e.id);
      const did = 'dc-d-' + e.id;
      const acts = el(doc, 'td', { class: 'nowrap' });
      const btn = (label: string, k: string, f: () => void, dis = ''): void => {
        const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc': k, 'data-id': e.id, title: dis || label, 'aria-label': `${label}: ${e.name}` }, [label]) as HTMLButtonElement;
        if (dis) b.disabled = true;
        b.addEventListener('click', f);
        acts.appendChild(b);
      };
      if (r) {
        const t = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc': 'toggle', 'data-id': e.id, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': did }, [open ? 'Hide details' : 'Details']);
        t.addEventListener('click', () => act.toggle(e.id));
        acts.appendChild(t);
      }
      if (e.expect !== 'timing') btn('Trace', 'trace', () => act.trace(e.id));
      btn('Edit', 'edit', () => act.edit(e.id), v.locked);
      btn('Delete', 'delete', () => act.remove(e.id), v.locked);
      tb.appendChild(
        el(doc, 'tr', { 'data-exp': e.id, class: r ? 'v-row v-' + r.verdict : '' }, [
          el(doc, 'td', { class: 'nowrap' }, [r ? verdictChip(doc, EV[r.verdict], 'check') : el(doc, 'span', { class: 'muted' }, ['not evaluated'])]),
          el(doc, 'th', { scope: 'row' }, [el(doc, 'span', { class: 'dc-name' }, [e.name]), el(doc, 'div', { class: 'muted small' }, [expectLine(e)])]),
          el(doc, 'td', {}, [r ? r.reason : '—']),
          acts,
        ]),
      );
      if (r) {
        const d = el(doc, 'tr', { class: 'dc-detail', id: did }, [el(doc, 'td', { colspan: '4' }, [detailBox(doc, r, v.related.get(e.id) || [], act)])]);
        d.hidden = !open;
        tb.appendChild(d);
      }
    });
    table.appendChild(tb);
    sec.appendChild(el(doc, 'div', { class: 'table-wrap' }, [table]));
  }
  if (v.run) sec.appendChild(limitsDetails(doc, v.run.info));
  box.appendChild(sec);
  // ---- the consistency findings
  box.appendChild(findingsSection(doc, v, act));
  return box;
}

/** An expectation's details: its layers, its timing chain, the failure applied, the findings related to where it stops. */
function detailBox(doc: Document, r: ExpectationResult, related: ShownFinding[], act: DesignActions): HTMLElement {
  const box = el(doc, 'div', { class: 'dc-detail-box small' });
  for (const d of r.detail) box.appendChild(el(doc, 'p', {}, [d]));
  if (r.check && !r.check.error) {
    const ul = el(doc, 'ul', { class: 'comm-layers' });
    for (const l of r.check.layers) ul.appendChild(el(doc, 'li', { class: 'v-' + l.verdict }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(l.verdict) + ' ']), el(doc, 'strong', {}, [LAYER_LABEL[l.id] + ': ']), l.text]));
    box.appendChild(ul);
  }
  if (r.timing && r.timing.chain.length > 1) box.appendChild(el(doc, 'p', {}, ['Source path: ', r.timing.chain.join(' ← ')]));
  if (r.enforcement) {
    const en = r.enforcement;
    const k = ENFORCE_KINDS.find((x) => x.id === en.kind);
    box.appendChild(el(doc, 'p', {}, [el(doc, 'strong', {}, ['Enforcement: ']), `${k ? k.label : en.kind}${en.boundary ? ' (' + en.boundary + ')' : ''}, path by path:`]));
    const ul = el(doc, 'ul', { class: 'dc-enf' });
    en.paths.forEach((p, i) => ul.appendChild(el(doc, 'li', { 'data-outcome': p.outcome }, [`Path ${i + 1}: ${p.outcome === 'denied' ? 'denied' : p.outcome === 'reached' ? 'reaches' : p.outcome === 'beyond' ? 'leaves the model' : 'stops'} at ${p.at}${p.detail ? ' — ' + p.detail : ''}${p.permittedBy.length ? ` (permitted before by ${p.permittedBy.join(', ')})` : ''}`])));
    box.appendChild(ul);
  }
  if (r.refs.length) {
    const p = el(doc, 'p', {}, ['In the diagram: ']);
    r.refs.slice(0, 12).forEach((x, i) => {
      const b = el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': x }, [x.replace(/^[a-z]+:/, '')]);
      b.addEventListener('click', () => act.show(x));
      p.appendChild(el(doc, 'span', {}, [i ? ', ' : '', b]));
    });
    box.appendChild(p);
  }
  if (related.length) {
    box.appendChild(el(doc, 'p', {}, [el(doc, 'strong', {}, ['Findings where it stops ']), '(they may explain it):']));
    const ul = el(doc, 'ul', {});
    for (const f of related) {
      const go = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc-goto': String(f.n) }, ['Go to']);
      go.addEventListener('click', () => act.goto(f.n));
      ul.appendChild(el(doc, 'li', {}, [f.p.problem, ' ', go]));
    }
    box.appendChild(ul);
  }
  return box;
}

/** The add / edit form: the basic fields, the advanced ones collapsed. */
function formBox(doc: Document, model: Model, f: ExpectForm, act: DesignActions): HTMLElement {
  const form = el(doc, 'form', { class: 'trace-form dc-form', 'aria-label': f.index < 0 ? 'Add expectation' : 'Edit expectation' }) as HTMLFormElement;
  const list = el(doc, 'datalist', { id: 'dc-ends' });
  for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    list.appendChild(el(doc, 'option', { value: d.id }));
    for (const a of d.applications || []) list.appendChild(el(doc, 'option', { value: `${d.id}/${a.id}` }, [a.name]));
  }
  const flist = el(doc, 'datalist', { id: 'dc-fail' });
  for (const fd of model.failureDomains) flist.appendChild(el(doc, 'option', { value: fd.id }, [`${fd.label} (failure domain)`]));
  for (const d of model.devices) flist.appendChild(el(doc, 'option', { value: d.id }));
  for (const l of model.links) flist.appendChild(el(doc, 'option', { value: l.id }, ['cable']));
  form.appendChild(list);
  form.appendChild(flist);
  const grid = el(doc, 'div', { class: 'tf-grid' });
  const field = (k: keyof ExpectForm, label: string, attrs: { [a: string]: string } = {}): void => {
    const i = el(doc, 'input', { id: 'dc-f-' + k, type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs }) as HTMLInputElement;
    i.value = String(f[k]);
    i.addEventListener('input', () => act.formInput(k, i.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-' + k }, [label]), i]));
  };
  field('name', 'Name', { placeholder: 'Guests can’t reach management' });
  const sel = el(doc, 'select', { id: 'dc-f-expect' }) as HTMLSelectElement;
  for (const k of EXPECT_KINDS) sel.appendChild(el(doc, 'option', { value: k.id, title: k.help }, [k.label]));
  sel.value = f.expect;
  sel.addEventListener('change', () => act.formInput('expect', sel.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-expect' }, ['Outcome']), sel]));
  // a timing expectation: the method it accepts (none is chosen for it)
  if (f.expect === 'timing') {
    const ms = el(doc, 'select', { id: 'dc-f-method', 'aria-describedby': 'dc-f-method-help' }) as HTMLSelectElement;
    ms.appendChild(el(doc, 'option', { value: '' }, ['Select…']));
    for (const k of TIMING_METHODS) ms.appendChild(el(doc, 'option', { value: k.id }, [k.label]));
    ms.value = f.method;
    ms.addEventListener('change', () => act.formInput('method', ms.value));
    grid.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-method' }, ['Method']), ms]));
    grid.appendChild(el(doc, 'p', { class: 'help tf-help', id: 'dc-f-method-help' }, ['Which timing source is accepted. Either: both are evaluated and reported, and one is enough; no precedence between them is assumed.']));
  }
  field('from', 'Source', { list: 'dc-ends', placeholder: 'device, interface, address or device/application' });
  field('to', 'Destination', { list: 'dc-ends', placeholder: f.expect === 'timing' ? 'optional: the timing source' : 'device, address, device/application or device/service' });
  field('failure', 'After failure of', { list: 'dc-fail', placeholder: 'optional: failure domain, devices, cables (comma-separated)' });
  form.appendChild(grid);
  const adv = el(doc, 'details', { class: 'dc-adv' }, [el(doc, 'summary', {}, [f.expect === 'blocked' ? 'Advanced: service, VRF, family, enforcement, description' : 'Advanced: service, VRF, family, description'])]);
  const g2 = el(doc, 'div', { class: 'tf-grid' });
  const field2 = (k: keyof ExpectForm, label: string, ph: string): void => {
    const i = el(doc, 'input', { id: 'dc-f-' + k, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: ph }) as HTMLInputElement;
    i.value = String(f[k]);
    i.addEventListener('input', () => act.formInput(k, i.value));
    g2.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-' + k }, [label]), i]));
  };
  field2('service', 'Service', 'from the application, or tcp/22, udp/53, icmp');
  field2('vrf', 'VRF', 'the source interface’s');
  const fam = el(doc, 'select', { id: 'dc-f-family' }) as HTMLSelectElement;
  for (const [v, t] of [['', 'The ends’ (or the application’s)'], ['4', 'IPv4'], ['6', 'IPv6']]) fam.appendChild(el(doc, 'option', { value: v }, [t]));
  fam.value = f.family;
  fam.addEventListener('change', () => act.formInput('family', fam.value));
  g2.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-family' }, ['Family']), fam]));
  // how a block must be enforced: blocked only (the basic form stays as it is)
  if (f.expect === 'blocked') {
    const enf = el(doc, 'select', { id: 'dc-f-enforce', 'aria-describedby': 'dc-f-enforce-help' }) as HTMLSelectElement;
    enf.appendChild(el(doc, 'option', { value: '' }, ['Unreachable (any prevention; the default)']));
    for (const k of ENFORCE_KINDS.filter((x) => x.id !== 'unreachable')) enf.appendChild(el(doc, 'option', { value: k.id, title: k.help }, [k.label]));
    enf.value = f.enforce === 'unreachable' ? '' : f.enforce;
    enf.addEventListener('change', () => act.formInput('enforce', enf.value));
    g2.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'dc-f-enforce' }, ['Enforcement']), enf]));
    const k = ENFORCE_KINDS.find((x) => x.id === (f.enforce || 'unreachable'));
    g2.appendChild(el(doc, 'p', { class: 'help tf-help', id: 'dc-f-enforce-help' }, [k ? k.help : '']));
    if (f.enforce === 'boundary') {
      const blist = el(doc, 'datalist', { id: 'dc-boundaries' });
      for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) blist.appendChild(el(doc, 'option', { value: d.id }));
      g2.appendChild(blist);
      field2('boundary', 'Boundary', 'the device that must deny it (a firewall, a gateway)');
      (g2.lastElementChild as HTMLElement).querySelector('input')!.setAttribute('list', 'dc-boundaries');
    }
  }
  field2('description', 'Note', 'why it is required');
  adv.appendChild(g2);
  if (f.service || f.vrf || f.family || f.enforce || f.description) adv.setAttribute('open', '');
  form.appendChild(adv);
  if (f.error) form.appendChild(el(doc, 'p', { class: 'trace-error', id: 'dc-f-error', role: 'alert' }, [f.error]));
  const save = el(doc, 'button', { type: 'submit', class: 'primary', id: 'dc-f-save' }, [f.index < 0 ? 'Add' : 'Save']);
  const cancel = el(doc, 'button', { type: 'button', id: 'dc-f-cancel' }, ['Cancel']);
  cancel.addEventListener('click', () => act.formCancel());
  form.appendChild(el(doc, 'div', { class: 'tf-actions' }, [save, cancel]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act.formSave();
  });
  return form;
}

/** The findings: counts by class; the groups (a shared cause) with their findings; the others. */
function findingsSection(doc: Document, v: DesignView, act: DesignActions): HTMLElement {
  const sec = el(doc, 'section', { class: 'dc-section', 'aria-labelledby': 'dc-find-h' });
  sec.appendChild(el(doc, 'h3', { id: 'dc-find-h' }, ['Consistency findings']));
  const total = v.findings.singles.length + v.findings.groups.reduce((s, g) => s + g.g.findings.length, 0);
  if (!total) {
    sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['No consistency check finds anything in the model (the checks the model switches off excepted).']));
    return sec;
  }
  const c = v.findings.counts;
  sec.appendChild(el(doc, 'p', { class: 'small' }, [`${total} finding${total === 1 ? '' : 's'}: ` + (Object.keys(CLASS_TEXT) as FindingClass[]).filter((k) => c[k]).map((k) => `${c[k]} ${CLASS_TEXT[k].toLowerCase()}`).join(', ') + '.']));
  for (const { g, n } of v.findings.groups) {
    const d = el(doc, 'details', { class: 'dc-group' }, [el(doc, 'summary', {}, [el(doc, 'strong', {}, ['Shared cause: ']), g.cause])]);
    const ul = el(doc, 'ul', { class: 'dc-findings' });
    g.findings.forEach((p, k) => ul.appendChild(findingItem(doc, { p, n: n[k] }, act)));
    d.appendChild(ul);
    sec.appendChild(d);
  }
  const ul = el(doc, 'ul', { class: 'dc-findings' });
  for (const f of v.findings.singles) ul.appendChild(findingItem(doc, f, act));
  sec.appendChild(ul);
  return sec;
}

function findingItem(doc: Document, f: ShownFinding, act: DesignActions): HTMLElement {
  const li = el(doc, 'li', { class: 'dc-finding sev-' + f.p.finding.severity, 'data-check': f.p.finding.check });
  li.appendChild(el(doc, 'span', { class: 'dc-class' }, [CLASS_TEXT[f.p.cls]]));
  li.appendChild(el(doc, 'span', { class: 'sev' }, [' ' + f.p.finding.severity + ' ']));
  li.appendChild(doc.createTextNode(f.p.problem));
  const d = el(doc, 'details', { class: 'layer-ev' }, [el(doc, 'summary', {}, ['Consequence, evidence, next step'])]);
  if (f.p.consequence) d.appendChild(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Consequence: ']), f.p.consequence]));
  const ev = el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Evidence: ']), f.p.evidence[0] + ' · ']);
  f.p.finding.refs.forEach((r, i) => {
    const b = el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': r }, [r.replace(/^[a-z]+:/, '')]);
    b.addEventListener('click', () => act.show(r));
    ev.appendChild(el(doc, 'span', {}, [i ? ', ' : '', b]));
  });
  d.appendChild(ev);
  const go = el(doc, 'button', { type: 'button', class: 'mini', 'data-dc-goto': String(f.n) }, ['Go to the field']);
  go.addEventListener('click', () => act.goto(f.n));
  d.appendChild(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, ['Next step: ']), f.p.action, ' ', go]));
  li.appendChild(d);
  return li;
}

/** The evaluation as text (Copy and Save as text). */
export function designText(o: { title: string; version?: string; outdated: boolean }, model: Model, run: ExpectationRun): string {
  const lines = exportHeader({ analysis: 'Design checks: saved expectations', title: o.title, info: run.info, version: o.version, outdated: o.outdated });
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

/** The evaluation as CSV: one line per expectation, the context in every line. */
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

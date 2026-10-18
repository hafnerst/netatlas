/**
 * Simulate → Experiments…: the model's saved experiments as a compact list,
 * each with an explicit Run (from a clean start, on scenario time; never
 * started by saving or editing), its progress and Stop, its last result
 * (each observation met or not, with what was found; the steps and the
 * events behind expansions), the comparison with the previous run, and a
 * short editor: the actions in order (time, what, target; the rest behind
 * More) and the observations (time, what, target, expected). Built from
 * elements and text nodes; the run itself is analysis/sim/experiment.ts.
 */
import { EXP_ACTIONS, EXP_OBSERVE, Experiment } from '../model/experiments';
import { Model } from '../model/types';
import { ExpRunResult, ObsOutcome, RunCompare } from '../analysis/sim/experiment';
import { exportFooter, resultInfo } from '../analysis/result';
import { el } from './dom';

export interface ExperimentsView {
  /** the experiments whose editor is open */
  open: Set<string>;
  /** the runs of each experiment, the newest last */
  runs: Map<string, ExpRunResult[]>;
  /** the one running now and how far it is */
  running: { id: string; reached: number; duration: number } | null;
  compare: Map<string, RunCompare>;
  /** the model each experiment's last run was on is not the one now */
  outdated: (r: ExpRunResult) => boolean;
  /** why the model can't be edited now ('' it can) */
  locked: string;
  /** the experiments' paths in the file (for the editor), by id */
  index: Map<string, number>;
}

export interface ExperimentsActions {
  add(): void;
  run(id: string): void;
  stop(): void;
  compare(id: string): void;
  toggle(id: string): void;
  remove(id: string): void;
  /** a field of the file changed: its path (JSON), its kind, the value */
  set(path: string, kind: 'text' | 'int' | 'duration', value: string): void;
  addStep(index: number, list: 'actions' | 'observe', kind: string): void;
  delStep(path: string): void;
  upStep(path: string): void;
  copy(id: string): void;
}

const MARK: { [k in ObsOutcome]: string } = { met: '✓', 'not-met': '✕', indeterminate: '?', unsupported: '–' };
const OUT_TEXT: { [k in ObsOutcome]: string } = { met: 'Met', 'not-met': 'Not met', indeterminate: 'Indeterminate', unsupported: 'Unsupported' };

const secs = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

export function experimentsBody(doc: Document, model: Model, v: ExperimentsView, act: ExperimentsActions): HTMLElement {
  const box = el(doc, 'div', { class: 'exp-body' });
  box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Saved experiments run from a clean start on scenario time (the simulated clock), so a run can be repeated. Saving or editing one never starts it; a run is apart from a simulation on screen.']));
  const add = el(doc, 'button', { type: 'button', id: 'ex-add', title: v.locked || 'Add an experiment to the model' }, ['Add experiment']) as HTMLButtonElement;
  add.disabled = !!v.locked;
  add.addEventListener('click', () => act.add());
  box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [add]));
  if (!model.experiments.length) {
    box.appendChild(el(doc, 'p', { class: 'muted small', id: 'ex-status', role: 'status' }, ['The model has no saved experiments. Add one, or use a traced communication (Trace path → Use in experiment…).']));
    return box;
  }
  for (const e of model.experiments) box.appendChild(card(doc, e, v, act));
  return box;
}

function card(doc: Document, e: Experiment, v: ExperimentsView, act: ExperimentsActions): HTMLElement {
  const runs = v.runs.get(e.id) || [];
  const last = runs[runs.length - 1];
  const running = v.running && v.running.id === e.id ? v.running : null;
  const c = el(doc, 'section', { class: 'ex-card', 'data-exp': e.id, 'aria-label': e.name });
  const btn = (label: string, k: string, f: () => void, dis = '', extra: { [a: string]: string } = {}): HTMLButtonElement => {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-ex': k, 'data-id': e.id, title: dis || label, 'aria-label': `${label}: ${e.name}`, ...extra }, [label]) as HTMLButtonElement;
    if (dis) b.disabled = true;
    b.addEventListener('click', f);
    return b;
  };
  const tools = el(doc, 'span', { class: 'ex-tools' }, [
    running ? btn('Stop', 'stop', () => act.stop(), '', { class: 'mini danger' }) : btn('Run', 'run', () => act.run(e.id), v.running ? 'Another experiment is running: stop it first' : '', { class: 'mini primary' }),
    btn('Compare with the previous run', 'compare', () => act.compare(e.id), runs.length < 2 ? 'Run it twice to compare' : ''),
    btn(v.open.has(e.id) ? 'Close editor' : 'Edit', 'toggle', () => act.toggle(e.id), '', { 'aria-expanded': v.open.has(e.id) ? 'true' : 'false' }),
    btn('Copy result', 'copy', () => act.copy(e.id), last ? '' : 'Run it first'),
    btn('Delete', 'delete', () => act.remove(e.id), v.locked),
  ]);
  c.appendChild(el(doc, 'div', { class: 'ex-head' }, [el(doc, 'strong', {}, [e.name]), el(doc, 'span', { class: 'muted small' }, [` · ${secs(e.duration)} · ${e.actions.length} action${e.actions.length === 1 ? '' : 's'} · ${e.observations.length} observation${e.observations.length === 1 ? '' : 's'}`]), tools]));
  if (running) c.appendChild(el(doc, 'p', { class: 'small', id: 'ex-progress', role: 'status' }, [`Running on scenario time: t = ${(running.reached / 1000).toFixed(0)} s of ${(running.duration / 1000).toFixed(0)} s`]));
  if (last && !running) {
    const res = el(doc, 'div', { class: 'ex-result', 'data-state': last.state });
    res.appendChild(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [last.state === 'stopped' ? 'Stopped: ' : 'Last run: ']), last.summary, v.outdated(last) ? el(doc, 'span', { class: 'an-outdated' }, [' · outdated: the model changed since']) : '']));
    const ul = el(doc, 'ul', { class: 'ex-obs small' });
    for (const r of last.observations) ul.appendChild(el(doc, 'li', { class: 'v-' + (r.outcome === 'met' ? 'satisfied' : r.outcome === 'not-met' ? 'violated' : r.outcome), 'data-outcome': r.outcome }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [MARK[r.outcome] + ' ']), el(doc, 'strong', {}, [`${OUT_TEXT[r.outcome]}: `]), `${r.obs.of} ${r.obs.target}${r.obs.group ? ' ' + r.obs.group : ''}${r.obs.to ? ' → ' + r.obs.to : ''} expects ${r.obs.expect} at t = ${(r.at / 1000).toFixed(1)} s — ${r.actual}`]));
    res.appendChild(ul);
    const steps = el(doc, 'details', { class: 'layer-ev' }, [el(doc, 'summary', {}, [`Steps (${last.actions.length})`])]);
    const sl = el(doc, 'ul', { class: 'small' });
    for (const s of last.actions) sl.appendChild(el(doc, 'li', { class: s.ok ? '' : 'muted' }, [`t = ${(s.at / 1000).toFixed(1)} s ${s.action.do} ${s.action.target}: ${s.ok ? '' : 'not done — '}${s.text}`]));
    steps.appendChild(sl);
    res.appendChild(steps);
    const evs = el(doc, 'details', { class: 'layer-ev' }, [el(doc, 'summary', {}, [`Events (${last.events.length}, state changes and drops)`])]);
    const el2 = el(doc, 'ul', { class: 'small' });
    for (const x of last.events.slice(-60)) el2.appendChild(el(doc, 'li', {}, [`t = ${(x.t / 1000).toFixed(2)} s ${x.device}: ${x.text}`]));
    evs.appendChild(el2);
    res.appendChild(evs);
    c.appendChild(res);
  }
  const cmp = v.compare.get(e.id);
  if (cmp) c.appendChild(el(doc, 'div', { class: 'ex-compare small', id: 'ex-compare-' + e.id }, [el(doc, 'strong', {}, ['Compared with the previous run']), el(doc, 'ul', {}, cmp.lines.map((l) => el(doc, 'li', {}, [l])).concat(cmp.incomplete.length ? [el(doc, 'li', { class: 'muted' }, [`Not decided: ${cmp.incomplete.join('; ')}`])] : []))]));
  if (v.open.has(e.id)) c.appendChild(editor(doc, e, v, act));
  return c;
}

/** The short editor: name and duration; the actions and observations in order, the rest behind More. */
function editor(doc: Document, e: Experiment, v: ExperimentsView, act: ExperimentsActions): HTMLElement {
  const k = v.index.get(e.id) as number;
  const base = ['experiments', k];
  const P = (...p: Array<string | number>): string => JSON.stringify(base.concat(p));
  const inp = (path: string, kind: 'text' | 'int' | 'duration', value: string, label: string, ph = ''): HTMLInputElement => {
    const i = el(doc, 'input', { type: 'text', 'data-ex-p': path, 'aria-label': label, placeholder: ph, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    i.value = value;
    if (v.locked) i.disabled = true;
    i.addEventListener('change', () => act.set(path, kind, i.value.trim()));
    return i;
  };
  const sel = (path: string, values: string[], cur: string, label: string): HTMLSelectElement => {
    const s = el(doc, 'select', { 'data-ex-p': path, 'aria-label': label }) as HTMLSelectElement;
    for (const x of values) s.appendChild(el(doc, 'option', { value: x }, [x]));
    s.value = cur;
    if (v.locked) s.disabled = true;
    s.addEventListener('change', () => act.set(path, 'text', s.value));
    return s;
  };
  const ed = el(doc, 'div', { class: 'ex-editor' });
  ed.appendChild(el(doc, 'div', { class: 'tf-grid' }, [el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', {}, ['Name ', inp(P('name'), 'text', e.name, 'Name')])]), el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', {}, ['Duration ', inp(P('duration'), 'duration', secs(e.duration), 'Duration', '120s')])])]));
  const stepTools = (path: string, n: number, label: string): HTMLElement =>
    el(doc, 'td', { class: 'nowrap' }, [
      ((): HTMLElement => {
        const b = el(doc, 'button', { type: 'button', class: 'mini', 'aria-label': `Move ${label} up`, title: 'Move up' }, ['↑']) as HTMLButtonElement;
        b.disabled = n === 0 || !!v.locked;
        b.addEventListener('click', () => act.upStep(path));
        return b;
      })(),
      ((): HTMLElement => {
        const b = el(doc, 'button', { type: 'button', class: 'mini danger', 'aria-label': `Delete ${label}`, title: 'Delete' }, ['×']) as HTMLButtonElement;
        b.disabled = !!v.locked;
        b.addEventListener('click', () => act.delStep(path));
        return b;
      })(),
    ]);
  // the actions
  const at = el(doc, 'table', { class: 'rule-table ex-steps', 'data-ex-list': 'actions' });
  at.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, ['At', 'Action', 'Target', 'To / group', ''].map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
  const atb = el(doc, 'tbody');
  e.actions.forEach((a, n) => {
    const label = `action ${n + 1}`;
    const more = el(doc, 'details', { class: 'rule-more' }, [el(doc, 'summary', {}, ['More'])]);
    more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['id ', inp(P('actions', n, 'id'), 'text', a.id || '', `Id of ${label}`)]));
    if (a.do === 'send') {
      more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['service ', inp(P('actions', n, 'service'), 'text', a.service || '', `Service of ${label}`, 'tcp/443')]));
      more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['count ', inp(P('actions', n, 'count'), 'int', a.count !== undefined ? String(a.count) : '', `Messages of ${label}`, '1')]));
      more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['interval ', inp(P('actions', n, 'interval'), 'duration', a.interval !== undefined ? secs(a.interval) : '', `Interval of ${label}`, '1s')]));
    }
    const second = a.do === 'send' ? inp(P('actions', n, 'to'), 'text', a.to || '', `Destination of ${label}`, 'device, address, app') : a.do === 'join' || a.do === 'leave' ? inp(P('actions', n, 'group'), 'text', a.group || '', `Group of ${label}`, '239.1.1.1') : el(doc, 'span', { class: 'muted' }, ['—']);
    atb.appendChild(el(doc, 'tr', {}, [el(doc, 'td', {}, [inp(P('actions', n, 'at'), 'duration', secs(a.at), `Time of ${label}`)]), el(doc, 'td', {}, [sel(P('actions', n, 'do'), EXP_ACTIONS.map((x) => x.id), a.do, `What ${label} does`)]), el(doc, 'td', {}, [inp(P('actions', n, 'target'), 'text', a.target, `Target of ${label}`), more]), el(doc, 'td', {}, [second]), stepTools(P('actions', n), n, label)]));
  });
  at.appendChild(atb);
  ed.appendChild(el(doc, 'div', { class: 'rule-ed' }, [el(doc, 'div', { class: 'rule-title' }, ['Actions (in time order; at one time, in this order)']), e.actions.length ? at : el(doc, 'p', { class: 'muted small' }, ['No action yet.']), addStep(doc, 'actions', EXP_ACTIONS.map((x) => [x.id, x.label] as [string, string]), k, v, act)]));
  // the observations
  const ot = el(doc, 'table', { class: 'rule-table ex-steps', 'data-ex-list': 'observe' });
  ot.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, ['At', 'Observe', 'Target', 'Expect', ''].map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
  const otb = el(doc, 'tbody');
  e.observations.forEach((o, n) => {
    const label = `observation ${n + 1}`;
    const def = EXP_OBSERVE.find((x) => x.id === o.of);
    const more = el(doc, 'details', { class: 'rule-more' }, [el(doc, 'summary', {}, ['More'])]);
    if (o.of === 'reach') {
      more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['to ', inp(P('observe', n, 'to'), 'text', o.to || '', `Destination of ${label}`)]));
      more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['service ', inp(P('observe', n, 'service'), 'text', o.service || '', `Service of ${label}`, 'tcp/443')]));
      more.setAttribute('open', '');
    }
    if (o.of === 'member') {
      more.appendChild(el(doc, 'label', { class: 'rule-mini' }, ['group ', inp(P('observe', n, 'group'), 'text', o.group || '', `Group of ${label}`, '239.1.1.1')]));
      more.setAttribute('open', '');
    }
    otb.appendChild(el(doc, 'tr', {}, [el(doc, 'td', {}, [inp(P('observe', n, 'at'), 'duration', o.at !== undefined ? secs(o.at) : '', `Time of ${label}`, 'the end')]), el(doc, 'td', {}, [sel(P('observe', n, 'of'), EXP_OBSERVE.map((x) => x.id), o.of, `What ${label} reads`)]), el(doc, 'td', {}, [inp(P('observe', n, 'target'), 'text', o.target, `Target of ${label}`), more]), el(doc, 'td', {}, [sel(P('observe', n, 'expect'), def ? def.expect : [o.expect], o.expect, `Expected outcome of ${label}`)]), stepTools(P('observe', n), n, label)]));
  });
  ot.appendChild(otb);
  ed.appendChild(el(doc, 'div', { class: 'rule-ed' }, [el(doc, 'div', { class: 'rule-title' }, ['Observations (none at a time: at the end)']), e.observations.length ? ot : el(doc, 'p', { class: 'muted small' }, ['No observation yet.']), addStep(doc, 'observe', EXP_OBSERVE.map((x) => [x.id, x.label] as [string, string]), k, v, act)]));
  return ed;
}

function addStep(doc: Document, list: 'actions' | 'observe', kinds: Array<[string, string]>, index: number, v: ExperimentsView, act: ExperimentsActions): HTMLElement {
  const s = el(doc, 'select', { 'aria-label': list === 'actions' ? 'Add an action' : 'Add an observation', 'data-ex-add': list }) as HTMLSelectElement;
  s.appendChild(el(doc, 'option', { value: '' }, [list === 'actions' ? '+ action…' : '+ observation…']));
  for (const [id, label] of kinds) s.appendChild(el(doc, 'option', { value: id }, [label]));
  if (v.locked) s.disabled = true;
  s.addEventListener('change', () => {
    if (s.value) act.addStep(index, list, s.value);
  });
  return el(doc, 'div', { class: 'rule-add' }, [s]);
}

/** A run as text (Copy result): the experiment, the model, the timing, each observation and step, and the events. */
export function experimentText(o: { title: string; version?: string }, e: Experiment, r: ExpRunResult, cmp?: RunCompare): string {
  const info = resultInfo({ kind: 'model', scope: `Experiment ${e.id}` }, ['Run from a clean start on scenario time (the simulated clock).'], ['Convergence time, throughput and synchronization accuracy are not measured.']);
  const lines = [`NetAtlas — Experiment “${e.name}” (${e.id})`, `Model: ${o.title}${o.version ? ` · NetAtlas ${o.version}` : ''} · model fingerprint ${r.fingerprint.slice(0, 12)}`, `Timing: scenario time; ${r.state === 'done' ? 'ran' : 'stopped'} to t = ${(r.reached / 1000).toFixed(1)} s of ${(r.duration / 1000).toFixed(0)} s${r.params.length ? `; parameters ${r.params.map((p) => `${p.key} ${p.value}`).join(', ')}` : ''}`, r.summary, ''];
  for (const x of r.observations) lines.push(`[${OUT_TEXT[x.outcome]}] ${x.obs.of} ${x.obs.target} expects ${x.obs.expect} at t = ${(x.at / 1000).toFixed(1)} s — ${x.actual}`);
  lines.push('', 'Steps:');
  for (const s of r.actions) lines.push(`  t = ${(s.at / 1000).toFixed(1)} s ${s.action.do} ${s.action.target}${s.action.to ? ' → ' + s.action.to : ''}: ${s.ok ? '' : 'not done — '}${s.text}`);
  if (cmp) {
    lines.push('', 'Compared with the previous run:');
    for (const l of cmp.lines) lines.push('  ' + l);
  }
  lines.push('', 'Events (state changes and drops):');
  for (const x of r.events) lines.push(`  t = ${(x.t / 1000).toFixed(2)} s ${x.device}: ${x.text}`);
  lines.push('');
  for (const l of exportFooter(info)) lines.push(l);
  return lines.join('\n') + '\n';
}

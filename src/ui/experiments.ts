/**
 * The Experiments workspace (Simulate → Experiments…): the panels around the
 * diagram for building, running and inspecting saved experiments.
 *
 *   left     the experiments; the selected one's identity, starting state,
 *            execution scope (with what it resolves to), its sequence of
 *            actions and observations as readable entries, and what still
 *            blocks a run;
 *   right    the selected step's configuration (its kind, when, its target
 *            and fields by the shared definitions of model/experiments.ts),
 *            what is missing, and its target's details;
 *   bottom   Run, Stop, Reset; the run's progress; each step's state, each
 *            observation's verdict, the events, the comparison with the
 *            previous run.
 *
 * One selected entry (the app's) is the only selection state; every change
 * is a document edit (one undo step) and the panels are drawn again from the
 * model, which keeps a step that is not fully configured. Nothing runs until
 * Run.
 */
import { ExpRunResult, OUTCOME_TEXT, ObsResult, RunCompare } from '../analysis/sim/experiment';
import { exportFooter, resultInfo } from '../analysis/result';
import { EXP_ACTIONS, EXP_OBSERVE, ExpAction, ExpObservation, ExpScope, Experiment, FIELD_LABEL, StepField, TargetKind, actionDef, actionText, durText, observationText, observeDef, scopeText, stepTimes, whenText } from '../model/experiments';
import { Model, deviceInterfaces } from '../model/types';
import { el } from './dom';

/** The selected entry: an experiment, and one of its steps (or none). */
export interface ExpSelection {
  exp: string | null;
  list: 'actions' | 'observe' | null;
  index: number;
}

export interface ExpWsView {
  model: Model;
  sel: ExpSelection;
  /** the experiment's index in the document (by id) */
  index: Map<string, number>;
  runs: Map<string, ExpRunResult[]>;
  running: { id: string; reached: number; duration: number; settle: number } | null;
  compare: Map<string, RunCompare>;
  outdated: (r: ExpRunResult) => boolean;
  /** why the model can't be edited now ('' it can) */
  locked: string;
  /** what the scope resolves to: devices run of all, and what it can't run */
  scope: (e: Experiment) => { run: number; total: number; added: string[]; boundary: number; cannot: string[] };
  /** a device chosen for a step whose interface or application is not chosen yet (the draft, not in the model) */
  draft: Map<string, string>;
  /** the last edit's note ("Cleared: group — Shut interface takes none") */
  note: string;
  /** the diagram's selection, for the shortcuts */
  selected: string | null;
}

export interface ExpWsActions {
  newExperiment(): void;
  select(sel: ExpSelection): void;
  /** a field of the experiment or of the selected step (a document path as JSON), text, an integer or a duration */
  set(path: string, kind: 'text' | 'int' | 'duration', value: string): void;
  setKind(list: 'actions' | 'observe', k: number, kind: string): void;
  addStep(list: 'actions' | 'observe', kind: string, target?: string): void;
  moveStep(list: 'actions' | 'observe', k: number, delta: -1 | 1): void;
  deleteStep(list: 'actions' | 'observe', k: number): void;
  setAfter(list: 'actions' | 'observe', k: number, action: number | null): void;
  setScope(kind: ExpScope['kind'], value: string): void;
  setDraft(key: string, dev: string): void;
  deleteExperiment(id: string): void;
  run(): void;
  stop(): void;
  reset(): void;
  compare(): void;
  copy(): void;
  showRef(ref: string): void;
}

const P = (...p: Array<string | number>): string => JSON.stringify(p);

/** The diagram refs a step's target stands for. */
export function targetRefs(model: Model, kind: TargetKind, t: string, e?: Experiment): string[] {
  if (!t) return [];
  const c = t.indexOf(':');
  const sl = t.indexOf('/');
  if (kind === 'step') {
    const a = e ? e.actions.find((x) => x.id === t) : undefined;
    return a ? targetRefs(model, (actionDef(a.do) as { target: TargetKind }).target, a.target, e) : sl > 0 ? ['device:' + t.slice(0, sl)] : [];
  }
  if (kind === 'expectations') return [];
  if (model.index.devices.has(t)) return ['device:' + t];
  if (c > 0 && model.index.devices.has(t.slice(0, c))) return ['iface:' + t];
  if (sl > 0 && model.index.devices.has(t.slice(0, sl))) return ['device:' + t.slice(0, sl)];
  if (model.index.links.has(t)) return ['link:' + t];
  if (model.index.relations.has(t)) return ['relation:' + t];
  const d = model.failureDomains.find((x) => x.id === t);
  if (d) return d.members.map((m) => (model.index.devices.has(m) ? 'device:' + m : model.index.links.has(m) ? 'link:' + m : model.index.relations.has(m) ? 'relation:' + m : 'group:' + m));
  return [];
}

/** Every target of an experiment, for the diagram's marks. */
export function experimentRefs(model: Model, e: Experiment): string[] {
  const out = new Set<string>();
  for (const a of e.actions) for (const r of targetRefs(model, (actionDef(a.do) as { target: TargetKind }).target, a.target, e)) out.add(r);
  for (const o of e.observations) for (const r of targetRefs(model, (observeDef(o.of) as { target: TargetKind }).target, o.target, e)) out.add(r);
  return Array.from(out);
}

/** Is a step configured? ('' it is, else what it misses) */
function stepMissing(s: ExpAction | ExpObservation, problems: string[], label: string): string[] {
  return problems.filter((p) => p.indexOf(label + ' (') === 0).map((p) => p.replace(/^[^:]*: /, ''));
}

// ------------------------------------------------------------------ the left panel

export function experimentsLeft(doc: Document, v: ExpWsView, act: ExpWsActions): HTMLElement {
  const box = el(doc, 'div', { class: 'ex-ws' });
  const add = el(doc, 'button', { type: 'button', id: 'ex-new', title: v.locked || 'Add an experiment to the model (one undo step); it runs only when you press Run' }, ['New experiment']) as HTMLButtonElement;
  add.disabled = !!v.locked;
  add.addEventListener('click', () => act.newExperiment());
  box.appendChild(el(doc, 'div', { class: 'ex-head' }, [el(doc, 'p', { class: 'muted small ex-purpose' }, ['A repeatable sequence of actions and observations, run on scenario time from its defined start. Nothing runs until Run.']), add]));
  const list = v.model.experiments;
  if (!list.length) {
    box.appendChild(el(doc, 'p', { class: 'muted', id: 'ex-empty' }, ['This model has no experiments yet.']));
    return box;
  }
  // the experiments: one is selected
  const ul = el(doc, 'ul', { class: 'ex-list', 'aria-label': 'Experiments' });
  for (const e of list) {
    const runs = v.runs.get(e.id) || [];
    const last = runs[runs.length - 1];
    const status = v.running && v.running.id === e.id ? 'Running' : e.problems.length ? `Incomplete (${e.problems.length})` : last ? last.summary : 'Ready, not run';
    const b = el(doc, 'button', { type: 'button', class: 'ex-item', 'data-exp': e.id, 'aria-pressed': v.sel.exp === e.id ? 'true' : 'false' }, [el(doc, 'strong', {}, [e.name]), el(doc, 'span', { class: 'muted small', 'data-status': e.problems.length ? 'incomplete' : last ? 'run' : 'ready' }, [(e.problems.length ? '⚠ ' : last ? '◷ ' : '○ ') + status])]);
    b.addEventListener('click', () => act.select({ exp: e.id, list: null, index: -1 }));
    ul.appendChild(el(doc, 'li', {}, [b]));
  }
  box.appendChild(ul);
  const e = list.find((x) => x.id === v.sel.exp);
  if (!e) return box;
  const k = v.index.get(e.id) as number;
  const sec = el(doc, 'section', { class: 'ex-sel', 'aria-labelledby': 'ex-sel-h' });
  sec.appendChild(el(doc, 'h3', { id: 'ex-sel-h', class: 'ex-sel-h' }, [e.name]));
  const input = (path: string, kind: 'text' | 'int' | 'duration', value: string, label: string, id: string, ph = ''): HTMLElement => {
    const i = el(doc, 'input', { type: 'text', id, 'data-ex-p': path, autocomplete: 'off', spellcheck: 'false', placeholder: ph }) as HTMLInputElement;
    i.value = value;
    i.disabled = !!v.locked;
    i.addEventListener('change', () => act.set(path, kind, i.value.trim()));
    return el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: id }, [label]), i]);
  };
  const g = el(doc, 'div', { class: 'tf-grid ex-grid' });
  g.appendChild(input(P('experiments', k, 'name'), 'text', e.name, 'Name', 'ex-name'));
  g.appendChild(input(P('experiments', k, 'duration'), 'duration', e.duration ? durText(e.duration).replace(' ', '') : '', 'Duration', 'ex-duration', '120s'));
  // the starting state: freshly booted, or settled for a while first
  const start = el(doc, 'select', { id: 'ex-start' }) as HTMLSelectElement;
  for (const [val, t] of [['boot', 'Freshly booted network'], ['settle', 'Settled first']]) start.appendChild(el(doc, 'option', { value: val }, [t]));
  start.value = e.settle ? 'settle' : 'boot';
  start.disabled = !!v.locked;
  start.addEventListener('change', () => act.set(P('experiments', k, 'settle'), 'duration', start.value === 'settle' ? '30s' : ''));
  const startRow = el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'ex-start' }, ['Start']), el(doc, 'span', { class: 'tf-pair' }, [start])]);
  if (e.settle) {
    const st = el(doc, 'input', { type: 'text', id: 'ex-settle', 'aria-label': 'Time to settle before the start', 'data-ex-p': P('experiments', k, 'settle'), value: durText(e.settle).replace(' ', '') }) as HTMLInputElement;
    st.disabled = !!v.locked;
    st.addEventListener('change', () => act.set(P('experiments', k, 'settle'), 'duration', st.value.trim()));
    (startRow.lastChild as HTMLElement).appendChild(st);
  }
  g.appendChild(startRow);
  // the execution scope, and what it resolves to
  const sk = el(doc, 'select', { id: 'ex-scope', 'aria-label': 'Execution scope' }) as HTMLSelectElement;
  for (const [val, t] of [['entire', 'Entire model'], ['group', 'Group'], ['vlan', 'VLAN'], ['domain', 'Failure domain'], ['device', 'Dependency slice of a device']]) sk.appendChild(el(doc, 'option', { value: val }, [t]));
  sk.value = e.scope.kind;
  sk.disabled = !!v.locked;
  const options: Array<[string, string]> =
    e.scope.kind === 'group'
      ? v.model.groups.map((x) => [x.id, x.label || x.id] as [string, string])
      : e.scope.kind === 'domain'
        ? v.model.failureDomains.map((x) => [x.id, x.label || x.id] as [string, string])
        : e.scope.kind === 'device'
          ? v.model.devices.map((x) => [x.id, x.id] as [string, string])
          : e.scope.kind === 'vlan'
            ? Array.from(new Set(v.model.networks.filter((n) => n.vlan !== undefined).map((n) => String(n.vlan)))).map((x) => [x, 'VLAN ' + x] as [string, string])
            : [];
  sk.addEventListener('change', () => {
    const first = sk.value === 'group' ? v.model.groups[0] : sk.value === 'domain' ? v.model.failureDomains[0] : sk.value === 'device' ? v.model.devices[0] : null;
    act.setScope(sk.value as ExpScope['kind'], first ? first.id : sk.value === 'vlan' ? String((v.model.networks.find((n) => n.vlan !== undefined) || { vlan: 1 }).vlan) : '');
  });
  const pair = el(doc, 'span', { class: 'tf-pair' }, [sk]);
  if (e.scope.kind !== 'entire') {
    const sv = el(doc, 'select', { id: 'ex-scope-value', 'aria-label': 'Scope: which' }) as HTMLSelectElement;
    for (const [val, t] of options) sv.appendChild(el(doc, 'option', { value: val }, [t]));
    if (!options.some((o) => o[0] === e.scope.value)) sv.appendChild(el(doc, 'option', { value: e.scope.value }, [`${e.scope.value} (unknown)`]));
    sv.value = e.scope.value;
    sv.disabled = !!v.locked;
    sv.addEventListener('change', () => act.setScope(e.scope.kind, sv.value));
    pair.appendChild(sv);
  }
  g.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'ex-scope' }, ['Scope']), pair]));
  sec.appendChild(g);
  const sc = v.scope(e);
  const resolved = el(doc, 'details', { class: 'layer-ev', id: 'ex-scope-detail' }, [el(doc, 'summary', {}, [e.scope.kind === 'entire' ? `Runs every device (${sc.total})` : `${scopeText(e.scope)}: runs ${sc.run} of ${sc.total} devices`])]);
  const rl = el(doc, 'ul', { class: 'small' });
  if (e.scope.kind === 'entire') rl.appendChild(el(doc, 'li', { class: 'muted' }, ['The whole model runs. A narrower scope runs fewer devices; devices outside it are not run and never answer.']));
  for (const x of sc.added.slice(0, 30)) rl.appendChild(el(doc, 'li', {}, [x]));
  if (sc.boundary) rl.appendChild(el(doc, 'li', { class: 'muted' }, [`${sc.boundary} cable${sc.boundary === 1 ? '' : 's'} lead out of the scope (not run beyond)`]));
  for (const x of sc.cannot) rl.appendChild(el(doc, 'li', { class: 'trace-error' }, ['Can’t run: ' + x]));
  rl.appendChild(el(doc, 'li', { class: 'muted' }, ['The scope follows the model as it is when the run starts; the steps name their targets explicitly.']));
  resolved.appendChild(rl);
  sec.appendChild(resolved);
  // the sequence: what it will do, entry by entry
  const times = stepTimes(e);
  const entries = (list: 'actions' | 'observe'): HTMLElement => {
    const steps: Array<ExpAction | ExpObservation> = list === 'actions' ? e.actions : e.observations;
    const ol = el(doc, 'ol', { class: 'ex-seq', 'aria-label': list === 'actions' ? 'Actions' : 'Observations', 'data-ex-list': list });
    steps.forEach((s, n) => {
      const label = list === 'actions' ? `action ${n + 1}` : `observation ${n + 1}`;
      const miss = stepMissing(s, e.problems, label);
      const t = (list === 'actions' ? times.actions : times.observations)[n];
      const text = list === 'actions' ? actionText(s as ExpAction) : observationText(s as ExpObservation, e.duration);
      const sel = v.sel.exp === e.id && v.sel.list === list && v.sel.index === n;
      const b = el(doc, 'button', { type: 'button', class: 'ex-entry' + (miss.length ? ' incomplete' : ''), 'data-ex-step': `${list}:${n}`, 'aria-pressed': sel ? 'true' : 'false', title: typeof t === 'number' ? `${text} (at ${durText(t)} after the start)` : text }, [el(doc, 'span', { class: 'ex-mark', 'aria-hidden': 'true' }, [miss.length ? '⚠' : '✓']), ' ', text, miss.length ? el(doc, 'span', { class: 'sr-only' }, [` — not configured: ${miss.join('; ')}`]) : '']);
      b.addEventListener('click', () => act.select({ exp: e.id, list, index: n }));
      ol.appendChild(el(doc, 'li', {}, [b]));
    });
    return ol;
  };
  const adder = (list: 'actions' | 'observe'): HTMLElement => {
    const s = el(doc, 'select', { id: list === 'actions' ? 'ex-add-action' : 'ex-add-observation', 'aria-label': list === 'actions' ? 'Add action' : 'Add observation' }) as HTMLSelectElement;
    s.appendChild(el(doc, 'option', { value: '' }, [list === 'actions' ? '+ Add action…' : '+ Add observation…']));
    for (const d of list === 'actions' ? EXP_ACTIONS : EXP_OBSERVE) s.appendChild(el(doc, 'option', { value: d.id }, [d.label]));
    s.disabled = !!v.locked;
    s.addEventListener('change', () => {
      if (s.value) act.addStep(list, s.value);
    });
    return s;
  };
  sec.appendChild(el(doc, 'h4', { class: 'ex-sub' }, [`Actions (${e.actions.length})`]));
  if (e.actions.length) sec.appendChild(entries('actions'));
  sec.appendChild(adder('actions'));
  sec.appendChild(el(doc, 'h4', { class: 'ex-sub' }, [`Observations (${e.observations.length})`]));
  if (e.observations.length) sec.appendChild(entries('observe'));
  sec.appendChild(adder('observe'));
  // shortcuts from the diagram's selection
  const sh = shortcuts(doc, v, act);
  if (sh) sec.appendChild(sh);
  // what blocks a run
  if (e.problems.length) {
    const pb = el(doc, 'details', { class: 'ex-problems', id: 'ex-problems', open: '' }, [el(doc, 'summary', {}, [`⚠ Can’t run yet (${e.problems.length})`])]);
    const pl = el(doc, 'ul', { class: 'small' });
    for (const p of e.problems.slice(0, 20)) {
      const m = /^(action|observation) (\d+) /.exec(p);
      if (m) {
        const b = el(doc, 'button', { type: 'button', class: 'link' }, [p]);
        b.addEventListener('click', () => act.select({ exp: e.id, list: m[1] === 'action' ? 'actions' : 'observe', index: Number(m[2]) - 1 }));
        pl.appendChild(el(doc, 'li', {}, [b]));
      } else pl.appendChild(el(doc, 'li', {}, [p]));
    }
    pb.appendChild(pl);
    sec.appendChild(pb);
  }
  // the rest
  const more = el(doc, 'details', { class: 'layer-ev ex-more' }, [el(doc, 'summary', {}, ['More'])]);
  more.appendChild(el(doc, 'p', { class: 'small' }, [`Id: ${e.id}`]));
  more.appendChild(input(P('experiments', k, 'description'), 'text', e.description || '', 'Description', 'ex-desc'));
  more.appendChild(el(doc, 'p', { class: 'small muted' }, [e.params.length ? `Simulation parameters: ${e.params.map((x) => `${x.key} ${x.value}`).join(', ')} (edit them in the YAML)` : 'Simulation parameters: the defaults (params: in the YAML sets others).']));
  const del = el(doc, 'button', { type: 'button', class: 'danger', id: 'ex-delete', title: v.locked || 'Delete this experiment (asks first; undo with Ctrl+Z)' }, ['Delete experiment']) as HTMLButtonElement;
  del.disabled = !!v.locked;
  del.addEventListener('click', () => act.deleteExperiment(e.id));
  more.appendChild(del);
  sec.appendChild(more);
  box.appendChild(sec);
  return box;
}

/** Steps from the diagram's selection: its device, interface, cable or application, as the first steps one would take there. */
function shortcuts(doc: Document, v: ExpWsView, act: ExpWsActions): HTMLElement | null {
  const r = v.selected;
  if (!r || v.locked) return null;
  const c = r.indexOf(':');
  const kind = r.slice(0, c);
  const id = r.slice(c + 1);
  const opts: Array<[string, 'actions' | 'observe', string, string]> = [];
  if (kind === 'device') {
    opts.push(['Power off', 'actions', 'power_off', id], ['Observe its state', 'observe', 'device', id]);
    const d = v.model.index.devices.get(id);
    for (const a of (d && d.applications) || []) opts.push([`Start ${a.id}`, 'actions', 'start_app', `${id}/${a.id}`]);
  } else if (kind === 'iface') opts.push(['Shut', 'actions', 'shut', id], ['Observe the interface', 'observe', 'interface', id]);
  else if (kind === 'link') opts.push(['Fail the cable', 'actions', 'fail', id], ['Observe the cable', 'observe', 'link', id]);
  if (!opts.length) return null;
  const row = el(doc, 'div', { class: 'ex-shortcuts', role: 'group', 'aria-label': `Steps for ${id}` }, [el(doc, 'span', { class: 'muted small' }, [`From the selection (${id}): `])]);
  for (const [label, list, k2, target] of opts.slice(0, 4)) {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-ex-shortcut': `${list}:${k2}` }, [label]);
    b.addEventListener('click', () => act.addStep(list, k2, target));
    row.appendChild(b);
  }
  return row;
}

// ------------------------------------------------------------------ the right panel

export function experimentsRight(doc: Document, v: ExpWsView, act: ExpWsActions): HTMLElement {
  const box = el(doc, 'div', { class: 'ex-step' });
  const e = v.model.experiments.find((x) => x.id === v.sel.exp);
  if (!e) {
    box.appendChild(el(doc, 'p', { class: 'muted' }, ['Select an experiment, then one of its steps to configure it.']));
    return box;
  }
  const list = v.sel.list;
  const n = v.sel.index;
  const step = list === 'actions' ? e.actions[n] : list === 'observe' ? e.observations[n] : undefined;
  if (!list || !step) {
    box.appendChild(el(doc, 'p', { class: 'muted' }, ['Select an action or an observation in the sequence to configure it, or add one.']));
    box.appendChild(el(doc, 'p', { class: 'small' }, [`${e.actions.length} action${e.actions.length === 1 ? '' : 's'}, ${e.observations.length} observation${e.observations.length === 1 ? '' : 's'}; ${e.duration ? `runs ${durText(e.duration)}` : 'no duration yet'}${e.settle ? ` after ${durText(e.settle)} to settle` : ', from a freshly booted network'}.`]));
    return box;
  }
  const k = v.index.get(e.id) as number;
  const base = ['experiments', k, list, n];
  const label = list === 'actions' ? `Action ${n + 1}` : `Observation ${n + 1}`;
  const def = list === 'actions' ? actionDef((step as ExpAction).do) : observeDef((step as ExpObservation).of);
  if (!def) return box;
  box.appendChild(el(doc, 'h3', { id: 'ex-step-h' }, [label]));
  const g = el(doc, 'div', { class: 'tf-grid ex-grid' });
  const row = (id: string, text: string, control: HTMLElement, msg?: string): void => {
    const cells: HTMLElement[] = [el(doc, 'label', { for: id }, [text]), control];
    g.appendChild(el(doc, 'div', { class: 'tf-row', 'data-ex-row': id }, cells));
    if (msg) {
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', id + '-msg');
      g.appendChild(el(doc, 'p', { class: 'field-err small', id: id + '-msg' }, [msg]));
    }
  };
  const missing = new Set(step.missing);
  // its kind: accepted at once (what the new kind takes is kept)
  const kind = el(doc, 'select', { id: 'ex-kind' }) as HTMLSelectElement;
  for (const d of list === 'actions' ? EXP_ACTIONS : EXP_OBSERVE) kind.appendChild(el(doc, 'option', { value: d.id }, [d.label]));
  kind.value = def.id;
  kind.disabled = !!v.locked;
  kind.addEventListener('change', () => act.setKind(list, n, kind.value));
  row('ex-kind', list === 'actions' ? 'Action' : 'Observe', kind);
  g.appendChild(el(doc, 'p', { class: 'help small muted', id: 'ex-kind-help' }, [def.help]));
  kind.setAttribute('aria-describedby', 'ex-kind-help');
  // when: from the start, or after an earlier action was submitted
  const after = el(doc, 'select', { id: 'ex-after' }) as HTMLSelectElement;
  after.appendChild(el(doc, 'option', { value: '' }, [list === 'observe' && step.at === undefined && !step.after ? 'At the end' : 'After the start']));
  if (list === 'observe') after.appendChild(el(doc, 'option', { value: 'start' }, ['After the start']));
  e.actions.forEach((a, j) => {
    if (list === 'actions' && j === n) return;
    after.appendChild(el(doc, 'option', { value: String(j) }, [`After action ${j + 1} is submitted${a.id ? ` (${a.id})` : ''}`]));
  });
  const ai = step.after ? e.actions.findIndex((a) => a.id === step.after) : -1;
  after.value = ai >= 0 ? String(ai) : list === 'observe' && step.at !== undefined && !step.after ? 'start' : '';
  after.disabled = !!v.locked;
  after.addEventListener('change', () => {
    if (after.value === '' || after.value === 'start') {
      act.setAfter(list, n, null);
      if (list === 'observe') act.set(P(...base, 'at'), 'duration', after.value === 'start' ? '0s' : '');
    } else act.setAfter(list, n, Number(after.value));
  });
  const at = el(doc, 'input', { type: 'text', id: 'ex-at', 'aria-label': 'Delay', placeholder: list === 'observe' && step.at === undefined && !step.after ? '' : '0s', autocomplete: 'off' }) as HTMLInputElement;
  at.value = step.at !== undefined ? durText(step.at).replace(' ', '') : '';
  at.disabled = !!v.locked || (list === 'observe' && step.at === undefined && !step.after);
  at.addEventListener('change', () => act.set(P(...base, 'at'), 'duration', at.value.trim()));
  row('ex-after', 'When', el(doc, 'span', { class: 'tf-pair' }, [after, at]), missing.has('at') ? 'the time is not a duration (e.g. 10s)' : undefined);
  g.appendChild(el(doc, 'p', { class: 'help small muted' }, [whenText(step, e.duration) + (step.after ? ' — its submission, not its effect: an observation says what happened' : '')]));
  // its target, by what the kind needs
  targetControl(doc, v, act, e, list, n, step, def.target, base, row, missing.has('target'));
  // its fields
  const fields: StepField[] = def.required.concat(def.optional);
  for (const f of fields) {
    const id = 'ex-f-' + f;
    const val = (step as unknown as { [k: string]: unknown })[f];
    const i = el(doc, 'input', { type: 'text', id, autocomplete: 'off', spellcheck: 'false', placeholder: f === 'service' ? 'tcp/443, udp/53, icmp' : f === 'group' ? '239.1.1.1' : f === 'interval' ? '1s' : f === 'to' ? 'device, interface, address, application' : f === 'port' ? '5000' : f === 'size' ? '1000' : '1', list: f === 'to' ? 'ex-ends' : null }) as HTMLInputElement;
    i.value = val === undefined ? '' : f === 'interval' ? durText(val as number).replace(' ', '') : String(val);
    i.disabled = !!v.locked;
    i.addEventListener('change', () => act.set(P(...base, f), f === 'interval' ? 'duration' : f === 'count' || f === 'port' || f === 'size' ? 'int' : 'text', i.value.trim()));
    row(id, FIELD_LABEL[f] + (def.required.indexOf(f) >= 0 ? '' : ' (optional)'), i, missing.has(f) ? `${FIELD_LABEL[f]} is required` : undefined);
  }
  if (fields.indexOf('to') >= 0) g.appendChild(endsList(doc, v.model));
  // an observation: what it expects, over which window
  if (list === 'observe') {
    const o = step as ExpObservation;
    const od = def as (typeof EXP_OBSERVE)[number];
    const ex = el(doc, 'select', { id: 'ex-expect' }) as HTMLSelectElement;
    for (const x of od.expect) ex.appendChild(el(doc, 'option', { value: x }, [x]));
    if (o.expect && od.expect.indexOf(o.expect) < 0) ex.appendChild(el(doc, 'option', { value: o.expect }, [o.expect]));
    ex.value = o.expect;
    ex.disabled = !!v.locked;
    ex.addEventListener('change', () => act.set(P(...base, 'expect'), 'text', ex.value));
    row('ex-expect', 'Expect', ex, missing.has('expect') ? 'the expected outcome is required' : undefined);
    const w = el(doc, 'input', { type: 'text', id: 'ex-within', placeholder: 'read at once', autocomplete: 'off' }) as HTMLInputElement;
    w.value = o.within ? durText(o.within).replace(' ', '') : '';
    w.disabled = !!v.locked;
    w.addEventListener('change', () => act.set(P(...base, 'within'), 'duration', w.value.trim()));
    row('ex-within', 'Window', w);
    g.appendChild(el(doc, 'p', { class: 'help small muted', id: 'ex-verdicts' }, [od.window === 'state' ? `Satisfied as soon as the state is “${o.expect || od.expect[0]}” within the window (without one: when read); violated when it is not by its end; indeterminate when it can’t be read (outside the scope, not determinable).` : `Counted until the window ends (without one: when read): satisfied when that is “${o.expect || od.expect[0]}”; indeterminate while nothing was sent or it is still on its way.`]));
  }
  box.appendChild(g);
  if (v.note) box.appendChild(el(doc, 'p', { class: 'small', id: 'ex-note', role: 'status' }, [v.note]));
  // order and removal
  const steps = list === 'actions' ? e.actions : e.observations;
  const tools = el(doc, 'div', { class: 'tf-actions' });
  const btn = (id: string, text: string, dis: boolean, f: () => void): void => {
    const b = el(doc, 'button', { type: 'button', id, class: id === 'ex-step-delete' ? 'danger' : '' }, [text]) as HTMLButtonElement;
    b.disabled = dis || !!v.locked;
    b.addEventListener('click', f);
    tools.appendChild(b);
  };
  btn('ex-step-up', 'Move up', n === 0, () => act.moveStep(list, n, -1));
  btn('ex-step-down', 'Move down', n >= steps.length - 1, () => act.moveStep(list, n, 1));
  btn('ex-step-delete', `Delete ${list === 'actions' ? 'action' : 'observation'}`, false, () => act.deleteStep(list, n));
  box.appendChild(tools);
  // the target's details
  const refs = targetRefs(v.model, def.target, step.target, e);
  if (refs.length) {
    const tl = el(doc, 'div', { class: 'ex-target small' }, [el(doc, 'strong', {}, ['Target: '])]);
    for (const r of refs.slice(0, 6)) {
      const b = el(doc, 'button', { type: 'button', class: 'link', 'data-ex-show': r, title: 'Show it in the diagram' }, [r.slice(r.indexOf(':') + 1)]);
      b.addEventListener('click', () => act.showRef(r));
      tl.appendChild(b);
      tl.appendChild(doc.createTextNode(' '));
    }
    const d = v.model.index.devices.get((refs[0].split(':')[1] || '').split('/')[0]);
    if (d) tl.appendChild(el(doc, 'div', { class: 'muted' }, [`${d.id}: ${d.type}${deviceInterfaces(d).length ? `, ${deviceInterfaces(d).length} interfaces` : ''}${(d.applications || []).length ? `, applications ${(d.applications || []).map((a) => a.id).join(', ')}` : ''}`]));
    box.appendChild(tl);
  }
  return box;
}

/** The ends a communication can name (a datalist). */
function endsList(doc: Document, model: Model): HTMLElement {
  const list = el(doc, 'datalist', { id: 'ex-ends' });
  for (const d of model.devices) {
    list.appendChild(el(doc, 'option', { value: d.id }));
    for (const i of deviceInterfaces(d)) if (i.addresses.length) list.appendChild(el(doc, 'option', { value: d.id + ':' + i.id }));
    for (const a of d.applications || []) list.appendChild(el(doc, 'option', { value: `${d.id}/${a.id}` }));
  }
  return list;
}

/** The target control a kind needs: a device, then an interface or an application; a cable; what can fail; a step; expectations; a source. */
function targetControl(doc: Document, v: ExpWsView, act: ExpWsActions, e: Experiment, list: 'actions' | 'observe', n: number, step: ExpAction | ExpObservation, kind: TargetKind, base: Array<string | number>, row: (id: string, text: string, control: HTMLElement, msg?: string) => void, missing: boolean): void {
  const m = v.model;
  const path = P(...base, 'target');
  const t = step.target;
  const msg = missing ? 'the target is required' : undefined;
  const select = (id: string, opts: Array<[string, string]>, cur: string, label: string, onChange: (val: string) => void, groups?: Array<[string, Array<[string, string]>]>): HTMLSelectElement => {
    const s = el(doc, 'select', { id, 'aria-label': label }) as HTMLSelectElement;
    s.appendChild(el(doc, 'option', { value: '' }, ['Select…']));
    for (const [val, text] of opts) s.appendChild(el(doc, 'option', { value: val }, [text]));
    for (const [gl, items] of groups || []) {
      if (!items.length) continue;
      const og = el(doc, 'optgroup', { label: gl });
      for (const [val, text] of items) og.appendChild(el(doc, 'option', { value: val }, [text]));
      s.appendChild(og);
    }
    if (cur && !Array.prototype.some.call(s.options, (o: HTMLOptionElement) => o.value === cur)) s.appendChild(el(doc, 'option', { value: cur }, [`${cur} (not in the model)`]));
    s.value = cur;
    s.disabled = !!v.locked;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const devices = m.devices.map((d) => [d.id, d.id] as [string, string]);
  const key = `${e.id}|${list}|${n}`;
  if (kind === 'iface' || kind === 'host-iface' || kind === 'app') {
    // a device first, then its interface or application: the device alone is a draft until both are chosen
    const sep = kind === 'app' ? '/' : ':';
    const cut = t.indexOf(sep);
    const dev = cut > 0 ? t.slice(0, cut) : v.draft.get(key) || '';
    const own = cut > 0 ? t.slice(cut + 1) : '';
    const devOpts = kind === 'app' ? m.devices.filter((d) => (d.applications || []).length).map((d) => [d.id, d.id] as [string, string]) : devices;
    const ds = select('ex-target-dev', devOpts, dev, 'Target device', (val) => act.setDraft(key, val));
    const d = m.index.devices.get(dev);
    const items: Array<[string, string]> = !d ? [] : kind === 'app' ? (d.applications || []).map((a) => [a.id, `${a.id} (${a.name})`] as [string, string]) : deviceInterfaces(d).map((i) => [i.id, i.id + (i.addresses.length ? ` (${i.addresses[0]})` : '')] as [string, string]);
    const is = select('ex-target-own', items, own, kind === 'app' ? 'Application' : 'Interface', (val) => act.set(path, 'text', val && dev ? dev + sep + val : ''));
    is.disabled = is.disabled || !dev;
    row('ex-target-dev', kind === 'app' ? 'Application' : 'Interface', el(doc, 'span', { class: 'tf-pair' }, [ds, is]), msg && !dev ? msg : msg ? `choose the ${kind === 'app' ? 'application' : 'interface'} of ${dev}` : undefined);
    return;
  }
  if (kind === 'device' || kind === 'router') {
    row('ex-target', 'Device', select('ex-target', devices, t, 'Target device', (val) => act.set(path, 'text', val)), msg);
    return;
  }
  if (kind === 'link') {
    row('ex-target', 'Cable', select('ex-target', m.links.map((l) => [l.id, `${l.id} (${l.a.device} – ${l.b.device})`] as [string, string]), t, 'Target cable', (val) => act.set(path, 'text', val)), msg);
    return;
  }
  if (kind === 'failable') {
    const s = select('ex-target', [], t, 'What fails', (val) => act.set(path, 'text', val), [
      ['Devices', devices],
      ['Cables', m.links.map((l) => [l.id, `${l.id} (${l.a.device} – ${l.b.device})`] as [string, string])],
      ['Relations', m.relations.map((r) => [r.id, `${r.id} (${r.protocol})`] as [string, string])],
      ['Failure domains', m.failureDomains.map((x) => [x.id, `${x.label} (${x.members.length} members)`] as [string, string])],
    ]);
    row('ex-target', 'Target', s, msg);
    return;
  }
  if (kind === 'step') {
    const want = (step as ExpObservation).of === 'send' ? 'send' : 'start_app';
    const opts = e.actions.filter((a) => a.do === want && a.id).map((a) => [a.id as string, `${a.id}: ${actionText(a)}`] as [string, string]);
    const s = select('ex-target', opts, t, 'Which step', (val) => act.set(path, 'text', val));
    row('ex-target', want === 'send' ? 'Send action' : 'Started application', s, msg || (!opts.length ? `no ${want === 'send' ? 'Send' : 'Start application'} action with an id yet: give one an id (its action's More), then choose it` : undefined));
    return;
  }
  if (kind === 'expectations') {
    // all, or the ones ticked: shown with their ids — none invented
    const fs = el(doc, 'fieldset', { class: 'ex-exps', id: 'ex-target' }, [el(doc, 'legend', {}, ['Saved expectations'])]);
    if (!m.expectations.length) fs.appendChild(el(doc, 'p', { class: 'muted small' }, ['The model has no saved expectations (Analyze → Design checks adds them).']));
    const chosen = new Set(t === '*' ? m.expectations.map((x) => x.id) : t.split(/[\s,]+/).filter((x) => x));
    const all = el(doc, 'input', { type: 'checkbox', id: 'ex-exp-all' }) as HTMLInputElement;
    all.checked = t === '*';
    all.disabled = !!v.locked || !m.expectations.length;
    all.addEventListener('change', () => act.set(path, 'text', all.checked ? '*' : ''));
    fs.appendChild(el(doc, 'div', { class: 'tf-check' }, [all, el(doc, 'label', { for: 'ex-exp-all' }, [`All, as the model has them when the run starts (${m.expectations.length})`])]));
    m.expectations.forEach((x, j) => {
      const c = el(doc, 'input', { type: 'checkbox', id: 'ex-exp-' + j, 'data-exp-id': x.id }) as HTMLInputElement;
      c.checked = chosen.has(x.id);
      c.disabled = !!v.locked || t === '*';
      c.addEventListener('change', () => {
        const now = m.expectations.filter((y) => (y.id === x.id ? c.checked : chosen.has(y.id))).map((y) => y.id);
        act.set(path, 'text', now.join(', '));
      });
      fs.appendChild(el(doc, 'div', { class: 'tf-check' }, [c, el(doc, 'label', { for: 'ex-exp-' + j }, [`${x.id}: ${x.name}`])]));
    });
    g(fs, msg);
    return;
  }
  // a source: a device, interface, application or address
  const i = el(doc, 'input', { type: 'text', id: 'ex-target', list: 'ex-ends', autocomplete: 'off', spellcheck: 'false', placeholder: 'device, interface, application or address' }) as HTMLInputElement;
  i.value = t;
  i.disabled = !!v.locked;
  i.addEventListener('change', () => act.set(path, 'text', i.value.trim()));
  row('ex-target', 'From', i, msg);
  function g(control: HTMLElement, m2?: string): void {
    row('ex-target', 'Target', control, m2);
  }
}

// ------------------------------------------------------------------ the bottom panel

export function experimentsDock(doc: Document, v: ExpWsView, act: ExpWsActions): HTMLElement {
  const box = el(doc, 'div', { class: 'ex-dock' });
  const e = v.model.experiments.find((x) => x.id === v.sel.exp);
  const runs = e ? v.runs.get(e.id) || [] : [];
  const last = runs[runs.length - 1];
  const running = !!v.running && !!e && v.running.id === e.id;
  // the controls: Run explicitly; Stop; Reset; Compare; Copy
  const bar = el(doc, 'div', { class: 'ex-runbar', role: 'group', 'aria-label': 'Run' });
  const b = (id: string, text: string, why: string, f: () => void, primary = false): void => {
    const x = el(doc, 'button', { type: 'button', id, class: primary ? 'primary' : '', title: why || text }, [text]) as HTMLButtonElement;
    x.disabled = !!why;
    x.addEventListener('click', f);
    bar.appendChild(x);
  };
  const runWhy = !e ? 'Select an experiment' : running ? 'It is running' : v.running ? `Another experiment is running (${v.running.id})` : e.problems.length ? `It can’t run yet: ${e.problems[0]}${e.problems.length > 1 ? ` (+${e.problems.length - 1})` : ''}` : '';
  b('ex-run', 'Run', runWhy, () => act.run(), true);
  b('ex-stop', 'Stop', running ? '' : 'Nothing is running', () => act.stop());
  b('ex-reset', 'Reset results', runs.length && !running ? '' : 'No results to reset', () => act.reset());
  b('ex-compare', 'Compare with the previous run', runs.length >= 2 && !running ? '' : 'Run it twice to compare', () => act.compare());
  b('ex-copy', 'Copy result', last && !running ? '' : 'No result yet', () => act.copy());
  // the state of the run: words, and the progress (polite, never moving the focus)
  const state = !e ? 'No experiment selected.' : running && v.running ? (v.running.reached < 0 ? `Running: settling, ${durText(-v.running.reached)} before the start` : `Running on scenario time: t = ${(v.running.reached / 1000).toFixed(0)} s of ${(v.running.duration / 1000).toFixed(0)} s`) : last ? `${last.state === 'stopped' ? 'Stopped' : last.state === 'refused' ? 'Not run' : 'Done'}: ${last.summary}${v.outdated(last) ? ' — outdated: the model changed since' : ''}` : e.problems.length ? 'Not runnable yet: configure the steps marked ⚠.' : 'Ready. Nothing has run: press Run.';
  bar.appendChild(el(doc, 'span', { id: 'ex-progress', class: 'small ex-state', role: 'status', 'aria-live': running ? 'off' : 'polite' }, [state]));
  box.appendChild(bar);
  if (!e) return box;
  if (!last) {
    // before a run: what it will do, in order
    const ul = el(doc, 'ol', { class: 'ex-plan small', 'aria-label': 'What it will do' });
    ul.appendChild(el(doc, 'li', {}, [`Start: ${e.settle ? `the network runs ${durText(e.settle)} to settle first` : 'a freshly booted network'}; scope: ${scopeText(e.scope)}.`]));
    for (const a of e.actions) ul.appendChild(el(doc, 'li', {}, [actionText(a)]));
    for (const o of e.observations) ul.appendChild(el(doc, 'li', {}, [observationText(o, e.duration)]));
    ul.appendChild(el(doc, 'li', {}, [`End at ${durText(e.duration || 0)}.`]));
    box.appendChild(el(doc, 'div', { class: 'ex-cols' }, [el(doc, 'section', { 'aria-labelledby': 'ex-plan-h' }, [el(doc, 'h3', { id: 'ex-plan-h' }, ['What it will do']), ul])]));
    return box;
  }
  const cols = el(doc, 'div', { class: 'ex-cols' });
  // the steps: submitted or refused, at their times (those not reached: pending)
  const steps = el(doc, 'ol', { class: 'ex-steplog small', 'aria-label': 'Actions in this run' });
  e.actions.forEach((a, n) => {
    const s = last.actions.find((x) => x.index === n);
    steps.appendChild(el(doc, 'li', { 'data-state': s ? s.state : 'pending' }, [el(doc, 'span', { class: 'ex-mark', 'aria-hidden': 'true' }, [s ? (s.state === 'submitted' ? '→' : '✕') : '…']), ` ${s ? `t = ${(s.at / 1000).toFixed(1)} s` : 'not reached'} — ${actionText(a)}: `, el(doc, 'span', { class: s && s.state === 'refused' ? 'trace-error' : 'muted' }, [s ? `${s.state === 'submitted' ? 'submitted' : 'refused'}: ${s.text}` : 'pending'])]));
  });
  cols.appendChild(el(doc, 'section', { 'aria-labelledby': 'ex-steps-h' }, [el(doc, 'h3', { id: 'ex-steps-h' }, [`Actions (${last.actions.length} of ${e.actions.length} submitted or refused)`]), steps]));
  // the observations: the verdict, what was found, when
  const obs = el(doc, 'ul', { class: 'ex-obs small', 'aria-label': 'Observations in this run' });
  for (const r of last.observations) obs.appendChild(obsItem(doc, r, e));
  cols.appendChild(el(doc, 'section', { 'aria-labelledby': 'ex-obs-h' }, [el(doc, 'h3', { id: 'ex-obs-h' }, ['Observations']), obs]));
  // the events, and the comparison
  const side = el(doc, 'section', { 'aria-labelledby': 'ex-ev-h' }, [el(doc, 'h3', { id: 'ex-ev-h' }, [`Run: ${last.scope}${last.settle ? `, settled ${durText(last.settle)}` : ''}`])]);
  const ev = el(doc, 'details', { class: 'layer-ev', id: 'ex-events' }, [el(doc, 'summary', {}, [`Events (${last.events.length}: state changes and drops)`])]);
  const evl = el(doc, 'ul', { class: 'small' });
  for (const x of last.events.slice(-80)) evl.appendChild(el(doc, 'li', {}, [`t = ${(x.t / 1000).toFixed(2)} s ${x.device}: ${x.text}`]));
  ev.appendChild(evl);
  side.appendChild(ev);
  const cmp = v.compare.get(e.id);
  if (cmp) side.appendChild(el(doc, 'div', { class: 'ex-compare small', id: 'ex-compare-' + e.id }, [el(doc, 'strong', {}, ['Compared with the previous run']), el(doc, 'ul', {}, cmp.lines.map((l) => el(doc, 'li', {}, [l])))]));
  cols.appendChild(side);
  box.appendChild(cols);
  return box;
}

function obsItem(doc: Document, r: ObsResult, e: Experiment): HTMLElement {
  const mark = r.outcome === 'satisfied' ? '✓' : r.outcome === 'violated' ? '✕' : r.outcome === 'unsupported' ? '–' : '?';
  return el(doc, 'li', { 'data-outcome': r.outcome, class: 'v-' + r.outcome }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [mark + ' ']), el(doc, 'strong', {}, [OUTCOME_TEXT[r.outcome] + ': ']), observationText(r.obs, e.duration), el(doc, 'div', { class: 'muted' }, [`${r.actual} — decided at t = ${(r.at / 1000).toFixed(1)} s${r.to > r.from ? ` (window ${(r.from / 1000).toFixed(1)}–${(r.to / 1000).toFixed(1)} s)` : ''}`])]);
}

/** A run as text (Copy result): the experiment, the model, the timing, each observation and step, and the events. */
export function experimentText(o: { title: string; version?: string }, e: Experiment, r: ExpRunResult, cmp?: RunCompare): string {
  const info = resultInfo({ kind: 'model', scope: `Experiment ${e.id}` }, ['Run on scenario time (the simulated clock) from the experiment’s defined start.'], ['Convergence time, throughput and synchronization accuracy are not measured.']);
  const lines = [`NetAtlas — Experiment “${e.name}” (${e.id})`, `Model: ${o.title}${o.version ? ` · NetAtlas ${o.version}` : ''} · model fingerprint ${r.fingerprint.slice(0, 12)}`, `Scope: ${r.scope}; start: ${r.settle ? `settled ${durText(r.settle)}` : 'freshly booted'}`, `Timing: scenario time; ${r.state === 'done' ? 'ran' : r.state} to t = ${(r.reached / 1000).toFixed(1)} s of ${(r.duration / 1000).toFixed(0)} s${r.params.length ? `; parameters ${r.params.map((p) => `${p.key} ${p.value}`).join(', ')}` : ''}`, r.summary, ''];
  for (const x of r.observations) lines.push(`[${OUTCOME_TEXT[x.outcome]}] ${observationText(x.obs, e.duration)} — ${x.actual}`);
  lines.push('', 'Actions:');
  for (const s of r.actions) lines.push(`  t = ${(s.at / 1000).toFixed(1)} s ${actionText(s.action)}: ${s.state} — ${s.text}`);
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

/**
 * The Simulation tab: the saved scenarios (Play, Delete), the scenario being
 * played (its steps, Previous / Next, what changed since the previous step,
 * what is down or degraded, which device pairs lose reachability). Built from elements and text
 * nodes only; the data comes from analysis/scenario.ts and
 * analysis/failure.ts. Objects are links that select them in the diagram
 * (data-goto); every state is written as a word with a symbol, never shown
 * by colour alone.
 */
import { Affected, LostPair, refLabel } from '../analysis/failure';
import { StepDiff, StepView, diffEmpty, scenarioProblems, stepText, targetRef } from '../analysis/scenario';
import { Model, Scenario, ScenarioStep } from '../model/types';
import { Flow, TrafficChange, TrafficState } from '../analysis/traffic';
import { MAX_DOTS } from './traffic';
import { el } from './dom';

/** The simulation on screen: the scenario, the step shown, its result and what changed since the step before. */
export interface SimState {
  /** the scenario's name ("Ad-hoc scenario" until it is saved) */
  name: string;
  /** the id of the saved scenario ('' = not saved) */
  saved: string;
  steps: ScenarioStep[];
  /** the step shown: 0 = before the first step (the model as written) … steps.length */
  at: number;
  view: StepView;
  /** what changed since the step before (null at step 0) */
  diff: StepDiff | null;
  /** the objects (refs) out of service for planned maintenance, not failed */
  maintained: string[];
}

/** The traffic animation's state for the tab. */
export interface TrafficPanel {
  on: boolean;
  paused: boolean;
  reduce: boolean;
  data: { state: TrafficState; changes: TrafficChange[] } | null;
}

export interface SimPanelActions {
  traffic: TrafficPanel | null;
  trafficToggle(): void;
  trafficPause(): void;
  /** the selection can be failed (too) ('' = it can; else why not) */
  addBlocked: string;
  add(): void;
  go(step: number): void;
  removeStep(step: number): void;
  restore(ref: string): void;
  save(): void;
  exit(): void;
  play(id: string): void;
  remove(id: string): void;
}

/** How many device pairs are listed before "and N more". */
const PAIRS_SHOWN = 40;

const STATE: { [s: string]: [string, string] } = {
  down: ['✕', 'Down'],
  degraded: ['◐', 'Degraded'],
  takeover: ['↻', 'Takes over'],
};

/** One line counting a kind: "2 down, 3 degraded" ('' when none). */
function countText(list: Affected[]): string {
  const down = list.filter((a) => a.state === 'down').length;
  const deg = list.filter((a) => a.state === 'degraded').length;
  const take = list.filter((a) => a.state === 'takeover').length;
  return [down ? `${down} down` : '', deg ? `${deg} degraded` : '', take ? `${take} take${take === 1 ? 's' : ''} over` : ''].filter((x) => x).join(', ');
}

/** The counts of a step: "7 down · 8 degraded or taken over · 3 device pairs lose reachability". */
export function simSummary(v: StepView): string {
  const s = v.summary;
  const all = s.devices.concat(s.links, s.relations, s.tunnels, s.networks, s.routes);
  const down = all.filter((a) => a.state === 'down').length;
  const deg = all.length - down;
  const lost = v.lost.pairs.filter((p) => !p.partial).length;
  const part = v.lost.pairs.length - lost;
  return `${down} down · ${deg} degraded or taken over · ${lost} device pair${lost === 1 ? '' : 's'} lose${lost === 1 ? 's' : ''} reachability${part ? ` (${part} more in part)` : ''}`;
}

/** Where the simulation is: "step 2 of 3: Fail hq-rtr1" / "before the first step". */
export function stepPosition(model: Model, st: SimState): string {
  if (!st.at) return `before the first of ${st.steps.length} step${st.steps.length === 1 ? '' : 's'}`;
  return `step ${st.at} of ${st.steps.length}: ${stepText(model, st.steps[st.at - 1])}`;
}

const ref = (doc: Document, model: Model, r: string): HTMLElement => el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': r }, [refLabel(model, r)]);

/** The Simulation tab. */
export function simulationPanel(doc: Document, model: Model, st: SimState | null, act: SimPanelActions): HTMLElement {
  const box = el(doc, 'section', { class: 'sim-panel', 'aria-label': 'Simulation' });
  const add = el(doc, 'button', { type: 'button', id: 'sim-add', title: act.addBlocked || 'Fail the selected object in a new step (X)' }, [st ? 'Fail the selection' : 'Fail the selection (X)']) as HTMLButtonElement;
  add.disabled = !!act.addBlocked;
  add.addEventListener('click', () => act.add());
  if (!st) {
    box.appendChild(el(doc, 'h3', {}, ['Simulation']));
    box.appendChild(
      el(doc, 'p', { class: 'muted small' }, [
        'Simulate answers “what if”: it plays a scenario, steps that fail or restore objects, on a copy of the network’s state. The model itself never changes, and editing is paused while a simulation is on.',
      ]),
    );
    box.appendChild(scenarioList(doc, model, act));
    box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Or start a scenario now: select a cable, port, device or relation and press X.']));
    box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [add]));
    if (act.addBlocked) box.appendChild(el(doc, 'p', { class: 'muted small', id: 'sim-add-why' }, [act.addBlocked]));
    box.appendChild(approximations(doc));
    return box;
  }
  const v = st.view;
  box.appendChild(el(doc, 'h3', { id: 'sim-title' }, ['Scenario: ', el(doc, 'span', { class: 'sim-name' }, [st.name]), st.saved ? null : el(doc, 'span', { class: 'muted' }, [' (not saved)'])]));
  box.appendChild(el(doc, 'p', { class: 'sim-status', role: 'status' }, [el(doc, 'span', { class: 'ts-mark', 'aria-hidden': 'true' }, ['◈ ']), `Simulated, ${stepPosition(model, st)} · ${simSummary(v)}`]));
  // the player
  const prev = el(doc, 'button', { type: 'button', id: 'sim-prev', 'data-command': 'sim.prev', title: 'The step before ([)' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['◀ ']), 'Previous step']) as HTMLButtonElement;
  prev.disabled = st.at === 0;
  prev.addEventListener('click', () => act.go(st.at - 1));
  const next = el(doc, 'button', { type: 'button', id: 'sim-next', 'data-command': 'sim.next', title: 'The next step (])' }, ['Next step', el(doc, 'span', { 'aria-hidden': 'true' }, [' ▶'])]) as HTMLButtonElement;
  next.disabled = st.at >= st.steps.length;
  next.addEventListener('click', () => act.go(st.at + 1));
  box.appendChild(el(doc, 'div', { class: 'sim-player', role: 'group', 'aria-label': 'Play the scenario' }, [prev, el(doc, 'span', { class: 'sim-at' }, [`Step ${st.at} of ${st.steps.length}`]), next]));
  // the steps
  const problems = new Map(scenarioProblems(model, { id: st.saved, label: st.name, steps: st.steps, line: 0 }).map((p) => [p.index, p.problem] as [number, string]));
  const ol = el(doc, 'ol', { class: 'sim-steps', 'aria-label': 'Steps' });
  const item = (k: number, text: string, note?: string): HTMLElement => {
    const cur = k === st.at;
    const go = el(doc, 'button', { type: 'button', class: 'ref sim-go', 'data-sim-step': String(k), 'aria-current': cur ? 'step' : null, title: cur ? 'The step shown' : 'Show the state after this step' }, [el(doc, 'span', { class: 'sim-cur', 'aria-hidden': 'true' }, [cur ? '▶ ' : '']), text]);
    go.addEventListener('click', () => act.go(k));
    const li = el(doc, 'li', { class: cur ? 'current' : '', value: String(k) }, [go]);
    if (note) li.appendChild(el(doc, 'span', { class: 'sim-why' }, [' — ' + note]));
    const p = problems.get(k - 1);
    if (p) li.appendChild(el(doc, 'span', { class: 'sim-problem' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [' ⚠ ']), 'skipped: ' + p]));
    if (k > 0) {
      const rm = el(doc, 'button', { type: 'button', class: 'mini', 'data-sim-remove-step': String(k), 'aria-label': `Remove step ${k}: ${text}`, title: st.saved ? 'Remove this step from the saved scenario (can be undone)' : 'Remove this step' }, ['Remove']);
      rm.addEventListener('click', () => act.removeStep(k));
      li.appendChild(doc.createTextNode(' '));
      li.appendChild(rm);
    }
    return li;
  };
  ol.appendChild(item(0, 'Before the first step (the model as written)'));
  st.steps.forEach((s, i) => ol.appendChild(item(i + 1, stepText(model, s), s.note)));
  box.appendChild(ol);
  const save = el(doc, 'button', { type: 'button', id: 'sim-save', 'aria-haspopup': 'dialog', title: st.saved ? 'Change the scenario’s name and description (one undo step)' : 'Save the scenario in the model, to replay it later (one undo step)' }, [st.saved ? 'Rename scenario…' : 'Save scenario…']);
  save.addEventListener('click', () => act.save());
  const exit = el(doc, 'button', { type: 'button', id: 'sim-exit', title: 'End the simulation (Esc)' }, ['Exit simulation']);
  exit.addEventListener('click', () => act.exit());
  box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [add, save, exit]));
  if (act.addBlocked) box.appendChild(el(doc, 'p', { class: 'muted small', id: 'sim-add-why' }, [act.addBlocked]));
  // what changed since the step before
  if (st.diff) box.appendChild(diffSection(doc, model, st.diff));
  // what is failed now
  box.appendChild(el(doc, 'h4', {}, [`Failed now (${v.failed.length})`]));
  if (v.failed.length) {
    const ul = el(doc, 'ul', { class: 'sim-failed reflist' });
    for (const r of v.failed) {
      const restore = el(doc, 'button', { type: 'button', class: 'mini', 'data-sim-restore': r, 'aria-label': `Restore ${refLabel(model, r)} in a new step`, title: 'Add a step that restores it' }, ['Restore']);
      restore.addEventListener('click', () => act.restore(r));
      const planned = st.maintained.indexOf(r) >= 0;
      ul.appendChild(el(doc, 'li', {}, [ref(doc, model, r), planned ? el(doc, 'span', { class: 'sim-why' }, [' — in planned maintenance']) : null, ' ', restore]));
    }
    box.appendChild(ul);
  } else box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Nothing is failed at this step.']));
  if (act.traffic) box.appendChild(trafficSection(doc, act.traffic, act));
  box.appendChild(results(doc, model, v));
  box.appendChild(approximations(doc));
  return box;
}

const CHANGE: { [k in TrafficChange['kind']]: [string, string] } = {
  rerouted: ['↷', 'Rerouted'],
  lost: ['✕', 'Lost'],
  restored: ['✓', 'Restored'],
  stopped: ['■', 'Stopped'],
  resumed: ['▶', 'Resumed'],
};

/**
 * The traffic of the step shown, as text: the switch and Pause, what changed
 * since the step before (rerouted, lost, restored …), the demands with their
 * paths, and the control traffic per relation. Everything the dots show is
 * here too.
 */
function trafficSection(doc: Document, t: TrafficPanel, act: SimPanelActions): HTMLElement {
  const box = el(doc, 'div', { class: 'sim-traffic', role: 'group', 'aria-labelledby': 'sim-traffic-h' });
  box.appendChild(el(doc, 'h4', { id: 'sim-traffic-h' }, ['Traffic']));
  const on = el(doc, 'button', { type: 'button', id: 'sim-traffic', class: 'mini', 'aria-pressed': t.on ? 'true' : 'false', title: 'Show the traffic the model implies as moving dots in both views' }, [t.on ? 'Traffic animation: on' : 'Traffic animation: off']);
  on.addEventListener('click', () => act.trafficToggle());
  const pause = el(doc, 'button', { type: 'button', id: 'sim-traffic-pause', class: 'mini', 'aria-pressed': t.paused ? 'true' : 'false', title: 'Stop the dots where they are, or let them move again' }, [t.paused ? 'Resume' : 'Pause']) as HTMLButtonElement;
  pause.disabled = !t.on || t.reduce;
  pause.addEventListener('click', () => act.trafficPause());
  box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [on, pause]));
  if (t.reduce && t.on) box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Reduced motion is on: arrows show the direction instead of moving dots.']));
  const data = t.data;
  if (!data) return box;
  const flows = data.state.flows;
  const demands = flows.filter((f) => f.kind === 'demand');
  const control = flows.filter((f) => f.kind === 'control');
  if (data.changes.length) {
    box.appendChild(el(doc, 'h5', {}, ['Changed by this step']));
    const ul = el(doc, 'ul', { class: 'sim-list traffic-changes' });
    for (const c of data.changes) {
      const [sym, word] = CHANGE[c.kind];
      ul.appendChild(el(doc, 'li', { class: 'tc-' + c.kind }, [el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [sym + ' ']), word]), ' ' + c.text]));
    }
    box.appendChild(ul);
  }
  box.appendChild(el(doc, 'h5', {}, [`Demands (${new Set(demands.map((f) => f.of)).size})`]));
  if (!demands.length) box.appendChild(el(doc, 'p', { class: 'muted small' }, ['The model has no traffic demands (its demands section). Add some to see traffic between sites; control traffic is shown either way.']));
  else {
    const ul = el(doc, 'ul', { class: 'sim-list traffic-flows' });
    for (const f of demands) ul.appendChild(flowItem(doc, f));
    box.appendChild(ul);
  }
  const det = el(doc, 'details', { class: 'traffic-control' });
  det.appendChild(el(doc, 'summary', {}, [`Control traffic (${control.length} flows of ${new Set(control.map((f) => f.of)).size} relations)`]));
  const ul = el(doc, 'ul', { class: 'sim-list' });
  for (const f of control) ul.appendChild(el(doc, 'li', {}, [el(doc, 'span', { class: 'sim-state' }, [f.what]), ' ' + f.label + (f.physical.length ? '' : ' (no cables known: the logical view only)')]));
  det.appendChild(ul);
  box.appendChild(det);
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      `Dots: demands larger, control traffic smaller; more dots for more bandwidth. At most ${MAX_DOTS} move at once (demands first). Equal-cost paths share a demand equally (an approximation).`,
    ]),
  );
  return box;
}

function flowItem(doc: Document, f: Flow): HTMLElement {
  const lost = f.state === 'lost';
  return el(doc, 'li', { class: lost ? 'sim-down' : 'sim-up', 'data-flow': f.id }, [
    el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [lost ? '✕ ' : '→ ']), lost ? 'Lost' : 'Delivered']),
    ' ',
    el(doc, 'strong', {}, [f.label]),
    el(doc, 'span', { class: 'sim-why' }, [' — ' + f.pathText]),
    f.back ? el(doc, 'span', { class: 'traffic-back' + (f.back.asymmetric ? ' asym' : '') }, [f.back.asymmetric ? ` · Asymmetric: the way back is ${f.back.devices.join(' → ')}` : ' · Returns the same way']) : null,
  ]);
}

/** The saved scenarios: name, steps, Play and Delete. */
function scenarioList(doc: Document, model: Model, act: SimPanelActions): HTMLElement {
  const box = el(doc, 'div', { class: 'sim-scenarios' });
  box.appendChild(el(doc, 'h4', {}, [`Saved scenarios (${model.scenarios.length})`]));
  if (!model.scenarios.length) {
    box.appendChild(el(doc, 'p', { class: 'muted small' }, ['None yet. A scenario you play can be saved in the model (in its scenarios section) for design reviews to replay.']));
    return box;
  }
  const ul = el(doc, 'ul', { class: 'sim-list sim-saved' });
  for (const sc of model.scenarios) ul.appendChild(scenarioItem(doc, model, sc, act));
  box.appendChild(ul);
  return box;
}

function scenarioItem(doc: Document, model: Model, sc: Scenario, act: SimPanelActions): HTMLElement {
  const bad = scenarioProblems(model, sc);
  const play = el(doc, 'button', { type: 'button', class: 'mini primary', 'data-sim-play': sc.id, 'aria-label': `Play ${sc.label}` }, ['Play']);
  play.addEventListener('click', () => act.play(sc.id));
  const del = el(doc, 'button', { type: 'button', class: 'mini', 'data-sim-delete': sc.id, 'aria-label': `Delete ${sc.label}`, title: 'Delete the scenario from the model (asks first; can be undone)' }, ['Delete']);
  del.addEventListener('click', () => act.remove(sc.id));
  return el(doc, 'li', {}, [
    el(doc, 'span', { class: 'sim-sc-name' }, [sc.label]),
    el(doc, 'span', { class: 'muted small' }, [` · ${sc.steps.length} step${sc.steps.length === 1 ? '' : 's'}`]),
    bad.length ? el(doc, 'span', { class: 'sim-problem small' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [' ⚠ ']), `${bad.length} can’t be played`]) : null,
    sc.description ? el(doc, 'span', { class: 'sim-why small sim-desc' }, [sc.description]) : null,
    el(doc, 'span', { class: 'sim-sc-act' }, [play, ' ', del]),
  ]);
}

/** What changed since the step before. */
function diffSection(doc: Document, model: Model, d: StepDiff): HTMLElement {
  const box = el(doc, 'div', { class: 'sim-diff' });
  box.appendChild(el(doc, 'h4', {}, ['Changed by this step']));
  if (diffEmpty(d)) {
    box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Nothing changed: the state is the same as after the step before.']));
    return box;
  }
  const ul = el(doc, 'ul', { class: 'sim-list' });
  const row = (cls: string, sym: string, word: string, refs: string[]): void => {
    if (!refs.length) return;
    const li = el(doc, 'li', { class: cls }, [el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [sym + ' ']), `${word} (${refs.length})`]), ' ']);
    refs.forEach((r, i) => {
      if (i) li.appendChild(doc.createTextNode(', '));
      li.appendChild(ref(doc, model, r));
    });
    ul.appendChild(li);
  };
  row('sim-down', '✕', 'Now down', d.down);
  row('sim-degraded', '◐', 'Now degraded', d.degraded);
  row('sim-up', '✓', 'Recovered', d.recovered);
  const pairs = (cls: string, sym: string, word: string, list: Array<{ from: string; to: string; partial?: boolean }>): void => {
    if (!list.length) return;
    const shown = list.slice(0, 12).map((p) => `${p.from} → ${p.to}${p.partial ? ' (in part)' : ''}`);
    ul.appendChild(el(doc, 'li', { class: cls }, [el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [sym + ' ']), `${word} (${list.length})`]), ' ' + shown.join(', ') + (list.length > shown.length ? ` and ${list.length - shown.length} more` : '')]));
  };
  pairs('sim-down', '✕', 'Reachability lost', d.lost);
  pairs('sim-up', '✓', 'Reachability regained', d.regained);
  box.appendChild(ul);
  return box;
}

/** What a step takes down or degrades, per kind, and the device pairs that lose reachability. */
function results(doc: Document, model: Model, v: StepView): HTMLElement {
  const box = el(doc, 'div', { class: 'sim-results' });
  const s = v.summary;
  const rows: Array<[string, Affected[]]> = [
    ['Relations', s.relations],
    ['Tunnels', s.tunnels],
    ['Networks', s.networks],
    ['Static routes', s.routes],
    ['Devices', s.devices],
    ['Cables', s.links],
  ];
  box.appendChild(el(doc, 'h4', {}, ['State at this step']));
  const tbl = el(doc, 'table', { class: 'sim-counts' });
  tbl.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Affected objects per kind']));
  for (const [label, list] of rows) tbl.appendChild(el(doc, 'tr', {}, [el(doc, 'th', { scope: 'row' }, [label]), el(doc, 'td', {}, [countText(list) || 'unaffected'])]));
  const lostAll = v.lost.pairs.filter((p) => !p.partial).length;
  const lostPart = v.lost.pairs.length - lostAll;
  tbl.appendChild(el(doc, 'tr', {}, [el(doc, 'th', { scope: 'row' }, ['Device pairs']), el(doc, 'td', {}, [lostAll || lostPart ? `${lostAll} lose reachability${lostPart ? `, ${lostPart} in part` : ''}` : 'all still reach each other'])]));
  box.appendChild(tbl);
  for (const [label, list] of rows) {
    if (!list.length) continue;
    box.appendChild(el(doc, 'h4', {}, [`${label} (${list.length})`]));
    const l = el(doc, 'ul', { class: 'sim-list' });
    for (const a of list) {
      const [sym, word] = STATE[a.state] || ['', a.state];
      l.appendChild(el(doc, 'li', { class: 'sim-' + a.state }, [el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [sym + ' ']), word]), ' ', ref(doc, model, a.ref), a.why ? el(doc, 'span', { class: 'sim-why' }, [' — ' + a.why]) : null]));
    }
    box.appendChild(l);
  }
  box.appendChild(el(doc, 'h4', {}, [`Reachability (${v.lost.pairs.length})`]));
  if (v.lost.pairs.length) {
    const l = el(doc, 'ul', { class: 'sim-list' });
    for (const p of v.lost.pairs.slice(0, PAIRS_SHOWN)) l.appendChild(pairItem(doc, p));
    box.appendChild(l);
    if (v.lost.pairs.length > PAIRS_SHOWN) box.appendChild(el(doc, 'p', { class: 'muted small' }, [`… and ${v.lost.pairs.length - PAIRS_SHOWN} more.`]));
  } else box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Every device pair that reached each other still does.']));
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      `Checked by tracing between every two of ${v.lost.checked} devices with an address${v.lost.total > v.lost.checked ? ` (the first ${v.lost.checked} of ${v.lost.total} by id)` : ''}; pairs with a failed device are not counted. Trace a path (Analysis tab) to see the way traffic takes in the simulated state.`,
    ]),
  );
  box.appendChild(
    el(doc, 'p', { class: 'trace-key small' }, [
      'In the diagram: ',
      el(doc, 'span', { class: 'tk tk-down' }, ['dotted, faded']),
      ' down; ',
      el(doc, 'span', { class: 'tk tk-deg' }, ['dash-dot']),
      ' degraded (a LAG with members down, a redundancy group failing over, a floating route taking over).',
    ]),
  );
  return box;
}

function pairItem(doc: Document, p: LostPair): HTMLElement {
  return el(doc, 'li', { class: p.partial ? 'sim-degraded' : 'sim-down' }, [
    el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [p.partial ? '◐ ' : '✕ ']), p.partial ? 'In part' : 'Lost']),
    ' ',
    el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + p.from }, [p.from]),
    ' → ',
    el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + p.to }, [p.to]),
    el(doc, 'span', { class: 'sim-why' }, [' — ' + p.detail]),
  ]);
}

/** What the simulation approximates, said where its results are. */
function approximations(doc: Document): HTMLElement {
  return el(doc, 'details', { class: 'sim-approx' }, [
    el(doc, 'summary', {}, ['What the simulation approximates']),
    el(doc, 'ul', { class: 'small' }, [
      el(doc, 'li', {}, ['Routing is computed from the model (static routes, connected networks, the relations of enabled protocols), not from real routing tables; equal-cost paths are all followed.']),
      el(doc, 'li', {}, ['No spanning tree, no protocol timers or convergence: a failure takes effect at once.']),
      el(doc, 'li', {}, ['No ACLs, NAT or QoS.']),
      el(doc, 'li', {}, ['Results are no more precise than the model: what it doesn’t describe is not simulated.']),
    ]),
  ]);
}

/** The ref a step's target selects (re-exported for the app). */
export { targetRef };

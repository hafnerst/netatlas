/**
 * The Analyze overview (Analyze → Overview): where an investigation starts,
 * not another analysis. It reuses what is known and computes nothing on
 * opening.
 *
 *   overviewRequest   the starting questions (one per task, with what it
 *                     answers), starting points from the selection, and the
 *                     component being explored (a subject chosen on purpose:
 *                     selecting another object does not replace it);
 *   overviewResults   what is known about this model — saved requirements
 *                     and whether (and how) they were evaluated, the
 *                     consistency findings, invalid model input, results
 *                     outdated by an edit, the interfaces whose addresses
 *                     are assigned at run time (questions about them need a
 *                     snapshot) — each count with its context and state
 *                     (not evaluated is never passed); the component's
 *                     dependencies (Depends on, Used by, Failure affects);
 *                     the recent and pinned results;
 *   history entries   a bounded, session-local record of the questions
 *                     answered: the question, its context and scope, the
 *                     model's fingerprint, when it was computed (or the
 *                     snapshot's time), the selection, and whether it is
 *                     outdated or evidence-limited. Reopened, a result is
 *                     shown as it was computed; a pinned result does not keep
 *                     a simulation's records alive.
 *
 * Built from elements and text nodes only.
 */
import { AnalysisContext, contextText } from '../analysis/result';
import { DEP_CHANGE_TEXT, DEP_LABEL, DepChange, ServiceDependency } from '../analysis/dependencies';
import { WhatIf, EXP_CHANGE_TEXT } from '../analysis/whatif';
import { Model, deviceInterfaces } from '../model/types';
import { ANALYZE_TASKS, AnalyzeTask } from './workspace';
import { clockText } from './analysis-ui';
import { el } from './dom';
import { EvidenceAction, EvidenceView } from './evidence';

/** At most this many recent results are kept (unpinned), and this many pinned. */
export const HISTORY_RECENT = 12;
export const HISTORY_PINNED = 8;

/** One answered question of this session (never saved with the model). */
export interface HistoryEntry {
  id: number;
  task: AnalyzeTask;
  /** the task's mode (Resilience, Design review) */
  mode: string;
  /** the question in words ("laptop → nas · tcp/445") */
  question: string;
  context: AnalysisContext;
  /** a hypothetical failure condition or a recorded exchange on top of the context */
  layers: string[];
  /** the model's fingerprint when it was computed */
  fingerprint: string;
  /** the model it was computed on (outdated when the current model differs) */
  model: Model;
  /** when it was computed (the page's clock) */
  at: number;
  /** the item selected in it (kept when it is left) */
  sel: string;
  evidenceLimited: boolean;
  pinned: boolean;
  /** the result itself, as its task keeps it (frozen: never recomputed) */
  data: unknown;
}

/** Keep the history within its bounds: every pinned entry up to HISTORY_PINNED, the newest unpinned up to HISTORY_RECENT. */
export function boundHistory(list: HistoryEntry[]): HistoryEntry[] {
  const pinned = list.filter((x) => x.pinned).slice(0, HISTORY_PINNED);
  const recent = list.filter((x) => !x.pinned).slice(0, HISTORY_RECENT);
  return list.filter((x) => pinned.indexOf(x) >= 0 || recent.indexOf(x) >= 0);
}

/** What is known about the model, for the overview (counts from results already computed; nothing computed here). */
export interface OverviewFacts {
  requirements: number;
  /** the evaluation on screen: its counts, outdated, its context ('' none) */
  evaluated: { counts: { [v: string]: number }; outdated: boolean; context: string } | null;
  findings: number;
  input: number;
  /** checks the model switches off */
  checksOff: number;
  /** the results kept that an edit made outdated */
  outdated: Array<{ id: number; question: string; task: string }>;
  /** the interfaces whose addresses are assigned at run time (DHCP, SLAAC, DHCPv6) */
  runtimeAddressed: string[];
  /** a simulation runs (a snapshot can resolve run-time addresses) */
  simulation: boolean;
}

/** The interfaces of a model whose addresses are assigned at run time. */
export function runtimeAddressed(model: Model): string[] {
  const out: string[] = [];
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      const v6 = (i as { ipv6?: { method?: string } }).ipv6;
      if (i.dhcp || (v6 && v6.method && v6.method !== 'static')) out.push(`${d.id}:${i.id}`);
    }
  }
  return out;
}

export interface OverviewActions {
  task(t: AnalyzeTask): void;
  /** a starting point of the selection */
  start(kind: string, ref: string): void;
  explore(ref: string | null): void;
  impact(): void;
  history(kind: 'open' | 'pin' | 'unpin' | 'export' | 'forget', id: number): void;
}

/** The overview's question (left): the starting questions, the selection's starting points, the component explored. */
export function overviewRequest(doc: Document, model: Model, sel: { ref: string; name: string; kind: string } | null, explore: { ref: string; name: string } | null, act: OverviewActions): HTMLElement {
  const box = el(doc, 'div', { class: 'an-overview' });
  box.appendChild(el(doc, 'p', { class: 'small' }, ['Choose a question. Each answer says what it was computed on, what it covers and what limits it; nothing is computed until you ask.']));
  const ul = el(doc, 'ul', { class: 'an-starts', 'aria-label': 'Starting questions' });
  for (const t of ANALYZE_TASKS.filter((x) => x.id !== 'overview')) {
    const b = el(doc, 'button', { type: 'button', class: 'an-start', 'data-an-start-task': t.id }, [el(doc, 'strong', {}, [t.label]), el(doc, 'span', { class: 'small muted' }, [t.answers])]);
    b.addEventListener('click', () => act.task(t.id));
    ul.appendChild(el(doc, 'li', {}, [b]));
  }
  box.appendChild(ul);
  // the selection's starting points: only what applies to it
  const sec = el(doc, 'section', { class: 'an-ov-sel', 'aria-labelledby': 'an-ov-sel-h' }, [el(doc, 'h3', { id: 'an-ov-sel-h' }, ['From the selection'])]);
  if (!sel) sec.appendChild(el(doc, 'p', { class: 'small muted' }, ['Select an object in the diagram for questions about it.']));
  else {
    sec.appendChild(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [sel.name]), el(doc, 'span', { class: 'muted' }, [` (${sel.kind})`])]));
    const acts = el(doc, 'div', { class: 'tf-actions', role: 'group', 'aria-label': `Questions about ${sel.name}` });
    const add = (kind: string, label: string, why: string): void => {
      const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-an-start': kind, title: why }, [label]);
      b.addEventListener('click', () => act.start(kind, sel.ref));
      acts.appendChild(b);
    };
    if (sel.kind === 'device' || sel.kind === 'interface') {
      add('diagnose', 'Diagnose its communication', 'Its client application to its peer (or the device as the source), checked in Communication');
      add('from', 'Check communication from it', 'Communication with it as the source; you give the destination');
      add('explore', 'Explore its dependencies', 'What it depends on, what uses it, what its failure affects');
      add('whatif', 'What if it fails', 'Resilience → Failure scenario with it as the condition, analysed now');
    }
    if (sel.kind === 'relation') add('diagnose', 'Diagnose this relation', 'The communication between its two ends, in Communication');
    if (sel.kind === 'cable') add('whatif', 'What if it fails', 'Resilience → Failure scenario with it as the condition, analysed now');
    if (sel.kind === 'network') add('addressing', 'Its addressing', 'Addressing with this network selected: its members, allocation and unallocated ranges');
    sec.appendChild(acts);
  }
  box.appendChild(sec);
  if (explore) {
    const ex = el(doc, 'p', { class: 'small', id: 'an-ov-explore' }, ['Exploring: ', el(doc, 'strong', {}, [explore.name]), ' ']);
    const stop = el(doc, 'button', { type: 'button', class: 'mini', 'data-an-explore-clear': '' }, ['Stop exploring']);
    stop.addEventListener('click', () => act.explore(null));
    ex.appendChild(stop);
    box.appendChild(ex);
  }
  return box;
}

/** A dependency of the explored component, as a row: its kind, what it is, and Evidence. */
function depItem(doc: Document, key: string, sel: string, d: ServiceDependency, change?: DepChange): HTMLElement {
  const on = key === sel;
  return el(doc, 'li', { class: 'an-pickrow' + (on ? ' an-selected' : ''), 'data-an-item': key, tabindex: '0', 'data-dep-kind': d.kind, ...(change ? { 'data-change': change.change } : {}) }, [
    el(doc, 'span', { class: 'muted' }, [DEP_LABEL[d.kind] + ': ']),
    d.text,
    change ? el(doc, 'span', { class: 'muted small' }, [` — ${DEP_CHANGE_TEXT[change.change]}`]) : null,
    ' ',
    el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': on ? 'true' : 'false', 'aria-controls': 'an-detail' }, ['Evidence']),
  ]);
}

/** The component's dependencies (see explorerEvidence). */
export interface Explorer {
  ref: string;
  name: string;
  /** the dependencies it has, and those of others it provides (from serviceDependencies) */
  dependsOn: ServiceDependency[];
  usedBy: ServiceDependency[];
  /** virtual machines and containers on it, and the host it runs on */
  guests: string[];
  host: string;
  /** its failure, once evaluated (never on its own) */
  impact: { model: Model; result: WhatIf } | null;
}

/** The overview's results (bottom): what is known; the component explored; the recent and pinned results. */
export function overviewResults(doc: Document, facts: OverviewFacts, ex: Explorer | null, history: HistoryEntry[], current: { model: Model; key: string }, sel: string, act: OverviewActions): HTMLElement {
  const box = el(doc, 'div', { class: 'an-ov-results' });
  // ---- what is known (each count says its context and state)
  const known = el(doc, 'section', { class: 'an-res-sec', 'aria-labelledby': 'an-known-h', id: 'an-known' }, [el(doc, 'h3', { id: 'an-known-h' }, ['What is known about this model'])]);
  const ul = el(doc, 'ul', { class: 'an-known small' });
  const line = (k: string, kids: Array<Node | string>, task?: AnalyzeTask): void => {
    const li = el(doc, 'li', { 'data-known': k }, kids);
    if (task) {
      const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-an-start-task': task }, ['Open']);
      b.addEventListener('click', () => act.task(task));
      li.appendChild(doc.createTextNode(' '));
      li.appendChild(b);
    }
    ul.appendChild(li);
  };
  if (!facts.requirements) line('requirements', ['No requirements are saved with the model.'], 'review');
  else if (!facts.evaluated) line('requirements', [el(doc, 'strong', {}, [`${facts.requirements} requirement${facts.requirements === 1 ? '' : 's'}`]), ' saved, not evaluated in this session (not evaluated is not satisfied).'], 'review');
  else {
    const c = facts.evaluated.counts;
    const parts = ['satisfied', 'violated', 'indeterminate', 'unsupported'].filter((k) => c[k]).map((k) => `${c[k]} ${k === 'violated' ? 'not satisfied' : k}`);
    line('requirements', [el(doc, 'strong', {}, [`${facts.requirements} requirement${facts.requirements === 1 ? '' : 's'}`]), `: ${parts.join(', ') || 'none evaluated'} — ${facts.evaluated.context}${facts.evaluated.outdated ? ' (outdated: the model changed since)' : ''}.`], 'review');
  }
  line('findings', [el(doc, 'strong', {}, [`${facts.findings} consistency finding${facts.findings === 1 ? '' : 's'}`]), ` — configured model, checked with every edit${facts.checksOff ? `; ${facts.checksOff} check${facts.checksOff === 1 ? '' : 's'} switched off by the model` : ''}.`], 'review');
  if (facts.input) line('input', [el(doc, 'strong', {}, [`${facts.input} invalid model input`]), ' — what depends on it is not analysed as intended.'], 'review');
  if (facts.outdated.length) line('outdated', [el(doc, 'strong', {}, [`${facts.outdated.length} result${facts.outdated.length === 1 ? '' : 's'} outdated`]), ` by an edit since: ${facts.outdated.map((o) => `${o.task}: ${o.question}`).slice(0, 4).join('; ')}${facts.outdated.length > 4 ? ' …' : ''} — Refresh computes them again.`]);
  if (facts.runtimeAddressed.length) line('runtime', [el(doc, 'strong', {}, [`${facts.runtimeAddressed.length} interface${facts.runtimeAddressed.length === 1 ? '' : 's'} addressed at run time`]), ` (DHCP, SLAAC, DHCPv6: ${facts.runtimeAddressed.slice(0, 5).join(', ')}${facts.runtimeAddressed.length > 5 ? ' …' : ''}): questions about them are indeterminate in the configured model; ${facts.simulation ? 'a snapshot of the running simulation can resolve them (Next computation: Simulation snapshot).' : 'a simulation snapshot can resolve them.'}`]);
  known.appendChild(ul);
  known.appendChild(el(doc, 'p', { class: 'small muted' }, ['No overall score: each answer belongs to its question, its context and its coverage.']));
  box.appendChild(known);
  // ---- the component explored
  if (ex) box.appendChild(explorerSection(doc, ex, current.model, sel, act));
  // ---- recent and pinned results
  const hs = el(doc, 'section', { class: 'an-res-sec', 'aria-labelledby': 'an-hist-h', id: 'an-history' }, [el(doc, 'h3', { id: 'an-hist-h' }, ['Recent and pinned results'])]);
  if (!history.length) hs.appendChild(el(doc, 'p', { class: 'small muted' }, [`None yet. The last ${HISTORY_RECENT} results of this session are kept here, and up to ${HISTORY_PINNED} pinned ones; nothing is saved with the model.`]));
  else {
    const hl = el(doc, 'ul', { class: 'an-hist small' });
    const order = history.filter((h) => h.pinned).concat(history.filter((h) => !h.pinned));
    for (const h of order) {
      const outdated = h.model !== current.model && h.fingerprint !== current.key;
      const status = [outdated ? 'outdated' : '', h.evidenceLimited ? 'evidence-limited' : ''].filter((x) => !!x);
      const key = 'hist:' + h.id;
      const on = key === sel;
      const li = el(doc, 'li', { class: 'an-pickrow' + (on ? ' an-selected' : ''), 'data-hist': String(h.id), 'data-an-item': key, tabindex: '0', ...(h.pinned ? { 'data-pinned': '' } : {}), ...(outdated ? { 'data-outdated': '' } : {}) }, [
        h.pinned ? el(doc, 'span', { 'aria-label': 'Pinned', title: 'Pinned' }, ['📌 ']) : null,
        el(doc, 'strong', {}, [taskLabel(h.task, h.mode) + ': ']),
        h.question,
        el(doc, 'div', { class: 'muted' }, [`${contextText(h.context)}${h.layers.length ? ' · ' + h.layers.join(' · ') : ''} · computed ${clockText(h.at)}${status.length ? ' · ' + status.join(', ') : ''}`]),
      ]);
      const btn = (k: 'open' | 'pin' | 'unpin' | 'export' | 'forget', label: string, title: string): void => {
        const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-hist-act': k, 'data-hist-id': String(h.id), title }, [label]);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          act.history(k, h.id);
        });
        li.appendChild(b);
      };
      btn('open', 'Reopen', 'Show this result again, as it was computed (marked outdated when the model changed since)');
      btn(h.pinned ? 'unpin' : 'pin', h.pinned ? 'Unpin' : 'Pin', h.pinned ? 'Let it go with the recent results' : `Keep it (up to ${HISTORY_PINNED} pinned); its simulation records are not kept alive by it`);
      btn('export', 'Save record', 'Save the question, its context, its fingerprint and its answer as a text file');
      hl.appendChild(li);
    }
    hs.appendChild(hl);
    hs.appendChild(el(doc, 'p', { class: 'small muted' }, [`Kept for this session only: the last ${HISTORY_RECENT} results and up to ${HISTORY_PINNED} pinned; loading another model clears them.`]));
  }
  box.appendChild(hs);
  return box;
}

export function taskLabel(t: AnalyzeTask, mode: string): string {
  const base = (ANALYZE_TASKS.find((x) => x.id === t) || { label: t }).label;
  const m: { [k: string]: string } = { single: 'single-component failures', scenario: 'failure scenario', capacity: 'capacity', findings: 'findings', requirements: 'requirements' };
  return m[mode] ? `${base} (${m[mode]})` : base;
}

/** The explored component's section: Depends on, Used by, Failure affects (evaluated on request). */
function explorerSection(doc: Document, ex: Explorer, current: Model, sel: string, act: OverviewActions): HTMLElement {
  const sec = el(doc, 'section', { class: 'an-res-sec', 'aria-labelledby': 'an-ex-h', id: 'an-explore' }, [el(doc, 'h3', { id: 'an-ex-h' }, [`Dependencies of ${ex.name}`])]);
  sec.appendChild(el(doc, 'p', { class: 'small muted' }, ['What the model configures (application peers, MQTT brokers, DNS, DHCP, timing sources, syslog, AAA; virtualization hosts): not inferred production dependencies, no business importance.']));
  const part = (title: string, id: string, items: HTMLElement[], none: string): void => {
    sec.appendChild(el(doc, 'h4', { id }, [`${title} (${items.length})`]));
    sec.appendChild(items.length ? el(doc, 'ul', { class: 'small an-deps', 'aria-labelledby': id }, items) : el(doc, 'p', { class: 'small muted' }, [none]));
  };
  const on = ex.dependsOn.map((d) => depItem(doc, 'dep-on:' + d.key, sel, d));
  if (ex.host) on.push(el(doc, 'li', { 'data-dep-kind': 'host' }, [el(doc, 'span', { class: 'muted' }, ['Host: ']), `runs on ${ex.host}`, ' ', el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + ex.host }, [ex.host])]));
  part('Depends on', 'an-ex-on', on, 'It configures no dependency of its own.');
  const by = ex.usedBy.map((d) => depItem(doc, 'dep-by:' + d.key, sel, d));
  for (const g of ex.guests) by.push(el(doc, 'li', { 'data-dep-kind': 'guest' }, [el(doc, 'span', { class: 'muted' }, ['Guest: ']), el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + g }, [g]), ' runs on it']));
  part('Used by', 'an-ex-by', by, 'Nothing configured depends on it.');
  sec.appendChild(el(doc, 'h4', { id: 'an-ex-fail' }, ['Failure affects']));
  const imp = ex.impact;
  if (!imp) {
    const b = el(doc, 'button', { type: 'button', class: 'mini', id: 'an-ex-impact', title: 'Evaluate its failure now (Resilience’s failure analysis, against the same baseline)' }, ['Evaluate its failure']);
    b.addEventListener('click', () => act.impact());
    sec.appendChild(el(doc, 'p', { class: 'small' }, ['Not evaluated yet. ', b]));
  } else {
    const w = imp.result;
    const outdated = imp.model !== current;
    const lost = w.deps.filter((c) => c.change === 'unavailable' || c.change === 'degraded' || c.change === 'indeterminate');
    const reqs = w.expectations.filter((x) => x.change !== 'unchanged' && x.change !== 'already-violated');
    sec.appendChild(el(doc, 'p', { class: 'small', id: 'an-ex-impact-sum' }, [`Hypothetical failure of ${ex.name}${outdated ? ' (outdated: the model changed since)' : ''}: ${w.structural ? w.structural.isolated.reduce((n, g) => n + g.length, 0) : 0} device(s) disconnected, ${w.deps.filter((c) => c.change === 'unavailable').length} configured dependenc${w.deps.filter((c) => c.change === 'unavailable').length === 1 ? 'y' : 'ies'} unavailable, ${w.expectations.filter((x) => x.change === 'availability-lost' || x.change === 'isolation-violated').length} requirement(s) no longer satisfied.`]));
    const items = lost.map((c) => depItem(doc, 'dep-fail:' + c.dep.key, sel, c.dep, c)).concat(reqs.map((x) => el(doc, 'li', { 'data-exp-change': x.change }, [el(doc, 'span', { class: 'muted' }, ['Requirement: ']), `${x.after.name} — ${EXP_CHANGE_TEXT[x.change]}`])));
    if (items.length) sec.appendChild(el(doc, 'ul', { class: 'small an-deps' }, items));
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-an-start': 'whatif-open' }, ['Open in Resilience → Failure scenario']);
    b.addEventListener('click', () => act.start('whatif', ex.ref));
    sec.appendChild(el(doc, 'p', { class: 'small' }, [b]));
  }
  return sec;
}

/** The evidence of an item of the overview: a dependency of the explored component, a history entry. */
export function overviewEvidence(doc: Document, ex: Explorer | null, history: HistoryEntry[], key: string, current: { model: Model; key: string }): EvidenceView | null {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === 'hist') {
    const h = history.find((x) => String(x.id) === id);
    if (!h) return null;
    const outdated = h.model !== current.model && h.fingerprint !== current.key;
    return {
      kind: 'Recent result',
      title: `${taskLabel(h.task, h.mode)}: ${h.question}`,
      context: `${contextText(h.context)}${h.layers.length ? ' · ' + h.layers.join(' · ') : ''} · computed ${clockText(h.at)}`,
      flags: [outdated ? 'Outdated: the model changed after this result' : '', h.evidenceLimited ? 'Evidence-limited: some records are no longer kept' : ''].filter((x) => !!x),
      explanation: [el(doc, 'p', { class: 'small' }, [`Model fingerprint ${h.fingerprint || '—'}. Reopening shows it as it was computed; Refresh there computes it again. ${h.pinned ? 'Pinned' : 'Recent'}: a session record, not saved with the model; it does not keep a simulation’s records available.`])],
      evidence: [],
      objects: [],
      next: [
        { id: 'hist-open', label: 'Reopen', ref: id },
        { id: h.pinned ? 'hist-unpin' : 'hist-pin', label: h.pinned ? 'Unpin' : 'Pin', ref: id },
        { id: 'hist-export', label: 'Save record', ref: id },
      ],
    };
  }
  if (!ex || (kind !== 'dep-on' && kind !== 'dep-by' && kind !== 'dep-fail')) return null;
  const d = ex.dependsOn.concat(ex.usedBy).find((x) => x.key === id) || (ex.impact ? (ex.impact.result.deps.find((c) => c.dep.key === id) || { dep: undefined }).dep : undefined);
  if (!d) return null;
  const change = kind === 'dep-fail' && ex.impact ? ex.impact.result.deps.find((c) => c.dep.key === id) : undefined;
  const next: EvidenceAction[] = [];
  for (const o of d.options) if (o.request) next.push({ id: 'communication', label: `Check ${o.text} in Communication`, ref: JSON.stringify(o.request), why: 'Its communication, checked in Communication' });
  if (d.kind === 'timing') next.push({ id: 'focus-timing', label: 'Focus on its timing context', ref: d.consumer });
  if (d.kind === 'application' || d.kind === 'mqtt' || d.kind === 'dns') next.push({ id: 'focus-app', label: 'Focus on its dependencies', ref: d.consumer });
  next.push({ id: 'whatif-provider', label: 'What if its provider fails', ref: (d.options.find((o) => !!o.provider) || { provider: '' }).provider || '', disabled: d.options.some((o) => !!o.provider) ? '' : 'No provider in the model' });
  const ev: Node[] = [el(doc, 'dl', { class: 'trace-ends small' }, [el(doc, 'dt', {}, ['Consumer']), el(doc, 'dd', {}, [d.consumerRef.replace(/^[a-z]+:/, '')]), el(doc, 'dt', {}, ['Options']), el(doc, 'dd', {}, [d.options.map((o) => o.text).join('; ') || '—']), el(doc, 'dt', {}, ['When unavailable']), el(doc, 'dd', {}, [d.consequence])])];
  if (change) ev.push(el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [DEP_CHANGE_TEXT[change.change] + ': ']), change.text]));
  if (d.kind === 'timing') ev.push(el(doc, 'p', { class: 'small muted' }, ['Timing: whether a compatible source path exists in the configured model; the protocol state is observed only in a simulation, and no accuracy is claimed.']));
  return {
    kind: 'Dependency',
    title: d.text,
    context: change ? `Configured model · hypothetical failure of ${ex.name}` : 'Configured model · configured dependencies',
    explanation: [el(doc, 'p', { class: 'small' }, [`${DEP_LABEL[d.kind]}: ${kind === 'dep-on' ? `${ex.name} depends on it` : kind === 'dep-by' ? `it depends on ${ex.name}` : `affected when ${ex.name} fails`}. Configured, not inferred.`])],
    evidence: ev,
    objects: [{ ref: d.consumerRef, label: d.consumerRef.replace(/^[a-z]+:/, '') }].concat(d.options.filter((o) => !!o.provider).map((o) => ({ ref: 'device:' + o.provider, label: o.provider as string }))),
    next,
  };
}

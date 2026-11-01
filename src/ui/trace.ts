/**
 * Communication (Analyze → Communication, T) in three parts: commRequest
 * (the question: searchable ends with how they bind, the service, Advanced
 * options), commResults (the answer once, the next steps, what is
 * established, the main blocker, the runtime observation, then the paths
 * and detailed evidence) and commEvidence (the selected layer, blocker,
 * path, hop or policy decision). Selectable items carry data-an-item;
 * selecting computes nothing. The runtime layer is a limitation of static
 * analysis, never a default selection. Elements and text nodes only.
 */
import { virtRefText } from '../analysis/trace-virtual';
import { Hop, HopWhy, Path, Trace, TraceRequest, encapText, endStatus, endText, outcomeLines, pathRefs, traceOutcome, traceText } from '../analysis/trace';
import { CommCheck, CommLayer, CommRequest, LAYER_LABEL, commText, parseCommEnd } from '../analysis/communication';
import { CommIdentity, Handoff, RunComparison } from '../analysis/comm-identity';
import { PathMtu, PathMtuResult } from '../analysis/mtu';
import { namedServices } from '../analysis/listeners';
import { deviceVrfs } from '../analysis/routing';
import { Verdict, exportFooter, exportHeader, verdictMark, verdictText } from '../analysis/result';
import { appProfile } from '../model/applications';
import { Model, deviceInterfaces } from '../model/types';
import { ChainLink, Diagnosis, DiagnosisState, LinkKind, diagnosisText } from '../analysis/diagnosis';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, limitsDetails, verdictLine } from './analysis-ui';
import { EvidenceAction, EvidenceView } from './evidence';

/** What the form holds (a session setting, never saved). VRF: 'auto' (the source interface's), '' (the default table) or a VRF name. */
export interface TraceForm {
  from: string;
  to: string;
  vrf: string;
  /** what is sent ("tcp/443", "udp/53", "icmp"; empty: from the applications, else not given) */
  service: string;
  /** '' (automatic: the ends', or the client application's), '4' or '6' */
  family: string;
  back: boolean;
}

export function newTraceForm(): TraceForm {
  return { from: '', to: '', vrf: 'auto', service: '', family: '', back: false };
}

/** A check on screen: the request, the communication check, its trace and (when asked for) the return trace. */
export interface TraceRun {
  req: TraceRequest;
  check: CommCheck;
  trace: Trace;
  back: Trace | null;
  /** the communication's identity (what the handoff, the comparison and a saved expectation carry on) */
  identity?: CommIdentity | null;
  /** the simulation handoff made from it */
  handoff?: Handoff | null;
  /** the static result beside a send of the simulation that carries it */
  compare?: RunComparison | null;
  /** the end-to-end path MTU of the evaluated paths */
  mtu?: PathMtu | null;
  /** the diagnosis: the static answer, with the recorded send once compared (frozen when made, never recomputed) */
  diagnosis?: Diagnosis | null;
}

/** The request a form makes. */
export function formRequest(f: TraceForm): CommRequest {
  const req: CommRequest = { from: f.from.trim() };
  if (f.to.trim()) req.to = f.to.trim();
  if (f.vrf !== 'auto') req.vrf = f.vrf;
  if (f.service.trim()) req.service = f.service.trim();
  if (f.family === '4' || f.family === '6') req.family = f.family === '4' ? 4 : 6;
  if (f.back) req.back = true;
  return req;
}

/** A request in words, for the history ("laptop → nas · tcp/445 · IPv4"). */
export function commQuestion(r: CommRequest): string {
  return `${r.from} → ${r.to || 'its configured peer'}${r.service ? ' · ' + r.service : ''}${r.family ? ' · IPv' + r.family : ''}${r.vrf !== undefined ? ' · ' + (r.vrf ? 'VRF ' + r.vrf : 'default table') : ''}${r.back ? ' · both directions' : ''}`;
}

/** Does a request ask what another asks (the same ends, VRF, service, family and direction)? */
export function sameRequest(a: CommRequest, b: CommRequest): boolean {
  const k = (r: CommRequest): string => JSON.stringify([r.from, r.to || '', r.vrf === undefined ? null : r.vrf, r.service || '', r.family || 0, !!r.back]);
  return k(a) === k(b);
}

export interface TracePanelActions extends ContextBarActions {
  input(field: 'from' | 'to' | 'vrf' | 'service' | 'family' | 'back', value: string | boolean): void;
  submit(): void;
  swap(): void;
  exit(): void;
  copy(): void;
  save(): void;
  /** prefill the simulation's action (never sends) */
  handoff(): void;
  /** compare the result with the simulation's matching run of it */
  compare(): void;
  /** keep it as a saved requirement (the Design review editor, prefilled) */
  saveExpectation(): void;
  /** prefill a send that tests the path MTU (never sends) */
  mtuTest(): void;
  /** keep it as an experiment (a send and its observation; nothing runs) */
  experiment(): void;
  /** take another of the end's addresses */
  pick(field: 'from' | 'to', value: string): void;
  /** go to a piece of evidence (an object, a rule, a layer, a message, an event): it selects or opens it, nothing else */
  goto(ref: string): void;
  /** take one of the choice's communications (Diagnose selected communication with several client applications) */
  choose(from: string, to: string): void;
  /** select an item of the results: its evidence on the right */
  select(key: string): void;
}

/** A diagnosis state in words, its mark, and the verdict colour it is shown in. */
export const DIAG_STATE: { [k in DiagnosisState]: { label: string; mark: string; tone: Verdict } } = {
  established: { label: 'Established', mark: '✓', tone: 'satisfied' },
  blocked: { label: 'Blocked', mark: '✕', tone: 'violated' },
  failed: { label: 'Not completed — cause not established', mark: '✕', tone: 'violated' },
  waiting: { label: 'Waiting', mark: '⧗', tone: 'indeterminate' },
  'in-progress': { label: 'In progress', mark: '…', tone: 'indeterminate' },
  recovered: { label: 'Recovered', mark: '↻', tone: 'satisfied' },
  partial: { label: 'Partial', mark: '◐', tone: 'partial' },
  cancelled: { label: 'Cancelled', mark: '–', tone: 'unsupported' },
  indeterminate: { label: 'Not established', mark: '?', tone: 'indeterminate' },
  unsupported: { label: 'Not supported', mark: '–', tone: 'unsupported' },
};

export const REL_LABEL: { [k in LinkKind]: string } = { cause: 'Cause', contributing: 'Contributing', prerequisite: 'Prerequisite', related: 'Related', coincidence: 'Coincidence', hypothesis: 'Not established' };

const relTone = (rel: LinkKind): Verdict => (rel === 'cause' ? 'violated' : rel === 'prerequisite' || rel === 'contributing' ? 'indeterminate' : rel === 'hypothesis' ? 'unsupported' : 'satisfied');

/** An Evidence button: it selects an item of the results (its evidence on the right). */
function pickButton(doc: Document, key: string, sel: string, label: string, aria?: string): HTMLElement {
  return el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': key === sel ? 'true' : 'false', 'aria-controls': 'an-detail', ...(aria ? { 'aria-label': aria } : {}) }, [label]);
}

/** One link of the evidence: what it is, from where, its text, its refs and — for a group — its messages. */
function chainItem(doc: Document, l: ChainLink, tag: 'li', pick?: { key: string; sel: string }): HTMLElement {
  const btn = (r: { ref: string; label: string }): HTMLElement => el(doc, 'button', { type: 'button', class: 'ref', 'data-diag-ref': r.ref, title: 'Go to ' + r.label }, [r.label]);
  const refs = l.refs.map(btn);
  const msgs = (l.messages || []).map(btn);
  const more = l.count !== undefined && l.messages && l.count > l.messages.length ? l.count - l.messages.length : 0;
  const li = el(doc, tag, { class: 'diag-link' + (pick && pick.key === pick.sel ? ' an-selected' : ''), 'data-rel': l.rel, 'data-source': l.source, ...(l.count !== undefined ? { 'data-count': String(l.count) } : {}) }, [
    el(doc, 'span', { class: 'diag-rel an-chip v-' + relTone(l.rel) }, [REL_LABEL[l.rel]]),
    ' ',
    el(doc, 'span', { class: 'muted' }, [l.source === 'static' ? 'Static · ' : 'Runtime · ']),
    l.text,
    ...(refs.length ? [el(doc, 'span', { class: 'diag-refs' }, refs.flatMap((b, k) => (k ? [' ', b] : [b])))] : []),
    ...(msgs.length ? [el(doc, 'span', { class: 'diag-refs diag-msgs', 'aria-label': `The ${l.count === 1 ? 'message' : 'messages'} it stands for` }, [`${l.count === 1 ? 'Message' : 'Messages'}: `, ...msgs.flatMap((b, k) => (k ? [' ', b] : [b])), more ? ` and ${more} more` : ''])] : []),
  ]);
  if (pick) li.appendChild(el(doc, 'span', {}, [' ', pickButton(doc, pick.key, pick.sel, 'Evidence', `Evidence: ${REL_LABEL[l.rel]}`)]));
  return li;
}

const OUTCOME_TEXT: { [k in NonNullable<Diagnosis['runtime']>['outcome']]: string } = { succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', mixed: 'mixed outcomes', none: 'nothing yet' };
const CAUSE_TEXT: { [k in NonNullable<Diagnosis['runtime']>['cause']]: string } = { established: 'established by the records', partly: 'established for some failures only', unknown: 'not established', 'n/a': 'nothing to explain' };

/** The labels of the next steps (the same in the results and in the evidence). */
export const NEXT_LABEL: { [k: string]: string } = {
  refresh: 'Refresh',
  handoff: 'Prepare modeled test',
  compare: 'Compare matching observation',
  'mtu-test': 'Prepare MTU test',
  'save-exp': 'Save as requirement…',
  experiment: 'Use in experiment…',
};

/** The ids the next steps' buttons keep (the keyboard and tests find them by it). */
const NEXT_ID: { [k: string]: string } = { handoff: 'trace-handoff', compare: 'trace-compare', 'mtu-test': 'trace-mtu-test', 'save-exp': 'trace-save-exp', experiment: 'trace-experiment' };

/**
 * The next steps of a result, in order: Refresh when it is outdated, the
 * objects a blocker names (the deciding rule first), the limiting interface
 * of the path MTU, then the actions that prefill or keep the question.
 * Each one says why it is unavailable now; none sends anything.
 */
export function commNext(run: TraceRun, view: TraceViewState): EvidenceAction[] {
  const d = run.diagnosis;
  const out: EvidenceAction[] = [];
  const why = (id: string): string | undefined => (d ? (d.next.find((x) => x.id === id) || { why: undefined }).why : undefined);
  if (view.bar.outdated) out.push({ id: 'refresh', label: 'Refresh', why: 'The model changed after this result' });
  if (d) for (const a of d.next) if (a.id === 'goto' && a.ref) out.push({ id: 'goto', label: a.label, why: a.why, ref: a.ref });
  const lim = run.mtu ? run.mtu.forward.concat(run.mtu.reverse).map((r) => r.limiting).find((x) => !!x && x.mtu === (run.mtu as PathMtu).mtu) : undefined;
  if (lim && lim.ref && !out.some((x) => x.ref === lim.ref)) out.push({ id: 'goto', label: 'Inspect limiting interface', why: `${lim.what}: ${lim.mtu} bytes sets the path MTU`, ref: lim.ref });
  const ho = run.handoff;
  if (ho && run.identity) {
    out.push({ id: 'handoff', label: NEXT_LABEL.handoff, why: why('handoff') || ho.text + ': prefilled, not sent', disabled: view.handoffBlocked });
    out.push({ id: 'compare', label: NEXT_LABEL.compare, why: why('compare') || 'The newest recorded run of exactly this communication', disabled: view.compareBlocked });
    if (run.mtu && run.mtu.payload) out.push({ id: 'mtu-test', label: NEXT_LABEL['mtu-test'], why: why('mtu-test') || 'A send one byte over the limit with Don’t fragment, prefilled: not sent', disabled: view.handoffBlocked });
  }
  if (run.identity && !run.check.error) {
    out.push({ id: 'save-exp', label: NEXT_LABEL['save-exp'], why: 'Keep this communication and its expected answer with the model (Design review → Requirements)', disabled: view.locked });
    if (ho && ho.kind === 'send') out.push({ id: 'experiment', label: NEXT_LABEL.experiment, why: 'Add an experiment that sends it and observes its delivery (it runs only when you press Run)', disabled: view.locked });
  }
  return out;
}

/** The path MTU (analysis/mtu.ts): the limit and what sets it, then per path, the overheads, what is not known, the assumptions. */
function mtuSection(doc: Document, m: PathMtu): HTMLElement {
  const d = el(doc, 'details', { class: 'layer-ev trace-mtu', id: 'trace-mtu' }, [el(doc, 'summary', {}, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(m.verdict) + ' ']), el(doc, 'strong', {}, ['Path MTU: ']), m.text])]);
  const body = el(doc, 'div', { class: 'small' });
  const one = (title: string, rs: PathMtuResult[]): void => {
    for (const r of rs) {
      body.appendChild(el(doc, 'p', {}, [el(doc, 'strong', {}, [`${title}${rs.length > 1 ? ' ' + (r.index + 1) : ''}: `]), r.mtu === null ? 'not known' : `${r.mtu} bytes${r.limiting ? ' (' + r.limiting.what + ')' : ''}`, r.unknown.length ? `; without a known MTU: ${r.unknown.map((u) => u.what).join(', ')}` : '']));
      if (r.overheads.length) body.appendChild(el(doc, 'p', { class: 'muted' }, ['Encapsulation: ' + r.overheads.map((o) => `${o.layer}: ${o.bytes === null ? 'not known' : o.bytes + ' bytes'} (${o.what})`).join('; ')]));
    }
  };
  one('Path', m.forward);
  if (m.reverse.length) one('Return path', m.reverse);
  for (const x of m.differs) body.appendChild(el(doc, 'p', {}, [x]));
  for (const x of m.assumptions) body.appendChild(el(doc, 'p', { class: 'muted' }, [x]));
  if (m.payload) body.appendChild(el(doc, 'p', { class: 'muted' }, ['Prepare MTU test (in the next steps) prefills a send one byte over the limit with Don’t fragment. The simulation fragments IPv4 without DF, drops a larger packet with DF (and IPv6) with Fragmentation Needed or Packet Too Big, and the sender learns the path MTU.']));
  d.appendChild(body);
  return d;
}

/** Every VRF of the model ('' first: the default table). */
export function modelVrfs(model: Model): string[] {
  const s = new Set<string>(['']);
  for (const d of model.devices) for (const v of deviceVrfs(model, d.id)) s.add(v);
  return Array.from(s).sort();
}

/** Short summary of a trace over all its evaluated paths: "Reachable within scope: 2 evaluated paths reach hq-log:eno1 (4 hops)". */
export function traceSummary(t: Trace): string {
  if (t.error) return t.error;
  if (!t.paths.length) return 'No path';
  const o = traceOutcome(t);
  const n = t.paths[0].hops.length - 1;
  const lines = outcomeLines(o).filter((l) => !/^More equal-cost/.test(l));
  return `${verdictText(o.verdict, 'reach')}: ${lines.join('; ')}${o.verdict === 'satisfied' && o.total === 1 ? ` (${n} hop${n === 1 ? '' : 's'})` : ''}${o.truncated ? '; more paths not evaluated' : ''}`;
}

/** Task-wide state the parts need besides the form and the result. */
export interface TraceViewState {
  formError: string;
  bar: ContextBarState;
  /** why the handoff can't be prepared now ('' it can): no simulation, an outdated result, a stale reference */
  handoffBlocked: string;
  /** why there is nothing to compare with ('' there is: a send of the simulation carries it) */
  compareBlocked: string;
  /** why the model can't be edited now ('' it can) */
  locked: string;
  /** the question is not one yet: which communication (Diagnose selected communication with several client applications) */
  choice?: { title: string; options: Array<{ label: string; from: string; to: string; why: string }> } | null;
  /** a policy decision a piece of evidence named: the device's rules in order, the deciding one marked */
  rule?: DiagRuleView | null;
  /** the item selected in the results ('' none) */
  sel: string;
}

/** A device's policy as a diagnosis' link shows it (read-only, in every workspace): its rules, the decision marked. */
export interface DiagRuleView {
  /** the evidence link that opened it (focus goes back to it) */
  ref: string;
  device: string;
  /** "default deny, stateful" or a firewall's implicit policy in words */
  summary: string;
  rows: Array<{ n: number; text: string; on: boolean }>;
  /** the default action's line, and whether it decided */
  def?: { text: string; on: boolean };
  /** the decision can't be shown (not in the model diagnosed, or not the rule recorded) */
  missing?: string;
  /** the current model's policy differs from the one diagnosed (said: what is shown is as it was) */
  current?: string;
}

/**
 * How an end binds, in words: what the check (and a prepared test) takes it
 * as. `from`: the source as typed, for an empty destination.
 */
export function bindingText(model: Model, field: 'from' | 'to', text: string, from = ''): string {
  const t = text.trim();
  if (!t) {
    if (field === 'to' && from.trim().indexOf('/') > 0) return 'Binding: the application’s configured peer (or broker)';
    return field === 'from' ? 'A device, interface, address or application: type to search' : 'A device, interface, address, application, service or host name: type to search';
  }
  const e = parseCommEnd(model, t);
  if (typeof e === 'string') return e;
  if (e.kind === 'app') return field === 'from' ? `Binding: application ${e.app.name} on ${e.device}, from its bind interface${(e.profile as { client?: boolean }).client ? '; with To empty, to its configured peer' : ''}` : `Binding: application ${e.app.name}’s listener on ${e.device} (its bind interface)`;
  if (e.kind === 'service') return `Binding: the ${e.service.label} listener on ${e.device}`;
  if (e.kind === 'name') return field === 'from' ? 'A host name is no source: give the device' : 'Binding: host name, resolved when sent (checked through the source’s DNS)';
  const end = e.end;
  if (end.kind === 'address') return 'Binding: exact address';
  if (end.kind === 'iface') return 'Binding: the interface’s effective address (a DHCP lease or SLAAC address when it has one)';
  return field === 'from' ? 'Binding: the device’s interface toward the destination, its effective address (chosen when checked)' : 'Binding: the device’s effective address of the family (chosen when checked)';
}

/** The searchable ends of the model (a datalist): devices, interfaces, exact addresses, applications, services, host names. */
function endsList(doc: Document, model: Model): HTMLElement {
  const list = el(doc, 'datalist', { id: 'trace-ends' });
  for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    list.appendChild(el(doc, 'option', { value: d.id }, [`Device${d.label !== d.id ? ' · ' + d.label : ''}`]));
    for (const i of deviceInterfaces(d)) {
      list.appendChild(el(doc, 'option', { value: d.id + ':' + i.id }, [`Interface${i.addresses.length ? ' · ' + i.addresses.join(', ') : ''}`]));
      for (const a of i.addresses) list.appendChild(el(doc, 'option', { value: a.split('/')[0] }, [`Exact address · ${d.id}:${i.id}`]));
    }
    for (const a of d.applications || []) {
      const p = appProfile(a.profile);
      list.appendChild(el(doc, 'option', { value: `${d.id}/${a.id}` }, [`Application · ${a.name} — ${p ? p.short : a.profile}${a.port !== undefined && p && p.listener ? ' ' + a.port : ''}`]));
    }
    for (const s of namedServices(d)) list.appendChild(el(doc, 'option', { value: `${d.id}/${s.id}` }, [`Service · ${s.label} — ${s.proto.toUpperCase()} ${s.port}`]));
    for (const n of d.dnsNames) list.appendChild(el(doc, 'option', { value: n.name.replace(/\.$/, '') }, [`Host name · ${d.id}`]));
  }
  return list;
}

/** The question (the left panel): the context, a choice to make first, the form. */
export function commRequest(doc: Document, model: Model, form: TraceForm, run: TraceRun | null, view: TraceViewState, act: TracePanelActions): HTMLElement {
  const formError = view.formError;
  const box = el(doc, 'div', { class: 'trace-panel' });
  box.appendChild(contextBar(doc, view.bar, act));
  // ---- which communication, when the selection is not one: nothing is checked until one is taken
  if (view.choice) {
    const ch = el(doc, 'div', { class: 'trace-choice', id: 'trace-choice', role: 'group', 'aria-labelledby': 'trace-choice-h' }, [el(doc, 'p', { id: 'trace-choice-h' }, [el(doc, 'strong', {}, [view.choice.title])])]);
    const ul = el(doc, 'ul', { class: 'small' });
    for (const o of view.choice.options) {
      const b = el(doc, 'button', { type: 'button', class: 'mini', title: o.why, 'data-choice-from': o.from, 'data-choice-to': o.to }, [o.label]);
      b.addEventListener('click', () => act.choose(o.from, o.to));
      ul.appendChild(el(doc, 'li', {}, [b]));
    }
    ch.appendChild(ul);
    box.appendChild(ch);
  }
  // ---- the form
  const f = el(doc, 'form', { class: 'trace-form', 'aria-label': 'Communication question' }) as HTMLFormElement;
  f.appendChild(endsList(doc, model));
  const binds: { [k: string]: HTMLElement } = {};
  const field = (id: 'from' | 'to', label: string): HTMLElement => {
    const input = el(doc, 'input', {
      id: 'trace-' + id,
      type: 'text',
      list: 'trace-ends',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: id === 'to' ? 'device, interface, address, application, service, host name' : 'device, interface, address or application',
      'aria-describedby': 'trace-' + id + '-bind',
      'data-t': 'trace',
      'data-p': id,
      'data-k': '',
    }) as HTMLInputElement;
    input.value = form[id];
    if (formError && formError.indexOf(id === 'from' ? 'Source' : 'Destination') === 0) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'trace-error trace-' + id + '-bind');
    }
    const bind = el(doc, 'p', { class: 'help tf-help an-bind', id: 'trace-' + id + '-bind' }, [bindingText(model, id, form[id], form.from)]);
    binds[id] = bind;
    input.addEventListener('input', () => {
      act.input(id, input.value);
      // (how the ends bind, as typed: the panel is not drawn again while typing)
      bind.textContent = bindingText(model, id, input.value, id === 'from' ? input.value : form.from);
      if (id === 'from' && binds.to) binds.to.textContent = bindingText(model, 'to', form.to, input.value);
    });
    return el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-' + id }, [label]), el(doc, 'div', { class: 'tf-col' }, [input, bind])]);
  };
  const grid = el(doc, 'div', { class: 'tf-grid' });
  grid.appendChild(field('from', 'From'));
  grid.appendChild(field('to', 'To'));
  // what is sent: from the applications, or given (a firewall's or a Security gateway's policy decides by it)
  const svc = el(doc, 'input', { id: 'trace-service', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'from the application, or tcp/443, udp/53, icmp', 'aria-describedby': 'trace-service-help', 'data-t': 'trace', 'data-p': 'service', 'data-k': '' }) as HTMLInputElement;
  svc.value = form.service;
  if (formError && formError.indexOf('Service') === 0) {
    svc.setAttribute('aria-invalid', 'true');
    svc.setAttribute('aria-describedby', 'trace-error trace-service-help');
  }
  svc.addEventListener('input', () => act.input('service', svc.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-service' }, ['Service']), el(doc, 'div', { class: 'tf-col' }, [svc, el(doc, 'p', { class: 'help tf-help', id: 'trace-service-help' }, ['An application or service end gives its own; policies decide by it, and the destination’s listener is checked.'])])]));
  f.appendChild(grid);
  // ---- advanced options: the routing context, the family, the return direction
  const adv = el(doc, 'details', { class: 'dc-adv', id: 'trace-adv' }, [el(doc, 'summary', {}, ['Advanced options: VRF, family, return direction'])]);
  if (form.vrf !== 'auto' || form.family || form.back) adv.setAttribute('open', '');
  const g2 = el(doc, 'div', { class: 'tf-grid' });
  const vrf = el(doc, 'select', { id: 'trace-vrf', 'data-t': 'trace', 'data-p': 'vrf', 'data-k': '' }) as HTMLSelectElement;
  vrf.appendChild(el(doc, 'option', { value: 'auto' }, ['Source interface’s VRF']));
  for (const v of modelVrfs(model)) vrf.appendChild(el(doc, 'option', { value: v }, [v === '' ? 'Default table' : 'VRF ' + v]));
  if (form.vrf !== 'auto' && !Array.prototype.some.call(vrf.options, (o: HTMLOptionElement) => o.value === form.vrf)) vrf.appendChild(el(doc, 'option', { value: form.vrf }, ['VRF ' + form.vrf]));
  vrf.value = form.vrf;
  vrf.addEventListener('change', () => act.input('vrf', vrf.value));
  g2.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-vrf' }, ['VRF']), vrf]));
  // the address family: the ends' own unless one is chosen (an end with both families: the destination's decides)
  const fam = el(doc, 'select', { id: 'trace-family', 'data-t': 'trace', 'data-p': 'family', 'data-k': '', 'aria-describedby': 'trace-family-help' }) as HTMLSelectElement;
  for (const [v, t] of [['', 'Automatic family'], ['4', 'IPv4'], ['6', 'IPv6']]) fam.appendChild(el(doc, 'option', { value: v }, [t]));
  fam.value = form.family || '';
  fam.addEventListener('change', () => act.input('family', fam.value));
  g2.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-family' }, ['Family']), el(doc, 'div', { class: 'tf-col' }, [fam, el(doc, 'p', { class: 'help tf-help', id: 'trace-family-help' }, ['Automatic: the family the ends (or the client application) give — one family is evaluated, never both silently.'])])]));
  adv.appendChild(g2);
  const back = el(doc, 'input', { type: 'checkbox', id: 'trace-back', 'data-t': 'trace', 'data-p': 'back', 'data-k': '' }) as HTMLInputElement;
  back.checked = form.back;
  back.addEventListener('change', () => act.input('back', back.checked));
  adv.appendChild(el(doc, 'div', { class: 'tf-check' }, [back, el(doc, 'label', { for: 'trace-back' }, ['Return direction too (reverse routing and path symmetry)'])]));
  f.appendChild(adv);
  const go = el(doc, 'button', { type: 'submit', class: 'primary', id: 'trace-go' }, ['Check communication']);
  const swap = el(doc, 'button', { type: 'button', class: 'mini tf-swap', id: 'trace-swap', title: 'Swap source and destination', 'aria-label': 'Swap source and destination' }, ['⇅ Swap']);
  swap.addEventListener('click', () => act.swap());
  const actions = el(doc, 'div', { class: 'tf-actions' }, [go, swap]);
  if (run) {
    const exit = el(doc, 'button', { type: 'button', id: 'trace-exit', title: 'Remove the result and the path from the diagram' }, ['Clear']);
    exit.addEventListener('click', () => act.exit());
    actions.appendChild(exit);
  }
  f.appendChild(actions);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    act.submit();
  });
  box.appendChild(f);
  if (formError) box.appendChild(el(doc, 'p', { class: 'trace-error', id: 'trace-error', role: 'alert' }, [formError]));
  return box;
}

/** The layer an investigation starts with: an established blocker, else a layer needing attention (never the runtime limitation), else the main path. */
export function commDefaultItem(run: TraceRun): string {
  const d = run.diagnosis;
  if (d) {
    const k = d.blockers.findIndex((b) => b.rel === 'cause');
    if (k >= 0) return 'blocker:' + k;
  }
  const c = run.check;
  const bad = c.layers.find((l) => l.id !== 'runtime' && l.verdict === 'violated') || c.layers.find((l) => l.id !== 'runtime' && l.verdict !== 'satisfied');
  if (bad) return 'layer:' + bad.id;
  if (!run.trace.error && run.trace.paths.length) return 'path:trace-main';
  return c.layers.length ? 'layer:' + c.layers[0].id : '';
}

const section = (doc: Document, id: string, title: string): HTMLElement => {
  const sec = el(doc, 'section', { class: 'trace-section an-res-sec', id, 'aria-labelledby': id + '-h' });
  sec.appendChild(el(doc, 'h3', { id: id + '-h' }, [title]));
  return sec;
};

/** The answer and its results (the bottom panel; see the module comment). */
export function commResults(doc: Document, model: Model, run: TraceRun, view: TraceViewState, act: TracePanelActions): HTMLElement {
  const c = run.check;
  const t = run.trace;
  const d = run.diagnosis;
  const sel = view.sel;
  const res = el(doc, 'div', { class: 'trace-result', id: 'diag', 'data-state': d ? d.state : c.verdict });
  // the result as a record: copy or save as text
  const copy = el(doc, 'button', { type: 'button', class: 'mini', id: 'trace-copy' }, ['Copy as text']);
  copy.addEventListener('click', () => act.copy());
  const save = el(doc, 'button', { type: 'button', class: 'mini', id: 'trace-save' }, ['Save as text']);
  save.addEventListener('click', () => act.save());
  res.appendChild(el(doc, 'div', { class: 'an-res-tools', role: 'group', 'aria-label': 'Export the result' }, [copy, save]));
  // ---- the answer, once: the diagnosis' state and summary (the static check's verdict is part of what is established)
  const ans = section(doc, 'an-answer', 'Answer');
  const st = d ? DIAG_STATE[d.state] : null;
  const h = ans.firstChild as HTMLElement;
  h.appendChild(doc.createTextNode(' '));
  if (st) h.appendChild(el(doc, 'span', { class: 'an-chip v-' + st.tone, id: 'diag-state' }, [st.mark + ' ' + st.label]));
  else h.appendChild(el(doc, 'span', { class: 'an-chip v-' + c.verdict, id: 'diag-state' }, [verdictMark(c.verdict) + ' ' + verdictText(c.verdict, 'reach')]));
  ans.appendChild(el(doc, 'p', { id: 'diag-summary', tabindex: '-1' }, [d ? d.summary : c.headline]));
  const flags = d ? [view.bar.outdated ? 'Outdated: the model changed after this diagnosis' : '', d.provisional ? 'Provisional: the run is not finished' : '', d.evidenceLimited ? 'Evidence-limited: some records are no longer kept' : ''].filter((x) => !!x) : view.bar.outdated ? ['Outdated: the model changed after this result'] : [];
  if (flags.length) ans.appendChild(el(doc, 'p', { class: 'small diag-flags', id: 'diag-flags' }, [flags.join(' · ')]));
  if (d) {
    // what was evaluated: the question as asked and resolved
    const q = el(doc, 'dl', { class: 'trace-ends small an-question', id: 'diag-question', 'aria-label': 'What was evaluated' });
    const row = (k: string, v: string): void => {
      q.appendChild(el(doc, 'dt', {}, [k]));
      q.appendChild(el(doc, 'dd', {}, [v]));
    };
    row('From', d.question.from);
    row('To', d.question.to);
    row('Family', d.question.family);
    row('Service', d.question.service);
    row('Routing context', d.question.vrf);
    row('Analyzed on', d.question.context);
    row('Runtime', d.question.run || 'none attached (Compare matching observation attaches the newest recorded run of exactly this communication)');
    ans.appendChild(q);
    if (d.question.unresolved.length) ans.appendChild(el(doc, 'p', { class: 'small muted', id: 'diag-open' }, ['Open: ' + d.question.unresolved.join('; ')]));
  }
  // the next steps: they prefill or open; nothing is sent, nothing is changed
  const next = commNext(run, view);
  if (next.length) {
    const nx = el(doc, 'div', { class: 'tf-actions diag-next', id: 'diag-next', role: 'group', 'aria-label': 'Next steps' });
    for (const a of next) {
      const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-diag-act': a.id, ...(a.ref ? { 'data-diag-ref': a.ref } : {}), ...(NEXT_ID[a.id] ? { id: NEXT_ID[a.id] } : {}), title: a.disabled || a.why || a.label }, [a.label]) as HTMLButtonElement;
      b.disabled = !!a.disabled;
      nx.appendChild(b);
    }
    ans.appendChild(nx);
  }
  res.appendChild(ans);
  // ---- what is established, layer by layer (the runtime layer is a limitation of static analysis, said apart)
  const est = section(doc, 'an-established', 'What is established');
  est.appendChild(verdictLine(doc, c.verdict, 'reach', c.headline.replace(/^(Reachable within scope|Indeterminate|Partially reachable|Beyond modeled scope)[,:;]?\s*/, ''), { id: 'trace-verdict', role: 'status', 'data-verdict': c.verdict, class: 'an-verdict small v-' + c.verdict }));
  const ul = el(doc, 'ul', { class: 'comm-layers', 'aria-label': 'What the check established, layer by layer' });
  for (const l of c.layers.filter((x) => x.id !== 'runtime')) ul.appendChild(layerItem(doc, l, sel));
  est.appendChild(ul);
  const rl = c.layers.find((x) => x.id === 'runtime');
  if (rl) est.appendChild(el(doc, 'p', { class: 'small muted an-limitation', id: 'an-runtime-limit', 'data-layer': 'runtime' }, [el(doc, 'strong', {}, ['Runtime limitation: ']), rl.text, ' ', pickButton(doc, 'layer:runtime', sel, 'Evidence', 'Evidence: runtime limitation')]));
  if (d && !d.blockers.length && d.established.length) est.appendChild(el(doc, 'ul', { class: 'diag-list small', id: 'diag-established' }, d.established.map((x) => el(doc, 'li', {}, [x]))));
  res.appendChild(est);
  // ---- the main blocker or limitation
  if (d && d.blockers.length) {
    const bl = section(doc, 'an-blockers', d.state === 'waiting' ? 'What it waits for, and what limits it' : 'Main blocker or limitation');
    const list = el(doc, 'ul', { class: 'diag-list', id: 'diag-blockers' });
    d.blockers.forEach((b, k) => list.appendChild(chainItem(doc, b, 'li', { key: 'blocker:' + k, sel })));
    bl.appendChild(list);
    res.appendChild(bl);
  }
  // ---- the runtime observation, when one is attached
  const rp = d ? d.runtime : undefined;
  if (rp || run.compare || (d && d.legs.length)) {
    const rt = section(doc, 'an-runtime', 'Runtime observation');
    if (rp) rt.appendChild(el(doc, 'p', { class: 'small', id: 'diag-runtime', 'data-completed': String(rp.completed), 'data-outcome': rp.outcome, 'data-cause': rp.cause }, [`${rp.completed ? 'Finished' : 'Not finished'} · observed: ${OUTCOME_TEXT[rp.outcome]} · cause: ${CAUSE_TEXT[rp.cause]} — ${rp.text}`]));
    if (run.compare) rt.appendChild(compareSection(doc, run.compare));
    if (d && d.legs.length) {
      const lu = el(doc, 'ul', { class: 'comm-legs small', id: 'diag-legs', 'aria-label': 'Legs, each on its own' });
      for (const g of d.legs) {
        const s2 = DIAG_STATE[g.state];
        lu.appendChild(el(doc, 'li', { 'data-state': g.state }, [el(doc, 'span', { class: 'an-chip v-' + s2.tone }, [s2.mark + ' ' + s2.label]), ' ', g.label, el(doc, 'div', { class: 'muted' }, [g.text])]));
      }
      rt.appendChild(lu);
    }
    res.appendChild(rt);
  } else res.appendChild(el(doc, 'p', { class: 'small muted', id: 'diag-runtime' }, ['Runtime observation: none attached. Static analysis establishes what the configuration allows, not that an exchange completed; Compare matching observation attaches a recorded run of exactly this communication.']));
  // ---- the paths and the detailed evidence
  const det = section(doc, 'an-paths', 'Paths and detailed evidence');
  const ends = el(doc, 'dl', { class: 'trace-ends small' });
  const row = (k: string, v: Array<Node | string>): void => {
    ends.appendChild(el(doc, 'dt', {}, [k]));
    ends.appendChild(el(doc, 'dd', {}, v));
  };
  if (c.from) row('From', [c.from.text, pickSelect(doc, model, run, 'from', act)]);
  if (c.to) row('To', [c.to.text, pickSelect(doc, model, run, 'to', act)]);
  if (t.source) row('VRF', [t.source.vrf ? 'VRF ' + t.source.vrf : 'Default table']);
  if (c.service) row('Service', [`${c.service.proto === 'icmp' ? 'ICMP' : c.service.proto.toUpperCase() + ' ' + c.service.port} (${c.serviceSource || 'given'})`]);
  det.appendChild(ends);
  if (run.mtu) det.appendChild(mtuSection(doc, run.mtu));
  if (!t.error) {
    if (t.paths[0]) det.appendChild(pathSection(doc, 'Main path', 'trace-main', t.paths[0], t, sel));
    if (t.paths.length > 1) {
      const more = el(doc, 'details', { class: 'trace-alts', open: '' }, [el(doc, 'summary', {}, [`Equal-cost alternatives (${t.paths.length - 1}${t.truncated ? ', more not evaluated' : ''})`])]);
      t.paths.slice(1).forEach((p, i) => more.appendChild(pathSection(doc, `Equal-cost alternative ${i + 1}`, 'trace-alt-' + (i + 1), p, t, sel)));
      det.appendChild(more);
    }
    if (t.truncated) det.appendChild(el(doc, 'p', { class: 'muted small' }, [outcomeLines(traceOutcome(t)).slice(-1)[0]]));
  }
  // a protocol break: the transfer ends at the gateway, which starts the second leg itself
  for (const l of t.legs || []) {
    const sec = el(doc, 'section', { class: 'trace-section trace-leg', 'aria-labelledby': 'trace-leg2-h', 'data-trace-path': 'trace-leg2' });
    sec.appendChild(el(doc, 'h4', { id: 'trace-leg2-h' }, ['Leg 2 (started by the gateway)']));
    sec.appendChild(el(doc, 'p', { class: 'small' }, [l.note]));
    if (l.trace.error || !l.trace.paths[0]) sec.appendChild(el(doc, 'p', { class: 'trace-status stopped' }, [l.trace.error || 'no path']));
    else {
      sec.appendChild(el(doc, 'p', { class: 'muted small' }, [traceSummary(l.trace)]));
      sec.appendChild(hopTable(doc, l.trace.paths[0], 'Leg 2, hop by hop', 'leg2', sel));
      sec.appendChild(endLine(doc, l.trace.paths[0], l.trace));
    }
    det.appendChild(sec);
  }
  // separate legs of the check: a broker's subscribers, a host name's DNS query
  if (c.legs.length) {
    const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': 'trace-legs-h' });
    sec.appendChild(el(doc, 'h4', { id: 'trace-legs-h' }, ['Separate legs']));
    sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['Checked on their own: what the destination passes on (a broker’s subscribers, over their own connections) or what the source needs first (a DNS query).']));
    const lu = el(doc, 'ul', { class: 'comm-legs' });
    for (const g of c.legs) lu.appendChild(el(doc, 'li', {}, [el(doc, 'span', { class: 'an-chip v-' + g.check.verdict }, [verdictMark(g.check.verdict) + ' ' + verdictText(g.check.verdict, 'reach')]), ' ', g.label, el(doc, 'div', { class: 'muted small' }, [g.check.headline])]));
    sec.appendChild(lu);
    det.appendChild(sec);
  }
  // the return direction: reverse routing, path symmetry, and what is not established
  if (run.back) {
    const b = run.back;
    const rv = c.reverse;
    const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': 'trace-back-h', 'data-trace-path': 'trace-back' });
    sec.appendChild(el(doc, 'h4', { id: 'trace-back-h' }, ['Return path']));
    const bo = traceOutcome(b);
    const items = el(doc, 'ul', { class: 'comm-layers' });
    items.appendChild(el(doc, 'li', { class: 'v-' + bo.verdict }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(bo.verdict) + ' ']), el(doc, 'strong', {}, ['Reverse routing: ']), b.error ? b.error : outcomeLines(bo).join('; ')]));
    const sym = rv ? rv.symmetry : 'not comparable';
    items.appendChild(el(doc, 'li', { class: sym === 'asymmetric' ? 'v-partial' : sym === 'symmetric' ? 'v-satisfied' : 'v-indeterminate' }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [sym === 'asymmetric' ? '⇄ ' : sym === 'symmetric' ? '↩ ' : '? ']), el(doc, 'strong', {}, ['Path symmetry: ']), sym === 'asymmetric' ? 'Asymmetric: the way back crosses other routers' : sym === 'symmetric' ? 'The same routers in reverse' : 'Not compared (a direction does not reach)']));
    items.appendChild(el(doc, 'li', { class: 'v-unsupported' }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, ['– ']), el(doc, 'strong', {}, ['Session: ']), 'not evaluated. The return trace carries no destination port: a TCP session and a stateful firewall’s return decision need the simulation.']));
    sec.appendChild(items);
    if (!b.error && b.paths[0]) {
      sec.appendChild(hopTable(doc, b.paths[0], 'The return path, hop by hop', 'trace-back', sel));
      sec.appendChild(endLine(doc, b.paths[0], b));
    }
    det.appendChild(sec);
  }
  // the evidence chain, behind an expansion
  if (d && d.chain.length) {
    const ch = el(doc, 'details', { class: 'layer-ev', id: 'diag-chain' }, [el(doc, 'summary', {}, [`Evidence chain (${d.chain.length})`])]);
    const ol = el(doc, 'ol', { class: 'diag-list small' });
    for (const l of d.chain) ol.appendChild(chainItem(doc, l, 'li'));
    ch.appendChild(ol);
    det.appendChild(ch);
  }
  // what the handoff carries over, and what it can't
  const ho = run.handoff;
  if (ho) {
    const cd = el(doc, 'details', { class: 'layer-ev', id: 'trace-carry' }, [el(doc, 'summary', {}, ['What a prepared test gets'])]);
    const cl = el(doc, 'ul', { class: 'small' });
    for (const x of ho.carried) cl.appendChild(el(doc, 'li', {}, [x]));
    for (const x of ho.notTransferred) cl.appendChild(el(doc, 'li', { class: 'muted' }, [el(doc, 'strong', {}, ['Not carried over: ']), x]));
    const id = run.identity;
    if (id) for (const e of [id.source, id.destination]) if (e.note) cl.appendChild(el(doc, 'li', { class: 'muted' }, [e.note]));
    cd.appendChild(cl);
    det.appendChild(cd);
  }
  if (d && d.limits.length) {
    const lim = el(doc, 'details', { class: 'layer-ev', id: 'diag-limits' }, [el(doc, 'summary', {}, ['What this diagnosis can’t establish'])]);
    lim.appendChild(el(doc, 'ul', { class: 'small muted' }, d.limits.map((x) => el(doc, 'li', {}, [x]))));
    det.appendChild(lim);
  }
  det.appendChild(
    el(doc, 'p', { class: 'trace-key small' }, [
      'In the diagram: ',
      el(doc, 'span', { class: 'tk tk-main' }, ['thick solid outline']),
      ' the main path; ',
      el(doc, 'span', { class: 'tk tk-alt' }, ['dashed']),
      ' equal-cost alternatives; ',
      el(doc, 'span', { class: 'tk tk-ret' }, ['dotted']),
      ' the return path where it differs; ',
      el(doc, 'span', { class: 'tk tk-stop' }, ['double']),
      ' where it stops.',
    ]),
  );
  det.appendChild(limitsDetails(doc, c.info, ['A Security gateway’s policy, a firewall’s policy (by the service), a VPN gateway’s tunnels and paired ports are considered; NAT for container bridges and the NAT service.']));
  res.appendChild(det);
  // ---- the selected item marked; the buttons act
  for (const x of Array.from(res.querySelectorAll('[data-an-item]')) as HTMLElement[]) {
    const on = x.getAttribute('data-an-item') === sel;
    if (x.tagName === 'BUTTON') x.setAttribute('aria-pressed', on ? 'true' : 'false');
    const holder = x.tagName === 'TR' ? x : (x.closest('li, tr, p.an-limitation') as HTMLElement | null);
    if (on && holder) holder.classList.add('an-selected');
  }
  res.addEventListener('click', (e) => {
    const tg = e.target as Element;
    const b = tg.closest('[data-diag-act], [data-diag-ref], [data-an-item]') as HTMLButtonElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const id = b.getAttribute('data-diag-act');
    const ref = b.getAttribute('data-diag-ref');
    if (id === 'refresh') act.refresh();
    else if (id === 'handoff') act.handoff();
    else if (id === 'compare') act.compare();
    else if (id === 'mtu-test') act.mtuTest();
    else if (id === 'save-exp') act.saveExpectation();
    else if (id === 'experiment') act.experiment();
    else if (ref) act.goto(ref);
    else if (b.hasAttribute('data-an-item') && !tg.closest('[data-goto]')) act.select(b.getAttribute('data-an-item') as string);
  });
  res.addEventListener('keydown', (e) => {
    const row = (e.target as Element).closest('tr[data-an-item]');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      act.select(row.getAttribute('data-an-item') as string);
    }
  });
  return res;
}

/** The static result beside the simulation's run of it. */
function compareSection(doc: Document, k: RunComparison): HTMLElement {
  const sec = el(doc, 'section', { class: 'trace-compare', id: 'trace-compare-res', 'aria-label': 'Compared with the simulation', tabindex: '-1' });
  sec.appendChild(el(doc, 'h4', {}, ['Compared with the matching observation']));
  // (provisional while messages are on their way or still to be sent: the evidence so far, never an agreement)
  const n = k.counts;
  const so = [n.delivered ? `${n.delivered} delivered` : '', n.failed ? `${n.failed} not delivered` : '', n.pending ? `${n.pending} on their way` : '', n.unsent ? `${n.unsent} still to be sent` : '', n.cancelled ? `${n.cancelled} cancelled by Stop` : ''].filter((x) => !!x).join(', ');
  const differs = !!k.unexplained || k.lines.length > 0;
  const head = !k.final ? (differs ? 'Provisional, they differ so far: ' : 'Provisional: ') : k.agree ? 'They agree: ' : 'They differ: ';
  sec.appendChild(el(doc, 'p', { class: 'small', 'data-agree': k.agree ? 'yes' : !k.final && !differs ? 'provisional' : 'no' }, [el(doc, 'strong', {}, [head]), `static analysis ${verdictText(k.expected, 'reach').toLowerCase()}; the simulation ${k.final ? '' : 'so far '}${k.runtime === 'delivered' ? 'delivered it' : k.runtime === 'failed' ? 'did not deliver it' : k.runtime === 'mixed' ? 'delivered some messages' : 'has no result yet'}${so ? ` (${so})` : ''}.`]));
  const ul = el(doc, 'ul', { class: 'small' });
  for (const l of k.lines) ul.appendChild(el(doc, 'li', {}, [l]));
  if (k.unexplained) ul.appendChild(el(doc, 'li', { class: 'muted' }, [k.unexplained]));
  for (const r of k.results) ul.appendChild(el(doc, 'li', { class: 'muted' }, [r]));
  sec.appendChild(ul);
  return sec;
}

/** The other addresses an end could stand for, as a select (none when there is only one). */
function pickSelect(doc: Document, model: Model, run: TraceRun, field: 'from' | 'to', act: TracePanelActions): Node | string {
  const c = run.check;
  const e = field === 'from' ? c.from : c.to;
  if (!e || !e.device) return '';
  // an application's end is its application's (its bind interface): nothing to choose
  const text = field === 'from' ? c.request.from : c.request.to || '';
  if (text.indexOf('/') > 0) return '';
  const dev = model.index.devices.get(e.device);
  if (!dev) return '';
  const fam = e.address && e.address.indexOf(':') >= 0 ? 6 : 4;
  const opts: Array<{ value: string; label: string }> = [];
  for (const i of deviceInterfaces(dev)) {
    for (const a of i.addresses) {
      const t = a.split('/')[0];
      if ((t.indexOf(':') >= 0 ? 6 : 4) !== fam) continue;
      opts.push({ value: `${e.device}:${i.id}`, label: `${e.device}:${i.id} · ${t}` });
    }
  }
  if (opts.length < 2) return '';
  const id = 'trace-pick-' + field;
  const sel = el(doc, 'select', { id, class: 'mini trace-pick', 'aria-label': `Another address for ${field === 'from' ? 'the source' : 'the destination'}` }) as HTMLSelectElement;
  sel.appendChild(el(doc, 'option', { value: '' }, ['Another address…']));
  for (const o of opts) sel.appendChild(el(doc, 'option', { value: o.value }, [o.label]));
  sel.addEventListener('change', () => {
    if (sel.value) act.pick(field, sel.value);
  });
  return el(doc, 'span', { class: 'trace-pick-wrap' }, [' ', sel]);
}

/** A layer as a list item: mark, name, result, and Evidence (its evidence on the right). */
function layerItem(doc: Document, l: CommLayer, sel: string): HTMLElement {
  const li = el(doc, 'li', { class: 'v-' + l.verdict, 'data-layer': l.id });
  li.appendChild(el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(l.verdict) + ' ']));
  li.appendChild(el(doc, 'strong', {}, [LAYER_LABEL[l.id] + ': ']));
  li.appendChild(el(doc, 'span', { class: 'sr-only' }, [verdictText(l.verdict, 'reach') + '. ']));
  li.appendChild(doc.createTextNode(l.text));
  li.appendChild(doc.createTextNode(' '));
  li.appendChild(pickButton(doc, 'layer:' + l.id, sel, 'Evidence', `Evidence: ${LAYER_LABEL[l.id]}`));
  return li;
}

/** One path as a labelled section: its table and its end. */
function pathSection(doc: Document, title: string, id: string, p: Path, t: Trace, sel: string): HTMLElement {
  const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': id + '-h', 'data-trace-path': id });
  sec.appendChild(el(doc, 'div', { class: 'an-path-head' }, [el(doc, 'h4', { id: id + '-h' }, [title]), pickButton(doc, 'path:' + id, sel, 'Path evidence', `Evidence: ${title}`)]));
  sec.appendChild(hopTable(doc, p, `${title}, hop by hop`, id, sel));
  sec.appendChild(endLine(doc, p, t));
  return sec;
}

function endLine(doc: Document, p: Path, t: Trace): HTMLElement {
  const k = p.end.kind;
  const cls = k === 'stopped' ? 'stopped' : k === 'reached' ? 'ok' : 'beyond';
  return el(doc, 'p', { class: 'trace-end ' + cls }, [
    el(doc, 'span', { 'aria-hidden': 'true', class: 'ts-mark' }, [k === 'stopped' ? '✕ ' : k === 'reached' ? '→ ' : '↗ ']),
    el(doc, 'strong', {}, [endStatus(p.end) + ': ']),
    endText(p.end, t.dest ? t.dest.address : ''),
  ]);
}

const ref = (doc: Document, r: string, text: string): HTMLElement => el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': r }, [text]);

/** The columns of a hop table. */
export const HOP_COLUMNS = ['#', 'Device', 'In', 'Out', 'Addresses', 'Route or relation', 'Encapsulation'];

/** A path as a table: one row per hop (a row of details under it when it has any); Why? shows the hop's decision evidence on the right; a tunnel's underlay as numbered rows. */
function hopTable(doc: Document, p: Path, caption: string, id: string, sel: string): HTMLElement {
  const table = el(doc, 'table', { class: 'hop-table' });
  table.appendChild(el(doc, 'caption', { class: 'sr-only' }, [caption]));
  table.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, HOP_COLUMNS.map((c) => el(doc, 'th', { scope: 'col' }, [c])))]));
  const tb = el(doc, 'tbody');
  hopRows(doc, tb, p.hops, '', 0, id, sel);
  table.appendChild(tb);
  return el(doc, 'div', { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': caption }, [table]);
}

function hopRows(doc: Document, tb: HTMLElement, hops: Hop[], prefix: string, depth: number, id: string, sel: string): void {
  hops.forEach((h, k) => {
    const n = `${prefix}${k + 1}`;
    const key = `hop:${id}:${n}`;
    const tags: Array<Node | string> = [];
    if (h.vrf) tags.push(el(doc, 'span', { class: 'th-tag' }, ['VRF ' + h.vrf]));
    if (h.ecmp > 1) tags.push(el(doc, 'span', { class: 'th-tag' }, [`equal-cost ${h.branch + 1} of ${h.ecmp}`]));
    if (h.nat) tags.push(el(doc, 'span', { class: 'th-tag', title: h.nat === 'snat' ? 'The source address becomes the host’s' : 'To a published port of a container' }, [h.nat.toUpperCase()]));
    const addrs: Array<Node | string> = [];
    if (h.inAddr) addrs.push(`in ${h.inAddr}`);
    if (h.outAddr) addrs.push(`${addrs.length ? ' · ' : ''}out ${h.outAddr}`);
    if (h.gateway) addrs.push(`${addrs.length ? ' · ' : ''}next hop ${h.gateway}`);
    const via: Array<Node | string> = [];
    if (h.via.text) {
      if (h.via.route) via.push(ref(doc, h.via.route, h.via.text));
      else if (h.via.relation && h.via.kind === 'dynamic') {
        const i = h.via.text.indexOf(h.via.relation);
        via.push(h.via.text.slice(0, i), ref(doc, 'relation:' + h.via.relation, h.via.relation), h.via.text.slice(i + h.via.relation.length));
      } else via.push((h.via.kind === 'none' || h.via.kind === 'blackhole' ? 'stops: ' : '') + h.via.text);
    }
    const encap: Array<Node | string> = [];
    h.encap.forEach((l, i) => {
      if (i) encap.push(' over ');
      encap.push(l.relation ? ref(doc, 'relation:' + l.relation, l.label) : l.label);
    });
    const numCell: Array<Node | string> = [n];
    if (h.why) numCell.push(el(doc, 'button', { type: 'button', class: 'mini why-btn an-pick', 'data-an-item': key, 'aria-pressed': key === sel ? 'true' : 'false', 'aria-controls': 'an-detail', 'aria-label': `Why hop ${n}?`, title: 'Why this hop: its decision evidence, on the right' }, ['Why?']));
    tb.appendChild(
      el(doc, 'tr', { class: 'hop-row' + (depth ? ' hop-under' : '') + (key === sel ? ' an-selected' : ''), 'data-hop': n, ...(h.why ? { 'data-an-item': key, tabindex: '0', 'aria-label': `Hop ${n}: ${h.device}` } : {}) }, [
        el(doc, 'th', { scope: 'row', class: 'th-n' }, numCell),
        el(doc, 'td', { class: 'hop-dev' }, [ref(doc, 'device:' + h.device, h.device), ...tags]),
        el(doc, 'td', { class: 'hop-if' }, h.ingress ? [ref(doc, `iface:${h.device}:${h.ingress}`, h.ingress)] : ['—']),
        el(doc, 'td', { class: 'hop-if' }, h.egress ? [ref(doc, `iface:${h.device}:${h.egress}`, h.egress)] : ['—']),
        el(doc, 'td', {}, addrs.length ? addrs : ['—']),
        el(doc, 'td', {}, via.length ? via : ['—']),
        el(doc, 'td', {}, encap.length ? encap : ['—']),
      ]),
    );
    // the details under the hop: switches passed, cables, notes
    const more: Array<Node | string> = [];
    // inside a host: port groups, virtual switches, container networks
    const inside = h.virtual.filter((r) => r.indexOf('iface:') !== 0);
    if (inside.length) {
      more.push(el(doc, 'span', { class: 'th-k' }, ['inside ']));
      inside.forEach((r, i) => more.push(i ? ', ' : '', ref(doc, r, virtRefText(r))));
    }
    if (h.l2.length) {
      if (more.length) more.push(' · ');
      more.push(el(doc, 'span', { class: 'th-k' }, ['through ']));
      h.l2.forEach((d, i) => more.push(i ? ', ' : '', ref(doc, 'device:' + d, d)));
    }
    if (h.links.length) {
      if (more.length) more.push(' · ');
      more.push(el(doc, 'span', { class: 'th-k' }, [h.links.length > 1 ? 'cables ' : 'cable ']));
      h.links.forEach((l, i) => more.push(i ? ', ' : '', ref(doc, 'link:' + l, l)));
    }
    for (const note of h.notes) {
      if (more.length) more.push(' · ');
      more.push(note);
    }
    if (h.underlay) {
      if (more.length) more.push(' · ');
      more.push(`underlay: the ${encapText(h.encap)} packet, rows ${n}.1 …`);
    }
    if (more.length) tb.appendChild(el(doc, 'tr', { class: 'hop-more' + (depth ? ' hop-under' : '') }, [el(doc, 'td', {}, ['']), el(doc, 'td', { colspan: '6' }, more)]));
    if (h.underlay) hopRows(doc, tb, h.underlay.hops, n + '.', depth + 1, id, sel);
  });
}

/** A hop's decision evidence: the lookup, the route chosen and why, the alternatives, the layer-2 way, the policy, NAT, the tunnel, the stop. */
export function whyBox(doc: Document, w: HopWhy): HTMLElement {
  const box = el(doc, 'dl', { class: 'why-box small' });
  const put = (k: string, v: Array<Node | string>): void => {
    box.appendChild(el(doc, 'dt', {}, [k]));
    box.appendChild(el(doc, 'dd', {}, v));
  };
  put('Lookup', [w.lookup]);
  if (w.selected.length) put('Selected', w.selected.map((s) => el(doc, 'div', {}, [s.ref ? ref(doc, s.ref, s.text) : s.text])));
  if (w.rule) put('Because', [w.rule]);
  if (w.alternatives.length) put('Alternatives', w.alternatives.map((a) => el(doc, 'div', {}, [a.ref ? ref(doc, a.ref, a.text) : a.text, el(doc, 'span', { class: 'muted' }, [` — not used: ${a.detail}`])])));
  if (w.l2) put('Layer 2', [w.l2]);
  if (w.policy.length) put('Policy', w.policy.map((x) => el(doc, 'div', {}, [x])));
  if (w.nat) put('Translation', [w.nat]);
  if (w.tunnel) put('Tunnel', [w.tunnel]);
  if (w.stop) put('Stops', [w.stop]);
  return box;
}

/** A path of a run by its id (trace-main, trace-alt-N, trace-back, leg2). */
function pathOf(run: TraceRun, id: string): Path | null {
  const t = run.trace;
  if (id === 'trace-main') return t.paths[0] || null;
  if (id.indexOf('trace-alt-') === 0) return t.paths[Number(id.slice(10))] || null;
  if (id === 'trace-back') return run.back && run.back.paths[0] ? run.back.paths[0] : null;
  if (id === 'leg2') return t.legs && t.legs[0] && t.legs[0].trace.paths[0] ? t.legs[0].trace.paths[0] : null;
  return null;
}

const PATH_TITLE = (id: string): string => (id === 'trace-main' ? 'Main path' : id === 'trace-back' ? 'Return path' : id === 'leg2' ? 'Leg 2' : `Equal-cost alternative ${id.slice(10)}`);

const refLabel = (r: string): string => r.replace(/^[a-z]+:/, '');

/** The diagram objects among a set of refs (devices, interfaces, cables, relations, networks), labelled. */
const objectRefs = (refs: Iterable<string>): Array<{ ref: string; label: string }> =>
  Array.from(new Set(Array.from(refs).filter((r) => /^(device|iface|link|relation|network|group|route|vswitch|portgroup|cnet):/.test(r)))).map((r) => ({ ref: r, label: refLabel(r) }));

/** One hop of a path by its number ("2", "2.1" for an underlay's). */
function hopOf(p: Path, n: string): Hop | null {
  let hops = p.hops;
  let h: Hop | null = null;
  for (const part of n.split('.')) {
    h = hops[Number(part) - 1] || null;
    if (!h) return null;
    hops = h.underlay ? h.underlay.hops : [];
  }
  return h;
}

/**
 * The evidence of the selected item (see the module comment), or null when
 * the key names nothing of this result (it is let go). `context`: the
 * result's context in words.
 */
export function commEvidence(doc: Document, run: TraceRun, key: string, view: TraceViewState, context: string): EvidenceView | null {
  const c = run.check;
  const d = run.diagnosis;
  const flags = view.bar.outdated ? ['Outdated: the model changed after this result'] : [];
  if (d && d.evidenceLimited) flags.push('Evidence-limited: some records are no longer kept');
  const base = { context, flags };
  const i = key.indexOf(':');
  const kind = i < 0 ? key : key.slice(0, i);
  const rest = i < 0 ? '' : key.slice(i + 1);
  if (kind === 'layer') {
    const l = c.layers.find((x) => x.id === rest);
    if (!l) return null;
    const next: EvidenceAction[] = [];
    if (l.id === 'path' && run.trace.paths[0]) next.push({ id: 'select', label: 'Show the main path', ref: 'path:trace-main' });
    if (d) for (const a of d.next) if (a.id === 'goto' && a.ref && (l.id !== 'policy' || a.ref.indexOf('policy:') === 0)) next.push({ id: 'goto', label: a.label, why: a.why, ref: a.ref });
    if (l.id === 'runtime') for (const a of commNext(run, view)) if (a.id === 'handoff' || a.id === 'compare') next.push(a);
    return {
      ...base,
      kind: l.id === 'runtime' ? 'Runtime limitation' : 'Communication layer',
      title: `${LAYER_LABEL[l.id]}: ${verdictText(l.verdict, 'reach')}`,
      explanation: [el(doc, 'p', { class: 'small' }, [l.text]), ...(l.id === 'runtime' ? [el(doc, 'p', { class: 'small muted' }, ['Static analysis intentionally does not establish an exchange (sessions, timers, retries): this is a limitation of what is evaluated, not a failed prerequisite.'])] : [])],
      evidence: l.detail.length ? [el(doc, 'ul', { class: 'small' }, l.detail.map((x) => el(doc, 'li', {}, [x])))] : [],
      objects: objectRefs(l.refs),
      next,
    };
  }
  if (kind === 'blocker' && d) {
    const b = d.blockers[Number(rest)];
    if (!b) return null;
    const runtime = b.refs.concat(b.messages || []).filter((r) => /^(event|packet|test):/.test(r.ref));
    const ev: Node[] = [];
    if (runtime.length || (b.messages && b.messages.length)) {
      const ul = el(doc, 'ul', { class: 'small' });
      for (const r of runtime) ul.appendChild(el(doc, 'li', {}, [el(doc, 'button', { type: 'button', class: 'ref', 'data-diag-ref': r.ref }, [r.label])]));
      if (b.count !== undefined && b.messages && b.count > b.messages.length) ul.appendChild(el(doc, 'li', { class: 'muted' }, [`and ${b.count - b.messages.length} more messages`]));
      ev.push(el(doc, 'p', { class: 'small' }, ['Recorded in the simulation (each opens its record; nothing moves the clock):']), ul);
    }
    const next: EvidenceAction[] = b.refs.filter((r) => /^(policy|layer):/.test(r.ref)).map((r) => ({ id: r.ref.indexOf('policy:') === 0 ? 'goto' : 'select', label: r.ref.indexOf('policy:') === 0 ? `Inspect deciding rule (${r.label})` : `Inspect ${r.label}`, ref: r.ref.indexOf('layer:') === 0 ? 'layer:' + r.ref.slice(6) : r.ref }));
    return {
      ...base,
      kind: b.rel === 'cause' ? 'Blocker' : 'Limitation',
      title: `${REL_LABEL[b.rel]} (${b.source === 'static' ? 'static analysis' : 'recorded at run time'})`,
      explanation: [el(doc, 'p', { class: 'small' }, [b.text])],
      evidence: ev,
      objects: objectRefs(b.refs.map((r) => r.ref)),
      next,
    };
  }
  if (kind === 'path') {
    const p = pathOf(run, rest);
    if (!p) return null;
    const devs = p.hops.map((h) => h.device);
    return {
      ...base,
      kind: rest.indexOf('trace-alt-') === 0 ? 'Equal-cost branch' : 'Path',
      title: PATH_TITLE(rest),
      explanation: [el(doc, 'p', { class: 'small' }, [`${endStatus(p.end)}: ${endText(p.end, run.trace.dest ? run.trace.dest.address : '')}`]), el(doc, 'p', { class: 'small muted' }, [`${p.hops.length} hop${p.hops.length === 1 ? '' : 's'}: ${devs.join(' → ')}`])],
      evidence: [],
      objects: objectRefs(pathRefs(p)),
      next: p.hops.filter((h) => !!h.why).slice(0, 6).map((h, k) => ({ id: 'select', label: `Hop ${p.hops.indexOf(h) + 1}: ${h.device}`, ref: `hop:${rest}:${p.hops.indexOf(h) + 1}`, why: k ? undefined : 'Its decision evidence' })),
    };
  }
  if (kind === 'hop') {
    const j = rest.lastIndexOf(':');
    const p = pathOf(run, rest.slice(0, j));
    const n = rest.slice(j + 1);
    const h = p ? hopOf(p, n) : null;
    if (!p || !h) return null;
    const refs = ['device:' + h.device].concat(h.ingress ? [`iface:${h.device}:${h.ingress}`] : [], h.egress ? [`iface:${h.device}:${h.egress}`] : [], h.links.map((l) => 'link:' + l), h.l2.map((x) => 'device:' + x), h.relations.map((r) => 'relation:' + r));
    const top = n.indexOf('.') < 0 ? Number(n) : 0;
    const next: EvidenceAction[] = [];
    if (top > 1 && hopOf(p, String(top - 1))) next.push({ id: 'select', label: `← Hop ${top - 1}`, ref: `hop:${rest.slice(0, j)}:${top - 1}` });
    if (top && hopOf(p, String(top + 1))) next.push({ id: 'select', label: `Hop ${top + 1} →`, ref: `hop:${rest.slice(0, j)}:${top + 1}` });
    next.push({ id: 'select', label: `The ${PATH_TITLE(rest.slice(0, j)).toLowerCase()}`, ref: 'path:' + rest.slice(0, j) });
    return {
      ...base,
      kind: 'Hop',
      title: `Hop ${n}: ${h.device}`,
      explanation: [el(doc, 'p', { class: 'small' }, [`${h.ingress ? 'In ' + h.ingress + (h.inAddr ? ' (' + h.inAddr + ')' : '') : 'Starts here'}${h.egress ? ' · out ' + h.egress + (h.outAddr ? ' (' + h.outAddr + ')' : '') : ''}${h.gateway ? ' · next hop ' + h.gateway : ''}`]), el(doc, 'p', { class: 'small muted' }, [h.via.text || 'No route or relation used'])],
      evidence: h.why ? [whyBox(doc, h.why)] : [],
      objects: objectRefs(refs),
      next,
    };
  }
  if (kind === 'rule' && view.rule) {
    const rv = view.rule;
    const box = el(doc, 'div', { class: 'diag-rule', id: 'diag-rule', tabindex: '-1', 'aria-label': `${rv.device} network policy`, 'data-device': rv.device }, [el(doc, 'p', { class: 'small muted' }, [rv.summary])]);
    if (rv.current) box.appendChild(el(doc, 'p', { class: 'small', 'data-current': 'differs' }, [rv.current]));
    if (rv.missing) box.appendChild(el(doc, 'p', { class: 'small' }, [rv.missing]));
    const ol = el(doc, 'ol', { class: 'diag-rules small' });
    for (const r of rv.rows) ol.appendChild(el(doc, 'li', { 'data-rule': String(r.n), ...(r.on ? { class: 'sel-mark', 'aria-current': 'true' } : {}) }, [`Rule ${r.n}: ${r.text}`, r.on ? el(doc, 'strong', {}, [' — decided here']) : '']));
    if (rv.def) ol.appendChild(el(doc, 'li', { 'data-rule': 'default', ...(rv.def.on ? { class: 'sel-mark', 'aria-current': 'true' } : {}) }, [rv.def.text, rv.def.on ? el(doc, 'strong', {}, [' — decided here']) : '']));
    if (ol.childNodes.length) box.appendChild(ol);
    return {
      ...base,
      kind: 'Policy decision',
      title: `${rv.device} · Network policy`,
      explanation: [el(doc, 'p', { class: 'small' }, [rv.missing ? 'The decision named by the evidence can’t be shown.' : 'The rules in order as they were when this was diagnosed (first match wins); the one that decided is marked. Read-only: the configuration is edited in the Inspector.'])],
      evidence: [box],
      objects: [{ ref: 'device:' + rv.device, label: rv.device }],
      next: [],
    };
  }
  return null;
}

/** The whole check as plain text (Copy and Save as text): what, of which model, on what; the verdict and its layers; the hop lists; the assumptions. */
export function traceExportText(o: { title: string; version?: string; outdated: boolean; fingerprint?: string }, run: TraceRun): string {
  const lines = exportHeader({ analysis: 'Communication', title: o.title, info: run.check.info, version: o.version, outdated: o.outdated });
  if (o.fingerprint) lines.push(`Model fingerprint: ${o.fingerprint}`);
  lines.push('');
  // the diagnosis first (the question, the answer, its evidence and limits), then the check and its hops
  if (run.diagnosis) {
    for (const l of diagnosisText({ ...run.diagnosis, outdated: o.outdated })) lines.push(l);
    lines.push('A modeled result: it says what this model (and this simulated run) establish, not how a production network behaves.');
    lines.push('');
  }
  for (const l of commText(run.check)) lines.push(l);
  lines.push('');
  lines.push(traceText(run.trace, run.back));
  lines.push('');
  for (const l of exportFooter(run.check.info)) lines.push(l);
  return lines.join('\n') + '\n';
}

/** The verdict of a trace (for tests and the banner). */
export function traceVerdict(t: Trace): Verdict {
  return traceOutcome(t).verdict;
}

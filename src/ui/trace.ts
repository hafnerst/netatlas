/**
 * The Trace path window (Analyze → Trace path…): the form (source,
 * destination, VRF, service, return direction) and the result, verdict
 * first: whether the source reaches the destination and can use its
 * application or service, layer by layer (addresses, name resolution,
 * network path, policy, listener, what runtime behaviour would need), the
 * effective ends, then the paths as tables, one row per hop: the device,
 * the interface the traffic comes in on and the one it leaves by, their
 * addresses and the next hop, the route or relation used, and the
 * encapsulation; under a hop, the cables, the switches passed and notes;
 * behind "Why?" the hop's decision evidence; a tunnel's traced underlay as
 * numbered rows under its hop (2.1, 2.2 …). The main path, each equal-cost
 * alternative and the return direction are sections of their own, each
 * with its end. Objects are links that select them in the diagram
 * (data-goto). Built from elements and text nodes only; the data comes from
 * analysis/communication.ts and analysis/trace.ts.
 */
import { virtRefText } from '../analysis/trace-virtual';
import { Hop, HopWhy, Path, Trace, TraceRequest, encapText, endStatus, endText, outcomeLines, traceOutcome, traceText } from '../analysis/trace';
import { CommCheck, CommLayer, CommRequest, LAYER_LABEL, commText } from '../analysis/communication';
import { CommIdentity, Handoff, RunComparison } from '../analysis/comm-identity';
import { PathMtu, PathMtuResult } from '../analysis/mtu';
import { namedServices } from '../analysis/listeners';
import { deviceVrfs } from '../analysis/routing';
import { Verdict, exportFooter, exportHeader, verdictMark, verdictText } from '../analysis/result';
import { appProfile } from '../model/applications';
import { Model, deviceInterfaces } from '../model/types';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, limitsDetails, verdictLine } from './analysis-ui';

/** What the form holds (a session setting, never saved). VRF: 'auto' (the source interface's), '' (the default table) or a VRF name. */
export interface TraceForm {
  from: string;
  to: string;
  vrf: string;
  /** what is sent ("tcp/443", "udp/53", "icmp"; empty: from the applications, else not given) */
  service: string;
  /** '' (the ends', or the client application's), '4' or '6' */
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

export interface TracePanelActions extends ContextBarActions {
  input(field: 'from' | 'to' | 'vrf' | 'service' | 'family' | 'back', value: string | boolean): void;
  submit(): void;
  swap(): void;
  exit(): void;
  copy(): void;
  save(): void;
  /** prefill the simulation's action (never sends) */
  handoff(): void;
  /** compare the result with the simulation's send of it */
  compare(): void;
  /** keep it as a saved expectation (the Design checks form, prefilled) */
  saveExpectation(): void;
  /** prefill a send that tests the path MTU (never sends) */
  mtuTest(): void;
  /** take another of the end's addresses */
  pick(field: 'from' | 'to', value: string): void;
}

/** The path MTU (analysis/mtu.ts): the limit and what sets it, then per path, the overheads, what is not known, the assumptions. */
function mtuSection(doc: Document, m: PathMtu, view: TraceViewState, act: TracePanelActions): HTMLElement {
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
  if (m.payload) {
    const b = el(doc, 'button', { type: 'button', class: 'mini', id: 'trace-mtu-test', title: view.handoffBlocked || 'Prefill a send one byte over the limit with Don’t fragment: not sent' }, ['Test the limit in simulation']) as HTMLButtonElement;
    b.disabled = !!view.handoffBlocked;
    b.addEventListener('click', () => act.mtuTest());
    body.appendChild(el(doc, 'p', {}, [b, ' ', el(doc, 'span', { class: 'muted' }, ['The simulation fragments IPv4 without DF, drops a larger packet with DF (and IPv6) with Fragmentation Needed or Packet Too Big, and the sender learns the path MTU.'])]));
  }
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

/** Window-wide state the body needs besides the form and the result. */
export interface TraceViewState {
  formError: string;
  bar: ContextBarState;
  /** why the handoff can't be prepared now ('' it can): no simulation, an outdated result, a stale reference */
  handoffBlocked: string;
  /** why there is nothing to compare with ('' there is: a send of the simulation carries it) */
  compareBlocked: string;
  /** why the model can't be edited now ('' it can) */
  locked: string;
}

/** The window's content: the form, and the result when there is one. */
export function traceWindowBody(doc: Document, model: Model, form: TraceForm, run: TraceRun | null, view: TraceViewState, act: TracePanelActions): HTMLElement {
  const formError = view.formError;
  const box = el(doc, 'div', { class: 'trace-panel' });
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      'Whether a source reaches a destination and can use its application or service, by the routes, adjacencies, policies and listeners of the model. An end is a device, an interface (device:interface), an address, an application (device/application) or a service (device/service). The path is marked in the diagram while this window is open.',
    ]),
  );
  box.appendChild(contextBar(doc, view.bar, act));
  // ---- the form
  const f = el(doc, 'form', { class: 'trace-form', 'aria-label': 'Trace path' }) as HTMLFormElement;
  const list = el(doc, 'datalist', { id: 'trace-ends' });
  for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    list.appendChild(el(doc, 'option', { value: d.id }, [d.label !== d.id ? d.label : '']));
    for (const i of deviceInterfaces(d)) list.appendChild(el(doc, 'option', { value: d.id + ':' + i.id }, [i.addresses.join(', ')]));
    for (const a of d.applications || []) {
      const p = appProfile(a.profile);
      list.appendChild(el(doc, 'option', { value: `${d.id}/${a.id}` }, [`${a.name} — ${p ? p.short : a.profile}${a.port !== undefined && p && p.listener ? ' ' + a.port : ''}`]));
    }
    for (const s of namedServices(d)) list.appendChild(el(doc, 'option', { value: `${d.id}/${s.id}` }, [`${s.label} — ${s.proto.toUpperCase()} ${s.port}`]));
  }
  f.appendChild(list);
  const field = (id: 'from' | 'to', label: string): HTMLElement => {
    const input = el(doc, 'input', {
      id: 'trace-' + id,
      type: 'text',
      list: 'trace-ends',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: id === 'to' ? 'device, interface, address, application or service' : 'device, interface, address or application',
      'data-t': 'trace',
      'data-p': id,
      'data-k': '',
    }) as HTMLInputElement;
    input.value = form[id];
    if (formError && formError.indexOf(id === 'from' ? 'Source' : 'Destination') === 0) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'trace-error');
    }
    input.addEventListener('input', () => act.input(id, input.value));
    return el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-' + id }, [label]), input]);
  };
  const grid = el(doc, 'div', { class: 'tf-grid' });
  grid.appendChild(field('from', 'From'));
  grid.appendChild(field('to', 'To'));
  const vrf = el(doc, 'select', { id: 'trace-vrf', 'data-t': 'trace', 'data-p': 'vrf', 'data-k': '' }) as HTMLSelectElement;
  vrf.appendChild(el(doc, 'option', { value: 'auto' }, ['Source interface’s VRF']));
  for (const v of modelVrfs(model)) vrf.appendChild(el(doc, 'option', { value: v }, [v === '' ? 'Default table' : 'VRF ' + v]));
  if (form.vrf !== 'auto' && !Array.prototype.some.call(vrf.options, (o: HTMLOptionElement) => o.value === form.vrf)) vrf.appendChild(el(doc, 'option', { value: form.vrf }, ['VRF ' + form.vrf]));
  vrf.value = form.vrf;
  vrf.addEventListener('change', () => act.input('vrf', vrf.value));
  // the address family: the ends' own unless one is chosen (an end with both families: the tracer's choice)
  const fam = el(doc, 'select', { id: 'trace-family', 'aria-label': 'Address family', 'data-t': 'trace', 'data-p': 'family', 'data-k': '' }) as HTMLSelectElement;
  for (const [v, t] of [['', 'Any family'], ['4', 'IPv4'], ['6', 'IPv6']]) fam.appendChild(el(doc, 'option', { value: v }, [t]));
  fam.value = form.family || '';
  fam.addEventListener('change', () => act.input('family', fam.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-vrf' }, ['VRF']), el(doc, 'span', { class: 'tf-pair' }, [vrf, fam])]));
  // what is sent: from the applications, or given (a firewall's or a Security gateway's policy decides by it)
  const svc = el(doc, 'input', { id: 'trace-service', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'from the application, or tcp/443, udp/53, icmp', 'aria-describedby': 'trace-service-help', 'data-t': 'trace', 'data-p': 'service', 'data-k': '' }) as HTMLInputElement;
  svc.value = form.service;
  if (formError && formError.indexOf('Service') === 0) {
    svc.setAttribute('aria-invalid', 'true');
    svc.setAttribute('aria-describedby', 'trace-error trace-service-help');
  }
  svc.addEventListener('input', () => act.input('service', svc.value));
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-service' }, ['Service']), svc]));
  grid.appendChild(el(doc, 'p', { class: 'help tf-help', id: 'trace-service-help' }, ['An application or service end gives its own; a firewall’s and a Security gateway’s policy decide by it, and the destination’s listener is checked.']));
  f.appendChild(grid);
  const back = el(doc, 'input', { type: 'checkbox', id: 'trace-back', 'data-t': 'trace', 'data-p': 'back', 'data-k': '' }) as HTMLInputElement;
  back.checked = form.back;
  back.addEventListener('change', () => act.input('back', back.checked));
  f.appendChild(el(doc, 'div', { class: 'tf-check' }, [back, el(doc, 'label', { for: 'trace-back' }, ['Return direction too (reverse routing and path symmetry)'])]));
  const go = el(doc, 'button', { type: 'submit', class: 'primary', id: 'trace-go' }, ['Trace']);
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
  if (!run) return box;
  box.appendChild(resultBody(doc, model, run, view, act));
  return box;
}

/** The result: the verdict, the effective ends, the layers, the paths, the legs, the return direction, the actions. */
function resultBody(doc: Document, model: Model, run: TraceRun, view: TraceViewState, act: TracePanelActions): HTMLElement {
  const c = run.check;
  const t = run.trace;
  const res = el(doc, 'div', { class: 'trace-result' });
  res.appendChild(verdictLine(doc, c.verdict, 'reach', c.headline.replace(/^(Reachable within scope|Indeterminate|Partially reachable|Beyond modeled scope)[,:;]?\s*/, ''), { id: 'trace-verdict', role: 'status', 'data-verdict': c.verdict }));
  // the effective ends (and the other addresses an end could stand for, only when there are several)
  const ends = el(doc, 'dl', { class: 'trace-ends small' });
  const row = (k: string, v: Array<Node | string>): void => {
    ends.appendChild(el(doc, 'dt', {}, [k]));
    ends.appendChild(el(doc, 'dd', {}, v));
  };
  if (c.from) row('From', [c.from.text, pickSelect(doc, model, run, 'from', act)]);
  if (c.to) row('To', [c.to.text, pickSelect(doc, model, run, 'to', act)]);
  if (t.source) row('VRF', [t.source.vrf ? 'VRF ' + t.source.vrf : 'Default table']);
  if (c.service) row('Service', [`${c.service.proto === 'icmp' ? 'ICMP' : c.service.proto.toUpperCase() + ' ' + c.service.port} (${c.serviceSource || 'given'})`]);
  res.appendChild(ends);
  // the layers, each with its evidence on demand
  const ul = el(doc, 'ul', { class: 'comm-layers', 'aria-label': 'What the check established, layer by layer' });
  c.layers.forEach((l, k) => ul.appendChild(layerItem(doc, l, k)));
  res.appendChild(ul);
  // the path MTU: one line, the evidence behind an expansion
  if (run.mtu) res.appendChild(mtuSection(doc, run.mtu, view, act));
  // the paths: the main one open, the equal-cost alternatives behind an expansion
  if (!t.error) {
    t.paths.forEach((p, i) => {
      if (i === 0) res.appendChild(pathSection(doc, 'Main path', 'trace-main', p, t));
    });
    if (t.paths.length > 1) {
      const more = el(doc, 'details', { class: 'trace-alts', open: '' }, [el(doc, 'summary', {}, [`Equal-cost alternatives (${t.paths.length - 1}${t.truncated ? ', more not evaluated' : ''})`])]);
      t.paths.slice(1).forEach((p, i) => more.appendChild(pathSection(doc, `Equal-cost alternative ${i + 1}`, 'trace-alt-' + (i + 1), p, t)));
      res.appendChild(more);
    }
    if (t.truncated) res.appendChild(el(doc, 'p', { class: 'muted small' }, [outcomeLines(traceOutcome(t)).slice(-1)[0]]));
  }
  // a protocol break: the transfer ends at the gateway, which starts the second leg itself
  for (const l of t.legs || []) {
    const sec = el(doc, 'section', { class: 'trace-section trace-leg', 'aria-labelledby': 'trace-leg2-h', 'data-trace-path': 'trace-leg2' });
    sec.appendChild(el(doc, 'h3', { id: 'trace-leg2-h' }, ['Leg 2 (started by the gateway)']));
    sec.appendChild(el(doc, 'p', { class: 'small' }, [l.note]));
    if (l.trace.error || !l.trace.paths[0]) sec.appendChild(el(doc, 'p', { class: 'trace-status stopped' }, [l.trace.error || 'no path']));
    else {
      sec.appendChild(el(doc, 'p', { class: 'muted small' }, [traceSummary(l.trace)]));
      sec.appendChild(hopTable(doc, l.trace.paths[0], 'Leg 2, hop by hop', 'leg2'));
      sec.appendChild(endLine(doc, l.trace.paths[0], l.trace));
    }
    res.appendChild(sec);
  }
  // separate legs of the check: a broker's subscribers, a host name's DNS query
  if (c.legs.length) {
    const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': 'trace-legs-h' });
    sec.appendChild(el(doc, 'h3', { id: 'trace-legs-h' }, ['Separate legs']));
    sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['Checked on their own: what the destination passes on (a broker’s subscribers, over their own connections) or what the source needs first (a DNS query).']));
    const lu = el(doc, 'ul', { class: 'comm-legs' });
    for (const g of c.legs) lu.appendChild(el(doc, 'li', {}, [el(doc, 'span', { class: 'an-chip v-' + g.check.verdict }, [verdictMark(g.check.verdict) + ' ' + verdictText(g.check.verdict, 'reach')]), ' ', g.label, el(doc, 'div', { class: 'muted small' }, [g.check.headline])]));
    sec.appendChild(lu);
    res.appendChild(sec);
  }
  // the return direction: reverse routing, path symmetry, and what is not established
  if (run.back) {
    const b = run.back;
    const rv = c.reverse;
    const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': 'trace-back-h', 'data-trace-path': 'trace-back' });
    sec.appendChild(el(doc, 'h3', { id: 'trace-back-h' }, ['Return path']));
    const bo = traceOutcome(b);
    const items = el(doc, 'ul', { class: 'comm-layers' });
    items.appendChild(el(doc, 'li', { class: 'v-' + bo.verdict }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(bo.verdict) + ' ']), el(doc, 'strong', {}, ['Reverse routing: ']), b.error ? b.error : outcomeLines(bo).join('; ')]));
    const sym = rv ? rv.symmetry : 'not comparable';
    items.appendChild(el(doc, 'li', { class: sym === 'asymmetric' ? 'v-partial' : sym === 'symmetric' ? 'v-satisfied' : 'v-indeterminate' }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [sym === 'asymmetric' ? '⇄ ' : sym === 'symmetric' ? '↩ ' : '? ']), el(doc, 'strong', {}, ['Path symmetry: ']), sym === 'asymmetric' ? 'Asymmetric: the way back crosses other routers' : sym === 'symmetric' ? 'The same routers in reverse' : 'Not compared (a direction does not reach)']));
    items.appendChild(el(doc, 'li', { class: 'v-unsupported' }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, ['– ']), el(doc, 'strong', {}, ['Session: ']), 'not evaluated. The return trace carries no destination port: a TCP session and a stateful firewall’s return decision need the simulation.']));
    sec.appendChild(items);
    if (!b.error && b.paths[0]) {
      sec.appendChild(hopTable(doc, b.paths[0], 'The return path, hop by hop', 'back'));
      sec.appendChild(endLine(doc, b.paths[0], b));
    }
    res.appendChild(sec);
  }
  const copy = el(doc, 'button', { type: 'button', id: 'trace-copy' }, ['Copy as text']);
  copy.addEventListener('click', () => act.copy());
  const save = el(doc, 'button', { type: 'button', id: 'trace-save' }, ['Save as text']);
  save.addEventListener('click', () => act.save());
  const acts = el(doc, 'div', { class: 'tf-actions' }, [copy, save]);
  const ho = run.handoff;
  if (ho) {
    const h = el(doc, 'button', { type: 'button', id: 'trace-handoff', title: view.handoffBlocked || ho.text + ': prefilled, not sent' }, ['Prepare in simulation']) as HTMLButtonElement;
    h.disabled = !!view.handoffBlocked;
    h.addEventListener('click', () => act.handoff());
    acts.appendChild(h);
    if (ho.kind === 'send') {
      const cmp = el(doc, 'button', { type: 'button', id: 'trace-compare', title: view.compareBlocked || 'Compare this result with the simulation’s send of it' }, ['Compare with simulation']) as HTMLButtonElement;
      cmp.disabled = !!view.compareBlocked;
      cmp.addEventListener('click', () => act.compare());
      acts.appendChild(cmp);
    }
  }
  if (run.identity && !c.error) {
    const sx = el(doc, 'button', { type: 'button', id: 'trace-save-exp', title: view.locked || 'Keep this communication as a design requirement (Design checks)' }, ['Save as expectation…']) as HTMLButtonElement;
    sx.disabled = !!view.locked;
    sx.addEventListener('click', () => act.saveExpectation());
    acts.appendChild(sx);
  }
  res.appendChild(acts);
  // what the handoff carries over, and what it can't
  if (ho) {
    const d = el(doc, 'details', { class: 'layer-ev', id: 'trace-carry' }, [el(doc, 'summary', {}, ['What the simulation gets'])]);
    const ul = el(doc, 'ul', { class: 'small' });
    for (const t of ho.carried) ul.appendChild(el(doc, 'li', {}, [t]));
    for (const t of ho.notTransferred) ul.appendChild(el(doc, 'li', { class: 'muted' }, [el(doc, 'strong', {}, ['Not carried over: ']), t]));
    const id = run.identity;
    if (id) for (const e of [id.source, id.destination]) if (e.note) ul.appendChild(el(doc, 'li', { class: 'muted' }, [e.note]));
    d.appendChild(ul);
    res.appendChild(d);
  }
  // the static result beside the simulation's
  if (run.compare) {
    const k = run.compare;
    const sec = el(doc, 'section', { class: 'trace-compare', id: 'trace-compare-res', 'aria-label': 'Compared with the simulation' });
    sec.appendChild(el(doc, 'h4', {}, ['Compared with the simulation']));
    sec.appendChild(el(doc, 'p', { class: 'small', 'data-agree': k.agree ? 'yes' : 'no' }, [el(doc, 'strong', {}, [k.runtime === 'pending' ? 'Not finished: ' : k.agree ? 'They agree: ' : 'They differ: ']), `static analysis ${verdictText(k.expected, 'reach').toLowerCase()}; the simulation ${k.runtime === 'delivered' ? 'delivered it' : k.runtime === 'failed' ? 'did not deliver it' : k.runtime === 'mixed' ? 'delivered some messages' : 'is still sending'}.`]));
    const ul = el(doc, 'ul', { class: 'small' });
    for (const l of k.lines) ul.appendChild(el(doc, 'li', {}, [l]));
    if (k.unexplained) ul.appendChild(el(doc, 'li', { class: 'muted' }, [k.unexplained]));
    for (const r of k.results) ul.appendChild(el(doc, 'li', { class: 'muted' }, [r]));
    sec.appendChild(ul);
    res.appendChild(sec);
  }
  res.appendChild(
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
  res.appendChild(limitsDetails(doc, c.info, ['A Security gateway’s policy, a firewall’s policy (by the service), a VPN gateway’s tunnels and paired ports are considered; NAT for container bridges and the NAT service.']));
  return res;
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

/** A layer as a list item: mark, name, result; the evidence behind an expansion. */
function layerItem(doc: Document, l: CommLayer, k: number): HTMLElement {
  const li = el(doc, 'li', { class: 'v-' + l.verdict, 'data-layer': l.id });
  li.appendChild(el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(l.verdict) + ' ']));
  li.appendChild(el(doc, 'strong', {}, [LAYER_LABEL[l.id] + ': ']));
  li.appendChild(el(doc, 'span', { class: 'sr-only' }, [verdictText(l.verdict, l.id === 'runtime' ? 'check' : 'reach') + '. ']));
  li.appendChild(doc.createTextNode(l.text));
  if (l.detail.length || l.refs.length) {
    const d = el(doc, 'details', { class: 'layer-ev', id: 'layer-ev-' + k }, [el(doc, 'summary', {}, ['Evidence'])]);
    if (l.detail.length) d.appendChild(el(doc, 'ul', { class: 'small' }, l.detail.map((x) => el(doc, 'li', {}, [x]))));
    if (l.refs.length) {
      const refs = el(doc, 'p', { class: 'small' }, ['In the diagram: ']);
      l.refs.forEach((r, i) => refs.appendChild(el(doc, 'span', {}, [i ? ', ' : '', ref(doc, r, r.replace(/^[a-z]+:/, ''))])));
      d.appendChild(refs);
    }
    li.appendChild(d);
  }
  return li;
}

/** One path as a labelled section: its table and its end. */
function pathSection(doc: Document, title: string, id: string, p: Path, t: Trace): HTMLElement {
  const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': id + '-h', 'data-trace-path': id });
  sec.appendChild(el(doc, 'h3', { id: id + '-h' }, [title]));
  sec.appendChild(hopTable(doc, p, `${title}, hop by hop`, id));
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

/** A path as a table: one row per hop (a row of details under it when it has any, and its evidence on demand); a tunnel's underlay as numbered rows. */
function hopTable(doc: Document, p: Path, caption: string, id: string): HTMLElement {
  const table = el(doc, 'table', { class: 'hop-table' });
  table.appendChild(el(doc, 'caption', { class: 'sr-only' }, [caption]));
  table.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, HOP_COLUMNS.map((c) => el(doc, 'th', { scope: 'col' }, [c])))]));
  const tb = el(doc, 'tbody');
  hopRows(doc, tb, p.hops, '', 0, id);
  table.appendChild(tb);
  // "Why?" opens and closes the evidence row under its hop (the button says which, aria-expanded)
  table.addEventListener('click', (e) => {
    const b = (e.target as Element).closest('[data-why]') as HTMLElement | null;
    if (!b) return;
    const r = doc.getElementById(b.getAttribute('aria-controls') as string);
    if (!r) return;
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    r.hidden = !open;
  });
  return el(doc, 'div', { class: 'table-wrap' }, [table]);
}

function hopRows(doc: Document, tb: HTMLElement, hops: Hop[], prefix: string, depth: number, id: string): void {
  hops.forEach((h, k) => {
    const n = `${prefix}${k + 1}`;
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
    const whyId = `why-${id}-${n.replace(/\./g, '-')}`;
    const numCell: Array<Node | string> = [n];
    if (h.why) numCell.push(el(doc, 'button', { type: 'button', class: 'mini why-btn', 'data-why': '', 'aria-expanded': 'false', 'aria-controls': whyId, 'aria-label': `Why hop ${n}?`, title: 'Why this hop: the decision evidence' }, ['Why?']));
    tb.appendChild(
      el(doc, 'tr', { class: 'hop-row' + (depth ? ' hop-under' : ''), 'data-hop': n }, [
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
    if (h.why) {
      const wr = el(doc, 'tr', { class: 'hop-why', id: whyId }, [el(doc, 'td', {}, ['']), el(doc, 'td', { colspan: '6' }, [whyBox(doc, h.why)])]);
      wr.hidden = true;
      tb.appendChild(wr);
    }
    if (h.underlay) hopRows(doc, tb, h.underlay.hops, n + '.', depth + 1, id);
  });
}

/** A hop's decision evidence: the lookup, the route chosen and why, the alternatives, the layer-2 way, the policy, NAT, the tunnel, the stop. */
function whyBox(doc: Document, w: HopWhy): HTMLElement {
  const box = el(doc, 'dl', { class: 'why-box small' });
  const put = (k: string, v: Array<Node | string>): void => {
    box.appendChild(el(doc, 'dt', {}, [k]));
    box.appendChild(el(doc, 'dd', {}, v));
  };
  put('Lookup', [w.lookup]);
  if (w.selected.length) put('Selected', w.selected.map((s, i) => el(doc, 'div', {}, [i ? '' : '', s.ref ? ref(doc, s.ref, s.text) : s.text])));
  if (w.rule) put('Because', [w.rule]);
  if (w.alternatives.length) put('Alternatives', w.alternatives.map((a) => el(doc, 'div', {}, [a.ref ? ref(doc, a.ref, a.text) : a.text, el(doc, 'span', { class: 'muted' }, [` — not used: ${a.detail}`])])));
  if (w.l2) put('Layer 2', [w.l2]);
  if (w.policy.length) put('Policy', w.policy.map((x) => el(doc, 'div', {}, [x])));
  if (w.nat) put('Translation', [w.nat]);
  if (w.tunnel) put('Tunnel', [w.tunnel]);
  if (w.stop) put('Stops', [w.stop]);
  return box;
}

/** The whole check as plain text (Copy and Save as text): what, of which model, on what; the verdict and its layers; the hop lists; the assumptions. */
export function traceExportText(o: { title: string; version?: string; outdated: boolean }, run: TraceRun): string {
  const lines = exportHeader({ analysis: 'Trace path', title: o.title, info: run.check.info, version: o.version, outdated: o.outdated });
  lines.push('');
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


/**
 * The Trace path window (Analyze → Trace path…): the form (source,
 * destination, VRF, return path) and the result as tables, one row per hop:
 * the device, the interface the traffic comes in on and the one it leaves
 * by, their addresses and the next hop, the route or relation used, and the
 * encapsulation; under a hop, the cables, the switches passed and notes; a
 * tunnel's traced underlay as numbered rows under its hop (2.1, 2.2 …).
 * The main path, each equal-cost alternative and the return path are
 * sections of their own, each with its end (reached, or where and why it
 * stops). Objects are links that select them in the diagram (data-goto).
 * Built from elements and text nodes only; the data comes from
 * analysis/trace.ts.
 */
import { virtRefText } from '../analysis/trace-virtual';
import { Hop, Path, Trace, TraceRequest, encapText, endStatus, endText, isAsymmetric } from '../analysis/trace';
import { deviceVrfs, vrfName } from '../analysis/routing';
import { Model, deviceInterfaces } from '../model/types';
import { el } from './dom';

/** What the form holds (a session setting, never saved). VRF: 'auto' (the source interface's), '' (the default table) or a VRF name. */
export interface TraceForm {
  from: string;
  to: string;
  vrf: string;
  back: boolean;
}

export function newTraceForm(): TraceForm {
  return { from: '', to: '', vrf: 'auto', back: false };
}

/** A trace on screen: the request, its result and (when asked for) the return trace. */
export interface TraceRun {
  req: TraceRequest;
  trace: Trace;
  back: Trace | null;
}

/** The request a form makes. */
export function formRequest(f: TraceForm): TraceRequest {
  const req: TraceRequest = { from: f.from.trim(), to: f.to.trim() };
  if (f.vrf !== 'auto') req.vrf = f.vrf;
  return req;
}

export interface TracePanelActions {
  input(field: 'from' | 'to' | 'vrf' | 'back', value: string | boolean): void;
  submit(): void;
  swap(): void;
  exit(): void;
  copy(): void;
  save(): void;
}

/** Every VRF of the model ('' first: the default table). */
export function modelVrfs(model: Model): string[] {
  const s = new Set<string>(['']);
  for (const d of model.devices) for (const v of deviceVrfs(model, d.id)) s.add(v);
  return Array.from(s).sort();
}

/** Short summary of a trace: "Reached hq-log:eno1 in 5 hops · 2 equal-cost paths". */
export function traceSummary(t: Trace): string {
  if (t.error) return t.error;
  const p = t.paths[0];
  if (!p) return 'No path';
  const n = p.hops.length - 1;
  const hops = `${n} hop${n === 1 ? '' : 's'}`;
  const e = p.end;
  const head =
    e.kind === 'reached'
      ? `Reached ${e.device}${e.iface ? ':' + e.iface : ''} in ${hops}`
      : e.kind === 'delivered'
        ? `Delivered into ${e.network || 'the network'} by ${e.device}`
        : e.kind === 'exits'
          ? `Leaves the model at ${e.device}`
          : `Stops at ${e.device} (${reasonLabel(e.reason)})`;
  return head + (t.paths.length > 1 ? ` · ${t.paths.length}${t.truncated ? '+' : ''} equal-cost paths` : '');
}

function reasonLabel(r: string): string {
  const m: { [k: string]: string } = {
    'no-route': 'no route',
    unresolved: 'next hop can’t be resolved',
    'no-adjacency': 'missing adjacency',
    blackhole: 'black hole',
    loop: 'routing loop',
    'not-forwarding': 'does not forward',
    down: 'down',
    'too-long': 'too many hops',
  };
  return m[r] || r;
}

/** The window's content: the form, and the result when there is one. */
export function traceWindowBody(doc: Document, model: Model, form: TraceForm, run: TraceRun | null, formError: string, simulated: boolean, act: TracePanelActions): HTMLElement {
  const box = el(doc, 'div', { class: 'trace-panel' });
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      'The way traffic takes from a source to a destination, by the routes and adjacencies of the model. Each end is a device, an interface (device:interface) or an IP address. The path is marked in the diagram while this window is open.',
    ]),
  );
  if (simulated) box.appendChild(el(doc, 'p', { class: 'sim-in-analysis small', role: 'note' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['◈ ']), 'A simulation is on: the path is traced in the simulated state.']));
  // ---- the form
  const f = el(doc, 'form', { class: 'trace-form', 'aria-label': 'Trace path' }) as HTMLFormElement;
  const list = el(doc, 'datalist', { id: 'trace-ends' });
  for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    list.appendChild(el(doc, 'option', { value: d.id }, [d.label !== d.id ? d.label : '']));
    for (const i of deviceInterfaces(d)) list.appendChild(el(doc, 'option', { value: d.id + ':' + i.id }, [i.addresses.join(', ')]));
  }
  f.appendChild(list);
  const field = (id: 'from' | 'to', label: string): HTMLElement => {
    const input = el(doc, 'input', {
      id: 'trace-' + id,
      type: 'text',
      list: 'trace-ends',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'device, device:interface or address',
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
  grid.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-vrf' }, ['VRF']), vrf]));
  f.appendChild(grid);
  const back = el(doc, 'input', { type: 'checkbox', id: 'trace-back', 'data-t': 'trace', 'data-p': 'back', 'data-k': '' }) as HTMLInputElement;
  back.checked = form.back;
  back.addEventListener('change', () => act.input('back', back.checked));
  f.appendChild(el(doc, 'div', { class: 'tf-check' }, [back, el(doc, 'label', { for: 'trace-back' }, ['Return path too (reveals asymmetric routing)'])]));
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
  // ---- the result
  const t = run.trace;
  const res = el(doc, 'div', { class: 'trace-result' });
  const ok = !!t.paths.length && t.paths[0].end.kind !== 'stopped';
  res.appendChild(el(doc, 'p', { class: 'trace-status ' + (ok ? 'ok' : 'stopped'), role: 'status' }, [el(doc, 'span', { 'aria-hidden': 'true', class: 'ts-mark' }, [ok ? '✓ ' : '✕ ']), traceSummary(t)]));
  if (t.source && t.dest) {
    res.appendChild(
      el(doc, 'p', { class: 'muted small' }, [
        `From ${t.source.device}${t.source.address ? ' (' + t.source.address + ')' : ''} in ${vrfName(t.source.vrf)} to ${t.dest.address}${t.dest.device ? ' (' + t.dest.device + (t.dest.iface ? ':' + t.dest.iface : '') + ')' : ' (not in the model)'}.`,
      ]),
    );
  }
  t.paths.forEach((p, i) => res.appendChild(pathSection(doc, i === 0 ? 'Main path' : `Equal-cost alternative ${i}`, i === 0 ? 'trace-main' : 'trace-alt-' + i, p, t)));
  if (t.truncated) res.appendChild(el(doc, 'p', { class: 'muted small' }, ['More equal-cost paths exist; the first ones are listed.']));
  // the return path
  if (run.back) {
    const b = run.back;
    const asym = !b.error && isAsymmetric(t, b);
    const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': 'trace-back-h' });
    sec.appendChild(el(doc, 'h3', { id: 'trace-back-h' }, ['Return path']));
    const head = b.error ? b.error : asym ? 'Asymmetric: the way back crosses other routers' : b.paths.length && b.paths[0].end.kind === 'reached' && ok ? 'The same routers in reverse' : traceSummary(b);
    sec.appendChild(el(doc, 'p', { class: 'trace-status ' + (asym ? 'asym' : b.paths.length && b.paths[0].end.kind !== 'stopped' ? 'ok' : 'stopped') }, [el(doc, 'span', { 'aria-hidden': 'true', class: 'ts-mark' }, [asym ? '⇄ ' : '↩ ']), head]));
    if (!b.error && b.paths[0]) {
      sec.appendChild(el(doc, 'p', { class: 'muted small' }, [traceSummary(b)]));
      sec.appendChild(hopTable(doc, b.paths[0], 'The return path, hop by hop'));
      sec.appendChild(endLine(doc, b.paths[0], b));
    }
    res.appendChild(sec);
  }
  const copy = el(doc, 'button', { type: 'button', id: 'trace-copy' }, ['Copy as text']);
  copy.addEventListener('click', () => act.copy());
  const save = el(doc, 'button', { type: 'button', id: 'trace-save' }, ['Save as text']);
  save.addEventListener('click', () => act.save());
  res.appendChild(el(doc, 'div', { class: 'tf-actions' }, [copy, save]));
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
  res.appendChild(el(doc, 'p', { class: 'muted small' }, ['A model-based approximation, not a simulation of the protocols: ACLs and firewall policies are not considered, NAT only for container bridges. See Limitations in the README.']));
  box.appendChild(res);
  return box;
}

/** One path as a labelled section: its table and its end. */
function pathSection(doc: Document, title: string, id: string, p: Path, t: Trace): HTMLElement {
  const sec = el(doc, 'section', { class: 'trace-section', 'aria-labelledby': id + '-h', 'data-trace-path': id });
  sec.appendChild(el(doc, 'h3', { id: id + '-h' }, [title]));
  sec.appendChild(hopTable(doc, p, `${title}, hop by hop`));
  sec.appendChild(endLine(doc, p, t));
  return sec;
}

function endLine(doc: Document, p: Path, t: Trace): HTMLElement {
  const stopped = p.end.kind === 'stopped';
  return el(doc, 'p', { class: 'trace-end ' + (stopped ? 'stopped' : 'ok') }, [
    el(doc, 'span', { 'aria-hidden': 'true', class: 'ts-mark' }, [stopped ? '✕ ' : '→ ']),
    el(doc, 'strong', {}, [endStatus(p.end) + ': ']),
    endText(p.end, t.dest ? t.dest.address : ''),
  ]);
}

const ref = (doc: Document, r: string, text: string): HTMLElement => el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': r }, [text]);

/** The columns of a hop table. */
export const HOP_COLUMNS = ['#', 'Device', 'In', 'Out', 'Addresses', 'Route or relation', 'Encapsulation'];

/** A path as a table: one row per hop (and a row of details under it when it has any); a tunnel's underlay as numbered rows. */
function hopTable(doc: Document, p: Path, caption: string): HTMLElement {
  const table = el(doc, 'table', { class: 'hop-table' });
  table.appendChild(el(doc, 'caption', { class: 'sr-only' }, [caption]));
  table.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, HOP_COLUMNS.map((c) => el(doc, 'th', { scope: 'col' }, [c])))]));
  const tb = el(doc, 'tbody');
  hopRows(doc, tb, p.hops, '', 0);
  table.appendChild(tb);
  return el(doc, 'div', { class: 'table-wrap' }, [table]);
}

function hopRows(doc: Document, tb: HTMLElement, hops: Hop[], prefix: string, depth: number): void {
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
    tb.appendChild(
      el(doc, 'tr', { class: 'hop-row' + (depth ? ' hop-under' : ''), 'data-hop': n }, [
        el(doc, 'th', { scope: 'row', class: 'th-n' }, [n]),
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
    if (h.underlay) hopRows(doc, tb, h.underlay.hops, n + '.', depth + 1);
  });
}

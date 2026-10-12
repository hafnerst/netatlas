/**
 * The Analysis tab of the side panel: the Trace path form (source,
 * destination, VRF, return path) and the result as a hop list: each hop's
 * device, ingress and egress interface with their addresses, the next hop,
 * the route or adjacency it used, the encapsulation, and the cables to the
 * next hop; the end of the path (reached, or where and why it stops); the
 * equal-cost alternatives and the return path. Objects are links that
 * select them in the diagram (data-goto). Built from elements and text
 * nodes only; the data comes from analysis/trace.ts.
 */
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
  showPath(i: number): void;
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

/** The tab's content. */
export function tracePanel(doc: Document, model: Model, form: TraceForm, run: TraceRun | null, shownPath: number, formError: string, act: TracePanelActions): HTMLElement {
  const box = el(doc, 'div', { class: 'trace-panel' });
  box.appendChild(el(doc, 'h3', {}, ['Trace path']));
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, ['The way traffic takes from a source to a destination, by the routes and adjacencies of the model. Each end is a device, an interface (device:interface) or an IP address.']),
  );
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
  f.appendChild(field('from', 'From'));
  const swap = el(doc, 'button', { type: 'button', class: 'mini tf-swap', id: 'trace-swap', title: 'Swap source and destination', 'aria-label': 'Swap source and destination' }, ['⇅ Swap']);
  swap.addEventListener('click', () => act.swap());
  f.appendChild(field('to', 'To'));
  const vrf = el(doc, 'select', { id: 'trace-vrf', 'data-t': 'trace', 'data-p': 'vrf', 'data-k': '' }) as HTMLSelectElement;
  vrf.appendChild(el(doc, 'option', { value: 'auto' }, ['Source interface’s VRF']));
  for (const v of modelVrfs(model)) vrf.appendChild(el(doc, 'option', { value: v }, [v === '' ? 'Default table' : 'VRF ' + v]));
  if (form.vrf !== 'auto' && !Array.prototype.some.call(vrf.options, (o: HTMLOptionElement) => o.value === form.vrf)) vrf.appendChild(el(doc, 'option', { value: form.vrf }, ['VRF ' + form.vrf]));
  vrf.value = form.vrf;
  vrf.addEventListener('change', () => act.input('vrf', vrf.value));
  f.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'trace-vrf' }, ['VRF']), vrf]));
  const back = el(doc, 'input', { type: 'checkbox', id: 'trace-back', 'data-t': 'trace', 'data-p': 'back', 'data-k': '' }) as HTMLInputElement;
  back.checked = form.back;
  back.addEventListener('change', () => act.input('back', back.checked));
  f.appendChild(el(doc, 'div', { class: 'tf-check' }, [back, el(doc, 'label', { for: 'trace-back' }, ['Trace the return path too (reveals asymmetric routing)'])]));
  const go = el(doc, 'button', { type: 'submit', class: 'primary', id: 'trace-go' }, ['Trace']);
  const actions = el(doc, 'div', { class: 'tf-actions' }, [go, swap]);
  if (run) {
    const exit = el(doc, 'button', { type: 'button', id: 'trace-exit', title: 'Remove the path from the diagram (Esc)' }, ['Exit trace']);
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
  const res = el(doc, 'section', { class: 'trace-result', 'aria-label': 'Path trace result' });
  const ok = !!t.paths.length && t.paths[0].end.kind !== 'stopped';
  res.appendChild(el(doc, 'p', { class: 'trace-status ' + (ok ? 'ok' : 'stopped'), role: 'status' }, [el(doc, 'span', { 'aria-hidden': 'true', class: 'ts-mark' }, [ok ? '✓ ' : '✕ ']), traceSummary(t)]));
  if (t.source && t.dest) {
    res.appendChild(
      el(doc, 'p', { class: 'muted small' }, [
        `From ${t.source.device}${t.source.address ? ' (' + t.source.address + ')' : ''} in ${vrfName(t.source.vrf)} to ${t.dest.address}${t.dest.device ? ' (' + t.dest.device + (t.dest.iface ? ':' + t.dest.iface : '') + ')' : ' (not in the model)'}.`,
      ]),
    );
  }
  if (t.paths.length > 1) {
    const sw = el(doc, 'div', { class: 'trace-paths', role: 'group', 'aria-label': 'Equal-cost paths' });
    t.paths.forEach((_p, i) => {
      const b = el(doc, 'button', { type: 'button', class: 'mini' + (i === shownPath ? ' active' : ''), 'aria-pressed': i === shownPath ? 'true' : 'false', 'data-trace-path': String(i) }, [i === 0 ? 'Main path' : `Alternative ${i}`]);
      b.addEventListener('click', () => act.showPath(i));
      sw.appendChild(b);
    });
    res.appendChild(sw);
  }
  const shown = t.paths[Math.min(shownPath, t.paths.length - 1)];
  if (shown) {
    res.appendChild(hopList(doc, shown.hops, '', 'trace-hops'));
    res.appendChild(endLine(doc, shown, t));
  }
  if (t.truncated) res.appendChild(el(doc, 'p', { class: 'muted small' }, ['More equal-cost paths exist; the first ones are listed.']));
  // the return path
  if (run.back) {
    const b = run.back;
    const asym = !b.error && isAsymmetric(t, b);
    const head = b.error ? b.error : asym ? 'Asymmetric: the way back crosses other routers' : b.paths.length && b.paths[0].end.kind === 'reached' && ok ? 'The same routers in reverse' : traceSummary(b);
    res.appendChild(el(doc, 'h4', {}, ['Return path']));
    res.appendChild(el(doc, 'p', { class: 'trace-status ' + (asym ? 'asym' : b.paths.length && b.paths[0].end.kind !== 'stopped' ? 'ok' : 'stopped') }, [el(doc, 'span', { 'aria-hidden': 'true', class: 'ts-mark' }, [asym ? '⇄ ' : '↩ ']), head]));
    if (!b.error && b.paths[0]) {
      res.appendChild(el(doc, 'p', { class: 'muted small' }, [traceSummary(b)]));
      res.appendChild(hopList(doc, b.paths[0].hops, '', 'trace-hops trace-back'));
      res.appendChild(endLine(doc, b.paths[0], b));
    }
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
      ' the path; ',
      el(doc, 'span', { class: 'tk tk-alt' }, ['dashed']),
      ' equal-cost alternatives; ',
      el(doc, 'span', { class: 'tk tk-ret' }, ['dotted']),
      ' the return path where it differs; ',
      el(doc, 'span', { class: 'tk tk-stop' }, ['double']),
      ' where it stops.',
    ]),
  );
  res.appendChild(el(doc, 'p', { class: 'muted small' }, ['A model-based approximation, not a simulation of the protocols: ACLs, firewall policies and NAT are not considered. See Limitations in the README.']));
  box.appendChild(res);
  return box;
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

function hopList(doc: Document, hops: Hop[], prefix: string, cls: string): HTMLElement {
  const ol = el(doc, 'ol', { class: cls });
  hops.forEach((h, k) => {
    const n = `${prefix}${k + 1}`;
    const li = el(doc, 'li', { class: 'trace-hop' });
    const head = el(doc, 'div', { class: 'th-head' }, [el(doc, 'span', { class: 'th-n' }, [n + '.']), ' ', ref(doc, 'device:' + h.device, h.device)]);
    if (h.vrf) head.appendChild(el(doc, 'span', { class: 'th-tag' }, ['VRF ' + h.vrf]));
    if (h.ecmp > 1) head.appendChild(el(doc, 'span', { class: 'th-tag' }, [`equal-cost ${h.branch + 1} of ${h.ecmp}`]));
    li.appendChild(head);
    const line = (label: string, kids: Array<Node | string>): void => {
      li.appendChild(el(doc, 'div', { class: 'th-line' }, [el(doc, 'span', { class: 'th-k' }, [label]), ' ', ...kids]));
    };
    if (h.ingress) line('in', [ref(doc, `iface:${h.device}:${h.ingress}`, h.ingress), h.inAddr ? ' ' + h.inAddr : '']);
    if (h.egress) line('out', [ref(doc, `iface:${h.device}:${h.egress}`, h.egress), h.outAddr ? ' ' + h.outAddr : '', h.gateway ? ` → next hop ${h.gateway}` : '']);
    if (h.via.text) {
      const via: Array<Node | string> = [];
      if (h.via.route) via.push(ref(doc, h.via.route, h.via.text));
      else if (h.via.relation && h.via.kind === 'dynamic') {
        const i = h.via.text.indexOf(h.via.relation);
        via.push(h.via.text.slice(0, i), ref(doc, 'relation:' + h.via.relation, h.via.relation), h.via.text.slice(i + h.via.relation.length));
      } else via.push(h.via.text);
      line(h.via.kind === 'local' ? 'here' : h.via.kind === 'none' || h.via.kind === 'blackhole' ? 'stop' : 'by', via);
    }
    if (h.encap.length) {
      const kids: Array<Node | string> = [];
      h.encap.forEach((l, i) => {
        if (i) kids.push(' over ');
        kids.push(l.relation ? ref(doc, 'relation:' + l.relation, l.label) : l.label);
      });
      line('encap', kids);
    }
    if (h.l2.length) {
      const kids: Array<Node | string> = [];
      h.l2.forEach((d, i) => kids.push(i ? ', ' : '', ref(doc, 'device:' + d, d)));
      line('through', kids);
    }
    if (h.links.length) {
      const kids: Array<Node | string> = [];
      h.links.forEach((l, i) => kids.push(i ? ', ' : '', ref(doc, 'link:' + l, l)));
      line(h.links.length > 1 ? 'cables' : 'cable', kids);
    }
    for (const note of h.notes) li.appendChild(el(doc, 'div', { class: 'th-note' }, [note]));
    if (h.underlay) {
      li.appendChild(el(doc, 'div', { class: 'th-line' }, [el(doc, 'span', { class: 'th-k' }, ['underlay']), ' ', `the ${encapText(h.encap)} packet:`]));
      li.appendChild(hopList(doc, h.underlay.hops, n + '.', 'trace-hops trace-under'));
    }
    ol.appendChild(li);
  });
  return ol;
}

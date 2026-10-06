/**
 * Rules for connecting two endpoints in a diagram (right-click, or the
 * keyboard equivalent): which endpoints can take part, which pairs are
 * compatible, and when a new relation would only repeat an existing one.
 * Everything follows the format's validation rules (validation/validate.ts),
 * so a connection made here never introduces an error by its endpoints.
 *
 * Physical view → a physical link (cable):
 *   - an end is a device (the whole device; no port is chosen for it) or a
 *     physical interface of a device; logical interfaces are never cabled;
 *   - a physical interface that already has a cable can't get another one
 *     (one cable per port);
 *   - the two ends must differ; on the same device both must be ports (a
 *     cable between two ports of one device), a device can't be cabled to
 *     itself or to one of its own ports.
 *   Two cables between the same two devices are fine (parallel cables).
 *
 * Logical view → a logical relation:
 *   - an end is a device or one of its logical interfaces (loopback,
 *     virtual, tunnel), as drawn in that view; an interface can take part
 *     in any number of relations;
 *   - the two ends must be on different devices;
 *   - a new relation is a duplicate only when an existing one has the same
 *     endpoints (in order, if unidirectional), protocol, label and
 *     direction, and no underlay (`over`) or attributes of its own; any
 *     difference in purpose or attributes makes it a distinct relation.
 */
import { normalizeProtocol } from './protocols';
import { Endpoint, Model, Relation, endpointText, ifaceKey } from './types';

export type ConnectView = 'physical' | 'logical';

/** The diagram ref of an endpoint ("device:x" or "iface:x:y"). */
export function endpointRef(e: Endpoint): string {
  return e.iface ? `iface:${e.device}:${e.iface}` : 'device:' + e.device;
}

/** The endpoint a diagram ref names, if it names one ("device:x", "iface:x:y"). */
export function endpointOfRef(ref: string): Endpoint | null {
  if (ref.indexOf('device:') === 0) return { device: ref.slice(7) };
  if (ref.indexOf('iface:') === 0) {
    const rest = ref.slice(6);
    const c = rest.indexOf(':');
    return c > 0 ? { device: rest.slice(0, c), iface: rest.slice(c + 1) } : null;
  }
  return null;
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.device === b.device && (a.iface || '') === (b.iface || '');
}

/** What the connection of a view creates. */
export function connectionKind(view: ConnectView): 'link' | 'relation' {
  return view === 'physical' ? 'link' : 'relation';
}

/** How an endpoint is named in messages: "device r1" or "interface r1 eth0". */
export function endpointName(model: Model, e: Endpoint): string {
  if (!e.iface) return `device ${model.index.devices.get(e.device)?.label || e.device}`;
  return `interface ${e.device} ${e.iface}`;
}

/** Why an endpoint can't take part in a connection in this view ('' when it can). */
export function endpointProblem(model: Model, view: ConnectView, e: Endpoint): string {
  if (!model.index.devices.has(e.device)) return `device “${e.device}” is not in the model`;
  if (!e.iface) return '';
  const i = model.index.interfaces.get(ifaceKey(e.device, e.iface));
  if (!i) return `“${endpointText(e)}” is not an interface of the model`;
  if (view === 'physical') {
    if (i.type !== 'physical') return `“${endpointText(e)}” is a logical interface: only physical interfaces are cabled`;
    const used = model.index.ifaceLink.get(ifaceKey(e.device, e.iface));
    if (used !== undefined) return `port “${endpointText(e)}” already has a cable (link “${used}”); one cable per port`;
    return '';
  }
  if (i.type === 'physical') return `“${endpointText(e)}” is a physical interface: in the logical view, relations connect devices and logical interfaces`;
  return '';
}

/** Why the two endpoints can't be connected in this view ('' when they can). */
export function pairProblem(model: Model, view: ConnectView, a: Endpoint, b: Endpoint): string {
  const pa = endpointProblem(model, view, a);
  if (pa) return pa;
  const pb = endpointProblem(model, view, b);
  if (pb) return pb;
  if (sameEndpoint(a, b)) return 'an endpoint cannot be connected to itself';
  if (a.device === b.device) {
    if (view === 'logical') return 'both endpoints are on the same device: a relation connects different devices';
    if (!a.iface || !b.iface) return 'a device cannot be cabled to itself or to one of its own ports';
  }
  return '';
}

/**
 * Every endpoint of the model that could complete a connection from `first`
 * in this view, devices and interfaces, in model order. (Which of them are
 * drawn, and so can be picked, is up to the caller.)
 */
export function compatibleEndpoints(model: Model, view: ConnectView, first: Endpoint): Endpoint[] {
  const out: Endpoint[] = [];
  for (const d of model.devices) {
    const options: Endpoint[] = [{ device: d.id }].concat((view === 'physical' ? d.interfaces : d.logical).map((i) => ({ device: d.id, iface: i.id })));
    for (const e of options) if (!pairProblem(model, view, first, e)) out.push(e);
  }
  return out;
}

export interface RelationDraft {
  protocol: string;
  label?: string;
  direction?: 'bidirectional' | 'unidirectional';
}

/** The existing relation a new one with these endpoints and values would only repeat, if any. */
export function duplicateRelation(model: Model, ends: Endpoint[], draft: RelationDraft): Relation | null {
  const proto = normalizeProtocol(draft.protocol.trim());
  const label = (draft.label || '').trim().toLowerCase();
  const dir = draft.direction || 'bidirectional';
  const key = (es: Endpoint[]): string => {
    const t = es.map(endpointText);
    return (dir === 'unidirectional' ? t : t.slice().sort()).join('\u0000');
  };
  const want = key(ends);
  for (const r of model.relations) {
    if (r.protocol !== proto || r.direction !== dir || (r.label || '').trim().toLowerCase() !== label) continue;
    if (r.over.length || r.attrs.length) continue;
    if (r.endpoints.length === ends.length && key(r.endpoints) === want) return r;
  }
  return null;
}

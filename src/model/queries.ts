/**
 * Pure queries over the network model: reference parsing, existence checks,
 * "what belongs to this object" (used for highlighting) and text search.
 * No layout, rendering or YAML knowledge.
 */
import { deviceNetworks, interfaceNetworks, networkMembers } from './derive';
import { Model, deviceInterfaces, ifaceKey, relationDevices } from './types';

export function splitRef(ref: string): [string, string] {
  const i = ref.indexOf(':');
  return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

export function refExists(model: Model, ref: string): boolean {
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  switch (kind) {
    case 'device':
      return ix.devices.has(id);
    case 'link':
      return ix.links.has(id);
    case 'relation':
    case 'hub':
      return ix.relations.has(id);
    case 'network':
      return ix.networks.has(id);
    case 'group':
      return ix.groups.has(id);
    case 'iface':
      return ix.interfaces.has(id);
    case 'protocol':
      return model.protocols.has(id);
    default:
      return false;
  }
}

/** Everything that should stay highlighted when `ref` is selected. */
export function relatedRefs(model: Model, ref: string): Set<string> {
  const out = new Set<string>([ref]);
  const ix = model.index;
  const [kind, id] = splitRef(ref);
  const addDevice = (d: string): void => {
    out.add('device:' + d);
  };
  const addLink = (lid: string): void => {
    const l = ix.links.get(lid);
    if (!l) return;
    out.add('link:' + lid);
    addDevice(l.a.device);
    addDevice(l.b.device);
    if (l.a.iface) out.add(`iface:${l.a.device}:${l.a.iface}`);
    if (l.b.iface) out.add(`iface:${l.b.device}:${l.b.iface}`);
  };
  // relations carried (directly or transitively) over something
  const carriedOver = (target: string): string[] => {
    const res: string[] = [];
    const queue = [target];
    const seen = new Set<string>();
    while (queue.length) {
      const t = queue.shift() as string;
      for (const r of model.relations) {
        if (r.over.indexOf(t) >= 0 && !seen.has(r.id)) {
          seen.add(r.id);
          res.push(r.id);
          queue.push(r.id);
        }
      }
    }
    return res;
  };
  const addRelation = (rid: string, withUnderlay: boolean): void => {
    const r = ix.relations.get(rid);
    if (!r) return;
    out.add('relation:' + rid);
    out.add('hub:' + rid);
    for (const d of relationDevices(r)) addDevice(d);
    for (const e of r.endpoints) if (e.iface) out.add(`iface:${e.device}:${e.iface}`);
    if (r.network) out.add('network:' + r.network);
    if (!withUnderlay) return;
    // walk the underlay chain: carriers and the links/networks they ride on
    const stack = r.over.slice();
    const seen = new Set<string>();
    while (stack.length) {
      const o = stack.pop() as string;
      if (seen.has(o)) continue;
      seen.add(o);
      if (ix.links.has(o)) addLink(o);
      else if (ix.networks.has(o)) out.add('network:' + o);
      else if (ix.relations.has(o)) {
        addRelation(o, false);
        stack.push(...(ix.relations.get(o) as { over: string[] }).over);
      }
    }
  };

  switch (kind) {
    case 'device': {
      const dv = ix.devices.get(id);
      if (!dv) break;
      if (dv.group) {
        let g = ix.groups.get(dv.group);
        while (g) {
          out.add('group:' + g.id);
          g = g.parent ? ix.groups.get(g.parent) : undefined;
        }
      }
      for (const i of deviceInterfaces(dv)) out.add(`iface:${id}:${i.id}`);
      for (const l of model.links) if (l.a.device === id || l.b.device === id) addLink(l.id);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === id)) addRelation(r.id, false);
      for (const n of deviceNetworks(model, id)) out.add('network:' + n);
      break;
    }
    case 'iface': {
      const inf = ix.interfaces.get(id);
      if (!inf) break;
      addDevice(inf.device);
      // the hierarchy: a child rides on its physical interface (and that port's cable); a port carries its children
      for (const c of inf.children) out.add(`iface:${inf.device}:${c.id}`);
      if (inf.parent) {
        out.add(`iface:${inf.device}:${inf.parent}`);
        const plid = ix.ifaceLink.get(ifaceKey(inf.device, inf.parent));
        if (plid) addLink(plid);
      }
      const lid = ix.ifaceLink.get(id);
      if (lid) {
        addLink(lid);
        for (const r of carriedOver(lid)) addRelation(r, false);
      }
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === inf.device && e.iface === inf.id)) addRelation(r.id, true);
      for (const n of interfaceNetworks(model, inf.device, inf.id)) out.add('network:' + n);
      break;
    }
    case 'link':
      addLink(id);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    case 'hub':
    case 'relation': {
      addRelation(id, true);
      const r = ix.relations.get(id);
      if (r) out.add('protocol:' + r.protocol);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    }
    case 'network': {
      const n = ix.networks.get(id);
      if (!n) break;
      for (const m of networkMembers(model, id)) {
        addDevice(m.device);
        for (const x of m.matches) out.add(`iface:${x.device}:${x.iface}`);
      }
      for (const r of model.relations) if (r.network === id) addRelation(r.id, false);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    }
    case 'group': {
      const inGroup = (gid: string | undefined): boolean => {
        let g = gid ? ix.groups.get(gid) : undefined;
        while (g) {
          if (g.id === id) return true;
          g = g.parent ? ix.groups.get(g.parent) : undefined;
        }
        return false;
      };
      for (const g of model.groups) if (inGroup(g.id)) out.add('group:' + g.id);
      for (const d of model.devices) if (inGroup(d.group)) {
        addDevice(d.id);
        for (const i of deviceInterfaces(d)) out.add(`iface:${d.id}:${i.id}`);
      }
      for (const l of model.links) if (out.has('device:' + l.a.device) && out.has('device:' + l.b.device)) addLink(l.id);
      // the enclosing groups, as for a device
      let up = ix.groups.get(id);
      while (up && up.parent) {
        out.add('group:' + up.parent);
        up = ix.groups.get(up.parent);
      }
      break;
    }
    case 'protocol':
      for (const r of model.relations) if (r.protocol === id) addRelation(r.id, false);
      break;
  }
  return out;
}

export interface SearchHit {
  ref: string;
  label: string;
  kind: string;
}

/** Case-insensitive search over ids, labels, protocols and addresses. */
export function search(model: Model, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<SearchHit & { score: number }> = [];
  const consider = (ref: string, kind: string, label: string, hay: string[]): void => {
    let best = -1;
    for (const s of hay) {
      const t = s.toLowerCase();
      const i = t.indexOf(q);
      if (i < 0) continue;
      const score = t === q ? 3 : i === 0 ? 2 : 1;
      if (score > best) best = score;
    }
    if (best >= 0) hits.push({ ref, kind, label, score: best });
  };
  for (const d of model.devices) {
    const addrs: string[] = [];
    for (const i of deviceInterfaces(d)) addrs.push(...i.addresses);
    consider('device:' + d.id, 'device', d.label, [d.id, d.label, d.type, ...addrs]);
  }
  for (const n of model.networks) consider('network:' + n.id, 'network', n.label, [n.id, n.label, n.vlan !== undefined ? 'vlan ' + n.vlan : '', ...n.cidr]);
  for (const r of model.relations) consider('relation:' + r.id, r.protocol, r.label || r.id, [r.id, r.protocol, r.label || '']);
  for (const l of model.links) consider('link:' + l.id, 'link', l.label || l.id, [l.id, l.label || '', l.cable || '']);
  for (const g of model.groups) consider('group:' + g.id, g.kind || 'group', g.label, [g.id, g.label]);
  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return hits.slice(0, limit).map(({ ref, label, kind }) => ({ ref, label, kind }));
}

/**
 * The selection context shown in the element lists: the selected model
 * entity and the entities *directly* related to it, as refs ("device:x",
 * "link:l", "network:n", "relation:r", "group:g", "protocol:p").
 *
 * Direct means one reference in the model, in either direction:
 * * device   — its own group (not the enclosing ones), links with an end on it,
 *              networks that contain one of its addresses (derived membership), relations
 *              with it or one of its interfaces as an endpoint;
 * * link     — its two end devices, relations carried directly over it (`over`);
 * * network  — its member devices, relations whose `network` is it or that
 *              are carried directly over it;
 * * relation — its endpoint devices, its `network`, the links / networks /
 *              relations in its `over`, relations carried directly over it,
 *              and the protocol defined in the file (`protocols:`) with exactly
 *              its protocol id (built-in definitions have no list entry;
 *              aliases such as ebgp → bgp don't count);
 * * group    — its parent group, its child groups, devices placed directly in it;
 * * protocol — relations using exactly that protocol id.
 * An interface (a port selected in the diagram) selects its device, and its
 * context is that of the port: the link cabled to it, networks containing one
 * of its addresses, and relations that name exactly that interface. A child
 * interface additionally has the link cabled to its physical interface.
 * The relation is symmetric for entities, and a subset of relatedRefs(), which
 * the diagram additionally extends along underlay paths and nested groups.
 */
export interface SelectionContext {
  /** the selected entity (a hub or port is mapped to its relation or device) */
  selected: string;
  /** directly related entities, without `selected` */
  related: Set<string>;
}

export function selectionContext(model: Model, ref: string): SelectionContext | null {
  if (!refExists(model, ref)) return null;
  const ix = model.index;
  let [kind, id] = splitRef(ref);
  if (kind === 'hub') kind = 'relation';
  const rel = new Set<string>();
  const add = (k: string, v: string | undefined): void => {
    if (v !== undefined) rel.add(k + ':' + v);
  };
  const overTarget = (o: string): void => {
    if (ix.links.has(o)) add('link', o);
    else if (ix.networks.has(o)) add('network', o);
    else if (ix.relations.has(o)) add('relation', o);
  };
  let selected = kind + ':' + id;
  switch (kind) {
    case 'device': {
      const d = ix.devices.get(id);
      if (!d) break;
      add('group', d.group);
      for (const l of model.links) if (l.a.device === id || l.b.device === id) add('link', l.id);
      for (const n of deviceNetworks(model, id)) add('network', n);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === id)) add('relation', r.id);
      break;
    }
    case 'iface': {
      const inf = ix.interfaces.get(id);
      if (!inf) break;
      selected = 'device:' + inf.device;
      add('link', ix.ifaceLink.get(id));
      if (inf.parent) add('link', ix.ifaceLink.get(ifaceKey(inf.device, inf.parent)));
      for (const n of interfaceNetworks(model, inf.device, inf.id)) add('network', n);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === inf.device && e.iface === inf.id)) add('relation', r.id);
      break;
    }
    case 'link': {
      const l = ix.links.get(id);
      if (!l) break;
      add('device', l.a.device);
      add('device', l.b.device);
      for (const r of model.relations) if (r.over.indexOf(id) >= 0) add('relation', r.id);
      break;
    }
    case 'network': {
      const n = ix.networks.get(id);
      if (!n) break;
      for (const m of networkMembers(model, id)) add('device', m.device);
      for (const r of model.relations) if (r.network === id || r.over.indexOf(id) >= 0) add('relation', r.id);
      break;
    }
    case 'relation': {
      const r = ix.relations.get(id);
      if (!r) break;
      for (const e of r.endpoints) add('device', e.device);
      add('network', r.network);
      for (const o of r.over) overTarget(o);
      for (const x of model.relations) if (x.over.indexOf(id) >= 0) add('relation', x.id);
      const def = model.protocols.get(r.protocol);
      if (def && def.custom) add('protocol', r.protocol);
      break;
    }
    case 'group': {
      const g = ix.groups.get(id);
      if (!g) break;
      add('group', g.parent);
      for (const x of model.groups) if (x.parent === id) add('group', x.id);
      for (const d of model.devices) if (d.group === id) add('device', d.id);
      break;
    }
    case 'protocol':
      for (const r of model.relations) if (r.protocol === id) add('relation', r.id);
      break;
  }
  rel.delete(selected);
  return { selected, related: rel };
}

export type ContextState = 'selected' | 'related' | 'unrelated';

/** How an entity's list entry is shown for a selection context (null: no selection). */
export function contextState(ctx: SelectionContext | null, ref: string): ContextState | null {
  if (!ctx) return null;
  if (ref === ctx.selected) return 'selected';
  return ctx.related.has(ref) ? 'related' : 'unrelated';
}

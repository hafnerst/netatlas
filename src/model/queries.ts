/**
 * Pure queries over the network model: reference parsing, existence checks,
 * "what belongs to this object" (used for highlighting) and text search.
 * No layout, rendering or YAML knowledge.
 */
import { Model, relationDevices } from './types';

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
      for (const i of dv.interfaces) out.add(`iface:${id}:${i.id}`);
      for (const l of model.links) if (l.a.device === id || l.b.device === id) addLink(l.id);
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === id)) addRelation(r.id, false);
      for (const n of model.networks) if (n.members.some((m) => m.device === id)) out.add('network:' + n.id);
      break;
    }
    case 'iface': {
      const inf = ix.interfaces.get(id);
      if (!inf) break;
      addDevice(inf.device);
      const lid = ix.ifaceLink.get(id);
      if (lid) {
        addLink(lid);
        for (const r of carriedOver(lid)) addRelation(r, false);
      }
      for (const r of model.relations) if (r.endpoints.some((e) => e.device === inf.device && e.iface === inf.id)) addRelation(r.id, true);
      for (const n of model.networks) if (n.members.some((m) => m.device === inf.device && m.iface === inf.id)) out.add('network:' + n.id);
      break;
    }
    case 'link':
      addLink(id);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    case 'hub':
    case 'relation':
      addRelation(id, true);
      for (const r of carriedOver(id)) addRelation(r, false);
      break;
    case 'network': {
      const n = ix.networks.get(id);
      if (!n) break;
      for (const m of n.members) {
        addDevice(m.device);
        if (m.iface) out.add(`iface:${m.device}:${m.iface}`);
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
        for (const i of d.interfaces) out.add(`iface:${d.id}:${i.id}`);
      }
      for (const l of model.links) if (out.has('device:' + l.a.device) && out.has('device:' + l.b.device)) addLink(l.id);
      break;
    }
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
    for (const i of d.interfaces) addrs.push(...i.addresses);
    consider('device:' + d.id, 'device', d.label, [d.id, d.label, d.type, d.model || '', d.mgmt || '', ...addrs]);
  }
  for (const n of model.networks) consider('network:' + n.id, 'network', n.label, [n.id, n.label, n.kind, n.vlan || '', ...n.cidr]);
  for (const r of model.relations) consider('relation:' + r.id, r.protocol, r.label || r.id, [r.id, r.protocol, r.label || '']);
  for (const l of model.links) consider('link:' + l.id, 'link', l.label || l.id, [l.id, l.label || '', l.cable || '']);
  for (const g of model.groups) consider('group:' + g.id, g.kind, g.label, [g.id, g.label]);
  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return hits.slice(0, limit).map(({ ref, label, kind }) => ({ ref, label, kind }));
}

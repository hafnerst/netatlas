/**
 * Focus mode's neighbourhood: the devices within N hops of an object, in a
 * view's sense of "directly connected": cables in the physical view,
 * relations (their endpoints) in the logical view. The object itself gives
 * the start: its devices, by the same direct-relation rules the selection
 * uses (model/queries.ts selectionContext): a device itself, an interface's
 * or route's device, a link's two devices, a relation's endpoints, a
 * network's members, a group's devices (nested groups included), a
 * protocol's relations' endpoints. Pure and deterministic.
 */
import { networkMembers } from '../model/derive';
import { splitRef } from '../model/queries';
import { Model, relationDevices } from '../model/types';

export type FocusView = 'physical' | 'logical';

/** The smallest and largest number of hops focus mode offers. */
export const FOCUS_MIN_HOPS = 1;
export const FOCUS_MAX_HOPS = 3;

/** The devices an object stands for (sorted); empty when it has none or doesn't exist. */
export function focusSeeds(model: Model, ref: string): string[] {
  const ix = model.index;
  let [kind, id] = splitRef(ref);
  if (kind === 'hub') kind = 'relation';
  const out = new Set<string>();
  switch (kind) {
    case 'device':
      if (ix.devices.has(id)) out.add(id);
      break;
    case 'iface': {
      const i = ix.interfaces.get(id);
      if (i) out.add(i.device);
      break;
    }
    case 'route': {
      const r = ix.routes.get(id);
      if (r) out.add(r.device);
      break;
    }
    case 'link': {
      const l = ix.links.get(id);
      if (l) {
        out.add(l.a.device);
        out.add(l.b.device);
      }
      break;
    }
    case 'relation': {
      const r = ix.relations.get(id);
      if (r) for (const d of relationDevices(r)) out.add(d);
      break;
    }
    case 'network':
      if (ix.networks.has(id)) for (const m of networkMembers(model, id)) out.add(m.device);
      break;
    case 'group': {
      const inGroup = (gid: string | undefined): boolean => {
        let g = gid ? ix.groups.get(gid) : undefined;
        while (g) {
          if (g.id === id) return true;
          g = g.parent ? ix.groups.get(g.parent) : undefined;
        }
        return false;
      };
      for (const d of model.devices) if (inGroup(d.group)) out.add(d.id);
      break;
    }
    case 'protocol':
      for (const r of model.relations) if (r.protocol === id) for (const d of relationDevices(r)) out.add(d);
      break;
  }
  return Array.from(out).sort();
}

/** Device → the devices one hop away in a view (cables, or relations), as sorted lists. */
export function hopGraph(model: Model, view: FocusView): Map<string, string[]> {
  const adj = new Map<string, Set<string>>();
  const join = (xs: string[]): void => {
    for (const x of xs) {
      if (!adj.has(x)) adj.set(x, new Set());
      for (const y of xs) if (y !== x) (adj.get(x) as Set<string>).add(y);
    }
  };
  if (view === 'physical') for (const l of model.links) join([l.a.device, l.b.device]);
  else for (const r of model.relations) join(relationDevices(r));
  const out = new Map<string, string[]>();
  adj.forEach((s, k) => out.set(k, Array.from(s).sort()));
  return out;
}

/**
 * The devices within `hops` hops (clamped to 1–3) of the object in a view,
 * with how far each is (0 for the object's own devices). Empty when the
 * object has no device.
 */
export function focusNeighbourhood(model: Model, ref: string, hops: number, view: FocusView): Map<string, number> {
  const n = Math.max(FOCUS_MIN_HOPS, Math.min(FOCUS_MAX_HOPS, Math.round(hops)));
  const dist = new Map<string, number>();
  const seeds = focusSeeds(model, ref);
  for (const s of seeds) dist.set(s, 0);
  const g = hopGraph(model, view);
  let frontier = seeds;
  for (let k = 1; k <= n && frontier.length; k++) {
    const next: string[] = [];
    for (const d of frontier) {
      for (const x of g.get(d) || []) {
        if (dist.has(x)) continue;
        dist.set(x, k);
        next.push(x);
      }
    }
    frontier = next.sort();
  }
  return dist;
}

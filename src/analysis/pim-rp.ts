/**
 * The rendezvous point a PIM sparse-mode router uses for an any-source
 * group, in that router's own context — one definition for the
 * simulation (sim/multicast.ts) and the checks (checks-multicast.ts):
 *
 *   1. its own static RP (its PIM service's `rp`, an address of a router
 *      of the model);
 *   2. else the `rp` of a PIM relation it is an endpoint of (an address,
 *      or a device: that router's address);
 *   3. else the candidate RP (`candidate_rp: yes`) with the highest router
 *      ID among the routers its PIM relations connect it to (its PIM
 *      domain: what the bootstrap router announces there).
 *
 * The address family must be the group's: an IPv6 group never takes an
 * IPv4 RP (a candidate is an IPv6 RP by its first loopback, else interface,
 * IPv6 address). Routers that disagree keep their own (nothing reconciles
 * them into one global RP); rpConflicts lists them. Pure.
 */
import { IpAddr, parseAddress } from '../model/ip';
import { protocolBase } from '../model/protocols';
import { Model, relationDevices } from '../model/types';
import { compareAddr } from './ipmath';

export interface RpChoice {
  dev: string;
  addr: IpAddr;
  how: string;
}

/** What the RP choice reads of the state: who owns an address, a router's IPv4 router ID and IPv6 address, whether it is on. */
export interface RpEnv {
  ownerOf(a: IpAddr): string | null;
  routerId(dev: string): IpAddr | null;
  v6Addr(dev: string): IpAddr | null;
  on?(dev: string): boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pimValue(model: Model, dev: string, key: string): string | undefined {
  const d = model.index.devices.get(dev);
  const s = d ? d.services.find((x) => x.id === 'pim') : undefined;
  return s ? s.values.get(key) : undefined;
}

/** The routers a router's PIM relations connect it to, transitively (its PIM domain). */
export function pimDomain(model: Model, dev: string): Set<string> {
  const dom = new Set<string>([dev]);
  const rels = model.relations.filter((r) => protocolBase(model.protocols, r.protocol) === 'pim');
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rels) {
      const ds = relationDevices(r);
      if (!ds.some((x) => dom.has(x))) continue;
      for (const x of ds)
        if (!dom.has(x)) {
          dom.add(x);
          grew = true;
        }
    }
  }
  return dom;
}

/** A router's own static RP of an address family; 'family' when it has one of the other family; null none. */
export function staticRp(model: Model, env: RpEnv, dev: string, v: 4 | 6): RpChoice | 'family' | null {
  const val = pimValue(model, dev, 'rp');
  const a = val ? parseAddress(val) : null;
  if (!a) return null;
  if (a.version !== v) return 'family';
  const o = env.ownerOf(a);
  return o ? { dev: o, addr: a, how: `the static RP of ${dev}` } : null;
}

function rpAddr(env: RpEnv, dev: string, v: 4 | 6): IpAddr | null {
  return v === 4 ? env.routerId(dev) : env.v6Addr(dev);
}

/** The RP a router uses for a group (see the module comment); null: none there. */
export function rpFor(model: Model, env: RpEnv, dev: string, group: string): RpChoice | null {
  const g = parseAddress(group);
  const v: 4 | 6 = g ? g.version : 4;
  const own = staticRp(model, env, dev, v);
  if (own && own !== 'family') return own;
  for (const r of model.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
    if (protocolBase(model.protocols, r.protocol) !== 'pim' || relationDevices(r).indexOf(dev) < 0) continue;
    const x = r.attrs.find(([k]) => k === 'rp');
    if (!x) continue;
    const a = parseAddress(x[1]);
    if (a) {
      const o = a.version === v ? env.ownerOf(a) : null;
      if (o) return { dev: o, addr: a, how: `the rp of its relation ${r.id}` };
      continue;
    }
    if (model.index.devices.has(x[1])) {
      const ra = rpAddr(env, x[1], v);
      if (ra) return { dev: x[1], addr: ra, how: `the rp of its relation ${r.id}` };
    }
  }
  const dom = pimDomain(model, dev);
  const cands = Array.from(dom)
    .filter((d) => pimValue(model, d, 'candidate_rp') === 'yes' && (!env.on || env.on(d)) && !!rpAddr(env, d, v))
    .map((d) => ({ d, rid: env.routerId(d) }))
    .sort((a, b) => (a.rid && b.rid ? compareAddr(b.rid, a.rid) : 0) || cmp(a.d, b.d));
  if (cands.length) return { dev: cands[0].d, addr: rpAddr(env, cands[0].d, v) as IpAddr, how: 'the candidate RP of its PIM domain with the highest router ID (bootstrap)' };
  return null;
}

/** Routers of one PIM domain whose RPs for a group differ (each pair once, sorted). */
export function rpConflicts(model: Model, env: RpEnv, routers: string[], group: string): Array<{ a: string; b: string; ra: RpChoice; rb: RpChoice }> {
  const out: Array<{ a: string; b: string; ra: RpChoice; rb: RpChoice }> = [];
  const list = routers.slice().sort(cmp);
  for (let i = 0; i < list.length; i++) {
    const ra = rpFor(model, env, list[i], group);
    if (!ra) continue;
    const dom = pimDomain(model, list[i]);
    for (let j = i + 1; j < list.length; j++) {
      if (!dom.has(list[j])) continue;
      const rb = rpFor(model, env, list[j], group);
      if (rb && compareAddr(ra.addr, rb.addr) !== 0) out.push({ a: list[i], b: list[j], ra, rb });
    }
  }
  return out;
}

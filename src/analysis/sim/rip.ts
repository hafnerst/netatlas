/**
 * RIP as the distance-vector protocol it is (RFC 2453; RIPng, RFC 2080,
 * alike): each router holds its own table — per prefix a metric, the
 * neighbour and relation it came from, a timeout — filled only by its
 * neighbours' Responses, never by another router's state.
 *
 *   A Response carries prefixes with their metrics: what the router
 *   originates (its connected networks, or its policy's advertise /
 *   redistribute / default_route: analysis/routing.ts originatedRoutes) with
 *   metric 0, and what it learned, through its export filter. Split
 *   horizon with poisoned reverse: a route goes out of the interface it
 *   came in by with metric 16 (infinity). One Response per interface, to
 *   the RIP group (a Request's answer: to the asking neighbour).
 *   Receiving one: metric + the relation's cost (default 1), at most 16;
 *   through the inbound filter. A new prefix with a metric below 16 is
 *   taken; from the neighbour the route came from, the new metric is
 *   taken whatever it is (16: the route is withdrawn) and the timeout
 *   starts again; from another neighbour, only a lower metric.
 *   Timeout (the profile's, 180 s): a route not refreshed is set to 16 and
 *   deleted after the garbage-collection time (120 s), advertised with 16
 *   meanwhile. The interface a route leaves by going down sets it to 16 at
 *   once; a network the router no longer originates is withdrawn (16).
 *   Every change is sent as a triggered Response after 1 to 5 s (only the
 *   changed routes); the whole table every update interval.
 *
 * The routes a router installs from it are its table's (Engine: the
 * routing context's `dv`), with RIP's distance; nothing propagates RIP over
 * the model's adjacencies. Not modelled: authentication, route tags beyond
 * the origin carried for redistribution loops, the hold-down of some
 * implementations, RIPv1. DOM-free.
 */
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../../model/ip';
import { DvRoute, DvTables, RouteOrigin, originatedRoutes, relParam } from '../routing';
import { filterRoute } from '../../model/routing-policy';
import { prefixText } from '../ipmath';
import { hashIndex } from './engine';
import { ProtocolSim, Sess } from './protocols';

/** RIP's infinity: a metric of 16 is unreachable. */
export const RIP_INFINITY = 16;
/** The garbage-collection timer (RFC 2453 §3.8): a route at 16 is advertised so long, then deleted. */
export const RIP_GARBAGE = 120000;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One entry of a Response: a prefix, its metric, where it was originated (carried for redistribution loops, as a route tag). */
export interface RipEntry {
  prefix: string;
  metric: number;
  origin: RouteOrigin;
}

interface RipRoute {
  net: IpPrefix;
  metric: number;
  /** the relation, neighbour and own interface it came by ('' : one this router originated and withdrew) */
  relation: string;
  peer: string;
  iface: string;
  origin: RouteOrigin;
  /** bumped at every refresh and change: an older timer does nothing */
  gen: number;
  /** at 16, waiting for its garbage collection */
  garbage: boolean;
}

interface RipTable {
  dev: string;
  vrf: string;
  routes: Map<string, RipRoute>;
  /** what it originated when it last looked (a prefix that is no longer there is withdrawn) */
  own: Map<string, { net: IpPrefix; origin: RouteOrigin }>;
  /** the prefixes changed since the last triggered Response, and whether one is due */
  changed: Set<string>;
  triggered: boolean;
}

/** The RIP routers' tables of a simulation (one per device and VRF). */
export class RipSim implements DvTables {
  private tables = new Map<string, RipTable>();
  /** bumped at every change of a table: the routing contexts that read them are made again */
  version = 0;

  constructor(private P: ProtocolSim) {
    P.deviceHooks.push((dev, up) => {
      if (up) return;
      // powered off: its tables are gone (it learns everything again after it boots)
      for (const k of Array.from(this.tables.keys())) if (k.split('\0')[0] === dev) this.tables.delete(k);
      this.version++;
    });
    P.routesHooks.push((dev) => this.ownCheck(dev));
  }

  private table(dev: string, vrf: string): RipTable {
    const k = dev + '\0' + vrf;
    let t = this.tables.get(k);
    if (!t) this.tables.set(k, (t = { dev, vrf, routes: new Map(), own: new Map(), changed: new Set(), triggered: false }));
    return t;
  }

  /** The routes a router holds now (the route computation's view of RIP), sorted. */
  routes(device: string, vrf: string): DvRoute[] {
    const t = this.tables.get(device + '\0' + vrf);
    if (!t) return [];
    const out: DvRoute[] = [];
    for (const r of t.routes.values()) if (r.metric < RIP_INFINITY && r.relation) out.push({ net: r.net, metric: r.metric, relation: r.relation, peer: r.peer, origin: r.origin });
    return out.sort((a, b) => cmp(prefixText(a.net), prefixText(b.net)));
  }

  /** A frozen copy of every table (a route recomputation's state): what they hold now, whatever happens later. */
  frozen(): DvTables {
    const copy = new Map<string, DvRoute[]>();
    for (const t of this.tables.values()) copy.set(t.dev + '\0' + t.vrf, this.routes(t.dev, t.vrf));
    return { routes: (device, vrf) => copy.get(device + '\0' + vrf) || [] };
  }

  /** What the router originates into RIP now, by prefix. */
  private originated(dev: string, vrf: string): Map<string, { net: IpPrefix; origin: RouteOrigin }> {
    const out = new Map<string, { net: IpPrefix; origin: RouteOrigin }>();
    for (const o of originatedRoutes(this.P.m, dev, vrf, 'rip', this.P.e.ctx(dev))) out.set(prefixText(o.net), o);
    return out;
  }

  /** What changed in what the router originates (an interface, a redistributed route): new prefixes and withdrawn ones are sent. */
  ownCheck(dev: string): void {
    for (const t of Array.from(this.tables.values())) {
      if (t.dev !== dev) continue;
      const now = this.originated(dev, t.vrf);
      for (const [k, o] of now) {
        if (!t.own.has(k)) {
          t.own.set(k, o);
          // (one it had learned from a neighbour is its own now)
          t.routes.delete(k);
          this.mark(t, k);
        }
      }
      for (const [k, o] of Array.from(t.own)) {
        if (now.has(k)) continue;
        t.own.delete(k);
        // withdrawn: advertised with 16 for the garbage-collection time
        const r: RipRoute = { net: o.net, metric: RIP_INFINITY, relation: '', peer: '', iface: '', origin: o.origin, gen: 0, garbage: true };
        t.routes.set(k, r);
        this.collect(t, k, r);
        this.mark(t, k);
      }
    }
  }

  /** A session's table (made with what the router originates). */
  private of(s: Sess): RipTable {
    const t = this.table(s.dev, s.local.l3.vrf);
    if (!t.own.size && !t.routes.size) for (const [k, o] of this.originated(s.dev, s.local.l3.vrf)) t.own.set(k, o);
    return t;
  }

  /**
   * The entries of a Response out of a session's interface: everything (a
   * periodic update, an answer to a Request) or the prefixes given (a
   * triggered update); poisoned reverse out of the interface a route came
   * in by; the export filter (towards the session's neighbour).
   */
  entries(s: Sess, only?: Set<string>): RipEntry[] {
    const t = this.of(s);
    const pol = this.policy(s.dev);
    const out: RipEntry[] = [];
    const add = (k: string, net: IpPrefix, metric: number, origin: RouteOrigin): void => {
      if (only && !only.has(k)) return;
      if (pol && pol.export.length && !filterRoute(pol.export, net, s.peer, 'export').permit) return;
      out.push({ prefix: k, metric, origin });
    };
    for (const [k, o] of t.own) add(k, o.net, 0, o.origin);
    for (const [k, r] of t.routes) {
      if (t.own.has(k)) continue;
      add(k, r.net, r.iface === s.local.l3.id ? RIP_INFINITY : r.metric, r.origin);
    }
    return out.sort((a, b) => cmp(a.prefix, b.prefix));
  }

  private policy(dev: string): { export: Parameters<typeof filterRoute>[0]; import: Parameters<typeof filterRoute>[0] } | undefined {
    const d = this.P.m.index.devices.get(dev);
    const svc = d ? d.services.find((x) => x.id === 'rip') : undefined;
    return svc && svc.policy ? svc.policy : undefined;
  }

  /** A Response from a session's neighbour: its entries go into the router's table as RIP says (see the module comment). */
  response(s: Sess, entries: RipEntry[]): void {
    const t = this.of(s);
    const cost = Math.max(1, Math.min(15, Number(relParam(s.rel, 'cost', s.dev)) || 1));
    const pol = this.policy(s.dev);
    const timeout = this.P.timer(s, s.profile, 'dead');
    let learned = 0;
    for (const e of entries) {
      const net = parsePrefix(e.prefix);
      if (!net || t.own.has(e.prefix)) continue;
      if (pol && pol.import.length && !filterRoute(pol.import, net, s.peer, 'import').permit) continue;
      const m = Math.min(RIP_INFINITY, e.metric + cost);
      const cur = t.routes.get(e.prefix);
      const same = !!cur && cur.relation === s.rel.id && cur.peer === s.peer;
      if (!cur || (cur.garbage && !same && m < RIP_INFINITY)) {
        if (m >= RIP_INFINITY) continue;
        const r: RipRoute = { net, metric: m, relation: s.rel.id, peer: s.peer, iface: s.local.l3.id, origin: e.origin, gen: 0, garbage: false };
        t.routes.set(e.prefix, r);
        this.refresh(t, e.prefix, r, timeout.ms, timeout.text);
        this.mark(t, e.prefix);
        learned++;
        continue;
      }
      if (same) {
        if (m < RIP_INFINITY) this.refresh(t, e.prefix, cur, timeout.ms, timeout.text);
        if (m !== cur.metric) {
          cur.metric = m;
          cur.origin = e.origin;
          if (m >= RIP_INFINITY) {
            this.collect(t, e.prefix, cur);
            this.P.e.note('route', 'rip', s.dev, s.peer, 'withdrawn', '', `${s.dev}: ${e.prefix} is unreachable through ${s.peer} (metric 16 in its Response): set to 16, deleted after ${RIP_GARBAGE / 1000} s`);
          } else cur.garbage = false;
          this.mark(t, e.prefix);
          learned++;
        }
        continue;
      }
      if (m < cur.metric) {
        cur.metric = m;
        cur.relation = s.rel.id;
        cur.peer = s.peer;
        cur.iface = s.local.l3.id;
        cur.origin = e.origin;
        cur.garbage = false;
        this.refresh(t, e.prefix, cur, timeout.ms, timeout.text);
        this.mark(t, e.prefix);
        learned++;
      }
    }
    if (learned) this.P.e.note('route', 'rip', s.dev, s.peer, 'learned', '', `${s.dev} learned from ${s.peer} (RIP Response): ${learned} route${learned === 1 ? '' : 's'} changed; its routes follow after its route recomputation delay`);
  }

  /** The route was heard again: its timeout starts again. */
  private refresh(t: RipTable, k: string, r: RipRoute, ms: number, text: string): void {
    const g = ++r.gen;
    this.P.e.after(ms, () => {
      if (r.gen !== g || t.routes.get(k) !== r || r.garbage) return;
      r.metric = RIP_INFINITY;
      this.collect(t, k, r);
      this.P.e.note('route', 'rip', t.dev, r.peer, 'timed out', '', `${t.dev}: ${k} from ${r.peer} timed out (${text} without a Response bringing it): set to 16, deleted after ${RIP_GARBAGE / 1000} s`);
      this.mark(t, k);
    });
  }

  /** At 16: advertised so for the garbage-collection time, then deleted. */
  private collect(t: RipTable, k: string, r: RipRoute): void {
    r.garbage = true;
    const g = ++r.gen;
    this.P.e.after(RIP_GARBAGE, () => {
      if (r.gen === g && t.routes.get(k) === r) t.routes.delete(k);
    });
  }

  /** A session's interface went down: what the router learned through it is unreachable at once. */
  ifaceDown(s: Sess): void {
    const t = this.tables.get(s.dev + '\0' + s.local.l3.vrf);
    if (!t) return;
    for (const [k, r] of t.routes) {
      if (r.relation !== s.rel.id || r.peer !== s.peer || r.metric >= RIP_INFINITY) continue;
      r.metric = RIP_INFINITY;
      this.collect(t, k, r);
      this.mark(t, k);
    }
    this.ownCheck(s.dev);
  }

  /** A Response out of a session's interface, to the RIP group (224.0.0.9, ff02::9). */
  send(s: Sess, what: string, list: RipEntry[]): void {
    const group = parseAddress(s.local.addr.version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string)) as IpAddr;
    this.P.multicast(s, group, 'Response', `${what}: ${list.length ? list.map((e) => `${e.prefix} metric ${e.metric}`).join(', ') : 'no routes'}`, { rip: list });
  }

  /** A change: the routes are computed again (after the recomputation delay) and a triggered Response goes out soon. */
  private mark(t: RipTable, k: string): void {
    t.changed.add(k);
    this.version++;
    this.P.e.dynamicChanged();
    this.P.e.recomputeSoon(t.dev);
    if (t.triggered) return;
    t.triggered = true;
    // RFC 2453 §3.10.1: a random delay of 1 to 5 s (here from the router and the moment: no random stream is used)
    const wait = 1000 + hashIndex(`${t.dev}|${t.vrf}|${Math.floor(this.P.e.now)}`, 4000);
    this.P.e.after(wait, () => {
      t.triggered = false;
      const only = new Set(t.changed);
      t.changed.clear();
      if (!this.tables.has(t.dev + '\0' + t.vrf) || !this.P.e.deviceOn(t.dev)) return;
      // one Response per relation and interface, to the group (as the periodic ones)
      const done = new Set<string>();
      for (const s of this.P.sessionsOf(t.dev).filter((x) => x.protocol === 'rip' && x.local.l3.vrf === t.vrf && x.x.started).sort((a, b) => cmp(a.key, b.key))) {
        const k = s.rel.id + '|' + s.local.l3.id;
        if (done.has(k) || !this.P.e.isL3Up(s.dev, s.local.l3.id)) continue;
        done.add(k);
        const list = this.entries(s, only);
        if (list.length) this.send(s, 'triggered update', list);
      }
    });
  }
}

/**
 * Which simulated traffic belongs to an experiment (analysis/sim/experiment.ts):
 * the messages its actions send and what they need on the way, so that the
 * diagram can show only those while the experiment plays (the rest still
 * runs; it is hidden, never faked away). DOM-free.
 *
 * A message (a flight: one hop of it) is relevant by causal ownership, not by
 * its protocol or its sender alone:
 *
 *   1. an operation of the experiment: a send's messages, a join's reports,
 *      a stream's datagrams and every copy of them, an application's
 *      exchanges (the id they carry);
 *   2. the continuation of a relevant message (the next cable, the copy a
 *      switch forwards: its parent);
 *   3. what a relevant message caused within the same exchange: a router
 *      forwarding it, the answer to it (the engine gives both the exchange's
 *      initiator as their origin); and the address resolution it needs (an
 *      ARP or neighbor request, and its reply);
 *   4. the prerequisite and maintenance traffic of the experiment's devices
 *      that nothing above covers, started by a device on its own (a timer,
 *      a boot): a host's DHCP, router solicitation, duplicate address
 *      detection, DNS and gratuitous ARP; the queries of the multicast
 *      routers and snooping switches of a receiver's or a sender's LAN; the
 *      sessions of a protocol an observation reads; the timing exchanges of
 *      a timing observation. Each device has its own protocols here: a
 *      device's other traffic is not the experiment's.
 *
 * What is outside these is unrelated: hidden while the experiment plays. A
 * host answering a router's query (its own report, sent on its own timer) is
 * relevant only when the host is one of the experiment's, so a relevant
 * message never pulls in a whole LAN, and a connected network never pulls in
 * the whole architecture.
 */
import { Experiment, actionDef, observeDef } from '../../model/experiments';
import { Model } from '../../model/types';
import { capabilities } from '../../model/capabilities';
import { autoIpv6 } from '../../model/ipv6';
import { serviceOf } from '../../model/services';
import { serviceDependencies } from '../dependencies';
import { Flight } from './types';

/** What a device's own traffic counts for the experiment: these protocols, started by the device itself. */
export interface RelevanceSpec {
  devices: Map<string, Set<string>>;
  /** why each device is the experiment's ("target of action 2", "h1’s DHCP server") */
  why: Map<string, string>;
}

/** the protocols of a host the experiment acts on or observes: getting an address, resolving, being found */
const HOST = ['arp', 'ndp', 'garp', 'dhcp', 'dhcpv6', 'dns'];
const MCAST = ['igmp', 'mld', 'pim'];
/** what a provider (a DHCP or DNS server, a peer, a broker) sends on its own that the experiment needs: nothing (its answers are caused by the requests: rule 3) */
const PROVIDER: string[] = [];
/** a router's router advertisements and DHCPv6 answers, for a host that configures IPv6 by them */
const V6ROUTER = ['ndp', 'dhcpv6'];

const split = (t: string): string => t.split(/[:/]/)[0];

/** The devices and protocols an experiment's own traffic comes from (rule 4 above). */
export function relevanceSpec(model: Model, e: Experiment, domainOf?: (dev: string, iface: string) => string[]): RelevanceSpec {
  const isRouter = (d: string): boolean => {
    const x = model.index.devices.get(d);
    return !!x && capabilities(x).l3Forward;
  };
  const devices = new Map<string, Set<string>>();
  const why = new Map<string, string>();
  const add = (dev: string, protos: string[], because: string): void => {
    if (!dev || !model.index.devices.has(dev)) return;
    let s = devices.get(dev);
    if (!s) devices.set(dev, (s = new Set()));
    for (const p of protos) s.add(p);
    if (!why.has(dev)) why.set(dev, because);
  };
  const end = (t: string, because: string): void => {
    if (!t) return;
    const dev = split(t);
    add(dev, HOST, because);
    // a host that configures IPv6 by advertisements: the routers of its LAN advertise (SLAAC, DHCPv6)
    const md = model.index.devices.get(dev);
    const c = t.indexOf(':');
    for (const i of md && domainOf ? md.interfaces || [] : []) {
      if ((c > 0 && i.id !== t.slice(c + 1)) || !autoIpv6(i.ipv6)) continue;
      for (const x of (domainOf as (d: string, i: string) => string[])(dev, i.id)) if (x !== dev && isRouter(x)) add(x, V6ROUTER, `advertises IPv6 to ${dev}:${i.id}`);
    }
    const sl = t.indexOf('/');
    if (sl > 0) {
      // (an application's own messages carry the experiment's ids: rule 1; its peer's or broker's answers follow them: rule 3)
      const id = t.slice(sl + 1);
      const d = model.index.devices.get(dev);
      const a = d ? (d.applications || []).find((x) => x.id === id) : undefined;
      if (a && a.peer) add(split(a.peer), PROVIDER, `${dev}/${id}’s peer`);
      if (a && a.broker) add(split(a.broker), PROVIDER, `${dev}/${id}’s broker`);
    }
  };
  const multicast = (t: string, because: string): void => {
    const dev = split(t);
    add(dev, MCAST.concat(['mcast']), because);
    const c = t.indexOf(':');
    // the queriers and snooping switches of its LAN
    if (domainOf && c > 0) for (const d of domainOf(dev, t.slice(c + 1))) if (d !== dev) add(d, MCAST, `in the LAN of ${t}`);
  };
  e.actions.forEach((a, k) => {
    const def = actionDef(a.do);
    if (!def || !a.target) return;
    const because = `the target of action ${k + 1}`;
    if (def.target === 'failable') {
      // what fails is the experiment's: its own state, not its traffic
      if (model.index.devices.has(a.target)) add(a.target, ['garp'], because);
      return;
    }
    end(a.target, because);
    if (a.to) end(a.to, `the destination of action ${k + 1}`);
    if (a.group) multicast(a.target, because);
  });
  e.observations.forEach((o, k) => {
    const def = observeDef(o.of);
    if (!def || !o.target || def.target === 'expectations' || def.target === 'step') return;
    const because = `observed by observation ${k + 1}`;
    if (o.of === 'session') {
      add(o.target, PROVIDER.concat(o.protocol ? [o.protocol] : []), because);
      if (o.to) add(o.to, PROVIDER.concat(o.protocol ? [o.protocol] : []), `the peer in observation ${k + 1}`);
      return;
    }
    if (o.of === 'timing') {
      const ps = o.protocol ? [o.protocol] : ['ptp', 'ntp'];
      add(o.target, PROVIDER.concat(ps), because);
      // its time sources and the clocks on the way: the devices that run that timing protocol (its domain's announcements, syncs, polls)
      for (const d of model.devices) for (const p of ps) if (d.id !== o.target && (serviceOf(d, p) || (!!d.appServices && d.appServices.has(p)))) add(d.id, [p], `runs ${p.toUpperCase()} (a time source of ${o.target} or a clock on its way)`);
      return;
    }
    if (o.of === 'member') {
      add(o.target, MCAST, because);
      return;
    }
    end(o.target, because);
    if (o.to && (o.of === 'reach' || o.of === 'neighbor' || o.of === 'route')) end(o.to, `the destination of observation ${k + 1}`);
    if (o.group || o.of === 'receive') multicast(o.target, because);
  });
  // the providers of the experiment's hosts: DHCP and DNS servers, brokers
  const hosts = Array.from(devices.keys());
  for (const d of serviceDependencies(model).filter((x) => hosts.indexOf(x.consumer) >= 0 && (x.kind === 'dhcp' || x.kind === 'dns'))) for (const opt of d.options) if (opt.provider) add(opt.provider, PROVIDER, `${d.consumer}’s ${d.kind === 'dhcp' ? 'DHCP' : 'DNS'} server`);
  return { devices, why };
}

export type RelevanceClass = 'action' | 'prerequisite';

/**
 * The classification of the flights, as they are sent (in order): each one
 * once, remembered by id for what it causes and continues. `owns` says
 * whether an operation id (a flight's `test`) is the experiment's.
 */
export class Relevance {
  private seen = new Map<number, RelevanceClass | null>();
  /** the exchange each relevant flight belongs to (its origin) */
  private origins = new Map<number, string | undefined>();
  /** and its protocol (a resolution's reply releases a packet without owning it) */
  private protocols = new Map<number, string>();
  /** relevant flights by kind, since the start (tests and the panel's note) */
  readonly counts = { action: 0, prerequisite: 0, hidden: 0 };

  constructor(
    readonly spec: RelevanceSpec,
    private owns: (op: number) => boolean,
  ) {}

  /** Is a flight the experiment's, and how (null: unrelated)? */
  classify(f: Flight): RelevanceClass | null {
    const k = this.seen.get(f.id);
    if (k !== undefined) return k;
    const c = this.decide(f);
    this.seen.set(f.id, c);
    if (c) {
      this.counts[c]++;
      this.origins.set(f.id, f.origin);
      this.protocols.set(f.id, f.protocol);
    }
    else this.counts.hidden++;
    // (a bounded memory: what is long gone is forgotten)
    if (this.seen.size > 60000) {
      const keys = Array.from(this.seen.keys()).slice(0, 20000);
      for (const x of keys) {
        this.seen.delete(x);
        this.origins.delete(x);
        this.protocols.delete(x);
      }
    }
    return c;
  }

  private decide(f: Flight): RelevanceClass | null {
    // 1. an operation of the experiment
    if (f.test !== undefined && this.owns(f.test)) return 'action';
    // 2. the next hop of a relevant message
    if (f.parent !== undefined) {
      const p = this.seen.get(f.parent);
      if (p) return p;
    }
    // 3. what a relevant message caused: its exchange (forwarded, answered), its address resolution
    if (f.cause !== undefined) {
      const c = this.seen.get(f.cause);
      if (c) {
        const resolving = (p: string): boolean => p === 'arp' || p === 'ndp';
        if (resolving(f.protocol)) return 'prerequisite';
        // (a packet that an address resolution released is not the resolution's: it belongs to whatever it is)
        if (!resolving(this.protocols.get(f.cause) || '') && f.origin !== undefined && this.origins.get(f.cause) === f.origin) return c;
      }
    }
    // 4. a device of the experiment on its own: its prerequisite and maintenance traffic
    const dev = f.origin !== undefined ? f.origin : f.sender;
    const protos = dev !== undefined ? this.spec.devices.get(dev) : undefined;
    if (protos && f.cause === undefined && f.parent === undefined && (protos.has(f.protocol) || (!!f.encapProtocols && f.encapProtocols.some((p) => protos.has(p))))) return f.test !== undefined ? null : 'prerequisite';
    return null;
  }
}

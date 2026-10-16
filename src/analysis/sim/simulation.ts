/**
 * The protocol simulation of a model (Simulate → Start simulation): the
 * engine (engine.ts) with every protocol's behaviour, started like a
 * freshly booted network. The window and the animation use this facade
 * only. Deterministic: the same model, the same actions at the same
 * simulated times, the same timeline. It never changes the model.
 */
import { SimGroup, simProfile } from '../../model/sim-profiles';
import { Model } from '../../model/types';
import { capabilities } from '../../model/capabilities';
import { deviceTypeLine } from '../../model/device-types';
import { failableRef } from '../failure';
import { formatAddr } from '../ipmath';
import { Engine, EngineOptions, fmtSec, subnetBroadcast } from './engine';
import { OTHER_BEHAVIOURS, installBootGarp, installCustomL2, installDemands, installFhrp, installL2Adverts, installLacp } from './proto-other';
import { ROUTING_BEHAVIOURS } from './proto-routing';
import { ProtocolSim, relationProfile } from './protocols';
import { ParamChange, ParamValue, Resolved, SimParams, durationText } from './params';
import { Multicast } from './multicast';
import { DnsCacheRow, LeaseRow, NetServicesSim, ZoneRow } from './netsvc';
import { Test, TestKind, Transport } from './transport';
import { ArpRow, ConnRow, Flight, GridTable, MacRow, NetEvent, SessionRow, SessionStatus, SimEvent, TableTimer } from './types';


/** The groups of the protocol checkboxes, in their order (Start simulation…, the Simulation setup panel). */
export type SimEntryGroup = SimGroup | 'Multicast' | 'Traffic';
export const ENTRY_GROUPS: readonly SimEntryGroup[] = ['Layer 2', 'Routing', 'Redundancy', 'Tunnels and overlays', 'Multicast', 'Services', 'Traffic', 'Custom'];

/** A protocol of the simulation as the setup lists it (a checkbox), with what in the model uses it. */
export interface SimProtocolEntry {
  id: string;
  label: string;
  group: SimEntryGroup;
  /** how many devices, relations, demands or streams use it */
  uses: number;
  /** what `uses` counts: "device", "relation", "demand", "stream" */
  unit: 'device' | 'relation' | 'demand' | 'stream';
}

/** "3 relations", "1 device". */
export function usesText(e: SimProtocolEntry): string {
  return `${e.uses} ${e.unit}${e.uses === 1 ? '' : 's'}`;
}

/** An interface a test can be sent from: its address, or its DHCP lease and state. */
export interface TestSourceIface {
  id: string;
  /** a DHCP client interface (its address is a lease) */
  dhcp: boolean;
  /** it has an address now */
  ready: boolean;
  /** its address, or its lease with gateway, DNS and expiry, or why it has none; and its Wi-Fi network */
  status: string;
}

/** A device as a source of Send test…: every device is one, able to send or with the reason it can't. */
export interface TestSource {
  id: string;
  /** it can send a test (now, or once its DHCP lease is there) */
  ok: boolean;
  /** why it can't; or, able to, what it waits for ('' nothing) */
  reason: string;
  ifaces: TestSourceIface[];
}

const DHCP_STATE: { [k: string]: string } = { INIT: 'about to ask', SELECTING: 'asking (DHCPDISCOVER)', REQUESTING: 'requesting the offered address', RENEWING: 'renewing', REBINDING: 'rebinding' };

export class Simulation {
  readonly engine: Engine;
  readonly protocols: ProtocolSim;
  readonly transport: Transport;
  readonly multicast: Multicast;
  /** DHCP and DNS: the servers' scopes and zones, the clients, the resolvers */
  readonly netsvc: NetServicesSim;
  readonly model: Model;

  constructor(model: Model, opts: EngineOptions = {}) {
    this.model = model;
    this.engine = new Engine(model, opts);
    this.protocols = new ProtocolSim(this.engine, { ...ROUTING_BEHAVIOURS, ...OTHER_BEHAVIOURS });
    installBootGarp(this.protocols);
    installFhrp(this.protocols);
    installLacp(this.protocols);
    installL2Adverts(this.protocols);
    installDemands(this.protocols);
    installCustomL2(this.protocols);
    this.multicast = new Multicast(this.protocols);
    this.multicast.install();
    this.netsvc = new NetServicesSim(this.protocols);
    this.transport = new Transport(this.protocols);
    this.transport.multicast = this.multicast;
    this.transport.netsvc = this.netsvc;
    this.netsvc.onLeaseFailed = (dev, iface, why) => this.transport.leaseFailed(dev, iface, why);
    this.transport.install();
    this.protocols.start();
  }

  /** The simulated time (ms). */
  get now(): number {
    return this.engine.now;
  }

  /** Run to simulated time t (ms). */
  runTo(t: number): void {
    this.engine.run(t);
  }

  /** Step: to the next moment something happens (at most `max` ms ahead); returns the new time. */
  step(max = 5000): number {
    const n = this.engine.nextTime();
    const t = n === null ? this.engine.now + max : Math.min(Math.max(n, this.engine.now), this.engine.now + max);
    this.engine.run(t);
    return this.engine.now;
  }

  // ------------------------------------------------------------ network events (several at once)

  /** Fail a cable or relation ("link:x", "relation:x"). */
  fail(ref: string): boolean {
    if (!failableRef(this.model, ref) || (ref.indexOf('link:') !== 0 && ref.indexOf('relation:') !== 0)) return false;
    return this.engine.fail(ref);
  }

  restore(ref: string): boolean {
    return this.engine.restore(ref);
  }

  /** Start flapping a cable ("link:x") or a cabled port's cable ("iface:dev:port"). */
  startFlap(ref: string): boolean {
    return this.engine.startFlap(ref);
  }

  stopFlap(ref: string): boolean {
    return this.engine.stopFlap(ref);
  }

  shut(dev: string, iface: string): boolean {
    return this.engine.shut(dev, iface);
  }

  noShut(dev: string, iface: string): boolean {
    return this.engine.noShut(dev, iface);
  }

  powerOff(dev: string): boolean {
    return this.engine.powerOff(dev);
  }

  powerOn(dev: string): boolean {
    return this.engine.powerOn(dev);
  }

  /** Stop a device's container engine (its containers and container networks stop). */
  stopEngine(dev: string): boolean {
    return this.engine.stopEngine(dev);
  }

  /** Start a device's container engine again (its containers as their restart policy says). */
  startEngine(dev: string): boolean {
    return this.engine.startEngine(dev);
  }

  /** End an event of the list (Restore, Stop flapping, No shut, Power on, Start engine). */
  end(ev: NetEvent): boolean {
    const id = ev.ref.slice(ev.ref.indexOf(':') + 1);
    if (ev.kind === 'fail') return this.restore(ev.ref);
    if (ev.kind === 'engine') return this.startEngine(id);
    if (ev.kind === 'flap') return this.stopFlap(ev.ref);
    if (ev.kind === 'shut') {
      const i = id.indexOf(':');
      return this.noShut(id.slice(0, i), id.slice(i + 1));
    }
    if (ev.kind === 'join' || ev.kind === 'leave' || ev.kind === 'stream' || ev.kind === 'stopped') {
      const i = id.indexOf(':');
      const dev = id.slice(0, i);
      const iface = id.slice(i + 1);
      const g = ev.group || '';
      if (ev.kind === 'join') return this.leaveGroup(dev, iface, g);
      if (ev.kind === 'leave') return this.joinGroup(dev, iface, g, []) === null;
      if (ev.kind === 'stream') return this.stopStream(dev, iface, g);
      return this.multicast.restartStream(dev, iface, g);
    }
    return this.powerOn(id);
  }

  /** The network events in effect (with the joins, leaves and streams). */
  netEvents(): NetEvent[] {
    return this.engine.netEvents().concat(this.multicast.netEvents()).sort((a, b) => a.since - b.since || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  // ------------------------------------------------------------ multicast: joins, streams, tables

  /** Join group…: a host joins a group on an interface (sources: SSM); a text when it cannot. */
  joinGroup(dev: string, iface: string, group: string, sources: string[]): string | null {
    const r = this.multicast.join(dev, iface, group, sources, 'event');
    if (r === null) this.engine.stateVersion++;
    return r;
  }

  leaveGroup(dev: string, iface: string, group: string): boolean {
    return this.multicast.leave(dev, iface, group);
  }

  /** Start stream…: a host sends UDP to a group every interval; a text when it cannot. */
  startStream(dev: string, iface: string, group: string, port = 5004, interval = 1000, size = 1316): string | null {
    const r = this.multicast.addStream(dev, iface, group, port, interval, size, 'event');
    if (typeof r === 'string') return r;
    this.engine.stateVersion++;
    return null;
  }

  stopStream(dev: string, iface: string, group: string): boolean {
    return this.multicast.stopStream(dev, iface, group);
  }

  /** A router's IGMP / MLD groups, a switch's multicast table, a router's multicast routes. */
  igmpTable(dev: string): GridTable {
    return this.multicast.igmpTable(dev);
  }

  snoopTable(dev: string): GridTable {
    return this.multicast.snoopTable(dev);
  }

  mrouteTable(dev: string): GridTable {
    return this.multicast.mrouteTable(dev);
  }

  /** What the diagram marks as down (cables, relations, interfaces, devices). */
  downRefs(): string[] {
    return this.engine.downRefs();
  }

  // ------------------------------------------------------------ parameters

  /** Set a simulation-wide parameter now (undefined: its default); logged, applied at once. */
  setParam(key: string, v: ParamValue | undefined): ParamChange | null {
    return this.engine.setParam(key, v);
  }

  /** The model changed (a Simulation section of a device, an interface, a network or a relation): every attribute is read again and the changes apply now. */
  deviceParamsFrom(model: Model): ParamChange[] {
    const out: ParamChange[] = [];
    for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!this.engine.net.devices.has(d.id)) continue;
      out.push(...this.engine.setDeviceParams(d.id, d.type, d.simulation || new Map()));
    }
    // and the objects' (interfaces, VLANs, relations)
    out.push(...this.engine.setObjectParams(model));
    return out;
  }

  get params(): SimParams {
    return this.engine.params;
  }

  events(): SimEvent[] {
    return this.engine.log;
  }

  /** The flights in the air at t (or any time since `since`: the reduced-motion steps). */
  flights(t: number, view: 'physical' | 'logical', since = t): Flight[] {
    return this.engine.flightsAt(t, view, since);
  }

  /** Run towards t, stopping at the first moment a message that `visible` accepts is sent; returns the time reached. */
  advance(t: number, visible: (f: Flight) => boolean): number {
    const from = this.engine.flightSerial;
    this.engine.runUntil(t, () => this.engine.flightsSince(from).some((f) => !f.hidden && f.t0 < t && visible(f)));
    return this.engine.now;
  }

  /**
   * Playback: move the clock on by `wallMs` of real time at `speed`. While
   * a message that `visible` accepts is on its way the clock slows down so
   * that it takes about `vis` ms of real time at 1× (a frame is on a cable
   * for microseconds); between messages it runs at the speed. Deterministic:
   * only how far the clock gets depends on it, never what happens.
   */
  play(wallMs: number, speed: number, visible: (f: Flight) => boolean, vis = 300): number {
    let w = wallMs;
    for (let i = 0; i < 64 && w > 1e-6; i++) {
      const t = this.engine.now;
      let dmin = Infinity;
      let nextEnd = Infinity;
      let upcoming = Infinity;
      for (const f of this.engine.flights) {
        if (f.hidden || !visible(f)) continue;
        const end = f.dropped !== undefined ? f.dropped : f.t1;
        if (f.t0 <= t && t < end) {
          dmin = Math.min(dmin, f.t1 - f.t0);
          nextEnd = Math.min(nextEnd, end);
        } else if (f.t0 > t) upcoming = Math.min(upcoming, f.t0);
      }
      const rate = dmin < Infinity ? speed * Math.min(1, Math.max(dmin, 1e-6) / vis) : speed;
      const target = Math.min(t + w * rate, nextEnd, upcoming);
      const nt = this.advance(target, visible);
      w -= (nt - t) / rate;
    }
    return this.engine.now;
  }

  status(): SessionStatus[] {
    return this.protocols.status();
  }

  arpTable(dev: string): ArpRow[] {
    return this.engine.arpRows(dev, 4);
  }

  ndTable(dev: string): ArpRow[] {
    return this.engine.arpRows(dev, 6);
  }

  macTable(dev: string): MacRow[] {
    return this.engine.macRows(dev);
  }

  arpTimers(dev: string): TableTimer[] {
    return this.engine.arpTimers(dev);
  }

  macTimers(dev: string): TableTimer[] {
    return this.engine.macTimers(dev);
  }

  setTimerScale(n: number): void {
    this.engine.setTimerScale(n);
  }

  get timerScale(): number {
    return this.engine.timerScale;
  }

  /** The devices with an IP stack (an ARP table) and the switches (a MAC table), by id. */
  tableDevices(): Array<{ id: string; arp: boolean; mac: boolean }> {
    return Array.from(this.engine.net.devices.values())
      .filter((d) => d.l3.size > 0 || d.bridge)
      .map((d) => ({ id: d.id, arp: Array.from(d.l3.values()).some((l) => l.addrs.length > 0 && l.kind !== 'loopback'), mac: d.bridge && (d.caps.switchFeatures || !!d.virt) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The protocols this model's simulation runs, grouped (Layer 2 first), for the window's checkboxes. */
  protocolEntries(): SimProtocolEntry[] {
    return protocolEntriesOf(this.model);
  }

  // ------------------------------------------------------------ Layer 4: tests, connections, firewall sessions

  /**
   * Send test…: one ICMP echo, TCP connection or UDP request from a device
   * to a device ("web1", "web1:eth0"), an address, a subnet broadcast,
   * 255.255.255.255 or a multicast group; a text when it cannot be sent.
   */
  sendTest(o: { from: string; via?: string; to: string; kind: TestKind; port?: number; size?: number; df?: boolean; keep?: boolean }): Test | string {
    const src = this.testSources().find((x) => x.id === o.from);
    if (src && !src.ok) return `${o.from} can't send a test: ${src.reason}`;
    const via = o.via || undefined;
    const r = this.transport.resolveTarget(o.from, { to: o.to.trim() }, o.kind);
    if (typeof r === 'string') return r;
    return this.transport.run({ from: o.from, via, target: o.to.trim(), dst: r.dst, name: r.name, kind: o.kind, port: o.kind === 'icmp' ? 0 : o.port, size: o.size, df: o.df, keep: o.keep, source: 'manual' });
  }

  /**
   * Every device of the model as a source of Send test…, and whether it can send one now. A device
   * sends from an interface of its IP stack (the capability resolver says which devices have one)
   * with an address: a configured one, or a DHCP client's lease. A DHCP client without its lease is a
   * source too: its test waits for the lease (and fails, saying why, when DHCP gets no answer). A
   * device without an IP stack (a cable's TAP, a passive monitor, a Cloud …) is listed, with the reason
   * it sends nothing. Computed from the simulation's state each time: never a stale lease.
   */
  testSources(): TestSource[] {
    const e = this.engine;
    const out: TestSource[] = [];
    for (const d of this.model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const sd = e.net.devices.get(d.id);
      const caps = sd ? sd.caps : capabilities(d);
      const what = deviceTypeLine(d) || 'a device without a type';
      if (!caps.ipStack || !sd) {
        out.push({ id: d.id, ok: false, reason: `it has no IP stack of its own (${what}): it forwards or observes traffic and sends none`, ifaces: [] });
        continue;
      }
      const ifaces: TestSourceIface[] = [];
      const l3s = Array.from(sd.l3.values()).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const l of l3s) {
        const mi = this.model.index.interfaces.get(d.id + ':' + l.id);
        const dhcp = !!mi && !!mi.dhcp && !mi.addresses.length;
        const at = this.attachment(d.id, l.id);
        if (!dhcp) {
          if (!l.addrs.length) continue;
          ifaces.push({ id: l.id, dhcp: false, ready: true, status: `${l.addrs.map((a) => a.text).join(', ')}${at ? ' · ' + at : ''}` });
          continue;
        }
        const lease = e.leases.get(d.id + ':' + l.id);
        const cs = this.netsvc.clientStatus(d.id, l.id);
        let status: string;
        let ready = false;
        if (lease && lease.kind === 'dhcp') {
          ready = true;
          const parts = [`DHCP: ${lease.addr.text}${lease.server ? ` from ${formatAddr(lease.server)}` : ''}`];
          if (lease.gateway) parts.push('gateway ' + formatAddr(lease.gateway));
          if (lease.dns.length) parts.push('DNS ' + lease.dns.map(formatAddr).join(', '));
          // (its length, not a countdown: the form's status line is announced when it changes)
          parts.push(`lease ${durationText(lease.expires - lease.bound)}`);
          status = parts.join(', ');
        } else if (!e.isL3Up(d.id, l.id)) status = 'DHCP: no lease, its link is not up (it asks when the link comes up)';
        else if (cs && cs.failed) status = `DHCP: no lease, ${cs.failed.text}${lease ? `; meanwhile the link-local address ${lease.addr.text} (only its own segment)` : ''}`;
        else if (lease) {
          ready = true;
          status = `link-local ${lease.addr.text} (no DHCP server answered: only its own segment)`;
        } else status = `DHCP: no lease yet (${cs ? DHCP_STATE[cs.state] || cs.state : 'not started'}): a test waits for it`;
        ifaces.push({ id: l.id, dhcp: true, ready, status: status + (at ? ' · ' + at : '') });
      }
      if (!ifaces.length) {
        out.push({ id: d.id, ok: false, reason: 'no interface with an address or DHCP: give one an address, or turn DHCP on', ifaces });
        continue;
      }
      if (!e.deviceOn(d.id)) {
        out.push({ id: d.id, ok: false, reason: 'it is powered off (Power on in its menu)', ifaces });
        continue;
      }
      const ready = ifaces.filter((i) => i.ready);
      const waiting = ifaces.find((i) => i.dhcp && !i.ready);
      out.push({ id: d.id, ok: true, reason: ready.length ? '' : waiting ? waiting.status.replace(/ · .*$/, '') : '', ifaces });
    }
    return out;
  }

  /** Where an interface is attached, when it says something: its Wi-Fi network and VLAN. */
  private attachment(dev: string, iface: string): string {
    const l = this.model.links.find((x) => (x.a.device === dev && x.a.iface === iface) || (x.b.device === dev && x.b.iface === iface));
    if (!l || !l.wirelessNetwork) return '';
    const ap = l.a.device === dev ? l.b : l.a;
    const apDev = this.model.index.devices.get(ap.device);
    const n = apDev && apDev.wireless ? apDev.wireless.networks.find((x) => x.id === l.wirelessNetwork && x.radio === ap.iface) : undefined;
    if (!n) return '';
    return `Wi-Fi network “${n.ssid}” of ${ap.device}${n.vlan !== undefined ? ` (VLAN ${n.vlan})` : n.untagged ? ' (untagged)' : ''}`;
  }

  /** The latest Send test… results, newest first. */
  tests(): Test[] {
    return this.transport.manualTests();
  }

  /** A DHCP server's leases as a table (Show DHCP leases). */
  leaseGrid(dev: string): GridTable {
    const rows = this.netsvc.leaseRows(dev).map((r) => [r.ip, r.mac, r.client, r.state === 'bound' ? 'Bound' : 'Offered', `scope ${r.scope + 1}`, fmtSec(Math.max(0, r.expires - this.now))]);
    return { caption: `DHCP leases of ${dev}`, cols: ['Address', 'MAC address', 'Client', 'State', 'Scope', 'Expires in'], rows, empty: 'No lease yet.', timers: [], notes: this.netsvc.scopeNotes(dev) };
  }

  /** A host's resolver cache as a table (Show DNS cache). */
  dnsCacheGrid(dev: string): GridTable {
    const rows = this.netsvc.cacheRows(dev).map((r) => [r.name, r.type, r.value, r.server, fmtSec(Math.max(0, r.expires - this.now))]);
    const servers = this.netsvc.dnsServers(dev).map((a) => formatAddr(a));
    return { caption: `DNS cache of ${dev}`, cols: ['Name', 'Type', 'Address', 'From server', 'Expires in'], rows, empty: 'Empty: nothing resolved yet.', timers: [], notes: [`DNS servers: ${servers.length ? servers.join(', ') : 'none'} (${Array.from(this.engine.leases.values()).some((l) => l.dev === dev && l.dns.length) ? 'from its DHCP lease' : 'configured'}); resolver: timeout 5 s, 2 attempts per server`] };
  }

  /** A DNS server's zones as a table (Show DNS zone). */
  dnsZoneGrid(dev: string): GridTable {
    const rows = this.netsvc.zoneRows(dev).map((r) => [r.zone, r.name, r.type, r.value, r.ttl, r.source]);
    return { caption: `DNS zones of ${dev}`, cols: ['Zone', 'Name', 'Type', 'Value', 'TTL', 'Source'], rows, empty: 'No record: no DNS name of the model is in its zones yet.', timers: [], notes: this.netsvc.zoneNotes(dev) };
  }

  /** A DHCP server's leases (Show DHCP leases). */
  leaseTable(dev: string): LeaseRow[] {
    return this.netsvc.leaseRows(dev);
  }

  /** A host's DNS cache (Show DNS cache). */
  dnsCache(dev: string): DnsCacheRow[] {
    return this.netsvc.cacheRows(dev);
  }

  /** A DNS server's zones (Show DNS zone). */
  dnsZone(dev: string): ZoneRow[] {
    return this.netsvc.zoneRows(dev);
  }

  /** The DHCP leases in effect on the clients (the diagram marks them; the model is unchanged). */
  leases(): Array<{ dev: string; iface: string; text: string; kind: 'dhcp' | 'link-local' }> {
    return Array.from(this.engine.leases.values()).map((l) => ({ dev: l.dev, iface: l.iface, text: l.addr.text, kind: l.kind })).sort((a, b) => (a.dev + ':' + a.iface < b.dev + ':' + b.iface ? -1 : 1));
  }

  /** A device's connections and open ports (TCP, UDP, ICMP tests waiting). */
  connTable(dev: string): ConnRow[] {
    return this.transport.connRows(dev);
  }

  /** A firewall's session table, and the timers in effect. */
  sessionTable(dev: string): SessionRow[] {
    return this.transport.sessionRows(dev);
  }

  sessionTimers(dev: string): Resolved[] {
    return this.transport.sessionTimers(dev);
  }

  /** The subnet broadcast addresses of a device's interfaces (Send test… offers them). */
  broadcastTargets(dev: string): string[] {
    const sd = this.engine.net.devices.get(dev);
    if (!sd) return [];
    const out: string[] = [];
    for (const l of Array.from(sd.l3.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      for (const a of l.addrs) {
        if (a.addr.version !== 4 || a.net.prefix > 30) continue;
        const b = formatAddr(subnetBroadcast(a));
        if (out.indexOf(b) < 0) out.push(b);
      }
    }
    if (out.length) out.push('255.255.255.255');
    return out;
  }

  /** What a broadcast reaches from a device's interface, or in a cable's VLAN (Highlight broadcast domain). */
  broadcastDomain(from: { dev: string; iface: string } | { link: string; vlan: number }): { vlan: number; refs: string[]; devices: string[]; links: string[] } {
    return this.engine.broadcastDomain(from);
  }

  /** The VLANs with a broadcast storm going on. */
  storms(): Array<{ vlan: number; since: number; links: string[] }> {
    return Array.from(this.engine.storms).map(([vlan, s]) => ({ vlan, since: s.since, links: s.links })).sort((a, b) => a.vlan - b.vlan);
  }
}

/**
 * The protocols this model's simulation runs, grouped (Layer 2, Routing,
 * Redundancy, Tunnels and overlays, Multicast, Services, Traffic, Custom),
 * each with what in the model uses it (devices, relations, demands or
 * streams), for the setup's checkboxes.
 */
export function protocolEntriesOf(model: Model): SimProtocolEntry[] {
  const seen = new Map<string, SimProtocolEntry>();
  const users = new Map<string, Set<string>>();
  const add = (id: string, label: string, group: SimEntryGroup, unit: SimProtocolEntry['unit'], user: string): void => {
    if (!seen.has(id)) seen.set(id, { id, label, group, uses: 0, unit });
    const u = users.get(id) || new Set<string>();
    u.add(user);
    users.set(id, u);
  };
  // multicast routing has a group of its own
  const groupOf = (id: string, g: SimEntryGroup): SimEntryGroup => (id === 'pim' || id === 'igmp' || id === 'mcast' ? 'Multicast' : g);
  const ifs = (d: Model['devices'][number]): Model['devices'][number]['interfaces'] => d.interfaces.concat(d.logical);
  for (const d of model.devices) {
    // (a DHCP client too: it has its address once leased)
    const addrs = ifs(d).filter((i) => i.type !== 'loopback' && (i.addresses.length || i.dhcp));
    if (!addrs.length) continue;
    add('arp', 'ARP', 'Layer 2', 'device', d.id);
    add('garp', 'Gratuitous ARP', 'Layer 2', 'device', d.id);
    if (addrs.some((i) => i.addresses.some((a) => a.indexOf(':') >= 0))) add('ndp', 'NDP', 'Layer 2', 'device', d.id);
  }
  for (const r of model.relations) {
    const p = relationProfile(model, r);
    add(p.id, p.label, groupOf(p.id, p.group), 'relation', r.id);
  }
  for (const d of model.devices) {
    if (d.logical.some((i) => i.type === 'virtual' && i.members.length)) add('lacp', 'LACP', 'Layer 2', 'device', d.id);
    for (const i of ifs(d)) for (const s of i.services) {
      const p = simProfile(s.id);
      if (p && !(seen.has(p.id) && seen.get(p.id)!.unit === 'relation')) add(p.id, p.label, groupOf(p.id, p.group), 'device', d.id);
    }
  }
  for (const dm of model.demands) add('demand', 'Demands (data)', 'Traffic', 'demand', dm.id);
  // Layer 3 and 4: ICMP (echo, errors), TCP and UDP (tests, health checks, probes): every addressed device can send them
  for (const d of model.devices) {
    if (!ifs(d).some((i) => i.addresses.length || i.dhcp)) continue;
    for (const [id, label] of [['icmp', 'ICMP / ICMPv6'], ['tcp', 'TCP (tests)'], ['udp', 'UDP (tests)']]) add(id, label, 'Traffic', 'device', d.id);
  }
  // DHCP: its servers and clients; DNS: its servers (and the hosts that ask them)
  for (const d of model.devices) {
    if ((d.netServices && d.netServices.dhcp) || ifs(d).some((i) => i.dhcp)) add('dhcp', 'DHCP', 'Services', 'device', d.id);
    if ((d.netServices && d.netServices.dns) || (d.dnsServers && d.dnsServers.length)) add('dns', 'DNS', 'Services', 'device', d.id);
  }
  // multicast: membership wherever a router runs PIM or a host joins; the streams
  for (const d of model.devices) {
    const joins = ifs(d).some((i) => !!i.multicast && i.multicast.joins.length > 0);
    if (joins || d.services.some((s) => s.id === 'pim')) add('igmp', 'IGMP / MLD', 'Multicast', 'device', d.id);
    for (const i of ifs(d)) for (const st of i.multicast ? i.multicast.streams : []) add('mcast', 'Multicast streams', 'Multicast', 'stream', `${d.id}:${i.id}:${st.group}`);
  }
  for (const e of seen.values()) e.uses = (users.get(e.id) as Set<string>).size;
  const order = (g: SimEntryGroup): number => ENTRY_GROUPS.indexOf(g);
  return Array.from(seen.values()).sort((a, b) => order(a.group) - order(b.group) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

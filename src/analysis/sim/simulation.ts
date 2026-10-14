/**
 * The protocol simulation of a model (Simulate → Start simulation): the
 * engine (engine.ts) with every protocol's behaviour, started like a
 * freshly booted network. The window and the animation use this facade
 * only. Deterministic: the same model, the same actions at the same
 * simulated times, the same timeline. It never changes the model.
 */
import { SIM_GROUPS, SimGroup, simProfile } from '../../model/sim-profiles';
import { Model } from '../../model/types';
import { failableRef } from '../failure';
import { formatAddr } from '../ipmath';
import { Engine, EngineOptions, subnetBroadcast } from './engine';
import { OTHER_BEHAVIOURS, installBootGarp, installCustomL2, installDemands, installFhrp, installL2Adverts, installLacp } from './proto-other';
import { ROUTING_BEHAVIOURS } from './proto-routing';
import { ProtocolSim, relationProfile } from './protocols';
import { ParamChange, ParamValue, Resolved, SimParams } from './params';
import { Multicast } from './multicast';
import { Test, TestKind, Transport } from './transport';
import { ArpRow, ConnRow, Flight, GridTable, MacRow, NetEvent, SessionRow, SessionStatus, SimEvent, TableTimer } from './types';


/** A protocol of the simulation as the window lists it (a checkbox). */
export interface SimProtocolEntry {
  id: string;
  label: string;
  group: SimGroup | 'Traffic';
}

export class Simulation {
  readonly engine: Engine;
  readonly protocols: ProtocolSim;
  readonly transport: Transport;
  readonly multicast: Multicast;
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
    this.transport = new Transport(this.protocols);
    this.transport.multicast = this.multicast;
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

  /** End an event of the list (Restore, Stop flapping, No shut, Power on). */
  end(ev: NetEvent): boolean {
    const id = ev.ref.slice(ev.ref.indexOf(':') + 1);
    if (ev.kind === 'fail') return this.restore(ev.ref);
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

  /** The model changed (a device's Simulation section): every device's attributes are read again and the changes apply now. */
  deviceParamsFrom(model: Model): ParamChange[] {
    const out: ParamChange[] = [];
    for (const d of model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!this.engine.net.devices.has(d.id)) continue;
      out.push(...this.engine.setDeviceParams(d.id, d.type, d.simulation || new Map()));
    }
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
      .map((d) => ({ id: d.id, arp: Array.from(d.l3.values()).some((l) => l.addrs.length > 0 && l.kind !== 'loopback'), mac: d.bridge && d.dev.type === 'switch' }))
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
  sendTest(o: { from: string; to: string; kind: TestKind; port?: number; size?: number; df?: boolean; keep?: boolean }): Test | string {
    const r = this.transport.resolveTarget(o.from, { to: o.to.trim() }, o.kind);
    if (typeof r === 'string') return r;
    return this.transport.run({ from: o.from, target: o.to.trim(), dst: r.dst, kind: o.kind, port: o.kind === 'icmp' ? 0 : o.port, size: o.size, df: o.df, keep: o.keep, source: 'manual' });
  }

  /** The latest Send test… results, newest first. */
  tests(): Test[] {
    return this.transport.manualTests();
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

/** The protocols this model's simulation runs, grouped (Layer 2 first), for the window's checkboxes. */
export function protocolEntriesOf(model: Model): SimProtocolEntry[] {
  const seen = new Map<string, SimProtocolEntry>();
  const add = (id: string, label: string, group: SimProtocolEntry['group']): void => {
    if (!seen.has(id)) seen.set(id, { id, label, group });
  };
  add('arp', 'ARP', 'Layer 2');
  if (model.devices.some((d) => d.interfaces.concat(d.logical).some((i) => i.addresses.some((a) => a.indexOf(':') >= 0)))) add('ndp', 'NDP', 'Layer 2');
  add('garp', 'Gratuitous ARP', 'Layer 2');
  for (const r of model.relations) {
    const p = relationProfile(model, r);
    add(p.id, p.label, p.group);
  }
  for (const d of model.devices) {
    if (d.logical.some((i) => i.type === 'virtual' && i.members.length)) add('lacp', 'LACP', 'Layer 2');
    for (const i of d.interfaces.concat(d.logical)) for (const s of i.services) {
      const p = simProfile(s.id);
      if (p) add(p.id, p.label, p.group);
    }
  }
  if (model.demands.length) add('demand', 'Demands (data)', 'Traffic');
  // Layer 3 and 4: ICMP (echo, errors), TCP and UDP (tests, health checks, probes)
  add('icmp', 'ICMP / ICMPv6', 'Traffic');
  add('tcp', 'TCP (tests)', 'Traffic');
  add('udp', 'UDP (tests)', 'Traffic');
  // multicast: membership wherever a router runs PIM or a host joins; the streams
  const joins = model.devices.some((d) => d.interfaces.concat(d.logical).some((i) => !!i.multicast && i.multicast.joins.length > 0));
  const pim = model.devices.some((d) => d.services.some((s) => s.id === 'pim'));
  if (joins || pim) add('igmp', 'IGMP / MLD', 'Routing');
  if (model.devices.some((d) => d.interfaces.concat(d.logical).some((i) => !!i.multicast && i.multicast.streams.length > 0))) add('mcast', 'Multicast streams', 'Traffic');
  const order = (g: SimProtocolEntry['group']): number => (g === 'Traffic' ? SIM_GROUPS.length : SIM_GROUPS.indexOf(g as SimGroup));
  return Array.from(seen.values()).sort((a, b) => order(a.group) - order(b.group) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

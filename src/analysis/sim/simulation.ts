/**
 * The protocol simulation of a model (Simulate → Start simulation): the
 * engine (engine.ts) with every protocol's behaviour, started like a
 * freshly booted network. The window and the animation use this facade
 * only. Deterministic: the same model, the same actions at the same
 * simulated times, the same timeline. It never changes the model.
 */
import { CUSTOM_SUPPORT, SimGroup, simProfile } from '../../model/sim-profiles';
import type { Support } from '../../model/support';
import { serviceDef } from '../../model/service-registry';
import { autoIpv6, ipConfigured } from '../../model/ipv6';
import { Model } from '../../model/types';
import { capabilities } from '../../model/capabilities';
import { snoopingChoice, switchedVlans } from '../../model/snooping';
import { deviceTypeLine } from '../../model/device-types';
import { failableRef } from '../failure';
import { formatAddr } from '../ipmath';
import type { AnalysisSnapshot, SnapTiming } from '../snapshot';
import { DevicePower, Engine, EngineOptions, fmtSec, subnetBroadcast } from './engine';
import { RealTimeScheduler } from './realtime';
import { OTHER_BEHAVIOURS, installBootGarp, installCustomL2, installDemands, installFhrp, installL2Adverts, installLacp } from './proto-other';
import { ROUTING_BEHAVIOURS } from './proto-routing';
import { ProtocolSim, relationProfile } from './protocols';
import { ParamChange, ParamValue, Resolved, SimParams, durationText, formatValue } from './params';
import { Multicast } from './multicast';
import { DnsCacheRow, LeaseRow, NetServicesSim, ZoneRow } from './netsvc';
import { Test, TestKind, Transport } from './transport';
import { AppSim } from './apps';
import { MqttSim } from './mqtt';
import { Ipv6Sim } from './ipv6';
import { NtpSim } from './ntp';
import { PtpSim } from './ptp';
import { ACTION_TITLE, ActionRecord, ActionView, CANCELLED, MAX_ACTIONS, SendRun, actionView } from './actions';
import { TestPlan, directedTarget, messageTime, needsInterface, planProblem, usesPorts } from './test-plan';
import { IpAddr, parseAddress } from '../../model/ip';
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
  /** what the simulation does for it (model/support.ts): a custom protocol's is drawn only */
  support: Support;
}

/** The support of the entries that are no relation protocol's profile: the tests' transport and the traffic. */
const ENTRY_SUPPORT: { [id: string]: Support } = {
  icmp: { level: 'modeled', does: 'Echo requests and replies, and the ICMP errors routers and hosts send (unreachable, time exceeded, fragmentation needed with path MTU discovery).', not: 'ICMP redirects, router discovery over ICMPv4.' },
  tcp: { level: 'modeled', does: 'The three-way handshake, segments by the path MTU, retransmission with backoff, RST, FIN and TIME_WAIT, keepalive probes, firewall sessions.', not: 'congestion control and windows: no throughput is computed.' },
  udp: { level: 'modeled', does: 'Datagrams to open ports and their answers; ICMP port unreachable from a closed port.', not: 'payload contents.' },
  demand: { level: 'modeled', does: 'Each demand’s packets along the path routing gives it, rerouted after failures.', not: 'bandwidth: no link is loaded or congested.' },
  mcast: { level: 'modeled', does: 'Each stream’s datagrams, replicated by snooping switches and multicast routing to the members.', not: 'bandwidth and rate limits.' },
  dhcpv6: { level: 'modeled', does: 'Stateful (Solicit, Advertise, Request, Reply; Renew at T1, Rebind at T2, expiry) and stateless (Information-request, Reply) DHCPv6 between a client and a server on its link, with DNS servers and duplicate address detection of the address.', not: 'prefix delegation, relay agents, Decline and Release, DUID types other than DUID-LL, authentication.' },
};

/** The support of an entry of the setup's list: its profile's, else the traffic's (custom: drawn only). */
function entrySupport(id: string): Support {
  if (ENTRY_SUPPORT[id]) return ENTRY_SUPPORT[id];
  if (id === 'mqtt') return (serviceDef('mqtt_broker') as { support: Support }).support;
  if (id === 'ptp') return (serviceDef('ptp') as { support: Support }).support;
  const p = simProfile(id);
  return p && p.support ? p.support : CUSTOM_SUPPORT;
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
  /** a test can go from it: it has an address, or it is a DHCP client (the test waits for its lease) */
  usable: boolean;
  /** the form's option: "eth0 - 10.0.0.1", "wlan0 - 192.168.30.23 (DHCP)", "wlan0 - No DHCP lease", "eth1 - No IP address" */
  label: string;
  /** the broadcast address of its IPv4 subnet now (a local broadcast's subnet scope), if it has one */
  bcast?: string;
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
  /** why it can't, in a few words: "Cannot send IP packets", "No interfaces", "No IP address", "Powered off" ('' it can) */
  short: string;
  /** its interfaces of the IP stack, those without an address too (not usable) */
  ifaces: TestSourceIface[];
}

/** A destination interface's address as the form offers it (unicast). */
export interface TestDestOption {
  /** "eth0|10.0.0.1", "wlan0|dhcp" (its lease when the message is sent) */
  value: string;
  iface: string;
  addr: string;
  /** "eth0 - 10.0.0.1", "wlan0 - 192.168.30.23 (DHCP)", "wlan0 - No DHCP lease" */
  label: string;
  ok: boolean;
}

/** A device as a unicast destination: its interfaces' addresses, or why it has none. */
export interface TestDestination {
  id: string;
  ok: boolean;
  /** why it can't be one, in a few words ('' it can) */
  short: string;
  options: TestDestOption[];
}

/** A Send test with its messages: one, or a series of `count` sent `interval` seconds apart. */
/** A Send network packets with its messages: one, or a series of `count` sent `interval` seconds apart. */
export type TestRun = SendRun;

/** The broadcast address of the first IPv4 subnet among addresses (none for a /31 or /32). */
function bcastOf(addrs: Array<{ addr: IpAddr; net: IpAddr & { prefix: number } }>): string | undefined {
  const a = addrs.find((x) => x.addr.version === 4 && x.net.prefix <= 30);
  return a ? formatAddr(subnetBroadcast(a)) : undefined;
}

/** Are messages of a run still to be sent? */
export function runPending(r: TestRun): boolean {
  return !r.stopped && r.sent < r.count;
}

/** Is a run going on: messages still to be sent, or on their way? */
export function runActive(r: TestRun): boolean {
  return runPending(r) || r.tests.some((t) => !t.done);
}

const DHCP_STATE: { [k: string]: string } = { INIT: 'about to ask', SELECTING: 'asking (DHCPDISCOVER)', REQUESTING: 'requesting the offered address', RENEWING: 'renewing', REBINDING: 'rebinding' };

/** What a Simulation takes: the engine's options, and the real-time schedule's clock (real ms; the tests' fake). */
export type SimOptions = EngineOptions & { realClock?: () => number };

/**
 * A device's lifecycle in words: the state, a short label (the diagram's
 * status indicator), and a line for its tooltip and menu. Operational,
 * powered off and booting are its power state (the engine's, which packet
 * processing uses); passive (a patch panel, a TAP, a pass-through) and
 * external (a cloud, an external network) have none of their own; unknown:
 * the simulation has no such device (yet).
 */
export interface DeviceStateView {
  state: 'operational' | 'off' | 'booting' | 'passive' | 'external' | 'unknown' | 'outside';
  /** "Operational", "Powered off", "Booting", "Passive", "External", "Unknown" */
  label: string;
  /** "Booting: up at t = 45 s", "Powered off at t = 12 s (down with its host esx-01)" */
  detail: string;
}

/** Does the state belong to a device with a power state of its own (it can be powered off and on)? */
export function hasLifecycle(st: DeviceStateView): boolean {
  return st.state === 'operational' || st.state === 'off' || st.state === 'booting';
}

export function deviceStateView(p: DevicePower | null, none: 'passive' | 'external' | 'unknown' = 'passive'): DeviceStateView {
  if (!p) {
    if (none === 'external') return { state: 'external', label: 'External', detail: 'External: a network outside the model (one hop); it has no power state of its own' };
    if (none === 'unknown') return { state: 'unknown', label: 'Unknown', detail: 'Unknown: the simulation has no state for it' };
    return { state: 'passive', label: 'Passive', detail: 'Passive: it passes signals without a power state of its own (a patch panel, a TAP, a pass-through)' };
  }
  if (p.state === 'booting') return { state: 'booting', label: 'Booting', detail: `Booting: powered on, up at t = ${fmtSec(p.until as number)}; it takes no part until then` };
  if (p.state === 'off') return { state: 'off', label: 'Powered off', detail: `Powered off at t = ${fmtSec(p.since as number)}${p.why ? ' (' + p.why + ')' : ''}` };
  return { state: 'operational', label: 'Operational', detail: 'Operational: powered on and booted (its interfaces, cables and peers have their own state)' };
}

export class Simulation {
  readonly engine: Engine;
  readonly protocols: ProtocolSim;
  readonly transport: Transport;
  readonly multicast: Multicast;
  /** DHCP and DNS: the servers' scopes and zones, the clients, the resolvers */
  readonly netsvc: NetServicesSim;
  readonly model: Model;
  /** the real-time schedule of Network events (a stream's datagrams); its clock injected for the tests */
  readonly realtime: RealTimeScheduler;
  /** the applications: listeners answer, clients run when started (apps.ts) */
  readonly apps: AppSim;
  /** MQTT: the brokers and their clients (mqtt.ts) */
  readonly mqtt: MqttSim;
  /** IPv6 host configuration: link-local addresses, router discovery, SLAAC, DAD, DHCPv6 (ipv6.ts) */
  readonly ipv6: Ipv6Sim;
  /** NTP's synchronization state (ntp.ts) and PTP (ptp.ts): kept apart, neither disciplines the other */
  readonly ntp: NtpSim;
  readonly ptp: PtpSim;

  constructor(model: Model, opts: SimOptions = {}) {
    this.model = model;
    this.engine = new Engine(model, opts);
    this.realtime = new RealTimeScheduler(opts.realClock);
    this.protocols = new ProtocolSim(this.engine, { ...ROUTING_BEHAVIOURS, ...OTHER_BEHAVIOURS });
    installBootGarp(this.protocols);
    installFhrp(this.protocols);
    installLacp(this.protocols);
    installL2Adverts(this.protocols);
    installDemands(this.protocols);
    installCustomL2(this.protocols);
    this.multicast = new Multicast(this.protocols);
    this.multicast.realtime = this.realtime;
    this.multicast.install();
    this.netsvc = new NetServicesSim(this.protocols);
    this.ipv6 = new Ipv6Sim(this.protocols);
    this.netsvc.v6Dns = (d) => this.ipv6.dnsServers(d);
    this.transport = new Transport(this.protocols);
    this.transport.multicast = this.multicast;
    this.transport.netsvc = this.netsvc;
    this.netsvc.onLeaseFailed = (dev, iface, why) => this.transport.leaseFailed(dev, iface, why);
    // a join of Network events is done when a multicast router records it
    this.multicast.onMember = (rdev, riface, group, reporter) => this.memberRecorded(rdev, riface, group, reporter);
    this.transport.install();
    this.apps = new AppSim(this.protocols, this.transport);
    this.apps.realtime = this.realtime;
    this.mqtt = new MqttSim(this.protocols, this.transport, this.apps);
    this.mqtt.realtime = this.realtime;
    this.ntp = new NtpSim(this.protocols);
    this.ntp.install();
    this.ptp = new PtpSim(this.protocols, this.multicast);
    this.protocols.start();
  }

  /** The simulated time (ms). */
  get now(): number {
    return this.engine.now;
  }

  /**
   * The real-time schedule's turn (once an animation frame, before the clock moves): the streams of
   * Network events send what is due now, at the current simulated time; returns how many datagrams.
   */
  pumpRealTime(): number {
    return this.realtime.pump();
  }

  /** Is anything on the real-time schedule (a stream of Network events running)? */
  realtimeActive(): boolean {
    return this.realtime.active();
  }

  /** The simulation plays or pauses (a hidden tab pauses it too): the real-time schedule with it. */
  setRealTimeRunning(on: boolean): void {
    this.realtime.setRunning(on);
  }

  /** The simulation is closed (Exit simulation, another model): nothing scheduled sends again. */
  close(): void {
    this.realtime.clear();
    this.realtime.setRunning(false);
  }

  /** A device's lifecycle as the diagram, its menu and the events say it (the state packet processing reads). */
  deviceState(dev: string): DeviceStateView {
    const p = this.engine.powerState(dev);
    if (p) return deviceStateView(p);
    const md = this.model.index.devices.get(dev);
    const sd = this.engine.net.devices.get(dev);
    return deviceStateView(null, !md || !sd ? 'unknown' : capabilities(md).externalTransit ? 'external' : capabilities(md).passThrough ? 'passive' : 'unknown');
  }

  /** The devices' lifecycle, by id (the model's devices). */
  deviceStates(): Map<string, DeviceStateView> {
    const out = new Map<string, DeviceStateView>();
    for (const d of this.model.devices) out.set(d.id, this.deviceState(d.id));
    return out;
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

  /** Start flapping a cabled port ("iface:dev:port"; its cable follows). A cable is no target: false. */
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
    const ok = this.engine.noShut(dev, iface);
    if (ok) for (const a of this.acts) if (a.shut && a.shut.dev === dev && a.shut.iface === iface && a.shut.upAt === undefined) a.shut.upAt = this.now;
    return ok;
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

  /** Leave group (a host's menu, a join's control, the form): a Leave multicast group event; false when it is no member. */
  leaveGroup(dev: string, iface: string, group: string): boolean {
    return !this.actLeave(dev, iface, group).error;
  }

  /** What a leave will send, and from where (the Leave multicast group form's note). */
  leaveContext(dev: string, iface: string, group: string): string {
    return this.multicast.leaveContext(dev, iface, group);
  }

  /** Why a host can't leave a group on an interface now (null: it can). */
  leaveProblem(dev: string, iface: string, group: string): string | null {
    return this.multicast.leaveProblem(dev, iface, group);
  }

  /**
   * Leave multicast group (Network events): the host's membership ends now
   * (no more answers to queries) and its leave goes out through the network,
   * drawn and inspectable with its event's id. The event follows what the
   * network had learned of the membership on the host's way (a snooping
   * switch's port facing it, a router's group on its subnet) until each is
   * removed — or kept, because another member behind it answered the group
   * queries.
   */
  actLeave(dev: string, iface: string, group: string): ActionRecord {
    const g = parseAddress(group.trim());
    const gt = g ? formatAddr(g) : group.trim();
    const target = `${dev}:${iface} → ${gt}`;
    const bad = this.multicast.leaveProblem(dev, iface, group);
    if (bad) return this.keepAction({ id: ++this.actSeq, kind: 'leave', at: this.now, target, error: bad });
    const watch = this.multicast.leaveWatch(dev, iface, gt);
    const sent = this.multicast.canReport(dev, iface);
    const traffic = this.transport.reserveId();
    this.multicast.leave(dev, iface, gt, traffic);
    this.engine.stateVersion++;
    for (const a of this.acts) if (a.join && a.join.dev === dev && a.join.iface === iface && a.join.group === gt && a.join.leftAt === undefined) a.join.leftAt = this.now;
    return this.keepAction({ id: ++this.actSeq, kind: 'leave', at: this.now, target, traffic, leave: { dev, iface, group: gt, sent, watch, until: this.now + this.multicast.leaveTime(watch), removed: [], kept: [] } });
  }

  /** The leaves' progress: each watched entry removed, or kept (still there after the network's leave time). */
  private updateLeaves(): void {
    for (const a of this.acts) {
      const l = a.leave;
      if (!l || l.done !== undefined) continue;
      for (const w of l.watch) {
        if (l.removed.indexOf(w.where) >= 0 || l.kept.indexOf(w.where) >= 0) continue;
        const st = this.multicast.watchState(w);
        if (!st.present) l.removed.push(w.where);
        else if (this.now >= l.until) l.kept.push(`${w.where}${st.reporter ? ' (' + st.reporter + ' reports it)' : ''}`);
      }
      if (l.removed.length + l.kept.length >= l.watch.length && (l.watch.length || this.now >= a.at)) l.done = this.now;
    }
  }

  // ------------------------------------------------------------ Network events: the operations and their list

  private keepAction(a: ActionRecord): ActionRecord {
    this.acts.push(a);
    // bounded: the oldest finished ones go first (a hard limit of twice as many, the oldest whatever their state)
    const views = (): ActionView[] => this.acts.map((x) => actionView(x, this.actionContext()));
    if (this.acts.length > MAX_ACTIONS) {
      const v = views();
      for (let i = 0; i < v.length && this.acts.length > MAX_ACTIONS; i++) {
        if (v[i].status === 'queued' || v[i].status === 'running' || v[i].status === 'paused') continue;
        const id = v[i].id;
        this.acts = this.acts.filter((x) => x.id !== id);
      }
    }
    if (this.acts.length > 2 * MAX_ACTIONS) this.acts.splice(0, this.acts.length - 2 * MAX_ACTIONS);
    return a;
  }

  private actionContext(): import('./actions').ActionContext {
    const p = (k: string): string => {
      const r = this.engine.params.get(k);
      return formatValue(r.def, r.value);
    };
    return {
      now: this.now,
      member: (d, i, g) => this.multicast.isMember(d, i, g),
      lastDrop: (id) => {
        const log = this.engine.log;
        for (let i = log.length - 1; i >= 0; i--) if (log[i].test === id && log[i].kind === 'drop') return { device: log[i].device, why: log[i].detail.replace(/^dropped at [^:]+: /, '') };
        return null;
      },
      shut: (d, i) => this.engine.isShut(d, i),
      rtPaused: !this.realtime.running,
      deviceOn: (d) => this.engine.deviceOn(d),
      appView: (a) => {
        const c = a.app ? this.mqtt.clientOf(a.app) : undefined;
        return c ? this.mqtt.view(a, c, !this.realtime.running) : null;
      },
      flapCycles: this.engine.params.num('flap-cycles'),
      flapTimes: `down ${p('flap-down')}, up ${p('flap-up')}, ${this.engine.params.num('flap-cycles') || 'continuous'}${this.engine.params.num('flap-cycles') ? ' cycles' : ''}`,
    };
  }

  /** Send network packets (Network events): a plan sent, its event in the list (refused: a failed event). */
  actSend(p: TestPlan): ActionRecord {
    const r = this.sendPlan(p);
    if (typeof r !== 'string') return this.acts.find((a) => a.run === r) as ActionRecord;
    return this.keepAction({ id: ++this.actSeq, kind: 'send', at: this.now, target: `${p.from || '?'} → ${p.to || p.target || p.group || p.subnet || p.scope || '?'}`, error: r });
  }

  /** Join multicast group (Network events): the join, done when a multicast router records it or its reports are sent. */
  actJoin(dev: string, iface: string, group: string, sources: string[]): ActionRecord {
    const g = parseAddress(group.trim());
    const gt = g ? formatAddr(g) : group.trim();
    const target = `${dev}:${iface} → ${gt}`;
    // its reports carry an id of their own: drawn whatever is ticked, in the log and the event's details
    const traffic = this.transport.reserveId();
    const r = this.multicast.join(dev, iface, group, sources, 'event', traffic);
    if (r === null) this.engine.stateVersion++;
    if (r) return this.keepAction({ id: ++this.actSeq, kind: 'join', at: this.now, target, error: r });
    // its second unsolicited report goes after the unsolicited report interval; done by then, a little later
    const until = this.now + this.multicast.unsolicited(dev, iface) + 1000;
    return this.keepAction({ id: ++this.actSeq, kind: 'join', at: this.now, target, traffic, join: { dev, iface, group: gt, sources, until } });
  }

  /** A multicast router recorded a member: a join of Network events from that host is done. */
  private memberRecorded(rdev: string, riface: string, group: string, reporter: string): void {
    const owner = this.engine.ownerOf(parseAddress(reporter) as IpAddr);
    for (const a of this.acts) {
      const j = a.join;
      if (!j || j.byAt !== undefined || j.group !== group || owner !== j.dev || this.now > j.until) continue;
      j.by = riface.indexOf('VLAN ') === 0 || riface.indexOf('the untagged') === 0 ? `${rdev} (${riface})` : `${rdev}:${riface}`;
      j.byAt = this.now;
    }
  }

  /** Start multicast stream (Network events): the stream, running until Stop stream. */
  actStream(dev: string, iface: string, group: string, port: number, interval: number, size: number): ActionRecord {
    const g = parseAddress(group.trim());
    const target = `${dev}:${iface} → ${g ? formatAddr(g) : group.trim()}:${port}`;
    const traffic = this.transport.reserveId();
    const st = this.multicast.addStream(dev, iface, group, port, interval, size, 'event', 0, '', traffic);
    if (typeof st === 'string') return this.keepAction({ id: ++this.actSeq, kind: 'stream', at: this.now, target, error: st });
    this.engine.stateVersion++;
    return this.keepAction({ id: ++this.actSeq, kind: 'stream', at: this.now, target, traffic, stream: st });
  }

  /** Start application (Network events): a client application's messages, one event until they are done or Stop. */
  actApp(dev: string, id: string, how: 'event' | 'start' = 'event'): ActionRecord {
    // (an experiment starts it on scenario time, as the scenario's own applications run: a Network event's repeats on real time)
    const r = this.apps.start(dev, id, how);
    const a = this.apps.app(dev, id);
    const target = `${dev}/${id}${a && a.peer ? ' → ' + a.peer : a && a.broker ? ' → ' + a.broker : ''}`;
    if (typeof r === 'string') return this.keepAction({ id: ++this.actSeq, kind: 'app', at: this.now, target, error: r });
    this.engine.stateVersion++;
    return this.keepAction({ id: ++this.actSeq, kind: 'app', at: this.now, target, app: r });
  }

  /** An MQTT broker's sessions (Show MQTT sessions). */
  mqttBrokerTable(dev: string): GridTable {
    return this.mqtt.brokerTable(dev);
  }

  /** A device's MQTT clients (Show MQTT clients). */
  mqttClientTable(dev: string): GridTable {
    return this.mqtt.clientTable(dev);
  }

  /** What stops a device's application from being started now (Start application's checks), or null. */
  appProblem(dev: string, id: string): string | null {
    return this.apps.problem(dev, id);
  }

  /** Shut interface (Network events): done at once; the interface stays down until No shut. */
  actShut(dev: string, iface: string): ActionRecord {
    const target = `${dev}:${iface}`;
    if (this.engine.isShut(dev, iface)) return this.keepAction({ id: ++this.actSeq, kind: 'shut', at: this.now, target, error: `${target} is shut already` });
    // an explicit shut ends the flapping of its cable first: no flap transition scheduled before can bring it up again
    if (this.engine.flapOf(`iface:${dev}:${iface}`)) this.stopFlap(`iface:${dev}:${iface}`);
    if (!this.shut(dev, iface)) return this.keepAction({ id: ++this.actSeq, kind: 'shut', at: this.now, target, error: `${target} can't be shut` });
    return this.keepAction({ id: ++this.actSeq, kind: 'shut', at: this.now, target, shut: { dev, iface } });
  }

  /** Start flapping (Network events): an interface (a cabled port), until its cycles are done or Stop flapping; never a cable. */
  actFlap(ref: string): ActionRecord {
    const target = ref.replace(/^iface:/, '').replace(/^link:/, 'cable ');
    // flapping is an interface's action: a cable goes down and up only as its ports do
    if (ref.indexOf('iface:') !== 0) return this.keepAction({ id: ++this.actSeq, kind: 'flap', at: this.now, target, error: `${target} is no interface: flapping is an interface action (choose a device and its interface)` });
    const going = this.engine.flapOf(ref);
    if (going) return this.keepAction({ id: ++this.actSeq, kind: 'flap', at: this.now, target, error: going.ref === ref ? `${target} is flapping already` : `its cable ${going.link} flaps already, from ${going.ref.slice(6)}` });
    // a shut interface stays down until No shut: flapping would not show anything (and could not bring it up)
    if (ref.indexOf('iface:') === 0) {
      const [, d, ...rest] = ref.split(':');
      if (this.engine.isShut(d, rest.join(':'))) return this.keepAction({ id: ++this.actSeq, kind: 'flap', at: this.now, target, error: `${target} is shut: bring it up first` });
    }
    if (!this.startFlap(ref)) return this.keepAction({ id: ++this.actSeq, kind: 'flap', at: this.now, target, error: `${target} has no cable to flap` });
    return this.keepAction({ id: ++this.actSeq, kind: 'flap', at: this.now, target, flap: { ref, obj: this.engine.flapOf(ref) as NonNullable<ReturnType<Engine['flapOf']>> } });
  }

  /**
   * Is a Network event running: a send with messages still to send or on their way (one waiting for
   * its source's DHCP lease does not count yet: nothing of it is in flight), a stream, a join waiting
   * for its router, a leave whose cleanup is not settled, flapping until it ends? Its traffic is then
   * the foreground of the display and the scenario the background (pacing.ts); a finished event, a
   * membership a join left behind or an event card kept in the list count for nothing.
   */
  foregroundActive(): boolean {
    this.updateLeaves();
    for (const a of this.acts) {
      if (a.run) {
        const r = a.run;
        if (!r.stopped && r.sent < r.count) return true;
        if (r.tests.some((t) => !t.done && t.result.indexOf('waiting for a DHCP lease') !== 0)) return true;
      } else if (a.stream) {
        if (a.stream.running) return true;
      } else if (a.join) {
        // a join until its membership is recorded (or its reports are out): the membership itself is no running action
        const j = a.join;
        if (j.byAt === undefined && j.leftAt === undefined && this.now < j.until) return true;
      } else if (a.leave) {
        // a leave until the network's cleanup it follows is settled
        if (a.leave.sent && a.leave.done === undefined) return true;
      } else if (a.flap) {
        // flapping until its cycles are done or it is stopped
        if (!a.flap.obj.ended) return true;
      } else if (a.app) {
        // an application until its messages are sent and settled (one waiting for its source's DHCP lease does not count yet)
        if (this.apps.pending(a.app)) return true;
        if (a.app.tests.some((t) => !t.done && t.result.indexOf('waiting for a DHCP lease') !== 0)) return true;
      }
    }
    return false;
  }

  /** The events of Network events, newest first, as the list shows them. */
  actions(): ActionView[] {
    this.updateLeaves();
    const c = this.actionContext();
    return this.acts.map((a) => actionView(a, c)).reverse();
  }

  /** An event's control: Stop (a send, a stream, flapping), No shut, Leave group. */
  actionControl(id: number, op: 'stop' | 'noshut' | 'leave'): boolean {
    const a = this.acts.find((x) => x.id === id);
    if (!a) return false;
    if (op === 'stop' && a.run) return this.stopRun(a.run.id);
    if (op === 'stop' && a.stream) return this.stopStream(a.stream.dev, a.stream.iface, a.stream.group);
    if (op === 'stop' && a.flap) return this.stopFlap(a.flap.ref);
    if (op === 'stop' && a.app) return this.apps.stop(a.app);
    if (op === 'noshut' && a.shut) return this.noShut(a.shut.dev, a.shut.iface);
    if (op === 'leave' && a.join) return this.leaveGroup(a.join.dev, a.join.iface, a.join.group);
    return false;
  }

  /** Clear finished: the events no longer queued or in progress leave the list. */
  clearFinished(): number {
    const keep = new Set(this.actions().filter((v) => v.status === 'queued' || v.status === 'running' || v.status === 'paused').map((v) => v.id));
    const n = this.acts.length - keep.size;
    this.acts = this.acts.filter((a) => keep.has(a.id));
    return n;
  }

  /**
   * The state changes in effect that no event of the list stands for: a cable or relation failed, a
   * device off, a container engine stopped (from the diagram's menus), a model's stream stopped or a
   * group it joins left, and what an event of the list no longer covers.
   */
  otherEvents(): NetEvent[] {
    const views = new Map(this.actions().map((v) => [v.id, v]));
    const covered = (e: NetEvent): boolean =>
      this.acts.some((a) => {
        const v = views.get(a.id);
        if (!v) return false;
        if (e.kind === 'shut' && a.shut) return e.ref === `iface:${a.shut.dev}:${a.shut.iface}` && v.controls.length > 0;
        if (e.kind === 'flap' && a.flap) return e.ref === a.flap.ref && v.status === 'running';
        if (e.kind === 'join' && a.join) return e.ref === `iface:${a.join.dev}:${a.join.iface}` && e.group === a.join.group && v.controls.length > 0;
        if (e.kind === 'stream' && a.stream) return e.ref === `iface:${a.stream.dev}:${a.stream.iface}` && e.group === a.stream.group && (v.status === 'running' || v.status === 'paused');
        return false;
      });
    return this.netEvents().filter((e) => !covered(e));
  }

  /** The titles of the operations (Network events' sections). */
  static readonly ACTION_TITLE = ACTION_TITLE;

  /** Why a host can't join a group on an interface now (Join multicast group's checks), or null. */
  joinProblem(dev: string, iface: string, group: string, sources: string[]): string | null {
    return this.multicast.joinProblem(dev, iface, group, sources);
  }

  /** Why a host can't start a stream to a group from an interface now, or null. */
  streamProblem(dev: string, iface: string, group: string): string | null {
    return this.multicast.streamProblem(dev, iface, group);
  }

  /** Start stream…: a host sends UDP to a group every interval; a text when it cannot. */
  startStream(dev: string, iface: string, group: string, port = 5004, interval = 1000, size = 1316): string | null {
    const r = this.multicast.addStream(dev, iface, group, port, interval, size, 'event');
    if (typeof r === 'string') return r;
    this.engine.stateVersion++;
    return null;
  }

  /** An experiment's multicast stream: on scenario time (a Network event's runs on real time), the same checks; the error, or null. */
  startExperimentStream(dev: string, iface: string, group: string, port: number, interval: number, size: number): string | null {
    const st = this.multicast.addStream(dev, iface, group, port, interval, size, 'experiment');
    if (typeof st === 'string') return st;
    this.engine.stateVersion++;
    return null;
  }

  /** What a host received of a multicast group so far (Multicast tables' reception), or null. */
  multicastReceived(dev: string, group: string): { count: number; first: number; last: number } | null {
    return this.multicast.received(dev, group);
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

  /** A host's own group memberships (Show group memberships). */
  memberTable(dev: string): GridTable {
    return this.multicast.memberTable(dev);
  }

  mrouteTable(dev: string): GridTable {
    return this.multicast.mrouteTable(dev);
  }

  /** What the diagram marks as down (cables, relations, interfaces, devices). */
  downRefs(): string[] {
    return this.engine.downRefs();
  }

  /** The state now, frozen for analysis (analysis/snapshot.ts): it never changes after this call. */
  snapshot(): AnalysisSnapshot {
    const s = this.engine.analysisSnapshot(this.downRefs());
    // the clocks' observed timing state: the protocol state, never an accuracy
    const timing: SnapTiming[] = [];
    for (const [dev, st] of Array.from(this.ntp.devs.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const src = st.source ? st.upstreams.find((u) => u.addr === st.source) : undefined;
      const t: SnapTiming = { dev, protocol: 'ntp', synchronized: st.own !== undefined || !!st.source, text: this.ntp.text(dev) };
      if (src && src.dev) t.source = src.dev;
      timing.push(t);
    }
    for (const [dev, c] of Array.from(this.ptp.clocks.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const t: SnapTiming = { dev, protocol: 'ptp', synchronized: c.state === 'synchronized' || c.state === 'grandmaster', text: c.state + (c.parent ? ` to the grandmaster ${c.parent.gmDev}` : '') };
      if (c.parent) t.source = c.parent.gmDev;
      timing.push(t);
    }
    return { ...s, timing };
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
    const t = this.transport.run({ from: o.from, via, target: o.to.trim(), dst: r.dst, name: r.name, kind: o.kind, port: o.kind === 'icmp' ? 0 : o.port, size: o.size, df: o.df, keep: o.keep, source: 'manual' });
    if (typeof t !== 'string') {
      const run: TestRun = { id: ++this.runSeq, series: t.series, plan: { delivery: 'unicast', from: o.from, via, kind: o.kind, target: o.to.trim() }, count: 1, interval: 0, t0: t.started, sent: 1, tests: [t], skipped: [], stopped: false };
      this.keepRun(run);
      this.keepAction({ id: ++this.actSeq, kind: 'send', at: this.now, target: run.series, run });
    }
    return t;
  }

  private runs: TestRun[] = [];
  private runSeq = 0;
  private acts: ActionRecord[] = [];
  private actSeq = 0;

  private keepRun(r: TestRun): void {
    this.runs.push(r);
    if (this.runs.length > 200) this.runs.splice(0, this.runs.length - 200);
  }

  /**
   * Send test as the form describes it (a delivery type, a source and its interface, the destination
   * the type asks for, a protocol, a port where it has one, and how many messages how far apart): the
   * first message now, at the current simulated time; message n at that time plus (n − 1) intervals of
   * simulated time, on the engine's own timeline, whether or not the messages before it were answered.
   * A text when it can't be sent (nothing is then scheduled). Each message finds its destination when
   * it is sent: a DHCP lease as it is then.
   */
  sendPlan(p: TestPlan): TestRun | string {
    const ready = this.preparePlan(p);
    if (typeof ready === 'string') return ready;
    const { via, first } = ready;
    const count = p.count === undefined ? 1 : p.count;
    const run: TestRun = { id: ++this.runSeq, series: '', plan: { ...p, via }, count, interval: count > 1 ? (p.interval as number) : 0, t0: this.now, sent: 0, tests: [], skipped: [], stopped: false };
    const one = (n: number): Test | string => {
      const d = n === 1 ? first : this.planTarget(p, via);
      if (typeof d === 'string') return `not sent: ${d}`;
      return this.transport.run({ from: p.from, via, target: d.target, dst: d.dst, name: d.name, kind: p.kind, port: usesPorts(p.kind) ? p.port : 0, size: p.size, df: p.df, keep: p.kind === 'tcp' && !!p.keep, source: 'manual', run: run.id, msg: n });
    };
    const t = one(1);
    if (typeof t === 'string') return t;
    run.series = t.series;
    run.sent = 1;
    run.tests.push(t);
    this.keepRun(run);
    // (every send is an event of Network events: one, whatever its number of messages)
    this.keepAction({ id: ++this.actSeq, kind: 'send', at: this.now, target: run.series, run });
    if (count > 1) this.nextMessage(run, one, 2);
    return run;
  }

  /**
   * What stops a plan from being sent now, in a few words, or null: the same checks as `sendPlan`
   * (the form disables Send with this text; the two can't disagree).
   */
  planCheck(p: TestPlan): string | null {
    const r = this.preparePlan(p);
    return typeof r === 'string' ? r : null;
  }

  private preparePlan(p: TestPlan): { via: string | undefined; first: { dst: IpAddr; target: string; name?: string } } | string {
    const bad = planProblem(p);
    if (bad) return bad;
    const src = this.testSources().find((x) => x.id === p.from);
    if (!src) return `${p.from} is not a device of the model.`;
    if (!src.ok) return `${p.from}: ${src.short}.`;
    const usable = src.ifaces.filter((i) => i.usable);
    let via = p.via;
    if (via !== undefined && !usable.some((i) => i.id === via)) return `${p.from} has no interface ${via} with an IP address or DHCP.`;
    if (via === undefined && needsInterface(p.delivery)) {
      if (usable.length !== 1) return 'Choose the interface to send from.';
      via = usable[0].id;
    }
    const first = this.planTarget(p, via);
    if (typeof first === 'string') return first + '.';
    return { via, first };
  }

  /** Message n of a series at its time (one timer at a time: a stopped series schedules nothing more). */
  private nextMessage(run: TestRun, one: (n: number) => Test | string, n: number): void {
    this.engine.at(messageTime(run.t0, n, run.interval), () => {
      if (run.stopped) return;
      const t = one(n);
      run.sent = n;
      if (typeof t === 'string') run.skipped.push({ n, t: this.now, why: t });
      else run.tests.push(t);
      if (n < run.count) this.nextMessage(run, one, n + 1);
    });
  }

  /** The destination of a plan's message now: the address, and how the test names it. */
  private planTarget(p: TestPlan, via: string | undefined): { dst: IpAddr; target: string; name?: string } | string {
    const e = this.engine;
    const sd = e.net.devices.get(p.from);
    if (p.delivery === 'unicast') {
      if (p.target) {
        const txt = p.target.trim();
        const a = parseAddress(txt);
        if (!a && (this.model.index.devices.has(txt) || this.model.index.devices.has(txt.split(':')[0]))) return `${txt} is a device: choose it under To`;
        if (a && e.isBroadcastAddr(a)) return `${txt} is a subnet’s broadcast address: choose Local or Directed broadcast`;
        const r = this.transport.resolveTarget(p.from, { to: txt }, p.kind);
        return typeof r === 'string' ? r : { dst: r.dst, target: txt, name: r.name };
      }
      const dev = p.to as string;
      const iface = p.toIface as string;
      const dd = this.testDestinations(p.from).find((d) => d.id === dev);
      if (!dd) return `${dev} is not a destination of ${p.from}`;
      const o = dd.options.find((x) => x.iface === iface && x.addr === p.toAddr);
      if (!o) return `${dev}:${iface} has no address ${p.toAddr === 'dhcp' ? 'from DHCP' : p.toAddr}`;
      if (!o.ok) return `${dev}:${iface} has no DHCP lease now`;
      let dst: IpAddr | null;
      if (o.addr === 'dhcp') {
        const l = e.leases.get(dev + ':' + iface);
        dst = l ? l.addr.addr : null;
      } else dst = parseAddress(o.addr);
      if (!dst) return `${dev}:${iface} has no address now`;
      // the target as written: the device when it offers just this address, else its interface (and the address when it has several)
      const target = dd.options.length === 1 ? dev : dd.options.filter((x) => x.iface === iface).length > 1 ? `${dev}:${iface} (${formatAddr(dst)})` : `${dev}:${iface}`;
      return { dst, target };
    }
    if (p.delivery === 'multicast') {
      const g = parseAddress((p.group as string).trim()) as IpAddr;
      const l = sd && via !== undefined ? sd.l3.get(via) : undefined;
      if (l && !this.leaseWaits(p.from, via as string) && !l.addrs.some((x) => x.addr.version === g.version)) return `${p.from}:${via} has no IPv${g.version} address for an IPv${g.version} group`;
      return { dst: g, target: formatAddr(g) };
    }
    if (p.delivery === 'broadcast') {
      const l = sd && via !== undefined ? sd.l3.get(via) : undefined;
      if (!l) return `${p.from} has no interface ${via}`;
      const v4 = l.addrs.find((x) => x.addr.version === 4);
      if (!v4 && !this.leaseWaits(p.from, via as string)) return `${p.from}:${via} has no IPv4 address: IPv6 has no broadcast (choose Multicast, e.g. ff02::1 for every node of the link)`;
      if (p.scope === 'limited') return { dst: parseAddress('255.255.255.255') as IpAddr, target: '255.255.255.255' };
      if (!v4) return `${p.from}:${via} has no IPv4 address yet, so its subnet broadcast is not known (the limited broadcast waits for the lease)`;
      if (v4.net.prefix > 30) return `${p.from}:${via} is a /${v4.net.prefix}: it has no subnet broadcast`;
      const b = subnetBroadcast(v4);
      return { dst: b, target: formatAddr(b) };
    }
    const b = directedTarget(p.subnet as string) as IpAddr;
    const text = formatAddr(b);
    if (!e.isBroadcastAddr(b)) return `${text} is not the broadcast address of a subnet of the model`;
    const own = !!sd && Array.from(sd.l3.values()).some((l) => (via === undefined || l.id === via) && l.addrs.some((x) => x.addr.version === 4 && x.net.prefix <= 30 && formatAddr(subnetBroadcast(x)) === text));
    if (own) return `${text} is the broadcast address of ${p.from}’s own subnet: choose Local broadcast`;
    return { dst: b, target: text };
  }

  /** Is a DHCP client interface still waiting for its lease (a test from it waits too)? */
  private leaseWaits(dev: string, iface: string): boolean {
    const mi = this.model.index.interfaces.get(dev + ':' + iface);
    return !!mi && !!mi.dhcp && !this.engine.leases.get(dev + ':' + iface);
  }

  /** The Send tests (each with its messages), newest first. */
  testRuns(): TestRun[] {
    return this.runs.slice().reverse();
  }

  /** Stop a series: no more of its messages are sent (those on their way finish). */
  stopRun(id: number): boolean {
    const r = this.runs.find((x) => x.id === id);
    if (!r || (!runPending(r) && !r.tests.some((t) => !t.done && !t.pktIds.length && !t.conn))) return false;
    r.stopped = true;
    r.stoppedAt = this.now;
    // a message still waiting (for its source's DHCP lease, a DNS answer) is not sent any more
    for (const t of r.tests) this.transport.cancel(t, CANCELLED);
    return true;
  }

  /** Stop every series (no more messages of any). */
  stopRuns(): number {
    let n = 0;
    for (const r of this.runs) if (this.stopRun(r.id)) n++;
    return n;
  }

  /**
   * Every device but the source as a unicast destination: each address of its interfaces as an
   * option ("eth0 - 10.0.0.1"), a DHCP client's interface with its lease now (or "No DHCP lease").
   */
  testDestinations(from: string): TestDestination[] {
    const e = this.engine;
    const out: TestDestination[] = [];
    for (const d of this.model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (d.id === from) continue;
      const sd = e.net.devices.get(d.id);
      const caps = sd ? sd.caps : capabilities(d);
      if (!caps.ipStack || !sd) {
        out.push({ id: d.id, ok: false, short: 'Cannot receive IP packets', options: [] });
        continue;
      }
      const options: TestDestOption[] = [];
      for (const l of Array.from(sd.l3.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const mi = this.model.index.interfaces.get(d.id + ':' + l.id);
        if (mi && mi.dhcp) {
          const lease = e.leases.get(d.id + ':' + l.id);
          options.push({ value: `${l.id}|dhcp`, iface: l.id, addr: 'dhcp', label: lease ? `${l.id} - ${formatAddr(lease.addr.addr)} (${lease.kind === 'dhcp' ? 'DHCP' : 'link-local'})` : `${l.id} - No DHCP lease`, ok: !!lease });
          continue;
        }
        for (const a of l.addrs) options.push({ value: `${l.id}|${formatAddr(a.addr)}`, iface: l.id, addr: formatAddr(a.addr), label: `${l.id} - ${formatAddr(a.addr)}`, ok: true });
      }
      const ok = options.some((o) => o.ok);
      out.push({ id: d.id, ok, short: ok ? '' : options.length ? 'No DHCP lease' : 'No IP address', options });
    }
    return out;
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
        out.push({ id: d.id, ok: false, reason: `it has no IP stack of its own (${what}): it forwards or observes traffic and sends none`, short: 'Cannot send IP packets', ifaces: [] });
        continue;
      }
      const ifaces: TestSourceIface[] = [];
      const l3s = Array.from(sd.l3.values()).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const l of l3s) {
        const mi = this.model.index.interfaces.get(d.id + ':' + l.id);
        const dhcp = !!mi && !!mi.dhcp;
        const at = this.attachment(d.id, l.id);
        // automatic IPv6: its state in a few words (SLAAC pending, DHCPv6 pending, an address, no default router …)
        const v6 = this.ipv6.status(d.id, l.id);
        if (!dhcp) {
          if (!l.addrs.length) {
            ifaces.push({ id: l.id, dhcp: false, ready: false, usable: false, label: `${l.id} - ${v6 || 'No IP address'}`, status: v6 || 'no IP address' });
            continue;
          }
          ifaces.push({ id: l.id, dhcp: false, ready: true, usable: true, label: `${l.id} - ${l.addrs.map((a) => formatAddr(a.addr)).join(', ')}`, bcast: bcastOf(l.addrs), status: `${l.addrs.map((a) => a.text).join(', ')}${at ? ' · ' + at : ''}` });
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
        const label = lease ? `${l.id} - ${formatAddr(lease.addr.addr)} (${lease.kind === 'dhcp' ? 'DHCP' : 'link-local'})` : `${l.id} - No DHCP lease`;
        ifaces.push({ id: l.id, dhcp: true, ready, usable: true, label, bcast: lease ? bcastOf([lease.addr]) : undefined, status: status + (v6 ? ' · IPv6: ' + v6 : '') + (at ? ' · ' + at : '') });
      }
      const usable = ifaces.filter((i) => i.usable);
      if (!usable.length) {
        out.push({ id: d.id, ok: false, reason: 'no interface with an address or DHCP: give one an address, or turn DHCP on', short: ifaces.length ? 'No IP address' : 'No interfaces', ifaces });
        continue;
      }
      if (!e.deviceOn(d.id)) {
        out.push({ id: d.id, ok: false, reason: 'it is powered off (Power on in its menu)', short: 'Powered off', ifaces });
        continue;
      }
      const ready = usable.filter((i) => i.ready);
      const waiting = usable.find((i) => i.dhcp && !i.ready);
      out.push({ id: d.id, ok: true, reason: ready.length ? '' : waiting ? waiting.status.replace(/ · .*$/, '') : '', short: '', ifaces });
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
    if (!seen.has(id)) seen.set(id, { id, label, group, uses: 0, unit, support: entrySupport(id) });
    const u = users.get(id) || new Set<string>();
    u.add(user);
    users.set(id, u);
  };
  // multicast routing has a group of its own
  const groupOf = (id: string, g: SimEntryGroup): SimEntryGroup => (id === 'pim' || id === 'igmp' || id === 'mcast' ? 'Multicast' : g);
  const ifs = (d: Model['devices'][number]): Model['devices'][number]['interfaces'] => d.interfaces.concat(d.logical);
  for (const d of model.devices) {
    // (a DHCP client too: it has its address once leased)
    const addrs = ifs(d).filter((i) => i.type !== 'loopback' && ipConfigured(i));
    if (!addrs.length) continue;
    add('arp', 'ARP', 'Layer 2', 'device', d.id);
    add('garp', 'Gratuitous ARP', 'Layer 2', 'device', d.id);
    if (addrs.some((i) => i.addresses.some((a) => a.indexOf(':') >= 0) || autoIpv6(i.ipv6) || !!i.ra)) add('ndp', 'NDP', 'Layer 2', 'device', d.id);
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
    if (!ifs(d).some((i) => ipConfigured(i))) continue;
    for (const [id, label] of [['icmp', 'ICMP / ICMPv6'], ['tcp', 'TCP (tests)'], ['udp', 'UDP (tests)']]) add(id, label, 'Traffic', 'device', d.id);
  }
  // DHCPv6: its servers (a scope on an IPv6 network) and clients
  for (const d of model.devices) {
    const v6scope = !!d.netServices && !!d.netServices.dhcp && d.netServices.dhcp.scopes.some((s) => {
      const n = s.network ? model.networks.find((x) => x.id === s.network) : undefined;
      return !!n && !!n.cidr && n.cidr.indexOf(':') >= 0;
    });
    if (v6scope || ifs(d).some((i) => i.ipv6 === 'dhcpv6' || i.ipv6 === 'slaac_dhcpv6' || (i.ipv6 === 'slaac' && model.devices.some((r) => ifs(r).some((x) => !!x.ra && x.ra.other))))) add('dhcpv6', 'DHCPv6', 'Services', 'device', d.id);
  }
  // PTP: its clocks (and NTP, the service's own state, beside its relations)
  for (const d of model.devices) {
    if (d.appServices && d.appServices.has('ptp')) add('ptp', 'PTP', 'Services', 'device', d.id);
  }
  // MQTT: its brokers and clients
  for (const d of model.devices) {
    if ((d.appServices && d.appServices.has('mqtt_broker')) || (d.applications || []).some((a) => a.profile === 'mqtt_client')) add('mqtt', 'MQTT', 'Services', 'device', d.id);
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
    // a switch that is a snooping querier candidate (a VLAN of it with the snooping querier on and its snooping enabled): its queries are IGMP too
    const querierVlans = model.networks.filter((n) => n.vlan !== undefined && !!n.simulation && n.simulation.get('snoop-querier') === 'on').map((n) => n.vlan as number);
    // (and an IPv4 address on its VLAN interface there to query from)
    const svi = (v: number): boolean => d.logical.some((i) => i.type === 'virtual' && i.vlan === v && i.addresses.some((a) => a.indexOf(':') < 0));
    if (querierVlans.some((v) => snoopingChoice(d, v) === 'enabled' && switchedVlans(d).indexOf(v) >= 0 && svi(v))) add('igmp', 'IGMP / MLD', 'Multicast', 'device', d.id);
    for (const i of ifs(d)) for (const st of i.multicast ? i.multicast.streams : []) add('mcast', 'Multicast streams', 'Multicast', 'stream', `${d.id}:${i.id}:${st.group}`);
  }
  for (const e of seen.values()) e.uses = (users.get(e.id) as Set<string>).size;
  const order = (g: SimEntryGroup): number => ENTRY_GROUPS.indexOf(g);
  return Array.from(seen.values()).sort((a, b) => order(a.group) - order(b.group) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

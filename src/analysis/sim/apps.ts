/**
 * The applications of the simulation (model/applications.ts): what a
 * client application sends when it runs, built on the transport's tests
 * (transport.ts: a TCP connection with its request and answer, a UDP
 * request and its answer, a one-way datagram), so every message crosses
 * the network with its addressing, routing, firewall policy and closed
 * ports, and is drawn and inspected like any other.
 *
 * A listener application listens because it exists (the transport opens
 * its port, on its bind interface only when it has one, and answers with
 * its sizes and delay). A client sends only when it is started: from
 * Network events (Start application: the foreground, its interval in real
 * time like a stream's), or with the simulation when its `start` says so
 * (the scenario's traffic, its interval in simulated time, from the chosen
 * senders only). Nothing starts because an application was added.
 *
 * Each message finds its peer when it is sent: another device's
 * application (its port, its bind interface's address), a device, an
 * address, or a host name resolved by DNS (A, or AAAA for IPv6), in the
 * address family the application uses (IPv4 unless its `ip_version` says
 * 6; never a fallback to the other family). What is missing (no address
 * of the family at either end, the peer gone from the model) ends that
 * message with the reason. A request that times out is sent again up to
 * its retries. A run is one operation with its counts and its messages'
 * results (actions.ts); several run side by side.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { APP_DEFAULTS, AppInstance, AppProfile, appProfile, parsePeer } from '../../model/applications';
import { formatAddr } from '../ipmath';
import { durationText } from './params';
import { ProtocolSim } from './protocols';
import { RealTimeScheduler } from './realtime';
import { SessionStatus } from './types';
import { Test, Transport } from './transport';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One start of a client application: its messages and how they went. */
export interface AppRun {
  id: number;
  dev: string;
  app: AppInstance;
  /** started from Network events (the foreground) or with the simulation (the scenario's) */
  /** experiment: started by an experiment (scenario time, as the scenario's; its messages carry their ids: the experiment's traffic) */
  how: 'event' | 'start' | 'experiment';
  /** "plc/registers", "10.0.0.30:5000", "nas.home.arpa:445" */
  target: string;
  t0: number;
  /** messages per start (null: until stopped) */
  count: number | null;
  /** ms between two messages (0: one message) */
  interval: number;
  /** messages started (not counting their retries) */
  sent: number;
  /** every message sent, retries included */
  tests: Test[];
  retried: number;
  /** messages that could not be sent at all, with why */
  skipped: Array<{ n: number; t: number; why: string }>;
  stopped: boolean;
  stoppedAt?: number;
  /** a run of Network events with an interval: its real-time schedule entry */
  rt?: number;
}

/** Where a message of an application goes now: its address, how it is named, its port (a host name: resolved when it is sent). */
interface PeerNow {
  dst: IpAddr;
  target: string;
  port: number;
  name?: string;
}

export class AppSim {
  private seq = 0;
  readonly runs: AppRun[] = [];
  /** the real-time schedule of Network events (the runs started there repeat on it) */
  realtime: RealTimeScheduler | null = null;

  constructor(
    private P: ProtocolSim,
    private T: Transport,
  ) {
    P.bootHooks.push(() => this.startConfigured());
    P.extraStatus.push(() => this.status());
  }

  private get e() {
    return this.P.e;
  }

  /** A device's application by id. */
  app(dev: string, id: string): AppInstance | undefined {
    const d = this.P.m.index.devices.get(dev);
    return d && d.applications ? d.applications.find((a) => a.id === id) : undefined;
  }

  /** The applications of a device that can be started (clients, senders; an MQTT client by mqtt.ts). */
  startable(dev: string): AppInstance[] {
    const d = this.P.m.index.devices.get(dev);
    return (d && d.applications ? d.applications : []).filter((a) => {
      const p = appProfile(a.profile);
      return !!p && p.client;
    });
  }

  /** The address family an application uses: its peer address's, else its ip_version, else IPv4. */
  family(a: AppInstance): 4 | 6 {
    const pa = a.peer ? parseAddress(a.peer) : null;
    return pa ? pa.version : a.ipVersion || 4;
  }

  /**
   * Where a message goes now, or why it can't go: the peer application's
   * device and port (its bind interface's address), a device, an address,
   * or a host name (with the port).
   */
  peerNow(dev: string, a: AppInstance): PeerNow | string {
    const v = this.family(a);
    if (!a.peer) return `${dev}/${a.id} has no peer`;
    const pr = parsePeer(a.peer);
    if (pr.device !== undefined) {
      const target = this.app(pr.device, pr.app || '');
      if (!target || target.port === undefined) return `${a.peer} is no application of the model`;
      const addr = this.addrOf(pr.device, v, target.bind);
      if (typeof addr === 'string') return `${a.peer}: ${addr}`;
      return { dst: addr, target: a.peer, port: target.port };
    }
    const port = a.port as number;
    const ip = parseAddress(a.peer);
    if (ip) return { dst: ip, target: `${a.peer}:${port}`, port };
    if (this.P.m.index.devices.has(a.peer)) {
      const addr = this.addrOf(a.peer, v);
      if (typeof addr === 'string') return addr;
      return { dst: addr, target: `${a.peer}:${port}`, port };
    }
    // a host name: its DNS answer when the message is sent
    return { dst: parseAddress(v === 4 ? '0.0.0.0' : '::') as IpAddr, target: `${a.peer}:${port}`, port, name: a.peer };
  }

  /** A device's address of a family now (its bind interface's, when it has one): its first interface's that has one (loopbacks last). */
  private addrOf(dev: string, v: 4 | 6, bind?: string): IpAddr | string {
    const sd = this.P.sd(dev);
    if (!sd) return `${dev} is not in the simulation`;
    if (bind !== undefined) {
      const l = sd.l3.get(bind);
      const x = l ? l.addrs.find((y) => y.addr.version === v) : undefined;
      return x ? x.addr : `it listens on ${dev}:${bind} only, which has no IPv${v} address${this.e.waitsForLease(dev) ? ' yet (waiting for its DHCP lease)' : ''}`;
    }
    const ls = Array.from(sd.l3.values()).filter((l) => l.kind !== 'tunnel').sort((x, y) => Number(x.kind === 'loopback') - Number(y.kind === 'loopback') || cmp(x.id, y.id));
    for (const l of ls) for (const x of l.addrs) if (x.addr.version === v) return x.addr;
    return `${dev} has no IPv${v} address${this.e.waitsForLease(dev) && v === 4 ? ' yet (waiting for its DHCP lease)' : ''}`;
  }

  /** What stops an application from being started now (null: it can be). */
  problem(dev: string, id: string): string | null {
    const a = this.app(dev, id);
    if (!a) return `${dev} has no application ${id}`;
    const p = appProfile(a.profile);
    if (!p || !p.client) return `${dev}/${id} is a listener: it answers, it is not started`;
    if (p.id === 'mqtt_client') return this.mqttProblem ? this.mqttProblem(dev, a) : 'MQTT clients are not part of this simulation';
    if (!this.e.deviceOn(dev)) return `${dev} is powered off`;
    if (this.runs.some((r) => r.dev === dev && r.app.id === id && this.active(r))) return `${dev}/${id} is running already`;
    const peer = this.peerNow(dev, a);
    if (typeof peer === 'string' && !/waiting for its DHCP lease/.test(peer)) return peer;
    return null;
  }

  /** An MQTT client's start and stop, by mqtt.ts (it keeps a session, not a series of tests). */
  mqttProblem: ((dev: string, a: AppInstance) => string | null) | null = null;
  mqttStart: ((dev: string, a: AppInstance, how: 'event' | 'start' | 'experiment') => AppRun | string) | null = null;
  mqttStop: ((run: AppRun) => boolean) | null = null;

  /** The id of a new run (an MQTT client's too). */
  nextId(): number {
    return ++this.seq;
  }

  /** Start a client application: its first message now, then one every interval (its count, or until stopped). */
  start(dev: string, id: string, how: 'event' | 'start' | 'experiment'): AppRun | string {
    const why = this.problem(dev, id);
    if (why) return why;
    const a = this.app(dev, id) as AppInstance;
    const p = appProfile(a.profile) as AppProfile;
    if (p.id === 'mqtt_client') return (this.mqttStart as NonNullable<AppSim['mqttStart']>)(dev, a, how);
    const peer = this.peerNow(dev, a);
    const interval = a.interval || 0;
    const count = interval ? (a.count !== undefined ? a.count : null) : 1;
    const run: AppRun = { id: this.nextId(), dev, app: a, how, target: typeof peer === 'string' ? a.peer || '?' : peer.target, t0: this.e.now, count, interval, sent: 0, tests: [], retried: 0, skipped: [], stopped: false };
    this.runs.push(run);
    if (this.runs.length > 200) this.runs.splice(0, this.runs.length - 200);
    const fire = (n: number): void => {
      if (run.stopped || (run.count !== null && n >= run.count)) return;
      this.message(run, p, n + 1, 0);
      if (run.count !== null && run.sent >= run.count) this.unschedule(run);
    };
    if (interval && how === 'event' && this.realtime) {
      // a run of Network events repeats in real time, as a stream does: its first message now
      run.rt = this.realtime.add(interval, fire).id;
    } else {
      fire(0);
      const next = (n: number): void => {
        if (!interval || run.stopped || (run.count !== null && n >= run.count)) return;
        this.e.at(run.t0 + n * interval, () => {
          if (run.stopped) return;
          fire(n);
          next(n + 1);
        });
      };
      next(1);
    }
    return run;
  }

  private unschedule(run: AppRun): void {
    if (run.rt !== undefined && this.realtime) this.realtime.remove(run.rt);
    run.rt = undefined;
  }

  /** Stop a run: no more messages (those on their way finish); an MQTT client unsubscribes and disconnects. */
  stop(run: AppRun): boolean {
    if (run.app.profile === 'mqtt_client') return !!this.mqttStop && this.mqttStop(run);
    if (run.stopped || !this.pending(run)) return false;
    run.stopped = true;
    run.stoppedAt = this.e.now;
    this.unschedule(run);
    for (const t of run.tests) this.T.cancel(t, 'not sent: cancelled (Stop)');
    return true;
  }

  /** Are messages of a run still to be sent? */
  pending(r: AppRun): boolean {
    return !r.stopped && (r.count === null || r.sent < r.count);
  }

  /** Is a run going on: messages to send, or on their way? */
  active(r: AppRun): boolean {
    return this.pending(r) || r.tests.some((t) => !t.done);
  }

  /** Message n (try 0, or a retry): to its peer as it is now. */
  private message(run: AppRun, p: AppProfile, n: number, retry: number): void {
    const a = run.app;
    if (retry === 0) run.sent = n;
    if (!this.e.deviceOn(run.dev)) {
      run.skipped.push({ n, t: this.e.now, why: `not sent: ${run.dev} is powered off` });
      return;
    }
    const peer = this.peerNow(run.dev, a);
    if (typeof peer === 'string') {
      run.skipped.push({ n, t: this.e.now, why: `not sent: ${peer}` });
      return;
    }
    const v = this.family(a);
    const tcp = p.transport === 'tcp';
    const size = a.requestSize !== undefined ? a.requestSize : tcp ? APP_DEFAULTS.tcpRequest : APP_DEFAULTS.udpRequest;
    const name = `${run.dev}/${a.id}`;
    const t = this.T.run({
      from: run.dev,
      target: peer.target,
      dst: peer.dst,
      name: peer.name,
      qtype: v === 6 ? 'AAAA' : 'A',
      kind: p.transport,
      port: peer.port,
      size,
      source: run.how === 'event' ? 'manual' : run.how === 'experiment' ? 'experiment' : 'traffic',
      series: `${name} → ${peer.target} ${p.transport}/${peer.port}`,
      run: run.id,
      msg: n,
      retry: retry || undefined,
      app: name,
      oneWay: !p.answered,
      timeout: a.timeout !== undefined ? { value: a.timeout } : undefined,
      onDone: (x) => {
        // a request without an answer in time: again, up to its retries (an error or a refusal is no reason to retry)
        if (x.ok || !p.answered || !/timed out/.test(x.result) || retry >= (a.retries || 0) || run.stopped) return;
        run.retried++;
        this.e.withTest(run.how !== 'start' ? x.id : null, () => this.e.note('message', p.transport, run.dev, '', 'retry', '', `${name}: message ${n} got no answer within its timeout: retry ${retry + 1} of ${a.retries}`));
        this.message(run, p, n, retry + 1);
      },
    });
    if (typeof t === 'string') run.skipped.push({ n, t: this.e.now, why: `not sent: ${t}` });
    else run.tests.push(t);
  }

  /** The applications that start with the simulation: from the chosen senders, once the network had time to come up. */
  private startConfigured(): void {
    for (const d of this.P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      for (const a of d.applications || []) {
        if (a.start !== 'simulation_start') continue;
        const p = appProfile(a.profile);
        if (!p || !p.client) continue;
        this.e.at(3000 + this.e.jitter(), () => {
          if (!this.e.isSender(d.id)) return;
          const r = this.start(d.id, a.id, 'start');
          if (typeof r === 'string') this.e.note('note', p.transport, d.id, '', 'application not started', '', `${d.id}/${a.id} (${a.name}) does not start with the simulation: ${r}`);
        });
      }
    }
  }

  /** The runs started with the simulation, as status rows (those of Network events are in Active events). */
  private status(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const r of this.runs) {
      if (r.how !== 'start' || r.app.profile === 'mqtt_client') continue;
      const o = appOutcome(r);
      const p = appProfile(r.app.profile) as AppProfile;
      out.push({
        protocol: p.transport,
        name: `${r.dev}/${r.app.id}: ${r.app.name}`,
        device: r.dev,
        peer: r.target.split('/')[0].split(':')[0],
        state: this.active(r) ? 'Running' : 'Done',
        up: o.failed === 0,
        detail: `${p.label} to ${r.target}, ${appCadence(r)}: ${appSummaryText(r, o)}`,
      });
    }
    return out;
  }
}

/** A run's messages as outcomes: answered (or, one-way, received), failed, pending, cancelled; retries not counted twice. */
export function appOutcome(r: AppRun): { ok: number; failed: number; pending: number; cancelled: number; retries: number } {
  // the last try of each message decides it
  const last = new Map<number, Test>();
  for (const t of r.tests) {
    const k = t.msg || 1;
    const was = last.get(k);
    if (!was || (t.retry || 0) >= (was.retry || 0)) last.set(k, t);
  }
  let ok = 0;
  let failed = r.skipped.length;
  let pending = 0;
  let cancelled = 0;
  for (const t of last.values()) {
    if (!t.done) pending++;
    else if (/cancelled \(Stop\)/.test(t.result)) cancelled++;
    else if (t.ok) ok++;
    else failed++;
  }
  return { ok, failed, pending, cancelled, retries: r.retried };
}

/** "12 answered · 1 failed · 2 retries". */
export function appSummaryText(r: AppRun, o = appOutcome(r)): string {
  const p = appProfile(r.app.profile);
  const okWord = p && !p.answered ? 'received' : 'answered';
  const parts: string[] = [];
  if (o.ok) parts.push(`${o.ok} ${okWord}`);
  if (o.failed) parts.push(`${o.failed} failed`);
  if (o.pending) parts.push(`${o.pending} pending`);
  if (o.cancelled) parts.push(`${o.cancelled} cancelled`);
  if (o.retries) parts.push(`${o.retries} retr${o.retries === 1 ? 'y' : 'ies'}`);
  return parts.join(' · ') || 'nothing sent yet';
}

/** "every 5 s of real time", "every 2 s", "one message". */
export function appCadence(r: AppRun): string {
  if (!r.interval) return 'one message';
  return `every ${durationText(r.interval)}${r.rt !== undefined || r.how === 'event' ? ' of real time' : ''}${r.count !== null ? `, ${r.count} message${r.count === 1 ? '' : 's'}` : ', until stopped'}`;
}

/** The address the run's last message went to, for the details. */
export function lastDst(r: AppRun): string {
  const t = r.tests[r.tests.length - 1];
  return t ? formatAddr(t.dst) : '';
}

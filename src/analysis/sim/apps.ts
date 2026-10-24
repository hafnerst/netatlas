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
import { APP_DEFAULTS, AppInstance, AppProfile, appFamily, appProfile, parsePeer } from '../../model/applications';
import { formatAddr } from '../ipmath';
import { fmtSec } from './engine';
import { durationText } from './params';
import { ProtocolSim } from './protocols';
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
  /** attempts that could not be sent at all, with why (retry: which attempt of message n; 0 or absent: its first) */
  skipped: Array<{ n: number; t: number; why: string; retry?: number }>;
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

/** How many finished runs the history keeps (a run still going on always stays: it is the simulation's own state). */
const RUN_HISTORY = 200;

/** An application that starts with the simulation, until it has started: due, waiting for its device, started, refused. */
interface Configured {
  dev: string;
  app: AppInstance;
  state: 'due' | 'waiting' | 'started' | 'refused';
  why?: string;
  /** the latest attempt scheduled (a device that becomes operational again schedules a new one, the earlier void) */
  gen: number;
}

export class AppSim {
  private seq = 0;
  readonly runs: AppRun[] = [];
  private configured = new Map<string, Configured>();

  constructor(
    private P: ProtocolSim,
    private T: Transport,
  ) {
    P.bootHooks.push(() => this.startConfigured());
    // a device that becomes operational: what waited for it to start with the simulation is tried again
    P.deviceHooks.push((dev, up) => {
      if (up) this.deviceUp(dev);
    });
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
    return appFamily(a);
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
    // (loopbacks, then a container bridge's interface, last: as Send test resolves a device, communication.ts appAddress)
    const back = (l: { id: string; kind: string }): number => (l.kind === 'loopback' ? 1 : (this.P.m.index.interfaces.get(dev + ':' + l.id) || { type: '' }).type === 'bridge' ? 2 : 0);
    const ls = Array.from(sd.l3.values()).filter((l) => l.kind !== 'tunnel').sort((x, y) => back(x) - back(y) || cmp(x.id, y.id));
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
    if (p.id === 'mqtt_client') {
      const r = (this.mqttStart as NonNullable<AppSim['mqttStart']>)(dev, a, how);
      this.prune();
      return r;
    }
    const peer = this.peerNow(dev, a);
    const interval = a.interval || 0;
    const count = interval ? (a.count !== undefined ? a.count : null) : 1;
    const run: AppRun = { id: this.nextId(), dev, app: a, how, target: typeof peer === 'string' ? a.peer || '?' : peer.target, t0: this.e.now, count, interval, sent: 0, tests: [], retried: 0, skipped: [], stopped: false };
    this.runs.push(run);
    this.prune();
    const fire = (n: number): void => {
      if (run.stopped || (run.count !== null && n >= run.count)) return;
      this.message(run, p, n + 1, 0);
    };
    // the first message now, then every interval of simulated time (the scenario's; never the page's frames)
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
    return run;
  }

  /**
   * Stop a run: no more messages and no more retries; a message not sent yet (waiting for its DHCP lease, a DNS answer)
   * is not sent, one on its way finishes. Also while its last message is still on its way (a retry may follow it). An
   * MQTT client unsubscribes and disconnects.
   */
  stop(run: AppRun): boolean {
    if (run.app.profile === 'mqtt_client') return !!this.mqttStop && this.mqttStop(run);
    if (run.stopped || !this.active(run)) return false;
    run.stopped = true;
    run.stoppedAt = this.e.now;
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

  /** The history bounded: the oldest finished runs leave it, never one still going on (an MQTT client until stopped). */
  private prune(): void {
    let over = this.runs.length - RUN_HISTORY;
    for (let i = 0; over > 0 && i < this.runs.length; ) {
      const r = this.runs[i];
      if (r.app.profile === 'mqtt_client' ? !r.stopped : this.active(r)) i++;
      else {
        this.runs.splice(i, 1);
        over--;
      }
    }
  }

  /** Message n (try 0, or a retry): to its peer as it is now. */
  private message(run: AppRun, p: AppProfile, n: number, retry: number): void {
    const a = run.app;
    if (retry === 0) run.sent = n;
    if (!this.e.deviceOn(run.dev)) {
      run.skipped.push({ n, t: this.e.now, why: `not sent: ${run.dev} is powered off`, retry });
      return;
    }
    const peer = this.peerNow(run.dev, a);
    if (typeof peer === 'string') {
      run.skipped.push({ n, t: this.e.now, why: `not sent: ${peer}`, retry });
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
        if (x.ok || !p.answered || !(x.outcome && x.outcome.kind === 'timeout') || retry >= (a.retries || 0) || run.stopped) return;
        run.retried++;
        this.e.withTest(run.how !== 'start' ? x.id : null, () => this.e.note('message', p.transport, run.dev, '', 'retry', '', `${name}: message ${n} got no answer within its timeout: retry ${retry + 1} of ${a.retries}`));
        this.message(run, p, n, retry + 1);
      },
    });
    if (typeof t === 'string') run.skipped.push({ n, t: this.e.now, why: `not sent: ${t}`, retry });
    else run.tests.push(t);
  }

  /**
   * The applications that start with the simulation (their own start setting; the Senders choose only what is shown),
   * once the network had time to come up: 3 s after the start — or, for a device not operational then (booting, off,
   * waiting for its host), 3 s after it has booted. Each starts once: a run of it already going on is not doubled.
   */
  private startConfigured(): void {
    for (const d of this.P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      for (const a of d.applications || []) {
        if (a.start !== 'simulation_start') continue;
        const p = appProfile(a.profile);
        if (!p || !p.client) continue;
        const key = `${d.id}/${a.id}`;
        this.configured.set(key, { dev: d.id, app: a, state: 'due', gen: 0 });
        this.e.at(3000 + this.e.jitter(d.id), () => this.startOne(key, 0));
      }
    }
  }

  /** A device became operational: what waited for it is tried once the network had time to come up (the latest boot only). */
  private deviceUp(dev: string): void {
    for (const [key, c] of this.configured) {
      if (c.dev !== dev || c.state !== 'waiting') continue;
      const g = ++c.gen;
      this.e.at(this.e.now + 3000 + this.e.jitter(dev), () => this.startOne(key, g));
    }
  }

  /** One attempt of an application that starts with the simulation: started; waiting for its device (said once); refused (said). */
  private startOne(key: string, g: number): void {
    const c = this.configured.get(key);
    if (!c || c.gen !== g || c.state === 'started' || c.state === 'refused') return;
    const { dev, app: a } = c;
    const p = appProfile(a.profile) as AppProfile;
    const proto = p.id === 'mqtt_client' ? 'mqtt' : p.transport;
    // not operational yet (booting, powered off, waiting for its host): it waits — not a refusal
    const ps = this.e.powerState(dev);
    if (ps ? ps.state !== 'on' : !this.e.deviceOn(dev)) {
      const why = ps && ps.state === 'booting' ? `${dev} is booting (up at t = ${fmtSec(ps.until as number)})` : `${dev} is powered off${ps && ps.why ? ` (${ps.why})` : ''}`;
      if (c.state !== 'waiting' || c.why !== why) this.e.note('note', proto, dev, '', 'application waiting', '', `${key} (${a.name}) starts with the simulation once ${dev} is operational: ${why}`);
      c.state = 'waiting';
      c.why = why;
      return;
    }
    const r = this.start(dev, a.id, 'start');
    if (typeof r !== 'string') {
      c.state = 'started';
      c.why = undefined;
      return;
    }
    // (started meanwhile from Network events or an experiment: that run goes on, not a second one)
    c.state = /is running already/.test(r) ? 'started' : 'refused';
    c.why = r;
    this.e.note('note', proto, dev, '', 'application not started', '', `${key} (${a.name}) does not start with the simulation: ${r}`);
  }

  /** The runs started with the simulation, as status rows (those of Network events are in Active events). */
  private status(): SessionStatus[] {
    const out: SessionStatus[] = [];
    // what waits for its device to start with the simulation (not started yet: no run)
    for (const [key, c] of this.configured) {
      if (c.state !== 'waiting') continue;
      const p = appProfile(c.app.profile) as AppProfile;
      out.push({ protocol: p.id === 'mqtt_client' ? 'mqtt' : p.transport, name: `${key}: ${c.app.name}`, device: c.dev, peer: '', state: 'Waiting', up: false, detail: `starts with the simulation once ${c.dev} is operational: ${c.why}` });
    }
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

/**
 * A run's messages as outcomes, one per original message: answered (or, one-way, received), failed, pending, cancelled.
 * Its last attempt decides each — a try sent, or one that could not be sent (a skipped retry fails that message once,
 * not again); the retries are counted apart.
 */
export function appOutcome(r: AppRun): { ok: number; failed: number; pending: number; cancelled: number; retries: number } {
  const last = new Map<number, { retry: number; t?: Test }>();
  for (const t of r.tests) {
    const k = t.msg || 1;
    const was = last.get(k);
    if (!was || (t.retry || 0) >= was.retry) last.set(k, { retry: t.retry || 0, t });
  }
  for (const s of r.skipped) {
    const was = last.get(s.n);
    if (!was || (s.retry || 0) >= was.retry) last.set(s.n, { retry: s.retry || 0 });
  }
  let ok = 0;
  let failed = 0;
  let pending = 0;
  let cancelled = 0;
  for (const { t } of last.values()) {
    if (!t) failed++;
    else if (!t.done) pending++;
    else if (t.outcome && t.outcome.kind === 'cancelled') cancelled++;
    else if (t.ok) ok++;
    else failed++;
  }
  return { ok, failed, pending, cancelled, retries: r.retried };
}

/** A run's messages by their last attempt sent (what decides each; a skipped last attempt is in `skipped`), in message order. */
export function lastAttempts(r: AppRun): Test[] {
  const last = new Map<number, Test>();
  for (const t of r.tests) {
    const k = t.msg || 1;
    const was = last.get(k);
    if (!was || (t.retry || 0) >= (was.retry || 0)) last.set(k, t);
  }
  return Array.from(last.keys())
    .sort((a, b) => a - b)
    .map((k) => last.get(k) as Test);
}

/**
 * A run as it is compared with a static result (comm-identity.ts RunRecord): each message by its last attempt — a try
 * sent, or the attempt that could not be sent (then in `skipped`, its earlier tries left out).
 */
export function appRunRecord(r: AppRun): { tests: Test[]; skipped: AppRun['skipped']; count: number | null; sent: number; stopped: boolean } {
  const tests = lastAttempts(r);
  const lastSkip = new Map<number, number>();
  for (const s of r.skipped) lastSkip.set(s.n, Math.max(lastSkip.has(s.n) ? (lastSkip.get(s.n) as number) : -1, s.retry || 0));
  const kept = tests.filter((t) => !lastSkip.has(t.msg || 1) || (t.retry || 0) > (lastSkip.get(t.msg || 1) as number));
  const keptMsgs = new Set(kept.map((t) => t.msg || 1));
  const skipped = r.skipped.filter((s) => !keptMsgs.has(s.n) && (s.retry || 0) === lastSkip.get(s.n));
  return { tests: kept, skipped, count: r.count, sent: r.sent, stopped: r.stopped };
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
  return `every ${durationText(r.interval)}${r.count !== null ? `, ${r.count} message${r.count === 1 ? '' : 's'}` : ', until stopped'}`;
}

/** The address the run's last message went to, for the details. */
export function lastDst(r: AppRun): string {
  const t = r.tests[r.tests.length - 1];
  return t ? formatAddr(t.dst) : '';
}

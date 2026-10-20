/**
 * PTP in the simulation (model/ptp.ts): PTPv2 of IEEE 1588-2008, the
 * Delay Request-Response Default profile over UDP/IPv4 multicast
 * (224.0.1.129, event messages to 319, general messages to 320, TTL 1),
 * two-step, end-to-end. Every message is a datagram of the simulation: it
 * crosses cables, switches (their VLANs and IGMP snooping: a clock's ports
 * join 224.0.1.129, as ptp4l does) and policy, and is drawn; what a clock
 * knows comes only from the messages it receives.
 *
 * Ordinary and boundary clocks: each PTP port starts LISTENING when its
 * interface is up. Announce messages qualify their sender as a foreign
 * master (2 within 4 announce intervals, the first not counted, as
 * linuxptp); the best master clock algorithm compares the data sets
 * (§9.3.4) and decides each port's state (§9.3.3): MASTER (the clock is
 * the grandmaster, M1 / M2, or a master on that path, M3 after its
 * qualification timeout in PRE_MASTER), SLAVE (UNCALIBRATED until its
 * servo locks), PASSIVE. A port without Announce from its masters for
 * announceReceiptTimeout intervals forgets them and decides again: a lost
 * grandmaster is replaced by the next best that can be one; when it comes
 * back, its Announces qualify it again and the election follows the data
 * sets. A receiver-only clock never becomes a master. Clocks of another
 * domain are ignored; a domain number never joins two networks the
 * messages can't cross.
 *
 * A master port sends Announce (the grandmaster's data set, its steps
 * removed), Sync, then Follow_Up with the precise origin timestamp t1. A
 * slave port takes t2 at the Sync's arrival, sends Delay_Req (t3), gets
 * Delay_Resp (t4); mean path delay = ((t2 − t1) + (t4 − t3) − corrections)
 * / 2, offset from master = t2 − t1 − correction − mean path delay. A
 * boundary clock is one clock: synchronized by its slave port, it sends its
 * own time from its master ports. An end-to-end transparent clock (a
 * switch) forwards PTP as any multicast and adds each event message's
 * residence time (its departure on the wire of the egress port minus its
 * arrival) to the correction of the matching Follow_Up (Sync) or Delay_Resp
 * (Delay_Req), the two-step way; it never becomes a time source.
 *
 * Clocks: every PTP clock has a modelled local clock: an initial offset
 * against true time and an oscillator drift (configured, else a
 * deterministic default from the device: ±500 µs, ±20 ppm). Timestamps are
 * that clock's readings, quantized to the timestamping's resolution
 * (hardware: 8 ns, when the frame starts on the wire / arrives; software:
 * 1 µs, when it is handed to or from the stack, so queueing before the wire
 * is not seen). The servo steps the phase by each offset and, from the
 * second one on, corrects the rate (a deterministic phase-and-frequency
 * correction, not ptp4l's PI gains). Synchronized: three offsets in a row
 * below 1 µs (hardware) or 100 µs (software) — this model's rule. No Sync
 * for four sync intervals: holdover, whose quality is not modelled. Paths
 * are as symmetric as the simulation makes them (the same cables both
 * ways); queueing in switches that are no transparent clock makes the
 * estimates err, and that is shown. None of this changes the simulation's
 * clock or schedule: the local clocks are numbers the clocks compute with.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { GmAttrs, PTP_DEFAULTS, PTP_GENERAL_PORT, PTP_EVENT_PORT, PTP_GROUP, PTP_LOCK, PTP_TIMESTAMPING, PtpClockKind, PtpDataset, Recommended, clockIdentity, compareDatasets, parseClockOffset, parseDrift, portIdentity, stateDecision } from '../../model/ptp';
import { Frame, hashIndex } from './engine';
import { Multicast } from './multicast';
import { L3Iface } from './net';
import { durationText } from './params';
import { ProtocolSim } from './protocols';
import { GridTable, Msg, Pkt } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const GROUP = parseAddress(PTP_GROUP) as IpAddr;
const NS = 1e6;

type PortState = 'INITIALIZING' | 'LISTENING' | 'PRE_MASTER' | 'MASTER' | 'PASSIVE' | 'UNCALIBRATED' | 'SLAVE' | 'FAULTY' | 'DISABLED';

interface Foreign {
  sender: string;
  dev: string;
  /** the counted Announces' times (ms); the first one heard is not counted */
  times: number[];
  first: number;
  last: number;
  ds: PtpDataset;
  interval: number;
}

interface PtpPort {
  clock: PtpClock;
  n: number;
  iface: string;
  id: string;
  state: PortState;
  since: number;
  foreign: Map<string, Foreign>;
  gen: number;
  seq: { announce: number; sync: number; delay: number };
  /** a slave: the last Sync heard (t2 and its correction, and the servo's steps by then), waiting for its Follow_Up */
  sync?: { seq: number; t2: number; corr: number; steps: number };
  /** the last complete pair (t1, t2, their correction) */
  pair?: { t1: number; t2: number; corr: number; at: number; steps: number };
  /** Delay_Req sent, waiting for their Delay_Resp: seq → t3 (and the servo's steps when it was taken) */
  delays: Map<number, { t3: number; steps: number }>;
  ignored: Set<number>;
}

export interface PtpClock {
  dev: string;
  kind: PtpClockKind;
  domain: number;
  identity: string;
  d0: GmAttrs;
  slaveOnly: boolean;
  hardware: boolean;
  res: number;
  announceIv: number;
  syncIv: number;
  delayIv: number;
  receipt: number;
  ports: PtpPort[];
  tcPorts: Set<string>;
  /** the local clock: its offset against true time at `tref` (ns), its rate error (ppm, the drift plus the servo's correction) */
  phase: number;
  rate: number;
  tref: number;
  drift: number;
  /** the slave port's parent and grandmaster, when it has one */
  parent: { port: PtpPort; sender: string; senderDev: string; gm: GmAttrs; gmDev: string; stepsRemoved: number } | null;
  gm: boolean;
  state: 'starting' | 'listening' | 'grandmaster' | 'acquiring' | 'synchronized' | 'holdover' | 'unsynchronized' | 'passive' | 'transparent' | 'off';
  since: number;
  lock: number;
  servoAt: number | null;
  /** the servo's phase steps so far (ns): a reading taken before a step is converted to the clock after it */
  steps: number;
  lastOffset?: number;
  meanPathDelay?: number;
  lastUpdate?: number;
  lost?: { at: number; why: string };
  updates: number;
  gen: number;
  tc: { corrected: number; last?: number; max: number };
}

interface PtpData {
  ptp: true;
  type: string;
  domain: number;
  seq: number;
  src: string;
  srcDev: string;
  from: string;
  correction: number;
  gm?: GmAttrs;
  gmDev?: string;
  stepsRemoved?: number;
  precise?: number;
  receive?: number;
  req?: string;
  interval?: number;
}

export class PtpSim {
  readonly clocks = new Map<string, PtpClock>();
  /** a message's arrival at a transparent clock's port: by message, then device */
  private ingress = new WeakMap<Msg, Map<string, { port: string; t: number }>>();
  /** when a clock's own message started on the wire (its hardware timestamp, true time in ms) */
  private wire = new WeakMap<Msg, number>();
  /** a transparent clock's residence times, by "dev|kind|seq|source|egress port" (ns) */
  private residence = new Map<string, number>();

  constructor(
    private P: ProtocolSim,
    private M: Multicast,
  ) {
    for (const d of P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      const s = d.appServices ? d.appServices.get('ptp') : undefined;
      const sd = P.sd(d.id);
      if (!s || !sd) continue;
      const v = s.values;
      const kind = v.clock as PtpClockKind | undefined;
      if (!kind) continue;
      const ifs = Array.isArray(v.interfaces) ? (v.interfaces as string[]) : [];
      const mac = (() => {
        for (const i of ifs) {
          const l = sd.l3.get(i);
          if (l && l.mac) return l.mac;
        }
        const any = Array.from(sd.l3.values()).find((l) => !!l.mac);
        if (any) return any.mac;
        for (const [k, m] of P.e.net.macs) if (k.indexOf(d.id + ':') === 0 || k.indexOf(d.id + '|') === 0) return m.mac;
        return `02:00:00:${(hashIndex(d.id, 255) as number).toString(16).padStart(2, '0')}:00:01`;
      })();
      const identity = clockIdentity(mac);
      const slaveOnly = kind === 'ordinary' && v.role === 'receiver_only';
      const num = (k: string, dflt: number): number => (typeof v[k] === 'number' ? (v[k] as number) : dflt);
      const hw = v.timestamping === 'hardware';
      const off = typeof v.clock_offset === 'string' ? parseClockOffset(v.clock_offset as string) : null;
      const drift = typeof v.drift === 'string' ? parseDrift(v.drift as string) : null;
      const c: PtpClock = {
        dev: d.id,
        kind,
        domain: num('domain', PTP_DEFAULTS.domain),
        identity,
        d0: { identity, priority1: num('priority1', PTP_DEFAULTS.priority1), clockClass: slaveOnly ? PTP_DEFAULTS.slaveOnlyClass : num('clock_class', PTP_DEFAULTS.clockClass), clockAccuracy: num('clock_accuracy', PTP_DEFAULTS.clockAccuracy), variance: num('variance', PTP_DEFAULTS.variance), priority2: num('priority2', PTP_DEFAULTS.priority2) },
        slaveOnly,
        hardware: hw,
        res: hw ? PTP_TIMESTAMPING.hardware.resolutionNs : PTP_TIMESTAMPING.software.resolutionNs,
        announceIv: num('announce_interval', PTP_DEFAULTS.announceInterval),
        syncIv: num('sync_interval', PTP_DEFAULTS.syncInterval),
        delayIv: num('delay_req_interval', PTP_DEFAULTS.delayReqInterval),
        receipt: num('announce_receipt_timeout', PTP_DEFAULTS.announceReceiptTimeout),
        ports: [],
        tcPorts: new Set(kind === 'transparent' ? ifs : []),
        // a deterministic default oscillator: its initial offset (±500 µs) and drift (±20 ppm) from the device's id
        phase: off !== null ? off : ((hashIndex(d.id + '|ptp-offset', 2001) as number) - 1000) * 500,
        rate: drift !== null ? drift : ((hashIndex(d.id + '|ptp-drift', 401) as number) - 200) / 10,
        tref: 0,
        drift: 0,
        parent: null,
        gm: false,
        state: kind === 'transparent' ? 'transparent' : 'starting',
        since: 0,
        lock: 0,
        servoAt: null,
        steps: 0,
        updates: 0,
        gen: 0,
        tc: { corrected: 0, max: 0 },
      };
      c.drift = c.rate;
      if (kind !== 'transparent') ifs.forEach((i, k) => c.ports.push({ clock: c, n: k + 1, iface: i, id: portIdentity(identity, k + 1), state: 'INITIALIZING', since: 0, foreign: new Map(), gen: 0, seq: { announce: 0, sync: 0, delay: 0 }, delays: new Map(), ignored: new Set() }));
      this.clocks.set(d.id, c);
    }
    if (!this.clocks.size) return;
    P.e.ptpHook = { ingress: (dev, port, frame, t) => this.atIngress(dev, port, frame, t), egress: (dev, port, frame, tIn, tOut) => this.atEgress(dev, port, frame, tIn, tOut) };
    P.handlers.set('ptp', (dev, l3, msg, pkt) => {
      if (l3 && pkt) this.rx(dev, l3, msg, pkt);
    });
    P.ifaceHooks.push((dev, l3, up) => {
      const c = this.clocks.get(dev);
      if (!c) return;
      for (const p of c.ports) if (p.iface === l3.id) up ? this.startPort(p, 'its interface is up') : this.faulty(p, 'its interface went down');
    });
    P.deviceHooks.push((dev, up) => {
      const c = this.clocks.get(dev);
      if (!c) return;
      if (!up) {
        c.gen++;
        for (const p of c.ports) {
          p.gen++;
          p.state = 'DISABLED';
          p.foreign.clear();
        }
        c.parent = null;
        c.gm = false;
        this.setState(c, 'off', `${dev} was powered off`);
      }
    });
    P.bootHooks.push(() => {
      for (const c of this.clocks.values()) for (const p of c.ports) if (P.e.isL3Up(c.dev, p.iface)) this.startPort(p, 'it starts');
    });
  }

  private get e() {
    return this.P.e;
  }

  // ------------------------------------------------------------ the local clocks

  /** A clock's reading at true time T (ns). */
  private local(c: PtpClock, T: number): number {
    return T + c.phase + c.rate * 1e-6 * (T - c.tref);
  }

  /** Its offset against true time now (ns): known to the simulation, never to the clock itself. */
  trueOffset(c: PtpClock): number {
    return this.local(c, this.e.now * NS) - this.e.now * NS;
  }

  private stamp(c: PtpClock, T: number): number {
    return Math.round(this.local(c, T) / c.res) * c.res;
  }

  /** Step the phase by an offset and, from the second offset on, correct the rate too (the servo). */
  private servo(c: PtpClock, ofm: number): void {
    const T = this.e.now * NS;
    // (the reading first: a new rate applies from now on, never to the time before)
    const now = this.local(c, T);
    if (c.servoAt !== null && T > c.servoAt) {
      const ppm = (ofm / (T - c.servoAt)) * 1e6;
      c.rate = Math.max(-1000, Math.min(1000, c.rate - ppm));
    }
    c.phase = now - ofm - T;
    c.tref = T;
    c.servoAt = T;
    c.steps += ofm;
  }

  // ------------------------------------------------------------ ports

  private later(p: PtpPort, dt: number, fn: () => void): void {
    const g = p.gen;
    const cg = p.clock.gen;
    this.e.after(Math.max(0, dt), () => {
      if (p.gen === g && p.clock.gen === cg) fn();
    });
  }

  private l3(p: PtpPort): L3Iface | undefined {
    const sd = this.P.sd(p.clock.dev);
    return sd ? sd.l3.get(p.iface) : undefined;
  }

  private startPort(p: PtpPort, why: string): void {
    const c = p.clock;
    if (!this.e.deviceOn(c.dev) || p.state === 'LISTENING' || p.state === 'MASTER' || p.state === 'SLAVE' || p.state === 'UNCALIBRATED' || p.state === 'PASSIVE' || p.state === 'PRE_MASTER') return;
    p.gen++;
    p.foreign.clear();
    p.state = 'LISTENING';
    p.since = this.e.now;
    // its interface joins the PTP group: switches that snoop IGMP send PTP there (no blanket bypass)
    if (!this.M.isMember(c.dev, p.iface, PTP_GROUP)) this.M.join(c.dev, p.iface, PTP_GROUP, [], 'model');
    this.e.note('state', 'ptp', c.dev, '', 'PTP port listening', 'LISTENING', `${c.dev} PTP port ${p.n} (${p.iface}, ${p.id}): LISTENING in domain ${c.domain} (${why}); it decides after ${c.receipt} announce intervals (${durationText(c.receipt * c.announceIv)}) without a better clock`);
    if (c.state === 'starting' || c.state === 'off') this.setState(c, 'listening', why);
    this.armReceipt(p);
  }

  private faulty(p: PtpPort, why: string): void {
    const c = p.clock;
    p.gen++;
    p.state = 'FAULTY';
    p.since = this.e.now;
    p.foreign.clear();
    p.sync = undefined;
    p.pair = undefined;
    p.delays.clear();
    this.e.note('state', 'ptp', c.dev, '', 'PTP port faulty', 'FAULTY', `${c.dev} PTP port ${p.n} (${p.iface}): FAULTY (${why})`);
    this.decide(c, why);
  }

  /** The announce receipt timeout of a port: Announces of its masters forgotten when none came for the timeout. */
  private armReceipt(p: PtpPort): void {
    const c = p.clock;
    const g = ++p.seq.announce;
    void g;
    const limit = c.receipt * c.announceIv;
    this.later(p, limit, () => {
      const now = this.e.now;
      let changed = false;
      for (const [k, f] of Array.from(p.foreign)) if (now - f.last >= c.receipt * f.interval) {
        p.foreign.delete(k);
        changed = true;
        this.e.note('table', 'ptp', c.dev, f.dev, 'foreign master lost', '', `${c.dev} PTP port ${p.n}: no Announce from ${f.dev} (${f.sender}) for ${c.receipt} announce intervals: it is forgotten`);
      }
      if (changed || p.state === 'LISTENING') this.decide(c, changed ? 'an announce receipt timeout' : 'no better clock announced itself');
      this.armReceipt(p);
    });
  }

  private qualified(f: Foreign, now: number): boolean {
    const window = PTP_DEFAULTS.foreignWindow * f.interval;
    f.times = f.times.filter((t) => now - t <= window);
    return f.times.length >= PTP_DEFAULTS.foreignThreshold;
  }

  /** The default data set as a data set of the comparison. */
  private d0(c: PtpClock): PtpDataset {
    return { gm: c.d0, stepsRemoved: 0, sender: `${c.identity}-0`, receiver: `${c.identity}-0` };
  }

  /** The best master clock algorithm: each port's state from the data sets it has (§9.3). */
  private decide(c: PtpClock, why: string): void {
    if (c.kind === 'transparent' || !this.e.deviceOn(c.dev)) return;
    const now = this.e.now;
    const live = c.ports.filter((p) => p.state !== 'FAULTY' && p.state !== 'DISABLED' && p.state !== 'INITIALIZING');
    const erbest = new Map<PtpPort, PtpDataset | null>();
    let ebest: { ds: PtpDataset; port: PtpPort; f: Foreign } | null = null;
    for (const p of live) {
      let best: { ds: PtpDataset; f: Foreign } | null = null;
      for (const f of p.foreign.values()) if (this.qualified(f, now) && f.ds.stepsRemoved < 255 && (!best || compareDatasets(f.ds, best.ds) > 0)) best = { ds: f.ds, f };
      erbest.set(p, best ? best.ds : null);
      if (best && (!ebest || compareDatasets(best.ds, ebest.ds) > 0)) ebest = { ds: best.ds, port: p, f: best.f };
    }
    const d0 = this.d0(c);
    let slave: PtpPort | null = null;
    let best = false;
    for (const p of live) {
      const rec: Recommended = stateDecision(d0, erbest.get(p) || null, ebest ? ebest.ds : null, !!ebest && ebest.port === p, c.slaveOnly, p.state === 'LISTENING' && now - p.since < c.receipt * c.announceIv);
      this.apply(p, rec, ebest ? ebest.ds : null);
      if (rec === 'S1') slave = p;
      if (rec === 'M1' || rec === 'M2') best = true;
    }
    const wasParent = c.parent ? c.parent.sender : null;
    if (slave && ebest) {
      const f = ebest.f;
      const gmDev = this.devOfIdentity(f.ds.gm.identity) || f.dev;
      const changed = !c.parent || c.parent.sender !== f.sender || c.parent.gm.identity !== f.ds.gm.identity;
      c.parent = { port: slave, sender: f.sender, senderDev: f.dev, gm: f.ds.gm, gmDev, stepsRemoved: f.ds.stepsRemoved + 1 };
      c.gm = false;
      if (changed) {
        c.lock = 0;
        c.servoAt = null;
        c.lastOffset = undefined;
        c.meanPathDelay = undefined;
        for (const p of c.ports) {
          p.sync = undefined;
          p.pair = undefined;
        }
        this.setState(c, 'acquiring', `its master is ${f.dev} (${f.sender}) on port ${slave.n}; grandmaster ${gmDev} (${f.ds.gm.identity}), ${f.ds.stepsRemoved + 1} step${f.ds.stepsRemoved ? 's' : ''} removed (${why})`);
      }
      return;
    }
    c.parent = null;
    const masters = live.filter((p) => p.state === 'MASTER' || p.state === 'PRE_MASTER');
    if (masters.length && (best || !ebest)) {
      if (!c.gm) {
        c.gm = true;
        this.setState(c, 'grandmaster', `no better clock is announced on ${masters.length === 1 ? 'its port' : 'any of its ports'} (${why})${wasParent ? `; it was synchronized to ${wasParent}: its clock runs free from its last correction (holdover quality is not modelled)` : ''}`);
      }
      return;
    }
    if (masters.length && ebest) {
      // a master on its paths, the grandmaster elsewhere (a boundary clock without a slave port: not synchronized)
      c.gm = false;
      if (c.state !== 'unsynchronized') this.setState(c, 'unsynchronized', `it is a master on its ports, but no port is synchronized to the grandmaster (${why})`);
      return;
    }
    c.gm = false;
    if (live.every((p) => p.state === 'PASSIVE')) this.setState(c, 'passive', why);
    else if (live.some((p) => p.state === 'LISTENING')) {
      if (wasParent) this.lose(c, `its master ${wasParent} is gone (${why})`);
      else if (c.state !== 'listening' && c.state !== 'unsynchronized') this.setState(c, 'listening', why);
    } else if (!live.length) {
      if (wasParent || c.state === 'synchronized' || c.state === 'acquiring') this.lose(c, why);
    }
  }

  private lose(c: PtpClock, why: string): void {
    c.lost = { at: this.e.now, why };
    this.setState(c, 'unsynchronized', `${why}; its clock runs free from its last correction (holdover quality is not modelled)`);
  }

  private devOfIdentity(id: string): string | null {
    for (const c of this.clocks.values()) if (c.identity === id) return c.dev;
    return null;
  }

  private apply(p: PtpPort, rec: Recommended, ebest: PtpDataset | null): void {
    const c = p.clock;
    const to: PortState = rec === 'M1' || rec === 'M2' ? 'MASTER' : rec === 'M3' ? 'PRE_MASTER' : rec === 'S1' ? (p.state === 'SLAVE' && c.parent && c.parent.port === p ? 'SLAVE' : 'UNCALIBRATED') : rec === 'P1' || rec === 'P2' ? 'PASSIVE' : 'LISTENING';
    if (rec === 'M3' && (p.state === 'MASTER' || p.state === 'PRE_MASTER')) return;
    if (to === p.state) return;
    const was = p.state;
    p.gen++;
    p.state = to;
    p.since = this.e.now;
    this.e.note('state', 'ptp', c.dev, '', `PTP port ${to}`, to, `${c.dev} PTP port ${p.n} (${p.iface}): ${was} → ${to} (${rec}${ebest ? `; the best clock it hears: ${ebest.gm.identity}` : ''})`);
    this.armReceipt(p);
    if (to === 'MASTER') this.masterTimers(p);
    if (to === 'PRE_MASTER') {
      // M3: a qualification timeout of (1 + steps removed) announce intervals before it is a master
      const steps = ebest ? ebest.stepsRemoved + 1 : 0;
      this.later(p, (1 + steps) * c.announceIv, () => {
        if (p.state !== 'PRE_MASTER') return;
        p.gen++;
        p.state = 'MASTER';
        p.since = this.e.now;
        this.e.note('state', 'ptp', c.dev, '', 'PTP port MASTER', 'MASTER', `${c.dev} PTP port ${p.n} (${p.iface}): PRE_MASTER → MASTER (its qualification timeout passed)`);
        this.armReceipt(p);
        this.masterTimers(p);
      });
    }
    if (to === 'UNCALIBRATED') this.delayTimer(p);
  }

  // ------------------------------------------------------------ sending

  private send(p: PtpPort, type: string, event: boolean, fields: Partial<PtpData>, size: number, rows: Array<[string, string]>): number | null {
    const c = p.clock;
    const l3 = this.l3(p);
    const src = l3 ? l3.addrs.find((a) => a.addr.version === 4) : undefined;
    if (!l3 || !src || !this.e.deviceOn(c.dev) || !this.e.isL3Up(c.dev, p.iface)) return null;
    const data: PtpData = { ptp: true, type, domain: c.domain, seq: 0, src: p.id, srcDev: c.dev, from: c.dev, correction: 0, ...fields };
    const msg: Msg = { protocol: 'ptp', type, label: `PTP ${type}`, detail: `PTP ${type} from ${c.dev} port ${p.n} (${p.id}), domain ${c.domain}, sequence ${data.seq}${rows.length ? ': ' + rows.map(([k, v]) => `${k} ${v}`).join(', ') : ''}`, data: { ...data, inspect: inspect(type, data, rows) } };
    const pkt = this.e.newPacket(src.addr, GROUP, l3.vrf, msg, [], 1);
    pkt.l4 = { proto: 'udp', num: 17, sport: event ? PTP_EVENT_PORT : PTP_GENERAL_PORT, dport: event ? PTP_EVENT_PORT : PTP_GENERAL_PORT };
    pkt.len = 8 + size;
    const T = this.e.now * NS;
    this.e.note('message', 'ptp', c.dev, '', `PTP ${type}`, '', msg.detail, this.e.now, msg);
    this.e.send(c.dev, pkt, l3);
    if (!event) return null;
    // its timestamp: on the wire (hardware), or when handed to the stack (software)
    const wire = this.wire.get(msg);
    return this.stamp(c, c.hardware && wire !== undefined ? wire * NS : T);
  }

  private masterTimers(p: PtpPort): void {
    const c = p.clock;
    const announce = (): void => {
      if (p.state !== 'MASTER') return;
      const gm = c.gm || !c.parent ? c.d0 : c.parent.gm;
      const steps = c.gm || !c.parent ? 0 : c.parent.stepsRemoved;
      const gmDev = c.gm || !c.parent ? c.dev : c.parent.gmDev;
      this.send(p, 'Announce', false, { seq: ++p.seq.announce, gm, gmDev, stepsRemoved: steps, interval: c.announceIv }, 64, [['grandmaster', `${gmDev} (${gm.identity})`], ['priority1', String(gm.priority1)], ['class', String(gm.clockClass)], ['steps removed', String(steps)]]);
      this.later(p, c.announceIv, announce);
    };
    const sync = (): void => {
      if (p.state !== 'MASTER') return;
      // a boundary clock's master ports send only once it is synchronized itself (or it is the grandmaster)
      if (c.gm || c.state === 'synchronized' || c.state === 'holdover' || c.kind === 'ordinary') {
        const seq = ++p.seq.sync;
        const t1 = this.send(p, 'Sync', true, { seq }, 44, [['two-step', 'yes']]);
        if (t1 !== null) this.send(p, 'Follow_Up', false, { seq, precise: t1 }, 44, [['precise origin timestamp t1', nsText(t1)]]);
      }
      this.later(p, c.syncIv, sync);
    };
    this.later(p, this.e.jitter(c.dev), announce);
    this.later(p, this.e.jitter(c.dev) + 1, sync);
  }

  private delayTimer(p: PtpPort): void {
    const c = p.clock;
    const tick = (): void => {
      if (p.state !== 'SLAVE' && p.state !== 'UNCALIBRATED') return;
      if (p.pair) {
        const seq = ++p.seq.delay;
        const t3 = this.send(p, 'Delay_Req', true, { seq }, 44, []);
        if (t3 !== null) p.delays.set(seq, { t3, steps: c.steps });
        if (p.delays.size > 8) p.delays.delete(Math.min(...Array.from(p.delays.keys())));
      }
      this.later(p, c.delayIv, tick);
    };
    this.later(p, c.delayIv / 2 + this.e.jitter(c.dev), tick);
  }

  // ------------------------------------------------------------ receiving

  private portOf(c: PtpClock, l3: L3Iface): PtpPort | undefined {
    return c.ports.find((p) => p.iface === l3.id);
  }

  private rx(dev: string, l3: L3Iface, msg: Msg, pkt: Pkt): void {
    const c = this.clocks.get(dev);
    const d = msg.data as unknown as PtpData;
    if (!c || c.kind === 'transparent' || !d || !d.ptp) return;
    const p = this.portOf(c, l3);
    if (!p || p.state === 'FAULTY' || p.state === 'DISABLED' || p.state === 'INITIALIZING') return;
    if (d.src.indexOf(c.identity) === 0) return;
    if (d.domain !== c.domain) {
      if (!p.ignored.has(d.domain)) {
        p.ignored.add(d.domain);
        this.e.note('note', 'ptp', dev, d.from, 'other domain', '', `${dev} PTP port ${p.n} ignores domain ${d.domain} (from ${d.from}): it is in domain ${c.domain}`);
      }
      return;
    }
    const t = this.stamp(c, this.e.now * NS);
    switch (d.type) {
      case 'Announce':
        this.announceIn(p, d);
        return;
      case 'Sync':
        if ((p.state === 'SLAVE' || p.state === 'UNCALIBRATED') && c.parent && c.parent.sender === d.src) p.sync = { seq: d.seq, t2: t, corr: d.correction, steps: c.steps };
        return;
      case 'Follow_Up':
        if ((p.state === 'SLAVE' || p.state === 'UNCALIBRATED') && c.parent && c.parent.sender === d.src && p.sync && p.sync.seq === d.seq) {
          p.pair = { t1: d.precise as number, t2: p.sync.t2, corr: p.sync.corr + d.correction, at: this.e.now, steps: p.sync.steps };
          this.measure(p);
        }
        return;
      case 'Delay_Req':
        if (p.state === 'MASTER') this.send(p, 'Delay_Resp', false, { seq: d.seq, receive: t, req: d.src, correction: d.correction }, 54, [['receive timestamp t4', nsText(t)], ['requesting port', d.src]]);
        return;
      case 'Delay_Resp': {
        if ((p.state !== 'SLAVE' && p.state !== 'UNCALIBRATED') || d.req !== p.id || !c.parent || c.parent.sender !== d.src) return;
        const q = p.delays.get(d.seq);
        if (q === undefined || !p.pair) return;
        p.delays.delete(d.seq);
        const pr = p.pair;
        // t3 on the clock as it was at t2 (a servo step between them is taken out)
        const t3 = q.t3 - (pr.steps - q.steps);
        c.meanPathDelay = (pr.t2 - pr.t1 + ((d.receive as number) - t3) - pr.corr - d.correction) / 2;
        return;
      }
    }
    void pkt;
  }

  private announceIn(p: PtpPort, d: PtpData): void {
    const c = p.clock;
    const now = this.e.now;
    const ds: PtpDataset = { gm: d.gm as GmAttrs, stepsRemoved: d.stepsRemoved || 0, sender: d.src, receiver: p.id };
    let f = p.foreign.get(d.src);
    const was = f ? this.qualified(f, now) : false;
    const before = f ? JSON.stringify(f.ds.gm) + f.ds.stepsRemoved : '';
    if (!f) {
      // the first Announce of a foreign master is not counted (1588-2008 §9.5.3 b, as linuxptp)
      f = { sender: d.src, dev: d.from, times: [], first: now, last: now, ds, interval: d.interval || c.announceIv };
      p.foreign.set(d.src, f);
      this.e.note('table', 'ptp', c.dev, d.from, 'foreign master', '', `${c.dev} PTP port ${p.n} hears ${d.from} (${d.src}) announce the grandmaster ${d.gmDev || ''} (${ds.gm.identity}, priority1 ${ds.gm.priority1}, class ${ds.gm.clockClass}, ${ds.stepsRemoved} steps removed): not qualified yet (${PTP_DEFAULTS.foreignThreshold} more Announces within ${PTP_DEFAULTS.foreignWindow} intervals)`);
      return;
    }
    f.times.push(now);
    f.last = now;
    f.ds = ds;
    f.dev = d.from;
    const is = this.qualified(f, now);
    if (is !== was || before !== JSON.stringify(ds.gm) + ds.stepsRemoved) this.decide(c, is && !was ? `${d.from} qualified as a foreign master` : `${d.from} announces another grandmaster`);
    else if (c.parent && c.parent.sender === d.src) {
      c.parent.gm = ds.gm;
      c.parent.stepsRemoved = ds.stepsRemoved + 1;
    }
  }

  /** An offset from the master: the servo corrects the clock; three small ones in a row make it synchronized. */
  private measure(p: PtpPort): void {
    const c = p.clock;
    const pr = p.pair as NonNullable<PtpPort['pair']>;
    if (c.meanPathDelay === undefined) return;
    const ofm = pr.t2 - pr.t1 - pr.corr - c.meanPathDelay;
    c.lastOffset = ofm;
    c.lastUpdate = this.e.now;
    c.updates++;
    this.servo(c, ofm);
    const limit = c.hardware ? PTP_LOCK.hardwareNs : PTP_LOCK.softwareNs;
    if (Math.abs(ofm) < limit) c.lock++;
    else c.lock = 0;
    if (c.lock >= PTP_LOCK.count && (c.state !== 'synchronized' || p.state !== 'SLAVE')) {
      if (p.state === 'UNCALIBRATED') {
        p.state = 'SLAVE';
        p.since = this.e.now;
      }
      this.setState(c, 'synchronized', `${PTP_LOCK.count} offsets in a row below ${nsText(limit)} (the last ${nsText(ofm)}, mean path delay ${nsText(c.meanPathDelay)})`);
    } else if (c.state === 'holdover') this.setState(c, c.lock >= PTP_LOCK.count ? 'synchronized' : 'acquiring', 'Sync messages again');
    else if (c.state === 'synchronized' && Math.abs(ofm) > 10 * limit) {
      c.lock = 0;
      if (p.state === 'SLAVE') p.state = 'UNCALIBRATED';
      this.setState(c, 'acquiring', `an offset of ${nsText(ofm)} (more than 10 × ${nsText(limit)})`);
    }
    // no Sync for four sync intervals: holdover (its quality is not modelled)
    const at = this.e.now;
    this.later(p, 4 * c.syncIv, () => {
      if (c.lastUpdate === at && (c.state === 'synchronized' || c.state === 'acquiring') && c.parent && c.parent.port === p) this.setState(c, 'holdover', `no Sync from ${c.parent.senderDev} for ${durationText(4 * c.syncIv)}: its clock runs free from its last correction (holdover quality is not modelled)`);
    });
  }

  private setState(c: PtpClock, s: PtpClock['state'], why: string): void {
    if (c.state === s && s !== 'acquiring') return;
    c.state = s;
    c.since = this.e.now;
    this.e.stateVersion++;
    this.e.note('state', 'ptp', c.dev, c.parent ? c.parent.senderDev : '', `PTP ${s}`, s, `${c.dev} (PTP ${c.kind} clock, domain ${c.domain}): ${stateWord(s)}: ${why}`);
  }

  // ------------------------------------------------------------ transparent clocks

  private atIngress(dev: string, port: string, frame: Frame, t: number): void {
    const c = this.clocks.get(dev);
    if (!c || c.kind !== 'transparent' || !c.tcPorts.has(port)) return;
    let m = this.ingress.get(frame.msg);
    if (!m) this.ingress.set(frame.msg, (m = new Map()));
    m.set(dev, { port, t });
  }

  private atEgress(dev: string, port: string, frame: Frame, tIn: number, tOut: number): Frame {
    const d = frame.msg.data as unknown as PtpData;
    if (!d || !d.ptp) return frame;
    // a clock's own message: its moment on the wire is its hardware timestamp
    if (d.from === dev && !this.wire.has(frame.msg)) this.wire.set(frame.msg, tOut);
    const c = this.clocks.get(dev);
    if (!c || c.kind !== 'transparent' || !c.tcPorts.has(port)) return frame;
    const ing = this.ingress.get(frame.msg);
    const at = ing ? ing.get(dev) : undefined;
    if (!at) return frame;
    // the residence time as its own clock measures it (its rate, its resolution)
    const res = Math.round(((tOut - at.t) * NS * (1 + c.rate * 1e-6)) / c.res) * c.res;
    const key = (kind: string, seq: number, src: string, p: string): string => `${dev}|${kind}|${seq}|${src}|${p}`;
    if (d.type === 'Sync') {
      this.residence.set(key('sync', d.seq, d.src, port), res);
      this.note(c, res);
      return frame;
    }
    if (d.type === 'Delay_Req') {
      this.residence.set(key('dreq', d.seq, d.src, port), res);
      this.note(c, res);
      return frame;
    }
    // two-step: a Sync's residence goes into its Follow_Up, a Delay_Req's into its Delay_Resp (its ingress port is where the request left)
    const r = d.type === 'Follow_Up' ? this.residence.get(key('sync', d.seq, d.src, port)) : d.type === 'Delay_Resp' ? this.residence.get(key('dreq', d.seq, d.req as string, at.port)) : undefined;
    if (r === undefined) return frame;
    if (this.residence.size > 4000) this.residence.clear();
    const nd: PtpData = { ...d, correction: d.correction + r };
    const msg: Msg = { ...frame.msg, label: frame.msg.label, detail: `${frame.msg.detail}; ${dev} (transparent clock) adds ${nsText(r)} of residence time`, data: { ...nd, inspect: inspect(nd.type, nd, []) } };
    return { ...frame, msg, ip: frame.ip ? { ...frame.ip, msg } : frame.ip };
  }

  private note(c: PtpClock, res: number): void {
    c.tc.corrected++;
    c.tc.last = res;
    c.tc.max = Math.max(c.tc.max, res);
  }

  // ------------------------------------------------------------ status and tables

  /** A clock's role and state in a few words, and in a line (the diagram's mark and its tooltip). */
  mark(dev: string): { text: string; state: string; detail: string } | null {
    const c = this.clocks.get(dev);
    if (!c) return null;
    if (c.kind === 'transparent') return { text: 'PTP · Transparent clock', state: 'transparent', detail: `${dev}: PTP end-to-end transparent clock on ${Array.from(c.tcPorts).join(', ')}: ${c.tc.corrected} event message${c.tc.corrected === 1 ? '' : 's'} timed${c.tc.last !== undefined ? `, the last residence time ${nsText(c.tc.last)} (at most ${nsText(c.tc.max)})` : ''}; it is no time source` };
    const word = c.state === 'grandmaster' ? 'Grandmaster' : c.state === 'synchronized' ? 'Synchronized' : c.state === 'acquiring' ? 'Acquiring' : c.state === 'holdover' ? 'Holdover' : c.state === 'unsynchronized' ? 'Unsynchronized' : c.state === 'passive' ? 'Passive' : c.state === 'off' ? 'Off' : 'Listening';
    const parts = [`PTP ${c.kind} clock, domain ${c.domain}: ${stateWord(c.state)}`];
    if (c.parent) parts.push(`grandmaster ${c.parent.gmDev} (${c.parent.gm.identity}) via ${c.parent.senderDev}, ${c.parent.stepsRemoved} step${c.parent.stepsRemoved === 1 ? '' : 's'} removed`);
    if (c.lastOffset !== undefined) parts.push(`offset from master ${nsText(c.lastOffset)}, mean path delay ${nsText(c.meanPathDelay as number)} (estimates from its ${c.hardware ? 'hardware' : 'software'} timestamps)`);
    if (c.gm) parts.push('the time source of its domain: its own clock, not verified against any reference');
    return { text: `PTP · ${word}${c.gm ? '' : ''}`, state: c.state, detail: `${dev}: ${parts.join('; ')}` };
  }

  /** Show PTP clock: its ports' states and foreign masters; its data sets, timers, offsets and assumptions. */
  table(dev: string): GridTable {
    const c = this.clocks.get(dev);
    const rows: string[][] = [];
    const notes: string[] = [];
    if (!c) return { caption: `PTP of ${dev}`, cols: [], rows, empty: `${dev} keeps no PTP clock.`, timers: [], notes };
    if (c.kind === 'transparent') {
      for (const p of Array.from(c.tcPorts).sort(cmp)) rows.push([p, 'transparent', '—', '—']);
      notes.push(`End-to-end transparent clock (two-step): adds each Sync's residence time to its Follow_Up and each Delay_Req's to its Delay_Resp; ${c.tc.corrected} event messages timed, the last ${c.tc.last !== undefined ? nsText(c.tc.last) : '—'}, at most ${nsText(c.tc.max)}.`);
      notes.push(`It measures with its own clock (drift ${c.rate.toFixed(1)} ppm, not syntonized), ${c.hardware ? PTP_TIMESTAMPING.hardware.label : PTP_TIMESTAMPING.software.label}.`);
      return { caption: `PTP transparent clock ${dev}`, cols: ['Port', 'Role', 'Foreign masters', 'Since'], rows, empty: '', timers: [], notes };
    }
    for (const p of c.ports) rows.push([`${p.n} (${p.iface})`, p.state, Array.from(p.foreign.values()).map((f) => `${f.dev} (${this.qualified(f, this.e.now) ? 'qualified' : 'not qualified'}, ${f.ds.gm.identity}, ${f.ds.stepsRemoved} steps)`).join('; ') || '—', `t = ${Math.round(p.since) / 1000} s`]);
    notes.push(`${dev}: ${stateWord(c.state)} since t = ${Math.round(c.since) / 1000} s. Clock identity ${c.identity}; ${c.kind} clock${c.slaveOnly ? ', receiver only (class 255)' : ''}; domain ${c.domain}; profile IEEE 1588-2008 Default delay request-response, UDP/IPv4, two-step.`);
    notes.push(`Default data set: priority1 ${c.d0.priority1}, class ${c.d0.clockClass}, accuracy 0x${c.d0.clockAccuracy.toString(16)}, variance 0x${c.d0.variance.toString(16)}, priority2 ${c.d0.priority2}.`);
    if (c.parent) notes.push(`Parent: ${c.parent.senderDev} (${c.parent.sender}); grandmaster ${c.parent.gmDev} (${c.parent.gm.identity}, priority1 ${c.parent.gm.priority1}, class ${c.parent.gm.clockClass}); steps removed ${c.parent.stepsRemoved}.`);
    else if (c.gm) notes.push('Grandmaster: it is the best clock its ports hear; its time is its own clock’s (not verified against a reference).');
    if (c.lastOffset !== undefined) notes.push(`Offset from master ${nsText(c.lastOffset)}, mean path delay ${nsText(c.meanPathDelay as number)} (${c.updates} updates; the estimates of its timestamps, path asymmetry included).`);
    const gm = c.parent ? this.clocks.get(c.parent.gmDev) : undefined;
    if (gm && gm !== c) notes.push(`Its clock against the grandmaster’s now: ${nsText(this.local(c, this.e.now * NS) - this.local(gm, this.e.now * NS))} (known to the simulation, not to ${dev}).`);
    notes.push(`Timers: Announce every ${durationText(c.announceIv)}, Sync every ${durationText(c.syncIv)}, Delay_Req every ${durationText(c.delayIv)}, announce receipt timeout ${c.receipt} intervals.`);
    notes.push(`Its modelled clock: ${c.hardware ? PTP_TIMESTAMPING.hardware.label : PTP_TIMESTAMPING.software.label}; oscillator drift ${c.drift.toFixed(1)} ppm, rate now ${c.rate.toFixed(3)} ppm after the servo; synchronized means ${PTP_LOCK.count} offsets in a row below ${nsText(c.hardware ? PTP_LOCK.hardwareNs : PTP_LOCK.softwareNs)} (this model’s rule).`);
    return { caption: `PTP clock ${dev}`, cols: ['Port', 'State', 'Foreign masters', 'Since'], rows, empty: '', timers: [], notes };
  }

  /** The grandmaster of a domain now, as the clocks see it (null: none). */
  grandmaster(domain = 0): string | null {
    for (const c of this.clocks.values()) if (c.domain === domain && c.gm) return c.dev;
    return null;
  }
}

function stateWord(s: PtpClock['state']): string {
  return s === 'grandmaster' ? 'grandmaster' : s === 'synchronized' ? 'synchronized' : s === 'acquiring' ? 'acquiring (its servo is not locked yet)' : s === 'holdover' ? 'holdover (no Sync; its quality is not modelled)' : s === 'unsynchronized' ? 'unsynchronized' : s === 'passive' ? 'passive' : s === 'transparent' ? 'transparent clock' : s === 'off' ? 'off' : s === 'starting' ? 'starting' : 'listening';
}

/** "1.234 µs", "-250 ns", "12.5 ms". */
export function nsText(ns: number): string {
  const a = Math.abs(ns);
  if (a < 1000) return `${Math.round(ns)} ns`;
  if (a < 1e6) return `${(ns / 1000).toFixed(3)} µs`;
  return `${(ns / 1e6).toFixed(3)} ms`;
}

/** What the packet inspector lists of a PTP message: its header and body fields. */
function inspect(type: string, d: PtpData, rows: Array<[string, string]>): { title: string; rows: Array<[string, string]> } {
  const out: Array<[string, string]> = [['Message', `${type} (${type === 'Sync' || type === 'Delay_Req' ? 'event, UDP 319' : 'general, UDP 320'})`], ['Domain', String(d.domain)], ['Sequence id', String(d.seq)], ['Source port identity', d.src], ['Correction field', nsText(d.correction)]];
  if (type === 'Sync') out.push(['Flags', 'two-step: the precise time follows in a Follow_Up']);
  if (d.gm) out.push(['Grandmaster', `${d.gmDev || ''} ${d.gm.identity}`.trim()], ['Grandmaster priority1, class, accuracy, variance, priority2', `${d.gm.priority1}, ${d.gm.clockClass}, 0x${d.gm.clockAccuracy.toString(16)}, 0x${d.gm.variance.toString(16)}, ${d.gm.priority2}`], ['Steps removed', String(d.stepsRemoved)]);
  if (d.precise !== undefined) out.push(['Precise origin timestamp (t1)', nsText(d.precise)]);
  if (d.receive !== undefined) out.push(['Receive timestamp (t4)', nsText(d.receive)], ['Requesting port identity', d.req || '']);
  void rows;
  return { title: 'Application – PTP (IEEE 1588-2008)', rows: out };
}


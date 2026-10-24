/**
 * MQTT 3.1.1 (OASIS Standard, 2014) in the simulation: the brokers (the
 * MQTT broker service) and their clients (applications of the profile
 * mqtt_client). Broker-mediated application traffic over TCP, never IP
 * multicast: a subscription is the broker's state, no IGMP membership.
 *
 * A client, once started, opens a TCP connection to its broker (its
 * address of the client's family, the broker's port or 1883) and sends
 * CONNECT with its client identifier and keep alive; the broker answers
 * CONNACK (0: accepted). A client already connected with the same
 * identifier is disconnected first [MQTT-3.1.4-2]. Every session is clean
 * (CleanSession = 1): nothing of it outlives its connection, so a
 * reconnecting client subscribes again.
 *
 * Subscriptions: SUBSCRIBE with the client's topic filters and QoS, SUBACK
 * with the QoS granted per filter (at most 1; 0x80 for an invalid one).
 * Publications: PUBLISH to the broker, which passes it to every session
 * whose filters match the topic (+ one level, # the rest, §4.7), with the
 * lower of the publication's and the highest matching granted QoS
 * [MQTT-3.8.4-6, MQTT-3.3.5-1]; nobody else gets it. QoS 1: the receiver
 * of a PUBLISH answers PUBACK with its packet identifier; one without
 * PUBACK is sent again with DUP after the retry interval while the
 * connection lasts (allowed by 3.1.1 §4.4, not required: a modelling
 * default of 20 s); what is still unacknowledged when the connection
 * closes is lost with the clean session. QoS 2 is not modelled.
 *
 * Keep alive: a client sends PINGREQ when it sent nothing for its keep
 * alive (the broker answers PINGRESP); without PINGRESP within a keep
 * alive it closes the connection. The broker closes a connection it heard
 * nothing on for 1.5 × the keep alive [MQTT-3.1.2-24]. A client whose
 * connection closed (or could not be opened) connects again after a
 * reconnect delay (a modelling default of 5 s) until it is stopped; Stop
 * unsubscribes, disconnects (DISCONNECT, then FIN) and ends the run. A
 * periodic publisher's schedule is its run's, not its connection's: it
 * goes on across reconnections (one round per interval; a round that falls
 * while it is not connected is not published, the next one is).
 *
 * Packet identifiers: 1–65535, each side its own (§2.3.1), wrapping after
 * 65535 and skipping one still waiting for its acknowledgment; SUBACK and
 * UNSUBACK complete only the request of their identifier.
 *
 * Each logical publication has a bounded record (MqttPublication, the
 * latest PUBS_KEPT): its run, client, topic, QoS and packet identifier,
 * the packets that carried it (DUPs and TCP retransmissions included), its
 * receipt at the broker, its PUBACK or its loss with a closed connection,
 * and each subscriber the broker passed it to, with that subscriber's
 * receipt — what a diagnosis correlates its legs by, so an earlier run's,
 * another publisher's or another topic's traffic never stands for it.
 *
 * Not modelled: QoS 2, persistent sessions, retained messages, wills,
 * user names and passwords, TLS, payload contents. Message sizes follow
 * the packets' fixed and variable headers (their strings in UTF-8 bytes,
 * §1.5.3), the payload as configured.
 */
import { IpAddr } from '../../model/ip';
import { APP_DEFAULTS, AppInstance, mqttClientId, mqttRole, topicFilterProblem, topicMatches } from '../../model/applications';
import { MQTT_PORT } from '../listeners';
import { formatAddr } from '../ipmath';
import { ordered, reachRank, runtimeKind } from '../endpoint-order';
import { AppRun, AppSim } from './apps';
import { durationText } from './params';
import { ProtocolSim } from './protocols';
import { AppMessage, AppSocket, Transport } from './transport';
import { GridTable, SessionStatus } from './types';
import type { ActionView } from './actions';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A client connects again this long after its connection closed (a modelling default: client libraries choose their own). */
export const RECONNECT_DELAY = 5000;

/** The size of an MQTT control packet: its fixed header (1 byte and the remaining length, 1–4 bytes) and the rest. */
function packetBytes(rest: number): number {
  return 1 + (rest < 128 ? 1 : rest < 16384 ? 2 : rest < 2097152 ? 3 : 4) + rest;
}
/** The bytes of a string in UTF-8 (MQTT's encoding of its strings, 3.1.1 §1.5.3): one to four per character, by code point. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u < 0x80) n += 1;
    else if (u < 0x800) n += 2;
    else if (u >= 0xd800 && u <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // a surrogate pair: one code point beyond the BMP, four bytes
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
/** A UTF-8 encoded string of an MQTT packet: its two-byte length and its bytes (3.1.1 §1.5.3). */
const str = (s: string): number => 2 + utf8Bytes(s);

/** Packet identifiers are 16 bits, never 0 (3.1.1 §2.3.1). */
const PID_MAX = 65535;
/**
 * The next packet identifier of one side (client and broker each have their own, 3.1.1 §2.3.1): counting on from the last
 * one, wrapping after 65535 to 1, skipping one still in use by an exchange not yet acknowledged; null when all 65535 are.
 */
function nextPid(holder: { nextPid: number }, inUse: (pid: number) => boolean): number | null {
  for (let k = 0; k < PID_MAX; k++) {
    const pid = holder.nextPid >= 1 && holder.nextPid <= PID_MAX ? holder.nextPid : 1;
    holder.nextPid = pid === PID_MAX ? 1 : pid + 1;
    if (!inUse(pid)) return pid;
  }
  return null;
}

/** How many publications' records are kept (the oldest go first; a diagnosis says when its run's are gone). */
export const PUBS_KEPT = 2000;

/** One logical publication of a client (its DUPs are copies of it) and what became of it, as recorded. */
export interface MqttPublication {
  /** its id in this simulation (the order publications were made) */
  id: number;
  /** the publisher's run (AppRun id), device, application and client identifier */
  run: number;
  dev: string;
  app: string;
  clientId: string;
  broker: string;
  topic: string;
  qos: 0 | 1;
  /** its packet identifier (QoS 1; 0 at QoS 0) */
  pid: number;
  /** published at */
  t: number;
  /** DUP copies sent (no PUBACK within the retry interval) */
  dups: number;
  /** the packets that carried it: its segment, a TCP retransmission, a DUP's (the latest 8) */
  pkts: number[];
  /** its first receipt at the broker, and how many copies arrived (DUPs included) */
  brokerRx?: number;
  brokerRxCount: number;
  /** the client identifiers the broker passed it to at its first receipt (empty: nobody was subscribed) */
  matched?: string[];
  /** its PUBACK at the publisher (QoS 1) */
  acked?: number;
  /** its connection closed before the PUBACK: lost with the clean session (why, as the client recorded it) */
  lost?: number;
  lostWhy?: string;
  /** each subscriber the broker sent it to: its receipt (the first copy) and how many copies arrived; its run */
  deliveries: Array<{ clientId: string; dev: string; app?: string; qos: 0 | 1; t: number; copies: number; rx?: number; rxCount: number; run?: number; acked?: number; pkts: number[] }>;
}

/** A broker's session of one client. */
interface BrokerSession {
  clientId: string;
  sock: AppSocket;
  /** the client's device and application, when the broker knows them (its packets say who sent them) */
  dev: string;
  app?: string;
  keepalive: number;
  heard: number;
  /** granted filters: filter → QoS */
  subs: Map<string, 0 | 1>;
  nextPid: number;
  /** QoS 1 deliveries waiting for PUBACK: packet id → the delivery */
  inflight: Map<number, { topic: string; bytes: number; tries: number; gen: number; traffic?: number; pub?: number }>;
  gen: number;
  since: number;
  delivered: number;
  acked: number;
}

interface Broker {
  dev: string;
  port: number;
  retry: number;
  sessions: Map<string, BrokerSession>;
  received: number;
  delivered: number;
  /** publications nobody was subscribed to */
  unmatched: number;
  /** connections refused or taken over */
  takeovers: number;
}

/** One run of an MQTT client (its sessions with the broker, one after the other). */
export interface MqttRun {
  run: AppRun;
  clientId: string;
  broker: string;
  port: number;
  state: 'Disconnected' | 'Connecting' | 'Connected' | 'Stopped';
  sock: AppSocket | null;
  /** connections opened (the first and each reconnection) */
  connects: number;
  /** filters granted by the broker's last SUBACK: filter → QoS (or 0x80 refused) */
  granted: Map<string, number>;
  /** the publications it sent and how many the broker acknowledged (QoS 1) */
  published: number;
  pubacked: number;
  /** QoS 1 publications waiting for PUBACK (their records' ids) */
  inflight: Map<number, { topic: string; bytes: number; tries: number; gen: number; pub: number }>;
  nextPid: number;
  /** the packet identifiers of its SUBSCRIBE and UNSUBSCRIBE waiting for SUBACK / UNSUBACK (null: none) */
  subPid: number | null;
  unsubPid: number | null;
  /** what it received, by topic */
  received: Map<string, number>;
  /** the last control packet it sent (its keep alive counts from it) */
  lastSent: number;
  pingAt: number | null;
  gen: number;
  /** publication rounds done (one PUBLISH per topic each) */
  rounds: number;
  /**
   * The run's publication schedule (its token; 0: none): one per run, kept across its connections — a round that falls
   * while it is not connected is not published (nor counted), the next one is once it is connected again
   */
  sched: number;
  /** rounds not published: not connected at their time */
  missed: number;
  /** the connection whose first missed round was said (once per connection lost) */
  missedSaid: number;
  lost: number;
  lastClose?: string;
  /** its traffic id (Network events): what it sends and causes is the foreground */
  traffic?: number;
  rt?: number;
}

export class MqttSim {
  readonly brokers = new Map<string, Broker>();
  readonly clients: MqttRun[] = [];
  private schedSeq = 0;
  /** the publications' records, oldest first (the latest PUBS_KEPT), and how many left already */
  readonly pubs: MqttPublication[] = [];
  pubsDropped = 0;
  private pubSeq = 0;
  private pubById = new Map<number, MqttPublication>();

  /** A publication's record (null: no such id, or no longer kept). */
  publication(id: unknown): MqttPublication | null {
    return typeof id === 'number' ? this.pubById.get(id) || null : null;
  }

  private newPublication(c: MqttRun, topic: string, qos: 0 | 1, pid: number): MqttPublication {
    const p: MqttPublication = { id: ++this.pubSeq, run: c.run.id, dev: c.run.dev, app: c.run.app.id, clientId: c.clientId, broker: c.broker, topic, qos, pid, t: this.e.now, dups: 0, pkts: [], brokerRxCount: 0, deliveries: [] };
    this.pubs.push(p);
    this.pubById.set(p.id, p);
    while (this.pubs.length > PUBS_KEPT) {
      const old = this.pubs.shift() as MqttPublication;
      this.pubById.delete(old.id);
      this.pubsDropped++;
    }
    return p;
  }

  constructor(
    private P: ProtocolSim,
    private T: Transport,
    private A: AppSim,
  ) {
    for (const d of P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      const svc = d.appServices ? d.appServices.get('mqtt_broker') : undefined;
      if (!svc) continue;
      const port = typeof svc.values.port === 'number' ? (svc.values.port as number) : MQTT_PORT;
      const b: Broker = { dev: d.id, port, retry: typeof svc.values.retry_interval === 'number' ? (svc.values.retry_interval as number) : APP_DEFAULTS.mqttRetry, sessions: new Map(), received: 0, delivered: 0, unmatched: 0, takeovers: 0 };
      this.brokers.set(d.id, b);
      // (its connections' own segments — the handshake, the acknowledgments — are drawn and filtered as MQTT's)
      T.appListen(d.id, port, `MQTT broker ${d.id}`, { message: (s, m) => this.brokerIn(b, s, m), closed: (s, why) => this.brokerClosed(b, s, why) }, { protocol: 'mqtt', label: 'MQTT' });
    }
    A.mqttProblem = (dev, a) => this.problem(dev, a);
    A.mqttStart = (dev, a, how) => this.start(dev, a, how);
    A.mqttStop = (run) => this.stop(run);
    P.extraStatus.push(() => this.status());
    P.deviceHooks.push((dev, up) => {
      // a broker powered off: its sessions are gone (its clients notice by their keep alive); booted, it takes connections again
      const b = this.brokers.get(dev);
      if (b && !up) b.sessions.clear();
      // a client powered off: its connection is gone; booted, it connects again
      for (const c of this.clients) if (c.run.dev === dev && c.state !== 'Stopped') {
        if (!up) this.lostConnection(c, `${dev} was powered off`, false);
        else this.reconnectSoon(c, `${dev} booted`);
      }
    });
  }

  private get e() {
    return this.P.e;
  }

  // ------------------------------------------------------------ the client

  /** What stops an MQTT client from starting now, or null. */
  private problem(dev: string, a: AppInstance): string | null {
    if (!a.broker) return `${dev}/${a.id} names no broker`;
    if (!this.brokers.has(a.broker)) return `${a.broker} runs no MQTT broker service`;
    if (!this.e.deviceOn(dev)) return `${dev} is powered off`;
    if (this.clients.some((c) => c.run.dev === dev && c.run.app.id === a.id && c.state !== 'Stopped')) return `${dev}/${a.id} is running already`;
    const v = this.A.family(a);
    const ip = this.brokerAddr(a.broker, v);
    if (typeof ip === 'string') return ip;
    return null;
  }

  /** The broker's address of a family now. */
  private brokerAddr(broker: string, v: 4 | 6): IpAddr | string {
    const sd = this.P.sd(broker);
    if (!sd) return `${broker} is not in the simulation`;
    // (as any device is reached — endpoint-order.ts reach, the static check's broker too: loopbacks, then a bridge's, last)
    const ls = ordered(Array.from(sd.l3.values()), (l) => reachRank(runtimeKind(l, this.P.m.index.interfaces.get(broker + ':' + l.id))), (l) => l.id);
    for (const l of ls) for (const x of l.addrs) if (x.addr.version === v) return x.addr;
    return `the broker ${broker} has no IPv${v} address`;
  }

  /** Start an MQTT client: connect, subscribe, publish every interval, until stopped (or its publications are done). */
  private start(dev: string, a: AppInstance, how: 'event' | 'start' | 'experiment'): AppRun | string {
    const b = this.brokers.get(a.broker as string) as Broker;
    const interval = a.publish.length ? a.interval || 0 : 0;
    const run: AppRun = { id: this.A.nextId(), dev, app: a, how, target: `${a.broker}:${b.port}`, t0: this.e.now, count: a.publish.length && a.count !== undefined ? a.count : a.publish.length && !interval ? 1 : null, interval, sent: 0, tests: [], retried: 0, skipped: [], stopped: false };
    const c: MqttRun = { run, clientId: mqttClientId(dev, a), broker: b.dev, port: b.port, state: 'Disconnected', sock: null, connects: 0, granted: new Map(), published: 0, pubacked: 0, inflight: new Map(), nextPid: 1, subPid: null, unsubPid: null, received: new Map(), lastSent: this.e.now, pingAt: null, gen: 0, rounds: 0, sched: 0, missed: 0, missedSaid: -1, lost: 0, traffic: how !== 'start' ? this.T.reserveId() : undefined };
    (run as AppRun & { mqtt?: MqttRun }).mqtt = c;
    this.clients.push(c);
    this.A.runs.push(run);
    this.connect(c, 'it starts');
    return run;
  }

  /** Run fn as the client's own (its traffic id: the foreground of Network events). */
  private as<T>(c: MqttRun, fn: () => T): T {
    return this.e.withTest(c.traffic !== undefined ? c.traffic : null, fn);
  }

  /** A timer of a client (its generation: a closed connection's timers do nothing). */
  private later(c: MqttRun, dt: number, fn: () => void): void {
    const g = c.gen;
    this.e.after(dt, () => {
      if (c.gen === g && c.state !== 'Stopped') this.as(c, fn);
    });
  }

  private note(c: MqttRun, what: string, state: string, detail: string): void {
    this.as(c, () => this.e.note('state', 'mqtt', c.run.dev, c.broker, what, state, detail));
  }

  private connect(c: MqttRun, why: string): void {
    if (c.state === 'Stopped' || !this.e.deviceOn(c.run.dev)) return;
    const v = this.A.family(c.run.app);
    const ip = this.brokerAddr(c.broker, v);
    if (typeof ip === 'string') {
      this.note(c, 'not connected', 'Disconnected', `${this.name(c)}: ${ip}; it tries again in ${durationText(RECONNECT_DELAY)}`);
      this.reconnectSoon(c, ip);
      return;
    }
    c.gen++;
    const g = c.gen;
    c.state = 'Connecting';
    c.connects++;
    c.granted.clear();
    c.sock = null;
    const s = this.as(c, () =>
      this.T.appConnect(c.run.dev, ip, c.port, `MQTT client ${c.clientId}`, {
        open: (sk) => this.as(c, () => this.opened(c, sk)),
        message: (sk, m) => this.as(c, () => this.clientIn(c, sk, m)),
        // (this attempt's own socket — also when it closes before appConnect returns it: its first SYN failed at once)
        closed: (sk, w) => {
          if (c.gen === g && (c.sock === sk || c.sock === null)) this.as(c, () => this.lostConnection(c, w, true));
        },
      }, undefined, { protocol: 'mqtt', label: 'MQTT' }),
    );
    if (typeof s === 'string') {
      this.note(c, 'not connected', 'Disconnected', `${this.name(c)}: ${s}; it tries again in ${durationText(RECONNECT_DELAY)}`);
      c.state = 'Disconnected';
      this.reconnectSoon(c, s);
      return;
    }
    // (closed already, while it was being opened: lostConnection said so and connects again)
    if (c.gen !== g) return;
    c.sock = s;
    this.note(c, 'connecting', 'Connecting', `${this.name(c)} opens a TCP connection to the broker ${c.broker} at ${formatAddr(ip)}:${c.port} (${c.connects === 1 ? why : 'reconnection ' + (c.connects - 1) + ': ' + why})`);
  }

  private name(c: MqttRun): string {
    return `MQTT client ${c.clientId} (${c.run.dev}/${c.run.app.id})`;
  }

  /** The TCP connection is open: CONNECT. */
  private opened(c: MqttRun, s: AppSocket): void {
    const ka = this.keepalive(c);
    this.send(c, s, 'CONNECT', `client ${c.clientId}`, `MQTT CONNECT from ${c.clientId}: protocol MQTT, level 4 (3.1.1), clean session, keep alive ${ka / 1000} s`, packetBytes(10 + str(c.clientId)), { clientId: c.clientId, keepalive: ka, clean: true, client: c.run.dev, app: c.run.app.id });
  }

  private keepalive(c: MqttRun): number {
    return c.run.app.keepalive !== undefined ? c.run.app.keepalive : APP_DEFAULTS.mqttKeepalive;
  }

  private send(c: MqttRun, s: AppSocket, type: string, short: string, detail: string, bytes: number, data: { [k: string]: unknown }, carried?: (pkt: number) => void): void {
    c.lastSent = this.e.now;
    const m = mqttMsg(type, short, detail, bytes, data);
    if (carried) m.carried = carried;
    s.send(m);
  }

  private clientIn(c: MqttRun, s: AppSocket, m: AppMessage): void {
    const d = m.data as { [k: string]: unknown };
    switch (m.type) {
      case 'MQTT CONNACK': {
        if (d.rc !== 0) {
          this.note(c, 'refused', 'Disconnected', `${this.name(c)}: the broker refused the connection (CONNACK return code ${d.rc})`);
          s.close('CONNACK refused');
          return;
        }
        c.state = 'Connected';
        // (a clean session: nothing of the last one is in flight — its packet identifiers start over)
        c.nextPid = 1;
        c.subPid = c.unsubPid = null;
        this.note(c, 'connected', 'Connected', `${this.name(c)} is connected to ${c.broker} (CONNACK 0: accepted, no session present: a clean session)`);
        const subs = c.run.app.subscribe;
        if (subs.length) {
          const qos = c.run.app.qos || 0;
          const pid = nextPid(c, (x) => this.clientPidInUse(c, x)) as number;
          c.subPid = pid;
          this.send(c, s, 'SUBSCRIBE', subs.length === 1 ? subs[0] : `${subs.length} filters`, `MQTT SUBSCRIBE (packet ${pid}) from ${c.clientId}: ${subs.map((f) => `${f} (QoS ${qos})`).join(', ')}`, packetBytes(2 + subs.reduce((n, f) => n + str(f) + 1, 0)), { pid, filters: subs.map((f) => ({ filter: f, qos })) });
        }
        this.armKeepalive(c);
        this.startPublishing(c);
        return;
      }
      case 'MQTT SUBACK': {
        // (only the SUBACK of its SUBSCRIBE: the same packet identifier, [MQTT-3.8.4-2])
        if (d.pid !== c.subPid) return;
        c.subPid = null;
        const codes = (d.codes as number[]) || [];
        c.run.app.subscribe.forEach((f, k) => c.granted.set(f, codes[k] !== undefined ? codes[k] : 0x80));
        this.note(c, 'subscribed', 'Connected', `${this.name(c)}: SUBACK ${c.run.app.subscribe.map((f, k) => `${f} → ${codes[k] === 0x80 ? 'refused (0x80)' : 'QoS ' + codes[k]}`).join(', ')}`);
        return;
      }
      case 'MQTT PUBACK': {
        const f = c.inflight.get(d.pid as number);
        if (!f) return;
        c.inflight.delete(d.pid as number);
        c.pubacked++;
        const p = this.publication(f.pub);
        if (p && p.acked === undefined) p.acked = this.e.now;
        return;
      }
      case 'MQTT PUBLISH': {
        const topic = d.topic as string;
        c.received.set(topic, (c.received.get(topic) || 0) + 1);
        // (this subscriber's receipt of that publication: the broker's copy names it)
        const p = this.publication(d.pub);
        const dl = p ? p.deliveries.find((x) => x.clientId === c.clientId) : undefined;
        if (dl) {
          if (dl.rx === undefined) dl.rx = this.e.now;
          dl.rxCount++;
          dl.run = c.run.id;
        }
        if (d.qos === 1) this.send(c, s, 'PUBACK', `packet ${d.pid}`, `MQTT PUBACK (packet ${d.pid}) from ${c.clientId}: it has the publication to ${topic}`, packetBytes(2), { pid: d.pid });
        return;
      }
      case 'MQTT PINGRESP':
        c.pingAt = null;
        return;
      case 'MQTT UNSUBACK':
        if (d.pid !== c.unsubPid) return;
        c.unsubPid = null;
        if (c.run.stopped) this.disconnect(c, s);
        return;
    }
  }

  /** Keep alive: PINGREQ when it sent nothing for the keep alive; no PINGRESP within another: the connection is closed. */
  private armKeepalive(c: MqttRun): void {
    const ka = this.keepalive(c);
    if (!ka) return;
    const tick = (): void => {
      const s = c.sock;
      if (!s || !s.open || c.state !== 'Connected') return;
      if (c.pingAt !== null && this.e.now - c.pingAt >= ka) {
        this.note(c, 'keep alive', 'Disconnected', `${this.name(c)}: no PINGRESP within ${durationText(ka)}: it closes the connection`);
        s.close('no PINGRESP');
        return;
      }
      if (c.pingAt === null && this.e.now - c.lastSent >= ka) {
        c.pingAt = this.e.now;
        this.send(c, s, 'PINGREQ', 'keep alive', `MQTT PINGREQ from ${c.clientId}: it sent nothing for its keep alive (${durationText(ka)})`, packetBytes(0), {});
      }
      this.later(c, Math.max(1000, ka / 4), tick);
    };
    this.later(c, Math.max(1000, ka / 4), tick);
  }

  /** Is a client's packet identifier in use (a QoS 1 publication, a SUBSCRIBE or UNSUBSCRIBE not yet acknowledged)? */
  private clientPidInUse(c: MqttRun, pid: number): boolean {
    return c.inflight.has(pid) || pid === c.subPid || pid === c.unsubPid;
  }

  private publishedAll(c: MqttRun): boolean {
    return c.run.count !== null && c.rounds >= c.run.count;
  }

  /**
   * Connected (CONNACK): the first round of publications at once, then the run's own schedule every interval of simulated
   * time — one schedule per run, kept across reconnections (a reconnection neither restarts nor duplicates it). A publisher
   * whose rounds are all done and that subscribes to nothing ends once they are acknowledged — also when it got there on
   * an earlier connection (what was unacknowledged then was lost with the clean session).
   */
  private startPublishing(c: MqttRun): void {
    const r = c.run;
    if (!r.app.publish.length) return;
    if (this.publishedAll(c)) {
      if (!r.app.subscribe.length) this.finishWhenAcked(c);
      return;
    }
    if (c.sched || c.rounds > 0) return;
    this.round(c);
    if (!r.interval || this.publishedAll(c)) return;
    const token = ++this.schedSeq;
    c.sched = token;
    const next = (): void => {
      this.e.after(r.interval, () => {
        if (c.sched !== token || c.state === 'Stopped' || r.stopped) return;
        if (c.state === 'Connected') this.as(c, () => this.round(c));
        else {
          c.missed++;
          if (c.missedSaid !== c.gen) {
            c.missedSaid = c.gen;
            this.note(c, 'not published', c.state, `${this.name(c)}: not connected at its publication time — the round is not published; it publishes again at its next one once connected`);
          }
        }
        if (this.publishedAll(c)) c.sched = 0;
        else next();
      });
    };
    next();
  }

  /** One round of publications: one PUBLISH to each topic. */
  private round(c: MqttRun): void {
    const r = c.run;
    if (c.state !== 'Connected' || r.stopped || this.publishedAll(c)) return;
    c.rounds++;
    r.sent = c.rounds;
    for (const t of r.app.publish) this.publish(c, t);
    // a publisher without subscriptions is done when its last publications are acknowledged
    if (this.publishedAll(c) && !r.app.subscribe.length) this.finishWhenAcked(c);
  }

  private publish(c: MqttRun, topic: string): void {
    const s = c.sock;
    if (!s || !s.open) return;
    const qos = c.run.app.qos || 0;
    const size = c.run.app.payloadSize !== undefined ? c.run.app.payloadSize : APP_DEFAULTS.mqttPayload;
    const pid = qos ? nextPid(c, (x) => this.clientPidInUse(c, x)) : 0;
    if (pid === null) {
      this.note(c, 'not published', c.state, `${this.name(c)}: no packet identifier free (all ${PID_MAX} wait for PUBACK): the publication to ${topic} is not sent`);
      return;
    }
    c.published++;
    const bytes = packetBytes(str(topic) + (qos ? 2 : 0) + size);
    const rec = this.newPublication(c, topic, qos ? 1 : 0, pid);
    const carried = (pkt: number): void => {
      rec.pkts.push(pkt);
      if (rec.pkts.length > 8) rec.pkts.shift();
    };
    this.send(c, s, 'PUBLISH', topic, `MQTT PUBLISH from ${c.clientId} to ${topic}: QoS ${qos}${qos ? `, packet ${pid}` : ''}, a payload of ${size} bytes (its contents are not modelled)`, bytes, { topic, qos, pid, dup: false, payload: size, from: c.run.dev, pub: rec.id }, carried);
    if (!qos) return;
    const f = { topic, bytes, tries: 0, gen: c.gen, pub: rec.id };
    c.inflight.set(pid, f);
    const retry = c.run.app.retryInterval !== undefined ? c.run.app.retryInterval : APP_DEFAULTS.mqttRetry;
    const again = (): void => {
      this.later(c, retry, () => {
        // (this publication's own: its packet identifier, once acknowledged, may be another's later)
        if (c.inflight.get(pid) !== f || !c.sock || !c.sock.open) return;
        f.tries++;
        c.run.retried++;
        rec.dups++;
        this.send(c, c.sock, 'PUBLISH', `${topic} (DUP)`, `MQTT PUBLISH from ${c.clientId} to ${topic} again: QoS 1, packet ${pid}, DUP (no PUBACK within ${durationText(retry)})`, bytes, { topic, qos, pid, dup: true, payload: size, from: c.run.dev, pub: rec.id }, carried);
        again();
      });
    };
    again();
  }

  /** A publisher's run ends once its publications are acknowledged (QoS 1) or sent (QoS 0): it disconnects. */
  private finishWhenAcked(c: MqttRun): void {
    const check = (): void => {
      if (c.state !== 'Connected' || !c.sock) return;
      if (c.inflight.size) {
        this.later(c, 500, check);
        return;
      }
      c.run.stopped = true;
      c.run.stoppedAt = this.e.now;
      this.disconnect(c, c.sock);
    };
    this.later(c, 200, check);
  }

  private disconnect(c: MqttRun, s: AppSocket): void {
    this.send(c, s, 'DISCONNECT', c.clientId, `MQTT DISCONNECT from ${c.clientId}: it ends its session`, packetBytes(0), {});
    c.state = 'Stopped';
    c.gen++;
    this.note(c, 'disconnected', 'Stopped', `${this.name(c)} disconnects from ${c.broker}`);
    // (the FIN after the DISCONNECT: a moment later, so both are in order on the wire)
    this.e.after(50, () => this.as(c, () => s.close('DISCONNECT sent')));
  }

  /** Stop (Network events): unsubscribe, disconnect, end the run. */
  stop(run: AppRun): boolean {
    const c = this.clients.find((x) => x.run === run);
    if (!c || c.state === 'Stopped') return false;
    run.stopped = true;
    run.stoppedAt = this.e.now;
    this.as(c, () => {
      const s = c.sock;
      if (s && s.open && c.state === 'Connected') {
        const subs = c.run.app.subscribe;
        if (subs.length) {
          const pid = nextPid(c, (x) => this.clientPidInUse(c, x)) as number;
          c.unsubPid = pid;
          this.send(c, s, 'UNSUBSCRIBE', subs.length === 1 ? subs[0] : `${subs.length} filters`, `MQTT UNSUBSCRIBE (packet ${pid}) from ${c.clientId}: ${subs.join(', ')}`, packetBytes(2 + subs.reduce((n, f) => n + str(f), 0)), { pid, filters: subs });
          // (no UNSUBACK in time: it disconnects all the same)
          this.later(c, 3000, () => {
            if (c.state !== 'Stopped' && c.sock) this.disconnect(c, c.sock);
          });
        } else this.disconnect(c, s);
      } else {
        c.state = 'Stopped';
        c.gen++;
        if (s) s.close('stopped');
        this.note(c, 'stopped', 'Stopped', `${this.name(c)} is stopped`);
      }
    });
    return true;
  }

  /** Its connection is gone: what was unacknowledged is lost with the clean session; it connects again (unless stopped). */
  private lostConnection(c: MqttRun, why: string, retry: boolean): void {
    if (c.state === 'Stopped') return;
    const was = c.state;
    c.gen++;
    c.state = 'Disconnected';
    c.sock = null;
    c.pingAt = null;
    c.lastClose = why;
    c.lost += c.inflight.size;
    for (const f of c.inflight.values()) {
      const p = this.publication(f.pub);
      if (p && p.acked === undefined && p.lost === undefined) {
        p.lost = this.e.now;
        p.lostWhy = why;
      }
    }
    c.inflight.clear();
    c.granted.clear();
    this.note(c, 'connection closed', 'Disconnected', `${this.name(c)}: ${was === 'Connecting' ? 'could not connect' : 'its connection is gone'} (${why})${retry ? `; it connects again in ${durationText(RECONNECT_DELAY)}` : ''}`);
    if (retry) this.reconnectSoon(c, why);
  }

  private reconnectSoon(c: MqttRun, why: string): void {
    const g = c.gen;
    this.e.after(RECONNECT_DELAY, () => {
      if (c.gen === g && c.state === 'Disconnected') this.as(c, () => this.connect(c, why));
    });
  }

  // ------------------------------------------------------------ the broker

  private brokerIn(b: Broker, s: AppSocket, m: AppMessage): void {
    const d = m.data as { [k: string]: unknown };
    const sess = Array.from(b.sessions.values()).find((x) => x.sock === s);
    if (sess) sess.heard = this.e.now;
    const bsend = (type: string, short: string, detail: string, bytes: number, data: { [k: string]: unknown }): void => {
      s.send(mqttMsg(type, short, detail, bytes, data));
    };
    switch (m.type) {
      case 'MQTT CONNECT': {
        const cid = d.clientId as string;
        if (!cid) {
          bsend('CONNACK', 'refused', `MQTT CONNACK from ${b.dev}: 2, identifier rejected`, packetBytes(2), { rc: 2 });
          return;
        }
        const old = b.sessions.get(cid);
        if (old && old.sock !== s) {
          // [MQTT-3.1.4-2]: a client already connected with this identifier is disconnected
          b.takeovers++;
          this.e.note('state', 'mqtt', b.dev, old.dev, 'session taken over', '', `MQTT broker ${b.dev}: a new CONNECT with the client identifier ${cid} from ${formatAddr(s.remote)}: it closes the existing connection of ${old.dev}${old.app ? '/' + old.app : ''} (MQTT 3.1.1 §3.1.4)`);
          b.sessions.delete(cid);
          old.gen++;
          old.sock.close(`the client identifier ${cid} connected again elsewhere`);
        }
        const ns: BrokerSession = { clientId: cid, sock: s, dev: String(d.client || this.e.ownerOf(s.remote) || formatAddr(s.remote)), app: d.app as string | undefined, keepalive: Number(d.keepalive) || 0, heard: this.e.now, subs: new Map(), nextPid: 1, inflight: new Map(), gen: 0, since: this.e.now, delivered: 0, acked: 0 };
        b.sessions.set(cid, ns);
        bsend('CONNACK', 'accepted', `MQTT CONNACK from ${b.dev} to ${cid}: 0, connection accepted (session present 0: clean session)`, packetBytes(2), { rc: 0, sessionPresent: false });
        this.brokerKeepalive(b, ns);
        return;
      }
      case 'MQTT SUBSCRIBE': {
        if (!sess) return;
        const filters = (d.filters as Array<{ filter: string; qos: number }>) || [];
        const codes = filters.map((f) => {
          if (topicFilterProblem(f.filter)) return 0x80;
          const q = (Math.min(1, f.qos) as 0 | 1);
          sess.subs.set(f.filter, q);
          return q;
        });
        this.e.note('table', 'mqtt', b.dev, sess.dev, 'subscribed', '', `MQTT broker ${b.dev}: ${sess.clientId} subscribes to ${filters.map((f, k) => `${f.filter} (granted ${codes[k] === 0x80 ? 'none: 0x80' : 'QoS ' + codes[k]})`).join(', ')}`);
        bsend('SUBACK', `packet ${d.pid}`, `MQTT SUBACK (packet ${d.pid}) from ${b.dev} to ${sess.clientId}: ${codes.map((x) => (x === 0x80 ? '0x80' : String(x))).join(', ')}`, packetBytes(2 + codes.length), { pid: d.pid, codes });
        return;
      }
      case 'MQTT UNSUBSCRIBE': {
        if (!sess) return;
        const fl = (d.filters as string[]) || [];
        for (const f of fl) sess.subs.delete(f);
        this.e.note('table', 'mqtt', b.dev, sess.dev, 'unsubscribed', '', `MQTT broker ${b.dev}: ${sess.clientId} unsubscribes from ${fl.join(', ')}`);
        bsend('UNSUBACK', `packet ${d.pid}`, `MQTT UNSUBACK (packet ${d.pid}) from ${b.dev} to ${sess.clientId}`, packetBytes(2), { pid: d.pid });
        return;
      }
      case 'MQTT PUBLISH': {
        if (!sess) return;
        const topic = d.topic as string;
        const qos = d.qos as 0 | 1;
        if (qos === 1) bsend('PUBACK', `packet ${d.pid}`, `MQTT PUBACK (packet ${d.pid}) from ${b.dev} to ${sess.clientId}: it has the publication to ${topic}`, packetBytes(2), { pid: d.pid });
        // a DUP of a publication it already passed on (its PUBACK was lost): passed on again, as MQTT 3.1.1 allows at QoS 1
        b.received++;
        const p = this.publication(d.pub);
        if (p) {
          if (p.brokerRx === undefined) p.brokerRx = this.e.now;
          p.brokerRxCount++;
        }
        this.fanOut(b, sess, topic, qos, Number(d.payload) || 0, p);
        return;
      }
      case 'MQTT PUBACK': {
        if (!sess) return;
        const f = sess.inflight.get(d.pid as number);
        if (f && sess.inflight.delete(d.pid as number)) {
          sess.acked++;
          const p = this.publication(f.pub);
          const dl = p ? p.deliveries.find((x) => x.clientId === sess.clientId) : undefined;
          if (dl && dl.acked === undefined) dl.acked = this.e.now;
        }
        return;
      }
      case 'MQTT PINGREQ':
        if (!sess) return;
        bsend('PINGRESP', 'keep alive', `MQTT PINGRESP from ${b.dev} to ${sess.clientId}`, packetBytes(0), {});
        return;
      case 'MQTT DISCONNECT':
        if (!sess) return;
        this.e.note('state', 'mqtt', b.dev, sess.dev, 'disconnected', '', `MQTT broker ${b.dev}: ${sess.clientId} disconnected; its session ends (clean session)`);
        b.sessions.delete(sess.clientId);
        sess.gen++;
        return;
    }
  }

  /** The publication goes to each session whose filters match, with the lower of its QoS and the highest granted. */
  private fanOut(b: Broker, from: BrokerSession, topic: string, qos: 0 | 1, payload: number, pub: MqttPublication | null): void {
    const to: Array<{ s: BrokerSession; q: 0 | 1 }> = [];
    for (const s of Array.from(b.sessions.values()).sort((x, y) => cmp(x.clientId, y.clientId))) {
      let best = -1;
      for (const [f, q] of s.subs) if (topicMatches(f, topic)) best = Math.max(best, q);
      if (best >= 0) to.push({ s, q: Math.min(qos, best) as 0 | 1 });
    }
    if (pub && !pub.matched) pub.matched = to.map((x) => x.s.clientId);
    if (!to.length) {
      b.unmatched++;
      this.e.note('message', 'mqtt', b.dev, from.dev, 'no subscriber', '', `MQTT broker ${b.dev}: nobody is subscribed to ${topic} (from ${from.clientId}): the publication goes no further`);
      return;
    }
    this.e.note('message', 'mqtt', b.dev, from.dev, 'fan-out', '', `MQTT broker ${b.dev}: the publication of ${from.clientId} to ${topic} goes to ${to.map((x) => `${x.s.clientId} (QoS ${x.q})`).join(', ')}`);
    for (const x of to) this.deliver(b, x.s, topic, x.q, payload, pub);
  }

  private deliver(b: Broker, s: BrokerSession, topic: string, q: 0 | 1, payload: number, pub: MqttPublication | null): void {
    if (!s.sock.open) return;
    const pid = q ? nextPid(s, (x) => s.inflight.has(x)) : 0;
    if (pid === null) {
      this.e.note('drop', 'mqtt', b.dev, s.dev, 'not delivered', '', `MQTT broker ${b.dev}: no packet identifier free for ${s.clientId} (all ${PID_MAX} wait for PUBACK): the publication to ${topic} is not delivered to it`);
      return;
    }
    const bytes = packetBytes(str(topic) + (q ? 2 : 0) + payload);
    b.delivered++;
    s.delivered++;
    const traffic = this.e.testCtx !== null ? this.e.testCtx : undefined;
    // (the publication's record learns this delivery — a DUP the publisher sent again is passed on again: one more copy)
    let dl = pub ? pub.deliveries.find((x) => x.clientId === s.clientId) : undefined;
    if (pub && !dl) {
      dl = { clientId: s.clientId, dev: s.dev, app: s.app, qos: q, t: this.e.now, copies: 0, rxCount: 0, pkts: [] };
      pub.deliveries.push(dl);
    }
    if (dl) dl.copies++;
    const carried = (pkt: number): void => {
      if (!dl) return;
      dl.pkts.push(pkt);
      if (dl.pkts.length > 8) dl.pkts.shift();
    };
    const m0 = mqttMsg('PUBLISH', topic, `MQTT PUBLISH from the broker ${b.dev} to ${s.clientId}: ${topic}, QoS ${q}${q ? `, packet ${pid}` : ''}, a payload of ${payload} bytes`, bytes, { topic, qos: q, pid, dup: false, payload, pub: pub ? pub.id : undefined });
    m0.carried = carried;
    s.sock.send(m0);
    if (!q) return;
    const f = { topic, bytes, tries: 0, gen: s.gen, traffic, pub: pub ? pub.id : undefined };
    s.inflight.set(pid, f);
    const g = s.gen;
    const again = (): void => {
      this.e.after(b.retry, () => {
        if (s.gen !== g || s.inflight.get(pid) !== f || !s.sock.open) return;
        f.tries++;
        const md = mqttMsg('PUBLISH', `${topic} (DUP)`, `MQTT PUBLISH from the broker ${b.dev} to ${s.clientId} again: ${topic}, QoS 1, packet ${pid}, DUP (no PUBACK within ${durationText(b.retry)})`, bytes, { topic, qos: q, pid, dup: true, payload, pub: pub ? pub.id : undefined });
        md.carried = carried;
        this.e.withTest(traffic, () => s.sock.send(md));
        again();
      });
    };
    again();
  }

  /** The broker's side of the keep alive: nothing heard for 1.5 × the client's keep alive closes the connection. */
  private brokerKeepalive(b: Broker, s: BrokerSession): void {
    if (!s.keepalive) return;
    const limit = 1.5 * s.keepalive;
    const g = s.gen;
    const tick = (): void => {
      if (s.gen !== g || b.sessions.get(s.clientId) !== s || !s.sock.open) return;
      if (this.e.now - s.heard >= limit) {
        this.e.note('state', 'mqtt', b.dev, s.dev, 'keep alive expired', '', `MQTT broker ${b.dev}: nothing from ${s.clientId} for ${durationText(limit)} (1.5 × its keep alive): it closes the connection and ends the session`);
        b.sessions.delete(s.clientId);
        s.gen++;
        s.sock.close('keep alive expired');
        return;
      }
      this.e.after(Math.max(1000, s.keepalive / 4), tick);
    };
    this.e.after(Math.max(1000, s.keepalive / 4), tick);
  }

  private brokerClosed(b: Broker, s: AppSocket, why: string): void {
    const sess = Array.from(b.sessions.values()).find((x) => x.sock === s);
    if (!sess) return;
    b.sessions.delete(sess.clientId);
    sess.gen++;
    this.e.note('state', 'mqtt', b.dev, sess.dev, 'session ended', '', `MQTT broker ${b.dev}: the connection of ${sess.clientId} is gone (${why}); its session ends (clean session)${sess.inflight.size ? `, ${sess.inflight.size} QoS 1 deliver${sess.inflight.size === 1 ? 'y' : 'ies'} unacknowledged` : ''}`);
  }

  // ------------------------------------------------------------ inspection

  /** A broker's clients and subscriptions, and its counters (Show MQTT sessions). */
  brokerTable(dev: string): GridTable {
    const b = this.brokers.get(dev);
    const rows: string[][] = [];
    if (b) for (const s of Array.from(b.sessions.values()).sort((x, y) => cmp(x.clientId, y.clientId))) rows.push([s.clientId, `${s.dev}${s.app ? '/' + s.app : ''} (${formatAddr(s.sock.remote)}:${s.sock.rport})`, Array.from(s.subs.entries()).map(([f, q]) => `${f} (QoS ${q})`).join(', ') || '—', s.keepalive ? durationText(s.keepalive) : 'off', String(s.delivered), String(s.inflight.size)]);
    return {
      caption: `MQTT sessions of ${dev}`,
      cols: ['Client identifier', 'Client', 'Subscriptions', 'Keep alive', 'Delivered', 'Awaiting PUBACK'],
      rows,
      empty: b ? 'No client connected.' : `${dev} runs no MQTT broker.`,
      timers: [],
      notes: b ? [`Listening on TCP ${b.port}. Publications received: ${b.received}; deliveries to subscribers: ${b.delivered}; with no subscriber: ${b.unmatched}; sessions taken over by the same client identifier: ${b.takeovers}.`, 'Every session is clean: it ends with its connection. QoS 2, retained messages and wills are not modelled.'] : [],
    };
  }

  /** A device's MQTT clients: state, granted subscriptions, publications and what they received (Show MQTT clients). */
  clientTable(dev: string): GridTable {
    const rows: string[][] = [];
    for (const c of this.clients.filter((x) => x.run.dev === dev)) {
      rows.push([
        `${c.run.app.id} (${c.clientId})`,
        `${c.broker}:${c.port}`,
        `${c.state}${c.lastClose && c.state !== 'Connected' ? ` (${c.lastClose})` : ''}`,
        c.run.app.subscribe.map((f) => `${f}: ${c.granted.has(f) ? (c.granted.get(f) === 0x80 ? 'refused' : 'QoS ' + c.granted.get(f)) : 'not granted'}`).join(', ') || '—',
        `${c.published}${c.run.app.qos ? ` (${c.pubacked} acknowledged, ${c.inflight.size} waiting)` : ''}`,
        Array.from(c.received.entries()).sort((x, y) => cmp(x[0], y[0])).map(([t, n]) => `${t}: ${n}`).join(', ') || '—',
      ]);
    }
    return { caption: `MQTT clients of ${dev}`, cols: ['Application', 'Broker', 'State', 'Subscriptions', 'Published', 'Received'], rows, empty: `${dev} has no MQTT client running.`, timers: [], notes: [] };
  }

  /** The client of a run. */
  clientOf(run: AppRun): MqttRun | undefined {
    return this.clients.find((c) => c.run === run);
  }

  /** The clients started with the simulation and the brokers, as status rows (those of Network events are in Active events). */
  private status(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const b of Array.from(this.brokers.values())) out.push({ protocol: 'mqtt', name: `MQTT broker ${b.dev}`, device: b.dev, peer: '', state: `${b.sessions.size} client${b.sessions.size === 1 ? '' : 's'}`, up: this.e.deviceOn(b.dev), detail: `TCP ${b.port}: ${b.received} publications received, ${b.delivered} deliveries, ${b.unmatched} with no subscriber` });
    for (const c of this.clients) {
      if (c.run.how !== 'start') continue;
      out.push({ protocol: 'mqtt', name: `${c.run.dev}/${c.run.app.id}: ${c.run.app.name}`, device: c.run.dev, peer: c.broker, state: c.state, up: c.state === 'Connected', detail: mqttSummary(c) });
    }
    return out;
  }

  /** A client's run as an event of Active events. */
  view(a: { id: number; at: number }, c: MqttRun): ActionView {
    const r = c.run;
    const going = c.state !== 'Stopped';
    const status: ActionView['status'] = going ? 'running' : r.stopped && r.count !== null && c.rounds >= r.count ? 'completed' : 'stopped';
    const ka = this.keepalive(c);
    const details = [
      `${r.dev}/${r.app.id} (${r.app.name}): MQTT 3.1.1 ${mqttRole(r.app)} of the broker ${c.broker}:${c.port}, client identifier ${c.clientId}, clean session, keep alive ${ka ? durationText(ka) : 'off'}; started ${atText(a.at)}.`,
      r.app.publish.length ? `Publishes to ${r.app.publish.join(', ')} at QoS ${r.app.qos || 0}${r.interval ? `, every ${durationText(r.interval)}${r.how === 'event' ? ' of real time' : ''}` : ', once'}${r.count !== null ? ` (${r.count} round${r.count === 1 ? '' : 's'})` : ' until stopped'}.` : 'Publishes nothing.',
      r.app.subscribe.length ? `Subscribes to ${r.app.subscribe.map((f) => `${f} (${c.granted.has(f) ? (c.granted.get(f) === 0x80 ? 'refused' : 'granted QoS ' + c.granted.get(f)) : 'not granted now'})`).join(', ')}.` : 'Subscribes to nothing.',
      `Connections opened: ${c.connects}${c.lastClose ? `; the last one closed: ${c.lastClose}` : ''}.`,
      `Published: ${c.published}${r.app.qos ? `, acknowledged (PUBACK): ${c.pubacked}, waiting: ${c.inflight.size}, retried (DUP): ${r.retried}, lost with a closed connection: ${c.lost}` : ''}.`,
      `Received: ${c.received.size ? Array.from(c.received.entries()).sort((x, y) => cmp(x[0], y[0])).map(([t, n]) => `${t} × ${n}`).join(', ') : 'nothing'} (only what matches its filters: the broker passes nothing else).`,
      'Broker-mediated: every publication goes to the broker first, which passes it on to the matching subscribers; no IP multicast, no IGMP.',
    ];
    return {
      id: a.id,
      kind: 'app',
      title: 'Application',
      target: `${r.dev}/${r.app.id} → ${c.broker}`,
      status,
      at: a.at,
      ended: going ? undefined : r.stoppedAt,
      progress: r.app.publish.length ? { done: c.published, total: r.count !== null ? r.count * r.app.publish.length : null, unit: 'published' } : undefined,
      summary: mqttSummary(c),
      state: c.state === 'Connected' ? `connected to ${c.broker}` : c.state === 'Connecting' ? 'connecting' : c.state === 'Stopped' ? 'disconnected' : `disconnected${c.lastClose ? ` (${c.lastClose})` : ''}, reconnecting`,
      controls: going ? [{ op: 'stop', label: 'Stop' }] : [],
      details,
      tests: c.traffic !== undefined ? [c.traffic] : [],
    };
  }
}

const atText = (ms: number): string => `t = ${Math.round(ms) / 1000} s`;

/** "connected · 12 published (12 acknowledged) · received sensors/room1 × 3". */
export function mqttSummary(c: MqttRun): string {
  const parts: string[] = [c.state === 'Connected' ? 'connected' : c.state === 'Stopped' ? 'disconnected' : c.state === 'Connecting' ? 'connecting' : 'not connected'];
  if (c.run.app.publish.length) parts.push(`${c.published} published${c.run.app.qos ? ` (${c.pubacked} acknowledged)` : ''}`);
  if (c.run.app.subscribe.length) {
    const n = Array.from(c.received.values()).reduce((x, y) => x + y, 0);
    parts.push(`${n} received`);
  }
  return parts.join(' · ');
}

/** An MQTT control packet as the transport sends it: drawn as MQTT, its label short ("MQTT PUBLISH"). */
function mqttMsg(type: string, short: string, detail: string, bytes: number, data: { [k: string]: unknown }): AppMessage {
  void short;
  // what the packet inspector lists: the packet's fields, never a payload's contents or a credential
  const rows: Array<[string, string]> = [['Packet', type], ['Size', `${bytes} bytes (fixed and variable header${data.payload !== undefined ? ', payload' : ''})`]];
  if (data.clientId !== undefined) rows.push(['Client identifier', String(data.clientId)], ['Clean session', 'yes'], ['Keep alive', `${Number(data.keepalive) / 1000} s`]);
  if (data.rc !== undefined) rows.push(['Return code', `${data.rc}${data.rc === 0 ? ' (connection accepted)' : data.rc === 2 ? ' (identifier rejected)' : ''}`]);
  if (data.topic !== undefined) rows.push(['Topic', String(data.topic)]);
  if (data.qos !== undefined) rows.push(['QoS', String(data.qos)]);
  if (data.pid) rows.push(['Packet identifier', String(data.pid)]);
  if (data.dup !== undefined) rows.push(['DUP', data.dup ? 'set (sent again)' : 'not set']);
  if (data.payload !== undefined) rows.push(['Payload', `${data.payload} bytes (its contents are not modelled)`]);
  if (data.filters !== undefined) rows.push(['Topic filters', (data.filters as Array<string | { filter: string; qos: number }>).map((f) => (typeof f === 'string' ? f : `${f.filter} (QoS ${f.qos})`)).join(', ')]);
  if (data.codes !== undefined) rows.push(['Granted', (data.codes as number[]).map((x) => (x === 0x80 ? '0x80 (failure)' : 'QoS ' + x)).join(', ')]);
  return { protocol: 'mqtt', type: 'MQTT ' + type, label: 'MQTT ' + type, detail, bytes, data: { ...data, inspect: { title: 'Application – MQTT 3.1.1', rows } } };
}

/** "publisher and subscriber" for the details. */
export function roleText(a: AppInstance): string {
  return mqttRole(a);
}

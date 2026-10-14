/**
 * Layer 4 of the simulation, and ICMP: what endpoints, servers, load
 * balancers, proxies, monitoring systems and firewalls do with packets
 * that are not a relation's protocol.
 *
 * ICMP echo (ping): answered unless the device's "respond to ping" is off;
 * to a broadcast address only when "respond to broadcast ping" is on. An
 * ICMP error that reaches a sender ends the test or connection it is about
 * (matched by the header it quotes); Fragmentation Needed / Packet Too Big
 * lowers the sender's path MTU to that destination (PMTUD, RFC 1191 / RFC
 * 8201) and the next packets fit.
 *
 * TCP (RFC 9293): the three-way handshake; a SYN unanswered is sent again
 * after the initial retransmission timeout, doubling each time (RFC 6298,
 * at most 120 s), until the SYN retries are spent (then the connection
 * times out); a closed port answers with a RST (unless "reply to closed
 * ports" is off: then nothing); data is sent in segments of at most the
 * path MTU less the headers and retransmitted the same way until
 * acknowledged; the client closes with FIN (FIN_WAIT, TIME_WAIT 60 s, the
 * server LAST_ACK); a connection kept open is probed after the keepalive
 * time (9 probes 75 s apart, Linux) and reset when none is answered.
 * UDP: a request is answered from an open port, else an ICMP port
 * unreachable comes back (never for a broadcast or multicast destination).
 * Which ports a device listens on: its `listening` attribute, else the
 * ports of the relations it serves (their profiles' transport).
 *
 * Tests: endpoint test traffic (periodic, when on: its gateway with ICMP
 * echo and the servers of its service relations on their protocol and
 * port, or its own targets), Send test… (one test from any device to a
 * device, interface, address, subnet broadcast, 255.255.255.255 or a
 * multicast group), a load balancer's health checks of its pool (its
 * service relations to the servers) and a monitoring system's ICMP probes
 * of the devices it polls by SNMP. Each test ends answered, refused,
 * unreachable or timed out (the application response timeout), in the
 * status table and the event log.
 *
 * Load balancers and proxies are full proxies for TCP: a client's
 * connection ends at them, the request goes on over a connection of their
 * own to a pool member (load balancer: a healthy one by its algorithm,
 * persistence by client address) or to the server of their own service
 * relation (proxy, with its upstream connect timeout and its client
 * connection timeout), and the answer comes back the same way.
 *
 * Firewalls (routing ones): the traffic of the model's relations is their
 * policy and passes; anything else passes when it belongs to a session of
 * their session table (stateful: replies, ICMP errors about it) or when
 * their `allow` list permits it (which opens a session), else their
 * default action drops it, or rejects it (TCP RST, else ICMP
 * administratively prohibited). Sessions time out by the firewall's
 * session timeouts. Pure and deterministic.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { Relation, relationDevices } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { lookup } from '../routing';
import { IcmpKind, fmtSec, hashIndex } from './engine';
import { isMulticastIp } from './mac';
import { L3Iface } from './net';
import { PortRule, Resolved, Target, durationText, parsePorts, parseTargets, portsMatch, resolvedText } from './params';
import { ProtocolSim, relationProfile } from './protocols';
import { ConnRow, L4, Msg, Pkt, SessionRow, SessionStatus } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** RFC 6298 §2.5 allows a maximum of at least 60 s; Linux TCP_RTO_MAX is 120 s. */
const RTO_MAX = 120000;
/** Data segments are sent again at most this often before the connection is reset (Linux tcp_retries2). */
const DATA_RETRIES = 15;
/** TIME_WAIT: 2 × MSL (Linux 60 s). */
const TIME_WAIT = 60000;
/** Keepalive probes: 9, 75 s apart (Linux tcp_keepalive_probes / tcp_keepalive_intvl). */
const KA_PROBES = 9;
const KA_INTERVAL = 75000;
/** A firewall keeps a closed TCP session this long (PAN-OS tcp-time-wait 15 s). */
const FW_CLOSING = 15000;
/** A monitoring system's ICMP probe is unanswered after this (fping's default timeout 500 ms). */
const PROBE_TIMEOUT = 500;
/** The ports a test uses when neither its target nor a relation names one: HTTP and DNS. */
export const DEFAULT_TCP_PORT = 80;
export const DEFAULT_UDP_PORT = 53;
/** The sizes of a test's request and answer (bytes of payload): a ping's 56, a small HTTP request, an answer of one full segment. */
export const PING_BYTES = 56;
const REQUEST_BYTES = 120;
const RESPONSE_BYTES = 1460;
const UDP_REQUEST = 40;
const UDP_RESPONSE = 200;

export type TestKind = 'icmp' | 'tcp' | 'udp';

/** A test: one ping, connection or UDP request, and how it ended. */
export interface Test {
  id: number;
  /** the status row it belongs to ("pc1 → web1 tcp/443") */
  series: string;
  from: string;
  /** what it was aimed at, as written ("web1", "10.0.0.255") */
  target: string;
  dst: IpAddr;
  kind: TestKind;
  port: number;
  size: number;
  df: boolean;
  keep: boolean;
  /** periodic test traffic, Send test…, a health check, a probe, a proxy's upstream */
  source: 'traffic' | 'manual' | 'health' | 'probe' | 'upstream';
  started: number;
  done: boolean;
  ok: boolean;
  result: string;
  /** answers so far (a broadcast ping can have several) */
  answers: string[];
  rtt?: number;
  /** the packet sent (an ICMP error quotes its id), for UDP and ICMP */
  pktIds: number[];
  /** the connection it opened (TCP) */
  conn?: Conn;
  /** a proxy's or load balancer's upstream: the client connection it serves */
  front?: Conn;
  /** health check / probe: who to tell */
  onDone?: (t: Test) => void;
  timeout: Resolved | { value: number };
}

/** A TCP connection end, or a UDP / ICMP socket waiting for an answer. */
interface Conn {
  key: string;
  dev: string;
  proto: 'tcp';
  local: IpAddr;
  lport: number;
  remote: IpAddr;
  rport: number;
  vrf: string;
  state: string;
  role: 'client' | 'server';
  since: number;
  /** the last segment heard */
  heard: number;
  /** the time its timer runs out (retransmission, TIME_WAIT, keepalive), null none */
  timer: number | null;
  tries: number;
  gen: number;
  what: string;
  test?: Test;
  /** at a load balancer / proxy: the upstream connection that serves this client connection, and back */
  upstream?: Conn;
  front?: Conn;
  /** the bytes received */
  got: number;
  /** what was sent and not yet acknowledged (for retransmission) */
  unacked: Array<{ flags: string[]; bytes: number; what: string }>;
  keep: boolean;
  /** keepalive probes sent without an answer */
  probes: number;
  /** a server: the request's arrival (answered after the service response time) */
  answered?: boolean;
}

interface FwSession {
  key: string;
  proto: 'tcp' | 'udp' | 'icmp';
  flow: string;
  state: string;
  created: number;
  last: number;
  rule: string;
  /** the timer key in effect ('fw-tcp', 'fw-half-open' …) */
  timeout: string;
}

interface Member {
  dev: string;
  addr: IpAddr;
  port: number;
  kind: TestKind;
  rel: string;
  up: boolean;
  fails: number;
  oks: number;
  last: string;
}

/** The transport of a profile ("TCP 443", "UDP 2055 / 4739", "IP 89"): its protocol and its ports. */
export function profileTransport(proto: string): { proto: 'tcp' | 'udp' | 'other'; ports: number[]; num: number } {
  const m = /\b(TCP|UDP)\s+([0-9]{1,5})((?:\s*\/\s*[0-9]{1,5})*)/.exec(proto);
  if (m) {
    const ports = [Number(m[2])];
    for (const x of (m[3] || '').split('/').map((y) => y.trim()).filter((y) => y)) ports.push(Number(x));
    return { proto: m[1] === 'TCP' ? 'tcp' : 'udp', ports, num: m[1] === 'TCP' ? 6 : 17 };
  }
  const ip = /\bIP(?: protocol)?\s+([0-9]{1,3})/.exec(proto);
  return { proto: 'other', ports: [], num: ip ? Number(ip[1]) : 0 };
}

export class Transport {
  readonly P: ProtocolSim;
  private seq = 0;
  private conns = new Map<string, Map<string, Conn>>();
  private nextPort = new Map<string, number>();
  private pmtu = new Map<string, Map<string, number>>();
  readonly tests: Test[] = [];
  private series = new Map<string, Test>();
  private fw = new Map<string, Map<string, FwSession>>();
  private pools = new Map<string, { members: Member[]; rr: number; sticky: Map<string, { member: string; at: number }> }>();
  private listenCache = new Map<string, PortRule[]>();

  constructor(P: ProtocolSim) {
    this.P = P;
  }

  private get e() {
    return this.P.e;
  }

  // ------------------------------------------------------------ installing

  install(): void {
    const P = this.P;
    P.handlers.set('icmp', (dev, l3, _msg, pkt) => {
      if (pkt && l3) this.icmpIn(dev, l3, pkt);
    });
    P.handlers.set('tcp', (dev, l3, _msg, pkt) => {
      if (pkt && l3) this.tcpIn(dev, l3, pkt);
    });
    P.handlers.set('udp', (dev, l3, _msg, pkt) => {
      if (pkt && l3) this.udpIn(dev, l3, pkt);
    });
    P.filterHook = (dev, pkt, from, to) => this.filter(dev, pkt, from, to);
    P.localErrorHook = (dev, pkt, kind, text, mtu) => this.localError(dev, pkt, kind, text, mtu);
    P.portHook = (dev, pkt, l3) => this.portOpen(dev, pkt, l3);
    P.sweepHooks.push(() => this.sweep());
    P.deviceHooks.push((dev, up) => {
      if (up) return;
      // powered off: its connections and sessions are gone
      this.conns.delete(dev);
      this.fw.delete(dev);
      this.pmtu.delete(dev);
    });
    P.bootHooks.push(() => {
      this.startTraffic();
      this.startHealthChecks();
      this.startProbes();
    });
    P.extraStatus.push(() => this.status());
  }

  // ------------------------------------------------------------ addresses and ports

  /** The address a device sends from towards a destination: the egress interface's (else its first of the family), and the VRF. */
  sourceFor(dev: string, dst: IpAddr): { src: IpAddr; vrf: string; l3: L3Iface | null } | null {
    const sd = this.P.sd(dev);
    if (!sd) return null;
    const ifs = Array.from(sd.l3.values()).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id));
    // a broadcast or a group: the first interface with an address of the family (a subnet broadcast: that subnet's)
    for (const l of ifs) {
      const a = l.addrs.find((x) => x.addr.version === dst.version && inNet(x, dst));
      if (a && l.kind !== 'loopback') return { src: a.addr, vrf: l.vrf, l3: l };
    }
    if (!isMulticastIp(dst) && !this.e.isBroadcastAddr(dst)) {
      for (const vrf of Array.from(new Set(ifs.map((l) => l.vrf))).sort(cmp)) {
        const d = lookup(this.P.m, dev, vrf, dst, this.e.ctx(dev));
        if (d.kind !== 'forward' || !d.hops.length) continue;
        const l = sd.l3.get(d.hops[0].iface);
        const a = l ? l.addrs.find((x) => x.addr.version === dst.version) : undefined;
        if (l && a) return { src: a.addr, vrf, l3: l };
      }
    }
    for (const l of ifs) {
      const a = l.addrs.find((x) => x.addr.version === dst.version);
      if (a && l.kind !== 'tunnel') return { src: a.addr, vrf: l.vrf, l3: l };
    }
    return null;
  }

  private ephemeral(dev: string): number {
    const n = this.nextPort.get(dev);
    const p = n !== undefined ? n : 49152 + (hashIndex(dev, 4000) as number);
    this.nextPort.set(dev, p >= 65535 ? 49152 : p + 1);
    return p;
  }

  /** The ports a device listens on: its `listening` attribute, else the ports of the relations it serves (a load balancer or proxy: also those it passes requests on to). */
  listening(dev: string): { rules: PortRule[]; written: boolean; text: string } {
    const own = this.e.params.deviceValue(dev, 'listening');
    if (own !== undefined) {
      const r = parsePorts(String(own) || 'none');
      return { rules: 'list' in r ? r.list : [], written: true, text: `listening ${String(own) || 'on nothing'} (device)` };
    }
    let rules = this.listenCache.get(dev);
    if (!rules) {
      rules = [];
      for (const r of this.P.m.relations) {
        const devs = relationDevices(r);
        if (devs.indexOf(dev) < 0) continue;
        const prof = relationProfile(this.P.m, r);
        const t = profileTransport(prof.proto);
        if (t.proto === 'other') continue;
        const type = this.P.sd(dev) ? this.P.sd(dev).dev.type : '';
        const relay = type === 'load_balancer' || type === 'proxy';
        const server = prof.behaviour === 'service' || prof.behaviour === 'custom' ? relay || (prof.fromServer ? devs.slice(0, -1).indexOf(dev) >= 0 : devs[devs.length - 1] === dev) : true;
        if (!server) continue;
        for (const p of t.ports) if (!rules.some((x) => x.proto === t.proto && x.from === p)) rules.push({ proto: t.proto, from: p, to: p });
      }
      rules.sort((a, b) => cmp(a.proto, b.proto) || a.from - b.from);
      this.listenCache.set(dev, rules);
    }
    return { rules, written: false, text: rules.length ? `listening on the ports of the relations it serves: ${rules.map((r) => r.proto + '/' + r.from).join(', ')}` : 'serving no relation: no port open' };
  }

  private open(dev: string, proto: 'tcp' | 'udp', port: number): boolean {
    return portsMatch(this.listening(dev).rules, proto, port);
  }

  /** A relation's message to a port the device does not listen on (its `listening` attribute leaves it out): refused like any other. */
  private portOpen(dev: string, pkt: Pkt, l3: L3Iface): boolean {
    const l4 = pkt.l4;
    if (!l4 || (l4.proto !== 'tcp' && l4.proto !== 'udp') || l4.dport === undefined || l4.dport >= 49152) return true;
    const ls = this.listening(dev);
    if (!ls.written || portsMatch(ls.rules, l4.proto, l4.dport)) return true;
    this.refuse(dev, l3, pkt, ls.text);
    return false;
  }

  /** A closed port: TCP RST (not to a RST), UDP ICMP port unreachable (not about a broadcast or multicast); nothing when the device does not reply to closed ports. */
  private refuse(dev: string, l3: L3Iface, pkt: Pkt, why: string): void {
    const l4 = pkt.l4 as L4;
    const cp = this.e.params.get('closed-port', dev);
    const what = `${l4.proto.toUpperCase()} port ${l4.dport} is closed on ${dev} (${why})`;
    if (cp.value !== 'on') {
      this.e.note('drop', l4.proto, dev, '', pkt.msg.type, '', `${what}: dropped without an answer (reply to closed ports ${resolvedText(cp)}): ${pkt.msg.label}`);
      return;
    }
    if (l4.proto === 'tcp') {
      if ((l4.flags || []).indexOf('RST') >= 0) return;
      this.e.note('drop', 'tcp', dev, '', pkt.msg.type, '', `${what}: it answers with a RST (${pkt.msg.label})`);
      this.segment(dev, { local: pkt.dst, lport: l4.dport as number, remote: pkt.src, rport: l4.sport as number, vrf: pkt.vrf }, ['RST', 'ACK'], 0, `refused: port ${l4.dport} is closed`, pkt.dst);
      return;
    }
    this.e.note('drop', 'udp', dev, '', pkt.msg.type, '', `${what}: ${isMulticastIp(pkt.dst) || this.e.isBroadcastAddr(pkt.dst) ? 'no ICMP error to a broadcast or multicast' : 'it answers with ICMP port unreachable'} (${pkt.msg.label})`);
    this.e.icmpError(dev, pkt, 'port', { from: l3 });
  }

  // ------------------------------------------------------------ path MTU

  private pathMtu(dev: string, dst: IpAddr): number | null {
    const m = this.pmtu.get(dev);
    const v = m ? m.get(formatAddr(dst)) : undefined;
    return v !== undefined ? v : null;
  }

  private learnMtu(dev: string, dst: IpAddr, mtu: number, how: string): void {
    let m = this.pmtu.get(dev);
    if (!m) {
      m = new Map();
      this.pmtu.set(dev, m);
    }
    const k = formatAddr(dst);
    const was = m.get(k);
    if (was !== undefined && was <= mtu) return;
    m.set(k, mtu);
    this.e.note('table', 'icmp', dev, '', 'path MTU', '', `${dev}: the path MTU to ${k} is ${mtu} bytes now (${how}); its next packets there fit (PMTUD)`);
  }

  // ------------------------------------------------------------ sending

  private msg(protocol: 'icmp' | 'tcp' | 'udp', type: string, label: string, detail: string, data: { [k: string]: unknown }): Msg {
    return { protocol, type, label, detail, data: { from: '', ...data } };
  }

  private sendPkt(dev: string, src: IpAddr, dst: IpAddr, vrf: string, m: Msg, l4: L4, len: number, df: boolean, peer: string): Pkt {
    (m.data as { from: string }).from = dev;
    const pkt = this.e.newPacket(src, dst, vrf, m);
    pkt.l4 = l4;
    pkt.len = len;
    pkt.df = df;
    pkt.flow = `${formatAddr(src)}:${l4.sport || l4.echoId || 0}>${formatAddr(dst)}:${l4.dport || 0}/${l4.proto}`;
    this.e.note('message', l4.proto, dev, peer, m.type, '', m.detail, this.e.now, m);
    // a group goes out of the interface it is sent from (a host sends it on its own segment)
    const out = isMulticastIp(dst) ? this.sourceFor(dev, dst) : null;
    this.e.send(dev, pkt, out && out.l3 ? out.l3 : undefined);
    return pkt;
  }

  /** A TCP segment from a connection's end (or a RST for a closed port: `src` its address). */
  private segment(dev: string, c: { local: IpAddr; lport: number; remote: IpAddr; rport: number; vrf: string }, flags: string[], bytes: number, what: string, src?: IpAddr, conn?: Conn): Pkt {
    const to = `${formatAddr(c.remote)}:${c.rport}`;
    const f = flags.join(',');
    const type = f === 'SYN' ? 'TCP SYN' : f === 'SYN,ACK' ? 'TCP SYN-ACK' : flags.indexOf('RST') >= 0 ? 'TCP RST' : flags.indexOf('FIN') >= 0 ? 'TCP FIN' : bytes > 0 ? 'TCP data' : what === 'keepalive' ? 'TCP keepalive' : 'TCP ACK';
    const label = type === 'TCP SYN' ? `TCP SYN → ${to}` : type === 'TCP data' ? `TCP data → ${to} (${bytes} B)` : type;
    const peer = this.e.ownerOf(c.remote) || '';
    const m = this.msg('tcp', type, label, `TCP ${formatAddr(src || c.local)}:${c.lport} → ${to} [${f}]${bytes ? ' ' + bytes + ' bytes' : ''}: ${what}`, {});
    const seq = conn ? conn.got + 1000 : 0;
    const l4: L4 = { proto: 'tcp', num: 6, sport: c.lport, dport: c.rport, flags, seq, ack: flags.indexOf('ACK') >= 0 ? seq + 1 : undefined };
    return this.sendPkt(dev, src || c.local, c.remote, c.vrf, m, l4, 20 + bytes, true, peer);
  }

  // ------------------------------------------------------------ tests

  /** A device's tests run against a target: its address and the test (a target's own, else the test type in effect). */
  resolveTarget(dev: string, t: Target, kind: TestKind): { dst: IpAddr; kind: TestKind; port: number; label: string } | string {
    let dst: IpAddr | null = parseAddress(t.to);
    let label = t.to;
    if (!dst) {
      const i = t.to.indexOf(':');
      const d = i >= 0 ? t.to.slice(0, i) : t.to;
      const iface = i >= 0 ? t.to.slice(i + 1) : undefined;
      const sd = this.P.sd(d);
      if (!sd) return `${t.to} is neither a device of the model nor an address`;
      const src = this.sourceFor(dev, parseAddress('0.0.0.0') as IpAddr);
      const want = src ? src.src.version : 4;
      const ls = Array.from(sd.l3.values()).filter((l) => (iface ? l.id === iface : l.kind !== 'tunnel')).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id));
      for (const l of ls) for (const a of l.addrs) if (!dst && a.addr.version === want) dst = a.addr;
      for (const l of ls) for (const a of l.addrs) if (!dst) dst = a.addr;
      if (!dst) return `${t.to} has no address`;
      label = t.to;
    }
    const k = t.test ? (t.test.proto as TestKind) : kind;
    const port = t.test && t.test.proto !== 'icmp' ? t.test.from : k === 'tcp' ? DEFAULT_TCP_PORT : k === 'udp' ? DEFAULT_UDP_PORT : 0;
    return { dst, kind: k, port, label };
  }

  /** Run one test now (Send test…, test traffic, a health check, a probe); its result comes later. */
  run(o: { from: string; target: string; dst: IpAddr; kind: TestKind; port?: number; size?: number; df?: boolean; keep?: boolean; source: Test['source']; series?: string; onDone?: (t: Test) => void; front?: Conn; timeout?: Resolved | { value: number } }): Test | string {
    const dev = o.from;
    if (!this.P.sd(dev)) return `${dev} is not a device of the simulation`;
    if (!this.e.deviceOn(dev)) return `${dev} is powered off`;
    const s = this.sourceFor(dev, o.dst);
    if (!s) return `${dev} has no IPv${o.dst.version} address to send from`;
    const kind = o.kind;
    const port = kind === 'icmp' ? 0 : o.port || (kind === 'tcp' ? DEFAULT_TCP_PORT : DEFAULT_UDP_PORT);
    const series = o.series || `${dev} → ${o.target} ${kind === 'icmp' ? 'ICMP echo' : kind + '/' + port}`;
    const t: Test = {
      id: ++this.seq,
      series,
      from: dev,
      target: o.target,
      dst: o.dst,
      kind,
      port,
      size: o.size !== undefined ? o.size : kind === 'icmp' ? PING_BYTES : kind === 'tcp' ? REQUEST_BYTES : UDP_REQUEST,
      df: o.df !== undefined ? o.df : kind === 'tcp',
      keep: !!o.keep,
      source: o.source,
      started: this.e.now,
      done: false,
      ok: false,
      result: 'waiting',
      answers: [],
      pktIds: [],
      onDone: o.onDone,
      front: o.front,
      timeout: o.timeout || this.e.params.get('app-timeout', dev),
    };
    this.tests.push(t);
    if (this.tests.length > 400) this.tests.splice(0, this.tests.length - 400);
    if (o.source !== 'health' && o.source !== 'probe' && o.source !== 'upstream') this.series.set(series, t);
    const bcast = this.e.isBroadcastAddr(o.dst) || isMulticastIp(o.dst);
    if (kind === 'tcp' && bcast) {
      this.finish(t, false, 'not sent: TCP connects to one host, never to a broadcast or multicast address');
      return t;
    }
    // the application gives up after its response timeout (a broadcast ping collects the answers until then)
    this.e.after(Number(t.timeout.value), () => {
      if (t.done) return;
      if (t.answers.length) this.finish(t, true, `${t.answers.length} answer${t.answers.length === 1 ? '' : 's'}: ${t.answers.join(', ')}`);
      else this.finish(t, false, `no answer within ${'def' in t.timeout ? resolvedText(t.timeout as Resolved) : durationText(Number(t.timeout.value))} (timed out)`);
    });
    if (kind === 'icmp') this.ping(t, s.src, s.vrf);
    else if (kind === 'udp') this.udpRequest(t, s.src, s.vrf);
    else this.connect(t, s.src, s.vrf);
    return t;
  }

  private finish(t: Test, ok: boolean, result: string): void {
    if (t.done) return;
    t.done = true;
    t.ok = ok;
    t.result = result;
    if (ok && t.rtt === undefined) t.rtt = this.e.now - t.started;
    if (t.source !== 'health' && t.source !== 'probe' && t.source !== 'upstream') this.e.note('state', t.kind, t.from, '', ok ? 'Test answered' : 'Test failed', ok ? 'answered' : 'failed', `Test ${t.series}: ${result}${ok && t.rtt !== undefined ? ` (round trip ${rttText(t.rtt)})` : ''}`);
    if (t.onDone) t.onDone(t);
  }

  // ------------------------------------------------------------ ICMP

  private ping(t: Test, src: IpAddr, vrf: string): void {
    const pm = this.pathMtu(t.from, t.dst);
    const v = t.dst.version;
    const name = v === 4 ? 'ICMP' : 'ICMPv6';
    const m = this.msg('icmp', 'Echo Request', `${name} Echo → ${formatAddr(t.dst)}`, `${name} Echo Request from ${formatAddr(src)} to ${formatAddr(t.dst)}, id ${t.id}, seq 1, ${t.size} bytes of data${t.df ? ', DF' : ''}${pm ? ' (path MTU ' + pm + ')' : ''}`, { test: t.id });
    const l4: L4 = { proto: 'icmp', num: v === 4 ? 1 : 58, icmpType: v === 4 ? 8 : 128, icmpCode: 0, icmpName: 'Echo Request', echoId: t.id, echoSeq: 1 };
    const p = this.sendPkt(t.from, src, t.dst, vrf, m, l4, 8 + t.size, t.df, this.e.ownerOf(t.dst) || '');
    t.pktIds.push(p.id);
  }

  private icmpIn(dev: string, l3: L3Iface, pkt: Pkt): void {
    const l4 = pkt.l4;
    if (!l4 || l4.proto !== 'icmp') return;
    const v = pkt.dst.version;
    if (l4.icmpType === (v === 4 ? 8 : 128)) {
      // an echo request: answered unless pings are off (to a broadcast: only when broadcast pings are answered)
      const bc = this.e.isBroadcastAddr(pkt.dst) || isMulticastIp(pkt.dst);
      const r = this.e.params.get(bc ? 'bcast-ping' : 'ping', dev);
      if (r.value !== 'on') {
        this.e.note('drop', 'icmp', dev, '', 'Echo Request', '', `${dev} does not answer ${pkt.msg.label} from ${formatAddr(pkt.src)} (${r.def.label.toLowerCase()} ${resolvedText(r)})`);
        return;
      }
      const own = bc ? l3.addrs.find((a) => a.addr.version === v) : undefined;
      const src = own ? own.addr : pkt.dst;
      const name = v === 4 ? 'ICMP' : 'ICMPv6';
      const m = this.msg('icmp', 'Echo Reply', `${name} Echo Reply from ${formatAddr(src)}`, `${name} Echo Reply from ${formatAddr(src)} to ${formatAddr(pkt.src)}, id ${l4.echoId}, seq ${l4.echoSeq}`, { test: (pkt.msg.data as { test?: number }).test });
      const back: L4 = { proto: 'icmp', num: l4.num, icmpType: v === 4 ? 0 : 129, icmpCode: 0, icmpName: 'Echo Reply', echoId: l4.echoId, echoSeq: l4.echoSeq };
      // the service response time of a server
      void this.sendPkt(dev, src, pkt.src, pkt.vrf, m, back, pkt.len || 64, false, this.e.ownerOf(pkt.src) || '');
      return;
    }
    if (l4.icmpType === (v === 4 ? 0 : 129)) {
      const t = this.tests.find((x) => x.id === l4.echoId && x.from === dev && x.kind === 'icmp');
      if (!t || t.done) return;
      const bc = this.e.isBroadcastAddr(t.dst) || isMulticastIp(t.dst);
      t.answers.push(`${formatAddr(pkt.src)}${this.e.ownerOf(pkt.src) ? ' (' + this.e.ownerOf(pkt.src) + ')' : ''}`);
      if (t.rtt === undefined) t.rtt = this.e.now - t.started;
      if (!bc) this.finish(t, true, `Echo Reply from ${formatAddr(pkt.src)}`);
      return;
    }
    // an ICMP error about something this device sent
    if (l4.quote) this.icmpError(dev, pkt);
  }

  /** An ICMP error reached the sender of the packet it quotes: the test or connection it is about ends; PMTUD learns the MTU. */
  private icmpError(dev: string, pkt: Pkt): void {
    const l4 = pkt.l4 as L4;
    const q = l4.quote as NonNullable<L4['quote']>;
    const from = `${formatAddr(pkt.src)}${this.e.ownerOf(pkt.src) ? ' (' + this.e.ownerOf(pkt.src) + ')' : ''}`;
    const what = `${pkt.msg.type} from ${from}`;
    const dst = parseAddress(q.dst);
    if (l4.mtu && dst) {
      this.learnMtu(dev, dst, l4.mtu, `${what}`);
      // a TCP connection sends what is not acknowledged again, in smaller segments
      const c = this.connByFlow(dev, q);
      if (c && c.unacked.length) this.retransmit(c, true);
      const t = this.tests.find((x) => !x.done && x.from === dev && x.pktIds.indexOf(q.pkt) >= 0);
      if (t && t.kind !== 'tcp') this.finish(t, false, `${what}: ${t.df ? 'the packet is too big for the path and DF is set' : 'too big'} (path MTU ${l4.mtu})`);
      return;
    }
    const t = this.tests.find((x) => !x.done && x.from === dev && x.pktIds.indexOf(q.pkt) >= 0);
    if (t) {
      this.finish(t, false, what);
      return;
    }
    const c = this.connByFlow(dev, q);
    if (c && (c.state === 'SYN_SENT' || c.state === 'SYN_RCVD')) {
      // a hard error while connecting ends the attempt (Linux: tcp_v4_err)
      this.closeConn(c, `connection failed: ${what}`);
      if (c.test) this.finish(c.test, false, what);
      return;
    }
    this.e.note('message', 'icmp', dev, '', pkt.msg.type, '', `${dev} received ${pkt.msg.label} about ${q.src} → ${q.dst}`);
  }

  /** A packet a device sent itself could not go: its test or connection fails at once (no ICMP on the wire). */
  private localError(dev: string, pkt: Pkt, kind: IcmpKind, text: string, mtu?: number): void {
    const t = this.tests.find((x) => !x.done && x.from === dev && x.pktIds.indexOf(pkt.id) >= 0);
    if (kind === 'frag' && mtu) this.learnMtu(dev, pkt.dst, mtu, `its own interface: ${text}`);
    if (t) {
      this.finish(t, false, `not sent: ${text}`);
      return;
    }
    const l4 = pkt.l4;
    if (!l4 || l4.proto !== 'tcp') return;
    const c = this.conn(dev, pkt.src, l4.sport as number, pkt.dst, l4.dport as number);
    if (!c) return;
    if (kind === 'frag') {
      this.retransmit(c, true);
      return;
    }
    if (c.state === 'SYN_SENT') {
      this.closeConn(c, `connection failed: ${text}`);
      if (c.test) this.finish(c.test, false, text);
    }
  }

  // ------------------------------------------------------------ UDP

  private udpRequest(t: Test, src: IpAddr, vrf: string): void {
    const sport = this.ephemeral(t.from);
    const to = `${formatAddr(t.dst)}:${t.port}`;
    const m = this.msg('udp', 'UDP request', `UDP → ${to}`, `UDP ${formatAddr(src)}:${sport} → ${to}, ${t.size} bytes (test ${t.series})`, { test: t.id });
    const p = this.sendPkt(t.from, src, t.dst, vrf, m, { proto: 'udp', num: 17, sport, dport: t.port }, 8 + t.size, t.df, this.e.ownerOf(t.dst) || '');
    t.pktIds.push(p.id);
  }

  private udpIn(dev: string, l3: L3Iface, pkt: Pkt): void {
    const l4 = pkt.l4;
    if (!l4 || l4.proto !== 'udp') return;
    const d = (pkt.msg.data || {}) as { test?: number; reply?: boolean };
    if (d.reply) {
      const t = this.tests.find((x) => x.id === d.test && x.from === dev);
      if (!t || t.done) return;
      t.answers.push(`${formatAddr(pkt.src)}${this.e.ownerOf(pkt.src) ? ' (' + this.e.ownerOf(pkt.src) + ')' : ''}`);
      if (!this.e.isBroadcastAddr(t.dst) && !isMulticastIp(t.dst)) this.finish(t, true, `UDP answer from ${formatAddr(pkt.src)}:${l4.sport}`);
      return;
    }
    if (!this.open(dev, 'udp', l4.dport as number)) {
      this.refuse(dev, l3, pkt, this.listening(dev).text);
      return;
    }
    const own = this.e.isBroadcastAddr(pkt.dst) || isMulticastIp(pkt.dst) ? l3.addrs.find((a) => a.addr.version === pkt.dst.version) : undefined;
    const src = own ? own.addr : pkt.dst;
    const rt = this.e.params.get('service-response', dev);
    const answer = (): void => {
      const m = this.msg('udp', 'UDP answer', `UDP ← ${formatAddr(src)}:${l4.dport}`, `UDP ${formatAddr(src)}:${l4.dport} → ${formatAddr(pkt.src)}:${l4.sport}, ${UDP_RESPONSE} bytes: the answer${Number(rt.value) > 0 ? ' after the service response time ' + resolvedText(rt) : ''}`, { test: d.test, reply: true });
      this.sendPkt(dev, src, pkt.src, pkt.vrf, m, { proto: 'udp', num: 17, sport: l4.dport, dport: l4.sport }, 8 + UDP_RESPONSE, false, this.e.ownerOf(pkt.src) || '');
    };
    if (Number(rt.value) > 0) this.e.after(Number(rt.value), answer);
    else answer();
  }

  // ------------------------------------------------------------ TCP

  private connKey(local: IpAddr, lport: number, remote: IpAddr, rport: number): string {
    return `${formatAddr(local)}:${lport}>${formatAddr(remote)}:${rport}`;
  }

  private conn(dev: string, local: IpAddr, lport: number, remote: IpAddr, rport: number): Conn | undefined {
    const m = this.conns.get(dev);
    return m ? m.get(this.connKey(local, lport, remote, rport)) : undefined;
  }

  private connByFlow(dev: string, q: NonNullable<L4['quote']>): Conn | undefined {
    const m = this.conns.get(dev);
    if (!m || q.sport === undefined || q.dport === undefined) return undefined;
    const a = parseAddress(q.src);
    const b = parseAddress(q.dst);
    return a && b ? m.get(this.connKey(a, q.sport, b, q.dport)) : undefined;
  }

  private addConn(c: Conn): void {
    let m = this.conns.get(c.dev);
    if (!m) {
      m = new Map();
      this.conns.set(c.dev, m);
    }
    m.set(c.key, c);
  }

  private setState(c: Conn, state: string): void {
    c.state = state;
    c.since = this.e.now;
  }

  /** Open a connection for a test: SYN, retransmitted with backoff until answered or the SYN retries are spent. */
  private connect(t: Test, src: IpAddr, vrf: string): void {
    const lport = this.ephemeral(t.from);
    const c: Conn = { key: this.connKey(src, lport, t.dst, t.port), dev: t.from, proto: 'tcp', local: src, lport, remote: t.dst, rport: t.port, vrf, state: 'SYN_SENT', role: 'client', since: this.e.now, heard: this.e.now, timer: null, tries: 0, gen: 0, what: t.source === 'upstream' ? `upstream for ${t.series}` : t.source === 'health' ? 'health check' : `test ${t.series}`, test: t, got: 0, unacked: [], keep: t.keep, probes: 0 };
    t.conn = c;
    this.addConn(c);
    this.sendSyn(c);
  }

  private rto(c: Conn): number {
    return Math.min(RTO_MAX, this.e.params.num('tcp-rto', c.dev) * Math.pow(2, c.tries));
  }

  private sendSyn(c: Conn): void {
    const p = this.segment(c.dev, c, ['SYN'], 0, c.tries ? `retransmission ${c.tries} (timeout ${durationText(this.rto({ ...c, tries: c.tries - 1 }))})` : `opens a connection (${c.what})`, undefined, c);
    if (c.test) c.test.pktIds.push(p.id);
    const g = ++c.gen;
    const wait = this.rto(c);
    c.timer = this.e.now + wait;
    this.e.after(wait, () => {
      if (c.gen !== g || c.state !== 'SYN_SENT') return;
      const max = this.e.params.get('tcp-syn-retries', c.dev);
      if (c.tries >= Number(max.value)) {
        this.closeConn(c, `connection timed out: no answer to the SYN and its ${c.tries} retransmissions (TCP SYN retries ${resolvedText(max)})`);
        if (c.test) this.finish(c.test, false, `TCP connect timed out after ${c.tries} retransmissions`);
        return;
      }
      c.tries++;
      this.sendSyn(c);
    });
  }

  /** Send data (split into segments that fit the path MTU) and wait for its acknowledgement. */
  private sendData(c: Conn, bytes: number, what: string): void {
    const mss = this.mss(c);
    c.unacked = [];
    for (let left = bytes; left > 0; left -= mss) c.unacked.push({ flags: left <= mss ? ['PSH', 'ACK'] : ['ACK'], bytes: Math.min(mss, left), what });
    c.tries = 0;
    this.retransmit(c, false);
  }

  private mss(c: Conn): number {
    const pm = this.pathMtu(c.dev, c.remote);
    const l3 = this.sourceFor(c.dev, c.remote);
    const own = l3 && l3.l3 ? Number(this.e.mtu(c.dev, l3.l3).value) : 1500;
    const mtu = Math.min(own, pm || own);
    return Math.max(8, mtu - (c.remote.version === 4 ? 40 : 60));
  }

  /** (Re)send what is unacknowledged; again after the retransmission timeout, doubling, until acknowledged or the retries are spent. */
  private retransmit(c: Conn, resize: boolean): void {
    if (!c.unacked.length) return;
    if (resize) {
      // smaller segments for a smaller path MTU
      const total = c.unacked.reduce((n, s) => n + s.bytes, 0);
      const what = c.unacked[0].what;
      c.unacked = [];
      const mss = this.mss(c);
      for (let left = total; left > 0; left -= mss) c.unacked.push({ flags: left <= mss ? ['PSH', 'ACK'] : ['ACK'], bytes: Math.min(mss, left), what });
    }
    const n = c.unacked.length;
    c.unacked.forEach((s, i) => this.segment(c.dev, c, s.flags, s.bytes, `${s.what}${n > 1 ? ` (segment ${i + 1} of ${n})` : ''}${c.tries ? `, retransmission ${c.tries}` : ''}`, undefined, c));
    const g = ++c.gen;
    const wait = this.rto(c);
    c.timer = this.e.now + wait;
    this.e.after(wait, () => {
      if (c.gen !== g || !c.unacked.length) return;
      if (c.tries >= DATA_RETRIES) {
        this.closeConn(c, `reset: no acknowledgement after ${c.tries} retransmissions`);
        if (c.test) this.finish(c.test, false, 'connection lost: the data was never acknowledged');
        return;
      }
      c.tries++;
      this.retransmit(c, false);
    });
  }

  private closeConn(c: Conn, why: string): void {
    const m = this.conns.get(c.dev);
    if (m && m.get(c.key) === c) m.delete(c.key);
    c.gen++;
    c.timer = null;
    this.e.note('table', 'tcp', c.dev, this.e.ownerOf(c.remote) || '', 'connection closed', 'CLOSED', `${c.dev} ${formatAddr(c.local)}:${c.lport} ↔ ${formatAddr(c.remote)}:${c.rport} (${c.what}): ${why}`);
    // a proxy's two sides go together
    const other = c.upstream || c.front;
    if (other) {
      c.upstream = c.front = undefined;
      if (other.front === c) other.front = undefined;
      if (other.upstream === c) other.upstream = undefined;
    }
  }

  private tcpIn(dev: string, l3: L3Iface, pkt: Pkt): void {
    const l4 = pkt.l4 as L4;
    const flags = l4.flags || [];
    const has = (f: string): boolean => flags.indexOf(f) >= 0;
    const c = this.conn(dev, pkt.dst, l4.dport as number, pkt.src, l4.sport as number);
    const bytes = (pkt.len || 20) - 20;
    if (!c) {
      if (has('RST')) return;
      if (has('SYN') && !has('ACK')) {
        if (!this.open(dev, 'tcp', l4.dport as number)) {
          this.refuse(dev, l3, pkt, this.listening(dev).text);
          return;
        }
        const sc: Conn = { key: this.connKey(pkt.dst, l4.dport as number, pkt.src, l4.sport as number), dev, proto: 'tcp', local: pkt.dst, lport: l4.dport as number, remote: pkt.src, rport: l4.sport as number, vrf: pkt.vrf, state: 'SYN_RCVD', role: 'server', since: this.e.now, heard: this.e.now, timer: null, tries: 0, gen: 0, what: `serves ${formatAddr(pkt.src)}`, got: 0, unacked: [], keep: false, probes: 0 };
        this.addConn(sc);
        this.segment(dev, sc, ['SYN', 'ACK'], 0, 'accepts the connection', undefined, sc);
        this.idle(sc);
        return;
      }
      // a segment of no connection it knows
      this.e.note('drop', 'tcp', dev, '', pkt.msg.type, '', `${dev} has no connection ${formatAddr(pkt.dst)}:${l4.dport} ↔ ${formatAddr(pkt.src)}:${l4.sport}: it answers with a RST (${pkt.msg.label})`);
      this.segment(dev, { local: pkt.dst, lport: l4.dport as number, remote: pkt.src, rport: l4.sport as number, vrf: pkt.vrf }, ['RST'], 0, 'no such connection');
      return;
    }
    c.heard = this.e.now;
    c.probes = 0;
    if (has('RST')) {
      const was = c.state;
      this.closeConn(c, was === 'SYN_SENT' ? `connection refused (RST from ${formatAddr(pkt.src)})` : `reset by ${formatAddr(pkt.src)}`);
      if (c.test) this.finish(c.test, false, was === 'SYN_SENT' ? `connection refused: RST from ${formatAddr(pkt.src)}${this.e.ownerOf(pkt.src) ? ' (' + this.e.ownerOf(pkt.src) + ')' : ''}` : 'connection reset');
      if (c.front) this.upstreamFailed(c, 'the server reset the connection');
      return;
    }
    if (c.state === 'SYN_SENT') {
      if (!has('SYN') || !has('ACK')) return;
      this.setState(c, 'ESTABLISHED');
      c.tries = 0;
      c.gen++;
      this.e.note('table', 'tcp', dev, this.e.ownerOf(c.remote) || '', 'connection established', 'ESTABLISHED', `${dev} ${formatAddr(c.local)}:${c.lport} → ${formatAddr(c.remote)}:${c.rport} established (${c.what})`);
      const t = c.test;
      if (t && t.source === 'health') {
        // a TCP health check: the handshake is the answer; closed again with a RST
        this.segment(dev, c, ['RST', 'ACK'], 0, 'health check done: closes at once', undefined, c);
        this.closeConn(c, 'health check done');
        this.finish(t, true, 'the handshake completed');
        return;
      }
      this.segment(dev, c, ['ACK'], 0, 'the connection is open', undefined, c);
      if (t && t.keep && t.source === 'manual') {
        this.finish(t, true, `connected; kept open (keepalive after ${resolvedText(this.e.params.get('tcp-keepalive', dev))})`);
        this.idle(c);
        return;
      }
      this.sendData(c, t ? t.size : REQUEST_BYTES, t && t.source === 'upstream' ? 'the request, passed on' : 'the request');
      return;
    }
    if (c.state === 'SYN_RCVD') {
      if (!has('ACK') || has('SYN')) return;
      this.setState(c, 'ESTABLISHED');
      this.idle(c);
    }
    switch (c.state) {
      case 'ESTABLISHED':
        if (has('FIN')) {
          // the peer closes: acknowledge and close our side (FIN and ACK in one segment)
          this.setState(c, 'LAST_ACK');
          this.segment(dev, c, ['FIN', 'ACK'], 0, 'closes its side as well', undefined, c);
          const g = ++c.gen;
          this.e.after(this.rto({ ...c, tries: 0 }) * 4, () => {
            if (c.gen === g && c.state === 'LAST_ACK') this.closeConn(c, 'closed (the last ACK did not come)');
          });
          return;
        }
        if (bytes > 0 && c.role === 'server') {
          this.serverData(c, bytes, pkt);
          return;
        }
        this.clientAck(c, pkt);
        return;
      case 'TIME_WAIT':
        if (bytes > 0 || has('FIN')) this.segment(dev, c, ['ACK'], 0, 'acknowledges again', undefined, c);
        return;
      case 'FIN_WAIT_1':
        if (bytes > 0 && !has('FIN')) this.segment(dev, c, ['ACK'], 0, 'acknowledges again', undefined, c);
        if (has('FIN')) {
          this.segment(dev, c, ['ACK'], 0, 'acknowledges the close', undefined, c);
          this.setState(c, 'TIME_WAIT');
          const g = ++c.gen;
          c.timer = this.e.now + TIME_WAIT;
          this.e.after(TIME_WAIT, () => {
            if (c.gen === g) this.closeConn(c, `TIME_WAIT over (${durationText(TIME_WAIT)})`);
          });
        }
        return;
      case 'LAST_ACK':
        if (has('ACK')) this.closeConn(c, 'closed');
        return;
    }
  }

  /** The client: data from the server (the response), or an acknowledgement. */
  private clientAck(c: Conn, pkt: Pkt): void {
    const bytes = (pkt.len || 20) - 20;
    if (c.unacked.length) {
      c.unacked = [];
      c.tries = 0;
      c.gen++;
      c.timer = null;
    }
    if (bytes <= 0) {
      // a keepalive's answer
      if (c.keep) this.idle(c);
      return;
    }
    c.got += bytes;
    // the answer is complete with its last segment (PSH)
    if (c.role === 'client' && (pkt.l4 as L4).flags && ((pkt.l4 as L4).flags as string[]).indexOf('PSH') >= 0) {
      this.segment(c.dev, c, ['ACK'], 0, `acknowledges the answer (${c.got} bytes)`, undefined, c);
      const t = c.test;
      if (c.front) {
        // an upstream connection: the answer goes back to the client
        const front = c.front;
        this.e.note('message', 'tcp', c.dev, this.e.ownerOf(front.remote) || '', 'relayed', '', `${c.dev} passes the answer of ${formatAddr(c.remote)}:${c.rport} back to ${formatAddr(front.remote)}:${front.rport}`);
        this.sendData(front, c.got, `the answer of ${formatAddr(c.remote)}`);
        this.idle(front);
      }
      if (t) this.finish(t, true, `connected and answered (${c.got} bytes)`);
      if (c.keep && t && t.source === 'manual') {
        this.idle(c);
        return;
      }
      // the client closes
      this.setState(c, 'FIN_WAIT_1');
      this.segment(c.dev, c, ['FIN', 'ACK'], 0, 'closes the connection', undefined, c);
      const g = ++c.gen;
      this.e.after(this.rto({ ...c, tries: 0 }) * 4, () => {
        if (c.gen === g && c.state === 'FIN_WAIT_1') this.closeConn(c, 'closed (no answer to the FIN)');
      });
      return;
    }
  }

  /** The server end got the request: it answers after its service response time; a load balancer or proxy passes it on. */
  private serverData(c: Conn, bytes: number, pkt: Pkt): void {
    c.got += bytes;
    this.segment(c.dev, c, ['ACK'], 0, `acknowledges ${bytes} bytes`, undefined, c);
    this.idle(c);
    if (c.answered) return;
    c.answered = true;
    const type = this.P.sd(c.dev).dev.type;
    if ((type === 'load_balancer' || type === 'proxy') && !c.upstream) {
      this.proxy(c, pkt);
      return;
    }
    const rt = this.e.params.get('service-response', c.dev);
    const answer = (): void => {
      if (c.state !== 'ESTABLISHED') return;
      this.sendData(c, RESPONSE_BYTES, `the answer${Number(rt.value) > 0 ? ' after the service response time ' + resolvedText(rt) : ''}`);
    };
    if (Number(rt.value) > 0) this.e.after(Number(rt.value), answer);
    else answer();
  }

  /** Keepalive (a connection kept open) and the proxy's client timeout: the idle timers of an open connection. */
  private idle(c: Conn): void {
    const g = ++c.gen;
    const type = this.P.sd(c.dev).dev.type;
    if (c.role === 'server' && type === 'proxy') {
      const ct = this.e.params.get('proxy-client', c.dev);
      c.timer = this.e.now + Number(ct.value);
      this.e.after(Number(ct.value), () => {
        if (c.gen !== g || (c.state !== 'ESTABLISHED' && c.state !== 'SYN_RCVD')) return;
        this.e.note('state', 'tcp', c.dev, this.e.ownerOf(c.remote) || '', 'client timeout', '', `${c.dev} closes the idle client connection from ${formatAddr(c.remote)}:${c.rport} after its client connection timeout ${resolvedText(ct)}`);
        this.setState(c, 'FIN_WAIT_1');
        this.segment(c.dev, c, ['FIN', 'ACK'], 0, 'client connection timeout', undefined, c);
      });
      return;
    }
    if (!c.keep) {
      c.timer = null;
      return;
    }
    const ka = this.e.params.get('tcp-keepalive', c.dev);
    const at = c.probes ? KA_INTERVAL : Number(ka.value);
    c.timer = this.e.now + at;
    this.e.after(at, () => {
      if (c.gen !== g || c.state !== 'ESTABLISHED') return;
      if (c.probes >= KA_PROBES) {
        this.segment(c.dev, c, ['RST'], 0, 'keepalive: the peer is gone', undefined, c);
        this.closeConn(c, `reset: none of ${KA_PROBES} keepalive probes answered`);
        return;
      }
      c.probes++;
      this.segment(c.dev, c, ['ACK'], 0, 'keepalive', undefined, c);
      this.e.note('table', 'tcp', c.dev, '', 'keepalive', '', `${c.dev} probes the idle connection to ${formatAddr(c.remote)}:${c.rport} (probe ${c.probes} of ${KA_PROBES}; keepalive time ${resolvedText(ka)}, then every ${durationText(KA_INTERVAL)})`);
      const probes = c.probes;
      c.gen++;
      this.idle(c);
      c.probes = probes;
    });
  }

  // ------------------------------------------------------------ load balancers and proxies

  /** The servers of a device's own service relations (it is the client): a load balancer's pool, a proxy's upstream. */
  private upstreams(dev: string): Member[] {
    const out: Member[] = [];
    for (const r of this.P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
      const devs = relationDevices(r);
      if (devs.length < 2 || devs[devs.length - 1] === dev || devs.indexOf(dev) < 0) continue;
      const prof = relationProfile(this.P.m, r);
      if (prof.behaviour !== 'service' && prof.behaviour !== 'custom') continue;
      const server = devs[devs.length - 1];
      const t = profileTransport(prof.proto);
      const a = this.firstAddr(server, r);
      if (!a) continue;
      out.push({ dev: server, addr: a, port: t.ports[0] || DEFAULT_TCP_PORT, kind: t.proto === 'udp' ? 'udp' : 'tcp', rel: r.id, up: true, fails: 0, oks: 0, last: 'not checked yet' });
    }
    return out;
  }

  private firstAddr(dev: string, r?: Relation): IpAddr | null {
    const sd = this.P.sd(dev);
    if (!sd) return null;
    const ep = r ? r.endpoints.find((x) => x.device === dev && x.iface) : undefined;
    const ls = Array.from(sd.l3.values()).filter((l) => (ep ? l.id === ep.iface : l.kind !== 'tunnel')).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id));
    for (const l of ls) for (const a of l.addrs) if (a.addr.version === 4) return a.addr;
    for (const l of ls) for (const a of l.addrs) return a.addr;
    return null;
  }

  private pool(dev: string): { members: Member[]; rr: number; sticky: Map<string, { member: string; at: number }> } {
    let p = this.pools.get(dev);
    if (!p) {
      p = { members: this.upstreams(dev), rr: 0, sticky: new Map() };
      this.pools.set(dev, p);
    }
    return p;
  }

  /** A client's request at a load balancer or proxy: on to a member (or the proxy's upstream) over a connection of its own. */
  private proxy(front: Conn, pkt: Pkt): void {
    const dev = front.dev;
    const type = this.P.sd(dev).dev.type;
    const p = this.pool(dev);
    let m: Member | undefined;
    let why = '';
    if (type === 'load_balancer') {
      const healthy = p.members.filter((x) => x.up);
      const client = formatAddr(front.remote);
      const per = this.e.params.get('lb-persistence', dev);
      const st = p.sticky.get(client);
      if (st && Number(per.value) > 0 && this.e.now - st.at <= Number(per.value)) {
        m = healthy.find((x) => x.dev === st.member);
        if (m) why = `persistence: ${client} stays with ${m.dev} (persistence timeout ${resolvedText(per)})`;
      }
      if (!m && healthy.length) {
        const alg = this.e.params.get('lb-algorithm', dev);
        if (alg.value === 'least-connections') {
          const count = (x: Member): number => Array.from((this.conns.get(dev) || new Map<string, Conn>()).values()).filter((c) => c.role === 'client' && compareAddr(c.remote, x.addr) === 0).length;
          m = healthy.slice().sort((a, b) => count(a) - count(b) || cmp(a.dev, b.dev))[0];
        } else if (alg.value === 'source-hash') m = healthy[hashIndex(client, healthy.length)];
        else m = healthy[p.rr++ % healthy.length];
        why = `${m.dev} chosen by ${resolvedText(alg)} among ${healthy.length} healthy member${healthy.length === 1 ? '' : 's'}`;
      }
      if (m && Number(per.value) > 0) p.sticky.set(client, { member: m.dev, at: this.e.now });
    } else {
      m = p.members[0];
      why = m ? `its upstream ${m.dev} (relation ${m.rel})` : '';
    }
    if (!m) {
      this.e.note('drop', 'tcp', dev, '', 'no upstream', '', `${dev} has no ${type === 'load_balancer' ? 'healthy pool member' : 'upstream server (a service relation of its own)'} for the request of ${formatAddr(front.remote)}: it answers with an error`);
      this.sendData(front, 200, type === 'load_balancer' ? 'an error: 503 Service Unavailable (no healthy member)' : 'an error: 502 Bad Gateway (no upstream)');
      return;
    }
    this.e.note('message', 'tcp', dev, m.dev, 'proxied', '', `${dev} passes the request of ${formatAddr(front.remote)}:${front.rport} on to ${m.dev} ${formatAddr(m.addr)}:${m.port}: ${why}`);
    const limit = type === 'proxy' ? this.e.params.get('proxy-upstream', dev) : undefined;
    const t = this.run({ from: dev, target: m.dev, dst: m.addr, kind: 'tcp', port: m.port, source: 'upstream', series: `${dev} → ${m.dev} (upstream)`, front, timeout: limit || { value: 3600000 } });
    if (typeof t === 'string') {
      this.sendData(front, 200, `an error: 502 Bad Gateway (${t})`);
      return;
    }
    if (t.conn) {
      t.conn.front = front;
      front.upstream = t.conn;
    }
    t.onDone = (x) => {
      if (!x.ok) this.upstreamFailed(x.conn || front, x.result, front);
    };
    void pkt;
  }

  private upstreamFailed(c: Conn, why: string, front?: Conn): void {
    const f = front || c.front;
    if (!f || f.state !== 'ESTABLISHED') return;
    const type = this.P.sd(f.dev).dev.type;
    if (c.state === 'SYN_SENT') this.closeConn(c, `given up: ${why}`);
    this.e.note('drop', 'tcp', f.dev, '', 'upstream failed', '', `${f.dev}: the upstream connection failed (${why}); ${formatAddr(f.remote)} gets an error`);
    this.sendData(f, 200, type === 'proxy' && /timed out|no answer/.test(why) ? 'an error: 504 Gateway Timeout' : 'an error: 502 Bad Gateway');
  }

  // ------------------------------------------------------------ periodic tests

  /** Endpoint test traffic: every test interval, when it is on, to each target. */
  private startTraffic(): void {
    for (const d of Array.from(this.P.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (d.dev.type !== 'endpoint' || !d.l3.size) continue;
      const dev = d.id;
      const first = 3000 + Math.floor(this.e.random() * 1000);
      this.P.periodic(
        () => true,
        () => this.e.params.num('test-interval', dev),
        () => {
          if (this.e.params.str('test-traffic', dev) !== 'on' || !this.e.deviceOn(dev)) return;
          for (const x of this.targets(dev)) {
            if (typeof x === 'string') continue;
            this.run({ from: dev, target: x.label, dst: x.dst, kind: x.kind, port: x.port, source: 'traffic' });
          }
        },
        first,
      );
    }
  }

  /** An endpoint's test targets: its own, else its gateway (ICMP echo) and the servers of its service relations (their protocol and port). */
  targets(dev: string): Array<{ dst: IpAddr; kind: TestKind; port: number; label: string } | string> {
    const kind = this.e.params.str('test-type', dev) as TestKind;
    const own = this.e.params.deviceValue(dev, 'test-targets');
    if (own !== undefined && String(own) !== '') {
      const r = parseTargets(String(own));
      return 'list' in r ? r.list.map((t) => this.resolveTarget(dev, t, kind)) : [];
    }
    const out: Array<{ dst: IpAddr; kind: TestKind; port: number; label: string }> = [];
    const sd = this.P.sd(dev);
    for (const vrf of Array.from(new Set(Array.from(sd.l3.values()).map((l) => l.vrf))).sort(cmp)) {
      const d = lookup(this.P.m, dev, vrf, parseAddress('0.0.0.0') as IpAddr, this.e.ctx(dev));
      const gw = d.kind === 'forward' && d.hops.length ? d.hops[0].gateway : undefined;
      if (gw && !out.some((x) => compareAddr(x.dst, gw) === 0)) out.push({ dst: gw, kind: 'icmp', port: 0, label: `gateway ${formatAddr(gw)}` });
    }
    for (const m of this.upstreams(dev)) {
      const prof = relationProfile(this.P.m, this.P.m.index.relations.get(m.rel) as Relation);
      const t = profileTransport(prof.proto);
      const k: TestKind = t.proto === 'tcp' ? 'tcp' : t.proto === 'udp' ? 'udp' : kind;
      const port = t.ports[0] || (k === 'tcp' ? DEFAULT_TCP_PORT : k === 'udp' ? DEFAULT_UDP_PORT : 0);
      out.push({ dst: m.addr, kind: k, port, label: m.dev });
    }
    return out;
  }

  /** A load balancer's health checks of its pool: every interval, each member; down after the failure threshold, up again at the first success. */
  private startHealthChecks(): void {
    for (const d of Array.from(this.P.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (d.dev.type !== 'load_balancer') continue;
      const dev = d.id;
      const p = this.pool(dev);
      if (!p.members.length) continue;
      this.P.periodic(
        () => true,
        () => this.e.params.num('lb-hc-interval', dev),
        () => {
          if (!this.e.deviceOn(dev)) return;
          for (const m of p.members) {
            const timeout = this.e.params.get('lb-hc-timeout', dev);
            this.run({
              from: dev,
              target: m.dev,
              dst: m.addr,
              kind: m.kind,
              port: m.port,
              source: 'health',
              series: `${dev} health check ${m.dev}`,
              timeout,
              onDone: (t) => this.checked(dev, m, t),
            });
          }
        },
        2000 + Math.floor(this.e.random() * 500),
      );
    }
  }

  private checked(dev: string, m: Member, t: Test): void {
    const fall = this.e.params.get('lb-hc-fall', dev);
    m.last = t.ok ? `last check answered at t = ${fmtSec(this.e.now)}` : `last check failed at t = ${fmtSec(this.e.now)}: ${t.result}`;
    if (t.ok) {
      m.fails = 0;
      m.oks++;
      if (!m.up) {
        m.up = true;
        this.e.note('state', 'tcp', dev, m.dev, 'member up', 'up', `${dev}: pool member ${m.dev} (${formatAddr(m.addr)}:${m.port}) is up again: a health check was answered`);
      }
      return;
    }
    m.fails++;
    if (m.up && m.fails >= Number(fall.value)) {
      m.up = false;
      this.e.note('state', 'tcp', dev, m.dev, 'member down', 'down', `${dev}: pool member ${m.dev} (${formatAddr(m.addr)}:${m.port}) is taken out after ${m.fails} failed health checks (threshold ${resolvedText(fall)}): ${t.result}`);
    }
  }

  /** A monitoring system's ICMP probes of the devices it polls by SNMP. */
  private startProbes(): void {
    for (const d of Array.from(this.P.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      const dev = d.id;
      const agents: Array<{ dev: string; addr: IpAddr }> = [];
      for (const r of this.P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
        if (this.e.base(r) !== 'snmp') continue;
        const devs = relationDevices(r);
        if (devs[devs.length - 1] !== dev) continue;
        for (const a of devs.slice(0, -1)) {
          const ad = this.firstAddr(a, r);
          if (ad && !agents.some((x) => x.dev === a)) agents.push({ dev: a, addr: ad });
        }
      }
      if (!agents.length) continue;
      this.P.periodic(
        () => true,
        () => this.e.params.num('icmp-probe', dev),
        () => {
          if (!this.e.deviceOn(dev)) return;
          for (const a of agents) this.run({ from: dev, target: a.dev, dst: a.addr, kind: 'icmp', source: 'probe', series: `${dev} probe ${a.dev}`, timeout: { value: PROBE_TIMEOUT }, onDone: (t) => this.probed(dev, a.dev, t) });
        },
        2500 + Math.floor(this.e.random() * 500),
      );
    }
  }

  private probeState = new Map<string, Test>();

  private probed(dev: string, agent: string, t: Test): void {
    const k = `${dev} probe ${agent}`;
    const was = this.probeState.get(k);
    this.probeState.set(k, t);
    if (!was || was.ok !== t.ok) this.e.note('state', 'icmp', dev, agent, t.ok ? 'reachable' : 'unreachable', t.ok ? 'up' : 'down', `${dev}: ${agent} is ${t.ok ? 'reachable' : 'unreachable'} by ICMP probe (${t.result}; every ${resolvedText(this.e.params.get('icmp-probe', dev))})`);
  }

  // ------------------------------------------------------------ firewalls

  private fwTable(dev: string): Map<string, FwSession> {
    let m = this.fw.get(dev);
    if (!m) {
      m = new Map();
      this.fw.set(dev, m);
    }
    return m;
  }

  private filter(dev: string, pkt: Pkt, from: L3Iface, to: L3Iface): boolean {
    void to;
    const l4 = pkt.l4;
    // the model's relations (and its demands) are the firewall's policy; protocols without a transport header pass
    if (pkt.msg.relation || pkt.rides.length || pkt.msg.protocol === 'demand' || !l4 || l4.proto === 'other') return true;
    const proto = l4.proto as 'tcp' | 'udp' | 'icmp';
    const tab = this.fwTable(dev);
    const stateful = this.e.params.get('fw-stateful', dev).value === 'on';
    // traffic between the endpoints of a service relation on its port (a test of it, and its answers) is the relation's
    const rel = this.relationFor(pkt);
    const sp = proto === 'icmp' ? l4.echoId || 0 : l4.sport || 0;
    const dp = proto === 'icmp' ? l4.echoId || 0 : l4.dport || 0;
    const fwd = `${proto}|${formatAddr(pkt.src)}:${sp}>${formatAddr(pkt.dst)}:${dp}`;
    const rev = `${proto}|${formatAddr(pkt.dst)}:${dp}>${formatAddr(pkt.src)}:${sp}`;
    const flags = l4.flags || [];
    if (stateful) {
      // an ICMP error about a session's packet belongs to it
      if (proto === 'icmp' && l4.quote) {
        const q = l4.quote;
        const qk = `${q.proto}|${q.src}:${q.sport || 0}>${q.dst}:${q.dport || 0}`;
        const qr = `${q.proto}|${q.dst}:${q.dport || 0}>${q.src}:${q.sport || 0}`;
        if (tab.has(qk) || tab.has(qr)) return true;
      }
      const s = tab.get(fwd) || tab.get(rev);
      if (s) {
        s.last = this.e.now;
        if (proto === 'tcp') {
          if (flags.indexOf('RST') >= 0) {
            tab.delete(s.key);
            this.e.note('table', 'tcp', dev, '', 'session closed', '', `${dev} session ${s.flow} ends (RST)`);
          } else if (flags.indexOf('FIN') >= 0) {
            s.state = 'CLOSING';
            s.timeout = 'closing';
          } else if (s.state === 'SYN' && flags.indexOf('ACK') >= 0 && tab.get(rev) === s) s.state = 'SYN-ACK';
          else if (s.state === 'SYN-ACK' && flags.indexOf('ACK') >= 0 && tab.get(fwd) === s) {
            s.state = 'ESTABLISHED';
            s.timeout = 'fw-tcp';
          }
        }
        return true;
      }
    }
    const allow = parsePorts(String(this.e.params.get('fw-allow', dev).value) || 'none');
    const rules = 'list' in allow ? allow.list : [];
    const port = proto === 'icmp' ? 0 : (l4.dport as number);
    const opening = proto !== 'tcp' || (flags.indexOf('SYN') >= 0 && flags.indexOf('ACK') < 0);
    const echoReq = proto !== 'icmp' || l4.icmpType === 8 || l4.icmpType === 128;
    if (rel && (!stateful || !opening)) return true;
    if ((rel || portsMatch(rules, proto, port)) && (!stateful || (opening && echoReq))) {
      const rule = rel ? `relation ${rel}` : `allow ${proto === 'icmp' ? 'icmp' : proto + '/' + port}`;
      if (stateful) {
        const s: FwSession = { key: fwd, proto, flow: `${formatAddr(pkt.src)}${proto === 'icmp' ? '' : ':' + sp} → ${formatAddr(pkt.dst)}${proto === 'icmp' ? ' (echo ' + sp + ')' : ':' + dp}`, state: proto === 'tcp' ? 'SYN' : 'ACTIVE', created: this.e.now, last: this.e.now, rule, timeout: proto === 'tcp' ? 'fw-half-open' : proto === 'udp' ? 'fw-udp' : 'fw-icmp' };
        tab.set(fwd, s);
        this.e.note('table', proto, dev, '', 'session opened', s.state, `${dev} opens a session ${s.flow} (${rule}, in ${from.id})`);
      }
      return true;
    }
    // stateless: the answer of a permitted service passes by its source port
    if (!stateful && proto !== 'icmp' && portsMatch(rules, proto, l4.sport as number)) return true;
    if (!stateful && proto === 'icmp' && portsMatch(rules, 'icmp', 0)) return true;
    const action = this.e.params.get('fw-action', dev);
    const what = `${proto === 'icmp' ? (pkt.dst.version === 4 ? 'ICMP' : 'ICMPv6') + ' ' + (l4.icmpName || '') : proto.toUpperCase() + ' ' + formatAddr(pkt.src) + ':' + l4.sport + ' → ' + formatAddr(pkt.dst) + ':' + l4.dport}`;
    const why = stateful && !opening ? 'it belongs to no session it knows' : 'no relation of the model and no allow entry permits it';
    this.e.note('drop', proto, dev, '', action.value === 'reject' ? 'rejected' : 'dropped', '', `${dev} ${action.value === 'reject' ? 'rejects' : 'drops'} ${what} (${pkt.msg.label}): ${why} (default action ${resolvedText(action)})`);
    if (action.value !== 'reject') return false;
    if (proto === 'tcp') {
      if (flags.indexOf('RST') < 0) this.segment(dev, { local: pkt.dst, lport: l4.dport as number, remote: pkt.src, rport: l4.sport as number, vrf: pkt.vrf }, ['RST', 'ACK'], 0, `rejected by ${dev}`, pkt.dst);
    } else this.e.icmpError(dev, pkt, 'admin', { from });
    return false;
  }

  /** The service relation a packet belongs to: between its two ends' devices (either way), on the relation's port. */
  private relationFor(pkt: Pkt): string | null {
    const l4 = pkt.l4;
    if (!l4 || (l4.proto !== 'tcp' && l4.proto !== 'udp')) return null;
    const a = this.e.ownerOf(pkt.src);
    const b = this.e.ownerOf(pkt.dst);
    if (!a || !b) return null;
    for (const r of this.P.m.relations.slice().sort((x, y) => cmp(x.id, y.id))) {
      const devs = relationDevices(r);
      if (devs.indexOf(a) < 0 || devs.indexOf(b) < 0) continue;
      const t = profileTransport(relationProfile(this.P.m, r).proto);
      if (t.proto !== l4.proto) continue;
      if (t.ports.indexOf(l4.dport as number) >= 0 || t.ports.indexOf(l4.sport as number) >= 0) return r.id;
    }
    return null;
  }

  private fwTimeout(dev: string, s: FwSession): number {
    return s.timeout === 'closing' ? FW_CLOSING : this.e.params.num(s.timeout, dev);
  }

  /** Once a second: firewall sessions past their timeout are removed. */
  private sweep(): void {
    for (const dev of Array.from(this.fw.keys()).sort(cmp)) {
      const tab = this.fw.get(dev) as Map<string, FwSession>;
      for (const [k, s] of Array.from(tab)) {
        const to = this.fwTimeout(dev, s);
        if (this.e.now - s.last < to) continue;
        tab.delete(k);
        this.e.note('table', s.proto, dev, '', 'session timed out', '', `${dev} removes the session ${s.flow} (${s.state}): idle for ${durationText(to)}${s.timeout === 'closing' ? ' after it closed' : ` (${resolvedText(this.e.params.get(s.timeout, dev))})`}`);
      }
    }
  }

  // ------------------------------------------------------------ the tables and the status

  connRows(dev: string): ConnRow[] {
    const out: ConnRow[] = [];
    const now = this.e.now;
    for (const r of this.listening(dev).rules) out.push({ proto: r.proto === 'udp' ? 'udp' : 'tcp', local: `*:${r.from}${r.to !== r.from ? '-' + r.to : ''}`, remote: '*', state: r.proto === 'udp' ? 'open' : 'LISTEN', what: this.listening(dev).written ? 'listening (device)' : 'listening (its relations)', age: now, remaining: null });
    for (const c of Array.from((this.conns.get(dev) || new Map<string, Conn>()).values()).sort((a, b) => cmp(a.key, b.key))) out.push({ proto: 'tcp', local: `${formatAddr(c.local)}:${c.lport}`, remote: `${formatAddr(c.remote)}:${c.rport}`, state: c.state, what: c.what, age: now - c.since, remaining: c.timer !== null ? Math.max(0, c.timer - now) : null });
    for (const t of this.tests) if (!t.done && t.from === dev && t.kind !== 'tcp') out.push({ proto: t.kind === 'udp' ? 'udp' : 'icmp', local: '', remote: `${formatAddr(t.dst)}${t.kind === 'udp' ? ':' + t.port : ''}`, state: 'waiting', what: `test ${t.series}`, age: now - t.started, remaining: Math.max(0, t.started + Number(t.timeout.value) - now) });
    return out;
  }

  sessionRows(dev: string): SessionRow[] {
    const tab = this.fw.get(dev);
    if (!tab) return [];
    const now = this.e.now;
    return Array.from(tab.values())
      .sort((a, b) => cmp(a.flow, b.flow))
      .map((s) => ({ proto: s.proto, flow: s.flow, state: s.state, age: now - s.created, remaining: Math.max(0, this.fwTimeout(dev, s) - (now - s.last)), rule: s.rule }));
  }

  /** The firewalls' session timeouts in effect (the table's top). */
  sessionTimers(dev: string): Resolved[] {
    return ['fw-half-open', 'fw-tcp', 'fw-udp', 'fw-icmp', 'fw-stateful', 'fw-action', 'fw-allow'].map((k) => this.e.params.get(k, dev));
  }

  private status(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const [k, t] of Array.from(this.series).sort((a, b) => cmp(a[0], b[0]))) {
      out.push({ protocol: t.kind, name: k, device: t.from, peer: this.e.ownerOf(t.dst) || '', state: t.done ? (t.ok ? 'Answered' : 'Failed') : 'Waiting', detail: `${t.result}${t.done && t.ok && t.rtt !== undefined ? ', round trip ' + rttText(t.rtt) : ''} · ${t.source === 'manual' ? 'Send test' : 'test traffic'} at t = ${fmtSec(t.started)}`, up: t.done ? t.ok : true });
    }
    for (const [dev, p] of Array.from(this.pools).sort((a, b) => cmp(a[0], b[0]))) {
      if (this.P.sd(dev).dev.type !== 'load_balancer') continue;
      for (const m of p.members) out.push({ protocol: m.kind, name: `${dev} pool: ${m.dev} ${m.kind}/${m.port}`, device: dev, peer: m.dev, state: m.up ? 'Up' : 'Down', detail: `${m.last}; every ${resolvedText(this.e.params.get('lb-hc-interval', dev))}, timeout ${resolvedText(this.e.params.get('lb-hc-timeout', dev))}`, up: m.up });
    }
    for (const [k, t] of Array.from(this.probeState).sort((a, b) => cmp(a[0], b[0]))) out.push({ protocol: 'icmp', name: k, device: t.from, peer: this.e.ownerOf(t.dst) || '', state: t.ok ? 'Reachable' : 'Unreachable', detail: `${t.result} · every ${resolvedText(this.e.params.get('icmp-probe', t.from))}`, up: t.ok });
    return out;
  }

  /** The latest Send test… results, newest first. */
  manualTests(): Test[] {
    return this.tests.filter((t) => t.source === 'manual').reverse();
  }
}

function inNet(a: { net: IpAddr & { prefix: number } }, ip: IpAddr): boolean {
  if (a.net.version !== ip.version) return false;
  let bits = a.net.prefix;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((a.net.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
  }
  return true;
}

/** A round trip as text: "1.234 ms", "0.046 ms", "2.1 s". */
export function rttText(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms) / 1000} s` : `${Math.round(ms * 1000) / 1000} ms`;
}


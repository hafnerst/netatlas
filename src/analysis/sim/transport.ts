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
import { PolicyDecision, policyDecision, policyStateful } from '../policy';
import { Relation, relationDevices, TRANSFER_PROFILES, ServiceInstance, Device, Model } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { lookup } from '../routing';
import { IcmpKind, fmtSec, hashIndex } from './engine';
import { isMulticastIp } from './mac';
import { isLinkLocal6 } from './engine';
import { L3Iface } from './net';
import { Seg, StreamMark, TcpStream, initialSeq, segmentLabel, tcpFlagsText } from './tcp';
import { flowKey } from './pacing';
import { ParamValue, PortRule, Resolved, Target, durationText, ifaceRef, parsePorts, parseTargets, portsMatch, relRef, resolvedText, paramDef } from './params';
import { Multicast } from './multicast';
import { NetServicesSim } from './netsvc';
import { dnsNameKey, dnsNameProblem } from '../../model/dns';
import { ProtocolSim, relationProfile } from './protocols';
import { ConnRow, L4, Msg, Pkt, SessionRow, SessionStatus } from './types';
import { isContainer } from '../../model/virtual';
import { capabilities } from '../../model/capabilities';
import { profileAt } from '../separation';
import { appListeners, deviceListeners, serviceListeners } from '../listeners';
import type { AppInstance } from '../../model/applications';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** RFC 6298 §2.5 allows a maximum of at least 60 s; Linux TCP_RTO_MAX is 120 s. */
const RTO_MAX = 120000;
/** A learned path MTU ages out after this (RFC 1191 §6.3 suggests 10 min; Linux mtu_expires 600 s). */
const PMTU_EXPIRES = 600000;
/** Data segments are sent again at most this often before the connection is reset (Linux tcp_retries2). */
const DATA_RETRIES = 15;
/** TIME_WAIT: 2 × MSL (Linux 60 s). */
const TIME_WAIT = 60000;
/** FIN_WAIT_2 without the peer's FIN: given up after this (Linux tcp_fin_timeout 60 s). */
const FIN_TIMEOUT = 60000;
/** A SYN-ACK is sent again at most this often (Linux tcp_synack_retries); a FIN (tcp_orphan_retries, 0 meaning 8). */
const SYNACK_RETRIES = 5;
const FIN_RETRIES = 8;
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
  /** a host name's resolution: "web.hq.example = 10.1.2.10 (DNS: 1.2 ms)" */
  resolved?: string;
  /** the status row it belongs to ("pc1 → web1 tcp/443") */
  series: string;
  from: string;
  /** the source interface chosen (Send test…), else the one the route gives */
  via?: string;
  /** a Send test's series and this message's number in it (1 …) */
  run?: number;
  msg?: number;
  /** what it was aimed at, as written ("web1", "10.0.0.255") */
  target: string;
  dst: IpAddr;
  kind: TestKind;
  port: number;
  size: number;
  df: boolean;
  keep: boolean;
  /** periodic test traffic, Send test…, a health check, a probe, a proxy's upstream */
  /** experiment: an experiment's application (scenario time, its messages carrying their id as a Send test's) */
  source: 'traffic' | 'manual' | 'experiment' | 'health' | 'probe' | 'upstream';
  started: number;
  /** when it ended (its answer, error or timeout) */
  ended?: number;
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
  /** a one-way datagram (periodic UDP messages): done when it reaches its receiver, nothing answers it */
  oneWay?: boolean;
  /** a host name's record type: A (IPv4, the default) or AAAA (IPv6) */
  qtype?: 'A' | 'AAAA';
  /** the retry this message is (an application's request sent again after a timeout: 1, 2 …) */
  retry?: number;
  /** the application that sent it ("hmi/poll") */
  app?: string;
}

/** What a connection's message is: an application's (MQTT, BGP), or a test's request or answer of so many bytes. */
type ConnMsg = { kind: 'app'; app: AppMessage } | { kind: 'request' | 'response'; bytes: number };

/** A TCP connection end (tcp.ts keeps its byte stream). */
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
  /** the time its next timer runs out (retransmission, TIME_WAIT, keepalive), null none */
  timer: number | null;
  /** retransmissions of the earliest unacknowledged segment so far (the timeout doubles with each) */
  tries: number;
  /** the running retransmission timer's token (0: none, -1: closed) */
  rtx: number;
  /** bumped by the state timers (TIME_WAIT, FIN_WAIT_2, keepalive): an older one does nothing */
  gen: number;
  what: string;
  test?: Test;
  /** at a load balancer / proxy: the upstream connection that serves this client connection, and back */
  upstream?: Conn;
  front?: Conn;
  /** the byte stream: sequence numbers, what is unacknowledged, what arrived */
  tcp: TcpStream<ConnMsg>;
  keep: boolean;
  /** keepalive probes sent without an answer */
  probes: number;
  /** a server: the request's arrival (answered after the service response time) */
  answered?: boolean;
  /** an application's own connection (MQTT, BGP): its socket, which gets the messages instead of the request / answer logic */
  sock?: AppSocket;
  /** the protocol its segments are drawn as (a BGP session's connection: BGP), else TCP */
  shown?: { protocol: string; label: string; relation?: string };
  /** the MSS the peer's SYN announced (RFC 9293 §3.7.1: what it can receive; 536 / 1220 when it announced none) */
  peerMss?: number;
}

/** What a listener's connections are drawn as: fixed, or found by the connection's local and remote address. */
type Shown = { protocol: string; label: string } | ((local: IpAddr, remote: IpAddr) => { protocol: string; label: string; relation?: string });

/** A message an application sends over its connection (an MQTT packet): what is drawn and logged, its size. */
export interface AppMessage {
  /** the protocol it is drawn and filtered as ("mqtt") */
  protocol: string;
  /** "MQTT PUBLISH" */
  type: string;
  /** the short label of its dot ("MQTT PUBLISH") */
  label: string;
  /** the log's and the packet inspector's line */
  detail: string;
  /** its size on the wire (the application's bytes, without TCP / IP) */
  bytes: number;
  data: { [k: string]: unknown };
  /** the model's relation it belongs to (a BGP session's), if any */
  relation?: string;
  /** what it waited for before it could go (a BGP OPEN: its TCP connection), for the inspector */
  waited?: string[];
}

/** What an application's connection tells it. */
export interface AppSocketHandlers {
  /** a client's connection is established */
  open?(s: AppSocket): void;
  /** a listener accepted a connection (established) */
  accept?(s: AppSocket): void;
  /** a whole message arrived (its last segment) */
  message(s: AppSocket, m: AppMessage): void;
  /**
   * the peer closed its direction (its FIN arrived; CLOSE_WAIT): this end
   * may still send, and closes when it is done (s.close()). Without it the
   * application closes its side at once (BGP and MQTT do).
   */
  peerClosed?(s: AppSocket): void;
  /** the connection is gone: reset, refused, timed out, closed here, both directions closed, the device powered off */
  closed(s: AppSocket, why: string): void;
}

/** An application's end of a TCP connection (transport.ts keeps the connection itself: handshake, retransmission, close). */
export class AppSocket {
  closedWhy: string | null = null;
  constructor(
    private T: Transport,
    readonly c: Conn,
    readonly h: AppSocketHandlers,
  ) {}
  get dev(): string {
    return this.c.dev;
  }
  get local(): IpAddr {
    return this.c.local;
  }
  get remote(): IpAddr {
    return this.c.remote;
  }
  get lport(): number {
    return this.c.lport;
  }
  get rport(): number {
    return this.c.rport;
  }
  /** established (or the peer closed only its direction: CLOSE_WAIT) and not closed here: it can send */
  get open(): boolean {
    return this.closedWhy === null && (this.c.state === 'ESTABLISHED' || this.c.state === 'CLOSE_WAIT');
  }
  send(m: AppMessage): boolean {
    return this.T.appSend(this, m);
  }
  /** close it (FIN): the peer learns of it; this end is told at once */
  close(why: string): void {
    this.T.appClose(this, why);
  }
  /** reset it (RST): gone at once on both ends */
  reset(why: string): void {
    this.T.appReset(this, why);
  }
  /** its segments (the handshake, the acknowledgments) are drawn and filtered as this protocol's, of this relation */
  show(protocol: string, label: string, relation?: string): void {
    this.c.shown = { protocol, label, relation };
  }
  /** the connection's table row: its state and sequence numbers (for an application's status) */
  get state(): string {
    return this.c.state;
  }
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
  /** connections opened so far (each one's initial sequence number differs) and the retransmission timers' tokens */
  private issCount = 0;
  private rtxTok = 0;
  private conns = new Map<string, Map<string, Conn>>();
  private nextPort = new Map<string, number>();
  /** a protocol break's UDP leg 2 waiting for its answer: by gateway and its source port, the client on leg 1 */
  private udpRelays = new Map<string, { client: IpAddr; cport: number; local: IpAddr; lport: number; vrf: string; test?: number; profile: string }>();
  /** learned path MTUs: by device, then "VRF|destination" */
  private pmtu = new Map<string, Map<string, { mtu: number; at: number; via: string }>>();
  readonly tests: Test[] = [];
  private series = new Map<string, Test>();
  private fw = new Map<string, Map<string, FwSession>>();
  private pools = new Map<string, { members: Member[]; rr: number; sticky: Map<string, { member: string; at: number }> }>();
  private listenCache = new Map<string, Listening>();
  /** group membership (multicast.ts): which hosts take a group's datagrams */
  multicast: Multicast | null = null;
  /** DHCP and DNS (the resolver for host names) */
  netsvc: NetServicesSim | null = null;

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
    // an application's messages over TCP (MQTT) are TCP segments drawn as their protocol
    P.handlers.set('mqtt', (dev, l3, _msg, pkt) => {
      if (pkt && l3 && pkt.l4 && pkt.l4.proto === 'tcp') this.tcpIn(dev, l3, pkt);
    });
    P.handlers.set('udp', (dev, l3, _msg, pkt) => {
      if (pkt && l3) this.udpIn(dev, l3, pkt);
    });
    // a segment of a connection, whatever protocol it is drawn as (a BGP session's, an MQTT client's)
    P.tcpHook = (dev, l3, pkt) => this.tcpIn(dev, l3, pkt);
    P.transport = this;
    P.filterHook = (dev, pkt, from, to) => this.filter(dev, pkt, from, to);
    P.localErrorHook = (dev, pkt, kind, text, mtu) => this.localError(dev, pkt, kind, text, mtu);
    P.portHook = (dev, pkt, l3) => this.portOpen(dev, pkt, l3);
    P.sweepHooks.push(() => this.sweep());
    P.deviceHooks.push((dev, up) => {
      if (up) return;
      // powered off: its connections are gone — each through closeConn, which ends its retransmission, keepalive and state
      // timers, so nothing of it is sent after the reboot (its applications' sockets are told so)
      const mine = this.conns.get(dev);
      if (mine) for (const c of Array.from(mine.values()).sort((a, b) => cmp(a.key, b.key))) this.closeConn(c, `${dev} was powered off`, false);
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
    if (this.multicast) {
      // a test's datagram to a group reached a member: its answer
      this.multicast.onTestReceived = (id, dev, from) => {
        void from;
        const t = this.tests.find((x) => x.id === id);
        if (t && !t.done && t.answers.indexOf(dev) < 0) {
          t.answers.push(dev);
          if (t.rtt === undefined) t.rtt = this.e.now - t.started;
        }
      };
    }
  }

  // ------------------------------------------------------------ addresses and ports

  /** The address a device sends from towards a destination, and its VRF and interface; null when there is none (pickSource says why). */
  sourceFor(dev: string, dst: IpAddr, via?: string, vrf?: string): { src: IpAddr; vrf: string; l3: L3Iface | null } | null {
    const r = this.pickSource(dev, dst, via, vrf);
    return 'why' in r ? null : r;
  }

  /**
   * The source of a device's own packet (RFC 6724 / Linux's choice, in the
   * simulation's terms), after the route:
   *   an interface chosen (Send test… from an interface): its address of
   *     the family — the interface must be up; its VRF;
   *   a broadcast or group: the interface whose subnet it is (a group: the
   *     first interface with an address of the family);
   *   else the routing context: the VRF given, else the default table
   *     (an unbound sender), else the one VRF with a route when there is
   *     exactly one (several: ambiguous, nothing is sent); the route's
   *     egress interface (the first of equal-cost next hops) gives the
   *     address — a link-local one only for a link-local destination —
   *     else (an unnumbered egress) an address of the device in the same
   *     VRF, loopbacks first.
   * Never an address of another VRF.
   */
  pickSource(dev: string, dst: IpAddr, via?: string, vrf?: string): { src: IpAddr; vrf: string; l3: L3Iface | null; how?: string } | { why: string; transient?: boolean } {
    const sd = this.P.sd(dev);
    if (!sd) return { why: `${dev} is not a device of the simulation` };
    const fam = `IPv${dst.version}`;
    const ll = isLinkLocalAddr(dst);
    const usable = (l: L3Iface, x: { addr: IpAddr }): boolean => x.addr.version === dst.version && (ll || !isLinkLocalAddr(x.addr) || l.kind === 'loopback') && this.e.usableAddr(l, x.addr);
    if (via !== undefined) {
      const l = sd.l3.get(via);
      if (!l) return { why: `${dev} has no interface ${via} with an IP address` };
      if (!this.e.isL3Up(dev, via)) return { why: `${dev}:${via} is down`, transient: true };
      const a = l.addrs.find((x) => usable(l, x) && (!this.e.isBroadcastAddr(dst) || isMulticastIp(dst) || inNet(x, dst) || formatAddr(dst) === '255.255.255.255')) || l.addrs.find((x) => usable(l, x)) || (ll && l.ll ? l.ll : undefined);
      return a ? { src: a.addr, vrf: l.vrf, l3: l } : { why: `${dev}:${via} has no ${fam} address to send from` };
    }
    const ifs = Array.from(sd.l3.values()).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id));
    if (isMulticastIp(dst) || this.e.isBroadcastAddr(dst)) {
      // a broadcast or a group: the interface whose subnet it is, else the first with an address of the family
      for (const l of ifs) {
        const a = l.addrs.find((x) => x.addr.version === dst.version && inNet(x, dst));
        if (a && l.kind !== 'loopback') return { src: a.addr, vrf: l.vrf, l3: l };
      }
      for (const l of ifs) {
        const a = l.addrs.find((x) => usable(l, x));
        if (a && l.kind !== 'tunnel' && l.kind !== 'loopback' && (vrf === undefined || l.vrf === vrf)) return { src: a.addr, vrf: l.vrf, l3: l };
      }
      return { why: `${dev} has no ${fam} address to send from` };
    }
    const vrfs = Array.from(new Set(ifs.map((l) => l.vrf))).sort(cmp);
    const routed = (v: string): { l3: L3Iface | null; local: boolean } | null => {
      const d = lookup(this.P.m, dev, v, dst, this.e.ctx(dev));
      if (d.kind === 'local') return { l3: ifs.find((l) => l.vrf === v && l.addrs.some((x) => compareAddr(x.addr, dst) === 0)) || null, local: true };
      if (d.kind !== 'forward' || !d.hops.length) return null;
      return { l3: sd.l3.get(d.hops[0].iface) || null, local: false };
    };
    let ctx = vrf;
    let how: string | undefined;
    if (ctx === undefined) {
      if (vrfs.indexOf('') >= 0 && routed('')) ctx = '';
      else {
        const others = vrfs.filter((v) => v !== '' && !!routed(v));
        if (others.length > 1) return { why: `${dev} reaches ${formatAddr(dst)} in VRFs ${others.join(', ')} and not in its default table: ambiguous — choose a source interface (its VRF)` };
        if (others.length === 1) {
          ctx = others[0];
          how = `in VRF ${ctx}, the only one with a route to ${formatAddr(dst)}`;
        }
      }
    }
    if (ctx === undefined) {
      // no route anywhere: an address of the default table (the packet fails at the route lookup, which says why)
      for (const l of ifs) {
        const a = l.addrs.find((x) => usable(l, x));
        if (a && l.kind !== 'tunnel' && l.vrf === '') return { src: a.addr, vrf: '', l3: l };
      }
      for (const l of ifs) {
        const a = l.addrs.find((x) => usable(l, x));
        if (a && l.kind !== 'tunnel') return { src: a.addr, vrf: l.vrf, l3: l };
      }
      return { why: `${dev} has no ${fam} address to send from` };
    }
    const r = routed(ctx);
    const out = r ? r.l3 : null;
    if (out) {
      const a = out.addrs.find((x) => usable(out, x)) || (ll && out.ll ? out.ll : undefined);
      if (a) return { src: a.addr, vrf: ctx, l3: out, how };
    }
    // an unnumbered egress (or none): an address of the device in the same VRF, loopbacks first
    const same = ifs.filter((l) => l.vrf === ctx && l.kind !== 'tunnel').sort((a, b) => Number(b.kind === 'loopback') - Number(a.kind === 'loopback') || cmp(a.id, b.id));
    for (const l of same) {
      const a = l.addrs.find((x) => usable(l, x));
      if (a) return { src: a.addr, vrf: ctx, l3: out || l, how };
    }
    return { why: `${dev} has no ${fam} address in ${ctx ? 'VRF ' + ctx : 'its default table'} to send from` };
  }

  private ephemeral(dev: string): number {
    const n = this.nextPort.get(dev);
    const p = n !== undefined ? n : 49152 + (hashIndex(dev, 4000) as number);
    this.nextPort.set(dev, p >= 65535 ? 49152 : p + 1);
    return p;
  }

  /** The ports a device listens on (deviceListening: one definition for the simulation and the static analysis). */
  listening(dev: string): Listening {
    const own = this.e.params.deviceValue(dev, 'listening');
    if (own !== undefined) return deviceListening(this.P.m, dev, own);
    let l = this.listenCache.get(dev);
    if (!l) {
      l = deviceListening(this.P.m, dev, undefined);
      this.listenCache.set(dev, l);
    }
    return l;
  }

  private relCache = new Map<string, PortRule[]>();

  /** The ports of the relations a device serves (a load balancer: also those it passes requests on to). */
  private relationRules(dev: string): PortRule[] {
    let rules = this.relCache.get(dev);
    if (!rules) {
      rules = relationServerPorts(this.P.m, dev);
      this.relCache.set(dev, rules);
    }
    return rules;
  }

  /**
   * Does the device take a segment or datagram to this port (and address)? Its listening ports; an
   * application bound to an interface takes only what is addressed to that interface, unless something
   * else listens on the port on all addresses (a service, a relation's server, an unbound application).
   */
  private open(dev: string, proto: 'tcp' | 'udp', port: number, dst?: IpAddr): boolean {
    // an application's own listener (an MQTT broker, a BGP speaker) listens while it runs
    if (proto === 'tcp' && this.appListening.has(dev + '|' + port)) return true;
    // a routing session's port (BGP 179, LDP 646) is open only while its speaker runs there (its relations alone open nothing)
    if (proto === 'tcp' && this.sessionPorts(dev).has(port)) return false;
    const ls = this.listening(dev);
    if (!portsMatch(ls.rules, proto, port)) return false;
    if (!dst || ls.written) return true;
    const bound = this.boundOnly(dev, proto, port);
    return !bound || bound.some((b) => this.addrOn(dev, b, dst));
  }

  private sessionPortCache = new Map<string, Set<number>>();

  /** The TCP ports of a device's routing sessions (BGP, EVPN, L3VPN, LDP …): their speakers listen on them, not the relations. */
  private sessionPorts(dev: string): Set<number> {
    let s = this.sessionPortCache.get(dev);
    if (s) return s;
    s = new Set<number>();
    for (const r of this.P.m.relations) {
      if (relationDevices(r).indexOf(dev) < 0) continue;
      const prof = relationProfile(this.P.m, r);
      if (prof.behaviour !== 'bgp' && prof.behaviour !== 'ldp') continue;
      const m = /\bTCP\s+([0-9]{1,5})/.exec(prof.proto);
      if (m) s.add(Number(m[1]));
    }
    this.sessionPortCache.set(dev, s);
    return s;
  }

  /** The interfaces a port is bound to, when only bound applications listen on it (else null: all addresses). */
  private boundOnly(dev: string, proto: 'tcp' | 'udp', port: number): string[] | null {
    return boundInterfaces(this.P.m, dev, proto, port, this.relationRules(dev));
  }

  /** Is the address one of an interface's (configured or leased) now? */
  private addrOn(dev: string, iface: string, a: IpAddr): boolean {
    const l = this.P.sd(dev).l3.get(iface);
    return !!l && l.addrs.some((x) => compareAddr(x.addr, a) === 0);
  }

  /** Why a port is closed, for the log: what listens, and where a bound application listens instead. */
  private listenText(dev: string, proto: 'tcp' | 'udp', port: number, dst: IpAddr): string {
    if (proto === 'tcp' && this.sessionPorts(dev).has(port)) return `no ${port === 646 ? 'LDP' : 'BGP'} speaker runs on ${dev}: port ${port} is open only while one does`;
    const ls = this.listening(dev);
    const bound = portsMatch(ls.rules, proto, port) ? this.boundOnly(dev, proto, port) : null;
    if (bound) return `${proto}/${port} listens on ${bound.join(', ')} only, not on ${formatAddr(dst)}`;
    return ls.text;
  }

  /** The listener application of a device that takes this port and address, if one does. */
  appAt(dev: string, proto: 'tcp' | 'udp', port: number, dst: IpAddr): AppInstance | undefined {
    const md = this.P.m.index.devices.get(dev);
    const hit = appListeners(md).filter((x) => x.proto === proto && x.port === port && (x.bind === undefined || this.addrOn(dev, x.bind, dst)));
    // (one bound to the address's own interface before one on all addresses)
    hit.sort((a, b) => Number(a.bind === undefined) - Number(b.bind === undefined));
    return hit.length && md && md.applications ? md.applications.find((a) => a.id === hit[0].app) : undefined;
  }

  /** The service response time at a port: the device attribute (or a relation's), with its source in words. */
  private serviceTime(dev: string, proto: 'tcp' | 'udp', port: number): { value: number; text: string } {
    const rt = this.e.params.get('service-response', dev, null, this.serviceRel(dev, proto, port));
    return { value: Number(rt.value), text: 'the service response time ' + resolvedText(rt) };
  }

  /** Run fn in the context of a test (a Send test's id, else none). */
  private withTestOf(t: Test, fn: () => void): void {
    this.e.withTest(t.source === 'manual' || t.source === 'experiment' ? t.id : null, fn);
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
      this.rstFor(dev, pkt, `refused: port ${l4.dport} is closed`);
      return;
    }
    this.e.note('drop', 'udp', dev, '', pkt.msg.type, '', `${what}: ${isMulticastIp(pkt.dst) || this.e.isBroadcastAddr(pkt.dst) ? 'no ICMP error to a broadcast or multicast' : 'it answers with ICMP port unreachable'} (${pkt.msg.label})`);
    this.e.icmpError(dev, pkt, 'port', { from: l3 });
  }

  // ------------------------------------------------------------ path MTU

  /**
   * The path MTU a device learned towards a destination in a VRF (PMTUD,
   * RFC 1191 / RFC 8201), while it is valid: it ages out after 10 min
   * (RFC 1191 §6.3, Linux mtu_expires; then the interface MTU is tried
   * again), and a change of the route's egress interface forgets it (a new
   * path is learned anew).
   */
  private pathMtu(dev: string, vrf: string, dst: IpAddr): number | null {
    const m = this.pmtu.get(dev);
    const k = vrf + '|' + formatAddr(dst);
    const v = m ? m.get(k) : undefined;
    if (!v) return null;
    if (this.e.now - v.at >= PMTU_EXPIRES || this.egressOf(dev, vrf, dst) !== v.via) {
      (m as Map<string, { mtu: number; at: number; via: string }>).delete(k);
      this.e.note('table', 'icmp', dev, '', 'path MTU', '', `${dev}: the path MTU to ${formatAddr(dst)}${vrf ? ' (VRF ' + vrf + ')' : ''} (${v.mtu} bytes) is forgotten: ${this.e.now - v.at >= PMTU_EXPIRES ? 'it aged out (10 min)' : 'the route leaves by another interface now'}`);
      return null;
    }
    return v.mtu;
  }

  /** The interface a device's route to a destination leaves by now ('' none). */
  private egressOf(dev: string, vrf: string, dst: IpAddr): string {
    const d = lookup(this.P.m, dev, vrf, dst, this.e.ctx(dev));
    return d.kind === 'forward' && d.hops.length ? d.hops[0].iface : '';
  }

  private learnMtu(dev: string, vrf: string, dst: IpAddr, mtu: number, how: string): void {
    let m = this.pmtu.get(dev);
    if (!m) {
      m = new Map();
      this.pmtu.set(dev, m);
    }
    const k = vrf + '|' + formatAddr(dst);
    const was = this.pathMtu(dev, vrf, dst);
    // (RFC 8201 §5.1: never below the IPv6 minimum of 1280; RFC 1191 §3: an IPv4 path is at least 68)
    const floor = dst.version === 6 ? 1280 : 68;
    const v = Math.max(floor, mtu);
    if (was !== null && was <= v) return;
    m.set(k, { mtu: v, at: this.e.now, via: this.egressOf(dev, vrf, dst) });
    this.e.note('table', 'icmp', dev, '', 'path MTU', '', `${dev}: the path MTU to ${formatAddr(dst)}${vrf ? ' (VRF ' + vrf + ')' : ''} is ${v} bytes now (${how}); its next packets there fit (PMTUD)`);
  }

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
    if (dst.version === 6 && !df) {
      const pm = this.pathMtu(dev, vrf, dst);
      if (pm) pkt.pmtu = pm;
    }
    if (l4.proto === 'tcp') {
      (m.data as { tcp?: boolean }).tcp = true;
      m.flags = tcpFlagsText(l4.flags);
    }
    if (l4.proto === 'tcp' || l4.proto === 'udp' || (l4.proto === 'icmp' && l4.echoId !== undefined)) m.conv = flowKey(l4.proto, formatAddr(src), formatAddr(dst), l4);
    this.e.note('message', m.protocol, dev, peer, m.type, '', m.detail, this.e.now, m);
    // the logical view: a segment of a relation's connection (its handshake, its acknowledgments, its messages) goes along the relation —
    // one dot per segment the connection sends, from this one place (a message without a relation goes by its network: the engine's)
    const rel = m.relation && peer ? this.P.m.index.relations.get(m.relation) : undefined;
    if (rel && l4.proto === 'tcp' && relationDevices(rel).indexOf(dev) >= 0 && relationDevices(rel).indexOf(peer) >= 0) this.P.lane(rel, dev, peer, m, this.e.estimate(dev, dst));
    // a group goes out of the interface it is sent from (a host sends it on its own segment)
    const out = isMulticastIp(dst) ? this.sourceFor(dev, dst) : null;
    this.e.send(dev, pkt, out && out.l3 ? out.l3 : undefined);
    return pkt;
  }

  /** A TCP segment from a connection's end (or a RST for a closed port: `src` its address). */
  // ------------------------------------------------------------ tests

  /** A device's tests run against a target: its address and the test (a target's own, else the test type in effect). */
  resolveTarget(dev: string, t: Target, kind: TestKind): { dst: IpAddr; kind: TestKind; port: number; label: string; name?: string } | string {
    let dst: IpAddr | null = parseAddress(t.to);
    let label = t.to;
    let name: string | undefined;
    if (!dst) {
      const i = t.to.indexOf(':');
      const d = i >= 0 ? t.to.slice(0, i) : t.to;
      const iface = i >= 0 ? t.to.slice(i + 1) : undefined;
      const sd = this.P.sd(d);
      // a host name: resolved by DNS when the test runs
      if (!sd && t.to.indexOf('.') > 0 && !dnsNameProblem(t.to)) {
        const k = t.test ? (t.test.proto as TestKind) : kind;
        const port = t.test && t.test.proto !== 'icmp' ? t.test.from : k === 'tcp' ? DEFAULT_TCP_PORT : k === 'udp' ? DEFAULT_UDP_PORT : 0;
        name = dnsNameKey(t.to);
        return { dst: parseAddress('0.0.0.0') as IpAddr, kind: k, port, label, name };
      }
      if (!sd) return `${t.to} is neither a device of the model, an address nor a host name`;
      const src = this.sourceFor(dev, parseAddress('0.0.0.0') as IpAddr);
      const want = src ? src.src.version : 4;
      // (a loopback, and a container bridge's interface on its host, last: the bridge's address is not reached from outside)
      const back = (l: { id: string; kind: string }): number => (l.kind === 'loopback' ? 1 : (this.P.m.index.interfaces.get(d + ':' + l.id) || { type: '' }).type === 'bridge' ? 2 : 0);
      const ls = Array.from(sd.l3.values()).filter((l) => (iface ? l.id === iface : l.kind !== 'tunnel')).sort((a, b) => back(a) - back(b) || cmp(a.id, b.id));
      for (const l of ls) for (const a of l.addrs) if (!dst && a.addr.version === want) dst = a.addr;
      for (const l of ls) for (const a of l.addrs) if (!dst) dst = a.addr;
      if (!dst) return `${t.to} has no address`;
      label = t.to;
    }
    const k = t.test ? (t.test.proto as TestKind) : kind;
    const port = t.test && t.test.proto !== 'icmp' ? t.test.from : k === 'tcp' ? DEFAULT_TCP_PORT : k === 'udp' ? DEFAULT_UDP_PORT : 0;
    return { dst, kind: k, port, label, name };
  }

  /** Run one test now (Send test…, test traffic, a health check, a probe); its result comes later. */
  run(o: { from: string; via?: string; target: string; dst: IpAddr; name?: string; kind: TestKind; port?: number; size?: number; df?: boolean; keep?: boolean; source: Test['source']; series?: string; onDone?: (t: Test) => void; front?: Conn; timeout?: Resolved | { value: number }; run?: number; msg?: number; oneWay?: boolean; qtype?: 'A' | 'AAAA'; retry?: number; app?: string }): Test | string {
    const dev = o.from;
    const sd = this.P.sd(dev);
    if (!sd) return `${dev} is not a device of the simulation`;
    if (!this.e.deviceOn(dev)) return `${dev} is powered off`;
    if (o.via !== undefined && !sd.l3.get(o.via)) return `${dev} has no interface ${o.via} with an IP address or DHCP`;
    // (a DHCP client without its lease yet: the test waits for it; a host name: for its answer)
    const waits = this.leaseWait(dev, o.via, o.name ? o.qtype === 'AAAA' : o.dst.version === 6);
    const pick = o.name || waits ? null : this.pickSource(dev, o.dst, o.via);
    // (an interface that is down now: the test is made, and fails saying so)
    if (pick && 'why' in pick && !pick.transient) return pick.why;
    const kind = o.kind;
    const port = kind === 'icmp' ? 0 : o.port || (kind === 'tcp' ? DEFAULT_TCP_PORT : DEFAULT_UDP_PORT);
    const series = o.series || `${o.via !== undefined ? dev + ':' + o.via : dev} → ${o.target} ${kind === 'icmp' ? 'ICMP echo' : kind + '/' + port}`;
    const t: Test = {
      id: ++this.seq,
      series,
      from: dev,
      via: o.via,
      run: o.run,
      msg: o.msg,
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
      oneWay: o.oneWay,
      qtype: o.qtype,
      retry: o.retry,
      app: o.app,
    };
    this.tests.push(t);
    if (this.tests.length > 400) this.tests.splice(0, this.tests.length - 400);
    if (o.source !== 'health' && o.source !== 'probe' && o.source !== 'upstream') this.series.set(series, t);
    this.begin(t, o.name);
    return t;
  }

  /**
   * A test goes once what it depends on is there: its sender's address (a
   * DHCP lease), then the target's address (a host name, resolved by DNS);
   * each wait is logged with its reason.
   */
  private begin(t: Test, name?: string): void {
    // a Send test's exchange is the test's: what it sends and needs, and every answer (always shown, marked Test)
    this.e.withTest(t.source === 'manual' || t.source === 'experiment' ? t.id : null, () => this.beginNow(t, name));
  }

  /** The DHCP client interface a test from this device (by this interface) waits for, if any (IPv6 waits for none: a lease is IPv4). */
  private leaseWait(dev: string, via?: string, v6 = false): string | null {
    if (v6) return null;
    if (via === undefined) return this.e.waitsForLease(dev);
    return this.e.addressReady(dev, via) ? null : via;
  }

  /**
   * A DHCP client gave up a round (no offer after its retries): the Send tests waiting for its lease
   * are not sent, and say why (the client starts again later; a new test waits for that).
   */
  leaseFailed(dev: string, iface: string, why: string): void {
    for (const t of this.tests) {
      if (t.done || t.from !== dev || t.result.indexOf('waiting for a DHCP lease on ' + dev + ':' + iface) !== 0) continue;
      this.e.withTest(t.source === 'manual' || t.source === 'experiment' ? t.id : null, () => this.finish(t, false, `not sent: ${dev}:${iface} has no DHCP lease (${why})`));
    }
  }

  /**
   * An id for the traffic of an operation that is no test (a join's reports, a stream's datagrams, from
   * Network events): from the tests' own sequence, so it never names a test; its messages carry it as a
   * test's do (always drawn, marked in the log, found by their event).
   */
  reserveId(): number {
    return ++this.seq;
  }

  /** Stop: a test that has sent nothing yet (waiting for a lease or a name) is not sent; true when it was cancelled. */
  cancel(t: Test, result: string): boolean {
    if (t.done || t.pktIds.length || t.conn) return false;
    this.e.withTest(t.source === 'manual' || t.source === 'experiment' ? t.id : null, () => this.finish(t, false, result));
    return true;
  }

  private beginNow(t: Test, name?: string): void {
    if (t.done) return;
    const dev = t.from;
    const lease = this.leaseWait(dev, t.via, name ? t.qtype === 'AAAA' : t.dst.version === 6);
    const what: Msg = { protocol: t.kind, type: 'test', label: `Test ${t.series}`, detail: `Test ${t.series}` };
    if (lease) {
      t.result = `waiting for a DHCP lease on ${dev}:${lease}`;
      this.e.waitFor('lease:' + dev + (t.via !== undefined ? ':' + t.via : ''), `a DHCP lease on ${dev}:${lease}`, dev, what, () => this.begin(t, name), 'test|' + t.id);
      return;
    }
    if (name && this.netsvc) {
      t.result = `resolving ${name}`;
      const qtype = t.qtype || 'A';
      if (!this.netsvc.cached(dev, name, qtype)) this.e.note('wait', t.kind, dev, '', 'waiting', '', `${what.label} waiting for DNS ${name} (${qtype})`);
      const since = this.e.now;
      this.netsvc.resolve(dev, name, qtype, (r) => {
        if (t.done) return;
        if (!r.addr) {
          this.finish(t, false, r.error || `${name} could not be resolved`);
          return;
        }
        t.dst = r.addr;
        t.resolved = `${name} = ${formatAddr(r.addr)} (DNS: ${durationText(this.e.now - since)})`;
        this.begin(t);
      });
      return;
    }
    const pick = this.pickSource(dev, t.dst, t.via);
    if ('why' in pick) {
      this.finish(t, false, `not sent: ${pick.why}`);
      return;
    }
    const s = pick;
    if (s.how) this.e.note('note', t.kind, dev, '', 'source', '', `Test ${t.series}: from ${formatAddr(s.src)} ${s.how}`);
    const o = { dst: t.dst };
    const kind = t.kind;
    const bcast = this.e.isBroadcastAddr(o.dst) || isMulticastIp(o.dst);
    if (kind === 'tcp' && bcast) {
      this.finish(t, false, 'not sent: TCP connects to one host, never to a broadcast or multicast address');
      return;
    }
    // the application gives up after its response timeout (a broadcast ping collects the answers until then)
    this.later(Number(t.timeout.value), () => {
      if (t.done) return;
      if (t.oneWay) this.finish(t, false, `not received within ${'def' in t.timeout ? resolvedText(t.timeout as Resolved) : durationText(Number(t.timeout.value))}${this.lastDrop(t)}`);
      else if (t.answers.length && isMulticastIp(t.dst)) this.finish(t, true, `received by ${t.answers.length} member${t.answers.length === 1 ? '' : 's'}: ${t.answers.slice().sort().join(', ')}`);
      else if (isMulticastIp(t.dst) && t.kind === 'udp') this.finish(t, false, `no member received it within ${'def' in t.timeout ? resolvedText(t.timeout as Resolved) : durationText(Number(t.timeout.value))}`);
      else if (t.answers.length) this.finish(t, true, `${t.answers.length} answer${t.answers.length === 1 ? '' : 's'}: ${t.answers.join(', ')}`);
      else this.finish(t, false, `no answer within ${'def' in t.timeout ? resolvedText(t.timeout as Resolved) : durationText(Number(t.timeout.value))} (timed out)${this.lastDrop(t)}`);
    });
    if (kind === 'icmp') this.ping(t, s.src, s.vrf);
    else if (kind === 'udp') this.udpRequest(t, s.src, s.vrf);
    else this.connect(t, s.src, s.vrf);
  }

  /** A timer of a test or a connection: it goes on in the Send test it belongs to (the engine's timers carry none). */
  private later(dt: number, fn: () => void): void {
    const id = this.e.testCtx;
    this.e.after(dt, () => this.e.withTest(id, fn));
  }

  /**
   * Why a Send test's traffic went unanswered, when the log knows: the last drop of one of its own
   * packets (a firewall's policy, no route, a VLAN a port doesn't carry …), so a timeout says where it ended.
   */
  private lastDrop(t: Test): string {
    if (t.source !== 'manual' && t.source !== 'experiment' && !t.app) return '';
    for (let i = this.e.log.length - 1; i >= 0; i--) {
      const ev = this.e.log[i];
      if (ev.t < t.started) break;
      if (ev.test === t.id && ev.kind === 'drop') return `; the last of its packets was dropped at ${ev.device}: ${ev.detail.replace(/^dropped at [^:]+: /, '')}`;
    }
    return '';
  }

  private finish(t: Test, ok: boolean, result: string): void {
    if (t.done) return;
    t.done = true;
    t.ended = this.e.now;
    t.ok = ok;
    t.result = result;
    if (ok && t.rtt === undefined) t.rtt = this.e.now - t.started;
    if (t.source !== 'health' && t.source !== 'probe' && t.source !== 'upstream') this.e.withTest(t.source === 'manual' || t.source === 'experiment' ? t.id : null, () => this.e.note('state', t.kind, t.from, '', ok ? 'Test answered' : 'Test failed', ok ? 'answered' : 'failed', `Test ${t.series}: ${result}${ok && t.rtt !== undefined ? ` (round trip ${rttText(t.rtt)})` : ''}`));
    if (t.onDone) t.onDone(t);
  }

  // ------------------------------------------------------------ ICMP

  private ping(t: Test, src: IpAddr, vrf: string): void {
    const pm = this.pathMtu(t.from, vrf, t.dst);
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
      // (respond to ping is per interface: the one the request came in on)
      const r = bc ? this.e.params.get('bcast-ping', dev) : this.e.params.get('ping', dev, null, ifaceRef(dev, l3.id));
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
      // (only about a packet this device sent: the quoted source is its own)
      if (!this.e.ownerOf(parseAddress(q.src) as IpAddr) || this.e.ownerOf(parseAddress(q.src) as IpAddr) !== dev) {
        this.e.note('drop', 'icmp', dev, '', pkt.msg.type, '', `${dev} ignores ${what}: it quotes ${q.src}, not one of its addresses`);
        return;
      }
      this.learnMtu(dev, pkt.vrf, dst, l4.mtu, `${what}`);
      // a TCP connection sends what is not acknowledged again, in smaller segments
      const c = this.connByFlow(dev, pkt.vrf, q);
      if (c && !c.tcp.idle) this.resend(c, `${what}: path MTU ${l4.mtu}`);
      const t = this.tests.find((x) => !x.done && x.from === dev && x.pktIds.indexOf(q.pkt) >= 0);
      if (t && t.kind !== 'tcp') this.finish(t, false, `${what}: ${t.df ? 'the packet is too big for the path and DF is set' : 'too big'} (path MTU ${l4.mtu})`);
      return;
    }
    const t = this.tests.find((x) => !x.done && x.from === dev && x.pktIds.indexOf(q.pkt) >= 0);
    if (t) {
      this.finish(t, false, what);
      return;
    }
    const c = this.connByFlow(dev, pkt.vrf, q);
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
    if (kind === 'frag' && mtu) this.learnMtu(dev, pkt.vrf, pkt.dst, mtu, `its own interface: ${text}`);
    if (t) {
      this.finish(t, false, `not sent: ${text}`);
      return;
    }
    const l4 = pkt.l4;
    if (!l4 || l4.proto !== 'tcp') return;
    const c = this.conn(dev, pkt.vrf, pkt.src, l4.sport as number, pkt.dst, l4.dport as number);
    if (!c) return;
    if (kind === 'frag') {
      this.resend(c, `${text}: its own interface`);
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
    // a datagram to a group: only members take it (a test counts them); nobody answers
    if (isMulticastIp(pkt.dst)) {
      if (this.multicast) this.multicast.dataIn(dev, l3, pkt);
      return;
    }
    const gw = this.P.sd(dev);
    const breaks = !!gw && gw.caps.sessionBreak && gw.caps.securityGateway;
    if (d.reply && breaks && this.breakAnswer(dev, pkt)) return;
    if (d.reply) {
      const t = this.tests.find((x) => x.id === d.test && x.from === dev);
      if (!t || t.done) return;
      t.answers.push(`${formatAddr(pkt.src)}${this.e.ownerOf(pkt.src) ? ' (' + this.e.ownerOf(pkt.src) + ')' : ''}`);
      if (!this.e.isBroadcastAddr(t.dst) && !isMulticastIp(t.dst)) this.finish(t, true, `UDP answer from ${formatAddr(pkt.src)}:${l4.sport}`);
      return;
    }
    if (!this.open(dev, 'udp', l4.dport as number, pkt.dst)) {
      this.refuse(dev, l3, pkt, this.listenText(dev, 'udp', l4.dport as number, pkt.dst));
      return;
    }
    const app = this.appAt(dev, 'udp', l4.dport as number, pkt.dst);
    const test = d.test !== undefined ? this.tests.find((x) => x.id === d.test) : undefined;
    if (test && test.oneWay && !test.done) {
      test.answers.push(`${dev}${app ? '/' + app.id : ''}`);
      if (test.rtt === undefined) test.rtt = this.e.now - test.started;
      this.withTestOf(test, () => this.finish(test, true, `received by ${dev}${app ? '/' + app.id : ''} on UDP ${l4.dport} (nothing comes back)`));
    }
    if (app && app.profile === 'udp_receiver') {
      this.e.note('message', 'udp', dev, this.e.ownerOf(pkt.src) || '', 'received', '', `${dev}/${app.id} (${app.name}) takes the datagram from ${formatAddr(pkt.src)}:${l4.sport}: a receiver answers nothing`);
      return;
    }
    // a one-way message to a listener that answers requests: it answers it too (its profile's behaviour)
    if (breaks && this.breakUdp(dev, l3, pkt)) return;
    // a protocol break's syslog leg 2 arrives at a collector: it answers nothing
    if ((pkt.msg.data as { breakLeg?: boolean } | undefined || {}).breakLeg && pkt.msg.type === 'Syslog message') return;
    const own = this.e.isBroadcastAddr(pkt.dst) || isMulticastIp(pkt.dst) ? l3.addrs.find((a) => a.addr.version === pkt.dst.version) : undefined;
    const src = own ? own.addr : pkt.dst;
    const rt = app && app.responseDelay !== undefined ? { value: app.responseDelay, text: `${durationText(app.responseDelay)} (${dev}/${app.id}'s response delay)` } : this.serviceTime(dev, 'udp', l4.dport as number);
    const bytes = app && app.responseSize !== undefined ? app.responseSize : UDP_RESPONSE;
    const answer = (): void => {
      const m = this.msg('udp', 'UDP answer', `UDP ← ${formatAddr(src)}:${l4.dport}`, `UDP ${formatAddr(src)}:${l4.dport} → ${formatAddr(pkt.src)}:${l4.sport}, ${bytes} bytes: the answer${app ? ` of ${dev}/${app.id} (${app.name})` : ''}${Number(rt.value) > 0 ? ' after ' + rt.text : ''}`, { test: d.test, reply: true });
      this.sendPkt(dev, src, pkt.src, pkt.vrf, m, { proto: 'udp', num: 17, sport: l4.dport, dport: l4.sport }, 8 + bytes, false, this.e.ownerOf(pkt.src) || '');
    };
    if (Number(rt.value) > 0) this.later(Number(rt.value), answer);
    else answer();
  }

  // ------------------------------------------------------------ TCP

  /** A connection's key on its device: its VRF and both ends (overlapping addresses in two VRFs are two connections). */
  private connKey(vrf: string, local: IpAddr, lport: number, remote: IpAddr, rport: number): string {
    return `${vrf}|${formatAddr(local)}:${lport}>${formatAddr(remote)}:${rport}`;
  }

  private conn(dev: string, vrf: string, local: IpAddr, lport: number, remote: IpAddr, rport: number): Conn | undefined {
    const m = this.conns.get(dev);
    return m ? m.get(this.connKey(vrf, local, lport, remote, rport)) : undefined;
  }

  private connByFlow(dev: string, vrf: string, q: NonNullable<L4['quote']>): Conn | undefined {
    const m = this.conns.get(dev);
    if (!m || q.sport === undefined || q.dport === undefined) return undefined;
    const a = parseAddress(q.src);
    const b = parseAddress(q.dst);
    return a && b ? m.get(this.connKey(vrf, a, q.sport, b, q.dport)) : undefined;
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

  /** A new connection end (its initial sequence number from its identity and a counter). */
  private newConn(o: { dev: string; vrf: string; local: IpAddr; lport: number; remote: IpAddr; rport: number; state: string; role: 'client' | 'server'; what: string; test?: Test; keep?: boolean }): Conn {
    const key = this.connKey(o.vrf, o.local, o.lport, o.remote, o.rport);
    const iss = initialSeq(o.dev + '|' + key, ++this.issCount);
    return { key, dev: o.dev, proto: 'tcp', local: o.local, lport: o.lport, remote: o.remote, rport: o.rport, vrf: o.vrf, state: o.state, role: o.role, since: this.e.now, heard: this.e.now, timer: null, tries: 0, rtx: 0, gen: 0, what: o.what, test: o.test, tcp: new TcpStream<ConnMsg>(iss), keep: !!o.keep, probes: 0 };
  }

  // ------------------------------------------------------------ applications' own connections (MQTT, BGP)

  /** the listeners of the applications' own protocols, by "device|port" */
  private appListening = new Map<string, { h: AppSocketHandlers; what: string; shown?: Shown }>();

  /**
   * An application listens on a TCP port of its device (an MQTT broker, a
   * BGP speaker): each connection gets a socket. `shown`: what its
   * connections' own segments are drawn as — or, by the connection's two
   * addresses, which of its configured peers it is (a BGP speaker knows its
   * neighbours by address), so that the handshake is that relation's.
   */
  appListen(dev: string, port: number, what: string, h: AppSocketHandlers, shown?: Shown): void {
    this.appListening.set(dev + '|' + port, { h, what, shown });
  }

  /** It stops listening (a BGP speaker going Idle): new connections to the port are refused again. */
  appUnlisten(dev: string, port: number): void {
    this.appListening.delete(dev + '|' + port);
  }

  /**
   * An application opens a connection (an MQTT client to its broker, a BGP
   * speaker to its peer): SYN with its retransmissions; `open` when it is
   * established, `closed` when it is refused or times out. A text when it
   * can't send. `from`: the source address (BGP's update source), else the
   * one the route gives; `vrf` with it.
   */
  appConnect(dev: string, dst: IpAddr, port: number, what: string, h: AppSocketHandlers, from?: { src: IpAddr; vrf: string }, shown?: { protocol: string; label: string; relation?: string }): AppSocket | string {
    const s = from || this.sourceFor(dev, dst);
    if (!s) return `${dev} has no IPv${dst.version} address to connect from`;
    const c = this.newConn({ dev, vrf: s.vrf, local: s.src, lport: this.ephemeral(dev), remote: dst, rport: port, state: 'SYN_SENT', role: 'client', what });
    if (shown) c.shown = shown;
    const sock = new AppSocket(this, c, h);
    c.sock = sock;
    this.addConn(c);
    this.sendSyn(c);
    return sock;
  }

  /** Send an application's message over its connection (segments by the path MTU, retransmitted until acknowledged). */
  appSend(sock: AppSocket, m: AppMessage): boolean {
    if (!sock.open) return false;
    this.write(sock.c, m.bytes, m.detail, { kind: 'app', app: m });
    (m as { sent?: number }).sent = this.e.now;
    return true;
  }

  /** Close an application's connection from its end (FIN after what it sent); it is told at once. */
  appClose(sock: AppSocket, why: string): void {
    const c = sock.c;
    this.sockClosed(sock, why);
    if (c.state === 'ESTABLISHED' || c.state === 'CLOSE_WAIT') this.close(c, `closes the connection (${why})`);
    else if (c.state === 'SYN_SENT' || c.state === 'SYN_RCVD') {
      if (c.state === 'SYN_RCVD') this.rst(c, why);
      this.closeConn(c, why);
    }
  }

  /** Reset an application's connection (BGP's NOTIFICATION, then the session goes): RST, gone at once. */
  appReset(sock: AppSocket, why: string): void {
    const c = sock.c;
    this.sockClosed(sock, why);
    if (c.state !== 'SYN_SENT') this.rst(c, why);
    this.closeConn(c, why);
  }

  /** Tell a socket its connection is gone (once). */
  private sockClosed(sock: AppSocket, why: string): void {
    if (sock.closedWhy !== null) return;
    sock.closedWhy = why;
    sock.h.closed(sock, why);
  }

  /** Open a connection for a test: SYN, retransmitted with backoff until answered or the SYN retries are spent. */
  private connect(t: Test, src: IpAddr, vrf: string): void {
    const c = this.newConn({ dev: t.from, vrf, local: src, lport: this.ephemeral(t.from), remote: t.dst, rport: t.port, state: 'SYN_SENT', role: 'client', what: t.source === 'upstream' ? `upstream for ${t.series}` : t.source === 'health' ? 'health check' : `test ${t.series}`, test: t, keep: t.keep });
    t.conn = c;
    this.addConn(c);
    this.sendSyn(c);
  }

  private rto(c: Conn): number {
    return Math.min(RTO_MAX, this.e.params.num('tcp-rto', c.dev) * Math.pow(2, c.tries));
  }

  private sendSyn(c: Conn): void {
    const s = c.tcp.syn(`opens a connection (${c.what})`);
    const p = this.emit(c, s);
    if (c.test) c.test.pktIds.push(p.id);
    this.armRtx(c);
  }

  /** Send data as one message of the connection (the request, the answer): segments of the MSS, the last marked. */
  private sendData(c: Conn, bytes: number, what: string): void {
    this.write(c, bytes, what, { kind: c.role === 'server' ? 'response' : 'request', bytes });
  }

  /** Write a message: its segments go out at once (no window), the retransmission timer runs while anything is unacknowledged. */
  private write(c: Conn, bytes: number, what: string, msg: ConnMsg): void {
    const segs = c.tcp.write(bytes, this.mss(c), what, msg);
    const n = segs.length;
    segs.forEach((s, i) => this.emit(c, s, n > 1 ? ` (segment ${i + 1} of ${n})` : ''));
    if (c.rtx === 0) this.armRtx(c);
  }

  /** Close this end (FIN after its data): FIN_WAIT_1 (it closes first) or LAST_ACK (the peer had closed: CLOSE_WAIT). */
  private close(c: Conn, what: string): void {
    if (c.tcp.finOut) return;
    const s = c.tcp.fin(what);
    this.setState(c, c.tcp.finIn ? 'LAST_ACK' : 'FIN_WAIT_1');
    this.emit(c, s);
    this.armRtx(c);
  }

  /** The MSS this end announces in its SYN (RFC 9293 §3.7.1): its interface's MTU towards the peer, less the IP and TCP headers. */
  private ownMss(c: Conn): number {
    const l3 = this.sourceFor(c.dev, c.remote, undefined, c.vrf);
    const own = l3 && l3.l3 ? Number(this.e.mtu(c.dev, l3.l3).value) : 1500;
    return Math.max(8, own - (c.remote.version === 4 ? 40 : 60));
  }

  /** The largest segment it sends: the smallest of its own MTU, the path MTU it learned, and the MSS the peer announced it can receive. */
  private mss(c: Conn): number {
    const pm = this.pathMtu(c.dev, c.vrf, c.remote);
    const hdr = c.remote.version === 4 ? 40 : 60;
    const byPath = pm ? Math.max(8, pm - hdr) : Infinity;
    return Math.max(8, Math.min(this.ownMss(c), byPath, c.peerMss !== undefined ? c.peerMss : Infinity));
  }

  /** The peer's SYN: its MSS option (none: the default of RFC 9293 §3.7.1, 536 bytes for IPv4, 1220 for IPv6). */
  private peerSyn(c: Conn, l4: L4): void {
    c.tcp.synIn(l4.seq || 0);
    c.peerMss = l4.mss !== undefined ? l4.mss : c.remote.version === 4 ? 536 : 1220;
  }

  /**
   * The path MTU went down (Fragmentation Needed / Packet Too Big): what is
   * unacknowledged is split for the new MSS over the same sequence range and
   * sent again at once (as Linux's tcp_simple_retransmit), the timer anew.
   */
  private resend(c: Conn, why: string): void {
    c.tcp.resegment(this.mss(c));
    const n = c.tcp.out.length;
    c.tcp.out.forEach((s, i) => {
      s.sent++;
      this.emit(c, s, `${n > 1 ? ` (segment ${i + 1} of ${n})` : ''}, sent again in smaller segments (${why})`);
    });
    this.armRtx(c);
  }

  /**
   * The retransmission timer (RFC 6298): one per connection while anything
   * sent is unacknowledged; when it runs out the earliest unacknowledged
   * segment goes again and the timeout doubles (at most 120 s), until the
   * retries are spent — the SYN retries for a SYN, 5 for a SYN-ACK
   * (Linux tcp_synack_retries), 8 for a FIN (tcp_orphan_retries), else 15
   * (tcp_retries2): then the connection is given up.
   */
  private armRtx(c: Conn): void {
    const tok = ++this.rtxTok;
    c.rtx = tok;
    if (c.tcp.idle) {
      c.rtx = 0;
      if (c.timer !== null && c.state !== 'TIME_WAIT' && c.state !== 'FIN_WAIT_2' && !c.keep) c.timer = null;
      return;
    }
    const wait = this.rto(c);
    c.timer = this.e.now + wait;
    this.later(wait, () => {
      if (c.rtx !== tok || c.tcp.idle) return;
      const s = c.tcp.earliest() as Seg<ConnMsg>;
      const max = s.syn && c.state === 'SYN_SENT' ? Number(this.e.params.get('tcp-syn-retries', c.dev).value) : s.syn ? SYNACK_RETRIES : s.fin ? FIN_RETRIES : DATA_RETRIES;
      if (c.tries >= max) {
        this.gaveUp(c, s);
        return;
      }
      c.tries++;
      s.sent++;
      this.emit(c, s, `, retransmission ${c.tries} (timeout ${durationText(this.rto({ ...c, tries: c.tries - 1 }))})`);
      if (s.syn && c.test && c.state === 'SYN_SENT') c.test.pktIds.push(this.lastPkt);
      this.armRtx(c);
    });
  }

  /** The retries are spent: the connection is given up (and its test or socket told). */
  private gaveUp(c: Conn, s: Seg<ConnMsg>): void {
    if (s.syn && c.state === 'SYN_SENT') {
      const max = this.e.params.get('tcp-syn-retries', c.dev);
      this.closeConn(c, `connection timed out: no answer to the SYN and its ${c.tries} retransmissions (TCP SYN retries ${resolvedText(max)})`);
      if (c.test) this.finish(c.test, false, `TCP connect timed out after ${c.tries} retransmissions`);
      return;
    }
    if (s.syn) {
      this.closeConn(c, `the handshake was not completed: no ACK to the SYN-ACK and its ${c.tries} retransmissions`);
      return;
    }
    if (s.fin) {
      this.closeConn(c, `closed: no acknowledgement of the FIN after ${c.tries} retransmissions`);
      return;
    }
    this.rst(c, 'no acknowledgement: given up');
    this.closeConn(c, `reset: no acknowledgement after ${c.tries} retransmissions`);
    if (c.test) this.finish(c.test, false, 'connection lost: the data was never acknowledged');
  }

  /**
   * The one way a connection ends (closed, reset, given up, its device
   * powered off): out of the table, CLOSED, and every timer of it void — the
   * retransmission timer's token, the state timers' generation — so that no
   * callback still holding it sends anything again.
   */
  private closeConn(c: Conn, why: string, log = true): void {
    if (c.sock) this.sockClosed(c.sock, why);
    const m = this.conns.get(c.dev);
    if (m && m.get(c.key) === c) m.delete(c.key);
    c.gen++;
    c.rtx = -1;
    c.timer = null;
    c.state = 'CLOSED';
    if (log) this.e.note('table', 'tcp', c.dev, this.e.ownerOf(c.remote) || '', 'connection closed', 'CLOSED', `${c.dev} ${formatAddr(c.local)}:${c.lport} ↔ ${formatAddr(c.remote)}:${c.rport} (${c.what}): ${why}`);
    // a proxy's two sides go together
    const other = c.upstream || c.front;
    if (other) {
      c.upstream = c.front = undefined;
      if (other.front === c) other.front = undefined;
      if (other.upstream === c) other.upstream = undefined;
    }
  }

  /** Is a connection still in its device's table (not closed)? */
  private alive(c: Conn): boolean {
    const m = this.conns.get(c.dev);
    return !!m && m.get(c.key) === c;
  }

  /** the last packet emit sent (a retransmitted SYN's, for its test) */
  private lastPkt = 0;

  /**
   * One segment of a connection on the wire: its sequence number, the
   * acknowledgment (RCV.NXT) once the peer's SYN is known, its flags, its
   * bytes, the MSS option on a SYN; a message's last segment carries the
   * message (its protocol, type and label when it is an application's). Its
   * label and log line give the flags of this header (tcp.ts's notation).
   */
  private emit(c: Conn, s: Seg<ConnMsg>, more = ''): Pkt {
    const synced = c.tcp.irs !== null;
    const flags = s.syn ? (synced ? ['SYN', 'ACK'] : ['SYN']) : s.fin ? ['FIN', 'ACK'] : s.mark ? ['PSH', 'ACK'] : ['ACK'];
    const l4: L4 = { proto: 'tcp', num: 6, sport: c.lport, dport: c.rport, flags, seq: s.seq, ack: synced ? c.tcp.ackNo : undefined };
    if (s.syn) l4.mss = this.ownMss(c);
    const app = s.mark && s.mark.msg.kind === 'app' ? s.mark.msg.app : undefined;
    const to = `${formatAddr(c.remote)}:${c.rport}`;
    const sh = c.shown;
    const label = segmentLabel({ flags, app: app ? app.label : undefined, owner: sh ? sh.label : undefined, bytes: s.len, to: s.syn && !synced ? to : undefined, retx: s.sent > 0 });
    const type = s.syn ? (synced ? 'TCP SYN-ACK' : 'TCP SYN') : s.fin ? 'TCP FIN' : s.len > 0 ? 'TCP data' : 'TCP ACK';
    // (an application's message: its own detail, then the segment's header; else what the segment is for)
    const detail = app ? `${app.detail} — ${this.segText(c, l4, s.len)}${more}` : `${sh ? sh.label + ' ' : ''}${this.segText(c, l4, s.len)}: ${s.what}${more}`;
    const data: { [k: string]: unknown } = { from: '', ...(app ? app.data : {}) };
    if (s.mark) data.tcpMark = { id: s.mark.id, end: s.mark.end, kind: s.mark.msg.kind, bytes: s.mark.msg.kind === 'app' ? s.mark.msg.app.bytes : s.mark.msg.bytes, label: app ? app.label : undefined, detail: app ? app.detail : undefined };
    if (app) data.appType = app.type;
    const msg: Msg = { protocol: (app ? app.protocol : sh ? sh.protocol : 'tcp') as Msg['protocol'], type: app ? app.type : type, label, detail, data, relation: app && app.relation ? app.relation : sh ? sh.relation : undefined };
    if (app && app.waited && s.sent === 0) msg.waited = app.waited;
    const p = this.sendPkt(c.dev, c.local, c.remote, c.vrf, msg, l4, 20 + s.len, true, this.e.ownerOf(c.remote) || '');
    this.lastPkt = p.id;
    return p;
  }

  /** A segment's header in the log's words: "TCP 10.0.1.10:49152 → 10.0.2.10:80 [S] seq 1000, MSS 1460". */
  private segText(c: { local: IpAddr; lport: number; remote: IpAddr; rport: number }, l4: L4, bytes: number): string {
    return `TCP ${formatAddr(c.local)}:${c.lport} → ${formatAddr(c.remote)}:${c.rport} ${tcpFlagsText(l4.flags)} seq ${l4.seq}${l4.ack !== undefined ? ', ack ' + l4.ack : ''}${bytes ? ', ' + bytes + ' bytes' : ''}${l4.mss !== undefined ? ', MSS ' + l4.mss : ''}`;
  }

  /** A segment of a connection without data (an acknowledgment, a keepalive probe, a RST): its label and log line from its flags. */
  private bare(c: Conn, l4: L4, what: string, keepalive = false): void {
    const sh = c.shown;
    const type = keepalive ? 'TCP keepalive' : (l4.flags || []).indexOf('RST') >= 0 ? 'TCP RST' : 'TCP ACK';
    const m = this.msg('tcp', type, segmentLabel({ flags: l4.flags || [], owner: sh ? sh.label : undefined, keepalive }), `${sh ? sh.label + ' ' : ''}${this.segText(c, l4, 0)}: ${what}`, {});
    if (sh) {
      m.protocol = sh.protocol as Msg['protocol'];
      if (sh.relation) m.relation = sh.relation;
    }
    this.sendPkt(c.dev, c.local, c.remote, c.vrf, m, l4, 20, true, this.e.ownerOf(c.remote) || '');
  }

  /** A segment without data: an acknowledgment (seq SND.NXT, ack RCV.NXT), or a keepalive probe (seq SND.NXT − 1). */
  private ackSeg(c: Conn, what: string, probe = false): void {
    this.bare(c, { proto: 'tcp', num: 6, sport: c.lport, dport: c.rport, flags: ['ACK'], seq: probe ? c.tcp.sndNxt - 1 : c.tcp.sndNxt, ack: c.tcp.ackNo }, what, probe);
  }

  /** This end aborts its connection (RFC 9293 §3.10.4 ABORT; as Linux, with the acknowledgment once synchronized): seq SND.NXT. */
  private rst(c: Conn, what: string): void {
    const synced = c.tcp.irs !== null;
    this.bare(c, { proto: 'tcp', num: 6, sport: c.lport, dport: c.rport, flags: synced ? ['RST', 'ACK'] : ['RST'], seq: c.tcp.sndNxt, ack: synced ? c.tcp.ackNo : undefined }, what);
  }

  /**
   * A RST answering a segment that is not acceptable where it arrives (a
   * closed port, a firewall's reject, a segment of no connection, an
   * acknowledgment of something never sent; RFC 9293 §3.10.7.1): when the
   * segment had an ACK, <SEQ=SEG.ACK><CTL=RST> — [R]; else
   * <SEQ=0><ACK=SEG.SEQ+SEG.LEN><CTL=RST,ACK> — [R,A]. Never to a RST.
   * `src`: the address it is sent from (a firewall answers for the
   * destination).
   */
  private rstFor(dev: string, pkt: Pkt, what: string, src?: IpAddr): void {
    const l4 = pkt.l4 as L4;
    const flags = l4.flags || [];
    if (flags.indexOf('RST') >= 0) return;
    const hasAck = flags.indexOf('ACK') >= 0;
    const space = Math.max(0, (pkt.len || 20) - 20) + (flags.indexOf('SYN') >= 0 ? 1 : 0) + (flags.indexOf('FIN') >= 0 ? 1 : 0);
    const out: L4 = hasAck ? { proto: 'tcp', num: 6, sport: l4.dport, dport: l4.sport, flags: ['RST'], seq: l4.ack || 0 } : { proto: 'tcp', num: 6, sport: l4.dport, dport: l4.sport, flags: ['RST', 'ACK'], seq: 0, ack: (l4.seq || 0) + space };
    const from = src || pkt.dst;
    const m = this.msg('tcp', 'TCP RST', segmentLabel({ flags: out.flags as string[] }), `${this.segText({ local: from, lport: l4.dport as number, remote: pkt.src, rport: l4.sport as number }, out, 0)}: ${what}`, {});
    this.sendPkt(dev, from, pkt.src, pkt.vrf, m, out, 20, true, this.e.ownerOf(pkt.src) || '');
  }

  /** Is a RST acceptable for a connection (RFC 9293 §3.10.7, RFC 5961: its sequence number at RCV.NXT; in SYN_SENT one that acknowledges the SYN)? */
  private rstOk(c: Conn, l4: L4): boolean {
    if (c.state === 'SYN_SENT') return (l4.flags || []).indexOf('ACK') >= 0 && l4.ack === c.tcp.sndNxt;
    return c.tcp.rcvNxt === null || l4.seq === c.tcp.rcvNxt;
  }

  /**
   * A segment arrives (RFC 9293 §3.10.7, in its order): no connection — a
   * SYN to a listening port opens one, anything else is answered with a
   * RST; a RST is taken only at its exact sequence number; SYN_SENT takes
   * only the SYN-ACK of its own SYN (an ACK of anything else gets [R]);
   * SYN_RCVD takes only the ACK of its SYN-ACK at the sequence number it
   * expects; in the synchronized states a SYN is answered with an ACK and
   * nothing else (RFC 5961 §4), an acknowledgment of something never sent
   * is answered with an ACK and the segment dropped, and the rest — the
   * acknowledgment, the data, the FIN — is the byte stream's.
   */
  private tcpIn(dev: string, l3: L3Iface, pkt: Pkt): void {
    const l4 = pkt.l4 as L4;
    const flags = l4.flags || [];
    const has = (f: string): boolean => flags.indexOf(f) >= 0;
    const vrf = l3.vrf;
    const c = this.conn(dev, vrf, pkt.dst, l4.dport as number, pkt.src, l4.sport as number);
    const bytes = Math.max(0, (pkt.len || 20) - 20);
    const ends = (x: Conn): string => `${formatAddr(x.local)}:${x.lport} ↔ ${formatAddr(x.remote)}:${x.rport}`;
    if (!c) {
      if (has('RST')) return;
      if (has('SYN') && !has('ACK')) {
        if (!this.open(dev, 'tcp', l4.dport as number, pkt.dst)) {
          this.refuse(dev, l3, pkt, this.listenText(dev, 'tcp', l4.dport as number, pkt.dst));
          return;
        }
        const sc = this.newConn({ dev, vrf, local: pkt.dst, lport: l4.dport as number, remote: pkt.src, rport: l4.sport as number, state: 'SYN_RCVD', role: 'server', what: `serves ${formatAddr(pkt.src)}` });
        const lh = this.appListening.get(dev + '|' + (l4.dport as number));
        if (lh) {
          sc.sock = new AppSocket(this, sc, lh.h);
          sc.what = `${lh.what}: a client at ${formatAddr(pkt.src)}`;
          if (lh.shown) sc.shown = typeof lh.shown === 'function' ? lh.shown(pkt.dst, pkt.src) : { ...lh.shown };
        }
        this.peerSyn(sc, l4);
        this.addConn(sc);
        this.emit(sc, sc.tcp.syn('accepts the connection'));
        this.armRtx(sc);
        return;
      }
      // a segment of no connection it knows
      this.e.note('drop', 'tcp', dev, '', pkt.msg.type, '', `${dev} has no connection ${formatAddr(pkt.dst)}:${l4.dport} ↔ ${formatAddr(pkt.src)}:${l4.sport}: it answers with a RST (${pkt.msg.label})`);
      this.rstFor(dev, pkt, 'no such connection');
      return;
    }
    if (has('RST')) {
      if (!this.rstOk(c, l4)) {
        this.e.note('drop', 'tcp', dev, '', 'TCP RST', c.state, `${dev} ignores a RST with sequence number ${l4.seq} on ${ends(c)} (expected ${c.state === 'SYN_SENT' ? 'an acknowledgment of its SYN' : c.tcp.rcvNxt})`);
        return;
      }
      const was = c.state;
      if (c.sock) this.sockClosed(c.sock, was === 'SYN_SENT' ? `connection refused: RST from ${formatAddr(pkt.src)}` : `connection reset by ${formatAddr(pkt.src)}`);
      this.closeConn(c, was === 'SYN_SENT' ? `connection refused (RST from ${formatAddr(pkt.src)})` : `reset by ${formatAddr(pkt.src)}`);
      if (c.test) this.finish(c.test, false, was === 'SYN_SENT' ? `connection refused: RST from ${formatAddr(pkt.src)}${this.e.ownerOf(pkt.src) ? ' (' + this.e.ownerOf(pkt.src) + ')' : ''}` : 'connection reset');
      if (c.front) this.upstreamFailed(c, 'the server reset the connection');
      return;
    }
    if (c.state === 'SYN_SENT') {
      // an acknowledgment of anything but its SYN: answered with a RST at that number (the attempt goes on)
      if (has('ACK') && l4.ack !== c.tcp.sndNxt) {
        this.e.note('drop', 'tcp', dev, '', pkt.msg.type, c.state, `${dev} is opening ${ends(c)}: the segment acknowledges ${l4.ack}, not its SYN (${c.tcp.sndNxt}): it answers with a RST`);
        this.rstFor(dev, pkt, `acknowledges ${l4.ack}, which was never sent`);
        return;
      }
      // only a SYN-ACK opens it (a simultaneous open, a SYN without ACK, is not modelled: ignored)
      if (!has('SYN') || !has('ACK')) return;
      c.heard = this.e.now;
      this.peerSyn(c, l4);
      c.tcp.ack(l4.ack as number);
      c.tries = 0;
      this.armRtx(c);
      this.setState(c, 'ESTABLISHED');
      this.e.note('table', 'tcp', dev, this.e.ownerOf(c.remote) || '', 'connection established', 'ESTABLISHED', `${dev} ${formatAddr(c.local)}:${c.lport} → ${formatAddr(c.remote)}:${c.rport} established (${c.what}; ISS ${c.tcp.iss}, IRS ${c.tcp.irs}; sends segments of at most ${this.mss(c)} bytes: the peer's MSS ${c.peerMss})`);
      // the handshake's third segment
      this.ackSeg(c, 'completes the handshake: the connection is open');
      const t = c.test;
      if (t && t.source === 'health') {
        // a TCP connect check (HAProxy's default layer-4 check): the connection is established, then closed at once with a RST
        this.rst(c, 'health check passed: closes the connection at once');
        this.closeConn(c, 'health check done');
        this.finish(t, true, 'connection established (the handshake completed), then closed with a RST');
        return;
      }
      if (c.sock) {
        if (c.sock.h.open) c.sock.h.open(c.sock);
        return;
      }
      if (t && t.keep && t.source === 'manual') {
        this.finish(t, true, `connected; kept open (keepalive after ${resolvedText(this.e.params.get('tcp-keepalive', dev))})`);
        this.idle(c);
        return;
      }
      this.sendData(c, t ? t.size : REQUEST_BYTES, t && t.source === 'upstream' ? 'the request, passed on' : 'the request');
      return;
    }
    if (c.state === 'SYN_RCVD') {
      // the client's SYN again (the SYN-ACK was lost): the SYN-ACK goes again
      if (has('SYN') && !has('ACK')) {
        const s = c.tcp.earliest();
        if (s && s.syn) {
          s.sent++;
          this.emit(c, s, ' (the client sent its SYN again)');
        }
        return;
      }
      if (!has('ACK')) return;
      // the sequence number first: the handshake's ACK (or the data that carries it) starts at RCV.NXT
      if (l4.seq !== c.tcp.rcvNxt) {
        this.e.note('drop', 'tcp', dev, '', pkt.msg.type, c.state, `${dev} drops a segment on ${ends(c)}: sequence number ${l4.seq}, it expects ${c.tcp.rcvNxt}; it acknowledges what it expects`);
        this.ackSeg(c, `an unacceptable sequence number (${l4.seq}): acknowledges ${c.tcp.rcvNxt}`);
        return;
      }
      if (l4.ack !== c.tcp.sndNxt) {
        this.e.note('drop', 'tcp', dev, '', pkt.msg.type, c.state, `${dev} drops a segment on ${ends(c)}: it acknowledges ${l4.ack}, not the SYN-ACK (${c.tcp.sndNxt}); it answers with a RST`);
        this.rstFor(dev, pkt, `acknowledges ${l4.ack}, not the SYN-ACK`);
        return;
      }
      c.heard = this.e.now;
      c.tcp.ack(l4.ack as number);
      c.tries = 0;
      this.armRtx(c);
      this.setState(c, 'ESTABLISHED');
      this.idle(c);
      if (c.sock && c.sock.h.accept) c.sock.h.accept(c.sock);
    } else {
      c.heard = this.e.now;
      c.probes = 0;
      if (has('SYN')) {
        // a SYN on a synchronized connection (a SYN-ACK again after a lost ACK, a stale SYN): an ACK of what it has, nothing else
        this.ackSeg(c, `a SYN on an open connection (seq ${l4.seq}): acknowledges ${c.tcp.ackNo}, changes nothing`);
        return;
      }
      if (!has('ACK')) return;
      if (l4.ack !== undefined && l4.ack > c.tcp.sndNxt) {
        // an acknowledgment of something never sent: the segment is dropped, its data never delivered
        this.e.note('drop', 'tcp', dev, '', pkt.msg.type, c.state, `${dev} drops a segment on ${ends(c)}: it acknowledges ${l4.ack}, beyond what was sent (${c.tcp.sndNxt}); it acknowledges what it has`);
        this.ackSeg(c, `acknowledges ${c.tcp.ackNo}: the segment acknowledged ${l4.ack}, which was never sent`);
        return;
      }
      if (c.state === 'TIME_WAIT') {
        // the peer's FIN again (its last ACK was lost): acknowledged again, TIME_WAIT starts again (RFC 9293 §3.10.7.4)
        if (has('FIN')) {
          this.ackSeg(c, 'the FIN again: acknowledges it again (TIME_WAIT starts again)');
          this.timeWait(c);
        }
        return;
      }
    }
    // an acknowledgment: what it covers leaves the retransmission queue (the timer starts again for the rest)
    if (l4.ack !== undefined && c.tcp.ack(l4.ack)) {
      c.tries = 0;
      this.armRtx(c);
      if (c.tcp.finAcked) {
        if (c.state === 'FIN_WAIT_1') this.finWait2(c);
        else if (c.state === 'CLOSING') this.timeWait(c);
        else if (c.state === 'LAST_ACK') {
          this.closeConn(c, 'closed');
          return;
        }
      }
    }
    const fin = has('FIN');
    if (bytes === 0 && !fin) {
      // a keepalive probe (its sequence number is one below RCV.NXT): it is answered
      if (c.tcp.rcvNxt !== null && l4.seq !== undefined && l4.seq < c.tcp.rcvNxt) this.ackSeg(c, 'answers the keepalive');
      if (c.keep && c.state === 'ESTABLISHED') this.idle(c);
      return;
    }
    const d = (pkt.msg.data || {}) as { tcpMark?: { id: number; end: number; kind: ConnMsg['kind']; bytes: number; label?: string; detail?: string } };
    let mark: StreamMark<ConnMsg> | undefined;
    if (d.tcpMark) {
      const k = d.tcpMark;
      const msg: ConnMsg = k.kind === 'app' ? { kind: 'app', app: { protocol: pkt.msg.protocol, type: pkt.msg.type, label: k.label || pkt.msg.type, detail: k.detail || '', bytes: k.bytes, data: pkt.msg.data || {}, relation: pkt.msg.relation } } : { kind: k.kind, bytes: k.bytes };
      mark = { id: k.id, end: k.end, msg };
    }
    const r = c.tcp.receive({ seq: l4.seq || 0, len: bytes, fin, mark });
    if (r.dup || r.outOfOrder) {
      // a duplicate (already delivered, never again) or a segment after a gap (kept): the acknowledgment says what is still missing
      this.ackSeg(c, r.dup ? `a duplicate (seq ${l4.seq}): acknowledges again, delivers nothing` : `out of order (seq ${l4.seq}, expected ${c.tcp.rcvNxt}): kept, acknowledges what is still missing`);
      return;
    }
    if (r.bytes > 0 && !r.fin && (c.state === 'ESTABLISHED' || c.state === 'FIN_WAIT_1' || c.state === 'FIN_WAIT_2')) this.ackSeg(c, `acknowledges ${r.bytes} bytes`);
    for (const m of r.msgs) {
      if (!this.alive(c)) break;
      this.delivered(c, m.msg, pkt);
    }
    if (r.fin && this.alive(c)) this.finIn(c, pkt);
  }

  /**
   * The peer's FIN arrived in order. ESTABLISHED: the peer closed its
   * direction (CLOSE_WAIT) — an application that handles it acknowledges
   * it and goes on sending until it closes; else (the test's request and
   * answer, BGP, MQTT) the application closes too, its FIN acknowledging
   * the peer's. FIN_WAIT_1 / FIN_WAIT_2: acknowledged, CLOSING or TIME_WAIT.
   */
  private finIn(c: Conn, pkt: Pkt): void {
    if (c.state === 'ESTABLISHED') {
      this.setState(c, 'CLOSE_WAIT');
      if (c.sock && c.sock.closedWhy === null && c.sock.h.peerClosed) {
        this.ackSeg(c, 'acknowledges the FIN: the peer has closed its direction');
        c.sock.h.peerClosed(c.sock);
        return;
      }
      if (c.sock) this.sockClosed(c.sock, `closed by ${formatAddr(pkt.src)} (FIN)`);
      this.close(c, 'closes its side as well (acknowledging the FIN)');
      return;
    }
    if (c.state === 'FIN_WAIT_1') {
      this.ackSeg(c, 'acknowledges the close');
      if (c.tcp.finAcked) this.timeWait(c);
      else this.setState(c, 'CLOSING');
      return;
    }
    if (c.state === 'FIN_WAIT_2') {
      this.ackSeg(c, 'acknowledges the close');
      this.timeWait(c);
    }
  }

  private finWait2(c: Conn): void {
    this.setState(c, 'FIN_WAIT_2');
    const g = ++c.gen;
    c.timer = this.e.now + FIN_TIMEOUT;
    this.later(FIN_TIMEOUT, () => {
      if (c.gen === g && c.state === 'FIN_WAIT_2') this.closeConn(c, `FIN_WAIT_2 timeout (${durationText(FIN_TIMEOUT)}): the peer never closed`);
    });
  }

  private timeWait(c: Conn): void {
    this.setState(c, 'TIME_WAIT');
    const g = ++c.gen;
    c.timer = this.e.now + TIME_WAIT;
    this.later(TIME_WAIT, () => {
      if (c.gen === g) this.closeConn(c, `TIME_WAIT over (${durationText(TIME_WAIT)})`);
    });
  }

  /** A whole message arrived (once, in order): an application's goes to its socket; a request to the server's logic; an answer to the client's. */
  private delivered(c: Conn, m: ConnMsg, pkt: Pkt): void {
    if (m.kind === 'app') {
      if (c.sock && c.sock.closedWhy === null) c.sock.h.message(c.sock, m.app);
      return;
    }
    // (a test's request on a port an application listens on too: answered as any server's)
    if (c.role === 'server') this.serverData(c, m.bytes, pkt);
    else this.answered(c);
  }

  /** The client got the whole answer: the test is answered; the client closes (unless kept open); an upstream passes it back. */
  private answered(c: Conn): void {
    const t = c.test;
    const got = c.tcp.received;
    if (c.front) {
      // an upstream connection: the answer goes back to the client
      const front = c.front;
      this.e.note('message', 'tcp', c.dev, this.e.ownerOf(front.remote) || '', 'relayed', '', `${c.dev} passes the answer of ${formatAddr(c.remote)}:${c.rport} back to ${formatAddr(front.remote)}:${front.rport}`);
      this.sendData(front, got, `the answer of ${formatAddr(c.remote)}`);
      this.idle(front);
    }
    if (t) this.finish(t, true, `connected and answered (${got} bytes)`);
    if (c.keep && t && t.source === 'manual') {
      this.idle(c);
      return;
    }
    this.close(c, 'closes the connection');
  }

  /** The server end got the whole request: it answers after its service response time; a load balancer or proxy passes it on. */
  private serverData(c: Conn, bytes: number, pkt: Pkt): void {
    void bytes;
    this.idle(c);
    if (c.answered) return;
    c.answered = true;
    const caps = this.P.sd(c.dev).caps;
    if (caps.loadBalancing && !c.upstream) {
      this.proxy(c, pkt);
      return;
    }
    const px = svcOf(this.P.m, c.dev, 'proxy');
    if (px && px.values.listener === c.lport && !c.upstream) {
      this.proxyService(c, px.values);
      return;
    }
    if (caps.sessionBreak && caps.securityGateway && !c.upstream) {
      this.breakTcp(c, pkt);
      return;
    }
    const app = this.appAt(c.dev, 'tcp', c.lport, c.local);
    const rt = app && app.responseDelay !== undefined ? { value: app.responseDelay, text: `${durationText(app.responseDelay)} (${c.dev}/${app.id}'s response delay)` } : this.serviceTime(c.dev, 'tcp', c.lport);
    const answer = (): void => {
      if (c.state !== 'ESTABLISHED') return;
      this.sendData(c, app && app.responseSize !== undefined ? app.responseSize : RESPONSE_BYTES, `the answer${app ? ` of ${c.dev}/${app.id} (${app.name})` : ''}${Number(rt.value) > 0 ? ' after ' + rt.text : ''}`);
    };
    if (Number(rt.value) > 0) this.later(Number(rt.value), answer);
    else answer();
  }

  /** Keepalive (a connection kept open): the idle timer of an open connection; its probes carry SND.NXT − 1, which the peer answers. */
  private idle(c: Conn): void {
    const g = ++c.gen;
    if (!c.keep) {
      if (c.rtx === 0) c.timer = null;
      return;
    }
    const ka = this.e.params.get('tcp-keepalive', c.dev);
    const at = c.probes ? KA_INTERVAL : Number(ka.value);
    c.timer = this.e.now + at;
    this.later(at, () => {
      if (c.gen !== g || c.state !== 'ESTABLISHED') return;
      if (c.probes >= KA_PROBES) {
        this.rst(c, 'keepalive: the peer is gone');
        this.closeConn(c, `reset: none of ${KA_PROBES} keepalive probes answered`);
        return;
      }
      c.probes++;
      this.ackSeg(c, 'keepalive', true);
      this.e.note('table', 'tcp', c.dev, '', 'keepalive', '', `${c.dev} probes the idle connection to ${formatAddr(c.remote)}:${c.rport} (probe ${c.probes} of ${KA_PROBES}; keepalive time ${resolvedText(ka)}, then every ${durationText(KA_INTERVAL)})`);
      const probes = c.probes;
      this.idle(c);
      c.probes = probes;
    });
  }

  // ------------------------------------------------------------ load balancers and proxies

  /** The servers of a device's own service relations (it is the client): a load balancer's pool, a proxy's upstream. */
  private upstreams(dev: string): Member[] {
    const out: Member[] = [];
    // a Load balancing service's backends, when written: its pool (on its service port)
    const lb = svcOf(this.P.m, dev, 'load_balancing');
    const backends = lb && Array.isArray(lb.values.backends) ? (lb.values.backends as string[]) : [];
    if (backends.length) {
      const port = typeof lb!.values.port === 'number' ? (lb!.values.port as number) : DEFAULT_TCP_PORT;
      for (const b of backends.slice().sort(cmp)) {
        const a = this.firstAddr(b);
        if (a) out.push({ dev: b, addr: a, port, kind: 'tcp', rel: '', up: true, fails: 0, oks: 0, last: 'not checked yet' });
      }
      return out;
    }
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

  /**
   * The relation a pool attribute is read from: a load balancer's pool is its
   * service relations to the members; the first (by id) that sets the
   * attribute, else the first (it inherits).
   */
  private poolRel(dev: string, key: string): string | null {
    const rels = this.pool(dev).members.map((m) => m.rel).sort(cmp);
    const own = rels.find((r) => this.e.params.objectValue(relRef(r), key) !== undefined);
    return own ? relRef(own) : rels.length ? relRef(rels[0]) : null;
  }

  /** The service relation of a server a request on this port belongs to (its response time), if any. */
  private serviceRel(dev: string, proto: string, port: number): string | null {
    for (const r of this.P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
      if (r.category !== 'service' || relationDevices(r).indexOf(dev) < 0) continue;
      const t = profileTransport(relationProfile(this.P.m, r).proto);
      if (t.proto === proto && (t.ports.indexOf(port) >= 0 || !t.ports.length)) return relRef(r.id);
    }
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
    const caps = this.P.sd(dev).caps;
    const p = this.pool(dev);
    let m: Member | undefined;
    let why = '';
    if (caps.loadBalancing) {
      const healthy = p.members.filter((x) => x.up);
      const client = formatAddr(front.remote);
      const per = this.e.params.get('lb-persistence', dev, null, this.poolRel(dev, 'lb-persistence'));
      const st = p.sticky.get(client);
      if (st && Number(per.value) > 0 && this.e.now - st.at <= Number(per.value)) {
        m = healthy.find((x) => x.dev === st.member);
        if (m) why = `persistence: ${client} stays with ${m.dev} (persistence timeout ${resolvedText(per)})`;
      }
      if (!m && healthy.length) {
        // (a Load balancing service's algorithm, when written, is its configuration)
        const svcAlg = svcOf(this.P.m, dev, 'load_balancing');
        const alg = svcAlg && typeof svcAlg.values.algorithm === 'string' ? { value: svcAlg.values.algorithm as string, source: 'configured' as const, where: 'its Load balancing service', def: paramDef('lb-algorithm') } : this.e.params.get('lb-algorithm', dev, null, this.poolRel(dev, 'lb-algorithm'));
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
      this.e.note('drop', 'tcp', dev, '', 'no upstream', '', `${dev} has no ${caps.loadBalancing ? 'healthy pool member' : 'upstream server (a service relation of its own)'} for the request of ${formatAddr(front.remote)}: it answers with an error`);
      this.sendData(front, 200, caps.loadBalancing ? 'an error: 503 Service Unavailable (no healthy member)' : 'an error: 502 Bad Gateway (no upstream)');
      return;
    }
    this.e.note('message', 'tcp', dev, m.dev, 'proxied', '', `${dev} passes the request of ${formatAddr(front.remote)}:${front.rport} on to ${m.dev} ${formatAddr(m.addr)}:${m.port}: ${why}`);
    const limit = undefined as Resolved | undefined;
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

  /**
   * A protocol break, TCP: the request ended at the gateway (leg 1). When its
   * policy permits the transfer profile for this source, the gateway opens a
   * connection of its own to the profile's forward address (leg 2), after its
   * transfer delay; the answer comes back on leg 2 and goes to the client on
   * leg 1. Not permitted: leg 1 is reset, nothing is started.
   */
  private breakTcp(front: Conn, pkt: Pkt): void {
    const dev = front.dev;
    const sd = this.P.sd(dev);
    const l3 = Array.from(sd.l3.values()).find((l) => l.addrs.some((a) => compareAddr(a.addr, front.local) === 0));
    const at = l3 ? profileAt(sd.dev, l3.id, 'tcp', front.lport) : undefined;
    const d = at && l3 ? this.e.sep.breakDecision(sd.dev, l3.id, pkt, at.profile.id) : null;
    if (!at || !d || !d.ok || !d.forward) {
      if (!at) this.e.note('drop', 'tcp', dev, '', 'denied', '', `${dev}: no transfer profile listens at ${l3 ? l3.id : formatAddr(front.local)} port ${front.lport}: leg 1 ends here, no leg 2 is started`);
      this.rst(front, 'not a permitted transfer');
      this.closeConn(front, 'not a permitted transfer');
      return;
    }
    const delay = this.e.sep.delay(sd.dev, pkt, `transfer profile ${at.profile.id}`);
    if (delay === null) return;
    const fwd = d.forward;
    const target = this.e.ownerOf(fwd.address) || '';
    const start = (): void => {
      if (front.state !== 'ESTABLISHED') return;
      this.e.note('message', 'tcp', dev, target, 'leg 2', '', `protocol break at ${dev}: the ${at.kind.label.toLowerCase()} of ${formatAddr(front.remote)}:${front.rport} ended at ${l3 ? l3.id : dev} port ${front.lport} (leg 1); ${dev} starts its own connection to ${formatAddr(fwd.address)}:${fwd.port} (leg 2, profile ${at.profile.id}, ${d.text.replace(/^[^:]*: /, '')}); nothing of leg 1 crosses`);
      const t = this.run({ from: dev, target, dst: fwd.address, kind: 'tcp', port: fwd.port, source: 'upstream', series: `${dev} leg 2 (${at.profile.id})`, front, timeout: { value: 3600000 } });
      if (typeof t === 'string') {
        this.e.note('drop', 'tcp', dev, '', 'leg 2 failed', '', `${dev} can't start leg 2: ${t}`);
        this.rst(front, 'leg 2 failed');
        this.closeConn(front, 'leg 2 failed');
        return;
      }
      if (t.conn) {
        t.conn.front = front;
        front.upstream = t.conn;
      }
      t.onDone = (x) => {
        if (!x.ok) this.upstreamFailed(x.conn || front, x.result, front);
      };
    };
    if (delay > 0) this.later(delay, start);
    else start();
  }

  /**
   * A protocol break, UDP: a datagram to a transfer profile's port ends at
   * the gateway; a permitted one is sent on as a new datagram of its own to
   * the profile's forward address. A DNS answer comes back to the gateway
   * and goes to the asker as the gateway's answer; a syslog message has none.
   */
  private breakUdp(dev: string, l3: L3Iface, pkt: Pkt): boolean {
    const sd = this.P.sd(dev);
    const l4 = pkt.l4 as L4;
    const at = profileAt(sd.dev, l3.id, 'udp', l4.dport as number);
    if (!at) return false;
    const d = this.e.sep.breakDecision(sd.dev, l3.id, pkt, at.profile.id);
    if (!d || !d.ok || !d.forward) return true;
    const delay = this.e.sep.delay(sd.dev, pkt, `transfer profile ${at.profile.id}`);
    if (delay === null) return true;
    const fwd = d.forward;
    const src = this.sourceFor(dev, fwd.address);
    if (!src) {
      this.e.note('drop', 'udp', dev, '', 'leg 2 failed', '', `${dev} has no address to send leg 2 to ${formatAddr(fwd.address)} from`);
      return true;
    }
    const data = (pkt.msg.data || {}) as { test?: number };
    const send = (): void => {
      const sport = this.ephemeral(dev);
      if (at.kind.reply) this.udpRelays.set(`${dev}|${sport}`, { client: pkt.src, cport: l4.sport as number, local: pkt.dst, lport: l4.dport as number, vrf: pkt.vrf, test: data.test, profile: at.profile.id });
      const m = this.msg('udp', at.kind.label, `UDP → ${formatAddr(fwd.address)}:${fwd.port}`, `protocol break at ${dev}: leg 2 of the ${at.kind.label.toLowerCase()} from ${formatAddr(pkt.src)}, a new datagram ${formatAddr(src.src)}:${sport} → ${formatAddr(fwd.address)}:${fwd.port} (profile ${at.profile.id})`, { breakLeg: true });
      this.sendPkt(dev, src.src, fwd.address, src.vrf, m, { proto: 'udp', num: 17, sport, dport: fwd.port }, 8 + 64, false, this.e.ownerOf(fwd.address) || '');
      this.e.note('message', 'udp', dev, this.e.ownerOf(fwd.address) || '', 'leg 2', '', `protocol break at ${dev}: the ${at.kind.label.toLowerCase()} from ${formatAddr(pkt.src)}:${l4.sport} ended at ${l3.id} port ${l4.dport} (leg 1); ${dev} sends its own to ${formatAddr(fwd.address)}:${fwd.port} (leg 2)${at.kind.reply ? '; the answer will come back to it' : '; nothing comes back'}`);
    };
    if (delay > 0) this.later(delay, send);
    else send();
    return true;
  }

  /** A protocol break's answer on leg 2: it goes to the client as the gateway's own answer on leg 1. */
  private breakAnswer(dev: string, pkt: Pkt): boolean {
    const l4 = pkt.l4 as L4;
    const k = `${dev}|${l4.dport}`;
    const r = this.udpRelays.get(k);
    if (!r) return false;
    this.udpRelays.delete(k);
    const m = this.msg('udp', 'UDP answer', `UDP ← ${formatAddr(r.local)}:${r.lport}`, `protocol break at ${dev}: the answer of leg 2 from ${formatAddr(pkt.src)} goes to ${formatAddr(r.client)}:${r.cport} as ${dev}'s own answer on leg 1 (profile ${r.profile})`, { test: r.test, reply: true });
    this.sendPkt(dev, r.local, r.client, r.vrf, m, { proto: 'udp', num: 17, sport: r.lport, dport: r.cport }, 8 + UDP_RESPONSE, false, this.e.ownerOf(r.client) || '');
    return true;
  }

  /**
   * The Proxy service: the client's connection ends at the proxy (its
   * listener port), and the proxy opens a connection of its own to its
   * upstream (a reverse proxy's server, a forward proxy's parent); the answer
   * goes back on the client's connection. A forward proxy without a parent
   * would go to the address the client asks for: test traffic names none,
   * so it says so and answers with an error.
   */
  private proxyService(front: Conn, v: { [k: string]: unknown }): void {
    const dev = front.dev;
    const up = typeof v.upstream === 'string' ? parseAddress(v.upstream) : null;
    const port = typeof v.upstream_port === 'number' ? (v.upstream_port as number) : DEFAULT_TCP_PORT;
    if (!up) {
      this.e.note('note', 'tcp', dev, '', 'no upstream', '', `${dev} is a forward proxy without a parent: it would open a connection to the address the client asks for, which a simulated test does not name — it answers with an error (a limitation of the simulation)`);
      this.sendData(front, 200, 'an error: 502 Bad Gateway (no destination named)');
      return;
    }
    const target = this.e.ownerOf(up) || '';
    this.e.note('message', 'tcp', dev, target, 'proxied', '', `${dev} (${v.mode} proxy) ends the connection of ${formatAddr(front.remote)}:${front.rport} at port ${front.lport} and opens its own to ${formatAddr(up)}:${port}`);
    const t = this.run({ from: dev, target, dst: up, kind: 'tcp', port, source: 'upstream', series: `${dev} → ${target || formatAddr(up)} (proxy upstream)`, front, timeout: { value: 3600000 } });
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
  }

  private upstreamFailed(c: Conn, why: string, front?: Conn): void {
    const f = front || c.front;
    if (!f || f.state !== 'ESTABLISHED') return;
    if (c.state === 'SYN_SENT') this.closeConn(c, `given up: ${why}`);
    this.e.note('drop', 'tcp', f.dev, '', 'upstream failed', '', `${f.dev}: the upstream connection failed (${why}); ${formatAddr(f.remote)} gets an error`);
    this.sendData(f, 200, 'an error: 502 Bad Gateway');
  }

  // ------------------------------------------------------------ periodic tests

  /** Endpoint test traffic: every test interval, when it is on, to each target. */
  private startTraffic(): void {
    for (const d of Array.from(this.P.e.net.devices.values()).sort((a, b) => cmp(a.id, b.id))) {
      if (!d.caps.testTraffic || !d.l3.size) continue;
      const dev = d.id;
      // all endpoints together, once the network had time to come up
      const first = 3000 + this.e.jitter(dev);
      this.P.periodic(
        () => true,
        () => this.e.params.num('test-interval', dev),
        () => {
          // optional traffic: where its parameter says so (the Senders choose what is shown, never what is generated)
          if (this.e.params.str('test-traffic', dev) !== 'on' || !this.e.deviceOn(dev)) return;
          for (const x of this.targets(dev)) {
            if (typeof x === 'string') continue;
            this.run({ from: dev, target: x.label, dst: x.dst, name: x.name, kind: x.kind, port: x.port, source: 'traffic' });
          }
        },
        first,
      );
    }
  }

  /** An endpoint's test targets: its own, else its gateway (ICMP echo) and the servers of its service relations (their protocol and port). */
  targets(dev: string): Array<{ dst: IpAddr; kind: TestKind; port: number; label: string; name?: string } | string> {
    const type = this.e.params.str('test-type', dev);
    // multicast: a UDP datagram to every group joined in the model (but its own), to RTP's port
    if (type === 'multicast' && this.multicast) {
      const own = new Set(this.multicast.joined(dev).map((j) => j.group));
      return this.multicast.groups().filter((g) => !own.has(g)).map((g) => ({ dst: parseAddress(g) as IpAddr, kind: 'udp' as TestKind, port: 5004, label: g }));
    }
    const kind = (type === 'multicast' ? 'udp' : type) as TestKind;
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
      if (!d.caps.loadBalancing) continue;
      const dev = d.id;
      const p = this.pool(dev);
      if (!p.members.length) continue;
      // each member by its own relation's health check (its interval and timeout; else the simulation's or the default)
      for (const m of p.members) {
        this.P.periodic(
          () => true,
          () => this.e.params.num('lb-hc-interval', dev, null, relRef(m.rel)),
          () => {
            if (!this.e.deviceOn(dev)) return;
            const timeout = this.e.params.get('lb-hc-timeout', dev, null, relRef(m.rel));
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
          },
          2000 + this.e.jitter(dev),
          dev,
        );
      }
    }
  }

  private checked(dev: string, m: Member, t: Test): void {
    const fall = this.e.params.get('lb-hc-fall', dev, null, relRef(m.rel));
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
        2500 + this.e.jitter(dev),
        dev,
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
    const l4 = pkt.l4;
    const dd = this.P.m.index.devices.get(dev);
    // the model's relations (and its demands) are the firewall's policy; protocols without a transport header (and IGMP) pass
    if (pkt.msg.relation || pkt.rides.length || pkt.msg.protocol === 'demand' || !l4 || l4.proto === 'other' || l4.proto === 'igmp') return true;
    const proto = l4.proto as 'tcp' | 'udp' | 'icmp';
    const tab = this.fwTable(dev);
    // (a written policy says whether it is stateful; a firewall's sessions otherwise; a router's policy is stateless)
    const stateful = dd ? policyStateful(dd, capabilities(dd).firewallPolicy && this.e.params.get('fw-stateful', dev).value === 'on') : false;
    // traffic between the endpoints of a service relation on its port (a test of it, and its answers) is the relation's
    const rel = this.relationFor(pkt);
    const sp = proto === 'icmp' ? l4.echoId || 0 : l4.sport || 0;
    const dp = proto === 'icmp' ? l4.echoId || 0 : l4.dport || 0;
    // (a session is its opening packet's ingress VRF's: overlapping addresses in two VRFs are two sessions; a reply leaves by that VRF)
    const fwd = `${from.vrf}|${proto}|${formatAddr(pkt.src)}:${sp}>${formatAddr(pkt.dst)}:${dp}`;
    const rev = `${to.vrf}|${proto}|${formatAddr(pkt.dst)}:${dp}>${formatAddr(pkt.src)}:${sp}`;
    const flags = l4.flags || [];
    if (stateful) {
      // an ICMP error about a session's packet belongs to it
      if (proto === 'icmp' && l4.quote) {
        const q = l4.quote;
        const qk = `${to.vrf}|${q.proto}|${q.src}:${q.sport || 0}>${q.dst}:${q.dport || 0}`;
        const qr = `${from.vrf}|${q.proto}|${q.dst}:${q.dport || 0}>${q.src}:${q.sport || 0}`;
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
    const opening = proto !== 'tcp' || (flags.indexOf('SYN') >= 0 && flags.indexOf('ACK') < 0);
    const echoReq = proto !== 'icmp' || l4.icmpType === 8 || l4.icmpType === 128;
    // a written network policy: its rules decide each packet (analysis/policy.ts, the engine the path tracer uses)
    if (dd && dd.policy) {
      const d = policyDecision(this.P.m, dd, { src: pkt.src, dst: pkt.dst, proto, sport: proto === 'icmp' ? undefined : l4.sport, dport: proto === 'icmp' ? undefined : l4.dport, srcDev: this.e.ownerOf(pkt.src), dstDev: this.e.ownerOf(pkt.dst), inIface: from.id, outIface: to.id }) as PolicyDecision;
      // (stateful: only what opens a flow is decided by the rules; the rest belongs to a session or is dropped)
      if (d.permit && (!stateful || (opening && echoReq))) {
        if (stateful) {
          const s: FwSession = { key: fwd, proto, flow: `${formatAddr(pkt.src)}${proto === 'icmp' ? '' : ':' + sp} → ${formatAddr(pkt.dst)}${proto === 'icmp' ? ' (echo ' + sp + ')' : ':' + dp}`, state: proto === 'tcp' ? 'SYN' : 'ACTIVE', created: this.e.now, last: this.e.now, rule: d.ruleText || 'default permit', timeout: proto === 'tcp' ? 'fw-half-open' : proto === 'udp' ? 'fw-udp' : 'fw-icmp' };
          tab.set(fwd, s);
          this.e.note('table', proto, dev, '', 'session opened', s.state, `${dev} opens a session ${s.flow} (${s.rule}, in ${from.id})`);
        }
        return true;
      }
      const what0 = `${proto === 'icmp' ? (pkt.dst.version === 4 ? 'ICMP' : 'ICMPv6') + ' ' + (l4.icmpName || '') : proto.toUpperCase() + ' ' + formatAddr(pkt.src) + ':' + l4.sport + ' → ' + formatAddr(pkt.dst) + ':' + l4.dport}`;
      const why0 = d.permit ? 'it belongs to no session it knows (a stateful policy)' : d.text.replace(/^\S+ denies [^:]*: /, '');
      const fwAct = capabilities(dd).firewallPolicy ? this.e.params.get('fw-action', dev) : null;
      const reject = !!fwAct && fwAct.value === 'reject';
      this.e.note('drop', proto, dev, '', reject ? 'rejected' : 'dropped', '', `${dev} ${reject ? 'rejects' : 'drops'} ${what0} (${pkt.msg.label}): ${why0}`);
      if (reject) {
        if (proto === 'tcp') {
          this.rstFor(dev, pkt, `rejected by ${dev}`, pkt.dst);
        } else this.e.icmpError(dev, pkt, 'admin', { from });
      }
      return false;
    }
    const allow = parsePorts(String(this.e.params.get('fw-allow', dev).value) || 'none');
    const rules = 'list' in allow ? allow.list : [];
    const port = proto === 'icmp' ? 0 : (l4.dport as number);
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
      this.rstFor(dev, pkt, `rejected by ${dev}`, pkt.dst);
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
      if (!this.P.sd(dev).caps.loadBalancing) continue;
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

/** An IPv6 link-local address (fe80::/10), or IPv4 169.254/16. */
function isLinkLocalAddr(a: IpAddr): boolean {
  return a.version === 6 ? isLinkLocal6(a) : a.bytes[0] === 169 && a.bytes[1] === 254;
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

/** A device's service of the registry (its values), when it runs it. */
function svcOf(m: Model, dev: string, id: string): ServiceInstance | undefined {
  const d = m.index.devices.get(dev);
  return d && d.appServices ? d.appServices.get(id) : undefined;
}

/** What a device listens on: the port rules, whether its `listening` attribute wrote them, and the rule in words. */
export interface Listening {
  rules: PortRule[];
  written: boolean;
  text: string;
}

/** The ports of the relations a device serves (a load balancer: also those it passes requests on to). */
export function relationServerPorts(m: Model, dev: string): PortRule[] {
  const rules: PortRule[] = [];
  const d = m.index.devices.get(dev);
  const relay = !!d && capabilities(d).loadBalancing;
  for (const r of m.relations) {
    const devs = relationDevices(r);
    if (devs.indexOf(dev) < 0) continue;
    const prof = relationProfile(m, r);
    const t = profileTransport(prof.proto);
    if (t.proto === 'other') continue;
    // a load balancer listens on the ports of the services it passes on
    const server = prof.behaviour === 'service' || prof.behaviour === 'custom' ? relay || (prof.fromServer ? devs.slice(0, -1).indexOf(dev) >= 0 : devs[devs.length - 1] === dev) : true;
    if (!server) continue;
    for (const p of t.ports) if (!rules.some((x) => x.proto === t.proto && x.from === p)) rules.push({ proto: t.proto, from: p, to: p });
  }
  return rules;
}

/**
 * The ports a device listens on, for the simulation and the static analysis
 * alike: its `listening` attribute when it has one (`own`: the value in
 * effect), else a protocol break's transfer profiles, else the ports of the
 * relations it serves, of its services and applications, and of what a
 * container publishes.
 */
export function deviceListening(m: Model, dev: string, own: ParamValue | undefined): Listening {
  if (own !== undefined) {
    const r = parsePorts(String(own) || 'none');
    return { rules: 'list' in r ? r.list : [], written: true, text: `listening ${String(own) || 'on nothing'} (device)` };
  }
  const md = m.index.devices.get(dev);
  const caps = md ? capabilities(md) : null;
  if (md && caps && caps.sessionBreak && caps.securityGateway) {
    const prof = (md.separation ? md.separation.profiles : []).filter((x) => x.listenPort !== undefined && TRANSFER_PROFILES.some((k) => k.id === x.type));
    const pr: PortRule[] = prof.map((x) => ({ proto: (TRANSFER_PROFILES.find((k) => k.id === x.type) as (typeof TRANSFER_PROFILES)[number]).transport, from: x.listenPort as number, to: x.listenPort as number }));
    return { rules: pr, written: false, text: pr.length ? `listening on its transfer profiles' ports: ${prof.map((x) => `${x.id} at ${x.listenInterface} port ${x.listenPort}`).join(', ')}` : 'a protocol break without transfer profiles: no port open' };
  }
  const rules = relationServerPorts(m, dev);
  // the ports of the services it runs (NTP, AAA, syslog, a proxy's listener, storage, an application …)
  for (const x of serviceListening(md)) if (!rules.some((y) => y.proto === x.proto && y.from === x.from)) rules.push(x);
  // a container serves the ports it publishes
  if (md && isContainer(md)) for (const i of md.logical) for (const p of i.publish || []) if (!rules.some((x) => x.proto === p.protocol && x.from === p.port)) rules.push({ proto: p.protocol, from: p.port, to: p.port });
  rules.sort((a, b) => cmp(a.proto, b.proto) || a.from - b.from);
  return { rules, written: false, text: rules.length ? `listening on the ports of the relations it serves${md && isContainer(md) ? ' and the ports it publishes' : ''}: ${rules.map((r) => r.proto + '/' + r.from).join(', ')}` : 'serving no relation: no port open' };
}

/** The interfaces a port is bound to, when only bound applications listen on it (else null: all addresses). */
export function boundInterfaces(m: Model, dev: string, proto: 'tcp' | 'udp', port: number, relRules: PortRule[] = relationServerPorts(m, dev)): string[] | null {
  const md = m.index.devices.get(dev);
  const mine = appListeners(md).filter((x) => x.proto === proto && x.port === port);
  if (!mine.length || mine.some((x) => x.bind === undefined)) return null;
  if (serviceListeners(md).some((x) => x.proto === proto && x.port === port)) return null;
  if (portsMatch(relRules, proto, port)) return null;
  return mine.map((x) => x.bind as string);
}

/** The `listening` attribute a device's model writes (its `simulation:` block), undefined when it writes none. */
export function writtenListening(d: Device | undefined): ParamValue | undefined {
  const v = d && d.simulation ? d.simulation.get('listening') : undefined;
  return v === undefined ? undefined : v;
}

/** The ports a device's services and applications listen on (analysis/listeners.ts). */
export function serviceListening(d: Device | undefined): PortRule[] {
  const out: PortRule[] = [];
  for (const x of deviceListeners(d)) if (!out.some((y) => y.proto === x.proto && y.from === x.port)) out.push({ proto: x.proto, from: x.port, to: x.port });
  return out;
}

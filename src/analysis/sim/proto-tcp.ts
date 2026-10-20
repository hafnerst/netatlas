/**
 * The sessions of the protocols that run over TCP (BGP and its EVPN and
 * L3VPN, LDP and its targeted sessions, HTTPS, SSL VPN): their messages go
 * over a connection of the common transport (transport.ts, tcp.ts) — its
 * handshake, listener, firewall sessions, retransmission, segmentation by
 * the path MTU, reset and close, and the connection table — never over an
 * imitation of TCP of their own.
 *
 * One side connects (the behaviour says which: BGP's initiator, LDP's
 * active side, a service's client); every device with such a session
 * listens on the protocol's port while the session runs. An accepted
 * connection belongs to no session until its first message names the
 * relation it is for; a connection that names none (no such session
 * there) is reset. Each message arrives at the behaviour's rx as if sent
 * by unicast; the connection opening and closing arrive at its `tcp`.
 */
import { compareAddr, formatAddr } from '../ipmath';
import { profileTransport } from './transport';
import type { AppMessage, AppSocket } from './transport';
import { Behaviour, ProtocolSim, Sess, ipOf } from './protocols';
import { Msg } from './types';

/** What a behaviour hears of its session's connection. */
export interface TcpBehaviour extends Behaviour {
  /** the connection is open (the connecting side: established; the listening side: its first message bound it), or gone */
  tcp?(P: ProtocolSim, s: Sess, ev: 'open' | 'closed', why: string): void;
}

/** The TCP port of a session's profile ("TCP 179" → 179; "UDP/TCP 646" → 646). */
export function tcpPort(s: Sess): number {
  const m = /\bTCP\s+([0-9]{1,5})/.exec(s.profile.proto) || /\bUDP\/TCP\s+([0-9]{1,5})/.exec(s.profile.proto);
  if (m) return Number(m[1]);
  const t = profileTransport(s.profile.proto);
  return t.ports[0] || 0;
}

function socks(P: ProtocolSim): Map<AppSocket, Sess> {
  let m = P.shared.get('tcp-socks') as Map<AppSocket, Sess> | undefined;
  if (!m) P.shared.set('tcp-socks', (m = new Map()));
  return m;
}

function beh(P: ProtocolSim, s: Sess): TcpBehaviour {
  return P.behaviours.get(s.profile.behaviour) as TcpBehaviour;
}

/** A message of the session from its connection: to the behaviour's rx, as a unicast one would. */
function deliver(P: ProtocolSim, s: Sess, m: AppMessage): void {
  s.heard = P.e.now;
  const msg: Msg = { protocol: s.protocol, type: m.type, label: m.label, detail: m.detail, relation: s.rel.id, data: m.data };
  beh(P, s).rx(P, s, msg, null, null);
  P.learn(s, msg);
}

/** A connection of a session is gone: the behaviour hears of it once (an older connection of the session says nothing). */
function closed(P: ProtocolSim, sock: AppSocket, why: string): void {
  const s = socks(P).get(sock);
  socks(P).delete(sock);
  if (!s || s.x.sock !== sock) return;
  s.x.sock = null;
  const b = beh(P, s);
  if (b.tcp) b.tcp(P, s, 'closed', why);
}

/**
 * The device listens on the session's port (once per device and port).
 * What arrives on an accepted connection names its relation and sender:
 * the connection is that session's from then on.
 */
export function tcpListen(P: ProtocolSim, s: Sess): void {
  const port = tcpPort(s);
  const key = `tcp-listen|${s.dev}|${port}`;
  if (!P.transport || P.shared.has(key)) return;
  P.shared.set(key, true);
  const dev = s.dev;
  P.transport.appListen(dev, port, `${s.profile.label.replace(/ \(.*\)$/, '')} (port ${port})`, {
    message(sock, m) {
      let o = socks(P).get(sock);
      if (!o) {
        const d = (m.data || {}) as { rel?: string; proto?: string; from?: string };
        o = d.rel && d.proto && d.from ? P.sess(d.proto, d.rel, dev, d.from) : undefined;
        if (!o || !o.x.started) {
          P.e.note('drop', d.proto || 'tcp', dev, d.from || '', m.type, '', `${dev} has no ${m.label.split(' ')[0]} session ${d.rel ? 'of ' + d.rel + ' ' : ''}with ${d.from || formatAddr(sock.remote)}: it resets the connection`);
          sock.reset('no such session');
          return;
        }
        const cur = o.x.sock as AppSocket | null | undefined;
        if (cur && cur !== sock && cur.open) {
          // a second connection for a session that has one: the session keeps the one it has when it is up (RFC 4271 §6.8), else takes the new one
          if (o.up) {
            P.e.note('drop', o.protocol, dev, o.peer, m.type, o.state, `${o.profile.label} ${o.rel.id}: ${dev} already has its session with ${o.peer} up: the new connection is closed (connection collision)`);
            sock.reset('connection collision: the session is up on another connection');
            return;
          }
          socks(P).delete(cur);
          cur.reset('replaced by a new connection of the peer');
        }
        o.x.sock = sock;
        socks(P).set(sock, o);
        sock.show(o.protocol, o.profile.label.replace(/ \(.*\)$/, '').replace(/ \/ .*$/, ''), o.rel.id);
        const b = beh(P, o);
        if (b.tcp) b.tcp(P, o, 'open', `${o.peer} connected from ${formatAddr(sock.remote)}`);
      }
      deliver(P, o, m);
    },
    closed(sock, why) {
      closed(P, sock, why);
    },
  }, (local, remote) => {
    // the session whose addresses the connection has (its configured peer): its relation's handshake; else the protocol's
    const o = Array.from(P.sessions.values())
      .filter((x) => x.dev === dev && x.x.started && tcpPort(x) === port && compareAddr(ipOf(x.local), local) === 0 && compareAddr(ipOf(x.remote), remote) === 0)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
    const by = o || s;
    return { protocol: by.protocol, label: by.profile.label.replace(/ \(.*\)$/, '').replace(/ \/ .*$/, ''), relation: o ? o.rel.id : undefined };
  });
}

/** The session's side connects to its peer (from the session's own address and VRF); nothing when it already has a connection. */
export function tcpConnect(P: ProtocolSim, s: Sess): boolean {
  if (!P.transport) return false;
  const cur = s.x.sock as AppSocket | null | undefined;
  if (cur && cur.closedWhy === null) return true;
  const port = tcpPort(s);
  const short = s.profile.label.replace(/ \(.*\)$/, '').replace(/ \/ .*$/, '');
  const sock = P.transport.appConnect(s.dev, ipOf(s.remote), port, `${short} ${s.rel.id} to ${s.peer}`, {
    open(k) {
      if (s.x.sock !== k) return;
      const b = beh(P, s);
      if (b.tcp) b.tcp(P, s, 'open', `TCP connection to ${formatAddr(ipOf(s.remote))}:${port} established`);
    },
    message(k, m) {
      if (s.x.sock === k) deliver(P, s, m);
    },
    closed(k, why) {
      closed(P, k, why);
    },
  }, { src: ipOf(s.local), vrf: s.local.l3.vrf }, { protocol: s.protocol, label: short, relation: s.rel.id });
  if (typeof sock === 'string') {
    P.e.note('drop', s.protocol, s.dev, s.peer, 'TCP', s.state, `${s.profile.label} ${s.rel.id}: ${s.dev} can't connect: ${sock}`);
    return false;
  }
  s.x.sock = sock;
  socks(P).set(sock, s);
  return true;
}

/** Is the session's connection open (established, not closed)? */
export function tcpOpen(s: Sess): boolean {
  const k = s.x.sock as AppSocket | null | undefined;
  return !!k && k.open;
}

/**
 * A message of the session over its connection (its size on the wire
 * `bytes`): drawn and logged as the protocol's, carried as TCP data. False
 * when the connection is not open (nothing is sent).
 */
export function tcpSend(P: ProtocolSim, s: Sess, type: string, detail: string, bytes: number, data: { [k: string]: unknown } = {}): boolean {
  const k = s.x.sock as AppSocket | null | undefined;
  if (!k || !k.open) return false;
  const short = s.profile.label.replace(/ \(.*\)$/, '').replace(/ \/ .*$/, '');
  const m: AppMessage = {
    protocol: s.protocol,
    type,
    label: `${short} ${type}`,
    detail: `${s.profile.label} ${type}: ${s.dev} (${formatAddr(k.local)}) → ${s.peer} (${formatAddr(k.remote)}), TCP ${k.rport === tcpPort(s) ? k.rport : k.lport}; ${detail}`,
    bytes,
    data: { ...data, rel: s.rel.id, proto: s.protocol },
    relation: s.rel.id,
  };
  if (s.x.waitedNext) {
    m.waited = s.x.waitedNext as string[];
    delete s.x.waitedNext;
  }
  // (its dots in the logical view are its segments', drawn by the transport as it sends them)
  return k.send(m);
}

/** Close the session's connection (FIN after what it sent; `reset`: RST at once). */
export function tcpClose(P: ProtocolSim, s: Sess, why: string, reset = false): void {
  const k = s.x.sock as AppSocket | null | undefined;
  s.x.sock = null;
  if (!k) return;
  socks(P).delete(k);
  if (reset) k.reset(why);
  else k.close(why);
}

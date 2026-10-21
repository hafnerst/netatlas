/**
 * The routing protocols' behaviours in the simulation: OSPF, IS-IS, EIGRP,
 * RIP, BGP (and the BGP-based EVPN and L3VPN), LDP (and the targeted LDP
 * of pseudowires and VPLS) and BFD. Each follows its profile's message
 * sequence and state machine (model/sim-profiles.ts) with the timers the
 * model sets or the defaults; see protocols.ts for how sessions are built.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { normalizeProtocol } from '../../model/protocols';
import { bgpAsn, routerIdFor } from '../../model/services';
import { compareAddr, formatAddr } from '../ipmath';
import { areaKey } from '../checks-more';
import { lookup, relParam } from '../routing';
import { fmtSec, hashIndex } from './engine';
import { durationText } from './params';
import { ADV_RXMT, Behaviour, ProtocolSim, Sess, ipOf } from './protocols';
import { TcpBehaviour, tcpClose, tcpConnect, tcpListen, tcpSend } from './proto-tcp';
import { RipEntry } from './rip';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const addr = (s: string): IpAddr => parseAddress(s) as IpAddr;

/** A device's router ID for a protocol: its configured one, else its highest loopback IPv4 address, else its highest IPv4 address. */
export function routerId(P: ProtocolSim, dev: string, protocol: string): string {
  const d = P.m.index.devices.get(dev);
  const own = routerIdFor(d, protocol);
  if (own && own.address) return own.address;
  const sd = P.sd(dev);
  const v4 = (loop: boolean): IpAddr[] => {
    const out: IpAddr[] = [];
    for (const l of sd.l3.values()) if ((l.kind === 'loopback') === loop) for (const a of l.addrs) if (a.addr.version === 4) out.push(a.addr);
    return out.sort(compareAddr);
  };
  const l = v4(true);
  if (l.length) return formatAddr(l[l.length - 1]);
  const a = v4(false);
  return a.length ? formatAddr(a[a.length - 1]) : dev;
}

/** After `ms`, if nothing was heard from the peer for `ms`, call `dead` (checked again while something is heard). */
function deadCheck(P: ProtocolSim, s: Sess, ms: number, dead: () => void): void {
  P.armDead(s, ms, dead);
}

/** Every `ms()` (from now), while the session's generation lasts; a parameter change reschedules it. */
function every(P: ProtocolSim, s: Sess, ms: () => number, fn: () => void): void {
  const g = s.gen;
  P.periodic(() => s.gen === g, ms, fn);
}

/**
 * The BFD sessions that serve a client session: those on its interface or between its addresses; a client between
 * loopbacks (BGP …), not on a link of its own, every BFD session of the device to that peer.
 */
function bfdFor(P: ProtocolSim, c: Sess): Sess[] {
  const all = Array.from(P.sessions.values()).filter((b) => b.profile.behaviour === 'bfd' && b.dev === c.dev && b.peer === c.peer);
  const same = all.filter((b) => b.local.l3.id === c.local.l3.id || (formatAddr(ipOf(b.local)) === formatAddr(ipOf(c.local)) && formatAddr(ipOf(b.remote)) === formatAddr(ipOf(c.remote))));
  return same.length || c.local.l3.kind !== 'loopback' ? same : all;
}

/** Tell the protocols that BFD session serves (RFC 5882 §4: its own clients — on its interface, between its addresses) that it went down. */
export function bfdDown(P: ProtocolSim, bs: Sess): void {
  for (const s of Array.from(P.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
    if (s.dev !== bs.dev || s.peer !== bs.peer || !s.up) continue;
    if (['ospf', 'isis', 'eigrp', 'bgp', 'evpn', 'l3vpn'].indexOf(s.protocol) < 0) continue;
    if (bfdFor(P, s).indexOf(bs) < 0) continue;
    const b = P.behaviours.get(s.profile.behaviour) as Behaviour & { down?: (P: ProtocolSim, s: Sess, why: string) => void };
    if (b.down) b.down(P, s, 'BFD session down');
  }
}

// ------------------------------------------------------------------ OSPF

/** An OSPF network type (the relation's `network-type`; broadcast unless written, point-to-point on a tunnel). */
type OspfType = 'broadcast' | 'point-to-point' | 'non-broadcast' | 'point-to-multipoint';

/** A session's view of its neighbour, from the neighbour's last Hello. */
interface OspfX {
  rid?: string;
  sent?: boolean;
  peerRid?: string;
  peerPrio?: number;
  /** the DR and BDR the neighbour declares (router IDs, '' none) */
  peerDr?: string;
  peerBdr?: string;
  /** the last incompatibility noted (said once until it changes) */
  mismatch?: string;
  /** the database exchange (RFC 2328 §10.6, §10.8): this router's DD sequence number, whether it is master, the neighbour's initial DD sequence number (the master's for a slave: its answer's number), the last DBD problem noted */
  dd?: number;
  master?: boolean;
  peerInit?: number;
  ddNote?: string;
  /** the last DBD received and accepted from the neighbour (its I and MS bits, DD sequence number): what a duplicate is (RFC 2328 §10.6) */
  lastRx?: { i: boolean; ms: boolean; dd: number };
  /** the last DBD this router sent in the exchange: what a slave sends again for a duplicate */
  lastTx?: () => void;
}

/**
 * An OSPF interface (RFC 2328 §9): its state, and on a broadcast or
 * non-broadcast network the DR and BDR it elected. Shared by every OSPF
 * session of the device on that interface (all relations: the segment's
 * neighbours are the interface's, never one relation's).
 */
interface OspfIf {
  dev: string;
  iface: string;
  type: OspfType;
  state: 'Down' | 'Waiting' | 'DR' | 'Backup' | 'DROther' | 'Point-to-point';
  dr: string;
  bdr: string;
  drDev: string;
  bdrDev: string;
  gen: number;
}

function ospfType(s: Sess): OspfType {
  const v = (relParam(s.rel, 'network-type', s.dev) || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (v === 'point-to-point' || v === 'non-broadcast' || v === 'point-to-multipoint' || v === 'broadcast') return v;
  return s.local.l3.kind === 'tunnel' ? 'point-to-point' : 'broadcast';
}

/** Does a network type elect a DR and BDR (broadcast and non-broadcast multi-access networks)? */
function elects(t: OspfType): boolean {
  return t === 'broadcast' || t === 'non-broadcast';
}

/** The router priority of a device on a relation (`priority.<device>`, else `priority`; 0–255; 0: never DR or BDR). Default 1. */
function ospfPrio(s: Sess): number {
  const v = relParam(s.rel, 'priority', s.dev);
  if (v === undefined || !/^\s*[0-9]+\s*$/.test(v)) return 1;
  const n = Number(v);
  return n <= 255 ? n : 1;
}

function ospfArea(s: Sess): string {
  return areaKey(relParam(s.rel, 'area', s.dev) || '0');
}

/** The device's OSPF sessions on one interface, every relation (the segment's neighbours as that router sees them). */
function onIface(P: ProtocolSim, dev: string, iface: string): Sess[] {
  return Array.from(P.sessions.values())
    .filter((o) => o.dev === dev && o.protocol === 'ospf' && o.local.l3.id === iface)
    .sort((a, b) => cmp(a.key, b.key));
}

function ospfIf(P: ProtocolSim, s: Sess): OspfIf {
  const k = `ospf-if|${s.dev}|${s.local.l3.id}`;
  let f = P.shared.get(k) as OspfIf | undefined;
  if (!f) {
    f = { dev: s.dev, iface: s.local.l3.id, type: ospfType(s), state: 'Down', dr: '', bdr: '', drDev: '', bdrDev: '', gen: 0 };
    P.shared.set(k, f);
  }
  return f;
}

/**
 * The interface comes up (RFC 2328 §9.3 InterfaceUp): point-to-point and
 * point-to-multipoint at once; a broadcast or non-broadcast one waits —
 * Waiting, for the Wait timer (the router dead interval) unless a Hello
 * shows a DR or BDR already there (BackupSeen) — before its first election.
 */
function ospfIfUp(P: ProtocolSim, s: Sess): void {
  const f = ospfIf(P, s);
  if (f.state !== 'Down') return;
  f.gen++;
  f.dr = f.bdr = f.drDev = f.bdrDev = '';
  if (!elects(f.type)) {
    f.state = 'Point-to-point';
    return;
  }
  f.state = 'Waiting';
  const dead = P.timer(s, s.profile, 'dead');
  const g = f.gen;
  P.e.note('state', 'ospf', s.dev, '', 'Waiting', 'Waiting', `OSPF ${s.dev}:${f.iface} (${f.type}): Waiting — no DR election before the Wait timer (${dead.text}) expires or a Hello shows a DR or BDR already elected`);
  P.e.after(dead.ms, () => {
    if (f.gen !== g || f.state !== 'Waiting') return;
    ospfElect(P, s.dev, f.iface, `the Wait timer expired (${dead.text})`, true);
  });
}

function ospfIfDown(P: ProtocolSim, dev: string, iface: string): void {
  const f = P.shared.get(`ospf-if|${dev}|${iface}`) as OspfIf | undefined;
  if (!f || f.state === 'Down') return;
  f.gen++;
  f.state = 'Down';
  f.dr = f.bdr = f.drDev = f.bdrDev = '';
}

const ridCmp = (a: string, b: string): number => {
  const x = parseAddress(a);
  const y = parseAddress(b);
  return x && y ? compareAddr(x, y) : cmp(a, b);
};

/**
 * The DR election of one interface (RFC 2328 §9.4): among this router and
 * its neighbours in 2-Way or more with a priority above 0. The BDR is the
 * best of those that do not declare themselves DR (those declaring
 * themselves BDR first); the DR the best of those declaring themselves DR,
 * else the BDR. Highest priority, then highest router ID. Non-preemptive:
 * a router already declared DR or BDR keeps the role when a better one
 * appears. No eligible router: no DR at all (and no adjacencies beyond
 * 2-Way on the segment). The adjacencies follow the result (AdjOK?).
 */
function ospfElect(P: ProtocolSim, dev: string, iface: string, why: string, endWait = false): void {
  const sessions = onIface(P, dev, iface);
  if (!sessions.length) return;
  const s0 = sessions[0];
  const f = ospfIf(P, s0);
  if (f.state === 'Down' || !elects(f.type)) return;
  // a Waiting interface elects only when its Wait ends (the Wait timer, BackupSeen); a neighbour change waits with it
  if (f.state === 'Waiting' && !endWait) return;
  const first = f.state === 'Waiting';
  if (first) f.state = 'DROther';
  const me = routerId(P, dev, 'ospf');
  type Cand = { dev: string; rid: string; prio: number; declDr: boolean; declBdr: boolean };
  const self: Cand = { dev, rid: me, prio: ospfPrio(s0), declDr: f.dr === me, declBdr: f.bdr === me };
  const others: Cand[] = [];
  for (const o of sessions) {
    const x = o.x as OspfX;
    if (!x.peerRid || ['Down', 'Init'].indexOf(o.state) >= 0 || others.some((c) => c.rid === x.peerRid)) continue;
    others.push({ dev: o.peer, rid: x.peerRid, prio: x.peerPrio === undefined ? 1 : x.peerPrio, declDr: x.peerDr === x.peerRid, declBdr: x.peerBdr === x.peerRid });
  }
  const best = (list: Cand[]): Cand | null => list.slice().sort((a, b) => b.prio - a.prio || ridCmp(b.rid, a.rid))[0] || null;
  const round = (): { dr: Cand | null; bdr: Cand | null } => {
    const elig = [self].concat(others).filter((c) => c.prio > 0);
    const noDr = elig.filter((c) => !c.declDr);
    const bdr = best(noDr.some((c) => c.declBdr) ? noDr.filter((c) => c.declBdr) : noDr);
    const declared = elig.filter((c) => c.declDr);
    const dr = declared.length ? best(declared) : bdr;
    return { dr, bdr: bdr && dr && bdr.rid === dr.rid ? null : bdr };
  };
  let r = round();
  // this router's own role changed: it declares the new one, and the election runs again (§9.4 step 4)
  for (let i = 0; i < 3; i++) {
    const isDr = !!r.dr && r.dr.rid === me;
    const isBdr = !!r.bdr && r.bdr.rid === me;
    if (isDr === self.declDr && isBdr === self.declBdr) break;
    self.declDr = isDr;
    self.declBdr = isBdr;
    r = round();
  }
  // (a BDR promoted to DR here leaves no BDR until that router's own election, which runs again as DR, names one in its Hellos)
  const was = `${f.dr}|${f.bdr}`;
  f.dr = r.dr ? r.dr.rid : '';
  f.drDev = r.dr ? r.dr.dev : '';
  f.bdr = r.bdr ? r.bdr.rid : '';
  f.bdrDev = r.bdr ? r.bdr.dev : '';
  f.state = f.drDev === dev ? 'DR' : f.bdrDev === dev ? 'Backup' : 'DROther';
  if (first || was !== `${f.dr}|${f.bdr}`) {
    const res = f.dr ? `DR ${f.dr} (${f.drDev})${f.bdr ? `, BDR ${f.bdr} (${f.bdrDev})` : ', no BDR'}` : 'no DR: no router on the segment has a priority above 0';
    P.e.note('state', 'ospf', dev, '', f.state, f.state, `OSPF ${dev}:${iface} DR election (${why}): ${res}; this router is ${f.state === 'Backup' ? 'BDR' : f.state}`);
  }
  for (const o of sessions) ospfAdjOk(P, o);
}

/** Should the router form an adjacency with this neighbour (RFC 2328 §10.4)? */
function ospfShouldAdj(P: ProtocolSim, s: Sess): boolean {
  const f = ospfIf(P, s);
  if (!elects(f.type)) return true;
  if (f.state === 'Waiting' || f.state === 'Down') return false;
  return [f.drDev, f.bdrDev].some((d) => !!d && (d === s.dev || d === s.peer));
}

/** AdjOK?: a neighbour in 2-Way becomes adjacent (ExStart) when it should; one that should no longer goes back to 2-Way. */
function ospfAdjOk(P: ProtocolSim, s: Sess): void {
  const x = s.x as OspfX;
  if (s.state === '2-Way' && ospfShouldAdj(P, s)) {
    ospfExStart(P, s, 'master / slave negotiation');
  } else if (['ExStart', 'Exchange', 'Loading', 'Full'].indexOf(s.state) >= 0 && !ospfShouldAdj(P, s)) {
    P.restart(s);
    x.sent = false;
    const f = ospfIf(P, s);
    P.setState(s, '2-Way', false, `no adjacency any more: neither is DR or BDR (DR ${f.dr || 'none'}, BDR ${f.bdr || 'none'})`);
    ospfRearm(P, s);
  }
  ospfDetail(P, s);
}

/**
 * ExStart (RFC 2328 §10.8): an empty DBD with I, M and MS set, its own DD
 * sequence number and its interface MTU, sent again until answered.
 */
function ospfExStart(P: ProtocolSim, s: Sess, why: string): void {
  const x = s.x as OspfX;
  P.setState(s, 'ExStart', false, why);
  x.dd = 1 + (hashIndex(`${s.key}|${P.e.now}`, 100000) as number);
  x.master = undefined;
  x.peerInit = undefined;
  x.lastRx = undefined;
  x.lastTx = undefined;
  const mtu = ospfMtu(P, s);
  ospfRetransmit(P, s, 'ExStart', () => P.unicast(s, 'DBD', `ExStart: I, M, MS bits set, DD sequence ${x.dd}, interface MTU ${mtu}, router ID ${x.rid}`, { phase: 'init', dd: x.dd, mtu, rid: x.rid }, 'ExStart'));
}

/**
 * SeqNumberMismatch (RFC 2328 §10.6, §10.3): a DBD that does not belong to
 * the exchange this router is in (the neighbour started over, or the
 * numbers are not the next ones): the adjacency goes back to ExStart and
 * negotiates anew. The neighbour's timers are kept (it is still heard).
 */
function ospfSeqMismatch(P: ProtocolSim, s: Sess, why: string): void {
  P.restart(s);
  (s.x as OspfX).sent = false;
  ospfRearm(P, s);
  P.e.note('state', 'ospf', s.dev, s.peer, 'SeqNumberMismatch', 'ExStart', `OSPF ${s.rel.id}: ${s.dev} → ${s.peer}: ${why} — back to ExStart`);
  ospfExStart(P, s, `SeqNumberMismatch: ${why}`);
}

/**
 * Send a packet of the database exchange, and again every retransmit
 * interval while the neighbour stays in that state (RFC 2328 §10.8: an
 * unanswered DBD or LSR is sent again).
 */
function ospfRetransmit(P: ProtocolSim, s: Sess, state: string, send: () => void): void {
  send();
  const g = s.gen;
  const again = (): void => {
    if (s.gen !== g || s.state !== state) return;
    send();
    P.later(s, P.timer(s, s.profile, 'rxmt').ms, again);
  };
  P.later(s, P.timer(s, s.profile, 'rxmt').ms, again);
}

/** A restart forgets the session's timers: its dead timer again (the neighbour is still heard). */
function ospfRearm(P: ProtocolSim, s: Sess): void {
  const dead = P.timer(s, s.profile, 'dead');
  deadCheck(P, s, dead.ms, () => ospfDown(P, s, `dead interval expired (${dead.text}): no Hello from ${s.peer}`));
}

function ospfDetail(P: ProtocolSim, s: Sess): void {
  const f = ospfIf(P, s);
  const x = s.x as OspfX;
  const role = elects(f.type) ? (f.state === 'Waiting' ? ' · Waiting (no DR yet)' : f.dr ? ` · DR ${f.dr}${f.bdr ? ', BDR ' + f.bdr : ''}${f.state === 'DR' ? ' (this router is DR)' : f.state === 'Backup' ? ' (this router is BDR)' : ''}` : ' · no DR (no eligible router)') : ` · ${f.type}`;
  s.x.detail = `router ID ${x.rid}, priority ${ospfPrio(s)}${role}`;
}

/** Hellos go out once per device, relation and interface (all its neighbours there hear them). */
function ospfHellos(P: ProtocolSim, s: Sess): void {
  const key = `ospf-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
  if (P.shared.has(key)) return;
  P.shared.set(key, true);
  const group = addr(ipOf(s.local).version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string));
  P.periodic(
    () => true,
    () => P.timer(s, s.profile, 'hello').ms,
    () => {
      if (!P.e.isL3Up(s.dev, s.local.l3.id) || !P.e.deviceOn(s.dev)) return;
      const f = ospfIf(P, s);
      if (f.state === 'Down') ospfIfUp(P, s);
      const rid = routerId(P, s.dev, 'ospf');
      const prio = ospfPrio(s);
      const hello = P.timer(s, s.profile, 'hello');
      const dead = P.timer(s, s.profile, 'dead');
      const seen = Array.from(new Set(onIface(P, s.dev, s.local.l3.id).filter((o) => o.state !== 'Down').map((o) => (o.x as OspfX).peerRid).filter((x): x is string => !!x)));
      const area = ospfArea(s);
      P.multicast(s, group, 'Hello', `router ID ${rid}, area ${relParam(s.rel, 'area', s.dev) || '0'}, priority ${prio}, hello ${hello.text}, dead ${dead.text}, ${f.type}, neighbours seen: ${seen.length ? seen.join(', ') : 'none'}${elects(f.type) ? `, DR ${f.dr || '0.0.0.0'}, BDR ${f.bdr || '0.0.0.0'}` : ''}`, { rid, prio, seen, hello: hello.ms, dead: dead.ms, area, type: f.type, dr: f.dr, bdr: f.bdr });
    },
  );
}

/** The MTU of the session's interface (what its DBDs announce, and the most it takes). */
function ospfMtu(P: ProtocolSim, s: Sess): number {
  return Number(P.e.mtu(s.dev, s.local.l3).value);
}

/** Why a neighbour's Hello can't make an adjacency (RFC 2328 §10.5: the intervals and the area must match; the network types too, in the simulation); '' when it can. */
function ospfMismatch(P: ProtocolSim, s: Sess, d: { hello?: number; dead?: number; area?: string; type?: string }): string {
  const hello = P.timer(s, s.profile, 'hello');
  const dead = P.timer(s, s.profile, 'dead');
  if (d.hello !== undefined && d.hello !== hello.ms) return `hello interval ${fmtSec(d.hello)} in its Hello, ${hello.text} here`;
  if (d.dead !== undefined && d.dead !== dead.ms) return `dead interval ${fmtSec(d.dead)} in its Hello, ${dead.text} here`;
  if (d.area !== undefined && d.area !== ospfArea(s)) return `area ${d.area} in its Hello, ${ospfArea(s)} here`;
  const t = ospfIf(P, s).type;
  if (d.type !== undefined && d.type !== t) return `network type ${d.type} there, ${t} here`;
  return '';
}

function ospfDown(P: ProtocolSim, s: Sess, why: string): void {
  if (s.state === 'Down') return;
  const was = s.state;
  P.restart(s);
  const x = s.x as OspfX;
  x.sent = false;
  P.setState(s, 'Down', false, why);
  // a neighbour lost (NeighborChange): the segment's DR and BDR again
  if (['Init', 'Down'].indexOf(was) < 0) ospfElect(P, s.dev, s.local.l3.id, `${s.peer} is gone`);
}

const ospf: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  start(P, s) {
    const x = s.x as OspfX;
    x.rid = routerId(P, s.dev, 'ospf');
    if (!P.shared.has('ospf-hooks')) {
      P.shared.set('ospf-hooks', true);
      // a device powered off: its interfaces' elections are gone (it starts over when it boots)
      P.deviceHooks.push((dev, up) => {
        if (up) return;
        for (const k of Array.from(P.shared.keys())) if (k.indexOf(`ospf-if|${dev}|`) === 0) ospfIfDown(P, dev, k.split('|')[2]);
      });
    }
    ospfIfUp(P, s);
    ospfDetail(P, s);
    ospfHellos(P, s);
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { rid?: string; prio?: number; seen?: string[]; reply?: boolean; phase?: string; hello?: number; dead?: number; area?: string; type?: string; dr?: string; bdr?: string };
    const x = s.x as OspfX;
    switch (msg.type) {
      case 'Hello': {
        if (!P.e.isL3Up(s.dev, s.local.l3.id)) return;
        const bad = ospfMismatch(P, s, d);
        if (bad) {
          // RFC 2328 §10.5: the Hello is discarded; no state is kept from it (an adjacency up so far dies by its dead interval)
          if (x.mismatch !== bad) {
            x.mismatch = bad;
            P.e.note('drop', 'ospf', s.dev, s.peer, 'Hello ignored', s.state, `OSPF ${s.rel.id}: ${s.dev} discards ${s.peer}'s Hello: ${bad} — no adjacency`);
          }
          return;
        }
        x.mismatch = undefined;
        const f = ospfIf(P, s);
        if (f.state === 'Down') ospfIfUp(P, s);
        const prioWas = x.peerPrio;
        const declWas = `${x.peerDr}|${x.peerBdr}`;
        x.peerRid = d.rid;
        x.peerPrio = typeof d.prio === 'number' ? d.prio : 1;
        x.peerDr = d.dr || '';
        x.peerBdr = d.bdr || '';
        ospfRearm(P, s);
        if (s.state === 'Down') P.setState(s, 'Init', false, `Hello from ${s.peer} (router ID ${d.rid})`);
        const seesUs = (d.seen || []).indexOf(x.rid as string) >= 0;
        let change = false;
        if (seesUs && s.state === 'Init') {
          P.setState(s, '2-Way', false, `${s.peer}'s Hello lists us`);
          change = true;
        }
        if (!seesUs && s.state !== 'Init' && s.state !== 'Down') {
          // 1-WayReceived: back to Init (the neighbour no longer lists this router)
          P.restart(s);
          x.sent = false;
          const was = s.state;
          P.setState(s, 'Init', false, `${s.peer}'s Hello no longer lists us`);
          ospfRearm(P, s);
          void was;
          ospfElect(P, s.dev, s.local.l3.id, `${s.peer} no longer lists this router`);
          return;
        }
        if (elects(f.type) && s.state !== 'Init') {
          // BackupSeen (RFC 2328 §10.5): the neighbour declares itself BDR, or DR with no BDR — the Wait is over
          const backupSeen = (x.peerBdr === x.peerRid) || (x.peerDr === x.peerRid && !x.peerBdr);
          if (f.state === 'Waiting' && backupSeen) ospfElect(P, s.dev, s.local.l3.id, `${s.peer}'s Hello shows the segment's ${x.peerBdr === x.peerRid ? 'BDR' : 'DR'}`, true);
          else if (f.state !== 'Waiting' && (change || prioWas !== x.peerPrio || declWas !== `${x.peerDr}|${x.peerBdr}`)) ospfElect(P, s.dev, s.local.l3.id, change ? `${s.peer} is 2-Way` : `${s.peer}'s Hello changed its priority or the DR / BDR it declares`);
        }
        ospfAdjOk(P, s);
        return;
      }
      case 'DBD': {
        if (s.state === 'Down') return;
        if (s.state === 'Init') {
          // RFC 2328 §10.6: a DBD in Init is a 2-WayReceived (the neighbour has seen this router's Hello)
          P.setState(s, '2-Way', false, `a DBD from ${s.peer}: it has seen this router's Hello`);
          ospfElect(P, s.dev, s.local.l3.id, `${s.peer} is 2-Way`);
          ospfAdjOk(P, s);
        }
        const dd = d as { phase?: string; dd?: number; mtu?: number; rid?: string; ms?: boolean };
        // RFC 2328 §10.6: a DBD whose interface MTU is larger than this interface takes is rejected (the adjacency stays in ExStart / Exchange)
        const mtu = ospfMtu(P, s);
        if (dd.mtu !== undefined && dd.mtu > mtu) {
          const note = `MTU ${dd.mtu} in ${s.peer}'s DBD is larger than ${s.local.l3.id}'s MTU ${mtu}`;
          if (x.ddNote !== note) {
            x.ddNote = note;
            P.e.note('drop', 'ospf', s.dev, s.peer, 'DBD rejected', s.state, `OSPF ${s.rel.id}: ${s.dev} rejects the DBD: ${note} — the adjacency does not get past ${s.state}`);
          }
          return;
        }
        x.ddNote = undefined;
        // (the bits of this DBD as sent: an initial one has I, M and MS set; the others the sender's MS)
        const rx = { i: dd.phase === 'init', ms: dd.phase === 'init' ? true : !!dd.ms, dd: dd.dd as number };
        const slaveAnswer = (again: boolean): void =>
          P.unicast(s, 'DBD', `Exchange (slave): the LSA headers of the database, DD sequence ${x.peerInit}${again ? ' (again)' : ''}`, { phase: 'summary', dd: x.peerInit, mtu, ms: false }, 'Exchange');
        const slaveAck = (again: boolean): void => P.unicast(s, 'DBD', `Exchange (slave): acknowledges DD sequence ${x.dd}${again ? ' (again: the master sent its summary again)' : ''}`, { phase: 'summary', dd: x.dd, mtu, ms: false }, 'Exchange');
        if (['Exchange', 'Loading', 'Full'].indexOf(s.state) >= 0) {
          // RFC 2328 §10.6: a duplicate of the last DBD received (the same I, M, MS bits and DD sequence number) is discarded by the
          // master and makes the slave send its last DBD again; in Loading and Full only duplicates are acceptable
          const l = x.lastRx;
          if (l && l.i === rx.i && l.ms === rx.ms && l.dd === rx.dd) {
            if (x.master === false && x.lastTx) {
              P.e.note('message', 'ospf', s.dev, s.peer, 'DBD duplicate', s.state, `OSPF ${s.rel.id}: ${s.dev} (slave) receives a duplicate of ${s.peer}'s DBD ${rx.dd}: it sends its last DBD again (RFC 2328 §10.6)`);
              x.lastTx();
            }
            return;
          }
          const why = rx.i
            ? `an initial DBD (I bit, DD sequence ${rx.dd}) from ${s.peer} in ${s.state}: it started the exchange over`
            : s.state !== 'Exchange'
              ? `a DBD that is no duplicate (DD sequence ${rx.dd}) in ${s.state}: only duplicates are acceptable after the exchange`
              : rx.ms !== (x.master === false)
                ? `the MS bit of DBD ${rx.dd} is ${rx.ms ? 'set' : 'clear'}, but ${s.peer} is the ${x.master ? 'slave' : 'master'}`
                : rx.dd !== (x.master ? (x.dd as number) : (x.dd as number) + 1)
                    ? `DBD ${rx.dd} out of sequence (${x.master ? 'the master expects the acknowledgment of' : 'the slave expects'} ${x.master ? x.dd : (x.dd as number) + 1})`
                    : '';
          if (why) {
            ospfSeqMismatch(P, s, why);
            return;
          }
          // the next DBD in sequence: accepted
          x.lastRx = rx;
          if (x.master === false) {
            // the slave: the master's summary is acknowledged with its DD sequence number; with that the exchange is done
            x.dd = rx.dd;
            x.lastTx = () => slaveAck(true);
            slaveAck(false);
          }
          // (the master: the slave's acknowledgment of its summary — the exchange is done)
        } else if (dd.phase === 'init') {
          if (['2-Way', 'ExStart'].indexOf(s.state) < 0 || !ospfShouldAdj(P, s)) return;
          x.peerInit = dd.dd;
          // the higher router ID is master; the slave takes the master's DD sequence number and answers with its summary
          if (dd.rid !== undefined && ridCmp(dd.rid, x.rid as string) > 0) {
            x.master = false;
            x.dd = dd.dd;
            x.sent = true;
            x.lastRx = rx;
            x.lastTx = () => slaveAnswer(true);
            P.setState(s, 'Exchange', false, `negotiation done: ${s.peer} (router ID ${dd.rid}) is master, this router slave (DD sequence ${dd.dd})`);
            slaveAnswer(false);
          }
          // (a neighbour with the lower router ID: its initial DBD is ignored — it answers this router's as slave)
          return;
        } else if (s.state === 'ExStart') {
          // the master: the slave's answer carries the master's DD sequence number — the negotiation is done; its summary is
          // sent, and again every retransmit interval until the slave acknowledges it (RFC 2328 §10.8); any other DBD is ignored
          if (dd.ms || dd.dd !== x.dd || (dd.rid !== undefined && ridCmp(dd.rid, x.rid as string) > 0)) return;
          x.master = true;
          x.sent = true;
          x.lastRx = rx;
          P.setState(s, 'Exchange', false, `negotiation done: this router (router ID ${x.rid}) is master, ${s.peer} slave (DD sequence ${x.dd})`);
          x.dd = (x.dd as number) + 1;
          const seq = x.dd;
          let n = 0;
          ospfRetransmit(P, s, 'Exchange', () => P.unicast(s, 'DBD', `Exchange (master): the LSA headers of the database, DD sequence ${seq}${n++ ? ' (again: not acknowledged)' : ''}`, { phase: 'summary', dd: seq, mtu, ms: true }, 'Exchange'));
          return;
        } else return;
        if (s.state !== 'Exchange') return;
        // both summaries had everything (M clear): Loading, the LSAs it lacks requested
        P.setState(s, 'Loading', false, 'database summaries exchanged');
        ospfRetransmit(P, s, 'Loading', () => P.unicast(s, 'LSR', 'requests the LSAs it lacks', {}, 'Loading'));
        return;
      }
      case 'LSR':
        if (['Exchange', 'Loading', 'Full'].indexOf(s.state) < 0) return;
        // the requested LSAs: this router's whole database (ProtocolSim.learn takes what is new to the peer)
        P.unicast(s, 'LSU', 'the requested LSAs', { reply: true, db: P.dbOf(s) });
        return;
      case 'LSU':
        // (a flooded LSU — a change — is ProtocolSim's: learned, acknowledged and flooded on there)
        if (!d.reply || ['Exchange', 'Loading', 'Full'].indexOf(s.state) < 0) return;
        P.unicast(s, 'LSAck', 'acknowledges the LSAs');
        if (s.state === 'Loading') P.setState(s, 'Full', true, 'databases synchronised');
        return;
      default:
        return;
    }
  },
  iface(P, s, up) {
    if (up) {
      // InterfaceUp: Waiting again (or point-to-point at once); the Hellos find the neighbours again
      if (s.x.started) ospfIfUp(P, s);
      return;
    }
    // the interface first (no election on an interface going down), then its neighbours
    ospfIfDown(P, s.dev, s.local.l3.id);
    ospfDown(P, s, `interface ${s.local.l3.id} went down`);
  },
  // RFC 2328 §13: a Link State Update from a neighbour in a state below Exchange is discarded
  learns(_P, s) {
    return ['Exchange', 'Loading', 'Full'].indexOf(s.state) >= 0;
  },
  // RFC 2328 §13.3: a change is flooded to every neighbour in Exchange or beyond (and sent again until acknowledged), not only to the Full ones
  floodsDuring: ['Exchange', 'Loading'],
  adjUp(P, s) {
    if (s.state === 'Full') return true;
    const f = ospfIf(P, s);
    if (s.state !== '2-Way' || !elects(f.type) || !f.drDev) return false;
    // two DROthers: they reach each other through the DR's network LSA — this router Full with the DR, and the DR's record (as
    // its LSUs brought it here) naming the other one as its neighbour; never the other router's own state, which it cannot see
    const meFull = s.dev === f.drDev || Array.from(P.sessions.values()).some((o) => o.protocol === 'ospf' && o.dev === s.dev && o.peer === f.drDev && o.state === 'Full');
    if (!meFull) return false;
    if (s.peer === f.drDev) return true;
    // (the DR's records in this router's own instance: what came over its sessions)
    return P.recordsIn(s.dev, P.instanceOf(s)).some((r) => r.origin === f.drDev && r.adj.some((a) => a.slice(a.lastIndexOf('|') + 1) === s.peer));
  },
  down: ospfDown,
};

// ------------------------------------------------------------------ IS-IS

const ISIS_MAC = '01:80:c2:00:00:15';

/** A device's IS-IS identity from its NET (area.system-id.selector: "49.0001.1921.6800.1001.00"), and its level. */
export function isisIdentity(P: ProtocolSim, dev: string): { sys: string; area: string; level: 'level-1' | 'level-2' | 'level-1-2' } {
  const d = P.m.index.devices.get(dev);
  const svc = d ? d.services.find((x) => x.id === 'isis') : undefined;
  const net = svc ? (svc.values.get('net') || '').trim().toLowerCase() : '';
  const parts = net.split('.');
  const lv = svc ? svc.values.get('level') : undefined;
  const level = lv === 'level-1' || lv === 'level-1-2' ? lv : 'level-2';
  // a NET: an area of one or more fields, a six-byte system ID (three fields), the selector
  if (parts.length >= 5) return { sys: parts.slice(-4, -1).join('.'), area: parts.slice(0, -4).join('.'), level };
  return { sys: routerId(P, dev, 'isis'), area: '', level };
}

/** Why two IS-IS routers' IIHs make no adjacency (ISO 10589 §8.4): no level in common, level 1 only across areas, the same system ID; '' when they can. */
function isisMismatch(me: ReturnType<typeof isisIdentity>, d: { sys?: string; area?: string; level?: string }): string {
  if (d.sys === me.sys) return `the same system ID ${me.sys} (a duplicate system ID)`;
  const l1 = (x: string | undefined): boolean => x === 'level-1' || x === 'level-1-2';
  const l2 = (x: string | undefined): boolean => x === 'level-2' || x === 'level-1-2';
  if (l2(me.level) && l2(d.level)) return '';
  if (l1(me.level) && l1(d.level)) return d.area === me.area ? '' : `level 1 only, and area ${d.area} there, ${me.area} here`;
  return `no level in common (${d.level} there, ${me.level} here)`;
}

/** The summary of a session's database a CSNP carries: each LSP by its origin and sequence number. */
function isisSummary(P: ProtocolSim, s: Sess): Array<{ k: string; seq: number }> {
  return P.dbOf(s).map((r) => ({ k: r.origin + '|' + r.inst, seq: r.seq }));
}

/** A CSNP with the database summary (ISO 10589 §7.3.15.3): at once when the adjacency comes up, then every CSNP interval while it is. */
function isisCsnp(P: ProtocolSim, s: Sess, why: string): void {
  const sum = isisSummary(P, s);
  isisFrame(P, s, 'CSNP', `${why}: the database summary, ${sum.map((x) => x.k.slice(0, x.k.indexOf('|')) + '#' + x.seq).join(', ') || 'empty'}`, { summary: sum });
}

/** An IS-IS PDU on the session's link: a frame to AllL2ISs (IS-IS runs on the link layer, not over IP). */
function isisFrame(P: ProtocolSim, s: Sess, type: string, detail: string, data: { [k: string]: unknown }): void {
  if (!P.e.isL3Up(s.dev, s.local.l3.id)) return;
  const m = P.msg(s, type, `${s.dev} on ${s.local.l3.id} to ${ISIS_MAC} (AllL2ISs): ${detail}`, data);
  P.e.note('message', s.protocol, s.dev, s.peer, type, '', m.detail, P.e.now, m);
  P.lane(s.rel, s.dev, s.peer, m, 2 * P.e.hopTime());
  P.e.emit(s.dev, s.local.l3, { src: s.local.l3.mac, dst: ISIS_MAC, msg: m, pdu: true });
}

/**
 * IS-IS (ISO 10589, RFC 1195): IIHs on the link with the router's system
 * ID, area and level (from its NET); the adjacency forms over the link
 * whatever the interfaces' IP addresses — on a level in common (level 1
 * only within an area), never with a duplicate system ID — through the
 * three-way handshake; then CSNP, PSNP and LSPs, all frames on the link.
 */
const isis: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  // (ISO 10589 §7.3.15.1: an LSP from a system with no adjacency up on the circuit is discarded)
  learns(_P, s) {
    return s.state === 'Up';
  },
  send(P, s, type, detail, data) {
    isisFrame(P, s, type, detail, data);
  },
  start(P, s) {
    const key = `isis-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    P.periodic(
      () => true,
      () => P.timer(s, s.profile, 'hello').ms,
      () => {
        if (!P.e.isL3Up(s.dev, s.local.l3.id) || s.local.l3.kind === 'tunnel') return;
        const me = isisIdentity(P, s.dev);
        // the neighbours it hears on the link, by their system IDs
        const seen = (P.byRel.get(s.rel.id) || []).filter((o) => o.dev === s.dev && o.state !== 'Down' && typeof o.x.peerSys === 'string').map((o) => o.x.peerSys as string);
        const m = P.msg(s, 'IIH', `${s.dev} on ${s.local.l3.id} to ${ISIS_MAC} (AllL2ISs): system ID ${me.sys}${me.area ? ', area ' + me.area : ''}, ${me.level}, hold ${P.timer(s, s.profile, 'dead').text}; neighbours seen: ${seen.join(', ') || 'none'}`, { seen, sys: me.sys, area: me.area, level: me.level });
        P.e.note('message', s.protocol, s.dev, s.peer, 'IIH', '', m.detail, P.e.now, m);
        for (const o of (P.byRel.get(s.rel.id) || []).filter((q) => q.dev === s.dev)) P.lane(s.rel, s.dev, o.peer, m, 2 * P.e.hopTime());
        P.e.emit(s.dev, s.local.l3, { src: s.local.l3.mac, dst: ISIS_MAC, msg: m, pdu: true });
      },
    );
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { seen?: string[]; sys?: string; area?: string; level?: string; acks?: number; summary?: Array<{ k: string; seq: number }>; req?: string[] };
    if (msg.type === 'IIH') {
      const me = isisIdentity(P, s.dev);
      const bad = isisMismatch(me, d);
      if (bad) {
        if (s.x.mismatch !== bad) {
          s.x.mismatch = bad;
          P.e.note('drop', 'isis', s.dev, s.peer, 'IIH ignored', s.state, `IS-IS ${s.rel.id}: ${s.dev} makes no adjacency with ${s.peer}: ${bad}`);
        }
        return;
      }
      s.x.mismatch = undefined;
      s.x.peerSys = d.sys;
      const listed = (d.seen || []).indexOf(me.sys) >= 0;
      // one-way (ISO 10589 §8.4.2, RFC 5303): the neighbour's IIHs no longer list this system — the adjacency is not up
      if (s.state === 'Up' && !listed) {
        P.restart(s);
        P.setState(s, 'Initializing', false, `${s.peer}'s IIH no longer lists this system (${me.sys}): one-way, the adjacency goes back to Initializing`);
      }
      const dead = P.timer(s, s.profile, 'dead');
      deadCheck(P, s, dead.ms, () => isis.down(P, s, `holding time expired (${dead.text})`));
      if (s.state === 'Down') P.setState(s, 'Initializing', false, `IIH from ${s.peer} (system ID ${d.sys})`);
      if (listed && s.state === 'Initializing') {
        P.setState(s, 'Up', true, `three-way handshake complete (system ID ${d.sys})`);
        isisCsnp(P, s, 'the adjacency is up');
        const g = s.gen;
        P.periodic(
          () => s.gen === g,
          () => P.timer(s, s.profile, 'csnp').ms,
          () => {
            if (s.state === 'Up' && P.e.isL3Up(s.dev, s.local.l3.id)) isisCsnp(P, s, `every ${P.timer(s, s.profile, 'csnp').text}`);
          },
          P.timer(s, s.profile, 'csnp').ms,
        );
      }
      return;
    }
    if (s.state !== 'Up') return;
    if (msg.type === 'CSNP') {
      // the LSPs the summary names that this system lacks, or holds older: requested by a PSNP (nothing missing: no request)
      const mine = new Map(isisSummary(P, s).map((x) => [x.k, x.seq]));
      const req = (d.summary || []).filter((x) => !x.k.startsWith(s.dev + '|') && (mine.get(x.k) === undefined || (mine.get(x.k) as number) < x.seq)).map((x) => x.k);
      if (req.length) isisFrame(P, s, 'PSNP', `requests the missing LSPs: ${req.map((k) => k.slice(0, k.indexOf('|'))).join(', ')}`, { req });
    } else if (msg.type === 'PSNP' && d.acks === undefined && d.req) {
      const want = new Set(d.req);
      const db = P.dbOf(s).filter((r) => want.has(r.origin + '|' + r.inst));
      if (db.length) isisFrame(P, s, 'LSP', `the requested LSPs: ${db.map((r) => r.origin + '#' + r.seq).join(', ')}`, { db });
    }
  },
  iface(P, s, up) {
    if (!up) isis.down(P, s, `interface ${s.local.l3.id} went down`);
  },
  down(P, s, why) {
    if (s.state === 'Down') return;
    P.restart(s);
    P.setState(s, 'Down', false, why);
  },
};

// ------------------------------------------------------------------ EIGRP

const eigrp: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  // (RFC 7868 §5.3.1: routes are taken only from a neighbour whose initialization is complete)
  learns(_P, s) {
    return s.state === 'Up';
  },
  start(P, s) {
    const key = `eigrp-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const group = addr(ipOf(s.local).version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string));
    P.periodic(
      () => true,
      () => P.timer(s, s.profile, 'hello').ms,
      () => {
        if (P.e.isL3Up(s.dev, s.local.l3.id)) P.multicast(s, group, 'Hello', `hold ${P.timer(s, s.profile, 'dead').text}`);
      },
    );
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { init?: boolean; seq?: number; ack?: number };
    const hold = P.timer(s, s.profile, 'dead');
    if (msg.type === 'Hello') {
      deadCheck(P, s, hold.ms, () => eigrp.down(P, s, `hold time expired (${hold.text})`));
      if (s.state === 'Down') {
        P.setState(s, 'Pending', false, `Hello from ${s.peer}`);
        eigrpInit(P, s);
      }
      return;
    }
    if (msg.type === 'Update' && d.init) {
      // the same init Update again (its sequence number: our ACK was lost): acknowledged again, nothing else
      if (s.x.peerInit && d.seq === s.x.peerInitSeq) {
        P.unicast(s, 'ACK', `acknowledges the init Update again (sequence ${d.seq}: a retransmission)`, { ack: d.seq });
        return;
      }
      // a new init Update from a neighbour that is Up: it restarted — the neighbour is reset and the adjacency starts over
      // from its next Hello (RFC 7868 §5.3.1); the init that reset it is not taken for the new adjacency, which would come
      // up at once on it and be reset by the neighbour's own new init in turn, without end
      if (s.state === 'Up') {
        eigrp.down(P, s, `init Update from ${s.peer} while Up: it restarted`);
        deadCheck(P, s, hold.ms, () => eigrp.down(P, s, `hold time expired (${hold.text})`));
        return;
      }
      P.unicast(s, 'ACK', `acknowledges the init Update (sequence ${d.seq})`, { ack: d.seq });
      s.x.peerInit = true;
      s.x.peerInitSeq = d.seq;
      if (s.state === 'Down') P.setState(s, 'Pending', false, `init Update from ${s.peer}`);
      if (!s.x.sentInit) eigrpInit(P, s);
      eigrpUp(P, s);
      return;
    }
    // an ACK completes the init only when it acknowledges this init's sequence number (RFC 7868 §5.3: the acknowledgment
    // number) — never one of an earlier adjacency, delayed, which would stop the new init's retransmission
    if (msg.type === 'ACK' && s.state === 'Pending' && s.x.sentInit) {
      if (d.ack !== s.x.initSeq) {
        P.e.note('drop', 'eigrp', s.dev, s.peer, 'ACK', s.state, `EIGRP ${s.rel.id}: ${s.dev} ignores an ACK of sequence ${d.ack === undefined ? '?' : d.ack} from ${s.peer}: its init Update is sequence ${s.x.initSeq} (an ACK of an earlier exchange)`);
        return;
      }
      s.x.initAcked = true;
      eigrpUp(P, s);
      return;
    }
    // (a Query is answered with a Reply by ProtocolSim.learn, once its records are taken: from a neighbour that is Up)
  },
  iface(P, s, up) {
    if (!up) eigrp.down(P, s, `interface ${s.local.l3.id} went down`);
  },
  down(P, s, why) {
    if (s.state === 'Down') return;
    P.restart(s);
    s.x.sentInit = s.x.peerInit = s.x.initAcked = false;
    s.x.initSeq = undefined;
    P.setState(s, 'Down', false, why);
  },
};

/** EIGRP's retry limit: a reliable packet sent this many times without an ACK resets the neighbour (RFC 7868 §5.3). */
const EIGRP_RETRIES = 16;

/**
 * The init Update (RFC 7868 §5.3.1): reliable — sent again every retransmit interval until the neighbour acknowledges it,
 * the neighbour reset after the retry limit.
 */
function eigrpInit(P: ProtocolSim, s: Sess): void {
  s.x.sentInit = true;
  s.x.initAcked = false;
  const g = s.gen;
  // (its sequence number: a retransmission carries the same one, a restart a new one)
  const seq = 1 + (hashIndex(`${s.key}|${P.e.now}|${g}`, 1000000) as number);
  s.x.initSeq = seq;
  const send = (n: number): void => {
    if (s.gen !== g || s.state !== 'Pending' || s.x.initAcked) return;
    if (n >= EIGRP_RETRIES) {
      eigrp.down(P, s, `retry limit exceeded: the init Update sent ${EIGRP_RETRIES} times without an ACK from ${s.peer}`);
      return;
    }
    P.unicast(s, 'Update', `init flag set, sequence ${seq}, no routes yet${n ? ` (sent again: no ACK after ${fmtSec(ADV_RXMT)})` : ''}`, { init: true, seq }, 'Pending');
    P.e.after(ADV_RXMT, () => send(n + 1));
  };
  send(0);
}

/** Up once both inits are through: its own acknowledged, the neighbour's received — then its routes (RFC 7868 §5.3.1). */
function eigrpUp(P: ProtocolSim, s: Sess): void {
  if (s.state !== 'Pending' || !s.x.initAcked || !s.x.peerInit) return;
  P.setState(s, 'Up', true, 'init Updates acknowledged both ways');
  P.unicast(s, 'Update', 'its routes', { db: P.dbOf(s), dbId: 0, dbAck: 'ACK' }, 'Up');
}

// ------------------------------------------------------------------ RIP

/**
 * RIP: a distance vector (rip.ts holds the routers' tables). A Request at
 * start; the whole table every update interval out of each interface (one
 * Response per relation and interface, to the group); a Request's answer to
 * the neighbour that asked. A Response's entries go into the table; the
 * session shows the neighbour heard (Heard), Down after the timeout without
 * any Response from it — its routes time out on their own.
 */
/**
 * RIP's Request for the whole table (RFC 2453 §3.9.1): when the router comes up — its first boot, after a power cycle —
 * and when the interface comes up again; once per interface (its sessions there share it).
 */
function ripRequest(P: ProtocolSim, s: Sess): void {
  if (!P.shared.has('rip-hooks')) {
    P.shared.set('rip-hooks', true);
    // powered off: it asks again when it boots
    P.deviceHooks.push((dev, up) => {
      if (up) return;
      for (const k of Array.from(P.shared.keys())) if (k.indexOf(`rip-req|${dev}|`) === 0) P.shared.delete(k);
    });
  }
  const key = `rip-req|${s.dev}|${s.local.l3.id}`;
  // (an interface still down sends nothing: it asks when it comes up)
  if (P.shared.has(key) || !P.e.isL3Up(s.dev, s.local.l3.id)) return;
  P.shared.set(key, true);
  const group = addr(ipOf(s.local).version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string));
  P.multicast(s, group, 'Request', 'asks for the whole table');
}

const rip: Behaviour = {
  start(P, s) {
    const R = P.ripSim();
    ripRequest(P, s);
    const key = `rip|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const upd = (): number => P.timer(s, s.profile, 'hello').ms;
    P.periodic(
      () => true,
      upd,
      () => {
        // the whole table every update interval: what a lost update did not bring comes with the next one
        if (P.e.isL3Up(s.dev, s.local.l3.id) && P.e.deviceOn(s.dev)) R.send(s, 'periodic update', R.entries(s));
      },
      upd(),
    );
  },
  rx(P, s, msg) {
    const R = P.ripSim();
    if (msg.type === 'Request') {
      const list = R.entries(s);
      P.unicast(s, 'Response', `answer to the request: ${list.length ? list.map((e) => `${e.prefix} metric ${e.metric}`).join(', ') : 'no routes'}`, { rip: list });
      return;
    }
    if (msg.type !== 'Response') return;
    const timeout = P.timer(s, s.profile, 'dead');
    deadCheck(P, s, timeout.ms, () => {
      P.restart(s);
      P.setState(s, 'Down', false, `timeout (${timeout.text}): no Response from ${s.peer} (its routes time out on their own)`);
    });
    if (s.state !== 'Heard') P.setState(s, 'Heard', true, `Response from ${s.peer}`);
    R.response(s, ((msg.data || {}) as { rip?: RipEntry[] }).rip || []);
  },
  iface(P, s, up) {
    if (!up) {
      P.ripSim().ifaceDown(s);
      P.shared.delete(`rip-req|${s.dev}|${s.local.l3.id}`);
    } else if (P.e.deviceOn(s.dev)) ripRequest(P, s);
  },
};

// ------------------------------------------------------------------ BGP (and EVPN, L3VPN)

/** An OPEN's parameters (RFC 4271 §4.2), kept as the session's state: what it sent and what it received. */
export interface BgpOpen {
  version: number;
  /** "My Autonomous System" (null: the device has no AS number) */
  as: number | null;
  /** the hold time it proposes, in seconds (0: no keepalives, no hold timer) */
  hold: number;
  /** the BGP identifier */
  id: string;
  /** the address families it announces (its capabilities) */
  afi: string;
}

function bgpRouteToPeer(P: ProtocolSim, s: Sess): boolean {
  const d = lookup(P.m, s.dev, s.local.l3.vrf, ipOf(s.remote), P.e.ctx(s.dev));
  return d.kind === 'forward' || d.kind === 'local';
}

/** The device's own AS number (its BGP service's asn), null when it has none. */
function bgpOwnAs(P: ProtocolSim, dev: string): number | null {
  const v = bgpAsn(P.m.index.devices.get(dev));
  return v === undefined ? null : v;
}

/**
 * The hold time a device proposes on a session: the relation's `hold`
 * (per device: `hold.<device>`; 0 or 3–65535 s), else the simulation's
 * (3 × BGP keepalive). 0 means none (RFC 4271 §4.4: no KEEPALIVEs, no hold timer).
 */
function bgpHold(P: ProtocolSim, s: Sess): { s: number; text: string } {
  const v = relParam(s.rel, 'hold', s.dev);
  if (v !== undefined && /^\s*[0-9]+\s*$/.test(v)) {
    const n = Number(v);
    if (n === 0) return { s: 0, text: '0 (configured: no keepalives and no hold timer)' };
    if (n >= 3 && n <= 65535) return { s: n, text: `${n} s (configured)` };
  }
  const t = P.timer(s, s.profile, 'hold');
  return { s: Math.round(t.ms / 1000), text: t.text };
}

/** The AS a device expects its peer in: the relation's `peer-as`, else (iBGP) its own, else the peer's own AS. */
function bgpExpectedAs(P: ProtocolSim, s: Sess): { as: number | null; how: string } {
  const v = relParam(s.rel, 'peer-as', s.dev);
  if (v !== undefined && /^\s*[0-9]+\s*$/.test(v)) return { as: Number(v), how: 'its peer-as' };
  if (normalizeProtocol(s.rel.protocol) === 'ibgp') return { as: bgpOwnAs(P, s.dev), how: 'iBGP: its own AS' };
  return { as: bgpOwnAs(P, s.peer), how: `${s.peer}'s own AS` };
}

function bgpAfi(s: Sess): string {
  return s.protocol === 'evpn' ? 'L2VPN EVPN' : s.protocol === 'l3vpn' ? 'VPNv4' : ipOf(s.local).version === 6 ? 'IPv6 unicast' : 'IPv4 unicast';
}

/** The details of a session: the negotiated hold time and keepalive interval (or what it proposes before). */
function bgpDetail(P: ProtocolSim, s: Sess): void {
  const neg = s.x.holdMs as number | undefined;
  if (neg !== undefined) {
    s.x.detail = neg === 0 ? 'hold time 0 negotiated: no keepalives, no hold timer' : `keepalive ${fmtSec(s.x.kaMs as number)}, hold ${fmtSec(neg)} (negotiated: the smaller of ${(s.x.open as BgpOpen).hold} s and ${(s.x.peerOpen as BgpOpen).hold} s)`;
    return;
  }
  const h = bgpHold(P, s);
  s.x.detail = `keepalive ${P.timer(s, s.profile, 'keepalive').text}, hold ${h.text}`;
}

function bgpConnect(P: ProtocolSim, s: Sess): void {
  if (!s.initiator) return;
  if (s.state === 'Established' || s.state === 'OpenSent' || s.state === 'OpenConfirm') return;
  if (bgpOwnAs(P, s.dev) === null) {
    if (s.state !== 'Idle') P.setState(s, 'Idle', false, `${s.dev} has no AS number: it does not start the session`);
    return;
  }
  if (!bgpRouteToPeer(P, s)) {
    // a session between loopbacks waits for a route to the peer (the IGP): it goes on the moment there is one
    if (s.state !== 'Active') P.setState(s, 'Active', false, `no route to ${formatAddr(ipOf(s.remote))} yet (waiting for ${s.local.l3.kind === 'loopback' ? 'the IGP' : 'the routes of its interface'})`);
    const g = s.gen;
    const m = P.msg(s, 'TCP SYN', `to port 179 of ${formatAddr(ipOf(s.remote))}`);
    P.e.waitFor(`route:${s.dev}|${s.local.l3.vrf}|${formatAddr(ipOf(s.remote))}`, `a route to ${formatAddr(ipOf(s.remote))}`, s.dev, m, () => {
      if (s.gen === g) bgpConnect(P, s);
    }, `${s.key}|bgp-route`);
    return;
  }
  P.setState(s, 'Connect', false, `opening TCP to ${formatAddr(ipOf(s.remote))} port 179`);
  P.e.note('wait', s.protocol, s.dev, s.peer, 'waiting', '', `${s.profile.label} OPEN to ${formatAddr(ipOf(s.remote))} waiting for TCP (the connection to port 179)`);
  s.x.tcpSince = P.e.now;
  if (!tcpConnect(P, s)) P.setState(s, 'Active', false, 'no connection could be opened');
  // ConnectRetry (RFC 4271 §8.2.2): an attempt not open by then is dropped and made again
  const retry = P.timer(s, s.profile, 'connect-retry');
  P.later(s, retry.ms, () => {
    if (s.state === 'Connect' || s.state === 'Active') {
      tcpClose(P, s, 'ConnectRetry timer expired', true);
      P.setState(s, 'Active', false, `ConnectRetry timer expired (${retry.text})`);
      bgpConnect(P, s);
    }
  });
}

function updateText(s: Sess): string {
  if (s.protocol === 'evpn') return 'EVPN routes: type 2 (MAC/IP) and type 3 (inclusive multicast)';
  if (s.protocol === 'l3vpn') return 'VPNv4 prefixes with route distinguisher, route targets and labels';
  return 'its prefixes';
}

/** This side's OPEN (structured: version, AS, hold time, identifier, address family). */
function bgpSendOpen(P: ProtocolSim, s: Sess): void {
  const h = bgpHold(P, s);
  const o: BgpOpen = { version: 4, as: bgpOwnAs(P, s.dev), hold: h.s, id: routerId(P, s.dev, 'bgp'), afi: bgpAfi(s) };
  s.x.open = o;
  tcpSend(P, s, 'OPEN', `version 4, AS ${o.as === null ? '?' : o.as}, hold time ${o.hold} s, BGP identifier ${o.id}, ${o.afi}`, 45, { open: o });
}

/** Why a peer's OPEN is refused (RFC 4271 §6.2: the NOTIFICATION's error), '' when it is accepted. */
function bgpOpenError(P: ProtocolSim, s: Sess, o: BgpOpen | undefined): string {
  if (!o) return 'OPEN Message Error: no parameters';
  if (o.version !== 4) return `OPEN Message Error / Unsupported Version Number (${o.version})`;
  const exp = bgpExpectedAs(P, s);
  if (o.as === null || exp.as === null || o.as !== exp.as) return `OPEN Message Error / Bad Peer AS: AS ${o.as === null ? '?' : o.as} in the OPEN, ${s.dev} expects ${exp.as === null ? 'an AS it does not know' : 'AS ' + exp.as} (${exp.how})`;
  if (o.hold === 1 || o.hold === 2) return `OPEN Message Error / Unacceptable Hold Time (${o.hold} s)`;
  if (o.id === routerId(P, s.dev, 'bgp')) return `OPEN Message Error / Bad BGP Identifier (${o.id} is ${s.dev}'s own)`;
  return '';
}

/** The negotiated timers (RFC 4271 §4.2, §10): the smaller hold time; keepalives at most a third of it (none when it is 0). */
function bgpNegotiate(P: ProtocolSim, s: Sess, peer: BgpOpen): void {
  const own = s.x.open as BgpOpen | undefined;
  const mine = own ? own.hold : bgpHold(P, s).s;
  const hold = Math.min(mine, peer.hold) * 1000;
  s.x.peerOpen = peer;
  s.x.holdMs = hold;
  s.x.kaMs = hold === 0 ? 0 : Math.min(P.timer(s, s.profile, 'keepalive').ms, Math.floor(hold / 3));
  bgpDetail(P, s);
}

function bgpHoldTimer(P: ProtocolSim, s: Sess): void {
  const hold = s.x.holdMs as number | undefined;
  if (!hold) return;
  deadCheck(P, s, hold, () => bgp.down(P, s, `hold timer expired (${fmtSec(hold)}, negotiated)`, true));
}

/** Refuse the OPEN: NOTIFICATION, the connection closed, the session Idle (ConnectRetry tries again). */
function bgpRefuse(P: ProtocolSim, s: Sess, err: string): void {
  tcpSend(P, s, 'NOTIFICATION', err, 21, { error: err });
  bgp.down(P, s, `${err} — NOTIFICATION sent`);
}

const bgp: TcpBehaviour & { down: (P: ProtocolSim, s: Sess, why: string, notify?: boolean) => void } = {
  refresh(P, s) {
    bgpDetail(P, s);
  },
  // RFC 4271 §9: UPDATEs are processed only in Established (in any other state one is an FSM error)
  learns(_P, s) {
    return s.state === 'Established';
  },
  advertise(P, s, recs, why) {
    // an UPDATE over the session's connection (TCP retransmits it): announcements and withdrawals of what changed
    if (s.state === 'Established') tcpSend(P, s, 'UPDATE', `${why}: ${recs.map((r) => r.origin + '#' + r.seq).join(', ')}`, 23 + 12 * recs.length, { db: recs });
  },
  start(P, s) {
    bgpDetail(P, s);
    if (bgpOwnAs(P, s.dev) === null) {
      // no BGP speaker: nothing listens on port 179, nothing connects
      P.setState(s, 'Idle', false, `${s.dev} has no AS number (its BGP service's asn): no BGP speaker runs`);
      return;
    }
    tcpListen(P, s);
    if (s.initiator) bgpConnect(P, s);
    else if (s.state === 'Idle') P.setState(s, 'Active', false, 'waiting for the peer to connect');
  },
  tcp(P, s, ev, why) {
    if (ev === 'open') {
      // RFC 4271 §8.2.2: the TCP connection established — both ends send their OPEN and go to OpenSent (the passive one too,
      // without waiting for the peer's)
      if (!s.initiator && s.state !== 'Active') return;
      P.setState(s, 'OpenSent', false, s.initiator ? 'TCP connection established' : `TCP connection from ${s.peer} accepted`);
      if (s.initiator) s.x.waitedNext = [`TCP connection to ${formatAddr(ipOf(s.remote))}:179: ${durationText(P.e.now - ((s.x.tcpSince as number) || P.e.now))}`];
      bgpSendOpen(P, s);
      return;
    }
    if (s.state === 'Connect') {
      // the attempt failed (refused, timed out): Active, and the ConnectRetry timer tries again
      P.setState(s, 'Active', false, `TCP connection to ${formatAddr(ipOf(s.remote))}:179 failed: ${why}`);
      return;
    }
    if (s.state !== 'Idle' && s.state !== 'Active') bgp.down(P, s, `its TCP connection ${/^(closed|reset|connection)/.test(why) ? why : 'is gone: ' + why}`);
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { open?: BgpOpen; error?: string };
    switch (msg.type) {
      case 'OPEN': {
        if (['Active', 'Connect', 'OpenSent'].indexOf(s.state) < 0) return;
        const err = bgpOpenError(P, s, d.open);
        if (err) {
          if (!s.initiator && s.state !== 'OpenSent') bgpSendOpen(P, s);
          bgpRefuse(P, s, err);
          return;
        }
        // (a passive side whose connection was bound only by this OPEN — it came from a translated address — sends its own now)
        if (!s.initiator && s.state !== 'OpenSent') bgpSendOpen(P, s);
        bgpNegotiate(P, s, d.open as BgpOpen);
        P.setState(s, 'OpenConfirm', false, `OPEN from ${s.peer} (AS ${(d.open as BgpOpen).as}, hold ${(d.open as BgpOpen).hold} s, identifier ${(d.open as BgpOpen).id})`);
        tcpSend(P, s, 'KEEPALIVE', 'confirms the OPEN', 19);
        bgpHoldTimer(P, s);
        return;
      }
      case 'KEEPALIVE':
        if (s.state === 'OpenConfirm') {
          P.setState(s, 'Established', true, 'KEEPALIVE received');
          s.x.waitedNext = ['the session to be Established'];
          const db = P.dbOf(s);
          tcpSend(P, s, 'UPDATE', updateText(s), 23 + 12 * db.length, { db });
          const ka = s.x.kaMs as number;
          if (ka > 0) {
            const g = s.gen;
            P.periodic(
              () => s.gen === g && s.state === 'Established',
              () => s.x.kaMs as number,
              () => tcpSend(P, s, 'KEEPALIVE', `every ${fmtSec(s.x.kaMs as number)} (a third of the negotiated hold time at most)`, 19),
              ka,
            );
          }
        }
        if (s.state === 'Established') bgpHoldTimer(P, s);
        return;
      case 'UPDATE':
        if (s.state === 'Established') bgpHoldTimer(P, s);
        return;
      case 'NOTIFICATION':
        bgp.down(P, s, `NOTIFICATION from ${s.peer}: ${d.error || 'closes the session'}`);
        return;
      default:
        return;
    }
  },
  down(P: ProtocolSim, s: Sess, why: string, notify = false) {
    if (s.state === 'Idle' && !s.up && !s.x.sock) return;
    const was = s.state === 'Established';
    if (notify) tcpSend(P, s, 'NOTIFICATION', 'Hold Timer Expired: closes the session', 21, { error: 'Hold Timer Expired' });
    // after a NOTIFICATION the connection is closed (FIN after it); else it is reset
    tcpClose(P, s, why, !notify && !/NOTIFICATION sent/.test(why));
    P.restart(s);
    delete s.x.holdMs;
    delete s.x.peerOpen;
    P.setState(s, 'Idle', false, why);
    bgpDetail(P, s);
    void was;
    const retry = P.timer(s, s.profile, 'connect-retry');
    if (s.initiator) P.later(s, retry.ms, () => bgpConnect(P, s));
    else P.later(s, 1000, () => P.setState(s, 'Active', false, 'waiting for the peer to connect again'));
  },
};

// ------------------------------------------------------------------ LDP (link and targeted)

const ldp: TcpBehaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  start(P, s) {
    const targeted = s.protocol !== 'ldp';
    const group = addr('224.0.0.2');
    const name = targeted ? 'Targeted Hello' : 'Hello';
    tcpListen(P, s);
    every(P, s, () => P.timer(s, s.profile, 'hello').ms, () => {
      const hello = P.timer(s, s.profile, 'hello');
      if (targeted || ipOf(s.local).version === 6) P.unicast(s, name, `transport address ${formatAddr(ipOf(s.local))}, hold ${P.timer(s, s.profile, 'dead').text}`);
      else {
        const key = `ldp-hello|${s.rel.id}|${s.dev}|${Math.floor(P.e.now / hello.ms)}`;
        if (!P.shared.has(key)) {
          P.shared.set(key, true);
          P.multicast(s, group, 'Hello', `transport address ${formatAddr(ipOf(s.local))}, hold ${P.timer(s, s.profile, 'dead').text}`);
        }
      }
    });
  },
  tcp(P, s, ev, why) {
    if (ev === 'open') {
      // the active side (the higher transport address) starts the session; the passive one answers its Initialization
      if (compareAddr(ipOf(s.local), ipOf(s.remote)) > 0 && s.state === 'Initialized') {
        P.setState(s, 'OpenSent', false, 'TCP open');
        tcpSend(P, s, 'Initialization', 'session parameters (keepalive time, label distribution)', 32);
      }
      return;
    }
    if (s.state !== 'Non-existent') ldp.down(P, s, `the session's TCP connection ${why}`);
  },
  rx(P, s, msg) {
    const hold = P.timer(s, s.profile, 'dead');
    // the side with the higher transport address opens the session (RFC 5036 2.5.2)
    const active = compareAddr(ipOf(s.local), ipOf(s.remote)) > 0;
    const session = (): void => {
      const sh = P.timer(s, s.profile, 'hold');
      P.armDead(s, sh.ms, () => ldp.down(P, s, `session hold time expired (${sh.text})`), 'session');
    };
    switch (msg.type) {
      case 'Hello':
      case 'Targeted Hello':
        deadCheck(P, s, hold.ms, () => ldp.down(P, s, `hello hold time expired (${hold.text})`));
        if (s.state === 'Non-existent' && active) {
          P.setState(s, 'Initialized', false, `hello from ${s.peer}; opening the session (higher transport address)`);
          if (!tcpConnect(P, s)) P.setState(s, 'Non-existent', false, 'no TCP connection could be opened');
        }
        return;
      case 'Initialization':
        session();
        if (s.state === 'Initialized' || s.state === 'Non-existent') {
          P.setState(s, 'OpenRec', false, 'Initialization from the peer');
          tcpSend(P, s, 'Initialization', 'session parameters', 32);
        } else if (s.state === 'OpenSent') P.setState(s, 'OpenRec', false, 'Initialization from the peer');
        tcpSend(P, s, 'Keepalive', 'accepts the session', 14);
        return;
      case 'Keepalive':
        session();
        if (s.state === 'OpenRec') {
          P.setState(s, 'Operational', true, 'session up');
          if (s.protocol === 'ldp') tcpSend(P, s, 'Address', 'its interface addresses', 30);
          tcpSend(P, s, s.protocol === 'pseudowire' ? 'Label Mapping (PW)' : s.protocol === 'vpls' ? 'Label Mapping (VPLS)' : 'Label Mapping', s.protocol === 'ldp' ? 'a label per prefix (FEC)' : 'the pseudowire label (FEC 128)', 40);
          every(P, s, () => P.timer(s, s.profile, 'keepalive').ms, () => {
            if (s.state === 'Operational') tcpSend(P, s, 'Keepalive', `every ${P.timer(s, s.profile, 'keepalive').text}`, 14);
          });
        }
        return;
      default:
        if (s.state === 'Operational') session();
        return;
    }
  },
  iface(P, s, up) {
    if (!up && s.protocol === 'ldp') ldp.down(P, s, `interface ${s.local.l3.id} went down`);
  },
  down(P, s, why) {
    if (s.state === 'Non-existent' && !s.x.sock) return;
    tcpClose(P, s, why);
    P.restart(s);
    P.setState(s, 'Non-existent', false, why + '; labels withdrawn');
    ldp.start(P, s);
  },
};

// ------------------------------------------------------------------ BFD

/** A BFD session's Desired Min TX: its interval, at least 1 s while it is not Up (RFC 5880 §6.8.3). */
function bfdTx(P: ProtocolSim, s: Sess): number {
  const iv = P.timer(s, s.profile, 'interval').ms;
  return s.state === 'Up' ? iv : Math.max(1000, iv);
}

const bfd: Behaviour = {
  refresh(P, s) {
    const iv = P.timer(s, s.profile, 'interval');
    const mult = P.timer(s, s.profile, 'multiplier');
    const n = Math.max(1, Math.round(mult.ms / 1000));
    s.x.detail = `interval ${iv.text}, multiplier ${mult.text}: detection ${fmtSec(iv.ms * n)}`;
  },
  start(P, s) {
    bfd.refresh!(P, s);
    // one transmit stream per generation: a Control received while it waits for its client (dispatch starts the session),
    // and the waiter firing later, never start a second one
    if (s.x.stream === s.gen) return;
    // BFD runs for a client: it starts when a routing session to the same peer asks for it (is up); with no client, at once
    const clients = P.sessionsOf(s.dev).filter((o) => o.peer === s.peer && o.profile.behaviour !== 'bfd' && ['ospf', 'bgp', 'isis', 'eigrp', 'ldp', 'rip'].indexOf(o.profile.behaviour) >= 0);
    if (clients.length && !clients.some((o) => o.up)) {
      if (!s.x.waitNoted) {
        s.x.waitNoted = true;
        P.e.note('wait', s.protocol, s.dev, s.peer, 'waiting', '', `BFD to ${s.peer} waiting for its client (${Array.from(new Set(clients.map((o) => o.profile.label))).join(', ')}) to ask for the session`);
      }
      s.x.started = false;
      // (one waiter per generation; a restart or a power cycle makes the old one do nothing)
      if (s.x.waiting !== s.gen) {
        s.x.waiting = s.gen;
        const g = s.gen;
        P.whenSessionUp((o) => clients.indexOf(o) >= 0, () => {
          if (s.gen === g && s.x.stream !== g) P.startNow(s);
        });
      }
      return;
    }
    s.x.stream = s.gen;
    // its Control packets every interval — never faster than the peer said it takes (its Required Min RX, RFC 5880 §6.8.2),
    // and at least 1 s while the session is not Up (RFC 5880 §6.8.3)
    every(P, s, () => Math.max(bfdTx(P, s), typeof s.x.peerMinRx === 'number' ? (s.x.peerMinRx as number) : 0), () => {
      const iv = P.timer(s, s.profile, 'interval');
      const tx = bfdTx(P, s);
      const n = Math.max(1, Math.round(P.timer(s, s.profile, 'multiplier').ms / 1000));
      if (P.e.isL3Up(s.dev, s.local.l3.id)) P.unicast(s, 'Control', `state ${s.state}, desired min TX ${fmtSec(tx)}${tx !== iv.ms ? ' (at least 1 s while not Up)' : ''}, required min RX ${fmtSec(iv.ms)}, detect multiplier ${n}`, { state: s.state, minTx: tx, minRx: iv.ms, mult: n });
    });
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { state?: string; minTx?: number; minRx?: number; mult?: number };
    const peerState = d.state || 'Down';
    const iv = P.timer(s, s.profile, 'interval');
    // RFC 5880 §6.8.4: the detection time is the PEER's detect multiplier × the larger of this end's Required Min RX and the
    // peer's Desired Min TX (as its Control packets say) — not this end's own multiplier
    const n = typeof d.mult === 'number' ? d.mult : Math.max(1, Math.round(P.timer(s, s.profile, 'multiplier').ms / 1000));
    const rate = Math.max(iv.ms, typeof d.minTx === 'number' ? d.minTx : iv.ms);
    if (typeof d.minRx === 'number') s.x.peerMinRx = d.minRx;
    const detect = rate * n;
    const g = s.gen;
    P.e.after(detect, () => {
      if (s.gen !== g || s.state === 'Down') return;
      if (P.e.now - s.heard >= detect - 1) {
        P.setState(s, 'Down', false, `detection time expired (${fmtSec(detect)}: the peer's multiplier ${n} × ${fmtSec(rate)})`);
        bfdDown(P, s);
      }
    });
    // RFC 5880 6.8.6
    if (s.state === 'Down') {
      if (peerState === 'Down') P.setState(s, 'Init', false, 'Control with state Down from the peer');
      else if (peerState === 'Init') P.setState(s, 'Up', true, 'Control with state Init from the peer');
    } else if (s.state === 'Init') {
      if (peerState === 'Init' || peerState === 'Up') P.setState(s, 'Up', true, `Control with state ${peerState}`);
    } else if (s.state === 'Up' && peerState === 'Down') {
      P.setState(s, 'Down', false, 'the peer reports Down');
      bfdDown(P, s);
    }
  },
};

export const ROUTING_BEHAVIOURS: { [id: string]: Behaviour } = { ospf, isis, eigrp, rip, bgp, ldp, bfd };

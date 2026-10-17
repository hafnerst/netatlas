/**
 * The routing protocols' behaviours in the simulation: OSPF, IS-IS, EIGRP,
 * RIP, BGP (and the BGP-based EVPN and L3VPN), LDP (and the targeted LDP
 * of pseudowires and VPLS) and BFD. Each follows its profile's message
 * sequence and state machine (model/sim-profiles.ts) with the timers the
 * model sets or the defaults; see protocols.ts for how sessions are built.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { routerIdFor } from '../../model/services';
import { compareAddr, formatAddr } from '../ipmath';
import { lookup } from '../routing';
import { fmtSec } from './engine';
import { durationText } from './params';
import { Behaviour, ProtocolSim, Sess } from './protocols';

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

/** The sessions of a device in other relations of a protocol (or the same), that are up, for flooding. */
function others(P: ProtocolSim, s: Sess, protocol: string, ok: (o: Sess) => boolean): Sess[] {
  return Array.from(P.sessions.values())
    .filter((o) => o.dev === s.dev && o.protocol === protocol && !(o.peer === s.peer && o.rel.id === s.rel.id) && ok(o))
    .sort((a, b) => cmp(a.key, b.key));
}

/** Tell the protocols that use BFD between two devices that it went down. */
export function bfdDown(P: ProtocolSim, dev: string, peer: string): void {
  for (const s of Array.from(P.sessions.values()).sort((a, b) => cmp(a.key, b.key))) {
    if (s.dev !== dev || s.peer !== peer || !s.up) continue;
    if (['ospf', 'isis', 'eigrp', 'bgp', 'evpn', 'l3vpn'].indexOf(s.protocol) < 0) continue;
    const b = P.behaviours.get(s.profile.behaviour) as Behaviour & { down?: (P: ProtocolSim, s: Sess, why: string) => void };
    if (b.down) b.down(P, s, 'BFD session down');
  }
}

// ------------------------------------------------------------------ OSPF

interface OspfX {
  rid?: string;
  prio?: number;
  sent?: boolean;
  peerRid?: string;
  peerPrio?: number;
  seenUs?: boolean;
}

/** Hellos go out once per device, relation and interface (all its neighbours there hear them). */
function ospfHellos(P: ProtocolSim, s: Sess): void {
  const key = `ospf-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
  if (P.shared.has(key)) return;
  P.shared.set(key, true);
  const group = addr(s.local.addr.version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string));
  const rid = routerId(P, s.dev, 'ospf');
  const prio = Number(relPrio(s)) || 1;
  P.periodic(
    () => true,
    () => P.timer(s, s.profile, 'hello').ms,
    () => {
      const hello = P.timer(s, s.profile, 'hello');
      const dead = P.timer(s, s.profile, 'dead');
      const mine = (P.byRel.get(s.rel.id) || []).filter((o) => o.dev === s.dev && o.local.l3.id === s.local.l3.id);
      const seen = mine.filter((o) => o.state !== 'Down').map((o) => (o.x as OspfX).peerRid).filter((x) => !!x) as string[];
      const dr = drOf(P, s);
      if (P.e.isL3Up(s.dev, s.local.l3.id)) {
        P.multicast(s, group, 'Hello', `router ID ${rid}, priority ${prio}, hello ${hello.text}, dead ${dead.text}, neighbours seen: ${seen.length ? seen.join(', ') : 'none'}${dr ? ', DR ' + dr.dr + (dr.bdr ? ', BDR ' + dr.bdr : '') : ''}`, { rid, prio, seen, hello: hello.ms, dead: dead.ms });
      }
    },
  );
}

function relPrio(s: Sess): string {
  const own = s.rel.attrs.find(([k]) => k === 'priority.' + s.dev) || s.rel.attrs.find(([k]) => k === 'priority');
  return own ? own[1] : '1';
}

/** The routers of a relation on the same segment (the same local interface): three or more make it multi-access (DR and BDR are elected). */
function segment(P: ProtocolSim, s: Sess): Sess[] {
  return (P.byRel.get(s.rel.id) || []).filter((o) => o.dev === s.dev && o.local.l3.id === s.local.l3.id);
}

function multiAccess(P: ProtocolSim, s: Sess): boolean {
  return segment(P, s).length >= 2;
}

/** The DR and BDR of the segment (highest priority, then highest router ID) among this router and its neighbours in 2-Way or more. */
function drOf(P: ProtocolSim, s: Sess): { dr: string; bdr: string; drDev: string; bdrDev: string } | null {
  if (!multiAccess(P, s)) return null;
  const cands: Array<{ dev: string; rid: string; prio: number }> = [{ dev: s.dev, rid: routerId(P, s.dev, 'ospf'), prio: Number(relPrio(s)) || 1 }];
  for (const o of segment(P, s)) {
    const x = o.x as OspfX;
    if (o.state === 'Down' || o.state === 'Init' || !x.peerRid) continue;
    cands.push({ dev: o.peer, rid: x.peerRid, prio: x.peerPrio || 1 });
  }
  const live = cands.filter((c) => c.prio > 0).sort((a, b) => b.prio - a.prio || compareAddr(addr(b.rid) || addr('0.0.0.0'), addr(a.rid) || addr('0.0.0.0')));
  if (!live.length) return null;
  return { dr: live[0].rid, drDev: live[0].dev, bdr: live[1] ? live[1].rid : '', bdrDev: live[1] ? live[1].dev : '' };
}

function ospfShouldAdj(P: ProtocolSim, s: Sess): boolean {
  const d = drOf(P, s);
  if (!d) return true;
  return [d.drDev, d.bdrDev].indexOf(s.dev) >= 0 || [d.drDev, d.bdrDev].indexOf(s.peer) >= 0;
}

function ospfDown(P: ProtocolSim, s: Sess, why: string): void {
  if (s.state === 'Down') return;
  P.restart(s);
  const x = s.x as OspfX;
  x.sent = false;
  x.seenUs = false;
  P.setState(s, 'Down', false, why);
  ospfFlood(P, s, `${s.dev}'s router LSA without ${s.peer}`);
}

/** The router floods an LSU with its new router LSA to its other Full neighbours (reconvergence). */
function ospfFlood(P: ProtocolSim, s: Sess, what: string): void {
  const seq = (P.shared.get('ospf-seq|' + s.dev) as number) || 0;
  P.shared.set('ospf-seq|' + s.dev, seq + 1);
  for (const o of others(P, s, 'ospf', (x) => x.state === 'Full')) {
    P.unicast(o, 'LSU', `flooding ${what} (LSA sequence ${seq + 1})`, { flood: `${s.dev}#${seq + 1}`, origin: s.dev });
  }
}

const ospf: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  start(P, s) {
    const x = s.x as OspfX;
    x.rid = routerId(P, s.dev, 'ospf');
    x.prio = Number(relPrio(s)) || 1;
    s.x.detail = `router ID ${x.rid}`;
    ospfHellos(P, s);
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { rid?: string; prio?: number; seen?: string[]; flood?: string; origin?: string; phase?: string; dead?: number };
    const x = s.x as OspfX;
    switch (msg.type) {
      case 'Hello': {
        if (!P.e.isL3Up(s.dev, s.local.l3.id)) return;
        x.peerRid = d.rid;
        x.peerPrio = d.prio;
        const dead = P.timer(s, s.profile, 'dead');
        deadCheck(P, s, dead.ms, () => ospfDown(P, s, `dead interval expired (${dead.text}): no Hello from ${s.peer}`));
        if (s.state === 'Down') P.setState(s, 'Init', false, `Hello from ${s.peer} (router ID ${d.rid})`);
        const seesUs = (d.seen || []).indexOf(x.rid as string) >= 0;
        if (seesUs && s.state === 'Init') P.setState(s, '2-Way', false, `${s.peer}'s Hello lists us`);
        if (!seesUs && s.state !== 'Init' && s.state !== 'Down') {
          ospfDown(P, s, `${s.peer}'s Hello no longer lists us`);
          return;
        }
        const role = drOf(P, s);
        s.x.detail = `router ID ${x.rid}${role ? ` · DR ${role.dr}${role.bdr ? ', BDR ' + role.bdr : ''}${role.drDev === s.dev ? ' (this router is DR)' : role.bdrDev === s.dev ? ' (this router is BDR)' : ''}` : ''}`;
        if (s.state === '2-Way' && ospfShouldAdj(P, s)) {
          P.setState(s, 'ExStart', false, 'master / slave negotiation');
          P.unicast(s, 'DBD', `ExStart: I, M, MS bits set, router ID ${x.rid}`, { phase: 'init' }, 'ExStart');
        }
        return;
      }
      case 'DBD':
        if (s.state === 'Down') return;
        if (d.phase === 'init') {
          if (!x.sent && ['Init', '2-Way', 'ExStart'].indexOf(s.state) >= 0) {
            x.sent = true;
            P.setState(s, 'Exchange', false, `${s.peer} started the exchange`);
            P.unicast(s, 'DBD', 'Exchange: the LSA headers of the database', { phase: 'summary' }, 'Exchange');
          }
          return;
        }
        if (!x.sent) {
          x.sent = true;
          P.unicast(s, 'DBD', 'Exchange: the LSA headers of the database', { phase: 'summary' }, 'Exchange');
        }
        if (s.state !== 'Full' && s.state !== 'Loading') {
          P.setState(s, 'Loading', false, 'database summaries exchanged');
          P.unicast(s, 'LSR', 'requests the LSAs it lacks', {}, 'Loading');
        }
        return;
      case 'LSR':
        P.unicast(s, 'LSU', 'the requested LSAs', { reply: true });
        return;
      case 'LSU':
        if (d.flood) {
          // a flooded LSA: acknowledged, and flooded on once
          P.unicast(s, 'LSAck', `acknowledges ${d.flood}`);
          const seen = 'ospf-lsa|' + s.dev + '|' + d.flood;
          if (P.shared.has(seen) || d.origin === s.dev) return;
          P.shared.set(seen, true);
          for (const o of others(P, s, 'ospf', (q) => q.state === 'Full' && q.peer !== d.origin)) P.unicast(o, 'LSU', `flooding ${d.flood} on`, { flood: d.flood, origin: d.origin });
          P.e.routingChanged();
          return;
        }
        P.unicast(s, 'LSAck', 'acknowledges the LSAs');
        if (s.state === 'Loading') {
          P.setState(s, 'Full', true, 'databases synchronised');
          ospfFlood(P, s, `${s.dev}'s router LSA with ${s.peer}`);
        }
        return;
      default:
        return;
    }
  },
  iface(P, s, up) {
    if (!up) ospfDown(P, s, `interface ${s.local.l3.id} went down`);
  },
  adjUp(P, s) {
    if (s.state === 'Full') return true;
    if (s.state !== '2-Way' || !multiAccess(P, s)) return false;
    // two DROthers: they reach each other through the DR's network LSA once both are Full with it
    const d = drOf(P, s);
    if (!d) return false;
    const full = (dev: string): boolean => dev === d.drDev || (P.byRel.get(s.rel.id) || []).some((o) => o.dev === dev && o.peer === d.drDev && o.state === 'Full');
    return full(s.dev) && full(s.peer);
  },
  down: ospfDown,
};

// ------------------------------------------------------------------ IS-IS

const ISIS_MAC = '01:80:c2:00:00:15';

const isis: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  start(P, s) {
    const key = `isis-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const sys = routerId(P, s.dev, 'isis');
    P.periodic(
      () => true,
      () => P.timer(s, s.profile, 'hello').ms,
      () => {
        if (!P.e.isL3Up(s.dev, s.local.l3.id) || s.local.l3.kind === 'tunnel') return;
        const seen = (P.byRel.get(s.rel.id) || []).filter((o) => o.dev === s.dev && o.state !== 'Down').map((o) => o.peer);
        const m = P.msg(s, 'IIH', `${s.dev} on ${s.local.l3.id} to ${ISIS_MAC} (AllL2ISs), hold ${P.timer(s, s.profile, 'dead').text}; neighbours seen: ${seen.join(', ') || 'none'}`, { seen, sys });
        P.e.note('message', s.protocol, s.dev, s.peer, 'IIH', '', m.detail);
        for (const o of (P.byRel.get(s.rel.id) || []).filter((q) => q.dev === s.dev)) P.lane(s.rel, s.dev, o.peer, m, 2 * P.e.hopTime());
        P.e.emit(s.dev, s.local.l3, { src: s.local.l3.mac, dst: ISIS_MAC, msg: m, pdu: true });
      },
    );
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { seen?: string[] };
    if (msg.type === 'IIH') {
      const dead = P.timer(s, s.profile, 'dead');
      deadCheck(P, s, dead.ms, () => isis.down(P, s, `holding time expired (${dead.text})`));
      if (s.state === 'Down') P.setState(s, 'Initializing', false, `IIH from ${s.peer}`);
      if ((d.seen || []).indexOf(s.dev) >= 0 && s.state === 'Initializing') {
        P.setState(s, 'Up', true, 'three-way handshake complete');
        P.unicast(s, 'CSNP', 'the database summary');
      }
      return;
    }
    if (msg.type === 'CSNP') P.unicast(s, 'PSNP', 'requests the missing LSPs');
    else if (msg.type === 'PSNP') P.unicast(s, 'LSP', 'the requested LSPs');
    else if (msg.type === 'LSP') P.e.routingChanged();
  },
  iface(P, s, up) {
    if (!up) isis.down(P, s, `interface ${s.local.l3.id} went down`);
  },
  down(P, s, why) {
    if (s.state === 'Down') return;
    P.restart(s);
    P.setState(s, 'Down', false, why);
    for (const o of others(P, s, 'isis', (q) => q.up)) P.unicast(o, 'LSP', `${s.dev}'s new LSP without ${s.peer}`);
  },
};

// ------------------------------------------------------------------ EIGRP

const eigrp: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  start(P, s) {
    const key = `eigrp-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const group = addr(s.local.addr.version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string));
    P.periodic(
      () => true,
      () => P.timer(s, s.profile, 'hello').ms,
      () => {
        if (P.e.isL3Up(s.dev, s.local.l3.id)) P.multicast(s, group, 'Hello', `hold ${P.timer(s, s.profile, 'dead').text}`);
      },
    );
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { init?: boolean };
    const hold = P.timer(s, s.profile, 'dead');
    if (msg.type === 'Hello') {
      deadCheck(P, s, hold.ms, () => eigrp.down(P, s, `hold time expired (${hold.text})`));
      if (s.state === 'Down') {
        P.setState(s, 'Pending', false, `Hello from ${s.peer}`);
        s.x.sentInit = true;
        P.unicast(s, 'Update', 'init flag set, no routes yet', { init: true }, 'Pending');
      }
      return;
    }
    if (msg.type === 'Update' && d.init) {
      P.unicast(s, 'ACK', 'acknowledges the init Update');
      if (!s.x.sentInit) {
        s.x.sentInit = true;
        if (s.state === 'Down') P.setState(s, 'Pending', false, `init Update from ${s.peer}`);
        P.unicast(s, 'Update', 'init flag set', { init: true }, 'Pending');
      }
      return;
    }
    if (msg.type === 'ACK' && s.state === 'Pending') {
      P.setState(s, 'Up', true, 'init Updates acknowledged both ways');
      P.unicast(s, 'Update', 'its routes', {}, 'Up');
      return;
    }
    if (msg.type === 'Update') P.unicast(s, 'ACK', 'acknowledges the routes');
    else if (msg.type === 'Query') P.unicast(s, 'Reply', 'its way to the lost routes (or none)');
  },
  iface(P, s, up) {
    if (!up) eigrp.down(P, s, `interface ${s.local.l3.id} went down`);
  },
  down(P, s, why) {
    if (s.state === 'Down') return;
    P.restart(s);
    s.x.sentInit = false;
    P.setState(s, 'Down', false, why);
    for (const o of others(P, s, 'eigrp', (q) => q.up)) P.unicast(o, 'Query', `routes lost with ${s.peer}: is there another way?`);
  },
};

// ------------------------------------------------------------------ RIP

const rip: Behaviour = {
  start(P, s) {
    const key = `rip|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const group = addr(s.local.addr.version === 4 ? (s.profile.group4 as string) : (s.profile.group6 as string));
    P.multicast(s, group, 'Request', 'asks for the whole table');
    const upd = (): number => P.timer(s, s.profile, 'hello').ms;
    P.periodic(
      () => true,
      upd,
      () => {
        if (P.e.isL3Up(s.dev, s.local.l3.id)) P.multicast(s, group, 'Response', 'periodic update: its routes');
      },
      upd(),
    );
  },
  rx(P, s, msg) {
    if (msg.type === 'Request') {
      P.unicast(s, 'Response', 'answer to the request: its routes');
      return;
    }
    if (msg.type !== 'Response') return;
    const timeout = P.timer(s, s.profile, 'dead');
    deadCheck(P, s, timeout.ms, () => {
      P.restart(s);
      P.setState(s, 'Down', false, `timeout (${timeout.text}): its routes are dropped`);
      for (const o of others(P, s, 'rip', (q) => q.up)) P.unicast(o, 'Response', `triggered update: the routes via ${s.peer} are unreachable (metric 16)`);
    });
    if (s.state !== 'Heard') P.setState(s, 'Heard', true, `Response from ${s.peer}`);
  },
};

// ------------------------------------------------------------------ BGP (and EVPN, L3VPN)

function bgpRouteToPeer(P: ProtocolSim, s: Sess): boolean {
  const d = lookup(P.m, s.dev, s.local.l3.vrf, s.remote.addr, P.e.ctx(s.dev));
  return d.kind === 'forward' || d.kind === 'local';
}

function bgpConnect(P: ProtocolSim, s: Sess): void {
  if (!s.initiator) return;
  if (s.state === 'Established') return;
  if (!bgpRouteToPeer(P, s)) {
    // a session between loopbacks waits for a route to the peer (the IGP): it goes on the moment there is one
    if (s.state !== 'Active') P.setState(s, 'Active', false, `no route to ${formatAddr(s.remote.addr)} yet (waiting for ${s.local.l3.kind === 'loopback' ? 'the IGP' : 'the routes of its interface'})`);
    const g = s.gen;
    const m = P.msg(s, 'TCP SYN', `to port 179 of ${formatAddr(s.remote.addr)}`);
    P.e.waitFor(`route:${s.dev}|${s.local.l3.vrf}|${formatAddr(s.remote.addr)}`, `a route to ${formatAddr(s.remote.addr)}`, s.dev, m, () => {
      if (s.gen === g) bgpConnect(P, s);
    }, `${s.key}|bgp-route`);
    return;
  }
  P.setState(s, 'Connect', false, `opening TCP to ${formatAddr(s.remote.addr)} port 179`);
  P.e.note('wait', s.protocol, s.dev, s.peer, 'waiting', '', `${s.profile.label} OPEN to ${formatAddr(s.remote.addr)} waiting for TCP (the connection to port 179)`);
  s.x.tcpSince = P.e.now;
  bgpSyn(P, s, 0, (s.x.synTok = ((s.x.synTok as number) || 0) + 1));
  const retry = P.timer(s, s.profile, 'connect-retry');
  P.later(s, retry.ms, () => {
    if (s.state === 'Connect' || s.state === 'Active') {
      P.setState(s, 'Active', false, `ConnectRetry timer expired (${retry.text})`);
      bgpConnect(P, s);
    }
  });
}

/**
 * BGP's TCP connection: its SYN is sent again after the initial
 * retransmission timeout, doubling each time, until the SYN retries are
 * spent (Layer 4 parameters); then the attempt has timed out and the
 * ConnectRetry timer tries again.
 */
function bgpSyn(P: ProtocolSim, s: Sess, n: number, tok: number): void {
  P.unicast(s, 'TCP SYN', n ? `to port 179, retransmission ${n}` : 'to port 179', {}, 'Connect');
  const rto = Math.min(120000, P.e.params.num('tcp-rto', s.dev) * Math.pow(2, n));
  P.later(s, rto, () => {
    if (s.state !== 'Connect' || s.x.synTok !== tok) return;
    const max = P.param('tcp-syn-retries', s.dev);
    if (n >= Number(max.value)) {
      P.e.note('state', s.protocol, s.dev, s.peer, 'TCP connect timed out', 'Connect', `${s.rel.id}: ${s.dev}'s TCP connection to ${formatAddr(s.remote.addr)}:179 timed out after ${n} retransmissions (TCP SYN retries ${P.paramText(max)}); the ConnectRetry timer tries again`);
      return;
    }
    bgpSyn(P, s, n + 1, tok);
  });
}

function updateText(s: Sess): string {
  if (s.protocol === 'evpn') return 'EVPN routes: type 2 (MAC/IP) and type 3 (inclusive multicast)';
  if (s.protocol === 'l3vpn') return 'VPNv4 prefixes with route distinguisher, route targets and labels';
  return 'its prefixes';
}

const bgp: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string, notify?: boolean) => void } = {
  refresh(P, s) {
    s.x.detail = `keepalive ${P.timer(s, s.profile, 'keepalive').text}, hold ${P.timer(s, s.profile, 'hold').text}`;
  },
  start(P, s) {
    bgp.refresh!(P, s);
    if (s.initiator) bgpConnect(P, s);
    else if (s.state === 'Idle') P.setState(s, 'Active', false, 'waiting for the peer to connect');
  },
  rx(P, s, msg) {
    const hold = P.timer(s, s.profile, 'hold');
    const dd = P.m.index.devices.get(s.dev);
    const asn = dd ? (dd.services.find((x) => x.id === 'bgp') || { values: new Map() }).values.get('asn') : undefined;
    switch (msg.type) {
      case 'TCP SYN':
        if (s.state === 'Established') bgp.down(P, s, 'the peer reconnects');
        P.unicast(s, 'TCP SYN-ACK', 'accepts the connection on port 179', {}, 'Connect');
        if (s.state !== 'Connect') P.setState(s, 'Connect', false, 'TCP connection from the peer');
        return;
      case 'TCP SYN-ACK':
        if (s.state !== 'Connect') return;
        P.unicast(s, 'TCP ACK', 'the connection is open');
        P.setState(s, 'OpenSent', false, 'TCP connection established');
        s.x.waitedNext = [`TCP connection to ${formatAddr(s.remote.addr)}:179: ${durationText(P.e.now - ((s.x.tcpSince as number) || P.e.now))}`];
        P.unicast(s, 'OPEN', `AS ${asn || '?'}, hold time ${fmtSec(hold.ms)}, BGP identifier ${routerId(P, s.dev, 'bgp')}${s.protocol === 'evpn' ? ', L2VPN EVPN' : s.protocol === 'l3vpn' ? ', VPNv4' : ''}`, {}, 'OpenSent');
        return;
      case 'TCP ACK':
        if (s.state !== 'Connect') return;
        P.setState(s, 'OpenSent', false, 'TCP connection established');
        P.unicast(s, 'OPEN', `AS ${asn || '?'}, hold time ${fmtSec(hold.ms)}, BGP identifier ${routerId(P, s.dev, 'bgp')}`, {}, 'OpenSent');
        return;
      case 'OPEN':
        if (s.state !== 'OpenSent') return;
        P.setState(s, 'OpenConfirm', false, `OPEN from ${s.peer}`);
        P.unicast(s, 'KEEPALIVE', 'confirms the OPEN', {}, 'OpenConfirm');
        return;
      case 'KEEPALIVE':
        if (s.state === 'OpenConfirm') {
          P.setState(s, 'Established', true, 'KEEPALIVE received');
          s.x.waitedNext = ['the session to be Established'];
          P.unicast(s, 'UPDATE', updateText(s), {}, 'Established');
          const g = s.gen;
          const kms = (): number => P.timer(s, s.profile, 'keepalive').ms;
          P.periodic(
            () => s.gen === g && s.state === 'Established',
            kms,
            () => P.unicast(s, 'KEEPALIVE', `every ${P.timer(s, s.profile, 'keepalive').text}`),
            kms(),
          );
        }
        if (s.state === 'Established') deadCheck(P, s, hold.ms, () => bgp.down(P, s, `hold timer expired (${hold.text})`, true));
        return;
      case 'UPDATE':
        if (s.state === 'Established') deadCheck(P, s, hold.ms, () => bgp.down(P, s, `hold timer expired (${hold.text})`, true));
        return;
      case 'NOTIFICATION':
        bgp.down(P, s, `NOTIFICATION from ${s.peer}`);
        return;
      default:
        return;
    }
  },
  down(P: ProtocolSim, s: Sess, why: string, notify = false) {
    if (s.state === 'Idle' && !s.up) return;
    const was = s.state === 'Established';
    if (notify) P.unicast(s, 'NOTIFICATION', `Hold Timer Expired: closes the session`);
    P.restart(s);
    P.setState(s, 'Idle', false, why);
    if (was) for (const o of others(P, s, s.protocol, (q) => q.state === 'Established')) P.unicast(o, 'UPDATE', `withdraws the prefixes learned from ${s.peer}`);
    const retry = P.timer(s, s.profile, 'connect-retry');
    if (s.initiator) P.later(s, retry.ms, () => bgpConnect(P, s));
    else P.later(s, 1000, () => P.setState(s, 'Active', false, 'waiting for the peer to connect again'));
  },
};

// ------------------------------------------------------------------ LDP (link and targeted)

const ldp: Behaviour & { down: (P: ProtocolSim, s: Sess, why: string) => void } = {
  start(P, s) {
    const targeted = s.protocol !== 'ldp';
    const group = addr('224.0.0.2');
    const name = targeted ? 'Targeted Hello' : 'Hello';
    every(P, s, () => P.timer(s, s.profile, 'hello').ms, () => {
      const hello = P.timer(s, s.profile, 'hello');
      if (targeted || s.local.addr.version === 6) P.unicast(s, name, `transport address ${formatAddr(s.local.addr)}, hold ${P.timer(s, s.profile, 'dead').text}`);
      else if (s.initiator || true) {
        const key = `ldp-hello|${s.rel.id}|${s.dev}|${Math.floor(P.e.now / hello.ms)}`;
        if (!P.shared.has(key)) {
          P.shared.set(key, true);
          P.multicast(s, group, 'Hello', `transport address ${formatAddr(s.local.addr)}, hold ${P.timer(s, s.profile, 'dead').text}`);
        }
      }
    });
  },
  rx(P, s, msg) {
    const hold = P.timer(s, s.profile, 'dead');
    // the side with the higher transport address opens the session (RFC 5036 2.5.2)
    const active = compareAddr(s.local.addr, s.remote.addr) > 0;
    switch (msg.type) {
      case 'Hello':
      case 'Targeted Hello':
        deadCheck(P, s, hold.ms, () => ldp.down(P, s, `hello hold time expired (${hold.text})`));
        if (s.state === 'Non-existent' && active) {
          P.setState(s, 'Initialized', false, `hello from ${s.peer}; opening the session (higher transport address)`);
          P.unicast(s, 'TCP SYN', 'to port 646');
        }
        return;
      case 'TCP SYN':
        P.unicast(s, 'TCP SYN-ACK', 'port 646');
        if (s.state === 'Non-existent') P.setState(s, 'Initialized', false, 'TCP from the peer');
        return;
      case 'TCP SYN-ACK':
        P.unicast(s, 'TCP ACK', 'the session’s TCP is open');
        P.setState(s, 'OpenSent', false, 'TCP open');
        P.unicast(s, 'Initialization', 'session parameters (keepalive time, label distribution)');
        return;
      case 'Initialization':
        if (s.state === 'Initialized' || s.state === 'Non-existent') {
          P.setState(s, 'OpenRec', false, 'Initialization from the peer');
          P.unicast(s, 'Initialization', 'session parameters');
        } else if (s.state === 'OpenSent') P.setState(s, 'OpenRec', false, 'Initialization from the peer');
        P.unicast(s, 'Keepalive', 'accepts the session');
        return;
      case 'Keepalive':
        if (s.state === 'OpenRec') {
          P.setState(s, 'Operational', true, 'session up');
          if (s.protocol === 'ldp') P.unicast(s, 'Address', 'its interface addresses');
          P.unicast(s, s.protocol === 'pseudowire' ? 'Label Mapping (PW)' : s.protocol === 'vpls' ? 'Label Mapping (VPLS)' : 'Label Mapping', s.protocol === 'ldp' ? 'a label per prefix (FEC)' : 'the pseudowire label (FEC 128)');
          every(P, s, () => P.timer(s, s.profile, 'keepalive').ms, () => {
            if (s.state === 'Operational') P.unicast(s, 'Keepalive', `every ${P.timer(s, s.profile, 'keepalive').text}`);
          });
        }
        return;
      default:
        return;
    }
  },
  iface(P, s, up) {
    if (!up && s.protocol === 'ldp') ldp.down(P, s, `interface ${s.local.l3.id} went down`);
  },
  down(P, s, why) {
    if (s.state === 'Non-existent') return;
    P.restart(s);
    P.setState(s, 'Non-existent', false, why + '; labels withdrawn');
    ldp.start(P, s);
  },
};

// ------------------------------------------------------------------ BFD

const bfd: Behaviour = {
  refresh(P, s) {
    const iv = P.timer(s, s.profile, 'interval');
    const mult = P.timer(s, s.profile, 'multiplier');
    const n = Math.max(1, Math.round(mult.ms / 1000));
    s.x.detail = `interval ${iv.text}, multiplier ${mult.text}: detection ${fmtSec(iv.ms * n)}`;
  },
  start(P, s) {
    bfd.refresh!(P, s);
    // BFD runs for a client: it starts when a routing session to the same peer asks for it (is up); with no client, at once
    const clients = P.sessionsOf(s.dev).filter((o) => o.peer === s.peer && o.profile.behaviour !== 'bfd' && ['ospf', 'bgp', 'isis', 'eigrp', 'ldp', 'rip'].indexOf(o.profile.behaviour) >= 0);
    if (clients.length && !clients.some((o) => o.up)) {
      if (!s.x.waitNoted) {
        s.x.waitNoted = true;
        P.e.note('wait', s.protocol, s.dev, s.peer, 'waiting', '', `BFD to ${s.peer} waiting for its client (${Array.from(new Set(clients.map((o) => o.profile.label))).join(', ')}) to ask for the session`);
      }
      s.x.started = false;
      P.whenSessionUp((o) => clients.indexOf(o) >= 0, () => P.startNow(s));
      return;
    }
    every(P, s, () => P.timer(s, s.profile, 'interval').ms, () => {
      const iv = P.timer(s, s.profile, 'interval');
      const n = Math.max(1, Math.round(P.timer(s, s.profile, 'multiplier').ms / 1000));
      if (P.e.isL3Up(s.dev, s.local.l3.id)) P.unicast(s, 'Control', `state ${s.state}, desired interval ${fmtSec(iv.ms)}, detect multiplier ${n}`, { state: s.state });
    });
  },
  rx(P, s, msg) {
    const peerState = ((msg.data || {}) as { state?: string }).state || 'Down';
    const iv = P.timer(s, s.profile, 'interval');
    const n = Math.max(1, Math.round(P.timer(s, s.profile, 'multiplier').ms / 1000));
    const detect = iv.ms * n;
    const g = s.gen;
    P.e.after(detect, () => {
      if (s.gen !== g || s.state === 'Down') return;
      if (P.e.now - s.heard >= detect - 1) {
        P.setState(s, 'Down', false, `detection time expired (${fmtSec(detect)}: ${n} × ${fmtSec(iv.ms)})`);
        bfdDown(P, s.dev, s.peer);
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
      bfdDown(P, s.dev, s.peer);
    }
  },
};

export const ROUTING_BEHAVIOURS: { [id: string]: Behaviour } = { ospf, isis, eigrp, rip, bgp, ldp, bfd };

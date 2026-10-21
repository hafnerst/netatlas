/**
 * The other behaviours of the simulation: first-hop redundancy (VRRP,
 * HSRP, GLBP, CARP, from the groups on the interfaces), IPsec (IKEv2),
 * the generic sessions (GRE, WireGuard, OpenVPN, MLAG …: a handshake, then
 * keepalives), services (request and response, or one way), encapsulated
 * data (VXLAN …), the dummy packets of the model's own protocols, LACP on
 * every aggregate's members, STP, LLDP and CDP, gratuitous ARP at boot,
 * PIM with IGMP, and the model's traffic demands.
 */
import { IpAddr, parseAddress } from '../../model/ip';
import { simProfile } from '../../model/sim-profiles';
import { bpsText, representativeText } from '../../model/speed';
import { Relation, deviceInterfaces, relationDevices } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { parseTraceEnd } from '../trace';
import { encapStack } from '../trace';
import { fmtSec } from './engine';
import { isMulticastIp, multicastMac, virtualMac } from './mac';
import { L3Iface, carries, otherEnd, portKey, linkPort } from './net';
import { ifaceRef, relRef } from './params';
import { Behaviour, ProtocolSim, Sess, ipOf } from './protocols';
import { TcpBehaviour, tcpClose, tcpConnect, tcpListen, tcpOpen, tcpSend } from './proto-tcp';
import { Msg, Pkt, SessionStatus } from './types';
import { pimValue } from '../pim-rp';
import { routerId } from './proto-routing';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const addr = (s: string): IpAddr => parseAddress(s) as IpAddr;

/** Every `ms()` (from now), while the session's generation lasts; a parameter change reschedules it. */
function every(P: ProtocolSim, s: Sess, ms: () => number, fn: () => void): void {
  const g = s.gen;
  P.periodic(() => s.gen === g, ms, fn);
}

function deadCheck(P: ProtocolSim, s: Sess, ms: number, dead: () => void): void {
  P.armDead(s, ms, dead);
}

// ------------------------------------------------------------------ first-hop redundancy

interface FhrpMember {
  /** this member's own bookkeeping (device, interface, group, family): never on the wire, never compared with a peer's */
  key: string;
  protocol: string;
  dev: string;
  l3: L3Iface;
  group: number;
  vip: IpAddr;
  vmac: string;
  prio: number;
  preempt: boolean;
  /** VRRP: the virtual address is one of the interface's own (priority 255, RFC 5798 §6.1) */
  owner: boolean;
  state: string;
  gen: number;
  /** VRRP / CARP: the master last heard; HSRP / GLBP: the Active and the Standby last heard (when, priority, address) */
  heardAt: number;
  active?: { at: number; prio: number; ip: string; dev: string };
  standby?: { at: number; prio: number; ip: string; dev: string };
  /** VRRP: the lower-priority master whose advertisements this preempting backup discards (since it became Backup) */
  lower?: { dev: string; prio: number };
  rel?: Relation;
}

const FHRP = ['vrrp', 'hsrp', 'glbp', 'carp'];

/** VRRP and CARP elect a master that alone advertises; HSRP and GLBP (its gateway, the AVG) an Active and a Standby that both say hello. */
function hsrpLike(protocol: string): boolean {
  return protocol === 'hsrp' || protocol === 'glbp';
}

/** the state a member is in while its interface is down, by its protocol's name for it (RFC 5798 Initialize, RFC 2281 Initial, carp(4) INIT) */
function initState(protocol: string): string {
  return protocol === 'vrrp' ? 'Initialize' : protocol === 'carp' ? 'Init' : 'Initial';
}

/**
 * The redundancy groups on the interfaces, each protocol's own way:
 *
 *   VRRP (RFC 5798) and CARP: the master alone advertises (IP protocol
 *   112 to 224.0.0.18 / ff02::12, TTL 255 — a receiver takes only TTL 255,
 *   §7.1; IPv6 from the interface's link-local address, §5.1.2.1); a
 *   backup becomes master after the master down interval (3 × the
 *   interval + the skew of its priority); the owner of the virtual
 *   address (an address of its interface) has priority 255 and is master
 *   at once. VRRP preemption (the default): a backup discards the
 *   advertisements of a lower priority — an equal one it accepts — and
 *   becomes master when its master down timer expires (§6.4.2); a master
 *   steps down for a higher priority, or an equal one from a higher
 *   primary address (§6.4.3). CARP: a preempting backup that outranks the
 *   master takes over at once (carp(4)).
 *   HSRP (RFC 2281) and GLBP's gateway election: the Active and the
 *   Standby router both send Hellos (HSRP version 1: UDP 1985 to 224.0.0.2
 *   with TTL 1; version 2 — Cisco's, for groups above 255 and for IPv6 —
 *   224.0.0.102, in IPv6 UDP 2029 to ff02::66 from the link-local address;
 *   GLBP UDP 3222 to 224.0.0.102 / ff02::66, TTL 255); the others Listen
 *   silently. A router
 *   that hears no Active (or no Standby) for the hold time Speaks — says
 *   hello and takes part — and after a hold time Speaking without a better
 *   one it becomes Standby, or Active when there is none; the Standby
 *   becomes Active when the Active's Hellos stop. Preemption only when
 *   configured (a Coup: the Active Resigns to Speak). GLBP: one virtual
 *   forwarder, the AVG's — no load sharing between gateways.
 *
 * The holder of the virtual address answers for it with the virtual MAC
 * and announces it with a gratuitous ARP when it takes it over.
 *
 * What a router matches a received advertisement or Hello by is what the
 * protocol carries: the group (VRID, VHID) of its address family, on the
 * interface it arrived on — never the receiver's VRF or another local
 * name. A different virtual address is logged (VRRP, HSRP, GLBP) or, for
 * CARP (its HMAC covers the addresses), discarded.
 */
export function installFhrp(P: ProtocolSim): void {
  const members: FhrpMember[] = [];
  for (const d of P.m.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
    for (const i of deviceInterfaces(d)) {
      for (const sv of i.services) {
        if (FHRP.indexOf(sv.id) < 0) continue;
        const g = Number(sv.values.get('group'));
        const vipText = sv.values.get('virtual_ip');
        const vip = vipText ? parseAddress(vipText) : null;
        const l3 = P.sd(d.id).l3.get(i.id);
        if (!vip || !l3 || !Number.isFinite(g)) continue;
        const owner = (sv.id === 'vrrp' || sv.id === 'carp') && l3.addrs.some((a) => compareAddr(a.addr, vip) === 0);
        const prio = owner ? 255 : Number(sv.values.get('priority') || '100');
        const rel = P.m.relations.find((r) => P.e.base(r) === sv.id && relationDevices(r).indexOf(d.id) >= 0);
        const pre = rel ? rel.attrs.find(([k]) => k === 'preempt') : undefined;
        members.push({ key: `${sv.id}|${d.id}|${i.id}|${g}|${vip.version}`, protocol: sv.id, dev: d.id, l3, group: g, vip, vmac: virtualMac(sv.id, g, vip.version), prio, owner, preempt: owner || (pre ? pre[1] !== 'false' : !hsrpLike(sv.id)), state: initState(sv.id), gen: 0, heardAt: -1, rel });
      }
    }
  }
  if (!members.length) return;
  const label = (m: FhrpMember): string => (simProfile(m.protocol) || { label: m.protocol.toUpperCase() }).label;
  const timers = (m: FhrpMember): { adv: number; down: number } => {
    const p = simProfile(m.protocol);
    const hold = p ? p.timers.find((t) => t.key === 'dead') : undefined;
    const a = p ? P.timer(null, p, 'hello', m.dev).ms : 1000;
    // VRRP / CARP: 3 × advertisement + skew ((256 − priority) / 256 × the interval); HSRP / GLBP: the hold time
    const down = hsrpLike(m.protocol) ? (hold ? hold.seconds : 10) * 1000 : 3 * a + Math.round(((256 - m.prio) / 256) * a);
    return { adv: a, down };
  };
  /** its source and primary address: IPv4 the interface's first, IPv6 its link-local one (RFC 5798 §1.6, §5.1.2.1) */
  const srcOf = (m: FhrpMember): IpAddr | null => {
    if (m.vip.version === 6) return m.l3.ll ? m.l3.ll.addr : null;
    const a = m.l3.addrs.find((x) => x.addr.version === 4);
    return a ? a.addr : null;
  };
  const ownIp = (m: FhrpMember): string => {
    const a = srcOf(m);
    return a ? formatAddr(a) : m.vip.version === 6 ? '::' : '0.0.0.0';
  };
  /** the members a member's messages are for (the lane drawn): the same relation, protocol, group and family */
  const peersOf = (m: FhrpMember): FhrpMember[] => members.filter((o) => o !== m && o.rel === m.rel && o.protocol === m.protocol && o.group === m.group && o.vip.version === m.vip.version);
  /** does (priority, address) a outrank b (higher priority, then the higher address)? */
  const outranks = (pa: number, ia: string, pb: number, ib: string): boolean => pa > pb || (pa === pb && compareAddr(addr(ia), addr(ib)) > 0);
  const holds = (st: string): boolean => st === 'Master' || st === 'Active';
  const set = (m: FhrpMember, st: string, why: string): void => {
    if (m.state === st) return;
    const had = holds(m.state);
    m.state = st;
    P.e.note('state', m.protocol, m.dev, '', st, st, `${label(m)} group ${m.group} (${formatAddr(m.vip)}) on ${m.dev}:${m.l3.id}: ${st}${why ? ' (' + why + ')' : ''}`);
    const k = m.dev + ':' + m.l3.id;
    const held = (P.vips.get(k) || []).filter((v) => !(compareAddr(v.addr, m.vip) === 0 && v.protocol === m.protocol));
    if (holds(st)) held.push({ addr: m.vip, mac: m.vmac, protocol: m.protocol });
    P.vips.set(k, held);
    // the new holder announces the virtual address with the virtual MAC: switches learn its port, hosts keep their entry
    if (holds(st) && !had) P.e.gratuitous(m.dev, m.l3, m.vip, m.vmac, `${label(m)} group ${m.group}: ${m.dev} is the new ${st}`, 'garp');
  };
  /** One advertisement or Hello of a member, its protocol's way (transport, TTL, source MAC). */
  const say = (m: FhrpMember, op = ''): void => {
    const p = simProfile(m.protocol);
    const hs = hsrpLike(m.protocol);
    const type = hs ? op || 'Hello' : 'Advertisement';
    const v2 = m.protocol === 'hsrp' && (m.vip.version === 6 || m.group > 255);
    const group = addr(m.vip.version === 6 ? (hs ? 'ff02::66' : (p && p.group6) || 'ff02::12') : v2 ? '224.0.0.102' : (p && p.group4) || '224.0.0.18');
    const src = srcOf(m);
    if (!src || !P.e.isL3Up(m.dev, m.l3.id)) return;
    // the Active (and the VRRP master) sends from the virtual MAC; a Standby or Speaking router from its own
    const smac = holds(m.state) ? m.vmac : m.l3.mac;
    const port = m.protocol === 'hsrp' ? (m.vip.version === 6 ? 2029 : 1985) : 3222;
    // HSRP in IPv4 (v1, v2): TTL 1 (RFC 2281 §5); in IPv6 255 (a link-local message, as ND's); GLBP: 255 (Cisco's GLBP, Wireshark's
    // check of 224.0.0.102); VRRP and CARP: 255 (RFC 5798 §5.1.1.3)
    const ttl = m.protocol === 'hsrp' && m.vip.version === 4 ? 1 : 255;
    const msg: Msg = { protocol: m.protocol, type, label: `${label(m)} ${type}${hs ? ' (' + m.state + ')' : ''}`, detail: `${label(m)}${v2 ? ' version 2' : ''} ${type}: group ${m.group}, ${hs ? 'state ' + m.state + ', ' : ''}priority ${m.prio}${m.owner ? ' (the address owner)' : ''}, virtual ${formatAddr(m.vip)}, from ${m.dev}:${m.l3.id} ${formatAddr(src)} (source MAC ${smac}${smac === m.vmac ? ', the virtual MAC' : ''}) to ${formatAddr(group)} (${multicastMac(group)})${hs ? `, UDP ${port}` : ', IP protocol 112'}, ${m.vip.version === 6 ? 'hop limit' : 'TTL'} ${ttl}`, relation: m.rel ? m.rel.id : undefined, data: { from: m.dev, group: m.group, vip: formatAddr(m.vip), prio: m.prio, ip: formatAddr(src), state: m.state, op: type } };
    P.e.note('message', m.protocol, m.dev, '', type, m.state, msg.detail, P.e.now, msg);
    if (m.rel) for (const o of peersOf(m)) P.lane(m.rel, m.dev, o.dev, msg, 2 * P.e.hopTime());
    const pkt = P.e.newPacket(src, group, m.l3.vrf, msg, m.rel ? [m.rel.id] : [], ttl);
    pkt.l4 = hs ? { proto: 'udp', num: 17, sport: port, dport: port } : { proto: 'other', num: 112 };
    // HSRP: UDP + its 20 bytes; VRRP / CARP: the 8-byte header + the one virtual address (4 or 16 bytes, RFC 5798 §5.1)
    pkt.len = hs ? 8 + (v2 ? (m.vip.version === 6 ? 52 : 40) : 20) : 8 + (m.vip.version === 6 ? 16 : 4);
    P.e.emit(m.dev, m.l3, { src: smac, dst: multicastMac(group), msg, ip: pkt });
  };

  // -------------------------------------------------- VRRP, CARP
  const master = (m: FhrpMember, why: string): void => {
    m.gen++;
    set(m, 'Master', why);
    const g = m.gen;
    say(m);
    P.periodic(
      () => m.gen === g && m.state === 'Master',
      () => timers(m).adv,
      () => say(m),
      timers(m).adv,
    );
  };
  const backup = (m: FhrpMember, why: string): void => {
    m.gen++;
    m.lower = undefined;
    set(m, 'Backup', why);
    const g = m.gen;
    const wait = (): void => {
      if (m.gen !== g || m.state !== 'Backup') return;
      const lower = m.lower;
      if (P.e.now - m.heardAt >= timers(m).down - 1) master(m, lower && P.e.now - m.heardAt >= timers(m).down - 1 ? `preempts ${lower.dev} (priority ${m.prio} > ${lower.prio}): master down interval expired (${fmtSec(timers(m).down)}) with only its advertisements heard` : m.heardAt < 0 ? 'no master heard' : `master down interval expired (${fmtSec(timers(m).down)}): no advertisement from the master`);
      else P.e.after(timers(m).down - (P.e.now - m.heardAt), wait);
    };
    P.e.after(timers(m).down, wait);
  };
  const vrStart = (m: FhrpMember, why: string): void => {
    // RFC 5798 §6.4.1: the owner of the address (priority 255) is master at once; the others start as backup
    if (m.owner) master(m, `${why}: it owns ${formatAddr(m.vip)} (priority 255)`);
    else backup(m, why);
  };
  const vrIn = (m: FhrpMember, d: { prio?: number; ip?: string; from?: string }, ttl: number): void => {
    if (ttl !== 255) {
      P.e.note('drop', m.protocol, m.dev, d.from || '', 'Advertisement', m.state, `${m.dev} discards a ${label(m)} advertisement with TTL ${ttl} (RFC 5798 §7.1: only TTL 255)`);
      return;
    }
    const theirs = d.prio || 0;
    const higher = outranks(theirs, d.ip || ownIp(m), m.prio, ownIp(m));
    if (m.state === 'Backup') {
      if (m.protocol === 'carp') {
        // carp(4): a preempting backup that would advertise more often than the master takes over at once; else it listens
        if (m.preempt && m.prio > theirs) master(m, `preempts ${d.from} (priority ${m.prio} > ${theirs})`);
        else m.heardAt = P.e.now;
      } else if (!m.preempt || theirs >= m.prio) m.heardAt = P.e.now;
      else {
        // RFC 5798 §6.4.2: a lower priority's advertisement is discarded (the master down timer runs on): it takes over when that expires
        m.lower = { dev: d.from || '', prio: theirs };
        P.e.note('drop', m.protocol, m.dev, d.from || '', 'Advertisement', m.state, `${m.dev} (priority ${m.prio}, preempt) discards ${d.from}'s advertisement with priority ${theirs}: it becomes Master when its master down timer expires (RFC 5798 §6.4.2)`);
      }
    } else if (m.state === 'Master' && higher) {
      m.heardAt = P.e.now;
      backup(m, `${d.from} has priority ${theirs}`);
    }
  };

  // -------------------------------------------------- HSRP, GLBP (its gateway election)
  const hsTick = (m: FhrpMember): void => {
    // every hello time: the Active, the Standby and a Speaking router say hello; the timers decide the next state
    const g = m.gen;
    P.periodic(
      () => m.gen === g && m.state !== initState(m.protocol),
      () => timers(m).adv,
      () => {
        if (m.state === 'Active' || m.state === 'Standby' || m.state === 'Speak') say(m);
        const hold = timers(m).down;
        const now = P.e.now;
        const activeGone = !m.active || now - m.active.at >= hold;
        const standbyGone = !m.standby || now - m.standby.at >= hold;
        if (m.state === 'Listen' && (activeGone || standbyGone)) hsSpeak(m, activeGone ? 'no Active heard for the hold time' : 'no Standby heard for the hold time');
        else if (m.state === 'Standby' && activeGone) hsSet(m, 'Active', `no Hello from the Active ${m.active ? m.active.dev : ''} for the hold time (${fmtSec(hold)})`.replace('  ', ' '));
      },
      timers(m).adv,
    );
  };
  const hsSet = (m: FhrpMember, st: string, why: string): void => {
    set(m, st, why);
    if (st === 'Active') m.active = undefined;
    if (st === 'Standby') m.standby = undefined;
  };
  const hsSpeak = (m: FhrpMember, why: string): void => {
    set(m, 'Speak', why);
    const g = m.gen;
    const hold = timers(m).down;
    P.e.after(hold, () => {
      if (m.gen !== g || m.state !== 'Speak') return;
      const now = P.e.now;
      // after a hold time Speaking: Active when there is none, else Standby when it is the best of the others, else Listen again
      if (!m.active || now - m.active.at >= hold) hsSet(m, 'Active', 'no Active heard while Speaking');
      else if (!m.standby || now - m.standby.at >= hold || outranks(m.prio, ownIp(m), m.standby.prio, m.standby.ip)) hsSet(m, 'Standby', 'the best of the other routers');
      else set(m, 'Listen', `${m.standby.dev} is Standby with a higher priority`);
    });
  };
  const hsStart = (m: FhrpMember, why: string): void => {
    m.gen++;
    m.active = m.standby = undefined;
    set(m, 'Listen', why);
    hsTick(m);
  };
  const hsIn = (m: FhrpMember, d: { prio?: number; ip?: string; from?: string; state?: string; op?: string }): void => {
    const theirs = { at: P.e.now, prio: d.prio || 0, ip: d.ip || '0.0.0.0', dev: d.from || '' };
    const better = outranks(theirs.prio, theirs.ip, m.prio, ownIp(m));
    if (d.op === 'Resign') {
      if (m.active && m.active.dev === theirs.dev) m.active = undefined;
      return;
    }
    if (d.op === 'Coup' || d.state === 'Active') {
      if (m.state === 'Active' && (d.op === 'Coup' ? better : better)) {
        // a better router took over (a Coup, or another Active that outranks it): it resigns
        say(m, 'Resign');
        set(m, 'Speak', `${theirs.dev} ${d.op === 'Coup' ? 'takes over (Coup)' : 'is Active with a higher priority'}`);
        hsSpeak(m, 'resigned');
        m.active = theirs;
        return;
      }
      m.active = theirs;
      // preemption (configured): a higher-priority Standby or Speaking router takes over with a Coup
      if (m.preempt && (m.state === 'Standby' || m.state === 'Speak') && outranks(m.prio, ownIp(m), theirs.prio, theirs.ip)) {
        say(m, 'Coup');
        hsSet(m, 'Active', `preempts ${theirs.dev} (priority ${m.prio} > ${theirs.prio})`);
      }
      return;
    }
    if (d.state === 'Standby' || d.state === 'Speak') {
      if (d.state === 'Standby') m.standby = theirs;
      if (m.state === 'Standby' && better) set(m, 'Listen', `${theirs.dev} (priority ${theirs.prio}) is the better Standby`);
    }
  };

  P.bootHooks.push(() => {
    // each starts as soon as its interface is up: all of them together
    for (const m of members) P.whenIfaceUp(m.dev, m.l3.id, () => (hsrpLike(m.protocol) ? hsStart(m, 'initial state') : vrStart(m, 'initial state')));
  });
  for (const proto of FHRP) {
    P.handlers.set(proto, (dev, l3, msg, pkt) => {
      const d = (msg.data || {}) as { group?: number; vip?: string; prio?: number; ip?: string; from?: string; state?: string; op?: string };
      const fam = pkt ? pkt.dst.version : d.vip && parseAddress(d.vip) ? (parseAddress(d.vip) as IpAddr).version : 4;
      for (const m of members) {
        // what the protocol carries: its group of this family, on the interface it arrived on
        if (m.protocol !== proto || m.dev !== dev || !l3 || m.l3.id !== l3.id || m.group !== d.group || m.vip.version !== fam || d.from === dev || m.state === initState(m.protocol)) continue;
        if (d.vip !== formatAddr(m.vip)) {
          const drop = m.protocol === 'carp';
          P.e.note(drop ? 'drop' : 'message', m.protocol, m.dev, d.from || '', msg.type, m.state, `${m.dev}:${m.l3.id}: ${label(m)} group ${m.group} from ${d.from} names virtual address ${d.vip}, here ${formatAddr(m.vip)} — a misconfiguration${drop ? '; discarded (its HMAC covers the addresses)' : ', logged (RFC 5798 §7.1)'}`);
          if (drop) continue;
        }
        // RFC 5798 §7.1: the owner of the address discards the advertisements of its group
        if (m.protocol === 'vrrp' && m.owner) continue;
        if (hsrpLike(m.protocol)) hsIn(m, d);
        else vrIn(m, d, pkt ? pkt.ttl : 255);
      }
    });
  }
  P.ifaceHooks.push((dev, l3, up) => {
    for (const m of members) {
      if (m.dev !== dev || m.l3.id !== l3.id) continue;
      if (!up) {
        m.gen++;
        set(m, initState(m.protocol), `interface ${l3.id} went down`);
      } else if (hsrpLike(m.protocol)) hsStart(m, `interface ${l3.id} came up`);
      else vrStart(m, `interface ${l3.id} came up`);
    }
  });
  P.extraStatus.push((): SessionStatus[] =>
    members.map((m) => ({ protocol: m.protocol, name: `group ${m.group} (${formatAddr(m.vip)}): ${m.dev}:${m.l3.id}`, device: m.dev, peer: '', state: m.state, detail: `priority ${m.prio}${m.owner ? ' (address owner)' : ''}${m.preempt ? ', preempt' : ''}; virtual MAC ${m.vmac}`, up: m.state !== initState(m.protocol), relation: m.rel ? m.rel.id : undefined })),
  );
}

// ------------------------------------------------------------------ IPsec (IKEv2)

/** IKEv2 retransmits a request this often before giving up (RFC 7296 §2.1 leaves it to the implementation; strongSwan: 5 retransmissions). */
const IKE_TRIES = 5;
/** The first retransmission after this, doubled each time (strongSwan's 4 s × 1.8ⁿ, simplified). */
const IKE_RTO = 2000;

/** One side's IKE state: its own requests' message IDs, the one outstanding, the peer's last request answered, its SAs' lifetimes. */
interface IkeX {
  /** the next message ID of this side's requests (IKE_SA_INIT 0, IKE_AUTH 1, then each exchange) */
  mid?: number;
  /** the request it waits a response for (what a CREATE_CHILD_SA rekeys) */
  pending?: { mid: number; type: string; tries: number; tok: number; what?: string; sa?: string };
  /** its requests waiting for their turn: one outstanding at a time (RFC 7296 §2.3, a window of one) */
  queue?: Array<{ type: string; what?: string; run: () => void }>;
  /** a new IKE SA the peer is negotiating while this side's is established (the old one serves until the new one is up) */
  replacing?: boolean;
  /** the peer's last request and this side's response to it (sent again when the request comes again) */
  answered?: { mid: number; type: string; detail: string; data: { [k: string]: unknown }; sa?: string };
  /** the next request ID expected from the peer */
  peerMid?: number;
  /** when its Child SA and IKE SA end unless rekeyed (ms) */
  childUntil?: number;
  ikeUntil?: number;
  tok?: number;
  /**
   * the IKE SA this side has (its identity: the initiator's SPI, RFC 7296 §2.6 — in the simulation the initiator and the
   * moment it began it); every message carries the SA it belongs to
   */
  sa?: string;
  /** the new IKE SA the peer is negotiating while this one is established (its IKE_SA_INIT's) */
  newSa?: string;
  /** the IKE SA a rekey just replaced: its Delete is still to be answered */
  oldSa?: string;
  /** the new IKE SA this side's own IKE rekey (its CREATE_CHILD_SA) proposes */
  pendingNewSa?: string;
}

/**
 * An IKE SA rekeyed (RFC 7296 §2.18): both sides go on in the new one, their message IDs from 0, the peer's last
 * request forgotten; the side that rekeyed deletes the old one with an INFORMATIONAL Delete on it (answered once).
 */
function ikeRekeyed(P: ProtocolSim, s: Sess, newSa: string, rekeyer: boolean): void {
  const x = s.x as IkeX;
  const old = x.sa;
  const oldMid = x.mid === undefined ? 0 : x.mid;
  x.sa = newSa;
  x.mid = 0;
  x.peerMid = undefined;
  x.answered = undefined;
  x.pendingNewSa = undefined;
  if (rekeyer) P.unicast(s, 'INFORMATIONAL', `request (message ID ${oldMid}): Delete (the old IKE SA, replaced by the rekey)`, { mid: oldMid, sa: old, del: true });
  else x.oldSa = old;
}

/** A fresh IKE SA identity (an initiator's SPI): the side that begins it and when. */
function ikeSpi(P: ProtocolSim, s: Sess): string {
  return `${s.dev}@${P.e.now}`;
}

/**
 * Send one of this side's IKE requests (a message ID of its own, RFC 7296
 * §2.2): sent again with a doubling timeout while unanswered; `failed`
 * after IKE_TRIES retransmissions. Only the response with the same message
 * ID ends it (ikeResponse). One request is outstanding at a time (a window
 * of one, §2.3): while another waits for its response this one waits its
 * turn — never replacing it — and goes when that one is answered or given
 * up (ikeNext). A rekey of an SA already waiting or outstanding is not
 * asked twice.
 */
function ikeRequest(P: ProtocolSim, s: Sess, type: string, detail: string, state: string, failed: (why: string) => void, data: { [k: string]: unknown } = {}): void {
  const x = s.x as IkeX;
  const what = typeof data.what === 'string' ? (data.what as string) : undefined;
  if (x.pending) {
    const q = x.queue || (x.queue = []);
    if (what && type === 'CREATE_CHILD_SA' && ((x.pending.type === type && x.pending.what === what) || q.some((e) => e.type === type && e.what === what))) return;
    const g = s.gen;
    q.push({ type, what, run: () => (s.gen === g ? ikeRequest(P, s, type, detail, state, failed, data) : undefined) });
    P.e.note('state', s.protocol, s.dev, s.peer, 'request waits', s.state, `IKEv2 ${s.rel.id}: ${s.dev}'s ${type}${what ? ` (${what === 'ike' ? 'IKE SA' : 'Child SA'})` : ''} waits for the response to its ${x.pending.type} (message ID ${x.pending.mid}): one request at a time`);
    return;
  }
  const mid = x.mid === undefined ? 0 : x.mid;
  x.mid = mid + 1;
  const tok = (x.tok = (x.tok || 0) + 1);
  const sa = x.sa;
  x.pending = { mid, type, tries: 0, tok, what, sa };
  const send = (n: number): void => P.unicast(s, type, `request (message ID ${mid})${n ? `, sent again (${n})` : ''}: ${detail}`, { ...data, mid, sa }, state);
  send(0);
  const again = (n: number): void => {
    P.later(s, IKE_RTO * Math.pow(2, n - 1), () => {
      const p = x.pending;
      if (!p || p.tok !== tok) return;
      if (n > IKE_TRIES) {
        x.pending = undefined;
        const g = s.gen;
        failed(`${type} (message ID ${mid}) unanswered after ${IKE_TRIES} retransmissions`);
        if (s.gen === g) ikeNext(s);
        return;
      }
      p.tries = n;
      send(n);
      again(n + 1);
    });
  };
  again(1);
}

/** A response: taken only for the request outstanding (its type, message ID and IKE SA); anything else is ignored. */
function ikeResponse(P: ProtocolSim, s: Sess, type: string, mid: number | undefined, sa?: string): boolean {
  const x = s.x as IkeX;
  const p = x.pending;
  if (!p || p.type !== type || p.mid !== mid || (sa !== undefined && p.sa !== undefined && sa !== p.sa)) {
    P.e.note('drop', s.protocol, s.dev, s.peer, type, s.state, `IKEv2 ${s.rel.id}: ${s.dev} ignores a ${type} response (message ID ${mid === undefined ? '?' : mid}): ${p ? `it waits for the response to ${p.type} ${p.mid}` : 'no request of its own is outstanding'}`);
    return false;
  }
  x.pending = undefined;
  ikeNext(s);
  return true;
}

/** The next request waiting for its turn goes (the one before it was answered or given up). */
function ikeNext(s: Sess): void {
  const x = s.x as IkeX;
  while (!x.pending && x.queue && x.queue.length) (x.queue.shift() as { run: () => void }).run();
}

/** This side's requests end (a restart, a new IKE SA): none outstanding, none waiting. */
function ikeClear(x: IkeX): void {
  x.pending = undefined;
  x.queue = [];
}

/** Answer the peer's request (the same message ID, in its IKE SA); the answer is kept, and sent again if the request comes again. */
function ikeAnswer(P: ProtocolSim, s: Sess, type: string, mid: number | undefined, detail: string, data: { [k: string]: unknown } = {}, state = '', sa = (s.x as IkeX).sa): void {
  const x = s.x as IkeX;
  x.answered = { mid: mid === undefined ? 0 : mid, type, detail, data, sa };
  x.peerMid = (mid === undefined ? 0 : mid) + 1;
  P.unicast(s, type, `response (message ID ${mid}): ${detail}`, { ...data, response: true, mid, sa }, state);
}

/** The peer's request: a retransmission of the last one answered (the same SA) is answered again (no second exchange). */
function ikeRepeat(P: ProtocolSim, s: Sess, type: string, mid: number | undefined, sa?: string): boolean {
  const x = s.x as IkeX;
  const a = x.answered;
  if (!a || a.type !== type || a.mid !== mid || (sa !== undefined && a.sa !== undefined && a.sa !== sa)) return false;
  P.unicast(s, type, `response (message ID ${mid}), sent again: the request came again`, { ...a.data, response: true, mid, sa: a.sa }, '');
  return true;
}

/**
 * A request of this side's current IKE SA that is neither the last one answered (ikeRepeat) nor the next one: an
 * old one, delayed — outside the window, dropped (RFC 7296 §2.2: a responder takes a request only with the next
 * message ID; it never starts that exchange again).
 */
function ikeStale(P: ProtocolSim, s: Sess, type: string, mid: number | undefined): boolean {
  const x = s.x as IkeX;
  if (mid === undefined || x.peerMid === undefined || mid >= x.peerMid) return false;
  P.e.note('drop', s.protocol, s.dev, s.peer, type, s.state, `IKEv2 ${s.rel.id}: ${s.dev} drops a ${type} request (message ID ${mid}) of its IKE SA with ${s.peer}: an old one (the next is ${x.peerMid}), outside the window (RFC 7296 §2.2)`);
  return true;
}

/**
 * IKEv2 (RFC 7296) between the two ends, each with its own state and
 * timers — never one side changing the other's:
 *   IKE_SA_INIT and IKE_AUTH (the initiator's requests, message IDs 0 and
 *   1), each sent again with a doubling timeout while unanswered; the
 *   responder answers a repeated request with its kept response. Both
 *   ends Established with the IKE SA and the first Child SA.
 *   Dead peer detection on each side: an empty INFORMATIONAL request every
 *   DPD interval, sent again every interval for its retries; unanswered,
 *   that side deletes its SAs (the initiator starts again after the DPD
 *   interval; the responder waits for it).
 *   Rekeying (either side, its rekey margin before its own lifetime ends —
 *   the responder half a margin later): a CREATE_CHILD_SA for the Child SA
 *   or the IKE SA; its response replaces the SA on both ends (a new
 *   lifetime); a new IKE SA's message IDs start at 0 and the old one is
 *   deleted (an INFORMATIONAL Delete on it). An SA not rekeyed by the end of
 *   its lifetime expires on that side: a Child SA — no traffic until a
 *   new one is negotiated; the IKE SA — everything is deleted and
 *   negotiated anew.
 *   One request of a side is outstanding at a time: a DPD, a rekey, a
 *   second rekey due at the same moment wait their turn (ikeRequest).
 *   A new IKE_SA_INIT from the peer while this side is established (the
 *   peer lost its SA and starts over): answered, and the old SAs keep
 *   serving until the new IKE_AUTH completes and replaces them — the new
 *   negotiation alone deletes nothing. Every message carries the IKE SA it
 *   belongs to (the initiator's SPI): a delayed IKE_SA_INIT or IKE_AUTH of
 *   the SA already established, or an old request of it (neither the last
 *   one answered nor the next), is dropped — outside the window (§2.2).
 * Cryptography stays abstract (proposals, keys and authentication are not
 * checked).
 */
const ike: Behaviour = {
  refresh(P, s) {
    if (s.up) ikeDetail(P, s);
  },
  start(P, s) {
    s.state = 'Idle';
    if (s.initiator) ikeInit(P, s);
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { response?: boolean; mid?: number; what?: string; sa?: string; newSa?: string; del?: boolean };
    const x = s.x as IkeX;
    const up = s.state === 'Established' || s.state === 'No Child SA';
    // a request of an IKE SA this side does not have (an old one, replaced or deleted): not taken
    const foreign = (): boolean => {
      if (d.sa === undefined || d.sa === x.sa) return false;
      P.e.note('drop', s.protocol, s.dev, s.peer, msg.type, s.state, `IKEv2 ${s.rel.id}: ${s.dev} drops a ${msg.type} ${d.response ? 'response' : 'request'} (message ID ${d.mid}) of an IKE SA it does not have`);
      return true;
    };
    switch (msg.type) {
      case 'IKE_SA_INIT':
        if (!d.response) {
          if (ikeRepeat(P, s, 'IKE_SA_INIT', d.mid, d.sa)) return;
          if (up && d.sa !== undefined && d.sa === x.sa) {
            // the IKE_SA_INIT that began this very SA, delayed: long processed, outside the window — never a new IKE SA
            P.e.note('drop', s.protocol, s.dev, s.peer, 'IKE_SA_INIT', s.state, `IKEv2 ${s.rel.id}: ${s.dev} drops an IKE_SA_INIT request (message ID ${d.mid}) of the IKE SA it already has with ${s.peer}: a retransmission, outside the window (RFC 7296 §2.2)`);
            return;
          }
          if (up) {
            // a new IKE SA from the peer while this side's is up: answered; the old SAs serve until the new one is authenticated
            x.replacing = true;
            x.newSa = d.sa;
            ikeAnswer(P, s, 'IKE_SA_INIT', d.mid, 'chosen proposal, KE, Nr (a new IKE SA: the established one serves until it is up)', {}, '', d.sa);
            P.e.note('state', s.protocol, s.dev, s.peer, 'new IKE SA', s.state, `IKEv2 ${s.rel.id}: ${s.peer} starts a new IKE SA; ${s.dev}'s established SAs serve until the new one is authenticated`);
            return;
          }
          x.mid = 0;
          x.sa = d.sa;
          ikeClear(x);
          ikeAnswer(P, s, 'IKE_SA_INIT', d.mid, 'chosen proposal, KE, Nr', {}, 'IKE_SA_INIT');
          P.setState(s, 'IKE_SA_INIT', false, 'request from the peer');
        } else if (s.state === 'IKE_SA_INIT' && ikeResponse(P, s, 'IKE_SA_INIT', d.mid, d.sa)) {
          P.setState(s, 'IKE_AUTH', false, 'IKE SA keys derived');
          ikeRequest(P, s, 'IKE_AUTH', 'IDi, AUTH, SAi2, TSi, TSr (encrypted)', 'IKE_AUTH', (why) => ikeFailed(P, s, why));
        }
        return;
      case 'IKE_AUTH':
        if (!d.response) {
          if (ikeRepeat(P, s, 'IKE_AUTH', d.mid, d.sa)) return;
          // the new IKE SA's authentication (the peer started over), or this negotiation's
          const replacing = !!x.replacing && (d.sa === undefined || d.sa === x.newSa);
          if (!replacing && (s.state !== 'IKE_SA_INIT' || (d.sa !== undefined && d.sa !== x.sa))) {
            if (up && d.sa === x.sa) ikeStale(P, s, 'IKE_AUTH', d.mid);
            return;
          }
          if (replacing) {
            x.sa = x.newSa;
            x.newSa = undefined;
          }
          ikeAnswer(P, s, 'IKE_AUTH', d.mid, 'IDr, AUTH, SAr2 (the first Child SA)', {}, 'Established');
          if (replacing) P.e.note('state', s.protocol, s.dev, s.peer, 'IKE SA replaced', 'Established', `IKEv2 ${s.rel.id}: the new IKE SA with ${s.peer} is authenticated: it and its Child SA replace ${s.dev}'s old ones (deleted now)`);
          ikeUp(P, s);
        } else if (s.state === 'IKE_AUTH' && ikeResponse(P, s, 'IKE_AUTH', d.mid, d.sa)) ikeUp(P, s);
        return;
      case 'INFORMATIONAL':
        if (d.del) {
          // the Delete of an IKE SA a rekey replaced (on the old SA): answered once; its response ends it
          if (!d.response && d.sa !== undefined && d.sa === x.oldSa) {
            x.oldSa = undefined;
            P.unicast(s, 'INFORMATIONAL', `response (message ID ${d.mid}): Delete (the old IKE SA)`, { response: true, mid: d.mid, sa: d.sa, del: true });
          } else if (d.response) P.e.note('state', s.protocol, s.dev, s.peer, 'old IKE SA deleted', s.state, `IKEv2 ${s.rel.id}: ${s.peer} confirms the Delete: the old IKE SA is gone`);
          return;
        }
        if (!d.response) {
          if (ikeRepeat(P, s, 'INFORMATIONAL', d.mid, d.sa)) return;
          if (foreign() || ikeStale(P, s, 'INFORMATIONAL', d.mid)) return;
          // (a DPD request of an IKE SA this side does not have: no answer — the peer's DPD finds that out)
          if (up) ikeAnswer(P, s, 'INFORMATIONAL', d.mid, 'DPD (empty)');
        } else ikeResponse(P, s, 'INFORMATIONAL', d.mid, d.sa);
        return;
      case 'CREATE_CHILD_SA':
        if (!d.response) {
          if (ikeRepeat(P, s, 'CREATE_CHILD_SA', d.mid, d.sa)) return;
          if (!up || foreign() || ikeStale(P, s, 'CREATE_CHILD_SA', d.mid)) return;
          // the rekeyed SA replaces this side's: a new lifetime from now; a new IKE SA — the answer is the old one's, then
          // this side is in the new one, its message IDs from 0 (RFC 7296 §2.18)
          ikeAnswer(P, s, 'CREATE_CHILD_SA', d.mid, d.what === 'ike' ? 'the new IKE SA' : 'the new Child SA', { what: d.what });
          if (d.what === 'ike') ikeRekeyed(P, s, d.newSa as string, false);
          ikeRenew(P, s, d.what === 'ike' ? 'ike' : 'child');
        } else if (ikeResponse(P, s, 'CREATE_CHILD_SA', d.mid, d.sa)) {
          if (d.what === 'ike') ikeRekeyed(P, s, (x.pendingNewSa as string) || ikeSpi(P, s), true);
          ikeRenew(P, s, d.what === 'ike' ? 'ike' : 'child');
        }
        return;
      default:
        return;
    }
  },
};

function ikeInit(P: ProtocolSim, s: Sess): void {
  P.restart(s);
  const x = s.x as IkeX;
  x.mid = 0;
  ikeClear(x);
  x.replacing = false;
  x.answered = undefined;
  x.peerMid = undefined;
  x.sa = ikeSpi(P, s);
  P.setState(s, 'IKE_SA_INIT', false, 'initiating');
  ikeRequest(P, s, 'IKE_SA_INIT', `SA proposals, KE, Ni to ${formatAddr(ipOf(s.remote))} UDP 500`, 'IKE_SA_INIT', (why) => ikeFailed(P, s, why));
}

/** The negotiation failed (a request unanswered): it starts again after the DPD interval (the initiator). */
function ikeFailed(P: ProtocolSim, s: Sess, why: string): void {
  P.setState(s, 'Idle', false, why);
  if (!s.initiator) return;
  const dpd = P.timer(s, s.profile, 'dpd');
  P.restart(s);
  P.later(s, dpd.ms, () => ikeInit(P, s));
}

/** This side's SAs are gone (DPD, the IKE SA's lifetime, the peer's new IKE_SA_INIT): its timers end; the initiator negotiates again after the DPD interval. */
function ikeDown(P: ProtocolSim, s: Sess, why: string, again = true): void {
  P.restart(s);
  const x = s.x as IkeX;
  ikeClear(x);
  // (a new IKE SA the peer was negotiating meanwhile goes on: this side waits for its IKE_AUTH)
  const replacing = !!x.replacing;
  x.replacing = false;
  x.childUntil = x.ikeUntil = undefined;
  if (replacing) {
    x.mid = 0;
    P.setState(s, 'IKE_SA_INIT', false, `${why}; the new IKE SA ${s.peer} started is negotiated on`);
    P.e.syncInterfaces();
    return;
  }
  P.setState(s, 'Idle', false, why);
  P.e.syncInterfaces();
  // (scheduled after the restart: this generation's timer, not the one just ended)
  if (again && s.initiator) P.later(s, P.timer(s, s.profile, 'dpd').ms, () => ikeInit(P, s));
}

function ikeDetail(P: ProtocolSim, s: Sess): void {
  const dpd = P.timer(s, s.profile, 'dpd');
  const retries = P.timer(s, s.profile, 'dpd-retries');
  const life = P.timer(s, s.profile, 'child-lifetime');
  const ike = P.timer(s, s.profile, 'ike-lifetime');
  const x = s.x as IkeX;
  const left = (t?: number): string => (t === undefined ? '' : ` (${fmtSec(Math.max(0, t - P.e.now))} left)`);
  s.x.detail = `DPD ${dpd.text} × ${retries.text}; Child SA lifetime ${life.text}${left(x.childUntil)}; IKE SA lifetime ${ike.text}${left(x.ikeUntil)}; rekey margin ${P.paramText(P.param('rekey-margin', s.dev, relRef(s.rel.id)))}`;
}

/**
 * Rekey an SA before its lifetime ends (its lifetime less the rekey margin, at least half of it). Either side rekeys
 * by its own lifetime (RFC 7296 §2.8: lifetimes are not negotiated); the responder halfway between the moment the
 * initiator would and the lifetime's end, so with equal lifetimes the initiator's rekey comes first and the
 * responder's is not needed (no simultaneous rekeying).
 */
function rekeyAfter(P: ProtocolSim, s: Sess, key: string): number {
  const life = P.timer(s, s.profile, key).ms;
  const margin = Number(P.param('rekey-margin', s.dev, relRef(s.rel.id)).value);
  const first = Math.max(life / 2, life - margin);
  return s.initiator ? first : (first + life) / 2;
}

/** A new SA (the first, or a rekeyed one): its lifetime from now; its expiry; the initiator's rekey before it. */
function ikeRenew(P: ProtocolSim, s: Sess, what: 'child' | 'ike'): void {
  const x = s.x as IkeX;
  const key = what === 'child' ? 'child-lifetime' : 'ike-lifetime';
  const life = P.timer(s, s.profile, key);
  const until = P.e.now + life.ms;
  if (what === 'child') x.childUntil = until;
  else x.ikeUntil = until;
  if (what === 'child' && s.state === 'No Child SA') {
    P.setState(s, 'Established', true, 'a new Child SA');
    P.e.syncInterfaces();
  }
  ikeDetail(P, s);
  // the end of the lifetime, unless a rekey replaced it meanwhile
  P.later(s, life.ms, () => {
    if ((what === 'child' ? x.childUntil : x.ikeUntil) !== until) return;
    if (what === 'ike') {
      ikeDown(P, s, `the IKE SA's lifetime (${life.text}) ended without a rekey: its SAs are deleted`);
      return;
    }
    x.childUntil = undefined;
    P.setState(s, 'No Child SA', false, `the Child SA's lifetime (${life.text}) ended without a rekey: no traffic until a new one`);
    P.e.syncInterfaces();
    ikeRequest(P, s, 'CREATE_CHILD_SA', 'a new Child SA (the old one expired)', '', (why) => ikeDown(P, s, `${why}: its SAs are deleted`), { what: 'child' });
  });
  // each side rekeys before the end of its own lifetime (unless the peer's rekey renewed the SA first)
  P.later(s, rekeyAfter(P, s, key), () => {
    if ((what === 'child' ? x.childUntil : x.ikeUntil) !== until) return;
    const margin = fmtSec(life.ms - rekeyAfter(P, s, key));
    const data: { [k: string]: unknown } = { what };
    if (what === 'ike') data.newSa = x.pendingNewSa = ikeSpi(P, s);
    ikeRequest(P, s, 'CREATE_CHILD_SA', what === 'child' ? `rekeys the Child SA ${margin} before its lifetime (${life.text}) ends` : `rekeys the IKE SA before its lifetime (${life.text}) ends`, '', (why) => P.e.note('state', s.protocol, s.dev, s.peer, 'rekey failed', s.state, `IKEv2 ${s.rel.id}: ${s.dev}'s rekey failed (${why}): the ${what === 'child' ? 'Child' : 'IKE'} SA lives until its lifetime ends`), data);
  });
}

function ikeUp(P: ProtocolSim, s: Sess): void {
  P.restart(s);
  const x0 = s.x as IkeX;
  // a new IKE SA: what was outstanding on the old one ends; the responder's own requests start at message ID 0 in it
  ikeClear(x0);
  if (!s.initiator) x0.mid = 0;
  x0.replacing = false;
  P.setState(s, 'Established', true, 'IKE SA and Child SA established');
  P.e.syncInterfaces();
  ikeRenew(P, s, 'child');
  ikeRenew(P, s, 'ike');
  // dead peer detection, on each side by its own timers: a request every interval, sent again every interval for its retries
  const g = s.gen;
  const dpd = (wait = P.timer(s, s.profile, 'dpd').ms): void => {
    P.later(s, wait, () => {
      // (a request of its own outstanding or waiting: its response shows the peer alive; DPD waits)
      if (s.gen !== g || (s.x as IkeX).pending || ((s.x as IkeX).queue || []).length) {
        if (s.gen === g) dpd();
        return;
      }
      const retries = Math.max(1, Math.round(P.timer(s, s.profile, 'dpd-retries').ms / 1000));
      const interval = P.timer(s, s.profile, 'dpd');
      const x = s.x as IkeX;
      const mid = x.mid === undefined ? 0 : x.mid;
      x.mid = mid + 1;
      const tok = (x.tok = (x.tok || 0) + 1);
      x.pending = { mid, type: 'INFORMATIONAL', tries: 0, tok };
      let n = 0;
      const sa = x.sa;
      x.pending.sa = sa;
      const send = (): void => P.unicast(s, 'INFORMATIONAL', `request (message ID ${mid})${n ? `, sent again (${n})` : ''}: DPD (empty)`, { mid, sa });
      send();
      const check = (): void => {
        P.later(s, interval.ms, () => {
          const p = x.pending;
          if (!p || p.tok !== tok) {
            // (answered: the next request an interval after this one was sent — now)
            dpd(0);
            return;
          }
          if (n >= retries) {
            x.pending = undefined;
            ikeDown(P, s, `Dead Peer Detection: no response to ${n + 1} DPD requests (${interval.text} × ${retries}): its SAs are deleted`);
            return;
          }
          n++;
          send();
          check();
        });
      };
      check();
    });
  };
  dpd();
}

// ------------------------------------------------------------------ generic sessions (GRE, WireGuard, OpenVPN, L2TP, MLAG …)

/** GRE's keepalives are outer packets between the tunnel's source and destination (inside ESP when the tunnel is carried over IPsec). */
function greSend(P: ProtocolSim, s: Sess, type: string, detail: string): void {
  const ends = P.e.tunnelEnds(s.dev, s.local.l3.id);
  if (s.local.l3.kind !== 'tunnel' || !ends.length) {
    P.unicast(s, type, detail);
    return;
  }
  const e = ends[0];
  const m = P.msg(s, type, `${s.dev} (${formatAddr(e.src)}) → ${s.peer} (${formatAddr(e.dst)}), IP 47; ${detail}`);
  P.e.note('message', s.protocol, s.dev, s.peer, type, '', m.detail);
  P.lane(s.rel, s.dev, s.peer, m, P.e.estimate(s.dev, e.dst));
  let pkt: Pkt = P.e.newPacket(e.src, e.dst, '', m, [s.rel.id]);
  for (const layer of encapStack(P.m, s.rel).slice(1)) {
    if (layer.relation && !P.sessionUp(layer.relation)) {
      // the tunnel's keepalives wait for what carries it (the newest only: they are periodic)
      const rid = layer.relation;
      P.e.waitFor('rel:' + rid, `${layer.label} ${rid}`, s.dev, m, () => P.e.send(s.dev, pkt), `${s.dev}|${s.protocol}|${type}`);
      return;
    }
    const outer: Msg = { ...m, data: { ...(m.data || {}), outer: layer.relation ? P.e.relProtocol(layer.relation) : '' } };
    pkt = { ...P.e.newPacket(e.src, e.dst, '', outer, pkt.rides.concat(layer.relation ? [layer.relation] : [])), inner: pkt, encap: layer.label };
  }
  P.e.send(s.dev, pkt);
}

/** Does a session's profile run over TCP (SSL VPN): its handshake starts with the connection of the common transport. */
function overTcp(s: Sess): boolean {
  return /^TCP\b/.test(s.profile.proto);
}

/** The first step of a handshake after its TCP steps (the transport makes the connection). */
function afterTcp(s: Sess): number {
  const h = s.profile.handshake || [];
  let k = 0;
  while (h[k] && /^TCP\b/.test(h[k].msg)) k++;
  return k;
}

function sessionSend(P: ProtocolSim, s: Sess, type: string, detail: string, data: { [k: string]: unknown } = {}): void {
  if (s.protocol === 'gre') greSend(P, s, type, detail);
  else if (overTcp(s)) tcpSend(P, s, type, detail, 64, data);
  else P.unicast(s, type, detail, data);
}

/** A handshake's steps from `k` that are this side's (sent one after the other). */
function ownSteps(P: ProtocolSim, s: Sess, k: number): number {
  const p = s.profile;
  const h = p.handshake || [];
  const mine = s.initiator ? 'a' : 'b';
  while (h[k] && h[k].from === mine) {
    sessionSend(P, s, h[k].msg, `handshake step ${k + 1} of ${h.length}`, { step: k });
    k++;
  }
  return k;
}

/** WireGuard's timers (the whitepaper §6): a handshake sent again every REKEY_TIMEOUT for up to REKEY_ATTEMPT_TIME. */
const WG_REKEY_TIMEOUT = 5000;
const WG_REKEY_ATTEMPT = 90000;

/**
 * WireGuard: the initiator's Handshake Initiation is sent again every 5 s
 * until a Handshake Response comes, for up to 90 s; once answered, both
 * ends have keys — the initiator handshakes again after REKEY_AFTER_TIME
 * (the profile's rekey, 120 s), and each end's keys are rejected after
 * REJECT_AFTER_TIME (its dead timer, 180 s) unless a newer handshake
 * replaced them. Keepalives keep NAT state, they renew no keys.
 */
function wgHandshake(P: ProtocolSim, s: Sess, why: string): void {
  const p = s.profile;
  const g = s.gen;
  const tok = ((s.x.wgTok as number) || 0) + 1;
  s.x.wgTok = tok;
  const started = P.e.now;
  let n = 0;
  const send = (): void => {
    sessionSend(P, s, p.handshake![0].msg, `${why}${n ? ` (sent again, ${n}: no Handshake Response within ${WG_REKEY_TIMEOUT / 1000} s)` : ''}`, { step: 0 });
    P.later(s, WG_REKEY_TIMEOUT, () => {
      if (s.gen !== g || s.x.wgTok !== tok || s.x.wgDone === tok) return;
      if (P.e.now - started >= WG_REKEY_ATTEMPT) {
        P.e.note('state', s.protocol, s.dev, s.peer, 'handshake failed', s.state, `WireGuard ${s.rel.id}: ${s.dev} got no Handshake Response for ${WG_REKEY_ATTEMPT / 1000} s: it stops trying until its next attempt`);
        return;
      }
      n++;
      send();
    });
  };
  send();
}

/** A completed WireGuard handshake at one end: new keys, their rejection after the dead timer, the initiator's next handshake. */
function wgKeys(P: ProtocolSim, s: Sess): void {
  const p = s.profile;
  const at = P.e.now;
  s.x.wgKeys = at;
  s.x.wgDone = s.x.wgTok;
  const reject = P.timer(s, p, 'dead');
  P.later(s, reject.ms, () => {
    if (s.x.wgKeys !== at) return;
    P.setState(s, p.states[0], false, `its keys are ${reject.text} old (REJECT_AFTER_TIME) and no newer handshake replaced them`);
  });
  if (s.initiator)
    P.later(s, P.timer(s, p, 'rekey').ms, () => {
      if (s.x.wgKeys === at) wgHandshake(P, s, `REKEY_AFTER_TIME (${P.timer(s, p, 'rekey').text}): a new handshake`);
    });
}

const session: TcpBehaviour = {
  refresh(P, s) {
    const p = s.profile;
    s.x.detail = p.id === 'wireguard' ? `handshake again after ${P.timer(s, p, 'rekey').text}, keys rejected after ${P.timer(s, p, 'dead').text}; persistent keepalive ${P.timer(s, p, 'hello').text}` : `${p.keepalive ? p.keepalive.msg.toLowerCase() + ' every ' + P.timer(s, p, 'hello').text + ', down after ' + P.timer(s, p, 'dead').text : ''}`;
  },
  start(P, s) {
    const p = s.profile;
    s.state = p.states[0];
    session.refresh!(P, s);
    if (p.id === 'wireguard') {
      if (s.initiator) {
        wgHandshake(P, s, 'starts the session');
        P.setState(s, p.states[1], false, 'handshake started');
      }
      // persistent keepalives both ways while the session has keys; a session without keys handshakes again (the initiator)
      every(P, s, () => P.timer(s, p, 'hello').ms, () => {
        if (s.up) sessionSend(P, s, 'Keepalive', 'persistent keepalive', { ka: true });
        else if (s.initiator && s.x.wgDone !== s.x.wgTok && P.e.now - ((s.x.wgStarted as number) || 0) >= WG_REKEY_ATTEMPT) {
          s.x.wgStarted = P.e.now;
          wgHandshake(P, s, 'starts the session again');
        }
      });
      return;
    }
    if (overTcp(s)) {
      // over TCP: the server listens, the client connects; the handshake goes on once the connection is open
      tcpListen(P, s);
      if (s.initiator) {
        tcpConnect(P, s);
        P.setState(s, p.states.length > 2 ? p.states[1] : p.states[0], false, 'handshake started: TCP connection');
      }
    } else if (s.initiator && p.handshake && p.handshake.length) {
      const first = p.handshake[0];
      sessionSend(P, s, first.msg, 'starts the session', { step: 0 });
      P.setState(s, p.states.length > 2 ? p.states[1] : p.states[0], false, 'handshake started');
    } else if (!p.handshake || !p.handshake.length) {
      // keepalives only (GRE): the session is up once one is answered
    }
    const ka = p.keepalive;
    if (!ka) return;
    every(P, s, () => P.timer(s, p, 'hello').ms, () => {
      if (!ka.both && !s.initiator) return;
      if (!ka.both || s.up || !p.handshake || !p.handshake.length) sessionSend(P, s, ka.msg, `${ka.reply ? 'expects ' + ka.reply : 'liveness'}`, { ka: true });
      // a session that is down starts its handshake again (over TCP: a new connection)
      if (!s.up && s.initiator && p.handshake && p.handshake.length && P.e.now - s.since >= P.timer(s, p, 'dead').ms) {
        if (overTcp(s)) {
          tcpClose(P, s, 'the session starts again', true);
          tcpConnect(P, s);
        } else sessionSend(P, s, p.handshake[0].msg, 'starts the session again', { step: 0 });
        s.since = P.e.now;
      }
    });
    const check = (): void => {
      const dead = P.timer(s, p, 'dead');
      deadCheck(P, s, dead.ms, () => {
        if (s.up) P.setState(s, p.states[0], false, `nothing heard for ${dead.text}`);
        if (s.protocol === 'gre') P.e.syncInterfaces();
      });
    };
    s.x.check = check;
  },
  tcp(P, s, ev, why) {
    const p = s.profile;
    if (ev === 'open') {
      if (!s.initiator) return;
      const k = ownSteps(P, s, afterTcp(s));
      if (k >= (p.handshake || []).length) P.setState(s, p.states[p.states.length - 1], true, 'answered');
      return;
    }
    if (s.up || s.state !== p.states[0]) P.setState(s, p.states[0], false, `its TCP connection ${why}`);
  },
  rx(P, s, msg) {
    const p = s.profile;
    const d = (msg.data || {}) as { step?: number; ka?: boolean };
    if (p.id === 'wireguard') {
      if (msg.type === p.handshake![0].msg) {
        // the responder: a Handshake Response, new keys
        sessionSend(P, s, p.handshake![1].msg, 'completes the handshake', { step: 1 });
        wgKeys(P, s);
        if (!s.up) P.setState(s, p.states[p.states.length - 1], true, 'handshake answered: keys');
      } else if (msg.type === p.handshake![1].msg && s.initiator) {
        wgKeys(P, s);
        if (!s.up) P.setState(s, p.states[p.states.length - 1], true, 'Handshake Response: keys');
      }
      return;
    }
    const up = (): void => {
      if (!s.up) {
        P.setState(s, p.states[p.states.length - 1], true, 'answered');
        if (s.protocol === 'gre') P.e.syncInterfaces();
      }
      if (typeof s.x.check === "function") (s.x.check as () => void)();
    };
    if (d.step !== undefined && p.handshake) {
      const next = p.handshake[d.step + 1];
      const mine = s.initiator ? 'a' : 'b';
      if (next && next.from === mine) {
        // this side's steps that follow (the rest of the handshake that is ours as well)
        const k = ownSteps(P, s, d.step + 1);
        if (k >= p.handshake.length) up();
        else if (s.state === p.states[0] && p.states.length > 2) P.setState(s, p.states[1], false, 'handshake');
      } else if (!next) up();
      return;
    }
    if (p.keepalive && msg.type === p.keepalive.msg && p.keepalive.reply) sessionSend(P, s, p.keepalive.reply, `answers ${msg.type}`, { ka: true });
    if (!p.handshake || !p.handshake.length || s.up || msg.type === (p.keepalive || { reply: '' }).reply) up();
  },
};

// ------------------------------------------------------------------ services, data, custom protocols

const service: TcpBehaviour = {
  refresh(P, s) {
    const p = s.profile;
    const sender = p.fromServer ? !s.initiator : s.initiator;
    if (!sender) return;
    s.x.detail = `${p.request} every ${P.timer(s, p, 'hello').text}${p.id === 'snmp' ? ', timeout ' + P.paramText(P.param('snmp-timeout', s.dev)) : ''}`;
  },
  start(P, s) {
    const p = s.profile;
    const tcp = /^TCP/.test(p.proto) && p.id !== 'radius';
    // requests come from the clients (from the server for SNMP); over TCP the server listens for their connections
    const sender = p.fromServer ? !s.initiator : s.initiator;
    if (tcp && !sender) tcpListen(P, s);
    if (!sender) return;
    service.refresh!(P, s);
    every(P, s, () => P.timer(s, p, 'hello').ms, () => {
      // SNMP: an agent that did not answer the last poll within the manager's timeout is not responding
      if (p.id === 'snmp') {
        const timeout = P.param('snmp-timeout', s.dev);
        const asked = P.e.now;
        s.x.asked = asked;
        P.later(s, Number(timeout.value), () => {
          const answered = s.x.answered as number | undefined;
          if (s.x.asked === asked && (answered === undefined || answered < asked)) {
            if (s.up || s.state !== 'Not responding') P.setState(s, 'Not responding', false, `no GetResponse within the SNMP timeout ${P.paramText(timeout)}`);
          }
        });
      }
      if (tcp && !tcpOpen(s)) {
        // no connection (yet, or it was lost): the common transport opens one; the requests go once it is open
        tcpConnect(P, s);
        return;
      }
      if (tcp && !s.x.open) return;
      svcSend(P, s, p.request as string, p.messages[0].does);
    });
  },
  tcp(P, s, ev, why) {
    const p = s.profile;
    if (ev === 'open') {
      if (!(p.fromServer ? !s.initiator : s.initiator)) return;
      if (p.id === 'https') svcSend(P, s, 'TLS ClientHello', 'cipher suites, key share');
      else {
        s.x.open = true;
        svcSend(P, s, p.request as string, p.messages[0].does);
      }
      return;
    }
    s.x.open = false;
    if (s.up) P.setState(s, p.states[0], false, `its TCP connection ${why}`);
  },
  rx(P, s, msg) {
    const p = s.profile;
    switch (msg.type) {
      case 'TLS ClientHello':
        // TLS 1.3 (RFC 8446 §2): the server's flight — ServerHello, its certificate, key share and Finished; its handshake completes with the client's Finished
        s.x.tls = 'server-flight';
        svcSend(P, s, 'TLS ServerHello', 'ServerHello, EncryptedExtensions, Certificate, CertificateVerify, Finished');
        return;
      case 'TLS ServerHello':
        // the client completes its side with its Finished before any application data of its own
        svcSend(P, s, 'TLS Finished', 'the client’s Finished: its side of the handshake is complete');
        s.x.open = true;
        s.x.tls = 'done';
        P.setState(s, 'Answered', true, 'TLS handshake complete (the client’s Finished sent)');
        svcSend(P, s, p.request as string, p.messages[0].does);
        return;
      case 'TLS Finished':
        s.x.tls = 'done';
        return;
      default:
        if (p.id === 'https' && msg.type === p.request && s.x.tls !== 'done') {
          // application data before the client's Finished: not taken (a TLS server answers with an alert and closes)
          P.e.note('drop', s.protocol, s.dev, s.peer, msg.type, s.state, `${p.label} ${s.rel.id}: ${s.dev} takes no request before the client's Finished (the handshake is not complete)`);
          return;
        }
        if (msg.type === p.request && p.response) {
          // the server answers after its response time (its simulation attribute)
          const rt = P.param('service-response', s.dev, relRef(s.rel.id));
          const answer = (): void => {
            svcSend(P, s, p.response as string, Number(rt.value) > 0 ? `the answer (after the response time ${P.paramText(rt)})` : 'the answer');
            if (!s.up) P.setState(s, p.states[p.states.length - 1], true, 'answers requests');
          };
          if (Number(rt.value) > 0) P.later(s, Number(rt.value), answer);
          else answer();
        } else if (msg.type === p.response) {
          s.x.answered = P.e.now;
          if (!s.up) P.setState(s, p.states[p.states.length - 1], true, 'answered');
        } else if (msg.type === p.request && !p.response && !s.up) P.setState(s, p.states[0], true, 'received');
    }
  },
};

/** A service's message: over its TCP connection for a TCP profile (HTTPS), else as a datagram of its own; an NTP response with the server's stratum as it knows it. */
function svcSend(P: ProtocolSim, s: Sess, type: string, detail: string): void {
  if (/^TCP/.test(s.profile.proto) && s.profile.id !== 'radius') {
    tcpSend(P, s, type, detail, /ClientHello/.test(type) ? 517 : /ServerHello/.test(type) ? 1400 : 300);
    return;
  }
  const ntp = s.profile.id === 'ntp' && type === s.profile.response ? (P.shared.get('ntp') as { responseStratum(dev: string): number } | undefined) : undefined;
  if (ntp) {
    const stratum = ntp.responseStratum(s.dev);
    P.unicast(s, type, `${detail}; stratum ${stratum}${stratum >= 16 ? ' (unsynchronized: no time to take)' : ''}`, { stratum });
  } else P.unicast(s, type, detail);
}

const data: Behaviour = {
  start(P, s) {
    if (s.rel.direction === 'unidirectional' && !s.initiator) return;
    const iv = P.timer(s, s.profile, 'hello');
    s.x.detail = `${s.profile.dataMsg} every ${iv.text} (demonstration)`;
    every(P, s, () => iv.ms, () => P.unicast(s, s.profile.dataMsg as string, `encapsulated (${s.profile.proto}) between ${formatAddr(ipOf(s.local))} and ${formatAddr(ipOf(s.remote))}`));
  },
  rx(P, s) {
    if (!s.up) P.setState(s, 'Up', true, 'data received');
  },
};

const custom: Behaviour = {
  start(P, s) {
    if (s.rel.direction === 'unidirectional' && !s.initiator) return;
    const iv = P.timer(s, s.profile, 'hello');
    s.x.detail = `${s.profile.label} packets every ${iv.text}${s.rel.direction === 'unidirectional' ? ', one way' : ', both ways'}`;
    P.setState(s, 'Sending', true, 'sends dummy packets');
    every(P, s, () => iv.ms, () => P.unicast(s, 'packet', `a dummy ${s.profile.label} packet (${s.rel.direction === 'unidirectional' ? 'one way, first endpoint to last' : 'bidirectional'})`));
  },
  rx(P, s) {
    if (!s.up) P.setState(s, 'Sending', true, 'packets arrive');
  },
};

// ------------------------------------------------------------------ PIM and IGMP

const pim: Behaviour = {
  start(P, s) {
    const key = `pim-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const group = addr(ipOf(s.local).version === 4 ? '224.0.0.13' : 'ff02::d');
    P.periodic(
      () => true,
      () => P.timer(s, s.profile, 'hello').ms,
      () => {
        // (the Hello's DR Priority option, RFC 7761 §4.9.2: what its neighbours elect the DR by)
        const prio = P.param('pim-dr-priority', s.dev, ifaceRef(s.dev, s.local.l3.id));
        if (P.e.isL3Up(s.dev, s.local.l3.id)) P.multicast(s, group, 'Hello', `holdtime ${P.timer(s, s.profile, 'dead').text}, DR priority ${P.paramText(prio)}`, { drPrio: Number(prio.value) });
      },
    );
    // a candidate RP announces itself every bootstrap period (PIM BSR, RFC 5059: in the simulation the candidate's own
    // Bootstrap, flooded over the PIM neighbours): its router ID, its RP addresses and a holdtime of 2.5 periods
    const bkey = 'pim-bsr|' + s.dev;
    if (pimValue(P.m, s.dev, 'candidate_rp') === 'yes' && !P.shared.has(bkey)) {
      P.shared.set(bkey, 0);
      P.periodic(
        () => P.e.deviceOn(s.dev),
        () => P.timer(s, s.profile, 'bsr').ms,
        () => {
          const seq = ((P.shared.get(bkey) as number) || 0) + 1;
          P.shared.set(bkey, seq);
          const m = P.shared.get('multicast') as { ownV6(d: string): IpAddr | null } | undefined;
          const rid = routerId(P, s.dev, 'pim');
          const v6 = m ? m.ownV6(s.dev) : null;
          const hold = Math.round(2.5 * P.timer(s, s.profile, 'bsr').ms);
          for (const o of Array.from(P.sessions.values()).filter((x) => x.protocol === 'pim' && x.dev === s.dev && x.up).sort((a, b) => (a.key < b.key ? -1 : 1))) {
            P.unicast(o, 'Bootstrap', `candidate RP ${s.dev} (router ID ${rid}): RP ${rid}${v6 ? ' and ' + formatAddr(v6) : ''} for 224.0.0.0/4${v6 ? ' and ff00::/8' : ''}, holdtime ${fmtSec(hold)}`, { bsr: seq, origin: s.dev, rid, rp4: rid, rp6: v6 ? formatAddr(v6) : undefined, hold });
          }
        },
        3000,
      );
    }
  },
  rx(P, s, msg, _pkt, l3) {
    // joins, prunes and grafts: multicast routing (multicast.ts)
    if (P.pimHook && P.pimHook(s, msg, l3)) return;
    const d = (msg.data || {}) as { bsr?: number; origin?: string };
    switch (msg.type) {
      case 'Hello': {
        const dead = P.timer(s, s.profile, 'dead');
        const hd = (msg.data || {}) as { drPrio?: number };
        // the neighbour's DR priority is what its Hello said (none: 1, RFC 7761 §4.3.2)
        s.x.peerDrPrio = typeof hd.drPrio === 'number' ? hd.drPrio : 1;
        deadCheck(P, s, dead.ms, () => {
          P.restart(s);
          P.setState(s, 'No neighbour', false, `holdtime expired (${dead.text})`);
        });
        if (!s.up) P.setState(s, 'Neighbour', true, `Hello from ${s.peer}`);
        return;
      }
      case 'Bootstrap': {
        const b = d as { bsr?: number; origin?: string; rid?: string; rp4?: string; rp6?: string; hold?: number };
        const key = `pim-bsr-seen|${s.dev}|${b.origin}|${b.bsr}`;
        if (P.shared.has(key) || !b.origin || b.origin === s.dev) return;
        P.shared.set(key, true);
        // what the router knows of the candidate from now on: its RP addresses, until the holdtime runs out without another Bootstrap
        const setKey = 'pim-rpset|' + s.dev;
        let set = P.shared.get(setKey) as Map<string, { rid: string; rp4?: string; rp6?: string; until: number }> | undefined;
        if (!set) P.shared.set(setKey, (set = new Map()));
        const was = set.get(b.origin);
        const hold = b.hold || 150000;
        set.set(b.origin, { rid: b.rid || '0.0.0.0', rp4: b.rp4, rp6: b.rp6, until: P.e.now + hold });
        if (!was || was.until <= P.e.now) P.e.note('table', 'pim', s.dev, b.origin, 'RP set', '', `PIM: ${s.dev} learns candidate RP ${b.origin} (router ID ${b.rid}) from a Bootstrap, for ${fmtSec(hold)} unless another one comes`);
        const set2 = set;
        const origin = b.origin;
        P.e.after(hold, () => {
          const x = set2.get(origin);
          if (x && x.until <= P.e.now) P.e.note('table', 'pim', s.dev, origin, 'RP expired', '', `PIM: ${s.dev} heard no Bootstrap of candidate RP ${origin} for its holdtime (${fmtSec(hold)}): it is no RP candidate here any more`);
        });
        for (const o of Array.from(P.sessions.values()).filter((x) => x.protocol === 'pim' && x.dev === s.dev && x.up && x.peer !== s.peer && x.peer !== b.origin)) P.unicast(o, 'Bootstrap', `forwarded on: candidate RP ${b.origin}`, { bsr: b.bsr, origin: b.origin, rid: b.rid, rp4: b.rp4, rp6: b.rp6, hold: b.hold });
        return;
      }
      default:
        return;
    }
  },
};

// ------------------------------------------------------------------ LACP

/**
 * LACP on every aggregate's member links: LACPDUs both ways, members attached, collecting and distributing; a member
 * whose link goes down is detached at once. IEEE 802.1AX: each LACPDU carries its actor's LACP_Timeout; a member
 * transmits at the rate its partner's timeout asks for (fast while it is short) and times out by its own; a member
 * collecting and distributing goes back to Attached when its partner says it is not in sync (the mux machine).
 */
export function installLacp(P: ProtocolSim): void {
  type Mem = { dev: string; agg: string; port: string; peer: string; peerPort: string; state: string; heard: number; gen: number; rel?: Relation; partner?: string; partnerShort?: boolean; txGen: number };
  const mems: Mem[] = [];
  const LACP_MAC = '01:80:c2:00:00:02';
  for (const d of P.m.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
    for (const i of d.logical) {
      if (i.type !== 'virtual' || !i.members.length) continue;
      for (const port of i.members.slice().sort(cmp)) {
        const e = P.e.net.ends.get(portKey(d.id, port));
        if (!e) continue;
        const o = otherEnd(P.e.net, e);
        const rel = P.m.relations.find((r) => P.e.base(r) === 'lacp' && relationDevices(r).indexOf(d.id) >= 0 && relationDevices(r).indexOf(o.device) >= 0);
        mems.push({ dev: d.id, agg: i.id, port, peer: o.device, peerPort: o.port, state: 'Detached', heard: -1, gen: 0, rel, txGen: 0 });
      }
    }
  }
  if (!mems.length) return;
  // the LACP rate of the member's aggregate: slow (30 s, timeout 90 s) or fast (1 s, timeout 3 s), IEEE 802.1AX
  const rate = (m: Mem): { every: number; timeout: number; text: string } => {
    const r = P.param('lacp-rate', m.dev, ifaceRef(m.dev, m.agg));
    const fast = r.value === 'fast';
    return { every: fast ? 1000 : 30000, timeout: fast ? 3000 : 90000, text: P.paramText(r) };
  };
  /** how often a member sends: fast while its partner's LACP_Timeout (in its last LACPDU) is short, else slow (802.1AX periodic machine) */
  const txEvery = (m: Mem): number => (m.partnerShort ? 1000 : 30000);
  const txText = (m: Mem): string => (m.partnerShort ? 'its partner’s timeout is short' : m.partnerShort === false ? 'its partner’s timeout is long' : 'no partner heard yet');
  const set = (m: Mem, st: string, why: string): void => {
    if (m.state === st) return;
    m.state = st;
    P.e.note('state', 'lacp', m.dev, m.peer, st, st, `LACP ${m.dev}:${m.agg} member ${m.port} (to ${m.peer}:${m.peerPort}): ${st}${why ? ' (' + why + ')' : ''}`);
    // only a member that is collecting and distributing carries the aggregate's traffic
    P.e.holdMember(m.dev, m.port, st !== 'Collecting / Distributing');
  };
  const send = (m: Mem, why: string): void => {
    const short = rate(m).timeout === 3000;
    const detail = `LACPDU from ${m.dev}:${m.port} (${m.agg}) to ${LACP_MAC}: actor state ${m.state === 'Collecting / Distributing' ? 'in sync, collecting, distributing' : m.state === 'Attached' ? 'in sync' : 'not in sync'}, LACP_Timeout ${short ? 'short' : 'long'}${why ? '; ' + why : ''}`;
    P.onPort('lacp', m.dev, m.port, LACP_MAC, 'LACPDU', 'LACP LACPDU', detail, { agg: m.agg, state: m.state, timeout: short ? 'short' : 'long' }, m.peer, m.rel);
  };
  /** the member's periodic LACPDUs, from `first` ms on, every txEvery; a new start ends the old one */
  const startTx = (m: Mem, first: number | undefined, why: string, onlyUp: boolean): void => {
    const g = ++m.txGen;
    P.periodic(
      () => m.txGen === g,
      () => txEvery(m),
      () => {
        if (!onlyUp || P.e.portUp(m.dev, m.port)) send(m, why);
      },
      first,
    );
  };
  // until LACP bundles a member, the aggregate's traffic waits for it
  for (const m of mems) P.e.holdMember(m.dev, m.port, true, true);
  // the members whose LACPDUs started (at their first link-up): a later link-up restarts them
  const started = new Set<Mem>();
  P.bootHooks.push(() => {
    for (const m of mems) {
      P.whenPortUp(m.dev, m.port, () => {
        started.add(m);
        startTx(m, undefined, 'periodic', true);
      });
    }
  });
  P.handlers.set('lacp', (dev, _l3, msg, _pkt, frame) => {
    const port = ((msg.data || {}) as { port?: string }).port;
    void port;
    const m = mems.find((x) => x.dev === dev && frame && P.e.net.ends.get(portKey(dev, x.port)) && x.peer === ((msg.data || {}) as { from?: string }).from && x.peerPort === ((msg.data || {}) as { port?: string }).port);
    if (!m) return;
    m.heard = P.e.now;
    // the partner's LACP_Timeout: short — this member transmits fast from now on (the periodic machine's FAST_PERIODIC: the next
    // LACPDU within a fast period), long — slow again
    const short = ((msg.data || {}) as { timeout?: string }).timeout === 'short';
    if (m.partnerShort !== short) {
      const was = m.partnerShort;
      m.partnerShort = short;
      if (started.has(m) && (short || was !== undefined)) startTx(m, short ? 1000 : 30000, 'periodic', true);
    }
    const g = m.gen;
    const timeout = rate(m).timeout;
    P.e.after(timeout, () => {
      if (m.gen === g && P.e.now - m.heard >= timeout - 1 && m.state !== 'Detached') {
        set(m, 'Detached', `no LACPDU for ${fmtSec(timeout)} (LACP rate ${rate(m).text})`);
        // (its state changed: it tells its partner at once — need to transmit, 802.1AX — not at its next periodic LACPDU)
        if (P.e.portUp(m.dev, m.port)) send(m, 'its partner timed out');
      }
    });
    const theirs = ((msg.data || {}) as { state?: string }).state || 'Detached';
    // the partner as its LACPDU names it (its system and its aggregate's key): every member of an aggregate must have the same
    // partner (IEEE 802.1AX selection) — a member cabled to another system or another aggregate there is not bundled
    const dd = (msg.data || {}) as { from?: string; agg?: string };
    m.partner = `${dd.from}|${dd.agg}`;
    const other = mems.find((x) => x.dev === m.dev && x.agg === m.agg && x !== m && x.state !== 'Detached' && x.partner !== undefined && x.partner !== m.partner);
    if (other) {
      if (m.state !== 'Detached') set(m, 'Detached', `its partner ${dd.from} (${dd.agg}) is not the aggregate's (${other.partner!.split('|').join(', ')})`);
      else if (!m.rel || !P.shared.has('lacp-mismatch|' + m.dev + '|' + m.port)) {
        P.shared.set('lacp-mismatch|' + m.dev + '|' + m.port, true);
        P.e.note('state', 'lacp', m.dev, m.peer, 'not bundled', 'Detached', `LACP ${m.dev}:${m.agg} member ${m.port}: its partner ${dd.from} (${dd.agg}) differs from the aggregate's other members' (${other.partner!.split('|').join(', ')}): it is not bundled`);
      }
      return;
    }
    if (m.state === 'Detached') {
      set(m, 'Attached', `partner ${m.peer}:${m.peerPort}`);
      send(m, 'answers the partner');
    } else if (m.state === 'Attached' && theirs !== 'Detached') {
      set(m, 'Collecting / Distributing', 'partner in sync');
      send(m, 'in sync');
    } else if (m.state === 'Collecting / Distributing' && theirs === 'Detached') {
      // the mux machine: the partner is not in sync — this member stops collecting and distributing (Attached), and says so
      set(m, 'Attached', `its partner ${m.peer}:${m.peerPort} is not in sync`);
      send(m, 'partner not in sync');
    }
  });
  P.linkHooks.push((ref, up) => {
    for (const m of mems) {
      const e = P.e.net.ends.get(portKey(m.dev, m.port));
      if (!e || 'link:' + e.link !== ref) continue;
      if (!up) {
        m.gen++;
        set(m, 'Detached', 'its link went down');
      } else if (started.has(m)) {
        m.gen++;
        m.partnerShort = undefined;
        startTx(m, 200, 'link up again', false);
      }
    }
  });
  P.extraStatus.push((): SessionStatus[] => mems.map((m) => ({ protocol: 'lacp', name: `${m.dev}:${m.agg} member ${m.port} → ${m.peer}:${m.peerPort}`, device: m.dev, peer: m.peer, state: m.state, detail: `LACPDU every ${fmtSec(txEvery(m))} (${txText(m)}), timeout ${fmtSec(rate(m).timeout)} (LACP rate ${rate(m).text})`, up: m.state === 'Collecting / Distributing', relation: m.rel ? m.rel.id : undefined })));
}

// ------------------------------------------------------------------ STP, LLDP, CDP (where the model has their relations)

/**
 * STP's BPDUs (shown; the tree itself is computed from the topology:
 * engine.ts spanningTree), LLDP and CDP advertisements on the cables of
 * their relations. A neighbour is known from its advertisements only: for
 * the time-to-live its last one announced (LLDP's TTL TLV, CDP's holdtime),
 * and no longer once the port's link goes down or the device is powered
 * off (IEEE 802.1AB: the remote information of a port that is disabled is
 * deleted) — never by looking at the neighbour.
 */
export function installL2Adverts(P: ProtocolSim): void {
  const STP_MAC = '01:80:c2:00:00:00';
  for (const r of P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
    const base = P.e.base(r);
    if (['stp', 'lldp', 'cdp'].indexOf(base) < 0) continue;
    const p = simProfile(base);
    if (!p) continue;
    const devs = relationDevices(r);
    // the cables between two of its devices: each end sends on its port
    type Port = { dev: string; port: string; peer: string; peerPort: string; heard: number; known: boolean; ttl: number; gen: number };
    const ports: Port[] = [];
    for (const l of P.m.links) {
      if (devs.indexOf(l.a.device) < 0 || devs.indexOf(l.b.device) < 0 || l.a.device === l.b.device) continue;
      ports.push({ dev: l.a.device, port: linkPort(P.m, l, l.a), peer: l.b.device, peerPort: linkPort(P.m, l, l.b), heard: -1, known: false, ttl: 0, gen: 0 });
      ports.push({ dev: l.b.device, port: linkPort(P.m, l, l.b), peer: l.a.device, peerPort: linkPort(P.m, l, l.a), heard: -1, known: false, ttl: 0, gen: 0 });
    }
    if (!ports.length) continue;
    // STP's hello time is each switch's own (its simulation attribute); LLDP's and CDP's their profile's
    const helloOf = (dev: string): number => (base === 'stp' ? Number(P.param('stp-hello', dev).value) : (p.timers.find((t) => t.key === 'hello') || { seconds: 30 }).seconds * 1000);
    const hello = helloOf('');
    const ttl = (p.timers.find((t) => t.key === 'dead') || { seconds: 120 }).seconds * 1000;
    const mac = p.mac || STP_MAC;
    P.bootHooks.push(() => {
      for (const x of ports) {
        const tick = (): void => {
          if (P.e.portUp(x.dev, x.port) && P.e.deviceOn(x.dev)) {
            const sd = P.sd(x.dev);
            if (base === 'stp') {
              // BPDUs leave forwarding ports only (a blocked port listens)
              const bp = sd.portOf.get(x.port);
              const bport = bp ? sd.bridgePorts.get(bp) : undefined;
              const blocked = !!bport && P.e.net.vlans.some((v) => carries(bport.vlans, v) && P.e.blocked(x.dev, bport.id, v));
              if (!blocked) {
                const root = stpRoot(P, devs);
                P.onPort('stp', x.dev, x.port, mac, 'BPDU', `${P.param('stp-mode', x.dev).value === 'stp' ? 'STP' : 'RSTP'} BPDU`, `${P.param('stp-mode', x.dev).value === 'stp' ? 'Configuration BPDU (802.1D)' : 'RST BPDU (802.1w)'} from ${x.dev}:${x.port}: root ${root || '?'}, bridge ${sd.bridgeId || x.dev}, hello ${fmtSec(helloOf(x.dev))}`, {}, x.peer, r);
              }
            } else P.onPort(base, x.dev, x.port, mac, p.messages[0].name, `${p.label} ${p.messages[0].name}`, `${p.messages[0].name} from ${x.dev}:${x.port}: system ${x.dev}, port ${x.port}, TTL ${fmtSec(ttl)}`, { ttl }, x.peer, r);
          }
        };
        P.whenPortUp(x.dev, x.port, () => P.periodic(() => true, () => helloOf(x.dev), tick));
      }
    });
    P.handlers.set(base, (dev, _l3, msg) => {
      const from = ((msg.data || {}) as { from?: string; port?: string; ttl?: number });
      const x = ports.find((q) => q.dev === dev && q.peer === from.from && q.peerPort === from.port);
      if (!x) return;
      x.heard = P.e.now;
      // (the time-to-live the advertisement announced: the sender's, not this device's own setting)
      x.ttl = typeof from.ttl === 'number' ? from.ttl : ttl;
      if (!x.known && base !== 'stp') {
        x.known = true;
        P.e.note('state', base, dev, x.peer, 'neighbour known', 'neighbour known', `${p.label} on ${dev}:${x.port}: neighbour ${x.peer} port ${x.peerPort} (for ${fmtSec(x.ttl)}, the TTL it announced)`);
      }
      const g = x.gen;
      const life = x.ttl;
      P.e.after(life, () => {
        if (x.gen === g && x.known && P.e.now - x.heard >= life - 1) {
          x.known = false;
          P.e.note('state', base, dev, x.peer, 'neighbour aged out', 'no neighbour', `${p.label} on ${dev}:${x.port}: ${x.peer} aged out after ${fmtSec(life)}`);
        }
      });
    });
    // what a port knew is gone with its link, and with its device's power
    const forget = (x: Port, why: string): void => {
      x.gen++;
      if (!x.known) return;
      x.known = false;
      P.e.note('state', base, x.dev, x.peer, 'neighbour removed', 'no neighbour', `${p.label} on ${x.dev}:${x.port}: ${x.peer} removed (${why})`);
    };
    P.linkHooks.push((ref, up) => {
      if (up) return;
      for (const x of ports) {
        const e = P.e.net.ends.get(portKey(x.dev, x.port));
        if (e && 'link:' + e.link === ref) forget(x, 'its link went down');
      }
    });
    P.deviceHooks.push((dev, up) => {
      if (!up) for (const x of ports) if (x.dev === dev) forget(x, `${dev} was powered off`);
    });
    P.extraStatus.push((): SessionStatus[] =>
      base === 'stp'
        ? devs.filter((d) => P.sd(d) && P.sd(d).bridge).map((d) => ({ protocol: 'stp', name: `${r.id}: ${d}`, device: d, peer: '', state: stpRoot(P, devs) === (P.sd(d).bridgeId || d) ? 'Root bridge' : 'Forwarding', detail: `bridge ${P.sd(d).bridgeId}; blocked: ${stpBlockedPorts(P, d).join(', ') || 'none'}`, up: true, relation: r.id }))
        : ports.map((x) => ({ protocol: base, name: `${x.dev}:${x.port} → ${x.peer}:${x.peerPort}`, device: x.dev, peer: x.peer, state: x.known ? 'neighbour known' : 'no neighbour', detail: `every ${fmtSec(hello)}, TTL ${fmtSec(ttl)}${x.known ? `; the neighbour's last advertisement ${fmtSec(P.e.now - x.heard)} ago announced ${fmtSec(x.ttl)}` : ''}`, up: x.known, relation: r.id })),
    );
  }
}

/** The root of the spanning tree of the first VLAN the bridges `devs` carry (the network's first VLAN, or untagged, when they carry none). */
function stpRoot(P: ProtocolSim, devs: string[]): string {
  const theirs = P.e.net.vlans.find((v) => devs.some((d) => P.sd(d) && Array.from(P.sd(d).bridgePorts.values()).some((bp) => carries(bp.vlans, v))));
  const v = theirs !== undefined ? theirs : P.e.net.vlans.length ? P.e.net.vlans[0] : 0;
  const t = P.e.tree(v);
  const sd = t.root ? P.e.net.devices.get(t.root) : undefined;
  return sd ? sd.bridgeId : '';
}

function stpBlockedPorts(P: ProtocolSim, dev: string): string[] {
  const sd = P.sd(dev);
  const out: string[] = [];
  for (const bp of sd.bridgePorts.values()) if (P.e.net.vlans.some((v) => carries(bp.vlans, v) && P.e.blocked(dev, bp.id, v))) out.push(bp.id);
  return out.sort(cmp);
}

// ------------------------------------------------------------------ gratuitous ARP at boot, and the demands

/** When the model's data (demands, streams) starts: once the network had time to come up (the link-up delay) and to converge a little. */
export const DATA_START = 4000;

/**
 * An interface that is up from the start (no cable to wait for) announces
 * its addresses at once (gratuitous ARP, unsolicited Neighbor
 * Advertisement); one that waits for its cable does so when it comes up.
 */
export function installBootGarp(P: ProtocolSim): void {
  P.bootHooks.push(() => {
    for (const d of P.e.net.devices.values()) {
      for (const l3 of Array.from(d.l3.values()).sort((a, b) => cmp(a.id, b.id))) {
        if (l3.kind === 'loopback' || l3.kind === 'tunnel' || !l3.addrs.length || !P.e.isL3Up(d.id, l3.id)) continue;
        for (const a of l3.addrs) P.e.at(P.e.jitter(d.id), () => P.e.gratuitous(d.id, l3, a.addr, l3.mac, `${l3.id} came up`));
      }
    }
  });
}

/** A demand's representative packet's size on the wire (its IP packet: engine.ts ipLen of a demand's data). */
const DEMAND_BYTES = 1420;

/** The model's demands: representative data packets from the source to the destination, more often for more bandwidth; delivered or lost. */
export function installDemands(P: ProtocolSim): void {
  type D = { id: string; label: string; dev: string; src: IpAddr; dst: IpAddr; every: number; sent: number; got: number; last: number; multicast: boolean; bps: number };
  const list: D[] = [];
  for (const dm of P.m.demands.slice().sort((a, b) => cmp(a.id, b.id))) {
    const se = parseTraceEnd(P.m, dm.source);
    const de = parseTraceEnd(P.m, dm.destination);
    if (typeof se === 'string' || typeof de === 'string') continue;
    const dev = se.kind === 'address' ? ownerOf(P, addr(se.address)) : se.device;
    if (!dev || !P.sd(dev)) continue;
    const sd = P.sd(dev);
    const dstAddr: IpAddr | null = de.kind === 'address' ? parseAddress(de.address) : firstAddr(P, de.device, de.kind === 'iface' ? de.iface : undefined);
    if (!dstAddr) continue;
    const srcAddr: IpAddr | null = se.kind === 'address' ? parseAddress(se.address) : firstAddr(P, dev, se.kind === 'iface' ? se.iface : undefined, dstAddr.version);
    if (!srcAddr || !sd) continue;
    // a multicast demand is a stream (multicast.ts)
    if (isMulticastIp(dstAddr)) continue;
    const ms = Math.round(Math.max(1000, Math.min(4000, 4000 / (1 + Math.log10(1 + dm.bps / 1e7)))));
    list.push({ id: dm.id, label: dm.label || dm.id, dev, src: srcAddr, dst: dstAddr, every: ms, sent: 0, got: 0, last: -1, multicast: isMulticastIp(dstAddr), bps: dm.bps });
  }
  if (!list.length) return;
  P.bootHooks.push(() => {
    for (const x of list) {
      const tick = (): void => {
        x.sent++;
        const msg: Msg = { protocol: 'demand', type: 'Data', label: `Data ${x.label}`, detail: `demand ${x.id} (${x.label}): representative data packet ${x.sent} from ${x.dev} (${formatAddr(x.src)}) to ${formatAddr(x.dst)} — it shows the demand's way, not its ${bpsText(x.bps)}`, data: { from: x.dev, demand: x.id, n: x.sent, source: formatAddr(x.src) } };
        const pkt = P.e.newPacket(x.src, x.dst, '', msg, []);
        // the transport of a load test (iperf's default port)
        pkt.l4 = { proto: 'udp', num: 17, sport: 5001, dport: 5001 };
        P.e.note('message', 'demand', x.dev, '', 'Data', '', msg.detail, P.e.now, msg);
        if (x.multicast) {
          const out = Array.from(P.sd(x.dev).l3.values()).find((l) => l.kind !== 'loopback' && l.kind !== 'tunnel' && l.addrs.some((a) => compareAddr(a.addr, x.src) === 0)) || Array.from(P.sd(x.dev).l3.values()).find((l) => l.kind !== 'loopback');
          if (out) P.e.send(x.dev, pkt, out);
        } else P.e.send(x.dev, pkt);
        P.e.after(x.every, tick);
      };
      // data starts once the network had time to converge (it still waits for ARP like any packet); all demands together
      P.e.at(DATA_START + P.e.jitter(x.dev), tick);
    }
  });
  P.handlers.set('demand', (dev, l3, msg, pkt) => {
    const d = (msg.data || {}) as { demand?: string; source?: string };
    // multicast data: the members take it (multicast.ts)
    if (pkt && isMulticastIp(pkt.dst)) {
      const m = P.shared.get('multicast') as { dataIn(dev: string, l3: L3Iface, pkt: Pkt): boolean } | undefined;
      if (m && l3) m.dataIn(dev, l3, pkt);
      return;
    }
    const x = list.find((q) => q.id === d.demand);
    if (!x) return;
    x.got++;
    x.last = P.e.now;
  });
  P.extraStatus.push((): SessionStatus[] =>
    list.map((x) => {
      const lost = x.sent - x.got;
      return { protocol: 'demand', name: `${x.id}: ${x.dev} → ${formatAddr(x.dst)}`, device: x.dev, peer: '', state: x.multicast ? 'multicast' : x.got && P.e.now - x.last < 3 * x.every + 3000 ? 'Delivered' : x.sent ? 'Lost' : 'Waiting', detail: `${x.got} of ${x.sent} representative packets delivered${lost > 0 ? ` (${lost} lost or on their way)` : ''}; ${representativeText(x.bps, x.every, DEMAND_BYTES)}`, up: x.multicast || (x.got > 0 && P.e.now - x.last < 3 * x.every + 3000) };
    }),
  );
}


function ownerOf(P: ProtocolSim, a: IpAddr): string | undefined {
  for (const d of P.e.net.devices.values()) for (const l of d.l3.values()) if (l.addrs.some((x) => compareAddr(x.addr, a) === 0)) return d.id;
  return undefined;
}

function firstAddr(P: ProtocolSim, dev: string, iface?: string, version?: 4 | 6): IpAddr | null {
  const sd = P.sd(dev);
  if (!sd) return null;
  const ls = Array.from(sd.l3.values()).filter((l) => (iface ? l.id === iface : l.kind !== 'tunnel')).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id));
  for (const l of ls) for (const a of l.addrs) if (!version || a.addr.version === version) return a.addr;
  return null;
}

/**
 * A protocol of the model's own between devices without addresses (a TAP
 * or SPAN feed between a switch and a sensor): its dummy packets go as
 * frames over the cable between them, in the relation's direction (and
 * never against a one-way cable).
 */
export function installCustomL2(P: ProtocolSim): void {
  type Feed = { rel: Relation; protocol: string; label: string; from: string; port: string; to: string; toPort: string; sent: number; got: number };
  const feeds: Feed[] = [];
  for (const r of P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
    const prof = P.profileOf(r);
    if (prof.behaviour !== 'custom') continue;
    const devs = relationDevices(r);
    const last = devs[devs.length - 1];
    const pairs: Array<[string, string]> = [];
    for (const c of devs.slice(0, -1)) {
      pairs.push([c, last]);
      if (r.direction !== 'unidirectional') pairs.push([last, c]);
    }
    for (const [a, b] of pairs) {
      if (P.pairSides(r, a, b)) continue;
      for (const l of P.m.links.slice().sort((x, y) => cmp(x.id, y.id))) {
        const fwd = l.a.device === a && l.b.device === b;
        const back = l.b.device === a && l.a.device === b;
        if (!fwd && !back) continue;
        // a one-way cable carries frames from end a to end b only
        if (back && l.direction === 'unidirectional') continue;
        const from = fwd ? l.a : l.b;
        const to = fwd ? l.b : l.a;
        feeds.push({ rel: r, protocol: prof.id, label: prof.label, from: a, port: linkPort(P.m, l, from), to: b, toPort: linkPort(P.m, l, to), sent: 0, got: 0 });
        break;
      }
    }
  }
  if (!feeds.length) return;
  P.bootHooks.push(() => {
    for (const f of feeds) {
      const iv = 5000;
      const tick = (): void => {
        f.sent++;
        P.onPort(f.protocol, f.from, f.port, 'ff:ff:ff:ff:ff:ff', 'packet', `${f.label} packet`, `${f.label} packet ${f.sent} from ${f.from}:${f.port} to ${f.to} over their cable (the devices have no addresses; ${f.rel.direction === 'unidirectional' ? 'one way' : 'both ways'})`, {}, f.to, f.rel);
        P.e.after(iv, tick);
      };
      P.whenPortUp(f.from, f.port, tick);
    }
  });
  for (const id of Array.from(new Set(feeds.map((f) => f.protocol)))) {
    P.handlers.set(id, (dev, _l3, msg) => {
      const d = (msg.data || {}) as { from?: string };
      const f = feeds.find((x) => x.to === dev && x.from === d.from && x.protocol === msg.protocol);
      if (f) f.got++;
    });
  }
  P.extraStatus.push((): SessionStatus[] => feeds.map((f) => ({ protocol: f.protocol, name: `${f.rel.id}: ${f.from} → ${f.to}`, device: f.from, peer: f.to, state: f.got ? 'Sending' : 'Waiting', detail: `${f.got} of ${f.sent} packets arrived (frames over the cable)`, up: f.got > 0, relation: f.rel.id })));
}

/** The PIM messages between a source's first router and the RP (they are no neighbours): Register and Register-Stop. */
export const OTHER_BEHAVIOURS: { [id: string]: Behaviour } = { ike, session, service, data, custom, pim };

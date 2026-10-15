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
import { Relation, deviceInterfaces, relationDevices } from '../../model/types';
import { compareAddr, formatAddr } from '../ipmath';
import { parseTraceEnd } from '../trace';
import { encapStack } from '../trace';
import { fmtSec } from './engine';
import { isMulticastIp, multicastMac, virtualMac } from './mac';
import { L3Iface, carries, otherEnd, portKey } from './net';
import { Behaviour, ProtocolSim, Sess } from './protocols';
import { Msg, Pkt, SessionStatus } from './types';

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
  key: string;
  protocol: string;
  dev: string;
  l3: L3Iface;
  group: number;
  vip: IpAddr;
  vmac: string;
  prio: number;
  preempt: boolean;
  state: string;
  gen: number;
  heardAt: number;
  rel?: Relation;
}

const FHRP = ['vrrp', 'hsrp', 'glbp', 'carp'];

/** The groups on the interfaces (VRRP …): elections, advertisements from the master, failover with a gratuitous ARP. */
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
        const prio = Number(sv.values.get('priority') || '100');
        const rel = P.m.relations.find((r) => P.e.base(r) === sv.id && relationDevices(r).indexOf(d.id) >= 0);
        const pre = rel ? rel.attrs.find(([k]) => k === 'preempt') : undefined;
        members.push({ key: `${sv.id}|${l3.vrf}|${g}|${formatAddr(vip)}`, protocol: sv.id, dev: d.id, l3, group: g, vip, vmac: virtualMac(sv.id, g, vip.version), prio, preempt: pre ? pre[1] !== 'false' : sv.id !== 'hsrp', state: 'Initialize', gen: 0, heardAt: -1, rel });
      }
    }
  }
  if (!members.length) return;
  const label = (m: FhrpMember): string => (simProfile(m.protocol) || { label: m.protocol.toUpperCase() }).label;
  const names = (m: FhrpMember, st: string): string => (m.protocol === 'hsrp' || m.protocol === 'glbp' ? (st === 'Master' ? 'Active' : st === 'Backup' ? 'Standby' : st) : st);
  const timers = (m: FhrpMember): { adv: number; down: number } => {
    const p = simProfile(m.protocol);
    const hold = p ? p.timers.find((t) => t.key === 'dead') : undefined;
    const a = p ? P.timer(null, p, 'hello', m.dev).ms : 1000;
    // VRRP / CARP: 3 × advertisement + skew ((256 − priority) / 256 s); HSRP / GLBP: the hold time
    const down = m.protocol === 'vrrp' || m.protocol === 'carp' ? 3 * a + Math.round(((256 - m.prio) / 256) * a) : (hold ? hold.seconds : 10) * 1000;
    return { adv: a, down };
  };
  const set = (m: FhrpMember, st: string, why: string): void => {
    if (m.state === st) return;
    m.state = st;
    P.e.note('state', m.protocol, m.dev, '', names(m, st), names(m, st), `${label(m)} group ${m.group} (${formatAddr(m.vip)}) on ${m.dev}:${m.l3.id}: ${names(m, st)}${why ? ' (' + why + ')' : ''}`);
    const k = m.dev + ':' + m.l3.id;
    const held = (P.vips.get(k) || []).filter((v) => !(compareAddr(v.addr, m.vip) === 0 && v.protocol === m.protocol));
    if (st === 'Master') held.push({ addr: m.vip, mac: m.vmac, protocol: m.protocol });
    P.vips.set(k, held);
  };
  const advertise = (m: FhrpMember): void => {
    const p = simProfile(m.protocol);
    const type = m.protocol === 'vrrp' || m.protocol === 'carp' ? 'Advertisement' : 'Hello';
    const group = addr(m.vip.version === 4 ? (p && p.group4) || '224.0.0.18' : (p && p.group6) || 'ff02::12');
    const src = m.l3.addrs.find((a) => a.addr.version === m.vip.version);
    if (!src || !P.e.isL3Up(m.dev, m.l3.id)) return;
    const msg: Msg = { protocol: m.protocol, type, label: `${label(m)} ${type}`, detail: `${label(m)} ${type}: group ${m.group}, priority ${m.prio}, virtual ${formatAddr(m.vip)}, from ${m.dev}:${m.l3.id} (source MAC ${m.vmac}, the virtual MAC) to ${formatAddr(group)} (${multicastMac(group)})`, relation: m.rel ? m.rel.id : undefined, data: { from: m.dev, key: m.key, prio: m.prio, ip: formatAddr(src.addr) } };
    P.e.note('message', m.protocol, m.dev, '', type, names(m, m.state), msg.detail);
    if (m.rel) for (const o of members) if (o.key === m.key && o !== m) P.lane(m.rel, m.dev, o.dev, msg, 2 * P.e.hopTime());
    const pkt = P.e.newPacket(src.addr, group, m.l3.vrf, msg, m.rel ? [m.rel.id] : [], 255);
    P.e.emit(m.dev, m.l3, { src: m.vmac, dst: multicastMac(group), msg, ip: pkt });
  };
  const becomeMaster = (m: FhrpMember, why: string): void => {
    m.gen++;
    set(m, 'Master', why);
    // the new master announces the virtual address with the virtual MAC: switches learn its port, hosts keep their entry
    P.e.gratuitous(m.dev, m.l3, m.vip, m.vmac, `${label(m)} group ${m.group}: ${m.dev} is the new ${names(m, 'Master')}`, 'garp');
    const g = m.gen;
    P.periodic(
      () => m.gen === g && m.state === 'Master',
      () => timers(m).adv,
      () => advertise(m),
    );
  };
  const backup = (m: FhrpMember, why: string): void => {
    m.gen++;
    set(m, 'Backup', why);
    const g = m.gen;
    const wait = (): void => {
      if (m.gen !== g || m.state !== 'Backup') return;
      if (P.e.now - m.heardAt >= timers(m).down - 1) becomeMaster(m, m.heardAt < 0 ? 'no master heard' : `master down interval expired (${fmtSec(timers(m).down)}): no ${m.protocol === 'vrrp' || m.protocol === 'carp' ? 'advertisement' : 'hello'} from the master`);
      else P.e.after(timers(m).down - (P.e.now - m.heardAt), wait);
    };
    P.e.after(timers(m).down, wait);
  };
  P.bootHooks.push(() => {
    // each starts (Backup) as soon as its interface is up: all of them together
    for (const m of members) P.whenIfaceUp(m.dev, m.l3.id, () => backup(m, 'initial state'));
  });
  for (const proto of FHRP) {
    P.handlers.set(proto, (dev, l3, msg) => {
      const d = (msg.data || {}) as { key?: string; prio?: number; ip?: string; from?: string };
      for (const m of members) {
        if (m.dev !== dev || !l3 || m.l3.id !== l3.id || m.key !== d.key || d.from === dev) continue;
        const theirs = d.prio || 0;
        const higher = theirs > m.prio || (theirs === m.prio && d.ip !== undefined && compareAddr(addr(d.ip), (m.l3.addrs[0] || { addr: addr('0.0.0.0') }).addr) > 0);
        if (m.state === 'Backup') {
          if (higher || !m.preempt) m.heardAt = P.e.now;
          else becomeMaster(m, `preempts ${d.from} (priority ${m.prio} > ${theirs})`);
        } else if (m.state === 'Master' && higher) {
          m.heardAt = P.e.now;
          backup(m, `${d.from} has priority ${theirs}`);
        }
      }
    });
  }
  P.ifaceHooks.push((dev, l3, up) => {
    for (const m of members) {
      if (m.dev !== dev || m.l3.id !== l3.id) continue;
      if (!up) {
        m.gen++;
        set(m, 'Initialize', `interface ${l3.id} went down`);
      } else backup(m, `interface ${l3.id} came up`);
    }
  });
  P.extraStatus.push((): SessionStatus[] =>
    members.map((m) => ({ protocol: m.protocol, name: `group ${m.group} (${formatAddr(m.vip)}): ${m.dev}:${m.l3.id}`, device: m.dev, peer: '', state: names(m, m.state), detail: `priority ${m.prio}${m.preempt ? ', preempt' : ''}; virtual MAC ${m.vmac}`, up: m.state === 'Master' || m.state === 'Backup', relation: m.rel ? m.rel.id : undefined })),
  );
}

// ------------------------------------------------------------------ IPsec (IKEv2)

const ike: Behaviour = {
  refresh(P, s) {
    if (s.up && s.initiator) ikeDetail(P, s);
  },
  start(P, s) {
    s.state = 'Idle';
    if (s.initiator) ikeInit(P, s);
  },
  rx(P, s, msg) {
    const d = (msg.data || {}) as { response?: boolean };
    switch (msg.type) {
      case 'IKE_SA_INIT':
        if (!d.response) {
          if (s.state === 'Established') P.setState(s, 'Idle', false, 'the peer starts over');
          P.unicast(s, 'IKE_SA_INIT', 'response: chosen proposal, KE, Nr', { response: true }, 'IKE_SA_INIT');
          P.setState(s, 'IKE_SA_INIT', false, 'request from the peer');
        } else if (s.state === 'IKE_SA_INIT') {
          P.unicast(s, 'IKE_AUTH', 'request: IDi, AUTH, SAi2, TSi, TSr (encrypted)', {}, 'IKE_AUTH');
          P.setState(s, 'IKE_AUTH', false, 'IKE SA keys derived');
        }
        return;
      case 'IKE_AUTH':
        if (!d.response) {
          P.unicast(s, 'IKE_AUTH', 'response: IDr, AUTH, SAr2 (the first Child SA)', { response: true }, 'Established');
          ikeUp(P, s);
        } else if (s.state === 'IKE_AUTH') ikeUp(P, s);
        return;
      case 'INFORMATIONAL':
        if (!d.response) P.unicast(s, 'INFORMATIONAL', 'DPD response (empty)', { response: true });
        else s.x.dpdMiss = 0;
        return;
      case 'CREATE_CHILD_SA':
        if (!d.response) P.unicast(s, 'CREATE_CHILD_SA', 'response: the new Child SA', { response: true });
        return;
      default:
        return;
    }
  },
};

function ikeInit(P: ProtocolSim, s: Sess): void {
  P.restart(s);
  P.setState(s, 'IKE_SA_INIT', false, 'initiating');
  P.unicast(s, 'IKE_SA_INIT', `request: SA proposals, KE, Ni to ${formatAddr(s.remote.addr)} UDP 500`, {}, 'IKE_SA_INIT');
  // no answer: start over after the DPD interval
  P.later(s, P.timer(s, s.profile, 'dpd').ms, () => {
    if (!s.up) ikeInit(P, s);
  });
}

function ikeDetail(P: ProtocolSim, s: Sess): void {
  const dpd = P.timer(s, s.profile, 'dpd');
  const retries = P.timer(s, s.profile, 'dpd-retries');
  const life = P.timer(s, s.profile, 'child-lifetime');
  const ike = P.timer(s, s.profile, 'ike-lifetime');
  s.x.detail = `DPD ${dpd.text} × ${retries.text}; Child SA lifetime ${life.text}; IKE SA lifetime ${ike.text}; rekey margin ${P.paramText(P.param('rekey-margin', s.dev))}`;
}

/** Rekey an SA before its lifetime ends (its lifetime less the rekey margin, at least half of it). */
function rekeyAfter(P: ProtocolSim, s: Sess, key: string): number {
  const life = P.timer(s, s.profile, key).ms;
  const margin = Number(P.param('rekey-margin', s.dev).value);
  return Math.max(life / 2, life - margin);
}

function ikeUp(P: ProtocolSim, s: Sess): void {
  P.restart(s);
  P.setState(s, 'Established', true, 'IKE SA and Child SA established');
  P.e.syncInterfaces();
  if (!s.initiator) return;
  ikeDetail(P, s);
  s.x.dpdMiss = 0;
  every(P, s, () => P.timer(s, s.profile, 'dpd').ms, () => {
    const retries = Math.max(1, Math.round(P.timer(s, s.profile, 'dpd-retries').ms / 1000));
    const dpd = P.timer(s, s.profile, 'dpd');
    if ((s.x.dpdMiss as number) >= retries) {
      const peer = P.sess(s.protocol, s.rel.id, s.peer, s.dev);
      P.setState(s, 'Idle', false, `Dead Peer Detection: ${s.x.dpdMiss} requests unanswered; the SAs are deleted`);
      if (peer && peer.up) P.setState(peer, 'Idle', false, 'the SAs are deleted');
      P.e.syncInterfaces();
      P.later(s, dpd.ms, () => ikeInit(P, s));
      P.restart(s);
      return;
    }
    s.x.dpdMiss = (s.x.dpdMiss as number) + 1;
    P.unicast(s, 'INFORMATIONAL', 'DPD request (empty)');
  });
  const g = s.gen;
  let first = true;
  P.periodic(
    () => s.gen === g,
    () => rekeyAfter(P, s, 'child-lifetime'),
    () => {
      if (first) {
        first = false;
        return;
      }
      P.unicast(s, 'CREATE_CHILD_SA', `rekeys the Child SA ${fmtSec(Number(P.param('rekey-margin', s.dev).value))} before its lifetime (${P.timer(s, s.profile, 'child-lifetime').text}) ends`);
    },
  );
  let firstIke = true;
  P.periodic(
    () => s.gen === g,
    () => rekeyAfter(P, s, 'ike-lifetime'),
    () => {
      if (firstIke) {
        firstIke = false;
        return;
      }
      P.unicast(s, 'CREATE_CHILD_SA', `rekeys the IKE SA before its lifetime (${P.timer(s, s.profile, 'ike-lifetime').text}) ends`);
    },
  );
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

function sessionSend(P: ProtocolSim, s: Sess, type: string, detail: string, data: { [k: string]: unknown } = {}): void {
  if (s.protocol === 'gre') greSend(P, s, type, detail);
  else P.unicast(s, type, detail, data);
}

const session: Behaviour = {
  refresh(P, s) {
    const p = s.profile;
    s.x.detail = `${p.keepalive ? p.keepalive.msg.toLowerCase() + ' every ' + P.timer(s, p, 'hello').text + ', down after ' + P.timer(s, p, 'dead').text : ''}`;
  },
  start(P, s) {
    const p = s.profile;
    s.state = p.states[0];
    session.refresh!(P, s);
    if (s.initiator && p.handshake && p.handshake.length) {
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
      // a session that is down starts its handshake again
      if (!s.up && s.initiator && p.handshake && p.handshake.length && P.e.now - s.since >= P.timer(s, p, 'dead').ms) {
        sessionSend(P, s, p.handshake[0].msg, 'starts the session again', { step: 0 });
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
  rx(P, s, msg) {
    const p = s.profile;
    const d = (msg.data || {}) as { step?: number; ka?: boolean };
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
        sessionSend(P, s, next.msg, `handshake step ${d.step + 2} of ${p.handshake.length}`, { step: d.step + 1 });
        // the rest of the handshake that is ours as well
        let k = d.step + 2;
        while (p.handshake[k] && p.handshake[k].from === mine) {
          sessionSend(P, s, p.handshake[k].msg, `handshake step ${k + 1} of ${p.handshake.length}`, { step: k });
          k++;
        }
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

const service: Behaviour = {
  refresh(P, s) {
    const p = s.profile;
    const sender = p.fromServer ? !s.initiator : s.initiator;
    if (!sender) return;
    s.x.detail = `${p.request} every ${P.timer(s, p, 'hello').text}${p.id === 'snmp' ? ', timeout ' + P.paramText(P.param('snmp-timeout', s.dev)) : ''}`;
  },
  start(P, s) {
    const p = s.profile;
    // requests come from the clients (from the server for SNMP)
    const sender = p.fromServer ? !s.initiator : s.initiator;
    if (!sender) return;
    service.refresh!(P, s);
    const tcp = /^TCP/.test(p.proto) && p.id !== 'radius';
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
      if (p.id === 'dhcp') {
        P.unicast(s, 'DHCPDISCOVER', 'the client looks for a server (relayed unicast to it)');
        return;
      }
      if (tcp && !s.x.open) {
        P.unicast(s, 'TCP SYN', `to the server${p.id === 'https' ? ' port 443' : ''}`);
        return;
      }
      P.unicast(s, p.request as string, p.messages[0].does);
    });
  },
  rx(P, s, msg) {
    const p = s.profile;
    switch (msg.type) {
      case 'TCP SYN':
        P.unicast(s, 'TCP SYN-ACK', 'accepts');
        return;
      case 'TCP SYN-ACK':
        P.unicast(s, 'TCP ACK', 'connection open');
        if (p.id === 'https') P.unicast(s, 'TLS ClientHello', 'cipher suites, key share');
        else {
          s.x.open = true;
          P.unicast(s, p.request as string, p.messages[0].does);
        }
        return;
      case 'TLS ClientHello':
        P.unicast(s, 'TLS ServerHello', 'certificate, key share, Finished');
        return;
      case 'TLS ServerHello':
        s.x.open = true;
        P.setState(s, 'Answered', true, 'TLS session established');
        P.unicast(s, p.request as string, p.messages[0].does);
        return;
      case 'DHCPDISCOVER':
        P.unicast(s, 'DHCPOFFER', 'an address and lease');
        return;
      case 'DHCPOFFER':
        P.unicast(s, 'DHCPREQUEST', 'takes the offered address');
        return;
      case 'DHCPREQUEST':
        P.unicast(s, 'DHCPACK', 'the lease is confirmed');
        return;
      case 'DHCPACK':
        P.setState(s, 'Bound', true, 'lease confirmed');
        return;
      default:
        if (msg.type === p.request && p.response) {
          // the server answers after its response time (its simulation attribute)
          const rt = P.param('service-response', s.dev);
          const answer = (): void => {
            P.unicast(s, p.response as string, Number(rt.value) > 0 ? `the answer (after the response time ${P.paramText(rt)})` : 'the answer');
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

const data: Behaviour = {
  start(P, s) {
    if (s.rel.direction === 'unidirectional' && !s.initiator) return;
    const iv = P.timer(s, s.profile, 'hello');
    s.x.detail = `${s.profile.dataMsg} every ${iv.text} (demonstration)`;
    every(P, s, () => iv.ms, () => P.unicast(s, s.profile.dataMsg as string, `encapsulated (${s.profile.proto}) between ${formatAddr(s.local.addr)} and ${formatAddr(s.remote.addr)}`));
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

/** The RP of the any-source groups (multicast.ts decides it), null: none. */
function rpOf(P: ProtocolSim): { dev: string; addr: IpAddr } | null {
  const m = P.shared.get('multicast') as { rp(): { dev: string; addr: IpAddr } | null } | undefined;
  return m ? m.rp() : null;
}

const pim: Behaviour = {
  start(P, s) {
    const key = `pim-hello|${s.rel.id}|${s.dev}|${s.local.l3.id}`;
    if (P.shared.has(key)) return;
    P.shared.set(key, true);
    const group = addr(s.local.addr.version === 4 ? '224.0.0.13' : 'ff02::d');
    P.periodic(
      () => true,
      () => P.timer(s, s.profile, 'hello').ms,
      () => {
        if (P.e.isL3Up(s.dev, s.local.l3.id)) P.multicast(s, group, 'Hello', `holdtime ${P.timer(s, s.profile, 'dead').text}, DR priority ${P.paramText(P.param('pim-dr-priority', s.dev))}`);
      },
    );
    // the RP announces itself (BSR) every bootstrap period
    const rp = rpOf(P);
    const bkey = 'pim-bsr|' + s.dev;
    if (rp && rp.dev === s.dev && !P.shared.has(bkey)) {
      P.shared.set(bkey, 0);
      P.periodic(
        () => true,
        () => P.timer(s, s.profile, 'bsr').ms,
        () => {
          const seq = ((P.shared.get(bkey) as number) || 0) + 1;
          P.shared.set(bkey, seq);
          for (const o of Array.from(P.sessions.values()).filter((x) => x.protocol === 'pim' && x.dev === s.dev && x.up).sort((a, b) => (a.key < b.key ? -1 : 1))) {
            P.unicast(o, 'Bootstrap', `the RP for 224.0.0.0/4 is ${formatAddr(rp.addr)} (${rp.dev})`, { bsr: seq, origin: s.dev });
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
        deadCheck(P, s, dead.ms, () => {
          P.restart(s);
          P.setState(s, 'No neighbour', false, `holdtime expired (${dead.text})`);
        });
        if (!s.up) P.setState(s, 'Neighbour', true, `Hello from ${s.peer}`);
        return;
      }
      case 'Bootstrap': {
        const key = `pim-bsr-seen|${s.dev}|${d.origin}|${d.bsr}`;
        if (P.shared.has(key)) return;
        P.shared.set(key, true);
        for (const o of Array.from(P.sessions.values()).filter((x) => x.protocol === 'pim' && x.dev === s.dev && x.up && x.peer !== s.peer && x.peer !== d.origin)) P.unicast(o, 'Bootstrap', 'forwarded on', { bsr: d.bsr, origin: d.origin });
        return;
      }
      default:
        return;
    }
  },
};

// ------------------------------------------------------------------ LACP

/** LACP on every aggregate's member links: LACPDUs both ways, members attached, collecting and distributing; a member whose link goes down is detached at once. */
export function installLacp(P: ProtocolSim): void {
  type Mem = { dev: string; agg: string; port: string; peer: string; peerPort: string; state: string; heard: number; gen: number; rel?: Relation };
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
        mems.push({ dev: d.id, agg: i.id, port, peer: o.device, peerPort: o.port, state: 'Detached', heard: -1, gen: 0, rel });
      }
    }
  }
  if (!mems.length) return;
  // the LACP rate of the member's device: slow (30 s, timeout 90 s) or fast (1 s, timeout 3 s), IEEE 802.1AX
  const rate = (dev: string): { every: number; timeout: number; text: string } => {
    const r = P.param('lacp-rate', dev);
    const fast = r.value === 'fast';
    return { every: fast ? 1000 : 30000, timeout: fast ? 3000 : 90000, text: P.paramText(r) };
  };
  const set = (m: Mem, st: string, why: string): void => {
    if (m.state === st) return;
    m.state = st;
    P.e.note('state', 'lacp', m.dev, m.peer, st, st, `LACP ${m.dev}:${m.agg} member ${m.port} (to ${m.peer}:${m.peerPort}): ${st}${why ? ' (' + why + ')' : ''}`);
    // only a member that is collecting and distributing carries the aggregate's traffic
    P.e.holdMember(m.dev, m.port, st !== 'Collecting / Distributing');
  };
  const send = (m: Mem, why: string): void => {
    const detail = `LACPDU from ${m.dev}:${m.port} (${m.agg}) to ${LACP_MAC}: actor state ${m.state === 'Collecting / Distributing' ? 'in sync, collecting, distributing' : m.state === 'Attached' ? 'in sync' : 'not in sync'}${why ? '; ' + why : ''}`;
    P.onPort('lacp', m.dev, m.port, LACP_MAC, 'LACPDU', 'LACP LACPDU', detail, { agg: m.agg, state: m.state }, m.peer, m.rel);
  };
  // until LACP bundles a member, the aggregate's traffic waits for it
  for (const m of mems) P.e.holdMember(m.dev, m.port, true, true);
  // the members whose LACPDUs started (at their first link-up): a later link-up restarts them
  const started = new Set<Mem>();
  P.bootHooks.push(() => {
    for (const m of mems) {
      P.whenPortUp(m.dev, m.port, () => {
        started.add(m);
        const g = m.gen;
        P.periodic(
          () => m.gen === g,
          () => rate(m.dev).every,
          () => {
            if (P.e.portUp(m.dev, m.port)) send(m, 'periodic');
          },
        );
      });
    }
  });
  P.handlers.set('lacp', (dev, _l3, msg, _pkt, frame) => {
    const port = ((msg.data || {}) as { port?: string }).port;
    void port;
    const m = mems.find((x) => x.dev === dev && frame && P.e.net.ends.get(portKey(dev, x.port)) && x.peer === ((msg.data || {}) as { from?: string }).from && x.peerPort === ((msg.data || {}) as { port?: string }).port);
    if (!m) return;
    m.heard = P.e.now;
    const g = m.gen;
    const timeout = rate(m.dev).timeout;
    P.e.after(timeout, () => {
      if (m.gen === g && P.e.now - m.heard >= timeout - 1 && m.state !== 'Detached') set(m, 'Detached', `no LACPDU for ${fmtSec(timeout)} (LACP rate ${rate(m.dev).text})`);
    });
    const theirs = ((msg.data || {}) as { state?: string }).state || 'Detached';
    if (m.state === 'Detached') {
      set(m, 'Attached', `partner ${m.peer}:${m.peerPort}`);
      send(m, 'answers the partner');
    } else if (m.state === 'Attached' && theirs !== 'Detached') {
      set(m, 'Collecting / Distributing', 'partner in sync');
      send(m, 'in sync');
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
        const g = m.gen;
        P.periodic(
          () => m.gen === g,
          () => rate(m.dev).every,
          () => send(m, 'link up again'),
          200,
        );
      }
    }
  });
  P.extraStatus.push((): SessionStatus[] => mems.map((m) => ({ protocol: 'lacp', name: `${m.dev}:${m.agg} member ${m.port} → ${m.peer}:${m.peerPort}`, device: m.dev, peer: m.peer, state: m.state, detail: `LACPDU every ${fmtSec(rate(m.dev).every)}, timeout ${fmtSec(rate(m.dev).timeout)} (LACP rate ${rate(m.dev).text})`, up: m.state === 'Collecting / Distributing', relation: m.rel ? m.rel.id : undefined })));
}

// ------------------------------------------------------------------ STP, LLDP, CDP (where the model has their relations)

export function installL2Adverts(P: ProtocolSim): void {
  const STP_MAC = '01:80:c2:00:00:00';
  for (const r of P.m.relations.slice().sort((a, b) => cmp(a.id, b.id))) {
    const base = P.e.base(r);
    if (['stp', 'lldp', 'cdp'].indexOf(base) < 0) continue;
    const p = simProfile(base);
    if (!p) continue;
    const devs = relationDevices(r);
    // the cables between two of its devices: each end sends on its port
    type Port = { dev: string; port: string; peer: string; peerPort: string; heard: number; known: boolean };
    const ports: Port[] = [];
    for (const l of P.m.links) {
      if (devs.indexOf(l.a.device) < 0 || devs.indexOf(l.b.device) < 0 || l.a.device === l.b.device) continue;
      ports.push({ dev: l.a.device, port: l.a.iface || '@' + l.id, peer: l.b.device, peerPort: l.b.iface || '@' + l.id, heard: -1, known: false });
      ports.push({ dev: l.b.device, port: l.b.iface || '@' + l.id, peer: l.a.device, peerPort: l.a.iface || '@' + l.id, heard: -1, known: false });
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
                const root = stpRoot(P);
                P.onPort('stp', x.dev, x.port, mac, 'BPDU', `${P.param('stp-mode', x.dev).value === 'stp' ? 'STP' : 'RSTP'} BPDU`, `${P.param('stp-mode', x.dev).value === 'stp' ? 'Configuration BPDU (802.1D)' : 'RST BPDU (802.1w)'} from ${x.dev}:${x.port}: root ${root || '?'}, bridge ${sd.bridgeId || x.dev}, hello ${fmtSec(helloOf(x.dev))}`, {}, x.peer, r);
              }
            } else P.onPort(base, x.dev, x.port, mac, p.messages[0].name, `${p.label} ${p.messages[0].name}`, `${p.messages[0].name} from ${x.dev}:${x.port}: system ${x.dev}, port ${x.port}, TTL ${fmtSec(ttl)}`, {}, x.peer, r);
          }
        };
        P.whenPortUp(x.dev, x.port, () => P.periodic(() => true, () => helloOf(x.dev), tick));
      }
    });
    P.handlers.set(base, (dev, _l3, msg) => {
      const from = ((msg.data || {}) as { from?: string; port?: string });
      const x = ports.find((q) => q.dev === dev && q.peer === from.from && q.peerPort === from.port);
      if (!x) return;
      x.heard = P.e.now;
      if (!x.known && base !== 'stp') {
        x.known = true;
        P.e.note('state', base, dev, x.peer, 'neighbour known', 'neighbour known', `${p.label} on ${dev}:${x.port}: neighbour ${x.peer} port ${x.peerPort}`);
      }
      P.e.after(ttl, () => {
        if (x.known && P.e.now - x.heard >= ttl - 1) {
          x.known = false;
          P.e.note('state', base, dev, x.peer, 'neighbour aged out', 'no neighbour', `${p.label} on ${dev}:${x.port}: ${x.peer} aged out after ${fmtSec(ttl)}`);
        }
      });
    });
    P.extraStatus.push((): SessionStatus[] =>
      base === 'stp'
        ? devs.filter((d) => P.sd(d) && P.sd(d).bridge).map((d) => ({ protocol: 'stp', name: `${r.id}: ${d}`, device: d, peer: '', state: stpRoot(P) === (P.sd(d).bridgeId || d) ? 'Root bridge' : 'Forwarding', detail: `bridge ${P.sd(d).bridgeId}; blocked: ${stpBlockedPorts(P, d).join(', ') || 'none'}`, up: true, relation: r.id }))
        : ports.map((x) => ({ protocol: base, name: `${x.dev}:${x.port} → ${x.peer}:${x.peerPort}`, device: x.dev, peer: x.peer, state: x.known ? 'neighbour known' : 'no neighbour', detail: `every ${fmtSec(hello)}, TTL ${fmtSec(ttl)}`, up: x.known, relation: r.id })),
    );
  }
}

function stpRoot(P: ProtocolSim): string {
  const v = P.e.net.vlans.length ? P.e.net.vlans[0] : 0;
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
        for (const a of l3.addrs) P.e.at(P.e.jitter(), () => P.e.gratuitous(d.id, l3, a.addr, l3.mac, `${l3.id} came up`));
      }
    }
  });
}

/** The model's demands: data packets from the source to the destination, at a rate that grows with the bandwidth; delivered or lost. */
export function installDemands(P: ProtocolSim): void {
  type D = { id: string; label: string; dev: string; src: IpAddr; dst: IpAddr; every: number; sent: number; got: number; last: number; multicast: boolean };
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
    list.push({ id: dm.id, label: dm.label || dm.id, dev, src: srcAddr, dst: dstAddr, every: ms, sent: 0, got: 0, last: -1, multicast: isMulticastIp(dstAddr) });
  }
  if (!list.length) return;
  P.bootHooks.push(() => {
    for (const x of list) {
      const tick = (): void => {
        x.sent++;
        const msg: Msg = { protocol: 'demand', type: 'Data', label: `Data ${x.label}`, detail: `demand ${x.id} (${x.label}): data packet ${x.sent} from ${x.dev} (${formatAddr(x.src)}) to ${formatAddr(x.dst)}`, data: { from: x.dev, demand: x.id, n: x.sent, source: formatAddr(x.src) } };
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
      P.e.at(DATA_START + P.e.jitter(), tick);
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
      return { protocol: 'demand', name: `${x.id}: ${x.dev} → ${formatAddr(x.dst)}`, device: x.dev, peer: '', state: x.multicast ? 'multicast' : x.got && P.e.now - x.last < 3 * x.every + 3000 ? 'Delivered' : x.sent ? 'Lost' : 'Waiting', detail: `${x.got} of ${x.sent} packets delivered${lost > 0 ? ` (${lost} lost or on their way)` : ''}; one every ${fmtSec(x.every)}`, up: x.multicast || (x.got > 0 && P.e.now - x.last < 3 * x.every + 3000) };
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
        feeds.push({ rel: r, protocol: prof.id, label: prof.label, from: a, port: from.iface || '@' + l.id, to: b, toPort: to.iface || '@' + l.id, sent: 0, got: 0 });
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

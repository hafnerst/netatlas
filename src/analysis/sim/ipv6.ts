/**
 * IPv6 host configuration in the simulation (model/ipv6.ts): link-local
 * addresses, router discovery (RFC 4861), stateless address
 * autoconfiguration with duplicate address detection (RFC 4862), DNS
 * servers in router advertisements (RDNSS, RFC 8106), and DHCPv6
 * (RFC 8415) stateful and stateless, all by modeled message exchanges.
 *
 * Interfaces: a host interface with an automatic method (slaac, dhcpv6,
 * slaac_dhcpv6) and a router interface with `ipv6_ra` get a link-local
 * address (fe80::/64 and the interface identifier from the MAC, modified
 * EUI-64): tentative until duplicate address detection passes (after a
 * random delay up to 1 s, one Neighbor Solicitation from :: to the
 * address's solicited-node group, then RetransTimer, 1 s; an answer, or
 * another node probing the same address, makes it a duplicate and the
 * interface's IPv6 stops, RFC 4862 §5.4.5). Interfaces with static IPv6
 * addresses only get a link-local address too (RFC 4291 §2.1). Every
 * written global IPv6 address of an interface (not a loopback's or a
 * tunnel's) runs the same detection when its interface comes up: tentative
 * meanwhile — not a source, not answered for, no packet taken for it — and
 * a duplicate is never used (RFC 4862 §5.4.5). Validation reports
 * duplicate written addresses in the model; the detection is what the
 * running network finds once the segments are connected.
 *
 * Router side: once its link-local address is valid, an advertising
 * interface sends Router Advertisements to ff02::1: its first three at
 * most MAX_INITIAL_RTR_ADVERT_INTERVAL (16 s) apart, then every interval
 * between MinRtrAdvInterval and MaxRtrAdvInterval (deterministic: the
 * simulation's own sequence); a Router Solicitation is answered after a
 * delay up to MAX_RA_DELAY_TIME (0.5 s), never less than
 * MIN_DELAY_BETWEEN_RAS (3 s) after its last advertisement. It advertises
 * only what is written: its router lifetime, the managed and other flags,
 * each prefix (on-link; autonomous unless set off) with its lifetimes, and
 * its DNS servers.
 *
 * Host side: once its link-local address is valid, an automatic interface
 * sends up to three Router Solicitations 4 s apart until an advertisement
 * comes. Each advertisement: its router a default router for its
 * lifetime (0: no longer one), each on-link prefix a connected network for
 * its valid lifetime, each autonomous /64 an address (SLAAC: prefix and
 * interface identifier, tentative until DAD passes, preferred until its
 * preferred lifetime, then deprecated, removed at its valid lifetime; a
 * later advertisement refreshes the lifetimes, by RFC 4862 §5.5.3 e's
 * two-hour rule), its DNS servers for their lifetime. With slaac and the
 * other-configuration flag it asks DHCPv6 for its information (stateless:
 * Information-request, Reply; refreshed after the information refresh time).
 * With dhcpv6 it asks a DHCPv6 server for an address (Solicit, Advertise,
 * Request, Reply), whatever the managed flag says; the address (a /128)
 * is tentative until DAD passes; it renews at T1 (Renew to the server),
 * rebinds at T2 (Rebind to any server), and loses it at its valid lifetime
 * (then solicits again). DHCPv6 gives no default router: it comes from the
 * advertisements. Several routers: the default route goes to the one with
 * the lowest link-local address (a simplification of RFC 4861 §6.3.6's
 * selection); every advertised prefix gets its address.
 *
 * Interface down (a failure, shut, the device off): what it learned is
 * gone at once (addresses, routers, DNS servers, DHCPv6 bindings) and its
 * timers do nothing any more; up again, it starts over. Address
 * selection: preferred addresses before deprecated ones (RFC 6724 rule 3),
 * written ones first. Not modelled: prefix delegation, DHCPv6 relay
 * agents (a server must be on the client's link), temporary and stable
 * privacy addresses (RFC 8981 / RFC 7217: the simulation forms its
 * identifiers from the MAC, deterministically), route information and
 * router preference options, DHCPv6 Decline and Release, MTU options.
 */
import { IpAddr, parseAddress, parsePrefix } from '../../model/ip';
import { DHCP6, NDP_CONSTANTS as N, RA_DEFAULTS, RaConfig, autoIpv6, raDnsLifetime, raInterval, raRouterLifetime, Ipv6Method } from '../../model/ipv6';
import { DEFAULT_LEASE, inRange } from '../../model/netservices';
import { deviceInterfaces } from '../../model/types';
import { compareAddr, formatAddr, inPrefix, networkOf, prefixText } from '../ipmath';
import { Connected, RibEntry } from '../routing';
import type { SnapAddr } from '../snapshot';
import { hashIndex } from './engine';
import { L3Iface, SimAddr } from './net';
import { durationText } from './params';
import { ProtocolSim } from './protocols';
import { GridTable, Msg, Pkt } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ALL_NODES = parseAddress('ff02::1') as IpAddr;
const ALL_ROUTERS = parseAddress('ff02::2') as IpAddr;
const DHCP_GROUP = parseAddress(DHCP6.GROUP) as IpAddr;
const UNSPEC = parseAddress('::') as IpAddr;

type AddrState = 'tentative' | 'preferred' | 'deprecated' | 'duplicate';

interface V6Addr {
  sa: SimAddr;
  kind: 'link-local' | 'slaac' | 'dhcpv6' | 'static';
  state: AddrState;
  preferredUntil: number;
  validUntil: number;
  /** the router (or DHCPv6 server) it came from */
  from?: string;
  gen: number;
}

interface Router6 {
  addr: IpAddr;
  dev: string;
  until: number;
  managed: boolean;
  other: boolean;
}

interface D6Client {
  state: 'SOLICIT' | 'REQUEST' | 'BOUND' | 'RENEW' | 'REBIND' | 'INFO' | 'INFORMED';
  xid: number;
  rt: number;
  tries: number;
  gen: number;
  server?: string;
  serverAddr?: IpAddr;
  offer?: { addr: IpAddr; preferred: number; valid: number; dns: IpAddr[]; domain?: string };
  addr?: V6Addr;
  t1?: number;
  t2?: number;
  since: number;
  failed?: string;
}

interface HostIf {
  dev: string;
  iface: string;
  method: Ipv6Method;
  l3: L3Iface;
  ll?: V6Addr;
  /** its written global addresses and their detection */
  statics: V6Addr[];
  addrs: V6Addr[];
  routers: Map<string, Router6>;
  onlink: Map<string, { net: IpAddr & { prefix: number }; until: number }>;
  dns: Map<string, { addr: IpAddr; until: number; source: string }>;
  rs: number;
  gen: number;
  ra: boolean;
  dhcp?: D6Client;
  info?: D6Client;
  disabled?: string;
}

interface RouterIf {
  dev: string;
  iface: string;
  l3: L3Iface;
  ra: RaConfig;
  ll?: V6Addr;
  statics: V6Addr[];
  sent: number;
  last: number;
  gen: number;
  answering: boolean;
}

/** An interface with static IPv6 addresses only (no automatic method, no advertisements): its IPv6 is on, with a link-local address of its own. */
interface PlainIf {
  dev: string;
  iface: string;
  l3: L3Iface;
  ll?: V6Addr;
  statics: V6Addr[];
  gen: number;
  disabled?: string;
}

interface Scope6 {
  dev: string;
  index: number;
  net: IpAddr & { prefix: number };
  start?: IpAddr;
  end?: IpAddr;
  dns: IpAddr[];
  domain?: string;
  lease: number;
  exclude: Set<string>;
  leases: Map<string, { addr: IpAddr; duid: string; client: string; state: 'offered' | 'bound'; expires: number }>;
}

/** The modified EUI-64 interface identifier of a MAC (RFC 4291 Appendix A): the simulation's identifiers, deterministic. */
function eui64(mac: string): number[] {
  const b = mac.split(':').map((x) => parseInt(x, 16) || 0);
  return [b[0] ^ 0x02, b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]];
}

function addrIn(prefix: number[], mac: string): IpAddr {
  return { version: 6, bytes: prefix.slice(0, 8).concat(eui64(mac)) };
}

function simAddr(a: IpAddr, prefix: number): SimAddr {
  return { addr: a, net: { ...networkOf({ version: 6, bytes: a.bytes, prefix }) }, text: `${formatAddr(a)}/${prefix}` };
}

const left = (ms: number): string => (ms === Infinity ? 'infinite' : durationText(Math.max(0, ms)));

export class Ipv6Sim {
  readonly hosts = new Map<string, HostIf>();
  readonly routers = new Map<string, RouterIf>();
  /** interfaces with static IPv6 addresses only */
  readonly plain = new Map<string, PlainIf>();
  private scopes: Scope6[] = [];
  private xid = 0;

  constructor(private P: ProtocolSim) {
    for (const d of P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      const sd = P.sd(d.id);
      if (!sd) continue;
      for (const i of deviceInterfaces(d)) {
        const l3 = sd.l3.get(i.id);
        if (!l3) continue;
        const k = d.id + ':' + i.id;
        // its written global IPv6 addresses: each tentative until its duplicate address detection passes (not a loopback's or a tunnel's)
        const statics = (): V6Addr[] => (l3.kind === 'loopback' || l3.kind === 'tunnel' ? [] : l3.addrs.filter((x) => x.addr.version === 6 && !(x.addr.bytes[0] === 0xfe && (x.addr.bytes[1] & 0xc0) === 0x80)).map((sa): V6Addr => ({ sa, kind: 'static', state: 'tentative', preferredUntil: Infinity, validUntil: Infinity, gen: 0 })));
        if (autoIpv6(i.ipv6)) this.hosts.set(k, { dev: d.id, iface: i.id, method: i.ipv6 as Ipv6Method, l3, statics: statics(), addrs: [], routers: new Map(), onlink: new Map(), dns: new Map(), rs: 0, gen: 0, ra: false });
        if (i.ra && sd.caps.l3Forward) this.routers.set(k, { dev: d.id, iface: i.id, l3, ra: i.ra, statics: this.hosts.has(k) ? [] : statics(), sent: 0, last: -Infinity, gen: 0, answering: false });
        // static IPv6 alone enables IPv6 on the interface: its link-local address (RFC 4291 §2.1), no advertisements or autoconfiguration needed
        if (!this.hosts.has(k) && !this.routers.has(k) && l3.kind !== 'loopback' && l3.kind !== 'tunnel' && i.addresses.some((t) => t.indexOf(':') >= 0)) this.plain.set(k, { dev: d.id, iface: i.id, l3, statics: statics(), gen: 0 });
        for (const o of [this.hosts.get(k), this.routers.get(k), this.plain.get(k)]) if (o) for (const a of o.statics) P.e.setUsable(d.id, i.id, a.sa.addr, false);
      }
      d.netServices && d.netServices.dhcp && d.netServices.dhcp.scopes.forEach((s, index) => {
        const n = s.network ? P.m.networks.find((x) => x.id === s.network) : undefined;
        const p = n && n.cidr ? parsePrefix(n.cidr) : null;
        if (!p || p.version !== 6) return;
        this.scopes.push({ dev: d.id, index, net: networkOf(p), start: s.start ? (parseAddress(s.start) as IpAddr) : undefined, end: s.end ? (parseAddress(s.end) as IpAddr) : undefined, dns: s.dns.map((x) => parseAddress(x) as IpAddr), domain: s.domain, lease: s.lease || DEFAULT_LEASE, exclude: new Set(s.exclude), leases: new Map() });
      });
    }
    if (!this.hosts.size && !this.routers.size && !this.plain.size && !this.scopes.length) return;
    const self = this;
    P.e.v6Hook = {
      dadProbe: (dev, l3, target) => self.heardProbe(dev, l3, target),
      unusable: (dev, l3, target) => {
        const x = self.holderOf(dev, l3, target);
        return !!x && (x.a.state === 'tentative' || x.a.state === 'duplicate');
      },
      advert: (dev, l3, target) => self.heardAdvert(dev, l3, target),
      connected: (dev) => self.connected(dev),
      routes: (dev, vrf) => self.routes(dev, vrf),
      addresses: () => self.acquired(),
    };
    P.handlers.set('ndp', (dev, l3, msg, pkt) => (pkt && l3 ? this.ndpIn(dev, l3, msg, pkt) : false));
    P.handlers.set('dhcpv6', (dev, l3, msg, pkt) => {
      if (pkt && l3) this.dhcpIn(dev, l3, msg, pkt);
    });
    P.ifaceHooks.push((dev, l3, up) => {
      const k = dev + ':' + l3.id;
      const h = this.hosts.get(k);
      const r = this.routers.get(k);
      const q = this.plain.get(k);
      if (!up) {
        if (h) this.resetHost(h, 'its interface went down');
        if (r) this.resetRouter(r);
        if (q) this.resetPlain(q);
        return;
      }
      if (h && !h.ll) this.startHost(h, 'its link is up');
      if (r && !r.ll) this.startRouter(r, 'its link is up');
      if (q && !q.ll) this.startPlain(q, 'its link is up');
    });
    P.deviceHooks.push((dev, up) => {
      if (up) return;
      for (const h of this.hosts.values()) if (h.dev === dev) this.resetHost(h, `${dev} was powered off`);
      for (const r of this.routers.values()) if (r.dev === dev) this.resetRouter(r);
      for (const q of this.plain.values()) if (q.dev === dev) {
        this.resetPlain(q);
        q.disabled = undefined;
      }
      for (const s of this.scopes) if (s.dev === dev) s.leases.clear();
    });
    P.bootHooks.push(() => {
      for (const h of this.hosts.values()) if (P.e.isL3Up(h.dev, h.iface)) this.startHost(h, 'it starts');
      for (const r of this.routers.values()) if (P.e.isL3Up(r.dev, r.iface)) this.startRouter(r, 'it starts');
      for (const q of this.plain.values()) if (P.e.isL3Up(q.dev, q.iface)) this.startPlain(q, 'it starts');
    });
  }

  private get e() {
    return this.P.e;
  }

  /** A delay of up to `max` ms, from the simulation's own seeded sequence (reproducible). */
  private delay(key: string, max: number): number {
    return (hashIndex(key, 1000) / 1000) * max;
  }

  /** A timer that does nothing once its owner was reset. */
  private later(owner: { gen: number }, dt: number, fn: () => void): void {
    const g = owner.gen;
    this.e.after(Math.max(0, dt), () => {
      if (owner.gen === g) fn();
    });
  }

  private note(kind: 'state' | 'message' | 'table' | 'drop' | 'note', proto: string, dev: string, peer: string, what: string, state: string, detail: string, msg?: Msg): void {
    this.e.note(kind, proto, dev, peer, what, state, detail, this.e.now, msg);
  }

  // ------------------------------------------------------------ duplicate address detection

  /** Probe an address (DAD), then make it usable: `done` with whether it is (false: a duplicate). */
  private dad(owner: { dev: string; l3: L3Iface; gen: number }, a: V6Addr, first: boolean, done: (ok: boolean) => void): void {
    const wait = first ? this.delay(`${owner.dev}|${owner.l3.id}|dad|${formatAddr(a.sa.addr)}`, N.MAX_RTR_SOLICITATION_DELAY) : 0;
    this.later(owner, wait, () => {
      if (a.state !== 'tentative') return;
      this.e.dadSolicit(owner.dev, owner.l3, a.sa.addr);
      this.later(owner, N.RETRANS_TIMER, () => {
        if (a.state !== 'tentative') return;
        a.state = this.e.now >= a.preferredUntil ? 'deprecated' : 'preferred';
        this.note('table', 'ndp', owner.dev, '', 'DAD passed', a.state, `${owner.dev}:${owner.l3.id}: ${a.sa.text} (${a.kind}) is unique on its link (no answer to its duplicate address detection within ${durationText(N.RETRANS_TIMER)}): it is ${a.state} now`);
        done(true);
      });
    });
  }

  /** Whose tentative address is this (or one it holds)? */
  private holderOf(dev: string, l3: L3Iface, target: IpAddr): { owner: HostIf | RouterIf | PlainIf; a: V6Addr } | null {
    const k = dev + ':' + l3.id;
    const h = this.hosts.get(k);
    if (h) for (const a of (h.ll ? [h.ll] : []).concat(h.statics, h.addrs, h.dhcp && h.dhcp.addr ? [h.dhcp.addr] : [])) if (compareAddr(a.sa.addr, target) === 0) return { owner: h, a };
    const r = this.routers.get(k);
    if (r) for (const a of (r.ll ? [r.ll] : []).concat(r.statics)) if (compareAddr(a.sa.addr, target) === 0) return { owner: r, a };
    const q = this.plain.get(k);
    if (q) for (const a of (q.ll ? [q.ll] : []).concat(q.statics)) if (compareAddr(a.sa.addr, target) === 0) return { owner: q, a };
    return null;
  }

  /** The interface's written global addresses: each probed (as its link-local one), usable once its detection passes. */
  private dadStatics(owner: HostIf | RouterIf | PlainIf): void {
    for (const a of owner.statics) {
      a.state = 'tentative';
      this.e.setUsable(owner.dev, owner.iface, a.sa.addr, false);
      this.note('table', 'ndp', owner.dev, '', 'static address', 'tentative', `${owner.dev}:${owner.iface}: ${a.sa.text} (written) is tentative until duplicate address detection passes: not used, not answered for meanwhile`);
      this.dad(owner, a, true, (ok) => {
        if (ok) this.e.setUsable(owner.dev, owner.iface, a.sa.addr, true);
      });
    }
  }

  /** Its interface went down (or the device off): the written addresses are tentative again (detected anew when it is up). */
  private resetStatics(owner: HostIf | RouterIf | PlainIf): void {
    for (const a of owner.statics) {
      if (a.state === 'duplicate' && !this.e.deviceOn(owner.dev)) a.state = 'tentative';
      if (a.state !== 'duplicate') a.state = 'tentative';
      this.e.setUsable(owner.dev, owner.iface, a.sa.addr, false);
    }
  }

  private heardProbe(dev: string, l3: L3Iface, target: IpAddr): void {
    const x = this.holderOf(dev, l3, target);
    if (x && x.a.state === 'tentative') this.duplicate(x.owner, x.a, 'another node probes the same address (RFC 4862 §5.4.3)');
  }

  private heardAdvert(dev: string, l3: L3Iface, target: IpAddr): void {
    const x = this.holderOf(dev, l3, target);
    if (x && x.a.state === 'tentative') this.duplicate(x.owner, x.a, 'a Neighbor Advertisement says another node has it');
  }

  private duplicate(owner: HostIf | RouterIf | PlainIf, a: V6Addr, why: string): void {
    a.state = 'duplicate';
    this.note('state', 'ndp', owner.dev, '', 'duplicate address', 'duplicate', `${owner.dev}:${owner.l3.id}: ${a.sa.text} is a duplicate (${why}): it is not used${a.kind === 'link-local' ? '; the interface’s IPv6 stops (RFC 4862 §5.4.5: a duplicate link-local address needs a manual fix)' : ''}`);
    if (a.kind === 'static') this.e.setUsable(owner.dev, owner.iface, a.sa.addr, false);
    if (a.kind === 'link-local') {
      if ('method' in owner || !('ra' in owner)) (owner as HostIf | PlainIf).disabled = `duplicate link-local address ${formatAddr(a.sa.addr)}`;
      owner.gen++;
      this.e.setLinkLocal(owner.dev, owner.iface, null);
    }
    if ('method' in owner) this.apply(owner);
  }

  /** An interface's link-local address: one written in the model (fe80::/10), else from its MAC (modified EUI-64). */
  private linkLocal(dev: string, iface: string, mac: string): { a: SimAddr; how: string } {
    const i = this.P.m.index.interfaces.get(dev + ':' + iface);
    for (const t of i ? i.addresses : []) {
      const pp = parsePrefix(t, false);
      if (pp && pp.version === 6 && pp.bytes[0] === 0xfe && (pp.bytes[1] & 0xc0) === 0x80) return { a: simAddr({ version: 6, bytes: pp.bytes.slice() }, 64), how: 'written in the model' };
    }
    return { a: simAddr(addrIn([0xfe, 0x80, 0, 0, 0, 0, 0, 0], mac), 64), how: `from its MAC ${mac}` };
  }

  // ------------------------------------------------------------ interfaces with static IPv6 addresses only

  /** The interface's IPv6 starts: its link-local address, tentative until duplicate address detection passes. */
  private startPlain(q: PlainIf, why: string): void {
    if (!this.e.deviceOn(q.dev) || q.disabled) return;
    q.gen++;
    const ll = this.linkLocal(q.dev, q.iface, q.l3.mac);
    const a: V6Addr = { sa: ll.a, kind: 'link-local', state: 'tentative', preferredUntil: Infinity, validUntil: Infinity, gen: 0 };
    q.ll = a;
    this.note('table', 'ndp', q.dev, '', 'link-local address', 'tentative', `${q.dev}:${q.iface}: link-local address ${a.sa.text} (${ll.how}) is tentative until duplicate address detection passes (${why}; its static IPv6 addresses enable IPv6 on it)`);
    this.dad(q, a, true, (ok) => {
      if (ok) this.e.setLinkLocal(q.dev, q.iface, a.sa);
    });
    this.dadStatics(q);
  }

  private resetPlain(q: PlainIf): void {
    q.gen++;
    q.ll = undefined;
    this.e.setLinkLocal(q.dev, q.iface, null);
    this.resetStatics(q);
  }

  // ------------------------------------------------------------ the router side

  private startRouter(r: RouterIf, why: string): void {
    if (!this.e.deviceOn(r.dev)) return;
    r.gen++;
    r.sent = 0;
    const ll = this.linkLocal(r.dev, r.iface, r.l3.mac);
    const a: V6Addr = { sa: ll.a, kind: 'link-local', state: 'tentative', preferredUntil: Infinity, validUntil: Infinity, gen: 0 };
    r.ll = a;
    this.note('table', 'ndp', r.dev, '', 'link-local address', 'tentative', `${r.dev}:${r.iface}: link-local address ${a.sa.text} (${ll.how}) is tentative until duplicate address detection passes (${why})`);
    this.dad(r, a, true, (ok) => {
      if (!ok) return;
      this.e.setLinkLocal(r.dev, r.iface, a.sa);
      this.advertise(r, 'its first advertisements');
    });
    this.dadStatics(r);
  }

  private resetRouter(r: RouterIf): void {
    r.gen++;
    r.ll = undefined;
    r.answering = false;
    this.e.setLinkLocal(r.dev, r.iface, null);
    this.resetStatics(r);
  }

  /** The interval before the next unsolicited advertisement (the first three at most 16 s apart). */
  private nextInterval(r: RouterIf): number {
    const max = raInterval(r.ra);
    const min = Math.max(3000, RA_DEFAULTS.minFactor * max);
    const iv = min + (hashIndex(`${r.dev}|${r.iface}|ra|${r.sent}`, 1000) / 1000) * (max - min);
    return r.sent < N.MAX_INITIAL_RTR_ADVERTISEMENTS ? Math.min(iv, N.MAX_INITIAL_RTR_ADVERT_INTERVAL) : iv;
  }

  private advertise(r: RouterIf, why: string): void {
    this.sendRa(r, why);
    const loop = (): void => {
      this.later(r, this.nextInterval(r), () => {
        this.sendRa(r, 'its periodic advertisement');
        loop();
      });
    };
    loop();
  }

  private sendRa(r: RouterIf, why: string): void {
    if (!r.ll || !this.e.deviceOn(r.dev) || !this.e.isL3Up(r.dev, r.iface)) return;
    r.sent++;
    r.last = this.e.now;
    const ra = r.ra;
    const valid = ra.validLifetime !== undefined ? ra.validLifetime : RA_DEFAULTS.valid;
    const preferred = ra.preferredLifetime !== undefined ? ra.preferredLifetime : RA_DEFAULTS.preferred;
    const life = raRouterLifetime(ra);
    const prefixes = ra.prefixes.map((p) => ({ prefix: p, onlink: true, autonomous: ra.autonomous, valid, preferred }));
    const data = { router: r.dev, iface: r.iface, lifetime: life, managed: ra.managed, other: ra.other, prefixes, dns: ra.dns, dnsLifetime: raDnsLifetime(ra) };
    const rows: Array<[string, string]> = [
      ['Message', 'Router Advertisement (ICMPv6 134)'],
      ['Router lifetime', life ? durationText(life) : '0 (not a default router)'],
      ['Flags', `M (managed) ${ra.managed ? 'set' : 'clear'}, O (other configuration) ${ra.other ? 'set' : 'clear'}`],
      ...prefixes.map((p): [string, string] => ['Prefix', `${p.prefix}: on-link, ${p.autonomous ? 'autonomous (SLAAC)' : 'not autonomous'}, valid ${durationText(p.valid)}, preferred ${durationText(p.preferred)}`]),
    ];
    if (ra.dns.length) rows.push(['DNS servers (RDNSS)', `${ra.dns.join(', ')}, lifetime ${durationText(raDnsLifetime(ra))}`]);
    const msg: Msg = { protocol: 'ndp', type: 'Router Advertisement', label: 'NDP RA', detail: `Router Advertisement from ${r.dev}:${r.iface} (${formatAddr(r.ll.sa.addr)}) to ff02::1 (${why}): router lifetime ${life ? durationText(life) : '0'}, M ${ra.managed ? 1 : 0}, O ${ra.other ? 1 : 0}; ${prefixes.map((p) => `${p.prefix}${p.autonomous ? ' (A)' : ''}`).join(', ')}${ra.dns.length ? `; DNS ${ra.dns.join(', ')}` : ''}`, data: { ...data, inspect: { title: 'ICMPv6 – Router Advertisement', rows } } };
    const pkt = this.e.newPacket(r.ll.sa.addr, ALL_NODES, r.l3.vrf, msg, [], 255);
    pkt.l4 = { proto: 'icmp', num: 58, icmpType: 134, icmpCode: 0, icmpName: 'Router Advertisement' };
    pkt.len = 16 + 32 * prefixes.length + (ra.dns.length ? 8 + 16 * ra.dns.length : 0);
    this.note('message', 'ndp', r.dev, '', msg.type, '', msg.detail, msg);
    this.e.send(r.dev, pkt, r.l3);
  }

  /** A Router Solicitation: an advertisement after a short delay, never sooner than 3 s after the last one. */
  private solicited(r: RouterIf, from: string): void {
    if (!r.ll || r.answering) return;
    r.answering = true;
    const at = Math.max(this.e.now + this.delay(`${r.dev}|${r.iface}|rs|${this.e.now}`, N.MAX_RA_DELAY_TIME), r.last + N.MIN_DELAY_BETWEEN_RAS);
    this.later(r, at - this.e.now, () => {
      r.answering = false;
      this.sendRa(r, `answering the Router Solicitation of ${from}`);
    });
  }

  // ------------------------------------------------------------ the host side

  private startHost(h: HostIf, why: string): void {
    if (!this.e.deviceOn(h.dev) || h.disabled) return;
    h.gen++;
    h.rs = 0;
    h.ra = false;
    const ll = this.linkLocal(h.dev, h.iface, h.l3.mac);
    const a: V6Addr = { sa: ll.a, kind: 'link-local', state: 'tentative', preferredUntil: Infinity, validUntil: Infinity, gen: 0 };
    h.ll = a;
    this.note('table', 'ndp', h.dev, '', 'link-local address', 'tentative', `${h.dev}:${h.iface}: link-local address ${a.sa.text} (${ll.how}) is tentative until duplicate address detection passes (${why})`);
    this.dad(h, a, true, (ok) => {
      if (!ok) return;
      this.e.setLinkLocal(h.dev, h.iface, a.sa);
      this.solicit(h);
      if (h.method === 'dhcpv6' || h.method === 'slaac_dhcpv6') this.dhcpStart(h, 'its method is ' + h.method);
    });
    this.dadStatics(h);
  }

  private resetHost(h: HostIf, why: string): void {
    const had = h.addrs.length || h.routers.size || h.dns.size || (h.dhcp && h.dhcp.addr);
    h.gen++;
    this.resetStatics(h);
    h.ll = undefined;
    h.addrs = [];
    h.routers.clear();
    h.onlink.clear();
    h.dns.clear();
    h.dhcp = undefined;
    h.info = undefined;
    h.ra = false;
    this.e.setLinkLocal(h.dev, h.iface, null);
    this.e.setV6(h.dev, h.iface, []);
    if (had) this.note('table', 'ndp', h.dev, '', 'IPv6 configuration cleared', 'none', `${h.dev}:${h.iface}: its learned IPv6 addresses, default routers and DNS servers are gone (${why}); it starts over when the interface is up`);
  }

  /** Router Solicitations: up to three, 4 s apart, until an advertisement comes. */
  private solicit(h: HostIf): void {
    if (h.ra || h.rs >= N.MAX_RTR_SOLICITATIONS || !h.ll) return;
    h.rs++;
    const msg: Msg = { protocol: 'ndp', type: 'Router Solicitation', label: 'NDP RS', detail: `Router Solicitation (ICMPv6 133) from ${h.dev}:${h.iface} (${formatAddr(h.ll.sa.addr)}) to ff02::2 (all routers): which routers are on this link? (${h.rs} of ${N.MAX_RTR_SOLICITATIONS})`, data: { from: h.dev, inspect: { title: 'ICMPv6 – Router Solicitation', rows: [['Message', 'Router Solicitation (ICMPv6 133)'], ['Source link-layer address', h.l3.mac], ['Attempt', `${h.rs} of ${N.MAX_RTR_SOLICITATIONS} (RTR_SOLICITATION_INTERVAL ${durationText(N.RTR_SOLICITATION_INTERVAL)})`]] } } };
    const pkt = this.e.newPacket(h.ll.sa.addr, ALL_ROUTERS, h.l3.vrf, msg, [], 255);
    pkt.l4 = { proto: 'icmp', num: 58, icmpType: 133, icmpCode: 0, icmpName: 'Router Solicitation' };
    pkt.len = 16;
    this.note('message', 'ndp', h.dev, '', msg.type, '', msg.detail, msg);
    this.e.send(h.dev, pkt, h.l3);
    this.later(h, N.RTR_SOLICITATION_INTERVAL, () => {
      if (h.ra) return;
      if (h.rs < N.MAX_RTR_SOLICITATIONS) this.solicit(h);
      else this.note('state', 'ndp', h.dev, '', 'no router', 'no router', `${h.dev}:${h.iface} got no Router Advertisement after ${N.MAX_RTR_SOLICITATIONS} solicitations: no default router, no SLAAC address (an advertisement that comes later is still taken)`);
    });
  }

  private ndpIn(dev: string, l3: L3Iface, msg: Msg, pkt: Pkt): boolean {
    const k = dev + ':' + l3.id;
    if (msg.type === 'Router Solicitation') {
      const r = this.routers.get(k);
      if (r) this.solicited(r, (msg.data as { from?: string }).from || formatAddr(pkt.src));
      return true;
    }
    if (msg.type !== 'Router Advertisement') return false;
    const h = this.hosts.get(k);
    if (!h || !h.ll || h.ll.state === 'tentative' || h.disabled) return true;
    this.raIn(h, msg.data as unknown as RaData, pkt.src);
    return true;
  }

  private raIn(h: HostIf, d: RaData, src: IpAddr): void {
    h.ra = true;
    const now = this.e.now;
    const rk = formatAddr(src);
    const changes: string[] = [];
    if (d.lifetime > 0) {
      const had = h.routers.has(rk);
      h.routers.set(rk, { addr: src, dev: d.router, until: now + d.lifetime, managed: d.managed, other: d.other });
      if (!had) changes.push(`default router ${d.router} (${rk}) for ${durationText(d.lifetime)}`);
      this.expireRouter(h, rk);
    } else if (h.routers.delete(rk)) changes.push(`${d.router} (${rk}) is no longer a default router (router lifetime 0)`);
    for (const p of d.prefixes) {
      const pp = parsePrefix(p.prefix, true);
      if (!pp) continue;
      const net = networkOf(pp);
      const key = prefixText(net);
      if (p.onlink) {
        if (p.valid > 0) h.onlink.set(key, { net, until: now + p.valid });
        else h.onlink.delete(key);
      }
      if (!p.autonomous || pp.prefix !== 64 || (h.method !== 'slaac' && h.method !== 'slaac_dhcpv6') || p.preferred > p.valid) continue;
      const ip = addrIn(net.bytes, h.l3.mac);
      const cur = h.addrs.find((x) => compareAddr(x.sa.addr, ip) === 0);
      if (!cur) {
        if (p.valid === 0) continue;
        const a: V6Addr = { sa: simAddr(ip, 64), kind: 'slaac', state: 'tentative', preferredUntil: now + p.preferred, validUntil: now + p.valid, from: d.router, gen: 0 };
        h.addrs.push(a);
        changes.push(`SLAAC address ${a.sa.text} (tentative: duplicate address detection)`);
        this.dad(h, a, false, (ok) => {
          if (ok) this.apply(h);
        });
        this.expireAddr(h, a);
        continue;
      }
      // RFC 4862 §5.5.3 e): the preferred lifetime is set; the valid one too, unless that would cut it below two hours
      cur.preferredUntil = now + p.preferred;
      const remaining = cur.validUntil - now;
      if (p.valid > N.TWO_HOURS || p.valid > remaining) cur.validUntil = now + p.valid;
      else if (remaining > N.TWO_HOURS) cur.validUntil = now + N.TWO_HOURS;
      if (cur.state === 'deprecated' && now < cur.preferredUntil) cur.state = 'preferred';
      this.expireAddr(h, cur);
    }
    if (d.dns.length) {
      for (const t of d.dns) {
        const a = parseAddress(t) as IpAddr;
        if (d.dnsLifetime > 0) {
          if (!h.dns.has(t)) changes.push(`DNS server ${t} (RDNSS) for ${durationText(d.dnsLifetime)}`);
          h.dns.set(t, { addr: a, until: now + d.dnsLifetime, source: `RDNSS from ${d.router}` });
        } else h.dns.delete(t);
      }
      this.expireDns(h);
    }
    if (changes.length) this.note('table', 'ndp', h.dev, d.router, 'router advertisement', '', `${h.dev}:${h.iface} takes the Router Advertisement of ${d.router}: ${changes.join('; ')}`);
    // stateless DHCPv6: a SLAAC host asks for its other configuration when the router says so
    if (d.other && h.method === 'slaac' && !h.info) this.infoStart(h, `${d.router} sets the other-configuration flag`);
    if (d.managed && h.method === 'slaac') this.note('note', 'ndp', h.dev, d.router, 'managed flag', '', `${h.dev}:${h.iface}: ${d.router} sets the managed flag (addresses by DHCPv6), but its method is slaac: it asks DHCPv6 for no address (choose dhcpv6 or slaac_dhcpv6 for that)`);
    this.apply(h);
  }

  private expireRouter(h: HostIf, rk: string): void {
    const r = h.routers.get(rk);
    if (!r) return;
    const until = r.until;
    this.later(h, until - this.e.now, () => {
      const x = h.routers.get(rk);
      if (!x || x.until !== until) return;
      h.routers.delete(rk);
      this.note('state', 'ndp', h.dev, x.dev, 'router expired', h.routers.size ? '' : 'no default router', `${h.dev}:${h.iface}: ${x.dev} (${rk}) is no longer a default router: no advertisement within its router lifetime${h.routers.size ? '' : ' — no default router left'}`);
      this.apply(h);
    });
  }

  private expireAddr(h: HostIf, a: V6Addr): void {
    const g = ++a.gen;
    const pu = a.preferredUntil;
    if (pu > this.e.now && pu !== Infinity)
      this.later(h, pu - this.e.now, () => {
        if (a.gen !== g || a.state !== 'preferred') return;
        a.state = 'deprecated';
        this.note('table', 'ndp', h.dev, '', 'address deprecated', 'deprecated', `${h.dev}:${h.iface}: ${a.sa.text} (${a.kind}) is deprecated (its preferred lifetime ended): kept for what uses it, not chosen for new connections`);
        this.apply(h);
      });
    if (a.validUntil !== Infinity)
      this.later(h, a.validUntil - this.e.now, () => {
        if (a.gen !== g) return;
        h.addrs = h.addrs.filter((x) => x !== a);
        this.note('table', 'ndp', h.dev, '', 'address expired', 'expired', `${h.dev}:${h.iface}: ${a.sa.text} (${a.kind}) is gone (its valid lifetime ended)`);
        this.apply(h);
      });
  }

  private expireDns(h: HostIf): void {
    const soon = Math.min(...Array.from(h.dns.values()).map((x) => x.until));
    if (!isFinite(soon)) return;
    this.later(h, soon - this.e.now, () => {
      for (const [k, x] of Array.from(h.dns)) if (x.until <= this.e.now) {
        h.dns.delete(k);
        this.note('table', 'ndp', h.dev, '', 'DNS server expired', '', `${h.dev}:${h.iface}: the DNS server ${k} (${x.source}) is gone (its lifetime ended)`);
      }
      this.expireDns(h);
    });
  }

  /** The interface's usable learned addresses go to the engine: preferred first, then deprecated. */
  private apply(h: HostIf): void {
    const mine = h.addrs.concat(h.dhcp && h.dhcp.addr ? [h.dhcp.addr] : []);
    const usable = mine.filter((a) => a.state === 'preferred').concat(mine.filter((a) => a.state === 'deprecated'));
    this.e.setV6(h.dev, h.iface, usable.map((a) => a.sa));
    this.e.stateVersion++;
  }

  /** Every address the hosts acquired, with its kind and state (an analysis snapshot's; see analysis/snapshot.ts). */
  private acquired(): SnapAddr[] {
    const out: SnapAddr[] = [];
    const owners: Array<{ dev: string; iface: string; l3: L3Iface; ll?: V6Addr; addrs: V6Addr[] }> = Array.from(this.hosts.values());
    for (const r of this.routers.values()) owners.push({ dev: r.dev, iface: r.iface, l3: r.l3, ll: r.ll, addrs: [] });
    for (const q of this.plain.values()) owners.push({ dev: q.dev, iface: q.iface, l3: q.l3, ll: q.ll, addrs: [] });
    for (const h of owners) {
      for (const a of (h.ll ? [h.ll] : []).concat(h.addrs)) {
        const s: SnapAddr = {
          device: h.dev,
          iface: h.iface,
          vrf: h.l3.vrf,
          address: a.sa.text,
          text: formatAddr(a.sa.addr),
          version: 6,
          method: a.kind === 'link-local' ? 'link-local' : a.kind,
          state: a.state,
        };
        if (a.from) s.from = a.from;
        if (isFinite(a.validUntil)) s.validUntil = a.validUntil;
        out.push(s);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ routing

  private connected(dev: string): Connected[] {
    const out: Connected[] = [];
    for (const h of this.hosts.values()) {
      if (h.dev !== dev) continue;
      for (const o of h.onlink.values()) {
        const own = h.l3.addrs.find((a) => a.addr.version === 6 && inPrefix(o.net, a.addr));
        if (own) out.push({ device: dev, iface: h.iface, vrf: h.l3.vrf, net: { ...o.net }, addr: own.addr, address: own.text });
      }
    }
    return out;
  }

  private routes(dev: string, vrf: string): RibEntry[] {
    const out: RibEntry[] = [];
    for (const h of this.hosts.values()) {
      if (h.dev !== dev || h.l3.vrf !== vrf || !h.routers.size) continue;
      // the default router: the one with the lowest link-local address (one route: no load sharing between routers)
      const r = Array.from(h.routers.values()).sort((x, y) => compareAddr(x.addr, y.addr))[0];
      out.push({ kind: 'static', device: dev, vrf, net: { version: 6, bytes: new Array(16).fill(0), prefix: 0 }, distance: 254, metric: 0, iface: h.iface, via: r.addr, blackhole: false, implicit: `default route via ${r.dev} (${formatAddr(r.addr)}), learned from its router advertisements` } as RibEntry);
    }
    return out;
  }

  /** The DNS servers a host learned (RDNSS, DHCPv6), for its resolver. */
  dnsServers(dev: string): IpAddr[] {
    const out: IpAddr[] = [];
    for (const h of this.hosts.values()) {
      if (h.dev !== dev) continue;
      for (const x of h.dns.values()) if (!out.some((y) => compareAddr(y, x.addr) === 0)) out.push(x.addr);
    }
    return out;
  }

  // ------------------------------------------------------------ DHCPv6: the client

  private duid(mac: string): string {
    return `DUID-LL ${mac}`;
  }

  private dhcpStart(h: HostIf, why: string): void {
    h.dhcp = { state: 'SOLICIT', xid: 0, rt: DHCP6.SOL_TIMEOUT, tries: 0, gen: 0, since: this.e.now };
    this.later(h, this.delay(`${h.dev}|${h.iface}|sol`, DHCP6.SOL_MAX_DELAY), () => this.solicitDhcp(h, why));
  }

  private infoStart(h: HostIf, why: string): void {
    h.info = { state: 'INFO', xid: 0, rt: DHCP6.INF_TIMEOUT, tries: 0, gen: 0, since: this.e.now };
    this.later(h, this.delay(`${h.dev}|${h.iface}|inf`, DHCP6.INF_MAX_DELAY), () => this.infoRequest(h, why));
  }

  private send6(h: HostIf, type: string, detail: string, data: { [k: string]: unknown }, rows: Array<[string, string]>): void {
    if (!h.ll || h.ll.state === 'tentative') return;
    const msg: Msg = { protocol: 'dhcpv6', type, label: `DHCPv6 ${type}`, detail, data: { from: h.dev, iface: h.iface, ...data, inspect: { title: 'Application – DHCPv6', rows: [['Message', type], ...rows] } } };
    const pkt = this.e.newPacket(h.ll.sa.addr, DHCP_GROUP, h.l3.vrf, msg, [], 1);
    pkt.l4 = { proto: 'udp', num: 17, sport: DHCP6.CLIENT_PORT, dport: DHCP6.SERVER_PORT };
    pkt.len = 8 + 60;
    this.note('message', 'dhcpv6', h.dev, '', type, '', detail, msg);
    this.e.send(h.dev, pkt, h.l3);
  }

  private solicitDhcp(h: HostIf, why: string): void {
    const c = h.dhcp;
    if (!c || c.state !== 'SOLICIT') return;
    c.tries++;
    c.xid = ++this.xid;
    this.send6(h, 'Solicit', `DHCPv6 Solicit from ${h.dev}:${h.iface} (${this.duid(h.l3.mac)}, IA_NA) to ff02::1:2: which server gives me an address? (${c.tries === 1 ? why : 'attempt ' + c.tries})`, { xid: c.xid, duid: this.duid(h.l3.mac), iana: true }, [['Transaction id', String(c.xid)], ['Client identifier', this.duid(h.l3.mac)], ['Options', 'IA_NA (an address), DNS servers (ORO)']]);
    const g = c.gen;
    this.later(h, c.rt, () => {
      if (c.gen !== g || c.state !== 'SOLICIT' || h.dhcp !== c) return;
      if (!c.offer) {
        c.failed = `no DHCPv6 server answered ${c.tries} Solicit${c.tries === 1 ? '' : 's'}`;
        if (c.tries === 3) this.note('state', 'dhcpv6', h.dev, '', 'no DHCPv6 server', 'DHCPv6 pending', `${h.dev}:${h.iface}: ${c.failed}; it goes on soliciting (backing off up to ${durationText(DHCP6.SOL_MAX_RT)})`);
        c.rt = Math.min(DHCP6.SOL_MAX_RT, c.rt * 2);
        this.solicitDhcp(h, '');
      }
    });
  }

  private infoRequest(h: HostIf, why: string): void {
    const c = h.info;
    if (!c || c.state !== 'INFO') return;
    c.tries++;
    c.xid = ++this.xid;
    this.send6(h, 'Information-request', `DHCPv6 Information-request from ${h.dev}:${h.iface} to ff02::1:2: its other configuration (DNS servers), no address (stateless; ${c.tries === 1 ? why : 'attempt ' + c.tries})`, { xid: c.xid, duid: this.duid(h.l3.mac), info: true }, [['Transaction id', String(c.xid)], ['Client identifier', this.duid(h.l3.mac)], ['Options', 'DNS servers (ORO)']]);
    const g = c.gen;
    this.later(h, c.rt, () => {
      if (c.gen !== g || c.state !== 'INFO' || h.info !== c) return;
      c.failed = `no DHCPv6 server answered ${c.tries} Information-request${c.tries === 1 ? '' : 's'}`;
      c.rt = Math.min(DHCP6.INF_MAX_RT, c.rt * 2);
      this.infoRequest(h, '');
    });
  }

  private request(h: HostIf, rebind: 'request' | 'renew' | 'rebind'): void {
    const c = h.dhcp as D6Client;
    c.tries++;
    const o = c.offer as NonNullable<D6Client['offer']>;
    const type = rebind === 'request' ? 'Request' : rebind === 'renew' ? 'Renew' : 'Rebind';
    this.send6(h, type, `DHCPv6 ${type} from ${h.dev}:${h.iface} for ${formatAddr(o.addr)}${rebind === 'rebind' ? ' (to any server, at T2)' : ` (to ${c.server}${rebind === 'renew' ? ', at T1' : ''})`}`, { xid: c.xid, duid: this.duid(h.l3.mac), addr: formatAddr(o.addr), server: rebind === 'rebind' ? undefined : c.server, kind: rebind }, [['Transaction id', String(c.xid)], ['IA_NA address', formatAddr(o.addr)], ['Server identifier', rebind === 'rebind' ? '(none: any server)' : String(c.server)]]);
    const g = c.gen;
    const rt = rebind === 'request' ? DHCP6.REQ_TIMEOUT * Math.pow(2, c.tries - 1) : Math.min(rebind === 'renew' ? DHCP6.REN_MAX_RT : DHCP6.REB_MAX_RT, (rebind === 'renew' ? DHCP6.REN_TIMEOUT : DHCP6.REB_TIMEOUT) * Math.pow(2, c.tries - 1));
    this.later(h, rt, () => {
      if (c.gen !== g || h.dhcp !== c) return;
      if (rebind === 'request' && c.state === 'REQUEST') {
        if (c.tries >= DHCP6.REQ_MAX_RC) {
          c.state = 'SOLICIT';
          c.tries = 0;
          c.offer = undefined;
          c.rt = DHCP6.SOL_TIMEOUT;
          this.solicitDhcp(h, `no Reply to ${DHCP6.REQ_MAX_RC} Requests`);
        } else this.request(h, 'request');
      } else if ((rebind === 'renew' && c.state === 'RENEW') || (rebind === 'rebind' && c.state === 'REBIND')) this.request(h, rebind);
    });
  }

  private clientIn(h: HostIf, msg: Msg, d: D6Data): void {
    const c = msg.type === 'Reply' && d.info ? h.info : h.dhcp;
    if (!c || d.xid !== c.xid) return;
    if (msg.type === 'Advertise' && c.state === 'SOLICIT') {
      if (!d.addr) return;
      c.offer = { addr: parseAddress(d.addr) as IpAddr, preferred: d.preferred as number, valid: d.valid as number, dns: (d.dns || []).map((x) => parseAddress(x) as IpAddr), domain: d.domain };
      c.server = d.serverId;
      c.serverAddr = parseAddress(d.serverAddr as string) as IpAddr;
      c.state = 'REQUEST';
      c.tries = 0;
      c.gen++;
      c.xid = ++this.xid;
      this.request(h, 'request');
      return;
    }
    if (msg.type !== 'Reply') return;
    if (d.info) {
      // stateless: the DNS servers until the information refresh time
      c.state = 'INFORMED';
      c.gen++;
      c.failed = undefined;
      const refresh = d.refresh || DHCP6.IRT_DEFAULT;
      for (const t of d.dns || []) h.dns.set(t, { addr: parseAddress(t) as IpAddr, until: this.e.now + refresh, source: `DHCPv6 from ${d.serverId}` });
      this.note('table', 'dhcpv6', h.dev, d.server || '', 'information', 'informed', `${h.dev}:${h.iface} got its other configuration by stateless DHCPv6 from ${d.server}: DNS ${(d.dns || []).join(', ') || 'none'}${d.domain ? `, domain ${d.domain}` : ''}; refreshed in ${durationText(refresh)}`);
      this.expireDns(h);
      this.later(h, refresh, () => {
        if (h.info !== c) return;
        c.state = 'INFO';
        c.tries = 0;
        c.rt = DHCP6.INF_TIMEOUT;
        this.infoRequest(h, 'the information refresh time is over');
      });
      return;
    }
    if (d.status === 'NoAddrsAvail') {
      c.state = 'SOLICIT';
      c.gen++;
      c.offer = undefined;
      c.failed = `${d.server} has no address left (NoAddrsAvail)`;
      this.note('state', 'dhcpv6', h.dev, d.server || '', 'no address', 'DHCPv6 pending', `${h.dev}:${h.iface}: ${c.failed}; it solicits again`);
      c.rt = DHCP6.SOL_TIMEOUT;
      this.later(h, DHCP6.SOL_TIMEOUT, () => this.solicitDhcp(h, 'after NoAddrsAvail'));
      return;
    }
    if (!d.addr || (c.state !== 'REQUEST' && c.state !== 'RENEW' && c.state !== 'REBIND')) return;
    const ip = parseAddress(d.addr) as IpAddr;
    const was = c.state;
    c.state = 'BOUND';
    c.gen++;
    c.tries = 0;
    c.failed = undefined;
    c.server = d.serverId;
    c.serverAddr = parseAddress(d.serverAddr as string) as IpAddr;
    const now = this.e.now;
    const pref = d.preferred as number;
    const valid = d.valid as number;
    c.t1 = now + DHCP6.T1 * pref;
    c.t2 = now + DHCP6.T2 * pref;
    for (const t of d.dns || []) h.dns.set(t, { addr: parseAddress(t) as IpAddr, until: now + valid, source: `DHCPv6 from ${d.serverId}` });
    this.expireDns(h);
    if (!c.addr || compareAddr(c.addr.sa.addr, ip) !== 0) {
      const a: V6Addr = { sa: simAddr(ip, 128), kind: 'dhcpv6', state: 'tentative', preferredUntil: now + pref, validUntil: now + valid, from: d.server, gen: 0 };
      c.addr = a;
      this.note('table', 'dhcpv6', h.dev, d.server || '', 'DHCPv6 address', 'tentative', `${h.dev}:${h.iface} is bound to ${formatAddr(ip)}/128 by DHCPv6 from ${d.server} (preferred ${durationText(pref)}, valid ${durationText(valid)}; renews at T1 ${durationText(DHCP6.T1 * pref)}, rebinds at T2 ${durationText(DHCP6.T2 * pref)}); tentative until duplicate address detection passes (RFC 8415 §18.2.10.1)`);
      this.dad(h, a, false, (ok) => {
        if (ok) this.apply(h);
      });
    } else {
      c.addr.preferredUntil = now + pref;
      c.addr.validUntil = now + valid;
      if (c.addr.state === 'deprecated') c.addr.state = 'preferred';
      this.note('state', 'dhcpv6', h.dev, d.server || '', was === 'RENEW' ? 'Renewed' : 'Rebound', 'bound', `${h.dev}:${h.iface} ${was === 'RENEW' ? 'renewed' : 'rebound'} ${formatAddr(ip)} with ${d.server} (valid ${durationText(valid)})`);
    }
    this.dhcpTimers(h, c);
    this.apply(h);
  }

  /** T1: Renew; T2: Rebind; the valid lifetime: the address goes and it solicits again. */
  private dhcpTimers(h: HostIf, c: D6Client): void {
    const g = c.gen;
    const a = c.addr as V6Addr;
    this.later(h, (c.t1 as number) - this.e.now, () => {
      if (c.gen !== g || c.state !== 'BOUND') return;
      c.state = 'RENEW';
      c.tries = 0;
      c.xid = ++this.xid;
      this.request(h, 'renew');
    });
    this.later(h, (c.t2 as number) - this.e.now, () => {
      if (h.dhcp !== c || (c.state !== 'RENEW' && c.state !== 'BOUND')) return;
      c.state = 'REBIND';
      c.tries = 0;
      c.gen++;
      c.xid = ++this.xid;
      this.request(h, 'rebind');
      this.lifetimeEnd(h, c, a);
    });
    if (a.preferredUntil > this.e.now)
      this.later(h, a.preferredUntil - this.e.now, () => {
        if (h.dhcp !== c || c.addr !== a || a.state !== 'preferred' || this.e.now < a.preferredUntil) return;
        a.state = 'deprecated';
        this.apply(h);
      });
  }

  private lifetimeEnd(h: HostIf, c: D6Client, a: V6Addr): void {
    const until = a.validUntil;
    this.later(h, until - this.e.now, () => {
      if (h.dhcp !== c || c.addr !== a || a.validUntil !== until || c.state === 'BOUND') return;
      this.note('state', 'dhcpv6', h.dev, '', 'lease expired', 'DHCPv6 pending', `${h.dev}:${h.iface}: the DHCPv6 address ${formatAddr(a.sa.addr)} is gone (its valid lifetime ended without a Renew or Rebind answered): it solicits again`);
      c.addr = undefined;
      c.offer = undefined;
      c.state = 'SOLICIT';
      c.gen++;
      c.tries = 0;
      c.rt = DHCP6.SOL_TIMEOUT;
      this.apply(h);
      this.solicitDhcp(h, 'its address expired');
    });
  }

  // ------------------------------------------------------------ DHCPv6: the server

  private dhcpIn(dev: string, l3: L3Iface, msg: Msg, pkt: Pkt): void {
    const d = (msg.data || {}) as unknown as D6Data;
    const h = this.hosts.get(dev + ':' + l3.id);
    if (h && (msg.type === 'Advertise' || msg.type === 'Reply')) {
      this.clientIn(h, msg, d);
      return;
    }
    if (['Solicit', 'Request', 'Renew', 'Rebind', 'Information-request'].indexOf(msg.type) < 0) return;
    // a server on the client's link: the scope whose network holds the receiving interface's address (no relay agents are modelled)
    const own = l3.addrs.filter((a) => a.addr.version === 6);
    const s = this.scopes.find((x) => x.dev === dev && own.some((a) => inPrefix(x.net, a.addr)));
    if (!s) {
      if (this.scopes.some((x) => x.dev === dev)) this.note('drop', 'dhcpv6', dev, d.from || '', msg.type, '', `${dev} has no DHCPv6 scope for the network of ${l3.id} (${msg.label} from ${d.from})`);
      return;
    }
    const me = own.find((a) => inPrefix(s.net, a.addr)) as SimAddr;
    const serverId = this.duid(l3.mac);
    const reply = (type: string, detail: string, data: { [k: string]: unknown }, rows: Array<[string, string]>): void => {
      const m: Msg = { protocol: 'dhcpv6', type, label: `DHCPv6 ${type}`, detail, data: { from: dev, xid: d.xid, serverId, server: dev, serverAddr: formatAddr(me.addr), ...data, inspect: { title: 'Application – DHCPv6', rows: [['Message', type], ['Transaction id', String(d.xid)], ['Server identifier', serverId], ...rows] } } };
      const p = this.e.newPacket(me.addr, pkt.src, l3.vrf, m, [], 64);
      p.l4 = { proto: 'udp', num: 17, sport: DHCP6.SERVER_PORT, dport: DHCP6.CLIENT_PORT };
      p.len = 8 + 80;
      this.note('message', 'dhcpv6', dev, d.from || '', type, '', detail, m);
      this.e.send(dev, p, l3);
    };
    const dnsT = s.dns.map(formatAddr);
    if (msg.type === 'Information-request') {
      reply('Reply', `DHCPv6 Reply from ${dev} to ${d.from}: DNS ${dnsT.join(', ') || 'none'}${s.domain ? `, domain ${s.domain}` : ''}; information refresh ${durationText(DHCP6.IRT_DEFAULT)} (stateless)`, { info: true, dns: dnsT, domain: s.domain, refresh: DHCP6.IRT_DEFAULT }, [['DNS servers', dnsT.join(', ') || 'none'], ['Information refresh time', durationText(DHCP6.IRT_DEFAULT)]]);
      return;
    }
    if (!s.start || !s.end) {
      reply('Reply', `DHCPv6 Reply from ${dev} to ${d.from}: NoAddrsAvail (its scope for ${prefixText(s.net)} leases no addresses: stateless only)`, { status: 'NoAddrsAvail' }, [['Status', 'NoAddrsAvail']]);
      return;
    }
    if (msg.type === 'Renew' && d.server !== undefined && d.server !== serverId) return;
    const now = this.e.now;
    for (const [k, l] of Array.from(s.leases)) if (l.expires <= now) s.leases.delete(k);
    const life = s.lease;
    if (msg.type === 'Solicit') {
      const held = Array.from(s.leases.values()).find((l) => l.duid === d.duid);
      const ip = held ? held.addr : this.pick(s);
      if (!ip) {
        this.note('drop', 'dhcpv6', dev, d.from || '', 'Solicit', '', `${dev}: DHCPv6 scope ${s.index + 1} (${prefixText(s.net)}) has no free address left`);
        reply('Advertise', `DHCPv6 Advertise from ${dev} to ${d.from}: NoAddrsAvail`, { status: 'NoAddrsAvail' }, [['Status', 'NoAddrsAvail']]);
        return;
      }
      s.leases.set(formatAddr(ip), { addr: ip, duid: d.duid as string, client: `${d.from}:${d.iface || ''}`, state: 'offered', expires: now + 120000 });
      reply('Advertise', `DHCPv6 Advertise from ${dev} to ${d.from}: ${formatAddr(ip)} (preferred and valid ${durationText(life)}), DNS ${dnsT.join(', ') || 'none'}`, { addr: formatAddr(ip), preferred: life, valid: life, dns: dnsT, domain: s.domain }, [['IA_NA address', `${formatAddr(ip)} (preferred ${durationText(life)}, valid ${durationText(life)})`], ['DNS servers', dnsT.join(', ') || 'none']]);
      return;
    }
    // Request, Renew, Rebind: the binding (a Rebind for an address of another scope: not this server's)
    const want = d.addr ? parseAddress(d.addr) : null;
    if (!want || !inPrefix(s.net, want) || !inRange(want, s.start, s.end)) return;
    const l = s.leases.get(formatAddr(want));
    if (l && l.duid !== d.duid) {
      reply('Reply', `DHCPv6 Reply from ${dev} to ${d.from}: NoAddrsAvail (${formatAddr(want)} is another client’s)`, { status: 'NoAddrsAvail' }, [['Status', 'NoAddrsAvail']]);
      return;
    }
    s.leases.set(formatAddr(want), { addr: want, duid: d.duid as string, client: `${d.from}:${d.iface || ''}`, state: 'bound', expires: now + life });
    reply('Reply', `DHCPv6 Reply from ${dev} to ${d.from}: ${formatAddr(want)} is bound (${msg.type}; preferred and valid ${durationText(life)}; T1 ${durationText(DHCP6.T1 * life)}, T2 ${durationText(DHCP6.T2 * life)})`, { addr: formatAddr(want), preferred: life, valid: life, dns: dnsT, domain: s.domain }, [['IA_NA address', `${formatAddr(want)} (preferred ${durationText(life)}, valid ${durationText(life)})`], ['T1, T2', `${durationText(DHCP6.T1 * life)}, ${durationText(DHCP6.T2 * life)}`], ['DNS servers', dnsT.join(', ') || 'none']]);
  }

  private pick(s: Scope6): IpAddr | null {
    const start = s.start as IpAddr;
    const end = s.end as IpAddr;
    const cur = { version: 6 as const, bytes: start.bytes.slice() };
    for (let n = 0; n < 4096; n++) {
      if (compareAddr(cur, end) > 0) return null;
      const t = formatAddr(cur);
      if (!s.exclude.has(t) && !s.leases.has(t) && !this.e.ownerOf(cur)) return { version: 6, bytes: cur.bytes.slice() };
      for (let i = 15; i >= 0; i--) {
        cur.bytes[i]++;
        if (cur.bytes[i] <= 255) break;
        cur.bytes[i] = 0;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ status and tables

  /** A host interface's IPv6 in a few words (the diagram's line, the interface's status). */
  status(dev: string, iface: string): string | null {
    const h = this.hosts.get(dev + ':' + iface);
    if (!h) return null;
    if (h.disabled) return `IPv6 stopped: ${h.disabled}`;
    const auto = h.addrs.concat(h.dhcp && h.dhcp.addr ? [h.dhcp.addr] : []);
    const dup = auto.find((a) => a.state === 'duplicate');
    if (dup) return `Duplicate address ${formatAddr(dup.sa.addr)}`;
    const pref = auto.filter((a) => a.state === 'preferred');
    const dep = auto.filter((a) => a.state === 'deprecated');
    const parts: string[] = [];
    if (pref.length) parts.push(`${formatAddr(pref[0].sa.addr)} (${pref[0].kind === 'slaac' ? 'SLAAC' : 'DHCPv6'})${pref.length + dep.length > 1 ? ` +${pref.length + dep.length - 1}` : ''}`);
    else if (dep.length) parts.push(`Address deprecated: ${formatAddr(dep[0].sa.addr)}`);
    else if (!h.ll || h.ll.state === 'tentative') parts.push('IPv6: duplicate address detection');
    else if (h.method === 'dhcpv6' || (h.method === 'slaac_dhcpv6' && !h.ra)) parts.push(h.dhcp && h.dhcp.failed ? 'DHCPv6 pending (no server answered)' : 'DHCPv6 pending');
    else parts.push(h.ra ? 'SLAAC: no address (no autonomous /64 prefix)' : 'SLAAC pending (no router advertisement yet)');
    if (pref.length + dep.length && !h.routers.size) parts.push('No default router');
    return parts.join(' · ');
  }

  /** A host interface's preferred address that it obtained at runtime (SLAAC or DHCPv6), or null. */
  acquiredAddress(dev: string, iface: string): { text: string; kind: 'slaac' | 'dhcpv6' } | null {
    const h = this.hosts.get(dev + ':' + iface);
    if (!h || h.disabled) return null;
    const a = h.addrs.concat(h.dhcp && h.dhcp.addr ? [h.dhcp.addr] : []).find((x) => x.state === 'preferred' && x.kind !== 'link-local');
    return a ? { text: formatAddr(a.sa.addr), kind: a.kind as 'slaac' | 'dhcpv6' } : null;
  }

  /** The diagram's line of a host interface: its first usable address with its source, else its state, short. */
  mark(dev: string, iface: string): string | null {
    const h = this.hosts.get(dev + ':' + iface);
    if (!h) return null;
    if (h.disabled) return 'IPv6 stopped (duplicate link-local)';
    const auto = h.addrs.concat(h.dhcp && h.dhcp.addr ? [h.dhcp.addr] : []);
    const use = auto.filter((a) => a.state === 'preferred').concat(auto.filter((a) => a.state === 'deprecated'));
    if (use.length) return `${formatAddr(use[0].sa.addr)} (${use[0].kind === 'slaac' ? 'SLAAC' : 'DHCPv6'}${use[0].state === 'deprecated' ? ', deprecated' : ''})${use.length > 1 ? ` +${use.length - 1}` : ''}`;
    if (auto.some((a) => a.state === 'duplicate')) return 'IPv6: duplicate address';
    if (auto.some((a) => a.state === 'tentative') || !h.ll || h.ll.state === 'tentative') return 'IPv6: duplicate address detection';
    return h.method === 'dhcpv6' ? 'IPv6: DHCPv6 pending' : h.ra ? 'IPv6: no SLAAC prefix' : 'IPv6: SLAAC pending';
  }

  /** Does the device have IPv6 host configuration or advertisements (its Show IPv6 table)? */
  hasTable(dev: string): boolean {
    return Array.from(this.hosts.values()).some((h) => h.dev === dev) || Array.from(this.routers.values()).some((r) => r.dev === dev) || this.scopes.some((s) => s.dev === dev);
  }

  /** A device's learned IPv6 state: addresses with their source, state and lifetimes; default routers; DNS servers; DHCPv6 (Show IPv6 configuration). */
  table(dev: string): GridTable {
    const now = this.e.now;
    const rows: string[][] = [];
    const notes: string[] = [];
    for (const h of Array.from(this.hosts.values()).filter((x) => x.dev === dev).sort((x, y) => cmp(x.iface, y.iface))) {
      const all = (h.ll ? [h.ll] : []).concat(h.addrs, h.dhcp && h.dhcp.addr ? [h.dhcp.addr] : []);
      for (const a of all) rows.push([h.iface, a.sa.text, a.kind === 'link-local' ? 'link-local' : a.kind === 'slaac' ? `SLAAC (${a.from})` : `DHCPv6 (${a.from})`, a.state, left(a.preferredUntil - now), left(a.validUntil - now)]);
      notes.push(`${h.iface} (${h.method}): ${this.status(dev, h.iface)}`);
      for (const r of h.routers.values()) notes.push(`${h.iface}: default router ${r.dev} (${formatAddr(r.addr)}), ${left(r.until - now)} left${r.managed || r.other ? ` (flags ${r.managed ? 'M' : ''}${r.other ? 'O' : ''})` : ''}`);
      for (const [k, x] of h.dns) notes.push(`${h.iface}: DNS server ${k} (${x.source}), ${left(x.until - now)} left`);
      if (h.dhcp) notes.push(`${h.iface}: DHCPv6 ${h.dhcp.state.toLowerCase()}${h.dhcp.server ? ` with ${h.dhcp.server}` : ''}${h.dhcp.t1 && h.dhcp.state === 'BOUND' ? `, renews in ${left(h.dhcp.t1 - now)}` : ''}${h.dhcp.failed ? ` (${h.dhcp.failed})` : ''}`);
      if (h.info) notes.push(`${h.iface}: stateless DHCPv6 ${h.info.state === 'INFORMED' ? 'informed' : 'asking'}${h.info.failed ? ` (${h.info.failed})` : ''}`);
    }
    for (const r of Array.from(this.routers.values()).filter((x) => x.dev === dev)) notes.push(`${r.iface}: advertises ${r.ra.prefixes.join(', ')} from ${r.ll ? r.ll.sa.text + (r.ll.state === 'tentative' ? ' (tentative)' : '') : '(no link-local address yet)'}; ${r.sent} advertisement${r.sent === 1 ? '' : 's'} sent; router lifetime ${durationText(raRouterLifetime(r.ra))}, interval up to ${durationText(raInterval(r.ra))}`);
    for (const s of this.scopes.filter((x) => x.dev === dev)) {
      notes.push(`DHCPv6 scope ${s.index + 1} (${prefixText(s.net)}): ${s.start ? `addresses ${formatAddr(s.start)}–${formatAddr(s.end as IpAddr)}` : 'stateless (information only)'}; DNS ${s.dns.map(formatAddr).join(', ') || 'none'}`);
      for (const l of s.leases.values()) if (l.expires > now) rows.push([`scope ${s.index + 1}`, `${formatAddr(l.addr)}/128`, `lease of ${l.client} (${l.duid})`, l.state, left(l.expires - now), left(l.expires - now)]);
    }
    return { caption: `IPv6 configuration of ${dev}`, cols: ['Interface', 'Address', 'Source', 'State', 'Preferred for', 'Valid for'], rows, empty: 'No learned IPv6 address.', timers: [], notes };
  }
}

interface RaData {
  router: string;
  iface: string;
  lifetime: number;
  managed: boolean;
  other: boolean;
  prefixes: Array<{ prefix: string; onlink: boolean; autonomous: boolean; valid: number; preferred: number }>;
  dns: string[];
  dnsLifetime: number;
}

interface D6Data {
  xid: number;
  from?: string;
  iface?: string;
  duid?: string;
  info?: boolean;
  addr?: string;
  preferred?: number;
  valid?: number;
  dns?: string[];
  domain?: string;
  refresh?: number;
  server?: string;
  serverId?: string;
  serverAddr?: string;
  status?: string;
  kind?: string;
}

void UNSPEC;

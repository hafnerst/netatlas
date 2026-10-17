/**
 * DHCP and DNS in the protocol simulation: the servers' scopes and zones
 * (the model's `services:`), the clients (interfaces with `ipv4: dhcp`, and
 * every host's resolver), the relays (`dhcp_relay:` on a router's
 * interface).
 *
 * DHCP (RFC 2131). A client's interface starts without an address. As soon
 * as its link is up it broadcasts a DHCPDISCOVER from 0.0.0.0 to
 * 255.255.255.255; a server in its broadcast domain, or a relay there
 * (forwarding it as unicast with its own address as giaddr), gets it. The
 * server picks an address of the scope whose network holds the receiving
 * interface's address (or the giaddr): the client's reservation, the
 * address it had, else the first free one of the range (not excluded, not
 * leased, not reserved for another; with the ping check, none that answers)
 * and answers with a DHCPOFFER (after its offer delay); a pool without a
 * free address does not answer (as ISC dhcpd: "no free leases"). The client
 * broadcasts a DHCPREQUEST, the server confirms with a DHCPACK (or a
 * DHCPNAK for an address it can't give), and the lease applies: the
 * address (announced with a gratuitous ARP), the gateway as its default
 * route, the DNS servers as its resolver's. Everything else the client
 * sends waits for it (the scheduler's dependency). It renews at T1 (half
 * the lease) by unicast to the server, rebinds at T2 (7/8) by broadcast,
 * and loses the address when the lease ends. Without an offer it sends
 * again after its retransmission delay, doubled each time up to 64 s, for
 * its retries; then it pauses five minutes and starts again, taking a
 * link-local address (169.254.0.0/16, RFC 3927) meanwhile when its
 * fallback is on. Clients run in parallel, each with its own jitter.
 *
 * DNS (RFC 1034 / 1035). A host's resolver asks its DNS servers (from its
 * lease, else its `dns_servers:`) over UDP 53: an A (or AAAA) query; the
 * server answers from its zones (the model's DNS names in the zone as A /
 * AAAA records, and the zone's own A, AAAA and CNAME records; a CNAME is
 * followed within its zones), NXDOMAIN for a name in a zone it doesn't
 * have, its forwarders for a name in none of its zones (a DNS server of the
 * model; else SERVFAIL). The resolver caches an answer for the record's TTL
 * (NXDOMAIN is not cached), tries each server twice with a 5 s timeout
 * (resolv.conf: timeout 5, attempts 2) and gives up with a timeout. Send
 * test and test traffic to a name resolve it first: the connection waits
 * for the answer.
 *
 * Simplifications: IPv4 only for DHCP (no DHCPv6); one lease per
 * interface; no DHCPDECLINE / DHCPRELEASE / DHCPINFORM; no option 82; the
 * offer is broadcast (the client's broadcast flag); no negative caching, no
 * DNSSEC, no TCP fallback, no recursion beyond the model's servers.
 */
import { IpAddr, parseAddress, parsePrefix } from '../../model/ip';
import { Device, DhcpScope, Model, deviceInterfaces } from '../../model/types';
import { compareAddr, formatAddr, inPrefix, networkOf, prefixText } from '../ipmath';
import { DEFAULT_LEASE, derivedRecords, inRange, inZone, recordFqdn } from '../../model/netservices';
import { durationText, ifaceRef, scopeRef, zoneRef } from './params';
import { L3Iface, Lease, SimAddr } from './net';
import { ProtocolSim } from './protocols';
import { Msg, Pkt } from './types';
import { dnsNameKey } from '../../model/dns';

const BROADCAST = parseAddress('255.255.255.255') as IpAddr;
const ZERO = parseAddress('0.0.0.0') as IpAddr;
/** the ping check's wait for an answer (ms) */
const PING_WAIT = 500;
/** an offer is held for its client this long (ms) */
const OFFER_HOLD = 120000;
/** the pause after the retries, before the client starts again (ms; Windows: 5 min) */
const DHCP_PAUSE = 300000;
/** the longest retransmission delay (RFC 2131 §4.1) */
const BACKOFF_MAX = 64000;
/** the resolver: its timeout per query and its attempts per server (resolv.conf defaults) */
const DNS_TIMEOUT = 5000;
const DNS_ATTEMPTS = 2;

/** A row of a server's lease table (Show DHCP leases). */
export interface LeaseRow {
  ip: string;
  mac: string;
  client: string;
  state: 'offered' | 'bound';
  /** when it ends (ms) */
  expires: number;
  scope: number;
}

/** A row of a host's resolver cache (Show DNS cache). */
export interface DnsCacheRow {
  name: string;
  type: string;
  value: string;
  server: string;
  expires: number;
}

/** A record of a server's zone (Show DNS zone). */
export interface ZoneRow {
  zone: string;
  name: string;
  type: string;
  value: string;
  source: string;
  ttl: string;
}

interface Scope {
  dev: string;
  index: number;
  net: ReturnType<typeof networkOf>;
  start: IpAddr;
  end: IpAddr;
  gateway?: IpAddr;
  dns: IpAddr[];
  lease: number;
  exclude: Set<string>;
  res: Map<string, string>;
  domain?: string;
  leases: Map<string, LeaseRow>;
}

type ClientState = 'INIT' | 'SELECTING' | 'REQUESTING' | 'BOUND' | 'RENEWING' | 'REBINDING';

interface Client {
  dev: string;
  iface: string;
  mac: string;
  state: ClientState;
  xid: number;
  attempt: number;
  /** bumped whenever its timers are replaced */
  gen: number;
  offer?: { ip: IpAddr; server: IpAddr; prefix: number; gateway?: IpAddr; dns: IpAddr[]; lease: number; domain?: string };
  /** its last round without an offer (when, and what happened), until it is bound again */
  failed?: { at: number; text: string };
}

/** A DHCP client interface's state, as Send test… shows it. */
export interface DhcpClientStatus {
  state: ClientState;
  /** the DHCPDISCOVERs of the current round so far */
  attempt: number;
  failed?: { at: number; text: string };
}

interface DhcpData {
  xid: number;
  chaddr: string;
  from: string;
  iface?: string;
  ciaddr?: string;
  yiaddr?: string;
  requested?: string;
  server?: string;
  giaddr?: string;
  prefix?: number;
  gateway?: string;
  dns?: string[];
  lease?: number;
  domain?: string;
}

interface DnsData {
  id: number;
  name: string;
  qtype: 'A' | 'AAAA';
  from: string;
  answer?: string[];
  rcode?: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  ttl?: number;
  cname?: string;
}

interface Query {
  dev: string;
  name: string;
  qtype: 'A' | 'AAAA';
  servers: IpAddr[];
  si: number;
  attempt: number;
  id: number;
  done: boolean;
  cb: (r: { addr?: IpAddr; error?: string }) => void;
  /** a server forwarding it: the client's query it answers */
  forFor?: { dev: string; q: Pkt; l3: L3Iface };
}

export class NetServicesSim {
  private scopes: Scope[] = [];
  private clients = new Map<string, Client>();
  /** told when a client gives up a round without a lease (Send tests waiting for it fail and say why) */
  onLeaseFailed: ((dev: string, iface: string, why: string) => void) | null = null;

  /** A DHCP client interface's state (null: the interface is no DHCP client of the simulation). */
  clientStatus(dev: string, iface: string): DhcpClientStatus | null {
    const c = this.clients.get(dev + ':' + iface);
    return c ? { state: c.state, attempt: c.attempt, failed: c.failed ? { ...c.failed } : undefined } : null;
  }
  private cache = new Map<string, Map<string, { addr: IpAddr; expires: number; server: string; type: string }>>();
  private queries = new Map<number, Query>();
  private qid = 0;

  constructor(private P: ProtocolSim) {
    this.readScopes();
    for (const d of P.m.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
      for (const i of deviceInterfaces(d)) if (i.dhcp && P.sd(d.id) && P.sd(d.id).l3.get(i.id)) this.clients.set(d.id + ':' + i.id, { dev: d.id, iface: i.id, mac: (P.sd(d.id).l3.get(i.id) as L3Iface).mac, state: 'INIT', xid: 0, attempt: 0, gen: 0 });
    }
    P.handlers.set('dhcp', (dev, l3, msg, pkt) => this.dhcpIn(dev, l3, msg, pkt));
    P.handlers.set('dns', (dev, l3, msg, pkt) => (msg.relation ? false : this.dnsIn(dev, l3, msg, pkt)));
    // a client starts when its link is up; a link down ends its lease
    P.ifaceHooks.push((dev, l3, up) => {
      const c = this.clients.get(dev + ':' + l3.id);
      if (!c) return;
      if (up && c.state === 'INIT' && !this.P.e.leases.has(dev + ':' + l3.id)) this.P.e.at(this.P.e.now + this.P.e.jitter(), () => this.discover(c, 'its link is up'));
      if (!up) {
        c.gen++;
        c.state = 'INIT';
        c.attempt = 0;
        this.P.e.dropLease(dev, l3.id, 'its link went down');
      }
    });
    P.bootHooks.push(() => {
      // (an interface up from the start, without a cable to wait for)
      for (const c of this.clients.values()) if (this.P.e.isL3Up(c.dev, c.iface)) this.P.e.at(this.P.e.jitter(), () => this.discover(c, 'it starts'));
    });
  }

  private readScopes(): void {
    for (const d of this.P.m.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
      const dh = d.netServices && d.netServices.dhcp;
      if (!dh) continue;
      dh.scopes.forEach((s: DhcpScope, index: number) => {
        const n = s.network ? this.P.m.networks.find((x) => x.id === s.network) : undefined;
        const p = n && n.cidr ? parsePrefix(n.cidr) : null;
        if (!p || p.version !== 4 || !s.start || !s.end) return;
        this.scopes.push({
          dev: d.id,
          index,
          net: networkOf(p),
          start: parseAddress(s.start) as IpAddr,
          end: parseAddress(s.end) as IpAddr,
          gateway: s.gateway ? (parseAddress(s.gateway) as IpAddr) : undefined,
          dns: s.dns.map((x) => parseAddress(x) as IpAddr),
          lease: s.lease || DEFAULT_LEASE,
          exclude: new Set(s.exclude),
          res: new Map(s.reservations.map((r) => [r.mac, r.ip])),
          domain: s.domain,
          leases: new Map(),
        });
      });
    }
  }

  // ------------------------------------------------------------ DHCP: the client

  private retries(c: Client): number {
    return this.P.e.params.num('dhcp-retries', c.dev, null, ifaceRef(c.dev, c.iface));
  }

  private msg(type: string, label: string, detail: string, data: DhcpData): Msg {
    return { protocol: 'dhcp', type, label, detail, data: data as unknown as { [k: string]: unknown } };
  }

  private send(dev: string, src: IpAddr, dst: IpAddr, msg: Msg, out?: L3Iface, server = false): void {
    const pkt = this.P.e.newPacket(src, dst, '', msg);
    pkt.l4 = { proto: 'udp', num: 17, sport: server ? 67 : 68, dport: server ? 68 : 67 };
    pkt.len = 8 + 300;
    this.P.e.send(dev, pkt, out);
  }

  private l3(c: Client): L3Iface | undefined {
    const sd = this.P.sd(c.dev);
    return sd ? sd.l3.get(c.iface) : undefined;
  }

  /** DHCPDISCOVER: the client looks for a server (a broadcast; a relay forwards it). */
  private discover(c: Client, why: string): void {
    const l3 = this.l3(c);
    if (!l3 || !this.P.e.deviceOn(c.dev) || !this.P.e.isL3Up(c.dev, c.iface)) return;
    if (c.state !== 'INIT' && c.state !== 'SELECTING') return;
    c.state = 'SELECTING';
    c.attempt++;
    c.xid = (hash(`${c.dev}|${c.iface}|${c.gen}|${c.attempt}`) >>> 0) % 0xffffffff;
    const gen = ++c.gen;
    const d: DhcpData = { xid: c.xid, chaddr: c.mac, from: c.dev, iface: c.iface };
    const m = this.msg('DHCPDISCOVER', 'DHCPDISCOVER', `DHCPDISCOVER from ${c.dev}:${c.iface} (${c.mac}, xid ${hex(c.xid)}) from 0.0.0.0:68 to 255.255.255.255:67: which server gives me an address? (${c.attempt === 1 ? why : 'attempt ' + c.attempt})`, d);
    this.P.e.note('message', 'dhcp', c.dev, '', 'DHCPDISCOVER', '', m.detail, this.P.e.now, m);
    this.send(c.dev, ZERO, BROADCAST, m, l3);
    // no offer within the retransmission delay (doubled each time): again; after the retries: a pause (and a link-local address)
    const r = this.P.e.params.get('dhcp-backoff', c.dev, null, ifaceRef(c.dev, c.iface));
    const wait = Math.min(BACKOFF_MAX, Number(r.value) * Math.pow(2, c.attempt - 1));
    this.P.e.after(wait, () => {
      if (c.gen !== gen || c.state !== 'SELECTING') return;
      if (c.attempt < this.retries(c)) {
        this.discover(c, '');
        return;
      }
      c.state = 'INIT';
      c.attempt = 0;
      const ll = this.P.e.params.get('link-local', c.dev, null, ifaceRef(c.dev, c.iface));
      const fall = ll.value === 'on' && !this.P.e.leases.has(c.dev + ':' + c.iface);
      c.failed = { at: this.P.e.now, text: `no DHCPOFFER after ${this.retries(c)} DHCPDISCOVERs; it tries again in ${durationText(DHCP_PAUSE)}` };
      this.P.e.note('state', 'dhcp', c.dev, '', 'no DHCP server', 'no lease', `${c.dev}:${c.iface} got no DHCPOFFER after ${this.retries(c)} DHCPDISCOVERs: it starts again in ${durationText(DHCP_PAUSE)}${fall ? '; meanwhile a link-local address (RFC 3927)' : ` (link-local fallback ${ll.value === 'on' ? 'on' : 'off'}: it stays without an address)`}`);
      // the Send tests waiting for this lease fail now, saying why (before a link-local address could stand in for it)
      if (this.onLeaseFailed) this.onLeaseFailed(c.dev, c.iface, c.failed.text);
      if (fall) this.linkLocal(c);
      const g2 = ++c.gen;
      this.P.e.after(DHCP_PAUSE, () => {
        if (c.gen === g2 && c.state === 'INIT') this.discover(c, 'it tries again');
      });
    });
  }

  /** A link-local address (169.254.1.0–169.254.254.255, from its MAC), announced; the next lease replaces it. */
  private linkLocal(c: Client): void {
    const h = hash(c.mac + '|' + c.dev);
    const ip = parseAddress(`169.254.${1 + (h % 254)}.${(h >>> 8) % 256}`) as IpAddr;
    const net = { version: 4 as const, bytes: [169, 254, 0, 0], prefix: 16 };
    const addr: SimAddr = { addr: ip, net, text: formatAddr(ip) + '/16' };
    this.P.e.note('table', 'dhcp', c.dev, '', 'link-local', 'link-local', `${c.dev}:${c.iface} takes the link-local address ${formatAddr(ip)}/16 (no DHCP server answered; RFC 3927): it reaches only its own segment`);
    this.P.e.bindLease({ dev: c.dev, iface: c.iface, addr, vrf: this.vrf(c), dns: [], kind: 'link-local', bound: this.P.e.now, expires: Infinity });
  }

  private vrf(c: Client): string {
    const l3 = this.l3(c);
    return l3 ? l3.vrf : '';
  }

  /** The client got an offer (the first one): it asks for the address with a broadcast DHCPREQUEST. */
  private offered(c: Client, d: DhcpData): void {
    if (c.state !== 'SELECTING' || d.xid !== c.xid || !d.yiaddr || !d.server) return;
    const l3 = this.l3(c);
    if (!l3) return;
    c.state = 'REQUESTING';
    c.offer = { ip: parseAddress(d.yiaddr) as IpAddr, server: parseAddress(d.server) as IpAddr, prefix: d.prefix || 24, gateway: d.gateway ? (parseAddress(d.gateway) as IpAddr) : undefined, dns: (d.dns || []).map((x) => parseAddress(x) as IpAddr), lease: d.lease || DEFAULT_LEASE, domain: d.domain };
    const gen = ++c.gen;
    const q: DhcpData = { xid: c.xid, chaddr: c.mac, from: c.dev, iface: c.iface, requested: d.yiaddr, server: d.server };
    const m = this.msg('DHCPREQUEST', `DHCPREQUEST ${d.yiaddr}`, `DHCPREQUEST from ${c.dev}:${c.iface} (${c.mac}, xid ${hex(c.xid)}), broadcast: it takes ${d.yiaddr} from server ${d.server}`, q);
    this.P.e.note('message', 'dhcp', c.dev, '', 'DHCPREQUEST', '', m.detail, this.P.e.now, m);
    this.send(c.dev, ZERO, BROADCAST, m, l3);
    // no answer: from the start
    this.P.e.after(Number(this.P.e.params.get('dhcp-backoff', c.dev, null, ifaceRef(c.dev, c.iface)).value), () => {
      if (c.gen !== gen || c.state !== 'REQUESTING') return;
      c.state = 'INIT';
      c.attempt = 0;
      this.discover(c, 'no DHCPACK for its request');
    });
  }

  /** DHCPACK: the lease applies (and its renewal, rebinding and end are scheduled). */
  private acked(c: Client, d: DhcpData): void {
    if (d.xid !== c.xid || !d.yiaddr) return;
    if (c.state !== 'REQUESTING' && c.state !== 'RENEWING' && c.state !== 'REBINDING') return;
    const ip = parseAddress(d.yiaddr) as IpAddr;
    const prefix = d.prefix || (c.offer ? c.offer.prefix : 24);
    const net = { ...networkOf({ version: 4, bytes: ip.bytes, prefix }) };
    const lease = d.lease || DEFAULT_LEASE;
    const was = c.state;
    c.state = 'BOUND';
    c.failed = undefined;
    c.attempt = 0;
    const gen = ++c.gen;
    const l: Lease = { dev: c.dev, iface: c.iface, addr: { addr: ip, net, text: `${formatAddr(ip)}/${prefix}` }, vrf: this.vrf(c), gateway: d.gateway ? (parseAddress(d.gateway) as IpAddr) : undefined, dns: (d.dns || []).map((x) => parseAddress(x) as IpAddr), domain: d.domain, server: d.server ? (parseAddress(d.server) as IpAddr) : undefined, kind: 'dhcp', bound: this.P.e.now, expires: this.P.e.now + lease };
    this.P.e.note('state', 'dhcp', c.dev, '', was === 'REQUESTING' ? 'Bound' : 'Renewed', 'bound', `${c.dev}:${c.iface} ${was === 'REQUESTING' ? 'is bound to' : 'renewed'} ${l.addr.text} (DHCP lease ${durationText(lease)} from ${d.server}${l.gateway ? `; gateway ${formatAddr(l.gateway)}` : ''}${l.dns.length ? `; DNS ${l.dns.map(formatAddr).join(', ')}` : ''}${l.domain ? `; domain ${l.domain}` : ''}): renews at ${durationText(lease / 2)}, rebinds at ${durationText((lease * 7) / 8)}`);
    this.P.e.bindLease(l);
    // T1: renew from the server (unicast); T2: rebind (broadcast); the end: the address goes
    this.P.e.after(lease / 2, () => {
      if (c.gen === gen && c.state === 'BOUND') this.renew(c, l, false);
    });
    this.P.e.after((lease * 7) / 8, () => {
      if (c.gen === gen && (c.state === 'RENEWING' || c.state === 'BOUND')) this.renew(c, l, true);
    });
    this.P.e.after(lease, () => {
      if (c.gen !== gen || c.state === 'BOUND') return;
      c.state = 'INIT';
      c.attempt = 0;
      this.P.e.note('state', 'dhcp', c.dev, '', 'Lease expired', 'no lease', `The DHCP lease of ${l.addr.text} on ${c.dev}:${c.iface} ended without a renewal: the interface has no address now; it starts again (DHCPDISCOVER)`);
      this.P.e.dropLease(c.dev, c.iface, 'its DHCP lease ended');
      this.discover(c, 'its lease ended');
    });
  }

  /** Renewing (unicast to its server) or rebinding (broadcast to any server). */
  private renew(c: Client, l: Lease, rebind: boolean): void {
    const l3 = this.l3(c);
    if (!l3) return;
    c.state = rebind ? 'REBINDING' : 'RENEWING';
    c.xid = (hash(`${c.dev}|${c.iface}|renew|${this.P.e.now}`) >>> 0) % 0xffffffff;
    const d: DhcpData = { xid: c.xid, chaddr: c.mac, from: c.dev, iface: c.iface, ciaddr: formatAddr(l.addr.addr), requested: formatAddr(l.addr.addr) };
    const m = this.msg('DHCPREQUEST', `DHCPREQUEST ${formatAddr(l.addr.addr)} (${rebind ? 'rebind' : 'renew'})`, `DHCPREQUEST from ${c.dev}:${c.iface} (${formatAddr(l.addr.addr)}): ${rebind ? 'rebinding at T2 (7/8 of the lease), broadcast to any server' : `renewing at T1 (half the lease), unicast to its server ${l.server ? formatAddr(l.server) : ''}`}`, d);
    this.P.e.note('message', 'dhcp', c.dev, '', 'DHCPREQUEST', '', m.detail, this.P.e.now, m);
    if (rebind || !l.server) this.send(c.dev, l.addr.addr, BROADCAST, m, l3);
    else this.send(c.dev, l.addr.addr, l.server, m);
  }

  // ------------------------------------------------------------ DHCP: what arrives

  private dhcpIn(dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null): void {
    const d = (msg.data || {}) as unknown as DhcpData;
    if (!pkt || !l3) return;
    const type = msg.type;
    // a client: an answer for it
    const c = d.chaddr ? Array.from(this.clients.values()).find((x) => x.dev === dev && x.mac === d.chaddr) : undefined;
    if (c && (type === 'DHCPOFFER' || type === 'DHCPACK' || type === 'DHCPNAK')) {
      if (type === 'DHCPOFFER') this.offered(c, d);
      else if (type === 'DHCPACK') this.acked(c, d);
      else if (d.xid === c.xid) {
        c.gen++;
        c.state = 'INIT';
        c.attempt = 0;
        this.P.e.note('state', 'dhcp', c.dev, '', 'DHCPNAK', 'no lease', `${c.dev}:${c.iface} got a DHCPNAK: it starts again`);
        this.P.e.dropLease(c.dev, c.iface, 'a DHCPNAK');
        this.discover(c, 'a DHCPNAK');
      }
      return;
    }
    if (type === 'DHCPDISCOVER' || type === 'DHCPREQUEST') {
      // a relay: a client's broadcast on an interface with a DHCP relay goes to its servers as unicast
      const relayTo = this.relayOf(dev, l3);
      if (relayTo.length && !d.giaddr && isBroadcast(pkt.dst)) {
        const own = l3.addrs.find((a) => a.addr.version === 4);
        if (!own) return;
        for (const srv of relayTo) {
          const fwd: DhcpData = { ...d, giaddr: formatAddr(own.addr) };
          const m = this.msg(type, msg.label + ' (relayed)', `${dev} relays ${msg.label} from ${d.from} to the DHCP server ${formatAddr(srv)} as unicast, with giaddr ${formatAddr(own.addr)} (its ${l3.id})`, fwd);
          this.P.e.note('message', 'dhcp', dev, this.P.e.ownerOf(srv) || '', type, '', m.detail, this.P.e.now, m);
          this.send(dev, own.addr, srv, m, undefined, true);
        }
        return;
      }
      if (this.isServer(dev)) this.serverIn(dev, l3, msg, d, pkt);
      return;
    }
    // a relay: the server's answer to its giaddr goes to the client's segment as a broadcast
    if ((type === 'DHCPOFFER' || type === 'DHCPACK' || type === 'DHCPNAK') && d.giaddr && this.P.e.ownsAddress(dev, parseAddress(d.giaddr) as IpAddr)) {
      const out = this.P.e.ownsAddress(dev, parseAddress(d.giaddr) as IpAddr) as L3Iface;
      const m = this.msg(type, msg.label, `${dev} passes ${msg.label} from the server on to ${d.from} as a broadcast on ${out.id}`, d);
      this.P.e.note('message', 'dhcp', dev, d.from, type, '', m.detail, this.P.e.now, m);
      this.send(dev, parseAddress(d.giaddr) as IpAddr, BROADCAST, m, out, true);
    }
  }

  private isServer(dev: string): boolean {
    return this.scopes.some((s) => s.dev === dev);
  }

  /** The DHCP servers an interface relays to (its `dhcp_relay:`). */
  private relayOf(dev: string, l3: L3Iface): IpAddr[] {
    const i = this.P.m.index.interfaces.get(dev + ':' + l3.id);
    return i && i.dhcpRelay ? i.dhcpRelay.map((x) => parseAddress(x) as IpAddr) : [];
  }

  /** The scope a request is for: the one whose network holds the giaddr, else the receiving interface's address. */
  private scopeFor(dev: string, l3: L3Iface, d: DhcpData): Scope | undefined {
    const at = d.giaddr ? [parseAddress(d.giaddr) as IpAddr] : l3.addrs.filter((a) => a.addr.version === 4).map((a) => a.addr);
    return this.scopes.find((s) => s.dev === dev && at.some((a) => inPrefix(s.net, a)));
  }

  private serverIn(dev: string, l3: L3Iface, msg: Msg, d: DhcpData, pkt: Pkt): void {
    const s = this.scopeFor(dev, l3, d);
    if (!s) {
      this.P.e.note('drop', 'dhcp', dev, d.from, msg.type, '', `${dev} has no DHCP scope for ${d.giaddr ? 'the relay’s network (giaddr ' + d.giaddr + ')' : 'the network of ' + l3.id} (${msg.label} from ${d.from})`);
      return;
    }
    const now = this.P.e.now;
    // (offers not taken in time are free again; ended leases too)
    for (const [k, r] of Array.from(s.leases)) if ((r.state === 'offered' && now - (r.expires - OFFER_HOLD) > OFFER_HOLD) || r.expires <= now) s.leases.delete(k);
    const me = this.serverAddr(dev, l3);
    if (msg.type === 'DHCPDISCOVER') {
      const ping = this.P.e.params.get('dhcp-ping-check', dev, null, scopeRef(dev, s.index));
      const delay = this.P.e.params.num('dhcp-offer-delay', dev, null, scopeRef(dev, s.index)) + (ping.value === 'on' ? PING_WAIT : 0);
      const ip = this.pick(s, d.chaddr, ping.value === 'on');
      if (!ip) {
        this.P.e.note('drop', 'dhcp', dev, d.from, 'DHCPDISCOVER', '', `${dev} does not answer the DHCPDISCOVER of ${d.from} (${d.chaddr}): scope ${s.index + 1} (${prefixText(s.net)}) has no free address left (pool exhausted; like ISC dhcpd, no DHCPOFFER)`);
        return;
      }
      s.leases.set(formatAddr(ip), { ip: formatAddr(ip), mac: d.chaddr, client: `${d.from}:${d.iface || ''}`, state: 'offered', expires: now + OFFER_HOLD, scope: s.index });
      this.P.e.after(delay, () => {
        const a: DhcpData = { xid: d.xid, chaddr: d.chaddr, from: d.from, iface: d.iface, yiaddr: formatAddr(ip), server: formatAddr(me), giaddr: d.giaddr, prefix: s.net.prefix, gateway: s.gateway ? formatAddr(s.gateway) : undefined, dns: s.dns.map(formatAddr), lease: s.lease, domain: s.domain };
        const m = this.msg('DHCPOFFER', `DHCPOFFER ${formatAddr(ip)} · lease ${leaseText(s.lease)}`, `DHCPOFFER from ${dev} (${formatAddr(me)}) to ${d.from} (${d.chaddr}): ${formatAddr(ip)}/${s.net.prefix}, lease ${durationText(s.lease)}${s.gateway ? ', gateway ' + formatAddr(s.gateway) : ''}${s.dns.length ? ', DNS ' + s.dns.map(formatAddr).join(', ') : ''}${delay > 0 ? ` (after ${ping.value === 'on' ? 'the ping check and ' : ''}${durationText(delay)})` : ''}`, a);
        this.answer(dev, l3, me, m, d);
      });
      return;
    }
    // DHCPREQUEST: for another server's offer (SELECTING): its own offer is free again
    if (d.server && compareAddr(parseAddress(d.server) as IpAddr, me) !== 0 && !d.ciaddr) {
      for (const [k, r] of Array.from(s.leases)) if (r.mac === d.chaddr && r.state === 'offered') s.leases.delete(k);
      return;
    }
    const want = d.requested ? (parseAddress(d.requested) as IpAddr) : null;
    const held = want ? s.leases.get(formatAddr(want)) : undefined;
    const reserved = want ? s.res.get(d.chaddr) === formatAddr(want) : false;
    const ok = !!want && inPrefix(s.net, want) && ((!!held && held.mac === d.chaddr) || reserved || (!held && inRange(want, s.start, s.end) && !s.exclude.has(formatAddr(want)) && !this.reservedForOther(s, want, d.chaddr)));
    if (!ok) {
      const m = this.msg('DHCPNAK', 'DHCPNAK', `DHCPNAK from ${dev} to ${d.from} (${d.chaddr}): ${d.requested || '?'} is not its to give (${!want ? 'none asked for' : !inPrefix(s.net, want) ? 'not in the scope’s network' : 'leased to another client'})`, { ...d, server: formatAddr(me) });
      this.answer(dev, l3, me, m, d);
      return;
    }
    s.leases.set(formatAddr(want as IpAddr), { ip: formatAddr(want as IpAddr), mac: d.chaddr, client: `${d.from}:${d.iface || ''}`, state: 'bound', expires: now + s.lease, scope: s.index });
    const a: DhcpData = { xid: d.xid, chaddr: d.chaddr, from: d.from, iface: d.iface, yiaddr: formatAddr(want as IpAddr), server: formatAddr(me), giaddr: d.giaddr, prefix: s.net.prefix, gateway: s.gateway ? formatAddr(s.gateway) : undefined, dns: s.dns.map(formatAddr), lease: s.lease, domain: s.domain };
    const m = this.msg('DHCPACK', `DHCPACK ${formatAddr(want as IpAddr)} · lease ${leaseText(s.lease)}`, `DHCPACK from ${dev} to ${d.from} (${d.chaddr}): ${formatAddr(want as IpAddr)}/${s.net.prefix} is leased for ${durationText(s.lease)}`, a);
    // a renewal from a bound client: unicast back to it
    if (d.ciaddr && !isBroadcast(pkt.dst)) {
      this.P.e.note('message', 'dhcp', dev, d.from, 'DHCPACK', '', m.detail, this.P.e.now, m);
      this.send(dev, me, parseAddress(d.ciaddr) as IpAddr, m, undefined, true);
      return;
    }
    this.answer(dev, l3, me, m, d);
  }

  /** The answer goes back the way the request came: to the relay (unicast to giaddr), else broadcast on the segment. */
  private answer(dev: string, l3: L3Iface, me: IpAddr, m: Msg, d: DhcpData): void {
    this.P.e.note('message', 'dhcp', dev, d.from, m.type, '', m.detail, this.P.e.now, m);
    if (d.giaddr) this.send(dev, me, parseAddress(d.giaddr) as IpAddr, m, undefined, true);
    else this.send(dev, me, BROADCAST, m, l3, true);
  }

  private serverAddr(dev: string, l3: L3Iface): IpAddr {
    const a = l3.addrs.find((x) => x.addr.version === 4);
    if (a) return a.addr;
    const sd = this.P.sd(dev);
    for (const l of sd.l3.values()) for (const x of l.addrs) if (x.addr.version === 4) return x.addr;
    return ZERO;
  }

  private reservedForOther(s: Scope, ip: IpAddr, mac: string): boolean {
    for (const [m, a] of s.res) if (m !== mac && a === formatAddr(ip)) return true;
    return false;
  }

  /** The address a client gets: its reservation, what it had, else the first free one of the range. */
  private pick(s: Scope, mac: string, ping: boolean): IpAddr | null {
    const r = s.res.get(mac);
    if (r) return parseAddress(r) as IpAddr;
    for (const l of s.leases.values()) if (l.mac === mac) return parseAddress(l.ip) as IpAddr;
    const v = s.start.bytes.slice();
    for (let n = 0; n < 65536; n++) {
      const a: IpAddr = { version: 4, bytes: v.slice() };
      if (compareAddr(a, s.end) > 0) break;
      const t = formatAddr(a);
      const free = !s.exclude.has(t) && !s.leases.has(t) && !this.reservedForOther(s, a, mac);
      // the ping check: an address some device answers for is skipped
      if (free && (!ping || !this.P.e.ownerOf(a))) return a;
      if (free && ping) this.P.e.note('note', 'dhcp', s.dev, this.P.e.ownerOf(a) || '', 'ping check', '', `${s.dev}'s ping check: ${t} answers (${this.P.e.ownerOf(a)}): it is skipped`);
      for (let i = 3; i >= 0; i--) {
        v[i]++;
        if (v[i] <= 255) break;
        v[i] = 0;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ DNS: the resolver

  /** The DNS servers of a host: its lease's, else its configured ones. */
  dnsServers(dev: string): IpAddr[] {
    for (const l of this.P.e.leases.values()) if (l.dev === dev && l.dns.length) return l.dns.slice();
    const d = this.P.m.index.devices.get(dev);
    return d && d.dnsServers ? d.dnsServers.map((x) => parseAddress(x) as IpAddr) : [];
  }

  /**
   * Resolve a name for a host: from its cache, else by asking its DNS
   * servers (each twice, 5 s apart); `cb` gets the address or why not.
   */
  resolve(dev: string, name: string, qtype: 'A' | 'AAAA', cb: (r: { addr?: IpAddr; error?: string }) => void): void {
    const key = dnsNameKey(name);
    const c = this.cache.get(dev);
    const hit = c ? c.get(key + '|' + qtype) : undefined;
    if (hit && hit.expires > this.P.e.now) {
      this.P.e.note('table', 'dns', dev, '', 'DNS cache', '', `${dev} has ${key} ${qtype} ${formatAddr(hit.addr)} in its DNS cache (from ${hit.server}; ${durationText(hit.expires - this.P.e.now)} left)`);
      cb({ addr: hit.addr });
      return;
    }
    const servers = this.dnsServers(dev);
    if (!servers.length) {
      cb({ error: `${dev} has no DNS server (none from a DHCP lease, none configured in dns_servers)` });
      return;
    }
    const q: Query = { dev, name: key, qtype, servers, si: 0, attempt: 0, id: ++this.qid, done: false, cb };
    this.queries.set(q.id, q);
    this.ask(q);
  }

  private ask(q: Query): void {
    if (q.done) return;
    if (q.si >= q.servers.length) {
      q.done = true;
      this.queries.delete(q.id);
      q.cb({ error: `DNS: no answer for ${q.name} from ${q.servers.map(formatAddr).join(', ')} (${DNS_ATTEMPTS} × ${durationText(DNS_TIMEOUT)} each; timed out)` });
      return;
    }
    const srv = q.servers[q.si];
    q.attempt++;
    const d: DnsData = { id: q.id, name: q.name, qtype: q.qtype, from: q.dev };
    const m: Msg = { protocol: 'dns', type: 'Query', label: `DNS ${q.qtype}? ${q.name}`, detail: `DNS query from ${q.dev} to ${formatAddr(srv)}:53 (UDP): ${q.qtype}? ${q.name} (id ${q.id}${q.attempt > 1 ? ', attempt ' + q.attempt : ''})`, data: d as unknown as { [k: string]: unknown } };
    const src = this.srcTo(q.dev, srv);
    if (!src) {
      q.done = true;
      this.queries.delete(q.id);
      q.cb({ error: `${q.dev} has no address to ask its DNS server ${formatAddr(srv)} from` });
      return;
    }
    this.P.e.note('message', 'dns', q.dev, this.P.e.ownerOf(srv) || '', 'Query', '', m.detail, this.P.e.now, m);
    const pkt = this.P.e.newPacket(src, srv, '', m);
    pkt.l4 = { proto: 'udp', num: 17, sport: 49152 + (q.id % 16000), dport: 53 };
    pkt.len = 8 + 40;
    this.P.e.send(q.dev, pkt);
    const at = q.attempt;
    // (a retry of a Send test's query is the test's too)
    const test = this.P.e.testCtx;
    this.P.e.after(DNS_TIMEOUT, () => {
      if (q.done || q.attempt !== at) return;
      if (q.attempt >= DNS_ATTEMPTS) {
        q.si++;
        q.attempt = 0;
      }
      this.P.e.withTest(test, () => this.ask(q));
    });
  }

  private srcTo(dev: string, dst: IpAddr): IpAddr | null {
    const sd = this.P.sd(dev);
    if (!sd) return null;
    for (const l of Array.from(sd.l3.values()).sort((a, b) => cmp(a.id, b.id))) for (const a of l.addrs) if (a.addr.version === dst.version && inPrefix(a.net, dst)) return a.addr;
    for (const l of Array.from(sd.l3.values()).sort((a, b) => Number(a.kind === 'loopback') - Number(b.kind === 'loopback') || cmp(a.id, b.id))) for (const a of l.addrs) if (a.addr.version === dst.version) return a.addr;
    return null;
  }

  private dnsIn(dev: string, l3: L3Iface | null, msg: Msg, pkt: Pkt | null): void {
    const d = (msg.data || {}) as unknown as DnsData;
    if (!pkt || !l3) return;
    if (msg.type === 'Response') {
      const q = this.queries.get(d.id);
      if (!q || q.done || q.dev !== dev) return;
      q.done = true;
      this.queries.delete(q.id);
      if (q.forFor) {
        this.reply(q.forFor.dev, q.forFor.l3, q.forFor.q, d.rcode || 'SERVFAIL', d.answer || [], d.ttl || 0, d.cname);
        return;
      }
      if (d.rcode === 'NOERROR' && d.answer && d.answer.length) {
        const a = parseAddress(d.answer[0]) as IpAddr;
        const c = this.cache.get(dev) || new Map();
        c.set(q.name + '|' + q.qtype, { addr: a, expires: this.P.e.now + (d.ttl || 0), server: formatAddr(pkt.src), type: q.qtype });
        this.cache.set(dev, c);
        q.cb({ addr: a });
      } else q.cb({ error: d.rcode === 'NXDOMAIN' ? `DNS: ${q.name} does not exist (NXDOMAIN from ${formatAddr(pkt.src)})` : `DNS: ${formatAddr(pkt.src)} could not resolve ${q.name} (${d.rcode || 'SERVFAIL'})` });
      return;
    }
    if (msg.type !== 'Query') return;
    const sd = this.P.m.index.devices.get(dev);
    const dns = sd && sd.netServices ? sd.netServices.dns : undefined;
    if (!dns) return;
    // a server that listens on one address only answers there
    if (dns.listen && formatAddr(pkt.dst) !== dns.listen) {
      this.P.e.note('drop', 'dns', dev, d.from, 'Query', '', `${dev} listens for DNS on ${dns.listen} only: ${msg.label} to ${formatAddr(pkt.dst)} is not answered`);
      return;
    }
    const zone = dns.zones.filter((z) => inZone(d.name, z.name)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) {
      // not one of its zones: its forwarders (a DNS server of the model), else SERVFAIL
      const fw = dns.forwarders.map((x) => parseAddress(x) as IpAddr).filter((a) => {
        const o = this.P.e.ownerOf(a);
        const od = o ? this.P.m.index.devices.get(o) : undefined;
        return !!od && !!od.netServices && !!od.netServices.dns && od.id !== dev;
      });
      if (fw.length) {
        this.P.e.note('note', 'dns', dev, '', 'forward', '', `${dev} has no zone for ${d.name}: it asks its forwarder ${fw.map(formatAddr).join(', ')}`);
        const q: Query = { dev, name: d.name, qtype: d.qtype, servers: fw, si: 0, attempt: 0, id: ++this.qid, done: false, cb: () => undefined, forFor: { dev, q: pkt, l3 } };
        this.queries.set(q.id, q);
        this.ask(q);
        return;
      }
      this.reply(dev, l3, pkt, 'SERVFAIL', [], 0, undefined, dns.forwarders.length ? 'its forwarders are outside the model' : 'it has no zone for it and no forwarder');
      return;
    }
    const ttl = this.P.e.params.num('dns-ttl', dev, null, zoneRef(dev, zone.name));
    const look = (name: string, depth: number): { answer: string[]; cname?: string } => {
      const recs = this.zoneRecords(dev, zone.name);
      const cn = recs.find((r) => r.name === name && r.type === 'CNAME');
      if (cn && depth < 8) {
        const r = look(dnsNameKey(cn.value), depth + 1);
        return { answer: r.answer, cname: cn.value };
      }
      return { answer: recs.filter((r) => r.name === name && r.type === d.qtype).map((r) => r.value) };
    };
    const r = look(d.name, 0);
    if (!r.answer.length) {
      const exists = this.zoneRecords(dev, zone.name).some((x) => x.name === d.name);
      this.reply(dev, l3, pkt, exists ? 'NOERROR' : 'NXDOMAIN', [], ttl, r.cname);
      return;
    }
    this.reply(dev, l3, pkt, 'NOERROR', r.answer, ttl, r.cname);
  }

  private reply(dev: string, l3: L3Iface, q: Pkt, rcode: DnsData['rcode'], answer: string[], ttl: number, cname?: string, why?: string): void {
    const d = (q.msg.data || {}) as unknown as DnsData;
    const a: DnsData = { id: d.id, name: d.name, qtype: d.qtype, from: dev, answer, rcode, ttl, cname };
    const label = rcode === 'NOERROR' && answer.length ? `DNS ${d.qtype} ${d.name} = ${answer[0]}` : rcode === 'NXDOMAIN' ? `DNS NXDOMAIN ${d.name}` : rcode === 'NOERROR' ? `DNS ${d.qtype} ${d.name}: no record` : `DNS SERVFAIL ${d.name}`;
    const m: Msg = { protocol: 'dns', type: 'Response', label, detail: `DNS response from ${dev} to ${formatAddr(q.src)}: ${rcode}${answer.length ? ` ${d.name}${cname ? ' (CNAME ' + cname + ')' : ''} ${d.qtype} ${answer.join(', ')}, TTL ${durationText(ttl)}` : ` for ${d.qtype}? ${d.name}`}${why ? ` (${why})` : ''}`, data: a as unknown as { [k: string]: unknown } };
    this.P.e.note('message', 'dns', dev, d.from, 'Response', '', m.detail, this.P.e.now, m);
    const pkt = this.P.e.newPacket(q.dst, q.src, q.vrf, m);
    pkt.l4 = { proto: 'udp', num: 17, sport: 53, dport: q.l4 && q.l4.sport ? q.l4.sport : 53 };
    pkt.len = 8 + 60;
    void l3;
    this.P.e.send(dev, pkt);
  }

  /** A server's zone: the model's DNS names in it (A / AAAA), and its own records. */
  zoneRecords(dev: string, zone: string): Array<{ name: string; type: string; value: string; source: string }> {
    const d = this.P.m.index.devices.get(dev);
    const z = d && d.netServices && d.netServices.dns ? d.netServices.dns.zones.find((x) => x.name === zone) : undefined;
    if (!z) return [];
    const out = derivedRecords(this.P.m, zone).map((r) => ({ name: r.fqdn, type: r.type as string, value: r.value, source: r.source }));
    for (const r of z.records) out.push({ name: recordFqdn(zone, r.name), type: r.type, value: r.value, source: 'zone record' });
    return out;
  }

  // ------------------------------------------------------------ tables

  /** A server's leases (Show DHCP leases). */
  leaseRows(dev: string): LeaseRow[] {
    const out: LeaseRow[] = [];
    for (const s of this.scopes) if (s.dev === dev) for (const l of s.leases.values()) if (l.expires > this.P.e.now) out.push(l);
    return out.sort((a, b) => compareAddr(parseAddress(a.ip) as IpAddr, parseAddress(b.ip) as IpAddr));
  }

  /** Is a name in a host's cache (not expired)? */
  cached(dev: string, name: string, qtype: 'A' | 'AAAA'): boolean {
    const c = this.cache.get(dev);
    const hit = c ? c.get(dnsNameKey(name) + '|' + qtype) : undefined;
    return !!hit && hit.expires > this.P.e.now;
  }

  /** A host's resolver cache (Show DNS cache). */
  cacheRows(dev: string): DnsCacheRow[] {
    const c = this.cache.get(dev);
    if (!c) return [];
    const out: DnsCacheRow[] = [];
    for (const [k, v] of c) if (v.expires > this.P.e.now) out.push({ name: k.split('|')[0], type: v.type, value: formatAddr(v.addr), server: v.server, expires: v.expires });
    return out.sort((a, b) => cmp(a.name, b.name));
  }

  /** A server's zones (Show DNS zone). */
  zoneRows(dev: string): ZoneRow[] {
    const d = this.P.m.index.devices.get(dev);
    const dns = d && d.netServices ? d.netServices.dns : undefined;
    if (!dns) return [];
    const out: ZoneRow[] = [];
    for (const z of dns.zones) {
      const ttl = durationText(this.P.e.params.num('dns-ttl', dev, null, zoneRef(dev, z.name)));
      for (const r of this.zoneRecords(dev, z.name)) out.push({ zone: z.name, name: r.name, type: r.type, value: r.value, source: r.source, ttl });
    }
    return out;
  }

  /** A server's scopes, one line each (above its lease table). */
  scopeNotes(dev: string): string[] {
    return this.scopes.filter((s) => s.dev === dev).map((s) => `Scope ${s.index + 1}: ${prefixText(s.net)}, ${formatAddr(s.start)}–${formatAddr(s.end)}${s.gateway ? ', gateway ' + formatAddr(s.gateway) : ''}${s.dns.length ? ', DNS ' + s.dns.map(formatAddr).join(', ') : ''}, lease ${durationText(s.lease)}${s.exclude.size ? `, ${s.exclude.size} excluded` : ''}${s.res.size ? `, ${s.res.size} reserved` : ''}`);
  }

  /** A DNS server's settings (above its zone table). */
  zoneNotes(dev: string): string[] {
    const d = this.P.m.index.devices.get(dev);
    const dns = d && d.netServices ? d.netServices.dns : undefined;
    if (!dns) return [];
    const out = [`Zones: ${dns.zones.map((z) => z.name).join(', ')}; listens on ${dns.listen || 'all its addresses'}`];
    if (dns.forwarders.length) out.push(`Forwarders: ${dns.forwarders.join(', ')}`);
    if (dns.reverse.length) out.push(`Reverse zones: ${dns.reverse.join(', ')}`);
    return out;
  }

  /** Is the device a DHCP server, a DNS server, does it resolve names (for its tables)? */
  hasLeases(dev: string): boolean {
    return this.isServer(dev);
  }

  hasZones(dev: string): boolean {
    const d = this.P.m.index.devices.get(dev);
    return !!d && !!d.netServices && !!d.netServices.dns;
  }

  resolves(dev: string): boolean {
    return this.dnsServers(dev).length > 0 || this.cache.has(dev);
  }
}

function isBroadcast(a: IpAddr): boolean {
  return a.version === 4 && a.bytes.every((b) => b === 255);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

/** "1 d", "12 h", "30 min" */
function leaseText(ms: number): string {
  if (ms % 86400000 === 0) return `${ms / 86400000} d`;
  if (ms % 3600000 === 0) return `${ms / 3600000} h`;
  if (ms % 60000 === 0) return `${ms / 60000} min`;
  return durationText(ms);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The model's DHCP servers and clients, DNS servers and resolvers: is there any (for the setup)? */
export function hasNetServices(model: Model): boolean {
  return model.devices.some((d: Device) => !!d.netServices || (d.dnsServers && d.dnsServers.length > 0) || deviceInterfaces(d).some((i) => i.dhcp));
}

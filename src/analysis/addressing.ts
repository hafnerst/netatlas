/**
 * The addressing overview: every network, grouped by VRF and nested by
 * containing prefix (a supernet tree), with its members, gateways and
 * virtual addresses, and how its address space is allocated; the addresses
 * that are used twice in one scope, prefixes that overlap and addresses in
 * no network.
 *
 * A network has no VRF of its own in the format: it is in the VRFs of the
 * interfaces that are its members (by address, as everywhere else) and of
 * the DHCP clients on cables carrying it. A network without either is listed
 * in the default table.
 *
 * Allocation. Each host address of a network is counted once, in the first
 * of these states that applies:
 *
 *   configured   an interface's address or a redundancy group's virtual
 *                address (in this listing's address space: its own VRF, and
 *                the members of other VRFs on the same switched segment, a
 *                router's VLAN interface in a VRF and the hosts behind it);
 *   reserved     a DHCP reservation, a DHCP scope's gateway, a gateway that
 *                routes name (a default route's next hop) that no interface
 *                has;
 *   acquired     in a simulation snapshot: an address a DHCP lease, SLAAC
 *                or DHCPv6 gave an interface;
 *   DHCP pool    the rest of a DHCP scope's range (its excluded addresses are
 *                not leased: they are not in the pool);
 *   subnets      the addresses of nested networks;
 *   unallocated  everything else: "unallocated in the model", the only
 *                addresses suggested for a static address (the next
 *                unallocated one). Nothing outside the model is known: an
 *                address the model leaves unallocated may be in use.
 *
 * Host usage (configured, reserved, acquired addresses) and prefix
 * allocation (pools and nested networks besides) are reported apart, so a
 * parent prefix with few hosts of its own is not taken for empty.
 *
 * Duplicates are judged in the scope the model establishes: a link-local
 * address (fe80::/10, 169.254.0.0/16) only within its segment; any other
 * address within a VRF and a connected part of the architecture
 * (analysis/scope.ts). An address used in two parts the model does not join
 * is reuse, listed apart; where an owner's scope is not known (no cable, no
 * relation), it is a possible conflict, never a definitive one.
 *
 * Everything is sorted by value, so the result does not depend on the order
 * of the file.
 */
import { linkNetworks, networkMembers } from '../model/derive';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { autoIpv6, Ipv6Method } from '../model/ipv6';
import { Interface, Model, deviceInterfaces, ifaceKey } from '../model/types';
import { virtualGateways } from './identity';
import { AddrRange, addrBig, bigAddr, compareAddr, comparePrefix, count64, formatAddr, freeRanges, hostCount, inPrefix, networkOf, prefixCovers, prefixRange, prefixText } from './ipmath';
import { routeRef, vrfKey, vrfName } from './routing';
import { AddrMethod, AnalysisSnapshot } from './snapshot';
import { architectureParts, isLinkLocal, joined, segmentOf } from './scope';

/** An address of an interface in a network. */
export interface AddrUse {
  device: string;
  iface: string;
  /** as written */
  address: string;
  /** canonical, without prefix length */
  text: string;
  /** the interface's DNS names */
  dns: string[];
  loopback: boolean;
  /** how it was obtained: configured (static), or acquired in a snapshot (DHCPv4, SLAAC, DHCPv6) */
  method: AddrMethod;
  /** a snapshot's acquired address: its state (bound, tentative, preferred, deprecated, duplicate) */
  state?: string;
}

/** An interface that gets its address by DHCP, on a cable that carries the network (by VLAN). */
export interface DhcpClient {
  device: string;
  iface: string;
  dns: string[];
  /** the link that carries the network to it */
  link: string;
}

/** An interface that configures its IPv6 address itself (SLAAC, DHCPv6), on a cable that carries the network: its configured intent. */
export interface AutoClient {
  device: string;
  iface: string;
  method: Ipv6Method;
  link: string;
}

/** A DHCP scope's pool in a network. */
export interface DhcpPool {
  /** the server */
  device: string;
  /** "10.1.1.100-10.1.1.199" */
  range: string;
  first: bigint;
  last: bigint;
  /** the scope's excluded addresses (not leased) and reservations */
  excluded: string[];
  reservations: Array<{ ip: string; mac: string }>;
  gateway?: string;
}

/** A gateway or virtual address of a network. */
export interface Gateway {
  /** canonical address */
  text: string;
  kind: 'vip' | 'gateway';
  /** what says so: "VRRP vrrp-10", "vrrp-virtual-ip of dist:Vlan10", "default route of pc1, pc2" */
  source: string;
  refs: string[];
}

/** How a network's host addresses are allocated: each counted once, in the first state that applies (see the module comment). */
export interface Allocation {
  configured: bigint;
  reserved: bigint;
  acquired: bigint;
  pool: bigint;
  /** host addresses in nested networks */
  subnets: bigint;
  unallocated: bigint;
}

export interface NetEntry {
  id: string;
  label: string;
  vlan?: number;
  prefix: IpPrefix;
  /** the prefix as text (canonical) */
  text: string;
  version: 4 | 6;
  /** the VRF of this listing ('' = default table), and the other VRFs the network is listed in */
  vrf: string;
  otherVrfs: string[];
  /** other VRFs whose members share this listing's address space (the same switched segment) */
  space: string[];
  /** the network it is nested in (the smallest containing one of the same VRF), and how deep */
  parent: string | null;
  depth: number;
  children: string[];
  /** the addresses in it that no nested network holds (configured, then a snapshot's acquired ones), and the DHCP and IPv6 autoconfiguration clients (gateways likewise: those of a nested network are listed there) */
  members: AddrUse[];
  dhcp: DhcpClient[];
  auto: AutoClient[];
  pools: DhcpPool[];
  /** addresses in nested networks */
  nestedUsed: number;
  gateways: Gateway[];
  /** distinct host addresses in use in the prefix (configured, reserved, acquired; nested networks' included) */
  used: bigint;
  /** host addresses of the prefix (IPv4: without network and broadcast address, except /31, /32) */
  size: bigint;
  /** IPv4: used / size in percent (host usage); IPv6: null (a percentage of 2^64 means nothing) */
  percent: number | null;
  /** IPv4: the allocated share of the prefix in percent (everything but unallocated); IPv6: null */
  allocatedPercent: number | null;
  alloc: Allocation;
  /** IPv6: the number of /64 subnets of the prefix (0 for a prefix longer than /64) */
  nets64: bigint | null;
  /** unallocated host addresses (outside nested networks, pools and anything in use) */
  free: AddrRange[];
  /** the lowest unallocated address with the network's prefix length ("10.0.0.7/24"), or null */
  nextFree: string | null;
}

export interface VrfGroup {
  /** '' = the default table */
  vrf: string;
  name: string;
  /** in tree order: each network followed by the networks nested in it */
  networks: NetEntry[];
}

export interface DuplicateAddr {
  vrf: string;
  text: string;
  owners: Array<{ device: string; iface: string }>;
  /** conflict: the model puts the owners in one scope; possible: an owner's scope is not known */
  certainty: 'conflict' | 'possible';
  /** the scope in words */
  why: string;
}

/** An address used more than once where the model separates the uses: not a conflict. */
export interface ReusedAddr {
  vrf: string;
  text: string;
  owners: Array<{ device: string; iface: string }>;
  why: string;
}

export interface PrefixOverlap {
  vrf: string;
  kind: 'same-prefix' | 'interface-subnet';
  message: string;
  refs: string[];
}

export interface Orphan {
  vrf: string;
  device: string;
  iface: string;
  address: string;
  loopback: boolean;
}

export interface AddressingOverview {
  vrfs: VrfGroup[];
  duplicates: DuplicateAddr[];
  reused: ReusedAddr[];
  overlaps: PrefixOverlap[];
  orphans: Orphan[];
  /** the snapshot's time, when the overview includes its acquired addresses */
  snapshotAt?: number;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const vrfOrder = (a: string, b: string): number => (a === '' ? (b === '' ? 0 : -1) : b === '' ? 1 : cmpStr(a, b));
const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
const ZERO = BigInt(0);
const ONE = BigInt(1);

function dnsOf(model: Model, device: string, iface: string): string[] {
  const d = model.index.devices.get(device);
  return d ? d.dnsNames.filter((n) => n.interfaces.indexOf(iface) >= 0).map((n) => n.name).sort() : [];
}

function host(text: string): IpAddr | null {
  const p = parsePrefix(text, false);
  return p ? { version: p.version, bytes: p.bytes } : null;
}

/** Merged, sorted ranges. */
function union(rs: AddrRange[]): AddrRange[] {
  const s = rs.slice().sort((a, b) => cmpBig(a.first, b.first));
  const out: AddrRange[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.first <= last.last + ONE) {
      if (r.last > last.last) last.last = r.last;
    } else out.push({ first: r.first, last: r.last });
  }
  return out;
}

function inRanges(rs: AddrRange[], v: bigint): boolean {
  return rs.some((r) => v >= r.first && v <= r.last);
}

function rangesCount(rs: AddrRange[], lo: bigint, hi: bigint): bigint {
  let n = ZERO;
  for (const r of rs) {
    const a = r.first < lo ? lo : r.first;
    const b = r.last > hi ? hi : r.last;
    if (b >= a) n += b - a + ONE;
  }
  return n;
}

/** The prefix's host addresses (IPv4 without the network and broadcast address, except /31, /32). */
function hostRange(p: IpPrefix): { lo: bigint; hi: bigint } {
  const r = prefixRange(p);
  if (p.version === 4 && p.prefix < 31) return { lo: r.first + ONE, hi: r.last - ONE };
  return { lo: r.first, hi: r.last };
}

const caches = new WeakMap<Model, AddressingOverview>();
const snapCaches = new WeakMap<AnalysisSnapshot, WeakMap<Model, AddressingOverview>>();

/** The overview of the configured model, or with a simulation snapshot's acquired addresses. */
export function addressingOverview(model: Model, snap: AnalysisSnapshot | null = null): AddressingOverview {
  const byModel = snap ? snapCaches.get(snap) : null;
  const known = snap ? (byModel ? byModel.get(model) : undefined) : caches.get(model);
  if (known) return known;
  const out = compute(model, snap);
  if (snap) {
    let m = snapCaches.get(snap);
    if (!m) snapCaches.set(snap, (m = new WeakMap()));
    m.set(model, out);
  } else caches.set(model, out);
  return out;
}

function compute(model: Model, snap: AnalysisSnapshot | null): AddressingOverview {
  const iface = (device: string, id: string): Interface | undefined => model.index.interfaces.get(ifaceKey(device, id));
  // ---- each network's prefix, members (per VRF), DHCP and IPv6 autoconfiguration clients, pools
  interface Slot {
    uses: AddrUse[];
    dhcp: DhcpClient[];
    auto: AutoClient[];
  }
  interface Raw {
    id: string;
    prefix: IpPrefix;
    byVrf: Map<string, Slot>;
    pools: DhcpPool[];
    /** VRF listings that share an address space (union-find roots) */
    space: Map<string, string>;
  }
  const raws: Raw[] = [];
  for (const n of model.networks) {
    const p = n.cidr ? parsePrefix(n.cidr) : null;
    if (!p) continue;
    const byVrf = new Map<string, Slot>();
    const slot = (v: string): Slot => {
      if (!byVrf.has(v)) byVrf.set(v, { uses: [], dhcp: [], auto: [] });
      return byVrf.get(v) as Slot;
    };
    for (const m of networkMembers(model, n.id)) {
      for (const x of m.matches) {
        const a = host(x.address);
        const i = iface(x.device, x.iface);
        if (!a || !i) continue;
        slot(vrfKey(i.vrf)).uses.push({ device: x.device, iface: x.iface, address: x.address, text: formatAddr(a), dns: dnsOf(model, x.device, x.iface), loopback: x.loopback, method: 'static' });
      }
    }
    for (const l of model.links) {
      if (linkNetworks(model, l).indexOf(n.id) < 0) continue;
      for (const e of [l.a, l.b]) {
        const i = e.iface !== undefined ? iface(e.device, e.iface) : undefined;
        if (!i) continue;
        if (i.dhcp && p.version === 4) slot(vrfKey(i.vrf)).dhcp.push({ device: i.device, iface: i.id, dns: dnsOf(model, i.device, i.id), link: l.id });
        if (p.version === 6 && autoIpv6(i.ipv6)) slot(vrfKey(i.vrf)).auto.push({ device: i.device, iface: i.id, method: i.ipv6 as Ipv6Method, link: l.id });
      }
    }
    // a snapshot's acquired addresses in the prefix (link-local ones are in no network)
    if (snap) {
      for (const a of snap.addresses) {
        if (a.method === 'link-local' || a.state === 'duplicate') continue;
        const ad = parseAddress(a.text);
        if (!ad || ad.version !== p.version || !inPrefix(p, ad)) continue;
        slot(a.vrf).uses.push({ device: a.device, iface: a.iface, address: a.address, text: a.text, dns: dnsOf(model, a.device, a.iface), loopback: false, method: a.method, state: a.state });
      }
    }
    if (!byVrf.size) slot('');
    const pools: DhcpPool[] = [];
    for (const d of model.devices) {
      const dh = d.netServices ? d.netServices.dhcp : undefined;
      for (const s of dh ? dh.scopes : []) {
        if (s.network !== n.id || s.start === undefined || s.end === undefined) continue;
        const a = parseAddress(s.start);
        const b = parseAddress(s.end);
        if (!a || !b || a.version !== p.version) continue;
        const pool: DhcpPool = { device: d.id, range: s.range || `${s.start}-${s.end}`, first: addrBig(a), last: addrBig(b), excluded: s.exclude.slice(), reservations: s.reservations.map((r) => ({ ip: r.ip, mac: r.mac })) };
        if (s.gateway !== undefined) pool.gateway = s.gateway;
        pools.push(pool);
      }
    }
    pools.sort((x, y) => cmpBig(x.first, y.first) || cmpStr(x.device, y.device));
    raws.push({ id: n.id, prefix: networkOf(p), byVrf, pools, space: new Map() });
  }
  // ---- which VRF listings of a network share an address space: a member of one on the segment of a member (or client) of the other
  for (const r of raws) {
    const vrfs = Array.from(r.byVrf.keys()).sort(vrfOrder);
    const root = new Map(vrfs.map((v) => [v, v] as [string, string]));
    const find = (v: string): string => {
      let x = v;
      while (root.get(x) !== x) x = root.get(x) as string;
      return x;
    };
    if (vrfs.length > 1) {
      const n = model.index.networks.get(r.id);
      const vlan = n ? n.vlan : undefined;
      const ends = (s: Slot): Array<{ device: string; iface: string }> => s.uses.map((u) => ({ device: u.device, iface: u.iface })).concat(s.dhcp.map((c) => ({ device: c.device, iface: c.iface })), s.auto.map((c) => ({ device: c.device, iface: c.iface })));
      for (let x = 0; x < vrfs.length; x++) {
        const seg = new Set<string>();
        for (const e of ends(r.byVrf.get(vrfs[x]) as Slot)) {
          const s = segmentOf(model, e.device, e.iface, vlan);
          if (s) s.forEach((k) => seg.add(k));
        }
        for (let y = x + 1; y < vrfs.length; y++) {
          if (ends(r.byVrf.get(vrfs[y]) as Slot).some((e) => seg.has(e.device + ':' + e.iface))) {
            const a = find(vrfs[x]);
            const b = find(vrfs[y]);
            if (a !== b) root.set(vrfOrder(a, b) <= 0 ? b : a, vrfOrder(a, b) <= 0 ? a : b);
          }
        }
      }
    }
    for (const v of vrfs) r.space.set(v, find(v));
  }
  // ---- gateways and virtual addresses, by VRF
  interface RawGw {
    vrf: string | null;
    addr: IpAddr;
    kind: 'vip' | 'gateway';
    source: string;
    refs: string[];
  }
  const gws: RawGw[] = [];
  // the virtual address of a redundancy group, once per VRF, from its members' interfaces
  for (const g of virtualGateways(model)) {
    const i = model.index.interfaces.get(g.device + ':' + g.iface);
    const vrf = vrfKey(i ? i.vrf : undefined);
    const same = gws.find((x) => x.kind === 'vip' && x.vrf === vrf && compareAddr(x.addr, g.address) === 0);
    if (same) {
      same.refs.push(`iface:${g.device}:${g.iface}`);
      continue;
    }
    gws.push({ vrf, addr: g.address, kind: 'vip', source: `${(model.services.get(g.service) || { label: g.service }).label}${g.group !== undefined ? ' group ' + g.group : ''}`, refs: [`iface:${g.device}:${g.iface}`] });
  }
  for (const d of model.devices) {
    // a default route's next hop is the gateway of the network it lies in
    for (const rt of d.routes) {
      if (rt.via === undefined || !/\/0$/.test(rt.prefix)) continue;
      const a = host(rt.via);
      if (a) gws.push({ vrf: vrfKey(rt.vrf), addr: a, kind: 'gateway', source: d.id, refs: [routeRef(rt)] });
    }
  }
  // ---- the listing of each VRF
  const vrfSet = new Set<string>();
  for (const r of raws) r.byVrf.forEach((_, v) => vrfSet.add(v));
  const vrfs: VrfGroup[] = [];
  for (const vrf of Array.from(vrfSet).sort(vrfOrder)) {
    const here = raws.filter((r) => r.byVrf.has(vrf)).sort((a, b) => comparePrefix(a.prefix, b.prefix) || cmpStr(a.id, b.id));
    // the parent: the smallest strictly larger containing prefix (a network with the same prefix is a sibling)
    const parent = new Map<string, string | null>();
    for (const r of here) {
      let best: Raw | null = null;
      for (const o of here) {
        if (o === r || o.prefix.prefix >= r.prefix.prefix || !prefixCovers(o.prefix, r.prefix)) continue;
        if (!best || o.prefix.prefix > best.prefix.prefix || (o.prefix.prefix === best.prefix.prefix && o.id < best.id)) best = o;
      }
      parent.set(r.id, best ? best.id : null);
    }
    const kids = (id: string | null): Raw[] => here.filter((r) => parent.get(r.id) === id);
    const entries: NetEntry[] = [];
    const visit = (r: Raw, depth: number): void => {
      const n = model.index.networks.get(r.id) as NonNullable<ReturnType<typeof model.index.networks.get>>;
      const own = r.byVrf.get(vrf) as Slot;
      // this listing's address space: its own VRF and the listings on its segment
      const spaceRoot = r.space.get(vrf) as string;
      const spaceVrfs = Array.from(r.byVrf.keys()).filter((v) => r.space.get(v) === spaceRoot);
      const spaceUses: AddrUse[] = [];
      for (const v of spaceVrfs) for (const u of (r.byVrf.get(v) as Slot).uses) spaceUses.push(u);
      const children = kids(r.id);
      const childRanges = union(children.map((c) => prefixRange(c.prefix)));
      const inChild = (u: AddrUse): boolean => inRanges(childRanges, addrBig(host(u.address) as IpAddr));
      const sortUse = (a: AddrUse, b: AddrUse): number => cmpBig(addrBig(host(a.address) as IpAddr), addrBig(host(b.address) as IpAddr)) || cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface);
      const members = own.uses.filter((u) => !inChild(u)).sort(sortUse);
      const nested = own.uses.filter(inChild);
      const gw = new Map<string, Gateway>();
      const nestedVip = new Set<string>();
      for (const g of gws) {
        if ((g.vrf !== null && spaceVrfs.indexOf(g.vrf) < 0) || g.addr.version !== r.prefix.version || !inPrefix(r.prefix, g.addr)) continue;
        // a gateway in a nested network is that network's (it still counts as used here)
        const isOwn = !children.some((c) => inPrefix(c.prefix, g.addr));
        const text = formatAddr(g.addr);
        const key = g.kind + ' ' + text;
        const cur = gw.get(key);
        if (!isOwn) {
          nestedVip.add(g.kind + ' ' + addrBig(g.addr).toString());
          continue;
        }
        if (!cur) gw.set(key, { text, kind: g.kind, source: g.kind === 'gateway' ? 'default route of ' + g.source : g.source, refs: g.refs.slice() });
        else {
          if (g.kind === 'gateway') cur.source += ', ' + g.source;
          else if (cur.source.split('; ').indexOf(g.source) < 0) cur.source += '; ' + g.source;
          for (const ref of g.refs) if (cur.refs.indexOf(ref) < 0) cur.refs.push(ref);
        }
      }
      const gateways = Array.from(gw.values()).sort((a, b) => cmpBig(addrBig(host(a.text) as IpAddr), addrBig(host(b.text) as IpAddr)) || cmpStr(a.kind, b.kind));
      // ---- allocation (each address once, by precedence)
      const { lo, hi } = hostRange(r.prefix);
      const inHost = (v: bigint): boolean => v >= lo && v <= hi;
      const configured = new Set<string>();
      const acquired = new Set<string>();
      const usedAll = new Set<string>();
      for (const u of spaceUses) {
        const v = addrBig(host(u.address) as IpAddr);
        if (!inHost(v)) continue;
        usedAll.add(v.toString());
        if (inRanges(childRanges, v)) continue;
        if (u.method === 'static') configured.add(v.toString());
        else acquired.add(v.toString());
      }
      for (const g of gateways) if (g.kind === 'vip') configured.add(addrBig(host(g.text) as IpAddr).toString());
      nestedVip.forEach((k) => {
        if (k.indexOf('vip ') === 0) usedAll.add(k.slice(4));
      });
      for (const g of gateways) if (g.kind === 'vip') usedAll.add(addrBig(host(g.text) as IpAddr).toString());
      const reserved = new Set<string>();
      const reserve = (text: string | undefined): void => {
        const a = text !== undefined ? parseAddress(text) : null;
        if (!a || a.version !== r.prefix.version || !inPrefix(r.prefix, a)) return;
        const k = addrBig(a).toString();
        if (inRanges(childRanges, addrBig(a)) || configured.has(k)) return;
        reserved.add(k);
      };
      for (const g of gateways) if (g.kind === 'gateway') reserve(g.text);
      for (const pl of r.pools) {
        reserve(pl.gateway);
        for (const x of pl.reservations) reserve(x.ip);
      }
      reserved.forEach((k) => usedAll.add(k));
      acquired.forEach((k) => {
        if (configured.has(k) || reserved.has(k)) acquired.delete(k);
      });
      // the pools: their ranges without the excluded addresses
      const poolRanges: AddrRange[] = [];
      for (const pl of r.pools) {
        const cut = pl.excluded
          .map((e) => parseAddress(e))
          .filter((a): a is IpAddr => !!a)
          .map((a) => addrBig(a))
          .sort(cmpBig);
        let cur = pl.first;
        for (const x of cut) {
          if (x < cur || x > pl.last) continue;
          if (x > cur) poolRanges.push({ first: cur, last: x - ONE });
          cur = x + ONE;
        }
        if (cur <= pl.last) poolRanges.push({ first: cur, last: pl.last });
      }
      const pools = union(poolRanges).filter((x) => x.last >= lo && x.first <= hi);
      const inPoolNoChild = (k: string): boolean => {
        const v = BigInt(k);
        return inRanges(pools, v) && !inRanges(childRanges, v);
      };
      let poolTaken = ZERO;
      for (const set of [configured, reserved, acquired]) set.forEach((k) => {
        if (inPoolNoChild(k)) poolTaken++;
      });
      const poolAll = rangesCount(pools, lo, hi);
      let poolInChild = ZERO;
      for (const c of childRanges) for (const x of pools) {
        const a = c.first > x.first ? c.first : x.first;
        const b = c.last < x.last ? c.last : x.last;
        if (b >= a) poolInChild += b - a + ONE;
      }
      const subnets = rangesCount(childRanges, lo, hi);
      const size = hostCount(r.prefix);
      const alloc: Allocation = {
        configured: BigInt(configured.size),
        reserved: BigInt(reserved.size),
        acquired: BigInt(acquired.size),
        pool: poolAll - poolInChild - poolTaken,
        subnets,
        unallocated: ZERO,
      };
      const taken = alloc.configured + alloc.reserved + alloc.acquired + alloc.pool + alloc.subnets;
      alloc.unallocated = size > taken ? size - taken : ZERO;
      const usedBig = Array.from(usedAll).map((s) => BigInt(s));
      const free = freeRanges(r.prefix, usedBig, childRanges.concat(pools));
      entries.push({
        id: r.id,
        label: n.label || n.id,
        vlan: n.vlan,
        prefix: r.prefix,
        text: prefixText(r.prefix),
        version: r.prefix.version,
        vrf,
        otherVrfs: Array.from(r.byVrf.keys()).filter((v) => v !== vrf).sort(vrfOrder),
        space: spaceVrfs.filter((v) => v !== vrf).sort(vrfOrder),
        parent: parent.get(r.id) || null,
        depth,
        children: children.map((c) => c.id),
        members,
        dhcp: own.dhcp.slice().sort((a, b) => cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface)),
        auto: own.auto.slice().sort((a, b) => cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface)),
        pools: r.pools,
        nestedUsed: nested.length,
        gateways,
        used: BigInt(usedAll.size),
        size,
        percent: r.prefix.version === 4 ? (size > ZERO ? Math.round((usedAll.size * 1000) / Number(size)) / 10 : 0) : null,
        allocatedPercent: r.prefix.version === 4 ? (size > ZERO ? Math.round((Number(size - alloc.unallocated) * 1000) / Number(size)) / 10 : 0) : null,
        alloc,
        nets64: r.prefix.version === 6 ? count64(r.prefix) : null,
        free,
        nextFree: firstFree(r.prefix, free),
      });
      for (const c of children) visit(c, depth + 1);
    };
    for (const r of kids(null)) visit(r, 0);
    vrfs.push({ vrf, name: vrfName(vrf), networks: entries });
  }
  // ---- duplicates, reuse, overlaps and orphans
  const orphans: Orphan[] = [];
  const overlaps: PrefixOverlap[] = [];
  const byAddr = new Map<string, { vrf: string; addr: IpAddr; owners: Array<{ device: string; iface: string }> }>();
  const nets = model.networks.map((n) => ({ n, p: n.cidr ? parsePrefix(n.cidr) : null })).filter((x): x is { n: (typeof model.networks)[number]; p: IpPrefix } => !!x.p);
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      const vrf = vrfKey(i.vrf);
      for (const address of i.addresses) {
        const p = parsePrefix(address, false);
        if (!p) continue;
        const a: IpAddr = { version: p.version, bytes: p.bytes };
        const k = vrf + '|' + p.version + '|' + addrBig(a).toString();
        const cur = byAddr.get(k) || { vrf, addr: a, owners: [] };
        if (!cur.owners.some((o) => o.device === d.id && o.iface === i.id)) cur.owners.push({ device: d.id, iface: i.id });
        byAddr.set(k, cur);
        const containing = nets.filter((x) => x.p.version === a.version && inPrefix(x.p, a));
        if (!containing.length && !isLinkLocal(a.bytes, a.version)) orphans.push({ vrf, device: d.id, iface: i.id, address, loopback: i.type === 'loopback' });
        // an interface whose subnet is larger than a network holding its address: the masks disagree
        const written = address.indexOf('/') >= 0;
        const narrower = written ? containing.filter((x) => x.p.prefix > p.prefix && (raws.find((r) => r.id === x.n.id) as Raw).byVrf.has(vrf)) : [];
        if (narrower.length) {
          narrower.sort((x, y) => comparePrefix(x.p, y.p) || cmpStr(x.n.id, y.n.id));
          overlaps.push({
            vrf,
            kind: 'interface-subnet',
            message: `${d.id}:${i.id} ${address}: its subnet ${prefixText(networkOf(p))} is larger than ${narrower.map((x) => `network ${x.n.id} (${prefixText(networkOf(x.p))})`).join(', ')}`,
            refs: [`iface:${d.id}:${i.id}`].concat(narrower.map((x) => 'network:' + x.n.id)),
          });
        }
      }
    }
  }
  const { duplicates, reused } = scopedDuplicates(model, Array.from(byAddr.values()));
  for (const g of vrfs) {
    const list = g.networks;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        if (comparePrefix(list[x].prefix, list[y].prefix) !== 0) continue;
        overlaps.push({ vrf: g.vrf, kind: 'same-prefix', message: `networks ${list[x].id} and ${list[y].id} have the same prefix ${list[x].text}`, refs: ['network:' + list[x].id, 'network:' + list[y].id] });
      }
    }
  }
  const byText = (a: { vrf: string; text: string }, b: { vrf: string; text: string }): number => vrfOrder(a.vrf, b.vrf) || cmpBig(addrBig(host(a.text) as IpAddr), addrBig(host(b.text) as IpAddr)) || (host(a.text) as IpAddr).version - (host(b.text) as IpAddr).version;
  const ov: AddressingOverview = {
    vrfs,
    duplicates: duplicates.sort(byText),
    reused: reused.sort(byText),
    overlaps: overlaps.sort((a, b) => vrfOrder(a.vrf, b.vrf) || cmpStr(a.kind, b.kind) || cmpStr(a.message, b.message)),
    orphans: orphans.sort((a, b) => vrfOrder(a.vrf, b.vrf) || cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface) || cmpStr(a.address, b.address)),
  };
  if (snap) ov.snapshotAt = snap.at;
  return ov;
}

/**
 * Split the addresses used more than once into conflicts (one scope),
 * possible conflicts (an owner's scope is not known) and reuse (scopes the
 * model separates). Link-local: the segment; else the VRF and the part.
 */
function scopedDuplicates(model: Model, list: Array<{ vrf: string; addr: IpAddr; owners: Array<{ device: string; iface: string }> }>): { duplicates: DuplicateAddr[]; reused: ReusedAddr[] } {
  const duplicates: DuplicateAddr[] = [];
  const reused: ReusedAddr[] = [];
  const parts = architectureParts(model);
  const sortO = (os: Array<{ device: string; iface: string }>): Array<{ device: string; iface: string }> => os.slice().sort((a, b) => cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface));
  for (const v of list) {
    if (v.owners.length < 2) continue;
    const owners = sortO(v.owners);
    const text = formatAddr(v.addr);
    if (isLinkLocal(v.addr.bytes, v.addr.version)) {
      // a link-local address is unique only on its link: the owners on one segment conflict
      const segs = owners.map((o) => segmentOf(model, o.device, o.iface));
      const groups: Array<Array<{ device: string; iface: string }>> = [];
      const unknown: Array<{ device: string; iface: string }> = [];
      owners.forEach((o, k) => {
        if (!segs[k]) {
          unknown.push(o);
          return;
        }
        const g = groups.find((x) => x.some((y) => (segs[k] as Set<string>).has(y.device + ':' + y.iface)));
        if (g) g.push(o);
        else groups.push([o]);
      });
      for (const g of groups) if (g.length > 1) duplicates.push({ vrf: v.vrf, text, owners: g, certainty: 'conflict', why: 'link-local on one switched segment' });
      if (unknown.length && owners.length > 1) {
        if (unknown.length === owners.length || groups.length) duplicates.push({ vrf: v.vrf, text, owners, certainty: 'possible', why: `link-local: the segment of ${unknown.map((o) => o.device + ':' + o.iface).join(', ')} is not modeled (no cable)` });
      }
      if (!unknown.length && groups.every((g) => g.length === 1)) reused.push({ vrf: v.vrf, text, owners, why: 'link-local on different links (interface-scoped)' });
      continue;
    }
    const lone = owners.filter((o) => !joined(model, o.device));
    if (lone.length) {
      duplicates.push({ vrf: v.vrf, text, owners, certainty: 'possible', why: `${lone.map((o) => o.device).join(', ')} ${lone.length === 1 ? 'is' : 'are'} joined to nothing in the model: the scope is not known` });
      continue;
    }
    const byPart = new Map<number, Array<{ device: string; iface: string }>>();
    for (const o of owners) {
      const p = parts.get(o.device) as number;
      if (!byPart.has(p)) byPart.set(p, []);
      (byPart.get(p) as Array<{ device: string; iface: string }>).push(o);
    }
    const together = Array.from(byPart.values()).filter((g) => g.length > 1);
    for (const g of together) duplicates.push({ vrf: v.vrf, text, owners: g, certainty: 'conflict', why: `${vrfName(v.vrf)}, in one connected part of the architecture` });
    if (byPart.size > 1) reused.push({ vrf: v.vrf, text, owners, why: `${vrfName(v.vrf)} in ${byPart.size} parts of the architecture the model does not connect` });
  }
  return { duplicates, reused };
}

/**
 * The lowest unallocated address to give an interface, with the prefix
 * length. In IPv6 the first address of a subnet (the subnet-router anycast
 * address) is unallocated but not offered.
 */
function firstFree(p: IpPrefix, free: AddrRange[]): string | null {
  const skip = p.version === 6 && p.prefix < 127 ? prefixRange(p).first : null;
  for (const r of free) {
    const v = r.first === skip ? r.first + ONE : r.first;
    if (v <= r.last) return formatAddr(bigAddr(v, p.version)) + '/' + p.prefix;
  }
  return null;
}

/**
 * Networks an interface could take its next address from, best first: the
 * networks its cable carries or its peer port is in, then the other
 * networks of its VRF (or without members), by prefix. Only networks with an
 * unallocated address; the address is unallocated in the model (not in a
 * DHCP pool, not reserved, not in use), never guaranteed free outside it.
 */
export function nextFreeChoices(model: Model, device: string, ifaceId: string): Array<{ id: string; label: string; text: string; nextFree: string; suggested: boolean }> {
  const i = model.index.interfaces.get(ifaceKey(device, ifaceId));
  if (!i) return [];
  const vrf = vrfKey(i.vrf);
  const ov = addressingOverview(model);
  const group = ov.vrfs.find((g) => g.vrf === vrf);
  const suggested = new Set<string>();
  const lid = model.index.ifaceLink.get(ifaceKey(device, ifaceId));
  const l = lid ? model.index.links.get(lid) : undefined;
  if (l) {
    for (const n of linkNetworks(model, l)) suggested.add(n);
    const far = l.a.device === device && l.a.iface === ifaceId ? l.b : l.a;
    const peer = far.iface !== undefined ? model.index.interfaces.get(ifaceKey(far.device, far.iface)) : undefined;
    if (peer) {
      for (const g of ov.vrfs) for (const n of g.networks) if (n.members.some((u) => u.device === peer.device && u.iface === peer.id)) suggested.add(n.id);
    }
  }
  const list = group ? group.networks : [];
  const out = list
    .filter((n) => n.nextFree !== null)
    .map((n) => ({ id: n.id, label: n.label, text: n.text, nextFree: n.nextFree as string, suggested: suggested.has(n.id) }));
  return out.filter((x) => x.suggested).concat(out.filter((x) => !x.suggested));
}

/** The address count as text: exact up to 2^53, else as a power of two where it is one. */
export function countText(v: bigint): string {
  if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let bits = 0;
  let x = v;
  while (x > ONE && x % BigInt(2) === ZERO) {
    x = x / BigInt(2);
    bits++;
  }
  return x === ONE ? '2^' + bits : v.toString();
}

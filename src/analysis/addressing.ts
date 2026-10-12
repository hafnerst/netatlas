/**
 * The addressing overview: every network, grouped by VRF and nested by
 * containing prefix (a supernet tree), with its members, gateways and
 * virtual addresses, how many addresses are used, its size, utilization,
 * free ranges and next free address; and the addresses that are used twice,
 * prefixes that overlap and addresses in no network.
 *
 * A network has no VRF of its own in the format: it is in the VRFs of the
 * interfaces that are its members (by address, as everywhere else) and of
 * the DHCP clients on cables carrying it. A network without either is listed
 * in the default table. Everything is sorted by value, so the result does
 * not depend on the order of the file.
 */
import { linkNetworks, networkMembers } from '../model/derive';
import { IpAddr, IpPrefix, parsePrefix } from '../model/ip';
import { Interface, Model, deviceInterfaces, ifaceKey } from '../model/types';
import { virtualGateways } from './identity';
import { AddrRange, addrBig, bigAddr, compareAddr, comparePrefix, count64, formatAddr, freeRanges, hostCount, inPrefix, networkOf, prefixCovers, prefixRange, prefixText } from './ipmath';
import { routeRef, vrfKey, vrfName } from './routing';

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
}

/** An interface that gets its address by DHCP, on a cable that carries the network (by VLAN). */
export interface DhcpClient {
  device: string;
  iface: string;
  dns: string[];
  /** the link that carries the network to it */
  link: string;
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
  /** the network it is nested in (the smallest containing one of the same VRF), and how deep */
  parent: string | null;
  depth: number;
  children: string[];
  /** the addresses in it that no nested network holds, and the DHCP clients (gateways likewise: those of a nested network are listed there) */
  members: AddrUse[];
  dhcp: DhcpClient[];
  /** addresses in nested networks */
  nestedUsed: number;
  gateways: Gateway[];
  /** distinct addresses used in the prefix (members, nested networks' members, virtual addresses) */
  used: bigint;
  /** host addresses of the prefix (IPv4: without network and broadcast address, except /31, /32) */
  size: bigint;
  /** IPv4: used / size in percent; IPv6: null (a percentage of 2^64 means nothing) */
  percent: number | null;
  /** IPv6: the number of /64 subnets of the prefix (0 for a prefix longer than /64) */
  nets64: bigint | null;
  /** free host addresses, outside nested networks */
  free: AddrRange[];
  /** the lowest free address with the network's prefix length ("10.0.0.7/24"), or null */
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
  overlaps: PrefixOverlap[];
  orphans: Orphan[];
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const vrfOrder = (a: string, b: string): number => (a === '' ? (b === '' ? 0 : -1) : b === '' ? 1 : cmpStr(a, b));
const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

function dnsOf(model: Model, device: string, iface: string): string[] {
  const d = model.index.devices.get(device);
  return d ? d.dnsNames.filter((n) => n.interfaces.indexOf(iface) >= 0).map((n) => n.name).sort() : [];
}

function host(text: string): IpAddr | null {
  const p = parsePrefix(text, false);
  return p ? { version: p.version, bytes: p.bytes } : null;
}

const cache = new WeakMap<Model, AddressingOverview>();

export function addressingOverview(model: Model): AddressingOverview {
  const known = cache.get(model);
  if (known) return known;
  const iface = (device: string, id: string): Interface | undefined => model.index.interfaces.get(ifaceKey(device, id));
  // ---- each network's prefix, members (per VRF) and DHCP clients
  interface Raw {
    id: string;
    prefix: IpPrefix;
    byVrf: Map<string, { uses: AddrUse[]; dhcp: DhcpClient[] }>;
  }
  const raws: Raw[] = [];
  for (const n of model.networks) {
    const p = n.cidr ? parsePrefix(n.cidr) : null;
    if (!p) continue;
    const byVrf = new Map<string, { uses: AddrUse[]; dhcp: DhcpClient[] }>();
    const slot = (v: string): { uses: AddrUse[]; dhcp: DhcpClient[] } => {
      if (!byVrf.has(v)) byVrf.set(v, { uses: [], dhcp: [] });
      return byVrf.get(v) as { uses: AddrUse[]; dhcp: DhcpClient[] };
    };
    for (const m of networkMembers(model, n.id)) {
      for (const x of m.matches) {
        const a = host(x.address);
        const i = iface(x.device, x.iface);
        if (!a || !i) continue;
        slot(vrfKey(i.vrf)).uses.push({ device: x.device, iface: x.iface, address: x.address, text: formatAddr(a), dns: dnsOf(model, x.device, x.iface), loopback: x.loopback });
      }
    }
    for (const l of model.links) {
      if (linkNetworks(model, l).indexOf(n.id) < 0) continue;
      for (const e of [l.a, l.b]) {
        const i = e.iface !== undefined ? iface(e.device, e.iface) : undefined;
        if (i && i.dhcp) slot(vrfKey(i.vrf)).dhcp.push({ device: i.device, iface: i.id, dns: dnsOf(model, i.device, i.id), link: l.id });
      }
    }
    if (!byVrf.size) slot('');
    raws.push({ id: n.id, prefix: networkOf(p), byVrf });
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
    const here = raws
      .filter((r) => r.byVrf.has(vrf))
      .sort((a, b) => comparePrefix(a.prefix, b.prefix) || cmpStr(a.id, b.id));
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
      const own = r.byVrf.get(vrf) as { uses: AddrUse[]; dhcp: DhcpClient[] };
      const children = kids(r.id);
      const inChild = (u: AddrUse): boolean => children.some((c) => inPrefix(c.prefix, host(u.address) as IpAddr));
      const sortUse = (a: AddrUse, b: AddrUse): number => cmpBig(addrBig(host(a.address) as IpAddr), addrBig(host(b.address) as IpAddr)) || cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface);
      const members = own.uses.filter((u) => !inChild(u)).sort(sortUse);
      const nested = own.uses.filter(inChild);
      const gw = new Map<string, Gateway>();
      const nestedVip = new Set<string>();
      for (const g of gws) {
        if ((g.vrf !== null && g.vrf !== vrf) || g.addr.version !== r.prefix.version || !inPrefix(r.prefix, g.addr)) continue;
        // a gateway in a nested network is that network's (it still counts as used here)
        const own = !children.some((c) => inPrefix(c.prefix, g.addr));
        const text = formatAddr(g.addr);
        const key = g.kind + ' ' + text;
        const cur = gw.get(key);
        if (g.kind === 'vip' && !own) nestedVip.add(addrBig(g.addr).toString());
        if (!own) continue;
        if (!cur) gw.set(key, { text, kind: g.kind, source: g.kind === 'gateway' ? 'default route of ' + g.source : g.source, refs: g.refs.slice() });
        else {
          if (g.kind === 'gateway') cur.source += ', ' + g.source;
          else if (cur.source.split('; ').indexOf(g.source) < 0) cur.source += '; ' + g.source;
          for (const ref of g.refs) if (cur.refs.indexOf(ref) < 0) cur.refs.push(ref);
        }
      }
      const gateways = Array.from(gw.values()).sort((a, b) => cmpBig(addrBig(host(a.text) as IpAddr), addrBig(host(b.text) as IpAddr)) || cmpStr(a.kind, b.kind));
      const used = new Set<string>();
      for (const u of own.uses) used.add(addrBig(host(u.address) as IpAddr).toString());
      for (const g of gateways) if (g.kind === 'vip') used.add(addrBig(host(g.text) as IpAddr).toString());
      nestedVip.forEach((v) => used.add(v));
      const usedBig = Array.from(used).map((s) => BigInt(s));
      const size = hostCount(r.prefix);
      const free = freeRanges(r.prefix, usedBig, children.map((c) => prefixRange(c.prefix)));
      entries.push({
        id: r.id,
        label: n.label || n.id,
        vlan: n.vlan,
        prefix: r.prefix,
        text: prefixText(r.prefix),
        version: r.prefix.version,
        vrf,
        otherVrfs: Array.from(r.byVrf.keys()).filter((v) => v !== vrf).sort(vrfOrder),
        parent: parent.get(r.id) || null,
        depth,
        children: children.map((c) => c.id),
        members,
        dhcp: own.dhcp.slice().sort((a, b) => cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface)),
        nestedUsed: nested.length,
        gateways,
        used: BigInt(used.size),
        size,
        percent: r.prefix.version === 4 ? (size > BigInt(0) ? Math.round((used.size * 1000) / Number(size)) / 10 : 0) : null,
        nets64: r.prefix.version === 6 ? count64(r.prefix) : null,
        free,
        nextFree: firstFree(r.prefix, free),
      });
      for (const c of children) visit(c, depth + 1);
    };
    for (const r of kids(null)) visit(r, 0);
    vrfs.push({ vrf, name: vrfName(vrf), networks: entries });
  }
  // ---- duplicates, overlaps and orphans
  const duplicates: DuplicateAddr[] = [];
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
        if (!containing.length) orphans.push({ vrf, device: d.id, iface: i.id, address, loopback: i.type === 'loopback' });
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
  byAddr.forEach((v) => {
    if (v.owners.length > 1) duplicates.push({ vrf: v.vrf, text: formatAddr(v.addr), owners: v.owners.slice().sort((a, b) => cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface)) });
  });
  for (const g of vrfs) {
    const list = g.networks;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        if (comparePrefix(list[x].prefix, list[y].prefix) !== 0) continue;
        overlaps.push({ vrf: g.vrf, kind: 'same-prefix', message: `networks ${list[x].id} and ${list[y].id} have the same prefix ${list[x].text}`, refs: ['network:' + list[x].id, 'network:' + list[y].id] });
      }
    }
  }
  const out: AddressingOverview = {
    vrfs,
    duplicates: duplicates.sort((a, b) => vrfOrder(a.vrf, b.vrf) || cmpBig(addrBig(host(a.text) as IpAddr), addrBig(host(b.text) as IpAddr)) || (host(a.text) as IpAddr).version - (host(b.text) as IpAddr).version),
    overlaps: overlaps.sort((a, b) => vrfOrder(a.vrf, b.vrf) || cmpStr(a.kind, b.kind) || cmpStr(a.message, b.message)),
    orphans: orphans.sort((a, b) => vrfOrder(a.vrf, b.vrf) || cmpStr(a.device, b.device) || cmpStr(a.iface, b.iface) || cmpStr(a.address, b.address)),
  };
  cache.set(model, out);
  return out;
}

/**
 * The lowest free address to give an interface, with the prefix length. In
 * IPv6 the first address of a subnet (the subnet-router anycast address) is
 * free but not offered.
 */
function firstFree(p: IpPrefix, free: AddrRange[]): string | null {
  const skip = p.version === 6 && p.prefix < 127 ? prefixRange(p).first : null;
  for (const r of free) {
    const v = r.first === skip ? r.first + BigInt(1) : r.first;
    if (v <= r.last) return formatAddr(bigAddr(v, p.version)) + '/' + p.prefix;
  }
  return null;
}

/**
 * Networks an interface could take its next address from, best first: the
 * networks its cable carries or its peer port is in, then the other
 * networks of its VRF (or without members), by prefix. Only networks with a
 * free address.
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
  while (x > BigInt(1) && x % BigInt(2) === BigInt(0)) {
    x = x / BigInt(2);
    bits++;
  }
  return x === BigInt(1) ? '2^' + bits : v.toString();
}

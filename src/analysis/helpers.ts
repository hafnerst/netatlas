/**
 * Suggestions for filling in the model: the values the Edit tab's input
 * helpers offer (as chips, a button or a combobox). Each is computed from
 * the model as it is and applied only when the user picks it; nothing here
 * changes the model. Pure and deterministic (the random MAC address takes
 * its random source as an argument).
 */
import { parseAddress, parsePrefix } from '../model/ip';
import { ServiceDef, bgpAsn, paramsAt } from '../model/services';
import { vlanIds } from '../model/derive';
import { Interface, InterfaceKind, Model, deviceInterfaces } from '../model/types';
import { tunnelBudget } from './checks-more';
import { gatewayServices } from './identity';
import { addrBig, bigAddr, formatAddr, inPrefix, networkOf, prefixRange, reservedOf } from './ipmath';
import { capabilities } from '../model/capabilities';

/** One suggested value: what is written, how the chip reads, what it means. */
export interface Suggestion {
  value: string;
  label: string;
  title: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ MTU

/** Common MTUs: the Ethernet standard and jumbo frames; for a tunnel also typical tunnel MTUs. */
export const ETHERNET_MTU = 1500;
export const JUMBO_MTU = 9000;

/**
 * The MTUs offered for an interface: 1500 (standard Ethernet) and 9000
 * (jumbo); for a tunnel interface 1400 (a common tunnel MTU) and 1476 (GRE
 * over a 1500 underlay), and, when the tunnel's underlay is known, its MTU
 * less the encapsulation overhead (the overhead named in the title). The
 * value already set is left out.
 */
export function mtuSuggestions(model: Model, i: Interface): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (v: number, label: string, title: string): void => {
    if (v === i.mtu || v < 68 || v > 65535) return;
    const dup = out.find((s) => s.value === String(v));
    if (dup) {
      dup.title += '; ' + title;
      return;
    }
    out.push({ value: String(v), label, title });
  };
  if (i.type === 'tunnel') {
    const b = tunnelBudget(model, i);
    if (b && b.under && b.under.mtu !== undefined) {
      const v = b.under.mtu - b.overhead;
      add(v, `${v} (underlay ${b.under.mtu} − ${b.overhead})`, `The MTU of the underlay ${b.under.id} (${b.under.mtu}) less ${b.overhead} bytes of encapsulation: ${b.what.join(' + ')}`);
    }
    add(1476, '1476 (GRE)', 'GRE over a 1500-byte underlay: 1500 − 24 (20 IP + 4 GRE)');
    add(1400, '1400 (tunnel)', 'A common tunnel MTU that leaves room for GRE over IPsec');
  }
  add(ETHERNET_MTU, '1500', 'The standard Ethernet MTU');
  add(JUMBO_MTU, '9000 (jumbo)', 'Jumbo frames');
  return out;
}

// ------------------------------------------------------------------ MAC

/** How the model writes MAC addresses: the separator, its grouping and the case. */
export interface MacStyle {
  /** ':' or '-' between bytes; '.' between groups of four hex digits (Cisco) */
  sep: ':' | '-' | '.';
  upper: boolean;
}

function macKey(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/** The style most MAC addresses of the model are written in (ties: the first in that order); 00:1c:… without any. */
export function macStyleOf(model: Model): MacStyle {
  const counts = new Map<string, number>();
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      if (!i.mac) continue;
      const m = i.mac.trim();
      const sep = /^[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}$/.test(m) ? '.' : m.indexOf('-') >= 0 ? '-' : ':';
      const upper = /[A-F]/.test(m) && !/[a-f]/.test(m);
      const k = sep + (upper ? 'U' : 'l');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let best = ':l';
  let n = 0;
  for (const k of [':l', ':U', '-l', '-U', '.l', '.U']) {
    const c = counts.get(k) || 0;
    if (c > n) {
      best = k;
      n = c;
    }
  }
  return { sep: best.charAt(0) as MacStyle['sep'], upper: best.charAt(1) === 'U' };
}

/** Six bytes as a MAC address in a style. */
export function formatMac(bytes: number[], style: MacStyle): string {
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0'));
  const t = style.sep === '.' ? [hex[0] + hex[1], hex[2] + hex[3], hex[4] + hex[5]].join('.') : hex.join(style.sep);
  return style.upper ? t.toUpperCase() : t;
}

/**
 * A random, locally administered unicast MAC address that no interface of
 * the model has: the first byte has the locally administered bit (0x02)
 * set and the multicast bit (0x01) cleared. Written in the model's style.
 * `random(n)` gives n random bytes (crypto.getRandomValues in the page).
 */
export function generateMac(model: Model, random: (n: number) => Uint8Array, style: MacStyle = macStyleOf(model), oui?: number[]): string {
  const used = new Set<string>();
  for (const d of model.devices) for (const i of deviceInterfaces(d)) if (i.mac) used.add(macKey(i.mac));
  for (let tries = 0; tries < 1000; tries++) {
    const r = Array.from(random(6)).slice(0, 6);
    r[0] = (r[0] & 0xfc) | 0x02;
    // a platform's own prefix (OUI): its first three bytes (VMware's manual range keeps the fourth below 0x40)
    if (oui) {
      for (let k = 0; k < oui.length; k++) r[k] = oui[k];
      if (oui[0] === 0x00 && oui[1] === 0x50 && oui[2] === 0x56) r[3] &= 0x3f;
    }
    const mac = formatMac(r, style);
    if (!used.has(macKey(mac))) return mac;
  }
  throw new Error('no free MAC address found');
}

/**
 * The MAC prefix (OUI) a virtualization platform gives its guests' NICs:
 * VMware 00:50:56, KVM / QEMU 52:54:00, Hyper-V 00:15:5d, Xen 00:16:3e,
 * Proxmox VE bc:24:11, Docker 02:42 (a container); none for another one.
 */
export function platformOui(platform: string | undefined): { oui: number[]; name: string } | undefined {
  const t: { [k: string]: { oui: number[]; name: string } } = {
    esxi: { oui: [0x00, 0x50, 0x56], name: 'VMware 00:50:56' },
    kvm: { oui: [0x52, 0x54, 0x00], name: 'KVM 52:54:00' },
    hyperv: { oui: [0x00, 0x15, 0x5d], name: 'Hyper-V 00:15:5d' },
    xen: { oui: [0x00, 0x16, 0x3e], name: 'Xen 00:16:3e' },
    proxmox: { oui: [0xbc, 0x24, 0x11], name: 'Proxmox VE bc:24:11' },
    docker: { oui: [0x02, 0x42], name: 'Docker 02:42' },
  };
  return platform !== undefined ? t[platform] : undefined;
}

/**
 * The next free address of a container network for one of its containers:
 * from its IPAM range when it has one, else from its subnet; never the
 * gateway, the network or broadcast address, or an address a container (or
 * any interface of the model) already has.
 */
export function nextFreeContainerAddr(model: Model, net: { subnet?: string; gateway?: string; start?: string; end?: string }): string | null {
  const p = net.subnet ? parsePrefix(net.subnet) : null;
  if (!p) return null;
  const used: bigint[] = [];
  for (const d of model.devices) for (const i of deviceInterfaces(d)) for (const a of i.addresses) {
    const x = parsePrefix(a, false);
    if (x && inPrefix(p, x)) used.push(addrBig(x));
  }
  if (net.gateway) {
    const g = parseAddress(net.gateway);
    if (g) used.push(addrBig(g));
  }
  const r = prefixRange(p);
  const lo = net.start ? parseAddress(net.start) : null;
  const hi = net.end ? parseAddress(net.end) : null;
  const first = lo ? addrBig(lo) : r.first;
  const last = hi ? addrBig(hi) : r.last;
  const reserved = reservedOf(p);
  for (let v = first; v <= last; v++) {
    if (used.indexOf(v) >= 0 || reserved.indexOf(v) >= 0) continue;
    return formatAddr(bigAddr(v, p.version));
  }
  return null;
}

// ------------------------------------------------------------------ VRF

export interface VrfChoice {
  name: string;
  /** interfaces and routes that name it */
  count: number;
}

/** The VRFs the model uses (interfaces and routes), sorted by name (case-insensitively, then exactly), with how often each is named. */
export function vrfChoices(model: Model): VrfChoice[] {
  const m = new Map<string, number>();
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) if (i.vrf) m.set(i.vrf, (m.get(i.vrf) || 0) + 1);
    for (const r of d.routes) if (r.vrf) m.set(r.vrf, (m.get(r.vrf) || 0) + 1);
  }
  return Array.from(m.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.name, b.name));
}

/** The VRF names of the model that differ from `name` only in case (a probable typo). */
export function vrfCaseVariants(model: Model, name: string): string[] {
  const n = name.trim();
  if (!n) return [];
  return vrfChoices(model)
    .map((c) => c.name)
    .filter((x) => x !== n && x.toLowerCase() === n.toLowerCase());
}

// ------------------------------------------------------------------ VLANs

/** The VLAN IDs the model defines or carries (networks, VLAN interfaces, ports), with what names them; sorted by ID. */
export function vlanChoices(model: Model): Array<{ id: number; names: string[] }> {
  const m = new Map<number, Set<string>>();
  const add = (v: number, what: string): void => {
    if (!m.has(v)) m.set(v, new Set());
    (m.get(v) as Set<string>).add(what);
  };
  for (const n of model.networks) if (n.vlan !== undefined) add(n.vlan, n.label || n.id);
  for (const d of model.devices) for (const i of d.logical) if (i.vlan !== undefined) add(i.vlan, `${d.id}:${i.id}`);
  for (const d of model.devices) for (const i of d.interfaces.concat(d.logical)) for (const v of vlanIds(i.vlans)) add(v, `${d.id}:${i.id}`);
  return Array.from(m.entries())
    .map(([id, names]) => ({ id, names: Array.from(names).sort(cmp) }))
    .sort((a, b) => a.id - b.id);
}

/** The lowest VLAN ID from 2 up that nothing in the model uses (1 is the default VLAN), or null. */
export function nextFreeVlan(model: Model): number | null {
  const used = new Set(vlanChoices(model).map((v) => v.id));
  for (let v = 2; v <= 4094; v++) if (!used.has(v)) return v;
  return null;
}

/** The VLAN suggestions of a VLAN field: the next free ID, then the defined VLANs by name. */
export function vlanSuggestions(model: Model, current?: number, max = 8): Suggestion[] {
  const out: Suggestion[] = [];
  const free = nextFreeVlan(model);
  if (free !== null && free !== current) out.push({ value: String(free), label: `${free} (next free)`, title: `VLAN ${free}: the lowest VLAN ID the model does not use yet` });
  for (const v of vlanChoices(model)) {
    if (out.length >= max || v.id === current) continue;
    const named = model.networks.filter((n) => n.vlan === v.id).map((n) => n.label || n.id);
    out.push({ value: String(v.id), label: named.length ? `${v.id} ${named[0]}` : String(v.id), title: `VLAN ${v.id}: ${v.names.join(', ')}` });
  }
  return out;
}

// ------------------------------------------------------------------ redundancy groups

/**
 * Group numbers for an interface's group of a redundancy service (VRRP …):
 * the groups the other members on its segment (interfaces in one of its
 * subnets) already use, to join one, and the lowest free number on the
 * segment.
 */
export function groupSuggestions(model: Model, i: Interface, service: ServiceDef): Suggestion[] {
  const gp = paramsAt(service, 'interface').find((p) => p.key === 'group');
  if (!gp) return [];
  const own = i.services.find((s) => s.id === service.id);
  const current = own ? own.values.get('group') : undefined;
  const nets = i.addresses
    .map((a) => parsePrefix(a, false))
    .filter((p): p is NonNullable<typeof p> => !!p && p.prefix < (p.version === 4 ? 32 : 128))
    .map(networkOf);
  const used = new Map<number, string[]>();
  for (const d of model.devices) {
    for (const x of deviceInterfaces(d)) {
      if (x === i) continue;
      const s = x.services.find((y) => y.id === service.id);
      const g = s ? s.values.get('group') : undefined;
      if (g === undefined) continue;
      const onSegment = x.addresses.some((a) => {
        const p = parsePrefix(a, false);
        return !!p && nets.some((n) => inPrefix(n, p));
      });
      if (!onSegment) continue;
      const k = Number(g);
      if (!used.has(k)) used.set(k, []);
      const vip = s ? s.values.get('virtual_ip') : undefined;
      (used.get(k) as string[]).push(`${d.id}:${x.id}${vip ? ' ' + vip : ''}`);
    }
  }
  const out: Suggestion[] = [];
  for (const [g, who] of Array.from(used.entries()).sort((a, b) => a[0] - b[0])) {
    if (String(g) === current) continue;
    out.push({ value: String(g), label: `${g} (join ${who[0].split(' ')[0]})`, title: `${service.label} group ${g} on this segment: ${who.join(', ')}` });
  }
  for (let g = gp.min !== undefined ? Math.max(1, gp.min) : 1; g <= (gp.max || 255); g++) {
    if (used.has(g)) continue;
    if (String(g) !== current) out.push({ value: String(g), label: `${g} (next free)`, title: `The lowest ${service.label} group number not used on this segment` });
    break;
  }
  return out;
}

/** Virtual IPs for a group: the one its group's other members use, else the first free host address of the interface's subnet. */
export function virtualIpSuggestions(model: Model, i: Interface, service: ServiceDef): Suggestion[] {
  const own = i.services.find((s) => s.id === service.id);
  const g = own ? own.values.get('group') : undefined;
  const cur = own ? own.values.get('virtual_ip') : undefined;
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const d of model.devices) {
    for (const x of deviceInterfaces(d)) {
      if (x === i) continue;
      const s = x.services.find((y) => y.id === service.id);
      const v = s ? s.values.get('virtual_ip') : undefined;
      if (!s || v === undefined || seen.has(v) || v === cur) continue;
      if (g !== undefined && s.values.get('group') !== g) continue;
      const p = parsePrefix(v, false);
      const inMine = !!p && i.addresses.some((a) => {
        const q = parsePrefix(a, false);
        return !!q && q.prefix < 32 && inPrefix(networkOf(q), p);
      });
      if (!inMine) continue;
      seen.add(v);
      out.push({ value: v, label: `${v} (as ${d.id})`, title: `The virtual IP of ${d.id}:${x.id}'s ${service.label} group ${s.values.get('group') || ''}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ AS numbers

/** The BGP AS numbers the model's devices use, with the devices; sorted by number. */
export function asnSuggestions(model: Model, except?: string): Suggestion[] {
  const m = new Map<number, string[]>();
  for (const d of model.devices) {
    const a = bgpAsn(d);
    if (a === undefined || d.id === except) continue;
    if (!m.has(a)) m.set(a, []);
    (m.get(a) as string[]).push(d.id);
  }
  return Array.from(m.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 8)
    .map(([a, ds]) => ({ value: String(a), label: `${a} (${ds[0]}${ds.length > 1 ? ' +' + (ds.length - 1) : ''})`, title: `AS ${a}: ${ds.join(', ')} (the same AS: iBGP between them)` }));
}

// ------------------------------------------------------------------ router ID

/** The device's loopbacks with an IPv4 address, offered as its router ID (the value written is the loopback's id). */
export function routerIdSuggestions(model: Model, device: string, current?: string): Suggestion[] {
  const d = model.index.devices.get(device);
  if (!d) return [];
  const out: Suggestion[] = [];
  for (const i of d.logical) {
    if (i.type !== 'loopback' || i.id === current) continue;
    const v4 = i.addresses.map((a) => parsePrefix(a, true)).find((p) => !!p && p.version === 4);
    if (v4) out.push({ value: i.id, label: `${i.id} (${v4.bytes.join('.')})`, title: `The loopback ${i.id}: its address ${v4.bytes.join('.')} is the router ID, and follows when it changes` });
  }
  return out;
}

// ------------------------------------------------------------------ interface names

/**
 * The next interface id of a kind on a device, following the names it
 * already uses for that kind: the stem it uses most (ge-0/0/, Vlan, lo),
 * with the number after its highest (ge-0/0/3 after ge-0/0/2). Without one
 * on the device: the stem the model uses most for that kind, from 0; else a
 * plain default (eth0, lo0, vlan0, tun0). Never an id the device has.
 */
export function nextInterfaceName(model: Model, device: string, kind: InterfaceKind): string {
  const d = model.index.devices.get(device);
  const taken = new Set(d ? deviceInterfaces(d).map((i) => i.id) : []);
  const stems = (ifs: Interface[]): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const i of ifs) {
      if (i.type !== kind) continue;
      const x = /^(.*?)([0-9]+)$/.exec(i.id);
      if (!x) continue;
      if (!m.has(x[1])) m.set(x[1], []);
      (m.get(x[1]) as number[]).push(Number(x[2]));
    }
    return m;
  };
  const pick = (m: Map<string, number[]>): string | null => {
    let best: string | null = null;
    for (const [stem, ns] of Array.from(m.entries()).sort((a, b) => cmp(a[0], b[0]))) if (best === null || ns.length > (m.get(best) as number[]).length) best = stem;
    return best;
  };
  const own = stems(d ? deviceInterfaces(d) : []);
  let stem = pick(own);
  let start = 0;
  if (stem !== null) start = Math.max(...(own.get(stem) as number[])) + 1;
  else {
    const all: Interface[] = [];
    for (const x of model.devices) all.push(...deviceInterfaces(x));
    stem = pick(stems(all));
    if (stem === null) stem = kind === 'physical' ? 'eth' : kind === 'loopback' ? 'lo' : kind === 'tunnel' ? 'tun' : 'vlan';
  }
  let n = start;
  while (taken.has(stem + n)) n++;
  return stem + n;
}

// ------------------------------------------------------------------ routes

/** Prefixes offered for a route: the default routes of the device's address families. */
export function routePrefixSuggestions(model: Model, device: string, current?: string): Suggestion[] {
  const d = model.index.devices.get(device);
  const fams = new Set<number>();
  if (d) for (const i of deviceInterfaces(d)) for (const a of i.addresses) {
    const p = parsePrefix(a, false);
    if (p) fams.add(p.version);
  }
  const out: Suggestion[] = [];
  if (fams.has(4) || !fams.size) out.push({ value: '0.0.0.0/0', label: '0.0.0.0/0 (default)', title: 'The IPv4 default route' });
  if (fams.has(6)) out.push({ value: '::/0', label: '::/0 (default)', title: 'The IPv6 default route' });
  return out.filter((s) => s.value !== current);
}

/** Administrative distances offered for a static route: a floating backup (250). */
export function distanceSuggestions(current?: string): Suggestion[] {
  return [{ value: '250', label: '250 (floating backup)', title: 'Higher than any routing protocol: used only when the other routes to the prefix are gone' }].filter((s) => s.value !== current);
}

/** The services of the model that have interface groups (VRRP …), for an interface's helpers. */
export function groupServices(model: Model): ServiceDef[] {
  return gatewayServices(model).map((id) => model.services.get(id) as ServiceDef);
}

// ------------------------------------------------------------------ IS-IS NET, BGP peer AS

/**
 * An IS-IS NET for a device, derived from its router ID or first IPv4
 * loopback by the usual convention: each octet written with three digits,
 * regrouped as the system ID (10.255.0.1 → 0102.5500.0001), in area 49.0001
 * with the selector 00.
 */
export function netSuggestions(model: Model, device: string, current?: string): Suggestion[] {
  const d = model.index.devices.get(device);
  if (!d) return [];
  let addr: number[] | null = null;
  if (d.routerId && d.routerId.address) addr = d.routerId.address.split('.').map(Number);
  if (!addr) {
    for (const i of d.logical) {
      if (i.type !== 'loopback') continue;
      const p = i.addresses.map((a) => parsePrefix(a, true)).find((x) => !!x && x.version === 4);
      if (p) {
        addr = p.bytes;
        break;
      }
    }
  }
  if (!addr) return [];
  const digits = addr.map((o) => String(o).padStart(3, '0')).join('');
  const sys = `${digits.slice(0, 4)}.${digits.slice(4, 8)}.${digits.slice(8, 12)}`;
  const net = `49.0001.${sys}.00`;
  return net === current ? [] : [{ value: net, label: net, title: `Area 49.0001, system ID ${sys} from ${addr.join('.')} (each octet as three digits)` }];
}

/** The AS number a BGP session's end expects of the other: the other device's local AS. */
export function peerAsSuggestions(model: Model, other: string, current?: string): Suggestion[] {
  const a = bgpAsn(model.index.devices.get(other));
  return a === undefined || String(a) === current ? [] : [{ value: String(a), label: `${a} (${other}'s AS)`, title: `The local AS number of ${other}` }];
}

// ------------------------------------------------------------------ DHCP scopes and DNS

/** The network's addresses as numbers (IPv4): its first and last host. */
function hostRange(cidr: string | undefined): { first: number; last: number; net: ReturnType<typeof networkOf> } | null {
  const p = cidr ? parsePrefix(cidr) : null;
  if (!p || p.version !== 4 || p.prefix > 29) return null;
  const n = networkOf(p);
  const base = ((n.bytes[0] << 24) | (n.bytes[1] << 16) | (n.bytes[2] << 8) | n.bytes[3]) >>> 0;
  const size = Math.pow(2, 32 - n.prefix);
  return { first: base + 1, last: base + size - 2, net: n };
}

const v4 = (x: number): string => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');

/**
 * What a DHCP scope of a network may be: a range (the upper half of the
 * hosts, without the addresses the model gives its interfaces there), the
 * default gateway (a router's address in it, or a redundancy group's virtual
 * address), the DNS servers (the model's DNS servers' addresses).
 */
export function scopeSuggestions(model: Model, networkId: string): { range: Suggestion[]; gateway: Suggestion[]; dns: Suggestion[] } {
  const out = { range: [] as Suggestion[], gateway: [] as Suggestion[], dns: [] as Suggestion[] };
  const n = model.networks.find((x) => x.id === networkId);
  const h = hostRange(n ? n.cidr : undefined);
  for (const d of model.devices) {
    if (!d.netServices || !d.netServices.dns) continue;
    for (const i of deviceInterfaces(d)) for (const a of i.addresses) {
      const ip = a.split('/')[0];
      if (ip.indexOf(':') < 0 && !out.dns.some((s) => s.value === ip)) out.dns.push({ value: ip, label: `${ip} (${d.id})`, title: `The DNS server ${d.id}` });
    }
  }
  if (!h || !n) return out;
  const used = new Set<number>();
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      for (const a of i.addresses) {
        const p = parsePrefix(a, false);
        if (!p || p.version !== 4 || !inPrefix(h.net, p)) continue;
        const x = ((p.bytes[0] << 24) | (p.bytes[1] << 16) | (p.bytes[2] << 8) | p.bytes[3]) >>> 0;
        used.add(x);
        if (d.services.length || capabilities(d).l3Forward) out.gateway.push({ value: v4(x), label: `${v4(x)} (${d.id}:${i.id})`, title: `The address of ${d.id}:${i.id} in ${n.id}` });
      }
      for (const s of i.services) {
        const vip = s.values.get('virtual_ip');
        const p = vip ? parsePrefix(vip, false) : null;
        if (p && p.version === 4 && inPrefix(h.net, p) && !out.gateway.some((g) => g.value === vip)) out.gateway.unshift({ value: String(vip), label: `${vip} (${s.id.toUpperCase()} group ${s.values.get('group') || ''})`, title: `The virtual address of the ${s.id.toUpperCase()} group in ${n.id}` });
      }
    }
  }
  // the upper half, without the addresses in use
  let a = h.first + Math.floor((h.last - h.first + 1) / 2);
  while (a <= h.last && used.has(a)) a++;
  let b = a;
  while (b + 1 <= h.last && !used.has(b + 1)) b++;
  if (a <= h.last && b - a >= 1) out.range.push({ value: `${v4(a)}-${v4(b)}`, label: `${v4(a)}–${v4(b)}`, title: `${b - a + 1} addresses of ${n.id} no interface of the model has` });
  return out;
}

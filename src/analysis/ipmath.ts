/**
 * Address arithmetic for IPv4 and IPv6: addresses as integers, prefixes as
 * ranges, canonical text, sizes, and the free parts of a prefix. Pure and
 * exact (BigInt), so IPv6 prefixes of any length are handled like IPv4 ones.
 */
import { IpAddr, IpPrefix, parsePrefix } from '../model/ip';

/** Number of bits of an address family. */
export function familyBits(version: 4 | 6): number {
  return version === 4 ? 32 : 128;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const BYTE = BigInt(8);
const FF = BigInt(255);

/** The address as an integer. */
export function addrBig(a: IpAddr): bigint {
  let v = ZERO;
  for (const b of a.bytes) v = (v << BYTE) | BigInt(b);
  return v;
}

/** The address of an integer in a family. */
export function bigAddr(v: bigint, version: 4 | 6): IpAddr {
  const n = version === 4 ? 4 : 16;
  const bytes: number[] = new Array(n);
  let x = v;
  for (let i = n - 1; i >= 0; i--) {
    bytes[i] = Number(x & FF);
    x >>= BYTE;
  }
  return { version, bytes };
}

/**
 * Canonical text of an address: dotted quad for IPv4; for IPv6 the
 * recommended form (RFC 5952): lower case, no leading zeros, the longest run
 * of two or more zero groups (the first of equal ones) written as "::".
 */
export function formatAddr(a: IpAddr): string {
  if (a.version === 4) return a.bytes.join('.');
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((a.bytes[i] << 8) | a.bytes[i + 1]);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (xs: number[]): string => xs.map((x) => x.toString(16)).join(':');
  if (best < 0) return hex(g);
  return hex(g.slice(0, best)) + '::' + hex(g.slice(best + bestLen));
}

/** The network a prefix names: host bits cleared ("10.1.2.3/24" -> 10.1.2.0/24). */
export function networkOf(p: IpPrefix): IpPrefix {
  const bits = familyBits(p.version);
  const host = BigInt(bits - p.prefix);
  const v = (addrBig(p) >> host) << host;
  return { ...bigAddr(v, p.version), prefix: p.prefix };
}

/** Canonical text of a prefix's network: "10.1.2.0/24", "2001:db8::/64". */
export function prefixText(p: IpPrefix): string {
  return formatAddr(networkOf(p)) + '/' + p.prefix;
}

/** First and last address of a prefix, as integers. */
export function prefixRange(p: IpPrefix): { first: bigint; last: bigint } {
  const host = BigInt(familyBits(p.version) - p.prefix);
  const first = (addrBig(p) >> host) << host;
  return { first, last: first + (ONE << host) - ONE };
}

/** Number of addresses of a prefix. */
export function prefixSize(p: IpPrefix): bigint {
  return ONE << BigInt(familyBits(p.version) - p.prefix);
}

/** Does prefix `outer` contain all of prefix `inner` (same family, not longer)? */
export function prefixCovers(outer: IpPrefix, inner: IpPrefix): boolean {
  if (outer.version !== inner.version || outer.prefix > inner.prefix) return false;
  const o = prefixRange(outer);
  const i = prefixRange(inner);
  return i.first >= o.first && i.last <= o.last;
}

/** Do two prefixes share any address? */
export function prefixesOverlap(a: IpPrefix, b: IpPrefix): boolean {
  return prefixCovers(a, b) || prefixCovers(b, a);
}

/** Is `a` inside prefix `p`? */
export function inPrefix(p: IpPrefix, a: IpAddr): boolean {
  if (p.version !== a.version) return false;
  const r = prefixRange(p);
  const v = addrBig(a);
  return v >= r.first && v <= r.last;
}

/**
 * The addresses of an IPv4 prefix that are not host addresses: its network
 * and broadcast address, except in a /31 (two hosts, RFC 3021) and a /32
 * (one). IPv6 has no broadcast address; its subnet-router anycast address
 * (the first one) is not counted out, as many networks use it.
 */
export function reservedOf(p: IpPrefix): bigint[] {
  if (p.version !== 4 || p.prefix >= 31) return [];
  const r = prefixRange(p);
  return [r.first, r.last];
}

/** Number of host addresses of a prefix (its size less the reserved ones). */
export function hostCount(p: IpPrefix): bigint {
  return prefixSize(p) - BigInt(reservedOf(p).length);
}

/** A run of addresses, both ends included. */
export interface AddrRange {
  first: bigint;
  last: bigint;
}

/** Number of addresses in a range. */
export function rangeSize(r: AddrRange): bigint {
  return r.last - r.first + ONE;
}

/**
 * The free host addresses of a prefix as ranges, ascending: every address
 * of the prefix that is neither in `used` nor reserved (reservedOf).
 * Addresses outside the prefix are ignored.
 */
export function freeRanges(p: IpPrefix, used: bigint[]): AddrRange[] {
  const r = prefixRange(p);
  const taken = Array.from(new Set(used.concat(reservedOf(p)).filter((v) => v >= r.first && v <= r.last).map((v) => v.toString())))
    .map((s) => BigInt(s))
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const out: AddrRange[] = [];
  let cur = r.first;
  for (const t of taken) {
    if (t > cur) out.push({ first: cur, last: t - ONE });
    cur = t + ONE;
  }
  if (cur <= r.last) out.push({ first: cur, last: r.last });
  return out;
}

/** The lowest free host address of a prefix (null: none is free). */
export function nextFree(p: IpPrefix, used: bigint[]): IpAddr | null {
  const f = freeRanges(p, used);
  return f.length ? bigAddr(f[0].first, p.version) : null;
}

/** "a – b" (or "a" for one address) in canonical text. */
export function rangeText(r: AddrRange, version: 4 | 6): string {
  const a = formatAddr(bigAddr(r.first, version));
  return r.first === r.last ? a : a + ' – ' + formatAddr(bigAddr(r.last, version));
}

/** Compare two addresses: family first (IPv4 before IPv6), then value. */
export function compareAddr(a: IpAddr, b: IpAddr): number {
  if (a.version !== b.version) return a.version - b.version;
  const x = addrBig(a);
  const y = addrBig(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Compare two prefixes: family, network address, then length (shorter first). */
export function comparePrefix(a: IpPrefix, b: IpPrefix): number {
  return compareAddr(networkOf(a), networkOf(b)) || a.prefix - b.prefix;
}

/** The address part of "addr" or "addr/len" (null if it isn't one). */
export function addrOf(text: string): IpAddr | null {
  const p = parsePrefix(text, false);
  return p ? { version: p.version, bytes: p.bytes } : null;
}

/** A big number as text with thin grouping ("65 536"), for counts that can exceed Number. */
export function bigText(v: bigint): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Number of /64 subnets an IPv6 prefix holds (0 when it is longer than /64). */
export function count64(p: IpPrefix): bigint {
  return p.version === 6 && p.prefix <= 64 ? ONE << BigInt(64 - p.prefix) : ZERO;
}

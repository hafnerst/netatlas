/** Minimal IPv4 / IPv6 address and prefix handling (no dependencies). */

export interface IpAddr {
  version: 4 | 6;
  /** 4 or 16 bytes */
  bytes: number[];
}

export interface IpPrefix extends IpAddr {
  prefix: number;
}

export function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p) || (p.length > 1 && p.charAt(0) === '0')) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

export function parseIPv6(s: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let tail4: number[] | null = null;
  let str = s;
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.') >= 0) {
    tail4 = parseIPv4(s.slice(lastColon + 1));
    if (!tail4) return null;
    str = s.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = str.indexOf('::');
  if (dbl >= 0 && str.indexOf('::', dbl + 1) >= 0) return null;
  const toGroups = (part: string): string[] | null => (part === '' ? [] : part.split(':'));
  let groups: string[];
  if (dbl >= 0) {
    const head = toGroups(str.slice(0, dbl));
    const tail = toGroups(str.slice(dbl + 2));
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = head.concat(new Array(missing).fill('0'), tail);
  } else {
    groups = str.split(':');
    if (groups.length !== 8) return null;
  }
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  if (tail4) bytes.splice(12, 4, ...tail4);
  return bytes;
}

export function parseAddress(s: string): IpAddr | null {
  const v4 = parseIPv4(s);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = s.indexOf(':') >= 0 ? parseIPv6(s) : null;
  return v6 ? { version: 6, bytes: v6 } : null;
}

/**
 * Parse "address/prefix". With `requirePrefix` false a bare address is
 * accepted as a host prefix (/32 or /128).
 */
export function parsePrefix(s: string, requirePrefix = true): IpPrefix | null {
  const slash = s.indexOf('/');
  if (slash < 0) {
    if (requirePrefix) return null;
    const a = parseAddress(s);
    return a ? { ...a, prefix: a.version === 4 ? 32 : 128 } : null;
  }
  const a = parseAddress(s.slice(0, slash));
  const p = s.slice(slash + 1);
  if (!a || !/^[0-9]{1,3}$/.test(p)) return null;
  const prefix = Number(p);
  if (prefix > (a.version === 4 ? 32 : 128)) return null;
  return { ...a, prefix };
}

/** Explain why a string is not a valid address with prefix length (for error messages). */
export function prefixProblem(s: string): string | null {
  if (parsePrefix(s)) return null;
  const slash = s.indexOf('/');
  const addr = slash < 0 ? s : s.slice(0, slash);
  const a = parseAddress(addr);
  if (!a) return `"${addr}" is not a valid IPv4 or IPv6 address`;
  if (slash < 0) return `"${s}" needs a prefix length, e.g. ${s}/${a.version === 4 ? 32 : 128}`;
  return `prefix length "/${s.slice(slash + 1)}" is invalid for IPv${a.version} (0–${a.version === 4 ? 32 : 128})`;
}

/** Does `net` contain address `a`? (Different versions never match.) */
export function prefixContains(net: IpPrefix, a: IpAddr): boolean {
  if (net.version !== a.version) return false;
  let bits = net.prefix;
  for (let i = 0; i < net.bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((net.bytes[i] & mask) !== (a.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

/** Canonical text of an address (for duplicate detection). */
export function addrKey(a: IpAddr): string {
  return a.version + ':' + a.bytes.join('.');
}

/**
 * An interface's IPv6 configuration (model/ipv6.ts): its method
 * (`ipv6:` static, slaac, dhcpv6, slaac_dhcpv6) and a router interface's
 * advertisements (`ipv6_ra:`). Per interface: the method is one of the
 * four, an automatic one is not on a loopback or tunnel, `static` has
 * IPv6 addresses to be static with; advertisements are a routing
 * device's, on an interface that routes, with at least one prefix written
 * (each an IPv6 prefix, a /64 when its addresses are for SLAAC), their
 * lifetimes in range and the preferred no longer than the valid one.
 */
import { IpAddr, parsePrefix, parseAddress } from '../model/ip';
import { Ipv6Method, IPV6_METHODS, RaConfig, autoIpv6 } from '../model/ipv6';
import { Device, Interface } from '../model/types';
import { capabilities } from '../model/capabilities';
import { formatAddr } from '../analysis/ipmath';
import { parseValue } from '../analysis/sim/params';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, Reader, get, isNull, suggest } from './reader';

const S = 1000;

/** Read `ipv6:` and `ipv6_ra:` of an interface into it. */
export function readIpv6(r: Reader, c: Ctx, im: YMap, ipath: string, iface: Interface, dev: Device): void {
  const n = get(im, 'ipv6');
  const v6addrs = iface.addresses.filter((a) => a.indexOf(':') >= 0);
  if (!isNull(n)) {
    const t = r.str(n as YNode, ipath + '.ipv6', 20);
    const ids = IPV6_METHODS.map((x) => x.id as string);
    if (t !== undefined && ids.indexOf(t) < 0) c.error(n as YNode, ipath + '.ipv6', `"${t}" is not an IPv6 method${suggest(t, ids)}: use static, slaac, dhcpv6 or slaac_dhcpv6`);
    else if (t !== undefined) {
      const m = t as Ipv6Method;
      if (autoIpv6(m) && (iface.type === 'loopback' || iface.type === 'tunnel')) c.error(n as YNode, ipath + '.ipv6', `a ${iface.type} interface configures no IPv6 address automatically: write its addresses under "ip:" and delete "ipv6: ${m}"`);
      else if (m === 'static' && !v6addrs.length) c.error(n as YNode, ipath + '.ipv6', `"${iface.id}" has no IPv6 address to be static with: write them under "ip:", or choose slaac or dhcpv6`);
      else iface.ipv6 = m;
    }
  } else if (v6addrs.length) iface.ipv6 = 'static';
  const ran = get(im, 'ipv6_ra');
  if (isNull(ran)) return;
  const path = ipath + '.ipv6_ra';
  const m = r.map(ran as YNode, path);
  if (!m) return;
  r.keys(m, SCHEMA.ipv6Ra, path);
  const ra: RaConfig = { prefixes: [], dns: [], managed: false, other: false, autonomous: true, line: m.line };
  // who advertises: a routing device's interface that routes (its port or VLAN interface, never a switch port, a loopback or a tunnel)
  if (!capabilities(dev).l3Forward) c.error(ran as YNode, path, `router advertisements are a router’s: "${dev.id}" routes nothing — delete "ipv6_ra"`);
  else if (iface.type === 'loopback' || iface.type === 'tunnel') c.error(ran as YNode, path, `a ${iface.type} interface sends no router advertisements: they go on a link (a routed port, a VLAN interface)`);
  const pn = get(m, 'prefixes');
  const items = isNull(pn) ? [] : r.list(pn as YNode, path + '.prefixes', true);
  for (const [k, x] of items.entries()) {
    const t = r.str(x, `${path}.prefixes[${k}]`, 64);
    if (t === undefined) continue;
    const p = parsePrefix(t, true);
    if (!p || p.version !== 6) {
      c.error(x, `${path}.prefixes[${k}]`, `"${t}" is not an IPv6 prefix (e.g. 2001:db8:10::/64)`);
      continue;
    }
    ra.prefixes.push(t);
  }
  if (!ra.prefixes.length) c.error(m, path + '.prefixes', `the advertisements of "${dev.id}:${iface.id}" need the prefixes they advertise: none is chosen for them (not every connected prefix is advertised)`, { key: 'prefixes' });
  const bool = (key: string): boolean | undefined => (isNull(get(m, key)) ? undefined : r.bool(get(m, key) as YNode, `${path}.${key}`));
  ra.managed = bool('managed') === true;
  ra.other = bool('other') === true;
  ra.autonomous = bool('autonomous') !== false;
  if (ra.autonomous) for (const t of ra.prefixes) {
    const p = parsePrefix(t, true);
    if (p && p.prefix !== 64) c.error(pn as YNode, path + '.prefixes', `${t}: SLAAC forms addresses in /64 prefixes only (RFC 4862: a 64-bit interface identifier) — advertise a /64, or set "autonomous: false"`);
  }
  const dn = get(m, 'dns');
  for (const [k, x] of (isNull(dn) ? [] : r.list(dn as YNode, path + '.dns', true)).entries()) {
    const t = r.str(x, `${path}.dns[${k}]`, 64);
    const a = t !== undefined ? parseAddress(t.trim()) : null;
    if (t !== undefined && (!a || a.version !== 6)) c.error(x, `${path}.dns[${k}]`, `"${t}" is not an IPv6 address (an RDNSS option carries IPv6 DNS servers)`);
    else if (a) ra.dns.push(formatAddr(a as IpAddr));
  }
  const dur = (key: string, min: number, max: number, what: string): number | undefined => {
    const x = get(m, key);
    if (isNull(x)) return undefined;
    const v = parseValue({ key, yaml: key, label: what, layer: 0, kind: 'duration', base: 's', dflt: 0, min, max, source: '', help: '' }, (x as YNode).kind === 'scalar' ? (x as { value: unknown }).value : undefined);
    if ('error' in v) {
      c.error(x as YNode, `${path}.${key}`, `${what} ${v.error}`);
      return undefined;
    }
    return Number(v.value);
  };
  ra.interval = dur('interval', 4 * S, 1800 * S, 'The advertisement interval (MaxRtrAdvInterval, 4 s to 30 min)');
  ra.routerLifetime = dur('router_lifetime', 0, 9000 * S, 'The router lifetime (0 to 9000 s; 0: not a default router)');
  ra.preferredLifetime = dur('preferred_lifetime', 0, 4294967 * S, 'The preferred lifetime');
  ra.validLifetime = dur('valid_lifetime', 0, 4294967 * S, 'The valid lifetime');
  ra.dnsLifetime = dur('dns_lifetime', 0, 4294967 * S, 'The DNS servers’ lifetime');
  // RFC 4861 §6.2.1: AdvDefaultLifetime is 0 or between MaxRtrAdvInterval and 9000 s
  const iv = ra.interval !== undefined ? ra.interval : 600 * S;
  if (ra.routerLifetime !== undefined && ra.routerLifetime > 0 && ra.routerLifetime < iv) c.error(get(m, 'router_lifetime') as YNode, path + '.router_lifetime', `the router lifetime (${ra.routerLifetime / S} s) is shorter than the advertisement interval (${iv / S} s): hosts would lose their default router between two advertisements — make it 0 or at least the interval (RFC 4861 §6.2.1)`);
  if (ra.preferredLifetime !== undefined && ra.validLifetime !== undefined && ra.preferredLifetime > ra.validLifetime) c.error(get(m, 'preferred_lifetime') as YNode, path + '.preferred_lifetime', 'the preferred lifetime is longer than the valid lifetime: an address can’t be preferred after it is no longer valid');
  if (!isNull(get(m, 'dns_lifetime')) && !ra.dns.length) c.error(get(m, 'dns_lifetime') as YNode, path + '.dns_lifetime', '"dns_lifetime" is the lifetime of the DNS servers it advertises: write them under "dns", or delete it');
  iface.ra = ra;
}

/** With the device read: advertised prefixes the interface has no address in are announced, not routed by it (a warning). */
export function checkRaPrefixes(c: Ctx, iface: Interface, node: YMap, path: string): void {
  if (!iface.ra) return;
  const own = iface.addresses.map((a) => parsePrefix(a, false)).filter((p): p is NonNullable<typeof p> => !!p && p.version === 6);
  for (const t of iface.ra.prefixes) {
    const p = parsePrefix(t, true);
    if (!p) continue;
    const inside = own.some((a) => a.prefix >= p.prefix && samePrefix(a.bytes, p.bytes, p.prefix));
    if (!inside) c.warn(get(node, 'ipv6_ra') as YNode, path + '.ipv6_ra.prefixes', `${t}: "${iface.id}" has no address in this prefix, so it advertises a network it has no route of its own to — give it an address there (e.g. ${t.replace(/::\/64$/, '::1/64')})`);
  }
}

function samePrefix(a: number[], b: number[], bits: number): boolean {
  for (let i = 0; i < a.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

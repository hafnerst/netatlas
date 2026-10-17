/**
 * A server's network services (`services:`): a DHCP server and a DNS
 * server. Only servers run them (a server, a VM or a container: they host
 * the same services; storage, appliances and network devices don't). An
 * enabled service shows what it still needs as errors (nothing is chosen
 * for the user): a DHCP server its scopes, each with its network, range,
 * default gateway and DNS servers (the lease time is 1 day unless written);
 * a DNS server its zones, each with its name. With the whole model known
 * (checkNetServices): a range inside its network, without the gateway or a
 * statically assigned address, no overlapping scopes, exclusions inside the
 * range, reservations inside the network; a zone's own records inside it,
 * no duplicates, no CNAME beside another record, A / AAAA values that are
 * addresses of the model, the listening address one of the server's own.
 * Also a host's static DNS servers (`dns_servers:`) and a routed
 * interface's DHCP relay (`dhcp_relay:`).
 */
import { formatAddr, inPrefix, networkOf, prefixText } from '../analysis/ipmath';
import { ParamDef, parseValue } from '../analysis/sim/params';
import { dnsNameKey, dnsNameProblem } from '../model/dns';
import { DEFAULT_LEASE, cmpAddr, derivedRecords, inRange, inZone, recordFqdn } from '../model/netservices';
import { IpAddr, IpPrefix, parseAddress, parsePrefix } from '../model/ip';
import { Device, DhcpScope, DnsRecord, DnsZone, Model, NetServices, deviceInterfaces } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, Reader, get, isNull } from './reader';
import { SimBlock, readSimBlock } from './simulation';
import { SvcDef, serviceDef, serviceEligibility } from '../model/service-registry';



const LEASE_DEF: ParamDef = { key: 'dhcp-lease', yaml: 'lease', label: 'Lease time', layer: 0, kind: 'duration', base: 's', dflt: DEFAULT_LEASE, min: 60000, max: 365 * 86400000, source: 'one day (Windows Server: 8 days, ISC: 12 h; one day is common)', help: '' };

const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

/** Where each scope and zone was written (for the checks with the whole model). */
export interface NetServiceNodes {
  device: string;
  scopes: Array<{ scope: DhcpScope; node: YMap; path: string; sim?: SimBlock }>;
  zones: Array<{ zone: DnsZone; node: YMap; path: string; sim?: SimBlock; records: Array<{ record: DnsRecord; node: YMap; path: string }> }>;
  dns?: { node: YMap; path: string };
}

/** An address as written (a scalar), checked; undefined (and an error) when it is not one. */
function addr(r: Reader, c: Ctx, n: YNode | undefined, path: string, v4 = false): string | undefined {
  const t = r.str(n, path, 64);
  if (t === undefined) return undefined;
  const a = parseAddress(t.trim());
  if (!a || (v4 && a.version !== 4)) {
    c.error(n as YNode, path, `"${t}" is not ${v4 ? 'an IPv4' : 'an IP'} address`);
    return undefined;
  }
  return formatAddr(a);
}

/** A list of addresses (a YAML list, or one written as a scalar). */
export function readAddressList(r: Reader, c: Ctx, n: YNode | undefined, path: string, v4 = false): string[] {
  return addrList(r, c, n, path, v4);
}

function addrList(r: Reader, c: Ctx, n: YNode | undefined, path: string, v4 = false): string[] {
  if (isNull(n)) return [];
  const out: string[] = [];
  r.list(n, path, true).forEach((x, k) => {
    const a = addr(r, c, x, `${path}[${k}]`, v4);
    if (a !== undefined && out.indexOf(a) < 0) out.push(a);
  });
  return out;
}

/** A device's `services:`: a DHCP server and / or a DNS server. */
export function readNetServices(r: Reader, c: Ctx, n: YNode | undefined, path: string, dev: Device): { services: NetServices; nodes: NetServiceNodes } | undefined {
  if (isNull(n)) return undefined;
  const m = r.map(n, path);
  if (!m) return undefined;
  r.keys(m, SCHEMA.netServices, path);
  // (the Hypervisor and the Container engine are read in virtual.ts)
  if (get(m, 'dhcp') === undefined && get(m, 'dns') === undefined) return undefined;
  // (who may run them is the service registry's: readServiceBlock reports a device that may not)
  const may = (id: string): boolean => serviceEligibility(serviceDef(id) as SvcDef, dev) === null;
  if (!may('dhcp') && !may('dns')) return undefined;
  const out: NetServices = {};
  const nodes: NetServiceNodes = { device: dev.id, scopes: [], zones: [] };
  // DHCP
  const dn = may('dhcp') ? get(m, 'dhcp') : undefined;
  if (dn !== undefined) {
    const dm = isNull(dn) ? null : r.map(dn, path + '.dhcp');
    const dpath = path + '.dhcp';
    out.dhcp = { scopes: [], line: dn.line };
    if (dm) r.keys(dm, SCHEMA.dhcpService, dpath);
    const sn = dm ? get(dm, 'scopes') : undefined;
    const items = isNull(sn) ? [] : r.list(sn, dpath + '.scopes');
    if (!items.length) c.error(dm || (dn as YNode), dpath + '.scopes', `the DHCP server of "${dev.id}" needs a scope: add one (its network, range, default gateway and DNS servers)`, { key: 'scopes' });
    items.forEach((it, k) => {
      const spath = `${dpath}.scopes[${k}]`;
      const sm = r.map(it, spath);
      if (!sm) return;
      r.keys(sm, SCHEMA.dhcpScope, spath);
      const need = (key: string, what: string): YNode | undefined => {
        const v = get(sm, key);
        if (isNull(v)) {
          c.error(sm, `${spath}.${key}`, `scope ${k + 1} of "${dev.id}" needs its ${what}`, { key });
          return undefined;
        }
        return v;
      };
      const scope: DhcpScope = { dns: [], exclude: [], reservations: [], line: sm.line };
      const net = need('network', 'network (a network of the model it leases addresses in)');
      if (net) scope.network = r.str(net, spath + '.network', 200);
      const rn = need('range', 'address range (start-end, e.g. 10.1.1.100-10.1.1.199)');
      if (rn) {
        const t = r.str(rn, spath + '.range', 100);
        const mm = t !== undefined ? /^\s*([0-9.]+)\s*-\s*([0-9.]+)\s*$/.exec(t) : null;
        const a = mm ? parseAddress(mm[1]) : null;
        const b = mm ? parseAddress(mm[2]) : null;
        if (t !== undefined && (!a || !b || a.version !== 4 || b.version !== 4)) c.error(rn, spath + '.range', `"${t}" is not a range of IPv4 addresses (start-end, e.g. 10.1.1.100-10.1.1.199)`);
        else if (a && b) {
          if (cmpAddr(a, b) > 0) c.error(rn, spath + '.range', `the range starts after it ends (${formatAddr(a)} > ${formatAddr(b)})`);
          else {
            scope.range = `${formatAddr(a)}-${formatAddr(b)}`;
            scope.start = formatAddr(a);
            scope.end = formatAddr(b);
          }
        }
      }
      const gw = need('gateway', 'default gateway (the router’s address in the network, or its virtual address)');
      if (gw) scope.gateway = addr(r, c, gw, spath + '.gateway', true);
      const dnsN = need('dns', 'DNS servers (the addresses it gives its clients)');
      if (dnsN) {
        scope.dns = addrList(r, c, dnsN, spath + '.dns');
        if (!scope.dns.length && !isNull(dnsN)) c.error(dnsN, spath + '.dns', `scope ${k + 1} of "${dev.id}" needs at least one DNS server address`);
      }
      const ln = get(sm, 'lease');
      if (!isNull(ln)) {
        const v = parseValue(LEASE_DEF, (ln as YNode).kind === 'scalar' ? (ln as { value: unknown }).value : undefined);
        if ('error' in v) c.error(ln as YNode, spath + '.lease', `Lease time ${v.error} (a bare number is in seconds)`);
        else scope.lease = Number(v.value);
      }
      scope.exclude = addrList(r, c, get(sm, 'exclude'), spath + '.exclude', true);
      const resN = get(sm, 'reservations');
      if (!isNull(resN)) {
        r.list(resN, spath + '.reservations').forEach((x, j) => {
          const rp = `${spath}.reservations[${j}]`;
          const rm = r.map(x, rp);
          if (!rm) return;
          r.keys(rm, SCHEMA.dhcpReservation, rp);
          const mac = r.reqStr(rm, 'mac', rp, 40);
          const ip = isNull(get(rm, 'ip')) ? (c.error(rm, rp + '.ip', 'a reservation needs its address', { key: 'ip' }), undefined) : addr(r, c, get(rm, 'ip'), rp + '.ip', true);
          if (mac !== undefined && !MAC_RE.test(mac.trim())) c.error(get(rm, 'mac') as YNode, rp + '.mac', `"${mac}" is not a MAC address (e.g. 02:00:00:00:00:01)`);
          else if (mac !== undefined && ip !== undefined) scope.reservations.push({ mac: mac.trim().toLowerCase().replace(/-/g, ':'), ip, line: rm.line });
        });
      }
      const dom = r.field(sm, 'domain', spath, 253);
      if (dom !== undefined) {
        const why = dnsNameProblem(dom);
        if (why) c.error(get(sm, 'domain') as YNode, spath + '.domain', `the domain name "${dom}": ${why}`);
        else scope.domain = dom;
      }
      const sb = readSimBlock(r, c, get(sm, 'simulation'), spath + '.simulation', 'service');
      if (sb) scope.simulation = sb.values;
      (out.dhcp as { scopes: DhcpScope[] }).scopes.push(scope);
      nodes.scopes.push({ scope, node: sm, path: spath, sim: sb });
    });
  }
  // DNS
  const zn = may('dns') ? get(m, 'dns') : undefined;
  if (zn !== undefined) {
    const zm = isNull(zn) ? null : r.map(zn, path + '.dns');
    const zpath = path + '.dns';
    out.dns = { zones: [], reverse: [], forwarders: [], line: zn.line };
    if (zm) {
      r.keys(zm, SCHEMA.dnsService, zpath);
      nodes.dns = { node: zm, path: zpath };
      const ls = get(zm, 'listen');
      if (!isNull(ls)) out.dns.listen = addr(r, c, ls, zpath + '.listen');
      out.dns.forwarders = addrList(r, c, get(zm, 'forwarders'), zpath + '.forwarders');
      const rv = get(zm, 'reverse_zones');
      if (!isNull(rv)) {
        r.list(rv, zpath + '.reverse_zones', true).forEach((x, k) => {
          const t = r.str(x, `${zpath}.reverse_zones[${k}]`, 64);
          const p = t !== undefined ? parsePrefix(t) : null;
          if (t !== undefined && !p) c.error(x, `${zpath}.reverse_zones[${k}]`, `"${t}" is not a network (a reverse zone is written as its prefix, e.g. 10.1.0.0/16)`);
          else if (p) out.dns!.reverse.push(prefixText(networkOf(p)));
        });
      }
    }
    const zitems = zm && !isNull(get(zm, 'zones')) ? r.list(get(zm, 'zones'), zpath + '.zones') : [];
    // a DNS server answers for its zones, or forwards (a router's or firewall's DNS forwarder): one or the other
    if (!zitems.length && !out.dns.forwarders.length) c.error(zm || (zn as YNode), zpath + '.zones', `the DNS server of "${dev.id}" needs a zone (its domain name, e.g. hq.example) or forwarders (the servers it asks)`, { key: 'zones' });
    const seenZones = new Set<string>();
    zitems.forEach((it, k) => {
      const zp = `${zpath}.zones[${k}]`;
      const zmap = r.map(it, zp);
      if (!zmap) return;
      r.keys(zmap, SCHEMA.dnsZone, zp);
      const name = isNull(get(zmap, 'name')) ? (c.error(zmap, zp + '.name', `zone ${k + 1} of "${dev.id}" needs its name (a domain, e.g. hq.example)`, { key: 'name' }), undefined) : r.str(get(zmap, 'name'), zp + '.name', 253);
      if (name === undefined) return;
      const why = dnsNameProblem(name);
      if (why) {
        c.error(get(zmap, 'name') as YNode, zp + '.name', `the zone name "${name}": ${why}`);
        return;
      }
      if (seenZones.has(dnsNameKey(name))) c.error(get(zmap, 'name') as YNode, zp + '.name', `zone ${name} is written twice on "${dev.id}"`);
      seenZones.add(dnsNameKey(name));
      const zone: DnsZone = { name: dnsNameKey(name), records: [], line: zmap.line };
      const recs: NetServiceNodes['zones'][number]['records'] = [];
      const rn = get(zmap, 'records');
      if (!isNull(rn)) {
        r.list(rn, zp + '.records').forEach((x, j) => {
          const rp = `${zp}.records[${j}]`;
          const rm = r.map(x, rp);
          if (!rm) return;
          r.keys(rm, SCHEMA.dnsRecord, rp);
          const rname = r.reqStr(rm, 'name', rp, 253);
          const type = r.reqStr(rm, 'type', rp, 10);
          const value = r.reqStr(rm, 'value', rp, 253);
          if (rname === undefined || type === undefined || value === undefined) return;
          const T = type.toUpperCase();
          if (T !== 'A' && T !== 'AAAA' && T !== 'CNAME') {
            c.error(get(rm, 'type') as YNode, rp + '.type', `record type "${type}": a record is A, AAAA or CNAME`);
            return;
          }
          const nameWhy = rname === '@' ? null : dnsNameProblem(rname);
          if (nameWhy) {
            c.error(get(rm, 'name') as YNode, rp + '.name', `the record name "${rname}": ${nameWhy}`);
            return;
          }
          if (T === 'CNAME') {
            const vw = dnsNameProblem(value);
            if (vw) {
              c.error(get(rm, 'value') as YNode, rp + '.value', `a CNAME points to a name: "${value}": ${vw}`);
              return;
            }
          } else {
            const a = parseAddress(value.trim());
            if (!a || a.version !== (T === 'A' ? 4 : 6)) {
              c.error(get(rm, 'value') as YNode, rp + '.value', `an ${T} record's value is an ${T === 'A' ? 'IPv4' : 'IPv6'} address: "${value}" is not one`);
              return;
            }
          }
          const record: DnsRecord = { name: rname, type: T as DnsRecord['type'], value: T === 'CNAME' ? dnsNameKey(value) : formatAddr(parseAddress(value.trim()) as IpAddr), line: rm.line };
          zone.records.push(record);
          recs.push({ record, node: rm, path: rp });
        });
      }
      const sb = readSimBlock(r, c, get(zmap, 'simulation'), zp + '.simulation', 'service');
      if (sb) zone.simulation = sb.values;
      out.dns!.zones.push(zone);
      nodes.zones.push({ zone, node: zmap, path: zp, sim: sb, records: recs });
    });
  }
  return { services: out, nodes };
}





/** The prefix of a network of the model (undefined: none, or not IPv4 when asked). */
function netPrefix(model: Model, id: string | undefined, v4 = true): IpPrefix | undefined {
  const n = id ? model.networks.find((x) => x.id === id) : undefined;
  const p = n && n.cidr ? parsePrefix(n.cidr) : null;
  return p && (!v4 || p.version === 4) ? networkOf(p) : undefined;
}

/** Every address configured on an interface of the model, with its owner. */
function staticAddresses(model: Model): Array<{ a: IpAddr; owner: string }> {
  const out: Array<{ a: IpAddr; owner: string }> = [];
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      for (const t of i.addresses) {
        const p = parsePrefix(t, false);
        if (p) out.push({ a: { version: p.version, bytes: p.bytes }, owner: `${d.id}:${i.id}` });
      }
    }
  }
  return out;
}

/** The checks of the servers' services with the whole model (see the top of this file). */
export function checkNetServices(c: Ctx, model: Model, all: NetServiceNodes[]): void {
  const statics = staticAddresses(model);
  const ranges: Array<{ dev: string; k: number; start: IpAddr; end: IpAddr; node: YMap; path: string }> = [];
  for (const n of all) {
    const dev = model.index.devices.get(n.device);
    if (!dev) continue;
    n.scopes.forEach((s, k) => {
      const sc = s.scope;
      const net = sc.network ? model.networks.find((x) => x.id === sc.network) : undefined;
      if (sc.network && !net) {
        c.error(s.node, s.path + '.network', `scope ${k + 1} of "${n.device}": "${sc.network}" is not a network of the model`, { key: 'network' });
        return;
      }
      const p = netPrefix(model, sc.network);
      if (net && !p) {
        c.error(s.node, s.path + '.network', `scope ${k + 1} of "${n.device}": network "${net.id}" is not an IPv4 network (DHCP leases IPv4 addresses here; DHCPv6 is not modelled)`, { key: 'network' });
        return;
      }
      if (!p) return;
      const where = `${net ? net.id : ''} (${prefixText(p)})`;
      const a = sc.start ? (parseAddress(sc.start) as IpAddr) : null;
      const b = sc.end ? (parseAddress(sc.end) as IpAddr) : null;
      if (a && b) {
        if (!inPrefix(p, a) || !inPrefix(p, b)) c.error(s.node, s.path + '.range', `the range ${sc.range} is not inside the network ${where}`, { key: 'range' });
        else {
          const gw = sc.gateway ? parseAddress(sc.gateway) : null;
          if (gw && inRange(gw, a, b)) c.error(s.node, s.path + '.range', `the range ${sc.range} contains the default gateway ${sc.gateway}`, { key: 'range' });
          const st = statics.find((x) => inRange(x.a, a, b));
          if (st) c.error(s.node, s.path + '.range', `the range ${sc.range} contains ${formatAddr(st.a)}, statically assigned to ${st.owner}`, { key: 'range' });
          for (const o of ranges) {
            if (o.start.version !== a.version) continue;
            if (cmpAddr(a, o.end) <= 0 && cmpAddr(o.start, b) <= 0) c.error(s.node, s.path + '.range', `the range ${sc.range} overlaps scope ${o.k + 1} of "${o.dev}" (${formatAddr(o.start)}-${formatAddr(o.end)})`, { key: 'range' });
          }
          ranges.push({ dev: n.device, k, start: a, end: b, node: s.node, path: s.path });
          for (const e of sc.exclude) if (!inRange(parseAddress(e) as IpAddr, a, b)) c.error(s.node, s.path + '.exclude', `the excluded address ${e} is not in the range ${sc.range}`, { key: 'exclude' });
        }
      }
      if (sc.gateway && !inPrefix(p, parseAddress(sc.gateway) as IpAddr)) c.error(s.node, s.path + '.gateway', `the default gateway ${sc.gateway} is not in the network ${where}`, { key: 'gateway' });
      const macs = new Set<string>();
      const ips = new Set<string>();
      for (const rv of sc.reservations) {
        const ra = parseAddress(rv.ip) as IpAddr;
        if (!inPrefix(p, ra)) c.error(s.node, s.path + '.reservations', `the reservation of ${rv.ip} (${rv.mac}) is not in the network ${where}`, { key: 'reservations', line: rv.line });
        const st = statics.find((x) => x.a.version === ra.version && cmpAddr(x.a, ra) === 0);
        if (st) c.error(s.node, s.path + '.reservations', `the reservation of ${rv.ip} (${rv.mac}): the address is statically assigned to ${st.owner}`, { key: 'reservations', line: rv.line });
        if (macs.has(rv.mac)) c.error(s.node, s.path + '.reservations', `${rv.mac} is reserved twice`, { key: 'reservations', line: rv.line });
        if (ips.has(rv.ip)) c.error(s.node, s.path + '.reservations', `${rv.ip} is reserved twice`, { key: 'reservations', line: rv.line });
        macs.add(rv.mac);
        ips.add(rv.ip);
      }
      // a scope's simulation attributes are a DHCP scope's
      if (s.sim) for (const key of Array.from(s.sim.values.keys())) {
        if (key === 'dns-ttl') {
          c.error(s.sim.map, `${s.path}.simulation.record_ttl`, '"record_ttl" (record ttl) is set per DNS zone: in the zone’s simulation:, not on a DHCP scope', { key: 'record_ttl' });
          s.sim.values.delete(key);
        }
      }
    });
    // DNS
    const ownAddrs = staticAddresses({ ...model, devices: [dev] } as Model).map((x) => formatAddr(x.a));
    const dns = dev.netServices && dev.netServices.dns;
    if (dns && dns.listen && ownAddrs.indexOf(dns.listen) < 0 && n.dns) c.error(n.dns.node, n.dns.path + '.listen', `"${n.device}" listens on ${dns.listen}, which is not one of its addresses (${ownAddrs.join(', ') || 'none'})`, { key: 'listen' });
    for (const z of n.zones) {
      const seen = new Map<string, DnsRecord[]>();
      for (const x of derivedRecords(model, z.zone.name)) seen.set(x.fqdn + '|' + x.type, [{ name: x.fqdn, type: x.type, value: x.value, line: 0 }]);
      for (const rr of z.records) {
        const rec = rr.record;
        const fq = recordFqdn(z.zone.name, rec.name);
        if (!inZone(fq, z.zone.name)) {
          c.error(rr.node, rr.path + '.name', `${rec.name} is outside the zone ${z.zone.name}`, { key: 'name' });
          continue;
        }
        const same = seen.get(fq + '|' + rec.type) || [];
        if (same.some((o) => o.value === rec.value)) c.error(rr.node, rr.path, `${fq} ${rec.type} ${rec.value} is written twice (or is already derived from a DNS name of the model)`);
        const cname = rec.type === 'CNAME' ? ['A', 'AAAA', 'CNAME'].some((t) => (seen.get(fq + '|' + t) || []).length) : (seen.get(fq + '|CNAME') || []).length > 0;
        if (cname) c.error(rr.node, rr.path, `${fq}: a CNAME cannot share its name with another record`);
        seen.set(fq + '|' + rec.type, same.concat([rec]));
        if (rec.type !== 'CNAME') {
          const a = parseAddress(rec.value) as IpAddr;
          if (!statics.some((x) => x.a.version === a.version && cmpAddr(x.a, a) === 0)) c.warn(rr.node, rr.path + '.value', `${fq} ${rec.type} ${rec.value}: no interface of the model has this address`);
        }
      }
      if (z.sim) for (const key of Array.from(z.sim.values.keys())) {
        if (key !== 'dns-ttl') {
          c.error(z.sim.map, `${z.path}.simulation`, 'a DNS zone’s simulation: has record_ttl only (offer_delay and ping_check are a DHCP scope’s)');
          z.sim.values.delete(key);
        }
      }
    }
  }
}


/**
 * Name resolution as the model defines it, without running anything: a
 * DNS server's zones (the model's DNS names in a zone as A / AAAA records,
 * and the zone's own A, AAAA and CNAME records; a CNAME followed within the
 * zone), NXDOMAIN for a name in one of its zones that has no record, its
 * forwarders (DNS servers of the model) for a name in none of its zones,
 * else SERVFAIL. The simulation's DNS servers answer by the same records
 * (analysis/sim/netsvc.ts zoneRecords); this is the static reading of them.
 *
 * Which servers a host asks: its `dns_servers:`, or, for an interface that
 * takes its address by DHCP, the DNS servers of the scopes of the networks
 * its cable carries (what a lease would give it). Configuration, not proof
 * that a query is answered: a server's reachability is a separate question
 * (the path tracer's), and caches, TTLs and timeouts are runtime behaviour.
 * Pure and deterministic.
 */
import { parseAddress } from '../model/ip';
import { DnsZone, Model, deviceInterfaces } from '../model/types';
import { dnsNameKey } from '../model/dns';
import { derivedRecords, inZone, recordFqdn } from '../model/netservices';
import { linkNetworks } from '../model/derive';
import { compareAddr } from './ipmath';
import { connectedOf } from './routing';

export interface ZoneRecord {
  name: string;
  type: string;
  value: string;
  source: string;
}

/** A server's zone: the model's DNS names in it (A / AAAA), then its own records. */
export function zoneRecords(model: Model, dev: string, zone: string): ZoneRecord[] {
  const d = model.index.devices.get(dev);
  const z = d && d.netServices && d.netServices.dns ? d.netServices.dns.zones.find((x) => x.name === zone) : undefined;
  if (!z) return [];
  const out: ZoneRecord[] = derivedRecords(model, zone).map((r) => ({ name: r.fqdn, type: r.type as string, value: r.value, source: r.source }));
  for (const r of z.records) out.push({ name: recordFqdn(zone, r.name), type: r.type, value: r.value, source: 'zone record' });
  return out;
}

/** The server's zone a name belongs to (the longest), if any. */
export function zoneFor(model: Model, dev: string, name: string): DnsZone | undefined {
  const d = model.index.devices.get(dev);
  const dns = d && d.netServices ? d.netServices.dns : undefined;
  const k = dnsNameKey(name);
  return dns ? dns.zones.filter((z) => inZone(k, z.name)).sort((a, b) => b.name.length - a.name.length)[0] : undefined;
}

/** What a DNS server of the model would answer, by its configuration. */
export interface NameAnswer {
  rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  addresses: string[];
  /** the server that has the zone (the asked one, or a forwarder) */
  server: string;
  zone?: string;
  cname?: string;
  /** the forwarder the asked server passes the query to */
  forwarder?: string;
  why: string;
}

/** The device that has an address (configured), if exactly one does; else the first by id. */
/** Every device that has an address on one of its interfaces (an address two VRFs both have: both), sorted by id. */
export function addressHolders(model: Model, address: string): string[] {
  const a = parseAddress(address);
  if (!a) return [];
  return model.devices
    .map((d) => d.id)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    .filter((d) => connectedOf(model, d).some((c) => compareAddr(c.addr, a) === 0));
}

export function addressOwner(model: Model, address: string): string | undefined {
  const a = parseAddress(address);
  if (!a) return undefined;
  for (const d of model.devices.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) if (connectedOf(model, d.id).some((c) => compareAddr(c.addr, a) === 0)) return d.id;
  return undefined;
}

/** The answer of a server for a name and type (A, AAAA), as its zones and forwarders give it (forwarders followed once). */
export function answerAt(model: Model, dev: string, name: string, qtype: 'A' | 'AAAA', depth = 0): NameAnswer {
  const d = model.index.devices.get(dev);
  const dns = d && d.netServices ? d.netServices.dns : undefined;
  const k = dnsNameKey(name);
  if (!dns) return { rcode: 'SERVFAIL', addresses: [], server: dev, why: `${dev} runs no DNS server` };
  const zone = zoneFor(model, dev, k);
  if (!zone) {
    const usable = dns.forwarders
      .map((x) => addressOwner(model, x))
      .filter((o): o is string => {
        const od = o ? model.index.devices.get(o) : undefined;
        return !!o && o !== dev && !!od && !!od.netServices && !!od.netServices.dns;
      });
    if (usable.length && depth < 2) {
      const a = answerAt(model, usable[0], k, qtype, depth + 1);
      return { ...a, forwarder: usable[0], why: `${dev} has no zone for ${k}: it forwards to ${usable[0]}; ${a.why}` };
    }
    return { rcode: 'SERVFAIL', addresses: [], server: dev, why: dns.forwarders.length ? `${dev} has no zone for ${k}, and its forwarders are outside the model` : `${dev} has no zone for ${k} and no forwarder` };
  }
  const recs = zoneRecords(model, dev, zone.name);
  let cname: string | undefined;
  let cur = k;
  for (let i = 0; i < 8; i++) {
    const cn = recs.find((r) => r.name === cur && r.type === 'CNAME');
    if (!cn) break;
    cname = cname || cn.value;
    cur = dnsNameKey(cn.value);
  }
  const addresses = recs.filter((r) => r.name === cur && r.type === qtype).map((r) => r.value);
  if (addresses.length) {
    const out: NameAnswer = { rcode: 'NOERROR', addresses, server: dev, zone: zone.name, why: `${dev} answers ${k} ${qtype} ${addresses.join(', ')} from its zone ${zone.name}` };
    if (cname) out.cname = cname;
    return out;
  }
  const exists = recs.some((r) => r.name === k);
  return { rcode: exists ? 'NOERROR' : 'NXDOMAIN', addresses: [], server: dev, zone: zone.name, why: exists ? `${k} has no ${qtype} record in ${zone.name} on ${dev}` : `${k} does not exist in ${zone.name} on ${dev} (NXDOMAIN)` };
}

/** A DNS server a host is configured to ask, and where that configuration comes from. */
export interface Resolver {
  address: string;
  /** "dns_servers", or the DHCP scope that hands it out ("DHCP scope of internal on core") */
  source: string;
  /** the interface whose lease brings it (a DHCP client) */
  iface?: string;
}

/** The DNS servers a device asks: its `dns_servers:`, else what the DHCP scopes of its DHCP interfaces' networks give out. */
export function resolversOf(model: Model, dev: string): Resolver[] {
  const d = model.index.devices.get(dev);
  if (!d) return [];
  if (d.dnsServers && d.dnsServers.length) return d.dnsServers.map((a) => ({ address: a, source: 'dns_servers' }));
  const out: Resolver[] = [];
  for (const i of deviceInterfaces(d)) {
    if (!i.dhcp) continue;
    const lid = model.index.ifaceLink.get(d.id + ':' + i.id);
    const l = lid ? model.index.links.get(lid) : undefined;
    const nets = l ? linkNetworks(model, l) : [];
    for (const srv of model.devices) {
      const dh = srv.netServices ? srv.netServices.dhcp : undefined;
      for (const s of dh ? dh.scopes : []) {
        if (!s.network || nets.indexOf(s.network) < 0) continue;
        for (const a of s.dns) if (!out.some((x) => x.address === a)) out.push({ address: a, source: `the DHCP scope of ${s.network} on ${srv.id}`, iface: i.id });
      }
    }
  }
  return out;
}

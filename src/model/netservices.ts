/**
 * The servers' network services as data (see validation/netservices.ts for
 * the format and its checks): which devices run them, the default lease,
 * address ranges, the names of a zone and the records the model's DNS names
 * give it. Pure; used by validation, the Inspector, the checks and the
 * simulation alike.
 */
import { dnsNameKey } from './dns';
import { IpAddr, parsePrefix } from './ip';
import { Model } from './types';

/** The device types that run network services (servers: a server, a VM, a container). */
export const SERVER_TYPES: readonly string[] = ['server', 'vm', 'container'];

/** The lease time without one written: one day (ms). */
export const DEFAULT_LEASE = 86400000;

export function cmpAddr(a: IpAddr, b: IpAddr): number {
  for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) return a.bytes[i] - b.bytes[i];
  return 0;
}

/** Is an address within a range (both ends included)? */
export function inRange(a: IpAddr, start: IpAddr, end: IpAddr): boolean {
  return a.version === start.version && cmpAddr(a, start) >= 0 && cmpAddr(a, end) <= 0;
}

/** A record's name in full (a relative name in its zone; "@" is the zone itself). */
export function recordFqdn(zone: string, name: string): string {
  if (name === '@') return zone;
  const k = dnsNameKey(name);
  if (name.charAt(name.length - 1) === '.') return k;
  return k === zone || k.endsWith('.' + zone) ? k : `${k}.${zone}`;
}

/** Is a name in a zone (the zone itself or below it)? */
export function inZone(name: string, zone: string): boolean {
  const k = dnsNameKey(name);
  return k === zone || k.endsWith('.' + zone);
}

/** The A / AAAA records the model's DNS names give a zone: each name in it, with the addresses of its interfaces (read-only, with their source). */
export function derivedRecords(model: Model, zone: string): Array<{ fqdn: string; type: 'A' | 'AAAA'; value: string; source: string }> {
  const out: Array<{ fqdn: string; type: 'A' | 'AAAA'; value: string; source: string }> = [];
  for (const d of model.devices) {
    for (const dn of d.dnsNames) {
      const fq = dnsNameKey(dn.name);
      if (!inZone(fq, zone)) continue;
      for (const iid of dn.interfaces) {
        const i = model.index.interfaces.get(d.id + ':' + iid);
        if (!i) continue;
        for (const t of i.addresses) {
          const p = parsePrefix(t, false);
          if (!p) continue;
          out.push({ fqdn: fq, type: p.version === 4 ? 'A' : 'AAAA', value: t.split('/')[0].toLowerCase(), source: `${d.id}:${iid} (DNS name ${dn.name})` });
        }
      }
    }
  }
  return out.sort((a, b) => (a.fqdn < b.fqdn ? -1 : a.fqdn > b.fqdn ? 1 : a.value < b.value ? -1 : 1));
}


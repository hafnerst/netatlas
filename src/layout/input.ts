/**
 * Canonical layout input.
 *
 * Auto-arrange is a pure function of this structure and of nothing else, so
 * two models that differ only in YAML key order, section order, the order of
 * list items (devices, interfaces, links, members, endpoints …), comments,
 * formatting, or fields that do not affect geometry (vendor, addresses,
 * attrs, protocols …) get exactly the same positions.
 *
 * Everything is sorted by id with plain code-unit string comparison (never
 * localeCompare, which depends on the browser locale).
 */
import { Model, loopbacks, relationDevices } from '../model/types';
import { networkSubtitle } from './sizes';

export interface LEnd {
  device: string;
  iface?: string;
}
export interface LLink {
  id: string;
  a: LEnd;
  b: LEnd;
}
export interface LDev {
  id: string;
  label: string;
  tier: number;
  group: string | null;
  loopbacks: number;
}
export interface LGroup {
  id: string;
  parent: string | null;
}
export interface LNet {
  id: string;
  label: string;
  sub: string;
  members: string[];
}
export interface LRel {
  id: string;
  devices: string[];
}
export interface LayoutInput {
  devices: LDev[];
  groups: LGroup[];
  links: LLink[];
  networks: LNet[];
  relations: LRel[];
}

/** Vertical tier of a device type in the physical view (0 = top). */
export function defaultTier(type: string): number {
  const t = type.toLowerCase();
  if (/^(cloud|internet|wan|isp|provider)$/.test(t)) return 0;
  if (/^(firewall|fw|ngfw|utm|ids|ips|waf)$/.test(t)) return 2;
  if (/^(router|gateway|vpn|pe|ce|bng|sdwan|sd-wan|loadbalancer|lb|adc)$/.test(t)) return 1;
  if (/^(l3switch|core|multilayer|spine)$/.test(t)) return 3;
  if (/^(switch|l2switch|leaf|access|tor)$/.test(t)) return 4;
  if (/^(ap|wlc|wireless|accesspoint)$/.test(t)) return 5;
  if (/^(server|host|hypervisor|vm|container|storage|nas|san|pc|workstation|laptop|phone|printer|camera|iot|client)$/.test(t)) return 6;
  return 4;
}

/** Code-unit string order: the same in every browser and locale. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byId<T extends { id: string }>(xs: T[]): T[] {
  return xs.slice().sort((p, q) => cmp(p.id, q.id));
}

function uniqSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort(cmp);
}

export function layoutInput(m: Model): LayoutInput {
  const devIds = new Set(m.devices.map((d) => d.id));
  return {
    devices: byId(
      m.devices.map((d) => ({
        id: d.id,
        label: d.label,
        tier: d.tier !== undefined ? d.tier : defaultTier(d.type),
        group: d.group || null,
        loopbacks: loopbacks(d).length,
      })),
    ),
    groups: byId(m.groups.map((g) => ({ id: g.id, parent: g.parent || null }))),
    links: byId(
      m.links.map((l) => {
        // endpoints in canonical order so "a/b" swapped is the same cable
        const ea: LEnd = l.a.iface ? { device: l.a.device, iface: l.a.iface } : { device: l.a.device };
        const eb: LEnd = l.b.iface ? { device: l.b.device, iface: l.b.iface } : { device: l.b.device };
        const ka = ea.device + ':' + (ea.iface || '');
        const kb = eb.device + ':' + (eb.iface || '');
        return cmp(ka, kb) <= 0 ? { id: l.id, a: ea, b: eb } : { id: l.id, a: eb, b: ea };
      }),
    ),
    networks: byId(
      m.networks.map((n) => ({
        id: n.id,
        label: n.label,
        sub: networkSubtitle(n.kind, n.cidr, n.vlan),
        members: uniqSorted(n.members.map((x) => x.device).filter((d) => devIds.has(d))),
      })),
    ),
    relations: byId(m.relations.map((r) => ({ id: r.id, devices: uniqSorted(relationDevices(r)) }))),
  };
}

/** Stable text form of the input: equal signatures always give equal auto-arrange results. */
export function layoutSignature(i: LayoutInput): string {
  return JSON.stringify(i);
}

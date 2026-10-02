/**
 * Canonical layout input.
 *
 * Auto-arrange is a pure function of this structure and of nothing else, so
 * two models that differ only in YAML key order, section order, the order of
 * list items (devices, interfaces, links, members, endpoints …), comments,
 * formatting, or fields that do not affect geometry (attrs,
 * protocols, addresses that do not change which network a device belongs
 * to …) get exactly the same positions.
 *
 * Everything is sorted by id with plain code-unit string comparison (never
 * localeCompare, which depends on the browser locale).
 */
import { deviceSubtitle } from '../model/device-types';
import { relationStyle } from '../model/protocols';
import { networkMembers, networkMismatch, networkName } from '../model/derive';
import { compareNames } from '../model/order';
import { Link, Model, loopbacks, relationDevices } from '../model/types';
import { buildBundle, laneLabel, relationPairs } from './bundles';
import { cmp } from './order';
import { chipTextWidth, loopbackChipText, networkSubtitle } from './sizes';

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
  /** second line of the device box: the type's display name */
  sub: string;
  tier: number;
  group: string | null;
  loopbacks: number;
  /** width the widest loopback chip needs in the logical view (0 without loopbacks) */
  chipW: number;
  /** the device's DNS names, each once, sorted (shown under it in the logical view) */
  dns: string[];
}
export interface LGroup {
  id: string;
  parent: string | null;
  label: string;
  kind: string;
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
  /** label of a multipoint relation's hub ('' for two-device relations, which are labelled per pair) */
  hubLabel: string;
}
/** The relations between one pair of devices: what has to fit between the two. */
export interface LPair {
  a: string;
  b: string;
  /** label texts, one per lane that carries a label */
  labels: string[];
  /** width of the bundle of lanes */
  width: number;
}
/** Text drawn on a cable. */
export interface LLinkLabel {
  id: string;
  text: string;
}
export interface LayoutInput {
  devices: LDev[];
  groups: LGroup[];
  links: LLink[];
  networks: LNet[];
  relations: LRel[];
  pairs: LPair[];
  linkLabels: LLinkLabel[];
}

/** Vertical tier of a device type in the physical view (0 = top). */
const TIERS: { [type: string]: number } = {
  cloud: 0,
  router: 1,
  gateway: 1,
  load_balancer: 1,
  proxy: 1,
  firewall: 2,
  ids_ips: 2,
  switch: 4,
  ap: 5,
  server: 6,
  vm: 6,
  container: 6,
  storage: 6,
  endpoint: 6,
  system: 6,
};

/** Default physical-view tier; devices without a known type sit with the switches. */
export function defaultTier(type: string): number {
  return Object.prototype.hasOwnProperty.call(TIERS, type) ? TIERS[type] : 4;
}

export { cmp };

function byId<T extends { id: string }>(xs: T[]): T[] {
  return xs.slice().sort((p, q) => cmp(p.id, q.id));
}

function uniqSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort(cmp);
}

export function layoutInput(m: Model): LayoutInput {
  return {
    devices: byId(
      m.devices.map((d) => ({
        id: d.id,
        label: d.label,
        sub: deviceSubtitle(d.type),
        tier: d.tier !== undefined ? d.tier : defaultTier(d.type),
        group: d.group || null,
        loopbacks: loopbacks(d).length,
        // over all loopbacks, not only the ones shown, so the order in the file doesn't matter
        chipW: loopbacks(d).reduce((m, l) => Math.max(m, chipNeed(l.id, l.addresses)), 0),
        dns: uniqSorted(d.dnsNames.map((n) => n.name).filter((n) => !!n)),
      })),
    ),
    groups: byId(m.groups.map((g) => ({ id: g.id, parent: g.parent || null, label: g.label, kind: g.kind }))),
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
        sub: networkSubtitle(n.cidr, n.vlan),
        // derived from the addresses inside the network's prefixes
        members: uniqSorted(networkMembers(m, n.id).map((x) => x.device)),
      })),
    ),
    relations: byId(
      m.relations.map((r) => {
        const devices = uniqSorted(relationDevices(r));
        return { id: r.id, devices, hubLabel: devices.length >= 3 ? relationStyle(m, r).label + (r.label ? ' · ' + r.label : '') : '' };
      }),
    ),
    pairs: Array.from(relationPairs(m.relations).entries()).map(([key, rels]) => {
      const bundle = buildBundle(m, key, rels);
      return { a: bundle.a, b: bundle.b, labels: bundle.lanes.filter((p) => p.root).map(laneLabel), width: bundle.width };
    }),
    linkLabels: byId(m.links.map((l) => ({ id: l.id, text: linkLabelText(m, l) })).filter((x) => x.text !== '')),
  };
}

/** Width a loopback's chip needs whichever of its addresses is written first (the chip shows the first one). */
function chipNeed(id: string, addresses: string[]): number {
  const firsts = addresses.length ? addresses : [''];
  return firsts.reduce((m, a) => Math.max(m, Math.ceil(chipTextWidth(loopbackChipText(id, a ? [a].concat(addresses.slice(1)) : [])))), 0);
}

/**
 * The networks a cable carries, for its label: the names of the networks
 * both ends carry, or a note when the ends differ (see the link's details).
 * Several networks are just listed: nothing about tagging is implied.
 */
export function linkNetworkLabel(m: Model, l: Link): string {
  if (networkMismatch(l.a.networks, l.b.networks)) return 'networks differ';
  // sorted, so the order of the list in the file affects neither text nor layout
  return l.a.networks.map((id) => networkName(m, id)).sort(compareNames).join(', ');
}

/** The text drawn on a cable: speed, networks, label. */
export function linkLabelText(m: Model, l: Link): string {
  return [l.speed, linkNetworkLabel(m, l), l.label].filter((s) => !!s).join(' · ');
}

/** Stable text form of the input: equal signatures always give equal auto-arrange results. */
export function layoutSignature(i: LayoutInput): string {
  return JSON.stringify(i);
}

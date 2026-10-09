/**
 * Canonical layout input.
 *
 * Auto-arrange is a pure function of this structure and of nothing else, so
 * two models that differ only in YAML key order, section order, the order of
 * list items (devices, interfaces, links, members, endpoints …), comments,
 * formatting, or fields that do not affect geometry (attrs without an
 * address, protocols, an address replaced by one just as long that is in the
 * same networks …) get exactly the same positions. Addresses and identifiers
 * are drawn in full (model/addresses.ts), so the input holds the sizes they
 * need, never the text itself.
 *
 * Everything is sorted by id with plain code-unit string comparison (never
 * localeCompare, which depends on the browser locale).
 */
import { deviceSubtitle } from '../model/device-types';
import { relationStyle } from '../model/protocols';
import { networkMembers, networkMismatch, networkName } from '../model/derive';
import { compareNames, sortedByName } from '../model/order';
import { Device, Link, Model, ifaceKey, loopbacks, relationDevices } from '../model/types';
import { addressAttrEntries, addressAttrLines, deviceAddressLines, deviceEntries, orderedAddresses } from '../model/addresses';
import { buildBundle, laneLabel, relationPairs } from './bundles';
import { cmp } from './order';
import { EntryText, entriesSize, memberLabelBox, networkSubtitle } from './sizes';

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
  /** size [w, h] of the device's address entries in the physical view ([0, 0]: none) */
  physList: [number, number];
  /** size [w, h] of the device's address entries in the logical view ([0, 0]: none) */
  logList: [number, number];
  /** the device's DNS names, each once, sorted (shown under it in the logical view) */
  dns: string[];
  /** physical interfaces without a cable, in display order (chips in the physical view's device box) */
  spare: string[];
  /** virtual and tunnel interfaces, in display order (chips under the device in the logical view) */
  logical: string[];
}
export interface LGroup {
  id: string;
  parent: string | null;
  label: string;
  kind: string;
  /** address lines under the title */
  extra: string[];
}
export interface LNet {
  id: string;
  label: string;
  sub: string;
  /** address lines under the prefix */
  extra: string[];
  members: string[];
  /** size [w, h] of the addresses written on each membership line, by member device (sorted) */
  memberLabels: Array<[string, number, number]>;
}
export interface LRel {
  id: string;
  devices: string[];
  /** label of a multipoint relation's hub ('' for two-device relations, which are labelled per pair) */
  hubLabel: string;
  /** address lines of the hub's label */
  hubExtra: string[];
}
/** The relations between one pair of devices: what has to fit between the two. */
export interface LPair {
  a: string;
  b: string;
  /** label texts, one per lane that carries a label */
  labels: string[];
  /** the address lines of each of those labels */
  extras: string[][];
  /** width of the bundle of lanes */
  width: number;
}
/** Text drawn on a cable. */
export interface LLinkLabel {
  id: string;
  text: string;
  /** cable id and address lines, kept whole */
  extra: string[];
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
        physList: entriesSize(entryTexts(m, d, 'physical')),
        logList: entriesSize(entryTexts(m, d, 'logical')),
        dns: uniqSorted(d.dnsNames.map((n) => n.name).filter((n) => !!n)),
        spare: sortedByName(d.interfaces.filter((i) => !m.index.ifaceLink.has(ifaceKey(d.id, i.id))).map((i) => i.id), (x) => x),
        logical: sortedByName(d.logical.filter((i) => i.type !== 'loopback').map((i) => i.id), (x) => x),
      })),
    ),
    groups: byId(m.groups.map((g) => ({ id: g.id, parent: g.parent || null, label: g.label, kind: g.kind, extra: addressAttrLines(g.attrs) }))),
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
        extra: addressAttrLines(n.attrs),
        // derived from the addresses inside the network's prefixes
        members: uniqSorted(networkMembers(m, n.id).map((x) => x.device)),
        memberLabels: memberLabelSizes(m, n.id),
      })),
    ),
    relations: byId(
      m.relations.map((r) => {
        const devices = uniqSorted(relationDevices(r));
        const hub = devices.length >= 3;
        return { id: r.id, devices, hubLabel: hub ? relationStyle(m, r).label + (r.label ? ' · ' + r.label : '') : '', hubExtra: hub ? addressAttrLines(r.attrs) : [] };
      }),
    ),
    pairs: Array.from(relationPairs(m.relations).entries()).map(([key, rels]) => {
      const bundle = buildBundle(m, key, rels);
      const roots = bundle.lanes.filter((p) => p.root);
      return { a: bundle.a, b: bundle.b, labels: roots.map(laneLabel), extras: roots.map((p) => p.extra), width: bundle.width };
    }),
    linkLabels: byId(m.links.map((l) => ({ id: l.id, text: linkLabelText(m, l), extra: linkLabelExtra(l) })).filter((x) => x.text !== '' || x.extra.length > 0)),
  };
}

/**
 * The entries a device's box holds in a view: its own address lines (an
 * entry without a name), then one entry per interface (model/addresses.ts).
 */
export function entryTexts(m: Model, d: Device, view: 'physical' | 'logical'): EntryText[] {
  const own = deviceAddressLines(d);
  const out: EntryText[] = own.length ? [{ header: '', lines: own }] : [];
  for (const e of deviceEntries(m, d, view)) out.push({ header: e.header, lines: e.lines });
  return out;
}

/**
 * The addresses written on the membership line of a device and a network:
 * every address of the device that lies in the network, in display order.
 */
export function memberAddresses(m: Model, networkId: string, device: string): string[] {
  const mem = networkMembers(m, networkId).find((x) => x.device === device);
  if (!mem) return [];
  const all = mem.matches.map((x) => x.address);
  return orderedAddresses(Array.from(new Set(all)));
}

function memberLabelSizes(m: Model, networkId: string): Array<[string, number, number]> {
  return uniqSorted(networkMembers(m, networkId).map((x) => x.device)).map((d) => {
    const b = memberLabelBox(memberAddresses(m, networkId, d));
    return [d, b.w, b.h] as [string, number, number];
  });
}

/** Lines under a cable's label, kept whole: its cable id and its address-like attrs. */
export function linkLabelExtra(l: Link): string[] {
  return linkLabelExtraFields(l).map((x) => x.line);
}

/** linkLabelExtra with the field each line is written from. */
export function linkLabelExtraFields(l: Link): Array<{ line: string; field: string; value: string }> {
  return (l.cable ? [{ line: 'cable ' + l.cable, field: 'cable', value: '' }] : []).concat(addressAttrEntries(l.attrs).map((a) => ({ line: a.line, field: 'attr', value: a.key })));
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

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
import { bindingKey, bindingOn, buildBundle, laneLabel, portSpans, relationPairs } from './bundles';
import { cmp } from './order';
import { END_LABEL_GAP, EntryText, PORT_STUB, endLabelBox, entriesSize, memberLabelBox, networkSubtitle, portRowH } from './sizes';

export interface LEnd {
  device: string;
  iface?: string;
  /** the aggregate (LAG) the port is a member of: its ports are kept together along the side */
  lag?: string;
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
  /** least height of the name part of the device's logical box: room for its device-level port (0: none) */
  bodyMin: number;
  /** how far the stubs and end labels of its ports reach out from the sides of its logical box (0: no ports) */
  reach: number;
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
  /** widest end label at the device end of a spoke (0: none) */
  endW: number;
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
  /** widest end label at the ports of `a` and of `b` (0: none) */
  ends: [number, number];
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
        bodyMin: portRowH(modelPortSpans(m).get(bindingKey(d.id, undefined)) || 0),
        reach: portReach(m, d.id),
        spare: sortedByName(d.interfaces.filter((i) => !m.index.ifaceLink.has(ifaceKey(d.id, i.id))).map((i) => i.id), (x) => x),
        logical: sortedByName(d.logical.filter((i) => i.type !== 'loopback').map((i) => i.id), (x) => x),
      })),
    ),
    groups: byId(m.groups.map((g) => ({ id: g.id, parent: g.parent || null, label: g.label, kind: g.kind, extra: addressAttrLines(g.attrs) }))),
    links: byId(
      m.links.map((l) => {
        // endpoints in canonical order so "a/b" swapped is the same cable
        const ea = portEnd(m, l.a);
        const eb = portEnd(m, l.b);
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
        const endW = hub ? devices.reduce((w, d) => Math.max(w, endLabelWidth(m, d, bindingOn(r, d))), 0) : 0;
        return { id: r.id, devices, hubLabel: hub ? relationStyle(m, r).label + (r.label ? ' · ' + r.label : '') : '', hubExtra: hub ? addressAttrLines(r.attrs) : [], endW };
      }),
    ),
    pairs: Array.from(relationPairs(m.relations).entries()).map(([key, rels]) => {
      const bundle = buildBundle(m, key, rels);
      const roots = bundle.lanes.filter((p) => p.root);
      const ends: [number, number] = [0, 0];
      for (const st of bundle.strands) {
        ends[0] = Math.max(ends[0], endLabelWidth(m, bundle.a, st.ia));
        ends[1] = Math.max(ends[1], endLabelWidth(m, bundle.b, st.ib));
      }
      return { a: bundle.a, b: bundle.b, labels: roots.map(laneLabel), extras: roots.map((p) => p.extra), width: bundle.width, ends };
    }),
    linkLabels: byId(m.links.map((l) => ({ id: l.id, text: linkLabelText(m, l), extra: linkLabelExtra(l) })).filter((x) => x.text !== '' || x.extra.length > 0)),
  };
}

/**
 * The aggregate (a virtual interface with member ports: a LAG or
 * port-channel) a port of a device is a member of; the smallest id when
 * several list it.
 */
export function aggregateOf(m: Model, device: string, iface: string | undefined): string | undefined {
  if (iface === undefined) return undefined;
  const d = m.index.devices.get(device);
  if (!d) return undefined;
  const ids = d.logical.filter((i) => i.members.indexOf(iface) >= 0).map((i) => i.id);
  return ids.length ? ids.sort(cmp)[0] : undefined;
}

/** A link end as the port layout sees it: device, interface and the aggregate the interface belongs to. */
export function portEnd(m: Model, e: { device: string; iface?: string }): LEnd {
  const out: LEnd = e.iface ? { device: e.device, iface: e.iface } : { device: e.device };
  const lag = aggregateOf(m, e.device, e.iface);
  if (lag !== undefined) out.lag = lag;
  return out;
}

/** The links of a model as the port layout takes them, ends as in the model (a, b). */
export function portLinks(m: Model): LLink[] {
  return m.links.map((l) => ({ id: l.id, a: portEnd(m, l.a), b: portEnd(m, l.b) }));
}

/**
 * The entries a device's box holds in a view: its own address lines (an
 * entry without a name), then one entry per interface (model/addresses.ts).
 */
export function entryTexts(m: Model, d: Device, view: 'physical' | 'logical'): EntryText[] {
  const own = deviceAddressLines(d);
  const out: EntryText[] = own.length ? [{ header: '', lines: own }] : [];
  const spans = view === 'logical' ? modelPortSpans(m) : null;
  for (const e of deviceEntries(m, d, view)) {
    // in the logical view the row of an interface with a port is high enough for the lanes leaving it
    const span = spans ? spans.get(bindingKey(d.id, e.id)) || 0 : 0;
    // … and for the port's end label, written beside the row above the lanes
    const minH = span ? portRowH(span) + endLabelH(m, d.id, e.id) : 0;
    out.push(minH ? { header: e.header, lines: e.lines, minH } : { header: e.header, lines: e.lines });
  }
  return out;
}

const spanCache = new WeakMap<Model, Map<string, number>>();

/** portSpans() of a model, computed once per model object (a new model is built after every edit). */
export function modelPortSpans(m: Model): Map<string, number> {
  let s = spanCache.get(m);
  if (!s) spanCache.set(m, (s = portSpans(m)));
  return s;
}

/**
 * The end label at a port in the logical view, line by line: the name of
 * the interface the relations are bound to and, for a tunnel sourced from
 * an underlay interface or address, that source ("src: Gi0/0 203.0.113.1"),
 * so the underlay is named and never mistaken for the binding. A
 * device-level port has no end label (it is beside the device's name).
 */
export function endLabelLines(m: Model, device: string, iface: string | undefined): string[] {
  if (iface === undefined) return [];
  const i = m.index.interfaces.get(ifaceKey(device, iface));
  const out = [iface];
  if (i && i.source) {
    const src = i.source;
    if (src.iface) {
      const under = m.index.interfaces.get(ifaceKey(device, src.iface));
      const addr = under ? orderedAddresses(under.addresses)[0] : undefined;
      out.push('src: ' + src.iface + (addr ? ' ' + addr.replace(/\/\d+$/, '') : ''));
    } else if (src.address) out.push('src: ' + src.address);
    else out.push('src: ' + src.text);
  }
  return out;
}

/**
 * How far the ports of a device reach out from the side of its logical box:
 * a stub, or an end label (the widest of the device), whichever is longer.
 */
export function portReach(m: Model, device: string): number {
  let r = 0;
  const prefix = bindingKey(device, undefined);
  modelPortSpans(m).forEach((_, k) => {
    if (k.indexOf(prefix) !== 0) return;
    const iface = k.slice(prefix.length);
    r = Math.max(r, PORT_STUB + 8, iface ? endLabelWidth(m, device, iface) + 15 : 0);
  });
  return r;
}

/** Height an end label takes beside its row, above the lanes (0: none). */
export function endLabelH(m: Model, device: string, iface: string | undefined): number {
  const lines = endLabelLines(m, device, iface);
  return lines.length ? endLabelBox(lines).h + END_LABEL_GAP : 0;
}

/** Width of the end label at a port (0: none). */
export function endLabelWidth(m: Model, device: string, iface: string | undefined): number {
  const lines = endLabelLines(m, device, iface);
  return lines.length ? endLabelBox(lines).w : 0;
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

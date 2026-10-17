/**
 * The addresses and identifiers the diagrams show, and where.
 *
 * Every address or identifier of the model is written into the diagram
 * itself, next to the object it belongs to, in full (never shortened):
 *
 *   interface   (an entry in its device's box)  id, label, VLAN, VRF, DHCP,
 *               addresses (IPv4 first, then IPv6, each with its prefix
 *               length, in file order within a family), MAC, a tunnel's
 *               source and destination, an aggregate's member ports, and
 *               address-like attrs;
 *   device      address-like attrs (an entry without a name in its box);
 *   network     prefix and VLAN (the network node), address-like attrs;
 *   link        cable id, address-like attrs (the cable label; the link-end
 *               networks are named there already);
 *   relation    address-like attrs (its label; e.g. a VRRP virtual-ip, a BGP
 *               peer address, an SR-TE endpoint);
 *   group       address-like attrs (under its title);
 *   route       its destination prefix and next hop (a line of its device's
 *               route table, in the logical view; see routeEntries).
 *
 * Views: the physical view shows the physical interfaces that have anything
 * to show; the logical view shows every loopback, virtual and tunnel
 * interface, the physical interfaces with layer-3 facts (address, DHCP,
 * VRF, VLAN) and those a relation is bound to (its line attaches to the
 * interface's entry). An interface drawn in both views shows the same entry
 * in both.
 *
 * "Address-like" attrs are those whose value contains an IPv4 or IPv6
 * address or prefix, or a MAC address. Free-form attrs are display-only, so
 * this is a display rule; nothing about the model changes.
 */
import { ServiceRegistry, usesRouterId } from './services';
import { interfaceAddresses, interfaceVlanText, interfaceVlans } from './derive';
import { parseAddress, parsePrefix } from './ip';
import { compareNames, sortedByName } from './order';
import { Attrs, Device, Interface, Model, Route, routeKey } from './types';

const MAC = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;

/** Is this one token an IPv4/IPv6 address or prefix, or a MAC address? */
export function isAddressToken(t: string): boolean {
  const s = t.trim().replace(/^[\[(]|[\]),;]$/g, '');
  if (!s) return false;
  return !!parseAddress(s) || !!parsePrefix(s) || MAC.test(s);
}

/** Does a free-form value contain an address (IPv4/IPv6 address or prefix, MAC)? */
export function hasAddress(v: string): boolean {
  return v.split(/[\s,;]+/).some(isAddressToken);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The address-like attrs as "key value" lines, sorted by key (the order in the file changes nothing). */
export function addressAttrLines(attrs: Attrs): string[] {
  return addressAttrEntries(attrs).map((x) => x.line);
}

/** The address-like attrs with their keys, in the order of addressAttrLines. */
export function addressAttrEntries(attrs: Attrs): Array<{ key: string; line: string }> {
  return attrs
    .filter(([, v]) => hasAddress(v))
    .map(([k, v]) => ({ key: k, line: k + ' ' + v.replace(/\s+/g, ' ').trim() }))
    .sort((p, q) => cmp(p.key, q.key) || cmp(p.line, q.line));
}

/**
 * What a line of the diagram shows of its object's configuration: the key
 * it is written from ("ip", "vrf", "vlan", "dhcp", "mac", "source",
 * "destination", "members", "cidr", "cable", or "attr" with the attribute's
 * key as value; "" for a derived line). The Edit tab highlights that field
 * when the line is clicked.
 */
export interface LineField {
  field: string;
  value: string;
}

/**
 * Addresses in display order: IPv4, then IPv6, each in numeric order (then
 * by prefix length), then anything that is not an address, as written. The
 * order in the file changes nothing, so dual-stack addresses always read the
 * same way.
 */
export function orderedAddresses(addrs: string[]): string[] {
  const key = (a: string): { f: number; k: string } => {
    const p = parsePrefix(a, false);
    if (!p) return { f: 2, k: a };
    const hex = (b: number): string => (b < 16 ? '0' : '') + b.toString(16);
    return { f: p.version === 4 ? 0 : 1, k: p.bytes.map(hex).join('') + '/' + hex(p.prefix) };
  };
  return addrs
    .map((a) => ({ a, ...key(a) }))
    .sort((p, q) => p.f - q.f || cmp(p.k, q.k) || cmp(p.a, q.a))
    .map((x) => x.a);
}

/** Longest line a list such as an aggregate's members is written on (the list continues on the next line). */
const LIST_LINE = 44;

function listLines(head: string, items: string[]): string[] {
  const out: string[] = [];
  let cur = head;
  for (const it of items) {
    const sep = cur === head ? ' ' : ', ';
    if (cur !== head && (cur + sep + it).length > LIST_LINE) {
      out.push(cur + ',');
      cur = '  ' + it;
    } else cur += sep + it;
  }
  out.push(cur);
  return out;
}

/**
 * The line a DHCP client's address takes in the diagram: reserved as wide
 * as the longest lease ("255.255.255.255/32 (DHCP lease)"), so that the
 * lease a simulation writes there never moves or overlaps anything.
 */
export const LEASE_PLACEHOLDER = 'lease: assigned in a simulation';

/** A lease as the diagram writes it ("10.1.1.50/24 (DHCP lease)"; a link-local fallback says so). */
export function leaseText(addr: string, kind: 'dhcp' | 'link-local'): string {
  return kind === 'link-local' ? `${addr} (link-local)` : `${addr} (DHCP lease)`;
}

/** One interface's entry: its name line, and the facts under it. */
export interface IfaceEntry {
  /** "iface:<device>:<id>" */
  ref: string;
  device: string;
  id: string;
  kind: Interface['type'];
  /** the name line: id, and the label when it says something else */
  header: string;
  lines: string[];
  /** the field each line is written from (same order as `lines`) */
  fields: LineField[];
}

/** The layer-3 facts of an interface (what puts a physical interface into the logical view), with their fields. */
function l3Lines(model: Model, i: Interface): Array<[string, LineField]> {
  const tags: string[] = [];
  const vlan = i.type === 'virtual' ? interfaceVlans(model, i).map((v) => 'VLAN ' + v).join(', ') : interfaceVlanText(interfaceAddresses(model, i.device, i.id));
  if (vlan) tags.push(vlan);
  if (i.vrf) tags.push('VRF ' + i.vrf);
  if (i.dhcp) tags.push('DHCP client');
  // the tags line stands for the first of them that is written on the interface (a derived VLAN is not)
  const tagField = i.vlan !== undefined && i.type === 'virtual' ? 'vlan' : i.vrf ? 'vrf' : i.dhcp ? 'dhcp' : '';
  const out: Array<[string, LineField]> = tags.length ? [[tags.join(' · '), { field: tagField, value: '' }]] : [];
  // a DHCP client's address is leased at runtime: its line is reserved here (a simulation writes the lease into it)
  const lease: Array<[string, LineField]> = i.dhcp ? [[LEASE_PLACEHOLDER, { field: 'lease', value: '' }]] : [];
  const relay: Array<[string, LineField]> = i.dhcpRelay && i.dhcpRelay.length ? [[`DHCP relay → ${i.dhcpRelay.join(', ')}`, { field: 'dhcp_relay', value: '' }]] : [];
  return out.concat(
    lease,
    orderedAddresses(i.addresses).map((a): [string, LineField] => [a, { field: 'ip', value: a }]),
    gatewayLines(model, i),
    relay,
  );
}

/** The virtual gateway addresses of an interface's redundancy groups ("VRRP 10 10.10.10.1"), with their fields. */
export function gatewayLines(model: Model, i: Interface): Array<[string, LineField]> {
  const out: Array<[string, LineField]> = [];
  for (const s of i.services) {
    const def = model.services.get(s.id);
    if (!def) continue;
    const g = s.values.get('group');
    for (const key of ['virtual_ip', 'virtual_ipv6']) {
      const v = s.values.get(key);
      if (v !== undefined) out.push([`${def.label}${g !== undefined ? ' ' + g : ''} ${v}`, { field: `protocols.${s.id}.${key}`, value: '' }]);
    }
  }
  return out;
}

export function interfaceEntry(model: Model, i: Interface): IfaceEntry {
  const rows = l3Lines(model, i);
  const add = (line: string, field: string, value = ''): void => {
    rows.push([line, { field, value }]);
  };
  if (i.type === 'loopback' && !i.addresses.length) add('(no address)', 'ip');
  if (i.mac) add('MAC ' + i.mac, 'mac');
  if (i.source) add('src ' + i.source.text, 'source');
  if (i.destination) add('dst ' + i.destination.text, 'destination');
  if (i.members.length) for (const l of listLines('members', sortedByName(i.members, (x) => x))) add(l, 'members');
  for (const a of addressAttrEntries(i.attrs)) add(a.line, 'attr', a.key);
  const label = i.label && i.label !== i.id ? i.id + ' · ' + i.label : i.id;
  return { ref: `iface:${i.device}:${i.id}`, device: i.device, id: i.id, kind: i.type, header: label, lines: rows.map((r) => r[0]), fields: rows.map((r) => r[1]) };
}

/** Interfaces in display order: by name, numbers by value (lo2 before lo10; model/order.ts). */
function byId(a: Interface, b: Interface): number {
  return compareNames(a.id, b.id);
}

/**
 * The interface entries of a device in a view, in a fixed order (that of
 * the names, so the file's order changes nothing): in the logical view
 * loopbacks, then virtual and tunnel interfaces, then physical ones.
 */
export function deviceEntries(model: Model, d: Device, view: 'physical' | 'logical'): IfaceEntry[] {
  if (view === 'physical') {
    return d.interfaces
      .slice()
      .sort(byId)
      .map((i) => interfaceEntry(model, i))
      .filter((e) => e.lines.length > 0 || e.header !== e.id);
  }
  const rank = (i: Interface): number => (i.type === 'loopback' ? 0 : i.type === 'physical' ? 2 : 1);
  const logical = d.logical.slice().sort((a, b) => rank(a) - rank(b) || byId(a, b));
  const bound = boundInterfaces(model, d.id);
  const phys = d.interfaces.filter((i) => l3Lines(model, i).length > 0 || bound.has(i.id)).sort(byId);
  return logical.concat(phys).map((i) => interfaceEntry(model, i));
}

/** Ids of a device's interfaces that a relation endpoint references (the relation is bound to them). */
export function boundInterfaces(model: Model, device: string): Set<string> {
  const out = new Set<string>();
  for (const r of model.relations) for (const e of r.endpoints) if (e.device === device && e.iface !== undefined) out.add(e.iface);
  return out;
}

// ----------------------------------------------------------------- routes

/**
 * A route as the diagram and the lists write it, in the order of the
 * familiar "ip route" output: "0.0.0.0/0 via 203.0.113.1 dev wan2 AD 250
 * metric 10", "192.0.2.0/24 blackhole". Only what is written is shown (no
 * default distance is added).
 */
export function routeLine(r: Route): string {
  const parts = [r.prefix];
  if (r.blackhole) parts.push('blackhole');
  if (r.via !== undefined) parts.push('via ' + r.via);
  if (r.iface !== undefined) parts.push('dev ' + r.iface);
  if (r.distance !== undefined) parts.push('AD ' + r.distance);
  if (r.metric !== undefined) parts.push('metric ' + r.metric);
  return parts.join(' ');
}

/** Sort key of an address or prefix text: family, then the bytes as hex, then the length (text that isn't one: last). */
function addrSortKey(t: string | undefined): string {
  if (t === undefined) return '';
  const p = parsePrefix(t, false);
  if (!p) return '9' + t;
  const hex = (b: number): string => (b < 16 ? '0' : '') + b.toString(16);
  // IPv4 before IPv6; the network part compared at full width
  return (p.version === 4 ? '4' : '6') + p.bytes.map(hex).join('') + '/' + hex(p.prefix);
}

/**
 * Display order of routes: VRF, destination (family, address, prefix
 * length), distance (a missing one counts as 1), metric, next hop, exit
 * interface; never the order of the file.
 */
export function compareRoutes(a: Route, b: Route): number {
  const d = (r: Route): number => (r.distance !== undefined ? r.distance : 1);
  const m = (r: Route): number => (r.metric !== undefined ? r.metric : 0);
  return (
    cmp(a.vrf || '', b.vrf || '') ||
    cmp(addrSortKey(a.prefix), addrSortKey(b.prefix)) ||
    d(a) - d(b) ||
    m(a) - m(b) ||
    Number(a.blackhole) - Number(b.blackhole) ||
    cmp(addrSortKey(a.via), addrSortKey(b.via)) ||
    cmp(a.iface || '', b.iface || '') ||
    cmp(routeLine(a), routeLine(b)) ||
    cmp(a.name || '', b.name || '') ||
    a.index - b.index
  );
}

/** The route table of one VRF of a device, as its box in the logical view shows it. */
export interface RouteTable {
  /** '' for the default table */
  vrf: string;
  /** "Routes" or "Routes · VRF x" */
  header: string;
  routes: Route[];
  lines: string[];
  /** "route:<device>:<index>" of each line */
  refs: string[];
}

/** The route tables of a device: one per VRF that has routes (the default table first), each sorted (compareRoutes). */
export function routeTables(d: Device): RouteTable[] {
  const byVrf = new Map<string, Route[]>();
  for (const r of d.routes.slice().sort(compareRoutes)) {
    const v = r.vrf || '';
    if (!byVrf.has(v)) byVrf.set(v, []);
    (byVrf.get(v) as Route[]).push(r);
  }
  return Array.from(byVrf.keys())
    .sort(cmp)
    .map((vrf) => {
      const routes = byVrf.get(vrf) as Route[];
      return { vrf, header: vrf ? 'Routes · VRF ' + vrf : 'Routes', routes, lines: routes.map(routeLine), refs: routes.map((r) => 'route:' + routeKey(r.device, r.index)) };
    });
}

/**
 * The routing identity a device's box shows, only where it applies: the
 * router ID its protocols share (when one of its enabled protocols uses a
 * router ID), a protocol's own router ID, and the AS number or NET of the
 * protocols that have one. Each with the field it is written in
 * ("protocols.bgp.asn").
 */
export function identityLines(d: Device, services: ServiceRegistry): Array<{ line: string; field: LineField }> {
  const out: Array<{ line: string; field: LineField }> = [];
  const uses = d.services.filter((s) => {
    const def = services.get(s.id);
    return !!def && usesRouterId(def);
  });
  const shared = uses.some((s) => !s.routerId);
  if (d.routerId && shared) out.push({ line: 'router-id ' + (d.routerId.address || d.routerId.text), field: { field: 'router_id', value: '' } });
  for (const s of d.services) {
    const def = services.get(s.id);
    if (!def) continue;
    if (s.routerId && usesRouterId(def)) out.push({ line: `${def.label} router-id ${s.routerId.address || s.routerId.text}`, field: { field: `protocols.${s.id}.router_id`, value: '' } });
    const asn = s.values.get('asn');
    if (asn !== undefined) out.push({ line: s.id === 'bgp' ? 'AS ' + asn : `${def.label} AS ${asn}`, field: { field: `protocols.${s.id}.asn`, value: '' } });
    const net = s.values.get('net');
    if (net !== undefined) out.push({ line: `${def.label} ${net}`, field: { field: `protocols.${s.id}.net`, value: '' } });
  }
  return out;
}

/**
 * The device's own lines in its box (both views), with the field each is
 * written from: its routing identity (identityLines), then its address-like
 * attrs.
 */
export function deviceOwnLines(d: Device, services: ServiceRegistry): Array<{ line: string; field: LineField }> {
  const out = identityLines(d, services);
  for (const a of addressAttrEntries(d.attrs)) out.push({ line: a.line, field: { field: 'attr', value: a.key } });
  return out;
}

/** Lines of a device's own entry (drawn in its box, in both views). */
export function deviceAddressLines(d: Device, services: ServiceRegistry): string[] {
  return deviceOwnLines(d, services).map((x) => x.line);
}

/**
 * Every address and identifier of a model, with where it is drawn: the
 * inventory the self-test compares with the text of the rendered diagrams.
 */
export interface AddressField {
  /** "device:x", "iface:x:y", "network:n", "link:l", "relation:r", "group:g" */
  owner: string;
  /** what it is, e.g. "ip", "mac", "cidr", "attrs.virtual-ip" */
  field: string;
  /** the text that must appear in full */
  text: string;
  views: Array<'physical' | 'logical'>;
}

export function addressInventory(model: Model): AddressField[] {
  const out: AddressField[] = [];
  const add = (owner: string, field: string, text: string, views: Array<'physical' | 'logical'>): void => {
    if (text) out.push({ owner, field, text, views });
  };
  const attrs = (owner: string, a: Attrs, views: Array<'physical' | 'logical'>): void => {
    for (const [k, v] of a) if (hasAddress(v)) add(owner, 'attrs.' + k, v.replace(/\s+/g, ' ').trim(), views);
  };
  for (const g of model.groups) attrs('group:' + g.id, g.attrs, ['physical', 'logical']);
  for (const d of model.devices) {
    attrs('device:' + d.id, d.attrs, ['physical', 'logical']);
    for (const x of identityLines(d, model.services)) add('device:' + d.id, x.field.field, x.line, ['physical', 'logical']);
    const bound = boundInterfaces(model, d.id);
    for (const i of d.interfaces.concat(d.logical)) {
      const owner = `iface:${d.id}:${i.id}`;
      const physical = i.type === 'physical';
      const inLogical = !physical || l3Lines(model, i).length > 0 || bound.has(i.id);
      const views: Array<'physical' | 'logical'> = physical ? (inLogical ? ['physical', 'logical'] : ['physical']) : ['logical'];
      add(owner, 'id', i.id, views);
      for (const a of i.addresses) add(owner, 'ip', a, views);
      if (i.mac) add(owner, 'mac', i.mac, views);
      for (const [line, f] of gatewayLines(model, i)) add(owner, f.field, line, views);
      if (i.vrf) add(owner, 'vrf', i.vrf, views);
      if (i.vlan !== undefined) add(owner, 'vlan', 'VLAN ' + i.vlan, views);
      if (i.source) add(owner, 'source', i.source.text, views);
      if (i.destination) add(owner, 'destination', i.destination.text, views);
      for (const m of i.members) add(owner, 'members', m, views);
      attrs(owner, i.attrs, views);
    }
    for (const n of d.dnsNames) add('device:' + d.id, 'dns_names', n.name, ['logical']);
    for (const r of d.routes) {
      const owner = 'route:' + routeKey(d.id, r.index);
      add(owner, 'prefix', r.prefix, ['logical']);
      if (r.via !== undefined) add(owner, 'via', r.via, ['logical']);
    }
  }
  for (const n of model.networks) {
    if (n.cidr) add('network:' + n.id, 'cidr', n.cidr, ['logical']);
    if (n.vlan !== undefined) add('network:' + n.id, 'vlan', 'VLAN ' + n.vlan, ['logical']);
    attrs('network:' + n.id, n.attrs, ['logical']);
  }
  for (const l of model.links) {
    if (l.cable) add('link:' + l.id, 'cable', l.cable, ['physical']);
    attrs('link:' + l.id, l.attrs, ['physical']);
  }
  // a relation is drawn between two or more devices (a nested one is named in its carrier's label)
  for (const r of model.relations) if (new Set(r.endpoints.map((e) => e.device)).size >= 2) attrs('relation:' + r.id, r.attrs, ['logical']);
  return out;
}

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
 *   group       address-like attrs (under its title).
 *
 * Views: the physical view shows the physical interfaces that have anything
 * to show; the logical view shows every loopback, virtual and tunnel
 * interface and the physical interfaces with layer-3 facts (address, DHCP,
 * VRF, VLAN). An interface drawn in both views shows the same entry in both.
 *
 * "Address-like" attrs are those whose value contains an IPv4 or IPv6
 * address or prefix, or a MAC address. Free-form attrs are display-only, so
 * this is a display rule; nothing about the model changes.
 */
import { interfaceAddresses, interfaceVlanText, interfaceVlans } from './derive';
import { parseAddress, parsePrefix } from './ip';
import { compareNames, sortedByName } from './order';
import { Attrs, Device, Interface, Model } from './types';

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
  if (i.dhcp) tags.push('DHCP');
  // the tags line stands for the first of them that is written on the interface (a derived VLAN is not)
  const tagField = i.vlan !== undefined && i.type === 'virtual' ? 'vlan' : i.vrf ? 'vrf' : i.dhcp ? 'dhcp' : '';
  const out: Array<[string, LineField]> = tags.length ? [[tags.join(' · '), { field: tagField, value: '' }]] : [];
  return out.concat(orderedAddresses(i.addresses).map((a): [string, LineField] => [a, { field: 'ip', value: a }]));
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
  const phys = d.interfaces.filter((i) => l3Lines(model, i).length > 0).sort(byId);
  return logical.concat(phys).map((i) => interfaceEntry(model, i));
}

/** Lines of a device's own address-like attrs (drawn in its box, in both views). */
export function deviceAddressLines(d: Device): string[] {
  return addressAttrLines(d.attrs);
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
    for (const i of d.interfaces.concat(d.logical)) {
      const owner = `iface:${d.id}:${i.id}`;
      const physical = i.type === 'physical';
      const inLogical = !physical || l3Lines(model, i).length > 0;
      const views: Array<'physical' | 'logical'> = physical ? (inLogical ? ['physical', 'logical'] : ['physical']) : ['logical'];
      add(owner, 'id', i.id, views);
      for (const a of i.addresses) add(owner, 'ip', a, views);
      if (i.mac) add(owner, 'mac', i.mac, views);
      if (i.vrf) add(owner, 'vrf', i.vrf, views);
      if (i.vlan !== undefined) add(owner, 'vlan', 'VLAN ' + i.vlan, views);
      if (i.source) add(owner, 'source', i.source.text, views);
      if (i.destination) add(owner, 'destination', i.destination.text, views);
      for (const m of i.members) add(owner, 'members', m, views);
      attrs(owner, i.attrs, views);
    }
    for (const n of d.dnsNames) add('device:' + d.id, 'dns_names', n.name, ['logical']);
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

/**
 * Addressing (Analyze → Addressing, I): the networks of each VRF as a compact
 * table (nested by prefix) with use and allocation, then the issues —
 * confirmed and possible conflicts, legitimate reuse, overlaps, addresses
 * outside the declared networks — filtered by text and by issue; a network's
 * or an issue's details in the evidence panel. "Unallocated in model" is
 * never "free in the real network".
 */
import { AddressingOverview, NetEntry, VrfGroup, countText } from '../analysis/addressing';
import { rangeText } from '../analysis/ipmath';
import { ADDR_METHOD_TEXT } from '../analysis/snapshot';
import { ipv6MethodLabel } from '../model/ipv6';
import { el } from './dom';

export type AddrSort = 'prefix' | 'vlan' | 'name' | 'used' | 'util';

/** The issue filter: every network, or only what an issue concerns. */
export type AddrIssue = 'all' | 'conflicts' | 'overlaps' | 'outside';

export const ADDR_ISSUES: ReadonlyArray<{ id: AddrIssue; label: string; help: string }> = [
  { id: 'all', label: 'All networks', help: 'Every network, then every issue' },
  { id: 'conflicts', label: 'Conflicts', help: 'Addresses used more than once in one scope (confirmed and possible), and the reuse the model separates' },
  { id: 'overlaps', label: 'Overlaps', help: 'Networks with the same prefix in a VRF, and interface subnets larger than the network holding their address' },
  { id: 'outside', label: 'Outside declared networks', help: 'Addresses in no network of the model' },
];

/** What Addressing remembers between openings (a view setting, never saved). */
export interface AddrViewState {
  filter: string;
  sort: AddrSort;
  desc: boolean;
  /** networks whose members are shown in place, as "<vrf>|<id>" */
  open: Set<string>;
  issue: AddrIssue;
}

export function newAddrViewState(): AddrViewState {
  return { filter: '', sort: 'prefix', desc: false, open: new Set(), issue: 'all' };
}

/** The networks an issue filter keeps (null: every one). */
function issueNets(ov: AddressingOverview, st: AddrViewState): Set<string> | null {
  if (st.issue === 'all') return null;
  const keepNets = new Set<string>();
  if (st.issue === 'conflicts') {
    const addrs = new Set(ov.duplicates.map((d) => d.vrf + '|' + d.text).concat(ov.reused.map((d) => d.vrf + '|' + d.text)));
    for (const g of ov.vrfs) for (const n of g.networks) if (n.members.some((m) => addrs.has(g.vrf + '|' + m.address.split('/')[0]))) keepNets.add(g.vrf + '|' + n.id);
  } else if (st.issue === 'overlaps') {
    for (const o of ov.overlaps) for (const r of o.refs) if (r.indexOf('network:') === 0) keepNets.add(o.vrf + '|' + r.slice(8));
  }
  return keepNets;
}

const SORTS: Array<{ key: AddrSort; label: string }> = [
  { key: 'prefix', label: 'Prefix' },
  { key: 'vlan', label: 'VLAN' },
  { key: 'name', label: 'Name' },
  { key: 'used', label: 'Hosts' },
  { key: 'util', label: 'Allocated' },
];

/** How many unallocated ranges a row lists before the rest go behind "more". */
const FREE_SHOWN = 3;

const groupTitle = (g: { vrf: string }): string => (g.vrf === '' ? 'Default table' : 'VRF ' + g.vrf);

/** Host use as text: a percentage for IPv4; for IPv6 the number of /64s. */
export function utilText(n: NetEntry): string {
  if (n.percent !== null) return n.percent.toFixed(1).replace(/\.0$/, '') + ' %';
  const nets = n.nets64 as bigint;
  return nets > BigInt(0) ? `${countText(nets)} × /64` : `/${n.prefix.prefix}`;
}

/** The allocated share as text (IPv4), the parts that make it up. */
export function allocText(n: NetEntry): string {
  const a = n.alloc;
  const parts: string[] = [];
  const add = (v: bigint, label: string): void => {
    if (v > BigInt(0)) parts.push(`${countText(v)} ${label}`);
  };
  add(a.configured, 'configured');
  add(a.reserved, 'reserved');
  add(a.acquired, 'acquired');
  add(a.pool, 'DHCP pool');
  add(a.subnets, 'in subnets');
  return parts.length ? parts.join(' · ') : 'nothing allocated';
}

function usedText(n: NetEntry): string {
  return `${countText(n.used)} / ${countText(n.size)}`;
}

/** Does a network match the filter text (prefix, name, id, VLAN, gateways, members)? */
function matches(n: NetEntry, q: string): boolean {
  if (!q) return true;
  const hay = [n.text, n.label, n.id, n.vlan !== undefined ? 'vlan ' + n.vlan : '', ...n.gateways.map((g) => g.text + ' ' + g.source)]
    .concat(n.members.map((u) => `${u.device} ${u.iface} ${u.text} ${u.address} ${u.dns.join(' ')} ${u.method}`))
    .concat(n.dhcp.map((c) => `${c.device} ${c.iface} dhcp ${c.dns.join(' ')}`))
    .concat(n.auto.map((c) => `${c.device} ${c.iface} ${c.method}`))
    .concat(n.pools.map((p) => `pool ${p.range} ${p.device}`))
    .join('\n')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !!w)
    .every((w) => hay.indexOf(w) >= 0);
}

/** The rows of a VRF in the order and with the filter of the state; `context` rows only lead to matches. */
export function visibleRows(g: VrfGroup, st: AddrViewState): Array<{ n: NetEntry; context: boolean }> {
  const q = st.filter.trim();
  const hit = new Set(g.networks.filter((n) => matches(n, q)).map((n) => n.id));
  const byId = new Map(g.networks.map((n) => [n.id, n] as [string, NetEntry]));
  const tree = st.sort === 'prefix' && !st.desc;
  const keep = new Set(hit);
  if (tree) {
    // a match keeps the networks it is nested in, as context
    hit.forEach((id) => {
      let p = (byId.get(id) as NetEntry).parent;
      while (p) {
        keep.add(p);
        p = (byId.get(p) as NetEntry).parent;
      }
    });
  }
  const order = new Map(g.networks.map((n, i) => [n.id, i] as [string, number]));
  let rows = g.networks.filter((n) => keep.has(n.id));
  if (!tree) {
    const key = (n: NetEntry): number | string => {
      if (st.sort === 'vlan') return n.vlan === undefined ? 1e9 : n.vlan;
      if (st.sort === 'name') return n.label.toLowerCase();
      if (st.sort === 'used') return Number(n.used);
      if (st.sort === 'util') return n.allocatedPercent === null ? -1 : n.allocatedPercent;
      return order.get(n.id) as number;
    };
    rows = rows.slice().sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (st.desc ? -c : c) || (order.get(a.id) as number) - (order.get(b.id) as number);
    });
  }
  return rows.map((n) => ({ n, context: !hit.has(n.id) }));
}

const ref = (doc: Document, target: string, text: string, title?: string): HTMLElement =>
  el(doc, 'button', { type: 'button', class: 'ref', 'data-addr-goto': target, title: title || 'Show in the diagram' }, [text]);

function membersBox(doc: Document, n: NetEntry): HTMLElement {
  const box = el(doc, 'div', { class: 'addr-members' });
  if (n.space.length) box.appendChild(el(doc, 'p', { class: 'muted small' }, [`One address space with ${n.space.map((v) => (v === '' ? 'the default table' : 'VRF ' + v)).join(', ')}: their members are on the same switched segment, and their addresses count here too.`]));
  if (!n.members.length && !n.dhcp.length && !n.auto.length) {
    box.appendChild(el(doc, 'p', { class: 'muted small' }, [n.nestedUsed ? `No address of its own: ${n.nestedUsed} in nested networks.` : 'No member: no interface has an address in this network.']));
  } else {
    const t = el(doc, 'table', { class: 'ports addr-mtable' }, [
      el(doc, 'thead', {}, [el(doc, 'tr', {}, ['Device', 'Interface', 'Address', 'How', 'DNS name'].map((h) => el(doc, 'th', { scope: 'col' }, [h])))]),
    ]);
    const body = el(doc, 'tbody');
    for (const u of n.members) {
      body.appendChild(
        el(doc, 'tr', {}, [
          el(doc, 'td', {}, [ref(doc, 'device:' + u.device, u.device)]),
          el(doc, 'td', {}, [ref(doc, `iface:${u.device}:${u.iface}`, u.iface), u.loopback ? el(doc, 'span', { class: 'muted' }, [' (loopback)']) : null]),
          el(doc, 'td', { class: 'mono' }, [u.address]),
          el(doc, 'td', {}, [u.method === 'static' ? 'Configured' : `${ADDR_METHOD_TEXT[u.method]} (${u.state || 'acquired'}, snapshot)`]),
          el(doc, 'td', {}, [u.dns.join(', ')]),
        ]),
      );
    }
    for (const c of n.dhcp) {
      body.appendChild(
        el(doc, 'tr', {}, [
          el(doc, 'td', {}, [ref(doc, 'device:' + c.device, c.device)]),
          el(doc, 'td', {}, [ref(doc, `iface:${c.device}:${c.iface}`, c.iface)]),
          el(doc, 'td', { class: 'muted' }, ['assigned at runtime (cable ', ref(doc, 'link:' + c.link, c.link), ' carries the network)']),
          el(doc, 'td', {}, ['DHCPv4 (configured)']),
          el(doc, 'td', {}, [c.dns.join(', ')]),
        ]),
      );
    }
    for (const c of n.auto) {
      body.appendChild(
        el(doc, 'tr', {}, [
          el(doc, 'td', {}, [ref(doc, 'device:' + c.device, c.device)]),
          el(doc, 'td', {}, [ref(doc, `iface:${c.device}:${c.iface}`, c.iface)]),
          el(doc, 'td', { class: 'muted' }, ['formed at runtime (cable ', ref(doc, 'link:' + c.link, c.link), ' carries the network)']),
          el(doc, 'td', {}, [ipv6MethodLabel(c.method) + ' (configured)']),
          el(doc, 'td', {}, ['']),
        ]),
      );
    }
    t.appendChild(body);
    box.appendChild(t);
  }
  for (const p of n.pools) {
    const extra = [p.excluded.length ? `excluded (not leased): ${p.excluded.join(', ')}` : '', p.reservations.length ? `reserved: ${p.reservations.map((r) => r.ip).join(', ')}` : '', p.gateway ? `gateway ${p.gateway}` : ''].filter((x) => x);
    box.appendChild(el(doc, 'p', { class: 'small' }, ['DHCP pool ', el(doc, 'span', { class: 'mono' }, [p.range]), ' of ', ref(doc, 'device:' + p.device, p.device), extra.length ? ` (${extra.join('; ')})` : '']));
  }
  if (n.nestedUsed) box.appendChild(el(doc, 'p', { class: 'muted small' }, [`… and ${n.nestedUsed} address${n.nestedUsed === 1 ? '' : 'es'} in nested networks.`]));
  return box;
}

function freeCell(doc: Document, n: NetEntry): HTMLElement {
  const td = el(doc, 'td', { class: 'addr-free mono' });
  if (!n.free.length) {
    td.appendChild(el(doc, 'span', { class: 'muted' }, ['none']));
    return td;
  }
  const line = (k: number): HTMLElement => el(doc, 'div', {}, [rangeText(n.free[k], n.version)]);
  for (let k = 0; k < Math.min(FREE_SHOWN, n.free.length); k++) td.appendChild(line(k));
  if (n.free.length > FREE_SHOWN) {
    const more = el(doc, 'details', {}, [el(doc, 'summary', {}, [`${n.free.length - FREE_SHOWN} more range${n.free.length - FREE_SHOWN === 1 ? '' : 's'}`])]);
    for (let k = FREE_SHOWN; k < n.free.length; k++) more.appendChild(line(k));
    td.appendChild(more);
  }
  return td;
}

/** The allocation of a row: the allocated share with a bar (IPv4), and its parts. */
function allocCell(doc: Document, n: NetEntry): HTMLElement {
  const td = el(doc, 'td', { class: 'addr-util' });
  if (n.allocatedPercent !== null) {
    const a = n.alloc;
    const size = Number(n.size) || 1;
    const w = (v: bigint): string => `width: ${Math.min(100, (Number(v) * 100) / size).toFixed(2)}%`;
    td.appendChild(el(doc, 'span', {}, [n.allocatedPercent.toFixed(1).replace(/\.0$/, '') + ' %']));
    td.appendChild(
      el(doc, 'span', { class: 'addr-bar alloc-bar', 'aria-hidden': 'true' }, [
        el(doc, 'span', { class: 'ab-host', style: w(a.configured + a.reserved + a.acquired) }),
        el(doc, 'span', { class: 'ab-pool', style: w(a.pool) }),
        el(doc, 'span', { class: 'ab-sub', style: w(a.subnets) }),
      ]),
    );
  } else td.appendChild(el(doc, 'span', {}, [utilText(n)]));
  td.appendChild(el(doc, 'div', { class: 'muted small' }, [allocText(n)]));
  return td;
}

function vrfTable(doc: Document, g: VrfGroup, st: AddrViewState, only: Set<string> | null, sel: string): HTMLElement | null {
  const sec = el(doc, 'section', { class: 'addr-vrf', 'data-addr-vrf': g.vrf, 'aria-labelledby': 'addr-vrf-' + (g.vrf || 'default') });
  const rows = visibleRows(g, st).filter((r) => !only || only.has(g.vrf + '|' + r.n.id));
  if (only && !rows.length) return null;
  sec.appendChild(el(doc, 'h3', { id: 'addr-vrf-' + (g.vrf || 'default'), class: 'fgroup-title' }, [`${groupTitle(g)} (${rows.filter((r) => !r.context).length} of ${g.networks.length} network${g.networks.length === 1 ? '' : 's'})`]));
  if (!rows.length) {
    sec.appendChild(el(doc, 'p', { class: 'muted small' }, ['No network matches the filter.']));
    return sec;
  }
  const head = el(doc, 'tr', {});
  for (const s of SORTS) {
    const active = st.sort === s.key;
    const dir = active ? (st.desc ? 'descending' : 'ascending') : 'none';
    head.appendChild(
      el(doc, 'th', { scope: 'col', 'aria-sort': dir }, [
        el(doc, 'button', { type: 'button', class: 'addr-sort', 'data-addr-sort': s.key, title: `Sort by ${s.label.toLowerCase()}${active ? ' (again: reverse)' : ''}` }, [s.label, el(doc, 'span', { class: 'sort-mark', 'aria-hidden': 'true' }, [active ? (st.desc ? ' ▼' : ' ▲') : ''])]),
      ]),
    );
    if (s.key === 'name') head.appendChild(el(doc, 'th', { scope: 'col' }, ['Gateway / VIP']));
  }
  head.appendChild(el(doc, 'th', { scope: 'col', title: 'The lowest address the model leaves unallocated: not configured, reserved, acquired, in a DHCP pool or a nested network' }, ['Next unallocated']));
  head.appendChild(el(doc, 'th', { scope: 'col' }, ['Unallocated in model']));
  const table = el(doc, 'table', { class: 'addr-table' }, [el(doc, 'thead', {}, [head])]);
  const body = el(doc, 'tbody');
  const tree = st.sort === 'prefix' && !st.desc;
  for (const { n, context } of rows) {
    const key = g.vrf + '|' + n.id;
    const open = st.open.has(key);
    const mid = 'addr-m-' + (g.vrf || 'default') + '-' + n.id;
    const count = n.members.length + n.dhcp.length + n.auto.length;
    const parentText = n.parent ? (g.networks.find((x) => x.id === n.parent) as NetEntry).text : '';
    const prefixRef = ref(doc, 'network:' + n.id, n.text);
    prefixRef.classList.add('mono');
    const prefixCell = el(doc, 'td', { class: 'addr-prefix', style: tree ? `padding-left: ${6 + n.depth * 16}px` : '' }, [
      tree && n.depth ? el(doc, 'span', { class: 'addr-nest', 'aria-hidden': 'true' }, ['└ ']) : null,
      prefixRef,
      parentText ? el(doc, 'span', { class: tree ? 'sr-only' : 'addr-in muted' }, [` in ${parentText}`]) : null,
      el(doc, 'div', {}, [
        el(doc, 'button', { type: 'button', class: 'mini addr-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': mid, 'data-addr-toggle': key, title: open ? 'Hide the members' : 'Show the members' }, [
          (open ? '▾ ' : '▸ ') + `${count} member${count === 1 ? '' : 's'}` + (n.nestedUsed ? ` · ${n.nestedUsed} nested` : '') + (n.pools.length ? ` · ${n.pools.length} pool${n.pools.length === 1 ? '' : 's'}` : ''),
        ]),
      ]),
      n.otherVrfs.length ? el(doc, 'div', { class: 'muted small' }, ['also in ' + n.otherVrfs.map((v) => (v === '' ? 'the default table' : 'VRF ' + v)).join(', ')]) : null,
    ]);
    const gws = el(doc, 'td', { class: 'addr-gw' });
    if (!n.gateways.length) gws.appendChild(el(doc, 'span', { class: 'muted' }, ['—']));
    for (const gw of n.gateways) {
      gws.appendChild(el(doc, 'div', {}, [ref(doc, gw.refs[0], gw.text, gw.source), el(doc, 'span', { class: 'muted small' }, [` ${gw.kind === 'vip' ? 'VIP' : 'gateway'}: ${gw.source}`])]));
    }
    const item = `net:${g.vrf}|${n.id}`;
    const on = item === sel;
    body.appendChild(
      el(doc, 'tr', { class: 'addr-row' + (context ? ' addr-context' : '') + (on ? ' an-selected' : ''), 'data-addr-net': n.id, 'data-an-item': item, tabindex: '0', 'aria-label': `${n.text} ${n.label}: its details`, ...(on ? { 'aria-current': 'true' } : {}) }, [
        prefixCell,
        el(doc, 'td', {}, [n.vlan !== undefined ? String(n.vlan) : '']),
        el(doc, 'td', {}, [ref(doc, 'network:' + n.id, n.label), context ? el(doc, 'span', { class: 'muted small' }, [' (holds matches)']) : null]),
        gws,
        el(doc, 'td', { class: 'mono' }, [usedText(n), el(doc, 'div', { class: 'muted small' }, [utilText(n)])]),
        allocCell(doc, n),
        el(doc, 'td', { class: 'mono' }, [n.nextFree || el(doc, 'span', { class: 'muted' }, ['none'])]),
        freeCell(doc, n),
      ]),
    );
    const mrow = el(doc, 'tr', { class: 'addr-mrow', id: mid }, [el(doc, 'td', { colspan: '8' }, [membersBox(doc, n)])]);
    if (!open) mrow.hidden = true;
    body.appendChild(mrow);
  }
  table.appendChild(body);
  sec.appendChild(el(doc, 'div', { class: 'addr-scroll', tabindex: '0', role: 'region', 'aria-label': groupTitle(g) + ' networks' }, [table]));
  return sec;
}

function issuesSection(doc: Document, ov: AddressingOverview, st: AddrViewState, sel: string): HTMLElement {
  const sec = el(doc, 'section', { class: 'addr-issues', 'aria-labelledby': 'addr-issues-title' }, [el(doc, 'h3', { id: 'addr-issues-title', class: 'fgroup-title' }, ['Issues: conflicts, reuse, overlaps and addresses outside the declared networks'])]);
  const vrfTag = (v: string): string => (v === '' ? '' : ` (VRF ${v})`);
  const show = (kind: string): boolean => st.issue === 'all' || (st.issue === 'conflicts' && (kind === 'duplicates' || kind === 'reused')) || (st.issue === 'overlaps' && kind === 'overlaps') || (st.issue === 'outside' && kind === 'orphans');
  const list = (title: string, kind: string, items: HTMLElement[], none: string): void => {
    if (!show(kind)) return;
    sec.appendChild(el(doc, 'h4', {}, [`${title} (${items.length})`]));
    if (!items.length) sec.appendChild(el(doc, 'p', { class: 'muted small', 'data-addr-list': kind }, [none]));
    else sec.appendChild(el(doc, 'ul', { class: 'addr-list', 'data-addr-list': kind }, items));
  };
  // an issue as a row of its list: its evidence on the right
  const li = (key: string, attrs: { [k: string]: string }, kids: Array<Node | string | null>): HTMLElement => {
    const on = key === sel;
    return el(doc, 'li', { ...attrs, 'data-an-item': key, tabindex: '0', class: 'an-pickrow' + (on ? ' an-selected' : '') }, [...kids, ' ', el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': on ? 'true' : 'false', 'aria-controls': 'an-detail' }, ['Evidence'])]);
  };
  const owners = (os: Array<{ device: string; iface: string }>): HTMLElement[] => os.map((o, k) => el(doc, 'span', {}, [k ? ', ' : '', ref(doc, `iface:${o.device}:${o.iface}`, `${o.device}:${o.iface}`)]));
  list(
    'Duplicate addresses',
    'duplicates',
    ov.duplicates.map((d, k) => li('issue:dup:' + k, { 'data-certainty': d.certainty }, [el(doc, 'strong', {}, [d.certainty === 'conflict' ? 'Conflict: ' : 'Possible conflict: ']), el(doc, 'span', { class: 'mono' }, [d.text]), vrfTag(d.vrf), ' on ', ...owners(d.owners), el(doc, 'span', { class: 'muted small' }, [` — ${d.why}`])])),
    'No address is used twice in one scope (a VRF and a connected part of the architecture; a link-local address on its segment).',
  );
  list(
    'Reused where the model separates the uses',
    'reused',
    ov.reused.map((d, k) => li('issue:reuse:' + k, {}, [el(doc, 'span', { class: 'mono' }, [d.text]), vrfTag(d.vrf), ' on ', ...owners(d.owners), el(doc, 'span', { class: 'muted small' }, [` — ${d.why}: legitimate reuse, not a conflict in the model`])])),
    'No address is reused across separate parts.',
  );
  list(
    'Overlapping prefixes',
    'overlaps',
    ov.overlaps.map((o, j) => li('issue:overlap:' + j, {}, [o.message + vrfTag(o.vrf) + ' ', ...o.refs.map((r, k) => el(doc, 'span', {}, [k ? ' · ' : '', ref(doc, r, r.replace(/^[a-z]+:/, ''))]))])),
    'No two networks of a VRF have the same prefix, and no interface subnet is larger than a network holding its address.',
  );
  list(
    'Addresses outside the declared networks',
    'orphans',
    ov.orphans.map((o, k) => li('issue:orphan:' + k, {}, [el(doc, 'span', { class: 'mono' }, [o.address]), vrfTag(o.vrf), ' on ', ref(doc, `iface:${o.device}:${o.iface}`, `${o.device}:${o.iface}`), o.loopback ? el(doc, 'span', { class: 'muted' }, [' (loopback)']) : null])),
    'Every address is in a network (link-local addresses are interface-scoped).',
  );
  return sec;
}

/** The tables (without the controls), for the current state: the networks the issue filter keeps, then the issues it keeps. */
export function addressingTables(doc: Document, ov: AddressingOverview, st: AddrViewState, sel = ''): HTMLElement {
  const box = el(doc, 'div', { class: 'addr-tables' });
  if (!ov.vrfs.length) box.appendChild(el(doc, 'p', { class: 'muted' }, ['The model has no network. Networks are listed here with their members, use and free addresses.']));
  const only = issueNets(ov, st);
  if (st.issue !== 'outside') for (const g of ov.vrfs) {
    const t = vrfTable(doc, g, st, only, sel);
    if (t) box.appendChild(t);
  }
  box.appendChild(issuesSection(doc, ov, st, sel));
  return box;
}

/** A short summary of the issues, for the results' first line. */
export function issueSummary(ov: AddressingOverview): string {
  const conf = ov.duplicates.filter((d) => d.certainty === 'conflict').length;
  const poss = ov.duplicates.length - conf;
  const parts = [`${conf} confirmed conflict${conf === 1 ? '' : 's'}`, `${poss} possible`, `${ov.reused.length} legitimate reuse${ov.reused.length === 1 ? '' : 's'}`, `${ov.overlaps.length} overlap${ov.overlaps.length === 1 ? '' : 's'}`, `${ov.orphans.length} address${ov.orphans.length === 1 ? '' : 'es'} outside the declared networks`];
  return parts.join(' · ');
}

/** How many networks the state shows, in words (for the live status line). */
export function shownText(ov: AddressingOverview, st: AddrViewState): string {
  const total = ov.vrfs.reduce((s, g) => s + g.networks.length, 0);
  const shown = ov.vrfs.reduce((s, g) => s + visibleRows(g, st).filter((r) => !r.context).length, 0);
  const sort = SORTS.find((x) => x.key === st.sort) as { label: string };
  return `${shown} of ${total} network listing${total === 1 ? '' : 's'} shown, sorted by ${sort.label.toLowerCase()}${st.desc ? ' (descending)' : ''}${st.sort === 'prefix' && !st.desc ? ', nested' : ''}.`;
}

/** The question of Addressing (left): the context line is the caller's; the text filter and the issue filter. */
export function addressingRequest(doc: Document, ov: AddressingOverview, st: AddrViewState, act: { issue(k: AddrIssue): void }): HTMLElement {
  const wrap = el(doc, 'div', { class: 'addr addr-request' });
  const filter = el(doc, 'input', { type: 'search', id: 'addr-filter', 'data-addr-filter': '', placeholder: 'prefix, name, VLAN, device, address…', 'aria-describedby': 'addr-status', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  filter.value = st.filter;
  const filters = el(doc, 'div', { class: 'an-filters' }, [el(doc, 'div', { class: 'tf-row' }, [el(doc, 'label', { for: 'addr-filter' }, ['Filter']), filter])]);
  wrap.appendChild(filters);
  const seg = el(doc, 'div', { class: 'seg addr-issue', role: 'radiogroup', 'aria-label': 'Show' });
  for (const t of ADDR_ISSUES) {
    const on = st.issue === t.id;
    const n = t.id === 'conflicts' ? ov.duplicates.length : t.id === 'overlaps' ? ov.overlaps.length : t.id === 'outside' ? ov.orphans.length : -1;
    const b = el(doc, 'button', { type: 'button', role: 'radio', class: 'mini' + (on ? ' active' : ''), 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-addr-issue': t.id, title: t.help }, [t.label + (n >= 0 ? ` (${n})` : '')]);
    b.addEventListener('click', () => act.issue(t.id));
    seg.appendChild(b);
  }
  seg.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(k) < 0) return;
    e.preventDefault();
    const i = ADDR_ISSUES.findIndex((x) => x.id === st.issue);
    act.issue(ADDR_ISSUES[(i + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : ADDR_ISSUES.length - 1)) % ADDR_ISSUES.length].id);
  });
  filters.appendChild(el(doc, 'div', { class: 'tf-row' }, [el(doc, 'span', { class: 'small muted', id: 'addr-issue-l' }, ['Show']), seg]));
  seg.setAttribute('aria-labelledby', 'addr-issue-l');
  wrap.appendChild(
    el(doc, 'details', { class: 'an-limits addr-legend' }, [
      el(doc, 'summary', {}, ['What the columns mean']),
      el(doc, 'p', { class: 'small' }, ['Hosts: the addresses in use (configured, reserved, acquired in a snapshot) of the host addresses. Allocated: what is configured, reserved, acquired, in a DHCP pool or in a nested network; each address counts once. A parent prefix with few hosts of its own may be allocated to its subnets.']),
      el(doc, 'p', { class: 'small' }, ['Unallocated in model: not configured, not reserved (DHCP reservations, a scope’s gateway, a gateway routes name), not acquired, outside the DHCP pools and nested networks. An address outside NetAtlas may still be in use: it is not guaranteed free.']),
    ]),
  );
  return wrap;
}

/** The results of Addressing (bottom): the summary, the exports and Expand all, the live status line, then the tables. */
export function addressingResults(doc: Document, ov: AddressingOverview, st: AddrViewState, sel: string): HTMLElement {
  const wrap = el(doc, 'div', { class: 'addr' });
  const anyOpen = st.open.size > 0;
  wrap.appendChild(
    el(doc, 'div', { class: 'an-res-tools addr-controls' }, [
      el(doc, 'button', { type: 'button', class: 'mini', 'data-addr-all': anyOpen ? 'close' : 'open', title: 'The members of every network in place (their details are also in the evidence panel)' }, [anyOpen ? 'Collapse all members' : 'Expand all members']),
      el(doc, 'button', { type: 'button', class: 'mini', 'data-addr-csv': 'copy', title: 'Copy the network table as CSV (comma-separated values)' }, ['Copy CSV']),
      el(doc, 'button', { type: 'button', class: 'mini', 'data-addr-csv': 'save', title: 'Save the network table as a CSV file' }, ['Save CSV']),
    ]),
  );
  wrap.appendChild(el(doc, 'p', { class: 'small', id: 'addr-summary' }, [el(doc, 'strong', {}, ['Issues: ']), issueSummary(ov)]));
  wrap.appendChild(el(doc, 'p', { id: 'addr-status', class: 'muted small', role: 'status' }, [shownText(ov, st)]));
  wrap.appendChild(addressingTables(doc, ov, st, sel));
  return wrap;
}

/** The issue an item key names, and its evidence. */
export function issueDetail(doc: Document, ov: AddressingOverview, key: string): { title: string; kind: string; explanation: Node[]; evidence: Node[]; refs: string[] } | null {
  const m = /^issue:(dup|reuse|overlap|orphan):(\d+)$/.exec(key);
  if (!m) return null;
  const k = Number(m[2]);
  const scope = (v: string): string => (v === '' ? 'the default table' : 'VRF ' + v);
  if (m[1] === 'dup' || m[1] === 'reuse') {
    const d = m[1] === 'dup' ? ov.duplicates[k] : ov.reused[k];
    if (!d) return null;
    const certainty = m[1] === 'dup' ? ((d as typeof ov.duplicates[number]).certainty === 'conflict' ? 'Confirmed conflict' : 'Possible conflict') : 'Legitimate reuse';
    return {
      kind: 'Addressing issue',
      title: `${certainty}: ${d.text}`,
      explanation: [el(doc, 'p', { class: 'small' }, [m[1] === 'dup' ? `${d.text} is configured on ${d.owners.length} interfaces in ${scope(d.vrf)}: ${d.why}.` : `${d.text} is used on ${d.owners.length} interfaces, which the model separates: ${d.why}. Not a conflict in the model.`])],
      evidence: [el(doc, 'ul', { class: 'small' }, d.owners.map((o) => el(doc, 'li', {}, [ref(doc, `iface:${o.device}:${o.iface}`, `${o.device}:${o.iface}`)])))],
      refs: d.owners.map((o) => `iface:${o.device}:${o.iface}`),
    };
  }
  if (m[1] === 'overlap') {
    const o = ov.overlaps[k];
    if (!o) return null;
    return { kind: 'Addressing issue', title: o.kind === 'same-prefix' ? 'Overlap: the same prefix twice' : 'Overlap: an interface subnet larger than its network', explanation: [el(doc, 'p', { class: 'small' }, [`${o.message} (${scope(o.vrf)}).`])], evidence: [], refs: o.refs };
  }
  const o = ov.orphans[k];
  if (!o) return null;
  return { kind: 'Addressing issue', title: `Outside the declared networks: ${o.address}`, explanation: [el(doc, 'p', { class: 'small' }, [`${o.device}:${o.iface} has ${o.address} in ${scope(o.vrf)}, and no network of the model holds it${o.loopback ? ' (a loopback)' : ''}. Declare its network to see its allocation; nothing is assumed about it.`])], evidence: [], refs: [`iface:${o.device}:${o.iface}`, 'device:' + o.device] };
}

/** One CSV field (RFC 4180: quoted when it holds a comma, quote or line break). */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/**
 * The network table as CSV: one line per network and VRF, in tree order;
 * members, gateways and unallocated ranges joined with "; "; the
 * allocation by state; the context (configured model or snapshot) in every
 * line. Counts are exact decimals (also 2^64 and up). Lines end in CRLF
 * (RFC 4180).
 */
export function addressingCsv(ov: AddressingOverview, context = 'Configured model'): string {
  const head = ['vrf', 'prefix', 'vlan', 'name', 'network_id', 'nested_in', 'gateways', 'members', 'used', 'size', 'utilization', 'ipv6_64s', 'next_free', 'free_ranges', 'configured', 'reserved', 'acquired', 'dhcp_pool', 'in_subnets', 'unallocated', 'allocated', 'dhcp_pools', 'context'];
  const lines = [head.join(',')];
  for (const g of ov.vrfs) {
    for (const n of g.networks) {
      const parent = n.parent ? (g.networks.find((x) => x.id === n.parent) as NetEntry).text : '';
      const members = n.members
        .map((u) => `${u.device}:${u.iface} ${u.address}${u.method === 'static' ? '' : ' ' + u.method}`)
        .concat(n.dhcp.map((c) => `${c.device}:${c.iface} dhcp`), n.auto.map((c) => `${c.device}:${c.iface} ${c.method}`));
      const a = n.alloc;
      lines.push(
        [
          g.vrf,
          n.text,
          n.vlan !== undefined ? String(n.vlan) : '',
          n.label,
          n.id,
          parent,
          n.gateways.map((x) => `${x.text} (${x.kind === 'vip' ? 'VIP' : 'gateway'}: ${x.source})`).join('; '),
          members.join('; '),
          n.used.toString(),
          n.size.toString(),
          n.percent !== null ? n.percent.toFixed(1) : '',
          n.nets64 !== null ? n.nets64.toString() : '',
          n.nextFree || '',
          n.free.map((r) => rangeText(r, n.version).replace(' – ', '-')).join('; '),
          a.configured.toString(),
          a.reserved.toString(),
          a.acquired.toString(),
          a.pool.toString(),
          a.subnets.toString(),
          a.unallocated.toString(),
          n.allocatedPercent !== null ? n.allocatedPercent.toFixed(1) : '',
          n.pools.map((p) => `${p.range} on ${p.device}`).join('; '),
          context,
        ]
          .map(csvField)
          .join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}


/** A network's details (the Analyze workspace's right panel): its members, its gateways, its allocation, what is unallocated. */
export function networkDetail(doc: Document, n: NetEntry): HTMLElement {
  const box = el(doc, 'div', { class: 'addr-detail small' });
  const dl = el(doc, 'dl', { class: 'trace-ends' });
  const row = (k: string, v: Array<Node | string>): void => {
    dl.appendChild(el(doc, 'dt', {}, [k]));
    dl.appendChild(el(doc, 'dd', {}, v));
  };
  if (n.vlan !== undefined) row('VLAN', [String(n.vlan)]);
  row('Hosts', [usedText(n), ` (${utilText(n)})`]);
  row('Allocated', [allocText(n)]);
  row('Gateway / VIP', [n.gateways.length ? n.gateways.map((g) => `${g.text} (${g.kind === 'vip' ? 'VIP' : 'gateway'}: ${g.source})`).join('; ') : '—']);
  row('Next unallocated', [n.nextFree || 'none']);
  box.appendChild(dl);
  const free = freeCell(doc, n);
  box.appendChild(el(doc, 'h4', {}, ['Unallocated in model']));
  box.appendChild(el(doc, 'div', {}, Array.from(free.childNodes)));
  box.appendChild(el(doc, 'h4', {}, ['Members']));
  box.appendChild(membersBox(doc, n));
  return box;
}

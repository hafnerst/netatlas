/** Side-panel content (details, legend, relation list) as HTML VNodes. */
import { deviceTypeLabel } from '../model/device-types';
import { sortedByName } from '../model/order';
import { Attrs, CATEGORIES, Interface, Model, ProtocolDef, RelEndpoint, deviceInterfaces, endpointText, ifaceKey, interfaceKindLabel, relationDevices } from '../model/types';
import { LegendItem, SWATCH_H, SWATCH_W, legendOf, relationSwatchParts } from '../diagram/legend';
import { VNode, h } from '../diagram/scene';
import { View } from '../diagram/session';
import { ContextState, SelectionContext, contextState, splitRef } from '../model/queries';
import { mediumStyle } from '../diagram/style';
import { AddressAssoc, deviceNetworks, derivedVlanText, interfaceAddresses, interfaceVlanText, linkEndVlanText, networkMembers, vlanMismatch, vlanMismatchText } from '../model/derive';
import { relationStyle } from '../model/protocols';


function refLink(ref: string, text: string): VNode {
  return h('button', { class: 'ref', type: 'button', 'data-goto': ref, title: 'Select ' + text }, text);
}

function kv(rows: Array<[string, string | VNode | undefined | null]>): VNode {
  return h(
    'table',
    { class: 'kv' },
    rows
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => h('tr', {}, [h('th', {}, k), typeof v === 'string' ? h('td', {}, v) : h('td', {}, [v as VNode])])),
  );
}

function attrsTable(title: string, attrs: Attrs): VNode | null {
  if (!attrs.length) return null;
  return h('section', {}, [h('h4', {}, title), kv(attrs.map(([k, v]) => [k, v] as [string, string]))]);
}

function epNode(model: Model, e: RelEndpoint): VNode {
  const parts: VNode[] = [refLink('device:' + e.device, model.index.devices.get(e.device)?.label || e.device)];
  if (e.iface) parts.push(h('span', { class: 'muted' }, ' '), refLink(`iface:${e.device}:${e.iface}`, e.iface));
  const extra: string[] = [];
  if (e.role) extra.push(e.role);
  if (e.address) extra.push(e.address);
  for (const [k, v] of e.attrs) extra.push(`${k}=${v}`);
  if (extra.length) parts.push(h('span', { class: 'muted' }, '  ' + extra.join(', ')));
  return h('li', {}, parts);
}

/** Read-only "address → network · VLAN" lines of an interface (all derived). */
function derivedAddressList(model: Model, assocs: AddressAssoc[]): VNode {
  return h(
    'ul',
    { class: 'reflist', 'data-derived': 'iface-vlan' },
    assocs.map((a) => {
      const kids: Array<VNode | null> = [h('span', { class: 'ro' }, a.address), h('span', { class: 'muted' }, ' → ')];
      if (!a.valid) kids.push(h('span', { class: 'muted' }, 'not an IP address'));
      else if (!a.networks.length) kids.push(h('span', { class: 'muted' }, 'no network'));
      else {
        a.networks.forEach((n, k) => {
          if (k) kids.push(h('span', {}, ', '));
          kids.push(refLink('network:' + n, model.index.networks.get(n)?.label || n));
        });
        kids.push(h('span', { class: a.vlan.state === 'ambiguous' ? 'warn-text' : 'muted' }, ' · ' + (derivedVlanText(a.vlan) || 'no VLAN defined')));
      }
      return h('li', {}, kids);
    }),
  );
}

/** Text for assistive technology: the state is also shown by markers and weight, not colour alone. */
export function contextNote(st: ContextState | null): VNode | null {
  if (!st) return null;
  return h('span', { class: 'sr-only' }, st === 'selected' ? ' (selected)' : st === 'related' ? ' (directly related)' : ' (not related)');
}

function list(title: string, items: VNode[]): VNode | null {
  if (!items.length) return null;
  return h('section', {}, [h('h4', {}, `${title} (${items.length})`), h('ul', { class: 'reflist' }, items)]);
}

function header(kind: string, title: string): VNode {
  return h('div', { class: 'det-head' }, [
    h('span', { class: 'badge', 'data-kind': kind }, kind),
    h('h3', {}, title),
  ]);
}

/** Details for the selected entity. */
export function detailsFor(model: Model, ref: string): VNode {
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  const kids: Array<VNode | null> = [];
  if (kind === 'device') {
    const d = ix.devices.get(id);
    if (!d) return h('div', {}, 'Not found');
    kids.push(header('device', d.label));
    kids.push(
      kv([
        ['id', d.id],
        ['type', deviceTypeLabel(d.type) || undefined],
        ['group', d.group ? refLink('group:' + d.group, ix.groups.get(d.group)?.label || d.group) : undefined],
        ['description', d.description],
      ]),
    );
    // display order is alphabetical; the file order is not changed by viewing
    const loops = sortedByName(d.loopbacks, (l) => l.id);
    if (loops.length) {
      kids.push(
        h('section', { 'data-list': 'loopbacks' }, [
          h('h4', {}, `Loopbacks (${loops.length})`),
          h(
            'table',
            { class: 'ports' },
            [h('tr', {}, [h('th', {}, 'id'), h('th', {}, 'name'), h('th', {}, 'addresses'), h('th', {}, 'used by')])].concat(
              loops.map((l) => {
                const users = model.relations.filter((r) => r.endpoints.some((e) => e.device === d.id && e.iface === l.id));
                return h('tr', { 'data-iface': l.id }, [
                  h('td', {}, [refLink(`iface:${d.id}:${l.id}`, l.id)]),
                  h('td', {}, l.label || ''),
                  h('td', {}, l.addresses.join('\n')),
                  h('td', {}, users.map((r) => refLink('relation:' + r.id, r.protocol.toUpperCase()))),
                ]);
              }),
            ),
          ),
        ]),
      );
    }
    const row = (i: Interface): VNode => {
      const lid = ix.ifaceLink.get(ifaceKey(d.id, i.id));
      const l = lid ? ix.links.get(lid) : undefined;
      const peer = l ? (l.a.device === d.id && l.a.iface === i.id ? l.b : l.a) : undefined;
      return h('tr', { class: (i.parent ? 'child' : l ? '' : 'unused'), 'data-iface': i.id, 'data-kind': i.type }, [
        h('td', {}, [i.parent ? h('span', { class: 'child-mark', 'aria-hidden': 'true' }, '↳ ') : null, refLink(`iface:${d.id}:${i.id}`, i.id)]),
        h('td', {}, interfaceKindLabel(i.type)),
        h('td', {}, i.addresses.join(', ')),
        h('td', {}, interfaceVlanText(interfaceAddresses(model, d.id, i.id)).replace(/VLAN /g, '')),
        h('td', {}, peer ? [refLink('link:' + (lid as string), '→ ' + endpointText(peer))] : []),
      ]);
    };
    // each physical interface, followed by its logical and tunnel children
    const rows: VNode[] = [];
    for (const i of sortedByName(d.interfaces, (x) => x.id)) {
      rows.push(row(i));
      for (const c of sortedByName(i.children, (x) => x.id)) rows.push(row(c));
    }
    if (rows.length) {
      const kidsN = rows.length - d.interfaces.length;
      kids.push(
        h('section', { 'data-list': 'interfaces' }, [
          h('h4', {}, `Interfaces (${d.interfaces.length} physical, ${d.interfaces.filter((i) => ix.ifaceLink.has(ifaceKey(d.id, i.id))).length} cabled${kidsN ? `, ${kidsN} child${kidsN > 1 ? 'ren' : ''}` : ''})`),
          h('table', { class: 'ports' }, [h('tr', {}, [h('th', {}, 'interface'), h('th', {}, 'type'), h('th', {}, 'address'), h('th', { title: 'Derived from the network containing the address' }, 'vlan'), h('th', {}, 'cable')]), ...rows]),
        ]),
      );
    }
    kids.push(
      list(
        'Logical relations',
        model.relations
          .filter((r) => r.endpoints.some((e) => e.device === d.id))
          .map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))])),
      ),
    );
    kids.push(
      list(
        'Networks',
        deviceNetworks(model, d.id).map((n) => h('li', {}, [refLink('network:' + n, ix.networks.get(n)?.label || n)])),
      ),
    );
    kids.push(attrsTable('Attributes', d.attrs));
  } else if (kind === 'iface') {
    const i = ix.interfaces.get(id);
    if (!i) return h('div', {}, 'Not found');
    const lid = ix.ifaceLink.get(id);
    kids.push(header('interface', i.device + ' ' + i.id));
    kids.push(
      kv([
        ['device', refLink('device:' + i.device, ix.devices.get(i.device)?.label || i.device)],
        ['label', i.label],
        ['type', interfaceKindLabel(i.type)],
        ['physical interface', i.parent ? refLink(`iface:${i.device}:${i.parent}`, i.parent) : undefined],
        ['addresses', i.addresses.join(', ')],
        ['vrf', i.vrf],
        ['mac', i.mac],
        ['cable', i.type !== 'physical' ? undefined : lid ? refLink('link:' + lid, lid) : 'not cabled'],
        ['description', i.description],
      ]),
    );
    const assocs = interfaceAddresses(model, i.device, i.id);
    if (assocs.length) kids.push(h('section', {}, [h('h4', {}, 'Network / VLAN (derived from the addresses)'), derivedAddressList(model, assocs)]));
    kids.push(
      list(
        'Child interfaces',
        sortedByName(i.children, (c) => c.id).map((c) =>
          h('li', { 'data-iface': c.id }, [refLink(`iface:${i.device}:${c.id}`, c.id), h('span', { class: 'muted' }, ' ' + [interfaceKindLabel(c.type), c.addresses.join(', ')].filter((x) => x).join(' · '))]),
        ),
      ),
    );
    kids.push(
      list(
        'Relations on this interface',
        model.relations
          .filter((r) => r.endpoints.some((e) => e.device === i.device && e.iface === i.id))
          .map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))])),
      ),
    );
    kids.push(attrsTable('Attributes', i.attrs));
  } else if (kind === 'link') {
    const l = ix.links.get(id);
    if (!l) return h('div', {}, 'Not found');
    kids.push(header('physical link', l.label || l.id));
    const ep = (e: { device: string; iface?: string; vlans: number[] }): VNode =>
      h('span', {}, [
        refLink('device:' + e.device, ix.devices.get(e.device)?.label || e.device),
        e.iface ? h('span', {}, ' ') : null,
        e.iface ? refLink(`iface:${e.device}:${e.iface}`, e.iface) : null,
        h('span', { class: e.vlans.length ? 'vlan-end' : 'vlan-end muted' }, ' — ' + linkEndVlanText(e.vlans)),
      ]);
    const mm = vlanMismatch(l.a.vlans, l.b.vlans);
    kids.push(
      kv([
        ['id', l.id],
        ['A', ep(l.a)],
        ['B', ep(l.b)],
        ['VLANs', mm ? h('span', { class: 'warn-text', 'data-vlan-mismatch': 'yes' }, '⚠ mismatch — ' + vlanMismatchText(mm)) : undefined],
        ['medium', mediumStyle(l.medium).label],
        ['speed', l.speed],
        ['cable', l.cable],
        ['description', l.description],
      ]),
    );
    kids.push(
      list(
        'Carries (logical)',
        model.relations.filter((r) => r.over.indexOf(l.id) >= 0).map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))])),
      ),
    );
    kids.push(attrsTable('Attributes', l.attrs));
  } else if (kind === 'relation' || kind === 'hub') {
    const r = ix.relations.get(id);
    if (!r) return h('div', {}, 'Not found');
    const def = relationStyle(model, r);
    kids.push(header(r.category, relationTitle(model, r.id)));
    kids.push(
      kv([
        ['id', r.id],
        ['protocol', def.label + (def.label.toLowerCase() !== r.protocol ? ` (${r.protocol})` : '')],
        ['category', r.category],
        ['directed', r.directed ? 'yes (first → last endpoint)' : undefined],
        ['network', r.network ? refLink('network:' + r.network, ix.networks.get(r.network)?.label || r.network) : undefined],
        ['description', r.description],
      ]),
    );
    kids.push(list('Endpoints', r.endpoints.map((e) => epNode(model, e))));
    kids.push(
      list(
        'Carried over (underlay)',
        r.over.map((o) => {
          const k = ix.links.has(o) ? 'link' : ix.networks.has(o) ? 'network' : 'relation';
          const text = k === 'relation' ? relationTitle(model, o) : k === 'link' ? `cable ${o}` : ix.networks.get(o)?.label || o;
          return h('li', {}, [refLink(k + ':' + o, text)]);
        }),
      ),
    );
    kids.push(
      list(
        'Carries (overlay)',
        model.relations.filter((x) => x.over.indexOf(r.id) >= 0).map((x) => h('li', {}, [refLink('relation:' + x.id, relationTitle(model, x.id))])),
      ),
    );
    kids.push(attrsTable(def.label + ' attributes', r.attrs));
    if (def.description) kids.push(h('p', { class: 'muted' }, def.description));
  } else if (kind === 'network') {
    const n = ix.networks.get(id);
    if (!n) return h('div', {}, 'Not found');
    kids.push(header('IP network', n.label));
    kids.push(kv([['id', n.id], ['cidr', n.cidr.join(', ')], ['vlan', n.vlan !== undefined ? String(n.vlan) : undefined], ['description', n.description]]));
    // derived: every device with an address inside the network's prefixes, once
    kids.push(
      list(
        'Members',
        networkMembers(model, n.id).map((m) =>
          h('li', { 'data-member': m.device }, [
            refLink('device:' + m.device, ix.devices.get(m.device)?.label || m.device),
            ...m.matches.map((x, k) =>
              h('span', {}, [h('span', { class: 'muted' }, k ? ', ' : ' '), refLink(`iface:${x.device}:${x.iface}`, x.iface), h('span', { class: 'muted' }, ' ' + x.address)]),
            ),
          ]),
        ),
      ),
    );
    kids.push(
      list(
        'Relations',
        model.relations
          .filter((r) => r.network === n.id || r.over.indexOf(n.id) >= 0)
          .map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))])),
      ),
    );
    kids.push(attrsTable('Attributes', n.attrs));
  } else if (kind === 'group') {
    const g = ix.groups.get(id);
    if (!g) return h('div', {}, 'Not found');
    kids.push(header(g.kind || 'group', g.label));
    kids.push(kv([['id', g.id], ['kind', g.kind], ['parent', g.parent ? refLink('group:' + g.parent, ix.groups.get(g.parent)?.label || g.parent) : undefined], ['description', g.description]]));
    kids.push(list('Sub-groups', model.groups.filter((c) => c.parent === g.id).map((c) => h('li', {}, [refLink('group:' + c.id, c.label)]))));
    kids.push(list('Devices', model.devices.filter((d) => d.group === g.id).map((d) => h('li', {}, [refLink('device:' + d.id, d.label)]))));
    kids.push(attrsTable('Attributes', g.attrs));
  } else if (kind === 'protocol') {
    const p = model.protocols.get(id);
    if (!p) return h('div', {}, 'Not found');
    kids.push(header('protocol', p.label));
    kids.push(kv([['id', p.id], ['category', p.category], ['description', p.description]]));
    kids.push(list('Relations', model.relations.filter((r) => r.protocol === id).map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))]))));
  } else {
    return h('div', {}, 'Nothing selected');
  }
  return h('div', { class: 'details' }, kids);
}

export function relationTitle(model: Model, id: string): string {
  const r = model.index.relations.get(id);
  if (!r) return id;
  const def = relationStyle(model, r);
  const devs = relationDevices(r).map((d) => model.index.devices.get(d)?.label || d);
  const pair = devs.length <= 3 ? devs.join(r.directed ? ' → ' : ' ↔ ') : `${devs.length} devices`;
  return `${def.label}${r.label ? ' “' + r.label + '”' : ''}: ${pair}`;
}

/** Short hover text. */
export function tooltipFor(model: Model, ref: string): string[] {
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  if (kind === 'device') {
    const d = ix.devices.get(id);
    if (!d) return [];
    const cabled = d.interfaces.filter((i) => ix.ifaceLink.has(ifaceKey(d.id, i.id))).length;
    const others = deviceInterfaces(d).length - d.interfaces.length - d.loopbacks.length;
    return [
      d.label,
      deviceTypeLabel(d.type),
      `${d.interfaces.length} physical interface${d.interfaces.length === 1 ? '' : 's'}, ${cabled} cabled`,
      others ? `${others} child interface${others === 1 ? '' : 's'}` : '',
      d.loopbacks.length ? `${d.loopbacks.length} loopback${d.loopbacks.length === 1 ? '' : 's'}` : '',
    ].filter((s) => s);
  }
  if (kind === 'iface') {
    const i = ix.interfaces.get(id);
    if (!i) return [];
    return [`${i.device} ${i.id}`, interfaceKindLabel(i.type) + (i.parent ? ' on ' + i.parent : '') + (i.children.length ? ' · children: ' + sortedByName(i.children, (c) => c.id).map((c) => c.id).join(', ') : ''), i.addresses.join(', '), interfaceVlanText(interfaceAddresses(model, i.device, i.id)), i.description || ''].filter((s) => s);
  }
  if (kind === 'link') {
    const l = ix.links.get(id);
    if (!l) return [];
    const carried = model.relations.filter((r) => r.over.indexOf(l.id) >= 0).length;
    return [
      `${endpointText(l.a)}  ⟷  ${endpointText(l.b)}`,
      [mediumStyle(l.medium).label, l.speed, l.label, l.cable].filter((s) => s).join(' · '),
      l.a.vlans.length || l.b.vlans.length ? `A: ${linkEndVlanText(l.a.vlans)}  |  B: ${linkEndVlanText(l.b.vlans)}` : '',
      vlanMismatch(l.a.vlans, l.b.vlans) ? '⚠ VLAN mismatch between the ends' : '',
      carried ? `carries ${carried} logical relation${carried > 1 ? 's' : ''}` : '',
    ].filter((s) => s);
  }
  if (kind === 'relation' || kind === 'hub') {
    const r = ix.relations.get(id);
    if (!r) return [];
    const lines = [relationTitle(model, id), r.category + (r.over.length ? ' · over ' + r.over.join(', ') : '')];
    for (const [k, v] of r.attrs.slice(0, 4)) lines.push(`${k}: ${v}`);
    return lines;
  }
  if (kind === 'network') {
    const n = ix.networks.get(id);
    if (!n) return [];
    const count = networkMembers(model, n.id).length;
    return [n.label, [n.vlan !== undefined ? 'VLAN ' + n.vlan : '', n.cidr.join(', ')].filter((s) => s).join(' · '), `${count} member${count === 1 ? '' : 's'}`].filter((s) => s);
  }
  if (kind === 'group') {
    const g = ix.groups.get(id);
    if (!g) return [];
    return [g.label, g.kind];
  }
  return [];
}

// ------------------------------------------------------------------ legend
// What the legend contains is defined once, in diagram/legend.ts; this is its
// HTML form for the Legend tab. Exported SVG files draw the same entries.

function swatchSvg(children: VNode[], height = SWATCH_H): VNode {
  return h('svg', { class: 'swatch', width: SWATCH_W, height, viewBox: `0 0 ${SWATCH_W} ${height}`, 'aria-hidden': height === SWATCH_H ? 'true' : undefined }, children);
}

export function relationSwatch(def: ProtocolDef): VNode {
  return swatchSvg(relationSwatchParts(def));
}

function row(item: LegendItem): VNode {
  return h('li', { class: 'legend-row' }, [swatchSvg(item.swatch, item.swatchH), h('span', {}, item.label)]);
}

export function legendFor(model: Model, view: View, hidden: Set<string>): VNode {
  const legend = legendOf(model, view);
  const sections: VNode[] = legend.sections.map((s) =>
    h('section', {}, [
      h('h4', {}, s.title),
      h(
        'ul',
        {},
        s.items.map((i) =>
          i.protocol === undefined
            ? row(i)
            : h('li', { class: 'legend-row' }, [
                h('label', { class: 'legend-toggle' }, [
                  h('input', { type: 'checkbox', 'data-proto': i.protocol, checked: hidden.has(i.protocol) ? undefined : 'checked', title: 'Show / hide ' + i.label }),
                  swatchSvg(i.swatch),
                  h('span', {}, `${i.label}${i.custom ? ' *' : ''}`),
                  h('span', { class: 'count' }, String(i.count)),
                ]),
              ]),
        ),
      ),
      s.note ? h('p', { class: 'muted' }, s.note) : null,
      s.more ? h('ul', {}, s.more.map(row)) : null,
    ]),
  );
  if (legend.footer) sections.push(h('p', { class: 'muted' }, legend.footer));
  return h('div', { class: 'legend' }, sections);
}

/** Relations list (usable from both views; selecting highlights the underlay path). */
/** Relations by category; with a selection, entries show its context like the outline. */
export function relationList(model: Model, ctx: SelectionContext | null = null): VNode {
  if (!model.relations.length) return h('p', { class: 'muted' }, 'This file defines no logical relations.');
  const cats = CATEGORIES.filter((c) => model.relations.some((r) => r.category === c));
  return h(
    'div',
    { class: 'rel-list' },
    cats.map((c) =>
      h('section', {}, [
        h('h4', {}, c),
        h(
          'ul',
          { class: 'reflist' },
          model.relations
            .filter((r) => r.category === c)
            .map((r) => {
              const st = contextState(ctx, 'relation:' + r.id);
              return h('li', st ? { class: 'ctx-' + st } : {}, [relationSwatch(relationStyle(model, r)), refLink('relation:' + r.id, relationTitle(model, r.id)), contextNote(st)]);
            }),
        ),
      ]),
    ),
  );
}

/** Side-panel content (details, legend, relation list) as HTML VNodes. */
import { deviceIcon, iconName } from '../diagram/icons';
import { Attrs, CATEGORIES, Category, Model, ProtocolDef, RelEndpoint, endpointText, ifaceKey, isLoopback, loopbacks, relationDevices } from '../model/types';
import { VNode, h } from '../diagram/scene';
import { View, splitRef } from '../diagram/session';
import { groupKindStyle, mediumStyle, networkColor, speedWidth } from '../diagram/style';
import { relationStyle } from '../validation/validate';

const CATEGORY_TEXT: { [c in Category]: string } = {
  tunnel: 'Tunnel (encapsulation) — hollow tube',
  adjacency: 'Protocol adjacency / session',
  overlay: 'Overlay / virtual network',
  redundancy: 'Redundancy / bundling',
  service: 'Service / dependency',
  other: 'Other logical relation',
};

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
        ['type', d.type],
        ['role', d.role],
        ['vendor', d.vendor],
        ['model', d.model],
        ['mgmt', d.mgmt],
        ['router ID', d.routerId ? refLink(`iface:${d.id}:${d.routerId}`, `${d.routerId} (${(d.interfaces.find((i) => i.id === d.routerId)?.addresses || []).filter((a) => a.indexOf(':') < 0)[0] || 'no IPv4'})`) : undefined],
        ['group', d.group ? refLink('group:' + d.group, ix.groups.get(d.group)?.label || d.group) : undefined],
        ['description', d.description],
      ]),
    );
    const loops = loopbacks(d);
    if (loops.length) {
      kids.push(
        h('section', {}, [
          h('h4', {}, `Loopbacks (${loops.length})`),
          h(
            'table',
            { class: 'ports' },
            [h('tr', {}, [h('th', {}, 'id'), h('th', {}, 'name'), h('th', {}, 'addresses'), h('th', {}, 'used by')])].concat(
              loops.map((l) => {
                const users = model.relations.filter((r) => r.endpoints.some((e) => e.device === d.id && e.iface === l.id));
                return h('tr', {}, [
                  h('td', {}, [refLink(`iface:${d.id}:${l.id}`, l.id + (d.routerId === l.id ? ' ★' : ''))]),
                  h('td', {}, l.label || ''),
                  h('td', {}, l.addresses.join('\n')),
                  h('td', {}, users.map((r) => refLink('relation:' + r.id, r.protocol.toUpperCase()))),
                ]);
              }),
            ),
          ),
          d.routerId ? h('p', { class: 'muted small' }, '★ = router ID source') : null,
        ]),
      );
    }
    const rows = d.interfaces.filter((i) => !isLoopback(i)).map((i) => {
      const lid = ix.ifaceLink.get(ifaceKey(d.id, i.id));
      const l = lid ? ix.links.get(lid) : undefined;
      const peer = l ? (l.a.device === d.id && l.a.iface === i.id ? l.b : l.a) : undefined;
      return h('tr', { class: l ? '' : 'unused' }, [
        h('td', {}, [refLink(`iface:${d.id}:${i.id}`, i.id)]),
        h('td', {}, [i.type === 'physical' ? '' : i.type, i.speed || '', i.media || ''].filter((s) => s).join(' ')),
        h('td', {}, i.addresses.join(', ')),
        h('td', {}, peer ? [refLink('link:' + (lid as string), '→ ' + endpointText(peer))] : []),
      ]);
    });
    if (rows.length) {
      kids.push(
        h('section', {}, [
          h('h4', {}, `Interfaces (${rows.length}, ${d.interfaces.filter((i) => ix.ifaceLink.has(ifaceKey(d.id, i.id))).length} cabled)`),
          h('table', { class: 'ports' }, [h('tr', {}, [h('th', {}, 'port'), h('th', {}, 'type'), h('th', {}, 'address'), h('th', {}, 'cable')]), ...rows]),
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
        model.networks.filter((n) => n.members.some((m) => m.device === d.id)).map((n) => h('li', {}, [refLink('network:' + n.id, n.label)])),
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
        ['type', i.type],
        ['speed', i.speed],
        ['media', i.media],
        ['addresses', i.addresses.join(', ')],
        ['vlan', i.vlan],
        ['mac', i.mac],
        ['cable', lid ? refLink('link:' + lid, lid) : 'not cabled'],
        ['description', i.description],
      ]),
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
    const ep = (e: { device: string; iface?: string }): VNode =>
      h('span', {}, [
        refLink('device:' + e.device, ix.devices.get(e.device)?.label || e.device),
        e.iface ? h('span', {}, ' ') : null,
        e.iface ? refLink(`iface:${e.device}:${e.iface}`, e.iface) : null,
      ]);
    kids.push(
      kv([
        ['id', l.id],
        ['A', ep(l.a)],
        ['B', ep(l.b)],
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
    kids.push(header(n.kind, n.label));
    kids.push(kv([['id', n.id], ['kind', n.kind], ['cidr', n.cidr.join(', ')], ['vlan', n.vlan], ['vrf', n.vrf], ['description', n.description]]));
    kids.push(list('Members', n.members.map((m) => epNode(model, m))));
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
    kids.push(header(g.kind, g.label));
    kids.push(kv([['id', g.id], ['kind', g.kind], ['parent', g.parent ? refLink('group:' + g.parent, ix.groups.get(g.parent)?.label || g.parent) : undefined], ['description', g.description]]));
    kids.push(list('Sub-groups', model.groups.filter((c) => c.parent === g.id).map((c) => h('li', {}, [refLink('group:' + c.id, c.label)]))));
    kids.push(list('Devices', model.devices.filter((d) => d.group === g.id).map((d) => h('li', {}, [refLink('device:' + d.id, d.label)]))));
    kids.push(attrsTable('Attributes', g.attrs));
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
    return [d.label, [d.type, d.vendor, d.model].filter((s) => s).join(' · '), `${d.interfaces.length} interfaces, ${cabled} cabled`, d.mgmt ? 'mgmt ' + d.mgmt : ''].filter((s) => s);
  }
  if (kind === 'iface') {
    const i = ix.interfaces.get(id);
    if (!i) return [];
    return [`${i.device} ${i.id}`, [i.type !== 'physical' ? i.type : '', i.speed, i.media].filter((s) => s).join(' · '), i.addresses.join(', '), i.description || ''].filter((s) => s);
  }
  if (kind === 'link') {
    const l = ix.links.get(id);
    if (!l) return [];
    const carried = model.relations.filter((r) => r.over.indexOf(l.id) >= 0).length;
    return [
      `${endpointText(l.a)}  ⟷  ${endpointText(l.b)}`,
      [mediumStyle(l.medium).label, l.speed, l.label, l.cable].filter((s) => s).join(' · '),
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
    return [n.label, [n.kind, n.vlan ? 'VLAN ' + n.vlan : '', n.cidr.join(', ')].filter((s) => s).join(' · '), `${n.members.length} members`];
  }
  if (kind === 'group') {
    const g = ix.groups.get(id);
    if (!g) return [];
    return [g.label, g.kind];
  }
  return [];
}

// ------------------------------------------------------------------ legend

function swatchSvg(children: VNode[]): VNode {
  return h('svg', { class: 'swatch', width: 44, height: 18, viewBox: '0 0 44 18', 'aria-hidden': 'true' }, children);
}

export function relationSwatch(def: ProtocolDef): VNode {
  const d = 'M3 9H41';
  if (def.style === 'tube') {
    return swatchSvg([
      h('path', { class: 'tube-outer', d, stroke: def.color, 'stroke-width': 10 }),
      h('path', { class: 'tube-inner', d, 'stroke-width': 4.8 }),
    ]);
  }
  const dash = def.style === 'dashed' ? '9 5' : def.style === 'dotted' ? '0.5 5' : def.style === 'dashdot' ? '10 4 2 4' : undefined;
  return swatchSvg([
    h('path', { class: 'rel-line', d, stroke: def.color, 'stroke-width': def.style === 'dotted' ? 3.2 : 2.4, 'stroke-dasharray': dash, 'stroke-linecap': def.style === 'dotted' ? 'round' : undefined }),
  ]);
}

function row(sw: VNode, label: string, extra?: VNode | null): VNode {
  return h('li', { class: 'legend-row' }, [sw, h('span', {}, label), extra || null]);
}

export function legendFor(model: Model, view: View, hidden: Set<string>): VNode {
  const sections: VNode[] = [];
  if (view === 'physical') {
    const types = Array.from(new Set(model.devices.map((d) => iconName(d.type)))).sort();
    sections.push(
      h('section', {}, [
        h('h4', {}, 'Devices'),
        h('ul', {}, types.map((t) => row(h('svg', { class: 'swatch', width: 44, height: 22, viewBox: '0 0 44 22' }, [deviceIcon(t, 11, 0, 22)]), t))),
      ]),
    );
    const media = new Map<string, { label: string; color: string; dash?: string }>();
    for (const l of model.links) {
      const m = mediumStyle(l.medium);
      media.set(m.key, m);
    }
    if (media.size) {
      sections.push(
        h('section', {}, [
          h('h4', {}, 'Cables (physical links)'),
          h(
            'ul',
            {},
            Array.from(media.values()).map((m) =>
              row(swatchSvg([h('path', { d: 'M3 9H41', stroke: m.color, 'stroke-width': 2.6, 'stroke-dasharray': m.dash, fill: 'none' })]), m.label),
            ),
          ),
          h('p', { class: 'muted' }, 'Line width grows with link speed (100M → 400G). Small squares are ports; labels show the interface name.'),
          h('ul', {}, [
            row(swatchSvg([h('path', { d: 'M3 9H41', stroke: '#868e96', 'stroke-width': speedWidth('1G'), fill: 'none' })]), '1G'),
            row(swatchSvg([h('path', { d: 'M3 9H41', stroke: '#868e96', 'stroke-width': speedWidth('100G'), fill: 'none' })]), '100G'),
          ]),
        ]),
      );
    }
    const kinds = Array.from(new Set(model.groups.map((g) => g.kind)));
    if (kinds.length) {
      sections.push(
        h('section', {}, [
          h('h4', {}, 'Locations / groups'),
          h(
            'ul',
            {},
            kinds.map((k) =>
              row(
                swatchSvg([
                  h('rect', { class: 'group-box ' + (groupKindStyle(k).strong ? 'group-strong' : ''), x: 3, y: 2, width: 38, height: 14, rx: 4, 'stroke-dasharray': groupKindStyle(k).dash }),
                ]),
                k,
              ),
            ),
          ),
        ]),
      );
    }
    sections.push(h('p', { class: 'muted' }, 'Tunnels and protocol sessions are logical and are shown in the Logical view, not as cables. Select a tunnel in the Relations list to highlight the cables it rides on.'));
  } else {
    const used = new Map<string, { def: ProtocolDef; count: number }>();
    for (const r of model.relations) {
      const def = relationStyle(model, r);
      const u = used.get(r.protocol);
      if (u) u.count++;
      else used.set(r.protocol, { def, count: 1 });
    }
    for (const cat of CATEGORIES) {
      const protos = Array.from(used.entries()).filter(([, u]) => u.def.category === cat);
      if (!protos.length) continue;
      sections.push(
        h('section', {}, [
          h('h4', {}, CATEGORY_TEXT[cat]),
          h(
            'ul',
            {},
            protos.map(([p, u]) =>
              h('li', { class: 'legend-row' }, [
                h('label', { class: 'legend-toggle' }, [
                  h('input', { type: 'checkbox', 'data-proto': p, checked: hidden.has(p) ? undefined : 'checked', title: 'Show / hide ' + u.def.label }),
                  relationSwatch(u.def),
                  h('span', {}, `${u.def.label}${u.def.custom ? ' *' : ''}`),
                  h('span', { class: 'count' }, String(u.count)),
                ]),
              ]),
            ),
          ),
        ]),
      );
    }
    sections.push(
      h('section', {}, [
        h('h4', {}, 'Other symbols'),
        h('ul', {}, [
          row(
            swatchSvg([
              h('path', { class: 'tube-outer', d: 'M3 9H41', stroke: '#7048e8', 'stroke-width': 14 }),
              h('path', { class: 'tube-inner', d: 'M3 9H41', 'stroke-width': 8.8 }),
              h('path', { class: 'tube-outer', d: 'M3 9H41', stroke: '#e8590c', 'stroke-width': 7 }),
              h('path', { class: 'tube-inner', d: 'M3 9H41', 'stroke-width': 2 }),
            ]),
            'Carried inside (e.g. GRE over IPsec)',
          ),
          row(swatchSvg([h('circle', { class: 'hub', cx: 22, cy: 9, r: 7, stroke: '#0c8599' })]), 'Multipoint hub (3+ devices)'),
          row(swatchSvg([h('rect', { class: 'net-box', x: 3, y: 2, width: 38, height: 14, rx: 7, stroke: networkColor('subnet') })]), 'Network (subnet / VLAN / VRF …)'),
          row(swatchSvg([h('path', { class: 'member', d: 'M3 9H41' })]), 'Network membership'),
          row(swatchSvg([h('path', { class: 'underlay', d: 'M3 9H41' })]), 'Physical adjacency (optional underlay)'),
        ]),
        used.size && Array.from(used.values()).some((u) => u.def.custom)
          ? h('p', { class: 'muted' }, '* defined in this file’s "protocols" section')
          : null,
      ]),
    );
  }
  return h('div', { class: 'legend' }, sections);
}

/** Relations list (usable from both views; selecting highlights the underlay path). */
export function relationList(model: Model): VNode {
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
            .map((r) => h('li', {}, [relationSwatch(relationStyle(model, r)), refLink('relation:' + r.id, relationTitle(model, r.id))])),
        ),
      ]),
    ),
  );
}

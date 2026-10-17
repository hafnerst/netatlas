/** Side-panel content (details, legend, relation list) as HTML VNodes. */
import { deviceKindLabel, deviceTypeLine, roleLabel } from '../model/device-types';
import { sortedByName } from '../model/order';
import { Attrs, CATEGORIES, Interface, LinkEnd, Model, ProtocolDef, RelEndpoint, Route, TunnelEnd, endpointText, ifaceKey, interfaceKindLabel, relationDevices, VpnService, VPN_OPERATIONS, VPN_TECHNOLOGIES } from '../model/types';
import { LegendItem, LegendSection, SWATCH_H, SWATCH_W, legendOf, relationSwatchParts } from '../diagram/legend';
import { VNode, h } from '../diagram/scene';
import { iconNode } from './dom';
import { View } from '../diagram/session';
import { ContextState, SelectionContext, contextState, routeRefOf, routesUsing, splitRef } from '../model/queries';
import { mediumStyle } from '../diagram/style';
import { AddressAssoc, addressOwners, associatedInterfaces, bridgePortsText, deviceNetworks, portRuns, vlanPortsByMode, derivedVlanText, endL2, endNetworks, interfaceAddresses, interfaceVlanPorts, interfaceVlanText, interfaceVlans, lagOf, networkMembers, networkName, portBadgeText, portL2, subinterfaceParent, tagMismatch, tagMismatchText } from '../model/derive';
import { relationStyle } from '../model/protocols';
import { compareRoutes, identityLines, routeLine } from '../model/addresses';
import { formatAddr } from '../analysis/ipmath';
import { DEFAULT_STATIC_DISTANCE, resolveRoute } from '../analysis/routing';
import { separationSummary } from '../analysis/separation';


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

/**
 * What an interface is associated with, in words: a port's (or an
 * aggregate's) VLANs, an aggregate's member ports, the VLAN of a VLAN
 * interface and its bridge ports, a subinterface's port, the source and
 * destination of a tunnel. '' when there is nothing to say.
 */
export function associationText(model: Model, i: Interface): string {
  const parts: string[] = [];
  const l2 = portBadgeText(portL2(model, i.device, i.id));
  if (l2) parts.push(l2 + (i.type === 'physical' && lagOf(model, i.device, i.id) !== undefined ? ` (from ${lagOf(model, i.device, i.id)})` : ''));
  if (i.members.length) parts.push('Member ports: ' + sortedByName(i.members, (x) => x).join(', '));
  const vlans = interfaceVlans(model, i);
  if (vlans.length) {
    parts.push(`VLAN ${vlans.join(', ')}`);
    const parent = subinterfaceParent(model, i);
    if (parent !== undefined) parts.push(`tagged on ${parent}`);
    else {
      const ports = bridgePortsText(model, i);
      parts.push(ports ? 'bridge ports: ' + ports : 'no bridge port in its VLAN');
    }
  }
  if (i.source) parts.push('Tunnel source: ' + i.source.text + (i.source.address !== undefined && i.source.iface ? ` (${i.source.iface})` : ''));
  if (i.destination) parts.push('Destination: ' + i.destination.text + (i.destination.address !== undefined && i.destination.device ? ` (${i.destination.device}${i.destination.iface ? ':' + i.destination.iface : ''})` : ''));
  return parts.join(' · ');
}

/**
 * A VLAN interface's bridge ports by mode, "Access: Gi1/0/1–10 · Trunk:
 * Gi1/0/48, Po1", each port (a run's first and last) a link to it; or
 * that it has none.
 */
export function bridgePortsNode(model: Model, i: Interface, link: (id: string) => VNode): VNode {
  const g = vlanPortsByMode(model, i);
  const groups: VNode[] = [];
  for (const [label, ids] of [['Access', g.access], ['Trunk', g.trunk]] as Array<[string, string[]]>) {
    if (!ids.length) continue;
    const runs: VNode[] = [];
    portRuns(ids).forEach((r, k) => {
      if (k) runs.push(h('span', {}, ', '));
      if (r.last !== undefined) runs.push(h('span', { class: 'port-run' }, [link(r.first), h('span', {}, '–'), link(r.last)]));
      else runs.push(link(r.first));
    });
    if (groups.length) groups.push(h('span', { class: 'muted' }, ' · '));
    groups.push(h('span', { 'data-mode': label.toLowerCase() }, [h('span', {}, label + ': '), ...runs]));
  }
  return groups.length ? h('span', { class: 'bridge-ports' }, groups) : h('span', { class: 'muted' }, 'none: no port of this device has its VLAN');
}

/** A tunnel end as details content: the text as written, linked when it is part of the model. */
function tunnelEndNode(model: Model, e: TunnelEnd): VNode {
  const ref = e.iface && e.device ? `iface:${e.device}:${e.iface}` : e.device ? 'device:' + e.device : '';
  const target = e.device ? (e.iface ? `${e.device}:${e.iface}` : e.device) : '';
  if (!ref) return h('span', {}, e.text);
  // written as an address: the interface that has the address is derived
  if (e.address !== undefined) return h('span', {}, [h('span', { class: 'ro' }, e.text + ' '), h('span', { class: 'muted' }, '→ '), refLink(ref, target)]);
  return refLink(ref, e.text);
}

/** Text for assistive technology: the state is also shown by markers and weight, not colour alone. */
export function contextNote(st: ContextState | null): VNode | null {
  if (!st) return null;
  return h('span', { class: 'sr-only' }, st === 'selected' ? ' (selected)' : st === 'related' ? ' (directly related)' : ' (not related)');
}

/** A port's mode badge in a port list ("Access · VLAN 10"; a member: its aggregate's, "from Po1"). */
function modeCell(model: Model, device: string, iface: string): VNode[] {
  const l2 = portL2(model, device, iface);
  const t = portBadgeText(l2);
  if (!l2 || !t) return [];
  return [h('span', { class: 'mode-badge mode-' + l2.kind, 'data-mode': l2.kind }, t), l2.lag !== undefined ? h('span', { class: 'muted' }, ` from ${l2.lag}`) : null].filter((x): x is VNode => !!x);
}

function list(title: string, items: VNode[]): VNode | null {
  if (!items.length) return null;
  return h('section', {}, [h('h4', {}, `${title} (${items.length})`), h('ul', { class: 'reflist' }, items)]);
}

/** The addresses of an interface as shown in the details: its manual addresses, or that DHCP provides them. */
function addressText(i: Interface, sep: string): string {
  return i.dhcp && !i.addresses.length ? 'DHCP' : i.addresses.join(sep);
}

/** Errors and warnings of the object a header is about (from the editor's validation). */
export interface IssueCount {
  errors: number;
  warnings: number;
}

/** The problem state of an object: "No problems", or how many errors and warnings it has. */
export function statusChip(kind: string, c: IssueCount): VNode {
  const state = c.errors ? 'error' : c.warnings ? 'warning' : 'ok';
  const parts: string[] = [];
  if (c.errors) parts.push(`${c.errors} error${c.errors > 1 ? 's' : ''}`);
  if (c.warnings) parts.push(`${c.warnings} warning${c.warnings > 1 ? 's' : ''}`);
  const text = parts.length ? parts.join(' · ') : 'No problems';
  return h('span', { class: 'ih-status ' + state, 'data-state': state, title: parts.length ? `This ${kind} has ${text}.` : `This ${kind} has no validation problems.` }, [
    iconNode(state),
    h('span', {}, text),
  ]);
}

/** How the header of an object names it: its kind, its name, and its ID (shown beside the name when they differ). */
export function headOf(model: Model, ref: string): { kind: string; title: string; id?: string } | null {
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  if (kind === 'device') {
    const d = ix.devices.get(id);
    return d ? { kind: 'device', title: d.label, id: d.id } : null;
  }
  if (kind === 'iface') {
    const i = ix.interfaces.get(id);
    return i ? { kind: 'interface', title: i.device + ' ' + i.id } : null;
  }
  if (kind === 'link') {
    const l = ix.links.get(id);
    return l ? { kind: 'physical link', title: l.label || l.id, id: l.id } : null;
  }
  if (kind === 'relation') {
    const r = ix.relations.get(id);
    return r ? { kind: r.category, title: relationTitle(model, r.id), id: r.id } : null;
  }
  if (kind === 'network') {
    const n = ix.networks.get(id);
    return n ? { kind: 'IP network', title: n.label, id: n.id } : null;
  }
  if (kind === 'group') {
    const g = ix.groups.get(id);
    return g ? { kind: g.kind || 'group', title: g.label, id: g.id } : null;
  }
  if (kind === 'protocol') {
    const p = model.protocols.get(id);
    return p ? { kind: 'protocol', title: p.label, id: p.id } : null;
  }
  if (kind === 'route') {
    const r = ix.routes.get(id);
    return r ? { kind: 'static route', title: `${r.device}: ${r.prefix}` + (r.name ? ` (${r.name})` : '') } : null;
  }
  return null;
}

/** The port at a link end in words: "Access · VLAN 10", "Trunk · 10, 20 (native 10)", "Routed" ('' for a host's port or no port). */
export function tagWords(model: Model, e: LinkEnd): string {
  const l = endL2(model, e);
  return l ? portBadgeText(l) + (l.lag !== undefined ? ` (from ${l.lag})` : '') : '';
}

/** A route's next hop in words: the address (and which interface has it), the exit interface, or "blackhole". */
function nextHopWords(model: Model, r: Route): string {
  if (r.blackhole) return 'blackhole (dropped)';
  const parts: string[] = [];
  if (r.via !== undefined) {
    const owners = addressOwners(model, r.via).map((o) => `${o.device}:${o.iface}`);
    parts.push(r.via + (owners.length ? ` (${owners.join(', ')})` : ''));
  }
  if (r.iface !== undefined) parts.push('out of ' + r.iface);
  return parts.join(' ');
}

/**
 * The header of a selected object, the same in Details and Edit: one row
 * with its type, its problem state and (in Edit) its actions, and below it
 * the object's name with its stable ID beside it when the two differ. The
 * ID is plain, selectable text, so it can be copied.
 */
export function objectHead(kind: string, title: string, id: string | undefined, status: IssueCount | null, actions: VNode | null = null): VNode {
  return h('div', { class: 'insp-head', 'data-kind': kind }, [
    h('div', { class: 'ih-row' }, [h('span', { class: 'badge', 'data-kind': kind }, kind), status ? statusChip(kind, status) : null, actions]),
    h('h3', {}, [h('span', { class: 'ih-name' }, title), id !== undefined && id !== title ? h('code', { class: 'ih-id', title: 'ID (stable identifier)' }, id) : null]),
  ]);
}



/** DNS names of its device that are associated with an interface, alphabetically. */
function dnsOf(model: Model, i: Interface): string[] {
  const d = model.index.devices.get(i.device);
  return d ? sortedByName(d.dnsNames.filter((x) => x.interfaces.indexOf(i.id) >= 0).map((x) => x.name), (x) => x) : [];
}

/** Details for the selected entity. */
export function detailsFor(model: Model, ref: string, status: IssueCount | null = null): VNode {
  const header = (): VNode => {
    const x = headOf(model, ref) || { kind, title: id };
    return objectHead(x.kind, x.title, x.id, status);
  };
  const [kind, id] = splitRef(ref);
  const ix = model.index;
  const kids: Array<VNode | null> = [];
  if (kind === 'device') {
    const d = ix.devices.get(id);
    if (!d) return h('div', {}, 'Not found');
    kids.push(header());
    kids.push(
      kv([
        ['type', deviceTypeLine(d) || deviceKindLabel(d) || undefined],
        ['role', d.role ? roleLabel(d.role) : undefined],
        ['group', d.group ? refLink('group:' + d.group, ix.groups.get(d.group)?.label || d.group) : undefined],
        ['port pairs', d.portPairs.length ? d.portPairs.map((p) => `${p.a} ${p.direction === 'a_to_b' ? '→' : '↔'} ${p.b}${p.copy.length ? ' (copy to ' + p.copy.join(', ') + ')' : ''}`).join('; ') : undefined],
        ['management', d.management.length ? d.management.join(', ') + ' (never forwarded)' : undefined],
        ['VPN', d.vpn ? vpnSummary(d.vpn) : undefined],
        ['protocols', d.services.length ? d.services.map((s) => (model.services.get(s.id) || { label: s.id }).label).join(', ') : undefined],
        ...identityLines(d, model.services).map((x): [string, string] => ['identity', x.line]),
        ['description', d.description],
      ]),
    );
    // a Security gateway's policy, in words: implementation, domains, directions, the rules in order, the default deny
    if (d.separation) kids.push(h('section', { 'data-list': 'separation' }, [h('h4', {}, 'Domain separation'), h('ul', { class: 'sep-summary' }, separationSummary(d).map((x) => h('li', {}, x)))]));
    // display order is alphabetical; the file order is not changed by viewing
    const phys = sortedByName(d.interfaces, (x) => x.id);
    if (phys.length) {
      kids.push(
        h('section', { 'data-list': 'interfaces' }, [
          h('h4', {}, `Physical interfaces (${phys.length}, ${phys.filter((i) => ix.ifaceLink.has(ifaceKey(d.id, i.id))).length} cabled)`),
          h('table', { class: 'ports' }, [
            h('tr', {}, [h('th', {}, 'port'), h('th', { title: 'Access (one VLAN), trunk (several) or routed' }, 'mode'), h('th', {}, 'address'), h('th', { title: 'Derived from the network containing the address' }, 'vlan'), h('th', {}, 'cable')]),
            ...phys.map((i) => {
              const lid = ix.ifaceLink.get(ifaceKey(d.id, i.id));
              const l = lid ? ix.links.get(lid) : undefined;
              const peer = l ? (l.a.device === d.id && l.a.iface === i.id ? l.b : l.a) : undefined;
              return h('tr', { class: l ? '' : 'unused', 'data-iface': i.id, 'data-kind': i.type }, [
                h('td', {}, [refLink(`iface:${d.id}:${i.id}`, i.id)]),
                h('td', {}, modeCell(model, d.id, i.id)),
                h('td', {}, addressText(i, ', ')),
                h('td', {}, interfaceVlanText(interfaceAddresses(model, d.id, i.id)).replace(/VLAN /g, '')),
                h('td', {}, peer ? [refLink('link:' + (lid as string), '→ ' + endpointText(peer))] : []),
              ]);
            }),
          ]),
        ]),
      );
    }
    const logical = sortedByName(d.logical, (x) => x.id);
    if (logical.length) {
      kids.push(
        h('section', { 'data-list': 'logical' }, [
          h('h4', {}, `Logical interfaces (${logical.length})`),
          h('table', { class: 'ports' }, [
            h('tr', {}, [h('th', {}, 'interface'), h('th', {}, 'type'), h('th', {}, 'address'), h('th', { title: 'Member ports, VLAN and the ports carrying it, tunnel source and destination' }, 'associated with')]),
            ...logical.map((i) =>
              h('tr', { 'data-iface': i.id, 'data-kind': i.type }, [
                h('td', {}, [refLink(`iface:${d.id}:${i.id}`, i.id), i.label ? h('span', { class: 'muted' }, ' ' + i.label) : null]),
                h('td', {}, interfaceKindLabel(i.type)),
                h('td', {}, addressText(i, '\n')),
                h('td', { 'data-assoc': '' }, associationText(model, i)),
              ]),
            ),
          ]),
        ]),
      );
    }
    // DNS names: each configured once, with the interfaces it is associated with (not with an address)
    const names = sortedByName(d.dnsNames, (x) => x.name);
    if (names.length) {
      kids.push(
        h('section', { 'data-list': 'dns-names' }, [
          h('h4', {}, `DNS names (${names.length})`),
          h('table', { class: 'ports' }, [
            h('tr', {}, [h('th', {}, 'name'), h('th', { title: 'The name is associated with these interfaces, not with one particular address' }, 'interfaces')]),
            ...names.map((x) =>
              h('tr', { 'data-dns': x.name }, [
                h('td', {}, x.name),
                h('td', {}, sortedByName(x.interfaces, (y) => y).reduce((acc: VNode[], y, k) => acc.concat(k ? [h('span', {}, ', '), refLink(`iface:${d.id}:${y}`, y)] : [refLink(`iface:${d.id}:${y}`, y)]), [])),
              ]),
            ),
          ]),
          h('p', { class: 'muted small' }, 'Configured names only: no DNS record is derived from them.'),
        ]),
      );
    }
    // static routes, in display order (VRF, destination, distance …), each selectable
    const routes = d.routes.slice().sort(compareRoutes);
    if (routes.length) {
      kids.push(
        h('section', { 'data-list': 'routes' }, [
          h('h4', {}, `Static routes (${routes.length})`),
          h('table', { class: 'ports' }, [
            h('tr', {}, [h('th', {}, 'destination'), h('th', {}, 'next hop'), h('th', { title: 'Administrative distance (route selection takes a missing one as 1)' }, 'AD'), h('th', {}, 'VRF')]),
            ...routes.map((r) =>
              h('tr', { 'data-route': String(r.index) }, [
                h('td', {}, [refLink(routeRefOf(r), r.prefix), r.name ? h('span', { class: 'muted' }, ' ' + r.name) : null]),
                h('td', {}, nextHopWords(model, r)),
                h('td', {}, r.distance !== undefined ? String(r.distance) : ''),
                h('td', {}, r.vrf || ''),
              ]),
            ),
          ]),
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
    kids.push(header());
    kids.push(
      kv([
        ['device', refLink('device:' + i.device, ix.devices.get(i.device)?.label || i.device)],
        ['label', i.label],
        ['type', interfaceKindLabel(i.type)],
        ['addresses', i.dhcp && !i.addresses.length ? 'obtained by DHCP (not known, so in no network)' : i.addresses.join(', ')],
        ['DNS names', dnsOf(model, i).join(', ') || undefined],
        ['vrf', i.vrf],
        ['mac', i.mac],
        ['MTU', i.mtu !== undefined ? String(i.mtu) : undefined],
        ['minimum links', i.minLinks !== undefined ? String(i.minLinks) : undefined],
        ['cable', i.type !== 'physical' ? undefined : lid ? refLink('link:' + lid, lid) : 'not cabled'],
        ['description', i.description],
      ]),
    );
    const assocs = interfaceAddresses(model, i.device, i.id);
    if (assocs.length) kids.push(h('section', {}, [h('h4', {}, 'Network / VLAN (derived from the addresses)'), derivedAddressList(model, assocs)]));
    const ifLink = (x: string): VNode => refLink(`iface:${i.device}:${x}`, x);
    const linked = (ids: string[]): VNode => h('span', {}, ids.reduce((acc: VNode[], x, k) => acc.concat(k ? [h('span', {}, ', '), ifLink(x)] : [ifLink(x)]), []));
    const vlans = interfaceVlans(model, i);
    const parent = subinterfaceParent(model, i);
    const l2 = portL2(model, i.device, i.id);
    const lag = i.type === 'physical' ? lagOf(model, i.device, i.id) : undefined;
    // only the associations that apply to this interface are shown
    kids.push(
      h('section', { 'data-assoc': i.type }, [
        kv([
          ['VLANs', l2 && portBadgeText(l2) ? h('span', {}, [h('span', { class: 'mode-badge mode-' + l2.kind }, portBadgeText(l2)), lag !== undefined ? h('span', { class: 'muted' }, [h('span', {}, ' of the aggregate '), ifLink(lag)]) : null]) : undefined],
          ['member ports', i.members.length ? linked(sortedByName(i.members, (x) => x)) : undefined],
          ['VLAN', vlans.length ? vlans.join(', ') + (i.vlan === undefined ? ' (from the network of its address)' : '') : undefined],
          ['subinterface of', parent !== undefined ? h('span', {}, [ifLink(parent), h('span', { class: 'muted' }, ` (VLAN ${vlans.join(', ')} tagged)`)]) : undefined],
          ['bridge ports', vlans.length && parent === undefined ? bridgePortsNode(model, i, ifLink) : undefined],
          ['tunnel source', i.source ? tunnelEndNode(model, i.source) : undefined],
          ['tunnel destination', i.destination ? tunnelEndNode(model, i.destination) : undefined],
        ]),
        vlans.length && parent === undefined ? h('p', { class: 'muted small' }, 'Derived: every port of this device whose VLANs include its VLAN.') : null,
      ]),
    );
    // the other direction: aggregates this port is a member of, VLAN interfaces whose VLAN it carries, tunnels sourced from it
    const d = ix.devices.get(i.device);
    // (a member port serves the VLAN interfaces of its aggregate's VLANs through it)
    const viaLag = i.type === 'physical' ? lagOf(model, i.device, i.id) : undefined;
    const bridges = (o: Interface): boolean => interfaceVlanPorts(model, o).some((p) => p.iface === i.id || (viaLag !== undefined && p.iface === viaLag));
    const users = d ? d.logical.filter((o) => o.id !== i.id && (o.members.indexOf(i.id) >= 0 || (!!o.source && o.source.iface === i.id) || bridges(o))) : [];
    kids.push(
      list(
        'Used by logical interfaces',
        sortedByName(users, (o) => o.id).map((o) =>
          h('li', { 'data-iface': o.id }, [
            refLink(`iface:${i.device}:${o.id}`, o.id),
            h('span', { class: 'muted' }, ' ' + (o.members.indexOf(i.id) >= 0 ? 'aggregate (member port)' : o.source && o.source.iface === i.id ? 'tunnel (source)' : subinterfaceParent(model, o) === i.id ? 'subinterface (its VLAN tagged here)' : `bridge port of its VLAN${viaLag !== undefined && !interfaceVlanPorts(model, o).some((p) => p.iface === i.id) ? `, through ${viaLag}` : ''}`)),
          ]),
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
    kids.push(
      list(
        'Static routes using it',
        routesUsing(model, i.device, i.id)
          .sort(compareRoutes)
          .map((r) => h('li', {}, [refLink(routeRefOf(r), `${r.device}: ${routeLine(r)}`), h('span', { class: 'muted' }, r.device === i.device && r.iface === i.id ? ' (exit interface)' : ' (next hop)')])),
      ),
    );
    kids.push(attrsTable('Attributes', i.attrs));
  } else if (kind === 'link') {
    const l = ix.links.get(id);
    if (!l) return h('div', {}, 'Not found');
    kids.push(header());
    const nets = (ids: string[]): VNode[] => ids.reduce((acc: VNode[], n, k) => acc.concat(k ? [h('span', {}, ', '), refLink('network:' + n, networkName(model, n))] : [refLink('network:' + n, networkName(model, n))]), []);
    // an end: where it plugs in, its port's VLANs, and the networks of the VLANs it carries (derived)
    const ep = (e: LinkEnd): VNode => {
      const carried = endNetworks(model, e);
      const port = [e.speed, e.duplex ? e.duplex + ' duplex' : ''].filter((x) => !!x).join(', ');
      const tag = [port, tagWords(model, e)].filter((x) => !!x).join('; ');
      return h('span', {}, [
        refLink('device:' + e.device, ix.devices.get(e.device)?.label || e.device),
        e.iface ? h('span', {}, ' ') : null,
        e.iface ? refLink(`iface:${e.device}:${e.iface}`, e.iface) : null,
        h('span', { class: tag ? 'tag-end' : 'tag-end muted' }, tag ? ' — ' + tag : ' — no VLANs'),
        carried.length ? h('span', { class: 'muted' }, ' · carries ') : null,
        ...nets(carried),
      ]);
    };
    const mm = tagMismatch(model, l);
    kids.push(
      kv([
        ['A', ep(l.a)],
        ['B', ep(l.b)],
        ['VLANs', mm ? h('span', { class: 'warn-text', 'data-tag-mismatch': 'yes' }, '⚠ the ends differ — ' + tagMismatchText(mm)) : undefined],
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
    kids.push(header());
    kids.push(
      kv([
        ['protocol', def.label + (def.label.toLowerCase() !== r.protocol ? ` (${r.protocol})` : '')],
        ['category', r.category],
        ['direction', r.direction === 'unidirectional' ? 'unidirectional (first → last endpoint)' : 'bidirectional'],
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
    kids.push(header());
    kids.push(kv([['IP network', n.cidr || 'missing or invalid'], ['vlan', n.vlan !== undefined ? String(n.vlan) : undefined], ['description', n.description]]));
    // derived: every device with a configured address inside the network's prefix, once
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
          .filter((r) => r.over.indexOf(n.id) >= 0)
          .map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))])),
      ),
    );
    // derived from the tagging of the link ends: the cable ends that carry its VLAN (not membership)
    kids.push(
      list(
        'Carried on cables',
        model.links
          .filter((l) => endNetworks(model, l.a).indexOf(n.id) >= 0 || endNetworks(model, l.b).indexOf(n.id) >= 0)
          .map((l) => {
            const ends = [endNetworks(model, l.a).indexOf(n.id) >= 0 ? 'A' : '', endNetworks(model, l.b).indexOf(n.id) >= 0 ? 'B' : ''].filter((x) => x);
            return h('li', { 'data-link': l.id }, [refLink('link:' + l.id, l.label || l.id), h('span', { class: 'muted' }, ` ${endpointText(l.a)} ⟷ ${endpointText(l.b)}` + (ends.length < 2 ? ` (end ${ends[0]} only)` : ''))]);
          }),
      ),
    );
    kids.push(attrsTable('Attributes', n.attrs));
  } else if (kind === 'group') {
    const g = ix.groups.get(id);
    if (!g) return h('div', {}, 'Not found');
    kids.push(header());
    kids.push(kv([['kind', g.kind], ['parent', g.parent ? refLink('group:' + g.parent, ix.groups.get(g.parent)?.label || g.parent) : undefined], ['description', g.description]]));
    kids.push(list('Sub-groups', model.groups.filter((c) => c.parent === g.id).map((c) => h('li', {}, [refLink('group:' + c.id, c.label)]))));
    kids.push(list('Devices', model.devices.filter((d) => d.group === g.id).map((d) => h('li', {}, [refLink('device:' + d.id, d.label)]))));
    kids.push(attrsTable('Attributes', g.attrs));
  } else if (kind === 'protocol') {
    const p = model.protocols.get(id);
    if (!p) return h('div', {}, 'Not found');
    kids.push(header());
    kids.push(kv([['category', p.category], ['description', p.description]]));
    kids.push(list('Relations', model.relations.filter((r) => r.protocol === id).map((r) => h('li', {}, [refLink('relation:' + r.id, relationTitle(model, r.id))]))));
  } else if (kind === 'route') {
    const r = ix.routes.get(id);
    if (!r) return h('div', {}, 'Not found');
    kids.push(header());
    const res = resolveRoute(model, r);
    kids.push(
      kv([
        ['device', refLink('device:' + r.device, ix.devices.get(r.device)?.label || r.device)],
        ['destination', r.prefix],
        ['next hop', r.blackhole ? 'blackhole: traffic to the destination is dropped' : r.via],
        ['exit interface', r.iface !== undefined ? refLink(`iface:${r.device}:${r.iface}`, r.iface) : undefined],
        ['distance', r.distance !== undefined ? String(r.distance) : `not written (route selection takes ${DEFAULT_STATIC_DISTANCE})`],
        ['metric', r.metric !== undefined ? String(r.metric) : undefined],
        ['VRF', r.vrf || 'the default table'],
        ['name', r.name],
        ['description', r.description],
      ]),
    );
    const owners = r.via !== undefined ? addressOwners(model, r.via) : [];
    kids.push(list('Next-hop address belongs to', owners.map((o) => h('li', {}, [refLink(`iface:${o.device}:${o.iface}`, `${o.device} ${o.iface}`)]))));
    kids.push(
      h('section', { 'data-resolution': res.ok ? 'ok' : res.reason }, [
        h('h4', {}, 'Resolution'),
        h(
          'p',
          { class: res.ok ? '' : r.blackhole ? 'muted' : 'warn-text' },
          res.ok ? 'Leaves through ' + res.hops.map((x) => x.iface + (x.gateway ? ' to ' + formatAddr(x.gateway) : '')).join(', ') + (res.recursive ? ' (resolved through another route)' : '') : r.blackhole ? 'A blackhole route: nothing is forwarded.' : 'Not usable: ' + res.detail + '.',
        ),
      ]),
    );
    kids.push(attrsTable('Attributes', r.attrs));
  } else {
    return h('div', {}, 'Nothing selected');
  }
  return h('div', { class: 'details' }, kids.map((k, i) => (i === 0 || !k ? k : card(k))));
}

/**
 * The sections of the Details tab as cards, like the field groups of the
 * Edit tab: a section keeps its title; the overview table of an object gets
 * the title "Overview", the untitled associations of an interface
 * "Associations". A section with nothing in it is left out.
 */
function card(v: VNode): VNode | null {
  if (v.tag === 'table') return h('section', { class: 'fgroup', 'data-group': 'overview' }, [h('h4', { class: 'fgroup-title' }, 'Overview'), v]);
  if (v.tag !== 'section') return v;
  const children = v.children.map((c) => (c.tag === 'h4' ? { ...c, attrs: { ...c.attrs, class: 'fgroup-title' } } : c));
  const titled = children.some((c) => c.tag === 'h4');
  if (!titled && children.every((c) => c.tag === 'table' && !c.children.length)) return null;
  return { ...v, attrs: { ...v.attrs, class: ((v.attrs.class || '') + ' fgroup').trim(), 'data-group': v.attrs['data-group'] || (titled ? '' : 'more') }, children: titled ? children : [h('h4', { class: 'fgroup-title' }, 'Associations'), ...children] };
}

export function relationTitle(model: Model, id: string): string {
  const r = model.index.relations.get(id);
  if (!r) return id;
  const def = relationStyle(model, r);
  const devs = relationDevices(r).map((d) => model.index.devices.get(d)?.label || d);
  const pair = devs.length <= 3 ? devs.join(r.direction === 'unidirectional' ? ' → ' : ' ↔ ') : `${devs.length} devices`;
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
    return [
      d.label,
      deviceKindLabel(d),
      `${d.interfaces.length} physical interface${d.interfaces.length === 1 ? '' : 's'}, ${cabled} cabled`,
      d.logical.length ? `${d.logical.length} logical interface${d.logical.length === 1 ? '' : 's'}` : '',
      d.routes.length ? `${d.routes.length} static route${d.routes.length === 1 ? '' : 's'}` : '',
    ].filter((s) => s);
  }
  if (kind === 'route') {
    const r = ix.routes.get(id);
    if (!r) return [];
    return [`${r.device}: ${routeLine(r)}`, r.name || '', r.vrf ? 'VRF ' + r.vrf : '', nextHopWords(model, r)].filter((s) => s);
  }
  if (kind === 'iface') {
    const i = ix.interfaces.get(id);
    if (!i) return [];
    const used = i.type === 'physical' ? associatedInterfaces(model, i) : [];
    return [`${i.device} ${i.id}`, interfaceKindLabel(i.type), associationText(model, i), used.length ? 'used by ' + sortedByName(used, (x) => x).join(', ') : '', addressText(i, ', '), dnsOf(model, i).join(', '), interfaceVlanText(interfaceAddresses(model, i.device, i.id)), i.description || ''].filter((s) => s);
  }
  if (kind === 'link') {
    const l = ix.links.get(id);
    if (!l) return [];
    const carried = model.relations.filter((r) => r.over.indexOf(l.id) >= 0).length;
    return [
      `${endpointText(l.a)}  ⟷  ${endpointText(l.b)}`,
      [mediumStyle(l.medium).label, l.speed, l.label, l.cable].filter((s) => s).join(' · '),
      tagWords(model, l.a) || tagWords(model, l.b) ? `A: ${tagWords(model, l.a) || 'no VLANs'}  |  B: ${tagWords(model, l.b) || 'no VLANs'}` : '',
      tagMismatch(model, l) ? '⚠ VLANs differ: ' + tagMismatchText(tagMismatch(model, l) as NonNullable<ReturnType<typeof tagMismatch>>) : '',
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
    return [n.label, [n.vlan !== undefined ? 'VLAN ' + n.vlan : '', n.cidr || ''].filter((s) => s).join(' · '), `${count} member${count === 1 ? '' : 's'}`].filter((s) => s);
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

/** While a simulation runs: what the devices' lifecycle badges say (sim-controller.ts draws them); with PTP clocks, their marks. */
function simStateSection(model?: Model): LegendSection {
  // (the swatch: the indicator's LED only; its word is the row's label)
  // a snooping badge: its sign and a word, in the role's style
  const snoopSwatch = (role: string, sign: string, word: string, none = false): VNode[] => [h('g', { class: 'sim-snoop-vlan', 'data-role': role, 'data-querier': none ? 'none' : 'heard' }, [h('rect', { x: 1, y: 2, width: 62, height: 14, rx: 3 }), h('text', { class: 'sim-snoop-icon', x: 4, y: 12.5 }, sign), h('text', { x: 14, y: 12.5 }, word)])];
  const led = (state: string): VNode[] => [h('g', { class: 'sim-power', 'data-power': state }, [h('rect', { x: 3, y: 2, width: 18, height: 14, rx: 7 }), h('circle', { class: 'sim-led', cx: 12, cy: 9, r: 3.5 })])];
  return {
    title: 'Simulation: device status',
    items: [
      { swatch: led('operational'), label: 'Operational (green): powered on and booted' },
      { swatch: led('off'), label: 'Powered off (red): or down with its host or its container engine; it takes no part' },
      { swatch: led('booting'), label: 'Booting (blue): powered on, it takes part when its boot time is over' },
      { swatch: led('passive'), label: 'Passive or External (hollow grey): a patch panel, a TAP, an external network — no power state of its own' },
      { swatch: [h('g', { class: 'sim-querier', 'data-role': 'querier' }, [h('rect', { x: 1, y: 2, width: 40, height: 14, rx: 3 }), h('text', { x: 5, y: 12.5 }, 'Querier')])], label: 'A router: Querier · VLAN 10 — the elected IGMP / MLD querier of that LAN (the election’s, not the configuration’s); dashed “Querier (startup)”: still sending its startup queries; grey “Standby”: a candidate that yields to another querier' },
      { swatch: snoopSwatch('querier', '★', 'Querier'), label: 'A snooping switch: one badge per VLAN with snooping enabled, in VLAN order. ★ VLAN 10 · Querier: it is that VLAN’s elected querier (dashed ☆ Querier (startup): its startup queries)' },
      { swatch: snoopSwatch('standby', '◇', 'Standby'), label: '◇ VLAN 20 · Standby: a querier candidate that yields to another querier there' },
      { swatch: snoopSwatch('snooping', '○', 'Snooping'), label: '○ VLAN 30 · Snooping · querier heard: no candidate itself, a querier queries the VLAN (behind a multicast router port)' },
      { swatch: snoopSwatch('snooping', '○', 'No querier', true), label: '○ VLAN 40 · Snooping · no querier (grey, dashed): nobody queries the VLAN, so no router port is learned there and a member’s report stays at the switch it reached; ✕ Candidate down, ⏻ Off or Booting: the switch is powered off or still booting' },
      ...(model && model.devices.some((d) => !!d.appServices && d.appServices.has('ptp')) ? ptpLegend() : []),
    ],
    note: 'Every device has its indicator on its box’s edge while the simulation runs. Only the device itself counts: a shut interface, a cable down, a peer away or a blocked packet never mark a device off, and operational says nothing about its interfaces, services or destinations. The indicator’s tooltip and the device’s menu say the state with its time.',
  };
}

/** The PTP clocks' marks: the clocks' own state (the election's and the servo's), never a guarantee of accuracy. */
function ptpLegend(): LegendItem[] {
  const mark = (state: string, text: string): VNode[] => [h('g', { class: 'sim-ptp', 'data-state': state }, [h('rect', { x: 1, y: 2, width: 62, height: 14, rx: 3 }), h('text', { x: 5, y: 12.5 }, text)])];
  return [
    { swatch: mark('grandmaster', '★ PTP · GM'), label: 'PTP · Grandmaster: the time source the best master clock algorithm elected in its domain (from the Announces it hears; its own clock, not verified against a reference)' },
    { swatch: mark('synchronized', '✓ PTP · Sync'), label: 'PTP · Synchronized: three offsets in a row below 1 µs (hardware timestamps) or 100 µs (software) — this model’s rule, not a guaranteed accuracy' },
    { swatch: mark('acquiring', 'PTP · Acq.'), label: 'PTP · Acquiring (dashed): a master chosen, its servo not locked yet; Listening: no master heard yet' },
    { swatch: mark('holdover', '✕ PTP · Hold'), label: 'PTP · Holdover or Unsynchronized (dotted): no Sync, or no master; its clock runs free from its last correction (holdover quality is not modelled)' },
    { swatch: mark('transparent', 'PTP · TC'), label: 'PTP · Transparent clock: a switch that corrects the residence time of what it forwards; no time source' },
  ];
}

export function legendFor(model: Model, view: View, hidden: Set<string>, simulation = false): VNode {
  const legend = legendOf(model, view);
  if (simulation) legend.sections.unshift(simStateSection(model));
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

/** A VPN gateway configuration in words: "site to site, IPsec (IKEv2): tunnels st0; protects 10.1.0.0/16". */
function vpnSummary(v: VpnService): string {
  const op = VPN_OPERATIONS.find((x) => x.id === v.operation);
  const tech = VPN_TECHNOLOGIES.find((x) => x.id === v.technology);
  const how = v.operation === 'site_to_site' ? `tunnels ${v.tunnels.join(', ') || '(none)'}` : v.operation === 'remote_access' ? `clients at ${v.listener || '?'}, pool ${v.pool || '?'}` : '';
  return [[op ? op.label.toLowerCase() : 'operation not set', tech ? tech.label : 'technology not set'].join(', '), how, v.protected.length ? 'protects ' + v.protected.join(', ') : ''].filter((x) => !!x).join('; ');
}

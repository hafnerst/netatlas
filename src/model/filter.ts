/**
 * Device filter: the part of a model that a diagram shows when only some
 * devices are selected. The result is a new, self-consistent Model (its own
 * index, no reference to anything left out), so the renderers, the legend,
 * the networks overview and the export work on it unchanged. The model that
 * is filtered is never modified, and the result carries no stored positions:
 * a filtered diagram is always arranged from scratch (see diagram/session.ts).
 *
 * Relevance rules (the same for the screen and for exports):
 *
 *   devices    the selected ones (unknown ids are ignored), in file order.
 *   interfaces all interfaces of the included devices. A tunnel destination
 *              on a left-out device keeps its text but no longer points at
 *              that device.
 *   links      only links whose two ends are on included devices; a cable to
 *              a left-out device is not drawn at all (no dangling stub).
 *   relations  only relations whose every endpoint device is included. A
 *              relation that also reaches a left-out device is left out
 *              entirely, never drawn as if it were complete.
 *              `over` keeps only included links, relations and networks;
 *              `network` is kept only if that network is included.
 *   networks   physical view: a network with at least one included member,
 *              or whose VLAN is permitted on an end of an included link.
 *              logical view: a network with at least one included member, or
 *              named by an included relation (`network` or `over`).
 *              Membership is derived again from the included devices'
 *              addresses, so a network with members on both sides shows only
 *              its included members.
 *   groups     a group that contains an included device, directly or through
 *              a child group, with its parent chain. A group with members on
 *              both sides contains only its included devices.
 *   protocols  a protocol is relevant when an included relation uses it: the
 *              legend, its protocol toggles and the exported legend list
 *              exactly those. (The registry itself is kept whole, so styles
 *              resolve as in the full model.) Protocols have no device of
 *              their own; this is the only reference they have.
 */
import { derive } from './derive';
import { Device, Group, Interface, Link, Model, ModelIndex, Network, Relation, ifaceKey, relationDevices } from './types';

export type FilterView = 'physical' | 'logical';

/** Device ids of a model, in file order. */
export function allDeviceIds(model: Model): string[] {
  return model.devices.map((d) => d.id);
}

/** Does `ids` select every device of the model (the unfiltered view)? */
export function selectsAll(model: Model, ids: Set<string>): boolean {
  return model.devices.every((d) => ids.has(d.id));
}

export function filterModel(model: Model, ids: Set<string>, view: FilterView): Model {
  const ix = model.index;
  const devices: Device[] = model.devices
    .filter((d) => ids.has(d.id))
    .map((d) => {
      const fix = (i: Interface): Interface =>
        i.destination && i.destination.device !== undefined && !ids.has(i.destination.device) ? { ...i, destination: { text: i.destination.text, address: i.destination.address } } : i;
      return { ...d, interfaces: d.interfaces.map(fix), logical: d.logical.map(fix) };
    });
  const devIds = new Set(devices.map((d) => d.id));

  const links: Link[] = model.links.filter((l) => devIds.has(l.a.device) && devIds.has(l.b.device));
  const linkIds = new Set(links.map((l) => l.id));
  const rels0 = model.relations.filter((r) => relationDevices(r).every((d) => devIds.has(d)));
  const relIds = new Set(rels0.map((r) => r.id));

  // networks: membership is decided by the included devices' addresses only
  const draft: Model = { ...model, devices, links, relations: [], networks: model.networks, groups: [], index: indexOf(devices, links, model.networks, [], []), layout: emptyLayout() };
  const members = derive(draft).members;
  const netIds = new Set<string>();
  for (const n of model.networks) {
    if ((members.get(n.id) || []).length) netIds.add(n.id);
    else if (view === 'physical' && n.vlan !== undefined && links.some((l) => l.a.vlans.indexOf(n.vlan as number) >= 0 || l.b.vlans.indexOf(n.vlan as number) >= 0)) netIds.add(n.id);
  }
  if (view === 'logical') {
    for (const r of rels0) {
      if (r.network !== undefined && ix.networks.has(r.network)) netIds.add(r.network);
      for (const o of r.over) if (ix.networks.has(o)) netIds.add(o);
    }
  }
  const networks: Network[] = model.networks.filter((n) => netIds.has(n.id));
  const relations: Relation[] = rels0.map((r) => ({
    ...r,
    over: r.over.filter((o) => linkIds.has(o) || relIds.has(o) || netIds.has(o)),
    network: r.network !== undefined && netIds.has(r.network) ? r.network : undefined,
  }));

  // groups: those holding an included device, with their parents
  const keep = new Set<string>();
  for (const d of devices) {
    const seen = new Set<string>();
    let g = d.group !== undefined ? ix.groups.get(d.group) : undefined;
    while (g && !seen.has(g.id)) {
      seen.add(g.id);
      keep.add(g.id);
      g = g.parent !== undefined ? ix.groups.get(g.parent) : undefined;
    }
  }
  const groups: Group[] = model.groups.filter((g) => keep.has(g.id));

  return {
    ...model,
    devices,
    links,
    networks,
    relations,
    groups,
    layout: emptyLayout(),
    index: indexOf(devices, links, networks, relations, groups),
  };
}

function emptyLayout(): Model['layout'] {
  return { physical: new Map(), logical: new Map(), manual: { physical: new Set(), logical: new Set() } };
}

function indexOf(devices: Device[], links: Link[], networks: Network[], relations: Relation[], groups: Group[]): ModelIndex {
  const interfaces = new Map<string, Interface>();
  for (const d of devices) for (const i of d.interfaces.concat(d.logical)) interfaces.set(ifaceKey(d.id, i.id), i);
  const ifaceLink = new Map<string, string>();
  for (const l of links) {
    if (l.a.iface !== undefined) ifaceLink.set(ifaceKey(l.a.device, l.a.iface), l.id);
    if (l.b.iface !== undefined) ifaceLink.set(ifaceKey(l.b.device, l.b.iface), l.id);
  }
  return {
    groups: new Map(groups.map((g) => [g.id, g] as [string, Group])),
    devices: new Map(devices.map((d) => [d.id, d] as [string, Device])),
    interfaces,
    links: new Map(links.map((l) => [l.id, l] as [string, Link])),
    networks: new Map(networks.map((n) => [n.id, n] as [string, Network])),
    relations: new Map(relations.map((r) => [r.id, r] as [string, Relation])),
    ifaceLink,
  };
}

/**
 * Collapsed groups: what a diagram draws when a group (a site, a room, a
 * rack) is shown as one box. Like the device filter (model/filter.ts), the
 * result is a new, self-consistent Model that the renderers draw unchanged;
 * the model itself is never modified, and nothing of it is lost: the box
 * stands for its devices, and every connection that leaves the group stays
 * drawn — to the box.
 *
 *   the box      one device (type System) per collapsed group that is not
 *                inside another collapsed group, its id COLLAPSED + the
 *                group's id (no model id can start so), labelled with the
 *                group and its number of devices, in the group's parent;
 *   boundary     a cable between a device inside and one outside ends on
 *                the box, at a port named after the inside end (sw-p1) that
 *                keeps that end's VLANs; a relation with an endpoint inside
 *                and one outside has that endpoint on the box;
 *   inside       the cables and relations between the group's own devices
 *                are not drawn (they are counted in the box's label);
 *   networks     a network with a member inside has the box as a member
 *                (one address port per network).
 */
import { Device, Group, Interface, Link, Model, ModelIndex, Relation, ifaceKey, relationDevices, routeKey } from './types';
import { derive } from './derive';

/** The id prefix of a collapsed group's box ("⊞site"): not an id character, so never a device of the model. */
export const COLLAPSED = '⊞';

/** The group a device id of a collapsed view stands for, or null. */
export function collapsedGroup(id: string): string | null {
  return id.indexOf(COLLAPSED) === 0 ? id.slice(COLLAPSED.length) : null;
}

/** The groups of a model under a group (itself included). */
export function groupTree(model: Model, group: string): Set<string> {
  const out = new Set<string>([group]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of model.groups)
      if (g.parent !== undefined && out.has(g.parent) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
  }
  return out;
}

/** The collapsed group that hides a device (the outermost), or null. */
export function hidingGroup(model: Model, device: string, collapsed: Set<string>): string | null {
  const d = model.index.devices.get(device);
  let g = d && d.group !== undefined ? model.index.groups.get(d.group) : undefined;
  let found: string | null = null;
  const seen = new Set<string>();
  while (g && !seen.has(g.id)) {
    seen.add(g.id);
    if (collapsed.has(g.id)) found = g.id;
    g = g.parent !== undefined ? model.index.groups.get(g.parent) : undefined;
  }
  return found;
}

export function collapseGroups(model: Model, collapsed: Set<string>): Model {
  if (!collapsed.size) return model;
  // each device: the box that stands for it (the outermost collapsed group), or itself
  const boxOf = new Map<string, string>();
  const inside = new Map<string, string[]>();
  for (const d of model.devices) {
    const g = hidingGroup(model, d.id, collapsed);
    if (g === null) continue;
    boxOf.set(d.id, COLLAPSED + g);
    inside.set(g, (inside.get(g) || []).concat([d.id]));
  }
  if (!boxOf.size) return model;
  const to = (dev: string): string => boxOf.get(dev) || dev;
  const ports = new Map<string, Interface[]>();
  const portFor = (box: string, dev: string, iface: string | undefined): string | undefined => {
    if (iface === undefined) return undefined;
    const list = ports.get(box) || [];
    const id = `${dev}-${iface}`.replace(/[^A-Za-z0-9_.\-/]/g, '_');
    if (!list.some((x) => x.id === id)) {
      const i = model.index.interfaces.get(ifaceKey(dev, iface));
      list.push(i ? { ...i, id, addresses: [], label: `${dev}:${iface}` } as Interface : ({ id, addresses: [] } as unknown as Interface));
      ports.set(box, list);
    }
    return id;
  };
  const counted = new Map<string, number>();
  const links: Link[] = [];
  for (const l of model.links) {
    const a = to(l.a.device);
    const b = to(l.b.device);
    if (a === b && a !== l.a.device) {
      counted.set(a, (counted.get(a) || 0) + 1);
      continue;
    }
    if (a === l.a.device && b === l.b.device) {
      links.push(l);
      continue;
    }
    links.push({ ...l, a: a === l.a.device ? l.a : { ...l.a, device: a, iface: portFor(a, l.a.device, l.a.iface) }, b: b === l.b.device ? l.b : { ...l.b, device: b, iface: portFor(b, l.b.device, l.b.iface) } });
  }
  const relations: Relation[] = [];
  for (const r of model.relations) {
    const ds = relationDevices(r);
    const mapped = new Set(ds.map(to));
    if (mapped.size === 1 && boxOf.has(ds[0])) continue;
    if (!ds.some((d) => boxOf.has(d))) {
      relations.push(r);
      continue;
    }
    relations.push({ ...r, endpoints: r.endpoints.map((e) => (boxOf.has(e.device) ? { ...e, device: to(e.device), iface: undefined } : e)) } as Relation);
  }
  // networks: one address port per network with a member inside
  const members = derive(model).members;
  for (const n of model.networks) {
    for (const m of members.get(n.id) || []) {
      const box = boxOf.get(m.device);
      if (!box || !m.matches.length) continue;
      const list = ports.get(box) || [];
      const id = `net-${n.id}`.replace(/[^A-Za-z0-9_.\-/]/g, '_');
      if (list.some((x) => x.id === id)) continue;
      const src = model.index.interfaces.get(ifaceKey(m.matches[0].device, m.matches[0].iface));
      if (!src) continue;
      list.push({ ...src, id, label: n.label || n.id, addresses: [m.matches[0].address] } as Interface);
      ports.set(box, list);
    }
  }
  const devices: Device[] = [];
  const placed = new Set<string>();
  for (const d of model.devices) {
    const box = boxOf.get(d.id);
    if (!box) {
      devices.push(d);
      continue;
    }
    if (placed.has(box)) continue;
    placed.add(box);
    const gid = box.slice(COLLAPSED.length);
    const g = model.index.groups.get(gid) as Group;
    const n = (inside.get(gid) || []).length;
    const c = counted.get(box) || 0;
    devices.push({
      id: box,
      label: `${g.label || g.id}: ${n} device${n === 1 ? '' : 's'}${c ? `, ${c} cable${c === 1 ? '' : 's'} inside` : ''} (collapsed)`,
      type: 'system',
      kind: 'collapsed_group',
      portPairs: [],
      management: [],
      group: g.parent,
      services: [],
      attrs: [],
      interfaces: ports.get(box) || [],
      logical: [],
      dnsNames: [],
      routes: [],
      line: g.line,
    });
  }
  const hiddenGroups = new Set<string>();
  for (const g of inside.keys()) for (const x of groupTree(model, g)) hiddenGroups.add(x);
  const groups = model.groups.filter((g) => !hiddenGroups.has(g.id));
  const interfaces = new Map<string, Interface>();
  for (const d of devices) for (const i of d.interfaces.concat(d.logical)) interfaces.set(ifaceKey(d.id, i.id), i);
  const ifaceLink = new Map<string, string>();
  for (const l of links) for (const e of [l.a, l.b]) if (e.iface !== undefined && !ifaceLink.has(ifaceKey(e.device, e.iface))) ifaceLink.set(ifaceKey(e.device, e.iface), l.id);
  const routes = new Map<string, import('./types').Route>();
  for (const d of devices) for (const r of d.routes) routes.set(routeKey(d.id, r.index), r);
  const index: ModelIndex = {
    groups: new Map(groups.map((g) => [g.id, g] as [string, Group])),
    devices: new Map(devices.map((d) => [d.id, d] as [string, Device])),
    interfaces,
    links: new Map(links.map((l) => [l.id, l] as [string, Link])),
    networks: model.index.networks,
    relations: new Map(relations.map((r) => [r.id, r] as [string, Relation])),
    ifaceLink,
    radioLinks: new Map(),
    routes,
  };
  return { ...model, devices, links, relations, groups, index, layout: { physical: new Map(), logical: new Map(), manual: { physical: new Set(), logical: new Set() }, routing: model.layout.routing } };
}

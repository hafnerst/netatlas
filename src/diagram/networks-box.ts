/**
 * The "Networks" overview drawn into exported SVG files, beside the legend:
 * the networks that are relevant to the exported view, with their name,
 * prefixes and VLAN. DOM-free, like the renderers.
 *
 * Relevance is decided from what the exported picture actually contains
 * (the `data-ref`s of its scene), not from the list of networks in the file:
 *
 *   drawn element                          networks it brings in
 *   -------------------------------------  ---------------------------------------------
 *   a network node (logical view)          that network
 *   a port (physical view)                 networks containing an address of that physical
 *                                          interface, of an aggregate it is a member of, or
 *                                          of a VLAN interface whose VLAN it carries
 *   a cable (physical view)                networks whose VLAN is permitted on one of its ends
 *   a device with loopbacks (logical view) networks containing an address of those loopbacks
 *   a relation (logical view)              its `network`, the networks in its `over`, and the
 *                                          networks containing an address of its endpoint interfaces
 *
 * So a network reached only through loopbacks or tunnel interfaces is not in
 * the physical picture's list, and with the network nodes switched off the
 * logical list holds only what the drawn relations and loopbacks use.
 */
import { Rect } from '../layout/geometry';
import { TextBlock, textBlock, textWidth } from '../layout/text';
import { associatedInterfaces, interfaceNetworks } from '../model/derive';
import { compareNames } from '../model/order';
import { splitRef } from '../model/queries';
import { Model, Network, ifaceKey, loopbacks } from '../model/types';
import { textLines } from './labels';
import { ExportOptions, LEGEND_GAP, SvgLegend, svgLegend } from './legend';
import { SceneResult } from './physical';
import { VNode, h, walk } from './scene';
import { View } from './session';

/** Every `data-ref` of a rendered scene: the elements the picture represents. */
export function sceneRefs(root: VNode): Set<string> {
  const out = new Set<string>();
  walk(root, (n) => {
    const r = n.attrs['data-ref'];
    if (r) out.add(r);
  });
  return out;
}

/**
 * The networks relevant to a view, given the refs of the elements drawn in
 * it (see the table above). Sorted by name, then id; each network once.
 */
export function viewNetworks(model: Model, view: View, refs: Set<string>): Network[] {
  const ix = model.index;
  const ids = new Set<string>();
  const addIface = (device: string, iface: string): void => {
    for (const n of interfaceNetworks(model, device, iface)) ids.add(n);
  };
  refs.forEach((ref) => {
    const [kind, id] = splitRef(ref);
    if (kind === 'network') {
      if (ix.networks.has(id)) ids.add(id);
    } else if (kind === 'iface') {
      const inf = ix.interfaces.get(id);
      if (!inf) return;
      addIface(inf.device, inf.id);
      // virtual interfaces that use the drawn port (aggregates, VLAN interfaces); tunnels are relations of the logical view
      if (view === 'physical' && inf.type === 'physical') {
        for (const other of associatedInterfaces(model, inf)) {
          const o = ix.interfaces.get(ifaceKey(inf.device, other));
          if (o && o.type === 'virtual') addIface(o.device, o.id);
        }
      }
    } else if (kind === 'link') {
      const l = ix.links.get(id);
      if (!l) return;
      const vlans = l.a.vlans.concat(l.b.vlans);
      for (const n of model.networks) if (n.vlan !== undefined && vlans.indexOf(n.vlan) >= 0) ids.add(n.id);
    } else if (kind === 'device') {
      // loopbacks are drawn under their device in the logical view only
      const d = view === 'logical' ? ix.devices.get(id) : undefined;
      if (d) for (const l of loopbacks(d)) addIface(d.id, l.id);
    } else if (kind === 'relation' || kind === 'hub') {
      const r = ix.relations.get(id);
      if (!r) return;
      if (r.network) ids.add(r.network);
      for (const o of r.over) if (ix.networks.has(o)) ids.add(o);
      for (const e of r.endpoints) if (e.iface && ix.interfaces.has(ifaceKey(e.device, e.iface))) addIface(e.device, e.iface);
    }
  });
  return model.networks.filter((n) => ids.has(n.id)).sort((p, q) => compareNames(p.label, q.label) || compareNames(p.id, q.id));
}

/** Second line of an entry: prefixes and VLAN, preceded by the id when the name alone is not unique. */
export function networkIdentity(n: Network, showId: boolean): string {
  const parts: string[] = [];
  if (showId) parts.push('id ' + n.id);
  parts.push(n.cidr.length ? n.cidr.slice().sort(compareNames).join(', ') : 'no prefix');
  if (n.vlan !== undefined) parts.push('VLAN ' + n.vlan);
  return parts.join(' · ');
}

const PAD = 14;
const HEADING_SIZE = 13;
const NOTE_SIZE = 11;
const NAME_SIZE = 12;
const SUB_SIZE = 11;
/** widest line of a name or of its prefixes; longer text wraps */
const ENTRY_MAX_W = 250;
const ENTRY_GAP = 9;
const COL_GAP = 22;
/** a column is at least this high before a second one is started */
const MIN_COL_H = 320;

interface Entry {
  id: string;
  name: TextBlock;
  sub: TextBlock;
  h: number;
}

/**
 * Draw the overview as SVG to the right of `after` (the legend's box), in
 * the legend's style. Long names and prefix lists wrap; a long list
 * continues in further columns instead of growing below the picture. The
 * returned viewBox is `viewBox` grown to contain the box fully, so it covers
 * nothing and is never clipped.
 */
export function svgNetworks(model: Model, view: View, refs: Set<string>, after: Rect, viewBox: Rect): SvgLegend {
  const nets = viewNetworks(model, view, refs);
  const heading = view === 'physical' ? 'Networks — physical view' : 'Networks — logical view';
  const note = nets.length ? `${nets.length} of ${model.networks.length} in the model: those used by what is shown` : '';
  const labelCount = new Map<string, number>();
  for (const n of nets) labelCount.set(n.label, (labelCount.get(n.label) || 0) + 1);
  const entries: Entry[] = nets.map((n) => {
    const name = textBlock(n.label, NAME_SIZE, ENTRY_MAX_W);
    const sub = textBlock(networkIdentity(n, (labelCount.get(n.label) as number) > 1), SUB_SIZE, ENTRY_MAX_W);
    return { id: n.id, name, sub, h: name.h + sub.h };
  });
  const empty = textBlock(
    model.networks.length ? 'No network is used by the elements shown in this view.' : 'The model defines no networks.',
    NAME_SIZE,
    ENTRY_MAX_W,
  );

  // columns: filled top to bottom, as high as the picture allows
  const maxColH = Math.max(MIN_COL_H, after.h - 60, viewBox.h - 2 * LEGEND_GAP - 60);
  const cols: Entry[][] = [[]];
  let colH = 0;
  for (const e of entries) {
    const add = e.h + (cols[cols.length - 1].length ? ENTRY_GAP : 0);
    if (cols[cols.length - 1].length && colH + add > maxColH) {
      cols.push([]);
      colH = 0;
    }
    colH += cols[cols.length - 1].length ? add : e.h;
    cols[cols.length - 1].push(e);
  }
  const colW = cols.map((c) => Math.ceil(c.reduce((m, e) => Math.max(m, e.name.w, e.sub.w), 0)));
  const bodyW = entries.length ? colW.reduce((s, w) => s + w, 0) + COL_GAP * (cols.length - 1) : Math.ceil(empty.w);
  const w = Math.ceil(Math.max(textWidth(heading, HEADING_SIZE), textWidth(note, NOTE_SIZE), bodyW) + 2 * PAD + 6);

  const kids: VNode[] = [h('text', { class: 'lg-heading', x: PAD, y: PAD + 12 }, heading)];
  let top = PAD + 22;
  if (note) {
    kids.push(h('text', { class: 'lg-title', x: PAD, y: top + 9 }, note));
    top += 17;
  }
  top += 6;
  let bottom = top;
  if (!entries.length) {
    kids.push(textLines({ class: 'lg-label nw-empty', 'font-size': NAME_SIZE }, empty, PAD, top));
    bottom = top + empty.h;
  } else {
    let x = PAD;
    cols.forEach((col, ci) => {
      let y = top;
      for (const e of col) {
        kids.push(
          h('g', { class: 'nw-entry', 'data-network': e.id }, [
            textLines({ class: 'lg-label nw-name', 'font-size': NAME_SIZE }, e.name, x, y),
            textLines({ class: 'lg-title nw-sub', 'font-size': SUB_SIZE }, e.sub, x, y + e.name.h),
          ]),
        );
        y += e.h + ENTRY_GAP;
      }
      bottom = Math.max(bottom, y - ENTRY_GAP);
      x += colW[ci] + COL_GAP;
    });
  }
  const hgt = Math.ceil(bottom + PAD);
  const box: Rect = { x: after.x + after.w + LEGEND_GAP, y: after.y, w, h: hgt };
  const right = box.x + box.w + LEGEND_GAP;
  return {
    root: h('g', { class: 'svg-networks', 'data-count': String(nets.length), transform: `translate(${box.x} ${box.y})` }, [h('rect', { class: 'lg-box', x: 0, y: 0, width: w, height: hgt, rx: 8 })].concat(kids)),
    box,
    viewBox: { x: viewBox.x, y: viewBox.y, w: Math.max(viewBox.w, right - viewBox.x), h: Math.max(viewBox.h, hgt + 2 * LEGEND_GAP) },
  };
}

export interface ExportBoxes {
  legend: SvgLegend;
  networks: SvgLegend;
  /** the viewBox of the exported picture: the diagram plus both boxes */
  viewBox: Rect;
}

/** Everything an exported SVG gets in addition to the diagram: the legend and the networks overview of that view. */
export function exportBoxes(model: Model, view: View, opts: ExportOptions, scene: SceneResult): ExportBoxes {
  const legend = svgLegend(model, view, opts, scene.bounds);
  const networks = svgNetworks(model, view, sceneRefs(scene.root), legend.box, legend.viewBox);
  return { legend, networks, viewBox: networks.viewBox };
}

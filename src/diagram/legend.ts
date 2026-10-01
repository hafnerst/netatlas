/**
 * The legend of a view, as data: which symbols the current model uses and
 * what they mean. One definition feeds both the Legend tab (HTML, in
 * ui/panels.ts) and the legend drawn into exported SVG files (below), so the
 * two can't disagree. DOM-free, like the renderers.
 */
import { Rect, textWidth } from '../layout/geometry';
import { DEVICE_TYPE_IDS, deviceTypeLabel } from '../model/device-types';
import { vlanMismatch } from '../model/derive';
import { relationStyle } from '../model/protocols';
import { CATEGORIES, Category, Model, ProtocolDef } from '../model/types';
import { deviceIcon, iconName } from './icons';
import { VNode, h } from './scene';
import { View } from './session';
import { NETWORK_COLOR, groupKindStyle, mediumStyle, speedWidth } from './style';

/** Swatches are drawn in a box of this width; `swatchH` is 18 unless an item says otherwise. */
export const SWATCH_W = 44;
export const SWATCH_H = 18;

export interface LegendItem {
  /** SVG content in a SWATCH_W × swatchH box */
  swatch: VNode[];
  swatchH?: number;
  label: string;
  /** set for protocol entries of the logical view: protocol id, number of relations, defined in the file */
  protocol?: string;
  count?: number;
  custom?: boolean;
}

export interface LegendSection {
  title: string;
  items: LegendItem[];
  /** explanatory text below the items (the Legend tab shows it; the SVG legend keeps to symbols) */
  note?: string;
  /** further items below the note */
  more?: LegendItem[];
}

export interface Legend {
  sections: LegendSection[];
  /** closing remark of the Legend tab */
  footer?: string;
}

export const CATEGORY_TEXT: { [c in Category]: string } = {
  tunnel: 'Tunnel (encapsulation) — hollow tube',
  adjacency: 'Protocol adjacency / session',
  overlay: 'Overlay / virtual network',
  redundancy: 'Redundancy / bundling',
  service: 'Service / dependency',
  other: 'Other logical relation',
};

const LINE = 'M3 9H41';

export function relationSwatchParts(def: ProtocolDef): VNode[] {
  if (def.style === 'tube') {
    return [h('path', { class: 'tube-outer', d: LINE, stroke: def.color, 'stroke-width': 10 }), h('path', { class: 'tube-inner', d: LINE, 'stroke-width': 4.8 })];
  }
  const dash = def.style === 'dashed' ? '9 5' : def.style === 'dotted' ? '0.5 5' : def.style === 'dashdot' ? '10 4 2 4' : undefined;
  return [
    h('path', { class: 'rel-line', d: LINE, stroke: def.color, 'stroke-width': def.style === 'dotted' ? 3.2 : 2.4, 'stroke-dasharray': dash, 'stroke-linecap': def.style === 'dotted' ? 'round' : undefined }),
  ];
}

/** Legend of a view for the current model: only symbols that the model uses, plus the fixed ones. */
export function legendOf(model: Model, view: View): Legend {
  const sections: LegendSection[] = [];
  if (view === 'physical') {
    // in the format's order; devices without a type last
    const rank = (t: string): number => (DEVICE_TYPE_IDS.indexOf(t) + DEVICE_TYPE_IDS.length + 1) % (DEVICE_TYPE_IDS.length + 1);
    const types = Array.from(new Set(model.devices.map((d) => iconName(d.type)))).sort((p, q) => rank(p) - rank(q));
    sections.push({ title: 'Devices', items: types.map((t) => ({ swatch: [deviceIcon(t, 11, 0, 22)], swatchH: 22, label: deviceTypeLabel(t) || 'No type' })) });
    const media = new Map<string, { label: string; color: string; dash?: string }>();
    for (const l of model.links) {
      const m = mediumStyle(l.medium);
      media.set(m.key, m);
    }
    if (media.size) {
      const width = (speed: string): LegendItem => ({ swatch: [h('path', { d: LINE, stroke: '#868e96', 'stroke-width': speedWidth(speed), fill: 'none' })], label: speed });
      sections.push({
        title: 'Cables (physical links)',
        items: Array.from(media.values()).map((m) => ({ swatch: [h('path', { d: LINE, stroke: m.color, 'stroke-width': 2.6, 'stroke-dasharray': m.dash, fill: 'none' })], label: m.label })),
        note: 'Line width grows with link speed (100M → 400G). Small squares are ports; labels show the interface name. “Trunk” on a cable means several VLANs are permitted; ⚠ marks a cable whose two ends permit different VLANs.',
        more: [width('1G'), width('100G')],
      });
    }
    const groups = groupSection(model);
    if (groups) sections.push(groups);
    return {
      sections,
      footer: 'Tunnels and protocol sessions are logical and are shown in the Logical view, not as cables. Select a tunnel in the Relations list to highlight the cables it rides on.',
    };
  }
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
    sections.push({
      title: CATEGORY_TEXT[cat],
      items: protos.map(([p, u]) => ({ swatch: relationSwatchParts(u.def), label: u.def.label, protocol: p, count: u.count, custom: u.def.custom })),
    });
  }
  sections.push({
    title: 'Other symbols',
    items: [
      {
        swatch: [
          h('path', { class: 'tube-outer', d: LINE, stroke: '#7048e8', 'stroke-width': 14 }),
          h('path', { class: 'tube-inner', d: LINE, 'stroke-width': 8.8 }),
          h('path', { class: 'tube-outer', d: LINE, stroke: '#e8590c', 'stroke-width': 7 }),
          h('path', { class: 'tube-inner', d: LINE, 'stroke-width': 2 }),
        ],
        label: 'Carried inside (e.g. GRE over IPsec)',
      },
      { swatch: [h('circle', { class: 'hub', cx: 22, cy: 9, r: 7, stroke: '#0c8599' })], label: 'Multipoint hub (3+ devices)' },
      { swatch: [h('rect', { class: 'net-box', x: 3, y: 2, width: 38, height: 14, rx: 7, stroke: NETWORK_COLOR })], label: 'IP network' },
      { swatch: [h('path', { class: 'member', d: LINE })], label: 'Network membership (from addresses)' },
    ],
    note: Array.from(used.values()).some((u) => u.def.custom) ? '* defined in this file’s "protocols" section' : undefined,
  });
  const groups = groupSection(model);
  if (groups) sections.push(groups);
  return { sections };
}

/** The kinds of groups / locations: their frames are drawn in both views. */
function groupSection(model: Model): LegendSection | null {
  const kinds = Array.from(new Set(model.groups.map((g) => g.kind)));
  if (!kinds.length) return null;
  return {
    title: GROUPS_TITLE,
    items: kinds.map((k) => ({
      swatch: [h('rect', { class: 'group-box ' + (groupKindStyle(k).strong ? 'group-strong' : ''), x: 3, y: 2, width: 38, height: 14, rx: 4, 'stroke-dasharray': groupKindStyle(k).dash })],
      label: k || '(no kind)',
    })),
  };
}

const GROUPS_TITLE = 'Locations / groups';

// ------------------------------------------------------- legend inside an SVG

/** What an exported picture shows, so its legend lists exactly that. */
export interface ExportOptions {
  hiddenProtocols: Set<string>;
  showNetworks: boolean;
  /** group / location frames are drawn (default true) */
  showGroups?: boolean;
}

const PAD = 14;
const ROW_GAP = 5;
const TITLE_SIZE = 11;
const LABEL_SIZE = 12;
/** space between the diagram and the legend, and around the legend */
export const LEGEND_GAP = 28;

/**
 * The sections an exported SVG needs: the Legend tab's content reduced to
 * what is drawn (hidden protocols, networks and group frames are left out), plus
 * the symbols the tab explains in prose (ports, VLAN mismatch).
 */
export function exportLegendSections(model: Model, view: View, opts: ExportOptions): LegendSection[] {
  const out: LegendSection[] = [];
  for (const s of legendOf(model, view).sections) {
    let items = s.items.concat(s.more || []);
    if (view === 'logical') {
      items = items.filter((i) => {
        if (i.protocol !== undefined) return !opts.hiddenProtocols.has(i.protocol);
        if (/^IP network|^Network membership/.test(i.label)) return opts.showNetworks && model.networks.length > 0;
        return true;
      });
    }
    if (s.title === GROUPS_TITLE && opts.showGroups === false) items = [];
    if (items.length) out.push({ title: s.title, items: items.map((i) => (i.custom ? { ...i, label: i.label + ' *' } : i)), note: view === 'logical' ? s.note : undefined });
  }
  if (view === 'physical' && model.links.length) {
    const cables = out.find((s) => /^Cables/.test(s.title));
    if (cables) {
      const n = cables.items.length - 2;
      cables.items[n] = { ...cables.items[n], label: '1G (width grows with speed)' };
      cables.items.push({ swatch: [h('rect', { class: 'port', x: 17.5, y: 4.5, width: 9, height: 9, rx: 1.5, fill: '#868e96' })], label: 'Port (label: interface name)' });
      if (model.links.some((l) => !!vlanMismatch(l.a.vlans, l.b.vlans))) {
        cables.items.push({ swatch: [h('text', { class: 'vlan-warn', x: 22, y: 14, 'text-anchor': 'middle' }, '⚠')], label: 'VLAN mismatch between the two ends' });
      }
    }
  }
  return out;
}

export interface SvgLegend {
  /** <g class="svg-legend">, positioned in diagram coordinates */
  root: VNode;
  /** the rectangle the legend occupies */
  box: Rect;
  /** the viewBox of the exported picture: diagram bounds plus the legend, nothing clipped */
  viewBox: Rect;
}

/**
 * Draw the legend as SVG next to the diagram. It is placed to the right of
 * `bounds` (the rectangle enclosing every drawn object, including
 * disconnected components), so it can't cover anything, and the returned
 * viewBox is grown to contain it fully. Sizes are in diagram units, the
 * same as the diagram's own labels, so both stay equally readable at any
 * zoom.
 */
export function svgLegend(model: Model, view: View, opts: ExportOptions, bounds: Rect): SvgLegend {
  const sections = exportLegendSections(model, view, opts);
  const heading = view === 'physical' ? 'Legend — physical view' : 'Legend — logical view';
  const kids: VNode[] = [];
  let widest = textWidth(heading, 13);
  for (const s of sections) {
    widest = Math.max(widest, textWidth(s.title.toUpperCase(), TITLE_SIZE) + 8);
    if (s.note) widest = Math.max(widest, textWidth(s.note, TITLE_SIZE));
    for (const i of s.items) widest = Math.max(widest, SWATCH_W + 10 + textWidth(i.label, LABEL_SIZE));
  }
  const w = Math.ceil(widest + 2 * PAD + 6);
  let y = PAD;
  kids.push(h('text', { class: 'lg-heading', x: PAD, y: y + 12 }, heading));
  y += 22;
  for (const s of sections) {
    y += 8;
    kids.push(h('text', { class: 'lg-title', x: PAD, y: y + 9 }, s.title.toUpperCase()));
    y += 17;
    for (const i of s.items) {
      const sh = i.swatchH || SWATCH_H;
      kids.push(h('g', { class: 'swatch', transform: `translate(${PAD} ${y})` }, i.swatch));
      kids.push(h('text', { class: 'lg-label', x: PAD + SWATCH_W + 10, y: y + sh / 2 + 4 }, i.label));
      y += sh + ROW_GAP;
    }
    if (s.note) {
      kids.push(h('text', { class: 'lg-title', x: PAD, y: y + 9 }, s.note));
      y += 15;
    }
  }
  const hgt = y + PAD - ROW_GAP;
  const box: Rect = { x: bounds.x + bounds.w + LEGEND_GAP, y: bounds.y + LEGEND_GAP, w, h: hgt };
  const viewBox: Rect = { x: bounds.x, y: bounds.y, w: bounds.w + LEGEND_GAP + w + LEGEND_GAP, h: Math.max(bounds.h, hgt + 2 * LEGEND_GAP) };
  return {
    root: h('g', { class: 'svg-legend', transform: `translate(${box.x} ${box.y})` }, [h('rect', { class: 'lg-box', x: 0, y: 0, width: w, height: hgt, rx: 8 })].concat(kids)),
    box,
    viewBox,
  };
}

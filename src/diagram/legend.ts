/**
 * The legend of a view, as data: which symbols the current model uses and
 * what they mean. One definition feeds both the Legend tab (HTML, in
 * ui/panels.ts) and the legend drawn into exported SVG files (below), so the
 * two can't disagree. DOM-free, like the renderers.
 */
import { Rect, textWidth } from '../layout/geometry';
import { DEVICE_TYPE_IDS, deviceTypeLabel, kindLabel, purposeDef } from '../model/device-types';
import { endTagText, tagMismatch } from '../model/derive';
import { relationStyle } from '../model/protocols';
import { CATEGORIES, Category, Model, ProtocolDef } from '../model/types';
import { isGuest } from '../model/virtual';
import { deviceIcon, iconName, layerBadge, glyphFor } from './icons';
import { VNode, h } from './scene';
import { View } from './session';
import { NETWORK_COLOR, groupKindStyle, mediumStyle, speedWidth } from './style';
import { capabilities } from '../model/capabilities';
import { SERVICES, deviceServices, MAX_BADGES } from '../model/service-registry';

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
    // in the format's order; devices without a type last; each glyph the model draws once: a kind's or a System's
    // own glyph with its name ("Endpoint · PLC"), the kinds that keep the type's glyph in brackets ("Firewall (NGFW)")
    const rank = (t: string): number => (DEVICE_TYPE_IDS.indexOf(t) + DEVICE_TYPE_IDS.length + 1) % (DEVICE_TYPE_IDS.length + 1);
    const types = Array.from(new Set(model.devices.map((d) => iconName(d.type)))).sort((p, q) => rank(p) - rank(q));
    const items: LegendItem[] = [];
    for (const t of types) {
      const ds = model.devices.filter((d) => iconName(d.type) === t);
      if (capabilities({ type: t }).switchFeatures) {
        items.push(...switchItems(model));
        continue;
      }
      const plain = ds.filter((d) => glyphFor(d) === iconName(d.type, d.layer3));
      if (plain.length) {
        const kinds = Array.from(new Set(plain.map((d) => kindLabel(d)).filter((k): k is string => !!k))).sort();
        items.push({ swatch: [deviceIcon(t, 11, 0, 22)], swatchH: 22, label: (deviceTypeLabel(t) || 'No type') + (kinds.length ? ` (${kinds.join(', ')})` : '') });
      }
      const variants = new Map<string, string>();
      for (const d of ds) {
        const g = glyphFor(d);
        if (g === iconName(d.type, d.layer3) || variants.has(g)) continue;
        const purpose = d.purpose ? purposeDef(d.purpose) : undefined;
        const what = [purpose ? purpose.label : '', kindLabel(d) || ''].filter((x) => !!x).join(', ');
        variants.set(g, `${deviceTypeLabel(t)} · ${what || g}`);
      }
      for (const [g, label] of Array.from(variants).sort((a, b) => (a[1] < b[1] ? -1 : 1))) items.push({ swatch: [deviceIcon(g, 11, 0, 22)], swatchH: 22, label });
    }
    items.push(...netServiceItems(model));
    sections.push({ title: 'Devices', items });
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
        more: [
          { ...width('1G'), label: '1G (width grows with speed)' },
          width('100G'),
          PORT_ITEM,
          ...(model.links.some((l) => !l.a.iface || !l.b.iface) ? [DEVICE_END_ITEM] : []),
          ...(model.devices.some((d) => d.logical.some((i) => i.members.length > 0)) ? [LAG_ITEM] : []),
          ...(model.links.some((l) => !!endTagText(model, l.a) || !!endTagText(model, l.b)) ? [TAG_ITEM] : []),
          ...(model.links.some((l) => /^T /.test(endTagText(model, l.a)) || /^T /.test(endTagText(model, l.b))) ? [TRUNK_ITEM] : []),
          ...(model.links.some((l) => !!tagMismatch(model, l)) ? [MISMATCH_ITEM] : []),
        ],
      });
    }
    const virt = virtualItems(model);
    if (virt.length) sections.push({ title: VIRTUAL_TITLE, items: virt });
    const groups = groupSection(model);
    if (groups) sections.push(groups);
    return {
      sections,
      footer: 'Tunnels and protocol sessions are drawn in the Logical view.',
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
  // a switch's layer is marked in both views
  const switches = switchItems(model);
  if (switches.length) sections.push({ title: 'Switches', items: switches });
  // a server's DHCP and DNS badges too
  const svcs = netServiceItems(model);
  if (svcs.length) sections.push({ title: 'Servers', items: svcs });
  // a guest names the host it runs on
  if (model.devices.some((d) => isGuest(d) && d.host !== undefined)) sections.push({ title: VIRTUAL_TITLE, items: [RUNS_ON_ITEM] });
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
        label: 'Carried inside (e.g. OSPF over GRE, bound to the same interfaces)',
      },
      IFACE_PORT_ITEM,
      ...(model.relations.some((r) => r.endpoints.some((e) => !e.iface)) ? [DEVICE_PORT_ITEM] : []),
      { swatch: [h('circle', { class: 'hub', cx: 22, cy: 9, r: 7, stroke: '#0c8599' })], label: 'Multipoint hub (3+ devices)' },
      { swatch: [h('rect', { class: 'net-box', x: 3, y: 2, width: 38, height: 14, rx: 7, stroke: NETWORK_COLOR })], label: 'IP network' },
      { swatch: [h('path', { class: 'member', d: LINE })], label: 'Network membership (from addresses)' },
      ...(model.devices.some((d) => d.dnsNames.length > 0) ? [DNS_ITEM] : []),
      ...(model.devices.some((d) => d.routes.length > 0) ? [ROUTES_ITEM, NEXT_HOP_ITEM] : []),
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

/** symbols of the physical view that the Legend tab and the exported legend share */
const PORT_ITEM: LegendItem = { swatch: [h('rect', { class: 'port', x: 17.5, y: 4.5, width: 9, height: 9, rx: 1.5, fill: '#868e96' })], label: 'Port (label: interface name)' };
/** a cable end without an interface: plugged into the device as a whole */
const DEVICE_END_ITEM: LegendItem = { swatch: [h('rect', { class: 'port dev-end', x: 17.5, y: 4.5, width: 9, height: 9, rx: 1.5 })], label: 'Cable end at the device (no port named)' };
/** an aggregate's bracket around its member ports */
const LAG_ITEM: LegendItem = {
  swatch: [
    h('rect', { class: 'port', x: 9, y: 4.5, width: 9, height: 9, rx: 1.5, fill: '#868e96' }),
    h('rect', { class: 'port', x: 26, y: 4.5, width: 9, height: 9, rx: 1.5, fill: '#868e96' }),
    h('rect', { class: 'lag-mark', x: 4, y: 3, width: 36, height: 12, rx: 6 }),
  ],
  label: 'Aggregate (LAG): its member ports, named by the aggregate',
};
/** the port beside an interface's row in the logical view, with its end label */
const IFACE_PORT_ITEM: LegendItem = {
  swatch: [
    h('rect', { class: 'dev-box', x: 1, y: 1, width: 14, height: 16, rx: 2 }),
    h('rect', { class: 'lport', x: 12, y: 5, width: 6, height: 8, rx: 1.5 }),
    h('path', { class: 'rel-line', d: 'M18 9H43', stroke: '#868e96', 'stroke-width': 2.4 }),
  ],
  label: 'Port of an interface: its relations start there (end label: its name, "src:" the underlay)',
};
/** the device-level port beside a device's name */
const DEVICE_PORT_ITEM: LegendItem = {
  swatch: [
    h('rect', { class: 'dev-box', x: 1, y: 1, width: 14, height: 16, rx: 2 }),
    h('rect', { class: 'lport dev-port', x: 12, y: 5, width: 6, height: 8, rx: 1.5 }),
    h('path', { class: 'rel-line', d: 'M18 9H43', stroke: '#868e96', 'stroke-width': 2.4 }),
  ],
  label: 'Device-level port: relations bound to the device as a whole',
};
const MISMATCH_ITEM: LegendItem = { swatch: [h('text', { class: 'net-warn', x: 22, y: 14, 'text-anchor': 'middle' }, '⚠')], label: 'VLANs differ: the ports at the two ends disagree' };
/** a port's VLANs, as its label's second line */
const TAG_ITEM: LegendItem = {
  swatch: [h('text', { class: 'port-tag', x: 22, y: 13, 'text-anchor': 'middle', 'font-size': 9 }, 'A · T · N')],
  label: 'Port VLANs: A 10 access port · T 10,20 trunk · N its native (untagged) VLAN · R · T a routed port’s tagged subinterfaces',
};
/** a trunk port: larger, with a thick frame */
const TRUNK_ITEM: LegendItem = {
  swatch: [h('rect', { class: 'port', x: 9, y: 4.5, width: 9, height: 9, rx: 1.5, fill: '#868e96' }), h('rect', { class: 'port trunk', x: 25, y: 3.5, width: 11, height: 11, rx: 1.5, fill: '#868e96' })],
  label: 'Access port (one VLAN) · trunk port (several VLANs, thick frame)',
};

/** a device's route table and the line from a route to its next hop (logical view; hidden with Routes) */
export const ROUTES_LABEL = 'Static routes (route table in the device, per VRF)';
export const NEXT_HOP_LABEL = 'Route → next hop (dotted, to the interface that has the next-hop address)';
const ROUTES_ITEM: LegendItem = {
  swatch: [h('g', { class: 'if-entry route-table' }, [h('rect', { x: 3, y: 2, width: 38, height: 14, rx: 3 }), h('text', { x: 6, y: 12, 'font-size': 8 }, '0/0 via')])],
  label: ROUTES_LABEL,
};
const NEXT_HOP_ITEM: LegendItem = {
  swatch: [h('path', { class: 'nh-line', d: LINE }), h('path', { class: 'nh-arrow', d: 'M41 9L35 5.5L35 12.5Z' })],
  label: NEXT_HOP_LABEL,
};

/** a device's DNS names, as written under it in the logical view */
const DNS_LABEL = 'DNS name (as configured, not looked up)';
const DNS_ITEM: LegendItem = {
  swatch: [h('g', { class: 'dns-chip' }, [h('rect', { x: 2, y: 3, width: 40, height: 12, rx: 6 }), h('text', { x: 22, y: 12, 'text-anchor': 'middle', 'font-size': 8 }, 'a.b.c')])],
  label: DNS_LABEL,
};

// ------------------------------------------------------- legend inside an SVG

/** What an exported picture shows, so its legend lists exactly that. */
export interface ExportOptions {
  hiddenProtocols: Set<string>;
  showNetworks: boolean;
  /** group / location frames are drawn (default true) */
  showGroups?: boolean;
  /** DNS names are drawn under devices (logical view; default: if the model has any) */
  dnsShown?: boolean;
  /** route tables and next-hop lines are drawn (logical view; default true) */
  showRoutes?: boolean;
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
 * the symbols the tab explains in prose (ports, ends carrying different networks).
 */
export function exportLegendSections(model: Model, view: View, opts: ExportOptions): LegendSection[] {
  const out: LegendSection[] = [];
  for (const s of legendOf(model, view).sections) {
    let items = s.items.concat(s.more || []);
    if (view === 'logical') {
      items = items.filter((i) => {
        if (i.protocol !== undefined) return !opts.hiddenProtocols.has(i.protocol);
        if (/^IP network|^Network membership/.test(i.label)) return opts.showNetworks && model.networks.length > 0;
        if (i.label === DNS_LABEL) return opts.dnsShown !== false;
        if (i.label === ROUTES_LABEL || i.label === NEXT_HOP_LABEL) return opts.showRoutes !== false;
        return true;
      });
    }
    if (s.title === GROUPS_TITLE && opts.showGroups === false) items = [];
    if (items.length) out.push({ title: s.title, items: items.map((i) => (i.custom ? { ...i, label: i.label + ' *' } : i)), note: view === 'logical' ? s.note : undefined });
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

const VIRTUAL_TITLE = 'Virtualization';

/** a guest in the logical view: its second line names its host */
const RUNS_ON_ITEM: LegendItem = {
  swatch: [h('rect', { class: 'dev-box', x: 2, y: 1, width: 40, height: 16, rx: 3 }), h('text', { x: 22, y: 12, 'text-anchor': 'middle', 'font-size': 7 }, 'runs on')],
  label: 'Guest (VM or container): "runs on" names its host',
};

/**
 * The physical view's symbols for what is drawn inside a host's box (those
 * the model has): virtual switches with their port groups, container
 * networks, the guests' boxes, and the wires.
 */
function virtualItems(model: Model): LegendItem[] {
  const out: LegendItem[] = [];
  const hv = model.devices.some((d) => !!d.hypervisor && d.hypervisor.vswitches.length > 0);
  const ce = model.devices.some((d) => !!d.containerEngine && d.containerEngine.networks.length > 0);
  if (!hv && !ce && !model.devices.some((d) => isGuest(d) && d.host !== undefined)) return out;
  if (hv) {
    out.push({
      swatch: [h('rect', { class: 'vbar-box', x: 1, y: 1, width: 42, height: 16, rx: 3 }), h('g', { class: 'pg-pill' }, [h('rect', { class: 'pg-box', x: 5, y: 5, width: 16, height: 9, rx: 2 })]), h('g', { class: 'pg-pill' }, [h('rect', { class: 'pg-box', x: 24, y: 5, width: 16, height: 9, rx: 2 })])],
      label: 'Virtual switch with its port groups (each with its VLAN)',
    });
  }
  if (ce) {
    out.push({
      swatch: [h('g', { class: 'cnet-bar' }, [h('rect', { class: 'vbar-box', x: 1, y: 4, width: 42, height: 10, rx: 3 })])],
      label: 'Container network (bridge, macvlan, overlay …): dashed',
    });
  }
  out.push({
    swatch: [h('rect', { class: 'dev-box', x: 1, y: 1, width: 42, height: 16, rx: 3 }), h('rect', { class: 'dev-box', x: 22, y: 5, width: 16, height: 9, rx: 2 })],
    label: 'Guest drawn inside its host (a container in a VM: inside the VM)',
  });
  out.push({ swatch: [h('path', { class: 'vwire', d: 'M3 14V9H41' })], label: 'Virtual wire: vNIC / veth to its port group or network' });
  if (hv || model.devices.some((d) => !!d.containerEngine && d.containerEngine.networks.some((n) => n.parent !== undefined))) {
    out.push({ swatch: [h('rect', { class: 'port', x: 3, y: 4.5, width: 9, height: 9, rx: 1.5, fill: '#868e96' }), h('path', { class: 'vwire vwire-uplink', d: 'M12 9H41' })], label: 'Uplink: a host port to its virtual switch (passthrough: to the guest)' });
  }
  return out;
}

/** The legend's server-service entries: a DHCP server and a DNS server (those the model has), with their badges; a DHCP client's interface. */
function netServiceItems(model: Model): LegendItem[] {
  // the badges the model's devices carry, each named once ("DHCP DHCP server", "WIFI Wireless access", "SEP Domain separation")
  const used = SERVICES.filter((s) => model.devices.some((d) => deviceServices(d).indexOf(s) >= 0));
  if (!used.length) return [];
  const out: LegendItem[] = [{ swatch: [h('text', { class: 'legend-badge', x: 2, y: 15 }, 'A · B +n')], swatchH: 22, label: `a device's services under its type (at most ${MAX_BADGES}, then how many more; all in its tooltip)` }];
  for (const s of used) out.push({ swatch: [h('text', { class: 'legend-badge', x: 2, y: 15 }, s.badge)], swatchH: 22, label: s.label });
  return out;
}

/** The legend's switch entries: the Layer 2 and the Layer 3 switch (those the model has), each with its glyph and badge. */
function switchItems(model: Model): LegendItem[] {
  const out: LegendItem[] = [];
  for (const l3 of [false, true]) {
    if (!model.devices.some((d) => capabilities(d).switchFeatures && !!d.layer3 === l3)) continue;
    out.push({ swatch: [deviceIcon('switch', 4, 0, 22, l3), layerBadge(l3, 17, 12)], swatchH: 24, label: l3 ? 'Layer 3 switch (L3: routes between its VLANs)' : 'Layer 2 switch (L2: forwards frames only)' });
  }
  return out;
}

/**
 * Logical view renderer.
 *
 * - Relations between two devices that share the same pair of devices are
 *   drawn as separate parallel "lanes" so they never hide each other.
 * - A relation carried over another relation on the same device pair (e.g.
 *   OSPF over GRE over IPsec) is drawn *inside* its carrier's tube.
 * - Tunnels are hollow tubes (never plain cable lines), adjacencies are thin
 *   solid lines, overlays dashed, redundancy dotted, services dash-dotted.
 * - Relations with 3+ devices get a hub node with spokes.
 * - Networks are pill nodes connected to member devices by thin lines. Members
 *   are derived from the addresses inside the network's prefixes; each line
 *   carries every address of the device inside the network.
 * - A device's box holds an entry per interface with its addresses and
 *   identifiers (loopbacks, virtual and tunnel interfaces, and physical
 *   ones with layer-3 facts; see model/addresses.ts), then its DNS names.
 * - Groups / locations are frames around their devices, as in the physical
 *   view (auto-arrange keeps the devices of a group together).
 * - All text is drawn in full. Every relation label gets its own place along
 *   (or, on a short line, beside) its bundle, clear of nodes and of the labels
 *   placed before it; see diagram/labels.ts.
 */
import { CBox, Pt, Rect, boxRect, clipToBox, normal, unionRect } from '../layout/geometry';
import { LINE_W, TUBE_WALL, buildBundle, laneLabel, relationPairs, spokeWidth } from '../layout/bundles';
import { CHIP_H, HUB_R, LNode, LogicalLayout, commonChain, deviceRect, isMultipoint, networkSubtitle } from '../layout/logical';
import { endLabelLines, memberAddresses } from '../layout/input';
import { CHIP_FONT, END_LABEL_GAP, ENTRY_GAP, ENTRY_MARGIN, NET_LABEL_SIZE, dnsNameLines, dnsShown, endLabelBox, entriesSize, memberLabelBox, networkBody, pillBox } from '../layout/sizes';
import { END_LABEL_X, RowSpan, deviceRows, middleSegment, offsetPolyline, polylineD, routeLogical } from './logical-ports';
import { addressAttrEntries, addressAttrLines } from '../model/addresses';
import { TextBlock } from '../layout/text';
import { networkMembers } from '../model/derive';
import { Device, LineStyle, Model, ProtocolDef, Relation, relationDevices } from '../model/types';
import { Attrs, LabelPlacer, addressLineAttrs, alongSegment, centerRect, fieldAttrs, leaderLine, textLines } from './labels';
import { cssToken, deviceNode, deviceSubtitle, entryItems, entryNodes, groupFrames, groupRects, nodeOverlaps, SceneResult } from './physical';
import { VNode, h } from './scene';
import { NETWORK_COLOR } from './style';
import { relationStyle } from '../model/protocols';

export interface LogicalOptions {
  showLabels: boolean;
  showNetworks: boolean;
  /** draw the frames of groups / locations (default true); hiding them never moves a node */
  showGroups?: boolean;
  hiddenProtocols: Set<string>;
  positions: Map<string, Pt>;
}

export function logicalNodes(layout: LogicalLayout, positions: Map<string, Pt>): Map<string, LNode> {
  const out = new Map<string, LNode>();
  layout.nodes.forEach((n, ref) => {
    const o = positions.get(ref);
    out.set(ref, o ? { ...n, cx: o.x, cy: o.y } : { ...n });
  });
  return out;
}

function dashFor(style: LineStyle): string | undefined {
  switch (style) {
    case 'dashed':
      return '9 5';
    case 'dotted':
      return '0.5 5';
    case 'dashdot':
      return '10 4 2 4';
    default:
      return undefined;
  }
}

/** Visual stroke of one relation along path `d`. */
function relationStroke(def: ProtocolDef, d: string, width: number): VNode[] {
  if (def.style === 'tube') {
    return [
      h('path', { class: 'tube-outer', d, stroke: def.color, 'stroke-width': width }),
      h('path', { class: 'tube-inner', d, 'stroke-width': Math.max(1, width - 2 * TUBE_WALL) }),
    ];
  }
  return [
    h('path', {
      class: 'rel-line',
      d,
      stroke: def.color,
      'stroke-width': def.style === 'dotted' ? LINE_W + 0.8 : LINE_W,
      'stroke-dasharray': dashFor(def.style),
      'stroke-linecap': def.style === 'dotted' ? 'round' : undefined,
    }),
  ];
}

function arrowHead(tip: Pt, from: Pt, color: string): VNode {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const L = 11;
  const W = 5.5;
  const bx = tip.x - ux * L;
  const by = tip.y - uy * L;
  return h('path', {
    class: 'arrow',
    d: `M${r1(tip.x)} ${r1(tip.y)}L${r1(bx - uy * W)} ${r1(by + ux * W)}L${r1(bx + uy * W)} ${r1(by - ux * W)}Z`,
    fill: color,
  });
}

function r1(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function lineD(a: Pt, b: Pt): string {
  return `M${r1(a.x)} ${r1(a.y)}L${r1(b.x)} ${r1(b.y)}`;
}

/** width of the mark of a port on the side of a device box */
const PORT_W = 6;

export function renderLogical(model: Model, layout: LogicalLayout, opts: LogicalOptions): SceneResult {
  const nodes = logicalNodes(layout, opts.positions);
  // lines attach to the device rectangle, not to the loopback chips below it
  const dev = (id: string): LNode | undefined => {
    const n = nodes.get('device:' + id);
    return n ? deviceRect(n) : undefined;
  };
  const visible = model.relations.filter((r) => !opts.hiddenProtocols.has(r.protocol) && relationDevices(r).every((d) => !!dev(d)));

  // labels keep clear of every node, and of each other
  const placer = new LabelPlacer();
  const labelRects: Rect[] = [];
  // group frames around the device nodes (with their loopback chips), the same geometry as in the physical view
  const showGroups = opts.showGroups !== false;
  const deviceBoxes = new Map<string, CBox>();
  nodes.forEach((n) => {
    if (n.kind === 'device') deviceBoxes.set(n.id, n);
  });
  const grects = showGroups ? groupRects(model, deviceBoxes, localNodes(model, nodes)) : new Map<string, Rect>();
  const groupTitles: VNode[] = [];
  const groupNodes = showGroups ? groupFrames(model, grects, placer, groupTitles) : [];
  nodes.forEach((n) => {
    if (n.kind === 'network' && !opts.showNetworks) return;
    placer.block(boxRect(n, 3));
  });

  const members: VNode[] = [];
  const relNodes: VNode[] = [];
  const labels: VNode[] = [];
  const nodeLayer: VNode[] = [];
  const memberLabels: Array<{ ref: string; s: Pt; e: Pt; addresses: string[] }> = [];

  // ---- network membership
  if (opts.showNetworks) {
    for (const nw of model.networks) {
      const nn = nodes.get('network:' + nw.id);
      if (!nn) continue;
      for (const m of networkMembers(model, nw.id)) {
        const dn = dev(m.device);
        if (!dn) continue;
        const s = clipToBox(dn, { x: nn.cx, y: nn.cy }, 1);
        const e = clipToBox(nn, { x: dn.cx, y: dn.cy }, 1);
        members.push(h('path', { class: 'member', 'data-ref': 'network:' + nw.id, d: lineD(s, e) }));
        // every address of the device inside the network, in full
        if (opts.showLabels) memberLabels.push({ ref: 'network:' + nw.id, s, e, addresses: memberAddresses(model, nw.id, m.device) });
      }
    }
  }

  // ---- relations: every strand and spoke routed from the ports of the interfaces it is bound to
  const multi: Relation[] = visible.filter((r) => isMultipoint(relationDevices(r)));
  const bundles = Array.from(relationPairs(visible).entries()).map(([key, rels]) => buildBundle(model, key, rels));
  const rows = new Map<string, Map<string, RowSpan>>();
  const netBoxes: Rect[] = [];
  nodes.forEach((n) => {
    if (n.kind === 'device') {
      const d = model.index.devices.get(n.id);
      if (d) rows.set(n.id, deviceRows(model, d, n));
    } else if (n.kind === 'network' && opts.showNetworks) netBoxes.push(boxRect(n, 4));
  });
  const routes = routeLogical(model, nodes, rows, bundles, multi, netBoxes);
  const routeRects: Rect[] = [];
  const keepLine = (pts: Pt[], halfW: number): void => {
    for (let k = 0; k + 1 < pts.length; k++) placer.blockLine(pts[k], pts[k + 1], halfW);
    for (const p of pts) routeRects.push({ x: p.x - halfW, y: p.y - halfW, w: 2 * halfW, h: 2 * halfW });
  };

  bundles.forEach((b, bi) => {
    b.strands.forEach((st, si) => {
      const pts = routes.strands.get(bi + ':' + si);
      if (!pts) return;
      for (const p of st.lanes) {
        const lane = offsetPolyline(pts, p.offset);
        const d = polylineD(lane);
        const children: VNode[] = [h('path', { class: 'hit', d, 'stroke-width': Math.max(10, p.width) }), ...relationStroke(p.def, d, p.width)];
        if (p.rel.direction === 'unidirectional') {
          // the arrow points at the last endpoint's port
          const toA = p.rel.endpoints[p.rel.endpoints.length - 1].device === b.a;
          children.push(toA ? arrowHead(lane[0], lane[1], p.def.color) : arrowHead(lane[lane.length - 1], lane[lane.length - 2], p.def.color));
        }
        relNodes.push(
          h(
            'g',
            {
              class: `rel cat-${p.def.category} style-${p.def.style} proto-${cssToken(p.rel.protocol)} depth-${p.depth}`,
              'data-ref': 'relation:' + p.rel.id,
            },
            children,
          ),
        );
        if (p.root) keepLine(lane, p.width / 2);
      }
    });
  });

  for (const r of multi) {
    const hub = nodes.get('hub:' + r.id);
    if (!hub) continue;
    const def = relationStyle(model, r);
    const kids: VNode[] = [];
    for (const d of relationDevices(r)) {
      const pts = routes.spokes.get(r.id + ':' + d);
      if (!pts) continue;
      const dd = polylineD(pts);
      kids.push(h('path', { class: 'hit', d: dd }), ...relationStroke(def, dd, spokeWidth(model, r)));
      keepLine(pts, spokeWidth(model, r) / 2);
    }
    kids.push(h('circle', { class: 'hub', cx: hub.cx, cy: hub.cy, r: HUB_R, stroke: def.color }));
    // the number of devices is text: written in the text colour (the ring around it has the protocol's colour)
    kids.push(h('text', { class: 'hub-glyph', x: hub.cx, y: hub.cy + 4, 'text-anchor': 'middle' }, String(relationDevices(r).length)));
    relNodes.push(h('g', { class: `rel hub-rel cat-${def.category} style-${def.style} proto-${cssToken(r.protocol)}`, 'data-ref': 'relation:' + r.id }, kids));
  }

  // ---- ports, and the end label at each: which interface the lanes there are bound to
  const portNodes: VNode[] = [];
  for (const port of routes.ports) {
    const ref = port.iface === undefined ? 'device:' + port.device : `iface:${port.device}:${port.iface}`;
    portNodes.push(
      h('rect', {
        class: 'lport' + (port.iface === undefined ? ' dev-port' : ''),
        'data-ref': ref,
        'data-endpoint': port.iface === undefined ? 'device' : 'iface',
        'data-side': port.side,
        x: port.x - PORT_W / 2,
        y: port.top - 2,
        width: PORT_W,
        height: port.bottom - port.top + 4,
        rx: 1.5,
      }),
    );
    if (!opts.showLabels || port.iface === undefined) continue;
    const lines = endLabelLines(model, port.device, port.iface);
    const box = endLabelBox(lines);
    // beside its row, on the side of the stubs the lanes turn away from (the row has room for it); elsewhere near them only when that is taken
    const dir = port.side === 'right' ? 1 : -1;
    const above = port.top - END_LABEL_GAP - box.h / 2;
    const below = port.bottom + END_LABEL_GAP + box.h / 2;
    const ys = port.labelBelow ? [below, above, below + 8, above - 8, below + 18, above - 18] : [above, below, above - 8, below + 8, above - 18, below + 18];
    const cands: Pt[] = [];
    for (const dx of [0, 10, 22]) for (const y of ys) cands.push({ x: port.x + dir * (END_LABEL_X + dx + box.w / 2), y });
    const c = placer.place(cands, box.w, box.h, true);
    const r = centerRect(c, box.w, box.h);
    labelRects.push(r);
    if (placer.leaderFrom) labels.push(leaderLine({ x: port.x + dir * 4, y: (port.top + port.bottom) / 2 }, r, ref));
    labels.push(
      textLines(
        { class: 'halo end-label', 'data-ref': ref, 'data-side': port.side, 'text-anchor': port.side === 'right' ? 'start' : 'end' },
        box.block,
        port.side === 'right' ? r.x + 2 : r.x + r.w - 2,
        r.y + 1,
        lines.map((_, i) => (i === 0 ? undefined : fieldAttrs({ field: 'source', value: '' }))),
      ),
    );
  }

  // ---- relation labels: one per lane that is not nested, along the middle of its strand
  if (opts.showLabels) {
    bundles.forEach((b, bi) => {
      b.strands.forEach((st, si) => {
        const pts = routes.strands.get(bi + ':' + si);
        if (!pts) return;
        // One label per lane that is not nested. They are written one after the
        // other along the strand, each next to its own lane; on a line too short
        // for that they are stacked across it. Each then takes the nearest free
        // place, so no two labels (and no label and node) share a spot.
        const [cs, ce] = middleSegment(pts);
        const dx = ce.x - cs.x;
        const dy = ce.y - cs.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const nrm = normal(cs, ce);
        const items = st.lanes
          .filter((p) => p.root)
          .map((p) => {
            const box = pillBox(laneLabel(p), p.extra);
            return { p, box, ext: Math.abs(ux) * box.w + Math.abs(uy) * box.h + 6 };
          });
        const total = items.reduce((sum, it) => sum + it.ext, 0);
        const room = len - 16;
        const alongOk = items.length === 1 || total <= room;
        let along = -total / 2;
        let across = -items.reduce((sum, it) => sum + it.box.h + 3, 0) / 2;
        for (const it of items) {
          const s = { x: cs.x + nrm.x * it.p.offset, y: cs.y + nrm.y * it.p.offset };
          const e = { x: ce.x + nrm.x * it.p.offset, y: ce.y + nrm.y * it.p.offset };
          let shift: number;
          let side: number;
          if (alongOk) {
            shift = along + it.ext / 2;
            side = 0;
            along += it.ext;
          } else {
            shift = 0;
            side = across + (it.box.h + 3) / 2 - it.p.offset;
            across += it.box.h + 3;
          }
          const step = it.box.h + 4;
          const c = placer.place(
            alongSegment(s, e, 0.5, [shift, shift - 24, shift + 24, shift - 48, shift + 48, shift - 80, shift + 80, shift - 120, shift + 120].map((v) => Math.max(-len / 2 + 8, Math.min(len / 2 - 8, v))), [side, side - step, side + step, side - 2 * step, side + 2 * step]),
            it.box.w,
            it.box.h,
          );
          labelRects.push(centerRect(c, it.box.w, it.box.h));
          if (placer.leaderFrom) labels.push(leaderLine(placer.leaderFrom, centerRect(c, it.box.w, it.box.h), 'relation:' + it.p.rel.id));
          // the relation's own address lines name its attrs (those of relations nested in it belong to them)
          labels.push(pill('relation:' + it.p.rel.id, c, it.box, it.p.def.color, addressLineAttrs(it.box.block, attrFields(it.p.rel.attrs))));
        }
      });
    });
    // multipoint relations: the label beside the hub
    for (const r of multi) {
      const hub = nodes.get('hub:' + r.id);
      if (!hub) continue;
      const def = relationStyle(model, r);
      const box = pillBox(def.label + (r.label ? ' · ' + r.label : ''), addressAttrLines(r.attrs));
      const dyy = HUB_R + 5 + box.h / 2;
      const dxx = HUB_R + 6 + box.w / 2;
      const c = placer.place(
        [
          { x: hub.cx, y: hub.cy + dyy },
          { x: hub.cx, y: hub.cy - dyy },
          { x: hub.cx + dxx, y: hub.cy },
          { x: hub.cx - dxx, y: hub.cy },
          { x: hub.cx + dxx, y: hub.cy + dyy },
          { x: hub.cx - dxx, y: hub.cy + dyy },
          { x: hub.cx + dxx, y: hub.cy - dyy },
          { x: hub.cx - dxx, y: hub.cy - dyy },
        ],
        box.w,
        box.h,
      );
      labelRects.push(centerRect(c, box.w, box.h));
      if (placer.leaderFrom) labels.push(leaderLine({ x: hub.cx, y: hub.cy }, centerRect(c, box.w, box.h), 'relation:' + r.id));
      labels.push(pill('relation:' + r.id, c, box, def.color, addressLineAttrs(box.block, attrFields(r.attrs))));
    }
  }

  // ---- addresses on membership lines: near the device, moved along the line where that spot is taken
  for (const ml of memberLabels) {
    const box = memberLabelBox(ml.addresses);
    const w = box.w;
    const hh = box.h;
    const st = hh + 2;
    // fallbacks, tried only when every usual spot is taken: right beside the device, where the line leaves it (or across it)
    const c = placer.place(alongSegment(ml.s, ml.e, 0.22, [0, 22, 44, 70, 100, -14], [0, -st, st]).concat(alongSegment(ml.s, ml.e, 0, [w / 2 + 6, w / 2 + 20], [0, -st, st, -2 * st, 2 * st])), w, hh);
    const r = centerRect(c, w, hh);
    labelRects.push(r);
    if (placer.leaderFrom) labels.push(leaderLine(placer.leaderFrom, r, ml.ref));
    labels.push(textLines({ class: 'halo member-label', 'data-ref': ml.ref, 'text-anchor': 'middle' }, box.block, c.x, r.y));
  }

  // ---- nodes
  nodes.forEach((n) => {
    if (n.kind === 'device') {
      const d = model.index.devices.get(n.id);
      if (!d) return;
      const bodyH = n.bodyH || n.h;
      nodeLayer.push(deviceNode(n.ref, d.label, deviceSubtitle(d.type), d.type, deviceRect(n), 'type-' + cssToken(d.type), bodyH));
      // the entries of its interfaces (loopbacks, virtual, tunnel, physical with addresses), each selectable
      const items = entryItems(model, d, 'logical');
      const listTop = n.cy - n.h / 2 + bodyH;
      const listH = entriesSize(items)[1];
      if (items.length) nodeLayer.push(...entryNodes(items, n.cx - n.w / 2 + ENTRY_MARGIN, listTop, n.w - 2 * ENTRY_MARGIN));
      // the names are labels: hidden with Labels (their room stays, so nothing moves)
      if (opts.showLabels) nodeLayer.push(...dnsChips(d, n, listTop + listH + (listH ? ENTRY_GAP : 0)));
    } else if (n.kind === 'network' && opts.showNetworks) {
      const nw = model.index.networks.get(n.id);
      if (!nw) return;
      const color = NETWORK_COLOR;
      const x = n.cx - n.w / 2;
      const y = n.cy - n.h / 2;
      const body = networkBody(nw.label, networkSubtitle(nw.cidr, nw.vlan), addressAttrLines(nw.attrs));
      const top = n.cy - (body.label.h + body.sub.h) / 2;
      const rx = Math.min(n.h / 2, 21);
      nodeLayer.push(
        h('g', { class: 'node network', 'data-ref': n.ref }, [
          h('rect', { class: 'net-box', x, y, width: n.w, height: n.h, rx, stroke: color }),
          h('rect', { class: 'net-tint', x, y, width: n.w, height: n.h, rx, fill: color }),
          textLines({ class: 'net-label', 'text-anchor': 'middle', 'font-size': NET_LABEL_SIZE }, body.label, n.cx, top),
          body.sub.lines.length ? textLines({ class: 'net-sub', 'text-anchor': 'middle' }, body.sub, n.cx, top + body.label.h, (networkSubtitle(nw.cidr, nw.vlan) ? [fieldAttrs({ field: nw.cidr ? 'cidr' : 'vlan', value: '' })] : []).concat(attrFields(nw.attrs).map(fieldAttrs))) : null,
        ]),
      );
    }
  });

  const rects: Rect[] = [];
  grects.forEach((r) => rects.push({ x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 }));
  nodes.forEach((n) => {
    if (n.kind === 'network' && !opts.showNetworks) return;
    rects.push({ x: n.cx - n.w / 2 - 60, y: n.cy - n.h / 2 - 50, w: n.w + 120, h: n.h + 100 });
  });
  // labels can lie outside the nodes' surroundings; they belong to the picture too
  for (const r of labelRects) rects.push({ x: r.x - 14, y: r.y - 14, w: r.w + 28, h: r.h + 28 });
  // and so do the bends of routes led around other boxes
  for (const r of routeRects) rects.push({ x: r.x - 12, y: r.y - 12, w: r.w + 24, h: r.h + 24 });
  return {
    conflicts: placer.conflicts + nodeOverlaps(Array.from(nodes.values()).filter((n) => n.kind !== 'network' || opts.showNetworks).map((n) => boxRect(n))),
    root: h('g', { class: 'scene scene-logical' }, [
      h('g', { class: 'layer-groups' }, groupNodes),
      h('g', { class: 'layer-members' }, members),
      h('g', { class: 'layer-relations' }, relNodes),
      h('g', { class: 'layer-nodes' }, nodeLayer),
      h('g', { class: 'layer-ports' }, portNodes),
      h('g', { class: 'layer-labels' }, groupTitles.concat(labels)),
    ]),
    bounds: unionRect(rects),
  };
}

/**
 * Networks and hubs local to one group: all the devices they connect to lie
 * in it. Auto-arrange places them inside that group (the innermost one
 * holding all of them), so its frame includes them. Keyed by group id.
 */
function localNodes(model: Model, nodes: Map<string, LNode>): Map<string, Rect[]> {
  const chain = (d: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let g = model.index.devices.get(d)?.group;
    while (g !== undefined && model.index.groups.has(g) && !seen.has(g)) {
      seen.add(g);
      out.push(g);
      g = model.index.groups.get(g)?.parent;
    }
    return out;
  };
  const out = new Map<string, Rect[]>();
  nodes.forEach((n) => {
    if (n.kind === 'device') return;
    const devs = n.kind === 'network' ? networkMembers(model, n.id).map((m) => m.device) : relationDevices(model.index.relations.get(n.id) as Relation);
    const inner = commonChain(devs.filter((d) => nodes.has('device:' + d)).map(chain))[0];
    if (inner === undefined) return;
    if (!out.has(inner)) out.set(inner, []);
    (out.get(inner) as Rect[]).push({ x: n.cx - n.w / 2, y: n.cy - n.h / 2, w: n.w, h: n.h });
  });
  return out;
}

/** The fields of an object's address lines (its address-like attrs, by key). */
function attrFields(attrs: Model['relations'][number]['attrs']): Array<{ field: string; value: string }> {
  return addressAttrEntries(attrs).map((a) => ({ field: 'attr', value: a.key }));
}

/** A relation label: its full text (wrapped if long) in a rounded box, centered at `p`. */
function pill(ref: string, p: Pt, box: { block: TextBlock; w: number; h: number }, color: string, lineAttrs: Array<Attrs | undefined> = []): VNode {
  return h('g', { class: 'pill', 'data-ref': ref }, [
    h('rect', { class: 'pill-box', x: p.x - box.w / 2, y: p.y - box.h / 2, width: box.w, height: box.h, rx: 9, stroke: color }),
    textLines({ class: 'pill-text', 'text-anchor': 'middle' }, box.block, p.x, p.y - box.block.h / 2, lineAttrs),
  ]);
}

/**
 * The device's DNS names in its box, under its interface entries: each name
 * once, however many interfaces it is associated with, every one of them; a
 * long name continues on further lines. They show what is configured in the
 * model, nothing looked up.
 */
function dnsChips(d: Device, n: LNode, top: number): VNode[] {
  const names = dnsShown(d.dnsNames.map((x) => x.name).filter((x) => !!x));
  if (!names.length) return [];
  const out: VNode[] = [];
  let y = top;
  const w = n.w - 16;
  for (const name of names) {
    const lines = dnsNameLines(name);
    out.push(
      h('g', { class: 'dns-chip', 'data-ref': 'device:' + d.id, 'data-dns': name }, [
        h('rect', { x: n.cx - w / 2, y, width: w, height: lines.length * CHIP_H - 3, rx: 6.5 }),
        ...lines.map((l, i) => h('text', { x: n.cx, y: y + 9.5 + i * CHIP_H, 'text-anchor': 'middle', 'font-size': CHIP_FONT }, l)),
      ]),
    );
    y += lines.length * CHIP_H;
  }
  return out;
}

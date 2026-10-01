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
 *   are derived from the addresses inside the network's prefixes.
 * - Groups / locations are frames around their devices, as in the physical
 *   view (auto-arrange keeps the devices of a group together).
 * - All text is drawn in full. Every relation label gets its own place along
 *   (or, on a short line, beside) its bundle, clear of nodes and of the labels
 *   placed before it; see diagram/labels.ts.
 */
import { CBox, Pt, Rect, boxRect, clipToBox, clipToCircle, lineBoxExit, normal, textWidth, unionRect } from '../layout/geometry';
import { LINE_W, TUBE_MIN, TUBE_WALL, buildBundle, laneLabel, relationPairs } from '../layout/bundles';
import { CHIP_H, HUB_R, LNode, LogicalLayout, MAX_CHIPS, commonChain, deviceRect, isMultipoint, networkSubtitle } from '../layout/logical';
import { CHIP_FONT, MEMBER_LABEL_SIZE, NET_LABEL_SIZE, loopbackChipText, networkBody, pillBox } from '../layout/sizes';
import { TextBlock } from '../layout/text';
import { networkMembers } from '../model/derive';
import { sortedByName } from '../model/order';
import { Device, LineStyle, Model, ProtocolDef, Relation, loopbacks, relationDevices } from '../model/types';
import { LabelPlacer, alongSegment, centerRect, textLines } from './labels';
import { cssToken, deviceNode, deviceSubtitle, groupFrames, groupRects, SceneResult } from './physical';
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

/** Segment between two boxes along the center line shifted by `offset` (parallel lanes). */
function laneSegment(A: CBox, B: CBox, offset: number): [Pt, Pt] {
  const ca = { x: A.cx, y: A.cy };
  const cb = { x: B.cx, y: B.cy };
  const nrm = normal(ca, cb);
  const pa = { x: ca.x + nrm.x * offset, y: ca.y + nrm.y * offset };
  const pb = { x: cb.x + nrm.x * offset, y: cb.y + nrm.y * offset };
  const ta = lineBoxExit(A, pa, pb, 2);
  const tb = lineBoxExit(B, pb, pa, 2);
  // If the shifted line misses a box (very wide bundles), fan the lane out from the box edge instead.
  const s = ta !== null && ta < 1 ? { x: pa.x + (pb.x - pa.x) * ta, y: pa.y + (pb.y - pa.y) * ta } : clipToBox(A, pb, 2);
  const e = tb !== null && tb < 1 ? { x: pb.x + (pa.x - pb.x) * tb, y: pb.y + (pa.y - pb.y) * tb } : clipToBox(B, pa, 2);
  return [s, e];
}

function nodeBorder(n: LNode, toward: Pt): Pt {
  return n.kind === 'hub' ? clipToCircle({ x: n.cx, y: n.cy }, HUB_R, toward) : clipToBox(n, toward, 2);
}

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
  const groupNodes = showGroups ? groupFrames(model, grects, placer) : [];
  nodes.forEach((n) => {
    if (n.kind === 'network' && !opts.showNetworks) return;
    placer.block(boxRect(n, 3));
  });

  const members: VNode[] = [];
  const relNodes: VNode[] = [];
  const labels: VNode[] = [];
  const nodeLayer: VNode[] = [];
  const memberLabels: Array<{ ref: string; s: Pt; e: Pt; text: string }> = [];

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
        if (opts.showLabels) {
          // the address that makes the device a member (the first one, if several match)
          const addr = m.matches[0].address + (m.matches.length > 1 ? ` +${m.matches.length - 1}` : '');
          memberLabels.push({ ref: 'network:' + nw.id, s, e, text: addr });
        }
      }
    }
  }

  // ---- two-device relations: group by device pair, nest carried relations
  const multi: Relation[] = visible.filter((r) => isMultipoint(relationDevices(r)));
  const byPair = relationPairs(visible);

  byPair.forEach((rels, key) => {
    const [da, db] = key.split('\u0000');
    const A = dev(da) as LNode;
    const B = dev(db) as LNode;
    const placed = buildBundle(model, key, rels).lanes;
    const rootsPlaced = placed.filter((p) => p.root);
    for (const p of placed) {
      const [s, e] = laneSegment(A, B, p.offset);
      const d = lineD(s, e);
      const children: VNode[] = [h('path', { class: 'hit', d, 'stroke-width': Math.max(10, p.width) }), ...relationStroke(p.def, d, p.width)];
      if (p.rel.directed) children.push(arrowHead(endTip(p.rel, s, e, da), endFrom(p.rel, s, e, da), p.def.color));
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
    }
    if (opts.showLabels) {
      // One label per lane that is not nested. They are written one after the
      // other along the bundle, each next to its own lane; on a line too short
      // for that they are stacked across it. Each then takes the nearest free
      // place, so no two labels (and no label and node) share a spot.
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      const dl = Math.hypot(dx, dy) || 1;
      const ux = dx / dl;
      const uy = dy / dl;
      const items = rootsPlaced.map((p) => {
        const box = pillBox(laneLabel(p));
        return { p, box, ext: Math.abs(ux) * box.w + Math.abs(uy) * box.h + 6 };
      });
      const total = items.reduce((s, it) => s + it.ext, 0);
      const [cs, ce] = laneSegment(A, B, 0);
      const room = Math.hypot(ce.x - cs.x, ce.y - cs.y) - 16;
      const alongOk = items.length === 1 || total <= room;
      let along = -total / 2;
      let across = -items.reduce((s, it) => s + it.box.h + 3, 0) / 2;
      for (const it of items) {
        const [s, e] = laneSegment(A, B, it.p.offset);
        const len = Math.hypot(e.x - s.x, e.y - s.y) || 1;
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
        labels.push(pill('relation:' + it.p.rel.id, c, it.box, it.p.def.color));
      }
    }
  });

  // ---- multipoint relations: hub + spokes
  for (const r of multi) {
    const hub = nodes.get('hub:' + r.id);
    if (!hub) continue;
    const def = relationStyle(model, r);
    const kids: VNode[] = [];
    for (const d of relationDevices(r)) {
      const dn = dev(d) as LNode;
      const s = clipToBox(dn, { x: hub.cx, y: hub.cy }, 2);
      const e = nodeBorder(hub, { x: dn.cx, y: dn.cy });
      const dd = lineD(s, e);
      kids.push(h('path', { class: 'hit', d: dd }), ...relationStroke(def, dd, TUBE_MIN));
    }
    kids.push(h('circle', { class: 'hub', cx: hub.cx, cy: hub.cy, r: HUB_R, stroke: def.color }));
    kids.push(h('text', { class: 'hub-glyph', x: hub.cx, y: hub.cy + 4, 'text-anchor': 'middle', fill: def.color }, String(relationDevices(r).length)));
    relNodes.push(h('g', { class: `rel hub-rel cat-${def.category} style-${def.style} proto-${cssToken(r.protocol)}`, 'data-ref': 'relation:' + r.id }, kids));
    if (opts.showLabels) {
      const box = pillBox(def.label + (r.label ? ' · ' + r.label : ''));
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
      labels.push(pill('relation:' + r.id, c, box, def.color));
    }
  }

  // ---- addresses on membership lines: near the device, moved along the line where that spot is taken
  for (const ml of memberLabels) {
    const w = textWidth(ml.text, MEMBER_LABEL_SIZE) + 4;
    // fallbacks, tried only when every usual spot is taken: right beside the device, where the line leaves it (or across it)
    const c = placer.place(alongSegment(ml.s, ml.e, 0.22, [0, 22, 44, 70, 100, -14], [0, -12, 12]).concat(alongSegment(ml.s, ml.e, 0, [w / 2 + 6, w / 2 + 20], [0, -12, 12, -24, 24])), w, 12);
    labelRects.push(centerRect(c, w, 12));
    labels.push(h('text', { class: 'halo member-label', 'data-ref': ml.ref, x: c.x, y: c.y + 3.5, 'text-anchor': 'middle' }, ml.text));
  }

  // ---- nodes
  nodes.forEach((n) => {
    if (n.kind === 'device') {
      const d = model.index.devices.get(n.id);
      if (!d) return;
      nodeLayer.push(deviceNode(n.ref, d.label, deviceSubtitle(d.type), d.type, deviceRect(n), 'type-' + cssToken(d.type)));
      nodeLayer.push(...loopbackChips(d, n));
    } else if (n.kind === 'network' && opts.showNetworks) {
      const nw = model.index.networks.get(n.id);
      if (!nw) return;
      const color = NETWORK_COLOR;
      const x = n.cx - n.w / 2;
      const y = n.cy - n.h / 2;
      const body = networkBody(nw.label, networkSubtitle(nw.cidr, nw.vlan));
      const top = n.cy - (body.label.h + body.sub.h) / 2;
      const rx = Math.min(n.h / 2, 21);
      nodeLayer.push(
        h('g', { class: 'node network', 'data-ref': n.ref }, [
          h('rect', { class: 'net-box', x, y, width: n.w, height: n.h, rx, stroke: color }),
          h('rect', { class: 'net-tint', x, y, width: n.w, height: n.h, rx, fill: color }),
          textLines({ class: 'net-label', 'text-anchor': 'middle', 'font-size': NET_LABEL_SIZE }, body.label, n.cx, top),
          body.sub.lines.length ? textLines({ class: 'net-sub', 'text-anchor': 'middle' }, body.sub, n.cx, top + body.label.h) : null,
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
  return {
    root: h('g', { class: 'scene scene-logical' }, [
      h('g', { class: 'layer-groups' }, groupNodes),
      h('g', { class: 'layer-members' }, members),
      h('g', { class: 'layer-relations' }, relNodes),
      h('g', { class: 'layer-nodes' }, nodeLayer),
      h('g', { class: 'layer-labels' }, labels),
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

/** For a directed relation the arrow points at the last endpoint's device. */
function endTip(r: Relation, s: Pt, e: Pt, firstSorted: string): Pt {
  const target = r.endpoints[r.endpoints.length - 1].device;
  return target === firstSorted ? s : e;
}
function endFrom(r: Relation, s: Pt, e: Pt, firstSorted: string): Pt {
  const target = r.endpoints[r.endpoints.length - 1].device;
  return target === firstSorted ? e : s;
}

/** A relation label: its full text (wrapped if long) in a rounded box, centered at `p`. */
function pill(ref: string, p: Pt, box: { block: TextBlock; w: number; h: number }, color: string): VNode {
  return h('g', { class: 'pill', 'data-ref': ref }, [
    h('rect', { class: 'pill-box', x: p.x - box.w / 2, y: p.y - box.h / 2, width: box.w, height: box.h, rx: 9, stroke: color }),
    textLines({ class: 'pill-text', 'text-anchor': 'middle' }, box.block, p.x, p.y - box.block.h / 2),
  ]);
}

/** Loopbacks as small chips hanging under the device, in alphabetical order (logical view only; they are never cabled). */
function loopbackChips(d: Device, n: LNode): VNode[] {
  const loops = sortedByName(loopbacks(d), (l) => l.id);
  if (!loops.length) return [];
  const out: VNode[] = [];
  const top = n.cy - n.h / 2 + (n.bodyH || 0) + 4;
  const w = n.w - 16;
  loops.slice(0, MAX_CHIPS).forEach((l, i) => {
    const text = loopbackChipText(l.id, l.addresses);
    const y = top + i * CHIP_H;
    out.push(
      h('g', { class: 'loop-chip', 'data-ref': `iface:${d.id}:${l.id}` }, [
        h('rect', { x: n.cx - w / 2, y, width: w, height: CHIP_H - 3, rx: 6.5 }),
        h('text', { x: n.cx, y: y + 9.5, 'text-anchor': 'middle', 'font-size': CHIP_FONT }, text),
      ]),
    );
  });
  if (loops.length > MAX_CHIPS) {
    out.push(h('text', { class: 'loop-more', x: n.cx, y: top + MAX_CHIPS * CHIP_H + 9, 'text-anchor': 'middle', 'data-ref': 'device:' + d.id }, `+${loops.length - MAX_CHIPS} more loopbacks`));
  }
  return out;
}

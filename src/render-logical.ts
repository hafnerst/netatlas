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
 * - Networks are pill nodes connected to member devices by thin lines.
 */
import { CBox, Pt, Rect, clipToBox, clipToCircle, ellipsize, lineBoxExit, normal, textWidth, unionRect } from './geometry';
import { CHIP_H, DEVICE_H, HUB_R, LNode, LogicalLayout, MAX_CHIPS, deviceRect, isMultipoint, networkSubtitle } from './layout-logical';
import { Device, LineStyle, Model, ProtocolDef, Relation, ifaceKey, loopbacks, relationDevices } from './model';
import { cssToken, deviceNode, deviceSubtitle, SceneResult } from './render-physical';
import { VNode, h } from './scene';
import { networkColor } from './style';
import { relationStyle } from './validate';

export interface LogicalOptions {
  showLabels: boolean;
  showUnderlay: boolean;
  showNetworks: boolean;
  hiddenProtocols: Set<string>;
  positions: Map<string, Pt>;
}

const LANE_GAP = 7;
const TUBE_WALL = 3;
const TUBE_MIN = 12;
const LINE_W = 2.4;

interface Lane {
  rel: Relation;
  def: ProtocolDef;
  width: number;
  children: Lane[];
}

interface PlacedLane {
  rel: Relation;
  def: ProtocolDef;
  offset: number;
  width: number;
  depth: number;
  /** label describing the nested stack, e.g. "IPsec › GRE › OSPF" */
  stack: string;
  root: boolean;
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
  const visibleIds = new Set(visible.map((r) => r.id));

  const underlay: VNode[] = [];
  const members: VNode[] = [];
  const relNodes: VNode[] = [];
  const labels: VNode[] = [];
  const nodeLayer: VNode[] = [];

  // ---- faint physical underlay (optional)
  if (opts.showUnderlay) {
    const seen = new Set<string>();
    for (const l of model.links) {
      const a = dev(l.a.device);
      const b = dev(l.b.device);
      if (!a || !b || a === b) continue;
      const key = [l.a.device, l.b.device].sort().join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      const s = clipToBox(a, { x: b.cx, y: b.cy });
      const e = clipToBox(b, { x: a.cx, y: a.cy });
      underlay.push(h('path', { class: 'underlay', 'data-ref': 'link:' + l.id, d: lineD(s, e) }));
    }
  }

  // ---- network membership
  if (opts.showNetworks) {
    for (const nw of model.networks) {
      const nn = nodes.get('network:' + nw.id);
      if (!nn) continue;
      for (const m of nw.members) {
        const dn = dev(m.device);
        if (!dn) continue;
        const s = clipToBox(dn, { x: nn.cx, y: nn.cy }, 1);
        const e = clipToBox(nn, { x: dn.cx, y: dn.cy }, 1);
        members.push(h('path', { class: 'member', 'data-ref': 'network:' + nw.id, d: lineD(s, e) }));
        if (opts.showLabels) {
          const iface = m.iface ? model.index.interfaces.get(ifaceKey(m.device, m.iface)) : undefined;
          const addr = m.address || (iface && iface.addresses[0]) || m.iface;
          if (addr) {
            const t = { x: s.x + (e.x - s.x) * 0.22, y: s.y + (e.y - s.y) * 0.22 };
            labels.push(h('text', { class: 'halo member-label', 'data-ref': 'network:' + nw.id, x: t.x, y: t.y + 3, 'text-anchor': 'middle' }, ellipsize(addr, 10, 150)));
          }
        }
      }
    }
  }

  // ---- two-device relations: group by device pair, nest carried relations
  const byPair = new Map<string, Relation[]>();
  const multi: Relation[] = [];
  for (const r of visible) {
    const ds = relationDevices(r);
    if (isMultipoint(ds)) multi.push(r);
    else if (ds.length === 2) {
      const key = ds.slice().sort().join('\u0000');
      if (!byPair.has(key)) byPair.set(key, []);
      (byPair.get(key) as Relation[]).push(r);
    }
  }

  byPair.forEach((rels, key) => {
    const [da, db] = key.split('\u0000');
    const A = dev(da) as LNode;
    const B = dev(db) as LNode;
    const inPair = new Set(rels.map((r) => r.id));
    const lanes = new Map<string, Lane>();
    for (const r of rels) {
      lanes.set(r.id, { rel: r, def: relationStyle(model, r), width: 0, children: [] });
    }
    const roots: Lane[] = [];
    for (const r of rels) {
      const carrier = r.over.find((o) => inPair.has(o) && visibleIds.has(o) && (lanes.get(o) as Lane).def.style === 'tube');
      if (carrier && carrier !== r.id) (lanes.get(carrier) as Lane).children.push(lanes.get(r.id) as Lane);
      else roots.push(lanes.get(r.id) as Lane);
    }
    // guard against cycles (validated already, but never loop forever)
    const measure = (ln: Lane, depth: number): number => {
      if (depth > 12) ln.children = [];
      const kids = ln.children.map((c) => measure(c, depth + 1));
      if (ln.def.style === 'tube') {
        const inner = kids.length ? kids.reduce((s, w) => s + w, 0) + 3 * (kids.length - 1) : 0;
        ln.width = Math.max(TUBE_MIN, inner + 2 * TUBE_WALL + 4);
      } else ln.width = LINE_W + 3;
      return ln.width;
    };
    roots.forEach((r) => measure(r, 0));
    // sort lanes: tunnels (widest) in the middle keeps the bundle symmetric
    roots.sort((u, v) => u.width - v.width || (u.rel.id < v.rel.id ? -1 : 1));
    const ordered: Lane[] = [];
    roots.forEach((ln, i) => (i % 2 ? ordered.unshift(ln) : ordered.push(ln)));
    const total = ordered.reduce((s, l) => s + l.width, 0) + LANE_GAP * (ordered.length - 1);
    const placed: PlacedLane[] = [];
    const stackLabel = (ln: Lane): string =>
      ln.def.label +
      (ln.children.length === 1
        ? ' › ' + stackLabel(ln.children[0])
        : ln.children.length > 1
          ? ' › (' + ln.children.map(stackLabel).join(', ') + ')'
          : '');
    const place = (ln: Lane, offset: number, depth: number, root: boolean): void => {
      placed.push({ rel: ln.rel, def: ln.def, offset, width: ln.width, depth, stack: stackLabel(ln), root });
      if (!ln.children.length) return;
      const inner = ln.children.reduce((s, c) => s + c.width, 0) + 3 * (ln.children.length - 1);
      let cur = offset - inner / 2;
      for (const c of ln.children) {
        place(c, cur + c.width / 2, depth + 1, false);
        cur += c.width + 3;
      }
    };
    let cur = -total / 2;
    for (const ln of ordered) {
      place(ln, cur + ln.width / 2, 0, true);
      cur += ln.width + LANE_GAP;
    }
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
      // spread the pills along the bundle by their projected size so they never overlap
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      const dl = Math.hypot(dx, dy) || 1;
      const ux = dx / dl;
      const uy = dy / dl;
      const items = rootsPlaced.map((p) => {
        const text = ellipsize(p.stack + (p.rel.label ? ' · ' + p.rel.label : ''), 10, 260);
        const w = textWidth(text, 10) + 14;
        return { p, text, ext: Math.abs(ux) * w + Math.abs(uy) * 18 + 5 };
      });
      const total = items.reduce((s, it) => s + it.ext, 0);
      const [cs, ce] = laneSegment(A, B, 0);
      const room = Math.hypot(ce.x - cs.x, ce.y - cs.y) - 16;
      if (total <= room || items.length === 1) {
        let along = -total / 2;
        for (const it of items) {
          const [s, e] = laneSegment(A, B, it.p.offset);
          const c = along + it.ext / 2;
          along += it.ext;
          labels.push(pill('relation:' + it.p.rel.id, { x: (s.x + e.x) / 2 + ux * c, y: (s.y + e.y) / 2 + uy * c }, it.text, it.p.def.color));
        }
      } else {
        // not enough room along a short edge: stack the pills across it instead
        const mx = (cs.x + ce.x) / 2;
        const my = (cs.y + ce.y) / 2;
        items.forEach((it, i) => {
          const k = (i - (items.length - 1) / 2) * 21;
          labels.push(pill('relation:' + it.p.rel.id, { x: mx - uy * k, y: my + ux * k }, it.text, it.p.def.color));
        });
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
      const text = def.label + (r.label ? ' · ' + r.label : '');
      labels.push(pill('relation:' + r.id, { x: hub.cx, y: hub.cy + HUB_R + 13 }, ellipsize(text, 10, 200), def.color));
    }
  }

  // ---- nodes
  nodes.forEach((n) => {
    if (n.kind === 'device') {
      const d = model.index.devices.get(n.id);
      if (!d) return;
      nodeLayer.push(deviceNode(n.ref, d.label, deviceSubtitle(d.type, d.model, d.role), d.type, deviceRect(n), 'type-' + cssToken(d.type)));
      nodeLayer.push(...loopbackChips(d, n));
    } else if (n.kind === 'network' && opts.showNetworks) {
      const nw = model.index.networks.get(n.id);
      if (!nw) return;
      const color = networkColor(nw.kind);
      const x = n.cx - n.w / 2;
      const y = n.cy - n.h / 2;
      const sub = networkSubtitle(nw.kind, nw.cidr, nw.vlan);
      nodeLayer.push(
        h('g', { class: `node network kind-${cssToken(nw.kind)}`, 'data-ref': n.ref }, [
          h('rect', { class: 'net-box', x, y, width: n.w, height: n.h, rx: n.h / 2, stroke: color }),
          h('rect', { class: 'net-tint', x, y, width: n.w, height: n.h, rx: n.h / 2, fill: color }),
          h('text', { class: 'net-label', x: n.cx, y: n.cy + (sub ? -2 : 4), 'text-anchor': 'middle' }, ellipsize(nw.label, 12, n.w - 20)),
          sub ? h('text', { class: 'net-sub', x: n.cx, y: n.cy + 12, 'text-anchor': 'middle' }, ellipsize(sub, 10, n.w - 20)) : null,
        ]),
      );
    }
  });

  const rects: Rect[] = [];
  nodes.forEach((n) => {
    if (n.kind === 'network' && !opts.showNetworks) return;
    rects.push({ x: n.cx - n.w / 2 - 60, y: n.cy - n.h / 2 - 50, w: n.w + 120, h: n.h + 100 });
  });
  return {
    root: h('g', { class: 'scene scene-logical' }, [
      h('g', { class: 'layer-underlay' }, underlay),
      h('g', { class: 'layer-members' }, members),
      h('g', { class: 'layer-relations' }, relNodes),
      h('g', { class: 'layer-nodes' }, nodeLayer),
      h('g', { class: 'layer-labels' }, labels),
    ]),
    bounds: unionRect(rects),
  };
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

function pill(ref: string, p: Pt, text: string, color: string): VNode {
  const w = textWidth(text, 10) + 14;
  return h('g', { class: 'pill', 'data-ref': ref }, [
    h('rect', { class: 'pill-box', x: p.x - w / 2, y: p.y - 9, width: w, height: 18, rx: 9, stroke: color }),
    h('text', { class: 'pill-text', x: p.x, y: p.y + 3.5, 'text-anchor': 'middle' }, text),
  ]);
}

/** Loopbacks as small chips hanging under the device (logical view only; they are never cabled). */
function loopbackChips(d: Device, n: LNode): VNode[] {
  const loops = loopbacks(d);
  if (!loops.length) return [];
  const out: VNode[] = [];
  const top = n.cy - n.h / 2 + DEVICE_H + 4;
  const w = n.w - 16;
  loops.slice(0, MAX_CHIPS).forEach((l, i) => {
    const rid = d.routerId === l.id;
    const extra = l.addresses.length > 1 ? ' +' + (l.addresses.length - 1) : '';
    const text = (rid ? '\u2605 ' : '') + l.id + '  ' + (l.addresses[0] || '(no address)') + extra;
    const y = top + i * CHIP_H;
    out.push(
      h('g', { class: 'loop-chip' + (rid ? ' rid' : ''), 'data-ref': `iface:${d.id}:${l.id}` }, [
        h('rect', { x: n.cx - w / 2, y, width: w, height: CHIP_H - 3, rx: 6.5 }),
        h('text', { x: n.cx, y: y + 9.5, 'text-anchor': 'middle' }, ellipsize(text, 9.5, w - 8)),
      ]),
    );
  });
  if (loops.length > MAX_CHIPS) {
    out.push(h('text', { class: 'loop-more', x: n.cx, y: top + MAX_CHIPS * CHIP_H + 9, 'text-anchor': 'middle', 'data-ref': 'device:' + d.id }, `+${loops.length - MAX_CHIPS} more loopbacks`));
  }
  return out;
}

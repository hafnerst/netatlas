/**
 * Physical view renderer: groups, devices, ports and cables.
 *
 * - Every label is drawn in full; boxes are sized for their text by the
 *   layout (layout/sizes.ts) and the text wraps inside them.
 * - A cable whose two ports face each other on one line is a single straight
 *   segment. Otherwise it leaves each port at a right angle and runs straight
 *   between the two stubs; if that would pass through a device, it bends
 *   around the device.
 * - Cable labels are placed on the cable's longest segment, away from
 *   devices, port labels and other cable labels.
 */
import { CBox, Pt, Rect, boxRect, segmentHitsRect, textWidth, unionRect } from '../layout/geometry';
import { linkLabelText, linkVlanLabel } from '../layout/input';
import { GROUP_PAD, PORT_FONT, PORT_LABEL_GAP, PhysicalLayout, PortPos, assignPorts } from '../layout/physical';
import { DEVICE_ICON, DEVICE_TEXT_X, deviceBody, groupHeader, linkLabelBox } from '../layout/sizes';
import { vlanMismatch } from '../model/derive';
import { deviceSubtitle } from '../model/device-types';
import { Model } from '../model/types';
import { deviceIcon } from './icons';
import { LabelPlacer, alongSegment, centerRect, textLines } from './labels';
import { VNode, h } from './scene';
import { groupKindStyle, mediumStyle, speedWidth } from './style';

export { deviceSubtitle, linkVlanLabel };

export interface ViewOptions {
  showLabels: boolean;
  /** draw the frames of groups / locations (default true); hiding them never moves a device */
  showGroups?: boolean;
  /** user-dragged node centers, keyed by ref ("device:x", "network:y", "hub:z") */
  positions: Map<string, Pt>;
}

export interface SceneResult {
  root: VNode;
  bounds: Rect;
}

const STUB = 20;

/** Device boxes after applying user drags. */
export function physicalBoxes(layout: PhysicalLayout, positions: Map<string, Pt>): Map<string, CBox> {
  const boxes = new Map<string, CBox>();
  layout.boxes.forEach((b, id) => {
    const o = positions.get('device:' + id);
    boxes.set(id, o ? { ...b, cx: o.x, cy: o.y } : { ...b });
  });
  return boxes;
}

/** Group rectangles derived bottom-up from their contents; wide enough for their title. */
export function groupRects(model: Model, boxes: Map<string, CBox>): Map<string, Rect> {
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const g = model.index.groups.get(id);
    const d = g && g.parent ? depthOf(g.parent) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  model.groups.forEach((g) => depthOf(g.id));
  const rects = new Map<string, Rect>();
  const deepestFirst = model.groups.slice().sort((a, b) => (depth.get(b.id) as number) - (depth.get(a.id) as number));
  for (const g of deepestFirst) {
    const parts: Rect[] = [];
    for (const d of model.devices) {
      // a device that isn't drawn (the logical view leaves out devices without logical relations) has no box
      const b = d.group === g.id ? boxes.get(d.id) : undefined;
      if (b) parts.push(boxRect(b));
    }
    for (const c of model.groups) if (c.parent === g.id && rects.has(c.id)) parts.push(rects.get(c.id) as Rect);
    if (!parts.length) continue;
    const u = unionRect(parts);
    const head = groupHeader(g.label, g.kind, u.w);
    const w = Math.max(u.w + 2 * GROUP_PAD, head.minW);
    rects.set(g.id, { x: u.x + u.w / 2 - w / 2, y: u.y - GROUP_PAD - head.h, w, h: u.h + 2 * GROUP_PAD + head.h });
  }
  return rects;
}

/**
 * The frames of groups / locations (outermost first, so children draw on
 * top), with title and kind. Used by both views. Each title is blocked for
 * the label placer, so no label is placed on it.
 */
export function groupFrames(model: Model, grects: Map<string, Rect>, placer: LabelPlacer): VNode[] {
  const out: VNode[] = [];
  const depthSorted = model.groups.filter((g) => grects.has(g.id));
  const depthOf = (id: string): number => {
    let d = 0;
    let g = model.index.groups.get(id);
    while (g && g.parent) {
      d++;
      g = model.index.groups.get(g.parent);
    }
    return d;
  };
  depthSorted.sort((a, b) => depthOf(a.id) - depthOf(b.id));
  for (const g of depthSorted) {
    const r = grects.get(g.id) as Rect;
    const ks = groupKindStyle(g.kind);
    const head = groupHeader(g.label, g.kind, r.w - 2 * GROUP_PAD);
    out.push(
      h('g', { class: `group kind-${cssToken(g.kind)} ${ks.strong ? 'group-strong' : ''}`, 'data-ref': 'group:' + g.id }, [
        h('rect', { class: 'group-box', x: r.x, y: r.y, width: r.w, height: r.h, rx: 12, 'stroke-dasharray': ks.dash }),
        textLines({ class: 'group-title' }, head.title, r.x + 14, r.y + 7),
        head.kind ? h('text', { class: 'group-kind', x: r.x + r.w - 12, y: r.y + 20, 'text-anchor': 'end' }, head.kind) : null,
      ]),
    );
    placer.block({ x: r.x + 10, y: r.y + 5, w: head.title.w + 8, h: head.title.h + 4 });
  }
  return out;
}

/** A device box with its icon and its full, wrapped label and subtitle. */
export function deviceNode(ref: string, label: string, sub: string, type: string, b: CBox, extraClass = ''): VNode {
  const x = b.cx - b.w / 2;
  const y = b.cy - b.h / 2;
  const body = deviceBody(label, sub, 0, 0);
  const textX = x + DEVICE_TEXT_X;
  const top = b.cy - body.textH / 2;
  return h('g', { class: 'node device ' + extraClass, 'data-ref': ref }, [
    h('rect', { class: 'dev-box', x, y, width: b.w, height: b.h, rx: 8 }),
    deviceIcon(type, x + 12, b.cy - DEVICE_ICON / 2, DEVICE_ICON),
    textLines({ class: 'dev-label' }, body.label, textX, top),
    body.sub.lines.length ? textLines({ class: 'dev-sub' }, body.sub, textX, top + body.textH - body.sub.h) : null,
  ]);
}

/** Where the label of a port is drawn, and the rectangle it covers. */
function portLabelBox(p: PortPos): { x: number; y: number; anchor: string; rect: Rect } {
  const w = textWidth(p.iface as string, PORT_FONT);
  if (p.side === 'top' || p.side === 'bottom') {
    const y = p.y + p.ny * 12 + (p.side === 'top' ? -1 : 8);
    return { x: p.x, y, anchor: 'middle', rect: { x: p.x - w / 2, y: y - 9, w, h: 12 } };
  }
  const x = p.x + p.nx * PORT_LABEL_GAP;
  const y = p.y - 5;
  return { x, y, anchor: p.side === 'left' ? 'end' : 'start', rect: { x: p.side === 'left' ? x - w : x, y: y - 9, w, h: 12 } };
}

/**
 * Way points between `s` and `e` that lead around the device boxes the
 * straight line would pass through (at most a few bends).
 */
function detour(s: Pt, e: Pt, obstacles: Rect[], depth: number): Pt[] {
  if (depth >= 4) return [];
  let hit: Rect | null = null;
  let hitD = Infinity;
  for (const o of obstacles) {
    if (!segmentHitsRect(s, e, o)) continue;
    const d = Math.hypot(o.x + o.w / 2 - s.x, o.y + o.h / 2 - s.y);
    if (d < hitD) {
      hitD = d;
      hit = o;
    }
  }
  if (!hit) return [];
  const m = 12;
  const corners: Pt[] = [
    { x: hit.x - m, y: hit.y - m },
    { x: hit.x + hit.w + m, y: hit.y - m },
    { x: hit.x - m, y: hit.y + hit.h + m },
    { x: hit.x + hit.w + m, y: hit.y + hit.h + m },
  ];
  const len = (p: Pt, q: Pt): number => Math.hypot(q.x - p.x, q.y - p.y);
  const clear = (p: Pt, q: Pt): boolean => !segmentHitsRect(p, q, hit as Rect);
  // around one corner, or, when the box lies squarely in the way, along one of its sides (two corners)
  const ways: Pt[][] = corners.map((c) => [c]);
  for (const [i, j] of [[0, 2], [1, 3], [0, 1], [2, 3]]) {
    ways.push([corners[i], corners[j]], [corners[j], corners[i]]);
  }
  const usable = ways
    .map((w, i) => ({ w, i, cost: len(s, w[0]) + (w.length > 1 ? len(w[0], w[1]) : 0) + len(w[w.length - 1], e) }))
    .filter((x) => clear(s, x.w[0]) && clear(x.w[x.w.length - 1], e))
    .sort((p, q) => p.cost - q.cost || p.i - q.i);
  if (!usable.length) return [];
  const w = usable[0].w;
  return [...detour(s, w[0], obstacles, depth + 1), ...w, ...detour(w[w.length - 1], e, obstacles, depth + 1)];
}

/** The points of a cable from port to port. */
export function cableRoute(pa: PortPos, pb: PortPos, boxes: Map<string, Rect>): Pt[] {
  const obstacles = Array.from(boxes.values());
  const facing = pa.nx === -pb.nx && pa.ny === -pb.ny;
  const a = { x: pa.x, y: pa.y };
  const b = { x: pb.x, y: pb.y };
  // two ports looking at each other on one line: one straight segment
  if (facing && (pa.nx !== 0 ? Math.abs(pa.y - pb.y) < 0.5 && (pb.x - pa.x) * pa.nx > 0 : Math.abs(pa.x - pb.x) < 0.5 && (pb.y - pa.y) * pa.ny > 0)) {
    let blocked = false;
    boxes.forEach((o, id) => {
      if (id !== pa.device && id !== pb.device && segmentHitsRect(a, b, o)) blocked = true;
    });
    if (!blocked) return [a, b];
  }
  const sa = { x: pa.x + pa.nx * STUB, y: pa.y + pa.ny * STUB };
  const sb = { x: pb.x + pb.nx * STUB, y: pb.y + pb.ny * STUB };
  return [a, sa, ...detour(sa, sb, obstacles, 0), sb, b];
}

export function renderPhysical(model: Model, layout: PhysicalLayout, opts: ViewOptions): SceneResult {
  const boxes = physicalBoxes(layout, opts.positions);
  const grects = groupRects(model, boxes);
  const ports = assignPorts(model.links, boxes);
  const portByKey = new Map<string, PortPos>(ports.map((p) => [p.key, p] as [string, PortPos]));
  const placer = new LabelPlacer();
  const obstacles = new Map<string, Rect>();
  model.devices.forEach((d) => {
    const b = boxes.get(d.id) as CBox;
    placer.block(boxRect(b, 2));
    obstacles.set(d.id, boxRect(b, 5));
  });

  // ---- groups (outermost first so children draw on top)
  const showGroups = opts.showGroups !== false;
  const groupNodes = showGroups ? groupFrames(model, grects, placer) : [];

  // ---- ports and cables: port labels first, they have fixed places
  const linkNodes: VNode[] = [];
  const labelNodes: VNode[] = [];
  const portNodes: VNode[] = [];
  const drawn = model.links
    .map((l) => ({ l, pa: portByKey.get(l.id + ':a'), pb: portByKey.get(l.id + ':b') }))
    .filter((x): x is { l: typeof x.l; pa: PortPos; pb: PortPos } => !!x.pa && !!x.pb);
  const extra: Rect[] = [];
  if (opts.showLabels) {
    for (const { pa, pb } of drawn) {
      for (const p of [pa, pb]) {
        if (!p.iface) continue;
        const pl = portLabelBox(p);
        labelNodes.push(h('text', { class: 'halo port-label', 'data-ref': `iface:${p.device}:${p.iface}`, x: pl.x, y: pl.y, 'text-anchor': pl.anchor, 'font-size': PORT_FONT }, p.iface));
        placer.block(pl.rect);
        extra.push(pl.rect);
      }
    }
  }
  // cables in id order, so label placement never depends on the order in the file
  const byId = drawn.slice().sort((p, q) => (p.l.id < q.l.id ? -1 : p.l.id > q.l.id ? 1 : 0));
  const labelAt = new Map<string, VNode[]>();
  for (const { l, pa, pb } of byId) {
    const pts = cableRoute(pa, pb, obstacles);
    // the longest segment carries the label
    let seg = 0;
    let segLen = -1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (d > segLen + 0.01) {
        segLen = d;
        seg = i;
      }
    }
    const out: VNode[] = [];
    const mismatch = !!vlanMismatch(l.a.vlans, l.b.vlans);
    const text = opts.showLabels ? linkLabelText(l) : '';
    let center = { x: (pts[seg].x + pts[seg + 1].x) / 2, y: (pts[seg].y + pts[seg + 1].y) / 2 };
    if (text) {
      const box = linkLabelBox(text);
      const step = Math.max(14, box.h + 2);
      center = placer.place(alongSegment(pts[seg], pts[seg + 1], 0.5, [0, -26, 26, -52, 52, -80, 80, -110, 110], [0, -step, step, -2 * step, 2 * step]), box.w, box.h);
      const r = centerRect(center, box.w, box.h);
      extra.push(r);
      out.push(textLines({ class: 'halo link-label' + (mismatch ? ' vlan-mismatch' : ''), 'data-ref': 'link:' + l.id, 'text-anchor': 'middle' }, box.block, center.x, r.y + 1));
      // a VLAN mismatch is marked next to the label
      if (mismatch) out.push(h('text', { class: 'halo vlan-warn', 'data-ref': 'link:' + l.id, x: center.x, y: r.y - 3, 'text-anchor': 'middle' }, '⚠'));
    } else if (mismatch) {
      // … and on the cable itself when labels are off
      out.push(h('text', { class: 'halo vlan-warn', 'data-ref': 'link:' + l.id, x: center.x, y: center.y - 8, 'text-anchor': 'middle' }, '⚠'));
    }
    labelAt.set(l.id, out);
    for (const p of pts) extra.push({ x: p.x - 8, y: p.y - 8, w: 16, h: 16 });
    const ms = mediumStyle(l.medium);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + n(p.x) + ' ' + n(p.y)).join('');
    labelAt.set(l.id + '\u0000path', [
      h('g', { class: `link cable medium-${cssToken(ms.key)}${mismatch ? ' vlan-mismatch' : ''}${pts.length === 2 ? ' straight' : ''}`, 'data-ref': 'link:' + l.id }, [
        h('path', { class: 'hit', d }),
        h('path', { class: 'cable-line', d, stroke: ms.color, 'stroke-width': speedWidth(l.speed), 'stroke-dasharray': ms.dash }),
      ]),
    ]);
  }
  // emit in model order (as before), whatever order the labels were placed in
  for (const { l, pa, pb } of drawn) {
    const ms = mediumStyle(l.medium);
    linkNodes.push(...(labelAt.get(l.id + '\u0000path') as VNode[]));
    for (const p of [pa, pb]) {
      portNodes.push(
        h('rect', {
          class: 'port',
          'data-ref': p.iface ? `iface:${p.device}:${p.iface}` : 'device:' + p.device,
          x: p.x - 4.5,
          y: p.y - 4.5,
          width: 9,
          height: 9,
          rx: 1.5,
          fill: ms.color,
        }),
      );
    }
    labelNodes.push(...(labelAt.get(l.id) as VNode[]));
  }

  // ---- devices
  const deviceNodes: VNode[] = model.devices.map((d) => {
    const b = boxes.get(d.id) as CBox;
    return deviceNode('device:' + d.id, d.label, deviceSubtitle(d.type), d.type, b, 'type-' + cssToken(d.type));
  });

  // everything drawn is inside the bounds: boxes, groups, labels and cable bends
  const rects: Rect[] = [];
  if (showGroups) grects.forEach((r) => rects.push({ x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 }));
  boxes.forEach((b) => rects.push({ x: b.cx - b.w / 2 - 50, y: b.cy - b.h / 2 - 40, w: b.w + 100, h: b.h + 80 }));
  for (const r of extra) rects.push({ x: r.x - 12, y: r.y - 12, w: r.w + 24, h: r.h + 24 });
  const bounds = unionRect(rects);

  return {
    root: h('g', { class: 'scene scene-physical' }, [
      h('g', { class: 'layer-groups' }, groupNodes),
      h('g', { class: 'layer-links' }, linkNodes),
      h('g', { class: 'layer-nodes' }, deviceNodes),
      h('g', { class: 'layer-ports' }, portNodes),
      h('g', { class: 'layer-labels' }, labelNodes),
    ]),
    bounds,
  };
}

function n(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** Safe token for use inside a class name (input-derived strings only ever reach classes through this). */
export function cssToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
}

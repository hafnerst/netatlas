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
 * - The addresses and identifiers of a device's interfaces are entries in
 *   its box (model/addresses.ts), each named by its interface, so its owner
 *   is never in doubt and no floating label can cover it.
 */
import { CBox, Pt, Rect, boxRect, rectsOverlap, segmentHitsRect, textWidth, unionRect } from '../layout/geometry';
import { entryTexts, linkLabelExtra, linkLabelText, linkNetworkLabel } from '../layout/input';
import { GROUP_PAD, PORT_FONT, PORT_LABEL_GAP, PhysicalLayout, PortPos, assignPorts, physicalListH, spareChipFlow } from '../layout/physical';
import { ChipFlow, DEVICE_ICON, DEVICE_TEXT_X, ENTRY_FONT, ENTRY_GAP, ENTRY_LH, ENTRY_MARGIN, ENTRY_PAD_X, ENTRY_PAD_Y, IFCHIP_FONT, IFCHIP_H, IFCHIP_PAD, chipStripH, deviceBody, entriesSize, entryBox, groupHeader, linkLabelBox } from '../layout/sizes';
import { addressAttrLines, deviceEntries } from '../model/addresses';
import { sortedByName } from '../model/order';
import { networkMismatch } from '../model/derive';
import { deviceSubtitle } from '../model/device-types';
import { Device, Model, ifaceKey } from '../model/types';
import { deviceIcon } from './icons';
import { LabelPlacer, alongSegment, centerRect, leaderLine, textLines } from './labels';
import { VNode, h } from './scene';
import { groupKindStyle, mediumStyle, speedWidth } from './style';

export { deviceSubtitle, linkNetworkLabel };

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
  /**
   * What a reader would see as overlapping: labels that found no free place
   * and pairs of overlapping nodes (after moving nodes by hand). 0 after
   * Auto-arrange; the app reports any other number.
   */
  conflicts: number;
}

/** Pairs of overlapping rectangles (node boxes). */
export function nodeOverlaps(rs: Rect[]): number {
  let n = 0;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rectsOverlap(rs[i], rs[j])) n++;
  return n;
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
export function groupRects(model: Model, boxes: Map<string, CBox>, extra: Map<string, Rect[]> = new Map()): Map<string, Rect> {
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
    // other nodes that belong in the group (the logical view's site-local networks and hubs)
    for (const r of extra.get(g.id) || []) parts.push(r);
    for (const c of model.groups) if (c.parent === g.id && rects.has(c.id)) parts.push(rects.get(c.id) as Rect);
    if (!parts.length) continue;
    const u = unionRect(parts);
    const head = groupHeader(g.label, g.kind, u.w, addressAttrLines(g.attrs));
    const w = Math.max(u.w + 2 * GROUP_PAD, head.minW);
    rects.set(g.id, { x: u.x + u.w / 2 - w / 2, y: u.y - GROUP_PAD - head.h, w, h: u.h + 2 * GROUP_PAD + head.h });
  }
  return rects;
}

/**
 * The frames of groups / locations (outermost first, so children draw on
 * top). Used by both views. Their titles and kinds go to `titles`, which
 * the renderers draw in the top layer with a halo, so no cable or relation
 * line drawn across a frame's title can make it hard to read. Each title is
 * blocked for the label placer, so no label is placed on it.
 */
export function groupFrames(model: Model, grects: Map<string, Rect>, placer: LabelPlacer, titles: VNode[] = []): VNode[] {
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
    const head = groupHeader(g.label, g.kind, r.w - 2 * GROUP_PAD, addressAttrLines(g.attrs));
    out.push(
      h('g', { class: `group kind-${cssToken(g.kind)} ${ks.strong ? 'group-strong' : ''}`, 'data-ref': 'group:' + g.id }, [
        h('rect', { class: 'group-box', x: r.x, y: r.y, width: r.w, height: r.h, rx: 12, 'stroke-dasharray': ks.dash }),
      ]),
    );
    titles.push(
      h('g', { class: 'group-label', 'data-ref': 'group:' + g.id }, [
        textLines({ class: 'halo group-title' }, head.title, r.x + 14, r.y + 7),
        head.kind ? h('text', { class: 'halo group-kind', x: r.x + r.w - 12, y: r.y + 20, 'text-anchor': 'end' }, head.kind) : null,
      ]),
    );
    placer.block({ x: r.x + 10, y: r.y + 5, w: head.title.w + 8, h: head.title.h + 4 });
  }
  return out;
}

/**
 * A device box with its icon and its full, wrapped label and subtitle. With
 * `bodyH`, the icon and text are centred in the top `bodyH` of the box (the
 * rest holds the chips of its uncabled ports).
 */
export function deviceNode(ref: string, label: string, sub: string, type: string, b: CBox, extraClass = '', bodyH = b.h): VNode {
  const x = b.cx - b.w / 2;
  const y = b.cy - b.h / 2;
  const body = deviceBody(label, sub, 0, 0);
  const textX = x + DEVICE_TEXT_X;
  const mid = y + bodyH / 2;
  const top = mid - body.textH / 2;
  return h('g', { class: 'node device ' + extraClass, 'data-ref': ref, 'data-endpoint': 'device' }, [
    h('rect', { class: 'dev-box', x, y, width: b.w, height: b.h, rx: 8 }),
    deviceIcon(type, x + 12, mid - DEVICE_ICON / 2, DEVICE_ICON),
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
  const groupTitles: VNode[] = [];
  const groupNodes = showGroups ? groupFrames(model, grects, placer, groupTitles) : [];

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
    const mismatch = !!networkMismatch(l.a.networks, l.b.networks);
    const text = opts.showLabels ? linkLabelText(model, l) : '';
    const lines = opts.showLabels ? linkLabelExtra(l) : [];
    let center = { x: (pts[seg].x + pts[seg + 1].x) / 2, y: (pts[seg].y + pts[seg + 1].y) / 2 };
    if (text || lines.length) {
      const box = linkLabelBox(text, lines);
      const step = Math.max(14, box.h + 2);
      center = placer.place(alongSegment(pts[seg], pts[seg + 1], 0.5, [0, -26, 26, -52, 52, -80, 80, -110, 110], [0, -step, step, -2 * step, 2 * step]), box.w, box.h);
      const r = centerRect(center, box.w, box.h);
      extra.push(r);
      if (placer.leaderFrom) out.push(leaderLine(placer.leaderFrom, r, 'link:' + l.id));
      out.push(textLines({ class: 'halo link-label' + (mismatch ? ' net-mismatch' : ''), 'data-ref': 'link:' + l.id, 'text-anchor': 'middle' }, box.block, center.x, r.y + 1));
      // ends that carry different networks are marked next to the label
      if (mismatch) out.push(h('text', { class: 'halo net-warn', 'data-ref': 'link:' + l.id, x: center.x, y: r.y - 3, 'text-anchor': 'middle' }, '⚠'));
    } else if (mismatch) {
      // … and on the cable itself when labels are off
      out.push(h('text', { class: 'halo net-warn', 'data-ref': 'link:' + l.id, x: center.x, y: center.y - 8, 'text-anchor': 'middle' }, '⚠'));
    }
    labelAt.set(l.id, out);
    for (const p of pts) extra.push({ x: p.x - 8, y: p.y - 8, w: 16, h: 16 });
    const ms = mediumStyle(l.medium);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + n(p.x) + ' ' + n(p.y)).join('');
    labelAt.set(l.id + '\u0000path', [
      h('g', { class: `link cable medium-${cssToken(ms.key)}${mismatch ? ' net-mismatch' : ''}${pts.length === 2 ? ' straight' : ''}`, 'data-ref': 'link:' + l.id }, [
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
          'data-endpoint': p.iface ? 'iface' : 'device',
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

  // ---- devices: label, the entries of their interfaces, and the chips of their uncabled ports at the bottom of the box
  const deviceNodes: VNode[] = model.devices.map((d) => {
    const b = boxes.get(d.id) as CBox;
    const flow = spareChipFlow(spareIds(model, d), b.w);
    const chipsH = chipStripH(flow);
    const items = entryItems(model, d, 'physical');
    const listH = physicalListH(entriesSize(items));
    if (flow.items.length) portNodes.push(...chipNodes(d.id, flow, b.cx - b.w / 2 + IFCHIP_PAD, b.cy + b.h / 2 - chipsH, 'port-chip', () => ''));
    if (items.length) portNodes.push(...entryNodes(items, b.cx - b.w / 2 + ENTRY_MARGIN, b.cy + b.h / 2 - chipsH - listH, b.w - 2 * ENTRY_MARGIN));
    return deviceNode('device:' + d.id, d.label, deviceSubtitle(d.type), d.type, b, 'type-' + cssToken(d.type), b.h - chipsH - listH);
  });

  // everything drawn is inside the bounds: boxes, groups, labels and cable bends
  const rects: Rect[] = [];
  if (showGroups) grects.forEach((r) => rects.push({ x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 }));
  boxes.forEach((b) => rects.push({ x: b.cx - b.w / 2 - 50, y: b.cy - b.h / 2 - 40, w: b.w + 100, h: b.h + 80 }));
  for (const r of extra) rects.push({ x: r.x - 12, y: r.y - 12, w: r.w + 24, h: r.h + 24 });
  const bounds = unionRect(rects);

  return {
    conflicts: placer.conflicts + nodeOverlaps(Array.from(boxes.values()).map((b) => boxRect(b))),
    root: h('g', { class: 'scene scene-physical' }, [
      h('g', { class: 'layer-groups' }, groupNodes),
      h('g', { class: 'layer-links' }, linkNodes),
      h('g', { class: 'layer-nodes' }, deviceNodes),
      h('g', { class: 'layer-ports' }, portNodes),
      h('g', { class: 'layer-labels' }, groupTitles.concat(labelNodes)),
    ]),
    bounds,
  };
}

/** An entry in a device's box: what it shows, and the object it belongs to. */
export interface EntryItem {
  header: string;
  lines: string[];
  ref: string;
  /** classes: if-entry plus the kind (loop-chip, logical-chip kind-…, phys-entry, dev-addr) */
  cls: string;
  /** an interface can be an endpoint of a new connection; the device's own entry is not one */
  endpoint: boolean;
}

/**
 * The entries of a device's box in a view, in the order the layout sized
 * them (layout/input.ts entryTexts): the device's own address lines, then
 * its interfaces.
 */
export function entryItems(model: Model, d: Device, view: 'physical' | 'logical'): EntryItem[] {
  const texts = entryTexts(model, d, view);
  const ifaces = deviceEntries(model, d, view);
  const own = texts.length > ifaces.length;
  return texts.map((t, i) => {
    if (own && i === 0) return { ...t, ref: 'device:' + d.id, cls: 'if-entry dev-addr', endpoint: false };
    const e = ifaces[own ? i - 1 : i];
    const kind = e.kind === 'loopback' ? 'loop-chip' : e.kind === 'physical' ? 'phys-entry' : 'logical-chip kind-' + e.kind;
    return { ...t, ref: e.ref, cls: 'if-entry ' + kind, endpoint: true };
  });
}

/**
 * Entries stacked from (x, y), each `w` wide: a frame, the interface's name,
 * and its addresses and identifiers, one per line, in the monospace font.
 */
export function entryNodes(items: EntryItem[], x: number, y: number, w: number): VNode[] {
  const out: VNode[] = [];
  let top = y;
  for (const it of items) {
    const b = entryBox(it);
    const kids: VNode[] = [h('rect', { x, y: top, width: w, height: b.h, rx: 4 })];
    let ty = top + ENTRY_PAD_Y;
    if (it.header) {
      kids.push(textLines({ class: 'if-name addr', 'font-size': ENTRY_FONT }, { lines: [it.header], size: ENTRY_FONT, w: 0, h: ENTRY_LH, mono: 0 }, x + ENTRY_PAD_X, ty));
      ty += ENTRY_LH;
    }
    if (it.lines.length) kids.push(textLines({ class: 'if-lines', 'font-size': ENTRY_FONT }, { lines: it.lines, size: ENTRY_FONT, w: 0, h: it.lines.length * ENTRY_LH, mono: 0 }, x + ENTRY_PAD_X, ty));
    out.push(h('g', { class: it.cls, 'data-ref': it.ref, 'data-endpoint': it.endpoint ? 'iface' : undefined }, kids));
    top += b.h + ENTRY_GAP;
  }
  return out;
}

/** A device's physical interfaces without a cable, in display order (as the layout sized them). */
export function spareIds(model: Model, d: Device): string[] {
  return sortedByName(d.interfaces.filter((i) => !model.index.ifaceLink.has(ifaceKey(d.id, i.id))).map((i) => i.id), (x) => x);
}

/**
 * Interface chips flowed from (x, y): one selectable chip per interface (ref
 * "iface:<device>:<id>"), each with the interface's full name. `kindOf` adds a class per interface (e.g. its type).
 */
export function chipNodes(device: string, flow: ChipFlow, x: number, y: number, cls: string, kindOf: (id: string) => string): VNode[] {
  return flow.items.map((c) => {
    const ty = y + c.y + IFCHIP_H / 2 + IFCHIP_FONT * 0.35;
    const kind = kindOf(c.id);
    return h('g', { class: `if-chip ${cls}${kind ? ' kind-' + cssToken(kind) : ''}`, 'data-ref': `iface:${device}:${c.id}`, 'data-endpoint': 'iface' }, [
      h('rect', { x: x + c.x, y: y + c.y, width: c.w, height: IFCHIP_H, rx: 3 }),
      h('text', { x: x + c.x + c.w / 2, y: ty, 'text-anchor': 'middle', 'font-size': IFCHIP_FONT }, c.text),
    ]);
  });
}

function n(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** Safe token for use inside a class name (input-derived strings only ever reach classes through this). */
export function cssToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
}

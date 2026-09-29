import { CBox, Pt, Rect, ellipsize, textWidth, unionRect } from '../layout/geometry';
import { deviceIcon } from './icons';
import { GROUP_PAD, GROUP_TITLE, PORT_FONT, PhysicalLayout, PortPos, assignPorts } from '../layout/physical';
import { Model } from '../model/types';
import { VNode, h } from './scene';
import { groupKindStyle, mediumStyle, speedWidth } from './style';

export interface ViewOptions {
  showLabels: boolean;
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

/** Group rectangles derived bottom-up from their contents. */
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
      if (d.group !== g.id) continue;
      const b = boxes.get(d.id) as CBox;
      parts.push({ x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h });
    }
    for (const c of model.groups) if (c.parent === g.id && rects.has(c.id)) parts.push(rects.get(c.id) as Rect);
    if (!parts.length) continue;
    const u = unionRect(parts);
    rects.set(g.id, { x: u.x - GROUP_PAD, y: u.y - GROUP_PAD - GROUP_TITLE, w: u.w + 2 * GROUP_PAD, h: u.h + 2 * GROUP_PAD + GROUP_TITLE });
  }
  return rects;
}

export function deviceNode(
  ref: string,
  label: string,
  sub: string,
  type: string,
  b: CBox,
  extraClass = '',
): VNode {
  const x = b.cx - b.w / 2;
  const y = b.cy - b.h / 2;
  const icon = 26;
  const textX = x + 12 + icon + 10;
  const maxText = b.w - (textX - x) - 10;
  return h('g', { class: 'node device ' + extraClass, 'data-ref': ref }, [
    h('rect', { class: 'dev-box', x, y, width: b.w, height: b.h, rx: 8 }),
    deviceIcon(type, x + 12, b.cy - icon / 2, icon),
    h('text', { class: 'dev-label', x: textX, y: b.cy - (sub ? 3 : -4) }, ellipsize(label, 13, maxText)),
    sub ? h('text', { class: 'dev-sub', x: textX, y: b.cy + 12 }, ellipsize(sub, 10.5, maxText)) : null,
  ]);
}

export function deviceSubtitle(type: string, model?: string, role?: string): string {
  return [type, role, model].filter((s) => !!s).join(' · ');
}

export function renderPhysical(model: Model, layout: PhysicalLayout, opts: ViewOptions): SceneResult {
  const boxes = physicalBoxes(layout, opts.positions);
  const grects = groupRects(model, boxes);
  const ports = assignPorts(model.links, boxes);
  const portByKey = new Map<string, PortPos>(ports.map((p) => [p.key, p] as [string, PortPos]));

  // ---- groups (outermost first so children draw on top)
  const groupNodes: VNode[] = [];
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
    groupNodes.push(
      h('g', { class: `group kind-${cssToken(g.kind)} ${ks.strong ? 'group-strong' : ''}`, 'data-ref': 'group:' + g.id }, [
        h('rect', { class: 'group-box', x: r.x, y: r.y, width: r.w, height: r.h, rx: 12, 'stroke-dasharray': ks.dash }),
        h('text', { class: 'group-title', x: r.x + 14, y: r.y + 21 }, ellipsize(g.label, 13, r.w - 90)),
        h('text', { class: 'group-kind', x: r.x + r.w - 12, y: r.y + 20, 'text-anchor': 'end' }, g.kind.toUpperCase()),
      ]),
    );
  }

  // ---- links (cables)
  const linkNodes: VNode[] = [];
  const labelNodes: VNode[] = [];
  const portNodes: VNode[] = [];
  for (const l of model.links) {
    const pa = portByKey.get(l.id + ':a');
    const pb = portByKey.get(l.id + ':b');
    if (!pa || !pb) continue;
    const ms = mediumStyle(l.medium);
    const sa = { x: pa.x + pa.nx * STUB, y: pa.y + pa.ny * STUB };
    const sb = { x: pb.x + pb.nx * STUB, y: pb.y + pb.ny * STUB };
    const d = `M${n(pa.x)} ${n(pa.y)}L${n(sa.x)} ${n(sa.y)}L${n(sb.x)} ${n(sb.y)}L${n(pb.x)} ${n(pb.y)}`;
    const width = speedWidth(l.speed);
    linkNodes.push(
      h('g', { class: `link cable medium-${cssToken(ms.key)}`, 'data-ref': 'link:' + l.id }, [
        h('path', { class: 'hit', d }),
        h('path', { class: 'cable-line', d, stroke: ms.color, 'stroke-width': width, 'stroke-dasharray': ms.dash }),
      ]),
    );
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
      if (opts.showLabels && p.iface) labelNodes.push(portLabel(p));
    }
    if (opts.showLabels) {
      const text = [l.speed, l.label].filter((s) => !!s).join(' · ');
      // only label cables whose middle segment has room for the text (hover shows it otherwise)
      if (text && Math.hypot(sb.x - sa.x, sb.y - sa.y) > Math.min(textWidth(text, 10.5), 160) + 24) {
        const m = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
        labelNodes.push(
          h('text', { class: 'halo link-label', 'data-ref': 'link:' + l.id, x: m.x, y: m.y + 4, 'text-anchor': 'middle' }, ellipsize(text, 10.5, 160)),
        );
      }
    }
  }

  // ---- devices
  const deviceNodes: VNode[] = model.devices.map((d) => {
    const b = boxes.get(d.id) as CBox;
    return deviceNode('device:' + d.id, d.label, deviceSubtitle(d.type, d.model, d.role), d.type, b, 'type-' + cssToken(d.type));
  });

  const rects: Rect[] = [];
  grects.forEach((r) => rects.push(r));
  boxes.forEach((b) => rects.push({ x: b.cx - b.w / 2 - 50, y: b.cy - b.h / 2 - 40, w: b.w + 100, h: b.h + 80 }));
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

function portLabel(p: PortPos): VNode {
  const text = p.iface as string;
  if (p.side === 'top' || p.side === 'bottom') {
    return h(
      'text',
      {
        class: 'halo port-label',
        'data-ref': `iface:${p.device}:${p.iface}`,
        x: p.x,
        y: p.y + p.ny * 12 + (p.side === 'top' ? -1 : 8),
        'text-anchor': 'middle',
      },
      text,
    );
  }
  return h(
    'text',
    {
      class: 'halo port-label',
      'data-ref': `iface:${p.device}:${p.iface}`,
      x: p.x + p.nx * 7,
      y: p.y - 5,
      'text-anchor': p.side === 'left' ? 'end' : 'start',
      'font-size': PORT_FONT,
    },
    text,
  );
}

function n(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** Safe token for use inside a class name (input-derived strings only ever reach classes through this). */
export function cssToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
}


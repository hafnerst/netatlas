/**
 * The non-IP interconnects in the physical view (model/interconnect.ts):
 * a point-to-point one is a line between its two opaque ports, labelled
 * with its technology and its direction ("USB 2.0 ↔", "RS-232 →"); a
 * shared one (a bus) is a bar of its own — its spine — with a tap from each
 * attachment's port and that attachment's role as a compact badge where the
 * tap meets the bar (C, T, C/T, P, M). One-way data is an arrowhead; the
 * colour (--opaque) is never the only sign: the lines are dashed and the
 * opaque ports are diamonds, a network port's square never.
 *
 * The routes come from the physical renderer (diagram/physical.ts: the
 * cables' routing, around devices and ports); this module only draws. Each
 * line also carries the track the simulation's illustrative transfers move
 * along (sim-anim.ts): a point-to-point line itself, from its first end;
 * for a bus, a hidden track per tap from the port along the bar to its
 * middle. DOM-free.
 */
import { CBox, Pt, Rect } from '../layout/geometry';
import { BUS_FONT } from '../layout/physical';
import { PortPos } from '../layout/physical';
import { ROLE_BADGE, ROLE_TEXT, interconnectLabel, receives, sends, technologyText } from '../model/interconnect';
import { IcAttachment, Interconnect, Model } from '../model/types';
import { LabelPlacer, alongSegment, centerRect, leaderLine } from './labels';
import { VNode, h } from './scene';

const n = (v: number): string => String(Math.round(v * 10) / 10);
const pathD = (pts: Pt[]): string => pts.map((p, i) => (i ? 'L' : 'M') + n(p.x) + ' ' + n(p.y)).join('');

/** An arrowhead at `end`, pointing away from `from`. */
function arrow(end: Pt, from: Pt): VNode {
  const dx = end.x - from.x;
  const dy = end.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const b = { x: end.x - ux * 9, y: end.y - uy * 9 };
  return h('path', { class: 'ic-arrow', d: `M${n(end.x)} ${n(end.y)}L${n(b.x - uy * 4.5)} ${n(b.y + ux * 4.5)}L${n(b.x + uy * 4.5)} ${n(b.y - ux * 4.5)}Z` });
}

/** An opaque port's marker: a diamond (a network port is a square). */
function diamond(p: PortPos, ic: string): VNode {
  const r = 5.5;
  return h('path', { class: 'port opaque-port', 'data-ref': `iface:${p.device}:${p.iface}`, 'data-endpoint': 'iface', 'data-interconnect': ic, d: `M${n(p.x)} ${n(p.y - r)}L${n(p.x + r)} ${n(p.y)}L${n(p.x)} ${n(p.y + r)}L${n(p.x - r)} ${n(p.y)}Z` });
}

/** Where along the longest segment of a route its label goes. */
function longest(pts: Pt[]): number {
  let seg = 0;
  let len = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (d > len + 0.01) {
      len = d;
      seg = i;
    }
  }
  return seg;
}

export interface InterconnectDraw {
  /** the lines and taps (with their hit areas and tracks) */
  lines: VNode[];
  /** the buses' bars */
  bars: VNode[];
  /** the opaque ports' diamonds */
  ports: VNode[];
  labels: VNode[];
}

/** The tooltip-like title of an interconnect: what it is, in words. */
export function interconnectTitle(ic: Interconnect): string {
  const parts = [technologyText(ic)];
  if (ic.protocol) parts.push(`carrying ${ic.protocol.name}${ic.protocol.version ? ' ' + ic.protocol.version : ''}`);
  if (ic.connector) parts.push(`connector ${ic.connector}`);
  return `${ic.id}: ${parts.join(', ')} — non-IP, ${ic.topology === 'shared' ? 'shared medium' : 'point to point'}`;
}

/**
 * Draw the interconnects of a model: `route(id)` gives each connection's
 * route (from its port at end a to end b: a p2p line's first end, a tap's
 * port), `port(key)` the placed ports ("<connection id>:a" / ":b").
 */
export function interconnectNodes(model: Model, boxes: Map<string, CBox>, port: (key: string) => PortPos | undefined, route: (id: string) => Pt[] | undefined, placer: LabelPlacer, showLabels: boolean, extra: Rect[]): InterconnectDraw {
  const out: InterconnectDraw = { lines: [], bars: [], ports: [], labels: [] };
  const sorted = model.interconnects.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const attachment = (ic: Interconnect, p: PortPos): IcAttachment | undefined => ic.endpoints.find((e) => e.device === p.device && e.port === p.iface);
  for (const ic of sorted) {
    const ref = 'interconnect:' + ic.id;
    const title = h('title', {}, interconnectTitle(ic));
    if (ic.topology === 'point_to_point') {
      const pa = port(ic.id + ':a');
      const pb = port(ic.id + ':b');
      const pts = route(ic.id);
      if (!pa || !pb || !pts || pts.length < 2) continue;
      const ea = attachment(ic, pa);
      const eb = attachment(ic, pb);
      const ab = !!ea && !!eb && sends(ea) && receives(eb);
      const ba = !!ea && !!eb && sends(eb) && receives(ea);
      const d = pathD(pts);
      out.lines.push(
        h('g', { class: 'ic interconnect p2p', 'data-ref': ref, 'data-from': `${pa.device}:${pa.iface}` }, [
          title,
          h('path', { class: 'hit', d }),
          h('path', { class: 'ic-line', d }),
          // (one way: an arrowhead where the data arrives)
          ab && !ba ? arrow(pts[pts.length - 1], pts[pts.length - 2]) : null,
          ba && !ab ? arrow(pts[0], pts[1]) : null,
        ]),
      );
      for (const p of [pa, pb]) out.ports.push(diamond(p, ic.id));
      if (showLabels) {
        const seg = longest(pts);
        const text = interconnectLabel(ic);
        const w = text.length * 6.4 + 8;
        const c = placer.place(alongSegment(pts[seg], pts[seg + 1], 0.5, [0, -26, 26, -52, 52, -80, 80], [0, -14, 14, -28, 28, -42, 42]), w, 14);
        extra.push(centerRect(c, w, 14));
        if (placer.leaderFrom) out.labels.push(leaderLine(placer.leaderFrom, centerRect(c, w, 14), ref));
        out.labels.push(h('text', { class: 'halo ic-label', 'data-ref': ref, x: n(c.x), y: n(c.y + 4), 'text-anchor': 'middle' }, text));
      }
      continue;
    }
    // a bus: its bar, then a tap from every attachment's port
    const b = boxes.get(ic.id);
    if (!b) continue;
    out.bars.push(
      // (a node: it is dragged like a device, its place kept in the layout)
      h('g', { class: 'node ic interconnect bus', 'data-ref': ref }, [
        title,
        h('rect', { class: 'ic-bar', x: n(b.cx - b.w / 2), y: n(b.cy - b.h / 2), width: n(b.w), height: n(b.h), rx: 4 }),
        h('text', { class: 'ic-bar-label', x: n(b.cx), y: n(b.cy + BUS_FONT / 2 - 1), 'text-anchor': 'middle', 'font-size': BUS_FONT }, interconnectLabel(ic)),
      ]),
    );
    for (const e of ic.endpoints.slice().sort((x, y) => (x.device + ':' + x.port < y.device + ':' + y.port ? -1 : 1))) {
      const id = `${ic.id}~${e.device}:${e.port}`;
      const pa = port(id + ':a');
      const pb = port(id + ':b');
      const pts = route(id);
      if (!pa || !pb || !pts || pts.length < 2) continue;
      const d = pathD(pts);
      // (the track a transfer moves along: from the port to the tap, then along the bar to its middle)
      const end = pts[pts.length - 1];
      const track = pts.concat([{ x: b.cx, y: end.y }]);
      const sendOnly = sends(e) && !receives(e);
      const receiveOnly = receives(e) && !sends(e);
      out.lines.push(
        h('g', { class: 'ic interconnect tap', 'data-ref': ref, 'data-port': `${e.device}:${e.port}` }, [
          h('title', {}, `${e.device}:${e.port} on ${ic.id}: ${ROLE_TEXT[e.role].toLowerCase()}${e.systemController ? ', system controller' : ''}${sendOnly ? ', sends only' : receiveOnly ? ', receives only' : ''}`),
          h('path', { class: 'hit', d }),
          h('path', { class: 'ic-line ic-tap', d }),
          h('path', { class: 'ic-track', d: pathD(track) }),
          sendOnly ? arrow(end, pts[pts.length - 2]) : receiveOnly ? arrow(pts[0], pts[1]) : null,
        ]),
      );
      out.ports.push(diamond(pa, ic.id));
      // the role where the tap meets the bar
      const badge = ROLE_BADGE[e.role] + (e.systemController ? '*' : '');
      const bw = badge.length * 6 + 8;
      // (beside the tap where it meets the bar, clear of the other badges and labels: the placer's first free place)
      const cands: Pt[] = [];
      for (const d of [10, 24, 38]) for (const side of [0, 1, -1, 2, -2]) cands.push({ x: pb.x + pb.nx * d - pb.ny * side * (bw / 2 + 3), y: pb.y + pb.ny * d + pb.nx * side * 9 });
      const at = placer.place(cands, bw, 14);
      const bx = at.x;
      const by = at.y;
      if (placer.leaderFrom) out.labels.push(leaderLine(placer.leaderFrom, centerRect(at, bw, 14), ref));
      out.labels.push(
        h('g', { class: 'ic-role', 'data-ref': ref, 'data-role': e.role, 'aria-label': `${e.device}:${e.port}: ${ROLE_TEXT[e.role]}` }, [
          h('rect', { x: n(bx - bw / 2), y: n(by - 7), width: n(bw), height: 14, rx: 3 }),
          h('text', { x: n(bx), y: n(by + 3.5), 'text-anchor': 'middle' }, badge),
        ]),
      );
      extra.push({ x: bx - bw / 2, y: by - 7, w: bw, h: 14 });
    }
  }
  return out;
}

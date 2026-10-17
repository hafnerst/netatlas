/**
 * Drawing a host's interior in the physical view (layout/virtual.ts has its
 * geometry): its virtual switches and container networks as bars, their
 * port groups as pills, the guests as boxes inside the host's box (a VM
 * that runs containers with its own interior inside it), each vNIC or veth
 * an entry wired to its port group or bar, and the wires from the host's
 * ports: uplinks to their virtual switch, a passthrough port to its vNIC,
 * a macvlan network's parent port to its bar. Everything carries the ref
 * of what it shows, so selecting, highlighting and Find work as for any
 * other element; text is drawn whole, in the bars' and entries' fonts.
 */
import { Rect } from '../layout/geometry';
import { PortPos } from '../layout/physical';
import { ENTRY_MARGIN } from '../layout/sizes';
import { textBlock } from '../layout/text';
import { BAR_FONT, PILL_FONT, Pt, VGuest, VInterior } from '../layout/virtual';
import { textLines } from './labels';
import { VNode, h } from './scene';
import type { EntryItem } from './physical';
import { virtLinkId } from '../model/virtual';

const TRACK = 4;
const GUTTER_PAD = 6;

function n(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function path(pts: Pt[]): string {
  return pts.map((p, i) => (i ? 'L' : 'M') + n(p.x) + ' ' + n(p.y)).join('');
}

/** What renderPhysical lends the interior: how to draw a device box and a list of entries (shared with it). */
export interface InteriorPainters {
  deviceNode(ref: string, label: string, sub: string, type: string, b: { cx: number; cy: number; w: number; h: number }, extraClass: string, bodyH: number, layer3?: boolean): VNode;
  entryNodes(items: EntryItem[], x: number, y: number, w: number): VNode[];
}

/**
 * The nodes of an interior at (ox, oy): bars, pills, wires and guests (into
 * `nodes`), and the rectangles of its text (into `rects`, for the bounds).
 * The guests' boxes go to `boxes` with their absolute rectangles.
 */
export function interiorNodes(v: VInterior, ox: number, oy: number, paint: InteriorPainters, out: { nodes: VNode[]; wires: VNode[]; guests: Map<string, Rect> }): void {
  for (const l of v.lanes) {
    if (l.bar) {
      const b = l.bar;
      out.nodes.push(
        h('g', { class: 'vbar ' + (b.ref.indexOf('vswitch:') === 0 ? 'vswitch-bar' : 'cnet-bar'), 'data-ref': b.ref }, [
          h('rect', { class: 'vbar-box', x: n(ox + b.x), y: n(oy + b.y), width: n(b.w), height: n(b.h), rx: 4 }),
          textLines({ class: 'vbar-title', 'data-ref': b.titleRef, 'font-size': BAR_FONT }, textBlock(b.title, BAR_FONT, Infinity), ox + b.x + 5, oy + b.y + 3),
          ...b.pills.map((p) =>
            h('g', { class: 'pg-pill', 'data-ref': p.ref }, [
              h('rect', { class: 'pg-box', x: n(ox + p.x), y: n(oy + p.y), width: n(p.w), height: n(p.h), rx: 3 }),
              h('text', { class: 'pg-name', x: n(ox + p.x + p.w / 2), y: n(oy + p.y + 12), 'text-anchor': 'middle', 'font-size': PILL_FONT }, p.name),
              h('text', { class: 'pg-sub', x: n(ox + p.x + p.w / 2), y: n(oy + p.y + 26), 'text-anchor': 'middle', 'font-size': PILL_FONT }, p.sub),
            ]),
          ),
        ]),
      );
    } else if (l.title) {
      out.nodes.push(h('text', { class: 'vlane-title', x: n(ox + l.x + 2), y: n(oy + l.y + 10), 'font-size': BAR_FONT }, l.title));
    }
    for (const g of l.guests) guestNodes(g, ox, oy, paint, out);
  }
  // (each with the protocol simulation's virtual link it stands for: its dots run along it, from the vNIC or veth)
  for (const w of v.wires) out.wires.push(h('path', { class: 'vwire', 'data-ref': w.from, 'data-to': w.to, 'data-link': wireLink(w.from), d: path(w.pts.map((p) => ({ x: ox + p.x, y: oy + p.y }))) }));
}

/** The virtual link of a wire from an interface ("iface:web1:eth0" → "~web1~eth0"). */
function wireLink(ref: string): string {
  const rest = ref.slice(6);
  const i = rest.indexOf(':');
  return virtLinkId(rest.slice(0, i), rest.slice(i + 1));
}

function guestNodes(g: VGuest, ox: number, oy: number, paint: InteriorPainters, out: { nodes: VNode[]; wires: VNode[]; guests: Map<string, Rect> }): void {
  const x = ox + g.x;
  const y = oy + g.y;
  if (g.kind === 'hostif') {
    // a host's own vNIC: its entry, beside the guests on its port group
    const e = g.entries[0];
    out.nodes.push(...paint.entryNodes([{ header: e.item.header, lines: e.item.lines, ref: e.ref, fields: e.item.fields, cls: 'if-entry logical-chip kind-vnic host-vnic', endpoint: true }], x, y, g.w));
    return;
  }
  const body = g.body as NonNullable<VGuest['body']>;
  out.guests.set(g.id, { x, y, w: g.w, h: g.h });
  out.nodes.push(paint.deviceNode(g.ref, g.label, g.sub, g.type, { cx: x + g.w / 2, cy: y + g.h / 2, w: g.w, h: g.h }, 'guest type-' + g.type, body.h, g.layer3));
  const items: EntryItem[] = g.entries.map((e) => ({ header: e.item.header, lines: e.item.lines, ref: e.ref, fields: e.item.fields, cls: 'if-entry logical-chip kind-' + e.item.kind, endpoint: true }));
  if (items.length) out.nodes.push(...paint.entryNodes(items, x + ENTRY_MARGIN, y + body.h, g.w - 2 * ENTRY_MARGIN));
  if (g.inner) interiorNodes(g.inner, x + g.innerX, y + g.innerY, paint, out);
}

/**
 * The wires from a host's ports into its interior at (ox, oy): an uplink to
 * its virtual switch's bar, a passthrough port to its vNIC's entry, a
 * macvlan / ipvlan network's parent port to its bar. A port above the
 * interior's first bar drops straight into it; every other wire runs into
 * the box a little, along to its track in the gutter of its side, and
 * down (or up) in it to where it ends.
 */
export function externalWires(v: VInterior, ox: number, oy: number, box: Rect, ports: PortPos[], host: string): VNode[] {
  const out: VNode[] = [];
  for (const x of v.external) {
    const p = ports.find((q) => q.device === host && q.iface === x.port);
    if (!p) continue;
    const firstBar = v.lanes[0] && v.lanes[0].bar;
    let pts: Pt[];
    if (x.top && p.side === 'top' && firstBar && x.kind !== 'passthrough') {
      const bx = Math.max(ox + firstBar.x + 6, Math.min(ox + firstBar.x + firstBar.w - 6, p.x));
      pts = [{ x: p.x, y: p.y }, { x: bx, y: p.y + 4 }, { x: bx, y: oy + firstBar.y }];
      if (bx === p.x) pts.splice(1, 1);
    } else {
      const side: 'left' | 'right' = p.side === 'left' || (p.side !== 'right' && p.x < box.x + box.w / 2) ? 'left' : 'right';
      const gx = side === 'left' ? ox + GUTTER_PAD / 2 + TRACK * x.track : ox + v.w - GUTTER_PAD / 2 - TRACK * x.track;
      const inward = { x: p.x - p.nx * 6, y: p.y - p.ny * 6 };
      const via = x.via(side).map((q) => ({ x: ox + q.x, y: oy + q.y }));
      pts = [{ x: p.x, y: p.y }, inward, { x: gx, y: inward.y }, { x: gx, y: via[0].y }].concat(via);
    }
    out.push(h('path', { class: 'vwire vwire-' + x.kind, 'data-ref': `iface:${host}:${x.port}`, 'data-to': x.to, d: path(pts) }));
  }
  return out;
}

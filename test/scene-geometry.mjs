// Geometry of a rendered scene (a VNode tree), for tests: the rectangles of
// nodes and labels, the text they show, and the segments of cables and
// relation lines. Text sizes are the same estimates the layout uses; the
// browser self-test repeats the important checks with real font metrics.
import { load, scene } from './helpers.mjs';

const { textWidth, lineHeight, monoWidth } = load('layout/text.js');
const { bindingOn } = load('layout/bundles.js');
const { relationDevices } = load('model/types.js');

const has = (n, c) => scene.hasClass(n, c);
const all = (v, pred) => scene.findAll(v, pred);
const num = (n, k) => Number(n.attrs[k]);

/** Lines of a <text>: its tspans, or its own text. */
export function linesOf(t) {
  return t.children.length ? t.children.map((c) => c.text) : [t.text];
}

/** Estimated width of each line of a <text>: address lines (class "addr") are in the monospace font. */
function lineWidths(t, size) {
  if (t.children.length) return t.children.map((c) => (has(c, 'addr') ? monoWidth(c.text, size) : textWidth(c.text, size)));
  return [has(t, 'addr') ? monoWidth(t.text, size) : textWidth(t.text, size)];
}

/** Rectangle covered by a <text> node (estimated), given its font size. */
export function textRect(t, size) {
  const lines = linesOf(t);
  const w = lineWidths(t, size).reduce((m, x) => Math.max(m, x), 0);
  const anchor = t.attrs['text-anchor'] || 'start';
  const x = num(t, 'x') - (anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0);
  const lh = lineHeight(size);
  // y is the first baseline
  return { x, y: num(t, 'y') - size * 0.35 - lh / 2, w, h: lines.length * lh };
}

const rectOf = (r) => ({ x: num(r, 'x'), y: num(r, 'y'), w: num(r, 'width'), h: num(r, 'height') });

export function overlap(a, b, slack = 0) {
  return a.x + slack < b.x + b.w && b.x + slack < a.x + a.w && a.y + slack < b.y + b.h && b.y + slack < a.y + a.h;
}
export function inside(inner, outer, slack = 0.5) {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}

const SIZES = { 'dev-label': 13, 'dev-sub': 10.5, 'net-label': 12, 'net-sub': 10, 'group-title': 13, 'pill-text': 10, 'link-label': 10.5, 'member-label': 10, 'port-label': 10, 'end-label': 9.5, 'lag-label': 9.5 };

/** Everything measurable in a scene. */
export function geometry(root) {
  const devices = all(root, (n) => has(n, 'device')).map((g) => {
    const box = rectOf(g.children.find((c) => has(c, 'dev-box')));
    const texts = g.children.filter((c) => c.tag === 'text');
    return { ref: g.attrs['data-ref'], box, texts: texts.map((t) => ({ cls: t.attrs.class, lines: linesOf(t), rect: textRect(t, SIZES[t.attrs.class]) })) };
  });
  const networks = all(root, (n) => has(n, 'network')).map((g) => {
    const box = rectOf(g.children.find((c) => has(c, 'net-box')));
    return { ref: g.attrs['data-ref'], box, texts: g.children.filter((c) => c.tag === 'text').map((t) => ({ cls: t.attrs.class, lines: linesOf(t), rect: textRect(t, SIZES[t.attrs.class]) })) };
  });
  const groups = all(root, (n) => has(n, 'group')).map((g) => {
    const box = rectOf(g.children.find((c) => has(c, 'group-box')));
    // the title is drawn in the label layer (above the lines), under the group's ref
    const lbl = all(root, (n) => has(n, 'group-label') && n.attrs['data-ref'] === g.attrs['data-ref'])[0];
    const t = lbl.children.find((c) => has(c, 'group-title'));
    return { ref: g.attrs['data-ref'], box, title: { lines: linesOf(t), rect: textRect(t, 13) } };
  });
  const pills = all(root, (n) => has(n, 'pill')).map((g) => {
    const t = g.children.find((c) => c.tag === 'text');
    return { ref: g.attrs['data-ref'], box: rectOf(g.children.find((c) => has(c, 'pill-box'))), lines: linesOf(t), rect: textRect(t, 10) };
  });
  // interface entries in device boxes: their frame and their text (name line, address lines)
  const entries = all(root, (n) => has(n, 'if-entry')).map((g) => {
    const ts = g.children.filter((c) => c.tag === 'text');
    return { ref: g.attrs['data-ref'], cls: g.attrs.class, box: rectOf(g.children.find((c) => c.tag === 'rect')), texts: ts.map((t) => ({ lines: linesOf(t), rect: textRect(t, num(t, 'font-size')) })) };
  });
  // the loopbacks' entries
  const chips = entries.filter((e) => /(^| )loop-chip( |$)/.test(e.cls)).map((e) => ({ ref: e.ref, box: e.box, text: e.texts.map((t) => t.lines.join(' ')).join(' '), rect: e.texts[0].rect }));
  // every piece of text drawn (for the overlap check)
  const texts = all(root, (n) => n.tag === 'text').map((t) => {
    const cls = (t.attrs.class || '').split(' ').find((c) => SIZES[c]);
    const size = cls ? SIZES[cls] : num(t, 'font-size') || (has(t, 'group-kind') ? 9.5 : has(t, 'hub-glyph') ? 11 : has(t, 'net-warn') ? 14 : 10);
    return { lines: linesOf(t), rect: textRect(t, size) };
  });
  const label = (cls) => all(root, (n) => n.tag === 'text' && has(n, cls)).map((t) => ({ ref: t.attrs['data-ref'], lines: linesOf(t), rect: textRect(t, SIZES[cls]) }));
  const path = (p) =>
    p.attrs.d
      .slice(1)
      .split('L')
      .map((s) => s.trim().split(' ').map(Number))
      .map(([x, y]) => ({ x, y }));
  const cables = all(root, (n) => has(n, 'cable')).map((g) => ({ ref: g.attrs['data-ref'], straight: has(g, 'straight'), pts: path(g.children.find((c) => has(c, 'cable-line'))) }));
  const rels = all(root, (n) => has(n, 'rel') && !has(n, 'hub-rel')).map((g) => ({ ref: g.attrs['data-ref'], pts: path(g.children.find((c) => has(c, 'hit'))) }));
  return { devices, networks, groups, pills, chips, entries, texts, linkLabels: label('link-label'), memberLabels: label('member-label'), portLabels: label('port-label'), cables, rels };
}

/** Does segment a->b pass through rectangle r? */
export function segHits(a, b, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 <= t1;
}

/** Problems of a scene that a reader would see: clipped text, overlapping labels, lines through nodes. */
export function problems(root) {
  const g = geometry(root);
  const out = [];
  const nodes = g.devices.concat(g.networks);
  for (const n of nodes) for (const t of n.texts) if (!inside(t.rect, n.box)) out.push(`text of ${n.ref} leaves its box: ${t.lines.join(' / ')}`);
  for (const gr of g.groups) if (!inside(gr.title.rect, gr.box)) out.push(`title of ${gr.ref} leaves its box`);
  for (const p of g.pills) if (!inside(p.rect, p.box)) out.push(`label text leaves its pill: ${p.lines.join(' / ')}`);
  for (const c of g.entries) for (const t of c.texts) if (!inside(t.rect, c.box)) out.push(`entry text leaves its frame: ${c.ref} ${t.lines.join(' / ')}`);
  // an entry lies inside its device's box
  for (const c of g.entries) {
    const dev = g.devices.find((d) => d.ref === 'device:' + c.ref.split(':')[1]);
    if (dev && !inside(c.box, dev.box)) out.push(`entry ${c.ref} leaves the box of ${dev.ref}`);
  }
  // no text is drawn over other text (addresses, names, labels, titles …)
  for (let i = 0; i < g.texts.length; i++) {
    for (let j = i + 1; j < g.texts.length; j++) if (overlap(g.texts[i].rect, g.texts[j].rect, 1)) out.push(`text overlaps text: "${g.texts[i].lines.join(' / ')}" / "${g.texts[j].lines.join(' / ')}"`);
  }
  for (let i = 0; i < g.devices.length; i++) for (let j = i + 1; j < g.devices.length; j++) if (overlap(g.devices[i].box, g.devices[j].box)) out.push(`${g.devices[i].ref} overlaps ${g.devices[j].ref}`);
  // floating labels: clear of nodes and of each other
  const floating = g.pills.map((p) => ({ what: 'label ' + p.lines.join(' '), rect: p.box })).concat(g.linkLabels.map((l) => ({ what: 'cable label ' + l.lines.join(' '), rect: l.rect })), g.memberLabels.map((l) => ({ what: 'address ' + l.lines.join(' '), rect: l.rect })));
  for (const f of floating) for (const n of nodes) if (overlap(f.rect, n.box, 1)) out.push(`${f.what} covers ${n.ref}`);
  for (let i = 0; i < floating.length; i++) for (let j = i + 1; j < floating.length; j++) if (overlap(floating[i].rect, floating[j].rect, 1)) out.push(`${floating[i].what} overlaps ${floating[j].what}`);
  // cables: not through a device that is not one of their ends (checked between the stubs)
  for (const c of g.cables) {
    for (let k = 0; k + 1 < c.pts.length; k++) {
      for (const d of g.devices) {
        const shrunk = { x: d.box.x + 2, y: d.box.y + 2, w: d.box.w - 4, h: d.box.h - 4 };
        const ends = [c.pts[0], c.pts[c.pts.length - 1]];
        const own = ends.some((e) => e.x >= d.box.x - 1 && e.x <= d.box.x + d.box.w + 1 && e.y >= d.box.y - 1 && e.y <= d.box.y + d.box.h + 1);
        if (!own && segHits(c.pts[k], c.pts[k + 1], shrunk)) out.push(`cable ${c.ref} runs through ${d.ref}`);
      }
    }
  }
  return out;
}

// ------------------------------------------------- bindings to interfaces (ports)

const pathPts = (d) =>
  d
    .slice(1)
    .split('L')
    .map((s) => s.trim().split(' ').map(Number))
    .map(([x, y]) => ({ x, y }));

/** Everything about the ports of a logical scene: boxes, rows, ports, lanes, end labels, leader lines. */
export function logicalScene(root) {
  const g = geometry(root);
  const boxes = new Map(g.devices.map((d) => [d.ref.slice(7), d.box]));
  const rows = new Map();
  for (const e of g.entries) {
    if (!/^iface:/.test(e.ref)) continue;
    const [, dev, ...rest] = e.ref.split(':');
    rows.set(dev + ':' + rest.join(':'), { top: e.box.y, bottom: e.box.y + e.box.h, ref: e.ref });
  }
  // the device-level row: the name part, above the first entry
  for (const [id, b] of boxes) {
    const first = g.entries.filter((e) => e.ref.split(':')[1] === id || e.ref === 'device:' + id).reduce((m, e) => Math.min(m, e.box.y), b.y + b.h);
    rows.set(id + ':', { top: b.y, bottom: first, ref: 'device:' + id });
  }
  const ports = all(root, (n) => n.tag === 'rect' && has(n, 'lport')).map((n) => ({ ref: n.attrs['data-ref'], side: n.attrs['data-side'], r: rectOf(n), dev: has(n, 'dev-port') }));
  const lanes = [];
  for (const grp of all(root, (n) => has(n, 'rel'))) {
    const ref = grp.attrs['data-ref'];
    const hub = has(grp, 'hub-rel');
    for (const c of grp.children.filter((x) => has(x, 'hit'))) {
      const stroke = grp.children.find((x) => has(x, 'tube-outer') || has(x, 'rel-line'));
      lanes.push({ ref, hub, pts: pathPts(c.attrs.d), half: stroke ? num(stroke, 'stroke-width') / 2 : 1.2 });
    }
  }
  const endLabels = all(root, (n) => n.tag === 'text' && has(n, 'end-label')).map((t) => ({ ref: t.attrs['data-ref'], side: t.attrs['data-side'], rect: textRect(t, 9.5), lines: linesOf(t) }));
  const leaders = all(root, (n) => has(n, 'leader')).map((n) => n.attrs['data-ref']);
  return { g, boxes, rows, ports, lanes, endLabels, leaders };
}

/** The device whose side `p` lies on, and which side (null: on none). */
export function sideOf(boxes, p) {
  for (const [id, b] of boxes) {
    if (p.y < b.y - 0.6 || p.y > b.y + b.h + 0.6) continue;
    if (Math.abs(p.x - b.x) <= 0.6) return { id, side: 'left', x: b.x };
    if (Math.abs(p.x - (b.x + b.w)) <= 0.6) return { id, side: 'right', x: b.x + b.w };
  }
  return null;
}

/**
 * Problems with the bindings of a logical scene: an end outside the port
 * area of the interface it references (the side of the box beside that
 * interface's row, or beside the name part for a device-level endpoint), a
 * lane through a box (so across another row), a port that leaves its row, an
 * end label that is not beside its port, names something else, or is
 * crossed by a line.
 */
export function logicalBindingProblems(m, root) {
  const out = [];
  const L = logicalScene(root);
  for (const lane of L.lanes) {
    const rid = lane.ref.slice(9);
    const r = m.index.relations.get(rid);
    const ends = lane.hub ? [lane.pts[0]] : [lane.pts[0], lane.pts[lane.pts.length - 1]];
    const seen = [];
    for (const p of ends) {
      const at = sideOf(L.boxes, p);
      if (!at) {
        out.push(`${lane.ref}: an end at ${p.x},${p.y} is on no device's side`);
        continue;
      }
      seen.push(at.id);
      if (relationDevices(r).indexOf(at.id) < 0) {
        out.push(`${lane.ref}: ends at ${at.id}, which is not one of its devices`);
        continue;
      }
      const iface = bindingOn(r, at.id);
      const row = L.rows.get(at.id + ':' + (iface === undefined ? '' : iface));
      if (!row) {
        out.push(`${lane.ref}: no row for ${at.id}:${iface}`);
        continue;
      }
      if (p.y < row.top - 0.6 || p.y > row.bottom + 0.6) out.push(`${lane.ref}: the end at ${at.id} (y ${p.y}) is not beside ${row.ref} (${row.top}..${row.bottom})`);
      const port = L.ports.find((q) => q.ref === row.ref && q.side === at.side && p.y >= q.r.y - 0.6 && p.y <= q.r.y + q.r.h + 0.6 && Math.abs(q.r.x + q.r.w / 2 - at.x) < 0.6);
      if (!port) out.push(`${lane.ref}: no port of ${row.ref} on the ${at.side} of ${at.id} holds its end`);
      else if (port.dev !== (iface === undefined)) out.push(`${lane.ref}: the port at ${at.id} has the wrong kind (device-level: ${port.dev})`);
    }
    if (!lane.hub && seen.length === 2 && seen[0] === seen[1] && relationDevices(r).length > 1) out.push(`${lane.ref}: both ends at ${seen[0]}`);
    for (let k = 0; k + 1 < lane.pts.length; k++) {
      for (const [id, b] of L.boxes) {
        if (segHits(lane.pts[k], lane.pts[k + 1], { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 })) out.push(`${lane.ref} crosses the box of ${id}`);
      }
    }
  }
  for (const p of L.ports) {
    const parts = p.ref.split(':');
    const key = p.ref.indexOf('iface:') === 0 ? parts[1] + ':' + parts.slice(2).join(':') : parts[1] + ':';
    const row = L.rows.get(key);
    if (!row) out.push(`port ${p.ref} has no row`);
    else if (p.r.y < row.top - 0.6 || p.r.y + p.r.h > row.bottom + 0.6) out.push(`port ${p.ref} leaves its row`);
  }
  for (const e of L.endLabels) {
    const port = L.ports.find((p) => p.ref === e.ref && p.side === e.side);
    if (!port) {
      out.push(`end label ${e.lines[0]} has no port`);
      continue;
    }
    const x = port.r.x + port.r.w / 2;
    const near = e.side === 'right' ? e.rect.x - x : x - (e.rect.x + e.rect.w);
    if (near < 0 || near > 34) out.push(`end label ${e.ref} is not beside its port (${near})`);
    const parts = e.ref.split(':');
    const row = L.rows.get(parts[1] + ':' + parts.slice(2).join(':'));
    if (row && (e.rect.y + e.rect.h < row.top - 30 || e.rect.y > row.bottom + 30)) out.push(`end label ${e.ref} is far from its row`);
    if (e.lines[0] !== parts.slice(2).join(':')) out.push(`end label ${e.ref} names ${e.lines[0]}`);
    for (const lane of L.lanes) {
      for (let k = 0; k + 1 < lane.pts.length; k++) {
        const r = { x: e.rect.x - lane.half + 0.5, y: e.rect.y - lane.half + 0.5, w: e.rect.w + 2 * lane.half - 1, h: e.rect.h + 2 * lane.half - 1 };
        if (segHits(lane.pts[k], lane.pts[k + 1], r)) {
          out.push(`end label ${e.ref} is crossed by ${lane.ref}`);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Problems with the bindings of a physical scene: a cable end not at the
 * port of the interface it references (or a device-level end not hollow), a
 * port off its device's side, a cable across another port's square or label,
 * a LAG bracket around a port that is not a member.
 */
export function physicalBindingProblems(m, root) {
  const out = [];
  const g = geometry(root);
  const boxes = new Map(g.devices.map((d) => [d.ref.slice(7), d.box]));
  const ports = all(root, (n) => n.tag === 'rect' && has(n, 'port')).map((n) => ({ ref: n.attrs['data-ref'], r: rectOf(n), devEnd: has(n, 'dev-end') }));
  const labels = all(root, (n) => n.tag === 'text' && has(n, 'port-label')).map((n) => ({ ref: n.attrs['data-ref'], r: textRect(n, 10) }));
  const holds = (r, p) => p.x >= r.x - 0.5 && p.x <= r.x + r.w + 0.5 && p.y >= r.y - 0.5 && p.y <= r.y + r.h + 0.5;
  for (const c of g.cables) {
    const l = m.index.links.get(c.ref.slice(5));
    const ends = [c.pts[0], c.pts[c.pts.length - 1]];
    const own = [];
    for (const e of [l.a, l.b]) {
      const ref = e.iface ? `iface:${e.device}:${e.iface}` : 'device:' + e.device;
      const port = ports.find((p) => p.ref === ref && ends.some((q) => Math.abs(p.r.x + p.r.w / 2 - q.x) < 0.6 && Math.abs(p.r.y + p.r.h / 2 - q.y) < 0.6));
      if (!port) {
        out.push(`${c.ref}: no port ${ref} at an end`);
        continue;
      }
      own.push(port);
      if (port.devEnd !== !e.iface) out.push(`${c.ref}: the end at ${ref} has the wrong kind`);
      const b = boxes.get(e.device);
      const cx = port.r.x + port.r.w / 2;
      const cy = port.r.y + port.r.h / 2;
      const vertical = Math.abs(cx - b.x) < 0.6 || Math.abs(cx - b.x - b.w) < 0.6;
      const horizontal = Math.abs(cy - b.y) < 0.6 || Math.abs(cy - b.y - b.h) < 0.6;
      const onSide = (vertical && cy >= b.y - 0.6 && cy <= b.y + b.h + 0.6) || (horizontal && cx >= b.x - 0.6 && cx <= b.x + b.w + 0.6);
      if (!onSide) out.push(`${c.ref}: port ${ref} is not on the side of ${e.device}`);
    }
    for (let k = 0; k + 1 < c.pts.length; k++) {
      for (const p of ports.concat(labels)) {
        if (own.indexOf(p) >= 0 || own.some((o) => o.ref === p.ref && o.ref.indexOf('iface:') === 0)) continue;
        if (holds(p.r, ends[0]) || holds(p.r, ends[1])) continue;
        if (segHits(c.pts[k], c.pts[k + 1], { x: p.r.x + 1, y: p.r.y + 1, w: p.r.w - 2, h: p.r.h - 2 })) out.push(`${c.ref} crosses ${p.ref}`);
      }
    }
  }
  for (const mk of all(root, (n) => n.tag === 'rect' && has(n, 'lag-mark'))) {
    const [, dev, ...rest] = mk.attrs['data-ref'].split(':');
    const agg = m.index.interfaces.get(dev + ':' + rest.join(':'));
    const r = rectOf(mk);
    const inside = ports.filter((p) => p.ref.split(':')[1] === dev && holds(r, { x: p.r.x + p.r.w / 2, y: p.r.y + p.r.h / 2 }));
    if (!inside.length) out.push(`bracket ${mk.attrs['data-ref']} holds no port`);
    for (const p of inside) if (agg.members.indexOf(p.ref.split(':').slice(2).join(':')) < 0) out.push(`bracket ${mk.attrs['data-ref']} holds ${p.ref}, not a member`);
  }
  return out;
}

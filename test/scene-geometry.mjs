// Geometry of a rendered scene (a VNode tree), for tests: the rectangles of
// nodes and labels, the text they show, and the segments of cables and
// relation lines. Text sizes are the same estimates the layout uses; the
// browser self-test repeats the important checks with real font metrics.
import { load, scene } from './helpers.mjs';

const { textWidth, lineHeight } = load('layout/text.js');

const has = (n, c) => scene.hasClass(n, c);
const all = (v, pred) => scene.findAll(v, pred);
const num = (n, k) => Number(n.attrs[k]);

/** Lines of a <text>: its tspans, or its own text. */
export function linesOf(t) {
  return t.children.length ? t.children.map((c) => c.text) : [t.text];
}

/** Rectangle covered by a <text> node (estimated), given its font size. */
export function textRect(t, size) {
  const lines = linesOf(t);
  const w = lines.reduce((m, l) => Math.max(m, textWidth(l, size)), 0);
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

const SIZES = { 'dev-label': 13, 'dev-sub': 10.5, 'net-label': 12, 'net-sub': 10, 'group-title': 13, 'pill-text': 10, 'link-label': 10.5, 'member-label': 10, 'port-label': 10 };

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
    const t = g.children.find((c) => has(c, 'group-title'));
    return { ref: g.attrs['data-ref'], box, title: { lines: linesOf(t), rect: textRect(t, 13) } };
  });
  const pills = all(root, (n) => has(n, 'pill')).map((g) => {
    const t = g.children.find((c) => c.tag === 'text');
    return { ref: g.attrs['data-ref'], box: rectOf(g.children.find((c) => has(c, 'pill-box'))), lines: linesOf(t), rect: textRect(t, 10) };
  });
  const chips = all(root, (n) => has(n, 'loop-chip')).map((g) => {
    const t = g.children.find((c) => c.tag === 'text');
    const w = t.text.length * 9.5 * 0.62;
    return { ref: g.attrs['data-ref'], box: rectOf(g.children.find((c) => c.tag === 'rect')), text: t.text, rect: { x: num(t, 'x') - w / 2, y: num(t, 'y') - 9, w, h: 12 } };
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
  return { devices, networks, groups, pills, chips, linkLabels: label('link-label'), memberLabels: label('member-label'), portLabels: label('port-label'), cables, rels };
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
  for (const c of g.chips) if (!inside(c.rect, c.box)) out.push(`chip text leaves its chip: ${c.text}`);
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

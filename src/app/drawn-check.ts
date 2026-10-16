/**
 * What is wrong with a drawn diagram, measured in the browser with the real font: text that leaves
 * its box or frame, shortened text, devices and networks that overlap, labels over labels or nodes,
 * and text drawn over text. Used by the self-tests (public and full).
 */
export function drawnProblems(doc: Document, rootSel = '#viewport'): string[] {
  const q = (sel: string): HTMLElement | null => doc.querySelector(sel) as HTMLElement | null;
  const root = q(rootSel) as unknown as SVGGElement;
  const out: string[] = [];
  type R = { x: number; y: number; w: number; h: number };
  const bb = (e: Element): R => {
    const b = (e as SVGGraphicsElement).getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const inside = (a: R, b: R): boolean => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
  const hit = (a: R, b: R): boolean => a.x + 1 < b.x + b.w && b.x + 1 < a.x + a.w && a.y + 1 < b.y + b.h && b.y + 1 < a.y + a.h;
  const each = (sel: string, fn: (e: Element) => void): void => Array.prototype.forEach.call(root.querySelectorAll(sel), fn);
  const boxed = (group: string, box: string, text: string): void =>
    each(group, (g) => {
      const frame = g.querySelector(box);
      if (!frame) return;
      Array.prototype.forEach.call(g.querySelectorAll(text), (t: Element) => {
        if (!inside(bb(t), bb(frame))) out.push(`"${t.textContent}" leaves its box (${Math.round(bb(t).w)} > ${Math.round(bb(frame).w)}; text x ${Math.round(bb(t).x)}, box x ${Math.round(bb(frame).x)})`);
      });
    });
  boxed('g.device', '.dev-box', 'text');
  boxed('g.network', '.net-box', 'text');
  // a group's title is drawn above the lines (in the label layer), inside its frame
  each('g.group-label', (gl) => {
    const frame = root.querySelector(`g.group[data-ref="${gl.getAttribute('data-ref')}"] .group-box`);
    const t = gl.querySelector('.group-title');
    if (frame && t && !inside(bb(t), bb(frame))) out.push(`"${t.textContent}" leaves its group frame`);
  });
  boxed('g.pill', '.pill-box', 'text');
  boxed('g.loop-chip', 'rect', 'text');
  boxed('g.dns-chip', 'rect', 'text');
  each('text', (t) => {
    if (/…$|\.\.\.$/.test(t.textContent || '')) out.push(`shortened text "${t.textContent}"`);
  });
  const nodes: Array<[string, R]> = [];
  each('g.device .dev-box, g.network .net-box', (e) => nodes.push([(e.parentElement as Element).getAttribute('data-ref') || '', bb(e)]));
  // (a guest's box lies wholly inside its host's: nesting, not an overlap)
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (hit(nodes[i][1], nodes[j][1]) && !inside(nodes[i][1], nodes[j][1]) && !inside(nodes[j][1], nodes[i][1])) out.push(`${nodes[i][0]} overlaps ${nodes[j][0]}`);
  const labels: Array<[string, R]> = [];
  each('g.pill .pill-box, text.link-label, text.member-label', (e) => labels.push([(e.textContent || (e.parentElement as Element).textContent || '').slice(0, 40), bb(e)]));
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) if (hit(labels[i][1], labels[j][1])) out.push(`labels overlap: "${labels[i][0]}" / "${labels[j][0]}"`);
    for (const n of nodes) if (hit(labels[i][1], n[1])) out.push(`label "${labels[i][0]}" covers ${n[0]}`);
  }
  // the entries with the interfaces' addresses: their text inside their frame, the frame inside its device's box
  boxed('g.if-entry', 'rect', 'text');
  each('g.if-entry', (g) => {
    const dev = root.querySelector(`g.device[data-ref="device:${(g.getAttribute('data-ref') || '').split(':')[1]}"] .dev-box`);
    const frame = g.querySelector('rect');
    if (dev && frame && !inside(bb(frame), bb(dev))) out.push(`entry ${g.getAttribute('data-ref')} leaves its device's box`);
  });
  // no text is drawn over other text: every pair of <text> elements, measured with the real font
  const texts: Array<[string, R]> = [];
  each('text', (t) => {
    const r = bb(t);
    if (r.w > 0 && r.h > 0) texts.push([(t.textContent || '').slice(0, 40), r]);
  });
  // (a text's box spans the font's whole ascent and descent, so the boxes of two lines set one under the
  // other touch: what counts is an overlap of more than 30 % of a line's height, i.e. glyphs on glyphs)
  const textHit = (a: R, b: R): boolean => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.3 * Math.min(a.h, b.h);
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) if (textHit(texts[i][1], texts[j][1])) out.push(`text overlaps text: "${texts[i][0]}" / "${texts[j][0]}"`);
  return out;
}

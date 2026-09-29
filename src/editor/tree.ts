/**
 * Generic edit primitives on the document tree (the parsed YAML). They keep
 * comments and key order intact; ModelDoc builds its operations from them.
 */
import { YMap, YNode } from '../yaml/parse';

/** Copy comments / blank-line markers from an old node onto its replacement. */
export function keepTrivia(from: YNode | undefined, to: YNode): YNode {
  if (!from) return to;
  if (from.before && !to.before) to.before = from.before;
  if (from.blank && !to.blank) to.blank = true;
  if (from.comment !== undefined && to.comment === undefined && to.kind === 'scalar' && from.kind === 'scalar') to.comment = from.comment;
  if (from.comment !== undefined && to.comment === undefined && to.kind !== 'scalar' && from.kind !== 'scalar') to.comment = from.comment;
  return to;
}

/** Insert or replace `key` in `m`, placing new keys according to `order`. */
export function setKey(m: YMap, key: string, value: YNode, order?: string[]): void {
  const existing = m.entries.get(key);
  if (existing) {
    existing.value = keepTrivia(existing.value, value);
    return;
  }
  const entry = { key, keyLine: 0, value };
  const pos = order ? order.indexOf(key) : -1;
  if (pos < 0) {
    m.entries.set(key, entry);
    return;
  }
  // insert before the first existing key that comes later in the canonical order
  const next = Array.from(m.entries.keys()).find((k) => {
    const p = (order as string[]).indexOf(k);
    return p > pos;
  });
  if (next === undefined) {
    m.entries.set(key, entry);
    return;
  }
  const rebuilt = new Map<string, typeof entry>();
  m.entries.forEach((e, k) => {
    if (k === next) rebuilt.set(key, entry);
    rebuilt.set(k, e);
  });
  m.entries = rebuilt;
}

/** Same members? */
export function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  let same = true;
  a.forEach((x) => {
    if (!b.has(x)) same = false;
  });
  return same;
}

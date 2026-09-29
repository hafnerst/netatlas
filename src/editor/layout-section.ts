/**
 * The document's `layout:` section: stored node positions per view and the
 * list of nodes placed by hand. Presentation only; see docs/FORMAT.md.
 * These functions read and write the section in the document tree. The rules
 * for *when* positions are stored live in ModelDoc.
 */
import { Pt } from '../layout/geometry';
import { cmp } from '../layout/input';
import { LayoutView } from '../layout/positions';
import { scalarText } from '../validation/validate';
import { YMap, YNode, mapNode, numNode, seqNode, strNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { keepTrivia, setKey } from './tree';

/** Keys present in the document's layout section for a view (valid or not). */
export function rawLayoutKeys(root: YMap, view: LayoutView): string[] {
  const lay = root.entries.get('layout');
  if (!lay || lay.value.kind !== 'map') return [];
  const vm = lay.value.entries.get(view);
  return vm && vm.value.kind === 'map' ? Array.from(vm.value.entries.keys()) : [];
}


/** Replace the stored positions of one view (entries sorted by id; comments kept). */
export function writeLayout(root: YMap, view: LayoutView, positions: Map<string, Pt>): void {
  let lay = root.entries.get('layout');
  if (!lay || lay.value.kind !== 'map') {
    const fresh = mapNode();
    fresh.blank = true;
    setKey(root, 'layout', fresh, SCHEMA.top);
    lay = root.entries.get('layout') as { key: string; keyLine: number; value: YNode };
  }
  const layMap = lay.value as YMap;
  const oldEntry = layMap.entries.get(view);
  const old = oldEntry && oldEntry.value.kind === 'map' ? oldEntry.value : null;
  const m = mapNode();
  for (const id of Array.from(positions.keys()).sort(cmp)) {
    const p = positions.get(id) as Pt;
    const v = seqNode([numNode(p.x), numNode(p.y)], true);
    const prev = old ? old.entries.get(id) : undefined;
    if (prev) keepTrivia(prev.value, v);
    m.entries.set(id, { key: id, keyLine: 0, value: v });
  }
  setKey(layMap, view, m, ['physical', 'logical']);
}


/** Ids recorded as hand-placed in the document (valid or not). */
export function rawManualIds(root: YMap, view: LayoutView): string[] {
  const lay = root.entries.get('layout');
  if (!lay || lay.value.kind !== 'map') return [];
  const man = lay.value.entries.get('manual');
  if (!man || man.value.kind !== 'map') return [];
  const l = man.value.entries.get(view);
  return l && l.value.kind === 'seq' ? l.value.items.map((i) => scalarText(i) || '') : [];
}


/** Store the set of hand-placed nodes of a view (sorted; removed when empty). */
export function writeManual(root: YMap, view: LayoutView, ids: Set<string>): void {
  let lay = root.entries.get('layout');
  if (!lay || lay.value.kind !== 'map') {
    if (!ids.size) return;
    const fresh = mapNode();
    fresh.blank = true;
    setKey(root, 'layout', fresh, SCHEMA.top);
    lay = root.entries.get('layout') as { key: string; keyLine: number; value: YNode };
  }
  const layMap = lay.value as YMap;
  const cur = layMap.entries.get('manual');
  let man = cur && cur.value.kind === 'map' ? cur.value : null;
  if (!ids.size) {
    if (man) {
      man.entries.delete(view);
      if (!man.entries.size) layMap.entries.delete('manual');
    }
    return;
  }
  if (!man) {
    man = mapNode();
    setKey(layMap, 'manual', man, ['physical', 'logical', 'manual']);
  }
  setKey(man, view, seqNode(Array.from(ids).sort(cmp).map(strNode), true), ['physical', 'logical']);
}


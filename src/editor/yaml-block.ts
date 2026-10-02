/**
 * Where an object is written in a YAML text: the lines of its entry, found
 * through the parsed structure (never by searching for its id as text, which
 * would also find references, comments and descriptions that mention it).
 * Used to mark the selected object in the full-file YAML editor.
 *
 * The answer is null whenever it would not be reliable: the text is not
 * valid YAML of the supported subset, the section is missing or written as
 * a one-line flow list, or no entry, or more than one, has that id.
 */
import { scalarText } from '../validation/validate';
import { YMap, YNode, YSeq, parseYaml } from '../yaml/parse';
import { EntityKind, SECTION } from './document';

/** 1-based, inclusive line range of an entry. */
export interface LineRange {
  first: number;
  last: number;
}

/** What to locate: an entity by its id, or one interface of a device. */
export interface BlockTarget {
  kind: EntityKind;
  id: string;
  /** an interface of the device `id` (physical or logical) */
  iface?: string;
}

export function yamlBlock(text: string, target: BlockTarget): LineRange | null {
  let root: YNode | null;
  try {
    root = parseYaml(text);
  } catch (e) {
    return null;
  }
  if (!root || root.kind !== 'map') return null;
  const lines = text.split(/\r\n|\r|\n/);
  const sec = seqAt(root, SECTION[target.kind]);
  const item = sec ? uniqueById(sec, target.id) : null;
  if (!sec || !item) return null;
  if (target.iface === undefined) return entryLines(lines, sec, item);
  if (target.kind !== 'device' || item.kind !== 'map') return null;
  // the interface ids of a device share one namespace across both lists
  const found: Array<[YSeq, YMap]> = [];
  for (const key of ['interfaces', 'logical_interfaces']) {
    const s = seqAt(item, key);
    const it = s ? matches(s, target.iface) : [];
    for (const m of it) found.push([s as YSeq, m]);
  }
  return found.length === 1 ? entryLines(lines, found[0][0], found[0][1]) : null;
}

function seqAt(m: YMap, key: string): YSeq | null {
  const e = m.entries.get(key);
  return e && e.value.kind === 'seq' && !e.value.flow ? e.value : null;
}

function matches(seq: YSeq, id: string): YMap[] {
  const out: YMap[] = [];
  for (const it of seq.items) {
    if (it.kind !== 'map') continue;
    const e = it.entries.get('id');
    if (e && scalarText(e.value) === id) out.push(it);
  }
  return out;
}

function uniqueById(seq: YSeq, id: string): YMap | null {
  const m = matches(seq, id);
  return m.length === 1 ? m[0] : null;
}

const indentOf = (s: string): number => s.length - s.replace(/^ +/, '').length;
const isBlank = (s: string): boolean => s.trim() === '';
const isComment = (s: string): boolean => s.trim().charAt(0) === '#';

/**
 * The lines of one entry of a block list: from its "-" line to its last
 * line of content. The entry ends where a line is indented no deeper than
 * its "-" (the next entry or the next key); comments and blank lines between
 * two entries belong to neither.
 */
function entryLines(lines: string[], seq: YSeq, item: YMap): LineRange | null {
  const dash = seq.col - 1;
  // the "-" is on the entry's first line ("- id: x"), or alone on a line above it
  let first = item.line;
  const at = (n: number): string => lines[n - 1] || '';
  const isDash = (n: number): boolean => indentOf(at(n)) === dash && at(n).charAt(dash) === '-';
  if (!isDash(first)) {
    first--;
    while (first > 0 && (isBlank(at(first)) || isComment(at(first)))) first--;
    if (first < 1 || !isDash(first) || at(first).trim() !== '-') return null;
  }
  let end = first;
  for (let n = first + 1; n <= lines.length; n++) {
    const s = at(n);
    if (isBlank(s) || isComment(s)) continue;
    if (indentOf(s) <= dash) break;
    end = n;
  }
  // comments and blank lines inside the entry belong to it; those after its last content line do not
  return end < item.line ? null : { first, last: end };
}

/**
 * Serializer for the netatlas YAML subset: the inverse of yaml.ts.
 *
 * Guarantees (checked by the tests):
 *   parse(stringify(tree)) has the same data as `tree` (keys, order, values,
 *   and the original text of plain scalars), and stringify is idempotent.
 *
 * Presentation that is preserved: key order, comments on their own lines
 * above keys / list items, trailing "# comments", blank lines between
 * entries, quoting style, and flow ([a, b] / {a: 1}) vs block style.
 * Normalized: indentation (2 spaces), spacing inside flow collections, and
 * folded (>) block scalars, which are written as literal (|) blocks with the
 * same value. The "---" / "..." document markers are not written.
 */
import { YMap, YNode, YScalar, YSeq, isPlainSafe, resolvePlain } from './yaml';

const IND = '  ';
const MAX_FLOW_LINE = 140;

export function stringifyYaml(root: YNode | null): string {
  const out: string[] = [];
  if (root) {
    if (root.kind === 'map') emitMapBody(root, '', out, null);
    else if (root.kind === 'seq') emitSeqBody(root, '', out);
    else {
      lead(root, '', out);
      const t = scalarInline(root, false);
      if (t === null) emitBlockScalarLines('', root, '', out, true);
      else out.push(t + trailing(root));
    }
    if (root.endComments) for (const c of root.endComments) out.push(c);
    while (out.length && out[out.length - 1] === '') out.pop();
  }
  // drop a leading blank line
  while (out.length && out[0] === '') out.shift();
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ scalars

function hex4(n: number): string {
  return ('000' + n.toString(16).toUpperCase()).slice(-4);
}

/** Double-quoted form: always representable. */
export function doubleQuote(s: string): string {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const c = s.charCodeAt(i);
    if (ch === '\\') r += '\\\\';
    else if (ch === '"') r += '\\"';
    else if (ch === '\n') r += '\\n';
    else if (ch === '\t') r += '\\t';
    else if (ch === '\r') r += '\\r';
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || c === 0xfffe || c === 0xffff) {
      r += '\\u' + hex4(c);
    } else r += ch;
  }
  return r + '"';
}

function singleQuotable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return false;
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b));
}

function numberText(v: number): string {
  if (isNaN(v)) return '.nan';
  if (v === Infinity) return '.inf';
  if (v === -Infinity) return '-.inf';
  return String(v);
}

/** Inline text for a scalar, or null when it must be written as a block scalar. */
export function scalarInline(n: YScalar, inFlow: boolean): string | null {
  const v = n.value;
  if (v === null) {
    if (!n.quoted && n.raw !== '' && isPlainSafe(n.raw, inFlow) && resolvePlain(n.raw) === null) return n.raw;
    return inFlow ? 'null' : '';
  }
  if (typeof v === 'string') {
    if (!n.quoted && isPlainSafe(n.raw, inFlow) && n.raw === v && resolvePlain(v) === v) return v;
    if (v.indexOf('\n') >= 0) {
      if (!inFlow && blockRepresentable(v)) return null;
      return doubleQuote(v);
    }
    if (n.style === 'single' && singleQuotable(v)) return "'" + v.replace(/'/g, "''") + "'";
    return doubleQuote(v);
  }
  // number / boolean: keep the original spelling (0x1F, 1e3, True …) when possible
  if (!n.quoted && n.raw !== '' && isPlainSafe(n.raw, inFlow) && sameValue(resolvePlain(n.raw), v)) return n.raw;
  return typeof v === 'number' ? numberText(v) : v ? 'true' : 'false';
}

/** Can the string be written as a literal block scalar in this subset? */
function blockRepresentable(v: string): boolean {
  const body = v.replace(/\n+$/, '');
  if (body === '') return false;
  const lines = body.split('\n');
  const firstContent = lines.find((l) => l !== '');
  if (firstContent === undefined || /^[ \t]/.test(firstContent)) return false;
  for (const l of lines) {
    if (l !== '' && l.trim() === '') return false; // whitespace-only lines would be normalized
    if (/^\t/.test(l)) return false; // looks like tab indentation to the parser
    for (let i = 0; i < l.length; i++) {
      const c = l.charCodeAt(i);
      if ((c < 0x20 && c !== 9) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) return false;
    }
  }
  return true;
}

function emitBlockScalarLines(head: string, n: YScalar, childIndent: string, out: string[], root = false): void {
  const v = n.value as string;
  const m = /\n*$/.exec(v);
  const trail = m ? m[0].length : 0;
  const chomp = trail === 0 ? '-' : trail === 1 ? '' : '+';
  const h = (root ? '' : head + ' ') + '|' + chomp;
  out.push(h + trailing(n));
  const body = v.slice(0, v.length - trail);
  for (const l of body.split('\n')) out.push(l === '' ? '' : childIndent + l);
  for (let i = 1; i < trail; i++) out.push('');
}

// ------------------------------------------------------------------ helpers

/** Trailing comment; the stored text keeps its original spacing (" # c" or "   # c"). */
function trailing(n: YNode): string {
  if (!n.comment) return '';
  return /^[ 	]/.test(n.comment) ? n.comment : ' ' + n.comment;
}

function lead(n: YNode, ind: string, out: string[]): void {
  if (n.blank) out.push('');
  if (n.before) for (const c of n.before) out.push(c === '' ? '' : ind + c);
}

export function keyText(k: string, inFlow: boolean): string {
  return isPlainSafe(k, inFlow) ? k : doubleQuote(k);
}

function hasComments(n: YNode): boolean {
  if (n.before || n.comment || n.blank) return true;
  if (n.kind === 'seq') return n.items.some(hasComments);
  if (n.kind === 'map') {
    let any = false;
    n.entries.forEach((e) => {
      if (hasComments(e.value)) any = true;
    });
    return any;
  }
  return false;
}

/** Flow text for a whole node, or null if it cannot be written inline. */
export function flowText(n: YNode): string | null {
  if (n.kind === 'scalar') return scalarInline(n, true);
  if (n.kind === 'seq') {
    const parts: string[] = [];
    for (const i of n.items) {
      if (hasComments(i)) return null;
      const t = flowText(i);
      if (t === null) return null;
      parts.push(t);
    }
    return '[' + parts.join(', ') + ']';
  }
  const parts: string[] = [];
  let ok = true;
  n.entries.forEach((e, k) => {
    if (!ok) return;
    if (hasComments(e.value)) {
      ok = false;
      return;
    }
    const t = flowText(e.value);
    if (t === null) ok = false;
    else parts.push(keyText(k, true) + ': ' + t);
  });
  return ok ? '{' + parts.join(', ') + '}' : null;
}

/**
 * Append the value `n` after `head` ("key:" or "-", already indented).
 * `childIndent` is the indentation for nested block content.
 */
function emitAfter(head: string, n: YNode, childIndent: string, out: string[]): void {
  if (n.kind === 'scalar') {
    const t = scalarInline(n, false);
    if (t === null) emitBlockScalarLines(head, n, childIndent, out);
    else out.push(head + (t === '' ? '' : ' ' + t) + trailing(n));
    return;
  }
  const empty = n.kind === 'seq' ? n.items.length === 0 : n.entries.size === 0;
  if (empty) {
    out.push(head + (n.kind === 'seq' ? ' []' : ' {}') + trailing(n));
    return;
  }
  if (n.flow) {
    const t = flowText(n);
    if (t !== null && head.length + 1 + t.length + trailing(n).length <= MAX_FLOW_LINE) {
      out.push(head + ' ' + t + trailing(n));
      return;
    }
  }
  out.push(head + trailing(n));
  if (n.kind === 'map') emitMapBody(n, childIndent, out, null);
  else emitSeqBody(n, childIndent, out);
}

/** Block mapping. `firstPrefix` replaces the indentation of the first key line ("- " compact form). */
function emitMapBody(m: YMap, ind: string, out: string[], firstPrefix: string | null): void {
  let first = true;
  m.entries.forEach((e, k) => {
    const v = e.value;
    if (!(first && firstPrefix !== null)) lead(v, ind, out);
    const head = (first && firstPrefix !== null ? firstPrefix : ind) + keyText(k, false) + ':';
    emitAfter(head, v, ind + IND, out);
    first = false;
  });
}

function emitSeqBody(s: YSeq, ind: string, out: string[]): void {
  for (const item of s.items) {
    lead(item, ind, out);
    if (item.kind === 'map' && item.entries.size > 0 && !item.comment) {
      const t = item.flow ? flowText(item) : null;
      if (t !== null && ind.length + 2 + t.length <= MAX_FLOW_LINE) {
        out.push(ind + '- ' + t);
        continue;
      }
      // compact "- key: value" form; comments of the first entry go above the dash
      const firstEntry = item.entries.values().next().value as { value: YNode };
      lead(firstEntry.value, ind, out);
      emitMapBody(item, ind + IND, out, ind + '- ');
      continue;
    }
    emitAfter(ind + '-', item, ind + IND, out);
  }
}

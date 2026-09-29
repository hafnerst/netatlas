/**
 * netatlas YAML subset parser.
 *
 * This is deliberately NOT a complete YAML implementation. It parses a
 * documented, safe subset (see docs/YAML-SUBSET.md) and rejects everything
 * else with a clear, line-numbered error instead of guessing.
 *
 * Supported:
 *   - block mappings and block sequences (including "- key: value" compact form)
 *   - plain, 'single-quoted' and "double-quoted" scalars (single line)
 *   - literal (|) and folded (>) block scalars with optional - / + chomping
 *   - single-line flow sequences [a, b] and flow mappings {a: 1, b: 2}
 *   - comments, an optional leading "---" and optional trailing "..."
 *   - YAML 1.2 core-schema resolution of null / booleans / ints / floats
 *
 * Rejected (with an explicit error):
 *   anchors (&), aliases (*), tags (!), merge keys (<<), directives (%),
 *   complex keys (?), multiple documents, multi-line plain or quoted scalars,
 *   multi-line flow collections, tab indentation, duplicate keys,
 *   explicit block-scalar indentation indicators, reserved indicators (@ `).
 *
 * Hard limits bound the work done on untrusted input (size, lines, depth,
 * node count, scalar length).
 */

export type ScalarValue = string | number | boolean | null;

/**
 * Presentation details kept so a document can be written back faithfully
 * (see yaml-write.ts). They never affect the data.
 */
export interface YTrivia {
  /** full-line comments (each starting with "#") directly above this node's line */
  before?: string[];
  /** a blank line precedes this node (or its leading comments) */
  blank?: boolean;
  /** trailing "# comment" on the line where the node (or its key) starts */
  comment?: string;
  /** root only: comments after the last node */
  endComments?: string[];
}

export type ScalarStyle = 'plain' | 'single' | 'double' | 'literal' | 'folded';

export interface YScalar extends YTrivia {
  kind: 'scalar';
  value: ScalarValue;
  /** Source text of the scalar (unquoted/unescaped for quoted scalars). */
  raw: string;
  quoted: boolean;
  /** how the scalar was written (absent = plain or unknown) */
  style?: ScalarStyle;
  line: number;
  col: number;
}

export interface YSeq extends YTrivia {
  kind: 'seq';
  items: YNode[];
  /** written as [a, b] */
  flow?: boolean;
  line: number;
  col: number;
}

export interface YMapEntry {
  key: string;
  keyLine: number;
  value: YNode;
}

export interface YMap extends YTrivia {
  kind: 'map';
  entries: Map<string, YMapEntry>;
  /** written as {a: 1} */
  flow?: boolean;
  line: number;
  col: number;
}

export type YNode = YScalar | YSeq | YMap;

export interface YamlLimits {
  maxBytes: number;
  maxLines: number;
  maxDepth: number;
  maxNodes: number;
  maxScalarLength: number;
}

export const DEFAULT_YAML_LIMITS: YamlLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxLines: 100000,
  maxDepth: 32,
  maxNodes: 250000,
  maxScalarLength: 10000,
};

export class YamlError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, line: number, col = 0) {
    super(message);
    this.name = 'YamlError';
    this.line = line;
    this.col = col;
  }
}

interface Line {
  /** 1-based source line number */
  no: number;
  /** original text (used by block scalars) */
  raw: string;
  /** column at which `text` starts */
  indent: number;
  /** content after indentation (may be rewritten for compact "- " forms) */
  text: string;
  /** full-line comment text (starting with "#"), if this is a comment line */
  comment?: string;
}

const NULL_RE = /^(?:~|null|Null|NULL)$/;
const TRUE_RE = /^(?:true|True|TRUE)$/;
const FALSE_RE = /^(?:false|False|FALSE)$/;
const INT_RE = /^[-+]?[0-9]+$/;
const OCT_RE = /^0o[0-7]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INF_RE = /^[-+]?\.(?:inf|Inf|INF)$/;
const NAN_RE = /^\.(?:nan|NaN|NAN)$/;

/** Resolve a plain scalar according to the YAML 1.2 core schema. */
export function resolvePlain(s: string): ScalarValue {
  if (s === '' || NULL_RE.test(s)) return null;
  if (TRUE_RE.test(s)) return true;
  if (FALSE_RE.test(s)) return false;
  if (INT_RE.test(s)) {
    const n = Number(s);
    // Integers that do not fit a double exactly stay strings (raw is kept anyway).
    return Number.isSafeInteger(n) ? n : s;
  }
  if (OCT_RE.test(s)) return parseInt(s.slice(2), 8);
  if (HEX_RE.test(s)) return parseInt(s.slice(2), 16);
  if (FLOAT_RE.test(s)) return Number(s);
  if (INF_RE.test(s)) return s.charAt(0) === '-' ? -Infinity : Infinity;
  if (NAN_RE.test(s)) return NaN;
  return s;
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\t';
}

class Parser {
  private lines: Line[] = [];
  private pos = 0;
  private nodes = 0;
  /** index of the first line whose comments have not been attached yet */
  private cCursor = 0;
  /** blank lines ended the previous block scalar (presentation only, unless kept by "+") */
  private pendingBlank = false;

  constructor(private readonly limits: YamlLimits) {}

  parse(input: string): YNode | null {
    if (input.length > this.limits.maxBytes) {
      throw new YamlError(
        `input is ${input.length} characters; the limit is ${this.limits.maxBytes}`,
        1,
      );
    }
    if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
    // Reject control characters other than TAB / LF / CR (and DEL / C1 controls).
    // eslint-disable-next-line no-control-regex
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F￾￿]/.exec(input);
    if (bad) {
      const line = input.slice(0, bad.index).split(/\r\n|\r|\n/).length;
      throw new YamlError(
        `control character U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} is not allowed`,
        line,
      );
    }
    const rawLines = input.split(/\r\n|\r|\n/);
    // A final line break terminates the last line; it does not start an empty one.
    if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    if (rawLines.length > this.limits.maxLines) {
      throw new YamlError(`input has ${rawLines.length} lines; the limit is ${this.limits.maxLines}`, 1);
    }
    let sawStart = false;
    let ended = false;
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      const no = i + 1;
      let indent = 0;
      while (indent < raw.length && raw.charAt(indent) === ' ') indent++;
      const text = raw.slice(indent);
      if (text.charAt(0) === '\t' && text.trim() !== '' && text.trim().charAt(0) !== '#') {
        throw new YamlError('tab characters are not allowed for indentation (use spaces)', no, indent + 1);
      }
      const trimmed = text.replace(/[ \t]+$/, '');
      if (ended) {
        if (trimmed === '' || trimmed.charAt(0) === '#') continue;
        throw new YamlError(
          'content after the document end marker "..." — multiple documents are not supported',
          no,
        );
      }
      if (indent === 0 && /^---(?:[ \t]|$)/.test(trimmed)) {
        const rest = trimmed.slice(3).trim();
        if (rest !== '' && rest.charAt(0) !== '#') {
          throw new YamlError('content on the "---" line is not supported; start the document on the next line', no);
        }
        const anyContent = this.lines.some((l) => isSignificant(l));
        if (sawStart || anyContent) {
          throw new YamlError('a second document ("---") was found — multiple documents are not supported', no);
        }
        sawStart = true;
        continue;
      }
      if (indent === 0 && /^\.\.\.(?:[ \t]|$)/.test(trimmed)) {
        ended = true;
        continue;
      }
      if (indent === 0 && trimmed.charAt(0) === '%') {
        throw new YamlError('YAML directives (%YAML, %TAG) are not supported', no);
      }
      const lead = trimmed.replace(/^[ \t]+/, '');
      // Blank and comment-only lines are kept (block scalars need them) but marked insignificant.
      this.lines.push({
        no,
        raw,
        indent,
        text: lead === '' || lead.charAt(0) === '#' ? '' : trimmed,
        comment: lead.charAt(0) === '#' ? lead : undefined,
      });
    }

    this.skipInsignificant();
    if (this.pos >= this.lines.length) return null;
    const first = this.lines[this.pos];
    if (first.indent !== 0) {
      throw new YamlError('the document must start at column 1 (no indentation)', first.no, first.indent + 1);
    }
    const root = this.parseBlock(0, 1);
    this.skipInsignificant();
    if (this.pos < this.lines.length) {
      const l = this.lines[this.pos];
      throw new YamlError('unexpected content — check the indentation of this line', l.no, l.indent + 1);
    }
    const tail = this.take(this.lines.length);
    if (tail.before) root.endComments = tail.before;
    return root;
  }

  // ---------------------------------------------------------------- helpers

  private countNode(line: number): void {
    if (++this.nodes > this.limits.maxNodes) {
      throw new YamlError(`document has more than ${this.limits.maxNodes} nodes`, line);
    }
  }

  private checkDepth(depth: number, line: number): void {
    if (depth > this.limits.maxDepth) {
      throw new YamlError(`nesting is deeper than ${this.limits.maxDepth} levels`, line);
    }
  }

  /** Comments / blank lines between the last attached position and line index `upto`. */
  private take(upto: number): { before?: string[]; blank?: boolean } {
    const before: string[] = [];
    let blank = this.pendingBlank;
    this.pendingBlank = false;
    for (let i = this.cCursor; i < upto && i < this.lines.length; i++) {
      const l = this.lines[i];
      if (l.comment !== undefined) before.push(l.comment);
      else if (l.text === '' && !before.length) blank = true;
      // a blank line after a comment is kept as "" (runs of blank lines collapse to one)
      else if (l.text === '' && before[before.length - 1] !== '') before.push('');
    }
    if (upto > this.cCursor) this.cCursor = upto;
    return { before: before.length ? before : undefined, blank: blank || undefined };
  }

  private attach(node: YNode, lead: { before?: string[]; blank?: boolean }): void {
    if (lead.before) node.before = lead.before;
    if (lead.blank) node.blank = true;
  }

  private skipInsignificant(): void {
    while (this.pos < this.lines.length && !isSignificant(this.lines[this.pos])) this.pos++;
  }

  private peek(): Line | null {
    this.skipInsignificant();
    return this.pos < this.lines.length ? this.lines[this.pos] : null;
  }

  private scalar(value: ScalarValue, raw: string, quoted: boolean, line: number, col: number): YScalar {
    this.countNode(line);
    if (raw.length > this.limits.maxScalarLength) {
      throw new YamlError(`scalar is longer than ${this.limits.maxScalarLength} characters`, line, col);
    }
    return { kind: 'scalar', value, raw, quoted, line, col };
  }

  // ---------------------------------------------------------- block nodes

  /** Parse the block node whose first line is the next significant line (indent >= minIndent). */
  private parseBlock(minIndent: number, depth: number): YNode {
    const l = this.peek();
    if (!l || l.indent < minIndent) {
      const at = l ? l.no : this.lines.length ? this.lines[this.lines.length - 1].no : 1;
      return this.scalar(null, '', false, at, 0);
    }
    this.checkDepth(depth, l.no);
    if (isSeqItem(l.text)) return this.parseSeq(l.indent, depth);
    if (findMappingColon(l) >= 0) return this.parseMap(l.indent, depth);
    // A lone scalar or flow collection on its own line.
    this.pos++;
    const node = this.parseInlineValue(l, 0, l.indent, depth);
    this.expectNoDeeper(l.indent);
    return node;
  }

  /** After an inline value, a more-indented line would be a multi-line continuation. */
  private expectNoDeeper(indent: number): void {
    const n = this.peek();
    if (n && n.indent > indent) {
      throw new YamlError(
        'unexpected indentation — multi-line plain scalars are not supported (quote the value or use a | or > block scalar), ' +
          'and a key cannot have both an inline value and nested content',
        n.no,
        n.indent + 1,
      );
    }
  }

  private parseSeq(indent: number, depth: number): YSeq {
    const first = this.peek() as Line;
    this.countNode(first.no);
    const seq: YSeq = { kind: 'seq', items: [], line: first.no, col: indent + 1 };
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) {
        throw new YamlError('unexpected indentation inside a sequence', l.no, l.indent + 1);
      }
      if (!isSeqItem(l.text)) {
        // A mapping key at the same indentation ends a sequence that is a mapping value.
        break;
      }
      let off = 1;
      while (off < l.text.length && l.text.charAt(off) === ' ') off++;
      const rest = l.text.slice(off);
      const lead = this.take(this.pos + 1);
      let item: YNode;
      if (rest === '' || rest.charAt(0) === '#') {
        this.pos++;
        const n = this.peek();
        if (n && n.indent > indent) item = this.parseBlock(indent + 1, depth + 1);
        else item = this.scalar(null, '', false, l.no, indent + 1);
        if (rest !== '') item.comment = l.text.slice(1);
      } else {
        // Compact form: rewrite the current line as if the item content started on its own line.
        l.indent = indent + off;
        l.text = rest;
        if (isSeqItem(rest) || findMappingColon(l) >= 0) {
          item = this.parseBlock(l.indent, depth + 1);
        } else {
          this.pos++;
          item = this.parseInlineValue(l, 0, indent, depth + 1);
          this.expectNoDeeper(indent);
        }
      }
      this.attach(item, lead);
      seq.items.push(item);
    }
    return seq;
  }

  private parseMap(indent: number, depth: number): YMap {
    const first = this.peek() as Line;
    this.countNode(first.no);
    const map: YMap = { kind: 'map', entries: new Map(), line: first.no, col: indent + 1 };
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) {
        throw new YamlError(
          'unexpected indentation — multi-line plain scalars are not supported, and nested content must follow a key that ends with ":"',
          l.no,
          l.indent + 1,
        );
      }
      if (isSeqItem(l.text)) {
        throw new YamlError('a sequence item ("- ") appears where a mapping key was expected', l.no, l.indent + 1);
      }
      const colon = findMappingColon(l);
      if (colon < 0) {
        throw new YamlError(
          'expected "key: value" — multi-line plain scalars are not supported (quote the value or use | / >)',
          l.no,
          l.indent + 1,
        );
      }
      const key = this.parseKey(l, colon);
      if (map.entries.has(key)) {
        throw new YamlError(
          `duplicate key "${truncate(key)}" (first defined on line ${(map.entries.get(key) as YMapEntry).keyLine})`,
          l.no,
          l.indent + 1,
        );
      }
      let off = colon + 1;
      while (off < l.text.length && isWs(l.text.charAt(off))) off++;
      const rest = l.text.slice(off);
      const lead = this.take(this.pos + 1);
      let value: YNode;
      if (rest === '' || rest.charAt(0) === '#') {
        this.pos++;
        const n = this.peek();
        if (n && n.indent > indent) {
          value = this.parseBlock(indent + 1, depth + 1);
        } else if (n && n.indent === indent && isSeqItem(n.text)) {
          this.checkDepth(depth + 1, n.no);
          value = this.parseSeq(indent, depth + 1);
        } else {
          value = this.scalar(null, '', false, l.no, off + l.indent + 1);
        }
        if (rest !== '') value.comment = l.text.slice(colon + 1);
      } else {
        this.pos++;
        value = this.parseInlineValue(l, off, indent, depth + 1);
        this.expectNoDeeper(indent);
      }
      this.attach(value, lead);
      map.entries.set(key, { key, keyLine: l.no, value });
    }
    return map;
  }

  private parseKey(l: Line, colon: number): string {
    const t = l.text;
    const c0 = t.charAt(0);
    if (c0 === '?' && (t.length === 1 || isWs(t.charAt(1)))) {
      throw new YamlError('complex mapping keys ("? ") are not supported', l.no, l.indent + 1);
    }
    let key: string;
    if (c0 === '"' || c0 === "'") {
      const q = scanQuoted(t, 0, l.no, l.indent);
      key = q.value;
    } else {
      key = t.slice(0, colon).replace(/[ \t]+$/, '');
      this.rejectIndicator(key, l, 0, true);
    }
    if (key === '<<' && c0 !== '"' && c0 !== "'") {
      throw new YamlError('merge keys ("<<") are not supported', l.no, l.indent + 1);
    }
    if (key.length > 256) throw new YamlError('mapping key is longer than 256 characters', l.no, l.indent + 1);
    this.countNode(l.no);
    return key;
  }

  private rejectIndicator(s: string, l: Line, off: number, isKey: boolean): void {
    const c = s.charAt(0);
    const col = l.indent + off + 1;
    const what = isKey ? 'key' : 'value';
    if (c === '&') throw new YamlError(`anchors ("&") are not supported (in ${what})`, l.no, col);
    if (c === '*') throw new YamlError(`aliases ("*") are not supported (in ${what})`, l.no, col);
    if (c === '!') throw new YamlError(`tags ("!") are not supported (in ${what})`, l.no, col);
    if (c === '@' || c === '`') throw new YamlError(`"${c}" is a reserved YAML indicator; quote the ${what}`, l.no, col);
    if (c === '%') throw new YamlError(`a ${what} starting with "%" must be quoted`, l.no, col);
    if (c === '?' && (s.length === 1 || isWs(s.charAt(1)))) throw new YamlError('complex mapping keys ("? ") are not supported', l.no, col);
    if (isKey && (c === '[' || c === '{')) throw new YamlError('flow collections cannot be used as mapping keys', l.no, col);
    if (isKey && (c === '|' || c === '>')) throw new YamlError(`a key starting with "${c}" must be quoted`, l.no, col);
  }

  /** Parse a value that starts at `off` within line `l` and ends on that line (or is a block scalar). */
  private parseInlineValue(l: Line, off: number, parentIndent: number, depth: number): YNode {
    const t = l.text;
    const c = t.charAt(off);
    const col = l.indent + off + 1;
    this.checkDepth(depth, l.no);
    if (c === '|' || c === '>') return this.parseBlockScalar(l, off, parentIndent);
    if (c === '[' || c === '{') {
      const fp = new FlowParser(this, t, l, depth);
      const node = fp.parseFlowNode(off);
      const comment = fp.expectLineEnd();
      if (comment) node.comment = comment;
      return node;
    }
    if (c === '"' || c === "'") {
      const q = scanQuoted(t, off, l.no, l.indent);
      const after = t.slice(q.end).replace(/^[ \t]+/, '');
      if (after !== '' && !(after.charAt(0) === '#' && q.end < t.length && isWs(t.charAt(q.end)))) {
        throw new YamlError('unexpected text after a quoted scalar', l.no, l.indent + q.end + 1);
      }
      const qs = this.scalar(q.value, q.value, true, l.no, col);
      qs.style = c === '"' ? 'double' : 'single';
      if (after !== '') qs.comment = t.slice(q.end);
      return qs;
    }
    if (c === '-' && (t.length === off + 1 || isWs(t.charAt(off + 1)))) {
      throw new YamlError('a sequence cannot start on the same line as a mapping key; put "- item" on the next line', l.no, col);
    }
    this.rejectIndicator(t.slice(off), l, off, false);
    // plain scalar: runs to a " #" comment or the end of the line
    let end = t.length;
    for (let i = off; i < t.length; i++) {
      if (t.charAt(i) === '#' && i > off && isWs(t.charAt(i - 1))) {
        end = i;
        break;
      }
    }
    const raw = t.slice(off, end).replace(/[ \t]+$/, '');
    if (/:(?:[ \t]|$)/.test(raw)) {
      throw new YamlError(
        'a plain value may not contain ": " (a nested mapping must go on the next line; otherwise quote the value)',
        l.no,
        col,
      );
    }
    const ps = this.scalar(resolvePlain(raw), raw, false, l.no, col);
    if (end < t.length) ps.comment = t.slice(off + raw.length);
    return ps;
  }

  private parseBlockScalar(l: Line, off: number, parentIndent: number): YScalar {
    const header = l.text.slice(off);
    const m = /^([|>])([-+]?)([ \t]+#.*)?$/.exec(header);
    if (!m) {
      if (/^[|>][-+]?[0-9]/.test(header) || /^[|>][0-9]/.test(header)) {
        throw new YamlError('explicit indentation indicators on block scalars are not supported', l.no, l.indent + off + 1);
      }
      throw new YamlError('invalid block scalar header (use |, |-, |+, >, >- or >+)', l.no, l.indent + off + 1);
    }
    const folded = m[1] === '>';
    const chomp = m[2];
    const startLine = l.no;
    // Collect raw lines: blank lines, or lines indented deeper than the parent.
    const body: string[] = [];
    let contentIndent = -1;
    while (this.pos < this.lines.length) {
      const nl = this.lines[this.pos];
      const blank = nl.raw.trim() === '';
      if (!blank) {
        let ind = 0;
        while (ind < nl.raw.length && nl.raw.charAt(ind) === ' ') ind++;
        if (ind <= parentIndent) break;
        if (contentIndent < 0) contentIndent = ind;
        if (ind < contentIndent) {
          throw new YamlError('block scalar line is less indented than its first line', nl.no, ind + 1);
        }
        body.push(nl.raw.slice(contentIndent));
      } else {
        body.push(contentIndent >= 0 ? nl.raw.slice(Math.min(contentIndent, nl.raw.length)) : '');
      }
      this.pos++;
    }
    // Trailing blank lines were consumed; they belong to chomping.
    let trailing = 0;
    while (body.length && body[body.length - 1].trim() === '') {
      body.pop();
      trailing++;
    }
    let text: string;
    if (!folded) {
      text = body.join('\n');
    } else {
      text = '';
      let prevMore = false;
      for (let i = 0; i < body.length; i++) {
        const ln = body[i];
        const more = ln.charAt(0) === ' ' || ln.charAt(0) === '\t';
        if (i === 0) text = ln;
        else if (ln === '') text += '\n';
        else if (body[i - 1] === '' || more || prevMore) text += (body[i - 1] === '' ? '' : '\n') + ln;
        else text += ' ' + ln;
        prevMore = more;
      }
    }
    if (body.length) {
      if (chomp === '') text += '\n';
      else if (chomp === '+') text += '\n' + '\n'.repeat(trailing);
    }
    const bs = this.scalar(text, text, true, startLine, l.indent + off + 1);
    bs.style = folded ? 'folded' : 'literal';
    if (m[3]) bs.comment = m[3].trim();
    // block content may look like comments; it is never attached as such
    this.cCursor = this.pos;
    if (trailing > 0 && chomp !== '+') this.pendingBlank = true;
    return bs;
  }

  // exposed to FlowParser
  mkScalar(value: ScalarValue, raw: string, quoted: boolean, line: number, col: number): YScalar {
    return this.scalar(value, raw, quoted, line, col);
  }
  mkNode(line: number): void {
    this.countNode(line);
  }
  depthCheck(depth: number, line: number): void {
    this.checkDepth(depth, line);
  }
}

/** Single-line flow collection parser. */
class FlowParser {
  private i = 0;
  constructor(
    private readonly p: Parser,
    private readonly t: string,
    private readonly l: Line,
    private readonly depth: number,
  ) {}

  private err(msg: string, at = this.i): never {
    throw new YamlError(msg, this.l.no, this.l.indent + at + 1);
  }

  private ws(): void {
    while (this.i < this.t.length && isWs(this.t.charAt(this.i))) this.i++;
  }

  /** Returns the trailing comment, if any. */
  expectLineEnd(): string | undefined {
    const start = this.i;
    this.ws();
    if (this.i >= this.t.length) return undefined;
    if (this.t.charAt(this.i) === '#' && this.i > start) return this.t.slice(start);
    this.err('unexpected text after a flow collection');
  }

  parseFlowNode(off: number): YNode {
    this.i = off;
    return this.node(this.depth);
  }

  private node(depth: number): YNode {
    this.p.depthCheck(depth, this.l.no);
    this.ws();
    if (this.i >= this.t.length) {
      this.err('flow collection is not closed on this line — multi-line flow collections are not supported');
    }
    const c = this.t.charAt(this.i);
    const col = this.l.indent + this.i + 1;
    if (c === '[') {
      this.p.mkNode(this.l.no);
      const seq: YSeq = { kind: 'seq', items: [], flow: true, line: this.l.no, col };
      this.i++;
      for (;;) {
        this.ws();
        if (this.i >= this.t.length) this.err('flow collection is not closed on this line — multi-line flow collections are not supported');
        if (this.t.charAt(this.i) === ']') {
          this.i++;
          return seq;
        }
        seq.items.push(this.node(depth + 1));
        this.ws();
        const d = this.t.charAt(this.i);
        if (d === ',') this.i++;
        else if (d === ']') {
          this.i++;
          return seq;
        } else if (d === '') this.err('flow sequence is not closed on this line — multi-line flow collections are not supported');
        else this.err('expected "," or "]" in flow sequence');
      }
    }
    if (c === '{') {
      this.p.mkNode(this.l.no);
      const map: YMap = { kind: 'map', entries: new Map(), flow: true, line: this.l.no, col };
      this.i++;
      for (;;) {
        this.ws();
        if (this.i >= this.t.length) this.err('flow collection is not closed on this line — multi-line flow collections are not supported');
        if (this.t.charAt(this.i) === '}') {
          this.i++;
          return map;
        }
        const keyNode = this.scalarTok(true);
        const key = keyNode.raw;
        if (!keyNode.quoted && key === '<<') this.err('merge keys ("<<") are not supported');
        this.ws();
        if (this.t.charAt(this.i) !== ':') this.err('expected ":" after key in flow mapping');
        this.i++;
        if (map.entries.has(key)) this.err(`duplicate key "${truncate(key)}"`);
        this.ws();
        const nc = this.t.charAt(this.i);
        const value =
          nc === ',' || nc === '}'
            ? this.p.mkScalar(null, '', false, this.l.no, this.l.indent + this.i + 1)
            : this.node(depth + 1);
        map.entries.set(key, { key, keyLine: this.l.no, value });
        this.ws();
        const d = this.t.charAt(this.i);
        if (d === ',') this.i++;
        else if (d === '}') {
          this.i++;
          return map;
        } else if (d === '') this.err('flow mapping is not closed on this line — multi-line flow collections are not supported');
        else this.err('expected "," or "}" in flow mapping');
      }
    }
    return this.scalarTok(false);
  }

  private scalarTok(isKey: boolean): YScalar {
    this.ws();
    const c = this.t.charAt(this.i);
    const col = this.l.indent + this.i + 1;
    if (c === '"' || c === "'") {
      const q = scanQuoted(this.t, this.i, this.l.no, this.l.indent);
      this.i = q.end;
      const qs = this.p.mkScalar(q.value, q.value, true, this.l.no, col);
      qs.style = c === '"' ? 'double' : 'single';
      return qs;
    }
    if (c === '&') this.err('anchors ("&") are not supported');
    if (c === '*') this.err('aliases ("*") are not supported');
    if (c === '!') this.err('tags ("!") are not supported');
    if (c === '@' || c === '`') this.err(`"${c}" is a reserved YAML indicator; quote the value`);
    if (c === '|' || c === '>') this.err('block scalars cannot be used inside flow collections');
    if (c === '?' ) this.err('complex keys ("?") are not supported');
    if (c === '[' || c === '{') {
      if (isKey) this.err('flow collections cannot be used as mapping keys');
    }
    const start = this.i;
    while (this.i < this.t.length) {
      const ch = this.t.charAt(this.i);
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (ch === ':' && (this.i + 1 >= this.t.length || /[ \t,\]}]/.test(this.t.charAt(this.i + 1)))) break;
      if (ch === '#' && this.i > start && isWs(this.t.charAt(this.i - 1))) {
        this.err('comments are not allowed inside a flow collection');
      }
      this.i++;
    }
    const raw = this.t.slice(start, this.i).replace(/[ \t]+$/, '');
    if (raw === '' && isKey) this.err('empty key in flow mapping');
    if (raw === '' && this.i >= this.t.length) {
      this.err('flow collection is not closed on this line — multi-line flow collections are not supported');
    }
    return this.p.mkScalar(isKey ? raw : resolvePlain(raw), raw, false, this.l.no, col);
  }
}

function truncate(s: string): string {
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function isSignificant(l: Line): boolean {
  return l.text !== '' && l.text.charAt(0) !== '#';
}

function isSeqItem(text: string): boolean {
  return text.charAt(0) === '-' && (text.length === 1 || isWs(text.charAt(1)));
}

/**
 * Index of the ":" that separates a block mapping key from its value, or -1.
 * Handles quoted keys and ignores anything after a comment.
 */
function findMappingColon(l: Line): number {
  const t = l.text;
  const c0 = t.charAt(0);
  if (c0 === '[' || c0 === '{' || c0 === '|' || c0 === '>') return -1;
  if (c0 === '"' || c0 === "'") {
    let end: number;
    try {
      end = scanQuoted(t, 0, l.no, l.indent).end;
    } catch (e) {
      return -1;
    }
    let i = end;
    while (i < t.length && isWs(t.charAt(i))) i++;
    if (t.charAt(i) === ':' && (i + 1 >= t.length || isWs(t.charAt(i + 1)))) return i;
    return -1;
  }
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (ch === '#' && i > 0 && isWs(t.charAt(i - 1))) return -1;
    if (ch === ':' && (i + 1 >= t.length || isWs(t.charAt(i + 1)))) return i;
  }
  return -1;
}

const ESCAPES: { [k: string]: string } = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: ' ',
  L: ' ',
  P: ' ',
};

/** Scan a single-line quoted scalar starting at `off`. */
function scanQuoted(t: string, off: number, lineNo: number, indent: number): { value: string; end: number } {
  const q = t.charAt(off);
  let i = off + 1;
  let out = '';
  if (q === "'") {
    for (;;) {
      if (i >= t.length) {
        throw new YamlError(
          'unterminated single-quoted scalar — multi-line quoted scalars are not supported',
          lineNo,
          indent + off + 1,
        );
      }
      const ch = t.charAt(i);
      if (ch === "'") {
        if (t.charAt(i + 1) === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += ch;
      i++;
    }
  }
  for (;;) {
    if (i >= t.length) {
      throw new YamlError(
        'unterminated double-quoted scalar — multi-line quoted scalars are not supported',
        lineNo,
        indent + off + 1,
      );
    }
    const ch = t.charAt(i);
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === '\\') {
      const e = t.charAt(i + 1);
      if (e === '') {
        throw new YamlError('escaped line breaks are not supported in double-quoted scalars', lineNo, indent + i + 1);
      }
      if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
        out += ESCAPES[e];
        i += 2;
        continue;
      }
      const len = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (len) {
        const hex = t.slice(i + 2, i + 2 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new YamlError(`invalid \\${e} escape (expected ${len} hex digits)`, lineNo, indent + i + 1);
        }
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          throw new YamlError(`invalid code point in \\${e} escape`, lineNo, indent + i + 1);
        }
        out += String.fromCodePoint(cp);
        i += 2 + len;
        continue;
      }
      throw new YamlError(`unknown escape sequence "\\${e}"`, lineNo, indent + i + 1);
    }
    out += ch;
    i++;
  }
}

/** Parse a YAML-subset document. Returns null for an empty document. */
export function parseYaml(input: string, limits: Partial<YamlLimits> = {}): YNode | null {
  return new Parser({ ...DEFAULT_YAML_LIMITS, ...limits }).parse(input);
}

/** Convert a node tree to plain JS values (keys are defined safely; no prototype pollution). */
export function toPlain(node: YNode | null): unknown {
  if (!node) return null;
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'seq') return node.items.map(toPlain);
  const o: { [k: string]: unknown } = {};
  node.entries.forEach((e, k) => {
    Object.defineProperty(o, k, { value: toPlain(e.value), enumerable: true, writable: true, configurable: true });
  });
  return o;
}

// ------------------------------------------------------------ constructors
// Nodes created by the editor have line 0 ("not from the source file").

/** A scalar holding a string; quoted only when a plain scalar would read back differently. */
export function strNode(s: string): YScalar {
  const plain = isPlainSafe(s, false) && resolvePlain(s) === s;
  const n: YScalar = { kind: 'scalar', value: s, raw: s, quoted: !plain, line: 0, col: 0 };
  if (!plain) n.style = 'double';
  return n;
}

export function numNode(n: number): YScalar {
  return { kind: 'scalar', value: n, raw: String(n), quoted: false, line: 0, col: 0 };
}

export function boolNode(b: boolean): YScalar {
  return { kind: 'scalar', value: b, raw: b ? 'true' : 'false', quoted: false, line: 0, col: 0 };
}

export function nullNode(): YScalar {
  return { kind: 'scalar', value: null, raw: '', quoted: false, line: 0, col: 0 };
}

/**
 * A scalar typed by YAML rules, as if the text had been written plainly in a
 * file ("42" -> number, "true" -> boolean, "10.0.0.1" -> string). Text that
 * cannot be written plainly becomes a string.
 */
export function autoNode(text: string): YScalar {
  if (text !== '' && isPlainSafe(text, false)) {
    return { kind: 'scalar', value: resolvePlain(text), raw: text, quoted: false, line: 0, col: 0 };
  }
  return strNode(text);
}

export function mapNode(entries: Array<[string, YNode]> = [], flow = false): YMap {
  const m: YMap = { kind: 'map', entries: new Map(), line: 0, col: 0 };
  if (flow) m.flow = true;
  for (const [k, v] of entries) m.entries.set(k, { key: k, keyLine: 0, value: v });
  return m;
}

export function seqNode(items: YNode[] = [], flow = false): YSeq {
  const s: YSeq = { kind: 'seq', items, line: 0, col: 0 };
  if (flow) s.flow = true;
  return s;
}

function copyTrivia(from: YTrivia, to: YTrivia): void {
  if (from.before) to.before = from.before.slice();
  if (from.blank) to.blank = true;
  if (from.comment !== undefined) to.comment = from.comment;
  if (from.endComments) to.endComments = from.endComments.slice();
}

/** Deep copy (including comments and style). */
export function cloneNode<T extends YNode>(n: T): T {
  if (n.kind === 'scalar') {
    const c: YScalar = { kind: 'scalar', value: n.value, raw: n.raw, quoted: n.quoted, line: n.line, col: n.col };
    if (n.style) c.style = n.style;
    copyTrivia(n, c);
    return c as T;
  }
  if (n.kind === 'seq') {
    const c: YSeq = { kind: 'seq', items: n.items.map((i) => cloneNode(i)), line: n.line, col: n.col };
    if (n.flow) c.flow = true;
    copyTrivia(n, c);
    return c as T;
  }
  const c: YMap = { kind: 'map', entries: new Map(), line: n.line, col: n.col };
  n.entries.forEach((e, k) => c.entries.set(k, { key: k, keyLine: e.keyLine, value: cloneNode(e.value) }));
  if (n.flow) c.flow = true;
  copyTrivia(n, c);
  return c as T;
}

/**
 * Can `s` be written as a plain scalar in this parser's subset (block or flow
 * context)? Type resolution ("42" is a number) is checked separately.
 */
export function isPlainSafe(s: string, inFlow: boolean): boolean {
  if (s === '' || s.length > 2000) return false;
  if (/^[ \t]|[ \t]$/.test(s)) return false;
  // eslint-disable-next-line no-control-regex
  if (UNSAFE_CHARS.test(s)) return false;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/:(?:[ \t]|$)/.test(s) || /[ \t]#/.test(s)) return false;
  if (s === '<<' || s === '---' || s === '...') return false;
  if (inFlow && (/[,\[\]{}]/.test(s) || /:[,\]}]/.test(s))) return false;
  return true;

}


// C0/C1 controls, DEL, line/paragraph separators and BOM
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yaml, example, exampleNames } from './helpers.mjs';

const P = (s, limits) => yaml.toPlain(yaml.parseYaml(s, limits));
const rejects = (s, re, line) => {
  assert.throws(
    () => yaml.parseYaml(s),
    (e) => {
      assert.equal(e.name, 'YamlError', String(e));
      assert.match(e.message, re);
      if (line !== undefined) assert.equal(e.line, line, `line of: ${e.message}`);
      return true;
    },
  );
};

test('block mappings, sequences and compact "- key:" items', () => {
  const v = P('a: 1\nb:\n  c: x\n  d:\n    - 1\n    - two\nlist:\n- id: r1\n  x: [1, 2]\n- id: r2\n');
  assert.deepEqual(v, { a: 1, b: { c: 'x', d: [1, 'two'] }, list: [{ id: 'r1', x: [1, 2] }, { id: 'r2' }] });
});

test('nested sequences and empty values', () => {
  assert.deepEqual(P('a:\n  - - 1\n    - 2\n  - []\n  -\nb:\nc: {}\n'), { a: [[1, 2], [], null], b: null, c: {} });
});

test('flow collections on one line', () => {
  assert.deepEqual(P('x: {a: 1, b: [c, "d, e"], f: {g: h}}\ny: [a:b, "q", \'r\', ]\n'), {
    x: { a: 1, b: ['c', 'd, e'], f: { g: 'h' } },
    y: ['a:b', 'q', 'r'],
  });
});

test('YAML 1.2 core schema resolution (no YAML 1.1 yes/no/on/off booleans)', () => {
  const v = P('a: true\nb: False\nc: ~\nd: null\ne: 42\nf: -3.5\ng: 0x1F\nh: 0o17\ni: yes\nj: off\nk: 1e3\nl: .inf\nm: "42"\nn: 10.0.0.1\no: 1.2.3\np: 65000:100\n');
  assert.deepEqual(v, { a: true, b: false, c: null, d: null, e: 42, f: -3.5, g: 31, h: 15, i: 'yes', j: 'off', k: 1000, l: Infinity, m: '42', n: '10.0.0.1', o: '1.2.3', p: '65000:100' });
});

test('raw text is kept for scalars (ids like 0.0.0.1 or 010 survive)', () => {
  const n = yaml.parseYaml('area: 010\nx: 1.10\n');
  assert.equal(n.entries.get('area').value.raw, '010');
  assert.equal(n.entries.get('x').value.raw, '1.10');
});

test('quoted scalars and escapes', () => {
  assert.deepEqual(P(`a: "tab\\there \\u00e9 \\"q\\" \\\\"\nb: 'it''s # not a comment'\nc: x # comment\nd: "#not"\n`), {
    a: 'tab\there é "q" \\',
    b: "it's # not a comment",
    c: 'x',
    d: '#not',
  });
});

test('block scalars: literal, folded, chomping', () => {
  const v = P('a: |\n  line1\n    indented\n  line3\n\nb: >-\n  folded\n  text\n\n  para\nc: |-\n  x\nd: |+\n  y\n\ne: end\n');
  assert.equal(v.a, 'line1\n  indented\nline3\n');
  assert.equal(v.b, 'folded text\npara');
  assert.equal(v.c, 'x');
  assert.equal(v.d, 'y\n\n');
  assert.equal(v.e, 'end');
});

test('comments, document markers, CRLF and BOM', () => {
  assert.deepEqual(P('\ufeff# hi\r\n---\r\na: 1 # c\r\n# x\r\n...\r\n# trailing\r\n'), { a: 1 });
});

test('rejects anchors and aliases (no alias expansion at all)', () => {
  rejects('a: &x 1\n', /anchors/, 1);
  rejects('a: 1\nb: *x\n', /aliases/, 2);
  rejects('- &a\n  b: 1\n', /anchors/, 1);
  rejects('a: [*x]\n', /aliases/, 1);
  rejects('&a k: v\n', /anchors/, 1);
});

test('rejects tags, merge keys, directives, complex keys', () => {
  rejects('a: !!str 1\n', /tags/, 1);
  rejects('a: !custom x\n', /tags/);
  rejects('<<: {a: 1}\n', /merge keys/, 1);
  rejects('a: {<<: x}\n', /merge keys/);
  rejects('%YAML 1.2\n---\na: 1\n', /directives/, 1);
  rejects('? a\n: b\n', /complex/, 1);
  rejects('a: @x\n', /reserved/);
});

test('rejects multiple documents', () => {
  rejects('a: 1\n---\nb: 2\n', /multiple documents/, 2);
  rejects('a: 1\n...\nb: 2\n', /multiple documents/, 3);
});

test('rejects multi-line plain / quoted scalars and multi-line flow', () => {
  rejects('a: this is\n  continued\n', /multi-line plain/, 2);
  rejects('a: "open\n  close"\n', /multi-line quoted/, 1);
  rejects('a: [1,\n  2]\n', /multi-line flow/, 1);
  rejects('a: b: c\n', /": "/, 1);
});

test('rejects duplicate keys, bad indentation and tabs', () => {
  rejects('a: 1\nb: 2\na: 3\n', /duplicate key "a" \(first defined on line 1\)/, 3);
  rejects('a:\n\tb: 1\n', /tab/, 2);
  rejects('a: 1\n  b: 2\n', /indentation/, 2);
  rejects('a:\n  - x\n   - y\n', /indentation/, 3);
  rejects('  a: 1\n', /column 1/, 1);
});

test('rejects control characters and bad escapes', () => {
  rejects('a: "\\q"\n', /unknown escape/);
  rejects('a: x\u0007\n', /control character/);
  rejects('a: "\\uD800"\n', /invalid code point/);
});

test('limits: size, depth, node count, scalar length', () => {
  assert.throws(() => yaml.parseYaml('a: ' + 'x'.repeat(100), { maxBytes: 50 }), /limit is 50/);
  let deep = '';
  for (let i = 0; i < 40; i++) deep += ' '.repeat(i * 2) + 'k:\n';
  assert.throws(() => yaml.parseYaml(deep), /deeper than 32/);
  assert.throws(() => yaml.parseYaml('a: [' + '[1],'.repeat(20) + ']', { maxDepth: 1 }), /deeper/);
  assert.throws(() => yaml.parseYaml('- 1\n'.repeat(1000), { maxNodes: 100 }), /more than 100 nodes/);
  assert.throws(() => yaml.parseYaml('a: ' + 'x'.repeat(200), { maxScalarLength: 100 }), /longer than 100/);
  assert.throws(() => yaml.parseYaml('\n'.repeat(20), { maxLines: 10 }), /limit is 10/);
});

test('"billion laughs" style input is impossible: aliases are refused before any expansion', () => {
  const lol = 'a: &a ["lol","lol"]\nb: &b [*a,*a,*a,*a]\nc: [*b,*b,*b,*b]\n';
  assert.throws(() => yaml.parseYaml(lol), /anchors/);
});

test('keys that could pollute prototypes are plain data', () => {
  const v = P('__proto__: {polluted: 1}\nconstructor: x\n');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.deepEqual(Object.keys(v), ['__proto__', 'constructor']);
});

test('JSON is not special-cased: multi-line JSON is rejected as unsupported YAML', () => {
  rejects('{\n  "a": 1\n}\n', /multi-line flow/, 1);
});

test('every shipped example conforms to the supported subset', () => {
  assert.ok(exampleNames.length >= 3);
  for (const f of exampleNames) {
    const node = yaml.parseYaml(example(f));
    assert.equal(node.kind, 'map', f);
  }
});

// Locating an object's entry in a YAML text (the mark of the selection in the YAML editor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { yamlBlock } = load('editor/yaml-block.js');

/** the marked lines as text, for readable assertions */
const marked = (text, target) => {
  const r = yamlBlock(text, target);
  return r ? text.split(/\r\n|\r|\n/).slice(r.first - 1, r.last) : null;
};

// "core" also appears as a label, in a quoted string, in a comment, as a reference,
// as an interface id, and as "- id: core" inside a block scalar of another device
const TRAPS = `netatlas: 1
title: core
# - id: core   (a comment that looks like an entry)
devices:
  - id: edge
    label: core
    description: "id: core"
    interfaces: [{id: core}]
  - id: core
    label: Core switch

    # a comment inside the entry
    interfaces:
      - {id: e0}
      - id: e1
        description: uplink
  # a comment between two entries
  - id: access
    description: |
      - id: core
        not: an entry
links:
  - id: l1
    a: {device: edge, interface: core}
    b: {device: core, interface: e0}
`;

test('the entry is found through the structure, never where the id only appears as text', () => {
  assert.deepEqual(marked(TRAPS, { kind: 'device', id: 'core' }), [
    '  - id: core',
    '    label: Core switch',
    '',
    '    # a comment inside the entry',
    '    interfaces:',
    '      - {id: e0}',
    '      - id: e1',
    '        description: uplink',
  ]);
  assert.deepEqual(yamlBlock(TRAPS, { kind: 'device', id: 'core' }), { first: 9, last: 16 });
  // the next entry starts after the comment between the two (which belongs to neither)
  assert.deepEqual(marked(TRAPS, { kind: 'device', id: 'access' }), ['  - id: access', '    description: |', '      - id: core', '        not: an entry']);
  assert.deepEqual(marked(TRAPS, { kind: 'device', id: 'edge' }), ['  - id: edge', '    label: core', '    description: "id: core"', '    interfaces: [{id: core}]']);
  // the last entry of the last section ends with the file
  assert.deepEqual(marked(TRAPS, { kind: 'link', id: 'l1' }), ['  - id: l1', '    a: {device: edge, interface: core}', '    b: {device: core, interface: e0}']);
});

test('interfaces: the entry of one interface of one device, in either list', () => {
  assert.deepEqual(marked(TRAPS, { kind: 'device', id: 'core', iface: 'e0' }), ['      - {id: e0}']);
  assert.deepEqual(marked(TRAPS, { kind: 'device', id: 'core', iface: 'e1' }), ['      - id: e1', '        description: uplink']);
  // edge's interface "core" is in a one-line list: several entries could share its line
  assert.equal(yamlBlock(TRAPS, { kind: 'device', id: 'edge', iface: 'core' }), null);
  const logical = 'netatlas: 1\ndevices:\n  - id: r1\n    interfaces:\n      - id: e0\n    logical_interfaces:\n      - id: lo0\n        type: loopback\n';
  assert.deepEqual(marked(logical, { kind: 'device', id: 'r1', iface: 'lo0' }), ['      - id: lo0', '        type: loopback']);
  assert.equal(yamlBlock(logical, { kind: 'device', id: 'r1', iface: 'nope' }), null);
});

test('nothing is marked when the entry cannot be located reliably', () => {
  // invalid YAML (an anchor is outside the supported subset), or not YAML at all
  assert.equal(yamlBlock(TRAPS.replace('  - id: access', '  - &a id: access'), { kind: 'device', id: 'core' }), null);
  assert.equal(yamlBlock('devices: [', { kind: 'device', id: 'core' }), null);
  assert.equal(yamlBlock('', { kind: 'device', id: 'core' }), null);
  // the same id twice in a section
  assert.equal(yamlBlock('netatlas: 1\ndevices:\n  - id: a\n  - id: a\n', { kind: 'device', id: 'a' }), null);
  // a section written as a one-line flow list
  assert.equal(yamlBlock('netatlas: 1\ndevices: [{id: a}, {id: b}]\n', { kind: 'device', id: 'a' }), null);
  // unknown id, other section, entry without an id
  assert.equal(yamlBlock(TRAPS, { kind: 'device', id: 'l1' }), null);
  assert.equal(yamlBlock(TRAPS, { kind: 'network', id: 'core' }), null);
  assert.equal(yamlBlock('netatlas: 1\ndevices:\n  - label: x\n', { kind: 'device', id: 'x' }), null);
});

test('list styles: "-" alone on its line, a list at the indentation of its key, CRLF line ends', () => {
  const dashAlone = 'netatlas: 1\ndevices:\n  -\n    id: a\n    label: A\n  - id: b\n';
  assert.deepEqual(marked(dashAlone, { kind: 'device', id: 'a' }), ['  -', '    id: a', '    label: A']);
  const flush = 'netatlas: 1\ndevices:\n- id: a\n  label: A\n- id: b\nlinks: []\n';
  assert.deepEqual(marked(flush, { kind: 'device', id: 'a' }), ['- id: a', '  label: A']);
  assert.deepEqual(marked(flush, { kind: 'device', id: 'b' }), ['- id: b']);
  const crlf = TRAPS.replace(/\n/g, '\r\n');
  assert.deepEqual(yamlBlock(crlf, { kind: 'device', id: 'core' }), { first: 9, last: 16 });
  // a quoted id is the same id
  assert.deepEqual(marked('netatlas: 1\ngroups:\n  - id: "g 1"\n    label: G\n', { kind: 'group', id: 'g 1' }), ['  - id: "g 1"', '    label: G']);
});

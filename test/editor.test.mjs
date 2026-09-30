// Editor core: YAML serialization round trips, ModelDoc editing operations,
// loopbacks, validation localisation and the generated editor examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, yaml, validate, state, scene, byClass } from './helpers.mjs';

const W = load('yaml/write.js');
const D = load('editor/document.js');
const IP = load('model/ip.js');
const { ModelDoc, KEY_ORDER } = D;

/** Data-only view of a tree (values, raw text of plain scalars, order). */
function data(n) {
  if (!n) return null;
  if (n.kind === 'scalar') {
    const v = typeof n.value === 'number' && isNaN(n.value) ? 'NaN' : n.value;
    // strings: the text is the value (quoting may differ between block and flow context)
    return n.quoted || n.value === null || typeof n.value === 'string' ? { v } : { v, raw: n.raw };
  }
  if (n.kind === 'seq') return n.items.map(data);
  const o = [];
  n.entries.forEach((e, k) => o.push([k, data(e.value)]));
  return { map: o };
}
/** Data plus comments. */
function full(n) {
  if (!n) return null;
  const t = { b: n.before || null, c: n.comment ? n.comment.trim() : null, e: n.endComments || null };
  if (n.kind === 'scalar') return { ...t, d: data(n) };
  if (n.kind === 'seq') return { ...t, s: n.items.map(full) };
  const o = [];
  n.entries.forEach((e, k) => o.push([k, full(e.value)]));
  return { ...t, m: o };
}

const exampleFiles = [];
for (const f of readdirSync(join(root, 'examples'))) if (/\.ya?ml$/.test(f)) exampleFiles.push(join('examples', f));
for (const f of readdirSync(join(root, 'examples', 'broken'))) exampleFiles.push(join('examples', 'broken', f));

// ------------------------------------------------------------ serializer

test('every example file is written back byte-for-byte (comments, order, style)', () => {
  for (const f of exampleFiles) {
    const text = readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(W.stringifyYaml(yaml.parseYaml(text)), text, f);
  }
});

const torture = `# header comment

# second header block
netatlas: 2   # version
title: "Quotes: \\"double\\" and 'single'"
single: 'it''s'
empty: ""
nothing:
tilde: ~
numbers: [1, -2, 3.5, 1e3, 0x1F, 0o17, .inf, -.inf, .nan]
bools: {a: true, b: False, c: "true"}
strings: ["yes", "no", "on", off, "123", "1.0", "null", "~", "- dash", "#hash", "a: b", "a #b", ": x", "@x", "\`x", "%x", "!x", "&x", "*x", "|x", ">x", "[x", "{x", "x]", "x,y", "tab\\there", " lead", "trail ", "caf\\u00e9", "line\\nbreak"]
"key with: colon": 1
"<<": merge-looking key
"#": hash key
unicode: "\\u00fcml\\u00e4ut \\u2603"
ctrl: "bell\\a esc\\e nul\\0 del\\x7F nel\\N ls\\L"
literal: |
  line 1
    indented
  # not a comment

  after blank
strip: |-
  no newline
keep: |+
  keep two

folded: >
  folded
  text

  para
list:
  # item comment
  - a
  - - nested
    - list
  -
  - {x: 1, y: [2, 3]}
  - key: value  # trailing
    other: "x"

  - last
nested:
  deep:
    deeper:
      deepest: [a, {b: c}]
# final comment
`;

test('serializer round-trips a torture document (data and comments) and is idempotent', () => {
  const a = yaml.parseYaml(torture);
  const out = W.stringifyYaml(a);
  const b = yaml.parseYaml(out);
  assert.deepEqual(data(b), data(a));
  assert.deepEqual(full(b), full(a));
  assert.equal(W.stringifyYaml(b), out);
  assert.match(out, /^# header comment\n\n# second header block\nnetatlas: 2   # version\n/);
  assert.match(out, /# final comment\n$/);
});

test('serializer fuzz: random trees survive stringify -> parse unchanged', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const alphabet = ['a', 'b', 'Z', '0', '9', ' ', ':', '#', '-', ',', '[', ']', '{', '}', '"', "'", '\\', '\n', '\t', '|', '>', '&', '*', '!', '%', '@', '`', '?', 'é', '☃', '/', '.', '~'];
  const randStr = () => {
    let s = '';
    const n = Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) s += pick(alphabet);
    return s;
  };
  const scalars = () => {
    const r = rnd();
    if (r < 0.5) return yaml.strNode(randStr());
    if (r < 0.65) return yaml.autoNode(pick(['1', '-7', '3.25', 'true', 'false', 'null', '~', '0x10', '1e5', 'yes', '10.0.0.1/24', 'r1:eth0', '2001:db8::1']));
    if (r < 0.8) return yaml.numNode(Math.round(rnd() * 1e6) / 100);
    if (r < 0.9) return yaml.boolNode(rnd() < 0.5);
    return yaml.nullNode();
  };
  const tree = (depth) => {
    const r = rnd();
    if (depth > 3 || r < 0.45) return scalars();
    if (r < 0.75) {
      const m = yaml.mapNode([], rnd() < 0.4);
      const n = Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const k = rnd() < 0.7 ? pick(['id', 'name', 'x', 'a b', 'k:v', '#k', '-k', '<<', '"q"', '123', 'true']) + i : randStr() + i;
        m.entries.set(k, { key: k, keyLine: 0, value: tree(depth + 1) });
      }
      return m;
    }
    const s = yaml.seqNode([], rnd() < 0.4);
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) s.items.push(tree(depth + 1));
    return s;
  };
  for (let i = 0; i < 400; i++) {
    const t = yaml.mapNode([['root', tree(0)]]);
    const out = W.stringifyYaml(t);
    let back;
    try {
      back = yaml.parseYaml(out);
    } catch (e) {
      assert.fail(`iteration ${i}: output does not parse: ${e.message}\n${out}`);
    }
    assert.deepEqual(data(back), data(t), `iteration ${i}\n${out}`);
    assert.equal(W.stringifyYaml(back), out, `not idempotent at ${i}`);
  }
});

// ------------------------------------------------------------ ModelDoc

test('a new model is valid and empty: nothing is created for the user', () => {
  const d = ModelDoc.create();
  assert.ok(d.valid, JSON.stringify(d.errors));
  assert.equal(d.origin, 'new');
  assert.equal(d.dirty, false);
  assert.equal(d.exportText(), 'netatlas: 2\ntitle: New network\n');
  for (const k of ['device', 'link', 'network', 'relation', 'group', 'protocol']) assert.equal(d.entities(k).length, 0, k);
});

test('import -> edit -> export -> reload keeps every edit and every untouched attribute', () => {
  const src = readFileSync(join(root, 'examples', 'enterprise-wan.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const d = ModelDoc.fromText(src, 'enterprise-wan.yaml', 'file').doc;
  assert.ok(d.valid);
  const i = d.findEntity('device', 'hq-fw').index;
  d.change('edit', () => {
    d.setAt(['devices', i, 'vendor'], yaml.strNode('Palo Alto Networks'), KEY_ORDER.device);
    d.setAt(['devices', i, 'attrs'], yaml.mapNode([['ha', yaml.mapNode([['mode', yaml.strNode('active/passive')], ['peers', yaml.seqNode([yaml.strNode('fw-b')], true)]])]]), KEY_ORDER.device);
  });
  assert.ok(d.dirty);
  const out = d.exportText();
  const back = ModelDoc.fromText(out, 'x.yaml', 'file').doc;
  assert.ok(back.valid);
  assert.equal(back.exportText(), out);
  const fw = back.result.model.index.devices.get('hq-fw');
  assert.equal(fw.vendor, 'Palo Alto Networks');
  assert.deepEqual(fw.attrs, [['ha.mode', 'active/passive'], ['ha.peers', 'fw-b']]);
  // untouched content is identical: reverting the two edits gives back the original text
  const reverted = out
    .replace('vendor: Palo Alto Networks', 'vendor: Palo Alto')
    .replace('    attrs:\n      ha:\n        mode: active/passive\n        peers: [fw-b]\n', '');
  assert.equal(reverted, src);
  assert.match(out, /cipher: GCM-AES-XPN-256/);
});

test('attributes the diagrams never render survive load -> edit -> export -> reload', () => {
  const src = `netatlas: 2
title: t
x-owner: team-net          # unknown top-level key (reported, kept)
devices:
  - id: r1
    serial: ABC123          # unknown device key (reported, kept)
    attrs:
      rack-unit: 12
      power: {psu: 2, watts: [450, 450]}
      notes: |
        multi-line
        text
      empty-list: []
      empty-map: {}
      when: 2027-01-31
      yes-string: yes
    interfaces:
      - {id: lo0, type: loopback, ip: [10.0.0.1/32], attrs: {ospf-passive: true}}
      - id: eth0
        extra: {x: [1, {y: z}]}
`;
  const d = ModelDoc.fromText(src, 'a.yaml', 'file').doc;
  assert.equal(d.errors.length, 3, d.errors.map((e) => e.message).join('\n'));
  d.change('edit', () => d.setAt(['devices', 0, 'label'], yaml.strNode('Router 1'), KEY_ORDER.device));
  const out = d.exportText();
  const back = ModelDoc.fromText(out, 'b.yaml', 'file').doc;
  // a label changes the box size, so the displayed positions are saved with the edit (layout section)
  assert.match(out, /\nlayout:\n  physical:\n    r1: \[-?\d+, -?\d+\]\n  logical:\n    r1: \[/);
  const strip = (t) => t.replace(/\n    label: Router 1/, '').replace(/\n\nlayout:\n[\s\S]*$/, '\n');
  assert.equal(strip(out), src);
  assert.deepEqual(data(back.root), data(d.root));
  assert.equal(back.errors.length, 3);
});

test('renaming ids updates every reference (device, interface, group, link, relation, network, protocol)', () => {
  const src = readFileSync(join(root, 'examples', 'enterprise-wan.yaml'), 'utf8');
  const d = ModelDoc.fromText(src, 'w.yaml', 'file').doc;
  const before = d.references('device', 'hq-rtr2').length;
  assert.equal(d.renameEntity('device', d.findEntity('device', 'hq-rtr2').index, 'edge-b'), before);
  const dev = d.findEntity('device', 'edge-b').index;
  assert.equal(d.renameInterface(dev, d.interfaceIds(dev).indexOf('lo0'), 'loopback0'), 1);
  assert.equal(d.renameEntity('group', d.findEntity('group', 'hq').index, 'berlin'), 2);
  assert.equal(d.renameEntity('link', d.findEntity('link', 'l-hq-isp1').index, 'uplink-1'), 3);
  assert.equal(d.renameEntity('relation', d.findEntity('relation', 'ipsec-muc').index, 'ipsec-munich'), 1);
  assert.equal(d.renameEntity('network', d.findEntity('network', 'net-users').index, 'vlan10'), 1);
  assert.equal(d.renameEntity('protocol', d.findEntity('protocol', 'macsec').index, 'macsec2'), 1);
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  const m = d.result.model;
  assert.ok(m.index.relations.get('ibgp-hq').endpoints.some((e) => e.device === 'edge-b' && e.iface === 'loopback0'));
  assert.equal(m.index.groups.get('hq-edge').parent, 'berlin');
  assert.deepEqual(m.index.relations.get('gre-muc').over, ['ipsec-munich']);
});

test('router_id follows an interface rename', () => {
  const d = ModelDoc.fromText('netatlas: 2\ndevices:\n  - id: r1\n    router_id: lo0\n    interfaces:\n      - {id: lo0, type: loopback, ip: [10.255.0.1/32]}\n', 'r.yaml', 'file').doc;
  assert.equal(d.renameInterface(0, 0, 'Loopback0'), 1);
  assert.ok(d.valid);
  assert.equal(d.result.model.devices[0].routerId, 'Loopback0');
});

test('deleting an entity reports (never silently removes) broken references; undo restores', () => {
  const d = ModelDoc.fromText(readFileSync(join(root, 'examples', 'minimal.yaml'), 'utf8'), 'm.yaml', 'file').doc;
  d.deleteEntity('device', 1);
  assert.ok(!d.valid);
  assert.ok(d.errors.some((e) => /unknown device "r2"/.test(e.message)));
  assert.match(d.exportText(), /r2:eth0/);
  // localisation: the error points at the link endpoint node
  const e = d.errors.find((x) => x.path === 'links.cable-1.b');
  assert.deepEqual(d.issuePath(e), ['links', 0, 'b']);
  assert.deepEqual(d.issueEntity(e), { kind: 'link', index: 0 });
  assert.ok(d.undo());
  assert.ok(d.valid);
  assert.ok(d.redo());
  assert.ok(!d.valid);
});

test('shorthand forms are expanded only when edited, keeping their data', () => {
  const d = ModelDoc.fromText(
    'netatlas: 2\ndevices:\n  - id: r1\n    interfaces: [eth0, eth1]\n  - id: r2\n    interfaces: [eth0]\nlinks:\n  - {id: l1, a: "r1:eth1", b: r2:eth0}\nrelations:\n  - {id: x, protocol: ospf, endpoints: ["r1:eth0", r2]}\n',
    's.yaml',
    'file',
  ).doc;
  d.change('edit', () => {
    d.ensureMap(['devices', 0, 'interfaces', 1]);
    d.setAt(['devices', 0, 'interfaces', 1, 'vrf'], yaml.strNode('blue'), KEY_ORDER.interface);
    d.ensureMap(['relations', 0, 'endpoints', 0]);
    d.setAt(['relations', 0, 'endpoints', 0, 'role'], yaml.strNode('gateway'), KEY_ORDER.endpoint);
  });
  // a link end becomes a mapping only when it gets VLANs; the other end is left as written
  assert.ok(d.addEndVlans(['links', 0, 'a'], [20, 10]));
  const out = d.exportText();
  assert.match(out, /interfaces: \[eth0, \{id: eth1, vrf: blue\}\]/);
  assert.match(out, /endpoints: \[\{device: r1, interface: eth0, role: gateway\}, r2\]/);
  assert.match(out, /a: \{device: r1, interface: eth1, vlans: \[10, 20\]\}, b: r2:eth0\}/);
  assert.ok(d.valid);
});

test('adding entities creates sections in canonical order with unique ids', () => {
  const d = ModelDoc.fromText('netatlas: 2\ntitle: x\n', 'e.yaml', 'new').doc;
  d.addEntity('relation');
  d.addEntity('device');
  d.addEntity('device');
  d.addEntity('group');
  assert.deepEqual(Array.from(d.root.entries.keys()), ['netatlas', 'title', 'groups', 'devices', 'relations', 'layout']);
  assert.deepEqual(d.entities('device').map((e) => e.id), ['device1', 'device2']);
  assert.equal(d.duplicateEntity('device', 0), 1);
  assert.deepEqual(d.entities('device').map((e) => e.id), ['device1', 'device3', 'device2']);
});

test('undo history is bounded and dirty tracking follows save', () => {
  const d = ModelDoc.create();
  for (let i = 0; i < 150; i++) d.change('t', () => d.setAt(['title'], yaml.strNode('t' + i), KEY_ORDER.top));
  let n = 0;
  while (d.undo()) n++;
  assert.equal(n, 100);
  d.markSaved();
  assert.equal(d.dirty, false);
  d.redo();
  assert.equal(d.dirty, true);
});

// ------------------------------------------------------------ loopbacks

const loopDoc = (ip, extra = '') => `netatlas: 2
devices:
  - id: r1
${extra}    interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: ${ip}}
      - {id: eth0}
`;

test('loopbacks: valid IPv4/IPv6 lists, single value and multiple loopbacks', () => {
  for (const ip of ['[10.0.0.1/32]', '[2001:db8::1/128]', '[10.0.0.1/32, 2001:db8::1/128, 192.0.2.7/24]', '10.0.0.1/32', '[::1/128]', '["2001:db8:0:0:0:0:0:2/128"]', '[::ffff:10.1.2.3/128]']) {
    const r = validate.loadModel(loopDoc(ip));
    assert.deepEqual(r.errors, [], ip);
  }
  const r = validate.loadModel(loopDoc('[10.0.0.1/32]').replace('      - {id: eth0}', '      - {id: lo1, type: loopback, ip: [fd00::1/128]}\n      - {id: lo2, type: loopback, ip: [10.9.9.9/32]}'));
  assert.deepEqual(r.errors, []);
  const d = r.model.devices[0];
  assert.equal(d.interfaces.filter((i) => i.type === 'loopback').length, 3);
});

test('loopbacks: invalid addresses are errors with an explanation at the address', () => {
  const cases = [
    ['[10.0.0.1]', /needs a prefix length, e\.g\. 10\.0\.0\.1\/32/],
    ['[10.0.0.256/32]', /not a valid IPv4 or IPv6 address/],
    ['[10.0.0.1/33]', /invalid for IPv4 \(0–32\)/],
    ['[2001:db8::1/129]', /invalid for IPv6 \(0–128\)/],
    ['[2001:db8:::1/128]', /not a valid/],
    ['[1:2:3:4:5:6:7:8:9/128]', /not a valid/],
    ['[010.0.0.1/32]', /not a valid/],
    ['[hello]', /not a valid/],
    ['[]', /needs at least one IPv4 or IPv6 address/],
    ['', /needs at least one/],
    ['[10.0.0.1/32, 10.0.0.1/32]', /listed twice/],
  ];
  for (const [ip, re] of cases) {
    const r = validate.loadModel(loopDoc(ip));
    assert.ok(r.errors.some((e) => re.test(e.message)), `${ip}: ${r.errors.map((e) => e.message).join('; ')}`);
  }
  const d = ModelDoc.fromText(loopDoc('[10.0.0.1/32, bad]'), 'x', 'file').doc;
  assert.deepEqual(d.issuePath(d.errors[0]), ['devices', 0, 'interfaces', 0, 'ip', 1]);
});

test('loopbacks: router_id must reference a loopback of the same device', () => {
  assert.deepEqual(validate.loadModel(loopDoc('[10.0.0.1/32]', '    router_id: lo0\n')).errors, []);
  assert.match(validate.loadModel(loopDoc('[10.0.0.1/32]', '    router_id: lo9\n')).errors[0].message, /no loopback "lo9" — did you mean "lo0"/);
  assert.match(validate.loadModel(loopDoc('[10.0.0.1/32]', '    router_id: eth0\n')).errors[0].message, /must name a loopback interface/);
  const v6 = validate.loadModel(loopDoc('[2001:db8::1/128]', '    router_id: lo0\n'));
  assert.equal(v6.errors.length, 0);
  assert.match(v6.warnings[0].message, /no IPv4 address; router IDs are 32-bit/);
});

test('loopbacks: never cabled, usable as relation endpoints; duplicates across devices warn', () => {
  const base = `netatlas: 2
devices:
  - id: a
    interfaces: [{id: lo0, type: loopback, ip: [10.0.0.1/32]}, {id: e0}]
  - id: b
    interfaces: [{id: lo0, type: loopback, ip: [10.0.0.1/32]}, {id: e0}]
`;
  const cabled = validate.loadModel(base + 'links:\n  - {id: l1, a: "a:lo0", b: "b:e0"}\n');
  assert.match(cabled.errors[0].message, /type "loopback", which is logical/);
  const rel = validate.loadModel(base + 'relations:\n  - {id: r, protocol: ibgp, endpoints: ["a:lo0", "b:lo0"]}\n');
  assert.equal(rel.errors.length, 0);
  assert.ok(rel.warnings.some((w) => /also assigned to a:lo0/.test(w.message)));
});

test('loopbacks: backward compatible with existing files (type: loopback, scalar ip)', () => {
  const m = validate.loadModel(readFileSync(join(root, 'examples', 'enterprise-wan.yaml'), 'utf8'));
  assert.deepEqual(m.errors, []);
  assert.equal(m.model.index.interfaces.get('hq-rtr1:lo0').type, 'loopback');
});

test('loopbacks: shown as chips in the logical view and in device details, never as ports', () => {
  const d = ModelDoc.fromText(readFileSync(join(root, 'examples', 'editor-new-network.yaml'), 'utf8'), 'n', 'file').doc;
  const s = new state.Session(d.result.model);
  const phys = s.render().root;
  assert.equal(byClass(phys, 'loop-chip').length, 0);
  assert.equal(scene.findAll(phys, (n) => n.attrs['data-ref'] === 'iface:edge-b:lo0').length, 0);
  s.setView('logical');
  const log = s.render().root;
  const chips = byClass(log, 'loop-chip');
  assert.equal(chips.length, 4);
  assert.equal(byClass(log, 'rid').length, 2);
  assert.match(scene.textOf(log), /lo0  10\.255\.0\.2\/32 \+1/);
  const det = scene.textOf(load('ui/panels.js').detailsFor(d.result.model, 'device:edge-b'));
  assert.match(det, /Loopbacks \(2\)/);
  assert.match(det, /10\.255\.0\.2\/32\n2001:db8:ffff::2\/128/);
  assert.match(det, /Interfaces \(1, 1 cabled\)/);
});

// ------------------------------------------------------------ IP helpers

test('ip helpers: parsing and containment', () => {
  assert.deepEqual(IP.parseIPv4('192.0.2.255'), [192, 0, 2, 255]);
  assert.equal(IP.parseIPv4('1.2.3'), null);
  assert.equal(IP.parseIPv6('::').length, 16);
  assert.equal(IP.parseIPv6('fe80::1%eth0'), null);
  assert.deepEqual(IP.parseIPv6('::ffff:1.2.3.4').slice(12), [1, 2, 3, 4]);
  const net = IP.parsePrefix('10.1.0.0/16');
  assert.ok(IP.prefixContains(net, IP.parseAddress('10.1.200.3')));
  assert.ok(!IP.prefixContains(net, IP.parseAddress('10.2.0.1')));
  assert.ok(IP.prefixContains(IP.parsePrefix('2001:db8::/32'), IP.parseAddress('2001:db8:ffff::1')));
  assert.ok(!IP.prefixContains(IP.parsePrefix('2001:db8::/32'), IP.parseAddress('10.0.0.1')));
  assert.ok(IP.prefixContains(IP.parsePrefix('0.0.0.0/0'), IP.parseAddress('8.8.8.8')));
});

test('an address outside a network is simply not a member (nothing to configure, nothing to warn about)', () => {
  const r = validate.loadModel(`netatlas: 2
devices:
  - id: a
    interfaces: [{id: e0, ip: 10.9.0.1/24}]
networks:
  - {id: n, cidr: [10.1.0.0/24, 2001:db8::/64]}
`);
  assert.deepEqual(r.errors.concat(r.warnings), []);
  assert.deepEqual(load('model/derive.js').networkMembers(r.model, 'n'), []);
});

test('drafts with errors still produce a drawable partial model', () => {
  const r = validate.loadModel('netatlas: 2\ndevices:\n  - id: a\n  - id: "bad id"\n  - {id: b, group: nowhere}\nlinks:\n  - {id: l, a: a, b: zz}\n');
  assert.equal(r.errors.length, 3);
  assert.deepEqual(r.model.devices.map((d) => d.id), ['a', 'b']);
  const s = new state.Session(r.model);
  assert.equal(byClass(s.render().root, 'device').length, 2);
});

// ------------------------------------------------------------ examples

test('the editor examples are reproducible from the editing core', async () => {
  const mod = await import('../scripts/make-editor-examples.mjs');
  for (const name of ['editor-new-network.yaml', 'minimal-edited.yaml']) {
    const onDisk = readFileSync(join(root, 'examples', name), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(mod.render(name), onDisk, name);
    const r = validate.loadModel(onDisk);
    assert.deepEqual(r.errors, [], name);
  }
  const edited = readFileSync(join(root, 'examples', 'minimal-edited.yaml'), 'utf8');
  assert.match(edited, /# Two routers, one cable, one GRE tunnel with an OSPF adjacency inside it\./);
  assert.match(edited, /a: edge-1:eth0/);
  assert.match(edited, /ip: \[10\.255\.0\.1\/32, 2001:db8:ffff::1\/128\]/);
});

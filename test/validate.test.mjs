import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, yaml, example, exampleNames, model, errorsOf } from './helpers.mjs';

const base = `netatlas: 1
devices:
  - id: r1
    type: router
    interfaces:
      - {id: eth0, speed: 1G}
      - {id: eth1}
      - {id: tun0, type: tunnel}
  - id: r2
    interfaces: [eth0, eth1]
`;

const expectError = (text, re, line) => {
  const errs = errorsOf(text);
  const hit = errs.find((e) => re.test(e.message));
  assert.ok(hit, `expected error ${re} but got:\n${errs.map((e) => `  line ${e.line}: ${e.message}`).join('\n') || '  (none)'}`);
  if (line !== undefined) assert.equal(hit.line, line, hit.message);
  return hit;
};

test('all examples validate without errors or warnings', () => {
  for (const f of exampleNames) {
    const r = validate.loadModel(example(f));
    assert.deepEqual(r.errors, [], f);
    assert.deepEqual(r.warnings, [], f);
    assert.ok(r.model.devices.length > 0);
  }
});

test('the WAN example has physical links and several logical layers over the same infrastructure', () => {
  const m = model(example('enterprise-wan.yaml'));
  const carriedOverUplink = m.relations.filter((r) => r.over.includes('l-hq-isp1')).map((r) => r.protocol);
  assert.ok(carriedOverUplink.includes('ipsec') && carriedOverUplink.includes('ebgp') && carriedOverUplink.includes('bfd'));
  const gre = m.index.relations.get('gre-muc');
  assert.equal(gre.category, 'tunnel');
  assert.deepEqual(gre.over, ['ipsec-muc']);
  assert.equal(m.index.relations.get('ospf-muc').over[0], 'gre-muc');
  const cats = new Set(m.relations.map((r) => r.category));
  for (const c of ['tunnel', 'adjacency', 'redundancy', 'service', 'other']) assert.ok(cats.has(c), c);
});

test('missing version and unsupported version', () => {
  expectError('devices: []\n', /netatlas: 1/);
  expectError('netatlas: 2\n', /unsupported format version/, 1);
  expectError('', /empty/);
  expectError('- a\n- b\n', /expected a mapping/);
});

test('unknown keys are rejected with a suggestion', () => {
  const e = expectError(base.replace('type: router', 'typ: router'), /unknown key "typ" — did you mean "type"\?/, 4);
  assert.match(e.message, /attrs/);
  expectError('netatlas: 1\ndevice: []\n', /did you mean "devices"/, 2);
});

test('invalid ids, duplicate ids across sections', () => {
  expectError('netatlas: 1\ndevices:\n  - id: "bad id"\n', /invalid id "bad id"/);
  expectError('netatlas: 1\ndevices:\n  - id: "r1:x"\n', /":" is reserved/);
  expectError(base + 'networks:\n  - {id: r1}\n', /duplicate id "r1" \(already used by a device on line 3/);
  expectError(base.replace('interfaces: [eth0, eth1]', 'interfaces: [eth0, eth0]'), /duplicate interface "eth0" on device "r2"/);
});

test('unknown device / interface references are reported with suggestions', () => {
  expectError(base + 'links:\n  - {id: l1, a: "r1:eth9", b: "r2:eth0"}\n', /device "r1" has no interface "eth9" — did you mean "eth0"\?/, 12);
  expectError(base + 'links:\n  - {id: l1, a: "r3:eth0", b: "r2:eth0"}\n', /unknown device "r3" — did you mean "r1"\?/);
  expectError(base + 'relations:\n  - {id: x, protocol: bgp, endpoints: [r1, rX]}\n', /unknown device "rX"/);
  expectError(base + 'links:\n  - {id: l1, a: "r1:eth0"}\n', /missing required key "b"/);
});

test('physical rules: one cable per port, logical interfaces cannot be cabled', () => {
  expectError(base + 'links:\n  - {id: l1, a: "r1:eth0", b: "r2:eth0"}\n  - {id: l2, a: "r1:eth0", b: "r2:eth1"}\n', /already cabled by link "l1"/, 13);
  expectError(base + 'links:\n  - {id: l1, a: "r1:tun0", b: "r2:eth0"}\n', /type "tunnel", which is logical/);
  expectError(base + 'links:\n  - {id: l1, a: "r1:eth0", b: "r1:eth0"}\n', /already cabled|to itself/);
});

test('speed mismatch is a warning, not an error', () => {
  const r = validate.loadModel(base.replace('interfaces: [eth0, eth1]', 'interfaces: [{id: eth0, speed: 10G}]') + 'links:\n  - {id: l1, a: "r1:eth0", b: "r2:eth0"}\n');
  assert.equal(r.errors.length, 0);
  assert.match(r.warnings[0].message, /speed mismatch/);
  assert.equal(r.model.links[0].speed, '1G');
});

test('relations: endpoints, over references and cycles', () => {
  expectError(base + 'relations:\n  - {id: x, protocol: gre, endpoints: [r1]}\n', /at least 2 endpoints/);
  expectError(base + 'relations:\n  - {id: x, protocol: gre, endpoints: [r1, r2], over: nope}\n', /unknown link, relation or network "nope"/);
  expectError(base + 'relations:\n  - {id: x, protocol: gre, endpoints: [r1, r2], over: r1}\n', /"r1" is a device/);
  expectError(base + 'relations:\n  - {id: x, protocol: gre, endpoints: [r1, r2], over: x}\n', /over itself/);
  expectError(
    base + 'relations:\n  - {id: a, protocol: gre, endpoints: [r1, r2], over: b}\n  - {id: b, protocol: ipsec, endpoints: [r1, r2], over: a}\n',
    /forms a cycle/,
  );
  expectError(base + 'relations:\n  - {id: x, protocol: gre, category: tunel, endpoints: [r1, r2]}\n', /unknown category "tunel" — did you mean "tunnel"/);
});

test('open protocol model: unknown protocols are accepted with a helpful warning', () => {
  const r = validate.loadModel(base + 'relations:\n  - {id: x, protocol: HIP, endpoints: [r1, r2]}\n  - {id: y, protocol: lisp, category: overlay, endpoints: [r1, r2]}\n');
  assert.equal(r.errors.length, 0);
  assert.equal(r.model.relations[0].protocol, 'hip');
  assert.equal(r.model.relations[0].category, 'other');
  assert.equal(r.model.relations[1].category, 'overlay');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /not built in.*"protocols:"/);
});

test('protocols section defines and overrides protocols; colors are validated', () => {
  const m = model(base + 'protocols:\n  - {id: geneve, category: tunnel, color: "#123456", label: Geneve!}\n  - {id: mytun, category: tunnel}\nrelations:\n  - {id: x, protocol: GENEVE, endpoints: [r1, r2]}\n');
  const def = m.protocols.get('geneve');
  assert.equal(def.category, 'tunnel');
  assert.equal(def.style, 'tube');
  assert.equal(def.color, '#123456');
  assert.equal(m.relations[0].category, 'tunnel');
  expectError(base + 'protocols:\n  - {id: x, color: "red; background:url(http://x)"}\n', /invalid color/);
  expectError(base + 'protocols:\n  - {id: x, style: wavy}\n', /unknown style "wavy"/);
});

test('aliases of built-in protocols (ebgp -> bgp family) keep the family style', () => {
  const m = model(base + 'relations:\n  - {id: x, protocol: eBGP, endpoints: [r1, r2]}\n');
  assert.equal(m.relations[0].protocol, 'ebgp');
  assert.equal(m.relations[0].category, 'adjacency');
});

test('groups: unknown parent, cycles, nesting depth', () => {
  expectError('netatlas: 1\ngroups:\n  - {id: a, parent: zz}\n', /unknown parent group "zz"/);
  expectError('netatlas: 1\ngroups:\n  - {id: a, parent: b}\n  - {id: b, parent: a}\n', /cycle/);
  let g = 'netatlas: 1\ngroups:\n  - {id: g0}\n';
  for (let i = 1; i < 12; i++) g += `  - {id: g${i}, parent: g${i - 1}}\n`;
  expectError(g, /nested deeper than 8/);
  expectError(base.replace('type: router', 'type: router\n    group: nowhere'), /unknown group "nowhere"/);
});

test('entity-count limits', () => {
  let t = 'netatlas: 1\ndevices:\n';
  for (let i = 0; i < 12; i++) t += `  - {id: d${i}}\n`;
  const r = validate.validate(yaml.parseYaml(t), { maxDevices: 10 });
  assert.match(r.errors[0].message, /too many devices: 12 \(limit 10\)/);
});

test('attributes: nested maps are flattened, lists joined; free-form keys allowed', () => {
  const m = model(base + 'relations:\n  - id: x\n    protocol: ipsec\n    endpoints: [r1, r2]\n    attrs:\n      ike: {version: 2, dh: [14, 19]}\n      psk-ref: vault/x\n');
  assert.deepEqual(m.relations[0].attrs, [['ike.version', '2'], ['ike.dh', '14, 19'], ['psk-ref', 'vault/x']]);
});

test('error flood is capped', () => {
  let t = 'netatlas: 1\nlinks:\n';
  for (let i = 0; i < 500; i++) t += `  - {id: l${i}, a: x, b: y}\n`;
  const errs = errorsOf(t);
  assert.ok(errs.length <= 202, String(errs.length));
  assert.match(errs[errs.length - 1].message, /stopped after/);
});


test('the broken demo file reports every problem with line numbers', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { root } = await import('./helpers.mjs');
  const errs = errorsOf(readFileSync(join(root, 'examples', 'broken', 'errors-demo.yaml'), 'utf8'));
  const summary = errs.map((e) => `${e.line}: ${e.message}`);
  const expected = [
    [9, /unknown key "typ" — did you mean "type"/],
    [17, /device "r1" has no interface "eth1" — did you mean "eth0"/],
    [18, /type "tunnel", which is logical/],
    [23, /unknown category "tunel" — did you mean "tunnel"/],
    [25, /unknown link, relation or network "l3" — did you mean "l1"/],
  ];
  for (const [line, re] of expected) assert.ok(errs.some((e) => e.line === line && re.test(e.message)), `${line} ${re}\n${summary.join('\n')}`);
  assert.equal(errs.length, expected.length, summary.join('\n'));
});

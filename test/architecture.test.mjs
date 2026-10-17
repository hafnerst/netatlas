// Enforces the layer structure documented in docs/ARCHITECTURE.md:
// every import in src/ must point to the same layer or to a layer that the
// importing layer may depend on. Type-only imports count too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { root } from './helpers.mjs';

/** layer -> layers it may import (besides itself) */
export const ALLOWED = {
  model: [],
  yaml: [],
  analysis: ['model'],
  validation: ['model', 'yaml', 'analysis'],
  layout: ['model'],
  diagram: ['model', 'layout', 'analysis'],
  editor: ['model', 'yaml', 'validation', 'layout', 'analysis'],
  ui: ['model', 'validation', 'layout', 'diagram', 'editor', 'analysis', 'generated'],
  app: ['model', 'yaml', 'validation', 'layout', 'diagram', 'editor', 'ui', 'analysis', 'generated'],
  generated: [],
};

function modules() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(root, 'src', dir), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) out.push(rel.replace(/\.ts$/, ''));
    }
  };
  walk('');
  return out;
}

function importsOf(id) {
  const src = readFileSync(join(root, 'src', id + '.ts'), 'utf8');
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map((m) => m[1]);
  return specs.map((s) => {
    assert.ok(s.startsWith('.'), `${id}: non-relative import "${s}" (no third-party modules)`);
    return posix.normalize(posix.join(posix.dirname(id), s));
  });
}

test('every module lives in a known layer (no loose files in src/)', () => {
  for (const id of modules()) {
    const layer = id.split('/')[0];
    assert.ok(id.includes('/') && ALLOWED[layer], `${id} is not inside a known layer folder`);
  }
});

test('imports only point to allowed layers', () => {
  const violations = [];
  for (const id of modules()) {
    const layer = id.split('/')[0];
    for (const target of importsOf(id)) {
      const tl = target.split('/')[0];
      if (tl !== layer && !ALLOWED[layer].includes(tl)) violations.push(`${id} -> ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('rendering and UI code never see YAML syntax', () => {
  for (const id of modules().filter((m) => /^(diagram|ui|layout)\//.test(m))) {
    for (const t of importsOf(id)) assert.ok(!t.startsWith('yaml/'), `${id} imports ${t}`);
  }
});

// Behavior follows from capabilities (src/model/capabilities.ts), not from type names: outside the
// registries (device types, services), the resolver, the icon lookup (presentation) and the self-test (which names example
// devices), no module compares a device's type with a type id. See FORMAT.md, "Capabilities".
const TYPE_IDS = ['router', 'switch', 'firewall', 'ap', 'load_balancer', 'ids_ips', 'vpn_gateway', 'security_gateway', 'server', 'vm', 'container', 'storage', 'endpoint', 'cloud', 'system'];
const TYPE_CHECK_EXEMPT = ['model/device-types', 'model/capabilities', 'model/service-registry', 'diagram/icons', 'app/selftest', 'app/viewport-check'];

test('no semantic type checks outside the registry and the capability resolver', () => {
  const alt = TYPE_IDS.join('|');
  const patterns = [
    new RegExp(`\\btype\\s*[!=]==\\s*'(${alt})'`),
    new RegExp(`'(${alt})'\\s*[!=]==\\s*[a-zA-Z_.]*type\\b`),
    new RegExp(`\\[\\s*'(${alt})'(\\s*,\\s*'(${alt})')+\\s*\\]\\.(indexOf|includes|some)`),
    new RegExp(`\\b(dtype|htype|t)\\s*[!=]==\\s*'(${alt})'`),
    // a list of types looked up by a device's type
    /_TYPES(?: as [^)]*\))?\.(indexOf|includes)\((?:d|dev|device|type|dtype)(?:\.type)?\)/,
    // a type read from the document and compared
    new RegExp(`'type'\\]\\)\\s*[!=]==\\s*'(${alt})'`),
  ];
  const violations = [];
  for (const id of modules()) {
    if (TYPE_CHECK_EXEMPT.includes(id) || id.startsWith('generated/')) continue;
    readFileSync(join(root, 'src', id + '.ts'), 'utf8').split('\n').forEach((line, i) => {
      if (patterns.some((p) => p.test(line))) violations.push(`${id}.ts:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(violations, [], 'decide by capabilities(d) instead:\n' + violations.join('\n'));
});

test('the guard sees type checks (it is not vacuous)', () => {
  const p = new RegExp(`\\btype\\s*[!=]==\\s*'(${TYPE_IDS.join('|')})'`);
  assert.ok(p.test("if (d.type === 'switch') x();"));
  assert.ok(!p.test("if (capabilities(d).switchFeatures) x();"));
});

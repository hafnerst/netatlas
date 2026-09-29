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
  validation: ['model', 'yaml'],
  layout: ['model'],
  diagram: ['model', 'layout'],
  editor: ['model', 'yaml', 'validation', 'layout'],
  ui: ['model', 'validation', 'layout', 'diagram', 'editor', 'generated'],
  app: ['model', 'yaml', 'validation', 'layout', 'diagram', 'editor', 'ui', 'generated'],
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

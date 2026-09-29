// Static audit of the deliverable: one self-contained HTML file, compiled
// JavaScript only, no external references, no network APIs, strict CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const html = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const js = scripts.map((m) => m[2]).join('\n');
// The document markup without the script body (the script legitimately contains test strings).
const markup = html.replace(/<script([^>]*)>[\s\S]*?<\/script>/g, '<script$1></script>');

test('exactly one inline script, no external script/style/link/img/iframe sources', () => {
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1].trim(), '', 'no src/type attributes on the script');
  assert.doesNotMatch(markup, /<script[^>]+src=/i);
  assert.doesNotMatch(markup, /<link\b/i);
  assert.doesNotMatch(markup, /<(img|iframe|object|embed|audio|video|source)\b[^>]*\ssrc=/i);
  assert.doesNotMatch(markup, /@import|url\(\s*['"]?(?!data:)[a-z]+:/i);
});

test('no remote URLs anywhere except XML namespace identifiers', () => {
  const urls = [...html.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s"'`)<>]+/gi)].map((m) => m[0]);
  const allowed = /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|XML\/1998\/namespace|2000\/xmlns\/?|1999\/xlink)$/;
  const bad = urls.filter((u) => !allowed.test(u));
  assert.deepEqual(bad, []);
});

test('no network-capable APIs are used by the application code', () => {
  for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'new Worker', 'RTCPeerConnection', 'import(', 'eval(', 'new Function', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!js.includes(api), `bundle must not contain ${api}`);
  }
});

test('strict Content-Security-Policy forbids all network access', () => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(m, 'CSP meta tag present');
  const csp = m[1];
  for (const d of ["default-src 'none'", "connect-src 'none'", "font-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(d), d);
  }
  assert.doesNotMatch(csp, /https?:|\*/);
  // CSP must come before any script
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
});

test('the artifact contains compiled JavaScript, not TypeScript', () => {
  assert.doesNotMatch(html, /type=["']text\/typescript["']/);
  assert.doesNotMatch(js, /\binterface\s+[A-Z]\w*\s*\{/);
  assert.doesNotMatch(js, /\):\s*(?:void|string|number|boolean)\s*\{/);
  assert.doesNotMatch(js, /\bimport\s+[{*\w]/);
  // bundle parses as plain JavaScript
  assert.doesNotThrow(() => new Function(js));
});

test('no third-party runtime code: every bundled module comes from src/', () => {
  const ids = [...js.matchAll(/__defs\["([^"]+)"\]/g)].map((m) => m[1]).sort();
  const srcModules = new Set();
  const walk = (dir, prefix) => {
    for (const e of readdirSync(join(root, 'src', dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), prefix + e.name + '/');
      else if (e.name.endsWith('.ts')) srcModules.add(prefix + e.name.replace(/\.ts$/, ''));
    }
  };
  walk('', '');
  for (const id of ids) assert.ok(srcModules.has(id), `unexpected module ${id}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.deepEqual(Object.keys(pkg.devDependencies), ['typescript']);
});

test('reasonable size, and the examples are embedded', () => {
  assert.ok(html.length < 1024 * 1024, `${html.length} bytes`);
  assert.match(js, /enterprise-wan\.yaml/);
  assert.match(js, /datacenter-evpn\.yaml/);
});

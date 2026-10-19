// The verification scripts themselves: how scripts/run-tests.mjs splits the
// test files into suites (every file in exactly one, none left out), how it
// reads a file's results, and what scripts/release-check.mjs accepts as a
// release: the package check, version and tag, the CHANGELOG section,
// checksums and provenance. DOM-free; the release check of the real
// dist/netatlas.html is in public-artifact.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './helpers.mjs';
import { classify, parseSummary, SUITES, PUBLIC, VIEWPORT } from '../scripts/run-tests.mjs';
import { inspectRelease, internalNames, checkVersion, changelogSection, checksums, provenance, TEST_ONLY, SIZE_BUDGET } from '../scripts/release-check.mjs';
import { GENERATED } from '../scripts/check-repro.mjs';

const dist = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('suites: every test file is in exactly one suite; the browser files are never in unit', () => {
  const all = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort();
  const c = classify();
  assert.deepEqual(c.map((x) => x.file).sort(), all, 'nothing left out');
  assert.equal(new Set(c.map((x) => x.file)).size, c.length, 'nothing twice');
  for (const x of c) {
    assert.ok(SUITES.includes(x.suite), x.file);
    const src = readFileSync(join(root, 'test', x.file), 'utf8');
    const browser = /\.\.\/scripts\/(cdp|browser-selftest)\.mjs/.test(src);
    assert.equal(x.suite === 'unit', !browser, `${x.file}: ${x.suite}`);
  }
  assert.deepEqual(c.filter((x) => x.suite === 'public').map((x) => x.file).sort(), PUBLIC.slice().sort());
  assert.deepEqual(c.filter((x) => x.suite === 'viewport').map((x) => x.file), VIEWPORT);
  // the full self-test is a browser test, the shipped page's self-test a public one
  assert.equal(c.find((x) => x.file === 'browser.test.mjs').suite, 'browser');
  assert.equal(c.find((x) => x.file === 'release.test.mjs').suite, 'unit');
});

test('suites: a helper module that defines tests, or a listed file that is missing, is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-suites-'));
  // (put together, so that this file's own text does not read as a browser import)
  const browserImport = 'import { openPage } from ' + "'../scripts/" + "cdp.mjs';\n";
  for (const f of PUBLIC.concat(VIEWPORT)) writeFileSync(join(dir, f), browserImport);
  writeFileSync(join(dir, 'a.test.mjs'), "import { test } from 'node:test';\n");
  assert.deepEqual(classify(dir).map((x) => `${x.file}:${x.suite}`).sort(), ['a.test.mjs:unit', 'offline.test.mjs:public', 'public-artifact.test.mjs:public', 'viewport.test.mjs:viewport']);
  writeFileSync(join(dir, 'forgotten.mjs'), "import { test } from 'node:test';\ntest('x', () => {});\n");
  assert.throws(() => classify(dir), /forgotten\.mjs imports node:test but is not named \*\.test\.mjs/);
  const dir2 = mkdtempSync(join(tmpdir(), 'netatlas-suites-'));
  writeFileSync(join(dir2, 'offline.test.mjs'), "import { test } from 'node:test';\n");
  assert.throws(() => classify(dir2), /offline\.test\.mjs is listed in the public suite but uses no browser[\s\S]*viewport\.test\.mjs is listed in scripts\/run-tests\.mjs but does not exist/);
});

test('suites: the TAP summary, and a skipped test seen by its directive (Node 18 hides it from the summary)', () => {
  const tap = 'TAP version 13\n# Subtest: a\nok 1 - a # SKIP no Chromium-based browser found\n  ---\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(parseSummary(tap), { tests: 1, pass: 0, fail: 0, skipped: 1, todo: 0, cancelled: 0 });
  assert.equal(parseSummary('# tests 4\n# pass 3\n# fail 1\n# skipped 0\n').fail, 1);
  assert.equal(parseSummary('crashed before any summary').tests, null);
});

test('package check: the committed release passes; a test module, an internal example or an external reference fails it', () => {
  const internal = internalNames();
  assert.ok(internal.includes('metro-ring.yaml') && internal.includes('minimal-edited.yaml') && !internal.includes('private-house.yaml'), internal.join());
  assert.deepEqual(inspectRelease(dist, { version: pkg.version, internal }), []);
  const inject = (s) => dist.replace('__defs["app/main"] = function', () => s + '__defs["app/main"] = function');
  assert.match(inspectRelease(inject('__defs["generated/test-examples"] = function (module, exports) {};\n'), { internal }).join(), /test-only module generated\/test-examples/);
  for (const id of TEST_ONLY) assert.ok(inspectRelease(inject(`__defs[${JSON.stringify(id)}] = 0;\n`), {}).some((p) => p.includes(id)), id);
  assert.match(inspectRelease(inject('var x = [{ "name": "metro-ring.yaml", "text": "" }];\n'), { internal }).join(), /internal example or fixture metro-ring\.yaml/);
  assert.match(inspectRelease(dist.replace('</head>', '<script src="https://cdn.example/x.js"></script></head>'), {}).join(), /2 <script> elements/);
  assert.match(inspectRelease(dist.replace('</head>', '<link rel="stylesheet" href="https://fonts.example/f.css"></head>'), {}).join(), /<link> element/);
  assert.match(inspectRelease(dist.replace("connect-src 'none'", "connect-src https:"), {}).join(), /lacks connect-src 'none'/);
  assert.match(inspectRelease(dist, { version: '9.9.9' }).join(), new RegExp(`says version ${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, not 9\\.9\\.9`));
  assert.match(inspectRelease(dist, { budget: 1000 }).join(), /over the budget of 1000 bytes/);
  assert.ok(Buffer.byteLength(dist) <= SIZE_BUDGET);
});

test('version and tag: the tag names package.json’s version, which package-lock.json repeats; a hyphen is a prerelease', () => {
  assert.deepEqual(checkVersion({ tag: 'v0.1.4', pkg: '0.1.4', lock: '0.1.4' }), { version: '0.1.4', prerelease: false, problems: [] });
  assert.equal(checkVersion({ tag: 'v0.2.0-rc.1', pkg: '0.2.0-rc.1', lock: '0.2.0-rc.1' }).prerelease, true);
  assert.match(checkVersion({ tag: 'v0.1.5', pkg: '0.1.4', lock: '0.1.4' }).problems.join(), /names version 0\.1\.5, but package\.json says 0\.1\.4/);
  assert.match(checkVersion({ tag: 'release-1', pkg: '0.1.4', lock: '0.1.4' }).problems.join(), /not vX\.Y\.Z/);
  assert.match(checkVersion({ pkg: '0.1.4', lock: '0.1.3' }).problems.join(), /package-lock\.json says 0\.1\.3/);
  const cur = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).version;
  assert.deepEqual(checkVersion({ pkg: pkg.version, lock: cur }).problems, []);
});

test('release notes: the CHANGELOG section of the version, without the next one', () => {
  const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const s = changelogSection(log, '0.1.3');
  assert.ok(s && s.length > 100);
  assert.doesNotMatch(s, /^## \[0\.1\.2\]/m);
  assert.equal(changelogSection(log, '9.9.9'), null);
  assert.equal(changelogSection('## [1.0.0] - 2026-01-01\nFirst.\n\n## [0.9.0]\nOld.\n', '1.0.0'), 'First.\n');
});

test('checksums and provenance: sha256sum format; the same input gives the same provenance, with no time in it', () => {
  const files = [{ name: 'netatlas.html', data: 'abc' }, { name: 'provenance.json', data: '{}\n' }];
  assert.equal(checksums(files), `${createHash('sha256').update('abc').digest('hex')}  netatlas.html\n${createHash('sha256').update('{}\n').digest('hex')}  provenance.json\n`);
  const input = { version: '0.1.4', prerelease: false, tag: 'v0.1.4', commit: 'a'.repeat(40), html: dist, formatVersion: 1, toolchain: { node: 'v24.22.0', npm: '11.19.1', typescript: '5.9.3', os: 'Linux x64' }, builder: { ci: 'GitHub Actions' } };
  const p = provenance(input);
  assert.deepEqual(provenance(input), p);
  assert.equal(p.artifact.sha256, createHash('sha256').update(dist).digest('hex'));
  assert.equal(p.artifact.bytes, Buffer.byteLength(dist));
  assert.equal(p.modelFormat, 1);
  assert.doesNotMatch(JSON.stringify(p), /\d{4}-\d\d-\d\dT|"(date|time|timestamp|created)/i);
});

test('reproducibility check: it covers every committed generated file, and the release HTML embeds no build time', () => {
  const committed = GENERATED.map((g) => g.path).filter((p) => !p.startsWith('build/'));
  assert.deepEqual(committed.sort(), ['dist/netatlas.html', 'docs/SUPPORT.md', 'src/generated/examples.ts', 'src/generated/help-assets.ts', 'src/generated/test-examples.ts']);
  for (const g of GENERATED) assert.match(g.by, /npm run build|tsc/, g.path);
  // no date or time of the build in the artifact: the same source gives the same bytes
  const build = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
  assert.doesNotMatch(build, /new Date|Date\.now|toISOString|process\.hrtime|Math\.random|SOURCE_DATE_EPOCH/);
});

test('package scripts: one full verification, the suites by name, freshness checks that write nothing', () => {
  const s = pkg.scripts;
  assert.equal(s.test, 'npm run build && node scripts/run-tests.mjs all');
  for (const suite of SUITES) assert.equal(s[`test:${suite}`], `node scripts/run-tests.mjs ${suite}`);
  assert.match(s.verify, /typecheck.*check:dist.*check:repro.*release:check.*run-tests\.mjs all/);
  // check:dist only verifies: every generator with --check (tsc writes build/js, which is not committed)
  for (const part of s['check:dist'].split(' && ')) assert.match(part, /--check$|^tsc -p tsconfig\.json$/, part);
  assert.equal(s.typecheck, 'tsc -p tsconfig.json --noEmit');
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(readFileSync(join(root, '.nvmrc'), 'utf8').trim(), '24');
});

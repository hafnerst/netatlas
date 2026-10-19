// Checks the shipped dist/netatlas.html as a release artifact, and prepares the
// release assets without publishing anything:
//
//   node scripts/release-check.mjs                    check dist/netatlas.html (and that it matches a fresh build)
//   node scripts/release-check.mjs --tag v0.1.4       also: the tag names this version and this commit, CHANGELOG has its section
//   node scripts/release-check.mjs --out release/     also write the assets: netatlas.html, SHA256SUMS,
//                                                     provenance.json and release-notes.md (the CHANGELOG section)
//
// What makes an artifact unfit for release (inspectRelease):
//   * a test-only module (TEST_ONLY), or an internal example or fixture by name;
//   * anything but one inline script; an external script, style, link or image;
//   * no strict Content-Security-Policy (default-src 'none', connect-src 'none');
//   * a version other than package.json's, or an unreplaced __VERSION__;
//   * more than SIZE_BUDGET bytes. The budget is raised only deliberately, with
//     a note in test/build.test.mjs, never to make a failing check pass.
//
// The build must have run first ("npm run check:dist" compiles build/js): this
// script runs scripts/build.mjs --check itself, so stale HTML is never packaged.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The modules only the test build may contain: the internal examples and fixtures, the full self-test, the viewport check. */
export const TEST_ONLY = ['generated/test-examples', 'app/selftest', 'app/viewport-check', 'app/main-test'];
/** The largest dist/netatlas.html that passes (bytes). Measured history and reasons: test/build.test.mjs. */
export const SIZE_BUDGET = 6 * 1024 * 1024;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The file names of the internal examples and fixtures (test/examples/**, test/fixtures/): never part of a release. */
export function internalNames(base = root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/\.ya?ml$/.test(e.name)) out.push(e.name);
    }
  };
  walk(join(base, 'test', 'examples'));
  walk(join(base, 'test', 'fixtures'));
  const pub = new Set(readdirSync(join(base, 'examples')).filter((f) => /\.ya?ml$/.test(f)));
  return [...new Set(out)].filter((n) => !pub.has(n)).sort();
}

/** What makes this HTML unfit as the release of `version`: a list of problems, empty when it is fit. */
export function inspectRelease(html, { version, internal = [], budget = SIZE_BUDGET } = {}) {
  const problems = [];
  for (const id of TEST_ONLY) if (html.includes(`__defs[${JSON.stringify(id)}]`)) problems.push(`contains the test-only module ${id}`);
  for (const name of internal) {
    const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`["']?name["']?\\s*:\\s*["']${q}["']`).test(html)) problems.push(`contains the internal example or fixture ${name}`);
  }
  const scripts = [...html.matchAll(/<script([^>]*)>/gi)];
  if (scripts.length !== 1) problems.push(`has ${scripts.length} <script> elements, not one inline script`);
  else if (scripts[0][1].trim()) problems.push(`its script has attributes (${scripts[0][1].trim()}): it must be inline`);
  // the markup without the script's body (any end tag form, such as "</script >"); the body is checked by the build audit
  const markup = html.replace(/<script([^>]*)>[\s\S]*?<\/script[^>]*>/gi, '<script$1></script>');
  if (/<link\b/i.test(markup)) problems.push('has a <link> element (an external style, font or icon)');
  if (/<(img|iframe|object|embed|audio|video|source)\b[^>]*\ssrc=["']?(?!data:)/i.test(markup)) problems.push('loads an external image or media element');
  if (/@import|url\(\s*['"]?(?!data:)[a-z]+:/i.test(markup)) problems.push('its stylesheet loads an external resource');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  if (!csp) problems.push('has no Content-Security-Policy');
  else for (const d of ["default-src 'none'", "connect-src 'none'"]) if (!csp[1].includes(d)) problems.push(`its Content-Security-Policy lacks ${d}`);
  if (html.includes('__VERSION__')) problems.push('has an unreplaced __VERSION__');
  const gen = /<meta name="generator" content="netatlas ([^"]*)">/.exec(html);
  if (version && (!gen || gen[1] !== version)) problems.push(`says version ${gen ? gen[1] : '(none)'}, not ${version}`);
  const size = Buffer.byteLength(html);
  if (size > budget) problems.push(`is ${size} bytes, over the budget of ${budget} bytes (scripts/release-check.mjs SIZE_BUDGET)`);
  return problems;
}

/** The version a tag names, whether it is a prerelease, and what disagrees with package.json / package-lock.json. */
export function checkVersion({ tag, pkg, lock }) {
  const problems = [];
  if (pkg !== lock) problems.push(`package.json says ${pkg}, package-lock.json says ${lock}`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg)) problems.push(`package.json's version ${pkg} is not a semantic version`);
  if (tag !== undefined && tag !== null) {
    const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
    if (!m) problems.push(`the tag "${tag}" is not vX.Y.Z or vX.Y.Z-pre`);
    else if (m[1] !== pkg) problems.push(`the tag ${tag} names version ${m[1]}, but package.json says ${pkg}`);
  }
  return { version: pkg, prerelease: pkg.includes('-'), problems };
}

/** The CHANGELOG.md section of a version (its text after the heading), or null. */
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const q = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = lines.findIndex((l) => new RegExp(`^## \\[${q}\\]`).test(l));
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(at + 1, end).join('\n').trim() + '\n';
}

/** A SHA256SUMS manifest ("sha256sum -c" reads it): one line per file. */
export function checksums(files) {
  return files.map((f) => `${sha256(f.data)}  ${f.name}\n`).join('');
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && cmd === 'npm' }).trim();
  } catch {
    return null;
  }
}

/** The release's provenance: what was built from what, with which tools. No timestamps, so a repeated run gives the same file. */
export function provenance({ version, prerelease, tag, commit, html, formatVersion, toolchain, builder }) {
  return {
    schema: 'netatlas-release-provenance/1',
    application: 'netatlas',
    version,
    prerelease,
    tag: tag || null,
    commit,
    modelFormat: formatVersion,
    artifact: { name: 'netatlas.html', bytes: Buffer.byteLength(html), sha256: sha256(html) },
    build: { command: 'npm ci && npm run build', reproducible: 'scripts/check-repro.mjs: two builds from the same commit are byte-identical', ...toolchain },
    builder: builder || null,
  };
}

function fail(lines) {
  for (const l of [].concat(lines)) console.error(`FAIL: ${l}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tag = arg('--tag');
  const outDir = arg('--out') ? resolve(arg('--out')) : null;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const v = checkVersion({ tag, pkg: pkg.version, lock: lock.version });
  const problems = [...v.problems];
  const commit = run('git', ['rev-parse', 'HEAD']);
  if (tag) {
    // the tag must exist and name exactly the commit being packaged
    const tagged = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
    if (!tagged) problems.push(`the tag ${tag} does not exist here (fetch tags first: git fetch --tags)`);
    else if (tagged !== commit) problems.push(`the tag ${tag} is commit ${tagged.slice(0, 12)}, but HEAD is ${String(commit).slice(0, 12)}`);
  }
  if (outDir && run('git', ['status', '--porcelain', '--untracked-files=no'])) problems.push('the working tree has uncommitted changes to tracked files: a release is packaged from a commit');
  const notes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), v.version);
  if (tag && !notes) problems.push(`CHANGELOG.md has no "## [${v.version}]" section`);
  // never package stale HTML: it must equal a fresh build of this source (needs build/js: npm run check:dist)
  if (!existsSync(join(root, 'build', 'js', 'app', 'main.js'))) problems.push('build/js is missing: run "npm run check:dist" first');
  else {
    try {
      execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--check'], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      problems.push(String(e.stderr || e.message).trim());
    }
  }
  const html = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
  problems.push(...inspectRelease(html, { version: v.version, internal: internalNames() }).map((p) => `dist/netatlas.html ${p}`));
  if (problems.length) fail(problems);
  const size = Buffer.byteLength(html);
  console.log(`dist/netatlas.html is fit for release ${tag || 'v' + v.version}${v.prerelease ? ' (a prerelease)' : ''}: ${size} bytes (${((size / SIZE_BUDGET) * 100).toFixed(1)} % of the budget), sha256 ${sha256(html)}`);
  if (outDir) {
    if (existsSync(outDir) && readdirSync(outDir).length) fail(`${outDir} is not empty: the assets are written only to a new or empty directory`);
    mkdirSync(outDir, { recursive: true });
    let formatVersion = null;
    try {
      formatVersion = require(join(root, 'build', 'js', 'yaml', 'schema.js')).FORMAT_VERSION;
    } catch {
      /* reported as null */
    }
    const ts = JSON.parse(readFileSync(join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
    const gh = process.env.GITHUB_ACTIONS === 'true';
    const prov = provenance({
      version: v.version,
      prerelease: v.prerelease,
      tag,
      commit,
      html,
      formatVersion,
      toolchain: { node: process.version, npm: run('npm', ['--version']), typescript: ts, os: `${os.type()} ${os.arch()}` },
      // no run number: a re-run of the same release gives the same file (the attestation names the run)
      builder: gh ? { ci: 'GitHub Actions', repository: process.env.GITHUB_REPOSITORY, workflow: process.env.GITHUB_WORKFLOW_REF || process.env.GITHUB_WORKFLOW, runner: `${process.env.RUNNER_OS || ''} ${process.env.RUNNER_ARCH || ''}`.trim() } : { ci: null, host: 'local' },
    });
    const files = [
      { name: 'netatlas.html', data: html },
      { name: 'provenance.json', data: JSON.stringify(prov, null, 1) + '\n' },
    ];
    for (const f of files) writeFileSync(join(outDir, f.name), f.data);
    writeFileSync(join(outDir, 'SHA256SUMS'), checksums(files));
    writeFileSync(join(outDir, 'release-notes.md'), notes || `(CHANGELOG.md has no section for ${v.version} yet)\n`);
    for (const f of ['netatlas.html', 'provenance.json', 'SHA256SUMS', 'release-notes.md']) console.log(`wrote ${join(outDir, f)}  ${statSync(join(outDir, f)).size} bytes`);
  }
}

// The rules for the GitHub Actions workflows (.github/workflows), so that a
// change that weakens them fails here as well as in review:
//   * the default token is read-only; a write permission only where listed below;
//   * no pull_request_target or workflow_run (never untrusted code with secrets or a write token);
//   * every action pinned to a full commit SHA with its version as a comment;
//   * no ${{ }} expression inside a shell script: event text reaches scripts only through env;
//   * a timeout on every job, checkout without stored credentials, npm ci only;
//   * nothing commits, pushes, tags, merges or replaces a release asset;
//   * CI's check names are the required checks of docs/rulesets/dev-main-required-checks.json.
// actionlint and zizmor check the rest in CI (the "Workflow lint" job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.github', 'workflows');
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
const text = (f) => readFileSync(join(dir, f), 'utf8');

/** The checks that the branch rules require: CI's job names (matrix entries expanded). */
export const REQUIRED_CHECKS = [
  'Source and generated files',
  'Model and analysis tests',
  'Compatibility (Node 22 on Linux)',
  'Compatibility (Node 24 on Windows)',
  'Browser regression tests',
  'Public artifact',
  'Viewport checks',
  'Workflow lint',
  'Release PR source',
];
/** The only write permissions: file, job, permission. */
const WRITES = ['release.yml publish contents', 'release.yml publish id-token', 'release.yml publish attestations', 'security.yml codeql security-events'];

/** The jobs of a workflow: name -> its lines (a two-space-indented key under "jobs:"). */
function jobs(src) {
  const lines = src.split('\n');
  const at = lines.indexOf('jobs:');
  const out = new Map();
  let cur = null;
  for (const l of lines.slice(at + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) out.set((cur = m[1]), []);
    else if (cur && (l.startsWith('    ') || !l.trim())) out.get(cur).push(l);
    else if (l.trim() && !l.startsWith(' ')) cur = null;
  }
  return out;
}

/** The shell scripts of a workflow: every "run:" value, inline or block. */
function scripts(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && m[2] !== '|' && m[2] !== '>') {
      out.push(m[2]);
      continue;
    }
    const ind = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].search(/\S/) > ind); j++) body.push(lines[j]);
    out.push(body.join('\n'));
  }
  return out;
}

test('there are the CI, Security and Release workflows', () => {
  assert.deepEqual(files, ['ci.yml', 'release.yml', 'security.yml']);
});

test('the default token is read-only, and only the listed jobs may write', () => {
  const writes = [];
  for (const f of files) {
    const src = text(f);
    assert.match(src, /\npermissions:\n {2}contents: read\n(?! )/, `${f}: top-level permissions are contents: read only`);
    for (const [job, lines] of jobs(src)) {
      for (const l of lines) {
        const m = /^\s+([a-z-]+): write\b/.exec(l);
        if (m) writes.push(`${f} ${job} ${m[1]}`);
      }
    }
    assert.doesNotMatch(src, /write-all/, `${f}: no write-all`);
  }
  assert.deepEqual(writes.sort(), WRITES.slice().sort());
});

test('no trigger that runs untrusted code with secrets or a write token', () => {
  for (const f of files) {
    assert.doesNotMatch(text(f), /pull_request_target|workflow_run/, f);
  }
});

test('every action is pinned to a full commit SHA, with its version as a comment', () => {
  for (const f of files) {
    const uses = [...text(f).matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0, f);
    for (const [, ref, rest] of uses) {
      if (ref.startsWith('./')) continue;
      assert.match(ref, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/, `${f}: ${ref} is not pinned to a commit`);
      assert.match(rest, /^\s+# v\d+(\.\d+)*$/, `${f}: ${ref} has no "# vX.Y.Z" comment`);
    }
  }
});

test('no expression inside a shell script: event text and inputs reach scripts through env only', () => {
  for (const f of files) {
    for (const s of scripts(text(f))) assert.doesNotMatch(s, /\$\{\{/, `${f}: ${s.trim().split('\n')[0]}`);
  }
});

test('every job has a timeout; checkout keeps no credentials; installs use npm ci', () => {
  for (const f of files) {
    const src = text(f);
    for (const [job, lines] of jobs(src)) assert.ok(lines.some((l) => /^ {4}timeout-minutes: \d+$/.test(l)), `${f} ${job}: timeout-minutes`);
    const checkouts = src.split(/\n\s*- uses: actions\/checkout@/).slice(1);
    for (const c of checkouts) assert.match(c.split(/\n\s*- /)[0], /persist-credentials: false/, `${f}: a checkout keeps its credentials`);
    for (const s of scripts(src)) {
      assert.doesNotMatch(s, /\bnpm (install|i)\b|\bnpx\b|npm .*-g\b/, `${f}: ${s.trim()}`);
    }
  }
});

test('nothing commits, pushes, tags, merges, enables auto-merge or replaces a release asset', () => {
  for (const f of files) {
    for (const s of scripts(text(f))) {
      assert.doesNotMatch(s, /git (commit|push|tag|merge(?!-base))\b|gh pr (merge|review)|--auto\b|--clobber|gh release (delete|edit)/, `${f}: ${s.trim().split('\n')[0]}`);
    }
  }
  // the release is attached to a draft: publishing is the maintainer's
  assert.match(text('release.yml'), /gh release create "\$TAG" "\$\{flags\[@\]\}"/);
  assert.match(text('release.yml'), /flags=\(--draft --verify-tag/);
});

test('pull request runs are cancelled by a newer push; runs on dev, main and releases are not', () => {
  for (const f of ['ci.yml', 'security.yml']) assert.match(text(f), /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/, f);
  assert.match(text('release.yml'), /concurrency:\n {2}group: release-\$\{\{ inputs\.tag \}\}\n {2}cancel-in-progress: false/);
  // a different group: a CI run can never cancel a release
  assert.match(text('ci.yml'), /group: ci-/);
});

test("CI's check names are the required checks of the proposed ruleset, and browser jobs are strict", () => {
  const src = text('ci.yml');
  const names = [];
  for (const [, lines] of jobs(src)) {
    const name = lines.map((l) => /^ {4}name: (.+)$/.exec(l)).find(Boolean);
    if (!name) continue;
    if (name[1].includes('${{ matrix.name }}')) {
      for (const l of lines) {
        const m = /^ {10}- name: (.+)$/.exec(l);
        if (m) names.push(name[1].replace('${{ matrix.name }}', m[1]));
      }
    } else names.push(name[1]);
  }
  assert.deepEqual(names.sort(), REQUIRED_CHECKS.slice().sort());
  const ruleset = JSON.parse(readFileSync(join(root, 'docs', 'rulesets', 'dev-main-required-checks.json'), 'utf8'));
  const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
  assert.deepEqual(rule.parameters.required_status_checks.map((c) => c.context).sort(), REQUIRED_CHECKS.slice().sort());
  assert.ok(rule.parameters.required_status_checks.every((c) => c.integration_id === 15368), 'the checks come from GitHub Actions');
  assert.deepEqual(ruleset.bypass_actors, []);
  // the browser suites run strictly: a missing browser fails
  assert.match(src, /NETATLAS_REQUIRE_BROWSER: '1'/);
  for (const s of ['browser', 'public', 'viewport']) assert.match(src, new RegExp(`run-tests\\.mjs ${s} --strict`));
  // and the pinned browser version is the same in CI and the release
  const v = /CHROME_VERSION: '([0-9.]+)'/;
  assert.equal(v.exec(src)[1], v.exec(text('release.yml'))[1]);
});

test('the committed artifact is checked before anything regenerates it', () => {
  // in CI's "Source and generated files" job and in the release: check:dist (writes nothing) comes before
  // everything that writes the generated files (check:repro, build) and before the tests
  const ci = jobs(text('ci.yml')).get('static').join('\n');
  for (const [name, src] of [['ci.yml static', ci], ['release.yml', text('release.yml')]]) {
    const check = src.indexOf('npm run check:dist');
    assert.ok(check > 0, name);
    for (const writer of ['npm run check:repro', 'npm run build', 'run-tests.mjs', 'release-check.mjs']) {
      const at = src.indexOf(writer);
      assert.ok(at < 0 || at > check, `${name}: ${writer} before check:dist`);
    }
  }
});

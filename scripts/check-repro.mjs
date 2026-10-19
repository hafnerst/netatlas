// Regenerates every generated file twice, and fails if
//   * the two builds differ (the build is not reproducible), or
//   * regenerating changed a tracked file (the committed artifact was stale).
//
//   node scripts/check-repro.mjs
//
// Run it AFTER "npm run check:dist", which proves the committed files current
// without writing them: this script writes them, so on its own it would hide
// what it overwrote. It needs a working tree without uncommitted changes to
// the generated files (it compares against git).
//
// The build is the "npm run build" pipeline, step by step, so that every
// output is hashed: src/generated/*.ts, build/js (tsc), docs/SUPPORT.md,
// dist/netatlas.html and the test build build/netatlas-test.html.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** The generated files a build writes, and the command that regenerates each. */
export const GENERATED = [
  { path: 'src/generated/examples.ts', by: 'npm run build (scripts/gen-examples.mjs)' },
  { path: 'src/generated/test-examples.ts', by: 'npm run build (scripts/gen-examples.mjs)' },
  { path: 'src/generated/help-assets.ts', by: 'npm run build (scripts/gen-help.mjs)' },
  { path: 'docs/SUPPORT.md', by: 'npm run build (scripts/gen-support.mjs)' },
  { path: 'dist/netatlas.html', by: 'npm run build (scripts/build.mjs)' },
  { path: 'build/netatlas-test.html', by: 'npm run build (not committed)' },
  { path: 'build/js', by: 'tsc (not committed)' },
];

const node = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

function build() {
  node(['scripts/gen-examples.mjs']);
  node(['scripts/gen-help.mjs']);
  node([tsc, '-p', 'tsconfig.json']);
  node(['scripts/gen-support.mjs']);
  node(['scripts/build.mjs']);
}

function hashes() {
  const out = new Map();
  // (each file is read once, without a separate check before: a directory is known from its listing)
  const file = (abs) => out.set(relative(root, abs).replace(/\\/g, '/'), createHash('sha256').update(readFileSync(abs)).digest('hex'));
  const dir = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) (e.isDirectory() ? dir : file)(join(abs, e.name));
  };
  for (const g of GENERATED) {
    const abs = join(root, g.path);
    try {
      dir(abs);
    } catch (e) {
      if (e.code === 'ENOTDIR') file(abs);
      else if (e.code !== 'ENOENT') throw e;
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).replace(/\s+$/, ''); // (not trim(): a porcelain line starts with a space)
  const tracked = new Set(git('ls-files', '--', ...GENERATED.map((g) => g.path)).split('\n').filter(Boolean));
  const dirtyBefore = git('status', '--porcelain', '--', ...tracked);
  if (dirtyBefore) {
    console.error(`FAIL: generated files have uncommitted changes, so the comparison with the commit would be meaningless:\n${dirtyBefore}`);
    process.exit(1);
  }

  build();
  const first = hashes();
  build();
  const second = hashes();

  const problems = [];
  for (const [f, h] of first) if (second.get(f) !== h) problems.push(`not reproducible: ${f} differs between two builds of the same source`);
  for (const f of second.keys()) if (!first.has(f)) problems.push(`not reproducible: ${f} appeared only in the second build`);
  const changed = git('status', '--porcelain', '--', ...tracked);
  for (const line of changed.split('\n').filter(Boolean)) {
    const f = line.slice(3);
    const g = GENERATED.find((x) => f === x.path || f.startsWith(x.path + '/'));
    problems.push(`stale: regenerating changed the committed ${f}; regenerate with ${g ? g.by : 'npm run build'} and commit it`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    if (changed) console.error(`\n${git('diff', '--stat', '--', ...tracked)}`);
    process.exit(1);
  }
  const dist = first.get('dist/netatlas.html');
  console.log(`two builds are byte-identical (${first.size} files) and leave every committed file unchanged; dist/netatlas.html sha256 ${dist}`);
}

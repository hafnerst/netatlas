// Runs the test files of test/ as named suites, so that local runs and CI run
// the same files the same way, every file exactly once:
//
//   unit      DOM-free tests: model, YAML, validation, analysis, protocols,
//             the scheduler, the build audit (the tsc output in build/js and
//             the committed dist/netatlas.html; no browser)
//   browser   interaction and rendering tests in a headless Chrome/Edge/
//             Chromium on the test build (build/netatlas-test.html), and the
//             full in-browser self-test
//   public    the shipped dist/netatlas.html: its own self-test, the offline
//             contract observed from outside the page, the release package check
//   viewport  the viewport check at ten window sizes (narrow windows and
//             zoom approximated by smaller viewports)
//   all       the four above, one after the other
//
//   node scripts/run-tests.mjs unit
//   node scripts/run-tests.mjs browser public --strict
//   node scripts/run-tests.mjs --list            which file is in which suite
//
// A file is in a browser suite when it imports scripts/browser-selftest.mjs
// or scripts/cdp.mjs; PUBLIC and VIEWPORT name the files of those two
// suites, every other browser file is "browser", every other file "unit".
//
// Options:
//   --strict           a browser suite fails when no browser is found or a
//                      test was skipped (CI); without it, a missing browser
//                      skips those tests, as "npm test" always did locally
//   --concurrency N    files run at once (default: the CPUs, at most 8, for
//                      unit; 2 for the browser suites). NETATLAS_TEST_CONCURRENCY too.
//   --results DIR      where logs, the summary and failure diagnostics go
//                      (default test-results/; not committed)
//   --file-timeout S   a file still running after S seconds fails (default 1200)
//   --only NAME        only the files whose name contains NAME (repeatable); the
//                      summary says how many files it left out
//
// Every file runs in its own process ("node <file>", TAP), as node --test
// does itself. Its whole output is kept in DIR/<suite>/<file>.log and
// printed when it fails. The browser helpers write screenshots, console
// errors and self-test results to DIR/<suite>/<file>/ (NETATLAS_DIAG_DIR);
// they are kept only for failed files.
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

export const SUITES = ['unit', 'browser', 'public', 'viewport'];
/** The files of the public suite: they exercise the shipped dist/netatlas.html. */
export const PUBLIC = ['public-artifact.test.mjs', 'offline.test.mjs'];
/** The files of the viewport suite. */
export const VIEWPORT = ['viewport.test.mjs'];

const BROWSER_IMPORT = /from\s+['"]\.\.\/scripts\/(?:cdp|browser-selftest)\.mjs['"]/;

/** Every test file and its suite; throws on a file that would never run or a listed file that is missing. */
export function classify(dir = testDir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  const problems = [];
  for (const f of names) {
    const src = readFileSync(join(dir, f), 'utf8');
    const isTest = f.endsWith('.test.mjs');
    if (!isTest) {
      // a helper module; one that defines tests would never run
      if (/from\s+['"]node:test['"]/.test(src)) problems.push(`${f} imports node:test but is not named *.test.mjs, so no suite runs it`);
      continue;
    }
    const browser = BROWSER_IMPORT.test(src);
    const suite = PUBLIC.includes(f) ? 'public' : VIEWPORT.includes(f) ? 'viewport' : browser ? 'browser' : 'unit';
    if ((suite === 'public' || suite === 'viewport') && !browser) problems.push(`${f} is listed in the ${suite} suite but uses no browser`);
    out.push({ file: f, suite });
  }
  for (const f of PUBLIC.concat(VIEWPORT)) if (!names.includes(f)) problems.push(`${f} is listed in scripts/run-tests.mjs but does not exist`);
  if (problems.length) throw new Error(problems.join('\n'));
  return out;
}

/** The counts of a node:test TAP summary. */
export function parseSummary(text) {
  const n = (k) => {
    const m = new RegExp('^# ' + k + ' (\\d+)\\s*$', 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  // Node 18 counts a whole file as one test in that summary: a skipped test inside it is seen by its "# SKIP" directive
  const directives = (text.match(/^\s*ok \d+ - .*# SKIP\b/gim) || []).length;
  const skipped = n('skipped');
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: Math.max(skipped || 0, directives), todo: n('todo'), cancelled: n('cancelled') };
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function runFile(file, env, timeoutS) {
  return new Promise((done) => {
    // the file itself, in its own process, reporting every test in TAP, whose summary is parsed
    // ("node --test <file>" on Node 18 reports a passing file as one test and hides what it skipped;
    // Node 18.12 has no --test-reporter and prints TAP anyway)
    const [maj, min] = process.versions.node.split('.').map(Number);
    const args = maj > 19 || (maj === 19 && min >= 6) || (maj === 18 && min >= 15) ? ['--test-reporter=tap', file] : [file];
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutS * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out, timedOut, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function main(argv) {
  const opt = { suites: [], strict: false, list: false, concurrency: Number(process.env.NETATLAS_TEST_CONCURRENCY) || 0, results: join(root, 'test-results'), fileTimeout: 1200, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') opt.strict = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--concurrency') opt.concurrency = Number(argv[++i]);
    else if (a === '--results') opt.results = resolve(argv[++i]);
    else if (a === '--file-timeout') opt.fileTimeout = Number(argv[++i]);
    else if (a === '--only') opt.only.push(argv[++i]);
    else if (a === 'all') opt.suites.push(...SUITES);
    else if (SUITES.includes(a)) opt.suites.push(a);
    else {
      console.error(`unknown argument "${a}" (suites: ${SUITES.join(', ')}, all)`);
      return 2;
    }
  }
  if (process.env.NETATLAS_REQUIRE_BROWSER === '1') opt.strict = true;
  const files = classify();
  if (opt.list) {
    for (const s of SUITES) {
      const fs = files.filter((f) => f.suite === s);
      console.log(`${s} (${fs.length}):\n  ${fs.map((f) => f.file).join('\n  ')}`);
    }
    return 0;
  }
  if (!opt.suites.length) {
    console.error(`name a suite: ${SUITES.join(', ')} or all (--list shows the files)`);
    return 2;
  }
  const suites = SUITES.filter((s) => opt.suites.includes(s));
  const needsBrowser = suites.some((s) => s !== 'unit');
  // what the suites test must exist: the tsc output and the test build (unit: the packaging test compares the
  // release with the test build); the public suite tests the committed dist/netatlas.html and needs no build
  const need = [];
  if (suites.some((s) => s !== 'public') && !existsSync(join(root, 'build', 'js', 'app', 'main.js'))) need.push('build/js');
  if (suites.some((s) => s !== 'public') && !existsSync(join(root, 'build', 'netatlas-test.html'))) need.push('build/netatlas-test.html');
  if (need.length) need[need.length - 1] += ' (run "npm run build")';
  if (need.length) {
    console.error(`FAIL: missing ${need.join(' and ')}`);
    return 1;
  }

  // the environment, recorded with the results
  const env = { node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') ? true : false, browser: null, browserVersion: null, strict: opt.strict };
  if (needsBrowser) {
    const { findBrowser } = await import('./browser-selftest.mjs');
    const wanted = process.env.NETATLAS_BROWSER;
    if (wanted && wanted !== 'none' && !existsSync(wanted)) {
      const msg = `NETATLAS_BROWSER=${wanted} does not exist`;
      if (opt.strict) {
        console.error(`FAIL: ${msg}`);
        return 1;
      }
      console.warn(`warning: ${msg}; looking for an installed browser instead`);
    }
    env.browser = findBrowser();
    if (!env.browser) {
      if (opt.strict) {
        console.error('FAIL: no Chrome/Edge/Chromium found, and --strict (or NETATLAS_REQUIRE_BROWSER=1) requires one. Set NETATLAS_BROWSER=/path/to/browser.');
        return 1;
      }
      console.warn('warning: no Chrome/Edge/Chromium found: the browser tests are SKIPPED (set NETATLAS_BROWSER; CI runs with --strict)');
    } else {
      const { browserVersion } = await import('./cdp.mjs');
      try {
        env.browserVersion = await browserVersion(env.browser);
      } catch (e) {
        if (opt.strict) {
          console.error(`FAIL: the browser ${env.browser} does not start: ${e.message}`);
          return 1;
        }
        console.warn(`warning: the browser ${env.browser} did not report its version: ${e.message}`);
      }
    }
  }
  mkdirSync(opt.results, { recursive: true });
  console.log(`node ${env.node} · ${env.os} · commit ${env.commit ? env.commit.slice(0, 12) : '?'}${env.dirty ? ' (uncommitted changes)' : ''}` + (needsBrowser ? ` · browser ${env.browserVersion || env.browser || 'none'}` : '') + (opt.strict ? ' · strict' : ''));

  const summary = { environment: env, suites: {} };
  let failed = 0;
  for (const suite of suites) {
    const all = files.filter((f) => f.suite === suite);
    const list = opt.only.length ? all.filter((f) => opt.only.some((o) => f.file.includes(o))) : all;
    if (list.length < all.length) console.log(`\n(--only: ${list.length} of the ${all.length} files of ${suite})`);
    if (!list.length) continue;
    const n = opt.concurrency || (suite === 'unit' ? Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 2) : 2);
    const dir = join(opt.results, suite);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log(`\n== ${suite}: ${list.length} files, ${n} at a time`);
    const t0 = Date.now();
    const results = await pool(list, n, async ({ file }) => {
      const base = file.replace(/\.test\.mjs$/, '');
      const diag = join(dir, base);
      const r = await runFile(join('test', file), { ...process.env, NETATLAS_DIAG_DIR: diag }, opt.fileTimeout);
      const c = parseSummary(r.out);
      const problems = [];
      if (r.timedOut) problems.push(`still running after ${opt.fileTimeout} s: stopped`);
      if (r.code !== 0) problems.push(`exit code ${r.code}`);
      if (c.fail) problems.push(`${c.fail} failed`);
      if (c.cancelled) problems.push(`${c.cancelled} cancelled`);
      if (c.tests === null && !r.timedOut) problems.push('no test summary in the output');
      if (opt.strict && suite !== 'unit' && c.skipped) problems.push(`${c.skipped} skipped (strict: a browser test may not be skipped)`);
      writeFileSync(join(dir, base + '.log'), r.out);
      const ok = !problems.length;
      if (ok) rmSync(diag, { recursive: true, force: true });
      const skip = c.skipped ? `, ${c.skipped} skipped` : '';
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.seconds.toFixed(1).padStart(6)} s  ${file}  (${c.pass ?? '?'}/${c.tests ?? '?'} passed${skip})${ok ? '' : '  -- ' + problems.join('; ')}`);
      if (!ok) {
        const lines = r.out.split('\n');
        console.log(lines.length > 400 ? `  … (${lines.length - 400} earlier lines in ${join(dir, base + '.log')})\n` + lines.slice(-400).join('\n') : r.out);
      }
      return { file, ok, problems, seconds: r.seconds, ...c };
    });
    const bad = results.filter((r) => !r.ok);
    failed += bad.length;
    const tests = results.reduce((s, r) => s + (r.tests || 0), 0);
    const skipped = results.reduce((s, r) => s + (r.skipped || 0), 0);
    summary.suites[suite] = { files: results.length, failedFiles: bad.map((r) => r.file), tests, skipped, seconds: (Date.now() - t0) / 1000, results };
    console.log(`${bad.length ? 'FAIL' : 'PASS'}: ${suite}: ${results.length - bad.length}/${results.length} files, ${tests} tests${skipped ? `, ${skipped} skipped` : ''}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (bad.length) console.log(`  failed: ${bad.map((r) => r.file).join(', ')}`);
  }
  writeFileSync(join(opt.results, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  writeFileSync(join(opt.results, 'environment.json'), JSON.stringify(env, null, 1) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    let md = `### Tests: ${suites.join(', ')}\n\n| Suite | Files | Tests | Skipped | Failed files | Time |\n|---|---|---|---|---|---|\n`;
    for (const s of suites) {
      const x = summary.suites[s];
      if (!x) continue;
      md += `| ${s} | ${x.files} | ${x.tests} | ${x.skipped} | ${x.failedFiles.join(', ') || 'none'} | ${x.seconds.toFixed(0)} s |\n`;
    }
    md += `\nNode ${env.node} · ${env.os} · commit \`${env.commit}\`` + (needsBrowser ? ` · browser ${env.browserVersion || 'none'}` : '') + '\n';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${suites.join(', ')}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.stack || e.message);
      process.exit(1);
    },
  );
}

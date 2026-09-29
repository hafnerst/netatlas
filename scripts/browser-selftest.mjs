// Runs the in-page self-test (dist/netatlas.html#selftest) in a headless
// Chromium-based browser (Chrome, Edge or Chromium) with DNS resolution
// disabled, and reports the results. Exit code 0 = all checks passed,
// 2 = no browser found (skipped), 1 = failures.
//
//   node scripts/browser-selftest.mjs            run the self-test
//   node scripts/browser-selftest.mjs --shot     also write screenshots to dist/screenshots/
//
// Set NETATLAS_BROWSER=/path/to/chrome to choose the browser explicitly.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = resolve(root, 'dist', 'netatlas.html');

export function findBrowser() {
  const env = process.env.NETATLAS_BROWSER;
  if (env && existsSync(env)) return env;
  const pf = process.env['ProgramFiles'] || 'C:\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    join(pf, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Google/Chrome/Application/chrome.exe'),
    join(local, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
  return candidates.find((c) => c && existsSync(c)) || null;
}

export function run(browser, url, extra) {
  const profile = mkdtempSync(join(tmpdir(), 'netatlas-'));
  try {
    return execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        // any DNS lookup fails: proves nothing on the page needs the network
        '--host-resolver-rules=MAP * ~NOTFOUND',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=20000',
        ...extra,
        url,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files briefly */
    }
  }
}

function decode(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function runSelfTest() {
  const browser = findBrowser();
  if (!browser) return { skipped: true };
  if (!existsSync(html)) throw new Error('dist/netatlas.html not found — run "npm run build" first');
  // desktop size, so the element lists (hidden below 1100 px) are on screen
  const dom = run(browser, pathToFileURL(html).href + '#selftest', ['--window-size=1600,1000', '--dump-dom']);
  const m = /<pre id="selftest"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (!m || !m[1].trim()) return { browser, pass: false, error: 'self-test produced no output', raw: dom.slice(0, 2000) };
  return { browser, ...JSON.parse(decode(m[1])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = runSelfTest();
  if (res.skipped) {
    console.log('SKIPPED: no Chrome/Edge/Chromium found (set NETATLAS_BROWSER=/path/to/browser)');
    process.exit(2);
  }
  console.log(`browser: ${res.browser}`);
  if (res.error) {
    console.log('ERROR:', res.error, res.raw || '');
    process.exit(1);
  }
  for (const c of res.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : '  -- ' + c.detail}`);
  // the YAML files the editor "downloaded" during the run (captured in the page), for review
  if (res.downloads && res.downloads.length) {
    const dir = join(root, 'dist', 'selftest-downloads');
    mkdirSync(dir, { recursive: true });
    for (const d of res.downloads) writeFileSync(join(dir, d.name.replace(/[^A-Za-z0-9._-]/g, '_')), d.text);
    console.log(`\nsaved ${res.downloads.length} downloaded file(s) to dist/selftest-downloads/`);
  }
  console.log(`\n${res.pass ? 'PASS' : 'FAIL'}: ${res.checks.filter((c) => c.ok).length}/${res.total} checks`);
  if (process.argv.includes('--shot')) {
    const outDir = join(root, 'dist', 'screenshots');
    mkdirSync(outDir, { recursive: true });
    const shots = [[0, 'physical'], [0, 'logical'], [1, 'physical'], [1, 'logical'], [2, 'logical'], [0, 'logical&select=relation:gre-muc'], [0, 'physical&select=relation:gre-muc']];
    for (const [ex, view] of shots) {
      const file = join(outDir, `example${ex}-${view.replace(/[^a-z0-9-]+/gi, "_")}.png`);
      run(res.browser, pathToFileURL(html).href + `#example=${ex}&view=${view}`, ['--window-size=1600,1000', `--screenshot=${file}`, '--hide-scrollbars']);
      console.log('screenshot:', file);
    }
  }
  process.exit(res.pass ? 0 : 1);
}

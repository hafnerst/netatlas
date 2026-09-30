// Runs the in-page self-test (dist/netatlas.html#selftest) in a headless
// Chromium-based browser (Chrome, Edge or Chromium) with DNS resolution
// disabled, and reports the results. Exit code 0 = all checks passed,
// 2 = no browser found (skipped), 1 = failures.
//
//   node scripts/browser-selftest.mjs            run the self-test
//   node scripts/browser-selftest.mjs --shot     also write screenshots to dist/screenshots/
//   node scripts/browser-selftest.mjs --viewport run the viewport check (#viewportcheck) at several window sizes
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
        '--virtual-time-budget=120000',
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

function runPage(hash, extra) {
  const browser = findBrowser();
  if (!browser) return { skipped: true };
  if (!existsSync(html)) throw new Error('dist/netatlas.html not found — run "npm run build" first');
  const dom = run(browser, pathToFileURL(html).href + '#' + hash, [...extra, '--dump-dom']);
  const m = /<pre id="selftest"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (!m || !m[1].trim()) {
    const last = /data-selftest-last="([^"]*)"/.exec(dom);
    return { browser, pass: false, error: 'the page produced no result' + (last ? `; the last finished check was ${last[1]}` : ''), raw: dom.slice(0, 2000) };
  }
  return { browser, ...JSON.parse(decode(m[1])) };
}

export function runSelfTest() {
  // desktop size: model panel, diagram and side panel next to each other
  return runPage('selftest', ['--window-size=1600,1000']);
}

/**
 * Window sizes at which the page must fit its viewport: a maximized desktop
 * window, windows that are not maximized, the two narrow layouts, and zoomed
 * pages. Browser zoom shrinks the viewport measured in CSS pixels (a
 * 1600x900 window at 200% has the viewport of an 800x450 window), so a
 * zoomed page is checked as that smaller window.
 */
export const VIEWPORTS = [
  { name: 'maximized desktop', size: '1920,1080' },
  { name: 'desktop', size: '1600,1000' },
  { name: 'not maximized', size: '1280,620' },
  { name: 'short and wide', size: '1400,480' },
  { name: 'narrow (under 1100px)', size: '1000,700' },
  { name: 'narrow (under 860px)', size: '800,640' },
  { name: '1920x1080 zoomed to 150%', size: '1280,720' },
  { name: '1600x900 zoomed to 200%', size: '800,450' },
  { name: '1920x1080 zoomed to 300%', size: '640,360' },
  { name: 'small window', size: '600,520' },
];

/** Run the in-page viewport check (#viewportcheck) at one window size. */
export function runViewportCheck(v) {
  return runPage('viewportcheck', ['--window-size=' + v.size]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--viewport')) {
  // node scripts/browser-selftest.mjs --viewport : only the viewport check, at every size
  let failed = 0;
  for (const v of VIEWPORTS) {
    const res = runViewportCheck(v);
    if (res.skipped) {
      console.log('SKIPPED: no Chrome/Edge/Chromium found (set NETATLAS_BROWSER=/path/to/browser)');
      process.exit(2);
    }
    const bad = res.error ? [{ name: res.error, detail: '' }] : res.failed;
    console.log(`${bad.length ? 'FAIL' : 'ok  '}  ${v.name} (window ${v.size.replace(',', 'x')}, page viewport ${res.window || '?'}): ${res.total || 0} states`);
    for (const c of bad) console.log(`        ${c.name}  -- ${c.detail}`);
    failed += bad.length;
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: viewport check at ${VIEWPORTS.length} window sizes`);
  process.exit(failed ? 1 : 0);
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    for (const d of res.downloads.filter((x) => !/\.png$/.test(x.name))) writeFileSync(join(dir, d.name.replace(/[^A-Za-z0-9._-]/g, '_')), d.text);
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

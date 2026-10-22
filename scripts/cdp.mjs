// Drives dist/netatlas.html (or any page) in a headless Chrome/Edge/Chromium
// through the DevTools protocol over a pipe (--remote-debugging-pipe): no
// network port and no third-party package. Real pointer, touch and keyboard
// input, so :hover, :focus-visible and the browser's own focus handling are
// what a user gets. DNS resolution is disabled, as in the self-test. Used by
// scripts/manual-screenshots.mjs and the browser tests.
//
// With NETATLAS_DIAG_DIR set (scripts/run-tests.mjs sets it per test file),
// every page records the console errors and uncaught exceptions of the page,
// and on close() writes them with a screenshot of what the page showed last
// to that directory; the runner keeps them only for a failed file.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findBrowser } from './browser-selftest.mjs';

let pages = 0;

/** A mouse, as on a desktop, also where the machine has no pointing device (CI's Linux runners): (hover: hover), (pointer: fine). */
export const MOUSE = '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4';

/** The browser's product and version (e.g. "Chrome/141.0.7390.54"), from the DevTools protocol; fails after 30 s. */
export async function browserVersion() {
  const b = launch();
  let timer;
  try {
    const v = await Promise.race([b.send('Browser.getVersion'), new Promise((_ok, fail) => (timer = setTimeout(() => fail(new Error('no answer within 30 s')), 30000)))]);
    return v.product;
  } finally {
    clearTimeout(timer);
    await b.close();
  }
}

/** A headless browser on a pipe: send() a DevTools command; the listeners get its events. */
function launch() {
  const browser = findBrowser();
  if (!browser) throw new Error('no Chrome/Edge/Chromium found (set NETATLAS_BROWSER=/path/to/browser)');
  const profile = mkdtempSync(join(tmpdir(), 'netatlas-cdp-'));
  const proc = spawn(
    browser,
    ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars', '--host-resolver-rules=MAP * ~NOTFOUND', MOUSE, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  const toBrowser = proc.stdio[3];
  const fromBrowser = proc.stdio[4];
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  let buf = '';
  // a browser that dies (e.g. without a usable sandbox) fails what waits for it, with the end of what it printed,
  // instead of an unhandled error on its pipe
  let stderr = '';
  let gone = null;
  proc.stdio[2].on('data', (d) => (stderr = (stderr + d.toString('utf8')).slice(-2000)));
  const died = (why) => {
    if (gone) return;
    gone = new Error(`the browser ${browser} ${why}${stderr.trim() ? ':\n' + stderr.trim() : ''}`);
    for (const { fail } of pending.values()) fail(gone);
    pending.clear();
  };
  proc.on('error', (e) => died(`could not start (${e.message})`));
  proc.on('exit', (code, signal) => died(`exited (${signal || 'code ' + code})`));
  toBrowser.on('error', () => died('closed its pipe'));
  fromBrowser.on('error', () => died('closed its pipe'));
  fromBrowser.on('data', (d) => {
    buf += d.toString('utf8');
    let at;
    while ((at = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else ok(msg.result);
      } else if (msg.method) for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      if (gone) return fail(gone);
      const id = nextId++;
      pending.set(id, { ok, fail });
      toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  const close = async () => {
    try {
      await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      /* already gone */
    }
    proc.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files briefly */
    }
  };
  return { send, listeners, close };
}

/**
 * A page in a headless browser, driven through the DevTools protocol (--remote-debugging-pipe).
 * observe: also record every request the page makes (page.requests), from before the first navigation.
 */
export async function openPage(url, { width = 1440, height = 900, dark = false, observe = false, diag = true } = {}) {
  const { send, listeners, close: quit } = launch();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (method, params) => send(method, params, sessionId);
  await cmd('Page.enable');
  const diagDir = diag && process.env.NETATLAS_DIAG_DIR ? process.env.NETATLAS_DIAG_DIR : null;
  const problems = [];
  if (diagDir) {
    listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') problems.push({ kind: 'exception', text: m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text });
      else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'assert')) problems.push({ kind: 'console.' + m.params.type, text: m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ') });
      else if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) problems.push({ kind: 'log.' + m.params.entry.level, text: m.params.entry.text, source: m.params.entry.source, url: m.params.entry.url });
    });
    await cmd('Runtime.enable');
    await cmd('Log.enable');
  }
  const requests = [];
  const violations = [];
  if (observe) {
    // every request this page's target makes, however it ends (a CSP or DNS failure included); the browser's
    // own background traffic (updates, safe browsing) belongs to no page and is never reported here
    listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Network.requestWillBeSent') requests.push({ id: m.params.requestId, url: m.params.request.url, type: m.params.type || '', initiator: m.params.initiator ? m.params.initiator.type : '' });
      else if (m.method === 'Network.loadingFailed') {
        const r = requests.find((x) => x.id === m.params.requestId);
        if (r) r.failed = m.params.blockedReason || m.params.errorText;
      } else if (m.method === 'Log.entryAdded' && (m.params.entry.source === 'security' || /Content Security Policy/i.test(m.params.entry.text))) violations.push({ text: m.params.entry.text, url: m.params.entry.url || '' });
    });
    await cmd('Network.enable');
    await cmd('Log.enable');
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  const loaded = new Promise((ok) => listeners.push((m) => m.method === 'Page.loadEventFired' && ok()));
  await cmd('Page.navigate', { url });
  await loaded;

  const page = {
    cmd,
    /** a command to the browser itself (not to the page's target) */
    browser: (method, params) => send(method, params),
    /** the requests the page made, and the Content Security Policy reports of its console (with observe: true) */
    requests,
    violations,
    /** evaluate an expression in the page (awaiting a promise) and return its JSON value */
    async eval(expr) {
      const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
      return r.result.value;
    },
    /** call a function in the page with arguments passed as values (nothing of them becomes page code); its JSON value */
    async call(fn, ...args) {
      const g = await cmd('Runtime.evaluate', { expression: 'globalThis' });
      const r = await cmd('Runtime.callFunctionOn', { objectId: g.result.objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${fn.name || 'call'}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
      return r.result.value;
    },
    /** let the page render (two animation frames and a short pause) */
    settle: (ms = 60) => page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ${ms}))))`),
    /** the bounding box of the first element matching a selector */
    rect: (sel) => page.call((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel),
    async mouse(type, x, y, button = 'none') {
      await cmd('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
    },
    async click(sel, button = 'left') {
      const r = await page.rect(sel);
      if (!r) throw new Error('nothing matches ' + sel);
      const x = r.x + r.w / 2;
      const y = r.y + r.h / 2;
      await page.mouse('mouseMoved', x, y);
      await page.mouse('mousePressed', x, y, button);
      await page.mouse('mouseReleased', x, y, button);
      await page.settle();
    },
    async hover(sel) {
      const r = await page.rect(sel);
      if (!r) throw new Error('nothing matches ' + sel);
      await page.mouse('mouseMoved', r.x + r.w / 2, r.y + r.h / 2);
      await page.settle();
    },
    /** a key press; modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift */
    async key(key, code = key, keyCode = 0, modifiers = 0) {
      const text = modifiers & 6 ? undefined : key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
      await cmd('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, text });
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await page.settle();
    },
    /** a tap on a touch screen (with touch emulation on) */
    async tap(sel) {
      const r = await page.rect(sel);
      if (!r) throw new Error('nothing matches ' + sel);
      const p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.settle(80);
    },
    async type(text) {
      await cmd('Input.insertText', { text });
      await page.settle();
    },
    /** a WebP screenshot of a part of the page (CSS pixels), clipped to the window */
    async shot(clip, { scale = 1, quality = 82 } = {}) {
      const x = Math.max(0, Math.floor(clip.x));
      const y = Math.max(0, Math.floor(clip.y));
      const w = Math.min(width - x, Math.ceil(clip.w));
      const h = Math.min(height - y, Math.ceil(clip.h));
      const r = await cmd('Page.captureScreenshot', { format: 'webp', quality, clip: { x, y, width: w, height: h, scale } });
      return Buffer.from(r.data, 'base64');
    },
    async close() {
      if (diagDir) {
        // what the page showed last and what it complained about, for a failed test (bounded: one small WebP per page)
        const n = ++pages;
        try {
          mkdirSync(diagDir, { recursive: true });
          const r = await cmd('Page.captureScreenshot', { format: 'webp', quality: 60 });
          writeFileSync(join(diagDir, `page-${process.pid}-${n}.webp`), Buffer.from(r.data, 'base64'));
        } catch {
          /* the page may be gone already */
        }
        try {
          const at = await page.eval('location.href').catch(() => url);
          writeFileSync(join(diagDir, `page-${process.pid}-${n}.json`), JSON.stringify({ url: at, width, height, dark, problems: problems.slice(0, 200) }, null, 1));
        } catch {
          /* nothing to keep */
        }
      }
      await quit();
    },
  };
  return page;
}

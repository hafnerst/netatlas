// Drives dist/netatlas.html (or any page) in a headless Chrome/Edge/Chromium
// through the DevTools protocol over a pipe (--remote-debugging-pipe): no
// network port and no third-party package. Real pointer, touch and keyboard
// input, so :hover, :focus-visible and the browser's own focus handling are
// what a user gets. DNS resolution is disabled, as in the self-test. Used by
// scripts/manual-screenshots.mjs and test/quick-actions.test.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findBrowser } from './browser-selftest.mjs';

/** A page in a headless browser, driven through the DevTools protocol (--remote-debugging-pipe). */
export async function openPage(url, { width = 1440, height = 900, dark = false } = {}) {
  const browser = findBrowser();
  if (!browser) throw new Error('no Chrome/Edge/Chromium found (set NETATLAS_BROWSER=/path/to/browser)');
  const profile = mkdtempSync(join(tmpdir(), 'netatlas-cdp-'));
  const proc = spawn(
    browser,
    ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars', '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const toBrowser = proc.stdio[3];
  const fromBrowser = proc.stdio[4];
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  let buf = '';
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
      const id = nextId++;
      pending.set(id, { ok, fail });
      toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (method, params) => send(method, params, sessionId);
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  const loaded = new Promise((ok) => listeners.push((m) => m.method === 'Page.loadEventFired' && ok()));
  await cmd('Page.navigate', { url });
  await loaded;

  const page = {
    cmd,
    /** evaluate an expression in the page (awaiting a promise) and return its JSON value */
    async eval(expr) {
      const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
      return r.result.value;
    },
    /** let the page render (two animation frames and a short pause) */
    settle: (ms = 60) => page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ${ms}))))`),
    /** the bounding box of the first element matching a selector */
    rect: (sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`),
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
      try {
        await send('Browser.close');
      } catch {
        /* already gone */
      }
      proc.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* the browser may still hold files briefly */
      }
    },
  };
  return page;
}

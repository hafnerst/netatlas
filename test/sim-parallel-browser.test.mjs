// Parallel exchanges on screen and the three-row simulation panel, with
// real input (headless Chrome/Edge/Chromium through the DevTools
// protocol; skipped without one): several dots of different protocols in
// flight at once at the start; the log groups the events of one moment
// (a ditto mark, the time for assistive technology) and lists what waits
// with its reason; the packet inspector says what a message waited for
// and what caused it; the panel is by default its header and exactly
// three rows of the status and three of the log, measured, at 100 %,
// 150 % and 200 % zoom, in a narrow window and in both themes; that is
// also its minimum; it is remembered under its new key and a double-click
// resets it; the diagram stays the largest part and the page never
// scrolls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(page, example) {
  await page.settle(150);
  const ex = `${example}.yaml`;
  await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.fit(), true`);
  await page.settle(150);
}

/** The rows of a table's area wholly in view under its column headings (null: the area is not shown). */
const ROWS = `(() => {
  const vis = (id) => {
    const a = document.getElementById(id);
    if (!a || !a.getClientRects().length) return null;
    const b = a.getBoundingClientRect();
    const th = a.querySelector('thead');
    const top = b.top + (th ? th.getBoundingClientRect().height : 0);
    const bottom = b.top + a.clientHeight;
    return Array.from(a.querySelectorAll('tbody tr')).filter((r) => { const q = r.getBoundingClientRect(); return q.top >= top - 1.5 && q.bottom <= bottom + 1.5; }).length;
  };
  const de = document.documentElement;
  return { dock: document.getElementById('sim-dock').getBoundingClientRect().height, canvas: document.getElementById('canvas-wrap').getBoundingClientRect().height, b: netatlas.dockBounds(),
    status: vis('sim-status-table'), log: vis('sim-log-table'), scroll: de.scrollHeight - de.clientHeight + de.scrollWidth - de.clientWidth };
})()`;

test('at the start, dots of several protocols are in flight at once (not drawn one after another)', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page, 'protocol-simulation');
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(true), true`);
    let most = 0;
    let dots = 0;
    for (let i = 0; i < 40 && most < 4; i++) {
      await wait(150);
      const r = await page.eval(`(() => { const c = netatlas.simController(); const on = c.pacer.items.filter((it) => it.drawn && !it.f.hidden && ['moving', 'transit'].includes(c.pacer.state(it).phase)); return { protocols: new Set(on.map((it) => it.f.protocol)).size, dots: document.querySelectorAll('#canvas .sim-dot').length }; })()`);
      most = Math.max(most, r.protocols);
      dots = Math.max(dots, r.dots);
    }
    assert.ok(most >= 4, `dots of ${most} protocols on their way together`);
    assert.ok(dots >= 4, `${dots} dots drawn at once`);
  } finally {
    await page.close();
  }
});

test('the log groups the events of one moment and says what waits for what; the packet inspector says what a message waited for and what caused it', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page, 'protocol-simulation');
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(13000), true`);
    await page.settle(300);
    const L = await page.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('#sim-log-table tbody tr'));
      const same = rows.filter((r) => r.classList.contains('sim-t-same'));
      const s = same[0];
      return { first: rows.filter((r) => r.classList.contains('sim-t-first')).length, same: same.length,
        ditto: s ? s.querySelector('td .sim-ditto').getAttribute('aria-hidden') + '|' + s.querySelector('td .sim-ditto').textContent : '',
        sr: s ? s.querySelector('td .sr-only').textContent : '', prev: s ? s.previousElementSibling.cells[0].textContent : '',
        waits: rows.filter((r) => r.getAttribute('data-kind') === 'wait').map((r) => r.cells[6].textContent) };
    })()`);
    assert.ok(L.first > 0 && L.same > 0, JSON.stringify(L).slice(0, 300));
    assert.equal(L.ditto, 'true|〃', 'a ditto mark, hidden from assistive technology');
    assert.match(L.sr, /^\d+\.\d{6} \(the same moment\)$/, 'the time for a screen reader');
    // the log's own filter finds the waits and their reasons
    await page.eval(`(() => { const f = document.getElementById('sim-log-filter'); f.value = 'waiting'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await page.settle(300);
    const W = await page.eval(`Array.from(document.querySelectorAll('#sim-log-table tbody tr')).map((r) => r.getAttribute('data-kind') + '|' + r.cells[6].textContent)`);
    // (a state that waits says so too: BGP Active waiting for the IGP)
    const waitRows = W.filter((x) => /^wait\|/.test(x));
    assert.ok(waitRows.length > 3 && waitRows.every((x) => /wait(s|ing)? for /.test(x)), W.slice(0, 5).join('\n'));
    assert.ok(W.some((x) => /BGP OPEN to .* waiting for TCP/.test(x)) || W.some((x) => /waiting for ARP/.test(x)), W.join('\n').slice(0, 600));
    // the packet inspector: a BGP OPEN waited for its TCP connection, caused by the SYN-ACK
    const seq = await page.eval(`(() => { const e = netatlas.simController().sim.events().find((x) => x.kind === 'message' && x.what === 'OPEN' && x.hdr && x.hdr.waited); return e ? e.seq : -1; })()`);
    assert.ok(seq >= 0);
    await page.eval(`netatlas.simController().inspectEvent(${seq}), true`);
    await page.settle(200);
    const T = await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"]').textContent`);
    assert.match(T, /Timing/);
    assert.match(T, /Waited forTCP connection to 10\.\d+\.\d+\.\d+:179: /);
    assert.match(T, /Caused byBGP TCP \[S,A\] \(sent by \w+\), received at t = \d+\.\d{6} s/);
  } finally {
    await page.close();
  }
});

for (const dark of [false, true]) {
  test(`the simulation panel (${dark ? 'dark' : 'light'} theme): its header and exactly three rows of the status and of the log at 100 %, 150 % and 200 % zoom and in a narrow window; the diagram stays the largest part`, { skip, timeout: 300000 }, async () => {
    // a 1920 × 1080 window at 100 %, 150 % and 200 % (its CSS pixels), and a narrow one (the tables behind tabs)
    for (const [w, h, z] of [[1920, 1080, 1], [1280, 720, 1.5], [960, 540, 2], [800, 640, 1]]) {
      const page = await openPage(url, { width: w, height: h, dark });
      try {
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: z, mobile: false });
        await load(page, 'enterprise-wan');
        // (the theme button: dark is the default)
        await page.eval(`document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(dark ? 'dark' : 'light')} && document.getElementById('theme-btn').click(), true`);
        await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(30000), true`);
        await page.settle(400);
        assert.equal(await page.eval(`document.documentElement.getAttribute('data-theme')`), dark ? 'dark' : 'light');
        const r = await page.eval(ROWS);
        const at = `${w}×${h} at ${z * 100} %: ${JSON.stringify(r)}`;
        assert.ok(Math.abs(r.dock - r.b.min) < 1.5 && r.b.dflt === r.b.min, `by default its minimum: ${at}`);
        assert.equal(r.status, 3, `three status rows: ${at}`);
        if (r.log === null) {
          // narrow: the log behind its tab, three rows there too, the panel's height the same
          await page.eval(`document.getElementById('sd-tab-log').click(), true`);
          await page.settle(250);
          const l = await page.eval(ROWS);
          assert.equal(l.log, 3, `three log rows (its tab): ${JSON.stringify(l)}`);
          assert.ok(Math.abs(l.dock - r.dock) < 1.5, 'the tabs keep the height');
        } else assert.equal(r.log, 3, `three log rows: ${at}`);
        assert.ok(r.canvas > r.dock, `the diagram is the largest part: ${at}`);
        assert.equal(r.scroll, 0, `the page does not scroll: ${at}`);
      } finally {
        await page.close();
      }
    }
  });
}

test('the panel’s three rows are its minimum; remembered under its new key (not the old one); a double-click and Enter reset it', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page, 'enterprise-wan');
    await page.eval(`localStorage.setItem('netatlas.simPanelHeight', '400'), netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(30000), true`);
    await page.settle(300);
    const H = `document.getElementById('sim-dock').getBoundingClientRect().height`;
    const b = await page.eval(`netatlas.dockBounds()`);
    const h0 = await page.eval(H);
    assert.ok(Math.abs(h0 - b.min) < 1.5, `the old key's 400 px is ignored: ${h0}`);
    await page.eval(`document.getElementById('dock-splitter').focus(), true`);
    await page.key('ArrowUp', 'ArrowUp', 38);
    const h1 = await page.eval(H);
    assert.ok(Math.abs(h1 - h0 - 20) < 2);
    assert.equal(await page.eval(`Number(localStorage.getItem('netatlas.simPanelHeight3'))`), Math.round(h1));
    assert.equal(await page.eval(`localStorage.getItem('netatlas.simPanelHeight')`), '400', 'the old key is left alone');
    // never lower than three rows
    for (let i = 0; i < 10; i++) await page.key('ArrowDown', 'ArrowDown', 40);
    assert.ok(Math.abs((await page.eval(H)) - b.min) < 1.5);
    assert.equal(await page.eval(`(${ROWS}).log`), 3);
    await page.key('End', 'End', 35);
    assert.ok(Math.abs((await page.eval(H)) - b.min) < 1.5);
    // taller, then a double-click: the default, the key removed
    await page.key('ArrowUp', 'ArrowUp', 38, 8);
    assert.ok((await page.eval(H)) > b.min + 60);
    const sp = await page.rect('#dock-splitter');
    const [x, y] = [sp.x + sp.w / 2, sp.y + sp.h / 2];
    await page.mouse('mouseMoved', x, y);
    for (const clickCount of [1, 2]) {
      await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
      await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
    }
    await page.settle(100);
    assert.ok(Math.abs((await page.eval(H)) - b.dflt) < 1.5, 'the default again');
    assert.equal(await page.eval(`localStorage.getItem('netatlas.simPanelHeight3')`), null);
    // Enter, too
    await page.eval(`document.getElementById('dock-splitter').focus(), true`);
    await page.key('ArrowUp', 'ArrowUp', 38);
    await page.key('Enter', 'Enter', 13);
    assert.ok(Math.abs((await page.eval(H)) - b.dflt) < 1.5);
  } finally {
    await page.close();
  }
});

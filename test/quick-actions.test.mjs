// The quick actions of the object list (Duplicate, Delete on a row) with real
// input in a headless Chrome/Edge/Chromium: pointer hover, keyboard focus and
// touch, which the in-page self-test cannot produce (:hover, :focus-visible,
// hover: none). What the actions do is checked there as well, against the
// Edit tab. Skipped when no Chromium-based browser is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const row = (ref) => `#outline-body .ol-item[data-ref="${ref}"]`;
/** the rows whose quick actions are shown, by the ref of their entry */
const SHOWN = `[...document.querySelectorAll('#outline-body .ol-row')].filter((r) => getComputedStyle(r.querySelector('.ol-quick')).display !== 'none').map((r) => r.querySelector('.ol-item').getAttribute('data-ref'))`;
const STATE = `({ sel: netatlas.session.state.selected, devices: netatlas.mdoc.entities('device').map((e) => e.id).join(','), dirty: netatlas.mdoc.dirty, dialog: document.getElementById('modal').open, focus: document.activeElement.getAttribute('data-ref') || document.activeElement.getAttribute('aria-label') || document.activeElement.id })`;

async function start(opts) {
  const page = await openPage(url, opts);
  await page.eval(`netatlas.loadExample(0), netatlas.setView('physical'), true`);
  await page.settle(150);
  return page;
}

test('pointer: only the row under the pointer shows Duplicate and Delete; they act without selecting their row', { skip, timeout: 120000 }, async () => {
  const page = await start({ width: 1440, height: 900 });
  try {
    assert.equal(await page.eval(`matchMedia('(hover: hover)').matches`), true);
    await page.click(row('device:hq-rtr1'));
    assert.equal((await page.eval(STATE)).sel, 'device:hq-rtr1');
    // nothing hovered (the pointer on the diagram): no row shows them, not even the selected one
    await page.mouse('mouseMoved', 700, 600);
    await page.settle();
    assert.deepEqual(await page.eval(SHOWN), []);
    // moving from row to row: always exactly the row under the pointer
    for (const ref of ['device:hq-fw', 'device:hq-core1', 'device:hq-rtr1', 'device:isp1-pe']) {
      await page.hover(row(ref));
      assert.deepEqual(await page.eval(SHOWN), [ref], ref);
    }
    // the shown buttons sit inside the row, beside the entry, and the entry's label stays readable
    const geo = await page.eval(`(() => { const r = document.querySelector('${row('device:isp1-pe')}').closest('.ol-row'); const b = r.querySelector('.ol-quick').getBoundingClientRect(); const rr = r.getBoundingClientRect(); const l = r.querySelector('.ol-label'); return { inside: b.left >= rr.left && b.right <= rr.right + 0.5 && b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5, label: l.getBoundingClientRect().width, full: l.scrollWidth <= l.clientWidth, btns: b.width }; })()`);
    assert.ok(geo.inside && geo.label > 100 && geo.full && geo.btns < 70, JSON.stringify(geo));
    // a click on Duplicate of another row: the copy is added and selected, the row's own entry is never selected
    await page.hover(row('device:hq-fw'));
    await page.click(`${row('device:hq-fw')} ~ .ol-quick [data-act="dup-entity"]`);
    let s = await page.eval(STATE);
    assert.equal(s.sel, 'device:hq-fw2');
    assert.match(s.devices, /hq-fw,hq-fw2,/);
    assert.equal(s.dirty, true);
    // undo and redo from the keyboard
    await page.key('z', 'KeyZ', 90, 2);
    assert.doesNotMatch((await page.eval(STATE)).devices, /hq-fw2/);
    await page.key('y', 'KeyY', 89, 2);
    assert.match((await page.eval(STATE)).devices, /hq-fw2/);
    // Delete on another row asks first; Cancel keeps the model and the selection
    await page.click(row('device:hq-rtr1'));
    await page.hover(row('device:hq-rtr2'));
    await page.click(`${row('device:hq-rtr2')} ~ .ol-quick [data-act="del-entity"]`);
    s = await page.eval(STATE);
    assert.equal(s.dialog, true);
    assert.equal(await page.eval(`document.getElementById('modal-title').textContent`), 'Delete device “hq-rtr2”?');
    await page.click('#modal [data-value="cancel"]');
    s = await page.eval(STATE);
    assert.equal(s.sel, 'device:hq-rtr1');
    assert.match(s.devices, /hq-rtr2/);
    // … and Delete deletes it
    await page.hover(row('device:hq-rtr2'));
    await page.click(`${row('device:hq-rtr2')} ~ .ol-quick [data-act="del-entity"]`);
    await page.click('#modal [data-value="delete"]');
    s = await page.eval(STATE);
    assert.doesNotMatch(s.devices, /hq-rtr2/);
    assert.equal(s.sel, null);
  } finally {
    await page.close();
  }
});

test('keyboard: the focused row shows its quick actions, Tab reaches them, Enter acts and the focus stays in the list', { skip, timeout: 120000 }, async () => {
  const page = await start({ width: 1440, height: 900 });
  try {
    // put the focus on the Collapse all button, then walk with Tab into the device list
    await page.eval(`document.querySelector('#outline-body [data-act="fold-all"]').focus(), true`);
    const seen = [];
    let focus = null;
    for (let i = 0; i < 40; i++) {
      await page.key('Tab', 'Tab', 9);
      focus = await page.eval(`(() => { const a = document.activeElement; const r = a.closest('.ol-row'); return { act: a.getAttribute('data-act'), label: a.getAttribute('aria-label'), row: r ? r.querySelector('.ol-item').getAttribute('data-ref') : null }; })()`);
      const shown = await page.eval(SHOWN);
      // whatever row has the focus is the one (and only one) that shows its buttons; elsewhere none is shown
      assert.deepEqual(shown, focus.row ? [focus.row] : [], JSON.stringify(focus));
      seen.push(focus.act);
      if (focus.row === 'device:hq-fw' && focus.act === 'dup-entity') break;
    }
    assert.equal(focus.label, 'Duplicate device hq-fw', 'Tab reaches the quick actions: ' + seen.join(' '));
    // Enter duplicates; the focus moves to the copy, which is selected, and its row shows the actions
    await page.key('Enter', 'Enter', 13);
    let s = await page.eval(STATE);
    assert.equal(s.sel, 'device:hq-fw2');
    assert.equal(s.focus, 'device:hq-fw2');
    assert.deepEqual(await page.eval(SHOWN), ['device:hq-fw2']);
    // Tab, Tab: Delete of the copy; Enter asks, Esc cancels; the focus returns to the Delete button
    await page.key('Tab', 'Tab', 9);
    await page.key('Tab', 'Tab', 9);
    assert.equal((await page.eval(STATE)).focus, 'Delete device hq-fw2');
    await page.key('Enter', 'Enter', 13);
    assert.equal((await page.eval(STATE)).dialog, true);
    await page.key('Escape', 'Escape', 27);
    s = await page.eval(STATE);
    assert.equal(s.dialog, false);
    assert.match(s.devices, /hq-fw2/);
    assert.equal(s.focus, 'Delete device hq-fw2');
    // the keyboard focus ring is visible on the focused button
    assert.match(await page.eval(`getComputedStyle(document.activeElement).outlineStyle`), /solid/);
  } finally {
    await page.close();
  }
});

test('touch: no hover, so tapping a row selects it and shows its quick actions; Delete still asks first', { skip, timeout: 120000 }, async () => {
  const page = await start({ width: 900, height: 700 });
  try {
    await page.cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.settle();
    assert.equal(await page.eval(`matchMedia('(hover: none)').matches`), true);
    assert.deepEqual(await page.eval(SHOWN), []);
    await page.tap(row('device:hq-core2'));
    assert.equal((await page.eval(STATE)).sel, 'device:hq-core2');
    assert.deepEqual(await page.eval(SHOWN), ['device:hq-core2']);
    await page.tap(row('device:hq-acc1'));
    assert.deepEqual(await page.eval(SHOWN), ['device:hq-acc1']);
    await page.tap(`${row('device:hq-acc1')} ~ .ol-quick [data-act="del-entity"]`);
    assert.equal((await page.eval(STATE)).dialog, true);
    await page.tap('#modal [data-value="delete"]');
    const s = await page.eval(STATE);
    assert.doesNotMatch(s.devices, /hq-acc1/);
    assert.equal(s.dialog, false);
  } finally {
    await page.close();
  }
});

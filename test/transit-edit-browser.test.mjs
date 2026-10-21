// Structured editing of a System's opaque transit in the browser (headless
// Chrome/Edge/Chromium through the DevTools protocol; skipped without one):
// a port made opaque in the Edit tab, a transit group added there, its
// membership edited (ports added and removed), a referenced port and device
// renamed (the group and the interconnects follow), undo, the group removed,
// export and reload — all through the Edit tab's controls, not YAML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

const START = `netatlas: 1
title: fabric
devices:
  - id: fsw
    type: system
    purpose: host
    interfaces: [{id: f1, stack: opaque}, {id: f2, stack: opaque}, {id: f3, stack: opaque}, {id: mgmt}]
  - {id: a, type: server, interfaces: [{id: p0, stack: opaque}]}
  - {id: b, type: server, interfaces: [{id: p0, stack: opaque}]}
interconnects:
  - {id: la, topology: point_to_point, technology: {name: SRIO}, endpoints: [{port: "a:p0"}, {port: "fsw:f1"}]}
  - {id: lb, topology: point_to_point, technology: {name: SRIO}, endpoints: [{port: "b:p0"}, {port: "fsw:f2"}]}
`;

test('a System’s transit groups through the Edit tab: an opaque port made, a group added, its ports added and removed, renames followed, undo, removed, exported and reloaded', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(START)}, 'fabric.yaml'), netatlas.setView('physical'), true`);
    await page.settle(200);
    const yaml = () => page.eval('netatlas.exportText()');
    const sel = async () => {
      await page.eval(`netatlas.select('device:fsw'), netatlas.showTab && netatlas.showTab('edit'), true`);
      await page.settle(150);
    };
    const q = (s) => `document.querySelector('#side ${s.replace(/'/g, "\\'")}')`;
    const change = (s, v) => page.eval(`(() => { const e = ${q(s)}; if (!e) throw new Error('no ${s.replace(/'/g, '')}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const click = (s) => page.eval(`(() => { const e = ${q(s)}; if (!e) throw new Error('no ${s.replace(/'/g, '')}'); e.click(); return true; })()`);
    const P = (p) => `[data-p='${JSON.stringify(p)}']`;
    await sel();
    // the group is offered on a System; its management port made opaque in the Edit tab (the Port stack select)
    assert.ok(await page.eval(`!!${q('[data-what="transit group"]')}`), 'the Opaque transit group is there');
    await change(`select${P(['devices', 0, 'interfaces', 3, 'stack'])}`, 'opaque');
    await page.settle(150);
    assert.match(await yaml(), /\{id: mgmt, stack: opaque\}/);
    // a transit group added, and its ports chosen
    await sel();
    await click('[data-what="transit group"]');
    await page.settle(150);
    await sel();
    const add = (port) => change(`select${P(['devices', 0, 'opaque_transit', 0, 'ports'])}`, port);
    await add('f1');
    await sel();
    await add('f2');
    await sel();
    await add('f3');
    await page.settle(150);
    let m = await page.eval(`JSON.stringify(netatlas.session.model.index.devices.get('fsw').opaqueTransit.map((g) => g.ports))`);
    assert.deepEqual(JSON.parse(m), [['f1', 'f2', 'f3']]);
    // the choices offered are its opaque ports only (not a network port)
    await sel();
    const offered = await page.eval(`Array.from(${q(`select${P(['devices', 0, 'opaque_transit', 0, 'ports'])}`)}.options).map((o) => o.value).filter((x) => x)`);
    assert.deepEqual(offered, ['mgmt']);
    // a port removed from the group
    await click(`[data-member="f3"] button`);
    await page.settle(150);
    m = await page.eval(`JSON.stringify(netatlas.session.model.index.devices.get('fsw').opaqueTransit.map((g) => g.ports))`);
    assert.deepEqual(JSON.parse(m), [['f1', 'f2']]);
    assert.match(await yaml(), /opaque_transit:/);
    // a referenced port renamed, then the device: the group and the interconnect follow
    await page.eval(`netatlas.select('iface:fsw:f1'), true`);
    await page.settle(150);
    await change(`input${P(['devices', 0, 'interfaces', 0, 'id'])}`, 'lane1');
    await page.settle(150);
    let y = await yaml();
    assert.match(y, /ports: \[lane1, f2\]/);
    assert.match(y, /"fsw:lane1"/);
    await sel();
    await change(`input${P(['devices', 0, 'id'])}`, 'fabric');
    await page.settle(150);
    y = await yaml();
    assert.match(y, /"fabric:lane1"/);
    assert.match(y, /ports: \[lane1, f2\]/);
    // undo, twice: the device and the port as they were
    await page.eval('netatlas.undo(), netatlas.undo(), true');
    await page.settle(150);
    y = await yaml();
    assert.match(y, /id: fsw\b/);
    assert.match(y, /"fsw:f1"/);
    assert.match(y, /ports: \[f1, f2\]/);
    // the group removed, and back with undo
    await sel();
    await click(`[aria-label="Delete transit group 1"]`);
    await page.settle(150);
    // (an emptied list stays written empty, as the editor's other lists: no group)
    assert.doesNotMatch(await yaml(), /ports: \[/);
    assert.equal(await page.eval(`netatlas.session.model.index.devices.get('fsw').opaqueTransit.length`), 0);
    await page.eval('netatlas.undo(), true');
    await page.settle(150);
    assert.match(await yaml(), /ports: \[f1, f2\]/);
    // exported and reloaded: the same group, no errors, and data passes through it only
    const text = await yaml();
    await page.eval(`netatlas.loadText(netatlas.exportText(), 'again.yaml'), true`);
    await page.settle(200);
    const again = JSON.parse(await page.eval(`JSON.stringify({ g: netatlas.session.model.index.devices.get('fsw').opaqueTransit.map((g) => g.ports), text: netatlas.exportText() })`));
    assert.deepEqual(again.g, [['f1', 'f2']]);
    assert.equal(again.text, text);
  } finally {
    await page.close();
  }
});

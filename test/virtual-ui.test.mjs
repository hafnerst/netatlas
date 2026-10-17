// Hypervisors, VMs and containers in the Edit tab, with real input
// (headless Chrome/Edge/Chromium through the DevTools protocol; skipped
// without one): the Services card's Hypervisor with its configuration; + VM
// on a host, the new VM's Host picker first and focused, offering only the
// hypervisors; + Virtual NIC with its host's port groups; the suggestion of
// the port group of its address's VLAN; unticking a service with guests asks
// first; + Container and its network attachment with the next free address.
// Every step is undone (the toolbar's Undo) to the file as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

async function edit(page, ref) {
  await page.eval(`netatlas.select(${JSON.stringify(ref)}), netatlas.showTab('edit'), true`);
  await page.settle(150);
}

/** A real click on an element of the Inspector, scrolled into view first. */
async function press(page, sel) {
  await page.eval(`(() => { document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`);
  await page.settle(60);
  await page.click(sel);
  await page.settle(150);
}

/** Choose an option of a select (as the keyboard or the mouse would: its value, then change). */
async function choose(page, sel, value) {
  await page.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.focus(); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await page.settle(150);
}

const options = (sel) => `Array.from(document.querySelector(${JSON.stringify(sel)}).options).map((o) => o.value).filter((v) => v)`;

test('the Edit tab: a hypervisor’s card, + VM with its Host picker, + Virtual NIC with the host’s port groups, the port group of its VLAN suggested; unticking asks; + Container with the next free address', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = 'virtualization.yaml';
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), true`);
    await page.settle(200);
    const before = await page.eval(`netatlas.exportText()`);
    // the hypervisor's card: ticked, its configuration collapsible
    await edit(page, 'device:hv1');
    assert.equal(await page.eval(`document.querySelector('#side-body input[data-act="netsvc"][data-svc="hypervisor"]').checked`), true);
    assert.ok(await page.eval(`!!document.querySelector('#side-body details[data-svc-card="hypervisor"] > summary')`));
    // + VM (a real click): a new VM on hv1, selected; its first field, Host, has the focus and offers the hypervisors only
    await press(page, '#side-body button[data-act="add-guest"][data-type="vm"]');
    const sel = await page.eval(`netatlas.session.state.selected`);
    assert.match(sel, /^device:/);
    const id = sel.slice(7);
    const hostSel = `#side-body select[aria-label="Host of ${id}"]`;
    assert.deepEqual(await page.eval(options(hostSel)), ['hv1', 'hv2']);
    assert.equal(await page.eval(`document.querySelector(${JSON.stringify(hostSel)}).value`), 'hv1');
    assert.match(await page.eval(`netatlas.exportText()`), new RegExp(`- id: ${id}\\n    type: vm\\n    host: hv1\\n`));
    // moved to hv2 with the picker
    await choose(page, hostSel, 'hv2');
    assert.match(await page.eval(`netatlas.exportText()`), new RegExp(`- id: ${id}\\n    type: vm\\n    host: hv2\\n`));
    // + Virtual NIC: its port group picker offers hv2's port groups
    await press(page, '#side-body button[data-act="add-logical"][data-kind="vnic"], #side-body button[data-type="vnic"]');
    const pgSel = await page.eval(`(() => { const s = document.querySelector('#side-body select[aria-label^="Port group of ${id} "]'); return s ? '#side-body select[aria-label="' + s.getAttribute('aria-label') + '"]' : ''; })()`);
    assert.ok(pgSel, 'a port group picker');
    assert.deepEqual(await page.eval(options(pgSel)), ['Mgmt', 'vMotion', 'Servers', 'Apps', 'VGT', 'Lab']);
    // undo it all: the file as it was
    // (the toolbar's Undo: Ctrl+Z in a select is the select's)
    for (let k = 0; k < 6 && (await page.eval(`netatlas.exportText()`)) !== before; k++) await page.click('#btn-undo');
    assert.equal(await page.eval(`netatlas.exportText()`), before);
    // the port group of its address's VLAN is suggested: web1's eth0 put on Apps (VLAN 20) while its address is in VLAN 10
    await edit(page, 'iface:web1:eth0');
    await choose(page, '#side-body select[aria-label="Port group of web1 eth0"]', 'Apps');
    const chip = '#side-body button[aria-label="Set the port group of web1 eth0 to Servers"]';
    assert.ok(await page.eval(`!!document.querySelector(${JSON.stringify(chip)})`), 'Servers suggested');
    await press(page, chip);
    assert.equal(await page.eval(`netatlas.exportText()`), before, 'the chip puts it back on Servers');
    // unticking the Hypervisor of a host with guests asks first, naming them; Cancel keeps it
    await edit(page, 'device:hv2');
    await press(page, '#side-body input[data-act="netsvc"][data-svc="hypervisor"]');
    const dlg = await page.eval(`(() => { const d = document.querySelector('#modal[open]'); return d ? d.textContent.replace(/\\s+/g, ' ') : ''; })()`);
    assert.match(dlg, /Disable the Hypervisor of “hv2”\?/);
    assert.match(dlg, /app1 \(VM\).*vr1 \(VM\).*lab1 \(VM\)/);
    await page.key('Escape', 'Escape', 27);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.exportText()`), before);
    assert.equal(await page.eval(`document.querySelector('#side-body input[data-act="netsvc"][data-svc="hypervisor"]').checked`), true);
    // + Container on the Docker host, a network attachment on the bridge, the next free address
    await edit(page, 'device:ctr1');
    await press(page, '#side-body button[data-act="add-guest"][data-type="container"]');
    const cid = (await page.eval(`netatlas.session.state.selected`)).slice(7);
    await press(page, '#side-body button[data-act="add-logical"][data-kind="veth"], #side-body button[data-type="veth"]');
    const netSel = await page.eval(`(() => { const s = document.querySelector('#side-body select[aria-label^="Container network of ${cid} "]'); return s ? '#side-body select[aria-label="' + s.getAttribute('aria-label') + '"]' : ''; })()`);
    assert.ok(netSel, 'a network picker');
    assert.deepEqual(await page.eval(options(netSel)), ['bridge', 'lan']);
    await choose(page, netSel, 'bridge');
    const next = await page.eval(`(() => { const b = Array.from(document.querySelectorAll('#side-body button.helper')).find((x) => /next free/i.test(x.title || '')); return b ? b.getAttribute('data-v') : ''; })()`);
    assert.equal(next, '172.17.0.100', 'the lowest free address of the range');
    for (let k = 0; k < 6 && (await page.eval(`netatlas.exportText()`)) !== before; k++) await page.click('#btn-undo');
    assert.equal(await page.eval(`netatlas.exportText()`), before);
  } finally {
    await page.close();
  }
});

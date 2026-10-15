// "Supports Layer 3" on a switch, with real input (headless
// Chrome/Edge/Chromium through the DevTools protocol; skipped without one):
// one short checkbox with its tooltip; on a Layer 2 switch the routing
// protocols are listed in Enable a protocol… but disabled, in a group
// "Requires Layer 3", with the reason, and nothing is suggested; the
// command palette's Enable a protocol says the same; a relation that needs
// Layer 3 offers no Layer 2 switch as an endpoint (and says why); a new
// relation between a Layer 2 switch and a router proposes no Layer 3
// protocol and reports one typed in; ticking the box makes them
// available; unticking it on a configured switch asks first, listing what
// goes, and one undo brings it all back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

async function edit(page, ref) {
  await page.eval(`netatlas.select(${JSON.stringify(ref)}), netatlas.showTab('edit'), true`);
  await page.settle(150);
}

test('Supports Layer 3: the checkbox, the protocols disabled with their reason on a Layer 2 switch, the palette, the endpoint pickers, a new relation; ticking and unticking (with the confirmation and one undo)', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = await page.eval(`Array.from(document.querySelectorAll('#menu-examples [data-example]')).findIndex((b) => /protocol-simulation/.test(b.textContent))`);
    await page.eval(`localStorage.clear(), netatlas.loadExample(${ex}), true`);
    await page.settle(150);
    await edit(page, 'device:acc-sw');
    const f = await page.eval(`(() => { const box = document.querySelector('#side-body input[data-act="layer3"]'); const lab = box.closest('label'); const fld = box.closest('.field');
      const sel = document.querySelector('#side-body select[data-t="enable-service"]'); const og = sel.querySelector('optgroup');
      return { label: lab.textContent.trim(), title: lab.title, checked: box.checked, helps: Array.from(fld.querySelectorAll('.help')).map((h) => h.textContent),
        group: og ? og.label : '', opts: og ? Array.from(og.querySelectorAll('option')).map((o) => o.textContent + '|' + o.disabled) : [],
        enabled: Array.from(sel.options).filter((o) => o.value && !o.disabled).length, why: document.getElementById(sel.getAttribute('aria-describedby')).textContent,
        chips: document.querySelectorAll('#side-body [data-act="enable-service"]').length }; })()`);
    assert.equal(f.label, 'Supports Layer 3');
    assert.equal(f.title, 'Routing, routing protocols, and gateways');
    assert.equal(f.checked, false, 'off by default');
    assert.deepEqual(f.helps, [], 'no explanation beside it');
    assert.equal(f.group, 'Requires Layer 3');
    assert.ok(f.opts.length >= 10 && f.opts.every((o) => /— requires Layer 3\|true$/.test(o)), f.opts.join(', '));
    for (const p of ['OSPF', 'BGP', 'IS-IS', 'EIGRP', 'RIP', 'PIM', 'LDP', 'VRRP', 'HSRP']) assert.ok(f.opts.some((o) => o.indexOf(p) === 0), p);
    assert.equal(f.enabled, 0, 'none can be chosen');
    assert.match(f.why, /require Layer 3: tick Supports Layer 3 above\. Its Layer 2 protocols \(STP, LACP, LLDP, IGMP \/ MLD snooping\) and management routes need nothing more/);
    assert.equal(f.chips, 0, 'nothing suggested');
    // a value that still arrives (a script, a stale form) changes nothing: the reason is said instead
    const yamlBefore = await page.eval(`netatlas.exportText()`);
    await page.eval(`(() => { const sel = document.querySelector('#side-body select[data-t="enable-service"]'); sel.value = 'ospf'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.exportText()`), yamlBefore, 'OSPF is not enabled on a Layer 2 switch');
    assert.match(await page.eval(`document.querySelector('#toast').textContent`), /^Requires Layer 3: acc-sw is a Layer 2 switch/);
    // the command palette's Enable a protocol: the same reason
    assert.equal(await page.eval(`netatlas.protocolTargetBlocked()`), 'Requires Layer 3: acc-sw is a Layer 2 switch (tick Supports Layer 3 in its Edit tab first)');
    // an OSPF relation: no Layer 2 switch offered as an endpoint, and why
    const rel = await page.eval(`netatlas.session.model.relations.find((r) => r.protocol === 'ospf').id`);
    await edit(page, 'relation:' + rel);
    const eps = await page.eval(`(() => { const s = Array.from(document.querySelectorAll('#side-body select[data-t="ep-dev"], #side-body select[data-t="ep-append"]')); return { opts: s.map((x) => Array.from(x.options).map((o) => o.value)), note: (Array.from(document.querySelectorAll('#side-body .ep-list p.muted')).map((p) => p.textContent)[0] || '') }; })()`);
    assert.ok(eps.opts.length >= 3 && eps.opts.every((o) => o.indexOf('acc-sw') < 0 && o.indexOf('core1') >= 0), JSON.stringify(eps.opts));
    assert.match(eps.note, /^Not offered: .*acc-sw.* \(Layer 2 switches; this protocol requires Layer 3 — tick Supports Layer 3 on the switch first\)\.$/);
    // a static-route-free service relation (ssh) offers it
    const ssh = await page.eval(`(() => { const r = netatlas.session.model.relations.find((x) => !['ospf', 'bgp', 'pim', 'vrrp', 'bfd', 'ipsec', 'gre', 'ha-sync'].includes(x.protocol) && x.category === 'service'); return r ? r.id : ''; })()`);
    if (ssh) {
      await edit(page, 'relation:' + ssh);
      assert.ok(await page.eval(`Array.from(document.querySelector('#side-body select[data-t="ep-append"]').options).some((o) => o.value === 'acc-sw')`));
    }
    // a new relation between acc-sw and core1: no Layer 3 protocol proposed; one typed in is reported
    await page.eval(`netatlas.editor.openDraft('relation', [{ device: 'acc-sw' }, { device: 'core1' }]), netatlas.showTab('edit'), true`);
    await page.settle(150);
    const d = await page.eval(`(() => { const i = document.getElementById('draft-protocol'); return Array.from(document.getElementById(i.getAttribute('list')).options).map((o) => o.value); })()`);
    assert.ok(d.length && d.indexOf('ospf') < 0 && d.indexOf('bgp') < 0 && d.indexOf('vrrp') < 0 && d.indexOf('lldp') >= 0, d.join(', '));
    const prob = await page.eval(`(() => { netatlas.editor.draft.values.protocol = 'ospf'; return netatlas.editor.draftProblems().protocol; })()`);
    assert.equal(prob, 'ospf requires Layer 3: acc-sw is a Layer 2 switch (tick Supports Layer 3 in its Edit tab first).');
    await page.eval(`netatlas.editor.cancelDraft(false), true`);
    // ticking it: the protocols can be enabled, the palette's command too
    await edit(page, 'device:acc-sw');
    await page.click('#side-body input[data-act="layer3"]');
    await page.settle(200);
    assert.equal(await page.eval(`netatlas.session.model.index.devices.get('acc-sw').layer3`), true);
    assert.ok(await page.eval(`Array.from(document.querySelector('#side-body select[data-t="enable-service"]').options).filter((o) => o.value && !o.disabled).length >= 10`));
    assert.equal(await page.eval(`netatlas.protocolTargetBlocked()`), '');
    // unticking it on a configured Layer 3 switch: the confirmation lists what goes; one undo brings it back
    await edit(page, 'device:core1');
    const before = await page.eval(`netatlas.yamlText ? netatlas.yamlText() : netatlas.mdoc.exportText()`);
    await page.click('#side-body input[data-act="layer3"]');
    await page.settle(200);
    const dlg = await page.eval(`(() => { const d = document.getElementById('modal'); return { open: d.open, title: d.querySelector('h2') ? d.querySelector('h2').textContent : '', items: Array.from(d.querySelectorAll('.removal-list li')).map((l) => l.textContent) }; })()`);
    assert.equal(dlg.open, true);
    assert.equal(dlg.title, 'Make core1 a Layer 2 switch?');
    assert.ok(dlg.items.some((x) => /protocol OSPF/.test(x)) && dlg.items.some((x) => /^router_id: /.test(x)), dlg.items.join('; '));
    await page.eval(`document.querySelector('#modal [data-value="l2"]').click(), true`);
    await page.settle(200);
    assert.equal(await page.eval(`!!netatlas.session.model.index.devices.get('core1').layer3`), false);
    await page.eval(`netatlas.undo ? netatlas.undo() : netatlas.mdoc.undo(), true`);
    await page.settle(200);
    assert.equal(await page.eval(`netatlas.yamlText ? netatlas.yamlText() : netatlas.mdoc.exportText()`), before, 'one undo step');
  } finally {
    await page.close();
  }
});

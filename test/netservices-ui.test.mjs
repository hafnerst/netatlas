// A server's Services card, with real input (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one): two checkboxes, DHCP
// server and DNS server, off by default; ticking one writes the service and
// shows what it still needs as errors (nothing is chosen for the user); a
// scope added from the card shows its mandatory fields with the input
// helpers' suggestions; a zone lists the records the model's DNS names give,
// read-only; unticking removes the service in one undo step. A routed
// interface has its DHCP relay field, a host its DNS servers. The servers'
// badges and the clients' reserved lease lines are drawn without overlaps.
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
  await page.call((sel) => { document.querySelector(sel).scrollIntoView({ block: 'center' }); return true; }, sel);
  await page.settle(60);
  await page.click(sel);
  await page.settle(150);
}

const CARD = `(() => { const g = document.querySelector('#side-body [data-group="netservices"]'); if (!g) return null;
  const box = (id) => g.querySelector('input[data-act="netsvc"][data-svc="' + id + '"]');
  return { title: g.querySelector('h4').textContent, dhcp: box('dhcp').checked, dns: box('dns').checked, dhcpTitle: box('dhcp').closest('label').title,
    errs: Array.from(g.querySelectorAll('.field-err')).map((e) => e.textContent), cards: Array.from(g.querySelectorAll('[data-card]')).map((c) => c.getAttribute('data-card')),
    labels: Array.from(g.querySelectorAll('label')).map((l) => l.textContent.trim()), chips: Array.from(g.querySelectorAll('.helper-chip, [data-act="helper"]')).map((c) => c.textContent),
    text: g.textContent }; })()`;

test('the Services card: off by default; DHCP and DNS ticked show what they need as errors; a scope with its helpers; a zone with its derived records; unticking is one undo step', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = 'campus-services.yaml';
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), true`);
    await page.settle(150);
    // web is a server without services: the card, both boxes off
    await edit(page, 'device:web');
    let c = await page.eval(CARD);
    assert.ok(c, 'a server has the Services card');
    // (a server's card also offers the Hypervisor and Container engine services)
    assert.equal(c.title, 'Services');
    assert.deepEqual([c.dhcp, c.dns], [false, false], 'both off by default');
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#side-body input[data-act="netsvc"]')).map((b) => b.getAttribute('data-svc') + '=' + b.checked)`), ['dhcp=false', 'dns=false', 'hypervisor=false', 'container_engine=false']);
    assert.match(c.dhcpTitle, /Leases addresses/);
    const before = await page.eval(`netatlas.exportText()`);
    // tick DHCP server (a real click): the service is written, its missing scope is an error
    await press(page, '#side-body input[data-act="netsvc"][data-svc="dhcp"]');
    c = await page.eval(CARD);
    assert.equal(c.dhcp, true);
    assert.match(await page.eval(`netatlas.exportText()`), /id: web[\s\S]*services:\s*\n\s*dhcp:/);
    assert.ok(c.errs.some((e) => /needs a scope/.test(e)), c.errs.join(' | '));
    // add a scope: its mandatory fields are errors until filled in; the helpers suggest values
    await press(page, '#side-body [data-act="add-svc-item"][data-what="scope"]');
    c = await page.eval(CARD);
    assert.equal(c.cards.length, 1);
    assert.ok(['Network *', 'Address range *', 'Default gateway *', 'DNS servers *'].every((l) => c.labels.some((x) => x.indexOf(l) === 0)), c.labels.join(' | '));
    const errs = await page.eval(`(netatlas.mdoc.result.errors || []).map((e) => e.message).filter((m) => /scope 1 of "web"/.test(m))`);
    // (without its network the scope's family is unknown: an IPv4 scope's range, gateway and DNS servers are asked for once it is chosen)
    assert.ok(errs.some((m) => m.indexOf('network') >= 0), errs.join(' | '));
    // the network chosen: range, gateway and DNS servers are suggested (servers, the gateway of the network)
    await page.eval(`(() => { const s = document.querySelector('#side-body [data-group="netservices"] select[data-p*="network"]'); s.value = 'servers'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    const errs4 = await page.eval(`(netatlas.mdoc.result.errors || []).map((e) => e.message).filter((m) => /scope 1 of "web"/.test(m))`);
    assert.ok(['range', 'default gateway', 'DNS servers'].every((w) => errs4.some((m) => m.indexOf(w) >= 0)), errs4.join(' | '));
    c = await page.eval(CARD);
    assert.match(c.text, /10\.10\.30\.1 \(core:Vlan30\)/, 'the gateway is suggested');
    assert.match(c.text, /10\.10\.10\.10 \(srv\)/, 'the DNS server srv is suggested');
    // DNS server: its zone is needed; added and named, it lists the model's DNS names in it, read-only
    await press(page, '#side-body input[data-act="netsvc"][data-svc="dns"]');
    c = await page.eval(CARD);
    assert.equal(c.dns, true, 'DNS server ticked');
    assert.ok(c.errs.some((e) => /needs a zone/.test(e)), c.errs.join(' | '));
    await press(page, '#side-body [data-act="add-svc-item"][data-what="zone"]');
    await page.eval(`(() => { const i = Array.from(document.querySelectorAll('#side-body [data-group="netservices"] input[data-p]')).find((x) => x.getAttribute('data-p').endsWith('"zones",0,"name"]')); i.value = 'campus.example'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    c = await page.eval(CARD);
    assert.match(c.text, /Zone campus\.example/);
    assert.match(c.text, /web\.campus\.example\s*A\s*10\.10\.30\.10/, 'a derived record with its value');
    assert.equal(await page.eval(`document.querySelectorAll('#side-body [data-group="netservices"] .mini-table input').length`), 0, 'derived records are read-only');
    // untick both: the services are gone; one undo brings the DNS server back
    await press(page, '#side-body input[data-act="netsvc"][data-svc="dns"]');
    await press(page, '#side-body input[data-act="netsvc"][data-svc="dhcp"]');
    // (a service's badge changes the box, so the positions shown were written to keep the diagram still; the rest is as before)
    assert.equal((await page.eval(`netatlas.exportText()`)).replace(/\n+layout:[\s\S]*$/, '\n'), before.replace(/\n+layout:[\s\S]*$/, '\n'), 'unticked: the model as before');
    await page.eval(`netatlas.undo(), true`);
    await page.settle(150);
    c = await page.eval(CARD);
    assert.deepEqual([c.dhcp, c.dns], [true, false], 'one undo: the DHCP server is back');
    // the other devices: a Layer 2 switch's Services card offers what it may run (NTP) and lists DHCP disabled with the reason; a host its DNS servers; core's Vlan20 its relay
    await edit(page, 'device:acc');
    const sw = await page.eval(`(() => { const s = document.querySelector('#side-body [data-group="netservices"] select[data-t="add-service"]'); return s ? Array.from(s.options).map((o) => (o.disabled ? '-' : '+') + o.value + ' ' + o.textContent) : null; })()`);
    assert.ok(sw && sw.some((x) => /^\+ntp /.test(x)) && sw.some((x) => /^-dhcp DHCP server — a Layer 2 switch routes nothing/.test(x)) && !sw.some((x) => /^-?separation/.test(x)), JSON.stringify(sw));
    assert.equal(await page.eval(`!!document.querySelector('#side-body [data-group="netservices"] input[data-svc="dhcp"]')`), false, 'no DHCP box on a Layer 2 switch');
    await edit(page, 'device:pc1');
    assert.equal(await page.eval(`!!document.querySelector('#side-body [data-group="dnsclient"]')`), true, 'a host has its DNS servers');
    await edit(page, 'iface:core:Vlan20');
    assert.match(await page.eval(`document.querySelector('#side-body').textContent`), /DHCP relay \(helper addresses\)[\s\S]*10\.10\.10\.10/);
  } finally {
    await page.close();
  }
});

test('the diagram: DHCP and DNS badges on the server, a reserved lease line on each DHCP client, filled during a simulation; nothing overlaps', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = 'campus-services.yaml';
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.fit(), true`);
    await page.settle(200);
    const geo = await page.eval(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }; const dev = document.querySelector('#canvas [data-ref="device:srv"]');
      const badges = Array.from(dev.querySelectorAll('.dev-sub tspan')).filter((t) => /DHCP|DNS/.test(t.textContent)).map((b) => ({ t: b.textContent, r: r(b) }));
      const label = r(dev.querySelector('.dev-label')); const box = r(dev.querySelector('.dev-box'));
      return { badges, label, box }; })()`);
    assert.deepEqual(geo.badges.map((b) => b.t), ['DHCP · DNS'], 'the service badges, a line under its type');
    const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const b of geo.badges) {
      assert.ok(!over(b.r, geo.label), `${b.t} does not touch the label`);
      assert.ok(b.r.left >= geo.box.left && b.r.right <= geo.box.right && b.r.top >= geo.box.top && b.r.bottom <= geo.box.bottom, `${b.t} inside the box: ${JSON.stringify([b.r, geo.box])}`);
    }

    // the reserved line, as wide as a lease: filled in the simulation, the same layout
    const lines = `Array.from(document.querySelectorAll('#canvas [data-field="lease"]')).map((t) => ({ t: t.textContent, w: t.closest('[data-ref]').querySelector('rect').getBoundingClientRect().width, on: t.classList.contains('lease-on') }))`;
    const a = await page.eval(lines);
    assert.equal(a.length, 3);
    await page.eval(`netatlas.startProtocolSimulation({ params: {}, senders: netatlas.session.model.devices.map((d) => d.id) }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(8000), true`);
    await page.settle(300);
    const b = await page.eval(lines);
    assert.deepEqual(b.map((x) => x.t).sort(), ['10.10.10.100/24 (DHCP lease)', '10.10.10.21/24 (DHCP lease)', '10.10.20.100/24 (DHCP lease)']);
    assert.ok(b.every((x) => x.on));
    assert.deepEqual(b.map((x) => x.w), a.map((x) => x.w), 'the entries keep their size: the lease fits the reserved line');
  } finally {
    await page.close();
  }
});

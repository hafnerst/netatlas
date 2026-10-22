// Every create action leaves the new entry ready to fill in: it is selected
// and marked with the Edit tab's selection highlight, its card is open and in
// view, the cursor is in its first editable field with the proposed text
// selected, and the creation is announced (the toast, a polite live region).
// A top-level object is also selected in the diagram and its outline row is
// in view. Undo puts the focus back on what created it (the add button, else
// the parent card or the object's heading), never on the page body; Ctrl+Z
// in the untouched new field takes the create back. Real pointer and keys in
// headless Chrome/Edge/Chromium (DevTools protocol); skipped without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const CTRL = 2;

/** In the page: where the focus is and whether the new entry is ready to fill in. */
const STATE = `(() => {
  const a = document.activeElement;
  const body = document.getElementById('side-body');
  const r = a.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  const mark = body.querySelector('.sel-mark');
  let selected = null;
  try { selected = a.value !== undefined && a.selectionStart !== null ? a.value.slice(a.selectionStart, a.selectionEnd) : null; } catch (e) { selected = null; }
  return {
    tag: a.tagName,
    t: a.getAttribute('data-t'),
    p: a.getAttribute('data-p'),
    act: a.getAttribute('data-act'),
    value: a.value === undefined ? null : a.value,
    selected,
    inSide: body.contains(a),
    inView: body.contains(a) ? r.top >= b.top - 1 && r.bottom <= b.bottom + 1 : null,
    marked: !!mark && (mark.contains(a) || mark.classList.contains('insp-head')),
    markAt: mark ? mark.getAttribute('data-card') || mark.className : null,
    toast: document.getElementById('toast').textContent,
    tab: netatlas.currentTab(),
    diagram: netatlas.session ? netatlas.session.state.selected : null,
    row: (() => { const row = document.querySelector('#outline-body .ol-item.active'); if (!row) return null; const rr = row.getBoundingClientRect(); const ob = document.getElementById('outline').getBoundingClientRect(); return { ref: row.getAttribute('data-ref'), inView: rr.top >= ob.top - 1 && rr.bottom <= ob.bottom + 1 }; })(),
  };
})()`;

async function start() {
  const page = await openPage(url, { width: 1440, height: 900 });
  await page.settle(150);
  return page;
}

/** Load an example (by its file name) and select an object, with the Edit tab open. */
async function open(page, example, ref) {
  await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(example)}), ${ref ? `netatlas.select(${JSON.stringify(ref)}, true), ` : ''}netatlas.showTab('edit'), true`);
  await page.settle(120);
}

/** Press a button the way a keyboard user does: focus it, Enter. */
async function press(page, sel) {
  const ok = await page.call((sel) => { const b = document.querySelector(sel); if (!b) return false; b.scrollIntoView({ block: 'nearest' }); b.focus(); return document.activeElement === b; }, sel);
  assert.ok(ok, 'focusable: ' + sel);
  await page.key('Enter', 'Enter', 13);
  await page.settle(120);
}

const count = (page, expr) => page.eval(expr);

/** The common expectations of an entry just created. */
function ready(s, what, { field, value, text = true } = {}) {
  assert.equal(s.inSide, true, `${what}: the focus is in the Edit tab (${s.tag} ${s.act || ''})`);
  assert.equal(s.tab, 'edit', what);
  assert.equal(s.inView, true, `${what}: the focused field is scrolled into view`);
  assert.equal(s.marked, true, `${what}: marked with the selection highlight (${s.markAt})`);
  if (field) assert.equal(s.t, field, `${what}: the first field (${s.p})`);
  if (value !== undefined) assert.equal(s.value, value, what);
  if (text && s.value) assert.equal(s.selected, s.value, `${what}: the proposed text is selected, so typing replaces it`);
}

/** Ctrl+Z: the create is gone and the focus is on `back` (a selector), never on the body. */
async function undoBack(page, what, back, gone) {
  await page.key('z', 'KeyZ', 90, CTRL);
  await page.settle(120);
  assert.equal(await page.eval(gone), true, `${what}: undone`);
  const ok = await page.call((back) => { const a = document.activeElement; return a !== document.body && a.matches(back); }, back);
  assert.ok(ok, `${what}: after undo the focus is on ${back}, not ${await page.eval(`document.activeElement.outerHTML.slice(0, 120)`)}`);
}

test('+ Add in the outline: every kind of object, selected in the diagram, its row in view, the cursor in its ID; undo returns to + Add', { skip, timeout: 240000 }, async () => {
  const page = await start();
  try {
    await open(page, 'enterprise-wan.yaml', null);
    for (const kind of ['device', 'link', 'network', 'relation', 'group', 'protocol']) {
      const n = await count(page, `netatlas.mdoc.entities('${kind}').length`);
      await press(page, `#outline-body [data-act="add-entity"][data-kind="${kind}"]`);
      const s = await page.eval(STATE);
      ready(s, kind, { field: 'id' });
      assert.match(s.toast, new RegExp(`^Added ${kind} “`), kind);
      assert.ok(s.row && s.row.inView, `${kind}: its outline row is in view`);
      if (kind === 'device') assert.equal(s.diagram, 'device:' + s.value, 'a new device is selected in the diagram');
      // typing replaces the proposed id
      await undoBack(page, kind, `[data-act="add-entity"][data-kind="${kind}"]`, `netatlas.mdoc.entities('${kind}').length === ${n}`);
    }
  } finally {
    await page.close();
  }
});

test('Duplicate (Edit tab and outline): the copy gets the focus in its ID; Ctrl+Z in the untouched field takes it back', { skip, timeout: 120000 }, async () => {
  const page = await start();
  try {
    await open(page, 'enterprise-wan.yaml', 'device:hq-fw');
    await press(page, '#side-body .insp-actions [data-act="dup-entity"]');
    const s = await page.eval(STATE);
    ready(s, 'duplicate', { field: 'id', value: 'hq-fw2' });
    assert.equal(s.diagram, 'device:hq-fw2');
    assert.equal(s.row.ref, 'device:hq-fw2');
    assert.equal(s.row.inView, true);
    assert.match(s.toast, /Duplicated as device “hq-fw2”/);
    // undo from the new field (nothing typed yet): the copy goes, the selection returns to the original
    await undoBack(page, 'duplicate', '[data-act="dup-entity"]', `!netatlas.mdoc.entities('device').some((e) => e.id === 'hq-fw2') && netatlas.session.state.selected === 'device:hq-fw'`);
    // once something is typed, Ctrl+Z is the field's own text undo
    await press(page, '#side-body .insp-actions [data-act="dup-entity"]');
    await page.type('edge-fw');
    await page.key('z', 'KeyZ', 90, CTRL);
    assert.equal(await page.eval(`netatlas.mdoc.entities('device').some((e) => e.id === 'hq-fw2')`), true, 'the copy stays: Ctrl+Z undid the typing');
  } finally {
    await page.close();
  }
});

test('the Inspector: interface, loopback, virtual and tunnel interfaces, a port range, a route and its duplicate, a DNS name', { skip, timeout: 240000 }, async () => {
  const page = await start();
  try {
    await open(page, 'enterprise-wan.yaml', 'device:hq-rtr1');
    const nIf = `netatlas.mdoc.interfaceEntries(3).length`;
    for (const [sel, what, re] of [
      ['[data-act="add-iface"]', 'interface', /^Interface eth\d+ added to hq-rtr1\.$/],
      ['[data-act="add-logical"][data-kind="loopback"]', 'loopback', /^Loopback lo\d+ added to hq-rtr1/],
      ['[data-act="add-logical"][data-kind="virtual"]', 'virtual interface', /^Virtual interface \S+ added to hq-rtr1/],
      ['[data-act="add-logical"][data-kind="tunnel"]', 'tunnel', /^Tunnel interface \S+ added to hq-rtr1/],
    ]) {
      const n = await page.eval(nIf);
      await press(page, '#side-body ' + sel);
      const s = await page.eval(STATE);
      ready(s, what, { field: 'ifid' });
      assert.match(s.toast, re, what);
      assert.match(s.markAt, /^\["devices",3,"(logical_)?interfaces",\d+\]$/, `${what}: its card is the marked selection`);
      assert.match(s.diagram, /^iface:hq-rtr1:/, `${what}: selected in the diagram`);
      await undoBack(page, what, sel, `${nIf} === ${n}`);
    }
    // a port range (a dialog): the first new port is ready
    await press(page, '#side-body [data-act="add-range"]');
    await page.eval(`(() => { const f = document.getElementById('range-from'), t = document.getElementById('range-to'); f.value = 'ge-0/0/10'; t.value = 'ge-0/0/12'; f.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await page.settle();
    await page.click('#modal [data-value="create"]');
    await page.settle(150);
    let s = await page.eval(STATE);
    ready(s, 'port range', { field: 'ifid', value: 'ge-0/0/10' });
    assert.match(s.toast, /^3 ports added to hq-rtr1/);
    await undoBack(page, 'port range', '[data-act="add-range"]', `!netatlas.mdoc.interfaceEntries(3).some((e) => e.id === 'ge-0/0/10')`);
    // a route: the prefix field (empty: nothing to select)
    await press(page, '#side-body [data-act="add-route"]');
    s = await page.eval(STATE);
    ready(s, 'route', { field: 'text', value: '' });
    assert.match(s.p, /^\["devices",3,"routes",0,"prefix"\]$/);
    assert.match(s.toast, /^Route added to hq-rtr1/);
    await undoBack(page, 'route', '[data-act="add-route"]', `netatlas.mdoc.routeEntries(3).length === 0`);
    // a route's duplicate (hq-rtr2 has one)
    await open(page, 'enterprise-wan.yaml', 'device:hq-rtr2');
    await press(page, '#side-body [data-act="dup-route"]');
    s = await page.eval(STATE);
    ready(s, 'duplicated route', { field: 'text', value: '192.0.2.34/32' });
    assert.match(s.markAt, /^\["devices",4,"routes",1\]$/);
    await undoBack(page, 'duplicated route', '[data-act="dup-route"]', `netatlas.mdoc.routeEntries(4).length === 1`);
    // a DNS name (a dialog)
    await press(page, '#side-body [data-act="add-dns"]');
    await page.eval(`(() => { const n = document.getElementById('dns-name'); n.value = 'edge.acme.example'; n.dispatchEvent(new Event('input', { bubbles: true })); const b = document.querySelector('#dns-ifaces input[type=checkbox]'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle();
    await page.click('#modal [data-value="create"]');
    await page.settle(150);
    s = await page.eval(STATE);
    ready(s, 'DNS name', { value: 'edge.acme.example' });
    assert.match(s.toast, /^DNS name “edge\.acme\.example” added to hq-rtr2\.$/);
    await undoBack(page, 'DNS name', '[data-act="add-dns"]', `!netatlas.exportText().includes('edge.acme.example')`);
  } finally {
    await page.close();
  }
});

test('addresses, protocols, interface groups, attributes, endpoints, members and underlays: the new entry is ready; a value committed with Tab keeps the focus where the user put it', { skip, timeout: 240000 }, async () => {
  const page = await start();
  try {
    // an address typed into "+ add" and Enter: the new address is focused and selected
    await open(page, 'enterprise-wan.yaml', 'iface:hq-rtr1:ge-0/0/1');
    const add = `#side-body details.card[open] input.append[data-t="list-append"]`;
    await page.call((add) => { const i = document.querySelector(add); i.scrollIntoView({ block: 'nearest' }); i.focus(); return true; }, add);
    await page.type('10.0.0.9/28');
    await page.key('Enter', 'Enter', 13);
    let s = await page.eval(STATE);
    ready(s, 'address (Enter)', { value: '10.0.0.9/28' });
    assert.match(s.toast, /^Address 10\.0\.0\.9\/28 added\.$/);
    await undoBack(page, 'address', 'input.append[data-t="list-append"]', `!netatlas.exportText().includes('10.0.0.9/28')`);
    // … with Tab: marked, revealed and announced, but the focus is not pulled back
    await page.call((add) => { const i = document.querySelector(add); i.focus(); return true; }, add);
    await page.type('10.0.0.10/28');
    await page.key('Tab', 'Tab', 9);
    s = await page.eval(STATE);
    assert.notEqual(s.value, '10.0.0.10/28', 'Tab moves on: the focus is not taken back to the new address');
    assert.match(s.toast, /^Address 10\.0\.0\.10\/28 added\.$/);
    assert.equal(await page.eval(`!!document.querySelector('#side-body .sel-mark input[value="10.0.0.10/28"]') || [...document.querySelectorAll('#side-body .sel-mark input')].some((i) => i.value === '10.0.0.10/28')`), true, 'the new address is marked');
    // the next free address of a network (a button)
    await open(page, 'enterprise-wan.yaml', 'iface:hq-core1:Vlan10');
    await press(page, '#side-body details.card[open] [data-act="add-next-free"]');
    s = await page.eval(STATE);
    ready(s, 'next free address');
    assert.match(s.value, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
    assert.equal(s.toast.indexOf(`Address ${s.value} from `), 0, s.toast);
    // an attribute: the new key's value is focused
    await open(page, 'enterprise-wan.yaml', 'device:hq-fw');
    // the device's own attributes (not an interface's): its "+ new key" field
    await page.eval(`(() => { const i = [...document.querySelectorAll('#side-body input[data-t="g-newkey"]')].find((x) => /^\\["devices",\\d+,"attrs"\\]$/.test(x.getAttribute('data-p'))); i.closest('details').open = true; i.scrollIntoView({ block: 'nearest' }); i.focus(); return document.activeElement === i; })()`);
    await page.type('rack-unit');
    await page.key('Enter', 'Enter', 13);
    s = await page.eval(STATE);
    ready(s, 'attribute');
    assert.match(s.p, /"attrs","rack-unit"\]$/);
    assert.match(s.toast, /^Attribute “rack-unit” added — enter its value\.$/);
    // a protocol from Enable a protocol… (a choice): its card is focused
    await open(page, 'enterprise-wan.yaml', 'device:isp2-pe');
    await page.eval(`(() => { const sel = document.querySelector('#side-body select[data-t="enable-service"]'); sel.scrollIntoView({ block: 'nearest' }); sel.focus(); sel.value = 'ospf'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    s = await page.eval(STATE);
    assert.equal(s.inSide, true);
    assert.equal(s.inView, true, 'the protocol is in view');
    assert.match(s.toast, /^OSPF enabled on isp2-pe/);
    assert.equal(s.marked, true, 'the protocol is marked');
    // a protocol suggestion chip (consistency-checks: r3 uses OSPF without enabling it)
    await open(page, 'consistency-checks.yaml', 'device:r3');
    await press(page, '#side-body [data-act="enable-service"][data-svc="ospf"]');
    s = await page.eval(STATE);
    assert.deepEqual({ inSide: s.inSide, inView: s.inView, marked: s.marked }, { inSide: true, inView: true, marked: true }, 'the enabled protocol is ready' + ' ' + JSON.stringify(s));
    assert.match(s.toast, /^OSPF enabled on r3/);
    // a VRRP group on an interface (a button)
    await open(page, 'enterprise-wan.yaml', 'iface:hq-core1:Ethernet1');
    const grp = await page.eval(`!!document.querySelector('#side-body [data-act="iface-svc-on"]')`);
    if (grp) {
      await press(page, '#side-body [data-act="iface-svc-on"]');
      s = await page.eval(STATE);
      ready(s, 'interface group');
      assert.match(s.p, /"protocols","vrrp",/);
    }
    // a relation's endpoint and underlay (choices), a LAG's member port (a choice)
    await open(page, 'enterprise-wan.yaml', 'relation:ospf-hq-area0');
    await page.eval(`(() => { const sel = document.querySelector('#side-body select[data-t="ep-append"]'); sel.scrollIntoView({ block: 'nearest' }); sel.focus(); sel.value = 'isp2-pe'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    s = await page.eval(STATE);
    ready(s, 'endpoint', { text: false });
    assert.match(s.p, /^\["relations",\d+,"endpoints",5/);
    assert.match(s.toast, /^Endpoint isp2-pe added\.$/);
    await page.eval(`(() => { const sel = document.querySelector('#side-body select[data-t="over-append"]'); sel.scrollIntoView({ block: 'nearest' }); sel.focus(); sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    s = await page.eval(STATE);
    assert.deepEqual({ inSide: s.inSide, inView: s.inView, marked: s.marked }, { inSide: true, inView: true, marked: true }, 'the underlay is ready' + ' ' + JSON.stringify(s));
    assert.match(s.toast, /^Underlay \S+ added\.$/);
    await open(page, 'enterprise-wan.yaml', 'iface:hq-core1:Port-Channel1');
    await page.eval(`(() => { const sel = document.querySelector('#side-body select[data-t="member-append"]'); sel.scrollIntoView({ block: 'nearest' }); sel.focus(); sel.value = 'Ethernet1'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(150);
    s = await page.eval(STATE);
    assert.deepEqual({ inSide: s.inSide, inView: s.inView, marked: s.marked }, { inSide: true, inView: true, marked: true }, 'the member port is ready' + ' ' + JSON.stringify(s));
    assert.match(s.toast, /^Member port Ethernet1 added\.$/);
  } finally {
    await page.close();
  }
});

test('Connect in the diagram: the new link opens in the Edit tab with the focus on its first field; X no longer fails anything', { skip, timeout: 120000 }, async () => {
  const page = await start();
  try {
    await open(page, 'enterprise-wan.yaml', null);
    await page.eval(`netatlas.startConnection('iface:hq-acc1:Gi1/0/1') || netatlas.startConnection('device:muc-ap'), true`);
    await page.eval(`netatlas.setView('physical'), netatlas.startConnection('device:hq-log'), netatlas.completeConnection('device:muc-ap'), true`);
    await page.settle(120);
    // the draft's ID has the focus; Enter creates the link
    assert.equal(await page.eval(`document.activeElement.id`), 'draft-id');
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    const s = await page.eval(STATE);
    ready(s, 'connected link', { field: 'id' });
    assert.match(s.toast, /^Added physical link “/);
    assert.equal(s.diagram, 'link:' + s.value);
    // X on a selected cable: nothing (no scenarios; nothing fails outside a simulation)
    await page.eval(`netatlas.select('link:l-hq-isp1'), true`);
    await page.eval(`document.getElementById('canvas').focus(), true`);
    await page.key('x', 'KeyX', 88);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simulationOn() || !document.getElementById('mb-sim').hidden`), false);
  } finally {
    await page.close();
  }
});

test('reduced motion: the new entry is scrolled into view at once (no smooth scrolling)', { skip, timeout: 120000 }, async () => {
  const page = await start();
  try {
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await open(page, 'enterprise-wan.yaml', 'device:hq-core1');
    // record how the Edit tab scrolls
    await page.eval(`(() => { window.__scrolls = []; const o = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (a) { window.__scrolls.push(a && a.behavior); return o.call(this, a); }; return true; })()`);
    await press(page, '#side-body [data-act="add-route"]');
    const behaviours = await page.eval(`window.__scrolls`);
    assert.ok(behaviours.length > 0 && behaviours.every((b) => b !== 'smooth'), JSON.stringify(behaviours));
    const s = await page.eval(STATE);
    ready(s, 'route (reduced motion)', { field: 'text' });
  } finally {
    await page.close();
  }
});

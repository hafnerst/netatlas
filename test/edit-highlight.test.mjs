// The selection in the Edit tab: the part of the configuration that belongs
// to what is selected is marked (tint, accent bar, a "Selected" tag and
// aria-current), at the most specific level: the field of the line that was
// clicked in the diagram (an address, VLAN, VRF, MAC, tunnel end, member
// ports, cable id, attribute), else the selected interface's card, else the
// object's header. Real input in a headless Chrome/Edge/Chromium through the
// DevTools protocol, in both themes; skipped when no Chromium-based browser
// is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const P = load('diagram/palette.js');
const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** What the Edit tab marks: one entry per marked element. */
const MARKS = `[...document.querySelectorAll('#side-body .sel-mark')].map((e) => {
  const body = document.getElementById('side-body').getBoundingClientRect();
  const r = e.getBoundingClientRect();
  // the field's own path: the shortest one in it (a list's items and buttons have longer ones)
  const ctl = [...e.querySelectorAll('[data-p]')].sort((p, q) => JSON.parse(p.getAttribute('data-p')).length - JSON.parse(q.getAttribute('data-p')).length)[0];
  return {
    kind: e.tagName === 'DETAILS' ? 'card' : e.classList.contains('insp-head') ? 'header' : e.classList.contains('list-row') ? 'row' : e.classList.contains('g-row') ? 'attr' : e.classList.contains('field') ? 'field' : e.className,
    iface: e.getAttribute('data-iface') || undefined,
    field: ctl && e.classList.contains('field') ? JSON.parse(ctl.getAttribute('data-p')).slice(-1)[0] : undefined,
    value: e.classList.contains('list-row') ? e.querySelector('input').value : e.classList.contains('g-row') ? e.querySelector('input.g-key').value : undefined,
    current: e.getAttribute('aria-current'),
    tag: !!e.querySelector('.sel-tag'),
    open: e.tagName === 'DETAILS' ? e.open : !e.closest('details:not([open])'),
    // (a whole interface card can be taller than the panel: its top is what must be in view)
    inView: r.top >= body.top - 1 && (r.bottom <= body.bottom + 1 || (r.height > body.height && r.top < body.top + 40)),
  };
})`;
const clean = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));

/** Click a line of the diagram (it is brought into view first, as Find does). `sel` starting with "&" refines the element with the ref itself. */
async function clickLine(page, ref, sel) {
  await page.eval(`netatlas.select(${JSON.stringify(ref)}, true), netatlas.select(null), window.__scrolls && (window.__scrolls.length = 0), true`);
  await page.settle(60);
  await page.click(`#viewport [data-ref="${ref}"]${sel ? (sel[0] === '&' ? sel.slice(1) : ' ' + sel) : ''}`);
  await page.settle(80);
  return (await page.eval(MARKS)).map(clean);
}

test('each selectable element, from the physical view, the logical view and the object list, marks its own part of the Edit tab, at the most specific level, in both themes', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url);
  try {
    // (scrolled into view at once, so it can be checked right after the click)
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const theme of ['dark', 'light']) {
      await page.eval(`netatlas.theme.set('${theme}'), netatlas.loadExample(6), netatlas.showTab('edit'), true`);
      const one = (marks, want, what) => {
        assert.equal(marks.length, 1, `${theme} ${what}: exactly one mark ${JSON.stringify(marks)}`);
        const m = marks[0];
        assert.ok(m.current === 'true' && m.tag && m.open && m.inView, `${theme} ${what}: aria-current, tag, visible ${JSON.stringify(m)}`);
        for (const k of Object.keys(want)) assert.equal(m[k], want[k], `${theme} ${what}: ${k} ${JSON.stringify(m)}`);
      };
      // ---- physical view
      await page.eval(`netatlas.setView('physical'), true`);
      one(await clickLine(page, 'device:core', '.dev-label'), { kind: 'header' }, 'a device');
      one(await clickLine(page, 'iface:core:xe-0/0/0', null), { kind: 'card', iface: 'xe-0/0/0' }, 'a port (link end)');
      one(await clickLine(page, 'iface:core:xe-0/0/1', 'tspan[data-value="2001:0db8:85a3:0000:0000:8a2e:0370:7334/127"]'), { kind: 'row', value: '2001:0db8:85a3:0000:0000:8a2e:0370:7334/127' }, 'an address of a port');
      one(await clickLine(page, 'iface:core:ge-0/0/3', 'tspan[data-field="vrf"]'), { kind: 'field', field: 'vrf' }, 'a VRF');
      one(await clickLine(page, 'iface:core:ge-0/0/9', 'tspan[data-field="mac"], text[data-field="mac"]'), { kind: 'field', field: 'mac' }, 'a MAC address');
      one(await clickLine(page, 'device:core', '&.dev-addr [data-value="router-id"]'), { kind: 'attr', value: 'router-id' }, "a device's address attribute");
      one(await clickLine(page, 'link:wan', '&.link-label [data-field="cable"]'), { kind: 'field', field: 'cable' }, 'a cable id');
      one(await clickLine(page, 'link:wan', 'path.cable-line'), { kind: 'header' }, 'a link');
      one(await clickLine(page, 'group:branch', '[data-value="site-prefix"]'), { kind: 'attr', value: 'site-prefix' }, "a group's address attribute");
      // ---- logical view
      await page.eval(`netatlas.setView('logical'), true`);
      one(await clickLine(page, 'iface:core:lo0', 'tspan[data-value="2001:db8:ffff:ffff::1/128"]'), { kind: 'row', value: '2001:db8:ffff:ffff::1/128' }, 'a loopback address (dual stack)');
      one(await clickLine(page, 'iface:core:ge-0/0/2.10', '[data-field="vlan"]'), { kind: 'field', field: 'vlan' }, 'a VLAN');
      one(await clickLine(page, 'iface:core:ge-0/0/2.10', '[data-value="vrrp-virtual-ip"]'), { kind: 'attr', value: 'vrrp-virtual-ip' }, 'a VRRP virtual address');
      one(await clickLine(page, 'iface:core:gr-0/0/0.0', '[data-field="destination"]'), { kind: 'field', field: 'destination' }, 'a tunnel destination');
      one(await clickLine(page, 'iface:core:gr-0/0/0.0', '[data-field="source"]'), { kind: 'field', field: 'source' }, 'a tunnel source');
      one(await clickLine(page, 'iface:core:ae0', '[data-field="members"]'), { kind: 'field', field: 'members' }, 'member ports');
      one(await clickLine(page, 'iface:core:ge-0/0/4', '[data-field="dhcp"]'), { kind: 'field' }, 'DHCP');
      one(await clickLine(page, 'iface:core:st0.1', '.if-name'), { kind: 'card', iface: 'st0.1' }, 'a tunnel interface (its name)');
      one(await clickLine(page, 'network:corp', '[data-field="cidr"]'), { kind: 'field', field: 'cidr' }, "a network's prefix");
      one(await clickLine(page, 'network:corp', '.net-label'), { kind: 'header' }, 'a network');
      one(await clickLine(page, 'relation:vrrp', '&.pill [data-value="virtual-ip"]'), { kind: 'attr', value: 'virtual-ip' }, "a relation's virtual address");
      one(await clickLine(page, 'relation:vrrp', '&.pill tspan:not([data-field])'), { kind: 'header' }, 'a relation');
      // ---- the object list: whole objects
      await page.click('#outline .ol-item[data-kind="device"][data-index="2"]');
      await page.settle(80);
      one((await page.eval(MARKS)).map(clean), { kind: 'header' }, 'a device from the object list');
      // nothing selected: no mark
      await page.key('Escape', 'Escape', 27);
      assert.deepEqual(await page.eval(MARKS), [], `${theme}: nothing selected, nothing marked`);
    }
  } finally {
    await page.close();
  }
});

test('the mark: a tint, a 3:1 accent bar and a "Selected" tag (not colour alone); not an error, hover or focus mark, and it leaves those visible', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url);
  try {
    for (const theme of ['dark', 'light']) {
      await page.eval(`netatlas.theme.set('${theme}'), netatlas.loadExample(6), netatlas.showTab('edit'), netatlas.setView('logical'), true`);
      await clickLine(page, 'iface:core:lo0', 'tspan[data-value="10.255.255.1/32"]');
      const look = await page.eval(`(() => {
        const toHex = (v) => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(v); return m ? '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('') : v; };
        const e = document.querySelector('#side-body .sel-mark');
        const cs = getComputedStyle(e);
        const panel = toHex(getComputedStyle(document.getElementById('side')).backgroundColor);
        const bar = /inset 3px 0px 0px (rgb\\([^)]*\\))|(rgb\\([^)]*\\)) 3px 0px 0px 0px inset/.exec(cs.boxShadow);
        const input = e.querySelector('input');
        input.focus();
        const ic = getComputedStyle(input);
        const tag = e.querySelector('.sel-tag');
        return { bg: toHex(cs.backgroundColor), panel, bar: bar ? toHex(bar[1] || bar[2]) : cs.boxShadow, tag: tag.textContent, tagColour: toHex(getComputedStyle(tag).color), tagBg: toHex(getComputedStyle(tag).backgroundColor), border: cs.borderLeftStyle + ' ' + toHex(cs.borderLeftColor), focus: input.matches(':focus') && ic.outlineStyle !== 'none' ? toHex(ic.outlineColor) : 'none', error: getComputedStyle(document.documentElement).getPropertyValue('--error').trim() };
      })()`);
      assert.notEqual(look.bg, look.panel, `${theme}: tinted`);
      assert.ok(P.contrast(look.bar, look.panel) >= 3 && P.contrast(look.bar, look.bg) >= 3, `${theme}: the bar has 3:1 against the panel and the tint ${JSON.stringify(look)}`);
      assert.match(look.tag, /Selected/, 'said in words, not by colour alone');
      assert.ok(P.contrast(look.tagColour, look.tagBg) >= 4.5, `${theme}: the tag is readable`);
      assert.notEqual(look.bar, look.error, 'not the error colour');
      assert.notEqual(look.focus, 'none', `${theme}: the focus ring of a field inside the mark still shows`);
    }
  } finally {
    await page.close();
  }
});

test('scrolling, motion and focus: the mark is scrolled into view only when off screen, smoothly unless reduced motion is preferred, and the focus never moves', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 760 });
  try {
    await page.eval(`netatlas.loadExample(6), netatlas.showTab('edit'), netatlas.setView('logical'), true`);
    // record how the Edit tab scrolls
    await page.eval(`(() => { const orig = Element.prototype.scrollIntoView; window.__scrolls = []; Element.prototype.scrollIntoView = function (o) { window.__scrolls.push(JSON.stringify(o)); return orig.call(this, o); }; return true; })()`);
    const scrolls = () => page.eval(`window.__scrolls.splice(0)`);
    const body = () => page.eval(`document.getElementById('side-body').scrollTop`);
    // the header of a device is at the top: in view already, nothing scrolls
    await page.eval(`window.__scrolls.length = 0, true`);
    await page.click('#outline .ol-item[data-kind="device"][data-index="1"]');
    await page.settle(100);
    assert.deepEqual(await scrolls(), []);
    // an interface far down the device's card list: scrolled into view, smoothly
    await clickLine(page, 'iface:core:xe-0/0/1', '.if-name');
    await page.settle(700);
    let s = await scrolls();
    assert.equal(s.length, 1);
    assert.match(s[0], /"behavior":"smooth"/);
    assert.ok((await page.eval(MARKS))[0].inView);
    // the same again (a re-render, e.g. after an edit): no scrolling
    await page.eval(`netatlas.showTab('edit'), true`);
    await page.settle(80);
    assert.deepEqual(await scrolls(), []);
    // reduced motion: no animation
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.eval(`document.getElementById('side-body').scrollTop = 0, true`);
    await clickLine(page, 'iface:core:ge-0/0/2.20', '.if-name');
    s = await scrolls();
    assert.equal(s.length, 1);
    assert.match(s[0], /"behavior":"auto"/);
    assert.ok((await page.eval(MARKS))[0].inView, 'in view at once');
    // keyboard: choosing an entry of the object list with Enter keeps the focus there while the Edit tab follows
    const before = await body();
    await page.eval(`document.querySelector('#outline .ol-item[data-kind="network"][data-index="4"]').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    assert.equal(await page.eval(`document.activeElement.getAttribute('data-kind') + ':' + document.activeElement.getAttribute('data-index')`), 'network:4', 'the focus stays in the object list');
    assert.deepEqual((await page.eval(MARKS)).map((m) => m.kind), ['header']);
    assert.ok(typeof before === 'number');
    // typing in a field of the selected object: the mark stays, the focus and the text being typed are kept
    await page.eval(`(() => { const i = [...document.querySelectorAll('#side-body input[data-p], #side-body textarea[data-p]')].find((x) => /,"label"\\]$/.test(x.getAttribute('data-p'))); i.focus(); i.select(); return true; })()`);
    await page.type('Corp LAN');
    assert.equal(await page.eval(`document.activeElement.value`), 'Corp LAN');
    assert.deepEqual((await page.eval(MARKS)).map((m) => m.kind), ['header']);
  } finally {
    await page.close();
  }
});

test('the mark follows edits, renames, undo / redo, duplicate, delete, view switches and a reload, and is cleared without a selection', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(6), netatlas.showTab('edit'), netatlas.setView('logical'), true`);
    const marks = async () => (await page.eval(MARKS)).map(clean);
    await clickLine(page, 'iface:core:lo1', 'tspan[data-value="192.0.2.53/32"]');
    assert.deepEqual((await marks()).map((m) => [m.kind, m.value]), [['row', '192.0.2.53/32']]);
    // the address is edited: the same row keeps the mark
    await page.eval(`(() => { const i = document.querySelector('#side-body .sel-mark input'); i.focus(); i.select(); return true; })()`);
    await page.type('192.0.2.54/32');
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    assert.deepEqual((await marks()).map((m) => [m.kind, m.value]), [['row', '192.0.2.54/32']], 'after the edit');
    await page.eval(`netatlas.undo(), true`);
    await page.settle(80);
    assert.deepEqual((await marks()).map((m) => [m.kind, m.value]), [['row', '192.0.2.53/32']], 'after undo');
    await page.eval(`netatlas.redo(), true`);
    await page.settle(80);
    assert.deepEqual((await marks()).map((m) => [m.kind, m.value]), [['row', '192.0.2.54/32']], 'after redo');
    // the other view: the selection and its mark stay
    await page.eval(`netatlas.setView('physical'), true`);
    await page.settle(80);
    assert.deepEqual((await marks()).map((m) => m.kind), ['row'], 'after switching views');
    // the interface is renamed: its card keeps the mark
    await page.eval(`netatlas.setView('logical'), true`);
    await clickLine(page, 'iface:core:gr-0/0/0.0', '.if-name');
    await page.eval(`(() => { const i = [...document.querySelectorAll('#side-body .sel-mark input[data-p]')].find((x) => /,"id"\\]$/.test(x.getAttribute('data-p'))); i.focus(); i.select(); return true; })()`);
    await page.type('gr-0/0/0.9');
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    assert.deepEqual((await marks()).map((m) => [m.kind, m.iface]), [['card', 'gr-0/0/0.9']], 'after the rename');
    assert.equal(await page.eval(`netatlas.session.state.selected`), 'iface:core:gr-0/0/0.9');
    // a device: Duplicate selects the copy (its header is marked); Delete clears the selection and the mark
    await page.eval(`netatlas.select('device:dist'), true`);
    await page.settle(60);
    await page.eval(`document.querySelector('#side-body .insp-head [data-act="dup-entity"]').click(), true`);
    await page.settle(100);
    assert.equal(await page.eval(`netatlas.session.state.selected`), 'device:dist2');
    assert.deepEqual((await marks()).map((m) => m.kind), ['header'], 'after duplicate');
    await page.eval(`document.querySelector('#side-body .insp-head [data-act="del-entity"]').click(), true`);
    await page.settle(80);
    await page.click('#modal [data-value="ok"], #modal .primary, #modal button.danger');
    await page.settle(100);
    assert.equal(await page.eval(`netatlas.session.state.selected`), null);
    assert.deepEqual(await marks(), [], 'after delete');
    // reloading the model starts without a selection, and without a mark
    await page.eval(`netatlas.select('device:core'), true`);
    await page.settle(60);
    assert.equal((await marks()).length, 1);
    await page.eval(`netatlas.loadExample(6), netatlas.showTab('edit'), true`);
    await page.settle(80);
    assert.deepEqual(await marks(), [], 'after a reload');
  } finally {
    await page.close();
  }
});

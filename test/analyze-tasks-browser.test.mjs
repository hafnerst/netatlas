// The Analyze workspace as investigations, with real input (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one): each test is a question asked, its answer understood, its evidence inspected and a next step
// taken — not the existence of controls. Twelve investigations: an application's communication found and checked; an
// indeterminate configured-model answer; a test prepared without sending it; a matching observation attached; a policy
// decision inspected and returned from; a multi-component failure without a hidden form; an affected dependency
// followed into Communication and back; a policy-enforced isolation requirement created; an addressing conflict
// investigated; tasks switched without losing a result's context; evidence opened in a narrow window; an outdated
// pinned result reopened honestly. Then the layouts (desktop, laptop, narrow, 200 %) in both themes: no sideways page
// scroll, the answer and its actions usable, the evidence panel naming what it describes, visible focus. These checks
// are not a full accessibility audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

// pc's application asks srv/web over TCP 80; fw denies it (rule 1)
const APP = `netatlas: 1
title: Analyze tasks
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.0.1.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]
    services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web"}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.0.1.1/24}, {id: out, ip: 10.0.2.1/24}]
    policy:
      default: permit
      rules:
        - {action: deny, proto: tcp, dport: 80}
        - {action: permit, proto: icmp}
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: 10.0.2.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]
    services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80}]}
links:
  - {id: l1, a: "pc:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "srv:eth0"}
`;

// two hosts with the same address on one switched segment: a confirmed conflict
const CONFLICT = `netatlas: 1
title: Address conflict
devices:
  - {id: a, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.5/24}]}
  - {id: b, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.5/24}]}
  - {id: c, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.7/24}]}
  - id: sw
    type: switch
    interfaces: [{id: p1}, {id: p2}, {id: p3}]
networks:
  - {id: lan, label: LAN, cidr: 10.0.0.0/24}
links:
  - {id: l1, a: "a:e0", b: "sw:p1"}
  - {id: l2, a: "b:e0", b: "sw:p2"}
  - {id: l3, a: "c:e0", b: "sw:p3"}
`;

async function waitReady(page) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (await page.eval(`document.readyState === 'complete' && !!window.netatlas`)) return;
    } catch (e) {
      /* navigating */
    }
  }
}

// a real click on an element, scrolled into view first (the panels scroll on their own)
async function press(page, sel) {
  // (the selector is passed as a value: no page code is built from it)
  await page.call((s) => {
    const e = document.querySelector(s);
    if (!e) throw new Error('nothing matches ' + s);
    e.scrollIntoView({ block: 'center' });
    return true;
  }, sel);
  await page.settle(40);
  await page.click(sel);
}

// what the evidence panel says it describes, and what has the keyboard
const EV = `(() => { const d = document.querySelector('#ws-an-right #an-detail, #ws-an-right #an-editor'); const a = document.activeElement; return { kind: d ? d.getAttribute('data-ev-kind') : null, title: (document.getElementById('an-ev-h') || document.getElementById('an-ed-h') || { textContent: '' }).textContent, ctx: (document.querySelector('#ws-an-right [data-an-ev-ctx]') || { textContent: '' }).textContent, sel: netatlas.analyzeSelection(), task: netatlas.analyzeTask(), mode: netatlas.analyzeMode(), active: a.id || a.getAttribute('data-an-item') || a.tagName, tab: document.body.getAttribute('data-panel-tab') }; })()`;
const SIM = `(() => { const c = netatlas.simController(); return JSON.stringify({ t: c ? c.sim.now : null, acts: c ? c.sim.actionCount : null, tests: c ? c.sim.tests().length : null }); })()`;

test('Communication: an application’s communication found and checked; an indeterminate answer understood; a test prepared without sending; a matching observation attached; a policy decision inspected and returned from', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    // (1) find an application's communication from the Overview and check it: the binding is said, the answer once
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('ot-network.yaml'), netatlas.runCommand('analyze.overview'), true`);
    await page.settle(200);
    assert.equal(await page.eval(`netatlas.analysisHistory().length`), 0, 'opening the overview computes nothing');
    await page.click('#ws-an-left [data-an-start-task="communication"]');
    assert.equal(await page.eval(`netatlas.analyzeTask()`), 'communication');
    const opts = await page.eval(`Array.from(document.querySelectorAll('#trace-ends option')).filter((o) => /^hmi/.test(o.value)).map((o) => o.value + ' ' + o.textContent)`);
    assert.ok(opts.some((o) => /^hmi\/poll Application/.test(o)) && opts.some((o) => /^hmi:\S+ Interface/.test(o)), 'the ends are searchable by kind: ' + opts.join(' | '));
    await page.eval(`document.getElementById('trace-from').focus(), true`);
    await page.type('hmi/poll');
    assert.match(await page.eval(`document.getElementById('trace-from-bind').textContent`), /^Binding: application .* on hmi, from its bind interface; with To empty, to its configured peer/);
    assert.match(await page.eval(`document.getElementById('trace-to-bind').textContent`), /configured peer/);
    // (Enter in the field: the form's one primary action, Check communication)
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    const ans = await page.eval(`({ states: document.querySelectorAll('#ws-an-dock #diag-state').length, state: document.getElementById('diag-state').textContent, est: !!document.getElementById('an-established'), limit: (document.getElementById('an-runtime-limit') || { textContent: '' }).textContent, family: document.getElementById('trace-family').options[0].textContent })`);
    assert.deepEqual([ans.states, ans.state, ans.est], [1, '✓ Established', true], 'one answer, then what is established');
    assert.match(ans.limit, /^Runtime limitation: /);
    assert.equal(ans.family, 'Automatic family');
    const ev1 = await page.eval(EV);
    assert.equal(ev1.kind, 'Path', 'the default evidence is the main path, not the runtime limitation');
    assert.match(ev1.ctx, /^Configured model · Selected endpoints · computed \d\d:\d\d:\d\d$/);
    // (2) an indeterminate configured-model answer: the evidence that needs attention first, not the runtime limitation
    await page.eval(`netatlas.loadExampleNamed('private-house.yaml'), netatlas.runCommand('trace.open'), netatlas.setTraceForm({ from: 'laptop', to: 'nas', service: '', family: '' }), netatlas.runTrace(), true`);
    await page.settle(200);
    const ind = await page.eval(EV);
    assert.equal(await page.eval(`document.getElementById('diag-state').textContent`), '? Not established');
    assert.equal(ind.sel, 'layer:address', 'the layer that needs attention is the evidence shown');
    assert.match(await page.eval(`document.getElementById('an-detail').textContent`), /DHCP at runtime/);
    assert.ok(await page.eval(`!!document.getElementById('an-runtime-limit')`), 'the runtime limitation stays visible in the summary');
    // (3) prepare a test without sending it: the simulation's clock, actions and tests unchanged
    await page.eval(`netatlas.loadText(${JSON.stringify(APP)}, 'tasks.yaml'), netatlas.startProtocolSimulation({ params: {} }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(5000), netatlas.simController().refresh(true), true`);
    await page.settle(150);
    await page.eval(`netatlas.select('device:pc', true), netatlas.runCommand('analyze.diagnose'), true`);
    await page.settle(200);
    assert.equal(await page.eval(`document.getElementById('diag').getAttribute('data-state')`), 'blocked');
    const s0 = await page.eval(SIM);
    const prep = await page.eval(`document.getElementById('trace-handoff').textContent`);
    assert.equal(prep, 'Prepare modeled test');
    await press(page, '#trace-handoff');
    assert.equal(await page.eval(SIM), s0, 'preparing sends nothing and moves no clock');
    // (4) attach a matching observation: the application's own run, said as a recorded runtime exchange
    await page.eval(`(() => { const c = netatlas.simController(); const a = c.sim.actApp('pc', 'get', 'event'); if (a.error) throw new Error(a.error); c.runTo(c.sim.now + 6000); c.refresh(true); return true; })()`);
    await page.settle(100);
    await press(page, '#trace-compare');
    await page.settle(150);
    const rt = await page.eval(`({ outcome: document.getElementById('diag-runtime').getAttribute('data-outcome'), ctx: document.querySelector('#ws-an-left .an-ctx-line').textContent, run: document.getElementById('diag-question').textContent })`);
    assert.equal(rt.outcome, 'failed');
    assert.match(rt.ctx, /Recorded runtime exchange: application run #\d+ of pc\/get/);
    // (5) the deciding rule: inspected in the evidence panel, read-only, the rule marked; Close returns to where it was chosen
    const ruleBtn = `#diag-next [data-diag-act="goto"][data-diag-ref^="policy:"]`;
    assert.match(await page.eval(`document.querySelector('${ruleBtn}').textContent`), /^Inspect deciding rule/);
    const s1 = await page.eval(SIM);
    await page.eval(`document.querySelector('${ruleBtn}').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(120);
    const rule = await page.eval(`(() => { const b = document.getElementById('diag-rule'); return { kind: document.getElementById('an-detail').getAttribute('data-ev-kind'), focus: document.activeElement === b, on: Array.from(b.querySelectorAll('li[aria-current="true"]')).map((x) => x.getAttribute('data-rule')) }; })()`);
    assert.deepEqual(rule, { kind: 'Policy decision', focus: true, on: ['1'] });
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal(await page.eval(`document.activeElement.getAttribute('data-diag-ref')`), (await page.eval(`document.querySelector('${ruleBtn}').getAttribute('data-diag-ref')`)), 'Escape lets the evidence go; the focus is back on the action it was opened from');
    assert.equal(await page.eval(SIM), s1, 'inspecting evidence moves no clock and sends nothing');
  } finally {
    await page.close();
  }
});

test('Resilience and Design review: a multi-component failure without a hidden form; an affected dependency followed into Communication and back; a policy-enforced isolation requirement created', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('ot-network.yaml'), true`);
    await page.settle(150);
    // (6) Outage impact straight from the menu: components picked by search, the condition previewed, then analyzed
    await page.click('#analyze-btn');
    await page.click('#btn-whatif');
    assert.deepEqual([await page.eval(`netatlas.analyzeTask()`), await page.eval(`netatlas.analyzeMode()`)], ['resilience', 'outage']);
    assert.equal(await page.eval(`document.activeElement.id`), 'oi-search', 'the picker is where the question starts');
    for (const id of ['edge', 'tap']) {
      await page.type(id);
      await page.settle(60);
      // (Enter adds an exact id only; ↓ then Enter the highlighted match)
      await page.key('Enter', 'Enter', 13);
      await page.settle(80);
    }
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#oi-condition [data-oi-pick]')).map((e) => e.getAttribute('data-oi-pick'))`), ['device:edge', 'device:tap']);
    assert.match(await page.eval(`document.getElementById('oi-counts').textContent`), /^2 explicitly selected components\.$/);
    await press(page, '#oi-go');
    await page.settle(150);
    const sum = await page.eval(`document.getElementById('oi-summary').textContent`);
    assert.match(sum, /^Outage: edge, tapCompared with the same configured architecture without this outage:.*configured dependenc(y becomes|ies become) unavailable/);
    assert.match(await page.eval(`document.querySelector('#ws-an-left .an-ctx-line').textContent`), /Hypothetical outage: edge, tap/);
    // (7) an affected dependency: its evidence, then its communication in Communication; Back returns to it
    const depKey = await page.eval(`document.querySelector('#ws-an-dock [data-change="unavailable"] [data-an-item^="dep:"]').getAttribute('data-an-item')`);
    await press(page, `#ws-an-dock [data-change="unavailable"] .an-pick[data-an-item="${depKey}"]`);
    const dep = await page.eval(EV);
    assert.equal(dep.kind, 'Dependency');
    assert.match(dep.ctx, /Hypothetical outage/);
    assert.match(await page.eval(`document.querySelector('#ws-an-right [data-ev-next="communication"]').textContent`), /without the outage$/, 'the baseline check is said to be one');
    await press(page, '#ws-an-right [data-ev-next="communication"]');
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.analyzeTask()`), 'communication');
    assert.ok(await page.eval(`!!netatlas.currentTrace()`), 'the dependency’s communication is checked');
    assert.match(await page.eval(`document.getElementById('an-back').textContent`), /^← Back to Resilience/);
    await press(page, '#an-back');
    await page.settle(100);
    const back = await page.eval(EV);
    assert.deepEqual([back.task, back.mode, back.sel, back.kind], ['resilience', 'outage', depKey, 'Dependency'], 'Back: the outage, its dependency still selected');
    // (8) a policy-enforced isolation requirement: the editor says it is one; enforcement in the primary fields
    await page.eval(`netatlas.exitWorkspace().then(() => true)`);
    await page.settle(80);
    await page.eval(`netatlas.runCommand('analyze.checks'), true`);
    await page.settle(100);
    await page.click('#dc-add');
    const ed = await page.eval(EV);
    assert.deepEqual([ed.kind, ed.title, ed.active], ['editor', 'New requirement', 'dc-f-name']);
    await page.type('Engineering kept out of the PLC by policy');
    await page.eval(`(() => { const s = document.getElementById('dc-f-expect'); s.value = 'blocked'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(80);
    assert.ok(await page.eval(`!document.getElementById('dc-f-enforce').closest('.dc-adv')`), 'enforcement is a primary field');
    await press(page, '#dc-f-enforce-policy');
    await page.eval(`(() => { const set = (id, v) => { const i = document.getElementById(id); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('dc-f-from', 'eng-ws'); set('dc-f-to', 'plc/registers'); return true; })()`);
    const before = await page.eval(`netatlas.session.model.expectations.length`);
    await press(page, '#an-ed-save');
    await page.settle(100);
    const y = await page.eval(`netatlas.exportText()`);
    assert.match(y, /name: Engineering kept out of the PLC by policy[\s\S]{0,200}enforce: policy/);
    assert.equal(await page.eval(`netatlas.session.model.expectations.length`), before + 1);
    assert.match(await page.eval(`document.querySelector('#ws-an-dock tr[data-exp="engineering-kept-out-of-the-plc-by-policy"]').textContent`), /Not evaluated/, 'saving evaluates nothing');
    assert.equal(await page.eval(`netatlas.simulationOn()`), false, 'and starts no simulation');
    await press(page, '#dc-evaluate');
    await page.settle(150);
    const row = await page.eval(`document.querySelector('#ws-an-dock tr[data-exp="engineering-kept-out-of-the-plc-by-policy"]').textContent`);
    assert.match(row, /(Satisfied|Violated|Indeterminate)/);
    assert.ok(!/Not evaluated/.test(row));
  } finally {
    await page.close();
  }
});

test('Addressing and navigation: an addressing conflict investigated; tasks switched without losing a result’s context; an outdated pinned result reopened honestly', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    // (9) a conflict: Conflicts shows it, its evidence names the owners; nothing is said free in the real network
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(CONFLICT)}, 'conflict.yaml'), netatlas.runCommand('analyze.addressing'), true`);
    await page.settle(150);
    await page.click('[data-addr-issue="conflicts"]');
    assert.equal(await page.eval(`document.querySelector('[data-addr-issue="conflicts"]').getAttribute('aria-checked')`), 'true');
    assert.match(await page.eval(`document.getElementById('addr-summary').textContent`), /1 confirmed conflict/);
    await press(page, '#ws-an-dock [data-addr-list="duplicates"] .an-pick');
    const conf = await page.eval(EV);
    assert.equal(conf.kind, 'Addressing issue');
    assert.match(conf.title, /^Confirmed conflict: 10\.0\.0\.5$/);
    assert.match(await page.eval(`document.getElementById('an-detail').textContent`), /a:e0[\s\S]*b:e0/);
    await page.click('[data-addr-issue="all"]');
    await press(page, '#ws-an-dock tr[data-an-item="net:|lan"] td:nth-child(2)');
    assert.match(await page.eval(`document.getElementById('an-detail').textContent`), /Unallocated in model/);
    // (10) a result in Communication with a hop selected; another task; back: the same result and the same hop
    await page.eval(`netatlas.runCommand('trace.open'), netatlas.setTraceForm({ from: 'a', to: 'c' }), netatlas.runTrace(), true`);
    await page.settle(150);
    const hop = await page.eval(`document.querySelector('#ws-an-dock .why-btn[data-an-item]').getAttribute('data-an-item')`);
    await press(page, `#ws-an-dock .why-btn[data-an-item="${hop}"]`);
    assert.equal(await page.eval(`netatlas.analyzeSelection()`), hop);
    const run0 = await page.eval(`netatlas.currentTrace().check.headline`);
    await press(page, '#ws-an-left [data-an-task="addressing"]');
    assert.equal(await page.eval(`netatlas.analyzeTask()`), 'addressing');
    assert.equal(await page.eval(`netatlas.analyzeSelection()`), 'net:|lan', 'Addressing kept its own selection');
    await press(page, '#ws-an-left [data-an-task="communication"]');
    assert.deepEqual([await page.eval(`netatlas.analyzeSelection()`), await page.eval(`netatlas.currentTrace().check.headline`)], [hop, run0], 'Communication: the same result, the same item');
    // (12) pinned, then outdated by an edit: reopened as it was, said outdated, Refresh offered — never recomputed silently
    await page.eval(`netatlas.runCommand('analyze.overview'), true`);
    await page.settle(100);
    const id = await page.eval(`netatlas.analysisHistory().find((h) => h.task === 'communication').id`);
    await press(page, `#ws-an-dock [data-hist-act="pin"][data-hist-id="${id}"]`);
    assert.equal(await page.eval(`netatlas.analysisHistory().find((h) => h.id === ${id}).pinned`), true);
    await page.eval(`(() => { const d = netatlas.mdoc; d.remove(['links', d.findEntity('link', 'l3').index], 'Remove cable'); netatlas.afterEdit(); return true; })()`);
    await page.settle(100);
    assert.ok(await page.eval(`!!document.querySelector('#ws-an-dock [data-hist="${id}"][data-outdated][data-pinned]')`), 'the overview says the pinned result is outdated');
    assert.match(await page.eval(`document.querySelector('#an-known [data-known="outdated"]').textContent`), /outdated/);
    // (while the overview is in front the path is off the diagram; the result is the entry's)
    assert.equal(await page.eval(`netatlas.currentTrace()`), null);
    const head0 = await page.eval(`netatlas.analysisHistory().find((h) => h.id === ${id}).data.check.headline`);
    await press(page, `#ws-an-dock [data-hist-act="open"][data-hist-id="${id}"]`);
    await page.settle(100);
    const re = await page.eval(`({ task: netatlas.analyzeTask(), sel: netatlas.analyzeSelection(), headline: netatlas.currentTrace().check.headline, outdated: !!document.querySelector('#ws-an-left .an-outdated [data-an-refresh]'), flags: (document.getElementById('diag-flags') || { textContent: '' }).textContent })`);
    assert.deepEqual([re.task, re.sel, re.headline, re.outdated], ['communication', hop, head0, true], 'reopened as computed, with its selection, outdated with Refresh');
    assert.match(re.flags, /Outdated/);
    assert.match(await page.eval(`document.getElementById('an-back').textContent`), /Back to Overview/);
  } finally {
    await page.close();
  }
});

test('(11) evidence in a narrow window: one surface at a time; selecting an item reveals the evidence with its heading focused; Close returns to the results and the item', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 600, height: 800 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('private-house.yaml'), netatlas.runCommand('trace.open'), true`);
    await page.settle(150);
    const tabs = await page.eval(`Array.from(document.querySelectorAll('#sim-paneltabs [role="tab"]')).filter((t) => t.getClientRects().length).sort((a, b) => getComputedStyle(a).order - getComputedStyle(b).order).map((t) => t.textContent)`);
    assert.deepEqual(tabs, ['Question', 'Results', 'Evidence', 'Diagram']);
    assert.equal(await page.eval(`document.body.getAttribute('data-panel-tab')`), 'setup', 'the question first');
    await page.eval(`netatlas.setTraceForm({ from: 'laptop', to: 'nas' }), true`);
    await page.click('#trace-go');
    await page.settle(120);
    assert.equal(await page.eval(`document.body.getAttribute('data-panel-tab')`), 'results', 'the answer comes into view');
    const item = await page.eval(`document.querySelector('#ws-an-dock .an-pick[data-an-item^="layer:path"]').getAttribute('data-an-item')`);
    await page.eval(`document.querySelector('#ws-an-dock .an-pick[data-an-item="${item}"]').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    const ev = await page.eval(EV);
    assert.deepEqual([ev.tab, ev.sel, ev.kind, ev.active], ['actions', item, 'Communication layer', 'an-detail'], 'the evidence tab, its panel focused (no hidden update)');
    assert.ok(await page.eval(`document.getElementById('an-detail').getBoundingClientRect().height > 0`), 'the evidence is shown, not updated in a hidden panel');
    await press(page, '[data-ev-close]');
    const back = await page.eval(EV);
    assert.deepEqual([back.tab, back.active], ['results', item], 'Close: the results again, the keyboard on the item it was opened from');
    assert.equal(await page.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, 'no sideways page scroll');
  } finally {
    await page.close();
  }
});

test('layouts in both themes (desktop, laptop, narrow, 200 %): the answer and its actions usable without sideways page scroll; the evidence panel names what it describes; focus visible; Balanced, Diagram- and Results-focused', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('enterprise-wan.yaml'), true`);
    for (const theme of ['light', 'dark']) {
      await page.eval(`netatlas.theme.set(${JSON.stringify(theme)}), true`);
      for (const [W, H, z] of [[1440, 900, 1], [1280, 720, 1], [600, 800, 1], [1440, 900, 2]]) {
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z, mobile: false });
        await page.settle(100);
        for (const run of [`netatlas.runCommand('trace.open'), netatlas.setTraceForm({ from: 'hq-fw', to: 'hq-log', service: 'udp/514' }), netatlas.runTrace()`, `netatlas.runCommand('analyze.addressing')`, `netatlas.prepareOutage(['domain:hq-rack-a']), netatlas.runOutage()`, `netatlas.runCommand('analyze.findings')`, `netatlas.runCommand('analyze.overview')`]) {
          await page.eval(`(${run}, true)`);
          await page.settle(120);
          const where = `${theme} ${W}×${H} ${z * 100}% ${run.slice(0, 40)}`;
          const narrow = await page.eval(`document.getElementById('spt-setup').getClientRects().length > 0`);
          if (narrow) await page.eval(`document.getElementById('spt-results').click(), true`);
          await page.settle(60);
          const g = await page.eval(`(() => { const d = document.documentElement; const head = document.querySelector('#ws-an-dock .an-dock-head h3'); const dock = document.getElementById('ws-an-dock').getBoundingClientRect(); return { scroll: d.scrollWidth - d.clientWidth, head: head ? head.textContent : '', headIn: !!head && head.getBoundingClientRect().width > 0 && head.getBoundingClientRect().right <= d.clientWidth + 1, dockW: Math.round(dock.width), vw: d.clientWidth }; })()`);
          assert.ok(g.scroll <= 0 && g.headIn, `${where}: ${JSON.stringify(g)}`);
          // the first item of the results shows its evidence, which names what it describes
          const has = await page.eval(`!!document.querySelector('#ws-an-dock [data-an-item]')`);
          if (has) {
            await page.eval(`(() => { const b = document.querySelector('#ws-an-dock .an-pick[data-an-item], #ws-an-dock tr[data-an-item], #ws-an-dock li[data-an-item]'); b.focus(); return true; })()`);
            await page.key('Enter', 'Enter', 13);
            await page.settle(80);
            const ev = await page.eval(EV);
            assert.ok(ev.kind && ev.title && ev.ctx, `${where}: the evidence names its kind, its item and its context ${JSON.stringify(ev)}`);
            const ring = await page.eval(`(() => { const a = document.activeElement; const cs = getComputedStyle(a); return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1; })()`);
            assert.ok(ring, `${where}: the evidence heading shows the keyboard focus`);
            await page.key('Escape', 'Escape', 27);
            await page.settle(60);
          }
          // every button of the workspace has an accessible name
          const unnamed = await page.eval(`Array.from(document.querySelectorAll('#ws-an-left button, #ws-an-dock button, #ws-an-right button')).filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim()).length`);
          assert.equal(unnamed, 0, `${where}: unnamed buttons`);
        }
      }
      // the layouts: the results take more room, or the diagram does
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.eval(`netatlas.runCommand('analyze.addressing'), true`);
      await page.settle(100);
      const h = {};
      for (const l of ['diagram', 'balanced', 'results']) {
        await page.click(`[data-an-layout="${l}"]`);
        h[l] = await page.eval(`Math.round(document.getElementById('sim-dock').getBoundingClientRect().height)`);
        assert.equal(await page.eval(`netatlas.analyzeLayout()`), l);
      }
      assert.ok(h.diagram < h.balanced && h.balanced < h.results, JSON.stringify(h));
      await page.click('[data-an-layout="balanced"]');
    }
  } finally {
    await page.close();
  }
});

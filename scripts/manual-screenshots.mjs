// Takes the screenshots of Help → User Manual from the real application:
// it opens the test build (build/netatlas-test.html: the application, plus the internal test models) in headless Chrome/Edge/Chromium, drives the UI
// into each state (menus open, a device selected, a connection being drawn …)
// with real pointer and keyboard input, and saves cropped WebP images to
// docs/img/manual/. "npm run build" then embeds them (scripts/gen-help.mjs).
//
//   npm run build && node scripts/manual-screenshots.mjs && npm run build
//
// The browser is controlled through the DevTools protocol (scripts/cdp.mjs).
// Set NETATLAS_BROWSER=/path/to/chrome to choose the browser.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// the test build: the released application, which can also load the internal test models some pictures show (npm run build writes it)
const html = resolve(root, 'build', 'netatlas-test.html');
const outDir = join(root, 'docs', 'img', 'manual');

/** a box around some rectangles, with a margin */
const around = (rs, m = 12) => {
  const x = Math.min(...rs.map((r) => r.x)) - m;
  const y = Math.min(...rs.map((r) => r.y)) - m;
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) + m - x, h: Math.max(...rs.map((r) => r.y + r.h)) + m - y };
};

async function main() {
  if (!existsSync(html)) {
    console.error('build/netatlas-test.html not found: run "npm run build" first');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const page = await openPage(pathToFileURL(html).href);
  const saved = [];
  const save = async (name, clip, opts) => {
    const data = await page.shot(clip, opts);
    writeFileSync(join(outDir, name + '.webp'), data);
    saved.push(`${name}.webp ${(data.length / 1024).toFixed(1)} KiB`);
  };
  try {
    // the start screen
    await page.settle(200);
    const start = await page.rect('#empty .start');
    await save('start', around([start], 20));

    // the enterprise WAN example, physical view
    await page.eval('netatlas.loadExample(0), netatlas.setView("physical"), true');
    await page.settle(200);
    await page.key('f', 'KeyF', 70);
    // the File menu
    await page.click('#menu-btn');
    await save('file-menu', around([await page.rect('#menu-btn'), await page.rect('#main-menu')], 10), { quality: 60 });
    await page.key('Escape', 'Escape', 27);
    // the Export menu with its submenu
    await page.click('#export-btn');
    await page.click('#btn-export-as');
    await save('export-menu', around([await page.rect('#export-btn'), await page.rect('#export-menu')], 10));
    await page.key('Escape', 'Escape', 27);
    await page.key('Escape', 'Escape', 27);
    await page.mouse('mouseMoved', 700, 890);
    await page.eval('document.activeElement && document.activeElement.blur(), true');
    await page.settle();

    // the whole window, physical view
    await save('physical', { x: 0, y: 0, w: 1440, h: 900 }, { scale: 0.75, quality: 40 });

    // the logical view of the metro ring example
    await page.eval('netatlas.loadExampleNamed("metro-ring.yaml"), netatlas.setView("logical"), true');
    await page.settle(200);
    await page.key('f', 'KeyF', 70);
    await page.key('+', 'Equal', 187);
    await page.key('+', 'Equal', 187);
    await page.mouse('mouseMoved', 1430, 890);
    {
      // the drawing (not the empty canvas around it), as far as it is on screen
      const c = await page.rect('#canvas-wrap');
      const v = await page.rect('#viewport');
      const x = Math.max(c.x, v.x - 16);
      const y = Math.max(c.y, v.y - 16);
      await save('logical', { x, y, w: Math.min(c.x + c.w, v.x + v.w + 16) - x, h: Math.min(c.y + c.h, v.y + v.h + 16) - y }, { quality: 43 });
    }
    await page.eval('netatlas.loadExample(0), netatlas.setView("logical"), true');
    await page.settle(200);

    // Find in diagram, with matches
    await page.click('#find-btn');
    await page.click('#btn-find');
    await page.type('hq-r');
    await save('find', around([await page.rect('#find-bar'), await page.rect('#search-results')], 12));
    await page.key('Escape', 'Escape', 27);

    // Filter object list
    await page.click('#find-btn');
    await page.click('#btn-outline-filter');
    await page.type('muc');
    const outline = await page.rect('#outline');
    const lastRow = await page.eval(`(() => { const rs = document.querySelectorAll('#outline .ol-item'); const r = rs[rs.length - 1].getBoundingClientRect(); return r.bottom; })()`);
    await save('filter-list', { x: 0, y: outline.y, w: outline.w, h: lastRow - outline.y + 6 });
    await page.key('Escape', 'Escape', 27);

    // the Edit tab of a device
    await page.eval('netatlas.setView("physical"), netatlas.select("device:hq-rtr1", true), true');
    await page.click('[data-tab="edit"]');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(150);
    const side = await page.rect('#side');
    await save('edit', { x: side.x, y: side.y, w: side.w, h: Math.min(560, side.h) });

    // the quick actions on the row under the pointer (a different row than the selected one)
    await page.hover('#outline .ol-item[data-ref="device:hq-fw"]');
    const row = await page.rect('#outline .ol-item[data-ref="device:hq-fw"]');
    const sec = await page.rect('#outline [data-section="device"]');
    await save('quick-actions', { x: 0, y: sec.y - 4, w: outline.w, h: Math.min(row.y + row.h + 70, sec.y + sec.h) - sec.y + 8 });

    // a connection being drawn in the physical view
    await page.key('Escape', 'Escape', 27);
    await page.eval('netatlas.select(null), document.activeElement && document.activeElement.blur(), true');
    await page.key('f', 'KeyF', 70);
    await page.settle(100);
    await page.click('#viewport [data-ref="device:muc-rtr"]', 'right');
    {
      // the dashed line follows the pointer, here over empty background between the branch and headquarters
      const c = await page.rect('#canvas-wrap');
      await page.mouse('mouseMoved', c.x + c.w * 0.27, c.y + c.h * 0.6);
    }
    await page.settle(100);
    await save('connect', around([await page.rect('#canvas-wrap')], 0), { scale: 0.85, quality: 65 });
    await page.key('Escape', 'Escape', 27);

    // the View, Auto-arrange and Filters groups of the toolbar
    await page.mouse('mouseMoved', 700, 890);
    await page.settle();
    await save('toolbar-groups', around([await page.rect('#view-group'), await page.rect('#filters-group')], 8));

    // the addresses of a router in the logical view, at 100 % (addressing example)
    await page.eval('netatlas.loadExampleNamed("addressing.yaml"), netatlas.setView("logical"), netatlas.select("device:core", true), netatlas.select(null), true');
    await page.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform')); netatlas.zoomBy(1 / Number(m[1])); return true; })()`);
    await page.eval('netatlas.select("device:core", true), netatlas.select(null), true');
    await page.mouse('mouseMoved', 700, 890);
    // (a message left over from the connection above is not part of this picture)
    await page.eval("document.getElementById('toast').hidden = true");
    await page.settle(200);
    {
      const c = await page.rect('#canvas-wrap');
      const b = await page.rect('#viewport [data-ref="device:core"] .dev-box');
      const x = Math.max(c.x, b.x - 150);
      const y = Math.max(c.y, b.y - 20);
      await save('addresses', { x, y, w: Math.min(c.x + c.w, b.x + b.w + 150) - x, h: Math.min(c.y + c.h, y + 470) - y }, { quality: 65 });
    }

    // ports: the branch router of the long-labels example at 100 %, GRE and OSPF leaving from the port of Tunnel10
    await page.eval('netatlas.loadExampleNamed("long-labels.yaml"), netatlas.setView("logical"), true');
    await page.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform')); netatlas.zoomBy(1 / Number(m[1])); return true; })()`);
    await page.eval('netatlas.select("device:br-rtr", true), netatlas.select(null), true');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(200);
    {
      const c = await page.rect('#canvas-wrap');
      const b = await page.rect('#viewport [data-ref="device:br-rtr"] .dev-box');
      const x = Math.max(c.x, b.x - 30);
      const y = Math.max(c.y, b.y - 46);
      await save('ports', { x, y, w: Math.min(c.x + c.w, b.x + b.w + 320) - x, h: Math.min(c.y + c.h, b.y + b.h + 40) - y });
    }
    await page.eval('netatlas.loadExampleNamed("addressing.yaml"), netatlas.setView("logical"), true');
    await page.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform')); netatlas.zoomBy(1 / Number(m[1])); return true; })()`);
    await page.eval('netatlas.select("device:core", true), netatlas.select(null), true');
    await page.settle(150);

    // the Edit tab marks what was clicked: an address of an interface (addressing example, logical view)
    await page.eval('netatlas.showTab("edit"), netatlas.select("iface:core:lo0", true), netatlas.select(null), true');
    await page.settle(150);
    await page.click('#viewport [data-ref="iface:core:lo0"] tspan[data-value="2001:db8:ffff:ffff::1/128"]');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(700);
    {
      const card = await page.rect('#side-body details.card[open]');
      const mark = await page.rect('#side-body .sel-mark');
      const side = await page.rect('#side');
      const y = Math.max(side.y, Math.min(card.y, mark.y - 140) - 6);
      await save('edit-mark', { x: side.x, y, w: side.w, h: Math.min(mark.y + mark.h + 24, side.y + side.h) - y });
    }

    // static routes: the branch router of the branch-routing example in the logical view, at 100 %
    const branch = 'branch-routing.yaml';
    await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(branch)}), netatlas.setView("logical"), true`);
    await page.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform')); netatlas.zoomBy(1 / Number(m[1])); return true; })()`);
    await page.eval('netatlas.select("device:br-rtr", true), netatlas.select(null), true');
    await page.mouse('mouseMoved', 700, 890);
    await page.eval("document.getElementById('toast').hidden = true");
    await page.settle(200);
    {
      const c = await page.rect('#canvas-wrap');
      const b = await page.rect('#viewport [data-ref="device:br-rtr"] .dev-box');
      const x = Math.max(c.x, b.x - 120);
      const y = Math.max(c.y, b.y - 30);
      await save('routes', { x, y, w: Math.min(c.x + c.w, b.x + b.w + 120) - x, h: Math.min(c.y + c.h, b.y + b.h + 30) - y }, { quality: 65 });
    }
    // port VLANs: the cable between the branch router (routed, with subinterfaces) and the access switch's trunk, physical view, at 100 %
    await page.eval('netatlas.setView("physical"), true');
    await page.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform')); netatlas.zoomBy(1 / Number(m[1])); return true; })()`);
    await page.eval('netatlas.select("link:br-trunk", true), netatlas.select(null), true');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(200);
    {
      const c = await page.rect('#canvas-wrap');
      const a = await page.rect('#viewport [data-ref="device:br-rtr"] .dev-box');
      const b = await page.rect('#viewport [data-ref="device:br-sw"] .dev-box');
      const r = around([a, b], 24);
      const x = Math.max(c.x, r.x - 60);
      const y = Math.max(c.y, r.y);
      await save('tagging', { x, y, w: Math.min(c.x + c.w, r.x + r.w + 60) - x, h: Math.min(c.y + c.h, r.y + r.h) - y });
    }
    // a trunk port's VLANs in the Edit tab (the VLAN example): the chips, the combobox, the native VLAN, the mode badge
    {
      const vx = 'vlan-ports.yaml';
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(vx)}), netatlas.setView("physical"), netatlas.showTab("edit"), netatlas.select("iface:acc1:Gi1/0/48", true), true`);
      await page.mouse('mouseMoved', 700, 890);
      await page.eval("document.getElementById('toast').hidden = true");
      // the card's VLAN part in the middle of the panel, so its title and the field above it are in the picture
      await page.eval("document.querySelector('#side-body details.card[open] .port-l2[data-port-l2=\"trunk\"]').scrollIntoView({ block: 'center' }), true");
      await page.settle(300);
      const box = await page.rect('#side-body details.card[open] .port-l2[data-port-l2="trunk"]');
      const side = await page.rect('#side');
      const y = Math.max(side.y, box.y - 40);
      await save('port-vlans', { x: side.x, y, w: side.w, h: Math.min(box.y + box.h + 8, side.y + side.h) - y }, { quality: 70 });
    }

    // the Addressing overview of the addressing example, with one network's members open
    {
      const ex = 'addressing.yaml';
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView("logical"), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`localStorage.removeItem('netatlas.window.addressing'), document.getElementById('btn-addressing').click(), document.querySelector('[data-addr-toggle="|corp"]').click(), true`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      const d = await page.rect('#toolwin');
      const sec = await page.rect('#toolwin .addr-vrf');
      await save('addressing', { x: d.x, y: d.y, w: d.w, h: Math.min(d.y + d.h, sec.y + 330) - d.y }, { quality: 70 });
      await page.eval(`netatlas.closeToolWindow(), true`);
      await page.settle(100);
    }

    // focus mode on the firewall (enterprise WAN, physical view), then the command palette with "focus" typed
    {
      await page.eval('netatlas.loadExample(0), netatlas.setView("physical"), netatlas.select("device:hq-fw", true), true');
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', shiftKey: true, bubbles: true })), true`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      const c = await page.rect('#canvas-wrap');
      await save('focus', around([c, await page.rect('#toolwin')], 0), { scale: 0.75, quality: 48 });
      await page.eval(`netatlas.closeToolWindow(), true`);
      await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })), true`);
      await page.settle(150);
      await page.eval(`(() => { const i = document.getElementById('palette-input'); i.value = 'focus'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await page.settle(200);
      await save('palette', around([await page.rect('#modal')], 6), { quality: 70 });
      await page.key('Escape', 'Escape', 27);
      await page.settle(100);
      await page.eval(`document.getElementById('focus-exit').click(), true`);
      await page.settle(100);
    }

    // path trace from the Munich LAN to the syslog server (enterprise WAN, physical view): the diagram and the Trace path window with its hop table
    {
      await page.eval('netatlas.loadExample(0), netatlas.setView("physical"), true');
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`localStorage.removeItem('netatlas.window.trace'), netatlas.setTraceForm({ from: 'muc-rtr:lan0', to: 'hq-log', back: false }), netatlas.openTrace(), netatlas.runTrace(), true`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      const c = await page.rect('#canvas-wrap');
      const w = await page.rect('#toolwin');
      await save('trace', around([c, w], 0), { scale: 0.75, quality: 40 });
      await page.eval(`netatlas.closeToolWindow(), true`);
      await page.settle(100);
    }

    // single points of failure: the window for the enterprise WAN, most impact first
    {
      await page.eval('netatlas.loadExample(0), netatlas.setView("physical"), true');
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`localStorage.removeItem('netatlas.window.spof'), netatlas.openSpof(), true`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(250);
      await save('spof', around([await page.rect('#toolwin')], 6), { quality: 40 });
      await page.eval(`netatlas.closeToolWindow(), true`);
      await page.settle(100);
    }

    // the simulation layout (enterprise-campus.yaml, a public example the manual names): core1's ARP table in the panel
    {
      await page.eval(`netatlas.loadExampleNamed('enterprise-campus.yaml'), netatlas.setView('physical'), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`localStorage.removeItem('netatlas.dockHeight'), sessionStorage.clear(), netatlas.startProtocolSimulation({ senders: ['laptop1', 'srv'] }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(25000), netatlas.select('device:core1'), netatlas.fit(), true`);
      await page.eval(`(() => { const c = netatlas.simController(); c.showTable('arp', 'core1'); for (let i = 0; i < 40; i++) c.advance(25); c.refresh(true); document.getElementById('toast').hidden = true; return true; })()`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      await save('simulation', { x: 0, y: 0, w: 1440, h: 900 }, { scale: 0.65, quality: 28 });
      await page.eval(`netatlas.exitSimulation(), sessionStorage.clear(), true`);
      await page.settle(100);
    }

    // the protocol simulation (protocol-simulation.yaml, an internal test model, physical view): the tables, the packet inspector, a broadcast domain, multicast routes, a device's Simulation section, the start dialog
    {
      await page.eval(`netatlas.loadText(${JSON.stringify(readFileSync(join(root, 'test', 'examples', 'protocol-simulation.yaml'), 'utf8'))}, 'protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`localStorage.removeItem('netatlas.dockHeight'), sessionStorage.clear(), netatlas.startProtocolSimulation({ senders: ['pc1', 'srv'] }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(25000), netatlas.fit(), true`);
      // a moment with messages on their way: the readable pacing for a little real time
      await page.eval(`(() => { const c = netatlas.simController(); c.showTable('arp', 'core1'); for (let i = 0; i < 40; i++) c.advance(25); c.refresh(true); document.getElementById('toast').hidden = true; return true; })()`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      const st = await page.rect('#sd-status');
      await save('arp-table', { x: st.x, y: st.y, w: st.w, h: Math.min(st.h, 300) }, { quality: 55 });
      // the packet inspector for a TCP SYN of pc1's test traffic, with Follow message
      await page.eval(`(() => { const c = netatlas.simController(); c.showStatus(); for (let i = 0; i < 400; i++) { const f = c.sim.engine.flights.find((x) => x.hdr && /^TCP SYN → /.test(x.label) && x.t0 <= c.t && c.t <= x.t1); if (f) { c.refresh(true); return c.inspectFlight(f.id, { x: 380, y: 120, w: 10, h: 10 }); } c.sim.advance(c.t + 5000, (x) => /^TCP SYN → /.test(x.label)); } return false; })()`);
      await page.settle(200);
      await save('packet-inspector', around([await page.rect('.sim-table-panel[data-table="packet"]')], 6), { quality: 55 });
      // the lab host's broadcast domain, highlighted
      await page.eval(`netatlas.simController().tables.closeAll(), netatlas.select('device:lab-sw2', true), netatlas.select(null), netatlas.zoomBy(1.25), netatlas.simController().highlightDomain({ dev: 'lab-h', iface: 'eth0' }), document.getElementById('toast').hidden = true, true`);
      await page.settle(250);
      const lab = [];
      for (const d of ['lab-sw1', 'lab-sw2', 'lab-h']) lab.push(await page.rect(`#canvas .node[data-ref="device:${d}"]`));
      await save('bc-domain', around(lab, 70), { quality: 45 });
      // r1's multicast routes
      await page.eval(`netatlas.simController().clearDomain(), netatlas.simController().runTo(45000), netatlas.simController().showTable('mroute', 'r1'), document.getElementById('toast').hidden = true, true`);
      await page.settle(200);
      const st2 = await page.rect('#sd-status');
      await save('mroutes', { x: st2.x, y: st2.y, w: st2.w, h: Math.min(st2.h, 300) }, { quality: 55 });
      // Network events: the four actions, Send network packets open: unicast from core1 (an interface chosen) to srv, UDP 53, ten messages a second apart
      await page.eval(`(() => { const set = (id, v, ev) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev || 'change')); };
        set('sim-t-type', 'unicast'); set('sim-t-from', 'core1');
        const via = Array.from(document.getElementById('sim-t-via').options).find((o) => o.value && o.value !== '*' && !o.disabled); if (via) set('sim-t-via', via.value);
        set('sim-t-to', 'srv'); set('sim-t-kind', 'udp'); set('sim-t-port', '53', 'input'); set('sim-t-count', '10', 'input'); set('sim-t-interval', '1', 'input');
        document.getElementById('sim-act-net').scrollIntoView({ block: 'start' }); document.getElementById('toast').hidden = true; return true; })()`);
      await page.settle(200);
      const tf = await page.rect('#sim-act-net');
      await save('send-test', { x: tf.x + 2, y: tf.y, w: tf.w - 4, h: Math.min(tf.h, 420) }, { quality: 26 });
      // Active events: the series sent, a join, flapping, then two streams side by side; a few real seconds on (one event each, with their states and progress)
      await page.eval(`(() => { const c = netatlas.simController(); c.startFlap('link:l-rx'); c.joinGroup('pc2', 'eth0', '239.4.4.4', []); const k = document.getElementById('sim-t-kind'); k.value = 'icmp'; k.dispatchEvent(new Event('change')); document.getElementById('sim-t-send').click();
        c.startStream('srv', 'eth0', '239.1.1.1', 5010, 1000, 500); c.startStream('pc2', 'eth0', '239.1.1.1', 5012, 1000, 500); c.setPlaying(true); return true; })()`);
      // (the streams' interval is real time: play for it)
      await new Promise((r) => setTimeout(r, 4500));
      // (taken while playing: In progress)
      await page.eval(`(() => { const c = netatlas.simController(); c.refresh(true); document.getElementById('sim-act-events').scrollIntoView({ block: 'start' }); document.getElementById('toast').hidden = true; return true; })()`);
      await page.settle(200);
      const ae = await page.rect('#sim-act-events');
      await save('active-events', { x: ae.x + 2, y: ae.y, w: ae.w - 4, h: Math.min(ae.h, 225) }, { quality: 24 });
      await page.eval(`(() => { const c = netatlas.simController(); c.setPlaying(false); c.sim.stopRuns(); c.stopFlap('link:l-rx'); c.leaveGroup('pc2', 'eth0', '239.4.4.4'); c.sim.stopStream('srv', 'eth0', '239.1.1.1'); c.sim.stopStream('pc2', 'eth0', '239.1.1.1'); c.runTo(c.t + 6000); return true; })()`);
      // core1's Simulation section in the Actions panel, editable while the simulation runs
      await page.eval(`netatlas.select('device:core1'), true`);
      await page.settle(200);
      await page.eval(`(() => { const b = document.getElementById('fg-simulation'); b.click(); b.scrollIntoView({ block: 'start' }); return true; })()`);
      await page.settle(200);
      const sa = await page.rect('#sim-actions');
      await save('sim-device', { x: sa.x + 2, y: sa.y, w: sa.w - 4, h: Math.min(sa.h, 460) }, { quality: 38 });
      // every device's status in the diagram: lab-h powered off, lab-sw2 booting, lab-sw1 operational
      await page.eval(`(() => { const c = netatlas.simController(); c.powerOff('lab-h'); c.powerOff('lab-sw2'); c.powerOn('lab-sw2'); netatlas.select('link:l-lab-h', true); netatlas.select(null); c.refresh(true); document.getElementById('toast').hidden = true; return true; })()`);
      await page.settle(250);
      const labs = [];
      for (const d of ['lab-sw1', 'lab-sw2', 'lab-h']) labs.push(await page.rect(`#canvas .node[data-ref="device:${d}"]`), await page.rect(`#canvas .sim-power[data-device="${d}"]`));
      await save('device-state', around(labs, 16), { quality: 30 });
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);
      // the start dialog: the protocols first; a modified value in Layer 3, collapsed again
      await page.eval(`sessionStorage.clear(), netatlas.openStartDialog(), true`);
      await page.settle(200);
      await page.eval(`(() => { document.getElementById('sim-pd-l3-btn').click(); const i = document.getElementById('sim-pd-ttl'); i.value = '32'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); document.getElementById('sim-pd-l3-btn').click(); document.getElementById('sim-pd-protos-p-arp').focus(); return true; })()`);
      await page.settle(200);
      await save('sim-start', around([await page.rect('#modal')], 4), { scale: 0.75, quality: 40 });
      // Senders in the dialog: the routers chosen with By type ▾
      await page.eval(`(() => { document.getElementById('sim-pd-senders-bytype').click(); Array.from(document.querySelectorAll('#sim-pd-senders .snd-menuitem')).find((b) => /^Routers/.test(b.textContent)).click(); document.getElementById('sim-pd-senders').scrollIntoView({ block: 'start' }); return true; })()`);
      await page.settle(200);
      await save('senders', around([await page.rect('#sim-pd-senders')], 6), { quality: 50 });
      await page.eval(`document.querySelector('#modal [data-value="cancel"]').click(), sessionStorage.clear(), true`);
      await page.settle(100);
    }

    // Device types ▾ for enterprise-campus.yaml: the Layer 2 switches unticked under Switch
    {
      await page.eval(`netatlas.loadExampleNamed('enterprise-campus.yaml'), netatlas.setView('physical'), document.getElementById('toast').hidden = true, true`);
      await page.settle(150);
      await page.eval(`netatlas.setTypeVisible('switch:l2', false), true`);
      await page.click('#types-btn');
      await page.settle(200);
      await save('device-types', around([await page.rect('#types-btn'), await page.rect('#types-panel')], 8), { quality: 55 });
      await page.key('Escape', 'Escape', 27);
      await page.eval(`netatlas.setTypeVisible('switch:l2', true), true`);
      await page.settle(100);
    }

    // DHCP and DNS (enterprise-campus.yaml): srv's Services card; the simulation with the leases in the diagram and srv's DHCP leases
    {
      const cs = 'enterprise-campus.yaml';
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(cs)}), netatlas.setView("physical"), netatlas.select("device:srv"), netatlas.showTab("edit"), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.settle(200);
      await page.eval(`(() => { const g = document.querySelector('#side-body [data-group="netservices"]'); g.scrollIntoView({ block: 'start' }); return true; })()`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(150);
      const g = await page.rect('#side-body [data-group="netservices"]');
      const sb = await page.rect('#side-body');
      await save('services', { x: g.x - 4, y: Math.max(sb.y, g.y - 4), w: g.w + 8, h: Math.min(sb.y + sb.h - g.y, 520) }, { quality: 45 });
      await page.eval(`localStorage.removeItem('netatlas.dockHeight'), sessionStorage.clear(), netatlas.select(null), netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(9000), netatlas.fit(), true`);
      // srv's leases (the panel high enough for its rows), then the whole diagram with the leases in the clients' lines
      await page.eval(`(() => { const c = netatlas.simController(); c.showTable('dhcp', 'srv'); netatlas.setDockHeight(300); c.refresh(true); return true; })()`);
      await page.settle(200);
      await page.eval(`netatlas.fit(), document.getElementById('toast').hidden = true, true`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      await save('dhcp-sim', { x: 0, y: 0, w: 1440, h: 900 }, { scale: 0.65, quality: 24 });
      await page.eval(`netatlas.exitSimulation(), sessionStorage.clear(), true`);
      await page.settle(100);
    }

    // services and Wi-Fi: ap-b's Wireless access (private-house.yaml), srv's Services card (enterprise-campus.yaml)
    {
      const ex = (name) => `${name}.yaml`;
      const card = async (example, dev, group, name, h, from = `[data-group="${group}"]`) => {
        await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(await ex(example))}), netatlas.setView("physical"), netatlas.select("device:${dev}"), netatlas.showTab("edit"), true`);
        await page.eval("document.getElementById('toast').hidden = true");
        await page.eval(`(() => { const g = document.querySelector('#side-body ${from}'); g.scrollIntoView({ block: 'start' }); return true; })()`);
        await page.mouse('mouseMoved', 700, 890);
        await page.settle(250);
        const g = await page.rect(`#side-body [data-group="${group}"]`);
        const f = await page.rect(`#side-body ${from}`);
        const sb = await page.rect('#side-body');
        const top = Math.max(sb.y, f.y - 4);
        await save(name, { x: g.x - 4, y: top, w: g.w + 8, h: Math.min(sb.y + sb.h - top, g.y + g.h + 4 - top, h) }, { quality: 38 });
      };
      await card('private-house', 'ap-b', 'svc-wireless', 'wifi-edit', 560);
      await card('enterprise-campus', 'srv', 'netservices', 'services-add', 560, '[data-svc-card="ntp"]');
    }

    // the device model: a System's Identity card (ot-network.yaml); the Security gateway (cross-domain.yaml): the diagram, its
    // Domain separation card, and Trace path with a service through its protocol break
    {
      const ex = (name) => `${name}.yaml`;
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(await ex('ot-network'))}), netatlas.setView("physical"), netatlas.select("device:pgw"), netatlas.showTab("edit"), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(250);
      // from its type down to its icon: what the System is
      await page.eval(`(() => { document.querySelector('#side-body select[data-key="type"]').closest('.field').scrollIntoView({ block: 'start' }); return true; })()`);
      await page.settle(150);
      {
        const g = await page.rect('#side-body [data-group="identity"]');
        const t = await page.rect('#side-body select[data-key="type"]');
        const sb = await page.rect('#side-body');
        const top = Math.max(sb.y, t.y - 30);
        await save('device-model', { x: g.x - 4, y: top, w: g.w + 8, h: Math.min(sb.y + sb.h, g.y + g.h + 4) - top }, { quality: 50 });
      }
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(await ex('cross-domain'))}), netatlas.setView("physical"), netatlas.select(null), netatlas.fit(), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(250);
      await save('separation', await page.rect('#canvas-wrap'), { scale: 0.75, quality: 50 });
      await page.eval(`netatlas.select("device:cdg"), netatlas.showTab("edit"), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.eval(`(() => { const g = document.querySelector('#side-body [data-group="separation"]'); g.scrollIntoView({ block: 'start' }); return true; })()`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(250);
      {
        const g = await page.rect('#side-body [data-group="separation"]');
        const sb = await page.rect('#side-body');
        const prof = await page.rect('#side-body .profile-card');
        const top = Math.max(sb.y, g.y - 4);
        await save('separation-edit', { x: g.x - 4, y: top, w: g.w + 8, h: Math.min(sb.y + sb.h, prof.y + prof.h + 8) - top }, { quality: 45 });
      }
      await page.eval(`netatlas.select(null), netatlas.setTraceForm({ from: 'red-ws', to: '10.10.0.1', service: 'tcp/443', back: false }), netatlas.openTrace(), true`);
      await page.settle(150);
      await page.eval(`document.getElementById('trace-go').click(), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      // the window scrolled to the protocol break's note and leg 2
      await page.eval(`(() => { const l = document.querySelector('section.trace-leg'); if (l) l.scrollIntoView({ block: 'end' }); return true; })()`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(300);
      {
        const w = await page.rect('#toolwin');
        await save('separation-trace', { x: w.x - 4, y: w.y - 4, w: w.w + 8, h: w.h + 8 }, { scale: 0.8, quality: 40 });
      }
      await page.eval(`netatlas.exitTrace(), true`);
      await page.settle(100);
    }

    // virtualization (virtualization.yaml): esx-01's interior in the physical view, its Services card with the Hypervisor open,
    // and the simulation after esx-02 was powered off (its VMs restarted on esx-01)
    {
      const vx = 'virtualization.yaml';
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(vx)}), netatlas.setView("physical"), netatlas.select(null), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.settle(200);
      // esx-01 centred, zoomed out until its whole box fits the diagram
      const frame = async (ref, top = 0) => {
        await page.eval(`netatlas.select(${JSON.stringify(ref)}, true), netatlas.select(null), true`);
        await page.settle(150);
        const c = await page.rect('#canvas-wrap');
        const b = await page.rect(`#viewport [data-ref="${ref}"] .dev-box`);
        const f = Math.min(1, ((c.w - 24) / b.w), ((c.h - top - 24) / b.h));
        if (f < 1) await page.eval(`netatlas.zoomBy(${f}), true`);
        // (below a banner over the diagram's top)
        if (top) await page.eval(`netatlas.zoom.ty += ${top / 2 + 6}, netatlas.applyZoom(), true`);
        await page.mouse('mouseMoved', 700, 890);
        await page.settle(250);
        const r = await page.rect(`#viewport [data-ref="${ref}"] .dev-box`);
        const x = Math.max(c.x, r.x - 10);
        const y = Math.max(c.y, r.y - 30);
        return { x, y, w: Math.min(c.x + c.w, r.x + r.w + 10) - x, h: Math.min(c.y + c.h, r.y + r.h + 10) - y };
      };
      await save('virtualization', await frame('device:hv1'), { quality: 55 });
      await page.eval(`netatlas.select("device:hv1"), netatlas.showTab("edit"), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.settle(200);
      await page.eval(`(() => { for (const d of document.querySelectorAll('#side-body details[data-svc-card="hypervisor"]')) d.open = true; const f = document.querySelector('#side-body input[data-svc="hypervisor"]').closest('.field'); f.scrollIntoView({ block: 'start' }); return true; })()`);
      await page.mouse('mouseMoved', 700, 890);
      await page.settle(200);
      {
        const g = await page.rect('#side-body [data-group="netservices"]');
        const sb = await page.rect('#side-body');
        const f = await page.rect('#side-body .field:has(> label > input[data-svc="hypervisor"])');
        const vms = await page.rect('#side-body [data-derived="guests-vm"]');
        const top = Math.max(sb.y, f.y - 6);
        await save('virtualization-edit', { x: g.x - 4, y: top, w: g.w + 8, h: Math.min(sb.y + sb.h, vms.y + vms.h + 8) - top }, { quality: 45 });
      }
      await page.eval(`localStorage.removeItem('netatlas.dockHeight'), sessionStorage.clear(), netatlas.select(null), netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(20000), true`);
      await page.eval(`(() => { const c = netatlas.simController(); c.sim.powerOff('hv2'); c.runTo(20000 + 30000 + 70000); c.refresh(true); return true; })()`);
      await page.settle(200);
      await page.eval(`document.getElementById('toast').hidden = true, true`);
      // esx-01 with the VMs restarted on it, under the simulation's banner
      {
        const banner = await page.rect('#mode-banner');
        const r = await frame('device:hv1', banner.h);
        const y = Math.min(r.y, banner.y);
        await save('sim-ha', { x: r.x, y, w: r.w, h: r.y + r.h - y }, { quality: 40 });
      }
      await page.eval(`netatlas.exitSimulation(), sessionStorage.clear(), true`);
      await page.settle(100);
    }

    // the querier election (the internal example): q1 the elected querier of LAN A, q2 a candidate without a mark
    {
      await page.eval(`netatlas.loadExampleNamed('multicast-querier.yaml'), netatlas.setView('physical'), netatlas.select(null), true`);
      await page.settle(150);
      await page.eval(`localStorage.removeItem('netatlas.dockHeight'), sessionStorage.clear(), netatlas.startProtocolSimulation({ params: {} }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(15000), netatlas.select('device:sw', true), netatlas.select(null), netatlas.simController().refresh(true), document.getElementById('toast').hidden = true, true`);
      await page.settle(250);
      const qs = [];
      for (const d of ['q1', 'q2', 'sw']) qs.push(await page.rect(`#canvas .node[data-ref="device:${d}"]`));
      qs.push(await page.rect('#canvas .sim-querier[data-device="q1"]'));
      await save('querier', around(qs, 10), { quality: 30 });
      await page.eval(`netatlas.exitSimulation(), sessionStorage.clear(), true`);
      await page.settle(100);
    }

    // input helpers: a tunnel interface's MTU suggestions and MAC Generate (enterprise WAN, hq-rtr1 st0.10)
    {
      await page.eval('netatlas.loadExample(0), netatlas.setView("physical"), netatlas.select("iface:hq-rtr1:st0.10"), netatlas.showTab("edit"), true');
      await page.eval("document.getElementById('toast').hidden = true");
      await page.settle(200);
      await page.eval(`(() => { const f = document.querySelector('#side-body details[open] .helpers').closest('.field'); f.scrollIntoView({ block: 'start' }); return true; })()`);
      await page.settle(150);
      const f1 = await page.rect('#side-body details[open] .helpers');
      const sb = await page.rect('#side-body');
      await save('helpers', { x: sb.x + 4, y: Math.max(sb.y, f1.y - 52), w: sb.w - 8, h: 205 }, { quality: 45 });
    }

    // routing services: r3's Protocols card (suggestions, BGP, Enable a protocol) in the Edit tab
    {
      const demo2 = 'consistency-checks.yaml';
      await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(demo2)}), netatlas.setView("physical"), netatlas.select("device:r3"), netatlas.showTab("edit"), true`);
      await page.eval("document.getElementById('toast').hidden = true");
      await page.settle(200);
      await page.eval(`(() => { const g = document.querySelector('#side-body [data-group="protocols"]'); g.scrollIntoView({ block: 'start' }); return true; })()`);
      await page.settle(150);
      const g = await page.rect('#side-body [data-group="protocols"]');
      const sb = await page.rect('#side-body');
      await save('protocols', { x: g.x - 4, y: Math.max(sb.y, g.y - 4), w: g.w + 8, h: Math.min(g.h + 8, sb.y + sb.h - g.y, 330) }, { quality: 45 });
    }

    // consistency checks: the Problems tab of the consistency-checks example, then its check settings
    const demo = 'consistency-checks.yaml';
    // (the side panel scrolled back to its top: the cards before scrolled it)
    await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(demo)}), netatlas.setView("physical"), netatlas.showTab("problems"), document.getElementById('side-body').scrollTop = 0, true`);
    await page.eval("document.getElementById('toast').hidden = true");
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(200);
    {
      const side = await page.rect('#side');
      const first = await page.rect('#side-body [data-problems="checks"] .issue:nth-of-type(2)');
      await save('problems', { x: side.x, y: side.y, w: side.w, h: Math.min(side.y + side.h, first.y + first.h + 8) - side.y }, { quality: 70 });
    }
    await page.click('#side-body [data-problems-settings]');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(300);
    {
      const side = await page.rect('#side');
      const g = await page.rect('#side-body [data-group="checks"]');
      const y = Math.max(side.y, g.y - 4);
      await save('checks', { x: side.x, y, w: side.w, h: Math.min(side.y + side.h, y + 270) - y }, { quality: 70 });
    }

    // the theme switch with its tooltip, in the dark theme (the default)
    await page.hover('#theme-btn');
    await page.settle(150);
    {
      const bar = await page.rect('header.topbar');
      const tip = await page.rect('#theme-tip');
      const x = Math.min(tip.x, bar.x + bar.w - 380);
      await save('theme', { x, y: 0, w: bar.x + bar.w - x, h: tip.y + tip.h + 10 });
    }
  } finally {
    await page.close();
  }
  for (const s of saved) console.log('wrote docs/img/manual/' + s);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

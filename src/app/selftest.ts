/**
 * In-browser end-to-end self-test, run by opening the built file with
 * "#selftest" appended to the URL (see scripts/browser-selftest.mjs).
 * It drives the real UI and DOM: loads every embedded example through the
 * same code paths as the file picker, switches views, and uses the editor
 * exactly like a user would (outline buttons, form fields, dialogs), then
 * checks what was drawn and what gets exported. It also verifies label
 * safety, error reporting and that the page made no network requests.
 */
import { ModelDoc } from '../editor/document';
import { strNode } from '../yaml/parse';
import { EXAMPLES } from '../generated/examples';
import { App } from '../ui/app';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(app: App, doc: Document): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
  };
  const count = (sel: string): number => doc.querySelectorAll('#viewport ' + sel).length;
  const q = (sel: string): HTMLElement | null => doc.querySelector(sel) as HTMLElement | null;
  const click = (sel: string): void => {
    const b = q(sel);
    if (b) b.click();
  };
  /** type into an editor field and commit it (like pressing Enter) */
  const setField = async (sel: string, value: string): Promise<boolean> => {
    const i = q(sel) as HTMLInputElement | null;
    if (!i) return false;
    i.focus();
    i.value = value;
    i.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    return true;
  };
  const answerDialog = async (value: string): Promise<boolean> => {
    await tick(10);
    const b = q(`#modal[open] [data-value="${value}"]`);
    if (b) b.click();
    await tick(10);
    return !!b;
  };
  /** status shown next to the Auto-arrange button: "auto" | "manual" | "edited" */
  const status = (v: 'physical' | 'logical'): string => (q(`[data-view-status="${v}"]`) || { getAttribute: () => '' }).getAttribute('data-status') || '';
  const statusText = (v: 'physical' | 'logical'): string => (q(`[data-view-status="${v}"]`) || { textContent: '' }).textContent || '';
  let violations = 0;
  doc.addEventListener('securitypolicyviolation', () => violations++);
  // capture downloads instead of saving them
  const downloads: Array<{ name: string; text: string }> = [];
  const origCreate = URL.createObjectURL;
  const pendingBlobs: Blob[] = [];
  URL.createObjectURL = (b: Blob | MediaSource): string => {
    pendingBlobs.push(b as Blob);
    return 'blob:selftest';
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    const blob = pendingBlobs.shift();
    if (blob) void blob.text().then((text) => downloads.push({ name: this.download, text }));
  };
  const lastDownload = async (): Promise<{ name: string; text: string } | undefined> => {
    await tick(30);
    return downloads[downloads.length - 1];
  };

  try {
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const policy = csp ? csp.getAttribute('content') || '' : '';
    check('CSP meta present and blocks network', /default-src 'none'/.test(policy) && /connect-src 'none'/.test(policy), policy);
    {
      const btn = q('#btn-arrange') as HTMLButtonElement | null;
      const r = btn ? btn.getBoundingClientRect() : null;
      check(
        'Auto-arrange button is in the top toolbar, visible and labelled (disabled until a model is open)',
        !!btn && !!btn.closest('header.topbar') && !!r && r.width > 40 && r.height > 10 && r.top < 60 && /^Auto-arrange/.test((btn.textContent || '').trim()) && btn.disabled,
        btn ? (btn.textContent || '') + (btn.disabled ? ' (disabled)' : '') : 'missing',
      );
    }

    // ------------------------------------------------ viewer: every example
    for (let i = 0; i < EXAMPLES.length; i++) {
      const ex = EXAMPLES[i];
      const file = new File([ex.text], ex.name, { type: 'application/yaml' });
      const res = await app.loadFile(file);
      check(`${ex.name}: loads via File API without errors`, res.ok && !res.errors.length, res.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
      if (!res.ok || !app.session) continue;
      const m = app.session.model;

      click('[data-view-btn="physical"]');
      check(`${ex.name}: physical view draws every device and cable, no relations`,
        doc.body.getAttribute('data-view') === 'physical' && count('.device') === m.devices.length && count('.cable') === m.links.length && count('.rel') === 0 && count('.port') === m.links.length * 2,
        `${count('.device')}/${m.devices.length} devices, ${count('.cable')}/${m.links.length} cables`);
      check(`${ex.name}: loopbacks are not drawn as ports in the physical view`, count('.loop-chip') === 0);

      click('[data-view-btn="logical"]');
      const drawable = m.relations.filter((r) => new Set(r.endpoints.map((e) => e.device)).size >= 2).length;
      check(`${ex.name}: logical view draws relations, no cables`, doc.body.getAttribute('data-view') === 'logical' && count('g.rel') === drawable && count('.cable') === 0, `${count('g.rel')} / ${drawable}`);
      const tunnels = m.relations.filter((r) => r.category === 'tunnel').length;
      check(`${ex.name}: tunnels drawn as tubes`, count('g.rel.cat-tunnel .tube-outer') >= tunnels && count('g.rel.cat-tunnel .cable-line') === 0);
      const loops = m.devices.reduce((s, d) => s + Math.min(3, d.interfaces.filter((x) => x.type === 'loopback').length), 0);
      check(`${ex.name}: loopbacks shown as chips in the logical view`, count('.loop-chip') === loops, `${count('.loop-chip')} / ${loops}`);

      const firstRel = m.relations[0];
      if (firstRel) {
        app.select('relation:' + firstRel.id);
        const keep = app.session.highlight() as Set<string>;
        const refs = Array.prototype.map.call(doc.querySelectorAll('#viewport [data-ref]'), (e: Element) => e.getAttribute('data-ref')) as string[];
        check(`${ex.name}: selecting a relation highlights it and dims exactly the unrelated items`,
          count('.selected') > 0 && count('.dim') === refs.filter((r) => !keep.has(r)).length);
        const insp = q('#side-body .inspector h3');
        check(`${ex.name}: selecting opens the object in the Edit inspector`, !!insp && (insp.textContent || '').length > 0 && !!q('#side-body .inspector [data-t="id"]'));
        click('[data-view-btn="physical"]');
        check(`${ex.name}: selection survives view switch`, app.session.state.selected === 'relation:' + firstRel.id);
        app.select(null);
      }
    }

    // ------------------------------------------------ viewer interactions
    app.loadExample(EXAMPLES.findIndex((e) => /enterprise-wan/.test(e.name)));
    click('[data-view-btn="physical"]');
    const svg = doc.getElementById('canvas') as unknown as SVGSVGElement;
    const vp = doc.getElementById('viewport') as unknown as SVGGElement;
    const pe = (type: string, x: number, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, isPrimary: true });
    const devEl = q('#viewport g.device[data-ref="device:hq-fw"] .dev-box') as unknown as SVGGraphicsElement;
    const r = devEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    devEl.dispatchEvent(pe('pointerdown', cx, cy));
    svg.dispatchEvent(pe('pointerup', cx, cy));
    check('click selects a device (and opens it in the editor)', !!app.session && app.session.state.selected === 'device:hq-fw' && (q('#side-body .inspector [data-t="id"]') as HTMLInputElement).value === 'hq-fw');
    devEl.dispatchEvent(pe('pointerdown', cx, cy));
    svg.dispatchEvent(pe('pointermove', cx + 60, cy + 30));
    svg.dispatchEvent(pe('pointermove', cx + 120, cy + 60));
    svg.dispatchEvent(pe('pointerup', cx + 120, cy + 60));
    {
      const dm = app.mdoc as ModelDoc;
      const fw = dm.result.model!.layout.physical.get('hq-fw');
      check(
        'dragging a device stores its position in the model (physical view only, one undo step)',
        !!fw && dm.dirty && dm.canUndo() === 'Move hq-fw' && dm.hasStoredLayout('physical') && !dm.hasStoredLayout('logical'),
        JSON.stringify(fw),
      );
      check('status after dragging: Physical "Manually adjusted", Logical still "Auto-arranged"', status('physical') === 'manual' && status('logical') === 'auto' && /Physical: Manually adjusted/.test(statusText('physical')), statusText('physical') + ' / ' + statusText('logical'));
      check('Auto-arrange button is enabled once a model is open', !(q('#btn-arrange') as HTMLButtonElement).disabled);
    }
    const t0 = vp.getAttribute('transform');
    const sr = svg.getBoundingClientRect();
    svg.dispatchEvent(pe('pointerdown', sr.left + 5, sr.top + 5));
    svg.dispatchEvent(pe('pointermove', sr.left + 105, sr.top + 55));
    svg.dispatchEvent(pe('pointerup', sr.left + 105, sr.top + 55));
    const t1 = vp.getAttribute('transform');
    check('dragging the background pans', t0 !== t1, `${t0} -> ${t1}`);
    svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300, clientX: sr.left + 200, clientY: sr.top + 200 }));
    check('mouse wheel zooms', vp.getAttribute('transform') !== t1);
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    check('undo reverts the drag (and the stored positions)', !(app.mdoc as ModelDoc).hasStoredLayout('physical'));
    check('status after undo: back to "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    check('keyboard shortcut L switches to the logical view', doc.body.getAttribute('data-view') === 'logical');
    check('switching views highlights the status of the shown view', !!q('[data-view-status="logical"].current') && !q('[data-view-status="physical"].current'));
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('Escape clears the selection', !!app.session && app.session.state.selected === null);

    click('[data-view-btn="logical"]');
    const ipsec = q('#viewport g.rel[data-ref="relation:ipsec-muc"] .tube-outer');
    const gre = q('#viewport g.rel[data-ref="relation:gre-muc"] .tube-outer');
    const w = (e: Element | null): number => (e ? parseFloat(e.getAttribute('stroke-width') || '0') : 0);
    check('GRE drawn inside IPsec (narrower tube on the same path)', !!ipsec && !!gre && w(gre) < w(ipsec) && gre!.getAttribute('d') === ipsec!.getAttribute('d'));
    check('custom protocol MACsec rendered', !!q('#viewport g.rel.proto-macsec'));
    const svgText = app.exportSvg();
    check('SVG export is standalone (inline style, no script, no external refs)', /^<svg[\s\S]*<style[\s\S]*relation:gre-muc[\s\S]*<\/svg>$/.test(svgText) && !/<script|https?:\/\/(?!www\.w3\.org)/.test(svgText));
    click('[data-view-btn="physical"]');
    app.select('relation:gre-muc');
    check('selecting GRE tunnel highlights its physical path (3 cables)', count('.cable.hl') === 3, String(count('.cable.hl')));
    app.select(null);

    // ---------------------------------------------------- auto-arrange
    {
      const rects = (): string => {
        const out: string[] = [];
        doc.querySelectorAll('#viewport g.node[data-ref]').forEach((g) => {
          const r = g.querySelector('rect');
          if (r) out.push(`${g.getAttribute('data-ref')}@${r.getAttribute('x')},${r.getAttribute('y')}`);
        });
        return out.sort().join(' ');
      };
      const wanIdx = EXAMPLES.findIndex((e) => /enterprise-wan/.test(e.name));
      app.loadExample(wanIdx);
      click('[data-view-btn="physical"]');
      const physBefore = rects();
      click('[data-view-btn="logical"]');
      const logBefore = rects();
      check('loading a file does not store positions or mark it changed; status "Auto-arranged"', !(app.mdoc as ModelDoc).hasStoredLayout('physical') && !(app.mdoc as ModelDoc).dirty && status('physical') === 'auto' && status('logical') === 'auto');
      click('#btn-arrange');
      await tick(10);
      check('Auto-arrange explains its scope (whole model, both views, undo)', /whole model/.test(q('#modal')!.textContent || '') && /Physical view: 15 devices/.test(q('#modal')!.textContent || '') && !!q('#modal [data-value="both"]'));
      await answerDialog('both');
      const ad = app.mdoc as ModelDoc;
      click('[data-view-btn="physical"]');
      check('arranging an automatic layout stores it without moving anything', ad.hasStoredLayout('physical') && ad.hasStoredLayout('logical') && rects() === physBefore && /nothing moved/.test(q('#toast')!.textContent || ''));
      click('[data-view-btn="logical"]');
      check('… in the logical view as well', rects() === logBefore);
      check('status after Auto-arrange: both views "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto');
      const undoLabel = ad.canUndo();
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      await tick(10);
      await answerDialog('logical');
      check('auto-arranging again changes nothing (no move, no undo step)', ad.canUndo() === undoLabel && rects() === logBefore && /Already arranged/.test(q('#toast')!.textContent || ''));
      // manual move, then arrange restores the deterministic positions; undo brings the manual one back
      ad.movePositions('logical', new Map([['hq-fw', { x: 4321, y: 1234 }]]), 'Move hq-fw');
      app.mdoc && app.select(null);
      (app as unknown as { afterEdit(n?: string): void }).afterEdit();
      const moved = rects();
      check('a manual move changes only that node', moved !== logBefore && moved.split(' ').filter((x, i) => x !== logBefore.split(' ')[i]).every((x) => /device:hq-fw|iface:hq-fw/.test(x)));
      check('status after a logical move: Logical "Manually adjusted", Physical unchanged', status('logical') === 'manual' && status('physical') === 'auto');
      // returning the node to its calculated position counts as auto-arranged again (derived, not a flag)
      ad.movePositions('logical', new Map([['hq-fw', ad.autoLayout('logical').get('hq-fw')!]]), 'Move hq-fw back');
      (app as unknown as { afterEdit(n?: string): void }).afterEdit();
      check('moving the node back to its calculated position shows "Auto-arranged"', status('logical') === 'auto' && rects() === logBefore);
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      check('undo of that shows "Manually adjusted" again', status('logical') === 'manual' && rects() === moved);
      click('#btn-arrange');
      await answerDialog('logical');
      check('Auto-arrange ignores manual positions (same result as before the move)', rects() === logBefore);
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      check('undo restores the manual position', rects() === moved && status('logical') === 'manual');
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
      check('redo: "Auto-arranged" again', status('logical') === 'auto');
      // export -> reload: identical positions in both views
      const exported = app.exportText();
      app.loadText(exported, 'arranged.yaml', 'file');
      click('[data-view-btn="logical"]');
      const logReload = rects();
      click('[data-view-btn="physical"]');
      check('arrange -> export -> reload keeps every position (both views)', logReload === logBefore && rects() === physBefore && !(app.mdoc as ModelDoc).dirty);
      check('status after export -> reload: both "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto');
      {
        // a manual adjustment survives export -> reload, and a model edit is not a manual adjustment
        const md = app.mdoc as ModelDoc;
        md.movePositions('physical', new Map([['hq-log', { x: -700, y: 40 }]]), 'Move hq-log');
        app.loadText(md.exportText(), 'manual.yaml', 'file');
        check('status after exporting and reloading a manually adjusted layout: Physical "Manually adjusted"', status('physical') === 'manual' && status('logical') === 'auto');
        const re = app.mdoc as ModelDoc;
        re.arrange(['physical', 'logical']);
        re.addEntity('device', [['id', strNode('hq-spare')], ['type', strNode('switch')], ['group', strNode('hq-core')]]);
        (app as unknown as { afterEdit(n?: string): void }).afterEdit();
        check('a model edit is not reported as a manual adjustment ("Edited since arranged")', status('physical') === 'edited' && status('logical') === 'edited', statusText('physical'));
        re.markSaved();
      }
      // an equivalent file with every list reversed arranges identically
      const shuffled = ModelDoc.fromText(EXAMPLES[wanIdx].text, 'shuffled.yaml', 'file').doc as ModelDoc;
      const rev = (n: import('../yaml/parse').YNode): void => {
        if (n.kind === 'seq') {
          n.items.reverse();
          n.items.forEach(rev);
        } else if (n.kind === 'map') {
          const e = Array.from(n.entries.entries()).reverse();
          n.entries = new Map(e);
          e.forEach(([, v]) => rev(v.value));
        }
      };
      rev(shuffled.root);
      // endpoint order of directed relations carries meaning: restore those
      const revText = shuffled.exportText().replace('endpoints: [hq-rtr1, muc-rtr]', 'endpoints: [muc-rtr, hq-rtr1]').replace('endpoints: ["hq-log:eno1", hq-fw]', 'endpoints: [hq-fw, "hq-log:eno1"]');
      check('reversed file keeps the direction of directed relations', /endpoints: \[muc-rtr, hq-rtr1\]/.test(revText) && /endpoints: \[hq-fw, "hq-log:eno1"\]/.test(revText));
      app.loadText(revText, 'reversed.yaml', 'file');
      const rd = app.mdoc as ModelDoc;
      rd.arrange(['physical', 'logical']);
      const layoutText = (t: string): string => t.slice(t.indexOf('\nlayout:'));
      check('an equivalent file with all lists and keys in reverse order arranges identically', layoutText(rd.exportText()) === layoutText(exported));
      rd.markSaved();
      // cross-engine determinism: metro-ring-arranged.yaml was computed in Node when the app was built
      const src = EXAMPLES.find((e) => e.name === 'metro-ring.yaml');
      const ref = EXAMPLES.find((e) => e.name === 'metro-ring-arranged.yaml');
      if (src && ref) {
        const md = ModelDoc.fromText(src.text, 'metro-ring.yaml', 'file').doc as ModelDoc;
        md.arrange(['physical', 'logical']);
        check('this browser computes exactly the positions that were computed at build time (metro-ring-arranged.yaml)', layoutText(md.exportText()) === layoutText(ref.text));
      }
    }

    // ---------------------------------------- editor: create a new model
    click('#btn-new');
    await tick();
    const d0 = app.mdoc as ModelDoc;
    check('New creates a valid minimal model (one router with a loopback)', !!d0 && d0.origin === 'new' && d0.valid && d0.entities('device').length === 1 && !d0.dirty);
    check('status of a new model: both views "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto');
    click('[data-view-btn="logical"]');
    check('new model: loopback chip with router-ID marker in the logical view', count('.loop-chip.rid') === 1);

    click('#outline [data-act="add-entity"][data-kind="device"]');
    await tick();
    check('Add device selects it in the inspector', (q('#side-body [data-t="id"]') as HTMLInputElement | null)?.value === 'device1');
    await setField('#side-body [data-t="id"]', 'edge2');
    // type a label without committing it, then press "+ Loopback" with the pointer
    const lbl = q('#side-body [data-p=\'["devices",1,"label"]\']') as HTMLInputElement;
    lbl.focus();
    lbl.value = 'Edge router 2';
    const addLoopBtn = q('#side-body [data-act="add-loop"]') as HTMLElement;
    addLoopBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 3 }));
    addLoopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await tick(10);
    check(
      'typing, then clicking an editor button keeps the typed text and performs the action',
      (app.mdoc as ModelDoc).text(['devices', 1, 'label']) === 'Edge router 2' && (app.mdoc as ModelDoc).interfaceIds(1).length === 1,
      JSON.stringify([(app.mdoc as ModelDoc).text(['devices', 1, 'label']), (app.mdoc as ModelDoc).interfaceIds(1)]),
    );
    const appendSel = '#side-body [data-t="list-append"][data-p=\'["devices",1,"interfaces",0,"ip"]\']';
    await setField(appendSel, '10.255.0.2/32');
    await setField(appendSel, '2001:db8:ffff::2/128');
    await setField(appendSel, '10.255.0.3');
    const errText = Array.prototype.map.call(doc.querySelectorAll('#side-body details.card .field-err'), (e: Element) => e.textContent).join(' | ');
    check('invalid loopback address is reported next to the field', /needs a prefix length/.test(errText) && !(app.mdoc as ModelDoc).valid, errText);
    await setField('#side-body [data-t="list-item"][data-p=\'["devices",1,"interfaces",0,"ip",2]\']', '10.255.0.3/32');
    await setField('#side-body [data-p=\'["devices",1,"interfaces",0,"label"]\']', 'Router ID');
    click('#side-body [data-act="add-loop"]');
    await tick();
    await setField('#side-body [data-t="list-append"][data-p=\'["devices",1,"interfaces",1,"ip"]\']', 'fd00::77/128');
    await setField('#side-body [data-p=\'["devices",1,"router_id"]\']', 'lo0');
    const dA = app.mdoc as ModelDoc;
    const loops = dA.result.model ? dA.result.model.index.devices.get('edge2')!.interfaces.filter((x) => x.type === 'loopback') : [];
    check('two loopbacks with IPv4 + IPv6 addresses added and valid', dA.valid && loops.length === 2 && loops[0].addresses.length === 3 && loops[1].addresses[0] === 'fd00::77/128', JSON.stringify(dA.errors.map((e) => e.message)));
    check('loopbacks appear in the diagram right away', count('[data-ref="iface:edge2:lo0"]') === 1 && count('[data-ref="iface:edge2:lo1"]') === 1);

    // interfaces + cable + tunnel between the loopbacks
    click('#side-body [data-act="add-iface"]');
    await tick();
    click('#outline [data-act="select"][data-kind="device"][data-index="0"]');
    await tick();
    click('#side-body [data-act="add-iface"]');
    await tick();
    click('#outline [data-act="add-entity"][data-kind="link"]');
    await tick();
    await setField('#side-body select[data-t="ep-dev"][data-p=\'["links",0,"a"]\']', 'router1');
    await setField('#side-body select[data-t="ep-if"][data-p=\'["links",0,"a"]\']', 'eth0');
    await setField('#side-body select[data-t="ep-dev"][data-p=\'["links",0,"b"]\']', 'edge2');
    await setField('#side-body select[data-t="ep-if"][data-p=\'["links",0,"b"]\']', 'eth0');
    click('[data-view-btn="physical"]');
    check('link created in the editor is drawn as a cable', count('.cable') === 1 && (app.mdoc as ModelDoc).valid, JSON.stringify((app.mdoc as ModelDoc).errors.map((e) => e.message)));
    click('#outline [data-act="add-entity"][data-kind="relation"]');
    await tick();
    await setField('#side-body [data-p=\'["relations",0,"protocol"]\']', 'gre');
    await setField('#side-body select[data-t="ep-append"]', 'router1');
    await setField('#side-body select[data-t="ep-append"]', 'edge2');
    await setField('#side-body select[data-t="ep-if"][data-p=\'["relations",0,"endpoints",0]\']', 'lo0');
    await setField('#side-body select[data-t="ep-if"][data-p=\'["relations",0,"endpoints",1]\']', 'lo0');
    await setField('#side-body select[data-t="over-append"]', 'link1');
    // protocol-specific attributes, including a nested group
    await setField('#side-body [data-t="g-newkey"][data-p=\'["relations",0,"attrs"]\']', 'key');
    await setField('#side-body [data-t="auto"][data-p=\'["relations",0,"attrs","key"]\']', '42');
    const newTypeSel = q('#side-body [data-p=\'["relations",0,"attrs"]\'][data-t="g-newkey"]')!.parentElement!.querySelector('.g-newtype') as HTMLSelectElement;
    newTypeSel.value = 'map';
    await setField('#side-body [data-t="g-newkey"][data-p=\'["relations",0,"attrs"]\']', 'keepalive');
    await setField('#side-body [data-t="g-newkey"][data-p=\'["relations",0,"attrs","keepalive"]\']', 'interval');
    await setField('#side-body [data-t="auto"][data-p=\'["relations",0,"attrs","keepalive","interval"]\']', '10s');
    click('[data-view-btn="logical"]');
    const dB = app.mdoc as ModelDoc;
    check('GRE tunnel between loopbacks drawn as a tube', count('g.rel.cat-tunnel .tube-outer') === 1 && dB.valid, JSON.stringify(dB.errors.map((e) => e.message)));
    check('edits mark the document dirty', dB.dirty && doc.body.getAttribute('data-dirty') === 'true' && /unsaved/.test(q('#status')!.textContent || ''));

    // export the new model
    click('#btn-download');
    await tick(10);
    const dlgText = q('#modal')!.textContent || '';
    check('download dialog explains the export', /downloads location/.test(dlgText) && (q('#dl-name') as HTMLInputElement).value === 'new-network.yaml');
    await answerDialog('download');
    const created = await lastDownload();
    check('new model downloaded as YAML', !!created && created.name === 'new-network.yaml' && !(app.mdoc as ModelDoc).dirty);
    if (created) {
      const re = ModelDoc.fromText(created.text, 'new-network.yaml', 'file');
      const rd = re.doc;
      const rm = rd && rd.result.model;
      check('exported new model reloads identically (valid, same YAML, loopbacks + attrs intact)',
        !!rd && rd.valid && rd.exportText() === created.text && !!rm && rm.index.devices.get('edge2')!.routerId === 'lo0' &&
          rm.index.interfaces.get('edge2:lo0')!.addresses.join(',') === '10.255.0.2/32,2001:db8:ffff::2/128,10.255.0.3/32' &&
          rm.relations[0].attrs.some(([k, v]) => k === 'keepalive.interval' && v === '10s') && /key: 42/.test(created.text),
        created.text);
    }

    // ------------------------ editor: import → edit → export → reload
    const wanText = EXAMPLES.find((e) => /enterprise-wan/.test(e.name))!.text.replace('    vendor: Juniper\n    model: MX204\n    group: hq-edge\n    mgmt: 10.99.0.11', '    vendor: Juniper\n    model: MX204\n    group: hq-edge\n    mgmt: 10.99.0.11\n    attrs:\n      serial: JN11AB22CD\n      contract: {id: C-77, expires: 2027-01-31}');
    const imp = await app.loadFile(new File([wanText], 'acme-wan.yaml'));
    check('imported file opens in the editor', imp.ok && (app.mdoc as ModelDoc).origin === 'file' && (app.mdoc as ModelDoc).valid);
    app.select('device:hq-rtr1');
    await setField('#side-body [data-t="id"]', 'hq-edge-a');
    const renamed = (app.mdoc as ModelDoc).exportText();
    check('renaming a device updates every reference', (app.mdoc as ModelDoc).valid && !/hq-rtr1:|device: hq-rtr1|id: hq-rtr1/.test(renamed) && /label: hq-rtr1/.test(renamed) && (renamed.match(/hq-edge-a/g) || []).length >= 12,
      String((renamed.match(/hq-edge-a/g) || []).length));
    await setField('#side-body [data-p=\'["devices",3,"vendor"]\']', 'Juniper Networks');
    click('#side-body [data-act="add-loop"]');
    await tick();
    const lastLoop = (app.mdoc as ModelDoc).interfaceIds(3).length - 1;
    await setField(`#side-body [data-t="list-append"][data-p='["devices",3,"interfaces",${lastLoop},"ip"]']`, '2001:db8:0:ff::1/128');
    click('#btn-download');
    await tick(10);
    check('export of an imported file is offered as a new copy', /original file on your disk is not modified/.test(q('#modal')!.textContent || '') && (q('#dl-name') as HTMLInputElement).value === 'acme-wan-edited.yaml');
    await answerDialog('download');
    const edited = await lastDownload();
    if (edited) {
      const back = ModelDoc.fromText(edited.text, edited.name, 'file').doc as ModelDoc;
      const bm = back.result.model!;
      check('import → edit → export → reload keeps the edits', back.valid && bm.index.devices.get('hq-edge-a')!.vendor === 'Juniper Networks' && bm.index.interfaces.get('hq-edge-a:' + back.interfaceIds(3)[lastLoop])!.addresses[0] === '2001:db8:0:ff::1/128');
      check('attributes not shown in diagrams survive the round trip', /serial: JN11AB22CD/.test(edited.text) && /contract: \{id: C-77, expires: 2027-01-31\}/.test(edited.text) && /cipher: GCM-AES-XPN-256/.test(edited.text));
      check('comments of the imported file are kept', /# --- Munich: IPsec carries GRE carries OSPF/.test(edited.text) && /^# netatlas example: enterprise WAN/.test(edited.text));
    } else check('import → edit → export → reload keeps the edits', false, 'no download captured');

    // unsaved-change guards
    await setField('#side-body [data-p=\'["devices",3,"model"]\']', 'MX304');
    const sel = q('#examples') as HTMLSelectElement;
    sel.value = '0';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(10);
    check('replacing a dirty model asks first', !!q('#modal[open]') && /Unsaved changes/.test(q('#modal')!.textContent || ''));
    await answerDialog('cancel');
    check('cancel keeps the edited model', (app.mdoc as ModelDoc).fileName === 'acme-wan.yaml' && (app.mdoc as ModelDoc).dirty);
    const bu = new Event('beforeunload', { cancelable: true });
    (doc.defaultView as Window).dispatchEvent(bu);
    check('closing the page with unsaved changes asks the browser to confirm', bu.defaultPrevented);

    // undo / redo
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    check('Ctrl+Z undoes the last edit', app.mdoc!.result.model!.index.devices.get('hq-edge-a')!.model === 'MX204');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    check('Ctrl+Y redoes it', app.mdoc!.result.model!.index.devices.get('hq-edge-a')!.model === 'MX304');

    // broken references: deleting a device others refer to
    app.select('device:muc-rtr');
    click('#side-body [data-act="del-entity"]');
    await tick(10);
    check('delete asks for confirmation and counts references', /references? to it will become invalid/.test(q('#modal')!.textContent || ''));
    await answerDialog('delete');
    const dC = app.mdoc as ModelDoc;
    check('broken references are reported (not silently removed)', !dC.valid && dC.errors.some((e) => /unknown device "muc-rtr"/.test(e.message)) && /muc-rtr/.test(dC.exportText()));
    check('entities with errors are flagged in the outline', doc.querySelectorAll('#outline .ol-badge.err').length > 0);
    click('#btn-download');
    await tick(10);
    check('exporting an invalid model warns explicitly', /has errors/.test(q('#modal h2')!.textContent || '') && !!q('#modal [data-value="download"].danger'));
    await answerDialog('cancel');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    check('undo restores the deleted device', (app.mdoc as ModelDoc).valid);

    // YAML tab: apply text edits, reject broken YAML without losing the model
    click('[data-tab="yaml"]');
    const ta = q('#yaml-src') as HTMLTextAreaElement;
    ta.value = ta.value.replace('title: ACME Corp — enterprise WAN', 'title: ACME WAN (edited as text)');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-tab="legend"]');
    click('[data-tab="yaml"]');
    check('unapplied YAML text survives switching tabs', /edited as text/.test((q('#yaml-src') as HTMLTextAreaElement).value));
    click('[data-yaml="apply"]');
    check('YAML tab edits are applied', app.mdoc!.result.model!.title === 'ACME WAN (edited as text)');
    (q('#yaml-src') as HTMLTextAreaElement).value = 'netatlas: 1\ndevices:\n  - &x {id: a}\n';
    click('[data-yaml="apply"]');
    check('invalid YAML in the text tab is rejected with a line number', /line 3/.test(q('#side-body .field-err')!.textContent || '') && app.mdoc!.result.model!.devices.length > 3);
    click('[data-yaml="revert"]');

    // unknown keys are kept and shown
    const unk = app.loadText('netatlas: 1\ndevices:\n  - id: r1\n    colour: blue\n    interfaces: [{id: lo0, type: loopback, ip: [10.0.0.1/32], weird: {x: 1}}]\n', 'unknown.yaml', 'file');
    app.select('device:r1');
    check('unknown properties are shown in the inspector, not dropped', unk.errors.length > 0 && !!q('#side-body .other') && /colour/.test(app.exportText()) && /weird: \{x: 1\}/.test(app.exportText()));
    click('#side-body [data-act="to-attrs"][data-k="colour"]');
    await tick();
    check('"move into attrs" fixes an unknown property', /attrs:\n\s+colour: blue/.test(app.exportText()));

    // ------------------------------------------ safety / errors / offline
    const evil =
      'netatlas: 1\ntitle: "<img src=x onerror=alert(1)>"\ndevices:\n' +
      '  - id: a\n    label: "<script>alert(1)</script>"\n    interfaces: [e0]\n' +
      '  - id: b\n    label: "<svg onload=alert(1)>"\n    interfaces: [e0]\n' +
      'links:\n  - {id: l1, a: "a:e0", b: "b:e0"}\n';
    const res = app.loadText(evil, 'evil.yaml');
    click('[data-view-btn="physical"]');
    const texts = Array.prototype.map.call(doc.querySelectorAll('#viewport .dev-label'), (e: Element) => e.textContent).join('|');
    app.select('device:a');
    check('hostile labels load and are shown literally', res.ok && texts.indexOf('<script>alert(1)</script>') >= 0, texts);
    check('no injected elements (diagram, outline, inspector)', !doc.querySelector('#viewport img, #viewport script, #viewport foreignObject, #side-body img, #side-body script, #outline img, body > img'));

    const bad = app.loadText('netatlas: 1\ndevices:\n  - &a {id: r1}\n', 'bad.yaml');
    check('YAML syntax errors are rejected before editing, with line number', !bad.ok && bad.errors[0].line === 3 && /anchor/.test(bad.errors[0].message) && (app.mdoc as ModelDoc).fileName === 'evil.yaml');
    check('the rejection is explained in a dialog and the current model is kept', /anchor/.test(q('#modal')!.textContent || ''));
    await answerDialog('ok');
    const bad2 = app.loadText('netatlas: 1\ndevices:\n  - id: r1\nlinks:\n  - {id: l1, a: "r1:eth0", b: r2}\n', 'bad2.yaml');
    check('a file with broken references opens as a draft listing its errors', bad2.ok && bad2.errors.length === 2 && /Problems \(2\)/.test(q('[data-tab="problems"]')!.textContent || ''));

    const perf = (doc.defaultView as Window).performance;
    const resources = perf && perf.getEntriesByType ? perf.getEntriesByType('resource').length : 0;
    check('no network resources requested', resources === 0, String(resources));
    check('no CSP violations', violations === 0, String(violations));

    app.mdoc!.markSaved();
    app.loadExample(0);
  } catch (e) {
    check('self-test crashed', false, String((e as Error).stack || e));
  } finally {
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
  }

  const pass = checks.every((c) => c.ok);
  const out = doc.getElementById('selftest') as HTMLElement;
  out.hidden = false;
  out.textContent = JSON.stringify({ pass, total: checks.length, failed: checks.filter((c) => !c.ok), checks, downloads }, null, 1);
  doc.body.setAttribute('data-selftest', pass ? 'pass' : 'fail');
  return checks;
}

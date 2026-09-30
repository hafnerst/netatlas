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
import { DEVICE_TYPES } from '../model/device-types';
import { interfaceAddresses, interfaceVlanText, networkMembers } from '../model/derive';
import { contextState, relatedRefs, selectionContext } from '../model/queries';
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
    const typeSel = (Array.from(doc.querySelectorAll('#side-body .inspector select[data-p]')) as HTMLSelectElement[]).find((x) => {
      const p = JSON.parse(x.getAttribute('data-p') || '[]');
      return p.length === 3 && p[0] === 'devices' && p[2] === 'type';
    });
    const typeOpts = typeSel ? Array.from(typeSel.options).map((o) => o.textContent).join('|') : '';
    check(
      'device type is chosen from the 15 types by display name',
      !!typeSel && typeSel.value === 'firewall' && typeOpts === 'Select device type|' + DEVICE_TYPES.map((t) => t.label).join('|') && typeSel.options.length === 16,
      typeOpts,
    );
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

    // ------------------------------------ selection context in the element lists
    {
      const olItems = (): HTMLButtonElement[] => Array.from(doc.querySelectorAll('#outline-body .ol-item[data-ref]')) as HTMLButtonElement[];
      const total = olItems().length;
      const olBtn = (ref: string): HTMLButtonElement | null => doc.querySelector(`#outline-body .ol-item[data-ref="${ref}"]`) as HTMLButtonElement | null;
      // outline and diagram agree with the model-derived context; nothing hidden, reordered or disabled
      const ctxOk = (ref: string): [boolean, string] => {
        const s = app.session!;
        const ctx = selectionContext(s.model, ref);
        const keep = relatedRefs(s.model, ref);
        const bad: string[] = [];
        if (!ctx || s.state.selected !== (ref.indexOf('hub:') === 0 ? 'relation:' + ref.slice(4) : ref)) bad.push('session selection ' + s.state.selected);
        const items = olItems();
        if (items.length !== total) bad.push(`entries ${items.length}/${total}`);
        for (const b of items) {
          const r = b.getAttribute('data-ref') as string;
          const want = contextState(ctx, r);
          if (b.getAttribute('data-ctx') !== want) bad.push(`${r}: ${b.getAttribute('data-ctx')} ≠ ${want}`);
          if (b.disabled || b.tabIndex < 0 || b.hidden || doc.defaultView!.getComputedStyle(b).display === 'none' || doc.defaultView!.getComputedStyle(b).visibility !== 'visible') bad.push(r + ' not usable');
        }
        if (doc.querySelectorAll('#outline-body .ctx-selected').length !== 1) bad.push('not exactly one selected entry');
        const hint = q('#outline-body .ol-ctx-hint');
        if (!hint || hint.getAttribute('data-related') !== String(ctx ? ctx.related.size : -1)) bad.push('hint');
        // the diagram highlights (at least) the list context, and nothing outside relatedRefs
        const drawn = Array.from(doc.querySelectorAll('#viewport [data-ref]'));
        for (const e of drawn) {
          const r = e.getAttribute('data-ref') as string;
          if (e.classList.contains('hl') !== keep.has(r)) bad.push('diagram ' + r);
          if (ctx && (r === ctx.selected || ctx.related.has(r)) && !e.classList.contains('hl')) bad.push('diagram misses ' + r);
        }
        return [!bad.length, bad.slice(0, 6).join('; ')];
      };
      const stateOf = (ref: string): string | null => (olBtn(ref) ? olBtn(ref)!.getAttribute('data-ctx') : 'missing');
      const clickDevice = (ref: string): void => {
        const box = q(`#viewport g.device[data-ref="${ref}"] .dev-box`) as unknown as SVGGraphicsElement;
        const b = box.getBoundingClientRect();
        box.dispatchEvent(pe('pointerdown', b.left + b.width / 2, b.top + b.height / 2));
        svg.dispatchEvent(pe('pointerup', b.left + b.width / 2, b.top + b.height / 2));
      };

      check('no selection: list entries at normal prominence', olItems().every((b) => !b.hasAttribute('data-ctx')) && !q('#outline-body .ol-ctx-hint'));
      clickDevice('device:muc-sw');
      let [ok, why] = ctxOk('device:muc-sw');
      check('diagram click on muc-sw: lists and diagram show the same selection context', ok, why);
      check(
        '… muc-sw selected; its cables and group directly related; the neighbour router (only via a cable) and others dimmed',
        stateOf('device:muc-sw') === 'selected' && stateOf('link:l-muc-sw') === 'related' && stateOf('link:l-muc-ap') === 'related' && stateOf('group:branch-muc') === 'related' &&
          stateOf('device:muc-rtr') === 'unrelated' && stateOf('device:hq-fw') === 'unrelated' && stateOf('relation:ospf-muc') === 'unrelated',
      );
      const selEl = olBtn('device:muc-sw')!;
      const relEl = olBtn('link:l-muc-sw')!;
      const unEl = olBtn('device:hq-fw')!;
      const view = doc.defaultView!;
      check(
        'states differ without colour: marker / bar / weight, and text for screen readers',
        selEl.getAttribute('aria-current') === 'true' && !!selEl.querySelector('.ctx-mark.sel') && view.getComputedStyle(selEl).fontWeight === '600' && view.getComputedStyle(selEl).boxShadow !== 'none' &&
          !!relEl.querySelector('.ctx-mark.rel') && !unEl.querySelector('.ctx-mark') &&
          /\(selected\)/.test(selEl.textContent || '') && /\(directly related\)/.test(relEl.textContent || '') && /\(not related\)/.test(unEl.textContent || ''),
      );
      check('dimmed entries stay readable (not transparent, not hidden)', view.getComputedStyle(unEl).opacity === '1' && view.getComputedStyle(unEl).visibility === 'visible');
      unEl.focus();
      const focused = doc.activeElement === unEl;
      unEl.click();
      [ok, why] = ctxOk('device:hq-fw');
      check('an unrelated entry is focusable and selectable; the context moves to it', focused && ok && stateOf('device:hq-fw') === 'selected' && stateOf('device:muc-sw') === 'unrelated', why);

      const fromOutline: Array<[string, () => boolean]> = [
        ['link:l-muc-sw', () => stateOf('device:muc-sw') === 'related' && stateOf('device:muc-rtr') === 'related' && stateOf('link:l-muc-ap') === 'unrelated'],
        ['network:net-transit', () => stateOf('device:hq-rtr1') === 'related' && stateOf('relation:ospf-hq-area0') === 'related' && stateOf('device:muc-rtr') === 'unrelated'],
        // carried over IPsec directly; the cables IPsec rides on are only indirect (the diagram still shows that path)
        ['relation:gre-muc', () => stateOf('relation:ipsec-muc') === 'related' && stateOf('relation:ospf-muc') === 'related' && stateOf('link:l-muc-inet') === 'unrelated' && count('.cable.hl') === 3],
        ['group:hq-core', () => stateOf('device:hq-core1') === 'related' && stateOf('group:hq') === 'related' && stateOf('group:hq-edge') === 'unrelated' && stateOf('device:hq-rtr1') === 'unrelated'],
        ['protocol:macsec', () => stateOf('relation:macsec-peer') === 'related' && stateOf('device:hq-core1') === 'unrelated' && count('g.rel.proto-macsec.hl') + count('.hl') > 0],
        ['device:muc-sw', () => stateOf('link:l-muc-sw') === 'related'],
      ];
      for (const [ref, extra] of fromOutline) {
        olBtn(ref)!.click();
        [ok, why] = ctxOk(ref);
        check(`selecting ${ref.split(':')[0]} ${ref.split(':')[1]} from the list: direct relations related, indirect ones dimmed`, ok && extra(), why);
      }
      app.select('relation:gre-muc');
      click('[data-view-btn="logical"]');
      [ok, why] = ctxOk('relation:gre-muc');
      check('switching to the logical view keeps lists and diagram consistent (no stale highlighting)', ok, why);
      app.showTab('relations');
      const li = (r: string): string => {
        const b = q(`#side-body .rel-list button.ref[data-goto="${r}"]`);
        return b && b.parentElement ? b.parentElement.className : 'missing';
      };
      check('right-hand Relations list shows the same context', li('relation:gre-muc') === 'ctx-selected' && li('relation:ipsec-muc') === 'ctx-related' && li('relation:syslog-fw') === 'ctx-unrelated', [li('relation:gre-muc'), li('relation:ipsec-muc'), li('relation:syslog-fw')].join(' '));
      (q('#side-body .rel-list button.ref[data-goto="relation:ospf-muc"]') as HTMLButtonElement).click();
      [ok, why] = ctxOk('relation:ospf-muc');
      check('selecting in the right-hand list updates the left list and the diagram', ok && stateOf('relation:ospf-muc') === 'selected' && stateOf('relation:gre-muc') === 'related', why);
      click('[data-view-btn="physical"]');
      [ok, why] = ctxOk('relation:ospf-muc');
      check('… and switching back to the physical view as well', ok, why);
      app.select('iface:muc-rtr:wan0');
      [ok, why] = ctxOk('iface:muc-rtr:wan0');
      check('selecting a port marks its device; its cable and relations are related', ok && stateOf('device:muc-rtr') === 'selected' && stateOf('link:l-muc-inet') === 'related' && stateOf('relation:ipsec-muc') === 'related' && stateOf('link:l-muc-sw') === 'unrelated', why);
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check(
        'clearing the selection returns every entry to normal prominence',
        app.session!.state.selected === null && olItems().every((b) => !b.hasAttribute('data-ctx')) && !q('#outline-body .ol-ctx-hint') && count('.dim') === 0 && count('.hl') === 0,
      );
    }

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
    check(
      'New creates an empty, valid model: nothing is chosen for the user',
      !!d0 && d0.origin === 'new' && d0.valid && !d0.dirty && d0.exportText() === 'netatlas: 1\ntitle: New network\n' && !!q('#side-body .hint-empty'),
      d0 ? d0.exportText() : '',
    );
    check('status of a new model: both views "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto');
    // the first device: no type preselected, and nothing saved for it
    click('#outline [data-act="add-entity"][data-kind="device"]');
    await tick();
    const devType = '#side-body select[data-p=\'["devices",0,"type"]\']';
    {
      const sel = q(devType) as HTMLSelectElement | null;
      const dn = app.mdoc as ModelDoc;
      check(
        'a new device has no type: the field reads "Select device type" and no type is saved or drawn',
        !!sel && sel.value === '' && sel.options[sel.selectedIndex].textContent === 'Select device type' && sel.classList.contains('unset') &&
          !/type:/.test(dn.exportText()) && dn.valid && !!dn.result.model && dn.result.model.devices[0].type === 'generic' && count('g.device .icon-generic') === 1,
        dn.exportText(),
      );
    }
    await setField('#side-body [data-t="id"]', 'router1');
    await setField(devType, 'router');
    {
      const dn = app.mdoc as ModelDoc;
      const sel = q(devType) as HTMLSelectElement | null;
      check(
        'choosing a device type saves exactly that value',
        /- id: router1\n {4}type: router\n/.test(dn.exportText()) && dn.result.model!.devices[0].type === 'router' && !!sel && sel.value === 'router' && !sel.classList.contains('unset') && count('g.device .icon-router') === 1,
        dn.exportText(),
      );
    }
    click('#side-body [data-act="add-loop"]');
    await tick();
    await setField('#side-body [data-t="list-append"][data-p=\'["devices",0,"interfaces",0,"ip"]\']', '10.255.0.1/32');
    await setField('#side-body [data-p=\'["devices",0,"router_id"]\']', 'lo0');
    click('[data-view-btn="logical"]');
    check('new model: loopback chip with router-ID marker in the logical view', count('.loop-chip.rid') === 1 && (app.mdoc as ModelDoc).valid);

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
    {
      const dr = app.mdoc as ModelDoc;
      const inp = q('#side-body [data-p=\'["relations",0,"protocol"]\']') as HTMLInputElement | null;
      const errs = dr.errors.map((e) => e.message).join(' | ');
      const fieldErr = Array.prototype.map.call(doc.querySelectorAll('#side-body .field-err'), (e: Element) => e.textContent).join(' | ');
      check(
        'a new relation has no protocol: empty field with a prompt; missing protocol and endpoints are reported',
        !!inp && inp.value === '' && inp.placeholder === 'Select or type a protocol' && !/protocol:/.test(dr.exportText()) &&
          /missing required key "protocol"/.test(errs) && /at least 2 endpoints/.test(errs) && /protocol/.test(fieldErr) && count('g.rel') === 0,
        errs + ' // ' + fieldErr,
      );
      click('#btn-download');
      await tick(10);
      check('the incomplete relation makes export warn explicitly ("Download anyway")', /has errors/.test(q('#modal h2')!.textContent || '') && !!q('#modal [data-value="download"].danger'));
      await answerDialog('cancel');
    }
    await setField('#side-body [data-p=\'["relations",0,"protocol"]\']', 'gre');
    check('choosing a protocol saves exactly that value', /protocol: gre\n/.test((app.mdoc as ModelDoc).exportText()));
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

    // ------------------- derived, read-only values: members and interface VLANs
    // an IP network is only its prefixes (and a VLAN); who belongs to it is computed
    click('#outline [data-act="add-entity"][data-kind="network"]');
    await tick();
    const text = (sel: string): string => (q(sel) || { textContent: '' }).textContent || '';
    const readOnly = (sel: string): boolean => !!q(sel) && !q(sel)!.querySelector('input, select, textarea, [data-act]');
    const members = '#side-body [data-derived="members"]';
    const ifVlan = (dev: number, k: number): string => `#side-body [data-card='["devices",${dev},"interfaces",${k}]'] [data-derived="iface-vlan"]`;
    const selectDevice = async (i: number): Promise<void> => {
      click(`#outline [data-act="select"][data-kind="device"][data-index="${i}"]`);
      await tick();
    };
    const selectNetwork = async (i: number): Promise<void> => {
      click(`#outline [data-act="select"][data-kind="network"][data-index="${i}"]`);
      await tick();
    };
    {
      const dn = app.mdoc as ModelDoc;
      check(
        'a new network is an id only: no kind, VRF or member fields, nothing invented; the member list is read-only',
        !q('#side-body [data-p=\'["networks",0,"kind"]\']') && !q('#side-body [data-p=\'["networks",0,"vrf"]\']') && !q('#side-body [data-p=\'["networks",0,"members"]\']') &&
          /- id: net1\n/.test(dn.exportText()) && !/kind:|vlan:|members:|cidr:/.test(dn.exportText()) && dn.valid && readOnly(members) && /Members \(0\)/.test(text(members)),
        dn.exportText() + ' // ' + text(members),
      );
      await setField('#side-body [data-t="list-append"][data-p=\'["networks",0,"cidr"]\']', '10.77.0.0/24');
      await setField('#side-body [data-t="int"][data-p=\'["networks",0,"vlan"]\']', '77');
      check('a prefix alone adds no member', /Members \(0\)/.test(text(members)) && count('.member') === 0 && /cidr: \[10\.77\.0\.0\/24\]\n {4}vlan: 77\n/.test((app.mdoc as ModelDoc).exportText()), (app.mdoc as ModelDoc).exportText());
      // an address on router1:eth0 makes router1 a member and gives the port the network's VLAN, at once
      await selectDevice(0);
      check('an interface without an address shows no derived network or VLAN (read-only)', readOnly(ifVlan(0, 1)) && /No address/.test(text(ifVlan(0, 1))), text(ifVlan(0, 1)));
      check(
        'interfaces have no editable VLAN, speed or media field',
        !q('#side-body [data-p=\'["devices",0,"interfaces",1,"vlan"]\']') && !q('#side-body [data-p=\'["devices",0,"interfaces",1,"speed"]\']') && !q('#side-body [data-p=\'["devices",0,"interfaces",1,"media"]\']') &&
          !q('#side-body [data-p=\'["devices",0,"interfaces",0,"speed"]\']'),
      );
      await setField('#side-body [data-t="list-append"][data-p=\'["devices",0,"interfaces",1,"ip"]\']', '10.77.0.1/24');
      check(
        'typing an address updates the interface\'s derived VLAN immediately (VLAN 77 from net1)',
        !!q(ifVlan(0, 1) + ' li[data-vlan="77"]') && /net1 · VLAN 77/.test(text(ifVlan(0, 1))) && readOnly(ifVlan(0, 1)),
        text(ifVlan(0, 1)),
      );
      check('a loopback outside every network derives nothing, and no VLAN is invented', !!q(ifVlan(0, 0) + ' li[data-vlan="none"]') && /no network contains it/.test(text(ifVlan(0, 0))), text(ifVlan(0, 0)));
      click('[data-view-btn="logical"]');
      check('… and the logical view draws the membership line at once', count('.member') === 1 && count('g.network') === 1, String(count('.member')));
      // the network's prefix decides: a different prefix length on the interface still matches
      await selectDevice(1);
      await setField('#side-body [data-t="list-append"][data-p=\'["devices",1,"interfaces",2,"ip"]\']', '10.77.0.2/16');
      await selectNetwork(0);
      check(
        'the network lists both devices once, with interface and address (own prefix length /16 does not matter)',
        /Members \(2\)/.test(text(members)) && doc.querySelectorAll(members + ' li[data-member]').length === 2 && /eth0 10\.77\.0\.1\/24/.test(text(members)) && /eth0 10\.77\.0\.2\/16/.test(text(members)) && count('.member') === 2,
        text(members),
      );
      // changing the network changes every derived value
      await setField('#side-body [data-t="int"][data-p=\'["networks",0,"vlan"]\']', '78');
      await selectDevice(0);
      check('changing the network\'s VLAN updates the interface immediately (78)', !!q(ifVlan(0, 1) + ' li[data-vlan="78"]'), text(ifVlan(0, 1)));
      // an overlapping network with another VLAN: an explicit ambiguity, nothing chosen
      click('#outline [data-act="add-entity"][data-kind="network"]');
      await tick();
      await setField('#side-body [data-t="list-append"][data-p=\'["networks",1,"cidr"]\']', '10.77.0.0/25');
      await setField('#side-body [data-t="int"][data-p=\'["networks",1,"vlan"]\']', '99');
      await selectDevice(0);
      {
        const da = app.mdoc as ModelDoc;
        check(
          'overlapping networks with different VLANs: the interface shows an explicit ambiguity and a warning, no VLAN is picked',
          !!q(ifVlan(0, 1) + ' li[data-vlan="ambiguous"]') && /VLAN 78 \(net1\) or VLAN 99 \(net2\)/.test(text(ifVlan(0, 1))) && da.valid && da.warnings.some((w) => /ambiguous/.test(w.message)),
          text(ifVlan(0, 1)),
        );
      }
      await selectNetwork(1);
      await setField('#side-body [data-t="list-item"][data-p=\'["networks",1,"cidr",0]\']', '10.99.0.0/24');
      await selectDevice(0);
      check('moving the second network away resolves it again (VLAN 78), and membership follows', !!q(ifVlan(0, 1) + ' li[data-vlan="78"]') && count('.member') === 2, text(ifVlan(0, 1)));
      const ex = (app.mdoc as ModelDoc).exportText();
      check('derived members and interface VLANs are never written to the YAML', !/members:|kind:/.test(ex) && (ex.match(/vlan: /g) || []).length === 2 && !/eth0[^\n]*vlan/.test(ex), ex);
    }

    // ------------------------------------ per-end VLANs on a link (trunk)
    {
      click('#outline [data-act="select"][data-kind="link"][data-index="0"]');
      await tick();
      const end = (side: string): string => `#side-body [data-vlan-end="${side}"]`;
      const st = (side: string): string => (q(end(side)) || { getAttribute: () => '' }).getAttribute('data-vlan-state') || '';
      const mismatch = (): string => (q('#side-body [data-vlan-mismatch]') || { getAttribute: () => '' }).getAttribute('data-vlan-mismatch') || '';
      const addTo = (side: string): string => `#side-body [data-t="vlan-add"][data-p='["links",0,"${side}"]']`;
      const lk = (): { a: number[]; b: number[] } => {
        const l = (app.mdoc as ModelDoc).result.model!.links[0];
        return { a: l.a.vlans, b: l.b.vlans };
      };
      check('a link end without VLANs says "No VLAN"; none is assumed', st('A') === 'none' && st('B') === 'none' && /No VLAN/.test(text(end('A'))) && mismatch() === 'no' && !/vlans/.test((app.mdoc as ModelDoc).exportText()));
      check('speed and medium are fields of the link', !!q('#side-body [data-p=\'["links",0,"speed"]\']') && !!q('#side-body [data-p=\'["links",0,"medium"]\']'));
      await setField(addTo('a'), '10, 20');
      check(
        'several VLANs on end A: labelled Trunk with its IDs; end B is not touched',
        st('A') === 'trunk' && /Trunk · VLANs 10, 20/.test(text(end('A'))) && st('B') === 'none' && JSON.stringify(lk()) === '{"a":[10,20],"b":[]}' &&
          /a: \{device: router1, interface: eth0, vlans: \[10, 20\]\}, b: edge2:eth0/.test((app.mdoc as ModelDoc).exportText()),
        (app.mdoc as ModelDoc).exportText(),
      );
      click('[data-view-btn="physical"]');
      check(
        'the difference between the ends is highlighted (editor, problems, physical view) and not repaired',
        mismatch() === 'yes' && /only on end A: 10, 20/.test(text('#side-body [data-vlan-mismatch]')) && (app.mdoc as ModelDoc).warnings.some((w) => /VLAN mismatch/.test(w.message)) && count('.cable.vlan-mismatch') === 1 && count('.vlan-warn') === 1,
        text('#side-body [data-vlan-mismatch]'),
      );
      // end B: pick a network's VLAN from the list -> a single VLAN
      await setField('#side-body select[data-t="vlan-pick"][data-p=\'["links",0,"b"]\']', '78');
      check('one VLAN on end B (picked from the networks\' VLANs): shown as a single VLAN, not a trunk', st('B') === 'single' && /VLAN 78/.test(text(end('B'))) && !/Trunk/.test(text(end('B'))) && JSON.stringify(lk()) === '{"a":[10,20],"b":[78]}' && mismatch() === 'yes');
      await setField(addTo('b'), '10 20');
      click('#side-body [data-act="del-vlan"][data-p=\'["links",0,"b"]\'][data-k="78"]');
      await tick();
      check('both ends permit the same VLANs: no mismatch, the cable is a trunk', JSON.stringify(lk()) === '{"a":[10,20],"b":[10,20]}' && mismatch() === 'no' && st('B') === 'trunk' && count('.cable.vlan-mismatch') === 0 && count('.vlan-warn') === 0 && !(app.mdoc as ModelDoc).warnings.some((w) => /VLAN mismatch/.test(w.message)));
      click('#side-body [data-act="del-vlan"][data-p=\'["links",0,"a"]\'][data-k="20"]');
      await tick();
      check('removing a VLAN from one end leaves the other end as it was (mismatch shown again)', JSON.stringify(lk()) === '{"a":[10],"b":[10,20]}' && st('A') === 'single' && st('B') === 'trunk' && mismatch() === 'yes');
      await setField(addTo('a'), '4095');
      check('an invalid VLAN ID is refused and nothing changes', JSON.stringify(lk()) === '{"a":[10],"b":[10,20]}' && /1 to 4094/.test(q('#toast')!.textContent || ''), q('#toast')!.textContent || '');
      await setField(addTo('a'), '20');
      check('link-end VLANs and network VLANs stay separate facts', (app.mdoc as ModelDoc).result.model!.networks[0].vlan === 78 && JSON.stringify(lk()) === '{"a":[10,20],"b":[10,20]}');
      click('[data-view-btn="logical"]');
    }

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
      check(
        'export → reload: per-end VLANs are in the file; members and interface VLANs are derived again, not stored',
        !!rm && JSON.stringify([rm.links[0].a.vlans, rm.links[0].b.vlans]) === '[[10,20],[10,20]]' && networkMembers(rm, 'net1').map((m) => m.device).join() === 'router1,edge2' &&
          interfaceVlanText(interfaceAddresses(rm, 'router1', 'eth0')) === 'VLAN 78' && !/members:|kind:/.test(created.text) && /b: \{device: edge2, interface: eth0, vlans: \[10, 20\]\}/.test(created.text),
        created.text);
      if (rd) {
        app.loadText(created.text, 'reloaded.yaml', 'file');
        click('[data-view-btn="physical"]');
        const physOk = count('.cable') === 1 && count('.vlan-warn') === 0;
        click('[data-view-btn="logical"]');
        check('… and both views draw the reloaded file the same way (cable without mismatch; 2 membership lines)', physOk && count('.member') === 2 && count('g.network') === 2, `${count('.member')} member lines`);
      }
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

    // keys of the earlier format are rejected with what to do instead (never read or converted)
    {
      const oldFile = app.loadText(
        'netatlas: 1\ngroups:\n  - {id: g1, kind: row}\ndevices:\n  - id: r1\n    interfaces: [{id: e0, speed: 1G, media: fiber, vlan: 5, ip: 10.0.0.1/24}]\nnetworks:\n  - {id: n1, kind: vlan, vrf: red, cidr: 10.0.0.0/24, members: [r1]}\n',
        'old-format.yaml',
        'file',
      );
      const msgs = oldFile.errors.map((e) => e.message).join(' | ');
      check(
        'a file in the earlier format opens as a draft with one actionable error per retired key',
        oldFile.ok && oldFile.errors.length === 7 && /"speed" is no longer part of the format/.test(msgs) && /"members" is no longer part of the format/.test(msgs) && /renamed to "floor"/.test(msgs) &&
          (app.mdoc as ModelDoc).result.model!.networks[0].vlan === undefined && networkMembers((app.mdoc as ModelDoc).result.model!, 'n1').length === 1,
        msgs,
      );
    }

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

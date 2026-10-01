/**
 * In-browser end-to-end self-test, run by opening the built file with
 * "#selftest" appended to the URL (see scripts/browser-selftest.mjs).
 * It drives the real UI and DOM: loads every embedded example through the
 * same code paths as the file picker, switches views, and uses the editor
 * exactly like a user would (outline buttons, form fields, dialogs), then
 * checks what was drawn and what gets exported. It also verifies label
 * safety, error reporting and that the page made no network requests.
 */
import { Device, Interface } from '../model/types';
import { ModelDoc } from '../editor/document';
import { DEVICE_TYPES } from '../model/device-types';
import { interfaceAddresses, interfaceVlanText, networkMembers } from '../model/derive';
import { contextState, relatedRefs, selectionContext } from '../model/queries';
import { strNode } from '../yaml/parse';
import { EXAMPLES, FIXTURES } from '../generated/examples';
import { PNG_MAX_PIXELS, PNG_MAX_SIDE, pngScale, svgToPng } from '../ui/files';
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
    // if the run never finishes, the page still says how far it got
    doc.body.setAttribute('data-selftest-last', `${checks.length}: ${name}`);
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
  /** layout status of a view, as tracked on the Auto-arrange button: "auto" | "manual" | "edited" */
  const status = (v: 'physical' | 'logical'): string => (q('#btn-arrange') || { getAttribute: () => '' }).getAttribute('data-status-' + v) || '';
  /** what the Auto-arrange button shows for the view on screen: status, icon, hover text, accessible description */
  const shown = (): { view: string; st: string; icon: string; title: string; desc: string } => {
    const b = q('#btn-arrange') as HTMLButtonElement;
    const d = doc.getElementById(b.getAttribute('aria-describedby') || '');
    return { view: b.getAttribute('data-view') || '', st: b.getAttribute('data-status') || '', icon: (b.querySelector('.arrange-icon') as HTMLElement).textContent || '', title: b.title, desc: d ? d.textContent || '' : '' };
  };
  const AUTO_MSG = 'This view matches the auto-arranged layout.';
  const MANUAL_MSG = 'This view has manually adjusted positions. Auto-arrange replaces them after a confirmation.';
  /** the button shows `st` for `view`: icon, hover text and description agree */
  const shows = (view: string, st: 'auto' | 'manual'): boolean => {
    const x = shown();
    const msg = st === 'auto' ? AUTO_MSG : MANUAL_MSG;
    return x.view === view && x.st === st && x.icon === (st === 'auto' ? '\u2713' : '\u270E') && x.title.indexOf(msg) === 0 && x.desc === msg && x.st === status(view as 'physical' | 'logical');
  };
  /**
   * What a reader would see as wrong in the drawn diagram, measured with the
   * browser's real font metrics (getBBox): text outside its box, overlapping
   * boxes, labels on top of each other or of a node, a shortened label.
   */
  const drawnProblems = (rootSel = '#viewport'): string[] => {
    const root = q(rootSel) as unknown as SVGGElement;
    const out: string[] = [];
    type R = { x: number; y: number; w: number; h: number };
    const bb = (e: Element): R => {
      const b = (e as SVGGraphicsElement).getBBox();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const inside = (a: R, b: R): boolean => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
    const hit = (a: R, b: R): boolean => a.x + 1 < b.x + b.w && b.x + 1 < a.x + a.w && a.y + 1 < b.y + b.h && b.y + 1 < a.y + a.h;
    const each = (sel: string, fn: (e: Element) => void): void => Array.prototype.forEach.call(root.querySelectorAll(sel), fn);
    const boxed = (group: string, box: string, text: string): void =>
      each(group, (g) => {
        const frame = g.querySelector(box);
        if (!frame) return;
        Array.prototype.forEach.call(g.querySelectorAll(text), (t: Element) => {
          if (!inside(bb(t), bb(frame))) out.push(`"${t.textContent}" leaves its box (${Math.round(bb(t).w)} > ${Math.round(bb(frame).w)}; text x ${Math.round(bb(t).x)}, box x ${Math.round(bb(frame).x)})`);
        });
      });
    boxed('g.device', '.dev-box', 'text');
    boxed('g.network', '.net-box', 'text');
    boxed('g.group', '.group-box', '.group-title');
    boxed('g.pill', '.pill-box', 'text');
    boxed('g.loop-chip', 'rect', 'text');
    each('text', (t) => {
      if (/…$|\.\.\.$/.test(t.textContent || '')) out.push(`shortened text "${t.textContent}"`);
    });
    const nodes: Array<[string, R]> = [];
    each('g.device .dev-box, g.network .net-box', (e) => nodes.push([(e.parentElement as Element).getAttribute('data-ref') || '', bb(e)]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (hit(nodes[i][1], nodes[j][1])) out.push(`${nodes[i][0]} overlaps ${nodes[j][0]}`);
    const labels: Array<[string, R]> = [];
    each('g.pill .pill-box, text.link-label, text.member-label', (e) => labels.push([(e.textContent || (e.parentElement as Element).textContent || '').slice(0, 40), bb(e)]));
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) if (hit(labels[i][1], labels[j][1])) out.push(`labels overlap: "${labels[i][0]}" / "${labels[j][0]}"`);
      for (const n of nodes) if (hit(labels[i][1], n[1])) out.push(`label "${labels[i][0]}" covers ${n[0]}`);
    }
    return out;
  };

  let violations = 0;
  doc.addEventListener('securitypolicyviolation', () => violations++);
  // capture downloads instead of saving them
  const downloads: Array<{ name: string; text: string }> = [];
  /** downloaded pictures that are not text (PNG), by file name */
  const pictures = new Map<string, Blob>();
  const origCreate = URL.createObjectURL;
  const pendingBlobs: Blob[] = [];
  URL.createObjectURL = (b: Blob | MediaSource): string => {
    pendingBlobs.push(b as Blob);
    return 'blob:selftest';
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    const blob = pendingBlobs.shift();
    if (!blob) return;
    if (blob.type === 'image/png') {
      pictures.set(this.download, blob);
      downloads.push({ name: this.download, text: '' });
    } else void blob.text().then((text) => downloads.push({ name: this.download, text }));
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
        'Auto-arrange button is in the top toolbar, visible and labelled (disabled, without a status, until a model is open); no separate status element',
        !!btn && !!btn.closest('header.topbar') && !!r && r.width > 40 && r.height > 10 && r.top < 60 && /^Auto-arrange/.test((btn.querySelector('.arrange-label')!.textContent || '').trim()) && btn.disabled &&
          shown().st === '' && shown().icon === '' && shown().desc === '' && !q('#layout-status') && !q('[data-view-status]') && !q('.lstat') &&
          doc.querySelectorAll('header.topbar [data-view-btn]').length === 2,
        btn ? (btn.textContent || '') + (btn.disabled ? ' (disabled)' : '') : 'missing',
      );
    }

    // ------------------------------------------------ main menu (toolbar)
    const textsOf = (sel: string): string[] => Array.prototype.map.call(doc.querySelectorAll(sel), (e: Element) => (e.textContent || '').trim()) as string[];
    /** show the entries of every section of the model outline (the tests below pick entries from all of them) */
    const expandOutline = (): void => {
      for (let n = 0; n < 2 && q('#outline [data-section][data-folded="true"]'); n++) click('#outline [data-act="fold-all"]');
    };
    {
      const bar = 'header.topbar';
      const menuBtn = q('#menu-btn') as HTMLButtonElement | null;
      const menu = q('#main-menu') as HTMLElement | null;
      const direct = ['#btn-undo', '#btn-redo', '[data-view-btn="physical"]', '[data-view-btn="logical"]', '#btn-arrange', '#search', '#menu-btn', '#export-btn'];
      check(
        'toolbar: logo and version, the File and Export menus, and undo/redo, Physical/Logical, Auto-arrange and Find as direct controls; no "Current model" button',
        !!q(bar + ' .brand svg') && /^v\d+\.\d+\.\d+/.test((q(bar + ' .brand .version') || { textContent: '' }).textContent || '') && !!menuBtn && /^File/.test((menuBtn.textContent || '').trim()) &&
          direct.every((d) => !!q(bar + ' ' + d) && !(q(bar + ' ' + d) as HTMLElement).closest('.dropdown') && (q(bar + ' ' + d) as HTMLElement).getBoundingClientRect().width > 10) &&
          !q('#btn-model') && !q('#model-badge') && !/Current model/.test((q(bar) as HTMLElement).textContent || ''),
      );
      check(
        'New, Open, Download and the examples are grouped in the File menu and nowhere else in the toolbar',
        !!menu && menu.hidden && menuBtn!.getAttribute('aria-expanded') === 'false' && ['#btn-new', '#open', '#btn-download', '#menu-examples'].every((x) => !!q('#main-menu ' + x)) && !q('#examples') && !q(bar + ' select') &&
          doc.querySelectorAll(bar + ' > button, ' + bar + ' > .btn-group > button').length === 2,
        String(doc.querySelectorAll(bar + ' > button, ' + bar + ' > .btn-group > button').length),
      );
      click('#menu-btn');
      const entries = textsOf('#main-menu button');
      const mr = menu!.getBoundingClientRect();
      check(
        'the File menu opens under its button with consistently named entries: New model, Open model…, Download model…, Close model, then the examples',
        !menu!.hidden && menuBtn!.getAttribute('aria-expanded') === 'true' && mr.height > 100 && mr.top >= menuBtn!.getBoundingClientRect().bottom - 1 && /^New model/.test(entries[0]) && /^Open model…$/.test(entries[1]) && /^Download model…/.test(entries[2]) && /Ctrl\+S$/.test(entries[2]) && entries[0] === 'New model' &&
          entries.length === 4 + EXAMPLES.length && entries[3] === 'Close model' && (q('#btn-close') as HTMLButtonElement).disabled && q('#btn-download')!.nextElementSibling === q('#btn-close') && entries.slice(4).join() === EXAMPLES.map((e) => e.name).join() && /Examples/.test(q('#menu-examples-title')!.textContent || '') && EXAMPLES.length === 6 && !/editor-new-network|minimal-edited|metro-ring-arranged/.test(menu!.textContent || '') && !/editor-new-network|minimal-edited|metro-ring-arranged/.test(q('#empty')!.textContent || '') && (q('#btn-download') as HTMLButtonElement).disabled,
        entries.join(' | '),
      );
      menuBtn!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const byEsc = menu!.hidden;
      click('#menu-btn');
      (q('#canvas') as unknown as Element).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9 }));
      const byOutside = menu!.hidden;
      menuBtn!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const focused = doc.activeElement === q('#btn-new');
      (q('#btn-new') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const moved = doc.activeElement === q('#open');
      (q('#open') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check('the File menu closes with Escape and when something else is pressed; arrow keys open it and move between entries', byEsc && byOutside && focused && moved && menu!.hidden && doc.activeElement === menuBtn, `${byEsc} ${byOutside} ${focused} ${moved}`);
      // ------------------------------------------------ Export menu (nothing to export yet)
      {
        const exBtn = q('#export-btn') as HTMLButtonElement;
        const exMenu = q('#export-menu') as HTMLElement;
        const item = q('#btn-export-as') as HTMLButtonElement;
        const sub = q('#export-formats') as HTMLElement;
        click('#export-btn');
        const open = !exMenu.hidden && exBtn.getAttribute('aria-expanded') === 'true';
        const direct = (Array.prototype.filter.call(exMenu.children, (c: Element) => c.tagName === 'BUTTON') as HTMLElement[]).map((c) => (c.querySelector('.mi-label') as HTMLElement).textContent);
        check(
          'an Export menu sits next to File, built like it, with one entry "Export view as…" that is disabled while there is no diagram',
          !!exBtn && (q('#menu-btn') as HTMLElement).parentElement!.nextElementSibling === exBtn.parentElement && /^Export/.test((exBtn.textContent || '').trim()) && exBtn.className === (q('#menu-btn') as HTMLElement).className.replace(' active', '') + ' active' &&
            exMenu.className === menu!.className && exMenu.getAttribute('role') === 'menu' && open && direct.join('|') === 'Export view as…' && item.disabled && /Open or create a model first/.test(item.title) &&
            item.getAttribute('aria-haspopup') === 'menu' && item.getAttribute('aria-expanded') === 'false' && item.getAttribute('aria-controls') === sub.id && sub.hidden && sub.getAttribute('role') === 'menu' &&
            !q('#save-svg') && !/Save SVG/.test((q('main') as HTMLElement).textContent || '') && !/Save SVG/.test((q('header.topbar') as HTMLElement).textContent || ''),
          `${open} ${direct.join('|')} disabled=${item.disabled}`,
        );
        {
          // no model: the submenu cannot be opened, by pointer or by keyboard, and its formats are disabled too
          item.click();
          exBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          const nowhere = doc.activeElement === exBtn;
          const formats = ['#btn-export-png', '#btn-export-svg'].map((x) => q(x) as HTMLButtonElement);
          check(
            'without a model the submenu stays closed and PNG and SVG are disabled',
            sub.hidden && item.getAttribute('aria-expanded') === 'false' && nowhere && !exMenu.hidden && formats.every((b) => !!b && b.disabled && /Open or create a model first/.test(b.title)) && formats.map((b) => (b.querySelector('.mi-label') as HTMLElement).textContent).join('|') === 'PNG|SVG' && !/PDF/i.test(exMenu.textContent || ''),
            `${sub.hidden} ${nowhere} ${!exMenu.hidden} ${formats.map((b) => b.disabled + ' ' + b.title).join(' / ')}`,
          );
          for (const b of formats) b.click();
        }
        const before = downloads.length;
        item.click();
        exBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const closed = exMenu.hidden && exBtn.getAttribute('aria-expanded') === 'false';
        // one menu at a time, and the arrow keys move between the two menus
        click('#menu-btn');
        click('#export-btn');
        const oneOpen = menu!.hidden && !exMenu.hidden;
        exBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        const toFile = !menu!.hidden && exMenu.hidden && doc.activeElement === q('#btn-new');
        (q('#btn-new') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const toExport = menu!.hidden && !exMenu.hidden;
        (doc.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await tick(30);
        check('the disabled export does nothing; the Export menu closes with Escape; only one menu is open at a time and the left/right arrow keys switch between File and Export', downloads.length === before && closed && oneOpen && toFile && toExport && exMenu.hidden && menu!.hidden, `${downloads.length - before} ${closed} ${oneOpen} ${toFile} ${toExport}`);
      }

      // ------------------------------------------------ start screen
      {
        /** back to the start screen */
        const toStart = (): void => app.closeModel();
        const start = q('#empty') as HTMLElement;
        const shownNow = (e: HTMLElement | null): boolean => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
        const newBtn = q('#new-empty') as HTMLButtonElement;
        const openBtn = q('#open-empty') as HTMLButtonElement;
        const pick = q('#start-example') as HTMLSelectElement;
        const loadBtn = q('#start-load') as HTMLButtonElement;
        const startText = (start.textContent || '').replace(/\s+/g, ' ').trim();
        check(
          'start screen: the NetAtlas name with its logo and one sentence about the tool',
          doc.body.getAttribute('data-state') === 'empty' && shownNow(start) && (q('#empty h1') as HTMLElement).textContent === 'NetAtlas' && parseFloat(doc.defaultView!.getComputedStyle(q('#empty h1') as Element).fontSize) >= 24 &&
            shownNow(q('#empty .start-brand svg') as unknown as HTMLElement) && (q('#empty .start-tagline') as HTMLElement).textContent === 'Create and explore network architecture diagrams, fully offline.' && doc.querySelectorAll('#empty p').length === 2,
          startText,
        );
        const options = Array.prototype.map.call(pick.options, (o: HTMLOptionElement) => o.textContent) as string[];
        check(
          'start screen: three ways to begin — New model, Open YAML file (also the drop target), Load example from a picker',
          /^New model/.test((newBtn.textContent || '').trim()) && /^Open YAML file…/.test((openBtn.textContent || '').trim()) && /drop one here/.test(openBtn.textContent || '') && openBtn.classList.contains('start-drop') &&
            doc.defaultView!.getComputedStyle(openBtn).borderTopStyle === 'dashed' && (q('#empty label[for="start-example"]') as HTMLElement).textContent === 'Load example' && options[0] === 'Choose an example…' && options.length === 1 + EXAMPLES.length &&
            options.indexOf('Minimal example') === 3 && loadBtn.disabled && doc.querySelectorAll('#empty .start-card').length === 3 && [newBtn, openBtn, pick].every(shownNow),
          options.join(' | '),
        );
        check(
          'start screen: no row of example links, no file names, no fixtures, no long description; the privacy note is one short line',
          !q('#empty .linkish') && !q('#empty [data-example]') && !q('#empty a') && !/\.ya?ml/.test(startText.replace('YAML', '')) && !/editor-new-network|minimal-edited|metro-ring-arranged/.test(startText) &&
            !/Content-Security-Policy|physical|logical|GRE|IPsec/i.test(startText) && startText.length - options.join('').length < 260 && ((q('#empty .start-note') as HTMLElement).textContent || '').length < 50,
          `${startText.length - options.join('').length} characters besides the example names: ${startText}`,
        );
        // keyboard: every action is a native control, reachable with Tab in reading order
        const order = Array.prototype.filter.call(doc.querySelectorAll('#empty button, #empty select, #empty a, #empty input'), (e: HTMLElement) => e.tabIndex >= 0) as HTMLElement[];
        newBtn.focus();
        const focusable = doc.activeElement === newBtn;
        pick.focus();
        check(
          'start screen: all actions are keyboard-accessible (buttons and a select, in reading order, with visible names)',
          order.map((e) => e.id).join() === 'new-empty,open-empty,start-example,start-load' && focusable && doc.activeElement === pick && newBtn.tagName === 'BUTTON' && openBtn.tagName === 'BUTTON' && pick.tagName === 'SELECT' &&
            !!pick.labels && pick.labels.length === 1 && loadBtn.textContent === 'Load',
          order.map((e) => e.id).join(),
        );

        // New model: an empty model, and straight into the editor
        newBtn.click();
        await tick(10);
        check(
          'start screen → New model creates an empty model and opens it in the editor',
          doc.body.getAttribute('data-state') === 'loaded' && !shownNow(start) && !!app.mdoc && app.mdoc.origin === 'new' && app.mdoc.exportText() === 'netatlas: 1\ntitle: New network\n' && !!q('[data-tab="edit"].active') &&
            !!q('#side-body [data-p=\'["title"]\']') && !app.mdoc.dirty,
        );
        toStart();

        // Open YAML file: the file picker of the existing loader
        const inputClick = HTMLInputElement.prototype.click;
        let pickerOpened = 0;
        HTMLInputElement.prototype.click = function (this: HTMLInputElement): void {
          if (this.id === 'file') pickerOpened++;
        };
        openBtn.click();
        await tick(10);
        HTMLInputElement.prototype.click = inputClick;
        check('start screen → Open YAML file opens the file picker (for .yaml / .yml files)', pickerOpened === 1 && /\.yaml/.test((q('#file') as HTMLInputElement).accept) && doc.body.getAttribute('data-state') === 'empty');

        // drag and drop: the page takes over every drag, so the browser never navigates to a dropped file
        const dragEvent = (type: string, files: File[], text?: string): DragEvent => {
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          if (text !== undefined) dt.setData('text/plain', text);
          return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        };
        /** wait until a dropped file has been read and handled (reading a file is asynchronous) */
        const until = async (done: () => boolean): Promise<void> => {
          for (let n = 0; n < 100 && !done(); n++) await tick(10);
        };
        const idleBg = doc.defaultView!.getComputedStyle(openBtn).backgroundColor;
        const over = dragEvent('dragover', [new File(['x'], 'x.yaml')]);
        (q('#side') as HTMLElement).dispatchEvent(over);
        const marked = doc.body.classList.contains('dropping') && doc.defaultView!.getComputedStyle(openBtn).backgroundColor !== idleBg && doc.defaultView!.getComputedStyle(q('#drop-hint') as Element).display === 'none';
        doc.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
        check('dragging a file over the page marks the "Open YAML file" card as the drop target; the drag is taken over by the page', over.defaultPrevented && marked && !doc.body.classList.contains('dropping'), `${over.defaultPrevented} ${marked}`);

        const good = dragEvent('drop', [new File([EXAMPLES[2].text], 'dropped.yaml', { type: 'application/yaml' })]);
        (q('header.topbar') as HTMLElement).dispatchEvent(good);
        await until(() => !!app.mdoc);
        check(
          'dropping a YAML file anywhere on the page opens it (the same loader as the file picker); the browser does not navigate',
          good.defaultPrevented && !!app.mdoc && app.mdoc.fileName === 'dropped.yaml' && app.mdoc.origin === 'file' && app.mdoc.valid && doc.body.getAttribute('data-state') === 'loaded',
          `${good.defaultPrevented} ${app.mdoc ? app.mdoc.fileName + ' ' + app.mdoc.origin : 'no model'} ${doc.body.getAttribute('data-state')} files=${good.dataTransfer ? good.dataTransfer.files.length : -1}`,
        );
        toStart();

        const bad = dragEvent('drop', [new File(['netatlas: 1\ndevices:\n  - &x {id: a}\n'], 'broken.yaml')]);
        openBtn.dispatchEvent(bad);
        await until(() => doc.body.getAttribute('data-state') === 'error');
        const errText = (q('#errors') as HTMLElement).textContent || '';
        check(
          'an invalid file gives clear feedback: what could not be opened, where and why, and how to go on',
          bad.defaultPrevented && doc.body.getAttribute('data-state') === 'error' && !app.mdoc && shownNow(q('#errors')) && /Could not open broken\.yaml/.test(errText) && /line 3/i.test(errText) && /anchor/.test(errText) &&
            textsOf('#errors .error-actions button').join('|') === 'Open another YAML file…|New model|Back to the start screen',
          errText.slice(0, 300),
        );
        const notYaml = dragEvent('drop', [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01])], 'picture.png', { type: 'image/png' })]);
        doc.body.dispatchEvent(notYaml);
        await until(() => /picture\.png/.test((q('#errors') as HTMLElement).textContent || ''));
        const pngText = (q('#errors') as HTMLElement).textContent || '';
        click('#errors [data-act-top="start"]');
        check('a file that is not YAML at all is refused the same way, and "Back to the start screen" returns', notYaml.defaultPrevented && /Could not open picture\.png/.test(pngText) && doc.body.getAttribute('data-state') === 'empty' && shownNow(start) && !app.mdoc, pngText.slice(0, 200));
        const textDrop = dragEvent('drop', [], 'some text dragged from another window');
        (q('#canvas-wrap') as HTMLElement).dispatchEvent(textDrop);
        await tick(10);
        check('dropping something that is not a file (a link, text) changes nothing and says so', textDrop.defaultPrevented && doc.body.getAttribute('data-state') === 'empty' && /drop a YAML file/.test(q('#toast')!.textContent || '') && !(q('#toast') as HTMLElement).hidden);

        // Load example: choose, then load
        pick.value = '0';
        pick.dispatchEvent(new Event('change', { bubbles: true }));
        const browsing = doc.body.getAttribute('data-state') === 'empty' && !loadBtn.disabled;
        loadBtn.click();
        await tick(10);
        check('start screen → Load example: choosing enables "Load", and only "Load" (or Enter) opens the example', browsing && !!app.mdoc && app.mdoc.fileName === EXAMPLES[0].name && app.mdoc.origin === 'example' && pick.value === '' && loadBtn.disabled && !shownNow(start));
        toStart();
        pick.value = '2';
        pick.dispatchEvent(new Event('change', { bubbles: true }));
        pick.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await tick(10);
        check('… with the keyboard: Enter on the chosen example loads it', !!app.mdoc && app.mdoc.fileName === EXAMPLES[2].name);

        // replacing a model with unsaved changes is confirmed first, also for a dropped file
        app.mdoc!.setText(['title'], 'Unsaved work');
        const replacing = dragEvent('drop', [new File([EXAMPLES[0].text], 'other.yaml')]);
        doc.body.dispatchEvent(replacing);
        await tick(20);
        const asked = !!q('#modal[open]') && /Unsaved changes/.test(q('#modal')!.textContent || '') && /Opening the dropped file/.test(q('#modal')!.textContent || '');
        await answerDialog('cancel');
        await tick(30);
        check('a drop onto a model with unsaved changes asks first; Cancel keeps the model', replacing.defaultPrevented && asked && app.mdoc!.fileName === EXAMPLES[2].name && app.mdoc!.text(['title']) === 'Unsaved work' && app.mdoc!.dirty);
        app.mdoc!.undo();
        app.mdoc!.markSaved();

        // Export: enabled with a diagram, and it exports the view that is selected
        const item = q('#btn-export-as') as HTMLButtonElement;
        const sub = q('#export-formats') as HTMLElement;
        const exBtn = q('#export-btn') as HTMLButtonElement;
        const exMenu = q('#export-menu') as HTMLElement;
        const key = (target: HTMLElement, k: string): void => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        (app as unknown as { updateChrome(): void }).updateChrome();
        {
          // pointer and touch: a press on the entry opens the submenu in place and keeps the menu; nothing depends on hovering
          click('#export-btn');
          for (const type of ['pointerenter', 'mouseenter', 'mouseover', 'pointermove']) item.dispatchEvent(new MouseEvent(type, { bubbles: true }));
          const notOnHover = sub.hidden;
          item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
          const byPress = !sub.hidden && !exMenu.hidden && item.getAttribute('aria-expanded') === 'true';
          const sr = sub.getBoundingClientRect();
          const mr2 = exMenu.getBoundingClientRect();
          const inside = sr.height > 40 && sr.top >= item.getBoundingClientRect().bottom - 1 && sr.bottom <= mr2.bottom + 0.5 && sr.left >= mr2.left && sr.right <= mr2.right + 0.5 && mr2.right <= doc.documentElement.clientWidth;
          const sizes = ['#btn-export-png', '#btn-export-svg'].map((x) => (q(x) as HTMLElement).getBoundingClientRect().height);
          item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
          const toggled = sub.hidden && !exMenu.hidden && item.getAttribute('aria-expanded') === 'false';
          item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
          click('#export-btn');
          const collapsed = exMenu.hidden && sub.hidden && item.getAttribute('aria-expanded') === 'false';
          check(
            '"Export view as…" opens its submenu (PNG, SVG) when pressed, not on hover; the submenu opens inside the menu, within the window, with entries as tall as the other menu entries; pressing again closes it, and it is closed when the menu closes',
            notOnHover && byPress && inside && sizes.every((h) => Math.abs(h - item.getBoundingClientRect().height) < 0.5 || h >= 24) && sizes[0] === sizes[1] && toggled && collapsed,
            `${notOnHover} ${byPress} ${inside} ${sizes.join('/')} ${toggled} ${collapsed}`,
          );
          // keyboard: arrow down onto the entry, arrow right (or Enter/Space, a click without a pointer) opens and enters the submenu
          exBtn.focus();
          key(exBtn, 'ArrowDown');
          const onEntry = doc.activeElement === item && sub.hidden;
          key(item, 'ArrowDown');
          const staysOnEntry = doc.activeElement === item;
          key(item, 'ArrowRight');
          const entered = !sub.hidden && doc.activeElement === q('#btn-export-png');
          key(doc.activeElement as HTMLElement, 'ArrowDown');
          const toSvg = doc.activeElement === q('#btn-export-svg');
          key(doc.activeElement as HTMLElement, 'ArrowDown');
          const wraps = doc.activeElement === item;
          key(doc.activeElement as HTMLElement, 'ArrowUp');
          const back = doc.activeElement === q('#btn-export-svg');
          key(doc.activeElement as HTMLElement, 'ArrowLeft');
          const left = sub.hidden && doc.activeElement === item && !exMenu.hidden;
          item.click(); // Enter or Space on a button is a click without a pointer position
          const byEnter = !sub.hidden && doc.activeElement === q('#btn-export-png');
          key(doc.activeElement as HTMLElement, 'Escape');
          const escSub = sub.hidden && doc.activeElement === item && !exMenu.hidden;
          key(item, 'Escape');
          const escMenu = exMenu.hidden && doc.activeElement === exBtn;
          check(
            'keyboard: arrow keys reach "Export view as…"; arrow right, Enter or Space open the submenu and move into it; up/down move through PNG and SVG; arrow left or Escape return to the entry, Escape again closes the menu',
            onEntry && staysOnEntry && entered && toSvg && wraps && back && left && byEnter && escSub && escMenu,
            [onEntry, staysOnEntry, entered, toSvg, wraps, back, left, byEnter, escSub, escMenu].join(' '),
          );
        }
        const names: string[] = [];
        const same: boolean[] = [];
        for (const view of ['logical', 'physical']) {
          click(`[data-view-btn="${view}"]`);
          for (const fmt of ['svg', 'png']) {
            const b = q('#btn-export-' + fmt) as HTMLButtonElement;
            click('#export-btn');
            item.click();
            const enabled = !item.disabled && !b.disabled && !sub.hidden && new RegExp(view).test(item.title) && new RegExp(view).test(b.title);
            const expected = app.exportSvg();
            const had = downloads.length;
            b.click();
            const closedAtOnce = exMenu.hidden && sub.hidden;
            for (let n = 0; n < 300 && downloads.length === had; n++) await tick(10);
            const got = downloads.length > had ? downloads[downloads.length - 1] : undefined;
            names.push(got ? got.name : '?');
            const said = new RegExp(`Exported “minimal-${view}\\.${fmt}”`).test(q('#toast')!.textContent || '');
            if (fmt === 'svg') same.push(enabled && closedAtOnce && said && !!got && got.text === expected && new RegExp(`Legend — ${view} view`).test(got.text) && new RegExp(`Networks — ${view} view`).test(got.text) && /class="svg-legend"/.test(got.text) && /class="svg-networks"/.test(got.text));
            else same.push(enabled && closedAtOnce && said && !!got && pictures.has(got.name) && pictures.get(got.name)!.size > 1000);
          }
        }
        check(
          'Export view as… → SVG / PNG exports whichever view is selected, named after the model and the view; the SVG has the same content as before (legend and Networks box); the menu closes and a message names the file',
          names.join() === 'minimal-logical.svg,minimal-logical.png,minimal-physical.svg,minimal-physical.png' && same.every((x) => x) && exMenu.hidden && downloads.length === downloads.filter((d) => d.name).length,
          names.join() + ' ' + same.join(),
        );
        check('the zoom bar has only zoom controls left', textsOf('.zoombar button').join('|') === '+|−|Fit' && !q('.zoombar #save-svg'));
        toStart();
      }

      // ------------------------------------------------ File → Close model
      {
        const closeBtn = q('#btn-close') as HTMLButtonElement;
        const onStart = (): boolean => doc.body.getAttribute('data-state') === 'empty' && !app.mdoc && !app.session && (q('#empty') as HTMLElement).getBoundingClientRect().height > 0;
        const dialogText = (): string => (q('#modal[open]') ? q('#modal')!.textContent || '' : '');
        const buttons = (): string => textsOf('#modal[open] .modal-btns button').join('|');
        const choose = async (): Promise<void> => {
          click('#menu-btn');
          closeBtn.click();
          await tick(20);
        };

        // a clean model closes at once: a new model, an opened file and an example alike
        const clean: string[] = [];
        click('#btn-new');
        await tick(10);
        const enabled = !closeBtn.disabled;
        await choose();
        clean.push(`new:${!q('#modal[open]') && onStart()}`);
        await app.loadFile(new File([EXAMPLES[2].text], 'mine.yaml'));
        await choose();
        clean.push(`file:${!q('#modal[open]') && onStart()}`);
        app.loadExample(0);
        await choose();
        clean.push(`example:${!q('#modal[open]') && onStart()}`);
        check('Close model is available once a model is open, and a model without unsaved changes closes at once and shows the start screen (new model, opened file, example)', enabled && closeBtn.disabled && clean.join() === 'new:true,file:true,example:true' && (q('#main-menu') as HTMLElement).hidden, clean.join());

        // unsaved changes: three choices. Cancel leaves the model and the editor untouched.
        await app.loadFile(new File([EXAMPLES[2].text], 'mine.yaml'));
        app.select('device:r1');
        await setField('#side-body [data-p=\'["devices",0,"label"]\']', 'Router one');
        click('[data-view-btn="logical"]');
        const kept = app.mdoc;
        const stateBefore = [app.exportText(), app.session!.state.view, app.session!.state.selected, (q('[data-tab].active') as HTMLElement).getAttribute('data-tab'), kept!.canUndo(), (q('#side-body [data-p=\'["devices",0,"label"]\']') as HTMLTextAreaElement).value].join('|');
        const had = downloads.length;
        await choose();
        const asked = dialogText();
        const offered = buttons();
        check(
          'closing a model with unsaved changes asks: Cancel, Discard changes, or Download and close; it says the download is a new file and the opened file is not overwritten',
          /Close the model with unsaved changes\?/.test(asked) && offered === 'Cancel|Discard changes|Download and close' && /“mine\.yaml” has changes that have not been downloaded/.test(asked) && /saves the current state as a new file, “mine-edited\.yaml”, in your browser’s downloads location; the file you opened is not overwritten/.test(asked) &&
            !/save (it )?(back )?to the original|overwrite the original/i.test(asked),
          offered + ' // ' + asked,
        );
        await answerDialog('cancel');
        await tick(30);
        const stateAfter = [app.exportText(), app.session!.state.view, app.session!.state.selected, (q('[data-tab].active') as HTMLElement).getAttribute('data-tab'), app.mdoc!.canUndo(), (q('#side-body [data-p=\'["devices",0,"label"]\']') as HTMLTextAreaElement).value].join('|');
        check('Cancel leaves the model and the editor untouched (same model, still unsaved, same view, selection, tab and form; nothing downloaded)', app.mdoc === kept && kept!.dirty && stateAfter === stateBefore && downloads.length === had && doc.body.getAttribute('data-state') === 'loaded');
        // Escape is Cancel
        await choose();
        (q('#modal') as HTMLElement).dispatchEvent(new Event('cancel', { cancelable: true }));
        await tick(30);
        check('… and so does Escape', app.mdoc === kept && kept!.dirty && !q('#modal[open]'));

        // Download and close: the YAML is exported first, then the start screen
        const yaml = app.exportText();
        await choose();
        await answerDialog('download');
        for (let n = 0; n < 40 && downloads.length === had; n++) await tick(10);
        const got = downloads[downloads.length - 1];
        check(
          'Download and close exports the current YAML (as a new file, not the original name) and then shows the start screen',
          downloads.length === had + 1 && !!got && got.name === 'mine-edited.yaml' && got.text === yaml && /label: Router one/.test(got.text) && onStart() && /Downloaded “mine-edited\.yaml”/.test(q('#toast')!.textContent || ''),
          got ? got.name : 'no download',
        );

        // Discard changes: nothing is exported
        app.loadExample(2);
        app.mdoc!.setText(['title'], 'Changed example');
        (app as unknown as { updateChrome(): void }).updateChrome();
        await choose();
        const exampleText = dialogText();
        await answerDialog('discard');
        await tick(30);
        check('Discard changes closes without exporting; for an example the prompt does not talk about an opened file', onStart() && downloads.length === had + 1 && /“minimal\.yaml” has changes/.test(exampleText) && /saves it as “minimal\.yaml”/.test(exampleText) && !/file you opened/.test(exampleText), exampleText);
        // a new model that was edited is asked about too, and keeps its errors in view
        click('#btn-new');
        await tick(10);
        app.mdoc!.addEntity('relation');
        (app as unknown as { afterEdit(n?: string): void }).afterEdit();
        await choose();
        const newText = dialogText();
        await answerDialog('cancel');
        await tick(20);
        check('a new model with unsaved changes is asked about as well, and the prompt mentions its validation errors', /“new-network\.yaml” has changes/.test(newText) && /The model has \d+ validation errors?\./.test(newText) && !!app.mdoc && app.mdoc.origin === 'new');
        app.mdoc!.markSaved();

        // closing clears what belonged to the model, so the next one starts clean
        app.loadExample(0);
        click('[data-view-btn="logical"]');
        app.select('device:hq-rtr1');
        click('#outline [data-act="fold-all"]');
        const filter = q('#outline [data-t="outline-filter"]') as HTMLInputElement;
        filter.value = 'hq';
        filter.dispatchEvent(new Event('input', { bubbles: true }));
        (q('#search') as HTMLInputElement).value = 'hq';
        (q('#search') as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
        (q('#opt-networks') as HTMLInputElement).click();
        click('#zoom-in');
        click('[data-tab="yaml"]');
        await choose();
        const gone = onStart() && doc.querySelectorAll('#viewport *').length === 0 && (q('#search') as HTMLInputElement).value === '' && (q('#search-results') as HTMLElement).hidden && doc.body.getAttribute('data-view') === 'none';
        app.loadExample(2);
        const foldedNow = (Array.prototype.map.call(doc.querySelectorAll('#outline [data-section]'), (e: Element) => e.getAttribute('data-section') + '=' + e.getAttribute('data-folded')) as string[]).join();
        check(
          'closing clears the selection and the view state: the next model opens in the physical view with nothing selected, no filter, default folding, all protocols and networks shown',
          gone && app.session!.state.view === 'physical' && app.session!.state.selected === null && app.session!.state.showNetworks && app.session!.state.hiddenProtocols.size === 0 && !q('#outline .ol-ctx-hint') &&
            (q('#outline [data-t="outline-filter"]') as HTMLInputElement).value === '' && foldedNow === 'device=false,link=true,network=false,relation=false,group=false,protocol=true' && !q('[data-tab="yaml"].active') && !q('[data-tab="edit"].active') && !app.mdoc!.dirty,
          `${gone} ${app.session!.state.view} ${app.session!.state.selected} ${foldedNow}`,
        );
        app.closeModel();
      }

      // ------------------------------------------------ + Port Range
      {
        click('#btn-new');
        await tick(10);
        click('#outline [data-act="add-entity"][data-kind="device"]');
        await tick();
        const m = (): ModelDoc => app.mdoc as ModelDoc;
        const ports = (): string[] => m().result.model!.devices[0].interfaces.map((i) => i.id);
        const type = async (sel: string, value: string): Promise<void> => {
          const i = q(sel) as HTMLInputElement;
          i.value = value;
          i.dispatchEvent(new Event('input', { bubbles: true }));
          await tick();
        };
        const create = (): HTMLButtonElement => q('#modal[open] [data-value="create"]') as HTMLButtonElement;
        const preview = (): string => (q('#range-preview') || { textContent: '' }).textContent || '';
        const head = '#side-body [data-list="interfaces"] .sub-head';
        check(
          '"+ Port Range" sits beside "+ Interface" in the Physical interfaces section',
          textsOf(head + ' button').join('|') === '+ Interface|+ Port Range' && !q('#side-body [data-list="logical"] [data-act="add-range"]'),
          textsOf(head + ' button').join('|'),
        );
        click(head + ' [data-act="add-range"]');
        await tick(20);
        check(
          'it asks for From and To names; nothing can be created until the range is valid',
          /Add a range of physical interfaces/.test(q('#modal')!.textContent || '') && !!q('#range-from') && !!q('#range-to') && textsOf('#modal .range-form label').join('|') === 'From|To' && create().disabled && doc.activeElement === q('#range-from') &&
            q('#range-preview')!.getAttribute('data-state') === 'empty',
        );
        await type('#range-from', 'ge 1/1');
        await type('#range-to', 'ge 1/24');
        const list = (q('#range-preview .range-list') || { textContent: '' }).textContent || '';
        check(
          'the preview lists the ports that will be created before anything is committed (ge 1/1 … ge 1/24), and says how they are stored',
          q('#range-preview')!.getAttribute('data-state') === 'ok' && /^24 physical interfaces will be created:/.test(preview()) && list.split(', ').length === 24 && /^ge 1\/1, ge 1\/2, ge 1\/3,/.test(list) && /ge 1\/23, ge 1\/24$/.test(list) &&
            /the ids are ge-1\/1 … ge-1\/24/.test(preview()) && !create().disabled && create().textContent === 'Create 24 ports' && ports().length === 0 && m().canUndo() === 'Add device',
          preview(),
        );
        const errors: string[] = [];
        for (const [a, b] of [['ge 1/1', 'ge 2/24'], ['ge 1/24', 'ge 1/1'], ['uplink', 'ge 1/24'], ['p1', 'p5000']]) {
          await type('#range-from', a);
          await type('#range-to', b);
          errors.push(`${q('#range-preview')!.getAttribute('data-state')}:${create().disabled}:${preview()}`);
        }
        (q('#range-to') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await tick(10);
        check(
          'invalid ranges show a clear error and cannot be created: different prefixes, reversed numbers, no port number, too large',
          errors.length === 4 && errors.every((x) => /^error:true:/.test(x)) && /must be the same in both names/.test(errors[0]) && /must be lower than the last/.test(errors[1]) && /does not end in a port number/.test(errors[2]) && /at most 256/.test(errors[3]) &&
            !!q('#modal[open]') && ports().length === 0,
          errors.join(' || '),
        );
        await answerDialog('cancel');
        await tick(20);
        check('Cancel creates nothing', ports().length === 0 && m().canUndo() === 'Add device' && !q('#modal[open]'));

        click(head + ' [data-act="add-range"]');
        await tick(20);
        await type('#range-from', 'ge 1/1');
        await type('#range-to', 'ge 1/24');
        create().click();
        await tick(30);
        const cards = (Array.prototype.map.call(doc.querySelectorAll('#side-body [data-list="interfaces"] > details.card'), (e: Element) => e.getAttribute('data-iface')) as string[]);
        const dev = m().result.model!.devices[0];
        check(
          'creating the range adds 24 physical interfaces in one undoable step, with nothing but an id and a label, shown in the usual alphabetical order',
          ports().length === 24 && ports()[0] === 'ge-1/1' && ports()[23] === 'ge-1/24' && dev.interfaces.every((i) => i.type === 'physical' && !i.addresses.length && /^ge 1\/\d+$/.test(i.label || '')) && dev.logical.length === 0 && m().result.model!.links.length === 0 &&
            m().valid && m().canUndo() === 'Add 24 ports' && cards.length === 24 && cards.slice(0, 3).join() === 'ge-1/1,ge-1/2,ge-1/3' && cards[9] === 'ge-1/10' && cards[23] === 'ge-1/24' &&
            /Physical interfaces \(24\)/.test(q('#side-body [data-list="interfaces"] h4')!.textContent || '') && /24 ports added/.test(q('#toast')!.textContent || '') && /- \{id: ge-1\/1, label: ge 1\/1\}/.test(app.exportText()),
          `${ports().length} ${m().canUndo()} ${cards.slice(0, 4).join()}`,
        );
        // the same range again is a duplicate; the single-interface action still works as before
        click(head + ' [data-act="add-range"]');
        await tick(20);
        await type('#range-from', 'ge 1/20');
        await type('#range-to', 'ge 1/30');
        const dup = preview();
        const dupDisabled = create().disabled;
        await answerDialog('cancel');
        await tick(20);
        click(head + ' [data-act="add-iface"]');
        await tick();
        check('a range that overlaps existing ports is rejected as a whole; "+ Interface" still adds a single interface', /Already on this device: ge 1\/20, ge 1\/21, ge 1\/22, ge 1\/23 and 1 more\. Nothing is created\./.test(dup) && dupDisabled && ports().length === 25 && ports()[24] === 'eth0' && m().canUndo() === 'Add interface', dup);
        // export -> reload, then undo
        const text = app.exportText();
        const back = ModelDoc.fromText(text, 'ports.yaml', 'file').doc as ModelDoc;
        m().undo();
        m().undo();
        (app as unknown as { afterEdit(n?: string): void }).afterEdit();
        check('the generated ports survive export → reload, and one undo removes the whole range', back.valid && back.exportText() === text && back.result.model!.devices[0].interfaces.length === 25 && back.result.model!.devices[0].interfaces[5].label === 'ge 1/6' && ports().length === 0);
        m().markSaved();
        app.closeModel();
      }

      // ------------------------------------------------ DHCP and DNS names
      {
        app.loadText(
          [
            'netatlas: 1',
            'devices:',
            '  - id: web1',
            '    interfaces:',
            '      - {id: eth0, label: Front, ip: [192.0.2.10/24, 2001:db8::10/64]}',
            '      - {id: eth1, ip: 198.51.100.10/24}',
            '      - eth2',
            '    logical_interfaces:',
            '      - {id: lo0, type: loopback, ip: 10.255.0.10/32}',
            '      - {id: vlan30, type: virtual}',
            '    dns_names:',
            '      - {name: mgmt.example.net, interfaces: [eth1]}',
            '',
          ].join('\n'),
          'dhcp.yaml',
        );
        await tick(10);
        click('#outline [data-act="select"][data-kind="device"][data-index="0"]');
        await tick(10);
        const m = (): ModelDoc => app.mdoc as ModelDoc;
        const inf = (id: string): Interface => m().result.model!.index.interfaces.get('web1:' + id) as Interface;
        const card = (id: string): string => `#side-body details.card[data-iface="${id}"]`;
        const sw = (id: string): HTMLElement => q(card(id) + ' [data-act="dhcp"]') as HTMLElement;
        const modal = (): string => (q('#modal[open]') || { textContent: '' }).textContent || '';
        const sections = textsOf('#side-body .inspector > section.sub h4');
        check(
          'every physical and logical interface except a loopback has a DHCP switch beside its addresses, off by default; DNS names follow the interface sections',
          (Array.prototype.map.call(doc.querySelectorAll('#side-body details.card > .field[data-dhcp] > label + [data-act="dhcp"]'), (b: Element) => (b.closest('details.card') as Element).getAttribute('data-iface')) as string[]).join() === 'eth0,eth1,eth2,vlan30' &&
            !q(card('lo0') + ' [data-act="dhcp"]') && !!q(card('lo0') + ' .field input.append') && !(q(card('lo0') + ' .field input.append') as HTMLInputElement).disabled &&
            Array.prototype.every.call(doc.querySelectorAll('#side-body [data-act="dhcp"]'), (b: Element) => b.getAttribute('aria-checked') === 'false' && b.getAttribute('role') === 'switch') &&
            !inf('eth2').dhcp && /^Physical interfaces/.test(sections[0]) && /^Logical interfaces/.test(sections[1]) && sections[2] === 'DNS names (1)',
          sections.join('|'),
        );
        const before = app.exportText();
        sw('eth1').click();
        await tick(20);
        const asked = modal();
        await answerDialog('cancel');
        await tick(10);
        check(
          'turning DHCP on for an interface with addresses asks first and lists the addresses and DNS names it deletes; Cancel changes nothing',
          /Turn DHCP on for “eth1”\?/.test(asked) && /198\.51\.100\.10\/24/.test(asked) && /mgmt\.example\.net — it has no other interface, so the name is deleted too/.test(asked) && app.exportText() === before && m().canUndo() === null && !inf('eth1').dhcp,
          asked,
        );
        sw('eth1').click();
        await tick(20);
        await answerDialog('dhcp');
        await tick(20);
        const field = q(card('eth1') + ' .field[data-dhcp]') as HTMLElement;
        const inputs = Array.prototype.slice.call(field.querySelectorAll('input')) as HTMLInputElement[];
        check(
          'confirming deletes the addresses and the association and turns DHCP on in one undo step; manual addresses are greyed out and disabled',
          inf('eth1').dhcp && !inf('eth1').addresses.length && m().result.model!.devices[0].dnsNames.length === 0 && m().canUndo() === 'Turn DHCP on' && m().valid &&
            field.getAttribute('data-dhcp') === 'on' && sw('eth1').getAttribute('aria-checked') === 'true' && inputs.length === 1 && inputs[0].disabled && !!field.querySelector('.list-ed.disabled') &&
            /DHCP/.test(q(card('eth1') + ' .card-title')!.textContent || '') && /no network and no VLAN can be derived/.test(q(card('eth1') + ' [data-derived="iface-vlan"]')!.textContent || ''),
          `${inf('eth1').dhcp} ${inputs.length} ${m().canUndo()}`,
        );
        // an interface without addresses or DNS names: nothing to lose, so nothing is asked
        sw('eth2').click();
        await tick(20);
        check('DHCP on for an interface with nothing to delete needs no confirmation', inf('eth2').dhcp && !q('#modal[open]') && m().canUndo() === 'Turn DHCP on');
        sw('eth1').click();
        await tick(20);
        const field2 = q(card('eth1') + ' .field[data-dhcp]') as HTMLElement;
        check(
          'turning DHCP off brings back manual editing, not the deleted addresses',
          !inf('eth1').dhcp && !inf('eth1').addresses.length && !q('#modal[open]') && field2.getAttribute('data-dhcp') === 'off' && !(field2.querySelector('input.append') as HTMLInputElement).disabled && m().canUndo() === 'Turn DHCP off',
        );
        // + DNS name
        click('#side-body [data-act="add-dns"]');
        await tick(20);
        const offered = Array.prototype.map.call(doc.querySelectorAll('#dns-ifaces input[type="checkbox"]'), (b: Element) => (b as HTMLInputElement).value) as string[];
        const labels = textsOf('#dns-ifaces label');
        const createBtn = (): HTMLButtonElement => q('#modal[open] [data-value="create"]') as HTMLButtonElement;
        const disabledFirst = createBtn().disabled;
        const nameIn = q('#dns-name') as HTMLInputElement;
        nameIn.value = 'api.example.com';
        nameIn.dispatchEvent(new Event('input', { bubbles: true }));
        for (const id of ['eth0', 'lo0']) {
          const b = q(`#dns-ifaces input[value="${id}"]`) as HTMLInputElement;
          b.checked = true;
          b.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await tick();
        const preview = (q('#dns-preview') || { textContent: '' }).textContent || '';
        check(
          '"+ DNS name" offers the interfaces with DHCP off by name, says which are excluded, and explains that a name belongs to the interface, not one of its addresses',
          offered.join() === 'eth0,eth1,lo0,vlan30' && labels[0] === 'Front (eth0)' && /DHCP is on: eth2/.test(q('[data-dns-excluded]')!.textContent || '') && disabledFirst && !createBtn().disabled &&
            /eth0 has 2 addresses: the name is associated with the interface, not with one particular address/.test(preview),
          offered.join() + ' | ' + preview,
        );
        createBtn().click();
        await tick(30);
        const chips = textsOf('#side-body [data-dns="api.example.com"] [data-dns-iface]');
        check(
          'the name is stored once with both interfaces (by id), shown with their names',
          JSON.stringify(m().result.model!.devices[0].dnsNames.map((x) => [x.name, x.interfaces])) === '[["api.example.com",["eth0","lo0"]]]' && m().canUndo() === 'Add DNS name' &&
            chips.length === 2 && /^Front \(eth0\)/.test(chips[0]) && /^lo0/.test(chips[1]) && /DNS names \(1\)/.test(textsOf('#side-body section[data-list="dns-names"] h4')[0] || ''),
          chips.join('|'),
        );
        // DHCP on an associated interface: the association is part of the confirmation
        sw('eth0').click();
        await tick(20);
        const asked2 = modal();
        await answerDialog('cancel');
        await tick(10);
        // deleting an associated interface removes the association with it
        click(card('lo0') + ' [data-act="del-iface"]');
        await tick(20);
        const asked3 = modal();
        await answerDialog('delete');
        await tick(20);
        check(
          'enabling DHCP or deleting an interface names the DNS associations it removes; after deleting, no reference is left',
          /api\.example\.com/.test(asked2) && !/deleted too/.test(asked2) && /association with the DNS name api\.example\.com is removed/.test(asked3) &&
            JSON.stringify(m().result.model!.devices[0].dnsNames.map((x) => x.interfaces)) === '[["eth0"]]' && m().valid && !inf('lo0'),
          asked3,
        );
        const text = app.exportText();
        const back = ModelDoc.fromText(text, 'dhcp.yaml', 'file').doc as ModelDoc;
        check(
          'DHCP and DNS names survive export → reload',
          back.valid && back.exportText() === text && /- \{id: eth2, dhcp: true\}/.test(text) && /dns_names:\n {6}- \{name: api\.example\.com, interfaces: \[eth0\]\}/.test(text),
          text,
        );
        m().markSaved();
        app.closeModel();
      }

      click('#menu-btn');
      click('#menu-examples [data-example="2"]');
      await tick(10);
      check('choosing an example from the menu loads it and closes the menu', menu!.hidden && !!app.mdoc && app.mdoc.fileName === EXAMPLES[2].name && !(q('#btn-download') as HTMLButtonElement).disabled, app.mdoc ? app.mdoc.fileName : 'nothing loaded');

      // the model and its settings without a "Current model" button: the model panel stays, the settings open from the Edit tab
      app.select('device:r1');
      await tick();
      const panel = (q('#outline') as HTMLElement).getBoundingClientRect();
      const listed = doc.querySelectorAll('#outline [data-ref]').length;
      app.select(null);
      await tick();
      click('[data-tab="edit"]');
      await tick();
      const settingsBtn = Array.prototype.find.call(doc.querySelectorAll('#side-body button'), (x: Element) => /Edit model settings/.test(x.textContent || '')) as HTMLElement | undefined;
      if (settingsBtn) settingsBtn.click();
      await tick();
      const head = (q('#side-body .insp-head') || { textContent: '' }).textContent || '';
      check(
        'without the "Current model" button the model stays open and visible (model panel with its entries, diagram), and its settings (title, description) open from the Edit tab',
        !q('#btn-model') && doc.body.getAttribute('data-state') === 'loaded' && panel.width > 100 && panel.height > 100 && listed >= 2 && count('g.device') === 2 && !!settingsBtn && !!q('[data-tab="edit"].active') && /^model/.test(head) && /Minimal example/.test(head) &&
          !!q('#side-body [data-p=\'["title"]\']') && !!q('#side-body [data-p=\'["description"]\']') && app.session!.state.selected === null,
        `${panel.width}x${panel.height} ${listed} ${head}`,
      );
      await setField('#side-body [data-p=\'["title"]\']', 'Renamed model');
      check('the title is edited there, and undo takes it back', (app.mdoc as ModelDoc).text(['title']) === 'Renamed model' && !!(app.mdoc as ModelDoc).canUndo() && !(q('#btn-undo') as HTMLButtonElement).disabled);
      check(
        'the model outline has no "Document" entry, and the interface says "model", not "document"',
        !q('#outline .ol-doc') && !q('#outline [data-kind="document"]') && !/Document/.test(q('#outline')!.textContent || '') && !/[Dd]ocument/.test(q('#side-body')!.textContent || '') && !/[Dd]ocument/.test(q('header.topbar')!.textContent || ''),
      );
      (app.mdoc as ModelDoc).markSaved();

      // ---------------------------------------------- collapsible outline sections
      app.loadExample(EXAMPLES.findIndex((e) => /enterprise-wan/.test(e.name)));
      await tick();
      const m0 = app.session!.model;
      const sec = (k: string): HTMLElement => q(`#outline [data-section="${k}"]`) as HTMLElement;
      const folded = (): string => (Array.prototype.map.call(doc.querySelectorAll('#outline [data-section]'), (e: Element) => e.getAttribute('data-section') + '=' + e.getAttribute('data-folded')) as string[]).join();
      const shownIn = (k: string): number => sec(k).querySelectorAll('.ol-item').length;
      const toggle = (k: string): HTMLElement => sec(k).querySelector('[data-act="fold"]') as HTMLElement;
      check(
        'outline sections fold: Links and Protocols start folded to a heading with their count, the others are open',
        folded() === 'device=false,link=true,network=false,relation=false,group=false,protocol=true' && shownIn('link') === 0 && shownIn('device') === m0.devices.length && new RegExp(`\\(${m0.links.length}\\)`).test(toggle('link').textContent || '') &&
          toggle('link').getAttribute('aria-expanded') === 'false' && toggle('device').getAttribute('aria-expanded') === 'true' && !!sec('link').querySelector('[data-act="add-entity"]'),
        folded(),
      );
      toggle('link').click();
      const opened = shownIn('link') === m0.links.length && toggle('link').getAttribute('aria-expanded') === 'true';
      toggle('device').click();
      check('a heading toggles its section; folding changes nothing in the model', opened && shownIn('device') === 0 && folded().indexOf('device=true,link=false') === 0 && !(app.mdoc as ModelDoc).dirty && (app.mdoc as ModelDoc).canUndo() === null, folded());
      click('#outline [data-act="fold-all"]');
      const allFolded = doc.querySelectorAll('#outline .ol-item').length === 0 && doc.querySelectorAll('#outline [data-section][data-folded="true"]').length === 6 && /Expand all/.test(q('#outline [data-act="fold-all"]')!.textContent || '');
      // what would be lost from view stays: the selected entry, and what is related to it as a count
      app.select('device:hq-rtr1');
      const selShown = textsOf('#outline .ol-item .ol-label').join() === 'hq-rtr1' && !!q('#outline .ol-item.ctx-selected');
      const relatedMark = (toggle('link').querySelector('.ol-related') || { textContent: '' }).textContent || '';
      check('"Collapse all" folds every section; a folded section still shows the selected entry and how many of its entries are related', allFolded && selShown && /^• \d+$/.test(relatedMark), `${allFolded} ${selShown} "${relatedMark}"`);
      app.select(null);
      // the filter looks into folded sections
      const filter = q('#outline [data-t="outline-filter"]') as HTMLInputElement;
      filter.value = 'isp1';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      const found = textsOf('#outline .ol-item');
      const f2 = q('#outline [data-t="outline-filter"]') as HTMLInputElement;
      f2.value = '';
      f2.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      check('the filter finds entries in folded sections', found.length >= 3 && found.every((x) => /isp1/i.test(x)) && doc.querySelectorAll('#outline .ol-item').length === 0, found.join(' | '));
      // errors inside a folded section are counted on its heading
      const broken = app.loadText('netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0]}\nlinks:\n  - {id: l1, a: "a:e0", b: nowhere}\n', 'broken-link.yaml', 'file');
      const badge = (sec('link').querySelector('[data-act="fold"] .ol-badge.err') || { textContent: '' }).textContent || '';
      check('a folded section shows the number of problems inside it on its heading', broken.ok && badge === '1' && shownIn('link') === 0, badge);
      // adding to a folded section opens it
      sec('network').querySelector<HTMLElement>('[data-act="add-entity"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 4 }));
      await tick();
      check('"+ Add" on a folded section opens it and shows the new entry', sec('network').getAttribute('data-folded') === 'false' && shownIn('network') === 1);
      (app.mdoc as ModelDoc).markSaved();
      expandOutline();
      check('"Expand all" opens every section again', doc.querySelectorAll('#outline [data-section][data-folded="true"]').length === 0 && /Collapse all/.test(q('#outline [data-act="fold-all"]')!.textContent || ''));
    }

    // ------------------------------------------------ viewer: every example
    for (let i = 0; i < EXAMPLES.length; i++) {
      const ex = EXAMPLES[i];
      const file = new File([ex.text], ex.name, { type: 'application/yaml' });
      const res = await app.loadFile(file);
      check(`${ex.name}: loads via File API without errors`, res.ok && !res.errors.length, res.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
      if (!res.ok || !app.session) continue;
      expandOutline();
      const m = app.session.model;

      click('[data-view-btn="physical"]');
      check(`${ex.name}: physical view draws every device and cable, no relations`,
        doc.body.getAttribute('data-view') === 'physical' && count('.device') === m.devices.length && count('.cable') === m.links.length && count('.rel') === 0 && count('.port') === m.links.length * 2,
        `${count('.device')}/${m.devices.length} devices, ${count('.cable')}/${m.links.length} cables`);
      check(`${ex.name}: loopbacks are not drawn as ports in the physical view`, count('.loop-chip') === 0);
      // stored layouts (the "…-arranged"/edited examples are arranged too) and auto layouts alike
      const physProblems = drawnProblems();
      check(`${ex.name}: physical view, measured in the browser: full text inside its boxes, no overlapping boxes or labels`, !physProblems.length, physProblems.slice(0, 5).join('; '));

      click('[data-view-btn="logical"]');
      const drawable = m.relations.filter((r) => new Set(r.endpoints.map((e) => e.device)).size >= 2).length;
      check(`${ex.name}: logical view draws relations, no cables`, doc.body.getAttribute('data-view') === 'logical' && count('g.rel') === drawable && count('.cable') === 0, `${count('g.rel')} / ${drawable}`);
      const tunnels = m.relations.filter((r) => r.category === 'tunnel').length;
      check(`${ex.name}: tunnels drawn as tubes`, count('g.rel.cat-tunnel .tube-outer') >= tunnels && count('g.rel.cat-tunnel .cable-line') === 0);
      const loops = m.devices.reduce((s, d) => s + Math.min(3, d.logical.filter((x) => x.type === 'loopback').length), 0);
      check(`${ex.name}: loopbacks shown as chips in the logical view`, count('.loop-chip') === loops, `${count('.loop-chip')} / ${loops}`);
      const logProblems = drawnProblems();
      check(`${ex.name}: logical view, measured in the browser: full text inside its boxes, no overlapping boxes or labels`, !logProblems.length, logProblems.slice(0, 5).join('; '));

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
      check('status after dragging: Physical "Manually adjusted", Logical still "Auto-arranged"', status('physical') === 'manual' && status('logical') === 'auto', status('physical') + ' / ' + status('logical'));
      {
        const b = q('#btn-arrange') as HTMLButtonElement;
        const cs = doc.defaultView!.getComputedStyle(b);
        const br = b.getBoundingClientRect();
        check(
          'the Auto-arrange button shows it: pencil icon, warning colour, hover text and accessible description say "manually adjusted"; still a clickable button',
          shows('physical', 'manual') && !b.disabled && b.tagName === 'BUTTON' && br.width > 60 && /Auto-arrange/.test(b.textContent || '') && cs.borderTopStyle === 'dashed' && cs.cursor !== 'not-allowed' && b.getAttribute('aria-describedby') === 'arrange-status',
          JSON.stringify(shown()),
        );
      }
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
    check('… and the button shows the check mark and "matches the auto-arranged layout" (icon, hover text, description)', shows('physical', 'auto') && doc.defaultView!.getComputedStyle(q('#btn-arrange')!).borderTopStyle === 'solid', JSON.stringify(shown()));
    {
      const panelShown = (): boolean => {
        const o = q('#outline') as HTMLElement;
        const r = o.getBoundingClientRect();
        const cs = doc.defaultView!.getComputedStyle(o);
        const c = (q('#canvas-wrap') as HTMLElement).getBoundingClientRect();
        // visible, with content, and beside the diagram (not on top of it)
        return cs.display !== 'none' && cs.visibility === 'visible' && r.width >= 150 && r.height > 200 && o.querySelectorAll('.ol-item').length > 10 && (r.right <= c.left + 1 || r.top >= c.bottom - 1);
      };
      const noToggle = !q('#btn-outline') && !Array.prototype.some.call(doc.querySelectorAll('header.topbar button'), (b: Element) => /Model/.test(b.textContent || '')) && !doc.body.classList.contains('no-outline');
      const a = panelShown();
      app.select('device:hq-fw');
      const b = panelShown();
      click('[data-view-btn="logical"]');
      const c = panelShown();
      app.select('relation:gre-muc');
      const d2 = panelShown();
      click('[data-view-btn="physical"]');
      app.select(null);
      check('there is no Model toggle button; the model panel is always visible (while selecting objects and switching views) and never covers the diagram', noToggle && a && b && c && d2 && panelShown(), JSON.stringify([noToggle, a, b, c, d2]));
    }
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
    check('keyboard shortcut L switches to the logical view', doc.body.getAttribute('data-view') === 'logical');
    check('switching views: the button shows the status of the view on screen', shows('logical', 'auto'), JSON.stringify(shown()));
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
    {
      // the exported file is parsed and laid out on its own, as a viewer would, and measured with real font metrics
      type Box = { x: number; y: number; w: number; h: number };
      const measure = (text: string, sel = 'g.svg-legend'): { ok: boolean; labels: string[]; why: string; box: Box } => {
        const parsed = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
        const holder = doc.createElement('div');
        // off screen at its natural size (scaled down to nothing, text metrics become meaningless)
        holder.setAttribute('style', 'position:absolute;left:-30000px;top:0;width:6000px;height:6000px;visibility:hidden');
        parsed.setAttribute('id', 'export-canvas');
        holder.appendChild(doc.importNode(parsed, true));
        doc.body.appendChild(holder);
        const root = holder.firstChild as SVGSVGElement;
        const why: string[] = [];
        const lg = root.querySelector(sel) as SVGGElement | null;
        let at: Box = { x: 0, y: 0, w: 0, h: 0 };
        const vpEl = root.querySelector('#viewport') as SVGGElement;
        let labels: string[] = [];
        if (!lg) why.push('no legend in the file');
        else {
          labels = Array.prototype.map.call(lg.querySelectorAll('text'), (t: Element) => t.textContent) as string[];
          const vb = (root.getAttribute('viewBox') || '').split(' ').map(Number);
          const tr = /translate\(([-0-9.]+) ([-0-9.]+)\)/.exec(lg.getAttribute('transform') || '') || ['', '0', '0'];
          const lb = lg.getBBox();
          const box = { x: Number(tr[1]) + lb.x, y: Number(tr[2]) + lb.y, w: lb.width, h: lb.height };
          at = box;
          const db = vpEl.getBBox();
          const frame = lg.querySelector('.lg-box') as SVGRectElement;
          if (!(box.x >= db.x + db.width)) why.push(`legend (x ${box.x}) is not right of the diagram (ends at ${db.x + db.width})`);
          if (!(box.x >= vb[0] && box.y >= vb[1] && box.x + box.w <= vb[0] + vb[2] && box.y + box.h <= vb[1] + vb[3])) why.push('legend is clipped by the viewBox ' + vb.join(' '));
          if (!(db.x >= vb[0] - 1 && db.y >= vb[1] - 1 && db.x + db.width <= vb[0] + vb[2] + 1 && db.y + db.height <= vb[1] + vb[3] + 1)) why.push('diagram is clipped by the viewBox');
          // measured text stays inside the legend's frame
          if (lb.width > Number(frame.getAttribute('width')) + 1 || lb.height > Number(frame.getAttribute('height')) + 1) why.push(`text leaves the frame (${lb.width} > ${frame.getAttribute('width')})`);
          const size = parseFloat(doc.defaultView!.getComputedStyle(lg.querySelector('.lg-label') as Element).fontSize);
          if (!(size >= 11)) why.push('label font size ' + size);
          if (lg.querySelector('use, image, foreignObject')) why.push('legend refers to content outside the file');
          if (Number(root.getAttribute('width')) !== Math.round(vb[2]) || Number(root.getAttribute('height')) !== Math.round(vb[3])) why.push('width/height do not match the viewBox');
        }
        doc.body.removeChild(holder);
        return { ok: !why.length, labels, why: why.join('; '), box: at };
      };
      const lgL = measure(svgText);
      check(
        'SVG export (logical view) contains its own legend: protocols and symbols, beside the diagram, not clipped, text inside its frame',
        lgL.ok && lgL.labels[0] === 'Legend — logical view' && ['IPsec', 'GRE', 'OSPF', 'MACsec *', 'IP network'].every((x) => lgL.labels.indexOf(x) >= 0),
        lgL.why + ' // ' + lgL.labels.join(' | '),
      );
      click('[data-view-btn="physical"]');
      const physText = app.exportSvg();
      const lgP = measure(physText);
      check(
        'SVG export (physical view) contains its own legend: device types, cable media, speed, locations',
        lgP.ok && lgP.labels[0] === 'Legend — physical view' && ['Router', 'Firewall', 'Fiber', 'Copper', '100G', 'site', 'rack'].every((x) => lgP.labels.indexOf(x) >= 0) && lgP.labels.indexOf('IPsec') < 0 &&
          !/<script|https?:\/\/(?!www\.w3\.org)/.test(physText),
        lgP.why + ' // ' + lgP.labels.join(' | '),
      );
      {
        // the networks overview: its own titled box in the legend's style, beside the legend, per view
        const apart = (a: Box, b: Box): boolean => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        const nwL = measure(svgText, 'g.svg-networks');
        const nwP = measure(physText, 'g.svg-networks');
        check(
          'SVG exports of both views contain a separate, titled "Networks" box: beside the diagram and the legend, not clipped, text inside its frame',
          nwL.ok && nwP.ok && nwL.labels[0] === 'Networks — logical view' && nwP.labels[0] === 'Networks — physical view' && apart(nwL.box, lgL.box) && apart(nwP.box, lgP.box) && nwL.box.x >= lgL.box.x + lgL.box.w && nwP.box.x >= lgP.box.x + lgP.box.w,
          nwL.why + ' // ' + nwP.why,
        );
        check(
          'the Networks box names each network with its prefix and VLAN (enterprise WAN: “Users” 10.10.10.0/24 · VLAN 10)',
          nwP.labels.some((x) => /10\.10\.10\.0\/24 · VLAN 10/.test(x)) && nwL.labels.some((x) => /10\.10\.10\.0\/24 · VLAN 10/.test(x)) && /<g class="svg-networks"/.test(physText),
          nwP.labels.join(' | '),
        );
        check('the diagram on screen has no Networks box drawn into it (export only)', !q('#canvas .svg-networks'));
      }
      // a model with several disconnected components and an unconnected device
      app.loadExample(EXAMPLES.findIndex((e) => e.name === 'metro-ring.yaml'));
      const mP = measure(app.exportSvg());
      click('[data-view-btn="logical"]');
      const mL = measure(app.exportSvg());
      check('disconnected components (metro ring): the legend is beside all of them in both views', mP.ok && mL.ok, mP.why + ' // ' + mL.why);
      {
        // view-specific lists: a network that only loopbacks are in belongs to the logical picture alone
        app.loadText(FIXTURES.find((e) => e.name === 'editor-new-network.yaml')!.text, 'editor-new-network.yaml', 'example');
        click('[data-view-btn="physical"]');
        const p = measure(app.exportSvg(), 'g.svg-networks');
        click('[data-view-btn="logical"]');
        const l = measure(app.exportSvg(), 'g.svg-networks');
        (q('#opt-networks') as HTMLInputElement).click();
        const hidden = measure(app.exportSvg(), 'g.svg-networks');
        (q('#opt-networks') as HTMLInputElement).click();
        const has = (m: { labels: string[] }, name: string): boolean => m.labels.indexOf(name) >= 0;
        check(
          'the Networks box lists only the networks of the exported view (loopback network: logical only; port networks: physical)',
          p.ok && l.ok && has(p, 'Core link') && has(p, 'Management') && !has(p, 'Router loopbacks') && has(l, 'Router loopbacks') && has(l, 'Core link') && p.labels.some((x) => /^2 of 3 in the model/.test(x)),
          p.labels.join(' | ') + ' // ' + l.labels.join(' | '),
        );
        check(
          'with network nodes switched off, the logical list holds only what the drawn relations and loopbacks use',
          hidden.ok && has(hidden, 'Router loopbacks') && !has(hidden, 'Core link') && !has(hidden, 'Management'),
          hidden.labels.join(' | '),
        );
        app.loadExample(EXAMPLES.findIndex((e) => e.name === 'minimal.yaml'));
        const none = measure(app.exportSvg(), 'g.svg-networks');
        check('a view without relevant networks says so in the box (clear empty state)', none.ok && none.labels[0] === 'Networks — logical view' && none.labels.some((x) => /The model defines no networks\./.test(x)), none.labels.join(' | '));
        app.loadExample(EXAMPLES.findIndex((e) => e.name === 'metro-ring.yaml'));
        click('[data-view-btn="logical"]');
      }
      check('the diagram on screen has no legend drawn into it (export only)', !q('#canvas .svg-legend'));
      app.loadExample(EXAMPLES.findIndex((e) => /enterprise-wan/.test(e.name)));
      click('[data-view-btn="logical"]');
    }
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
        // the hint names what the marks mean and nothing else (no "others dimmed"); the dimming itself is still there
        else if ((hint.textContent || '').trim() !== `▸ selected · • related (${ctx ? ctx.related.size : 0})`) bad.push('hint text "' + hint.textContent + '"');
        if (items.some((b) => b.getAttribute('data-ctx') === 'unrelated') && !q('#outline-body .ol-item.ctx-unrelated')) bad.push('unrelated entries are not dimmed');
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

    // ------------------------ sizing and readability: long and multi-line labels
    {
      const idx = EXAMPLES.findIndex((e) => e.name === 'long-labels.yaml');
      app.loadExample(idx);
      const m = app.session!.model;
      click('[data-view-btn="physical"]');
      const lines = (ref: string, cls: string): string[] => {
        const t = q(`#viewport g[data-ref="${ref}"] text.${cls}`);
        if (!t) return [];
        const spans = t.querySelectorAll('tspan');
        return spans.length ? (Array.prototype.map.call(spans, (x: Element) => x.textContent) as string[]) : [t.textContent || ''];
      };
      const boxH = (ref: string): number => (q(`#viewport g[data-ref="${ref}"] .dev-box`) as unknown as SVGGraphicsElement).getBBox().height;
      check(
        'a device label with line breaks is drawn as those lines; a long label wraps; a long word is broken; nothing is cut',
        lines('device:core-a', 'dev-label').join('|') === 'core-a|Core switch A|(rack 12, U30-U34)' &&
          lines('device:fw', 'dev-label').length >= 3 && lines('device:fw', 'dev-label').join(' ') === m.index.devices.get('fw')!.label &&
          lines('device:storage', 'dev-label').length >= 2 && lines('device:storage', 'dev-label').join('') === m.index.devices.get('storage')!.label &&
          lines('group:dc', 'group-title').join(' ') === m.index.groups.get('dc')!.label,
        JSON.stringify([lines('device:core-a', 'dev-label'), lines('device:fw', 'dev-label'), lines('device:storage', 'dev-label'), lines('group:dc', 'group-title')]),
      );
      check('boxes differ in size with their text (one-letter label < three lines < long wrapped label)', boxH('device:srv') < boxH('device:core-a') && boxH('device:core-a') < boxH('device:fw'), [boxH('device:srv'), boxH('device:core-a'), boxH('device:fw')].join(' '));
      const straight = count('.cable.straight');
      const peerD = ['peer-1', 'peer-2', 'peer-3'].map((id) => (q(`#viewport g.cable[data-ref="link:${id}"] .cable-line`) as Element).getAttribute('d') || '');
      check(
        'three cables between the same two devices are parallel straight lines, each with its own label on it',
        peerD.every((d) => /^M[-0-9.]+ ([-0-9.]+)L[-0-9.]+ \1$/.test(d)) && new Set(peerD).size === 3 && straight >= 5 &&
          ['100G · peer link 1', '100G · peer link 2', '100G · keepalive'].every((t) => Array.prototype.some.call(doc.querySelectorAll('#viewport text.link-label'), (e: Element) => e.textContent === t)),
        peerD.join(' | ') + ' straight: ' + straight,
      );
      const physSvg = app.exportSvg();
      click('[data-view-btn="logical"]');
      const pillText = (id: string): string => {
        const t = q(`#viewport g.pill[data-ref="relation:${id}"] text`);
        if (!t) return '';
        const spans = t.querySelectorAll('tspan');
        return spans.length ? (Array.prototype.map.call(spans, (x: Element) => x.textContent) as string[]).join(' ') : t.textContent || '';
      };
      const pillRect = (id: string): DOMRect => (q(`#viewport g.pill[data-ref="relation:${id}"] .pill-box`) as Element).getBoundingClientRect();
      const four = ['ipsec-br', 'bgp-br', 'bfd-br', 'syslog-br'];
      const apart = four.every((a, i) => four.slice(i + 1).every((b) => {
        const ra = pillRect(a);
        const rb = pillRect(b);
        return ra.right <= rb.left || rb.right <= ra.left || ra.bottom <= rb.top || rb.bottom <= ra.top;
      }));
      check(
        'four labelled relations between the same two devices: four labels, each complete, at its own place; nested relations are named in their carrier\'s label',
        apart && pillText('ipsec-br') === 'IPsec · IKEv2 site-to-site with certificate authentication › GRE · primary › OSPF · area 0.0.0.10' &&
          pillText('bgp-br') === 'eBGP · AS 65010 ↔ AS 65020' && pillText('bfd-br') === 'BFD · 300 ms × 3' && pillText('syslog-br') === 'Syslog · audit log' && !q('#viewport g.pill[data-ref="relation:gre-br"]'),
        four.map(pillText).join(' | '),
      );
      const netLines = lines('network:servers', 'net-sub').join(' ');
      check('a network shows all of its prefixes', ['10.10.0.0/24', '2001:db8:10::/64', '2001:db8:11::/64'].every((c) => netLines.indexOf(c) >= 0), netLines);
      // the standalone SVG files: same full text, measured on their own
      const logSvg = app.exportSvg();
      const exported = (text: string): { full: boolean; problems: string[] } => {
        const parsed = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
        const holder = doc.createElement('div');
        // off screen at its natural size (scaled down to nothing, text metrics become meaningless)
        holder.setAttribute('style', 'position:absolute;left:-30000px;top:0;width:6000px;height:6000px;visibility:hidden');
        parsed.setAttribute('id', 'export-canvas');
        holder.id = 'export-probe';
        holder.appendChild(doc.importNode(parsed, true));
        doc.body.appendChild(holder);
        const all = (holder.textContent || '').replace(/\s+/g, '');
        const full = m.devices.every((d) => all.indexOf(d.label.replace(/\s+/g, '')) >= 0);
        const problems = drawnProblems('#export-probe #viewport');
        doc.body.removeChild(holder);
        return { full, problems };
      };
      const ep = exported(physSvg);
      const el2 = exported(logSvg);
      check('SVG exports of both views contain every label in full, inside its box, without overlapping labels', ep.full && el2.full && !ep.problems.length && !el2.problems.length && /peer link 2/.test(physSvg) && /certificate/.test(logSvg) && !/…</.test(physSvg + logSvg), ep.problems.concat(el2.problems).slice(0, 5).join('; '));
      // Auto-arrange is a function of the model: drag, select, arrange -> the picture before the drag
      const snapshot = (): string => new XMLSerializer().serializeToString(q('#viewport') as Element);
      const before = snapshot();
      const d = app.mdoc as ModelDoc;
      d.movePositions('logical', new Map([['fw', { x: 2222, y: -1111 }]]), 'Move fw');
      (app as unknown as { afterEdit(n?: string): void }).afterEdit();
      app.select('device:br-rtr');
      const dragged = snapshot() !== before && status('logical') === 'manual';
      app.select(null);
      click('#btn-arrange');
      await answerDialog('arrange');
      const again = snapshot() === before && status('logical') === 'auto';
      click('#btn-arrange');
      await tick(10);
      check('after dragging and selecting, Auto-arrange gives exactly the same picture (positions, routes, label places); repeating it moves nothing and asks nothing', dragged && again && !q('#modal[open]') && snapshot() === before && /Already arranged/.test(q('#toast')!.textContent || ''), `${dragged} ${again}`);
      // a label typed with a line break in the editor
      app.select('device:srv');
      await setField('#side-body textarea[data-p=\'["devices",3,"label"]\']', 'srv-01\nhypervisor');
      check('typing a line break into a device label gives two lines in the diagram and a block scalar in the YAML', lines('device:srv', 'dev-label').join('|') === 'srv-01|hypervisor' && /label: \|-\n {6}srv-01\n {6}hypervisor\n/.test(app.exportText()) && !drawnProblems().length, lines('device:srv', 'dev-label').join('|'));
      (app.mdoc as ModelDoc).markSaved();
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
      {
        // groups are placed by their cabling: the providers between the Internet above and the HQ routers below
        const top = (sel: string): DOMRect => (q('#viewport ' + sel) as Element).getBoundingClientRect();
        const prov = top('g.group[data-ref="group:providers"] .group-box');
        const hq = top('g.group[data-ref="group:hq"] .group-box');
        const inet = top('g.device[data-ref="device:inet"] .dev-box');
        const pe1 = top('g.device[data-ref="device:isp1-pe"] .dev-box');
        const r1 = top('g.device[data-ref="device:hq-rtr1"] .dev-box');
        check(
          'Auto-arrange places the provider group by its cables: under the Internet, above the HQ routers it feeds, and over them',
          inet.bottom < prov.top && prov.bottom < hq.top && pe1.left + pe1.width / 2 > hq.left && pe1.left + pe1.width / 2 < hq.right && Math.abs(pe1.left - r1.left) < hq.width / 3 && !drawnProblems().length,
          JSON.stringify([Math.round(inet.bottom), Math.round(prov.top), Math.round(prov.bottom), Math.round(hq.top)]),
        );
      }
      click('[data-view-btn="logical"]');
      const logBefore = rects();
      check('loading a file does not store positions or mark it changed; status "Auto-arranged"', !(app.mdoc as ModelDoc).hasStoredLayout('physical') && !(app.mdoc as ModelDoc).dirty && status('physical') === 'auto' && status('logical') === 'auto');
      const ad = app.mdoc as ModelDoc;
      /** the positions shown in a view, and the view's part of the layout section */
      const viewState = (v: 'physical' | 'logical'): string => JSON.stringify([Array.from(ad.displayedPositions(v).entries()), Array.from(ad.result.model!.layout[v].entries()), Array.from(ad.result.model!.layout.manual[v])]);
      click('#btn-arrange');
      await tick(10);
      check(
        'Auto-arrange has no view chooser: it arranges the view on screen at once and leaves the other view alone',
        !q('#modal[open]') && ad.hasStoredLayout('logical') && !ad.hasStoredLayout('physical') && rects() === logBefore && ad.canUndo() === 'Auto-arrange (logical view)' && /nothing moved/.test(q('#toast')!.textContent || ''),
        `${ad.canUndo()} / ${q('#toast')!.textContent}`,
      );
      click('[data-view-btn="physical"]');
      click('#btn-arrange');
      await tick(10);
      check('arranging an automatic layout stores it without moving anything', !q('#modal[open]') && ad.hasStoredLayout('physical') && ad.hasStoredLayout('logical') && rects() === physBefore && /nothing moved/.test(q('#toast')!.textContent || ''));
      click('[data-view-btn="logical"]');
      check('… in the logical view as well', rects() === logBefore);
      check('status after Auto-arrange: both views "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto');
      const undoLabel = ad.canUndo();
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      await tick(10);
      check('auto-arranging again changes nothing (no question, no move, no undo step)', !q('#modal[open]') && ad.canUndo() === undoLabel && rects() === logBefore && /Already arranged/.test(q('#toast')!.textContent || ''));
      // manual move, then arrange restores the deterministic positions; undo brings the manual one back
      ad.movePositions('logical', new Map([['hq-fw', { x: 4321, y: 1234 }]]), 'Move hq-fw');
      app.mdoc && app.select(null);
      (app as unknown as { afterEdit(n?: string): void }).afterEdit();
      const moved = rects();
      check('a manual move changes only that node', moved !== logBefore && moved.split(' ').filter((x, i) => x !== logBefore.split(' ')[i]).every((x) => /device:hq-fw|iface:hq-fw/.test(x)));
      check('status after a logical move: Logical "Manually adjusted", Physical unchanged', status('logical') === 'manual' && status('physical') === 'auto');
      {
        // the views are tracked independently; the button follows the view on screen, and switching moves nothing
        const inLogical = shows('logical', 'manual');
        click('[data-view-btn="physical"]');
        const inPhysical = shows('physical', 'auto');
        click('[data-view-btn="logical"]');
        check('the button follows the shown view (logical: manually adjusted, physical: matches); switching views rearranges nothing', inLogical && inPhysical && shows('logical', 'manual') && rects() === moved, JSON.stringify(shown()));
      }
      // returning the node to its calculated position counts as auto-arranged again (derived, not a flag)
      ad.movePositions('logical', new Map([['hq-fw', ad.autoLayout('logical').get('hq-fw')!]]), 'Move hq-fw back');
      (app as unknown as { afterEdit(n?: string): void }).afterEdit();
      check('moving the node back to its calculated position shows "Auto-arranged"', status('logical') === 'auto' && rects() === logBefore);
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      check('undo of that shows "Manually adjusted" again', status('logical') === 'manual' && rects() === moved);
      {
        // positions set by hand are only replaced after a confirmation that says what changes
        const physState = viewState('physical');
        const logState = viewState('logical');
        const textBefore = app.exportText();
        const undoBefore = ad.canUndo();
        click('#btn-arrange');
        await tick(10);
        const asked = q('#modal[open]') ? q('#modal')!.textContent || '' : '';
        check(
          'Auto-arrange asks before replacing manual positions and explains what changes (which objects, this view only, undo)',
          /Replace manual positions in the logical view\?/.test(asked) && /1 object was positioned by hand in the logical view: hq-fw/.test(asked) && /physical view is not changed/.test(asked) && /Ctrl\+Z/.test(asked) &&
            !q('#modal [data-value="both"]') && !!q('#modal [data-value="cancel"]') && !!q('#modal [data-value="arrange"]'),
          asked,
        );
        await answerDialog('cancel');
        check(
          'Cancel leaves both views untouched (positions, stored layout, YAML, undo history, status)',
          rects() === moved && viewState('logical') === logState && viewState('physical') === physState && app.exportText() === textBefore && ad.canUndo() === undoBefore && status('logical') === 'manual' && status('physical') === 'auto',
        );
        click('#btn-arrange');
        await answerDialog('arrange');
        check('after confirming, Auto-arrange ignores manual positions (same result as before the move)', rects() === logBefore && status('logical') === 'auto');
        check('… and the other view is exactly as it was', viewState('physical') === physState);
      }
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      check('undo restores the manual position', rects() === moved && status('logical') === 'manual');
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
      check('redo: "Auto-arranged" again', status('logical') === 'auto' && shows('logical', 'auto'));
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
        check('status after exporting and reloading a manually adjusted layout: Physical "Manually adjusted"', status('physical') === 'manual' && status('logical') === 'auto' && shows('physical', 'manual'), JSON.stringify(shown()));
        const re = app.mdoc as ModelDoc;
        re.arrange(['physical', 'logical']);
        re.addEntity('device', [['id', strNode('hq-spare')], ['type', strNode('switch')], ['group', strNode('hq-core')]]);
        (app as unknown as { afterEdit(n?: string): void }).afterEdit();
        check('a model edit is not reported as a manual adjustment ("Edited since arranged")', status('physical') === 'edited' && status('logical') === 'edited' && shown().st === 'edited' && shown().icon === '\u25CF' && /no longer matches the auto-arranged layout/.test(shown().desc), JSON.stringify(shown()));
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
      const ref = FIXTURES.find((e) => e.name === 'metro-ring-arranged.yaml');
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
    check('status of a new model: both views "Auto-arranged"', status('physical') === 'auto' && status('logical') === 'auto' && shown().st === 'auto' && shown().desc === AUTO_MSG);
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
    click('#side-body [data-act="add-logical"][data-kind="loopback"]');
    await tick();
    await setField('#side-body [data-t="list-append"][data-p=\'["devices",0,"logical_interfaces",0,"ip"]\']', '10.255.0.1/32');
    click('[data-view-btn="logical"]');
    check(
      'new model: the loopback is a logical interface of type loopback and is drawn as a chip in the logical view',
      count('.loop-chip') === 1 && (app.mdoc as ModelDoc).valid && /logical_interfaces:\n {6}- \{id: lo0, type: loopback, ip: \[10\.255\.0\.1\/32\]\}/.test(app.exportText()) && !/\n {4}interfaces:|loopbacks:/.test(app.exportText()),
      app.exportText(),
    );
    check(
      'devices have no vendor, model, role, management-address or router-ID field',
      ['vendor', 'model', 'role', 'mgmt', 'router_id'].every((k) => !q(`#side-body [data-p='["devices",0,"${k}"]']`)) && !/Router ID \(loopback\)|Vendor|Management address/.test(q('#side-body')!.textContent || ''),
    );

    click('#outline [data-act="add-entity"][data-kind="device"]');
    await tick();
    check('Add device selects it in the inspector', (q('#side-body [data-t="id"]') as HTMLInputElement | null)?.value === 'device1');
    await setField('#side-body [data-t="id"]', 'edge2');
    // type a label without committing it, then press "+ Loopback" with the pointer
    const lbl = q('#side-body [data-p=\'["devices",1,"label"]\']') as HTMLInputElement;
    lbl.focus();
    lbl.value = 'Edge router 2';
    const addLoopBtn = q('#side-body [data-act="add-logical"][data-kind="loopback"]') as HTMLElement;
    addLoopBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 3 }));
    addLoopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await tick(10);
    check(
      'typing, then clicking an editor button keeps the typed text and performs the action',
      (app.mdoc as ModelDoc).text(['devices', 1, 'label']) === 'Edge router 2' && (app.mdoc as ModelDoc).interfaceIds(1).length === 1,
      JSON.stringify([(app.mdoc as ModelDoc).text(['devices', 1, 'label']), (app.mdoc as ModelDoc).interfaceIds(1)]),
    );
    const appendSel = '#side-body [data-t="list-append"][data-p=\'["devices",1,"logical_interfaces",0,"ip"]\']';
    await setField(appendSel, '10.255.0.2/32');
    await setField(appendSel, '2001:db8:ffff::2/128');
    await setField(appendSel, '10.255.0.3');
    const errText = Array.prototype.map.call(doc.querySelectorAll('#side-body details.card .field-err'), (e: Element) => e.textContent).join(' | ');
    check('invalid loopback address is reported next to the field', /needs a prefix length/.test(errText) && !(app.mdoc as ModelDoc).valid, errText);
    await setField('#side-body [data-t="list-item"][data-p=\'["devices",1,"logical_interfaces",0,"ip",2]\']', '10.255.0.3/32');
    await setField('#side-body [data-p=\'["devices",1,"logical_interfaces",0,"label"]\']', 'Router ID');
    click('#side-body [data-act="add-logical"][data-kind="loopback"]');
    await tick();
    await setField('#side-body [data-t="list-append"][data-p=\'["devices",1,"logical_interfaces",1,"ip"]\']', 'fd00::77/128');
    const dA = app.mdoc as ModelDoc;
    const loops = dA.result.model ? dA.result.model.index.devices.get('edge2')!.logical.filter((x) => x.type === 'loopback') : [];
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

    // ----------------- physical and logical interfaces, and what a logical interface is associated with
    {
      const selectDev = async (i: number): Promise<void> => {
        click(`#outline [data-act="select"][data-kind="device"][data-index="${i}"]`);
        await tick();
      };
      await selectDev(0);
      const dh = (): ModelDoc => app.mdoc as ModelDoc;
      const r1 = (): Device => dh().result.model!.index.devices.get('router1')!;
      const lg = (k: number): string => `["devices",0,"logical_interfaces",${k}]`;
      const card = (p: string): string => `#side-body details[data-card='${p}']`;
      const field = (k: number, key: string): string => `#side-body [data-p='["devices",0,"logical_interfaces",${k},"${key}"]']`;
      const labels = (p: string): string => (Array.prototype.map.call(doc.querySelectorAll(card(p) + ' > .field > label'), (e: Element) => (e.textContent || '').trim()) as string[]).join('|');
      const typeText = q(card('["devices",0,"interfaces",0]') + ' > [data-iface-type="physical"]');
      check(
        'a physical interface has no type to select: its type is read-only text "Physical"',
        !!typeText && /Physical/.test(typeText.textContent || '') && !typeText.querySelector('input, select, textarea') && !q(`#side-body [data-p='["devices",0,"interfaces",0,"type"]']`) && !/type: physical/.test(app.exportText()),
        typeText ? typeText.textContent || '' : 'no type text',
      );
      const loopSel = q(`#side-body select[data-t="logical-type"][data-p='["devices",0,"logical_interfaces",0,"type"]']`) as HTMLSelectElement | null;
      const typeOptions = loopSel ? (Array.prototype.map.call(loopSel.options, (o: HTMLOptionElement) => o.value + '=' + o.textContent) as string[]).join() : '';
      check(
        'interfaces are listed in two categories, Physical and Logical; a logical interface\'s type is Loopback, Virtual or Tunnel',
        !!q('#side-body [data-list="interfaces"] ' + `details[data-card='["devices",0,"interfaces",0]']`) && !!q('#side-body [data-list="logical"] ' + `details[data-card='${lg(0)}']`) && typeOptions === 'loopback=Loopback,virtual=Virtual,tunnel=Tunnel' && loopSel!.value === 'loopback' &&
          /Physical interfaces \(1\)/.test(q('#side-body [data-list="interfaces"] h4')!.textContent || '') && /Logical interfaces \(1\)/.test(q('#side-body [data-list="logical"] h4')!.textContent || '') &&
          !q('#side-body [data-act="add-child"]') && !/Child interfaces|Parent/.test(q('#side-body')!.textContent || ''),
        typeOptions,
      );
      check('a loopback has no parent, member or tunnel fields', !/Member ports|Ports carrying VLAN|Tunnel source|Tunnel destination/.test(labels(lg(0))) && /Addresses/.test(labels(lg(0))), labels(lg(0)));

      // an aggregate: a virtual interface that names several member ports
      click('#side-body [data-act="add-iface"]');
      await tick();
      click('#side-body [data-act="add-logical"][data-kind="virtual"]');
      await tick();
      const memberSel = `#side-body select[data-t="member-append"][data-p='["devices",0,"logical_interfaces",1,"members"]']`;
      const offered = (): string => (Array.prototype.map.call((q(memberSel) as HTMLSelectElement).options, (o: HTMLOptionElement) => o.value) as string[]).join();
      const before = offered();
      await setField(memberSel, 'eth1');
      await setField(memberSel, 'eth0');
      const chips = (): string => (Array.prototype.map.call(doc.querySelectorAll(card(lg(1)) + ' [data-member]'), (e: Element) => e.getAttribute('data-member')) as string[]).join();
      check(
        'a virtual interface can reference several member ports, picked from the device\'s physical interfaces (label "Member ports")',
        before === ',eth0,eth1' && offered() === '' && chips() === 'eth1,eth0' && r1().logical[1].members.join() === 'eth1,eth0' && r1().logical[1].type === 'virtual' && dh().valid &&
          /- \{id: virtual0, type: virtual, members: \[eth1, eth0\]\}/.test(app.exportText()) && /Member ports/.test(labels(lg(1))),
        `${before} / ${offered()} / ${chips()} / ${app.exportText()}`,
      );

      // a VLAN interface: it names its VLAN; the ports carrying that VLAN come from the link ends
      click('#side-body [data-act="add-logical"][data-kind="virtual"]');
      await tick();
      const vlanPorts = card(lg(2)) + ' > [data-derived="vlan-ports"]';
      // a virtual interface is not assumed to be a bond or a VLAN interface: until it is one, both are offered and no ports are shown
      const plain = labels(lg(2));
      const noVlanYet = !q(vlanPorts);
      await setField(field(2, 'vlan'), '30');
      const noPort = (q(vlanPorts) || { textContent: '' }).textContent || '';
      click('#outline [data-act="select"][data-kind="link"][data-index="0"]');
      await tick();
      await setField(`#side-body [data-t="vlan-add"][data-p='["links",0,"a"]']`, '30');
      await selectDev(0);
      const ports = (Array.prototype.map.call(doc.querySelectorAll(vlanPorts + ' li[data-port]'), (e: Element) => e.getAttribute('data-port')) as string[]).join();
      check(
        'a VLAN interface shows "Ports carrying VLAN" read-only, derived from the VLANs on the link ends; no port is entered on the interface',
        /Member ports/.test(plain) && /VLAN ID/.test(plain) && noVlanYet && /No link end of this device permits VLAN 30/.test(noPort) && ports === 'eth0' && !/Member ports/.test(labels(lg(2))) && /Ports carrying VLAN 30/.test(labels(lg(2))) &&
          !/VLAN ID|Ports carrying VLAN/.test(labels(lg(1))) && /VLAN 30 on/.test(q(vlanPorts)!.textContent || '') && !q(vlanPorts + ' input, ' + vlanPorts + ' select, ' + vlanPorts + ' [data-act]') &&
          !!q(vlanPorts + ' .derived-tag') && /- \{id: virtual1, type: virtual, vlan: 30\}/.test(app.exportText()) && r1().logical[2].members.length === 0 && dh().valid,
        `${plain} / ${noPort} / ${ports} / ${labels(lg(2))} / ${labels(lg(1))}`,
      );
      // taking the VLAN off the link takes the port out of the list; nothing on the interface changes
      click('#outline [data-act="select"][data-kind="link"][data-index="0"]');
      await tick();
      click('#side-body [data-act="del-vlan"][data-p=\'["links",0,"a"]\'][data-k="30"]');
      await tick();
      await selectDev(0);
      check('… and follows the links: without the VLAN on the cable no port is listed', doc.querySelectorAll(vlanPorts + ' li[data-port]').length === 0 && /- \{id: virtual1, type: virtual, vlan: 30\}/.test(app.exportText()) && !/vlans:/.test(app.exportText()));

      // a tunnel: its source is any interface of the device (here a loopback) or an address
      click('#side-body [data-act="add-logical"][data-kind="tunnel"]');
      await tick();
      await setField(field(3, 'source'), 'lo0');
      await setField(field(3, 'destination'), 'edge2:lo0');
      const t = (): Interface => r1().logical[3];
      const viaLoopback = dh().valid && t().type === 'tunnel' && !!t().source && t().source!.iface === 'lo0' && !!t().destination && t().destination!.device === 'edge2' && t().destination!.iface === 'lo0';
      await setField(field(3, 'source'), 'eth7');
      const badSource = (Array.prototype.map.call(doc.querySelectorAll(card(lg(3)) + ' .field-err'), (e: Element) => e.textContent) as string[]).join(' | ');
      await setField(field(3, 'source'), '10.255.0.1');
      const viaAddress = dh().valid && t().source!.address === '10.255.0.1' && t().source!.iface === 'lo0';
      await setField(field(3, 'source'), 'eth0');
      check(
        'a tunnel names its source (a loopback, an address or a port: not only a physical parent) and its destination; an unknown source is an error',
        viaLoopback && viaAddress && /tunnel source "eth7" is neither an IP address nor an interface of "router1"/.test(badSource) && dh().valid && t().source!.iface === 'eth0' && /Tunnel source\|Tunnel destination/.test(labels(lg(3))) &&
          !/Member ports|Ports carrying VLAN/.test(labels(lg(3))) && /- \{id: tun0, type: tunnel, source: eth0, destination: edge2:lo0\}/.test(app.exportText()),
        `${viaLoopback} ${viaAddress} ${badSource} ${labels(lg(3))}`,
      );

      // display order is alphabetical; the file keeps the order things were added in
      const shown = (list: string): string => (Array.prototype.map.call(doc.querySelectorAll(`#side-body [data-list="${list}"] > details.card`), (e: Element) => e.getAttribute('data-iface')) as string[]).join();
      const yamlBefore = app.exportText();
      await selectDev(1);
      await selectDev(0);
      check(
        'interfaces are shown alphabetically in both categories while the file keeps its own order; viewing changes nothing',
        shown('logical') === 'lo0,tun0,virtual0,virtual1' && shown('interfaces') === 'eth0,eth1' && r1().logical.map((i) => i.id).join() === 'lo0,virtual0,virtual1,tun0' && app.exportText() === yamlBefore,
        shown('logical'),
      );
      // a cable ends on a physical interface; renaming a port updates the member list that names it
      click('#outline [data-act="select"][data-kind="link"][data-index="0"]');
      await tick();
      const endIfs = (Array.prototype.map.call((q('#side-body select[data-t="ep-if"][data-p=\'["links",0,"a"]\']') as HTMLSelectElement).options, (o: HTMLOptionElement) => o.value) as string[]).join();
      check('a link end offers physical interfaces only', endIfs === ',eth0,eth1', endIfs);
      await selectDev(0);
      await setField(`#side-body [data-t="ifid"][data-p='["devices",0,"interfaces",1,"id"]']`, 'eth9');
      check('renaming a port updates the aggregate that lists it', dh().valid && r1().logical[1].members.join() === 'eth9,eth0' && /members: \[eth9, eth0\]/.test(app.exportText()));
      // selection: a logical interface highlights the ports it uses and their cables
      click('[data-view-btn="physical"]');
      app.select('iface:router1:virtual0');
      const bond = !!q(card(lg(1)) + '[open]') && !!q('#viewport [data-ref="iface:router1:eth0"].hl') && !!q('#viewport [data-ref="link:link1"].hl');
      app.select('iface:router1:tun0');
      const tun = !!q(card(lg(3)) + '[open]') && !!q('#viewport [data-ref="iface:router1:eth0"].hl') && !!q('#viewport [data-ref="link:link1"].hl') && !!q('#viewport [data-ref="device:edge2"].hl');
      check('selecting an aggregate highlights its member ports and their cables; selecting a tunnel its source port, that cable and the destination device', bond && tun, `${bond} ${tun}`);
      app.select(null);
    }
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
    const ifVlan = (dev: number, k: number, list = 'interfaces'): string => `#side-body [data-card='["devices",${dev},"${list}",${k}]'] > [data-derived="iface-vlan"]`;
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
          /- id: net1\n/.test(dn.exportText()) && !/kind:|vlan:|members:|cidr:/.test(dn.exportText().slice(dn.exportText().indexOf('networks:'))) && dn.valid && readOnly(members) && /Members \(0\)/.test(text(members)),
        dn.exportText() + ' // ' + text(members),
      );
      await setField('#side-body [data-t="list-append"][data-p=\'["networks",0,"cidr"]\']', '10.77.0.0/24');
      await setField('#side-body [data-t="int"][data-p=\'["networks",0,"vlan"]\']', '77');
      check('a prefix alone adds no member', /Members \(0\)/.test(text(members)) && count('.member') === 0 && /cidr: \[10\.77\.0\.0\/24\]\n {4}vlan: 77\n/.test((app.mdoc as ModelDoc).exportText()), (app.mdoc as ModelDoc).exportText());
      // an address on router1:eth0 makes router1 a member and gives the port the network's VLAN, at once
      await selectDevice(0);
      check('an interface without an address shows no derived network or VLAN (read-only)', readOnly(ifVlan(0, 0)) && /No address/.test(text(ifVlan(0, 0))), text(ifVlan(0, 0)));
      check(
        'interfaces have no editable VLAN, speed or media field',
        !q('#side-body [data-p=\'["devices",0,"interfaces",0,"vlan"]\']') && !q('#side-body [data-p=\'["devices",0,"interfaces",0,"speed"]\']') && !q('#side-body [data-p=\'["devices",0,"interfaces",0,"media"]\']') &&
          !q('#side-body [data-p=\'["devices",0,"logical_interfaces",0,"speed"]\']') && !q('#side-body [data-p=\'["devices",0,"logical_interfaces",3,"speed"]\']'),
      );
      await setField('#side-body [data-t="list-append"][data-p=\'["devices",0,"interfaces",0,"ip"]\']', '10.77.0.1/24');
      check(
        'typing an address updates the interface\'s derived VLAN immediately (VLAN 77 from net1)',
        !!q(ifVlan(0, 0) + ' li[data-vlan="77"]') && /net1 · VLAN 77/.test(text(ifVlan(0, 0))) && readOnly(ifVlan(0, 0)),
        text(ifVlan(0, 0)),
      );
      check('a loopback outside every network derives nothing, and no VLAN is invented', !!q(ifVlan(0, 0, 'logical_interfaces') + ' li[data-vlan="none"]') && /no network contains it/.test(text(ifVlan(0, 0, 'logical_interfaces'))), text(ifVlan(0, 0, 'logical_interfaces')));
      click('[data-view-btn="logical"]');
      check('… and the logical view draws the membership line at once', count('.member') === 1 && count('g.network') === 1, String(count('.member')));
      // the network's prefix decides: a different prefix length on the interface still matches
      await selectDevice(1);
      await setField('#side-body [data-t="list-append"][data-p=\'["devices",1,"interfaces",0,"ip"]\']', '10.77.0.2/16');
      await selectNetwork(0);
      check(
        'the network lists both devices once, with interface and address (own prefix length /16 does not matter)',
        /Members \(2\)/.test(text(members)) && doc.querySelectorAll(members + ' li[data-member]').length === 2 && /eth0 10\.77\.0\.1\/24/.test(text(members)) && /eth0 10\.77\.0\.2\/16/.test(text(members)) && count('.member') === 2,
        text(members),
      );
      // changing the network changes every derived value
      await setField('#side-body [data-t="int"][data-p=\'["networks",0,"vlan"]\']', '78');
      await selectDevice(0);
      check('changing the network\'s VLAN updates the interface immediately (78)', !!q(ifVlan(0, 0) + ' li[data-vlan="78"]'), text(ifVlan(0, 0)));
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
          !!q(ifVlan(0, 0) + ' li[data-vlan="ambiguous"]') && /VLAN 78 \(net1\) or VLAN 99 \(net2\)/.test(text(ifVlan(0, 0))) && da.valid && da.warnings.some((w) => /ambiguous/.test(w.message)),
          text(ifVlan(0, 0)),
        );
      }
      await selectNetwork(1);
      await setField('#side-body [data-t="list-item"][data-p=\'["networks",1,"cidr",0]\']', '10.99.0.0/24');
      await selectDevice(0);
      check('moving the second network away resolves it again (VLAN 78), and membership follows', !!q(ifVlan(0, 0) + ' li[data-vlan="78"]') && count('.member') === 2, text(ifVlan(0, 0)));
      const ex = (app.mdoc as ModelDoc).exportText();
      check('derived members and interface VLANs are never written to the YAML', !/\n {4}members:|kind:/.test(ex) && (ex.match(/vlan: /g) || []).length === 3 && !/eth0[^\n]*vlan/.test(ex), ex);
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
      check('exported new model reloads identically (valid, same YAML; loopbacks, aggregate, VLAN interface, tunnel + attrs intact)',
        !!rd && rd.valid && rd.exportText() === created.text && !!rm && rm.index.devices.get('edge2')!.logical.map((l) => l.id + ':' + l.type).join() === 'lo0:loopback,lo1:loopback' &&
          rm.index.interfaces.get('edge2:lo0')!.addresses.join(',') === '10.255.0.2/32,2001:db8:ffff::2/128,10.255.0.3/32' && rm.index.interfaces.get('edge2:lo0')!.type === 'loopback' &&
          rm.index.devices.get('router1')!.interfaces.map((i) => `${i.id}:${i.type}`).join() === 'eth0:physical,eth9:physical' &&
          rm.index.devices.get('router1')!.logical.map((i) => `${i.id}:${i.type}:${i.members.join('+')}:${i.vlan || ''}:${i.source ? i.source.iface : ''}>${i.destination ? i.destination.text : ''}`).join() === 'lo0:loopback:::>,virtual0:virtual:eth9+eth0::>,virtual1:virtual::30:>,tun0:tunnel:::eth0>edge2:lo0' &&
          rm.relations[0].attrs.some(([k, v]) => k === 'keepalive.interval' && v === '10s') && /key: 42/.test(created.text),
        created.text);
      check(
        'export → reload: per-end VLANs are in the file; members and interface VLANs are derived again, not stored',
        !!rm && JSON.stringify([rm.links[0].a.vlans, rm.links[0].b.vlans]) === '[[10,20],[10,20]]' && networkMembers(rm, 'net1').map((m) => m.device).join() === 'router1,edge2' &&
          interfaceVlanText(interfaceAddresses(rm, 'router1', 'eth0')) === 'VLAN 78' && !/\n {4}members:|kind:/.test(created.text) && /b: \{device: edge2, interface: eth0, vlans: \[10, 20\]\}/.test(created.text),
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
    const wanText = EXAMPLES.find((e) => /enterprise-wan/.test(e.name))!.text.replace('    label: hq-rtr1\n    type: router\n    group: hq-edge\n', '    label: hq-rtr1\n    type: router\n    group: hq-edge\n    attrs:\n      serial: JN11AB22CD\n      contract: {id: C-77, expires: 2027-01-31}\n');
    const imp = await app.loadFile(new File([wanText], 'acme-wan.yaml'));
    check('imported file opens in the editor', imp.ok && (app.mdoc as ModelDoc).origin === 'file' && (app.mdoc as ModelDoc).valid);
    app.select('device:hq-rtr1');
    await setField('#side-body [data-t="id"]', 'hq-edge-a');
    const renamed = (app.mdoc as ModelDoc).exportText();
    check('renaming a device updates every reference', (app.mdoc as ModelDoc).valid && !/hq-rtr1:|device: hq-rtr1|id: hq-rtr1/.test(renamed) && /label: hq-rtr1/.test(renamed) && (renamed.match(/hq-edge-a/g) || []).length >= 12,
      String((renamed.match(/hq-edge-a/g) || []).length));
    await setField('#side-body [data-p=\'["devices",3,"description"]\']', 'Primary edge router');
    click('#side-body [data-act="add-logical"][data-kind="loopback"]');
    await tick();
    await setField(`#side-body [data-t="list-append"][data-p='["devices",3,"logical_interfaces",2,"ip"]']`, '2001:db8:0:ff::1/128');
    click('#btn-download');
    await tick(10);
    check('export of an imported file is offered as a new copy', /original file on your disk is not modified/.test(q('#modal')!.textContent || '') && (q('#dl-name') as HTMLInputElement).value === 'acme-wan-edited.yaml');
    await answerDialog('download');
    const edited = await lastDownload();
    if (edited) {
      const back = ModelDoc.fromText(edited.text, edited.name, 'file').doc as ModelDoc;
      const bm = back.result.model!;
      check('import → edit → export → reload keeps the edits', back.valid && bm.index.devices.get('hq-edge-a')!.description === 'Primary edge router' && bm.index.devices.get('hq-edge-a')!.logical.map((l) => l.id).join() === 'lo0,st0.10,lo1' && bm.index.interfaces.get('hq-edge-a:lo1')!.addresses[0] === '2001:db8:0:ff::1/128' &&
        bm.index.interfaces.get('hq-edge-a:st0.10')!.source!.iface === 'ge-0/0/0' && bm.index.interfaces.get('hq-edge-a:st0.10')!.destination!.device === 'muc-rtr');
      check('attributes not shown in diagrams survive the round trip', /serial: JN11AB22CD/.test(edited.text) && /contract: \{id: C-77, expires: 2027-01-31\}/.test(edited.text) && /cipher: GCM-AES-XPN-256/.test(edited.text));
      check('comments of the imported file are kept', /# --- Munich: IPsec carries GRE carries OSPF/.test(edited.text) && /^# netatlas example: enterprise WAN/.test(edited.text));
    } else check('import → edit → export → reload keeps the edits', false, 'no download captured');

    // unsaved-change guards
    await setField('#side-body [data-p=\'["devices",3,"description"]\']', 'Primary edge router (MX304)');
    click('#menu-examples [data-example="0"]');
    await tick(10);
    check('replacing a dirty model asks first', !!q('#modal[open]') && /Unsaved changes/.test(q('#modal')!.textContent || ''));
    await answerDialog('cancel');
    check('cancel keeps the edited model', (app.mdoc as ModelDoc).fileName === 'acme-wan.yaml' && (app.mdoc as ModelDoc).dirty);
    const bu = new Event('beforeunload', { cancelable: true });
    (doc.defaultView as Window).dispatchEvent(bu);
    check('closing the page with unsaved changes asks the browser to confirm', bu.defaultPrevented);

    // undo / redo
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    check('Ctrl+Z undoes the last edit', app.mdoc!.result.model!.index.devices.get('hq-edge-a')!.description === 'Primary edge router');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    check('Ctrl+Y redoes it', app.mdoc!.result.model!.index.devices.get('hq-edge-a')!.description === 'Primary edge router (MX304)');

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
    const unk = app.loadText('netatlas: 1\ndevices:\n  - id: r1\n    colour: blue\n    logical_interfaces: [{id: lo0, type: loopback, ip: [10.0.0.1/32], weird: {x: 1}}]\n', 'unknown.yaml', 'file');
    app.select('device:r1');
    check('unknown properties are shown in the inspector, not dropped', unk.errors.length > 0 && !!q('#side-body .other') && /colour/.test(app.exportText()) && /weird: \{x: 1\}/.test(app.exportText()));
    click('#side-body [data-act="to-attrs"][data-k="colour"]');
    await tick();
    check('"move into attrs" fixes an unknown property', /attrs:\n\s+colour: blue/.test(app.exportText()));

    // keys that are not part of the format are rejected with what to do instead (never read or converted)
    {
      const badFile = app.loadText(
        'netatlas: 1\ngroups:\n  - {id: g1, kind: row}\ndevices:\n  - id: r1\n    vendor: Acme\n    router_id: lo0\n    interfaces: [{id: e0, type: physical, speed: 1G, media: fiber, vlan: 5, ip: 10.0.0.1/24, children: [{id: t0, type: tunnel}]}]\n    loopbacks: [{id: lo0, ip: 10.9.9.9/32}]\nnetworks:\n  - {id: n1, kind: vlan, vrf: red, cidr: 10.0.0.0/24, members: [r1]}\n',
        'unsupported-keys.yaml',
        'file',
      );
      const msgs = badFile.errors.map((e) => e.message).join(' | ');
      check(
        'a file with keys outside the format opens as a draft with one actionable error per key',
        badFile.ok && badFile.errors.length === 12 && /"children" is not part of the format — interfaces are not nested/.test(msgs) && /"loopbacks" is not part of the format/.test(msgs) && /"speed" is not part of the format/.test(msgs) && /"vendor" is not part of the format/.test(msgs) && /"router_id" is not part of the format/.test(msgs) && /"type" is not part of the format/.test(msgs) &&
          (app.mdoc as ModelDoc).result.model!.devices[0].logical.length === 0 && (app.mdoc as ModelDoc).result.model!.devices[0].interfaces.length === 1 && (app.mdoc as ModelDoc).result.model!.devices[0].interfaces.every((i) => i.type === 'physical') && /"members" is not part of the format/.test(msgs) && /write "kind: floor"/.test(msgs) &&
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

    {
      // after everything above (long forms, every tab, both views, dialogs): the page still fits its window
      const root = doc.documentElement;
      (doc.defaultView as Window).scrollTo(0, 100000);
      const scrolled = (doc.defaultView as Window).scrollY || root.scrollTop || doc.body.scrollTop;
      const st = (q('#status') as HTMLElement).getBoundingClientRect();
      const side = (q('#side') as HTMLElement).getBoundingClientRect();
      check(
        'the application fits the window: the document does not scroll, and the side panel ends at the status bar',
        root.scrollHeight <= root.clientHeight && root.scrollWidth <= root.clientWidth && !scrolled && Math.abs(st.bottom - root.clientHeight) <= 1 && side.bottom <= st.top + 0.5,
        `document ${root.scrollWidth}x${root.scrollHeight} in ${root.clientWidth}x${root.clientHeight}, scrolled ${scrolled}, side ends at ${side.bottom}, status ${st.top}–${st.bottom}`,
      );
    }
    // ------------------------------------------------ Export view as… PNG / SVG: what the pictures contain
    {
      interface Px { w: number; h: number; data: Uint8ClampedArray }
      /** wait for work the browser does outside the page's timers (decoding, encoding), keeping the run's clock going */
      const alive = async <T>(p: Promise<T>): Promise<T> => {
        let settled = false;
        const done = (): void => void (settled = true);
        p.then(done, done);
        for (let n = 0; n < 3000 && !settled; n++) await tick(10);
        return p;
      };
      const be = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
      /** read a PNG: its signature and header, and its pixels as the browser decodes them */
      const readPng = async (blob: Blob): Promise<{ valid: boolean; w: number; h: number; px: Px }> => {
        const bytes = new Uint8Array(await alive(blob.arrayBuffer()));
        const sig = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) && String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === 'IHDR';
        // decoded as an image from a data: URL, like any picture in a page
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 8192)) as number[]);
        const bmp = new Image();
        await alive(
          new Promise<void>((done, fail) => {
            bmp.onload = () => done();
            bmp.onerror = () => fail(new Error('the PNG cannot be decoded'));
            bmp.src = 'data:image/png;base64,' + btoa(bin);
          }),
        );
        const c = doc.createElement('canvas');
        c.width = bmp.naturalWidth;
        c.height = bmp.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        ctx.drawImage(bmp, 0, 0);
        return { valid: sig, w: be(bytes, 16), h: be(bytes, 20), px: { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data } };
      };
      /** share of the pixels of a rectangle (in pixels) that differ from the colour of the picture's first pixel */
      const ink = (p: Px, x0: number, y0: number, x1: number, y1: number): number => {
        const d = p.data;
        let n = 0;
        let all = 0;
        for (let y = Math.max(0, Math.floor(y0)); y < Math.min(p.h, Math.ceil(y1)); y++)
          for (let x = Math.max(0, Math.floor(x0)); x < Math.min(p.w, Math.ceil(x1)); x++) {
            const i = (y * p.w + x) * 4;
            all++;
            if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24 || d[i + 3] !== 255) n++;
          }
        return all ? n / all : 0;
      };
      interface Box { x: number; y: number; w: number; h: number }
      /** what an exported SVG contains: size, the legend and Networks boxes (in picture units), its texts */
      const readSvg = (text: string): { w: number; h: number; vb: number[]; legend: Box | null; networks: Box | null; netCount: number; texts: string[]; heading: string; devices: number; content: Box | null } => {
        const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
        const vb = (root.getAttribute('viewBox') || '').split(' ').map(Number);
        const box = (sel: string): Box | null => {
          const g = root.querySelector(sel);
          const m = g ? /translate\(([-0-9.]+) ([-0-9.]+)\)/.exec(g.getAttribute('transform') || '') : null;
          const r = g ? g.querySelector('rect') : null;
          return m && r ? { x: +m[1] - vb[0], y: +m[2] - vb[1], w: +(r.getAttribute('width') || 0), h: +(r.getAttribute('height') || 0) } : null;
        };
        const nw = root.querySelector('g.svg-networks');
        const texts = (Array.prototype.map.call(root.querySelectorAll('text'), (t: Element) => t.textContent || '') as string[]);
        return { w: +(root.getAttribute('width') || 0), h: +(root.getAttribute('height') || 0), vb, legend: box('g.svg-legend'), networks: box('g.svg-networks'), netCount: nw ? +(nw.getAttribute('data-count') || 0) : -1, texts, heading: nw ? (nw.querySelector('text') as Element).textContent || '' : '', devices: root.querySelectorAll('g.device').length, content: null };
      };
      const within = (b: Box | null, w: number, h: number): boolean => !!b && b.x >= 0 && b.y >= 0 && b.x + b.w <= w + 0.5 && b.y + b.h <= h + 0.5;
      /** export the view on screen in both formats through the menu and compare the two pictures */
      const both = async (base: string, view: string): Promise<{ ok: boolean; why: string; svg: ReturnType<typeof readSvg>; scale: number; png: { w: number; h: number } }> => {
        const why: string[] = [];
        const got: { [fmt: string]: string } = {};
        for (const fmt of ['svg', 'png']) {
          click('#export-btn');
          click('#btn-export-as');
          const had = downloads.length;
          click('#btn-export-' + fmt);
          for (let n = 0; n < 1500 && downloads.length === had; n++) await tick(10);
          const d = downloads.length > had ? downloads[downloads.length - 1] : undefined;
          if (!d || d.name !== `${base}-${view}.${fmt}`) why.push(`${fmt}: downloaded ${d ? d.name : 'nothing'}`);
          got[fmt] = d ? d.name : '';
          if (q('#modal[open]')) {
            why.push(`${fmt}: ${q('#modal')!.textContent}`);
            await answerDialog('ok');
          }
        }
        const svgText = (downloads.filter((d) => d.name === got.svg).pop() || { text: '' }).text;
        const svg = readSvg(svgText);
        const blob = pictures.get(got.png);
        if (!svgText || !blob) return { ok: false, why: why.join('; ') || 'a picture is missing', svg, scale: 0, png: { w: 0, h: 0 } };
        const png = await readPng(blob);
        const scale = pngScale(svg.w, svg.h);
        if (!png.valid) why.push('not a PNG file');
        if (png.w !== Math.round(svg.w * scale) || png.h !== Math.round(svg.h * scale) || png.px.w !== png.w || png.px.h !== png.h) why.push(`PNG is ${png.w}x${png.h}, expected ${svg.w}x${svg.h} at ${scale}`);
        // the whole diagram: the bounds come from what is drawn, not from the part on screen
        const bounds = (app as unknown as { bounds: Box }).bounds;
        if (svg.vb[0] > bounds.x + 0.5 || svg.vb[1] > bounds.y + 0.5 || svg.vb[0] + svg.vb[2] < bounds.x + bounds.w - 0.5 || svg.vb[1] + svg.vb[3] < bounds.y + bounds.h - 0.5) why.push('the picture is smaller than the diagram');
        if (svg.devices !== count('g.device')) why.push(`${svg.devices} of ${count('g.device')} devices`);
        if (/transform=/.test(/<g[^>]*id="viewport"[^>]*>/.exec(svgText)![0])) why.push('the pan/zoom of the screen is in the picture');
        if (svg.texts.some((t) => /…$|\.\.\.$/.test(t))) why.push('shortened text');
        // legend and Networks box: inside the picture, for this view, and drawn in the PNG
        if (!within(svg.legend, svg.w, svg.h)) why.push('legend outside the picture');
        if (!within(svg.networks, svg.w, svg.h)) why.push('Networks box outside the picture');
        if (svg.texts.indexOf(`Legend — ${view} view`) < 0) why.push('no legend for this view');
        if (svg.heading !== `Networks — ${view} view`) why.push('Networks box: ' + svg.heading);
        for (const [name, b] of [['legend', svg.legend], ['Networks box', svg.networks]] as Array<[string, Box | null]>) {
          if (!b) continue;
          const share = ink(png.px, b.x * scale, b.y * scale, (b.x + b.w) * scale, (b.y + b.h) * scale);
          if (share < 0.01) why.push(`${name} is blank in the PNG (${share})`);
        }
        const all = ink(png.px, 0, 0, png.w, png.h);
        if (all < 0.005) why.push(`the PNG is blank (${all})`);
        // margin: the boxes beside the diagram keep a distance to the edge of the picture, so nothing is cut off
        for (const b of [svg.legend, svg.networks]) if (b && (b.x < 8 || b.y < 8 || svg.w - b.x - b.w < 8 || svg.h - b.y - b.h < 8)) why.push('a box touches the edge of the picture');
        // same composition: the downloaded SVG, drawn at the PNG's size, gives the PNG's pixels
        const again = await readPng((await alive(svgToPng(doc, svgText, svg.w, svg.h, getComputedStyle(q('#canvas-wrap') as HTMLElement).backgroundColor))).blob);
        let differ = 0;
        if (again.px.data.length !== png.px.data.length) differ = -1;
        else for (let i = 0; i < png.px.data.length; i += 4) if (Math.abs(png.px.data[i] - again.px.data[i]) + Math.abs(png.px.data[i + 1] - again.px.data[i + 1]) + Math.abs(png.px.data[i + 2] - again.px.data[i + 2]) > 24) differ++;
        if (differ < 0 || differ > (png.w * png.h) / 1000) why.push(`the PNG differs from the SVG in ${differ} pixels`);
        return { ok: !why.length, why: why.join('; '), svg, scale, png: { w: png.w, h: png.h } };
      };

      // enterprise WAN, zoomed in and panned away: the picture is still the whole diagram
      app.mdoc!.markSaved();
      app.loadExample(EXAMPLES.findIndex((e) => e.name === 'enterprise-wan.yaml'));
      const res: { [view: string]: Awaited<ReturnType<typeof both>> } = {};
      for (const view of ['physical', 'logical']) {
        click(`[data-view-btn="${view}"]`);
        await tick();
        for (let n = 0; n < 4; n++) click('#zoom-in');
        (q('#canvas') as unknown as Element).dispatchEvent(new WheelEvent('wheel', { deltaX: 400, deltaY: 300, bubbles: true, cancelable: true }));
        res[view] = await both('enterprise-wan', view);
        click('#zoom-fit');
        check(`PNG and SVG of the ${view} view (enterprise WAN, zoomed in): the whole diagram with a margin, full labels, the legend and the Networks box of that view; the PNG is the SVG at ${res[view].scale}× and shows the same picture`, res[view].ok, `${res[view].why} svg ${res[view].svg.w}x${res[view].svg.h} png ${res[view].png.w}x${res[view].png.h}`);
      }
      check(
        'each view exports its own picture: different legends and sizes, the Networks box headed by the view, and interface names only in the physical one',
        res.physical.svg.heading !== res.logical.svg.heading && res.physical.svg.texts.join('|') !== res.logical.svg.texts.join('|') && res.physical.svg.netCount > 0 && res.logical.svg.netCount > 0,
        `${res.physical.svg.heading} (${res.physical.svg.netCount}) / ${res.logical.svg.heading} (${res.logical.svg.netCount})`,
      );
      {
        // view-specific network information: a network that only loopbacks are in belongs to the logical picture alone
        app.loadText(FIXTURES.find((e) => e.name === 'editor-new-network.yaml')!.text, 'editor-new-network.yaml', 'example');
        click('[data-view-btn="physical"]');
        const p = await both('editor-new-network', 'physical');
        click('[data-view-btn="logical"]');
        const l = await both('editor-new-network', 'logical');
        check('the Networks box of each exported picture lists the networks of that view (a loopback-only network only in the logical PNG and SVG)', p.ok && l.ok && l.svg.netCount > p.svg.netCount && l.svg.networks!.h > p.svg.networks!.h, `${p.why} / ${l.why} / ${p.svg.netCount} < ${l.svg.netCount}`);
      }
      {
        // long labels: nothing shortened, nothing cut off
        app.loadExample(EXAMPLES.findIndex((e) => e.name === 'long-labels.yaml'));
        for (const view of ['physical', 'logical']) {
          click(`[data-view-btn="${view}"]`);
          const r = await both('long-labels', view);
          const longest = r.svg.texts.reduce((a, t) => Math.max(a, t.length), 0);
          check(`long labels, ${view} view: PNG and SVG carry every label in full, inside the picture`, r.ok && longest > 30, `${r.why} longest text ${longest}`);
        }
      }
      {
        // a large diagram: 96 devices in 8 groups
        const lines = ['netatlas: 1', 'title: Large network with many devices', 'groups:'];
        for (let g = 0; g < 8; g++) lines.push(`  - {id: site-${g}, label: Site number ${g} with a long descriptive name, kind: site}`);
        lines.push('devices:');
        for (let g = 0; g < 8; g++)
          for (let n = 0; n < 12; n++) {
            lines.push(`  - id: d${g}-${n}`, `    label: Device ${n} of site ${g}`, `    type: ${n === 0 ? 'router' : 'switch'}`, `    group: site-${g}`, '    interfaces:', `      - {id: up, ip: 10.${g}.0.${n + 1}/24}`, '      - {id: down}', '      - {id: wan}');
            lines.push('    logical_interfaces:', `      - {id: lo0, type: loopback, ip: 10.255.${g}.${n + 1}/32}`);
          }
        lines.push('links:');
        for (let g = 0; g < 8; g++) {
          for (let n = 1; n < 12; n++) lines.push(`  - {id: l${g}-${n}, a: "d${g}-${n}:up", b: "d${g}-${n - 1}:${n === 1 ? 'down' : 'down'}", speed: 10G}`.replace(`d${g}-${n - 1}:down`, n % 3 === 1 ? `d${g}-0:down` : `d${g}-${n - 1}:down`));
          lines.push(`  - {id: wan-${g}, a: "d${g}-0:wan", b: "d${(g + 1) % 8}-0:up", speed: 100G, label: backbone ${g}}`);
        }
        lines.push('networks:');
        for (let g = 0; g < 8; g++) lines.push(`  - {id: net-${g}, label: Site ${g} access, cidr: 10.${g}.0.0/24, vlan: ${100 + g}}`);
        lines.push('  - {id: net-lo, label: Loopbacks, cidr: 10.255.0.0/16}');
        const big = app.loadText(lines.join('\n') + '\n', 'large-network.yaml', 'file');
        const drawn = count('g.device');
        const sizes: string[] = [];
        let okBig = !!big && drawn === 96;
        for (const view of ['physical', 'logical']) {
          click(`[data-view-btn="${view}"]`);
          await tick();
          const r = await both('large-network', view);
          okBig = okBig && r.ok && r.svg.devices === 96 && r.svg.netCount >= 8 && r.png.w <= PNG_MAX_SIDE && r.png.h <= PNG_MAX_SIDE && r.png.w * r.png.h <= PNG_MAX_PIXELS * 1.001 && r.svg.w > 1500;
          sizes.push(`${view}: ${r.why} svg ${r.svg.w}x${r.svg.h} png ${r.png.w}x${r.png.h} at ${r.scale} networks ${r.svg.netCount}`);
        }
        check('a large diagram (96 devices, 8 groups, 9 networks) exports completely as PNG and SVG in both views, within the size a browser can draw', okBig, `${drawn} devices; ${sizes.join(' | ')}`);
      }
      {
        // a picture too large for one image is drawn smaller, not cut off (checked with the limits lowered for the run)
        const small = pngScale(40000, 10000);
        const huge = pngScale(100000, 100000);
        check('PNG size limits: twice the diagram size normally, reduced for very large diagrams so that the whole picture still fits', pngScale(1200, 800) === 2 && Math.abs(small - PNG_MAX_SIDE / 40000) < 1e-9 && Math.abs(huge - Math.sqrt(PNG_MAX_PIXELS) / 100000) < 1e-9 && huge < small);
      }
      {
        // failures are reported, and nothing is downloaded
        const had = downloads.length;
        const proto = HTMLCanvasElement.prototype as unknown as { toBlob: (cb: (b: Blob | null) => void) => void };
        const origToBlob = proto.toBlob;
        proto.toBlob = (cb): void => cb(null);
        click('#export-btn');
        click('#btn-export-as');
        click('#btn-export-png');
        for (let n = 0; n < 300 && !q('#modal[open]'); n++) await tick(10);
        proto.toBlob = origToBlob;
        const said = q('#modal[open]') ? q('#modal')!.textContent || '' : '';
        await answerDialog('ok');
        check(
          'a PNG export that fails is reported in a dialog (what, why, and that nothing was downloaded); nothing is downloaded and the model stays as it was',
          /Could not export the view as PNG/.test(said) && /“large-network-logical\.png” was not created: the browser could not encode a \d+ × \d+ pixel picture\./.test(said) && /Nothing was downloaded/.test(said) && /SVG export has no such limit/.test(said) && downloads.length === had && !q('#modal[open]') && count('g.device') === 96,
          said,
        );
        const xs = XMLSerializer.prototype as unknown as { serializeToString: (n: Node) => string };
        const origSer = xs.serializeToString;
        xs.serializeToString = (): string => {
          throw new Error('out of memory');
        };
        click('#export-btn');
        click('#btn-export-as');
        click('#btn-export-svg');
        for (let n = 0; n < 300 && !q('#modal[open]'); n++) await tick(10);
        xs.serializeToString = origSer;
        const saidSvg = q('#modal[open]') ? q('#modal')!.textContent || '' : '';
        await answerDialog('ok');
        check('a failing SVG export is reported the same way', /Could not export the view as SVG/.test(saidSvg) && /“large-network-logical\.svg” was not created: out of memory\./.test(saidSvg) && downloads.length === had, saidSvg);
      }
    }

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

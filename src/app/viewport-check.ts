/**
 * In-browser check that the application shell fits the browser viewport,
 * run by opening the built file with "#viewportcheck" appended to the URL
 * (scripts/browser-selftest.mjs does that at several window sizes and zoom
 * factors). It drives the real UI into its content-heavy states and
 * measures the page: the document itself must never scroll, the toolbar,
 * diagram controls and status bar must stay inside the window, and long
 * content must scroll inside its own panel.
 */
import { EXAMPLES } from '../generated/examples';
import { App } from '../ui/app';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runViewportCheck(app: App, doc: Document): Promise<Check[]> {
  const win = doc.defaultView as Window;
  const root = doc.documentElement;
  const checks: Check[] = [];
  const q = (sel: string): HTMLElement | null => doc.querySelector(sel) as HTMLElement | null;
  const click = (sel: string): void => {
    const b = q(sel);
    if (b) b.click();
  };
  const vw = (): number => root.clientWidth;
  const vh = (): number => root.clientHeight;

  /** Everything that must hold in every state of the page. Returns the problems found. */
  const problems = (): string[] => {
    const why: string[] = [];
    // the document has nothing to scroll, and cannot be scrolled
    if (root.scrollHeight > vh()) why.push(`document is ${root.scrollHeight}px high in a ${vh()}px window`);
    if (root.scrollWidth > vw()) why.push(`document is ${root.scrollWidth}px wide in a ${vw()}px window`);
    if (doc.body.scrollHeight > vh() + 0.5) why.push(`body content is ${doc.body.scrollHeight}px high`);
    win.scrollTo(0, 100000);
    root.scrollTop = 100000;
    doc.body.scrollTop = 100000;
    const scrolled = win.scrollY || root.scrollTop || doc.body.scrollTop;
    if (scrolled) why.push(`the document scrolled by ${scrolled}px`);
    win.scrollTo(100000, 0);
    const sideways = win.scrollX || root.scrollLeft || doc.body.scrollLeft;
    if (sideways) why.push(`the document scrolled sideways by ${sideways}px`);
    win.scrollTo(0, 0);
    root.scrollTop = 0;
    doc.body.scrollTop = 0;
    // every part of the shell lies inside the window
    // (the start screen has no panels: they appear with the first model)
    const started = doc.body.getAttribute('data-state') !== 'empty';
    const panels = started ? ['#outline', '#side', '#side .tabs', '#side-body'] : [];
    for (const sel of ['header.topbar', 'main', '#canvas-wrap', '#status'].concat(panels)) {
      const e = q(sel);
      if (!e) {
        why.push('missing ' + sel);
        continue;
      }
      const r = e.getBoundingClientRect();
      if (r.top < -0.5 || r.left < -0.5 || r.bottom > vh() + 0.5 || r.right > vw() + 0.5) why.push(`${sel} leaves the window (${Math.round(r.left)},${Math.round(r.top)} – ${Math.round(r.right)},${Math.round(r.bottom)} of ${vw()}x${vh()})`);
      if (r.width < 1 || r.height < 1) why.push(`${sel} has no room (${Math.round(r.width)}x${Math.round(r.height)})`);
    }
    // the panels end where the status bar begins: nothing extends below the application's bottom edge
    const status = (q('#status') as HTMLElement).getBoundingClientRect();
    for (const sel of started ? ['#side', '#outline', '#canvas-wrap'] : ['#canvas-wrap']) {
      const r = (q(sel) as HTMLElement).getBoundingClientRect();
      if (r.bottom > status.top + 0.5) why.push(`${sel} extends below the status bar (${Math.round(r.bottom)} > ${Math.round(status.top)})`);
    }
    if (Math.abs(status.bottom - vh()) > 1) why.push(`the status bar is not at the bottom edge (${Math.round(status.bottom)} of ${vh()})`);
    // toolbar controls: all inside the window, none clipped by the toolbar
    const bar = (q('header.topbar') as HTMLElement).getBoundingClientRect();
    const controls = doc.querySelectorAll('header.topbar button, header.topbar select, header.topbar input#search, header.topbar label.opt');
    for (let i = 0; i < controls.length; i++) {
      const c = controls[i] as HTMLElement;
      if (c.closest('.dropdown')) continue; // entries of an open drop-down lie below the toolbar by design (checked separately)
      const r = c.getBoundingClientRect();
      if (!r.width && !r.height) continue; // not shown in this view (e.g. logical-only options)
      if (r.left < -0.5 || r.right > vw() + 0.5 || r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5) why.push(`toolbar control "${(c.textContent || c.id || '').trim().slice(0, 20)}" is clipped`);
    }
    return why;
  };
  const state = (name: string, extra: string[] = []): void => {
    const why = problems().concat(extra);
    checks.push({ name, ok: !why.length, detail: why.join('; ') });
  };
  /**
   * A panel whose content is longer than the panel scrolls inside itself,
   * down to its last element. `must`: the content is known to be longer
   * than any window (otherwise a panel that shows everything is fine too).
   */
  const scrollsInside = (sel: string, must = false): string[] => {
    const e = q(sel) as HTMLElement;
    const why: string[] = [];
    if (e.scrollHeight <= e.clientHeight + 1) return must ? [`${sel} was expected to have more content than fits (${e.scrollHeight} <= ${e.clientHeight})`] : [];
    const style = win.getComputedStyle(e).overflowY;
    if (style !== 'auto' && style !== 'scroll') why.push(`${sel} does not scroll (overflow-y: ${style})`);
    e.scrollTop = e.scrollHeight;
    if (e.scrollTop < 1) why.push(`${sel} could not be scrolled`);
    if (Math.abs(e.scrollTop + e.clientHeight - e.scrollHeight) > 1.5) why.push(`${sel} does not reach its end`);
    const last = e.lastElementChild ? e.lastElementChild.getBoundingClientRect() : null;
    const box = e.getBoundingClientRect();
    // the visible part of the panel ends above its own horizontal scrollbar, if it has one
    const visibleBottom = box.top + e.clientTop + e.clientHeight;
    if (last && last.bottom > visibleBottom + 1) why.push(`the end of ${sel} stays hidden (content ends at ${Math.round(last.bottom)}, panel at ${Math.round(visibleBottom)}; ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight})`);
    if (box.bottom > vh() + 0.5) why.push(`${sel} ends below the window`);
    return why.concat(problems());
  };

  try {
    state('empty start page');
    {
      // every way to begin can be brought into view inside the start screen (it scrolls by itself in a small window), never the page
      const why: string[] = [];
      const area = (q('#canvas-wrap') as HTMLElement).getBoundingClientRect();
      for (const sel of ['#empty h1', '#new-empty', '#open-empty', '#start-example', '#start-load', '#empty .start-note']) {
        const e = q(sel);
        if (!e) {
          why.push('missing ' + sel);
          continue;
        }
        e.scrollIntoView({ block: 'nearest' });
        const r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) why.push(`${sel} is not shown`);
        else if (r.top < area.top - 0.5 || r.bottom > area.bottom + 0.5 || r.left < area.left - 0.5 || r.right > area.right + 0.5 || r.bottom > vh() + 0.5) why.push(`${sel} cannot be brought into view (${Math.round(r.top)}–${Math.round(r.bottom)} of ${Math.round(area.top)}–${Math.round(area.bottom)})`);
        else {
          const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || !(e.contains(hit) || hit.contains(e))) why.push(`${sel} is covered`);
        }
      }
      state('start screen: name, the three ways to begin and the note are reachable', why);
      (q('#empty') as HTMLElement).scrollTop = 0;
    }

    // a long device form: every interface card open
    app.loadExample(EXAMPLES.findIndex((e) => /enterprise-wan/.test(e.name)));
    app.select('device:hq-core1');
    await tick();
    const cards = doc.querySelectorAll('#side-body details');
    for (let i = 0; i < cards.length; i++) (cards[i] as HTMLDetailsElement).open = true;
    await tick();
    state('long device form (all cards open)', scrollsInside('#side-body', true));
    // focusing and revealing the last field must scroll the panel, not the page
    const inputs = doc.querySelectorAll('#side-body input, #side-body textarea');
    const lastInput = inputs[inputs.length - 1] as HTMLElement;
    (q('#side-body') as HTMLElement).scrollTop = 0;
    lastInput.focus();
    lastInput.scrollIntoView();
    await tick();
    const r = lastInput.getBoundingClientRect();
    state('focusing the last field of the form', r.bottom > vh() || r.top < 0 ? ['the focused field is outside the window'] : []);
    state('the model outline is longer than its panel', scrollsInside('#outline', true));
    const zoom = (q('.zoombar') as HTMLElement).getBoundingClientRect();
    const canvas = (q('#canvas-wrap') as HTMLElement).getBoundingClientRect();
    state('diagram controls stay inside the diagram area', zoom.top < canvas.top || zoom.bottom > canvas.bottom || zoom.left < canvas.left || zoom.right > canvas.right || zoom.bottom > vh() ? ['the zoom bar leaves the diagram area'] : []);
    {
      // the Auto-arrange group: its label above one row of three buttons, inside a dashed frame, within the window
      const g = q('#arrange-group') as HTMLElement;
      const gr = g.getBoundingClientRect();
      const tr = (q('#arrange-title') as HTMLElement).getBoundingClientRect();
      const bs = ['default', 'compact', 'spacious'].map((s) => (q('#btn-arrange-' + s) as HTMLElement).getBoundingClientRect());
      const why: string[] = [];
      const cs = (doc.defaultView as Window).getComputedStyle(g);
      if (cs.borderTopStyle !== 'dashed') why.push('the group has no dashed frame');
      if (tr.width < 1 || tr.height < 1) why.push('the label is not shown');
      if (bs.some((b) => b.top < tr.bottom - 0.5)) why.push('the label is not above the buttons');
      if (bs.some((b) => Math.abs(b.top - bs[0].top) > 0.5 || Math.abs(b.height - bs[0].height) > 0.5)) why.push('the buttons are not on one row');
      if (bs[1].left < bs[0].right - 1.5 || bs[2].left < bs[1].right - 1.5 || bs[1].left > bs[0].right + 0.5 || bs[2].left > bs[1].right + 0.5) why.push('the buttons are not side by side');
      if ([tr].concat(bs).some((r) => r.left < gr.left - 0.5 || r.right > gr.right + 0.5 || r.top < gr.top - 0.5 || r.bottom > gr.bottom + 0.5)) why.push('the label or a button leaves the frame');
      if (gr.left < -0.5 || gr.right > vw() + 0.5 || gr.top < -0.5) why.push('the group leaves the window');
      state('the Auto-arrange group: label above the three buttons, in one dashed frame', why);
    }

    // drop-downs of the toolbar open over the page: fully visible, not clipped by the toolbar, inside the window
    const popup = (sel: string): string[] => {
      const e = q(sel);
      if (!e || e.hidden) return [`${sel} is not shown`];
      const r = e.getBoundingClientRect();
      const why: string[] = [];
      if (r.width < 40 || r.height < 20) why.push(`${sel} has no room (${Math.round(r.width)}x${Math.round(r.height)})`);
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw() + 0.5 || r.bottom > vh() + 0.5) why.push(`${sel} leaves the window (${Math.round(r.left)},${Math.round(r.top)} – ${Math.round(r.right)},${Math.round(r.bottom)} of ${vw()}x${vh()})`);
      // what is actually on top at three points of it is the drop-down itself
      for (const [fx, fy] of [[0.5, 0.1], [0.5, 0.5], [0.5, 0.9]]) {
        const hit = doc.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        if (!hit || !e.contains(hit)) why.push(`${sel} is covered or clipped at ${Math.round(fy * 100)}% of its height`);
      }
      return why;
    };
    click('#view-btn');
    await tick();
    state('View menu open', popup('#view-menu'));
    click('#btn-find');
    await tick();
    const search = q('#search') as HTMLInputElement;
    search.value = 'hq';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    state('Find bar with its results drop-down', popup('#find-bar').concat(popup('#search-results')));
    app.closeFind();

    // the diagram filters stay on one row; what does not fit is in the Filters drop-down, which says what is off
    for (const view of ['logical', 'physical']) {
      click(`[data-view-btn="${view}"]`);
      await tick();
      const group = q('#view-filters') as HTMLElement;
      const parts = (Array.prototype.slice.call(group.children) as HTMLElement[]).filter((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
      const tops = parts.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2));
      const why: string[] = [];
      if (tops.some((t) => Math.abs(t - tops[0]) > 2)) why.push(`the filters are on more than one row (${tops.join(', ')})`);
      const gr = group.getBoundingClientRect();
      if (gr.right > vw() + 0.5 || gr.left < -0.5) why.push('the filters leave the window');
      for (const e of parts) if (e.getBoundingClientRect().right > gr.right + 0.5) why.push(`${(e.textContent || '').trim()} sticks out of the filter group`);
      const more = q('#more-filters-btn') as HTMLButtonElement;
      if (!more.hidden) {
        click('#more-filters-btn');
        await tick();
        why.push(...popup('#more-filters'));
        // a switch that this view shows (Networks is there in the logical view only)
        const box = (Array.prototype.slice.call(doc.querySelectorAll('#more-filters input:not(:disabled)')) as HTMLInputElement[]).find((x) => x.offsetParent !== null) || null;
        if (box && (q('#more-filters') as HTMLElement).contains(box)) {
          box.click();
          await tick();
          if (!/off/.test(more.textContent || '') || more.getAttribute('data-off') !== '1') why.push('the Filters button does not say that a filter inside it is off');
          box.click();
          await tick();
        }
        click('#more-filters-btn');
        await tick();
      }
      state(`${view} view: diagram filters on one row (${more.hidden ? 'all shown' : 'some in Filters'})`, why);
    }

    // a long file name: a badge at the start of the status bar, shortened, never wider than the bar
    {
      app.mdoc && app.mdoc.markSaved();
      const long = 'a-very-long-file-name-of-a-network-model-that-does-not-fit-anywhere-' + 'x'.repeat(80) + '.yaml';
      app.loadText(EXAMPLES[0].text, long, 'file');
      await tick();
      const bar = (q('#status') as HTMLElement).getBoundingClientRect();
      const badge = q('#status .fname') as HTMLElement;
      const br = badge.getBoundingClientRect();
      const why: string[] = [];
      if (badge.title.indexOf(long + ':') !== 0) why.push('the full name is not its tooltip');
      if (br.left < bar.left || br.right > bar.right + 0.5 || br.width > bar.width * 0.5 + 1) why.push(`the badge takes ${Math.round(br.width)} of ${Math.round(bar.width)}px`);
      if ((q('#status') as HTMLElement).scrollHeight > (q('#status') as HTMLElement).clientHeight + 1) why.push('the status bar wraps');
      state('a long file name in the status bar', why);
      app.mdoc && app.mdoc.markSaved();
      app.loadExample(0);
      await tick();
    }
    click('#menu-btn');
    await tick();
    const lastEntry = doc.querySelectorAll('#main-menu button');
    const menu = q('#main-menu') as HTMLElement;
    menu.scrollTop = menu.scrollHeight;
    const le = lastEntry[lastEntry.length - 1].getBoundingClientRect();
    state('File menu open', popup('#main-menu').concat(le.bottom > vh() + 0.5 ? ['the last example of the menu cannot be reached'] : []));
    click('#menu-btn');
    await tick();
    state('File menu closed again', q('#main-menu') && !(q('#main-menu') as HTMLElement).hidden ? ['the menu did not close'] : []);
    click('#export-btn');
    await tick();
    state('Export menu open', popup('#export-menu'));
    click('#btn-export-as');
    await tick();
    state('Export submenu open (PNG, SVG)', (q('#export-formats') as HTMLElement).hidden ? ['the submenu did not open'] : popup('#export-menu'));
    click('#export-btn');
    await tick();

    // switching views and tabs
    for (const view of ['logical', 'physical']) {
      click(`[data-view-btn="${view}"]`);
      await tick();
      state(`${view} view with the form open`);
    }
    for (const tab of ['details', 'legend', 'relations', 'problems', 'yaml', 'edit']) {
      click(`[data-tab="${tab}"]`);
      await tick();
      state(`side panel tab "${tab}"`);
    }
    click('[data-view-btn="logical"]');
    click('[data-tab="relations"]');
    await tick();
    state('relations list in the logical view', scrollsInside('#side-body'));
    click('[data-tab="yaml"]');
    await tick();
    state('YAML tab (the whole file as text)');

    // a draft with many problems, and a dialog on top
    app.mdoc && app.mdoc.markSaved();
    app.loadText('netatlas: 1\ndevices:\n' + Array.from({ length: 60 }, (_, i) => `  - {id: d${i}, vendor: x, interfaces: [{id: e0, type: x}]}\n`).join(''), 'many-errors.yaml', 'file');
    click('[data-tab="problems"]');
    await tick();
    state('problems list with 120 entries', scrollsInside('#side-body', true));
    // the largest dialog of saving: the download of a copy (a browser without a save picker), with the model's errors
    app.fileAccess = { saveFile: null, openFile: null };
    click('#menu-btn');
    click('#btn-save-as');
    await tick(10);
    const dlg = q('#modal[open] .modal-inner');
    const dr = dlg ? dlg.getBoundingClientRect() : null;
    state('a dialog is open', !dr ? ['no dialog'] : dr.top < 0 || dr.bottom > vh() + 0.5 || dr.left < 0 || dr.right > vw() + 0.5 ? [`the dialog leaves the window (${Math.round(dr.top)} – ${Math.round(dr.bottom)} of ${vh()})`] : []);
    const cancel = q('#modal[open] [data-value="cancel"]');
    const cr = cancel ? cancel.getBoundingClientRect() : null;
    state('the dialog buttons can be reached', !cr || cr.bottom > vh() + 0.5 || cr.top < 0 ? ['the dialog buttons are outside the window'] : []);
    if (cancel) cancel.click();
    await tick(10);
    app.mdoc && app.mdoc.markSaved();
  } catch (e) {
    checks.push({ name: 'viewport check crashed', ok: false, detail: String((e as Error).stack || e) });
  }

  const pass = checks.every((c) => c.ok);
  const out = doc.getElementById('selftest') as HTMLElement;
  out.hidden = false;
  out.textContent = JSON.stringify({ pass, total: checks.length, window: `${vw()}x${vh()}`, failed: checks.filter((c) => !c.ok), checks }, null, 1);
  doc.body.setAttribute('data-selftest', pass ? 'pass' : 'fail');
  return checks;
}

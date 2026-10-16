/**
 * The self-test of the released application (dist/netatlas.html#selftest):
 * what can be checked with the public examples alone, in both themes. The
 * full self-test needs the internal examples and runs on the test build
 * (npm run build, then build/netatlas-test.html#selftest; scripts/browser-selftest.mjs).
 * The result is written to the page as JSON, as the full self-test's is.
 */
import { EXAMPLES } from '../generated/examples';
import { App } from '../ui/app';
import { internalExamples } from '../ui/examples';
import { drawnProblems } from './drawn-check';
import { outlineStability } from './outline-check';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function report(doc: Document, checks: Check[], extra: { [k: string]: unknown }): void {
  const pass = checks.every((c) => c.ok);
  const out = doc.getElementById('selftest') as HTMLElement;
  out.hidden = false;
  out.textContent = JSON.stringify({ pass, total: checks.length, failed: checks.filter((c) => !c.ok), ...extra, checks }, null, 1);
  doc.body.setAttribute('data-selftest', pass ? 'pass' : 'fail');
}

export async function runPublicSelfTest(app: App, doc: Document): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
    doc.body.setAttribute('data-selftest-last', `${checks.length}: ${name}`);
  };
  const q = (sel: string): HTMLElement | null => doc.querySelector(sel) as HTMLElement | null;
  let violations = 0;
  doc.addEventListener('securitypolicyviolation', () => violations++);
  const html = doc.documentElement;
  const before = html.getAttribute('data-theme');
  try {
    // the catalog: the File menu and the start screen offer the public examples, and this build has no others
    const labels = Array.prototype.map.call(doc.querySelectorAll('#menu-examples .mi-label'), (e: Element) => e.textContent || '') as string[];
    check('the File menu lists the public examples, in the catalog order', labels.join() === EXAMPLES.map((e) => e.name).join(), labels.join(', '));
    check("the start screen's example picker offers the same examples", (q('#start-example') as HTMLSelectElement).querySelectorAll('option[value]:not([value=""])').length === EXAMPLES.length);
    check('this build carries no internal examples (they are in the test build only)', internalExamples().length === 0, String(internalExamples().length));
    // every public example, both themes: valid, both views drawn without overlaps
    for (const theme of ['light', 'dark']) {
      html.setAttribute('data-theme', theme);
      for (let i = 0; i < EXAMPLES.length; i++) {
        const ex = EXAMPLES[i];
        app.loadExample(i);
        await tick(10);
        const errs = app.mdoc ? app.mdoc.errors.length : -1;
        check(`${theme}: ${ex.name} loads without errors`, errs === 0, String(errs));
        for (const view of ['physical', 'logical'] as const) {
          app.setView(view);
          await tick(10);
          const drawn = doc.querySelectorAll('#viewport g.device').length;
          // measured at 100 % zoom (as the full self-test measures at a desktop size): a browser lays out text it draws
          // very small with hinted glyph widths, so a far-zoomed-out fit in a narrow window measures differently
          const vp = doc.getElementById('viewport') as unknown as SVGGraphicsElement | null;
          const scale = vp && vp.getCTM() ? (vp.getCTM() as DOMMatrix).a : 1;
          if (scale > 0 && Math.abs(scale - 1) > 0.01) app.zoomBy(1 / scale);
          await tick(10);
          const probs = drawnProblems(doc);
          app.fit();
          check(`${theme}: ${ex.name}, ${view} view: drawn, nothing overlaps`, drawn > 0 && !probs.length, `${drawn} devices; ${probs.slice(0, 3).join('; ')}`);
        }
        app.mdoc!.markSaved();
      }
      // the device type selector names the types in sentence case (VPN gateway), from the registry
      app.loadExample(0);
      await tick(10);
      const first = doc.querySelector('#viewport g.device') as Element | null;
      app.select(first ? first.getAttribute('data-ref') : null);
      const tab = q('[data-tab="edit"]');
      if (tab) tab.click();
      await tick(10);
      const opts = Array.prototype.map.call(doc.querySelectorAll('#side-body select[data-key="type"] option'), (o: Element) => o.textContent || '') as string[];
      check(`${theme}: the type selector offers "VPN gateway" (sentence case, like "Access point")`, opts.indexOf('VPN gateway') >= 0 && opts.indexOf('Access point') >= 0 && !opts.some((o) => /VPN G[a]teway/.test(o)), opts.join(', '));
      // the Objects list: folding a section moves no heading
      const why = await outlineStability(app, doc);
      check(`${theme}: Objects list: folding and unfolding (click, keyboard, all) moves no section heading; the focus stays and takes no room`, !why.length, why.slice(0, 4).join('; '));
      app.mdoc!.markSaved();
    }
    const perf = (doc.defaultView as Window).performance;
    const resources = perf && perf.getEntriesByType ? perf.getEntriesByType('resource').length : 0;
    check('no network resources requested', resources === 0, String(resources));
    check('no CSP violations', violations === 0, String(violations));
  } catch (e) {
    check('self-test crashed', false, String((e as Error).stack || e));
  } finally {
    if (before === null) html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', before);
  }
  app.loadExample(0);
  report(doc, checks, { scope: 'public', note: 'The public self-test: the examples of this build. The full self-test runs on the test build (npm run build, then build/netatlas-test.html#selftest).' });
  return checks;
}

/** "#viewportcheck" in the released application: it needs the internal examples; says so instead of starting. */
export function notInThisBuild(app: App, doc: Document): void {
  void app;
  report(doc, [], { scope: 'none', skipped: true, note: 'The viewport check needs the internal examples and runs on the test build only: npm run build, then build/netatlas-test.html#viewportcheck (node scripts/browser-selftest.mjs --viewport).' });
  doc.body.setAttribute('data-selftest', 'skipped');
}

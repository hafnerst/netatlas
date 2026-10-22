import { App } from '../ui/app';
import { applyTheme, readTheme } from '../ui/theme';

/** What a build runs for a "#selftest" or "#viewportcheck" link instead of the application's start. */
export interface BootHooks {
  selftest: (app: App, doc: Document) => unknown;
  viewportcheck: (app: App, doc: Document) => unknown;
}

/** Start the application (both builds: src/app/main.ts and src/app/main-test.ts). */
export function boot(hooks: BootHooks): void {
  const start = (): void => {
    const app = new App(document);
    (window as unknown as { netatlas: App }).netatlas = app;
    const hash = location.hash.replace(/^#/, '');
    if (hash === 'selftest') {
      void hooks.selftest(app, document);
      return;
    }
    if (hash === 'viewportcheck') {
      void hooks.viewportcheck(app, document);
      return;
    }
    // Optional deep link to a built-in example, by its place in the catalog or its file name,
    // e.g. "#example=0&view=logical&devices=hq-rtr1,hq-fw" or "#example=private-house.yaml&view=physical".
    const params = new Map<string, string>();
    for (const part of hash.split('&')) {
      const i = part.indexOf('=');
      if (i > 0) params.set(part.slice(0, i), part.slice(i + 1));
    }
    const example = params.get('example');
    const ex = example !== undefined ? decodeURIComponent(example) : '';
    if (/^[0-9]+$/.test(ex) ? app.loadExample(Number(ex)) : /\.ya?ml$/.test(ex) ? app.loadExampleNamed(ex) : null) {
      const view = params.get('view');
      if (view === 'logical' || view === 'physical') app.setView(view);
      // "devices=a,b": show only these devices (a temporary filtered view)
      const devices = params.get('devices');
      if (devices !== undefined) app.setDevices(decodeURIComponent(devices).split(',').filter((x) => !!x));
      const select = params.get('select');
      if (select) app.select(decodeURIComponent(select), true);
    }
  };
  // The script runs in the document's <head>: the stored theme is in effect before the body is drawn
  // (no flash of the other theme); the application starts once the document is there.
  applyTheme(document, readTheme(window));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

import { App } from '../ui/app';
import { runSelfTest } from './selftest';
import { runViewportCheck } from './viewport-check';

function start(): void {
  const app = new App(document);
  (window as unknown as { netatlas: App }).netatlas = app;
  const hash = location.hash.replace(/^#/, '');
  if (hash === 'selftest') {
    void runSelfTest(app, document);
    return;
  }
  if (hash === 'viewportcheck') {
    void runViewportCheck(app, document);
    return;
  }
  // Optional deep link to a built-in example, e.g. "#example=0&view=logical&devices=hq-rtr1,hq-fw".
  const params: { [k: string]: string } = {};
  for (const part of hash.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) params[part.slice(0, i)] = part.slice(i + 1);
  }
  if (params.example !== undefined && /^[0-9]+$/.test(params.example)) {
    app.loadExample(Number(params.example));
    if (params.view === 'logical' || params.view === 'physical') app.setView(params.view);
    // "devices=a,b": show only these devices (a temporary filtered view)
    if (params.devices !== undefined) app.setDevices(decodeURIComponent(params.devices).split(',').filter((x) => !!x));
    if (params.select) app.select(decodeURIComponent(params.select), true);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

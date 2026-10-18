/**
 * The execution scope of a simulation, chosen in Start simulation: a
 * select of the scopes that apply (analysis/exec-scope.ts) and, for the one
 * chosen, how many devices it runs, what was added for it to run
 * faithfully, its boundary and what it can't run — behind an expansion.
 * The entire model is the default; a scope never changes what is drawn.
 */
import { ExecScope } from '../analysis/exec-scope';
import { el } from './dom';

export function scopeChooser(doc: Document, scopes: ExecScope[]): { el: HTMLElement; selected(): ExecScope | undefined } {
  const sel = el(doc, 'select', { id: 'sim-pd-scope', 'aria-describedby': 'sim-pd-scope-help' }) as HTMLSelectElement;
  scopes.forEach((s, k) => sel.appendChild(el(doc, 'option', { value: String(k) }, [s.label])));
  const info = el(doc, 'div', { id: 'sim-pd-scope-info', class: 'small' });
  const total = scopes.length ? scopes[0].devices.size : 0;
  const show = (): void => {
    while (info.firstChild) info.removeChild(info.firstChild);
    const s = scopes[Number(sel.value) || 0];
    if (!s || s.kind === 'entire') {
      info.appendChild(el(doc, 'p', { class: 'muted' }, [`Runs every device (${total}).`]));
      return;
    }
    info.appendChild(el(doc, 'p', {}, [`Runs ${s.devices.size} of ${total} devices; the others are not run at all (marked Not run), and nothing answers from them.`]));
    for (const c of s.cannot) info.appendChild(el(doc, 'p', { class: 'trace-error' }, ['Can’t run faithfully: ' + c]));
    const d = el(doc, 'details', { class: 'layer-ev', id: 'sim-pd-scope-detail' }, [el(doc, 'summary', {}, [`Included for it (${s.included.length}) and its boundary (${s.boundary.length} cable${s.boundary.length === 1 ? '' : 's'}${s.cutRelations.length ? `, ${s.cutRelations.length} relation${s.cutRelations.length === 1 ? '' : 's'}` : ''})`])]);
    const ul = el(doc, 'ul', {});
    for (const x of s.included.slice(0, 40)) ul.appendChild(el(doc, 'li', {}, [`${x.device}: ${x.why}`]));
    for (const b of s.boundary.slice(0, 40)) ul.appendChild(el(doc, 'li', { class: 'muted' }, [`Boundary: ${b.device}${b.iface ? ':' + b.iface : ''} (cable ${b.link}) leads to ${b.outside}, not run`]));
    if (s.cutRelations.length) ul.appendChild(el(doc, 'li', { class: 'muted' }, [`Relations to devices outside (their sessions can’t form): ${s.cutRelations.join(', ')}`]));
    d.appendChild(ul);
    info.appendChild(d);
  };
  sel.addEventListener('change', show);
  show();
  const box = el(doc, 'fieldset', { class: 'sim-pd-scope' }, [el(doc, 'legend', {}, ['Execution scope']), el(doc, 'p', { id: 'sim-pd-scope-help', class: 'muted small' }, ['What runs: not what is drawn (the filters), nor what an analysis evaluates.']), sel, info]);
  return { el: box, selected: () => scopes[Number(sel.value) || 0] };
}

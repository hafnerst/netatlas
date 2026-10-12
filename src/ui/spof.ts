/**
 * The Single points of failure report in the Analysis tab (Analyze →
 * Single points of failure). It analyzes the model as written, like the
 * other Analyze reports: nothing here starts a simulation by itself. Each
 * entry names the object (a link that selects it in the diagram), what its
 * failure cuts off and which relations go down, and offers an explicit
 * Simulate this failure, which starts an ad-hoc scenario (Simulate mode).
 * Built from elements and text nodes only; the data comes from
 * analysis/failure.ts (singlePointsOfFailure).
 */
import { Spof, refLabel } from '../analysis/failure';
import { Model } from '../model/types';
import { el } from './dom';

export interface SpofActions {
  /** why Simulate this failure is unavailable now ('' = it is available) */
  simulateBlocked: string;
  simulate(s: Spof): void;
  close(): void;
}

const KIND: { [k in Spof['kind']]: string } = { device: 'Device', cable: 'Cable', lag: 'LAG' };

/** The report's section: heading, what it lists, one entry per single point of failure (most impact first), Close report. */
export function spofSection(doc: Document, model: Model, list: Spof[], simOn: boolean, act: SpofActions): HTMLElement {
  const box = el(doc, 'section', { class: 'spof-report', 'aria-labelledby': 'spof-title' });
  const close = el(doc, 'button', { type: 'button', class: 'mini', id: 'spof-close', title: 'Hide the report (the model is not changed)' }, ['Close report']);
  close.addEventListener('click', () => act.close());
  box.appendChild(el(doc, 'div', { class: 'spof-head' }, [el(doc, 'h3', { id: 'spof-title', tabindex: '-1' }, ['Single points of failure']), close]));
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      'The cables, devices and LAGs whose failure alone cuts devices off from the rest of the physical network, or brings down relations whose endpoints are still up (no redundant underlay). Most impact first. Computed from the model as written',
      simOn ? ' (not the simulated state that is on).' : '.',
    ]),
  );
  if (!list.length) {
    box.appendChild(el(doc, 'p', { role: 'status', class: 'spof-count' }, ['No single point of failure: every cable, device and LAG can fail without cutting the network or bringing a relation down.']));
    return box;
  }
  box.appendChild(el(doc, 'p', { role: 'status', class: 'spof-count' }, [`${list.length} single point${list.length === 1 ? '' : 's'} of failure.`]));
  const ul = el(doc, 'ul', { class: 'spof-list', 'aria-label': 'Single points of failure' });
  for (const s of list) {
    const name = s.kind === 'lag' ? `${refLabel(model, s.ref)} (${s.fail.length} cables)` : refLabel(model, s.ref);
    const sim = el(doc, 'button', { type: 'button', class: 'mini', 'data-spof-sim': s.ref, 'aria-label': `Simulate the failure of ${name}`, title: act.simulateBlocked || 'Start a scenario that fails it (Simulate mode; the model is not changed)' }, ['Simulate this failure']) as HTMLButtonElement;
    sim.disabled = !!act.simulateBlocked;
    sim.addEventListener('click', () => act.simulate(s));
    ul.appendChild(
      el(doc, 'li', { 'data-spof': s.ref, 'data-spof-kind': s.kind }, [
        el(doc, 'div', { class: 'spof-name' }, [el(doc, 'span', { class: 'spof-kind' }, [KIND[s.kind] + ' ']), el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': s.ref, title: 'Select it in the diagram' }, [name])]),
        el(doc, 'p', { class: 'small' }, [el(doc, 'span', { class: 'muted' }, ['Cuts off: ']), s.isolated.length ? s.isolated.map((g) => g.join(', ')).join('; ') : 'nothing']),
        el(doc, 'p', { class: 'small' }, [el(doc, 'span', { class: 'muted' }, ['Relations down: ']), s.relations.length ? s.relations.join(', ') : 'none']),
        el(doc, 'div', { class: 'spof-act' }, [sim]),
      ]),
    );
  }
  box.appendChild(ul);
  if (act.simulateBlocked) box.appendChild(el(doc, 'p', { class: 'muted small', id: 'spof-sim-why' }, [act.simulateBlocked]));
  return box;
}

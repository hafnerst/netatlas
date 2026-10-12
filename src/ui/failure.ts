/**
 * Failure simulation in the Analysis tab (what failed, what is down or
 * degraded, which device pairs lose reachability) and the Single points of
 * failure report (a dialog). Built from elements and text nodes only; the
 * data comes from analysis/failure.ts. Objects are links that select them
 * in the diagram (data-goto); every state is written as a word with a
 * symbol, never shown by colour alone.
 */
import { Affected, FailureResult, FailureSummary, LostPair, Spof, refLabel } from '../analysis/failure';
import { Model } from '../model/types';
import { el } from './dom';

/** A simulation on screen: the result, what is affected, and the reachability lost. */
export interface SimView {
  res: FailureResult;
  summary: FailureSummary;
  lost: { pairs: LostPair[]; checked: number; total: number };
}

export interface SimPanelActions {
  remove(ref: string): void;
  /** the selection can be failed too ('' = it can; else why not) */
  addBlocked: string;
  add(): void;
  exit(): void;
  spof(): void;
}

/** How many lost pairs are listed before "and N more". */
const PAIRS_SHOWN = 40;

const STATE: { [s: string]: [string, string] } = {
  down: ['✕', 'Down'],
  degraded: ['◐', 'Degraded'],
  takeover: ['↻', 'Takes over'],
};

/** One line counting a kind: "2 down, 3 degraded" ('' when none). */
function countText(list: Affected[]): string {
  const down = list.filter((a) => a.state === 'down').length;
  const deg = list.filter((a) => a.state === 'degraded').length;
  const take = list.filter((a) => a.state === 'takeover').length;
  return [down ? `${down} down` : '', deg ? `${deg} degraded` : '', take ? `${take} take${take === 1 ? 's' : ''} over` : ''].filter((x) => x).join(', ');
}

/** The status line of a simulation: "7 down · 8 degraded · 3 device pairs lose reachability". */
export function simSummary(v: SimView): string {
  const s = v.summary;
  const all = s.devices.concat(s.links, s.relations, s.tunnels, s.networks, s.routes);
  const down = all.filter((a) => a.state === 'down').length;
  const deg = all.length - down;
  const lost = v.lost.pairs.filter((p) => !p.partial).length;
  const part = v.lost.pairs.length - lost;
  return `${down} down · ${deg} degraded or taken over · ${lost} device pair${lost === 1 ? '' : 's'} lose${lost === 1 ? 's' : ''} reachability${part ? ` (${part} more in part)` : ''}`;
}

/** The Failure simulation section of the Analysis tab. */
export function simPanel(doc: Document, model: Model, v: SimView | null, act: SimPanelActions): HTMLElement {
  const box = el(doc, 'section', { class: 'sim-panel', 'aria-label': 'Failure simulation' });
  box.appendChild(el(doc, 'h3', {}, ['Failure simulation']));
  const spof = el(doc, 'button', { type: 'button', id: 'sim-spof' }, ['Single points of failure…']);
  spof.addEventListener('click', () => act.spof());
  const add = el(doc, 'button', { type: 'button', id: 'sim-add', title: act.addBlocked || 'Fail the selected object too (X)' }, [v ? 'Fail the selection too' : 'Fail the selection']) as HTMLButtonElement;
  add.disabled = !!act.addBlocked;
  add.addEventListener('click', () => act.add());
  if (!v) {
    box.appendChild(
      el(doc, 'p', { class: 'muted small' }, ['Select a cable, port, device or relation and press X (Analyze → Simulate failure of selection) to see what fails with it. The model does not change.']),
    );
    box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [add, spof]));
    if (act.addBlocked) box.appendChild(el(doc, 'p', { class: 'muted small' }, [act.addBlocked]));
    return box;
  }
  box.appendChild(el(doc, 'p', { class: 'sim-status', role: 'status' }, [el(doc, 'span', { class: 'ts-mark', 'aria-hidden': 'true' }, ['⚠ ']), 'Simulation: ', simSummary(v)]));
  // what failed
  box.appendChild(el(doc, 'h4', {}, ['Failed']));
  const ul = el(doc, 'ul', { class: 'sim-failed reflist' });
  for (const r of v.res.failed) {
    const restore = el(doc, 'button', { type: 'button', class: 'mini', 'data-sim-remove': r, 'aria-label': `Restore ${refLabel(model, r)}`, title: 'Take it out of the simulation' }, ['Restore']);
    restore.addEventListener('click', () => act.remove(r));
    ul.appendChild(el(doc, 'li', {}, [el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': r }, [refLabel(model, r)]), ' ', restore]));
  }
  box.appendChild(ul);
  const exit = el(doc, 'button', { type: 'button', id: 'sim-exit', title: 'End the simulation (Esc)' }, ['Exit simulation']);
  exit.addEventListener('click', () => act.exit());
  box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [add, exit, spof]));
  // the counts
  const s = v.summary;
  const rows: Array<[string, Affected[]]> = [
    ['Relations', s.relations],
    ['Tunnels', s.tunnels],
    ['Networks', s.networks],
    ['Static routes', s.routes],
    ['Devices', s.devices],
    ['Cables', s.links],
  ];
  const tbl = el(doc, 'table', { class: 'sim-counts' });
  tbl.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Affected objects per kind']));
  for (const [label, list] of rows) tbl.appendChild(el(doc, 'tr', {}, [el(doc, 'th', { scope: 'row' }, [label]), el(doc, 'td', {}, [countText(list) || 'unaffected'])]));
  const lostAll = v.lost.pairs.filter((p) => !p.partial).length;
  const lostPart = v.lost.pairs.length - lostAll;
  tbl.appendChild(el(doc, 'tr', {}, [el(doc, 'th', { scope: 'row' }, ['Device pairs']), el(doc, 'td', {}, [lostAll || lostPart ? `${lostAll} lose reachability${lostPart ? `, ${lostPart} in part` : ''}` : 'all still reach each other'])]));
  box.appendChild(tbl);
  // the lists
  for (const [label, list] of rows) {
    if (!list.length) continue;
    box.appendChild(el(doc, 'h4', {}, [`${label} (${list.length})`]));
    const l = el(doc, 'ul', { class: 'sim-list' });
    for (const a of list) {
      const [sym, word] = STATE[a.state] || ['', a.state];
      l.appendChild(
        el(doc, 'li', { class: 'sim-' + a.state }, [
          el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [sym + ' ']), word]),
          ' ',
          el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': a.ref }, [refLabel(model, a.ref)]),
          a.why ? el(doc, 'span', { class: 'sim-why' }, [' — ' + a.why]) : null,
        ]),
      );
    }
    box.appendChild(l);
  }
  // reachability
  box.appendChild(el(doc, 'h4', {}, [`Reachability (${v.lost.pairs.length})`]));
  if (v.lost.pairs.length) {
    const l = el(doc, 'ul', { class: 'sim-list' });
    for (const p of v.lost.pairs.slice(0, PAIRS_SHOWN)) {
      l.appendChild(
        el(doc, 'li', { class: p.partial ? 'sim-degraded' : 'sim-down' }, [
          el(doc, 'span', { class: 'sim-state' }, [el(doc, 'span', { 'aria-hidden': 'true' }, [p.partial ? '◐ ' : '✕ ']), p.partial ? 'In part' : 'Lost']),
          ' ',
          el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + p.from }, [p.from]),
          ' → ',
          el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': 'device:' + p.to }, [p.to]),
          el(doc, 'span', { class: 'sim-why' }, [' — ' + p.detail]),
        ]),
      );
    }
    box.appendChild(l);
    if (v.lost.pairs.length > PAIRS_SHOWN) box.appendChild(el(doc, 'p', { class: 'muted small' }, [`… and ${v.lost.pairs.length - PAIRS_SHOWN} more.`]));
  } else box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Every device pair that reached each other still does.']));
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      `Checked by tracing between every two of ${v.lost.checked} devices with an address${v.lost.total > v.lost.checked ? ` (the first ${v.lost.checked} of ${v.lost.total} by id)` : ''}; pairs with a failed device are not counted. Trace a path below to see the way traffic takes now.`,
    ]),
  );
  box.appendChild(
    el(doc, 'p', { class: 'trace-key small' }, [
      'In the diagram: ',
      el(doc, 'span', { class: 'tk tk-down' }, ['dotted, faded']),
      ' down; ',
      el(doc, 'span', { class: 'tk tk-deg' }, ['dash-dot']),
      ' degraded (a LAG with members down, a redundancy group failing over, a floating route taking over).',
    ]),
  );
  return box;
}

const KIND: { [k in Spof['kind']]: string } = { device: 'Device', cable: 'Cable', lag: 'LAG' };

/** The Single points of failure dialog's body: one row per point, each a button that starts its simulation (data-spof). */
export function spofBody(doc: Document, model: Model, list: Spof[]): HTMLElement {
  const box = el(doc, 'div', { class: 'spof-body' });
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      'The cables, devices and LAGs whose failure alone cuts devices off from the rest of the physical network, or brings down relations whose endpoints are still up (no redundant underlay). Most impact first. Choose one to simulate its failure.',
    ]),
  );
  if (!list.length) {
    box.appendChild(el(doc, 'p', { role: 'status' }, ['No single point of failure: every cable, device and LAG can fail without cutting the network or bringing a relation down.']));
    return box;
  }
  box.appendChild(el(doc, 'p', { role: 'status', class: 'spof-count' }, [`${list.length} single point${list.length === 1 ? '' : 's'} of failure.`]));
  const wrap = el(doc, 'div', { class: 'spof-wrap' });
  const t = el(doc, 'table', { class: 'spof-table' });
  t.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, [el(doc, 'th', { scope: 'col' }, ['Kind']), el(doc, 'th', { scope: 'col' }, ['Fails']), el(doc, 'th', { scope: 'col' }, ['Cuts off']), el(doc, 'th', { scope: 'col' }, ['Relations down'])])]));
  const tb = el(doc, 'tbody');
  for (const s of list) {
    const name = s.kind === 'lag' ? `${refLabel(model, s.ref)} (${s.fail.length} cables)` : refLabel(model, s.ref);
    tb.appendChild(
      el(doc, 'tr', {}, [
        el(doc, 'td', {}, [KIND[s.kind]]),
        el(doc, 'th', { scope: 'row' }, [el(doc, 'button', { type: 'button', class: 'ref', 'data-spof': s.fail.join(' '), title: 'Simulate this failure' }, [name])]),
        el(doc, 'td', {}, [s.isolated.length ? s.isolated.map((g) => g.join(', ')).join('; ') : '—']),
        el(doc, 'td', {}, [s.relations.length ? s.relations.join(', ') : '—']),
      ]),
    );
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  box.appendChild(wrap);
  return box;
}

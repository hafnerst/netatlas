/**
 * Active events: one list for what Network events started (each with its
 * state, progress, outcome and controls; details behind a disclosure) and
 * the other state changes in effect (a failed cable, a device powered off …,
 * started from the diagram's menus). Compact rows: an icon and a word for the
 * state (never the colour alone), a progress bar where progress is
 * measurable, an outcome bar only where a success rate means something.
 * Rebuilt only when what it shows changed; the focus and the open details
 * stay where they were, and nothing is announced on every update.
 */
import { ActionView, STATUS_ICON, STATUS_LABEL } from '../analysis/sim/actions';
import { fmtSec } from '../analysis/sim/engine';
import { NetEvent } from '../analysis/sim/types';
import { el } from './dom';

export interface EventListHost {
  /** an event's control (Stop, No shut, Leave group) */
  control(id: number, op: 'stop' | 'noshut' | 'leave' | 'restore'): void;
  /** end a state change of the other kind (Restore, Power on …) */
  end(e: NetEvent): void;
  /** its button's word ("Restore") and what it is about ("cable l1") */
  endLabel(e: NetEvent): string;
  label(ref: string): string;
  /** open a message of a send in the packet inspector (the first or the latest) */
  inspect(testId: number): boolean;
}

/** The text of a state change of the other kind: "Cable l1: failed". */
function otherText(h: EventListHost, e: NetEvent): string {
  const what = e.kind === 'fail' ? 'failed' : e.kind === 'flap' ? `flapping (${e.state})` : e.kind === 'shut' ? 'shut' : e.state;
  const l = h.label(e.ref);
  return `${l.charAt(0).toUpperCase() + l.slice(1)}: ${what}`;
}

/** The parts of a view the list shows, as a key: the list is rebuilt when it changes. */
export function listKey(views: ActionView[], others: NetEvent[]): string {
  return JSON.stringify([views.map((v) => [v.id, v.status, v.summary, v.state, v.progress, v.outcome, v.controls, v.details.length, v.details[v.details.length - 1]]), others.map((e) => [e.kind, e.ref, e.group, e.state])]);
}

/** One event of Network events. */
function actionItem(doc: Document, h: EventListHost, v: ActionView, open: boolean): HTMLElement {
  const finished = v.status !== 'queued' && v.status !== 'running' && v.status !== 'paused';
  const head = el(doc, 'div', { class: 'sim-ev-head' }, [
    el(doc, 'span', { class: 'sim-ev-icon', 'aria-hidden': 'true' }, [STATUS_ICON[v.status]]),
    el(doc, 'span', { class: 'sim-ev-title' }, [v.title]),
    el(doc, 'span', { class: 'sim-ev-status' }, [STATUS_LABEL[v.status]]),
    el(doc, 'span', { class: 'sim-ev-time muted' }, [`t = ${fmtSec(v.at)}${finished && v.ended !== undefined && fmtSec(v.ended) !== fmtSec(v.at) ? '–' + fmtSec(v.ended) : ''}`]),
  ]);
  const li = el(doc, 'li', { class: 'sim-ev', 'data-act': String(v.id), 'data-kind': v.kind, 'data-status': v.status }, [head, el(doc, 'div', { class: 'sim-ev-target' }, [v.target])]);
  // progress: measurable (of a total) as a bar with its numbers; open-ended as a count
  if (v.progress) {
    const p = v.progress;
    if (p.total !== null && p.total > 1) {
      const bar = el(doc, 'progress', { class: 'sim-ev-progress', max: String(p.total), value: String(p.done), 'aria-label': `${p.done} of ${p.total} ${p.unit}` });
      li.appendChild(el(doc, 'div', { class: 'sim-ev-row' }, [bar, el(doc, 'span', { class: 'sim-ev-count' }, [`${p.done}/${p.total} ${p.unit}`])]));
    }
  }
  // the outcome: a bar of answered / failed / pending only where a success rate means something
  const o = v.outcome;
  if (o && o.rate && o.ok + o.failed + o.pending > 0) {
    const all = o.ok + o.failed + o.pending + o.unknown + o.cancelled;
    const seg = (cls: string, n: number): HTMLElement | null => (n ? el(doc, 'span', { class: 'sim-ev-seg ' + cls, style: `flex-grow: ${n}` }) : null);
    const done = o.ok + o.failed;
    const rate = done ? Math.round((o.ok / done) * 100) : null;
    const text = `${rate === null ? 'no result yet' : rate + ' % success'} (${o.ok} ✓ · ${o.failed} ✕${o.pending ? ` · ${o.pending} pending` : ''})`;
    li.appendChild(
      el(doc, 'div', { class: 'sim-ev-row' }, [
        el(doc, 'span', { class: 'sim-ev-bar', role: 'img', 'aria-label': `Outcome of ${all} message${all === 1 ? '' : 's'}: ${o.ok} succeeded, ${o.failed} failed, ${o.pending} pending${rate === null ? '' : `; ${rate} % of those finished succeeded`}` }, [seg('ok', o.ok), seg('fail', o.failed), seg('pending', o.pending), seg('unknown', o.unknown + o.cancelled)]),
        el(doc, 'span', { class: 'sim-ev-count' }, [text]),
      ]),
    );
  }
  li.appendChild(el(doc, 'div', { class: 'sim-ev-summary' }, [v.summary + (v.state ? ` · ${v.state}` : '')]));
  // controls, and the details
  const row = el(doc, 'div', { class: 'sim-ev-actions' });
  for (const c of v.controls) {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-op': c.op, 'aria-label': `${c.label}: ${v.title}, ${v.target}` }, [c.label]);
    b.addEventListener('click', () => h.control(v.id, c.op));
    row.appendChild(b);
  }
  const det = el(doc, 'details', { class: 'sim-ev-details' }) as HTMLDetailsElement;
  det.open = open;
  det.appendChild(el(doc, 'summary', {}, ['Details']));
  const ul = el(doc, 'ul', { class: 'small' });
  for (const d of v.details) ul.appendChild(el(doc, 'li', {}, [d]));
  det.appendChild(ul);
  if (v.tests.length) {
    const ins = el(doc, 'div', { class: 'sp-row' });
    const add = (label: string, id: number, op: string): void => {
      const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-op': op }, [label]);
      b.addEventListener('click', () => {
        if (!h.inspect(id)) b.textContent = `${label}: not in the log any more`;
      });
      ins.appendChild(b);
    };
    add('Inspect the first message', v.tests[0], 'first');
    if (v.tests.length > 1) add('Inspect the latest', v.tests[v.tests.length - 1], 'latest');
    det.appendChild(ins);
  }
  row.appendChild(det);
  li.appendChild(row);
  return li;
}

/** A state change in effect that no event of the list stands for (from the diagram's menus): its line and its way back. */
function otherItem(doc: Document, h: EventListHost, e: NetEvent): HTMLElement {
  const li = el(doc, 'li', { class: 'sim-ev sim-ev-other', 'data-event': e.kind, 'data-ref': e.ref, 'data-status': 'state' }, [
    el(doc, 'div', { class: 'sim-ev-head' }, [el(doc, 'span', { class: 'sim-ev-icon', 'aria-hidden': 'true' }, ['●']), el(doc, 'span', { class: 'sim-ev-title' }, [otherText(h, e)]), el(doc, 'span', { class: 'sim-ev-time muted' }, [`since t = ${fmtSec(e.since)}`])]),
  ]);
  if (!e.hosted) {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'aria-label': `${h.endLabel(e)}: ${h.label(e.ref)}` }, [h.endLabel(e)]);
    b.addEventListener('click', () => h.end(e));
    li.appendChild(el(doc, 'div', { class: 'sim-ev-actions' }, [b]));
  }
  return li;
}

/** Fill the list: the events of Network events (newest first), then the other state changes in effect. */
export function renderEvents(doc: Document, ul: HTMLElement, h: EventListHost, views: ActionView[], others: NetEvent[]): void {
  // what is open and focused stays so
  const open = new Set(Array.from(ul.querySelectorAll('li[data-act] > .sim-ev-actions > details[open]')).map((d) => (d.closest('li') as HTMLElement).getAttribute('data-act')));
  const a = doc.activeElement as HTMLElement | null;
  const focusLi = a && ul.contains(a) ? (a.closest('li.sim-ev') as HTMLElement | null) : null;
  const focus = focusLi ? { act: focusLi.getAttribute('data-act'), ref: focusLi.getAttribute('data-ref'), op: a!.getAttribute('data-op'), summary: a!.tagName === 'SUMMARY' } : null;
  while (ul.firstChild) ul.removeChild(ul.firstChild);
  for (const v of views) ul.appendChild(actionItem(doc, h, v, open.has(String(v.id))));
  for (const e of others) ul.appendChild(otherItem(doc, h, e));
  if (focus) {
    const li = (focus.act ? ul.querySelector(`li[data-act="${focus.act}"]`) : ul.querySelector(`li[data-ref="${focus.ref}"]`)) as HTMLElement | null;
    const back = li ? ((focus.summary ? li.querySelector('summary') : focus.op ? li.querySelector(`[data-op="${focus.op}"]`) : null) || li.querySelector('button, summary')) : null;
    // (its control gone, e.g. Stop once stopped: the event's details, else the list's heading)
    ((back as HTMLElement | null) || (doc.getElementById('sim-act-events-h') as HTMLElement | null))?.focus();
  }
}

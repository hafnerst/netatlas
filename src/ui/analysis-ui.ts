/**
 * The parts every Analyze window shares: the context line (configured model
 * or simulation snapshot, the scope, whether the result is outdated, with a
 * Refresh), the choice between the configured model and a snapshot while a
 * simulation runs, a verdict line (a mark and words, never colour alone),
 * and the assumptions and limits behind an expansion. Built from elements
 * and text nodes only; the meanings are analysis/result.ts's.
 */
import { AnalysisContext, Coverage, ResultInfo, Verdict, VerdictTone, contextText, coverageText, verdictMark, verdictText } from '../analysis/result';
import { el } from './dom';

export interface ContextBarState {
  /** what the result on screen was computed on (null: nothing computed yet) */
  context: AnalysisContext | null;
  /** the model changed after the result: it is outdated */
  outdated: boolean;
  /** a simulation is running: a snapshot can be analysed */
  simulation: boolean;
  /** the source chosen for the next computation */
  source: 'model' | 'snapshot';
  /** why this tool can't analyse a snapshot ('' = it can) */
  noSnapshot: string;
  /** the diagram is filtered (the analysis scope is not) */
  filtered: boolean;
  /** an id prefix for the controls */
  id: string;
}

export interface ContextBarActions {
  refresh(): void;
  source(s: 'model' | 'snapshot'): void;
}

/**
 * The context line of a window: "Configured model · Entire architecture",
 * the outdated notice with Refresh, the source choice while a simulation
 * runs, and that display filters don't change the scope.
 */
export function contextBar(doc: Document, st: ContextBarState, act: ContextBarActions): HTMLElement {
  const bar = el(doc, 'div', { class: 'an-context', role: 'group', 'aria-label': 'Analysis context' });
  if (st.simulation) {
    const seg = el(doc, 'div', { class: 'seg an-source', role: 'radiogroup', 'aria-label': 'Analyze' });
    const opt = (v: 'model' | 'snapshot', label: string, why: string): HTMLElement => {
      const on = st.source === v;
      const b = el(doc, 'button', { type: 'button', role: 'radio', class: 'mini' + (on ? ' active' : ''), 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-an-source': v, id: `${st.id}-src-${v}`, title: why || label }, [label]) as HTMLButtonElement;
      if (v === 'snapshot' && st.noSnapshot) b.disabled = true;
      b.addEventListener('click', () => act.source(v));
      return b;
    };
    seg.appendChild(opt('model', 'Configured model', 'The configuration as written'));
    seg.appendChild(opt('snapshot', 'Simulation snapshot', st.noSnapshot || 'The running simulation, frozen when the analysis runs: its leases, SLAAC addresses, what is up and what was learned'));
    bar.appendChild(seg);
    if (st.noSnapshot) bar.appendChild(el(doc, 'p', { class: 'muted small an-nosnap' }, [st.noSnapshot]));
  }
  if (st.context) {
    bar.appendChild(el(doc, 'p', { class: 'an-ctx-line small', 'data-an-context': st.context.kind }, [el(doc, 'span', { class: 'an-ctx-k' }, ['Context: ']), contextText(st.context)]));
  }
  if (st.outdated) {
    const refresh = el(doc, 'button', { type: 'button', class: 'mini', id: `${st.id}-refresh`, 'data-an-refresh': '' }, ['Refresh']);
    refresh.addEventListener('click', () => act.refresh());
    bar.appendChild(el(doc, 'p', { class: 'an-outdated small', role: 'status' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['⟳ ']), 'Outdated: the model changed after this result. ', refresh]));
  }
  if (st.filtered) bar.appendChild(el(doc, 'p', { class: 'muted small' }, ['The diagram is filtered; the analysis covers what its scope says, not only what is shown.']));
  return bar;
}

/** A verdict as a line: its mark, its words, and a short explanation. */
export function verdictLine(doc: Document, v: Verdict, tone: VerdictTone, text: string, attrs: { [k: string]: string } = {}): HTMLElement {
  return el(doc, 'p', { class: 'an-verdict v-' + v, ...attrs }, [el(doc, 'span', { class: 'v-mark', 'aria-hidden': 'true' }, [verdictMark(v) + ' ']), el(doc, 'strong', {}, [verdictText(v, tone)]), text ? ': ' + text : '']);
}

/** A small verdict chip (tables, lists). */
export function verdictChip(doc: Document, v: Verdict, tone: VerdictTone, label?: string): HTMLElement {
  return el(doc, 'span', { class: 'an-chip v-' + v }, [el(doc, 'span', { 'aria-hidden': 'true' }, [verdictMark(v) + ' ']), label || verdictText(v, tone)]);
}

/** The coverage of a result in a line. */
export function coverageLine(doc: Document, c: Coverage): HTMLElement {
  return el(doc, 'p', { class: 'an-coverage small' + (c.checked < c.eligible || c.truncated || c.cancelled ? ' partial' : '') }, [coverageText(c)]);
}

/** The assumptions and limits of a result, behind an expansion. */
export function limitsDetails(doc: Document, info: ResultInfo, extra: string[] = []): HTMLElement {
  const d = el(doc, 'details', { class: 'an-limits' }, [el(doc, 'summary', {}, ['Assumptions and limits'])]);
  const list = (title: string, items: string[]): void => {
    if (!items.length) return;
    d.appendChild(el(doc, 'p', { class: 'small an-lim-h' }, [title]));
    d.appendChild(el(doc, 'ul', { class: 'small' }, items.map((x) => el(doc, 'li', {}, [x]))));
  };
  list('Assumptions', info.assumptions.concat(extra));
  list('Not evaluated', info.limits);
  d.appendChild(el(doc, 'p', { class: 'small muted' }, ['A model-based result: it does not prove the behaviour of a production network.']));
  return d;
}

/**
 * The parts every Analyze task shares: the context line (next source, result
 * shown with its layers and time, draft, outdated, incomplete, evidence
 * limited), verdict lines and chips, coverage, assumptions and limits.
 */
import { AnalysisContext, Coverage, ResultInfo, Verdict, VerdictTone, coverageText, simTimeText, verdictMark, verdictText } from '../analysis/result';
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
  /** when the result on screen was computed (ms since the epoch; the page's clock) */
  computedAt?: number;
  /** what the result adds to its context: a hypothetical failure condition, a recorded runtime exchange */
  layers?: string[];
  /** the question in the form differs from the one the result answers ('' = it does not) */
  draft?: string;
  /** the result does not cover all it could ('' = it does) */
  incomplete?: string;
  /** some evidence of the result is no longer available ('' = all of it is) */
  limited?: string;
}

export interface ContextBarActions {
  refresh(): void;
  source(s: 'model' | 'snapshot'): void;
}

/** A clock time of the page ("10:42:05"), for when a result was computed. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => (n < 10 ? '0' : '') + n;
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The kind of state a result describes, in words (one meaning each: never mixed). */
export function contextKindText(c: AnalysisContext): string {
  return c.kind === 'model' ? 'Configured model' : `Frozen simulation snapshot at ${simTimeText(c.at || 0)}`;
}

/**
 * The context of a task, in one place and the same in every task: the source
 * the next computation reads (and why a tool can't read a snapshot), the
 * context of the result on screen (configured model or frozen snapshot, a
 * hypothetical failure condition or a recorded runtime exchange on top, the
 * scope, when it was computed), and what limits it: a question changed since
 * (a draft, not answered yet), an edit since (outdated, with Refresh),
 * incomplete coverage, evidence no longer kept. That a display filter does
 * not change the scope is said.
 */
export function contextBar(doc: Document, st: ContextBarState, act: ContextBarActions): HTMLElement {
  const bar = el(doc, 'div', { class: 'an-context', role: 'group', 'aria-label': 'Analysis context' });
  if (st.simulation) {
    const seg = el(doc, 'div', { class: 'seg an-source', role: 'radiogroup', 'aria-label': 'Next computation reads' });
    const opt = (v: 'model' | 'snapshot', label: string, why: string): HTMLElement => {
      const on = st.source === v;
      const b = el(doc, 'button', { type: 'button', role: 'radio', class: 'mini' + (on ? ' active' : ''), 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-an-source': v, id: `${st.id}-src-${v}`, title: why || label }, [label]) as HTMLButtonElement;
      if (v === 'snapshot' && st.noSnapshot) b.disabled = true;
      b.addEventListener('click', () => act.source(v));
      return b;
    };
    seg.appendChild(opt('model', 'Configured model', 'The configuration as written'));
    seg.appendChild(opt('snapshot', 'Simulation snapshot', st.noSnapshot || 'The running simulation, frozen when the analysis runs: its leases, SLAAC addresses, what is up and what was learned'));
    bar.appendChild(el(doc, 'div', { class: 'an-ctx-next' }, [el(doc, 'span', { class: 'an-ctx-k small' }, ['Next computation: ']), seg]));
    if (st.noSnapshot) bar.appendChild(el(doc, 'p', { class: 'muted small an-nosnap' }, [st.noSnapshot]));
  }
  if (st.context) {
    const c = st.context;
    const parts: Array<Node | string> = [el(doc, 'span', { class: 'an-ctx-k' }, ['Result shown: ']), el(doc, 'span', { class: 'an-ctx-kind', 'data-an-kind': c.kind }, [contextKindText(c)])];
    for (const l of st.layers || []) parts.push(' · ', el(doc, 'span', { class: 'an-ctx-kind', 'data-an-kind': 'layer' }, [l]));
    parts.push(' · ' + c.scope);
    if (st.computedAt) parts.push(el(doc, 'span', { class: 'muted' }, [` · computed ${clockText(st.computedAt)}`]));
    bar.appendChild(el(doc, 'p', { class: 'an-ctx-line small', 'data-an-context': c.kind }, parts));
  } else bar.appendChild(el(doc, 'p', { class: 'an-ctx-line small muted', 'data-an-context': '' }, ['No result yet: nothing is computed until you ask.']));
  if (st.draft) bar.appendChild(el(doc, 'p', { class: 'an-draft small', role: 'status', 'data-an-draft': '' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['✎ ']), st.draft]));
  if (st.outdated) {
    const refresh = el(doc, 'button', { type: 'button', class: 'mini', id: `${st.id}-refresh`, 'data-an-refresh': '' }, ['Refresh']);
    refresh.addEventListener('click', () => act.refresh());
    bar.appendChild(el(doc, 'p', { class: 'an-outdated small', role: 'status' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['⟳ ']), 'Outdated: the model changed after this result. ', refresh]));
  }
  if (st.incomplete) bar.appendChild(el(doc, 'p', { class: 'an-outdated small', 'data-an-incomplete': '' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['◐ ']), st.incomplete]));
  if (st.limited) bar.appendChild(el(doc, 'p', { class: 'an-outdated small', 'data-an-limited': '' }, [el(doc, 'span', { 'aria-hidden': 'true' }, ['⌀ ']), st.limited]));
  if (st.filtered) bar.appendChild(el(doc, 'p', { class: 'muted small' }, ['The diagram shows selected objects; the analysis covers what its scope says, not only what is shown.']));
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

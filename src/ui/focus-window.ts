/**
 * The Focus window (Analyze → Focus…, Shift+F): the object focus mode starts
 * from (the selection), the neighbourhood's size (1–3 hops), Focus and Exit
 * focus, and what is shown now. The focus banner over the diagram stays.
 * Built from elements and text nodes only.
 */
import { FOCUS_MAX_HOPS, FOCUS_MIN_HOPS } from '../analysis/focus';
import { el } from './dom';

export interface FocusWindowState {
  /** the selection's name ('' = nothing selected), and why it can't be focused ('' = it can) */
  selected: string;
  blocked: string;
  /** the hops chosen */
  hops: number;
  /** what focus mode shows now ('' = it is off) */
  note: string;
  /** the contextual focus actions for the selection (a key, a label, whether it is on) */
  contexts?: Array<{ key: string; label: string; on: boolean }>;
}

/** The window's content. Its controls: data-focus-hops (a radio per number of hops), #focus-go, #focus-exit-w. */
export function focusWindowBody(doc: Document, st: FocusWindowState): HTMLElement {
  const box = el(doc, 'div', { class: 'focus-body' });
  box.appendChild(el(doc, 'p', { class: 'muted small' }, ['Shows only an object and what is within some hops of it: along cables in the Physical view, along relations in the Logical view. Nothing in the model changes.']));
  box.appendChild(el(doc, 'p', { class: 'focus-sel' }, [el(doc, 'span', { class: 'muted' }, ['Object: ']), st.selected ? el(doc, 'strong', {}, [st.selected]) : el(doc, 'span', {}, ['Select an object in the diagram or the object list'])]));
  const group = el(doc, 'div', { class: 'seg focus-hops', role: 'radiogroup', 'aria-label': 'Hops' });
  for (let n = FOCUS_MIN_HOPS; n <= FOCUS_MAX_HOPS; n++) {
    group.appendChild(el(doc, 'button', { type: 'button', role: 'radio', class: 'mini' + (n === st.hops ? ' active' : ''), 'aria-checked': n === st.hops ? 'true' : 'false', tabindex: n === st.hops ? '0' : '-1', 'data-focus-hops': String(n) }, [`${n} hop${n === 1 ? '' : 's'}`]));
  }
  box.appendChild(el(doc, 'div', { class: 'focus-row' }, [el(doc, 'span', { class: 'muted', id: 'focus-hops-label' }, ['Neighbourhood: ']), group]));
  const go = el(doc, 'button', { type: 'button', class: 'primary', id: 'focus-go', title: st.blocked || 'Show only this object and its neighbourhood' }, ['Focus']) as HTMLButtonElement;
  go.disabled = !!st.blocked;
  const exit = el(doc, 'button', { type: 'button', id: 'focus-exit-w', title: st.note ? 'Show the complete diagram again' : 'Focus mode is off' }, ['Exit focus']) as HTMLButtonElement;
  exit.disabled = !st.note;
  box.appendChild(el(doc, 'div', { class: 'tf-actions' }, [go, exit]));
  if (st.blocked) box.appendChild(el(doc, 'p', { class: 'muted small', id: 'focus-why' }, [st.blocked]));
  // contextual focus: only what applies to the selection
  if (st.contexts && st.contexts.length) {
    const g = el(doc, 'div', { class: 'focus-ctx', role: 'group', 'aria-labelledby': 'focus-ctx-h' });
    g.appendChild(el(doc, 'p', { class: 'small', id: 'focus-ctx-h' }, ['Or show what it takes part in (configured structure, not proof of reachability):']));
    for (const c of st.contexts) g.appendChild(el(doc, 'button', { type: 'button', class: 'mini' + (c.on ? ' active' : ''), 'aria-pressed': c.on ? 'true' : 'false', 'data-focus-ctx': c.key }, [c.label]));
    box.appendChild(g);
  }
  box.appendChild(el(doc, 'p', { class: 'small focus-now', role: 'status' }, [st.note ? st.note + '.' : 'Focus mode is off: the complete diagram is shown.']));
  return box;
}

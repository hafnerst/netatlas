/**
 * The parts every task of the Analyze workspace shares, so that the four
 * tasks read alike:
 *
 *   taskNav       the task areas at the top of the Question panel (a radio
 *                 group; the arrow keys move between them), and a mode
 *                 switch inside a task (Resilience, Design review);
 *   evidencePanel the right panel's one structure for whatever is selected
 *                 in the results — what it is, the result's context, the
 *                 explanation, the evidence and decisions, the objects it
 *                 concerns (with the diagram actions Locate, Fit, Show only
 *                 and Restore), what to inspect next, and Back / Close;
 *   editorPanel   an editor in the right panel says it is one: its own title,
 *                 what saving does, Save changes and Cancel;
 *   evidenceHint  what the right panel says while nothing is selected.
 *
 * Rendering never computes an analysis: each part draws what it is given.
 * Built from elements and text nodes only.
 */
import { el } from './dom';

/** One action of a list of next steps; `disabled` says why it is not available now. */
export interface EvidenceAction {
  id: string;
  label: string;
  why?: string;
  disabled?: string;
  /** an object reference the action is about (a link, a rule) */
  ref?: string;
}

/** What the evidence panel shows of the selected result item. */
export interface EvidenceView {
  /** what kind of item it describes ("Communication layer", "Hop", "Policy decision", "Addressing issue" …) */
  kind: string;
  title: string;
  /** the source, scope and time of the result it belongs to ("Configured model · Selected endpoints · computed 10:42") */
  context: string;
  /** a result's status that limits it: outdated, provisional, evidence-limited */
  flags?: string[];
  explanation: Array<Node | string>;
  /** the evidence and the decisions it rests on (empty: none beyond the explanation) */
  evidence: Node[];
  /** the objects it concerns, in the diagram */
  objects: Array<{ ref: string; label: string }>;
  next: EvidenceAction[];
}

export interface EvidenceActions {
  /** an action of Inspect next */
  next(id: string, ref?: string): void;
  /** an object: selected in the diagram */
  goto(ref: string): void;
  /** the diagram actions for the objects */
  view(kind: 'locate' | 'fit' | 'only' | 'restore'): void;
  /** back to where this evidence was opened from */
  back(): void;
  /** let the selection go (Escape does the same) */
  close(): void;
}

/** The state of the diagram actions: a previous view to restore, a display filter on. */
export interface EvidenceDiagram {
  restorable: boolean;
  /** "Back to …" ('' none) */
  back: string;
}

const section = (doc: Document, title: string, kids: Array<Node | string>, cls = ''): HTMLElement => el(doc, 'div', { class: 'an-ev-sec' + (cls ? ' ' + cls : '') }, [el(doc, 'h4', {}, [title]), ...kids]);

/** The right panel's content for a selected result item (see the module comment). The panel's heading takes the focus. */
export function evidencePanel(doc: Document, v: EvidenceView, d: EvidenceDiagram, act: EvidenceActions): HTMLElement {
  const box = el(doc, 'section', { id: 'an-detail', class: 'an-ev', tabindex: '-1', 'aria-labelledby': 'an-ev-h', 'data-ev-kind': v.kind });
  box.appendChild(el(doc, 'p', { class: 'an-ev-kind small' }, [v.kind]));
  box.appendChild(el(doc, 'h3', { id: 'an-ev-h' }, [v.title]));
  box.appendChild(el(doc, 'p', { class: 'an-ev-ctx small', 'data-an-ev-ctx': '' }, [v.context]));
  if (v.flags && v.flags.length) box.appendChild(el(doc, 'p', { class: 'an-outdated small', role: 'status' }, [v.flags.join(' · ')]));
  box.appendChild(section(doc, 'Explanation', v.explanation.length ? v.explanation : [el(doc, 'p', { class: 'muted small' }, ['Nothing more is established for it.'])]));
  if (v.evidence.length) box.appendChild(section(doc, 'Evidence and decisions', v.evidence));
  // the objects it concerns: links that select them, and what the diagram can do with them (display only)
  const objs: Array<Node | string> = [];
  if (v.objects.length) {
    const p = el(doc, 'p', { class: 'small an-ev-objs' });
    v.objects.slice(0, 24).forEach((o, i) => {
      const b = el(doc, 'button', { type: 'button', class: 'ref', 'data-ev-goto': o.ref, title: 'Select it in the diagram' }, [o.label]);
      p.appendChild(el(doc, 'span', {}, [i ? ', ' : '', b]));
    });
    if (v.objects.length > 24) p.appendChild(doc.createTextNode(` and ${v.objects.length - 24} more`));
    objs.push(p);
  } else objs.push(el(doc, 'p', { class: 'muted small' }, ['It names no object of the diagram.']));
  const btn = (k: 'locate' | 'fit' | 'only' | 'restore', label: string, title: string, off: string): HTMLElement => {
    const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-ev-view': k, title: off || title }, [label]) as HTMLButtonElement;
    b.disabled = !!off;
    return b;
  };
  const none = v.objects.length ? '' : 'It names no object of the diagram';
  objs.push(
    el(doc, 'div', { class: 'tf-actions an-ev-view', role: 'group', 'aria-label': 'Diagram' }, [
      btn('locate', 'Locate in diagram', 'Select the first object and bring it into view', none),
      btn('fit', 'Fit relevant objects', 'Zoom the diagram to these objects', none),
      btn('only', 'Show only relevant objects', 'A display filter (Focus): only these devices are drawn; the analysis keeps its own scope', none),
      btn('restore', 'Restore previous view', 'The zoom and the display as they were before Fit or Show only', d.restorable ? '' : 'Nothing to restore'),
    ]),
  );
  box.appendChild(section(doc, 'Relevant objects', objs));
  if (v.next.length) {
    const nx = el(doc, 'div', { class: 'tf-actions', role: 'group', 'aria-label': 'Inspect next' });
    for (const a of v.next) {
      const b = el(doc, 'button', { type: 'button', class: 'mini', 'data-ev-next': a.id, ...(a.ref ? { 'data-ev-ref': a.ref } : {}), title: a.disabled || a.why || a.label }, [a.label]) as HTMLButtonElement;
      b.disabled = !!a.disabled;
      nx.appendChild(b);
    }
    box.appendChild(section(doc, 'Inspect next', [nx]));
  }
  const foot = el(doc, 'div', { class: 'tf-actions an-ev-foot' });
  if (d.back) foot.appendChild(el(doc, 'button', { type: 'button', class: 'mini', 'data-ev-back': '' }, ['← ' + d.back]));
  foot.appendChild(el(doc, 'button', { type: 'button', class: 'mini', 'data-ev-close': '', title: 'Let the selection go (Esc)' }, ['Close evidence']));
  box.appendChild(foot);
  box.addEventListener('click', (e) => {
    const t = (e.target as Element).closest('button') as HTMLButtonElement | null;
    if (!t || t.disabled) return;
    if (t.hasAttribute('data-ev-goto')) act.goto(t.getAttribute('data-ev-goto') as string);
    else if (t.hasAttribute('data-ev-view')) act.view(t.getAttribute('data-ev-view') as 'locate' | 'fit' | 'only' | 'restore');
    else if (t.hasAttribute('data-ev-next')) act.next(t.getAttribute('data-ev-next') as string, t.getAttribute('data-ev-ref') || undefined);
    else if (t.hasAttribute('data-ev-back')) act.back();
    else if (t.hasAttribute('data-ev-close')) act.close();
  });
  return box;
}

/** What the right panel says while nothing is selected (it is the panel's heading for the keyboard). */
export function evidenceHint(doc: Document, text: string): HTMLElement {
  return el(doc, 'section', { id: 'an-detail', class: 'an-ev an-ev-empty', tabindex: '-1', 'aria-labelledby': 'an-ev-h', 'data-ev-kind': '' }, [el(doc, 'h3', { id: 'an-ev-h', class: 'sr-only' }, ['Evidence']), el(doc, 'p', { class: 'muted small' }, [text])]);
}

export interface EditorView {
  /** "New requirement", "Edit requirement “Guests can’t reach management”", "Failure domains" */
  title: string;
  /** what saving does */
  note: string;
  body: Node;
  /** why the model can't be edited now ('' it can): said, and Save is unavailable — nothing is ended to make it succeed */
  locked: string;
  error?: string;
  saveLabel?: string;
}

/** The right panel as an editor (see the module comment). Its form submits Save; Escape is Cancel. */
export function editorPanel(doc: Document, v: EditorView, act: { save(): void; cancel(): void }): HTMLElement {
  const box = el(doc, 'section', { id: 'an-editor', class: 'an-ev an-editor', tabindex: '-1', 'aria-labelledby': 'an-ed-h', 'data-ev-kind': 'editor' });
  box.appendChild(el(doc, 'p', { class: 'an-ev-kind small' }, ['Editing the model']));
  box.appendChild(el(doc, 'h3', { id: 'an-ed-h' }, [v.title]));
  box.appendChild(el(doc, 'p', { class: 'small muted' }, [v.note]));
  if (v.locked) box.appendChild(el(doc, 'p', { class: 'an-outdated small', role: 'status', id: 'an-ed-locked' }, [v.locked]));
  const form = el(doc, 'form', { class: 'trace-form an-ed-form', 'aria-labelledby': 'an-ed-h', novalidate: '' }) as HTMLFormElement;
  form.appendChild(v.body);
  if (v.error) form.appendChild(el(doc, 'p', { class: 'trace-error', id: 'an-ed-error', role: 'alert' }, [v.error]));
  const save = el(doc, 'button', { type: 'submit', class: 'primary', id: 'an-ed-save', title: v.locked || 'Save the change to the model (one undo step)' }, [v.saveLabel || 'Save changes']) as HTMLButtonElement;
  save.disabled = !!v.locked;
  const cancel = el(doc, 'button', { type: 'button', id: 'an-ed-cancel', title: 'Leave the editor without changing the model (Esc)' }, ['Cancel']);
  cancel.addEventListener('click', () => act.cancel());
  form.appendChild(el(doc, 'div', { class: 'tf-actions' }, [save, cancel]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!save.disabled) act.save();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    act.cancel();
  });
  box.appendChild(form);
  return box;
}

/** A radio group of choices (the task areas, a task's modes): roving tabindex, the arrow keys move and choose. */
export function radioNav<T extends string>(doc: Document, label: string, items: ReadonlyArray<{ id: T; label: string; help: string }>, current: T, attr: string, choose: (id: T) => void): HTMLElement {
  const nav = el(doc, 'div', { class: 'an-tools', role: 'radiogroup', 'aria-label': label });
  for (const t of items) {
    const on = t.id === current;
    const b = el(doc, 'button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', [attr]: t.id, title: t.help }, [t.label]);
    b.addEventListener('click', () => choose(t.id));
    nav.appendChild(b);
  }
  nav.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].indexOf(k) < 0) return;
    e.preventDefault();
    const i = items.findIndex((x) => x.id === current);
    const n = k === 'Home' ? 0 : k === 'End' ? items.length - 1 : (i + (k === 'ArrowDown' || k === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
    choose(items[n].id);
    const b = doc.querySelector(`[${attr}="${items[n].id}"]`) as HTMLElement | null;
    if (b) b.focus();
  });
  return nav;
}

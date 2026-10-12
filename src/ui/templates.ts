/**
 * The Scenario templates dialog (Simulate → Scenario templates…): the list
 * of templates, each available or greyed out with why, and the review of a
 * template's proposal for this model (its name, description, steps and what
 * to look at) before it is saved as a normal scenario. Built from elements
 * and text nodes only; the proposals come from analysis/templates.ts.
 */
import { Proposal, TEMPLATES } from '../analysis/templates';
import { stepText } from '../analysis/scenario';
import { Model } from '../model/types';
import { el } from './dom';

/** The list: one button per template (data-template); one that doesn't apply is disabled and says why, in text. */
export function templateListBody(doc: Document, proposals: Proposal[]): HTMLElement {
  const box = el(doc, 'div', { class: 'tpl-body' });
  box.appendChild(
    el(doc, 'p', { class: 'muted small' }, [
      'A template looks at this model and proposes concrete steps. You review them, then save them as a scenario (one undo step) to play and replay. Proposals follow from the model alone: the same model, the same steps.',
    ]),
  );
  const ul = el(doc, 'ul', { class: 'tpl-list', 'aria-label': 'Scenario templates' });
  for (const t of TEMPLATES) {
    const p = proposals.find((x) => x.template === t.id) as Proposal;
    const id = 'tpl-why-' + t.id;
    const b = el(doc, 'button', { type: 'button', class: 'tpl-pick', 'data-template': t.id, 'aria-describedby': id }, [el(doc, 'span', { class: 'tpl-name' }, [t.label])]) as HTMLButtonElement;
    b.disabled = !p.applicable;
    ul.appendChild(
      el(doc, 'li', { class: p.applicable ? '' : 'tpl-off' }, [
        b,
        el(doc, 'p', { class: 'small tpl-why', id }, [p.applicable ? `${t.summary} Proposed here: ${p.name}.` : `Not for this model: ${p.reason}.`]),
      ]),
    );
  }
  box.appendChild(ul);
  return box;
}

/** The review of one proposal: the name and description (editable), the steps, what to look at. */
export function templateReviewBody(doc: Document, model: Model, p: Proposal): { body: HTMLElement; name: HTMLInputElement; desc: HTMLTextAreaElement } {
  const t = TEMPLATES.find((x) => x.id === p.template);
  const name = el(doc, 'input', { id: 'tpl-name', type: 'text', value: p.name, autocomplete: 'off' }) as HTMLInputElement;
  const desc = el(doc, 'textarea', { id: 'tpl-desc', rows: '3' }) as HTMLTextAreaElement;
  desc.value = p.description;
  const ol = el(doc, 'ol', { class: 'sim-steps tpl-steps', 'aria-label': 'Proposed steps' });
  for (const s of p.steps) ol.appendChild(el(doc, 'li', {}, [stepText(model, s), s.note ? el(doc, 'span', { class: 'sim-why' }, [' — ' + s.note]) : null]));
  const notes = el(doc, 'ul', { class: 'small tpl-notes' });
  for (const n of p.notes) notes.appendChild(el(doc, 'li', {}, [n]));
  const body = el(doc, 'div', { class: 'tpl-body' }, [
    el(doc, 'p', { class: 'muted small' }, [t ? t.summary : '']),
    el(doc, 'div', { class: 'field' }, [el(doc, 'label', { for: 'tpl-name' }, ['Name']), name]),
    el(doc, 'div', { class: 'field' }, [el(doc, 'label', { for: 'tpl-desc' }, ['Description']), desc]),
    el(doc, 'h4', {}, [`Proposed steps (${p.steps.length})`]),
    ol,
    el(doc, 'h4', {}, ['What to look at']),
    notes,
    el(doc, 'p', { class: 'muted small' }, ['Saving adds it to the model’s scenarios section (one undo step); it never changes the network objects. You can edit, replay or delete it like any scenario.']),
  ]);
  return { body, name, desc };
}

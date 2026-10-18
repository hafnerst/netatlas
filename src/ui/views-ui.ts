/**
 * The Saved views window (Find → Saved views…): the model's saved views,
 * each with what it shows and Open / Delete, and a name field to save the
 * view on screen. Opening a view changes what is drawn only: never the
 * model, an analysis or a simulation.
 */
import { SavedView, viewSummary } from '../model/views';
import { el } from './dom';

export interface ViewsActions {
  save(name: string): void;
  open(id: string): void;
  remove(id: string): void;
}

export function viewsBody(doc: Document, views: SavedView[], current: string, locked: string, act: ViewsActions): HTMLElement {
  const box = el(doc, 'div', { class: 'views-win' });
  const name = el(doc, 'input', { type: 'text', id: 'vw-name', maxlength: '200', placeholder: 'A name for it', 'aria-label': 'Name of the view to save' }) as HTMLInputElement;
  const save = el(doc, 'button', { type: 'button', id: 'vw-save', title: locked || 'Save the diagram, focus, filters, options and zoom on screen as a view of the model (one undo step)' }, ['Save current view']) as HTMLButtonElement;
  save.disabled = !!locked;
  name.disabled = !!locked;
  const go = (): void => {
    if (!save.disabled) act.save(name.value.trim());
  };
  save.addEventListener('click', go);
  name.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  box.appendChild(el(doc, 'p', { class: 'muted small' }, [`On screen: ${current}. A view is display state only: opening one never changes the model, an analysis or a simulation.`]));
  box.appendChild(el(doc, 'div', { class: 'vw-save-row' }, [name, save]));
  if (!views.length) {
    box.appendChild(el(doc, 'p', { class: 'muted', id: 'vw-empty' }, ['No saved views yet.']));
    return box;
  }
  const ul = el(doc, 'ul', { class: 'vw-list', 'aria-label': 'Saved views' });
  for (const v of views) {
    const open = el(doc, 'button', { type: 'button', 'data-vw': 'open', 'data-id': v.id, title: `Show the diagram as “${v.name}” saved it` }, ['Open']);
    open.addEventListener('click', () => act.open(v.id));
    const del = el(doc, 'button', { type: 'button', 'data-vw': 'delete', 'data-id': v.id, class: 'link', title: locked || `Delete the view “${v.name}” (one undo step)` }, ['Delete']) as HTMLButtonElement;
    del.disabled = !!locked;
    del.addEventListener('click', () => act.remove(v.id));
    ul.appendChild(el(doc, 'li', { 'data-view': v.id }, [el(doc, 'strong', {}, [v.name]), ' ', el(doc, 'span', { class: 'muted small' }, [viewSummary(v)]), el(doc, 'span', { class: 'vw-tools' }, [open, del])]));
  }
  box.appendChild(ul);
  return box;
}

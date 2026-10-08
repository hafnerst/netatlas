/** Modal dialog and toast. Content is built from text nodes and elements only. */
import { el } from './dom';

export interface DialogOpts {
  title: string;
  body: Array<Node | string>;
  buttons: Array<{ label: string; value: string; kind?: 'primary' | 'danger' }>;
  /** called once the dialog is built and shown (e.g. to keep a button in step with what is typed) */
  ready?: (dialog: HTMLElement) => void;
  /** a class for the dialog element while it shows this content (e.g. its size) */
  className?: string;
  /** a × button in the title row that closes the dialog like Esc ("cancel") */
  closeButton?: boolean;
  /** the element (a selector inside the body) that gets the focus instead of the primary button */
  focus?: string;
}

/**
 * Show the page's <dialog id="modal"> and resolve with the value of the
 * clicked button ("cancel" on Esc). The primary button, or the first input,
 * gets the focus.
 */
export function showDialog(doc: Document, opts: DialogOpts): Promise<string> {
  const dlg = doc.getElementById('modal') as HTMLDialogElement;
  while (dlg.firstChild) dlg.removeChild(dlg.firstChild);
  dlg.className = opts.className || '';
  dlg.setAttribute('aria-labelledby', 'modal-title');
  const form = el(doc, 'div', { class: 'modal-inner' });
  const title = el(doc, 'h2', { id: 'modal-title' }, [opts.title]);
  const closeX = opts.closeButton ? el(doc, 'button', { type: 'button', class: 'modal-x', 'aria-label': 'Close', title: 'Close (Esc)' }, ['×']) : null;
  form.appendChild(closeX ? el(doc, 'div', { class: 'modal-head' }, [title, closeX]) : title);
  const bodyEl = el(doc, 'div', { class: 'modal-body' });
  for (const b of opts.body) bodyEl.appendChild(typeof b === 'string' ? doc.createTextNode(b) : b);
  form.appendChild(bodyEl);
  const btns = el(doc, 'div', { class: 'modal-btns' });
  form.appendChild(btns);
  dlg.appendChild(form);
  return new Promise((resolve) => {
    const done = (v: string): void => {
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onCancel = (e: Event): void => {
      e.preventDefault();
      done('cancel');
    };
    dlg.addEventListener('cancel', onCancel);
    if (closeX) closeX.addEventListener('click', () => done('cancel'));
    for (const b of opts.buttons) {
      const btn = el(doc, 'button', { type: 'button', class: b.kind || '', 'data-value': b.value }, [b.label]);
      btn.addEventListener('click', () => done(b.value));
      btns.appendChild(btn);
    }
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    if (opts.ready) opts.ready(dlg);
    const primary = btns.querySelector('.primary, .danger') as HTMLElement | null;
    const target = opts.focus ? (bodyEl.querySelector(opts.focus) as HTMLElement | null) : null;
    if (target) target.focus();
    else if (primary && !bodyEl.querySelector('input')) primary.focus();
    else {
      const inp = bodyEl.querySelector('input') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  });
}

let toastTimer = 0;

/** Show a short message in the page's #toast element for 3.5 s. */
export function showToast(doc: Document, msg: string): void {
  const t = doc.getElementById('toast') as HTMLElement;
  t.textContent = msg;
  t.hidden = false;
  const win = doc.defaultView;
  if (win) {
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => {
      t.hidden = true;
    }, 3500);
  }
}

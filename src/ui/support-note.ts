/**
 * What NetAtlas does for a protocol, service or profile, where it is chosen
 * or configured: a compact disclosure ("ⓘ Modeled behavior") that opens to
 * two short lines, what is simulated or checked and what is not
 * (model/support.ts). A native <details>: keyboard operable, announced as a
 * disclosure, closed until it is opened. Never a warning on every action.
 */
import { Support, supportLabel, supportText } from '../model/support';
import { el } from './dom';

export function supportNote(doc: Document, s: Support, name: string): HTMLElement {
  return el(doc, 'details', { class: 'support-note', 'data-support': s.level }, [
    el(doc, 'summary', { title: supportText(s), 'aria-label': `${name}: ${supportLabel(s.level)} (what NetAtlas simulates)` }, [el(doc, 'span', { class: 'sup-i', 'aria-hidden': 'true' }, ['ⓘ']), ' ', supportLabel(s.level)]),
    el(doc, 'p', { class: 'sup-does' }, [s.does]),
    el(doc, 'p', { class: 'sup-not' }, [el(doc, 'span', { class: 'sup-key' }, ['Not modeled: ']), s.not]),
  ]);
}

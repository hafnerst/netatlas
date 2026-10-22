/**
 * The duration control of the Experiments workspace: a number and its unit
 * (sec, min, hours) side by side, for every duration an experiment has (its
 * length, the settling time, a step's delay, an observation's window, an
 * action's For, a message interval).
 *
 * The model keeps one canonical value (ms, written as "90s", "5min", "2h":
 * model/experiments.ts durationYaml); the unit is only how it is shown. A
 * unit chosen here is remembered for that field while the page is open (it
 * is no model data: choosing one changes nothing in the model and marks
 * nothing modified), and changing it converts the number so that the
 * duration stays the same (60 sec → 1 min, 1.5 hours → 90 min). Without a
 * chosen unit a value is shown in the largest unit that gives a whole number.
 *
 * What is typed is checked before anything is written: a finite number of
 * at least 0, within the field's range; a fraction where it means something
 * (rounded to the millisecond, the model's resolution, and never more). An
 * invalid or missing required value is said next to the field and not
 * written (nothing replaces it silently); what was typed stays in the field
 * while the panel is drawn again, until it is valid or the field is left
 * with its old value.
 */
import { DURATION_UNITS, DurationUnit, durText, durationIn, durationMs, durationUnit } from '../model/experiments';
import { el } from './dom';

export interface DurationSpec {
  /** the field's key (a document path as JSON): the unit and an unwritten draft are remembered by it */
  key: string;
  /** the input's id (its label's for) */
  id: string;
  /** its name, for the unit's accessible name ("Duration unit") */
  label: string;
  /** the value in the model (ms; undefined: not set) */
  value: number | undefined;
  /** the range (ms) */
  min: number;
  max: number;
  /** must be set (an empty field is said, never written) */
  required?: boolean;
  /** "read at once": what an empty field means */
  placeholder?: string;
  disabled?: boolean;
  /** what the model says is wrong with it (shown under it) */
  error?: string;
  /** write a valid value (ms), or remove it (null; only when not required) */
  commit(ms: number | null): void;
}

/** the units chosen per field, and what was typed but not written (this page only) */
const units = new Map<string, DurationUnit>();
const drafts = new Map<string, { text: string; why: string }>();

/** Forget the remembered units and drafts (another model was loaded). */
export function resetDurationDrafts(): void {
  units.clear();
  drafts.clear();
}

/** The unit a field is shown in now. */
export function unitOf(key: string, ms: number | undefined): DurationUnit {
  return units.get(key) || (ms !== undefined && ms > 0 ? durationUnit(ms) : 'sec');
}

/** Why a typed value can't be written ('' it can), with its ms. */
export function checkDuration(text: string, unit: DurationUnit, spec: { min: number; max: number; required?: boolean }): { ms: number | null; why: string } {
  if (!text.trim()) return spec.required ? { ms: null, why: 'Required: enter a number.' } : { ms: null, why: '' };
  const ms = durationMs(text, unit);
  if (ms === null) return { ms: null, why: 'Enter a number of 0 or more (a fraction like 1.5 is fine).' };
  if (ms < spec.min) return { ms: null, why: `At least ${durText(spec.min)}.` };
  if (ms > spec.max) return { ms: null, why: `At most ${durText(spec.max)}.` };
  return { ms, why: '' };
}

export function durationControl(doc: Document, spec: DurationSpec): HTMLElement {
  const unit = unitOf(spec.key, spec.value);
  const draft = drafts.get(spec.key);
  const num = el(doc, 'input', { type: 'number', id: spec.id, class: 'dur-num', min: '0', step: 'any', inputmode: 'decimal', autocomplete: 'off', placeholder: spec.placeholder || '' }) as HTMLInputElement;
  num.value = draft ? draft.text : spec.value !== undefined ? String(durationIn(spec.value, unit)) : '';
  num.disabled = !!spec.disabled;
  const sel = el(doc, 'select', { class: 'dur-unit', id: spec.id + '-unit', 'aria-label': `${spec.label} unit` }) as HTMLSelectElement;
  for (const u of DURATION_UNITS) sel.appendChild(el(doc, 'option', { value: u.id }, [u.label]));
  sel.value = unit;
  sel.disabled = !!spec.disabled;
  const msg = el(doc, 'p', { class: 'field-err small dur-msg', id: spec.id + '-msg', role: 'status' });
  const say = (why: string): void => {
    msg.textContent = why;
    msg.hidden = !why;
    if (why) {
      num.setAttribute('aria-invalid', 'true');
      num.setAttribute('aria-describedby', spec.id + '-msg');
    } else {
      num.removeAttribute('aria-invalid');
      num.removeAttribute('aria-describedby');
    }
  };
  say(draft ? draft.why : spec.error || '');
  num.addEventListener('change', () => {
    const u = sel.value as DurationUnit;
    const r = checkDuration(num.value, u, spec);
    if (r.why) {
      // not written: what was typed stays, and why it can't be
      drafts.set(spec.key, { text: num.value, why: r.why });
      say(r.why);
      return;
    }
    drafts.delete(spec.key);
    say('');
    if (r.ms === spec.value || (r.ms === null && spec.value === undefined)) return;
    spec.commit(r.ms);
  });
  sel.addEventListener('change', () => {
    const from = units.get(spec.key) || unit;
    const to = sel.value as DurationUnit;
    units.set(spec.key, to);
    // the same duration in the new unit (what is typed and valid, else the model's value)
    const typed = durationMs(num.value, from);
    const ms = typed !== null ? typed : spec.value;
    if (ms !== undefined && num.value.trim()) {
      num.value = String(durationIn(ms, to));
      const d = drafts.get(spec.key);
      if (d) drafts.set(spec.key, { text: num.value, why: d.why });
    }
  });
  const box = el(doc, 'span', { class: 'dur-ctl', role: 'group', 'aria-label': spec.label }, [num, sel]);
  return el(doc, 'span', { class: 'dur-wrap' }, [box, msg]);
}

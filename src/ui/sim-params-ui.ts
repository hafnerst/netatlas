/**
 * The simulation's Layer 1–4 parameters as a form: one collapsible section
 * per layer ("Layer 2 – Data link (6)", collapsed until opened), every
 * field prefilled with the value in effect, its unit, a help line with the
 * default and its source, range checks, a "modified" mark where it differs
 * from the default, and Reset per section and for all. The same form is
 * the start dialog's (values applied on Start) and the Simulation window's
 * (each change applied at once, at the current simulated time).
 */
import { ParamDef, ParamValue, LAYER_TITLES, fieldText, fieldUnit, formatValue, helpText, layerRows, paramDef, paramLayers, parseValue } from '../analysis/sim/params';
import { el } from './dom';

export interface ParamEditorOpts {
  /** a prefix for the element ids (the dialog's and the window's forms are on the page together) */
  id: string;
  /** the simulation-wide values that differ from their defaults */
  values: { [key: string]: ParamValue };
  /** a value was set (undefined: back to its default) */
  onChange?: (key: string, v: ParamValue | undefined) => void;
  /** the form's fields are valid again or not (the dialog's Start button follows it) */
  onValidity?: (ok: boolean) => void;
}

export interface ParamEditor {
  el: HTMLElement;
  /** the values that differ from their defaults */
  values(): { [key: string]: ParamValue };
  valid(): boolean;
  /** show values set elsewhere (the other form) */
  set(values: { [key: string]: ParamValue }): void;
}

export function paramEditor(doc: Document, opts: ParamEditorOpts): ParamEditor {
  const state = new Map<string, ParamValue>(Object.keys(opts.values).map((k) => [k, opts.values[k]]));
  const bad = new Set<string>();
  const root = el(doc, 'div', { class: 'psecs', id: opts.id });
  const resetAll = el(doc, 'button', { type: 'button', class: 'mini', id: opts.id + '-reset-all' }, ['Reset all to defaults']) as HTMLButtonElement;
  root.appendChild(el(doc, 'div', { class: 'psec-tools' }, [resetAll, el(doc, 'span', { class: 'muted small' }, ['Each field shows its default and where it comes from. A cable’s or relation’s own value in the model, and a device’s Simulation settings, take precedence.'])]));
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const sections: Array<{ layer: number; keys: string[]; reset: HTMLButtonElement; count: HTMLElement }> = [];

  const value = (key: string): ParamValue => (state.has(key) ? (state.get(key) as ParamValue) : paramDef(key).dflt);

  const mark = (key: string): void => {
    const row = root.querySelector(`[data-param-row~="${key}"]`) as HTMLElement | null;
    if (!row) return;
    const keys = (row.getAttribute('data-param-row') as string).split(' ');
    const mod = keys.some((k) => state.has(k));
    row.classList.toggle('modified', mod);
    const m = row.querySelector('.pmod') as HTMLElement;
    m.hidden = !mod;
  };

  const sync = (): void => {
    for (const s of sections) {
      const n = s.keys.filter((k) => state.has(k)).length;
      s.reset.disabled = n === 0;
      s.count.textContent = n ? `${n} modified` : '';
    }
    resetAll.disabled = state.size === 0;
    if (opts.onValidity) opts.onValidity(bad.size === 0);
  };

  const showError = (def: ParamDef, msg: string): void => {
    const inp = inputs.get(def.key) as HTMLElement;
    const err = root.querySelector('#' + opts.id + '-' + def.key + '-err') as HTMLElement;
    err.textContent = msg ? `${def.label} ${msg}.` : '';
    err.hidden = !msg;
    if (msg) inp.setAttribute('aria-invalid', 'true');
    else inp.removeAttribute('aria-invalid');
  };

  const commit = (def: ParamDef, v: ParamValue | undefined): void => {
    const was = value(def.key);
    if (v === undefined || v === def.dflt) state.delete(def.key);
    else state.set(def.key, v);
    mark(def.key);
    sync();
    if (value(def.key) !== was && opts.onChange) opts.onChange(def.key, v === def.dflt ? undefined : v);
  };

  const field = (def: ParamDef): HTMLElement => {
    const fid = opts.id + '-' + def.key;
    const helpId = fid + '-help';
    const errId = fid + '-err';
    let inp: HTMLInputElement | HTMLSelectElement;
    if (def.kind === 'enum') {
      const s = el(doc, 'select', { id: fid, 'data-param': def.key, 'aria-describedby': helpId + ' ' + errId }) as HTMLSelectElement;
      for (const o of def.options || []) s.appendChild(el(doc, 'option', { value: o.value }, [o.label]));
      s.value = String(value(def.key));
      s.addEventListener('change', () => commit(def, s.value));
      inp = s;
    } else {
      const i = el(doc, 'input', { type: 'text', id: fid, 'data-param': def.key, inputmode: def.kind === 'speed' ? 'text' : 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': helpId + ' ' + errId, value: fieldText(def, value(def.key)) }) as HTMLInputElement;
      const check = (): ParamValue | null => {
        const p = parseValue(def, i.value.trim() === '' ? fieldText(def, def.dflt) : i.value);
        if ('error' in p) {
          bad.add(def.key);
          showError(def, p.error);
          sync();
          return null;
        }
        bad.delete(def.key);
        showError(def, '');
        sync();
        return p.value;
      };
      i.addEventListener('input', () => void check());
      i.addEventListener('change', () => {
        const v = check();
        if (v === null) return;
        if (i.value.trim() === '') i.value = fieldText(def, def.dflt);
        commit(def, v);
      });
      inp = i;
    }
    inputs.set(def.key, inp);
    const unit = fieldUnit(def);
    return el(doc, 'div', { class: 'pfield' }, [
      el(doc, 'label', { for: fid }, [def.pairOf ? def.label.replace(/^BFD /, '') : def.label]),
      el(doc, 'span', { class: 'pinput' }, [inp, unit ? el(doc, 'span', { class: 'punit', 'aria-hidden': 'true' }, [unit]) : null]),
      el(doc, 'p', { class: 'phelp small muted', id: helpId }, [helpText(def) + (unit ? ` Unit: ${unit.replace(/ \(.*\)$/, '')}.` : '')]),
      el(doc, 'p', { class: 'perr field-err', id: errId, hidden: '' }, ['']),
    ]);
  };

  for (const layer of paramLayers()) {
    const rows = layerRows(layer);
    const bodyId = `${opts.id}-l${layer}`;
    const title = `${LAYER_TITLES[layer]} (${rows.length})`;
    const btn = el(doc, 'button', { type: 'button', class: 'psec-toggle', 'aria-expanded': 'false', 'aria-controls': bodyId, id: bodyId + '-btn' }, [title]);
    const count = el(doc, 'span', { class: 'psec-mod small' }, ['']);
    const body = el(doc, 'div', { class: 'psec-body', id: bodyId, hidden: '' });
    const keys: string[] = [];
    for (const row of rows) {
      const box = el(doc, 'div', { class: 'prow', 'data-param-row': row.map((d) => d.key).join(' ') }, [el(doc, 'span', { class: 'pmod', hidden: '' }, ['modified']), ...row.map((d) => field(d))]);
      for (const d of row) keys.push(d.key);
      body.appendChild(box);
    }
    const reset = el(doc, 'button', { type: 'button', class: 'mini psec-reset' }, [`Reset ${LAYER_TITLES[layer].replace(/ –.*$/, '')}`]) as HTMLButtonElement;
    reset.addEventListener('click', () => {
      for (const k of keys) {
        const def = paramDef(k);
        bad.delete(k);
        showError(def, '');
        const inp = inputs.get(k) as HTMLInputElement | HTMLSelectElement;
        inp.value = fieldText(def, def.dflt);
        if (state.has(k)) commit(def, undefined);
      }
      sync();
    });
    body.appendChild(el(doc, 'div', { class: 'psec-foot' }, [reset]));
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      body.hidden = !open;
    });
    root.appendChild(el(doc, 'section', { class: 'psec', 'data-layer': String(layer) }, [el(doc, 'h3', { class: 'psec-head' }, [btn, count]), body]));
    sections.push({ layer, keys, reset, count });
  }
  resetAll.addEventListener('click', () => {
    for (const s of sections) s.reset.click();
  });
  for (const k of state.keys()) mark(k);
  sync();
  return {
    el: root,
    values: () => {
      const o: { [key: string]: ParamValue } = {};
      for (const [k, v] of state) o[k] = v;
      return o;
    },
    valid: () => bad.size === 0,
    set(values) {
      state.clear();
      for (const k of Object.keys(values)) state.set(k, values[k]);
      for (const [k, inp] of inputs) {
        if (doc.activeElement === inp) continue;
        inp.value = fieldText(paramDef(k), value(k));
        mark(k);
      }
      sync();
    },
  };
}

/** A value with its unit, for texts ("4 h"). */
export function paramText(key: string, v: ParamValue): string {
  return formatValue(paramDef(key), v);
}

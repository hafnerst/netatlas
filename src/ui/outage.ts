/**
 * Resilience → Outage impact: what stops working, what remains available and
 * what becomes uncertain if these components become unavailable. The
 * components are chosen in a searchable picker (or prepared from the diagram
 * selection, a single-component failure, a saved failure set) and kept as
 * exact refs; the configured architecture is compared with itself without
 * the outage by the failure analysis (analysis/whatif.ts, exact refs). A
 * static comparison: no convergence, recovery time, transient loss or
 * probability. Nothing in the model changes. outageOptions, searchOutage,
 * addPicks, expandSet, outagePreview, outageSummary and outageText are pure.
 */
import { DEP_CHANGE_TEXT, DEP_LABEL, DepChange } from '../analysis/dependencies';
import { domainRefs, failableRef, refLabel } from '../analysis/failure';
import { coverageText, exportFooter, exportHeader } from '../analysis/result';
import { EXP_CHANGE_TEXT, ExpChange, ExpChangeKind, WHATIF_MAX, WhatIf } from '../analysis/whatif';
import { bpsText } from '../analysis/capacity';
import { lookupProtocol } from '../model/protocols';
import { FAILURE_DOMAIN_KINDS, Model, deviceInterfaces, relationDevices } from '../model/types';
import { el } from './dom';
import { ContextBarActions, ContextBarState, contextBar, coverageLine, limitsDetails } from './analysis-ui';
import { EvidenceAction, EvidenceView } from './evidence';

/** A component of the condition: its exact ref, and where it came from ('' chosen directly, 'domain:<id>', 'group:<id>'). */
export interface OutagePick {
  ref: string;
  via: string[];
}

export interface OutageForm {
  picks: OutagePick[];
  /** device pairs too: '' none, 'entire', 'group:<id>' */
  reach: string;
  /** the picker's text (kept across redraws) */
  query: string;
  /** components prepared from elsewhere while a condition exists: added or started over only on request */
  offer: { refs: string[]; via: string; label: string } | null;
}

export function newOutageForm(): OutageForm {
  return { picks: [], reach: '', query: '', offer: null };
}

/** What the picker offers: a component (or a set that expands to components), or something that can't be made unavailable on its own. */
export interface OutageOption {
  ref: string;
  id: string;
  type: string;
  detail: string;
  /** why it can't be chosen ('' it can) */
  unsupported: string;
  /** lower case: what a search matches */
  text: string;
}

const optCache = new WeakMap<Model, OutageOption[]>();

/** Every option of a model, in the order they are offered: devices, cables, interfaces, relations, groups, saved failure sets, then the unsupported. */
export function outageOptions(model: Model): OutageOption[] {
  const hit = optCache.get(model);
  if (hit) return hit;
  const out: OutageOption[] = [];
  const add = (ref: string, id: string, type: string, detail: string, unsupported = '', extra = ''): void => {
    out.push({ ref, id, type, detail, unsupported, text: `${id} ${type} ${detail} ${extra}`.toLowerCase() });
  };
  const end = (e: { device: string; iface?: string }): string => (e.iface !== undefined ? `${e.device}:${e.iface}` : e.device);
  for (const d of model.devices) add('device:' + d.id, d.id, 'Device', [d.label && d.label !== d.id ? d.label : '', d.type].filter((x) => !!x).join(' · '));
  for (const l of model.links) add('link:' + l.id, l.id, 'Cable', `${end(l.a)} ↔ ${end(l.b)}`, '', l.label || '');
  for (const d of model.devices) for (const i of deviceInterfaces(d)) add(`iface:${d.id}:${i.id}`, `${d.id}:${i.id}`, 'Interface', [i.label || '', i.addresses.join(' ')].filter((x) => !!x).join(' · '), '', i.type);
  for (const r of model.relations) add('relation:' + r.id, r.id, 'Relation', `${lookupProtocol(model.protocols, r.protocol, r.category).label} · ${relationDevices(r).join(' ↔ ')}`, '', r.label || '');
  for (const g of model.groups) {
    const n = groupDevices(model, g.id).length;
    add('group:' + g.id, g.id, 'Group', `${g.label !== g.id ? g.label + ' · ' : ''}adds its ${n} device${n === 1 ? '' : 's'}`, n ? '' : 'The group has no device: nothing to make unavailable');
  }
  for (const d of model.failureDomains) add('domain:' + d.id, d.id, 'Saved failure set', `${d.label} · ${kindLabel(d.kind)} · ${d.members.length} member${d.members.length === 1 ? '' : 's'}`);
  for (const n of model.networks) add('network:' + n.id, n.id, 'Network', n.label, 'A network is not made unavailable on its own: choose the devices, cables or interfaces that carry it');
  for (const d of model.devices) for (const a of d.applications || []) add(`app:${d.id}/${a.id}`, `${d.id}/${a.id}`, 'Application', a.name, `An application is not made unavailable on its own: choose ${d.id}, the device that runs it`);
  optCache.set(model, out);
  return out;
}

const kindLabel = (k: string): string => (FAILURE_DOMAIN_KINDS.find((x) => x.id === k) || { label: k }).label;

/** The devices of a group, nested groups included (its explicit membership; never the drawing). */
export function groupDevices(model: Model, gid: string): string[] {
  const inGroup = (g0: string | undefined): boolean => {
    let g = g0 ? model.index.groups.get(g0) : undefined;
    for (let n = 0; g && n < 32; n++) {
      if (g.id === gid) return true;
      g = g.parent ? model.index.groups.get(g.parent) : undefined;
    }
    return false;
  };
  return model.devices.filter((d) => inGroup(d.group)).map((d) => d.id);
}

/** The options a search matches (every word, in id, type, label and endpoints): exact ids first, then id prefixes, then the rest in their order; at most `limit`, with how many matched. */
export function searchOutage(model: Model, query: string, limit = 30): { items: OutageOption[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w);
  if (!words.length) return { items: [], total: 0 };
  const q = query.trim().toLowerCase();
  const all = outageOptions(model).filter((o) => words.every((w) => o.text.indexOf(w) >= 0));
  const rank = (o: OutageOption): number => (o.unsupported ? 3 : o.id.toLowerCase() === q ? 0 : o.id.toLowerCase().indexOf(q) === 0 ? 1 : 2);
  const ranked = all.map((o, i) => ({ o, i, r: rank(o) })).sort((a, b) => a.r - b.r || a.i - b.i);
  return { items: ranked.slice(0, limit).map((x) => x.o), total: all.length };
}

/** A component of a condition as the lists name it: its id, type and context ("uplink-b", "Cable", "access-1:up2 ↔ core-b:down1"). */
export function pickLabel(model: Model, ref: string): { id: string; type: string; detail: string } {
  const o = outageOptions(model).find((x) => x.ref === ref);
  if (o) return { id: o.id, type: o.type, detail: o.detail };
  return { id: ref.slice(ref.indexOf(':') + 1), type: '', detail: 'not in the model' };
}

/** A set's components: a saved failure set's or a group's (with the members that name nothing now), or the ref itself. */
export function expandSet(model: Model, ref: string): { refs: string[]; via: string; label: string; invalid: string[] } {
  if (ref.indexOf('domain:') === 0) {
    const d = model.failureDomains.find((x) => x.id === ref.slice(7));
    if (!d) return { refs: [], via: ref, label: ref.slice(7), invalid: [] };
    const known = (m: string): boolean => model.index.devices.has(m) || model.index.links.has(m) || model.index.relations.has(m) || model.index.groups.has(m);
    return { refs: domainRefs(model, d), via: ref, label: `saved failure set ${d.label}`, invalid: d.members.filter((m) => !known(m)) };
  }
  if (ref.indexOf('group:') === 0) {
    const g = model.index.groups.get(ref.slice(6));
    return { refs: g ? groupDevices(model, g.id).map((x) => 'device:' + x) : [], via: ref, label: `group ${g ? g.label : ref.slice(6)}`, invalid: [] };
  }
  return { refs: [ref], via: '', label: '', invalid: [] };
}

/** Add components to a condition (deduplicated by ref; a component already there notes where else it came from). */
export function addPicks(picks: OutagePick[], refs: string[], via: string): { picks: OutagePick[]; added: number; already: number } {
  const out = picks.map((p) => ({ ref: p.ref, via: p.via.slice() }));
  let added = 0;
  let already = 0;
  for (const r of refs) {
    const p = out.find((x) => x.ref === r);
    if (p) {
      already++;
      if (p.via.indexOf(via) < 0) p.via.push(via);
    } else {
      out.push({ ref: r, via: [via] });
      added++;
    }
  }
  return { picks: out, added, already };
}

export interface OutagePreview {
  /** the picks that exist in the model */
  refs: string[];
  /** the picks that name nothing in the model now (deleted or renamed) */
  missing: string[];
  /** chosen directly */
  explicit: number;
  /** from each set: its label, how many, how many of them also chosen directly */
  sets: Array<{ via: string; label: string; count: number; also: number }>;
  tooLarge: boolean;
  /** why it can't be analyzed now ('' it can) */
  blocked: string;
  /** how the analysis propagates the outage, for the kinds chosen */
  propagation: string;
}

const viaLabel = (model: Model, via: string): string => {
  if (via.indexOf('domain:') === 0) {
    const d = model.failureDomains.find((x) => x.id === via.slice(7));
    return `saved failure set ${d ? d.label : via.slice(7)}`;
  }
  if (via.indexOf('group:') === 0) {
    const g = model.index.groups.get(via.slice(6));
    return `group ${g ? g.label : via.slice(6)}`;
  }
  return via;
};

/** The condition as the question shows it before anything is evaluated. */
export function outagePreview(model: Model, picks: OutagePick[]): OutagePreview {
  const refs = picks.filter((p) => failableRef(model, p.ref)).map((p) => p.ref);
  const missing = picks.filter((p) => !failableRef(model, p.ref)).map((p) => p.ref);
  const vias: string[] = [];
  for (const p of picks) for (const v of p.via) if (v && vias.indexOf(v) < 0) vias.push(v);
  const sets = vias.map((v) => {
    const of = picks.filter((p) => p.via.indexOf(v) >= 0);
    return { via: v, label: viaLabel(model, v), count: of.length, also: of.filter((p) => p.via.indexOf('') >= 0).length };
  });
  const tooLarge = refs.length > WHATIF_MAX;
  const kinds = new Set(refs.map((r) => r.slice(0, r.indexOf(':'))));
  const prop: string[] = [];
  if (kinds.has('device')) prop.push('a device takes its interfaces and attached cables down, and the guests it hosts (unless an HA cluster restarts them)');
  if (kinds.has('link')) prop.push('a cable takes its ports down');
  if (kinds.has('iface')) prop.push('an interface takes its cable down');
  if (kinds.has('relation')) prop.push('a relation takes what runs over it down');
  const blocked = !picks.length
    ? 'Choose at least one component.'
    : missing.length
      ? `Remove what is no longer in the model: ${missing.map((r) => r.slice(r.indexOf(':') + 1)).join(', ')}.`
      : tooLarge
        ? `${refs.length} components: at most ${WHATIF_MAX} are evaluated together. Remove some; nothing is cut off silently.`
        : '';
  return { refs, missing, explicit: picks.filter((p) => p.via.indexOf('') >= 0).length, sets, tooLarge, blocked, propagation: prop.length ? `The analysis then propagates it as modeled: ${prop.join('; ')}; aggregates, redundancy groups and routes degrade, fail over or fail with them. These consequences are results, not additional choices.` : '' };
}

/** A finished (or progressing) outage analysis: the condition as it was asked, frozen with its result. */
export interface OutageRun {
  model: Model;
  at: number;
  result: WhatIf;
  picks: OutagePick[];
  /** the configured dependencies and saved requirements compared */
  depsTotal: number;
  /** device pairs being traced (Stop ends it; the coverage says how far it got) */
  reachRunning: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A requirement change that means it is no longer satisfied because of the outage. */
const REQ_NEW: ExpChangeKind[] = ['isolation-violated', 'availability-lost'];

/** The objects down or degraded as a consequence (not chosen): refs with their state and why. */
export function propagated(w: WhatIf): Array<{ ref: string; state: string; why: string }> {
  const r = w.result;
  if (!r) return [];
  const chosen = new Set(r.failed);
  const out: Array<{ ref: string; state: string; why: string }> = [];
  const add = <K>(m: Map<K, string>, ref: (k: K) => string): void =>
    m.forEach((st, k) => {
      const x = ref(k);
      if (st !== 'up' && !chosen.has(x)) out.push({ ref: x, state: st === 'takeover' ? 'takes over' : st, why: r.why.get(x) || '' });
    });
  add(r.devices, (k) => 'device:' + k);
  add(r.links, (k) => 'link:' + k);
  add(r.relations, (k) => 'relation:' + k);
  add(r.networks, (k) => 'network:' + k);
  add(r.routes, (k) => k);
  return out;
}

/** The answer's lines: what changed against the baseline, by computed category (an unavailable category is said, never shown as zero). */
export function outageSummary(model: Model, run: OutageRun): string[] {
  const w = run.result;
  const lines: string[] = [];
  const req = w.expectations;
  const count = (k: ExpChangeKind[]): number => req.filter((x) => k.indexOf(x.change) >= 0).length;
  if (!req.length) lines.push('No saved requirements were available to evaluate.');
  else {
    const parts = [count(REQ_NEW) ? `${plural(count(REQ_NEW), 'requirement is', 'requirements are')} no longer satisfied` : '', count(['alternative']) ? `${plural(count(['alternative']), 'requirement is', 'requirements are')} kept through an alternative` : '', count(['indeterminate', 'unsupported']) ? `${plural(count(['indeterminate', 'unsupported']), 'requirement', 'requirements')} cannot be determined` : '', count(['already-violated']) ? `${plural(count(['already-violated']), 'requirement was', 'requirements were')} already violated before the outage` : ''].filter((x) => !!x);
    lines.push(parts.length ? parts.join('; ') : `No change to the ${plural(req.length, 'saved requirement', 'saved requirements')}`);
  }
  const d = (k: string): number => w.deps.filter((x) => x.change === k).length;
  if (!w.deps.length) lines.push('The model configures no dependency (application peers, brokers, DNS, DHCP, timing, syslog, AAA) to evaluate.');
  else {
    const parts = [d('unavailable') ? `${plural(d('unavailable'), 'configured dependency becomes', 'configured dependencies become')} unavailable` : '', d('alternative') ? `${plural(d('alternative'), 'remains', 'remain')} available through an alternative` : '', d('degraded') ? `${d('degraded')} degraded` : '', d('indeterminate') ? `${d('indeterminate')} cannot be determined` : '', d('consumer-down') ? `${plural(d('consumer-down'), 'has its', 'have their')} consumer unavailable by the outage` : '', d('not-before') ? `${d('not-before')} already unavailable before the outage` : ''].filter((x) => !!x);
    lines.push(parts.length ? parts.join('; ') : `No change to the ${plural(w.deps.length, 'configured dependency', 'configured dependencies')}`);
  }
  const iso = w.structural ? w.structural.isolated.reduce((n, g) => n + g.length, 0) : 0;
  const prop = propagated(w).length;
  lines.push(prop || iso ? `${plural(prop, 'further object goes', 'further objects go')} down or degrade as a consequence${iso ? `; ${plural(iso, 'device is', 'devices are')} disconnected` : ''}` : 'No further object goes down or degrades as a consequence');
  if (w.capacity && w.capacity.before.evaluated) {
    const ch = w.capacity.changes.filter((x) => x.change !== 'unchanged').length;
    lines.push(ch ? `${plural(ch, 'stated demand changes', 'stated demands change')} against the stated capacity` : 'The stated traffic fits as it did');
  }
  if (w.reach) lines.push(`${plural(w.reach.pairs.length, 'device pair loses', 'device pairs lose')} reachability (${coverageText(w.reach.coverage)}${run.reachRunning ? ', still checking' : ''})`);
  else lines.push('Device-pair connectivity was not checked (optional: choose a check scope)');
  const changed = count(REQ_NEW) + count(['indeterminate', 'unsupported']) + d('unavailable') + d('degraded') + d('indeterminate') + prop + iso + (w.reach ? w.reach.pairs.length : 0) + (w.capacity ? w.capacity.changes.filter((x) => x.change !== 'unchanged').length : 0);
  if (!changed) lines.push('No additional modeled effect found within the checks performed.');
  return lines;
}

// ------------------------------------------------------------ the question (left)

export interface OutageView {
  model: Model;
  form: OutageForm;
  run: OutageRun | null;
  bar: ContextBarState;
  sel: string;
  locked: string;
  /** the diagram selection when it is a supported component not in the condition (null: none) */
  selection: { ref: string; label: string } | null;
  /** the configured dependencies of the model on screen */
  depsTotal: number;
  /** the device pairs a check scope would trace: of how many */
  pairs: { checked: number; eligible: number } | null;
}

export interface OutageActions extends ContextBarActions {
  oiAdd(ref: string): void;
  oiRemove(ref: string): void;
  oiClear(): void;
  oiQuery(q: string): void;
  oiReach(v: string): void;
  oiOffer(kind: 'add' | 'replace' | 'dismiss'): void;
  oiSelection(): void;
  oiRun(): void;
  oiStop(): void;
  oiOut(kind: 'copy' | 'save' | 'experiment'): void;
  /** the failure domains' editor (a model edit, separate) */
  domains(): void;
}

/** The searchable picker: an inline listbox of the matches; ↑/↓ choose, Enter adds the highlighted one (or an exact id), Escape clears. */
function picker(doc: Document, v: OutageView, act: OutageActions): HTMLElement {
  const m = v.model;
  const box = el(doc, 'div', { class: 'oi-picker' });
  const input = el(doc, 'input', { type: 'search', id: 'oi-search', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'oi-matches', 'aria-describedby': 'oi-help', autocomplete: 'off', spellcheck: 'false', placeholder: 'name, ID, type or endpoint' }) as HTMLInputElement;
  input.value = v.form.query;
  const list = el(doc, 'ul', { id: 'oi-matches', role: 'listbox', class: 'combo-list oi-matches', 'aria-label': 'Matching components' }) as HTMLUListElement;
  const status = el(doc, 'p', { class: 'small muted', id: 'oi-match-status', role: 'status', 'aria-live': 'polite' });
  const chosen = new Set(v.form.picks.map((p) => p.ref));
  let active = -1;
  let items: OutageOption[] = [];
  const options = (): HTMLElement[] => Array.from(list.querySelectorAll('[role="option"]')) as HTMLElement[];
  const render = (): void => {
    while (list.firstChild) list.removeChild(list.firstChild);
    const r = searchOutage(m, input.value);
    items = r.items;
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.hidden = !input.value.trim();
    input.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    items.forEach((o, k) => {
      const on = chosen.has(o.ref);
      const li = el(doc, 'li', { role: 'option', id: 'oi-o' + k, 'data-oi-ref': o.ref, 'aria-selected': 'false', 'aria-disabled': o.unsupported || on ? 'true' : 'false', class: 'combo-opt' + (o.unsupported ? ' oi-unsupported' : '') }, [
        el(doc, 'span', {}, [el(doc, 'strong', {}, [o.id]), ` — ${o.type}${o.detail ? ' · ' + o.detail : ''}`]),
        el(doc, 'span', { class: 'combo-count' }, [o.unsupported ? o.unsupported : on ? 'in the condition' : o.ref.indexOf('domain:') === 0 || o.ref.indexOf('group:') === 0 ? 'adds its components' : '']),
      ]);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(k);
      });
      list.appendChild(li);
    });
    status.textContent = !input.value.trim() ? '' : r.total ? (r.total > items.length ? `${items.length} of ${r.total} matches shown: refine the search.` : `${plural(r.total, 'match', 'matches')}.`) : 'Nothing in the model matches.';
  };
  const choose = (k: number): void => {
    const o = items[k];
    if (!o) return;
    if (o.unsupported) {
      status.textContent = `${o.id}: ${o.unsupported}.`;
      return;
    }
    if (chosen.has(o.ref)) {
      status.textContent = `${o.id} is already in the condition.`;
      return;
    }
    act.oiAdd(o.ref);
  };
  const move = (d: number): void => {
    const os = options();
    if (!os.length) return;
    active = (active + d + os.length) % os.length;
    os.forEach((o, k) => o.setAttribute('aria-selected', k === active ? 'true' : 'false'));
    input.setAttribute('aria-activedescendant', os[active].id);
    if (typeof os[active].scrollIntoView === 'function') os[active].scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    act.oiQuery(input.value);
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) return choose(active);
      // (an exact id or ref only when it names one thing: never the first of several, never a similar name)
      const q = input.value.trim();
      const exact = items.filter((o) => o.id === q || o.ref === q);
      if (exact.length === 1) choose(items.indexOf(exact[0]));
      else status.textContent = exact.length > 1 ? `Several objects are called ${q}: choose one with ↑/↓.` : q ? 'Choose a match with ↑/↓, then Enter.' : '';
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      act.oiQuery('');
      render();
    }
  });
  box.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'oi-search' }, ['Add component']), input]));
  box.appendChild(el(doc, 'p', { class: 'small muted', id: 'oi-help' }, ['Devices, cables, interfaces and relations; a group adds its devices. ↑/↓ choose, Enter adds, Escape clears.']));
  box.appendChild(list);
  box.appendChild(status);
  render();
  return box;
}

/** The question of Outage impact (left): what it is for, the picker, the condition as it will be evaluated, the optional check scope, Analyze impact. */
export function outageRequest(doc: Document, v: OutageView, act: OutageActions): HTMLElement {
  const m = v.model;
  const f = v.form;
  const sec = el(doc, 'div', { class: 'wi-section oi-section' });
  sec.appendChild(contextBar(doc, v.bar, act));
  sec.appendChild(el(doc, 'p', { class: 'small', id: 'oi-intro' }, ['Choose components to make unavailable. Compare the modeled consequences with the architecture without this outage. Nothing in the model is changed.']));
  const why = el(doc, 'details', { class: 'an-limits', id: 'oi-why' }, [el(doc, 'summary', {}, ['When is this useful?'])]);
  why.appendChild(el(doc, 'ul', { class: 'small' }, ['Check whether another uplink preserves connectivity.', 'Examine a maintenance outage.', 'Check the effect of losing a broker or resolver.', 'Investigate two components being unavailable together.'].map((x) => el(doc, 'li', {}, [x]))));
  why.appendChild(el(doc, 'p', { class: 'small muted' }, ['Single-component failures scans every component failing alone. Outage impact answers for the components you choose. What happens over time — convergence, retries, recovery — is a question for Simulation and Experiments.']));
  sec.appendChild(why);
  if (f.offer) {
    const o = f.offer;
    const b = (k: 'add' | 'replace' | 'dismiss', label: string): HTMLElement => {
      const x = el(doc, 'button', { type: 'button', class: k === 'add' ? 'mini primary' : 'mini', 'data-oi-offer': k }, [label]);
      x.addEventListener('click', () => act.oiOffer(k));
      return x;
    };
    sec.appendChild(el(doc, 'div', { class: 'oi-offer', role: 'group', id: 'oi-offer', 'aria-label': 'Prepared components' }, [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [o.label]), ` is prepared; the condition below already has ${plural(f.picks.length, 'component', 'components')}.`]), el(doc, 'div', { class: 'tf-actions' }, [b('add', 'Add to the condition'), b('replace', 'Start a new condition with it'), b('dismiss', 'Keep the condition as it is')])]));
  }
  sec.appendChild(picker(doc, v, act));
  const tools = el(doc, 'div', { class: 'tf-actions oi-add-more' });
  if (v.selection) {
    const s = el(doc, 'button', { type: 'button', class: 'mini', id: 'oi-add-sel', title: 'Add the object selected in the diagram' }, [`Add diagram selection (${v.selection.label})`]);
    s.addEventListener('click', () => act.oiSelection());
    tools.appendChild(s);
  }
  if (m.failureDomains.length) {
    const sel = el(doc, 'select', { id: 'oi-set', 'aria-describedby': 'oi-set-help' }) as HTMLSelectElement;
    sel.appendChild(el(doc, 'option', { value: '' }, ['Add saved failure set…']));
    for (const d of m.failureDomains) sel.appendChild(el(doc, 'option', { value: 'domain:' + d.id }, [`${d.label} (${kindLabel(d.kind)}, ${plural(d.members.length, 'member', 'members')})`]));
    const add = el(doc, 'button', { type: 'button', class: 'mini', id: 'oi-set-add' }, ['Add set']);
    add.addEventListener('click', () => {
      if (sel.value) act.oiAdd(sel.value);
    });
    tools.appendChild(el(doc, 'label', { for: 'oi-set', class: 'sr-only' }, ['Saved failure set']));
    tools.appendChild(sel);
    tools.appendChild(add);
  }
  if (tools.childNodes.length) sec.appendChild(tools);
  const cfg = el(doc, 'button', { type: 'button', class: 'ref', id: 'dom-config', title: v.locked || 'Add, change or delete the model’s failure domains: a model edit with undo, in the right panel' }, [m.failureDomains.length ? 'Edit failure domains…' : 'Define failure domains…']);
  cfg.addEventListener('click', () => act.domains());
  sec.appendChild(el(doc, 'p', { class: 'small muted', id: 'oi-set-help' }, [m.failureDomains.length ? 'A saved failure set (failure domain) is a named set of components assumed to become unavailable together; adding one adds its components. ' : 'Saved failure sets are optional: a failure domain is a named set of components assumed to become unavailable together. ', cfg]));
  sec.appendChild(conditionPreview(doc, v, act));
  // the optional check scope, with its size before anything runs
  const r = el(doc, 'select', { id: 'oi-reach' }) as HTMLSelectElement;
  r.appendChild(el(doc, 'option', { value: '' }, ['No device-pair check']));
  r.appendChild(el(doc, 'option', { value: 'entire' }, ['Device pairs: entire architecture (bounded)']));
  for (const g of m.groups) r.appendChild(el(doc, 'option', { value: 'group:' + g.id }, [`Device pairs: ${g.label}`]));
  r.value = f.reach;
  r.addEventListener('change', () => act.oiReach(r.value));
  sec.appendChild(el(doc, 'div', { class: 'tf-row dc-row' }, [el(doc, 'label', { for: 'oi-reach' }, ['Also check']), r]));
  if (v.pairs) sec.appendChild(el(doc, 'p', { class: 'small muted', id: 'oi-pairs' }, [v.pairs.checked < v.pairs.eligible ? `Traces ${v.pairs.checked} of ${v.pairs.eligible} device pairs (the limit), before and under the outage; the coverage is reported. Stop is available while it runs.` : `Traces all ${v.pairs.eligible} device pairs, before and under the outage. Stop is available while it runs.`]));
  const pv = outagePreview(m, f.picks);
  const go = el(doc, 'button', { type: 'submit', class: 'primary', id: 'oi-go', 'aria-describedby': 'oi-blocked' }, ['Analyze impact']) as HTMLButtonElement;
  if (pv.blocked) go.setAttribute('aria-disabled', 'true');
  const form = el(doc, 'form', { class: 'trace-form', 'aria-label': 'Outage impact' }) as HTMLFormElement;
  const acts = el(doc, 'div', { class: 'tf-actions' }, [go]);
  if (f.picks.length) {
    const clr = el(doc, 'button', { type: 'button', class: 'mini', id: 'oi-clear' }, ['Clear']);
    clr.addEventListener('click', () => act.oiClear());
    acts.appendChild(clr);
  }
  form.appendChild(acts);
  form.appendChild(el(doc, 'p', { class: 'small muted', id: 'oi-blocked' }, [pv.blocked]));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act.oiRun();
  });
  sec.appendChild(form);
  return sec;
}

/** The condition as it will be evaluated: the components, where each came from, the counts, the limits. */
function conditionPreview(doc: Document, v: OutageView, act: OutageActions): HTMLElement {
  const m = v.model;
  const picks = v.form.picks;
  const pv = outagePreview(m, picks);
  const box = el(doc, 'section', { class: 'oi-condition', id: 'oi-condition', 'aria-labelledby': 'oi-cond-h' }, [el(doc, 'h4', { id: 'oi-cond-h' }, ['Assume unavailable'])]);
  if (!picks.length) {
    box.appendChild(el(doc, 'p', { class: 'small muted', id: 'oi-none' }, ['Nothing yet: add one or more components above.']));
    return box;
  }
  const ul = el(doc, 'ul', { class: 'small oi-picks', 'aria-label': 'Components assumed unavailable' });
  for (const p of picks) {
    const l = pickLabel(m, p.ref);
    const gone = pv.missing.indexOf(p.ref) >= 0;
    const from = p.via.filter((x) => !!x).map((x) => `from ${viaLabel(m, x)}`);
    const rm = el(doc, 'button', { type: 'button', class: 'mini', 'data-oi-remove': p.ref, 'aria-label': `Remove ${l.id} from the condition`, title: 'Remove' }, ['×']);
    rm.addEventListener('click', () => act.oiRemove(p.ref));
    ul.appendChild(el(doc, 'li', { 'data-oi-pick': p.ref, class: gone ? 'oi-gone' : '' }, [el(doc, 'strong', {}, [l.id]), el(doc, 'span', { class: 'muted' }, [gone ? ' — not in the model any more (deleted or renamed)' : ` — ${l.type}${l.detail ? ' · ' + l.detail : ''}`]), from.length ? el(doc, 'span', { class: 'muted' }, [` (${from.join(', ')}${p.via.indexOf('') >= 0 ? ', also chosen directly' : ''})`]) : null, ' ', rm]));
  }
  box.appendChild(ul);
  const counts = [pv.explicit ? `${plural(pv.explicit, 'explicitly selected component', 'explicitly selected components')}` : ''].concat(pv.sets.map((s) => `${s.count} from the ${s.label}${s.also ? ` (${s.also} also selected directly)` : ''}`)).filter((x) => !!x);
  box.appendChild(el(doc, 'p', { class: 'small', id: 'oi-counts' }, [counts.join('; ') + '.']));
  if (pv.sets.length) box.appendChild(el(doc, 'p', { class: 'small muted' }, ['A set’s components are copied into this condition: removing one here does not change the saved failure set or the group.']));
  if (pv.propagation) box.appendChild(el(doc, 'p', { class: 'small muted', id: 'oi-propagation' }, [pv.propagation]));
  if (pv.missing.length || pv.tooLarge) box.appendChild(el(doc, 'p', { class: 'trace-error', role: 'alert', id: 'oi-refuse' }, [pv.blocked]));
  box.appendChild(el(doc, 'p', { class: 'small muted' }, [`Compared against the baseline: ${m.expectations.length ? plural(m.expectations.length, 'saved requirement', 'saved requirements') : 'no saved requirement'}, ${v.depsTotal ? plural(v.depsTotal, 'configured dependency', 'configured dependencies') : 'no configured dependency'}, the structure${m.demands && m.demands.length ? ', the stated capacity' : ''}.`]));
  return box;
}

// ------------------------------------------------------------ the answer (bottom)

const CAP_CHANGE_TEXT: { [k: string]: string } = { overload: 'Overloaded although still carried', lost: 'No longer carried', distribution: 'Now depends on the distribution', unknown: 'Insufficient information', relieved: 'Fits again', unchanged: 'Unchanged' };

/** A selectable row of a result list (its evidence on the right). */
function pickItem(doc: Document, key: string, sel: string, kids: Array<Node | string | null>, attrs: { [k: string]: string } = {}): HTMLElement {
  const on = key === sel;
  return el(doc, 'li', { ...attrs, class: (attrs.class ? attrs.class + ' ' : '') + 'an-pickrow' + (on ? ' an-selected' : '') }, [...kids, ' ', el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': on ? 'true' : 'false', 'aria-controls': 'an-detail' }, ['Evidence'])]);
}

/** A group of results, open when it holds what matters first or the selection. */
function group(doc: Document, title: string, items: HTMLElement[], open: boolean, attrs: { [k: string]: string } = {}): HTMLElement | null {
  if (!items.length) return null;
  const d = el(doc, 'details', { class: 'wi-group', ...attrs }, [el(doc, 'summary', {}, [`${title} (${items.length})`]), el(doc, 'ul', { class: 'small' }, items)]);
  if (open) d.setAttribute('open', '');
  return d;
}

const DEP_GROUPS: Array<{ k: DepChange['change']; title: string; open: boolean }> = [
  { k: 'unavailable', title: 'Dependencies newly unavailable', open: true },
  { k: 'degraded', title: 'Dependencies degraded', open: true },
  { k: 'alternative', title: 'Dependencies retained through alternatives', open: true },
  { k: 'indeterminate', title: 'Dependencies that cannot be determined', open: false },
  { k: 'consumer-down', title: 'Dependencies whose consumer is unavailable by the outage', open: false },
  { k: 'not-before', title: 'Dependencies already unavailable before the outage', open: false },
];

const REQ_GROUPS: Array<{ k: ExpChangeKind[]; title: string; open: boolean }> = [
  { k: ['isolation-violated', 'availability-lost'], title: 'Requirements newly violated', open: true },
  { k: ['alternative'], title: 'Requirements kept through an alternative', open: true },
  { k: ['indeterminate', 'unsupported'], title: 'Requirements that cannot be determined', open: false },
  { k: ['already-violated'], title: 'Requirements already violated before the outage', open: false },
];

const stripKind = (r: string): string => r.replace(/^[a-z]+:/, '');

/** The answer (bottom): the condition and baseline, the summary, the changed items by kind, alternatives and uncertainty, coverage, exports. */
export function outageResults(doc: Document, v: OutageView, act: OutageActions): HTMLElement {
  const run = v.run;
  const box = el(doc, 'div', { class: 'wi-result', id: 'oi-result' });
  if (!run) {
    box.appendChild(el(doc, 'p', { class: 'muted', id: 'an-empty' }, ['Select one or more components on the left, review what will become unavailable, then Analyze impact: what changes compared with the architecture without the outage appears here.']));
    return box;
  }
  const w = run.result;
  const m = run.model;
  const out = (k: 'copy' | 'save' | 'experiment', label: string, title: string): HTMLElement => {
    const b = el(doc, 'button', { type: 'button', class: 'mini', id: 'oi-' + k, title }, [label]);
    b.addEventListener('click', () => act.oiOut(k));
    return b;
  };
  box.appendChild(el(doc, 'div', { class: 'an-res-tools', role: 'group', 'aria-label': 'Export or continue' }, [out('copy', 'Copy as text', 'Copy the result as plain text'), out('save', 'Save as text', 'Save the result as a text file'), out('experiment', 'Prepare an experiment…', v.locked || 'For recovery, retries and transient behaviour over time: adds an experiment that fails these components (one undo step; nothing runs until you run it)')]));
  if (w.unknown.length) box.appendChild(el(doc, 'p', { class: 'trace-error', role: 'alert' }, [`Not in the model: ${w.unknown.map(stripKind).join(', ')}.`]));
  const names = run.picks.map((p) => pickLabel(m, p.ref).id);
  if (w.tooLarge || !w.result) {
    box.appendChild(el(doc, 'p', { class: 'small', id: 'oi-summary', tabindex: '-1' }, [w.info.limits[w.info.limits.length - 1] || 'Nothing was evaluated.']));
    return box;
  }
  const lines = outageSummary(m, run);
  const newly = w.expectations.some((x) => REQ_NEW.indexOf(x.change) >= 0) || w.deps.some((d) => d.change === 'unavailable');
  const unsure = w.expectations.some((x) => x.change === 'indeterminate' || x.change === 'unsupported') || w.deps.some((d) => d.change === 'indeterminate');
  box.appendChild(
    el(doc, 'div', { class: 'an-verdict oi-summary ' + (newly ? 'v-violated' : unsure ? 'v-indeterminate' : 'v-neutral'), role: 'status', id: 'oi-summary', tabindex: '-1' }, [
      el(doc, 'p', {}, [el(doc, 'strong', {}, [`Outage: ${names.join(', ')}`])]),
      el(doc, 'p', { class: 'small' }, ['Compared with the same configured architecture without this outage:']),
      el(doc, 'ul', { class: 'small' }, lines.map((l) => el(doc, 'li', {}, [l]))),
    ]),
  );
  if (unsure) box.appendChild(el(doc, 'p', { class: 'small', id: 'oi-unsure' }, ['Some outcomes cannot be determined: the configured model does not establish them (for example addresses assigned at runtime). They are not counted as lost.']));
  const sel = v.sel;
  const groups: Array<HTMLElement | null> = [];
  // what was assumed, then what follows from it
  groups.push(group(doc, 'Unavailable by assumption', run.picks.map((p) => { const l = pickLabel(m, p.ref); return pickItem(doc, 'obj:' + p.ref, sel, [el(doc, 'strong', {}, [l.id]), el(doc, 'span', { class: 'muted' }, [` — ${l.type}`])]); }), true, { id: 'oi-assumed' }));
  const prop = propagated(w);
  const pd = group(doc, 'Propagated effects', prop.map((x) => pickItem(doc, 'obj:' + x.ref, sel, [el(doc, 'span', { class: 'muted' }, [x.state + ': ']), refLabel(m, x.ref), x.why ? el(doc, 'div', { class: 'muted' }, [x.why]) : null], { 'data-state': x.state })), false, { id: 'oi-propagated' });
  if (pd && w.structural && w.structural.isolated.length) pd.insertBefore(el(doc, 'p', { class: 'small' }, [`Disconnected: ${w.structural.isolated.map((g) => g.join(', ')).join('; ')}`]), pd.childNodes[1]);
  groups.push(pd);
  for (const g of REQ_GROUPS) {
    const list = w.expectations.filter((x) => g.k.indexOf(x.change) >= 0);
    groups.push(group(doc, g.title, list.map((x) => reqItem(doc, x, sel)), g.open || list.some((x) => 'wexp:' + x.after.id === sel), { 'data-exp-group': g.k[0] }));
  }
  for (const g of DEP_GROUPS) {
    const list = w.deps.filter((d) => d.change === g.k);
    groups.push(group(doc, g.title, list.map((c) => pickItem(doc, 'dep:' + c.dep.key, sel, [el(doc, 'span', { class: 'muted' }, [DEP_LABEL[c.dep.kind] + ': ']), el(doc, 'button', { type: 'button', class: 'ref', 'data-goto': c.dep.consumerRef }, [c.dep.text]), el(doc, 'div', { class: 'muted' }, [c.text])])), g.open || list.some((c) => 'dep:' + c.dep.key === sel), { 'data-change': g.k }));
  }
  if (w.capacity && w.capacity.before.evaluated) {
    const list = w.capacity.changes.filter((y) => y.change !== 'unchanged');
    const items = list.map((x) => pickItem(doc, 'cap:' + x.demand.id, sel, [el(doc, 'strong', {}, [CAP_CHANGE_TEXT[x.change] + ': ']), x.demand.label, el(doc, 'div', { class: 'muted' }, [x.after.text])], { 'data-cap-change': x.change }));
    if (!items.length) items.push(el(doc, 'li', { class: 'muted' }, ['No demand changes: the stated traffic fits as it did.']));
    const d = el(doc, 'details', { class: 'wi-group', id: 'oi-capacity', open: '' }, [el(doc, 'summary', {}, [`Capacity under the outage: ${w.capacity.after.text}`]), el(doc, 'ul', { class: 'small' }, items)]);
    groups.push(d);
  }
  for (const g of groups) if (g) box.appendChild(g);
  if (w.reach) {
    const d = el(doc, 'details', { class: 'wi-group', open: '', id: 'oi-reach-res' }, [el(doc, 'summary', {}, [`Device pairs that lose reachability (${w.reach.pairs.length})`])]);
    const cov = coverageLine(doc, w.reach.coverage);
    if (run.reachRunning) {
      cov.textContent = `Checking device pairs: ${w.reach.coverage.checked} of ${w.reach.coverage.eligible}… `;
      const stop = el(doc, 'button', { type: 'button', class: 'mini', id: 'oi-stop' }, ['Stop']);
      stop.addEventListener('click', () => act.oiStop());
      cov.appendChild(stop);
    }
    cov.setAttribute('role', 'status');
    d.appendChild(cov);
    const ul = el(doc, 'ul', { class: 'small' });
    for (const p of w.reach.pairs.slice(0, 50)) ul.appendChild(pickItem(doc, `pair:${p.from}>${p.to}`, sel, [`${p.from} → ${p.to}${p.partial ? ' (some equal-cost paths)' : ''}: ${p.detail}`]));
    if (w.reach.pairs.length > 50) ul.appendChild(el(doc, 'li', { class: 'muted' }, [`… ${w.reach.pairs.length - 50} more (in the text export)`]));
    d.appendChild(ul);
    box.appendChild(d);
  }
  box.appendChild(limitsDetails(doc, w.info));
  return box;
}

function reqItem(doc: Document, x: ExpChange, sel: string): HTMLElement {
  const must = x.after.expect === 'blocked' ? 'must be blocked' : x.after.expect === 'available' ? 'must be available' : x.after.expect;
  return pickItem(doc, 'wexp:' + x.after.id, sel, [el(doc, 'strong', {}, [`${EXP_CHANGE_TEXT[x.change]}: `]), `${x.after.name} (${must}; without the outage ${x.before.verdict}, under it ${x.after.verdict})`], { class: 'v-' + x.after.verdict, 'data-exp-change': x.change });
}

// ------------------------------------------------------------ the evidence (right)

/** The evidence of an item of the outage's result: a component, a dependency, a requirement, a demand, a device pair. Always under the outage. */
export function outageEvidence(doc: Document, run: OutageRun, key: string, context: string): EvidenceView | null {
  const w = run.result;
  const m = run.model;
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  const dl = (before: string, after: string, more: Array<[string, string]> = []): HTMLElement => el(doc, 'dl', { class: 'trace-ends small' }, [el(doc, 'dt', {}, ['Without the outage']), el(doc, 'dd', {}, [before]), el(doc, 'dt', {}, ['Under the outage']), el(doc, 'dd', {}, [after]), ...more.flatMap(([k, v]) => [el(doc, 'dt', {}, [k]), el(doc, 'dd', {}, [v])])]);
  const res = w.result;
  if (kind === 'obj' && res) {
    const chosen = res.failed.indexOf(id) >= 0;
    const st = chosen ? 'down' : (propagated(w).find((x) => x.ref === id) || { state: '' }).state;
    if (!st) return null;
    const why = res.why.get(id) || '';
    return {
      kind: chosen ? 'Component assumed unavailable' : 'Propagated effect',
      title: refLabel(m, id),
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [chosen ? 'Part of the outage condition: unavailable by assumption, not a consequence.' : `A consequence of the outage as the failure analysis propagates it: ${why || st}.`])],
      evidence: [dl('Available (as configured)', `${st}${why && !chosen ? ' — ' + why : ''}`)],
      objects: /^(device|link|relation|iface|network):/.test(id) ? [{ ref: id, label: stripKind(id) }] : [],
      next: [],
    };
  }
  if (kind === 'dep') {
    const c = w.deps.find((x) => x.dep.key === id);
    if (!c) return null;
    const next: EvidenceAction[] = [];
    for (const o of c.dep.options) if (o.request) next.push({ id: 'communication', label: `Check ${o.text} without the outage`, why: 'Communication evaluates the configured architecture without this outage: its answer is the baseline, not the state under the outage (shown here)', ref: JSON.stringify(o.request) });
    const provider = c.dep.options.find((o) => !!o.provider && !run.picks.some((p) => p.ref === 'device:' + o.provider));
    if (provider) next.push({ id: 'outage-add', label: `Add ${provider.provider} to the outage`, why: 'Prepares a combined condition with this provider unavailable too (not analyzed until you ask)', ref: 'device:' + provider.provider });
    return {
      kind: 'Dependency',
      title: c.dep.text,
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [DEP_CHANGE_TEXT[c.change].replace('the failure', 'the outage') + ': ']), c.text]), el(doc, 'p', { class: 'small muted' }, [`When unavailable: ${c.dep.consequence}.`])],
      evidence: [dl(c.before.text, c.after.text, [['Options', c.dep.options.map((o) => o.text).join('; ') || '—']])],
      objects: [{ ref: c.dep.consumerRef, label: stripKind(c.dep.consumerRef) }].concat(c.dep.options.filter((o) => !!o.provider).map((o) => ({ ref: 'device:' + o.provider, label: o.provider as string }))),
      next,
    };
  }
  if (kind === 'wexp') {
    const x = w.expectations.find((y) => y.after.id === id);
    if (!x) return null;
    return {
      kind: 'Requirement',
      title: x.after.name,
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [EXP_CHANGE_TEXT[x.change].replace('the failure', 'the outage') + ': ']), x.after.reason])],
      evidence: [dl(`${x.before.verdict} — ${x.before.reason}`, `${x.after.verdict} — ${x.after.reason}`)],
      objects: x.after.refs.filter((r) => /^(device|iface|link|relation):/.test(r)).slice(0, 24).map((r) => ({ ref: r, label: stripKind(r) })),
      next: [{ id: 'requirement', label: 'Open in Design review (without the outage)', why: 'Design review evaluates the requirement as saved, without this outage', ref: x.after.id }],
    };
  }
  if (kind === 'cap' && w.capacity) {
    const x = w.capacity.changes.find((y) => y.demand.id === id);
    if (!x) return null;
    return {
      kind: 'Demand',
      title: x.demand.label,
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [el(doc, 'strong', {}, [CAP_CHANGE_TEXT[x.change] + ': ']), `${bpsText(x.demand.bps)} stated, ${x.demand.from} → ${x.demand.to}`])],
      evidence: [dl(x.before.text, x.after.text)],
      objects: [x.demand.from, x.demand.to].filter((d) => !!d && d.indexOf('/') < 0).map((d) => ({ ref: 'device:' + d.split(':')[0], label: d })),
      next: [],
    };
  }
  if (kind === 'pair' && w.reach) {
    const [a, b] = id.split('>');
    const p = w.reach.pairs.find((y) => y.from === a && y.to === b);
    if (!p) return null;
    return {
      kind: 'Device pair',
      title: `${a} → ${b}`,
      context,
      explanation: [el(doc, 'p', { class: 'small' }, [p.partial ? 'Some of its equal-cost paths are lost under the outage; others remain.' : 'Reachable without the outage; not under it.'])],
      evidence: [dl('Reachable', p.detail)],
      objects: [{ ref: 'device:' + a, label: a }, { ref: 'device:' + b, label: b }],
      next: [{ id: 'communication', label: 'Check it without the outage', why: 'Communication evaluates the configured architecture without this outage', ref: JSON.stringify({ from: a, to: b }) }],
    };
  }
  return null;
}

/** An outage analysis as text. */
export function outageText(o: { title: string; version?: string; outdated: boolean }, run: OutageRun): string {
  const w = run.result;
  const m = run.model;
  const lines = exportHeader({ analysis: 'Resilience: outage impact', title: o.title, info: w.info, version: o.version, outdated: o.outdated });
  lines.push('Assume unavailable:');
  for (const p of run.picks) {
    const l = pickLabel(m, p.ref);
    const from = p.via.filter((x) => !!x).map((x) => viaLabel(m, x));
    lines.push(`  ${l.id} — ${l.type}${l.detail ? ' · ' + l.detail : ''}${from.length ? ` (from ${from.join(', ')})` : ''}`);
  }
  if (w.unknown.length) lines.push(`Not in the model: ${w.unknown.join(', ')}`);
  lines.push('', 'Compared with the same configured architecture without this outage:');
  if (w.result) for (const l of outageSummary(m, run)) lines.push(`  ${l}`);
  else lines.push(`  ${w.info.limits[w.info.limits.length - 1] || 'Nothing was evaluated.'}`);
  const prop = propagated(w);
  if (prop.length) {
    lines.push('', `Propagated effects (${prop.length}):`);
    for (const x of prop) lines.push(`  ${x.state}: ${refLabel(m, x.ref)}${x.why ? ' — ' + x.why : ''}`);
  }
  if (w.structural && w.structural.isolated.length) lines.push(`Disconnected: ${w.structural.isolated.map((g) => g.join(', ')).join('; ')}`);
  for (const g of REQ_GROUPS) {
    const list = w.expectations.filter((x) => g.k.indexOf(x.change) >= 0);
    if (!list.length) continue;
    lines.push('', `${g.title} (${list.length}):`);
    for (const x of list) lines.push(`  ${x.after.name} (${x.after.expect}): without the outage ${x.before.verdict}, under it ${x.after.verdict} — ${x.after.reason}`);
  }
  for (const g of DEP_GROUPS) {
    const list = w.deps.filter((d) => d.change === g.k);
    if (!list.length) continue;
    lines.push('', `${g.title} (${list.length}):`);
    for (const c of list) lines.push(`  ${DEP_LABEL[c.dep.kind]}: ${c.dep.text} — ${c.text}`);
  }
  if (w.capacity && w.capacity.before.evaluated) {
    lines.push('', `Capacity: ${w.capacity.after.text}`);
    for (const x of w.capacity.changes.filter((y) => y.change !== 'unchanged')) lines.push(`  ${CAP_CHANGE_TEXT[x.change]}: ${x.demand.label} — ${x.after.text}`);
  }
  if (w.reach) {
    lines.push('', `Device pairs that lose reachability (${w.reach.pairs.length}); ${coverageText(w.reach.coverage)}:`);
    for (const p of w.reach.pairs) lines.push(`  ${p.from} → ${p.to}${p.partial ? ' (some equal-cost paths)' : ''}: ${p.detail}`);
  }
  lines.push('');
  for (const l of exportFooter(w.info)) lines.push(l);
  return lines.join('\n') + '\n';
}

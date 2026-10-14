/**
 * The command palette (Ctrl+K, Cmd+K on macOS): one search field over every
 * command of the registry (menus, toolbar, analysis modes, with their
 * shortcuts; unavailable ones disabled, with the reason) and every object of
 * the model (devices, interfaces, links, networks, relations, routes,
 * groups). Fuzzy matching; the recently used entries first. The matching
 * and ranking are pure functions; the dialog body is built from elements
 * and text nodes only.
 */
import { routeLine } from '../model/addresses';
import { lookupProtocol } from '../model/protocols';
import { Model, deviceInterfaces, relationDevices } from '../model/types';
import { serviceWords } from '../model/queries';
import { Command, CommandState, keyLabel } from './commands';
import { el } from './dom';

export interface PaletteItem {
  /** "cmd:<id>" or "ref:<object ref>" */
  key: string;
  kind: 'command' | 'object';
  label: string;
  /** the group of a command, the kind of an object ("device", "network" …) */
  sub: string;
  /** the shortcut, as written */
  keys: string;
  /** what the matching looks at besides the label */
  words: string;
  state: CommandState;
  mode: boolean;
}

/**
 * How well a query matches a text (null: it doesn't). Every word of the
 * query must occur in the text: as a substring (best at the start of a word)
 * or else as a subsequence (its letters in order; better when they follow
 * each other or start words). Case is ignored.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter((w) => !!w);
  if (!words.length) return 0;
  const t = text.toLowerCase();
  const startAt = (i: number): boolean => i === 0 || !/[a-z0-9]/.test(t.charAt(i - 1));
  let total = 0;
  for (const w of words) {
    const at = t.indexOf(w);
    if (at >= 0) {
      // the earliest occurrence at a word start, if there is one
      let best = at;
      for (let i = at; i >= 0; i = t.indexOf(w, i + 1)) {
        if (startAt(i)) {
          best = i;
          break;
        }
      }
      total += 100 + (startAt(best) ? 40 : 0) + (best === 0 ? 20 : 0) - Math.min(best, 30);
      continue;
    }
    // a subsequence, from left to right
    let pos = -1;
    let score = 40;
    let prev = -2;
    for (const ch of w) {
      const i = t.indexOf(ch, pos + 1);
      if (i < 0) return null;
      score += i === prev + 1 ? 4 : startAt(i) ? 3 : -Math.min(i - pos - 1, 5);
      prev = i;
      pos = i;
    }
    total += score;
  }
  // shorter texts first among equals
  return total - Math.min(t.length, 120) / 40;
}

/** The objects the palette can select, in a stable order (by kind, then id). */
export function objectItems(model: Model): PaletteItem[] {
  const out: PaletteItem[] = [];
  const ok: CommandState = { enabled: true };
  const add = (ref: string, label: string, sub: string, words: string): void => {
    out.push({ key: 'ref:' + ref, kind: 'object', label, sub, keys: '', words, state: ok, mode: false });
  };
  const byId = <T extends { id: string }>(xs: T[]): T[] => xs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const d of byId(model.devices)) {
    const layer = d.type === 'switch' ? (d.layer3 ? 'Layer 3 switch' : 'Layer 2 switch') : '';
    add('device:' + d.id, d.label && d.label !== d.id ? `${d.label} (${d.id})` : d.id, layer || 'device', `${d.type} ${layer} ${layer ? (d.layer3 ? 'l3' : 'l2') : ''} ${d.group || ''} ${serviceWords(model, d).join(' ')}`);
  }
  for (const d of byId(model.devices)) {
    for (const i of byId(deviceInterfaces(d))) {
      const svc = i.services.map((s) => `${s.id} ${Array.from(s.values.values()).join(' ')}`).join(' ');
      add(`iface:${d.id}:${i.id}`, `${d.id}:${i.id}`, 'interface', `${i.label || ''} ${i.addresses.join(' ')} ${i.vrf || ''} ${i.type} ${svc}`);
    }
  }
  for (const l of byId(model.links)) add('link:' + l.id, `${l.id}: ${l.a.device}${l.a.iface ? ':' + l.a.iface : ''} – ${l.b.device}${l.b.iface ? ':' + l.b.iface : ''}`, 'link', `${l.label || ''} ${l.cable || ''} ${l.medium || ''} ${l.speed || ''} cable`);
  for (const n of byId(model.networks)) add('network:' + n.id, n.label && n.label !== n.id ? `${n.label} (${n.id})` : n.id, 'network', `${n.cidr || ''} ${n.vlan !== undefined ? 'vlan ' + n.vlan : ''}`);
  for (const r of byId(model.relations)) {
    const p = lookupProtocol(model.protocols, r.protocol, r.category);
    add('relation:' + r.id, `${p.label} ${r.label || r.id}: ${relationDevices(r).join(' – ')}`, 'relation', `${r.id} ${r.protocol} ${r.category}`);
  }
  for (const d of byId(model.devices)) {
    for (const r of d.routes) add(`route:${d.id}:${r.index}`, `${d.id}: ${routeLine(r)}`, 'route', `route ${r.name || ''} ${r.vrf || ''}`);
  }
  for (const g of byId(model.groups)) add('group:' + g.id, g.label && g.label !== g.id ? `${g.label} (${g.id})` : g.id, 'group', `${g.kind || ''} location`);
  return out;
}

/** The commands as palette entries, with their state now. */
export function commandItems(commands: Command[], stateOf: (c: Command) => CommandState, mac = false): PaletteItem[] {
  return commands.map((c) => ({ key: 'cmd:' + c.id, kind: 'command', label: c.label, sub: c.group, keys: keyLabel(c.keys, mac), words: c.keywords || '', state: stateOf(c), mode: !!c.mode }));
}

/** At most this many results are listed (the rest: keep typing). */
export const PALETTE_LIMIT = 60;

/**
 * The results for a query. Without one: the recent entries, then every
 * command (objects only when searched for). With one: everything that
 * matches, best first; on a tie, recent entries, then commands, then
 * objects, then by label.
 */
export function rankItems(items: PaletteItem[], query: string, recent: string[]): { items: Array<PaletteItem & { recent: boolean }>; more: number } {
  const q = query.trim();
  const rec = new Map(recent.map((k, i) => [k, i] as [string, number]));
  if (!q) {
    const byKey = new Map(items.map((x) => [x.key, x] as [string, PaletteItem]));
    const first = recent.map((k) => byKey.get(k)).filter((x): x is PaletteItem => !!x).map((x) => ({ ...x, recent: true }));
    const cmds = items.filter((x) => x.kind === 'command' && !rec.has(x.key)).map((x) => ({ ...x, recent: false }));
    const all = first.concat(cmds);
    return { items: all.slice(0, PALETTE_LIMIT), more: Math.max(0, all.length - PALETTE_LIMIT) };
  }
  const scored: Array<{ x: PaletteItem; s: number }> = [];
  for (const x of items) {
    const a = fuzzyScore(q, x.label);
    const b = fuzzyScore(q, `${x.label} ${x.sub} ${x.words} ${x.keys}`);
    const s = a !== null ? a + 10 : b;
    if (s === null) continue;
    scored.push({ x, s: s + (rec.has(x.key) ? 15 - (rec.get(x.key) as number) : 0) });
  }
  scored.sort((p, r) => r.s - p.s || (p.x.kind === r.x.kind ? 0 : p.x.kind === 'command' ? -1 : 1) || (p.x.label < r.x.label ? -1 : p.x.label > r.x.label ? 1 : 0));
  const all = scored.map((y) => ({ ...y.x, recent: rec.has(y.x.key) }));
  return { items: all.slice(0, PALETTE_LIMIT), more: Math.max(0, all.length - PALETTE_LIMIT) };
}

/** What the screen reader hears after each change of the results. */
export function resultsText(n: number, more: number, query: string): string {
  if (!n) return query.trim() ? 'No results.' : 'No commands.';
  return `${n}${more ? '+' : ''} result${n === 1 && !more ? '' : 's'}.`;
}

/** The listbox for a ranked list; `active` is the index of the highlighted option. */
export function paletteList(doc: Document, ranked: { items: Array<PaletteItem & { recent: boolean }>; more: number }, active: number, query: string): HTMLElement {
  const ul = el(doc, 'ul', { id: 'palette-list', class: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
  let heading = '';
  ranked.items.forEach((x, i) => {
    const h = !query.trim() ? (x.recent ? 'Recent' : 'Commands') : '';
    if (h && h !== heading) {
      heading = h;
      ul.appendChild(el(doc, 'li', { class: 'pal-head', role: 'presentation' }, [h]));
    }
    const disabled = !x.state.enabled;
    ul.appendChild(
      el(
        doc,
        'li',
        {
          id: 'palette-opt-' + i,
          class: 'pal-opt' + (i === active ? ' active' : '') + (disabled ? ' disabled' : ''),
          role: 'option',
          'aria-selected': i === active ? 'true' : 'false',
          'aria-disabled': disabled ? 'true' : 'false',
          'data-pal': x.key,
          'data-index': String(i),
        },
        [
          el(doc, 'span', { class: 'pal-main' }, [
            el(doc, 'span', { class: 'pal-label' }, [x.label]),
            el(doc, 'span', { class: 'pal-sub' }, [x.kind === 'object' ? x.sub : x.mode ? x.sub + ' · mode' : x.sub]),
            x.state.checked !== undefined ? el(doc, 'span', { class: 'pal-sub' }, [x.state.checked ? ' · on' : ' · off']) : null,
          ]),
          x.keys ? el(doc, 'kbd', { class: 'pal-keys' }, [x.keys]) : null,
          disabled && x.state.reason ? el(doc, 'span', { class: 'pal-reason' }, ['Unavailable: ' + x.state.reason]) : null,
        ],
      ),
    );
  });
  if (!ranked.items.length) ul.appendChild(el(doc, 'li', { class: 'pal-none', role: 'presentation' }, [query.trim() ? 'Nothing matches. Try fewer letters, or a part of a name, address or id.' : 'No commands.']));
  if (ranked.more) ul.appendChild(el(doc, 'li', { class: 'pal-none', role: 'presentation' }, [`${ranked.more} more: keep typing to narrow the list.`]));
  return ul;
}

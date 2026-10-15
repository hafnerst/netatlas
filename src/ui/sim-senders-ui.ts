/**
 * Senders: which devices the protocol simulation shows as sending (the Start
 * dialog's and the Simulation setup panel's section). A disclosure button
 * whose name sums the choice up ("Senders (3 of 23): hq-rtr1, muc-rtr,
 * client-1…"), and under it a filter box, the quick actions (All, None,
 * Selected in diagram, By type ▾, By group / site ▾) and a checklist of the
 * devices grouped by type or by group / site (the user switches between the
 * two), each with its type's icon, its name and, for a switch, its L2 / L3
 * badge. Every group folds and says how many of its devices are chosen
 * ("Routers (2 of 5)"). Nothing here changes the model; the simulation
 * decides what the choice means (sim-controller.ts).
 */
import { DEVICE_TYPES, deviceTypeLabel } from '../model/device-types';
import { Model } from '../model/types';
import { deviceIcon } from '../diagram/icons';
import { el, materialize } from './dom';

export interface SendersPickerOpts {
  /** a prefix for the element ids */
  id: string;
  model: Model;
  /** the devices chosen at first */
  selected: Set<string>;
  /** open at first (the dialog: open; the panel: collapsed) */
  open: boolean;
  /** the devices the diagram's selection stands for (Selected in diagram); empty: none */
  diagram: () => Set<string>;
  /** the choice changed */
  onChange?: (selected: Set<string>) => void;
}

export interface SendersPicker {
  el: HTMLElement;
  selected(): Set<string>;
  set(s: Set<string>): void;
  /** "Senders (3 of 23): hq-rtr1, muc-rtr, client-1…" */
  summary(): string;
}

/** Plural names of the device types, for the groups' headings. */
function plural(label: string): string {
  if (/s$/.test(label)) return label;
  if (/(ch|sh|x)$/.test(label)) return label + 'es';
  if (/[^aeiou]y$/.test(label)) return label.slice(0, -1) + 'ies';
  return label + 's';
}

/** The summary of a choice: its count and its first names. */
export function sendersSummary(model: Model, sel: Set<string>): string {
  const all = model.devices.length;
  const chosen = model.devices.filter((d) => sel.has(d.id)).sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
  if (chosen.length === all) return `Senders (all ${all})`;
  if (!chosen.length) return `Senders (0 of ${all}): none`;
  const names = chosen.slice(0, 3).map((d) => d.label);
  return `Senders (${chosen.length} of ${all}): ${names.join(', ')}${chosen.length > 3 ? '…' : ''}`;
}

export function sendersPicker(doc: Document, o: SendersPickerOpts): SendersPicker {
  const m = o.model;
  const sel = new Set(Array.from(o.selected).filter((id) => m.index.devices.has(id)));
  let by: 'type' | 'group' = 'type';
  const folded = new Set<string>();
  const bodyId = o.id + '-body';
  const toggle = el(doc, 'button', { type: 'button', class: 'sp-toggle snd-toggle', id: o.id + '-toggle', 'aria-expanded': o.open ? 'true' : 'false', 'aria-controls': bodyId }, [el(doc, 'span', { class: 'psec-caret', 'aria-hidden': 'true' }, ['▸']), el(doc, 'span', { class: 'snd-sum' }, [''])]);
  const find = el(doc, 'input', { type: 'search', id: o.id + '-find', class: 'snd-find', placeholder: 'Filter devices…', 'aria-label': 'Filter the senders list', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const btn = (label: string, id: string, extra: { [k: string]: string } = {}): HTMLButtonElement => el(doc, 'button', { type: 'button', class: 'mini', id: o.id + '-' + id, ...extra }, [label]) as HTMLButtonElement;
  const all = btn('All', 'all');
  const none = btn('None', 'none');
  const inDiagram = btn('Selected in diagram', 'diagram');
  const byType = btn('By type ▾', 'bytype', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const byGroup = btn('By group / site ▾', 'bygroup', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const gType = el(doc, 'button', { type: 'button', class: 'mini snd-by', 'aria-pressed': 'true', id: o.id + '-gtype' }, ['Type']) as HTMLButtonElement;
  const gGroup = el(doc, 'button', { type: 'button', class: 'mini snd-by', 'aria-pressed': 'false', id: o.id + '-ggroup' }, ['Group / site']) as HTMLButtonElement;
  const list = el(doc, 'div', { class: 'snd-list', id: o.id + '-list', role: 'group', 'aria-label': 'Senders' });
  const menu = el(doc, 'div', { class: 'dropdown menu snd-menu', role: 'menu', hidden: '' });
  const body = el(doc, 'div', { class: 'snd-body', id: bodyId }, [
    find,
    el(doc, 'div', { class: 'snd-tools', role: 'group', 'aria-label': 'Choose senders' }, [all, none, inDiagram, byType, byGroup, menu]),
    el(doc, 'div', { class: 'snd-tools snd-groupby', role: 'group', 'aria-label': 'Group the list by' }, [el(doc, 'span', { class: 'muted small' }, ['Group by']), gType, gGroup]),
    list,
  ]);
  body.hidden = !o.open;
  const root = el(doc, 'section', { class: 'snd', id: o.id, 'aria-labelledby': toggle.id }, [el(doc, 'h3', { class: 'snd-head' }, [toggle]), body]);

  const groupLabel = (gid: string | undefined): string => {
    if (!gid) return 'No group';
    const g = m.groups.find((x) => x.id === gid);
    return g ? g.label : gid;
  };
  const groupsOf = (): Array<{ key: string; label: string; ids: string[] }> => {
    const out: Array<{ key: string; label: string; ids: string[] }> = [];
    if (by === 'type') {
      for (const t of DEVICE_TYPES) {
        const ds = m.devices.filter((d) => d.type === t.id);
        if (ds.length) out.push({ key: 'type:' + t.id, label: plural(t.label), ids: ds.map((d) => d.id) });
      }
      const other = m.devices.filter((d) => !DEVICE_TYPES.some((t) => t.id === d.type));
      if (other.length) out.push({ key: 'type:', label: 'Other devices', ids: other.map((d) => d.id) });
    } else {
      const keys = Array.from(new Set(m.devices.map((d) => d.group || ''))).sort((a, b) => (!a ? 1 : !b ? -1 : groupLabel(a).toLowerCase() < groupLabel(b).toLowerCase() ? -1 : 1));
      for (const k of keys) out.push({ key: 'group:' + k, label: groupLabel(k || undefined), ids: m.devices.filter((d) => (d.group || '') === k).map((d) => d.id) });
    }
    for (const g of out) g.ids.sort((a, b) => {
      const la = (m.index.devices.get(a) as { label: string }).label.toLowerCase();
      const lb = (m.index.devices.get(b) as { label: string }).label.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return out;
  };

  const render = (): void => {
    const q = find.value.trim().toLowerCase();
    const keep = list.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).getAttribute('data-sender') || (doc.activeElement as HTMLElement).getAttribute('data-fold') : null;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const g of groupsOf()) {
      const ids = g.ids.filter((id) => {
        const d = m.index.devices.get(id) as { id: string; label: string };
        return !q || d.label.toLowerCase().indexOf(q) >= 0 || d.id.toLowerCase().indexOf(q) >= 0;
      });
      if (!ids.length) continue;
      const n = g.ids.filter((id) => sel.has(id)).length;
      const open = !folded.has(g.key) || !!q;
      const gid = `${o.id}-g-${g.key.replace(/[^a-z0-9]/gi, '_')}`;
      const fold = el(doc, 'button', { type: 'button', class: 'snd-fold', 'data-fold': g.key, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': gid }, [el(doc, 'span', { class: 'psec-caret', 'aria-hidden': 'true' }, ['▸']), `${g.label} (${n} of ${g.ids.length})`]);
      const items = el(doc, 'div', { class: 'snd-items', id: gid, role: 'group', 'aria-label': g.label });
      items.hidden = !open;
      for (const id of ids) {
        const d = m.index.devices.get(id) as { id: string; label: string; type: string; layer3?: boolean };
        const cb = el(doc, 'input', { type: 'checkbox', 'data-sender': id, id: `${o.id}-d-${id.replace(/[^a-z0-9-]/gi, '_')}` }) as HTMLInputElement;
        cb.checked = sel.has(id);
        const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('width', '16');
        icon.setAttribute('height', '16');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('class', 'snd-icon');
        icon.appendChild(materialize(deviceIcon(d.type, 0, 0, 24, d.layer3), doc, true));
        items.appendChild(
          el(doc, 'label', { class: 'snd-item', for: cb.id, title: `${d.label} (${d.id}) · ${deviceTypeLabel(d.type) || 'no type'}` }, [
            cb,
            icon,
            el(doc, 'span', { class: 'snd-name' }, [d.label]),
            d.type === 'switch' ? el(doc, 'span', { class: 'snd-badge ' + (d.layer3 ? 'l3' : 'l2') }, [d.layer3 ? 'L3' : 'L2']) : null,
          ]),
        );
      }
      list.appendChild(el(doc, 'div', { class: 'snd-group', 'data-group': g.key }, [fold, items]));
    }
    if (!list.firstChild) list.appendChild(el(doc, 'p', { class: 'muted small' }, ['No device matches.']));
    if (keep) {
      const again = list.querySelector(`[data-sender="${keep}"], [data-fold="${keep}"]`) as HTMLElement | null;
      if (again) again.focus();
    }
    sync();
  };

  const sync = (): void => {
    const s = sendersSummary(m, sel);
    (toggle.querySelector('.snd-sum') as HTMLElement).textContent = s;
    all.disabled = sel.size === m.devices.length;
    none.disabled = sel.size === 0;
    inDiagram.disabled = o.diagram().size === 0;
  };

  const changed = (): void => {
    render();
    if (o.onChange) o.onChange(new Set(sel));
  };
  const setTo = (ids: Iterable<string>): void => {
    sel.clear();
    for (const id of ids) if (m.index.devices.has(id)) sel.add(id);
    changed();
  };

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    if (open) sync();
  });
  find.addEventListener('input', render);
  list.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const id = t.getAttribute('data-sender');
    if (!id) return;
    if (t.checked) sel.add(id);
    else sel.delete(id);
    changed();
  });
  list.addEventListener('click', (e) => {
    const f = (e.target as Element).closest('[data-fold]');
    if (!f) return;
    const k = f.getAttribute('data-fold') as string;
    if (folded.has(k)) folded.delete(k);
    else folded.add(k);
    render();
  });
  all.addEventListener('click', () => setTo(m.devices.map((d) => d.id)));
  none.addEventListener('click', () => setTo([]));
  inDiagram.addEventListener('click', () => setTo(o.diagram()));
  const pickBy = (b: HTMLButtonElement): void => {
    b.setAttribute('aria-expanded', 'true');
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    const save = by;
    by = b === byType ? 'type' : 'group';
    const gs = groupsOf();
    by = save;
    for (const g of gs) {
      const item = el(doc, 'button', { type: 'button', role: 'menuitem', class: 'snd-menuitem' }, [`${g.label} (${g.ids.length})`]);
      item.addEventListener('click', () => {
        close();
        setTo(g.ids);
        b.focus();
      });
      menu.appendChild(item);
    }
    menu.hidden = false;
    const r = b.getBoundingClientRect();
    const pr = (menu.offsetParent || body).getBoundingClientRect();
    menu.style.left = Math.max(0, r.left - pr.left) + 'px';
    menu.style.top = r.bottom - pr.top + 2 + 'px';
    (menu.querySelector('button') as HTMLElement).focus();
  };
  const close = (): void => {
    menu.hidden = true;
    byType.setAttribute('aria-expanded', 'false');
    byGroup.setAttribute('aria-expanded', 'false');
  };
  byType.addEventListener('click', () => (menu.hidden ? pickBy(byType) : close()));
  byGroup.addEventListener('click', () => (menu.hidden ? pickBy(byGroup) : close()));
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('button')) as HTMLElement[];
    const i = items.indexOf(doc.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const opener = byType.getAttribute('aria-expanded') === 'true' ? byType : byGroup;
      close();
      opener.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Tab') close();
  });
  doc.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== byType && e.target !== byGroup) close();
  });
  const groupBy = (b: 'type' | 'group'): void => {
    by = b;
    gType.setAttribute('aria-pressed', b === 'type' ? 'true' : 'false');
    gGroup.setAttribute('aria-pressed', b === 'group' ? 'true' : 'false');
    render();
  };
  gType.addEventListener('click', () => groupBy('type'));
  gGroup.addEventListener('click', () => groupBy('group'));
  render();
  return {
    el: root,
    selected: () => new Set(sel),
    set(s) {
      sel.clear();
      for (const id of s) if (m.index.devices.has(id)) sel.add(id);
      render();
    },
    summary: () => sendersSummary(m, sel),
  };
}

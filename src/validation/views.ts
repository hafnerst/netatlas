/**
 * The model's saved views (`views:`, model/views.ts): their syntax, and
 * the objects they name (a device or focus target that names nothing is a
 * warning: opening the view leaves it out).
 */
import { DEVICE_TYPES, typeKeysOf } from '../model/device-types';
import { MAX_VIEWS, SavedFocus, SavedView, VIEW_CONTEXTS, VIEW_FOCUS_KEYS, VIEW_KEYS, VIEW_OPTION_KEYS, VIEW_VIEWPORT_KEYS } from '../model/views';
import { Model, ifaceKey } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { Ctx, ID_RE, Reader, get, scalarText } from './reader';

/** The ref a focus target names ("device:sw", "iface:sw:p1", "network:lan" …), or null. */
export function focusRef(model: Model, t: string): string | null {
  const k = t.indexOf(':');
  if (k > 0 && ['network', 'group', 'link', 'relation', 'device'].indexOf(t.slice(0, k)) >= 0) {
    const kind = t.slice(0, k);
    const id = t.slice(k + 1);
    const idx = kind === 'network' ? model.index.networks : kind === 'group' ? model.index.groups : kind === 'link' ? model.index.links : kind === 'relation' ? model.index.relations : model.index.devices;
    return idx.has(id) ? kind + ':' + id : null;
  }
  if (model.index.devices.has(t)) return 'device:' + t;
  if (k > 0 && model.index.interfaces.has(ifaceKey(t.slice(0, k), t.slice(k + 1)))) return 'iface:' + t;
  if (model.index.networks.has(t)) return 'network:' + t;
  if (model.index.groups.has(t)) return 'group:' + t;
  if (model.index.links.has(t)) return 'link:' + t;
  return null;
}

export function readViews(r: Reader, c: Ctx, top: YMap, model: Model): SavedView[] {
  const out: SavedView[] = [];
  const seen = new Map<string, number>();
  const items = r.list(get(top, 'views'), 'views');
  if (items.length > MAX_VIEWS) c.error(items[MAX_VIEWS], 'views', `too many saved views: ${items.length} (limit ${MAX_VIEWS})`);
  const typeKeys = new Set<string>();
  for (const d of DEVICE_TYPES) for (const k of typeKeysOf(d.id)) typeKeys.add(k);
  items.slice(0, MAX_VIEWS).forEach((n, i) => {
    const path = `views[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, VIEW_KEYS, path);
    const id = r.id(m, path, ID_RE, 'view id');
    if (!id) return;
    const vp = 'views.' + id;
    if (seen.has(id)) {
      c.error(get(m, 'id') as YNode, vp + '.id', `duplicate view id "${id}" (already used on line ${seen.get(id)})`);
      return;
    }
    seen.set(id, m.line);
    const name = r.field(m, 'name', vp, 200);
    if (!name || !name.trim()) c.error(get(m, 'name') || m, vp + '.name', 'a saved view needs a readable name', get(m, 'name') ? {} : { key: 'name' });
    const view = r.field(m, 'view', vp, 20);
    if (view !== 'physical' && view !== 'logical') c.error(get(m, 'view') || m, vp + '.view', view === undefined ? 'a saved view needs its diagram: physical or logical' : `"${view}" is no diagram: physical or logical`, get(m, 'view') ? {} : { key: 'view' });
    const v: SavedView = { id, name: (name || id).trim(), view: view === 'logical' ? 'logical' : 'physical', hideTypes: [], hideProtocols: [], options: {}, line: m.line };
    const desc = r.field(m, 'description', vp, 2000);
    if (desc !== undefined) v.description = desc;
    // the focus
    const fn = get(m, 'focus');
    if (fn) {
      const fm = r.map(fn, vp + '.focus');
      if (fm) {
        r.keys(fm, VIEW_FOCUS_KEYS, vp + '.focus');
        const target = r.field(fm, 'target', vp + '.focus', 200);
        if (!target) c.error(get(fm, 'target') || fm, vp + '.focus.target', 'a focus needs its target (a device, device:interface, network:…, group:…)', get(fm, 'target') ? {} : { key: 'target' });
        else {
          const f: SavedFocus = { target };
          if (!focusRef(model, target)) c.warn(get(fm, 'target') as YNode, vp + '.focus.target', `"${target}" is nothing of the model: the view opens without its focus`);
          const hops = r.int(get(fm, 'hops'), vp + '.focus.hops', 1, 3, 'hops');
          if (hops !== undefined) f.hops = hops;
          const ctx = r.field(fm, 'context', vp + '.focus', 20);
          if (ctx !== undefined) {
            if (VIEW_CONTEXTS.indexOf(ctx as SavedFocus['context']) < 0) c.error(get(fm, 'context') as YNode, vp + '.focus.context', `"${ctx}" is no contextual focus: ${VIEW_CONTEXTS.join(', ')}`);
            else f.context = ctx as SavedFocus['context'];
            if (hops !== undefined) c.error(get(fm, 'hops') as YNode, vp + '.focus.hops', 'a contextual focus has no hops');
          }
          if (get(fm, 'vlan')) {
            const vl = r.vlanId(get(fm, 'vlan'), vp + '.focus.vlan');
            if (vl !== undefined) f.vlan = vl;
          }
          const g = r.field(fm, 'group', vp + '.focus', 64);
          if (g !== undefined) f.group = g;
          if (f.context === 'vlan' && f.vlan === undefined) c.error(fm, vp + '.focus.vlan', 'a VLAN focus needs its VLAN', { key: 'vlan' });
          if (f.context === 'multicast' && !f.group) c.error(fm, vp + '.focus.group', 'a multicast focus needs its group', { key: 'group' });
          v.focus = f;
        }
      }
    }
    // the filters
    const dn = get(m, 'devices');
    if (dn) {
      v.devices = [];
      for (const x of r.list(dn, vp + '.devices')) {
        const t = scalarText(x);
        if (t === undefined) continue;
        if (!model.index.devices.has(t)) c.warn(x, vp + '.devices', `"${t}" is no device of the model: the view leaves it out`);
        else v.devices.push(t);
      }
    }
    for (const x of r.list(get(m, 'hide_types'), vp + '.hide_types')) {
      const t = scalarText(x);
      if (t === undefined) continue;
      // a type stands for each of its kinds (switch: switch:l2 and switch:l3)
      const keys = DEVICE_TYPES.some((d) => d.id === t) ? typeKeysOf(t) : typeKeys.has(t) ? [t] : [];
      if (!keys.length) c.error(x, vp + '.hide_types', `"${t}" is no device type (e.g. server, switch, switch:l2)`);
      for (const k of keys) if (v.hideTypes.indexOf(k) < 0) v.hideTypes.push(k);
    }
    for (const x of r.list(get(m, 'hide_protocols'), vp + '.hide_protocols')) {
      const t = scalarText(x);
      if (t !== undefined) v.hideProtocols.push(t);
    }
    const on = get(m, 'options');
    if (on) {
      const om = r.map(on, vp + '.options');
      if (om) {
        r.keys(om, VIEW_OPTION_KEYS, vp + '.options');
        for (const k of VIEW_OPTION_KEYS) {
          const b = r.bool(get(om, k), `${vp}.options.${k}`);
          if (b !== undefined) (v.options as { [k: string]: boolean })[k] = b;
        }
      }
    }
    const pn = get(m, 'viewport');
    if (pn) {
      const pm = r.map(pn, vp + '.viewport');
      if (pm) {
        r.keys(pm, VIEW_VIEWPORT_KEYS, vp + '.viewport');
        const num = (k: string, min: number, max: number): number | undefined => {
          const t = r.field(pm, k, vp + '.viewport', 20);
          if (t === undefined) {
            c.error(pm, `${vp}.viewport.${k}`, `a viewport needs ${k}`, { key: k });
            return undefined;
          }
          const x = Number(t);
          if (!isFinite(x) || x < min || x > max) {
            c.error(get(pm, k) as YNode, `${vp}.viewport.${k}`, `"${t}" is no ${k === 'zoom' ? 'zoom (0.05 to 6)' : 'position'}`);
            return undefined;
          }
          return x;
        };
        const x = num('x', -1e7, 1e7);
        const y = num('y', -1e7, 1e7);
        const z = num('zoom', 0.05, 6);
        if (x !== undefined && y !== undefined && z !== undefined) v.viewport = { x, y, zoom: z };
      }
    }
    out.push(v);
  });
  return out;
}

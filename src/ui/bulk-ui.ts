/**
 * The Bulk edit ports window: a device's ports to tick, one VLAN operation
 * and its values, the preview (each port before and after, and what is
 * left as it is and why), and Apply — one undo step for every port. Nothing
 * changes before Apply.
 */
import { BulkOp, PortPlanRow, portText, portVlanIds } from '../model/bulk-ports';
import { Device } from '../model/types';
import { el } from './dom';

export interface BulkActions {
  plan(ports: string[], op: BulkOp): PortPlanRow[];
  apply(ports: string[], op: BulkOp): void;
}

/** "10, 20, 30-39" → the IDs, or an error text. */
export function parseVlanList(t: string): number[] | string {
  const out: number[] = [];
  for (const part of t.split(/[\s,]+/).filter((x) => x)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return `"${part}" is no VLAN ID or range`;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || b < a) return `"${part}" is outside 1–4094`;
    for (let v = a; v <= b; v++) if (out.indexOf(v) < 0) out.push(v);
  }
  return out.length ? out.sort((x, y) => x - y) : 'name at least one VLAN';
}

export function bulkBody(doc: Document, dev: Device, locked: string, act: BulkActions): HTMLElement {
  const box = el(doc, 'div', { class: 'bulk-win' });
  const ports = dev.interfaces.filter((i) => !i.routed && !(i.type === 'virtual' && i.vlan !== undefined));
  box.appendChild(el(doc, 'p', { class: 'muted small' }, [`One VLAN change on several ports of ${dev.id}. The preview shows each port before and after; nothing changes before Apply, and Ctrl+Z undoes all of it at once.`]));
  // the ports
  const list = el(doc, 'fieldset', { class: 'bulk-ports' }, [el(doc, 'legend', {}, [`Ports (${ports.length})`])]);
  const all = el(doc, 'button', { type: 'button', class: 'link', id: 'bulk-all' }, ['Select all']);
  const none = el(doc, 'button', { type: 'button', class: 'link', id: 'bulk-none' }, ['Clear']);
  list.appendChild(el(doc, 'div', { class: 'helpers' }, [all, none]));
  const grid = el(doc, 'div', { class: 'bulk-grid' });
  const boxes: HTMLInputElement[] = [];
  for (const i of ports) {
    const cb = el(doc, 'input', { type: 'checkbox', 'data-bulk-port': i.id, id: `bulk-p-${i.id}` }) as HTMLInputElement;
    boxes.push(cb);
    grid.appendChild(el(doc, 'label', { for: `bulk-p-${i.id}` }, [cb, ` ${i.id} `, el(doc, 'span', { class: 'muted small' }, [portText(portVlanIds(i), i.native)])]));
  }
  list.appendChild(grid);
  box.appendChild(list);
  // the operation
  const op = el(doc, 'select', { id: 'bulk-op', 'aria-label': 'Operation' }) as HTMLSelectElement;
  for (const [v, t] of [['add', 'Add a VLAN'], ['remove', 'Remove a VLAN'], ['access', 'Make access ports of a VLAN'], ['trunk', 'Make trunks of VLANs'], ['clear', 'Remove every VLAN']]) op.appendChild(el(doc, 'option', { value: v }, [t]));
  const vlan = el(doc, 'input', { type: 'text', id: 'bulk-vlan', inputmode: 'numeric', 'aria-label': 'VLAN', placeholder: 'VLAN (e.g. 20)', size: '8' }) as HTMLInputElement;
  const vlans = el(doc, 'input', { type: 'text', id: 'bulk-vlans', 'aria-label': 'VLANs', placeholder: 'VLANs (10, 20, 30-39)', size: '18' }) as HTMLInputElement;
  const native = el(doc, 'input', { type: 'text', id: 'bulk-native', inputmode: 'numeric', 'aria-label': 'Native VLAN (optional)', placeholder: 'native (optional)', size: '10' }) as HTMLInputElement;
  box.appendChild(el(doc, 'div', { class: 'bulk-op-row' }, [op, vlan, vlans, native]));
  const err = el(doc, 'p', { class: 'trace-error', id: 'bulk-error', role: 'alert', hidden: '' }, ['']);
  box.appendChild(err);
  const prev = el(doc, 'div', { id: 'bulk-preview', 'aria-live': 'polite' });
  box.appendChild(prev);
  const apply = el(doc, 'button', { type: 'button', id: 'bulk-apply', class: 'primary', title: locked || 'Apply the preview: one undo step for every port' }, ['Apply']) as HTMLButtonElement;
  box.appendChild(el(doc, 'div', { class: 'modal-btns' }, [apply]));
  const chosen = (): string[] => boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-bulk-port') as string);
  const current = (): BulkOp | string => {
    const k = op.value;
    if (k === 'clear') return { kind: 'clear' };
    if (k === 'trunk') {
      const vs = parseVlanList(vlans.value);
      if (typeof vs === 'string') return vs;
      if (native.value.trim()) {
        const nv = parseVlanList(native.value);
        if (typeof nv === 'string' || nv.length !== 1) return 'the native VLAN is one VLAN ID';
        return { kind: 'trunk', vlans: vs, native: nv[0] };
      }
      return { kind: 'trunk', vlans: vs };
    }
    const v = parseVlanList(vlan.value);
    if (typeof v === 'string' || v.length !== 1) return typeof v === 'string' ? v : 'one VLAN ID';
    return { kind: k as 'add' | 'remove' | 'access', vlan: v[0] };
  };
  const show = (): void => {
    vlan.hidden = op.value === 'trunk' || op.value === 'clear';
    vlans.hidden = native.hidden = op.value !== 'trunk';
    while (prev.firstChild) prev.removeChild(prev.firstChild);
    const ps = chosen();
    const o = current();
    err.hidden = typeof o !== 'string' || (!vlan.value && !vlans.value);
    err.textContent = typeof o === 'string' ? o : '';
    apply.disabled = true;
    if (!ps.length) {
      prev.appendChild(el(doc, 'p', { class: 'muted small' }, ['Tick the ports to change.']));
      return;
    }
    if (typeof o === 'string') return;
    const rows = act.plan(ps, o);
    const n = rows.filter((r) => r.write).length;
    const tb = el(doc, 'tbody', {});
    for (const r of rows) tb.appendChild(el(doc, 'tr', { 'data-bulk-row': r.port, class: r.write ? '' : 'muted' }, [el(doc, 'td', {}, [r.port]), el(doc, 'td', {}, [r.before]), el(doc, 'td', {}, [r.write ? r.after : `unchanged: ${r.note}`])]));
    prev.appendChild(el(doc, 'p', { class: 'small', id: 'bulk-count' }, [`Preview: ${n} of ${rows.length} port${rows.length === 1 ? '' : 's'} change.`]));
    prev.appendChild(el(doc, 'table', { class: 'data-table' }, [el(doc, 'thead', {}, [el(doc, 'tr', {}, [el(doc, 'th', {}, ['Port']), el(doc, 'th', {}, ['Before']), el(doc, 'th', {}, ['After'])])]), tb]));
    apply.disabled = !!locked || !n;
  };
  for (const x of [op, vlan, vlans, native]) {
    x.addEventListener('input', show);
    x.addEventListener('change', show);
  }
  grid.addEventListener('change', show);
  all.addEventListener('click', () => {
    boxes.forEach((b) => (b.checked = true));
    show();
  });
  none.addEventListener('click', () => {
    boxes.forEach((b) => (b.checked = false));
    show();
  });
  apply.addEventListener('click', () => {
    const o = current();
    if (typeof o !== 'string' && !apply.disabled) act.apply(chosen(), o);
  });
  show();
  return box;
}

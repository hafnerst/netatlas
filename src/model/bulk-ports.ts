/**
 * Bulk editing of a device's ports: one VLAN operation on several ports,
 * planned first (a preview: each port before and after, and what is not
 * changed and why), then applied by the editor as one undo step
 * (editor/document.ts applyPortPlan). Pure; the model is not touched.
 *
 *   access     the ports become access ports of one VLAN (no native);
 *   trunk      the ports become trunks of a VLAN list, with an optional native;
 *   add        a VLAN is added to each port's list (an access port becomes
 *              a trunk with its old VLAN native, so its untagged traffic
 *              stays as it was);
 *   remove     a VLAN is taken out of each port's list (a native that is
 *              removed goes too; a port left without a VLAN keeps none);
 *   clear      the VLANs are removed (the port carries no VLAN).
 *
 * A routed port, a VLAN interface and a port without the VLAN (remove) are
 * left as they are, and said so.
 */
import { Device, Interface, VlanRange } from './types';

export type BulkOp = { kind: 'access'; vlan: number } | { kind: 'trunk'; vlans: number[]; native?: number } | { kind: 'add'; vlan: number } | { kind: 'remove'; vlan: number } | { kind: 'clear' };

export interface PortPlanRow {
  port: string;
  /** its index in the device's interfaces */
  index: number;
  before: string;
  after: string;
  /** the VLANs and native as they will be written (null: unchanged) */
  write: { vlans: number[]; native?: number } | null;
  /** why it is left as it is */
  note?: string;
}

const MAX_LIST = 4094;

/** The VLAN IDs of a port's ranges (bounded). */
export function portVlanIds(i: Interface): number[] {
  const out: number[] = [];
  for (const r of i.vlans as VlanRange[]) for (let v = r.from; v <= r.to && out.length < MAX_LIST; v++) if (out.indexOf(v) < 0) out.push(v);
  return out.sort((a, b) => a - b);
}

/** "access 10", "trunk 10, 20 (native 99)", "no VLAN", "routed". */
export function portText(vlans: number[], native?: number, routed?: boolean): string {
  if (routed) return 'routed';
  if (!vlans.length) return 'no VLAN';
  if (vlans.length === 1 && native === undefined) return `access ${vlans[0]}`;
  return `trunk ${compact(vlans)}${native !== undefined ? ` (native ${native})` : ''}`;
}

function compact(ids: number[]): string {
  const out: string[] = [];
  for (let k = 0; k < ids.length; k++) {
    let j = k;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    out.push(j > k + 1 ? `${ids[k]}-${ids[j]}` : j === k + 1 ? `${ids[k]}, ${ids[j]}` : `${ids[k]}`);
    k = j;
  }
  return out.join(', ');
}

export function planPortEdit(device: Device, ports: string[], op: BulkOp): PortPlanRow[] {
  const rows: PortPlanRow[] = [];
  device.interfaces.forEach((i, index) => {
    if (ports.indexOf(i.id) < 0) return;
    const cur = portVlanIds(i);
    const before = portText(cur, i.native, i.routed);
    const row = (write: PortPlanRow['write'], note?: string): void => {
      rows.push({ port: i.id, index, before, after: write ? portText(write.vlans, write.native) : before, write, note });
    };
    if (i.routed) return row(null, 'a routed port carries no VLAN');
    if (i.type === 'virtual' && i.vlan !== undefined) return row(null, 'a VLAN interface, not a port');
    let next: { vlans: number[]; native?: number };
    if (op.kind === 'access') next = { vlans: [op.vlan] };
    else if (op.kind === 'trunk') next = { vlans: op.vlans.slice().sort((a, b) => a - b), native: op.native };
    else if (op.kind === 'clear') next = { vlans: [] };
    else if (op.kind === 'add') {
      if (cur.indexOf(op.vlan) >= 0) return row(null, `already carries VLAN ${op.vlan}`);
      // an access port keeps its untagged VLAN: it becomes the native of the trunk
      const native = i.native !== undefined ? i.native : cur.length === 1 ? cur[0] : undefined;
      next = { vlans: cur.concat([op.vlan]).sort((a, b) => a - b), native };
    } else {
      if (cur.indexOf(op.vlan) < 0) return row(null, `does not carry VLAN ${op.vlan}`);
      const left = cur.filter((v) => v !== op.vlan);
      const native = i.native === op.vlan ? undefined : i.native;
      next = { vlans: left, native: left.length === 1 && native === left[0] ? undefined : native };
    }
    if (next.native !== undefined && next.vlans.indexOf(next.native) < 0) next.vlans = next.vlans.concat([next.native]).sort((a, b) => a - b);
    if (portText(next.vlans, next.native) === before) return row(null, 'already so');
    row(next);
  });
  return rows;
}

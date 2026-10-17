/**
 * VLAN lists as written (a port's `vlans`, a port group's): IDs and ranges,
 * each checked, none twice.
 */
import { VLAN_MAX, VLAN_MIN, VlanRange } from '../model/types';
import { YNode } from '../yaml/parse';
import { Ctx, Reader, kindOf, scalarText } from './reader';

export function readVlanRanges(r: Reader, c: Ctx, node: YNode | undefined, path: string, where: string): VlanRange[] {
  const out: VlanRange[] = [];
  const seen: number[] = [];
  r.list(node, path, true).forEach((item, k) => {
    const ip = node && node.kind === 'seq' ? `${path}[${k}]` : path;
    const t = item.kind === 'scalar' ? scalarText(item) : undefined;
    const m = t !== undefined ? /^([0-9]{1,4})(?:\s*-\s*([0-9]{1,4}))?$/.exec(t) : null;
    const from = m ? Number(m[1]) : NaN;
    const to = m ? Number(m[2] !== undefined ? m[2] : m[1]) : NaN;
    if (!m || !(from >= VLAN_MIN && to <= VLAN_MAX && from <= to) || /^0/.test(m[1]) || (m[2] !== undefined && /^0/.test(m[2]))) {
      c.error(item, ip, `${t !== undefined ? `"${t}"` : kindOf(item)} is not a VLAN ID or range: use a whole number from ${VLAN_MIN} to ${VLAN_MAX}, or a range such as 100-199`);
      return;
    }
    const twice: number[] = [];
    for (let v = from; v <= to; v++) if (seen.indexOf(v) >= 0) twice.push(v);
    if (twice.length) {
      c.error(item, ip, `VLAN ${twice[0]}${twice.length > 1 ? ' and others' : ''} listed twice in the VLANs of ${where}`);
      return;
    }
    for (let v = from; v <= to; v++) seen.push(v);
    out.push({ from, to });
  });
  return out;
}

export function vlanTextOf(rs: VlanRange[]): string {
  return rs.map((x) => (x.to > x.from ? `${x.from}-${x.to}` : String(x.from))).join(', ');
}

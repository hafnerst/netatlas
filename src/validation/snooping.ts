/**
 * A switch's IGMP / MLD snooping per VLAN (`igmp_mld_snooping:`, see
 * model/snooping.ts): a mapping of VLAN IDs or ranges to `enabled` or
 * `disabled`. Only switches have it; a VLAN may be chosen once. A choice
 * for a VLAN none of the switch's ports carries is a warning (it does
 * nothing). A switched VLAN without a choice is reported by the consistency
 * check `snooping-not-configured` (an error there, not a format error: the
 * model still loads and draws).
 */
import { Device, VLAN_MAX, VLAN_MIN } from '../model/types';
import { SNOOPING_KEY, SnoopingRange, hasSnooping, switchedVlans } from '../model/snooping';
import { deviceTypeLabel } from '../model/device-types';
import { YMap, YNode } from '../yaml/parse';
import { Ctx, Reader, isNull, kindOf, scalarText } from './reader';

/** Read the setting (the device's type must be known); undefined when it is not written or not a switch's. */
export function readSnooping(r: Reader, c: Ctx, m: YMap, dpath: string, dev: Device): SnoopingRange[] | undefined {
  const n = m.entries.get(SNOOPING_KEY);
  if (!n || isNull(n.value)) return undefined;
  const node = n.value;
  const path = `${dpath}.${SNOOPING_KEY}`;
  if (!hasSnooping(dev)) {
    c.error(node, path, `${SNOOPING_KEY} is a switch's setting (IGMP / MLD snooping per VLAN); "${dev.id}" is ${deviceTypeLabel(dev.type) ? 'a ' + deviceTypeLabel(dev.type) : 'not a switch'} — delete it`);
    return undefined;
  }
  const map = r.map(node, path);
  if (!map) return undefined;
  const out: SnoopingRange[] = [];
  for (const e of Array.from(map.entries.values())) {
    const ep = `${path}.${e.key}`;
    const k = /^([0-9]{1,4})(?:\s*-\s*([0-9]{1,4}))?$/.exec(e.key);
    const from = k ? Number(k[1]) : NaN;
    const to = k ? Number(k[2] !== undefined ? k[2] : k[1]) : NaN;
    if (!k || !(from >= VLAN_MIN && to <= VLAN_MAX && from <= to) || /^0/.test(k[1]) || (k[2] !== undefined && /^0/.test(k[2]))) {
      c.error(e.value, ep, `"${e.key}" is not a VLAN ID or range: use a whole number from ${VLAN_MIN} to ${VLAN_MAX}, or a range such as 30-39`, { line: e.keyLine });
      continue;
    }
    const v = e.value.kind === 'scalar' ? scalarText(e.value) : undefined;
    if (v !== 'enabled' && v !== 'disabled') {
      c.error(e.value, ep, `IGMP / MLD snooping of VLAN ${e.key} is ${v !== undefined && v !== '' ? `"${v}"` : kindOf(e.value)}: write enabled or disabled`);
      continue;
    }
    const twice = out.find((x) => x.from <= to && from <= x.to);
    if (twice) {
      c.error(e.value, ep, `VLAN ${Math.max(from, twice.from)} is chosen twice in ${SNOOPING_KEY} of "${dev.id}"`);
      continue;
    }
    out.push({ from, to, enabled: v === 'enabled' });
  }
  return out;
}

/** Once its ports are read: a choice for VLANs that none of its switch ports carries does nothing. */
export function checkSnoopingVlans(c: Ctx, m: YMap, dpath: string, dev: Device): void {
  const n = m.entries.get(SNOOPING_KEY);
  if (!dev.snooping || !n || n.value.kind !== 'map') return;
  const carried = switchedVlans(dev);
  for (const e of Array.from(n.value.entries.values())) {
    const r = dev.snooping.find((x) => e.key === (x.from === x.to ? String(x.from) : '') || new RegExp(`^${x.from}\\s*-\\s*${x.to}$`).test(e.key));
    if (!r || carried.some((v) => v >= r.from && v <= r.to)) continue;
    c.warn(e.value as YNode, `${dpath}.${SNOOPING_KEY}.${e.key}`, `${r.from === r.to ? `VLAN ${r.from} is` : `VLANs ${r.from}-${r.to} are`} on none of the switch ports of "${dev.id}": its IGMP / MLD snooping setting there does nothing`, { line: e.keyLine });
  }
}

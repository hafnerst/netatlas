/**
 * IGMP / MLD snooping, a switch's own configuration (`igmp_mld_snooping:`):
 * one explicit choice per VLAN the switch carries on its ports, `enabled` or
 * `disabled`, for IPv4 (IGMP) and IPv6 (MLD) together. A VLAN without a
 * choice is not configured: a configuration error (the consistency check
 * `snooping-not-configured`), never read as either value. Different
 * switches may choose differently for the same VLAN.
 *
 *   igmp_mld_snooping: {10: enabled, 20: enabled, 30-39: disabled}
 *
 * What the choice does in the simulation (analysis/sim/multicast.ts):
 * enabled, a group's data goes to the ports where a member reported it and
 * to the multicast router ports only (no member: to the router ports only,
 * never flooded); disabled, multicast is flooded to every port of the VLAN.
 */
import { capabilities } from './capabilities';
import { Device, VlanRange, deviceInterfaces } from './types';
import { vlanIds } from './derive';

export const SNOOPING_KEY = 'igmp_mld_snooping';
export const SNOOPING_VALUES = ['enabled', 'disabled'] as const;

/** A switch's choice for a VLAN or a range of VLANs. */
export interface SnoopingRange extends VlanRange {
  enabled: boolean;
}

export type SnoopingChoice = 'enabled' | 'disabled' | 'unset';

/** Does a device take the setting: a switch (Layer 2 or Layer 3; its switched VLANs)? */
export function hasSnooping(d: { type: string; layer3?: boolean }): boolean {
  return capabilities(d).switchFeatures;
}

/** The VLANs a switch carries on its switch ports (ports and aggregates with VLANs; not its routed ports, not a VLAN interface's alone), ascending. */
export function switchedVlans(d: Device): number[] {
  if (!hasSnooping(d)) return [];
  const out = new Set<number>();
  for (const i of deviceInterfaces(d)) if (!i.routed) for (const v of vlanIds(i.vlans)) out.add(v);
  return Array.from(out).sort((a, b) => a - b);
}

/** A switch's choice for a VLAN: enabled, disabled, or not configured. */
export function snoopingChoice(d: Device | undefined, vlan: number): SnoopingChoice {
  if (!d || !d.snooping) return 'unset';
  const r = d.snooping.find((x) => vlan >= x.from && vlan <= x.to);
  return r ? (r.enabled ? 'enabled' : 'disabled') : 'unset';
}

/** The VLANs where a switch's snooping is enabled, ascending (none: no switch, or enabled nowhere). */
export function snoopingEnabledVlans(d: Device): number[] {
  return switchedVlans(d).filter((v) => snoopingChoice(d, v) === 'enabled');
}

/**
 * The words of a snooping VLAN's badge in the simulation, after "VLAN n · ":
 * every text a badge can have is one of these (its width is reserved for the
 * longest, so a role that changes never moves or resizes it).
 */
export const SNOOP_ROLE_TEXTS = ['Querier', 'Querier (startup)', 'Standby', 'Candidate down · querier heard', 'Candidate down · no querier', 'Snooping · querier heard', 'Snooping · no querier', 'Off', 'Booting'];

/** The switched VLANs of a switch without a choice (a configuration error each). */
export function unsetSnoopingVlans(d: Device): number[] {
  return switchedVlans(d).filter((v) => snoopingChoice(d, v) === 'unset');
}

/**
 * A simulation snapshot for analysis: the state of a running protocol
 * simulation at one moment, frozen, so that an analysis computed on it is
 * stable while the simulation goes on. It holds what the analysis reads:
 * the routing context (what is up, the adjacencies, the connected networks
 * and default routes a DHCP lease or a router advertisement added) and the
 * effective addresses with where each came from. Nothing of it changes after
 * it was taken, and nothing is computed from the live simulation later.
 *
 * Configured intent and acquired state stay apart: an interface's `ipv4:
 * dhcp` or `ipv6: slaac` is configuration (model/types.ts); the address a
 * lease or SLAAC gave it is a snapshot fact, with its state (tentative,
 * preferred, deprecated, duplicate) and lifetimes. Pure types and helpers.
 */
import type { RoutingCtx } from './routing';

/** How an address was obtained. */
export type AddrMethod = 'static' | 'dhcpv4' | 'slaac' | 'dhcpv6' | 'link-local';

export const ADDR_METHOD_TEXT: { [m in AddrMethod]: string } = {
  static: 'Static',
  dhcpv4: 'DHCPv4',
  slaac: 'SLAAC',
  dhcpv6: 'DHCPv6',
  'link-local': 'Link-local',
};

/** An effective address of an interface in a snapshot (an acquired one: a lease, SLAAC, DHCPv6, link-local). */
export interface SnapAddr {
  device: string;
  iface: string;
  vrf: string;
  /** with its prefix length ("192.168.10.100/24") */
  address: string;
  /** without it */
  text: string;
  version: 4 | 6;
  method: AddrMethod;
  /** IPv6: tentative (DAD running), preferred, deprecated (preferred lifetime over), duplicate (DAD failed); DHCPv4: bound */
  state: 'bound' | 'tentative' | 'preferred' | 'deprecated' | 'duplicate';
  /** the server (DHCP) or router (SLAAC) it came from */
  from?: string;
  /** when it stops being valid (simulated ms; none: never) */
  validUntil?: number;
}

/** A frozen simulation state. */
export interface AnalysisSnapshot {
  /** the simulated time it was taken at (ms) */
  at: number;
  /** what routing and the path tracer read (frozen) */
  ctx: RoutingCtx;
  /** the acquired addresses (sorted by device, interface, address) */
  addresses: SnapAddr[];
  /** the failed objects at that moment (refs, sorted) */
  down: string[];
  /** a key of the snapshot (equal keys: the same state) */
  key: string;
}

/** The acquired addresses of an interface in a snapshot. */
export function snapAddrsOf(s: AnalysisSnapshot | null | undefined, device: string, iface?: string): SnapAddr[] {
  return s ? s.addresses.filter((a) => a.device === device && (iface === undefined || a.iface === iface)) : [];
}

/** How an address of an interface was obtained: a snapshot's acquired address by its text, else static. */
export function methodOf(s: AnalysisSnapshot | null | undefined, device: string, iface: string, text: string): AddrMethod {
  const a = s ? s.addresses.find((x) => x.device === device && x.iface === iface && x.text === text) : undefined;
  return a ? a.method : 'static';
}

/**
 * IPv6 host configuration as the model writes it, and the protocol
 * constants the simulation uses (analysis/sim/ipv6.ts).
 *
 * A host interface's IPv6 method (`ipv6:`):
 *   static        its written addresses only (`ip:`), no router discovery;
 *                 the default when it has IPv6 addresses and nothing is written;
 *   slaac         stateless address autoconfiguration (RFC 4862): it
 *                 solicits routers, forms an address in every advertised
 *                 /64 prefix with the autonomous flag, takes the routers as
 *                 default routers and their DNS servers (RDNSS, RFC 8106);
 *                 asks DHCPv6 for further information (DNS) when a router
 *                 sets the other-configuration flag (stateless DHCPv6);
 *   dhcpv6        stateful DHCPv6 (RFC 8415): its address from a DHCPv6
 *                 server (a /128), its default router from router
 *                 advertisements (DHCPv6 has no default-gateway option);
 *   slaac_dhcpv6  both: a SLAAC address and a DHCPv6 address.
 * Every interface with an automatic method has a link-local address
 * (fe80::/64), validated by duplicate address detection before use.
 *
 * A router interface's advertisements (`ipv6_ra:`): only what is written
 * is advertised: its prefixes (each explicitly; never every connected
 * prefix), and, collapsed in the editor, the DNS servers, the managed and
 * other-configuration flags, whether its prefixes are for SLAAC
 * (autonomous), the router lifetime, the advertisement interval and the
 * prefixes' preferred and valid lifetimes. Unwritten values are RFC 4861
 * §6.2.1's defaults.
 */

export type Ipv6Method = 'static' | 'slaac' | 'dhcpv6' | 'slaac_dhcpv6';

/** Does an interface take part in IP: written addresses, IPv4 by DHCP, automatic IPv6, or a router's advertisements? */
export function ipConfigured(i: { addresses: string[]; dhcp: boolean; ipv6?: Ipv6Method; ra?: unknown }): boolean {
  return i.addresses.length > 0 || i.dhcp || autoIpv6(i.ipv6) || !!i.ra;
}

export const IPV6_METHODS: ReadonlyArray<{ id: Ipv6Method; label: string; help: string }> = [
  { id: 'static', label: 'Static', help: 'Only the addresses written under ip:; no router discovery.' },
  { id: 'slaac', label: 'Automatic (SLAAC)', help: 'An address in each advertised prefix; routers and DNS from their advertisements.' },
  { id: 'dhcpv6', label: 'Automatic (DHCPv6)', help: 'Its address from a DHCPv6 server; its default router from router advertisements.' },
  { id: 'slaac_dhcpv6', label: 'Automatic (SLAAC and DHCPv6)', help: 'Both a SLAAC address and a DHCPv6 address.' },
];

export function ipv6MethodLabel(m: Ipv6Method | undefined): string {
  const x = IPV6_METHODS.find((y) => y.id === m);
  return x ? x.label : 'None';
}

/** Is the method automatic (link-local, router solicitations)? */
export function autoIpv6(m: Ipv6Method | undefined): boolean {
  return m === 'slaac' || m === 'dhcpv6' || m === 'slaac_dhcpv6';
}

/** A router interface's advertisements as read (durations in ms; unwritten: undefined, the defaults apply). */
export interface RaConfig {
  prefixes: string[];
  dns: string[];
  managed: boolean;
  other: boolean;
  autonomous: boolean;
  routerLifetime?: number;
  interval?: number;
  preferredLifetime?: number;
  validLifetime?: number;
  dnsLifetime?: number;
  line: number;
}

const S = 1000;
/** RFC 4861 §6.2.1 router defaults and RFC 8106 §5.1's RDNSS lifetime. */
export const RA_DEFAULTS = {
  /** MaxRtrAdvInterval */
  interval: 600 * S,
  /** MinRtrAdvInterval = 0.33 × MaxRtrAdvInterval */
  minFactor: 0.33,
  /** AdvDefaultLifetime = 3 × MaxRtrAdvInterval */
  routerLifetimeFactor: 3,
  /** AdvValidLifetime (30 days) */
  valid: 2592000 * S,
  /** AdvPreferredLifetime (7 days) */
  preferred: 604800 * S,
  /** RDNSS lifetime: at least 3 × MaxRtrAdvInterval (RFC 8106 §5.1) */
  dnsFactor: 3,
} as const;

/** RFC 4861 §10 host and router constants, RFC 4862 duplicate address detection. */
export const NDP_CONSTANTS = {
  MAX_RTR_SOLICITATION_DELAY: 1 * S,
  RTR_SOLICITATION_INTERVAL: 4 * S,
  MAX_RTR_SOLICITATIONS: 3,
  MAX_INITIAL_RTR_ADVERT_INTERVAL: 16 * S,
  MAX_INITIAL_RTR_ADVERTISEMENTS: 3,
  MAX_RA_DELAY_TIME: 0.5 * S,
  MIN_DELAY_BETWEEN_RAS: 3 * S,
  /** DupAddrDetectTransmits (1) solicitations, RetransTimer (1 s) apart */
  DAD_TRANSMITS: 1,
  RETRANS_TIMER: 1 * S,
  /** RFC 4862 §5.5.3 e): a valid lifetime is lowered to no less than two hours by an advertisement */
  TWO_HOURS: 7200 * S,
} as const;

/** RFC 8415 §7.6 transmission parameters (ms), and its recommended T1 / T2 (0.5 and 0.8 of the preferred lifetime). */
export const DHCP6 = {
  SOL_MAX_DELAY: 1 * S,
  SOL_TIMEOUT: 1 * S,
  SOL_MAX_RT: 3600 * S,
  REQ_TIMEOUT: 1 * S,
  REQ_MAX_RT: 30 * S,
  REQ_MAX_RC: 10,
  REN_TIMEOUT: 10 * S,
  REN_MAX_RT: 600 * S,
  REB_TIMEOUT: 10 * S,
  REB_MAX_RT: 600 * S,
  INF_MAX_DELAY: 1 * S,
  INF_TIMEOUT: 1 * S,
  INF_MAX_RT: 3600 * S,
  IRT_DEFAULT: 86400 * S,
  T1: 0.5,
  T2: 0.8,
  CLIENT_PORT: 546,
  SERVER_PORT: 547,
  /** All_DHCP_Relay_Agents_and_Servers */
  GROUP: 'ff02::1:2',
} as const;

/** The router lifetime in effect (ms). */
export function raRouterLifetime(ra: RaConfig): number {
  return ra.routerLifetime !== undefined ? ra.routerLifetime : RA_DEFAULTS.routerLifetimeFactor * raInterval(ra);
}

export function raInterval(ra: RaConfig): number {
  return ra.interval !== undefined ? ra.interval : RA_DEFAULTS.interval;
}

export function raDnsLifetime(ra: RaConfig): number {
  return ra.dnsLifetime !== undefined ? ra.dnsLifetime : RA_DEFAULTS.dnsFactor * raInterval(ra);
}

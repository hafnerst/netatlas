/**
 * Send test's plan: what one Send test, or a series of them, is made of, and
 * the rules that the form, its validation and the simulation share. These
 * are the delivery types, the protocols each one offers, when a port
 * applies, and the message count and interval. With one definition the form
 * can't offer what the packet generator refuses, nor the reverse.
 *
 * - **Unicast**: one destination, a device's interface (its address, or its
 *   DHCP lease when the message is sent) or an address or host name written
 *   in. ICMP echo, TCP or UDP.
 * - **Multicast**: a group address. UDP only: members take it (the
 *   membership and multicast routing of the simulation decide who), nobody
 *   answers; the simulation has no echo to a group.
 * - **Local broadcast**: out of the source interface into its broadcast
 *   domain, to 255.255.255.255 (limited) or to that interface's subnet
 *   broadcast. ICMP echo (answered where broadcast pings are on) or UDP.
 *   IPv4 only: IPv6 has no broadcast.
 * - **Directed broadcast**: to the broadcast address of a subnet elsewhere,
 *   written in explicitly; routed like unicast, and sent out as a broadcast
 *   by the last router only where it forwards directed broadcasts. ICMP or
 *   UDP, IPv4 only.
 *
 * TCP connects to one host, so it is offered for unicast only.
 *
 * One message is one test: an ICMP echo request, a UDP datagram, or a TCP
 * connection attempt (its handshake, request, answer and close are part of
 * that one message). Replies, retransmissions, forwarded copies and the
 * replicas of a broadcast or multicast don't count. Message n of a series is
 * sent at the start time plus (n − 1) intervals of simulated time, whatever
 * became of the messages before it.
 */
import { IpAddr, parseAddress, parsePrefix } from '../../model/ip';
import { isMulticastIp } from './mac';
import { TestKind } from './transport';

export type Delivery = 'unicast' | 'multicast' | 'broadcast' | 'directed';

export const DELIVERIES: Delivery[] = ['unicast', 'multicast', 'broadcast', 'directed'];

export const DELIVERY_LABEL: Record<Delivery, string> = { unicast: 'Unicast', multicast: 'Multicast', broadcast: 'Local broadcast', directed: 'Directed broadcast' };

export const KIND_LABEL: Record<TestKind, string> = { icmp: 'ICMP (ping)', tcp: 'TCP', udp: 'UDP' };

/** The most messages one Send test sends (a browser stays responsive), and the interval's range in seconds. */
export const MAX_MESSAGES = 1000;
export const MIN_INTERVAL = 0.01;
export const MAX_INTERVAL = 3600;

/** The protocols a delivery type offers: those whose semantics the simulation implements for it. */
export function kindsFor(d: Delivery): TestKind[] {
  return d === 'unicast' ? ['icmp', 'tcp', 'udp'] : d === 'multicast' ? ['udp'] : ['icmp', 'udp'];
}

/** Does a protocol have ports (a destination port to choose)? */
export function usesPorts(k: TestKind): boolean {
  return k === 'tcp' || k === 'udp';
}

/** Does a delivery type need the source interface chosen, when the source has several (a broadcast or a group leaves one interface)? */
export function needsInterface(d: Delivery): boolean {
  return d === 'multicast' || d === 'broadcast';
}

/** One Send test (with `count` above 1, a series of them). Fields that don't apply are left out. */
export interface TestPlan {
  delivery: Delivery;
  from: string;
  /** the source interface; left out (unicast and directed broadcast only): as its routes choose */
  via?: string;
  kind: TestKind;
  /** the destination port (TCP and UDP only) */
  port?: number;
  /** unicast: the destination device, its interface and that interface's address ('dhcp': its lease when the message is sent) */
  to?: string;
  toIface?: string;
  toAddr?: string;
  /** unicast: an address or a host name written instead of a device */
  target?: string;
  /** a host name's family: 6 resolves its AAAA record, else its A record */
  family?: 4 | 6;
  /** multicast: the group */
  group?: string;
  /** local broadcast: 255.255.255.255, or the source interface's subnet broadcast */
  scope?: 'limited' | 'subnet';
  /** directed broadcast: the target subnet ("10.1.2.0/24") or its broadcast address ("10.1.2.255") */
  subnet?: string;
  /** messages (1 when left out) and the interval between them in seconds (only with more than one) */
  count?: number;
  interval?: number;
  size?: number;
  df?: boolean;
  keep?: boolean;
}

const whole = (n: number | undefined, lo: number, hi: number): boolean => n !== undefined && Number.isInteger(n) && n >= lo && n <= hi;

/**
 * What is wrong with a plan by its own fields, or null. The simulation checks the rest against its
 * state (the source can send, the interface has an address, the subnet is one of the model's).
 */
export function planProblem(p: TestPlan): string | null {
  if (!p.delivery || DELIVERIES.indexOf(p.delivery) < 0) return 'Choose a delivery type.';
  if (!p.from) return 'Choose the device to send from.';
  if (p.via !== undefined && !p.via) return 'Choose the interface to send from.';
  if (p.delivery === 'unicast') {
    if (p.to && p.target) return 'Choose a destination device or write an address, not both.';
    if (p.target !== undefined && !p.target.trim() && !p.to) return 'Enter the address or host name.';
    if (!p.to && !p.target) return 'Choose the destination.';
    if (p.to && (!p.toIface || !p.toAddr)) return 'Choose the destination interface.';
    if (p.target) {
      const a = parseAddress(p.target.trim());
      if (a && isMulticastIp(a)) return `${p.target.trim()} is a group: choose Multicast.`;
      if (a && a.version === 4 && a.bytes.every((b) => b === 255)) return '255.255.255.255 is the limited broadcast: choose Local broadcast.';
    }
  } else if (p.delivery === 'multicast') {
    const g = (p.group || '').trim();
    if (!g) return 'Enter the group address.';
    const a = parseAddress(g);
    if (!a) return `${g} is not an IP address.`;
    if (!isMulticastIp(a)) return `${g} is not a multicast group (224.0.0.0/4, ff00::/8).`;
  } else if (p.delivery === 'broadcast') {
    if (p.scope !== 'limited' && p.scope !== 'subnet') return 'Choose the broadcast scope.';
  } else {
    const r = directedTarget(p.subnet || '');
    if (typeof r === 'string') return r;
  }
  if (!p.kind) return 'Choose a protocol.';
  if (kindsFor(p.delivery).indexOf(p.kind) < 0) return p.kind === 'tcp' ? `TCP connects to one host: not for ${DELIVERY_LABEL[p.delivery].toLowerCase()}.` : `${KIND_LABEL[p.kind]} is not offered for ${DELIVERY_LABEL[p.delivery].toLowerCase()}.`;
  if (usesPorts(p.kind)) {
    if (p.port === undefined) return 'Enter the destination port.';
    if (!whole(p.port, 1, 65535)) return 'The port is a whole number from 1 to 65535.';
  } else if (p.port !== undefined) return `${KIND_LABEL[p.kind]} has no ports.`;
  if (p.keep && p.kind !== 'tcp') return 'Keep open is for TCP only.';
  const count = p.count === undefined ? 1 : p.count;
  if (!whole(count, 1, MAX_MESSAGES)) return `The number of messages is a whole number from 1 to ${MAX_MESSAGES}.`;
  if (count > 1 && !(p.interval !== undefined && isFinite(p.interval) && p.interval >= MIN_INTERVAL && p.interval <= MAX_INTERVAL)) return `The interval is a number of seconds from ${MIN_INTERVAL} to ${MAX_INTERVAL}.`;
  if (p.size !== undefined && !whole(p.size, 0, 65000)) return 'The data size is a whole number of bytes from 0 to 65000.';
  return null;
}

/**
 * A directed broadcast's address, from the subnet written ("10.1.2.0/24" → 10.1.2.255) or the
 * broadcast address itself; a text when it is none. Nothing is guessed: a bare address is taken as
 * the broadcast address (the simulation checks it is one of a subnet of the model).
 */
export function directedTarget(text: string): IpAddr | string {
  const s = text.trim();
  if (!s) return 'Enter the target subnet (e.g. 10.1.2.0/24) or its broadcast address.';
  const p = s.indexOf('/') >= 0 ? parsePrefix(s) : null;
  const a = p || parseAddress(s);
  if (!a) return `${s} is not a subnet or an address.`;
  if (a.version === 6) return 'IPv6 has no broadcast: choose Multicast (ff02::1 reaches every node of a link).';
  if (!p) {
    if (a.bytes.every((b) => b === 255)) return '255.255.255.255 is the limited broadcast: choose Local broadcast.';
    return a;
  }
  if (p.prefix > 30) return `A /${p.prefix} has no broadcast address.`;
  const bytes = p.bytes.slice();
  let bits = p.prefix;
  for (let i = 0; i < 4; i++, bits -= 8) {
    const keep = bits >= 8 ? 0xff : bits > 0 ? (0xff << (8 - bits)) & 0xff : 0;
    bytes[i] = (bytes[i] & keep) | (~keep & 0xff);
  }
  return { version: 4, bytes };
}

/** The scheduled time of message n (1-based) of a series that starts at t0 (ms), the interval in seconds. */
export function messageTime(t0: number, n: number, interval: number): number {
  return t0 + (n - 1) * Math.round(interval * 1000 * 1000) / 1000;
}


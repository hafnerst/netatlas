/**
 * The types the protocol simulation shares with its window and its
 * animation: messages, the dots in flight (one per cable or logical line),
 * the event log, the status of the protocols' sessions, and the ARP,
 * neighbour and MAC tables. Times are in milliseconds of simulated time.
 */
import { IpAddr } from '../../model/ip';

/** A drawn line a dot runs along, and which way (as analysis/traffic.ts: a cable "a"→"b", a relation's lane device→device, a hub spoke, a network's membership line). */
export interface Track {
  ref: string;
  from: string;
  to: string;
}

/** A protocol message (what a dot carries). */
export interface Msg {
  /** the protocol's profile id ("ospf", "arp", "custom:<id>") */
  protocol: string;
  /** the message type ("Hello", "ARP Request") */
  type: string;
  /** the dot's label: protocol and message, short ("OSPF Hello", "ARP Who has 10.0.0.2? Tell 10.0.0.1") */
  label: string;
  /** the full payload for the event log */
  detail: string;
  /** the relation (session) it belongs to, when there is one */
  relation?: string;
  /** protocol data (read by the receiving state machine) */
  data?: { [k: string]: unknown };
}

/** An IP packet in the simulation. */
export interface Pkt {
  id: number;
  src: IpAddr;
  dst: IpAddr;
  ttl: number;
  vrf: string;
  msg: Msg;
  /** an encapsulated packet (GRE, ESP …) and the header's name */
  inner?: Pkt;
  encap?: string;
  /** for equal-cost path selection: the same flow takes the same path */
  flow: string;
  /** the relations it rides (its session, and the tunnels it is inside), for failures of a relation */
  rides: string[];
}

/** One dot: a message on one cable (physical) or one logical line, from t0 to t1. */
export interface Flight {
  id: number;
  t0: number;
  t1: number;
  protocol: string;
  label: string;
  view: 'physical' | 'logical';
  track: Track;
  /** dropped where it is at this time (a failure): drawn lost there */
  dropped?: number;
  /** the flight it continues (the cable before it), for a failure that cuts a path */
  parent?: number;
  /** hidden: it never happened (a failure upstream cut it) */
  hidden?: boolean;
  /** the encapsulation it travels in, outermost last ("GRE", "ESP") */
  encap?: string[];
  /** the protocols of that encapsulation ("gre", "ipsec") */
  encapProtocols?: string[];
}

export type EventKind = 'message' | 'state' | 'drop' | 'route' | 'link' | 'table' | 'note';

/** One line of the event log. */
export interface SimEvent {
  t: number;
  seq: number;
  kind: EventKind;
  /** the protocol's profile id ('link' for interfaces and cables) */
  protocol: string;
  /** the device it happens at (a message: its sender) */
  device: string;
  /** a message's receiver, a session's peer ('' none) */
  peer: string;
  /** the message type, or what happened ("Down", "dropped") */
  what: string;
  /** a state reached ('' none) */
  state: string;
  /** the full payload or explanation */
  detail: string;
}

/** A protocol session's status (the status table). */
export interface SessionStatus {
  protocol: string;
  /** "ospf-w1-c1: w1 ↔ c1" */
  name: string;
  device: string;
  peer: string;
  state: string;
  /** the role, the timers in effect, the last change */
  detail: string;
  up: boolean;
  relation?: string;
}

export type ArpType = 'dynamic' | 'static' | 'incomplete' | 'gratuitous' | 'virtual';
export type NdState = 'INCOMPLETE' | 'REACHABLE' | 'STALE' | 'DELAY' | 'PROBE';

/** A row of an ARP (IPv4) or neighbour (IPv6) table. */
export interface ArpRow {
  ip: string;
  /** '' while incomplete */
  mac: string;
  macSimulated: boolean;
  iface: string;
  vlan: number;
  type: ArpType;
  /** IPv6: the NUD state; IPv4: '' (or "refreshing" while being refreshed) */
  state: string;
  /** ms since it was learned or last refreshed */
  age: number;
  /** ms until it expires or its state times out (null: does not time out) */
  remaining: number | null;
  version: 4 | 6;
}

/** A row of a switch's MAC table. */
export interface MacRow {
  mac: string;
  macSimulated: boolean;
  vlan: number;
  port: string;
  type: 'dynamic' | 'static';
  age: number;
  remaining: number | null;
}

/** A timer of a table, as shown at its top. */
export interface TableTimer {
  label: string;
  /** the configured or default value, in seconds */
  seconds: number;
  /** 'configured' (the device's or the interface's) or 'default' (with its source) */
  origin: string;
}

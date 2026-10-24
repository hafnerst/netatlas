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
  /** the device that sent it (set when it is first sent or logged; a forwarded copy keeps it) */
  sender?: string;
  /** the device whose own action started the exchange it belongs to: its sender, or for a reply (an ARP reply, a TCP SYN-ACK, an ICMP error …) the origin of what it answers */
  origin?: string;
  /** what made it be sent: the message it answers or carries on ("ARP Request from r1 at t = 2.000 s"); none: its own timer or start */
  causedBy?: string;
  /** what it waited for before it could be sent, and how long ("ARP 10.0.12.2: 0.2 ms") */
  waited?: string[];
  /** the Send test it belongs to (its id): the test's own packets, what they need (ARP, NDP, DNS) and every answer to them */
  test?: number;
  /** the transport conversation it belongs to (pacing.ts flowKey: a TCP connection's ends and ports), for its dots in both views */
  conv?: string;
  /** a TCP segment's flags as a label gives them ("[S,A]", tcp.ts), from its header */
  flags?: string;
}

/** The transport header of a packet (ICMP counts here too): what the inspector, firewalls and the transport layer read. */
export interface L4 {
  proto: 'icmp' | 'tcp' | 'udp' | 'igmp' | 'other';
  /** the IP protocol number (IPv6: next header): 1 / 58 ICMP, 6 TCP, 17 UDP, 89 OSPF … */
  num: number;
  sport?: number;
  dport?: number;
  /** TCP flags ("SYN", "ACK", "FIN", "RST", "PSH"; a label gives them as tcp.ts's tcpFlagsText: [S,A]) */
  flags?: string[];
  seq?: number;
  ack?: number;
  /** TCP's MSS option (a SYN's: the largest segment its sender can receive) */
  mss?: number;
  /** ICMP / ICMPv6 type and code, and their name ("Destination Unreachable", "Net Unreachable") */
  icmpType?: number;
  icmpCode?: number;
  icmpName?: string;
  /** an echo's identifier and sequence number */
  echoId?: number;
  echoSeq?: number;
  /** Fragmentation Needed / Packet Too Big: the MTU of the next hop */
  mtu?: number;
  /** an ICMP error quotes the header of the packet it is about */
  quote?: Quote;
  /** IGMP (IP protocol 2) or MLD (ICMPv6 130–143): the message, its version, the group, the sources, the records of a v3 / v2 report */
  igmp?: { type: string; version: string; group?: string; sources?: string[]; maxResp?: number; records?: string[] };
}

/** The header of the packet an ICMP error is about (quoted in it). */
export interface Quote {
  src: string;
  dst: string;
  ttl: number;
  proto: string;
  sport?: number;
  dport?: number;
  /** a quoted ICMP echo's identifier */
  echoId?: number;
  /** the quoted packet's IP protocol number (IPv6: next header); none: the packet had no transport header */
  num?: number;
  /** the quoted packet's id, for the sender to match it */
  pkt: number;
  /** the quoted packet's flow (the transport matches its connection) */
  flow: string;
}

/** An IP packet in the simulation. */
export interface Pkt {
  id: number;
  src: IpAddr;
  dst: IpAddr;
  ttl: number;
  vrf: string;
  msg: Msg;
  /** its transport header (none: a protocol message whose transport is in its profile) */
  l4?: L4;
  /** IPv4 Don't Fragment (IPv6 never fragments on the way) */
  df?: boolean;
  /** the bytes after the IP header (transport header and payload; none: the message's size) */
  len?: number;
  /** a fragment: its number (1-based) of how many it was cut into, its offset in bytes, and the whole packet's length (after the IP header) */
  frag?: { i: number; n: number; offset: number; whole: number };
  /** an encapsulated packet (GRE, ESP …) and the header's name */
  inner?: Pkt;
  encap?: string;
  /** the encapsulation's format (encap.ts: its base protocol, "gre", "ipsec"): what it adds to the inner packet's length */
  encapProto?: string;
  /** for equal-cost path selection: the same flow takes the same path */
  flow: string;
  /** the relations it rides (its session, and the tunnels it is inside), for failures of a relation */
  rides: string[];
  /** held for its transfer delay at this Security gateway: decided already, it goes on */
  held?: string;
  /** IPv6: the path MTU its sender knows (it fragments its own packet to it; routers never do) */
  pmtu?: number;
  /** the Router Alert option (IPv4 option 20, RFC 2113; IPv6 Hop-by-Hop, RFC 2711): IGMP and MLD carry it */
  routerAlert?: boolean;
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
  /** unicast, broadcast or multicast (the dot's shape) */
  cast?: Cast;
  /** the frame's headers on this cable (the packet inspector) */
  hdr?: Headers;
  /** its message's sender and origin (Senders: what is shown) */
  sender?: string;
  origin?: string;
  /** the Send test its message belongs to (always shown, drawn first, marked Test) */
  test?: number;
  /** its message's transport conversation (Msg.conv): Follow message's key in both views */
  conv?: string;
  /** a TCP segment's flags (Msg.flags): what a short background label says of it */
  flags?: string;
  /** its message's type (Msg.type: "ARP Request", "Hello", "Membership Report" …): the pacing's steady state is a kind seen before */
  type?: string;
  /**
   * the flight whose arrival caused it (a frame forwarded on, an answer, an
   * ARP request for a packet, the packet released by the ARP reply …): the
   * display starts it only after that one has arrived; none for what a
   * timer or a Network event starts
   */
  cause?: number;
  /**
   * Its delivery's lifecycle (the engine's events its arrival is, Engine.at
   * with it as a gate): `due` of them still queued — pending, whatever their
   * time, even at the engine's own time when it stopped partway through a
   * moment — and `delivered` once one was processed (it may have found the
   * delivery cancelled). Neither: it has no delivery of its own (it ends on
   * screen only). Kept with the flight, nothing more.
   */
  due?: number;
  delivered?: boolean;
  /** illustrative data on a non-IP interconnect (opaque.ts): the inspector's rows of it, and its notice (no headers) */
  illustrative?: { title: string; rows: Array<[string, string]>; notice: string };
}

/**
 * What a snooping switch makes of a multicast frame in a VLAN (RFC 4541
 * §2.1): the ports it goes to (null: every port of the VLAN, flooded) and
 * why — its member ports and its multicast router ports (each until when),
 * the kind of frame and the policy that applied.
 */
export interface SnoopResult {
  ports: Set<string> | null;
  /** the group's member ports, until when */
  members: Map<string, number>;
  /** those of them where a leave was heard: they go at their time unless a member answers the group-specific queries */
  leaving?: Set<string>;
  /** the VLAN's multicast router ports (a query or PIM Hello arrived there), until when */
  routers: Map<string, number>;
  /** data: a group's packets; control: a report or leave (to router ports only); linklocal: 224.0.0.0/24, ff02::/16 (flooded); off: snooping disabled or not configured (flooded) */
  kind: 'data' | 'control' | 'linklocal' | 'off';
  /** the VLAN's IGMP / MLD snooping */
  mode: 'enabled' | 'disabled' | 'unset';
  /** unregistered multicast (a group without members): 'router-ports' or 'flood' */
  unregistered: string;
}

/** One port of a multicast forwarding decision: sent there, or not and why (short). */
export interface McPort {
  port: string;
  sent: boolean;
  /** "member port (3 min 20 s left)", "multicast router port", "no member and no router port", "not in VLAN 20", "ingress port" … */
  why: string;
}

/**
 * A device's multicast forwarding decision for one packet: a switch's
 * (Layer 2, per VLAN, by snooping) or a router's (Layer 3, multicast
 * routing). The packet inspector shows it for the hop that arrived there
 * and the hops it sent.
 */
export interface McDecision {
  dev: string;
  t: number;
  layer: 'l2' | 'l3';
  /** the VLAN (0: Layer 3) */
  vlan: number;
  group: string;
  /** the port or interface it came in on (null: the device sent it itself) */
  ingress: string | null;
  /** the rule in a few words: "IGMP snooping enabled, unregistered multicast to router ports" */
  mode: string;
  ports: McPort[];
  /** the outcome in one sentence */
  text: string;
}

export type Cast = 'unicast' | 'broadcast' | 'multicast';

/** A frame's headers, layer by layer, as the packet inspector shows them. */
export interface Headers {
  cast: Cast;
  /** the protocol's profile id (the inspector's colour and title) */
  protocol: string;
  label: string;
  l2: {
    src: string;
    dst: string;
    /** what the destination MAC is ("broadcast", "IPv4 multicast 224.0.0.5 → 01:00:5e:00:00:05") */
    dstNote: string;
    /** the 802.1Q tag on this cable (null: untagged) */
    vlan: number | null;
    /** "IPv4 (0x0800)", "ARP (0x0806)", "IPv6 (0x86dd)", "slow protocols (0x8809)" */
    ethertype: string;
    /** the frame's size on the wire (bytes) */
    bytes: number;
  };
  arp?: { op: string; senderMac: string; senderIp: string; targetMac: string; targetIp: string };
  /** the IP headers, outermost first (an encapsulated packet has several) */
  l3: Array<{ version: 4 | 6; src: string; dst: string; ttl: number; df: boolean; proto: string; len: number; frag?: string; encap?: string; options?: string }>;
  l4?: L4;
  /** what it carries ("OSPF Hello", "Echo request, 56 bytes", the quoted header of an ICMP error) */
  payload: string;
  /** an application protocol's fields as the packet inspector lists them (MQTT, PTP, DHCPv6, router discovery) */
  app?: { title: string; rows: Array<[string, string]> };
  /** why it was sent then: what caused it, and what it waited for */
  causedBy?: string;
  waited?: string[];
}

export type EventKind = 'message' | 'state' | 'drop' | 'route' | 'link' | 'table' | 'note' | 'wait';

/**
 * Why a packet was dropped, recorded where it was decided (the event's
 * text is its presentation, never read back): the kind, the packet (its
 * id, its outer header), and what decided it — an interface, an MTU, a
 * relation, a cable, a policy's rule.
 */
/**
 * What decided a drop, where it was decided: closed-port (nothing listens: a RST, ICMP port unreachable or nothing back),
 * no-answer (it arrived and the device does not answer it: pings off, a listener of another service), not-routed (a host
 * that does not forward), one-way (a device that passes one direction only), gateway (a Security gateway's policy),
 * not-associated (a Wi-Fi client the access point no longer has), not-forwarded (a device that does not carry it by its
 * configuration: an external Layer 3 hop, no multicast, a directed or limited broadcast), unsupported (where the
 * simulation itself stops: a tunneled Wi-Fi network — a limitation, never a failure of the network).
 */
export type DropKind = 'no-route' | 'blackhole' | 'ttl' | 'too-big' | 'policy' | 'iface-down' | 'tunnel-down' | 'relation-failed' | 'neighbor' | 'cable' | 'loss' | 'not-sent' | 'scope' | 'beyond' | 'vlan' | 'inspection' | 'vpn-only' | 'reassembly' | 'closed-port' | 'no-answer' | 'not-routed' | 'one-way' | 'gateway' | 'not-associated' | 'not-forwarded' | 'unsupported' | 'other';

export interface DropCause {
  kind: DropKind;
  /** the packet (Pkt.id: a test's pktIds name it) */
  pkt?: number;
  /** its outer header as decided on: "192.0.2.1 → 198.51.100.2 GRE (47) carrying 10.1.0.10 → 10.2.0.10" */
  flow?: string;
  /** an encapsulated packet: the ids of the packets inside it, innermost last (a test's own packet may be one of them) */
  carried?: number[];
  vrf?: string;
  iface?: string;
  link?: string;
  mtu?: number;
  relation?: string;
  /** the relation (session) the packet was one of — its own keepalive, Hello, handshake: what a session that went down heard nothing of */
  session?: string;
  /** the device that sent the packet (its sender, as recorded when it was first sent) */
  from?: string;
  /** neighbor: the next hop's address that could not be resolved */
  neighbor?: string;
  /** policy: the device whose rules decided, the rule (1-based, as the decision numbers it), its text, the default */
  policy?: { device: string; action: 'deny' | 'reject' | 'undecided'; rule?: number; ruleText?: string; byDefault: boolean; text: string };
}

/**
 * What a test waited for before its packets went (a lease, a DNS answer, a neighbour, a tunnel …): since, until (none:
 * still), and `met` once the condition held — a wait that ended with its test, unmet, has `until` and no `met`.
 */
export interface WaitRecord {
  cond: string;
  why: string;
  since: number;
  until?: number;
  met?: boolean;
}

/**
 * A packet as it was first sent (the packet inspector's frame), by its id: an inner packet's record is the frame that
 * carried it (`layer`: its IP header in the frame's, outermost 0), so a diagnosis' link opens that packet and no other.
 */
export interface PacketRecord {
  hdr: Headers;
  t: number;
  device: string;
  layer: number;
}

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
  /** a message: its headers as sent (the packet inspector) */
  hdr?: Headers;
  /** a message: its sender and origin (Senders: what the log lists) */
  sender?: string;
  origin?: string;
  /** of a Send test (its id): listed whatever the filters, marked Test */
  test?: number;
  /** a drop: why, structured (DropCause) */
  cause?: DropCause;
  /** the packet it is about (Pkt.id) */
  pkt?: number;
  /** an equal-cost choice: which of how many next hops (0-based) the packet's flow took, out of which interface */
  route?: { pkt: number; of: number; index: number; iface: string; gateway?: string };
  /** a message: the relation (session) it belongs to */
  relation?: string;
  /** a state change, structured: what changed ("relation:gre1", "iface:r1:tun0", "link:c3"), up or down, why as recorded, and for a session the last time it heard its peer (-1 never) */
  transition?: Transition;
}

export interface Transition {
  ref: string;
  up: boolean;
  reason?: string;
  /** a session going down: when it last heard its peer (-1: never); the interval it heard nothing in ends at the transition */
  lastHeard?: number;
  /** a session: its device (each end has its own) */
  device?: string;
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

/** A timer of a table, as shown at its top: the value in effect and where it comes from. */
export interface TableTimer {
  label: string;
  /** the value as text ("4 h") */
  value: string;
  source: 'configured' | 'object' | 'device' | 'simulation' | 'default';
  /** the source in words ("default — Cisco IOS (4 h); RFC 826 sets none") */
  origin: string;
}

/** A network event in effect (the Simulation window lists them, each with what ends it). */
/** A connection or socket of a device (its connections table). */
export interface ConnRow {
  proto: 'tcp' | 'udp' | 'icmp';
  local: string;
  remote: string;
  /** TCP: LISTEN, SYN_SENT, ESTABLISHED, FIN_WAIT_1, TIME_WAIT …; UDP / ICMP: waiting, answered */
  state: string;
  /** what it is for ("test web1 tcp/443", "health check", "upstream of 10.0.0.5:49152") */
  what: string;
  age: number;
  /** ms until its timer runs out (a retransmission, TIME_WAIT, keepalive) */
  remaining: number | null;
}

/** A table of the multicast simulation (IGMP groups, a switch's multicast table, multicast routes): its columns and rows. */
export interface GridTable {
  caption: string;
  cols: string[];
  rows: string[][];
  /** shown when there is no row */
  empty: string;
  timers: TableTimer[];
  /** further lines under the timers ("Querier on Vlan10: 10.10.10.2 (this router)") */
  notes: string[];
}

/** A row of a firewall's session table. */
export interface SessionRow {
  /** 'other': an IP protocol without ports (GRE, ESP …), by its address pair */
  proto: 'tcp' | 'udp' | 'icmp' | 'other';
  /** "10.0.0.5:49152 → 10.1.1.10:443" */
  flow: string;
  state: string;
  age: number;
  remaining: number;
  /** what permitted it ("allow tcp/443", "relation https-1") */
  rule: string;
}

export interface NetEvent {
  /** join / leave: a host joined a group, or left one its model joins; stream / stopped: a stream started, or one of the model stopped */
  kind: 'fail' | 'flap' | 'shut' | 'power' | 'engine' | 'join' | 'leave' | 'stream' | 'stopped';
  /** "link:x", "relation:x", "iface:dev:port", "device:x" */
  ref: string;
  /** a join, leave or stream: its group */
  group?: string;
  since: number;
  /** "failed", "down, cycle 2 of 3", "booting (up at t = 70 s)" */
  state: string;
  /** a VM or container that went down with its host (it is not ended by itself) */
  hosted?: boolean;
}

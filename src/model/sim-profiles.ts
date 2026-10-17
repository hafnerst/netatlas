/**
 * The simulation profile of every built-in protocol (Simulate → Start
 * simulation): the messages it exchanges, its transport, its timers with
 * their standard defaults (and where the default comes from), its states,
 * and what it does when a peer or link fails and after the link is
 * restored. Pure data, read by the protocol simulation
 * (analysis/sim/protocols.ts), its window and the documentation; a
 * protocol's registry entry (model/protocols.ts) and its profile share the
 * id.
 *
 * `behaviour` names the state machine the simulation runs for it. Several
 * protocols share one, configured by the profile's own data: the generic
 * `session` (a handshake, then keepalives, down after the dead interval),
 * `service` (request and response, or one-way messages) and `data`
 * (encapsulated traffic only).
 *
 * Timers: `param` names the model value that overrides the default (a
 * parameter of the protocol's relations or of the device's routing
 * service, as written there); `seconds` is the default, used and marked
 * "default" in the event log when the model writes nothing.
 */

import type { Support } from './support';

export type SimGroup = 'Layer 2' | 'Routing' | 'Redundancy' | 'Tunnels and overlays' | 'Services' | 'Custom';
export const SIM_GROUPS: readonly SimGroup[] = ['Layer 2', 'Routing', 'Redundancy', 'Tunnels and overlays', 'Services', 'Custom'];

export type SimBehaviour =
  | 'arp'
  | 'ndp'
  | 'garp'
  /** DHCP: simulated from the servers' scopes and the clients (analysis/sim/netsvc.ts), no relation sessions */
  | 'dhcp-server'
  | 'stp'
  | 'advert'
  | 'lacp'
  | 'ospf'
  | 'isis'
  | 'eigrp'
  | 'rip'
  | 'pim'
  | 'igmp'
  | 'ldp'
  | 'bfd'
  | 'bgp'
  | 'fhrp'
  | 'ike'
  | 'session'
  | 'service'
  | 'data'
  | 'custom';

export interface SimTimer {
  key: string;
  label: string;
  /** the default, in seconds */
  seconds: number;
  /** where the default comes from */
  source: string;
  /** the model value that sets it (a relation parameter `key` or `key.<device>`, or the service's parameter), when there is one */
  param?: string;
}

export interface SimMessage {
  name: string;
  does: string;
}

/** A generic session's handshake step: which end sends what (a: the relation's first endpoint, b: the other). */
export interface HandshakeStep {
  from: 'a' | 'b';
  msg: string;
}

export interface SimProfile {
  id: string;
  label: string;
  group: SimGroup;
  behaviour: SimBehaviour;
  /** what the simulation does for it, and what it leaves out (model/support.ts; filled from SUPPORT below) */
  support?: Support;
  messages: SimMessage[];
  /** how its messages travel: protocol / port, unicast or multicast address, a handshake */
  transport: string;
  timers: SimTimer[];
  /** its states, in the order a session goes through them */
  states: string[];
  failure: string;
  restore: string;
  /** session: the handshake (before Up) */
  handshake?: HandshakeStep[];
  /** session / advert: the keepalive (its reply, if any) */
  keepalive?: { msg: string; reply?: string; both?: boolean };
  /** service: the request and its response (none: one-way) */
  request?: string;
  response?: string;
  /** service: the last endpoint sends the requests (SNMP: the manager polls the agents) */
  fromServer?: boolean;
  /** messages that carry data (data, tunnels): their name */
  dataMsg?: string;
  /** an encapsulation header the protocol adds ("GRE", "ESP", "VXLAN") */
  encap?: string;
  /** the transport's short form for the event log ("UDP 3784", "IP 89") */
  proto: string;
  /** a well-known multicast group or MAC address the protocol sends to */
  group4?: string;
  group6?: string;
  mac?: string;
}

const T = (key: string, label: string, seconds: number, source: string, param?: string): SimTimer => ({ key, label, seconds, source, param });

/** The fixed interval of the demonstration traffic of services (their real traffic is on demand). */
export const SERVICE_DEMO = 'demonstration interval (the real traffic is on demand)';

export const SIM_PROFILES: readonly SimProfile[] = [
  // ------------------------------------------------------------ Layer 2
  {
    id: 'arp',
    label: 'ARP',
    group: 'Layer 2',
    behaviour: 'arp',
    messages: [
      { name: 'ARP Request', does: '“Who has 10.0.0.2? Tell 10.0.0.1”: broadcast in the VLAN before the first unicast IPv4 packet to a next hop' },
      { name: 'ARP Reply', does: '“10.0.0.2 is at 02:1a:…”: unicast from the owner of the address' },
    ],
    transport: 'Ethernet type 0x0806; request to ff:ff:ff:ff:ff:ff, reply unicast',
    proto: 'ARP',
    mac: 'ff:ff:ff:ff:ff:ff',
    timers: [
      T('arp-timeout', 'ARP entry timeout', 14400, 'Cisco IOS default (4 h); RFC 826 sets none', 'arp_timeout'),
      T('retrans', 'Retransmit interval', 1, 'RFC 4861 RETRANS_TIMER, used for ARP as well'),
      T('retries', 'Requests before an incomplete entry is dropped', 3, 'RFC 4861 MAX_MULTICAST_SOLICIT, used for ARP as well'),
    ],
    states: ['incomplete', 'dynamic (valid)', 'refreshing', 'expired'],
    failure: 'Entries stay until they expire; one whose owner no longer answers when it is refreshed is dropped. Entries of an interface that goes down are removed at once.',
    restore: 'The next packet to the neighbour resolves it again (ARP Request, ARP Reply).',
  },
  {
    id: 'ndp',
    label: 'NDP',
    group: 'Layer 2',
    behaviour: 'ndp',
    messages: [
      { name: 'Neighbor Solicitation', does: 'to the solicited-node multicast address ff02::1:ffXX:XXXX of the target, before the first unicast IPv6 packet' },
      { name: 'Neighbor Advertisement', does: 'the answer, with the target’s link-layer (MAC) address; unsolicited when an interface comes up' },
    ],
    transport: 'ICMPv6 types 135 / 136; solicitation to 33:33:ff:XX:XX:XX, advertisement unicast',
    proto: 'ICMPv6',
    timers: [
      T('reachable', 'Reachable time', 30, 'RFC 4861 REACHABLE_TIME (30 000 ms)', 'ndp_reachable_time'),
      T('retrans', 'Retransmit interval', 1, 'RFC 4861 RETRANS_TIMER (1 000 ms)'),
      T('retries', 'Solicitations before an incomplete entry is dropped', 3, 'RFC 4861 MAX_MULTICAST_SOLICIT / MAX_UNICAST_SOLICIT'),
      T('delay', 'Delay before the first probe', 5, 'RFC 4861 DELAY_FIRST_PROBE_TIME'),
    ],
    states: ['INCOMPLETE', 'REACHABLE', 'STALE', 'DELAY', 'PROBE'],
    failure: 'A neighbour that stops answering goes STALE, then DELAY and PROBE (three unicast solicitations), and is removed. Entries of an interface that goes down are removed at once.',
    restore: 'The next packet resolves it again (Neighbor Solicitation, Neighbor Advertisement).',
  },
  {
    id: 'garp',
    label: 'Gratuitous ARP',
    group: 'Layer 2',
    behaviour: 'garp',
    messages: [
      { name: 'Gratuitous ARP', does: 'an ARP for the sender’s own address, broadcast when an interface comes up and when a VRRP / HSRP master changes (with the virtual MAC)' },
      { name: 'Unsolicited Neighbor Advertisement', does: 'the IPv6 counterpart, to ff02::1' },
    ],
    transport: 'ARP to ff:ff:ff:ff:ff:ff; IPv6: ICMPv6 136 to ff02::1 (33:33:00:00:00:01)',
    proto: 'ARP',
    timers: [],
    states: ['sent'],
    failure: 'A new master announces the virtual MAC at once, so switches learn its new port and hosts keep their entry.',
    restore: 'An interface that comes up announces itself again.',
  },
  {
    id: 'stp',
    label: 'STP (RSTP)',
    group: 'Layer 2',
    behaviour: 'stp',
    messages: [{ name: 'BPDU', does: 'Configuration BPDU from the root and the designated bridges, every hello time' }],
    transport: 'IEEE 802.1D / 802.1w BPDU to 01:80:c2:00:00:00 (not forwarded by bridges)',
    proto: 'LLC',
    mac: '01:80:c2:00:00:00',
    timers: [T('hello', 'Hello time', 2, 'IEEE 802.1D / 802.1w default'), T('max-age', 'Max age', 20, 'IEEE 802.1D default'), T('forward-delay', 'Forward delay', 15, 'IEEE 802.1D default')],
    states: ['Discarding', 'Learning', 'Forwarding'],
    failure: 'When a link of the tree fails, an alternate port takes over (rapid transition) and the MAC tables are flushed.',
    restore: 'The restored link becomes an alternate port again; the tree is recomputed and the MAC tables flushed.',
  },
  {
    id: 'lldp',
    label: 'LLDP',
    group: 'Layer 2',
    behaviour: 'advert',
    messages: [{ name: 'LLDPDU', does: 'system and port description to the directly connected neighbour' }],
    transport: 'IEEE 802.1AB, Ethernet type 0x88cc to 01:80:c2:00:00:0e (not forwarded)',
    proto: 'LLDP',
    mac: '01:80:c2:00:00:0e',
    keepalive: { msg: 'LLDPDU', both: true },
    timers: [T('hello', 'Transmit interval', 30, 'IEEE 802.1AB msgTxInterval'), T('dead', 'TTL (4 × interval)', 120, 'IEEE 802.1AB msgTxHold 4')],
    states: ['no neighbour', 'neighbour known'],
    failure: 'The neighbour entry ages out after its TTL.',
    restore: 'The next LLDPDU recreates it.',
  },
  {
    id: 'cdp',
    label: 'CDP',
    group: 'Layer 2',
    behaviour: 'advert',
    messages: [{ name: 'CDP Advertisement', does: 'device and port information to the directly connected neighbour' }],
    transport: 'SNAP to 01:00:0c:cc:cc:cc (not forwarded)',
    proto: 'SNAP',
    mac: '01:00:0c:cc:cc:cc',
    keepalive: { msg: 'CDP Advertisement', both: true },
    timers: [T('hello', 'Timer', 60, 'Cisco default'), T('dead', 'Holdtime', 180, 'Cisco default')],
    states: ['no neighbour', 'neighbour known'],
    failure: 'The neighbour entry ages out after the holdtime.',
    restore: 'The next advertisement recreates it.',
  },
  {
    id: 'lacp',
    label: 'LACP',
    group: 'Layer 2',
    behaviour: 'lacp',
    messages: [{ name: 'LACPDU', does: 'actor and partner state of each member link, both ways' }],
    transport: 'Slow protocols, Ethernet type 0x8809 to 01:80:c2:00:00:02 (per member link)',
    proto: 'LACP',
    mac: '01:80:c2:00:00:02',
    timers: [T('hello', 'Periodic time (slow)', 30, 'IEEE 802.1AX slow periodic time'), T('dead', 'Timeout (3 × periodic)', 90, 'IEEE 802.1AX long timeout')],
    states: ['Detached', 'Attached', 'Collecting / Distributing'],
    failure: 'A member whose link goes down is detached at once; the aggregate stays up while min_links members are (degraded).',
    restore: 'The member exchanges LACPDUs again and is added back to the aggregate.',
  },
  {
    id: 'mlag',
    label: 'MLAG / vPC',
    group: 'Redundancy',
    behaviour: 'session',
    messages: [
      { name: 'Peer keepalive', does: 'liveness of the peer, both ways' },
      { name: 'Config sync', does: 'the peers agree on their roles once' },
    ],
    transport: 'UDP 3200 between the peers',
    proto: 'UDP 3200',
    handshake: [
      { from: 'a', msg: 'Config sync' },
      { from: 'b', msg: 'Config sync' },
    ],
    keepalive: { msg: 'Peer keepalive', both: true },
    timers: [T('hello', 'Keepalive interval', 1, 'Cisco vPC default'), T('dead', 'Keepalive timeout', 5, 'Cisco vPC default')],
    states: ['Down', 'Peer alive (primary / secondary)'],
    failure: 'Without keepalives the secondary assumes the peer is gone.',
    restore: 'The peers sync again and resume their roles.',
  },
  // ------------------------------------------------------------ routing
  {
    id: 'ospf',
    label: 'OSPF',
    group: 'Routing',
    behaviour: 'ospf',
    messages: [
      { name: 'Hello', does: 'discovers neighbours and keeps the adjacency alive; elects DR and BDR on a multi-access network' },
      { name: 'DBD', does: 'Database Description: the summary of the link-state database (ExStart, Exchange)' },
      { name: 'LSR', does: 'Link-State Request for the LSAs it lacks (Loading)' },
      { name: 'LSU', does: 'Link-State Update carrying LSAs; flooded again when the topology changes' },
      { name: 'LSAck', does: 'acknowledges an LSU' },
    ],
    transport: 'IP protocol 89; Hello and LSU to 224.0.0.5 / ff02::5 (AllSPFRouters), DBD and LSR unicast',
    proto: 'IP 89',
    group4: '224.0.0.5',
    group6: 'ff02::5',
    timers: [T('hello', 'Hello interval', 10, 'RFC 2328 Appendix C.3', 'hello'), T('dead', 'Router dead interval', 40, 'RFC 2328 Appendix C.3 (4 × hello)', 'dead'), T('rxmt', 'Retransmit interval', 5, 'RFC 2328 Appendix C.3')],
    states: ['Down', 'Init', '2-Way', 'ExStart', 'Exchange', 'Loading', 'Full'],
    failure: 'Hellos are lost; after the dead interval the neighbour goes Down, the router floods an LSU with its new router LSA and the routes are recomputed (reconvergence).',
    restore: 'Hellos meet again: Init, 2-Way, ExStart (DBD), Exchange, Loading (LSR, LSU, LSAck), Full; LSUs flood the change and the routes are recomputed.',
  },
  {
    id: 'isis',
    label: 'IS-IS',
    group: 'Routing',
    behaviour: 'isis',
    messages: [
      { name: 'IIH', does: 'IS-IS Hello: discovers and keeps the adjacency' },
      { name: 'LSP', does: 'Link State PDU, flooded' },
      { name: 'CSNP', does: 'Complete Sequence Numbers PDU: the database summary (by the DIS, and once on point-to-point links)' },
      { name: 'PSNP', does: 'Partial Sequence Numbers PDU: requests or acknowledges LSPs' },
    ],
    transport: 'directly on the link layer (no IP): 01:80:c2:00:00:14 / 15 (AllL1ISs / AllL2ISs)',
    proto: 'IS-IS (LLC)',
    mac: '01:80:c2:00:00:15',
    timers: [T('hello', 'Hello interval', 10, 'ISO/IEC 10589 / common default'), T('dead', 'Holding time (3 × hello)', 30, 'ISO/IEC 10589 / common default'), T('csnp', 'CSNP interval', 10, 'common default')],
    states: ['Down', 'Initializing', 'Up'],
    failure: 'After the holding time the adjacency goes Down, a new LSP is flooded and the routes are recomputed.',
    restore: 'IIHs bring it Up again (three-way), CSNP / PSNP / LSP synchronise the database.',
  },
  {
    id: 'eigrp',
    label: 'EIGRP',
    group: 'Routing',
    behaviour: 'eigrp',
    messages: [
      { name: 'Hello', does: 'discovers neighbours and keeps them' },
      { name: 'Update', does: 'routes, reliably (with an ACK); the first carries the init flag' },
      { name: 'Query', does: 'asks the neighbours for another way when a route is lost' },
      { name: 'Reply', does: 'answers a query' },
      { name: 'ACK', does: 'acknowledges a reliable packet' },
    ],
    transport: 'IP protocol 88; Hello to 224.0.0.10 / ff02::a, Update / Query multicast or unicast, ACK unicast',
    proto: 'IP 88',
    group4: '224.0.0.10',
    group6: 'ff02::a',
    timers: [T('hello', 'Hello interval', 5, 'RFC 7868 (high-bandwidth links)'), T('dead', 'Hold time', 15, 'RFC 7868 (3 × hello)')],
    states: ['Down', 'Pending', 'Up'],
    failure: 'After the hold time the neighbour goes Down; Query to the other neighbours, Reply, then the routes are recomputed.',
    restore: 'Hello, Update with init and ACK both ways: Up, then Updates for the routes.',
  },
  {
    id: 'rip',
    label: 'RIP',
    group: 'Routing',
    behaviour: 'rip',
    messages: [
      { name: 'Request', does: 'asks the neighbours for their table, once at start' },
      { name: 'Response', does: 'the table: periodic, and triggered by a change' },
    ],
    transport: 'UDP 520 to 224.0.0.9 (RIPv2); RIPng UDP 521 to ff02::9',
    proto: 'UDP 520',
    group4: '224.0.0.9',
    group6: 'ff02::9',
    timers: [T('hello', 'Update timer', 30, 'RFC 2453'), T('dead', 'Timeout', 180, 'RFC 2453')],
    states: ['Down', 'Heard'],
    failure: 'Responses stop; after the timeout the neighbour’s routes are dropped and a triggered Response tells the others.',
    restore: 'The next Response brings the routes back (a triggered Response follows).',
  },
  {
    id: 'bgp',
    label: 'BGP',
    group: 'Routing',
    behaviour: 'bgp',
    messages: [
      { name: 'TCP SYN / SYN-ACK / ACK', does: 'the TCP handshake to port 179' },
      { name: 'OPEN', does: 'AS number, hold time, router ID, capabilities' },
      { name: 'KEEPALIVE', does: 'confirms OPEN, then keeps the session alive' },
      { name: 'UPDATE', does: 'advertises reachable prefixes, or withdraws them' },
      { name: 'NOTIFICATION', does: 'reports an error and closes the session (hold timer expired)' },
    ],
    transport: 'TCP 179, unicast between the peers (often loopbacks, reached over the IGP)',
    proto: 'TCP 179',
    timers: [T('hold', 'Hold time', 90, 'RFC 4271 §10 (suggested)'), T('keepalive', 'Keepalive time', 30, 'RFC 4271 §10 (hold time / 3)'), T('connect-retry', 'ConnectRetry time', 120, 'RFC 4271 §10 (suggested)')],
    states: ['Idle', 'Connect', 'Active', 'OpenSent', 'OpenConfirm', 'Established'],
    failure: 'KEEPALIVEs are lost; when the hold time expires the session sends NOTIFICATION and goes Idle, and UPDATEs withdraw its prefixes from the other peers. (With BFD, the session goes down as soon as BFD does.)',
    restore: 'Once the peer is reachable again: TCP handshake, OPEN, KEEPALIVE, Established, UPDATEs.',
  },
  {
    id: 'ldp',
    label: 'LDP',
    group: 'Routing',
    behaviour: 'ldp',
    messages: [
      { name: 'Hello', does: 'discovers LDP peers on the link' },
      { name: 'Initialization', does: 'opens the session over TCP' },
      { name: 'Keepalive', does: 'keeps the session' },
      { name: 'Address', does: 'the peer’s interface addresses' },
      { name: 'Label Mapping', does: 'a label for each prefix (FEC)' },
    ],
    transport: 'Hello UDP 646 to 224.0.0.2; session TCP 646',
    proto: 'UDP/TCP 646',
    group4: '224.0.0.2',
    timers: [T('hello', 'Link hello interval', 5, 'RFC 5036 / common default'), T('dead', 'Hello hold time', 15, 'RFC 5036 (3 × hello)'), T('keepalive', 'Keepalive interval', 60, 'common default'), T('hold', 'Session hold time', 180, 'common default')],
    states: ['Non-existent', 'Initialized', 'OpenSent', 'OpenRec', 'Operational'],
    failure: 'The hello hold time expires; the session closes and the labels are withdrawn.',
    restore: 'Hello, TCP, Initialization, Keepalive, Address and Label Mapping again: Operational.',
  },
  {
    id: 'pim',
    label: 'PIM',
    group: 'Routing',
    behaviour: 'pim',
    messages: [
      { name: 'Hello', does: 'discovers PIM neighbours (and elects the DR)' },
      { name: 'Join/Prune', does: 'joins the shared tree towards the RP (or the source), hop by hop, for a group with receivers' },
      { name: 'Register', does: 'the source’s DR sends the first multicast packets to the RP, unicast' },
      { name: 'Register-Stop', does: 'the RP stops the registration once it receives natively' },
      { name: 'Bootstrap', does: 'the RP announcements (BSR), flooded hop by hop' },
    ],
    transport: 'IP protocol 103; Hello and Join/Prune to 224.0.0.13 / ff02::d, Register unicast',
    proto: 'IP 103',
    group4: '224.0.0.13',
    group6: 'ff02::d',
    timers: [T('hello', 'Hello period', 30, 'RFC 7761'), T('dead', 'Hello holdtime', 105, 'RFC 7761 (3.5 × hello)'), T('join', 'Join/Prune period', 60, 'RFC 7761'), T('bsr', 'Bootstrap period', 60, 'RFC 5059')],
    states: ['No neighbour', 'Neighbour', 'Joined'],
    failure: 'Hellos stop; after the holdtime the neighbour is gone and the joins take the other way (when there is one).',
    restore: 'Hello again, then the next Join/Prune rebuilds the tree.',
  },
  {
    id: 'igmp',
    label: 'IGMP / MLD',
    group: 'Routing',
    behaviour: 'igmp',
    messages: [
      { name: 'Membership Query', does: 'the router asks which groups have members on the LAN' },
      { name: 'Membership Report', does: 'a receiver joins a group (and answers queries)' },
      { name: 'Leave Group', does: 'a receiver leaves' },
    ],
    transport: 'IP protocol 2 (IGMPv2 / v3) to 224.0.0.1 and the group; MLD: ICMPv6 to ff02::1',
    proto: 'IP 2',
    group4: '224.0.0.1',
    timers: [T('query', 'Query interval', 125, 'RFC 3376'), T('dead', 'Group membership interval', 260, 'RFC 3376')],
    states: ['No members', 'Members'],
    failure: 'Without reports the group membership times out.',
    restore: 'The receiver reports again.',
  },
  {
    id: 'bfd',
    label: 'BFD',
    group: 'Routing',
    behaviour: 'bfd',
    messages: [{ name: 'Control', does: 'Control packets both ways at the negotiated rate; each carries the sender’s state' }],
    transport: 'UDP 3784 (single hop), unicast between the peers',
    proto: 'UDP 3784',
    timers: [T('interval', 'Transmit interval', 1, 'RFC 5880 sets none; 1 s, the slow rate RFC 5880 §6.8.3 requires before the session is up', 'interval'), T('multiplier', 'Detect multiplier', 3, 'common default', 'multiplier')],
    states: ['Down', 'Init', 'Up'],
    failure: 'After interval × multiplier without a Control packet the session goes Down and tells the protocols using it (OSPF, BGP …) at once.',
    restore: 'Down, Init, Up in a three-way exchange; the protocols may form their adjacencies again.',
  },
  // ------------------------------------------------------------ redundancy
  {
    id: 'vrrp',
    label: 'VRRP',
    group: 'Redundancy',
    behaviour: 'fhrp',
    messages: [{ name: 'Advertisement', does: 'the master’s priority, every advertisement interval' }],
    transport: 'IP protocol 112 to 224.0.0.18 / ff02::12; virtual MAC 00:00:5e:00:01:VRID',
    proto: 'IP 112',
    group4: '224.0.0.18',
    group6: 'ff02::12',
    timers: [T('hello', 'Advertisement interval', 1, 'RFC 5798'), T('dead', 'Master down interval (3 × interval + skew)', 3, 'RFC 5798 §6.1')],
    states: ['Initialize', 'Backup', 'Master'],
    failure: 'The backup misses three advertisements, becomes Master and sends a gratuitous ARP for the virtual address with the virtual MAC.',
    restore: 'A higher-priority member that preempts becomes Master again (with a gratuitous ARP).',
  },
  {
    id: 'hsrp',
    label: 'HSRP',
    group: 'Redundancy',
    behaviour: 'fhrp',
    messages: [{ name: 'Hello', does: 'state and priority, from the active and the standby router' }],
    transport: 'UDP 1985 to 224.0.0.2 (v1); virtual MAC 00:00:0c:07:ac:GG',
    proto: 'UDP 1985',
    group4: '224.0.0.2',
    timers: [T('hello', 'Hello time', 3, 'RFC 2281'), T('dead', 'Hold time', 10, 'RFC 2281')],
    states: ['Initial', 'Listen', 'Speak', 'Standby', 'Active'],
    failure: 'The standby router misses hellos for the hold time, becomes Active and sends a gratuitous ARP with the virtual MAC.',
    restore: 'A preempting higher-priority router becomes Active again.',
  },
  {
    id: 'glbp',
    label: 'GLBP',
    group: 'Redundancy',
    behaviour: 'fhrp',
    messages: [{ name: 'Hello', does: 'the AVG and the forwarders announce themselves' }],
    transport: 'UDP 3222 to 224.0.0.102; virtual MACs 00:07:b4:…',
    proto: 'UDP 3222',
    group4: '224.0.0.102',
    timers: [T('hello', 'Hello time', 3, 'Cisco default'), T('dead', 'Hold time', 10, 'Cisco default')],
    states: ['Listen', 'Speak', 'Standby', 'Active'],
    failure: 'The standby AVG takes over the virtual address after the hold time.',
    restore: 'A preempting higher-priority gateway becomes AVG again.',
  },
  {
    id: 'carp',
    label: 'CARP',
    group: 'Redundancy',
    behaviour: 'fhrp',
    messages: [{ name: 'Advertisement', does: 'the master’s advertisement base and skew' }],
    transport: 'IP protocol 112 to 224.0.0.18; virtual MAC 00:00:5e:00:01:VHID',
    proto: 'IP 112',
    group4: '224.0.0.18',
    timers: [T('hello', 'Advertisement base', 1, 'OpenBSD carp(4) default'), T('dead', 'Master down (3 × advertisement)', 3, 'OpenBSD carp(4)')],
    states: ['Init', 'Backup', 'Master'],
    failure: 'The backup becomes master after three missed advertisements and sends a gratuitous ARP.',
    restore: 'The preempting member becomes master again.',
  },
  {
    id: 'ha-sync',
    label: 'HA sync',
    group: 'Redundancy',
    behaviour: 'session',
    messages: [
      { name: 'Heartbeat', does: 'liveness of the cluster peer' },
      { name: 'Sync', does: 'configuration and session state' },
    ],
    transport: 'the vendor’s HA link (unicast)',
    proto: 'HA',
    handshake: [
      { from: 'a', msg: 'Sync' },
      { from: 'b', msg: 'Sync' },
    ],
    keepalive: { msg: 'Heartbeat', both: true },
    timers: [T('hello', 'Heartbeat interval', 1, 'common default'), T('dead', 'Failover after', 3, 'common default (3 missed heartbeats)')],
    states: ['Down', 'Synchronised'],
    failure: 'Missed heartbeats: the standby takes over.',
    restore: 'The peers synchronise again.',
  },
  // ------------------------------------------------------------ tunnels and overlays
  {
    id: 'ipsec',
    label: 'IPsec (IKEv2)',
    group: 'Tunnels and overlays',
    behaviour: 'ike',
    messages: [
      { name: 'IKE_SA_INIT', does: 'request and response: algorithms, Diffie-Hellman, nonces' },
      { name: 'IKE_AUTH', does: 'request and response: identities, authentication, the first Child SA' },
      { name: 'CREATE_CHILD_SA', does: 'rekeys the Child SA before its lifetime ends' },
      { name: 'INFORMATIONAL', does: 'Dead Peer Detection: an empty request, answered while the peer is alive' },
      { name: 'ESP', does: 'the protected traffic (what runs over the tunnel, e.g. GRE)' },
    ],
    transport: 'IKE UDP 500 (4500 behind NAT); ESP IP protocol 50',
    proto: 'UDP 500',
    encap: 'ESP',
    dataMsg: 'ESP',
    timers: [T('dpd', 'DPD interval', 10, 'common default (RFC 7296 sets none)'), T('dpd-retries', 'DPD retries', 3, 'common default'), T('child-lifetime', 'Child SA lifetime', 3600, 'common default (rekeyed before it ends)'), T('ike-lifetime', 'IKE SA lifetime', 86400, 'common default')],
    states: ['Idle', 'IKE_SA_INIT', 'IKE_AUTH', 'Established'],
    failure: 'ESP and DPD requests are lost; after the DPD retries the SAs are deleted (traffic over the tunnel is lost).',
    restore: 'IKE_SA_INIT and IKE_AUTH again: the SAs are re-established.',
  },
  {
    id: 'gre',
    label: 'GRE',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'Keepalive', does: 'a GRE packet that the peer sends back (when keepalives are on)' },
      { name: 'GRE', does: 'encapsulated packets (OSPF, data …)' },
    ],
    transport: 'IP protocol 47, unicast between the tunnel’s source and destination',
    proto: 'IP 47',
    encap: 'GRE',
    dataMsg: 'GRE',
    keepalive: { msg: 'Keepalive', reply: 'Keepalive reply' },
    timers: [T('hello', 'Keepalive interval', 10, 'Cisco “keepalive 10 3”'), T('dead', 'Down after (3 × interval)', 30, 'Cisco “keepalive 10 3”')],
    states: ['Down', 'Up'],
    failure: 'Keepalives are not answered: after three the tunnel interface goes down.',
    restore: 'The first answered keepalive brings it up again.',
  },
  {
    id: 'ipip',
    label: 'IP-in-IP',
    group: 'Tunnels and overlays',
    behaviour: 'data',
    messages: [{ name: 'IP-in-IP', does: 'encapsulated packets; no control messages' }],
    transport: 'IP protocol 4',
    proto: 'IP 4',
    encap: 'IPIP',
    dataMsg: 'IP-in-IP packet',
    timers: [T('hello', 'Demonstration packet interval', 5, SERVICE_DEMO)],
    states: ['Up'],
    failure: 'Packets are lost where they meet the failure (no control protocol notices it).',
    restore: 'Packets pass again.',
  },
  {
    id: 'wireguard',
    label: 'WireGuard',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'Handshake Initiation', does: 'starts a session (and every 2 minutes after)' },
      { name: 'Handshake Response', does: 'completes it' },
      { name: 'Keepalive', does: 'an empty data packet' },
      { name: 'Data', does: 'encrypted traffic' },
    ],
    transport: 'UDP (51820 by convention)',
    proto: 'UDP 51820',
    encap: 'WireGuard',
    dataMsg: 'WireGuard data',
    handshake: [
      { from: 'a', msg: 'Handshake Initiation' },
      { from: 'b', msg: 'Handshake Response' },
    ],
    keepalive: { msg: 'Keepalive', both: true },
    timers: [T('hello', 'Persistent keepalive', 25, 'the usual persistent-keepalive (WireGuard has none by default)'), T('dead', 'Handshake considered dead', 180, 'WireGuard REJECT_AFTER_TIME'), T('rekey', 'Rekey after', 120, 'WireGuard REKEY_AFTER_TIME')],
    states: ['No session', 'Handshake', 'Session'],
    failure: 'Keepalives are lost; without an answered handshake the session expires.',
    restore: 'A new Handshake Initiation / Response.',
  },
  {
    id: 'openvpn',
    label: 'OpenVPN',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'P_CONTROL_HARD_RESET_CLIENT_V2', does: 'the client starts' },
      { name: 'P_CONTROL_HARD_RESET_SERVER_V2', does: 'the server answers' },
      { name: 'P_CONTROL (TLS)', does: 'the TLS handshake in control packets' },
      { name: 'P_DATA (ping)', does: 'keepalive pings and data' },
    ],
    transport: 'UDP 1194',
    proto: 'UDP 1194',
    encap: 'OpenVPN',
    dataMsg: 'P_DATA',
    handshake: [
      { from: 'a', msg: 'P_CONTROL_HARD_RESET_CLIENT_V2' },
      { from: 'b', msg: 'P_CONTROL_HARD_RESET_SERVER_V2' },
      { from: 'a', msg: 'P_CONTROL (TLS ClientHello)' },
      { from: 'b', msg: 'P_CONTROL (TLS ServerHello)' },
    ],
    keepalive: { msg: 'P_DATA (ping)', both: true },
    timers: [T('hello', 'Ping', 10, 'the common “keepalive 10 60”'), T('dead', 'Ping restart', 60, 'the common “keepalive 10 60”')],
    states: ['Down', 'TLS handshake', 'Up'],
    failure: 'Pings are lost; after the restart time the session restarts.',
    restore: 'Hard reset and TLS handshake again.',
  },
  {
    id: 'l2tp',
    label: 'L2TP',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'SCCRQ / SCCRP / SCCCN', does: 'control connection set-up' },
      { name: 'ICRQ / ICRP / ICCN', does: 'session set-up' },
      { name: 'HELLO', does: 'keepalive of the control connection' },
    ],
    transport: 'UDP 1701 (L2TPv2) / IP protocol 115 (L2TPv3)',
    proto: 'UDP 1701',
    encap: 'L2TP',
    dataMsg: 'L2TP data',
    handshake: [
      { from: 'a', msg: 'SCCRQ' },
      { from: 'b', msg: 'SCCRP' },
      { from: 'a', msg: 'SCCCN' },
      { from: 'a', msg: 'ICRQ' },
      { from: 'b', msg: 'ICRP' },
      { from: 'a', msg: 'ICCN' },
    ],
    keepalive: { msg: 'HELLO', reply: 'ZLB ACK' },
    timers: [T('hello', 'Hello interval', 60, 'common default'), T('dead', 'Down after', 180, 'common default (3 × hello)')],
    states: ['Idle', 'Wait-ctl-reply', 'Established'],
    failure: 'HELLOs are not acknowledged: the tunnel is torn down.',
    restore: 'Control connection and session set up again.',
  },
  {
    id: 'dmvpn',
    label: 'DMVPN',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'NHRP Registration Request', does: 'a spoke registers its address at the hub' },
      { name: 'NHRP Registration Reply', does: 'the hub confirms' },
      { name: 'NHRP Resolution Request / Reply', does: 'spoke-to-spoke address resolution' },
    ],
    transport: 'NHRP over mGRE (usually inside IPsec)',
    proto: 'NHRP',
    encap: 'mGRE',
    dataMsg: 'mGRE',
    handshake: [
      { from: 'a', msg: 'NHRP Registration Request' },
      { from: 'b', msg: 'NHRP Registration Reply' },
    ],
    keepalive: { msg: 'NHRP Registration Request', reply: 'NHRP Registration Reply' },
    timers: [T('hello', 'Registration interval (holdtime / 3)', 2400, 'Cisco default (holdtime 7200 s)'), T('dead', 'Holdtime', 7200, 'Cisco default')],
    states: ['Not registered', 'Registered'],
    failure: 'Registrations are lost; the hub drops the spoke after the holdtime.',
    restore: 'The spoke registers again.',
  },
  {
    id: 'gtp',
    label: 'GTP',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'Echo Request', does: 'path management between GTP peers' },
      { name: 'Echo Response', does: 'its answer' },
      { name: 'G-PDU', does: 'user traffic in GTP-U' },
    ],
    transport: 'GTP-U UDP 2152 (GTP-C UDP 2123)',
    proto: 'UDP 2152',
    encap: 'GTP-U',
    dataMsg: 'G-PDU',
    keepalive: { msg: 'Echo Request', reply: 'Echo Response' },
    timers: [T('hello', 'Echo interval', 60, '3GPP TS 29.281 (at least 60 s)'), T('dead', 'Path failure after', 180, 'common default (3 unanswered)')],
    states: ['Path down', 'Path up'],
    failure: 'Unanswered echoes: path failure.',
    restore: 'An answered echo: path up.',
  },
  {
    id: 'rsvp-te',
    label: 'RSVP-TE',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'Path', does: 'from the head end downstream, hop by hop, with the explicit route' },
      { name: 'Resv', does: 'from the tail end upstream, with the labels' },
      { name: 'PathTear / ResvTear', does: 'remove the LSP' },
    ],
    transport: 'IP protocol 46',
    proto: 'IP 46',
    encap: 'MPLS',
    dataMsg: 'MPLS',
    handshake: [
      { from: 'a', msg: 'Path' },
      { from: 'b', msg: 'Resv' },
    ],
    keepalive: { msg: 'Path', reply: 'Resv' },
    timers: [T('hello', 'Refresh interval', 30, 'RFC 2205 (R)'), T('dead', 'State lifetime', 90, 'RFC 2205 (≈ 3 × R)')],
    states: ['Down', 'Path sent', 'Up'],
    failure: 'Refreshes are lost; the LSP state times out (a backup path would be signalled).',
    restore: 'Path and Resv set the LSP up again.',
  },
  {
    id: 'sr-te',
    label: 'SR-TE',
    group: 'Tunnels and overlays',
    behaviour: 'data',
    messages: [{ name: 'SR data', does: 'packets with the policy’s segment list (no signalling in the network)' }],
    transport: 'MPLS label stack or SRv6 header',
    proto: 'MPLS',
    encap: 'SR',
    dataMsg: 'SR data',
    timers: [T('hello', 'Demonstration packet interval', 5, SERVICE_DEMO)],
    states: ['Up'],
    failure: 'Packets are lost where the path is broken (no signalling notices it).',
    restore: 'Packets pass again.',
  },
  {
    id: 'pseudowire',
    label: 'Pseudowire',
    group: 'Tunnels and overlays',
    behaviour: 'ldp',
    messages: [
      { name: 'Targeted Hello', does: 'LDP hello to the remote PE (unicast)' },
      { name: 'Initialization', does: 'opens the targeted LDP session' },
      { name: 'Label Mapping (PW)', does: 'the pseudowire label (FEC 128, the PW id)' },
      { name: 'Keepalive', does: 'keeps the session' },
    ],
    transport: 'targeted LDP: UDP / TCP 646 unicast between the PEs; frames in MPLS',
    proto: 'UDP/TCP 646',
    encap: 'MPLS',
    dataMsg: 'PW frame',
    timers: [T('hello', 'Targeted hello interval', 15, 'RFC 5036 / common default'), T('dead', 'Targeted hello hold time', 45, 'RFC 5036 (3 × hello)'), T('keepalive', 'Keepalive interval', 60, 'common default'), T('hold', 'Session hold time', 180, 'common default')],
    states: ['Non-existent', 'Initialized', 'Operational'],
    failure: 'The targeted session times out; the pseudowire goes down.',
    restore: 'The session and the label mapping are set up again.',
  },
  {
    id: 'ssl-vpn',
    label: 'SSL VPN',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'TCP SYN / SYN-ACK / ACK', does: 'to port 443' },
      { name: 'TLS ClientHello / ServerHello / Finished', does: 'the TLS handshake' },
      { name: 'DPD', does: 'dead peer detection' },
      { name: 'Application Data', does: 'the tunnelled traffic' },
    ],
    transport: 'TCP 443 (DTLS UDP 443 for data)',
    proto: 'TCP 443',
    encap: 'TLS',
    dataMsg: 'Application Data',
    handshake: [
      { from: 'a', msg: 'TCP SYN' },
      { from: 'b', msg: 'TCP SYN-ACK' },
      { from: 'a', msg: 'TCP ACK' },
      { from: 'a', msg: 'TLS ClientHello' },
      { from: 'b', msg: 'TLS ServerHello' },
      { from: 'a', msg: 'TLS Finished' },
    ],
    keepalive: { msg: 'DPD', reply: 'DPD reply' },
    timers: [T('hello', 'DPD interval', 30, 'common default'), T('dead', 'Down after', 90, 'common default (3 × DPD)')],
    states: ['Down', 'TLS handshake', 'Up'],
    failure: 'DPD is not answered: the tunnel is down.',
    restore: 'TCP and TLS handshake again.',
  },
  {
    id: 'vxlan',
    label: 'VXLAN',
    group: 'Tunnels and overlays',
    behaviour: 'data',
    messages: [{ name: 'VXLAN frame', does: 'Ethernet frames of the VNI between the VTEPs (with EVPN as the control plane, or flood and learn)' }],
    transport: 'UDP 4789 between the VTEPs',
    proto: 'UDP 4789',
    encap: 'VXLAN',
    dataMsg: 'VXLAN frame',
    timers: [T('hello', 'Demonstration packet interval', 5, SERVICE_DEMO)],
    states: ['Up'],
    failure: 'Frames are lost where the underlay is broken; the underlay reroutes them when it can.',
    restore: 'Frames pass again.',
  },
  {
    id: 'geneve',
    label: 'Geneve',
    group: 'Tunnels and overlays',
    behaviour: 'data',
    messages: [{ name: 'Geneve frame', does: 'encapsulated frames between the tunnel endpoints' }],
    transport: 'UDP 6081',
    proto: 'UDP 6081',
    encap: 'Geneve',
    dataMsg: 'Geneve frame',
    timers: [T('hello', 'Demonstration packet interval', 5, SERVICE_DEMO)],
    states: ['Up'],
    failure: 'Frames are lost where the underlay is broken.',
    restore: 'Frames pass again.',
  },
  {
    id: 'evpn',
    label: 'EVPN',
    group: 'Tunnels and overlays',
    behaviour: 'bgp',
    messages: [
      { name: 'TCP SYN / SYN-ACK / ACK', does: 'to port 179' },
      { name: 'OPEN', does: 'with the L2VPN EVPN address family' },
      { name: 'KEEPALIVE', does: 'keeps the session' },
      { name: 'UPDATE (EVPN routes)', does: 'type 2 (MAC/IP) and type 3 (inclusive multicast) routes' },
    ],
    transport: 'MP-BGP, TCP 179 between loopbacks',
    proto: 'TCP 179',
    timers: [T('hold', 'Hold time', 90, 'RFC 4271 §10 (suggested)'), T('keepalive', 'Keepalive time', 30, 'RFC 4271 §10'), T('connect-retry', 'ConnectRetry time', 120, 'RFC 4271 §10')],
    states: ['Idle', 'Connect', 'Active', 'OpenSent', 'OpenConfirm', 'Established'],
    failure: 'The hold time expires: the session goes down and its MAC/IP routes are withdrawn.',
    restore: 'The session is re-established and the routes advertised again.',
  },
  {
    id: 'l3vpn',
    label: 'MPLS L3VPN',
    group: 'Tunnels and overlays',
    behaviour: 'bgp',
    messages: [
      { name: 'TCP SYN / SYN-ACK / ACK', does: 'to port 179' },
      { name: 'OPEN', does: 'with the VPNv4 / VPNv6 address family' },
      { name: 'KEEPALIVE', does: 'keeps the session' },
      { name: 'UPDATE (VPNv4)', does: 'customer prefixes with route distinguisher, route targets and label' },
    ],
    transport: 'MP-BGP, TCP 179 between the PEs; traffic with an MPLS label stack',
    proto: 'TCP 179',
    timers: [T('hold', 'Hold time', 90, 'RFC 4271 §10 (suggested)'), T('keepalive', 'Keepalive time', 30, 'RFC 4271 §10'), T('connect-retry', 'ConnectRetry time', 120, 'RFC 4271 §10')],
    states: ['Idle', 'Connect', 'Active', 'OpenSent', 'OpenConfirm', 'Established'],
    failure: 'The hold time expires: the VPN routes are withdrawn.',
    restore: 'The session is re-established and the VPN routes advertised again.',
  },
  {
    id: 'vpls',
    label: 'VPLS',
    group: 'Tunnels and overlays',
    behaviour: 'ldp',
    messages: [
      { name: 'Targeted Hello', does: 'LDP hello to the remote PE' },
      { name: 'Initialization', does: 'opens the targeted session' },
      { name: 'Label Mapping (VPLS)', does: 'the pseudowire label of the VPLS instance' },
      { name: 'Keepalive', does: 'keeps the session' },
    ],
    transport: 'targeted LDP (UDP / TCP 646); frames in MPLS',
    proto: 'UDP/TCP 646',
    encap: 'MPLS',
    dataMsg: 'VPLS frame',
    timers: [T('hello', 'Targeted hello interval', 15, 'RFC 5036 / common default'), T('dead', 'Targeted hello hold time', 45, 'RFC 5036'), T('keepalive', 'Keepalive interval', 60, 'common default'), T('hold', 'Session hold time', 180, 'common default')],
    states: ['Non-existent', 'Initialized', 'Operational'],
    failure: 'The session times out and the pseudowires of the instance go down.',
    restore: 'The session and labels are set up again.',
  },
  {
    id: 'sd-wan',
    label: 'SD-WAN',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'DTLS handshake', does: 'control connection set-up' },
      { name: 'BFD probe', does: 'liveness and quality of each tunnel' },
    ],
    transport: 'DTLS / TLS control, IPsec data tunnels with BFD inside',
    proto: 'UDP 12346',
    encap: 'IPsec',
    dataMsg: 'SD-WAN data',
    handshake: [
      { from: 'a', msg: 'DTLS ClientHello' },
      { from: 'b', msg: 'DTLS ServerHello' },
    ],
    keepalive: { msg: 'BFD probe', both: true },
    timers: [T('hello', 'BFD hello', 1, 'Cisco SD-WAN default'), T('dead', 'Down after (7 × hello)', 7, 'Cisco SD-WAN default multiplier')],
    states: ['Down', 'Up'],
    failure: 'BFD probes are lost: the tunnel is down and traffic moves to the others.',
    restore: 'The tunnel comes up with its first answered probes.',
  },
  {
    id: 'otv',
    label: 'OTV',
    group: 'Tunnels and overlays',
    behaviour: 'session',
    messages: [
      { name: 'OTV Hello', does: 'IS-IS hellos between the edge devices' },
      { name: 'OTV MAC update', does: 'MAC reachability (IS-IS LSPs)' },
    ],
    transport: 'IS-IS in a multicast or unicast overlay',
    proto: 'OTV',
    encap: 'OTV',
    dataMsg: 'OTV frame',
    handshake: [
      { from: 'a', msg: 'OTV Hello' },
      { from: 'b', msg: 'OTV Hello' },
      { from: 'a', msg: 'OTV MAC update' },
    ],
    keepalive: { msg: 'OTV Hello', both: true },
    timers: [T('hello', 'Hello interval', 20, 'Cisco default'), T('dead', 'Hold time', 100, 'Cisco default')],
    states: ['Down', 'Up'],
    failure: 'Hellos stop: the adjacency goes down after the hold time.',
    restore: 'Hellos and MAC updates again.',
  },
  // ------------------------------------------------------------ services
  service('dns', 'DNS', 'UDP 53', 'Query', 'Response', 30, 'DNS queries for names, answered by the server'),
  service('ntp', 'NTP', 'UDP 123', 'Client request', 'Server response', 64, 'time requests (NTPv4 minimum poll interval 64 s, RFC 5905)', 'RFC 5905 minpoll (64 s)'),
  service('syslog', 'Syslog', 'UDP 514', 'Syslog message', undefined, 20, 'log messages to the collector (one way)'),
  { ...service('snmp', 'SNMP', 'UDP 161', 'GetRequest', 'GetResponse', 60, 'the manager (the last endpoint) polls each agent'), fromServer: true, transport: 'UDP 161, unicast from the manager (the last endpoint) to each agent' },
  service('radius', 'RADIUS / TACACS+', 'UDP 1812 (TACACS+ TCP 49)', 'Access-Request', 'Access-Accept', 60, 'authentication requests to the server'),
  {
    // DHCP is simulated from the servers' scopes (services: dhcp) and the clients' ipv4: dhcp (analysis/sim/netsvc.ts):
    // a relation of it is drawn, not run as a session of its own (its behaviour has no engine)
    id: 'dhcp',
    label: 'DHCP',
    group: 'Services',
    behaviour: 'dhcp-server',
    messages: [
      { name: 'DHCPDISCOVER', does: 'broadcast by the client from 0.0.0.0 (a relay forwards it to the server as unicast, with its giaddr)' },
      { name: 'DHCPOFFER', does: 'the server’s offer: an address of the scope, its lease time, gateway and DNS servers' },
      { name: 'DHCPREQUEST', does: 'the client takes it (broadcast); later its renewal (unicast) and rebinding (broadcast)' },
      { name: 'DHCPACK', does: 'the server confirms the lease (DHCPNAK: an address it can’t give)' },
    ],
    transport: 'UDP 67 / 68: broadcast on the client’s segment, unicast through a relay',
    proto: 'UDP 67',
    timers: [T('hello', 'Renewal (T1 = lease / 2)', 43200, 'RFC 2131 (one-day lease)')],
    states: ['Init', 'Bound'],
    failure: 'Without a server the client retries with backoff, then pauses; the lease ends at its expiry.',
    restore: 'The next DHCPDISCOVER or renewal reaches the server.',
  },
  service('capwap', 'CAPWAP', 'UDP 5246', 'Echo Request', 'Echo Response', 30, 'the control channel between an access point and its wireless controller (RFC 5415 EchoInterval 30 s)', 'RFC 5415 EchoInterval (30 s)'),
  service('https', 'HTTPS', 'TCP 443', 'TLS Application Data (request)', 'TLS Application Data (response)', 30, 'web requests after the TCP and TLS handshakes'),
  service('netflow', 'NetFlow / IPFIX', 'UDP 2055 / 4739', 'Flow export', undefined, 60, 'flow records to the collector (one way)', 'common active timeout (60 s)'),
];

/** A service profile: requests from the clients (every endpoint but the last) to the server (the last endpoint), answered unless one-way. */
function service(id: string, label: string, proto: string, request: string, response: string | undefined, every: number, does: string, source = SERVICE_DEMO): SimProfile {
  return {
    id,
    label,
    group: 'Services',
    behaviour: 'service',
    messages: response ? [{ name: request, does }, { name: response, does: 'the answer' }] : [{ name: request, does }],
    transport: `${proto}, unicast from the clients to the server`,
    proto,
    request,
    response,
    timers: [T('hello', response ? 'Request interval' : 'Message interval', every, source)],
    states: response ? ['Waiting', 'Answered'] : ['Sending'],
    failure: response ? 'Requests are lost where the way is broken; they find another way when routing has one.' : 'Messages are lost where the way is broken.',
    restore: 'Requests reach the server again.',
  };
}

/** The profile of a user-defined protocol: dummy packets with its name between the endpoints, in the relation's direction. */
export function customProfile(id: string, label: string): SimProfile {
  return {
    id,
    label,
    group: 'Custom',
    behaviour: 'custom',
    messages: [{ name: `${label} packet`, does: 'a dummy packet between the endpoints (the protocol is the model’s own: its messages are unknown)' }],
    transport: 'unicast between the endpoints, in the relation’s direction',
    proto: label,
    timers: [T('hello', 'Packet interval', 5, SERVICE_DEMO)],
    states: ['Sending'],
    failure: 'Packets are lost where the way is broken.',
    restore: 'Packets pass again.',
    support: CUSTOM_SUPPORT,
  };
}

/**
 * What the simulation does for each built-in protocol, by its behaviour,
 * with a protocol's own statement where it differs. Every built-in
 * protocol has a behaviour of the engine, so each is modeled within the
 * stated scope; a protocol of the model's own (customProfile) is drawn
 * only, whatever demonstration packets it sends.
 */
const SESSION_NOT = 'payload contents and cryptographic operations; the protocol’s own negotiation is reduced to its profile’s handshake.';
const BY_BEHAVIOUR: { [b: string]: Support } = {
  arp: { level: 'modeled', does: 'Requests, replies and the ARP table with its timers are simulated before IPv4 unicast.', not: 'proxy ARP, ARP inspection.' },
  ndp: { level: 'modeled', does: 'Neighbor Solicitation and Advertisement and the neighbour states (INCOMPLETE … PROBE) are simulated before IPv6 unicast.', not: 'SEND, proxy NDP. Router discovery, SLAAC and duplicate address detection are the interfaces’ IPv6 configuration.' },
  garp: { level: 'modeled', does: 'Announcements when an interface comes up and when a redundancy group’s master changes are simulated.', not: 'ARP inspection or conflict handling beyond the log.' },
  stp: { level: 'modeled', does: 'A spanning tree per VLAN blocks loops; ports converge with the RSTP or STP timers and BPDUs are shown.', not: 'the tree is computed from the topology, not negotiated BPDU by BPDU; no MSTP regions.' },
  advert: { level: 'modeled', does: 'Periodic advertisements and each neighbour entry with its hold time are simulated.', not: 'their TLV contents.' },
  lacp: { level: 'modeled', does: 'LACPDUs on every member, bundling and min-links are simulated.', not: 'system and port priorities, keys, fast timers.' },
  ospf: { level: 'modeled', does: 'Hellos, the adjacency states up to Full (DBD, LSR, LSU, LSAck), their timers and the flooding after a change are simulated; routes come from the adjacencies that are up.', not: 'LSA contents field by field, area types, authentication.' },
  isis: { level: 'modeled', does: 'Hellos, the adjacency states and their timers are simulated; routes come from the adjacencies that are up.', not: 'LSPs field by field, levels’ details, authentication.' },
  eigrp: { level: 'modeled', does: 'Hellos, Updates, the neighbour states with their hold time, and Queries and Replies when a neighbour is lost are simulated; routes come from the adjacencies that are up.', not: 'DUAL’s feasibility computation, metrics from bandwidth and delay.' },
  rip: { level: 'modeled', does: 'Requests, periodic and triggered Responses and the neighbour timeout are simulated; routes come from the neighbours that are heard.', not: 'the table’s entries field by field (metrics, route tags).' },
  bgp: { level: 'modeled', does: 'The TCP session, OPEN, KEEPALIVE, the hold timer and UPDATEs are simulated; routes come from the sessions that are up.', not: 'path attributes and policies (local preference, communities), route reflection, authentication.' },
  ldp: { level: 'modeled', does: 'Hellos, the session and its label mapping messages are simulated.', not: 'label-switched forwarding: traffic follows the IP path.' },
  pim: { level: 'modeled', does: 'Hellos with the DR election, Join/Prune, Register, the RP’s Bootstrap announcement, the RPF check and multicast forwarding (sparse, SSM, dense) are simulated.', not: 'an election among BSR candidates (the RP is configured), Auto-RP, asserts.' },
  igmp: { level: 'modeled', does: 'Reports, leaves, queries, the querier election and switches’ snooping per VLAN are simulated.', not: 'IGMP proxying.' },
  bfd: { level: 'modeled', does: 'Control packets and the detection time are simulated; a session down takes its client protocols down.', not: 'echo mode, authentication.' },
  fhrp: { level: 'modeled', does: 'The election, advertisements, the virtual MAC and failover with a gratuitous ARP are simulated.', not: 'object tracking, load sharing details.' },
  ike: { level: 'modeled', does: 'IKEv2 exchanges, SA lifetimes, rekeying and dead peer detection are simulated; traffic is carried in ESP.', not: 'cryptographic operations: proposals, keys and authentication are not checked.' },
  session: { level: 'modeled', does: 'Session establishment (its profile’s handshake), keepalives and the dead interval are simulated; traffic is encapsulated where the profile has a header.', not: SESSION_NOT },
  data: { level: 'modeled', does: 'Traffic is encapsulated in its header along the relation and decapsulated at the far end.', not: 'a control plane of its own (learning, signalling).' },
  service: { level: 'modeled', does: 'Requests (and their answers) cross the network at a demonstration interval between the relation’s ends: reachability, firewall policy and closed ports apply.', not: 'message contents and the server’s application logic.' },
  'dhcp-server': { level: 'modeled', does: 'DISCOVER, OFFER, REQUEST and ACK, relays, leases with renewal, rebinding and expiry are simulated from the servers’ scopes.', not: 'DHCPDECLINE, RELEASE, INFORM, option 82.' },
};
const BY_PROTOCOL: { [id: string]: Support } = {
  dns: { level: 'modeled', does: 'A relation’s demonstration queries cross the network; name resolution itself (A / AAAA, CNAME, forwarders, the resolver cache) is simulated from the DNS servers’ zones.', not: 'DNSSEC, TCP fallback, recursion beyond the model’s servers.' },
  ntp: { level: 'modeled', does: 'Client requests and server responses at the poll interval; the clients’ synchronization state (synchronized, unsynchronized) and the servers’ stratum follow from them.', not: 'clock filtering, selection and discipline: no offset or accuracy is computed.' },
  https: { level: 'modeled', does: 'TCP connections with requests and answers at a demonstration interval are simulated (the TLS handshake is part of the connection’s time).', not: 'TLS itself: certificates and encryption are not checked.' },
  stp: BY_BEHAVIOUR.stp,
};
for (const p of SIM_PROFILES) p.support = BY_PROTOCOL[p.id] || BY_BEHAVIOUR[p.behaviour];

/** What a protocol of the model's own gets: drawn, with demonstration packets of its name. */
export const CUSTOM_SUPPORT: Support = {
  level: 'drawn',
  does: 'Its relations are drawn; in the simulation it only sends demonstration packets of its name between the endpoints.',
  not: 'its messages, states and timers (they are unknown to NetAtlas).',
};

const BY_ID = new Map(SIM_PROFILES.map((p) => [p.id, p] as [string, SimProfile]));

/** The profile of a built-in protocol (by its base id), or undefined. */
export function simProfile(id: string): SimProfile | undefined {
  return BY_ID.get(id);
}

/** The default of a profile's timer (seconds), or `fallback`. */
export function timerDefault(p: SimProfile, key: string, fallback = 0): number {
  const t = p.timers.find((x) => x.key === key);
  return t ? t.seconds : fallback;
}

/** The ARP, NDP and MAC table timers' defaults (seconds), shared by the simulation, its tables and docs/FORMAT.md. */
export const ARP_TIMEOUT_DEFAULT = 14400;
export const NDP_REACHABLE_DEFAULT = 30;
export const ND_RETRANS_DEFAULT = 1;
export const ND_RETRIES_DEFAULT = 3;
export const ND_DELAY_DEFAULT = 5;
/** IEEE 802.1D-2004 recommended ageing time of a bridge's filtering database. */
export const MAC_AGING_DEFAULT = 300;

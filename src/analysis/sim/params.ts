/**
 * The protocol simulation's parameters: the simulation-wide Layer 1–3
 * parameters of Start simulation (and the Simulation window), and the
 * per-device simulation attributes (a device's optional `simulation:`
 * block). One registry, one order of precedence, used by the engine, the
 * window, the Inspector, the tables and validation alike:
 *
 *   1. configured  explicit configuration on the object in the model
 *                  (a relation's OSPF timers, a cable's `simulation:`
 *                  latency, a link's speed);
 *   2. device      the device's simulation attribute (`simulation:`);
 *   3. simulation  the simulation-wide value (Start simulation…, the
 *                  Simulation window; remembered for the browser session);
 *   4. default     the built-in common default, with its source.
 *
 * Pure: no DOM, no storage. Durations are kept in milliseconds; a value
 * written in the model without a unit is in the parameter's `base` unit.
 */
import { DEVICE_TYPE_IDS } from '../../model/device-types';
import { Capabilities, capabilities, layer3Option } from '../../model/capabilities';
import { parseSpeed } from '../../model/speed';

export type ParamKind = 'duration' | 'count' | 'percent' | 'speed' | 'enum' | 'list';
export type ParamValue = number | string;
export type Source = 'configured' | 'object' | 'device' | 'simulation' | 'default';

/**
 * Where an attribute is written in the model (its `simulation:` block), the
 * level real devices configure it at:
 *   device     the device's block: what applies to the whole device;
 *   interface  a port's, an aggregate's or a logical interface's block;
 *   vlan       a network's block (its `vlan:`): every switch carrying the VLAN;
 *   relation   a relation's block: a session, a tunnel, a redundancy group,
 *              a service relation (a server's service, a load balancer's pool);
 *   service    a server service's entry: a DHCP scope's or a DNS zone's block.
 */
export type ParamLevel = 'device' | 'interface' | 'vlan' | 'relation' | 'service';

/** The objects of a server's services that have simulation attributes of their own. */
export type SvcLevel = 'dhcp' | 'dns' | 'hypervisor' | 'vswitch' | 'container_engine' | 'separation';
export const PARAM_LEVELS: readonly ParamLevel[] = ['device', 'interface', 'vlan', 'relation', 'service'];

/** Which interfaces an interface attribute applies to (of the devices it applies to). */
export type IfaceApplies = 'ip' | 'routed' | 'port' | 'bridge-port' | 'lag' | 'radio' | 'dhcp';

/** Which relations a relation attribute applies to: by base protocol, or a service relation of a load balancer or a server. */
export type RelApplies = string;

/** Which devices a simulation attribute applies to (see deviceParams). */
export type Applies = 'all' | 'ip' | 'dhcp' | 'router' | 'switch' | 'aggregate' | 'firewall' | 'ids' | 'vpn' | 'host' | 'hypervisor' | 'engine' | 'container' | 'monitor' | 'cloud' | 'ap' | 'endpoint' | 'lb' | 'separation';

export interface ParamDef {
  /** the registry key ("arp-timeout") */
  key: string;
  /** the key in a device's (or a cable's) `simulation:` block */
  yaml: string;
  label: string;
  /** the section of the start dialog and the window (0: a device attribute only) */
  layer: 0 | 1 | 2 | 3 | 4;
  kind: ParamKind;
  /** a duration's unit for a bare number in the model and in the fields ("s", "ms") */
  base?: 's' | 'ms';
  /** the built-in common default (durations in ms) */
  dflt: ParamValue;
  /** per device type, where the default differs */
  dfltByType?: { [type: string]: ParamValue };
  min?: number;
  max?: number;
  /** a count that must be a multiple of this (bridge and port priorities) */
  step?: number;
  options?: Array<{ value: string; label: string }>;
  /** where the default comes from */
  source: string;
  /** a short help text (the default and its source are added where shown) */
  help: string;
  /** what 0 means ("continuous"); a list: what an empty one means */
  zero?: string;
  /** a list's entries: ports ("tcp/443, udp/53, icmp, any"), test targets ("web1 tcp/443, 10.0.0.9"), VLAN values ("10=4096"), addresses ("10.0.0.5, 10.0.9.5") */
  list?: 'ports' | 'targets' | 'vlan-values' | 'addresses';
  /** shown in one row with this parameter in the dialog (BFD interval × multiplier); not counted on its own */
  pairOf?: string;
  /** an attribute of these devices (an object attribute: of the devices whose objects these are) */
  device?: Applies[];
  /** where it is written (default: the device) */
  level?: ParamLevel;
  /** an object attribute that may also be written device-wide, as the device's default for its objects */
  devDefault?: boolean;
  /** an interface attribute: which interfaces */
  ifaces?: IfaceApplies[];
  /** a relation attribute: which relations (base protocols; "lb-service", "server-service": the service relations of one) */
  rels?: RelApplies[];
  /** a service attribute: of a DHCP scope, a DNS zone, a Hypervisor service, one of its virtual switches, a Container engine */
  svc?: SvcLevel;
  /** a value configured on the object in the model can override it (shown in the help) */
  configured?: string;
}

const S = 1000;

const P = (d: ParamDef): ParamDef => d;

const ON_OFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const TEST_TYPES = [
  { value: 'icmp', label: 'ICMP echo (ping)' },
  { value: 'tcp', label: 'TCP connection' },
  { value: 'udp', label: 'UDP request' },
  { value: 'multicast', label: 'Multicast (UDP to the groups joined in the model)' },
];

/** Every parameter, in the order the dialog and the Inspector list them. */
export const PARAMS: readonly ParamDef[] = [
  // ------------------------------------------------------------ Layer 1 – Physical
  P({ key: 'link-latency', yaml: 'latency', label: 'Link latency', layer: 1, kind: 'duration', base: 'ms', dflt: 0.1, min: 0, max: 10 * S, source: 'about 20 km of fibre (5 µs per km); a cable in one building is far shorter', help: 'Propagation delay of a cable; serialization (frame size ÷ speed) is added.', device: ['cloud'], configured: 'a cable’s simulation: latency' }),
  P({ key: 'loss', yaml: 'loss', label: 'Packet loss', layer: 1, kind: 'percent', dflt: 0, min: 0, max: 100, source: 'a healthy link loses nothing', help: 'Share of frames lost on each cable, from a fixed seed.', device: ['cloud'], configured: 'a cable’s simulation: loss' }),
  P({ key: 'los-detect', level: 'interface', ifaces: ['port'], device: ['all'], yaml: 'los_detection', label: 'Loss-of-signal detection', layer: 1, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 60 * S, source: 'Junos hold-time down 0 ms (Cisco carrier-delay is the same idea)', help: 'How long a port takes to report that its cable went dark; frames are lost meanwhile.' }),
  P({ key: 'link-up-delay', level: 'interface', ifaces: ['port'], device: ['all'], yaml: 'link_up_delay', label: 'Link-up delay', layer: 1, kind: 'duration', base: 's', dflt: 2 * S, min: 0, max: 300 * S, source: '1000BASE-T autonegotiation and link training (IEEE 802.3 clauses 28 and 40) take about 2 s', help: 'After a restore or power-on: the time until the port is up again.' }),
  P({ key: 'default-speed', yaml: 'speed', label: 'Default speed', layer: 1, kind: 'speed', dflt: 1e9, min: 1e3, max: 1.6e12, source: '1000BASE-T, the usual access port', help: 'For cables without a speed: serialization time of each frame.', configured: 'a cable’s speed' }),
  P({ key: 'flap-down', yaml: 'flap_down', label: 'Flapping: down time', layer: 1, kind: 'duration', base: 's', dflt: 5 * S, min: 100, max: 3600 * S, source: 'a demonstration value', help: 'Start flapping: how long the cable stays down in each cycle.' }),
  P({ key: 'flap-up', yaml: 'flap_up', label: 'Flapping: up time', layer: 1, kind: 'duration', base: 's', dflt: 10 * S, min: 100, max: 3600 * S, source: 'a demonstration value', help: 'Start flapping: how long the cable stays up between two losses.' }),
  P({ key: 'flap-cycles', yaml: 'flap_cycles', label: 'Flapping: cycles', layer: 1, kind: 'count', dflt: 3, min: 0, max: 1000, zero: 'continuous', source: 'a demonstration value', help: 'How many times it goes down and up again; 0: until Stop flapping.' }),
  // ------------------------------------------------------------ Layer 2 – Data link
  P({ key: 'arp-timeout', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'arp_timeout', label: 'ARP timeout', layer: 2, kind: 'duration', base: 's', dflt: 14400 * S, min: S, max: 2147483 * S, source: 'Cisco IOS (4 h); RFC 826 sets none', help: 'How long an ARP entry stays valid.', device: ['ip'] }),
  P({ key: 'arp-retransmit', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'arp_retransmit', label: 'ARP retransmit interval', layer: 2, kind: 'duration', base: 's', dflt: S, min: 100, max: 60 * S, source: 'RFC 4861 RETRANS_TIMER (used for ARP as well)', help: 'Time between two ARP Requests or Neighbor Solicitations for one address.', device: ['ip'] }),
  P({ key: 'arp-retries', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'arp_retries', label: 'ARP retries', layer: 2, kind: 'count', dflt: 3, min: 1, max: 10, source: 'RFC 4861 MAX_MULTICAST_SOLICIT (used for ARP as well)', help: 'Requests before an unanswered entry is dropped with its waiting packets.', device: ['ip'] }),
  P({ key: 'ndp-reachable', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'ndp_reachable_time', label: 'NDP reachable time', layer: 2, kind: 'duration', base: 's', dflt: 30 * S, min: S, max: 3600 * S, source: 'RFC 4861 REACHABLE_TIME', help: 'How long an IPv6 neighbour counts as reachable after it was confirmed.', device: ['ip'] }),
  P({ key: 'mac-aging', yaml: 'mac_aging', label: 'MAC aging time', layer: 2, kind: 'duration', base: 's', dflt: 300 * S, min: 10 * S, max: 1000000 * S, source: 'IEEE 802.1D-2004 recommended ageing time', help: 'How long a switch keeps a MAC address it no longer hears.', device: ['switch'] }),
  P({
    key: 'stp-mode',
    yaml: 'stp_mode',
    label: 'Spanning tree',
    layer: 2,
    kind: 'enum',
    dflt: 'rstp',
    options: [
      { value: 'rstp', label: 'RSTP (802.1w)' },
      { value: 'mstp', label: 'MSTP (802.1s, rapid; priorities per VLAN)' },
      { value: 'pvst', label: 'Rapid PVST+ (rapid; priorities per VLAN)' },
      { value: 'stp', label: 'STP (802.1D)' },
      { value: 'off', label: 'Off (loops are not blocked)' },
    ],
    source: 'IEEE 802.1D-2004 (RSTP, the default of current switches)',
    help: 'Rapid modes converge at once (6 s further away), STP in 30 s. Off: a loop storms.',
    device: ['switch'],
  }),
  P({ key: 'igmp-snooping', level: 'vlan', devDefault: true, yaml: 'igmp_snooping', label: 'IGMP / MLD snooping', layer: 2, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'on by default on current switches (Cisco IOS, Junos; RFC 4541)', help: 'Switches send a group only to its members and the routers; off: flooded.', device: ['switch'] }),
  P({ key: 'mtu', yaml: 'mtu', label: 'Default MTU', layer: 2, kind: 'count', dflt: 1500, min: 68, max: 65535, source: 'RFC 894 (IP over Ethernet)', help: 'Largest IP packet an interface sends (bytes); larger ones fragment or fail.', configured: 'an interface’s mtu' }),
  // ------------------------------------------------------------ Layer 3 – Network
  P({ key: 'ttl', yaml: 'ttl', label: 'Default TTL / hop limit', layer: 3, kind: 'count', dflt: 64, min: 1, max: 255, source: 'RFC 1700 (IANA); Linux, macOS and most routers', help: 'The TTL (IPv4) and hop limit (IPv6) of the packets a device sends.', device: ['ip'] }),
  P({ key: 'icmp-errors', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'icmp_errors', label: 'Send ICMP errors', layer: 3, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'RFC 1812 §4.3 and RFC 4443 (routers and hosts send them)', help: 'Unreachable, Time Exceeded, Packet Too Big; never about broadcast or multicast.', device: ['ip'] }),
  P({ key: 'ospf-hello', yaml: 'ospf_hello', label: 'OSPF hello interval', layer: 3, kind: 'duration', base: 's', dflt: 10 * S, min: S, max: 65535 * S, source: 'RFC 2328 Appendix C.3', help: 'The dead interval is 4 × hello.', configured: 'an OSPF relation’s hello and dead' }),
  P({ key: 'bgp-keepalive', yaml: 'bgp_keepalive', label: 'BGP keepalive', layer: 3, kind: 'duration', base: 's', dflt: 60 * S, min: S, max: 21845 * S, source: 'Cisco IOS: keepalive 60 s, hold 180 s; RFC 4271 §10 suggests 30 s and 90 s', help: 'The hold time is 3 × keepalive.', configured: 'a BGP relation’s keepalive and hold' }),
  P({ key: 'bfd-interval', yaml: 'bfd_interval', label: 'BFD interval', layer: 3, kind: 'duration', base: 'ms', dflt: 300, min: 3, max: 10 * S, source: 'a common configuration (RFC 5880 sets none)', help: 'Detection time: interval × multiplier.', configured: 'a BFD relation’s interval and multiplier' }),
  P({ key: 'bfd-multiplier', yaml: 'bfd_multiplier', label: 'BFD multiplier', layer: 3, kind: 'count', dflt: 3, min: 1, max: 255, source: 'a common configuration (RFC 5880 sets none)', help: 'Missed packets before the session goes down.', pairOf: 'bfd-interval', configured: 'a BFD relation’s multiplier' }),
  P({ key: 'vrrp-advert', level: 'relation', rels: ['vrrp', 'hsrp', 'carp', 'glbp'], device: ['all'], yaml: 'vrrp_advert', label: 'VRRP advertisement interval', layer: 3, kind: 'duration', base: 's', dflt: S, min: 10, max: 40950, source: 'RFC 5798 §5.2.7 (100 centiseconds)', help: 'The master-down interval is 3 × interval + skew. CARP uses it as well.' }),
  P({ key: 'igmp-query', level: 'interface', devDefault: true, ifaces: ['routed'], yaml: 'igmp_query_interval', label: 'IGMP / MLD query interval', layer: 3, kind: 'duration', base: 's', dflt: 125 * S, min: S, max: 3175 * S, source: 'RFC 3376 §8.2 and RFC 3810 §9.2 (125 s)', help: 'How often the querier asks which groups have members.', device: ['router', 'switch'] }),
  P({ key: 'spf-delay', yaml: 'spf_delay', label: 'Route recomputation delay', layer: 3, kind: 'duration', base: 'ms', dflt: 200, min: 0, max: 60 * S, source: 'Junos spf-options delay (200 ms)', help: 'SPF and FIB update after a change: the old routes are used meanwhile.', device: ['router'] }),
  // ------------------------------------------------------------ Layer 4 – Transport
  P({ key: 'tcp-syn-retries', yaml: 'tcp_syn_retries', label: 'TCP SYN retries', layer: 4, kind: 'count', dflt: 6, min: 0, max: 20, source: 'Linux net.ipv4.tcp_syn_retries (about 127 s in all)', help: 'Retransmitted SYNs before a connection attempt times out.', device: ['ip'] }),
  P({ key: 'tcp-rto', yaml: 'tcp_rto', label: 'TCP initial retransmission timeout', layer: 4, kind: 'duration', base: 's', dflt: S, min: 10, max: 60 * S, source: 'RFC 6298 §2.1', help: 'Wait before the first retransmission; it doubles each time.' }),
  P({ key: 'tcp-keepalive', yaml: 'tcp_keepalive', label: 'TCP keepalive time', layer: 4, kind: 'duration', base: 's', dflt: 7200 * S, min: S, max: 86400 * S, source: 'RFC 1122 §4.2.3.6 (at least 2 h); Linux tcp_keepalive_time', help: 'An idle open connection is probed after this (then 9 probes 75 s apart).', device: ['ip'] }),
  P({ key: 'closed-port', yaml: 'closed_port_reply', label: 'Reply to closed ports', layer: 4, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'RFC 9293 §3.10.7.1 (RST) and RFC 1122 §3.2.2.1 (port unreachable)', help: 'TCP RST, or ICMP port unreachable for UDP; off: silently dropped.', device: ['ip'] }),
  P({ key: 'test-traffic', yaml: 'test_traffic', label: 'Endpoint test traffic', layer: 4, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off, so that the timeline shows the protocols alone until it is wanted', help: 'Endpoints reach their gateway and the servers of their service relations.', device: ['endpoint'] }),
  P({ key: 'test-interval', yaml: 'test_interval', label: 'Test traffic interval', layer: 4, kind: 'duration', base: 's', dflt: 5 * S, min: 100, max: 3600 * S, source: 'a demonstration value', help: 'How often each endpoint sends its test traffic.', device: ['endpoint'] }),
  P({ key: 'test-type', yaml: 'test_type', label: 'Test traffic type', layer: 4, kind: 'enum', dflt: 'icmp', options: TEST_TYPES, source: 'ping, the usual first test', help: 'ICMP echo, a TCP connection or a UDP request (a relation’s own port wins).', device: ['endpoint'] }),
  P({ key: 'app-timeout', yaml: 'app_timeout', label: 'Application response timeout', layer: 4, kind: 'duration', base: 's', dflt: 5 * S, min: 100, max: 600 * S, source: 'dig’s default timeout (5 s); Windows ping waits 4 s', help: 'A test without an answer within it is reported as timed out.', device: ['endpoint'] }),
  // ------------------------------------------------------------ device attributes only
  P({ key: 'boot-time', yaml: 'boot_time', label: 'Boot time', layer: 0, kind: 'duration', base: 's', dflt: 30 * S, dfltByType: { container: 2 * S, vm: 20 * S, router: 60 * S, firewall: 60 * S, vpn_gateway: 60 * S, separation_gateway: 60 * S, load_balancer: 60 * S }, min: 0, max: 3600 * S, source: 'a demonstration value (containers start in seconds, chassis routers in minutes)', help: 'Power on: the time until its interfaces come up.', device: ['all'] }),
  P({ key: 'ecmp-max', yaml: 'max_paths', label: 'Maximum ECMP paths', layer: 0, kind: 'count', dflt: 4, min: 1, max: 64, source: 'Cisco IOS maximum-paths (4)', help: 'Equal-cost next hops it spreads flows over.', device: ['router'] }),
  P({ key: 'mac-table-size', yaml: 'mac_table_size', label: 'MAC table size', layer: 0, kind: 'count', dflt: 8192, min: 1, max: 1000000, source: 'a small access switch (data sheets: 8 K–16 K entries)', help: 'When it is full, new addresses are not learned and their frames are flooded.', device: ['switch'] }),
  P({ key: 'stp-hello', yaml: 'stp_hello', label: 'STP hello time', layer: 0, kind: 'duration', base: 's', dflt: 2 * S, min: S, max: 10 * S, source: 'IEEE 802.1D-2004 Table 17-1', help: 'RSTP: a switch further from a failure takes over after 3 hellos.', device: ['switch'] }),
  P({ key: 'stp-forward-delay', yaml: 'stp_forward_delay', label: 'STP forward delay', layer: 0, kind: 'duration', base: 's', dflt: 15 * S, min: 4 * S, max: 30 * S, source: 'IEEE 802.1D-2004 Table 17-1', help: 'STP: listening and learning each take this long.', device: ['switch'] }),
  P({ key: 'stp-max-age', yaml: 'stp_max_age', label: 'STP max age', layer: 0, kind: 'duration', base: 's', dflt: 20 * S, min: 6 * S, max: 40 * S, source: 'IEEE 802.1D-2004 Table 17-1', help: 'STP: how long a switch further from a failure keeps the old information.', device: ['switch'] }),
  P({ key: 'bridge-priority', yaml: 'bridge_priority', label: 'Bridge priority', layer: 0, kind: 'count', dflt: 32768, min: 0, max: 61440, step: 4096, source: 'IEEE 802.1D-2004 §17.13.7 (32768)', help: 'The root bridge is the one with the lowest priority (then MAC). A multiple of 4096.', device: ['switch'] }),
  P({ key: 'bridge-priority-vlans', yaml: 'bridge_priority_vlans', label: 'Bridge priority per VLAN', layer: 0, kind: 'list', list: 'vlan-values', dflt: '', min: 0, max: 61440, step: 4096, zero: 'the bridge priority in every VLAN', source: 'MSTP instances and Rapid PVST+ (one tree per VLAN)', help: 'MSTP or PVST: VLAN=priority (10=4096, 20=8192); others take the bridge priority.', device: ['switch'] }),
  P({ key: 'stp-port', yaml: 'stp', label: 'Spanning tree on this port', layer: 0, level: 'interface', ifaces: ['bridge-port'], kind: 'enum', dflt: 'on', options: ON_OFF, source: 'every port takes part (Cisco, Junos)', help: 'Off: the port sends no BPDUs and is never blocked (a loop over it storms).', device: ['switch'] }),
  P({ key: 'stp-cost', yaml: 'stp_cost', label: 'Port path cost', layer: 0, level: 'interface', ifaces: ['bridge-port'], kind: 'count', dflt: 0, min: 0, max: 200000000, zero: 'by speed (802.1D-2004: 20 000 at 1 Gbit/s)', source: 'IEEE 802.1D-2004 Table 17-3 (20 Tbit/s ÷ speed)', help: 'The root port is the one with the lowest path cost to the root.', device: ['switch'] }),
  P({ key: 'stp-port-priority', yaml: 'stp_port_priority', label: 'Port priority', layer: 0, level: 'interface', ifaces: ['bridge-port'], kind: 'count', dflt: 128, min: 0, max: 240, step: 16, source: 'IEEE 802.1D-2004 §17.13.10 (128)', help: 'Between two equal ports to the same bridge the lower priority wins. A multiple of 16.', device: ['switch'] }),
  P({ key: 'stp-edge', yaml: 'stp_edge', label: 'Edge port (PortFast)', layer: 0, level: 'interface', devDefault: true, ifaces: ['bridge-port'], kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless configured (Cisco spanning-tree portfast)', help: 'A host port: forwarding at once, even with STP. A BPDU makes it a normal port.', device: ['switch'] }),
  P({ key: 'stp-bpdu-guard', yaml: 'stp_bpdu_guard', label: 'BPDU guard', layer: 0, level: 'interface', devDefault: true, ifaces: ['bridge-port'], kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless configured (Cisco spanning-tree bpduguard)', help: 'A BPDU on the port shuts it down (err-disabled) until the simulation restores it.', device: ['switch'] }),
  P({ key: 'stp-root-guard', yaml: 'stp_root_guard', label: 'Root guard', layer: 0, level: 'interface', ifaces: ['bridge-port'], kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless configured (Cisco spanning-tree guard root)', help: 'Never the root port: a better root behind it blocks it (root-inconsistent).', device: ['switch'] }),
  P({
    key: 'stp-link-type',
    yaml: 'stp_link_type',
    label: 'Link type',
    layer: 0,
    level: 'interface',
    ifaces: ['bridge-port'],
    kind: 'enum',
    dflt: 'auto',
    options: [
      { value: 'auto', label: 'Auto (point-to-point at full duplex)' },
      { value: 'point-to-point', label: 'Point-to-point' },
      { value: 'shared', label: 'Shared (half duplex, a hub)' },
    ],
    source: 'IEEE 802.1w (auto: by duplex)',
    help: 'Rapid convergence needs point-to-point; a shared link waits 2 × forward delay.',
    device: ['switch'],
  }),
  P({
    key: 'lacp-rate', level: 'interface', ifaces: ['lag'],
    yaml: 'lacp_rate',
    label: 'LACP rate',
    layer: 0,
    kind: 'enum',
    dflt: 'slow',
    options: [
      { value: 'slow', label: 'Slow (every 30 s, timeout 90 s)' },
      { value: 'fast', label: 'Fast (every 1 s, timeout 3 s)' },
    ],
    source: 'IEEE 802.1AX (slow periodic time)',
    help: 'How often LACPDUs go out on the members of its aggregates.',
    device: ['aggregate'],
  }),
  P({ key: 'ha-failover', yaml: 'ha_failover', label: 'HA failover detection', layer: 0, kind: 'duration', base: 's', dflt: 3 * S, min: 100, max: 300 * S, source: 'a common setting (3 missed heartbeats of 1 s)', help: 'Its HA sync relation is down after this long without a heartbeat.', device: ['firewall'], configured: 'an HA sync relation’s dead' }),
  P({
    key: 'ips-fail',
    yaml: 'fail_mode',
    label: 'When it fails',
    layer: 0,
    kind: 'enum',
    dflt: 'open',
    options: [
      { value: 'open', label: 'Fail open (frames pass unchecked)' },
      { value: 'closed', label: 'Fail closed (nothing passes)' },
    ],
    source: 'the hardware bypass of most inline appliances',
    help: 'Power off: does traffic still pass through it?',
    device: ['ids'],
  }),
  P({ key: 'ips-latency', yaml: 'inspection_latency', label: 'Inspection latency', layer: 0, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 10 * S, source: 'none unless set (see the appliance’s data sheet)', help: 'Added to every frame it passes on.', device: ['ids'] }),
  P({ key: 'ike-lifetime', level: 'relation', devDefault: true, rels: ['ipsec'], yaml: 'ike_lifetime', label: 'IKE SA lifetime', layer: 0, kind: 'duration', base: 's', dflt: 86400 * S, min: 60 * S, max: 31536000 * S, source: 'Cisco IKEv2 (86 400 s)', help: 'The IKE SA is rekeyed this long after it was set up, less the rekey margin.', device: ['vpn'] }),
  P({ key: 'child-lifetime', level: 'relation', devDefault: true, rels: ['ipsec'], yaml: 'child_lifetime', label: 'Child SA lifetime', layer: 0, kind: 'duration', base: 's', dflt: 3600 * S, min: 60 * S, max: 31536000 * S, source: 'Cisco IOS and strongSwan (1 h)', help: 'The Child SA (the tunnel’s ESP keys) is rekeyed before it ends.', device: ['vpn'], configured: 'an IPsec relation’s child-lifetime' }),
  P({ key: 'rekey-margin', level: 'relation', devDefault: true, rels: ['ipsec'], yaml: 'rekey_margin', label: 'Rekey margin', layer: 0, kind: 'duration', base: 's', dflt: 540 * S, min: 0, max: 86400 * S, source: 'strongSwan margintime (9 min)', help: 'How long before a lifetime ends the SA is rekeyed.', device: ['vpn'] }),
  P({ key: 'dpd-interval', level: 'relation', devDefault: true, rels: ['ipsec'], yaml: 'dpd_interval', label: 'DPD interval', layer: 0, kind: 'duration', base: 's', dflt: 10 * S, min: S, max: 3600 * S, source: 'a common setting (RFC 7296 sets none)', help: 'Dead Peer Detection: an empty INFORMATIONAL request this often.', device: ['vpn'], configured: 'an IPsec relation’s dpd' }),
  P({ key: 'dpd-retries', level: 'relation', devDefault: true, rels: ['ipsec'], yaml: 'dpd_retries', label: 'DPD retries', layer: 0, kind: 'count', dflt: 3, min: 1, max: 20, source: 'a common setting', help: 'Unanswered requests before the SAs are deleted.', device: ['vpn'] }),
  P({ key: 'service-response', level: 'relation', devDefault: true, rels: ['server-service'], yaml: 'response_time', label: 'Service response time', layer: 0, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 60 * S, source: 'none unless set', help: 'How long its services take to answer a request.', device: ['host'] }),
  P({ key: 'vm-restart', level: 'service', svc: 'hypervisor', yaml: 'vm_restart', label: 'VM restart time', layer: 0, kind: 'duration', base: 's', dflt: 60 * S, min: 0, max: 3600 * S, source: 'a demonstration value (HA failure detection plus the restart)', help: 'The host powered off: its VMs restart on another HA cluster member after this.', device: ['hypervisor'] }),
  P({ key: 'failover-detect', level: 'service', svc: 'vswitch', yaml: 'failover_detection', label: 'Teaming failover detection', layer: 0, kind: 'duration', base: 'ms', dflt: S, min: 0, max: 60 * S, source: 'a demonstration value (link-status failover detection takes about a second)', help: 'An active uplink fails: after this, its guests move to the next uplink (with RARP).', device: ['hypervisor'] }),
  P({ key: 'container-start', level: 'service', svc: 'container_engine', yaml: 'container_start', label: 'Container start time', layer: 0, kind: 'duration', base: 's', dflt: 2 * S, min: 0, max: 600 * S, source: 'a demonstration value (a container starts in seconds)', help: 'The engine or its host starts: its containers (by restart policy) are up after this.', device: ['engine'] }),
  P({ key: 'transfer-delay', level: 'service', svc: 'separation', yaml: 'transfer_delay', label: 'Transfer delay', layer: 0, kind: 'duration', base: 'ms', dflt: 1, min: 0, max: 60 * S, source: 'a demonstration value (a separation gateway inspects what it transfers)', help: 'Time a permitted transfer takes inside the gateway (per packet, or per new leg).', device: ['separation'] }),
  P({ key: 'transfer-loss', level: 'service', svc: 'separation', yaml: 'transfer_loss', label: 'Transfer loss', layer: 0, kind: 'percent', dflt: 0, min: 0, max: 100, source: 'none unless set', help: 'Share of permitted transfers it loses (an overloaded or faulty gateway).', device: ['separation'] }),
  P({ key: 'restart-policy', yaml: 'restart_policy', label: 'Restart policy', layer: 0, kind: 'enum', dflt: 'no', options: [{ value: 'no', label: 'No' }, { value: 'always', label: 'Always' }, { value: 'on-failure', label: 'On failure' }, { value: 'unless-stopped', label: 'Unless stopped' }], source: 'Docker (no)', help: 'Whether the engine starts it again after its host or the engine restarts.', device: ['container'] }),
  P({ key: 'snmp-interval', yaml: 'snmp_interval', label: 'SNMP polling interval', layer: 0, kind: 'duration', base: 's', dflt: 60 * S, min: S, max: 86400 * S, source: 'a demonstration value (300 s is common in production)', help: 'How often it polls each SNMP agent.', device: ['monitor'] }),
  P({ key: 'snmp-timeout', yaml: 'snmp_timeout', label: 'SNMP timeout', layer: 0, kind: 'duration', base: 's', dflt: S, min: 100, max: 60 * S, source: 'net-snmp (1 s)', help: 'An agent that does not answer within it is reported as not responding.', device: ['monitor'] }),
  P({ key: 'ap-association', yaml: 'association_time', label: 'Client association time', layer: 0, kind: 'duration', base: 's', dflt: S, min: 0, max: 60 * S, source: 'a demonstration value (WPA2-PSK takes well under a second, 802.1X longer)', help: 'Its wireless links come up this long after the radio is back.', device: ['ap'] }),
  P({ key: 'ap-beacon', level: 'interface', ifaces: ['radio'], yaml: 'beacon_interval', label: 'Beacon interval', layer: 0, kind: 'duration', base: 'ms', dflt: 102.4, min: 10, max: 10 * S, source: 'IEEE 802.11 (100 TU = 102.4 ms)', help: 'A client that comes back waits for the next beacon, then associates.', device: ['ap'] }),
  P({ key: 'ap-idle', yaml: 'client_idle_timeout', label: 'Client idle timeout', layer: 0, kind: 'duration', base: 's', dflt: 300 * S, min: 10 * S, max: 86400 * S, source: 'Cisco WLC user idle timeout (300 s)', help: 'A client silent this long is disassociated; it associates again to send.', device: ['ap'] }),
  // ICMP and broadcast
  P({ key: 'ping', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'respond_to_ping', label: 'Respond to ping', layer: 0, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'RFC 1122 §3.2.2.6 (every host answers echo requests)', help: 'Off: echo requests to it go unanswered.', device: ['ip'] }),
  P({ key: 'bcast-ping', yaml: 'respond_to_broadcast_ping', label: 'Respond to broadcast ping', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'Linux icmp_echo_ignore_broadcasts (RFC 1122 §3.2.2.6 allows ignoring them)', help: 'Echo requests to a broadcast address: answered only when on.', device: ['ip'] }),
  P({ key: 'icmp-rate', yaml: 'icmp_rate_limit', label: 'ICMP error rate limit', layer: 0, kind: 'duration', base: 'ms', dflt: 500, min: 0, max: 60 * S, source: 'Cisco IOS ip icmp rate-limit unreachable (500 ms); RFC 1812 §4.3.2.8', help: 'At most one ICMP error per this interval; 0: no limit.', device: ['ip'] }),
  P({ key: 'directed-broadcast', level: 'interface', ifaces: ['routed'], yaml: 'directed_broadcast', label: 'Forward directed broadcasts', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'RFC 2644 (off by default since 1999)', help: 'A packet to a connected subnet’s broadcast address goes out as a broadcast.', device: ['router'] }),
  P({ key: 'storm-bc', level: 'interface', ifaces: ['bridge-port'], yaml: 'storm_control_broadcast', label: 'Storm control: broadcast', layer: 0, kind: 'count', dflt: 0, min: 0, max: 100000000, zero: 'off', source: 'off unless configured (Cisco storm-control)', help: 'Frames per second a port takes in; above it they are dropped. 0: off.', device: ['switch'] }),
  P({ key: 'storm-mc', level: 'interface', ifaces: ['bridge-port'], yaml: 'storm_control_multicast', label: 'Storm control: multicast', layer: 0, kind: 'count', dflt: 0, min: 0, max: 100000000, zero: 'off', source: 'off unless configured (Cisco storm-control)', help: 'Multicast frames per second a port takes in; 0: off.', device: ['switch'] }),
  // firewalls
  P({
    key: 'fw-action',
    yaml: 'default_action',
    label: 'Default action',
    layer: 0,
    kind: 'enum',
    dflt: 'drop',
    options: [
      { value: 'drop', label: 'Drop (silently)' },
      { value: 'reject', label: 'Reject (TCP RST, else ICMP administratively prohibited)' },
    ],
    source: 'the implicit deny of PAN-OS and Cisco ASA (silent)',
    help: 'What happens to traffic its policy does not permit.',
    device: ['firewall'],
  }),
  P({ key: 'fw-allow', yaml: 'allow', label: 'Also permits', layer: 0, kind: 'list', list: 'ports', dflt: '', zero: 'nothing more', source: 'none: the model’s relations through it are its policy', help: 'Further traffic it permits: tcp/22, udp/53, icmp, any.', device: ['firewall'] }),
  P({ key: 'fw-stateful', yaml: 'stateful', label: 'Stateful', layer: 0, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'every current firewall', help: 'On: replies pass by its session table; off: each packet is checked alone.', device: ['firewall'] }),
  P({ key: 'fw-tcp', yaml: 'tcp_session_timeout', label: 'TCP session timeout', layer: 0, kind: 'duration', base: 's', dflt: 3600 * S, min: S, max: 604800 * S, source: 'PAN-OS (3600 s)', help: 'An established TCP session idle this long is removed.', device: ['firewall'] }),
  P({ key: 'fw-half-open', yaml: 'tcp_handshake_timeout', label: 'TCP handshake timeout', layer: 0, kind: 'duration', base: 's', dflt: 5 * S, min: S, max: 3600 * S, source: 'PAN-OS tcp-init (5 s)', help: 'A half-open session (SYN without the handshake done) is removed after it.', device: ['firewall'] }),
  P({ key: 'fw-udp', yaml: 'udp_session_timeout', label: 'UDP session timeout', layer: 0, kind: 'duration', base: 's', dflt: 30 * S, min: S, max: 604800 * S, source: 'PAN-OS (30 s)', help: 'A UDP session idle this long is removed.', device: ['firewall'] }),
  P({ key: 'fw-icmp', yaml: 'icmp_session_timeout', label: 'ICMP session timeout', layer: 0, kind: 'duration', base: 's', dflt: 6 * S, min: S, max: 3600 * S, source: 'PAN-OS (6 s)', help: 'An ICMP echo session idle this long is removed.', device: ['firewall'] }),
  // servers, load balancers, endpoints, monitoring
  P({ key: 'listening', yaml: 'listening', label: 'Listening services', layer: 0, kind: 'list', list: 'ports', dflt: '', zero: 'its service relations’ ports', source: 'the ports of the service relations it serves', help: 'Open ports (tcp/443, udp/53); others get a RST or port unreachable.', device: ['host', 'lb'] }),
  P({ key: 'lb-hc-interval', level: 'relation', rels: ['lb-service'], yaml: 'health_check_interval', label: 'Health check interval', layer: 0, kind: 'duration', base: 's', dflt: 2 * S, min: 100, max: 3600 * S, source: 'HAProxy inter (2 s)', help: 'How often it checks each pool member (its service relations).', device: ['lb'] }),
  P({ key: 'lb-hc-timeout', level: 'relation', rels: ['lb-service'], yaml: 'health_check_timeout', label: 'Health check timeout', layer: 0, kind: 'duration', base: 's', dflt: 2 * S, min: 100, max: 600 * S, source: 'HAProxy timeout check (defaults to inter)', help: 'A check not answered within it fails.', device: ['lb'] }),
  P({ key: 'lb-hc-fall', level: 'relation', rels: ['lb-service'], yaml: 'health_check_threshold', label: 'Health check failure threshold', layer: 0, kind: 'count', dflt: 3, min: 1, max: 100, source: 'HAProxy fall (3)', help: 'Failed checks in a row before a member is taken out (one success brings it back).', device: ['lb'] }),
  P({ key: 'lb-persistence', level: 'relation', rels: ['lb-service'], yaml: 'persistence_timeout', label: 'Persistence timeout', layer: 0, kind: 'duration', base: 's', dflt: 180 * S, min: 0, max: 86400 * S, source: 'F5 BIG-IP source address affinity (180 s)', help: 'A client keeps its member while it returns within it; 0: no persistence.', device: ['lb'] }),
  P({
    key: 'lb-algorithm', level: 'relation', rels: ['lb-service'],
    yaml: 'algorithm',
    label: 'Balancing algorithm',
    layer: 0,
    kind: 'enum',
    dflt: 'round-robin',
    options: [
      { value: 'round-robin', label: 'Round robin' },
      { value: 'least-connections', label: 'Least connections' },
      { value: 'source-hash', label: 'Source address hash' },
    ],
    source: 'HAProxy and F5 BIG-IP (round robin)',
    help: 'Which healthy member a new connection goes to.',
    device: ['lb'],
  }),
  P({ key: 'test-targets', yaml: 'test_targets', label: 'Test targets', layer: 0, kind: 'list', list: 'targets', dflt: '', zero: 'its gateway and service relations', source: 'its gateway and the servers of its service relations', help: 'Devices or addresses, each optionally with tcp/443, udp/53 or icmp.', device: ['endpoint'] }),
  // DHCP and DNS: the servers' scopes and zones, the clients' interfaces
  P({ key: 'dhcp-offer-delay', yaml: 'offer_delay', label: 'Offer delay', layer: 0, level: 'service', svc: 'dhcp', devDefault: true, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 60 * S, source: 'none unless set (Windows Server: a delay for the secondary of a split scope)', help: 'How long the server waits before it answers a DHCPDISCOVER.', device: ['dhcp'] }),
  P({ key: 'dhcp-ping-check', yaml: 'ping_check', label: 'Ping check before offering', layer: 0, level: 'service', svc: 'dhcp', devDefault: true, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'Windows Server conflict detection (0 attempts: off)', help: 'The server pings an address before it offers it (500 ms) and skips one in use.', device: ['dhcp'] }),
  P({ key: 'dns-ttl', yaml: 'record_ttl', label: 'Record TTL', layer: 0, level: 'service', svc: 'dns', kind: 'duration', base: 's', dflt: 3600 * S, min: 0, max: 604800 * S, source: 'a common zone default (1 h)', help: 'How long a resolver caches an answer from this zone.', device: ['host'] }),
  P({ key: 'dhcp-retries', yaml: 'dhcp_retries', label: 'DHCP retries', layer: 0, level: 'interface', ifaces: ['dhcp'], kind: 'count', dflt: 4, min: 1, max: 20, source: 'RFC 2131 §4.1 (4, 8, 16, 32 s: about a minute)', help: 'DHCPDISCOVERs without an offer before the client pauses (5 min) and starts again.', device: ['ip'] }),
  P({ key: 'dhcp-backoff', yaml: 'dhcp_backoff', label: 'DHCP retransmission delay', layer: 0, level: 'interface', ifaces: ['dhcp'], kind: 'duration', base: 's', dflt: 4 * S, min: 100, max: 64 * S, source: 'RFC 2131 §4.1 (4 s, doubled each time up to 64 s)', help: 'The wait for an offer after the first DHCPDISCOVER; it doubles each time.', device: ['ip'] }),
  P({ key: 'link-local', yaml: 'link_local_fallback', label: 'Link-local fallback', layer: 0, level: 'interface', ifaces: ['dhcp'], kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless set (RFC 3927: Windows and macOS use it)', help: 'Without a DHCP server: a 169.254.0.0/16 address until a lease comes.', device: ['ip'] }),
  // multicast
  P({
    key: 'igmp-version', level: 'interface', devDefault: true, ifaces: ['ip'],
    yaml: 'igmp_version',
    label: 'IGMP / MLD version',
    layer: 0,
    kind: 'enum',
    dflt: 'v3',
    options: [
      { value: 'v3', label: 'IGMPv3 / MLDv2 (source lists)' },
      { value: 'v2', label: 'IGMPv2 / MLDv1' },
    ],
    source: 'Linux, Windows and current routers (RFC 3376, RFC 3810)',
    help: 'v3 reports name sources (needed for SSM); v2 reports are suppressed by others.',
    device: ['ip'],
  }),
  P({ key: 'igmp-unsolicited', level: 'interface', devDefault: true, ifaces: ['ip'], yaml: 'unsolicited_report_interval', label: 'Unsolicited report interval', layer: 0, kind: 'duration', base: 's', dflt: 0, min: 0, max: 60 * S, zero: 'by version: v2 10 s, v3 1 s', source: 'RFC 2236 §8.10 (10 s) and RFC 3376 §8.11 (1 s)', help: 'Between the repeated reports of a join or leave; 0: by the IGMP version.', device: ['ip'] }),
  P({ key: 'igmp-querier', level: 'interface', devDefault: true, ifaces: ['routed'], yaml: 'igmp_querier', label: 'IGMP / MLD querier', layer: 0, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'on where a router runs PIM or IGMP (Cisco IOS, Junos)', help: 'It takes part in the querier election of its subnets (the lowest address wins).', device: ['router'] }),
  P({ key: 'igmp-max-resp', level: 'interface', devDefault: true, ifaces: ['routed'], yaml: 'igmp_max_response', label: 'Query response interval', layer: 0, kind: 'duration', base: 's', dflt: 10 * S, min: 100, max: 25 * S, source: 'RFC 3376 §8.3 (10 s)', help: 'Members answer a query after a random delay up to this.', device: ['router', 'switch'] }),
  P({ key: 'igmp-robustness', level: 'interface', devDefault: true, ifaces: ['routed'], yaml: 'igmp_robustness', label: 'Robustness variable', layer: 0, kind: 'count', dflt: 2, min: 1, max: 7, source: 'RFC 3376 §8.1 (2)', help: 'Repeats of reports and group queries; membership lasts robustness × query + response.', device: ['router', 'switch'] }),
  P({ key: 'igmp-lmqi', level: 'interface', devDefault: true, ifaces: ['routed'], yaml: 'last_member_query_interval', label: 'Last member query interval', layer: 0, kind: 'duration', base: 's', dflt: S, min: 100, max: 25 * S, source: 'RFC 3376 §8.8 (1 s)', help: 'After a leave: group-specific queries this far apart, then the group goes.', device: ['router', 'switch'] }),
  P({ key: 'pim-dr-priority', level: 'interface', ifaces: ['routed'], yaml: 'pim_dr_priority', label: 'PIM DR priority', layer: 0, kind: 'count', dflt: 1, min: 0, max: 4294967295, source: 'RFC 7761 §4.3.2 (1)', help: 'The designated router of a segment: the highest priority, then address.', device: ['router'] }),
  P({
    key: 'spt-switchover',
    yaml: 'spt_switchover',
    label: 'SPT switchover',
    layer: 0,
    kind: 'enum',
    dflt: 'immediately',
    options: [
      { value: 'immediately', label: 'Immediately (at the first packet)' },
      { value: 'never', label: 'Never (stay on the shared tree)' },
    ],
    source: 'Cisco IOS spt-threshold 0 (immediately)',
    help: 'A last-hop router joins the source’s tree and prunes it off the RP’s.',
    device: ['router'],
  }),
  P({ key: 'snoop-querier', level: 'vlan', yaml: 'snooping_querier', label: 'Snooping querier', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless configured (Cisco ip igmp snooping querier)', help: 'Queries a VLAN that has no multicast router, so that members are learned.', device: ['switch'] }),
  P({ key: 'fast-leave', level: 'vlan', yaml: 'fast_leave', label: 'Fast leave', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless configured (Cisco immediate-leave)', help: 'A port that leaves a group stops getting it at once, without group queries.', device: ['switch'] }),
  P({
    key: 'unknown-mc', level: 'vlan',
    yaml: 'unknown_multicast',
    label: 'Unknown multicast',
    layer: 0,
    kind: 'enum',
    dflt: 'flood',
    options: [
      { value: 'flood', label: 'Flood in the VLAN' },
      { value: 'drop', label: 'Drop (router ports only)' },
    ],
    source: 'flooding until a member reports (RFC 4541 §2.1.2 allows it)',
    help: 'A group without members on the switch: flooded, or only to router ports.',
    device: ['switch'],
  }),
  P({ key: 'mrouter-aging', yaml: 'router_port_aging', label: 'Router port aging', layer: 0, kind: 'duration', base: 's', dflt: 300 * S, min: 10 * S, max: 3600 * S, source: 'Cisco IOS multicast router port (5 min)', help: 'A port that heard no query or PIM Hello for this long is no router port.', device: ['switch'] }),
  P({ key: 'mc-passthrough', level: 'interface', ifaces: ['ip'], yaml: 'multicast_passthrough', label: 'Multicast passthrough', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'firewalls drop multicast unless configured (PAN-OS, Cisco ASA)', help: 'On: it routes multicast like a router; off: multicast data is dropped.', device: ['firewall'] }),
  P({ key: 'mc-tunnel', level: 'relation', devDefault: true, rels: ['ipsec', 'gre', 'vxlan', 'wireguard', 'openvpn', 'l2tp'], yaml: 'multicast_over_tunnel', label: 'Multicast over tunnels', layer: 0, kind: 'enum', dflt: 'on', options: ON_OFF, source: 'GRE carries multicast; plain IPsec does not (RFC 4301)', help: 'Its tunnels carry multicast, but only inside GRE; off: none.', device: ['vpn'] }),
  P({ key: 'mc-to-unicast', level: 'interface', ifaces: ['radio'], yaml: 'multicast_to_unicast', label: 'Multicast to unicast', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'off unless configured (Cisco VideoStream, Aruba)', help: 'Group frames go to each wireless client as unicast frames.', device: ['ap'] }),
  P({ key: 'mc-support', yaml: 'multicast', label: 'Carries multicast', layer: 0, kind: 'enum', dflt: 'off', options: ON_OFF, source: 'the internet routes no multicast', help: 'Off: routed multicast does not cross it (link-local groups do).', device: ['cloud'] }),
  P({ key: 'icmp-probe', yaml: 'icmp_probe_interval', label: 'ICMP probe interval', layer: 0, kind: 'duration', base: 's', dflt: 60 * S, min: S, max: 86400 * S, source: 'Zabbix simple checks (1 min)', help: 'How often it pings each device it monitors (its SNMP relations).', device: ['monitor'] }),
];

const BY_KEY = new Map<string, ParamDef>(PARAMS.map((p) => [p.key, p]));
const BY_YAML = new Map<string, ParamDef>(PARAMS.filter((p) => p.device || p.level).map((p) => [p.yaml, p]));

export function paramDef(key: string): ParamDef {
  const d = BY_KEY.get(key);
  if (!d) throw new Error('unknown simulation parameter ' + key);
  return d;
}

/** The device attribute of a `simulation:` key (undefined: none). */
export function deviceParamByYaml(yaml: string): ParamDef | undefined {
  return BY_YAML.get(yaml);
}

/** The cable attributes (a link's `simulation:` block): latency, loss, flapping from the start. */
export const LINK_KEYS: readonly string[] = ['latency', 'loss', 'flapping'];

export const LAYER_TITLES: { [n: number]: string } = { 1: 'Layer 1 – Physical', 2: 'Layer 2 – Data link', 3: 'Layer 3 – Network', 4: 'Layer 4 – Transport' };

/** The simulation-wide parameters of a layer, in order (a pair's second half follows its first). */
export function layerParams(layer: number): ParamDef[] {
  return PARAMS.filter((p) => p.layer === layer);
}

/** The rows of a layer's section: a parameter with the one shown beside it (BFD interval × multiplier). */
export function layerRows(layer: number): ParamDef[][] {
  const out: ParamDef[][] = [];
  for (const p of layerParams(layer)) {
    if (p.pairOf) {
      const row = out.find((r) => r[0].key === p.pairOf);
      if (row) {
        row.push(p);
        continue;
      }
    }
    out.push([p]);
  }
  return out;
}

/** The layers that have simulation-wide parameters, ascending. */
export function paramLayers(): number[] {
  return [1, 2, 3, 4].filter((l) => layerParams(l).length > 0);
}

// ------------------------------------------------------------ which devices an attribute applies to

/** What the applicability rules need to know about a device. */
export interface DeviceFacts {
  id: string;
  type: string;
  layer3?: boolean;
  /** what it can do (model/capabilities.ts) */
  caps: Capabilities;
  /** has an address (an IP stack) */
  ip: boolean;
  /** forwards IP for others */
  routes: boolean;
  /** has an aggregate (LACP) */
  aggregate: boolean;
  /** an endpoint of an IPsec relation */
  ipsec: boolean;
  /** polls SNMP agents (the manager of an SNMP relation) */
  snmpManager: boolean;
  /** a server with the Hypervisor service */
  hypervisor: boolean;
  /** has the Container engine service (a server or a VM) */
  engine?: boolean;
  /** runs a DHCP server (services: dhcp) */
  dhcpServer?: boolean;
}

function applies(a: Applies, f: DeviceFacts): boolean {
  const c = f.caps;
  switch (a) {
    case 'all':
      return true;
    case 'ip':
      return f.ip;
    case 'dhcp':
      return !!f.dhcpServer;
    case 'router':
      return f.routes;
    case 'switch':
      return c.switchFeatures;
    case 'aggregate':
      return f.aggregate;
    case 'firewall':
      return c.firewallPolicy;
    case 'ids':
      return c.inspection;
    case 'vpn':
      return c.vpnTermination || f.ipsec;
    case 'host':
      return c.serviceHost;
    case 'hypervisor':
      return c.canHostGuests.vms && f.hypervisor;
    case 'engine':
      return !!f.engine;
    case 'container':
      return c.canBeGuest === 'container';
    case 'monitor':
      return c.monitoring || f.snmpManager;
    case 'cloud':
      return c.externalTransit;
    case 'ap':
      return c.wirelessAccess;
    case 'endpoint':
      return c.testTraffic;
    case 'lb':
      return c.loadBalancing;
    case 'separation':
      return c.separationGateway;
  }
  return false;
}

/** The simulation attributes a device's own block can have (device-wide ones, and the device-wide defaults of object attributes), in order. */
export function deviceParams(f: DeviceFacts): ParamDef[] {
  return PARAMS.filter((p) => !!p.device && deviceWide(p) && p.device.some((a) => applies(a, f)));
}

/** What the applicability of an interface attribute needs to know about the interface. */
export interface IfaceFacts {
  /** a port (physical interface) */
  port: boolean;
  /** has an address or takes one by DHCP */
  ip: boolean;
  /** takes its address by DHCP */
  dhcp: boolean;
  /** an aggregate (a virtual interface with members) */
  lag: boolean;
  /** a port of the device's bridge: a switch's port that is no aggregate's member, or an aggregate */
  bridgePort: boolean;
  /** a radio: a port of an access point with a wireless cable */
  radio: boolean;
}

function ifaceApplies(a: IfaceApplies, d: DeviceFacts, i: IfaceFacts): boolean {
  switch (a) {
    case 'ip':
      return i.ip;
    case 'routed':
      return i.ip && d.routes;
    case 'port':
      return i.port;
    case 'bridge-port':
      return i.bridgePort;
    case 'lag':
      return i.lag;
    case 'radio':
      return i.radio;
    case 'dhcp':
      return i.dhcp;
  }
  return false;
}

/** The simulation attributes of an interface (its own block), in order. */
export function interfaceParams(d: DeviceFacts, i: IfaceFacts): ParamDef[] {
  return PARAMS.filter((p) => p.level === 'interface' && (!p.device || p.device.some((a) => applies(a, d))) && (p.ifaces || []).some((a) => ifaceApplies(a, d, i)));
}

/** The simulation attributes of a VLAN (a network's block), in order. */
export function vlanParams(): ParamDef[] {
  return PARAMS.filter((p) => p.level === 'vlan');
}

/** What the applicability of a relation attribute needs to know about the relation. */
export interface RelFacts {
  /** its base protocol */
  base: string;
  /** a service relation of a load balancer (one of its pool) */
  lbService: boolean;
  /** a service relation of a server */
  serverService: boolean;
}

/** The simulation attributes of a relation (its own block), in order. */
export function relationParams(r: RelFacts): ParamDef[] {
  return PARAMS.filter((p) => p.level === 'relation' && (p.rels || []).some((x) => x === r.base || (x === 'lb-service' && r.lbService) || (x === 'server-service' && r.serverService)));
}

/** The simulation attributes of a DHCP scope or a DNS zone (its own block), in order. */
export function serviceParams(svc: SvcLevel): ParamDef[] {
  return PARAMS.filter((p) => p.level === 'service' && p.svc === svc);
}

/** Every attribute of a level, in order (for messages: where an attribute belongs). */
export function levelParams(level: ParamLevel): ParamDef[] {
  return PARAMS.filter((p) => (p.level || 'device') === level && (level !== 'device' || !!p.device));
}

/** Where an attribute is written, for messages: "per interface", "per VLAN (a network's simulation:)". */
export function levelText(def: ParamDef): string {
  const l = def.level || 'device';
  if (l === 'interface') {
    const i = def.ifaces || [];
    const what = i.indexOf('lag') >= 0 && i.length === 1 ? 'aggregate (LAG)' : i.indexOf('bridge-port') >= 0 ? 'switch port' : i.indexOf('radio') >= 0 ? 'radio (an access point’s wireless port)' : i.indexOf('port') >= 0 ? 'port' : 'interface';
    return `per ${what}: in the ${what}’s simulation:`;
  }
  if (l === 'vlan') return 'per VLAN: in the simulation: of the network with that VLAN';
  if (l === 'relation') return 'per relation: in the relation’s simulation:';
  if (l === 'service') return SVC_WHERE[def.svc || 'dhcp'];
  return 'per device: in the device’s simulation:';
}

const SVC_WHERE: { [k in SvcLevel]: string } = {
  dhcp: 'per DHCP scope: in the scope’s simulation:',
  dns: 'per DNS zone: in the zone’s simulation:',
  hypervisor: 'per Hypervisor service: in services.hypervisor.simulation:',
  vswitch: 'per virtual switch: in the virtual switch’s simulation:',
  container_engine: 'per Container engine: in services.container_engine.simulation:',
  separation: 'per Domain separation: in services.separation.simulation:',
};

/** Every device type has some attribute (boot time at least): for the docs and the tests. */
export function attributesByType(): Array<{ type: string; keys: string[] }> {
  return DEVICE_TYPE_IDS.map((type) => {
    // (as it is most often used: a switch and a VM with Layer 3, a server running guests, a System as a host)
    const d = { type, layer3: layer3Option(type) ? true : undefined, purpose: 'host' };
    const caps = capabilities(d);
    const f: DeviceFacts = { id: '', type, layer3: d.layer3, caps, ip: caps.ipStack, routes: caps.l3Forward, aggregate: caps.switchFeatures || caps.serviceHost || caps.l3Forward, ipsec: false, snmpManager: false, hypervisor: caps.canHostGuests.vms, engine: caps.canHostGuests.containers };
    return { type, keys: deviceParams(f).map((p) => p.key) };
  });
}

// ------------------------------------------------------------ values: parse, check, format

/** Parse a value as written in the model or typed in a field; an error text when it isn't one. */
export function parseValue(def: ParamDef, raw: unknown): { value: ParamValue } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { error: 'is empty' };
  if (def.kind === 'list') {
    const t = Array.isArray(raw) ? raw.map((x) => String(x)).join(', ') : String(raw);
    if (def.list === 'vlan-values') return parseVlanValues(t, def);
    if (def.list === 'addresses') return parseAddressList(t);
    const r = def.list === 'targets' ? parseTargets(t) : parsePorts(t);
    if ('error' in r) return r;
    return { value: def.list === 'targets' ? targetsText(r.list as Target[]) : portsText(r.list as PortRule[]) };
  }
  if (def.kind === 'enum') {
    // on / off may be written as true / false
    const onOff = (def.options || []).some((o) => o.value === 'on');
    const v = typeof raw === 'boolean' && onOff ? (raw ? 'on' : 'off') : String(raw).trim().toLowerCase();
    const ok = (def.options || []).some((o) => o.value === v);
    return ok ? { value: v } : { error: `must be one of ${(def.options || []).map((o) => o.value).join(', ')}` };
  }
  let n: number | null = null;
  if (def.kind === 'speed') {
    n = typeof raw === 'number' ? raw : parseSpeed(String(raw));
    if (n === null) return { error: 'is not a speed (e.g. 1G, 100M)' };
  } else if (def.kind === 'duration') {
    if (typeof raw === 'number') n = def.base === 's' ? raw * S : raw;
    else {
      const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(µs|us|ms|s|sec|min|m|h|d)?\s*$/i.exec(String(raw));
      if (!m) return { error: `is not a duration (e.g. ${def.base === 'ms' ? '300ms' : '30s'}, 5min, 4h)` };
      const v = Number(m[1]);
      const u = (m[2] || def.base || 's').toLowerCase();
      n = u === 'µs' || u === 'us' ? v / 1000 : u === 'ms' ? v : u === 'min' || u === 'm' ? v * 60 * S : u === 'h' ? v * 3600 * S : u === 'd' ? v * 86400 * S : v * S;
    }
  } else if (def.kind === 'percent') {
    const t = typeof raw === 'number' ? String(raw) : String(raw).trim().replace(/\s*%$/, '');
    if (!/^[0-9]+(\.[0-9]+)?$/.test(t)) return { error: 'is not a percentage (e.g. 0.5, 2%)' };
    n = Number(t);
  } else {
    const t = String(raw).trim();
    if (!/^[0-9]+$/.test(t)) return { error: 'must be a whole number' };
    n = Number(t);
  }
  const min = def.min !== undefined ? def.min : -Infinity;
  const max = def.max !== undefined ? def.max : Infinity;
  if (n < min || n > max) return { error: `must be from ${formatValue(def, min)} to ${formatValue(def, max)}` };
  if (def.step && n % def.step !== 0) return { error: `must be a multiple of ${def.step}` };
  return { value: n };
}

/** "10=4096, 20=8192": per VLAN (1–4094) a value of the parameter's range and step; normalized, by VLAN. */
export function parseVlanValues(text: string, def: ParamDef): { value: string } | { error: string } {
  const out = new Map<number, number>();
  for (const part of text.split(/[,;\s]+/).filter((x) => x)) {
    const m = /^([0-9]+)\s*[=:]\s*([0-9]+)$/.exec(part);
    if (!m) return { error: `has "${part}": write VLAN=value, e.g. 10=4096` };
    const vlan = Number(m[1]);
    const v = Number(m[2]);
    if (vlan < 1 || vlan > 4094) return { error: `has VLAN ${vlan}: a VLAN is from 1 to 4094` };
    if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) return { error: `has ${v} for VLAN ${vlan}: must be from ${def.min} to ${def.max}` };
    if (def.step && v % def.step !== 0) return { error: `has ${v} for VLAN ${vlan}: must be a multiple of ${def.step}` };
    if (out.has(vlan)) return { error: `names VLAN ${vlan} twice` };
    out.set(vlan, v);
  }
  return { value: Array.from(out).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v}`).join(', ') };
}

/** The value of one VLAN in a "10=4096, 20=8192" list (undefined: not listed). */
export function vlanValue(text: string, vlan: number): number | undefined {
  for (const part of String(text).split(/,\s*/)) {
    const [k, v] = part.split('=');
    if (Number(k) === vlan && v !== undefined) return Number(v);
  }
  return undefined;
}

/** "10.0.0.5, 10.0.9.5": IP addresses (a DHCP relay's servers), normalized. */
export function parseAddressList(text: string): { value: string } | { error: string } {
  const out: string[] = [];
  for (const part of text.split(/[,;\s]+/).filter((x) => x)) {
    if (!/^[0-9a-fA-F:.]+$/.test(part) || (!/^\d{1,3}(\.\d{1,3}){3}$/.test(part) && part.indexOf(':') < 0)) return { error: `has "${part}": not an IP address` };
    if (/^\d/.test(part) && part.indexOf(':') < 0 && part.split('.').some((o) => Number(o) > 255)) return { error: `has "${part}": not an IPv4 address` };
    if (out.indexOf(part.toLowerCase()) < 0) out.push(part.toLowerCase());
  }
  return { value: out.join(', ') };
}

/** A value as the UI writes it: "4 h", "300 ms", "1 Gbit/s", "0.5 %", "3" ("continuous" for a 0 that means it). */
export function formatValue(def: ParamDef, v: ParamValue): string {
  if (def.kind === 'list') return String(v) === '' ? def.zero || 'none' : String(v);
  if (def.kind === 'enum') {
    const o = (def.options || []).find((x) => x.value === v);
    return o ? o.label.replace(/ \(.*\)$/, '') : String(v);
  }
  const n = Number(v);
  if (n === 0 && def.zero) return def.zero;
  if (def.kind === 'count') return String(n);
  if (def.kind === 'percent') return `${n} %`;
  if (def.kind === 'speed') return speedText(n);
  return durationText(n);
}

/** A duration in ms as text: "4 h", "5 min", "30 s", "1.5 s", "300 ms", "0.1 ms". */
export function durationText(ms: number): string {
  if (ms === 0) return '0 s';
  const s = ms / S;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  if (ms >= S) return `${round(s, 3)} s`;
  if (ms >= 1) return `${round(ms, 3)} ms`;
  return `${round(ms * 1000, 3)} µs`;
}

function speedText(bps: number): string {
  if (bps >= 1e12 && bps % 1e12 === 0) return `${bps / 1e12} Tbit/s`;
  if (bps >= 1e9) return `${round(bps / 1e9, 3)} Gbit/s`;
  if (bps >= 1e6) return `${round(bps / 1e6, 3)} Mbit/s`;
  if (bps >= 1e3) return `${round(bps / 1e3, 3)} kbit/s`;
  return `${bps} bit/s`;
}

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

/** A value as a field (and the model, without a unit) holds it: a duration in its base unit, a speed like "1G". */
export function fieldText(def: ParamDef, v: ParamValue): string {
  if (def.kind === 'enum' || def.kind === 'list') return String(v);
  const n = Number(v);
  if (def.kind === 'duration') return String(round(def.base === 's' ? n / S : n, 6));
  if (def.kind === 'speed') {
    if (n % 1e12 === 0) return `${n / 1e12}T`;
    if (n % 1e9 === 0) return `${n / 1e9}G`;
    if (n % 1e6 === 0) return `${n / 1e6}M`;
    if (n % 1e3 === 0) return `${n / 1e3}k`;
    return String(n);
  }
  return String(n);
}

/** The unit a field shows beside it. */
export function fieldUnit(def: ParamDef): string {
  if (def.kind === 'duration') return def.base === 'ms' ? 'ms' : 's';
  if (def.kind === 'percent') return '%';
  if (def.kind === 'speed') return 'bit/s (1G, 100M)';
  return '';
}

/** The default of a parameter for a device type. */
export function defaultFor(def: ParamDef, type?: string): ParamValue {
  if (type && def.dfltByType && def.dfltByType[type] !== undefined) return def.dfltByType[type];
  return def.dflt;
}

/** The help line under a field: what it does, its default and the source of that. */
export function helpText(def: ParamDef, type?: string): string {
  const d = defaultFor(def, type);
  return `${def.help} Default ${formatValue(def, d)}: ${def.source}.${def.configured ? ` Overridden by ${def.configured}.` : ''}`;
}

// ------------------------------------------------------------ lists: ports and test targets

/** A port rule of a list: a transport and a port range ("tcp/443", "udp/5000-5010"), ICMP, or anything. */
export interface PortRule {
  proto: 'tcp' | 'udp' | 'icmp' | 'any';
  from: number;
  to: number;
}

/** A test target: a device (optionally an interface of it) or an address, with the test to run against it (none: the test type in effect). */
export interface Target {
  /** a device id ("web1", "web1:eth0") or an address */
  to: string;
  test?: PortRule;
}

/** "tcp/443, udp/53, icmp, any" (or "none") → the rules; an error text for a bad entry. */
export function parsePorts(text: string): { list: PortRule[] } | { error: string } {
  const out: PortRule[] = [];
  const t = text.trim();
  if (t.toLowerCase() === 'none') return { list: out };
  for (const raw of t.split(/[,\s]+/).filter((x) => x)) {
    const r = portRule(raw);
    if (!r) return { error: `has "${raw}": write tcp/443, udp/53, tcp/8000-8080, icmp or any` };
    out.push(r);
  }
  if (!out.length) return { error: 'is empty (write none for no entry)' };
  return { list: out };
}

function portRule(raw: string): PortRule | null {
  const x = raw.trim().toLowerCase();
  if (x === 'icmp' || x === 'any') return { proto: x, from: 0, to: 0 };
  const m = /^(tcp|udp)\/([0-9]{1,5})(?:-([0-9]{1,5}))?$/.exec(x);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] !== undefined ? Number(m[3]) : from;
  if (from < 1 || to > 65535 || to < from) return null;
  return { proto: m[1] as 'tcp' | 'udp', from, to };
}

export function portsText(list: PortRule[]): string {
  if (!list.length) return '';
  return list.map((r) => (r.proto === 'icmp' || r.proto === 'any' ? r.proto : `${r.proto}/${r.from}${r.to !== r.from ? '-' + r.to : ''}`)).join(', ');
}

/** "web1 tcp/443, 10.0.0.9, db1:eth0 udp/53" (or "none") → the targets. */
export function parseTargets(text: string): { list: Target[] } | { error: string } {
  const out: Target[] = [];
  const t = text.trim();
  if (t.toLowerCase() === 'none') return { list: out };
  for (const raw of t.split(',').map((x) => x.trim()).filter((x) => x)) {
    const parts = raw.split(/\s+/);
    if (parts.length > 2 || !/^[A-Za-z0-9_.:\-]+$/.test(parts[0])) return { error: `has "${raw}": write a device or an address, optionally followed by tcp/443, udp/53 or icmp` };
    const tgt: Target = { to: parts[0] };
    if (parts.length === 2) {
      const r = portRule(parts[1]);
      if (!r || r.proto === 'any' || r.from !== r.to) return { error: `has "${raw}": the test is tcp/<port>, udp/<port> or icmp` };
      tgt.test = r;
    }
    out.push(tgt);
  }
  if (!out.length) return { error: 'is empty (write none for no entry)' };
  return { list: out };
}

export function targetsText(list: Target[]): string {
  return list.map((x) => x.to + (x.test ? ' ' + portsText([x.test]) : '')).join(', ');
}

/** Does a port rule list match a packet (its transport and destination port; ICMP by its kind)? */
export function portsMatch(list: PortRule[], proto: string, port: number): boolean {
  return list.some((r) => r.proto === 'any' || (r.proto === proto && (proto === 'icmp' || (port >= r.from && port <= r.to))));
}

// ------------------------------------------------------------ resolution

export interface Resolved {
  value: ParamValue;
  source: Source;
  /** where a configured value is written ("relation ospf-r1-r2") */
  where?: string;
  def: ParamDef;
}

/** A configured value, from the object in the model (the caller reads it). */
export interface Configured {
  value: ParamValue;
  where: string;
}

/** "(configured on …)", "(device)", "(simulation)", "(default, RFC …)" */
export function sourceText(r: Resolved, long = false): string {
  if (r.source === 'configured') return r.where ? `configured on ${r.where}` : 'configured';
  if (r.source === 'object') return r.where ? `set on ${r.where}` : 'set on the object';
  if (r.source === 'device') return 'device';
  if (r.source === 'simulation') return 'simulation';
  return long ? `default — ${r.def.source}` : 'default';
}

export function resolvedText(r: Resolved): string {
  return `${formatValue(r.def, r.value)} (${sourceText(r)})`;
}

/** A parameter change, as the event log writes it. */
export interface ParamChange {
  key: string;
  device?: string;
  /** an object's attribute ("iface:r1:ge1", "vlan:10", "rel:ipsec-br") */
  object?: string;
  from: ParamValue;
  to: ParamValue;
  source: Source;
}

/**
 * The parameters in effect: simulation-wide values (only those that differ
 * from the default are kept) and each device's attributes. The resolver of
 * the order of precedence above.
 */
export class SimParams {
  private sim = new Map<string, ParamValue>();
  private dev = new Map<string, Map<string, ParamValue>>();
  /** the objects' attributes, by object ("iface:<dev>:<iface>", "vlan:<n>", "rel:<id>") */
  private obj = new Map<string, Map<string, ParamValue>>();
  private types = new Map<string, string>();
  /** bumped on every change (readers cache by it) */
  version = 0;

  constructor(sim?: { [key: string]: ParamValue }, devices?: Map<string, { type: string; values: Map<string, ParamValue> }>) {
    if (sim) for (const k of Object.keys(sim)) if (BY_KEY.has(k)) this.setSim(k, sim[k]);
    if (devices) for (const [id, d] of devices) this.setDevice(id, d.type, d.values);
  }

  /** The simulation-wide value (an explicit one, or the default). */
  simValue(key: string): ParamValue {
    const v = this.sim.get(key);
    return v !== undefined ? v : paramDef(key).dflt;
  }

  /** The simulation-wide values that differ from their defaults. */
  simValues(): { [key: string]: ParamValue } {
    const out: { [key: string]: ParamValue } = {};
    for (const [k, v] of this.sim) out[k] = v;
    return out;
  }

  /** Set a simulation-wide value (undefined, or the default: back to the default). Returns the change, or null. */
  setSim(key: string, v: ParamValue | undefined): ParamChange | null {
    const def = paramDef(key);
    const from = this.simValue(key);
    if (v === undefined || v === def.dflt) this.sim.delete(key);
    else this.sim.set(key, v);
    const to = this.simValue(key);
    if (to === from) return null;
    this.version++;
    return { key, from, to, source: 'simulation' };
  }

  /** A device's own value of an attribute (undefined: it inherits). */
  deviceValue(device: string, key: string): ParamValue | undefined {
    const m = this.dev.get(device);
    return m ? m.get(key) : undefined;
  }

  /** Replace a device's attributes (from its `simulation:` block); the changes of their values in effect. */
  setDevice(device: string, type: string, values: Map<string, ParamValue>): ParamChange[] {
    const before = new Map<string, ParamValue>();
    const keys = new Set<string>(Array.from(values.keys()).concat(Array.from((this.dev.get(device) || new Map()).keys())));
    for (const k of keys) before.set(k, this.get(k, device).value);
    this.types.set(device, type);
    this.dev.set(device, new Map(values));
    const out: ParamChange[] = [];
    for (const k of Array.from(keys).sort()) {
      const r = this.get(k, device);
      if (r.value !== before.get(k)) out.push({ key: k, device, from: before.get(k) as ParamValue, to: r.value, source: r.source });
    }
    if (out.length) this.version++;
    return out;
  }

  /** An object's own value of an attribute (undefined: it inherits). */
  objectValue(object: string, key: string): ParamValue | undefined {
    const m = this.obj.get(object);
    return m ? m.get(key) : undefined;
  }

  /** Replace an object's attributes (its `simulation:` block); the changes of their values in effect there. */
  setObject(object: string, device: string | undefined, values: Map<string, ParamValue>): ParamChange[] {
    const keys = new Set<string>(Array.from(values.keys()).concat(Array.from((this.obj.get(object) || new Map()).keys())));
    const before = new Map<string, ParamValue>();
    for (const k of keys) before.set(k, this.get(k, device, null, object).value);
    if (values.size) this.obj.set(object, new Map(values));
    else this.obj.delete(object);
    const out: ParamChange[] = [];
    for (const k of Array.from(keys).sort()) {
      const r = this.get(k, device, null, object);
      if (r.value !== before.get(k)) out.push({ key: k, device, object, from: before.get(k) as ParamValue, to: r.value, source: r.source });
    }
    if (out.length) this.version++;
    return out;
  }

  /** The objects that have values, by kind ("iface:", "vlan:", "rel:"). */
  objects(prefix: string): string[] {
    return Array.from(this.obj.keys()).filter((k) => k.indexOf(prefix) === 0).sort();
  }

  /**
   * The value in effect, and where it comes from: what is configured on the
   * object in the model, then the object's attribute (`at`: its interface,
   * VLAN or relation), then the device's (an attribute of the device, or
   * the device-wide default of an object attribute that has one), then the
   * simulation's, then the default.
   */
  get(key: string, device?: string, configured?: Configured | null, at?: string | null): Resolved {
    const def = paramDef(key);
    if (configured) return { value: configured.value, source: 'configured', where: configured.where, def };
    if (at) {
      const v = this.objectValue(at, key);
      if (v !== undefined) return { value: v, source: 'object', where: objectWhere(at), def };
    }
    if (device !== undefined && deviceWide(def)) {
      const v = this.deviceValue(device, key);
      if (v !== undefined) return { value: v, source: 'device', def };
    }
    const s = this.sim.get(key);
    if (s !== undefined) return { value: s, source: 'simulation', def };
    return { value: defaultFor(def, device !== undefined ? this.types.get(device) : undefined), source: 'default', def };
  }

  /** A number in effect (durations in ms). */
  num(key: string, device?: string, configured?: Configured | null, at?: string | null): number {
    return Number(this.get(key, device, configured, at).value);
  }

  str(key: string, device?: string, at?: string | null): string {
    return String(this.get(key, device, null, at).value);
  }

  /** What a device inherits for an attribute (its own value left out): the simulation's value or the default. */
  inherited(key: string, device: string): Resolved {
    const def = paramDef(key);
    const s = this.sim.get(key);
    if (s !== undefined) return { value: s, source: 'simulation', def };
    return { value: defaultFor(def, this.types.get(device)), source: 'default', def };
  }

  /** What an object inherits for an attribute (its own value left out): the device's default, the simulation's value or the default. */
  inheritedAt(key: string, device: string | undefined): Resolved {
    return this.get(key, device, null, null);
  }
}

/** Can a device's own block set this attribute: a device attribute, or an object attribute with a device-wide default? */
export function deviceWide(def: ParamDef): boolean {
  return !def.level || def.level === 'device' || !!def.devDefault;
}

/** An object reference as the sources write it: "r1:ge1", "VLAN 10", "relation ipsec-br". */
export function objectWhere(at: string): string {
  if (at.indexOf('iface:') === 0) return at.slice(6);
  if (at.indexOf('vlan:') === 0) return 'VLAN ' + at.slice(5);
  if (at.indexOf('rel:') === 0) return 'relation ' + at.slice(4);
  if (at.indexOf('scope:') === 0) return `DHCP scope ${Number(at.split(':')[2]) + 1} of ${at.split(':')[1]}`;
  if (at.indexOf('zone:') === 0) return `zone ${at.split(':').slice(2).join(':')} of ${at.split(':')[1]}`;
  return at;
}

/** The object references of the engine and the Inspector. */
export const ifaceRef = (device: string, iface: string): string => `iface:${device}:${iface}`;
/** A VLAN's reference: the untagged frames of switches without VLANs (0 inside the simulation) are VLAN 1, a switch's default VLAN. */
export const vlanRef = (vlan: number): string => `vlan:${vlan || 1}`;
export const relRef = (id: string): string => `rel:${id}`;
/** A DHCP scope's (by its position in the server's list) and a DNS zone's reference. */
export const scopeRef = (device: string, index: number): string => `scope:${device}:${index}`;
export const zoneRef = (device: string, zone: string): string => `zone:${device}:${zone}`;
/** a hypervisor's service, one of its virtual switches, a container engine: their simulation attributes */
export const hvRef = (device: string): string => `hv:${device}`;
export const vswRef = (device: string, vswitch: string): string => `vsw:${device}:${vswitch}`;
export const ceRef = (device: string): string => `ce:${device}`;

/** A change as the event log writes it: "Parameter changed: ARP timeout 4 h → 60 s (simulation)". */
export function changeText(c: ParamChange): string {
  const def = paramDef(c.key);
  const on = c.object ? ' on ' + objectWhere(c.object) : c.device ? ' on ' + c.device : '';
  return `Parameter changed: ${def.label}${on} ${formatValue(def, c.from)} → ${formatValue(def, c.to)} (${c.source === 'object' ? 'set there' : c.source})`;
}

/** The simulation-wide values as stored for the browser session (JSON): only known keys with valid values. */
export function readStoredParams(json: string | null): { [key: string]: ParamValue } {
  const out: { [key: string]: ParamValue } = {};
  if (!json) return out;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch (e) {
    return out;
  }
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(o as object)) {
    const def = BY_KEY.get(k);
    if (!def || def.layer === 0) continue;
    const v = (o as { [k: string]: unknown })[k];
    if (typeof v !== 'number' && typeof v !== 'string') continue;
    const p = def.kind === 'enum' ? parseValue(def, v) : typeof v === 'number' && Number.isFinite(v) && (def.min === undefined || v >= def.min) && (def.max === undefined || v <= def.max) ? { value: v } : { error: 'bad' };
    if ('value' in p) out[k] = p.value;
  }
  return out;
}

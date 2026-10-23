/**
 * One catalog of what NetAtlas implements, read from the definitions that
 * carry it (model/support.ts): the protocols of the simulation
 * (model/sim-profiles.ts), the services (model/service-registry.ts), the
 * application profiles (model/applications.ts), and what the static
 * analysis evaluates (below). The User Manual shows it, and
 * docs/SUPPORT.md is generated from it (scripts/gen-support.mjs), so a
 * statement of support is written once. Each entry says what is
 * implemented and what is left out; docs/LIMITATIONS.md adds the
 * simplifications that cut across them.
 */
import { APP_PROFILES } from './applications';
import { IC_SUPPORT } from './interconnect';
import { SERVICES } from './service-registry';
import { SIM_GROUPS, SIM_PROFILES } from './sim-profiles';
import { Support, SupportLevel } from './support';

/** What a static analysis evaluates, and what it does not (no level: it runs no exchanges). */
export interface AnalysisSupport {
  id: string;
  name: string;
  does: string;
  not: string;
}

/**
 * The static analyses (Analyze, the consistency checks): what each
 * evaluates from the configured model or a simulation snapshot, and what
 * only the simulation (or nothing in NetAtlas) establishes.
 */
export const ANALYSIS_SUPPORT: readonly AnalysisSupport[] = [
  {
    id: 'trace',
    name: 'Trace path',
    does: 'Longest-prefix forwarding over connected networks, static routes (distance, metric, recursive next hops) and the routes of enabled routing protocols’ adjacencies through the routing-policy subset (advertised prefixes, a default route, redistribution with its origin history, ordered import/export filters, BGP local preference and AS path); equal-cost paths (up to 16), VRFs, VRRP / HSRP holders, tunnels with their traced underlay, the layer-2 way through VLANs and Wi-Fi networks; the filtering decision of network policies (routers, Layer 3 switches, firewalls) and Security gateways for a given service; NAT of container bridges.',
    not: 'the NAT service’s translations (the simulation applies them), policy-based routing, MPLS label forwarding, multicast forwarding (the simulation forwards multicast), spanning-tree blocking (the cable way is the shortest one through layer-2 devices).',
  },
  {
    id: 'policy',
    name: 'Network policy',
    does: 'One engine for Trace path, the communication checks and the simulation: a router’s, Layer 3 switch’s or firewall’s ordered rules (addresses and objects, protocol, ports, interfaces and zones, an explicit default action), the rule that decided named (also for the packets of relations and tunnels through it, and IP protocols without ports by `proto: any` rules and the default action, tracked by address pair and IP protocol number); a firewall without one: its relations and allow list. A rule naming a device: that device’s addresses, checked against the device the traffic reaches (an address several devices have and no owner known: undecided, never permitted).',
    not: 'a return decision statically (the simulation keeps a stateful policy’s sessions); application identification, TLS inspection, user identities, NAT rules, VLAN ACLs.',
  },
  {
    id: 'communication',
    name: 'Communication check',
    does: 'Address, name resolution (the model’s DNS zones and forwarders), the path over every evaluated equal-cost path, the modeled policy, the destination’s listener and bind interface, for applications and services; the reverse direction as reverse routing and symmetry.',
    not: 'that the application accepts the connection, authentication, a TCP session, a stateful return decision, health and completion: runtime behaviour, which the simulation exchanges.',
  },
  {
    id: 'mtu',
    name: 'Path MTU',
    does: 'The largest packet that crosses each evaluated path unfragmented, and the payload that fits (TCP MSS, UDP or ICMP payload): the interfaces’ written MTUs, both ends of the cables on the way, tunnels as the largest inner packet their underlay leaves room for, with the encapsulation sizes the simulation’s packets have (the outer header of the tunnel’s family, a UDP tunnel’s UDP, the format’s header, ESP’s padding, VXLAN’s and Geneve’s inner Ethernet; nested layers inside out), equal-cost branches and the return path apart.',
    not: 'an MTU that is not written (never taken as 1500: the result is then an upper bound); formats other than the one assumed per protocol (a GRE key, AES-GCM, Geneve options: a few bytes); a tunnel without a known format is taken as GRE and its limit called an estimate; the size a flow actually uses (the simulation’s fragmentation, Fragmentation Needed / Packet Too Big and PMTUD show it).',
  },
  {
    id: 'diagnosis',
    name: 'Diagnosis',
    does: 'The answer to one communication question in order — its state (established, blocked, waiting, recovered, partial, not established), what prevents or limits it, the evidence chain, the separate legs, the next actions — from the communication check and, once compared, a recorded send’s structured records: each message’s outcome, the recorded cause of the last drop of its packets (the packet, its outer header, the rule or interface), its waits, retransmissions and DNS queries, the equal-cost branch taken; an MQTT client’s legs by their counters; every piece of evidence a link to what it names.',
    not: 'causes not recorded (said as not established, never guessed), coincidences in time as causes, a single root cause where several blockers exist, records no longer kept (said as evidence-limited), a per-publication MQTT trail, a diagnosis of production networks.',
  },
  {
    id: 'addressing',
    name: 'Addressing overview',
    does: 'Each host address in its allocation state (configured, reserved, acquired in a snapshot, DHCP pool, nested network, unallocated); suggestions outside pools, reservations and used addresses; duplicates in the scope the model establishes (a link-local address on its VLAN-scoped segment, any other in a VRF and a connected part).',
    not: 'addresses used outside the model, SLAAC interface identifiers in the configured model (a snapshot has them).',
  },
  {
    id: 'dependencies',
    name: 'Service dependencies',
    does: 'Only what the model configures: application peers, MQTT brokers, resolvers, DHCP (a server on the client’s broadcast domain with a scope for it, or an IPv4 relay whose way passes the path, the policy and the listener both ways), timing sources, syslog senders and AAA clients; compared under a failure.',
    not: 'dependencies nobody wrote down, business importance, DHCPv6 relays (DHCPv6 is served on the client’s link only), the remaining lease time of addresses already given.',
  },
  {
    id: 'failure',
    name: 'Failure analysis and what if',
    does: 'Single points of failure (each cable, device and LAG alone) with their structural and service impact; what-if conditions of failure domains or up to 64 components, compared with the same baseline: dependencies, every saved expectation (availability and isolation), reachability of device pairs in a scope, and the stated traffic against the stated capacity (cables, an aggregate’s surviving members, shared radios; overload although still carried said apart).',
    not: 'probabilities, convergence and recovery times, combinations beyond the condition given; throughput, queues, delay and hardware forwarding limits; a spread of traffic over equal-cost paths or bundle members (both an equal split and all on one path are evaluated).',
  },
  {
    id: 'timing',
    name: 'Timing source paths',
    does: 'By the method asked for (PTP, NTP, or either: both reported). PTP: a source-capable clock of the domain and profile on the clock’s VLAN-scoped segments or behind boundary clocks. NTP: the configured source chain, upstream by upstream — each an address, reachable on UDP 123 (path, policy, listener), the device it is the one its traffic reaches — to a configured reference, with cycles, chains without a reference, upstreams outside the model and alternative roots said apart from a merely reachable upstream; a snapshot adds the synchronization the simulation observed.',
    not: 'accuracy (the simulation models the protocol states, not oscillators or clock discipline); precedence or bridging between NTP and PTP.',
  },
  {
    id: 'experiments',
    name: 'Saved experiments',
    does: 'An explicitly configured sequence run on the shared engine from its defined start (freshly booted, settled, or a cold start: every device with a power lifecycle booting; the entire model, its targets and their dependencies, or another scope), on scenario time: sends prepared from the communication’s identity, failures and restores, interface and power actions (with how long they last), joins and leaves, scenario-time multicast streams, applications; steps after an earlier action’s submission, an action waiting for its device to come up; observations of delivery, reception, MQTT delivery, device, interface and cable state, an address acquired, a neighbor resolved, a route, a protocol session, multicast membership, a timing state, a communication and the saved expectations, each over its window with the moment it was reached; played in the diagram with only its own traffic shown (its operations and their prerequisites); a run compared with the previous one.',
    not: 'real-time streams of Network events (they run on browser time); requirements it was not given (it never checks the architecture as a whole by itself); membership learned by a snooping switch; a state held for a period; convergence time, throughput and synchronization accuracy; a scripting language.',
  },
  {
    id: 'snapshot',
    name: 'Simulation snapshots',
    does: 'The state of a running simulation at one moment for the analyses: leases, SLAAC and DHCPv6 addresses with their state, what is up, the routes learned.',
    not: 'later changes of the running simulation; hypothetical failures applied to it (they would blend two states).',
  },
];

export interface SupportEntry {
  /** the area it is listed under */
  area: string;
  id: string;
  name: string;
  support: Support;
}

/** The protocols, services and application profiles with their support, by area (stable order). */
export function supportCatalog(): SupportEntry[] {
  const out: SupportEntry[] = [];
  for (const g of SIM_GROUPS) {
    if (g === 'Custom') continue;
    for (const p of SIM_PROFILES) if (p.group === g && p.support) out.push({ area: `Protocols: ${g}`, id: p.id, name: p.label, support: p.support });
  }
  for (const s of SERVICES) out.push({ area: 'Services', id: s.id, name: s.label, support: s.support });
  for (const a of APP_PROFILES) out.push({ area: 'Application profiles', id: a.id, name: a.label, support: a.support });
  out.push({ area: 'Non-IP interconnects', id: 'interconnect', name: 'Interconnects and opaque ports', support: IC_SUPPORT });
  return out;
}

/** The areas of the catalog, in order. */
export function supportAreas(): string[] {
  const out: string[] = [];
  for (const e of supportCatalog()) if (out.indexOf(e.area) < 0) out.push(e.area);
  return out;
}

export type { SupportLevel };

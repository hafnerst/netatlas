# Limitations

NetAtlas is an architecture-level workbench: it models, analyzes and
simulates the behaviour that matters for a network's design. It is not a
digital twin and emulates no vendor operating system.

This page is organized by area. Each area says what is **implemented**,
the important **simplifications**, and what is **not supported**. What each
protocol, service and application profile implements is stated once, in the
definitions themselves: [SUPPORT.md](SUPPORT.md) lists those statements (the
application shows the same ones in its ⓘ notes and in Help → User Manual →
*What NetAtlas models*). The README has a short overview.

## Analysis and simulation

**Implemented.** Two ways to ask a question, which never run behind each
other's back:

| | Static analysis (Analyze) | Simulation (Simulate) |
| --- | --- | --- |
| Works on | the configured model, or a snapshot of a running simulation | the model, started from a clean state |
| Answers | what the configuration establishes: paths, policy decisions, listeners, allocation, dependencies, failure impact | what the modeled protocols do over time: exchanges, states, leases, convergence order, delivery |
| Sends | nothing | modeled messages, scheduled on a simulated clock |
| Result | a verdict (satisfied, violated, partial, beyond modeled scope, indeterminate, unsupported) with its context, scope, coverage and assumptions | events, tables and delivery outcomes |

**Simplifications.**

* A result is computed once and stays as it was: after an edit it is marked
  *Outdated* until you press **Refresh**.
* A snapshot holds what the running simulation had at one moment (leases,
  SLAAC and DHCPv6 addresses with their state, what was up, each router's
  installed routes — what it had learned by its last recomputation); it is
  not updated as the simulation goes on.
* An execution scope runs fewer devices, closed over what they depend on
  (each device added examined in turn); a relation with more than two
  endpoints runs with those inside. Where what is left out can change the
  outcome (such a relation, demands from outside), the scope says it *may
  differ from the entire model*; its results are the scope's.
* Analyses that would blend two states refuse: a hypothetical failure is
  applied to the configured model only, never to a snapshot.
* **Compare with simulation** takes only a send that carried the check's
  identity: its source interface — and, for a check from an exact
  address, a send that left from that address as recorded when it was
  sent (an interface is not an address: Send network packets names the
  interface, which sends from an address of its own choosing, and says
  so) —, the destination by its binding, the family, the port and the
  routing context. While messages are on their way or still to be sent
  the comparison is provisional.
* An execution scope keeps an interconnect's `traffic:` only where its
  initiator, its source, the recipient and every transit device on the
  way are inside; the scope says which transfers it leaves out.
* **Diagnosis** (Trace path) is built only from what was recorded: the
  communication check's layers and, once compared, the structured records
  of the run asked about — a send, a client application's own newest run
  (its retries one message's attempts), or an MQTT client's newest run:
  each message's outcome (answered, refused, unreachable, too big, timed
  out, lost, not sent, no address, name not resolved, cancelled), the
  device that answered and the reason it recorded, every drop recorded in
  its exchange with its cause, what it waited for, its TCP retransmissions,
  its DNS queries' fates, the equal-cost branch it took, and the recorded
  state changes of what it needed. It answers apart whether the run
  finished, what was observed and whether a cause is established. It never
  reads a cause from a log line's words, never takes a later state for the
  state when a packet was sent, and links only what a record links. A
  timeout is an observed outcome: its cause is established only when every
  attempt has a recorded drop; else the drops are *contributing* and the
  cause *not established* — the answer, or its way back, may be what is
  missing. A RST says what its sender recorded (a closed port, a policy's
  rule, no connection), never more. A route there later is an observed
  difference: what changed is not established. Things that merely
  happened at the same time are not linked.
* A prerequisite chain goes as far as the records: a missing route or a
  tunnel down → the relation the configured path uses there → its recorded
  state change (or that it never came up, when the log reaches back to the
  start) → for a session that heard nothing, the recorded fate of its own
  packets in that interval (decisive only when each was dropped, all by one
  cause). A route withdrawn by a routing protocol is linked to the relation
  the path uses, not to the protocol's individual updates.
* What a diagnosis can read is bounded: the event log keeps its latest
  20 000 events, the packet records the latest 8 192 packets, the MQTT
  records the latest 2 000 publications, the transport its last 400 tests,
  the engine the waits of as many. A test's outcome keeps its own drops (at
  most 8) and how far back the log reached when it ended, so a terminal
  outcome stays usable after the log moved on; a diagnosis whose records
  were gone already says it is *evidence-limited* and does not explain it,
  and a link to an event, packet or message no longer kept — or of an
  earlier simulation — says it is unavailable. A diagnosis is kept with its
  result (also across leaving Analyze) and never recomputed; after an edit
  it is marked outdated.
* An MQTT diagnosis reads the run's own publications (one record each, its
  DUP copies counted apart): the broker's receipt (recorded at the broker,
  also at QoS 0), the PUBACK (still pending: waiting), a loss with a closed
  connection, and each subscriber's receipt of them; other publishers',
  other topics' and earlier runs' traffic never count. QoS 2, persistent
  sessions and retained messages are not modelled.
* Drops that still record no structured cause: protocol-internal ones
  (an OSPF Hello ignored, an IKE request outside the window, a DHCP scope
  exhausted …), TCP's sequence checks (a RST or segment ignored), storm
  control and illustrative data on non-IP interconnects. A diagnosis says
  such a failure's cause is not established.
* Static analysis and simulation still differ where one has state the
  other has not: a stateful firewall passes a packet as the reply of a
  session the other direction opened (also for IP protocols without
  ports, tracked by address pair), which the static policy check, deciding
  each direction by its rules, does not know; a tunnel whose keepalives a
  policy denies goes down at run time (no route over it), which the static
  trace, following the configuration, does not foresee.

**Not supported.** Runtime behaviour that no static analysis establishes
(that an application accepts a connection, authenticates, answers or
completes; a TCP session; a stateful return decision) is reported as such,
never claimed. Opening an analysis result never starts the simulation or
sends traffic.

## Addressing and IP configuration

**Implemented.** IPv4 and IPv6 addresses on interfaces; DHCP (IPv4, through
relays) and DHCPv6 (stateful and stateless) from the servers' scopes; router
advertisements, SLAAC and duplicate address detection; DNS names, zones and
forwarders. The Addressing overview counts each host address once, in its
allocation state (configured, reserved, acquired in a snapshot, DHCP pool,
nested network, unallocated), and suggests only unallocated addresses.

**Simplifications.**

* **Membership is by address.** A network has no VRF of its own: it is
  listed in the VRFs of the interfaces with addresses in it (and of DHCP
  clients on cables carrying its VLAN), and in the default table when it has
  none. VRFs are names on interfaces; the same prefix in two VRFs is one
  network with members from both. Two listings of one network share an
  address space only where a member of one is on the switched segment of
  the other.
* **One prefix per network.** A segment with an IPv4 and an IPv6 prefix is
  two networks (they may share a VLAN). A device without addresses (an
  unmanaged switch, an access point in bridge mode) is a member of no
  network.
* **Addresses known to the model only.** "Unallocated in model" is the
  model's statement: an address used outside NetAtlas is not known.
  Gateways are found where the model writes them (virtual addresses, default
  routes, DHCP scopes). A DHCP client has no address in the configured model
  (a snapshot has its lease); SLAAC interface identifiers are not predicted
  in the configured model (a snapshot has them). IPv6 free ranges include a
  subnet's first address (the subnet-router anycast address), which is
  never offered as the next address; large IPv6 networks list their free
  ranges as ranges.
* **Duplicates in the scope the model establishes.** A link-local address
  is unique on its segment — the broadcast domain of its VLAN, the same one
  the simulation forwards in; any other in a VRF and a connected part of the
  architecture. An owner without a cable or relation has an unknown scope:
  a *possible* conflict.
* **IPv6 interfaces.** Static IPv6 addresses enable IPv6 on an interface:
  its link-local address (written fe80::, else from its MAC) is tentative
  until duplicate address detection passes. A written global address runs
  it too (tentative meanwhile: not a source, not answered for; a duplicate
  found on the link is never used — the first holder keeps it), as do
  acquired addresses (SLAAC, DHCPv6). Validation reports duplicates written
  in the model; the detection is what the running network finds.
* **DHCP and DNS.** One lease per interface; each DHCP message has its leg's
  UDP ports (client 68 → 67, relay ↔ server 67 → 67, to the client 67 → 68)
  in its interface's VRF; renewing and rebinding are sent again after half
  the time left. DNS has no negative caching,
  DNSSEC or TCP fallback and recurses only through the model's DNS servers.
  A name belongs to whole interfaces, never one address of an interface. A
  DHCP client without a DHCP server in the model gets no address (or a
  link-local one with its fallback on). DHCP is not available on loopbacks.
* **Addresses in `attrs`** are recognised by their value (an IPv4 / IPv6
  address or prefix, a MAC address) and drawn with their key; other
  identifiers there (a route target, a VNI) stay in the details.

**Not supported.** DHCPDECLINE, RELEASE, INFORM and option 82; DHCPv6
relays and prefix delegation (DHCPv6 is served on the server's own link);
privacy addresses (RFC 8981) and SEND; proxy ARP and proxy NDP.

## Layer 2

**Implemented.** 802.1Q access and trunk ports by VLAN ID, native VLANs,
VLAN interfaces, subinterfaces and aggregates; a spanning tree per VLAN;
LACP; Wi-Fi networks mapped to VLANs; virtual switches with port groups and
container networks; inline and pass-through devices between paired ports.
One definition of a broadcast domain serves the simulation, the
consistency checks and the analyses: a VLAN number alone never joins two
segments, and a port that names no VLAN context (a trunk) is not known
rather than every VLAN.

**Simplifications.**

* **VLANs are IDs.** A VLAN exists in the model when a network or a VLAN
  interface names it (VLAN 1 always does); a trunk's VLANs are its allowed
  list, pruned by nothing else. A routed port with subinterfaces is compared
  with a trunk on its tagged VLANs only.
* **Spanning tree.** The tree is computed from the topology, converged at
  the start; after a change the ports converge with the mode's timer (RSTP
  at once or after 3 hellos, STP 30 or 50 s), not BPDU by BPDU. Loops are
  broken by a tree per VLAN unless the switches' spanning tree is set off;
  a topology change flushes the VLAN's MAC tables. The path tracer takes
  the shortest cable way through layer-2 devices (as a tree might leave it).
* **Layer 2 switches** have one management interface with addresses; a
  switch that routes says `layer3: true`.
* **LACP** (IEEE 802.1AX): each LACPDU carries its actor's LACP_Timeout;
  a member transmits at the rate its partner's timeout asks for (fast
  while it is short) and times out by its own; a member goes back to
  Attached (no traffic) when its partner says it is not in sync, and tells
  its partner at once when it times out. Not modelled: churn detection,
  marker PDUs, partner key details beyond the aggregate's identity.
* **Wi-Fi without radio.** A client is associated with the network its
  connection names; WPA security is a label (no 4-way handshake or 802.1X).
  A network tunneled to its controller is not simulated (the simulation and
  the tracer say so).
* **Virtual networking is the network side.** Each host's virtual switch is
  its own; a VM moves only by an HA restart in the simulation (on the first
  member, by id, that is on; no admission control or resources); a host's
  inventory (CPU, RAM) is only compared. An overlay container network is one
  network.

**Not supported.** Q-in-Q, VLAN translation, private VLANs, voice VLANs,
dynamic VLAN assignment (802.1X, VTP, MVRP), per-VLAN port costs and MSTP
regions; radio-frequency models (channels, coverage, interference, rates,
roaming) and a controller's own forwarding; Kubernetes (a node is a
container host, its pods containers), nested virtualization, vMotion,
distributed switches spanning hosts and overlay tunnels between container
hosts.

## Routing

**Implemented.** Connected networks, static routes (longest prefix, then
distance — a missing one counts as 1 — then metric; recursive next hops),
VRFs, and the routes of the enabled routing protocols' adjacencies. In the
simulation the protocols' sessions and adjacencies form and fail with
their timers (see SUPPORT.md for each); each router's routes come from
what the advertisements it received told it (below).

**Simplifications.**

* **Routes follow the adjacencies and a bounded policy, not the protocols'
  algorithms.** Every router of an adjacency originates its connected
  networks (or, with a policy, what it advertises, a default route and
  what it redistributes) and passes on what it learns through the ordered
  import and export filters; the lowest cost wins (a hop unless a `cost`
  is written), for BGP first the highest local preference and the
  shortest AS path. In the simulation each router computes them from the
  records it has learned, one database per routing instance (a protocol in
  a VRF): each record is a router's adjacencies of that instance and its
  interfaces that are up, with a sequence number, carried only by that
  protocol's own advertisements (OSPF and IS-IS flood them and send them
  again after 5 s until acknowledged, EIGRP likewise, BGP's UPDATEs go over
  TCP) and flooded only over that instance's sessions — OSPF never teaches
  BGP, nor one VRF another; redistribution is the policy's. A message is
  taken only when the protocol's state machine allows it (OSPF from
  Exchange on, IS-IS and EIGRP adjacencies up, BGP Established). The
  records are an abstraction of the databases, not LSAs or BGP paths field
  by field: the prefixes a router originates are computed from its
  configuration, the knowledge of its adjacencies from the records. A
  router knows another router's interfaces by the newest record of it,
  whatever its instance. An adjacency forms only where the two have a
  network in common (a BGP session may also run between loopbacks; IS-IS
  forms on a cable whatever the addresses).
* **RIP is a distance vector** of its own: each router's table (prefix,
  metric, the neighbour it came from, a timeout) comes from its
  neighbours' Responses only, with split horizon and poisoned reverse,
  withdrawal with 16, a 180 s timeout and 120 s garbage collection, and
  triggered updates after 1–5 s, from and to UDP 520; a router asks its
  neighbours for their tables (a Request) at every boot and when an
  interface comes up again. RIPng (RFC 2080) on UDP 521: Responses go to
  ff02::9 from the link-local address with hop count 255, the answer to a
  Request unicast to the requester; a Response not from port 521, not
  from a link-local address or (to the group) with another hop count is
  ignored; a Request waits until the link-local address is valid. The
  learned next hop is the neighbour's session address. No hold-down, no
  RIPv1.
* **IS-IS** pairs routers over the cable between them (its PDUs are
  frames), by the NET's system ID and area and the level; its routes over
  an unnumbered interface go to the neighbour's own address out of it,
  numbered interfaces in different subnets get no IPv4 next hop. One
  database for both levels, no designated IS: both ends send a CSNP (the
  database summary) every CSNP interval, a PSNP asks for what is missing or
  older, the next CSNP repairs a loss; an adjacency whose neighbour's IIHs
  stop listing it goes back to Initializing (one-way detection).
* **First-hop redundancy.** A router recognizes its group by what the
  protocol carries — the group number (VRID, VHID) of the address family,
  on the interface the advertisement arrived on — never by its VRF's
  name; a member takes its group's relation (the one naming its
  interface, else one naming the device) for its attributes, preempt;
  a different virtual address under the same group is logged (VRRP,
  HSRP, GLBP) or, for CARP, discarded. VRRP (RFC 5798) preempts by its
  master down timer: a Backup accepts an equal or higher priority (an
  equal one does not preempt, whatever the addresses), discards a lower
  one and takes over when the timer (3 × the interval + its skew)
  expires; a Master steps down for a higher priority, or an equal one
  from a higher primary address; IPv6 from the link-local address. HSRP
  (RFC 2281) decides an equal priority by the address, also for its Coup;
  version 2 (Cisco's) where version 1 can't carry the group — above 255,
  or IPv6 (UDP 2029 to ff02::66). CARP preempts at once for a strictly
  higher priority. Not modelled: a priority-0 advertisement on shutdown
  (an interface or device that goes down simply stops advertising),
  learned advertisement intervals, authentication; GLBP is one virtual
  forwarder (no load sharing); HSRP version 2's hop limit in IPv6 (255)
  is assumed.
* **EIGRP**: the init Update is reliable (sent again every 5 s until
  acknowledged — its ACK carries the init's sequence number, an ACK of an
  earlier exchange is ignored —, the neighbour reset after 16 tries; Up only with both
  inits through; a new init from an Up neighbour resets it — the init
  that reset it is not kept, the neighbour learned again from its next
  Hello); a
  lost neighbour is a Query to the others, each answering with a Reply
  (stuck in active after 3 min without one); DUAL's feasibility condition
  is not modelled (another neighbour's route is used at once). Only the
  init Update has its own sequence numbers and retry limit; other reliable
  packets use the shared 5 s retransmission.
* **OSPF.** The DR election follows RFC 2328 (Waiting, BackupSeen,
  priority, non-preemptive) per interface; Hellos whose intervals, area or
  network type differ are discarded (a network-type mismatch never forms
  an adjacency in the simulation, whatever a vendor would do). The database
  exchange negotiates master and slave by router ID and rejects a DBD
  whose MTU is larger than the interface's (stuck in ExStart / Exchange);
  one DBD holds the database (no M-bit paging). A DBD in Exchange,
  Loading or Full is checked as RFC 2328 §10.6 says: a duplicate of the
  last one received is discarded by the master and answered again by the
  slave (in Full for as long as it comes, not only a dead interval);
  anything else that is not the next DBD — the MS bit, the I bit, a DD
  sequence number out of order, any non-duplicate after the exchange — is
  SeqNumberMismatch, back to ExStart. LSUs and LSAcks go unicast to each
  neighbour (RFC 2328 floods to AllSPFRouters / AllDRouters); the unicast
  TTL is not checked against the RFC. Two DROthers reach each
  other through the DR's record. NBMA neighbours are not configured: a
  non-broadcast network behaves as a broadcast one.
* **BGP.** Only the relation's first endpoint connects (no connection
  collision of two simultaneous opens); a second connection of a session
  that is up is closed. Both ends send their OPEN when the TCP connection
  is established (RFC 4271 §8.2.2), the passive one too; a connection is
  the session's when its SYN came from the peer's session, so a test to
  port 179 stays its own. The OPEN's capabilities are its address family.
* **BFD** (RFC 5880, 5881): one transmit stream per session, at least 1 s
  apart while not Up, from an ephemeral port to 3784 with TTL 255; Down
  takes down the clients on its own interface or address pair only (a
  client between loopbacks is served by every single-hop BFD session to
  its peer).
* **Ports between peers.** IKE from and to UDP 500, LDP's Hellos 646, RIP
  520 (RIPng 521), GTP-U, L2TP and WireGuard their port both ways; BFD, VXLAN and
  Geneve from an ephemeral port of each side to theirs; client and server
  services keep the client's ephemeral port.
* **IKEv2.** Messages belong to an IKE SA (its identity stands in for the
  SPIs): a delayed IKE_SA_INIT or IKE_AUTH of the established SA, or an old
  request of it, is dropped (outside the window); a rekeyed IKE SA starts
  its message IDs at 0 and the old one is deleted (the Delete is sent once,
  not retransmitted). Until its Delete exchange the old IKE SA keeps its
  responder state: a rekey request sent again (its response lost) is
  answered from the kept response there, a DPD on its way is answered
  there; a DPD of a side's own still outstanding on it ends with it, the
  next one goes in the new SA; a request waiting behind the IKE rekey goes
  in the new SA with message ID 0. Dead peer detection every interval; either side
  rekeys by its own lifetime — the responder halfway between the
  initiator's rekey time and its lifetime's end (no simultaneous rekeying,
  no nonce comparison). NAT-T is not modelled.
* **A cold start** learns nothing before an adjacency forms: a router's
  first tables hold its connected and static routes only.
* **Equal-cost paths** are all listed (up to 16), without hashing; beyond
  16 the others' outcome is not known (said so). The return path starts at
  the destination's own address. Asked for a device, a path that ends at
  another device with its address (behind another equal-cost next hop)
  does not reach it: the check is partial, and the destination reported
  is the device the paths reach.
* **Tunnels.** A tunnel's underlay is traced when the model's routes lead
  to its destination — every equal-cost alternative of its outer packet a
  branch of the path (each for the path MTU and the capacity); which one a
  flow takes is the simulation's forwarding choice — otherwise its `over:`
  chain is followed as written. A tunnel's own packets (GRE keepalives,
  WireGuard handshakes …) and its data go between its outer ends with the
  protocol's outer header: GRE and mGRE 47, IP-in-IP 4, IPsec ESP 50 (no
  NAT traversal), UDP to the protocol's port for WireGuard, OpenVPN, L2TP,
  GTP-U, VXLAN and Geneve (IPv6 inside IP-in-IP: 41); other tunnels' outer
  header is not stated (GRE assumed). A tunnel's outer packets are routed in
  the VRF of its source interface. A tunnel interface follows its session's
  state. What each encapsulation adds is one definition for the static path
  MTU, the tunnel-MTU check and the simulation's packet lengths
  (*Encapsulation sizes*, below).
* **Routing services describe their configuration.** Each protocol has a
  fixed set of parameters (a protocol of the model may declare its own);
  areas, costs and timers are per relation end; one router ID per protocol.
  A router ID or AS number is never invented. Duplicate router IDs are
  looked for within the devices one protocol's relations join.
* **Static routes.** Routes resolve directly or recursively, never through a
  default route. A device of type access point, IDS/IPS or cloud, or
  without a type, can't have routes; a gateway is a static default route.

**Not supported.** Route maps beyond the policy subset's matches and sets
(FORMAT.md, *Routing policy*), communities, MED, route reflection and iBGP
split horizon, export filters of link-state protocols, OSPF areas and LSA
types, summarisation of learned routes, per-VRF protocol instances,
policy-based routing, MPLS label forwarding (traffic follows the IP path),
and vendor specifics of static routes (tracking objects, BFD for static
routes, resolution through a default route).

## Policy, NAT and boundaries

**Implemented.** One network-policy engine for the path tracer, the
communication checks and the simulation: a router's, Layer 3 switch's or
firewall's ordered Layer 3/4 rules (`policy:`: addresses and objects,
protocol, ports, interfaces and zones, an explicit default action,
stateful or stateless), and, without one, a firewall's implicit policy (its
relations and allow list). Besides it: a Security gateway's domain
separation (filtering bridge, filtering router, protocol break), a VPN
gateway's tunnels and an IDS/IPS's inspection. NAT: the NAT service (PAT, source NAT, port forwarding) and a
load balancer's source NAT in the simulation; container bridges' NAT (SNAT
to the host's address, DNAT for published ports) in both.

**Simplifications.**

* **Static analysis decides one direction.** The path tracer evaluates the
  rules for the service given (without one, a decision that depends on it
  is said, not guessed); a stateful return decision is the simulation's,
  never claimed statically. A firewall without a written policy keeps its
  implicit one: the model's relations through it (each permits its
  protocol's port between its devices, both ways) and its `allow` list (a
  service from anywhere to anywhere), default deny. A written rule base
  decides the packets of relations and tunnels through it too, in the
  simulation as in the path tracer — and IP protocols without ports (GRE,
  ESP, IGMP …): rules with `proto: any` by their addresses, interfaces and
  zones, else the default action; a stateful policy tracks them by their
  address pair and IP protocol number (Linux conntrack's generic
  tracking), so one protocol's session never permits another's (GRE keys
  and ESP SPIs are not tracked); an ICMP error about a session's packet
  (an echo by its identifier) belongs to it. Exempt only what is
  scoped to the link (224.0.0.0/24, ff02::/16, fe80::/10). The path tracer
  applies the rules to a tunnel's outer packet (its source, protocol and,
  over UDP, port); a denial there stops the tunnel.
* **A router's policy filters what it routes**, not what it bridges within
  a VLAN (no VLAN ACLs); it is stateless unless written stateful.
* **A rule's device or interface is its effective addresses.** In the
  simulation and a snapshot: its written addresses that are usable and
  what DHCP, SLAAC or DHCPv6 gave it (an expired lease none); where the
  owner of an address is known, only that device — so an address two VRFs
  both have is not one identity. The owner comes from the forwarding
  context: in the path tracer the traced ends, and among several holders
  of a next hop or a destination the one on the segment the hop reaches;
  in the simulation the packet's sender for its own source, and for a
  destination the device the firewall's routes lead to, segment by
  segment — each next hop continued in the VRF of the interface it was
  reached on, a device on the way the owner only when it has the address
  in the VRF walked (as forwarding decides), every equal-cost next hop
  followed (the packet's own next hop first — its gateway, not only its
  interface): next hops leading to different owners give none. An address several devices have and no owner known (only the
  address given): the rule decides nothing — never every holder. In the
  configured model a device that takes its address at runtime is not
  known: a rule naming it, for an address nobody is known to have,
  decides nothing (analyze a snapshot).
* **Unknown is not permitted.** A decision that lacks the source, the
  service or a runtime identity is undecided: the communication check's
  policy layer is indeterminate and says what it lacks (an expectation
  keeps it), never "Permitted"; the simulation drops a packet whose
  decision can't be made and says why. A rule a known protocol or port
  can't match is no reason for an undecided decision; an earlier undecided
  rule still stops the evaluation (first match).
* **NAT is one translation per flow** — TCP and UDP by their ports, an ICMP
  echo by its identifier; an ICMP error about a translated packet goes back
  to the inside host with its quoted header translated back (PMTUD through
  NAT) — (no port exhaustion, no hairpin NAT);
  the path tracer names a container's published ports without checking the
  port numbers, and does not apply the NAT service (the simulation does).
* **An IDS/IPS's inspection** matches protocols and ports; inline it blocks,
  passively it alerts. Failed open, it passes frames unchecked.
* **A Security gateway is a model of a boundary**, not of a product: a
  protocol break models HTTPS requests, DNS queries and syslog messages
  only; anything else is reported as a limitation.

**Path MTU.** The static path MTU uses the MTUs the model writes (an
interface's, an aggregate's members', the ports of the cables on the way,
both ends of each cable) and the encapsulation sizes below; an MTU not
written is not known, so the result is an upper bound. Which equal-cost
branch a flow takes is not modeled statically: each branch is given (the
simulation records the branch each Send test's packets took). The
simulation fragments IPv4 without DF, drops a larger packet with DF (and
IPv6) with Fragmentation Needed or Packet Too Big, and the sender learns the
path MTU (PMTUD, per VRF and destination, forgotten after 10 min or when the
route leaves by another interface); TCP segments by it and by the MSS its
peer's SYN announced (out of a tunnel: the tunnel's MTU less the headers),
and an IPv6 sender fragments its own UDP and ICMP to it. A tunnel takes what
its MTU allows — written, else what its underlay's egress leaves room for,
lower once its head learned a smaller path MTU towards the tunnel's
destination: a larger IPv4 packet without DF is fragmented before
encapsulation, one with DF (or IPv6) is refused with Fragmentation Needed or
Packet Too Big carrying what fits (RFC 4459). A frame larger than a port of
its cable takes (its MTU written: the receiving end, or a switch port it
leaves by) is dropped there as oversize, without an ICMP error — the black
hole of an MTU mismatch, which the link-MTU check reports. An outer packet's
fragments are reassembled before it is decapsulated. TCP options other than
the MSS, MSS clamping on tunnel heads, jumbo-frame negotiation and PLPMTUD
are not modelled.

**Encapsulation sizes** (src/analysis/encap.ts, one definition): the outer
IP header of the tunnel's family (20 or 40 bytes; the family written on the
tunnel's ends, IPv4 assumed and said when not written), a UDP tunnel's UDP
header (8), and the tunnel's own format: GRE and mGRE 4 (no key, checksum or
sequence number), IP-in-IP 0, IPsec ESP tunnel mode with AES-CBC and
HMAC-SHA1-96 (8 SPI and sequence number, 16 IV, the inner packet and its 2
trailer bytes padded to 16, 12 ICV: exact for this suite, a few bytes off for
another, such as AES-GCM), WireGuard 16 + a 16-byte tag (its padding to 16
bytes, which never exceeds the interface MTU, is not counted: a packet of the
tunnel's MTU is exact, a smaller one up to 15 bytes short), OpenVPN over UDP
24 (tun mode, P_DATA_V2, an AEAD cipher), L2TPv3 over UDP 12 (no cookie, the
inner counted as an IP packet), GTP-U 8, VXLAN and Geneve 8 + the inner
Ethernet header 14 (untagged; Geneve without options). A tunnel whose
protocol has none of these is taken as GRE, by the simulation and by the
static path MTU alike, which then calls its limit an estimate
(indeterminate).

**Not supported.** Application identification, TLS inspection, user
identities, time ranges, NAT rules in a policy (the NAT service translates),
VLAN ACLs, vendor rule syntax, NAT ALGs and port-block allocation; the
contents of what a Security gateway transfers.

## Multicast

**Implemented.** IGMP and MLD (reports, leaves, queries, the querier
election), IGMP / MLD snooping per VLAN, PIM (sparse, SSM, dense) with the
RPF check, and the multicast forwarding these build; streams and joins as
Network events, attributed to their event.

**Simplifications.**

* **Snooping.** One choice per VLAN covers IGMP and MLD. Forwarding is by
  group: an IGMPv3 / MLDv2 member's sources are shown, not filtered at the
  switch. A switch's snooping querier sends IGMP (IPv4) queries only, from
  its VLAN interface's IPv4 address; IPv6 members are learned from their
  reports and from multicast routers' queries. Access points and virtual
  switches don't snoop (an access point floods to the clients of that Wi-Fi
  network). Unregistered multicast is a per-VLAN policy (`router-ports`,
  `flood`). Port roles come from queries and PIM Hellos. Fast leave removes
  a port at once, also when another member is behind it.
* **The querier election** follows IGMPv2 / v3 and MLDv1 / v2 (the lowest
  address wins, startup queries, the other querier present interval); a
  switch's snooping querier takes part by its VLAN interface's address. A
  leave report is sent once; a lost leave is covered by the membership
  interval.
* **PIM.** Each router uses its own RP: its static `rp`, else its PIM
  relations' `rp`, else the candidate RP with the highest router ID among
  those whose Bootstraps reached it (each candidate floods its own every
  Bootstrap period; known for 2.5 periods, then dropped — no separate BSR,
  no C-RP advertisements, no priorities, no group ranges); routers that
  disagree keep their own (said, and their trees do not meet); the DR is
  elected by the priorities the neighbours' Hellos announce; an RPT prune
  acts at the next router up only, and the RP prunes the source's (S,G)
  towards it once nothing else wants it (RFC 7761 §4.5.7); the shared
  tree's (S,G,rpt) prune is not refreshed in the periodic Join/Prune and
  does not expire; register suppression lasts while the source sends.
* **IGMPv3 / MLDv2.** A join is a state-change record (TO_EX, ALLOW), an
  answer to a query the current state (IS_EX, IS_IN); routers keep a
  timer per source in INCLUDE mode — a new source on a known group gets
  its (S,G), a blocked one leaves when its timer runs out; a BLOCK of
  sources the router does not have changes nothing. A member of every
  source (EXCLUDE {}, or an IGMPv2 / MLDv1 report) beside members of named
  sources: every source is forwarded while that group timer runs; when it
  runs out only the named sources stay (RFC 3376 §6.5) — a member leaving
  or a named source's timer running out does not end the group while
  another member still wants it. A BLOCK is
  followed up with group-specific queries (no group-and-source query);
  snooping keeps one source list per port. An IPv6 stream goes from the
  interface's global address (MLD from its link-local one).
* **IGMP and MLD messages** carry the Router Alert option and TTL 1, their
  lengths by version; MLD goes from the link-local address once it is valid
  (a host's Report before it: from ::), and a router elects the MLD querier
  by link-local address.
* **Network events.** A join's outcome is what a multicast router of its
  segment records (receipt by snooping switches is not part of it); a
  Leave multicast group follows the entries learned on the host's way when
  it is sent. Multicast tests are UDP only.

**Not supported.** IGMPv1, IGMP proxying, statically configured router
ports, vendor variants of unregistered flooding, MSDP and inter-domain
multicast, PIM Assert, Bidir-PIM, embedded or anycast RP, Auto-RP and BSR
candidate election.

## Timing

**Implemented.** PTP (IEEE 1588-2008, its Default delay request-response
profile over UDP/IPv4, two-step: the best master clock algorithm, port
states, boundary clocks, end-to-end transparent clocks) and NTP (requests at
the poll interval, synchronization state and stratum) in the simulation. The
static timing check finds a compatible source path.

**Simplifications.** PTP clock states follow the modelled timestamps (a
model of the servo, not of real oscillators); a foreign master is
forgotten one announce receipt timeout after its last Announce; a
transparent clock has no timing state of its own. NTP computes no time: its
state is modelled, its offsets, jitter and clock filter are not; a client
knows its upstreams only by their responses (the stratum each reported,
fresh by the reach register), never by their state. An upstream is an
address (an association): the client asks exactly that address — a
loopback's too, when it has a route —, a response counts for the
upstream it comes from, and two addresses of one server are two
upstreams; an address several devices have is the one the client's
traffic reaches (in the simulation and the static chain alike). An ntp
relation of the model between the two runs instead of the configured
upstream, between the addresses it picks; its responses count only when
they come from a configured upstream's address. Which of several devices
with an upstream's address the client reaches is resolved once, by the
configured routing, when the sessions are built (the simulation's own
tables start empty of learned routes all the same); one it can't tell is
not asked, said, and not reconsidered later. A source is lost exactly 8
polls after its last answer; a device with a stratum of its own is a
reference, whatever upstreams are written beside it. A static
timing check works by the method asked for (PTP, NTP, or either, both then
reported): a PTP source path, or an NTP source chain from upstream to
upstream to a configured reference (a reference's own clock is taken as
given; a chain is followed for at most 15 hops) that is feasible — the
reference's stratum plus the hops down to the client at most 15 (RFC 5905;
the simulation uses the same ceiling), the best feasible alternative taken.
It establishes a source path or chain, never synchronization or accuracy;
a snapshot adds the synchronization the simulation observed.

**Not supported.** One-step clocks, peer delay, gPTP / IEEE 802.1AS,
telecom or power profiles, IPv6 or Layer 2 PTP transport, management
messages, TSN, holdover quality; NTP and PTP never discipline each other.

## Applications and services

**Implemented.** Application profiles send TCP or UDP requests and answers,
one-way datagrams or MQTT 3.1.1 (QoS 0 and 1) between the model's devices;
services (DNS, NTP, syslog, RADIUS / TACACS+, SNMP, CAPWAP, storage, proxies,
load balancers) as their request / answer exchanges.

**Simplifications.** An application's name (*Modbus TCP*, *OPC UA*) only
labels it; payloads are sizes, never contents. TCP has no congestion
control, windows or delayed acknowledgements (a request and an answer, each
acknowledged; a connection's byte stream has real sequence and
acknowledgement numbers, the MSS each SYN announces, every segment of a
write goes at once, and a lost one waits for the retransmission timer —
RFC 6298's, from the measured round trip (SRTT, RTTVAR, Karn's rule; at
least 1 s or the configured initial RTO if lower; 3 s after a SYN timed
out) — no fast retransmit, no SACK, no timestamps; a test's connection
ends with its test (an ICMP error about its SYN; an abort, [R,A], at its
response timeout); unacceptable segments are refused as RFC 9293
says; a FIN closes one direction, CLOSE_WAIT until the application
closes — the test's request/answer and BGP and MQTT close at once; no
urgent data, no ECN, no simultaneous open, no window scaling);
a load balancer's health check is a TCP connect check (the handshake
completed, then a RST);
tests use fixed sizes (a 120-byte request, a 1460-byte
answer). Load balancers and proxies relay TCP only (UDP to them is answered
by themselves); a reverse proxy and a load balancer relay one connection
each way; a forward proxy without a parent is reported as a limitation.
Service traffic of relations (DNS, NTP, syslog …) is sent at a fixed
demonstration interval. An application that starts with the simulation
starts 3 s after the start or, when its device is not operational then
(booting, off, waiting for its host), 3 s after the device's latest boot
(said, shown as Waiting); it starts once — a run going on is not doubled,
also not by a reboot; a configuration problem is refused, said and not
tried again. An experiment's `start_app` waits for the device to boot,
not for its links: a message sent before the link-up delay has passed
finds no route, as on a device. The runs' history keeps the last 200
finished runs; a run still going on always stays. Each original message
has one outcome, from its last attempt (sent or not); retries are counted
apart. Stop is accepted while the last message is on its way: nothing
more is sent and no retry follows; what is already on its way finishes.
MQTT: a periodic publisher's schedule belongs to its run — it goes on
across reconnections; a round that falls while it is not connected is not
published (nor counted toward a count). Packet identifiers are 1–65535
per side, wrap and skip those awaiting acknowledgment (all in use:
nothing is sent, said). Topics, filters and client identifiers are sized
in UTF-8 bytes (client identifiers are ASCII by validation). A TCP
connection whose SYN cannot leave is closed at once and not retransmitted.
A Cloud is one opaque Layer 3 hop with its latency and loss.

**Not supported.** Industrial or building protocol engines (Modbus, OPC UA,
BACnet), MQTT QoS 2, persistent sessions, retained messages, wills,
authentication and TLS; EAP, MIBs, CAPWAP join or image download; a public
cloud's hosts behind its instances.

## Simulation time and display

**Implemented.** A simulated clock with scheduled events; three pacings
(Readable, Proportional, Real time) that change what is shown and how long
it takes, never what happens; in Readable and Proportional pacing a
delivery drawn as a dot waits until its dot has arrived on screen (Real
time waits for nothing); Network events (sends, streams, joins, interface
and device actions) from the user.

**Simplifications.**

* **Scenario time.** Everything runs on scenario time, in every pacing:
  a send's intervals, streams and repeating applications of Network events
  as much as the model's own traffic; the same history gives the same
  datagrams at the same simulated times however it was played. Real time
  pacing shows a simulated second in a real one and, on a heavy model, may
  fall behind (*· behind*).
* **Determinism.** Jitter of starts and timers comes from a fixed seed, under
  a hop's time — each device's and each cable's own stream, from the
  model's title and its id, so adding a device changes nobody else's; a
  generated MAC comes from the title and the interface alone (a written MAC
  is always kept, a duplicate too); packet loss is a share of frames from a
  fixed seed; there is
  no queuing beyond each cable's serialization and no CPU limit. A broadcast
  storm follows each frame for 6 rounds.
* **Waiting for the dots is strictly chronological.** While a delivery
  waits for its dot, nothing later in simulated time happens — not even an
  unrelated device's timer — so messages a few milliseconds apart are shown
  one after the other, each a hop's display time. Only what was already on
  its way moves meanwhile. A busy startup is therefore shown one message
  of each kind (the steady state below); the examples' startups take one to
  four minutes of Readable display before the simulation runs at its rate.
* **The steady state is summarized.** A kind of the scenario's message (its
  protocol, its message type and a TCP segment's flags) drawn once is cable
  activity the next times, and nothing waits for it, until the next change
  from outside makes the scenario news again — a Network event, a failure
  or restore, a power change, a shut or no shut, flapping you started and
  its transitions, a join or a stream (not the model's own flapping, not a
  packet): a second host's DHCP Discover, the next Hello, the next periodic
  test are lit cables, not dots. The model's illustrative non-IP data
  (an interconnect's `traffic:`) is drawn every time and never waited for.
* **Only a dot the diagram draws holds.** A delivery waits for its dot only
  while the dot's track is in the scene: filtered out (devices, types),
  inside a collapsed group, switched off by IP / Non-IP, or without
  geometry, it holds nothing; a track outside the pan and zoom still holds.
  When it comes back, what was delivered meanwhile is not drawn as on its
  way. A very large moment (thousands of events at one simulated time)
  may take several frames, in its order; at the playback's end (an
  experiment's) the rest of such a moment is still processed, never
  beyond it. An action of yours while a moment is partly done takes
  effect then: after its events already done, before those still queued
  (they see it). Your own
  Network events, their prerequisites (the ARP a send needs) and the
  conversation followed are always dots. A multicast stream is a flow on
  every cable of its tree; one datagram after each Network event is shown
  hop by hop. Real time pacing is an overview and waits for nothing.
* **Foreground and background are a display choice.** Senders choose what is
  shown, not what runs: every device's protocols are computed. A dot not
  waited for (the scenario's muted background while Network events run, a
  stream's flow, Real time) may still run behind the tables, up to 15 s,
  beyond which the exchange shows as cable activity — but what goes on with what
  is drawn (the next cable of a message on screen, the next message of a
  conversation on screen: a TCP handshake's SYN-ACK and ACK) up to 60 s,
  beyond the dot limit; at most 48 messages start being drawn at once and
  the event log keeps the last 20 000 events. Following a message keeps
  its conversation drawn: a TCP or UDP conversation is its two ends with
  their ports (an ICMP echo its identifier), as its sender sent it — a
  conversation through NAT is two, one each side of the translation. Cable
  activity shows the last 3 s of display. A browser tab in the background
  stops the display clock. Switching the view, the protocols or senders
  shown, or the pacing removes the dots of what was delivered meanwhile
  (history), rather than letting them travel behind the tables.
* **Order on screen** follows the deliveries the engine records; a reply
  sent after a delay of its own (a service's response time, an ARP
  retransmission) is ordered by its conversation and counts as the
  replier's.
* **Devices and interfaces.** A device is powered on, off or booting (its
  boot is one wait); Power off then Power on is a reboot. A failed-open
  IDS/IPS passes frames unchecked. Shut interface ends its flapping first; a
  shut interface can't start flapping; one flapping per cable; flapping
  uses the Layer 1 parameters for every flap. Changing a dead or hold
  interval during a simulation applies from the next message heard. A
  change of a switch's VLANs or snooping needs the simulation started again
  (the model is locked meanwhile).
* **Send test.** A series plays at the animation's pace; the source port is
  always an ephemeral one; a directed broadcast must name a subnet of the
  model; Stop ends a series but not the messages on their way. At most 50
  finished events are kept.

* **An execution scope runs a part of the model.** The devices outside are
  not run (never frozen as participants, never answering); traffic towards
  them is logged where it leaves the scope. A scope adds the routing domain
  its routes come from, the switches between, its DHCP and DNS servers and
  gateway-group members; a protocol whose peers are all outside it does not
  form. An experiment runs the entire model unless its `scope` names a
  narrower one (below). A scope inside one large
  routing domain still runs every router of that domain (its routes come
  from them), so where route convergence dominates, a smaller scope gains
  little: the routes are computed again for each routing message's
  estimate, which grows with the domain.
* **Saved experiments run on scenario time.** A run starts from the
  experiment's defined start (freshly booted, settled, or a cold start) and
  is repeatable; at one time, actions apply in the order written. A step
  after an earlier action counts from its submission, not its effect; an
  action waits only for its own device to come up, never for the whole
  network. A stream of Network events is no experiment action.
  Observations read states and deliveries over their window: no
  convergence time, throughput or accuracy is measured. A state's moment is
  the evidence's own time where it has one (a boot's end, a lease's
  binding, a first datagram), else when it was read (every 0.1 s of
  scenario time; a communication and the saved expectations every second).
  Not observed: membership learned by a snooping switch (a router's
  membership is), and a state held for a period (a window says only whether
  it was reached).
* **A cold start boots what has a lifecycle.** Devices with a power
  lifecycle start off and boot by their boot time; a VM starts with its
  host, a container by its restart policy (one that does not restart stays
  off). Cables, patch panels, TAPs and external networks have none: they are
  never powered. Boot times are the simulation parameters' (a device's
  boot-time), not a vendor's.
* **An experiment shows only its own traffic.** While it plays, the diagram
  shows its actions' messages and what they cause (forwarding, answers,
  address resolution) and its devices' own prerequisite traffic (DHCP, DNS,
  ARP, router discovery and duplicate address detection, a receiver's LAN's
  IGMP / MLD queries, the sessions or clocks an observation reads). This is
  attribution by cause and by device role, not proof: traffic of the
  experiment's devices that it did not name (a host's other applications)
  is hidden, and a shared resource's other users — load on a link — are
  hidden too, though they run and may change a result. The rest runs and
  never holds the run or its display back; the result is the same shown or
  not.
* **A narrower execution scope leaves activity out.** The **Targets and
  their dependencies** scope (and a group, VLAN, domain or dependency
  slice) runs fewer devices: what runs outside it — load on a shared link,
  other hosts, a protocol domain it does not reach — is not modeled. A run
  says how many devices of the model it ran; it does not claim the entire
  model's result.
* **Analyze over a simulation reads a snapshot.** Entering Analyze pauses
  a running simulation; its analyses read a frozen snapshot, never the live
  state, and the simulation resumes when Analyze is left.

**Not supported.** Real timing jitter, vendor-specific behaviour beyond the
parameters, CPU limits, full TCP-stack fidelity.

## Failure analysis, dependencies and expectations

**Implemented.** Single points of failure with structural and service
impact; what-if conditions (failure domains, or up to 64 components)
compared with the same baseline; configured service dependencies; saved
expectations (availability, isolation, dependencies, timing) evaluated
statically; contextual focus.

**Simplifications.**

* **Failures follow what the model writes.** A relation goes down when
  anything it runs `over` goes down (`over` is a chain: a relation is only as
  redundant as its `over:` list says); a LACP or MLAG relation's cables count
  side by side; a relation without `over` is affected only through its
  endpoints. A VLAN interface goes down when every port carrying its VLAN
  does. The single points of failure fail each cable, device and LAG alone;
  combinations are what-if conditions you choose, never enumerated. The
  structural impact is an object count, not a business criticality.
* **Capacity is stated traffic against stated speeds.** An application's
  transfer is traced between its own ends — its family, the peer
  listener's bind interface's address (else its device's address of the
  family), the client's address it sends from (its egress interface
  towards the peer), as the simulation's applications pick them; a bound listener
  whose interface is down is not carried, never rerouted to another
  address. Demands and
  applications with an interval (payload rates: one MQTT publication per
  topic, each subscriber a matching publication once; a client's answers
  at its responder's response size, assumed and said when the responder is
  not known; a written 0 is 0) against cables and aggregates per direction
  when full duplex (their surviving members; a single flow at most one
  member that is up), half-duplex cables and shared radios as one medium,
  before and after a failure. The spread over equal-cost paths or
  bundle members is not assumed (an equal split and all on one path are
  both evaluated). Not modeled: queues, delay, microbursts, QoS, hardware
  forwarding performance, the throughput a protocol achieves.
* **Device pairs** are checked by tracing between devices (each to the
  other's first address that is up), in a chosen scope and at most 1600
  ordered pairs, relevant endpoints first; the coverage says what was left
  out.
* **Dependencies are what the model configures** (an application's peer, an
  MQTT client's broker, resolvers, DHCP servers, a timing source, syslog
  senders, AAA clients). A DHCP server's loss stops new assignments; leases
  already given are taken to last.
* **Expectations.** An end the failure takes down is known to be
  unavailable: an availability requirement is violated, an isolation
  requirement indeterminate (no traffic originates, so no control is
  exercised). A block that holds because no route exists is said to be one.
* **Contextual focus shows configured structure** (VLAN members, configured
  dependencies, a multicast group's configured senders and receivers, a
  timing domain's clocks); being shown together proves no path.

**Not supported.** Probabilities, convergence and recovery times, business
importance, dependencies nobody wrote down, requirements about sessions or
timing accuracy.

## Non-IP interconnects

**Implemented.** Opaque ports, point-to-point and shared interconnects
with a technology, an application protocol and a connector as text, peer
and controller / target access with per-attachment roles and data
directions, explicit transit through Systems, their drawing in the
physical view (IP / Non-IP switches), the editor, Find, and illustrative
data with failures of an interconnect, an attachment or a port, sent as a
Network event or written as an interconnect's `traffic:` (the scenario's,
with the simulation).

**Simplifications.**

* **Illustrative only.** Data moves where the model says it can, one
  direction, no reply. No technology or protocol is simulated:
  enumeration, addressing, arbitration, collisions, framing, timing,
  bandwidth, acknowledgment, error handling and termination are not. Two
  controllers of a bus send at the same moment without contention. A hop
  takes 1 ms of simulated time; the size is a label. A failure while data
  is on its way stops it there (a restore does not bring it back); a
  series keeps its last 50 transfers in detail and counts all of them.
* **Editing.** Interconnects, their endpoints and a System's transit
  groups have their controls in the Edit tab; an interconnect's `traffic:`
  is written in YAML, and its references (initiator, source, recipients)
  follow a renamed device or port and are reported when one is deleted.
* **Text, not semantics.** Technology, version, protocol and connector are
  free text: nothing checks that a USB version matches on both ends, that
  a connector fits, or that an RS-232 line is short enough.
* **No conversion.** A transit group passes data between ports of one
  technology only; a converter or gateway (USB to serial, CAN to
  Ethernet) is not modelled as such.
* **No coupling with the IP side.** An opaque port's device being powered
  off stops its data; nothing else of the IP simulation affects or is
  affected by an interconnect. Its failure is a failure of the connection
  only: no electrical fault (a shorted bus taking everything down) is
  inferred.
* **Not in Analyze.** Paths, what-if, failure domains, expectations and
  experiments cover the IP side only.

## Model and editing

**Implemented.** One YAML model with validation, an editor that writes it
back (comments and key order kept), undo and redo, consistency checks, input
helpers and the command palette.

**Simplifications.**

* **YAML subset, not full YAML.** Anchors, aliases and multi-line plain
  scalars must be rewritten (the error says so and points to the line).
  Formatting is normalized on export: indentation, flow spacing, `>` blocks
  and runs of blank lines change; a comment attached to something deleted
  moves to the next item or goes with it. Comments are edited in the YAML
  tab.
* **Consistency checks compare what the model writes down.** They don't read
  device configurations: they find contradictions in the model, not in the
  network. The tunnel-MTU check uses the encapsulation sizes of
  *Policy, NAT and boundaries* (the outer header of the tunnel's family; ESP
  with its padding for the MTU it checks) and skips protocols without a
  format. The underlay check asks whether `over:`
  connects the endpoints as a graph. OSPF and BGP parameters are read from
  relation attributes with fixed names (`area`, `network-type`, `hello`,
  `dead`, `peer-as`); one value for both ends is taken as agreement. A
  multi-chassis aggregate is accepted when an `mlag`/`vpc` relation includes
  its peers. A VRF mismatch is reported only where both interfaces name a
  VRF.
* **Relations name only their underlay.** A network a relation carries (a
  VNI, the customer networks of an L3VPN) and endpoint roles go into the
  relation's `attrs`.
* **Associations of logical interfaces** are member ports, a VLAN (with its
  derived bridge ports), a subinterface's port (`<port>.<n>`) and a tunnel's
  source and destination; a VLAN interface's bridge ports are its own
  device's.
* **Input helpers only suggest**, from the model as it is (a VRRP group
  number is free on the segment as the model describes it; a generated MAC
  is unique in the model only).
* **Connecting in the diagram** creates two-endpoint links and relations;
  more endpoints, an underlay or attributes are added in the Edit tab.
* **Device types are a fixed list** of 15 ([FORMAT.md](FORMAT.md)); a kind and
  a role say more.
* **Alphabetical means natural order** (`eth2` before `eth10`), not
  locale-aware.

**Not supported.** Other import or export formats (only YAML in; YAML, PNG
and SVG out), printing layouts, multi-user editing.

## Diagram, layout and export

**Simplifications.**

* **Auto-arrange is heuristic.** It reduces crossings and overlaps without
  minimizing them (two spines to four leaves cross six times; dense meshes
  cross). Cables are routed around boxes with a few bends (orthogonally in
  the Structured arrangement), not around group boxes, titles or other
  cables; relation lines in the logical view are straight and may cross
  another group's frame. Group placement follows the cabling layer by
  layer. Network membership lines end at the device box. Positions are
  deterministic within one version (verified in V8; Firefox and Safari run
  the same check with `#selftest`); stored positions never change by an
  upgrade, and the view says *edited since arranged* until you arrange
  again. Once positions are stored, new objects are placed next to their
  neighbours.
* **Performance** (Node, a generated model with 1000 devices in 20 sites):
  Auto-arrange 73 ms (physical) and 170 ms (logical); an edit with
  validation 35–65 ms; browser rendering comes on top. The logical layout
  grows with the square of the largest connected component (stress layout
  up to 300 nodes, a force layout above). Above 400 devices the exchange
  passes of Auto-arrange are skipped.
* **Labels** keep clear of nodes, group titles and each other, not of lines
  (a halo keeps them readable); a label without a free place takes the
  nearest one with a dashed leader, or overlaps least (reported). Text
  width is estimated (no font metrics), so boxes have a little spare room.
  The estimate fits Segoe UI, Roboto and Arial-like fonts. Where the
  system's UI font is wider, such as DejaVu Sans on many Linux desktops, a
  long label can reach a few pixels past its box (seen in CI on Ubuntu,
  whose browser jobs therefore use Liberation Sans:
  `.github/fontconfig/fonts.conf`).
* **Badges.** Snooping badges and status pills are placed where nothing is
  drawn, not reserved by Auto-arrange; on a crowded box they take its top
  right corner. A device with many uncabled ports gets a tall strip of
  chips; every address is written out.
* **Filtered views are not saved**; only the complete diagrams' positions
  are stored in the file.
* **Exports.** The SVG legend is a single column (a model with many
  protocols gives a tall legend); the Networks box makes pictures wider.
  The PNG is drawn at twice the diagram's size, less for very large ones; a
  diagram too large for the browser to draw can't be exported as PNG (the
  SVG export has no such limit).
* **Focus mode counts hops between devices** (a cable in the physical view,
  a relation in the logical view) on the complete model, then narrowed by
  the other filters.
* **Small windows.** The page never scrolls; each panel scrolls on its own.
  Below 1100 px the panels get narrower, below 860 px they move under the
  diagram; the simulation layout's side panels have fixed widths and become
  tabs below 860 px. At 300 % zoom on a 1080p screen only the toolbar and
  the simulation panel's controls fit.
* **Themes:** Dark and Light; the operating system's setting is not
  followed. A modal dialog blocks the page behind it.
* **Keyboard access:** forms and panels are keyboard-operable; diagram
  elements aren't individually focusable. The command palette's `Ctrl+K` /
  `Cmd+K` is taken from the browser while NetAtlas has the focus.

## Browsers and files

* **Saving to a file depends on the browser.** Chromium-based browsers let
  *Save model as…* write to a chosen file and *Save model* update it (with
  a permission prompt once per session). Firefox and Safari download a
  copy, not linked to the model; a file opened through their picker, or
  dropped onto the page, is never linked. The `beforeunload` prompt is the
  browser's generic one.
* The automated browser test needs a Chromium-based browser; Firefox and
  Safari are covered by the manual `#selftest` procedure.

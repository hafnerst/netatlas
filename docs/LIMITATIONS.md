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
  SLAAC and DHCPv6 addresses with their state, what was up, the routes
  learned); it is not updated as the simulation goes on.
* Analyses that would blend two states refuse: a hypothetical failure is
  applied to the configured model only, never to a snapshot.

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
* **DHCP and DNS.** One lease per interface. DNS has no negative caching,
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
their timers (see SUPPORT.md for each); the routes come from the
adjacencies that are up.

**Simplifications.**

* **Routes follow the adjacencies and a bounded policy, not the protocols'
  algorithms.** Every router of an adjacency originates its connected
  networks (or, with a policy, what it advertises, a default route and
  what it redistributes) and passes on what it learns through the ordered
  import and export filters; the lowest cost wins (a hop unless a `cost`
  is written), for BGP first the highest local preference and the
  shortest AS path. The simulation installs the same routes over the
  adjacencies that are up. An adjacency forms only where the two have a
  network in common (a BGP session may also run between loopbacks). An LSU
  or UPDATE stands for what changed.
* **Equal-cost paths** are all listed (up to 16), without hashing; beyond
  16 the others' outcome is not known (said so). The return path starts at
  the destination's own address.
* **Tunnels.** A tunnel's underlay is traced when the model's routes lead
  to its destination; otherwise its `over:` chain is followed as written.
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
  service from anywhere to anywhere), default deny.
* **A router's policy filters what it routes**, not what it bridges within
  a VLAN (no VLAN ACLs); it is stateless unless written stateful.
* **NAT is one translation per flow** (no port exhaustion, no hairpin NAT);
  the path tracer names a container's published ports without checking the
  port numbers, and does not apply the NAT service (the simulation does).
* **An IDS/IPS's inspection** matches protocols and ports; inline it blocks,
  passively it alerts. Failed open, it passes frames unchecked.
* **A Security gateway is a model of a boundary**, not of a product: a
  protocol break models HTTPS requests, DNS queries and syslog messages
  only; anything else is reported as a limitation.

**Path MTU.** The static path MTU uses the MTUs the model writes (an
interface's, an aggregate's members', the ports of the cables on the way)
and the tunnel-MTU check's overheads (an IPv4 outer header; IPsec as the
worst case of ESP tunnel mode); an MTU not written is not known, so the
result is an upper bound, and an encapsulation without a figure leaves its
path's limit unknown. Which equal-cost branch a flow takes is not modeled:
each branch is given. The simulation fragments IPv4 without DF, drops a
larger packet with DF (and IPv6) with Fragmentation Needed or Packet Too
Big, and the sender learns the path MTU (PMTUD); TCP segments by it. TCP
options, jumbo-frame negotiation and PLPMTUD are not modelled.

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
* **PIM.** The bootstrap router announces the RP, but RP election is the
  highest candidate's router ID; an RPT prune acts at the next router up
  only; register suppression lasts while the source sends; IGMPv3 / MLDv2
  source lists are kept per group.
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
model of the servo, not of real oscillators). NTP computes no time: its
state is modelled, its offsets, jitter and clock filter are not. A static
timing check works by the method asked for (PTP, NTP, or either, both then
reported): a PTP source path, or an NTP source chain from upstream to
upstream to a configured reference (a reference's own clock is taken as
given; a chain is followed for at most 15 hops). It establishes a source
path or chain, never synchronization or accuracy; a snapshot adds the
synchronization the simulation observed.

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
acknowledged); tests use fixed sizes (a 120-byte request, a 1460-byte
answer). Load balancers and proxies relay TCP only (UDP to them is answered
by themselves); a reverse proxy and a load balancer relay one connection
each way; a forward proxy without a parent is reported as a limitation.
Service traffic of relations (DNS, NTP, syslog …) is sent at a fixed
demonstration interval. A Cloud is one opaque Layer 3 hop with its latency
and loss.

**Not supported.** Industrial or building protocol engines (Modbus, OPC UA,
BACnet), MQTT QoS 2, persistent sessions, retained messages, wills,
authentication and TLS; EAP, MIBs, CAPWAP join or image download; a public
cloud's hosts behind its instances.

## Simulation time and display

**Implemented.** A simulated clock with scheduled events; three pacings
(Readable, Fast, Real time) that change what is shown, never what happens;
Network events (sends, streams, joins, interface and device actions) from
the user.

**Simplifications.**

* **Scenario time and real time.** The simulation runs on scenario time.
  A send's intervals are scenario time in every pacing (in Readable pacing
  its next message comes as soon as the last one was seen). A stream of
  Network events runs on real time: it sends in the first animation frame
  at or after each moment of its schedule (each deadline computed from the
  stream's start, so it never drifts); a frame later than a whole interval
  sends one datagram and counts the others as skipped; while a stream runs
  the simulated clock follows real time and, on a heavy model, may fall
  behind (*· behind*). Two runs with streams differ in their simulated
  times; the model's own traffic is the same every run.
* **Determinism.** Jitter of starts and timers comes from a fixed seed, under
  a hop's time; packet loss is a share of frames from a fixed seed; there is
  no queuing beyond each cable's serialization and no CPU limit. A broadcast
  storm follows each frame for 6 rounds.
* **Foreground and background are a display choice.** Senders choose what is
  shown, not what runs: every device's protocols are computed. In Readable
  pacing the dots of a long chain run behind the tables, up to 15 s, beyond
  which the exchange shows as cable activity; at most 48 messages are drawn
  at once and the event log keeps the last 20 000 events. Following a
  message keeps its conversation drawn. Cable activity shows the last 3 s
  of display. A browser tab in the background stops the display clock.
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
  form. Experiments always run the entire model. A scope inside one large
  routing domain still runs every router of that domain (its routes come
  from them), so where route convergence dominates, a smaller scope gains
  little: the routes are computed again for each routing message's
  estimate, which grows with the domain.
* **Saved experiments run on scenario time.** A run starts from the
  experiment's defined start (freshly booted, settled, or a cold start) and
  is repeatable; at one time, actions apply in the order written. A step
  after an earlier action counts from its submission, not its effect; an
  action waits only for its own device to come up, never for the whole
  network. A stream of Network events (real time) is no experiment action.
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
* **Capacity is stated traffic against stated speeds.** Demands and
  applications with an interval (payload rates) against cables, aggregates
  (their surviving members; a single flow at most one member) and shared
  radios, before and after a failure. The spread over equal-cost paths or
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
  network. The tunnel-MTU check assumes a fixed overhead per encapsulation
  with an IPv4 outer header (IPsec: the worst case of ESP tunnel mode) and
  skips protocols without a figure. The underlay check asks whether `over:`
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

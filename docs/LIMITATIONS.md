# Limitations

What NetAtlas does not do, area by area. The README has a short overview;
each protocol and service also says in the application what it models and
what it leaves out (its ⓘ note in the editor and in **Start simulation…**).


* **Applications are traffic, not protocols.** An application profile
  sends TCP or UDP requests and answers, one-way datagrams or MQTT; its
  name (*Modbus TCP*, *OPC UA*) only labels it: no industrial or building
  protocol engine (Modbus, OPC UA, BACnet) is simulated. Payloads are
  sizes, never contents.
* **MQTT is 3.1.1 with clean sessions.** QoS 0 and 1; no QoS 2, persistent
  sessions, retained messages, wills, authentication or TLS; one broker per
  client (no bridging).
* **IPv6 host configuration stops at the link.** Router advertisements,
  SLAAC with duplicate address detection, DHCPv6 (stateful and stateless)
  on the server's own link; no DHCPv6 relay, prefix delegation, privacy
  addresses (RFC 8981) or SEND.
* **PTP is one profile.** IEEE 1588-2008's Default delay request-response
  profile over UDP/IPv4, two-step; no one-step clocks, peer delay, gPTP /
  IEEE 802.1AS, telecom or power profiles, IPv6 or Layer 2 transport,
  management messages, or TSN. The clock states follow the modelled
  timestamps (a model of the servo, not of real oscillators); holdover
  quality and accuracy against a reference are not modelled.
* **NTP computes no time.** Its state (synchronized, stratum, reach) is
  modelled; offsets, jitter and the clock filter are not, and NTP and PTP
  never discipline each other.
* **Snooping badges are placed, not reserved.** Auto-arrange reserves no
  room for the simulation's per-VLAN snooping badges: nearly every switch
  of the examples has snooping configured, and reserving their room made
  every such diagram wider, with longer cabling and more crossings, for a
  picture shown only while simulating. A block is placed beside its box
  where nothing is drawn, clear of group frames where possible (where a
  frame is in the way, as at the private house's core, the opaque badges
  cross its line); it keeps its place while roles change, and devices
  never move. In the logical view the same applies. Very many
  snooping VLANs (beyond about 20) make a tall block that may have to sit
  below or above the box.
* **Unregistered multicast** is a per-VLAN policy (`router-ports`,
  `flood`); vendor variants (flooding only while no querier is present,
  per-port blocking) are not modelled. Port roles come from queries and
  PIM Hellos; statically configured router ports are not supported.

* **YAML subset, not full YAML.** Files that use anchors or aliases, or
  multi-line plain scalars, must be rewritten before they can be opened.
  The error message says so and points to the line.
* **Formatting is normalized on export.** Indentation, flow spacing,
  `>` blocks and runs of blank lines change (see above); comments and key
  order are kept. A comment attached to something you delete is moved to the
  next item or dropped with it. Comments can only be added or edited in the
  YAML tab.
* **Saving to a file depends on the browser.** Chrome, Edge and other
  Chromium-based browsers let *Save model as…* write to a file you choose,
  and *Save model* then updates it (the browser may ask for permission once
  per session). Firefox and Safari can't: there *Save model as…* downloads a
  copy, which is not linked to the model, and where it goes depends on the
  browser's download settings. A file opened through Firefox's or Safari's
  file picker, or dropped onto the page, is never linked. The
  `beforeunload` prompt is the browser's generic one, and some browsers limit
  when it's shown.
* **Virtualization is a model of the network side.** No Kubernetes (pods,
  services, CNI plugins, ingress: a Kubernetes node is a container host with
  its networks, its pods containers), no nested virtualization (a VM can't
  have the Hypervisor service), no vMotion (a VM moves only by an HA restart
  in the simulation), no distributed switch spanning hosts (each host's
  switch is its own), no overlay tunnel between container hosts (an overlay
  is one network). **NAT is modelled for container bridges and the NAT
  service only:** SNAT to the host's address and DNAT for published ports; the path tracer names the
  published ports but doesn't check port numbers, and the simulation keeps
  one translation per flow (no port exhaustion, no hairpin NAT). HA restarts
  a VM on the first member (by id) that is on, without admission control
  or resources; a host's inventory (CPU, RAM) is only compared, never
  enforced. A VM drawn in another host during the simulation makes room
  below that host; the stored layout never changes.
* **Connecting in the diagram** creates two-endpoint links and relations
  only; a relation with more endpoints, an underlay (`over`) or attributes is
  completed in the Edit tab afterwards. A device with very many uncabled
  ports gets a tall strip of chips, and one with many addressed interfaces a
  tall box: every address is written out.
* **Interface actions follow the interface's state.** Shut, its button is
  **Bring interface up** and the form is marked *⏻ Shut* (a bar, a tint,
  the words); flapping, **Stop flapping** and *↯ Flapping* with its cycle.
  It follows whatever changed the interface: the form, the diagram's
  menus, Active events, a flap's own transitions; another interface chosen
  shows its own state. The administrative state and the link are said
  apart (*Administratively up · link down (dsl-router is off)*). **Conflict
  rule:** Shut interface ends the interface's flapping first (its later
  transitions are cancelled, so none can bring the interface up); a shut
  interface can't start flapping; one flapping per cable. **Stop
  flapping** cancels the flap's later transitions and leaves the cable as
  it would be without it (up again unless a shut, a failed cable or a
  device off holds it down). A second press within half a second counts as
  the same press. Simulation only: the model is not changed.
* **Multicast from Network events is drawn.** A join's IGMP / MLD reports
  (its unsolicited ones and its leave, with what they cause at once: a
  router's PIM Join upstream, its group-specific query after the leave)
  and a stream's datagrams carry
  their event's id, as a send's messages do: drawn whatever protocols and
  senders are ticked, marked **Test** in the log, opened from the event's
  details and by their dots. They follow the simulation's own forwarding
  (the copies the switches and routers make; flooded in a VLAN where
  snooping knows no member, as the switches do), and a stream's event
  says where its copies stop. The datagrams sent are counted apart from
  their copies and from what each member received.
* **Foreground and background are a display choice.** A send's intervals
  are simulated time in every pacing: in Readable pacing its next message
  comes as soon as the last one was seen, not after a real interval; Real
  time pacing gives real seconds, with brief dots. Cable activity shows the last 3 s of display,
  by cable and protocol, not every hop. A browser tab in the background
  stops the display clock; nothing catches up when it comes back.
* **Streams in real time: browser timing.** A stream of Network events
  sends in the first animation frame at or after each moment of its
  schedule (within a frame, about 1/60 s, on an idle page); a busy page is
  later, but each deadline is computed from the stream's start, so it
  never drifts. A frame later than a whole interval (a stall, a suspended
  or hidden tab) sends one datagram, the others are counted as skipped in
  the event's details; a hidden tab pauses the streams with the clock.
  While a stream runs the simulated clock runs with real time, so on a
  heavy model it can fall behind (*· behind*): the datagrams still go on
  time, at the simulated time reached. Their simulated times depend on how
  the simulation was played, so two runs differ there (the model's own
  streams and everything else stay the same every run). The stream's
  dots keep the pacing's hop time: in Readable pacing several datagrams
  of a stream are on screen at once, and a send's dots don't hold the
  clock while a stream runs (its reply is drawn after its request
  arrived). Streams have no count or duration of their own.
* **Device state's limits.** The lifecycle the simulation has is powered
  on, off and booting (Power off, Power on); there is no reboot or
  shutdown of its own (Power off, then Power on, is a reboot: off, then
  booting, then operational). A failed-open IDS / IPS is *Powered off
  (failed open)*: it passes frames unchecked. The status indicator is
  placed once per redraw, where nothing is drawn on the box's top or bottom
  edge; on a box crowded with ports on both edges it takes the top right
  corner anyway (it never moves the box). The simulation's own virtual
  switches have no indicator (they are not devices of the model).
* **IGMP / MLD snooping's limits.** One choice per VLAN covers IGMP and
  MLD together (no separate MLD setting). Forwarding is by group: an
  IGMPv3 / MLDv2 member's sources are shown, not filtered at the switch.
  A switch's snooping querier sends IGMP (IPv4) queries only, from its
  VLAN interface's IPv4 address (none: no querier); IPv6 members are
  learned from their own reports and from multicast routers' queries.
  Memberships and router ports age in simulated time (the
  membership interval, the router port aging), never in real time; a
  stream of Network events is sent at the simulated time it is due, so its
  datagrams follow the same tables. Access points and virtual switches
  don't snoop (they flood a VLAN's multicast to their ports, an access
  point to the clients of that Wi-Fi network only). A change of a switch's
  VLANs or snooping needs the simulation started again (the model is
  locked meanwhile).
* **The querier election's limits.** IGMPv2 / v3 and MLDv1 / v2 rules
  (the lowest address wins, startup queries, the other querier present
  interval); IGMPv1 (no election) is not simulated. A switch's snooping
  querier takes part in the same election by its VLAN interface's address
  (some switches instead defer to any multicast router; that is not
  modelled). All IGMP / MLD timers — the election, the queries, the
  members' answers, the aging — run on the simulated clock; in Readable
  pacing that clock slows while dots are shown, in Real time pacing (or
  while a stream of Network events runs) it follows real time. A leave
  report is sent once (a v3 / MLDv2 state-change report is not repeated);
  a lost leave is covered by the membership interval. A Leave multicast
  group follows the entries learned on the host's way when it is sent; an
  entry learned later (another join of it) is not followed. Querier marks
  are placed like the status pills: when nothing beside a box is free they
  take its top right corner. Fast leave removes a switch's port at once,
  also when another member is behind it (as configured switches do).
* **Network events' limits.** Fail link and Power off have no form of
  their own (the diagram's menus start them; they are listed). Flapping
  uses the Layer 1 parameters for every flap (no per-flap timing); a
  stream runs until stopped (no count or duration). A join's outcome is
  what a multicast router of its segment records; receipt by snooping
  switches is not part of it. A join's answers to later queries belong to
  its membership, not to the join: they are drawn only when IGMP / MLD is
  ticked (a model with multicast). At most 50 finished events are kept.
* **Send test's limits.** A series plays at the animation's pace: in
  *Readable* pacing every message's hops are drawn, so 100 messages take
  as long on screen as their hops do, while their simulated times stay one
  interval apart (the event log shows them). Multicast tests are UDP only
  (no echo to a group); a directed broadcast must name a subnet of the
  model; the source port is always an ephemeral one (no source port field);
  Stop ends a series but not the messages already on their way.
* **Auto-arrange is heuristic.** It reduces crossings and overlaps but
  doesn't minimize them, so dense meshes (e.g. a full iBGP mesh) still cross,
  and some cabling can't be drawn without crossings at all (two spines to
  four leaves: six). The exchanges make arranging a model of a few hundred
  devices slower (about 1 s for 300 devices in Node, 0.7 s before); above
  400 devices they are skipped.
  Cables and relations are routed around boxes with a few bends, not
  orthogonally routed. Ports, stubs and end labels need room: logical
  diagrams are somewhat larger than they were without them (8–35 % per
  side for the examples). Network membership lines still end at the border
  of the device box, not at the port of the interface holding the address
  (the address is written on the line and in the entry). Positions
  are deterministic within one netatlas version; a future version may
  arrange differently, which only matters when you press Auto-arrange again.
  Stored positions are never changed by an upgrade. Determinism across
  engines relies on the ECMAScript arithmetic guarantees; it was verified in
  V8 (Node, Chrome, Edge). Firefox and Safari can run the same check with
  `#selftest`.
* **Performance** (measured in Node on a generated model with 1000 devices
  in 20 sites): Auto-arrange took 73 ms for the physical view and 170 ms for
  the logical view; an edit, including validation and position upkeep, took
  35–65 ms. Browser rendering comes on top. The logical layout grows with
  the square of the largest connected component (stress layout up to 300
  nodes, a cheaper force layout above that).
* **Before anything is stored**, the diagram shows the auto-arranged layout,
  which follows the model. Once positions are stored (after the first move,
  geometric edit or arrange), nothing moves by itself: new objects are
  placed next to their neighbors, which can be less tidy than a fresh
  Auto-arrange.
* **Network semantics are only partly checked.** netatlas validates address
  and prefix syntax, duplicate addresses and prefixes and VLAN IDs, and its
  consistency checks compare what the model writes down (see [Consistency
  checks](FORMAT.md#consistency-checks)). They don't read device configurations, so
  they find contradictions in the model, not in the network. It doesn't
  compare the VLANs a port carries with the addresses behind it (carriage
  and membership are separate facts).
* **The Addressing overview derives what the format doesn't say.** A
  network has no VRF of its own: it is listed in the VRFs of the interfaces
  that have addresses in it (and of DHCP clients on cables carrying its
  VLAN), and in the default table when it has none, so a network meant for
  a VRF but without members is listed in the default table. Membership is by
  address alone, as everywhere in NetAtlas. A DHCP client is listed in the
  networks whose VLAN its cable carries; it has no address, so it isn't
  counted as used. Gateways are found where the model writes them (virtual
  addresses, default routes); a gateway configured only on the hosts isn't
  known. IPv6 free ranges include a subnet's first address (the
  subnet-router anycast address), but it is never offered as the next free
  address. Large IPv6 networks list their free ranges as ranges, never
  address by address.
* **Focus mode counts hops between devices.** A hop follows a cable
  (Physical view) or a relation (Logical view) from one device to another; a
  network, a location or a protocol is not a step of its own, and an object
  without a device (a network without members) can't be focused. Networks
  and relations are shown where the filtered view (*Find and filter objects* in Help → User Manual)
  shows them for the focused devices. The neighbourhood is computed on the
  complete model, then narrowed by the other filters, so a device hidden by
  a filter can still be the way to one that is shown.
* **Input helpers only suggest.** They are computed from the model as it
  is (a VRRP group number is free on the interface's segment as the model
  describes it, not on the real network); the underlay-derived tunnel MTU
  uses the same fixed overheads as the tunnel-MTU check. A generated MAC
  address is unique in the model only. The VRF combobox lists the VRFs of
  interfaces and routes; the VRF case check compares names exactly
  otherwise.
* **Routing services describe configuration, they don't run it.** Each
  protocol has a fixed set of parameters (a protocol of the model may
  declare its own); there are no per-interface OSPF or IS-IS settings
  (areas, costs and timers are per relation end), no route maps, no
  redistribution, no BGP address families or neighbour settings beyond
  `peer-as`, and one router ID per protocol (no per-VRF instances). A
  router ID or AS number is not invented: enabling a protocol leaves its
  mandatory parameters empty and reported. Duplicate router IDs are looked
  for within the devices one protocol's relations join, not across
  protocols. A VRRP / HSRP group's members are found by its virtual
  address; the group's relation (`vrrp-users`) is drawn as before but no
  longer holds the address.
* **The protocol simulation is a teaching and design-review simulation of
  protocol behaviour, not an exact protocol implementation.** There is no
  real timing jitter (only a small fixed-seed jitter of starts and timers, under a hop's time), no
  vendor-specific behaviour beyond the parameters, no queuing beyond each cable's serialization
  (one frame after the other) and no CPU limits; packet loss is a share of
  frames from a fixed seed. TCP has no congestion control, windows or
  delayed acknowledgements (a request and an answer, each acknowledged);
  UDP and TCP tests stand for applications (fixed sizes: a 120-byte
  request, a 1460-byte answer); DHCP is IPv4 only (no DHCPv6), one lease
  per interface, without DECLINE, RELEASE, INFORM or option 82; DNS has no
  negative caching, DNSSEC or TCP fallback and recurses only through the
  model's DNS servers (a DHCP client without a DHCP server in the model
  gets no address, or a link-local one with its fallback on); a
  firewall's policy is the model's relations plus its `allow` list (no
  rule base, NAT or application identification); load balancers and
  proxies relay TCP only (UDP to them is answered by themselves); a
  broadcast storm follows each frame for 6 rounds instead of forever.
  Multicast: no MSDP or inter-domain multicast, no PIM Assert (two routers
  forwarding onto one LAN both do until one prunes), no Bidir-PIM, no
  embedded or anycast RP; the bootstrap router announces the RP but RP
  election is the highest candidate's router ID (not RFC 7761's hash); an
  RPT prune acts at the next router up only; register suppression lasts
  while the source sends (no null registers); IGMPv3 / MLDv2 source lists
  are kept per group, not per filter-mode transition. The pacing shows
  each hop for its paced time while the simulated clock runs on: in
  Readable pacing the dots of a long chain (a ping across several routers
  with ARP on the way) run behind the tables and the log, up to 15 s,
  beyond which the exchange shows as cable activity; a busy model (BFD
  every 300 ms, streams, storms) can exceed the 25 ms of work a frame and
  fall behind real time (*· behind*). The causal order on screen follows
  the deliveries the engine records; a reply sent after a delay of its own
  (a service's response time, an ARP retransmission) is ordered by its
  conversation, not by a recorded cause. Messages beyond the 48 on screen
  are not drawn, so a hop of a message that was not drawn may be followed
  by one that is. Background dots are not inspectable on the diagram;
  the event log opens any of them.
  Senders choose what is shown, not what runs: every device's protocols
  are computed, so a model with few senders still costs the whole
  simulation's work, and between two shown messages the clock may jump
  through many hidden ones (at most 25 ms of work a frame). A message's
  origin follows what a device handles at once: a reply sent after a
  delay of its own (a service response time, an ARP retransmission)
  counts as the replier's.
  Following a message keeps its conversation drawn (the same protocol
  between the same two ends); the other messages go on, faint. The time shown
  is always the true simulated time; what happens is never affected.
  The spanning tree is converged at the start; its convergence after a
  change uses the mode's timer (RSTP at once at the change or after 3
  hellos, STP 30 or 50 s), not BPDU-by-BPDU proposal and agreement. A
  device's boot is one wait (its boot time); a VM can only restart on a
  server it is cabled to. Changing a dead or hold interval during a
  simulation applies from the next message heard. Routing is the path
  tracer's (connected networks, static routes, the relations of enabled
  protocols as their adjacencies come up), not real link-state or
  path-vector computation: OSPF areas, LSA types, BGP attributes and
  policies are not modelled; an LSU or UPDATE stands for what changed.
  Service traffic (DNS, NTP, syslog …) is sent at a fixed demonstration
  interval. A frame's way through the switches is decided when it is sent.
  Loops are broken by a spanning tree per VLAN whether or not the model
  has an STP relation (BPDUs are shown only where it does), unless the
  switches' spanning tree is set off; a topology change flushes
  the VLAN's MAC tables. A gratuitous ARP updates entries but creates
  none. A tunnel's outer packet that the model's routing does not carry
  (an internet the model leaves out) follows the cables its relations are
  declared `over`, as Trace path does, without ARP there. Large models: at most 48 dots are drawn at
  once and the event log keeps the last 20 000 events; the simulation
  itself runs every protocol of the model, which may slow the page for
  models with many hundreds of sessions.
* **Layer 2 switches** have one management interface with addresses; a
  model that routes on a switch must say `layer3: true` (earlier files
  without it are reported, not converted).
* **The single points of failure follow what the model writes.** A relation goes
  down when anything it runs `over` goes down: `over` is read as a chain,
  so a relation that could take another way (a routed tunnel over a
  redundant internet) is only as redundant as its `over:` list says; a LACP
  or MLAG relation's cables count side by side. A relation without `over` is
  affected only through its endpoints. A VLAN interface goes down only when
  every port carrying its VLAN does; partial capacity loss is not modelled
  (a degraded LAG has no less bandwidth in the model). Device pairs are
  checked by tracing between devices (each to the other's first address
  that is still up), for at most 40 devices; the single points of failure
  are found by failing each cable, device and LAG alone, never
  combinations.
* **The path tracer is a model-based approximation, not a simulation of
  real protocols.** Every router of a routing protocol's adjacencies
  advertises all its connected networks and passes on what it learns;
  static routes are not advertised, nothing is redistributed between
  protocols, and areas, route maps, prefix lists, AS paths, BGP attributes,
  summarisation and timers are not considered (BGP is treated like the
  other protocols, by hop count unless a `cost` is written). An adjacency
  forms only where the two have a network in common (a BGP session may also
  run between loopbacks). ACLs, firewall policies, NAT (but for container
  bridges and the NAT service), policy-based routing, multicast and MPLS label
  switching are out of scope: the model
  doesn't describe them. Between two hops the cable way is the shortest one
  through layer-2 devices (as a spanning tree might leave it), not a
  simulation of spanning tree; an interface without a cable in the model is
  taken as connected. Equal-cost paths are all listed (up to 16), with no
  hashing. A tunnel's underlay is traced only when the routes of the model
  lead to its destination; otherwise its `over:` chain is shown as written.
  The return path starts at the destination's own address (the interface
  traced to).
* **The command palette's shortcuts are the page's own.** `Ctrl+K` / `Cmd+K`
  is taken from the browser (in some browsers it focuses the address or
  search bar) while NetAtlas has the focus. The palette searches the open
  model only; the recent list is kept per browser and lists objects only
  while they exist.
* **The consistency checks are approximations.** The tunnel-MTU check
  assumes a fixed overhead per encapsulation with an IPv4 outer header
  (IPsec: the worst case of ESP tunnel mode; an IPv6 outer header, GRE keys
  and sequence numbers, or IPsec NAT traversal add more) and skips protocols
  it has no figure for. The underlay check only asks whether the links,
  networks and relations in `over:` connect the endpoints as a graph; it
  doesn't route over them. OSPF and BGP parameters are read from relation
  attributes with fixed names (`area`, `network-type`, `hello`, `dead`,
  `peer-as`), so a model that spells them otherwise isn't checked; a single
  value for both ends is taken as agreement. A multi-chassis aggregate is
  accepted when an `mlag`/`vpc` relation includes all its peer devices,
  without checking the MLAG's own configuration. A VRF mismatch is reported
  only where both interfaces name a VRF, since VRF names are local to a
  device.
* **Static routes are a model, not a router.** Route selection is longest
  prefix, then distance (a missing one counts as 1), then metric; next hops
  resolve directly or recursively, never through a default route. Vendor
  specifics (route tags, tracking objects, permanent routes, resolution
  through a default route where a vendor allows it, BFD for static routes,
  per-VRF next hops into another VRF) are not modelled. Routes are drawn in
  the logical view only; the next-hop line points at the interface that has
  the next-hop address, not along the path. A device of type access point,
  IDS/IPS or cloud, or without a type, can't have routes; there is no
  separate default-gateway field (a gateway is a static default route).
* **Port VLANs are 802.1Q access and trunk ports, by VLAN ID.** There is
  no list of VLANs with names of their own: a VLAN exists in the model when
  a network or a VLAN interface names it (VLAN 1, the default VLAN, always
  does). A trunk's VLANs are its allowed list, pruned by nothing else.
  Q-in-Q, VLAN translation, private VLANs, voice VLANs on access ports,
  dynamic VLAN assignment (802.1X, VTP, MVRP) and per-VLAN port costs are
  not modelled. A routed port with subinterfaces is compared with a trunk
  on its tagged VLANs only; its untagged traffic is not a native VLAN.
* **A relation names only its underlay.** A network a relation carries or
  serves (the VNI of a VXLAN, the customer networks of an L3VPN) has no
  field of its own; keep it in the relation's `attrs`. Endpoints carry no
  role, address or attributes; those go into the relation's `attrs` too.
* **Membership is by address only.** VRFs are names on interfaces and don't
  separate address spaces: the same prefix used in two VRFs is one network
  with members from both. A device without addresses (an unmanaged switch, an
  access point in bridge mode) can't be shown as a member of a network.
* **One prefix per network.** A segment with an IPv4 and an IPv6 prefix is
  two networks (they may share a VLAN).
* **Text measurement is estimated** (no font metrics, which keeps
  Auto-arrange identical in every browser). Boxes therefore have a little
  spare room, and with an unusually wide font a very long line can touch the
  edge of its box.
* **Label placement has limits.** Labels keep clear of nodes, of group
  titles and of each other, not of lines, so a label can lie on a cable or
  relation line that isn't its own (it has a halo that keeps it readable).
  The addresses of a membership line are written on that line. A label that
  finds no free place next to its line takes the nearest free place further
  away, tied to its line by a dashed leader; only when there is none (after
  dragging nodes close together) is it put where it overlaps least, and the
  overlap is reported over the diagram (it is never dropped).
* **Addresses in `attrs`** are recognised by their value (an IPv4 / IPv6
  address or prefix, or a MAC address) and drawn with their key; other
  identifiers kept there (a route target, a VNI, an AS number) are not
  addresses and stay in the details. Descriptions are free text and are not
  searched for addresses.
* **Themes:** Dark and Light only; the operating system's light or dark
  setting is not followed. While a dialog is open the page behind it can't
  be used (the dialog is modal), so the theme is switched before or after. Colours of custom protocols are adjusted per
  theme like the built-in ones (darker on light only when too pale, calmer
  and lighter on dark).
* **Group placement is a heuristic.** It follows the cabling layer by layer
  and tries a bounded number of alternatives. It gives short, mostly
  uncrossed cabling for trees and hub-and-spoke shapes; rings and meshes
  between groups still cross somewhere. The diagram's shape follows the
  topology (a chain of groups is tall, many siblings are wide).
* **Routing is simple.** Cables bend around devices, not around group boxes,
  titles or other cables; relation lines in the logical view are always
  straight. Crossings are reduced, not eliminated.
* **Stored layouts and application versions:** a stored layout keeps its
  positions in every NetAtlas version. If a version arranges differently,
  the view shows *edited since arranged* until you use Auto-arrange again.
* **Keyboard access:** forms and panels are keyboard-operable, but diagram
  elements aren't individually focusable.
* **Small windows:** the application always fits the browser viewport and
  the page itself never scrolls; each panel scrolls on its own. The model
  panel is always shown. Below 1100 px it and the side panel get narrower
  (the side panel can be resized, but the diagram keeps at least 360 px);
  below 860 px both move under the diagram, side by side. In windows under
  560 px of height the mouse and keyboard help starts folded. Very small windows (or a
  strongly zoomed page) leave little room for the diagram, because the
  toolbar wraps onto more rows there. In the simulation layout the side
  panels have fixed widths (no splitter); below 860 px Setup and Actions
  are tabs, and in a window that is also 700 px high or less the diagram
  takes turns with them above the simulation panel. At 300 % zoom on a
  1080p screen only the toolbar and the simulation panel's controls fit.
* **The SVG legend is a single column** to the right of the diagram, in the
  diagram's own units. A model with very many protocols or device types
  gives a tall legend, and the picture is made as tall as the legend. It
  doesn't repeat the explanatory paragraphs of the Legend tab.
* **The Networks box makes exported pictures wider.** It stands to the right
  of the legend and continues in further columns when the list is long, so a
  model with hundreds of relevant networks gives a wide picture. In the
  logical view with network nodes switched on, every network is drawn and
  therefore listed.
* **Device types are a fixed list** of 15 (see [docs/FORMAT.md](FORMAT.md));
  a kind (with *Other* and a name of your own) and a role say more.
* **A Security gateway is a model of a boundary**, not of a product: it
  shows how a filtering bridge, a filtering router or a protocol break
  behaves with an explicit policy, and gives no assurance of a real
  device's separation. A protocol break models HTTPS requests, DNS queries
  and syslog messages only; anything else is reported as a limitation.
  Router ACLs are not part of the path tracer (a Security gateway's
  policy, a firewall's policy, a VPN gateway's tunnels and port pairs are).
* **A firewall's policy has no zones or directions:** it is the model's
  relations through it (each permits its protocol's port between its
  devices, both ways) and its `allow` list (a service from anywhere to
  anywhere), with stateful replies and a default action. A rule base with
  zones, directions and address objects ("Internal may open IoT, IoT may
  not open Internal") is not modelled; `private-house.yaml` therefore
  permits only each zone's HTTPS to the Internet and nothing between zones.
  The path tracer applies the policy when you give a service.
* **A Cloud is opaque:** one Layer 3 hop with its latency and loss; its
  internals, and a public cloud's hosts behind its cloud instances, are not
  modelled.
* **Services are modelled by their exchanges, not their software.** NTP,
  RADIUS / TACACS+, syslog, SNMP and CAPWAP are simulated as their
  request / answer messages (no clock discipline, no EAP, no MIB, no
  CAPWAP join or image download); a storage service and an application
  listen on their ports and answer. A forward proxy without a parent is
  reported as a limitation (its destinations are outside the model); a
  reverse proxy and a load balancer relay one connection each way. NAT is
  one translation per flow (PAT and source NAT inside → outside, port
  forwards outside → in; no port exhaustion, no hairpin NAT). An IDS/IPS's
  Inspection matches protocols and ports only. Router ACLs are not
  modelled.
* **Wi-Fi without radio.** There is no radio-frequency model: no channels,
  coverage, interference, rates or roaming; a client is associated with
  the network its connection names. A network tunneled to its controller
  is not simulated (the simulation and the tracer say so); a controller's
  own forwarding of client traffic is not modelled. WPA security is a
  label: no 4-way handshake or 802.1X exchange is simulated.
* **Associations of logical interfaces are limited to a few kinds:**
  member ports, a VLAN (with its derived bridge ports), a subinterface's
  port (by its name, `<port>.<n>`) and a tunnel's source and destination.
  A VLAN interface's *Bridge ports* are the ports of its own device only.
* **DNS names and DHCP outside a simulation.** A name belongs to whole
  interfaces; it can't be tied to one address of an interface. A DNS
  server's zone derives its A and AAAA records from the names in it; names
  of devices not in any zone are not checked against anything. A DHCP
  client's address is unknown outside a simulation (it is in no network
  and has no derived VLAN); the lease a simulation gives it is shown, not
  written to the model. DHCP is not available on loopbacks; a server's
  scopes are IPv4 only.
* **Filtered views are not saved.** The device selection and the positions
  of a filtered view last until the model is closed or reloaded; only the
  complete diagrams' positions are stored in the YAML file.
* **Logical group frames can be crossed by relation lines.** Devices of a
  group are kept together, but a relation between two groups is drawn
  straight and may pass over a third group's frame.
* **Alphabetical means natural order:** letters ignore case and digit runs
  compare by value (`eth2` before `eth10`); it is not locale-aware.
* **No other import or export formats** (only YAML in; YAML, PNG and SVG
  out), no printing layout, and no multi-user editing.
* **Very large PNGs:** the PNG is drawn by the browser at twice the
  diagram's size, less for very large diagrams. A diagram too large for the
  browser to draw as one image can't be exported as PNG (the dialog says
  so); the SVG export has no such limit.
* The automated browser test needs a Chromium-based browser. Firefox and
  Safari are covered by the manual `#selftest` procedure.

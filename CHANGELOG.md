# Changelog

All notable changes to NetAtlas are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/). While the version is 0.x, minor
releases may still change behaviour.

Two version numbers are involved. The **application version** (0.1.2) names
a NetAtlas release and is shown next to the logo. The **model format
version** (`netatlas: 1`) names the YAML format a model file is written in;
it is described in [docs/FORMAT.md](docs/FORMAT.md).

## [Unreleased]

### Model format 1: changes before launch

NetAtlas is not released for production use yet, so model format 1 still
changes. These changes are made within version 1 (files keep `netatlas: 1`);
there is no conversion of files written for the earlier drafts.

- **Static routes:** a device may have `routes`, each with `prefix` and a
  next hop (`via`, `interface`, both, or `blackhole: true`), and optionally
  `distance` (1–255), `metric`, `vrf`, `name`, `description` and `attrs`.
  Allowed on Layer 3+ device types (router, switch, firewall, load balancer,
  proxy, gateway) and on hosts (server, VM, container, storage, endpoint,
  system); an error on access points, IDS/IPS, clouds and devices without a
  type. A host's default gateway is a static default route.
- **VLAN tagging on link ends** replaces the per-end `networks` list: a link
  end has `mode` (`access` or `trunk`), `untagged` (a VLAN ID: the access VLAN
  or a trunk's native VLAN) and `tagged` (VLAN IDs and ranges such as
  `100-199`). VLANs are referenced by ID, as on networks and VLAN interfaces;
  the networks a cable carries are now derived from its tagging. `networks`
  on a link end is an unknown key.
- **Consistency facts as fields:** an interface may have `mtu`; an aggregate
  (a virtual interface with members) `min_links`; a device `router_id` (an
  IPv4 address) and `asn`; a link end the port's `speed` and `duplex`
  (`full`, `half`, `auto`). The examples write these as fields instead of
  `attrs` (`router-id`, `asn`, `local-as`, a GRE relation's `mtu`).
- **`checks:`** (top level) switches consistency checks off or changes their
  severity: `checks: {duplicate-mac: info, relation-vrf-mismatch: off}`.
- **Routing services (`protocols:` on a device):** a Layer 3+ device lists
  the protocols it runs, each with its parameters
  (`protocols: {bgp: {asn: 65010}, ospf: {}, static: {}}`), defined by a
  registry (BGP, OSPF, IS-IS, EIGRP, RIP, LDP, PIM, BFD, static routing,
  VRRP, HSRP, GLBP, CARP). Mandatory parameters (BGP's `asn`, IS-IS's `net`,
  a group's `group` and `virtual_ip`) are errors until written; OSPF needs a
  router ID. `protocols:` on a device that isn't Layer 3+ is an error.
- **The device's `asn` key is gone:** the AS number is BGP's parameter;
  `asn` on a device is an unknown key that says where it belongs.
- **`router_id`** is shared by the protocols that use one, and may name a
  loopback of the device (`router_id: lo0`, its IPv4 address) or be an
  IPv4 address; a protocol may have its own (`ospf: {router_id: …}`).
  Without an enabled protocol that uses a router ID it is reported as not
  applicable.
- **VRRP / HSRP groups at their interfaces:** an interface's
  `protocols: {vrrp: {group: 10, virtual_ip: 10.10.10.1, priority: 200}}`
  (also `virtual_ipv6`) replaces the virtual addresses in relation `attrs`
  (`virtual-ip`, `vip`, `master`, `priority`) and interface attributes
  (`vrrp-virtual-ip`), which nothing reads any more.
- **A protocol of the model can declare `params`** (key, label, type,
  scope, required, range or values, suggestions, description) and
  `router_id` (`required` / `optional` / `none`); it is then a routing
  service like the built-in ones.
- **No compatibility messages for earlier drafts:** keys that earlier
  development versions used (`loopbacks`, `children`, `directed`, `prefixes`,
  `vlans`, `vendor` …) are reported like any other unknown key, with the
  closest known key as a suggestion; group kind `row` is free text like
  every other kind. `router_id` is an address now: the earlier
  `router_id: lo0` is an error ("not a router ID").

### Added

- **Input helpers in the Edit tab** (each an explicit action, one undo
  step, validated like typing, nothing written by itself): MTU chips (1500,
  9000, and for tunnels 1476, 1400 and the underlay's MTU less the
  encapsulation overhead), **Generate** for a MAC address (random, locally
  administered unicast, unique in the model, in the model's style, from
  `crypto.getRandomValues`), a **VRF combobox** (the VRFs in use with their
  counts; case-only differences flagged), VLAN IDs (next free, defined),
  an interface name that follows the device's pattern, the router ID from
  the loopbacks, AS numbers in use, VRRP / HSRP group numbers and virtual
  IPs on the segment, the registry's common parameter values, default
  route prefixes and a floating distance, an IS-IS NET from the router ID,
  a BGP end's peer AS from the other device. The palette offers *Generate a
  MAC address* and *MTU 1500* for the selected interface. A protocol
  defined in the model has a *Routing service* card (*Uses a router ID*).
- **Check `vrf-name-case`:** VRF names that differ only in case.

- **Routing services in the Edit tab:** a device's **Protocols** card shows
  the protocols it runs with their parameters (typed fields, choices,
  suggestions), the shared **Router ID** while one of them uses it (its
  loopbacks offered), an own router ID per protocol, one-click
  suggestions for protocols the device's relations use but it doesn't
  enable, **Enable a protocol…**, and **Disable** (listing what goes, one
  undo step). Interfaces get their VRRP/HSRP group card; relations of OSPF,
  BGP … a card with their per-end parameters. The palette has *Enable a
  protocol on the selected device…*; Find and the palette find protocols,
  AS numbers, router IDs and virtual addresses.
- **Checks** `protocol-not-enabled`, `protocol-unused`, `static-not-enabled`
  and `fhrp-group-mismatch`; `duplicate-router-id` per protocol domain;
  `vip-outside-subnet` on the interfaces' groups.

- **Static routes in the diagram and the editor.** The logical view shows
  each device's routes as a route table in its box (one per VRF), a line per
  route (`0.0.0.0/0 via 203.0.113.5 AD 250`), and a dotted line with an arrow
  from a route to the interface its next hop belongs to. A **Routes** switch
  in the toolbar's Filters hides them without moving anything. The Edit tab
  has a **Static routes** section per device (add, edit, duplicate, delete,
  each one undo step; an exit-interface picker and next-hop suggestions).
  Details, tooltips, **Find** (prefix, next hop, name) and selection include
  routes; a route is related to its device, its exit interface and the
  interface its next hop belongs to.
- **VLAN tagging in the diagram and the editor.** The physical view writes
  each link end's tagging under its port name (`U 99 · T 10,20,100-199`) and
  marks a cable whose ends disagree with ⚠ *VLANs differ*. The Edit tab has
  **Mode**, **Untagged / Native VLAN** and **Tagged VLANs** per end, with the
  networks they carry; **Find** finds the cables carrying a VLAN (`vlan 20`).
- **Analysis module** (`src/analysis/`): address arithmetic for IPv4 and
  IPv6, routing tables (connected networks, static routes per VRF,
  longest-prefix match, distance, metric, equal-cost multipath, recursive
  next hops never through a default route) and a registry of **consistency
  checks**, each with a stable id, a severity and the fields it reads. Its
  findings appear in the Problems tab (with the check id, and a click opens
  the object) and at their field in the Edit tab; they never make a model
  invalid. Checks in this release: `route-nexthop-self`,
  `route-nexthop-unresolved`, `route-nexthop-recursive` (info),
  `route-nexthop-interface`, `route-exit-interface`, `route-duplicate`,
  `route-conflict`, `vlan-native-mismatch`, `vlan-tagged-mismatch`,
  `vlan-access-tagged`, `vlan-untagged-tagged`, `vlan-unknown`.
- **Addressing overview** (Analyze → Addressing overview…, `I`): the
  networks of each VRF nested by containing prefix, with VLAN, name,
  members (device, interface, address, DNS name, DHCP), gateway or VIP, used
  addresses and size, utilization (IPv4 percent; IPv6 number of /64s), free
  ranges and the next free address; duplicate addresses, overlapping
  prefixes and addresses in no network. Filter, sort, a click selects the
  object in the diagram, Copy CSV and Save CSV. The Edit tab offers the next
  free address of a network when an address is added to an interface.
  Computed in `src/analysis/addressing.ts`.
- **Analyze menu** between Find and Help, for the analysis views.
- **Command palette** (`Ctrl+K`, `Cmd+K` on a Mac; Find → Command
  palette…): fuzzy search over every command (with its shortcut; an
  unavailable one disabled, with the reason) and every object of the model
  (devices, interfaces, cables, networks, relations, routes, locations);
  recent entries first; Enter runs or selects, Esc closes; the number of
  results is announced. The menus, the keyboard shortcuts and the palette
  now come from one command registry (`src/ui/commands.ts`).
- **Focus mode** (`Shift+F`, the ◎ Focus button under the diagram, Analyze →
  Focus on selection): only the selected object and what is within 1–3 hops
  of it, along cables (physical view) or relations (logical view). A banner
  names it, changes the hops and exits (also `Esc`); it combines with the
  other filters, positions are temporary, and leaving it restores the
  diagram and zoom exactly. Exports carry a *Focus* note. Computed in
  `src/analysis/focus.ts`.
- **Path tracer** (Analyze → Trace path…, `T`): from a device, interface or
  address to another, optionally in a VRF, by the model's connected
  networks, static routes and routes learned over the routing adjacencies
  (OSPF, IS-IS, EIGRP, RIP, BGP: `cost` per adjacency, else a hop count;
  longest prefix, administrative distance, equal-cost multipath), VRRP
  virtual gateways, the cables through switches in the network's VLAN, and
  tunnels with their encapsulation stack (GRE over IPsec) and underlay. The
  new **Analysis** tab lists the hops (device, interfaces and addresses, the
  route or adjacency, the encapsulation, the cables), the equal-cost
  alternatives, where and why a trace stops, and an optional return path
  that reveals asymmetric routing; Copy / Save as text. Both views mark the
  path (solid), the alternatives (dashed) and the return path (dotted);
  exports carry it with a *Path trace* note. A model-based approximation,
  computed in `src/analysis/trace.ts`; the routing tables now include the
  dynamic routes (`src/analysis/routing.ts`).
- **The mode banner** has a row per analysis mode on (simulation, focus,
  path trace).
- **Failure simulation** (Analyze → Simulate failure of selection, `X`):
  fail cables, ports, devices or relations; the failure is propagated
  through the model (interfaces and cables of a failed device, the cable of
  a failed port, everything that runs `over` a failed cable or relation,
  recursively; LAGs degraded while `min_links` members are up; redundancy
  groups failing over; static routes failing and floating routes taking
  over; networks losing members). Both views mark what is down (dotted,
  faded) or degraded (dash-dot); the Analysis tab counts and lists the
  affected relations, tunnels, networks, routes, devices and cables and the
  device pairs that lose reachability; a banner marks the simulation, `Esc`
  ends it. Path tracing works under it. Exports carry a *Simulation* note.
  Computed in `src/analysis/failure.ts`.
- **Single points of failure** (Analyze → Single points of failure…): the
  cables, devices and LAGs whose failure alone partitions the physical
  network or brings down relations without a redundant underlay; an entry
  starts its simulation.
- **More consistency checks**, each with a positive and a negative test:
  `link-mtu-mismatch`, `tunnel-mtu` (with the encapsulation overhead it
  assumes in the message, added up over a tunnel stack),
  `link-speed-mismatch`, `link-duplex-mismatch`, `lag-member-speed`,
  `lag-peer-devices` (unless an MLAG pairs the peers), `lag-min-links`,
  `link-subnet-mismatch`, `address-reserved`, `vip-outside-subnet`,
  `duplicate-router-id`, `duplicate-mac`, `ospf-area-mismatch`,
  `ospf-network-type-mismatch`, `ospf-timer-mismatch`, `bgp-peer-as`,
  `bgp-session-type`, `tunnel-endpoint-mismatch`, `tunnel-underlay`,
  `relation-vrf-mismatch`.
- **Problems tab** in two parts, the file's own problems and the consistency
  checks; findings can be narrowed by severity and name the objects they
  concern as links; the checks a model changes are listed. **Model settings
  → Consistency checks** sets each check to its default, another severity or
  off. The Edit tab has MTU, minimum links, router ID, AS number, and per link
  end the port's speed and duplex; the device box shows `router-id` and `AS`.
- Example **`consistency-checks.yaml`**: one deliberate inconsistency per
  check.
- Example **`branch-routing.yaml`**: a dual-homed branch with a floating
  static default route, equal-cost routes to HQ, a blackhole, a guest VRF,
  host default gateways and a router-on-a-stick trunk with a native VLAN.
- User Manual section *Static routes and VLAN tagging* with two screenshots;
  README screenshots of route tables and port tagging.
- Tests: `test/analysis.test.mjs`, `test/routes.test.mjs`,
  `test/vlan-tagging.test.mjs` (every route and VLAN check positive and
  negative), and a self-test block for the routes UI, the Routes switch and
  its effect on exports.

- **Relations and links attached to their interfaces.** In the logical view
  every interface a relation is bound to has a **port** beside its row on the
  side of the device box, and every relation starts and ends exactly there,
  found by the interface's id. Several relations on one interface leave its
  port side by side in parallel lanes; a relation bound to the device as a
  whole leaves from a separate, hollow **device-level port** beside the
  device's name. Each port has an **end label** with the interface's name and,
  for a tunnel, the underlay it is sourced from (`src: Gi0/0 203.0.113.1`).
  Routes leave the port on the side facing the peer, never cross another row
  or box, nest so that no route passes another port's stub or end label, and
  go around boxes corner by corner without two routes sharing a corner.
- **Physical view:** a cable to a device as a whole ends in a hollow square;
  the member ports of an aggregate (LAG, port-channel) are kept together and
  drawn in a bracket named by the aggregate; bending cables go around other
  devices together with their ports and port labels.
- **Pointing marks what belongs together:** an interface's row, port and end
  label and every relation and cable attached to it; for a relation or
  cable, the interfaces at its ends. In the diagram, in the Objects list and
  on the endpoints of the Edit tab, which also marks the two ends of a
  selected relation or link and says which port each is drawn from.
- Example **`port-bindings.yaml`**: several tunnel interfaces and
  subinterfaces per router, three relations on one interface, tunnels
  sourced from an interface and from an address, device-level relations, a
  LAG and a three-device relation.
- Legend entries for interface ports, device-level ports, LAG brackets and
  device-level cable ends.
- Tests: `test/ports.test.mjs` checks for every example, every Auto-arrange
  option, after dragging, with labels off and protocols hidden that every
  lane and cable end lies in the port area of the interface it references,
  that no lane crosses a box and no cable another port, and that end labels
  are beside their port and clear of text and lines; the browser self-test
  repeats this with real fonts, in both themes and on the exported SVG, and
  the viewport check at every window size and zoom.

- **Save model** and **Save model as…** replace *Download model…*. *Save
  model as…* saves to a file name and place you choose and links the model
  to that file; *Save model* (Ctrl+S) then updates it without asking (the
  browser may ask once for permission). In browsers without a save picker
  (Firefox, Safari) *Save model as…* says so and downloads a copy, which is
  not linked. *Open model…* through the browser's picker (Chromium-based
  browsers) links the opened file; a file read through a plain file input or
  dropped without a handle is never linked. A cancelled picker, a refused
  permission or a failed write is reported and keeps every change unsaved.
- **Auto-arrange** has three options in the toolbar: **Default** (the
  existing layout), **Compact** (the same arrangement with the empty space
  taken out, group by group) and **Spacious** (spread out by 1.4). All are
  deterministic and idempotent, in complete and filtered views.
- **Every interface is drawn:** ports without a cable as chips in their
  device box (physical view), every loopback and the virtual and tunnel
  interfaces as chips (logical view). Each can be selected.
- **Connecting in the diagram:** right-click a device or an interface, then a
  second one, to open a new physical link (physical view) or logical relation
  (logical view) in the Edit tab with both endpoints filled in; it is created
  only when it is complete and you press *Create*. Compatible endpoints are
  marked; incompatible ones are refused with the reason. Esc cancels. The
  keyboard equivalent is **C** on a selected device or interface and the
  connect bar. A logical interface can take part in several relations; only a
  relation that repeats an existing one is refused.
- The open example is marked in the **File** menu, with whether its model was
  modified.
- A **Help** menu next to **Find**. **User Manual** opens a large dialog with a
  short, task-by-task guide to the basic features (opening or creating a
  model, saving and exporting, the Physical and Logical views, finding and
  filtering, selecting and editing, connecting, Auto-arrange, keyboard
  shortcuts), illustrated with screenshots of the application. **License**
  names the license, the Apache License, Version 2.0, and shows its full text.
  Both are embedded in `netatlas.html` and work offline; they close with ×,
  Close or Esc and return the focus to **Help**.
- **Quick actions in the object list:** the row under the pointer shows
  **Duplicate** and **Delete**, the same actions as in the Edit tab (same
  confirmation, undo, selection and modified state). The row with the
  keyboard focus shows them too, and on touch screens the selected row. Their
  accessible names say the action and the object (*Delete device hq-fw*).
- **Dark and Light themes, Dark by default.** A toggle at the right end of
  the toolbar with a tooltip and an accessible name that say the theme in
  effect and what a press does. The choice is remembered in the browser,
  never in the model, and is in effect before the first paint (no flash of
  the other theme); without a stored choice, or without storage, the theme
  is Dark. The whole application and
  the diagram are drawn from one set of design tokens (WCAG 2.2 AA in both
  themes; dark grey surfaces, off-white text, calmer accent and status
  colours); cable and protocol colours are adjusted per theme so every line
  keeps 3:1 contrast.
- **Exports in the selected theme.** PNG and SVG are drawn in the theme on
  screen. The SVG carries resolved colours and an explicit background (no
  stylesheet, CSS variable or `prefers-color-scheme`), so it looks the same in
  every viewer; the PNG has the same colours on an opaque background.
- **Every address in the diagram.** Each device's box holds an entry per
  interface with its name, addresses (IPv4 then IPv6, secondary and dual
  stack together), VLAN, VRF, DHCP, MAC address, tunnel source and
  destination and member ports, in a monospace font and never shortened.
  Membership lines carry every address of the device in the network; cables
  show their cable id; addresses in `attrs` (VRRP / HSRP virtual addresses,
  router IDs, NAT and peer addresses …) are written next to their device,
  interface, network, cable, relation or group. Auto-arrange reserves the
  room they need.
- **No overlaps, or a note when there are.** A label with no free place next
  to its line takes the nearest free place, tied to it by a dashed leader
  line; an overlap made by moving nodes by hand is reported over the diagram.
- The left panel is titled **Objects** (*Select, duplicate, or delete*), a
  region with that name and a heading for assistive technology; the right
  panel is named *Inspector* for screen readers.
- **The selection in the Edit tab.** The part of the configuration that
  belongs to what is selected (in either view or the object list) is marked
  with a tint, an accent bar and a *▸ Selected* tag, and `aria-current`: the
  object's header, the selected interface's card, or the very field of the
  line that was clicked in the diagram (an address, VLAN, VRF, DHCP, MAC,
  tunnel end, member ports, a network's prefix, a cable id, an attribute).
  It is scrolled into view when off screen (smoothly, unless reduced motion
  is preferred), never moves the focus, and follows edits, undo / redo,
  renames and view switches.
- The example **addressing.yaml**: a router with many interfaces, dual-stack
  and secondary addresses, VLAN subinterfaces, tunnels and long IPv6
  addresses.

### Changed

- The path tracer and the failure analysis use only the protocols a device
  enables (an adjacency forms between devices that both enable its
  protocol); iBGP or eBGP follows from the two local AS numbers; a VRRP
  gateway's active member is the group with the highest `priority`. The
  diagram writes the router ID and the AS number only where they apply, and
  a group's virtual address in its interface's entry (`VRRP 10 10.10.10.1`).
- Every example enables the protocols its devices run.

- **Address arithmetic** compares addresses and prefixes byte by byte (no
  BigInt) where the routing tables and the simulation call it often.

- **`enterprise-wan.yaml`** routes end to end: the firewall's two router
  ports share a transit VLAN (`vlan5`), the firewall and the core switches
  have transit addresses (so their OSPF adjacencies can form), the servers'
  gateway is a VRRP address, and host routes keep the tunnel endpoints on
  the internet uplinks.

- The examples and fixtures use VLAN tagging on their link ends instead of
  per-end network lists. Cable labels no longer list networks (the port
  labels carry the tagging).
- Logical-view routing: a relation whose route has to go around a box turns
  beyond the end labels of the rows it passes (the stubs are nested again with
  the turn the route really makes).
- The File menu scrolls inside a short window a little earlier, so its last
  example is always reachable.

- **A relation is nested in a tunnel's tube only when both are bound to the
  same interfaces.** GRE on a tunnel interface carried over IPsec between the
  WAN ports is drawn from its own ports, and its label says *(over IPsec)*;
  OSPF on the same tunnel interface as GRE is still drawn inside it.
- A physical interface a relation is bound to has an entry in the logical
  view even without an address (its relations attach to it).
- **Auto-arrange** (all three options) leaves room for ports, stubs and end
  labels: rows with ports are taller, and devices, networks and hubs keep
  their ports' reach apart. Logical diagrams get somewhat larger (8–35 % per
  side for the examples); stored positions don't change, but a view arranged
  with an earlier version shows *edited since arranged* until it is arranged
  again.
- A group's kind (e.g. *SITE*) is kept free of labels, like its title.
- DNS chips are a little higher, so their text stays inside at small zoom.

- The **Find & Filter** menu is now called **Find** (also its tooltip and
  accessible name), to save room in the toolbar. *Find in diagram…* and
  *Filter object list…* are unchanged.
- The dashed frames of the **View**, **Auto-arrange** and **Filters** groups
  are clearly visible: their colour has at least 3:1 contrast against the
  toolbar in the light and the dark theme. Same frame and spacing for all
  three.
- While a dialog is open, the page's one-key shortcuts (P, L, A, C, arrows …)
  no longer act on the page behind it.
- The **View** menu (Find in diagram…, Filter object list…) is now called
  **Find & Filter** (also its tooltip and accessible name), so it isn't
  mistaken for the **View** group of Physical / Logical. Its entries,
  shortcuts and behaviour are unchanged.
- The Find & Filter menu (then called View) says what its entries work on: **Find…** is now **Find in
  diagram…** (`/`), **Filter outline…** is now **Filter object list…** (it
  narrows the model outline; the diagram is not changed). Hover texts, the
  Find bar's accessible name and the outline filter's placeholder follow.
- The File menu says *model* in every entry (New model, Open model…, Save
  model, Save model as…, Close model) and uses "…" exactly where input
  follows; the start screen's card is **Open model…**.
- **Modified** is now a comparison with what was opened or last saved: undo
  back to that state clears it. The file name in the status bar shows a small
  dot and says how the model is saved; no button changes its border colour.
- The *Auto-arrange* label sits above its three buttons, and label and buttons
  share a subtle dashed frame; the label stays visible in a narrow toolbar.
- **View** (Physical, Logical) and **Filters** (Devices, Labels, Groups /
  Locations, Networks, Endpoints, Servers and the Filters drop-down) are
  grouped the same way: a label above the controls, in the same dashed
  frame. In a window 400 px high or less the three labels are hidden (they
  remain the groups' accessible names); the frames stay.
- The Auto-arrange option the view on screen is arranged with is selected and
  disabled; the check mark and edit icons are gone. The state is derived
  from the current positions of the complete or filtered view, and the `A`
  key (Default) follows it.
- The **Edit** tab groups each object's fields into titled cards (Identity,
  Placement, Ends, Cable, Addressing, Protocol, Endpoints, Underlay, Notes,
  More); the **Details** tab shows its sections in the same cards.
- The logical view shows every loopback (there was a limit of three), and
  every address of a loopback (it showed the first one and "+N").
- Chips of uncabled ports show their full names; a long run of similar names
  no longer writes the shared prefix once.
- The logical view shows every DNS name of a device (it showed two and
  "+N more names").
- In the logical view a device's box holds its interfaces and DNS names, and
  lines attach to the whole box. Group titles are drawn above the lines, with
  a halo.
- **Compact** keeps room for the port labels on the facing sides of two
  devices side by side, as **Default** does.
- The number in a multipoint hub is written in the text colour (the ring
  keeps the protocol's colour), and the light theme's muted text, selection
  and line colours are a little darker, for WCAG AA contrast.
- The example *device-types.yaml* has six free ports on its access switch.

### Fixed

- In a narrow toolbar, switching off a filter that sits in the **Filters**
  drop-down could move the filter group to another row, after which the
  button no longer counted it (*Filters · 1 off*). The group now keeps room
  for the button's longest label, and the row settles in one pass.
- Physical view: a tagged port's VLAN line no longer overlaps the name of
  the untagged port below it, the ⚠ of a cable whose tagging differs is
  kept clear of other labels, and a cable no longer runs through a device
  when its way around starts at another port of that device.
- In the **View** and **Auto-arrange** groups, a hovered or keyboard-focused
  segment lost part of its border (e.g. the right edge of *Default*): the
  next segment, which shares that border column, was drawn over it. A
  segment whose border changes is now drawn above its neighbours, in every
  state and at every zoom.
- On the start screen, **Labels**, **Groups / Locations** and **Networks**
  were still enabled; now every diagram filter (and the **Filters**
  drop-down) is disabled until a model is open, and shows its default.

## [0.1.2] - 2026-10-02

NetAtlas 0.1.2 is still one self-contained, offline HTML file
(`dist/netatlas.html`) with no third-party code. It reads and writes YAML
model format 1 (`netatlas: 1`).

### Upgrading from 0.1.1

Model format 1 was tightened in this release. Some keys that 0.1.1 accepted
are now rejected, each with an error that says what to write instead;
nothing is converted, guessed or dropped, and a file with errors still opens
as a draft so it can be fixed in the editor:

- a network's `cidr` is **one** prefix (a list, even of one, is an error):
  make one network per prefix;
- a link end's `vlans` is replaced by `networks: [network ids]`;
- a relation's `network` is removed (put a network it runs over in `over`),
  and endpoints lose `role`, `address` and `attrs` (use the relation's
  `attrs`);
- a relation's `directed: true|false` is replaced by
  `direction: bidirectional|unidirectional` (omitted = bidirectional).

The built-in examples are already migrated.

### Added

- **DHCP on interfaces.** Physical, virtual and tunnel interfaces have a
  `dhcp` flag (omitted = `false`) and a **DHCP** switch next to their
  addresses. While it is on, manual addresses can't be entered; turning it
  on for an interface with addresses or DNS names asks first and removes
  them in one undo step. A loopback can't use DHCP, and `dhcp: true` with
  addresses on the same interface is an error that keeps both values. A
  DHCP interface is in no network, because its address isn't known.
- **DNS names on devices.** `dns_names` lists names, each entered once and
  associated with one or more of the device's interfaces (DHCP interfaces
  excluded). Names are checked for host-name syntax, duplicates and unknown
  interfaces; renaming or deleting an interface keeps the associations
  valid. Details, tooltips and **Find…** show them, and the **Logical view**
  writes each name once under its device in a dashed chip (long names wrap,
  more than two end in *+n more names*). They follow Labels and the device
  filters and are part of the logical PNG and SVG exports, whose legend
  calls them *DNS name (as configured, not looked up)*. No DNS record is
  derived.
- **Device-filtered views.** **Devices** at the top right chooses which
  devices the diagram shows. A filtered view shows those devices with the
  cables, relations, networks, groups and protocols relevant to them, is
  auto-arranged for the subset, and keeps its positions only for the
  session (never in the YAML file); *Select all* restores the complete
  diagram with its saved positions. Exports show the filtered view.
- **Endpoints** and **Servers** switches hide the devices of those types,
  on screen and in exports, combined with the Devices selection, without
  changing the model or the saved layout.
- **Groups / Locations** switch in both views: shows or hides group frames
  without moving devices.
- **View menu** next to Export: **Find…** (`/`) opens a Find bar over the
  diagram; **Filter outline…** shows the model outline's filter box.
- **Filters ▾**: in a narrow toolbar the diagram filters stay on one row and
  the switches that don't fit move into a drop-down that says how many of
  them are off.
- **The YAML tab marks the selected object's entry**, found by the object's
  ID in the parsed text, and keeps the YAML tab open while you select.

### Changed

- **Networks have exactly one prefix**, and **link ends carry networks**
  (`networks: [...]` per end) instead of VLAN lists. Carriage is not
  membership; a difference between the two ends is a warning, never
  synchronized, and the "Trunk" wording is gone. Cable labels name the
  networks, and a VLAN interface's *Ports carrying its networks* are derived
  from the link ends.
- **Relations:** endpoints are only what they connect, `over` is the one
  dependency field, and **direction** is a *Bidirectional / Unidirectional*
  switch (unidirectional relations are drawn with an arrow, from the first
  endpoint to the last).
- **Logical view:** devices are clustered by group, with the group's frame
  around them; a network or hub whose devices all lie in one group is placed
  inside its frame. Stored positions are not changed, but a logical view
  that was auto-arranged with 0.1.1 may show *Edited since arranged* until it
  is arranged again.
- **Edit and Details headers:** one design for both tabs: the object's type,
  its problem state (*No problems*, or the number of errors and warnings),
  its name with its ID beside it, and, in Edit, **Duplicate** and **Delete**
  (red) as icon buttons with names and tooltips. Details no longer starts
  with an *id* row.
- **Shorter help** in the editor and the legend; the physical legend shows
  ports and the ⚠ for ends with different networks as symbols. Validation
  messages are unchanged.
- **Mouse & keyboard help** is a foldable box with *Pointer* and *Keyboard*
  groups (folded at first in windows under 560 px of height).
- **The model outline doesn't shift** when something is selected.
- **Bottom bar:** the file name is a badge at its start (shortened when
  long); "everything stays in this page" is gone.
- Narrow editor panels put section buttons (*+ Interface*, *+ Port Range*)
  on a second line instead of past the edge.

### Removed

- The **Underlay** option of the logical view.
- The search box in the toolbar (now **View → Find…**) and the outline
  filter box that was always shown (now **View → Filter outline…**).
- The keys listed under *Upgrading from 0.1.1*.

### Known limitations

- A file that 0.1.1 accepted with the keys above opens with errors and must
  be edited before it can be downloaded without *Download anyway*. The model
  format version stays `netatlas: 1`.
- In a very small window (about 620 px wide, e.g. a 1920×1080 screen at
  300 % zoom) the diagram filters move to a second toolbar row as one group.
- Adding the first DNS name to a device changes its size in the logical
  view; like any such edit, it stores the shown positions in the file's
  `layout` section.
- The automated browser test runs in Chromium-based browsers only.
- See the README's "Limitations" section for the full list.

## [0.1.1] - 2026-09-30

NetAtlas 0.1.1 is still one self-contained, offline HTML file
(`dist/netatlas.html`). It reads and writes YAML model format 1.

### YAML model format 1

Model format 1 ([docs/FORMAT.md](docs/FORMAT.md)) is the only model format
NetAtlas supports. Every file starts with `netatlas: 1`.

* **Strict validation.** A missing `netatlas:` line, any other value, an
  unknown key and the keys listed under
  [Rejected keys and values](docs/FORMAT.md#rejected-keys-and-values) are
  errors, located at the key, each saying what to write instead. Nothing is
  converted, guessed or accepted as an alias. A file with errors opens as a
  draft, keeps everything it contains, and is downloaded only after an
  explicit **Download anyway**.
* **Configure once, derive elsewhere.** Each fact has one place in the file;
  everything that follows from it is shown read-only (marked *derived*) and
  never written back:
  * a network is its `cidr` prefixes (each with a prefix length) and an
    optional `vlan` (1–4094); its **members are derived** from the interface
    and loopback addresses inside a prefix;
  * the **VLAN of an interface address** is derived from the network that
    contains it; networks with different VLANs give an explicit *ambiguous*
    and a warning;
  * `speed` and `medium` are configured on the **link** only;
  * each **link end** lists the VLANs it permits (`vlans`): several are a
    *Trunk*, one is *VLAN n*, none is *No VLAN*; different lists at the two
    ends give a warning and ⚠ on the cable;
  * `vrf` is set on interfaces and loopbacks.
* **Two categories of interfaces.** A device has `interfaces` (physical
  ports, without a type) and `logical_interfaces` (`type: loopback`,
  `virtual` or `tunnel`), with one set of ids per device. Only a physical
  interface can be cabled. An aggregate lists its `members`; a VLAN
  interface names its `vlan`, and the ports carrying it are derived from the
  link ends; a tunnel names its `source` and `destination`.
* **Devices** have `id`, `label`, `type` (one of 15), `group`, `tier`,
  `description`, `attrs` and the two interface lists. Other facts go in
  `attrs`.
* **Groups:** `kind` is free text; `floor` is the kind for a storey.

### Editor

* **Start screen** with three ways to begin: **New model**, **Open YAML
  file…** (also a drop target; a file dropped anywhere on the page is
  opened) and **Load example** (a picker with the six examples). A file that
  can't be opened is reported with the reason and a way back.
* **File menu:** **New model**, **Open model…**, **Download model…**
  (Ctrl+S), **Close model** and **Examples**. *Close model* asks first when
  there are unsaved changes: **Download and close**, **Discard changes** or
  **Cancel**.
* **Interfaces** are edited in two sections, *Physical interfaces* and
  *Logical interfaces*, with **+ Interface**, **+ Port Range**,
  **+ Loopback**, **+ Virtual** and **+ Tunnel**. **+ Port Range** creates
  a numbered range of ports (`ge 1/1` … `ge 1/24`) in one undoable step,
  with a preview; invalid ranges are rejected as a whole with the reason.
* Interfaces are listed alphabetically (digits by value) in the editor,
  the details and the pickers; the order in the file is not changed.
* VLAN pickers per link end; derived values are marked *derived* and can't
  be edited.
* The model outline's sections fold (*Collapse all* / *Expand all*); a
  folded section still shows its count, problems and related entries.
* The model's title and description are edited with **Edit model
  settings** in the Edit tab. The model panel is always visible and adapts
  to narrow windows.

### Diagrams and Auto-arrange

* **Sized for their text.** Labels wrap and nothing is shortened with "…";
  boxes, network pills, group titles and relation labels grow to fit, and
  networks show all their prefixes.
* **Readable cabling.** Ports that face each other are lined up, cables bend
  around devices instead of crossing them, and every cable with a speed,
  VLANs or a label shows it. Cable, relation and address labels avoid nodes
  and each other.
* **Groups are placed by their cabling** in the physical view.
* **Auto-arrange works on the view on screen only.** If that view has
  positions set by hand, a confirmation names what moves; Cancel changes
  nothing. The button shows the view's layout status (✓ auto-arranged,
  ✎ manually adjusted, ● edited since arranged).
* Selecting a logical interface highlights the ports it uses and their
  cables; selecting a port highlights the logical interfaces that use it.

### Export

* **Export → Export view as… → PNG / SVG.** Both formats save the selected
  view (Physical or Logical) as the same picture: the whole diagram
  whatever the zoom, full labels, the legend and a **Networks overview**
  that lists the networks relevant to that view, with a margin. Files are
  named `<model>-<view>.png` / `.svg`. The PNG is drawn at twice the
  diagram's size (less for very large diagrams). A failed export is
  reported in a dialog and nothing is downloaded.
* The submenu opens by click, tap, Enter, Space or arrow right, never on
  hover; arrow left or Esc closes it.

### Fixed

* The application fits the browser viewport: in a window that isn't
  maximized the page no longer gets a scrollbar of its own, and the
  right-hand panel no longer extends below the status bar. Long forms and
  lists scroll inside their panels.

### Known limitations

* **YAML:** not full YAML (anchors, aliases and multi-line plain scalars
  are rejected); formatting is normalised on export, comments and key
  order are kept.
* **Saving** always downloads a new file; a web page can't overwrite the
  file it opened.
* **Auto-arrange** is heuristic: dense meshes still cross, and relation
  lines are straight.
* **Network semantics** are only partly checked; membership is by address
  only (VRFs don't separate address spaces).
* **Logical interfaces** have three kinds of association: member ports, a
  VLAN, and a tunnel's source and destination.
* **Very large diagrams** may exceed what a browser can draw as one PNG;
  the SVG export has no such limit.
* **Browsers:** diagram elements aren't individually keyboard-focusable;
  the automated browser test runs in Chromium-based browsers only; Firefox
  and Safari are covered by the manual `#selftest` check.
* See the README's "Limitations" section for details.

## [0.1.0] - 2026-09-29

First release: a usable initial version, not a complete one.

### What it does

* **One self-contained HTML file** (`dist/netatlas.html`, about 0.5 MB):
  * opens directly from disk (`file://`) in Chrome, Edge, Firefox or Safari;
  * no server, no network access (enforced by a Content-Security-Policy with
    `default-src 'none'`), no external assets, no third-party runtime code.
* **YAML model** (format version 1, [docs/FORMAT.md](docs/FORMAT.md)):
  * devices with interfaces, links (physical cabling), networks and logical
    relations;
  * groups (sites, rooms, racks …) and custom protocol definitions;
  * a documented, safe YAML subset
    ([docs/YAML-SUBSET.md](docs/YAML-SUBSET.md)) with line-precise error
    messages and suggestions.
* **Physical view:**
  * devices with ports and interface names;
  * cables by medium and speed;
  * nested location boxes.
* **Logical view:**
  * networks, routing adjacencies, overlays, redundancy groups and services;
  * tunnels drawn as hollow tubes, with nesting (e.g. OSPF over GRE over
    IPsec);
  * multipoint hubs and loopback chips.
* **Loopbacks:**
  * multiple IPv4/IPv6 loopbacks per device, with strict address checks;
  * `router_id` pointing at a loopback.
* **Device types:** 15 types, each with its own icon and display name:
  * router, switch, firewall, ap, server, vm, container, storage;
  * load_balancer, proxy, ids_ips, gateway, endpoint, cloud, system.
* **Editor:**
  * create, edit, duplicate and delete every element;
  * rename ids with all references updated;
  * protocol-specific attributes as an editable tree;
  * a raw YAML tab;
  * undo/redo;
  * validation as you type, with errors shown at the field.
* **No implicit defaults:** new elements get only an id. Type, kind,
  protocol and category stay unset until you choose them.
* **Round trip:** export and reload keep comments, key order, unknown keys and
  attributes no view shows. Invalid models are only exported after an
  explicit "Download anyway".
* **Positions:**
  * drag devices and networks; positions are stored in the model's `layout:`
    section;
  * deterministic **Auto-arrange** for either or both views;
  * a per-view status: *Auto-arranged* / *Manually adjusted* / *Edited since
    arranged*.
* **Selection and navigation:**
  * selecting an element highlights related elements in the diagram and marks
    the directly related entries in the element lists;
  * search and SVG export.

### Known limitations

* **YAML:**
  * not full YAML: anchors, aliases and multi-line plain scalars are
    rejected;
  * formatting (indentation, flow spacing) is normalised on export; comments
    and key order are kept.
* **Saving** always downloads a new file; a web page can't overwrite the file
  it opened.
* **Auto-arrange** is heuristic: dense meshes still cross, and lines are
  straight, not orthogonally routed.
* **Network semantics** are only partly checked: addresses, duplicates and
  prefix membership are checked; routing and VLAN consistency are not.
* **Browsers:**
  * the element lists are hidden in windows narrower than 1100 px;
  * diagram elements aren't individually keyboard-focusable;
  * the automated browser test runs in Chromium-based browsers only; Firefox
    and Safari are covered by the manual `#selftest` check.
* See the README's "Limitations" section for details.

[0.1.2]: https://github.com/hafnerst/netatlas/releases/tag/v0.1.2
[0.1.1]: https://github.com/hafnerst/netatlas/releases/tag/v0.1.1
[0.1.0]: https://github.com/hafnerst/netatlas/releases/tag/v0.1.0

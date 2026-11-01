# NetAtlas architecture

NetAtlas is a TypeScript application built into one self-contained HTML
file (`dist/netatlas.html`). The source in `src/` is organised in layers.
Each layer has one responsibility and may only import the layers below it.
`test/architecture.test.mjs` enforces this.

## Layers

| Layer | Responsibility | Main modules |
|---|---|---|
| `model/` | The network model: types for devices, their physical and logical interfaces (loopback, virtual, tunnel) with the associations of each kind, links, networks, relations, protocols and groups; the display order of names (`order.ts`); the protocol registry; the **network services** (`netservices.ts`: the server types that run DHCP and DNS, the default lease, address ranges, the records a zone derives from the model's DNS names); the **simulation profiles** of the protocols (`sim-profiles.ts`: messages, transport — between peers `ports` (both from and to the protocol's port, or each from its own ephemeral port) and a fixed `ttl` —, timers with their defaults and sources, states, failure and restore, the ARP / NDP / MAC table defaults); the **routing services registry** (`services.ts`: each protocol a device can enable, its parameters with type, scope, validation and suggestions, its use of the router ID, and the readers of a device's enabled protocols); IP addresses; DNS-name syntax; the **device filter** (the part of a model relevant to some devices, as a self-consistent sub-model); **derived facts** (network members and interface VLANs from addresses and each network's one prefix, the VLANs and networks a cable carries at each end from the tagging of its ends and how the ends differ, which interfaces own an address); the **device types' routing roles** and a switch's layer (`deviceRoutingRole`: a Layer 2 switch is a host, a Layer 3 switch a router); pure queries (references, related objects, search); a model's **fingerprint** for the freshness of analysis results (`fingerprint.ts`: what an analysis reads, without positions and line numbers); the **rules for connecting two endpoints** in a diagram (which endpoints and pairs are compatible, when a relation repeats an existing one); **which addresses and identifiers the diagrams write out, for which object and in which view** (the entries of an interface, a device's route tables, address-like attrs, the inventory the tests compare with the drawing). No I/O, no YAML, no layout. | `types.ts`, `device-types.ts`, `protocols.ts`, `sim-profiles.ts`, `services.ts`, `ip.ts`, `dns.ts`, `filter.ts`, `collapse.ts` (a group drawn as one box, its connections to the box), `derive.ts`, `queries.ts`, `order.ts`, `connect.ts`, `addresses.ts`, `routing-policy.ts`, `net-policy.ts`, `experiments.ts`, `views.ts`, `bulk-ports.ts` (a bulk port edit's plan: the preview), `support-catalog.ts` (what each analysis does and does not; docs/SUPPORT.md is generated from it) |
| `analysis/` | **All network logic**, pure and DOM-free, on the typed `Model`: address arithmetic for IPv4 and IPv6 (`ipmath.ts`: integers, canonical text, prefix ranges, sizes, free ranges); routing (`routing.ts`: connected networks, per-VRF tables, longest-prefix match, distance, metric, equal-cost multipath, recursive next hops, the routes learned over routing adjacencies, the hook for what is down); the **path tracer** (`trace.ts`: hop-by-hop forwarding with next-hop owners and VRRP, layer-2 ways through switches by VLAN, tunnels with their encapsulation stack and underlay (each equal-cost alternative of the outer packet a branch of the path, decided by the outer packet's own protocol and port), equal-cost branches, stop reasons, the return path, the text form); the **routing identity** (`identity.ts`: the virtual gateway addresses of the redundancy groups, protocol domains, the protocols a device should enable); the checks of the routing services (`checks-services.ts`); **failure impact** (`failure.ts`: propagation of failed devices, ports, cables and relations through interfaces, LAGs, `over` chains, redundancy groups, networks and static routes; the routing context the tracer reads; device pairs that lose reachability; single points of failure); **simulated traffic** (`traffic.ts`, for the protocol simulation: the flows a state implies, control traffic per protocol and demands traced with equal-cost splitting, each with its drawn lines in both views and the cables' direction; the changes between two states); the **consistency checks** (`checks.ts`: a registry of checks with stable ids, severities and the fields they read, the checks of routes and VLAN tagging, and the run that returns findings with a model's `checks:` settings applied; `checks-more.ts`: the checks of MTU, speed and duplex, aggregates, addressing, router IDs and MACs, OSPF, BGP, tunnels and VRFs). Focus mode's **neighbourhood** (`focus.ts`): the devices within N hops along cables or relations. The **addressing overview** (`addressing.ts`): networks per VRF as a supernet tree with members, gateways, use, free ranges and the next free address; duplicates, overlaps and addresses in no network. The **protocol simulation** (`sim/`): the simulated network built from the model (`net.ts`: bridges and routers, bridge ports with their VLANs from the link ends' tagging, layer-3 interfaces with their MACs, the spanning tree per VLAN), MAC addresses (`mac.ts`: canonical text, generated MACs from a fixed seed, multicast and virtual MACs, the seeded random), the parameters (`params.ts`: the registry of the Layer 1–4 parameters and the simulation attributes, each with its level (device, interface, VLAN, relation, service), defaults, ranges and sources, and the one resolver of the order of precedence, configured → object → device → simulation → default; `attrs.ts`: which attributes a device and each of its interfaces, VLANs and relations has), the discrete-event engine (`engine.ts`: frames over cables with latency, serialization and loss, carrier detection and link-up delay (a fresh start brings every cable up after it), wireless association, the waits for preconditions (a tunnel up, a route there: held, logged with their reason, released together when the condition holds), the seeded jitter of starts and timers, network events (failures, flapping, shut, power), MAC learning and flooding, the spanning tree and broadcast storms where it is off, storm control, broadcast domains, ARP and neighbour discovery with their tables and timers, forwarding with MAC rewrite and TTL, MTU, fragmentation and reassembly, ICMP errors, broadcasts, tunnels, failures, the event log, the dots in flight and each frame's headers for the packet inspector), the sessions and their behaviours (`protocols.ts`, `proto-routing.ts`, `proto-other.ts`; each starts when its interface is up, scheduled by its dependencies only, never by protocol or device order), Layer 4 (`transport.ts`: ICMP echo and the errors a sender receives, path MTU, TCP and UDP, listening ports, tests and test traffic, load balancers, proxies, monitoring probes, firewall policy and sessions — a written rule base also for the packets of relations and tunnels through it, and for IP protocols without ports, tracked by address pair and IP protocol number; a protocol session's listener binds a connection at accept when its SYN came from that session (`Conn.synApp`); the retransmission timeout from the measured round trip, RFC 6298; work a device scheduled is dropped when it was power-cycled meanwhile, `Engine.powerEpoch`), multicast (`multicast.ts`: IGMP / MLD queriers and membership, snooping, PIM sparse, SSM and dense mode with the RPF check, streams, joins and their events, the multicast tables), the applications (`apps.ts`: Start application and the applications that start with the simulation — each once its device is operational —, the runs with a bounded history of finished ones, one outcome per original message, Stop; `mqtt.ts`: MQTT 3.1.1 clients and broker over the one TCP, one publication schedule per run across reconnections, packet identifiers per side, a bounded record of each publication and, for those that age out, their run's tally by topic — settled outcomes counted, unsettled ones unavailable), time (`ntp.ts`, `ptp.ts`), IPv6 host configuration (`ipv6.ts`), RIP's tables (`rip.ts`), the non-IP illustrative data (`opaque.ts`), DHCP and DNS (`netsvc.ts`: the clients' DORA through relays, leases with renew, rebind and expiry applied to the routing context, retries and the link-local fallback; the resolver with its cache, the servers' zones and forwarders; the lease, zone and cache tables), every message's sender and origin (the engine: a reply, an error or a forwarded copy carries the origin of what it answers), the senders that generate the optional test traffic, the pacing of what is shown (`pacing.ts`: each hop's display time — in Readable from `travel.ts`, the one mapping of a hop's modelled traversal cost, its wire time or a relation lane's underlay estimate, onto 3–5 s on a log scale of the model's own cables, a line drawn in two halves one traversal, no cost 4 s; presentation only —, Readable or Proportional, the speed, skipping idle time, Follow message and Step, a Send test drawn first; **the barrier**: in Readable and Proportional pacing the pacer sets `Engine.hold`, and `runUntil` stops before a delivery whose dot is still on its way on screen — a queued delivery carries the flights that bring it (its cable's dot, the logical view's network line or relation lane, an opaque hop's last dot) — and leaves it and everything after it pending, event by event within a moment, so the engine is never ahead of a dot it is waited for and never reorders anything; each flight carries its delivery's lifecycle (`Flight.due`: deliveries still queued, `delivered`: one processed — set by `Engine.at` with gates and by the event's execution), so at the engine's own time a processed delivery is told from a pending one without comparing times; whether a hop is waited for is decided when it is taken in (shown: in the view on screen, of a protocol and sender shown, and drawn in the scene — the controller asks whether the scene has its track, so a filter, a collapsed group or IP / Non-IP takes the hold away; not the muted background, not a stream's flow but its example datagram, not the model's illustrative non-IP data, never in Real time); the steady state (a kind of scenario message drawn before, since the presentation's epoch last moved: `Simulation.presentationEpoch` counts the Network events and every successful change from outside — failures, restores, power, shut, flapping started from outside and its transitions, joins, streams — never packets) is cable activity and not waited for; a change of what is shown (and a scene whose tracks changed) goes through `reshow`; a frame's budget is asked within a moment too (`runUntil`'s `yieldNow`: the rest of a large moment stays queued in its order); `Engine.run` (tests, runTo, an experiment's result) never waits; nothing it does changes what happens; the browser's loop starts the clock with the first frame drawn and caps a frame at 100 ms), and the facade the UI uses (`simulation.ts`). The multicast consistency checks are in `checks-multicast.ts`, those of DHCP clients and relays in `checks-netservices.ts`. Deterministic: results are sorted by values, never by the order of the file; the simulation's timeline depends only on the model and the actions. **Network policy** (`policy.ts`): one ordered rule engine — a router's or Layer 3 switch's ACL, a firewall's explicit rule base, or its implicit policy (the relations through it and its allow list) — evaluated alike by the path tracer, the communication checks and the simulation's transport and forwarding; a rule's device or interface is its effective addresses there (`PolicyIds`: the configured model's, with runtime addresses unknown and undecided; a snapshot's or the simulation's acquired ones), checked against the address's owner from the forwarding context (the tracer's traced ends and the holder on the segment a hop reaches; the simulation's `Engine.ownerSeenFrom`: each next hop continued in the VRF of the interface it was reached on — `holderOnSegment` gives the device and that interface —, a device on the way the owner only when it has the address in the VRF walked, every equal-cost next hop followed, the packet's own next hop first — its gateway, not only its interface) — an address several devices have, its owner unknown, is undecided; an undecided decision carries what it lacks (`undecidedBy`), recorded on the trace's hops (`HopWhy.policyUndecided`) and read by the communication check, never inferred from text. The **routing policy** subset (`model/routing-policy.ts` for its rules; `routing.ts computeDynamic`, one iterative propagation with routing domains, origins, AS paths and local preference) is the one routing computation for Analyze and Simulate. **Architecture validation** on top of these: the **result semantics** every Analyze tool shares (`result.ts`: the verdicts satisfied, violated, partial, beyond, indeterminate and unsupported, the analysis context (configured model or snapshot, scope), coverage, assumptions and limits, the export header); a **simulation snapshot** for analysis (`snapshot.ts`: a frozen routing context and the acquired addresses with their method and state, taken by `Engine.analysisSnapshot`); the **communication check** (`communication.ts`: application, client and service ends, the layers address, name, path, policy, listener and runtime, the MQTT subscriber legs, the reverse direction, the simulation handoff), with the static **name resolution** (`names.ts`: the DNS servers' zones and forwarders, a host's resolvers; the simulation's DNS server answers from the same `zoneRecords`) and the **listening ports** (`sim/transport.ts deviceListening`: one definition for the simulation and the static check; `listeners.ts namedServices`); the **scope** of addresses (`scope.ts`: switched segments, connected parts of the architecture); the **service dependencies** and their comparison under a failure (`dependencies.ts`), the **timing source paths** (`timing.ts`: PTP over segments and boundary clocks, NTP upstreams), the **what-if** of a failure condition (`whatif.ts`), failure domains, scoped device pairs and per-candidate structural impact (`failure.ts`); the **saved expectations' evaluation** (`expectations.ts`); the **findings' presentation** (`findings.ts`: class, consequence, next step, groups by a shared field); contextual focus (`focus.ts`: VLAN, dependencies, multicast, timing, VRF; `navigationIndex` for Find → Applications, VLANs and VRFs). The **communication identity** (`comm-identity.ts`: the bindings a check chose — source interface, family, destination, port — the handoff to Send network packets with what is carried and what is not, which send carries a check (`runMatches`: its plan, and each message as sent — a host name's family included) and whether an application's run is a question's communication (`appRunProblem`), the comparison of a static result with a simulation run from recorded state only). **Path MTU** (`mtu.ts`: every evaluated path and branch, nested encapsulation). **Capacity** (`capacity.ts`: stated traffic against stated capacity, before and after a failure, without assuming how multipath spreads; per direction on a full-duplex cable, the answer sizes of the responding listener, one MQTT publication per topic; an application's transfer traced between its resolved ends — `communication.ts appAddress`, `applications.ts appFamily`, the client's own source `communication.ts egressSource` (the simulation's routed source choice, statically) — in the state traced). **Execution scopes** (`exec-scope.ts`: what a simulation runs — a communication's paths, a dependency slice, a group, a VLAN, a failure domain — closed over what it needs, its boundary, and the sub-model it runs). **Experiments** (`sim/experiment.ts`: a runner of a saved experiment from a clean start on scenario time, in slices, its observations and the comparison of two runs). | `ipmath.ts`, `routing.ts`, `identity.ts`, `trace.ts`, `failure.ts`, `traffic.ts`, `checks-services.ts`, `checks.ts`, `checks-more.ts`, `checks-multicast.ts`, `checks-netservices.ts`, `addressing.ts`, `focus.ts`, `result.ts`, `snapshot.ts`, `communication.ts`, `names.ts`, `scope.ts`, `dependencies.ts`, `timing.ts`, `whatif.ts`, `expectations.ts`, `findings.ts`, `policy.ts`, `comm-identity.ts`, `mtu.ts`, `capacity.ts`, `exec-scope.ts`, `sim/*.ts` |
| `yaml/` | The YAML boundary: the supported YAML subset (parser with line/column positions, comments and styles), the serializer (the inverse), and the format **schema** (which keys exist, in canonical order). Knows nothing about networks beyond key names. | `parse.ts`, `write.ts`, `schema.ts` |
| `validation/` | Turns a parsed YAML tree into a `Model` plus errors and warnings. Every issue is attached to the YAML node it concerns. Structural and cross-reference checks, loopback/IP rules, static routes and link-end tagging, the presentation-only `layout` section, the simulation blocks of devices, interfaces, VLANs, relations, scopes and zones at their levels (`simulation.ts`), a server's DHCP and DNS services, relays and DNS servers (`netservices.ts`), the analysis sections `failure_domains` and `expectations` (`expectations.ts`), network policies (`policy.ts`), saved experiments (`experiments.ts`) and saved views (`views.ts`). Then it runs the consistency checks of `analysis/` on the model and attaches each finding to the entry and field it is about. Callable without any UI. | `validate.ts` (the format's rules), `simulation.ts`, `netservices.ts`, `expectations.ts`, `policy.ts`, `experiments.ts`, `views.ts`, `reader.ts` (issue collector, typed reader, suggestions) |
| `layout/` | Deterministic positions for both views: a canonical, order-independent input built from the model; auto-arrange for the physical and the logical view, and the strategies built on it (Default, Compact, Structured, with the orthogonal routing of `orthogonal.ts`); placement of new nodes; the rule "stored positions else auto-arrange". Separates calculated positions from network semantics. | `input.ts`, `physical.ts`, `logical.ts`, `positions.ts`, `strategies.ts`, `text.ts` (width estimate, wrapping), `sizes.ts` (element sizes from their text, including the rows and end labels of ports), `bundles.ts` (the strands of a device pair, grouped by the interfaces they are bound to, with their lanes and labels; the room each port needs), `geometry.ts`, `order.ts` |
| `diagram/` | Presentation: turns model + positions into a virtual SVG tree (`VNode`) for each view, and holds the DOM-free view state (current view, selection, filters, temporary drag positions). Uses `analysis/` for what it shows of the network's behaviour (where a route's next hop is). No parsing, no editing rules, no DOM. | `session.ts`, `physical.ts`, `logical.ts`, `logical-ports.ts` (the ports of the logical view: rows, sides, stacking, stubs and routes), `legend.ts` (the legend as data, and its SVG form for exports), `networks-box.ts` (the networks relevant to a rendered view, and their overview box for exports), `labels.ts` (multi-line text, collision-free label placement with leader lines), `palette.ts` (the colours of the model drawn per theme, WCAG contrast), `scene.ts`, `style.ts`, `icons.ts` |
| `editor/` | The editable document (`ModelDoc`): the YAML tree plus undo/redo, dirty state, validation after every change, and **explicit editing operations** (set a field, append to a list, point an endpoint at an interface, switch DHCP on or off for an interface, add or remove a DNS name, rename an id with all references, add a physical or logical interface, arrange one view, move a node, …). Also the layout section and the layout status, and where an object's entry is in a YAML text (`yaml-block.ts`, found through the parsed structure). | `document.ts`, `tree.ts`, `layout-section.ts`, `yaml-block.ts` |
| `ui/` | The browser: application shell, canvas interaction (selection, dragging, connecting endpoints), inspector forms and outline, side panels, dialogs, the **workspaces** (`workspace.ts`: Edit, Simulate, Experiments and Analyze share one frame, the left, right and bottom panels around the diagram, one body per workspace in each, one workspace at a time; `app.ts` owns the lifecycle: entering asks before ending running work, Analyze over a simulation pauses it and reads a snapshot, exit restores the editing panels and clears the overlays, loading another model clears every result and pending job through a model generation that late callbacks check), the Experiments workspace's panels (`experiments.ts`: the list, identity, start, scope and sequence; the selected step's configuration; run controls, the pre-run summary, progress, what the run waits for, verdicts and comparison; `duration-input.ts`: the number-and-unit control of every duration, its unit only shown, one canonical value written), an experiment played through the simulation controller (`sim-controller.ts` with the experiment's simulation and its relevance filter: only its traffic drawn, nothing muted, its clock stopping at the end and resting at its notable moments), the **tool windows** for what is not a workspace (`toolwindow.ts`: Saved views and the like; one non-modal window at a time, moved, resized, folded, docked at the bottom in narrow windows, its geometry in local storage; F6 moves between it and the page's regions), the Addressing overview's table and CSV (`addressing.ts`), Trace path's form and hop tables (`trace.ts`), the Focus controls (`focus-window.ts`), the Single points of failure table with sorting, filtering, CSV and text, the progressive service impact, the what-if and the failure domains (`spof.ts`), the Design checks window (`design-checks.ts`: saved expectations, their form, the grouped findings), the parts every Analyze window shares (`analysis-ui.ts`: the context line with Outdated and Refresh, the configured model / snapshot choice, verdict lines and chips, assumptions and limits), the simulation mode's interface (`simulation-mode.ts`: banner text, marker, the failed state), the **protocol simulation** on screen (`sim-controller.ts`: the display clock, the simulation layout's three panels (setup, actions, the docked simulation panel), the in-diagram menus and the same events in the Actions panel; `sim-protocols-ui.ts`: the grouped protocol checkboxes of the Start dialog and the setup; `sim-senders-ui.ts`: the Senders section (summary, filter, quick actions, the checklist by type or group / site); `sim-params-ui.ts`: the parameter sections of the start dialog and the setup; `sim-anim.ts`: the labelled dots as the pacing places them, the arrival pulse, the trail, the sender and receiver marks, and the still picture for exports and reduced motion; `sim-labels.ts`: where labels go, pure; `sim-tables.ts`: the device tables in the simulation panel and the packet inspector), the side panel's splitter (`splitter.ts`), the **command registry** that drives the menus, the keyboard shortcuts and the command palette (`commands.ts`, `palette.ts`), the Help menu's manual and license (`help.ts`), the examples it can load (`examples.ts`: the public catalog, and the internal examples only the test build registers), local files (reading, writing through a file handle the user chose, download), and the only code that creates DOM elements (`dom.ts`). Uses the editor's operations and never builds YAML itself. | `app.ts`, `inspector.ts`, `panels.ts`, `dialogs.ts`, `help.ts`, `files.ts`, `dom.ts`, `theme.ts` (Light / Dark, Dark by default), `export-style.ts` (resolved colours for exports) |
| `app/` | The two entry points: `main.ts` for the released application (`dist/netatlas.html`: the public examples; `#selftest` runs its own self-test, `public-selftest.ts`) and `main-test.ts` for the test build (`build/netatlas-test.html`: it also registers the internal examples and runs the full in-browser self-test, `#selftest`, and the viewport check, `#viewportcheck`). Both start the application through `boot.ts`. Checks shared by the self-tests: what is wrong with a drawn diagram (`drawn-check.ts`) and whether the Objects list's headings stand still (`outline-check.ts`). | `main.ts`, `main-test.ts`, `boot.ts`, `public-selftest.ts`, `selftest.ts`, `viewport-check.ts`, `drawn-check.ts`, `outline-check.ts` |
| `generated/` | Built from `examples/*.yaml` (the public catalog) and from `test/examples/*.yaml` and `test/fixtures/*.yaml` (the internal test examples and fixtures, imported by the test build only) by `scripts/gen-examples.mjs`, and from `LICENSE` and `docs/img/manual/*.webp` by `scripts/gen-help.mjs` (the license text and the manual's screenshots as `data:` URLs); do not edit. | `examples.ts`, `test-examples.ts`, `help-assets.ts` |

## Allowed dependencies

```
            app ──────────────────────────────────────────────┐
             │                                                  │
            ui ───────────┬──────────────┬─────────┐            │
             │            │              │         │            │
          editor ──┐   diagram ──┐       │         │            │
             │     │      │      │       │         │            │
             │     │      └──► layout ◄──┘         │            │
             │     │             │                 │            │
             │     └──────► validation             │            │
             │                 │    │              │            │
             └───────────► yaml ◄───┘              │            │
                                                   ▼            ▼
             analysis  (imported by validation, diagram, editor, ui, app)
                                                   │
                              model  (imported by every layer except yaml)
```

| Layer | May import |
|---|---|
| `model` | — |
| `yaml` | — |
| `analysis` | `model` |
| `validation` | `model`, `yaml`, `analysis` |
| `layout` | `model` |
| `diagram` | `model`, `layout`, `analysis` |
| `editor` | `model`, `yaml`, `validation`, `layout`, `analysis` |
| `ui` | `model`, `validation`, `layout`, `diagram`, `editor`, `analysis`, `generated` |
| `app` | everything |

`diagram/`, `layout/` and `ui/` never import `yaml/`. There are no
third-party modules at all; imports must be relative, and the build refuses
anything else.

## Design decisions and trade-offs

* **The YAML tree is the document.** Editing changes the parsed tree in
  place, and export serializes that tree. This is what preserves comments,
  key order, quoting, unknown keys and attributes that no view shows.
  The typed `Model` is *derived* from the tree after every change, by
  validation, and is used for drawing and checks.
  *Trade-off:* editing operations work on paths into the tree rather than on
  typed objects. The UI still never constructs YAML: it calls `ModelDoc`
  operations and only reads the tree through the `DocNode` alias.
* **One format schema.** `yaml/schema.ts` lists the keys of every mapping
  kind in canonical order. Validation (unknown keys), the editor (where new
  keys go) and the inspector ("other properties") all use it. Any other key
  is an "unknown key" error with the closest known key as a suggestion; it is
  never read or converted, and the file keeps it. There is no compatibility
  layer for earlier development versions of the format.
* **Configured versus derived.** A fact is stored in one place in the YAML
  tree. Whatever follows from it is computed by `model/derive.ts` from the
  typed `Model` (cached per model object, and a new model is built after
  every edit), and is only ever displayed: network members, the VLAN of an
  interface address, the difference between the networks of a link's two ends, the ports carrying a VLAN interface's networks. No
  editing operation writes a derived value, so it can't go stale or
  contradict its source. The typed `Network` has no member list and the
  typed `Interface` no VLAN, so nothing can read a stored copy by mistake.
  Membership (IP containment, derived), port VLANs (layer-2 carriage,
  configured per port or aggregate, by VLAN ID; the networks a cable
  carries and a VLAN interface's bridge ports are derived from them) and a
  relation's `over` (its underlay, configured) are separate facts; none is
  derived from another.
  *Trade-off:* membership is recomputed for the whole model after each edit
  (addresses × networks); that is well inside the time validation already
  takes.
* **Interfaces are flat, in two lists.** `Device.interfaces` holds the
  physical interfaces and `Device.logical` the loopback, virtual and tunnel
  interfaces; nothing is nested and there is no generic parent. Both lists
  share the per-device id namespace, so `index.interfaces` and
  `device:interface` references are flat too. An association is a field of
  the kind of interface it belongs to (`members`, `vlan`, `source`,
  `destination`) or is derived in `model/derive.ts` (`interfaceVlans`,
  `interfaceNetworkPorts`, `associatedInterfaces`): the ports of a VLAN
  interface come from the link ends and are never stored. The editor
  addresses an interface by its document path (`interfaceEntries()`).
* **Virtualization is derived, never stored twice.** A guest names its
  `host`; everything else follows from that and the host's services:
  `model/virtual.ts` answers what runs where (guests, port groups, a vnic's
  virtual switch, a veth's network, the derived bridge interfaces) and is
  read by validation (`validation/virtual.ts`), the checks
  (`analysis/checks-virtual.ts`), the related objects and Find. The
  physical view nests a host's interior (`layout/virtual.ts` for its
  geometry, `diagram/virtual.ts` to draw it) inside the host's box, so the
  layout positions hosts only; the logical view adds each bridge or overlay
  network as a network scoped to its host (`withVirtualNetworks`, a view
  of the model, never the model itself). The path tracer resolves where an
  interface meets the cables (`analysis/trace-virtual.ts`); the protocol
  simulation expands the virtual switches and container networks into
  bridges and virtual links (`analysis/sim/net.ts expandVirtual`), so the
  engine forwards, fails over and restarts with the machinery it has.
* **Display order is not file order.** `model/order.ts` sorts names for
  display (editor cards, details, loopback chips, the networks box). The
  lists in the model and in the YAML tree keep the file's order, so viewing
  can't rewrite a file.
* **Themes are tokens; exports carry values.** Every colour of the
  application is a CSS custom property, defined once per theme (`:root`
  and `:root[data-theme="dark"]` hold the dark ones, the default;
  `:root[data-theme="light"]` the light ones). `ui/theme.ts` sets
  `data-theme` on `<html>`, so a switch repaints without re-laying out
  anything; the bundle runs in `<head>` and sets it before the body is
  parsed, so a stored Light theme is in effect at the first paint. Colours that come from the model (media,
  protocols) are attributes of the scene; `ui/dom.ts` passes them through
  `diagram/palette.ts` for the theme in effect when it creates the elements.
  An export clones the scene into the page, reads the styles the browser
  computed for it and writes them as plain attributes, then drops the
  stylesheet: the file shows the theme on screen in any viewer.
  *Trade-off:* the export needs the DOM (it can't be produced in Node), and
  its file carries every resolved value instead of shared rules.
* **One layer scale.** Every `z-index` of the stylesheet is a token of
  one scale in `:root` (diagram < overlays < panels < toolbar < menus /
  popovers < tooltips < dialogs < announcements); only small local orders
  inside a component are numbers. The page's regions (the top bar, the
  canvas, the simulation panel) are container-query containers, and
  `container-type` makes each a stacking context, so a z-index counts only
  inside its region: each region is therefore given its layer on the scale
  itself. `test/zorder.test.mjs` checks the scale and, with
  `elementFromPoint`, that every menu is on top during a simulation.
* **Exports describe the rendered scene.** The legend and the networks box
  of an SVG export are computed from the model *and* the scene that was
  rendered (`sceneRefs`), so they list what the picture shows, including the
  effect of filters.
* **A filtered view is a filtered model.** Showing some devices builds a
  sub-model (`model/filter.ts`) with its own index and no reference to
  anything left out, and the session draws that instead of the complete
  model. Renderers, legend, networks overview and export need no notion of a
  filter, and the relevance rules live in one place. Its positions are the
  auto-arranged layout of the sub-model plus the user's moves, kept per view
  in the session (`diagram/session.ts`) and never handed to the document,
  so the YAML file can only ever hold the complete diagrams' layout.
  *Trade-off:* the sub-model is rebuilt after every edit while a filter is
  active (cheap: it is a selection plus a new index).
* **The simulation is one causally connected stack.** What a higher layer
  shows rests on what the layers below did, at the moment it happened:
  - *Layers 1–2 per hop.* A frame's arrival at a device is an event of its
    own: the device decides then, with its state then (`engine.ts`).
  - *Routing is learned, per instance.* Each router keeps one database per
    routing instance — a protocol in a VRF — with one record per origin
    (that origin's adjacencies of the instance and its interfaces, with a
    sequence number; `protocols.ts`); a record travels only in that
    protocol's advertisements, over that instance's sessions, and is taken
    only when the protocol's state machine allows it (`Behaviour.learns`).
    RIP keeps its own distance-vector tables instead (`rip.ts`), which the
    route computation takes as they are (`RoutingCtx.dv`). A router
    computes its routes from what it has, after its route recomputation
    delay. `RoutingCtx.at` gives every router its own state, so a lookup at
    a router uses its installed routes — in the simulation and in an
    analysis snapshot. A router's own interfaces are read live in its own
    lookups.
  - *Knowledge comes by messages.* A device knows another's state only by
    what it received: a BFD peer's intervals, a PIM neighbour's DR
    priority, an RP candidate's Bootstrap (until its holdtime), an NTP
    server's stratum, an OSPF DR's record of its neighbours; an IKEv2 end
    deletes its own SAs by its own DPD, never the peer's.
  - *One TCP.* `sim/tcp.ts` is a connection end's byte stream (sequence
    and acknowledgment numbers, retransmission ranges, out-of-order
    segments, each message delivered once) and the one notation of its
    flags (`tcpFlagsText`: [S,A]); `transport.ts` sends its segments, every
    label and log line from the segment's own header, and draws a
    relation's segments along the relation in the logical view; BGP, LDP,
    HTTPS, SSL VPN and MQTT run over it (`proto-tcp.ts`, `mqtt.ts`) instead
    of imitating TCP, and no other module makes a TCP header.
  - *Each router's own context.* The PIM RP (`analysis/pim-rp.ts`, shared
    with the checks), the path MTU (per device, VRF and destination), the
    firewall sessions and NAT translations (per VRF), the source address
    (after the route, in its VRF).
  - *One clock.* Everything repeats on the simulated clock (streams and
    applications of Network events too): the pacing changes how fast it is
    shown, never what exists.
  - *Each object its own random stream.* Jitter, loss and the other draws
    come from a stream per device or cable, seeded by the model's title and
    its id; generated MACs from the title and the interface: adding an
    unrelated object changes no one else's timeline.
  *Trade-off:* a router's records are a per-router abstraction of the
  protocols' databases (not LSAs or BGP paths field by field): the
  prefixes an origin advertises are computed from its configuration given
  the adjacencies the records say are up.
* **A result says what it is, and stays as computed.** Every Analyze task returns its verdict in one vocabulary (`analysis/result.ts`) with the context it was computed on and its coverage. A result is computed when the user asks (Check communication, Evaluate, Analyze scenario, Evaluate capacity, opening Addressing), never behind their back: an edit marks it outdated (by the model's fingerprint, so moving a node does not), Refresh computes it again. A snapshot of a running simulation is frozen when it is taken; a tool that can't evaluate one correctly says so instead of blending the simulation's state with a what-if.
  *Trade-off:* the user presses Refresh after editing; in return a result being read never changes under the reader.
* **Analyze: one interaction model, rendered explicitly.** The workspace is organized by the question asked — Overview, Communication, Resilience (single-component failures, outage impact, capacity), Design review (findings, requirements), Addressing (`ui/workspace.ts`) — and every task uses the panels alike: the question on the left, the answer and results at the bottom, the evidence of the selected item on the right (`ui/evidence.ts`: what it is, its context, explanation, evidence, objects with Locate / Fit / Show only / Restore, what to inspect next; an editor says it is one). Each task's module builds its three parts from the App's state (`trace.ts` commRequest / commResults / commEvidence, `spof.ts`, `outage.ts`, `design-checks.ts`, `addressing.ts`, `overview.ts`); `App.renderAnalyzeWs` mounts them, and one delegated listener per panel (wired once) selects a result item (`data-an-item`) or an object (`data-goto`). Rendering and selecting compute nothing; only the question's action, Refresh and Evaluate do, on the analysis engines that existed before (`analysis/communication.ts`, `diagnosis.ts`, `failure.ts`, `whatif.ts`, `capacity.ts`, `expectations.ts`, `addressing.ts`, `findings.ts`). The selection is per task and mode, by a stable key (`layer:policy`, `hop:trace-main:2`, `spof:device:hq-fw`, `net:<vrf>|<id>`, `exp:<id>` …), so sorting, filtering and switching tasks keep it; Back returns to the task, item and scroll an investigation came from. Focus is a view aid of the diagram in a tool window, not a task.
* **Outage impact: components first, the same engine.** Resilience → Outage impact (`ui/outage.ts`) asks *what changes if these components become unavailable?* Its question holds exact refs (`device:core-a`, `link:uplink-b`, `iface:r1:wan`, `relation:vpn`), chosen in a searchable picker or prepared from the diagram selection, a single-component row or a dependency's provider — prepared, never run, and never replacing a condition without an explicit Add or Start new. A group adds its devices by membership and a saved failure domain is an optional shortcut that copies its components, each marked with where it came from; no domain is needed or created. `whatIf(model, refs, { exact: true })` (`analysis/whatif.ts`) evaluates them without id precedence, against the same baseline and with the same propagation, dependency, requirement and capacity comparison the analysis always had; the result keeps the condition as asked, frozen with its model (a changed request is marked not applied; an edit marks it outdated). The UI tells the chosen components from what the analysis propagates, says absent checks instead of zeros, and traces optional device pairs in slices with Stop and the coverage. It is a static comparison on the configured model; Experiments (prepared from it as an explicit model edit) answer what happens over time.
  *Trade-off:* each task's parts are drawn again as a whole (a typed filter only redraws the results and the evidence, so the caret stays); in return no panel holds a copy of a result, and nothing depends on where another part's DOM happens to be.
* **Recent results are session state, bounded.** The overview's recent and pinned results (`ui/overview.ts`: 12 recent, 8 pinned) hold a result object as its task keeps it, with the question, its context, the model it was computed on, its fingerprint and its selection; reopening one shows it as computed (outdated by fingerprint), never recomputed. Nothing of it is saved with the model, and loading another model clears it. A result that names a simulation's records keeps only references: whether a record is still kept is decided when it is followed (`gotoEvidence`), never by the history.
  *Trade-off:* a pinned result can keep an old `Model` object alive (at most 20 of them); in return reopening needs no recomputation and can never answer a different question.
* **Evidence is recorded where it is decided; a diagnosis only reads it.**
  The boundary that decides an outcome records it as data on its own log
  line (`note`'s `ex`, never a pending slot another line could take): a
  drop's cause (`DropCause` in `analysis/sim/types.ts`: its kind, the
  packet id, the packets inside an outer one, its sender and session, the
  outer header, the interface, MTU, next hop, relation, cable, or the
  policy's device, rule and default) is set by the engine or the firewall
  filter that dropped it; a RST or ICMP error carries the decision it
  reports and its sender's reason; a test's outcome (`TestOutcome` in
  `analysis/sim/transport.ts`: its kind, the device that answered and why,
  every drop of its exchange marked when it was one of its attempts, how
  far back the log reached), its waits (met or not), retransmissions and
  DNS queries by the transport that ended or held it; an equal-cost choice
  by the forwarding that made it; a state change of an interface, cable or
  session as a `Transition`; an MQTT publication's fate in its record
  (`MqttPublication`, `analysis/sim/mqtt.ts`). What a packet released from
  a queue or a wait sends and notes belongs to its own exchange
  (`Engine.ownExchange`). `analysis/diagnosis.ts` builds the answer to a
  communication question from the communication check and these records
  (`Simulation.runEvidence`, `appEvidence` and `mqttEvidence` hand them
  over, scoped to the run asked about, without running anything): it
  never parses an event's text and never reconstructs the past from the
  current tables. It answers apart whether the run finished, what was
  observed and whether its cause is established; each link of its
  evidence chain says whether it is a recorded cause, contributing, a
  prerequisite (with the recorded transition behind it), a related
  observation or not established. Runtime references name their
  execution (`Simulation.exec`), so a later simulation's reused numbers
  never answer them.
  *Trade-off:* a cause the engine does not record (protocol-internal and
  TCP-sequence drops still say only text) stays *not established* in a
  diagnosis instead of being guessed from the words; the records are
  bounded by the log's, the packets', the publications' and the test
  list's retention, which a diagnosis says.
* **A tunnel layer has its own identity.** `trace.ts layerEnds` resolves
  each layer of a tunnel stack: the tunnel's ends for its first, a
  relation carried between other addresses (IPsec between WAN addresses
  under GRE between loopbacks) its own ends, family and VRF. The tunnel-MTU
  budget, the static path MTU, Trace path (the outer packet routed by the
  outermost layer's ends) and the simulation (each header between its
  ends, keepalives too) all read it; `endpoint-order.ts` is the one order
  in which a device's interfaces stand for it as an address (an ordinary
  interface, a loopback, a container bridge's), each consumer keeping its
  own adapter for usability.
  *Trade-off:* a layer's ends come from the model's static addresses (a
  lease is not known statically); a relation without interfaces rides the
  tunnel's own ends.
* **One definition of what an encapsulation adds.** `analysis/encap.ts`
  states each tunnel format's bytes (outer header of the tunnel's family,
  outer UDP, header, padding, trailer, inner Ethernet) with the format it
  assumes; the static path MTU, the tunnel-MTU check, the MTU suggestions
  and the simulation's packet lengths, tunnel MTU, PMTUD relay and TCP MSS
  all read it, so the same packet has the same size statically and at run
  time. The outer protocol and ports stay `trace.ts tunnelOuter`'s.
  *Trade-off:* one format per protocol (ESP with AES-CBC and HMAC-SHA1-96,
  GRE without a key …): a device with other options differs by a few bytes,
  which the result's assumptions say.
* **What runs, what is drawn and what is evaluated are three things.**
  A simulation's execution scope (`analysis/exec-scope.ts`) decides what
  runs: a sub-model of the scope's devices, closed over what they need
  (the routing domain whose routes they use, the switches between, their
  DHCP and DNS servers, gateway-group members). The devices outside are not
  run — never frozen and shown as participants — and traffic towards them
  is logged where it leaves the scope. The diagram's filters, focus,
  collapsed groups and saved views decide only what is drawn; an analysis
  evaluates what it was asked for.
  *Trade-off:* a scoped run can differ from the entire model where the
  scope cuts a dependency it did not see; the scope lists what it added and
  its boundary so that this can be judged.
* **Experiments run on scenario time only.** A saved experiment
  (`analysis/sim/experiment.ts`) starts a new simulation of the model and
  advances it on the simulated clock, in slices of the page's time, so a
  run is repeatable and comparable with the previous one. Real-time
  streams are no experiment action.
  *Trade-off:* behaviour that depends on the browser's real time is out of
  an experiment's reach.
* **One place for network logic.** Everything that reasons about the
  network (route resolution, address arithmetic, the consistency checks)
  lives in `analysis/`, works on the typed `Model` and returns plain data.
  Validation, the diagram, the editor and the UI call it; none of them
  re-implements a part of it. Its results are sorted by values (prefix,
  distance, interface id, address), so they never depend on the order of
  the YAML file.
* **Checks are findings, not format errors.** The format's rules make a file
  valid or not; the consistency checks describe the network and never block
  anything. Validation runs them on a valid model and attaches each finding to
  the YAML entry and field it is about (`Issue.check`, `Issue.refs`), so the
  Problems tab, the Edit tab and "jump to" treat them like any other issue,
  in their own list (`LoadResult.findings`).
* **Positions are separate from semantics.** Positions live in the optional
  `layout:` section, are only warnings when broken, and never change the
  model. Auto-arrange is a pure function of a canonical input
  (`layout/input.ts`), so YAML order, comments and manual moves can't affect
  it. The layout status is derived by comparing stored positions with that
  result (see `docs/FORMAT.md`). The strategies (`layout/strategies.ts`) are
  functions of the Default result, so they inherit its determinism; which
  one a view "is arranged with" is found by comparing positions, never
  stored.
* **Modified is a comparison, not a flag.** `ModelDoc` keeps the text it was
  opened or last saved with; the model is modified when its export differs.
  Undo back to the saved state is therefore unmodified, and a save records
  the text that was actually written. Whether the model is linked to a file
  (a writable handle), its displayed name and its modified state are three
  separate pieces of state in `ui/app.ts`.
* **A connection is a draft until it is created.** Choosing two endpoints in
  the diagram only opens a form (`Editor.draft`); the model is changed once,
  by `ModelDoc.addConnection`, when the user creates it. The rules for which
  endpoints may be connected live in `model/connect.ts`, next to the
  validation they mirror, so the UI and the tests share them.
* **One definition of every size.** `layout/sizes.ts` turns text into
  wrapped lines and element sizes. Auto-arrange reserves exactly those sizes
  and the renderers draw exactly those lines, so text fits its box without
  either side measuring fonts. Widths are estimates from character classes;
  that is what keeps the layout identical across browsers.
  *Trade-off:* a little spare room in every box, and no pixel-exact fit.
* **A binding is drawn as a port.** An endpoint that names an interface
  binds its relation or link to it, and the renderers attach the line there
  and nowhere else: `diagram/logical-ports.ts` finds the row of the
  interface by its id (`deviceRows`), puts a port beside it, and routes the
  strand from port to port; the physical view puts the cable end on the port
  of that interface (`layout/physical.ts`). Nothing is matched by position
  or index. Relations are grouped into strands by their bindings
  (`layout/bundles.ts`), so a relation is nested in a tunnel's tube only when
  both run between the same ports. The room ports need (row heights for
  their lanes and end labels, the reach of stubs and labels beside a box) is
  part of the layout input, so Auto-arrange leaves it and stays a function
  of the model. *Trade-off:* rows with ports are taller and the logical
  diagrams larger; routes are computed at render time (sides, stubs, corners
  around boxes), like labels, so they follow dragged nodes.
* **Non-IP interconnects are a separate graph.** Opaque ports
  (`stack: opaque`) live in `Device.opaquePorts`, never in its interfaces,
  and interconnects in `Model.interconnects`; `model/interconnect.ts` holds
  their rules (roles, data directions, the hop rule, explicit transit).
  Everything IP — addressing, routing, paths, checks, the logical view, the
  simulation's network — iterates interfaces and links, so it cannot see an
  opaque port by construction; validation refuses one as a link or relation
  end. Only the physical layout (`layout/input.ts` merges them as extra
  nodes and edges), the diagram (`diagram/interconnects.ts`), the editor and
  `analysis/sim/opaque.ts` read them. That simulation moves abstract data
  over the interconnect graph and the Systems' `opaque_transit` groups (the
  only transit; nothing is joined because two connections share a
  technology), as flights with no headers on tracks
  `interconnect:<id>`: the search (`model/interconnect.ts opaqueRoute`, also the execution scope's) admits only hops the access rule allows,
  each hop is checked when it is due, and a failure cuts the hops on their
  way it blocks. A series keeps its last transfers and counts; the
  inspector's rows go with the flight (`Flight.illustrative`). An
  interconnect's `traffic:` runs with the simulation as the scenario's
  (drawn as a flow, never waited for).
  *Trade-off:* no protocol of an interconnect is simulated — only where
  data can go and why it can't; and a device that is both (a USB adapter
  with a network stack) is modelled as two ports, one of each kind.
* **Labels are placed at render time, deterministically.** Floating labels
  (cable labels, relation labels, addresses) go through a `LabelPlacer` in id
  order: first free candidate, else least overlap. Routes and label places
  are therefore a function of the model and the node positions only, also
  for manually placed nodes.
* **Rendering is data.** Renderers return a `VNode` tree, which keeps them
  testable in Node. `ui/dom.ts` is the single place that turns it into DOM,
  using only `createElementNS`, filtered `setAttribute` and text nodes. That
  is the safety boundary for untrusted names and labels.
* **No framework, no dependency injection.** Modules expose functions and a
  few small classes (`ModelDoc`, `Session`, `App`, `Editor`). The UI layer
  is still the largest part (`app.ts`, `inspector.ts`); splitting it further
  would mostly move code around without clearer boundaries.
* **Bundling.** `tsc` compiles to CommonJS in `build/js/`, and
  `scripts/build.mjs` wraps the modules (entry `app/main`) into one inline
  script and inlines the CSS. The output is deterministic, so a checked-in
  HTML file can be verified against the source (below).

## Extending

* **Capabilities, not type names.** What a device does — bridge, route,
  filter, pass between paired ports, receive copies, end a VPN, separate
  two domains, run guests — comes from one resolver,
  `model/capabilities.ts`, which reads the type, the mode, Supports Layer
  3, a System's purpose and a Security gateway's implementation.
  Validation, the editor, Connect, the tracer, single points of failure,
  the simulation, Auto-arrange and the helpers ask it; only the registry
  (`model/device-types.ts`), the resolver and the icon lookup name types.
  `test/architecture.test.mjs` fails on a comparison with a type name
  anywhere else. Policy that more than one module applies is written once:
  a Security gateway's decisions in `analysis/separation.ts` (the tracer,
  the simulation's `analysis/sim/separation.ts`).

* **New protocol:** nothing to change in the code. Add it under
  `protocols:` in a YAML file, or extend the built-in table in
  `model/protocols.ts`.
* **New device type:** add it to `model/device-types.ts` (identifier,
  display name, kinds, modes and the behaviour it shares), give the
  behaviour its capabilities in `model/capabilities.ts`, give it a glyph in
  `diagram/icons.ts`, list it in `docs/FORMAT.md` and regenerate the
  capability matrix (`node scripts/capability-matrix.mjs --write`). Nothing
  else names it: every module decides by capabilities.
* **New field on an entity:** add the key to `yaml/schema.ts`, read and
  check it in `validation/validate.ts` (and the model type), then show and
  edit it in `ui/inspector.ts` using an existing `ModelDoc` operation.
  Round-tripping works automatically. First check that the fact isn't
  already configured somewhere else: if it is, add a function to
  `model/derive.ts` and show it read-only instead.
* **New view:** add layout functions under `layout/` (fed by
  `layout/input.ts`), a renderer under `diagram/`, and switch between them in
  `diagram/session.ts`.

## Build and verification

```sh
npm ci                 # TypeScript only (dev dependency, pinned by package-lock.json)
npm run build          # -> dist/netatlas.html (and the test build, build/netatlas-test.html)
npm test               # build + every test suite (unit, browser, public, viewport)
npm run check:dist     # are the checked-in generated files generated from this source?
npm run verify         # everything CI checks
```

`npm run check:dist` regenerates every generated file in memory (the
embedded examples, the help assets, the fixtures, `docs/SUPPORT.md` and the
bundle) and compares them byte-for-byte with the committed ones. It writes
none of them. It exits with status 1 and names the command that regenerates
a stale one. To confirm a checkout or a pull request, run it on a clean
working tree after `npm ci`. The suites, CI's checks and the release
verification are in [TESTING.md](TESTING.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Project layout


The source is split into layers. Each layer imports only the layers below
it, and `test/architecture.test.mjs` enforces this. The layers above give their
responsibilities and the allowed dependencies.

```
src/
  model/        Network model: types, protocol registry, IP handling, queries (refs, search)
  analysis/     Network logic: address math, routing, consistency checks (pure, deterministic)
  yaml/         YAML boundary: subset parser, serializer, format schema (keys + order)
  validation/   Parsed tree -> model + errors/warnings (and check findings) located at YAML nodes
  layout/       Deterministic auto-arrange for both views, stored vs automatic positions
  diagram/      Model + positions -> virtual SVG tree; DOM-free view session
  editor/       Editable document: editing operations, undo/redo, renames, layout section
  ui/           Browser: app shell, inspector, panels, dialogs, file I/O, VNode -> DOM
  app/          Entry points: main.ts (the release) and main-test.ts (the test build); the in-browser
                self-tests (selftest.ts: full, test build only; public-selftest.ts: the release's own)
                and the viewport check (test build only)
  generated/    The public examples (examples.ts), the internal examples and fixtures (test-examples.ts,
                test build only), the license text and the manual's screenshots, embedded at build time (do not edit)
  index.html, styles.css
scripts/        build.mjs, gen-examples.mjs, gen-help.mjs, gen-support.mjs, make-fixtures.mjs,
                capability-matrix.mjs, check-repro.mjs, release-check.mjs, run-tests.mjs,
                browser-selftest.mjs, cdp.mjs, manual-screenshots.mjs, readme-screenshots.mjs
test/           node:test suites; test/examples/: the internal test examples; test/fixtures/: generated test data
examples/       The public examples: the File menu's catalog (see examples/README.md)
docs/           ARCHITECTURE.md, FORMAT.md, YAML-SUBSET.md, LIMITATIONS.md, SUPPORT.md (generated), TESTING.md,
                REPOSITORY-SETTINGS.md, screenshots
                (docs/img/manual/: the screenshots of Help → User Manual)
dist/netatlas.html   The deliverable (checked in; see "Is the checked-in HTML current?" in CONTRIBUTING.md)
build/          tsc output and the test build build/netatlas-test.html (not committed)
CHANGELOG.md    Release notes per version
CONTRIBUTING.md Branch workflow and release procedure
```

## Security model


* Input is untrusted. Everything user-supplied (from files or typed into the
  editor) reaches the page only as text nodes, form-field values, or validated
  attribute values. Elements are only created with `createElement[NS]` and
  `setAttribute`; attribute names come from code and are filtered (no `on*`,
  `href`, `src`, `style`). Colours must match `#rgb`/`#rrggbb`. Class names
  derived from input are reduced to `[a-z0-9_-]`. The bundle contains no
  `innerHTML`, `eval` or `Function`.
* There is no network at all: a CSP with `default-src 'none'`, no external
  resources, and no network APIs. Saving writes to a file the user chose
  (File System Access API, Chromium-based browsers) or uses a local Blob
  download; the page never gets access to any other file.
* Input size and complexity are bounded at every stage: file size, YAML
  lines/depth/nodes/scalar length, entity counts, error count, layout
  iterations, and the undo history (100 steps).

# Testing and verification

How NetAtlas is tested: the automated suites (`npm test`), the in-browser
self-tests, and a manual check for other browsers. Moved here from the
README; the commands to run are in [CONTRIBUTING.md](../CONTRIBUTING.md#building-and-testing).


```sh
npm test                    # build + every test suite (unit, browser, public, viewport)
npm run verify              # what CI checks: type check, freshness, reproducibility, package check, every suite
npm run check:dist          # are the committed generated files current? (writes nothing)
npm run test:unit           # one suite (also test:browser, test:public, test:viewport)
npm run selftest:browser    # only the full in-browser self-test, on the test build (verbose)
npm run selftest:public     # only the released application's own self-test, dist/netatlas.html#selftest (verbose)
npm run selftest:viewport   # only the viewport check, on the test build at ten window sizes (verbose)
node scripts/browser-selftest.mjs --shot   # also writes screenshots of the release to dist/screenshots/
```

## Suites

`scripts/run-tests.mjs` runs the test files of `test/` as four suites; every
`*.test.mjs` file is in exactly one of them (`node scripts/run-tests.mjs --list`
shows which), and the runner refuses a helper module that defines tests
(it would never run). A file that imports the browser helpers
(`scripts/cdp.mjs`, `scripts/browser-selftest.mjs`) is a browser file.

| Suite | Files | What it tests | Needs |
|---|---|---|---|
| `unit` | DOM-free files (97) | YAML, model, validation, analysis, layout, protocols and the simulation's scheduler on its own clock (no real sleeps), the architecture's layer rules, the static audit of `dist/netatlas.html`, the verification scripts and the workflow rules | `npm run build` (the tsc output; the packaging test also reads the test build) |
| `browser` | browser files (33) | Interaction and rendering with real pointer and keyboard input, both themes; the full in-browser self-test of the test build | `npm run build`; a browser |
| `public` | `public-artifact`, `offline` | The committed `dist/netatlas.html` as shipped: the release package check, its own self-test at three sizes, and the offline contract observed from outside the page | a browser (no build) |
| `viewport` | `viewport` | The viewport check at ten window sizes | `npm run build`; a browser |

* **Concurrency:** files run in their own processes, as many at a time as
  there are CPUs (at most 8) for `unit`, and **2 at a time** for the
  browser suites, so that browsers don't compete for the machine. Set
  `NETATLAS_TEST_CONCURRENCY` or `--concurrency N` to change that. A file
  still running after 20 minutes is stopped and fails.
* **Results:** each file's whole output is in `test-results/<suite>/<file>.log`,
  and `test-results/summary.json` and `environment.json` record the result,
  Node, the operating system, the commit and the browser version.
* **Failure evidence:** while a browser file runs, every page it opens
  records its console errors, warnings and uncaught exceptions, and on
  closing writes them with a screenshot of what it showed last to
  `test-results/<suite>/<file>/`; the self-tests write their full results
  there too. These are kept only for a file that failed. They contain
  nothing but the test pages: the examples and the test models.
* **No retries.** A failure is reported as it happened; the runner never
  runs a file again to make it pass. A test that fails only under load
  (one is known: the pace measured on screen in `sim-pause.test.mjs`) is a
  finding to fix in the test.

### Browsers and strict mode

The browser suites use Chrome, Edge or Chromium (found in the usual places,
or `NETATLAS_BROWSER=/path/to/browser`). **Locally**, without a browser
those tests are reported as skipped, as `npm test` always did, with a
warning. With **`--strict`** (or `NETATLAS_REQUIRE_BROWSER=1`), as in CI, a
missing browser, a `NETATLAS_BROWSER` that does not exist, a browser that
does not start, or any skipped browser test fails the suite.
`NETATLAS_BROWSER=none` behaves as if no browser were installed, to try
this.

**Zoom.** The narrow and zoomed sizes (the viewport check, the public
self-test's "zoomed to 200 %") are *approximations*: a smaller window, with
the CSS viewport a zoomed page has. They are not browser zoom (which also
scales the device pixel ratio, and fonts with minimum sizes); a real zoom
level is checked by hand (step 1 of the manual check below). The automated
checks of contrast, keyboard use and focus cover what they test, not WCAG
conformance as a whole.

### Offline

The released page loads nothing: its Content Security Policy allows no
connection, font, frame or external image, and the build refuses
non-relative modules. Three checks prove it, each a different way:

* **Static** (`test/build.test.mjs`, `scripts/release-check.mjs`): one inline
  script, no `<link>`, no external URL besides XML namespaces and the
  license's text, the strict CSP, no test-only module or internal example.
* **From inside the page** (the public self-test): no resource timing
  entries, no CSP violation, with DNS resolution disabled.
* **From outside the page** (`test/offline.test.mjs`): the DevTools
  protocol records every request the page's own target makes, however it
  ends, while the page runs its examples in both views and themes, Help,
  Analyze, a simulation, an experiment and the PNG export. Only the page
  itself and `data:` / `blob:` URLs are allowed. A control makes the page
  request an external host and checks that the observation sees it. The
  browser's own background traffic (component updates, safe browsing)
  belongs to no page and is not counted; it is also switched off.

### Size and speed

The release has a size budget (`SIZE_BUDGET`, 6 MiB, in
`scripts/release-check.mjs`; 5 973 779 bytes at 0.1.3 plus the played
experiments, 95 % of it). It is raised only deliberately, with the reason
in `test/build.test.mjs`. A few tests bound the time of a computation
generously (auto-arrange of the stress example: 8 s), as a guard against
an accidental quadratic step, not as benchmarks. The simulation's speed
is compared with `dev` by hand when a change could affect it; there is no
timing benchmark among the required checks.

## CI

`.github/workflows/ci.yml` runs on every pull request into `dev` or
`main`, on every push to them, and by hand. Each job is a check; the names
are the ones the branch rules require (proposed:
[docs/rulesets/dev-main-required-checks.json](rulesets/dev-main-required-checks.json)).
*Suite time* is measured on a 12-thread Windows development machine
(Node 24.22, Chrome 155); the jobs on GitHub's 4-core runners add the
installation and the build and have not been measured yet, so expect more.

| Check | What it runs | Suite time |
|---|---|---|
| Source and generated files | `npm ci`, `typecheck`, then **`check:dist` before anything regenerates**, then `check:repro` (two builds, identical, nothing committed changed), `release:check`; on failure the differences are kept | check:dist 9 s, check:repro 18 s |
| Model and analysis tests | `build`, the `unit` suite | 30 s |
| Compatibility (Node 22 on Linux), (Node 24 on Windows) | `check:dist`, `build` and the `unit` suite on another Node version and operating system | about the same |
| Browser regression tests | `build`, the `browser` suite with Chrome for Testing 155.0.8059.84 | 8.5 min (2 files at a time) |
| Public artifact | the `public` suite on the committed `dist/netatlas.html` (no install, no build) | 16 s |
| Viewport checks | `build`, the `viewport` suite | 42 s |
| Workflow lint | actionlint (with shellcheck) and zizmor on the workflows | seconds |
| Release PR source | a pull request into `main` must come from `dev` | seconds |

The jobs run in parallel; a pull request has its result in about the time
of the browser job. The browser suites run with `--strict`, the browser is
installed by `browser-actions/setup-chrome` at that exact version, and each
failed job uploads `test-results/` (7 days). On the Ubuntu 24.04 runners
the jobs allow the user namespaces Chrome's sandbox needs (rather than
`--no-sandbox`), and set the UI font to Liberation Sans
(`.github/fontconfig/fonts.conf`): the runners' default, DejaVu Sans, is
wider than the label sizes assume (docs/LIMITATIONS.md, "Labels"). Every
test browser is given a mouse (`(hover: hover)`, `(pointer: fine)`) through
Blink's settings, because the runners have no pointing device; touch is
emulated explicitly where a test wants it. A newer push to a pull request
cancels its older run; runs on `dev` and `main` are not cancelled.

`.github/workflows/security.yml` runs CodeQL and, on pull requests, a
dependency review; they are advisory (not required), see
[REPOSITORY-SETTINGS.md](REPOSITORY-SETTINGS.md#security-features). The
release workflow is described in
[CONTRIBUTING.md](../CONTRIBUTING.md#releasing).

What runs in CI and what stays manual: everything above is automated; the
manual check below (other browsers, real zoom, the file dialogs) is not.

## The test files

| Area | Where | What is checked |
|---|---|---|
| Parsing | `test/yaml.test.mjs` (19 tests) | Every supported construct; rejection (with line numbers) of anchors, aliases, tags, merge keys, directives, multiple documents, multi-line scalars and flow, tabs, duplicate keys and bad escapes; all resource limits; `__proto__` safety; all examples conform to the subset |
| Validation | `test/validate.test.mjs` (18 tests) | Examples valid; unknown keys, ids and references reported with suggestions; one cable per port; logical interfaces can't be cabled; `over` cycles; protocols; groups; limits; the broken demo file's exact errors |
| **Editor core and round trips** | `test/editor.test.mjs` (22 tests) | **Example files written back byte-for-byte.** A torture document and 400 random trees round-trip. **Create → export → reload.** **Import → edit → export → reload** (untouched text identical). **Attributes no diagram shows, and unknown keys, survive.** Renames update every kind of reference. Deletes report broken references; undo/redo; shorthand expansion; canonical key order. **Multiple IPv4/IPv6 loopbacks.** Every class of invalid loopback address, with the error located at the exact address. a router ID that names a loopback, renamed with it; duplicate-address warnings; loopback display in both views and details; drafts with errors still draw; the editor examples are reproducible. |
| **Auto-arrange** | `test/layout.test.mjs` (20 tests) | **Repeatability** (fresh documents give identical integer positions). **Order independence:** every example with shuffled keys, sections and lists and swapped cable ends, 3 seeds each, gives the same canonical input and identical positions in both views; fields that don't affect geometry don't matter. **Idempotence:** a second arrange changes nothing and adds no undo step. **Load → arrange → export → reload:** same positions and same rendered scene, and re-arranging after reload is a no-op; the arranged example is reproducible. **Manual moves:** only the moved node changes; the other view is untouched; arrange ignores manual positions; undo restores them. **Edits never re-arrange:** the first geometric edit freezes the shown positions; new nodes go next to their neighbors without overlap; renames carry positions; deletes drop them. The YAML tab is taken literally. **Semantics:** the model is identical with and without `layout`, and bad entries are warnings only. **Disconnected components** of different sizes: no overlaps in either view, and component bounding boxes are disjoint. **Dense relationships:** a 12-router full mesh with tunnels has no overlaps and gets a lane per relation. No overlaps for any example. **Static determinism guard:** no `Math.random`, time, `localeCompare`, `hypot`/`sin`/`cos`/`pow` or DOM measurement in layout code. Large-model runtime. **Layout status:** the Auto-arrange option the view matches is selected and disabled, the others available; none is selected while the view matches none (both views, filtered views too); a disabled option does nothing by click, pointer, keyboard or `A`. *auto / manual / edited* for each view after load, non-geometric edits, drags, undo/redo, a node moved back to its calculated position, export → reload, Auto-arrange and its repetition, model edits (never "manual"), renames and deletes; bad `layout.manual` entries are warnings only. |
| **Group placement** | `test/group-placement.test.mjs` (8 tests) | **enterprise-wan:** the provider group lies under the Internet and above the HQ routers it feeds, over them; cabling is under 60 % of the previous length, with no crossing and no bend around a device (previously 16 and 6), and shorter than the same picture with the group moved back to the bottom. Same result with other ids and another kind; the layout code contains no group kind or name. A provider group cabled only to an access switch is placed *below* its site. Data centre: spines above and between the leaf racks. Hub and spokes with groups of different sizes, a block with links to two others, a rack two layers down, a disconnected group and a loose device: layers, order, no overlapping groups, deterministic, idempotent, order-independent, manual moves kept until Auto-arrange. Every example in both views: no overlaps, clipped text or cables through devices; SVG legend clear of the diagram. Logical view: edges are relations and memberships, not cables. |
| **Relations and cables at their interfaces** | `test/ports.test.mjs` (12 tests), the browser self-test and the viewport check | **Logical view, every example and every Auto-arrange option:** each end of each lane (and each hub spoke) lies in the *port area* of the interface it references (the side of the box beside that interface's row, or beside the name part for a device-level endpoint), at a port of the right kind; no lane crosses a box, so none crosses another row; every port lies beside its own row; every end label names its interface, is beside its port, overlaps no text and is crossed by no line. `test/examples/long-labels.yaml`: GRE and OSPF of the branch router end beside `Tunnel10` and well clear of `Tunnel20`, which has no port; the file's bindings are checked as written (IPsec is bound to the devices). The stress example `test/examples/port-bindings.yaml`: three lanes from one tunnel interface, OSPF inside the IPsec tube there, `src:` end labels, subinterface and device-level ports, the LAG. **After dragging** devices to free places, with **labels off** and **protocols hidden**: the same bindings. **Deterministic**, and independent of the order of relations in the file. A reference to a missing interface is an error and nothing is attached in its place. **Physical view, every example and option, and after dragging:** each cable ends at the port of the interface it names (hollow at a device), on its device's side, across no other port or port label; LAG brackets hold member ports only. Pointing marks (`attachedRefs`) and the selection highlight of both end interfaces. **In the browser** (real fonts): the `test/examples/long-labels.yaml` bindings, no end label over text or under a line in both examples, contrast of ports, end labels, LAG marks and device-level ends in the light and dark theme (3:1 for marks, 4.5:1 for text), the bindings and the theme's colours in the exported SVG of both themes, pointing in the diagram and in the Objects list, and the endpoint marks of the Edit tab. **At every window size of the viewport check** (narrow layouts and pages zoomed to 150–300 %): every line of the stress example at a port, every port drawn, no end label or LAG name over other text. |
| **Sizing and readability** | `test/readability.test.mjs` (13 tests) | Text wrapping: explicit line breaks kept, wrap at spaces, long words broken after punctuation, nothing dropped, width bounded (also for 200 unbroken characters and CJK). Element sizes follow text within bounds. **Every example, both views:** no "…", device, network and group labels complete, every cable and relation labelled, text inside its box, no overlapping labels, no label on a node, no cable through a device. `test/examples/long-labels.yaml`: multi-line labels, differing node sizes, three parallel straight cables with their own labels, a cable that bends around a device, five labelled lanes between the same two devices (distinct labels, a nested relation named in its carrier's label, a carrier on other interfaces named as *over*). **Determinism:** drag + select + arrange one view at a time gives the same positions *and the same drawn picture* as a fresh arrange; arranging again moves nothing; same picture after export and reload; drawn text is part of the layout input, undrawn text is not. Labels and cable bends lie inside the exported picture's bounds. |
| **Physical and logical interfaces** | `test/interfaces.test.mjs` (16 tests) | **Two categories** stored once per device, zero or more of either; a physical interface has no type, a logical one requires `loopback`, `virtual` or `tunnel`; one id namespace per device; a cable ends on a physical interface only. **Loopbacks:** addresses, no parent, no other type's keys. **Aggregates:** several member ports; unknown, non-physical, duplicate and foreign-device members are errors at the entry; a port in two aggregates is a warning. **VLAN interfaces:** `vlan` or the VLAN of the address's network; *ports carrying VLAN* derived from link ends, following every link change, never stored; nothing assumed for other virtual interfaces. **Tunnels:** source is a port, a loopback or an address (its interface derived), destination an address, device or interface; invalid ones are errors. **Diagrams and selection** follow each association in both directions; details show only the association that applies. **Alphabetical display** in both categories with the file untouched. **Structures outside the format:** `children` and `loopbacks` are errors, not read, not dropped from the file. **Editing and export → reload**, renames across members, sources and destinations; every example. |
| **DHCP and DNS names** | `test/dhcp-dns.test.mjs` (15 tests), and the browser self-test | **DHCP:** off by default for new physical and logical interfaces and for interfaces without addresses; `ipv4: dhcp` on both categories; only true/false; not on a loopback (an error that keeps the flag, refused by the editor, no switch on the card, repairable by turning it off); DHCP together with addresses is an error that keeps both values; a DHCP interface is in no network; `ip: dhcp` points to the flag. Turning it on lists the addresses and DNS associations it deletes, then deletes them in one undo step; turning it off doesn't bring them back. **DNS names:** syntax; one name with several interfaces of both categories; duplicates, unknown and DHCP interfaces, repeated interfaces and an empty list are errors; a name on two devices warns; adding is checked first; enabling DHCP, deleting an interface and renaming it keep every association valid. Details, tooltips and search; nothing in the diagrams; export → reload. **In the browser:** the switch on every card except the loopback's, Cancel changes nothing, confirming greys the field out, no question when nothing is lost, the *+ DNS name* dialog (eligible interfaces by name, excluded DHCP interfaces, the several-addresses note), deleting an associated interface. |
| **Filtered views** | `test/filter.test.mjs` (10 tests), and the browser self-test | **Relevance**, both views, on a model with a group and a network that have members on both sides, a cable, a relation and a multipoint relation crossing the boundary, `over` / `network` references and a tunnel destination on the hidden side: only links and relations entirely among the selected devices; networks by membership, cable VLAN (physical) or relation (logical); only included members; groups with their parents; protocols from shown relations only; the complete model unchanged. **Layout:** no filter = stored positions; a subset is auto-arranged for itself, the same for any selection order and after earlier moves and filters; moves are temporary, per view, never in the document (no undo step, YAML and stored layout unchanged, export → reload identical); unrelated actions don't re-arrange; Auto-arrange restores the subset's layout; Select all restores the complete positions; edits keep a filtered layout stable. **Export** of a subset: devices, links, relations, legend and Networks overview of the subset only, no hint. **Groups / Locations** off hides frames, never devices, in both views; **logical clustering**: no frame covers a device of another group, sibling frames never overlap (every example). **In the browser:** the top-right controls (Devices, Labels, Groups / Locations; Networks in the logical view; no Underlay), the panel, the hint (outside the SVG), a temporary drag, view switching, Auto-arrange, Select all, and PNG + SVG of a filtered view in both views. |
| **DNS names in the logical view, Details header, filters, Find menu** | `test/dns-logical.test.mjs`, `test/dhcp-dns.test.mjs`, and the browser self-test | Each name once per device (not per interface), sorted; long names broken after a dot and never shortened; more than two names end in *+n more names*; the node is sized for them (no overlaps, text inside its chip); Labels off hides them; a filtered-out device takes its names along; the physical view has none; the logical SVG and PNG carry them and the legend names them only when they are drawn. **In the browser:** the same on screen and in both exports; editor hints no longer than 90 characters; the physical legend shows ports and ⚠ as symbols; Details and Edit have the same header (kind, name, ID beside it, problem state, also with an error) and Details has no *id* row; the toolbar filters on one row in a narrow toolbar, the Filters drop-down by keyboard with its *off* count, state kept when widening again; the file-name badge with a long name; Find → Find in diagram… / `/` / Esc, Find → Filter object list… / Esc (the diagram unchanged), both disabled without a model; on the start screen every diagram filter disabled and inert (inline and in a disabled Filters drop-down), enabled with its defaults once a model is open. |
| **Device types filter** | `test/type-filter.test.mjs` (6 tests), and the browser self-test | **Markup:** **Device types ▾** right after **Devices ▾** (a dialog button like it), the Endpoints and Servers switches gone, every type shown for a new model. **Rules:** hiding a type removes its devices, cables and relations in both views and in the export; the other devices keep their places; on again restores the complete diagram and its stored positions exactly, with the document, YAML and undo history unchanged. Switches by kind: Layer 2 and Layer 3 hidden apart, both hiding every switch. **With a device selection:** shown = selected and of a shown type, the selection is kept, and on again restores it with its positions; Select all while a type is off; a selection of hidden devices only. Moves and edits while a type is off stay temporary. **In the browser:** one row per type the model uses (display names, the format's order, the counts; absent types left out), *Device types: All* / *14 of 15* on the button and in the status bar with the types off named; Arrow Down opens it at the first type, Esc closes it; both views, SVG and PNG exports; Clear (*0 of N*) and Select all; Switch with Layer 2 and Layer 3 under it (a mixed state while one is off); combined with a device selection (*hidden: type Server off* in the Devices list, the counts). |
| **YAML mark, edit header, help, outline geometry** | `test/yaml-block.test.mjs` (4 tests), `test/menu.test.mjs`, and the browser self-test | **Locating an entry** by structure: an id that also appears as a title, label, quoted text, comment, reference, interface id and as `- id:` inside another entry's block text is marked only at its entry; interfaces in either list; `-` alone on its line, a list at its key's indentation, CRLF, quoted ids; nothing for invalid YAML, duplicate ids, flow lists or unknown ids. **In the browser:** the band lies exactly behind the entry; selecting from the diagram and the lists keeps the YAML tab, the text, focus, caret and text selection; typing, invalid text, Apply, undo and renaming; a newly selected entry is scrolled into view once and a later re-render keeps the reader's scroll position. **Edit header** with a 64-character id, a long label and an error: one row with type, state and actions, accessible names, tooltips, a red Delete, nothing clipped and no page or panel scrolling at 410, 300 and 240 px panel widths. **Help:** two labelled groups with every documented action, readable, side by side or stacked, foldable. **Outline:** selecting, switching and clearing leave every entry, its label and the panel width in place. |
| **Auto-arrange: current view, confirmation** | `test/arrange.test.mjs` (6 tests) | Arranging one view leaves the other's displayed positions, stored positions, hand-placed list and YAML untouched (both directions, also without stored positions). What would be overwritten: hand-placed nodes that differ from the auto layout, none for an auto-arranged or merely edited view; asking changes nothing (what Cancel relies on). Deterministic and idempotent per view, status follows. The UI has no "both views" choice and calls arrange with the current view (and the chosen strategy) only. |
| **Auto-arrange strategies** | `test/strategies.test.mjs` (7 tests), `test/default-arrange.test.mjs` (1 test), and the browser self-test | **Default** is exactly the existing Auto-arrange: **the positions and the drawn scene of every example, both views, match a snapshot taken before Compact and Structured were reworked** (`test/snapshots/default-arrange.json`). **Every strategy, every example (small and dense), both views:** deterministic integer positions, no overlapping nodes, no device inside the frame of a group it doesn't belong to. **Compact** takes less room than Default; **Structured** puts every position on its 10 px grid and differs from Default. **Arranging:** one undo step with the strategy in its name, idempotent, recognised from the positions and the routing after undo, export → reload and manual moves (none matches; every strategy reports the hand-placed node; a node put back where a strategy places it is no longer hand-placed). **Ties:** a one-device model matches Default and Compact (Default first); Structured changes its routing, one undo step. **Filtered views:** each strategy arranges the shown devices only, temporarily, deterministically for any selection order, without overlaps. Disconnected components, a long group title, long labels and many ports. **In the browser:** the three options in the toolbar (labelled group, no icons), Compact / Structured arrange the physical view only, Structured's cables at right angles (also after a move, with the status saying so), the selected option follows undo, a manual move enables all three and replacing it asks first, a filtered view, and identical results (Default selected, Compact disabled and saying so). |
| **The three presets drawn** | `test/arrange-presets.test.mjs` (16 tests), `test/arrange-presets-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450) | **Default** is the preset unless another is chosen (the initial layout, arrange without a preset, `A`), and after Compact or Structured it draws exactly the fresh Default with no routing stored; opening a file keeps its stored positions and routing. **Compact:** the full drawn bounds clearly smaller on the representative examples (private house, campus, data center, WAN, the OT cell, the stress model), never larger on any example; unconnected sibling groups side by side and a long row of clients folded, each still below its switch; the same texts in the same font sizes, no overlaps, every end at its interface. **Structured:** every position on the 10 px grid and at least as many connected devices in one column as Default; on every example and in both views every route only `M`/`L` commands with horizontal and vertical segments and right-angle bends (never back along itself), ends at the ports or interface rows, end labels at their ports, no overlaps; cables clear of every other device's box, no two cables sharing one line for more than a few px; the router around a box with its margin, straight when the ends line up, corridors spread apart with the ends kept; nested groups and floors around their own devices only, guests inside their hosts, no device moved to another group, nothing added; OSPF inside its GRE tube; positions and routing in one undo step, kept after a move and an edit, after save and reload (the same scene), removed by Default and by Remove stored positions; the `layout.routing` entry and its warnings. **All three:** the same input gives the same positions, routing and scene, arranging again changes nothing, a 300-device model arranged and drawn in a few seconds. **In the browser:** the buttons and hover texts, Structured by the keyboard, the browser's own geometry and line joins (mitred, round after Default), the SVG and PNG export showing the screen's routes, a move and undo, the logical view, no sideways scrolling. |
| **Crossings** | `test/arrange-crossings.test.mjs` (7 tests) | The crossing measure on the drawn routes (a shared end or a common port is no crossing); the private house with Default and Structured: the core's cables to the DSL router and to the NAS don't cross, nothing crosses, every device in its floor and inside its frame, every cable from a port of its own device to one of the other, through no third device, no label conflicts; the data center's border leaf placed so its uplink crosses nothing (only the six crossings two spines and four leaves always have); no public example with more crossings than its topology leaves (Compact at most two more), and fewer in all the examples than before (Default 26 → 15; Compact 15, Structured 18, the spine/leaf mesh 7 instead of 6; the layout stress model aside); the same positions and routes every time, and arranging again changes nothing; 300 devices in sites arranged in a few seconds. |
| **Connecting endpoints** | `test/connect.test.mjs` (8 tests), and the browser self-test | **Rules:** physical view — devices and uncabled physical interfaces; not logical interfaces, not a cabled port; a device can't be cabled to itself or its own port, two ports of one device can; parallel device-to-device cables are allowed. Logical view — devices and logical interfaces, on different devices; physical interfaces are not offered; an interface already in a relation stays available. **Duplicates** only for the same endpoints (ordered when unidirectional), protocol (normalised), label and direction, and no underlay or attributes on the existing relation. **Creating:** one undo step, stable `"device:interface"` references, a device end stays the whole device, valid, modified, undone cleanly. **Two distinct relations on the same logical interfaces:** created, three separate lanes, each selectable and highlighted, edited independently, exported and reloaded identically. **Interfaces in the diagrams:** uncabled ports as chips (physical), loopbacks and the other logical interfaces (logical), every endpoint element tagged, following adds, deletions, new cables and filters; chip texts with a shared prefix, nothing shortened, devices sized for their chips. **In the browser:** left click selects an interface (Edit tab, card open) and never connects; right-click starts (browser menu suppressed only there), marks the source, compatible and incompatible endpoints, draws the line; an incompatible endpoint is refused with a message and the first kept; Esc and switching views cancel; the second right-click opens the draft with the ID focused; invalid IDs keep Create disabled; Create adds the link, Undo removes it; C + the connect bar + Enter, Esc discards the draft; the logical view's chips, a same-device pair refused, a duplicate relation refused until its label differs, both relations drawn, edited, in the SVG and reloaded. |
| **Saving** | `test/save.test.mjs` (6 tests), and the browser self-test | **File menu wording:** *model* in every entry, "…" exactly on *Open model…* and *Save model as…*, no *Download model*. **Capabilities** detected, never assumed (no picker without the API or a secure context); only a writable file handle links a model, never a plain file or a drop without one. **Writing:** granted, asked for and refused permission, a failed write — reported, never thrown, nothing written on a refusal. **Modified state** is a comparison with what was opened or saved: undo and redo, saving, an edit during a write. Save model shows no dialog and keeps the unsaved state when it fails; the download fallback never links. **In the browser** (with stand-ins for the browser's file handles): a cancelled picker saves nothing; Save model as… writes, links, stops marking the example and downloads nothing; Save model (Ctrl+S) writes at once without a dialog; undo / redo after saving; a failed write and a refused permission (Save model then unavailable); Open model… with the picker links the file and asks for write permission on the first save; a file from the file input is not linked and Ctrl+S then opens Save model as…; the example mark moves and clears; without a picker the download copy keeps the example marked and says so. |
| **Networks box in exported SVG** | `test/networks-box.test.mjs` (9 tests) | **Relevance per view**, from the drawn elements: ports, the aggregates and virtual interfaces that use them, the networks the cable ends carry (physical); network nodes, relations' `over`/endpoint interfaces, loopbacks (logical); hidden protocols and switched-off network nodes excluded; not every network of the file. Content: title per view, name, prefix, VLAN, id for equal names, sorted. Empty states. **Every example, both views:** beside the legend, no overlap with diagram or legend, inside the viewBox with margins, every line inside the frame. Long names wrap without being shortened; 150 networks flow into columns without overlap. Deterministic. |
| Rendering | `test/render.test.mjs` (12 tests) | Physical view: devices, cables and ports, no relations. Logical view: relations, no cables; tunnels as tubes; GRE inside IPsec; parallel lanes; protocol matrix; hostile labels stay text; deterministic layout |
| **Legend in exported SVG** | `test/legend.test.mjs` (5 tests) | For every example and both views: the legend lies to the right of everything drawn, inside the enlarged viewBox, with margins; every label fits its frame; a short diagram grows to the legend's height and a large one with many disconnected components keeps its size. Content: device types, media, speed, ports, locations, the VLAN-mismatch symbol only when used; protocols with their line styles, without the ones that are hidden; no references outside the file. The Legend tab and the SVG legend come from the same entries. |
| View switching | `test/state.test.mjs` (8 tests) | Physical ↔ logical switching keeps the selection and positions; highlight sets; search, details and legend |
| **Toolbar and outline** | `test/menu.test.mjs` (18 tests), and the browser self-test | The toolbar markup: logo and version, one **File** menu holding New, Open, Save, Save as, Close and the examples (each entry says *model*, "…" only where input follows), the **Export** menu with *Export view as…* and its PNG / SVG submenu, the **Find** menu with *Find in diagram…* (/) and *Filter object list…* (their only place), the **Help** menu right after it with *User Manual* and *License* (never disabled), the License dialog's name matching `LICENSE` and `package.json` and its embedded text equal to `LICENSE`, every screenshot the manual names embedded as a `data:` image, the toolbar groups' frame colour at least 3:1 against the toolbar in both themes, undo/redo, views and the three Auto-arrange options as direct controls, and the diagram filters as one group with a **Filters** drop-down; no "document" wording in the interface. In the browser: the menu opens, names its entries, closes with Esc and on an outside click, works with arrow keys, and loads an example; there is no **Current model** button, the model panel stays visible and **Edit model settings** in the Edit tab opens the whole model's edit view, where the title is edited and undone; outline sections fold and unfold, Links and Protocols start folded, a folded section keeps its count, its problems, the selected entry and the number of related entries, the filter looks inside, **+ Add** opens it, and folding never changes the model. **Start screen:** name, logo and one sentence; New model, Open model… (file picker and drop target) and Load example (picker filled with the six examples by title, then *Load* or Enter); no link row, file names or long text; keyboard order; drops anywhere are taken over by the page, valid files open, invalid and non-YAML files give a "Could not open" page with a way back, non-file drops change nothing, and a drop onto unsaved work asks first. **Export menu:** next to File, same behaviour, arrow keys between the menus, disabled without a diagram, exports the selected view with its legend and Networks box; no Save SVG button. **Close model:** after *Save model as…*, disabled without a model; a clean new model, opened file and example close at once; with unsaved changes the prompt offers Cancel (model, view, selection, tab and form untouched; Esc too), Discard changes (nothing exported) and Save and close / Save as and close… (without a save picker: a downloaded copy under the new-copy name, then the start screen); the wording never claims to overwrite the original; the open example is marked in the File menu, modified or not, also after undo and redo; closing clears selection, view, filters, folding and search. **+ Port Range** through the dialog: live preview, disabled Create and errors for invalid ranges, Cancel, creation of 24 ports, duplicate rejection, undo, export → reload. |
| **Picture export** | `test/menu.test.mjs` (scale and file names), and the browser self-test | **Both formats, both views**, through the menu, for enterprise-wan (zoomed in and panned first), long-labels, a fixture with a loopback-only network and a generated **large model** (96 devices, 8 groups, 9 networks): the file is named `<model>-<view>.png` / `.svg`; the picture covers the diagram's bounds, not the part on screen, and carries no pan or zoom; every device is in it and no text is shortened; the **legend** and the **Networks** box of that view lie inside the picture with a margin. The PNG has a valid signature and header, the size of the SVG times the scale, is not blank in the legend and Networks areas, and matches the downloaded SVG drawn at the same size pixel for pixel (one picture, two formats). The Networks box differs by view (the loopback-only network only in the logical pictures). PNG scale: 2×, reduced for very large diagrams (the large logical view is drawn below 2×). **Menu:** disabled without a model; the submenu opens on a press, not on hover, with arrow right / Enter / Space, closes with arrow left / Esc. **Failures:** a PNG that can't be encoded and an SVG that can't be serialised open a dialog naming the file and the reason; nothing is downloaded. |
| **New entries ready to fill in (real input)** | `test/create-focus.test.mjs` (6 tests), through the DevTools protocol | Every create path, with the keyboard: **+ Add** for each kind of object (device, link, network, relation, group, protocol), **Duplicate** (Edit tab and outline), **+ Interface**, **+ Loopback**, virtual and tunnel interfaces, **+ Port Range**, **+ Route** and a route's duplicate, **+ DNS name**, an address typed into *add* (Enter, and Tab, which keeps the focus where Tab put it), the next free address, an attribute, a protocol from *Enable a protocol…* and from a suggestion chip, a VRRP group, an endpoint, an underlay, a member port and **Connect** (the draft, then the new link); `X` no longer does anything. Each time: the entry is selected and marked, in view in the Edit tab, the cursor in its first field with the proposed text selected, the announcement's wording, a new object selected in the diagram with its outline row in view. Undo: the entry gone, the focus on the button that created it, the selection back to what it was; Ctrl+Z in the untouched new field undoes the create, after typing it undoes the text. Reduced motion: no smooth scrolling. |
| **Side panel (real input)** | `test/side-panel.test.mjs` (4 tests), through the DevTools protocol | The limits (320 px, the diagram's 360 px, stored values checked); the splitter as a separator with name and value, ← → with and without Shift, Home, End, Enter, a drag, a double-click, the width remembered over a reload in local storage and never in the model; at 1440 … 600 px wide and 100 / 150 / 200 % zoom, with the default and the widest width, on every tab: no tab cut off or squeezed, the active one shown, the splitter shown only beside the diagram, the diagram's room, no sideways page scrolling; a growing tab label wraps; a very short window keeps one row with the rest in **More ▾** (the active tab never in it; ↓, Enter, Esc). |
| **Quick actions (real input)** | `test/quick-actions.test.mjs` (3 tests), through the DevTools protocol (`scripts/cdp.mjs`) | **Pointer:** with nothing hovered no row shows Duplicate and Delete, not even the selected one; moving from row to row shows them on exactly the row under the pointer, inside it, the label still readable; Duplicate on another row adds and selects the copy without selecting that row; Ctrl+Z / Ctrl+Y; Delete asks, Cancel keeps model and selection, Delete deletes. **Keyboard:** Tab through the list: the focused row (and only it) shows its buttons, Tab reaches them, Enter duplicates and the cursor moves to the copy's ID in the Edit tab (its row selected and in view), Delete asks and Esc returns the focus to the button, with a visible focus ring. **Touch** (hover: none): a tap selects a row and shows its buttons; Delete asks first. The browser self-test adds: every row has the pair, named with action and object; quick Duplicate and Delete on every kind of object (device, link, network, relation, group, protocol) export exactly what the Edit tab's buttons export. |
| **Help** | `test/menu.test.mjs`, the browser self-test and the viewport check | The menu by arrow keys from Find; User Manual: title, ×, Close, Esc, focus on its text and back on **Help** afterwards, a section per basic task, the contents list moving to a section without changing the page address, every screenshot a decodable embedded image with alt text and caption, shortcuts of the page off while it is open; License: names the Apache License, Version 2.0 (SPDX Apache-2.0), the full text embedded and scrolling in place, no links; both without a model. |
| **Viewport** | `test/viewport.test.mjs` (12 tests) → the test build's `build/netatlas-test.html#viewportcheck` (44 states per window size: the Objects list's headings in both themes, including every tool window docked or floating, the start dialog with every section open, the simulation layout (setup, diagram, actions and the panel each whole and inside the window, none over another, nothing wider than its panel; below 860 px the Setup and Actions tabs, and in a narrow, not tall window the Diagram, Setup and Actions tabs, each tried; a table, the packet inspector, a parameter layer and Send test's options open; at 300 % zoom the clock and Exit reachable; Exit bringing back the Objects list), and the ports of `test/examples/port-bindings.yaml` in both views, the start screen's actions, the open File, Export, Find and Help menus, Help → User Manual and Help → License with its full text (inside the window, × and Close reachable, the text scrolling inside the dialog), the open PNG / SVG submenu, the Find bar with its results, the diagram filters on one row with the Filters drop-down and its "off" count in both views, and a long file name in the status bar) | Stylesheet: the shell is sized by the viewport (`100dvh`, shrinkable middle row), the document is clipped, no fixed pixel heights, the panels are the scrolling regions and positioned. **In a real browser at ten window sizes** (maximized, not maximized, short and wide, both narrow layouts, and the viewports of pages zoomed to 150 %, 200 % and 300 %): with a long device form, its last field focused, both views, every tab, long lists and a dialog, the document has nothing to scroll and cannot be scrolled; toolbar controls, diagram controls, tabs and status bar are inside the window; the side panel ends at the status bar; long panels scroll to their end inside themselves. |
| **Themes and theme-aware export** | `test/theme.test.mjs` (11 tests), through the DevTools protocol for the browser part | **Tokens:** one set of names for both themes, the dark ones the default (`:root`), no colour outside them, nothing picks the theme from the system; WCAG 2.2 AA pairs (text and muted text 4.5:1 on every surface and on the selection tint, control borders, focus ring, selection, selection bar and diagram lines 3:1). **Diagram colours:** every medium and protocol colour 3:1 on each surface in both themes. **Start-up:** a fresh profile opens in Dark; a stored Light stays Light, Dark stays Dark, a stored *system*, an invalid or an empty value becomes Dark (and is removed), with the OS set to light and to dark; the theme is already set when the page body is created (no flash). **The toggle:** right end of the toolbar at 1440, 1024, 720 and 390 px, never in a menu; name, tooltip (hover and keyboard focus) and icon; Dark ⇄ Light by mouse, Enter and Space, keeping view, selection, zoom and layout. **Storage:** the choice survives a reload; without storage the theme is Dark and switching still works. **Exports:** Light and Dark (with the OS light and dark) × both views × PNG and SVG: background and colours as on screen, no stylesheet, variable or media query in the SVG, opaque PNG; exporting changes nothing on screen. **An exported SVG opened on its own in a browser with the other colour scheme** keeps its theme. **Automated contrast check** of the rendered application in both themes. |
| **Selection in the Edit tab** | `test/edit-highlight.test.mjs` (4 tests), through the DevTools protocol | In both themes, clicked in the physical view, the logical view and the object list: a device, a port (link end), an address of a port and of a loopback, a VRF, a VLAN, a MAC address, a DHCP switch, tunnel source and destination, member ports, a tunnel interface, a device's, a group's and a relation's address attribute, a VRRP virtual address, a network and its prefix, a link and its cable id, a relation: exactly the matching section is marked (aria-current, tag, visible). The bar has 3:1 against the panel and the tint, the tag is readable, the focus ring inside a mark shows. Scrolled only when off screen, smoothly or (reduced motion) at once; the focus stays where it was, typing is not interrupted. The mark follows an edited address, undo, redo, a view switch and a renamed interface; Duplicate marks the copy; Delete, Esc and loading a model clear it. |
| **Segment borders** | `test/segments.test.mjs` (2 tests), through the DevTools protocol | Every segment of **View** and **Auto-arrange** and every button of **Filters**: in both themes, at 1440 and 800 px, at 100, 125, 150 and 200 % zoom, disabled, normal, selected, hovered, pressed and keyboard-focused: at each of its four edges it is on top, or the neighbour there draws its border and is in a state at least as prominent (DOM, `elementFromPoint`); the right border of a hovered segment shows its hover colour in the screenshot's pixels; nothing moves or changes size on hover. Without the fix the test reports the hovered segment's right edge covered by its neighbour. |
| **Addresses in the diagram** | `test/addresses.test.mjs` (8 tests), and the browser self-test | **Inventory:** every address and identifier field of every example (`ip`, `mac`, `vrf`, `vlan`, tunnel `source` / `destination`, `members`, network `cidr` and `vlan`, `cable`, DNS names, address-like `attrs`) is drawn as text in its view, whole; no "+N", no "…". **Order:** IPv4 then IPv6, numeric, secondary and dual-stack together. **No overlaps:** no text over other text, no label over a node, entries inside their boxes, for every example, both views and all three Auto-arrange strategies (the self-test measures the same with the browser's fonts). **Determinism** with the room addresses need. **Dragging:** entries move with their device; an overlap made by hand is counted and shown; Auto-arrange removes it. |
| **Objects title** | `test/objects-title.test.mjs` (2 tests), through the DevTools protocol for the browser part | The left panel is a complementary region named *Objects* by its level-2 heading, with no subtitle and **no description** (read from the browser's accessibility tree); the right panel is the region *Inspector*. The title is one compact row above the list at 1440, 1024 and 800 px. |
| Offline / artifact | `test/build.test.mjs` (8 tests) | One inline script; no external references or remote URLs (the only exception: the two `apache.org` addresses quoted in the embedded license text, shown as plain text, never as a link); the manual's screenshots embedded as `data:` images, under 1080 KiB together; the page within the release size budget (6 MiB); no `fetch`, XHR, WebSocket, `eval`, `innerHTML` …; strict CSP before the script; compiled JavaScript only; every module comes from `src/`; one version in `package.json`, `package-lock.json`, the HTML (meta and UI) and `CHANGELOG.md` |
| Device types | `test/device-types.test.mjs` (6 tests) | Exactly the 15 specified types with their display names; each is accepted, has its own icon and a default tier; no type is allowed (generic icon); any other value (old names such as `l3switch`, `hypervisor`, `host`, `leaf`, `spine`, wrong case, hostile text) is an error at the type line with a suggestion or the list of types; display names in subtitles, details and the legend; the examples use only these types |
| **Device model** | `test/device-model.test.mjs` (21 tests), `test/device-model-doc.test.mjs` (2 tests), and the browser self-test | **Capabilities** of every type, mode, Supports Layer 3, System purpose and separation implementation; roles' rows and the deterministic fallback; **validation** of kinds (Other with its name), roles, modes, purposes and icons, port pairs, the removed types; the VPN gateway's conditional configuration (site to site, remote access, an unsupported technology) and the Security gateway's (no default implementation, exactly two domains, directions, every match written, profiles only in a protocol break, an unsupported transfer); **policy semantics** (rule order, default deny, an empty policy, management interfaces, no reverse initiation); the **tracer and the simulation** through a filtering bridge, a filtering router and a protocol break (both legs, over TCP and UDP), a VPN gateway's tunnels only, port pairs (one way, a TAP's copy, a passive monitor), a Cloud as one Layer 3 hop; **single points of failure** by what a device joins; cloud groups and cloud instances; port role labels and the legend; the editor's **change plan** (what goes, one undo step, nothing chosen); the examples converted by behaviour; the capability matrix in docs/FORMAT.md equals the resolver's. **In the browser, both themes:** the Security gateway's Edit cards, its ports' domain labels, no overlaps; Trace path with a service and its Leg 2; a type change's confirmation (Cancel, confirm, one undo); a System's purpose. |
| **Services and Wi-Fi** | `test/services.test.mjs` (13 tests), and the browser self-test | **The registry:** every service with its badge and help, who may run it and the reason when not (a Layer 2 switch, a transparent firewall, a System that is not a host; nothing on a Security gateway but its separation), the built-in functions, the schema's keys equal the registry's, the service matrix in docs/FORMAT.md equals the registry's. **Validation:** required parameters (always or by the others), parameters that don't apply, placeholder secrets, references; Wi-Fi networks (VLAN or untagged, radio, security, passphrase, one SSID per radio, the uplink carries the VLAN, a router's VLAN interfaces), wireless connections (their network, several per radio), the controller and its access points. **Analyses:** several networks over one uplink (each client's lease in its own VLAN, Guest isolated, the shared uplink a single point of failure and its failure in the simulation), a tunneled network reported, NTP, RADIUS, syslog, SNMP and CAPWAP exchanges and the services' listening ports, DNAT, a reverse proxy, a load balancer's own backends and algorithm, an IPS block, a VPN on a firewall and a router, PAT in the simulation and as the tracer's note. **Diagram and editor:** badges (three and a count, the tooltip, the legend), Find by SSID, VLAN and service, removing a service (its change plan, one undo step), adding one (nothing chosen). **In the browser, both themes:** the Services card, Add service… with its disabled entries and their reasons, the Wireless access card, the badge line and its tooltip. |
| **The example catalog and packaging** | `test/menu.test.mjs`, `test/browser.test.mjs`, `test/public-artifact.test.mjs`, `test/release.test.mjs` | The File menu's eleven public examples in their order, one line each, each with a title and a description, valid, without warnings and without consistency findings but the one `virtualization.yaml` shows on purpose; `examples/` holds exactly the catalog, `test/examples/` the internal examples, no name in both; only the test build's entry and the full self-test import the internal examples and fixtures; **every internal example and fixture is absent from `dist/netatlas.html`** (by a long, distinctive part of each file) and present in the test build, as are the public ones; the release contains neither the full self-test nor the viewport check, and the build refuses one that would. |
| **The private house** | `test/house.test.mjs` (9 tests) | Valid, no warnings or findings; the floors and where each device stands; the DSL modem/router (Firewall, kind *DSL modem/router*: PAT, policy, DNS) and a Layer 3 switch that only routes, its gateways and VRFs; the wiring (the basement AP and the distributor on the core, the upper-floor APs on the distributor), one uplink per AP, the VLANs carried and tagged alike at both ends; three access points with the same three SSIDs and VLANs, each client on a network of its access point in its VLAN; in the simulation each lease in its VLAN, HTTPS from every zone through PAT, the NAS by name from Internal, IoT and Guest dropped by the DSL router (by IoT's own VRF), the relations' HTTPS answered through the NAT; a Guest broadcast domain without Internal or IoT; the tracer stopping at the policy; the riser cable as the upper floors' single point of failure, its failure cutting both upper-floor access points, one cable event and one carrier loss per end. |
| **Device type names** | `test/naming.test.mjs` (4 tests) | *VPN gateway* / *VPN gateways* from the registry with the identifier `vpn_gateway`; every type in sentence case, acronyms kept in running text; the old capitalised spelling nowhere in the code, the manual, the documentation or the examples (the change log names it once); the device box, the legend, the Device types filter, Find, validation, the tracer and the simulation say *VPN gateway*; a label a user wrote with the old spelling in it, and the file, are unchanged. |
| **The Objects list's headings** | `test/outline-layout.test.mjs` (3 tests), and in the browser: the self-test, the released application's self-test and the viewport check (`src/app/outline-check.ts`) | The rules that keep a heading still: one spacing for open and folded sections, one caret glyph turned by a transform, one line box, focus as an outline, the list's scrollbar room kept; in the browser, at every window size and in both themes, each section (empty, populated, with a problem badge) folded and unfolded by a click and by the keyboard and all at once: the toggled heading and those above it keep position, height, width, padding, caret, title and count, those below move only up or down, `aria-expanded` follows, the focus stays on the heading and its outline takes no room. |
| New elements | `test/creation-defaults.test.mjs` (7 tests) | **New** is empty and valid; each new object gets only an ID (no type, kind, prefix, VLAN, protocol or category); missing required values are errors located at the object, optional ones stay unset; choosing a value saves exactly it and clearing removes the key; an empty group kind is not drawn as a site; **Duplicate** keeps all values; every example imports and exports byte-for-byte, with model values taken only from the file |
| **Derived values and unknown keys** | `test/derive.test.mjs` (19 tests) | **Membership** from addresses: one entry per device with every match; a DHCP interface makes no member; the network prefix is the authority (the interface's own prefix length is ignored); IPv4 and IPv6 boundaries and prefix lengths (`/0`, `/30`, `/31`, `/32`, `/52`, `/128`); no matching across families; overlapping networks (every containing network, same prefix twice warns); invalid and incomplete addresses match nothing. **One prefix per network:** missing, empty, a list (even of one) and invalid prefixes are errors that keep the value in the file. **Interface VLAN:** derived per address; none when no network matches or no VLAN is defined; several addresses give several VLANs; conflicting networks give an explicit ambiguity and a warning. Derived values follow every edit and undo, and are **never written to YAML**. Membership drives highlighting, selection context, search and the layout input. **Keys outside the format** are unknown keys, located at the key; nothing is converted; the file is written back unchanged. Each fact has one key in the schema; `vrf` on interfaces; loopbacks have no physical-link properties. |
| **Analysis: address math and routing** | `test/analysis.test.mjs` (9 tests) | **Address math** for IPv4 and IPv6: integers, canonical text (RFC 5952), networks of prefixes, sizes (up to `::/0`), ranges, containment and overlap, host counts (network and broadcast address, `/31`, `/32`, IPv6), free ranges and the next free address, `/64` counts, ordering. **Routing:** connected networks per VRF, static routes (a missing distance counts as 1), longest-prefix match, distance, metric, **equal-cost multipath**, blackholes, VRF tables, local addresses; next hops directly connected, **recursive**, through an exit interface, the device's own address, a loop, never through a default route; **interfaces that are down** remove their networks and routes and let a **floating** route take over; results independent of the order of the file; the targets of next-hop lines and the editor's next-hop suggestions. |
| **Static routes** | `test/routes.test.mjs` (14 tests) | The format (prefix, `via`, `interface`, `blackhole`, distance, metric, VRF, name, attrs; IPv4 and IPv6), written back exactly; **which device types may have routes** (Layer 3+ and hosts; not AP, IDS/IPS, cloud, untyped) and a host's default gateway; every validation error at its field; **each route check positive and negative** (`route-nexthop-self`, `-unresolved` incl. another VRF, `-recursive`, `-interface`, `route-exit-interface` for a loopback, an uncabled port, a LAG member and another VRF, `route-duplicate`, `route-conflict`); findings at their field, never invalidating, order-independent; **editing** (add, duplicate, delete, blackhole, undo; renaming an exit interface); the **route tables and next-hop lines** of the logical view, the **Routes** switch (nothing moves), the address inventory; related objects, details, tooltip, Find; filtered views. |
| **Port VLANs** | `test/port-vlans.test.mjs` (19 tests) | **The port model:** access, trunk with and without a native VLAN, routed (a Layer 3 switch's, a router's), hosts unaffected, LAG members taking the aggregate's VLANs, subinterfaces by name; badges and diagram tags; **validation** (a switch port's mandatory VLANs at the field, a switch's aggregate, members with their own VLANs, native VLANs, routed ports, IDs 1–4094, ranges, repeats, an address on a bridge port, the old link-end keys); router-on-a-stick against a bridge port; **VLAN interfaces** bound to every bridge port of their VLAN (access, trunk, LAG), following the ports, the bridge-port runs, two for a VLAN, none of its ports, one on a Layer 2 switch; **each VLAN check positive and negative** (`vlan-access-mismatch`, `vlan-trunk-mismatch`, `vlan-native-mismatch`, `vlan-access-trunk`, `vlan-unknown`, `lag-member-vlans`); editing (merged ranges, native, routed, one undo step each; a native VLAN that no longer fits goes), **Assign VLANs to ports…** in one undo step, making a switch Layer 2; the diagram's tags, trunk ports, the *VLANs differ* mark, details, tooltips, Find by VLAN and mode, highlighting both ways, membership. |
| **Port VLANs in the simulation** | `test/sim-vlans.test.mjs` (6 tests) | Access ports untagged and trunks tagged except the native VLAN (the frame headers), inter-VLAN routing on the VLAN interfaces (TTL), a VLAN interface through any bridge port, ARP on it, MAC tables per VLAN, a routed port without VLANs, a disallowed VLAN dropped with the port's VLANs in the log, a native mismatch leaking with its explanation, the spanning tree on the bridge ports. |
| **Virtualization: the format and editing** | `test/virtual.test.mjs` (20 tests), and the browser self-test | **Guests:** a host required, of the right kind (a VM: a server with the Hypervisor; a container: a server or VM with the Container engine); no ports, cables or location of their own; no hypervisor type (its error says what to do). **The services:** what they need as errors, virtual switches (uplinks, teaming, port groups), vnics (port group or passthrough, exclusive, never an uplink; guest tagging), container networks of every driver and their attachments (subnet, published ports). **Checks:** the five virtualization checks. **Related objects and Find** both ways. **Editing:** renaming a host (and a host port), deleting a host or unticking its service (guests named, references reported), + VM / + Container, port group VLANs, guest tagging, NAT, the next free address. **Connect** refuses a guest. |
| **Virtualization in the Edit tab (real input)** | `test/virtual-ui.test.mjs` (1 test), through the DevTools protocol | A hypervisor's Services card; **+ VM** on a host, the new VM's **Host** picker offering the hypervisors only; **+ Virtual NIC** with its host's port groups; the port group of its address's VLAN suggested and set by its chip; unticking the Hypervisor of a host with guests asks first and names them, Cancel keeps it; **+ Container** with its network picker (its host's networks) and the next free address of the range; every step undone to the file as it was. |
| **Virtualization in the diagrams** | `test/virtual-diagram.test.mjs` (7 tests), and the browser self-test | **Physical:** each guest inside its host (a container in a VM inside the VM), bars and port groups inside, nothing overlapping, deterministic; the wires from vnics and veths to their port groups or networks, uplinks from the host's ports, passthrough. **Logical:** *runs on*, bridge and overlay networks of their own host (the same subnet behind two hosts: two networks), selecting one selects its container network, its place stored as `host/name` and accepted on reload. **Filter:** servers by service, guests only with their host (with the hint), focus keeps a host's guests. **Legends.** **The simulation's HA restarts** drawn in the new host, what lies below making room. |
| **Virtualization in the analyses** | `test/virtual-analysis.test.mjs` (7 tests) | **Path tracer:** through the port group's virtual switch and the active uplink, inside a host without a cable, guest tagging, passthrough, different VLANs on one switch; teaming failover; SNAT out of a container host (and out of a VM), DNAT to a published port, no way in without one, macvlan, a container's implicit default route. **Failures:** a host's guests down, HA restarts (not with passthrough) followed by the tracer. **Single points of failure:** a host for its guests, a passthrough port, a virtual switch with one uplink or uplinks to one switch. |
| **Virtualization in the simulation** | `test/sim-virtual.test.mjs` (7 tests) | **The network:** a bridge per virtual switch and container network, virtual links, the uplinks' and the passthrough port's cables moved, HA standby links parked, none in the spanning tree. **Forwarding:** across hosts and inside one, nothing learned on uplinks, split horizon. **Teaming:** failover after the detection time with a RARP per guest, failback. **HA:** a host's VMs restart on the other member after the VM restart time (not with passthrough), a container with its VM. **Containers:** SNAT and the reply, published ports (DNAT and back), refused and unreachable otherwise, macvlan (and its host that can't reach it). **The engine:** stop and start, restart policies, start time. |
| **Command registry and palette** | `test/palette.test.mjs` (6 tests) | The registry: unique ids, every command with label, group, state and action, no shortcut used twice, the commands the palette must offer and one per example. **The menus are the registry:** every menu entry names a command and shows its label and shortcut; no entry is wired by hand; the keyboard dispatches through the registry. Shortcut labels (Ctrl, or Cmd on a Mac) and matching (Ctrl/Cmd, Shift, never Alt). Fuzzy matching (word starts, subsequences, every word), ranking (recent first, unavailable entries with their reason, keywords), the results count; the objects (devices, interfaces, links, networks, relations, routes, groups), each once and selectable, found by address and next hop. |
| **Focus mode** | `test/focus.test.mjs` (7 tests) | The devices an object stands for (device, interface, link, relation, hub, group, protocol; none for a network without members); hops along cables (physical) and relations (logical), 1 to 3; the same neighbourhood for a file in another order. The session: each view shows its neighbourhood with temporary positions, more hops keep the devices that stay in place, ending gives back the complete diagrams exactly; focus combined with a type filter, and the filtered view with a hand-moved node given back as it was; an edit deleting the focused object ends focus; focusing every device of three examples and ending restores the stored positions. |
| **Simulated traffic (for the protocol simulation)** | `test/traffic.test.mjs` (8 tests) | The flows per protocol (OSPF and BFD both ways, VRRP from its active member, syslog one way, a bidirectional service with replies, a hub group per member) with their lanes and cables; demands traced through networks and relations, the rate growing with the bandwidth; equal-cost paths sharing a demand; a one-way cable never used backwards by the tracer, and its format; `test/examples/ospf-reroute.yaml` with the primary link failed, then w1's LAN too, then both back (rerouted, VRRP failing over, the camera lost where it stops, restored exactly) and the changes from one state to the next; cables oriented by walking (LAG members the same way, unknown order both ways); determinism (file order, repeated runs, failure order); the `demands:` section's form and warnings. |
| **Analyze windows and what was removed** | `test/windows.test.mjs` (5 tests) | **Single points of failure:** a row per point with element, type, what it cuts off, the relations down and the impact, most impact first; sorting by every column both ways (ties in the report's order); filtering by words; CSV (header, quoting) and text. **Trace path:** the hop table's columns. The windows' commands (`F6` also while typing, the Analyze entries ending in “…”, their keys). **Removed:** a `scenarios:` section and `risk_groups:` are unknown keys; the scenario, template and traffic modules are gone; no `X`, `[`, `]`, no Analysis or Simulation tab; no example writes them. |
| **Workspaces (real input)** | `test/toolwindow.test.mjs` (5 tests), through the DevTools protocol | `F6` with real keys region by region in Analyze (the left panel, the bottom panel, the outline, the diagram), `Shift+F6` back; `Esc` in a panel's field never leaving the workspace, in the diagram leaving it and restoring the Inspector; `Shift+F` entering Analyze → Focus with the keyboard on the hops; a floating tool window (Saved views) dragged by its title bar and grip, stopped at the edge, remembered over a reload; at 800 and 600 px and 200 % zoom the panels as tabs and the page not scrolling. |
| **Experiments** | `test/experiments.test.mjs` (6 tests) and the browser self-test | `after` chains resolved, cycles and unknown actions said; observation windows (a state satisfied as soon as it holds, traffic counted to the end); settle not counted; scope sub-models and actions outside them refused; the saved-expectations observation; the document operations (add, change kind keeping what fits, move, after, scope) each one undo step. In the browser: the kind kept on change, drafts editable and not runnable, focus kept, undo / redo and reload, run / stop / reset with no stale callback, the cable-activity indicator's geometry (one side through pan, zoom, theme, redraw and alternating directions), workspace transitions and model replacement. |
| **Experiments played** | `test/experiment-play.test.mjs` (9 tests) and the browser self-test | The duration units: conversions that keep the duration (60 sec → 1 min, 1.5 hours → 90 min, 1 s through hours and back), fractions, nothing invalid or missing written, the canonical form. The model: `start: cold`, `for`, the new fields and observations, the targets scope, errors versus warnings. A cold start: devices off, then booting by their boot time (the evidence’s own time), an action waiting for its device and said, guests after their host, external objects never powered, the same result run again. The observations: neighbor, route, OSPF session, PTP timing (no accuracy claimed), MQTT delivery, a reception with a minimum, sent is not received. Relevance: the experiment’s operations and prerequisites, a host’s other traffic and the rest of the network hidden. Played with the pacing (only its traffic shown) or run at once: the same verdicts, times and evidence, and less display time than with everything shown. Stop: nothing added afterwards, every observation said. In the browser: the duration control (unit change converts without writing, invalid and empty values said and not written, undo / redo), the three starts, For only on actions that last, the pre-run summary, a cold start playing with the device states Booting then Operational, Pause and Skip, Analyze pausing and resuming a playing run, another model ending it, and an ordinary simulation afterwards without the experiment’s filter; the viewport check with a run playing. |
| **Protocol simulation (engine)** | `test/sim.test.mjs` (61 tests) | **Fresh start:** empty ARP, neighbour and MAC tables, every session down, the interfaces up at t = 0. **ARP before the first unicast packet:** the broadcast request (*ARP Who has 10.0.1.2? Tell 10.0.1.1*), the reply with the MAC, the entry, then the waiting packet. **NDP:** a Neighbor Solicitation to the solicited-node address (33:33:ff:00:00:01), the advertisement, REACHABLE. **Multicast MACs** (01:00:5e…, 33:33…) and virtual MACs; OSPF Hellos without ARP. **VRRP failover** after the master-down interval with a gratuitous ARP for the VIP with the virtual MAC; the host's entry *virtual*; the switch learns its new port. **Tables:** configured and default timers, the timer scale, refresh while in use, removal when unanswered, the entries of an interface that goes down. **Switching:** learning per port and VLAN, flooding within the VLAN only, known unicast to the learned port, VLAN separation; aging, flushing on a failed port, relearning on the new path; static entries. **Routing** between VLANs on a Layer 3 switch (the MACs rewritten, TTL 64 → 63, in the log) and none on a Layer 2 switch. **Generated MACs:** locally administered, unique, the same in any order, marked simulated. **Determinism**; a failure (dropped frames where they were, the dead interval, LSU flooding, the reroute, the full handshake after the restore); tunnels (OSPF in GRE in ESP); custom protocols one way and both ways, and as frames between devices without addresses. **Every built-in protocol has a profile** (messages, transport, timers with sources, states, failure, restore), and for 41 protocols a two-router model shows its message sequence and the state it reaches, with its timers logged (defaults marked); configured timers; LACP, STP, LLDP, CDP, PIM and IGMP; the protocols of a model for the window. |
| **Layer 2 and Layer 3 switches** | `test/l3switch.test.mjs` (5 tests) | `layer3` on switches only; the role rule; a Layer 2 switch's management interface, VRF and routes allowed, every kind of Layer 3 configuration reported (protocols, router ID, a second addressed interface, tunnels, groups, VRFs, routes in other VRFs, routing relations); the path tracer stops at a Layer 2 switch and passes a Layer 3 one; making a Layer 3 switch Layer 2: the list of what goes and the relations that stay, one undo step, and back; the L2 / L3 badge and glyph in both views, the legend, Find and the palette. |
| **Simulation parameters and network events** | `test/sim-params.test.mjs` (16 tests) | **The registry:** the layers' sections (8, 6 and 6 rows, at most 8), every parameter with a default in its range, a unit, a short help and a source, the defaults and their sources. **Values:** durations with a unit or in the parameter's own, percentages, speeds, choices; range and unit errors. **Precedence:** configured, device, simulation, default, and the source labels (*5 s (configured on cable x)*, *1 min (device)*, *10 min (simulation)*, *4 h (default)*); the values remembered for the session (only known, valid ones). **Device attributes:** every device type has its own (boot time at least), narrowed by what the model gives the device; the `simulation:` blocks of devices and cables validated (unknown key with a suggestion, not for this type, range, unit); the old `arp_timeout` key is an error; the Edit tab writes only overrides as one undo step that the simulation's lock allows. **Layer 1:** latency = propagation + serialization (64 bytes at 1 Mbit/s plus 2 ms), a cloud's latency on its cables, packet loss (100 %, and deterministic below), loss-of-signal detection, the link-up delay, a loss too short to notice. **Network events:** a failed relation, flapping for its cycles and continuous until stopped, shut and no shut (a port, a VLAN interface), power off (tables and sessions gone, the neighbour notices) and on (boot time, sessions afresh), several at once and ending them; an IPS failing open or closed; a VM restarted on another server. **Live changes:** a shorter ARP timeout expiring entries at once, the next OSPF Hello rescheduled, every change logged; a device's attributes changed in the model applying at once (*device*); the route recomputation delay; RSTP vs STP convergence; a full MAC table; the default TTL; **determinism** with parameter changes and events at the same simulated times. |
| **Readable playback waits for the dots** | `test/sim-barrier.test.mjs` (20 tests) | Every test checks the barrier every frame: the simulated clock never past the arrival of a hop waited for that is still on its way on screen. **ARP and TCP over three cables:** the reply after the request reached the server, the waiting SYN after the reply reached the client, the client's ARP entry when the reply arrived on screen, SYN → SYN-ACK → ACK → data each after the one before arrived; a warm cache sends no ARP. **Concurrency:** two hosts' tests moving at the same time. **Multicast:** a stream before the join, the member port learned when the join's report arrived on screen, copies to the TV only after it, none after the leave, every copy forwarded after its upstream copy arrived; flooding where snooping is off, as headless. **Scheduling:** the engine stops before a held delivery event by event (what comes before it at the same moment runs, what comes after doesn't), a zero-latency delivery held too, `run` never waits; a zero-latency cable's dot still gets its time; a cable failing under a dot releases it, with the headless outcome; Step processes the next visible delivery at its own time and nothing later, Next exchange; detach on stop and a fresh start. **Semantic invariance:** the same actions at the same scenario times give the same log, the same flights (deliveries and drops), the same client connections and the same outcomes headless and in Readable, 4×, 0.25×, Proportional, Real time, the logical view, a protocol hidden, a dot limit of 2, no idle skipping and with every repeat drawn — and with view, pacing, speed, follow, limit and filter changed on the way. **The steady state:** repeats summarized, the simulation then at its rate, a Network event making it news again; the pacing text's words for a hold. Also: a held dot whose track leaves the scene lets its hold go (the headless outcome); the presentation epoch per change from outside, recovery traffic detailed then summarized again; equal-time processed versus pending deliveries across filter and pacing changes (the delivery lifecycle), zero-time flights; a receiver's state unchanged until its delivery runs; the network's normalized state (neighbor and MAC tables, routes, connections, sessions, leases, IGMP and snooping, outcomes) at checkpoints of longer scenarios headless and paced; the logical view's barriers (network lines, relation lanes, answers, a view change); a 30 000-event moment within the frame budget, in order, its held delivery still holding. |
| **TCP connections: who opens them** | `test/sim-tcp-connections.test.mjs` (13 tests) | Counted at the transport's connection creation, not by dots. One Send test is one connection, its SYN's retransmissions on the same port; a connection attempt its application gave up on (its response timeout) is closed, no SYN after it (it used to retransmit for about two minutes beside every newer attempt); periodic test traffic one connection per target and interval on the scenario's clock, never more than one attempt in SYN_SENT; an application's retries one connection per try within count × (1 + retries); a DNS wait adds none; a BGP session one connection, kept; a reboot leaves nothing of the old attempts; the examples open exactly their configured connections in two minutes. Lifecycle boundaries: Stop during an ARP and a DHCP wait, a SYN-ACK at the timeout's own moment (and just before) identical paced, BGP after a failure and recovery, an MQTT client stopped while connecting, LDP after a ring failure, an established connection whose application times out. |
| **Non-IP correctness** | `test/sim-opaque-correctness.test.mjs` (11 tests), `test/transit-edit-browser.test.mjs` (1 test, browser) | Route discovery admits only hops the rules allow (an invalid alternative sorted first never ends it; cycles; all invalid; deterministic); a failure while a hop is on its way stops it — mid-hop, the final hop, between transit hops, before departure, at the arrival's own time, attachment-only against the whole bus — a restore never revives it, headless and paced alike; bounded retention (last transfers kept, counts of all, finished series released, rows on the flights); an interconnect's `traffic:` with the simulation and its validation; vme-rack.yaml covers every configuration and carries data on every interconnect with its IP applications answered. In the browser: a System's transit groups added, edited, renamed, undone, removed, exported and reloaded through the Edit tab. |
| **Analysis correctness** | `test/analysis-correctness.test.mjs` (17 tests), `test/sim-eligibility-browser.test.mjs` (1 test, browser) | The family asked for is the one traced (dual-stack ends, devices, interfaces, applications, identity, expectation, prefill); policy rules naming DHCP / SLAAC devices and interfaces in the simulation and a snapshot, the configured model's undecided case, renewal and expiry, overlapping addresses in two VRFs; a send counts as a check's evidence only with its whole identity; an unsettled run is provisional; capacity by topics, responders, zero sizes, live members and direction; NTP stratum feasibility; a broadcast's source by VRF, usability and state. In the browser: a held dot whose track leaves the scene (filter, collapsed group, IP / Non-IP, redraw) lets go of its hold. |
| **Post-#93 findings** | `test/policy-identity.test.mjs` (4 tests), `test/source-binding.test.mjs` (3 tests), `test/interconnect-refs.test.mjs` (5 tests), and additions to `analysis-correctness`, `experiment-play`, `sim-barrier`, `sim-tcp-connections`, `transit-edit-browser` | Destination identity with the same address in two VRFs (static, simulation, snapshot; an address alone with two holders undecided); policy uncertainty carried as structure through a routed firewall to the policy layer and expectations, a rule a known service can't match, an earlier undecided rule, mixed lists; an exact source address against a send's recorded source (IPv4 and IPv6 aliases, an unusable alias, interface bindings, the one-interface case); `traffic:` references followed by device and port renames (vme-rack.yaml, undo/redo, export, deletion, in the browser) and execution scopes (a recipient beyond a transit, a transit outside, initiators outside); capacity along a bound listener's interface and in IPv6; lease renewal, expiry and reassignment proven; BGP and LDP sessions down and up again with bounded connections of their own; a large moment at the playback cap (budget yields, the run's end, a held delivery after it); an action while a moment is partly done. |
| **Protocol realism** | `test/sim-fhrp-identity.test.mjs` (14 tests), `test/sim-ntp-associations.test.mjs` (8), `test/sim-peer-ports.test.mjs` (2), `test/sim-audit.test.mjs` (5), and additions to `policy-identity`, `sim-ntp`, `sim-routing-exchange`, `sim-isis`, `sim-rip`, `sim-ike`, `sim-multicast`, `sim-ptp`, `sim-tcp-correctness`, `sim-tcp-connections`, `sim-dhcp-dns`, `sim-ipv6`, `sim`, `analysis-correctness`, `source-binding`, `sim-barrier` | First-hop redundancy by what the protocol carries (VRFs named differently, two LANs reusing a group, IPv4 and IPv6), VRRP preemption by the master down timer, HSRP's own tie rule and version 2, the headers as sent; NTP upstreams as addresses (a loopback with and without a route, two addresses of one server, a policy, overlapping addresses, IPv6, a reboot), the reach check exactly 8 polls, observations, a boot; policy owners several hops away and over equal-cost next hops, a written rule base for relations, a path to another holder not reaching the destination; OSPF's DBD checks (RFC 2328 §10.6); EIGRP's reliable init, IS-IS one-way detection and periodic CSNPs, RIP's Request at boot; BFD's one stream, slow rate and scope; the UDP ports between peers; LACP's rates and mux machine; IKEv2's SA identity, rekeyed message IDs, DPD and the responder's rekey; IGMPv3 records and per-source state, the RP's (S,G) prune, the PTP announce receipt timeout; TCP's RTO (RFC 6298), a test's connection ended with it; DNS CNAME across zones and refusal by a host without DNS, DHCPv6 REQ_MAX_RT, NDP's unsolicited NA, answers scheduled before a power cycle; BGP's passive OPEN; capacity from the client's egress address; exact-source boundaries; non-IP traffic under display settings. 65 of them fail on dev. |
| **Post-#95 correctness** | additions to `sim-ike`, `policy-identity`, `sim-routing-exchange`, `sim-ntp-associations`, `sim-fhrp-identity`, `sim-multicast` | An IKE SA rekey with its response lost (once, twice), a late original, a Child SA rekey waiting behind it, a DPD across the rekey, the responder rekeying — the same new SA on both ends, message IDs, traffic through the tunnel; the owner local only in the VRF walked (interface order, permit and deny, failure and recovery), two gateways on one shared LAN (each its owner); GRE through a written rule base (deny all, proto any, tcp only — simulation and static); an EIGRP ACK of an earlier adjacency after a restart; a cold start with the upstream reached only through OSPF; two HSRP groups with their own relations; an IGMPv3 BLOCK of an unknown source. |
| **Pacing** | `test/sim-pacing.test.mjs` (16 tests) | **Readable:** 3 s for a typical hop, monotonic in the latency, clamped to 2 and 6 s; the speeds 0.1× … 4× with 1× the default; the pulse and the ✕ 1.5 s; **Proportional:** the scale, at least 0.2 s and at most 30 s; the descriptions (*Readable · 3 s per hop · 1×*). **Speed limit:** at most 70 px a second at 100 % zoom (700 px: 10 s), in both modes, for every hop of a run. **The cause:** a hop shown keeps exactly its paced time on screen (to the frame) whatever the simulation does meanwhile; a jump through hidden traffic does a bounded amount of work per frame. **Full path:** every hop of a frame shown for its paced time, a continuing hop starting when the one before it arrived, crossing the switch first; in the logical view along relations and network lines; the simulated clock never past a hop waited for on screen (checked every frame), Real time waiting for none. **Speed, skipping, Step, a lost message, Follow, the dot limit, a jump, determinism** as before. |
| **Senders** | `test/sim-senders.test.mjs` (3 tests), `test/sim-senders-browser.test.mjs` (2 tests, through the DevTools protocol) | **Engine:** every message and dot has its sender and origin; an ARP reply, srv's SYN-ACK and RST to pc1, a router's ICMP error about pc1's packet carry pc1's exchange; a forwarded frame keeps its sender; with pc1 the only sender no other endpoint sends test traffic, pc1 still does, and every protocol's sessions reach the same states (OSPF Full); the change logged; deterministic. **On screen:** nothing selected: every device (*Senders (all 22)*, its accessible name); the dialog's order (protocols, senders open, parameters collapsed); the groups by type with counts (*Routers (4 of 4)*), None, By type ▾ → Routers (*Senders (4 of 22): branch router, r1, r2…*), the icons and L2 / L3 badges, a group folded, by group / site, the filter, All; pc1 selected in the diagram: preselected, Selected in diagram available; the setup panel's order with Senders collapsed and its summary; remembered for the next start. Running with pc1: only its exchanges in the log (replies by others among them) and as dots, the others counted (*… messages from non-senders hidden*), Show all senders listing them; OSPF Full; the badge on pc1 only (named, in the export); r1's menu: Use as sender (logged, the summary, both badges, Stop as sender in Actions); All in the panel: no badges, nothing hidden; the model unchanged. |
| **Panel, inspector, tab, pace** | `test/sim-pause.test.mjs` (4 tests, through the DevTools protocol) | **The panel:** heights remembered under the old keys ignored; its three-row minimum, the diagram more than twice as high, 3 rows of log and status, the toolbar in view; dragged 80 px up (exact, stored under `netatlas.simPanelHeight3`), ↓ with the keyboard, remembered over Exit and Start, a double-click resets it and removes the key; at 800 × 640 and 800 × 450 (200 % zoom) the toolbar in view and no page scroll. **The inspector:** a log message opens it and pauses (*Paused: inspecting packet*, announced); × resumes (*Playing*), Esc too, a click in the diagram too (the inspector stays open), the focus to another control too, out of sight too; paused by the user first: stays paused after closing; Play while inspecting plays, Pause then stays paused after closing; Follow message plays beside the open inspector. **A hidden tab:** the clock stops, still meant to play, goes on when visible; paused before: stays paused. **The pace measured:** with real frames over 16 s every hop took at least 2 s of real time, and no line is crossed faster than 70 px a second. |
| **Parallel exchanges** | `test/sim-parallel.test.mjs` (11 tests) | **Startup:** nothing is sent before the links are up (the link-up delay); ARP, OSPF and PIM Hellos, VRRP and IGMP then start together, their simulated intervals overlapping. **Unicast:** waits only for its own next hop (the packet via the gateway answered at once while another next hop is unresolved; each says *waiting for ARP x*; packets for one next hop leave together). **BGP:** ARP → SYN → SYN-ACK → OPEN → Established → UPDATE, *OPEN waiting for TCP*, the OPEN's *waited* and *caused by*. **Tunnels:** the link, IKE_SA_INIT, IKE_AUTH, Established, GRE up, the tunnel up, OSPF inside, in that order; the GRE keepalive waits for IPsec, nothing dropped as *not up*. **PIM:** Hellos at once; the Join waits for its RPF route, the Register for a route to the RP and goes with it (its wait recorded); no *cannot join*. **Independence:** two islands go through the same steps at the same moments, their first hops overlapping; restored together they reconverge together. **Determinism:** the same events at the same times twice; the jitter under its share of a hop; ties in sequence order; another model jitters differently. **Pacing:** a dot limit of 1 or 48 and both modes give the same simulated times (the hops not drawn still sent); several protocols on screen at once at the start. **The log:** waiting rows with their reason; the events of one moment adjacent. |
| **Parallel on screen, three-row panel** | `test/sim-parallel-browser.test.mjs` (5 tests, through the DevTools protocol) | **Dots:** at the start dots of at least 4 protocols in flight at once. **The log:** same-moment groups (a ditto mark hidden from assistive technology, the time for a screen reader), *waiting* rows with their reasons found by the filter; the packet inspector's *Timing* (a BGP OPEN waited for its TCP connection, caused by the SYN-ACK). **The panel**, light and dark: at 1920 × 1080 at 100 %, 150 % and 200 % and at 800 × 640 (tabs) exactly 3 status and 3 log rows in view, the default equal to the minimum, the diagram larger, no page scroll. **Height:** the old key's value ignored and left alone, stored under `netatlas.simPanelHeight3`, never lower than three rows, a double-click and Enter reset it and remove the key. |
| **Send test at once** | `test/sim-send-test.test.mjs` (5 tests), `test/sim-send-test-browser.test.mjs` (3 tests, through the DevTools protocol) | A test starts at the current simulated time while other traffic is in flight, its first message leaving at once; its waits are only ARP / NDP, DNS and a DHCP lease (a test by name from a client without its lease: the lease, then DNS, then the SYN). **Marked:** its packets, their ARP, the replies, a RST, an ICMP error, its state line; no routing protocol or other traffic. **Pacing:** at the dot limit its hops are drawn at once, one after the other, each delivered when its dot arrived, never behind the traffic on screen. **Deterministic** with tests at given times, however the time is advanced. **On screen:** drawn and listed despite the senders and the protocols, *Test ·* in the label and **Test** in the log, a trail; during the startup burst drawn at once; paused, *Sent at t = … It starts when the simulation plays.* (the time unchanged) and **Send and play**; a series of four 0.5 s apart: paused, nothing more sent; played at 1× and 4×, the same simulated times (fewer frames at 4×). |
| **TCP flags, lifecycle and the handshake on screen** | `test/sim-tcp-correctness.test.mjs` (15 tests), `test/tcp-flags-browser.test.mjs` (2 tests, through the DevTools protocol: light / physical, dark / logical) | **The notation:** S, F, R, P, A, U, E, C in that order, `[]` for none, the long names; every label of every TCP dot (a fresh connection, the examples' BGP, LDP, HTTPS, MQTT) gives its header's flags, no TCP header made up outside the transport. **The handshake:** [S], [S,A], [A] three dots in causal order with their numbers; in the logical view along the relation (the listener's SYN-ACK too), one dot per segment, the dot's headers and conversation shared with the physical one. **Bundling:** in busy models no drawn handshake cut after its SYN, the background still bundled; Follow message draws every segment. **Correctness:** the health check's third ACK before its RST; power-off with unacknowledged data and a reboot — nothing of the old connection; [R] at SEG.ACK for a segment with an ACK, [R,A] seq 0 otherwise; an ACK beyond SND.NXT dropped and answered; SYN-RECEIVED's wrong ACK answered with [R]; a lost last ACK — the FIN again, TIME_WAIT again; half-close (CLOSE_WAIT, data after the FIN); the MSS of each SYN; two connections between the same hosts two conversations. **In the browser:** [S], [S,A], [A], [P,A] dots of a TCP test, each label's flags those its inspector lists. |
| **Routing information, exchanges and the remaining protocols** | `test/sim-routing-scope.test.mjs` (3), `test/sim-rip.test.mjs` (6), `test/sim-isis.test.mjs` (3), `test/sim-routing-exchange.test.mjs` (4), `test/sim-fhrp.test.mjs` (4), `test/sim-ike.test.mjs` (4), `test/sim-sessions.test.mjs` (2), `test/sim-identity.test.mjs` (2), `test/sim-audit.test.mjs` (4) | **Instances:** BGP UPDATEs lost, OSPF up — no BGP route (on dev there is one); learning gated by the state machine, another instance's and stale records ignored. **RIP:** metrics hop by hop, poisoned reverse, withdrawal by a triggered update within 1–5 s, a 180 s timeout and garbage collection, an interface down at once, an export filter. **IS-IS:** an adjacency between subnets and over unnumbered interfaces (a ping through), level 1 across areas and a duplicate system ID refused. **OSPF:** master and slave by router ID, an MTU mismatch stuck in ExStart; DROthers through the DR's record. **EIGRP:** a Query answered by a Reply, stuck in active. **FHRP:** HSRP Active, Standby, Listen with their Hellos (UDP 1985, TTL 1, the MACs), failover and Coup / Resign; VRRP's owner and TTL 255. **IKEv2:** a lost IKE_AUTH sent again with its ID, each end's own DPD, recovery, a rekey answered or lost. **TLS** flights and **WireGuard**'s timers. **Identities:** a MAC written twice kept whatever the order; an unrelated device changes no MAC and no timing. **Audit:** BFD's detection by the peer's values, PIM's DR by its Hellos, DNS forwarders asked (SERVFAIL), LACP one partner per aggregate. DHCP's legs through a UDP-67 firewall, its VRF and renewals sent again are in `test/sim-dhcp-dns.test.mjs`; MLD's source, Router Alert and lengths and the RP set from Bootstraps in `test/sim-multicast.test.mjs`; static DAD in `test/sim-ipv6-lifecycle.test.mjs`; PAT of echoes and PMTUD through NAT in `test/sim-vrf.test.mjs`; NTP's learned stratum in `test/sim-ntp.test.mjs`. |
| **Send test's sources** | `test/send-test.test.mjs` (6 tests) | Every device a source (guest-phone among them), the others listed with the reason from the capability resolver (a Cloud, a TAP, a passive IDS: no IP stack; a switch without an address); a DHCP client before its lease (the test waits, nothing invented) and after it (lease, server, gateway, DNS, Wi-Fi network and VLAN; the test from the leased address); DHCP without an answer (the waiting test ends with the reason, the device stays a source); no stale lease after its link went down; an interface chosen as the source (its address and VRF, an unknown one refused); a policy-denied Guest test sent and ending where the DSL router dropped it, an unreachable one ending otherwise. |
| **Send test's plan** | `test/send-test-plan.test.mjs` (12 tests) | **Shared rules:** the protocols of each delivery type (no TCP for multicast or broadcast), ports for TCP and UDP only (none while the protocol is unselected, an ICMP plan with a port refused), what is missing named in the form's order; counts (0, 1.5, 1001, NaN refused) and intervals (0, negative, NaN, ∞, above 3600, below 0.01 refused; none needed for one message). **Labels:** *name - address* per interface, a DHCP lease before and after, two addresses of one interface as two destinations, the ISP *Cannot send IP packets*. **Unicast:** the destination interface chosen is the target (a DHCP lease found when sent; the DSL router's *wan*); several need a choice; an address that interface lacks refused. **Ports:** an ICMP test's packets carry none. **100 messages at 1 s:** exactly 100 originating echo requests at t0 … t0 + 99 s, deterministic, under 5 s; a series not waiting for replies; **Stop** (nothing more sent, those on their way finish), stopping all; the clock run in small steps or at once giving the same times. **Multicast:** members receive it, a group without members nobody; IPv6 groups need an IPv6 address. **Local broadcast:** limited and subnet scope, never past the router, not into another VLAN of the house. **Directed broadcast:** a subnet of the model and not the source's own; dropped where off, answered where on. |
| **Multicast drawn, interface states** | `test/mcast-actions.test.mjs` (4 tests), `test/mcast-iface-browser.test.mjs` (2 tests, through the DevTools protocol, both themes) | **Multicast:** the house offers only IGMP / MLD to tick (the core's VLAN 20 snooping querier), no streams; a join's two reports from tv's Wi-Fi interface carry its event's id (never a test's), no datagram among them; a stream's datagrams from nas, copies on the VLAN 10 path, none towards another VLAN or past the core; 3 datagrams sent counted apart from their copies; the event says it stops at core (no PIM); the first datagram in the log for the inspector. With a router and a member: the copies reach the member, not a host that is none; Stop: no datagram after it; the join recorded; the model's own reports not marked, the join's later answers not either, its leave report marked. The same times whether run in steps or at once, nothing while the clock stands. **Interfaces:** administrative and operational state apart; Shut interface during flapping stops it first and stays down 60 s later; a shut interface can't flap; one flapping per cable from either end; Bring interface up; Stop flapping in the down phase brings the cable up, no later transition; the peer off said so. **On screen:** the join's and the stream's dots drawn at once while paused, the clock still; their copies when playing; a stream dot opening the inspector (UDP to the group); Stop: nothing after; the form marked *↯ Flapping* with Stop flapping, a quick second press not stopping it, another interface unmarked, the flap's transition followed; Shut stopping the flapping (both events), *⏻ Shut* with Bring interface up, flapping disabled with the reason; Bring interface up by Enter, the focus kept, the link up later; changes from the diagram's menu and Active events followed; the peer off; a bar and bold words, not colour alone; a new simulation without any of it. |
| **IGMP startup and concurrency** | `test/sim-concurrency.test.mjs` (7 tests, the fake clock), `test/concurrency-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450 — 200 % zoom) | **Startup:** the private house's core queries VLAN 20 at t = 2000 ms and 33 250 ms, its table *query at t = 33.3 s (startup 2 of 2)*; every fresh simulation has the same deadlines; a model without a candidate has no query. **Concurrency:** two independent sends at once both on their way at the same time; the causal order on screen (a hop after the one before it, the reply after the request's last hop, the packet ARP released after the ARP reply), and no reply computed before its request arrived on screen; the same events whatever is drawn; each frame's work bounded. **Attribution:** a send's request, ARP and reply carry its id and are the foreground; the scenario the background while it runs, never an OSPF Hello in front; done and arrived, nothing muted. **On screen:** an IGMP dot after the startup's earlier first messages, the core's badge *VLAN 20 · Querier (startup)*, the deadline in the election table, *scheduled* in the diagnostics; a stream and a series both in front; grey `.sim-bg` dots, no `data-flight`, `pointer-events: none`, no outline and no inspector from them; the inspector kept; nothing grey after both stopped. |
| **Foreground and background** | `test/sim-foreground.test.mjs` (6 tests), `test/sim-foreground-browser.test.mjs` (2 tests, through the DevTools protocol, both themes) | **On screen:** the scenario at most 6 exchanges as dots, lit cables with *protocol ×n* counts, the note; a stream from pc1 in front (*· streams in real time*, a datagram every real second in Readable pacing, its dots drawn, the scenario's hops since then not), a stream dot opening the inspector among the activity; Next exchange named, paused after it; Real time: simulated time with the real seconds (never ahead), a datagram a second; stopped, the scenario in front again. **Model** (a fake real clock): on `protocol-simulation.yaml`, a 1 s stream in Readable pacing sends 21 datagrams in 20 s, at least 3 on their way at once, each hop readable, each delivery after its dot, *· streams in real time*; while it runs the scenario's hops are cable activity (by cable and protocol); stopped, its sends cancelled and the scenario the foreground again. Bundling: never more than 6 of the scenario's conversations on their way as dots, several at once, the rest activity, no dot passed by the clock, no run-away. Real time: 5 s of display = 5 s simulated, a 1 s stream sends 11 datagrams in 10 s and still one a second at 2×, every hop 0.8 s, nothing holds the clock, a slow machine falls behind without a burst. Next exchange: the exchange first on screen ends. A Step, Next exchange or a jump while a stream runs: the clock goes on from there, never catching up in a burst (at most 2 s simulated in 2 s). |
| **Streams in real time** | `test/sim-realtime.test.mjs` (11 tests, a fake clock), `test/realtime-streams-browser.test.mjs` (2 tests, through the DevTools protocol, both themes), `test/mcast-actions.test.mjs`, `test/network-events.test.mjs` | **The schedule:** the first send at once, then every 1 s, 2 s, 250 ms, never early and within a frame of its deadline; two entries of 1 s at 0, 1, 2, 3 s in the same frames, in the order added (*abababab*); other intervals and start times each on their own grid, the same deadline in the order added; 20 000 irregularly late frames leave the last send within 110 ms of its deadline (no drift); a 3.5 s stall sends once for the latest deadline and counts 2 skipped, then the grid goes on; paused, nothing sent and nothing caught up after; a removed entry never sends again, even from the pump under way; clear removes all. **Streams:** two 1 s streams (srv, pc2 to 239.1.1.1) send 4 each in 3 s at the same simulated moments, 11 each in 10 s, both reach pc1 and rx; a 1 s and a 2 s stream started 0.4 s apart keep their counts (7 and 3 in 6 s); 3 s of real time with the clock standing still send 3 datagrams at that moment (no waiting for forwarding); 2 minutes of simulated time alone send none; Stop one, the other goes on; paused: *Paused*, then on from there; a second Start is refused (no second schedule); closed: nothing more; the source off: nothing sent, *not sending: srv is off*, *3 while srv was off*, then on its grid again after booting; the model's streams stay on simulated time; Start again from the menu is one schedule. **On screen:** two streams from the form, each a datagram every real second within two (5 s measured), side by side within one, both with at least 2 datagrams on their way at once, both *Paused* and not counting while paused, a dot of the second opening the inspector with port 5012, Stop one and the other goes on. |
| **Device state** | `test/device-state.test.mjs` (5 tests), `test/realtime-streams-browser.test.mjs` (both themes), `test/events-status-snooping-browser.test.mjs` | **Model:** operational, powered off, booting (until its boot time, not a millisecond before), operational again, each with its words, the same state as `deviceOn` (packet processing); powered off while booting and on again: the first boot never completes the second; a shut interface, a failed cable, the gateway off leave a device operational (only r3 marked); an external network *External*, a pass-through *Passive*, a device the simulation lacks *Unknown*; a guest *down with its host hv2*; a new simulation all operational. **On screen:** every device's indicator, *lab-h* *Operational*; powered off: *Powered off*, its tooltip and accessible name *Powered off at t = …*, the outline marked, the box neither moved nor resized, its label clear, the menu's state line and *Power on*; powered on: *Booting* with *up at t = …*, still booting a millisecond before, operational after; a shut interface of srv marks no device; *inet* *External*, no Power off; Exit clears every indicator and mark. |
| **Every device's status, Expand all / Collapse all, snooping on screen** | `test/events-status-snooping-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450 — 200 % zoom) | **Status:** all 14 devices of the private house with an indicator (13 *Operational* with the theme's green LED, *isp* *External*), its role and accessible name its tooltip, none over a text or port mark or another indicator (in the drawing's coordinates), every box where it was before the simulation, through Power off / on and after Exit; *Powered off*, *Booting*, *Operational* again after the boot time; a shut interface leaves the device *Operational*; the menu's state line equals the tooltip; the diagram's accessible name lists *powered off: ap-1*. **Bulk:** the accessible names and tooltips, mixed (both enabled), Expand all by Enter (all open, it disabled, the focus on Collapse all), Collapse all by Space (all closed, it disabled, the focus back), Active events and More options untouched, the heading and buttons not moving, a typed group kept, a running stream still counting, nothing wider than the panel. **Snooping:** dist's rows (10, 20, 30 enabled, 99 disabled), *Not configured* an error and gone from the YAML, chosen again; the thermostat's stream only to dist and core (*stops at core*), the core's snooping table empty with its notes, the TV's join in the open table without reopening it, *Show group memberships*, no table viewer among Network events. |
| **Querier election, members, leaves, interface flapping** | `test/querier-election.test.mjs` (11 tests, the fake clock), `test/querier-leave-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450), the internal example `multicast-querier.yaml` | **Election:** down before the interfaces are up; every candidate queries at once (q1, q2), q2 hears q1 and stops, q1 *starting* then *querier* after its 2 startup queries 5 s apart, then one every 20 s, q2 none; the tables; the query's addresses. **Scope:** LAN B (the same VLAN 10) elects q3; the hosts say who queries them; one router on two LANs: querier on one, non-querier on the other; no candidate at all (snooping enabled is none): no query, the host says none heard. **Failover / recovery:** q1 off, q2 takes over exactly 45 s after q1's last query, then every 20 s; q1 back: two startup queries 5 s apart, then every 20 s (no duplicate schedule), q2 silent. **Flapping** q1's port: its candidacy down and up again, startup each time, q2 never queries. **Members:** still learned at 200 s (membership interval 50 s) through ≥ 8 answers; a cable down drops the switch's port, not the host's membership; learned again from its next answer. **Leave:** refused for a group or host without membership; the watch (sw port p4, q1:g0, q2:g0); *cleanup pending (3 of 3)* until removed at the switch's port and kept at the routers (rx2 answered the one group query); the leave report inspectable; delivery to rx1 stops, rx2 and the source go on; no later answer from rx1; rx3 leaving keeps the shared port (rx4 answers); a leave that can't be sent fails with its reason; MLD named as MLD. **Interfaces only:** a cable refused by the simulation, a port flaps (admin up, link down), the model's `flapping: "on"` on a port. **On screen:** the query dots of q1, q2, q3; dashed *Querier (startup) · VLAN 10* on q1 and q3, then *Querier · VLAN 10*, *Standby · VLAN 10* on q2; clear of texts, ports and statuses; boxes unmoved; Show querier election; the six actions in order, Leave in Expand all; no group chosen for you, the note; Enter on Leave group; the event's summaries; the packet inspector's TO_IN; q1 off: q2's mark; Exit clears all. |
| **Join and leave timing, stable packet labels, fitted badges** | `test/mcast-timing.test.mjs` (5 tests, the fake clock), `test/labels-badges-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450 — 200 % zoom), the internal example `multicast-querier.yaml` (shared port) | **Join:** every core decision before the report's processing leaves the TV out, every one after sends it (*member port*), no query in between, the same stream. **Leave:** *cleanup pending*; the core's port expires exactly 2000 ms after the leave (no sweep delay), *nobody answered the group-specific queries after the leave*; meanwhile the decisions say *member port, leave pending: it goes in n s*; none after it sends to the TV, no copy on l-core-apb after it; *removed at core*; the stream keeps running. **Shared port:** rx3 leaves, rx4 behind the same port answers: p6 kept, p5 (rx2) and the router port p1 still sent, p4 never; *kept at sw (VLAN 10, port p6)*. **Same moment:** a packet, a report, a packet at one instant: before and after; at the expiry moment the entry is gone. **On screen:** every copy within 1 s of being forwarded (no backlog); no TV copy after the removal; the pending ones drawn to their end, at most a hop's time later. **Labels:** the same slot from appearance to arrival for every foreground and background label, never more than 40 px from its dot, every moving foreground dot labelled, the inspector still opens. **Badges:** 2–6 px before the sign, 2–8 px after the text, short ones shorter, one column, clear of texts and indicators, one VLAN fitted, a role change refits in place. |
| **Multicast forwarding by port roles, snooping roles per VLAN, background labels** | `test/mcast-forwarding.test.mjs` (10 tests, the fake clock), `test/mcast-roles-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450 — 200 % zoom), the internal example `snooping-roles.yaml` | **Private house:** the thermostat's VLAN 20 stream to dist's router port up only (*multicast router port (n min left)*), not to ap1 (*no member and no multicast router port*), never back to ap2; the core's Layer 2 decision (no port) and Layer 3 (*routes no multicast*); as the house was (no querier in VLAN 10): no router port at dist although the core is Layer 3, the laptop's stream ends at dist, the NAS's report reaches the core only, the core shows the member, nothing arrives; now: the stream to the core, the NAS's join learned at the core's port nas only (none at dist), the next datagram delivered, no extra query, no other group, no leak to other VLANs; leave, cable failure (port gone at once, learned again from the next answer), a new simulation empty; the TV in VLAN 20 joining the VLAN 10 group gets nothing (no PIM, said); `unregistered_multicast: flood` floods at dist and core alike, VLAN 20 unaffected. **Roles:** sw-a's four VLANs Querier / Standby / Snooping · querier heard / Snooping · no querier, with the querier's identity and router ports apart; LAN B's querier in the same VLAN ID never lent; failover, a querier lost, Off and back, reset; the snooping table's lines equal the badges; queries agree with the roles. **On screen:** four badges in VLAN order, one width, clear of every text and indicator, tooltip = accessible name = the model's detail, the same place and size after a role change, kept while an action is in front, all in the SVG export, gone on Exit; the inspector's *Switching at dist (sent this hop)* port by port; background labels grey, short, `pointer-events: none`, not under the pointer, gone when your actions end. |
| **IGMP / MLD snooping per VLAN** | `test/snooping.test.mjs` (8 tests), `test/sim-multicast.test.mjs` (snooping tests rewritten), `test/sim-levels.test.mjs`, `test/mcast-actions.test.mjs` | **Format:** enabled / disabled per VLAN or range, the model's ranges, `snoopingChoice`, the errors (a wrong value, a VLAN twice, not a mapping, not a switch) and the warning for a VLAN no port carries; the check `snooping-not-configured` (an error, its VLANs listed; a routed port and a VLAN interface alone need none; disabled counts as a choice); the removed attributes `igmp_snooping` / `unknown_multicast` as errors that say where snooping lives. **Forwarding:** nothing to any host before a join; a join opens its own port, its group, its VLAN only (not the same group from VLAN 20, not another group, not h2); never back to the source; the log's *forwards … to no port*; reports only to router ports, queries flooded; refresh by answers to queries (still there at 90 s with a 30 s membership interval), a leave (after the last member queries), a link down (at once, logged), learned again after the restore, expiry of a host powered off, a switch powered off, a new simulation empty; IPv6 (MLDv2 member, ff05::1 to its member only, the host's memberships); a Layer 3 switch without PIM routes nothing to VLAN 20, with PIM (dense) to its member only. **The private house:** the six scenarios (no join; the TV's join, only towards ap-b and the TV; leave; nothing into Internal or Guest; the TV moved to Internal gets nothing without multicast routing, its membership in VLAN 10); disabled floods, not configured floods and says so. |
| **Model format, applications, support levels** | `test/applications.test.mjs` (8 tests), `test/support.test.mjs` (3 tests), `test/validate.test.mjs` | The earlier `dhcp: true` an unknown key saying to write `ipv4: dhcp`; applications on host-capable Endpoints (a PLC, an HMI) and not on a TAP, a monitoring System or a Security gateway; each profile's fields, required by the others' values; listener conflicts (also with a service's port), peers missing or of a profile that can't answer, bind interfaces, `count` without `interval`, MQTT topics and filters, client identifiers per broker; Add, Duplicate, rename (peers follow), Remove listing the references, one undo step each; every protocol, service and profile has a support statement, user-defined protocols are *Diagram only*. |
| **Applications and traffic profiles in the simulation** | `test/sim-apps.test.mjs` (9 tests, the fake clock) | No application traffic until started; a TCP client and its listener, answered with the listener's response size, a series of 3 every 2 s; periodic one-way UDP messages that nothing answers; a bind interface (the device's other address refused); the application's address family, IPv6 when it says so, no fallback to IPv4; a request that times out retried up to its retries and counted once; several applications at once, each its own event, Stop ending a series; `start: simulation_start`; a host name resolved by DNS (AAAA for IPv6) before the connection. |
| **MQTT** | `test/sim-mqtt.test.mjs` (10 tests, the fake clock), the public example `ot-network.yaml` | CONNECT / CONNACK, SUBSCRIBE / SUBACK, PUBLISH and the broker's fan-out to matching filters (`+`, `#`, `$` topics), the lower QoS of the two, QoS 1 with PUBACK and a DUP retry (a subscriber's cable down), keep-alive and the broker's 1.5 × timeout, a reconnect, UNSUBSCRIBE and DISCONNECT on Stop, a client identifier in use taking the session over, the tables, no payload in the inspection; in `ot-network.yaml` the dashboard gets the temperature only, the alarm log nothing. |
| **IPv6 host configuration** | `test/sim-ipv6.test.mjs` (11 tests, the fake clock), the public example `private-house.yaml` | The format (methods, `ipv6_ra` with required prefixes, /64 for SLAAC, lifetimes, router lifetime against the interval, DHCPv6 scopes without a gateway); link-local addresses and DAD; RS / RA; SLAAC with lifetimes and the two-hour rule; default router expiry; a duplicate address; RDNSS; stateful and stateless DHCPv6, renew, rebind, expiry; the statuses; in `private-house.yaml` the laptop and the phone dual-stack, an IPv4 test waiting for the DHCP lease even when the SLAAC address is ready first. |
| **NTP and PTP** | `test/sim-ntp.test.mjs` (3 tests), `test/sim-ptp.test.mjs` (10 tests), the public example `timing-ptp.yaml` | NTP: serving versus synchronized, the stratum from the source, unsynchronized after 8 unanswered polls, an upstream outside the model. PTP: the format and what each clock function needs; the election and the port states; offsets within the lock threshold from the modelled timestamps, the path delay of the cables, the scheduler untouched; a transparent clock correcting more than 1 ms of queueing (without it the path delay holds the queueing and the boundary clock does not lock); grandmaster loss and recovery; a boundary clock's upstream failing; domains and islands kept apart; the data set comparison; a reset; in `timing-ptp.yaml` gm-b taking over while gm-a is off and gm-a winning again. |
| **Applications, IPv6, MQTT and PTP on screen** | `test/apps-ipv6-ptp-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 × 900, light at 720 × 450) | The thermostat's applications collapsed to one line each, Advanced closed, the support note opened with `Enter`, Add application focusing the profile, Duplicate, Remove listing tv/control first, one undo step each; the laptop's IPv6 method, the core's router advertisements with Advanced closed; Start application and the MQTT sessions and deliveries in `ot-network.yaml`; the PTP marks in `timing-ptp.yaml` clear of texts and ports with their tooltips, the boxes unmoved, Show PTP clock, the failover, Exit clearing the marks; no sideways scrolling. |
| **Network events** | `test/network-events.test.mjs` (10 tests), `test/network-events-browser.test.mjs` (3 tests, through the DevTools protocol: light and dark at 1440 px, light at 640 px) | **Lifecycle:** every operation one event with a stable id, refused ones *Failed* with the simulation's reason, the older programmatic send listed too; a series of 20 one event with *sent of requested*, pending never failed, completed with its last answer's time; a series with failures still *Completed*; a broadcast without answers *unknown* and no rate; a group's members apart from its messages; a DHCP client's send *Queued* until its lease, Stop then *Cancelled* with nothing on the wire; a join *In progress* until q1 records it, then *Completed* with its membership and Leave group (completed 2 min later too), without a router completed after its reports; a stream's datagrams and each member's count, stopped; a shut *Completed* at once with the interface down and No shut, not listed twice; flapping's cycles (3 by 35 s), stopped part way; a failed cable and a device off in the list; the same states whether run in steps or at once; at most 50 kept, those in progress never dropped, Clear finished. **On screen:** the four actions in order as headings with their forms (no object list, no Show …), Active events after them; the tables in the device's menu and the status side; each form's device and interface (Select…, disabled until a device), its reason; the diagram's selection not changing the join form; a join, a stream, flapping (not twice), a shut and a series listed newest first with their states (icon and word), a named progress bar, paused without moving on; details open and the focus kept over four updates; the inspector from the details; Stop keeping the focus in its event; No shut; the outcome bar named; a failed cable with Restore; Clear finished keeping the flapping, the cable and the membership, the focus on the heading; nothing wider than the panel, no sideways scrolling, every control named. |
| **Send test's form** | `test/send-test-form-browser.test.mjs` (2 tests, through the DevTools protocol, both themes) | Nothing chosen: From and To disabled and greyed, Send disabled, the hint once; unicast: every device in From (the ISP disabled, *Cannot send IP packets*), the guest phone's one interface as text before and after its lease, the core's interfaces as options with *Chosen by routing*, the destination's interface (one shown, four a choice, cleared with another device); a port only for TCP and UDP and empty, cleared when ICMP is chosen; the interval greyed for one message; another delivery type clearing what doesn't fit (TCP and the destination for a group) and keeping what does (UDP and its port for a broadcast); the subnet scope's address; a directed broadcast to a subnet outside the model blocked; a Guest test dropped by the policy; a series as one event of Active events with its progress (*1/3 sent*, *1 pending*, then *3 answered* and its named outcome bar) and Stop, stopped where it was; every control named, nothing wider than the panel; Send network packets… from the ISP's menu. |
| **Packet hit area** | `test/sim-packet-hit.test.mjs` (1 test), `test/sim-packet-hit-browser.test.mjs` (2 tests, through the DevTools protocol, both themes) | The nearest dot within 12 screen pixels at 50 %, 100 % and 200 % zoom, ties to the earlier message, none beyond. **On screen:** 9 px beside a dot it is outlined (a ring of the same size at every zoom, the hand) and a click opens that packet; 20 px away neither; the inspector keeps its packet while the simulation moves on; the outline gone when the pointer leaves; a device clicked away from the dots selected; the event log opening a packet by the keyboard. |
| **Even pacing from the first packet** | `test/sim-pacing-browser.test.mjs` (1 test, through the DevTools protocol) | In a real browser, the screen time of every hop (moving to arrival) ÷ its configured time is 0.95–1.06 for the first packets after the start, with the main thread blocked 400 ms before the first frame and the startup burst beyond the dot limit, and for messages a minute later; the first frame counts 0, no frame more than 100 ms; a hidden tab stops the clock and nothing jumps after it; the same hop is given the same time early and late. |
| **Exit simulation** | `test/sim-exit.test.mjs` (2 tests, through the DevTools protocol) | By `Esc`, the banner, the simulation panel, the Simulate menu and the palette, from the Edit, Details and YAML tabs: no *Editing is paused* notice or disabled Exit button, no read-only form, the outline's Add buttons enabled, an edit applied at once; the tab and the selection back; no panel, setup, actions, banner, border label, table, packet inspector or dot. Closing or replacing the model during a simulation: the same. |
| **Layer order and the simulation indicator** | `test/zorder.test.mjs` (4 tests, through the DevTools protocol) | **The token scale** in `:root` (diagram < overlays < panels < toolbar < menus / popovers < tooltips < dialogs < announcements) and every `z-index` of the stylesheet on it. **During a simulation, in both themes:** `elementFromPoint` at the edges and corners of every top-bar menu that reaches the diagram, the palette, the in-diagram menu and the packet inspector finds the menu itself, never the border or the simulation panel; the border is a solid 2 px inset `box-shadow` with `pointer-events: none` and at least 3:1 against the canvas; the label reads *◈ Simulation running*. |
| **Attributes at their level** | `test/sim-levels.test.mjs` (8 tests) | **The audit:** every attribute's level (device, interface, VLAN, relation, service). **Precedence** configured → object → device → simulation → default, *Inherited: device* on an object. **Wrong level:** a port's attribute on the device, a device's on a port, a VLAN attribute without a VLAN, one that doesn't apply: errors that say where it belongs, never moved. **Per-port spanning tree in the simulation:** bridge priority elects the root, port cost picks the root port, root guard blocks a port with a better root behind it; PVST and MSTP priorities per VLAN; an edge port forwarding at once with STP while a host port without it waits 2 × forward delay; BPDU guard err-disabling a port; a shared link waiting like STP; storm control and the link-up delay per port. **The Edit tab:** an interface's attribute written in its `simulation:` block, one undo step, Reset removing it. |
| **Supports Layer 3** | `test/layer3-ui.test.mjs` (1 test, through the DevTools protocol) | The checkbox and its tooltip, no help text; on a Layer 2 switch the routing protocols listed disabled in *Requires Layer 3* with the reason, nothing suggested, a scripted choice changing nothing; the palette's reason; the endpoint pickers leaving the switch out (and saying why) of relations that need Layer 3; a new relation proposing no Layer 3 protocol and reporting one typed in; ticking makes them available; unticking a configured switch confirms the list of what goes, one undo step. |
| **DHCP and DNS (engine)** | `test/sim-dhcp-dns.test.mjs` (10 tests) | **The model:** services off by default, what they need as errors, only on servers, VMs and containers; scopes against the model (the range inside the network, without the gateway or a static address, no overlaps; exclusions and reservations); zones (records inside the zone, no duplicates, no CNAME beside another record, the listening address, the records the DNS names give); the checks `dhcp-no-server` (same broadcast domain or through a relay) and `dhcp-relay-no-server`. **The simulation:** DORA at the start, every client in parallel, one through the relay (giaddr), the reservation and the exclusion; everything a client sends waits for its lease, its relations' sessions start with it; renew at T1 (unicast), rebind at T2 (broadcast), the end of the lease; an exhausted pool not answering, retries with backoff (4, 8, 16, 32 s), the pause and the link-local fallback; DNS answered from the zone (a CNAME followed), NXDOMAIN, a timeout with retries, the cache for the record TTL, the zone and cache tables; a deterministic timeline. |
| **DHCP and DNS (editing, diagram)** | `test/netservices-ui.test.mjs` (2 tests, through the DevTools protocol) | The Services card off by default on a server; ticking DHCP or DNS shows what is missing as errors; **+ Add scope** with its required fields and suggestions; a zone with its derived records (read-only); unticking both restores the model, one undo brings a service back; no card on a switch; a host's DNS servers; a VLAN interface's DHCP relay. **Diagram:** the DHCP and DNS badges inside the box, apart from the label and each other; the reserved lease lines filled in a simulation without changing any entry's size. |
| **Simulation UI** | `test/sim-ui.test.mjs` (2 tests), `test/sim-browser.test.mjs` (8 tests, through the DevTools protocol) | Start simulation… and Exit simulation in their three states with the reasons (one registry for the menu and the palette); label placement (never on a text, a box or another label). **The Start dialog with real keys:** Simulate ▾ → Start; the protocols first (groups *Layer 2 (4 of 4)* … *Custom (1 of 1)*, every protocol ticked, *OSPF 8 relations*, *(18 of 18)*), the keyboard on the first protocol, Space unticking it, a group's Clear and its count; the layers collapsed with *(8)*, a changed TTL making Layer 3 say *· 1 modified* while collapsed (in its accessible name too); no scrolling at 1366 × 768; Start primary and last; Esc cancelling, the protocols open and all ticked again on reopening; Enter on a checkbox starting; the choice in the setup panel (*(14 of 18)*, Traffic *(0 of 4)*, every layer collapsed) and on the next start. **The layout:** setup and actions in place of the Objects list and the Inspector (named *Simulation setup* and *Actions*), the panel under them, no tool window, nothing to detach it, the page not scrolling; the four actions of Network events whatever is selected; the splitter (↑ twice: 40 px taller, stored, `aria-valuenow`; never below 150 px; Enter: the default); `F6` / `Shift+F6` through setup, diagram, actions and panel; Exit bringing back the Objects list, the Legend tab, the selection and the zoom. **Menus and actions:** a click on a cable opens Fail link, Start flapping and Highlight broadcast domain at that spot with the keyboard in it; Enter fails it, Restore from the Active events; a switch's menu by arrow keys; its ARP and MAC tables in the panel's status side (no floating table), Protocols again; unticking OSPF in the setup keeps the time and is remembered. **Pacing:** *Readable · 1 s per hop · 1×*, every hop 0.6–3 s; a dot clicked: the packet inspector with Follow message, the simulation paused (also when it was playing); Follow and Stop following; Step; the speed 0.25×–4×, Proportional with its scale, skipping off and on; *⏩ … skipped* reported. **Reduced motion:** still arrows with labels for the first message at once with Step, arrows that do not move while playing, Step one event at a time, the export a still picture without the moment's marks. **A device's Simulation section** in the Actions panel (once; collapsed; own and inherited values with their sources), an override written as `simulation: {arp_timeout: 45}` and logged as *(device)*, Undo taking it back; the setup's parameters applied at once, remembered, *· 1 modified*. **Layers 3 and 4, multicast:** the storm warning, a log message in the inspector by keyboard, the log by cast, layer and protocol; Send test from the Actions panel (Enter in Port) and from a device's menu; a broadcast domain; connections and sessions; Join multicast group… from a host's menu (the form open with the host, kept after the join), the join completed with its membership recorded, Leave group; the IGMP, multicast-table and multicast-route tables; IGMP in the inspector. |
| **Failure simulation** | `test/failure.test.mjs` (9 tests) | A failed device (its interfaces and cables down, neighbours degraded, relations at it down, a VRRP group failing over, networks degraded or down, the routing context); a failed port (its cable, the far port) and a LAG degraded or down by `min_links`, and its LACP relation; a cable or relation failing what runs over it, recursively (OSPF over GRE over IPsec), with tunnels listed apart; a relation of three devices; static routes failing and the floating route taking over, with the path tracer following it; a VRRP failover in the tracer; device pairs losing reachability in full or in part; the single points of failure (partitioning cables and devices, a LAG listed once, relations without a redundant underlay, none in a ring, the enterprise WAN); only cables, ports, devices and relations can fail; the same result for another order of the failed objects and of the file. |
| **Path tracer** | `test/trace.test.mjs` (14 tests) | A static path hop by hop (longest prefix match, interfaces, addresses, routes, cables, the refs it marks; ends given as device, interface or address); a floating route taking over when the better next hop's interface is down; where a trace stops and why (black hole, no route, an unresolved next hop, a loop, a host that does not forward); a destination outside the model (leaves it, or delivered into a network); bad requests; equal-cost multipath (every branch, the main path and the alternatives); routes learned over OSPF (hop count, a per-device cost, a static route beating OSPF, a failed adjacency); an adjacency without a common network; a GRE-over-IPsec tunnel with OSPF over it (the stack, the declared underlay, a routed underlay traced nested) and a VLAN missing from a trunk; a VRRP gateway and its failover; VRFs; the return path and asymmetric routing; the same text for files in another order; the paths of the enterprise WAN and branch examples. |
| **Addressing overview** | `test/addressing.test.mjs` (11 tests) | VRF groups (default table first) from the members' VRFs, the supernet tree; members with DNS names and loopbacks, DHCP clients on cables carrying the network, nested members counted, not repeated; gateways (VRRP / interface VIPs, default-route next hops), not repeated on a supernet; used, size and utilization (IPv4 percent, IPv6 /64 count, 2^64 as text); free ranges without reserved, used and nested addresses, the next free address (IPv6 after the subnet-router anycast address), a full network; duplicates per VRF (not across VRFs), same-prefix networks and interface subnets larger than their network, addresses in no network; the same result for a file with every list reversed; filter with context rows, flat sorts; CSV (header, quoting, CRLF, exact counts); the Inspector's next-free choices (VRF, networks on the cable first); every example builds and lists every network. |
| **Analyze as architecture validation** | `test/analyze-validation.test.mjs` (36 tests) | The shared verdicts, all-of, the context and coverage texts; a trace's outcome over every evaluated path (mixed equal-cost paths partial, a path that leaves the model or ends in a network without the destination beyond scope, never success), the hop evidence from the decision (selected, rule, alternatives, layer 2, stop), endpoint resolution by device, interface and address alike; communication checks (an application to its peer's listener with transport, port and bind interface; a reachable address without a listener; a listener bound to another interface; a policy denial apart from a missing route; name resolution by the model's DNS with the query as its own leg, NXDOMAIN, no resolver; an MQTT client's broker leg and its subscribers' separate legs; the reverse direction without a destination port and without a session; DHCP and SLAAC sources indeterminate in the configured model and used from a snapshot); snapshots that don't change while the simulation goes on; a PTP source path that never claims synchronization; allocation-aware addressing (pools, exclusions, reservations counted once and never suggested; a parent prefix's subnets apart from its hosts; a snapshot's acquired addresses; link-local and reuse in separate parts not conflicts, an unknown scope a possible one; two VRF listings on one segment sharing an address space; the CSV's allocation and context); service dependencies and the what-if comparison (unavailable, an alternative resolver, a DHCP server's loss and existing leases); failure domains (members, groups, validation, what if a domain fails); combined failures and scoped reachability with coverage (relevant endpoints first, no alphabetical cut); a service single point that cuts nothing off; saved expectations (satisfied, violated, indeterminate, unsupported; blocked by policy apart from not reachable; a failure condition on a snapshot; timing; a dependency), shared stop points, renames, the delete confirmation's list, undo and redo, the same result for another file order; contextual focus (VLAN, dependencies, multicast, timing, a guest's host); findings presented and grouped without loss; the freshness fingerprint (positions and comments don't count); the text and CSV exports with their context. |
| **Analysis integration** | `test/analysis-integration.test.mjs` (47 tests), `test/arrange-crossings.test.mjs` and `test/default-arrange.test.mjs` for the examples, and the browser self-test | **Segments and DHCP:** isolated VLANs on one switch are separate segments (access ports, Wi-Fi networks, port groups), one definition with the simulation's broadcast domain; no DHCP provider, PTP source or address conflict across them; a relay path a policy denies is no provider, a failed first relay never hides a working second one. **What if:** blocked expectations compared too (a failure that exposes a forbidden path), an end the failure takes down leaves the isolation unexercised. **Support catalog:** one source for the manual and docs/SUPPORT.md. **Communication identity:** the handoff carries the check's own choices, a stale reference stops it, the comparison explains a difference from recorded state only. **Isolation enforcement:** denied by policy needs an evaluated policy's denial, a missing route or listener is none, partial ECMP is no isolation. **Timing:** NTP chains to a modeled reference, cycles, external upstreams, an upstream on a failed device; the method explicit. **Path MTU:** the limiting component per branch and the return path, nested encapsulation, the simulation's DF behaviour. **Routing policy:** default-only and prefix filters by import or export, BGP selection, redistribution without loops, the simulation installing the same routes. **Network policy:** first match, the tracer naming the rule, stateful and stateless, transparent firewalls. **Capacity:** stated traffic against stated capacity before and after a failure, multipath not assumed. **Experiments:** repeatable runs, cancellation, comparison, validation, renames, the OT example's outage (applications on scenario time, an MQTT client's rounds). **Execution scopes, saved views, collapsed groups, bulk port edits:** what a scope runs and its boundary, a scoped simulation that never answers from outside it; views validated and following renames; a collapsed group's box and boundary connections; a bulk edit's preview and one undo step. The self-test runs each representative architecture's workflow in the UI (private house, campus, WAN, data center, IoT, timing). |
| **Analyze workflows** | `test/analyze-workflows.test.mjs` (5 tests) | On the public examples: a small network (the guest's lease in a snapshot, DNS, the guest kept out of management by the policy, static suggestions outside the pools), an enterprise (VRFs and a reused address, a dual-stack multi-interface end, equal-cost paths with full coverage, a rack failure leaving the requirement on the other core, the core room taking it down), an OT cell (the HMI to the controller's listener, the PLC to its broker, the broker as a service single point, the IT side not kept out), PTP timing (a source path, the second grandmaster as an alternative). |
| **Input helpers** | `test/helpers.test.mjs` (7 tests) | MTU suggestions (1500, 9000; for tunnels 1476, 1400 and the underlay's MTU less the encapsulation overhead, for GRE and for GRE over IPsec, with the overhead named); MAC generation (the locally administered and unicast bits over 200 draws, a colliding draw drawn again, the model's style: colons, upper-case hyphens, Cisco dots; valid once written); the VRFs in use sorted and counted, case-only variants and the `vrf-name-case` check; VLAN IDs (next free, defined); redundancy groups to join or the next free one, and the group's virtual IP; AS numbers in use; router IDs from loopbacks; IS-IS NET from the router ID; a BGP end's peer AS; interface names after a device's pattern; route prefixes and distances; a helper applied is one undo step and validated. |
| **Routing services (protocols)** | `test/protocols.test.mjs` (8 tests) | The registry (every built-in protocol's parameters with type, scope and range or values, suggestions that are valid values, which use the router ID; no `static`, which is reported as an unknown protocol); applicability (a router ID without a protocol that uses one is not applicable; `asn` on a device names BGP; misplaced parameters; Layer 3+ devices only, the same list as for routers among static routes; unknown protocols; interface groups need the protocol on the device); mandatory parameters and typed values; a protocol's own router ID and the shared one from a loopback; protocols of the model with their own parameters; the suggestions from relations and the two checks (static routes need no protocol); enabling and disabling (the values listed first, the router ID going with the last protocol that uses it, one undo step each, back to the file exactly); the path tracer only over enabled protocols, iBGP / eBGP from the local AS numbers; the identity lines of the diagram; Find by protocol, AS, router ID and virtual address; the examples. |
| **Consistency checks** | `test/checks.test.mjs` (16 tests) | The registry (unique ids, severity, title, what each check reads); a consistent model on which **every check is silent**; **for every check a positive case** (it finds the mistake, with its message, severity and place) **and negative cases** (equal values written differently, `1000M` = `1G`, area `0` = `0.0.0.0`; missing values; a single shared value; an MLAG pairing the peers; a /31; a VRF facing no VRF); the tunnel-MTU overheads summed over GRE over IPsec, and unknown encapsulations skipped; the new fields validated and written back exactly; the `checks:` section (off, other severities, unknown ids and values with suggestions, editing as one undo step); the demo example finds every check and downgrades one; router ID and AS drawn in both views and in the details. |
| Selection context | `test/selection-context.test.mjs` (6 tests) | Each element type (device, port, link, network, relation, group, protocol) gives the documented direct relationships; indirect ones (a cable's far end, a sub-group's devices, the cables under a tunnel's carrier, built-in protocols) are excluded; symmetric and a subset of the diagram highlight in every example; view-independent; protocols can be selected; the Relations list shows the same states with screen-reader text |
| Architecture | `test/architecture.test.mjs` (5 tests) | Every module lives in a layer folder; imports follow the allowed dependency direction (docs/ARCHITECTURE.md); the diagram, layout and UI layers never import the YAML layer; **no module compares a device's type with a type name** outside the registry, the capability resolver, the icon lookup and the self-test (the guard is tested against a sample) |
| **Port ranges** | `test/port-range.test.mjs` (7 tests) | The final number is the port number (also with leading zeros and multi-part names); ids follow the model's convention, with the typed name as label when it isn't a valid id. Rejected with a clear reason: missing number, different prefixes, first not lower than last, more than 256 ports, names that can't become ids. Duplicate names or ids on the device (ids and labels, physical and logical) reject the whole range; other devices don't count. Creation is all or nothing, one undo step, physical interfaces only (no addresses, VLANs, links); alphabetical display; **export → reload** of generated ports. |
| Module APIs | `test/modules.test.mjs` (10 tests) | Document editing operations (typed values, lists, endpoints, attrs, key order, one undo step each); the format schema is the single source of allowed keys; model queries; export file names; `check:dist` accepts the current build and rejects a stale HTML file |
| **End-to-end in a real browser** | `test/browser.test.mjs` → the test build's `build/netatlas-test.html#selftest` (1035 in-page checks, every public and internal example); `test/public-artifact.test.mjs` → the released application's own `dist/netatlas.html#selftest` (the eleven public examples in both views and both themes, the type names, the Objects list's headings, offline) at a desktop size, a narrow window and a page zoomed to 200 % | Headless Chrome, Edge or Chromium opens the file from `file://` **with DNS resolution disabled** and drives the real UI. **Viewer:** every example loads through the File API path, both views are drawn, loopback chips appear only in the logical view, interaction works. **New model:** New is empty; a new device shows *Select device type* and saves no type until one is chosen; a new relation has no protocol and reports its missing protocol and endpoints (saving then needs "Download anyway" in the download fallback); a new network is only an ID; add a device, **add two loopbacks, type IPv4/IPv6 addresses, see the error for an address without a prefix and fix it**, add physical interfaces (type shown as read-only *Physical*), **a bond with two member ports, a VLAN interface whose *Ports carrying its VLAN* follow the tagging of the cable ends, and a tunnel sourced from a loopback, an address and a port (an unknown source is an error)**, all listed alphabetically while the file keeps its order, a cable (link ends offer physical interfaces only), a GRE tunnel between loopbacks with nested attrs, then **VLAN tagging on the link ends** (a trunk with tagged VLANs and a range on one end, the other untouched; a difference shown in the editor, in Problems and on the cable, and not synchronized; the same VLANs in another order agree), **save (download a copy) and reload** the file. **Static routes:** the route tables and next-hop lines of `test/examples/branch-routing.yaml`, the **Routes** switch (nothing moves) and its effect on the SVG export, selecting a route (its card opens and is marked), Duplicate and undo, **+ Route** on a host with a next hop that a check reports at its field and in Problems, and the jump from Problems to the route. **Command palette:** `Ctrl+K` opens it with a combobox and a listbox (a live count), fuzzy matching, an unavailable command listed with its reason and not run, an object selected with Enter, recent entries first, a command run (Logical view), Esc returning the focus, the Find menu entry, no change to the model. **Input helpers:** the MTU chips under their field in a labelled group with accessible names, a chip writing its value in one undo step, **Generate** for a MAC (named for its interface, locally administered unicast, unique, one undo step), the VRF combobox (ARIA roles, typing opens the VRFs in use with their counts, ↓ to an option, Enter picks it, a case-only variant flagged in a live region, Esc closes and keeps the selection), naming a new port after the device's pattern as a rename, the chips readable in both themes, and the palette's MAC and MTU commands. **Routing services:** a device's Protocols section with one-click suggestions (accessible names), the findings in Problems, enabling OSPF (one undo step) with its required router ID as an error until filled in, *Enable a protocol* as a labelled choice, IS-IS's required NET and its level choice, undo back to the file, *Disable* asking first with the list of what goes, undo, the chips readable in both themes, the palette command. **Scenario templates:** the Simulate entry (a dialog), the eleven templates with one that doesn't apply greyed out and its reason (aria-describedby), the review (the editable name focused, the steps, the notes, nothing saved yet), Save and play (a saved scenario, one undo step, played: both uplinks of a shared duct fail), undo, the palette's template entries. **Simulated traffic:** `test/examples/ospf-reroute.yaml` played step by step in both themes: the animation on by default in its own layer under the boxes; the baseline on the preferred path with dots on its cables; the primary link failing (rerouted, said in the tab, the old way faded and the new one emphasized, no dots on the failed cable); the second failure (VRRP failing over to w2, the camera lost with a marker at w-cam); the logical view; both links restored; Pause stopping the dots; the export with arrows, no dots and the Simulation note; switching it off; no change to the model and no undo step. **Simulation:** the Analyze menu without simulation entries and the Simulate menu with them; the Simulation tab of its own; unavailable without a selection or for a network (with the reason), `X` starting an ad-hoc scenario with the mode indicators (banner with scenario and step, the solid 2 px border, status-bar marker, *◈ Simulation running* label), the results (relations, tunnels, networks, routes, the device pairs that lose reachability), the cable drawn dotted and what runs over it marked down in both views; the edit lock (the Edit tab read-only with its Exit simulation button, the outline's Add buttons, the YAML text, the editing core refusing any edit); a trace in the simulated state saying so; `[` / `]` playing back and forward with the same results (deterministic), Restore and Remove steps; playing changing nothing and adding no undo step; Save scenario… (a labelled dialog, one undo step), a step added to a saved scenario as an undoable edit, undoing the save; replaying a saved scenario step by step; the palette's *Play scenario*; the Single points of failure report in Analyze and the Analysis tab (an entry's name only selects; **Simulate this failure** starts a scenario; unavailable during another simulation; Close report); Focus counting hops over what is up; exports with the frame and a *Simulation: scenario …* note in both themes; `Esc`. **DHCP and DNS (`test/examples/campus-services.yaml`, both themes):** no problem; the server's DHCP and DNS badges with tooltips, the clients' reserved lease lines and the legend entries; the Services card with both boxes ticked, two scopes and the zone with its derived records; in the simulation the leases written into the reserved lines with *(DHCP lease)* (the reservation, the relayed client), DORA in parallel and through the relay, DNS by name before the connection; *Show DHCP leases*, *Show DNS zone* and *Show DNS cache*; the indicator (a solid 2 px inset border that catches no click, the label); the lines restored after Exit. **Path tracer:** `T` opening the Analysis tab with the selection in From and the keyboard in To, an unknown end refused at its field, a trace with its return path (the banner with the hops, the equal-cost alternative and the return path), the hop list (interfaces, addresses, the OSPF route, GRE over IPsec, the cables), the path's devices and cables marked in the physical view down to the internet underneath the tunnel, the alternative marked apart (dashed, not by colour alone), the relations in the logical view, exports with the marked path and a *Path trace* note in both themes, the text copy, no change to the model and no undo step, the trace computed again after an edit, `Esc` ending it, the Analyze menu entries. **Focus mode:** unavailable without a selection (with the reason), `Shift+F` showing one hop with the banner (object, hops, count, temporary positions), the banner's controls, `+` for 2 hops, relations in the logical view, an export with exactly the focused part and a *Focus* note, both themes, no change to the model and no undo step, `Esc` restoring every device at its position, Focus / Exit focus as commands. **Addressing overview:** opened from Analyze and with `I`, every network listed per VRF with its columns, utilization as text, the filter (with the focus kept and a live count), sorting by a header (aria-sort, reversed on a second press), a network's members opened and closed (aria-expanded), the duplicate / overlap / no-network lists, no sideways page scrolling, the CSV, a click selecting the network in the diagram, Esc closing it without changing the model or adding an undo step, both themes, and the Edit tab's **Next free address** adding an address (and undo). **Consistency checks:** the Problems tab of `test/examples/consistency-checks.yaml` in two parts with a finding of every check (id, title, severity as a word, the objects as links), the severity filter (aria-pressed, focus kept), the checks the model changes, an object link selecting it, a finding opening its field with the message, an MTU fix removing the finding, the model settings' check table writing `checks:` (off, another severity, undo), and a link end's speed and duplex. **Imported model:** rename a device (every reference follows), edit, add an IPv6 loopback, save as a downloaded `…-edited.yaml`, **reload, and check that edits, hidden attributes and comments survived**. **Guards:** unsaved-changes dialog on replace; `beforeunload`; Ctrl+Z/Y; deleting a referenced device reports broken references; **exporting an invalid model requires "Download anyway"**; YAML-tab apply/reject; unknown keys kept and movable into attrs; typed text is committed before a button acts; **selection context in the lists:** selecting from the diagram, the left list and the right-hand Relations list keeps lists and diagram consistent for every element type (direct entries related, indirect ones dimmed), unrelated entries stay focusable and selectable, view switches leave no stale highlighting, and `Esc` clears everything; the device type is chosen from the 15 types by display name. **Auto-arrange:** the three options are in the top toolbar, visible and labelled (disabled until a model is open); the status reads *Auto-arranged* / *Manually adjusted* / *Edited since arranged* after loading, dragging, undo, switching views (the shown view is highlighted), Auto-arrange, moving a node back to its calculated position, export → reload of arranged and of manually adjusted layouts, a model edit, and New; loading stores nothing; the dialog shows the scope; arranging an automatic layout stores it without moving anything; repeating it is a no-op; a manual move changes only that node and is undone by arrange (and restored by undo); **arrange → export → reload is pixel-identical in both views**; a file with every list and key reversed arranges identically; **the browser reproduces the build-time positions of `metro-ring-arranged.yaml`** (a cross-engine determinism check when run in Firefox or Safari). **Safety:** hostile labels create no elements; YAML syntax errors are refused with the current model kept; **no network requests, no CSP violations**. The test is skipped if no Chromium-based browser is installed; set `NETATLAS_BROWSER` to choose one. |
| **Offline, observed from outside** | `test/offline.test.mjs` (2 tests, through the DevTools protocol, both themes) | Every request of the shipped page's target while it opens each public example in both views, Help (the manual's pictures, the license), Analyze, a simulation, the `cold-tv` experiment and the PNG export: only the page itself and `data:` / `blob:`; no CSP report. **Control:** a request to an external host from the page is observed and refused by the CSP |
| **Verification scripts and workflows** | `test/release.test.mjs` (9 tests), `test/workflows.test.mjs` (10 tests) | **Suites:** every test file in exactly one suite, the browser files never in `unit`, a helper that defines tests refused, a skipped test seen on Node 18 too. **Release:** the committed HTML passes the package check; a test-only module, an internal example, a second script, a `<link>`, a weaker CSP, another version or an oversized file fail it; tag, `package.json` and lockfile versions agree, a hyphen is a prerelease; the CHANGELOG section; `SHA256SUMS`; provenance without time. **Reproducibility:** every committed generated file covered, no time in the build. **Workflows:** read-only default token, writes only where listed, no `pull_request_target`, SHA pins with versions, no expression in a shell script, timeouts, no credentials kept, `npm ci` only, nothing pushes, tags, merges or replaces an asset, the release is a draft, cancellation only of pull request runs, CI's check names equal the proposed required checks, the browser jobs strict, `check:dist` before anything regenerates |

### Manual check (any browser, e.g. Firefox or Safari)

1. Disconnect the network, or use an air-gapped machine. Run `npm run build`
   first: the steps below use the test build, `build/netatlas-test.html`
   (the application plus the internal test models), except where they say
   `dist/netatlas.html`.
2. Open `build/netatlas-test.html#selftest`. A result panel appears;
   `"pass": true` means all in-page checks passed. Open
   `dist/netatlas.html#selftest` too: the released application's own
   self-test (`"scope": "public"`: its examples in both themes, the Objects
   list, offline).
3. Open `dist/netatlas.html` with the developer tools' *Network* tab open.
   Choose **File → New model**: the model is empty. Press **+ Add** next to Devices: the
   new `device1` shows *Select device type*, and the YAML tab shows no
   `type:`. Choose *Router*: `type: router` appears. Press **+ Add** next to
   Relations: the protocol field is empty with a prompt, and Problems lists
   the missing protocol and endpoints. Select `device1` again, press
   **+ Loopback**, and type `10.255.0.9` into the address field. An error asks for a prefix length;
   change it to `10.255.0.9/32` and the error disappears. Switch to
   **Logical**: the loopback chip is under the device. Press **+ Interface**
   twice: each card says *Type: Physical* as plain text. Press **+ Virtual**
   and pick both ports under **Member ports**; press **+ Tunnel** and choose
   `lo0` as **Tunnel source**. The cards are in alphabetical order, the only
   logical types offered are *Loopback*, *Virtual* and *Tunnel*, and no card
   has a parent field. The YAML tab shows `interfaces:` and
   `logical_interfaces:`. No request appears in the Network tab.
4. **File → Open model…** → `examples/enterprise-wan.yaml`. The page asks about the
   unsaved new model first. Rename `hq-rtr1` in the Edit tab and choose
   **File → Save model as…**. In Chrome or Edge, pick a new file name: the
   status bar now names that file, *Save model* is available, and Ctrl+S
   after another edit updates the file without asking. In Firefox or Safari,
   the dialog says that a copy is downloaded and proposes
   `enterprise-wan-edited.yaml`; *Save model* stays unavailable. Open the
   saved file: the rename, all comments and all other content are there.
5. Open `test/examples/broken/errors-demo.yaml`. It opens as a draft with twelve
   errors (among them `vendor`, which is not a device key, the `loopbacks:` and
   `children:` keys, a member that isn't a port and an unknown tunnel
   source), each shown next to its field and listed in **Problems**.
6. **Auto-arrange:** open `test/examples/metro-ring.yaml`. *Auto-arrange* is in
   the top toolbar, next to **Physical** / **Logical**, with three options:
   **Default** is selected (and disabled), **Compact** and **Structured** are
   available; there are no icons. Hover over the group: *The physical view is
   arranged with Default.* A screen reader reads the same sentence.
   * Press **Compact**: the diagram gets tighter, Compact is now the selected
     one, Default and Structured are available. Press **Structured**: rows
     and columns, and every cable horizontal and vertical with sharp corners.
     Drag a device: its cables are drawn again at right angles, no option is
     selected and the hover text adds *Its lines keep the right angles of
     Structured.* Ctrl+Z twice: Compact is selected again, with the usual
     lines. Switch to **Logical**: that view
     is still arranged with Default.
   * Back in **Physical**, drag `pe3` somewhere else: no option is selected,
     all three can be pressed, and the hover text reads *This view has
     manually adjusted positions. Each Auto-arrange option replaces them after
     a confirmation.*
   * Press **Default**: a dialog asks *Replace manual positions in the
     physical view?*, names `pe3`, and says the logical view is not changed.
     **Cancel**: nothing moves in either view.
   * Press **Default** again and confirm: `pe3` returns, the toast reports
     what moved, and Default is selected. Pressing it or `A` now does
     nothing.
   * Choose **File → New model**, add one device: Default is selected and
     Compact is disabled too; its hover text says it gives the same
     positions. Structured is available (it would route at right angles).
   * Open the metro ring again, drag `pe3`, save it, then open the saved
     file: both views look exactly the same and show the same status
     (Physical: none selected, Logical: Default). After Default in both views
     and another save, its `layout:` section matches the one in
     `test/fixtures/metro-ring-arranged.yaml`.
   * **Connecting:** open `test/examples/device-types.yaml`. `acc-sw1` shows its
     free ports as chips (*Et ▸ 3 4 5 6 7 8*). Click a chip: the port opens in
     the Edit tab. Right-click chip *3*: it is marked, a dashed line follows
     the pointer, compatible endpoints get a green dashed outline and the
     cabled ports are faded. Right-click a cabled port: a message says why
     not, and the first endpoint stays. Right-click `nms`: the Edit tab shows
     *New physical link* with both ends and the ID selected; press **Create
     physical link**: the cable is drawn, Ctrl+Z removes it. Select a device,
     press **C**, pick an endpoint in the bar and press Enter; Esc in the
     form discards it. Right-clicking the background still opens the
     browser's menu.
7. **Selection context:** open `examples/enterprise-wan.yaml`.
   * Click `muc-sw` in the diagram. In the left list, `muc-sw` is marked ▸.
     Its two cables and the group *Branch Munich* are marked •. Everything
     else, including the router `muc-rtr` at the far end of a cable, is grey
     but readable.
   * Tab to a grey entry and press Enter: it becomes the selection.
   * Select `gre-muc` in the **Relations** tab. Both lists mark `ipsec-muc`
     and `ospf-muc` as related. The physical diagram still shows the cables
     the tunnel rides on.
   * Switch views: the markings stay the same.
   * Press `Esc`: all entries return to normal.

8. **Derived values and port VLANs.** Keep the **YAML**
   tab in mind: at every step it must show only what you typed.
   * Choose **File → New model**. Add two devices; on each, press **+ Interface** (`eth0`).
     Add a link and choose `device1`/`eth0` for End A and `device2`/`eth0`
     for End B.
   * **Network membership, live.** Add a network: **IP network (CIDR)** is one
     field and Problems says the network needs it. Enter `10.77.0.0/24` and
     VLAN ID `77`. **Members (0)** is marked *derived* and has no input.
     Select `device1`, open `eth0`: there is no VLAN, speed or media field,
     and **Network / VLAN** (*derived*) says there is no address. Type
     `10.77.0.1/24` into Addresses: the line `10.77.0.1/24 → net1 · VLAN 77`
     appears at once. On `device2`/`eth0` type `10.77.0.2/16` (a different
     prefix length on purpose). Select the network: **Members (2)** lists both
     devices with interface and address. In the **Logical** view both are
     connected to the network.
   * **The network is the source.** Change the network's VLAN ID to `78`:
     both interfaces now show VLAN 78.
   * **Ambiguity is shown, not resolved.** Add a second network with prefix
     `10.77.0.0/25` and VLAN ID `99`. `device1`/`eth0` shows
     *VLAN ambiguous: VLAN 78 (net1) or VLAN 99 (net2) — none is chosen*,
     and **Problems** lists a warning. Change the second network's prefix to
     `10.99.0.0/24`: the interface shows VLAN 78 again.
   * **Port VLANs.** (The ports' VLANs are tried on `test/examples/vlan-ports.yaml`, step
     22.) Select the link: its ends have **Speed** and **Duplex**, and say
     their ports have no VLANs (two router ports: routed).
   * **Export and reload.** The YAML tab shows one `cidr` value per network,
     and neither `members` nor a `vlan` on any physical interface. **File →
     Save model as…**, then **File → Open model…** the saved file: the
     members, the interface VLANs and both views are the same as before.
   * **Keys outside the format.** In the YAML tab, add `speed: 1G` to an
     interface and `members: [device1]` to a network, and **Apply**.
     Problems lists one error for each of the two keys (*unknown key*); the
     keys are shown
     under **Other properties** on the interface and the network, and the
     YAML tab still contains them unchanged.

9. **Model panel, SVG legend and Networks box.**
   * The model panel (the lists of devices, links, networks …) is always on
     the left; no toolbar button hides it. Switch between **Physical**
     and **Logical**, click objects in the diagram and entries in the
     lists, open the other tabs on the right: the panel stays where it is.
   * Make the window narrower than 1100 px, then narrower than 860 px: the
     panel is still there (narrower, then below the diagram next to the side
     panel) and never lies on top of the diagram, the zoom bar or the
     toolbar.
   * Open `examples/enterprise-wan.yaml`, choose **Physical**, press
     **Export → Export view as… → SVG**. Open the saved file by itself in a browser (offline is
     fine): right of the diagram is a box *Legend — physical view* with
     device icons, cable colours, the two line widths and the location
     boxes. It doesn't overlap anything and nothing is cut off.
   * Choose **Logical**, untick one protocol in the **Legend** tab, press
     export again: the file's legend reads *Legend — logical view*, lists the
     protocols with their line styles, and omits the one you unticked.
   * Repeat with `test/examples/metro-ring.yaml` (several separate components and
     an unconnected router): the legend is to the right of all of them.
   * In each of these files, right of the legend, is a second box *Networks —
     physical view* / *Networks — logical view* with the name, prefix and
     VLAN of each network. Open `test/fixtures/editor-new-network.yaml` with **File → Open model…**
     and save both views: the physical picture lists *Core link* and
     *Management* ("2 of 3 in the model"), the logical one also *Router
     loopbacks*. Untick **Networks** in the logical view and save again: only
     *Router loopbacks* is listed. `test/examples/minimal.yaml` gives a box that says *The
     model defines no networks.*

10. **Sizing and readability.** Open `test/examples/long-labels.yaml` with **Open model…**.
    * **Physical:** `core-a` shows three lines (as written in the YAML), the
      firewall's long label is wrapped over several lines, the storage host
      name is broken after a `-` or `.`, and the one-letter server `s` has the
      smallest box. No text ends in "…" and none leaves its box. The group
      title at the top is written out in full. The three cables between
      `core-a` and `core-b` are parallel straight lines, each with its own
      label (*peer link 1*, *peer link 2*, *keepalive*); the cable to `s`
      carries a long label, wrapped, and its port on `core-a` reads `A 10`.
    * **Logical:** between the firewall and the branch router there are five
      labels that don't overlap; one names the stack bound to the tunnel
      interfaces (*GRE · primary › OSPF · area 0.0.0.10 (over IPsec)*). GRE
      and OSPF start at the port beside the branch router's `Tunnel10` row
      (end label *Tunnel10 / src: GigabitEthernet0/0/0*); nothing starts
      beside `Tunnel20`. IPsec, eBGP, BFD and syslog, bound to the devices,
      start at the hollow device-level ports beside the device names. The
      server segment is three networks, each with its prefix.
    * Drag the firewall far away, click another device, then
      **Auto-arrange** and confirm: the picture is exactly as before the
      drag. **Default** is selected and disabled (still readable).
    * Select the device `s`, type a second line into **Label** (Enter makes a
      new line; click elsewhere to apply): the box grows and shows two lines.
    * Export both views (**Export → Export view as… → SVG**) and open the files on their own: the same
      full text, the same label places, and the legend beside the diagram.
    * Open `enterprise-wan.yaml`: in the physical view the two peer links
      between `hq-core1` and `hq-core2` are straight, every cable has its
      label, and the long uplinks bend around devices instead of crossing
      them.

11. **Start screen and Export menu.** Open `dist/netatlas.html` freshly.
    * The page shows the NetAtlas name and logo, one sentence, and three
      cards: **New model**, **Open model…** (dashed: the drop target)
      and **Load example** with a list and a **Load** button. There are no
      example links and no long text. Tab reaches all four controls in order.
    * Drag a YAML file over the window: the *Open model…* card lights up.
      Drop it anywhere: the model opens and the address bar still shows
      `netatlas.html`. Reload, then drop a picture or a broken YAML file:
      the page says *Could not open …* with the reason and offers to open
      another file, start a new model or go back.
    * **Export** next to **File** lists *Export view as…*, greyed out on
      the start screen. With a model open, click it: **PNG** and **SVG**
      appear under it (nothing opens by hovering). Try it with the keyboard
      too: arrow-down to the entry, arrow-right into the submenu, arrow-left
      or Esc back.
    * Zoom far into the diagram, then export **PNG** and **SVG** in the
      Physical and in the Logical view: four files named `…-physical.png`,
      `…-physical.svg`, `…-logical.png`, `…-logical.svg`. Each shows the
      whole diagram (not the zoomed part) with its legend and Networks box,
      and the PNG looks like the SVG. The zoom bar at the bottom of the
      diagram has only **+**, **−** and **Fit**.
    * Change something in the model, then drop another file: you are asked
      before the unsaved model is replaced.

12. **Close model and port ranges.**
    * On the start screen **File → Close model** is greyed out. Load an
      example and choose it: the start screen returns without a question.
    * Load an example, change a label, choose **File → Close model**: a
      dialog offers **Cancel**, **Discard changes** and **Save as and
      close…**. *Cancel* (or Esc) leaves everything as it was. *Save as and
      close…* saves a YAML file (Chrome, Edge: to a file you choose; Firefox,
      Safari: as a downloaded copy, the dialog says so) and then shows the
      start screen; cancelling the save keeps the model open. *Discard
      changes* shows the start screen without saving a file.
    * Do the same with a file you saved with *Save model as…* (Chrome, Edge):
      the button now reads **Save and close** and writes that file at once.
    * **File → New model**, add a device, press **+ Port Range**. Type
      `ge 1/1` and `ge 1/24`: the preview lists 24 ports and the button reads
      *Create 24 ports*. Change *To* to `ge 2/24`: an error appears and the
      button is disabled. Set it back and create: 24 cards in order
      `ge-1/1`, `ge-1/2` … `ge-1/24`, none with an address. Ctrl+Z removes
      all 24. Create them again and try the same range once more: *Already
      on this device*. **+ Interface** still adds a single `eth0`.

13. **Toolbar and outline.** Open `enterprise-wan.yaml`.
    * The toolbar reads, from the left: logo and version, **File**,
      **Export**, **Find**, **Help**, undo and redo, **Physical** / **Logical**,
      **Auto-arrange** (*Default*, *Compact*, *Structured*), then the diagram
      filters on the right.
    * **File** opens a menu with *New model*, *Open model…*, *Save model*,
      *Save model as…*, *Close model* and the examples; the open example is
      marked *open* (*open · modified* after an edit, *open* again after
      Ctrl+Z). Esc or a click elsewhere closes it; with the
      keyboard, arrow-down opens it and moves through the entries.
    * There is no **Current model** button. The model panel on the left and
      the diagram are there as before. Click an empty spot of the diagram,
      open the **Edit** tab and press **Edit model settings**: the model's
      title and description can be edited. There is no "Document" entry in
      the panel on the left.
    * In the left panel **Links** and **Protocols** are folded. Click a
      heading to fold or unfold it; **Collapse all** leaves six headings.
      Select a device in the diagram: its entry appears under the folded
      **Devices** heading and **Links** shows "• n" related entries. Choose
      **Find → Filter object list…** and type: matches from folded sections are listed.

14. **Fitting the window.** Open `enterprise-wan.yaml`, make the browser
    window clearly smaller than the screen and select a device with many
    interfaces (`hq-core1`); open several interface cards.
    * The page has no scrollbar of its own, vertical or horizontal. The
      editor scrolls inside the right-hand panel, down to its last field,
      and the panel ends at the status bar.
    * Tab through the form to the last field, switch **Physical** /
      **Logical**, and open each tab on the right: still no page scrollbar,
      and the toolbar, the zoom bar and the status bar stay where they are.
    * Drag the window smaller and larger, and zoom the page (Ctrl `+` to
      200 % or more): the shell follows the window. Below 1100 px the panels
      get narrower, below 860 px they move under the diagram; the toolbar
      wraps onto more rows.
    * Select an entry far down in the **Relations** list, then open the
      **YAML** tab: nothing appears below the status bar.

15. **Group placement.** Open `enterprise-wan.yaml`, **Physical** view (if
    *Default* isn't the selected Auto-arrange option, press it first).
    * *Internet* is at the top. *Service providers* is directly under it and
      above *HQ Berlin*; each ISP router is over the HQ router it connects
      to, and the two uplinks run almost straight down. The branches hang
      under the Internet as well. No two cables cross.
    * Drag *ISP-1 PE* to the bottom of the diagram: its cables get long and
      no Auto-arrange option is selected. **Default** (after the confirmation) puts it back exactly
      where it was.
    * Open `datacenter-evpn.yaml`: the spine rack is above and between the
      two leaf racks. Open `test/examples/metro-ring.yaml`: the out-of-band group and the
      spare router, which are cabled to nothing else, are beside the ring.
    * Export the view as SVG and open the file: the same arrangement, with the legend
      beside it.

16. **DHCP and DNS names.** Open `enterprise-wan.yaml` and select *hq-rtr1*.
    * Each interface card has a **DHCP off** switch beside *Addresses*,
      except the loopback *lo0*.
      Below the logical interfaces, **DNS names (2)** shows
      *hq-rtr1.acme.example* with *lo0* and *ge-0/0/1*.
    * Switch DHCP on for *ge-0/0/1*: the dialog lists *10.0.0.2/28* and the
      DNS name. **Cancel**: nothing changed. Again, and confirm: the address
      list is greyed out, the name keeps only *lo0*, Ctrl+Z restores both.
    * **+ DNS name**: the dialog lists the interfaces by name; type
      `api.acme.example`, tick two interfaces, add. Delete one of those
      interfaces: the dialog says the association goes, and the name keeps
      the other one.
    * *ham-rtr* → *wan1* shows **DHCP on**; its **Details** say the address
      is obtained by DHCP.

17. **Showing part of the network.** Open `enterprise-wan.yaml`.
    * Top right: **Devices: all (15)**, **Labels** and **Groups /
      Locations** (both on); in the Logical view also **Networks**; no
      Underlay.
    * Open **Devices** and leave only *Internet*, *ISP-1 PE*, *hq-rtr1*,
      *hq-rtr2*, *hq-fw* and *hq-core1* ticked. The Physical view shows
      those six, the cables between them only, and the HQ frames around
      just them; the note *Filtered-view positions are temporary and are not
      saved in YAML* appears above the diagram.
    * Drag *hq-fw*: Ctrl+Z has nothing to undo and the file is not marked
      unsaved. Switch to Logical: only eBGP, BFD and iBGP among those
      routers, no GRE or IPsec; back in Physical, *hq-fw* is where you put
      it. **Auto-arrange** puts it back without asking.
    * Export the view as SVG and PNG: only the six devices, a legend and
      Networks box for them, no note.
    * **Select all**: the complete diagram returns exactly as before.

18. **Device types, the outline, the edit header, the help, the YAML
    mark.** Open `test/examples/device-types.yaml`.
    * Top right, next to **Devices ▾**: **Device types: All**. Open it (a
      click, or Arrow Down on the button): one row per type the model has,
      by name, with its number of devices; all ticked. Untick **Endpoint**:
      *laptop-042* and *pc-017* disappear with their cables, the other
      devices don't move, the button says *Device types: 14 of 15*, the
      status bar *device types: 14 of 15 (off: Endpoint)*, and the note
      about temporary positions appears. Export the view as SVG and PNG: no
      endpoints in either. Untick **Server** too, then tick both: the
      diagram is as before, the file isn't marked unsaved and Ctrl+Z has
      nothing to undo. **Clear**: an empty diagram, *0 of 15*; **Select
      all**: everything back. Repeat in the Logical view. Esc closes the
      list and returns to the button.
    * **Devices**: keep only *edge-rtr*, *laptop-042* and *esx-01*. Untick
      **Server**: *esx-01* leaves the diagram, its row in the Devices list
      stays ticked with *hidden: type Server off*, the button says *Devices:
      2 of 17*. Server on: the three devices are back where they were.
    * Open `test/examples/protocol-simulation.yaml`: **Switch** has **Layer 2** and
      **Layer 3** under it. Untick Layer 2: only the access switches go;
      Switch shows a mixed state.
    * Click devices one after another in the diagram, then press Esc: the
      entries of the left list and their names don't move sideways or down.
    * Select *esx-01*: the Edit tab starts with *DEVICE*, *No problems* and
      **Duplicate** / **Delete** (red), the name below. Make the window
      narrow (under 1100 px): the two buttons show only their icons, with
      tooltips; nothing is cut off and no scrollbar appears.
    * Bottom right, **Mouse & keyboard** shows a *Pointer* and a *Keyboard*
      group; it folds with a click. In a window under 560 px of height it
      starts folded.
    * Open the **YAML** tab and click *core-sw* in the diagram: the tab stays
      open, the *core-sw* entry is marked and scrolled into view, and the line
      above the text names its lines; the places where *core* appears inside
      other entries are not marked. Type a comment line at the top: the mark
      moves down one line. Type `&x ` right after the `- ` of any entry: the mark disappears;
      remove it: it comes back. **Apply**, Ctrl+Z: the mark follows.

19. **DNS names in the logical view, short help, Details, filters, file
    name, Find menu.** Open `enterprise-wan.yaml`.
    * **Logical** view: *hq-rtr1* has *hq-rtr1.acme.example* once (it
      belongs to two interfaces) and *vpn1.acme.example* in dashed chips
      under its loopback; *hq-log* has *syslog.acme.example*. Switch
      **Labels** off: the names go, nothing moves. Export SVG and PNG: the
      names and a legend entry *DNS name (as configured, not looked up)*.
    * Select *hq-rtr1*: the Label hint says only *Line breaks are kept.*;
      the Legend tab (Physical) shows *Port* and the port VLANs as
      symbols, without a paragraph.
    * Switch between **Edit** and **Details**: the same header (type, *No
      problems*, name). Select *hq-log*: the header shows *hq-log (syslog)*
      with *(hq-log)* beside it; Details has no *id* row.
    * Make the window narrower (or zoom in): the filters stay on one row,
      **Devices ▾** and **Device types ▾** stay, and **Filters ▾** appears;
      switch *Routes* off inside it (Logical view): the button says
      *Filters · 1 off*. Widen the window: *Routes* is back on the toolbar,
      unchecked.
    * Open a file with a very long name: the badge at the start of the
      bottom bar is shortened with "…", hover shows the whole name.
    * **Find → Find in diagram…** and `/` open the Find bar; Esc closes it.
      **Find → Filter object list…** shows the filter in the outline; the
      diagram does not change; Esc removes it. With no model open both
      entries are greyed out.
    * On the start screen Devices, Device types, Labels, Groups / Locations
      (and the Filters drop-down in a narrow window) are greyed out
      and can't be clicked, focused or switched with the keyboard. Open an
      example: they are enabled again, all on.

20. **Help, quick actions, toolbar groups.** Open the file **without a
    network connection** (or with the network switched off).
    * **Help → User Manual**: a large dialog with a contents list and a
      section per task; every screenshot shows. Scroll with the keyboard
      (the text has the focus). Esc closes it; the focus is on **Help**.
      Make the window narrow or zoom to 200 %: the dialog still fits, the
      page itself does not scroll.
    * **Help → License**: *Apache License, Version 2.0*; **Full license
      text** opens the complete text in place. **×** closes it.
    * Open `enterprise-wan.yaml`. Move the pointer over the rows of the
      object list: only the row under the pointer shows Duplicate and
      Delete. Duplicate *hq-fw* from its row: *hq-fw2* is added and
      selected; Ctrl+Z removes it. Delete *hq-rtr2* from its row: the dialog
      asks; Cancel keeps it.
    * Tab into the object list: the focused row shows its two buttons and
      Tab reaches them; Enter on Delete asks, Esc returns to the button.
    * On a touch screen (or the browser's device emulation): tap a row; its
      buttons appear.
    * The **View**, **Auto-arrange** and **Filters** groups have clearly
      visible dashed frames of the same look, in the light and the dark theme
      and in both views.

21. **Themes, theme-aware export, addresses, Objects.** Open
    `test/examples/addressing.yaml` with **Open model…**.
    * The theme switch is at the right end of the toolbar. Hover it, or
      reach it with Tab: the tooltip says *Theme: Dark. Switch to the light
      theme*. Press it (or Enter / Space): Light; again: Dark. Every
      panel, menu, dialog (**Help → User Manual**, **License**), the toolbar
      frames, form fields, scrollbars and the diagram follow at once; the
      selection and zoom stay. Reload the page: the choice is kept, and the
      page never shows the other theme first. In a fresh browser profile (or
      after clearing the site's data) NetAtlas opens in Dark.
    * Hover, Tab to and press each segment of **View** and **Auto-arrange**
      (also at 125 %, 150 % and 200 % zoom, and in a narrow window): every
      segment keeps a complete border on all four sides.
    * Click an address line of *core-rtr-01* in the diagram: the Edit tab
      scrolls to that address and marks it (*▸ Selected*); click the VLAN
      line of *ge-0/0/2.10*: its VLAN field is marked; click a device in the
      object list: its header is marked. Esc clears the mark.
    * In both themes, export both views as PNG and SVG: each picture is in
      the theme on screen. Open an exported dark SVG in a browser or viewer
      set to light (and a light one in a dark viewer): it keeps its theme.
    * In both views, every address of *core-rtr-01* is in its box, next to
      its interface's name, in full (also
      `2001:0db8:85a3:0000:0000:8a2e:0370:7334/127`); the VRRP virtual
      addresses are on the *VRRP* label, the cable ids under the cables, the
      prefixes on the networks. Nothing overlaps; after **Compact** and
      **Structured** neither. Drag *core-rtr-01* onto *dist-sw-01*: a note
      over the diagram says there are overlaps; **Default** removes them.
    * The left panel is titled **Objects**, nothing else beside it; a
      screen reader announces the region *Objects* with no description.

22. **Static routes and port VLANs.** Open `test/examples/branch-routing.yaml` from the
    **File** menu.
    * **Physical** view: the cable between the branch router and the access
      switch reads `R · T 10,20,30` at the router (its subinterfaces) and `T
      10,20,30,99 · N 99` at the switch; the access ports read `A 10` and `A
      20`; nothing overlaps.
    * **Logical** view: the branch router's box has a *Routes* table (the
      default route, the floating default `… AD 250`, two equal-cost routes
      to `10.10.0.0/16`, a blackhole) and a *Routes · VRF GUEST* table;
      dotted lines with arrows lead from the routes to the ISP edges' ports.
      The hosts' default gateways point at the router's subinterfaces.
      Switch **Routes** off: tables and lines go, no box moves; on again.
      Export SVG and PNG in both themes: tables, lines and the legend
      entries *Static routes …* and *Route → next hop …* are in the picture.
    * Click the floating default route's line: it is marked, as are the
      router and the ISP B port its next hop belongs to; the Edit tab opens
      its card, marked *▸ Selected*. Press ⧉ (Duplicate) and change the
      copy's distance; Ctrl+Z twice restores the file. **Find** `vlan 20`
      lists the trunk, the access port and their cables; **Find**
      `203.0.113.5` lists the routes via ISP B.
    * Select *Office PC*, press **+ Route**, enter `10.30.0.0/16` and
      `10.99.0.1`: the card and **Problems** report that the next hop is not
      in a network connected to *pc1* (check `route-nexthop-unresolved`);
      clicking the problem opens the route. Undo.
    * On the switch's trunk Gi1/0/1, remove VLAN 30 (its chip's ×): Problems
      reports that the trunks carry different VLANs and the cable is marked
      ⚠ *VLANs differ*. Undo.
    * Open `test/examples/vlan-ports.yaml`, in both themes and at 200 % zoom. Problems
      lists the two deliberate mistakes (acc3's native VLAN, VLAN 30 that
      acc1 doesn't allow); the cable *wrong-native* is marked ⚠, also in the
      Objects list. Select *acc1:Gi1/0/1*: its card reads *Access · VLAN 10*.
      Tab into **VLANs**, type `2`, press ↓ and Enter: VLAN 20 is added, the
      badge reads *Trunk · 10, 20* and a **Native VLAN** picker appears; a
      screen reader announces the combobox and its options. Press Backspace:
      VLAN 20 goes. Remove VLAN 10: the field shows the error *needs its
      VLANs* and Problems lists it; clicking it puts the cursor back in the
      field; **Same as Gi1/0/2** fills it in. Select *acc1* and press
      **Assign VLANs to ports…**: from `Gi1/0/5` to `Gi1/0/14`, VLANs `30`:
      the preview lists 10 ports; **Assign**, then one Ctrl+Z restores them.
      Select *core1:Vlan10*: **Bridge ports** lists *Trunk: Gi1/0/1, Po1*,
      read-only, and the diagram highlights those ports and their cables,
      Po1's members included. Start the simulation and ping from *pc1* to
      *pc2* (answered: routed by core1) and from *pc4* to *pc1* (not
      answered); the log shows *VLAN mismatch* notes on *wrong-native* and
      VLAN 30 dropped at acc1:Gi1/0/47; the packet inspector shows the
      802.1Q tag of a frame on a trunk.
23. **Consistency checks.** Open `test/examples/consistency-checks.yaml` with **Open model…** and the **Problems** tab, in both themes and at 200 % zoom.
    * *The file* reports no problems; *Consistency checks* lists 34
      findings, at least one of every check, each with its severity as a
      word, its check id, its title, the message and *Concerns:* links.
      Nothing overlaps; the list scrolls.
    * Tab to **Warnings** and press Space: the warnings go and the button
      reads ☐ and is announced as not pressed; Space again brings them back.
    * Click *r2* in the `duplicate-router-id` finding: r2 is selected. Click
      the `link-mtu-mismatch` finding: r1's port e0 opens in the Edit tab
      with the message under **MTU (bytes)**. Change 9000 to 1500: the
      finding goes; Ctrl+Z brings it back.
    * Press **Change in the model settings**: **Consistency checks** lists
      every check; `duplicate-mac` reads *Info*. Set `lag-min-links` to
      *Off*: its finding goes and the YAML tab shows `lag-min-links: off`
      under `checks:`. Undo.
    * Select link `t4`: End B shows **Port speed** `100M` and **Duplex**
      *Half*; set them to `1G` and *Full*: the speed and duplex findings go.
      Undo twice.
    * Physical and logical view, all three Auto-arrange options: nothing
      overlaps, the r1 box reads `router-id 10.255.0.1` and `AS 65001`.
24. **Addressing overview.** Open `test/examples/addressing.yaml`, press `I` (or Analyze →
    Addressing overview…), in both themes, at 200 % zoom and in a window
    about 600 px wide.
    * *Default table* lists *Campus* `10.10.0.0/16` with *Corporate* and
      *Voice* nested under it (└); *VRF CORP* and *VRF MGMT* follow. The
      Corporate row shows the VIP `10.10.10.1`, `2 / 254`, `0.8 %` with a
      bar, next free `10.10.10.2/24` and its free ranges; IPv6 rows show
      `1 × /64` instead of a percentage. Nothing overlaps; a wide table
      scrolls sideways inside its frame, never the page.
    * Press **▸ 1 member** on Corporate: *dist*, *Vlan10*, `10.10.10.3/24`,
      DHCP *no*. Type `srv` in Filter: only *Management* stays, and the line
      under the filter says *1 of 14*. Clear it; press **Utilization**
      twice: the list is flat, fullest first.
    * Below: *Addresses in no network* lists the loopbacks and the IPsec
      tunnel addresses. **Copy CSV**, paste into a text editor: a header
      and a line per network. **Save CSV** downloads
      `addressing-addressing.csv`.
    * Click *Corporate*: the network is selected in the diagram and the
      window stays open. Esc closes it; press `I` again: filter, sort and
      open members are as you left them. Ctrl+Z has nothing new to undo.
    * Select *srv*'s interface *eth0*, Edit tab: **Next free address**
      offers `10.20.0.1/24` for *Management*; **+ Add** adds it, Ctrl+Z
      removes it.

44. **Join and leave take effect at once; labels stay with their dots;
    badges fit.** Open `private-house.yaml`, start the simulation, in both
    themes, at 200 % zoom and in a window about 600 px wide.
    * **Start multicast stream** from the thermostat to 239.20.0.1: dots on
      w-thermostat, ap-2–dist and the riser cable at once, none to the TV.
    * **Join multicast group** with the tv: within about a second dots on
      core–ap-b and w-tv too (the next datagram); the core's snooping table
      lists port ap.
    * **Leave multicast group** (tv): for 2 s the TV still gets datagrams —
      open one on core–ap-b: *member port, leave pending: it goes in 1.x s*;
      then the event says *removed at core*, and no new dot starts towards
      the TV; the last ones finish their cable (about 3 s).
    * Watch a send's labels pass a device: each stays on the same side of
      its dot, moving with it, overlapping the name for a moment.
    * Each badge's border ends just after its words (*VLAN 10 · Querier* is
      short, *VLAN 10 · Snooping · querier heard* longer).
    * In the test build, `multicast-querier.yaml`: rx3 and rx4 (behind
      edge) and rx2 join, a stream from src; rx3 leaves: *kept at sw (VLAN
      10, port p6)*, rx4 and rx2 go on receiving.
43. **Multicast port roles, snooping roles per VLAN, background labels.**
    Open `private-house.yaml`, start the simulation, in both themes, at
    200 % zoom and in a window about 600 px wide.
    * After a few seconds: core shows *★ VLAN 10 · Querier*, *VLAN 20 ·
      Querier*, *VLAN 30 · Querier* (first dashed *☆ … (startup)*); dist
      *○ VLAN 10 · Snooping · querier heard* (and 20, 30). Hover one: who
      queries, behind which port. **Show snooping table** on dist: the same
      lines; port up a *multicast router port … not a membership*.
    * **Start multicast stream** from the thermostat to 239.20.0.1: dist →
      core only; open its hop on the riser cable: *Switching at dist (sent
      this hop)*: *→ up: sent — multicast router port*, *✕ ap1: not sent —
      no member and no multicast router port*; *Routing at core*: it routes
      no multicast. The scenario's dots: grey, short grey labels (*ARP*,
      *DHCP*, *IGMP Query*), nothing to point at.
    * **Start multicast stream** from the laptop to 239.10.0.1: to the core,
      *stops at core*. **Join multicast group** with the nas (eth0) on
      239.10.0.1 while it runs: the core's table *239.10.0.1 … nas*, dist's
      none; the next datagram reaches the NAS. **Leave multicast group**:
      after the last member queries it stops reaching it.
    * Open the internal example `test/examples/snooping-roles.yaml` in the
      test build: sw-a shows four badges, *Querier*, *Standby*, *Snooping ·
      querier heard*, *Snooping · no querier*. Power sw-b off: after about
      4 min sw-a's VLAN 20 says *Querier*; the badges don't move. Export
      SVG: all four in the picture. Exit: gone.
42. **IGMP at startup, concurrency, background dots.** Open
    `private-house.yaml`, in both themes, at 200 % zoom and in a window
    about 600 px wide.
    * **Start**: within about 2 s of real time, IGMP dots leave the core
      (its queries of VLANs 10, 20 and 30 at t = 2 s), though DHCP and ARP
      of every host are on their way too. The core's badges say dashed
      *☆ VLAN 10 · Querier (startup)* (and 20, 30). At about 33 s the
      second queries; then *★ VLAN 20 · Querier*. **Show querier election**
      on core: *Next* *query at t = …*.
    * Untick IGMP under the protocols: no IGMP dots; tick it again.
    * Open `test/examples/protocol-simulation.yaml` in the test build:
      **Start multicast stream** from pc1 and **Send network packets**
      from pc2 to 10.10.10.21, 20 messages 1 s apart: both in colour,
      their dots on their way at the same time; the scenario's dots go on
      moving, grey. Point at a grey dot: no outline, a click opens
      nothing. Click a dot of the stream: the inspector, which stays.
      Stop both: once their dots arrived, the scenario is in colour again.
    * Pacing Real time and Proportional: the same; the clock never stops
      while dots are on their way.
41. **Querier election, Leave multicast group, interface flapping.** Open the
    internal example `test/examples/multicast-querier.yaml` in the test
    build, start the simulation, in both themes, at 200 % zoom and in a
    window about 600 px wide.
    * At once: IGMP query dots from q1, q2 and q3; q1 and q3 marked dashed
      *Querier (startup) · VLAN 10*, q2 *Standby · VLAN 10*. After a few seconds q1 and q3 say
      *Querier · VLAN 10* (solid); hover: the LAN, g0 and the address.
      q2's menu, **Show querier election**: *Non-querier*, *10.5.0.1 (q1)*,
      the time until it would take over.
    * **Join multicast group** rx1 and rx2 on `239.5.5.5`, **Start
      multicast stream** from src: both receive; the snooping table of sw
      lists p4 and p5; wait several query intervals (20 s): still there,
      no second join.
    * **Leave multicast group** (right below Join; also in Expand all):
      rx1, eth0; the group list offers `239.5.5.5 (IGMP)`, none chosen; the
      note says *sends an IGMPv3 report that blocks 239.5.5.5 …*. Leave:
      the event says *cleanup pending*, then *removed at sw (VLAN 10, port
      p4)* and *kept at q1:g0 … another member there answered*; rx1 gets
      nothing more, rx2 does; rx1 never answers a later query for it.
    * rx3 and rx4 (behind edge) join, rx3 leaves: *kept at sw (VLAN 10,
      port p6)*: rx4 answered.
    * Power q1 off: about 45 s later q2 says *Querier · VLAN 10*. Power q1
      on: after its boot it is *Querier (startup)*, then *Querier* again; q2
      is *Standby* again. LAN B's q3 is never affected.
    * A cable's menu has no flapping; Interface actions flaps rx2's eth0
      (*↯ Flapping*, the link down and up). Exit: no mark left.
40. **Expand all / Collapse all, every device's status, snooping per VLAN.**
    Open `private-house.yaml`, in both themes, at 200 % zoom and in a window
    about 600 px wide.
    * Select *dist*, Edit tab: **IGMP / MLD snooping** lists VLAN 10, 20,
      30 *Enabled* and 99 *Disabled*. Set 99 to *Not configured — choose*:
      the row and the Problems tab say *snooping-not-configured*; the YAML
      tab no longer has `99:`. Choose *Disabled* again: the error is gone.
      In a network's Simulation subsection there is no snooping setting
      (only the snooping querier and fast leave).
    * Start the simulation. Every device has an indicator on its box's
      edge — *Operational* with a green LED, *External* (hollow) on *isp* —
      none over a name, an address, a port or a cable; zoom in and out:
      the boxes never move.
    * Beside **Network events**: **Collapse all** closes the six forms
      (Expand all enabled, Collapse all disabled, the keyboard moves to
      Expand all); **Expand all** opens them all. Type a group in Start
      multicast stream, collapse and expand: it is still there. Active
      events and More options are untouched. Tab to the buttons: a visible
      focus ring, the tooltips *Expand all / Collapse all Network events
      sections*; the heading doesn't move.
    * Start multicast stream from *thermostat* to `239.20.0.1`: its dots go
      to dist and the core and stop there; its event says *stops at core*,
      its Details *no member reported it there*. Click *core*, **Show
      snooping table**: *No memberships and no router port learned in
      VLAN 10, 20, 30*, the notes say each VLAN's setting, that core is the
      snooping querier of VLAN 20 and routes no multicast. **Join multicast
      group** *tv* on `239.20.0.1`: the open table gets *20 · 239.20.0.1
      (IGMP) · ap · member: IGMPv3 …* without reopening it; the dots now go
      on to ap-b and the TV, nowhere else (not ap-1, not the NAS). *tv*'s
      **Show group memberships** lists the group. **Leave group**: after a
      few seconds the core's row is gone and the stream stops at core again.
39. **Streams in real time, device states.** Open
    `test/examples/protocol-simulation.yaml`, start the simulation, in both
    themes, at 200 % zoom and in a window about 600 px wide.
    * Start multicast stream from *srv* to *239.1.1.1* port 5010, interval
      1, then from *pc2* to the same group, port 5012: both events count a
      datagram each second (watch a clock), side by side; the panel says
      *· streams in real time*; several of their datagrams are on their way
      at once. Set the speed to 4×: the time shown runs faster, the
      streams still send one a second. A dot of each opens the inspector
      with its own port.
    * Pause: both say *Paused* and stop counting; Play: they go on, nothing
      caught up. **Stop stream** on one: the other goes on.
    * Every device says *Operational* with a green LED. Click *lab-h*,
      **Power off**: *Powered off* (red) on its box's edge, the box where it
      was, its label readable; hover it: *Powered off at t = …*. **Power
      on**: *Booting* until its boot time is over (the menu says *up at t =
      …*), then *Operational*. Shut an interface of *srv*: *srv* stays
      *Operational*. *inet* says *External*, its menu has no Power off. The
      **Legend** tab explains the indicator. Exit: every indicator is gone.
38. **Foreground and background.** Open `test/examples/protocol-simulation.yaml`,
    start the simulation, in both themes, at 200 % zoom and in a window about
    600 px wide.
    * The scenario: a few exchanges as dots, each to its end; other cables
      lit and dashed with counts (*OSPF ×2 · ARP ×1*); the panel says how
      many more are cable activity.
    * Start multicast stream from *pc1* to *239.9.9.9*: its datagrams are
      the dots in colour, one a second, several on their way; the
      scenario's dots go on moving, grey, and the pointer goes through
      them; *· streams in real time*. Click a dot of the stream: the
      inspector. **Stop stream**: once its dots arrived, the scenario's
      dots are in colour again.
    * Pause, **Next exchange**: the exchange on screen runs to its end.
    * Pacing **Real time (1 s = 1 s)**: the time shown counts real seconds,
      a stream sends a datagram a second, the dots are brief.
37. **Multicast drawn, interface states.** Open `private-house.yaml`, start
    the simulation, in both themes, at 200 % zoom and in a window about
    600 px wide.
    * Join multicast group: *tv*, *239.1.1.1*: its IGMP reports are dots
      from the TV's Wi-Fi link (paused: there at once). Start multicast
      stream: *nas*, *239.1.1.1*, port 5004: its datagrams leave the NAS and
      spread through VLAN 10; the event says *stops at core*. Click a dot:
      the inspector shows the UDP datagram to 239.1.1.1. **Stop stream**:
      no new dots.
    * Interface actions: *core*, *wan*, **Start flapping**: the form is
      marked *↯ Flapping …*, the button says **Stop flapping**. Choose
      *nas*: unmarked; *wan* again: marked. **Shut interface**: the
      flapping stops (its event *Stopped*), *⏻ Shut*, **Bring interface
      up**, Start flapping greyed with *bring it up first*. Tab to it and
      press Enter: administratively up, the link up after a moment.
    * Power off *dsl-router*: *Administratively up · link down
      (dsl-router is off)*.
36. **Network events and Active events.** Open `private-house.yaml`, start
    the simulation, in both themes, at 200 % zoom and in a window about
    600 px wide.
    * The Actions panel: **Network events** with *Send network packets*
      (open), *Join multicast group*, *Start multicast stream*, *Interface
      actions*; no Object list, no *Show …*; **Active events** below:
      *None yet*.
    * Join: Device *tv* (its one interface shown), Group *239.1.1.1*: the
      event *In progress*, then *Completed · no multicast router recorded
      it … · member of 239.1.1.1* with **Leave group**. Click *nas* in the
      diagram: the form still says *tv*.
    * Stream from *nas* (UDP port empty: *Enter the UDP port.*; 5004): *In
      progress*, datagrams counted, **Stop stream**: *Stopped*.
    * Interface actions: *core*, *wan*: the flapping cycle is shown;
      **Start flapping**: the button greys (*is flapping*), the event counts
      cycles to *3/3* and *Completed*. *dist*, *ap1*: **Shut interface**:
      *Completed · interface down (shut)*, **No shut**.
    * Send laptop → nas, ICMP, 10 messages: one event, *1/10 sent*, the
      bar filling; **Details**: the basis and the messages, **Inspect the
      first message**. Pause: nothing changes. Tab to *Details* and let it
      play: the focus stays there.
    * Fail a cable from the diagram: listed with **Restore**. **Clear
      finished**: the events still in progress and the states in effect
      stay; the keyboard is on the heading.
35. **Send test's delivery types, series and packet hit area.** Open
    `private-house.yaml`, start the simulation, in both themes, at 200 % zoom
    and in a window about 600 px wide.
    * Send test: only **Delivery** is active, From and To are greyed with
      *Choose a delivery type first.*; Send is disabled.
    * **Unicast**, From *isp*: greyed, *isp — Cannot send IP packets*. From
      *core*: **Interface** lists *Vlan10 - 192.168.10.1* … and *Chosen by
      routing*, no summary line under it. From *guest-phone*: its one
      interface as text, *wlan0 - No DHCP lease*, then its lease.
    * To *dsl-router*: four interfaces, one must be chosen; To *nas*: *eth0 -
      192.168.10.20* shown. Protocol empty, no Port; TCP: Port empty, Send
      says *Enter the destination port.*; ICMP: Port gone.
    * **Multicast**: only UDP offered, the destination and TCP cleared.
      **Local broadcast** from *laptop*: Scope *Subnet (192.168.10.255)*.
      **Directed broadcast** *10.9.9.0/24*: *not the broadcast address of a
      subnet of the model*.
    * Unicast laptop → nas, ICMP, Messages 100, Interval 1: the list counts
      the messages; the event log's echo requests are 1 s apart in
      simulated time; Pause: none is added; **Stop**: the count stays.
    * Point near a moving dot (not on it): a ring outlines it and the
      pointer is a hand; click: the inspector opens for that packet and
      stays on it while the simulation goes on. Zoom in and out: the same
      reach on screen.
34. **Send test, pacing, exit.** Open `test/examples/protocol-simulation.yaml`, in both
    themes, at 200 % zoom and in a window about 600 px wide.
    * Start the simulation: the first dots move as slowly as those a minute
      later (about 3 s a hop).
    * During the burst (more than 48 dots), Send test from pc1 to core1: its
      ARP request and echo appear at once, labelled *Test ·*, with a trail;
      the log marks them **Test**. In the setup untick every protocol and
      choose srv as the only sender: a test from pc1 is still drawn.
    * Pause, Send: *Sent at t = … It starts when the simulation plays.*;
      the time stands; **Send and play** sends and plays.
    * Select a device, Edit tab, start, then exit by `Esc`, the banner, the
      panel's Exit, Simulate → Exit simulation and the palette: each time
      the Edit tab is editable at once, with no notice and no greyed-out
      Exit simulation.
33. **DHCP and DNS servers, levels, the indicator.** Open
    `test/examples/campus-services.yaml`, in both themes, at 200 % zoom and in a window
    about 600 px wide.
    * *srv* carries **DHCP** and **DNS** badges, the PCs' interfaces say
      *DHCP client* with a line *lease: assigned in a simulation*; the
      legend lists the DHCP and the DNS server.
    * Select *srv*, Edit tab: **Services (DHCP, DNS)** with both boxes
      ticked, two scopes and the zone *campus.example* with the records of
      *core*, *srv* and *web* (read-only) and the CNAME *www*. Select *web*:
      tick **DHCP server**: *needs a scope* is an error; **+ Add scope**: the
      four required fields are errors, the network chosen, the gateway and
      *srv* are suggested; untick it: the model is as before.
    * Select *acc*, open the interface *u2*: its **Simulation** subsection
      shows *Port path cost* 200000, the others *Inherited*; *p1* shows
      **Edge port** and **BPDU guard** on.
    * Start the simulation: the DISCOVERs of *pc1*, *lap1* and *pc2* start
      together; *core* relays *pc2*'s; the leases appear in the diagram as
      *10.10.10.21/24 (DHCP lease)* … Then *DNS A? web.campus.example* and
      the HTTPS connection. Click *srv*: **Show DHCP leases**, **Show DNS
      zone**; *pc1*: **Show DNS cache**. The thin border and *◈ Simulation
      running*; open every menu: each lies in front of the border.
32. **Layer 2 and Layer 3 switches.** Open `enterprise-wan.yaml`, in both
    themes, at 200 % zoom and in a window about 600 px wide.
    * hq-core1 and hq-core2 carry an **L3** badge (and the Layer 3 glyph),
      hq-acc1 an **L2** badge, in both views (muc-sw and ham-sw, which have
      no addresses, in the physical view); the badge
      touches no label; the legend explains both; the object list shows
      L2 / L3 beside the names; Find `l3` finds the core switches.
    * Select hq-core1, Edit tab: **Supports Layer 3** is ticked (hover:
      *Routing, routing protocols, and gateways*). Untick it: a dialog
      lists what goes (OSPF, VRRP, the router ID, the VRRP group, the
      addresses of Vlan20 …) and the relations that stay; **Make it
      Layer 2**: the Protocols card disappears, the relations are reported
      in Problems; Ctrl+Z brings everything back in one step.
    * Select hq-acc1: Supports Layer 3 is not ticked; *Enable a protocol…*
      lists the routing protocols greyed out under *Requires Layer 3*, with
      the reason under it, and nothing is suggested; *Enable a protocol…*
      in the palette says why. Select the OSPF relation *ospf-hq-area0*:
      hq-acc1 is not offered as an endpoint, and the note says why.
31. **Protocol simulation.** Open `test/examples/protocol-simulation.yaml`, in both
    themes, at 200 % zoom and in a window about 600 px wide, then about
    1400 px wide.
    * **Simulate ▾**: *Start simulation…* available, *Exit simulation*
      greyed out. Select core2 and open the **Details** tab first. Start
      simulation…: the dialog opens with **Protocols** at the top, all
      ticked, grouped (*Layer 2 (4 of 4)*, *Routing (3 of 3)* …), each with
      its devices or relations, and the keyboard on *ARP*; below, *Layer 1
      – Physical (8)* … *Layer 4 – Transport (8)*, collapsed. It does not
      scroll at 1280 × 720. **Clear** under *Traffic*: *Traffic (0 of 4)*.
      Open Layer 3, set *Default TTL* to 32, close it: *Layer 3 – Network
      (8) · 1 modified*; a screen reader reads that as the button's name,
      with *collapsed*. Esc: nothing starts. Open it again (the protocols
      open and all ticked again), clear Traffic, press **Enter**: it starts.
    * The layout: **Simulation setup** on the left (Traffic unticked,
      every layer collapsed), **Actions** on the right (core2's events),
      the simulation panel under them; the banner, the thin 2 px border
      and *◈ Simulation running*; open the File menu: it lies in front of
      the border, which never catches a click; now
      *Start simulation…* is greyed out (*A simulation is already
      running*) and *Exit simulation* available; the palette says the
      same. Drag the line above the panel, then focus it and press ↑, ↓,
      Enter. `F6` goes setup → diagram → actions → panel; `Shift+F6` back.
    * The panel under the diagram shows its header and exactly three rows
      of the status and three of the log, in both themes and at 100 %,
      150 % and 200 % zoom; it can't be made lower. Drag it taller, then
      double-click the line above it: back to three rows.
    * At the start, several dots of different protocols (ARP, OSPF and PIM
      Hellos, IGMP, STP, IPsec) travel at the same time, once the links
      are up after 2 s; none waits for another to arrive. In the event
      log, events of the same moment are one group (a ditto mark instead
      of the repeated time), and muted *waiting* rows say what waits for
      what. Open a BGP OPEN in the packet inspector: *Waited for* names
      its TCP connection, *Caused by* the SYN-ACK.
    * Labelled dots travel their whole way, cable by cable and across the
      switches, about three seconds per cable (longer on the WAN links and
      on long lines: never faster than about 70 px a second at 100 %
      zoom), fading in at the sender with a pulse at the receiver: *ARP Who
      has …? Tell …*, *ARP Reply … is at …*, *OSPF Hello*, later *BGP
      KEEPALIVE*, *IPsec IKE_AUTH*, *OSPF Hello ‹GRE in IPsec (IKEv2)›*. Each
      label can be read in time. No label covers an address or another
      label. *⏩ … skipped* appears between bursts. Speed 4×, then 0.1×;
      Pacing *Proportional*, *1 ms = 0.1 s*; back to Readable and 1×.
    * Click a dot: *Paused: inspecting packet*, the packet inspector opens.
      Close it: *Playing*. Click a log message, then click in the diagram:
      *Playing*, the inspector stays open. Press **Pause**, open the
      inspector and close it: still *Paused*. Open it and press **Follow
      message**: its replies follow with a trail beside the open
      inspector, the rest faint; **Step** a few times; **Stop following**.
      Switch to another browser tab and back: the clock stood still, then
      goes on.
    * **Senders** in the setup (collapsed: *Senders (all 22)*): open it,
      **None**, then tick *User PC*: the summary says *Senders (1 of 22):
      User PC*, pc1 gets a ▶ badge, only pc1's exchanges (with the replies
      of others) move and are logged; the log says how many messages of
      non-senders it hides; **Show all senders** lists them. Click r1:
      **Use as sender**; the log says *Senders changed: pc1, r1*. OSPF
      stays Full. **All** again: no badges.
    * Click core1: *Show ARP table*, *Show MAC table*, *Power off*, *Shut an
      interface…*; the same buttons in Actions. Show core1's ARP table:
      the panel's Status side shows it (*core1: ARP* pressed), with
      *(simulated)* MACs and the timers (core1: 5 min *device*); then its
      MAC table; then *Protocols*.
    * Actions of core1, at the bottom: its **Simulation** section; open
      it, set *MAC aging time* to 60: the YAML gets `mac_aging: 60`, the
      log *Parameter changed: … (device)*; Ctrl+Z takes it back.
    * The setup's Layer 3: OSPF hello 2: the next Hellos come every 2 s at
      once; the log says so, and Layer 3 says *· 1 modified*.
    * Untick ARP in the setup: the ARP dots and log lines go, the time and
      the tables stay. Select all.
    * Click r2: **Power off**, then **Power on** in **Active events**: r2
      boots for 1 min, then its sessions start again. **Interface actions**:
      choose an end of the cable *l-rx*, **Start flapping**: it goes down
      and up three times; its event counts the cycles, then says
      *Completed*.
    * Click the cable *l-carrier-r3*: **Fail link**. r3's OSPF goes Down
      at once, r1's after its dead interval; the users' data goes via r2;
      the cable is drawn down. Table timers 1:60: entries age, r1's entry
      for r3 is refreshed in vain and removed. Fail *l-acc-core1*: acc-sw's
      MAC entries move from up1 to up2 (both failures in Active events).
      **Restore**: OSPF forms again (Init … Full).
    * Make the window 1000 px wide, then 800 px (Setup / Actions tabs over
      the panel), then 800 × 600 (Diagram / Setup / Actions tabs): nothing
      overlaps, the page doesn't scroll. Zoom to 200 %: the same.
    * Turn on *reduce motion* in the system: still arrows with labels
      instead of moving dots, each for its paced time; Step one message at
      a time. Export SVG: arrows and the *Protocol simulation, t = …* note.
      **Exit simulation**: the Objects list and the Details tab are back,
      with the last selection; the zoom is as it was; the model is
      unchanged, Ctrl+Z has nothing new to undo.
30. **New entries and the side panel.** Open `enterprise-wan.yaml`, in both
    themes, at 200 % zoom and in a window about 600 px wide.
    * Select *hq-rtr1*, press **+ Interface**: the new interface's card is
      open, marked *▸ Selected* and in view, the cursor in its ID with the
      proposed name selected; type a name, Enter. Ctrl+Z, Ctrl+Z: the
      interface is gone and the focus is on **+ Interface**.
    * **+ Add** under Devices: the new device is selected in the diagram, its
      row in the object list in view, the cursor in its ID.
    * Tab to the splitter on the side panel's left edge (a screen reader says
      *Width of the side panel, 480 pixels wide*), press ← a few times, then
      reload the page: the width is kept. Double-click the grip: 480 px.
    * Make the window 400 px high or less: the tabs stay on one row and the
      others are under **More ▾**; pick one with the keyboard.
29. **Input helpers.** Open `test/examples/addressing.yaml`, in both themes, at 200 % zoom
    and in a window about 600 px wide, and use only the keyboard.
    * Select *core:ge-0/0/9*: under **MTU**, *1500* and *9000 (jumbo)*. Tab
      to *1500*, Enter: the MTU is written; Ctrl+Z.
    * Select *core:ge-0/0/4*: **Generate** under **MAC** writes an address
      like `0a:…` (locally administered, unicast), in the style of the
      model's other MAC addresses; Ctrl+Z.
    * Select *core:ge-0/0/3*, go to **VRF**: type `c`: the list shows
      *CORP · 2 uses*; ↓ and Enter take it; type `corp`: *differs from “CORP”
      only in case*; Esc closes the list.
    * Open `enterprise-wan.yaml`, select *hq-rtr1:st0.10*: the MTU chips
      include *1403 (underlay 1500 − 97)*; its tooltip names GRE and IPsec.
28. **Routing services.** Open `test/examples/consistency-checks.yaml`, in both themes, at
    200 % zoom and in a window about 600 px wide.
    * Select *r3*: its **Protocols** card offers *Enable OSPF · used by
      ospf-13* (its static route needs no protocol); Problems lists it, and
      **Enable a protocol…** offers no static routing. Press Tab to the first chip and Enter: OSPF is enabled, and
      *OSPF needs a router ID* shows at the new **Router ID** field and in
      Problems. Type `10.255.0.3`, Enter: the error is gone. Ctrl+Z twice.
    * Choose **Enable a protocol… → IS-IS**: *NET (system ID) (required)* is
      an error until filled in; **Level** offers the three levels.
    * Select *r1*, **Disable** on VRRP: the dialog lists `e0: {group: 12,
      virtual_ip: 10.9.9.9, priority: 200}`. Confirm: gone from the YAML;
      Ctrl+Z brings it back.
    * Open `enterprise-wan.yaml`: hq-rtr1's box shows `router-id 10.255.0.1`
      and `AS 65010`; hq-acc1 (a switch without routing protocols) shows
      neither; hq-core1's Vlan10 entry shows `VRRP 10 10.10.10.1`.
27. **Analyze windows.** Open `enterprise-wan.yaml`, in both themes, at
    200 % zoom and in a window about 600 px wide, then about 1400 px wide.
    * **Analyze ▾**: *Addressing overview…*, *Focus…*, *Exit focus*, *Trace
      path…*, *Exit path trace*, *Single points of failure…*. **Simulate ▾**:
      *Start simulation…* available, *Exit simulation* greyed out with its
      reason.
      The side panel has six tabs (no Analysis, no Simulation). `X`, `[` and
      `]` do nothing.
    * **Single points of failure…**: a window (in the narrow window docked
      at the bottom, full width, the diagram above it; the page does not
      scroll). *inet* first (impact 13). Press **Element** twice, **Impact**
      again; type `cable` in Filter: only cables, *n of m shown*. **Show in
      diagram** on *l-hq-isp1*: the cable is selected, the window stays.
      **Copy CSV**, paste: the header and the rows shown.
    * Wide window: drag the title bar and the ◢ grip; the window never
      leaves the browser window. Reload the page and open it again: same
      place, same size. ▾ folds it to its title bar; **Dock** docks it.
    * `F6` from the window: the focus moves to the left panel, then the
      diagram, the side panel and back into the window, where it was;
      `Shift+F6` goes back. `Esc` in the window closes it; the focus is
      where it was before it opened. A screen reader announces a dialog
      named *Single points of failure*, and the rest of the page stays
      reachable.
    * **Addressing overview…** while the SPOF window is open: it replaces
      it. Click a network: it is selected, the window stays.
26. **Path tracer.** Open `enterprise-wan.yaml`, in both themes, at 200 %
    zoom and in a window about 600 px wide.
    * Select *muc-rtr* and press `T`: the Trace path window opens with
      *muc-rtr* in From and the keyboard in To. Type `nowhere`, Enter: the field says
      why and nothing is traced.
    * From `muc-rtr:lan0` to `hq-log`, tick *Trace the return path too*,
      **Trace**: the banner reads *Reached hq-log:eno1 in 4 hops · 2
      equal-cost paths*; the hop table shows muc-rtr leaving by *Tunnel10*
      into *GRE over IPsec* over the internet cables, hq-rtr1, hq-fw (in by
      *vlan5*), hq-core1 and hq-log, a row each, with the columns Device,
      In, Out, Addresses, Route or relation and Encapsulation. The
      **Alternative 1** section lists the way over hq-core2. The return path goes through the VRRP address of the
      servers to hq-core1.
    * In the physical view the path is drawn with thick solid outlines, the
      hq-core2 alternative dashed, the rest dimmed; in the logical view the
      OSPF, GRE and IPsec relations are marked. Export SVG and PNG: the
      marked path with the *Path trace* note.
    * **Copy as text**, paste it into an editor. Close the window with **×**:
      nothing is marked; Ctrl+Z has nothing to undo.
25. **Command palette and focus mode.** Open `enterprise-wan.yaml`, in both
    themes, at 200 % zoom and in a window about 600 px wide.
    * Press `Ctrl+K` (`Cmd+K` on a Mac): the palette opens with the focus in
      it; a screen reader says how many results there are. Type `adrs ovr`:
      *Addressing overview…* is first. Type `exit focus`: it is greyed out,
      *Unavailable: Focus mode is off*; Enter does nothing but say so. Type
      `hq-rtr1`, Enter: the router is selected. `Ctrl+K` again: *Recent*
      lists it first. Esc closes and the focus is back where it was.
    * With *hq-fw* selected in the physical view, press `Shift+F`: the Focus
      window opens (*Object: hq-fw*, *1 hop* checked) and only the
      firewall, the two routers and the two core switches are drawn; the
      banner reads *Focus: hq-fw and what is within 1 hop (cables) · 5 of 15
      devices* with **−**, **+** and **Exit focus**. Press **+**: more
      devices, the ones already there stay where they were. Switch to the
      logical view: the banner says *(relations)*. Export SVG and PNG: only
      what is drawn, with the *Focus* note on top.
    * Close the window (the focus stays on, with its banner), then
      **Exit focus**: the whole diagram is back as before, at the same zoom;
      the selection stays; Ctrl+Z has nothing to undo.

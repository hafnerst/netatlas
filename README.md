# netatlas

**Offline network architecture diagrams and editor. YAML in, YAML out.**

netatlas is a single, self-contained HTML file: `dist/netatlas.html`. Open it
in any modern browser, including on an air-gapped machine. Start a new
network model or open a YAML file, then view it and edit it:

* **Physical view:** devices, their ports (with interface names), cabling
  (medium and speed), and locations such as sites, rooms and racks, drawn as
  nested boxes.
* **Logical view:** networks (subnets, VLANs, VNIs, VRFs), device loopbacks,
  routing adjacencies, overlays, redundancy groups, services, and tunnels such
  as GRE and IPsec. Tunnels are drawn as hollow tubes; a relation carried over
  a tunnel (e.g. GRE over IPsec, OSPF over GRE) is drawn *inside* its tube.
* **Editor:** a model outline plus a property inspector. It can create,
  change and delete every part of the model: devices, interfaces, loopbacks,
  links, networks, relations and tunnels, groups, protocol definitions,
  free-form attributes, and even keys the format doesn't define. Validation
  runs as you type, and the diagram updates immediately. **Download YAML**
  saves the model as a portable YAML file.

There's nothing to install, no server, and no network access. YAML remains
the model: the page reads it, edits it and writes it back.

| Editor: outline, inspector with loopbacks, logical view | Physical view |
|---|---|
| ![editor](docs/img/editor.png) | ![physical](docs/img/wan-physical.png) |

| Selecting the GRE tunnel highlights the cables it rides on | Data-center fabric, physical |
|---|---|
| ![path](docs/img/wan-physical-gre-path.png) | ![dc](docs/img/dc-physical.png) |

| Auto-arrange, physical: POP sites, customer, separate OOB island | Auto-arrange, logical: iBGP mesh between loopbacks, tunnels, disconnected OOB component |
|---|---|
| ![metro physical](docs/img/metro-physical.png) | ![metro logical](docs/img/metro-logical.png) |

## Open it, create or load a model

1. Open `dist/netatlas.html` in Chrome, Edge, Firefox or Safari. Double-click
   it, drag it into a browser window, or enter its `file:///…/netatlas.html`
   path in the address bar. (Don't open `src/index.html`: that's only the
   build template.)
2. Either:
   * click **New** to start from a valid minimal model (one router with a
     router-ID loopback);
   * click **Open YAML…** and choose a `.yaml` / `.yml` file, or drag a file
     anywhere onto the page;
   * choose a built-in file from **Examples…**.
3. Switch between **Physical** and **Logical** (or press `P` / `L`).
4. Click anything in the diagram or in the **Model** outline on the left. The
   **Edit** tab on the right opens it in the inspector.
5. Click **Download YAML** (or press Ctrl+S) to save the model.

Files are read with the browser's File API, edited in memory and saved as a
browser download. They're never sent anywhere. The page's
Content-Security-Policy (`default-src 'none'`, `connect-src 'none'`) makes
network access impossible even in principle.

## Editing

| Task | How |
|---|---|
| Add an object | **+ Add** next to a section of the Model outline (devices, links, networks, relations, groups, protocols) |
| Edit fields | Type in the inspector. A change is applied when you press Enter, leave the field, or click anything else, including the diagram. |
| Rename an ID | Edit the **ID** field. Every reference (links, endpoints, members, `over`, `router_id`, group parents, protocol names) is updated, and a notice says how many. |
| Interfaces and loopbacks | In a device: **+ Loopback** / **+ Interface**. Each one is a collapsible card with all interface fields, an address list, attributes, and the relations that use it. |
| Endpoints | Device and interface pickers (loopbacks and other logical interfaces are labelled). Role, address and endpoint attributes are under "role, address, attrs…". |
| Tunnel underlay (`over`) | Pick links, relations or networks from the list, e.g. GRE over IPsec over two cables. |
| Protocol-specific settings | **attrs** on a relation (and on each endpoint): an editable tree of values, groups and lists of any depth |
| Keys the format doesn't know | Shown under **Other properties**. They're kept and exported, and reported as errors. Use **→ attrs** to move one into `attrs`. |
| Delete | **Delete** on the object. The dialog says how many references will break; broken references are then listed as errors, never removed silently. |
| Undo / redo | Toolbar arrows, or Ctrl+Z / Ctrl+Y (up to 100 steps) |
| Raw YAML | The **YAML** tab shows the model exactly as it will be exported. Edit and **Apply** (text that doesn't parse is rejected with its line number; unapplied text survives tab switches). |
| Problems | The **Problems** tab lists all errors and warnings; click one to jump to the object. Objects with errors get a red badge in the outline and a dashed red outline in the diagram. The inspector shows each message under the affected field. |

**Saving is a download of a new file.** A web page can't overwrite a file on
your disk. For an imported file the download dialog says so, and suggests the
name `<original>-edited.yaml`; your original stays untouched. If the model has
validation errors, the dialog lists them and the button becomes **Download
anyway**. Invalid models are only exported after that explicit confirmation.

**Unsaved changes.** The status bar shows "● unsaved changes" and the title
gets a ●. **New**, **Open**, **Examples** and dropping a file all ask first
(*Cancel* / *Download first…* / *Discard changes*). Closing or reloading the
tab triggers the browser's own "leave page?" prompt.

**Drafts are allowed.** A file with validation errors (broken references, a
loopback without an address, …) opens and is drawn as far as it's valid, so
you can repair it in the editor. Only input that isn't valid YAML in the
supported subset is refused before editing, with the line number.

### Loopbacks

Loopbacks are logical interfaces: an interface with `type: loopback`, a
stable `id`, a name (`label`) and one or more IPv4 and/or IPv6 addresses
**with prefix length**. A device can have any number of them. `router_id:
lo0` names the loopback that provides the router ID. Relations can use a
loopback as an endpoint (tunnel endpoints, BGP sources), but don't have to.
Loopbacks are never cabled or drawn in the physical view. The logical view
shows them as chips under the device (★ = router ID), and the device details
list them. Existing files that already use `type: loopback` load unchanged.
The full rules are in [docs/FORMAT.md](docs/FORMAT.md#loopbacks).

### What round-trips

Everything the file contains survives **load → edit → export → reload**,
including attributes no diagram shows, unknown keys, nested structures,
comments, key order and quoting style. Indentation is normalized to 2 spaces
and `>` blocks become `|` blocks with the same value. The example files are
written back byte-for-byte. The details are in
[docs/YAML-SUBSET.md](docs/YAML-SUBSET.md#writing-yaml-export-from-the-editor).

## Working with the diagram

| Action | How |
|---|---|
| Pan / zoom | drag the background; mouse wheel; `+` `−` `Fit` buttons; arrow keys, `+`, `-`, `0` |
| Select | click any device, port, loopback chip, cable, tunnel, hub or network. The **Edit** tab opens it; **Details** gives a read-only summary. |
| Highlight | selecting something dims everything unrelated. For a tunnel this includes its carriers, what it carries, its endpoints and, in the physical view, **the cables it rides on**. The selection is kept across views. |
| Hover | tooltip with a short summary |
| Rearrange | drag devices or networks. The position is stored in the model (one undo step each) and exported with it. |
| Auto-arrange | **Auto-arrange…** (or `A`): recomputes the positions of the **whole model** for this view or both views. See below. |
| Find | `/` or the search box: ids, labels, IP addresses, CIDRs, protocols, cable ids |
| Filter | **Legend** tab (logical view): turn protocols on and off; top-bar toggles for labels, networks and a faint physical underlay |
| Export picture | **Save SVG** saves the current view as a standalone SVG file |

## Auto-arrange and positions

**Auto-arrange…** (next to *Fit*, or press `A`) lays out the entire model,
not just what is visible or selected. It includes objects hidden by filters.
A dialog shows its scope (how many objects in each view) and lets you arrange
**this view** or **both views**. The result is one undo step (Ctrl+Z). It
never runs by itself.

* **Physical view:** sites, racks and other groups become nested boxes;
  devices sit in rows by role (WAN/cloud on top, then routers, firewalls,
  core, access, servers); connected components are kept together and
  disconnected ones apart; rows and groups are ordered to reduce crossings;
  boxes grow to fit port labels.
* **Logical view:** each connected part of the logical graph is laid out
  with evenly spaced graph distances. Crossings, and lines passing through
  devices, are reduced. Devices keep room for parallel relation lanes and
  their labels, and separate components are packed apart. Tunnels (tubes),
  adjacencies, overlays and cables remain visually distinct.
* **Deterministic:** the same model gives the same positions, whatever you
  loaded, selected or moved before. YAML key order and list order don't
  matter, and arranging twice moves nothing the second time.
  "Equivalent input" is defined exactly in
  [docs/FORMAT.md](docs/FORMAT.md#auto-arrange).

**Positions live in the YAML**, in an optional `layout:` section
(`id: [x, y]` per view). It's presentation only: it never changes the
network, and a broken entry is only a warning.

* Opening a file never writes positions. Without a `layout` section the
  diagram shows the auto-arranged layout, and the status next to the button
  says *positions: automatic*.
* When you drag a node, or make the first edit that changes the geometry
  (adding, removing or renaming objects, changing labels, groups, cables or
  relations), the positions currently shown are stored (*positions: saved*).
  From then on nothing moves by itself; new objects are placed next to their
  neighbors.
* Load → Auto-arrange → export → reload shows exactly the same diagram.

The complete rules are in [docs/FORMAT.md](docs/FORMAT.md#layout-diagram-positions).

## The YAML model in brief

```yaml
netatlas: 1
title: Minimal example
devices:
  - id: r1
    type: router
    router_id: lo0
    interfaces:
      - {id: eth0, speed: 1G, ip: 192.0.2.1/30}
      - {id: tun0, type: tunnel}
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
  - id: r2
    type: router
    interfaces:
      - {id: eth0, speed: 1G, ip: 192.0.2.2/30}
      - {id: tun0, type: tunnel}
links:                                   # physical cabling only
  - {id: cable-1, a: "r1:eth0", b: "r2:eth0", medium: copper}
relations:                               # everything logical
  - {id: gre-1,  protocol: gre,  endpoints: ["r1:tun0", "r2:tun0"], over: cable-1}
  - {id: ospf-1, protocol: ospf, endpoints: ["r1:tun0", "r2:tun0"], over: gre-1}
```

* **Stable identifiers.** Groups, devices, links, networks and relations have
  ids that are unique across the file. Interfaces, including loopbacks, are
  addressed as `device:interface`.
* **Physical vs logical is explicit.** `links` are cables between ports.
  Logical interfaces (loopback, tunnel, SVI, LAG …) can't be cabled.
  `relations` are protocol sessions, tunnels, overlays, redundancy groups and
  service dependencies. `over:` says what a relation rides on.
* **Open protocol set.** `protocol:` accepts any name. About 40 common
  protocols are built in. New ones can be styled in a `protocols:` section.
  Protocol-specific settings go in free-form `attrs`.
* **Six drawing categories:** `tunnel` (tube), `adjacency` (solid),
  `overlay` (dashed), `redundancy` (dotted), `service` (dash-dot), `other`.

The complete reference is **[docs/FORMAT.md](docs/FORMAT.md)**, and the exact
YAML that is read and written is in
**[docs/YAML-SUBSET.md](docs/YAML-SUBSET.md)**.

### Examples

| File | Shows |
|---|---|
| [`examples/enterprise-wan.yaml`](examples/enterprise-wan.yaml) | HQ with two ISPs and two branches. **IPsec → GRE → OSPF** stacks over the same internet uplinks that also carry eBGP and BFD. WireGuard backup over LTE, loopbacks used by iBGP, a multipoint OSPF area, VRRP, LACP, syslog, an undeclared protocol and a user-defined one (MACsec). |
| [`examples/datacenter-evpn.yaml`](examples/datacenter-evpn.yaml) | Spine/leaf fabric in racks: eBGP underlay, EVPN sessions between loopbacks, a multipoint VXLAN VNI, MLAG, LACP, and a user-defined `srv6` tunnel. |
| [`examples/minimal.yaml`](examples/minimal.yaml) | Two routers, one cable, OSPF inside GRE. |
| [`examples/editor-new-network.yaml`](examples/editor-new-network.yaml) | **A network created with New in the editor.** Two routers with multiple IPv4/IPv6 loopbacks and router IDs, a cable, an iBGP session between IPv6 loopbacks, and a GRE tunnel between loopbacks with nested attributes. |
| [`examples/minimal-edited.yaml`](examples/minimal-edited.yaml) | **`minimal.yaml` imported and updated in the editor.** Loopbacks added, router IDs set, `r1` renamed to `edge-1` (references followed), cable attributes and an iBGP session added. The original comments are preserved. |
| [`examples/metro-ring.yaml`](examples/metro-ring.yaml) | **Representative architecture for Auto-arrange.** Six PE routers in three POPs on a fibre ring, IPv4/IPv6 loopbacks (router IDs, iBGP and RSVP-TE endpoints), an OSPF area, LDP per link, a dense 15-session iBGP mesh, TE tunnels, an L3VPN overlay, customer eBGP, a disconnected out-of-band network and an unconnected spare router. No stored positions. |
| [`examples/metro-ring-arranged.yaml`](examples/metro-ring-arranged.yaml) | `metro-ring.yaml` after **load → Auto-arrange (both views) → export**: identical network plus a `layout` section. A test checks it's reproducible, and the in-browser self-test checks that the browser computes the same positions. |
| [`examples/broken/errors-demo.yaml`](examples/broken/errors-demo.yaml) | Intentionally invalid, to show error reporting. It opens as a draft you can fix. |

`scripts/make-editor-examples.mjs` produces the two editor examples and `metro-ring-arranged.yaml` with the
same editing core the page uses, and a test checks that they're up to date.
The browser self-test (below) also builds a model and edits an imported one
through the real UI. It saves the files it "downloaded" in
`dist/selftest-downloads/`.

## Supported YAML (summary)

Supported: block mappings and sequences, plain and quoted scalars, `|` and `>`
block scalars, single-line flow `[…]` / `{…}`, comments, and one document.
Scalars follow the YAML 1.2 core schema; `yes`/`no` are strings.

**Rejected with a line-numbered error, before editing:** anchors and aliases,
merge keys, tags, directives, multiple documents, complex keys, multi-line
plain or quoted scalars, multi-line flow collections, tabs in indentation,
and duplicate keys. Input is limited to 2 MiB, 100k lines, depth 32 and 250k
nodes. Details are in [docs/YAML-SUBSET.md](docs/YAML-SUBSET.md).

## Build

Requirements: Node.js ≥ 18. The only dependency is the TypeScript compiler
(a devDependency). There are no runtime or application-library dependencies.

```sh
npm install        # installs typescript only
npm run build      # -> dist/netatlas.html
```

`npm run build` does three things:

1. `scripts/gen-examples.mjs` embeds `examples/*.yaml` into
   `src/generated/examples.ts` for the **Examples…** menu.
2. `tsc` compiles `src/**/*.ts` to CommonJS JavaScript in `build/js/`.
3. `scripts/build.mjs` bundles those modules into one inline `<script>`. It's
   a small wrapper that refuses any non-relative `require`. It then inlines
   `src/styles.css` into `src/index.html` and writes
   **`dist/netatlas.html`**. The browser never sees or compiles TypeScript.

To regenerate the editor examples after changing the editing core, run
`node scripts/make-editor-examples.mjs`. Use `--check` to only verify them.

## Verification

```sh
npm test                    # build + all automated tests (Node + headless browser)
npm run selftest:browser    # only the in-browser end-to-end test (verbose)
node scripts/browser-selftest.mjs --shot   # also writes screenshots to dist/screenshots/
```

| Area | Where | What is checked |
|---|---|---|
| Parsing | `test/yaml.test.mjs` (19 tests) | Every supported construct; rejection (with line numbers) of anchors, aliases, tags, merge keys, directives, multiple documents, multi-line scalars and flow, tabs, duplicate keys and bad escapes; all resource limits; `__proto__` safety; all examples conform to the subset |
| Validation | `test/validate.test.mjs` (17 tests) | Examples valid; unknown keys, ids and references reported with suggestions; one cable per port; logical interfaces can't be cabled; `over` cycles; protocols; groups; limits; the broken demo file's exact errors |
| **Editor core and round trips** | `test/editor.test.mjs` (22 tests) | **Example files written back byte-for-byte.** A torture document and 400 random trees round-trip. **Create → export → reload.** **Import → edit → export → reload** (untouched text identical). **Attributes no diagram shows, and unknown keys, survive.** Renames update every kind of reference. Deletes report broken references; undo/redo; shorthand expansion; canonical key order. **Multiple IPv4/IPv6 loopbacks.** Every class of invalid loopback address, with the error located at the exact address. `router_id` rules; duplicate-address and CIDR-membership warnings; compatibility with existing loopbacks; loopback display in both views and details; drafts with errors still draw; the editor examples are reproducible. |
| **Auto-arrange** | `test/layout.test.mjs` (18 tests) | **Repeatability** (fresh documents give identical integer positions). **Order independence:** every example with shuffled keys, sections and lists and swapped cable ends, 3 seeds each, gives the same canonical input and identical positions in both views; fields that don't affect geometry don't matter. **Idempotence:** a second arrange changes nothing and adds no undo step. **Load → arrange → export → reload:** same positions and same rendered scene, and re-arranging after reload is a no-op; the arranged example is reproducible. **Manual moves:** only the moved node changes; the other view is untouched; arrange ignores manual positions; undo restores them. **Edits never re-arrange:** the first geometric edit freezes the shown positions; new nodes go next to their neighbors without overlap; renames carry positions; deletes drop them. The YAML tab is taken literally. **Semantics:** the model is identical with and without `layout`, and bad entries are warnings only. **Disconnected components** of different sizes: no overlaps in either view, and component bounding boxes are disjoint. **Dense relationships:** a 12-router full mesh with tunnels has no overlaps and gets a lane per relation. No overlaps for any example. **Static determinism guard:** no `Math.random`, time, `localeCompare`, `hypot`/`sin`/`cos`/`pow` or DOM measurement in layout code. Large-model runtime |
| Rendering | `test/render.test.mjs` (12 tests) | Physical view: devices, cables and ports, no relations. Logical view: relations, no cables; tunnels as tubes; GRE inside IPsec; parallel lanes; protocol matrix; hostile labels stay text; deterministic layout |
| View switching | `test/state.test.mjs` (8 tests) | Physical ↔ logical switching keeps the selection and positions; highlight sets; search, details and legend |
| Offline / artifact | `test/build.test.mjs` (7 tests) | One inline script; no external references or remote URLs; no `fetch`, XHR, WebSocket, `eval`, `innerHTML` …; strict CSP before the script; compiled JavaScript only; every module comes from `src/` |
| **End-to-end in a real browser** | `test/browser.test.mjs` → `dist/netatlas.html#selftest` (128 in-page checks) | Headless Chrome, Edge or Chromium opens the file from `file://` **with DNS resolution disabled** and drives the real UI. **Viewer:** every example loads through the File API path, both views are drawn, loopback chips appear only in the logical view, interaction works. **New model:** add a device, **add two loopbacks, type IPv4/IPv6 addresses, see the error for an address without a prefix and fix it**, set `router_id`, add interfaces, a cable, a GRE tunnel between loopbacks with nested attrs, then **download and reload** the file. **Imported model:** rename a device (every reference follows), edit, add an IPv6 loopback, download as `…-edited.yaml`, **reload, and check that edits, hidden attributes and comments survived**. **Guards:** unsaved-changes dialog on replace; `beforeunload`; Ctrl+Z/Y; deleting a referenced device reports broken references; **exporting an invalid model requires "Download anyway"**; YAML-tab apply/reject; unknown keys kept and movable into attrs; typed text is committed before a button acts. **Auto-arrange:** loading stores nothing; the dialog shows the scope; arranging an automatic layout stores it without moving anything; repeating it is a no-op; a manual move changes only that node and is undone by arrange (and restored by undo); **arrange → export → reload is pixel-identical in both views**; a file with every list and key reversed arranges identically; **the browser reproduces the build-time positions of `metro-ring-arranged.yaml`** (a cross-engine determinism check when run in Firefox or Safari). **Safety:** hostile labels create no elements; YAML syntax errors are refused with the current model kept; **no network requests, no CSP violations**. The test is skipped if no Chromium-based browser is installed; set `NETATLAS_BROWSER` to choose one. |

### Manual check (any browser, e.g. Firefox or Safari)

1. Disconnect the network, or use an air-gapped machine.
2. Open `dist/netatlas.html#selftest`. A result panel appears; `"pass": true`
   means all in-page checks passed.
3. Open `dist/netatlas.html` with the developer tools' *Network* tab open.
   Click **New**, select `router1`, press **+ Loopback**, and type
   `10.255.0.9` into the address field. An error asks for a prefix length;
   change it to `10.255.0.9/32` and the error disappears. Switch to
   **Logical**: the loopback chip is under the device. No request appears in
   the Network tab.
4. **Open YAML…** → `examples/enterprise-wan.yaml`. The page asks about the
   unsaved new model first. Rename `hq-rtr1` in the Edit tab and download:
   the dialog proposes `enterprise-wan-edited.yaml`. Open the downloaded
   file: the rename, all comments and all other content are there.
5. Open `examples/broken/errors-demo.yaml`. It opens as a draft with five
   errors, each shown next to its field and listed in **Problems**.
6. **Auto-arrange:** open `examples/metro-ring.yaml`; the zoom bar says
   *positions: automatic*.
   * Drag `pe3` somewhere else, then choose **Auto-arrange… → Both views**:
     `pe3` returns and the toast reports what moved.
   * Choose **Auto-arrange…** again: "Already arranged — nothing moved".
   * Press Ctrl+Z: `pe3` is back where you dragged it.
   * Download, then open the downloaded file: both views look exactly the
     same. Its `layout:` section matches the one in
     `examples/metro-ring-arranged.yaml` after the same arrange.

## Security model

* Input is untrusted. Everything user-supplied (from files or typed into the
  editor) reaches the page only as text nodes, form-field values, or validated
  attribute values. Elements are only created with `createElement[NS]` and
  `setAttribute`; attribute names come from code and are filtered (no `on*`,
  `href`, `src`, `style`). Colours must match `#rgb`/`#rrggbb`. Class names
  derived from input are reduced to `[a-z0-9_-]`. The bundle contains no
  `innerHTML`, `eval` or `Function`.
* There is no network at all: a CSP with `default-src 'none'`, no external
  resources, and no network APIs. Saving uses a local Blob download.
* Input size and complexity are bounded at every stage: file size, YAML
  lines/depth/nodes/scalar length, entity counts, error count, layout
  iterations, and the undo history (100 steps).

## Limitations (honest list)

* **YAML subset, not full YAML.** Files that use anchors or aliases, or
  multi-line plain scalars, must be rewritten before they can be opened.
  The error message says so and points to the line.
* **Formatting is normalized on export.** Indentation, flow spacing,
  `>` blocks and runs of blank lines change (see above); comments and key
  order are kept. A comment attached to something you delete is moved to the
  next item or dropped with it. Comments can only be added or edited in the
  YAML tab.
* **Saving creates a new file.** Browsers don't let a page overwrite the file
  it opened. You choose the name in the download dialog; where it goes
  depends on the browser's download settings. The `beforeunload` prompt is
  the browser's generic one, and some browsers limit when it's shown.
* **Auto-arrange is heuristic.** It reduces crossings and overlaps but
  doesn't minimize them, so dense meshes (e.g. a full iBGP mesh) still cross.
  Cables and relations are straight lines, not orthogonally routed. Positions
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
  syntax (strictly for loopbacks), duplicate addresses, and whether members
  are inside their network's prefix. It doesn't check routing, reachability
  over the `over:` path, or VLAN consistency.
* **Text measurement is estimated** (no font metrics), so long labels are
  shortened with "…". The full text is in the inspector and tooltips.
* **Keyboard access:** forms and panels are keyboard-operable, but diagram
  elements aren't individually focusable.
* The automated browser test needs a Chromium-based browser. Firefox and
  Safari are covered by the manual `#selftest` procedure.

## Contributing

Work happens on short-lived branches with pull requests into `dev`; releases are pull requests from `dev` into `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) and, for the GitHub rules that enforce it, [docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md).

## Project layout

```
src/                  TypeScript application source
  yaml.ts             YAML-subset parser (positions, comments, styles, limits)
  yaml-write.ts       YAML-subset serializer (inverse of yaml.ts)
  doc.ts              Editable document: tree edits, undo/redo, renames with references, export
  ip.ts               IPv4/IPv6 address and prefix handling
  model.ts            Typed model (derived from the document for drawing)
  protocols.ts        Built-in protocol registry (extensible from YAML)
  validate.ts         Document -> model + errors/warnings located at YAML nodes
  editor.ts           Model outline + property inspector (forms, cards, generic tree editor)
  layout-physical.ts  Physical auto-arrange (tiered nested groups, components); port placement
  layout-input.ts     Canonical, order-independent layout input
  layout-auto.ts      Stored vs automatic positions, placement of new nodes
  layout-logical.ts   Logical auto-arrange (stress / force layout, crossing reduction)
  render-physical.ts  Physical view -> virtual SVG tree
  render-logical.ts   Logical view: lanes, nested tubes, hubs, networks, loopback chips
  state.ts            DOM-free session: view switching, selection, search
  panels.ts           Details, tooltip, legend, relation list
  scene.ts, dom.ts    Virtual nodes and the only VNode -> DOM code
  ui.ts, main.ts      Browser shell (file I/O, dialogs, pan/zoom, editor wiring)
  selftest.ts         In-browser end-to-end checks (#selftest)
  index.html, styles.css
scripts/              build.mjs, gen-examples.mjs, make-editor-examples.mjs, browser-selftest.mjs
test/                 node:test suites
examples/             Example inputs (all conform to the subset)
docs/                 FORMAT.md, YAML-SUBSET.md, screenshots
dist/netatlas.html    The deliverable
```

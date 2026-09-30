# NetAtlas

**NetAtlas — an explorable map of a network architecture.**

NetAtlas lets you create, edit and explore physical and logical network
diagrams from a single YAML file, entirely offline. The whole tool is one
self-contained HTML file, `dist/netatlas.html`, that runs in any modern
browser, including on an air-gapped machine. Start a new model or open a YAML
file, then:

* **Physical view:** devices, their ports (with interface names), cabling
  (medium, speed, and the VLANs each end permits, e.g. a trunk), and
  locations such as sites, floors, rooms and racks, drawn as nested boxes.
* **Logical view:** IP networks with their members, device loopbacks,
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

> **Breaking change on `dev` (unreleased): the YAML format was restructured.** Each fact
> is now configured in one place and derived everywhere else: network
> members and interface VLANs are computed from addresses, speed and medium
> live only on the link, and each link end lists its own VLANs. The version
> line stays `netatlas: 1`, but files written for release 0.1.x that use the
> removed keys are **not converted**; they open as a draft with one error
> per key to change. See
> [Changes from the earlier format](docs/FORMAT.md#changes-from-the-earlier-format).

**Version 0.1.0**, the first release. It's a usable initial version; see
the [changelog](CHANGELOG.md) for what it covers, and
[Limitations](#limitations-honest-list) for what it doesn't.

| Editor: outline, inspector with the device type, loopbacks; logical view | Physical view of the same network |
|---|---|
| ![Editor with the inspector open for router hq-rtr1 in the logical view](docs/img/editor.png) | ![Enterprise WAN, physical view](docs/img/wan-physical.png) |

| Selecting the GRE tunnel: IPsec → GRE → OSPF in the logical view… | …and the cables it rides on in the physical view |
|---|---|
| ![GRE tunnel selected in the logical view](docs/img/wan-logical-gre-selected.png) | ![GRE tunnel path highlighted in the physical view](docs/img/wan-physical-gre-path.png) |

| All 15 device types, each with its own icon; the legend lists them by name | Data-center fabric: spines raised with `tier`, leaves, servers |
|---|---|
| ![Campus example using every device type, with the legend](docs/img/device-types.png) | ![Data-center fabric, physical view](docs/img/dc-physical.png) |

| **Auto-arrange**, physical: POP sites, customer, separate OOB island | **Auto-arrange**, logical: iBGP mesh between loopbacks, tunnels, OOB component |
|---|---|
| ![Metro ring after Auto-arrange, physical view](docs/img/metro-physical.png) | ![Metro ring after Auto-arrange, logical view](docs/img/metro-logical.png) |

The **Auto-arrange…** button and the per-view status (*Auto-arranged* /
*Manually adjusted* / *Edited since arranged*) sit in the top toolbar.

## Open it, create or load a model

1. Get `netatlas.html`: attach it from the
   [GitHub release](https://github.com/hafnerst/netatlas/releases), or take
   `dist/netatlas.html` from this repository (or build it, see *Build*).
   It's the only file you need. Open it in Chrome, Edge, Firefox or Safari. Double-click
   it, drag it into a browser window, or enter its `file:///…/netatlas.html`
   path in the address bar. (Don't open `src/index.html`: that's only the
   build template.)
2. Either:
   * click **New** to start from an empty model, then add objects with
     **+ Add** in the Model outline;
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
| Add an object | **+ Add** next to a section of the Model outline (devices, links, networks, relations, groups, protocols). A new object gets only a unique ID; **nothing else is chosen for you**. A device has no type, a group no kind, a network no prefix or VLAN, a protocol no category, a relation no protocol (fields show prompts such as *Select device type*). Until you fill them in, the missing required values (a relation's protocol and endpoints, a link's ends) are reported as errors. |
| Duplicate | **Duplicate** on an object copies all its values and attributes under a new ID. |
| Edit fields | Type in the inspector. A change is applied when you press Enter, leave the field, or click anything else, including the diagram. |
| Rename an ID | Edit the **ID** field. Every reference (links, endpoints, `over`, `router_id`, group parents, protocol names) is updated, and a notice says how many. |
| Interfaces and loopbacks | In a device: **+ Loopback** / **+ Interface**. Each one is a collapsible card with all interface fields, an address list, attributes, and the relations that use it. **Network / VLAN** on the card is *derived*: it is computed from the addresses and the networks, can't be edited, and changes as soon as an address or a network changes. |
| Networks | A network is its prefixes and, optionally, the VLAN it lives in. **Members** is *derived*: every device with an interface or loopback address inside a prefix, listed once with the matching interfaces and addresses. To add a member, give it an address in the network. |
| Link VLANs (trunks) | On a link, **End A VLANs** and **End B VLANs** each take any number of VLAN IDs: pick a VLAN that a network defines, or type IDs (`10, 20, 30-32`). Several IDs read **Trunk**, one reads **VLAN n**, none reads **No VLAN**. Each end is stored separately; if they differ, a warning shows the difference and nothing is changed for you. Speed and medium are set here too, and only here. |
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
| Selection context in the lists | the element lists on the left and the **Relations** tab show the same selection: the selected entry is marked **▸** (bold, with a bar), entries **directly** related to it are marked **•**, and all others are greyed out but stay readable, clickable and keyboard-focusable. Select from either list or the diagram; `Esc` clears it. See *Which entries count as related* below. |
| Hover | tooltip with a short summary |
| Rearrange | drag devices or networks. The position is stored in the model (one undo step each) and exported with it. |
| Auto-arrange | **Auto-arrange…** in the top toolbar (or `A`): recomputes the positions of the **whole model** for this view or both views. The badges next to it show whether each view is auto-arranged. See below. |
| Find | `/` or the search box: ids, labels, IP addresses, CIDRs, protocols, cable ids |
| Filter | **Legend** tab (logical view): turn protocols on and off; top-bar toggles for labels, networks and a faint physical underlay |
| Export picture | **Save SVG** saves the current view as a standalone SVG file |

### Which entries count as related

The lists mark an entry as related only if the model references it directly
from the selected entry, or the other way round. Something reachable only
through another object stays greyed out. For example, the router at the other
end of a switch's cable is two steps away (switch → cable → router).

| Selected | Directly related |
|---|---|
| Device | its own group (not the enclosing ones), its cables, networks containing one of its addresses, relations with it or one of its interfaces as an endpoint |
| Port (in the diagram) | selects its device; related are the cable on that port, the networks containing an address of that interface, and the relations that name exactly that interface |
| Link (cable) | its two devices, relations carried directly over it |
| Network | its member devices (derived from addresses), relations in it (`network:`) or carried directly over it |
| Relation | its endpoint devices, its `network`, what it is carried `over`, relations carried over it, and its protocol if that is defined in the file's `protocols:` section |
| Group | its parent group, its sub-groups, devices placed directly in it |
| Protocol | relations using exactly that protocol id (aliases such as `ebgp` → `bgp` don't count) |

The rule is symmetric: if A is related to B, then B is related to A. The
diagram highlights at least these entries. It also highlights path context
that the lists don't count as direct:
* the devices at both ends of a highlighted cable or relation;
* the full underlay path of a tunnel, e.g. the cables under GRE-over-IPsec;
* everything inside a selected group.

Both come from the same model references, in `src/model/queries.ts`
(`selectionContext` and `relatedRefs`).

## Auto-arrange and positions

The **Auto-arrange…** button in the top toolbar, next to *Physical* /
*Logical* (or press `A`), lays out the entire model, not just what is
visible or selected. It includes objects hidden by filters. A dialog shows
the scope and the current status of each view, and lets you choose
**Arrange <current> view only** or **Arrange both views**. The result is one
undo step (Ctrl+Z). It never runs by itself.

Next to the button, one badge per view tells you whether that view matches
the Auto-arrange result (the badge of the shown view is highlighted):

| Status | Meaning |
|---|---|
| ✓ **Auto-arranged** | Every object is exactly where Auto-arrange puts it for the current model. |
| ✎ **Manually adjusted** | Some objects were dragged away from their auto-arranged positions. |
| ● **Edited since arranged** | The model changed after arranging (e.g. a device was added). Existing objects kept their positions and new ones were placed next to their neighbors, so the diagram no longer matches a fresh Auto-arrange. Nothing was moved by hand. |

The status is **derived from the document every time**: it compares the
current positions with the deterministic Auto-arrange result for the current
model. So it's correct after undo/redo, after export and reload, and when
objects are back at their calculated positions. Physical and logical views
are tracked separately. Ordinary model edits never count as manual
adjustments.

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

* **Exported YAML stores the coordinates** once there are any to store.
  Opening a file never writes positions: without a `layout` section the
  diagram shows the auto-arranged layout (*Auto-arranged*).
* When you drag a node, or make the first edit that changes the geometry
  (adding, removing or renaming objects, changing labels, groups, cables or
  relations), the positions currently shown are stored. From then on nothing
  moves by itself; new objects are placed next to their neighbors.
* Dragged nodes are also listed in `layout.manual`, which is how
  *Manually adjusted* is told apart from *Edited since arranged* after a
  reload. Auto-arrange clears that list for the arranged view, and a node
  dropped exactly on its calculated position leaves it.
* Load → Auto-arrange → export → reload shows exactly the same diagram with
  the same status.

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
      - {id: eth0, ip: 192.0.2.1/30}
      - {id: tun0, type: tunnel}
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
  - id: r2
    type: router
    interfaces:
      - {id: eth0, ip: 192.0.2.2/30}
      - {id: tun0, type: tunnel}
links:                                   # physical cabling only; speed and medium live here
  - {id: cable-1, a: "r1:eth0", b: "r2:eth0", medium: copper, speed: 1G}
networks:                                # IP networks; r1 and r2 are members through their addresses
  - {id: transfer, cidr: 192.0.2.0/30}
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
* **Configure once, derive elsewhere.** A network has prefixes and,
  optionally, a VLAN; its members are whoever has an address inside. An
  interface's VLAN is the VLAN of the network containing its address. Speed
  and medium belong to the link. Each end of a link lists the VLANs it
  permits (several = a trunk). Derived values are shown read-only and are
  never written to the file. The
  [table of sources](docs/FORMAT.md#configure-once-derive-elsewhere) has the
  details.
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
| [`examples/enterprise-wan.yaml`](examples/enterprise-wan.yaml) | HQ with two ISPs and two branches. **IPsec → GRE → OSPF** stacks over the same internet uplinks that also carry eBGP and BFD. WireGuard backup over LTE, loopbacks used by iBGP, a multipoint OSPF area, VRRP, LACP, syslog, an undeclared protocol and a user-defined one (MACsec). IP networks with derived members, two of them with a VLAN, and trunk cables (VLANs 10 and 20 on both ends). |
| [`examples/datacenter-evpn.yaml`](examples/datacenter-evpn.yaml) | Spine/leaf fabric in racks: eBGP underlay, EVPN sessions between loopbacks, a multipoint VXLAN VNI, MLAG, LACP, and a user-defined `srv6` tunnel. The tenant network's members are the leaves' SVIs, which carry the VRF. |
| [`examples/minimal.yaml`](examples/minimal.yaml) | Two routers, one cable, OSPF inside GRE. |
| [`examples/editor-new-network.yaml`](examples/editor-new-network.yaml) | **A network created with New in the editor.** Two routers with multiple IPv4/IPv6 loopbacks and router IDs, a cable, an IP network that both routers join through their port addresses, an iBGP session between IPv6 loopbacks, and a GRE tunnel between loopbacks with nested attributes. |
| [`examples/minimal-edited.yaml`](examples/minimal-edited.yaml) | **`minimal.yaml` imported and updated in the editor.** Loopbacks added, router IDs set, `r1` renamed to `edge-1` (references followed), cable attributes and an iBGP session added. The original comments are preserved. |
| [`examples/metro-ring.yaml`](examples/metro-ring.yaml) | **Representative architecture for Auto-arrange.** Six PE routers in three POPs on a fibre ring, IPv4/IPv6 loopbacks (router IDs, iBGP and RSVP-TE endpoints), an OSPF area, LDP per link, a dense 15-session iBGP mesh, TE tunnels, an L3VPN overlay, customer eBGP, a disconnected out-of-band network and an unconnected spare router. No stored positions. |
| [`examples/metro-ring-arranged.yaml`](examples/metro-ring-arranged.yaml) | `metro-ring.yaml` after **load → Auto-arrange (both views) → export**: identical network plus a `layout` section. A test checks it's reproducible, and the in-browser self-test checks that the browser computes the same positions. |
| [`examples/device-types.yaml`](examples/device-types.yaml) | **Every device type.** A campus with internet edge, VPN gateway, firewall, inline IPS, a DMZ with load balancer and proxy, core/access switching with Wi-Fi and endpoints, and a server room with a hypervisor, a VM, a container, NAS and a monitoring appliance. |
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

To retake the README screenshots in `docs/img/` after a UI change, run
`node scripts/readme-screenshots.mjs` after `npm run build`. It needs Chrome,
Edge or Chromium and uses the page's deep links
(`#example=<n>&view=<physical|logical>&select=<ref>`).

### Is the checked-in HTML current?

`dist/netatlas.html` is committed so that it can be used without building.
To confirm that it was generated from the current source:

```sh
git status --short        # 1. clean working tree (no local edits)
npm ci                    # 2. the pinned TypeScript version
npm run check:dist        # 3. rebuild in memory and compare byte-for-byte
```

`check:dist` regenerates `src/generated/examples.ts` and the bundle in memory
and writes neither file. It prints the sha256 of the result, and exits with
status 1 if either committed file differs. The build is deterministic, so the
same source always gives the same file. `npm test` checks this too.

## Verification

```sh
npm test                    # build + all automated tests (Node + headless browser)
npm run check:dist          # is dist/netatlas.html generated from the current source?
npm run selftest:browser    # only the in-browser end-to-end test (verbose)
node scripts/browser-selftest.mjs --shot   # also writes screenshots to dist/screenshots/
```

| Area | Where | What is checked |
|---|---|---|
| Parsing | `test/yaml.test.mjs` (19 tests) | Every supported construct; rejection (with line numbers) of anchors, aliases, tags, merge keys, directives, multiple documents, multi-line scalars and flow, tabs, duplicate keys and bad escapes; all resource limits; `__proto__` safety; all examples conform to the subset |
| Validation | `test/validate.test.mjs` (17 tests) | Examples valid; unknown keys, ids and references reported with suggestions; one cable per port; logical interfaces can't be cabled; `over` cycles; protocols; groups; limits; the broken demo file's exact errors |
| **Editor core and round trips** | `test/editor.test.mjs` (22 tests) | **Example files written back byte-for-byte.** A torture document and 400 random trees round-trip. **Create → export → reload.** **Import → edit → export → reload** (untouched text identical). **Attributes no diagram shows, and unknown keys, survive.** Renames update every kind of reference. Deletes report broken references; undo/redo; shorthand expansion; canonical key order. **Multiple IPv4/IPv6 loopbacks.** Every class of invalid loopback address, with the error located at the exact address. `router_id` rules; duplicate-address warnings; compatibility with existing loopbacks; loopback display in both views and details; drafts with errors still draw; the editor examples are reproducible. |
| **Auto-arrange** | `test/layout.test.mjs` (20 tests) | **Repeatability** (fresh documents give identical integer positions). **Order independence:** every example with shuffled keys, sections and lists and swapped cable ends, 3 seeds each, gives the same canonical input and identical positions in both views; fields that don't affect geometry don't matter. **Idempotence:** a second arrange changes nothing and adds no undo step. **Load → arrange → export → reload:** same positions and same rendered scene, and re-arranging after reload is a no-op; the arranged example is reproducible. **Manual moves:** only the moved node changes; the other view is untouched; arrange ignores manual positions; undo restores them. **Edits never re-arrange:** the first geometric edit freezes the shown positions; new nodes go next to their neighbors without overlap; renames carry positions; deletes drop them. The YAML tab is taken literally. **Semantics:** the model is identical with and without `layout`, and bad entries are warnings only. **Disconnected components** of different sizes: no overlaps in either view, and component bounding boxes are disjoint. **Dense relationships:** a 12-router full mesh with tunnels has no overlaps and gets a lane per relation. No overlaps for any example. **Static determinism guard:** no `Math.random`, time, `localeCompare`, `hypot`/`sin`/`cos`/`pow` or DOM measurement in layout code. Large-model runtime. **Layout status:** *auto / manual / edited* for each view after load, non-geometric edits, drags, undo/redo, a node moved back to its calculated position, export → reload, Auto-arrange and its repetition, model edits (never "manual"), renames and deletes; bad `layout.manual` entries are warnings only. |
| Rendering | `test/render.test.mjs` (12 tests) | Physical view: devices, cables and ports, no relations. Logical view: relations, no cables; tunnels as tubes; GRE inside IPsec; parallel lanes; protocol matrix; hostile labels stay text; deterministic layout |
| View switching | `test/state.test.mjs` (8 tests) | Physical ↔ logical switching keeps the selection and positions; highlight sets; search, details and legend |
| Offline / artifact | `test/build.test.mjs` (8 tests) | One inline script; no external references or remote URLs; no `fetch`, XHR, WebSocket, `eval`, `innerHTML` …; strict CSP before the script; compiled JavaScript only; every module comes from `src/`; one version in `package.json`, `package-lock.json`, the HTML (meta and UI) and `CHANGELOG.md` |
| Device types | `test/device-types.test.mjs` (6 tests) | Exactly the 15 specified types with their display names; each is accepted, has its own icon and a default tier; no type is allowed (generic icon); any other value (old names such as `l3switch`, `hypervisor`, `host`, `leaf`, `spine`, wrong case, hostile text) is an error at the type line with a suggestion or the list of types; display names in subtitles, details and the legend; the examples use only these types |
| New elements | `test/creation-defaults.test.mjs` (7 tests) | **New** is empty and valid; each new object gets only an ID (no type, kind, prefix, VLAN, protocol or category); missing required values are errors located at the object, optional ones stay unset; choosing a value saves exactly it and clearing removes the key; an empty group kind is not drawn as a site; **Duplicate** keeps all values; every example imports and exports byte-for-byte, with model values taken only from the file |
| **Derived values and retired keys** | `test/derive.test.mjs` (25 tests) | **Membership** from addresses: one entry per device with every match; the network prefix is the authority (the interface's own prefix length is ignored); IPv4 and IPv6 boundaries and prefix lengths (`/0`, `/30`, `/31`, `/32`, `/52`, `/128`); no matching across families; overlapping networks; invalid and incomplete addresses match nothing; invalid network prefixes are errors. **Interface VLAN:** derived per address; none when no network matches or no VLAN is defined; several addresses give several VLANs; conflicting networks give an explicit ambiguity and a warning. Derived values follow every edit and undo, and are **never written to YAML**. Membership drives highlighting, selection context, search and the layout input. **Link ends:** VLANs stored per end; Trunk / single / none; a mismatch is a warning and changes neither end; ID validation; editing one end never writes the other; short form restored when the last VLAN is removed; network VLANs and link VLANs are independent. **Earlier-format input:** every retired key and the renamed group kind is an error with instructions, located at the key; nothing is converted; the file is written back unchanged. The schema holds no retired key; `vrf` on interfaces; loopbacks have no physical-link properties. |
| Selection context | `test/selection-context.test.mjs` (6 tests) | Each element type (device, port, link, network, relation, group, protocol) gives the documented direct relationships; indirect ones (a cable's far end, a sub-group's devices, the cables under a tunnel's carrier, built-in protocols) are excluded; symmetric and a subset of the diagram highlight in every example; view-independent; protocols can be selected; the Relations list shows the same states with screen-reader text |
| Architecture | `test/architecture.test.mjs` (3 tests) | Every module lives in a layer folder; imports follow the allowed dependency direction (docs/ARCHITECTURE.md); the diagram, layout and UI layers never import the YAML layer |
| Module APIs | `test/modules.test.mjs` (9 tests) | Document editing operations (typed values, lists, endpoints, attrs, key order, one undo step each); the format schema is the single source of allowed keys; model queries; export file names; `check:dist` accepts the current build and rejects a stale HTML file |
| **End-to-end in a real browser** | `test/browser.test.mjs` → `dist/netatlas.html#selftest` (199 in-page checks) | Headless Chrome, Edge or Chromium opens the file from `file://` **with DNS resolution disabled** and drives the real UI. **Viewer:** every example loads through the File API path, both views are drawn, loopback chips appear only in the logical view, interaction works. **New model:** New is empty; a new device shows *Select device type* and saves no type until one is chosen; a new relation has no protocol and reports its missing protocol and endpoints (export then needs "Download anyway"); a new network is only an ID; add a device, **add two loopbacks, type IPv4/IPv6 addresses, see the error for an address without a prefix and fix it**, set `router_id`, add interfaces, a cable, a GRE tunnel between loopbacks with nested attrs, then **download and reload** the file. **Imported model:** rename a device (every reference follows), edit, add an IPv6 loopback, download as `…-edited.yaml`, **reload, and check that edits, hidden attributes and comments survived**. **Guards:** unsaved-changes dialog on replace; `beforeunload`; Ctrl+Z/Y; deleting a referenced device reports broken references; **exporting an invalid model requires "Download anyway"**; YAML-tab apply/reject; unknown keys kept and movable into attrs; typed text is committed before a button acts; **selection context in the lists:** selecting from the diagram, the left list and the right-hand Relations list keeps lists and diagram consistent for every element type (direct entries related, indirect ones dimmed), unrelated entries stay focusable and selectable, view switches leave no stale highlighting, and `Esc` clears everything; the device type is chosen from the 15 types by display name. **Auto-arrange:** the button is in the top toolbar, visible and labelled (disabled until a model is open); the status badges read *Auto-arranged* / *Manually adjusted* / *Edited since arranged* after loading, dragging, undo, switching views (the shown view is highlighted), Auto-arrange, moving a node back to its calculated position, export → reload of arranged and of manually adjusted layouts, a model edit, and New; loading stores nothing; the dialog shows the scope; arranging an automatic layout stores it without moving anything; repeating it is a no-op; a manual move changes only that node and is undone by arrange (and restored by undo); **arrange → export → reload is pixel-identical in both views**; a file with every list and key reversed arranges identically; **the browser reproduces the build-time positions of `metro-ring-arranged.yaml`** (a cross-engine determinism check when run in Firefox or Safari). **Safety:** hostile labels create no elements; YAML syntax errors are refused with the current model kept; **no network requests, no CSP violations**. The test is skipped if no Chromium-based browser is installed; set `NETATLAS_BROWSER` to choose one. |

### Manual check (any browser, e.g. Firefox or Safari)

1. Disconnect the network, or use an air-gapped machine.
2. Open `dist/netatlas.html#selftest`. A result panel appears; `"pass": true`
   means all in-page checks passed.
3. Open `dist/netatlas.html` with the developer tools' *Network* tab open.
   Click **New**: the model is empty. Press **+ Add** next to Devices: the
   new `device1` shows *Select device type*, and the YAML tab shows no
   `type:`. Choose *Router*: `type: router` appears. Press **+ Add** next to
   Relations: the protocol field is empty with a prompt, and Problems lists
   the missing protocol and endpoints. Select `device1` again, press
   **+ Loopback**, and type `10.255.0.9` into the address field. An error asks for a prefix length;
   change it to `10.255.0.9/32` and the error disappears. Switch to
   **Logical**: the loopback chip is under the device. No request appears in
   the Network tab.
4. **Open YAML…** → `examples/enterprise-wan.yaml`. The page asks about the
   unsaved new model first. Rename `hq-rtr1` in the Edit tab and download:
   the dialog proposes `enterprise-wan-edited.yaml`. Open the downloaded
   file: the rename, all comments and all other content are there.
5. Open `examples/broken/errors-demo.yaml`. It opens as a draft with five
   errors, each shown next to its field and listed in **Problems**.
6. **Auto-arrange:** open `examples/metro-ring.yaml`. The **Auto-arrange…**
   button is in the top toolbar, and the badges next to it read
   *Physical: Auto-arranged* and *Logical: Auto-arranged*.
   * Drag `pe3` somewhere else: the Physical badge changes to *Manually
     adjusted*, and switching to Logical shows that view is still
     *Auto-arranged*.
   * Choose **Auto-arrange… → Arrange both views**:
     `pe3` returns, the toast reports what moved, and both badges read
     *Auto-arranged*.
   * Choose **Auto-arrange…** again: "Already arranged — nothing moved".
   * Press Ctrl+Z: `pe3` is back where you dragged it, and the badge says
     *Manually adjusted* again.
   * Download, then open the downloaded file: both views look exactly the
     same and show the same badges. Its `layout:` section matches the one in
     `examples/metro-ring-arranged.yaml` after the same arrange.
7. **Selection context:** open `examples/enterprise-wan.yaml` in a window
   wider than 1100 px, so the element lists are shown.
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

8. **Derived values and trunk VLANs.** Keep the **YAML**
   tab in mind: at every step it must show only what you typed.
   * Click **New**. Add two devices; on each, press **+ Interface** (`eth0`).
     Add a link and choose `device1`/`eth0` for End A and `device2`/`eth0`
     for End B.
   * **Network membership, live.** Add a network and enter the prefix
     `10.77.0.0/24` and VLAN ID `77`. **Members (0)** is marked *derived* and
     has no input. Select `device1`, open `eth0`: there is no VLAN, speed or
     media field, and **Network / VLAN** (*derived*) says there is no
     address. Type `10.77.0.1/24` into Addresses: the line
     `10.77.0.1/24 → net1 · VLAN 77` appears at once. On `device2`/`eth0`
     type `10.77.0.2/16` (a different prefix length on purpose). Select the
     network: **Members (2)** lists both devices with interface and address.
     In the **Logical** view both are connected to the network.
   * **The network is the source.** Change the network's VLAN ID to `78`:
     both interfaces now show VLAN 78. Remove the address from
     `device2`/`eth0`: the network shows one member and one line.
   * **Ambiguity is shown, not resolved.** Add a second network with prefix
     `10.77.0.0/25` and VLAN ID `99`. `device1`/`eth0` shows
     *VLAN ambiguous: VLAN 78 (net1) or VLAN 99 (net2) — none is chosen*,
     and **Problems** lists a warning. Change the second network's prefix to
     `10.99.0.0/24`: the interface shows VLAN 78 again.
   * **Per-end trunk VLANs.** Select the link: both ends read **No VLAN**.
     In **End A VLANs** type `10, 20` and press Enter: End A reads
     **Trunk · VLANs 10, 20**, End B still reads **No VLAN**, a warning
     names the VLANs that are only on end A, and the **Physical** view marks
     the cable with ⚠. In End B, choose `78 · net1` from the list: End B
     reads **VLAN 78** (a single VLAN, not a trunk), and the warning stays.
     Type `10 20` into End B and remove `78` with its ×: the warning and the
     ⚠ disappear and the cable is labelled *Trunk 10,20*. Remove `20` from
     End A: End B keeps `10, 20` and the warning returns. Type `4095`: it is
     refused. Add `20` to End A again.
   * **Export and reload.** The YAML tab shows `vlans: [10, 20]` under `a`
     and under `b`, `cidr` and `vlan` on the networks, and neither `members`
     nor a `vlan` on any interface. **Download YAML**, then **Open YAML…**
     the downloaded file: the members, the interface VLANs, the trunk
     labels and both views are the same as before, and the status reads no
     unsaved changes.
   * **Earlier-format input.** In the YAML tab, add `speed: 1G` to an
     interface and `members: [device1]` to a network, and **Apply**.
     Problems lists one error for each of the two keys, each saying what to
     do; the keys are shown
     under **Other properties** on the interface and the network, and the
     YAML tab still contains them unchanged.

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
  and prefix syntax, duplicate addresses, VLAN IDs, and whether the two ends
  of a link permit the same VLANs. It doesn't check routing or reachability
  over the `over:` path, and it doesn't compare the VLANs on a cable with the
  VLAN derived for the port's addresses.
* **Membership is by address only.** VRFs are names on interfaces and don't
  separate address spaces: the same prefix used in two VRFs is one network
  with members from both. A device without addresses (an unmanaged switch, an
  access point in bridge mode) can't be shown as a member of a network.
* **VLAN lists are explicit.** A link end stores single IDs, not ranges; the
  editor expands `30-32` when you type it. A trunk of hundreds of VLANs is a
  long list.
* **Text measurement is estimated** (no font metrics), so long labels are
  shortened with "…". The full text is in the inspector and tooltips.
* **Keyboard access:** forms and panels are keyboard-operable, but diagram
  elements aren't individually focusable.
* **Narrow windows:** below 1100 px the element lists (Model outline) are
  hidden; the diagram, inspector and Relations tab still work.
* **Device types are a fixed list** of 15 (see [docs/FORMAT.md](docs/FORMAT.md));
  roles such as spine or leaf go in `role`.
* **An interface without `type` is a physical port** (a format rule that the
  shorthand `interfaces: [eth0]` relies on).
* **No other import or export formats** (only YAML in, YAML and SVG out), no
  printing layout, and no multi-user editing.
* The automated browser test needs a Chromium-based browser. Firefox and
  Safari are covered by the manual `#selftest` procedure.

## Contributing

Work happens on short-lived branches with pull requests into `dev`; releases are pull requests from `dev` into `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) and, for the GitHub rules that enforce it, [docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md).

## Project layout

The source is split into layers. Each layer imports only the layers below
it, and `test/architecture.test.mjs` enforces this. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the responsibilities, the
allowed dependencies and the trade-offs.

```
src/
  model/        Network model: types, protocol registry, IP handling, queries (refs, search)
  yaml/         YAML boundary: subset parser, serializer, format schema (keys + order)
  validation/   Parsed tree -> model + errors/warnings located at YAML nodes
  layout/       Deterministic auto-arrange for both views, stored vs automatic positions
  diagram/      Model + positions -> virtual SVG tree; DOM-free view session
  editor/       Editable document: editing operations, undo/redo, renames, layout section
  ui/           Browser: app shell, inspector, panels, dialogs, file I/O, VNode -> DOM
  app/          Entry point (main.ts) and in-browser self-test (selftest.ts)
  generated/    Examples embedded at build time (do not edit)
  index.html, styles.css
scripts/        build.mjs, gen-examples.mjs, make-editor-examples.mjs, browser-selftest.mjs,
                readme-screenshots.mjs
test/           node:test suites
examples/       Example inputs (all conform to the subset)
docs/           ARCHITECTURE.md, FORMAT.md, YAML-SUBSET.md, repository settings, screenshots
dist/netatlas.html   The deliverable (checked in; see "Is the checked-in HTML current?")
CHANGELOG.md    Release notes per version
CONTRIBUTING.md Branch workflow and release procedure
```

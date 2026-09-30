# Changelog

All notable changes to NetAtlas are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/). While the version is 0.x, minor
releases may still change behaviour; the YAML format has its own version
(`netatlas: 1`) and stays readable across application versions.

## [Unreleased]

### Added: Close model, port ranges

* **File → Close model**, right after *Download model…*: closes the current
  model and shows the start screen. Unavailable while no model is open. With
  unsaved changes it asks: **Download and close** (exports the YAML first),
  **Discard changes** or **Cancel** (nothing changes). The prompt says that a
  download is a new file and that an opened file is not overwritten. Closing
  clears the selection, view, filters, folding, zoom and search.
* **+ Port Range** beside **+ Interface** in a device's physical interfaces:
  enter a *From* and a *To* name (`ge 1/1` … `ge 1/24`), see the ports in a
  preview, and create them in one undoable step. The final number is the
  port number and the prefix must match. Missing numbers, different
  prefixes, a first number that isn't lower, duplicates on the device and
  ranges above 256 ports are rejected as a whole with the reason. Only
  physical interfaces are created; a name with characters an id can't have
  (a space) becomes the label and gets an id with "-" instead.

### Changed: start screen and Export menu

* **New start screen.** Before a model is open the page shows the NetAtlas
  name and logo, one sentence, and three ways to begin: **New model**,
  **Open YAML file…** (also the drop target) and **Load example** (a picker
  with the six examples, then *Load*). The long description and the row of
  example links are gone, and the two side panels appear with the first
  model. Dropping a file anywhere still opens it; every drag and drop on the
  page is taken over, so the browser can't navigate away. The "could not
  open" page offers to open another file, start a new model or go back.
* **Export menu.** *Save SVG* moved from the zoom bar into an **Export** menu
  next to **File**: **Export current view as SVG** exports the selected view
  (Physical or Logical) exactly as before, with its legend and Networks
  overview. It is disabled until there is a diagram. The two menus share
  their behaviour; the left and right arrow keys move between them.

### Changed: toolbar and model outline

* **Six examples.** `editor-new-network.yaml`, `minimal-edited.yaml` and
  `metro-ring-arranged.yaml` are no longer offered as examples. They are
  generated test data and moved to `test/fixtures/`
  (`scripts/make-fixtures.mjs`, formerly `make-editor-examples.mjs`).
* The selection hint above the outline reads "selected · related (n)"; the
  words "others dimmed" are gone. The dimming itself is unchanged.

* **One File menu.** *New*, *Open YAML…*, *Download YAML* and the examples
  list are grouped in a **File** menu next to the logo: **New model**,
  **Open model…**, **Download model…** and, under **Examples**, the built-in
  files. The three commands follow one pattern (verb + "model"), and an entry
  ends in "…" exactly when it asks for something first (a file to pick, a
  file name to confirm). Tooltips say what each does. Undo/redo, Physical/Logical,
  Auto-arrange and Find stay direct controls.
* **Current model** in the toolbar opens the edit view of the entire model
  (title, description, format version). It replaces the "Document" entry at
  the top of the left panel, and the interface now says "model" instead of
  "document".
* **Outline sections fold.** Each heading of the left panel folds its
  section; Links and Protocols start folded, and *Collapse all* / *Expand
  all* does every section. A folded section keeps its count, its problem
  badge, the selected entry and the number of related entries; the filter
  still searches it.
* Fixed: the toolbar's drop-downs (search results) were cut off by the
  toolbar since it became a scrolling box; the toolbar no longer scrolls or
  clips, and drop-downs stay inside the window.

### Breaking: interfaces in two categories instead of a hierarchy

The nesting of logical and tunnel interfaces under physical interfaces, and
the separate `loopbacks` list, are replaced. Nothing is converted and no old
key is kept: `children:` and `loopbacks:` are errors that say what to do,
their entries are not read, and the file keeps them until you move them.

* A device has `interfaces` (physical: ports, no type) and
  `logical_interfaces` (each with `type: loopback`, `virtual` or `tunnel`).
  Both lists share one set of ids per device; `device:interface` references
  are unchanged.
* No generic parent. An aggregate lists its `members` (physical interfaces
  of the same device, validated). A VLAN interface names its `vlan`, or takes
  it from the network of its address; the **ports carrying the VLAN** are
  derived from the link ends and shown read-only. A tunnel names its
  `source` (any interface of the device, or an address) and `destination`
  (an address, a device or `device:interface`).
* Editor: two sections, *Physical interfaces* and *Logical interfaces*, with
  **+ Loopback**, **+ Virtual**, **+ Tunnel**; the child-interface controls
  are gone. Cards are sorted alphabetically without touching the file.
* Diagrams and selection: a logical interface highlights the ports it uses
  and their cables (member ports, ports carrying its VLAN, a tunnel's
  source) and a tunnel's destination; a port highlights the logical
  interfaces that use it. The device details have one table per category.
* The Networks box of a physical export counts, for a drawn port, the
  aggregates it is a member of and the VLAN interfaces it carries.

### Fixed

* **The application fits the browser viewport.** In a window that wasn't
  maximized, the page could get a scrollbar of its own and the right-hand
  panel could extend below the status bar. The cause was the hidden
  screen-reader texts of list entries: far down a long list they were laid
  out against the page instead of their panel and made the document as tall
  as the list. The panels are now the containing blocks of their content,
  the document is clipped, the shell is sized by the viewport (`100dvh`)
  with a middle row that may shrink, and dialogs are bounded
  by the window. Long forms and lists scroll inside their panels.

### Breaking: fewer device fields, no interface type on ports

The YAML format changes incompatibly (the version line stays `netatlas: 1`;
the tool isn't used in production). Nothing is converted and no old key is
kept as an alias: a file in the old form opens as a draft with one error per
key to change. See "Changes from the earlier format" in `docs/FORMAT.md`.

* **`interfaces` holds physical interfaces only.** They have no `type` key;
  writing one (any value) is an error. In the editor their type is the
  read-only text *Physical*. Interfaces of the 0.1.x types `loopback`,
  `tunnel`, `vlan`, `svi`, `subinterface`, `lag` … are logical interfaces
  (see above).
* Only a physical interface can be the end of a link; relations can use any
  interface.
* **Removed from devices:** `vendor`, `model`, `role`, `mgmt` and
  `router_id`. They are errors in a file and gone from the editor, the
  subtitle of a device (now just its type), tooltips, details and search.
  The ★ router-ID marker is gone; loopbacks and their addresses are
  unaffected.
* Examples, documentation and tests use the new format.

### Changed

* **Auto-arrange arranges the view on screen only.** The dialog that offered
  "this view" or "both views" is gone, and the other view is never touched.
  If the view has positions that were set by hand, a confirmation says which
  objects move and that the other view stays as it is; Cancel changes
  nothing. A view that already matches the auto-arranged layout, or differs
  only because the model was edited, is not asked about. Determinism,
  idempotence and the status on the button are unchanged.
* **Exported SVG files contain a Networks overview** in a second box beside
  the legend, in both views. It lists the networks relevant to the exported
  view (name, prefixes, VLAN), decided from what the picture shows: ports,
  the virtual interfaces using them and cable VLANs in the physical view; network
  nodes, relations and loopbacks in the logical view. Long names wrap, long
  lists continue in columns, and an empty list says so.
* **Interfaces and loopbacks are shown alphabetically** (digits by value) in
  the editor, the details, interface pickers and the loopback chips. The
  order in the YAML file is not changed by this.
* Device boxes are narrower where a role or model used to be in the
  subtitle, so auto-arranged positions change again. Stored layouts are kept
  and show *edited since arranged* until Auto-arrange is used.

* **Auto-arrange places groups by their cabling** (physical view). Blocks
  that are cabled to each other form layers: a group lies one layer below the
  block it is cabled to, as close as possible to the point under the devices
  it connects. In `enterprise-wan.yaml` the provider group is now between the
  Internet and the HQ routers instead of at the bottom: total cable length
  drops by about half and no cables cross (16 crossings before). The rule
  uses only the topology and device tiers, never a group's kind or name.
  Disconnected groups are packed beside the connected part. Auto-arranged
  positions change again; stored layouts are kept as they are.

* **Diagram elements are sized for their text; nothing is shortened with
  "…".** Labels wrap (line breaks in a device label are kept as lines),
  long words are broken, and boxes, network pills, group titles and relation
  labels grow to fit. Networks show all their prefixes. The device label
  field in the editor accepts line breaks.
* **Auto-arrange accounts for real sizes and labels.** Rows leave room for
  port labels and cable labels; connected nodes in the logical view are
  spaced for the labels between them. Diagrams are somewhat larger.
* **Cables:** ports that face each other are lined up, so such cables (and
  parallel cables between the same devices) are straight; a cable bends
  around a device instead of crossing it. Every cable with a speed, VLANs or
  a label now shows it (short cables used to lose their label).
* **Labels get their own places:** cable labels, relation labels and
  addresses on membership lines avoid nodes and each other. A relation
  nested in a tunnel is named, with its own label, in the tunnel's label.
* Auto-arranged positions differ from earlier versions. Stored layouts are
  kept as they are and show *edited since arranged* until Auto-arrange is
  used again.
* New example `long-labels.yaml`. The two editor examples are now
  auto-arranged at the end of their script.

* **The model panel is always visible.** The *Model* toggle button in the
  toolbar is gone. In narrow windows the panel gets narrower (below 1100 px)
  or moves under the diagram next to the side panel (below 860 px) instead
  of being hidden.
* **Exported SVG files contain the legend** of the exported view, for both
  views. It is drawn to the right of the diagram, never over it, and the
  picture is enlarged so that nothing is clipped. It lists what the picture
  shows (hidden protocols are left out).

* **Layout status moved onto the Auto-arrange button.** The separate status
  badges in the toolbar are gone. The button shows the status of the view on
  screen with an icon (✓ matches the auto-arranged layout, ✎ manually
  adjusted, ● edited since arranged), a colour and border, and a message
  that is both the hover text and the button's accessible description. The
  status rules and the Auto-arrange algorithm are unchanged.

### Breaking: restructured YAML format

**Files written for release 0.1.x that use the removed keys are not
converted.** They open as a draft with one error for every key that has to
change; each error says what to do. Update the file by hand. The format
version stays `netatlas: 1`: the tool isn't used in production yet, so this
one incompatible change is made without a new format version. The full table
is in [docs/FORMAT.md](docs/FORMAT.md#changes-from-the-earlier-format).

The model now follows one rule: **each fact is configured in one place and
derived everywhere else.**

* **Networks are IP networks.** Removed from networks: `kind`, `vrf` and
  `members`. A network is its `cidr` prefixes and, optionally, the `vlan` it
  lives in (a VLAN ID, 1–4094). A `cidr` entry that isn't a valid prefix is
  now an error.
* **Network members are derived.** A device is a member when one of its
  interface or loopback addresses lies inside one of the network's prefixes.
  The network's prefix decides; the interface's own prefix length isn't
  used. The read-only list shows each device once, with the matching
  interfaces and addresses, and updates with every edit.
* **Interfaces:** removed `vlan`, `speed` and `media`. The VLAN shown for an
  interface is derived from the network containing each address; conflicting
  networks give an explicit "ambiguous" and a warning instead of a choice.
  New: `vrf` on an interface (also on loopbacks).
* **Links:** `speed` and `medium` are configured on the link only; there is
  no fallback to the interfaces, and the "speed mismatch" warning is gone.
  New: each end (`a`, `b`) can list the VLANs it permits
  (`a: {device: sw1, interface: Et1, vlans: [10, 20]}`). Several VLANs are
  labelled *Trunk*, one *VLAN n*, none *No VLAN*. Different lists at the two
  ends give a warning, in the editor and as ⚠ on the cable; neither end is
  changed.
* **Groups:** the kind `row` was renamed to `floor`; `kind: row` is an
  error.
* **Editor:** derived values are marked *derived* and can't be edited. New
  VLAN pickers per link end. Networks have no kind, VRF or member fields;
  interfaces no VLAN, speed or media fields.
* **Diagrams:** the logical view draws membership lines from the derived
  members and all networks in one colour; the physical view labels trunks
  and marks VLAN mismatches.
* All examples are in the new format. Two devices in
  `enterprise-wan.yaml`, the leaves in `datacenter-evpn.yaml` and three
  devices in `metro-ring.yaml` got an address so that they remain members;
  the networks that were only a VRF's device list are gone (the VRF is on
  the interfaces).

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

### Compatibility

* This is the first release; there are no earlier versions to migrate from.
* **Files written during development may need one change:** `type` must be
  one of the 15 device types. Older values such as `l3switch`, `hypervisor`,
  `host`, `leaf` or `spine` are reported as errors that name the type to use.
  Spine/leaf roles belong in `role`; use `tier` to change the row.
* **Changed meaning of a missing value:** a group or network without `kind` is
  no longer treated as `site` / `subnet`; it is drawn without a kind.
* **Positions:** stored positions are never changed by an upgrade. A later
  version may arrange differently only when you press Auto-arrange again.

[0.1.0]: https://github.com/hafnerst/netatlas/releases/tag/v0.1.0

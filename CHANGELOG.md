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

### Added

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

### Changed

- The View menu says what its entries work on: **Find…** is now **Find in
  diagram…** (`/`), **Filter outline…** is now **Filter object list…** (it
  narrows the model outline; the diagram is not changed). Hover texts, the
  Find bar's accessible name and the outline filter's placeholder follow.
- The File menu says *model* in every entry (New model, Open model…, Save
  model, Save model as…, Close model) and uses "…" exactly where input
  follows; the start screen's card is **Open model…**.
- **Modified** is now a comparison with what was opened or last saved: undo
  back to that state clears it. The file name in the status bar shows a small
  dot and says how the model is saved; no button changes its border colour.
- The Auto-arrange option the view on screen is arranged with is selected and
  disabled; the check mark and edit icons are gone. The state is derived
  from the current positions of the complete or filtered view, and the `A`
  key (Default) follows it.
- The **Edit** tab groups each object's fields into titled cards (Identity,
  Placement, Ends, Cable, Addressing, Protocol, Endpoints, Underlay, Notes,
  More); the **Details** tab shows its sections in the same cards.
- The logical view shows every loopback (there was a limit of three).
- The example *device-types.yaml* has six free ports on its access switch.

### Fixed

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

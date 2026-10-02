# Changelog

All notable changes to NetAtlas are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/). While the version is 0.x, minor
releases may still change behaviour.

Two version numbers are involved. The **application version** (0.1.1) names
a NetAtlas release and is shown next to the logo. The **model format
version** (`netatlas: 1`) names the YAML format a model file is written in;
it is described in [docs/FORMAT.md](docs/FORMAT.md).

## [Unreleased]

### Added

- **Endpoints and Servers** controls next to Labels and Groups / Locations,
  in both views, on by default. Switching one off hides the devices of type
  `endpoint` or `server` (and their cables and relations, by the device-
  filter rules) on screen and in PNG/SVG exports, without changing the
  model, the YAML or the saved layout. They combine with **Devices**: the
  diagram shows the selected devices that are not of a hidden type, the
  selection itself is kept, and switching the type on again restores it,
  with its devices in their places.
- **The YAML tab marks the selected object's entry.** The entry is found by
  the object's ID in the parsed text (never by a text search), follows
  selection changes, typing, Apply, undo/redo, opening a file and renaming,
  and disappears while the text doesn't parse. Selecting keeps the YAML tab
  open. The text, caret, text selection and scroll position are left alone,
  except that a newly selected entry out of sight is scrolled into view.

### Changed

- **Edit header:** the object's type, its validation state (*No problems*,
  or the number of errors and warnings) and the **Duplicate** / **Delete**
  buttons (with icons, accessible names and tooltips; Delete in red) share
  one row, with the full name below. In a narrow panel the buttons show
  only their icons.
- **Mouse & keyboard help** at the bottom right: a foldable box with a
  *Pointer* and a *Keyboard* group instead of one line; side by side when
  there is room. It starts folded in windows under 560 px of height (it
  used to be hidden there). The shortcuts are unchanged.
- **The model outline no longer shifts** when something is selected: the
  *selected · related (n)* hint shares the row of *Collapse all*, every
  entry keeps the place of its selection mark, and the scrollbar's room is
  reserved.
- The status bar no longer says "everything stays in this page".
- A section heading of the editor (e.g. *Physical interfaces* with
  **+ Interface** / **+ Port Range**) puts its buttons on a second line in a
  narrow panel instead of past its edge.

- **DHCP on interfaces.** Every physical interface and every virtual or
  tunnel interface has a `dhcp` flag (`true` / `false`, omitted = `false`)
  and a **DHCP** switch next to its addresses in the editor. A loopback
  can't use DHCP: it has no switch, and `dhcp: true` on it is an error. It is off for new interfaces and is
  never inferred from an empty address list. While it is on, manual
  addresses can't be entered. Turning it on for an interface with
  addresses or DNS names asks first and deletes them in one undo step;
  turning it off doesn't bring them back. A file with `dhcp: true` and
  addresses on the same interface is rejected with an error that keeps
  both values. A DHCP interface is in no network, because its address is
  not known.
- **DNS names on devices.** `dns_names` on a device lists names, each
  entered once and associated with one or more of the device's physical or
  logical interfaces (by interface id). The editor has a **DNS names**
  section after the interface sections, with **+ DNS name** (interfaces
  picked by name; DHCP interfaces are not offered). Names are checked for
  host-name syntax, duplicates, unknown or DHCP interfaces and an empty
  interface list. Renaming an interface updates its associations; deleting
  it or turning DHCP on removes them in the same step, and a name left
  without interfaces goes with them. A name belongs to the interface, not
  one of its addresses, and no DNS record is derived. Device details,
  interface details, tooltips and **Find…** show the names; the diagrams
  don't.
- The `enterprise-wan.yaml` example uses both: the Hamburg LTE uplink has
  `dhcp: true`, and three DNS names are configured at HQ.
- **Device-filtered views.** A **Devices** control at the top right of both
  views chooses which devices the diagram shows (all by default; check
  boxes, a filter box, *Select all*, *Clear*). A filtered view shows the
  selected devices, the cables and relations entirely among them, the
  networks, groups and protocols relevant to them, and only the included
  members of mixed groups and networks. It is auto-arranged for the subset,
  deterministically. Its positions and moves are temporary (per view, never
  written to the YAML file; a note on the diagram says so), and *Select all*
  restores the complete diagram with its saved positions. Auto-arrange in a
  filtered view arranges only the shown devices. PNG and SVG exports show
  the filtered view with a legend and Networks overview of what is drawn.
- **Groups / Locations** option in both views (on by default): shows or
  hides group frames without moving devices.

### Changed

- **Logical view: devices are clustered by group.** Auto-arrange keeps the
  devices of each group / location together and draws the group's frame
  around them, as in the physical view; networks and multipoint hubs are
  placed around the groups. Models without groups are arranged as before.
  Stored logical positions are not changed; for a model with groups, a
  logical view that was auto-arranged before may now show *Edited since
  arranged* until it is arranged again.

- **Networks have exactly one prefix.** `cidr` is one required value
  (**IP network (CIDR)** in the editor). A missing prefix, an empty list, a
  list of several (even of one) and an invalid prefix are errors that keep
  the value in the file; make one network per prefix. Two networks with the
  same prefix are a warning. Membership is unchanged in principle: a device
  is a member when a configured address lies inside the prefix (DHCP
  interfaces count for nothing); an address inside overlapping networks
  belongs to all of them, and its VLAN is derived only when they agree.
- **Link ends carry networks, not VLAN IDs.** `vlans` on a link end is
  replaced by `networks: [network ids]` — the networks the cable carries at
  that end (physical / layer-2 carriage). Any network can be assigned; the
  ends are configured and validated separately and a difference is a
  warning, never synchronized. Carriage is not membership, and several
  networks are not called a trunk: the "Trunk" wording is gone. Cable labels
  name the networks; selecting a network highlights the cables that carry
  it; a VLAN interface's *Ports carrying its networks* (formerly *Ports
  carrying VLAN*) are derived from the link ends; filtered views and the
  exported Networks box use the assignments.
- **Relations: endpoints are only what they connect, and `over` is the one
  dependency field.** Endpoints lose `role`, `address` and `attrs` (keep such
  facts in the relation's `attrs`); the relation's `network` field is
  removed (a network it runs over goes into `over`; a network it carries or
  serves stays in `attrs` — a documented limitation).
- Logical view: a network or multipoint hub whose devices all lie in one
  group is placed inside that group's frame.
- **Relation direction.** `directed: true|false` is replaced by
  `direction: bidirectional|unidirectional` (omitted = bidirectional), and
  the editor's *Directed* checkbox by a **Bidirectional / Unidirectional**
  switch. Unidirectional relations flow from the first endpoint to the last
  and are drawn with an arrow. `directed` is rejected with an error saying
  what to write instead; the examples are migrated.
- The examples are migrated: networks split per prefix, link ends name
  networks, VRRP and OSPF run `over` their LAN segments, endpoint roles and
  ASNs moved into relation attributes.

### Removed

- The **Underlay** option of the logical view (a faint line per cabled
  device pair).
- Relation `directed` (see *direction*). Link-end `vlans`, relation `network`, endpoint `role` / `address` /
  `attrs`, and lists in a network's `cidr`. Old files are rejected with an
  error saying what to write instead; nothing is converted or dropped.

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

[0.1.1]: https://github.com/hafnerst/netatlas/releases/tag/v0.1.1
[0.1.0]: https://github.com/hafnerst/netatlas/releases/tag/v0.1.0

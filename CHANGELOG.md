# Changelog

All notable changes to NetAtlas are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/). While the version is 0.x, minor
releases may still change behaviour; the YAML format has its own version
(`netatlas: 1`) and stays readable across application versions.

## [Unreleased]

### Changed

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

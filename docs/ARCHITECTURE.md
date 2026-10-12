# NetAtlas architecture

NetAtlas is a TypeScript application built into one self-contained HTML
file (`dist/netatlas.html`). The source in `src/` is organised in layers.
Each layer has one responsibility and may only import the layers below it.
`test/architecture.test.mjs` enforces this.

## Layers

| Layer | Responsibility | Main modules |
|---|---|---|
| `model/` | The network model: types for devices, their physical and logical interfaces (loopback, virtual, tunnel) with the associations of each kind, links, networks, relations, protocols and groups; the display order of names (`order.ts`); the protocol registry; IP addresses; DNS-name syntax; the **device filter** (the part of a model relevant to some devices, as a self-consistent sub-model); **derived facts** (network members and interface VLANs from addresses and each network's one prefix, the VLANs and networks a cable carries at each end from the tagging of its ends and how the ends differ, which interfaces own an address); the **device types' routing roles**; pure queries (references, related objects, search); the **rules for connecting two endpoints** in a diagram (which endpoints and pairs are compatible, when a relation repeats an existing one); **which addresses and identifiers the diagrams write out, for which object and in which view** (the entries of an interface, a device's route tables, address-like attrs, the inventory the tests compare with the drawing). No I/O, no YAML, no layout. | `types.ts`, `device-types.ts`, `protocols.ts`, `ip.ts`, `dns.ts`, `filter.ts`, `derive.ts`, `queries.ts`, `order.ts`, `connect.ts`, `addresses.ts` |
| `analysis/` | **All network logic**, pure and DOM-free, on the typed `Model`: address arithmetic for IPv4 and IPv6 (`ipmath.ts`: integers, canonical text, prefix ranges, sizes, free ranges); routing (`routing.ts`: connected networks, per-VRF tables, longest-prefix match, distance, metric, equal-cost multipath, recursive next hops, the hook for interfaces that are down); the **consistency checks** (`checks.ts`: a registry of checks with stable ids, severities and the fields they read, the checks of routes and VLAN tagging, and the run that returns findings with a model's `checks:` settings applied; `checks-more.ts`: the checks of MTU, speed and duplex, aggregates, addressing, router IDs and MACs, OSPF, BGP, tunnels and VRFs). Focus mode's **neighbourhood** (`focus.ts`): the devices within N hops along cables or relations. The **addressing overview** (`addressing.ts`): networks per VRF as a supernet tree with members, gateways, use, free ranges and the next free address; duplicates, overlaps and addresses in no network. Deterministic: results are sorted by values, never by the order of the file. | `ipmath.ts`, `routing.ts`, `checks.ts`, `checks-more.ts`, `addressing.ts`, `focus.ts` |
| `yaml/` | The YAML boundary: the supported YAML subset (parser with line/column positions, comments and styles), the serializer (the inverse), and the format **schema** (which keys exist, in canonical order). Knows nothing about networks beyond key names. | `parse.ts`, `write.ts`, `schema.ts` |
| `validation/` | Turns a parsed YAML tree into a `Model` plus errors and warnings. Every issue is attached to the YAML node it concerns. Structural and cross-reference checks, loopback/IP rules, static routes and link-end tagging, the presentation-only `layout` section. Then it runs the consistency checks of `analysis/` on the model and attaches each finding to the entry and field it is about. Callable without any UI. | `validate.ts` (the format's rules), `reader.ts` (issue collector, typed reader, suggestions) |
| `layout/` | Deterministic positions for both views: a canonical, order-independent input built from the model; auto-arrange for the physical and the logical view, and the strategies built on it (Default, Compact, Spacious); placement of new nodes; the rule "stored positions else auto-arrange". Separates calculated positions from network semantics. | `input.ts`, `physical.ts`, `logical.ts`, `positions.ts`, `strategies.ts`, `text.ts` (width estimate, wrapping), `sizes.ts` (element sizes from their text, including the rows and end labels of ports), `bundles.ts` (the strands of a device pair, grouped by the interfaces they are bound to, with their lanes and labels; the room each port needs), `geometry.ts`, `order.ts` |
| `diagram/` | Presentation: turns model + positions into a virtual SVG tree (`VNode`) for each view, and holds the DOM-free view state (current view, selection, filters, temporary drag positions). Uses `analysis/` for what it shows of the network's behaviour (where a route's next hop is). No parsing, no editing rules, no DOM. | `session.ts`, `physical.ts`, `logical.ts`, `logical-ports.ts` (the ports of the logical view: rows, sides, stacking, stubs and routes), `legend.ts` (the legend as data, and its SVG form for exports), `networks-box.ts` (the networks relevant to a rendered view, and their overview box for exports), `labels.ts` (multi-line text, collision-free label placement with leader lines), `palette.ts` (the colours of the model drawn per theme, WCAG contrast), `scene.ts`, `style.ts`, `icons.ts` |
| `editor/` | The editable document (`ModelDoc`): the YAML tree plus undo/redo, dirty state, validation after every change, and **explicit editing operations** (set a field, append to a list, point an endpoint at an interface, switch DHCP on or off for an interface, add or remove a DNS name, rename an id with all references, add a physical or logical interface, arrange one view, move a node, …). Also the layout section and the layout status, and where an object's entry is in a YAML text (`yaml-block.ts`, found through the parsed structure). | `document.ts`, `tree.ts`, `layout-section.ts`, `yaml-block.ts` |
| `ui/` | The browser: application shell, canvas interaction (selection, dragging, connecting endpoints), inspector forms and outline, side panels, dialogs, the Addressing overview's table and CSV (`addressing.ts`), the **command registry** that drives the menus, the keyboard shortcuts and the command palette (`commands.ts`, `palette.ts`), the Help menu's manual and license (`help.ts`), local files (reading, writing through a file handle the user chose, download), and the only code that creates DOM elements (`dom.ts`). Uses the editor's operations and never builds YAML itself. | `app.ts`, `inspector.ts`, `panels.ts`, `dialogs.ts`, `help.ts`, `files.ts`, `dom.ts`, `theme.ts` (Light / Dark, Dark by default), `export-style.ts` (resolved colours for exports) |
| `app/` | Entry point, the in-browser self-test (`#selftest`) and the viewport check (`#viewportcheck`). | `main.ts`, `selftest.ts`, `viewport-check.ts` |
| `generated/` | Built from `examples/*.yaml` by `scripts/gen-examples.mjs`, and from `LICENSE` and `docs/img/manual/*.webp` by `scripts/gen-help.mjs` (the license text and the manual's screenshots as `data:` URLs); do not edit. | `examples.ts`, `help-assets.ts` |

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
  Membership (IP containment, derived), link-end tagging (layer-2
  carriage, configured per end, by VLAN ID; the networks a cable carries
  are derived from it) and a relation's `over` (its underlay, configured)
  are separate facts; none is derived from another.
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

* **New protocol:** nothing to change in the code. Add it under
  `protocols:` in a YAML file, or extend the built-in table in
  `model/protocols.ts`.
* **New device type:** add it to `model/device-types.ts` (identifier and
  display name), give it a glyph in `diagram/icons.ts` and a default row in
  `layout/input.ts`, and list it in `docs/FORMAT.md`.
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
npm install            # TypeScript only (dev dependency)
npm run build          # -> dist/netatlas.html
npm test               # build + all tests (Node + headless browser)
npm run check:dist     # is the checked-in dist/netatlas.html generated from this source?
```

`npm run check:dist` regenerates the embedded examples and the bundle in
memory and compares them byte-for-byte with `src/generated/examples.ts` and
`dist/netatlas.html`. It writes neither file. It exits with status 1 and
says so if either is stale. To confirm a checkout or a pull request, run it
on a clean working tree after `npm ci`.

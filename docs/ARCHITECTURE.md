# NetAtlas architecture

NetAtlas is a TypeScript application built into one self-contained HTML
file (`dist/netatlas.html`). The source in `src/` is organised in layers.
Each layer has one responsibility and may only import the layers below it.
`test/architecture.test.mjs` enforces this.

## Layers

| Layer | Responsibility | Main modules |
|---|---|---|
| `model/` | The network model: types for devices, their physical and logical interfaces (loopback, virtual, tunnel) with the associations of each kind, links, networks, relations, protocols and groups; the display order of names (`order.ts`); the protocol registry; IP addresses; DNS-name syntax; the **device filter** (the part of a model relevant to some devices, as a self-consistent sub-model); **derived facts** (network members and interface VLANs from addresses and each network's one prefix, the networks a cable carries at each end and whether the ends differ); pure queries (references, related objects, search); the **rules for connecting two endpoints** in a diagram (which endpoints and pairs are compatible, when a relation repeats an existing one). No I/O, no YAML, no layout. | `types.ts`, `device-types.ts`, `protocols.ts`, `ip.ts`, `dns.ts`, `filter.ts`, `derive.ts`, `queries.ts`, `order.ts`, `connect.ts` |
| `yaml/` | The YAML boundary: the supported YAML subset (parser with line/column positions, comments and styles), the serializer (the inverse), and the format **schema** (which keys exist, in canonical order). Knows nothing about networks beyond key names. | `parse.ts`, `write.ts`, `schema.ts` |
| `validation/` | Turns a parsed YAML tree into a `Model` plus errors and warnings. Every issue is attached to the YAML node it concerns. Structural and cross-reference checks, loopback/IP rules, the presentation-only `layout` section. Callable without any UI. | `validate.ts` (the format's rules), `reader.ts` (issue collector, typed reader, suggestions) |
| `layout/` | Deterministic positions for both views: a canonical, order-independent input built from the model; auto-arrange for the physical and the logical view, and the strategies built on it (Default, Compact, Spacious); placement of new nodes; the rule "stored positions else auto-arrange". Separates calculated positions from network semantics. | `input.ts`, `physical.ts`, `logical.ts`, `positions.ts`, `strategies.ts`, `text.ts` (width estimate, wrapping), `sizes.ts` (element sizes from their text), `bundles.ts` (lanes and labels of a device pair), `geometry.ts`, `order.ts` |
| `diagram/` | Presentation: turns model + positions into a virtual SVG tree (`VNode`) for each view, and holds the DOM-free view state (current view, selection, filters, temporary drag positions). No parsing, no editing rules, no DOM. | `session.ts`, `physical.ts`, `logical.ts`, `legend.ts` (the legend as data, and its SVG form for exports), `networks-box.ts` (the networks relevant to a rendered view, and their overview box for exports), `labels.ts` (multi-line text, collision-free label placement), `scene.ts`, `style.ts`, `icons.ts` |
| `editor/` | The editable document (`ModelDoc`): the YAML tree plus undo/redo, dirty state, validation after every change, and **explicit editing operations** (set a field, append to a list, point an endpoint at an interface, switch DHCP on or off for an interface, add or remove a DNS name, rename an id with all references, add a physical or logical interface, arrange one view, move a node, …). Also the layout section and the layout status, and where an object's entry is in a YAML text (`yaml-block.ts`, found through the parsed structure). | `document.ts`, `tree.ts`, `layout-section.ts`, `yaml-block.ts` |
| `ui/` | The browser: application shell, canvas interaction (selection, dragging, connecting endpoints), inspector forms and outline, side panels, dialogs, the Help menu's manual and license (`help.ts`), local files (reading, writing through a file handle the user chose, download), and the only code that creates DOM elements (`dom.ts`). Uses the editor's operations and never builds YAML itself. | `app.ts`, `inspector.ts`, `panels.ts`, `dialogs.ts`, `help.ts`, `files.ts`, `dom.ts` |
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
                              model  (imported by every layer except yaml)
```

| Layer | May import |
|---|---|
| `model` | — |
| `yaml` | — |
| `validation` | `model`, `yaml` |
| `layout` | `model` |
| `diagram` | `model`, `layout` |
| `editor` | `model`, `yaml`, `validation`, `layout` |
| `ui` | `model`, `validation`, `layout`, `diagram`, `editor`, `generated` |
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
  keys go) and the inspector ("other properties") all use it. It also lists
  keys that are not part of the format but are easily expected in a place
  (a `speed` on a port, a `loopbacks` list), with the instruction shown when
  one is found; they are rejected like any unknown key, never read or
  converted.
* **Configured versus derived.** A fact is stored in one place in the YAML
  tree. Whatever follows from it is computed by `model/derive.ts` from the
  typed `Model` (cached per model object, and a new model is built after
  every edit), and is only ever displayed: network members, the VLAN of an
  interface address, the difference between the networks of a link's two ends, the ports carrying a VLAN interface's networks. No
  editing operation writes a derived value, so it can't go stale or
  contradict its source. The typed `Network` has no member list and the
  typed `Interface` no VLAN, so nothing can read a stored copy by mistake.
  Membership (IP containment, derived), link-end `networks` (physical
  carriage, configured per end) and a relation's `over` (its underlay,
  configured) are three separate facts; none is derived from another.
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

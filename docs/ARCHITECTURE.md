# NetAtlas architecture

NetAtlas is a TypeScript application built into one self-contained HTML
file (`dist/netatlas.html`). The source in `src/` is organised in layers.
Each layer has one responsibility and may only import the layers below it.
`test/architecture.test.mjs` enforces this.

## Layers

| Layer | Responsibility | Main modules |
|---|---|---|
| `model/` | The network model: types for devices, interfaces (incl. loopbacks), links, networks, relations, protocols and groups; the protocol registry; IP addresses; **derived facts** (network members and interface VLANs from addresses, link-end VLAN state); pure queries (references, related objects, search). No I/O, no YAML, no layout. | `types.ts`, `device-types.ts`, `protocols.ts`, `ip.ts`, `derive.ts`, `queries.ts` |
| `yaml/` | The YAML boundary: the supported YAML subset (parser with line/column positions, comments and styles), the serializer (the inverse), and the format **schema** (which keys exist, in canonical order). Knows nothing about networks beyond key names. | `parse.ts`, `write.ts`, `schema.ts` |
| `validation/` | Turns a parsed YAML tree into a `Model` plus errors and warnings. Every issue is attached to the YAML node it concerns. Structural and cross-reference checks, loopback/IP rules, the presentation-only `layout` section. Callable without any UI. | `validate.ts` (the format's rules), `reader.ts` (issue collector, typed reader, suggestions) |
| `layout/` | Deterministic positions for both views: a canonical, order-independent input built from the model; auto-arrange for the physical and the logical view; placement of new nodes; the rule "stored positions else auto-arrange". Separates calculated positions from network semantics. | `input.ts`, `physical.ts`, `logical.ts`, `positions.ts`, `sizes.ts`, `geometry.ts` |
| `diagram/` | Presentation: turns model + positions into a virtual SVG tree (`VNode`) for each view, and holds the DOM-free view state (current view, selection, filters, temporary drag positions). No parsing, no editing rules, no DOM. | `session.ts`, `physical.ts`, `logical.ts`, `legend.ts` (the legend as data, and its SVG form for exports), `scene.ts`, `style.ts`, `icons.ts` |
| `editor/` | The editable document (`ModelDoc`): the YAML tree plus undo/redo, dirty state, validation after every change, and **explicit editing operations** (set a field, append to a list, point an endpoint at an interface, rename an id with all references, add a loopback, arrange, move a node, …). Also the layout section and the layout status. | `document.ts`, `tree.ts`, `layout-section.ts` |
| `ui/` | The browser: application shell, canvas interaction, inspector forms and outline, side panels, dialogs, local file reading and download, and the only code that creates DOM elements (`dom.ts`). Uses the editor's operations and never builds YAML itself. | `app.ts`, `inspector.ts`, `panels.ts`, `dialogs.ts`, `files.ts`, `dom.ts` |
| `app/` | Entry point and the in-browser self-test (`#selftest`). | `main.ts`, `selftest.ts` |
| `generated/` | Built from `examples/*.yaml` by `scripts/gen-examples.mjs`; do not edit. | `examples.ts` |

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
  the keys of the earlier format that were retired, with the instruction shown
  when one is found; they are rejected, never read or converted.
* **Configured versus derived.** A fact is stored in one place in the YAML
  tree. Whatever follows from it is computed by `model/derive.ts` from the
  typed `Model` (cached per model object, and a new model is built after
  every edit), and is only ever displayed: network members, the VLAN of an
  interface address, the trunk state and mismatch of a link's ends. No
  editing operation writes a derived value, so it can't go stale or
  contradict its source. The typed `Network` has no member list and the
  typed `Interface` no VLAN, so nothing can read a stored copy by mistake.
  *Trade-off:* membership is recomputed for the whole model after each edit
  (addresses × networks); that is well inside the time validation already
  takes.
* **Positions are separate from semantics.** Positions live in the optional
  `layout:` section, are only warnings when broken, and never change the
  model. Auto-arrange is a pure function of a canonical input
  (`layout/input.ts`), so YAML order, comments and manual moves can't affect
  it. The layout status is derived by comparing stored positions with that
  result (see `docs/FORMAT.md`).
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

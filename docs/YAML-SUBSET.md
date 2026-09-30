# Supported YAML subset

netatlas contains its own small YAML parser (`src/yaml.ts`), because
third-party libraries aren't allowed and full YAML is large and has features
that are unsafe on untrusted input. The parser supports a **documented subset**
and **rejects everything else with an explicit, line-numbered error**. It never
guesses, and it never falls back to treating the input as JSON. (A one-line
JSON object happens to be valid YAML flow syntax and is parsed as YAML;
multi-line JSON is rejected.)

## Supported

| Construct | Example |
|---|---|
| Block mappings | `key: value` |
| Block sequences, including the compact form | `- id: r1` followed by `  type: router` |
| Sequences as mapping values at the same indentation | `interfaces:` / `- eth0` |
| Nested sequences | `- - a` |
| Plain scalars (single line) | `title: Core network` |
| Single-quoted scalars (`''` escapes a quote) | `label: 'it''s'` |
| Double-quoted scalars with escapes `\\ \" \/ \n \t \r \0 \a \b \e \f \v \N \_ \L \P \xHH \uHHHH \UHHHHHHHH` | `label: "A\tB"` |
| Literal block scalars `\|`, `\|-`, `\|+` | `description: \|` + indented lines |
| Folded block scalars `>`, `>-`, `>+` | |
| Flow sequences and mappings **on one line** (nesting allowed, trailing comma allowed) | `ip: [10.0.0.1/24, 2001:db8::1/64]`, `{id: eth0, ip: 10.0.0.1/24}` |
| Comments | `# …` on their own line or after a value (preceded by a space) |
| Document markers | an optional leading `---` and an optional trailing `...` |
| Empty values | `key:` → null |
| UTF-8 input, with or without a BOM, and LF / CRLF / CR line ends | |

### Scalar types (YAML 1.2 core schema)

| Plain text | Value |
|---|---|
| `null`, `Null`, `NULL`, `~`, empty | null |
| `true`/`True`/`TRUE`, `false`/`False`/`FALSE` | boolean |
| `123`, `-7`, `0x1F`, `0o17` | integer |
| `1.5`, `1e3`, `.inf`, `.nan` | float |
| everything else, including `yes`, `no`, `on`, `off`, `10.0.0.1`, `1.2.3`, `65000:100` | string |

YAML 1.1 booleans (`yes`/`no`/`on`/`off`) are **strings**, so the "Norway
problem" can't happen. netatlas also keeps the original text of every scalar,
so values like `area: 0.0.0.1`, `key: 010` or `asn: 65001` show up exactly as
written.

## Rejected, with an explicit error

| Construct | Why |
|---|---|
| Anchors `&a` and aliases `*a` | Alias expansion is the vector for "billion laughs" memory attacks and makes shared structure implicit. Aliases are refused before anything is expanded. Repeat the content instead. |
| Merge keys `<<:` | Depend on aliases. |
| Tags `!tag`, `!!str` | Arbitrary types aren't needed, and tags are a classic deserialization risk. |
| Directives `%YAML`, `%TAG` | Not needed. |
| Multiple documents (a second `---`, content after `...`) | A file describes one network. |
| Complex keys `? key` and flow collections as keys | Not needed. |
| Multi-line plain scalars (a value continued on the next, more-indented line) | Ambiguous in practice; use quotes or a `\|` / `>` block. |
| Multi-line quoted scalars and escaped line breaks | Use a block scalar. |
| Multi-line flow collections (`[` … `]` over several lines) | Use a block sequence / mapping. |
| Tab characters in indentation | Forbidden by YAML itself. |
| Duplicate keys in one mapping | The error names the first definition. |
| Explicit block-scalar indentation indicators (`\|2`) | Rarely needed. |
| Reserved indicators `@` and `` ` `` at the start of a plain scalar | Forbidden by YAML itself; quote the value. |
| Control characters (other than tab, LF, CR) | Reject binary / garbage input early. |

## Resource limits

The parser checks these while it reads, so malformed or hostile input can't
consume unbounded memory or time:

| Limit | Default |
|---|---|
| Input size | 2 MiB (also checked on the file size before reading) |
| Lines | 100 000 |
| Nesting depth | 32 |
| Nodes (scalars + collections + keys) | 250 000 |
| Scalar length | 10 000 characters |
| Mapping key length | 256 characters |

Parsing runs in linear time in the input size. Keys are kept in `Map`s, so
keys like `__proto__` are ordinary data. The model-level limits (number of
devices, links and so on) are listed in [FORMAT.md](FORMAT.md#validation-and-limits).

## Writing YAML (export from the editor)

The editor never rebuilds the file from an internal data model. The parsed
YAML tree *is* the document being edited: every edit changes that tree in
place, and **Download model…** serializes it with `src/yaml-write.ts`, which
writes the same subset back out.

**Preserved**
* All data, including keys the editor doesn't know (they're reported as
  errors and shown under *Other properties*, but never dropped), nested
  `attrs` of any depth, lists of mappings, empty lists and mappings, and the
  original spelling of numbers and booleans (`0x1F`, `1e3`, `True`, `010`).
* Key order, and the order of list items.
* Comments on their own lines above keys and list items (including groups of
  comments separated by blank lines), trailing `# comments` with their
  original spacing, comments at the end of the file, and single blank lines
  between entries.
* Quoting style (`'single'` / `"double"` / plain) where the value allows it,
  and flow (`[a, b]`, `{a: 1}`) vs block style.

**Normalized**
* Indentation (always 2 spaces) and spacing inside flow collections
  (`{a: 1, b: 2}`).
* Folded (`>`) block scalars are written as literal (`|`) blocks with the
  same value.
* Runs of blank lines become one blank line. The `---` and `...` document
  markers aren't written.
* Flow collections longer than 140 characters, or that contain comments,
  are written in block style.

**Edits**
* Values changed in the forms keep their comments. Keys the editor adds are
  inserted in the documented order (e.g. `tier` after `group`, `type` right
  after the `id` of a logical interface).
* A shorthand is only expanded when you edit it. `interfaces: [eth0]` becomes
  `[{id: eth0, vrf: blue}]` once you set a VRF, an endpoint `"r1:eth0"`
  becomes `{device: r1, interface: eth0, role: …}` once you give it a role,
  and a link end `"r1:eth0"` becomes
  `{device: r1, interface: eth0, vlans: [10, 20]}` once you add VLANs (and
  goes back to `r1:eth0` when the last VLAN is removed).
* Strings are quoted only when they'd otherwise read back differently
  (`"123"`, `"yes"`, `"a: b"`, `" padded"`). Text typed into a free-form
  attribute is typed like YAML would type it: `42` becomes a number, `true`
  a boolean, `10.0.0.1` stays a string.
* Comments can only be edited in the **YAML** tab.

The tests check these guarantees:
* every example file is written back **byte-for-byte**;
* a "torture" document with every construct round-trips its data and
  comments, and the output is idempotent;
* 400 randomly generated trees full of special characters survive
  `stringify → parse` unchanged (`test/editor.test.mjs`).

## Conformance of the examples

Every file in `examples/` is parsed by the test suite
(`test/yaml.test.mjs` → *every shipped example conforms to the supported
subset*), then validated without errors or warnings
(`test/validate.test.mjs` → *all examples validate without errors or warnings*).
`examples/broken/errors-demo.yaml` is intentionally invalid and is used to
check the error messages.

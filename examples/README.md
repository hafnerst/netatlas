# Examples: the public catalog and the internal test examples

NetAtlas keeps two kinds of example models apart.

| | Public examples | Internal test examples |
|---|---|---|
| Where | `examples/*.yaml` (this folder) | `test/examples/*.yaml` (and `test/fixtures/*.yaml`, generated) |
| What | One representative, realistic model per kind of network NetAtlas is meant for | Test scenarios: a feature, an edge case, validation, layout or the simulation |
| In the File menu | Yes, in the order of `CATALOG` in `scripts/gen-examples.mjs` | Never |
| In `dist/netatlas.html` | Yes (`src/generated/examples.ts`), offline | No |
| In the test build `build/netatlas-test.html` | Yes | Yes (`src/generated/test-examples.ts`), loaded by name |
| Read by the Node tests | Yes (`example(name)` in `test/helpers.mjs`) | Yes, the same way |

## The public catalog

| File | Kind of network |
|---|---|
| `enterprise-wan.yaml` | Enterprise WAN: HQ and two branches over VPN tunnels, dynamic routing |
| `enterprise-campus.yaml` | Enterprise campus: three tiers, controller-managed Wi-Fi, the campus services |
| `datacenter-evpn.yaml` | Data center: spine/leaf fabric with EVPN/VXLAN |
| `virtualization.yaml` | Virtualized servers: a hypervisor cluster, VMs and containers |
| `private-house.yaml` | Private house: three floors, a DSL modem/router, Wi-Fi networks on VLANs |
| `dmz-services.yaml` | Internet edge: a firewall with VPN and NAT, IPS, reverse proxy, load balancer |
| `hybrid-cloud.yaml` | Hybrid cloud: a data centre with an AWS VPC and an Azure VNet |
| `ot-network.yaml` | OT cell: PLC, HMI, protocol gateway, TAP and passive IDS; applications and MQTT |
| `timing-ptp.yaml` | Time synchronization: PTP grandmasters, a boundary and a transparent clock |
| `cross-domain.yaml` | Cross-domain boundary: a Security gateway that breaks the protocol |

The README's [Examples](../README.md#examples) section says why each one is
in the catalog. A public example has a concise `title` and a `description`,
loads without errors, warnings or consistency findings (each public example
is checked in both views and both themes by the released application's own
self-test), and shows one architecture rather than a list of features.

## How the separation is kept

* **The folder decides, and the catalog is explicit.** `scripts/gen-examples.mjs`
  embeds exactly the files listed in its `CATALOG` from this folder, and
  fails when a file here is not listed (or a listed file is missing), or when
  an internal example has the name of a public one. Everything in
  `test/examples/` and `test/fixtures/` goes to
  `src/generated/test-examples.ts` instead.
* **Only the test build imports them.** `src/app/main-test.ts` (the test
  build's entry) registers the internal examples (`ui/examples.ts`), which
  makes them loadable by name (`netatlas.loadExampleNamed('metro-ring.yaml')`,
  or `#example=metro-ring.yaml`); they are never listed in the File menu.
  `src/app/main.ts` (the release) imports none of it.
* **The build checks the release.** `scripts/build.mjs` writes both pages and
  fails if `dist/netatlas.html` would contain a test-only module
  (`generated/test-examples`, `app/selftest`, `app/viewport-check`,
  `app/main-test`).
* **Tests check it.** `test/menu.test.mjs` checks the catalog and its order,
  that every internal example and fixture is absent from
  `dist/netatlas.html` (by a long, distinctive part of each file) and present
  in the test build, and which source files import the test module.

## Adding an example

* A **public** example: write it here, add it to `CATALOG`, run
  `npm run build`, and describe it in the README's Examples section.
* A **test scenario**: write it in `test/examples/`; the tests read it with
  `example(name)`, the test build loads it with `loadExampleNamed`. Any model
  in either folder can also be opened with **Open model…**.

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
| `vme-rack.yaml` | Embedded VME rack, IP and non-IP side by side: every interconnect configuration (backplane, overlay fabric, 1553, CAN, serial both ways and one way, USB), each with traffic, beside Ethernet applications |

[Why each one is in the catalog](#why-each-one-is-in-the-catalog) is below. A public example has a concise `title` and a `description`,
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

## Why each one is in the catalog

The **File** menu offers eleven examples: one representative model for each
kind of network NetAtlas is meant for, each a coherent architecture rather
than a list of features. They are in [`examples/`]() and are the
only models built into `dist/netatlas.html`.

| File | Architecture | Why it is in the catalog |
|---|---|---|
| [`enterprise-wan.yaml`](enterprise-wan.yaml) | **Enterprise WAN.** HQ with two ISPs and two branches; IPsec → GRE → OSPF over the internet uplinks, eBGP and BFD to the providers, a WireGuard backup over LTE, VRRP, LACP and routing services per device. | Overlay tunnels on an underlay, dynamic routing and redundancy: how a WAN with VPNs is drawn in both views and traced through its tunnels; saved expectations and two failure domains (a rack, the core room) for Design checks and What if; a routing policy (Hamburg takes the default route only, Munich a prefix-filtered set) and the path MTU over the GRE tunnel. |
| [`enterprise-campus.yaml`](enterprise-campus.yaml) | **Enterprise campus.** Core, distribution and access switches by role; two controller-managed access points with Staff and Guest on VLANs; a services server with DHCP (through the core's relays), DNS, NTP, AAA, syslog and monitoring. | A three-tier campus with VLAN-backed Wi-Fi and the services that run it; the simulation shows the leases, CAPWAP, RADIUS and the rest; the core's network policy keeps the guests out, the Staff relay has an alternative DHCP server, the traced communication can be the execution scope, and a saved Guest VLAN view. |
| [`datacenter-evpn.yaml`](datacenter-evpn.yaml) | **Data center.** A spine/leaf fabric in racks: an eBGP underlay, EVPN between loopbacks, a VXLAN VNI, MLAG and a tenant VRF. | A routed fabric with an overlay: the physical racks and the logical sessions apart; stated replication traffic over two spines and what survives when one loses power (capacity in What if), and a view with a compute rack collapsed. |
| [`virtualization.yaml`](virtualization.yaml) | **Virtualized servers.** Two hypervisors in an HA cluster with teamed uplinks, VMs on port groups, a virtual router, a container host with a NAT bridge and macvlan. | Hosts with their guests and virtual switches; in the simulation an HA restart, an uplink failover and NAT. |
| [`private-house.yaml`](private-house.yaml) | **Private house.** Three floors; a DSL modem/router with NAT and a firewall; a Layer 3 switch in the basement as the core; a distribution switch on the second floor; an access point on every floor with Internal, IoT and Guest on VLANs 10, 20 and 30 over one uplink; Internal dual-stack (SLAAC from the core's router advertisements); a thermostat with two applications. | The smallest complete network: floors as groups, several Wi-Fi networks per access point, zones with a policy point, and a shared uplink as a single point of failure; saved expectations whose clients take their addresses by DHCP (indeterminate in the configured model, evaluated on a simulation snapshot) and a shared-power failure domain; saved views (the IoT VLAN, the floors collapsed); two experiments that play in the diagram: a cold start in which the TV boots, gets its address and reaches the thermostat, and the TV joining, receiving and leaving the thermostat's multicast stream. See [the private house](#the-private-house-example). |
| [`dmz-services.yaml`](dmz-services.yaml) | **Internet edge.** A firewall with a site-to-site VPN and NAT (PAT, a port forward), an inline IPS, a reverse proxy in front of a load balancer with two application servers, a NAS reached over the VPN. | The services of a perimeter, end to end: a request through DNAT, the proxy and the pool, and what the IPS blocks. |
| [`hybrid-cloud.yaml`](hybrid-cloud.yaml) | **Hybrid cloud.** A data centre joined over a private interconnect to an AWS VPC and an Azure VNet, each with a cloud gateway and cloud instances. | Public cloud as groups (region, VPC, VNet) and instances without a host of their own. |
| [`ot-network.yaml`](ot-network.yaml) | **OT cell.** A PLC and an HMI behind a protocol gateway, a pass-through TAP feeding a passive IDS; the PLC's applications (a register listener the HMI polls, telemetry published by MQTT) and an MQTT broker with a matching and a non-matching subscriber. | Industrial devices, port pairs and a monitoring copy that forwards nothing; Endpoints that run applications without becoming servers, and MQTT's fan-out by topic filter; dependency expectations, a violated isolation requirement (a forwarder without a policy) and the broker as a service single point; repeatable experiments of the cabinet's outage and of the HMI's dashboard receiving the PLC's temperatures by MQTT. |
| [`timing-ptp.yaml`](timing-ptp.yaml) | **Time synchronization.** Two cells in one PTP domain: two grandmaster candidates behind a transparent-clock switch, a router as boundary clock, a PLC and a drive receiving time. | The PTP election, boundary and transparent clocks, and a grandmaster failing and coming back, in the simulation; timing expectations with an explicit method (PTP keeps a source without one grandmaster; the router's NTP chain does not) that never claim synchronization. |
| [`cross-domain.yaml`](cross-domain.yaml) | **Cross-domain boundary.** Red and Black domains joined by a Security gateway that breaks the protocol: one permitted web transfer in two legs, one denied transfer, a management network apart. | A separation boundary with an explicit policy, traced with a service. |
| [`vme-rack.yaml`](vme-rack.yaml) | **Embedded VME rack.** A VME64x crate in a control-room rack: a system-controller CPU, a second CPU, ADC and digital I/O boards and a MIL-STD-1553 board on the VMEbus backplane, and a VXS-style SRIO fabric overlaid on it through a switch card; the 1553 bus to two remote terminals and a bus monitor, and a CAN bus to a pump drive and a valve controller in the field; RS-232 console lines from both CPUs to a console server, a GPS receiver's NMEA line into one CPU, a USB log stick; Ethernet for the CPUs, the console server and an engineering workstation, which polls the controller's telemetry, opens console sessions and collects syslog. | A reference for a mixed architecture, one of each non-IP configuration: a shared backplane with controller-and-target cards (one the system controller), an overlay fabric of point-to-point lanes with an explicit transit group (and a port outside it), a command/response bus with a monitor, a bus of peers with a receive-only node and its protocol, serial lines both ways and one way, USB host and device, opaque ports beside IP interfaces on the same boards. Every interconnect carries illustrative data while the simulation runs (`traffic:`), the IP side its applications; **Send illustrative data** and **Non-IP failures** show where data can go and why it can't; the IP side never uses the interconnects. |

### The private-house example

The floors are groups in the house: **Basement**, **First floor (above the
basement)** and **Second floor (top)**; every device is in the floor where it
stands, also when its cable runs to a switch on another floor. The physical
view draws the house as a cross-section (each device's `tier`).

* **WAN edge.** NetAtlas has no DSL or PPPoE model, so the modem is a
  **combined DSL modem/router**, and says so: its type is *Firewall* (the
  type whose policy NetAtlas enforces) with the kind *DSL modem/router*. It
  terminates the line to the provider (a Cloud, one Layer 3 hop; the cable's
  label says *VDSL2 (PPPoE)*), translates the house's addresses (its NAT
  service, PAT), filters, and answers DNS for `home.arpa`. The Layer 3 switch
  only routes: no NAT, no firewall, no DSL.
* **Inside.** The Layer 3 switch *core* in the basement is the gateway of
  every VLAN and the DHCP server of all three Wi-Fi networks. The distribution
  switch *dist* on the second floor feeds the first- and second-floor access
  points; the basement access point is on the core.

  | Wi-Fi network | SSID | VLAN | Subnet | VRF on the core |
  |---|---|---|---|---|
  | Internal | Home | 10 | 192.168.10.0/24 | default |
  | IoT | Home-IoT | 20 | 192.168.20.0/24 | `iot` |
  | Guest | Home-Guest | 30 | 192.168.30.0/24 | `guest` |
  | management | – | 99 | 192.168.99.0/24 | default |

  Every access point has the same three networks on its radio and one wired
  uplink, a trunk with VLANs 10, 20, 30 and 99, all tagged, the same at the
  switch end; the riser cable between the core and *dist* carries the same.
  The core's trunk to the DSL router carries three transit VLANs (110, 120,
  130), one per VRF.
* **Policy.** The core routes inside each VRF only; traffic between the
  zones, and to the Internet, goes to the DSL router, whose policy is the
  relations through it: each zone's devices may open HTTPS to the Internet,
  nothing else crosses between zones (default action: drop). So Internal
  reaches the NAS directly, IoT and Guest reach the Internet but not the NAS,
  and management (VLAN 99) is routed with Internal only.
* **Dual stack.** Internal is IPv4 and IPv6: the core's VLAN 10 interface
  has a second address, `fd00:10::1/64` (a unique local prefix; the provider
  gives the house no IPv6 here), and sends router advertisements for
  `fd00:10::/64`. The laptop and the phone (`ipv6: slaac`) form an address
  in it after duplicate address detection and take the core as their IPv6
  default router, while DHCP still leases their IPv4 address. The other
  networks stay IPv4 only.
* **Applications.** The thermostat stays an Endpoint and runs two
  applications: *Local control*, a TCP listener on port 8080, and *Cloud
  sync*, a TCP client of the web server's HTTPS application every 30 s. The
  TV's *Thermostat control* is a client of the first (both are in IoT).
  *Network events → Start application* starts a client.
* **What to try.** Start a simulation: each client is leased in its
  network's VLAN; the laptop finds the NAS by name and opens it; the TV's and
  the guest phone's attempts at the NAS are dropped by the DSL router. Trace
  path from `core:Vlan30` to `192.168.10.20` with the service `tcp/445`: it
  stops at the DSL router's policy. Fail `l-core-dist`: both upper-floor
  access points lose their uplink; *Single points of failure* lists it.
* **Limits.** The policy has no zones or directions (see
  [Limitations](../docs/LIMITATIONS.md)): "Internal may open IoT, IoT may
  not open Internal" can't be written, so nothing is permitted between the
  zones. There is no radio or roaming model.

### Internal test examples

[`test/examples/`](../test/examples/) holds nineteen more models. They are test
scenarios, not architectures: each exercises a feature, an edge case,
validation, layout or the simulation (`addressing.yaml`, `long-labels.yaml`,
`consistency-checks.yaml`, `protocol-simulation.yaml`, `metro-ring.yaml`,
`vlan-ports.yaml` …), and several were examples of the File menu before the
catalog was curated. `test/examples/broken/errors-demo.yaml` is
intentionally invalid. The tests read them, and the **test build**
(`build/netatlas-test.html`, written by `npm run build` next to the release)
can load them by name for the in-browser self-test, the viewport check and
the screenshots; `dist/netatlas.html` does not contain them. Any of them
opens with **Open model…**.

Three more files, in `test/fixtures/`, are generated test data:
`editor-new-network.yaml` (a model built from *New model* with the editor's
operations), `minimal-edited.yaml` (`test/examples/minimal.yaml` imported and
edited) and `metro-ring-arranged.yaml` (`test/examples/metro-ring.yaml` after
Auto-arrange in both views). `scripts/make-fixtures.mjs` produces them with
the same editing core the page uses; tests check that they're up to date,
and the in-browser self-test checks that the browser computes the same
positions. The browser self-test ([docs/TESTING.md](../docs/TESTING.md)) also builds a model and edits an
imported one through the real UI. It saves the files it "downloaded" in
`dist/selftest-downloads/`.

How the two kinds are kept apart is described
[above](#how-the-separation-is-kept).

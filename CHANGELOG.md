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

### Model format 1: changes before launch

NetAtlas is not released for production use yet, so model format 1 still
changes. These changes are made within version 1 (files keep `netatlas: 1`);
there is no conversion of files written for the earlier drafts.

- **Static routes:** a device may have `routes`, each with `prefix` and a
  next hop (`via`, `interface`, both, or `blackhole: true`), and optionally
  `distance` (1–255), `metric`, `vrf`, `name`, `description` and `attrs`.
  Allowed on devices that forward (a router, a switch, a routed firewall, a
  load balancer, a VPN Gateway, a filtering router, a Layer 3 forwarder
  System) and on hosts; an error on access points, IDS/IPS, clouds,
  pass-through Systems and devices without a type. A host's default gateway
  is a static default route.
- **VLANs on ports** replace the per-end `networks` list (and the link-end
  tagging of earlier drafts): a physical port, or an aggregate for its
  members, has `vlans` (VLAN IDs and ranges such as `30-39`): one VLAN makes
  an access port (untagged), several a trunk, with an optional `native`
  VLAN (untagged, one of its VLANs; without it every VLAN is tagged). On a
  Layer 3 switch a port may be `routed: true` instead. A switch's port needs
  its VLANs (an error until they are filled in); on a router and other
  Layer 3 devices a port without VLANs is routed; hosts are unaffected. A
  port with VLANs is a bridge port: an address on it is an error. A member
  of an aggregate takes the aggregate's VLANs (VLANs of its own are an
  error). Subinterfaces (`<port>.<n>`) stay for router-on-a-stick; a port
  can't be a bridge port and a subinterface parent for the same VLAN. VLANs
  are referenced by ID, as on networks and VLAN interfaces; the networks a
  cable carries are derived from its two ports. A link end holds only
  `device`, `interface`, `speed` and `duplex`: `mode`, `untagged`,
  `tagged` and `networks` there are unknown keys that say where the VLANs
  go.
- **VLAN interfaces bind to their bridge ports:** a VLAN interface is
  written once per device and VLAN, and is bound to every bridge port of
  its VLAN (access ports, trunks, aggregates) by itself; it has no member
  list. Two for one VLAN are an error, one whose VLAN no port carries a
  warning, and a Layer 2 switch has one (its management interface).
- **Consistency facts as fields:** an interface may have `mtu`; an aggregate
  (a virtual interface with members) `min_links`; a device `router_id` (an
  IPv4 address) and `asn`; a link end the port's `speed` and `duplex`
  (`full`, `half`, `auto`). The examples write these as fields instead of
  `attrs` (`router-id`, `asn`, `local-as`, a GRE relation's `mtu`).
- **`checks:`** (top level) switches consistency checks off or changes their
  severity: `checks: {duplicate-mac: info, relation-vrf-mismatch: off}`.
- **Routing services (`protocols:` on a device):** a Layer 3+ device lists
  the protocols it runs, each with its parameters
  (`protocols: {bgp: {asn: 65010}, ospf: {}}`), defined by a registry (BGP,
  OSPF, IS-IS, EIGRP, RIP, LDP, PIM, BFD, VRRP, HSRP, GLBP, CARP). Static
  routes are no protocol: a device's `routes` are always in effect, and
  `static` under `protocols:` (or as a relation's protocol) is unknown. Mandatory parameters (BGP's `asn`, IS-IS's `net`,
  a group's `group` and `virtual_ip`) are errors until written; OSPF needs a
  router ID. `protocols:` on a device that isn't Layer 3+ is an error.
- **The device's `asn` key is gone:** the AS number is BGP's parameter;
  `asn` on a device is an unknown key that says where it belongs.
- **`router_id`** is shared by the protocols that use one, and may name a
  loopback of the device (`router_id: lo0`, its IPv4 address) or be an
  IPv4 address; a protocol may have its own (`ospf: {router_id: …}`).
  Without an enabled protocol that uses a router ID it is reported as not
  applicable.
- **VRRP / HSRP groups at their interfaces:** an interface's
  `protocols: {vrrp: {group: 10, virtual_ip: 10.10.10.1, priority: 200}}`
  (also `virtual_ipv6`) replaces the virtual addresses in relation `attrs`
  (`virtual-ip`, `vip`, `master`, `priority`) and interface attributes
  (`vrrp-virtual-ip`), which nothing reads any more.
- **A link's `direction`:** `direction: unidirectional` makes a cable carry
  traffic from end `a` to end `b` only (simplex fibre, a data diode, a TAP
  or SPAN feed), consistent with relations; drawn with an arrow at end `b`;
  the path tracer never uses it the other way.
- **`demands:`** (top level, optional): traffic demands, each a `source`
  and `destination` (as Trace path takes them) and a `bandwidth`, with an
  optional `label`, `class` and `description`, for the protocol simulation.
  Analysis data: never changing the network objects; an end that names
  nothing is a warning.
- **A protocol of the model can declare `params`** (key, label, type,
  scope, required, range or values, suggestions, description) and
  `router_id` (`required` / `optional` / `none`); it is then a routing
  service like the built-in ones.
- **No compatibility messages for earlier drafts:** keys that earlier
  development versions used (`loopbacks`, `children`, `directed`, `prefixes`,
  `vlans`, `vendor` …) are reported like any other unknown key, with the
  closest known key as a suggestion; group kind `row` is free text like
  every other kind. `router_id` is an address now: the earlier
  `router_id: lo0` is an error ("not a router ID").

- **`layer3`** on switches (`layer3: true`): a Layer 3 switch with the full
  Layer 3+ feature set. Without it a switch is a Layer 2 switch: one
  management interface with addresses, static routes in the default table
  or its VRF, and nothing else of layer 3 (protocols, router ID, a second
  addressed interface, groups, tunnels, other VRFs, routing relations are
  errors). The examples write `layer3: true` on their routing switches.
- **`simulation:` on a device**: its simulation attributes, overrides only
  (`simulation: {arp_timeout: 300, spf_delay: 50ms, boot_time: 2min}`),
  checked against the registry, the device's type, the range and the unit.
  The ARP and NDP timers live here now: `arp_timeout` and
  `ndp_reachable_time` directly on a device or an interface are unknown
  keys.
- **`simulation:` on a link**: the cable's `latency`, `loss` and
  `flapping: true`, configured on the object and so first in the order of
  precedence.
- **`multicast:` on an interface**: the groups it joins (`join`: a group,
  or `{group, sources}` for a source-specific one) and the streams it sends
  (`streams`: `group`, `port`, `interval`, `size`); groups are checked
  (multicast, never link-local, SSM with sources and IGMPv3). PIM's device
  parameters `rp`, `candidate_rp` and `candidate_bsr`. Multicast device
  attributes: `igmp_version`, `unsolicited_report_interval`;
  `igmp_querier`, `igmp_query_interval`, `igmp_max_response`,
  `igmp_robustness`, `last_member_query_interval`, `pim_dr_priority`,
  `spt_switchover` (routers); `igmp_snooping`, `snooping_querier`,
  `fast_leave`, `unknown_multicast`, `router_port_aging` (switches);
  `multicast_passthrough` (firewalls), `multicast_over_tunnel` (gateways),
  `multicast_to_unicast` (access points), `multicast` (clouds).
- **More simulation attributes on devices** (Layers 3 and 4, broadcast):
  `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_errors`,
  `icmp_rate_limit`, `tcp_syn_retries`, `tcp_keepalive`,
  `closed_port_reply` (devices with an address); `directed_broadcast`
  (routers); `storm_control_broadcast`, `storm_control_multicast` and
  `stp_mode: off` (switches); `default_action`, `allow`, `stateful`,
  `tcp_session_timeout`, `tcp_handshake_timeout`, `udp_session_timeout`,
  `icmp_session_timeout` (firewalls); `listening` (servers, VMs,
  containers, storage, load balancers, proxies); `health_check_interval`,
  `health_check_timeout`, `health_check_threshold`, `persistence_timeout`,
  `algorithm` (load balancers); `client_timeout`, `upstream_timeout`
  (proxies); `test_traffic`, `test_targets`, `test_interval`, `test_type`,
  `app_timeout` (endpoints); `icmp_probe_interval` (monitoring systems);
  `beacon_interval`, `client_idle_timeout` (access points). A list
  (`allow`, `listening`, `test_targets`) is one text or a YAML list; on /
  off may be written `true` / `false`.
- Built-in protocols **`stp`** (aliases `rstp`, `mstp`), **`lldp`**, **`cdp`**
  and **`igmp`** (alias `mld`).
- **Simulation attributes at their level:** `simulation:` is also allowed
  on interfaces (physical and logical), on networks with a `vlan` (for the
  VLAN) and on relations, and on a DHCP scope and a DNS zone. Each
  attribute has one level: ARP / NDP timers, `respond_to_ping`,
  `icmp_errors`, `link_up_delay`, `los_detection`, storm control, the IGMP
  attributes, `pim_dr_priority`, `directed_broadcast`, `lacp_rate`,
  `beacon_interval`, `multicast_to_unicast`, `multicast_passthrough` are an
  interface's; `igmp_snooping`, `snooping_querier`, `fast_leave`,
  `unknown_multicast` a VLAN's; `vrrp_advert`, the IPsec lifetimes and DPD,
  `multicast_over_tunnel`, a load balancer pool's health checks,
  persistence and algorithm, and `response_time` a relation's. Some may be
  written on the device as the default for its objects. An attribute at
  the wrong level is an error naming its level (files using the old device
  attributes for these must move them; there is no conversion).
- **Spanning tree per port:** `stp`, `stp_cost`, `stp_port_priority`,
  `stp_edge`, `stp_bpdu_guard`, `stp_root_guard`, `stp_link_type` on a
  switch port or aggregate; `bridge_priority` and, for the new modes
  `mstp` and `pvst`, `bridge_priority_vlans` on the switch. The device
  attribute `stp-priority` is gone (`bridge_priority` replaces it).
- **Network services:** `services: {dhcp: {scopes: […]}, dns: {listen,
  zones: […], forwarders, reverse_zones}}` on a server, VM or container;
  `dhcp_relay` (helper addresses) on a routed interface with an address;
  `dns_servers` on a device. Simulation attributes `offer_delay` and
  `ping_check` (a scope's, or the server's), `record_ttl` (a zone's), and
  `dhcp_retries`, `dhcp_backoff`, `link_local_fallback` (a DHCP client
  interface's).
- **Virtualization: guests and their hosts.** There is no `hypervisor`
  device type (an unknown type whose error says what to do): a hypervisor
  is a server with `services: {hypervisor: {platform, cluster, cpu, ram,
  vswitches: [{name, type, uplinks, teaming, mtu, port_groups: [{name,
  vlans, native, guest_tagging}], simulation}], simulation}}`, a container
  host a server or VM with `services: {container_engine: {engine,
  networks: [{name, driver, interface, subnet, gateway, nat, parent, mode,
  hosts, range}], simulation}}`. A VM or a container needs `host` (of the
  right kind), has no `interfaces`, no cables and no `group` (its host's
  location), and optionally `guest_os`, `vcpu`, `ram` (VMs) or `image`
  (containers). New logical interface types: `vnic` (`port_group` or
  `passthrough` with `vf`; a hypervisor's host interface with `role`) and
  `veth` (`network`, `aliases`, `publish: [{host_port, port, protocol,
  host_ip}]`); a bridge network's interface on its host is derived. A VM
  may have `layer3: true` (a virtual router). The simulation attribute
  `vm_restart` moved from the device to the Hypervisor service; new are
  `failover_detection` (a virtual switch), `container_start` (a Container
  engine) and `restart_policy` (a container). The logical layout may hold a
  container network's place as `<host>/<network>`.
- **The device model: 15 types, kinds, roles, modes and System purposes.**
  The types are `router`, `switch`, `firewall`, `ap`, `load_balancer`,
  `ids_ips`, `vpn_gateway`, `security_gateway`, `server`, `vm`,
  `container`, `storage`, `endpoint`, `cloud` and `system`; the generic
  `gateway` and the `proxy` types are gone (unknown types whose errors say
  what they became). New device keys: `kind` (optional, the type's kinds,
  `other` with `kind_label`), `role` (suggested or custom), `mode`
  (firewall `routed`/`transparent`, IDS/IPS `inline`/`passive`, access point
  `standalone`/`controller`), `purpose` (required on a System: `host`,
  `l2_forwarder`, `l3_forwarder`, `inline`, `passive_monitor`,
  `pass_through`, `external_network`) and `icon` (a System's, among its
  purpose's), `port_pairs` (`{a, b, direction, copy}`, required on inline
  and pass-through devices) and `management`. A device's `role` is no
  longer an unknown key. Groups gain the kinds `cloud_region`, `vpc` and
  `vnet` with a `provider`; a VM or container in a cloud group may have no
  `host` (a cloud instance, with interfaces and cables of its own).
- **VPN Gateway and Security gateway functions.** A VPN Gateway's
  `services: {vpn: {operation, technology, tunnels | listener + pool,
  protected}}` and a Security gateway's `services: {separation:
  {implementation, domains, directions, rules, profiles, simulation}}` are
  required on them and errors anywhere else. The separation's simulation
  attributes are `transfer_delay` and `transfer_loss`. The proxy's
  `client_timeout` and `upstream_timeout` went with the `proxy` type.
- **Services by the service registry:** `services:` on any device may hold
  the services of the registry (`dhcp`, `dns`, `ntp`, `aaa`, `syslog`,
  `monitoring`, `proxy`, `load_balancing`, `vpn`, `nat`, `wireless`,
  `wireless_controller`, `hypervisor`, `container_engine`, `storage`,
  `application`, `inspection`, `separation`), each where the registry
  allows it; elsewhere an error with the reason. DHCP and DNS are no longer
  limited to hosts: a router, a Layer 3 switch and a routed firewall may
  run them. An access point's `wireless` is required (built in); a
  load balancer's `load_balancing` and an IDS/IPS's `inspection` are
  optional built-in configuration. A DNS server needs a zone or forwarders.
- **Wireless access and Wi-Fi networks:** `services.wireless` (an access
  point's, a router's) has `networks`, each with `id`, `ssid`, `vlan` or
  `untagged: true`, `radio`, `security` and `passphrase` (a placeholder),
  and on a controller-managed access point `forwarding` (`local`,
  `tunneled`) and a `controller`. A wireless connection at a radio names
  its network in the link's new key `wireless_network`; a radio takes
  several such connections. Access points may have static routes (their
  management address's default gateway).
- **The Separation gateway is now called the Security gateway:** the type
  `separation_gateway` is renamed `security_gateway` (no conversion of
  files written for the earlier draft); its function stays *Domain
  separation* (`services.separation`).
- **Examples converted by behaviour:** `device-types.yaml` (a remote-access
  VPN Gateway, the proxy as a server in the DMZ, a NAS behind a filtering
  bridge, a System of purpose host), `metro-ring.yaml` (console servers as
  Systems of purpose host), `ospf-reroute.yaml` (a passive IDS);
  roles replace `tier` workarounds and role words in labels in
  `datacenter-evpn.yaml`, `enterprise-wan.yaml`, `long-labels.yaml` and
  `campus-services.yaml`.

### Added

- **The service registry and the Services card** (one change across the
  app): every service is described once — its parameters with their types
  and conditions, who may run it and why not, its badge and its
  simulation. The Edit tab's **Services** card holds a card per service;
  **Add service…** lists the services the device may run and the others
  disabled with their reason; **Remove** shows its change plan (one undo
  step). Badges in a line under the device's type (at most three and a
  count, a tooltip with all, the legend). Find and the palette by SSID,
  VLAN and service. The service matrix in docs/FORMAT.md is generated from
  the registry (`node scripts/capability-matrix.mjs --write`).
- **Wi-Fi networks mapped to VLANs** over one uplink, by the device's
  Wireless access: validation (the VLAN is carried, nothing is added),
  each client in its network's VLAN in the path tracer and the simulation
  (DHCP, ARP and broadcasts stay there), the shared uplink as a single
  point of failure, a tunneled network reported as not simulated, the
  networks and their clients in the Wireless access card, *SSID “…” · A n*
  at the radio's end of each connection.
- **The catalog in the simulation:** NTP requests to upstreams, RADIUS /
  TACACS+ from an AAA server's clients, syslog from its senders, SNMP polls
  of monitored devices, CAPWAP between controller-managed access points
  and their controller, a reverse proxy, a load balancer's own backends and
  algorithm, NAT (PAT, source NAT, port forwards; noted by the path
  tracer), an inline IPS's blocks and a passive one's alerts; the services'
  ports are listening.
- **Four examples:** `multi-ssid-ap.yaml`, `home-network.yaml`,
  `campus-wireless.yaml` (three tiers, controller-managed Wi-Fi, a
  services server) and `dmz-services.yaml` (a VPN and NAT on a firewall,
  an IPS, a reverse proxy, a load balancer, a NAS).

- **Capability-based behaviour** (one change across the app): every
  module decides by what a device can do — one resolver
  (`src/model/capabilities.ts`) derives it from the type, mode, Supports
  Layer 3, a System's purpose and a Security gateway's implementation —
  instead of by type names; an architecture test keeps type comparisons out
  of everything but the registry and the resolver. The capability matrix
  in docs/FORMAT.md is generated from the resolver and checked by a test.
  * **Editing:** the device's *Identity* card in order — Type, Kind (with
    *Other* and its name), Role, Mode or a System's Purpose and Icon;
    changing the type, mode, purpose or implementation asks first, lists
    what no longer fits and what stays but is reported, and removes it in
    one undo step. The **VPN gateway** and **Domain separation** cards
    (built in, not removable; nothing preselected), **Port pairs** and
    **Management interfaces**.
  * **VPN Gateway:** forwards only to and from its VPN, in the path tracer
    and in the simulation.
  * **Security gateway:** exactly two domains, permitted directions,
    ordered allow rules with every match written, a default deny both ways,
    replies of a permitted transfer and nothing else the other way; a
    filtering bridge, a filtering router, or a protocol break with transfer
    profiles (HTTPS, DNS, syslog) whose two legs are traced, simulated and
    correlated; management interfaces never forwarded; its own icon, the
    domain under each port, and its policy in the Details tab.
  * **Path tracer:** an optional **Service** (`tcp/443`, `udp/53`, `icmp`)
    a Security gateway decides by; a protocol break's **Leg 2**; port
    pairs, TAP copies and a VPN Gateway's tunnels; a stop reason *denied*.
  * **Simulation:** a transparent firewall filters what it bridges; inline
    devices and pass-through Systems keep to their pairs (one way where
    set) and copy to monitor ports; passive monitors report what they
    observe; a Cloud is one Layer 3 hop (TTL one lower; TTL-1 hellos end
    at it).
  * **Single points of failure** follow what each device joins: a
    Security gateway's domains only with a permitted transfer, port
    pairs, never a management interface.
  * **Diagram, legend, Find, palette:** icons for the VPN Gateway, the
    Security gateway, the kinds with an icon (Cloud gateway, PLC, HMI,
    camera …) and the System purposes (console, protocol gateway, TAP,
    diode …); the subtitle with mode, purpose and kind; the legend lists
    the types and kinds used; ports say "domain Red", "management",
    "pair 1", "copy"; Find and the palette find devices by kind and role;
    Auto-arrange puts a known role in its row.
- **Five examples:** `wan-vpn.yaml` (an MPLS Cloud and a dedicated VPN
  Gateway), `hybrid-cloud.yaml` (region, VPC, VNet, Cloud gateway routers,
  cloud instances), `ot-network.yaml` (PLC, HMI, a protocol gateway System,
  a TAP and a passive IDS), `cross-domain.yaml` (a protocol break with a
  permitted and a denied transfer) and `separation-filtering.yaml` (a
  filtering bridge and a filtering router).
- **Hypervisors, VMs and containers** (one change across the app):
  * **Editing:** the **Services** card's **Hypervisor** and **Container
    engine** checkboxes with their collapsible configuration (virtual
    switches with uplinks, teaming and port groups; container networks of
    every driver); a host's guests with **+ VM** / **+ Container**; a
    guest's **Host** picker (only the hosts that can run it) as its first
    field; **+ Virtual NIC** / **+ Host interface** / **+ Network
    attachment** with pickers of what the host offers (port groups,
    passthrough ports, networks), MAC generation with the platform's OUI and
    the next free address; unticking a service or deleting a host asks
    first and names the guests; renaming a host updates them; Connect
    refuses a guest.
  * **Validation and checks:** every rule of the format, and the checks
    `vswitch-uplink-vlan`, `vnic-network-vlan`, `container-parent-vlan`,
    `ha-restart-portgroup` and `hypervisor-overcommit` (info).
  * **Physical view:** guests inside their host's box (a container in a VM
    inside the VM) with the virtual switches and container networks as
    bars, port groups as pills, wires from the vNICs and veths, uplink and
    passthrough wires from the host's ports; dragging a guest moves its
    host. **Logical view:** a guest's box names its host (*runs on …*);
    bridge and overlay networks are networks of their own host (dashed,
    *NAT*). Legend entries for both.
  * **Filters, Find and related objects:** *Server* in **Device types ▾**
    has **Hypervisor**, **Container host** and **Other** under it; the
    physical view shows a guest only with its host and says which it leaves
    out; focus keeps a host's guests; Find by host, port group and network;
    related objects both ways.
  * **Path tracer:** through the port group's virtual switch and the
    teaming's uplink (or the passthrough port), inside a host without a
    cable, SNAT out of a container host and DNAT to a published port (a
    limited NAT model), a container's default route by its network's
    gateway. **Failures and single points of failure:** a host takes its
    guests (an HA cluster restarts its VMs), a vNIC follows its uplinks;
    SPOF lists a host for its guests, a virtual switch with one uplink or
    uplinks to one switch, and a passthrough port.
  * **Simulation:** each virtual switch is a bridge without spanning tree
    (split horizon, teaming), failing over after its detection time with a
    RARP per guest; a host powered off takes its guests, an HA cluster
    restarts its VMs on another member after the VM restart time (drawn
    there during the simulation); container NAT, published ports and
    macvlan; the container start time and restart policies; new events
    **Stop / Start container engine**, and a host's uplink as a port;
    **Show MAC table** of a virtual switch or container network.
- Example **`virtualization.yaml`**: two ESXi hosts in an HA cluster with
  teamed uplinks to two ToR switches, VMs on access port groups, with guest
  tagging, with passthrough and a virtual router; a Docker host with a NAT
  bridge network (published ports) and a macvlan network; a VM running a
  container. `device-types.yaml` and `consistency-checks.yaml` use the new
  model.
- User Manual sections *Model hypervisors, VMs and containers* and *Follow
  virtual networking in a simulation* with three screenshots; a README
  screenshot of the virtualization example.
- Tests: `test/virtual.test.mjs`, `test/virtual-diagram.test.mjs`,
  `test/virtual-analysis.test.mjs`, `test/sim-virtual.test.mjs`,
  `test/virtual-ui.test.mjs` (the Edit tab with real input); a self-test
  block on the virtualization example in both themes and a viewport state
  for a hypervisor's Services card.

- **Send and play** in the Send test form while paused. A test's messages
  are marked **Test** (in their labels, *Test ·*, and in the event log)
  and draw a trail.

- **DHCP and DNS servers.** A server's **Services** card with **DHCP
  server** and **DNS server** checkboxes (off by default): scopes with
  network, range, gateway, DNS servers, lease, exclusions, reservations and
  domain, suggested by the input helpers; zones with the records derived
  from the model's DNS names (read-only, with their source) and their own
  A, AAAA and CNAME records; listening address, forwarders, reverse zones.
  What a service still needs is reported as errors; validation of ranges,
  gateways, reservations, overlaps, records and relays; the checks
  `dhcp-no-server` and `dhcp-relay-no-server`. A host's DNS servers, a
  routed interface's DHCP relay. The diagram marks servers with **DHCP** /
  **DNS** badges (in the legend) and DHCP client interfaces with *DHCP
  client* and a reserved lease line.
- **DHCP and DNS in the protocol simulation:** DORA for every client in
  parallel, through relays, the lease applied (address, default route, DNS
  servers) and everything else waiting for it; renew at T1, rebind at T2,
  expiry; an exhausted pool (no answer, or a NAK); retries with backoff and
  a link-local fallback; DNS resolution by host name for Send test and test
  traffic (CNAMEs, NXDOMAIN, SERVFAIL, forwarders, timeouts, the cache) as a
  dependency of the connection. Labels such as *DHCPOFFER 10.10.10.100 ·
  lease 1 d*, *DNS A? web.campus.example*. Tables **Show DHCP leases**,
  **Show DNS zone** and **Show DNS cache**. The diagram writes a lease into
  its client's line: *10.10.10.100/24 (DHCP lease)*.
- **Per-object Simulation subsections** in the Edit tab (collapsed) for
  interfaces, networks with a VLAN, relations, DHCP scopes and DNS zones,
  with the same inherit / override / reset fields as a device's.
- **Spanning tree per port in the simulation:** 802.1D path costs by speed,
  root and designated ports, port priorities, root guard, edge ports
  (forwarding at once; without one a host port waits 2 × forward delay in
  STP mode), BPDU guard (err-disabling the port), shared links; MSTP and
  PVST with a root per VLAN.
- New example **`campus-services.yaml`**: a DHCP and DNS server for two
  VLANs (one behind a relay on a Layer 3 switch), a Layer 2 access switch
  with per-port spanning-tree settings, test traffic by host name.

- **Senders** in the protocol simulation: choose which devices you watch,
  in Start simulation… (after the protocols, open) and in the Simulation
  setup (collapsed, its heading summing the choice up: *Senders (3 of 23):
  hq-rtr1, muc-rtr, client-1…*). A filter box, **All**, **None**,
  **Selected in diagram**, **By type ▾**, **By group / site ▾**, and a
  checklist grouped by type or by group / site with icons, L2 / L3 badges
  and foldable groups with counts. Only the senders' messages and the
  exchanges they start (replies, errors, forwarded copies) are drawn and
  logged; the log counts the others, and **Show all senders** lists them.
  Endpoint test traffic comes from senders only; every protocol still runs
  on every device. The diagram's selection is preselected; the choice is
  remembered for the session. **Use as sender** / **Stop as sender** in a
  device's menu and in Actions; a ▶ badge marks the senders. Every message
  carries its sender and origin in the engine.
- The playback state beside Play and Step (*Playing*, *Paused*, *Paused:
  inspecting packet*), announced politely.
- Speeds 0.1× (the slowest) to 4×.


- **Device types ▾** filter, directly next to **Devices ▾** with the same
  look: a checkbox per device type the model uses (display names, with each
  type's number of devices; types the model doesn't use are left out),
  **Select all** and **Clear**; *Switch* has **Layer 2** and **Layer 3**
  under it when the model has both. The button and the status bar say what
  is shown (*Device types: 3 of 8*). Unticking a type hides its devices and
  what only they connect; nothing is deleted or moved; it combines with
  Devices (a device hidden by its type stays ticked there, *hidden: type
  Server off*); both views and exports; full keyboard support.
- **The simulation layout:** while a simulation runs, **Simulation setup**
  (the protocols, open, and the Layer 1–4 parameters, collapsed) replaces
  the Objects list, **Actions** (the selected object's network events, the
  active events, Send test, the device's Simulation settings) replaces the
  Inspector's tabs, and the **simulation panel** is docked under the
  diagram (Play, Step, speed, pacing, skip idle time, the time and Exit;
  status and the selected device's tables beside the event log). Its height
  is set with a keyboard-operable splitter and remembered. Narrower than
  1100 px the side panels narrow; below 860 px Setup and Actions are tabs
  above the panel (with Diagram in a window that is also not tall).
- **Pacing of the simulation** (`analysis/sim/pacing.ts`): every message
  travels its whole way (hop by hop and across switches in the physical
  view, along the whole relation in the logical view), fades in at its
  sender, pulses at its receiver, and a lost one shows ✕ where it was lost
  for about a second. **Readable** pacing (the default: about 1 s per hop,
  scaled by the link's latency, 0.6–3 s) or **Proportional to latency**
  (*1 ms = 1 s*), a speed of 0.25×–4× on top, **Skip idle time** (on;
  *⏩ 9.8 s skipped*), **Follow message** (a message and its replies hold
  the pace, with a trail), **Step** to the next message event; the sending
  and receiving devices are marked. Under reduced motion each message is a
  still labelled arrow for the same paced time. Pacing never changes what
  is simulated.
- `F6` / `Shift+F6` move the keyboard focus between the left panel, the
  diagram, the right panel, the simulation panel and a tool window.
- The protocol list gets a **Multicast** group, and each protocol says how
  many devices, relations, demands or streams use it.
- The event log can be filtered by protocol.


- **Multicast in the simulation.** IGMPv2 / v3 and MLDv1 / v2: querier
  election and takeover, general and group-specific queries, reports with
  random delays and v2 report suppression, leaves, expiry. IGMP / MLD
  snooping on switches: router and member ports, reports only to routers,
  fast leave, the snooping querier, unknown multicast flooded or dropped.
  PIM sparse mode (the DR's joins to the RP, Register and Register-Stop, the
  switch to the source's tree and the RPT prune), SSM and dense mode (flood,
  prune, graft); the RPF check, and trees that move when the unicast routes
  change. Streams from hosts, Join group… / Leave group / Start stream… /
  Stop stream as network events (from a host's menu and the window's
  Multicast section); Show IGMP groups, Show multicast table, Show
  multicast routes; IGMP / MLD in the packet inspector; multicast tests
  that list the members that received them. The start dialog's Layer 2 and
  Layer 3 get their eighth parameters (IGMP / MLD snooping, the query
  interval); the test traffic type multicast.
- **Multicast consistency checks:** `multicast-no-querier`,
  `multicast-no-rp`, `multicast-rpf-not-pim`.
- The example `protocol-simulation.yaml` streams an any-source and a
  source-specific group to receivers in two VLANs behind a snooping switch,
  with two queriers, a static RP, a link whose failure moves the tree and a
  VLAN without a querier.
- **Layers 3 and 4 in the simulation.** ICMP and ICMPv6 errors from where a
  packet stops (net and host unreachable, TTL exceeded, fragmentation
  needed / packet too big, port unreachable, administratively prohibited,
  reassembly time exceeded), quoting the packet's header, never about a
  broadcast or multicast packet or another error, rate-limited per device,
  none from a blackhole route; MTU per interface (`mtu`, else the default
  MTU) with IPv4 fragmentation and reassembly, and path MTU discovery. TCP
  (handshake, SYN retransmissions with exponential backoff and the
  connection timeout, RST from closed ports, data in segments that fit the
  path MTU, FIN and TIME_WAIT, keepalive) and UDP (answers, port
  unreachable); BGP's TCP connection retransmits its SYN the same way.
  Listening ports per device (its attribute, else the ports of the
  relations it serves). Firewalls apply their policy (the model's
  relations, an allow list, a stateful session table with timeouts; drop or
  reject). Load balancers (health checks, round robin / least connections /
  source hash, persistence) and proxies (upstream connect timeout, client
  timeout) relay TCP; monitoring systems ping the devices they poll by SNMP.
- **Layer 4 parameters** (Layer 4 – Transport (8)): TCP SYN retries, the
  initial retransmission timeout, the keepalive time, reply to closed
  ports, endpoint test traffic with its interval and type, the application
  response timeout; Layer 2 gets the default MTU, Layer 3 *Send ICMP
  errors*; the spanning tree mode can be off.
- **Test traffic and Send test…:** endpoints ping their gateway and test the
  servers of their service relations (or their own targets) every
  interval when test traffic is on; Send test… (a device's menu, the
  window) runs one ICMP echo, TCP connection or UDP request from any device
  to a device, interface, address, subnet broadcast, 255.255.255.255 or a
  group, with the data size, DF and keeping a TCP connection open. Results
  in the window, the status table and the event log.
- **The packet inspector:** a dot, or a message of the event log (also by
  keyboard), shows its frame layer by layer: MACs and what they are, the
  VLAN tag, the IP headers (TTL, DF, protocol, length, fragment), ports and
  TCP flags, ICMP type and code with the quoted header, the payload.
  Every message, a relation's too, carries its transport header.
- **Broadcast:** limited broadcasts stay in their subnet; directed
  broadcasts only where a router forwards them; broadcast pings answered
  only where that is on. **Highlight broadcast domain** on a device or a
  cable marks what a broadcast reaches. A loop of switches without
  spanning tree storms (warned in the banner and the window, MAC addresses
  moving); storm control drops the looping frames.
- **Dots by cast:** a circle for unicast, a square for broadcast, a
  diamond for multicast (explained in the window). The event log filters
  by layer and by cast; ARP and NDP messages have log lines of their own.
- **Show connections** (a device's open ports and connections with their
  states and timers) and **Show sessions** (a firewall's session table).
- **Wireless clients** are disassociated after their access point's
  client idle timeout and wait for the next beacon to come back.
- The example `protocol-simulation.yaml` shows them: pc1's test traffic
  (an open and a closed port of srv, the DMZ server behind a firewall that
  rejects, an address without a route), a path with a smaller MTU, and a
  lab loop without spanning tree that storms.
- **Simulation parameters for Layers 1–3.** Start simulation… opens a
  dialog with one collapsible section per layer (Layer 1 – Physical (8),
  Layer 2 – Data link (6), Layer 3 – Network (6)): latency, packet loss,
  loss-of-signal detection, link-up delay, default speed, flapping times
  and cycles; ARP timeout, retransmit and retries, NDP reachable time, MAC
  aging, spanning-tree mode; default TTL, OSPF hello, BGP keepalive, BFD
  interval × multiplier, VRRP advertisement, route recomputation delay.
  Every field has its default with its source, its unit and a range check;
  changed values are marked modified, with Reset per section and for all;
  the values are remembered for the browser session. The same sections are
  in the Simulation window, where a change applies at once (timers
  rescheduled, tables checked against new timeouts) and is logged.
- **One order of precedence** for every value: configured on the object,
  the device's attribute, the simulation's value, the default; every place
  that shows a value says which (`src/analysis/sim/params.ts`).
- **A device's Simulation section** in the Edit tab (collapsed, its count
  in its name): the attributes that apply to the device (ARP / NDP timers,
  TTL, boot time; route recomputation delay, ECMP paths; MAC aging and
  table size, spanning-tree mode and timers, LACP rate; HA failover; IPS
  fail mode and latency; IKE / Child SA lifetimes, rekey margin, DPD;
  service response time; VM restart time; SNMP polling; a cloud's latency
  and loss; an access point's association time), inherited values shown
  with their source, overrides written as one undo step, Reset to
  inherited. It stays editable during a simulation, where its changes apply
  at once (and Undo takes them back).
- **Network events**, several at once: Fail link / Restore on cables and
  relations, Start / Stop flapping on cables and ports, Shut interface /
  No shut, Power off / Power on (boot time, a fresh start; an IPS failing
  open or closed; VMs restarted on another server), from the in-diagram
  menus and from the window's Network events list, each event with its way
  back.
- **Layer 1 in the engine:** a frame takes its cable's latency plus its
  serialization time; packet loss from a fixed seed; ports notice a dark
  cable after the loss-of-signal detection time and come back after the
  link-up delay. Routers keep their old routes for their route
  recomputation delay; the spanning tree converges as its mode says.
- **The protocol simulation** (Simulate → Start simulation…): a freshly
  booted network (every ARP, neighbour and MAC table empty, every adjacency
  down, the interfaces up at t = 0) whose protocols exchange their messages
  as labelled dots, cable by cable in the physical view and along the
  relations in the logical view, with lanes per direction, labels placed
  where they cover nothing, at most 48 dots (the rest in the event log). Its
  window: Play, Pause, Step, speed 0.25×–10×, the simulated time, the
  protocols shown (grouped, Layer 2 first; changed at any time without a
  restart), failing a link, the ARP and MAC tables, the status table and a
  filterable event log. Every built-in protocol has a **simulation
  profile** in the registry (messages, transport, timers with their
  defaults and sources, states, failure and restore behaviour); the model's
  values are used where written, defaults are marked in the log. Messages
  over tunnels travel inside them (OSPF in GRE in ESP); protocols of the
  model's own send dummy packets in the relation's direction; the demands
  send data packets. Deterministic (a fixed seed), requestAnimationFrame,
  paused while the page is hidden; reduced motion: steps with static
  labelled arrows; exports: a still picture with a *Protocol simulation,
  t = …* note. It never changes the model.
- **Layer 2 in the simulation:** ARP (request broadcast, unicast reply, the
  waiting packet released) and NDP (solicited-node multicast, advertisement)
  before unicast traffic; multicast to the group's MAC; gratuitous ARP when
  an interface comes up and when a VRRP / HSRP master changes (with the
  virtual MAC); switches learning per port and VLAN, flooding within the
  VLAN, known unicast to the learned port; access ports untagged and trunks
  tagged except their native VLAN (the 802.1Q tag in the packet
  inspector), a VLAN interface reached through any bridge port of its
  VLAN, a disallowed VLAN dropped and a native mismatch leaking, both
  explained in the log; a spanning tree per VLAN on the bridge ports
  (BPDUs, LLDP and CDP where the model has their
  relations); LACP on aggregates; routers and Layer 3 switches rewriting the
  MACs and decrementing the TTL hop by hop, in the event log. Interfaces
  without a MAC get a generated, locally administered one, from a fixed
  seed, marked *(simulated)*.
- **ARP, neighbour and MAC tables** per device, hidden until asked for:
  clicking a device in the simulation offers **Show ARP table** (and **Show
  MAC table** for switches), the window lists them too; small movable
  non-modal panels, several at once, closed by Esc and when the simulation
  ends; entries with type, state, age and the time to expiry, the timers in
  effect (configured or default with its source) and a **timer scale**.
- **Failing a link** in the diagram (Fail this link / Restore link at the
  spot clicked, one link at a time; the window offers the same): dropped
  frames marked where they were lost, timers expiring (OSPF dead interval,
  BGP hold time, BFD, DPD, VRRP master down), states going down,
  reconvergence (LSU flooding, withdrawals), VRRP failover, traffic
  rerouted or lost; after the restore the full handshakes.
- **Layer 2 / Layer 3 switches** in the Edit tab (a **Layer 3** checkbox;
  making a configured Layer 3 switch Layer 2 asks first and lists what
  goes, one undo step), the diagram (an **L2** / **L3** badge on the icon
  and a Layer 3 glyph, in both views and exports, explained in the legend),
  the details, the object list, Find and the palette; the same rule in the
  Protocols card, the checks, the path tracer, Single points of failure
  and the simulation.
- **New example `protocol-simulation.yaml`**: hosts without MACs, a Layer 2
  access switch, a Layer 3 core switch routing two VLANs, trunks, a VRRP
  pair, a configured ARP timeout, an OSPF ring with costs, iBGP between
  loopbacks, BFD, IPsec with GRE and OSPF, PIM with a source and a
  receiver, a custom protocol on a one-way relation.

- **New example `ospf-reroute.yaml`:** OSPF costs that make one way
  preferred, a VRRP pair, a camera VLAN routed by one router, a one-way TAP
  cable and two demands.
- **New entries are ready to fill in:** after any create action (+ Add,
  Duplicate, Connect, an interface, loopback, port range, route, DNS name,
  address, protocol, VRRP group, attribute, endpoint, member port, underlay)
  the entry is selected and marked, its card opened and
  scrolled into view (smoothly unless reduced motion is preferred), and the
  cursor is in its first field with the proposed text selected; a new object
  is selected in the diagram with its outline row in view. The creation is
  announced to screen readers. Ctrl+Z in the untouched new field takes it
  back; after an undo the focus returns to the creating button and the
  selection to what it was.
- **A resizable side panel:** 480 px by default (was 410), with a splitter
  (drag, double-click to reset; a keyboard-operable separator with ← → Home
  End Enter); the width is remembered in local storage, the diagram keeps at
  least 360 px, and the tabs wrap instead of being cut off.
- **Analyze in tool windows:** every entry of **Analyze ▾** opens its own
  non-modal window over the diagram (`role="dialog"`, no `aria-modal`):
  movable by its title bar, resizable at its grip (both also with the arrow
  keys), foldable, dockable; its size, position, docking and folding
  remembered in local storage; never outside the browser window; one at a
  time (opening another replaces it); closed with × or Esc, the focus
  returning to where it was; `F6` moves the keyboard focus between the
  window and the page. Below 860 px wide (200 % zoom on most screens) it is
  docked: a full-width panel at the bottom, above the status bar, and the
  page never scrolls. The **Addressing overview** is one (a click selects
  without closing it); **Focus…** (`Shift+F`) shows the selected object,
  1–3 hops as a radio group, Focus and Exit focus (the banner stays);
  **Trace path…** (`T`) has From, To, VRF and the return path, and a hop
  table (device, in, out, addresses, route or relation, encapsulation) per
  path, the alternatives and the return path in labelled sections, Copy and
  Save as text, the path marked while it is on; **Single points of
  failure…** is a table (element, type, cuts off, relations down, impact),
  most impact first, sortable by every column and filterable, with Show in
  diagram per row, a short explanation, CSV and text (copy or save) of the
  rows shown.
- **Simulate ▾** holds **Start simulation…** and **Exit simulation**.
- **Input helpers in the Edit tab** (each an explicit action, one undo
  step, validated like typing, nothing written by itself): MTU chips (1500,
  9000, and for tunnels 1476, 1400 and the underlay's MTU less the
  encapsulation overhead), **Generate** for a MAC address (random, locally
  administered unicast, unique in the model, in the model's style, from
  `crypto.getRandomValues`), a **VRF combobox** (the VRFs in use with their
  counts; case-only differences flagged), VLAN IDs (next free, defined),
  an interface name that follows the device's pattern, the router ID from
  the loopbacks, AS numbers in use, VRRP / HSRP group numbers and virtual
  IPs on the segment, the registry's common parameter values, default
  route prefixes and a floating distance, an IS-IS NET from the router ID,
  a BGP end's peer AS from the other device. The palette offers *Generate a
  MAC address* and *MTU 1500* for the selected interface. A protocol
  defined in the model has a *Routing service* card (*Uses a router ID*).
- **Check `vrf-name-case`:** VRF names that differ only in case.

- **Routing services in the Edit tab:** a device's **Protocols** card shows
  the protocols it runs with their parameters (typed fields, choices,
  suggestions), the shared **Router ID** while one of them uses it (its
  loopbacks offered), an own router ID per protocol, one-click
  suggestions for protocols the device's relations use but it doesn't
  enable, **Enable a protocol…**, and **Disable** (listing what goes, one
  undo step). Interfaces get their VRRP/HSRP group card; relations of OSPF,
  BGP … a card with their per-end parameters. The palette has *Enable a
  protocol on the selected device…*; Find and the palette find protocols,
  AS numbers, router IDs and virtual addresses.
- **Checks** `protocol-not-enabled`, `protocol-unused`, `static-not-enabled`
  and `fhrp-group-mismatch`; `duplicate-router-id` per protocol domain;
  `vip-outside-subnet` on the interfaces' groups.

- **Static routes in the diagram and the editor.** The logical view shows
  each device's routes as a route table in its box (one per VRF), a line per
  route (`0.0.0.0/0 via 203.0.113.5 AD 250`), and a dotted line with an arrow
  from a route to the interface its next hop belongs to. A **Routes** switch
  in the toolbar's Filters hides them without moving anything. The Edit tab
  has a **Static routes** section per device (add, edit, duplicate, delete,
  each one undo step; an exit-interface picker and next-hop suggestions).
  Details, tooltips, **Find** (prefix, next hop, name) and selection include
  routes; a route is related to its device, its exit interface and the
  interface its next hop belongs to.
- **Port VLANs in the diagram and the editor.** The physical view writes
  each port's VLANs under its name (`A 10`, `T 10,20,30–39 · N 10`, `R · T
  10,20` for a routed port's tagged subinterfaces), draws trunks larger with
  a thick frame (in the legend) and marks a cable whose ports disagree with
  ⚠ *VLANs differ*. A port's card has a keyboard-operable multi-select
  **VLANs** combobox (the model's VLANs with their names; new IDs and
  ranges), a **Native VLAN** picker on trunks and a **Routed port**
  checkbox on a Layer 3 switch; a mode badge in words (*Access · VLAN 10*,
  *Trunk · 10, 20, 30–39 (native 10)*, *Routed*) in the card, the device's
  port list and, per cable, the Objects list; suggestions (*Same as
  Gi1/0/1*, *VLANs of the connected port*); **Assign VLANs to ports…** for a
  port range in one undo step; a switch port's missing VLANs as an error at
  the field and in Problems, which leads back to the field. A VLAN
  interface shows its **Bridge ports** read-only, by mode, each a link; it
  and its ports highlight each other. **Find** finds ports and cables by
  VLAN (`vlan 20`) and ports by mode (`trunk`).
- **Analysis module** (`src/analysis/`): address arithmetic for IPv4 and
  IPv6, routing tables (connected networks, static routes per VRF,
  longest-prefix match, distance, metric, equal-cost multipath, recursive
  next hops never through a default route) and a registry of **consistency
  checks**, each with a stable id, a severity and the fields it reads. Its
  findings appear in the Problems tab (with the check id, and a click opens
  the object) and at their field in the Edit tab; they never make a model
  invalid. Checks in this release: `route-nexthop-self`,
  `route-nexthop-unresolved`, `route-nexthop-recursive` (info),
  `route-nexthop-interface`, `route-exit-interface`, `route-duplicate`,
  `route-conflict`, `vlan-access-mismatch`, `vlan-trunk-mismatch`,
  `vlan-native-mismatch`, `vlan-access-trunk`, `vlan-unknown` (VLAN 1
  aside), `lag-member-vlans`.
- **Addressing overview** (Analyze → Addressing overview…, `I`): the
  networks of each VRF nested by containing prefix, with VLAN, name,
  members (device, interface, address, DNS name, DHCP), gateway or VIP, used
  addresses and size, utilization (IPv4 percent; IPv6 number of /64s), free
  ranges and the next free address; duplicate addresses, overlapping
  prefixes and addresses in no network. Filter, sort, a click selects the
  object in the diagram, Copy CSV and Save CSV. The Edit tab offers the next
  free address of a network when an address is added to an interface.
  Computed in `src/analysis/addressing.ts`.
- **Analyze menu** between Find and Help, for the analysis views.
- **Command palette** (`Ctrl+K`, `Cmd+K` on a Mac; Find → Command
  palette…): fuzzy search over every command (with its shortcut; an
  unavailable one disabled, with the reason) and every object of the model
  (devices, interfaces, cables, networks, relations, routes, locations);
  recent entries first; Enter runs or selects, Esc closes; the number of
  results is announced. The menus, the keyboard shortcuts and the palette
  now come from one command registry (`src/ui/commands.ts`).
- **Focus mode** (`Shift+F`, the ◎ Focus button under the diagram, Analyze →
  Focus on selection): only the selected object and what is within 1–3 hops
  of it, along cables (physical view) or relations (logical view). A banner
  names it, changes the hops and exits (also `Esc`); it combines with the
  other filters, positions are temporary, and leaving it restores the
  diagram and zoom exactly. Exports carry a *Focus* note. Computed in
  `src/analysis/focus.ts`.
- **Path tracer** (Analyze → Trace path…, `T`): from a device, interface or
  address to another, optionally in a VRF, by the model's connected
  networks, static routes and routes learned over the routing adjacencies
  (OSPF, IS-IS, EIGRP, RIP, BGP: `cost` per adjacency, else a hop count;
  longest prefix, administrative distance, equal-cost multipath), VRRP
  virtual gateways, the cables through switches in the network's VLAN, and
  tunnels with their encapsulation stack (GRE over IPsec) and underlay. The
  new **Analysis** tab lists the hops (device, interfaces and addresses, the
  route or adjacency, the encapsulation, the cables), the equal-cost
  alternatives, where and why a trace stops, and an optional return path
  that reveals asymmetric routing; Copy / Save as text. Both views mark the
  path (solid), the alternatives (dashed) and the return path (dotted);
  exports carry it with a *Path trace* note. A model-based approximation,
  computed in `src/analysis/trace.ts`; the routing tables now include the
  dynamic routes (`src/analysis/routing.ts`).
- **The mode banner** has a row per analysis mode on (simulation, focus,
  path trace).
- **Single points of failure** (Analyze → Single points of failure…): the
  cables, devices and LAGs whose failure alone partitions the physical
  network or brings down relations without a redundant underlay, found by
  propagating each failure through the model (`src/analysis/failure.ts`).
- **More consistency checks**, each with a positive and a negative test:
  `link-mtu-mismatch`, `tunnel-mtu` (with the encapsulation overhead it
  assumes in the message, added up over a tunnel stack),
  `link-speed-mismatch`, `link-duplex-mismatch`, `lag-member-speed`,
  `lag-peer-devices` (unless an MLAG pairs the peers), `lag-min-links`,
  `link-subnet-mismatch`, `address-reserved`, `vip-outside-subnet`,
  `duplicate-router-id`, `duplicate-mac`, `ospf-area-mismatch`,
  `ospf-network-type-mismatch`, `ospf-timer-mismatch`, `bgp-peer-as`,
  `bgp-session-type`, `tunnel-endpoint-mismatch`, `tunnel-underlay`,
  `relation-vrf-mismatch`.
- **Problems tab** in two parts, the file's own problems and the consistency
  checks; findings can be narrowed by severity and name the objects they
  concern as links; the checks a model changes are listed. **Model settings
  → Consistency checks** sets each check to its default, another severity or
  off. The Edit tab has MTU, minimum links, router ID, AS number, and per link
  end the port's speed and duplex; the device box shows `router-id` and `AS`.
- Example **`consistency-checks.yaml`**: one deliberate inconsistency per
  check.
- Example **`branch-routing.yaml`**: a dual-homed branch with a floating
  static default route, equal-cost routes to HQ, a blackhole, a guest VRF,
  host default gateways and a router-on-a-stick (a routed router port with
  subinterfaces, the switch's trunk with a native VLAN).
- Example **`vlan-ports.yaml`**: an L2 access switch (ports 1–10 in VLAN
  10, 11–20 in VLAN 20, a trunk uplink with a native VLAN), an L3 core with
  Vlan10 and Vlan20 bound to their bridge ports, a routed uplink, a LAG
  trunk, a router with a bridge port and its BVI, and deliberate
  mismatches (a native VLAN that differs, a VLAN one end doesn't allow).
- User Manual section *Static routes and port VLANs* with three
  screenshots; README screenshots of route tables and port VLANs.
- Tests: `test/analysis.test.mjs`, `test/routes.test.mjs`,
  `test/port-vlans.test.mjs` (the port model, validation, VLAN interfaces,
  every VLAN check positive and negative, editing, display),
  `test/sim-vlans.test.mjs` (port VLANs in the simulation), and self-test
  blocks for the routes UI, the Routes switch and its effect on exports,
  and the port VLANs on the VLAN example in both themes.

- **Relations and links attached to their interfaces.** In the logical view
  every interface a relation is bound to has a **port** beside its row on the
  side of the device box, and every relation starts and ends exactly there,
  found by the interface's id. Several relations on one interface leave its
  port side by side in parallel lanes; a relation bound to the device as a
  whole leaves from a separate, hollow **device-level port** beside the
  device's name. Each port has an **end label** with the interface's name and,
  for a tunnel, the underlay it is sourced from (`src: Gi0/0 203.0.113.1`).
  Routes leave the port on the side facing the peer, never cross another row
  or box, nest so that no route passes another port's stub or end label, and
  go around boxes corner by corner without two routes sharing a corner.
- **Physical view:** a cable to a device as a whole ends in a hollow square;
  the member ports of an aggregate (LAG, port-channel) are kept together and
  drawn in a bracket named by the aggregate; bending cables go around other
  devices together with their ports and port labels.
- **Pointing marks what belongs together:** an interface's row, port and end
  label and every relation and cable attached to it; for a relation or
  cable, the interfaces at its ends. In the diagram, in the Objects list and
  on the endpoints of the Edit tab, which also marks the two ends of a
  selected relation or link and says which port each is drawn from.
- Example **`port-bindings.yaml`**: several tunnel interfaces and
  subinterfaces per router, three relations on one interface, tunnels
  sourced from an interface and from an address, device-level relations, a
  LAG and a three-device relation.
- Legend entries for interface ports, device-level ports, LAG brackets and
  device-level cable ends.
- Tests: `test/ports.test.mjs` checks for every example, every Auto-arrange
  option, after dragging, with labels off and protocols hidden that every
  lane and cable end lies in the port area of the interface it references,
  that no lane crosses a box and no cable another port, and that end labels
  are beside their port and clear of text and lines; the browser self-test
  repeats this with real fonts, in both themes and on the exported SVG, and
  the viewport check at every window size and zoom.

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
- A **Help** menu next to **Find**. **User Manual** opens a large dialog with a
  short, task-by-task guide to the basic features (opening or creating a
  model, saving and exporting, the Physical and Logical views, finding and
  filtering, selecting and editing, connecting, Auto-arrange, keyboard
  shortcuts), illustrated with screenshots of the application. **License**
  names the license, the Apache License, Version 2.0, and shows its full text.
  Both are embedded in `netatlas.html` and work offline; they close with ×,
  Close or Esc and return the focus to **Help**.
- **Quick actions in the object list:** the row under the pointer shows
  **Duplicate** and **Delete**, the same actions as in the Edit tab (same
  confirmation, undo, selection and modified state). The row with the
  keyboard focus shows them too, and on touch screens the selected row. Their
  accessible names say the action and the object (*Delete device hq-fw*).
- **Dark and Light themes, Dark by default.** A toggle at the right end of
  the toolbar with a tooltip and an accessible name that say the theme in
  effect and what a press does. The choice is remembered in the browser,
  never in the model, and is in effect before the first paint (no flash of
  the other theme); without a stored choice, or without storage, the theme
  is Dark. The whole application and
  the diagram are drawn from one set of design tokens (WCAG 2.2 AA in both
  themes; dark grey surfaces, off-white text, calmer accent and status
  colours); cable and protocol colours are adjusted per theme so every line
  keeps 3:1 contrast.
- **Exports in the selected theme.** PNG and SVG are drawn in the theme on
  screen. The SVG carries resolved colours and an explicit background (no
  stylesheet, CSS variable or `prefers-color-scheme`), so it looks the same in
  every viewer; the PNG has the same colours on an opaque background.
- **Every address in the diagram.** Each device's box holds an entry per
  interface with its name, addresses (IPv4 then IPv6, secondary and dual
  stack together), VLAN, VRF, DHCP, MAC address, tunnel source and
  destination and member ports, in a monospace font and never shortened.
  Membership lines carry every address of the device in the network; cables
  show their cable id; addresses in `attrs` (VRRP / HSRP virtual addresses,
  router IDs, NAT and peer addresses …) are written next to their device,
  interface, network, cable, relation or group. Auto-arrange reserves the
  room they need.
- **No overlaps, or a note when there are.** A label with no free place next
  to its line takes the nearest free place, tied to it by a dashed leader
  line; an overlap made by moving nodes by hand is reported over the diagram.
- The left panel is titled **Objects** (*Select, duplicate, or delete*), a
  region with that name and a heading for assistive technology; the right
  panel is named *Inspector* for screen readers.
- **The selection in the Edit tab.** The part of the configuration that
  belongs to what is selected (in either view or the object list) is marked
  with a tint, an accent bar and a *▸ Selected* tag, and `aria-current`: the
  object's header, the selected interface's card, or the very field of the
  line that was clicked in the diagram (an address, VLAN, VRF, DHCP, MAC,
  tunnel end, member ports, a network's prefix, a cable id, an attribute).
  It is scrolled into view when off screen (smoothly, unless reduced motion
  is preferred), never moves the focus, and follows edits, undo / redo,
  renames and view switches.
- The example **addressing.yaml**: a router with many interfaces, dual-stack
  and secondary addresses, VLAN subinterfaces, tunnels and long IPv6
  addresses.

### Changed

- **Send test runs at once**: a test is sent at the current simulated
  time, in parallel with the traffic on screen, after only its real
  dependencies (ARP / NDP, DNS, a DHCP lease, the TCP handshake). Its
  messages and answers (replies, ICMP errors, RSTs) are always shown,
  whatever the senders and the protocols ticked, take display priority at
  the dot limit, and while the test is on its way it alone sets the pace
  (as Follow message does). Paused, Send sends at the current time and
  the panel says it starts when the simulation plays.
- The logical view's typical hop (what readable pacing scales by) is two
  cables, fixed for the whole simulation, instead of being learned from
  its first 64 hops.

- **The simulation indicator** is a thin solid 2 px border inside the
  diagram (3:1 or more in both themes, `pointer-events: none`) and the
  label *◈ Simulation running*, instead of the hatched frame.
- **One layer scale** for the whole page, as tokens in `:root`: diagram <
  overlays < panels < toolbar < menus / popovers < tooltips < dialogs <
  announcements. Every `z-index` uses it.
- **Supports Layer 3:** a switch's Layer 3 checkbox is now *Supports Layer
  3* (tooltip *Routing, routing protocols, and gateways*). On a Layer 2
  switch the routing protocols are listed disabled in a group *Requires
  Layer 3* with the reason, nothing of Layer 3 is suggested, and relation
  endpoint pickers, the input helpers and the palette follow the same rule.
- **Precedence** has an object level: configured → object → device →
  simulation → default; values show the object they come from.
- The simulated built-in `dhcp` relation is only drawn now (its messages
  come from the DHCP servers of the model).
- A DHCP interface's entry says *DHCP client* (was *DHCP*).
- A device's DNS names: the hint no longer says that no record is created
  (a DNS server's zone answers them).

- **Independent protocol exchanges run in parallel.** The cause of the
  one-after-another display: each session started at its own random moment
  between 0.2 and 1.7 s (and the boot announcements between 0 and 0.9 s),
  and the periodic timers kept those phases; a hop takes about 0.1 ms of
  simulated time, and the readable pacing holds the simulated clock at the
  first arrival on screen, so a message that started more than a hop later
  could only be drawn after that dot arrived, three seconds later. Now
  everything is scheduled by its actual preconditions only: every cable
  comes up after the link-up delay, every session and multicast or
  broadcast protocol starts the moment its interface is up, all together,
  with a seeded jitter of less than a hop (timers too, without drifting);
  unicast waits for its own next hop's ARP; BGP connects the moment there
  is a route to its peer (no more polling every second); what runs over a
  tunnel waits for the tunnel instead of being dropped, a PIM Register for
  a route to the RP, a Join for its RPF route (a wait, no longer *cannot
  join*); BFD for its client session; an aggregate's traffic for LACP to
  bundle a member; a tunnel's own keepalives run over the interface of its
  source. The event log has *waiting* rows with the reason and groups the
  events of one moment; the packet inspector shows a message's *Timing*
  (caused by, waited for). The dot limit and the pacing never change a
  simulated time.
- **The simulation panel is its header and exactly three rows** of the
  status and of the log by default, measured from the rows and headers as
  the theme and zoom make them, and that is its minimum; the panel is never
  taller than the diagram. Remembered under a new key
  (`netatlas.simPanelHeight3`); a double-click resets it. The status has a
  one-line summary like the log's, so both tables start level; the log
  stays at its newest rows when the panel's height changes.

- **Slower default pacing:** about 3 s per hop (2–6 s by relative latency,
  before 1 s, 0.6–3 s), a dot never faster than 70 px a second at 100 %
  zoom, 0.6 s across a switch, the arrival pulse and a lost message's ✕
  1.5 s. Measured in the browser, the configured pacing was applied; the
  dots were fast because the time per hop did not depend on the length of
  the line on screen and was short.
- **The packet inspector pauses only while it is in use:** opening it from a
  dot or a log message pauses; closing it, leaving it (a click or the focus
  elsewhere) or losing sight of it plays again, unless the user paused.
  Follow message plays on beside it.
- **A smaller simulation panel:** about a quarter of the window by default
  (24 %, at least its toolbar and 3½ rows), its height remembered under a
  new key (`netatlas.simPanelHeight`); its table rows are one line each.
- The event log waits for new events while the pointer is on it or the
  keyboard in it, so that a row doesn't move away under a click.


- **Start simulation…** puts the protocols first: open at the top, grouped
  by layer with counts, Select all and Clear per group and for all; the
  Layer 1–4 parameters collapsed below, a collapsed layer saying how many
  of its values are modified (*Layer 3 – Network (8) · 2 modified*, also in
  its accessible name). Start is the primary action, `Enter` starts, `Esc`
  cancels; the focus starts on the first protocol; with the parameters
  collapsed it fits without scrolling at common window sizes, only the
  protocol list scrolls. The choice of protocols is remembered for the
  session, like the parameters.
- The device tables (ARP, MAC, connections, sessions, IGMP, multicast)
  show in the simulation panel instead of floating panels; only the packet
  inspector floats.
- The Objects panel has no subtitle any more (and its region no
  description).
- The Filters ▾ overflow order is Routes, Networks, Groups / Locations,
  Labels; Devices and Device types always stay in the row.
- The simulation's speeds are 0.25×, 0.5×, 1×, 2× and 4× (they now apply
  to the paced display, not the simulated clock).
- The size limit of the built file in the build test is 4 MiB.


- **PIM and IGMP in the simulation** are no longer just the relations'
  messages: the multicast data follows the trees PIM builds (a router
  without an RP for a sparse-mode group joins nothing; the old fallback,
  the PIM router with the highest router ID, is gone: the check
  `multicast-no-rp` reports it). An IGMP relation's `group` is the host's
  join; a demand to a group is a stream.
- **The MAC table** shows only entries learned by the current time (a
  frame's way is decided when it is sent).
- **ARP Requests are labelled by their cast:** *ARP Request (broadcast):
  who has 10.0.0.2?* (a refresh: *(unicast)*); the full *Who has … Tell …*
  is in the event log.
- **The simulation's timing is real:** a message takes its latency and
  serialization time instead of a fixed 0.3 s per cable; the playback slows
  down while a message is on its way so that it can still be followed, and
  the event log shows times to the microsecond. One link at a time is no
  longer the limit, and the in-diagram menu says *Fail link*.
- **Simulate → Start simulation…** replaces the greyed-out placeholder
  *Protocol simulation…*: available with a model when no simulation runs
  (unavailable without one, and while one runs: *A simulation is already
  running*); Exit simulation the other way round. The banner offers
  **Simulation window**.

- The side panel has six tabs: the **Analysis** and **Simulation** tabs are
  gone; their content lives in the tool windows.
- **Static routing is no longer a protocol:** removed from the registry,
  Enable a protocol…, the suggestions and the checks (`static-not-enabled`
  is gone; `protocol-unused` no longer looks at routes). Static routes work
  on every Layer 3+ device whatever it enables; the examples no longer
  write `static: {}`.
- The path tracer and the failure analysis use only the protocols a device
  enables (an adjacency forms between devices that both enable its
  protocol); iBGP or eBGP follows from the two local AS numbers; a VRRP
  gateway's active member is the group with the highest `priority`. The
  diagram writes the router ID and the AS number only where they apply, and
  a group's virtual address in its interface's entry (`VRRP 10 10.10.10.1`).
- Every example enables the protocols its devices run.

- **Address arithmetic** compares addresses and prefixes byte by byte (no
  BigInt) where the routing tables and the simulation call it often.

- **`enterprise-wan.yaml`** routes end to end: the firewall's two router
  ports share a transit VLAN (`vlan5`), the firewall and the core switches
  have transit addresses (so their OSPF adjacencies can form), the servers'
  gateway is a VRRP address, and host routes keep the tunnel endpoints on
  the internet uplinks.

- The examples and fixtures write VLANs on their ports instead of per-end
  network lists; every switch port has its VLANs. Cable labels no longer
  list networks (the port labels carry the VLANs).
- A Problems entry puts the cursor in the field it is about, when that is
  an editable field.
- Making a Layer 3 switch a Layer 2 switch also lists its routed ports
  (they need their VLANs afterwards).
- Logical-view routing: a relation whose route has to go around a box turns
  beyond the end labels of the rows it passes (the stubs are nested again with
  the turn the route really makes).
- The File menu scrolls inside a short window a little earlier, so its last
  example is always reachable.

- **A relation is nested in a tunnel's tube only when both are bound to the
  same interfaces.** GRE on a tunnel interface carried over IPsec between the
  WAN ports is drawn from its own ports, and its label says *(over IPsec)*;
  OSPF on the same tunnel interface as GRE is still drawn inside it.
- A physical interface a relation is bound to has an entry in the logical
  view even without an address (its relations attach to it).
- **Auto-arrange** (all three options) leaves room for ports, stubs and end
  labels: rows with ports are taller, and devices, networks and hubs keep
  their ports' reach apart. Logical diagrams get somewhat larger (8–35 % per
  side for the examples); stored positions don't change, but a view arranged
  with an earlier version shows *edited since arranged* until it is arranged
  again.
- A group's kind (e.g. *SITE*) is kept free of labels, like its title.
- DNS chips are a little higher, so their text stays inside at small zoom.

- The **Find & Filter** menu is now called **Find** (also its tooltip and
  accessible name), to save room in the toolbar. *Find in diagram…* and
  *Filter object list…* are unchanged.
- The dashed frames of the **View**, **Auto-arrange** and **Filters** groups
  are clearly visible: their colour has at least 3:1 contrast against the
  toolbar in the light and the dark theme. Same frame and spacing for all
  three.
- While a dialog is open, the page's one-key shortcuts (P, L, A, C, arrows …)
  no longer act on the page behind it.
- The **View** menu (Find in diagram…, Filter object list…) is now called
  **Find & Filter** (also its tooltip and accessible name), so it isn't
  mistaken for the **View** group of Physical / Logical. Its entries,
  shortcuts and behaviour are unchanged.
- The Find & Filter menu (then called View) says what its entries work on: **Find…** is now **Find in
  diagram…** (`/`), **Filter outline…** is now **Filter object list…** (it
  narrows the model outline; the diagram is not changed). Hover texts, the
  Find bar's accessible name and the outline filter's placeholder follow.
- The File menu says *model* in every entry (New model, Open model…, Save
  model, Save model as…, Close model) and uses "…" exactly where input
  follows; the start screen's card is **Open model…**.
- **Modified** is now a comparison with what was opened or last saved: undo
  back to that state clears it. The file name in the status bar shows a small
  dot and says how the model is saved; no button changes its border colour.
- The *Auto-arrange* label sits above its three buttons, and label and buttons
  share a subtle dashed frame; the label stays visible in a narrow toolbar.
- **View** (Physical, Logical) and **Filters** (Devices, Labels, Groups /
  Locations, Networks, Endpoints, Servers and the Filters drop-down) are
  grouped the same way: a label above the controls, in the same dashed
  frame. In a window 400 px high or less the three labels are hidden (they
  remain the groups' accessible names); the frames stay.
- The Auto-arrange option the view on screen is arranged with is selected and
  disabled; the check mark and edit icons are gone. The state is derived
  from the current positions of the complete or filtered view, and the `A`
  key (Default) follows it.
- The **Edit** tab groups each object's fields into titled cards (Identity,
  Placement, Ends, Cable, Addressing, Protocol, Endpoints, Underlay, Notes,
  More); the **Details** tab shows its sections in the same cards.
- The logical view shows every loopback (there was a limit of three), and
  every address of a loopback (it showed the first one and "+N").
- Chips of uncabled ports show their full names; a long run of similar names
  no longer writes the shared prefix once.
- The logical view shows every DNS name of a device (it showed two and
  "+N more names").
- In the logical view a device's box holds its interfaces and DNS names, and
  lines attach to the whole box. Group titles are drawn above the lines, with
  a halo.
- **Compact** keeps room for the port labels on the facing sides of two
  devices side by side, as **Default** does.
- The number in a multipoint hub is written in the text colour (the ring
  keeps the protocol's colour), and the light theme's muted text, selection
  and line colours are a little darker, for WCAG AA contrast.
- The example *device-types.yaml* has six free ports on its access switch.

### Removed

- The **`gateway`** and **`proxy`** device types (converted by behaviour:
  a VPN Gateway, a router, a System, a Security gateway, a server …), and
  with the proxy its request relaying and its two simulation attributes;
  the Proxy service brings them back as a service of a server, VM or
  container.
- The **hypervisor** as an implied role of a server cabled to VMs (VMs and
  containers are no longer cabled), and the device-level `vm_restart`.
- The **Endpoints** and **Servers** toolbar switches, their overflow
  entries and commands (Device types ▾ replaces them).
- The floating **Simulation window**, its command and the banner's
  *Simulation window* button.


Development features of this version that never were in a release; the
live protocol simulation replaces them.

- **Scenarios:** the `scenarios:` section (now an unknown key), saving,
  playing and stepping through them, the Simulation tab, **Simulate failure
  of selection** (`X`), **Previous / Next step** (`[` `]`).
- **Scenario templates**, **risk groups** (`risk_groups`, now an unknown
  key, and their Edit-tab fields), planned maintenance (`maintain`) and the
  `group` / `risk` step targets.
- The **traffic animation** of scenario steps (the flows themselves,
  `src/analysis/traffic.ts`, stay for the protocol simulation).
- The **Analysis** side tab (the path tracer and the single points of
  failure are tool windows now).

### Fixed

- **Test messages were delayed.** A test sent while many dots were on
  screen was not drawn at all (beyond the 48-dot limit, or from a sender or
  protocol not chosen); hops that are not drawn do not hold the simulated
  clock, so the simulation ran through the test unseen (idle skipping
  jumped past it too) and only its result appeared. A drawn test's next hop
  could only be processed once every message on screen that arrived
  earlier in simulated time had reached its end on screen, seconds later.
- **The first packets moved faster than later ones.** The display clock
  took its reference when the animation was scheduled, before the
  simulation layout was set up, so the first frame counted the setup time
  (up to 250 ms, and a negative step before it); the hops on screen jumped
  ahead. In the logical view the typical hop was still being learned
  during the startup burst, so the first hops were paced on another
  scale. The clock now starts with the first frame drawn, a frame counts
  at most 100 ms, and the typical hop is fixed.
- **The "Editing is paused" notice stayed after Exit simulation**, with a
  greyed-out Exit simulation button, a read-only form and the outline's
  Add buttons disabled: stopping the simulation brought the Inspector back
  while the editing lock was still set (it was cleared just after, and
  nothing drew the Inspector again). The lock is now cleared first, and the
  notice is shown only while a simulation runs.

- **Menus behind the simulation frame.** The top bar's menus (and the
  palette, the in-diagram menu and the packet inspector) could appear
  behind the simulation frame and the simulation panel's splitter: the top
  bar, the canvas and the panel are container-query containers, and
  `container-type` makes each a stacking context, so a menu's z-index only
  counted inside the top bar, which came before the canvas in the page.
  The regions now have explicit layers on the new scale.
- The Find bar's results were covered by the side panel at narrow widths.
- A click on a checkbox in the Edit tab was lost when a field was still
  being typed in (the commit re-rendered the form), or right after a button
  whose own click had landed elsewhere.
- A scripted or stale choice could enable a routing protocol on a Layer 2
  switch.
- A broadcast domain counted a cable whose far end the spanning tree
  blocks.
- Skipping idle time could run hours ahead on a slow machine: an idle jump
  cut short by its work budget started a new jump the next frame instead of
  going on to the same end, so it never rested. It now goes on, and rests.

- A jump over idle time could do minutes of work in one frame when most
  messages were hidden; it now does at most 25 ms per frame.
- Messages that were not shown (another view, a hidden protocol) took
  places of the 48-dot limit.


- `Esc` on the Devices ▾ button (not only inside its list) closes the list.
- A collapsed parameter section's fields were laid out (though hidden) and
  could make the Start dialog scroll.


- In a narrow toolbar, switching off a filter that sits in the **Filters**
  drop-down could move the filter group to another row, after which the
  button no longer counted it (*Filters · 1 off*). The group now keeps room
  for the button's longest label, and the row settles in one pass.
- Physical view: a port's VLAN line no longer overlaps the name of the
  port below it or the title of a group (the rows and frames keep room for
  it), the ⚠ of a cable whose ports differ is
  kept clear of other labels, and a cable no longer runs through a device
  when its way around starts at another port of that device.
- In the **View** and **Auto-arrange** groups, a hovered or keyboard-focused
  segment lost part of its border (e.g. the right edge of *Default*): the
  next segment, which shares that border column, was drawn over it. A
  segment whose border changes is now drawn above its neighbours, in every
  state and at every zoom.
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

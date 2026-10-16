# netatlas YAML format (version 1)

This document is the contract of **NetAtlas YAML model format version 1**,
the only model format NetAtlas supports. Every file declares it with
`netatlas: 1`; a missing line or any other value is an error. The model
format version is independent of the application version: NetAtlas 0.1.2 is
an application release, and it reads and writes model format 1.

A netatlas file describes **one** network architecture. It separates two
things that are often mixed up in diagrams:

| Concept | Section | Drawn in | Meaning |
|---|---|---|---|
| Physical connectivity | `links` | Physical view | A real cable / radio link between two ports (what each port carries is configured on the port) |
| Logical relationships | `relations` | Logical view | Protocol sessions, tunnels, overlays, redundancy groups, service dependencies |
| IP networks | `networks` | Logical view | One IP prefix each, optionally with the VLAN it lives in. Members are derived from addresses. |
| Static routes | `routes` of a device | Logical view | Destination prefix and next hop, per device and VRF |
| Locations | `groups` | Physical view | Sites, buildings, floors, rooms, racks, providers (nestable) |

A tunnel is **never** a `link`. It is a `relation` whose `over:` field says what
it rides on (cables, networks, or other relations), for example GRE over IPsec
over two internet uplinks.

The file must use the [supported YAML subset](YAML-SUBSET.md).

```yaml
netatlas: 1            # required format version
title: My network      # optional
description: |         # optional
  Free text.
protocols: [...]       # optional: define or restyle protocols
groups: [...]
devices: [...]
links: [...]
networks: [...]
relations: [...]
demands: [...]         # optional: traffic demands (traced; never change the network)
checks: {...}          # optional: switch consistency checks off or change their severity
```

Unknown keys are errors (with "did you mean …?" suggestions), so typos never
silently disappear. That includes `scenarios:` and `risk_groups:`, which
earlier development versions had: the protocol simulation replaces the
scenarios, and a file that still has them gets them reported; delete
them. Put any custom data under `attrs:`; it is shown in the
details panel.

## Configure once, derive elsewhere

Every fact has **one** authoritative place in the file. Everything else that
shows it is computed from there, is read-only in the editor (marked
*derived*), updates as soon as its source changes, and is **never written to
the YAML file**.

| Fact | Configured in (authoritative) | Derived, read-only |
|---|---|---|
| Which devices belong to a network | the network's `cidr` and the `ip` addresses of interfaces and loopbacks (an interface with `dhcp: true` has none, so it is in no network) | the network's member list (details, editor, membership lines in the logical view, selection context, layout) |
| The VLAN of an IP network | `vlan` on the network | the VLAN shown for each interface address inside that network |
| The VLANs a port carries | `vlans` and `native` on the port, or on its aggregate (one VLAN: access; several: trunk); `routed: true` on a Layer 3 switch's routed port | its mode (access / trunk / routed) and badge, the port's diagram tag, the networks a cable carries (the networks of its ports' VLANs), the "VLANs differ" mark, the cables listed with a network, the VLAN checks |
| Speed and medium of a physical connection | `speed` and `medium` on the link | cable width, colour and label |
| The VRF of an interface | `vrf` on the interface | — |
| The member ports of a bond / aggregate | `members` on the virtual interface | highlighting of the ports and their cables |
| The VLAN of a VLAN interface | `vlan` on the virtual interface, or (when that is left out) the `vlan` of the network containing its address | — |
| Which ports a VLAN interface uses | the `vlans` of the device's ports and aggregates (nothing on the interface) | *Bridge ports* of the VLAN interface (every port of its VLAN, by mode), its highlighting |
| What a relation depends on | `over` on the relation (links, relations or networks) | highlighting of the underlay path |
| The interface a tunnel is sourced from, when its source is written as an address | the `ip` of the interface that has the address | the tunnel's source interface (highlighting, details) |
| Where a static route leads | `routes` on the device (`via`, `interface`) and the `ip` of interfaces | the interface its next hop belongs to, how the next hop resolves, the next-hop line in the logical view |

Three facts about networks are easy to confuse and are deliberately separate;
none is derived from another:

* **Membership** (IP containment, *derived*): a device is a member of a
  network when a configured address of one of its interfaces lies inside the
  network's prefix. It says nothing about cables.
* **Port VLANs** (layer-2 carriage, *configured* per port): `vlans` and
  `native` on a port (or its aggregate) say which VLANs *that port* carries,
  untagged or tagged. The networks a cable carries follow from its two
  ports: the networks whose `vlan` is one of their VLANs. A port's VLANs
  don't make anyone a member and aren't derived from addresses. The two
  ends of a cable are independent.
* **Relation underlay** (dependency, *configured*): `over` on a relation
  says what the relation rides on — links, other relations or networks.

And separately: **`vlan` on a network** says which VLAN an IP subnet lives
in. It answers "which VLAN is 10.10.10.0/24?" and gives interfaces with an
address in the subnet their (derived) VLAN. VLANs are referenced by their ID
everywhere: on a network, on a VLAN interface and on a port. There is no
separate list of VLANs; a VLAN *exists in the model* when a network or a VLAN
interface names it.

## Identifiers

* Every entity in `groups`, `devices`, `links`, `networks` and `relations`
  has an `id`. **Ids are unique across all of these sections**, so a reference
  such as `over: x` is never ambiguous.
* Ids: 1–64 characters from `A–Z a–z 0–9 _ . -`, starting with a letter or
  digit. `:` is reserved.
* Interface ids are unique **within their device** and may also contain `/`
  (`ge-0/0/1`, `Ethernet1/49`). Physical and logical interfaces share that
  one set of ids, so `device:interface` names exactly one interface,
  whichever list it is in.
* Ids are the stable keys of the model. Labels can change freely.

## Endpoint references

Links and relation endpoints refer to devices or interfaces:

```yaml
- r1                      # a device
- r1:ge-0/0/1             # an interface of a device, physical or logical
                          # (quote it inside [ ] or { } if you like)
- {device: r1, interface: ge-0/0/1}   # the same, as a mapping
```

A **relation endpoint** is a device or one of its interfaces, nothing else:
as a mapping it accepts only `device` and `interface`. Anything that
describes an endpoint's part in the relation (a role, an address, an AS
number …) goes into the relation's `attrs`. A **link end** written as a
mapping accepts `device`, `interface` and the port settings `speed` and
`duplex` (see [Port settings](#port-settings-on-a-link-end)); what a port
carries is configured on the port (see [Port VLANs](#port-vlans-access-trunk-routed)). A link end can
only name a physical interface; a relation endpoint can name any interface.

**An endpoint binds its relation or link to what it names.** The diagrams
draw it from there and from nowhere else: a relation endpoint
`r1:Tunnel10` is drawn from the port of `Tunnel10` (beside that interface's
row in `r1`'s box in the logical view), a link end `r1:ge-0/0/1` ends at the
port `ge-0/0/1`, and an endpoint that names only the device (`r1`) is drawn
from the device as a whole (its device-level port beside its name, or a
hollow cable end). The interface is found by its id, never by a position.
An endpoint that names an interface the device doesn't have is an error at
that endpoint, and nothing is attached in its place. A relation with more
than one endpoint on the same device is bound by the first of them.

## `groups`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name (defaults to the id) |
| `kind` | | Free text, e.g. `site`, `building`, `floor`, `room`, `rack`, `provider`, `cloud`, `zone`. There is no default: a group without a kind is drawn as a plain box. `site`/`campus`/`building`/`datacenter`/`region` are emphasised; `provider`/`cloud`/`external` are drawn dashed. The kind is shown in the group's title bar and in the legend. A public cloud has three kinds of its own: `cloud_region`, `vpc` and `vnet` (see [Public cloud](#public-cloud-regions-vpcs-and-vnets)). |
| `provider` | | A cloud group's (`cloud_region`, `vpc`, `vnet`) provider: `aws`, `azure`, `gcp`, `oci` or any other name. Drawn with the kind ("VPC · AWS"). An error on any other group. |
| `parent` | | Id of the enclosing group (at most 8 levels) |
| `description`, `attrs` | | |

## `devices`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name. Drawn in full: long labels wrap, and line breaks in the label are kept (see [Sizes, labels and routes](#sizes-labels-and-routes)). |
| `type` | | One of the [device types](#device-types) below, written exactly as listed (lower case). Any other value is an error. Without a type the device gets a generic icon. |
| `kind`, `kind_label` | | Optional: what kind of its type it is ([kinds](#kinds)), e.g. `kind: ngfw` on a firewall, `kind: plc` on an endpoint. Every type offers `other`, which needs its name in `kind_label` ("Fiber modem"). Some kinds have an icon of their own. |
| `role` | | Optional: its role in the network, one of the [suggested roles](#roles) (`core`, `access`, `spine`, `leaf`, `border` …) or a name of your own. Auto-arrange puts a known role in its row; Find and the command palette find devices by role. |
| `mode` | | Firewalls (`routed`, `transparent`), IDS/IPS (`inline`, `passive`) and access points (`standalone`, `controller`) only: how it works ([modes](#modes)). Not written: the first. |
| `purpose` | Systems: yes | What a System does: `host`, `l2_forwarder`, `l3_forwarder`, `inline`, `passive_monitor`, `pass_through` or `external_network` ([System purposes](#system-purposes)). Required on a System, an error on any other type. |
| `icon` | | Systems only: one of its purpose's icons (`console`, `protocol_gateway`, `tap` …). Not written: the purpose's first. |
| `host` | VMs and containers: yes | A **guest's host**: the device it runs on — for a VM a server with the Hypervisor service, for a container a server or a VM with the Container engine service. Required on a VM or a container (except a [cloud instance](#public-cloud-regions-vpcs-and-vnets)), an error on any other type. See [Virtualization](#virtualization-hypervisors-vms-and-containers). |
| `layer3` | | Switches and VMs only: `layer3: true` makes a switch a **Layer 3 switch** (a VM a virtual router or firewall), with the full Layer 3+ feature set (routing protocols, a router ID, addresses on several interfaces, VRRP / HSRP groups, tunnels, VRFs). Without it a switch is a **Layer 2 switch** (see [Layer 2 and Layer 3 switches](#layer-2-and-layer-3-switches)). On any other type it is an error. |
| `group` | | Id of the group the device is located in. A guest (VM or container) has none of its own: it is where its host is, and `group` on it is an error — except a cloud instance, which is in its cloud group. |
| `tier` | | 0–9: vertical row in the physical view (0 = top). By default this comes from the device's role, else from what it does (see [Roles](#roles)). Set it to place a device elsewhere. |
| `guest_os`, `vcpu`, `ram` | | VMs only, optional: the guest operating system (text), its virtual CPUs (a whole number) and its memory (`8G`, `512M`). The host's inventory (`cpu`, `ram`) counts them. |
| `image` | | Containers only, optional: the image it runs (`nginx:1.27`). |
| `router_id` | | The router ID the device's protocols share: the id of one of its **loopbacks** (`lo0`: its IPv4 address is used) or an **IPv4 address** without a prefix length (`10.255.0.1`). Applies only while an enabled protocol uses a router ID (OSPF, BGP, EIGRP, LDP); otherwise it is reported as not applicable. See [Routing services](#routing-services-protocols). |
| `simulation` | | The device's **simulation attributes** (the device-level ones, and defaults for its objects where an attribute allows it), for the [protocol simulation](#simulation-parameters-and-device-attributes): only what it overrides, e.g. `simulation: {arp_timeout: 300, spf_delay: 50ms, boot_time: 2min}`. Everything else it inherits from the simulation's values or the defaults. |
| `protocols` | | The **routing services** the device runs, with their parameters: `protocols: {bgp: {asn: 65001}, ospf: {}}`. Layer 3+ devices only (a switch with `layer3: true`). See [Routing services](#routing-services-protocols). |
| `description`, `attrs` | | |
| `interfaces` | | List of the device's **physical interfaces** (its ports, below). The shorthand `interfaces: [eth0, eth1]` is allowed. |
| `logical_interfaces` | | List of the device's **logical interfaces** (below): loopbacks, virtual interfaces and tunnel interfaces; a VM's virtual NICs (`vnic`) and a container's network attachments (`veth`). |
| `dns_names` | | List of the device's **DNS names**, each associated with one or more of its interfaces. See [DNS names](#dns-names). |
| `dns_servers` | | The DNS servers the device asks (a list of addresses), when they are not given by a DHCP lease. See [DNS servers of a host](#dns-servers-of-a-host-dns_servers). |
| `services` | | The **services** the device runs, by the [service registry](#services-the-registry-and-its-catalog): `services: {dhcp: {…}, ntp: {…}, wireless: {…}}`. Who may run which is the registry's (with the reason when a device may not); the built-in functions of the appliances are written here too: a VPN gateway's `vpn`, a Security gateway's `separation`, an access point's `wireless` (required), a load balancer's `load_balancing` and an IDS/IPS's `inspection` (optional). See also [Network services](#network-services-services-dhcp-and-dns-servers), [Virtualization](#virtualization-hypervisors-vms-and-containers), [VPN gateway](#vpn-gateway), [Security gateway](#security-gateway) and [Wireless access](#wireless-access-wi-fi-networks-on-vlans). |
| `port_pairs` | inline and pass-through devices: yes | The pairs of ports traffic passes between: `port_pairs: [{a: in, b: out}]`, with `direction: a_to_b` for one way and `copy: [mon]` for monitor ports that get a copy. See [Port pairs](#port-pairs). |
| `management` | | The device's management interfaces (`management: [mgmt0]`): never forwarded, in no domain. Firewalls, IDS/IPS, Security gateways and passive monitors. See [Management interfaces](#management-interfaces). |
| `routes` | | List of the device's **static routes**. See [Static routes](#static-routes). Only devices whose type has a routing table may have them. |

A device has no `vendor`, `model` or `mgmt` key; like every key the
format doesn't define, each is an error ("unknown key"). Such facts can be
kept as free-form `attrs`, which are shown in the details only. A device has
no `asn` either: the AS number is BGP's parameter (`protocols: {bgp: {asn:
65001}}`), and `asn` on the device is reported as an unknown key that names
where it belongs.

### Routing services (`protocols`)

A Layer 3+ device (router, Layer 3 switch or VM, routed firewall, load
balancer, VPN gateway, a System that is a Layer 3 forwarder: what
[can run routing protocols](#capabilities)) lists the
protocols it runs under `protocols:`, each with its parameters. A protocol
without parameters is enabled with an empty mapping. Static routes are not
a protocol: a device's [`routes`](#static-routes) are always in effect, and
`static` under `protocols:` is reported like any other unknown protocol:

```yaml
- id: hq-rtr1
  type: router
  router_id: lo0                # shared by the protocols that use a router ID
  protocols:
    bfd: {}
    bgp: {asn: 65010}           # the local AS number is mandatory
    ospf: {}                    # OSPF requires a router ID: the device's, or its own
  logical_interfaces:
    - {id: lo0, type: loopback, ip: 10.255.0.1/32}
```

What each protocol has is defined by a registry (the built-in protocols
below; a protocol of the model's [`protocols:` section](#protocols-defining-new-protocols)
can declare its own). A parameter is written in one of three places, its
**scope**:

* `device`: in the device's block: `protocols: {bgp: {asn: 65010}}`;
* `interface`: in an interface's own `protocols:` block, for what applies
  per interface; the device must enable the protocol:
  `protocols: {vrrp: {group: 10, virtual_ip: 10.10.10.1, priority: 200}}`;
* `endpoint`: in the `attrs` of the protocol's relations, per endpoint
  device (`area: {r1: 0, r2: 0}`) or one value for both ends (`area: 0`).
  See [protocol-specific attributes](#protocol-specific-attributes).

| Protocol | Device parameters | Interface parameters | Endpoint parameters (relation `attrs`) | Router ID |
|---|---|---|---|---|
| `bgp` | **`asn`** (1–4294967295) | | `peer-as`, `distance` | optional |
| `ospf` | `process` (1–65535) | | `area`, `network-type`, `hello`, `dead`, `cost`, `distance` | **required** |
| `isis` | **`net`** (a NET: `49.0001.1921.6800.1001.00`), `level` (`level-1`, `level-2`, `level-1-2`) | | `cost`, `distance` | |
| `eigrp` | **`asn`** (1–65535) | | `cost`, `distance` | optional |
| `rip` | `version` (`1`, `2`, `ng`) | | `distance` | |
| `ldp` | | | | optional |
| `pim` | `mode` (`sparse`, `dense`, `ssm`); `rp` (the static rendezvous point, an address); `candidate_rp`, `candidate_bsr` (`yes`, `no`) | | `rp` (a relation's, as before) | |
| `bfd` | | | `interval`, `multiplier` | |
| `vrrp`, `hsrp`, `glbp`, `carp` | | **`group`**, **`virtual_ip`**, `virtual_ipv6`, `priority` | | |

Bold: mandatory once the protocol is enabled. Rules:

* **Mandatory parameters** are errors until they are written: nothing is
  chosen for the user. OSPF without a router ID (neither the device's nor
  its own) is an error.
* **Router ID.** The device's `router_id` is shared by its protocols that
  use one; a protocol may write its own `router_id` in its block instead
  (`ospf: {router_id: 10.255.9.9}`). A router ID is an IPv4 address or the id
  of a loopback of the device that has an IPv4 address. Without an enabled
  protocol that uses a router ID, `router_id` is **not applicable** (a
  warning). A protocol that uses none has no `router_id` key.
* **AS number** only with BGP (or EIGRP's own): the device has no `asn` key.
* **Layer 3+ only**: `protocols:` on another device type is an error.
* **Unknown** protocols and parameters, and parameters written in the wrong
  scope, are errors that say where they belong.
* Values are checked by their type: whole numbers in their range, IPv4 and
  IP addresses, a list of allowed values, OSPF areas (a number or a dotted
  id), NETs.

The [consistency checks](#consistency-checks) read the AS numbers and router
IDs from the enabled protocols (iBGP or eBGP follows from the two local AS
numbers; duplicate router IDs are looked for per protocol domain) and
report a protocol that a device's relations use but that it does not
enable, and one enabled but used by no relation. The path tracer and the
failure analysis use only the protocols a device enables: a routing
adjacency forms only between devices that both enable its protocol. The
diagram writes the router ID and the AS number only where they apply.

### Device types

| Display name | `type` | Kinds (`kind`) | Modes (`mode`) | What it does |
|---|---|---|---|---|
| Router | `router` | `router`, `cpe`, `sd_wan`, `cloud_gateway`★, `other` | | routes between its interfaces |
| Switch | `switch` | `campus`, `data_center`, `industrial`, `other` | | bridges by VLAN; with `layer3: true` also routes |
| Firewall | `firewall` | `ngfw`, `utm`, `cloud_firewall`, `other` | `routed`, `transparent` | routes with its policy; transparent: bridges its data ports with its policy |
| Access point | `ap` | `indoor`, `outdoor`, `mesh`, `bridge`, `other` | `standalone`, `controller` | bridges its wireless side to its wired side (Wireless access) |
| Load balancer | `load_balancer` | `hardware`, `virtual`, `other` | | routes; ends client connections and passes them to its pool |
| IDS/IPS | `ids_ips` | `appliance`, `virtual`, `other` | `inline`, `passive` | inline: passes traffic between its paired ports, may drop it; passive: receives copies, forwards nothing |
| VPN gateway | `vpn_gateway` | `hardware`, `virtual`, `remote_access`, `other` | | ends its VPNs; forwards only to and from them |
| Security gateway | `security_gateway` | `cross_domain`, `red_black`, `it_ot`, `other` | | transfers between exactly two domains only what its policy permits, the way its implementation does it |
| Server | `server` | `physical`, `appliance`, `other` | | a host; may run DHCP, DNS, a hypervisor, a container engine |
| Virtual machine | `vm` | `general`, `virtual_appliance`, `other` | | a guest of a hypervisor (or a cloud instance); with `layer3: true` routes |
| Container | `container` | `application`, `infrastructure`, `other` | | a guest of a container engine (or a cloud instance) |
| Storage | `storage` | `nas`, `san`, `backup`, `other` | | a host |
| Endpoint | `endpoint` | `pc`, `mobile`★, `printer`★, `camera`★, `voip`★, `iot`★, `media`★, `plc`★, `hmi`★, `other` | | a host; sends test traffic |
| Cloud | `cloud` | `internet`, `carrier`, `mpls`, `mobile`★, `other` | | an external network crossed as one opaque Layer 3 hop |
| System | `system` | `other` | | what its [purpose](#system-purposes) says (required) |
| *(no type)* | | | | unknown: drawn generic, routes nothing |

★ the kind has an icon of its own. Every type has its own icon; the display
name (with the switch's layer, the mode, a System's purpose and the kind:
"Firewall · Transparent · NGFW") appears in the diagram subtitle, the
details, tooltips, the legend and the editor. The error for any other value
suggests the closest type (`Router` → `router`, `load-balancer` →
`load_balancer`) or lists all of them.

There is no generic gateway and no proxy type any more. What was written as
one is converted by what it does: a VPN gateway becomes a **VPN gateway**
(`vpn_gateway`, with its VPN gateway function); a NAT gateway a **router**; a
public cloud's gateway a **router** of kind `cloud_gateway` in its cloud
group; a protocol or OT gateway a **System** with its purpose (usually
`l3_forwarder`), unless it is a cross-domain boundary, which is a
**Security gateway**; a forward or reverse proxy a **server**, **VM** or
**container** (the Proxy service comes with the service registry). The
values `gateway`, `proxy` and `hypervisor` are unknown types whose errors
say so. There is no hypervisor type either: a hypervisor is a **server with
the Hypervisor service** (see [Virtualization](#virtualization-hypervisors-vms-and-containers)).

#### Kinds

A kind is optional and says what kind of its type a device is: a firewall's
`ngfw`, a switch's `industrial`, an endpoint's `plc`. It changes nothing a
device does (that is its type's, its mode's and its purpose's); some kinds
have an icon of their own. Every type offers `other` with a name of your own
in `kind_label` (required with it, an error without it):

```yaml
- id: modem
  type: router
  kind: other
  kind_label: Fiber modem
```

The legend lists the types and kinds the model uses.

#### Roles

A device's `role` is its role in the network. The suggested roles, with the
row Auto-arrange gives them (0 = top):

| `role` | Name | Row |
|---|---|---|
| `border` | Border / Edge | 1 |
| `wan_edge` | WAN edge | 1 |
| `pe`, `ce`, `p` | PE, CE, P | 1 |
| `dmz` | DMZ | 2 |
| `core`, `spine` | Core, Spine | 3 |
| `distribution`, `leaf` | Distribution, Leaf | 4 |
| `access` | Access | 5 |
| `management` | Management / OOB | 6 |

Any other role of your own is allowed (letters, digits, spaces, `- _ . /`).
Without a known role a device's row follows from what it does: external
networks on top (0), then routers (1), policy, inline and separation devices
(2), switches and pass-through devices (4), wireless access (5), hosts,
guests and passive monitors (6); a device without a type sits with the
switches. An unknown custom role takes that row too, so the layout stays
deterministic. `tier` overrides both. Find and the command palette find a
device by its role ("core", "role spine").

#### Modes

A firewall is `routed` (the default: it routes and applies its policy to
what it forwards) or `transparent` (it bridges its data ports and applies
its policy to what passes; its data ports have no addresses, a
[management interface](#management-interfaces) may). An IDS/IPS is `inline`
(the default: traffic passes through it between its
[paired ports](#port-pairs), and it may drop what it inspects) or `passive`
(it receives copies, from a TAP or a SPAN port, and never forwards
anything). An access point is `standalone` or `controller`-managed.

#### System purposes

A System says what it does in `purpose` (required: a System without one is
an error, and does nothing):

| `purpose` | Name | What it does | Icons (`icon`) |
|---|---|---|---|
| `host` | Host | sends and receives, forwards nothing (a console server, a controller appliance, a building management system) | `system`, `console`, `controller` |
| `l2_forwarder` | Layer 2 forwarder | bridges its ports, by VLAN where its ports have VLANs (a media converter, an industrial bridge, a point-to-point radio) | `bridge`, `radio`, `converter` |
| `l3_forwarder` | Layer 3 forwarder | routes; may run routing protocols (a protocol gateway, a routed WAN optimizer) | `protocol_gateway`, `router` |
| `inline` | Inline | passes traffic between its paired ports, may delay or drop it, one way if a pair says so (a WAN optimizer, an inline encryptor, a simplified data diode) | `inline`, `diode` |
| `passive_monitor` | Passive monitor | receives copies, forwards nothing (a sensor, a monitoring probe) | `sensor` |
| `pass_through` | Pass-through | joins its paired ports physically, without an IP stack (a patch panel, a splice, a passive optical part, a TAP) | `patch`, `tap` |
| `external_network` | External network | an opaque transit, crossed as one hop (a private carrier, a partner network) | `cloud` |

Its `kind_label` names what it is ("Industrial protocol gateway"), its
`icon` is one of its purpose's (the first when not written). A security
boundary between domains is a [Security gateway](#security-gateway),
not a System.

A **TAP** or packet broker is modelled with both of its paths: the original
traffic passes between a port pair, and the copy leaves by the pair's
`copy` ports, to a passive monitor. A receive-only passive monitor is not a
TAP: without a through path and a copy, nothing passes it.

#### Capabilities

Every module (validation, the editor, Connect, the Layer 3+ rules, the path
tracer, single points of failure, the simulation, Auto-arrange and the
helpers) decides by what a device **can do**, never by its type's name.
One resolver (`src/model/capabilities.ts`) derives it from the type, the
mode, Supports Layer 3, a System's purpose and a Security gateway's
implementation; an architecture test fails on any comparison with a type
name outside the registry and the resolver. A capability is what a device
can do, not connectivity: what actually passes still depends on its
interfaces, cables, VLANs, routes and policy.

<!-- capability-matrix:begin (generated by scripts/capability-matrix.mjs) -->
| Device | host | L2 forward | L3 forward | policy | inline (pairs) | passive copy | pass-through | external transit | hosts guests | is a guest | VPN | separation | session break | routing protocols | management ifaces |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Router |  |  | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |  |
| Switch |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Switch · Supports Layer 3 |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |  |
| Firewall · Routed |  |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  | ✓ | ✓ |
| Firewall · Transparent |  | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |
| Access point · Standalone |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Access point · Controller-managed |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Load balancer |  |  | ✓ |  |  |  |  |  |  |  |  |  | ✓ | ✓ |  |
| IDS/IPS · Inline |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |  | ✓ |
| IDS/IPS · Passive |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  | ✓ |
| VPN gateway |  |  | ✓ |  |  |  |  |  |  |  | terminates; only via its VPN |  |  | ✓ |  |
| Security gateway (no implementation yet) |  |  |  | ✓ |  |  |  |  |  |  |  | none yet |  |  | ✓ |
| Security gateway · filtering bridge |  | ✓ |  | ✓ |  |  |  |  |  |  |  | filtering bridge |  |  | ✓ |
| Security gateway · filtering router |  |  | ✓ | ✓ |  |  |  |  |  |  |  | filtering router |  |  | ✓ |
| Security gateway · protocol break |  |  |  | ✓ |  |  |  |  |  |  |  | protocol break | ✓ |  | ✓ |
| Server | ✓ |  |  |  |  |  |  |  | VMs, containers |  |  |  |  |  |  |
| Virtual machine | ✓ |  |  |  |  |  |  |  | containers | vm |  |  |  |  |  |
| Virtual machine · Supports Layer 3 |  |  | ✓ |  |  |  |  |  | containers | vm |  |  |  | ✓ |  |
| Container | ✓ |  |  |  |  |  |  |  |  | container |  |  |  |  |  |
| Storage | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Endpoint | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Cloud |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |
| System · Host | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| System · Layer 2 forwarder |  | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| System · Layer 3 forwarder |  |  | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |  |
| System · Inline |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |  |  |
| System · Passive monitor |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  | ✓ |
| System · Pass-through |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| System · External network |  |  |  |  |  |  |  | ✓ |  |  |  |  |  |  |  |
<!-- capability-matrix:end -->

*host*: an end system with an IP stack that forwards nothing; *L2/L3
forward*: bridges / routes between its interfaces; *policy*: applies a
policy to what it forwards; *inline*: passes traffic only between paired
ports; *passive copy*: receives copies only; *pass-through*: joins paired
ports without an IP stack; *external transit*: an opaque network crossed as
one hop; *session break*: ends connections and starts its own (a load
balancer, a protocol break); *routing protocols*: may run OSPF, BGP and the
others.

#### Port pairs

An inline device (an inline IDS/IPS, an inline System) and a pass-through
System pass traffic only between paired ports; `port_pairs` is required on
them and an error elsewhere:

```yaml
port_pairs:
  - {a: net-a, b: net-b, copy: [mon]}     # both ways; a copy of what passes to mon
  - {a: in2, b: out2, direction: a_to_b}  # one way: from in2 to out2 only
```

`a` and `b` are two different physical interfaces of the device, each in
one pair; `copy` lists monitor ports that get a copy of what passes and send
nothing back. The tracer and the simulation keep to the pairs (a frame from
an unpaired port, or from `b` of a one-way pair, ends there, and says so);
a TAP's copy is noted on the trace and arrives at the monitor in the
simulation. The physical view writes "pair 1", "copy of pair 1" under the
ports.

#### Management interfaces

`management` lists a device's management interfaces: they are its own (an
address, SSH, SNMP), never forwarded, in no domain and in no port pair.
Firewalls, IDS/IPS, Security gateways and passive monitors may have
them; a transparent firewall's and a filtering bridge's management
interface is the only one with an address. The physical view writes
"management" under the port.

#### VPN gateway

A VPN gateway (`vpn_gateway`) ends VPNs. Its **VPN gateway** function is
built in and required (`services: {vpn: …}`); nothing of it is chosen for
you:

| Key | Required | Description |
|---|---|---|
| `operation` | yes | `site_to_site` (tunnels to fixed peers) or `remote_access` (clients connect to it) |
| `technology` | yes | `ipsec` (IKEv2), `wireguard` or `openvpn`; any other is reported as not supported |
| `tunnels` | site to site | its tunnel interfaces (logical interfaces of type `tunnel`), each with its `source` (the local end) and `destination` (the peer) |
| `listener` | remote access | the interface its clients connect to (with an address) |
| `pool` | remote access | the clients' addresses, a prefix (`10.250.0.0/24`); no fixed peer |
| `protected` | yes | the networks behind it its VPN reaches: network ids or prefixes |

The keys of the other operation are errors. A VPN gateway **forwards only
to and from its VPN**: traffic in or out of one of its tunnels, or to and
from its remote-access pool; anything else between its interfaces is
refused, in the path tracer and in the simulation ("hq-vpn is a VPN
Gateway: it forwards only to and from its VPN"). Its tunnels behave as any
tunnel does (IKE, ESP, the encapsulation, the underlay and the
decapsulation in the trace and the simulation). A VPN is not a separation:
it protects traffic on its way, it does not decide what may cross between
domains.

#### Security gateway

A Security gateway (`security_gateway`) is a security boundary between
**exactly two domains**: it transfers only what its policy explicitly
permits, the way its implementation does it. Its **Domain separation** is
built in and required (`services: {separation: …}`), and exists on no other
device. NetAtlas models how such a boundary behaves; it does not reproduce
a particular product or give any assurance of a real device's separation.

```yaml
services:
  separation:
    implementation: protocol_break
    domains:
      - {name: Red, interfaces: [red0]}
      - {name: Black, interfaces: [black0]}
    directions:
      - {from: Red, to: Black}
    profiles:
      - id: web
        type: https
        listen: {interface: red0, port: 443}
        forward: {address: 10.20.0.80, port: 443}
    rules:
      - id: red-web
        description: Red workstations may fetch from the Black web server
        from: Red
        to: Black
        source: 10.10.0.0/24
        destination: 10.20.0.80
        protocol: tcp
        ports: "443"
        profile: web
management: [mgmt0]
```

| Key | Required | Description |
|---|---|---|
| `implementation` | yes, no default | `filtering_bridge`: passes the permitted frames between its domains unchanged (both domains share their networks; no address in them). `filtering_router`: routes the permitted packets (each domain its own network, the gateway an address in each). `protocol_break`: nothing passes through; a permitted transfer ends at the gateway and the gateway starts a new one of its own on the other side. |
| `domains` | yes | exactly two, each with its `name` and its data `interfaces`. Any names: `Red`/`Black` are suggestions only (as are `HIGH`/`LOW`, `IT`/`OT`); NetAtlas reads no classification, trust, encryption or direction from a name or colour. An interface is in one domain at most; a management interface in none. |
| `directions` | yes | the permitted directions of transfer: `{from: A, to: B}`, one or both |
| `rules` | | the allow rules, in order (an empty list permits nothing) |
| `profiles` | protocol breaks | the transfer profiles a protocol break can model |
| `simulation` | | `transfer_delay`, `transfer_loss` (the gateway's own delay and loss per permitted transfer) |

A rule has a stable `id`, an optional `description`, its domains (`from`,
`to`), its `source` and `destination` (an address, a prefix, or `any`),
its `protocol` (`tcp`, `udp`, `icmp` or `any`), its destination `ports`
(tcp and udp: `"443"`, `"80, 443"`, `"8000-8080"` or `any`) and, in a
protocol break, its `profile`. **Every match is written**: an empty field is
an error, never "any"; a broad match is written `any`.

How the policy decides (the same in the tracer, single points of failure
and the simulation):

1. A transfer comes in on an interface of one domain and leaves by an
   interface of the other; an interface in no domain (a management
   interface, an unassigned port) transfers nothing.
2. Its direction must be one of `directions`.
3. The rules are checked in their written order; the first whose domains,
   source, destination, protocol and ports match permits it.
4. Nothing matching: denied (the **default deny**, both ways).

A permitted transfer's **replies** come back (the TCP handshake and
answers, a DNS answer, an echo reply, an ICMP error about it): a reply is
not a transfer of its own. Starting a transfer the other way needs that
direction and a rule of its own; `directions` with both ways opens nothing
by itself. A protocol break is no physical data diode either: its replies
come back on the legs.

A **protocol break** forwards nothing. A transfer is addressed to one of
its transfer profiles' listening ports; when a rule naming the profile
permits it (its `source` matches the client, its `destination` and `ports`
the profile's `forward` address and port), the gateway ends the transfer
there (leg 1) and starts a new one of its own to the forward address (leg
2); the answer comes back on leg 2 and the gateway answers on leg 1. The
profiles NetAtlas can model:

| `type` | Transfer | Transport | Reply |
|---|---|---|---|
| `https` | HTTPS request | TCP 443 | the answer on leg 1 |
| `dns` | DNS query | UDP 53 | the answer on leg 1 |
| `syslog` | Syslog message | UDP 514 | none |

Any other type is an error ("not a transfer NetAtlas can model"), and a
profile that is incomplete transfers nothing: a limitation is reported,
never a success. Path trace (with a service, e.g. `tcp/443`) shows both
legs and their correlation; the simulation shows them in the timeline and
the packet details. A transfer that is not permitted ends at the gateway
with its reason.

In the diagram the Security gateway has its own icon; each domain-facing
port says its domain ("domain Red"), the management port "management" —
text, not colour, carries it. The Details tab lists the implementation, the
domains, the directions and the rules in order. Single points of failure
count a gateway as joining its domains only when its policy permits a
transfer, and never through its management interfaces.

Changing a device's type, mode, purpose or a Security gateway's
implementation asks first when something would no longer fit, lists it
(its kind, its built-in function, its port pairs, a protocol break's
profiles …) and what stays but is then reported (its guests, the relations
that need routing), and removes it in one undo step; nothing more
permissive takes its place and nothing new is chosen.

#### Cloud: an external network

A Cloud (`cloud`, or a System of purpose `external_network`) is a network
outside the model whose internals are not modelled: the internet, a
carrier, an MPLS / VPN service, a mobile network. It carries traffic
between its attachments as **one opaque Layer 3 hop**: an IP packet crosses
it with its TTL one lower; what has no hop left (a routing protocol's TTL-1
hellos, link-local multicast) ends at it, so routing protocols across a
Cloud run through a tunnel. Its cables' latency and loss apply; routed
multicast crosses it only with `simulation: {multicast: on}`.

#### Public cloud: regions, VPCs and VNets

A public cloud is drawn with groups of the kinds `cloud_region`, `vpc` and
`vnet`, each with its `provider`; they nest (a VPC in its region). In them
are the provider's gateways (a router of kind `cloud_gateway`), and **cloud
instances**: VMs and containers in a cloud group that have no `host` — the
provider's hosts are not modelled. A cloud instance's interfaces are its
attachments to the virtual network (physical interfaces, cabled to its
gateway or a switch of the VPC); its group is its cloud group. See
`examples/hybrid-cloud.yaml`.

### Layer 2 and Layer 3 switches

A switch is a **Layer 2 switch** unless it says `layer3: true`. A Layer 2
switch forwards frames between its ports and routes nothing; it keeps a
**management address** and **static routes** (for example a default
gateway towards management). Exactly these rules apply, and validation
reports anything else on a Layer 2 switch as an error:

| A Layer 2 switch may have | It may not have (errors) |
|---|---|
| ports that are switch ports: each with its VLANs (or its aggregate's), see [Port VLANs](#port-vlans-access-trunk-routed) | a port without VLANs, a routed port (`routed: true`), an address on a port |
| addresses on **one** interface: its management interface (its one VLAN interface), or DHCP there | addresses on a second interface (that would route between subnets or VLANs), a `dhcp_relay` |
| a VRF on that management interface | a VRF on any other interface |
| static routes in the default table or in the management interface's VRF | routes in another VRF |
| relations of services (SNMP, syslog, NTP …), LACP, MLAG, STP, LLDP, CDP and the model's own protocols | `protocols:` (routing services), `router_id`, VRRP / HSRP / GLBP / CARP groups on an interface, tunnel interfaces |
| | being an endpoint of a routing, BFD, LDP, PIM or first-hop redundancy relation, or of a tunnel or overlay |

A **Layer 3 switch** (`layer3: true`) has the full Layer 3+ feature set of
a router and routes between its VLANs. The same rule is used by the
Inspector, the Protocols card and its suggestions, the input helpers, the
consistency checks, the path tracer (a Layer 2 switch stops a trace as a
device that does not forward), Single points of failure and the protocol
simulation. The diagram marks every switch with an **L2** or **L3** badge
on its icon (and a Layer 3 switch with its own glyph), explained in the
legend of both views.

```yaml
- id: acc-sw
  type: switch                # a Layer 2 switch
  interfaces:
    - {id: p1, vlans: 10}                 # access ports
    - {id: p2, vlans: 20}
    - {id: up1, vlans: [10, 20, 99], native: 99}   # the trunk uplink
  logical_interfaces:
    - {id: Vlan99, type: virtual, vlan: 99, ip: 10.99.0.10/24}   # its management address
  routes:
    - {prefix: 0.0.0.0/0, via: 10.99.0.1}
- id: core1
  type: switch
  layer3: true                # a Layer 3 switch: routes between VLAN 10 and 20
  interfaces:
    - {id: down1, vlans: [10, 20, 99], native: 99}
    - {id: wan, routed: true, ip: 192.0.2.2/30}    # a routed port
  logical_interfaces:
    - {id: Vlan10, type: virtual, vlan: 10, ip: 10.10.10.1/24}
    - {id: Vlan20, type: virtual, vlan: 20, ip: 10.10.20.1/24}
```

In the Edit tab this is one checkbox on a switch, **Supports Layer 3**
(its tooltip: *Routing, routing protocols, and gateways*), off by default.
While it is off, the switch's *Enable a protocol…* lists the routing
protocols disabled, in a group *Requires Layer 3*, with the reason; nothing
of Layer 3 is suggested; the relation endpoint pickers leave the switch out
of relations that need Layer 3 (and say why), and the command palette's
*Enable a protocol* says the same.

Making a switch a Layer 2 switch (unticking **Supports Layer 3**)
asks first and lists what goes with it, in one undo step: its protocols
and router ID, the groups on its interfaces, the addresses of every
interface but its management interface, the VRFs of the others, its tunnel
interfaces, routes in other VRFs, and `routed: true` on its routed ports
(which then need their VLANs: nothing is chosen for them, so they are
reported until they get them). Relations at it that need routing are
listed but kept (they belong to other devices too) and reported until they
are changed.

### Interfaces

A device stores each of its interfaces once, in one of two lists. The list
says which category an interface is in:

| Written in | Category | `type` | Can be cabled |
|---|---|---|---|
| `interfaces` | **Physical**: a port of the device | none to choose | yes |
| `logical_interfaces` | **Logical**: an interface without a port of its own | `loopback`, `virtual` or `tunnel` (required) | no |

A device may have any number of either, including none.

```yaml
devices:
  - id: core1
    type: switch
    layer3: true
    interfaces:                                     # physical
      - {id: Ethernet1, routed: true, ip: 198.51.100.2/30}   # a routed port
      - {id: Ethernet2, vlans: 10}                  # an access port
      - Ethernet51                                  # the short form (a member: it takes Port-Channel1's VLANs)
      - Ethernet52
    logical_interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
      - {id: Port-Channel1, type: virtual, members: [Ethernet51, Ethernet52], vlans: [10, 20]}   # a bond, a trunk
      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.10.10.2/24}                # a VLAN interface
      - {id: Vxlan1, type: virtual}                                             # neither of the two
      - {id: tun0, type: tunnel, source: lo0, destination: 203.0.113.9}         # sourced from the loopback
```

**Keys of every interface:**

| Key | Description |
|---|---|
| `id` | required, unique within the device across both lists. This is the stable identifier and the interface name used in references (`core1:Vlan10`). |
| `label` | optional display name (defaults to the id) |
| `dhcp` | `true` or `false`; **omitted means `false`**. `true`: the interface obtains its address by DHCP, so it has no manually configured addresses. Not on a loopback. See [DHCP](#dhcp). |
| `ip` | the manually configured addresses: one address or a list, `ip: 10.0.0.1/30` or `ip: [192.0.2.1/24, 2001:db8::1/64]`. Addresses that aren't valid IPv4/IPv6 addresses give a *warning* and are shown as written (on a loopback they are an error); for `ip: dhcp` the warning says to write `dhcp: true` instead (on a loopback: to write its address). **The addresses decide which networks the device belongs to.** |
| `vrf` | name of the VRF the interface is assigned to (free text, display only). Membership in a network is decided by the address alone. |
| `vlans`, `native`, `routed` | a port's (or an aggregate's) VLANs: see [Port VLANs](#port-vlans-access-trunk-routed). |
| `mtu` | the interface's MTU in bytes, a whole number from 68 to 65535. Omitted: not modelled (no MTU is assumed, so nothing is compared). Read by the [consistency checks](#consistency-checks) `link-mtu-mismatch` and `tunnel-mtu`. |
| `multicast` | the groups the device joins on the interface and the streams it sends from it, for the protocol simulation. See [Multicast](#multicast). |
| `dhcp_relay` | the **DHCP relay** (helper addresses) of a routed interface with an address: `dhcp_relay: [10.10.10.10]`. It forwards the DHCP broadcasts of its subnet to these servers. See [DHCP](#dhcp). |
| `simulation` | the interface's **simulation attributes** (ARP timers, spanning tree per port, IGMP, DHCP client retries …): only what it overrides. See [Levels](#levels-where-an-attribute-is-written). |
| `mac`, `description`, `attrs` | |

A **physical interface** has no other keys but its VLANs (`vlans`, `native`,
`routed`). In particular it has **no `type` key**: every entry of `interfaces` is a physical interface, and writing
`type:` there is an error, whatever its value.

A **logical interface** additionally has:

| Key | Description |
|---|---|
| `type` | required: `loopback`, `virtual` or `tunnel`. No other value is accepted. |
| `members` | `virtual` only. See [Aggregates](#aggregates-member-ports). An aggregate carries VLANs like a port (`vlans`, `native`). |
| `min_links` | `virtual` with `members` only: how many member links must be up for the aggregate to be up (1–64). See [Aggregates](#aggregates-member-ports). |
| `vlan` | `virtual` only. See [VLAN interfaces](#vlan-interfaces-bound-to-their-bridge-ports). |
| `source`, `destination` | `tunnel` only. See [Tunnel interfaces](#tunnel-interfaces-source-and-destination). |

* `loopback`: an address of the device itself. See [Loopbacks](#loopbacks).
* `virtual`: every other interface that isn't a port and isn't a tunnel: a
  VLAN interface (SVI, IRB, BVI), a bond or LAG, a subinterface, a VTEP, a
  bridge. What it is follows from what is written: `members` make an
  aggregate; a name `<port>.<n>` makes a subinterface of that port (or
  aggregate); a VLAN (`vlan`, or the network of its address) otherwise makes
  a VLAN interface; anything else is just virtual.
* `tunnel`: a tunnel endpoint (GRE, IPsec VTI, WireGuard …).

**A logical interface has no generic parent.** There is no "parent physical
interface" field. What a logical interface is associated with depends on
what it is, and each association is written (or derived) in the way that
fits its meaning; the three cases follow. A key on the wrong type (`members`
on a tunnel, `source` on a loopback …) is an error, never ignored.

An interface has **no** `speed` or `media` key, and a physical interface has
no `vlan` key (it has `vlans`, the VLANs it carries):

* speed and medium belong to the cable and are set on the [link](#links-physical-cabling-only);
  what a port is *set to* (its speed and duplex) is a setting of the link end
  (see [Port settings on a link end](#port-settings-on-a-link-end));
* the VLAN of an address is derived. For each address, netatlas looks up the
  networks whose prefix contains it and shows that network's `vlan`:

| The address lies in … | Derived VLAN shown |
|---|---|
| no network | none ("no network") |
| networks that define no `vlan` | none ("no VLAN defined") — a VLAN is never invented |
| one or more networks that all define the same `vlan` | that VLAN |
| networks that define **different** VLANs | *ambiguous: VLAN x or y*, plus a warning. Nothing is chosen. |

An interface with several addresses gets one result per address, so it can
be associated with several networks and VLANs. That is not an ambiguity.
This applies to physical and logical interfaces alike.

#### Port VLANs: access, trunk, routed

What a port carries is configured **on the port** (a physical interface,
or an aggregate for its members), by VLAN ID:

```yaml
interfaces:
  - {id: Gi1/0/1, vlans: 10}                        # an access port in VLAN 10 (untagged)
  - {id: Gi1/0/48, vlans: [10, 20, 30-39], native: 99}   # a trunk: 99 untagged, the others tagged
  - {id: Gi1/0/47, vlans: [10, 20]}                 # a trunk without a native VLAN: every VLAN tagged
  - {id: Te1/3, routed: true, ip: 10.0.0.2/30}      # a routed port (a Layer 3 switch's)
```

| Key | Description |
|---|---|
| `vlans` | the VLANs the port carries: one ID (1–4094), a range `100-199`, or a list of both (`[10, 20, 30-39]`). **One VLAN** makes an **access port** (its frames untagged); **several** make a **trunk** (802.1Q-tagged). |
| `native` | a trunk's **native VLAN**: one of its `vlans`, sent and taken untagged; every other VLAN is tagged. Without it every VLAN of the trunk is tagged. |
| `routed` | `true`: a **routed port** of a Layer 3 switch (a Layer 3 interface: no VLANs, it may have addresses). |

* A port with VLANs is a **bridge port** (a switch port). It has **no
  address of its own**: an `ip` or `dhcp: true` on it is an error (the
  address goes on the VLAN interface of its VLAN, or the port is made
  routed).
* **Per device type:**

  | Device | A port without `vlans` |
  |---|---|
  | switch (Layer 2) | an **error** (*needs its VLANs*) until they are filled in: every port says what it carries |
  | Layer 3 switch | the same, unless it is a routed port (`routed: true`) |
  | router, firewall and other Layer 3 devices | a **routed port**: VLANs are optional; with VLANs it is a bridge port (for a BVI / IRB) |
  | hosts (servers, endpoints …) | unaffected: their ports are just ports |

* **Aggregates:** the VLANs are written on the aggregate, and its member
  ports take them. A member with VLANs (or `native`, `routed`) of its own is
  an error. A switch's aggregate needs its VLANs like a port.
* **Subinterfaces** (router-on-a-stick) stay: a virtual interface named
  `<port>.<n>` (`ge-0/0/1.10`) is a subinterface of that port or aggregate,
  in its VLAN (`vlan`, or the network of its address), always 802.1Q-tagged.
  Its port stays a routed port; it shows the VLANs it tags (*Routed · tagged
  10, 20*). A port can't be both a bridge port of a VLAN and the parent of a
  subinterface for the same VLAN: that is an error.
* Errors: a VLAN ID outside 1–4094 or a bad range (one whose end is lower
  than its start), a VLAN listed twice, a `native` VLAN that isn't one of
  the port's VLANs, `native` on an access port (one VLAN is untagged
  anyway), `routed` on a Layer 2 switch or on a device that isn't a switch,
  `routed` together with `vlans`, and `vlans` / `native` / `routed` on a
  loopback, a tunnel or a VLAN interface.
* **The networks a cable carries are derived** from its two ports: the
  networks whose `vlan` is one of their VLANs. Carriage is not membership:
  it makes no device a member of a network.
* The **VLAN checks** (see [Consistency checks](#consistency-checks)) compare
  the two ends of every cable: access ports in different VLANs, trunks with
  different lists, a native VLAN mismatch, an access port facing a trunk
  whose native VLAN is another one, VLANs nothing defines, and aggregate
  members whose far ends differ. **Neither end is changed**: fix the one
  that is wrong.
* **Display:** the port's card, the device's port list and the details show
  its mode as a badge in words — *Access · VLAN 10*, *Trunk · 10, 20, 30–39
  (native 10)*, *Routed* — never in colour alone. In the **physical view**
  the port's label has its VLANs as a second line: `A 10` (access), `T
  10,20,30–39 · N 10` (trunk, its native VLAN), `R · T 10,20` (a routed port
  with tagged subinterfaces); a trunk is drawn larger, with a thick frame.
  A cable shows what both its ports carry, and one whose ends disagree is
  marked ⚠ with *VLANs differ*. The Objects list shows the same on each
  cable. **Find** finds ports and cables by VLAN (`vlan 20` or `20`) and by
  mode (`trunk`, `access port`, `routed port`).
* **Editing:** the VLANs are a multi-select combobox (chips, the model's
  VLANs with their names as you type, new IDs and ranges accepted; Enter or
  a comma adds, Backspace removes the last one); a trunk gets a **Native
  VLAN** picker; a Layer 3 switch's port a **Routed port** checkbox.
  Suggestions copy the VLANs of a neighbouring port (*Same as Gi1/0/1*) or
  of the port at the other end of the cable (*VLANs of the connected
  port*). **Assign VLANs to ports…** on a device gives a range of ports
  (written as for *+ Port Range*) the same VLANs and native VLAN, in one
  undo step. Each change is one undo step.

#### Aggregates: member ports

A virtual interface that represents a bond, LAG or other aggregate lists the
physical interfaces that belong to it:

```yaml
- {id: Port-Channel1, type: virtual, members: [Ethernet51, Ethernet52]}
```

* `members` is one interface id or a list. Each must be a **physical
  interface of the same device**; an unknown id, a logical interface and an
  id listed twice are errors, located at the entry.
* A port that is a member of two aggregates gives a *warning*.
* `min_links` is the number of member links that must be up for the
  aggregate to be up (LACP "minimum links"). An aggregate whose `min_links`
  is larger than its number of cabled member ports can never be up (the
  check `lag-min-links`). `min_links` on an interface without members is an
  error.
* Members whose cables end on **several devices** make a multi-chassis
  aggregate: that is consistent only when an `mlag` (or `vpc`) relation pairs
  those devices; otherwise the check `lag-peer-devices` reports it. Members
  with different speeds are reported by `lag-member-speed`.
* The members are the only place this is written. The ports themselves say
  nothing about the aggregate.
* An aggregate carries VLANs like a port (`vlans`, `native`): its members
  take them and have none of their own (see [Port VLANs](#port-vlans-access-trunk-routed)).
* What the aggregate *does* (LACP towards another device, MLAG) is a
  relation with the aggregate as its endpoint.
* The physical view draws an aggregate as a bracket around its cabled member
  ports on each side of the device, named by the aggregate's id (`Po1`); the
  member ports keep their own names and cables. The logical view draws the
  aggregate as an entry of its own, and relations bound to it (LACP) start
  from its port.

#### VLAN interfaces: bound to their bridge ports

A virtual interface that is the interface of a VLAN (an SVI, an IRB or BVI
interface) is written **once per device and VLAN**, and references that
VLAN, not ports:

```yaml
- {id: Vlan10, type: virtual, vlan: 10, ip: 10.10.10.2/24}
- {id: Vlan20, type: virtual, ip: 10.10.20.2/24}     # VLAN 20, from the network containing 10.10.20.2
```

* `vlan` is a VLAN ID (1–4094). It may be left out when an address of the
  interface lies in a network that defines a `vlan`: the VLAN is then taken
  from that network, so it is entered once. If both are present and differ,
  a *warning* says so.
* It is **bound to every bridge port of its VLAN** on its device by itself:
  the access ports in that VLAN, the trunks that carry it and the
  aggregates that do (their members with them). There is **no member list**
  to keep: `members` makes an aggregate, and `vlans` on a VLAN interface is
  an error. The binding changes as soon as a port's VLANs change.
* **Bridge ports** is derived and read-only in the Edit panel and the
  details: the ports grouped by mode (*Access: Gi1/0/1–10 · Trunk: Gi1/0/48,
  Po1*), each a link to its port. Selecting the VLAN interface highlights
  its bridge ports and their cables; selecting a port highlights the VLAN
  interfaces of its VLANs.
* Validation: two VLAN interfaces for the same VLAN on one device are an
  error; a VLAN interface whose VLAN no port of the device carries is a
  warning (it reaches no one); a Layer 2 switch has one VLAN interface, its
  management interface (another one is an error).
* Membership in a network follows the VLAN interface's address, as for any
  interface; the logical view draws each VLAN interface once, as a row of
  its device.
* A virtual interface without a VLAN (no `vlan` and no address in a network
  with one; e.g. a VTEP) has no bridge ports.

#### Tunnel interfaces: source and destination

```yaml
- {id: tun0, type: tunnel, source: ge-0/0/0, destination: 203.0.113.9}
- {id: tun1, type: tunnel, source: lo0, destination: edge-b:lo0}
- {id: tun2, type: tunnel, source: 198.51.100.2, destination: 10.255.0.2}
```

* `source` is where the tunnel is sourced from on this device: the id of
  **any other interface of the device, physical or logical** (a port, a
  loopback, a VLAN interface …), or an IP address. An id that isn't an
  interface of the device is an error. When an address is written and an
  interface of the device has that address, that interface is derived as the
  source interface; if none has it, a *warning* says the source interface
  can't be derived.
* `destination` is the remote end: an IP address, or a device or
  `device:interface` of this model. A name that is neither is an error. When
  an address is written and an interface in the model has it, the device is
  derived.
* Both are optional.
* The tunnel itself (GRE, IPsec …, and what it is carried over) is a
  [relation](#relations-logical-layer) between the two tunnel interfaces.
  `source` and `destination` describe the interface; they don't replace the
  relation.

**In the diagrams.** The physical view draws a physical interface as a port
when it is cabled; logical interfaces are never ports. Selecting a logical
interface (in the details, the editor or through a relation) highlights what
it is associated with: the member ports of an aggregate, the ports carrying
the VLAN of a VLAN interface, a tunnel's source interface, each with its
cable, and the device a tunnel's destination names. Selecting a port
highlights the logical interfaces that use it. Tunnels and other relations
between logical interfaces are drawn in the logical view. The device details
list the physical and the logical interfaces in two tables; the second one
says what each logical interface is associated with.

**Display order.** The editor and the details show the interfaces of each
category in alphabetical order of their ids: letters without regard to case,
runs of digits by their value (`eth2` before `eth10`). Ids that are equal in
that comparison are ordered by their exact spelling, and identical ids
(possible only in a draft with errors) keep the order of the file. This is
display only: the order of the lists in the YAML file means nothing to
netatlas, is never changed by viewing or editing an entry, and new entries
are appended to the end of their list.

### Loopbacks

A loopback is a logical interface with `type: loopback`: an address of the
device itself. It has no port, no cable and normally no physical interface
it depends on, so nothing of the kind is written for it. A device can have
zero, one or several, and a device may have loopbacks and no physical
interface at all.

```yaml
devices:
  - id: edge-a
    type: router
    interfaces:
      - {id: ge-0/0/0, ip: 192.0.2.1/31}
    logical_interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
      - {id: lo1, type: loopback, label: BGP source (IPv6), ip: [2001:db8:ffff::a/128]}
relations:
  - id: ibgp-v6
    protocol: ibgp
    endpoints: [edge-a:lo1, edge-b:lo1]  # a session sourced from loopbacks
  - id: gre-lab
    protocol: gre
    endpoints: [edge-a:lo0, edge-b:lo0]  # a tunnel whose endpoints are loopbacks
```

Rules (errors unless noted):

* `ip`: at least one address. Each must be an IPv4 or IPv6 address **with a
  prefix length** (`10.255.0.1/32`, `2001:db8::1/128`); `/0–32` for IPv4 and
  `/0–128` for IPv6. The same address can't appear twice on one loopback.
  If the same address is used on another interface anywhere in the model, you
  get a *warning*.
* A loopback has no `members`, `vlan`, `source` or `destination`, and can't
  be the end of a physical link. Its addresses count for network membership
  like any other interface's.
* A loopback may be used anywhere an interface can be referenced: as a
  relation endpoint (tunnel endpoints, BGP/LDP session sources) and as the
  `source` of a tunnel interface. It doesn't have to be referenced at all.
* There is no router-ID field. If a loopback provides the router ID, say so
  in its `label`.
* Display: in the **logical view** each device shows every loopback as a row
  under the device, in alphabetical order, and its virtual and tunnel
  interfaces as small chips under them (a device with any logical interface
  is shown even if it has no relations). The device's **details** list them
  with the other logical interfaces. The **physical view** never draws them,
  because they have no port or cable; it draws every physical interface: a
  cabled one as a port on its cable, an uncabled one as a chip at the bottom
  of its device box.

### DHCP

Every physical interface and every virtual or tunnel interface has an explicit DHCP state (a loopback can't use DHCP, below):

```yaml
    interfaces:
      - {id: wan1, dhcp: true, description: LTE modem}   # address assigned by DHCP
      - {id: lan0, ip: 10.30.0.1/24}                     # dhcp omitted: false
      - {id: eth3}                                       # no address, and not DHCP either
```

* `dhcp` is `true` or `false`, and an omitted `dhcp` is `false`. An
  interface without addresses is **not** assumed to use DHCP. The editor
  creates every interface with DHCP off and writes nothing for it; switching
  DHCP on writes `dhcp: true`, switching it off removes the key again.
* DHCP and manual addresses exclude each other. `dhcp: true` together with
  an `ip` is an **error** (attached to the addresses). Neither value is
  dropped or chosen: fix the file by deleting one of them.
* DHCP is not an address. The address the interface will obtain is unknown,
  so it contributes to no network's membership and has no derived VLAN until
  an address is written. It can't carry a DNS name (below). The diagram
  marks it *DHCP client* and keeps a line for its lease, which the
  protocol simulation fills in ("10.10.10.100/24 (DHCP lease)"); the model
  is unchanged. Its DHCP server is modelled as well: see
  [Network services](#network-services-services-dhcp-and-dns-servers).
* **A loopback can't use DHCP.** It is an address of the device itself and is
  always configured, so `dhcp: true` on a loopback is an **error** (kept in
  the file, not dropped), and the loopback still needs its address.
  `dhcp: false` on a loopback is accepted. The editor shows no DHCP switch on
  a loopback card; if the file has `dhcp: true` there, the switch is shown
  only so that it can be turned off.
* In the editor the **DHCP** switch sits next to the addresses (not on a loopback). While it is
  on, manual addresses can't be entered. Turning it on for an interface that
  has addresses or DNS names first lists what will be deleted, and deletes
  it in the same undo step only after confirmation. Turning it off does not
  bring deleted addresses back.

#### DHCP relay

A routed interface with an address can relay DHCP to servers in other
subnets: `dhcp_relay` lists their addresses (the *helper addresses*).

```yaml
    logical_interfaces:
      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.10.20.1/24, dhcp_relay: [10.10.10.10]}
```

It forwards the clients' DHCP broadcasts as unicast to each server, with
its own address as the relay address (`giaddr`), so the server picks the
scope of that subnet, and passes the answers back to the clients. Only on
an interface of a device that routes (a router, a Layer 3 switch, a
firewall …) and that has an address; elsewhere it is an error, and so is a
value that isn't an IPv4 address. The consistency check `dhcp-relay-no-server`
reports a helper address that is no DHCP server of the model.

### DNS names

`dns_names` lists names of the device. Each entry is a name and the
interfaces of the same device it is associated with, by interface id; a
name is written once, however many interfaces it belongs to:

```yaml
devices:
  - id: hq-rtr1
    interfaces:
      - {id: ge-0/0/0, ip: 198.51.100.2/30}
      - {id: ge-0/0/1, ip: 10.0.0.2/28}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
    dns_names:
      - {name: vpn1.acme.example, interfaces: [ge-0/0/0]}
      - {name: hq-rtr1.acme.example, interfaces: [lo0, ge-0/0/1]}
```

| Key | Description |
|---|---|
| `name` | required. A host name: dot-separated labels of letters, digits and hyphens (1–63 characters each, not starting or ending with a hyphen), at most 253 characters, optionally ending in a dot; the last label is not all digits. |
| `interfaces` | required, at least one: ids of physical or logical interfaces of this device. A single id may be written without brackets. |

* The association is to the **interface**, not to one of its addresses: an
  interface with several addresses is associated as a whole. Nothing is
  derived from it: no A or AAAA record is created or implied, and no DNS
  server is consulted. Associating a name with one particular address would
  be a separate, future addition to the format.
* An interface with `dhcp: true` can't be associated; that is an error.
* Errors: an invalid name; the same name twice on one device (names are
  compared without case and without a trailing dot); an unknown interface;
  an interface listed twice for a name; no interface. The same name on
  another device is a *warning*.
* Editing keeps every association valid. Renaming an interface updates its
  associations. Deleting an interface, or turning DHCP on for it, removes
  its associations in the same undo step (the editor says so first); a name
  that is left without interfaces is deleted with them.
* Display: the device's **details** list its names with their interfaces,
  and an interface's details and tooltip name its DNS names. The **logical
  view** writes each name once under its device (hidden with *Labels*); the
  physical view doesn't show them. Showing a name says only that it is
  configured: no DNS record is looked up or derived. **Find in diagram…**
  finds a device by a DNS name.

### DNS servers of a host (`dns_servers`)

`dns_servers` lists the addresses of the DNS servers a device asks:
`dns_servers: [10.10.10.10]`. A DHCP client gets them from its lease (the
scope's `dns`); while it has a lease, those are used instead. A value that
isn't an address is an error. In the protocol simulation a
host resolves names (test traffic to a host name, `Send test` to a name)
through them.

### Services: the registry and its catalog

Every service a device may run is in the **service registry**
(`src/model/service-registry.ts`): its key under `services:`, its
parameters (each with its type, whether it is required — always, or by the
others' values — and where it applies), who may run it, its badge, and its
simulation. Nothing is enabled implicitly: a service is there when it is
written, and its required fields are errors until they are. A device that
may not run a service is told why ("a Layer 2 switch routes nothing: tick
Supports Layer 3 first"); the Edit tab's **Add service…** lists those
entries disabled with the same reason. A **built-in** function is its
appliance's: always there and not removable (an access point's Wireless
access, a load balancer's Load balancing, an IDS/IPS's Inspection, a VPN
Gateway's VPN gateway, a Security gateway's Domain separation); where its
configuration is required, a missing one is an error. **A Security gateway
runs nothing but its Domain separation**: no service may bypass its
boundary.

<!-- service-matrix:begin (generated by scripts/capability-matrix.mjs) -->
| Service | Key | Badge | Built into | Optional on | Conditions |
|---|---|---|---|---|---|
| DHCP server | `dhcp` | DHCP |  | Router, Switch, Firewall, Server, Virtual machine, Container | a Layer 2 switch routes nothing: tick Supports Layer 3 first; a transparent firewall forwards no IP of its own: make it routed |
| DNS server | `dns` | DNS |  | Router, Firewall, Server, Virtual machine, Container | a transparent firewall forwards no IP of its own: make it routed |
| NTP | `ntp` | NTP |  | Router, Switch, Firewall, Server, Virtual machine, System | only a System whose purpose is Host runs services |
| AAA | `aaa` | AAA |  | Server, Virtual machine, Container |  |
| Syslog collector | `syslog` | LOG |  | Server, Virtual machine, Container, System | only a System whose purpose is Host runs services |
| Monitoring | `monitoring` | MON |  | Server, Virtual machine, Container, System | only a System whose purpose is Host runs services |
| Proxy | `proxy` | PRX |  | Server, Virtual machine, Container, Firewall | a transparent firewall forwards no IP of its own: make it routed |
| Load balancing | `load_balancing` | LB | Load balancer | Server, Virtual machine, Container |  |
| VPN gateway | `vpn` | VPN | VPN gateway (its configuration required) | Router, Firewall, Server, Virtual machine | a transparent firewall forwards no IP of its own: make it routed |
| NAT | `nat` | NAT |  | Router, Switch, Firewall, Load balancer, VPN gateway, Virtual machine, System | NAT is a Layer 3 forwarder’s: it routes nothing |
| Wireless access | `wireless` | WIFI | Access point (its configuration required) | Router |  |
| Wireless controller | `wireless_controller` | WLC |  | Server, Virtual machine, System | only a System whose purpose is Host runs services |
| Hypervisor | `hypervisor` | HV |  | Server |  |
| Container engine | `container_engine` | CTR |  | Server, Virtual machine |  |
| Storage service | `storage` | STOR |  | Storage, Server, Virtual machine |  |
| Application | `application` | APP |  | Server, Virtual machine, Container, Storage, System | only a System whose purpose is Host runs services |
| Inspection | `inspection` | IPS | IDS/IPS |  |  |
| Domain separation | `separation` | SEP | Security gateway (its configuration required) |  |  |
<!-- service-matrix:end -->

The parameters of the services without a section of their own:

| Service | Parameters (required in **bold**) | What the simulation does |
|---|---|---|
| `ntp` | **`stratum`** (1–15) or **`upstreams`** (addresses): one of them | asks its upstreams (NTP client request / server response, every 64 s); listens on UDP 123 |
| `aaa` | **`protocol`** (`radius`, `tacacs`), **`secret`** (a placeholder), **`clients`** (devices) | each client's authentication request and the answer; listens on UDP 1812 (TACACS+: TCP 49) |
| `syslog` | `port` (514), `transport` (`udp`, `tcp`), `senders` (devices) | its senders' messages (one way), besides its syslog relations |
| `monitoring` | **`targets`** (devices), `icmp_interval`, `snmp_interval` | polls each target by SNMP (and the ICMP probes of the monitoring attributes) |
| `proxy` | **`mode`** (`forward`, `reverse`), **`listener`** (port), `upstream` (address; **required for a reverse proxy**), `upstream_port` | ends the client's connection at its listener and opens its own to the upstream; the answer goes back on the first connection |
| `load_balancing` | `virtual_address`, `port`, `backends` (devices), `algorithm`, `snat` | its backends (else its service relations' servers) are its pool: health checks, the algorithm, persistence |
| `nat` | **`inside`**, **`outside`** (interfaces), **`rules`**: each **`type`** `pat` / `snat` (**`source`**, `to`) or `dnat` (**`protocol`**, **`port`**, **`to`**, `to_port`) | translates on the way from inside to outside (PAT, source NAT) and forwards outside ports in (destination NAT), the replies translated back; the path tracer notes the translation |
| `wireless_controller` | **`aps`** (devices: controller-managed access points) | the CAPWAP control channel with each access point (echo every 30 s); listens on UDP 5246 |
| `storage` | **`protocols`** (`nfs`, `smb`, `iscsi`) | listens on TCP 2049, 445, 3260 |
| `application` | **`name`**, **`ports`** (`tcp/443`, `udp/5060` …) | listens on its ports and answers |
| `inspection` | `block` (`tcp/23`, `udp/69`, `icmp`) | an inline IDS/IPS drops what it blocks; a passive one raises an alert and lets it pass |

A secret (an AAA shared secret, a Wi-Fi passphrase) is written as a
placeholder, `<name>` or `${NAME}`; anything else is a warning: a model file
is shared. The exchanges a service implies (NTP to its upstreams, RADIUS
from its clients, syslog from its senders, SNMP polls of its targets,
CAPWAP to the controller) are simulated as relations the model doesn't
have to draw; an exchange a relation of the model already describes is not
added twice.

The diagram writes a device's services as **badges** in a line under its
type — at most three, then how many more (`DHCP · DNS · NTP +3`); its
tooltip names every one, and the legend lists the badges the model uses.

### Wireless access: Wi-Fi networks on VLANs

An access point's **Wireless access** (built in) and a router's (a
service) have the same model: their **Wi-Fi networks**, each bridged to one
VLAN of the device's wired side.

```yaml
- id: ap1
  type: ap
  services:
    wireless:
      networks:
        - {id: staff, ssid: Staff, vlan: 10, radio: radio0, security: wpa3_enterprise}
        - {id: guest, ssid: Guest, vlan: 20, radio: radio0, security: wpa2_psk, passphrase: "<guest-psk>"}
        - {id: iot, ssid: IoT, vlan: 30, radio: radio0, security: wpa2_psk, passphrase: "<iot-psk>"}
  interfaces:
    - {id: eth0, vlans: [10, 20, 30]}   # the one uplink: a trunk that carries the three VLANs
    - {id: radio0}                      # the radio: a physical interface
links:
  - {id: w-laptop, a: "ap1:radio0", b: "laptop:wlan0", medium: wireless, wireless_network: staff}
```

| Key | Required | Description |
|---|---|---|
| `id` | yes | the network's id: what a connection names (an SSID need not be unique) |
| `ssid` | yes | the name clients see (at most 32 characters; one per radio) |
| `vlan` | yes, or `untagged` | the VLAN it is bridged to. Never inferred and never VLAN 1 by default |
| `untagged` | | `true`: bridged to the untagged domain of the uplink (its access VLAN, or a trunk's native one) instead |
| `radio` | yes | the physical interface it is on |
| `security` | yes | `open`, `wpa2_psk`, `wpa3_sae`, `wpa2_enterprise`, `wpa3_enterprise` |
| `passphrase` | PSK / SAE | a placeholder (`"<guest-psk>"`) |
| `forwarding` | | a controller-managed access point's: `local` (bridged at the access point, the default) or `tunneled` (to the controller: not simulated, and said so) |

A controller-managed access point (`mode: controller`) names its
`controller` in `services.wireless` (a device with the Wireless controller
service, which lists it among its `aps`).

**Physical interfaces, VLANs and attachment points stay apart.** The radio
is a physical interface; the uplink is a wired port with its VLANs, as any
port has them (access, trunk, native); a Wi-Fi network is an attachment
point, not a port: its connections are bridged into its VLAN. A wireless
connection at a radio names its network (`wireless_network`) — required
there, an error anywhere else — and several connections share the radio.
The physical view writes the network under the radio's end of each
connection (*SSID “Guest” · A 20*); the Details tab lists the networks
with their VLANs and clients.

What is checked (errors, nothing is added for you): a VLAN-backed
network's VLAN is carried by one of the device's wired ports (a router: or
it has a VLAN interface for it); an untagged network needs a wired port
with an untagged VLAN; the uplink's tagging must agree with the far end's,
by the rules of [port VLANs](#port-vlans-access-trunk-routed); the radio is
a physical interface that no cable but wireless connections uses; each
connection names a network of its radio.

What follows: a client is in its network's VLAN only. Two networks on one
radio share the radio and the uplink, never a frame: Staff and Guest are as
far apart as two VLANs (inter-VLAN traffic needs a routed path, and the
policy on it). DHCP, ARP and broadcasts stay in the network's VLAN unless a
relay sends them on. Frames leave the uplink tagged (or untagged in its
native VLAN) as the port says; the uplink is one cable: its failure cuts
every network of the access point at once, and single points of failure
say so. A cable's latency and loss count once, on the cable they are
written on; the association itself (its beacon wait and association time)
is the access point's. There is no radio-frequency or roaming model.

### Network services (`services`): DHCP and DNS servers

A router, a Layer 3 switch, a routed firewall, a server, a VM or a
container can run a **DHCP server**; a router, a routed firewall, a
server, a VM or a container a **DNS server** (a router's and a
firewall's usually a forwarder: `forwarders` without zones). Both are off
unless written; the Edit tab has a *Services* card with a checkbox for
each.

```yaml
  - id: srv
    type: server
    services:
      dhcp:
        scopes:
          - network: users                     # a network of the model (IPv4)
            range: 10.10.10.100-10.10.10.199   # the addresses it leases
            gateway: 10.10.10.1                # the default gateway it gives
            dns: [10.10.10.10]                 # the DNS servers it gives
            lease: 8h                          # optional (default 1 day)
            exclude: [10.10.10.150]            # optional: never leased
            reservations:                      # optional: always this address
              - {mac: "02:00:00:00:10:21", ip: 10.10.10.21}
            domain: campus.example             # optional (option 15)
            simulation: {offer_delay: 500ms}   # optional: the scope's simulation attributes
      dns:
        listen: 10.10.10.10                    # optional: the address it answers on (default: all)
        zones:
          - name: campus.example
            records:                           # its own records (A, AAAA, CNAME)
              - {name: www, type: CNAME, value: web.campus.example}
            simulation: {record_ttl: 300}
        forwarders: [192.0.2.53]               # optional: where other names are asked
        reverse_zones: [10.10.0.0/16]          # optional: PTR answers for these networks
    interfaces: [{id: eth0, ip: 10.10.10.10/24}]
```

**DHCP scopes.** Each scope needs its `network`, `range`, `gateway` and
`dns`; a missing one is an error, as is a DHCP server without a scope.
The range lies inside the network and is written `start-end`; it may not
contain the gateway or an address configured statically in the model. The
gateway must be in the network; the lease time is a duration (`8h`,
`1d`, a bare number is in seconds). An exclusion must lie in the range; a
reservation needs a MAC address and an address inside the network that
isn't configured statically, and two reservations may not share either. Two scopes of
the model may not overlap.

**DNS zones.** A zone's `name` is a domain. Its A and AAAA records come
from the model: every DNS name (`dns_names`) inside the zone gives one
record per address of its interfaces (shown read-only in the editor, with
the device and interface they come from). A zone's own `records` add A,
AAAA and CNAME records (`name` relative to the zone or ending in it); a
name outside the zone, a record written twice or already derived from a
DNS name, a CNAME next to another record of the same name, and an A record
whose value isn't an IPv4 address (AAAA: IPv6) are errors. A DNS server without a zone is an error; `listen` must be one
of its own addresses; `forwarders` and `reverse_zones` are optional.

**Clients.** A DHCP client is an interface with `dhcp: true`. Its segment
needs a DHCP server: one in its broadcast domain, or a relay on its gateway
interface (`dhcp_relay`); else the consistency check `dhcp-no-server`
reports it. A host's DNS servers come from its lease, else from
`dns_servers`.

### Virtualization: hypervisors, VMs and containers

A hypervisor is a **server with the Hypervisor service**; a container host is
a **server or a VM with the Container engine service**. VMs and containers
are **guests**: each names its `host`, and its network goes through the
host's virtual networking, never through a cable of its own.

```yaml
  - id: hv1
    type: server
    group: rack1
    services:
      hypervisor:
        platform: esxi                       # kvm, esxi, hyperv, proxmox, xen, other
        cluster: prod                        # optional: its HA cluster
        cpu: 64                              # optional inventory: physical cores …
        ram: 512G                            # … and memory (overcommit is reported as info)
        vswitches:
          - name: vSwitch0
            type: standard                   # standard, distributed, linux_bridge, ovs
            uplinks: [vmnic0, vmnic1]        # the host's ports (or a bond), in teaming order
            teaming: active_standby          # active_standby, load_based, source_based, lacp
            mtu: 1500                        # optional
            port_groups:
              - {name: Servers, vlans: 10}                  # access: one VLAN
              - {name: Trunk, vlans: [10, 20], native: 10}  # trunk, with an optional native VLAN
              - {name: VGT, guest_tagging: true}            # the guest tags (VGT)
            simulation: {failover_detection: 1s}
        simulation: {vm_restart: 30}
    interfaces: [vmnic0, vmnic1, vmnic2]
    logical_interfaces:
      # a host interface (VMkernel port): a vnic of the host itself, with its role
      - {id: vmk0, type: vnic, port_group: Servers, role: management, ip: 10.10.0.11/24}
  - id: web1
    type: vm
    host: hv1                                # required: a server with the Hypervisor service
    guest_os: Ubuntu 24.04                   # optional: guest_os, vcpu, ram
    vcpu: 2
    ram: 4G
    logical_interfaces:
      - {id: eth0, type: vnic, port_group: Servers, mac: "00:50:56:01:00:21", ip: 10.10.0.21/24}
  - id: db1
    type: vm
    host: hv1
    logical_interfaces:
      - {id: eth0, type: vnic, passthrough: vmnic2, ip: 10.10.0.40/24}   # PCI passthrough (vf: SR-IOV)
  - id: ctr1
    type: server
    services:
      container_engine:
        engine: docker                       # docker, podman, containerd, lxc, other
        networks:
          - name: bridge
            driver: bridge                   # creates the bridge interface on the host
            interface: docker0
            subnet: 172.17.0.0/16
            gateway: 172.17.0.1              # the bridge interface's address
            nat: true                        # masquerade to the host's address
            range: 172.17.0.100-172.17.0.199 # optional: IPAM, where "next free" takes from
          - {name: lan, driver: macvlan, parent: eth1, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: bridge}
          - {name: host, driver: host}
        simulation: {container_start: 2s}
    interfaces: [{id: eth0, ip: 10.20.0.50/24}, eth1]
  - id: web
    type: container
    host: ctr1                               # required: a server or VM with the Container engine
    image: nginx:1.27
    simulation: {restart_policy: always}
    logical_interfaces:
      - id: eth0
        type: veth
        network: bridge
        ip: 172.17.0.2                       # static; without a length it is in the subnet
        aliases: [web.local]                 # optional: DNS aliases on the network
        publish:
          - {host_port: 8080, port: 80, protocol: tcp}    # host_ip: optional
```

**Guests.** A VM or a container needs its `host`: a VM a server with the
Hypervisor service, a container a server or a VM with the Container engine
service (a container in a VM runs inside the VM). A guest has **no physical
interfaces** and **no cables**: `interfaces` on it, or a link end naming it,
is an error, and Connect refuses it (cable its host instead). It is where its
host is: `group` on a guest is an error, and its location is its host's.
Renaming a host updates its guests; deleting a host, or unticking its
service, asks first and lists the guests whose `host` then breaks (they are
reported until moved or deleted). `guest_os`, `vcpu` and `ram` (VMs) and
`image` (containers) are optional facts.

**Hypervisor service** (`services.hypervisor`, servers only; on a VM it is
an error: nested virtualization is not modelled):

| Key | Required | Description |
|---|---|---|
| `platform` | yes | `kvm`, `esxi`, `hyperv`, `proxmox`, `xen` or `other`; it also picks the OUI the MAC generator uses for its VMs |
| `cluster` | | The name of its **HA cluster**: the members restart each other's VMs (see the simulation and the failure analysis) |
| `cpu`, `ram` | | Its inventory: physical cores and memory. With it, the VMs' `vcpu` and `ram` are added up and an overcommit is reported (info) |
| `vswitches` | yes | Its virtual switches (at least one) |
| `simulation` | | The service's simulation attributes (`vm_restart`) |

A **virtual switch** has a `name` (unique on its host), a `type`
(`standard`, `distributed`, `linux_bridge` or `ovs`), its `uplinks` (the
host's ports or aggregates, in teaming order; none: an internal switch), its
`teaming` (`active_standby`, `load_based`, `source_based` or `lacp`; LACP
needs one aggregate of the host as the uplink; without uplinks `teaming` is
an error), an optional `mtu`, its `port_groups` (at least one) and its
`simulation` (`failover_detection`). A port is the uplink of one virtual
switch; an uplink with an address is an error (the host's addresses belong
on host interfaces).

A **port group** has a `name` (unique on its host: a VM names it) and its
VLAN mode, as a port: `vlans` with one VLAN (access) or several (a trunk,
with an optional `native` VLAN among them), or `guest_tagging: true` (the
guest tags; every VLAN of the uplinks passes). Both, or neither, is an
error.

**Virtual NICs** (`type: vnic`, on a VM, or on a hypervisor as its host
interface): `port_group` (a port group of its host) or `passthrough` (a
physical port of its host, bound to the VM; `vf` its SR-IOV virtual
function), never both. A port used for passthrough is exclusive and can't
be an uplink. A host interface has a `role` (`management`, `migration` or
`storage`) and no passthrough. A VM's VLAN subinterfaces (`eth0.10`, type
`virtual`) sit on a vnic whose port group passes their tags (guest tagging
or a trunk). A vnic is Layer 3 like any interface: `ip`, `mac`, `mtu`,
`vrf`; a VM with `layer3: true` routes (a virtual router or firewall).

**Container engine** (`services.container_engine`, servers and VMs):

| Key | Required | Description |
|---|---|---|
| `engine` | yes | `docker`, `podman`, `containerd`, `lxc` or `other` |
| `networks` | yes | Its container networks (at least one) |
| `simulation` | | The service's simulation attributes (`container_start`) |

A **container network** has a `name` (unique on its engine) and a `driver`:

| Driver | Keys | What it is |
|---|---|---|
| `bridge` | `interface` (the bridge it creates on the host, e.g. `docker0`), `subnet`, `gateway` (the bridge interface's address), `nat` (masquerade to the host), `range` | a network behind its host; with NAT its containers reach out with the host's address, and are reached from outside only on their published ports |
| `macvlan` | `parent` (a port, an aggregate or a VLAN subinterface of the host; in a VM a vnic), `subnet`, `gateway`, `mode` (`bridge`, `private`, `vepa`, `passthru`), `range` | its containers have their own MAC addresses on the parent's LAN; the host can't reach them through the parent |
| `ipvlan` | as macvlan, `mode` (`l2`, `l3`) | its containers share the parent's MAC address |
| `overlay` | `subnet`, `gateway`, `hosts` (the other container engines that take part), `range` | a network across hosts (its tunnel between the hosts is not modelled) |
| `host` | — | the container uses its host's interfaces and addresses: its own address is an error |
| `none` | — | no network |

The bridge interface is derived (never written): it appears under the host's
logical interfaces with the gateway's address. A subnet is a network with its
prefix length and no host bits; the gateway lies in it and is not its network
or broadcast address; the `range` (`start-end`) lies in it.

**Container network attachments** (`type: veth`, on a container): its
`network` (a network of its host's engine, or an overlay that lists the
host), its address (`ip`: static, inside the subnet, not the gateway; without
a prefix length it takes the subnet's — the editor's *Next free* takes the
lowest free one of the range; DHCP only on macvlan networks), an optional
`mac` and DNS `aliases`, and `publish` (bridge networks only): published
ports, each `host_port`, `port`, `protocol` (`tcp`, `udp`) and an optional
`host_ip` (an address of the host); a host address and port can be published
once.

**Out of scope.** Kubernetes (pods, services, CNI plugins, ingress) is not
modelled: a Kubernetes node is a container host (`engine: containerd`) with
its networks, its pods are containers. The overlay's tunnel between hosts,
nested virtualization, vMotion (a VM moves only by an HA restart in the
simulation), and a distributed switch spanning hosts (each host's switch is
its own) are not modelled either.

**Validation.** Besides the rules above (a container's address outside its
network's subnet is an error), these consistency checks apply (warnings
unless said): `vswitch-uplink-vlan` (error: the switch port at an uplink
doesn't carry a port group's VLAN), `vnic-network-vlan` (a VM's address
outside the network of its port group's VLAN, or of its passthrough port's),
`duplicate-mac` (one MAC address on two interfaces, vnics included),
`container-parent-vlan` (a macvlan network in another VLAN than its parent),
`ha-restart-portgroup` (a VM of an HA cluster can't restart on another
member: a port group missing there, or a passthrough port) and
`hypervisor-overcommit` (info: more vCPUs or RAM than the host has).

**In the diagrams.** The physical view draws each guest **inside its host's
box** (a container in a VM inside the VM), with the virtual switches and
container networks as bars, their port groups as pills, a wire from each
vnic and veth to its port group or network, and the uplink wires from the
host's ports; the layout keeps positions for the hosts only (dragging a
guest moves its host). The logical view draws each guest as a device whose
second line names its host ("runs on esx-01"), and each bridge or overlay
network with a subnet as a **network of its own host** (dashed; "NAT" when
it masquerades): its members are that host's bridge interface and the
containers on it, never another host's with the same subnet. Its place in
the logical layout is stored under `<host>/<network>` (`ctr1/bridge: [x,
y]`), an id no device or network can have.

**In the analyses.** The path tracer leaves a vnic through its port group's
virtual switch and the uplink its teaming uses (active / standby: the first
that is up; LACP: the bond; load- and source-based: the first that is up),
or through its passthrough port; two guests on one virtual switch (in one
VLAN) or one container network meet inside the host without a cable. NAT is
modelled for container bridges only: a container host forwards for its
bridge networks; with `nat` the source becomes the host's address (SNAT); a
container behind NAT is reached from outside only at its host's address, on
a published port (DNAT; the port numbers are named, not checked); without a
published port it can't be reached. A macvlan container and its own host
can't reach each other. A container's default route is its network's
gateway unless it has one written. Failures: a host takes its guests down,
unless it is in an HA cluster with a member left (its VMs restart there,
except one with a passthrough port); a vnic goes down when every uplink of
its virtual switch is down. Single points of failure add a host for its
guests, a virtual switch with one uplink or uplinks to only one switch, and
a passthrough port.

**In the simulation.** Each virtual switch is a bridge without spanning
tree: it learns its guests, not its uplinks, sends what isn't theirs by its
teaming's uplink, never from one uplink to another, and takes broadcasts
from the active uplink only. When the active uplink goes down it fails over
after its `failover_detection` and announces each guest's MAC address with a
RARP on the new uplink; it fails back when the uplink returns. A host powered
off takes its guests down; in an HA cluster its VMs restart on another member
after `vm_restart` (then their boot time) and are drawn there during the
simulation only. A container host forwards between its bridge networks and
the rest with NAT (shown in the event log and the packet inspector),
forwards published ports to their containers, and a container starts after
its engine's `container_start`; when its host boots or its engine starts
again, its `restart_policy` decides whether it does (`no`, `on-failure`: not
after a clean stop; `always`; `unless-stopped`: unless stopped by hand). The
simulation's events include powering a VM or container off and on, a
host's uplink (shut, flapping, its cable failed) and stopping or starting a
container engine.

### Static routes

`routes` lists the static routes of a device: where traffic to a
destination prefix goes. A device that *forwards* (a router, a Layer 3
switch, a routed firewall, a load balancer, a VPN gateway, a filtering
router, a Layer 3 forwarder System) may have any route; a *host* (server,
VM, container, storage, endpoint, a Layer 2 switch, a transparent firewall,
a filtering bridge or protocol break, a host System) may have routes too.
**A host's default gateway is a static route** to `0.0.0.0/0` (or `::/0`)
via the gateway's address: there is no separate gateway field.

```yaml
devices:
  - id: br-rtr
    type: router
    interfaces:
      - {id: wan1, ip: 198.51.100.2/30}
      - {id: wan2, ip: 203.0.113.6/30}
      - {id: tun0}
    routes:
      - {prefix: 0.0.0.0/0, via: 198.51.100.1, name: default via ISP A}
      - {prefix: 0.0.0.0/0, via: 203.0.113.5, distance: 250, name: floating default}
      - {prefix: 10.10.0.0/16, via: 198.51.100.1, distance: 10}    # these two: equal-cost
      - {prefix: 10.10.0.0/16, via: 203.0.113.5, distance: 10}
      - {prefix: 10.30.0.0/16, interface: tun0}                    # out of an interface
      - {prefix: 192.0.2.0/24, via: 198.51.100.1, interface: wan1} # both
      - {prefix: 198.18.0.0/15, blackhole: true}                   # a null route
      - {prefix: 0.0.0.0/0, vrf: GUEST, blackhole: true}           # in a VRF
  - id: pc1
    type: endpoint
    interfaces:
      - {id: eth0, ip: 10.20.10.50/24}
    routes:
      - {prefix: 0.0.0.0/0, via: 10.20.10.1}                       # the default gateway
```

| Key | Description |
|---|---|
| `prefix` | required: the destination, an IPv4 or IPv6 prefix with its length. `0.0.0.0/0` and `::/0` are default routes. |
| `via` | the next-hop address, without a prefix length, of the same family as `prefix` |
| `interface` | the exit interface: an interface id of the same device |
| `blackhole` | `true`: traffic to the prefix is dropped (a null route). A blackhole route has no `via` and no `interface`. |
| `distance` | administrative distance, 1–255. Among routes to the same prefix the lowest distance is used; a route with a higher distance is a *floating* backup that takes over when the better one can't be used. |
| `metric` | optional, a whole number ≥ 0: among routes with the same prefix and distance the lowest metric is used |
| `vrf` | the VRF the route belongs to (the same names as `vrf` on interfaces); without it the default table |
| `name`, `description`, `attrs` | |

* A route needs a next hop: `via`, `interface`, both, or `blackhole: true`.
* Several routes may have the same prefix: with the same distance and metric
  they are **equal-cost** (all used), with a higher distance they are
  **floating** backups.
* A route is identified by its place in its device's list; in the app it is
  `route:<device>:<index>`. The order of the list means nothing else: the
  diagram, the details and the route selection sort routes by VRF,
  prefix, distance, metric and next hop.
* Errors: a missing or invalid prefix; a `via` that isn't an address (or has
  a prefix length, or the wrong family); an `interface` the device doesn't
  have; no next hop; `blackhole: true` together with `via` or `interface`; a
  distance outside 1–255; a metric that isn't a whole number ≥ 0; routes on a
  device whose type has no routing table. A prefix with bits set beyond its
  length is a *warning*: the route is for the whole prefix. A route with an
  error is left out of the model (and kept in the file).
* **Route selection** (used by the next-hop line, the details and the
  analyses): the longest matching prefix among the usable routes and the
  connected networks (every interface address with its prefix length, in the
  interface's VRF, distance 0); for that prefix the lowest distance, then the
  lowest metric; what is left is used together. **A missing `distance` is
  taken as 1** and a missing metric as 0, the usual defaults for static
  routes. A route is usable while its next hop resolves: directly connected
  (in a network of an interface of the device in the route's VRF; with an
  exit interface, in a network of that interface, unless the interface has no
  address of its own, as an unnumbered or tunnel interface), or
  **recursively** through another route of the same VRF, but **never through
  a default route**. This is a model of static routing, not of any one
  vendor's implementation.
* The **consistency checks** for routes (see [Consistency
  checks](#consistency-checks)) report a next hop that is the device's own
  address, one that is neither connected nor resolvable (or connected only
  in another VRF), one outside the exit interface's networks, an exit
  interface that can't forward (a loopback, a member port of an aggregate, a
  port without a cable, another VRF), the same route twice, and routes to one
  prefix at one distance that contradict each other.
* Display: in the **logical view** the device's box has a **route table**
  per VRF (*Routes*, *Routes · VRF GUEST*), a line per route, written
  `prefix via address dev interface AD distance metric metric` or `prefix
  blackhole` (only what is written). A route whose next hop is an interface
  of another device has a thin **dotted line with an arrow** from its line
  to that interface's row; for a route with only an exit interface, to the
  far end of its cable or to a tunnel's destination. The **Routes** switch
  (in Filters) hides tables and lines; their room stays, so nothing moves.
  The physical view doesn't show routes. Selecting a route highlights its
  device, its exit interface and the interface (and device) its next hop
  belongs to.
* Editing keeps routes valid: renaming an interface updates the routes that
  leave through it; deleting it leaves them as errors to fix.

## `links` (physical cabling only)

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `a`, `b` | yes | The two ends. `device:interface`, or just `device` when the port is unknown or irrelevant (e.g. "Internet"), or a mapping `{device, interface, speed, duplex}`. What each port carries is configured on the port ([Port VLANs](#port-vlans-access-trunk-routed)). |
| `medium` | | `fiber`, `copper`, `dac`, `aoc`, `wireless`/`lte`/`5g`/`microwave`, `serial`, `virtual`, or any other text (it gets its own colour). **The only place the medium of the connection is configured**; without it the cable is drawn as "Unspecified". |
| `speed` | | e.g. `1G`, `10G`, `100G`, `250M`. **The only place the speed of the connection is configured**; it sets the line width. |
| `direction` | | `unidirectional`: traffic only from end `a` to end `b` (simplex fibre, a data diode, a TAP or SPAN feed), drawn with an arrow at end `b`; the path tracer and the simulated traffic never use it the other way. `bidirectional` is the default and is not written. Anything else is an error. |
| `simulation` | | The cable's settings for the [protocol simulation](#simulation-parameters-and-device-attributes): `latency` (its propagation delay; a bare number is in ms, or `250us`, `2ms`), `loss` (the share of frames lost, in percent) and `flapping: true` (it flaps from the start, with the simulation's flapping times). Configured here, they take precedence over everything else. |
| `wireless_network` | wireless connections at a radio: yes | The Wi-Fi network (its `id`) of the end with Wireless access the connection is associated with: it takes that network's VLAN. An error on any other link. |
| `label`, `cable` (cable/circuit id), `description`, `attrs` | | |

Rules: a port can have at most one cable — except a radio of a Wireless
access, which takes every wireless connection associated with one of its
Wi-Fi networks (each names it in `wireless_network`). Only physical interfaces can be
cabled: a link end that names a logical interface is an error (cable the
member ports of an aggregate, or the port a tunnel is sourced from, instead).
A link can't connect a port to itself.

A link is the physical connection: one cable (or radio path) between two
ports. `cable` is only its label or circuit id. There is no separate cable
object, so `medium` and `speed` exist exactly once per connection.

### Port settings on a link end

What each port is **set to** is written at its end of the link, because the
two ends can be set differently (and a mismatch is the point of recording
them):

```yaml
links:
  - id: srv-7
    a: {device: acc1, interface: Gi1/0/7, speed: 1G, duplex: full}
    b: {device: srv7, interface: eno1, speed: 1G, duplex: full}
    speed: 1G
```

| Key | Description |
|---|---|
| `speed` | the speed the port is set to, written like the link's `speed` (`100M`, `1G`, `2.5G`, `10G` …). Compared by value: `1000M` is `1G`. |
| `duplex` | `full`, `half` or `auto`. Any other value is an error. |

* The link's own `speed` stays **the** speed of the connection: it sets the
  line width and the legend. The ends' settings are only compared: with each
  other and with the link's speed (`link-speed-mismatch`), and the duplex of
  the two ends with each other (`link-duplex-mismatch`; `auto` against a
  fixed setting is reported too, since the auto end usually falls back to
  half duplex).
* Omitted: not modelled. Nothing is assumed, nothing is compared.
* The details of a link list each end's settings; the diagram doesn't draw
  them.

### VLANs: configured on the ports

A link holds no VLANs: what a cable carries follows from its two ports'
`vlans` and `native` (see [Port VLANs](#port-vlans-access-trunk-routed)).
The cable shows what both ends carry, the networks of those VLANs, and ⚠
*VLANs differ* when they disagree. `mode`, `untagged` and `tagged` on a
link end are unknown keys; the error says where the VLANs go.

## `networks`

| Key | Description |
|---|---|
| `id` | required |
| `label` | |
| `cidr` | required: **exactly one** IPv4 or IPv6 prefix **with a prefix length**, written as one value: `10.10.10.0/24` or `2001:db8::/64`. The prefix decides who is a member. A list is an error, even a one-element list; use one network per prefix (e.g. an IPv4 and an IPv6 network for one segment, both with the same `vlan`). |
| `vlan` | the VLAN ID (1–4094) this IP network lives in, if any |
| `simulation` | the VLAN's **simulation attributes** (IGMP snooping and its querier, fast leave, unknown multicast), for every switch carrying the VLAN; only on a network with a `vlan`. See [Levels](#levels-where-an-attribute-is-written). |
| `description`, `attrs` | |

A network is always an IP network: there is no `kind`. It has no `vrf` (a VRF
is assigned on [interfaces](#interfaces)) and **no `members` list**.

### Membership (derived)

A device is a member of a network when **at least one statically configured
address of one of its interfaces (physical or logical) lies inside the
network's prefix**. An interface with `dhcp: true` has no configured
address, so it makes its device a member of nothing.
The list is computed from the current model every time it is shown. It names
the device once, with every matching interface (or loopback) and address.

```yaml
devices:
  - id: core1
    logical_interfaces:
      - {id: Vlan10, type: virtual, ip: 10.10.10.2/24}   # member of "users", VLAN 10
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}     # in no network
networks:
  - {id: users, cidr: 10.10.10.0/24, vlan: 10}         # members: core1 (Vlan10 10.10.10.2/24)
```

The exact rules:

* **The network's prefix is the authority.** Only the address part of an
  interface address is compared. The interface's own prefix length doesn't
  have to match the network's and isn't used: `10.10.10.2`, `10.10.10.2/24`,
  `10.10.10.2/16` and `10.10.10.2/32` are all inside `10.10.10.0/24`, and
  `10.10.11.2/16` is not.
* **Every address inside the prefix matches**, including the first and last
  address of the range. `/32` and `/128` match exactly one address; `/0`
  matches every address of its family.
* **IPv4 and IPv6 never match each other.** An IPv4-mapped IPv6 address
  (`::ffff:10.1.0.1`) is an IPv6 address. IPv6 addresses are compared by
  value, so upper/lower case and `::` compression don't matter.
* **Overlapping networks:** an address inside the prefixes of several
  networks (a `/24` inside a `/16`, say) belongs to **every** one of them,
  so the device is a member of each; nothing is chosen. Where the distinction
  matters it is reported, never guessed: the derived VLAN of such an address
  is shown only when all those networks agree on it, otherwise it is
  *ambiguous* with a warning (see [Interfaces](#interfaces)). Two networks
  with exactly the same prefix are a *warning*: they would list the same
  members.
* **Invalid or incomplete addresses belong to no network**: text that isn't
  an address (`dhcp`), a wrong octet or group, a prefix length that is
  missing after the slash or out of range (`10.1.0.1/`, `10.1.0.1/33`), a
  zone suffix (`fe80::1%eth0`). On an ordinary interface they are a warning
  and are shown as written; on a loopback they are an error.
* **The network's prefix must be valid.** A missing `cidr`, an empty list,
  a list of several prefixes, and a value that isn't an address with a
  prefix length are *errors*; such a network has no members until it is
  fixed, and its value is kept in the file as written. A prefix with bits
  set beyond its length (`10.10.10.9/24`) is a *warning*; the network is the
  whole `/24`.
* A device without addresses is in no network. To add a member, give one of
  its interfaces an address in the prefix.
* `vrf` on an interface doesn't take part: membership is by address only.

## `relations` (logical layer)

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `protocol` | yes | **Any** name (case-insensitive). Built-in names get a default category and colour (list below). |
| `category` | | Overrides the protocol's category. One of `tunnel`, `adjacency`, `overlay`, `redundancy`, `service`, `other`. |
| `endpoints` | yes | Two or more endpoint references. With 3+ distinct devices the relation is drawn as a hub with spokes (e.g. an OSPF area, a VXLAN VNI, DMVPN). |
| `over` | | Id, or list of ids, of the **links, relations or networks this relation is carried over** (its underlay: what it depends on). This is how GRE-over-IPsec, OSPF-over-GRE, a tunnel over specific internet uplinks, LACP over member cables, or VRRP and OSPF on a LAN segment (`over: net-users`) is expressed. Nothing is assumed when it is left out. Cycles are rejected. |
| `direction` | | `bidirectional` (the default when the key is left out) or `unidirectional`: the relation flows one way, **from the first endpoint to the last**, and is drawn with an arrow at the last endpoint's device (e.g. syslog, replication). The order of the endpoints then carries meaning. A multipoint relation (3+ devices, drawn as a hub) gets no arrow. Any other value is an error. |
| `label`, `description` | | |
| `attrs` | | **Protocol-specific attributes**, free-form (see below) |
| `simulation` | | The relation's **simulation attributes** (a VRRP group's advertisement interval, an IPsec tunnel's lifetimes and DPD, a load balancer pool's health checks, a server's response time): only what it overrides. See [Levels](#levels-where-an-attribute-is-written). |

### Protocol-specific attributes

The core model never needs to change for a new protocol. All protocol
details go into the relation's `attrs`, including what is specific to one
endpoint (endpoints themselves carry nothing but what they connect):

```yaml
- id: ipsec-hq-branch
  protocol: ipsec
  endpoints: ["hq-rtr1:ge-0/0/0", "br-rtr:wan0"]
  over: [uplink-hq, uplink-branch]
  attrs:
    ike: {version: 2, dh-group: [19, 20]}   # nested maps are flattened to "ike.version", "ike.dh-group"
    encryption: aes-256-gcm
    local-id: {hq-rtr1: hq.example, br-rtr: branch.example}
```

**Parameters the consistency checks read.** A few attribute keys have a
meaning for the [consistency checks](#consistency-checks). A value that
belongs to one endpoint is written keyed by its device (it is then
flattened to `area.r1`, `area.r2`); a single value is the same at both ends,
so it can't disagree:

```yaml
- id: ospf-r1-r2
  protocol: ospf
  endpoints: ["r1:e0", "r2:e0"]
  attrs:
    area: {r1: 0.0.0.0, r2: 0.0.0.0}            # compared: 0 and 0.0.0.0 are the same area
    network-type: {r1: point-to-point, r2: point-to-point}
    hello: {r1: 10, r2: 10}                      # seconds; and dead
- id: ebgp-r1-isp
  protocol: ebgp
  endpoints: ["r1:xe0", "isp:xe1"]
  attrs:
    peer-as: {r1: 64500, isp: 65001}             # the AS each device expects the other to be in
```

| Relations | Keys | Compared with |
|---|---|---|
| `ospf` (and its aliases) | `area`, `network-type`, `hello`, `dead`, per device | the same key of the other endpoint |
| `bgp`, `ebgp`, `ibgp` | `peer-as` per device; `type: ibgp`/`ebgp` on a plain `bgp` relation | the other device's BGP `asn` |

These keys are the protocols' [endpoint parameters](#routing-services-protocols):
the Edit tab shows them as fields of the relation, one per endpoint device.
A redundancy group's virtual address is not a relation attribute: it is the
`virtual_ip` of each member interface's group (`protocols: {vrrp: {group:
10, virtual_ip: 10.10.10.1}}`), compared with the interface's subnets.

**Parameters the path tracer reads.** The [path tracer](../README.md#path-tracer)
learns routes over the relations of the routing protocols (`ospf`, `isis`,
`eigrp`, `rip`, `bgp` and their aliases) and reads a few more keys, each a
single value or per device:

| Relations | Key | Meaning (without it) |
|---|---|---|
| routing protocols | `cost` (1–16777215) | what an adjacency adds to a route's metric, from that device (1: a hop count) |
| routing protocols | `distance` (1–255) | the administrative distance of the routes learned over it (eBGP 20, EIGRP 90, OSPF 110, IS-IS 115, RIP 120, iBGP 200) |

```yaml
- {id: ospf-muc, protocol: ospf, endpoints: ["hq-rtr1:st0.10", "muc-rtr:Tunnel10"], over: gre-muc, attrs: {cost: 100}}
```

The active member of a redundancy group is the interface whose group has
the highest `priority` (a member without one counts as 0), then the first by
device id.

**A relation names only what it rides on.** There is no field for a network
that a relation *carries* or *serves* (the VNI network of a VXLAN, the
customer networks of an L3VPN): such a network is not its underlay, so it
doesn't go into `over`. Keep the reference in `attrs` (e.g.
`attrs: {vni: 10100}`); it is shown in the details but not drawn or
highlighted. This is an intentional limitation of the format.

### How to draw a relation: categories and styles

| Category | Default style | Typical protocols |
|---|---|---|
| `tunnel` | hollow **tube** (never a plain line, so it can't be mistaken for a cable) | GRE, IPsec, IP-in-IP, WireGuard, OpenVPN, L2TP, DMVPN, GTP, RSVP-TE/SR-TE LSPs, pseudowires |
| `adjacency` | solid line | BGP (eBGP/iBGP/MP-BGP), OSPF, IS-IS, EIGRP, RIP, LDP, PIM, BFD |
| `overlay` | dashed | VXLAN, Geneve, EVPN, L3VPN, VPLS, SD-WAN, OTV |
| `redundancy` | dotted | LACP/LAG, MLAG/vPC, VRRP, HSRP, GLBP, CARP, HA sync |
| `service` | dash-dot | DNS, NTP, syslog, SNMP, RADIUS/TACACS+, DHCP relay, HTTPS, NetFlow/IPFIX |
| `other` | dash-dot | anything not categorised |

When a relation is carried `over` a **tunnel** between the same two devices,
it is drawn *inside* that tube. GRE over IPsec shows as a GRE tube inside an
IPsec tube, and OSPF over that GRE as a line inside it. Several relations
between the same pair of devices get separate parallel lanes, so none of them
hide each other.

### `protocols`: defining new protocols

Unknown protocol names are accepted without any declaration. They're drawn in
category `other` (or the relation's `category`) with a colour derived
deterministically from the name, and a warning suggests declaring them. To give
a new protocol a proper look, or to restyle a built-in one:

```yaml
protocols:
  - id: srv6            # the name used in relations (lower-case)
    label: SRv6 policy
    category: tunnel    # tunnel | adjacency | overlay | redundancy | service | other
    color: "#e03131"    # #rgb or #rrggbb only
    style: tube         # optional: tube | solid | dashed | dotted | dashdot
    description: Segment routing over IPv6
```

A protocol of the model becomes a [routing service](#routing-services-protocols)
devices can enable when it declares `params` (a list, possibly empty) or
`router_id` (`required`, `optional` or `none`: whether it uses the router
ID). Each parameter is a mapping:

| Key | Description |
|---|---|
| `key` | the parameter's YAML key (lower case, digits, `_` and `-`) |
| `label` | its name in the Edit tab (default: the key) |
| `type` | `int`, `text`, `ipv4`, `address`, `enum`, `area` or `net` (default `text`) |
| `scope` | `device`, `interface` or `endpoint` (default `device`) |
| `required` | `true`: mandatory once the protocol is enabled |
| `min`, `max` | `int`: the range |
| `values` | `enum`: the allowed values |
| `suggest` | values the Edit tab offers |
| `description` | its help text |

```yaml
protocols:
  - id: macsec
    label: MACsec
    category: other
    params:
      - {key: cipher, type: enum, values: [gcm-aes-128, gcm-aes-xpn-256], required: true}
```

The built-in routing services (the table in
[Routing services](#routing-services-protocols)) keep their parameters: a
`params` or `router_id` on their ids is an error.

Built-in protocol ids: `gre`, `ipsec`, `ipip`, `wireguard`, `openvpn`, `l2tp`,
`dmvpn`, `gtp`, `rsvp-te`, `sr-te`, `pseudowire`, `ssl-vpn`, `vxlan`, `geneve`,
`evpn`, `l3vpn`, `vpls`, `sd-wan`, `otv`, `bgp`, `ospf`, `isis`, `eigrp`, `rip`,
`ldp`, `pim`, `bfd`, `lacp`, `mlag`, `vrrp`, `hsrp`, `glbp`, `carp`,
`ha-sync`, `dns`, `ntp`, `syslog`, `snmp`, `radius`, `dhcp`, `https`,
`netflow`, `stp`, `lldp`, `cdp` and `igmp`. There are also aliases such as
`ebgp`, `ibgp`, `mp-bgp`, `ospfv3`, `is-is`, `wg`, `ikev2`, `mpls-te`, `pw`,
`lag`, `port-channel`, `vpc`, `tacacs+`, `ipfix`, `sflow`, `rstp`, `mstp` and
`mld`.

Every built-in protocol has a **simulation profile** (its messages,
transport, timers with their defaults, states, and what it does on a
failure and after a restore; `src/model/sim-profiles.ts`), used by
Simulate → Start simulation. The simulation reads these relation
attributes where they are written (they are *configured*, the first in the
[order of precedence](#order-of-precedence); else the simulation's value or
the protocol's default, as the event log says): OSPF `hello`, `dead` and `priority`; BFD
`interval` (`300ms`, `1s`) and `multiplier`; PIM `rp` (the RP: an address
or a device); IGMP `group` (default 239.1.1.1); VRRP / HSRP `preempt`
(`false` turns it off). A switch's spanning-tree bridge priority is its
simulation attribute `bridge_priority` (default 32768; per VLAN with
`bridge_priority_vlans` for MSTP and PVST), a port's cost and priority are
the port's `stp_cost` and `stp_port_priority`. A protocol the model defines
itself is simulated with dummy packets labelled with its name, in the
relation's direction.

## `demands` (traffic demands)

Optional. Traffic that flows between two points of the network, for the
protocol simulation (Simulate → Start simulation…: its data packets follow
the routing, are rerouted when a link fails, or are lost where they stop;
a multicast destination is delivered by PIM to the group's receivers). A
demand is analysis data:
it is traced like **Trace path**, never changes the network objects, and a
file means the same network with or without it.

```yaml
demands:
  - id: users-app                 # required, unique among the demands
    label: Users to the app server
    source: w-host                # a device, an interface (device:interface) or an IP address
    destination: e-srv
    bandwidth: 400M               # required: a number with k, M, G or T (bits per second)
    class: business               # optional: a traffic class, free text
    description: …                # optional
```

`source` and `destination` take what the path tracer takes. A demand is
traced from its source to its destination like Trace path; equal-cost
paths share it equally.

Validation: unknown keys, a missing `source`, `destination` or `bandwidth`,
a bandwidth that isn't one and a duplicate id are **errors**; an end that
names nothing of the model is a **warning** (the demand can't be traced and
is shown as lost). At most 2000 demands.

## Simulation parameters and device attributes

Simulate → Start simulation… opens a dialog with the simulation's
**Layer 1–4 parameters** (eight per layer): one collapsible section per
layer, every field prefilled with its
default, its unit, a short help with the default and its source, and a
range check; changed values are marked *modified*, and each section and
the whole form can be reset. The same sections are in the Simulation
window, where a change applies at once, at the current simulated time
(and is written to the event log). The values are remembered for the next
start in the same browser session; they are **never written to the
model**. What a device or a cable overrides is written in the model, in
its optional `simulation:` block (only the overrides).

### Order of precedence

One order decides which value is in effect, everywhere (the engine, the
window, the tables, the Edit tab):

1. **configured**: explicit configuration on the object in the model, for
   example a relation's OSPF `hello` / `dead` or BFD `interval` /
   `multiplier`, a cable's `simulation: {latency, loss}` or `speed`, an
   interface's `mtu`;
2. **object**: the simulation attribute written on the object itself, at
   its [level](#levels-where-an-attribute-is-written): an interface's, a
   VLAN's (its network's), a relation's, a DHCP scope's or a DNS zone's
   `simulation:`;
3. **device**: the device's simulation attribute (`simulation:` on it): a
   device-level attribute, or the device-wide default of an object-level
   attribute that allows one (the tables say which);
4. **simulation**: the simulation-wide value (the dialog, the window);
5. **default**: the built-in common default, with its source.

Wherever a value is shown it says where it comes from: *configured on …*,
*interface …* / *VLAN …* / *relation …* / *scope …* / *zone …*, *device*,
*simulation* or *default* (with its source). A derived timer
follows its base: OSPF's dead interval is 4 × the hello interval, BGP's
hold time 3 × the keepalive. A cable's latency and loss come from the
cable, else from one of its devices (a cloud's `latency` and `loss`: the
larger of the two ends), else from the simulation.

### Levels: where an attribute is written

Every simulation attribute belongs to the level real devices configure it
at, and is written in that object's `simulation:` block:

| Level | Written in | Examples |
|---|---|---|
| device | the device's `simulation:` | boot time, ECMP paths, the spanning-tree mode and bridge priority, a firewall's policy |
| interface | a port's, an aggregate's or a logical interface's `simulation:` | ARP timers, link-up delay, a port's spanning-tree cost, edge port and BPDU guard, IGMP, a DHCP client's retries |
| VLAN | the `simulation:` of a network with a `vlan` | IGMP snooping, the snooping querier, fast leave |
| relation | a relation's `simulation:` | a VRRP group's advertisement interval, an IPsec tunnel's lifetimes, a load balancer pool's health checks |
| service | a DHCP scope's or a DNS zone's `simulation:`; a Hypervisor service's, a virtual switch's or a Container engine's | the offer delay and ping check of a scope, a zone's record TTL; the VM restart time, the teaming failover detection, the container start time |

Some object-level attributes may also be written on the device, as the
default for its objects (the column *Also device-wide*): `stp_edge: on` on
a switch makes every port an edge port unless a port says otherwise. An
attribute written at a level it doesn't belong to is an **error** that
names its level; it is never moved automatically. In the Edit tab each
object has a collapsed *Simulation* subsection with its attributes, each
showing whether it is inherited (and from where), overridden, or reset.

### The parameters

The tables below are generated from the registry
(`src/analysis/sim/params.ts`). A duration may be written with a unit
(`250us`, `300ms`, `30s`, `5min`, `4h`); a bare number is in the unit the
attribute names (seconds, or milliseconds for latencies, BFD, the route
recomputation delay, the ICMP rate limit and the beacon interval). A
choice of on and off may also be written `true` / `false`. A list
(`allow`, `listening`, `test_targets`) is one text with commas or a YAML
list; `none` is an empty one. A per-VLAN value (`bridge_priority_vlans`) is
a list of `VLAN: value` pairs, ranges allowed.

#### Layer 1 – Physical (8)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| Link latency | 100 µs | 0 s – 10 s | about 20 km of fibre (5 µs per km); a cable in one building is far shorter | attribute `latency` (device); configured: a cable’s simulation: latency |
| Packet loss | 0 % | 0 % – 100 % | a healthy link loses nothing | attribute `loss` (device); configured: a cable’s simulation: loss |
| Loss-of-signal detection | 0 s | 0 s – 1 min | Junos hold-time down 0 ms (Cisco carrier-delay is the same idea) | attribute `los_detection` (interface) |
| Link-up delay | 2 s | 0 s – 5 min | 1000BASE-T autonegotiation and link training (IEEE 802.3 clauses 28 and 40) take about 2 s | attribute `link_up_delay` (interface) |
| Default speed | 1 Gbit/s | 1 kbit/s – 1600 Gbit/s | 1000BASE-T, the usual access port | configured: a cable’s speed |
| Flapping: down time | 5 s | 100 ms – 1 h | a demonstration value |  |
| Flapping: up time | 10 s | 100 ms – 1 h | a demonstration value |  |
| Flapping: cycles | 3 (0: continuous) | 0 (continuous) – 1000 | a demonstration value |  |

#### Layer 2 – Data link (8)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| ARP timeout | 4 h | 1 s – 2147483 s | Cisco IOS (4 h); RFC 826 sets none | attribute `arp_timeout` (interface) |
| ARP retransmit interval | 1 s | 100 ms – 1 min | RFC 4861 RETRANS_TIMER (used for ARP as well) | attribute `arp_retransmit` (interface) |
| ARP retries | 3 | 1 – 10 | RFC 4861 MAX_MULTICAST_SOLICIT (used for ARP as well) | attribute `arp_retries` (interface) |
| NDP reachable time | 30 s | 1 s – 1 h | RFC 4861 REACHABLE_TIME | attribute `ndp_reachable_time` (interface) |
| MAC aging time | 5 min | 10 s – 1000000 s | IEEE 802.1D-2004 recommended ageing time | attribute `mac_aging` (device) |
| Spanning tree | RSTP | `rstp`, `mstp`, `pvst`, `stp`, `off` | IEEE 802.1D-2004 (RSTP, the default of current switches) | attribute `stp_mode` (device) |
| IGMP / MLD snooping | On | `on`, `off` | on by default on current switches (Cisco IOS, Junos; RFC 4541) | attribute `igmp_snooping` (VLAN) |
| Default MTU | 1500 | 68 – 65535 | RFC 894 (IP over Ethernet) | configured: an interface’s mtu |

#### Layer 3 – Network (8)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| Default TTL / hop limit | 64 | 1 – 255 | RFC 1700 (IANA); Linux, macOS and most routers | attribute `ttl` (device) |
| Send ICMP errors | On | `on`, `off` | RFC 1812 §4.3 and RFC 4443 (routers and hosts send them) | attribute `icmp_errors` (interface) |
| OSPF hello interval | 10 s | 1 s – 65535 s | RFC 2328 Appendix C.3 | configured: an OSPF relation’s hello and dead |
| BGP keepalive | 1 min | 1 s – 21845 s | Cisco IOS: keepalive 60 s, hold 180 s; RFC 4271 §10 suggests 30 s and 90 s | configured: a BGP relation’s keepalive and hold |
| BFD interval | 300 ms | 3 ms – 10 s | a common configuration (RFC 5880 sets none) | configured: a BFD relation’s interval and multiplier |
| BFD multiplier | 3 | 1 – 255 | a common configuration (RFC 5880 sets none) | configured: a BFD relation’s multiplier |
| VRRP advertisement interval | 1 s | 10 ms – 40.95 s | RFC 5798 §5.2.7 (100 centiseconds) | attribute `vrrp_advert` (relation) |
| IGMP / MLD query interval | 125 s | 1 s – 3175 s | RFC 3376 §8.2 and RFC 3810 §9.2 (125 s) | attribute `igmp_query_interval` (interface) |
| Route recomputation delay | 200 ms | 0 s – 1 min | Junos spf-options delay (200 ms) | attribute `spf_delay` (device) |

#### Layer 4 – Transport (8)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| TCP SYN retries | 6 | 0 – 20 | Linux net.ipv4.tcp_syn_retries (about 127 s in all) | attribute `tcp_syn_retries` (device) |
| TCP initial retransmission timeout | 1 s | 10 ms – 1 min | RFC 6298 §2.1 |  |
| TCP keepalive time | 2 h | 1 s – 24 h | RFC 1122 §4.2.3.6 (at least 2 h); Linux tcp_keepalive_time | attribute `tcp_keepalive` (device) |
| Reply to closed ports | On | `on`, `off` | RFC 9293 §3.10.7.1 (RST) and RFC 1122 §3.2.2.1 (port unreachable) | attribute `closed_port_reply` (device) |
| Endpoint test traffic | Off | `on`, `off` | off, so that the timeline shows the protocols alone until it is wanted | attribute `test_traffic` (device) |
| Test traffic interval | 5 s | 100 ms – 1 h | a demonstration value | attribute `test_interval` (device) |
| Test traffic type | ICMP echo | `icmp`, `tcp`, `udp`, `multicast` | ping, the usual first test | attribute `test_type` (device) |
| Application response timeout | 5 s | 100 ms – 10 min | dig’s default timeout (5 s); Windows ping waits 4 s | attribute `app_timeout` (device) |

#### Device attributes (44)

| Key | Attribute | Default | Range | Source of the default | Applies to | Also device-wide |
|---|---|---|---|---|---|---|
| `latency` | Link latency (ms) | 100 µs | 0 s – 10 s | about 20 km of fibre (5 µs per km); a cable in one building is far shorter | clouds |  |
| `loss` | Packet loss | 0 % | 0 % – 100 % | a healthy link loses nothing | clouds |  |
| `mac_aging` | MAC aging time (s) | 5 min | 10 s – 1000000 s | IEEE 802.1D-2004 recommended ageing time | switches |  |
| `stp_mode` | Spanning tree | RSTP | `rstp`, `mstp`, `pvst`, `stp`, `off` | IEEE 802.1D-2004 (RSTP, the default of current switches) | switches |  |
| `ttl` | Default TTL / hop limit | 64 | 1 – 255 | RFC 1700 (IANA); Linux, macOS and most routers | devices with an address |  |
| `spf_delay` | Route recomputation delay (ms) | 200 ms | 0 s – 1 min | Junos spf-options delay (200 ms) | routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |  |
| `tcp_syn_retries` | TCP SYN retries | 6 | 0 – 20 | Linux net.ipv4.tcp_syn_retries (about 127 s in all) | devices with an address |  |
| `tcp_keepalive` | TCP keepalive time (s) | 2 h | 1 s – 24 h | RFC 1122 §4.2.3.6 (at least 2 h); Linux tcp_keepalive_time | devices with an address |  |
| `closed_port_reply` | Reply to closed ports | On | `on`, `off` | RFC 9293 §3.10.7.1 (RST) and RFC 1122 §3.2.2.1 (port unreachable) | devices with an address |  |
| `test_traffic` | Endpoint test traffic | Off | `on`, `off` | off, so that the timeline shows the protocols alone until it is wanted | endpoints |  |
| `test_interval` | Test traffic interval (s) | 5 s | 100 ms – 1 h | a demonstration value | endpoints |  |
| `test_type` | Test traffic type | ICMP echo | `icmp`, `tcp`, `udp`, `multicast` | ping, the usual first test | endpoints |  |
| `app_timeout` | Application response timeout (s) | 5 s | 100 ms – 10 min | dig’s default timeout (5 s); Windows ping waits 4 s | endpoints |  |
| `boot_time` | Boot time (s) | 30 s (container 2 s, vm 20 s, router 1 min, firewall 1 min, vpn_gateway 1 min, security_gateway 1 min, load_balancer 1 min) | 0 s – 1 h | a demonstration value (containers start in seconds, chassis routers in minutes) | every device |  |
| `max_paths` | Maximum ECMP paths | 4 | 1 – 64 | Cisco IOS maximum-paths (4) | routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |  |
| `mac_table_size` | MAC table size | 8192 | 1 – 1000000 | a small access switch (data sheets: 8 K–16 K entries) | switches |  |
| `stp_hello` | STP hello time (s) | 2 s | 1 s – 10 s | IEEE 802.1D-2004 Table 17-1 | switches |  |
| `stp_forward_delay` | STP forward delay (s) | 15 s | 4 s – 30 s | IEEE 802.1D-2004 Table 17-1 | switches |  |
| `stp_max_age` | STP max age (s) | 20 s | 6 s – 40 s | IEEE 802.1D-2004 Table 17-1 | switches |  |
| `bridge_priority` | Bridge priority | 32768 | 0 – 61440 | IEEE 802.1D-2004 §17.13.7 (32768) | switches |  |
| `bridge_priority_vlans` | Bridge priority per VLAN | empty: the bridge priority in every VLAN | a value, or per VLAN: `4096, 20: 8192, 30-39: 12288` | MSTP instances and Rapid PVST+ (one tree per VLAN) | switches |  |
| `ha_failover` | HA failover detection (s) | 3 s | 100 ms – 5 min | a common setting (3 missed heartbeats of 1 s) | firewalls |  |
| `fail_mode` | When it fails | Fail open | `open`, `closed` | the hardware bypass of most inline appliances | IDS / IPS |  |
| `inspection_latency` | Inspection latency (ms) | 0 s | 0 s – 10 s | none unless set (see the appliance’s data sheet) | IDS / IPS |  |
| `restart_policy` | Restart policy | No | `no`, `always`, `on-failure`, `unless-stopped` | Docker (no) | containers |  |
| `snmp_interval` | SNMP polling interval (s) | 1 min | 1 s – 24 h | a demonstration value (300 s is common in production) | systems and SNMP managers |  |
| `snmp_timeout` | SNMP timeout (s) | 1 s | 100 ms – 1 min | net-snmp (1 s) | systems and SNMP managers |  |
| `association_time` | Client association time (s) | 1 s | 0 s – 1 min | a demonstration value (WPA2-PSK takes well under a second, 802.1X longer) | access points |  |
| `client_idle_timeout` | Client idle timeout (s) | 5 min | 10 s – 24 h | Cisco WLC user idle timeout (300 s) | access points |  |
| `respond_to_broadcast_ping` | Respond to broadcast ping | Off | `on`, `off` | Linux icmp_echo_ignore_broadcasts (RFC 1122 §3.2.2.6 allows ignoring them) | devices with an address |  |
| `icmp_rate_limit` | ICMP error rate limit (ms) | 500 ms | 0 s – 1 min | Cisco IOS ip icmp rate-limit unreachable (500 ms); RFC 1812 §4.3.2.8 | devices with an address |  |
| `default_action` | Default action | Drop | `drop`, `reject` | the implicit deny of PAN-OS and Cisco ASA (silent) | firewalls |  |
| `allow` | Also permits | empty: nothing more | a list: `tcp/443`, `udp/53`, `tcp/8000-8080`, `icmp`, `any`; `none` | none: the model’s relations through it are its policy | firewalls |  |
| `stateful` | Stateful | On | `on`, `off` | every current firewall | firewalls |  |
| `tcp_session_timeout` | TCP session timeout (s) | 1 h | 1 s – 168 h | PAN-OS (3600 s) | firewalls |  |
| `tcp_handshake_timeout` | TCP handshake timeout (s) | 5 s | 1 s – 1 h | PAN-OS tcp-init (5 s) | firewalls |  |
| `udp_session_timeout` | UDP session timeout (s) | 30 s | 1 s – 168 h | PAN-OS (30 s) | firewalls |  |
| `icmp_session_timeout` | ICMP session timeout (s) | 6 s | 1 s – 1 h | PAN-OS (6 s) | firewalls |  |
| `listening` | Listening services | empty: its service relations’ ports | a list: `tcp/443`, `udp/53`, `tcp/8000-8080`, `icmp`, `any`; `none` | the ports of the service relations it serves | servers, VMs, containers, storage; load balancers; proxies |  |
| `test_targets` | Test targets | empty: its gateway and service relations | a list: a device, `device:interface` or an address (or a host name), each optionally with `tcp/<port>`, `udp/<port>` or `icmp`; `none` | its gateway and the servers of its service relations | endpoints |  |
| `spt_switchover` | SPT switchover | Immediately | `immediately`, `never` | Cisco IOS spt-threshold 0 (immediately) | routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |  |
| `router_port_aging` | Router port aging (s) | 5 min | 10 s – 1 h | Cisco IOS multicast router port (5 min) | switches |  |
| `multicast` | Carries multicast | Off | `on`, `off` | the internet routes no multicast | clouds |  |
| `icmp_probe_interval` | ICMP probe interval (s) | 1 min | 1 s – 24 h | Zabbix simple checks (1 min) | systems and SNMP managers |  |

#### Interface attributes (33)

| Key | Attribute | Default | Range | Source of the default | Applies to | Also device-wide |
|---|---|---|---|---|---|---|
| `los_detection` | Loss-of-signal detection (ms) | 0 s | 0 s – 1 min | Junos hold-time down 0 ms (Cisco carrier-delay is the same idea) | ports |  |
| `link_up_delay` | Link-up delay (s) | 2 s | 0 s – 5 min | 1000BASE-T autonegotiation and link training (IEEE 802.3 clauses 28 and 40) take about 2 s | ports |  |
| `arp_timeout` | ARP timeout (s) | 4 h | 1 s – 2147483 s | Cisco IOS (4 h); RFC 826 sets none | interfaces with an address | yes |
| `arp_retransmit` | ARP retransmit interval (s) | 1 s | 100 ms – 1 min | RFC 4861 RETRANS_TIMER (used for ARP as well) | interfaces with an address | yes |
| `arp_retries` | ARP retries | 3 | 1 – 10 | RFC 4861 MAX_MULTICAST_SOLICIT (used for ARP as well) | interfaces with an address | yes |
| `ndp_reachable_time` | NDP reachable time (s) | 30 s | 1 s – 1 h | RFC 4861 REACHABLE_TIME | interfaces with an address | yes |
| `icmp_errors` | Send ICMP errors | On | `on`, `off` | RFC 1812 §4.3 and RFC 4443 (routers and hosts send them) | interfaces with an address | yes |
| `igmp_query_interval` | IGMP / MLD query interval (s) | 125 s | 1 s – 3175 s | RFC 3376 §8.2 and RFC 3810 §9.2 (125 s) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …); switches | yes |
| `stp` | Spanning tree on this port | On | `on`, `off` | every port takes part (Cisco, Junos) | switch ports and their aggregates of switches |  |
| `stp_cost` | Port path cost | by speed (802.1D-2004: 20 000 at 1 Gbit/s) | 0 (by speed) – 200000000 | IEEE 802.1D-2004 Table 17-3 (20 Tbit/s ÷ speed) | switch ports and their aggregates of switches |  |
| `stp_port_priority` | Port priority | 128 | 0 – 240 | IEEE 802.1D-2004 §17.13.10 (128) | switch ports and their aggregates of switches |  |
| `stp_edge` | Edge port (PortFast) | Off | `on`, `off` | off unless configured (Cisco spanning-tree portfast) | switch ports and their aggregates of switches | yes |
| `stp_bpdu_guard` | BPDU guard | Off | `on`, `off` | off unless configured (Cisco spanning-tree bpduguard) | switch ports and their aggregates of switches | yes |
| `stp_root_guard` | Root guard | Off | `on`, `off` | off unless configured (Cisco spanning-tree guard root) | switch ports and their aggregates of switches |  |
| `stp_link_type` | Link type | Auto | `auto`, `point-to-point`, `shared` | IEEE 802.1w (auto: by duplex) | switch ports and their aggregates of switches |  |
| `lacp_rate` | LACP rate | Slow | `slow`, `fast` | IEEE 802.1AX (slow periodic time) | aggregates (LAGs) of devices with an aggregate (LACP) |  |
| `beacon_interval` | Beacon interval (ms) | 102.4 ms | 10 ms – 10 s | IEEE 802.11 (100 TU = 102.4 ms) | access-point radios of access points |  |
| `respond_to_ping` | Respond to ping | On | `on`, `off` | RFC 1122 §3.2.2.6 (every host answers echo requests) | interfaces with an address | yes |
| `directed_broadcast` | Forward directed broadcasts | Off | `on`, `off` | RFC 2644 (off by default since 1999) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |  |
| `storm_control_broadcast` | Storm control: broadcast | off | 0 (off) – 100000000 | off unless configured (Cisco storm-control) | switch ports and their aggregates of switches |  |
| `storm_control_multicast` | Storm control: multicast | off | 0 (off) – 100000000 | off unless configured (Cisco storm-control) | switch ports and their aggregates of switches |  |
| `dhcp_retries` | DHCP retries | 4 | 1 – 20 | RFC 2131 §4.1 (4, 8, 16, 32 s: about a minute) | DHCP clients (`dhcp: true`) |  |
| `dhcp_backoff` | DHCP retransmission delay (s) | 4 s | 100 ms – 64 s | RFC 2131 §4.1 (4 s, doubled each time up to 64 s) | DHCP clients (`dhcp: true`) |  |
| `link_local_fallback` | Link-local fallback | Off | `on`, `off` | off unless set (RFC 3927: Windows and macOS use it) | DHCP clients (`dhcp: true`) |  |
| `igmp_version` | IGMP / MLD version | IGMPv3 / MLDv2 | `v3`, `v2` | Linux, Windows and current routers (RFC 3376, RFC 3810) | interfaces with an address | yes |
| `unsolicited_report_interval` | Unsolicited report interval (s) | by version: v2 10 s, v3 1 s | 0 (by version: v2 10 s, v3 1 s) – 1 min | RFC 2236 §8.10 (10 s) and RFC 3376 §8.11 (1 s) | interfaces with an address | yes |
| `igmp_querier` | IGMP / MLD querier | On | `on`, `off` | on where a router runs PIM or IGMP (Cisco IOS, Junos) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) | yes |
| `igmp_max_response` | Query response interval (s) | 10 s | 100 ms – 25 s | RFC 3376 §8.3 (10 s) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …); switches | yes |
| `igmp_robustness` | Robustness variable | 2 | 1 – 7 | RFC 3376 §8.1 (2) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …); switches | yes |
| `last_member_query_interval` | Last member query interval (s) | 1 s | 100 ms – 25 s | RFC 3376 §8.8 (1 s) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …); switches | yes |
| `pim_dr_priority` | PIM DR priority | 1 | 0 – 4294967295 | RFC 7761 §4.3.2 (1) | routed interfaces (of a router or another Layer 3 device) of routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |  |
| `multicast_passthrough` | Multicast passthrough | Off | `on`, `off` | firewalls drop multicast unless configured (PAN-OS, Cisco ASA) | interfaces with an address of firewalls |  |
| `multicast_to_unicast` | Multicast to unicast | Off | `on`, `off` | off unless configured (Cisco VideoStream, Aruba) | access-point radios of access points |  |

#### VLAN attributes (4)

| Key | Attribute | Default | Range | Source of the default | Applies to | Also device-wide |
|---|---|---|---|---|---|---|
| `igmp_snooping` | IGMP / MLD snooping | On | `on`, `off` | on by default on current switches (Cisco IOS, Junos; RFC 4541) | every switch carrying the VLAN | yes |
| `snooping_querier` | Snooping querier | Off | `on`, `off` | off unless configured (Cisco ip igmp snooping querier) | every switch carrying the VLAN |  |
| `fast_leave` | Fast leave | Off | `on`, `off` | off unless configured (Cisco immediate-leave) | every switch carrying the VLAN |  |
| `unknown_multicast` | Unknown multicast | Flood in the VLAN | `flood`, `drop` | flooding until a member reports (RFC 4541 §2.1.2 allows it) | every switch carrying the VLAN |  |

#### Relation attributes (13)

| Key | Attribute | Default | Range | Source of the default | Applies to | Also device-wide |
|---|---|---|---|---|---|---|
| `vrrp_advert` | VRRP advertisement interval (s) | 1 s | 10 ms – 40.95 s | RFC 5798 §5.2.7 (100 centiseconds) | `vrrp`, `hsrp`, `carp`, `glbp` relations |  |
| `ike_lifetime` | IKE SA lifetime (s) | 24 h | 1 min – 8760 h | Cisco IKEv2 (86 400 s) | `ipsec` relations | yes |
| `child_lifetime` | Child SA lifetime (s) | 1 h | 1 min – 8760 h | Cisco IOS and strongSwan (1 h) | `ipsec` relations | yes |
| `rekey_margin` | Rekey margin (s) | 9 min | 0 s – 24 h | strongSwan margintime (9 min) | `ipsec` relations | yes |
| `dpd_interval` | DPD interval (s) | 10 s | 1 s – 1 h | a common setting (RFC 7296 sets none) | `ipsec` relations | yes |
| `dpd_retries` | DPD retries | 3 | 1 – 20 | a common setting | `ipsec` relations | yes |
| `response_time` | Service response time (ms) | 0 s | 0 s – 1 min | none unless set | a server’s service relations | yes |
| `health_check_interval` | Health check interval (s) | 2 s | 100 ms – 1 h | HAProxy inter (2 s) | a load balancer’s pool (its member relations) |  |
| `health_check_timeout` | Health check timeout (s) | 2 s | 100 ms – 10 min | HAProxy timeout check (defaults to inter) | a load balancer’s pool (its member relations) |  |
| `health_check_threshold` | Health check failure threshold | 3 | 1 – 100 | HAProxy fall (3) | a load balancer’s pool (its member relations) |  |
| `persistence_timeout` | Persistence timeout (s) | 3 min | 0 s – 24 h | F5 BIG-IP source address affinity (180 s) | a load balancer’s pool (its member relations) |  |
| `algorithm` | Balancing algorithm | Round robin | `round-robin`, `least-connections`, `source-hash` | HAProxy and F5 BIG-IP (round robin) | a load balancer’s pool (its member relations) |  |
| `multicast_over_tunnel` | Multicast over tunnels | On | `on`, `off` | GRE carries multicast; plain IPsec does not (RFC 4301) | `ipsec`, `gre`, `vxlan`, `wireguard`, `openvpn`, `l2tp` relations | yes |

#### Service attributes (8)

| Key | Attribute | Default | Range | Source of the default | Applies to | Also device-wide |
|---|---|---|---|---|---|---|
| `offer_delay` | Offer delay (ms) | 0 s | 0 s – 1 min | none unless set (Windows Server: a delay for the secondary of a split scope) | a DHCP server’s scopes | yes |
| `ping_check` | Ping check before offering | Off | `on`, `off` | Windows Server conflict detection (0 attempts: off) | a DHCP server’s scopes | yes |
| `record_ttl` | Record TTL (s) | 1 h | 0 s – 168 h | a common zone default (1 h) | a DNS server’s zones |  |
| `vm_restart` | VM restart time (s) | 1 min | 0 s – 1 h | a demonstration value (HA failure detection plus the restart) | a Hypervisor service (`services.hypervisor.simulation`) |  |
| `failover_detection` | Teaming failover detection (ms) | 1 s | 0 s – 1 min | a demonstration value (link-status failover detection takes about a second) | a virtual switch |  |
| `container_start` | Container start time (s) | 2 s | 0 s – 10 min | a demonstration value (a container starts in seconds) | a Container engine service (`services.container_engine.simulation`) |  |
| `transfer_delay` | Transfer delay (ms) | 1 ms | 0 s – 1 min | a demonstration value (a security gateway inspects what it transfers) | a Security gateway's Domain separation (`services.separation.simulation`) |  |
| `transfer_loss` | Transfer loss (%) | 0 % | 0 % – 100 % | none unless set | a Security gateway's Domain separation (`services.separation.simulation`) |  |

| Device type | Device-wide simulation attributes |
|---|---|
| Router (`router`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `igmp_query_interval`, `spf_delay`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `max_paths`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `igmp_version`, `unsolicited_report_interval`, `igmp_querier`, `igmp_max_response`, `igmp_robustness`, `last_member_query_interval`, `spt_switchover` |
| Switch (`switch`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `mac_aging`, `stp_mode`, `igmp_snooping`, `ttl`, `icmp_errors`, `igmp_query_interval`, `spf_delay`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `max_paths`, `mac_table_size`, `stp_hello`, `stp_forward_delay`, `stp_max_age`, `bridge_priority`, `bridge_priority_vlans`, `stp_edge`, `stp_bpdu_guard`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `igmp_version`, `unsolicited_report_interval`, `igmp_querier`, `igmp_max_response`, `igmp_robustness`, `last_member_query_interval`, `spt_switchover`, `router_port_aging` |
| Firewall (`firewall`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `igmp_query_interval`, `spf_delay`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `max_paths`, `ha_failover`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `default_action`, `allow`, `stateful`, `tcp_session_timeout`, `tcp_handshake_timeout`, `udp_session_timeout`, `icmp_session_timeout`, `igmp_version`, `unsolicited_report_interval`, `igmp_querier`, `igmp_max_response`, `igmp_robustness`, `last_member_query_interval`, `spt_switchover` |
| Access point (`ap`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `association_time`, `client_idle_timeout`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `igmp_version`, `unsolicited_report_interval` |
| Load balancer (`load_balancer`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `igmp_query_interval`, `spf_delay`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `max_paths`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `listening`, `igmp_version`, `unsolicited_report_interval`, `igmp_querier`, `igmp_max_response`, `igmp_robustness`, `last_member_query_interval`, `spt_switchover` |
| IDS/IPS (`ids_ips`) | `boot_time`, `fail_mode`, `inspection_latency` |
| VPN gateway (`vpn_gateway`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `igmp_query_interval`, `spf_delay`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `max_paths`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `igmp_version`, `unsolicited_report_interval`, `igmp_querier`, `igmp_max_response`, `igmp_robustness`, `last_member_query_interval`, `spt_switchover`, `multicast_over_tunnel` |
| Security gateway (`security_gateway`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `igmp_version`, `unsolicited_report_interval` |
| Server (`server`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `response_time`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `listening`, `igmp_version`, `unsolicited_report_interval` |
| Virtual machine (`vm`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `igmp_query_interval`, `spf_delay`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `max_paths`, `response_time`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `listening`, `igmp_version`, `unsolicited_report_interval`, `igmp_querier`, `igmp_max_response`, `igmp_robustness`, `last_member_query_interval`, `spt_switchover` |
| Container (`container`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `response_time`, `restart_policy`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `listening`, `igmp_version`, `unsolicited_report_interval` |
| Storage (`storage`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `response_time`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `listening`, `igmp_version`, `unsolicited_report_interval` |
| Endpoint (`endpoint`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `test_traffic`, `test_interval`, `test_type`, `app_timeout`, `boot_time`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `test_targets`, `igmp_version`, `unsolicited_report_interval` |
| Cloud (`cloud`) | `latency`, `loss`, `boot_time`, `multicast` |
| System (`system`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `icmp_errors`, `tcp_syn_retries`, `tcp_keepalive`, `closed_port_reply`, `boot_time`, `snmp_interval`, `snmp_timeout`, `respond_to_ping`, `respond_to_broadcast_ping`, `icmp_rate_limit`, `igmp_version`, `unsolicited_report_interval`, `icmp_probe_interval` |

Validation reports, as errors: an unknown key in a `simulation:` block
(with a suggestion), an attribute written at the wrong level (it names the
right one), an attribute that does not apply to the device's
type or the object (the table above; the Edit tab lists the ones that apply to the
device itself, e.g. LACP only with an aggregate, the VPN attributes only on
a gateway or an IPsec endpoint), a value out of its range, and a value
that isn't one (a duration without a known unit, a speed that isn't one,
a choice that isn't offered).

```yaml
devices:
  - id: core1
    type: switch
    layer3: true
    simulation: {arp_timeout: 300, mac_aging: 120, stp_mode: stp, spf_delay: 50ms}
  - id: inet
    type: cloud
    simulation: {latency: 15, loss: 0.5}
  - id: fw1
    type: firewall
    simulation: {default_action: reject, allow: "tcp/443, icmp", udp_session_timeout: 60}
  - id: web
    type: server
    simulation: {listening: [tcp/443, tcp/80], respond_to_ping: false}
  - id: pc1
    type: endpoint
    simulation: {test_traffic: "on", test_targets: "web tcp/443, 10.0.0.53 udp/53"}
  - id: lab-sw1
    type: switch
    simulation: {stp_mode: "off"}
    interfaces:
      - {id: p1, vlans: 10, simulation: {storm_control_broadcast: 1000, stp_edge: "on", stp_bpdu_guard: "on"}}
      - {id: up2, vlans: [10, 20], simulation: {stp_cost: 200000}}
networks:
  - {id: users, cidr: 10.10.10.0/24, vlan: 10, simulation: {snooping_querier: "on"}}
relations:
  - {id: gw, protocol: vrrp, endpoints: [core1, core2], simulation: {vrrp_advert: 300ms}}
links:
  - {id: uplink2, a: "acc-sw:up2", b: "core2:down1", simulation: {flapping: true}}
```

### Multicast

An interface may join groups and send streams (`multicast:`), for the
protocol simulation:

```yaml
devices:
  - id: pc2
    type: endpoint
    interfaces:
      - id: eth0
        ip: 10.10.20.22/24
        multicast:
          join:
            - 239.1.1.1                                     # any source (ASM)
            - {group: 232.1.1.1, sources: [10.30.0.30]}     # source-specific (SSM)
  - id: mcsrc
    type: server
    interfaces:
      - id: eth0
        ip: 10.30.0.30/24
        multicast:
          streams:
            - {group: 239.1.1.1, port: 5004, interval: 2s, size: 1316}
```

| Key | Description |
|---|---|
| `join` | groups: an address, or `{group, sources}`. A group is in 224.0.0.0/4 or ff00::/8 and not link-local (224.0.0.0/24, ff02::/16: those are never joined or routed). A source-specific group (232.0.0.0/8, ff3x::/32) needs its `sources` (unicast addresses of the same family), and a device whose simulation sets `igmp_version: v2` cannot join with a source list. A group is joined once per interface. |
| `streams` | UDP streams: `group` (required), `port` (1–65535, default 5004, RTP), `interval` (a duration, default 1 s; a bare number in seconds), `size` (bytes, 1–65000, default 1316: seven MPEG-TS packets). |

The interface needs an address. An IGMP relation's `group` attribute is a
join of its host end too, and a demand to a group is a stream (UDP 5001).
PIM's rendezvous point is a router's `protocols: {pim: {rp: …}}`, else a PIM
relation's `rp`, else the candidate RP (`candidate_rp: yes`) with the
highest router ID.

What the simulation does with them:

- **IGMPv2 / IGMPv3 and MLDv1 / MLDv2** (the device's `igmp_version`): every
  router that runs PIM (or is the router end of an IGMP relation) with its
  querier on takes part in the querier election of its subnets (the lowest
  address queries every query interval; another takes over after the
  other-querier-present interval, robustness × query interval + response
  interval ÷ 2). A host reports a join at once and again after the
  unsolicited report interval, answers a query after a random delay (from
  the seed) up to the response interval, and (v2) sends none when it heard
  another member's report first. A leave (IGMPv2 Leave, MLDv1 Done, a v3 /
  MLDv2 report that blocks the sources) brings robustness group-specific
  queries, one last member query interval apart; unanswered, the group
  goes. A membership not reported for robustness × query interval +
  response interval expires. Reports: v2 to the group, v3 to 224.0.0.22,
  MLDv2 to ff02::16 (ICMPv6 143), all with TTL 1.
- **Snooping** (per switch and VLAN, RFC 4541): router ports from queries
  and PIM Hellos (for the router-port aging time), member ports from
  reports (for the membership interval; with fast leave a leave removes the
  port at once). Reports go to the router ports only; a group's data to its
  member and router ports; a group without members is flooded or, with
  `unknown_multicast: drop`, sent to the router ports only; link-local
  groups are always flooded; with snooping off everything is flooded. A
  switch with `snooping_querier: on` queries a VLAN that has no router port
  (from its VLAN interface's address, else 0.0.0.0).
- **PIM sparse mode**: the designated router of a segment (the highest
  `pim_dr_priority`, then address) joins (*, G) towards the RP for its
  members, hop by hop along the unicast route (each RPF neighbour must be
  a PIM neighbour; while it is not, the join is tried again every 5 s).
  Joins are refreshed every 60 s and held 210 s; a router with no outgoing
  interface left prunes upstream. A source's first-hop router sends its data
  to the RP in Registers until the RP, which joins (S, G) towards the
  source, gets it natively and answers with a Register-Stop. A last-hop
  router joins (S, G) at the first packet (`spt_switchover: immediately`;
  `never` stays on the shared tree) and prunes the source off the shared
  tree ((S, G, rpt)). **SSM** groups are joined (S, G) towards each source,
  without an RP. **Dense mode** floods to every PIM neighbour and member
  interface; a router without receivers, or one that got a copy on another
  interface than its RPF interface, prunes it (for 210 s); a new member
  grafts it back.
- **The RPF check**: data that arrives on another interface than the one
  towards its source (or the RP, on the shared tree) is dropped. When the
  unicast routes change, every entry's RPF interface is checked again: a
  join to the new neighbour, a prune to the old one; the receivers miss the
  stream until the tree is rebuilt (logged when one receives nothing for
  three intervals).
- **Never routed**: link-local groups and packets with TTL 1 (each router
  decrements it). A router without PIM routes no multicast; a firewall only
  with `multicast_passthrough: on`; a cloud carries routed multicast only
  with `multicast: on`; a tunnel carries it only with its router's
  `multicast_over_tunnel` on (GRE carries multicast; plain IPsec does not).
  An access point with `multicast_to_unicast: on` sends a group to its
  wireless client as unicast frames.
- **Tests**: a UDP datagram to a group (Send test…, or test traffic of the
  multicast type: to every group joined in the model) is answered by
  nobody; the test lists the members that received it.

The window's **Multicast** section (and a host's menu) joins a group or
starts a stream as a network event, ended by **Leave group** / **Stop
stream**; the groups and streams of the model can be left or stopped the
same way. **Show IGMP groups** (a router: its interfaces' querier state and
groups, with the last reporter, version, sources and expiry), **Show
multicast table** (a switch: per VLAN and group the member ports and router
ports) and **Show multicast routes** (a router: (*, G) and (S, G) with their
RPF interface and neighbour, outgoing interfaces and flags, and the RP)
show the state, with the timers in effect.

### Layers 3 and 4, and broadcast

What the parameters and attributes above act on (the simulation is a
teaching and design-review model, not a protocol implementation; see the
README's limitations):

- **ICMP errors** (ICMPv6 for IPv6): *net unreachable* (a router without a
  route; type 3 code 0, ICMPv6 1/0), *host unreachable* (a next hop that
  does not answer ARP or neighbour solicitations after its retries; 3/1,
  ICMPv6 1/3), *TTL exceeded* (11/0, ICMPv6 3/0), *fragmentation needed*
  (DF set and a smaller MTU on the way; 3/4 with the MTU, ICMPv6 *packet
  too big* 2/0: IPv6 routers never fragment), *port unreachable* (a closed
  UDP port; 3/3, ICMPv6 1/4), *administratively prohibited* (a firewall
  that rejects; 3/13, ICMPv6 1/1), *reassembly time exceeded* (fragments
  missing after 30 s, Linux `ipfrag_time`). An error quotes the header of
  the packet it is about; its source is the address of the interface it
  is sent from (RFC 1812 §4.3.2.4). None is sent about an ICMP error, a
  fragment but the first, or a broadcast or multicast packet (an IPv6
  packet too big excepted, RFC 4443 §2.4), none where *Send ICMP errors* is
  off, at most one per the device's *ICMP error rate limit*; a blackhole
  route drops silently. A sender's own failure (no route, no ARP answer,
  larger than its own MTU) ends its test at once, without an ICMP error on
  the wire.
- **MTU and fragmentation**: an interface's MTU is its `mtu`, else the
  default MTU. An IPv4 packet without DF is cut into fragments (multiples
  of 8 bytes) and reassembled at its destination; with DF, or IPv6, it is
  dropped with the error above, and the sender lowers its **path MTU** to
  that destination (PMTUD, RFC 1191 / RFC 8201): TCP sends smaller segments.
- **TCP** (RFC 9293): the three-way handshake; an unanswered SYN is sent
  again after the initial retransmission timeout, doubling each time
  (RFC 6298, at most 120 s), until the SYN retries are spent (the
  connection times out); unacknowledged data the same way (up to 15
  times, Linux `tcp_retries2`); a closed port answers with a RST; the
  client closes with FIN (TIME_WAIT 60 s); a connection kept open is
  probed after the keepalive time, then 9 probes 75 s apart (Linux), and
  reset when none is answered. BGP's TCP connection retransmits its SYN
  the same way before its ConnectRetry timer. **UDP**: a request is
  answered from an open port, else ICMP port unreachable (never for a
  broadcast or multicast destination). With *Reply to closed ports* off,
  nothing answers.
- **Listening services**: a device listens on its `listening` ports, else
  on the ports of the relations it serves (their profile's transport, e.g.
  HTTPS TCP 443, DNS UDP 53; both ends of BGP or LDP; a load balancer
  also on the ports it passes requests on to; a protocol break on its
  transfer profiles' ports). A request of a
  relation to a port its `listening` leaves out is refused like any other.
- **Firewalls** (routing ones): the traffic of the model's relations (and
  of its demands, and tests between a service relation's endpoints on its
  port) is their policy and passes; anything else passes when it belongs to
  a session (stateful: replies, and ICMP errors about them) or when their
  `allow` list permits it (which opens a session), else the default action
  drops it, or rejects it (TCP RST from the destination's address, else
  ICMP administratively prohibited). Sessions time out by the timeouts
  (half-open, TCP, UDP, ICMP; a closed TCP session after 15 s, PAN-OS
  `tcp-time-wait`). Stateless, each packet is checked alone, a reply by its
  source port.
- **Test traffic**: an endpoint with test traffic on pings its gateway (its
  default route's next hop) and tests the servers of its service relations
  on their protocol and port, every test interval; its `test_targets`
  replace that list (a target without a test gets the test type: TCP to
  port 80, UDP to port 53). A test without an answer within the
  application response timeout fails. **Send test…** runs one test from
  any device to a device, an interface, an address, a subnet broadcast,
  255.255.255.255 or a multicast group, with the data size, DF and (TCP)
  keeping the connection open.
- **Load balancers and proxies** are full proxies for TCP: a client's
  connection ends at them; a load balancer passes the request to a
  healthy pool member (the servers of its own service relations) by its
  algorithm, a client keeping its member within the persistence timeout;
  health checks every interval (a TCP handshake, else the member's
  protocol), a member down after the failure threshold, up again at the
  first success. A Security gateway that breaks the protocol ends the
  request (leg 1) and opens a connection of its own to its transfer
  profile's forward address (leg 2), when its policy permits; the answer
  goes back on leg 1, and a transfer it does not permit is reset.
- **Monitoring**: a device that polls agents by SNMP pings each every ICMP
  probe interval (unanswered after 500 ms, fping's default).
- **Broadcast**: a broadcast frame (ff:ff:ff:ff:ff:ff) is flooded to every
  port of its VLAN but the one it came in on, trunks included, and never
  crosses a router. A router takes 255.255.255.255 itself and forwards it
  nowhere; a packet to a connected subnet's broadcast address goes out as a
  broadcast only where *forward directed broadcasts* is on (off by default,
  RFC 2644). A host answers a broadcast ping only with *respond to
  broadcast ping* on (off by default, as Linux). IPv6 has no broadcast: its
  all-nodes group ff02::1 (multicast) takes its place. **Highlight
  broadcast domain** (a device's or a cable's menu) marks the devices,
  ports and cables a broadcast from there reaches now.
- **Loops and storms**: a switch with its spanning tree `off` blocks none
  of its ports; a loop whose switches all run none stays open, and a
  flooded frame that comes back circulates and multiplies (a broadcast
  storm: a warning in the banner and the window, MAC addresses moving
  between ports). A frame is followed for 6 rounds (a real one circulates
  until the loop is broken). Storm control at a port (frames per second,
  broadcast and multicast) drops the looping frames: a loop forwards at
  line rate, above any threshold. The storm is over when the loop is
  broken (a cable down, a spanning tree on).
- **Wireless**: a client silent for its access point's client idle
  timeout is disassociated (the access point's frames to it are dropped);
  its next frame, and a link that comes back, waits for the next beacon
  (beacons at whole multiples of the beacon interval) and the association
  time.

Every message carries its headers: the **packet inspector** (a dot, or a
message of the event log) shows the frame layer by layer: source and
destination MAC (what a broadcast or multicast MAC is, and how an IP group
maps to it: 01:00:5e + the low 23 bits, 33:33 + the low 32 bits), the
802.1Q tag on that cable, the IP headers (outermost first: TTL, DF,
protocol, length, fragment), the transport header (ports, TCP flags,
ICMP type and code with the quoted header) and what it carries. A relation's
message has its profile's transport (OSPF IP 89, BGP TCP 179 …).

### DHCP and DNS

With DHCP and DNS servers in the model
([Network services](#network-services-services-dhcp-and-dns-servers)),
the simulation runs their exchanges (protocols *DHCP* and *DNS*, group
Services):

* **DHCP (RFC 2131).** A client's interface starts without an address. As
  soon as its link is up it broadcasts a DHCPDISCOVER; a server in its
  broadcast domain gets it, or a relay there (`dhcp_relay`) forwards it as
  unicast with its own address as `giaddr`. The server offers the
  client's reservation, the address it had, else the first free one of the
  scope's range (not excluded, leased or reserved; with the ping check, none
  that answers), after its offer delay: "DHCPOFFER 10.10.10.100 · lease
  1 d". The client requests it, the server acknowledges, and the lease
  applies: the address (with a gratuitous ARP), the gateway as its default
  route, the DNS servers as its resolver's. Clients run in parallel;
  everything else a client sends waits for its lease (logged as a wait).
  It renews at T1 (half the lease) by unicast, rebinds at T2 (7/8) by
  broadcast, and loses the address when the lease ends. A pool without a
  free address does not answer a DISCOVER; a request for an address it
  can't give gets a DHCPNAK. Without an offer the client tries again after
  its retransmission delay (`dhcp_backoff`, doubled each time up to 64 s)
  for `dhcp_retries` times, then pauses five minutes; with
  `link_local_fallback` it takes a link-local address (169.254.0.0/16,
  RFC 3927) meanwhile.
* **DNS (RFC 1034 / 1035).** A host resolves a name through its DNS
  servers (from its lease, else `dns_servers`) over UDP 53: "DNS A?
  web.campus.example", answered "DNS A web.campus.example = 10.10.30.10".
  A server answers from its zones (following a CNAME within them),
  NXDOMAIN for a missing name in a zone it has, through its forwarders for
  other names (a DNS server of the model), else SERVFAIL. The resolver
  caches each answer for the record's TTL (`record_ttl` of the zone), tries
  each server twice with a 5 s timeout, and else reports a timeout. *Send
  test* and test traffic accept a host name: the resolution is a dependency
  of the connection, which waits for it.
* **Tables.** *Show DHCP leases* on a DHCP server (each lease with its
  client, address and expiry, under its scopes' settings), *Show DNS zone*
  on a DNS server (every record with its TTL and source) and *Show DNS
  cache* on a host (each cached name with its server and what is left of
  its TTL).

Simplifications: IPv4 only for DHCP (no DHCPv6); one lease per interface;
no DHCPDECLINE, DHCPRELEASE or DHCPINFORM; no relay agent information
(option 82); offers are broadcast; no negative caching, DNSSEC or TCP
fallback, and no recursion beyond the model's DNS servers.

### What the parameters do

* **Layer 1.** A frame takes its cable's latency plus its serialization
  time (its size at the cable's speed, the default speed when the cable
  has none); frames on one cable and direction go one after the other. A
  share of frames is lost where the packet loss says, from a fixed seed. A
  cable that goes down (failed, flapping, a shut port, a device powered
  off) drops what is on it at once; its ports notice after the
  loss-of-signal detection time (a port whose own device took it down: at
  once). When it comes back, its ports come up after the link-up delay
  (an access point's wireless links: its association time); a loss shorter
  than the detection time is never noticed. Flapping: down for the
  flapping down time, up for the up time, for its cycles.
* **Layer 2.** The ARP and neighbour timers below; the MAC aging time and
  the MAC table size (a full table learns nothing new: frames to an
  unknown address are flooded); the spanning tree's convergence after a
  change: RSTP takes over at once at the switch at the change, after 3 ×
  the hello time (6 s) further away; STP after 2 × the forward delay
  (30 s) at the change, max age + 2 × the forward delay (50 s) further
  away. A topology change flushes the VLAN's MAC tables.
  Ports carry what they are configured with ([Port VLANs](#port-vlans-access-trunk-routed)):
  an access port sends and takes its VLAN's frames untagged; a trunk tags
  every VLAN but its native one (the packet inspector shows the 802.1Q
  tag). A VLAN interface is reached through any bridge port of its VLAN,
  answers ARP there and routes between VLANs on a Layer 3 device; the MAC
  tables learn per VLAN. A frame of a VLAN that a port doesn't allow is
  dropped, and an untagged frame between two ports whose native (or
  access) VLANs differ arrives in the other VLAN: the log explains both
  (*VLAN 30 is not allowed on the port (trunk of VLANs 10,20 (native
  10))*, *VLAN mismatch … it leaks from VLAN 10 into VLAN 20*). The
  spanning tree runs per bridge port; routed ports act at Layer 3.
* **Layer 3.** A device sends with its default TTL / hop limit (a
  protocol that sets one, e.g. OSPF's 1, keeps it). The protocols' timers
  follow the parameters through the order above. After anything that
  changes the routes (an adjacency, an interface) a router keeps using its
  old routes for its route recomputation delay (routers that recompute at
  the same moment share it; the log says *Routes recomputed at …*). Equal
  -cost next hops are used up to the device's maximum ECMP paths.
* **Devices.** Power off: its ports go dark, its tables and sessions are
  gone; power on: it boots for its boot time, then its ports come up and
  its sessions start afresh. An inline IDS / IPS that fails open passes
  frames on (nothing else); failing closed, nothing. A server's VMs and
  containers (devices of those types cabled to it) go down with it and are
  restarted after its VM restart time where another server is cabled to
  them (else when it is back). The IPsec lifetimes are rekeyed their
  margin before they end; DPD gives up after its retries. A server answers
  its service requests after its response time; an SNMP manager reports
  an agent that does not answer within its SNMP timeout as *Not
  responding*. The LACP rate is slow (30 s, timeout 90 s) or fast (1 s,
  timeout 3 s), IEEE 802.1AX.

During a simulation a change applies at once: pending periodic timers are
rescheduled (the next OSPF Hello goes at its last one plus the new
interval, or now when that has passed), the tables are checked against
their new timeouts (a shorter ARP timeout expires older entries now), and
latency, loss and flapping act from the next frame or cycle on. Each
change is written to the log, e.g. *Parameter changed: ARP timeout 4 h →
60 s (simulation)*. A device's Simulation section in the Edit tab is the
one part of the model that can be edited during a simulation: its changes
are normal edits (Undo takes them back) and apply there at once. The
timeline stays deterministic: the same model, start values and changes at
the same simulated times give the same result.

### ARP and neighbour timers

The protocol simulation keeps an **ARP table** (IPv4) and a **neighbour
table** (IPv6) for every device with an IP stack, and a **MAC table** for
every switch. They start empty and are filled only by what the simulation
resolves and learns. Their timers follow the order of precedence above;
each table shows the values in effect with where they come from:

| Timer | Device attribute | Default | Source of the default |
|---|---|---|---|
| ARP timeout | `arp_timeout` | 4 h | the Cisco IOS default (RFC 826 sets none; Linux uses neighbour unreachability detection instead) |
| NDP reachable time | `ndp_reachable_time` | 30 s | RFC 4861 §10, REACHABLE_TIME (30 000 ms) |
| Retransmit interval (ARP and NDP) | `arp_retransmit` | 1 s | RFC 4861 §10, RETRANS_TIMER (used for ARP as well) |
| Requests before an incomplete entry is dropped | `arp_retries` | 3 | RFC 4861 §10, MAX_MULTICAST_SOLICIT (used for ARP as well) |
| Delay before the first NDP probe | — | 5 s | RFC 4861 §10, DELAY_FIRST_PROBE_TIME |
| MAC aging time | `mac_aging` | 5 min | IEEE 802.1D-2004, the recommended ageing time |
| MAC table size | `mac_table_size` | 8192 | a small access switch |

An ARP entry that was used since it was learned is refreshed by a unicast
ARP Request when its timeout ends (and removed when that goes unanswered
after the retries); an unused one expires. IPv6 entries follow RFC 4861
(INCOMPLETE, REACHABLE, STALE, DELAY, PROBE). The simulation window's
**timer scale** (1:1, 1:60, 1:240, 1:3600) makes these timers run faster in
the simulation only; the values shown as in effect do not change.

### Generated MAC addresses

An interface without `mac` gets a generated one in the simulation: a
locally administered unicast address (`x2:…`), unique in the model, derived
from a fixed seed (the model's title and interfaces) and the interface's
`device:interface` id, so the same model always gives the same addresses.
They are marked *(simulated)* wherever they are shown and never written to
the model.

## Validation and limits

Validation reports **all** problems it finds (up to 200). Each one comes with
a line number, a path such as `relations.gre-1.over`, the offending source line
and, where possible, a suggestion. In the editor the same problems are shown
next to the object and field they concern.

**Errors** cover:
* a missing `netatlas:` line, or any value other than `1`;
* missing required keys, wrong value types and unknown keys (with the closest
  known key as a suggestion; custom data belongs under `attrs`);
* invalid or duplicate ids, and unknown references (devices, interfaces,
  groups, networks, `over`);
* two cables on one port, or a cable on a logical interface;
* an interface id used twice on a device (across both lists), a `type` on a
  physical interface, a logical interface without a type or with one other
  than `loopback`, `virtual` or `tunnel`;
* a member port that isn't a physical interface of the same device or is
  listed twice; a tunnel source that is neither an address nor an interface
  of the device; a tunnel destination that is neither an address nor a
  device or interface of the model; `members`, `vlan`, `source` or
  `destination` on an interface of another type;
* `dhcp` that isn't `true` or `false`, `dhcp: true` on an interface
  that also has addresses, and `dhcp: true` on a loopback;
* a DNS name that isn't a valid host name, is listed twice on a device, has
  no interface, names an unknown interface or one with `dhcp: true`, or
  lists an interface twice;
* `over` cycles;
* a relation `direction` other than `bidirectional` or `unidirectional`;
* a network without exactly one valid prefix (missing, an empty list,
  several prefixes, not a prefix);
* port VLANs: a switch port (or a switch's aggregate) without VLANs; VLAN
  IDs outside 1–4094, a bad range, a VLAN listed twice; a `native` VLAN that
  isn't one of the port's VLANs, or on an access port; `routed` where it
  doesn't apply or together with `vlans`; VLANs on an aggregate's member;
  an address on a bridge port; a subinterface for a VLAN its port carries
  as a bridge port; see [Port VLANs](#port-vlans-access-trunk-routed);
* VLAN interfaces: two for one VLAN on a device, `members` or `vlans` on
  one, a second one on a Layer 2 switch;
* static routes: see [Static routes](#static-routes);
* `mtu` outside 68–65535, `min_links` outside 1–64 or on an interface
  without members, a `router_id` that is neither an IPv4 address (without
  prefix length) nor a loopback of the device with an IPv4 address, routing
  services on a device that is not Layer 3+, unknown or misplaced protocol
  parameters, a mandatory parameter left out or a value of the wrong type,
  a link end's `duplex` other than
  `full`, `half` or `auto`;
* simulation attributes: an unknown key, one written at the wrong level
  (the message names its level: device, interface, VLAN, relation or
  service), one that doesn't apply to the device or object, a value out of
  range or not one; see [Levels](#levels-where-an-attribute-is-written);
* network services: `services` on a device that is not a server, VM or
  container; a DHCP server without a scope or a scope missing its network,
  range, gateway or DNS servers; a range outside its network, containing
  the gateway or a static address, or overlapping another scope; a bad
  lease time, exclusion, reservation or domain; a DNS server without a
  zone, a zone without a name or written twice, a bad record, a `listen`
  address that isn't the server's; a `dhcp_relay` on an interface that
  doesn't route or has no address; an address in `dns_servers`,
  `dhcp_relay`, `dns` or `forwarders` that isn't one;
* in `checks:`, an id that isn't a check, or a value other than `off`,
  `error`, `warning` or `info`;
* invalid loopback addresses, invalid VLAN IDs, and bad colours, categories
  or styles.

**Warnings** don't block rendering:
* an unknown protocol without a category;
* an address whose derived VLAN is ambiguous (overlapping networks with
  different VLANs);
* a prefix with bits beyond its length (of a network or a route), or the same
  prefix on two networks;
* a relation carried over another relation whose endpoints don't match;
* an interface address that isn't a valid IP address;
* the same address assigned twice;
* a port that is a member of two aggregates;
* a VLAN interface whose `vlan` differs from the VLAN of the network its
  address lies in, or whose VLAN no port of its device carries;
* a tunnel source address that no interface of the device has;
* the same DNS name on two devices;
* a demand whose source or destination names nothing of the model.

A file with **errors can still be opened and drawn**. Everything that
validated is shown, so an incomplete draft stays usable. Only files that
aren't valid YAML in the supported subset (or aren't a mapping) are refused
before editing.

### Consistency checks

Beyond the format's rules, NetAtlas checks whether the network the model
describes is consistent. Each check has a **stable id**, a severity
(**error**, **warning** or **info**), a message, every object it concerns and
a place to jump to; the Problems tab lists the findings with their check id,
and the Edit tab shows each one at its field. Findings never make a model
invalid, and they are reported only while the format has no errors.

**A check runs only on data that is present.** Where a value it compares is
missing, it says nothing; no default is assumed (a router's port without
VLANs is routed, not "access in VLAN 1").

| Id | Severity | Finds | Reads |
|---|---|---|---|
| `route-nexthop-self` | error | a next hop that is an address of the device itself | routes: `via`; interfaces: `ip` |
| `route-nexthop-interface` | error | a next hop outside the networks of the route's exit interface (not checked for an interface without an address) | routes: `via`, `interface`; interfaces: `ip` |
| `route-nexthop-unresolved` | error | a next hop that is neither in a network directly connected to the device in the route's VRF nor resolvable through another route (it names the VRF when the next hop is connected in another one) | routes: `prefix`, `via`, `interface`, `vrf`, `blackhole`; interfaces: `ip`, `vrf` |
| `route-nexthop-recursive` | info | a next hop that resolves through another route | the same |
| `route-exit-interface` | error | an exit interface that can't forward the route: a loopback, a member port of an aggregate, a physical port without a cable, an interface in another VRF | routes: `interface`, `vrf`; interfaces: `type`, `members`, `vrf`; links |
| `route-duplicate` | warning | the same route twice (prefix, next hop, distance, metric, VRF) | routes |
| `route-conflict` | warning | a blackhole and a forwarding route to one prefix at the same distance; routes via the same next hop at the same distance with different metrics | routes |
| `vlan-access-mismatch` | warning | access ports in different VLANs at the two ends of a cable (the cable joins the two VLANs) | interfaces: `vlans` (of the ports at both ends of a link) |
| `vlan-trunk-mismatch` | warning | trunks with different VLAN lists at the two ends (a VLAN only one end allows is dropped by the other); a routed port with subinterfaces counts as a trunk of their VLANs | interfaces: `vlans` |
| `vlan-native-mismatch` | error | trunks whose native VLANs differ, or one with a native VLAN and one without (untagged frames leak into another VLAN or are dropped) | interfaces: `vlans`, `native` |
| `vlan-access-trunk` | warning | an access port cabled to a trunk whose native VLAN isn't the access port's VLAN | interfaces: `vlans`, `native` |
| `vlan-unknown` | warning | VLANs on a port that no network and no VLAN interface defines (VLAN 1, the default VLAN, aside) | interfaces: `vlans`; networks and VLAN interfaces: `vlan` |
| `lag-member-vlans` | warning | members of an aggregate whose far ends carry different VLANs (a bundle carries the same VLANs on every member) | logical interfaces: `members`, `vlans`, `native`; interfaces: `vlans`, `native` at the far ends; links |
| `link-mtu-mismatch` | warning | different MTUs at the two ends of a cable | interfaces: `mtu`; links |
| `tunnel-mtu` | warning | a tunnel interface whose MTU plus the encapsulation overhead (table below) is larger than the MTU of its underlay; the message names the overhead assumed and the largest MTU that fits | tunnel interfaces: `mtu`, `source`; the MTU of the source interface, else of the device's ports on the links in `over`; the tunnel relations bound to it and the tunnels they ride on |
| `link-speed-mismatch` | warning | port speeds that differ between the ends, or from the link's speed | links: `speed`, `a`/`b` `speed` |
| `link-duplex-mismatch` | error | duplex that differs between the ends | links: `a`/`b` `duplex` |
| `lag-member-speed` | warning | member links of one aggregate with different speeds | virtual interfaces: `members`; links: `speed`, `a`/`b` `speed` |
| `lag-peer-devices` | error | an aggregate whose member links end on several devices, which no `mlag` (or `vpc`) relation pairs | virtual interfaces: `members`; links; `mlag` relations |
| `lag-min-links` | warning | an aggregate with fewer cabled member ports than `min_links` | virtual interfaces: `members`, `min_links`; links |
| `link-subnet-mismatch` | error | addresses at the two ends of a cable in different subnets (per IP version, where both ends have one with a prefix length) | interfaces: `ip`; links |
| `address-reserved` | error | an IPv4 network or broadcast address used as an interface address (not for /31 and /32) | interfaces: `ip`; networks: `cidr` (for an address without a prefix length) |
| `vip-outside-subnet` | error | a group's virtual address outside its interface's subnet | interfaces: `protocols` (`virtual_ip`, `virtual_ipv6` of VRRP, HSRP, GLBP, CARP), `ip` |
| `fhrp-group-mismatch` | warning | members of one virtual address in different groups | interfaces: `protocols` (`group`, `virtual_ip`) |
| `duplicate-router-id` | error | the same router ID on two devices of one protocol domain (devices that relations of the protocol join) | devices: `router_id`, `protocols` (a protocol's own `router_id`); relations of each protocol |
| `protocol-not-enabled` | warning | a Layer 3+ device that is an endpoint of a protocol's relation but does not enable the protocol | relations; devices: `protocols` |
| `protocol-unused` | info | a protocol enabled on a device but used by none of its relations (a redundancy protocol: by no interface group) | devices: `protocols`; relations |
| `duplicate-mac` | warning | the same MAC address on two interfaces (compared without separators and case) | interfaces: `mac` |
| `vswitch-uplink-vlan` | error | a port group's VLAN that the switch port at an uplink of its virtual switch doesn't carry (the VLAN can't leave the host) | `services.hypervisor`: `vswitches` (`uplinks`, `port_groups`); links; interfaces: `vlans`, `native` (at the uplinks' far ends) |
| `vnic-network-vlan` | warning | a VM's (or host interface's) address in a network of another VLAN than its port group's (a passthrough vnic: than its port's) | logical interfaces (`vnic`): `port_group`, `passthrough`, `ip`; port groups; networks: `cidr`, `vlan`; links |
| `container-parent-vlan` | warning | a macvlan or ipvlan network whose subnet is the network of another VLAN than its parent interface's | `services.container_engine`: `networks` (`parent`, `subnet`); interfaces; networks: `cidr`, `vlan`; links |
| `ha-restart-portgroup` | warning | a VM of an HA cluster that can't restart on another member: a port group of its vnics is missing there, or it has a passthrough port | `services.hypervisor`: `cluster`, `port_groups`; VMs: `host`; vnics: `port_group`, `passthrough` |
| `hypervisor-overcommit` | info | a hypervisor whose VMs have more vCPUs or memory than its `cpu` or `ram` | `services.hypervisor`: `cpu`, `ram`; VMs: `host`, `vcpu`, `ram` |
| `ospf-area-mismatch` | error | an OSPF adjacency whose ends are in different areas | OSPF relations: `area.<device>` |
| `ospf-network-type-mismatch` | warning | different OSPF network types at the two ends | OSPF relations: `network-type.<device>` |
| `ospf-timer-mismatch` | error | different hello or dead intervals at the two ends | OSPF relations: `hello.<device>`, `dead.<device>` |
| `bgp-peer-as` | error | a peer AS that is not the other device's AS | BGP relations: `peer-as.<device>`; devices: `protocols.bgp.asn` |
| `bgp-session-type` | error | iBGP between devices in different AS numbers, or eBGP within one | `ibgp`/`ebgp` relations (or `bgp` with `type`); devices: `protocols.bgp.asn` |
| `tunnel-endpoint-mismatch` | error | a tunnel whose destination is not what its peer is sourced from | tunnel relations between two tunnel interfaces; tunnel interfaces: `source`, `destination`; interfaces: `ip` |
| `tunnel-underlay` | warning | a tunnel whose `over` does not connect its endpoints (links join their two devices, networks their members, relations their devices) | tunnel relations: endpoints, `over` |
| `vrf-name-case` | warning | VRF names that differ only in case (the spelling used most is taken as meant; the others are reported) | interfaces: `vrf`; routes: `vrf` |
| `relation-vrf-mismatch` | warning | a relation between interfaces in different VRFs (only where both name a VRF: a VRF interface facing one without, as a provider edge facing a customer, is normal) | relation endpoints; interfaces: `vrf` |
| `multicast-no-querier` | warning | an interface that joins a group in a subnet where no multicast router (PIM, its querier not off) has an interface, and no switch on its Layer 2 way is a snooping querier | interfaces: `multicast.join`, `ip`; devices: `protocols.pim`, simulation `igmp_querier`, `snooping_querier`; links |
| `multicast-no-rp` | warning | routers in PIM sparse mode and any-source groups joined or streamed, but no rendezvous point (no `rp`, no `candidate_rp: yes`, no relation `rp`) | devices: `protocols.pim`; relations: `rp`; interfaces: `multicast` |
| `multicast-rpf-not-pim` | warning | a PIM router whose unicast route towards a stream's source (or the RP) leaves through an interface to a device it has no PIM relation with there: joins cannot go that way and the traffic fails the RPF check | devices: `protocols.pim`, `routes`; interfaces: `multicast.streams`, `ip`; PIM relations |

**Encapsulation overhead** assumed by `tunnel-mtu`, per packet, with an IPv4
outer header (an IPv6 outer header adds 20 bytes more, which the check
doesn't assume). A tunnel stack (GRE over IPsec) adds up the overheads of
all its layers; a tunnel protocol not in the table is not checked.

| Protocol | Bytes | Made of |
|---|---|---|
| `gre` | 24 | 20 IP + 4 GRE |
| `ipip` | 20 | 20 IP |
| `ipsec` | 73 | ESP tunnel mode, worst case: 20 IP + 8 ESP + 16 IV + 15 padding + 2 trailer + 12 ICV (the real figure depends on cipher and padding) |
| `wireguard` | 60 | 20 IP + 8 UDP + 32 WireGuard |
| `vxlan` | 50 | 14 Ethernet + 20 IP + 8 UDP + 8 VXLAN |
| `geneve` | 50 | without options: 14 Ethernet + 20 IP + 8 UDP + 8 Geneve |
| `l2tp` | 40 | L2TPv3 over UDP: 20 IP + 8 UDP + 12 L2TP |
| `gtp` | 36 | GTP-U: 20 IP + 8 UDP + 8 GTP |

#### `checks`: switching checks off

A model can switch a check off or give it another severity, in the
top-level `checks` mapping (check id → `off`, `error`, `warning` or `info`):

```yaml
checks:
  relation-vrf-mismatch: off        # route leaking between VRFs is intended here
  duplicate-mac: info
```

A check that isn't listed keeps its default. In the editor, **Model
settings → Consistency checks** lists every check with its default and
writes this section (choosing the default removes the entry); the Problems
tab names the checks the model changes.

| Limit | Value |
|---|---|
| File size | 2 MiB |
| Lines | 100 000 |
| Nesting depth | 32 |
| YAML nodes | 250 000 |
| Scalar length | 10 000 characters |
| Groups / devices / links / networks / relations | 500 / 1 000 / 5 000 / 2 000 / 5 000 |
| Interfaces per device / total (physical and logical together) | 512 / 20 000 |
| Endpoints per relation | 64 |
| Group nesting | 8 levels |
| Attributes per entity | 100 |

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
| Physical connectivity | `links` | Physical view | A real cable / radio link between two ports, with the layer-2 tagging of each end |
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
| The VLANs a port carries | `mode`, `untagged`, `tagged` on each end of the link (`a`, `b`) | the networks a cable carries (the networks of those VLANs), the "VLANs differ" mark, the cables listed with a network, the VLAN checks |
| Speed and medium of a physical connection | `speed` and `medium` on the link | cable width, colour and label |
| The VRF of an interface | `vrf` on the interface | — |
| The member ports of a bond / aggregate | `members` on the virtual interface | highlighting of the ports and their cables |
| The VLAN of a VLAN interface | `vlan` on the virtual interface, or (when that is left out) the `vlan` of the network containing its address | — |
| Which ports a VLAN interface uses | the tagging of the link ends (nothing on the interface) | *Ports carrying its VLAN* of the virtual interface |
| What a relation depends on | `over` on the relation (links, relations or networks) | highlighting of the underlay path |
| The interface a tunnel is sourced from, when its source is written as an address | the `ip` of the interface that has the address | the tunnel's source interface (highlighting, details) |
| Where a static route leads | `routes` on the device (`via`, `interface`) and the `ip` of interfaces | the interface its next hop belongs to, how the next hop resolves, the next-hop line in the logical view |

Three facts about networks are easy to confuse and are deliberately separate;
none is derived from another:

* **Membership** (IP containment, *derived*): a device is a member of a
  network when a configured address of one of its interfaces lies inside the
  network's prefix. It says nothing about cables.
* **Link-end tagging** (layer-2 carriage, *configured* per end): `mode`,
  `untagged` and `tagged` on a link end say which VLANs *that port* carries,
  untagged or tagged. The networks a cable carries follow from it: the
  networks whose `vlan` is one of those VLANs. Tagging doesn't make anyone a
  member and isn't derived from the port's addresses. The two ends are
  independent.
* **Relation underlay** (dependency, *configured*): `over` on a relation
  says what the relation rides on — links, other relations or networks.

And separately: **`vlan` on a network** says which VLAN an IP subnet lives
in. It answers "which VLAN is 10.10.10.0/24?" and gives interfaces with an
address in the subnet their (derived) VLAN. VLANs are referenced by their ID
everywhere: on a network, on a VLAN interface and on a link end. There is no
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
mapping accepts `device`, `interface` and the tagging keys `mode`, `untagged`
and `tagged` (see [VLAN tagging](#vlan-tagging-on-a-link-end)). A link end can
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
| `kind` | | Free text, e.g. `site`, `building`, `floor`, `room`, `rack`, `provider`, `cloud`, `zone`. There is no default: a group without a kind is drawn as a plain box. `site`/`campus`/`building`/`datacenter`/`region` are emphasised; `provider`/`cloud`/`external` are drawn dashed. The kind is shown in the group's title bar and in the legend. |
| `parent` | | Id of the enclosing group (at most 8 levels) |
| `description`, `attrs` | | |

## `devices`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name. Drawn in full: long labels wrap, and line breaks in the label are kept (see [Sizes, labels and routes](#sizes-labels-and-routes)). |
| `type` | | One of the [device types](#device-types) below, written exactly as listed (lower case). Any other value is an error. Without a type the device gets a generic icon. |
| `layer3` | | Switches only: `layer3: true` makes a switch a **Layer 3 switch**, with the full Layer 3+ feature set (routing protocols, a router ID, addresses on several interfaces, VRRP / HSRP groups, tunnels, VRFs). Without it a switch is a **Layer 2 switch** (see [Layer 2 and Layer 3 switches](#layer-2-and-layer-3-switches)). On any other type it is an error. |
| `group` | | Id of the group the device is located in |
| `tier` | | 0–9: vertical row in the physical view (0 = top). By default this comes from the type (see the table below). Set it to place a device elsewhere, e.g. `tier: 3` for core or spine switches above the access switches. |
| `router_id` | | The router ID the device's protocols share: the id of one of its **loopbacks** (`lo0`: its IPv4 address is used) or an **IPv4 address** without a prefix length (`10.255.0.1`). Applies only while an enabled protocol uses a router ID (OSPF, BGP, EIGRP, LDP); otherwise it is reported as not applicable. See [Routing services](#routing-services-protocols). |
| `simulation` | | The device's **simulation attributes**, for the [protocol simulation](#simulation-parameters-and-device-attributes): only what it overrides, e.g. `simulation: {arp_timeout: 300, spf_delay: 50ms, boot_time: 2min}`. Everything else it inherits from the simulation's values or the defaults. |
| `protocols` | | The **routing services** the device runs, with their parameters: `protocols: {bgp: {asn: 65001}, ospf: {}}`. Layer 3+ devices only (a switch with `layer3: true`). See [Routing services](#routing-services-protocols). |
| `description`, `attrs` | | |
| `interfaces` | | List of the device's **physical interfaces** (its ports, below). The shorthand `interfaces: [eth0, eth1]` is allowed. |
| `logical_interfaces` | | List of the device's **logical interfaces** (below): loopbacks, virtual interfaces and tunnel interfaces. |
| `dns_names` | | List of the device's **DNS names**, each associated with one or more of its interfaces. See [DNS names](#dns-names). |
| `routes` | | List of the device's **static routes**. See [Static routes](#static-routes). Only devices whose type has a routing table may have them. |

A device has no `vendor`, `model`, `role` or `mgmt` key; like every key the
format doesn't define, each is an error ("unknown key"). Such facts can be
kept as free-form `attrs`, which are shown in the details only. A device has
no `asn` either: the AS number is BGP's parameter (`protocols: {bgp: {asn:
65001}}`), and `asn` on the device is reported as an unknown key that names
where it belongs.

### Routing services (`protocols`)

A Layer 3+ device (router, Layer 3 switch, firewall, load balancer, proxy, gateway:
the [device types](#device-types) whose routing role is *router*, the same
list as for the routers among [static routes](#static-routes)) lists the
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
| `pim` | `mode` (`sparse`, `dense`, `ssm`) | | | |
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

| Display name | `type` | Default `tier` | Layer 3 (static routes) |
|---|---|---|---|
| Router | `router` | 1 | forwards |
| Switch | `switch` | 4 | with `layer3: true` forwards (a Layer 3 switch); else a Layer 2 switch: host (a management address and routes, never forwarding) |
| Firewall | `firewall` | 2 | forwards |
| Access point | `ap` | 5 | — |
| Server | `server` | 6 | host |
| Virtual machine | `vm` | 6 | host |
| Container | `container` | 6 | host |
| Storage | `storage` | 6 | host |
| Load balancer | `load_balancer` | 1 | forwards |
| Proxy | `proxy` | 1 | forwards |
| IDS/IPS | `ids_ips` | 2 | — |
| Gateway | `gateway` | 1 | forwards |
| Endpoint | `endpoint` | 6 | host |
| Cloud | `cloud` | 0 | — |
| System | `system` | 6 | host |
| *(no type)* | | 4 | — |

The last column says what a device of the type does at layer 3. **Layer 3+**
devices (*forwards*) route traffic between their interfaces and may have any
static route. **Hosts** have an IP stack but never forward traffic for others;
they may have routes too, typically their default gateway. An access point and
an IDS/IPS are drawn as layer-2 or transparent devices, a cloud stands for a
network outside the model, and a device without a type is unknown: routes on
any of these are an error.

Each type has its own icon, and the display name appears in the diagram
subtitle, the details, tooltips, the legend and the editor. The error for
any other value suggests the closest type (`Router` → `router`,
`load-balancer` → `load_balancer`) or lists all of them. A role such as
spine, leaf, core or border is not a type: write it into the label, the
description or `attrs`.

### Layer 2 and Layer 3 switches

A switch is a **Layer 2 switch** unless it says `layer3: true`. A Layer 2
switch forwards frames between its ports and routes nothing; it keeps a
**management address** and **static routes** (for example a default
gateway towards management). Exactly these rules apply, and validation
reports anything else on a Layer 2 switch as an error:

| A Layer 2 switch may have | It may not have (errors) |
|---|---|
| addresses on **one** interface: its management interface (a VLAN interface, or a port), or DHCP there | addresses on a second interface (that would route between subnets or VLANs) |
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
  interfaces: [p1, p2, up1]
  logical_interfaces:
    - {id: Vlan99, type: virtual, vlan: 99, ip: 10.99.0.10/24}   # its management address
  routes:
    - {prefix: 0.0.0.0/0, via: 10.99.0.1}
- id: core1
  type: switch
  layer3: true                # a Layer 3 switch: routes between VLAN 10 and 20
  logical_interfaces:
    - {id: Vlan10, type: virtual, vlan: 10, ip: 10.10.10.1/24}
    - {id: Vlan20, type: virtual, vlan: 20, ip: 10.10.20.1/24}
```

Making a switch a Layer 2 switch in the Edit tab (unticking **Layer 3**)
asks first and lists what goes with it, in one undo step: its protocols
and router ID, the groups on its interfaces, the addresses of every
interface but its management interface, the VRFs of the others, its tunnel
interfaces and routes in other VRFs. Relations at it that need routing are
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
    interfaces:                                     # physical
      - {id: Ethernet1, ip: 198.51.100.2/30}
      - {id: Ethernet51}
      - Ethernet52                                  # the short form
    logical_interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
      - {id: Port-Channel1, type: virtual, members: [Ethernet51, Ethernet52]}   # a bond
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
| `mtu` | the interface's MTU in bytes, a whole number from 68 to 65535. Omitted: not modelled (no MTU is assumed, so nothing is compared). Read by the [consistency checks](#consistency-checks) `link-mtu-mismatch` and `tunnel-mtu`. |
| `mac`, `description`, `attrs` | |

A **physical interface** has no other keys. In particular it has **no `type`
key**: every entry of `interfaces` is a physical interface, and writing
`type:` there is an error, whatever its value.

A **logical interface** additionally has:

| Key | Description |
|---|---|
| `type` | required: `loopback`, `virtual` or `tunnel`. No other value is accepted. |
| `members` | `virtual` only. See [Aggregates](#aggregates-member-ports). |
| `min_links` | `virtual` with `members` only: how many member links must be up for the aggregate to be up (1–64). See [Aggregates](#aggregates-member-ports). |
| `vlan` | `virtual` only. See [VLAN interfaces](#vlan-interfaces-ports-carrying-the-vlan). |
| `source`, `destination` | `tunnel` only. See [Tunnel interfaces](#tunnel-interfaces-source-and-destination). |

* `loopback`: an address of the device itself. See [Loopbacks](#loopbacks).
* `virtual`: every other interface that isn't a port and isn't a tunnel: a
  VLAN interface (SVI, IRB), a bond or LAG, a subinterface, a VTEP, a bridge.
  Nothing is assumed about which of these it is.
* `tunnel`: a tunnel endpoint (GRE, IPsec VTI, WireGuard …).

**A logical interface has no generic parent.** There is no "parent physical
interface" field. What a logical interface is associated with depends on
what it is, and each association is written (or derived) in the way that
fits its meaning; the three cases follow. A key on the wrong type (`members`
on a tunnel, `source` on a loopback …) is an error, never ignored.

An interface has **no** `speed` or `media` key, and a physical interface has
no `vlan` key:

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
* What the aggregate *does* (LACP towards another device, MLAG) is a
  relation with the aggregate as its endpoint.
* The physical view draws an aggregate as a bracket around its cabled member
  ports on each side of the device, named by the aggregate's id (`Po1`); the
  member ports keep their own names and cables. The logical view draws the
  aggregate as an entry of its own, and relations bound to it (LACP) start
  from its port.

#### VLAN interfaces: ports carrying the VLAN

A virtual interface that is the interface of a VLAN (an SVI, an IRB
interface) references that VLAN, not ports:

```yaml
- {id: Vlan10, type: virtual, vlan: 10, ip: 10.10.10.2/24}
- {id: Vlan20, type: virtual, ip: 10.10.20.2/24}     # VLAN 20, from the network containing 10.10.20.2
```

* `vlan` is a VLAN ID (1–4094). It may be left out when an address of the
  interface lies in a network that defines a `vlan`: the VLAN is then taken
  from that network, so it is entered once. If both are present and differ,
  a *warning* says so.
* **Ports carrying its VLAN** is derived and read-only: the physical
  interfaces of the same device whose link end carries the interface's VLAN,
  untagged or tagged (see [VLAN tagging](#vlan-tagging-on-a-link-end)).
  Nothing is entered on the interface for it, and it changes as soon as a
  link end changes. A VLAN that no link end of the device carries gives no
  ports.
* A virtual interface without a VLAN (no `vlan` and no address in a network
  with one; e.g. a plain bond or a VTEP) has no such ports.

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
  an address is written. It can't carry a DNS name (below).
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

### Static routes

`routes` lists the static routes of a device: where traffic to a
destination prefix goes. A device of a *forwarding* type (router, switch,
firewall, load balancer, proxy, gateway) may have any route; a *host*
(server, VM, container, storage, endpoint, system) may have routes too.
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
| `a`, `b` | yes | The two ends. `device:interface`, or just `device` when the port is unknown or irrelevant (e.g. "Internet"), or a mapping `{device, interface, speed, duplex, mode, untagged, tagged}`. |
| `medium` | | `fiber`, `copper`, `dac`, `aoc`, `wireless`/`lte`/`5g`/`microwave`, `serial`, `virtual`, or any other text (it gets its own colour). **The only place the medium of the connection is configured**; without it the cable is drawn as "Unspecified". |
| `speed` | | e.g. `1G`, `10G`, `100G`, `250M`. **The only place the speed of the connection is configured**; it sets the line width. |
| `direction` | | `unidirectional`: traffic only from end `a` to end `b` (simplex fibre, a data diode, a TAP or SPAN feed), drawn with an arrow at end `b`; the path tracer and the simulated traffic never use it the other way. `bidirectional` is the default and is not written. Anything else is an error. |
| `simulation` | | The cable's settings for the [protocol simulation](#simulation-parameters-and-device-attributes): `latency` (its propagation delay; a bare number is in ms, or `250us`, `2ms`), `loss` (the share of frames lost, in percent) and `flapping: true` (it flaps from the start, with the simulation's flapping times). Configured here, they take precedence over everything else. |
| `label`, `cable` (cable/circuit id), `description`, `attrs` | | |

Rules: a port can have at most one cable. Only physical interfaces can be
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

### VLAN tagging on a link end

Each end of a link says how its port carries VLANs: its **mode**, its
**untagged** VLAN and its **tagged** VLANs, by VLAN ID. The two ends are
stored separately, because they can differ:

```yaml
links:
  - id: uplink-1
    a: {device: core1, interface: Ethernet1, mode: trunk, untagged: 99, tagged: [10, 20, 100-199]}
    b: {device: acc1, interface: Gi1/0/49, mode: trunk, untagged: 99, tagged: [10, 20, 100-199]}
    medium: fiber
    speed: 10G
  - {id: srv-1, a: {device: acc1, interface: Gi1/0/1, mode: access, untagged: 20}, b: "srv1:eno1"}
  - {id: p2p, a: "r1:eth0", b: "r2:eth0"}                    # nothing about layer 2 at either end
```

| Key | Description |
|---|---|
| `mode` | `access` (one untagged VLAN) or `trunk` (tagged VLANs, plus an untagged *native* VLAN). Required when `untagged` or `tagged` is written. |
| `untagged` | a VLAN ID (1–4094): an access port's VLAN, or a trunk's native VLAN |
| `tagged` | the tagged VLANs: one ID, a range `100-199`, or a list of both (`[10, 20, 100-199]`) |

* **Nothing is assumed.** An end without a mode says nothing about layer 2:
  it is not "access in VLAN 1", and it is never compared with the other end.
  A routed port or a server NIC usually has no mode.
* **The networks a cable carries are derived**: the networks whose `vlan` is
  one of the VLANs of the end, untagged or tagged. Carriage is not
  membership: it makes no device a member of a network.
* Errors: a mode other than `access` or `trunk`; a VLAN ID outside 1–4094; a
  range whose end is lower than its start; a VLAN listed twice in `tagged`;
  `untagged` or `tagged` without a mode.
* The **VLAN checks** (see [Consistency checks](#consistency-checks)) report
  untagged (native) VLANs that differ between the two ends, trunks that tag
  different VLANs (a warning), an access port with tagged VLANs, a VLAN
  untagged at one end and tagged at the other, and VLANs that no network and
  no VLAN interface of the model defines (a warning). **Neither end is
  changed**: fix the end that is wrong.
* Display: in the **physical view** each port's label has the tagging as its
  second line, `U 10` (untagged) and `T 20,30,100-199` (tagged, in ranges),
  e.g. `U 99 · T 10,20`; an end with a mode but no VLANs shows its mode. A
  cable whose two ends disagree is marked ⚠ with *VLANs differ* in its label.
  Tooltip and details spell the tagging out (*trunk, native VLAN 99, tagged
  10,20*) and name the networks it carries. A network's details list the
  cables that carry its VLAN, and selecting a network highlights them.
  **Find** finds the cables carrying a VLAN: `vlan 20` or `20`.
* A VLAN interface's **Ports carrying its VLAN** are the ports of its device
  whose end carries that VLAN.

## `networks`

| Key | Description |
|---|---|
| `id` | required |
| `label` | |
| `cidr` | required: **exactly one** IPv4 or IPv6 prefix **with a prefix length**, written as one value: `10.10.10.0/24` or `2001:db8::/64`. The prefix decides who is a member. A list is an error, even a one-element list; use one network per prefix (e.g. an IPv4 and an IPv6 network for one segment, both with the same `vlan`). |
| `vlan` | the VLAN ID (1–4094) this IP network lives in, if any |
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
(`false` turns it off). A switch's spanning-tree priority is the device
attribute `stp-priority` (default 32768). A protocol the model defines
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
**Layer 1–3 parameters** (Layer 4 comes with the simulation of TCP and
UDP): one collapsible section per layer, every field prefilled with its
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
   `multiplier`, a cable's `simulation: {latency, loss}` or `speed`;
2. **device**: the device's simulation attribute (`simulation:` on it);
3. **simulation**: the simulation-wide value (the dialog, the window);
4. **default**: the built-in common default, with its source.

Wherever a value is shown it says where it comes from: *configured on …*,
*device*, *simulation* or *default* (with its source). A derived timer
follows its base: OSPF's dead interval is 4 × the hello interval, BGP's
hold time 3 × the keepalive. A cable's latency and loss come from the
cable, else from one of its devices (a cloud's `latency` and `loss`: the
larger of the two ends), else from the simulation.

### The parameters

The tables below are generated from the registry
(`src/analysis/sim/params.ts`). A duration may be written with a unit
(`250us`, `300ms`, `30s`, `5min`, `4h`); a bare number is in the unit the
attribute names (seconds, or milliseconds for latencies, BFD and the route
recomputation delay).

#### Layer 1 – Physical (8)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| Link latency | 100 µs | 0 s – 10 s | about 20 km of fibre (5 µs per km); a cable in one building is far shorter | device attribute `latency`; configured: a cable’s simulation: latency |
| Packet loss | 0 % | 0 % – 100 % | a healthy link loses nothing | device attribute `loss`; configured: a cable’s simulation: loss |
| Loss-of-signal detection | 0 s | 0 s – 1 min | Junos hold-time down 0 ms (Cisco carrier-delay is the same idea) |  |
| Link-up delay | 2 s | 0 s – 5 min | 1000BASE-T autonegotiation and link training (IEEE 802.3 clauses 28 and 40) take about 2 s |  |
| Default speed | 1 Gbit/s | 1 kbit/s – 1600 Gbit/s | 1000BASE-T, the usual access port | configured: a cable’s speed |
| Flapping: down time | 5 s | 100 ms – 1 h | a demonstration value |  |
| Flapping: up time | 10 s | 100 ms – 1 h | a demonstration value |  |
| Flapping: cycles | 3 (0: continuous) | continuous – 1000 | a demonstration value |  |

#### Layer 2 – Data link (6)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| ARP timeout | 4 h | 1 s – 2147483 s | Cisco IOS (4 h); RFC 826 sets none | device attribute `arp_timeout` |
| ARP retransmit interval | 1 s | 100 ms – 1 min | RFC 4861 RETRANS_TIMER (used for ARP as well) | device attribute `arp_retransmit` |
| ARP retries | 3 | 1 – 10 | RFC 4861 MAX_MULTICAST_SOLICIT (used for ARP as well) | device attribute `arp_retries` |
| NDP reachable time | 30 s | 1 s – 1 h | RFC 4861 REACHABLE_TIME | device attribute `ndp_reachable_time` |
| MAC aging time | 5 min | 10 s – 1000000 s | IEEE 802.1D-2004 recommended ageing time | device attribute `mac_aging` |
| Spanning tree | RSTP | `rstp`, `stp` | IEEE 802.1D-2004 (RSTP, the default of current switches) | device attribute `stp_mode` |

#### Layer 3 – Network (6)

| Parameter | Default | Range | Source of the default | Also |
|---|---|---|---|---|
| Default TTL / hop limit | 64 | 1 – 255 | RFC 1700 (IANA); Linux, macOS and most routers | device attribute `ttl` |
| OSPF hello interval | 10 s | 1 s – 65535 s | RFC 2328 Appendix C.3 | configured: an OSPF relation’s hello and dead |
| BGP keepalive | 1 min | 1 s – 21845 s | Cisco IOS: keepalive 60 s, hold 180 s; RFC 4271 §10 suggests 30 s and 90 s | configured: a BGP relation’s keepalive and hold |
| BFD interval | 300 ms | 3 ms – 10 s | a common configuration (RFC 5880 sets none) | configured: a BFD relation’s interval and multiplier |
| BFD multiplier | 3 | 1 – 255 | a common configuration (RFC 5880 sets none) | configured: a BFD relation’s multiplier |
| VRRP advertisement interval | 1 s | 10 ms – 40.95 s | RFC 5798 §5.2.7 (100 centiseconds) |  |
| Route recomputation delay | 200 ms | 0 s – 1 min | Junos spf-options delay (200 ms) | device attribute `spf_delay` |

#### Device attributes

| Key | Attribute | Default | Range | Source of the default | Applies to |
|---|---|---|---|---|---|
| `latency` | Link latency (ms) | 100 µs | 0 s – 10 s | about 20 km of fibre (5 µs per km); a cable in one building is far shorter | clouds |
| `loss` | Packet loss | 0 % | 0 % – 100 % | a healthy link loses nothing | clouds |
| `arp_timeout` | ARP timeout (s) | 4 h | 1 s – 2147483 s | Cisco IOS (4 h); RFC 826 sets none | devices with an address |
| `arp_retransmit` | ARP retransmit interval (s) | 1 s | 100 ms – 1 min | RFC 4861 RETRANS_TIMER (used for ARP as well) | devices with an address |
| `arp_retries` | ARP retries | 3 | 1 – 10 | RFC 4861 MAX_MULTICAST_SOLICIT (used for ARP as well) | devices with an address |
| `ndp_reachable_time` | NDP reachable time (s) | 30 s | 1 s – 1 h | RFC 4861 REACHABLE_TIME | devices with an address |
| `mac_aging` | MAC aging time (s) | 5 min | 10 s – 1000000 s | IEEE 802.1D-2004 recommended ageing time | switches |
| `stp_mode` | Spanning tree | RSTP | `rstp`, `stp` | IEEE 802.1D-2004 (RSTP, the default of current switches) | switches |
| `ttl` | Default TTL / hop limit | 64 | 1 – 255 | RFC 1700 (IANA); Linux, macOS and most routers | devices with an address |
| `spf_delay` | Route recomputation delay (ms) | 200 ms | 0 s – 1 min | Junos spf-options delay (200 ms) | routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |
| `boot_time` | Boot time (s) | 30 s (container 2 s, vm 20 s, router 1 min, firewall 1 min, gateway 1 min, load_balancer 1 min) | 0 s – 1 h | a demonstration value (containers start in seconds, chassis routers in minutes) | every device |
| `max_paths` | Maximum ECMP paths | 4 | 1 – 64 | Cisco IOS maximum-paths (4) | routers and Layer 3 devices (Layer 3 switches, firewalls, gateways …) |
| `mac_table_size` | MAC table size | 8192 | 1 – 1000000 | a small access switch (data sheets: 8 K–16 K entries) | switches |
| `stp_hello` | STP hello time (s) | 2 s | 1 s – 10 s | IEEE 802.1D-2004 Table 17-1 | switches |
| `stp_forward_delay` | STP forward delay (s) | 15 s | 4 s – 30 s | IEEE 802.1D-2004 Table 17-1 | switches |
| `stp_max_age` | STP max age (s) | 20 s | 6 s – 40 s | IEEE 802.1D-2004 Table 17-1 | switches |
| `lacp_rate` | LACP rate | Slow | `slow`, `fast` | IEEE 802.1AX (slow periodic time) | devices with an aggregate (LACP) |
| `ha_failover` | HA failover detection (s) | 3 s | 100 ms – 5 min | a common setting (3 missed heartbeats of 1 s) | firewalls |
| `fail_mode` | When it fails | Fail open | `open`, `closed` | the hardware bypass of most inline appliances | IDS / IPS |
| `inspection_latency` | Inspection latency (ms) | 0 s | 0 s – 10 s | none unless set (see the appliance’s data sheet) | IDS / IPS |
| `ike_lifetime` | IKE SA lifetime (s) | 24 h | 1 min – 8760 h | Cisco IKEv2 (86 400 s) | gateways and IPsec endpoints |
| `child_lifetime` | Child SA lifetime (s) | 1 h | 1 min – 8760 h | Cisco IOS and strongSwan (1 h) | gateways and IPsec endpoints |
| `rekey_margin` | Rekey margin (s) | 9 min | 0 s – 24 h | strongSwan margintime (9 min) | gateways and IPsec endpoints |
| `dpd_interval` | DPD interval (s) | 10 s | 1 s – 1 h | a common setting (RFC 7296 sets none) | gateways and IPsec endpoints |
| `dpd_retries` | DPD retries | 3 | 1 – 20 | a common setting | gateways and IPsec endpoints |
| `response_time` | Service response time (ms) | 0 s | 0 s – 1 min | none unless set | servers, VMs, containers, storage |
| `vm_restart` | VM restart time (s) | 1 min | 0 s – 1 h | a demonstration value (HA failure detection plus the restart) | servers that host VMs or containers (cabled to them) |
| `snmp_interval` | SNMP polling interval (s) | 1 min | 1 s – 24 h | a demonstration value (300 s is common in production) | systems and SNMP managers |
| `snmp_timeout` | SNMP timeout (s) | 1 s | 100 ms – 1 min | net-snmp (1 s) | systems and SNMP managers |
| `association_time` | Client association time (s) | 1 s | 0 s – 1 min | a demonstration value (WPA2-PSK takes well under a second, 802.1X longer) | access points |

| Device type | Simulation attributes |
|---|---|
| Router (`router`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `spf_delay`, `boot_time`, `max_paths`, `lacp_rate`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries` |
| Switch (`switch`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `mac_aging`, `stp_mode`, `ttl`, `spf_delay`, `boot_time`, `max_paths`, `mac_table_size`, `stp_hello`, `stp_forward_delay`, `stp_max_age`, `lacp_rate`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries` |
| Firewall (`firewall`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `spf_delay`, `boot_time`, `max_paths`, `lacp_rate`, `ha_failover`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries` |
| Access point (`ap`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `association_time` |
| Server (`server`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `response_time`, `vm_restart`, `snmp_interval`, `snmp_timeout` |
| Virtual machine (`vm`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `response_time`, `snmp_interval`, `snmp_timeout` |
| Container (`container`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `response_time`, `snmp_interval`, `snmp_timeout` |
| Storage (`storage`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `response_time` |
| Load balancer (`load_balancer`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `spf_delay`, `boot_time`, `max_paths`, `lacp_rate`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries` |
| Proxy (`proxy`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `spf_delay`, `boot_time`, `max_paths`, `lacp_rate`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries` |
| IDS/IPS (`ids_ips`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `fail_mode`, `inspection_latency` |
| Gateway (`gateway`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `spf_delay`, `boot_time`, `max_paths`, `lacp_rate`, `ike_lifetime`, `child_lifetime`, `rekey_margin`, `dpd_interval`, `dpd_retries` |
| Endpoint (`endpoint`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `snmp_interval`, `snmp_timeout` |
| Cloud (`cloud`) | `latency`, `loss`, `boot_time` |
| System (`system`) | `arp_timeout`, `arp_retransmit`, `arp_retries`, `ndp_reachable_time`, `ttl`, `boot_time`, `lacp_rate`, `snmp_interval`, `snmp_timeout` |

Validation reports, as errors: an unknown key in a `simulation:` block
(with a suggestion), an attribute that does not apply to the device's
type (the table above; the Edit tab lists the ones that apply to the
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
links:
  - {id: uplink2, a: "acc-sw:up2", b: "core2:down1", simulation: {flapping: true}}
```

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
* a link end's tagging: a mode other than `access` or `trunk`, VLAN IDs
  outside 1–4094, a bad range, a VLAN listed twice, VLANs without a mode;
* static routes: see [Static routes](#static-routes);
* `mtu` outside 68–65535, `min_links` outside 1–64 or on an interface
  without members, a `router_id` that is neither an IPv4 address (without
  prefix length) nor a loopback of the device with an IPv4 address, routing
  services on a device that is not Layer 3+, unknown or misplaced protocol
  parameters, a mandatory parameter left out or a value of the wrong type,
  a link end's `duplex` other than
  `full`, `half` or `auto`;
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
  address lies in;
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
missing, it says nothing; no default is assumed (an end without a mode is not
"access in VLAN 1").

| Id | Severity | Finds | Reads |
|---|---|---|---|
| `route-nexthop-self` | error | a next hop that is an address of the device itself | routes: `via`; interfaces: `ip` |
| `route-nexthop-interface` | error | a next hop outside the networks of the route's exit interface (not checked for an interface without an address) | routes: `via`, `interface`; interfaces: `ip` |
| `route-nexthop-unresolved` | error | a next hop that is neither in a network directly connected to the device in the route's VRF nor resolvable through another route (it names the VRF when the next hop is connected in another one) | routes: `prefix`, `via`, `interface`, `vrf`, `blackhole`; interfaces: `ip`, `vrf` |
| `route-nexthop-recursive` | info | a next hop that resolves through another route | the same |
| `route-exit-interface` | error | an exit interface that can't forward the route: a loopback, a member port of an aggregate, a physical port without a cable, an interface in another VRF | routes: `interface`, `vrf`; interfaces: `type`, `members`, `vrf`; links |
| `route-duplicate` | warning | the same route twice (prefix, next hop, distance, metric, VRF) | routes |
| `route-conflict` | warning | a blackhole and a forwarding route to one prefix at the same distance; routes via the same next hop at the same distance with different metrics | routes |
| `vlan-native-mismatch` | error | untagged (native) VLANs that differ between the two ends | links: `mode`, `untagged` |
| `vlan-tagged-mismatch` | warning | two trunk ends that tag different VLANs | links: `mode`, `tagged` |
| `vlan-access-tagged` | error | an access port with tagged VLANs | links: `mode`, `tagged` |
| `vlan-untagged-tagged` | error | a VLAN untagged at one end and tagged at the other | links: `mode`, `untagged`, `tagged` |
| `vlan-unknown` | warning | VLANs on a port that no network and no VLAN interface defines | links: `untagged`, `tagged`; networks and VLAN interfaces: `vlan` |
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
| `ospf-area-mismatch` | error | an OSPF adjacency whose ends are in different areas | OSPF relations: `area.<device>` |
| `ospf-network-type-mismatch` | warning | different OSPF network types at the two ends | OSPF relations: `network-type.<device>` |
| `ospf-timer-mismatch` | error | different hello or dead intervals at the two ends | OSPF relations: `hello.<device>`, `dead.<device>` |
| `bgp-peer-as` | error | a peer AS that is not the other device's AS | BGP relations: `peer-as.<device>`; devices: `protocols.bgp.asn` |
| `bgp-session-type` | error | iBGP between devices in different AS numbers, or eBGP within one | `ibgp`/`ebgp` relations (or `bgp` with `type`); devices: `protocols.bgp.asn` |
| `tunnel-endpoint-mismatch` | error | a tunnel whose destination is not what its peer is sourced from | tunnel relations between two tunnel interfaces; tunnel interfaces: `source`, `destination`; interfaces: `ip` |
| `tunnel-underlay` | warning | a tunnel whose `over` does not connect its endpoints (links join their two devices, networks their members, relations their devices) | tunnel relations: endpoints, `over` |
| `vrf-name-case` | warning | VRF names that differ only in case (the spelling used most is taken as meant; the others are reported) | interfaces: `vrf`; routes: `vrf` |
| `relation-vrf-mismatch` | warning | a relation between interfaces in different VRFs (only where both name a VRF: a VRF interface facing one without, as a provider edge facing a customer, is normal) | relation endpoints; interfaces: `vrf` |

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

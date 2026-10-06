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
| Physical connectivity | `links` | Physical view | A real cable / radio link between two ports |
| Logical relationships | `relations` | Logical view | Protocol sessions, tunnels, overlays, redundancy groups, service dependencies |
| IP networks | `networks` | Logical view | One IP prefix each, optionally with the VLAN it lives in. Members are derived from addresses. |
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
```

Unknown keys are errors (with "did you mean …?" suggestions), so typos never
silently disappear. Put any custom data under `attrs:`; it is shown in the
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
| Which networks a cable carries | `networks` on each end of the link (`a`, `b`) | the cable label, the "ends differ" warning, the cables listed with a network |
| Speed and medium of a physical connection | `speed` and `medium` on the link | cable width, colour and label |
| The VRF of an interface | `vrf` on the interface | — |
| The member ports of a bond / aggregate | `members` on the virtual interface | highlighting of the ports and their cables |
| The VLAN of a VLAN interface | `vlan` on the virtual interface, or (when that is left out) the `vlan` of the network containing its address | — |
| Which ports a VLAN interface uses | `networks` on the ends of the links (nothing on the interface) | *Ports carrying its networks* of the virtual interface |
| What a relation depends on | `over` on the relation (links, relations or networks) | highlighting of the underlay path |
| The interface a tunnel is sourced from, when its source is written as an address | the `ip` of the interface that has the address | the tunnel's source interface (highlighting, details) |

Three facts about networks are easy to confuse and are deliberately separate;
none is derived from another:

* **Membership** (IP containment, *derived*): a device is a member of a
  network when a configured address of one of its interfaces lies inside the
  network's prefix. It says nothing about cables.
* **Link-end networks** (physical / layer-2 carriage, *configured* per end):
  `networks` on a link end says which networks *that cable carries at that
  end*. An assignment doesn't make anyone a member, isn't derived from the
  port's addresses, and several networks on one end don't by themselves mean
  the port is tagged (there is no "trunk" in the model). The two ends are
  independent.
* **Relation underlay** (dependency, *configured*): `over` on a relation
  says what the relation rides on — links, other relations or networks.

And separately: **`vlan` on a network** says which VLAN an IP subnet lives
in. It answers "which VLAN is 10.10.10.0/24?" and gives interfaces with an
address in the subnet their (derived) VLAN. A link end shows the VLAN of each
network it carries next to it, for information only.

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
mapping accepts `device`, `interface` and `networks` (see
[links](#links-physical-cabling-only)). A link end can only name a physical
interface; a relation endpoint can name any interface.

## `groups`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name (defaults to the id) |
| `kind` | | Free text, e.g. `site`, `building`, `floor`, `room`, `rack`, `provider`, `cloud`, `zone`. There is no default: a group without a kind is drawn as a plain box. `site`/`campus`/`building`/`datacenter`/`region` are emphasised; `provider`/`cloud`/`external` are drawn dashed. The kind is shown in the group's title bar and in the legend. `kind: row` is an error; write `floor` (see [Rejected keys and values](#rejected-keys-and-values)). |
| `parent` | | Id of the enclosing group (at most 8 levels) |
| `description`, `attrs` | | |

## `devices`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name. Drawn in full: long labels wrap, and line breaks in the label are kept (see [Sizes, labels and routes](#sizes-labels-and-routes)). |
| `type` | | One of the [device types](#device-types) below, written exactly as listed (lower case). Any other value is an error. Without a type the device gets a generic icon. |
| `group` | | Id of the group the device is located in |
| `tier` | | 0–9: vertical row in the physical view (0 = top). By default this comes from the type (see the table below). Set it to place a device elsewhere, e.g. `tier: 3` for core or spine switches above the access switches. |
| `description`, `attrs` | | |
| `interfaces` | | List of the device's **physical interfaces** (its ports, below). The shorthand `interfaces: [eth0, eth1]` is allowed. |
| `logical_interfaces` | | List of the device's **logical interfaces** (below): loopbacks, virtual interfaces and tunnel interfaces. |
| `dns_names` | | List of the device's **DNS names**, each associated with one or more of its interfaces. See [DNS names](#dns-names). |

A device has no `vendor`, `model`, `role`, `mgmt` or `router_id` key; each
of them is an error (see [Rejected keys and values](#rejected-keys-and-values)).
Such facts can be kept as free-form `attrs`, which are shown in the details
only.

### Device types

| Display name | `type` | Default `tier` |
|---|---|---|
| Router | `router` | 1 |
| Switch | `switch` | 4 |
| Firewall | `firewall` | 2 |
| Access point | `ap` | 5 |
| Server | `server` | 6 |
| Virtual machine | `vm` | 6 |
| Container | `container` | 6 |
| Storage | `storage` | 6 |
| Load balancer | `load_balancer` | 1 |
| Proxy | `proxy` | 1 |
| IDS/IPS | `ids_ips` | 2 |
| Gateway | `gateway` | 1 |
| Endpoint | `endpoint` | 6 |
| Cloud | `cloud` | 0 |
| System | `system` | 6 |
| *(no type)* | | 4 |

Each type has its own icon, and the display name appears in the diagram
subtitle, the details, tooltips, the legend and the editor. The error for
any other value suggests the closest type (`Router` → `router`,
`load-balancer` → `load_balancer`) or lists all of them. A role such as
spine, leaf, core or border is not a type: write it into the label, the
description or `attrs`.

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
| `mac`, `description`, `attrs` | |

A **physical interface** has no other keys. In particular it has **no `type`
key**: every entry of `interfaces` is a physical interface, and writing
`type:` there is an error, whatever its value.

A **logical interface** additionally has:

| Key | Description |
|---|---|
| `type` | required: `loopback`, `virtual` or `tunnel`. No other value is accepted. |
| `members` | `virtual` only. See [Aggregates](#aggregates-member-ports). |
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
* The members are the only place this is written. The ports themselves say
  nothing about the aggregate.
* What the aggregate *does* (LACP towards another device, MLAG) is a
  relation with the aggregate as its endpoint.

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
* **Ports carrying its networks** is derived and read-only. The networks of
  a virtual interface are the networks containing its addresses and, when
  `vlan` is written on it, the networks of that VLAN. Its ports are the
  physical interfaces of the same device whose link end lists one of those
  networks (see [Networks on a link end](#networks-on-a-link-end)). Nothing
  is entered on the interface for it, and it changes as soon as a link end
  changes. A network that no link end of the device carries gives no ports.
* A virtual interface in no network (no address, no `vlan`; e.g. a plain
  bond or a VTEP) has no such ports.

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

## `links` (physical cabling only)

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `a`, `b` | yes | The two ends. `device:interface`, or just `device` when the port is unknown or irrelevant (e.g. "Internet"), or a mapping `{device, interface, networks}`. |
| `medium` | | `fiber`, `copper`, `dac`, `aoc`, `wireless`/`lte`/`5g`/`microwave`, `serial`, `virtual`, or any other text (it gets its own colour). **The only place the medium of the connection is configured**; without it the cable is drawn as "Unspecified". |
| `speed` | | e.g. `1G`, `10G`, `100G`, `250M`. **The only place the speed of the connection is configured**; it sets the line width. |
| `label`, `cable` (cable/circuit id), `description`, `attrs` | | |

Rules: a port can have at most one cable. Only physical interfaces can be
cabled: a link end that names a logical interface is an error (cable the
member ports of an aggregate, or the port a tunnel is sourced from, instead).
A link can't connect a port to itself.

A link is the physical connection: one cable (or radio path) between two
ports. `cable` is only its label or circuit id. There is no separate cable
object, so `medium` and `speed` exist exactly once per connection.

### Networks on a link end

Each end lists the networks the cable carries there, by network id. The two
lists are stored separately, because they can differ:

```yaml
links:
  - id: uplink-1
    a: {device: core1, interface: Ethernet1, networks: [users, servers, voice]}
    b: {device: acc1, interface: Gi1/0/49, networks: [users, servers]}       # differs from end a
    medium: fiber
    speed: 10G
  - {id: srv-1, a: {device: acc1, interface: Gi1/0/1, networks: servers}, b: "srv1:eno1"}   # one network at a, none at b
  - {id: p2p, a: "r1:eth0", b: "r2:eth0"}                                                  # nothing at either end
```

* `networks` is one network id or a list of ids, in any order. Any network
  can be assigned, whether or not it has a `vlan`. An unknown id, and an id
  listed twice on one end, is an error.
* This is **carriage, not membership**: it says the cable carries the network
  at that end. It makes no device a member (membership comes from
  addresses), and it is not derived from the port's own addresses — a routed
  port with an address in a network doesn't put that network on its cable,
  and an L2 port without any address can carry several networks.
* **No tagging is implied.** Several networks on an end are just several
  networks: two networks may share one VLAN (an IPv4 and an IPv6 prefix of
  one segment), and the model doesn't say whether a port tags. There is no
  "trunk" in the format or the display. The VLAN of each network is shown
  next to it in the editor, for information.
* The end is shown by what is configured there, and nothing is assumed: no
  networks reads **No network**.
* If the two ends differ in any way (including "some at one end, none at the
  other"), the link gets a *warning* naming the networks that are only at
  end A and only at end B. The editor shows it under the two ends, and the
  physical view marks the cable with ⚠ and the label *networks differ*.
  **Neither end is changed**: fix the end that is wrong.
* In the physical view a cable whose ends agree is labelled with the names of
  its networks, sorted (speed · networks · label). The per-end lists are in
  the tooltip and the details. A network's details list the cables that carry
  it, and selecting a network highlights them.
* Renaming a network updates the link ends that name it; deleting it leaves
  them as errors to fix.
* A link end has no `vlans` key: VLAN IDs belong on the networks.

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
| `adjacency` | solid line | BGP (eBGP/iBGP/MP-BGP), OSPF, IS-IS, EIGRP, RIP, LDP, PIM, BFD, static |
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

Built-in protocol ids: `gre`, `ipsec`, `ipip`, `wireguard`, `openvpn`, `l2tp`,
`dmvpn`, `gtp`, `rsvp-te`, `sr-te`, `pseudowire`, `ssl-vpn`, `vxlan`, `geneve`,
`evpn`, `l3vpn`, `vpls`, `sd-wan`, `otv`, `bgp`, `ospf`, `isis`, `eigrp`, `rip`,
`ldp`, `pim`, `bfd`, `static`, `lacp`, `mlag`, `vrrp`, `hsrp`, `glbp`, `carp`,
`ha-sync`, `dns`, `ntp`, `syslog`, `snmp`, `radius`, `dhcp`, `https`,
`netflow`. There are also aliases such as `ebgp`, `ibgp`, `mp-bgp`, `ospfv3`,
`is-is`, `wg`, `ikev2`, `mpls-te`, `pw`, `lag`, `port-channel`, `vpc`,
`tacacs+`, `ipfix` and `sflow`.

## `layout` (diagram positions)

Optional and **purely presentational**. It stores node centers per view,
keyed by entity id:

```yaml
layout:
  physical:            # device ids
    pe1: [120, 40]
    pe2: [360, 40]
  logical:             # device ids, network ids, ids of relations drawn as hubs (3+ devices)
    pe1: [0, 0]
    cust-a-access: [240, 90]
    ospf-core: [120, 60]
  manual:              # optional: nodes placed by hand (written by the editor)
    physical: [pe3]
```

* Values are `[x, y]` numbers; netatlas writes integers, sorted by id.
* `manual` lists, per view, the nodes the user dragged. It is used only for
  the layout status (see below): it tells *Manually adjusted* apart from
  *Edited since arranged*. Auto-arrange clears it for the arranged view. A
  node dropped exactly on the position one of the Auto-arrange strategies
  gives it is removed from it.
* Group boxes, ports, cables, relation lines and labels are never stored.
  They're derived from the node positions.
* Only the positions of the **complete** diagrams are stored. A view filtered
  to some devices (see [Filtered views](#filtered-views)) has temporary
  positions that are never written to the file.
* **Layout data never changes what the network is.** A malformed entry, an
  unknown view, or a position for an id that doesn't exist (or isn't a node of
  that view) is only a *warning* and is ignored. The model is the same with or
  without this section.
* Entries for objects that no longer exist are dropped the next time
  positions are written. When an entity is renamed in the editor, its
  positions follow it.

### How positions are decided

| Situation | Positions shown |
|---|---|
| A view has **no** stored positions | The **Auto-arrange** result for the current model. Opening or viewing a file never writes anything. |
| A view has stored positions | Stored positions are used. A node without one (e.g. added by hand in the YAML) is placed next to its neighbors in free space, without moving anything else. |
| You **drag** a node | Its new position is stored. If the view had no stored positions, all currently shown positions of that view are stored with it (one undo step). |
| You make an edit that affects geometry (adding, removing or renaming objects, changing any text that is drawn — labels, type, cable speed or the networks of its ends, relation labels —, groups, cables, relations, loopbacks, or an address or prefix that changes who is a member of a network …) | The positions shown **before** the edit are stored for both views, in the same undo step. New objects are placed next to their neighbors; nothing else moves. Adding, removing, renaming or cabling an interface affects geometry (every interface is drawn). Edits that don't affect geometry (attrs, descriptions, DNS names, cable medium, the associations of virtual and tunnel interfaces, addresses that leave membership as it is …) store nothing. |
| You click an **Auto-arrange** option (Default, Compact or Spacious) | All positions of **the view on screen** are recomputed with that strategy for the whole model and stored (one undo step). The other view keeps its positions, stored or not. If the view has positions that were set by hand, netatlas first asks for confirmation (see [Auto-arrange](#auto-arrange)). If the positions already equal the stored ones, nothing happens at all. The file stores positions only, never which strategy produced them. |
| You edit the **YAML** tab | The text is taken literally, including its `layout` section. Deleting the section there returns to automatic positions. |

So **load → arrange → export → reload** shows exactly the same picture. A
file that has never been edited in netatlas keeps showing the auto-arranged
layout, which is itself deterministic.

### Layout status

For each view the editor knows whether the diagram matches an Auto-arrange
strategy, and shows the status of the view on screen on the **Auto-arrange**
options (the matching one is selected and disabled; a hover text and
accessible description say which applies). The status is derived from the
document, never from the last action:

| Status | Rule |
|---|---|
| **Auto-arranged** (with a strategy) | No positions are stored for the view (it shows the Default result), or every displayed position equals the result of one strategy for the current model. When several strategies give the same positions, the first of Default, Compact, Spacious counts, and the others are shown as giving the same positions. |
| **Manually adjusted** | The positions match no strategy, and a node of the view is listed in `layout.manual`. |
| **Edited since arranged** | The positions match no strategy, but no node was placed by hand. The model changed after arranging, and positions were kept stable rather than re-arranged. |

Because it's derived, undo/redo, export → reload and moving a node back to
its calculated position always give the right status.

### Auto-arrange

**Auto-arrange** has three options, **Default**, **Compact** and
**Spacious**. Each arranges one view: the one on screen. There is no choice
of views; to arrange the other view, switch to it and choose an option there.
What happens depends on the view's layout status:

| Status of the view on screen | What an option does |
|---|---|
| **Auto-arranged with this option** | Nothing: the option is disabled. |
| **Auto-arranged with another option**, or **Edited since arranged** | The view is arranged at once; no position in it was set by hand, so nothing is asked. |
| **Manually adjusted** | A confirmation names the objects that were positioned by hand and says that they (and any other objects that no longer match) move to the calculated layout, that the other view is not changed, and that the step can be undone. **Cancel** changes nothing in either view. |

The strategies:

* **Default** is the layout described below.
* **Compact** is the Default layout with the slack taken out, container by
  container: the contents of each group are compacted first, and the group
  then takes part in its parent's compaction as one rigid block the size of
  its frame (with its title), so frames never overlap anything outside them.
  Inside a container, the items are moved towards their middle by 55 % (by
  centre along x, by top edge along y, so the tops of a row stay lined up)
  and separated again: first along x, in x order, each pushed right of the
  earlier ones it stands beside in the Default layout; then along y, in y
  order, each pushed below the earlier ones it overlaps horizontally. The
  gaps are 56 × 72 px (physical) and 64 × 64 px (logical) between items, plus
  a little air around a frame. The order along each axis is kept, so rows
  stay rows and stacks stay stacks. Cable and relation labels have less room
  and may sit closer to their lines.
* **Spacious** is the Default layout spread out from the centre of its node
  centres by a factor of 1.4. Distances only grow, so nothing can come to
  overlap; every line gets more room for its labels, and the picture grows.

Compact and Spacious are pure functions of the Default result, so they are as
deterministic as it is, and idempotent.

The Default layout is computed as follows.

* **Physical view:** tiered, nested group boxes. Inside a group, devices
  sit in rows by tier: cloud/WAN on top, then routers, firewalls, core,
  access, APs, and servers/hosts; a device's `tier` overrides this. Rows are
  reordered with barycenter sweeps to reduce crossings.
  **Groups are placed by their cabling**, at every level of nesting. The
  blocks of one container (its own device rows, its child groups and, at the
  top level, the connected components of ungrouped devices) are arranged like
  this:
  * blocks that are cabled to each other, directly or through other blocks,
    form one stack of layers. The top layer is the container's own device
    rows if it has any, else the block or blocks whose devices rank highest
    (lowest tier, e.g. a cloud). Every other block lies one layer below the
    nearest block it is cabled to. No group kind or name plays a part: a
    provider group cabled to a cloud above and routers below ends up between
    them, and one cabled only to an access switch ends up under that switch;
  * within a layer, blocks are ordered by the mean position of the devices
    they are cabled to, and each block is moved as close to that point as its
    neighbors allow, so its cables are short and steep. A block cabled to two
    others lies between them;
  * a block is placed as high as it can be: below every block it is cabled
    to (with room for the cables and their labels) and below whatever already
    occupies its own width. Blocks never overlap;
  * a top layer that gets too wide continues on a second line; lower layers
    may get considerably wider first, because a second line would put blocks
    under their own layer and the cables would have to cross it;
  * stacks that are not cabled to each other, and blocks without any cable
    (a disconnected group, a spare device), are packed side by side in a
    fixed order: highest-ranking first, then larger, then by id;
  * several rounds are computed and the one with the shortest and least
    crossing cabling is used; then pairs of blocks in a layer are exchanged
    where that improves it further (rings have no order every cable agrees
    with). This search is bounded, and skipped above 400 devices.

  The diagram grows as needed: a tall block in one layer moves only the
  blocks below its own width.
  Device boxes are as large as their full label needs and grow further for
  their ports and port labels. The gap between two neighbors of a row is
  widened for the port labels on the facing sides and for the label of a
  cable between them. A group box is at least as wide as its title.
* **Logical view:** each connected component (devices, networks, multipoint
  hubs) is laid out on its own with stress majorization, which spaces graph
  distances evenly. Its edges are the logical relationships only (relations
  between two devices, the spokes of multipoint relations, and network
  membership); cables are not edges here. Very large components (over 300
  nodes) use a force-directed layout instead.
  **Devices are clustered by group.** Each group's content (its devices and
  its child groups) is laid out on its own, deepest groups first; the group
  then takes part in the layout around it as one box, exactly the size of its
  frame (content, padding and title). So a group's frame never covers a
  device of another group, and sibling frames never overlap. Relationships
  between devices of different groups count as edges between the groups
  that hold them. Networks and multipoint hubs belong to no group and are
  placed around the groups. Components are ordered by how many nodes they
  hold, a group counting with everything inside it. A model without groups is
  laid out without this step. The layout is seeded from the auto-arranged
  *physical* positions, so the two views keep a similar mental map, but never
  from manual positions. Then:
  * every node is as large as its full text needs; the distance between two
    connected nodes follows from their sizes and from the labels that must
    fit between them, and boxes are pushed apart until that room exists
    (a gap as wide as the widest label, or as high as all labels stacked);
  * node positions are swapped where that strictly reduces edge crossings and
    edges passing through nodes;
  * nodes that an edge would pass through are moved aside;
  * components are packed in rows, largest first.

### Filtered views

The **Devices** control (top right, in both views) chooses the devices the
diagram shows. Every device is selected by default.

* **All devices selected:** the complete diagram, with its stored positions,
  exactly as without a filter. Dragging stores positions and Auto-arrange
  works on the complete view, as described above.
* **Some devices selected:** each view shows the part of the model relevant
  to them, and that part is **auto-arranged for itself**. The result depends
  only on the model and the set of selected devices (not on the order they
  were chosen in, earlier filters or earlier drags). It is computed when the
  filtered view is first shown and stays as it is until you move a node,
  press Auto-arrange or change the selection; options such as Labels,
  selecting objects or switching views don't re-arrange it. An edit to the
  model keeps it stable and places new objects next to their neighbours.

What a filtered view contains:

| Element | Shown when |
|---|---|
| Devices | selected |
| Physical links | both ends are on selected devices. A cable to a hidden device is not drawn at all. |
| Relations (logical view) | every endpoint is on a selected device. A relation that also reaches a hidden device (including a multipoint relation) is left out, never drawn as if it were complete. Its `over` keeps only what is shown. |
| Networks, physical view | a selected device has an address in it, or an end of a shown link carries it |
| Networks, logical view | a selected device has an address in it, or a shown relation names it in `over` |
| Network members | only the selected devices with an address in the network |
| Groups / locations | they contain a selected device (directly or in a child group); they frame only their selected devices |
| Protocols | a shown relation uses them: the Legend, its protocol switches and the exported legend list only those |

A tunnel interface whose destination is on a hidden device keeps its
destination text, but nothing is highlighted on the hidden side.

**Positions in a filtered view are temporary.** A note on the diagram says
so: *Filtered-view positions are temporary and are not saved in YAML.*
Dragging a node there moves it for the session only: there is no undo step
and nothing is written to the file. Each view keeps its own temporary
positions, so switching views moves nothing in the other one. Selecting all
devices again shows the complete diagram with its stored positions,
unchanged; a filtered view chosen again later is arranged afresh.

**Auto-arrange in a filtered view** (any option) arranges the shown devices
only, at once and without confirmation (the positions it replaces are
temporary). The stored layout of the complete view is not changed. The
option whose result the filtered view shows is selected; after a node was
moved there, none is (*Manually adjusted*); the hover text and the
accessible description say that the view is filtered.

**Export** (PNG and SVG) shows the filtered view: the selected devices and
what is relevant to them, with the current Labels, Groups / Locations and
Networks settings, the whole filtered diagram (not just the part on screen),
a legend of what is drawn and a Networks overview of the networks relevant
to it. The note about temporary positions is not part of the picture.

**Groups / Locations** (both views, on by default) shows or hides the
frames of groups. Hiding them never hides or moves a device. **Networks**
(logical view) shows or hides network nodes and their membership lines; the
addresses in the editor are not affected.

### Sizes, labels and routes

Nothing in the diagram is shortened with "…". These rules decide sizes and
places; they are the same on screen and in exported SVG files.

* **Text.** A label is drawn in full. Line breaks in a label (a YAML block
  scalar, or `\n` in a quoted string) are kept as lines. A line that is too
  long wraps at spaces; a single word that is too long is broken, preferably
  after `- _ / . : , ; | @ = +`. Maximum line widths: device label and
  subtitle 220, network 210, relation label 240, cable label 190. Labels are
  limited to 200 characters by the format, so an element can't grow without
  bound: the longest possible device label gives a box about 280 wide.
* **Devices** grow in width up to the wrap width and in height with the
  number of lines; the subtitle (the device type) wraps the same way. In
  the logical view a device is also as wide as its widest loopback chip and
  grows for the chips of its virtual and tunnel interfaces; in the physical
  view it grows for the chips of its uncabled ports (rows as wide as the box,
  a shared prefix of six or more similar names written once).
* **Networks** show their label and their prefix (with the VLAN), wrapped.
  In the logical view a network or multipoint hub whose devices all lie in
  one group (a site LAN, a rack's LAG) is placed inside that group's frame,
  in the innermost group holding all of them.
* **Groups** wrap their title at the width of their content (at least 260)
  and get a taller title area for it.
* **Cables.** Ports are placed opposite the device they lead to. Where the
  two ports of a cable face each other they are moved onto one line, so the
  cable is a single straight segment; several cables between the same two
  devices become parallel straight lines. Other cables leave each port at a
  right angle and run straight between the two stubs. If that line would pass
  through a device, the cable bends around it (at most a few bends).
* **Cable labels** (speed · networks · label) are always drawn, on the cable's
  longest segment. Each takes the first free place: the middle, then further
  along the segment, then beside it.
* **Relation labels.** Every relation between two devices that isn't nested
  in a tunnel has its own label next to its own lane. A nested relation is
  named in its carrier's label together with its own label
  (`IPsec · site-to-site › GRE · primary › OSPF · area 1`), so it is neither
  lost nor drawn twice. Labels are written one after the other along the
  bundle, or stacked across it when the line is too short, and each then
  takes the nearest place that is free of nodes and other labels.
* **Order.** Labels are placed in id order, so the result depends only on
  the model and the node positions, never on selection or on what was
  dragged before.

**Trade-offs and limits.**

* Text widths are *estimated* (see Determinism), a little on the wide side,
  so boxes have some spare room; with an unusually wide font a very long line
  can still touch the edge of its box.
* A label that finds no free place among its candidates is put where it
  overlaps least. It is never dropped. This can happen in very dense
  diagrams, or after nodes were dragged close together by hand.
* Labels keep clear of nodes and of other labels, not of lines: a label can
  lie on a cable or relation line that isn't its own.
* Cables avoid devices, not group boxes, group titles or other cables.
  Crossings are reduced by the placement of groups and the ordering of rows,
  not eliminated: a full mesh or a ring between groups always crosses
  somewhere.
* Group placement is a heuristic. Layers come from the *nearest* connected
  block, so a group cabled both to the top and far down lies near the top and
  has one long cable. A chain of groups gives a tall diagram, a wide layer a
  wide one; the shape follows the topology rather than the screen.
* Relation lines in the logical view are always straight. Auto-arrange moves
  nodes off the lines; with manual positions a line can pass under a node.
* Spacing is preferred over density, so Default diagrams are fairly large;
  Compact takes the slack out.
* Stored positions are never changed by another NetAtlas application
  version. If that version arranges differently, the view shows *edited
  since arranged* until Auto-arrange is used again.

**Determinism.** Auto-arrange is a pure function of a canonical *layout
input* (`src/layout/input.ts`). It uses no randomness, no clock, no browser
measurement (text widths are estimated from character classes) and no
locale-dependent ordering. Every list is sorted by id with plain code-unit
comparison, and every tie is broken by id. The arithmetic uses only `+ − × ÷`,
`Math.sqrt` and constant tables. The ECMAScript spec requires these to give
the same result in every browser; `Math.hypot`, `sin` and `cos` are allowed
to vary, so they aren't used. Results are rounded to whole pixels.

**Equivalent input.** Two files arrange identically (in the same netatlas
version) when they have the same:

* device ids, labels, types, tiers (explicit `tier`,
  else derived from `type`), groups, the number of loopbacks and the width of
  the widest loopback chip (loopback ids and addresses), the ids of the
  uncabled physical interfaces and of the virtual and tunnel interfaces;
* groups (ids, parents, labels and kinds);
* cables (ids and their endpoints `device:interface`; which end is `a` and
  which is `b` doesn't matter) and the text drawn on them (speed, the
  networks of the ends, label);
* networks (ids, labels, and the subtitle shown from `vlan`/`cidr`, plus the
  derived set of member devices);
* relations (ids and the set of devices they connect), and per pair of
  devices the label texts and the width of the bundle (protocol display
  names and line styles, relation labels, nesting through `over`).

**Not relevant:**
* order of keys, sections and list items (devices, physical and logical
  interfaces, member ports, cables, endpoints, link-end networks, `over`, …);
* comments, quoting and formatting;
* the `layout` section itself;
* manual moves and load order;
* direction, attributes, descriptions, the medium of a cable, cable
  ids (`cable:`), virtual and tunnel interfaces, and interface addresses as long as they don't change which
  networks a device belongs to. In short: what isn't drawn as text and
  doesn't change a size.

## Validation and limits

Validation reports **all** problems it finds (up to 200). Each one comes with
a line number, a path such as `relations.gre-1.over`, the offending source line
and, where possible, a suggestion. In the editor the same problems are shown
next to the object and field they concern.

**Errors** cover:
* a missing `netatlas:` line, or any value other than `1`;
* missing required keys, wrong value types and unknown keys;
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
* an unknown network on a link end, or one listed twice on an end;
* invalid loopback addresses, invalid VLAN IDs, and bad colours, categories
  or styles;
* the keys and values listed under
  [Rejected keys and values](#rejected-keys-and-values), each with an
  instruction saying where the fact belongs.

**Warnings** don't block rendering:
* an unknown protocol without a category;
* different networks at the two ends of a link;
* an address whose derived VLAN is ambiguous (overlapping networks with
  different VLANs);
* a prefix with bits beyond its length, or the same prefix on two networks;
* a relation carried over another relation whose endpoints don't match;
* an interface address that isn't a valid IP address;
* the same address assigned twice;
* a port that is a member of two aggregates;
* a VLAN interface whose `vlan` differs from the VLAN of the network its
  address lies in;
* a tunnel source address that no interface of the device has;
* the same DNS name on two devices.

A file with **errors can still be opened and drawn**. Everything that
validated is shown, so an incomplete draft stays usable. Only files that
aren't valid YAML in the supported subset (or aren't a mapping) are refused
before editing.

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

## Rejected keys and values

Some keys are easily expected in a place where the format doesn't have them,
because the fact they describe belongs somewhere else. Like every unknown key
they are errors, but instead of a "did you mean" suggestion the error says
where the fact belongs. netatlas never converts them, never reads them into
the model and never treats them as aliases.

| Written in | Key or value | Where the fact belongs |
|---|---|---|
| a device | `vendor`, `model`, `role`, `mgmt` | Not part of the format. Keep the value under `attrs:` if you need it (shown in the details only). |
| a device | `router_id` | Not part of the format. Declare the loopback under `logical_interfaces:` with `type: loopback`, and name its purpose in its `label` if you like. |
| a device | `loopbacks` | A loopback is a logical interface: an entry of `logical_interfaces:` with `type: loopback`. |
| an entry of `interfaces` | `type` (any value) | An entry of `interfaces` is always a physical interface. A loopback, virtual or tunnel interface belongs in `logical_interfaces:`. |
| an entry of `interfaces` or `logical_interfaces` | `children` | Interfaces are not nested. Each logical interface is an entry of `logical_interfaces:` with its `type`; a tunnel names its `source`, an aggregate its `members`, a VLAN interface its `vlan`. |
| an entry of `interfaces` | `members`, `source`, `destination` | Keys of a virtual (`members`) or tunnel (`source`, `destination`) interface in `logical_interfaces:`. |
| an entry of `interfaces` | `speed`, `media` | `speed` and `medium` of the [link](#links-physical-cabling-only) cabled to the port. |
| an entry of `interfaces` | `vlan` | Derived from the network containing the address: `vlan` on that [network](#networks). The networks a cable carries are `networks` on the link end. |
| an entry of `logical_interfaces` | `parent` | There is no generic parent: `members` (aggregate), `vlan` (VLAN interface) or `source` (tunnel). |
| an entry of `logical_interfaces` | `speed`, `media` | A logical interface has no cable; speed and medium are properties of a link. |
| a network | `kind` | A network is always an IP network. |
| a network | `vrf` | `vrf` on the interfaces (or loopbacks) that are in the VRF. |
| a network | `members` | Derived from the addresses inside the network's `cidr` (see [Membership](#membership-derived)). |
| a network | `prefixes`, or `cidr` as a list | Exactly one prefix: `cidr: 10.0.0.0/24`. Make a network for each other prefix. |
| a link end | `vlans` | `networks: [network ids]`; the VLAN ID belongs on the network (`vlan`). |
| a relation | `network` | If the relation runs over the network, list it in `over`; if it carries or serves it, keep that in `attrs`. |
| a relation | `directed` | `direction: unidirectional` for `directed: true`; for `directed: false` nothing (bidirectional is the default). |
| a relation endpoint | `role`, `address`, `attrs` | The relation's `attrs`. An endpoint is only a device and, optionally, an interface. |
| a group | `kind: row` | `kind: floor`. |

Entries under a rejected key are **not read** (so references to them are
reported as well) and **not dropped**: the file keeps them, and exports them
unchanged, until you remove or move them.

# netatlas YAML format (version 1)

> **Breaking changes (after release 0.1.x).** The format was restructured
> twice: first so that each fact is configured in one place, then so that
> interfaces form a hierarchy (physical interfaces with logical and tunnel
> children, loopbacks in a list of their own) and devices lost five fields.
> The version line stays `netatlas: 1`, because the tool isn't used in
> production yet, but files that use the removed keys or the old interface
> structure are **not converted** and no old key is kept as an alias. They
> open as a draft with one error per key that has to change; update them by
> hand as described in
> [Changes from the earlier format](#changes-from-the-earlier-format).

A netatlas file describes **one** network architecture. It separates two
things that are often mixed up in diagrams:

| Concept | Section | Drawn in | Meaning |
|---|---|---|---|
| Physical connectivity | `links` | Physical view | A real cable / radio link between two ports |
| Logical relationships | `relations` | Logical view | Protocol sessions, tunnels, overlays, redundancy groups, service dependencies |
| IP networks | `networks` | Logical view | IP prefixes, optionally with the VLAN they live in. Members are derived from addresses. |
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
| Which devices belong to a network | the network's `cidr` and the `ip` addresses of interfaces and loopbacks | the network's member list (details, editor, membership lines in the logical view, selection context, layout) |
| The VLAN of an IP network | `vlan` on the network | the VLAN shown for each interface address inside that network |
| The VLANs permitted on a cable | `vlans` on each end of the link (`a`, `b`) | *Trunk* / single VLAN / *No VLAN* per end; the mismatch warning |
| Speed and medium of a physical connection | `speed` and `medium` on the link | cable width, colour and label |
| The VRF of an interface | `vrf` on the interface | — |

Two of these are easy to confuse and are deliberately separate:

* **`vlan` on a network** says which VLAN an *IP subnet* lives in. It answers
  "which VLAN is 10.10.10.0/24?" and gives interfaces with an address in the
  subnet their (derived) VLAN.
* **`vlans` on a link end** says which VLAN IDs *that port permits on that
  cable*. It answers "what does this end of the trunk carry?". It doesn't
  need a network with that VLAN, it doesn't change any interface's derived
  VLAN, and the two ends are independent.

## Identifiers

* Every entity in `groups`, `devices`, `links`, `networks` and `relations`
  has an `id`. **Ids are unique across all of these sections**, so a reference
  such as `over: x` is never ambiguous.
* Ids: 1–64 characters from `A–Z a–z 0–9 _ . -`, starting with a letter or
  digit. `:` is reserved.
* Interface ids are unique **within their device** and may also contain `/`
  (`ge-0/0/1`, `Ethernet1/49`). Physical interfaces, their children and
  loopbacks share that one set of ids, so `device:interface` names exactly
  one of them, wherever it is declared.
* Ids are the stable keys of the model. Labels can change freely.

## Endpoint references

Links and relation endpoints refer to devices or interfaces:

```yaml
- r1                      # a device
- r1:ge-0/0/1             # an interface of a device: a physical interface, one of its
                          # children, or a loopback (quote it inside [ ] or { } if you like)
- {device: r1, interface: ge-0/0/1, role: hub, address: 10.0.0.1/30, attrs: {asn: 65001}}
```

The mapping form with `role`, `address` and `attrs` is for relation
endpoints. A link end written as a mapping accepts `device`, `interface` and
`vlans` (see [links](#links-physical-cabling-only)). A **link end** can only
name a physical interface; a **relation endpoint** can name any interface or
loopback.

## `groups`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name (defaults to the id) |
| `kind` | | Free text, e.g. `site`, `building`, `floor`, `room`, `rack`, `provider`, `cloud`, `zone`. There is no default: a group without a kind is drawn as a plain box. `site`/`campus`/`building`/`datacenter`/`region` are emphasised; `provider`/`cloud`/`external` are drawn dashed. The kind is shown in the group's title bar and in the legend. `row` was renamed to `floor`; `kind: row` is an error. |
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
| `loopbacks` | | List of [loopbacks](#loopbacks): logical endpoints of the device itself. |
| `interfaces` | | List of the device's **physical interfaces** (below); each may have `children`. The shorthand `interfaces: [eth0, eth1]` is allowed. |

A device has no `vendor`, `model`, `role`, `mgmt` or `router_id` key (see
[Changes from the earlier format](#changes-from-the-earlier-format)). Such
facts can be kept as free-form `attrs`, which are shown in the details only.

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

Interfaces form a hierarchy with two levels, and where an interface is
written decides what it is:

| Written in | It is | Can be cabled | `type` key |
|---|---|---|---|
| `interfaces` of a device | a **physical** interface (a port) | yes | none |
| `children` of a physical interface | a **logical** or a **tunnel** interface that runs on that port | no | `logical` (default) or `tunnel` |
| `loopbacks` of a device | a **loopback**: a logical endpoint of the device itself | no | none |

```yaml
devices:
  - id: edge-a
    type: router
    loopbacks:
      - {id: lo0, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
    interfaces:
      - id: ge-0/0/0                    # a physical interface with two children
        ip: 198.51.100.2/30
        children:
          - {id: ge-0/0/0.100, type: logical, label: Management, ip: 10.100.0.1/24}
          - {id: st0.10, type: tunnel, ip: 172.16.10.1/30, description: GRE to Munich}
      - {id: ge-0/0/1}                  # a physical interface without children
      - ge-0/0/2                        # the same, in the short form
```

**Physical interfaces** (`interfaces`):

| Key | Description |
|---|---|
| `id` | required, unique within the device. This is the stable identifier and the interface name used in references (`r1:ge-0/0/0`). |
| `label` | optional display name (defaults to the id) |
| `ip` | one address or a list: `ip: 10.0.0.1/30` or `ip: [192.0.2.1/24, 2001:db8::1/64]`. Addresses that aren't valid IPv4/IPv6 addresses (e.g. `dhcp`) give a *warning* and are shown as written. **The addresses decide which networks the device belongs to.** |
| `vrf` | name of the VRF the interface is assigned to (free text, display only). Membership in a network is decided by the address alone. |
| `mac`, `description`, `attrs` | |
| `children` | list of the logical and tunnel interfaces that run on this port: none, one or several. The shorthand `children: [ge-0/0/0.1]` is allowed (a logical child). |

A physical interface has **no `type` key**: every entry of `interfaces` is a
physical interface, and writing `type:` there is an error, whatever its
value.

**Child interfaces** (`children`) take the same keys as a physical
interface, except `children` (they can't be nested), plus:

| Key | Description |
|---|---|
| `type` | `logical` or `tunnel`; `logical` when the key is missing. **No other value is accepted.** |

`logical` covers everything that is configured on top of a port and isn't a
tunnel: a subinterface, an SVI or IRB interface, a LAG/bundle member view, a
VTEP. `tunnel` is a tunnel endpoint (GRE, IPsec VTI, WireGuard …). The more
specific function isn't a type of its own; say it with the `label`, the
`description` or `attrs` (e.g. `attrs: {function: svi}`), and express what
the interface *does* with a relation: a tunnel is a relation between two
tunnel interfaces, a LAG is an `lacp` relation, a VXLAN VNI an overlay.

A child always belongs to exactly one physical interface of its own device.
An interface that really has no port of its own (an SVI on a switch, a VTEP)
is written under the port it is reached through, or, if it is an address of
the device itself, as a loopback.

An interface has **no** `speed`, `media` or `vlan` key:

* speed and medium belong to the cable and are set on the [link](#links-physical-cabling-only);
* the VLAN is derived. For each address, netatlas looks up the networks whose
  prefix contains it and shows that network's `vlan`:

| The address lies in … | Derived VLAN shown |
|---|---|
| no network | none ("no network") |
| networks that define no `vlan` | none ("no VLAN defined") — a VLAN is never invented |
| one or more networks that all define the same `vlan` | that VLAN |
| networks that define **different** VLANs | *ambiguous: VLAN x or y*, plus a warning. Nothing is chosen. |

An interface with several addresses gets one result per address, so it can
be associated with several networks and VLANs. That is not an ambiguity.
All of this applies to children and loopbacks in the same way.

**In the diagrams.** The physical view draws a physical interface as a port
when it is cabled; children and loopbacks are never ports. Selecting a child
(in the details, the editor or through a relation) highlights its port and
that port's cable, and selecting a port highlights its children. Tunnels and
other relations between child interfaces are drawn in the logical view. The
device details list every physical interface followed by its children.

**Display order.** The editor and the details show loopbacks, physical
interfaces and the children of each interface in alphabetical order of their
ids: letters without regard to case, runs of digits by their value (`eth2`
before `eth10`). Ids that are equal in that comparison are ordered by their
exact spelling, and identical ids (possible only in a draft with errors) keep
the order of the file. This is display only: the order of the lists in the
YAML file means nothing to netatlas, is never changed by viewing or editing
an entry, and new entries are appended to the end of their list.

### Loopbacks

A loopback is a logical endpoint of the device itself: it has addresses, but
no port and no cable. Loopbacks are written in the device's own `loopbacks`
list, next to `interfaces`, because they don't belong to any physical
interface. A device can have zero, one or several, and a device may have
loopbacks and no interface at all.

```yaml
devices:
  - id: edge-a
    type: router
    loopbacks:
      - {id: lo0, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
      - {id: lo1, label: BGP source (IPv6), ip: [2001:db8:ffff::a/128]}
    interfaces:
      - {id: ge-0/0/0, ip: 192.0.2.1/31}
relations:
  - id: ibgp-v6
    protocol: ibgp
    endpoints: [edge-a:lo1, edge-b:lo1]  # a session sourced from loopbacks
  - id: gre-lab
    protocol: gre
    endpoints: [edge-a:lo0, edge-b:lo0]  # a tunnel whose endpoints are loopbacks
```

| Key | Description |
|---|---|
| `id` | required, unique on the device (across interfaces, children and loopbacks) |
| `label` | the loopback's name, e.g. "Router ID" (defaults to the id) |
| `ip` | required: one address or a list |
| `vrf`, `description`, `attrs` | |

Rules (errors unless noted):

* `ip`: at least one address. Each must be an IPv4 or IPv6 address **with a
  prefix length** (`10.255.0.1/32`, `2001:db8::1/128`); `/0–32` for IPv4 and
  `/0–128` for IPv6. The same address can't appear twice on one loopback.
  If the same address is used on another interface anywhere in the model, you
  get a *warning*.
* A loopback has no `type` (the list says what it is), no `mac`, no
  `children` and no physical-link properties; it can't be the end of a
  physical link. Its addresses count for network membership like any other
  interface's.
* A loopback may be used anywhere an interface can be referenced in a
  relation (tunnel endpoints, BGP/LDP session sources). It doesn't have to
  be referenced at all.
* There is no router-ID field. If a loopback provides the router ID, say so
  in its `label`.
* Display: in the **logical view** each device shows its loopbacks as small
  chips under the device, in alphabetical order (the first three, then
  "+N more"; a device with loopbacks is shown even if it has no relations).
  The device's **details** list them in their own table with the relations
  that use them. The **physical view** never draws them, because they have
  no port or cable.

## `links` (physical cabling only)

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `a`, `b` | yes | The two ends. `device:interface`, or just `device` when the port is unknown or irrelevant (e.g. "Internet"), or a mapping `{device, interface, vlans}`. |
| `medium` | | `fiber`, `copper`, `dac`, `aoc`, `wireless`/`lte`/`5g`/`microwave`, `serial`, `virtual`, or any other text (it gets its own colour). **The only place the medium of the connection is configured**; without it the cable is drawn as "Unspecified". |
| `speed` | | e.g. `1G`, `10G`, `100G`, `250M`. **The only place the speed of the connection is configured**; it sets the line width. |
| `label`, `cable` (cable/circuit id), `description`, `attrs` | | |

Rules: a port can have at most one cable. Only physical interfaces can be
cabled: a link end that names a child interface or a loopback is an error
(cable the physical interface the child runs on instead). A link can't
connect a port to itself.

A link is the physical connection: one cable (or radio path) between two
ports. `cable` is only its label or circuit id. There is no separate cable
object, so `medium` and `speed` exist exactly once per connection.

### VLANs on a link end (trunks)

Each end lists the VLAN IDs it permits on the cable. The two lists are stored
separately, because they can differ:

```yaml
links:
  - id: uplink-1
    a: {device: core1, interface: Ethernet1, vlans: [10, 20, 30]}   # a trunk
    b: {device: acc1, interface: Gi1/0/49, vlans: [10, 20]}          # a trunk; differs from end a
    medium: fiber
    speed: 10G
  - {id: srv-1, a: {device: acc1, interface: Gi1/0/1, vlans: 20}, b: "srv1:eno1"}   # one VLAN at a, none at b
  - {id: p2p, a: "r1:eth0", b: "r2:eth0"}                                          # no VLAN at either end
```

* `vlans` is one VLAN ID or a list of IDs. An ID is a whole number from 1 to
  4094; anything else, and an ID listed twice on one end, is an error. Ranges
  such as `10-20` are not part of the format (the editor's input field
  expands them into single IDs).
* The end is labelled by what is configured there, and nothing is assumed:

  | `vlans` on the end | Shown as |
  |---|---|
  | missing or empty | **No VLAN** |
  | one ID | **VLAN 20** |
  | several IDs | **Trunk · VLANs 10, 20, 30** |

* If the two ends differ in any way (including "some at one end, none at the
  other"), the link gets a *warning* naming the VLANs that are only on end A
  and only on end B. The editor shows it under the two ends, and the physical
  view marks the cable with ⚠. **Neither end is changed**: fix the end that
  is wrong.
* In the physical view a cable whose ends agree is labelled `VLAN 20` or
  `Trunk 10,20,30`. The per-end lists are in the tooltip and the details.
* These VLANs are independent of `vlan` on a network (see
  [Configure once, derive elsewhere](#configure-once-derive-elsewhere)).

## `networks`

| Key | Description |
|---|---|
| `id` | required |
| `label` | |
| `cidr` | one prefix or a list, IPv4 and/or IPv6, each **with a prefix length**: `10.10.10.0/24`, `[192.0.2.0/24, 2001:db8::/64]`. The prefixes decide who is a member. |
| `vlan` | the VLAN ID (1–4094) this IP network lives in, if any |
| `description`, `attrs` | |

A network is always an IP network: there is no `kind`. It has no `vrf` (a VRF
is assigned on [interfaces](#interfaces)) and **no `members` list**.

### Membership (derived)

A device is a member of a network when **at least one address assigned to one
of its interfaces (physical or child) or loopbacks lies inside one of the
network's prefixes**.
The list is computed from the current model every time it is shown. It names
the device once, with every matching interface (or loopback) and address.

```yaml
devices:
  - id: core1
    interfaces:
      - id: Ethernet1
        children:
          - {id: Vlan10, ip: 10.10.10.2/24}            # member of "users", derived VLAN 10
    loopbacks:
      - {id: lo0, ip: 10.255.0.1/32}                   # in no network
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
* **A network with several prefixes** has as members the devices matching
  any of them.
* **Overlapping networks:** an address belongs to every network that
  contains it, so the device is a member of each. (For the derived VLAN of
  such an address see [Interfaces](#interfaces).)
* **Invalid or incomplete addresses belong to no network**: text that isn't
  an address (`dhcp`), a wrong octet or group, a prefix length that is
  missing after the slash or out of range (`10.1.0.1/`, `10.1.0.1/33`), a
  zone suffix (`fe80::1%eth0`). On an ordinary interface they are a warning
  and are shown as written; on a loopback they are an error.
* **The network's own prefixes must be valid.** A `cidr` entry that isn't an
  address with a prefix length is an *error* and defines nothing. A prefix
  with bits set beyond its length (`10.10.10.9/24`) is a *warning*; the
  network is the whole `/24`. A network without any prefix is a *warning*
  and has no members.
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
| `over` | | Id, or list of ids, of the **links, relations or networks this relation is carried over**. This is how GRE-over-IPsec, OSPF-over-GRE, a tunnel over specific internet uplinks, or LACP over member cables is expressed. Cycles are rejected. |
| `network` | | Id of a network the relation belongs to (e.g. the VLAN of a VRRP group) |
| `directed` | | `true`: drawn with an arrow from the first to the last endpoint (e.g. syslog, replication) |
| `label`, `description` | | |
| `attrs` | | **Protocol-specific attributes**, free-form (see below) |

### Protocol-specific attributes

The core model never needs to change for a new protocol. All protocol details
go into `attrs`, both on the relation and on each endpoint:

```yaml
- id: ipsec-hq-branch
  protocol: ipsec
  endpoints:
    - {device: hq-rtr1, interface: ge-0/0/0, attrs: {local-id: hq.example}}
    - {device: br-rtr,  interface: wan0,     attrs: {local-id: branch.example}}
  over: [uplink-hq, uplink-branch]
  attrs:
    ike: {version: 2, dh-group: [19, 20]}   # nested maps are flattened to "ike.version", "ike.dh-group"
    encryption: aes-256-gcm
```

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
  node dropped exactly on its auto-arranged position is removed from it.
* Group boxes, ports, cables, relation lines and labels are never stored.
  They're derived from the node positions.
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
| You make an edit that affects geometry (adding, removing or renaming objects, changing any text that is drawn — labels, type, cable speed or VLANs, relation labels —, groups, cables, relations, loopbacks, or an address or prefix that changes who is a member of a network …) | The positions shown **before** the edit are stored for both views, in the same undo step. New objects are placed next to their neighbors; nothing else moves. Edits that don't affect geometry (attrs, descriptions, cable medium, child interfaces, addresses that leave membership as it is …) store nothing. |
| You click **Auto-arrange** | All positions of **the view on screen** are recomputed for the whole model and stored (one undo step). The other view keeps its positions, stored or not. If the view has positions that were set by hand, netatlas first asks for confirmation (see [Auto-arrange](#auto-arrange)). If the positions already equal the stored ones, nothing happens at all. |
| You edit the **YAML** tab | The text is taken literally, including its `layout` section. Deleting the section there returns to automatic positions. |

So **load → arrange → export → reload** shows exactly the same picture. A
file that has never been edited in netatlas keeps showing the auto-arranged
layout, which is itself deterministic.

### Layout status

For each view the editor knows whether the diagram matches Auto-arrange, and
shows the status of the view on screen on the **Auto-arrange** button (icon,
colour, hover text and accessible description). The status is derived from
the document, never from the last action:

| Status | Rule |
|---|---|
| **Auto-arranged** | No positions are stored for the view, or every displayed position equals the Auto-arrange result for the current model. |
| **Manually adjusted** | Some positions differ, and at least one differing node is listed in `layout.manual`. |
| **Edited since arranged** | Some positions differ, but none of the differing nodes was placed by hand. The model changed after arranging, and positions were kept stable rather than re-arranged. |

Because it's derived, undo/redo, export → reload and moving a node back to
its calculated position always give the right status.

### Auto-arrange

The **Auto-arrange** button arranges one view: the one on screen. There is no
choice of views; to arrange the other view, switch to it and press the button
there. What happens depends on the view's layout status:

| Status of the view on screen | What the button does |
|---|---|
| **Auto-arranged** | Nothing moves and nothing is asked. If the view has no stored positions yet, the positions shown are stored. |
| **Edited since arranged** | The view is arranged at once; no position in it was set by hand, so nothing is asked. |
| **Manually adjusted** | A confirmation names the objects that were positioned by hand and says that they (and any other objects that no longer match) move back to the calculated layout, that the other view is not changed, and that the step can be undone. **Cancel** changes nothing in either view. |

The layout itself is computed as follows.

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
  membership); cables are not edges here, and groups don't exist in this
  view; very large components (over 300 nodes) use a
  force-directed layout instead. It is seeded from the auto-arranged
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
  the logical view a device is also as wide as its widest loopback chip.
* **Networks** show their label and *all* prefixes, wrapped.
* **Groups** wrap their title at the width of their content (at least 260)
  and get a taller title area for it.
* **Cables.** Ports are placed opposite the device they lead to. Where the
  two ports of a cable face each other they are moved onto one line, so the
  cable is a single straight segment; several cables between the same two
  devices become parallel straight lines. Other cables leave each port at a
  right angle and run straight between the two stubs. If that line would pass
  through a device, the cable bends around it (at most a few bends).
* **Cable labels** (speed · VLANs · label) are always drawn, on the cable's
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
* Diagrams are larger than before: spacing was preferred over density.
* Files arranged with an earlier version keep their stored positions. Their
  status shows *edited since arranged* until Auto-arrange is used again,
  because the auto-arranged layout itself changed.

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
  the widest loopback chip (loopback ids and addresses);
* groups (ids, parents, labels and kinds);
* cables (ids and their endpoints `device:interface`; which end is `a` and
  which is `b` doesn't matter) and the text drawn on them (speed, VLANs,
  label);
* networks (ids, labels, and the subtitle shown from `vlan`/`cidr`, plus the
  derived set of member devices);
* relations (ids and the set of devices they connect), and per pair of
  devices the label texts and the width of the bundle (protocol display
  names and line styles, relation labels, nesting through `over`).

**Not relevant:**
* order of keys, sections and list items (devices, interfaces, children,
  loopbacks, cables, endpoints, prefixes, VLAN lists, `over`, …);
* comments, quoting and formatting;
* the `layout` section itself;
* manual moves and load order;
* direction, attributes, descriptions, the medium of a cable, cable
  ids (`cable:`), child interfaces, and interface addresses as long as they don't change which
  networks a device belongs to. In short: what isn't drawn as text and
  doesn't change a size.

## Validation and limits

Validation reports **all** problems it finds (up to 200). Each one comes with
a line number, a path such as `relations.gre-1.over`, the offending source line
and, where possible, a suggestion. In the editor the same problems are shown
next to the object and field they concern.

**Errors** cover:
* missing required keys, wrong value types and unknown keys;
* invalid or duplicate ids, and unknown references (devices, interfaces,
  groups, networks, `over`);
* two cables on one port, or a cable on a child interface or a loopback;
* an interface id used twice on a device (across interfaces, children and
  loopbacks), a `type` on a physical interface or a loopback, a child type
  other than `logical` or `tunnel`, children of a child;
* `over` cycles;
* invalid loopback addresses, invalid network prefixes, invalid or repeated
  VLAN IDs, and bad colours, categories or styles;
* keys and values of the earlier format (see
  [Changes from the earlier format](#changes-from-the-earlier-format)).

**Warnings** don't block rendering:
* an unknown protocol without a category;
* different VLANs at the two ends of a link;
* an address whose derived VLAN is ambiguous (overlapping networks with
  different VLANs);
* a network without a prefix, or a prefix with bits beyond its length;
* a relation carried over another relation whose endpoints don't match;
* an interface address that isn't a valid IP address;
* the same address assigned twice.

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
| Interfaces per device / total (physical, children and loopbacks together) | 512 / 20 000 |
| Endpoints per relation | 64 |
| Group nesting | 8 levels |
| Attributes per entity | 100 |

## Changes from the earlier format

The format version is unchanged (`netatlas: 1`). Files written for an earlier
state of the format have to be updated by hand; netatlas doesn't convert
them, and it doesn't keep the old keys or values as aliases. Opening such a
file shows an error for every key or value below, each saying what to do.
Nothing of the old keys is read into the model, and the file is kept as it
is until you change it.

### Interface hierarchy and device fields

| Before | Now | What to do |
|---|---|---|
| `type` on an entry of `interfaces` (any value, `physical` included) | removed: the entry is always a physical interface | Delete the key. If the entry wasn't a port, move it (next two rows). |
| `type: loopback` on an interface | a `loopbacks` list on the device | Move the entry into `loopbacks:` of the same device and delete its `type`. Its `id`, `label`, `ip`, `vrf`, `description` and `attrs` stay as they are; references such as `r1:lo0` keep working. |
| `type: tunnel` on an interface | `type: tunnel` on a **child** | Move the entry into `children:` of the physical interface the tunnel runs on. |
| `type: vlan`, `svi`, `subinterface`, `virtual`, `lag`, `bundle`, `irb`, `bvi`, `vti` (or any other text) | `type: logical` or `type: tunnel` on a child | Move the entry into `children:` of a physical interface and write `type: logical` (or `tunnel` for a tunnel endpoint such as a VTI). Keep the specific function in `label`, `description` or `attrs` if you need it. |
| a cable on a logical interface was refused | a link end must name a physical interface | Unchanged in effect; the error now names the physical interface to cable. |
| `mac` on a loopback | removed | Delete it. |
| `vendor`, `model`, `role`, `mgmt` on a device | removed | Delete them, or move the values into `attrs:` (shown in the details only). They are no longer drawn in the device's subtitle, shown in tooltips or searched. |
| `router_id` on a device | removed | Delete it. The loopback and its addresses are unaffected; name its purpose in the loopback's `label` if you like. The ★ marker and the "router ID" line in the details are gone. |
| interface ids unique among a device's interfaces | unique among interfaces, children and loopbacks of the device | Rename one of two entries that share an id. |

```yaml
# before                                  # now
- id: r1                                  - id: r1
  vendor: Juniper                           loopbacks:
  router_id: lo0                              - {id: lo0, ip: 10.255.0.1/32}
  interfaces:                               interfaces:
    - {id: ge-0/0/0, ip: 192.0.2.1/30}        - id: ge-0/0/0
    - {id: st0.10, type: tunnel}                ip: 192.0.2.1/30
    - {id: lo0, type: loopback,                 children:
       ip: 10.255.0.1/32}                         - {id: st0.10, type: tunnel}
```

### One place per fact (earlier change)

| Before (0.1.x) | Now | What to do |
|---|---|---|
| `kind` on a network | removed | Delete it. A network is always an IP network. |
| `vrf` on a network | removed | Delete it, and set `vrf:` on the interfaces (or loopbacks) that are in the VRF. |
| `members` on a network | removed; derived | Delete it. Make sure each former member has an interface or loopback address inside the network's `cidr`, and that the network has a `cidr`. A "network" that was only a list of devices (a VRF, a zone) isn't an IP network: remove it, or model it as a relation or group. |
| `cidr` that isn't a valid prefix | now an error (was a warning) | Write an address with a prefix length. |
| `vlan` on a network: any text | a VLAN ID, 1–4094 | Write the number. |
| `vlan` on an interface or loopback | removed; derived | Delete it. Set `vlan:` on the network that contains the interface's address. For VLANs a port carries on a cable, use `vlans:` on the link end. |
| `speed` on an interface | removed | Move it to `speed:` of the link cabled to that port. |
| `media` on an interface | removed | Move it to `medium:` of the link cabled to that port. |
| a link without `medium`/`speed` took them from its interfaces | no fallback | Set them on the link. |
| (none) | `vlans` on a link end | New: VLANs permitted per end. |
| (none) | `vrf` on an interface | New. |
| group `kind: row` | `kind: floor` | Rename. |
| warning "speed mismatch" between two interfaces | gone | Speed exists once, on the link. |
| warning "address … is outside" a network | gone | An address outside the prefix simply isn't a member. |

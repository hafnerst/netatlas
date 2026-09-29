# netatlas YAML format (version 1)

A netatlas file describes **one** network architecture. It separates two
things that are often mixed up in diagrams:

| Concept | Section | Drawn in | Meaning |
|---|---|---|---|
| Physical connectivity | `links` | Physical view | A real cable / radio link between two ports |
| Logical relationships | `relations` | Logical view | Protocol sessions, tunnels, overlays, redundancy groups, service dependencies |
| Layer-2/3 segments | `networks` | Logical view | Subnets, VLANs, VNIs, VRFs, zones … and their members |
| Locations | `groups` | Physical view | Sites, buildings, rooms, rows, racks, providers (nestable) |

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

## Identifiers

* Every entity in `groups`, `devices`, `links`, `networks` and `relations`
  has an `id`. **Ids are unique across all of these sections**, so a reference
  such as `over: x` is never ambiguous.
* Ids: 1–64 characters from `A–Z a–z 0–9 _ . -`, starting with a letter or
  digit. `:` is reserved.
* Interface ids are unique **within their device** and may also contain `/`
  (`ge-0/0/1`, `Ethernet1/49`). Globally an interface is `device:interface`.
* Ids are the stable keys of the model. Labels can change freely.

## Endpoint references

Links, network members and relation endpoints refer to devices or interfaces:

```yaml
- r1                      # a device
- r1:ge-0/0/1             # an interface of a device (quote it inside [ ] or { } if you like)
- {device: r1, interface: ge-0/0/1, role: hub, address: 10.0.0.1/30, attrs: {asn: 65001}}
```

The mapping form (`role`, `address`, `attrs`) is available for network members
and relation endpoints. Physical links accept only `device` / `interface`.

## `groups`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name (defaults to the id) |
| `kind` | | Free text, e.g. `site`, `building`, `room`, `row`, `rack`, `provider`, `cloud`, `zone` (default `site`). `site`/`campus`/`building`/`datacenter`/`region` are emphasised; `provider`/`cloud`/`external` are drawn dashed. |
| `parent` | | Id of the enclosing group (at most 8 levels) |
| `description`, `attrs` | | |

## `devices`

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `label` | | Display name |
| `type` | | Free text. Recognised icons: `router`, `switch`, `l3switch`, `firewall`, `server`, `hypervisor`, `cloud`, `ap`, `storage`, `loadbalancer`, `host`, plus aliases such as `leaf`, `spine`, `fw`, `vm`, `internet`, `pc`. Other values get a generic icon. |
| `group` | | Id of the group the device is located in |
| `tier` | | 0–9: vertical row in the physical view (0 = top). By default this comes from the type: cloud/WAN → routers → firewalls → core → access → APs → servers/hosts. |
| `vendor`, `model`, `role`, `mgmt` | | Shown in the subtitle, tooltip and details |
| `router_id` | | Id of one of **this device's loopbacks**. Its IPv4 address is the router ID. Must name an interface of `type: loopback`; a warning is given if that loopback has no IPv4 address. |
| `description`, `attrs` | | |
| `interfaces` | | List of interfaces (below), **including loopbacks**. The shorthand `interfaces: [eth0, eth1]` is allowed. |

### Interfaces

| Key | Description |
|---|---|
| `id` | required, unique within the device. This is the stable identifier and the interface name used in references (`r1:lo0`). |
| `label` | optional display name (for loopbacks: the loopback's name, e.g. "Router ID"; defaults to the id) |
| `type` | default `physical`. **Logical types cannot be cabled**: `loopback`, `tunnel`, `vlan`, `svi`, `subinterface`, `virtual`, `lag`, `bundle`, `irb`, `bvi`, `vti` |
| `speed` | e.g. `1G`, `10G`, `100G`, `250M` (sets the cable width if the link gives none) |
| `media` | e.g. `fiber`, `copper`, `dac`, `aoc`, `wireless`, `lte` (sets the cable style if the link gives none) |
| `ip` | one address or a list: `ip: 10.0.0.1/30` or `ip: [192.0.2.1/24, 2001:db8::1/64]`. Addresses of ordinary interfaces that aren't valid IPv4/IPv6 addresses (e.g. `dhcp`) give a *warning* and are shown as written. |
| `vlan`, `mac`, `description`, `attrs` | |

### Loopbacks

A loopback is an interface with `type: loopback`. There's no separate
loopback structure: it uses the same interface abstraction, so files that
already declare loopbacks this way need no changes. A device can have zero,
one or several loopbacks.

```yaml
devices:
  - id: edge-a
    type: router
    router_id: lo0                      # optional: which loopback provides the router ID
    interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
      - {id: lo1, type: loopback, label: BGP source (IPv6), ip: [2001:db8:ffff::a/128]}
      - {id: ge-0/0/0, speed: 10G}
relations:
  - id: ibgp-v6
    protocol: ibgp
    endpoints: [edge-a:lo1, edge-b:lo1]  # a session sourced from loopbacks
  - id: gre-lab
    protocol: gre
    endpoints: [edge-a:lo0, edge-b:lo0]  # a tunnel whose endpoints are loopbacks
```

Rules (errors unless noted):

* `id`: the stable identifier, unique on the device. `label` is the loopback's
  name.
* `ip`: at least one address. Each must be an IPv4 or IPv6 address **with a
  prefix length** (`10.255.0.1/32`, `2001:db8::1/128`); `/0–32` for IPv4 and
  `/0–128` for IPv6. The same address can't appear twice on one loopback.
  If the same address is used on another interface anywhere in the model, you
  get a *warning*.
* A loopback is logical: it can't be the end of a physical link.
* A loopback may be used anywhere an interface can be referenced: relation
  endpoints (tunnel endpoints, BGP/LDP session sources), network members, and
  `router_id`. It doesn't have to be referenced at all.
* Display: in the **logical view** each device shows its loopbacks as small
  chips under the device (★ marks the router-ID loopback; a device with
  loopbacks is shown even if it has no relations). The device's **details**
  list them in their own table with the relations that use them. The
  **physical view** never draws them, because they have no port or cable.

## `links` (physical cabling only)

| Key | Required | Description |
|---|---|---|
| `id` | yes | |
| `a`, `b` | yes | Endpoints. `device:interface`, or just `device` when the port is unknown or irrelevant (e.g. "Internet"). |
| `medium` | | `fiber`, `copper`, `dac`, `aoc`, `wireless`/`lte`/`5g`/`microwave`, `serial`, `virtual`, or any other text (it gets its own colour). Defaults to the interfaces' `media`. |
| `speed` | | Defaults to the interfaces' speed. A mismatch between the two interfaces produces a warning. |
| `label`, `cable` (cable/circuit id), `description`, `attrs` | | |

Rules: a port can have at most one cable. Logical interfaces (see above) can't
be cabled. A link can't connect a port to itself.

## `networks`

| Key | Description |
|---|---|
| `id` | required |
| `label` | |
| `kind` | free text; common: `subnet` (default), `vlan`, `vni`, `vrf`, `zone`, `segment` |
| `cidr` | one prefix or a list |
| `vlan`, `vrf` | |
| `members` | endpoint references (devices or interfaces); the interface's first address (or `address:`) is shown on the membership line |
| `description`, `attrs` | |

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
    vrf-cust-a: [240, 90]
    ospf-core: [120, 60]
```

* Values are `[x, y]` numbers; netatlas writes integers, sorted by id.
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
| You make an edit that affects geometry (adding, removing or renaming objects, changing labels, groups, cables, relations, members, loopback count …) | The positions shown **before** the edit are stored for both views, in the same undo step. New objects are placed next to their neighbors; nothing else moves. Edits that don't affect geometry (vendor, addresses, attrs, descriptions …) store nothing. |
| You click **Auto-arrange** | All positions of the chosen view(s) are recomputed for the whole model and stored (one undo step). If they already equal the stored ones, nothing happens at all. |
| You edit the **YAML** tab | The text is taken literally, including its `layout` section. Deleting the section there returns to automatic positions. |

So **load → arrange → export → reload** shows exactly the same picture. A
file that has never been edited in netatlas keeps showing the auto-arranged
layout, which is itself deterministic.

### Auto-arrange

* **Physical view:** tiered, nested group boxes. Cloud/WAN is on top, then
  routers, firewalls, core, access, APs, and servers/hosts; a device's `tier`
  overrides this. Ungrouped devices are split into connected components that
  are packed separately. Rows and sibling groups are reordered with barycenter
  sweeps to reduce crossings; groups with no outside connections go last.
  Device boxes grow to fit their ports and port labels.
* **Logical view:** each connected component (devices, networks, multipoint
  hubs) is laid out on its own with stress majorization, which spaces graph
  distances evenly; very large components (over 300 nodes) use a
  force-directed layout instead. It is seeded from the auto-arranged
  *physical* positions, so the two views keep a similar mental map, but never
  from manual positions. Then:
  * boxes are pushed apart with room for relation bundles and labels;
  * node positions are swapped where that strictly reduces edge crossings and
    edges passing through nodes;
  * nodes that an edge would pass through are moved aside;
  * components are packed in rows, largest first.

**Determinism.** Auto-arrange is a pure function of a canonical *layout
input* (`src/layout-input.ts`). It uses no randomness, no clock, no browser
measurement (text widths are estimated from character classes) and no
locale-dependent ordering. Every list is sorted by id with plain code-unit
comparison, and every tie is broken by id. The arithmetic uses only `+ − × ÷`,
`Math.sqrt` and constant tables. The ECMAScript spec requires these to give
the same result in every browser; `Math.hypot`, `sin` and `cos` are allowed
to vary, so they aren't used. Results are rounded to whole pixels.

**Equivalent input.** Two files arrange identically (in the same netatlas
version) when they have the same:

* device ids, labels, tiers (explicit `tier`, else derived from `type`),
  groups, and number of loopbacks;
* groups (ids and parents);
* cables (ids and their endpoints `device:interface`; which end is `a` and
  which is `b` doesn't matter);
* networks (ids, labels, and the subtitle shown from `kind`/`vlan`/`cidr`,
  plus the set of member devices);
* relations (ids and the set of devices they connect).

**Not relevant:**
* order of keys, sections and list items (devices, interfaces, cables,
  endpoints, members, `over`, …);
* comments, quoting and formatting;
* the `layout` section itself;
* manual moves and load order;
* protocols, categories, direction, attributes, addresses, vendors,
  descriptions.

## Validation and limits

Validation reports **all** problems it finds (up to 200). Each one comes with
a line number, a path such as `relations.gre-1.over`, the offending source line
and, where possible, a suggestion. In the editor the same problems are shown
next to the object and field they concern.

**Errors** cover:
* missing required keys, wrong value types and unknown keys;
* invalid or duplicate ids, and unknown references (devices, interfaces,
  groups, networks, `over`, `router_id`);
* two cables on one port, or a cable on a logical interface;
* `over` cycles;
* invalid loopback addresses, and bad colours, categories or styles.

**Warnings** don't block rendering:
* an unknown protocol without a category;
* an interface speed mismatch;
* a relation carried over another relation whose endpoints don't match;
* an interface address that isn't a valid IP address;
* the same address assigned twice;
* a network member whose address lies outside the network's `cidr`;
* a `router_id` loopback without IPv4.

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
| Interfaces per device / total | 512 / 20 000 |
| Endpoints per relation / members per network | 64 / 1 000 |
| Group nesting | 8 levels |
| Attributes per entity | 100 |

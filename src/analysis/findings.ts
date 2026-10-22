/**
 * The consistency findings as an architect reads them: what is wrong in
 * one line, what follows from it where that is derivable, the evidence
 * (the finding's own message and the objects it concerns), and the next
 * step. Each finding is classified:
 *
 *   contradiction  two parts of the configuration disagree (a next hop on
 *                  no network of its interface, different VLANs at the two
 *                  ends of a cable);
 *   missing        something a configured function needs is not written
 *                  (no DHCP server for a relay, no querier);
 *   risk           consistent, but likely to cause trouble (a duplicate
 *                  route, a speed mismatch, overcommitted hosts);
 *   unsupported    the check can't evaluate what is written.
 *
 * Findings with one cause are grouped: the same configuration field (the
 * same object and field the findings point to), or the same object, named
 * by several checks. A group keeps every finding and its evidence; nothing
 * is hidden, and nothing is changed: the next step is a suggestion, never an
 * automatic fix. Pure and deterministic.
 */
import { Finding, checkById } from './checks';

export type FindingClass = 'contradiction' | 'missing' | 'risk' | 'unsupported';

export const CLASS_TEXT: { [c in FindingClass]: string } = {
  contradiction: 'Contradictory configuration',
  missing: 'Missing required information',
  risk: 'Potential risk',
  unsupported: 'Not evaluated',
};

/** What a check's findings mean: their class, what follows from them, and the next step. */
interface CheckMeaning {
  cls: FindingClass;
  consequence?: string;
  action: string;
}

const M = (cls: FindingClass, action: string, consequence?: string): CheckMeaning => (consequence ? { cls, action, consequence } : { cls, action });

const MEANING: { [id: string]: CheckMeaning } = {
  'route-nexthop-self': M('contradiction', 'Set the next hop to a neighbour’s address, or remove the route.', 'The route can’t be used: traffic for its prefix takes another route or none.'),
  'route-nexthop-interface': M('contradiction', 'Correct the next hop or the exit interface so the next hop is on the interface’s network.', 'The route is not installed: traffic for its prefix takes another route or none.'),
  'route-nexthop-unresolved': M('contradiction', 'Give the next hop on a connected network (in the route’s VRF), or add the route it resolves through.', 'The route is not installed; a floating route with a higher distance may take over.'),
  'route-nexthop-recursive': M('risk', 'Check that the recursive resolution is intended; a connected next hop is simpler to reason about.'),
  'route-exit-interface': M('contradiction', 'Route through an interface that forwards (the aggregate instead of a member, a cabled port, the route’s VRF).', 'Traffic for the prefix can’t leave by it.'),
  'route-duplicate': M('risk', 'Remove one of the two routes.'),
  'route-conflict': M('contradiction', 'Decide which route is meant and remove or re-rank the other (distance, metric).', 'Traffic may go a way that is not intended.'),
  'vlan-access-mismatch': M('contradiction', 'Put both ends of the cable in the same access VLAN.', 'Frames reach the other end in another VLAN: hosts on the two sides can’t reach each other at layer 2.'),
  'vlan-trunk-mismatch': M('contradiction', 'Allow the same VLANs on both ends of the trunk.', 'A VLAN carried on one end only is cut at this cable: communications in it that need the cable fail.'),
  'vlan-native-mismatch': M('contradiction', 'Use the same native VLAN on both ends.', 'Untagged frames land in different VLANs on the two sides.'),
  'vlan-access-trunk': M('contradiction', 'Make both ends access ports in one VLAN, or both trunks.', 'Untagged frames are dropped or land in the native VLAN.'),
  'vlan-unknown': M('missing', 'Define the VLAN (a network with its VLAN, or a VLAN interface), or remove it from the port.'),
  'lag-member-vlans': M('contradiction', 'Carry the same VLANs on every member’s far end.', 'Traffic hashed onto a member whose far end lacks the VLAN is lost.'),
  'routing-policy': M('missing', 'Write the prefix, enable the protocol or name a neighbour of the protocol; end each filter with an explicit catch-all rule.', 'Routes are not advertised, redistributed or matched as the policy intends.'),
  'link-mtu-mismatch': M('risk', 'Use the same MTU on both ends.', 'Large packets are dropped or fragmented in one direction.'),
  'tunnel-mtu': M('risk', 'Lower the tunnel’s MTU below its underlay’s, less the encapsulation.', 'Full-size packets in the tunnel need fragmentation or are dropped.'),
  'link-speed-mismatch': M('risk', 'Set the same speed on both ends (or auto on both).', 'The link may not come up, or runs at the lower speed.'),
  'link-duplex-mismatch': M('risk', 'Set the same duplex on both ends.', 'Collisions and loss under load.'),
  'lag-member-speed': M('risk', 'Use members of one speed.', 'Load is shared unevenly; some switches reject such a bundle.'),
  'lag-peer-devices': M('contradiction', 'Cable every member to the same peer (or configure MLAG on the peers).', 'The bundle can’t form as written.'),
  'lag-min-links': M('contradiction', 'Lower min_links to the number of members, or add members.', 'The aggregate can never be up.'),
  'link-subnet-mismatch': M('contradiction', 'Put both ends of the cable in one subnet.', 'The two interfaces can’t reach each other directly; routing over the cable fails.'),
  'address-reserved': M('contradiction', 'Use a host address of the subnet (not its network or broadcast address).'),
  'duplicate-mac': M('contradiction', 'Give each interface its own MAC address.', 'Switches learn the address in two places: frames go to the wrong port.'),
  'ospf-area-mismatch': M('contradiction', 'Use the same OSPF area on both ends of the adjacency.', 'The adjacency does not form: routes over it are missing.'),
  'ospf-network-type-mismatch': M('contradiction', 'Use the same OSPF network type on both ends.', 'The adjacency may not form, or forms but routes wrongly.'),
  'ospf-timer-mismatch': M('contradiction', 'Use the same hello and dead intervals on both ends.', 'The adjacency does not form.'),
  'bgp-peer-as': M('contradiction', 'Make each side’s peer AS match the other’s local AS.', 'The session does not establish: no routes are exchanged.'),
  'bgp-session-type': M('contradiction', 'Correct the session type or the AS numbers.'),
  'tunnel-endpoint-mismatch': M('contradiction', 'Point each tunnel end at the other’s source.', 'The tunnel can’t come up: what runs over it fails.'),
  'tunnel-underlay': M('missing', 'Give the tunnel an underlay that reaches its destination (a route, a relation it runs over).', 'The tunnel has no way to its far end in the model.'),
  'vrf-name-case': M('risk', 'Write the VRF name the same way everywhere (VRF names are case-sensitive).'),
  'relation-vrf-mismatch': M('contradiction', 'Put the relation’s endpoints in the same VRF, or correct the endpoints.'),
  'snooping-not-configured': M('missing', 'Say for the VLAN whether IGMP/MLD snooping is enabled (igmp_mld_snooping).'),
  'multicast-no-querier': M('missing', 'Add a querier for the VLAN (a router running IGMP/PIM, or a snooping querier).', 'Snooping switches age the memberships out: receivers lose the stream.'),
  'multicast-no-rp': M('missing', 'Name the rendezvous point for PIM sparse mode.', 'Sources and receivers don’t meet: no shared tree.'),
  'multicast-rp-conflict': M('contradiction', 'Give the routers of the domain the same RP for the group (one static rp everywhere, or a candidate RP).', 'Sources register with one RP, receivers join towards another: the any-source group is not delivered.'),
  'multicast-rpf-not-pim': M('contradiction', 'Enable PIM on the RPF interface, or change the unicast route to the source.', 'The RPF check fails: the stream is not forwarded.'),
  'dhcp-no-server': M('missing', 'Add a DHCP server with a scope for the network, or a relay to one.', 'The client gets no address (its link-local fallback, if any).'),
  'dhcp-relay-no-server': M('missing', 'Point the relay at a DHCP server of the model that has a scope for the network.', 'The clients behind the relay get no address.'),
  'protocol-not-enabled': M('missing', 'Enable the protocol on the device (Protocols), or remove the relation.', 'The relation forms no adjacency: what it would carry is missing.'),
  'protocol-unused': M('risk', 'Remove the protocol, or add the relations that use it.'),
  'duplicate-router-id': M('contradiction', 'Give each router its own router ID.', 'Routing protocols confuse the two routers.'),
  'vip-outside-subnet': M('contradiction', 'Put the virtual address in the interface’s subnet.', 'Hosts can’t reach the gateway address.'),
  'fhrp-group-mismatch': M('contradiction', 'Use the same group and virtual address on every member.', 'The members don’t form one redundancy group.'),
  'vswitch-uplink-vlan': M('contradiction', 'Carry the port group’s VLANs on the virtual switch’s uplinks (and their far ends).', 'The guests on the port group are cut off from the network.'),
  'vnic-network-vlan': M('contradiction', 'Match the vNIC’s network to its port group’s VLAN.'),
  'container-parent-vlan': M('contradiction', 'Carry the network’s VLAN on the parent interface.'),
  'ha-restart-portgroup': M('missing', 'Create the port group on every member of the HA cluster.', 'A VM restarted on another host loses its network.'),
  'hypervisor-overcommit': M('risk', 'Check the guests’ vCPU and RAM against the host’s.', 'Guests compete for resources under load.'),
};

export interface PresentedFinding {
  finding: Finding;
  /** the check's title */
  check: string;
  cls: FindingClass;
  /** the first line: the problem */
  problem: string;
  consequence?: string;
  /** the finding's message and the objects it concerns */
  evidence: string[];
  action: string;
}

export interface FindingGroup {
  /** a stable key (the object and field) */
  key: string;
  /** "3 findings point to hq-core1:Ethernet49 (vlans)" */
  cause: string;
  /** the object the findings share */
  ref: string;
  field?: string;
  findings: PresentedFinding[];
}

/** One finding as an architect reads it. */
export function presentFinding(f: Finding): PresentedFinding {
  const def = checkById(f.check);
  const m = MEANING[f.check] || M(f.severity === 'error' ? 'contradiction' : 'risk', 'Go to the field it is about and correct the value; where it is intended, switch the check off in the model’s checks: section.');
  const msg = f.message.charAt(0).toUpperCase() + f.message.slice(1);
  const out: PresentedFinding = { finding: f, check: def ? def.title : f.check, cls: m.cls, problem: msg, evidence: [`${def ? def.title : f.check} (${f.check}, ${f.severity})`].concat(f.refs.map((r) => r)), action: m.action };
  if (m.consequence) out.consequence = m.consequence;
  return out;
}

/**
 * Group the findings by a shared cause: the same object and field named by
 * more than one finding (of the same check or of different ones). The
 * others stay single. Groups first (largest first), then the singles, in
 * the findings' order.
 */
export function groupFindings(fs: Finding[]): { groups: FindingGroup[]; singles: PresentedFinding[] } {
  const by = new Map<string, PresentedFinding[]>();
  const order: string[] = [];
  for (const f of fs) {
    const k = f.at.ref + '\n' + (f.at.field || '');
    if (!by.has(k)) {
      by.set(k, []);
      order.push(k);
    }
    (by.get(k) as PresentedFinding[]).push(presentFinding(f));
  }
  const groups: FindingGroup[] = [];
  const singles: PresentedFinding[] = [];
  for (const k of order) {
    const list = by.get(k) as PresentedFinding[];
    if (list.length < 2) {
      singles.push(list[0]);
      continue;
    }
    const [ref, field] = k.split('\n');
    const name = ref.replace(/^[a-z]+:/, '');
    groups.push({ key: k, ref, field: field || undefined, cause: `${list.length} findings point to ${name}${field ? ' (' + field + ')' : ''}: one change there may resolve them`, findings: list });
  }
  groups.sort((a, b) => b.findings.length - a.findings.length || (a.key < b.key ? -1 : 1));
  return { groups, singles };
}

/** The findings of a class, counted. */
export function classCounts(fs: Finding[]): { [c in FindingClass]: number } {
  const out = { contradiction: 0, missing: 0, risk: 0, unsupported: 0 };
  for (const f of fs) out[presentFinding(f).cls]++;
  return out;
}

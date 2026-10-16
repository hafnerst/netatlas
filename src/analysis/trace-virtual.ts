/**
 * Virtual networking for the path tracer (analysis/trace.ts): where an
 * interface of a guest, or a host's own virtual interface, meets the cables.
 *
 *   * a vNIC on a port group leaves its host through the port group's
 *     virtual switch, by its teaming: active / standby the first uplink that
 *     is up (in order), LACP every member of the bond, load- or source-based
 *     the first uplink that is up (the one the trace follows); a virtual
 *     switch without uplinks is internal to its host;
 *   * a vNIC in passthrough sends straight out of the host port bound to it;
 *   * a VLAN subinterface of a vNIC (guest tagging) is its vNIC;
 *   * a veth on a bridge network stays on the bridge: beyond it only through
 *     the host (routed, NAT); a bridge network's own interface on the host
 *     (docker0) is on it too;
 *   * a veth on a macvlan or ipvlan network leaves through the network's
 *     parent interface (and on through it, when that is itself a vNIC), but
 *     the host itself can't reach its macvlan containers;
 *   * an overlay network joins its containers on every host it spans (the
 *     tunnel between the hosts is not traced).
 *
 * Two ends that share a virtual segment (the same virtual switch, the same
 * container network) reach each other inside the host, without a cable.
 */
import { Device, Interface, Model, ifaceKey } from '../model/types';
import { interfaceVlans, subinterfaceParent } from '../model/derive';
import { cnetRef, portGroupL2, portGroupOf, portGroupRef, uplinkPorts, vethNetwork, vnicHost, vnicPortGroup, vswitchRef } from '../model/virtual';

export interface VirtEnd {
  /** the device whose cables the traffic leaves by (a guest's host, or the host itself) */
  device: string;
  /** the ports of that device it leaves by (none: it doesn't leave the host) */
  ports: string[];
  /** the virtual segments it is on (virtual switch, container network refs): ends that share one meet inside the host */
  domains: string[];
  /** what it crosses inside the host: port group, virtual switch, container network (refs) */
  refs: string[];
  notes: string[];
  /** on a macvlan / ipvlan network of this device: that device can't reach it */
  childOf?: string;
  /** set when it can't leave the host at all: why */
  closed?: string;
  /** the VLAN it is in on its virtual switch (a port group's untagged VLAN, a guest's tag), when known */
  vlan?: number;
}

type Up = (device: string, iface: string) => boolean;
/** the host a VM runs on now, when it was moved (HA restart) */
type Where = ((guest: string) => string | undefined) | undefined;

const TEAMING_TEXT: Record<string, string> = { active_standby: 'active / standby', load_based: 'load-based', source_based: 'source-based', lacp: 'LACP' };

/** How an interface meets the cables when virtual networking is involved; null when it is an ordinary interface. */
export function virtEnd(model: Model, device: string, iface: string, up: Up, depth = 0, where?: Where): VirtEnd | null {
  let i = model.index.interfaces.get(ifaceKey(device, iface));
  if (!i || depth > 3) return null;
  // a guest's VLAN subinterface (guest tagging) leaves through its vNIC, in its own VLAN
  let tag: number | undefined;
  if (i.type === 'virtual') {
    const p = subinterfaceParent(model, i);
    const pi = p !== undefined ? model.index.interfaces.get(ifaceKey(device, p)) : undefined;
    if (!pi || pi.type !== 'vnic') return null;
    tag = interfaceVlans(model, i)[0];
    i = pi;
  }
  if (i.type === 'vnic') {
    const v = vnicEnd(model, i, up, where);
    if (v && tag !== undefined) v.vlan = tag;
    return v;
  }
  if (i.type === 'veth') return vethEnd(model, i, up, depth, where);
  if (i.type === 'bridge' && i.derived !== undefined) {
    const d = model.index.devices.get(device) as Device;
    return { device, ports: [], domains: [cnetRef(d.id, i.derived)], refs: [cnetRef(d.id, i.derived)], notes: [] };
  }
  return null;
}

function vnicEnd(model: Model, i: Interface, up: Up, where: Where): VirtEnd | null {
  // a VM restarted on another host: the port group of the same name there
  const moved = where ? where(i.device) : undefined;
  const mh = moved !== undefined ? model.index.devices.get(moved) : undefined;
  const mx = mh ? portGroupOf(mh, i.portGroup) : undefined;
  if (mh && i.portGroup !== undefined && !mx) return { device: mh.id, ports: [], domains: [], refs: [], notes: [], closed: `${i.device} runs on ${mh.label} now, which has no port group ${i.portGroup}` };
  const x = mh && mx ? { host: mh, vswitch: mx.vswitch, pg: mx.pg } : vnicPortGroup(model, i);
  if (x) {
    const { host, vswitch: vs, pg } = x;
    const out: VirtEnd = { device: host.id, ports: [], domains: [vswitchRef(host.id, vs.name)], refs: [portGroupRef(host.id, pg.name), vswitchRef(host.id, vs.name)], notes: [] };
    const l2 = portGroupL2(pg);
    if (l2.untagged !== undefined) out.vlan = l2.untagged;
    if (!vs.uplinks.length) {
      out.closed = `${vs.name} has no uplinks: it is internal to ${host.label}`;
      return out;
    }
    const teaming = vs.teaming || '';
    if (teaming === 'lacp') {
      const ports = uplinkPorts(model, host, vs).filter((p) => up(host.id, p));
      out.ports = ports;
      if (ports.length) out.notes.push(`${vs.name}: LACP over ${ports.join(', ')}`);
    } else {
      // the first uplink that is up (an aggregate as its members)
      const live = vs.uplinks.filter((u) => upAll(model, host, u, up));
      if (live.length) {
        const first = live[0];
        out.ports = expand(model, host, first);
        const rest = vs.uplinks.filter((u) => u !== first);
        const how = TEAMING_TEXT[teaming] || 'teaming';
        if (teaming === 'active_standby' || !teaming) {
          out.notes.push(`${vs.name}: ${first} active${rest.length ? ` (${rest.join(', ')} standby)` : ''}`);
          const down = vs.uplinks.slice(0, vs.uplinks.indexOf(first));
          if (down.length) out.notes.push(`${down.join(', ')} down: ${vs.name} fails over to ${first}`);
        } else out.notes.push(`${vs.name}: ${how} teaming, this flow on ${first}`);
      }
    }
    if (!out.ports.length) out.closed = `every uplink of ${vs.name} on ${host.label} is down`;
    return out;
  }
  if (i.passthrough !== undefined) {
    const h = vnicHost(model, i);
    if (!h) return null;
    const out: VirtEnd = { device: h.id, ports: [i.passthrough], domains: [], refs: [], notes: [`passthrough of ${h.label}:${i.passthrough}`] };
    if (!up(h.id, i.passthrough)) {
      out.ports = [];
      out.closed = `${h.label}:${i.passthrough} (passthrough) is down`;
    }
    return out;
  }
  return null;
}

function vethEnd(model: Model, i: Interface, up: Up, depth: number, where: Where): VirtEnd | null {
  const x = vethNetwork(model, i);
  if (!x) return null;
  const { net, owner } = x;
  const ref = cnetRef(owner.id, net.name);
  if (net.driver === 'bridge') {
    return { device: owner.id, ports: [], domains: [ref], refs: [ref], notes: [], closed: `${i.device} is on the bridge ${net.iface || net.name} of ${owner.label}: beyond it only through ${owner.label}` };
  }
  if (net.driver === 'overlay') {
    return { device: owner.id, ports: [], domains: [ref], refs: [ref], notes: [`overlay ${net.name}: between its hosts over their own network (not traced)`], closed: `${i.device} is on the overlay ${net.name}: beyond it only through a router on it` };
  }
  if ((net.driver === 'macvlan' || net.driver === 'ipvlan') && net.parent !== undefined) {
    const host = x.host;
    const under = virtEnd(model, host.id, net.parent, up, depth + 1, where);
    const base: VirtEnd = under || { device: host.id, ports: portsOfPlain(model, host.id, net.parent), domains: [], refs: [], notes: [] };
    const out: VirtEnd = { ...base, domains: [ref].concat(base.domains), refs: [ref].concat(base.refs), notes: [`${net.driver} ${net.name} on ${host.label}:${net.parent}`].concat(base.notes), childOf: host.id };
    if (!under && !out.ports.some((p) => up(host.id, p))) out.closed = `${host.label}:${net.parent} (parent of ${net.name}) is down`;
    return out;
  }
  if (net.driver === 'none') return { device: owner.id, ports: [], domains: [], refs: [ref], notes: [], closed: `${i.device} is on the network ${net.name} (driver none): no network` };
  return null;
}

/** The ports of a host interface, plain (a port itself, an aggregate's members). */
function portsOfPlain(model: Model, device: string, iface: string): string[] {
  const i = model.index.interfaces.get(ifaceKey(device, iface));
  if (!i) return [];
  return i.type === 'virtual' && i.members.length ? i.members.slice() : [iface];
}

function expand(model: Model, host: Device, u: string): string[] {
  return portsOfPlain(model, host.id, u);
}

function upAll(model: Model, host: Device, u: string, up: Up): boolean {
  return up(host.id, u) && expand(model, host, u).some((p) => up(host.id, p));
}

/** The segment two ends share inside a host, if any. */
export function sharedDomain(a: VirtEnd | null, b: VirtEnd | null): string | undefined {
  if (!a || !b) return undefined;
  return a.domains.find((d) => b.domains.indexOf(d) >= 0);
}

/** "port group Apps", "vSwitch0", "network bridge": a virtual ref in words. */
export function virtRefText(ref: string): string {
  const parts = ref.split(':');
  const name = parts.slice(2).join(':');
  if (parts[0] === 'portgroup') return 'port group ' + name;
  if (parts[0] === 'cnet') return 'network ' + name;
  return name;
}

/**
 * Virtualization, derived from the model (validation/virtual.ts has the
 * format and its rules): the guests of a host, the virtual switch and port
 * group of a VM's virtual NIC (and the VLANs it gives it), the container
 * network of a container's attachment, the hypervisor a container in a VM
 * finally runs on, the members of an HA cluster. Pure; cached per model.
 */
import { ContainerNetwork, Device, Interface, Model, Network, PortGroup, VSwitch, VlanRange, ifaceKey } from './types';
import { DeviceLike, capabilities } from './capabilities';

/** Is a device a guest (a VM or a container)? */
export function isGuest(d: DeviceLike | undefined): boolean {
  return !!d && capabilities(d).canBeGuest !== null;
}

/** Is a device a VM (a guest of a hypervisor)? */
export function isVm(d: DeviceLike | undefined): boolean {
  return !!d && capabilities(d).canBeGuest === 'vm';
}

/** Is a device a container (a guest of a container engine)? */
export function isContainer(d: DeviceLike | undefined): boolean {
  return !!d && capabilities(d).canBeGuest === 'container';
}

/** May a device run VMs (with the Hypervisor service)? */
export function mayHostVms(d: DeviceLike | undefined): boolean {
  return !!d && capabilities(d).canHostGuests.vms;
}

/** May a device run containers (with the Container engine service)? */
export function mayHostContainers(d: DeviceLike | undefined): boolean {
  return !!d && capabilities(d).canHostGuests.containers;
}

interface VirtCache {
  /** host id -> its guests (VMs and containers directly on it), in model order */
  guests: Map<string, Device[]>;
  /** cluster name -> its hypervisors, in model order */
  clusters: Map<string, Device[]>;
}

const caches = new WeakMap<Model, VirtCache>();

function cache(model: Model): VirtCache {
  let c = caches.get(model);
  if (c) return c;
  c = { guests: new Map(), clusters: new Map() };
  for (const d of model.devices) {
    if (isGuest(d) && d.host !== undefined && model.index.devices.has(d.host)) {
      const l = c.guests.get(d.host) || [];
      l.push(d);
      c.guests.set(d.host, l);
    }
    if (d.hypervisor && d.hypervisor.cluster) {
      const l = c.clusters.get(d.hypervisor.cluster) || [];
      l.push(d);
      c.clusters.set(d.hypervisor.cluster, l);
    }
  }
  caches.set(model, c);
  return c;
}

/** The guests running directly on a host (VMs on a hypervisor; containers on a container engine), in model order. */
export function guestsOf(model: Model, host: string): Device[] {
  return cache(model).guests.get(host) || [];
}

/** Every guest below a host: its own, and the containers in its VMs (depth first, model order). */
export function allGuestsOf(model: Model, host: string): Device[] {
  const out: Device[] = [];
  const walk = (h: string, depth: number): void => {
    if (depth > 3) return;
    for (const g of guestsOf(model, h)) {
      out.push(g);
      walk(g.id, depth + 1);
    }
  };
  walk(host, 0);
  return out;
}

/** A guest's host, if it has a valid one. */
export function hostOf(model: Model, d: Device | undefined): Device | undefined {
  return d && isGuest(d) && d.host !== undefined ? model.index.devices.get(d.host) : undefined;
}

/** The physical machine a device runs on: itself, or (for a guest) its host's, down to a server. */
export function machineOf(model: Model, d: Device): Device {
  let x = d;
  for (let i = 0; i < 4; i++) {
    const h = hostOf(model, x);
    if (!h) return x;
    x = h;
  }
  return x;
}

/** The chain from a guest to its machine: [guest, host, host's host …]. */
export function hostChain(model: Model, d: Device): Device[] {
  const out = [d];
  let x = d;
  for (let i = 0; i < 4; i++) {
    const h = hostOf(model, x);
    if (!h) break;
    out.push(h);
    x = h;
  }
  return out;
}

/** The members of an HA cluster (hypervisors naming it), in model order. */
export function clusterMembers(model: Model, cluster: string | undefined): Device[] {
  return cluster ? cache(model).clusters.get(cluster) || [] : [];
}

/** Every HA cluster of the model, by name, sorted. */
export function clusters(model: Model): Array<{ name: string; members: Device[] }> {
  return Array.from(cache(model).clusters.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, members]) => ({ name, members }));
}

/** A port group of a host by name, with its virtual switch. */
export function portGroupOf(host: Device | undefined, name: string | undefined): { vswitch: VSwitch; pg: PortGroup } | undefined {
  if (!host || !host.hypervisor || name === undefined) return undefined;
  for (const vs of host.hypervisor.vswitches) for (const pg of vs.portGroups) if (pg.name === name) return { vswitch: vs, pg };
  return undefined;
}

/** The host a vnic's port group (or passthrough port) is on: a VM's host, or the hypervisor itself for its own host interfaces. */
export function vnicHost(model: Model, i: Interface): Device | undefined {
  if (i.type !== 'vnic') return undefined;
  const d = model.index.devices.get(i.device);
  if (!d) return undefined;
  return isVm(d) ? hostOf(model, d) : d.hypervisor ? d : undefined;
}

/** A vnic's virtual switch and port group, if it is on one. */
export function vnicPortGroup(model: Model, i: Interface): { host: Device; vswitch: VSwitch; pg: PortGroup } | undefined {
  const h = vnicHost(model, i);
  const x = h ? portGroupOf(h, i.portGroup) : undefined;
  return h && x ? { host: h, vswitch: x.vswitch, pg: x.pg } : undefined;
}

function idsOf(rs: VlanRange[]): number[] {
  const out: number[] = [];
  for (const r of rs) for (let v = r.from; v <= r.to; v++) if (out.indexOf(v) < 0) out.push(v);
  return out.sort((a, b) => a - b);
}

/** What a port group is at layer 2: an access port group, a trunk, or guest tagging (every VLAN of the uplinks). */
export interface PgL2 {
  kind: 'access' | 'trunk' | 'guest';
  vlans: number[];
  native?: number;
  /** the VLAN its guests' untagged frames are in (access: its VLAN; trunk: its native VLAN) */
  untagged?: number;
}

export function portGroupL2(pg: PortGroup): PgL2 {
  if (pg.guestTagging) return { kind: 'guest', vlans: [] };
  const vlans = idsOf(pg.vlans);
  if (vlans.length === 1) return { kind: 'access', vlans, untagged: vlans[0] };
  return { kind: 'trunk', vlans, native: pg.native, untagged: pg.native };
}

/** "Access · VLAN 10", "Trunk · 10, 20 (native 10)", "Guest tagging (VGT)". */
export function portGroupText(pg: PortGroup): string {
  const l = portGroupL2(pg);
  if (l.kind === 'guest') return 'Guest tagging (VGT)';
  if (l.kind === 'access') return `Access · VLAN ${l.vlans[0]}`;
  return `Trunk · ${rangesText(l.vlans)}${l.native !== undefined ? ` (native ${l.native})` : ''}`;
}

function rangesText(ids: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    out.push(j > i + 1 ? `${ids[i]}–${ids[j]}` : j === i + 1 ? `${ids[i]}, ${ids[j]}` : String(ids[i]));
    i = j;
  }
  return out.join(', ');
}

/** The VLAN a vnic's untagged frames are in (from its port group), if one. */
export function vnicVlan(model: Model, i: Interface): number | undefined {
  const x = vnicPortGroup(model, i);
  return x ? portGroupL2(x.pg).untagged : undefined;
}

/** The container networks a container on `host` may attach to: its host's, and the overlay networks of other engines that list it. */
export function containerNetworks(model: Model, host: string): Array<{ net: ContainerNetwork; owner: Device }> {
  const out: Array<{ net: ContainerNetwork; owner: Device }> = [];
  const h = model.index.devices.get(host);
  if (h && h.containerEngine) for (const n of h.containerEngine.networks) if (n.name) out.push({ net: n, owner: h });
  for (const d of model.devices) {
    if (d.id === host || !d.containerEngine) continue;
    for (const n of d.containerEngine.networks) if (n.driver === 'overlay' && n.hosts.indexOf(host) >= 0 && !out.some((x) => x.net.name === n.name)) out.push({ net: n, owner: d });
  }
  return out;
}

/** A veth's container network (and the engine that defines it). */
export function vethNetwork(model: Model, i: Interface): { net: ContainerNetwork; owner: Device; host: Device } | undefined {
  if (i.type !== 'veth' || i.network === undefined) return undefined;
  const d = model.index.devices.get(i.device);
  const h = hostOf(model, d);
  if (!h) return undefined;
  const x = containerNetworks(model, h.id).find((y) => y.net.name === i.network);
  return x ? { net: x.net, owner: x.owner, host: h } : undefined;
}

/** A container bridge network's interface on its host (docker0). */
export function bridgeIfaceOf(model: Model, owner: Device, net: ContainerNetwork): Interface | undefined {
  return net.driver === 'bridge' && net.iface ? model.index.interfaces.get(ifaceKey(owner.id, net.iface)) : undefined;
}

/** The containers attached to a container network (their veths), in model order. */
export function networkAttachments(model: Model, owner: Device, net: ContainerNetwork): Interface[] {
  const out: Interface[] = [];
  for (const d of model.devices) {
    if (!isContainer(d)) continue;
    for (const i of d.logical) {
      if (i.type !== 'veth') continue;
      const x = vethNetwork(model, i);
      if (x && x.owner === owner && x.net === net) out.push(i);
    }
  }
  return out;
}

/** The vnics on a port group of a host (its guests' and its own host interfaces), in model order. */
export function portGroupAttachments(model: Model, host: Device, pgName: string): Interface[] {
  const out: Interface[] = [];
  for (const d of [host].concat(guestsOf(model, host.id).filter((g) => isVm(g)))) {
    for (const i of d.logical) if (i.type === 'vnic' && i.portGroup === pgName && vnicHost(model, i) === host) out.push(i);
  }
  return out;
}

/** The vnics bound by passthrough to a host port (with their VF), in model order. */
export function passthroughOf(model: Model, host: Device, port: string): Interface[] {
  return guestsOf(model, host.id)
    .filter((g) => isVm(g))
    .reduce((a: Interface[], g) => a.concat(g.logical.filter((i) => i.type === 'vnic' && i.passthrough === port)), []);
}

/** The virtual switch a host port is an uplink of (a member of an aggregate that is one counts). */
export function uplinkOf(model: Model, host: Device, port: string): VSwitch | undefined {
  if (!host.hypervisor) return undefined;
  for (const vs of host.hypervisor.vswitches) {
    if (vs.uplinks.indexOf(port) >= 0) return vs;
    for (const u of vs.uplinks) {
      const a = model.index.interfaces.get(ifaceKey(host.id, u));
      if (a && a.members.indexOf(port) >= 0) return vs;
    }
  }
  return undefined;
}

/** The physical ports of a virtual switch's uplinks (an aggregate's members), in uplink order. */
export function uplinkPorts(model: Model, host: Device, vs: VSwitch): string[] {
  const out: string[] = [];
  for (const u of vs.uplinks) {
    const i = model.index.interfaces.get(ifaceKey(host.id, u));
    if (!i) continue;
    if (i.type === 'virtual' && i.members.length) for (const m of i.members) out.push(m);
    else out.push(u);
  }
  return out;
}

/** "runs on esx-01" (a guest's host, by its label), for the logical view and the details. */
/**
 * The protocol simulation runs a virtual switch or a container network as a
 * bridge of its own ("hv1/vSwitch0"), joined to each vNIC / veth on it by a
 * virtual link ("~web1~eth0"; at another member of an HA cluster, where the
 * VM may be restarted: "~web1~eth0@hv2"). Neither "/" nor "~" is ever part
 * of an id in the file. The physical view tags its wires with the same ids.
 */
export function virtBridgeId(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function virtLinkId(guest: string, iface: string, at?: string): string {
  return `~${guest}~${iface}${at !== undefined ? '@' + at : ''}`;
}

/** The id of a container network drawn as a network ("ctr1/bridge"; a "/" is never part of an id in the file). */
export function cnetNetworkId(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/**
 * The container networks the logical view draws as networks: a bridge or
 * an overlay network with a subnet. (A macvlan or ipvlan network's
 * containers have addresses on their host's LAN: they are members of the
 * networks there.) Each is scoped to the devices behind its host, so the
 * same subnet on two hosts makes two networks.
 */
export function virtualNetworks(model: Model): Network[] {
  const out: Network[] = [];
  for (const owner of model.devices) {
    if (!owner.containerEngine) continue;
    for (const net of owner.containerEngine.networks) {
      if (!net.name || !net.subnet || (net.driver !== 'bridge' && net.driver !== 'overlay')) continue;
      const scope = [owner.id];
      if (net.driver === 'overlay') for (const h of net.hosts) if (scope.indexOf(h) < 0) scope.push(h);
      for (const i of networkAttachments(model, owner, net)) if (scope.indexOf(i.device) < 0) scope.push(i.device);
      const nw: Network = {
        id: cnetNetworkId(owner.id, net.name),
        label: `${net.driver === 'bridge' && net.iface ? net.iface : net.name} on ${owner.label}`,
        cidr: net.subnet,
        attrs: [],
        line: net.line,
        scope,
        cnet: cnetRef(owner.id, net.name),
      };
      if (net.driver === 'bridge' && net.nat) nw.nat = owner.id;
      out.push(nw);
    }
  }
  return out;
}

/**
 * The model with VMs on other hosts than their own (the protocol
 * simulation's HA restarts, drawn during the simulation only): a copy whose
 * guests name their new host. The model itself is never changed.
 */
export function withPlacement(model: Model, moved: Map<string, string>): Model {
  if (!moved.size) return model;
  const devices = model.devices.map((d) => {
    const to = moved.get(d.id);
    return to !== undefined && to !== d.host && model.index.devices.has(to) ? { ...d, host: to } : d;
  });
  return { ...model, devices, index: { ...model.index, devices: new Map(devices.map((d) => [d.id, d] as [string, Device])) } };
}

const withCache = new WeakMap<Model, Model>();

/**
 * The model the logical view draws: the model with its container networks
 * as networks (virtualNetworks), or the model itself when it has none.
 * Computed once per model object.
 */
export function withVirtualNetworks(model: Model): Model {
  const known = withCache.get(model);
  if (known) return known;
  const extra = virtualNetworks(model).filter((n) => !model.index.networks.has(n.id));
  let out = model;
  if (extra.length) {
    const networks = model.networks.concat(extra);
    out = { ...model, networks, index: { ...model.index, networks: new Map(networks.map((n) => [n.id, n] as [string, Network])) } };
    // (the virtualization caches of the two are the same: only networks differ)
  }
  withCache.set(model, out);
  return out;
}

/** The text under a network's name: VLAN and prefix, and for a container network what it is ("NAT": behind its host, named in its label). */
export function networkSubText(model: Model, n: Network, base: string): string {
  if (!n.cnet) return base;
  const what = n.nat !== undefined ? 'NAT' : isOverlay(model, n) ? 'overlay' : 'container bridge';
  return base ? `${base} · ${what}` : what;
}

function isOverlay(model: Model, n: Network): boolean {
  const t = n.cnet ? virtRefTarget(model, n.cnet) : undefined;
  return !!t && t.kind === 'cnet' && t.net.driver === 'overlay';
}

export function runsOnText(model: Model, d: Device): string {
  const h = hostOf(model, d);
  return h ? `runs on ${h.label}` : '';
}

/** A size as written ("16G") in bytes; undefined when it isn't one. */
export function sizeBytes(t: string | undefined): number | undefined {
  if (t === undefined) return undefined;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT])(?:i?B)?\s*$/i.exec(t);
  if (!m) return undefined;
  const mul = { K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase() as 'K' | 'M' | 'G' | 'T'];
  return Number(m[1]) * Math.pow(1024, mul);
}

// ------------------------------------------------------------ refs of the virtual networking

/** The diagram / selection refs of a host's virtual switch, port group and container network. */
export function vswitchRef(host: string, name: string): string {
  return `vswitch:${host}:${name}`;
}
export function portGroupRef(host: string, name: string): string {
  return `portgroup:${host}:${name}`;
}
export function cnetRef(owner: string, name: string): string {
  return `cnet:${owner}:${name}`;
}

/** What a vswitch / portgroup / cnet ref names, if it exists in the model. */
export function virtRefTarget(
  model: Model,
  ref: string,
): { kind: 'vswitch'; host: Device; vswitch: VSwitch } | { kind: 'portgroup'; host: Device; vswitch: VSwitch; pg: PortGroup } | { kind: 'cnet'; host: Device; net: ContainerNetwork } | undefined {
  const c = ref.indexOf(':');
  if (c < 0) return undefined;
  const kind = ref.slice(0, c);
  const rest = ref.slice(c + 1);
  const c2 = rest.indexOf(':');
  if (c2 < 0) return undefined;
  const host = model.index.devices.get(rest.slice(0, c2));
  const name = rest.slice(c2 + 1);
  if (!host) return undefined;
  if (kind === 'vswitch' && host.hypervisor) {
    const vs = host.hypervisor.vswitches.find((v) => v.name === name);
    return vs ? { kind: 'vswitch', host, vswitch: vs } : undefined;
  }
  if (kind === 'portgroup') {
    const x = portGroupOf(host, name);
    return x ? { kind: 'portgroup', host, vswitch: x.vswitch, pg: x.pg } : undefined;
  }
  if (kind === 'cnet' && host.containerEngine) {
    const net = host.containerEngine.networks.find((n) => n.name === name);
    return net ? { kind: 'cnet', host, net } : undefined;
  }
  return undefined;
}

/**
 * What the virtual networking relates to an object, both ways: a guest to
 * its host, its port groups and virtual switches (a VM) or its container
 * networks (a container); a host to its guests and its own; a virtual
 * switch, port group or container network to its host, its uplinks or
 * parent and the interfaces on it (and their devices). Refs only; the
 * caller adds the cables of the ports.
 */
export function virtualRelated(model: Model, ref: string): string[] {
  const out = virtualRelatedRefs(model, ref);
  // a container network drawn as a network (logical view) goes with it
  for (const r of [ref].concat(out)) {
    const t = r.indexOf('cnet:') === 0 ? r.slice(5).split(':') : null;
    if (!t || t.length < 2) continue;
    const id = cnetNetworkId(t[0], t.slice(1).join(':'));
    if (model.index.networks.has(id) && out.indexOf('network:' + id) < 0) out.push('network:' + id);
  }
  return out;
}

function virtualRelatedRefs(model: Model, ref: string): string[] {
  const out: string[] = [];
  const add = (r: string): void => {
    if (out.indexOf(r) < 0) out.push(r);
  };
  const ifr = (i: Interface): string => `iface:${i.device}:${i.id}`;
  const onVnic = (i: Interface): void => {
    const x = vnicPortGroup(model, i);
    if (x) {
      add(portGroupRef(x.host.id, x.pg.name));
      add(vswitchRef(x.host.id, x.vswitch.name));
      add('device:' + x.host.id);
    } else if (i.passthrough !== undefined) {
      const h = vnicHost(model, i);
      if (h) {
        add('device:' + h.id);
        add(`iface:${h.id}:${i.passthrough}`);
      }
    }
  };
  const onVeth = (i: Interface): void => {
    const x = vethNetwork(model, i);
    if (!x) return;
    add(cnetRef(x.owner.id, x.net.name));
    add('device:' + x.host.id);
    if (x.owner !== x.host) add('device:' + x.owner.id);
    const b = bridgeIfaceOf(model, x.owner, x.net);
    if (b) add(ifr(b));
  };
  const onHost = (h: Device): void => {
    for (const g of guestsOf(model, h.id)) add('device:' + g.id);
    if (h.hypervisor) for (const vs of h.hypervisor.vswitches) {
      add(vswitchRef(h.id, vs.name));
      for (const pg of vs.portGroups) if (pg.name) add(portGroupRef(h.id, pg.name));
    }
    if (h.containerEngine) for (const n of h.containerEngine.networks) if (n.name) add(cnetRef(h.id, n.name));
  };
  const [kind] = ref.split(':', 1);
  if (kind === 'device') {
    const d = model.index.devices.get(ref.slice(7));
    if (!d) return out;
    const h = hostOf(model, d);
    if (h) add('device:' + h.id);
    for (const i of d.logical) {
      if (i.type === 'vnic') onVnic(i);
      if (i.type === 'veth') onVeth(i);
    }
    onHost(d);
  } else if (kind === 'iface') {
    const i = model.index.interfaces.get(ref.slice(6));
    if (!i) return out;
    if (i.type === 'vnic') onVnic(i);
    if (i.type === 'veth') onVeth(i);
    const d = model.index.devices.get(i.device);
    // a host port: the virtual switch it is an uplink of, or the vnic bound to it
    if (d && i.type === 'physical') {
      const vs = uplinkOf(model, d, i.id);
      if (vs) add(vswitchRef(d.id, vs.name));
      for (const v of passthroughOf(model, d, i.id)) {
        add(ifr(v));
        add('device:' + v.device);
      }
    }
    // a bridge network's interface: its network and the containers on it
    if (d && i.type === 'bridge' && i.derived && d.containerEngine) {
      const net = d.containerEngine.networks.find((n) => n.name === i.derived);
      if (net) {
        add(cnetRef(d.id, net.name));
        for (const v of networkAttachments(model, d, net)) {
          add(ifr(v));
          add('device:' + v.device);
        }
      }
    }
  } else {
    const t = virtRefTarget(model, ref);
    if (!t) return out;
    add('device:' + t.host.id);
    if (t.kind === 'vswitch' || t.kind === 'portgroup') {
      if (t.kind === 'portgroup') add(vswitchRef(t.host.id, t.vswitch.name));
      for (const u of t.vswitch.uplinks) add(`iface:${t.host.id}:${u}`);
      for (const p of uplinkPorts(model, t.host, t.vswitch)) add(`iface:${t.host.id}:${p}`);
      for (const pg of t.kind === 'portgroup' ? [t.pg] : t.vswitch.portGroups) {
        if (t.kind === 'vswitch' && pg.name) add(portGroupRef(t.host.id, pg.name));
        for (const v of portGroupAttachments(model, t.host, pg.name)) {
          add(ifr(v));
          add('device:' + v.device);
        }
      }
    } else {
      const b = bridgeIfaceOf(model, t.host, t.net);
      if (b) add(ifr(b));
      if (t.net.parent) add(`iface:${t.host.id}:${t.net.parent}`);
      for (const v of networkAttachments(model, t.host, t.net)) {
        add(ifr(v));
        add('device:' + v.device);
      }
    }
  }
  return out;
}

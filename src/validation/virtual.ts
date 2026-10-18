/**
 * Virtualization in the format: guests (VMs and containers) and the server
 * services that run them.
 *
 *   - A guest (type `vm` or `container`) has exactly one `host`: a server
 *     with the Hypervisor service for a VM, a server or a VM with the
 *     Container engine service for a container. It has no ports and no
 *     cables of its own, and its location is its host's (`group:` on a
 *     guest is an error). It reaches the network through its host only:
 *     a VM by its virtual NICs (`vnic`), each on a port group of a virtual
 *     switch of its host or bound to a host port by passthrough; a
 *     container by its attachments (`veth`) to the container networks of
 *     its host.
 *   - The Hypervisor service (servers only): its platform, an optional HA
 *     cluster, inventory, and its virtual switches (uplinks, teaming, MTU,
 *     port groups with a VLAN mode as on a port, or guest tagging). The
 *     hypervisor's own host interfaces are `vnic`s on its port groups.
 *   - The Container engine service (servers and VMs): its engine and its
 *     container networks (bridge, host, macvlan, ipvlan, overlay, none). A
 *     bridge network creates its bridge interface on the host (docker0),
 *     with the gateway address: a derived interface, never written.
 *
 * Mandatory values are reported until they are written (nothing is chosen
 * for the user). The checks that need the whole model (hosts, port groups,
 * passthrough ports, uplinks, networks, addresses) run once every device is
 * read (checkVirtual).
 */
import { formatAddr, inPrefix, networkOf, prefixText, reservedOf, addrBig, prefixRange } from '../analysis/ipmath';
import { paramDef, SvcLevel } from '../analysis/sim/params';
import { deviceTypeLabel } from '../model/device-types';
import { IpPrefix, hasHostBits, parseAddress, parsePrefix } from '../model/ip';
import {
  CONTAINER_DRIVERS,
  CONTAINER_ENGINES,
  ContainerDriver,
  ContainerEngine,
  ContainerNetwork,
  Device,
  HOST_IFACE_ROLES,
  HV_PLATFORMS,
  HostIfaceRole,
  HypervisorService,
  IPVLAN_MODES,
  Interface,
  MACVLAN_MODES,
  PortGroup,
  PublishedPort,
  TEAMINGS,
  VSWITCH_TYPES,
  VSwitch,
  ifaceKey,
} from '../model/types';
import { sizeBytes, isGuest, isVm, isContainer, mayHostVms, mayHostContainers } from '../model/virtual';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, IFACE_RE, Reader, get, isNull, suggest } from './reader';
import { readSimBlock } from './simulation';
import { readVlanRanges, vlanTextOf } from './vlans';

/** "a server", "a virtual machine", "a device without a type" (in a sentence). */
function typeWords(type: string): string {
  const l = deviceTypeLabel(type);
  return l ? `a ${l.charAt(0).toLowerCase() + l.slice(1)}` : 'a device without a type';
}

/** Is a device a guest (a VM or a container)? */
export function isGuestType(type: string): boolean {
  return isGuest({ type });
}

/** Where the parts of a device's virtualization were written (for the checks with the whole model). */
export interface VirtNodes {
  device: string;
  hostNode?: YNode;
  groupNode?: YNode;
  hv?: {
    node: YMap;
    path: string;
    vswitches: Array<{ vs: VSwitch; node: YMap; path: string; uplinks: YNode[]; pgs: Array<{ pg: PortGroup; node: YMap; path: string }> }>;
  };
  ce?: { node: YMap; path: string; nets: Array<{ net: ContainerNetwork; node: YMap; path: string }> };
}

const PLATFORM_IDS = HV_PLATFORMS.map((x) => x.id);
const VSWITCH_IDS = VSWITCH_TYPES.map((x) => x.id);
const TEAMING_IDS = TEAMINGS.map((x) => x.id);
const ENGINE_IDS = CONTAINER_ENGINES.map((x) => x.id);
const DRIVER_IDS = CONTAINER_DRIVERS.map((x) => x.id as string);

function oneOf(r: Reader, c: Ctx, m: YMap, key: string, path: string, ids: readonly string[], what: string): string | undefined {
  const t = r.field(m, key, path, 60);
  if (t === undefined) return undefined;
  if (ids.indexOf(t) < 0) {
    c.error(get(m, key) as YNode, `${path}.${key}`, `"${t}" is not a ${what}: use ${ids.map((x) => `"${x}"`).join(', ')}${suggest(t, ids)}`);
    return undefined;
  }
  return t;
}

function readSize(r: Reader, c: Ctx, m: YMap, key: string, path: string): string | undefined {
  const t = r.field(m, key, path, 30);
  if (t === undefined) return undefined;
  if (sizeBytes(t) === undefined) {
    c.error(get(m, key) as YNode, `${path}.${key}`, `"${t}" is not a size: write a number with a unit, e.g. 16G or 512M`);
    return undefined;
  }
  return t.trim();
}

/** A service object's `simulation:` block: only the attributes of that object (svc), checked against the registry. */
export function readSvcSim(r: Reader, c: Ctx, n: YNode | undefined, path: string, svc: SvcLevel, what: string): Map<string, number | string> | undefined {
  const sb = readSimBlock(r, c, n, path, 'service');
  if (!sb) return undefined;
  for (const k of Array.from(sb.values.keys())) {
    const def = paramDef(k);
    if (def && def.svc !== svc) {
      c.error(sb.map, `${path}.${def.yaml}`, `"${def.yaml}" (${def.label.toLowerCase()}) is not an attribute of ${what}`, { key: def.yaml });
      sb.values.delete(k);
    }
  }
  return sb.values.size ? sb.values : undefined;
}

/**
 * A device's own guest fields: a guest's `host` (required), a VM's
 * `guest_os`, `vcpu` and `ram`, a container's `image`. On any other type
 * they are errors.
 */
export function readGuestFields(r: Reader, c: Ctx, m: YMap, dpath: string, dev: Device, nodes: VirtNodes, cloudGroup: (id: string) => boolean = () => false): void {
  const guest = isGuestType(dev.type);
  const hn = get(m, 'host');
  const gn0 = get(m, 'group');
  const group0 = !isNull(gn0) ? r.str(gn0, dpath + '.group', 200) : undefined;
  if (guest && isNull(hn) && group0 !== undefined && cloudGroup(group0)) {
    // a cloud instance: in a cloud region, VPC or VNet, on the provider's hosts (not modelled)
    dev.cloudInstance = true;
  } else if (guest) {
    const want = isVm(dev) ? 'a server with the Hypervisor service' : 'a server or a VM with the Container engine service';
    if (isNull(hn)) c.error(m, dpath + '.host', `${isVm(dev) ? 'VM' : 'container'} "${dev.id}" needs its host: ${want} (or, as a cloud instance, a cloud group: a cloud_region, vpc or vnet)`, { key: 'host' });
    else {
      dev.host = r.str(hn, dpath + '.host', 200);
      nodes.hostNode = hn;
    }
  } else if (!isNull(hn)) {
    c.error(hn as YNode, dpath + '.host', `only a VM or a container has a host; "${dev.id}" is ${typeWords(dev.type)} — delete "host"`);
  }
  const only = (key: string, type: string, what: string): YNode | undefined => {
    const n = get(m, key);
    if (isNull(n)) return undefined;
    if (dev.type === type) return n;
    c.error(n as YNode, `${dpath}.${key}`, `"${key}" is ${what}'s; "${dev.id}" is ${typeWords(dev.type)} — delete it`);
    return undefined;
  };
  if (only('guest_os', 'vm', 'a VM')) dev.guestOs = r.field(m, 'guest_os', dpath, 120);
  if (only('vcpu', 'vm', 'a VM')) dev.vcpu = r.int(get(m, 'vcpu'), dpath + '.vcpu', 1, 4096, 'number of virtual CPUs');
  if (only('ram', 'vm', 'a VM')) dev.ram = readSize(r, c, m, 'ram', dpath);
  if (only('image', 'container', 'a container')) dev.image = r.field(m, 'image', dpath, 300);
  // a guest's location is its host's (a cloud instance's is its cloud group)
  const gn = get(m, 'group');
  if (guest && !dev.cloudInstance && !isNull(gn)) {
    nodes.groupNode = gn;
    c.error(gn as YNode, dpath + '.group', `${isVm(dev) ? 'VM' : 'container'} "${dev.id}" is where its host is: its location is the host's — delete "group" (set the host's location instead)`);
    dev.group = undefined;
  }
}

/** The Hypervisor and Container engine services of a device's `services:` (DHCP and DNS are read in netservices.ts). */
export function readVirtServices(r: Reader, c: Ctx, n: YNode | undefined, path: string, dev: Device, nodes: VirtNodes): void {
  if (isNull(n) || (n as YNode).kind !== 'map') return;
  const m = n as YMap;
  const hn = get(m, 'hypervisor');
  if (hn !== undefined) {
    const hpath = path + '.hypervisor';
    if (!mayHostVms(dev)) {
      c.error(hn, hpath, `the Hypervisor service runs on a server; "${dev.id}" is ${typeWords(dev.type)}${isVm(dev) ? ' (nested virtualization is not modelled)' : ''}`);
    } else readHypervisor(r, c, hn, hpath, dev, nodes);
  }
  const en = get(m, 'container_engine');
  if (en !== undefined) {
    const epath = path + '.container_engine';
    if (!mayHostContainers(dev)) {
      c.error(en, epath, `the Container engine service runs on a server or a VM; "${dev.id}" is ${typeWords(dev.type)}`);
    } else readEngine(r, c, en, epath, dev, nodes);
  }
}

function readHypervisor(r: Reader, c: Ctx, n: YNode, path: string, dev: Device, nodes: VirtNodes): void {
  const hm = isNull(n) ? null : r.map(n, path);
  const hv: HypervisorService = { vswitches: [], line: n.line };
  dev.hypervisor = hv;
  if (!hm) {
    c.error(n, path, `the Hypervisor service of "${dev.id}" needs its platform and a virtual switch`);
    return;
  }
  nodes.hv = { node: hm, path, vswitches: [] };
  r.keys(hm, SCHEMA.hypervisor, path);
  if (isNull(get(hm, 'platform'))) c.error(hm, path + '.platform', `the Hypervisor service of "${dev.id}" needs its platform (${PLATFORM_IDS.join(', ')})`, { key: 'platform' });
  else hv.platform = oneOf(r, c, hm, 'platform', path, PLATFORM_IDS, 'hypervisor platform');
  const cl = r.field(hm, 'cluster', path, 64);
  if (cl !== undefined) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,63}$/.test(cl)) c.error(get(hm, 'cluster') as YNode, path + '.cluster', `"${cl}" is not a cluster name: use A–Z a–z 0–9 _ . -`);
    else hv.cluster = cl;
  }
  hv.cpu = r.int(get(hm, 'cpu'), path + '.cpu', 1, 100000, 'number of CPU cores');
  hv.ram = readSize(r, c, hm, 'ram', path);
  const vn = get(hm, 'vswitches');
  const items = isNull(vn) ? [] : r.list(vn, path + '.vswitches');
  if (!items.length) c.error(hm, path + '.vswitches', `the Hypervisor service of "${dev.id}" needs a virtual switch: add one (its name, type and port groups)`, { key: 'vswitches' });
  const pgNames = new Map<string, string>();
  items.forEach((it, k) => {
    const vpath = `${path}.vswitches[${k}]`;
    const vm = r.map(it, vpath);
    if (!vm) return;
    r.keys(vm, SCHEMA.vswitch, vpath);
    const vs: VSwitch = { name: '', uplinks: [], portGroups: [], line: vm.line };
    const need = (key: string, what: string): boolean => {
      if (!isNull(get(vm, key))) return true;
      c.error(vm, `${vpath}.${key}`, `virtual switch ${k + 1} of "${dev.id}" needs its ${what}`, { key });
      return false;
    };
    if (need('name', 'name')) {
      const nm = r.field(vm, 'name', vpath, 64) || '';
      if (hv.vswitches.some((x) => x.name === nm)) c.error(get(vm, 'name') as YNode, vpath + '.name', `"${dev.id}" has two virtual switches named "${nm}"`);
      else vs.name = nm;
    }
    if (need('type', `type (${VSWITCH_IDS.join(', ')})`)) vs.type = oneOf(r, c, vm, 'type', vpath, VSWITCH_IDS, 'virtual switch type');
    const uplinkNodes = r.list(get(vm, 'uplinks'), vpath + '.uplinks', true);
    uplinkNodes.forEach((u, j) => {
      const t = r.str(u, `${vpath}.uplinks[${j}]`, 200);
      if (t === undefined) return;
      if (vs.uplinks.indexOf(t) >= 0) c.error(u, `${vpath}.uplinks[${j}]`, `uplink "${t}" is listed twice`);
      else vs.uplinks.push(t);
    });
    if (vs.uplinks.length) {
      if (need('teaming', `teaming (${TEAMING_IDS.join(', ')}): how it uses its uplinks`)) vs.teaming = oneOf(r, c, vm, 'teaming', vpath, TEAMING_IDS, 'teaming');
    } else if (!isNull(get(vm, 'teaming'))) {
      c.error(get(vm, 'teaming') as YNode, vpath + '.teaming', `teaming is how a virtual switch uses its uplinks: "${vs.name || k + 1}" has none (an internal switch) — add uplinks or delete "teaming"`);
    }
    vs.mtu = r.int(get(vm, 'mtu'), vpath + '.mtu', 68, 65535, 'MTU');
    vs.simulation = readSvcSim(r, c, get(vm, 'simulation'), vpath + '.simulation', 'vswitch', 'a virtual switch');
    const pgN = get(vm, 'port_groups');
    const pgItems = isNull(pgN) ? [] : r.list(pgN, vpath + '.port_groups');
    if (!pgItems.length) c.error(vm, vpath + '.port_groups', `virtual switch "${vs.name || k + 1}" of "${dev.id}" needs a port group (its name and VLAN)`, { key: 'port_groups' });
    const pgs: Array<{ pg: PortGroup; node: YMap; path: string }> = [];
    pgItems.forEach((pi, j) => {
      const ppath = `${vpath}.port_groups[${j}]`;
      const pm = r.map(pi, ppath);
      if (!pm) return;
      r.keys(pm, SCHEMA.portGroup, ppath);
      const pg: PortGroup = { name: '', vlans: [], guestTagging: false, line: pm.line };
      if (isNull(get(pm, 'name'))) c.error(pm, ppath + '.name', `port group ${j + 1} of "${vs.name || k + 1}" needs its name`, { key: 'name' });
      else {
        const nm = r.field(pm, 'name', ppath, 64) || '';
        const other = pgNames.get(nm);
        if (other !== undefined) c.error(get(pm, 'name') as YNode, ppath + '.name', `"${dev.id}" has two port groups named "${nm}" (also on ${other}): a VM names its port group, so the names are unique on a host`);
        else {
          pg.name = nm;
          pgNames.set(nm, vs.name || `virtual switch ${k + 1}`);
        }
      }
      const vlN = get(pm, 'vlans');
      const gt = r.bool(get(pm, 'guest_tagging'), ppath + '.guest_tagging') === true;
      if (gt && !isNull(vlN)) c.error(get(pm, 'guest_tagging') as YNode, ppath + '.guest_tagging', `port group "${pg.name}" has VLANs and guest tagging: with guest tagging the guest tags (every VLAN of the uplinks passes) — delete one of them`);
      else if (gt) pg.guestTagging = true;
      else if (isNull(vlN)) c.error(pm, ppath + '.vlans', `port group "${pg.name || j + 1}" needs its VLAN mode: "vlans" (one VLAN: access; several: a trunk) or "guest_tagging: true"`, { key: 'vlans' });
      else pg.vlans = readVlanRanges(r, c, vlN, ppath + '.vlans', `port group "${pg.name}"`);
      const nn = get(pm, 'native');
      const native = r.vlanId(nn, ppath + '.native');
      if (native !== undefined) {
        const ids: number[] = [];
        for (const x of pg.vlans) for (let v = x.from; v <= x.to; v++) ids.push(v);
        if (ids.length < 2) c.error(nn as YNode, ppath + '.native', `"native" is a trunk port group's untagged VLAN: "${pg.name}" ${ids.length === 1 ? `has one VLAN (${ids[0]}), untagged anyway` : 'has no VLANs'} — delete it`);
        else if (ids.indexOf(native) < 0) c.error(nn as YNode, ppath + '.native', `the native VLAN ${native} is not one of the VLANs of port group "${pg.name}" (${vlanTextOf(pg.vlans)})`);
        else pg.native = native;
      }
      vs.portGroups.push(pg);
      pgs.push({ pg, node: pm, path: ppath });
    });
    hv.vswitches.push(vs);
    (nodes.hv as NonNullable<VirtNodes['hv']>).vswitches.push({ vs, node: vm, path: vpath, uplinks: uplinkNodes, pgs });
  });
  hv.simulation = readSvcSim(r, c, get(hm, 'simulation'), path + '.simulation', 'hypervisor', 'the Hypervisor service');
}

/** A subnet as written: an address with prefix length, the network itself (no host bits). */
function readSubnet(r: Reader, c: Ctx, m: YMap, path: string): IpPrefix | undefined {
  const t = r.field(m, 'subnet', path, 64);
  if (t === undefined) return undefined;
  const p = parsePrefix(t.trim());
  if (!p) {
    c.error(get(m, 'subnet') as YNode, path + '.subnet', `"${t}" is not a subnet: write a network with its prefix length, e.g. 172.17.0.0/16`);
    return undefined;
  }
  if (hasHostBits(p)) {
    c.error(get(m, 'subnet') as YNode, path + '.subnet', `"${t}" has host bits set: the subnet is ${prefixText(networkOf(p))}`);
    return undefined;
  }
  return p;
}

function readEngine(r: Reader, c: Ctx, n: YNode, path: string, dev: Device, nodes: VirtNodes): void {
  const em = isNull(n) ? null : r.map(n, path);
  const ce: ContainerEngine = { networks: [], line: n.line };
  dev.containerEngine = ce;
  if (!em) {
    c.error(n, path, `the Container engine service of "${dev.id}" needs its engine and a container network`);
    return;
  }
  nodes.ce = { node: em, path, nets: [] };
  r.keys(em, SCHEMA.containerEngine, path);
  if (isNull(get(em, 'engine'))) c.error(em, path + '.engine', `the Container engine service of "${dev.id}" needs its engine (${ENGINE_IDS.join(', ')})`, { key: 'engine' });
  else ce.engine = oneOf(r, c, em, 'engine', path, ENGINE_IDS, 'container engine');
  const nn = get(em, 'networks');
  const items = isNull(nn) ? [] : r.list(nn, path + '.networks');
  if (!items.length) c.error(em, path + '.networks', `the Container engine of "${dev.id}" needs a container network: add one (its name and driver)`, { key: 'networks' });
  items.forEach((it, k) => {
    const npath = `${path}.networks[${k}]`;
    const nm = r.map(it, npath);
    if (!nm) return;
    r.keys(nm, SCHEMA.containerNetwork, npath);
    const net: ContainerNetwork = { name: '', hosts: [], line: nm.line };
    const need = (key: string, what: string): boolean => {
      if (!isNull(get(nm, key))) return true;
      c.error(nm, `${npath}.${key}`, `container network ${net.name ? `"${net.name}"` : k + 1} of "${dev.id}" needs its ${what}`, { key });
      return false;
    };
    if (need('name', 'name')) {
      const t = r.field(nm, 'name', npath, 64) || '';
      if (ce.networks.some((x) => x.name === t)) c.error(get(nm, 'name') as YNode, npath + '.name', `"${dev.id}" has two container networks named "${t}"`);
      else net.name = t;
    }
    if (need('driver', `driver (${DRIVER_IDS.join(', ')})`)) net.driver = oneOf(r, c, nm, 'driver', npath, DRIVER_IDS, 'network driver') as ContainerDriver | undefined;
    const d = net.driver;
    // what each driver has; anything else on it is an error
    const keysOf: { [k in ContainerDriver]: string[] } = {
      bridge: ['interface', 'subnet', 'gateway', 'nat', 'range'],
      macvlan: ['parent', 'subnet', 'gateway', 'mode', 'range'],
      ipvlan: ['parent', 'subnet', 'gateway', 'mode', 'range'],
      overlay: ['subnet', 'gateway', 'hosts', 'range'],
      host: [],
      none: [],
    };
    if (d) {
      for (const key of ['interface', 'subnet', 'gateway', 'nat', 'parent', 'mode', 'hosts', 'range']) {
        if (isNull(get(nm, key)) || keysOf[d].indexOf(key) >= 0) continue;
        c.error(get(nm, key) as YNode, `${npath}.${key}`, `a ${d} network has no "${key}"${d === 'host' ? ' (its containers use the host’s interfaces and addresses)' : d === 'none' ? ' (its containers have no network)' : ''} — delete it`);
      }
    }
    if (d === 'bridge' && need('interface', 'bridge interface (the interface it creates on the host, e.g. docker0)')) {
      const t = r.field(nm, 'interface', npath, 64) || '';
      if (!IFACE_RE.test(t)) c.error(get(nm, 'interface') as YNode, npath + '.interface', `"${t}" is not an interface name`);
      else net.iface = t;
    }
    let subnet: IpPrefix | undefined;
    if (d === 'bridge' || d === 'macvlan' || d === 'ipvlan' || d === 'overlay') {
      if (need('subnet', 'subnet (e.g. 172.17.0.0/16)')) subnet = readSubnet(r, c, nm, npath);
      if (subnet) net.subnet = prefixText(subnet);
    }
    if (d === 'bridge' || d === 'macvlan' || d === 'ipvlan' || (d === 'overlay' && !isNull(get(nm, 'gateway')))) {
      if (need('gateway', d === 'bridge' ? 'gateway (the bridge interface’s address on the host, e.g. 172.17.0.1)' : 'gateway (the router’s address in the subnet)')) {
        const t = r.field(nm, 'gateway', npath, 64) || '';
        const a = parseAddress(t.trim());
        if (!a) c.error(get(nm, 'gateway') as YNode, npath + '.gateway', `"${t}" is not an IP address`);
        else if (subnet && !inPrefix(subnet, a)) c.error(get(nm, 'gateway') as YNode, npath + '.gateway', `the gateway ${formatAddr(a)} is not in the subnet ${net.subnet}`);
        else if (subnet && reservedOf(subnet).some((x) => x === addrBig(a))) c.error(get(nm, 'gateway') as YNode, npath + '.gateway', `${formatAddr(a)} is the ${addrBig(a) === prefixRange(subnet).first ? 'network' : 'broadcast'} address of ${net.subnet}, not a host`);
        else net.gateway = formatAddr(a);
      }
    }
    if (d === 'bridge' && need('nat', 'NAT setting (nat: true to masquerade to the host’s address, false to route)')) {
      const v = r.bool(get(nm, 'nat'), npath + '.nat');
      if (v !== undefined) net.nat = v;
    }
    if ((d === 'macvlan' || d === 'ipvlan') && need('parent', 'parent interface (the host interface it sits on)')) net.parent = r.field(nm, 'parent', npath, 200);
    if ((d === 'macvlan' || d === 'ipvlan') && need('mode', `mode (${(d === 'macvlan' ? MACVLAN_MODES : IPVLAN_MODES).join(', ')})`)) {
      net.mode = oneOf(r, c, nm, 'mode', npath, d === 'macvlan' ? MACVLAN_MODES : IPVLAN_MODES, `${d} mode`);
    }
    if (d === 'overlay') {
      r.list(get(nm, 'hosts'), npath + '.hosts', true).forEach((x, j) => {
        const t = r.str(x, `${npath}.hosts[${j}]`, 200);
        if (t === undefined) return;
        if (t === dev.id) c.error(x, `${npath}.hosts[${j}]`, `"${t}" is this network's own host: "hosts" lists the other hosts that take part`);
        else if (net.hosts.indexOf(t) >= 0) c.error(x, `${npath}.hosts[${j}]`, `"${t}" is listed twice`);
        else net.hosts.push(t);
      });
    }
    const rn = get(nm, 'range');
    if (!isNull(rn) && d && keysOf[d].indexOf('range') >= 0) {
      const t = r.str(rn, npath + '.range', 100) || '';
      const mm = /^\s*([0-9a-fA-F.:]+)\s*-\s*([0-9a-fA-F.:]+)\s*$/.exec(t);
      const a = mm ? parseAddress(mm[1]) : null;
      const b = mm ? parseAddress(mm[2]) : null;
      if (!a || !b || a.version !== b.version) c.error(rn as YNode, npath + '.range', `"${t}" is not an address range (start-end, e.g. 172.17.0.100-172.17.0.199)`);
      else if (addrBig(a) > addrBig(b)) c.error(rn as YNode, npath + '.range', `the range starts after it ends (${formatAddr(a)} > ${formatAddr(b)})`);
      else if (subnet && (!inPrefix(subnet, a) || !inPrefix(subnet, b))) c.error(rn as YNode, npath + '.range', `the range ${formatAddr(a)}-${formatAddr(b)} is not inside the subnet ${net.subnet}`);
      else {
        net.start = formatAddr(a);
        net.end = formatAddr(b);
        net.range = `${net.start}-${net.end}`;
      }
    }
    ce.networks.push(net);
    (nodes.ce as NonNullable<VirtNodes['ce']>).nets.push({ net, node: nm, path: npath });
  });
  ce.simulation = readSvcSim(r, c, get(em, 'simulation'), path + '.simulation', 'container_engine', 'the Container engine');
}

/**
 * The keys of a VM's (or a hypervisor's) `vnic` and of a container's
 * `veth`, as written; what they name is checked with the whole model.
 * On another interface type these keys are errors (validate.ts `only`).
 */
export function readVirtIface(r: Reader, c: Ctx, im: YMap, ipath: string, iface: Interface, dev: Device): void {
  if (iface.type === 'vnic') {
    if (!mayHostContainers(dev)) {
      c.error(get(im, 'type') as YNode, ipath + '.type', `a vnic is a VM's virtual NIC (or a hypervisor's host interface); "${dev.id}" is ${typeWords(dev.type)}`);
    }
    iface.portGroup = r.field(im, 'port_group', ipath, 64);
    iface.passthrough = r.field(im, 'passthrough', ipath, 200);
    const vfN = get(im, 'vf');
    if (!isNull(vfN)) {
      if (iface.passthrough === undefined) c.error(vfN as YNode, ipath + '.vf', `"vf" is the SR-IOV virtual function of a passthrough port: "${iface.id}" has no passthrough — delete it`);
      else iface.vf = r.int(vfN, ipath + '.vf', 0, 4095, 'virtual function number');
    }
    const roleN = get(im, 'role');
    if (!isNull(roleN)) {
      const t = r.str(roleN, ipath + '.role', 30);
      if (!mayHostVms(dev)) c.error(roleN as YNode, ipath + '.role', `"role" is a hypervisor's host interface's (management, migration, storage); "${iface.id}" is a VM's vnic — delete it`);
      else if (t !== undefined && HOST_IFACE_ROLES.indexOf(t as HostIfaceRole) < 0) c.error(roleN as YNode, ipath + '.role', `"${t}" is not a host interface role: use ${HOST_IFACE_ROLES.join(', ')}`);
      else if (t !== undefined) iface.role = t as HostIfaceRole;
    }
    if (iface.portGroup !== undefined && iface.passthrough !== undefined) {
      c.error(get(im, 'passthrough') as YNode, ipath + '.passthrough', `"${iface.id}" has a port group and a passthrough port: a vnic is on a port group or bound to a host port — delete one of them`);
      iface.passthrough = undefined;
      iface.vf = undefined;
    } else if (iface.portGroup === undefined && iface.passthrough === undefined) {
      c.error(im, ipath + '.port_group', `vnic "${iface.id}" of "${dev.id}" needs its port group (a port group of its host's virtual switches)${isVm(dev) ? ' or a passthrough port' : ''}`, { key: 'port_group' });
    } else if (iface.passthrough !== undefined && !isVm(dev)) {
      c.error(get(im, 'passthrough') as YNode, ipath + '.passthrough', `passthrough binds a VM's vnic to a host port; a host interface is on a port group — delete it`);
      iface.passthrough = undefined;
    }
  }
  if (iface.type === 'veth') {
    if (!isContainer(dev)) c.error(get(im, 'type') as YNode, ipath + '.type', `a veth is a container's attachment to a container network; "${dev.id}" is ${typeWords(dev.type)}`);
    if (isNull(get(im, 'network'))) c.error(im, ipath + '.network', `veth "${iface.id}" of "${dev.id}" needs its container network (a network of its host's container engine)`, { key: 'network' });
    else iface.network = r.field(im, 'network', ipath, 64);
    const al: string[] = [];
    r.list(get(im, 'aliases'), ipath + '.aliases', true).forEach((x, j) => {
      const t = r.str(x, `${ipath}.aliases[${j}]`, 253);
      if (t === undefined) return;
      if (al.indexOf(t) >= 0) c.error(x, `${ipath}.aliases[${j}]`, `alias "${t}" is listed twice`);
      else al.push(t);
    });
    if (al.length) iface.aliases = al;
    const pubN = get(im, 'publish');
    if (!isNull(pubN)) {
      const pubs: PublishedPort[] = [];
      r.list(pubN, ipath + '.publish').forEach((x, j) => {
        const pp = `${ipath}.publish[${j}]`;
        const pm = r.map(x, pp);
        if (!pm) return;
        r.keys(pm, SCHEMA.published, pp);
        const hostPort = isNull(get(pm, 'host_port')) ? (c.error(pm, pp + '.host_port', 'a published port needs its host port', { key: 'host_port' }), undefined) : r.int(get(pm, 'host_port'), pp + '.host_port', 1, 65535, 'port');
        const port = isNull(get(pm, 'port')) ? (c.error(pm, pp + '.port', 'a published port needs the container’s port', { key: 'port' }), undefined) : r.int(get(pm, 'port'), pp + '.port', 1, 65535, 'port');
        const proto = isNull(get(pm, 'protocol')) ? (c.error(pm, pp + '.protocol', 'a published port needs its protocol (tcp or udp)', { key: 'protocol' }), undefined) : r.field(pm, 'protocol', pp, 10);
        if (proto !== undefined && proto !== 'tcp' && proto !== 'udp') c.error(get(pm, 'protocol') as YNode, pp + '.protocol', `"${proto}" is not a protocol for a published port: use tcp or udp`);
        let hostIp: string | undefined;
        const hip = r.field(pm, 'host_ip', pp, 64);
        if (hip !== undefined) {
          const a = parseAddress(hip.trim());
          if (!a) c.error(get(pm, 'host_ip') as YNode, pp + '.host_ip', `"${hip}" is not an IP address`);
          else hostIp = formatAddr(a);
        }
        if (hostPort !== undefined && port !== undefined && (proto === 'tcp' || proto === 'udp')) pubs.push({ hostIp, hostPort, port, protocol: proto, line: pm.line });
      });
      if (pubs.length) iface.publish = pubs;
    }
  }
}

/** Where the model-level checks find what they report on. */
export interface VirtCheckCtx {
  devices: Device[];
  devIndex: Map<string, Device>;
  interfaces: Map<string, Interface>;
  ifaceNodes: Map<string, YMap>;
  ifacePaths: Map<string, string>;
  devNodes: Map<string, { node: YMap; path: string }>;
  virt: Map<string, VirtNodes>;
}

/** The container networks a container on `host` may attach to: its host's, and the overlay networks of other engines that list it. */
export function containerNetworksFor(devIndex: Map<string, Device>, host: string): Array<{ net: ContainerNetwork; owner: string }> {
  const out: Array<{ net: ContainerNetwork; owner: string }> = [];
  const h = devIndex.get(host);
  if (h && h.containerEngine) for (const n of h.containerEngine.networks) if (n.name) out.push({ net: n, owner: host });
  devIndex.forEach((d) => {
    if (d.id === host || !d.containerEngine) return;
    for (const n of d.containerEngine.networks) if (n.driver === 'overlay' && n.hosts.indexOf(host) >= 0 && !out.some((x) => x.net.name === n.name)) out.push({ net: n, owner: d.id });
  });
  return out;
}

/**
 * The checks of virtualization with the whole model; returns the derived
 * bridge interfaces of the container bridge networks (to be added to their
 * hosts and the index).
 */
export function checkVirtual(c: Ctx, x: VirtCheckCtx): Interface[] {
  const { devIndex, interfaces } = x;
  const derived: Interface[] = [];
  const at = (id: string): { node: YMap; path: string } => x.devNodes.get(id) as { node: YMap; path: string };
  // ---- guests: their host, its service; their location is the host's
  for (const d of x.devices) {
    if (!isGuestType(d.type) || d.host === undefined) continue;
    const vn = x.virt.get(d.id);
    const node = (vn && vn.hostNode) || at(d.id).node;
    const path = at(d.id).path + '.host';
    const h = devIndex.get(d.host);
    const kind = isVm(d) ? 'VM' : 'container';
    if (!h) {
      c.error(node, path, `unknown host "${d.host}"${suggest(d.host, Array.from(devIndex.keys()))}`);
      d.host = undefined;
    } else if (h.id === d.id) {
      c.error(node, path, `${kind} "${d.id}" can't be its own host`);
      d.host = undefined;
    } else if (isVm(d) && !(mayHostVms(h) && h.hypervisor)) {
      c.error(node, path, `the host of VM "${d.id}" is a server with the Hypervisor service; "${h.id}" ${mayHostVms(h) ? 'has no Hypervisor service (enable it in its Services)' : `is ${typeWords(h.type)}`}`);
      d.host = undefined;
    } else if (isContainer(d) && !(mayHostContainers(h) && h.containerEngine)) {
      c.error(node, path, `the host of container "${d.id}" is a server or a VM with the Container engine service; "${h.id}" ${mayHostContainers(h) ? 'has no Container engine service (enable it in its Services)' : `is ${typeWords(h.type)}`}`);
      d.host = undefined;
    }
  }
  // the location: a VM's is its host's; a container's is its host's (a VM's: the VM's host's)
  const groupOf = (d: Device, depth = 0): string | undefined => {
    if (!isGuestType(d.type) || depth > 3) return d.group;
    const h = d.host !== undefined ? devIndex.get(d.host) : undefined;
    return h ? groupOf(h, depth + 1) : undefined;
  };
  for (const d of x.devices) if (isGuestType(d.type)) d.group = groupOf(d);

  // ---- hypervisors: uplinks, port groups
  /** "host:port[:vf]" -> what uses it ("uplink of vSwitch0", "passthrough of vm1:eth1") */
  const portUse = new Map<string, string>();
  for (const d of x.devices) {
    const vn = x.virt.get(d.id);
    if (!d.hypervisor || !vn || !vn.hv) continue;
    for (const v of vn.hv.vswitches) {
      v.vs.uplinks.forEach((u, j) => {
        const node = v.uplinks[j] || v.node;
        const p = `${v.path}.uplinks[${j}]`;
        const i = interfaces.get(ifaceKey(d.id, u));
        if (!i) {
          c.error(node, p, `"${d.id}" has no port "${u}"${suggest(u, d.interfaces.map((y) => y.id).concat(d.logical.filter((y) => y.members.length > 0).map((y) => y.id)))}`);
          return;
        }
        if (!(i.type === 'physical' || (i.type === 'virtual' && i.members.length > 0))) {
          c.error(node, p, `"${u}" is a ${i.type} interface: a virtual switch's uplinks are the host's physical ports or aggregates (bonds)`);
          return;
        }
        if (i.addresses.length || i.dhcp) c.error(node, p, `uplink "${u}" has an address: an uplink belongs to the virtual switch — put the host's address on a host interface (a vnic on a port group)`);
        const prev = portUse.get(ifaceKey(d.id, u));
        if (prev) c.error(node, p, `"${u}" is already the ${prev}: a port is the uplink of one virtual switch`);
        else portUse.set(ifaceKey(d.id, u), `uplink of ${v.vs.name}`);
      });
      if (v.vs.teaming === 'lacp') {
        const lags = v.vs.uplinks.filter((u) => {
          const i = interfaces.get(ifaceKey(d.id, u));
          return !!i && i.type === 'virtual' && i.members.length > 0;
        });
        if (v.vs.uplinks.length !== 1 || lags.length !== 1) c.error((get(v.node, 'teaming') as YNode) || v.node, v.path + '.teaming', `LACP teaming needs one aggregate (a bond of the host) as the uplink of "${v.vs.name}"${v.vs.uplinks.length ? `; it has ${v.vs.uplinks.join(', ')}` : ''}`);
      }
    }
  }
  // ---- vnics: a VM's on its host's port groups (or passthrough), a hypervisor's own on its port groups
  const pgOf = (h: Device, name: string): PortGroup | undefined => {
    for (const vs of (h.hypervisor && h.hypervisor.vswitches) || []) for (const pg of vs.portGroups) if (pg.name === name) return pg;
    return undefined;
  };
  const pgNames = (h: Device): string[] => ((h.hypervisor && h.hypervisor.vswitches) || []).reduce((a: string[], vs) => a.concat(vs.portGroups.map((p) => p.name).filter((n) => !!n)), []);
  for (const d of x.devices) {
    for (const i of d.logical) {
      if (i.type !== 'vnic') continue;
      const key = ifaceKey(d.id, i.id);
      const im = x.ifaceNodes.get(key) as YMap;
      const ipath = x.ifacePaths.get(key) as string;
      const h = isVm(d) ? (d.host !== undefined ? devIndex.get(d.host) : undefined) : d;
      if (mayHostVms(d) && !d.hypervisor) {
        c.error(get(im, 'type') as YNode, ipath + '.type', `a server's vnic is a host interface on its own virtual switch: "${d.id}" has no Hypervisor service`);
        continue;
      }
      if (!h || !h.hypervisor) continue;
      if (i.portGroup !== undefined && !pgOf(h, i.portGroup)) {
        c.error(get(im, 'port_group') as YNode, ipath + '.port_group', `${h === d ? `"${d.id}"` : `host "${h.id}"`} has no port group "${i.portGroup}"${pgNames(h).length ? suggest(i.portGroup, pgNames(h)) || ` (it has ${pgNames(h).join(', ')})` : ' (its virtual switches have no port groups)'}`);
      }
      if (i.passthrough !== undefined) {
        const p = interfaces.get(ifaceKey(h.id, i.passthrough));
        const pn = get(im, 'passthrough') as YNode;
        if (!p || p.type !== 'physical') {
          c.error(pn, ipath + '.passthrough', `host "${h.id}" has no physical port "${i.passthrough}"${suggest(i.passthrough, h.interfaces.map((y) => y.id))}`);
          continue;
        }
        const whole = ifaceKey(h.id, i.passthrough);
        const k = i.vf !== undefined ? `${whole}:${i.vf}` : whole;
        const prevWhole = portUse.get(whole);
        const prevVf = portUse.get(k);
        const who = `passthrough of ${d.id}:${i.id}`;
        if (prevWhole && /^uplink/.test(prevWhole)) c.error(pn, ipath + '.passthrough', `${i.passthrough} of "${h.id}" is the ${prevWhole}: a port used for passthrough can't be an uplink`);
        else if (prevVf && prevVf !== who) c.error(pn, ipath + '.passthrough', `${i.passthrough}${i.vf !== undefined ? ` (virtual function ${i.vf})` : ''} of "${h.id}" is already the ${prevVf}: a passthrough port is used once`);
        else if (prevWhole && i.vf === undefined) c.error(pn, ipath + '.passthrough', `${i.passthrough} of "${h.id}" is already the ${prevWhole}: a port used for passthrough is exclusive`);
        else {
          portUse.set(k, who);
          if (i.vf === undefined) portUse.set(whole, who);
          else if (!portUse.has(whole)) portUse.set(whole, `SR-IOV port (virtual functions) of ${d.id}:${i.id}`);
        }
      }
    }
    // a VM's VLAN subinterfaces ("eth0.20" on a vnic): only with guest tagging or a trunk port group
    if (isVm(d) && d.host !== undefined) {
      const h = devIndex.get(d.host);
      for (const sub of d.logical) {
        const dot = sub.id.lastIndexOf('.');
        if (sub.type !== 'virtual' || dot <= 0) continue;
        const parent = d.logical.find((p) => p.id === sub.id.slice(0, dot) && p.type === 'vnic');
        if (!parent || !h || parent.portGroup === undefined) continue;
        const pg = pgOf(h, parent.portGroup);
        const ids: number[] = [];
        if (pg) for (const r of pg.vlans) for (let v = r.from; v <= r.to; v++) ids.push(v);
        if (pg && !pg.guestTagging && ids.length < 2) {
          const key = ifaceKey(d.id, sub.id);
          c.error(x.ifaceNodes.get(key) as YMap, x.ifacePaths.get(key) as string, `"${sub.id}" is a VLAN subinterface of vnic "${parent.id}", whose port group "${pg.name}" is an access port group (VLAN ${ids[0]}): the guest's tags need guest tagging or a trunk port group`);
        }
      }
    }
  }
  // ---- container engines: parents, overlay hosts; bridge interfaces
  for (const d of x.devices) {
    const vn = x.virt.get(d.id);
    if (!d.containerEngine || !vn || !vn.ce) continue;
    for (const { net, node, path } of vn.ce.nets) {
      if ((net.driver === 'macvlan' || net.driver === 'ipvlan') && net.parent !== undefined) {
        const p = interfaces.get(ifaceKey(d.id, net.parent));
        const ok = !!p && (p.type === 'physical' || p.type === 'vnic' || (p.type === 'virtual' && (p.members.length > 0 || /\./.test(p.id))));
        if (!ok) c.error(get(node, 'parent') as YNode, path + '.parent', p ? `"${net.parent}" is a ${p.type} interface: a ${net.driver} network sits on a port, an aggregate, a VLAN subinterface${isVm(d) ? ' or a vnic' : ''} of its host` : `"${d.id}" has no interface "${net.parent}"${suggest(net.parent, d.interfaces.concat(d.logical).map((y) => y.id))}`);
      }
      net.hosts.forEach((hid, j) => {
        const h = devIndex.get(hid);
        if (!h || !h.containerEngine) c.error(node, `${path}.hosts[${j}]`, h ? `"${hid}" has no Container engine service` : `unknown host "${hid}"${suggest(hid, Array.from(devIndex.keys()))}`);
      });
      if (net.driver === 'bridge' && net.iface && net.subnet && net.gateway) {
        const k = ifaceKey(d.id, net.iface);
        if (interfaces.has(k)) {
          c.error(get(node, 'interface') as YNode, path + '.interface', `"${d.id}" already has an interface "${net.iface}": the bridge network creates its own interface — choose another name`);
          continue;
        }
        const bi: Interface = {
          id: net.iface,
          device: d.id,
          type: 'bridge',
          dhcp: false,
          addresses: [`${net.gateway}/${net.subnet.split('/')[1]}`],
          vlans: [],
          members: [],
          services: [],
          attrs: [],
          derived: net.name,
          line: node.line,
        };
        interfaces.set(k, bi);
        d.logical.push(bi);
        derived.push(bi);
      }
    }
  }
  // ---- veths: the network, the address, published ports
  /** "host|ip|port|proto" -> the veth that published it */
  const published = new Map<string, string>();
  for (const d of x.devices) {
    if (!isContainer(d)) continue;
    const nets = d.host !== undefined ? containerNetworksFor(devIndex, d.host) : [];
    for (const i of d.logical) {
      if (i.type !== 'veth') continue;
      const key = ifaceKey(d.id, i.id);
      const im = x.ifaceNodes.get(key) as YMap;
      const ipath = x.ifacePaths.get(key) as string;
      if (d.host === undefined || i.network === undefined) continue;
      const found = nets.find((n) => n.net.name === i.network);
      if (!found) {
        c.error(get(im, 'network') as YNode, ipath + '.network', `host "${d.host}" has no container network "${i.network}"${nets.length ? suggest(i.network, nets.map((n) => n.net.name)) || ` (it has ${nets.map((n) => n.net.name).join(', ')})` : ''}`);
        continue;
      }
      const net = found.net;
      if ((net.driver === 'host' || net.driver === 'none') && (i.addresses.length || i.dhcp)) {
        c.error((get(im, i.dhcp ? 'ipv4' : 'ip') as YNode) || im, `${ipath}.${i.dhcp ? 'ipv4' : 'ip'}`, net.driver === 'host' ? `"${i.network}" is a host network: the container shares its host's interfaces and addresses — delete its own address` : `"${i.network}" is a none network: the container has no network there — delete the address`);
      }
      if (i.dhcp && net.driver !== 'macvlan' && net.driver !== 'host' && net.driver !== 'none') {
        c.error(get(im, 'ipv4') as YNode, ipath + '.ipv4', `a container gets its address on a ${net.driver} network from the engine (a static address, or the next free one of the network's range): DHCP is modelled on macvlan networks only`);
      }
      const sub = net.subnet ? parsePrefix(net.subnet) : null;
      if (sub) {
        i.addresses.forEach((t, j) => {
          const p = parsePrefix(t, false);
          if (!p) return;
          const node = (get(im, 'ip') as YNode) || im;
          const ap = `${ipath}.ip${(get(im, 'ip') as YNode | undefined)?.kind === 'seq' ? `[${j}]` : ''}`;
          if (!inPrefix(sub, p)) c.error(node, ap, `${t.split('/')[0]} is not in the subnet ${net.subnet} of container network "${net.name}"`);
          else if (net.gateway && formatAddr(p) === net.gateway) c.error(node, ap, `${net.gateway} is the gateway of container network "${net.name}"${net.driver === 'bridge' ? ` (the host's ${net.iface || 'bridge'})` : ''}: a container needs another address`);
          else if (t.indexOf('/') >= 0 && p.prefix !== sub.prefix) c.error(node, ap, `${t} has another prefix length than the subnet ${net.subnet}: write ${t.split('/')[0]}/${sub.prefix} (or the address alone)`);
        });
      }
      for (const pub of i.publish || []) {
        const pubNode = (get(im, 'publish') as YNode) || im;
        if (net.driver !== 'bridge') {
          c.error(pubNode, ipath + '.publish', `published ports are a bridge network's (DNAT on the host): "${net.name}" is a ${net.driver} network`);
          break;
        }
        const h = devIndex.get(found.owner);
        if (pub.hostIp && h && !h.interfaces.concat(h.logical).some((y) => y.addresses.some((a) => a.split('/')[0].toLowerCase() === (pub.hostIp as string).toLowerCase()))) {
          c.error(pubNode, ipath + '.publish', `${pub.hostIp} is not an address of host "${found.owner}"`);
        }
        const k = `${found.owner}|${pub.hostIp || '*'}|${pub.hostPort}|${pub.protocol}`;
        const kAny = `${found.owner}|*|${pub.hostPort}|${pub.protocol}`;
        const prev = published.get(k) || (pub.hostIp ? published.get(kAny) : Array.from(published.keys()).filter((y) => y.indexOf(`${found.owner}|`) === 0 && y.endsWith(`|${pub.hostPort}|${pub.protocol}`)).map((y) => published.get(y))[0]);
        if (prev) c.error(pubNode, ipath + '.publish', `${pub.protocol}/${pub.hostPort} on ${pub.hostIp || 'every address'} of "${found.owner}" is already published by ${prev}`);
        else published.set(k, `${d.id}:${i.id}`);
      }
    }
  }
  return derived;
}

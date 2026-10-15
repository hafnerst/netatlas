/**
 * Which simulation attributes a device of the model has (params.ts
 * deviceParams): what its type is, and what the model gives it (addresses,
 * aggregates, an IPsec relation, an SNMP relation it polls from, VMs or
 * containers cabled to it). Pure.
 */
import { deviceRoutingRole } from '../../model/device-types';
import { protocolBase } from '../../model/protocols';
import { Device, Interface, Model, Relation, deviceInterfaces, relationDevices } from '../../model/types';
import { DeviceFacts, IfaceFacts, ParamDef, RelFacts, deviceParams, deviceParamByYaml, interfaceParams, relationParams, vlanParams } from './params';

export function deviceFacts(model: Model, d: Device): DeviceFacts {
  const ifs = deviceInterfaces(d);
  const rels = model.relations.filter((r) => relationDevices(r).indexOf(d.id) >= 0);
  const base = (p: string): string => protocolBase(model.protocols, p);
  const hosts = model.links.some((l) => {
    const other = l.a.device === d.id ? l.b.device : l.b.device === d.id ? l.a.device : '';
    const o = other ? model.index.devices.get(other) : undefined;
    return !!o && (o.type === 'vm' || o.type === 'container');
  });
  return {
    id: d.id,
    type: d.type,
    layer3: d.layer3,
    ip: ifs.some((i) => i.addresses.length > 0 || i.dhcp),
    routes: deviceRoutingRole(d) === 'router',
    aggregate: d.logical.some((i) => i.type === 'virtual' && i.members.length > 0),
    ipsec: rels.some((r) => base(r.protocol) === 'ipsec'),
    snmpManager: rels.some((r) => base(r.protocol) === 'snmp' && relationDevices(r)[relationDevices(r).length - 1] === d.id),
    hosts,
    dhcpServer: !!d.netServices && !!d.netServices.dhcp,
  };
}

/** What the applicability of an interface attribute needs: a port, an address, an aggregate, a bridge port, a radio. */
export function ifaceFacts(model: Model, d: Device, i: Interface): IfaceFacts {
  const lag = i.type === 'virtual' && i.members.length > 0;
  const member = d.logical.some((x) => x.type === 'virtual' && x.members.indexOf(i.id) >= 0);
  const port = i.type === 'physical';
  const wireless = port && model.links.some((l) => l.medium === 'wireless' && ((l.a.device === d.id && l.a.iface === i.id) || (l.b.device === d.id && l.b.iface === i.id)));
  return {
    port,
    ip: i.addresses.length > 0 || i.dhcp,
    dhcp: i.dhcp,
    lag,
    bridgePort: d.type === 'switch' && ((port && !member && !(i.addresses.length > 0 || i.dhcp)) || lag),
    radio: d.type === 'ap' && wireless,
  };
}

/** What the applicability of a relation attribute needs: its protocol, and whether it is a load balancer's pool or a server's service. */
export function relFacts(model: Model, r: Relation): RelFacts {
  const types = relationDevices(r).map((id) => (model.index.devices.get(id) || { type: '' }).type);
  const service = r.category === 'service';
  return {
    base: protocolBase(model.protocols, r.protocol),
    lbService: service && types.indexOf('load_balancer') >= 0,
    serverService: service && types.some((t) => ['server', 'vm', 'container', 'storage'].indexOf(t) >= 0),
  };
}

/** The attributes an interface's Simulation subsection lists: those that apply to it, and any it has written although they don't. */
export function interfaceAttributes(model: Model, d: Device, i: Interface, written: string[] = []): ParamDef[] {
  return withWritten(interfaceParams(deviceFacts(model, d), ifaceFacts(model, d, i)), written);
}

/** The attributes a relation's Simulation subsection lists. */
export function relationAttributes(model: Model, r: Relation, written: string[] = []): ParamDef[] {
  return withWritten(relationParams(relFacts(model, r)), written);
}

/** The attributes a network's Simulation subsection lists (a network with a VLAN). */
export function vlanAttributes(written: string[] = []): ParamDef[] {
  return withWritten(vlanParams(), written);
}

function withWritten(list: ParamDef[], written: string[]): ParamDef[] {
  for (const y of written) {
    const p = deviceParamByYaml(y);
    if (p && list.indexOf(p) < 0) list.push(p);
  }
  return list;
}

/** The attributes a device's Simulation section lists: those that apply to it, and any it has written although they don't. */
export function deviceAttributes(model: Model, d: Device, written: string[] = []): ParamDef[] {
  const list = deviceParams(deviceFacts(model, d));
  for (const y of written) {
    const p = deviceParamByYaml(y);
    if (p && list.indexOf(p) < 0) list.push(p);
  }
  return list;
}

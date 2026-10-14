/**
 * Which simulation attributes a device of the model has (params.ts
 * deviceParams): what its type is, and what the model gives it (addresses,
 * aggregates, an IPsec relation, an SNMP relation it polls from, VMs or
 * containers cabled to it). Pure.
 */
import { deviceRoutingRole } from '../../model/device-types';
import { protocolBase } from '../../model/protocols';
import { Device, Model, deviceInterfaces, relationDevices } from '../../model/types';
import { DeviceFacts, ParamDef, deviceParams, deviceParamByYaml } from './params';

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
  };
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

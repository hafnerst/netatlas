/**
 * The consistency checks of the routing services (model/services.ts): a
 * protocol used by a device's relations but not enabled on it, a protocol
 * enabled but used by no relation, router IDs used twice within one protocol domain, virtual gateway
 * addresses outside their interface's subnet, and members of one group
 * with different group numbers. Each reads only what is written.
 */
import { deviceRoutingRole } from '../model/device-types';
import { parsePrefix } from '../model/ip';
import { protocolBase } from '../model/protocols';
import { routerIdFor, serviceOf } from '../model/services';
import { Model, relationDevices } from '../model/types';
import { MoreCheck } from './checks-more';
import { gatewayConfigs, protocolDomains, serviceRelations, virtualGateways } from './identity';
import { formatAddr, inPrefix, networkOf } from './ipmath';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const label = (model: Model, id: string): string => (model.services.get(id) || { label: id }).label;

export const SERVICE_CHECKS: MoreCheck[] = [
  {
    id: 'protocol-not-enabled',
    severity: 'warning',
    title: 'A device’s relation runs a protocol the device does not enable',
    reads: 'relations (protocol, endpoints); devices: protocols',
    run(model, emit) {
      for (const d of model.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
        if (deviceRoutingRole(d) !== 'router') continue;
        const missing = new Map<string, string[]>();
        for (const r of model.relations) {
          const base = protocolBase(model.protocols, r.protocol);
          const def = model.services.get(base);
          if (!def || !def.sessions || serviceOf(d, base) || relationDevices(r).indexOf(d.id) < 0) continue;
          if (!missing.has(base)) missing.set(base, []);
          (missing.get(base) as string[]).push(r.id);
        }
        for (const [svc, rels] of Array.from(missing.entries()).sort((a, b) => cmp(a[0], b[0]))) {
          rels.sort(cmp);
          emit({
            message: `${d.id} is an endpoint of ${label(model, svc)} ${rels.join(', ')}, but ${label(model, svc)} is not enabled on it: enable ${label(model, svc)} in its protocols`,
            refs: ['device:' + d.id].concat(rels.map((x) => 'relation:' + x)),
            at: { ref: 'device:' + d.id, field: 'protocols' },
          });
        }
      }
    },
  },
  {
    id: 'protocol-unused',
    severity: 'info',
    title: 'A protocol enabled on a device but used by none of its relations',
    reads: 'devices: protocols; relations (protocol, endpoints)',
    run(model, emit) {
      for (const d of model.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
        for (const s of d.services) {
          const def = model.services.get(s.id);
          if (!def || !def.sessions) continue;
          const used = serviceRelations(model, s.id).some((r) => relationDevices(r).indexOf(d.id) >= 0);
          // a redundancy group is used by its interface settings too
          const atIface = d.interfaces.concat(d.logical).some((i) => i.services.some((x) => x.id === s.id));
          if (!used && !atIface) emit({ message: `${def.label} is enabled on ${d.id}, but no ${def.label} relation has it as an endpoint`, refs: ['device:' + d.id], at: { ref: 'device:' + d.id, field: 'protocols.' + s.id } });
        }
      }
    },
  },
  {
    id: 'duplicate-router-id',
    severity: 'error',
    title: 'The same router ID on two devices of one protocol domain',
    reads: 'devices: router_id, protocols (own router_id); relations of each protocol (its domains)',
    run(model, emit) {
      const ids = Array.from(model.services.values())
        .filter((s) => s.routerId !== 'none')
        .map((s) => s.id)
        .sort(cmp);
      for (const svc of ids) {
        for (const dom of protocolDomains(model, svc)) {
          const seen = new Map<string, string>();
          for (const dev of dom) {
            const d = model.index.devices.get(dev);
            const rid = routerIdFor(d, svc);
            if (!rid || !rid.address) continue;
            const first = seen.get(rid.address);
            if (first === undefined) seen.set(rid.address, dev);
            else
              emit({
                message: `${label(model, svc)} router ID ${rid.address} is used by ${first} and ${dev}, in one ${label(model, svc)} domain`,
                refs: ['device:' + dev, 'device:' + first],
                at: { ref: 'device:' + dev, field: rid === (serviceOf(d, svc) || { routerId: undefined }).routerId ? `protocols.${svc}.router_id` : 'router_id' },
              });
          }
        }
      }
    },
  },
  {
    id: 'vip-outside-subnet',
    severity: 'error',
    title: 'Virtual (gateway) address outside its interface’s subnet',
    reads: 'interfaces: protocols (virtual_ip of VRRP, HSRP, GLBP, CARP …), ip',
    run(model, emit) {
      for (const g of virtualGateways(model)) {
        const i = model.index.interfaces.get(g.device + ':' + g.iface);
        if (!i) continue;
        const nets = i.addresses
          .map((t) => ({ t, p: parsePrefix(t, false) }))
          .filter((x) => !!x.p && x.t.indexOf('/') >= 0 && (x.p as NonNullable<typeof x.p>).version === g.address.version);
        if (!nets.length || nets.some((x) => inPrefix(networkOf(x.p as NonNullable<typeof x.p>), g.address))) continue;
        emit({
          message: `${g.device}:${g.iface}: the ${label(model, g.service)} virtual address ${formatAddr(g.address)} is not in a subnet of the interface (${nets.map((x) => x.t).join(', ')})`,
          refs: [`iface:${g.device}:${g.iface}`],
          at: { ref: `iface:${g.device}:${g.iface}`, field: `protocols.${g.service}.${g.key}` },
        });
      }
    },
  },
  {
    id: 'fhrp-group-mismatch',
    severity: 'warning',
    title: 'Members of one virtual address with different group numbers',
    reads: 'interfaces: protocols (group, virtual_ip of VRRP, HSRP …)',
    run(model, emit) {
      const by = new Map<string, Array<{ device: string; iface: string; group?: number }>>();
      for (const x of gatewayConfigs(model)) {
        const t = x.svc.values.get('virtual_ip');
        if (t === undefined) continue;
        const k = x.svc.id + ' ' + t;
        if (!by.has(k)) by.set(k, []);
        const g = x.svc.values.get('group');
        (by.get(k) as Array<{ device: string; iface: string; group?: number }>).push({ device: x.iface.device, iface: x.iface.id, group: g !== undefined ? Number(g) : undefined });
      }
      for (const [k, ms] of Array.from(by.entries()).sort((a, b) => cmp(a[0], b[0]))) {
        const groups = Array.from(new Set(ms.filter((m) => m.group !== undefined).map((m) => m.group as number)));
        if (groups.length < 2) continue;
        const [svc, vip] = k.split(' ');
        ms.sort((a, b) => cmp(a.device, b.device) || cmp(a.iface, b.iface));
        const last = ms[ms.length - 1];
        emit({
          message: `${label(model, svc)} ${vip}: the members are in different groups (${ms.map((m) => `${m.device}:${m.iface} group ${m.group}`).join(', ')}); one virtual address needs one group`,
          refs: ms.map((m) => `iface:${m.device}:${m.iface}`),
          at: { ref: `iface:${last.device}:${last.iface}`, field: `protocols.${svc}.group` },
        });
      }
    },
  },
];

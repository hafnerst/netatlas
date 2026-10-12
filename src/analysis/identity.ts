/**
 * The routing identity of the model, read through the service registry
 * (model/services.ts): the virtual gateway addresses of first-hop
 * redundancy groups (VRRP, HSRP …: the `virtual_ip` of an interface's
 * group), the protocol domains (the devices joined by one protocol's
 * relations), and the effective router IDs per protocol. Pure; sorted by
 * values.
 */
import { IpAddr, parseAddress } from '../model/ip';
import { routingRole } from '../model/device-types';
import { protocolBase } from '../model/protocols';
import { serviceOf } from '../model/services';
import { Interface, Model, Relation, ServiceConfig, deviceInterfaces, relationDevices } from '../model/types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A virtual gateway address of a redundancy group, at one member interface. */
export interface VirtualGateway {
  service: string;
  device: string;
  iface: string;
  /** the parameter it is written in (virtual_ip, virtual_ipv6) */
  key: string;
  address: IpAddr;
  /** as written */
  text: string;
  group?: number;
  priority?: number;
}

/** The interface parameters that hold a virtual gateway address. */
export const VIRTUAL_KEYS = ['virtual_ip', 'virtual_ipv6'];

/** The services whose interface settings carry a virtual gateway address (`virtual_ip`). */
export function gatewayServices(model: Model): string[] {
  return Array.from(model.services.values())
    .filter((s) => s.params.some((p) => p.scope === 'interface' && p.key === 'virtual_ip'))
    .map((s) => s.id)
    .sort(cmp);
}

const vgCache = new WeakMap<Model, VirtualGateway[]>();

/** Every virtual gateway address of the model (of enabled services), by device and interface. */
export function virtualGateways(model: Model): VirtualGateway[] {
  const known = vgCache.get(model);
  if (known) return known;
  const svc = gatewayServices(model);
  const out: VirtualGateway[] = [];
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      for (const s of i.services) {
        if (svc.indexOf(s.id) < 0 || !serviceOf(d, s.id)) continue;
        for (const key of VIRTUAL_KEYS) {
          const t = s.values.get(key);
          const a = t !== undefined ? parseAddress(t) : null;
          if (!a || t === undefined) continue;
          const g = s.values.get('group');
          const p = s.values.get('priority');
          const vg: VirtualGateway = { service: s.id, device: d.id, iface: i.id, key, address: a, text: t };
          if (g !== undefined) vg.group = Number(g);
          if (p !== undefined) vg.priority = Number(p);
          out.push(vg);
        }
      }
    }
  }
  out.sort((a, b) => cmp(a.device, b.device) || cmp(a.iface, b.iface) || cmp(a.service, b.service));
  vgCache.set(model, out);
  return out;
}

/** The interface settings of a gateway service (for the checks). */
export function gatewayConfigs(model: Model): Array<{ iface: Interface; svc: ServiceConfig }> {
  const svc = gatewayServices(model);
  const out: Array<{ iface: Interface; svc: ServiceConfig }> = [];
  for (const d of model.devices) for (const i of deviceInterfaces(d)) for (const s of i.services) if (svc.indexOf(s.id) >= 0) out.push({ iface: i, svc: s });
  return out;
}

/** The relations whose protocol is a service (its sessions), by service id. */
export function serviceRelations(model: Model, service: string): Relation[] {
  return model.relations.filter((r) => protocolBase(model.protocols, r.protocol) === service).sort((a, b) => cmp(a.id, b.id));
}

/**
 * The domains of a protocol: groups of the devices enabling it that its
 * relations join (directly or through others), each sorted; a device with
 * no relation of it is a domain of its own.
 */
export function protocolDomains(model: Model, service: string): string[][] {
  const devs = model.devices.filter((d) => !!serviceOf(d, service)).map((d) => d.id).sort(cmp);
  const parent = new Map<string, string>(devs.map((d) => [d, d]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const r of serviceRelations(model, service)) {
    const ds = relationDevices(r).filter((d) => parent.has(d));
    for (let i = 1; i < ds.length; i++) {
      const a = find(ds[0]);
      const b = find(ds[i]);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const d of devs) {
    const k = find(d);
    if (!groups.has(k)) groups.set(k, []);
    (groups.get(k) as string[]).push(d);
  }
  return Array.from(groups.values()).sort((a, b) => cmp(a[0], b[0]));
}

/** A protocol a device should enable: the relations of it that have the device as an endpoint. */
export interface ServiceSuggestion {
  service: string;
  relations: string[];
}

/**
 * The protocols a Layer 3+ device does not enable although it uses them:
 * those of the relations it is an endpoint of. Sorted by service id. (The
 * Inspector offers each with one click; the check protocol-not-enabled
 * reports them.) Static routes need no protocol: a Layer 3+ device's
 * `routes` are always in effect.
 */
export function suggestedServices(model: Model, device: string): ServiceSuggestion[] {
  const d = model.index.devices.get(device);
  if (!d || routingRole(d.type) !== 'router') return [];
  const out = new Map<string, ServiceSuggestion>();
  for (const r of model.relations) {
    const base = protocolBase(model.protocols, r.protocol);
    const def = model.services.get(base);
    if (!def || !def.sessions || serviceOf(d, base) || relationDevices(r).indexOf(device) < 0) continue;
    if (!out.has(base)) out.set(base, { service: base, relations: [] });
    (out.get(base) as ServiceSuggestion).relations.push(r.id);
  }
  return Array.from(out.values())
    .map((s) => ({ ...s, relations: s.relations.sort(cmp) }))
    .sort((a, b) => cmp(a.service, b.service));
}

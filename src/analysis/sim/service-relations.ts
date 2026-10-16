/**
 * The exchanges a device's services imply, as relations the simulation
 * runs (they are not added to the model, and not drawn): an NTP server's
 * requests to its upstreams, an AAA server's clients' authentication
 * requests, a syslog collector's senders' messages, a monitoring server's
 * SNMP polls of its targets, a controller-managed access point's CAPWAP
 * control channel to its controller. An exchange a relation of the model
 * already describes (the same protocol between the same two devices) is not
 * added again.
 */
import { compareAddr } from '../ipmath';
import { parseAddress } from '../../model/ip';
import { protocolBase } from '../../model/protocols';
import { Model, Relation, deviceInterfaces, relationDevices } from '../../model/types';

/** The device that has an address (as written on its interfaces), else null. */
function ownerOf(model: Model, text: string): string | null {
  const a = parseAddress(text);
  if (!a) return null;
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      for (const x of i.addresses) {
        const b = parseAddress(x.replace(/\/\d+$/, ''));
        if (b && compareAddr(a, b) === 0) return d.id;
      }
    }
  }
  return null;
}

/** The relations a model's services imply (see the module comment), in a stable order. */
export function serviceRelations(model: Model): Relation[] {
  const out: Relation[] = [];
  const has = (protocol: string, a: string, b: string): boolean =>
    model.relations.some((r) => protocolBase(model.protocols, r.protocol) === protocol && relationDevices(r).indexOf(a) >= 0 && relationDevices(r).indexOf(b) >= 0) ||
    out.some((r) => r.protocol === protocol && r.endpoints[0].device === a && r.endpoints[1].device === b);
  const add = (id: string, protocol: string, client: string, server: string, label: string): void => {
    if (client === server || !model.index.devices.has(client) || !model.index.devices.has(server) || has(protocol, client, server)) return;
    out.push({ id, protocol, category: 'service', label, endpoints: [{ device: client }, { device: server }], over: [], direction: 'unidirectional', attrs: [], line: 0 });
  };
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : []);
  for (const d of model.devices.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const svc = d.appServices;
    if (svc) {
      const ntp = svc.get('ntp');
      if (ntp) list(ntp.values.upstreams).forEach((u, k) => {
        const o = ownerOf(model, u);
        if (o) add(`ntp-of-${d.id}-${k + 1}`, 'ntp', d.id, o, `NTP: ${d.id} asks ${o}`);
      });
      const aaa = svc.get('aaa');
      if (aaa) for (const c of list(aaa.values.clients)) add(`aaa-${c}-${d.id}`, 'radius', c, d.id, `AAA: ${c} authenticates at ${d.id}`);
      const log = svc.get('syslog');
      if (log) for (const s of list(log.values.senders)) add(`syslog-${s}-${d.id}`, 'syslog', s, d.id, `Syslog: ${s} logs to ${d.id}`);
      // SNMP: the manager is the relation's last endpoint (it polls each agent)
      const mon = svc.get('monitoring');
      if (mon) for (const t of list(mon.values.targets)) add(`snmp-${t}-${d.id}`, 'snmp', t, d.id, `Monitoring: ${d.id} polls ${t}`);
    }
    if (d.wireless && d.wireless.controller) add(`capwap-${d.id}`, 'capwap', d.id, d.wireless.controller, `CAPWAP: ${d.id} to its controller ${d.wireless.controller}`);
  }
  return out;
}

/**
 * The exchanges a device's services imply, as relations the simulation
 * runs (they are not added to the model, and not drawn): an NTP server's
 * requests to its upstreams, an AAA server's clients' authentication
 * requests, a syslog collector's senders' messages, a monitoring server's
 * SNMP polls of its targets, a controller-managed access point's CAPWAP
 * control channel to its controller. An exchange a relation of the model
 * already describes (the same protocol between the same two devices) is not
 * added again.
 *
 * An NTP upstream is an address, not a device: its relation carries the
 * address configured (the attribute `upstream`), the session asks exactly
 * that address, and two upstreams that are two addresses of one server are
 * two associations. Which device has the address is the one the client's
 * traffic reaches (`owner`: the simulation's forwarding context), so an
 * address two VRFs both have is not the first device listed.
 */
import { addressHolders } from '../names';
import { protocolBase } from '../../model/protocols';
import { Model, Relation, relationDevices } from '../../model/types';

/** The address an NTP upstream relation asks (its configured upstream), or undefined for any other relation. */
export function upstreamOf(r: Relation): string | undefined {
  const a = r.attrs.find(([k]) => k === 'upstream');
  return a ? a[1] : undefined;
}

/**
 * The relations a model's services imply (see the module comment), in a stable order. `owner`: which device an
 * address several devices have is, seen from a client (null: it can't be told — no relation is made up).
 */
export function serviceRelations(model: Model, owner: (client: string, address: string) => string | null = () => null): Relation[] {
  const out: Relation[] = [];
  const has = (protocol: string, a: string, b: string, upstream?: string): boolean =>
    model.relations.some((r) => protocolBase(model.protocols, r.protocol) === protocol && relationDevices(r).indexOf(a) >= 0 && relationDevices(r).indexOf(b) >= 0) ||
    out.some((r) => r.protocol === protocol && r.endpoints[0].device === a && r.endpoints[1].device === b && upstreamOf(r) === upstream);
  const add = (id: string, protocol: string, client: string, server: string, label: string, upstream?: string): void => {
    if (client === server || !model.index.devices.has(client) || !model.index.devices.has(server) || has(protocol, client, server, upstream)) return;
    out.push({ id, protocol, category: 'service', label, endpoints: [{ device: client }, { device: server }], over: [], direction: 'unidirectional', attrs: upstream ? [['upstream', upstream]] : [], line: 0 });
  };
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : []);
  for (const d of model.devices.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const svc = d.appServices;
    if (svc) {
      const ntp = svc.get('ntp');
      if (ntp) list(ntp.values.upstreams).forEach((u, k) => {
        const hs = addressHolders(model, u);
        const o = hs.length === 1 ? hs[0] : hs.length > 1 ? owner(d.id, u) : null;
        if (o) add(`ntp-of-${d.id}-${k + 1}`, 'ntp', d.id, o, `NTP: ${d.id} asks ${o} at ${u}`, u);
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

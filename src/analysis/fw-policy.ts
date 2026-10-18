/**
 * A firewall's policy as the path tracer reads it, the same as the
 * simulation's (analysis/sim/transport.ts filter): what the model's relations
 * between the two devices permit on their protocol's port, and the further
 * services of its "allow" list (simulation attribute); anything else is
 * denied. Its sessions (replies) are the simulation's; the tracer follows one
 * direction with a service. A relation permits both ways and a service of the
 * allow list from anywhere to anywhere: the policy has no zones or directions.
 */
import { Device, Model, relationDevices } from '../model/types';
import { protocolBase } from '../model/protocols';
import { simProfile } from '../model/sim-profiles';
import { parsePorts, portsMatch } from './sim/params';

/** The transport and ports of a relation's protocol ("TCP 443", "UDP 1812/1813"), or none. */
function transportOf(model: Model, protocol: string): { proto: string; ports: number[] } | null {
  const p = simProfile(protocolBase(model.protocols, protocol));
  const m = p ? /\b(TCP|UDP)\s+([0-9]{1,5})((?:\s*\/\s*[0-9]{1,5})*)/.exec(p.proto) : null;
  if (!m) return null;
  const ports = [Number(m[2])].concat((m[3] || '').split('/').map((y) => y.trim()).filter((y) => y).map(Number));
  return { proto: m[1].toLowerCase(), ports };
}

/**
 * The firewall's decision on traffic from one device to another with a service: a text saying
 * what permits it (ok), or why it is denied.
 */
export function firewallDecision(model: Model, fw: Device, from: string | null, to: string | null, svc: { proto: string; port: number }): { ok: boolean; text: string } {
  const what = svc.proto === 'icmp' ? 'ICMP' : `${svc.proto}/${svc.port}`;
  if (svc.proto !== 'icmp' && from && to) {
    for (const r of model.relations.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const devs = relationDevices(r);
      if (devs.indexOf(from) < 0 || devs.indexOf(to) < 0) continue;
      const t = transportOf(model, r.protocol);
      if (t && t.proto === svc.proto && t.ports.indexOf(svc.port) >= 0) return { ok: true, text: `${fw.id} permits ${what} from ${from} to ${to}: the relation ${r.id} (${r.protocol})` };
    }
  }
  // (the device's `allow:` as validation stores it: by its registry key)
  const raw = fw.simulation ? fw.simulation.get('fw-allow') : undefined;
  const allow = parsePorts(raw === undefined ? 'none' : String(raw) || 'none');
  if ('list' in allow && portsMatch(allow.list, svc.proto, svc.proto === 'icmp' ? 0 : svc.port)) return { ok: true, text: `${fw.id} permits ${what}: its allow list (${String(raw)})` };
  const between = (from ? ` from ${from}` : '') + (to ? ` to ${to}` : '');
  return { ok: false, text: `${fw.id} denies ${what}${between}: no relation of the model between them and no allow entry permits it (its default action)` };
}

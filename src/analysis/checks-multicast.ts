/**
 * The consistency checks of multicast (the interfaces' `multicast:` joins
 * and streams, PIM on the routers): receivers in a subnet that no IGMP / MLD
 * querier serves, sparse-mode groups without a rendezvous point, and a
 * router whose unicast route towards a source (or the RP) leaves through an
 * interface without a PIM neighbour, so that the source's traffic fails
 * its RPF check there. Pure: read from the model only.
 */
import { IpAddr, parseAddress } from '../model/ip';
import { protocolBase } from '../model/protocols';
import { Device, Interface, Model, deviceInterfaces, relationDevices } from '../model/types';
import { compareAddr, formatAddr } from './ipmath';
import { lookup } from './routing';

type Emit = (f: { message: string; refs: string[]; at: { ref: string; field?: string } }) => void;

interface McCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  reads: string;
  run(model: Model, emit: Emit): void;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const iref = (i: Interface): string => `iface:${i.device}:${i.id}`;

function addrs(i: Interface): Array<{ addr: IpAddr; prefix: number }> {
  const out: Array<{ addr: IpAddr; prefix: number }> = [];
  for (const t of i.addresses) {
    const [a, p] = t.split('/');
    const ad = parseAddress(a);
    if (ad) out.push({ addr: ad, prefix: p !== undefined ? Number(p) : ad.version === 4 ? 32 : 128 });
  }
  return out;
}

function sameNet(a: IpAddr, b: IpAddr, prefix: number): boolean {
  if (a.version !== b.version) return false;
  let bits = prefix;
  for (let i = 0; i < a.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((a.bytes[i] & mask) !== (b.bytes[i] & mask)) return false;
  }
  return true;
}

function pim(d: Device): boolean {
  return d.services.some((s) => s.id === 'pim');
}

function isSsm(g: IpAddr): boolean {
  return g.version === 4 ? g.bytes[0] === 232 : g.bytes[0] === 0xff && (g.bytes[1] & 0xf0) === 0x30;
}

/** Every join of the model, with its interface. */
function joins(model: Model): Array<{ d: Device; i: Interface; group: string }> {
  const out: Array<{ d: Device; i: Interface; group: string }> = [];
  for (const d of model.devices) for (const i of deviceInterfaces(d)) if (i.multicast) for (const j of i.multicast.joins) out.push({ d, i, group: j.group });
  return out;
}

/** Every stream's source address. */
function sources(model: Model): Array<{ d: Device; i: Interface; addr: IpAddr; group: string }> {
  const out: Array<{ d: Device; i: Interface; addr: IpAddr; group: string }> = [];
  for (const d of model.devices) {
    for (const i of deviceInterfaces(d)) {
      if (!i.multicast) continue;
      for (const s of i.multicast.streams) {
        const g = parseAddress(s.group);
        const a = g ? addrs(i).find((x) => x.addr.version === g.version) : undefined;
        if (a && g) out.push({ d, i, addr: a.addr, group: s.group });
      }
    }
  }
  return out;
}

/** The static RP the model names (a router's pim rp, a PIM relation's rp, a candidate RP), or null. */
function rpOf(model: Model): string | null {
  for (const d of model.devices) {
    const s = d.services.find((x) => x.id === 'pim');
    if (s && (s.values.get('rp') || s.values.get('candidate_rp') === 'yes')) return s.values.get('rp') || d.id;
  }
  for (const r of model.relations) if (protocolBase(model.protocols, r.protocol) === 'pim' && r.attrs.some(([k]) => k === 'rp')) return (r.attrs.find(([k]) => k === 'rp') as [string, string])[1];
  return null;
}

export const MULTICAST_CHECKS: McCheck[] = [
  {
    id: 'multicast-no-querier',
    severity: 'warning',
    title: 'Receivers of a group in a subnet without an IGMP / MLD querier',
    reads: 'interfaces: multicast join, simulation igmp_querier; routers with PIM (protocols: pim) and their simulation igmp_querier; networks (VLANs) with simulation snooping_querier',
    run(model, emit) {
      const routers = model.devices.filter((d) => pim(d) || model.relations.some((r) => protocolBase(model.protocols, r.protocol) === 'igmp' && relationDevices(r).indexOf(d.id) >= 0 && d.type !== 'endpoint' && d.type !== 'server'));
      const seen = new Set<string>();
      for (const j of joins(model)) {
        const key = j.d.id + ':' + j.i.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const own = addrs(j.i);
        const served = routers.some((r) =>
          deviceInterfaces(r).some((ri) => {
            // the querier setting of that interface, else the router's
            const q = (ri.simulation && ri.simulation.get('igmp-querier')) || (r.simulation && r.simulation.get('igmp-querier'));
            return q !== 'off' && addrs(ri).some((ra) => own.some((o) => o.addr.version === ra.addr.version && o.prefix === ra.prefix && sameNet(o.addr, ra.addr, o.prefix)));
          }),
        );
        if (served || snoopingQuerier(model, j.d, own)) continue;
        emit({ message: `${key} joins ${j.group}, but no multicast router (PIM, querier on) is in its subnet and no switch on its way is a snooping querier: its membership is never asked for, and with snooping the switches never learn it`, refs: ['device:' + j.d.id, iref(j.i)], at: { ref: iref(j.i), field: 'multicast' } });
      }
    },
  },
  {
    id: 'multicast-no-rp',
    severity: 'warning',
    title: 'Sparse-mode groups without a rendezvous point',
    reads: 'interfaces: multicast join and streams; protocols: pim (mode, rp, candidate_rp); PIM relations: rp',
    run(model, emit) {
      const sparse = model.devices.filter((d) => {
        const s = d.services.find((x) => x.id === 'pim');
        return !!s && (s.values.get('mode') || 'sparse') === 'sparse';
      });
      if (!sparse.length || rpOf(model)) return;
      const groups = new Set<string>();
      for (const j of joins(model)) {
        const g = parseAddress(j.group);
        if (g && !isSsm(g)) groups.add(j.group);
      }
      for (const s of sources(model)) {
        const g = parseAddress(s.group);
        if (g && !isSsm(g)) groups.add(s.group);
      }
      if (!groups.size) return;
      const d = sparse.sort((a, b) => cmp(a.id, b.id))[0];
      emit({ message: `PIM sparse mode on ${sparse.map((x) => x.id).sort(cmp).join(', ')}, any-source groups ${Array.from(groups).sort(cmp).join(', ')}, but no rendezvous point: write rp under a router's protocols: pim (or candidate_rp: yes), or use source-specific groups (232.0.0.0/8)`, refs: sparse.map((x) => 'device:' + x.id), at: { ref: 'device:' + d.id, field: 'protocols' } });
    },
  },
  {
    id: 'multicast-rpf-not-pim',
    severity: 'warning',
    title: 'A router’s route towards a multicast source leaves through an interface without PIM (the RPF check fails)',
    reads: 'interfaces: multicast streams; protocols: pim; routes and relations (the unicast route); PIM relations (the neighbours)',
    run(model, emit) {
      const targets: Array<{ addr: IpAddr; what: string }> = sources(model).map((s) => ({ addr: s.addr, what: `the source ${formatAddr(s.addr)} (${s.d.id}) of ${s.group}` }));
      const rp = rpOf(model);
      const rpa = rp ? parseAddress(rp) : null;
      if (rpa) targets.push({ addr: rpa, what: `the RP ${rp}` });
      const seen = new Set<string>();
      for (const r of model.devices.filter(pim).sort((a, b) => cmp(a.id, b.id))) {
        for (const t of targets) {
          const k = r.id + '|' + formatAddr(t.addr);
          if (seen.has(k)) continue;
          seen.add(k);
          if (deviceInterfaces(r).some((i) => addrs(i).some((a) => compareAddr(a.addr, t.addr) === 0))) continue;
          const d = lookup(model, r.id, '', t.addr);
          if (d.kind !== 'forward' || !d.hops.length || !d.hops[0].gateway) continue;
          const hop = d.hops[0];
          const gw = hop.gateway as IpAddr;
          const owner = model.devices.find((x) => deviceInterfaces(x).some((i) => addrs(i).some((a) => compareAddr(a.addr, gw) === 0)));
          if (!owner) continue;
          const ok = model.relations.some((rel) => {
            if (protocolBase(model.protocols, rel.protocol) !== 'pim') return false;
            const devs = relationDevices(rel);
            if (devs.indexOf(r.id) < 0 || devs.indexOf(owner.id) < 0) return false;
            const ep = rel.endpoints.find((e) => e.device === r.id);
            return !ep || !ep.iface || ep.iface === hop.iface;
          });
          if (ok) continue;
          emit({ message: `${r.id}'s route towards ${t.what} leaves through ${hop.iface} to ${owner.id} (${formatAddr(gw)}), but they have no PIM relation there: joins cannot go that way and the traffic fails the RPF check at ${r.id}`, refs: ['device:' + r.id, 'device:' + owner.id, `iface:${r.id}:${hop.iface}`], at: { ref: 'device:' + r.id, field: 'protocols' } });
        }
      }
    },
  },
];

/** Does a switch with the snooping querier on lie on the receiver's Layer 2 way (through switches and access points)? */
function snoopingQuerier(model: Model, d: Device, own: Array<{ addr: IpAddr; prefix: number }> = []): boolean {
  // the snooping querier is a VLAN's setting (a network's simulation:): the VLAN of the host's subnet
  const querierVlan = model.networks.some((n) => {
    if (n.vlan === undefined || !n.simulation || n.simulation.get('snoop-querier') !== 'on' || !n.cidr) return false;
    const [na, nl] = n.cidr.split('/');
    const net = parseAddress(na);
    return !!net && own.some((o) => o.addr.version === net.version && o.prefix === Number(nl) && sameNet(o.addr, net, o.prefix));
  });
  const seen = new Set<string>([d.id]);
  let frontier = [d.id];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const l of model.links) {
        const o = l.a.device === id ? l.b.device : l.b.device === id ? l.a.device : '';
        if (!o || seen.has(o)) continue;
        const od = model.index.devices.get(o);
        if (!od || (od.type !== 'switch' && od.type !== 'ap')) continue;
        if (od.type === 'switch' && querierVlan) return true;
        seen.add(o);
        next.push(o);
      }
    }
    frontier = next;
  }
  return false;
}

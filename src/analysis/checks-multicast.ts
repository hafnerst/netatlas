/**
 * The consistency checks of multicast (the interfaces' `multicast:` joins
 * and streams, PIM on the routers): receivers in a subnet that no IGMP / MLD
 * querier serves, sparse-mode groups without a rendezvous point, and a
 * router whose unicast route towards a source (or the RP) leaves through an
 * interface without a PIM neighbour, so that the source's traffic fails
 * its RPF check there; a switch VLAN without an IGMP / MLD snooping choice
 * (model/snooping.ts). Pure: read from the model only.
 */
import { IpAddr, parseAddress } from '../model/ip';
import { protocolBase } from '../model/protocols';
import { Device, Interface, Model, deviceInterfaces, relationDevices } from '../model/types';
import { compareAddr, formatAddr } from './ipmath';
import { lookup } from './routing';
import { RpEnv, rpConflicts, rpFor } from './pim-rp';
import { routerIdFor } from '../model/services';
import { capabilities } from '../model/capabilities';
import { SNOOPING_KEY, unsetSnoopingVlans } from '../model/snooping';
import { vlanRangesShown } from '../model/derive';

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
/** The RP choice's view of the model (analysis/pim-rp.ts): the configured addresses, the router IDs, every router on. */
function rpEnv(model: Model): RpEnv {
  return {
    ownerOf(a: IpAddr): string | null {
      const d = model.devices.find((x) => deviceInterfaces(x).some((i) => addrs(i).some((y) => compareAddr(y.addr, a) === 0)));
      return d ? d.id : null;
    },
    routerId(dev: string): IpAddr | null {
      const d = model.index.devices.get(dev);
      const own = routerIdFor(d, 'pim');
      if (own && own.address) return parseAddress(own.address);
      const v4 = (loop: boolean): IpAddr[] => (d ? deviceInterfaces(d) : []).filter((i) => (i.type === 'loopback') === loop).flatMap((i) => addrs(i).map((x) => x.addr)).filter((x) => x.version === 4).sort(compareAddr);
      const l = v4(true);
      const all = l.length ? l : v4(false);
      return all.length ? all[all.length - 1] : null;
    },
    v6Addr(dev: string): IpAddr | null {
      const d = model.index.devices.get(dev);
      const ifs = (d ? deviceInterfaces(d) : []).slice().sort((x, y) => Number(y.type === 'loopback') - Number(x.type === 'loopback') || cmp(x.id, y.id));
      for (const i of ifs) for (const x of addrs(i)) if (x.addr.version === 6 && x.addr.bytes[0] !== 0xfe) return x.addr;
      return null;
    },
  };
}

export const MULTICAST_CHECKS: McCheck[] = [
  {
    id: 'snooping-not-configured',
    severity: 'error',
    title: 'A switch VLAN without an IGMP / MLD snooping choice',
    reads: 'switches: igmp_mld_snooping; the VLANs of their ports and aggregates',
    run(model, emit) {
      for (const d of model.devices.slice().sort((a, b) => cmp(a.id, b.id))) {
        const unset = unsetSnoopingVlans(d);
        if (!unset.length) continue;
        const list = vlanRangesShown(unset, true);
        emit({ message: `${d.id} carries VLAN${unset.length > 1 ? 's' : ''} ${list} without an IGMP / MLD snooping choice: set ${SNOOPING_KEY} to enabled or disabled for ${unset.length > 1 ? 'each' : 'it'} (until then the simulation floods ${unset.length > 1 ? 'their' : 'its'} multicast, as a switch without snooping)`, refs: ['device:' + d.id], at: { ref: 'device:' + d.id, field: SNOOPING_KEY } });
      }
    },
  },
  {
    id: 'multicast-no-querier',
    severity: 'warning',
    title: 'Receivers of a group in a subnet without an IGMP / MLD querier',
    reads: 'interfaces: multicast join, simulation igmp_querier; routers with PIM (protocols: pim) and their simulation igmp_querier; networks (VLANs) with simulation snooping_querier',
    run(model, emit) {
      const routers = model.devices.filter((d) => pim(d) || model.relations.some((r) => protocolBase(model.protocols, r.protocol) === 'igmp' && relationDevices(r).indexOf(d.id) >= 0 && capabilities(d).l3Forward));
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
      if (!sparse.length) return;
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
      // each router's own RP for each group (its static RP, its relations' rp, its domain's candidate): those that have none
      const env = rpEnv(model);
      const none = new Map<string, string[]>();
      for (const r of sparse.slice().sort((a, b) => cmp(a.id, b.id))) for (const g of Array.from(groups).sort(cmp)) if (!rpFor(model, env, r.id, g)) none.set(r.id, (none.get(r.id) || []).concat([g]));
      if (!none.size) return;
      const ids = Array.from(none.keys());
      const gs = Array.from(new Set(Array.from(none.values()).flat())).sort(cmp);
      emit({ message: `PIM sparse mode on ${ids.join(', ')}, any-source group${gs.length === 1 ? '' : 's'} ${gs.join(', ')}, but no rendezvous point there (no static rp, no rp on its PIM relations, no candidate RP in its PIM domain, or none of the group's address family): write rp under a router's protocols: pim (or candidate_rp: yes), or use source-specific groups (232.0.0.0/8)`, refs: ids.map((x) => 'device:' + x), at: { ref: 'device:' + ids[0], field: 'protocols' } });
    },
  },
  {
    id: 'multicast-rp-conflict',
    severity: 'warning',
    title: 'Routers of one PIM domain use different rendezvous points for a group',
    reads: 'protocols: pim (rp, candidate_rp); PIM relations: rp; interfaces: multicast join and streams',
    run(model, emit) {
      const env = rpEnv(model);
      const routers = model.devices.filter(pim).map((d) => d.id);
      const groups = Array.from(new Set(sources(model).map((s) => s.group).concat(joins(model).map((j) => j.group)))).filter((g) => {
        const a = parseAddress(g);
        return !!a && !isSsm(a);
      }).sort(cmp);
      const seen = new Set<string>();
      for (const g of groups) {
        for (const c of rpConflicts(model, env, routers, g)) {
          const k = `${c.a}|${c.b}|${formatAddr(c.ra.addr)}|${formatAddr(c.rb.addr)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          emit({ message: `${c.a} uses ${formatAddr(c.ra.addr)} (${c.ra.dev}, ${c.ra.how}) as the RP of ${g}, ${c.b} ${formatAddr(c.rb.addr)} (${c.rb.dev}, ${c.rb.how}): in one PIM domain their shared trees do not meet`, refs: ['device:' + c.a, 'device:' + c.b], at: { ref: 'device:' + c.a, field: 'protocols' } });
        }
      }
    },
  },
  {
    id: 'multicast-rpf-not-pim',
    severity: 'warning',
    title: 'A router’s route towards a multicast source leaves through an interface without PIM (the RPF check fails)',
    reads: 'interfaces: multicast streams; protocols: pim; routes and relations (the unicast route); PIM relations (the neighbours)',
    run(model, emit) {
      const targets: Array<{ addr: IpAddr; what: string }> = sources(model).map((s) => ({ addr: s.addr, what: `the source ${formatAddr(s.addr)} (${s.d.id}) of ${s.group}` }));
      const env = rpEnv(model);
      const asm = Array.from(new Set(sources(model).map((s) => s.group).concat(joins(model).map((j) => j.group)))).filter((g) => {
        const a = parseAddress(g);
        return !!a && !isSsm(a);
      }).sort(cmp);
      const seen = new Set<string>();
      for (const r of model.devices.filter(pim).sort((a, b) => cmp(a.id, b.id))) {
        // the RP this router itself uses (for each any-source group), besides the sources
        const own = targets.slice();
        for (const g of asm) {
          const rp = rpFor(model, env, r.id, g);
          if (rp && !own.some((t) => compareAddr(t.addr, rp.addr) === 0)) own.push({ addr: rp.addr, what: `its RP ${formatAddr(rp.addr)} (${rp.dev})` });
        }
        for (const t of own) {
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
        if (!od || (!capabilities(od).switchFeatures && !capabilities(od).wirelessAccess)) continue;
        if (capabilities(od).switchFeatures && querierVlan) return true;
        seen.add(o);
        next.push(o);
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * End-to-end path MTU, statically: for a communication check's evaluated
 * paths (every equal-cost branch) and its return path, the largest IP
 * packet that crosses each path unfragmented, the component that limits
 * it, and the payload that fits (the MTU less the IP and transport
 * headers: TCP's MSS, a UDP or ICMP payload). It extends the model's MTU
 * facts (an interface's `mtu`) and the tunnel overheads the tunnel-MTU
 * check states (checks-more.ts ENCAP_OVERHEAD), never duplicates them:
 *
 *   interfaces  each hop's egress interface, the ports of the cables to the
 *               next hop (switch ports too: a frame must fit them) and the
 *               next hop's ingress interface;
 *   tunnels     a hop that encapsulates (GRE, IPsec, VXLAN …) takes the
 *               inner packet through its traced underlay: the underlay
 *               path's MTU less the overhead of the layers it adds (nested
 *               layers add up), and the tunnel interface's own MTU.
 *
 * Nothing unknown is taken as known: an interface without an MTU written
 * is listed as unknown (the result is then an upper bound, indeterminate),
 * and an encapsulation without a known overhead makes that path's limit
 * unknown. Equal-cost branches and the two directions are reported apart
 * where they differ. The simulation fragments IPv4 without DF, drops a
 * larger packet with DF (and IPv6) with Fragmentation Needed or Packet Too
 * Big, and learns the path MTU from it (PMTUD): that is runtime behaviour,
 * offered as a prefilled test, never claimed here. Pure and deterministic.
 */
import { ENCAP_OVERHEAD, baseProtocol } from './checks-more';
import { parseAddress } from '../model/ip';
import { Model, ifaceKey } from '../model/types';

import { CommCheck } from './communication';
import { Verdict } from './result';
import { Hop, Path, Trace, TraceService } from './trace';

/** One MTU on the way: an interface, a port of a cable, or a tunnel (its underlay less its overhead). */
export interface MtuConstraint {
  /** "r1:ge-0/0/1", "sw1:p3 (a port on the way)", "tunnel gre-ham: underlay 1500 − 97" */
  what: string;
  /** a ref for navigation */
  ref: string;
  kind: 'interface' | 'port' | 'tunnel';
  /** null: not known (no MTU written, an overhead not known) */
  mtu: number | null;
}

/** An encapsulation's overhead, as assumed. */
export interface MtuOverhead {
  /** the relation (or tunnel) it belongs to */
  layer: string;
  bytes: number | null;
  /** "GRE: 20 IP + 4 GRE" */
  what: string;
}

/** One evaluated path's MTU. */
export interface PathMtuResult {
  /** 0: the main path, then the equal-cost alternatives */
  index: number;
  /** the smallest known MTU (bytes); null when none is known */
  mtu: number | null;
  /** the component that sets it */
  limiting?: MtuConstraint;
  /** what is on the way without a known MTU: the result is an upper bound */
  unknown: MtuConstraint[];
  /** the encapsulations on the way and what each adds */
  overheads: MtuOverhead[];
  /** every constraint, in path order */
  constraints: MtuConstraint[];
}

export interface PathMtu {
  family: 4 | 6;
  forward: PathMtuResult[];
  reverse: PathMtuResult[];
  /** the IP packet size that crosses every evaluated path (the smallest), null when not known */
  mtu: number | null;
  /** the largest payload of the communication's transport that fits (MTU less the headers) */
  payload: { proto: 'tcp' | 'udp' | 'icmp'; bytes: number; headers: string } | null;
  /** satisfied: established from known MTUs; indeterminate: an upper bound (something unknown on the way); unsupported: nothing to evaluate */
  verdict: Verdict;
  /** one line */
  text: string;
  /** the evaluated branches differ, or the two directions do */
  differs: string[];
  assumptions: string[];
}

const ipHeader = (v: 4 | 6): number => (v === 4 ? 20 : 40);

/** The MTU written on an interface, the smaller of an aggregate's and its members' (none: not known). */
function ifaceMtu(model: Model, dev: string, iface: string | undefined): number | null {
  if (iface === undefined) return null;
  const i = model.index.interfaces.get(ifaceKey(dev, iface));
  if (!i) return null;
  let m = i.mtu !== undefined ? i.mtu : null;
  for (const x of i.members) {
    const mi = model.index.interfaces.get(ifaceKey(dev, x));
    if (mi && mi.mtu !== undefined) m = m === null ? mi.mtu : Math.min(m, mi.mtu);
  }
  return m;
}

/** The overhead of an encapsulation layer (its relation's protocol), as the tunnel-MTU check assumes it. */
function layerOverhead(model: Model, layer: { label: string; relation?: string }): MtuOverhead {
  const r = layer.relation ? model.index.relations.get(layer.relation) : undefined;
  const o = r ? ENCAP_OVERHEAD[baseProtocol(model, r)] : undefined;
  return o ? { layer: layer.relation || layer.label, bytes: o.bytes, what: o.what } : { layer: layer.relation || layer.label, bytes: null, what: `${layer.label}: overhead not known` };
}

/** The constraints of one path, in order (a tunnel's underlay recursively), and its encapsulations. */
function pathConstraints(model: Model, p: Path, depth: number): { constraints: MtuConstraint[]; overheads: MtuOverhead[] } {
  const constraints: MtuConstraint[] = [];
  const overheads: MtuOverhead[] = [];
  const seen = new Set<string>();
  const add = (c: MtuConstraint): void => {
    if (seen.has(c.ref + '|' + c.kind)) return;
    seen.add(c.ref + '|' + c.kind);
    constraints.push(c);
  };
  let prevEncap = 0;
  p.hops.forEach((h: Hop, k) => {
    if (h.ingress !== undefined) add({ what: `${h.device}:${h.ingress}`, ref: `iface:${h.device}:${h.ingress}`, kind: 'interface', mtu: ifaceMtu(model, h.device, h.ingress) });
    if (h.egress === undefined) return;
    // the layers this hop adds: the inner packet goes through the underlay, less their overhead
    const added = h.encap.slice(prevEncap);
    prevEncap = h.encap.length;
    if (added.length && h.underlay && depth < 4) {
      const under = pathConstraints(model, h.underlay, depth + 1);
      const os = added.map((l) => layerOverhead(model, l));
      overheads.push(...os, ...under.overheads);
      const known = under.constraints.filter((c) => c.mtu !== null) as Array<MtuConstraint & { mtu: number }>;
      const min = known.length ? known.reduce((a, b) => (b.mtu < a.mtu ? b : a)) : null;
      const over = os.some((o) => o.bytes === null) ? null : os.reduce((s, o) => s + (o.bytes as number), 0);
      const label = added.map((l) => l.relation || l.label).join(' over ');
      // the unknowns of the underlay stay unknown
      for (const c of under.constraints) if (c.mtu === null) add({ ...c, what: `${c.what} (in the underlay of ${label})` });
      add({ what: `${label}: ${min ? `underlay ${min.mtu} (${min.what})` : 'underlay MTU not known'} − ${over === null ? 'an overhead not known' : over + ' bytes of encapsulation'}`, ref: added[0].relation ? 'relation:' + added[0].relation : `iface:${h.device}:${h.egress}`, kind: 'tunnel', mtu: min && over !== null ? min.mtu - over : null });
    } else if (added.length) {
      // a declared underlay (its `over` cables, not traced): the outer packet crosses them; the tunnel's source interface sends it
      const os = added.map((l) => layerOverhead(model, l));
      overheads.push(...os);
      const under: MtuConstraint[] = [];
      const ti = model.index.interfaces.get(ifaceKey(h.device, h.egress));
      if (ti && ti.source && ti.source.iface) under.push({ what: `${h.device}:${ti.source.iface} (the tunnel’s source)`, ref: `iface:${h.device}:${ti.source.iface}`, kind: 'interface', mtu: ifaceMtu(model, h.device, ti.source.iface) });
      for (const lid of h.links) {
        const l = model.index.links.get(lid);
        for (const e of l ? [l.a, l.b] : []) if (e.iface !== undefined) under.push({ what: `${e.device}:${e.iface}`, ref: `iface:${e.device}:${e.iface}`, kind: 'port', mtu: ifaceMtu(model, e.device, e.iface) });
      }
      const label = added.map((l) => l.relation || l.label).join(' over ');
      for (const c of under.filter((x, k) => under.findIndex((y) => y.ref === x.ref) === k)) if (c.mtu === null) add({ ...c, what: `${c.what} (in the underlay of ${label})` });
      const known = under.filter((c) => c.mtu !== null) as Array<MtuConstraint & { mtu: number }>;
      const min = known.length ? known.reduce((a, b) => (b.mtu < a.mtu ? b : a)) : null;
      const over = os.some((o) => o.bytes === null) ? null : os.reduce((s, o) => s + (o.bytes as number), 0);
      add({ what: `${label}: ${min ? `underlay ${min.mtu} (${min.what})` : 'underlay MTU not known'} − ${over === null ? 'an overhead not known' : over + ' bytes of encapsulation'}`, ref: added[0].relation ? 'relation:' + added[0].relation : `iface:${h.device}:${h.egress}`, kind: 'tunnel', mtu: min && over !== null ? min.mtu - over : null });
      add({ what: `${h.device}:${h.egress}`, ref: `iface:${h.device}:${h.egress}`, kind: 'interface', mtu: ifaceMtu(model, h.device, h.egress) });
      return;
    }
    add({ what: `${h.device}:${h.egress}`, ref: `iface:${h.device}:${h.egress}`, kind: 'interface', mtu: ifaceMtu(model, h.device, h.egress) });
    // a traced underlay carries the outer packet: its cables are the underlay's, not this hop's
    if (added.length) return;
    // the ports of the cables to the next hop (switch ports on the way too)
    for (const lid of h.links) {
      const l = model.index.links.get(lid);
      if (!l) continue;
      for (const e of [l.a, l.b]) {
        if (e.iface === undefined) continue;
        const next = p.hops[k + 1];
        const own = (e.device === h.device && e.iface === h.egress) || (next && e.device === next.device && e.iface === next.ingress);
        if (own) continue;
        add({ what: `${e.device}:${e.iface} (a port on the way)`, ref: `iface:${e.device}:${e.iface}`, kind: 'port', mtu: ifaceMtu(model, e.device, e.iface) });
      }
    }
  });
  return { constraints, overheads };
}

function resultOf(model: Model, p: Path, index: number): PathMtuResult {
  const { constraints, overheads } = pathConstraints(model, p, 0);
  const known = constraints.filter((c) => c.mtu !== null) as Array<MtuConstraint & { mtu: number }>;
  const limiting = known.length ? known.reduce((a, b) => (b.mtu < a.mtu ? b : a)) : undefined;
  const out: PathMtuResult = { index, mtu: limiting ? limiting.mtu : null, unknown: constraints.filter((c) => c.mtu === null), overheads, constraints };
  if (limiting) out.limiting = limiting;
  return out;
}

/** The payload that fits an MTU: TCP's MSS, a UDP or ICMP payload. */
function payloadOf(mtu: number, v: 4 | 6, svc: TraceService | undefined): PathMtu['payload'] {
  const proto = svc ? svc.proto : 'icmp';
  const l4 = proto === 'tcp' ? 20 : 8;
  return { proto, bytes: mtu - ipHeader(v) - l4, headers: `${ipHeader(v)} IPv${v} + ${l4} ${proto === 'tcp' ? 'TCP (without options)' : proto.toUpperCase()}` };
}

/**
 * The path MTU of a communication check (see the module comment): over its
 * evaluated paths that reach, and its return path when it has one. Null
 * when nothing was traced.
 */
export function pathMtu(model: Model, c: CommCheck): PathMtu | null {
  const t: Trace | undefined = c.trace;
  if (!t || t.error || !t.paths.length) return null;
  const a = c.from && c.from.address ? parseAddress(c.from.address) : t.dest ? parseAddress(t.dest.address) : null;
  const v: 4 | 6 = a ? a.version : 4;
  const ends = (p: Path): boolean => p.end.kind === 'reached' || p.end.kind === 'delivered';
  const forward = t.paths.map((p, i) => ({ p, i })).filter((x) => ends(x.p)).map((x) => resultOf(model, x.p, x.i));
  const back = c.reverse ? c.reverse.trace : null;
  const reverse = back && !back.error ? back.paths.map((p, i) => ({ p, i })).filter((x) => ends(x.p)).map((x) => resultOf(model, x.p, x.i)) : [];
  const out: PathMtu = { family: v, forward, reverse, mtu: null, payload: null, verdict: 'unsupported', text: '', differs: [], assumptions: [] };
  out.assumptions.push('An interface’s MTU is the one written in the model (an aggregate: the smallest of it and its members); one not written is not known, never taken as 1500.');
  out.assumptions.push('Encapsulation overheads are the tunnel-MTU check’s, with an IPv4 outer header (IPsec: the worst case of ESP tunnel mode); an encapsulation without a figure leaves its path’s limit unknown.');
  if (!forward.length) {
    out.text = 'No evaluated path reaches the destination: there is no path MTU to evaluate';
    return out;
  }
  const all = forward.concat(reverse);
  const knownAll = all.every((r) => r.mtu !== null);
  const vals = all.map((r) => r.mtu).filter((x): x is number => x !== null);
  out.mtu = vals.length ? Math.min(...vals) : null;
  if (out.mtu !== null) out.payload = payloadOf(out.mtu, v, c.service);
  const fwdVals = forward.map((r) => r.mtu);
  if (new Set(fwdVals.map(String)).size > 1) out.differs.push(`The equal-cost paths differ: ${forward.map((r) => `path ${r.index + 1} ${r.mtu === null ? 'not known' : r.mtu + ' bytes'}`).join(', ')}; a flow takes one of them (which one is not modeled).`);
  if (reverse.length) {
    const f = forward.map((r) => r.mtu).filter((x): x is number => x !== null);
    const b = reverse.map((r) => r.mtu).filter((x): x is number => x !== null);
    if (f.length && b.length && Math.min(...f) !== Math.min(...b)) out.differs.push(`The directions differ: ${Math.min(...f)} bytes there, ${Math.min(...b)} bytes back.`);
  }
  const unknown = all.reduce((s, r) => s + r.unknown.length, 0);
  const lim = all.filter((r) => r.mtu === out.mtu).map((r) => r.limiting).find((x) => !!x);
  if (out.mtu === null) {
    out.verdict = 'indeterminate';
    out.text = `The path MTU is not known: no MTU is written on the way (${unknown} interface${unknown === 1 ? '' : 's'} or tunnel${unknown === 1 ? '' : 's'} without one)`;
  } else if (!knownAll || unknown) {
    out.verdict = 'indeterminate';
    out.text = `At most ${out.mtu} bytes (limited by ${lim ? lim.what : 'a component'}); ${unknown} component${unknown === 1 ? '' : 's'} on the way ha${unknown === 1 ? 's' : 've'} no known MTU, so the limit may be lower`;
  } else {
    out.verdict = 'satisfied';
    out.text = `Path MTU ${out.mtu} bytes (limited by ${lim ? lim.what : 'a component'})`;
  }
  if (out.payload) out.text += `; payload up to ${out.payload.bytes} bytes (${out.payload.proto === 'tcp' ? 'TCP MSS' : out.payload.proto.toUpperCase() + ' payload'}: ${out.mtu} − (${out.payload.headers}))`;
  return out;
}

/** A send that tests the path MTU in the simulation: the payload that fits and one byte more, with DF (IPv4) set. */
export function mtuTestSizes(m: PathMtu): { fits: number; tooBig: number } | null {
  if (!m.payload || m.mtu === null) return null;
  return { fits: m.payload.bytes, tooBig: m.payload.bytes + 1 };
}

/**
 * End-to-end path MTU, statically: for a communication check's evaluated
 * paths (every equal-cost branch) and its return path, the largest IP
 * packet that crosses each path unfragmented, the component that limits
 * it, and the payload that fits (the MTU less the IP and transport
 * headers: TCP's MSS, a UDP or ICMP payload). It extends the model's MTU
 * facts (an interface's `mtu`) and the encapsulation formats of encap.ts
 * (the one definition the simulation's packet lengths use too), never
 * duplicates them:
 *
 *   interfaces  each hop's egress interface, the ports of the cables to the
 *               next hop (switch ports too: a frame must fit them) and the
 *               next hop's ingress interface;
 *   tunnels     a hop that encapsulates (GRE, IPsec, VXLAN …) takes the
 *               inner packet through its traced underlay: the underlay
 *               path's MTU less what the layers it adds take (nested
 *               layers inside out, ESP's padding to its block included:
 *               the largest inner packet whose outer packet fits), and the
 *               tunnel interface's own MTU.
 *
 * Nothing unknown is taken as known: an interface without an MTU written
 * is listed as unknown (the result is then an upper bound, indeterminate),
 * and an encapsulation without a known format is taken as GRE, as the
 * simulation takes it, and makes that path's limit an estimate
 * (indeterminate). Equal-cost branches and the two directions are reported apart
 * where they differ. The simulation fragments IPv4 without DF, drops a
 * larger packet with DF (and IPv6) with Fragmentation Needed or Packet Too
 * Big, and learns the path MTU from it (PMTUD): that is runtime behaviour,
 * offered as a prefilled test, never claimed here. Pure and deterministic.
 */
import { baseProtocol, tunnelOuterFamily } from './checks-more';
import { ASSUMED_ENCAP, EncapDef, encapDef, layerText, maxInnerStack } from './encap';
import { parseAddress } from '../model/ip';
import { Model, ifaceKey } from '../model/types';

import { CommCheck } from './communication';
import { Verdict } from './result';
import { Hop, Path, Trace, TraceService, layerEnds } from './trace';

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

/** An encapsulation layer on the way and what it takes. */
export interface MtuOverhead {
  /** the relation (or tunnel) it belongs to */
  layer: string;
  /** what it adds at the path's limit (null: the underlay's MTU is not known) */
  bytes: number | null;
  /** "GRE: 20 IPv4 + 4 GRE" */
  what: string;
  /** its format as assumed (encap.ts EncapDef.assumes) */
  assumes: string;
  /** the format is not known: taken as GRE, the limit is an estimate */
  assumed?: boolean;
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
  /** the encapsulations whose format is not known (taken as GRE): the limit is an estimate */
  assumed: string[];
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

/** The outer family of a hop's encapsulation: its traced underlay's addresses, else the tunnel interface's ends, else null. */
function outerOf(model: Model, h: Hop): 4 | 6 | null {
  for (const u of h.underlay ? h.underlay.hops : []) {
    const a = parseAddress(u.outAddr || u.inAddr || '');
    if (a) return a.version;
  }
  const ti = h.egress !== undefined ? model.index.interfaces.get(ifaceKey(h.device, h.egress)) : undefined;
  return ti ? tunnelOuterFamily(model, ti) : null;
}

/** The layers a hop adds (innermost first) with their formats and outer family, and what each takes at a limit. */
function layersOf(model: Model, h: Hop, added: Array<{ label: string; relation?: string }>, inner: 4 | 6): { layers: Array<{ def: EncapDef; outer: 4 | 6 }>; os: MtuOverhead[]; fam: 4 | 6 | null } {
  // (the tunnel's own family for its first layer; a layer carried over a relation between other addresses, that
  // relation's own — layerEnds, as the trace routes the outer packet and the simulation sends it)
  const ti = h.egress !== undefined ? model.index.interfaces.get(ifaceKey(h.device, h.egress)) : undefined;
  const fam = (ti ? tunnelOuterFamily(model, ti) : null) || outerOf(model, h);
  const layers: Array<{ def: EncapDef; outer: 4 | 6 }> = [];
  const os: MtuOverhead[] = [];
  for (const l of added) {
    const r = l.relation ? model.index.relations.get(l.relation) : undefined;
    const known = r ? encapDef(baseProtocol(model, r)) : null;
    const def = known || ASSUMED_ENCAP;
    const own = layers.length && l.relation ? layerEnds(model, h.device, l.relation, fam || undefined) : null;
    const outer: 4 | 6 = own ? own.family : fam || inner;
    layers.push({ def, outer });
    const o: MtuOverhead = { layer: l.relation || l.label, bytes: null, what: known ? layerText(def, outer) : `${l.label}: format not known, taken as ${layerText(def, outer)}`, assumes: def.assumes };
    if (!known) o.assumed = true;
    os.push(o);
  }
  return { layers, os, fam };
}

/** The tunnel constraint of the layers a hop adds over an underlay whose smallest known MTU is `min`. */
function tunnelConstraint(label: string, ref: string, min: MtuConstraint | null, layers: Array<{ def: EncapDef; outer: 4 | 6 }>, os: MtuOverhead[]): MtuConstraint {
  const fit = min && min.mtu !== null ? maxInnerStack(layers, min.mtu) : null;
  if (min && min.mtu !== null && fit !== null) {
    // what each layer takes at this limit, outermost first: its outer packet less its inner
    let lim = min.mtu;
    for (let k = layers.length - 1; k >= 0; k--) {
      const inner = maxInnerStack([layers[k]], lim);
      os[k].bytes = inner === null ? null : lim - inner;
      if (inner !== null) lim = inner;
    }
  }
  const what = `${label}: ${min ? `underlay ${min.mtu} (${min.what})` : 'underlay MTU not known'} − ${min && fit !== null ? (min.mtu as number) - fit + ' bytes of encapsulation' : min ? 'more than it has room for' : 'its encapsulation'}`;
  return { what, ref, kind: 'tunnel', mtu: min && fit !== null ? fit : min ? 0 : null };
}

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

/** The constraints of one path, in order (a tunnel's underlay recursively), and its encapsulations. */
function pathConstraints(model: Model, p: Path, depth: number, v: 4 | 6, base = 0): { constraints: MtuConstraint[]; overheads: MtuOverhead[] } {
  const constraints: MtuConstraint[] = [];
  const overheads: MtuOverhead[] = [];
  const seen = new Set<string>();
  const add = (c: MtuConstraint): void => {
    if (seen.has(c.ref + '|' + c.kind)) return;
    seen.add(c.ref + '|' + c.kind);
    constraints.push(c);
  };
  // (an underlay's hops name the layers their outer packet already is: those are not added again)
  let prevEncap = base;
  p.hops.forEach((h: Hop, k) => {
    if (h.ingress !== undefined) add({ what: `${h.device}:${h.ingress}`, ref: `iface:${h.device}:${h.ingress}`, kind: 'interface', mtu: ifaceMtu(model, h.device, h.ingress) });
    if (h.egress === undefined) return;
    // the layers this hop adds: the inner packet goes through the underlay, less their overhead
    const added = h.encap.slice(prevEncap);
    prevEncap = h.encap.length;
    if (added.length && h.underlay && depth < 4) {
      const { layers, os, fam } = layersOf(model, h, added, v);
      const under = pathConstraints(model, h.underlay, depth + 1, fam || v, h.encap.length);
      overheads.push(...os, ...under.overheads);
      const known = under.constraints.filter((c) => c.mtu !== null) as Array<MtuConstraint & { mtu: number }>;
      const min = known.length ? known.reduce((a, b) => (b.mtu < a.mtu ? b : a)) : null;
      const label = added.map((l) => l.relation || l.label).join(' over ');
      // the unknowns of the underlay stay unknown
      for (const c of under.constraints) if (c.mtu === null) add({ ...c, what: `${c.what} (in the underlay of ${label})` });
      add(tunnelConstraint(label, added[0].relation ? 'relation:' + added[0].relation : `iface:${h.device}:${h.egress}`, min, layers, os));
    } else if (added.length) {
      // a declared underlay (its `over` cables, not traced): the outer packet crosses them; the tunnel's source interface sends it
      const { layers, os } = layersOf(model, h, added, v);
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
      add(tunnelConstraint(label, added[0].relation ? 'relation:' + added[0].relation : `iface:${h.device}:${h.egress}`, min, layers, os));
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

function resultOf(model: Model, p: Path, index: number, v: 4 | 6): PathMtuResult {
  const { constraints, overheads } = pathConstraints(model, p, 0, v);
  const known = constraints.filter((c) => c.mtu !== null) as Array<MtuConstraint & { mtu: number }>;
  const limiting = known.length ? known.reduce((a, b) => (b.mtu < a.mtu ? b : a)) : undefined;
  const out: PathMtuResult = { index, mtu: limiting ? limiting.mtu : null, unknown: constraints.filter((c) => c.mtu === null), overheads, constraints, assumed: overheads.filter((o) => o.assumed).map((o) => o.layer) };
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
  const forward = t.paths.map((p, i) => ({ p, i })).filter((x) => ends(x.p)).map((x) => resultOf(model, x.p, x.i, v));
  const back = c.reverse ? c.reverse.trace : null;
  const reverse = back && !back.error ? back.paths.map((p, i) => ({ p, i })).filter((x) => ends(x.p)).map((x) => resultOf(model, x.p, x.i, v)) : [];
  const out: PathMtu = { family: v, forward, reverse, mtu: null, payload: null, verdict: 'unsupported', text: '', differs: [], assumptions: [] };
  out.assumptions.push('An interface’s MTU is the one written in the model (an aggregate: the smallest of it and its members); one not written is not known, never taken as 1500.');
  out.assumptions.push('Encapsulation sizes are the formats the simulation uses too (one definition), with the outer header of the tunnel’s family; an encapsulation without a known format is taken as GRE, which makes the limit an estimate.');
  const formats = new Set<string>();
  for (const r of forward.concat(reverse)) for (const o of r.overheads) formats.add(o.assumes);
  for (const f of formats) out.assumptions.push('Assumed format: ' + f + '.');
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
  const assumed = Array.from(new Set(all.flatMap((r) => r.assumed)));
  const lim = all.filter((r) => r.mtu === out.mtu).map((r) => r.limiting).find((x) => !!x);
  if (out.mtu === null) {
    out.verdict = 'indeterminate';
    out.text = `The path MTU is not known: no MTU is written on the way (${unknown} interface${unknown === 1 ? '' : 's'} or tunnel${unknown === 1 ? '' : 's'} without one)`;
  } else if (assumed.length) {
    out.verdict = 'indeterminate';
    out.text = `About ${out.mtu} bytes (limited by ${lim ? lim.what : 'a component'}): the format of ${assumed.join(', ')} is not known and is taken as GRE`;
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

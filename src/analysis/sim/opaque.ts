/**
 * Illustrative data on the non-IP interconnects (model/interconnect.ts),
 * apart from everything IP: no Ethernet, IP or transport header is made, no
 * protocol of the interconnect is simulated — no enumeration, addressing,
 * arbitration, collision, framing, acknowledgment or timing. A transfer is
 * abstract data moved along the modelled connections, on the simulation's
 * clock, so the diagram can show which ports it reaches and why not.
 *
 *   A transfer: an initiator (the attachment that starts it), a data source
 *   (where the data comes from: the initiator, or for a controller's read a
 *   target), the recipients, an illustrative size, and Count / Interval.
 *   Each recipient's way is found over the interconnects and the explicit
 *   transit groups of Systems (model/types.ts OpaqueTransit), nothing else:
 *   not a chassis, a device or a technology name. Every hop follows the
 *   access model's rule (model/interconnect.ts hopRule): the sender sends,
 *   the recipient receives, a controller initiates (one end of the data
 *   its own), peers send their own data; a hop after a transit is started
 *   by the forwarding port. A transfer is one direction: nothing answers,
 *   whatever "both" says.
 *   When a hop is due it needs its devices on (a transit device too), its
 *   ports not shut, its attachment not detached and its interconnect not
 *   failed; otherwise the data stops there and the result says why. A
 *   passive interconnect has no power state of its own.
 *   Each hop takes OPAQUE_HOP_MS of simulated time — a display parameter of
 *   the model, never a prediction of throughput or latency.
 *
 * Its dots are the physical view's only (the logical view has no
 * interconnects): along a point-to-point line, or up a bus's tap and down
 * the recipient's. DOM-free.
 */
import { IcAttachment, Interconnect, Model } from '../../model/types';
import { DATA_TEXT, ROLE_TEXT, hopRule, receives, sends, technologyText } from '../../model/interconnect';
import type { Engine } from './engine';
import { Flight, Msg } from './types';

/** One hop of illustrative data, in simulated ms: a display parameter of the model (no timing is predicted). */
export const OPAQUE_HOP_MS = 1;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface OpaqueSpec {
  /** "device:port" of the attachment that starts the transfer */
  initiator: string;
  /** "device:port" where the data comes from */
  from: string;
  /** "device:port" of each recipient */
  to: string[];
  count: number;
  /** ms between two transfers of the series */
  interval: number;
  /** illustrative payload size in bytes (shown only) */
  size: number;
}

/** One hop: on an interconnect, from an attachment to another, started by an initiator (after a transit: the forwarding device). */
export interface OpaqueHop {
  ic: Interconnect;
  from: IcAttachment;
  to: IcAttachment;
  initiator: IcAttachment;
  /** the System it crossed to reach this hop's interconnect (its transit group) */
  via?: string;
}

/** What became of one transfer to one recipient. */
export interface OpaqueDelivery {
  n: number;
  to: string;
  t: number;
  /** null: on its way */
  ok: boolean | null;
  why: string;
  path: string;
  flights: number[];
  ended?: number;
}

export interface OpaqueRun {
  id: number;
  spec: OpaqueSpec;
  t0: number;
  sent: number;
  deliveries: OpaqueDelivery[];
  stopped: boolean;
  stoppedAt?: number;
  /** the id its dots and log lines carry (the foreground of the display, as a Send network packets' messages) */
  traffic: number;
}

/** What the inspector shows of an illustrative dot: no layers, these rows, and the notice. */
export interface OpaqueInfo {
  title: string;
  rows: Array<[string, string]>;
  notice: string;
}

export const OPAQUE_NOTICE = 'Illustrative traffic — protocol behaviour not simulated.';

export class OpaqueSim {
  /** failed interconnects (a point-to-point connection, a bus segment) */
  readonly failed = new Set<string>();
  /** detached attachments, "interconnect|device:port" */
  readonly detached = new Set<string>();
  /** opaque ports shut (administratively down), "device:port" */
  readonly shut = new Set<string>();
  readonly runs: OpaqueRun[] = [];
  /** the inspector's rows of each dot, by flight id */
  readonly info = new Map<number, OpaqueInfo>();
  private seq = 0;

  constructor(
    private e: Engine,
    private m: Model,
    private reserveId: () => number,
  ) {}

  /** A port's attachment: its interconnect and how it is attached; null when it is on none. */
  attachment(key: string): { ic: Interconnect; a: IcAttachment } | null {
    const id = this.m.index.portInterconnect.get(key);
    const ic = id ? this.m.index.interconnects.get(id) : undefined;
    const a = ic ? ic.endpoints.find((x) => `${x.device}:${x.port}` === key) : undefined;
    return ic && a ? { ic, a } : null;
  }

  /**
   * The way from a data source to a recipient (fewest hops, deterministic):
   * along interconnects and through explicit transit groups only. Every hop
   * checked by its interconnect's rule; a string says why there is none.
   */
  route(from: string, to: string, initiator: string): OpaqueHop[] | string {
    const src = this.attachment(from);
    if (!src) return `${from} is on no interconnect`;
    const init = this.attachment(initiator);
    if (!init) return `the initiator ${initiator} is on no interconnect`;
    if (!this.attachment(to)) return `${to} is on no interconnect`;
    if (init.ic.id !== src.ic.id) return `the initiator ${initiator} is not on ${src.ic.id}, the data source's interconnect`;
    type State = { at: { ic: Interconnect; a: IcAttachment }; hops: OpaqueHop[]; via?: string };
    const seen = new Set<string>([from]);
    let layer: State[] = [{ at: src, hops: [] }];
    for (let depth = 0; depth < 32 && layer.length; depth++) {
      const next: State[] = [];
      for (const st of layer) {
        const others = st.at.ic.endpoints.filter((x) => x !== st.at.a).sort((x, y) => cmp(`${x.device}:${x.port}`, `${y.device}:${y.port}`));
        for (const b of others) {
          const hop: OpaqueHop = { ic: st.at.ic, from: st.at.a, to: b, initiator: st.hops.length ? st.at.a : init.a, via: st.via };
          const key = `${b.device}:${b.port}`;
          if (key === to) {
            const path = st.hops.concat([hop]);
            for (const h of path) {
              const why = hopRule(h.ic, h.from, h.to, h.initiator);
              if (why) return why;
            }
            return path;
          }
          // through a System's transit group: on from the group's other ports (the same technology, never converted)
          const dev = this.m.index.devices.get(b.device);
          const group = dev ? dev.opaqueTransit.find((g) => g.ports.indexOf(b.port) >= 0) : undefined;
          if (!group) continue;
          for (const p of group.ports.slice().sort(cmp)) {
            const k = `${b.device}:${p}`;
            if (p === b.port || seen.has(k)) continue;
            const on = this.attachment(k);
            if (!on) continue;
            seen.add(k);
            next.push({ at: on, hops: st.hops.concat([hop]), via: b.device });
          }
        }
      }
      layer = next;
    }
    return `no modelled connection from ${from} to ${to} (interconnects and explicit transit groups only)`;
  }

  /** Why a hop can't be taken now (null: it can): devices on, ports not shut, attachments in place, the interconnect not failed. */
  private blocked(h: OpaqueHop): string | null {
    const k = (a: IcAttachment): string => `${a.device}:${a.port}`;
    if (this.failed.has(h.ic.id)) return `the interconnect ${h.ic.id} is failed`;
    for (const a of [h.from, h.to]) {
      if (!this.e.deviceOn(a.device)) return `${a.device} is powered off`;
      if (this.shut.has(k(a))) return `${k(a)} is shut`;
      if (this.detached.has(`${h.ic.id}|${k(a)}`)) return `${k(a)} is detached from ${h.ic.id}`;
    }
    return null;
  }

  /** Send illustrative data: a series of transfers (Count, Interval) to each recipient; refused: why. */
  start(spec: OpaqueSpec): OpaqueRun | string {
    if (!this.attachment(spec.from)) return `${spec.from || 'the data source'} is on no interconnect`;
    if (!spec.to.length) return 'choose a recipient';
    if (!(spec.count >= 1)) return 'the count is at least 1';
    const run: OpaqueRun = { id: ++this.seq, spec, t0: this.e.now, sent: 0, deliveries: [], stopped: false, traffic: this.reserveId() };
    this.runs.push(run);
    for (let n = 0; n < spec.count; n++) {
      this.e.at(this.e.now + n * Math.max(0, spec.interval), () => {
        if (run.stopped) return;
        run.sent++;
        for (const to of spec.to) this.transfer(run, n, to);
      });
    }
    return run;
  }

  /** Stop a series: what is not sent yet is not sent; what is on its way arrives or stops on its own. */
  stop(id: number): boolean {
    const r = this.runs.find((x) => x.id === id);
    if (!r || r.stopped || r.sent >= r.spec.count) return false;
    r.stopped = true;
    r.stoppedAt = this.e.now;
    return true;
  }

  /** One transfer to one recipient: its way hop by hop, each hop checked when it is due. */
  private transfer(run: OpaqueRun, n: number, to: string): void {
    const s = run.spec;
    const d: OpaqueDelivery = { n, to, t: this.e.now, ok: null, why: '', path: '', flights: [] };
    run.deliveries.push(d);
    const r = this.route(s.from, to, s.initiator);
    const [fromDev] = s.from.split(':');
    const [toDev] = to.split(':');
    if (typeof r === 'string') {
      this.end(run, d, false, r);
      this.note('drop', fromDev, toDev, `Illustrative data ${n + 1} from ${s.from} to ${to} not sent: ${r}`, run);
      return;
    }
    d.path = [s.from].concat(r.map((h) => `${h.to.device}:${h.to.port}`)).join(' → ');
    this.note('message', fromDev, toDev, `Illustrative data ${n + 1} of ${s.count}: ${s.size} bytes from ${s.from} to ${to}, initiated by ${s.initiator} (${d.path}) — ${OPAQUE_NOTICE}`, run);
    let parent: number | undefined;
    const step = (k: number): void => {
      const h = r[k];
      const why = this.blocked(h);
      if (why) {
        this.end(run, d, false, `stopped at ${h.from.device}:${h.from.port}: ${why}`);
        this.note('drop', h.from.device, h.to.device, `Illustrative data ${n + 1} to ${to} stops at ${h.from.device}:${h.from.port}: ${why}`, run);
        return;
      }
      parent = this.draw(run, d, h, parent);
      // (the hop's arrival: the pacing holds it until its dot is there)
      const dot = parent;
      this.e.after(OPAQUE_HOP_MS, () => {
        if (k + 1 < r.length) step(k + 1);
        else {
          this.end(run, d, true, 'delivered along the modelled connection');
          this.note('message', toDev, fromDev, `Illustrative data ${n + 1} reached ${to}: delivered along the modelled connection (${d.path}) — ${OPAQUE_NOTICE}`, run);
        }
      }, [dot]);
    };
    step(0);
  }

  private end(run: OpaqueRun, d: OpaqueDelivery, ok: boolean, why: string): void {
    d.ok = ok;
    d.why = why;
    d.ended = this.e.now;
    void run;
  }

  /** A hop's dots: along the line (point to point), or up the sender's tap and down the recipient's (a bus). */
  private draw(run: OpaqueRun, d: OpaqueDelivery, h: OpaqueHop, parent: number | undefined): number {
    const s = run.spec;
    const fk = `${h.from.device}:${h.from.port}`;
    const tk = `${h.to.device}:${h.to.port}`;
    const label = `${technologyText(h.ic)} data · ${s.size} B`;
    const msg = (): Msg => ({ protocol: 'opaque' as Msg['protocol'], type: 'Illustrative data', label, detail: `${fk} → ${tk} on ${h.ic.id}`, data: { from: h.from.device }, test: run.traffic, sender: s.from.split(':')[0], origin: s.initiator.split(':')[0] });
    const ref = 'interconnect:' + h.ic.id;
    const t0 = this.e.now;
    const info: OpaqueInfo = {
      title: `Illustrative data on ${h.ic.id}`,
      rows: [
        ['Technology', technologyText(h.ic) + (h.ic.protocol ? ` (carrying ${h.ic.protocol.name}${h.ic.protocol.version ? ' ' + h.ic.protocol.version : ''})` : '')],
        ['Initiated by', `${s.initiator} (${ROLE_TEXT[h.initiator.role].toLowerCase()})`],
        ['Data', `from ${s.from} to ${d.to}, ${s.size} bytes (illustrative)`],
        ['This hop', `${fk} (${DATA_TEXT[h.from.data].toLowerCase()}) → ${tk} (${DATA_TEXT[h.to.data].toLowerCase()})${h.via ? `, after crossing ${h.via}'s transit` : ''}`],
        ['Way', d.path],
        ['Decision', `allowed: ${fk} ${sends(h.from) ? 'sends' : '—'}, ${tk} ${receives(h.to) ? 'receives' : '—'}; ${h.ic.access === 'peer' ? 'peers send their own data' : `the controller ${h.initiator.device}:${h.initiator.port} initiates`}`],
      ],
      notice: OPAQUE_NOTICE,
    };
    const add = (f: Flight): number => {
      this.info.set(f.id, info);
      d.flights.push(f.id);
      return f.id;
    };
    if (h.ic.topology === 'point_to_point') return add(this.e.flight(t0, t0 + OPAQUE_HOP_MS, msg(), 'physical', { ref, from: fk, to: tk }, parent));
    const up = add(this.e.flight(t0, t0 + OPAQUE_HOP_MS / 2, msg(), 'physical', { ref, from: fk, to: 'bus' }, parent));
    return add(this.e.flight(t0 + OPAQUE_HOP_MS / 2, t0 + OPAQUE_HOP_MS, msg(), 'physical', { ref, from: 'bus', to: tk }, up));
  }

  private note(kind: 'message' | 'drop', dev: string, peer: string, detail: string, run: OpaqueRun): void {
    this.e.withTest(run.traffic, () => this.e.note(kind, 'opaque', dev, peer, kind === 'drop' ? 'not delivered' : 'Illustrative data', '', detail));
  }

  // ------------------------------------------------------------ failures (each with its way back)

  /** Fail an interconnect (a point-to-point connection, a bus segment): nothing crosses it until restored. */
  failInterconnect(id: string): string | null {
    if (!this.m.index.interconnects.has(id)) return `no interconnect ${id}`;
    if (this.failed.has(id)) return `${id} is failed already`;
    this.failed.add(id);
    this.e.note('state', 'opaque', '', '', 'interconnect failed', 'failed', `The interconnect ${id} is failed: no illustrative data crosses it (no electrical fault beyond it is inferred)`);
    return null;
  }

  restoreInterconnect(id: string): boolean {
    if (!this.failed.delete(id)) return false;
    this.e.note('state', 'opaque', '', '', 'interconnect restored', 'up', `The interconnect ${id} is restored`);
    return true;
  }

  /** Detach a participant from its interconnect (an attachment failure): that port alone is disconnected. */
  detach(key: string): string | null {
    const at = this.attachment(key);
    if (!at) return `${key} is on no interconnect`;
    const k = `${at.ic.id}|${key}`;
    if (this.detached.has(k)) return `${key} is detached already`;
    this.detached.add(k);
    this.e.note('state', 'opaque', key.split(':')[0], '', 'detached', 'detached', `${key} is detached from ${at.ic.id}: it sends and receives nothing there; the others go on`);
    return null;
  }

  reattach(key: string): boolean {
    const at = this.attachment(key);
    if (!at || !this.detached.delete(`${at.ic.id}|${key}`)) return false;
    this.e.note('state', 'opaque', key.split(':')[0], '', 'attached', 'attached', `${key} is attached to ${at.ic.id} again`);
    return true;
  }

  /** Shut an opaque port (administratively down) / bring it up again. */
  shutPort(key: string): string | null {
    if (!this.m.index.opaquePorts.has(key)) return `${key} is no opaque port`;
    if (this.shut.has(key)) return `${key} is shut already`;
    this.shut.add(key);
    this.e.note('state', 'opaque', key.split(':')[0], '', 'port shut', 'shut', `The opaque port ${key} is shut`);
    return null;
  }

  noShutPort(key: string): boolean {
    if (!this.shut.delete(key)) return false;
    this.e.note('state', 'opaque', key.split(':')[0], '', 'port up', 'up', `The opaque port ${key} is up again`);
    return true;
  }
}

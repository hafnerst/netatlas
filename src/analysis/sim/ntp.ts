/**
 * NTP's synchronization state in the simulation, kept apart from PTP
 * (ptp.ts): the requests and responses themselves are the NTP sessions'
 * (proto-other.ts, the service behaviour: a client request every poll
 * interval, its server's response); this module follows what they mean.
 *
 * A device with the NTP service and its own stratum serves time at that
 * stratum from a reference clock of its own (taken as given: no reference
 * clock is simulated). One with upstreams starts unsynchronized: it serves
 * stratum 16 (an alarm: no client takes time from it) until a response
 * comes from an upstream whose stratum (in the response: what that server
 * knew when it answered) is below 15; then it is synchronized to that
 * upstream, its stratum one more than the one the response said (an
 * upstream at 15 would make it 16: no time to give, RFC 5905's MAXSTRAT,
 * so that one is not usable). A client
 * knows its upstreams only by their responses — the stratum each last
 * reported and when — never by reading a server's state. A response of its
 * source that is no longer usable (it reports 15 or 16: it lost its own
 * time) ends the synchronization at once; so does no response from its
 * source for 8 poll intervals (an NTP reach register gone to zero, RFC
 * 5905). Then it takes the next upstream whose last response, still fresh
 * (within those 8 polls), was usable — the lowest stratum, then the
 * configured order — else it is unsynchronized until one answers.
 *
 * One definition of the state everywhere (status, Show NTP status, what it
 * serves, the analysis snapshot, experiment observations):
 * `synchronized(dev)` — powered on, and a reference clock of its own or a
 * source that makes its stratum below 16. A device powered off serves
 * nothing and is not synchronized; it forgets what its upstreams said (it
 * starts over when it boots). A relation's client (an
 * ntp relation without the service) has the same state. Not modelled:
 * clock filtering, selection and discipline (no offset, jitter or accuracy
 * is computed), leap seconds, authentication, NTP's own symmetric modes.
 * NTP and PTP never discipline each other.
 */
import { compareAddr } from '../ipmath';
import { parseAddress } from '../../model/ip';
import { durationText } from './params';
import { ProtocolSim } from './protocols';
import { GridTable, SessionStatus } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** polls without an answer after which a source is unreachable (an 8-bit reach register) */
export const NTP_REACH = 8;

export interface NtpState {
  dev: string;
  /** a stratum of its own (a reference clock), when configured */
  own?: number;
  /** its configured upstreams (addresses), and the device each is, when the model has it */
  /** its upstreams: the address, the device it is (when the model has it), its last response and the stratum that response reported */
  upstreams: Array<{ addr: string; dev: string | null; last?: number; stratum?: number }>;
  /** the upstream it is synchronized to now, and since when */
  source?: string;
  since?: number;
  /** when it lost its source, and why */
  lost?: { at: number; why: string };
  /** bumped when its source changes: an older reach check does nothing */
  gen: number;
}

/** The highest stratum a usable server reports: one more makes 16, unsynchronized (RFC 5905: MAXSTRAT 16). */
const USABLE_STRATUM = 14;

export class NtpSim {
  readonly devs = new Map<string, NtpState>();

  constructor(private P: ProtocolSim) {
    P.shared.set('ntp', this);
    for (const d of P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      const s = d.appServices ? d.appServices.get('ntp') : undefined;
      if (!s) continue;
      const ups = Array.isArray(s.values.upstreams) ? (s.values.upstreams as string[]) : [];
      this.devs.set(d.id, { dev: d.id, own: typeof s.values.stratum === 'number' ? (s.values.stratum as number) : undefined, upstreams: ups.map((a) => ({ addr: a, dev: this.owner(a) })), gen: 0 });
    }
    P.handlers.set('ntp', (dev, _l3, msg) => {
      const d = (msg.data || {}) as { from?: string; stratum?: number };
      if (msg.type === 'Server response') this.answered(dev, String(d.from || ''), typeof d.stratum === 'number' ? d.stratum : 16);
      // (the session behaviour goes on with it)
      return false;
    });
    P.deviceHooks.push((dev, up) => {
      const st = this.devs.get(dev);
      if (!st || up) return;
      // powered off: no source, and nothing of what its upstreams said (it starts over when it boots)
      for (const u of st.upstreams) {
        u.last = undefined;
        u.stratum = undefined;
      }
      if (st.source) this.lose(st, `${dev} was powered off`, false);
    });
  }

  private owner(addr: string): string | null {
    const a = parseAddress(addr);
    if (!a) return null;
    for (const d of this.P.m.devices) for (const i of d.interfaces.concat(d.logical)) for (const x of i.addresses) {
      const b = parseAddress(x.replace(/\/\d+$/, ''));
      if (b && compareAddr(a, b) === 0) return d.id;
    }
    return null;
  }

  /** A device's stratum as it knows it now: its own, one more than its source's last response said, else 16 (unsynchronized); 16 while it is off. */
  stratum(dev: string): number {
    const st = this.devs.get(dev);
    if (!st || !this.P.e.deviceOn(dev)) return 16;
    if (st.own !== undefined) return st.own;
    if (!st.source) return 16;
    const src = st.upstreams.find((u) => u.addr === st.source);
    return src && src.stratum !== undefined ? Math.min(16, src.stratum + 1) : 16;
  }

  /** Is a device synchronized now (the one definition: status, tables, what it serves, the snapshot)? Powered on, with a stratum below 16. */
  synchronized(dev: string): boolean {
    return this.devs.has(dev) && this.stratum(dev) < 16;
  }

  /** The stratum a server puts in its response: what it knows itself (its own state, never its upstreams'). */
  responseStratum(dev: string): number {
    return this.stratum(dev);
  }

  /** The poll interval: the NTP sessions' demonstration interval (NTPv4's minimum poll, 64 s). */
  private poll(_dev: string): number {
    return 64000;
  }

  /** A server's response reached its client: what it says (its stratum) is all the client knows of it. */
  private answered(client: string, server: string, stratum: number): void {
    let st = this.devs.get(client);
    if (!st) {
      // a relation's client without the service: it has the same state
      st = { dev: client, upstreams: [{ addr: server, dev: server }], gen: 0 };
      this.devs.set(client, st);
    }
    const u = st.upstreams.find((x) => x.dev === server);
    if (!u) return;
    u.last = this.P.e.now;
    u.stratum = stratum;
    if (st.own !== undefined) return;
    if (stratum > USABLE_STRATUM) {
      // the server has no time to give: at 16 it is unsynchronized itself, at 15 it would make this client 16
      const why = stratum >= 16 ? `it is unsynchronized itself` : `one more would be stratum 16`;
      if (st.source === u.addr) this.lose(st, `its source ${server} answers at stratum ${stratum} (${why})`);
      else if (!st.source) this.P.e.note('state', 'ntp', client, server, 'not synchronized', 'unsynchronized', `${client}: ${server} answers at stratum ${stratum} (${why}): no time to take from it`);
      return;
    }
    if (st.source === u.addr) return;
    if (st.source) {
      const cur = st.upstreams.find((x) => x.addr === st!.source);
      if (cur && cur.last !== undefined && this.P.e.now - cur.last < NTP_REACH * this.poll(client)) return;
    }
    this.select(st, u, `stratum ${stratum} in its response`);
  }

  /** The client takes an upstream as its source (it answered usably). */
  private select(st: NtpState, u: NtpState['upstreams'][number], why: string): void {
    st.source = u.addr;
    st.since = this.P.e.now;
    st.lost = undefined;
    st.gen++;
    this.P.e.note('state', 'ntp', st.dev, u.dev || '', 'synchronized', 'synchronized', `${st.dev} is synchronized to ${u.dev || u.addr} (${u.addr}, ${why}): it serves stratum ${this.stratum(st.dev)} now (no offset or accuracy is computed: NTP's clock discipline is not modelled)`);
    this.watch(st);
  }

  /** Its source unanswered for the reach register's 8 polls: unsynchronized again. */
  private watch(st: NtpState): void {
    const src = st.source;
    const gen = st.gen;
    const limit = NTP_REACH * this.poll(st.dev);
    const u0 = st.upstreams.find((x) => x.addr === src);
    // (checked when the 8 polls since its last answer are over)
    const at = u0 && u0.last !== undefined ? u0.last + limit : this.P.e.now + limit;
    this.P.e.at(Math.max(this.P.e.now, at), () => {
      if (st.source !== src || st.gen !== gen) return;
      const u = st.upstreams.find((x) => x.addr === src);
      if (u && u.last !== undefined && this.P.e.now - u.last < limit) {
        this.watch(st);
        return;
      }
      this.lose(st, `no response from ${src} for ${NTP_REACH} polls (${durationText(limit)})`);
    });
  }

  /**
   * Its source is gone: the next upstream whose last response is fresh
   * (within the reach register's 8 polls) and was usable becomes its source
   * — the lowest stratum, then the configured order; else it is
   * unsynchronized (and serves stratum 16) until one answers.
   */
  private lose(st: NtpState, why: string, fallback = true): void {
    const was = st.source;
    st.source = undefined;
    st.gen++;
    st.lost = { at: this.P.e.now, why };
    const limit = NTP_REACH * this.poll(st.dev);
    const next = fallback
      ? st.upstreams
          .filter((u) => u.addr !== was && u.dev && u.last !== undefined && this.P.e.now - u.last < limit && u.stratum !== undefined && u.stratum <= USABLE_STRATUM)
          .sort((a, b) => (a.stratum as number) - (b.stratum as number))[0]
      : undefined;
    if (next) {
      this.P.e.note('state', 'ntp', st.dev, next.dev || '', 'source lost', 'synchronized', `${st.dev} loses its source ${was}: ${why}; it takes ${next.dev} (${next.addr}), whose last response ${durationText(this.P.e.now - (next.last as number))} ago said stratum ${next.stratum}`);
      this.select(st, next, `its last response, ${durationText(this.P.e.now - (next.last as number))} ago, said stratum ${next.stratum}`);
      return;
    }
    this.P.e.note('state', 'ntp', st.dev, '', 'unsynchronized', 'unsynchronized', `${st.dev} is unsynchronized: ${why}; it serves stratum 16 until an upstream answers again`);
  }

  /** A device's NTP state in a few words. */
  text(dev: string): string {
    const st = this.devs.get(dev);
    if (!st) return '';
    if (!this.P.e.deviceOn(dev)) return 'powered off: it serves no time';
    if (st.own !== undefined) return `serving time at stratum ${st.own} (its own reference clock, taken as given)`;
    if (this.synchronized(dev)) return `synchronized to ${st.source} since t = ${Math.round((st.since as number) / 100) / 10} s; serving stratum ${this.stratum(dev)}`;
    const outside = st.upstreams.filter((u) => !u.dev).map((u) => u.addr);
    return `unsynchronized (stratum 16)${st.lost ? `: ${st.lost.why}` : ': no usable upstream answered yet'}${outside.length ? `; ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the model (not simulated)` : ''}`;
  }

  private status(): SessionStatus[] {
    return Array.from(this.devs.values()).map((st) => {
      const ok = this.synchronized(st.dev);
      return { protocol: 'ntp', name: `NTP ${st.dev}`, device: st.dev, peer: ok && st.source ? st.upstreams.find((u) => u.addr === st.source)?.dev || '' : '', state: ok ? 'Synchronized' : 'Unsynchronized', up: ok, detail: this.text(st.dev) };
    });
  }

  install(): void {
    this.P.extraStatus.push(() => this.status());
  }

  /** Show NTP status: its role, its upstreams with their last answer, its source and stratum. */
  table(dev: string): GridTable {
    const st = this.devs.get(dev);
    const now = this.P.e.now;
    // (what its responses said: a client knows nothing else of an upstream)
    const rows = st ? st.upstreams.map((u) => [u.addr, u.dev || '(outside the model)', u.last !== undefined ? `${durationText(now - u.last)} ago` : 'never', u.stratum !== undefined ? String(u.stratum) : '—', st.source === u.addr ? 'its source' : '']) : [];
    return { caption: `NTP of ${dev}`, cols: ['Upstream', 'Device', 'Last answer', 'Stratum it reported', ''], rows, empty: st && st.own !== undefined ? 'A reference: it asks no upstream.' : 'No upstream.', timers: [], notes: st ? [`${dev}: ${this.text(dev)}.`, `Unreachable after ${NTP_REACH} polls without an answer (the demonstration poll interval is 64 s, NTP's minimum).`] : [] };
  }

  /** Is there an NTP state to show for the device? */
  has(dev: string): boolean {
    return this.devs.has(dev);
  }

  /** (for the details) the addresses of its upstreams */
  upstreamText(dev: string): string {
    const st = this.devs.get(dev);
    return st ? st.upstreams.map((u) => u.addr + (u.dev ? ` (${u.dev})` : '')).join(', ') : '';
  }
}


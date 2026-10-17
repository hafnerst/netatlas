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
 * comes from an upstream that is itself usable (a reference or
 * synchronized); then it is synchronized to that upstream, its stratum one
 * more. Without a response from its source for 8 poll intervals (an NTP
 * reach register gone to zero, RFC 5905) it is unsynchronized again and
 * tries the next usable upstream that answers. A relation's client (an
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
  upstreams: Array<{ addr: string; dev: string | null; last?: number }>;
  /** the upstream it is synchronized to now, and since when */
  source?: string;
  since?: number;
  /** when it lost its source, and why */
  lost?: { at: number; why: string };
}

export class NtpSim {
  readonly devs = new Map<string, NtpState>();

  constructor(private P: ProtocolSim) {
    for (const d of P.m.devices.slice().sort((x, y) => cmp(x.id, y.id))) {
      const s = d.appServices ? d.appServices.get('ntp') : undefined;
      if (!s) continue;
      const ups = Array.isArray(s.values.upstreams) ? (s.values.upstreams as string[]) : [];
      this.devs.set(d.id, { dev: d.id, own: typeof s.values.stratum === 'number' ? (s.values.stratum as number) : undefined, upstreams: ups.map((a) => ({ addr: a, dev: this.owner(a) })) });
    }
    P.handlers.set('ntp', (dev, _l3, msg) => {
      if (msg.type === 'Server response') this.answered(dev, String((msg.data as { from?: string }).from || ''));
      // (the session behaviour goes on with it)
      return false;
    });
    P.deviceHooks.push((dev, up) => {
      const st = this.devs.get(dev);
      if (st && !up && st.source) this.lose(st, `${dev} was powered off`);
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

  /** A device's stratum now: its own, one more than its source's, else 16 (unsynchronized). */
  stratum(dev: string): number {
    const st = this.devs.get(dev);
    if (!st) return 16;
    if (st.own !== undefined) return st.own;
    if (!st.source) return 16;
    const src = st.upstreams.find((u) => u.addr === st.source);
    return src && src.dev ? Math.min(16, this.stratum(src.dev) + 1) : 16;
  }

  /** Does a device serve usable time (a reference, or synchronized), and is it powered on? */
  usable(dev: string): boolean {
    return this.P.e.deviceOn(dev) && this.stratum(dev) < 16;
  }

  /** The poll interval: the NTP sessions' demonstration interval (NTPv4's minimum poll, 64 s). */
  private poll(_dev: string): number {
    return 64000;
  }

  private answered(client: string, server: string): void {
    let st = this.devs.get(client);
    if (!st) {
      // a relation's client without the service: it has the same state
      st = { dev: client, upstreams: [{ addr: server, dev: server }] };
      this.devs.set(client, st);
    }
    const u = st.upstreams.find((x) => x.dev === server);
    if (!u) return;
    u.last = this.P.e.now;
    if (st.own !== undefined) return;
    const ok = this.usable(server);
    if (!ok) {
      if (!st.source) this.P.e.note('state', 'ntp', client, server, 'not synchronized', 'unsynchronized', `${client}: ${server} answers at stratum 16 (it is unsynchronized itself): no time to take from it`);
      return;
    }
    if (st.source === u.addr) return;
    if (st.source) {
      const cur = st.upstreams.find((x) => x.addr === st!.source);
      if (cur && cur.last !== undefined && this.P.e.now - cur.last < NTP_REACH * this.poll(client)) return;
    }
    st.source = u.addr;
    st.since = this.P.e.now;
    st.lost = undefined;
    this.P.e.note('state', 'ntp', client, server, 'synchronized', 'synchronized', `${client} is synchronized to ${server} (${u.addr}, stratum ${this.stratum(server)}): it serves stratum ${this.stratum(client)} now (no offset or accuracy is computed: NTP's clock discipline is not modelled)`);
    this.watch(st);
  }

  /** Its source unanswered for the reach register's 8 polls: unsynchronized again. */
  private watch(st: NtpState): void {
    const src = st.source;
    const limit = NTP_REACH * this.poll(st.dev);
    const u0 = st.upstreams.find((x) => x.addr === src);
    // (checked when the 8 polls since its last answer are over)
    const at = u0 && u0.last !== undefined ? u0.last + limit : this.P.e.now + limit;
    this.P.e.at(Math.max(this.P.e.now, at), () => {
      if (st.source !== src) return;
      const u = st.upstreams.find((x) => x.addr === src);
      if (u && u.last !== undefined && this.P.e.now - u.last < limit) {
        this.watch(st);
        return;
      }
      this.lose(st, `no response from ${src} for ${NTP_REACH} polls (${durationText(limit)})`);
    });
  }

  private lose(st: NtpState, why: string): void {
    st.source = undefined;
    st.lost = { at: this.P.e.now, why };
    this.P.e.note('state', 'ntp', st.dev, '', 'unsynchronized', 'unsynchronized', `${st.dev} is unsynchronized: ${why}; it serves stratum 16 until an upstream answers again`);
  }

  /** A device's NTP state in a few words. */
  text(dev: string): string {
    const st = this.devs.get(dev);
    if (!st) return '';
    if (st.own !== undefined) return `serving time at stratum ${st.own} (its own reference clock, taken as given)`;
    if (st.source) return `synchronized to ${st.source} since t = ${Math.round((st.since as number) / 100) / 10} s; serving stratum ${this.stratum(dev)}`;
    const outside = st.upstreams.filter((u) => !u.dev).map((u) => u.addr);
    return `unsynchronized (stratum 16)${st.lost ? `: ${st.lost.why}` : ': no usable upstream answered yet'}${outside.length ? `; ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the model (not simulated)` : ''}`;
  }

  private status(): SessionStatus[] {
    return Array.from(this.devs.values()).map((st) => ({ protocol: 'ntp', name: `NTP ${st.dev}`, device: st.dev, peer: st.source ? st.upstreams.find((u) => u.addr === st.source)?.dev || '' : '', state: st.own !== undefined || st.source ? 'Synchronized' : 'Unsynchronized', up: st.own !== undefined || !!st.source, detail: this.text(st.dev) }));
  }

  install(): void {
    this.P.extraStatus.push(() => this.status());
  }

  /** Show NTP status: its role, its upstreams with their last answer, its source and stratum. */
  table(dev: string): GridTable {
    const st = this.devs.get(dev);
    const now = this.P.e.now;
    const rows = st ? st.upstreams.map((u) => [u.addr, u.dev || '(outside the model)', u.last !== undefined ? `${durationText(now - u.last)} ago` : 'never', u.dev ? String(this.stratum(u.dev)) : '—', st.source === u.addr ? 'its source' : '']) : [];
    return { caption: `NTP of ${dev}`, cols: ['Upstream', 'Device', 'Last answer', 'Its stratum', ''], rows, empty: st && st.own !== undefined ? 'A reference: it asks no upstream.' : 'No upstream.', timers: [], notes: st ? [`${dev}: ${this.text(dev)}.`, `Unreachable after ${NTP_REACH} polls without an answer (the demonstration poll interval is 64 s, NTP's minimum).`] : [] };
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


/**
 * The byte stream of one TCP connection end (RFC 9293 §3.3): its send and
 * receive sequence state, what a segment carries, what an acknowledgment
 * covers, and when a message the application wrote has arrived whole.
 * Pure and DOM-free; transport.ts sends and receives the segments.
 *
 * Send side: ISS, SND.UNA (the oldest unacknowledged sequence number) and
 * SND.NXT (the next one to send). The SYN and the FIN take one sequence
 * number each; data takes one per byte. Every segment keeps the sequence
 * range it was first sent with: a retransmission sends the same range
 * again (a smaller path MTU splits it, never moves it). An acknowledgment
 * is cumulative: it covers everything below its number; one of something
 * never sent, or one at or below SND.UNA, acknowledges nothing new.
 *
 * Receive side: IRS and RCV.NXT (the next sequence number expected). A
 * segment below RCV.NXT is a duplicate (acknowledged again, delivered
 * never); one above it waits in the out-of-order queue until the gap is
 * filled; the acknowledgment always says RCV.NXT. A message the
 * application wrote (an MQTT packet, a BGP UPDATE, a request) is marked at
 * its last byte: it is delivered once, in order, when RCV.NXT passes that
 * byte — never twice, never before its bytes have all arrived.
 *
 * Simplified (the simulation's abstraction, docs/LIMITATIONS.md): no
 * receive window or flow control and no congestion control — every
 * segment of a write is sent at once; no fast retransmit or SACK (a lost
 * segment waits for the retransmission timer, which sends the earliest
 * unacknowledged segment); no urgent data or options other than the MSS
 * the path MTU gives; sequence numbers do not wrap (the ISS is below 2^31
 * and a simulated connection carries far less than 2 GB).
 */

/** A message the application wrote, marked at its last byte. */
export interface StreamMark<M> {
  /** the application's own number of it (one per connection end) */
  id: number;
  /** the sequence number after its last byte */
  end: number;
  msg: M;
}

/** A segment as sent (or received): its sequence range and what it carries. */
export interface Seg<M> {
  seq: number;
  /** data bytes (the SYN and FIN are not counted here) */
  len: number;
  syn?: boolean;
  fin?: boolean;
  /** the message that ends with this segment's last byte */
  mark?: StreamMark<M>;
  /** what it carries, in words (the log's) */
  what: string;
  /** how often it was sent again */
  sent: number;
}

/** The sequence space a segment takes: its bytes, and one each for SYN and FIN. */
export function segSpace(s: { len: number; syn?: boolean; fin?: boolean }): number {
  return s.len + (s.syn ? 1 : 0) + (s.fin ? 1 : 0);
}

/** What arrived: the acknowledgment to send, the messages now whole, the FIN. */
export interface Received<M> {
  /** the segment was (entirely) a duplicate of what had arrived already */
  dup: boolean;
  /** it is beyond RCV.NXT: kept until the gap before it is filled */
  outOfOrder: boolean;
  /** RCV.NXT after it: the acknowledgment number to send */
  ack: number;
  /** the messages that are whole now, in order, each once */
  msgs: Array<StreamMark<M>>;
  /** the peer's FIN is in order now (RCV.NXT moved past it) */
  fin: boolean;
  /** new data bytes in order */
  bytes: number;
}

export class TcpStream<M> {
  readonly iss: number;
  sndUna: number;
  sndNxt: number;
  irs: number | null = null;
  rcvNxt: number | null = null;
  /** sent, not yet entirely acknowledged, in sequence order */
  out: Array<Seg<M>> = [];
  /** received beyond RCV.NXT */
  private ooo: Array<Seg<M>> = [];
  /** messages delivered (their ids): nothing is delivered twice */
  private delivered = new Set<number>();
  /** the data bytes received in order */
  received = 0;
  /** the FIN of the peer arrived in order; this end's FIN was sent / acknowledged */
  finIn = false;
  finOut = false;
  finAcked = false;
  private nextMsg = 0;

  constructor(iss: number) {
    this.iss = iss;
    this.sndUna = iss;
    this.sndNxt = iss;
  }

  /** This end's SYN (the first segment it sends, sequence ISS): sent once, retransmitted as it is. */
  syn(what: string): Seg<M> {
    if (this.out.length && this.out[0].syn) return this.out[0];
    const s: Seg<M> = { seq: this.iss, len: 0, syn: true, what, sent: 0 };
    this.out.push(s);
    this.sndNxt = this.iss + 1;
    return s;
  }

  /** The peer's SYN arrived: its ISN is the receive side's start. */
  synIn(seq: number): void {
    if (this.irs !== null) return;
    this.irs = seq;
    this.rcvNxt = seq + 1;
  }

  /** Data the application writes: segments of at most `mss` bytes from SND.NXT, the last marked with the message. */
  write(bytes: number, mss: number, what: string, msg?: M): Array<Seg<M>> {
    const out: Array<Seg<M>> = [];
    const n = Math.max(1, Math.floor(bytes));
    const end = this.sndNxt + n;
    const mark: StreamMark<M> | undefined = msg !== undefined ? { id: ++this.nextMsg, end, msg } : undefined;
    for (let left = n; left > 0; left -= mss) {
      const len = Math.min(mss, left);
      const s: Seg<M> = { seq: this.sndNxt, len, what, sent: 0 };
      if (left <= mss && mark) s.mark = mark;
      this.sndNxt += len;
      out.push(s);
      this.out.push(s);
    }
    return out;
  }

  /** This end closes: a FIN after its data (one sequence number). */
  fin(what: string): Seg<M> {
    const s: Seg<M> = { seq: this.sndNxt, len: 0, fin: true, what, sent: 0 };
    this.sndNxt += 1;
    this.finOut = true;
    this.out.push(s);
    return s;
  }

  /** The acknowledgment number this end sends (RCV.NXT), 0 before it has the peer's SYN. */
  get ackNo(): number {
    return this.rcvNxt === null ? 0 : this.rcvNxt;
  }

  /**
   * An acknowledgment arrived: SND.UNA moves up to it (never down, never
   * past SND.NXT); what it covers entirely leaves the retransmission queue.
   * True when it acknowledged something new.
   */
  ack(a: number): boolean {
    if (a <= this.sndUna || a > this.sndNxt) return false;
    this.sndUna = a;
    this.out = this.out.filter((s) => s.seq + segSpace(s) > a);
    if (this.finOut && a === this.sndNxt) this.finAcked = true;
    return true;
  }

  /** Everything sent is acknowledged. */
  get idle(): boolean {
    return this.sndUna === this.sndNxt;
  }

  /** The earliest unacknowledged segment (what the retransmission timer sends again). */
  earliest(): Seg<M> | null {
    return this.out.length ? this.out[0] : null;
  }

  /**
   * A smaller path MTU: the unacknowledged data is split into segments of
   * at most `mss` bytes over the same sequence range (the marks stay at the
   * same bytes).
   */
  resegment(mss: number): void {
    const out: Array<Seg<M>> = [];
    for (const s of this.out) {
      if (s.len <= mss) {
        out.push(s);
        continue;
      }
      // (a segment's part already acknowledged is not sent again)
      const from = Math.max(s.seq, this.sndUna);
      const end = s.seq + s.len;
      for (let q = from; q < end; q += mss) {
        const len = Math.min(mss, end - q);
        const p: Seg<M> = { seq: q, len, what: s.what, sent: s.sent };
        if (q + len === end && s.mark) p.mark = s.mark;
        out.push(p);
      }
    }
    this.out = out;
  }

  /**
   * A segment arrived (its SYN handled by synIn): in order its data and
   * FIN advance RCV.NXT, and what waited out of order after it follows;
   * below RCV.NXT it is a duplicate; beyond it it waits.
   */
  receive(seg: { seq: number; len: number; fin?: boolean; mark?: StreamMark<M> }): Received<M> {
    const res: Received<M> = { dup: false, outOfOrder: false, ack: this.ackNo, msgs: [], fin: false, bytes: 0 };
    if (this.rcvNxt === null) return res;
    const space = seg.len + (seg.fin ? 1 : 0);
    if (space === 0) return res;
    if (seg.seq + space <= this.rcvNxt) {
      res.dup = true;
      return res;
    }
    if (seg.seq > this.rcvNxt) {
      if (!this.ooo.some((o) => o.seq === seg.seq && o.len === seg.len)) this.ooo.push({ seq: seg.seq, len: seg.len, fin: seg.fin, mark: seg.mark, what: '', sent: 0 });
      this.ooo.sort((a, b) => a.seq - b.seq);
      res.outOfOrder = true;
      return res;
    }
    this.take(seg, res);
    // what waited for this gap
    for (;;) {
      const i = this.ooo.findIndex((o) => o.seq <= (this.rcvNxt as number));
      if (i < 0) break;
      const o = this.ooo.splice(i, 1)[0];
      if (o.seq + segSpace(o) > (this.rcvNxt as number)) this.take(o, res);
    }
    res.ack = this.ackNo;
    return res;
  }

  /** In order (it starts at or before RCV.NXT and reaches past it): its new bytes, its mark, its FIN. */
  private take(seg: { seq: number; len: number; fin?: boolean; mark?: StreamMark<M> }, res: Received<M>): void {
    const nxt = this.rcvNxt as number;
    const end = seg.seq + seg.len;
    if (end > nxt) {
      res.bytes += end - nxt;
      this.received += end - nxt;
      this.rcvNxt = end;
    }
    if (seg.mark && seg.mark.end <= (this.rcvNxt as number) && !this.delivered.has(seg.mark.id)) {
      this.delivered.add(seg.mark.id);
      res.msgs.push(seg.mark);
    }
    if (seg.fin && end === this.rcvNxt && !this.finIn) {
      this.finIn = true;
      this.rcvNxt = end + 1;
      res.fin = true;
    }
  }
}

/** An initial sequence number from a connection's identity and a counter (deterministic, below 2^31; RFC 6528's are random). */
export function initialSeq(key: string, n: number): number {
  let h = 2166136261;
  const s = key + '#' + n;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h & 0x3fffffff;
}

/**
 * The real-time schedule of Network events: what a user started that
 * repeats at an interval of real time (a multicast stream), independent of
 * the simulated clock. DOM-free; its clock is injected (the browser's
 * `performance.now`, a test's fake), so tests never sleep.
 *
 * Its time is the clock's while it runs: paused (the simulation paused,
 * its tab hidden, the simulation closed) its time stands, and resuming goes
 * on from there, so a pause shifts every deadline by its length and sends
 * nothing it missed.
 *
 * Each entry keeps its own grid: the first send at once when it is added
 * (the streams' convention: the first datagram goes when the stream
 * starts), the n-th at start + n × interval of the schedule's time. A
 * deadline is computed from the start, never from when the last send
 * happened, so a late frame doesn't add up to drift. `pump()` (once an
 * animation frame) sends what is due: entries with the same deadline in the
 * order they were added; a frame late by less than an interval sends the
 * one due and keeps the grid; one later than that (a stall) sends one for
 * the latest deadline and counts the others as skipped, never a burst.
 * Every entry is due on its own grid in the same pump: two streams of 1 s
 * each send every second, never taking turns.
 *
 * Entries are removed by `remove` (Stop) and all of them by `clear`
 * (closing the simulation); a removed entry's callback never runs again,
 * even from a pump already under way.
 */

export interface RtEntry {
  id: number;
  /** real ms between two sends */
  interval: number;
  /** the schedule's time at the start (the first send) */
  start: number;
  /** the next send's index (1: the second send, at start + interval) */
  next: number;
  /** sends left out because the page was late by more than an interval */
  skipped: number;
  /** what one send does (n: the send's index, 0 the first) */
  fire: (n: number) => void;
}

export class RealTimeScheduler {
  private entries: RtEntry[] = [];
  private seq = 0;
  /** schedule time = clock − offset while running; while paused it stands at `pausedAt` */
  private offset = 0;
  private pausedAt: number | null;

  constructor(
    /** real ms, monotonic (performance.now in the browser) */
    public clock: () => number = () => Date.now(),
    running = true,
  ) {
    this.pausedAt = running ? null : this.clock();
  }

  /** The schedule's own time (real ms that it ran). */
  now(): number {
    return (this.pausedAt !== null ? this.pausedAt : this.clock()) - this.offset;
  }

  get running(): boolean {
    return this.pausedAt === null;
  }

  /** Run or pause (the simulation's play state; a hidden tab counts as paused). */
  setRunning(on: boolean): void {
    if (on === this.running) return;
    if (on) {
      this.offset += this.clock() - (this.pausedAt as number);
      this.pausedAt = null;
    } else this.pausedAt = this.clock();
  }

  /** Add an entry: its first send now, then every interval; returns it (its id removes it). */
  add(interval: number, fire: (n: number) => void): RtEntry {
    const e: RtEntry = { id: ++this.seq, interval: Math.max(1, interval), start: this.now(), next: 1, skipped: 0, fire };
    this.entries.push(e);
    fire(0);
    return e;
  }

  remove(id: number): boolean {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    return this.entries.length < n;
  }

  /** Remove every entry (the simulation closed or started again). */
  clear(): void {
    this.entries = [];
  }

  get(id: number): RtEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Is anything scheduled? */
  active(): boolean {
    return this.entries.length > 0;
  }

  /** How many entries are scheduled. */
  get size(): number {
    return this.entries.length;
  }

  /** When an entry's next send is due (schedule time), or null. */
  due(id: number): number | null {
    const e = this.get(id);
    return e ? e.start + e.next * e.interval : null;
  }

  /** Send what is due now; returns how many sends were made. */
  pump(): number {
    if (!this.running || !this.entries.length) return 0;
    const now = this.now();
    const due: Array<{ e: RtEntry; at: number; n: number }> = [];
    for (const e of this.entries) {
      const at = e.start + e.next * e.interval;
      if (at > now) continue;
      // the latest deadline passed; those before it (a stall longer than an interval) are skipped
      const last = Math.floor((now - e.start) / e.interval);
      e.skipped += last - e.next;
      due.push({ e, at: e.start + last * e.interval, n: last });
      e.next = last + 1;
    }
    // the same deadline: in the order added (stable); each entry once per pump
    due.sort((a, b) => a.at - b.at || a.e.id - b.e.id);
    let sent = 0;
    for (const d of due) {
      // (removed meanwhile, by an earlier send's consequences: never again)
      if (this.entries.indexOf(d.e) < 0) continue;
      d.e.fire(d.n);
      sent++;
    }
    return sent;
  }
}

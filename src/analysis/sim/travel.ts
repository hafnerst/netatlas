/**
 * Visible travel time: how long a dot takes on screen to cross the line it
 * is drawn on, in Readable pacing at 1× (the normal playback). The one
 * mapping from a hop's modelled traversal cost to its presentation time;
 * nothing else decides it. DOM-free.
 *
 * The cost of a hop is its modelled simulated time on its line: a cable's
 * propagation delay plus its frame's serialization (bytes × 8 ÷ speed) — the
 * engine's own wire timing, taken once (the flight's t1 − t0, never latency
 * and serialization added again); a relation's lane its transfer as the
 * engine estimates it over its underlay (the cables of its traced path,
 * each with its own latency and speed: Engine.estimate). A line drawn in
 * two halves (to a network, a hub or a bus and on) is one traversal: the
 * halves share the time of their whole.
 *
 * Simulated costs are tiny (0.1 ms on a LAN cable, 20 ms on a WAN link), so
 * they are compressed on a log scale over the model's own range rather than
 * clamped: from the model's cheapest cable (TRAVEL_MIN: the quickest a
 * routine LAN hop shows) to TRAVEL_SPAN times its dearest (TRAVEL_MAX; a
 * logical line usually spans a few cables), a window at least
 * TRAVEL_DECADES wide upwards when the cables differ less — so a cheaper hop
 * always shows shorter than a dearer one within the bounds, and in a
 * homogeneous model a relation over two cables, a large frame or a slower
 * link still shows longer than a small frame on one cable. The scale is
 * fixed when the simulation starts (and when a latency or speed parameter
 * changes), never by which messages came first.
 *
 * Without a cost (none modelled, zero, unknown) or a scale (a model without
 * cables), a hop takes TRAVEL_NEUTRAL: the middle, said nowhere to be a
 * latency. The speed control divides these times (2× halves them, 0.5×
 * doubles them); paused time is not counted. A dot's seconds are never a
 * delay of the network: the simulated times stay what the engine made them.
 */

/** Readable at 1×: the shortest and the longest crossing of a line (display ms). */
export const TRAVEL_MIN = 3000;
export const TRAVEL_MAX = 5000;
/** No modelled cost or no scale: the middle. */
export const TRAVEL_NEUTRAL = 4000;
/** The scale's top: this many times the dearest cable (a logical line spans several). */
export const TRAVEL_SPAN = 4;
/** The scale's narrowest window (decades of cost), widened upwards. */
export const TRAVEL_DECADES = 2;

/** The model's range of traversal costs (simulated ms), log-mapped onto TRAVEL_MIN … TRAVEL_MAX. */
export interface TravelScale {
  lo: number;
  hi: number;
}

const ok = (x: number): boolean => x > 0 && isFinite(x);

/** The scale from the model's cable costs (simulated ms each); null without any. */
export function travelScale(costs: readonly number[]): TravelScale | null {
  const c = costs.filter(ok);
  if (!c.length) return null;
  const lo = Math.min(...c);
  return { lo, hi: Math.max(Math.max(...c) * TRAVEL_SPAN, lo * Math.pow(10, TRAVEL_DECADES)) };
}

/** The display time (ms at 1×) of a traversal costing `cost` simulated ms; TRAVEL_NEUTRAL without a cost or a scale. */
export function travelMs(cost: number | null | undefined, scale: TravelScale | null): number {
  if (cost === null || cost === undefined || !ok(cost) || !scale) return TRAVEL_NEUTRAL;
  const lo = Math.log10(scale.lo);
  const x = (Math.log10(cost) - lo) / (Math.log10(scale.hi) - lo);
  return TRAVEL_MIN + (TRAVEL_MAX - TRAVEL_MIN) * Math.max(0, Math.min(1, x));
}

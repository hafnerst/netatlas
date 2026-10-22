/**
 * PTP as NetAtlas models it: PTPv2 of IEEE 1588-2008, its Delay
 * Request-Response Default PTP profile (Annex J.3) over UDP/IPv4
 * (Annex D: event messages to UDP 319, general messages to UDP 320, both
 * to 224.0.1.129), end-to-end delay measurement, two-step clocks. The
 * profile's defaults (as linuxptp's default configuration has them):
 * domain 0, priority1 and priority2 128, clock class 248, clock accuracy
 * 0xFE (unknown), offsetScaledLogVariance 0xFFFF, Announce every 2 s
 * (logAnnounceInterval 1), Sync every 1 s (logSyncInterval 0), Delay_Req
 * at most every 1 s (logMinDelayReqInterval 0), announceReceiptTimeout 3.
 * The multicast TTL is 1 (linuxptp's udp_ttl): PTP stays in its subnet,
 * a boundary clock carries time across routers.
 *
 * The best master clock algorithm's data set comparison (1588-2008
 * §9.3.4, as linuxptp's bmc.c implements it) and the state decision
 * (§9.3.3) are here, pure, for the simulation (analysis/sim/ptp.ts) and
 * the tests. Not part of this model: one-step clocks, the peer delay
 * mechanism, IEEE 802.1AS (gPTP) and other profiles, management and
 * signaling messages, unicast negotiation, TSN.
 */

export type PtpClockKind = 'ordinary' | 'boundary' | 'transparent';

export const PTP_GROUP = '224.0.1.129';
export const PTP_EVENT_PORT = 319;
export const PTP_GENERAL_PORT = 320;

const S = 1000;
/** the profile's allowed intervals (ms) */
export const PTP_RANGES = {
  announce: [1 * S, 2 * S, 4 * S, 8 * S, 16 * S],
  sync: [0.5 * S, 1 * S, 2 * S],
  delayReq: [1 * S, 2 * S, 4 * S, 8 * S, 16 * S, 32 * S],
} as const;

export const PTP_DEFAULTS = {
  domain: 0,
  priority1: 128,
  priority2: 128,
  clockClass: 248,
  /** a slave-only clock's class */
  slaveOnlyClass: 255,
  clockAccuracy: 0xfe,
  variance: 0xffff,
  announceInterval: 2 * S,
  syncInterval: 1 * S,
  delayReqInterval: 1 * S,
  announceReceiptTimeout: 3,
  /** FOREIGN_MASTER_THRESHOLD and FOREIGN_MASTER_TIME_WINDOW (in announce intervals), 1588-2008 §9.3.2.4.6 */
  foreignThreshold: 2,
  foreignWindow: 4,
} as const;

/** The modelling assumptions of the timestamps (not the standard's): hardware at the wire, software when handed to the stack. */
export const PTP_TIMESTAMPING = {
  hardware: { resolutionNs: 8, label: 'hardware (8 ns resolution, taken when the frame leaves or arrives on the wire)' },
  software: { resolutionNs: 1000, label: 'software (1 µs resolution, taken when the message is handed to or from the network stack: queueing before the wire is not seen)' },
} as const;

/** How close the estimates must stay for this model to call a slave synchronized (a model's rule, not the standard's). */
export const PTP_LOCK = { count: 3, hardwareNs: 1000, softwareNs: 100000 } as const;

/** "+250us", "-3ms", "0", "1.5ms" → ns; null when it is not one. */
export function parseClockOffset(t: string): number | null {
  const m = /^\s*([+-]?)\s*([0-9]+(?:\.[0-9]+)?)\s*(ns|us|µs|ms|s)?\s*$/.exec(t);
  if (!m) return null;
  const v = Number(m[2]) * (m[3] === 's' ? 1e9 : m[3] === 'ms' ? 1e6 : m[3] === 'ns' ? 1 : m[3] ? 1e3 : Number(m[2]) === 0 ? 1 : NaN);
  if (!isFinite(v) || Math.abs(v) > 1e12) return null;
  return m[1] === '-' ? -v : v;
}

/** "20ppm", "-5 ppm", "0" → ppm; null when it is not one (at most ±1000 ppm). */
export function parseDrift(t: string): number | null {
  const m = /^\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*(ppm)?\s*$/.exec(t);
  if (!m || (!m[2] && Number(m[1]) !== 0)) return null;
  const v = Number(m[1]);
  return Math.abs(v) <= 1000 ? v : null;
}

/** A clock identity from a MAC (EUI-48 to EUI-64: ff:fe in the middle, IEEE 1588-2008 §7.5.2.2.2). */
export function clockIdentity(mac: string): string {
  const b = mac.split(':');
  return [b[0], b[1], b[2], 'ff', 'fe', b[3], b[4], b[5]].join(':');
}

/** A port identity as text: its clock identity and port number ("00:1b:21:ff:fe:12:34:56-1"). */
export function portIdentity(clock: string, port: number): string {
  return `${clock}-${port}`;
}

/** The grandmaster attributes an Announce carries (and a clock's own default data set). */
export interface GmAttrs {
  identity: string;
  priority1: number;
  clockClass: number;
  clockAccuracy: number;
  variance: number;
  priority2: number;
}

/** A data set of the comparison: a grandmaster, its distance, who sent it and who received it. */
export interface PtpDataset {
  gm: GmAttrs;
  stepsRemoved: number;
  /** the sending port's identity (the local clock's own: "clock-0") */
  sender: string;
  /** the receiving port's identity */
  receiver: string;
}

/** The comparison's results: A better, A better by topology, equal (an error case), B better by topology, B better. */
export const A_BETTER = 2;
export const A_BETTER_TOPO = 1;
export const B_BETTER_TOPO = -1;
export const B_BETTER = -2;

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Port identities: by clock identity, then port number. */
function cmpPort(a: string, b: string): number {
  const i = a.lastIndexOf('-');
  const j = b.lastIndexOf('-');
  return cmpId(a.slice(0, i), b.slice(0, j)) || Number(a.slice(i + 1)) - Number(b.slice(j + 1));
}

/**
 * 1588-2008 §9.3.4 (Figures 27 and 28): another grandmaster is compared by
 * its attributes (priority1, clock class, accuracy, variance, priority2,
 * identity: lower wins); the same grandmaster by topology (fewer steps
 * removed, then the sender's, then the receiver's port identity).
 */
export function compareDatasets(a: PtpDataset | null, b: PtpDataset | null): number {
  if (a === b) return 0;
  if (a && !b) return A_BETTER;
  if (b && !a) return B_BETTER;
  const x = a as PtpDataset;
  const y = b as PtpDataset;
  if (x.gm.identity !== y.gm.identity) {
    const order: Array<keyof GmAttrs> = ['priority1', 'clockClass', 'clockAccuracy', 'variance', 'priority2'];
    for (const k of order) if (x.gm[k] !== y.gm[k]) return (x.gm[k] as number) < (y.gm[k] as number) ? A_BETTER : B_BETTER;
    return cmpId(x.gm.identity, y.gm.identity) < 0 ? A_BETTER : B_BETTER;
  }
  // the same grandmaster: by topology (Figure 28)
  if (x.stepsRemoved + 1 < y.stepsRemoved) return A_BETTER;
  if (y.stepsRemoved + 1 < x.stepsRemoved) return B_BETTER;
  if (x.stepsRemoved < y.stepsRemoved) {
    const d = cmpPort(y.receiver, y.sender);
    return d < 0 ? A_BETTER : d > 0 ? A_BETTER_TOPO : 0;
  }
  if (x.stepsRemoved > y.stepsRemoved) {
    const d = cmpPort(x.receiver, x.sender);
    return d < 0 ? B_BETTER : d > 0 ? B_BETTER_TOPO : 0;
  }
  const s = cmpPort(x.sender, y.sender);
  if (s) return s < 0 ? A_BETTER_TOPO : B_BETTER_TOPO;
  const pr = Number(x.receiver.split('-').pop()) - Number(y.receiver.split('-').pop());
  return pr < 0 ? A_BETTER_TOPO : pr > 0 ? B_BETTER_TOPO : 0;
}

/** A port's recommended state (1588-2008 §9.3.3, Figure 26; a slave-only clock: §9.2.2). */
export type Recommended = 'M1' | 'M2' | 'M3' | 'S1' | 'P1' | 'P2' | 'LISTENING';

export function stateDecision(d0: PtpDataset, erbest: PtpDataset | null, ebest: PtpDataset | null, thisIsEbestPort: boolean, slaveOnly: boolean, listening: boolean): Recommended {
  if (slaveOnly) return ebest && thisIsEbestPort ? 'S1' : ebest ? 'P2' : 'LISTENING';
  if (!erbest && listening) return 'LISTENING';
  if (d0.gm.clockClass <= 127) return compareDatasets(d0, erbest) > 0 ? 'M1' : 'P1';
  if (compareDatasets(d0, ebest) > 0) return 'M2';
  if (thisIsEbestPort) return 'S1';
  if (compareDatasets(ebest, erbest) === A_BETTER_TOPO) return 'P2';
  return 'M3';
}

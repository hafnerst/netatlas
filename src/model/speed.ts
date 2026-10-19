/** Speeds and bandwidths as written in the model: "10G", "100M", "1 Gbps", "400GbE". */

/** Parse "10G", "100M", "1 Gbps", "400GbE" into bits per second (null: not a speed). */
/** A bit rate in words ("1.5 Gbit/s", "200 Mbit/s", "800 bit/s"). */
export function bpsText(b: number): string {
  return b >= 1e9 ? `${+(b / 1e9).toFixed(2)} Gbit/s` : b >= 1e6 ? `${+(b / 1e6).toFixed(2)} Mbit/s` : b >= 1e3 ? `${+(b / 1e3).toFixed(2)} kbit/s` : `${Math.round(b)} bit/s`;
}

/**
 * What a demand's simulated packets are: representative ones, one every
 * so often (more often for a larger demand), that show its way and whether
 * it gets through — never its stated bandwidth, which only capacity
 * analysis uses (no cable is loaded or queued by it in the simulation).
 */
export function representativeText(bps: number, everyMs: number, bytes: number): string {
  const wire = ((bytes + 18) * 8 * 1000) / everyMs;
  return `representative packets: one of ${bytes} bytes every ${+(everyMs / 1000).toFixed(1)} s (about ${bpsText(wire)} on the wire); the demand states ${bpsText(bps)}, which capacity analysis uses — the simulation does not carry that load`;
}

export function parseSpeed(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgGtT]?)(?:b(?:ps|it\/s|e)?|bps)?\s*$/i.exec(s.replace(/gbe$/i, 'G'));
  if (!m) return null;
  const mult: { [k: string]: number } = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return parseFloat(m[1]) * mult[m[2].toLowerCase()];
}

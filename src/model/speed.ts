/** Speeds and bandwidths as written in the model: "10G", "100M", "1 Gbps", "400GbE". */

/** Parse "10G", "100M", "1 Gbps", "400GbE" into bits per second (null: not a speed). */
export function parseSpeed(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgGtT]?)(?:b(?:ps|it\/s|e)?|bps)?\s*$/i.exec(s.replace(/gbe$/i, 'G'));
  if (!m) return null;
  const mult: { [k: string]: number } = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return parseFloat(m[1]) * mult[m[2].toLowerCase()];
}

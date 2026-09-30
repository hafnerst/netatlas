/**
 * Display order of names (interfaces, loopbacks, networks): alphabetical,
 * the same in every browser and locale. Letters compare without regard to
 * case and runs of digits by their value, so "eth2" comes before "eth10".
 * Names that are equal this way fall back to plain code-unit order, and the
 * sort keeps the given (file) order for identical names.
 *
 * This is for display only: nothing is reordered in the model or the file.
 */
function chunks(s: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([0-9]+)|([^0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? Number(m[1]) : m[2].toLowerCase());
  return out;
}

export function compareNames(a: string, b: string): number {
  const ca = chunks(a);
  const cb = chunks(b);
  for (let i = 0; i < ca.length && i < cb.length; i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    // a number sorts before text
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  if (ca.length !== cb.length) return ca.length < cb.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A sorted copy: by name, identical names in their given order. */
export function sortedByName<T>(items: readonly T[], name: (x: T) => string): T[] {
  return items
    .map((x, i) => ({ x, i, n: name(x) }))
    .sort((p, q) => compareNames(p.n, q.n) || p.i - q.i)
    .map((e) => e.x);
}

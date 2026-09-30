/** Code-unit string order: the same in every browser and locale. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A model's fingerprint for freshness: what an analysis reads, as text. Two
 * models with the same fingerprint give the same analysis results, so a
 * result computed on one is up to date for the other. Positions (the
 * `layout` section), line numbers, the index and the built-in service
 * registry are left out: moving a node or editing a comment does not make a
 * result outdated; changing an address, a cable, a route or a service does.
 * Pure; cached per model.
 */
import type { Model } from './types';

/** keys of the model itself that are no network facts */
const TOP_SKIP = new Set(['layout', 'index', 'services']);
const cache = new WeakMap<Model, string>();

/** A short identity of a model's fingerprint (two FNV-1a hashes, 16 hex digits): what an export names the model by. */
export function fingerprintId(model: Model): string {
  const t = modelFingerprint(model);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ t.length;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function modelFingerprint(model: Model): string {
  const known = cache.get(model);
  if (known !== undefined) return known;
  const stack = new WeakSet<object>();
  const text = JSON.stringify(model, function (this: unknown, k: string, v: unknown): unknown {
    if (this === model && TOP_SKIP.has(k)) return undefined;
    if (k === 'line') return undefined;
    if (typeof v === 'function') return undefined;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Map) return Array.from(v.entries());
    if (v instanceof Set) return Array.from(v.values());
    if (v && typeof v === 'object') {
      // (a cycle is cut; nothing of the model refers back up, but stay safe)
      if (stack.has(v as object)) return undefined;
      stack.add(v as object);
    }
    return v;
  });
  cache.set(model, text);
  return text;
}

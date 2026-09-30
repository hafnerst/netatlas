/**
 * Validation plumbing: the issue type and collector, limits, id patterns, and
 * a typed reader over the parsed YAML tree that reports problems with the
 * node they concern. validate.ts holds the rules of the format itself.
 */
import { Attrs, VLAN_MAX, VLAN_MIN } from '../model/types';
import { YMap, YNode } from '../yaml/parse';

export interface Issue {
  severity: 'error' | 'warning';
  /** 1-based line in the loaded file; 0 for content created in the editor */
  line: number;
  /** human-readable location, e.g. "devices.r1.interfaces[0].ip[1]" */
  path: string;
  message: string;
  /** the YAML node the issue is about (the containing mapping for a missing key) */
  node?: YNode;
  /** the key concerned, when the issue is about a key of `node` (missing / unknown key) */
  key?: string;
}

export interface ModelLimits {
  maxGroups: number;
  maxDevices: number;
  maxInterfacesPerDevice: number;
  maxInterfaces: number;
  maxLinks: number;
  maxNetworks: number;
  maxRelations: number;
  maxEndpoints: number;
  maxProtocols: number;
  maxGroupDepth: number;
  maxAttrs: number;
  maxLabel: number;
  maxDescription: number;
  maxErrors: number;
}

export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  maxGroups: 500,
  maxDevices: 1000,
  maxInterfacesPerDevice: 512,
  maxInterfaces: 20000,
  maxLinks: 5000,
  maxNetworks: 2000,
  maxRelations: 5000,
  maxEndpoints: 64,
  maxProtocols: 200,
  maxGroupDepth: 8,
  maxAttrs: 100,
  maxLabel: 200,
  maxDescription: 4000,
  maxErrors: 200,
};

/** Entity ids: letters, digits, "_", ".", "-" (no ":" — it separates device and interface). */
export const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,63}$/;
/** Interface ids additionally allow "/" (e.g. "ge-0/0/1", "Ethernet1/1"). */
export const IFACE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-\/]{0,63}$/;

export class TooManyErrors extends Error {}

export interface At {
  key?: string;
  line?: number;
}

export class Ctx {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  constructor(readonly limits: ModelLimits) {}
  private mk(severity: 'error' | 'warning', node: YNode, path: string, message: string, at: At): Issue {
    const is: Issue = { severity, line: at.line !== undefined ? at.line : node.line, path, message, node };
    if (at.key !== undefined) is.key = at.key;
    return is;
  }
  error(node: YNode, path: string, message: string, at: At = {}): void {
    this.errors.push(this.mk('error', node, path, message, at));
    if (this.errors.length >= this.limits.maxErrors) throw new TooManyErrors();
  }
  warn(node: YNode, path: string, message: string, at: At = {}): void {
    if (this.warnings.length < this.limits.maxErrors) this.warnings.push(this.mk('warning', node, path, message, at));
  }
}

// --------------------------------------------------------------- utilities

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp: number[] = [];
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** " — did you mean "x"?" or a short list of valid options. */
export function suggest(name: string, candidates: Iterable<string>, listIfFew = 8): string {
  const all = Array.from(candidates);
  let best = '';
  let bestD = 99;
  const lname = name.toLowerCase();
  for (const c of all) {
    const d = levenshtein(lname, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best && bestD <= Math.max(1, Math.min(3, Math.floor(name.length / 3)))) return ` — did you mean "${best}"?`;
  if (all.length && all.length <= listIfFew) return ` (known: ${all.join(', ')})`;
  return '';
}

export function kindOf(n: YNode): string {
  return n.kind === 'map' ? 'a mapping' : n.kind === 'seq' ? 'a list' : n.value === null ? 'empty (null)' : 'a scalar';
}

export function get(m: YMap, key: string): YNode | undefined {
  const e = m.entries.get(key);
  return e ? e.value : undefined;
}

export function isNull(n: YNode | undefined): boolean {
  return !n || (n.kind === 'scalar' && n.value === null && !n.quoted);
}

/** Text of a scalar as written (numbers keep their spelling, e.g. "010"). */
export function scalarText(n: YNode): string | undefined {
  if (n.kind !== 'scalar' || (n.value === null && !n.quoted)) return undefined;
  return n.quoted ? String(n.value) : n.raw;
}

export class Reader {
  constructor(private readonly c: Ctx) {}

  map(n: YNode | undefined, path: string): YMap | null {
    if (!n) return null;
    if (n.kind !== 'map') {
      this.c.error(n, path, `expected a mapping ("key: value" lines) but found ${kindOf(n)}`);
      return null;
    }
    return n;
  }

  /** A list; a single scalar is accepted as a one-element list when `allowScalar`. */
  list(n: YNode | undefined, path: string, allowScalar = false): YNode[] {
    if (isNull(n)) return [];
    const node = n as YNode;
    if (node.kind === 'seq') return node.items;
    if (allowScalar && node.kind === 'scalar') return [node];
    this.c.error(node, path, `expected a list ("- item" lines or [a, b]) but found ${kindOf(node)}`);
    return [];
  }

  /** Unknown keys are errors; `retired` keys get their own message saying what replaces them. */
  keys(m: YMap, allowed: string[], path: string, hint = '', retired: { [key: string]: string } = {}): void {
    m.entries.forEach((e, k) => {
      if (allowed.indexOf(k) >= 0) return;
      if (Object.prototype.hasOwnProperty.call(retired, k)) {
        this.c.error(m, path ? path + '.' + k : k, `"${k}" is no longer part of the format — ${retired[k]}`, { key: k, line: e.keyLine });
      } else {
        this.c.error(m, path ? path + '.' + k : k, `unknown key "${k}"${suggest(k, allowed, 20)}${hint}`, { key: k, line: e.keyLine });
      }
    });
  }

  str(n: YNode | undefined, path: string, max: number): string | undefined {
    if (isNull(n)) return undefined;
    const node = n as YNode;
    if (node.kind !== 'scalar') {
      this.c.error(node, path, `expected a single value but found ${kindOf(node)}`);
      return undefined;
    }
    const s = scalarText(node) as string;
    if (s.length > max) {
      this.c.error(node, path, `value is ${s.length} characters long; the limit is ${max}`);
      return s.slice(0, max);
    }
    return s;
  }

  field(m: YMap, key: string, path: string, max: number): string | undefined {
    return this.str(get(m, key), path + '.' + key, max);
  }

  reqStr(m: YMap, key: string, path: string, max: number): string | undefined {
    const n = get(m, key);
    if (isNull(n)) {
      this.c.error(m, path, `missing required key "${key}"`, { key });
      return undefined;
    }
    return this.str(n, path + '.' + key, max);
  }

  id(m: YMap, path: string, re = ID_RE, what = 'id'): string | undefined {
    const v = this.reqStr(m, 'id', path, 200);
    if (v === undefined) return undefined;
    if (!re.test(v)) {
      this.c.error(
        get(m, 'id') as YNode,
        path + '.id',
        `invalid ${what} "${v}": use 1–64 characters from A–Z a–z 0–9 _ . -${re === IFACE_RE ? ' /' : ''}, starting with a letter or digit` +
          (v.indexOf(':') >= 0 ? ' (":" is reserved to separate device and interface)' : ''),
      );
      return undefined;
    }
    return v;
  }

  /** A VLAN ID: a whole number from 1 to 4094. */
  vlanId(n: YNode | undefined, path: string): number | undefined {
    if (isNull(n)) return undefined;
    const node = n as YNode;
    const t = node.kind === 'scalar' ? (scalarText(node) as string) : '';
    const v = /^[1-9][0-9]{0,3}$/.test(t) ? Number(t) : 0;
    if (v < VLAN_MIN || v > VLAN_MAX) {
      this.c.error(node, path, `${node.kind === 'scalar' ? `"${t}"` : kindOf(node)} is not a VLAN ID: use a whole number from ${VLAN_MIN} to ${VLAN_MAX}`);
      return undefined;
    }
    return v;
  }

  bool(n: YNode | undefined, path: string): boolean | undefined {
    if (isNull(n)) return undefined;
    const node = n as YNode;
    if (node.kind !== 'scalar' || typeof node.value !== 'boolean') {
      this.c.error(node, path, 'expected true or false');
      return undefined;
    }
    return node.value;
  }

  /** Display-only flattening of attrs; the document keeps the full structure. */
  attrs(n: YNode | undefined, path: string): Attrs {
    const out: Attrs = [];
    if (isNull(n)) return out;
    const m = this.map(n, path);
    if (!m) return out;
    const walk = (node: YNode, prefix: string, depth: number): void => {
      if (out.length >= this.c.limits.maxAttrs) {
        this.c.error(node, path, `more than ${this.c.limits.maxAttrs} attributes`);
        return;
      }
      if (node.kind === 'scalar') {
        const s = node.quoted ? String(node.value) : node.raw;
        out.push([prefix, s.length > 500 ? s.slice(0, 500) + '…' : s]);
      } else if (node.kind === 'seq') {
        if (node.items.every((i) => i.kind === 'scalar')) {
          out.push([prefix, node.items.map((i) => (i.kind === 'scalar' ? (i.quoted ? String(i.value) : i.raw) : '')).join(', ')]);
        } else node.items.forEach((i, k) => walk(i, prefix + '[' + k + ']', depth + 1));
      } else if (depth > 4) {
        out.push([prefix, '{…}']);
      } else {
        node.entries.forEach((e, k) => walk(e.value, prefix ? prefix + '.' + k : k, depth + 1));
      }
    };
    walk(m, '', 0);
    return out;
  }
}


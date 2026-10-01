/**
 * DNS names of a device: syntax and comparison. A name is a host name in the
 * letter-digit-hyphen form (RFC 1123): dot-separated labels of 1–63
 * characters, 253 characters in total, optionally ending in a dot. Nothing is
 * resolved and no record is created; the name is configuration only.
 */

const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Longest name, without the trailing dot. */
export const DNS_NAME_MAX = 253;

/** Why `name` is not a valid DNS name, or null when it is. */
export function dnsNameProblem(name: string): string | null {
  if (!name) return 'the name is empty';
  if (/\s/.test(name)) return 'a DNS name cannot contain spaces';
  const bare = name.charAt(name.length - 1) === '.' ? name.slice(0, -1) : name;
  if (!bare) return 'a DNS name needs at least one label';
  if (bare.length > DNS_NAME_MAX) return `a DNS name has at most ${DNS_NAME_MAX} characters`;
  const labels = bare.split('.');
  for (const l of labels) {
    if (!l) return 'a DNS name cannot contain an empty label (two dots in a row, or a leading dot)';
    if (l.length > 63) return `the label "${l.slice(0, 20)}…" is longer than 63 characters`;
    if (!LABEL_RE.test(l)) {
      return `the label "${l}" may only contain letters, digits and hyphens, and cannot start or end with a hyphen`;
    }
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return 'the last label of a DNS name cannot be all digits (an IP address is not a DNS name)';
  return null;
}

/** Comparison key: DNS names are case-insensitive, and a trailing dot does not make a different name. */
export function dnsNameKey(name: string): string {
  const n = name.toLowerCase();
  return n.charAt(n.length - 1) === '.' ? n.slice(0, -1) : n;
}

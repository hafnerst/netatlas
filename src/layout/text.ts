/**
 * Text measuring and wrapping for diagram labels.
 *
 * Labels are never shortened: a label that is too long for one line is
 * wrapped, and the element it belongs to grows. Widths are estimated from
 * character classes (no font metrics, no DOM), so the same text gives the
 * same lines and sizes in every browser and in Node; this is what keeps
 * Auto-arrange deterministic. The estimate is deliberately a little wide.
 */

/** Estimated advance of one character, in em, for the UI font at label weight. */
function charEm(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 0x2e80) return 1.05; // CJK, full-width forms, most symbols and emoji halves
  if (code > 0x7e) return 0.72; // accented Latin, Greek, Cyrillic, arrows, dashes …
  if (c === ' ') return 0.3;
  if (/[ilj.,:;|!']/.test(c)) return 0.33;
  if (/[ftrI1()\[\]\/\\\-"`]/.test(c)) return 0.43;
  if (/[mw]/.test(c)) return 0.9;
  if (/[MW@%]/.test(c)) return 1.0;
  if (/[A-Z]/.test(c)) return 0.72;
  if (/[0-9]/.test(c)) return 0.61;
  return 0.59;
}

/** Estimated width of one line of text at a font size. */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charEm(s.charAt(i));
  return w * size;
}

/** Height of one line of text at a font size (whole pixels). */
export function lineHeight(size: number): number {
  return Math.round(size * 1.25);
}

/**
 * The lines a label is written in: explicit line breaks are kept, other
 * white space is collapsed, and empty lines are dropped.
 */
export function explicitLines(s: string): string[] {
  return s
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
}

/** Characters after which a long word may be broken without a hyphen. */
const BREAK_AFTER = /[-_\/\\.:,;|@=+]/;

/** Split a word that is wider than `maxW` on its own; prefers breaking after punctuation. */
function breakWord(word: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < word.length) {
    let w = 0;
    let end = start;
    let soft = -1;
    while (end < word.length) {
      const cw = charEm(word.charAt(end)) * size;
      if (end > start && w + cw > maxW) break;
      w += cw;
      end++;
      if (end < word.length && BREAK_AFTER.test(word.charAt(end - 1))) soft = end;
    }
    // use the last punctuation break if it keeps at least 40 % of the line
    if (end < word.length && soft > start && soft - start >= (end - start) * 0.4) end = soft;
    out.push(word.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * Wrap a label to lines no wider than `maxW`: at explicit line breaks, then
 * at spaces, and inside a word only when the word alone is too wide. No text
 * is dropped and nothing is replaced by "…".
 */
export function wrapText(s: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of explicitLines(s)) {
    let line = '';
    for (const word of para.split(' ')) {
      const pieces = textWidth(word, size) > maxW ? breakWord(word, size, maxW) : [word];
      pieces.forEach((piece, k) => {
        // pieces of a broken word never share a line with each other
        const joined = line === '' ? piece : line + (k === 0 ? ' ' : '') + piece;
        if (line !== '' && (k > 0 || textWidth(joined, size) > maxW)) {
          out.push(line);
          line = piece;
        } else line = joined;
      });
    }
    if (line !== '') out.push(line);
  }
  return out;
}

export interface TextBlock {
  lines: string[];
  size: number;
  /** widest line */
  w: number;
  /** lines × line height */
  h: number;
}

export function textBlock(s: string, size: number, maxW: number): TextBlock {
  const lines = wrapText(s, size, maxW);
  return { lines, size, w: lines.reduce((m, l) => Math.max(m, textWidth(l, size)), 0), h: lines.length * lineHeight(size) };
}

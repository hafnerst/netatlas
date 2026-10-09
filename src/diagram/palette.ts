/**
 * Theme-aware diagram colours.
 *
 * The colours a model gives its diagram (cable media, protocols, custom
 * protocol colours, the network colour) are written for a light canvas. Each
 * theme draws them through `themedColor`, so that every line and swatch stays
 * a meaningful graphic (WCAG 2.2: at least 3:1 against the canvas and the
 * panels behind legends) without changing its hue:
 *
 *   light  a colour too pale for the light canvas is darkened just enough;
 *   dark   the saturation is lowered (no glare on dark grey), then the colour
 *          is lightened just enough for the dark canvas and panels.
 *
 * Pure and deterministic (no DOM): the same colour and theme always give the
 * same result, so the screen and both export formats agree.
 */
export type Theme = 'light' | 'dark';

/** Surfaces diagram graphics are drawn on, per theme (canvas, panel, raised: see styles.css). */
export const SURFACES: { [t in Theme]: string[] } = {
  light: ['#fbfcfd', '#ffffff'],
  dark: ['#15181d', '#20252c', '#282e36'],
};

/** Minimum contrast of a diagram graphic against the surfaces it lies on. */
export const GRAPHIC_CONTRAST = 3;

type RGB = [number, number, number];

export function parseHex(s: string): RGB | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hex(c: RGB): string {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance (WCAG). */
export function luminance(c: RGB): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** Contrast ratio of two colours (WCAG), 1 … 21. */
export function contrast(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return 1;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

function toHsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h /= 6;
  return [h, s, l];
}

function toRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

function worst(c: string, theme: Theme): number {
  return SURFACES[theme].reduce((m, s) => Math.min(m, contrast(c, s)), Infinity);
}

const cache: { [t in Theme]: Map<string, string> } = { light: new Map(), dark: new Map() };

/**
 * The colour a diagram graphic is drawn in for a theme. Anything that is not
 * a #rgb / #rrggbb colour (none, a gradient reference …) is returned as is.
 */
export function themedColor(color: string, theme: Theme): string {
  const key = color.toLowerCase();
  const known = cache[theme].get(key);
  if (known !== undefined) return known;
  const rgb = parseHex(color);
  let out = color;
  // a light-theme colour that already stands out is kept exactly as written
  if (rgb && !(theme === 'light' && worst(color, theme) >= GRAPHIC_CONTRAST)) {
    let [h, s, l] = toHsl(rgb);
    if (theme === 'dark') s = Math.min(s * 0.78, 0.72);
    out = hex(toRgb([h, s, l]));
    // lighten (dark) or darken (light) in small steps until the graphic stands out from every surface
    const step = theme === 'dark' ? 0.02 : -0.02;
    for (let i = 0; i < 60 && worst(out, theme) < GRAPHIC_CONTRAST + 0.05; i++) {
      l = Math.max(0, Math.min(1, l + step));
      out = hex(toRgb([h, s, l]));
    }
  }
  cache[theme].set(key, out);
  return out;
}

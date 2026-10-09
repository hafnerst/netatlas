/**
 * The colour theme: Light or Dark. Dark is the default.
 *
 * The theme in effect is written to <html data-theme="light|dark">, which
 * switches every design token in styles.css at once; nothing is reloaded or
 * re-laid out. The stylesheet's tokens without that attribute are the dark
 * ones, and the script that sets it runs in the document's <head>, before
 * anything is drawn (see app/main.ts), so a stored Light theme is in effect
 * from the first paint and there is never a flash of the other theme.
 *
 * The choice is remembered in this browser's local storage (never in the
 * model file or an export). A stored "light" or "dark" is kept; anything else
 * (the "system" of earlier versions, an invalid value, nothing) means Dark.
 * Where storage is not available (some file:// setups, private windows),
 * the theme is Dark and a switch lasts for the session.
 */
import { Theme } from '../diagram/palette';

export type { Theme };

export const THEME_KEY = 'netatlas.theme';
export const DEFAULT_THEME: Theme = 'dark';

/** The theme a stored value stands for: Light only when "light" is stored, else Dark. */
export function storedTheme(value: string | null | undefined): Theme {
  return value === 'light' ? 'light' : DEFAULT_THEME;
}

export function otherTheme(t: Theme): Theme {
  return t === 'dark' ? 'light' : 'dark';
}

export function themeLabel(t: Theme): string {
  return t === 'dark' ? 'Dark' : 'Light';
}

/** What the theme button says: the current theme, and what pressing it does. */
export function themeButtonText(t: Theme): string {
  return `Theme: ${themeLabel(t)}. Switch to the ${themeLabel(otherTheme(t)).toLowerCase()} theme`;
}

function storage(win: Window | null): Storage | null {
  try {
    return win && win.localStorage ? win.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read the stored theme, tidying up what earlier versions or other tabs left
 * (a stored "system" or an invalid value is removed: nothing stored means Dark).
 */
export function readTheme(win: Window | null): Theme {
  const s = storage(win);
  if (!s) return DEFAULT_THEME;
  try {
    const v = s.getItem(THEME_KEY);
    if (v !== null && v !== 'light' && v !== 'dark') s.removeItem(THEME_KEY);
    return storedTheme(v);
  } catch {
    return DEFAULT_THEME;
  }
}

/** Put a theme into effect: the attribute every token depends on (and with it CSS color-scheme). */
export function applyTheme(doc: Document, t: Theme): void {
  doc.documentElement.setAttribute('data-theme', t);
}

export class ThemeController {
  theme: Theme;
  private listeners: Array<(theme: Theme) => void> = [];

  constructor(private doc: Document) {
    this.theme = readTheme(doc.defaultView);
    applyTheme(doc, this.theme);
  }

  /** Called with the theme after every switch. */
  onChange(fn: (theme: Theme) => void): void {
    this.listeners.push(fn);
  }

  set(t: Theme): void {
    this.theme = t;
    const s = storage(this.doc.defaultView);
    try {
      if (s) s.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    applyTheme(this.doc, t);
    for (const fn of this.listeners) fn(t);
  }

  /** The theme button: Light ⇄ Dark. */
  toggle(): void {
    this.set(otherTheme(this.theme));
  }
}

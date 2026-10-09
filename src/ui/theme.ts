/**
 * The colour theme: Light, Dark, or System (the default: follows the
 * operating system's prefers-color-scheme, also while the app runs).
 *
 * The theme in effect is written to <html data-theme="light|dark">, which
 * switches every design token in styles.css at once; nothing is reloaded or
 * re-laid out. The user's choice is remembered in this browser's local
 * storage (never in the model file or an export); where storage is not
 * available (some file:// setups, private windows) the choice simply lasts
 * for the session.
 */
import { Theme } from '../diagram/palette';

export type { Theme };
export type ThemePref = 'light' | 'dark' | 'system';

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
export const THEME_KEY = 'netatlas.theme';

/** The theme in effect for a choice, given whether the system prefers dark. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

/** The choice after `pref` when the theme button is pressed: System → Light → Dark → System. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length];
}

export function themePrefLabel(p: ThemePref): string {
  return p === 'system' ? 'System' : p === 'light' ? 'Light' : 'Dark';
}

/** What the theme button says: the current theme, and what pressing it does. */
export function themeButtonText(pref: ThemePref, theme: Theme): string {
  const now = pref === 'system' ? `System (${theme === 'dark' ? 'dark' : 'light'})` : themePrefLabel(pref);
  const next = nextThemePref(pref);
  return `Theme: ${now}. Switch to ${next === 'system' ? 'System (follow the operating system)' : themePrefLabel(next)}`;
}

function readStored(win: Window | null): ThemePref {
  try {
    const v = win && win.localStorage ? win.localStorage.getItem(THEME_KEY) : null;
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function store(win: Window | null, pref: ThemePref): void {
  try {
    if (!win || !win.localStorage) return;
    if (pref === 'system') win.localStorage.removeItem(THEME_KEY);
    else win.localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

export class ThemeController {
  pref: ThemePref;
  theme: Theme = 'light';
  private mql: MediaQueryList | null = null;
  private listeners: Array<(theme: Theme) => void> = [];

  constructor(private doc: Document) {
    const win = doc.defaultView;
    this.pref = readStored(win);
    try {
      this.mql = win && win.matchMedia ? win.matchMedia('(prefers-color-scheme: dark)') : null;
    } catch {
      this.mql = null;
    }
    const onSystem = (): void => {
      if (this.pref === 'system') this.apply();
    };
    if (this.mql) {
      if (this.mql.addEventListener) this.mql.addEventListener('change', onSystem);
      else if ((this.mql as MediaQueryList & { addListener?: (f: () => void) => void }).addListener) (this.mql as MediaQueryList & { addListener: (f: () => void) => void }).addListener(onSystem);
    }
    this.apply(true);
  }

  /** Called with the theme in effect after every change of the choice or of the system theme (not for the initial one). */
  onChange(fn: (theme: Theme) => void): void {
    this.listeners.push(fn);
  }

  systemDark(): boolean {
    return !!this.mql && this.mql.matches;
  }

  set(pref: ThemePref): void {
    this.pref = pref;
    store(this.doc.defaultView, pref);
    this.apply();
  }

  /** The theme button: System → Light → Dark → System. */
  cycle(): void {
    this.set(nextThemePref(this.pref));
  }

  private apply(initial = false): void {
    this.theme = resolveTheme(this.pref, this.systemDark());
    const root = this.doc.documentElement;
    root.setAttribute('data-theme', this.theme);
    root.setAttribute('data-theme-pref', this.pref);
    if (!initial) for (const fn of this.listeners) fn(this.theme);
  }
}

/**
 * What NetAtlas actually does for a protocol, a service or a profile: one
 * of three levels, with a short statement of what is simulated and what is
 * not. The definitions themselves carry it (model/sim-profiles.ts for the
 * protocols, model/service-registry.ts for the services,
 * model/applications.ts for the application profiles); the editor, the
 * Start simulation dialog and the documentation read it from there.
 *
 *   drawn       Diagram representation: drawn and documented (a custom
 *               protocol may send demonstration packets of its name); no
 *               behaviour of its own is checked or simulated.
 *   configured  Structured configuration and validation: its settings are
 *               read and checked against the model, its ports and
 *               references take part where they apply, its protocol
 *               exchanges are not simulated.
 *   modeled     Modeled runtime behaviour: the simulation runs its
 *               exchanges and state within the stated scope. Never "full
 *               support": `not` says what is left out.
 */

export type SupportLevel = 'drawn' | 'configured' | 'modeled';

export interface Support {
  level: SupportLevel;
  /** what it does at this level: what is simulated, or what is checked */
  does: string;
  /** what it does not do (the important limitations) */
  not: string;
}

export const SUPPORT_LEVELS: ReadonlyArray<{ id: SupportLevel; label: string; help: string }> = [
  { id: 'drawn', label: 'Diagram only', help: 'Drawn and documented; no behaviour of its own is checked or simulated.' },
  { id: 'configured', label: 'Configuration and validation', help: 'Its settings are checked against the model; its protocol exchanges are not simulated.' },
  { id: 'modeled', label: 'Modeled behavior', help: 'The simulation runs its exchanges and state, within the stated limits.' },
];

export function supportLabel(level: SupportLevel): string {
  return (SUPPORT_LEVELS.find((x) => x.id === level) as { label: string }).label;
}

/** The support as two short lines: "Modeled behavior: …" and "Not modeled: …". */
export function supportLines(s: Support): string[] {
  return [`${supportLabel(s.level)}: ${s.does}`, `Not modeled: ${s.not}`];
}

/** The support as one sentence, for a tooltip or a screen reader. */
export function supportText(s: Support): string {
  return supportLines(s).join(' ');
}

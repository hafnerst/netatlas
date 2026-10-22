/**
 * The result semantics every Analyze tool shares: what a conclusion says
 * (its verdict), what it was computed on (the configured model or a
 * simulation snapshot), how much of the architecture it covers, and what it
 * assumes or leaves out. One vocabulary, so that a "reachable" of Trace path,
 * a "satisfied" of a saved expectation and a dependency of the failure
 * analysis mean the same thing:
 *
 *   satisfied      the evaluated model establishes the requested condition
 *                  (reachable within scope, the expectation holds);
 *   violated       a modeled condition contradicts the requirement or
 *                  prevents the communication (blocked, unavailable);
 *   partial        evaluated alternatives give different outcomes (equal-cost
 *                  paths of which some reach and some stop);
 *   beyond         the path continues outside the represented architecture:
 *                  nothing about the rest is known;
 *   indeterminate  information the conclusion needs is missing (an address
 *                  only a DHCP server assigns at runtime, a next hop that is
 *                  not modeled …);
 *   unsupported    the analysis does not implement what the question needs
 *                  (a TCP session's return policy, a failure combined with a
 *                  snapshot).
 *
 * Only `satisfied` is a positive conclusion, and only within the model: no
 * verdict claims anything about a production network. There are no
 * percentages or confidence scores: counts say what was evaluated. Pure.
 */

export type Verdict = 'satisfied' | 'violated' | 'partial' | 'beyond' | 'indeterminate' | 'unsupported';

export const VERDICTS: readonly Verdict[] = ['satisfied', 'violated', 'partial', 'beyond', 'indeterminate', 'unsupported'];

/** The words of a verdict, per kind of question (the meaning is the same). */
export type VerdictTone = 'reach' | 'check' | 'service';

const WORDS: { [t in VerdictTone]: { [v in Verdict]: string } } = {
  reach: {
    satisfied: 'Reachable within scope',
    violated: 'Blocked',
    partial: 'Partially reachable',
    beyond: 'Beyond modeled scope',
    indeterminate: 'Indeterminate',
    unsupported: 'Unsupported',
  },
  check: {
    satisfied: 'Satisfied',
    violated: 'Violated',
    partial: 'Partially satisfied',
    beyond: 'Beyond modeled scope',
    indeterminate: 'Indeterminate',
    unsupported: 'Unsupported',
  },
  service: {
    satisfied: 'Available within scope',
    violated: 'Unavailable',
    partial: 'Partially available',
    beyond: 'Beyond modeled scope',
    indeterminate: 'Indeterminate',
    unsupported: 'Unsupported',
  },
};

export function verdictText(v: Verdict, tone: VerdictTone = 'check'): string {
  return WORDS[tone][v];
}

/** The mark shown before a verdict (never colour alone): ✓ ✕ ◐ ↗ ? –. */
export function verdictMark(v: Verdict): string {
  return v === 'satisfied' ? '✓' : v === 'violated' ? '✕' : v === 'partial' ? '◐' : v === 'beyond' ? '↗' : v === 'indeterminate' ? '?' : '–';
}

/**
 * The verdict of several conditions that must all hold: the first of
 * violated, indeterminate, unsupported, partial, beyond that occurs, else
 * satisfied. (An empty list is indeterminate: nothing was evaluated.)
 */
export function allOf(vs: Verdict[]): Verdict {
  if (!vs.length) return 'indeterminate';
  for (const v of ['violated', 'indeterminate', 'unsupported', 'partial', 'beyond'] as Verdict[]) if (vs.indexOf(v) >= 0) return v;
  return 'satisfied';
}

// ------------------------------------------------------------ context

/** What a result was computed on. */
export interface AnalysisContext {
  /** the model as configured, or a snapshot of a running simulation */
  kind: 'model' | 'snapshot';
  /** a snapshot's simulated time (ms) */
  at?: number;
  /** what the analysis covers, in words ("Entire architecture", "Selected endpoints", "Failure domain Rack A") */
  scope: string;
}

export function configuredContext(scope = 'Entire architecture'): AnalysisContext {
  return { kind: 'model', scope };
}

export function snapshotContext(at: number, scope = 'Entire architecture'): AnalysisContext {
  return { kind: 'snapshot', at, scope };
}

/** "t = 12.3 s" */
export function simTimeText(ms: number): string {
  const s = ms / 1000;
  return `t = ${s >= 100 ? Math.round(s) : Math.round(s * 10) / 10} s`;
}

/** The context line of a result: "Configured model · Entire architecture" or "Simulation snapshot at t = 12.3 s · Selected endpoints". */
export function contextText(c: AnalysisContext): string {
  const what = c.kind === 'model' ? 'Configured model' : `Simulation snapshot at ${simTimeText(c.at || 0)}`;
  return `${what} · ${c.scope}`;
}

/** What a configured-model result evaluates, and what a snapshot adds (the first assumption of every result). */
export function contextAssumption(c: AnalysisContext): string {
  return c.kind === 'model'
    ? 'Evaluates the configuration and the structural assumptions NetAtlas supports; addresses that DHCP or SLAAC assign at runtime are not known.'
    : 'Evaluates the simulation as it was at the snapshot: its effective addresses (DHCP leases, SLAAC and DHCPv6 addresses), what was up, and the learned routes; the simulation keeps running, the snapshot does not change.';
}

// ------------------------------------------------------------ coverage

/** How much of what could be evaluated was. */
export interface Coverage {
  checked: number;
  eligible: number;
  /** what is counted ("device pairs", "paths", "candidates") */
  unit: string;
  /** what was left out, in words */
  omitted?: string;
  /** a limit stopped the evaluation */
  truncated?: boolean;
  /** the user stopped it */
  cancelled?: boolean;
}

export function complete(c: Coverage): boolean {
  return c.checked >= c.eligible && !c.truncated && !c.cancelled;
}

/** "Checked 40 of 45 device pairs (limit reached); 5 omitted: …" */
export function coverageText(c: Coverage): string {
  const head = c.checked >= c.eligible && !c.truncated ? `Checked all ${c.eligible} ${c.unit}` : `Checked ${c.checked} of ${c.eligible} ${c.unit}`;
  const why = c.cancelled ? ' (stopped before the end)' : c.truncated ? ' (a limit was reached)' : '';
  return head + why + (c.omitted ? `; not checked: ${c.omitted}` : '');
}

// ------------------------------------------------------------ result info

/** What every result carries besides its findings. */
export interface ResultInfo {
  context: AnalysisContext;
  /** assumptions the conclusion depends on (short sentences) */
  assumptions: string[];
  /** what the analysis did not evaluate, or evaluated only in part */
  limits: string[];
  coverage?: Coverage;
}

export function resultInfo(context: AnalysisContext, assumptions: string[] = [], limits: string[] = [], coverage?: Coverage): ResultInfo {
  const out: ResultInfo = { context, assumptions: [contextAssumption(context)].concat(assumptions), limits: limits.slice() };
  if (coverage) out.coverage = coverage;
  return out;
}

/** The header of a text export: what, of which model, on what, with the application version. */
export function exportHeader(o: { analysis: string; title: string; info: ResultInfo; version?: string; outdated?: boolean }): string[] {
  const lines = [`${o.analysis} — ${o.title || 'Untitled model'}`];
  lines.push(`Context: ${contextText(o.info.context)}${o.outdated ? ' (outdated: the model changed after this result)' : ''}`);
  if (o.info.coverage) lines.push(`Coverage: ${coverageText(o.info.coverage)}`);
  if (o.version) lines.push(`NetAtlas ${o.version}`);
  return lines;
}

/** The footer of a text export: assumptions and limits. */
export function exportFooter(info: ResultInfo): string[] {
  const lines: string[] = [];
  if (info.assumptions.length) {
    lines.push('Assumptions:');
    for (const a of info.assumptions) lines.push('  - ' + a);
  }
  if (info.limits.length) {
    lines.push('Not evaluated:');
    for (const a of info.limits) lines.push('  - ' + a);
  }
  lines.push('A model-based result: it does not prove the behaviour of a production network.');
  return lines;
}

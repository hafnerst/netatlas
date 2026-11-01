/**
 * The panel workspaces: Simulate, Experiments and Analyze each repurpose the
 * same three panels around the diagram — left (setup), right (details) and
 * bottom (run and results) — in place of the Objects list and the
 * Inspector, with a banner row that names the workspace and its Exit, a
 * frame around the diagram (its colour and, beyond colour, its badge and
 * banner icon), and the menu of the workspace marked as current.
 *
 * One workspace is presented at a time (`data-workspace` on the body;
 * `data-panels` lays the panels out; `data-sim` stays "a simulation is
 * running"). Each panel holds one body per workspace and shows only the
 * current one, so a workspace's content (a simulation's controls) survives
 * while another is in front, and nothing is mounted twice.
 */

export type Workspace = 'edit' | 'simulate' | 'experiments' | 'analyze';

export interface WorkspaceText {
  /** the banner's and the badge's name */
  name: string;
  icon: string;
  left: string;
  right: string;
  bottom: string;
  /** the narrow layout's tabs (`results`: the bottom panel as a tab of its own, Analyze only) */
  tabs: { setup: string; actions: string; results?: string };
  /** the menu button marked current */
  menu: string;
}

export const WORKSPACES: { [k in Exclude<Workspace, 'edit'>]: WorkspaceText } = {
  simulate: { name: 'Simulation', icon: '◈', left: 'Simulation setup', right: 'Actions', bottom: 'Simulation panel', tabs: { setup: 'Setup', actions: 'Actions' }, menu: 'simulate-btn' },
  experiments: { name: 'Experiments', icon: '⧗', left: 'Experiments', right: 'Step', bottom: 'Experiment run', tabs: { setup: 'Experiment', actions: 'Step' }, menu: 'simulate-btn' },
  analyze: { name: 'Analyze', icon: '⌕', left: 'Question', right: 'Evidence', bottom: 'Answer and results', tabs: { setup: 'Question', actions: 'Evidence', results: 'Results' }, menu: 'analyze-btn' },
};

/** The bodies of each panel, by workspace. */
export const PANEL_BODIES: { [k in Exclude<Workspace, 'edit'>]: { left: string; right: string; bottom: string } } = {
  simulate: { left: 'sim-setup-body', right: 'sim-actions-body', bottom: 'sim-dock-body' },
  experiments: { left: 'ws-exp-left', right: 'ws-exp-right', bottom: 'ws-exp-dock' },
  analyze: { left: 'ws-an-left', right: 'ws-an-right', bottom: 'ws-an-dock' },
};

/**
 * Lay the panels out for a workspace (or take them away: 'edit'): titles,
 * accessible names, the bodies shown, the narrow layout's tab labels, the
 * menu button marked current. A body that is left keeps its content (its
 * owner clears it when its work ends).
 */
export function applyPanels(doc: Document, ws: Workspace): void {
  const body = doc.body;
  const on = ws !== 'edit';
  if (on) {
    body.setAttribute('data-panels', 'on');
    body.setAttribute('data-workspace', ws);
  } else {
    body.removeAttribute('data-panels');
    body.removeAttribute('data-workspace');
  }
  const show = (id: string, v: boolean): void => {
    const e = doc.getElementById(id) as HTMLElement | null;
    if (e) e.hidden = !v;
  };
  for (const id of ['sim-setup', 'sim-actions', 'sim-dock', 'sim-paneltabs']) show(id, on);
  // (the results as a tab of their own: Analyze only)
  show('spt-results', ws === 'analyze');
  for (const k of Object.keys(PANEL_BODIES) as Array<keyof typeof PANEL_BODIES>) {
    const b = PANEL_BODIES[k];
    for (const id of [b.left, b.right, b.bottom]) show(id, k === ws);
  }
  const t = on ? WORKSPACES[ws as Exclude<Workspace, 'edit'>] : null;
  const text = (id: string, v: string): void => {
    const e = doc.getElementById(id);
    if (e && e.textContent !== v) e.textContent = v;
  };
  if (t) {
    text('sim-setup-title', t.left);
    text('sim-actions-title', t.right);
    text('sim-dock-title', t.bottom);
    text('spt-setup', t.tabs.setup);
    text('spt-actions', t.tabs.actions);
    text('spt-results', t.tabs.results || '');
    const split = doc.getElementById('dock-splitter');
    if (split) split.setAttribute('aria-label', `Height of the ${t.bottom.toLowerCase()}`);
    const tabs = doc.getElementById('sim-paneltabs');
    if (tabs) tabs.setAttribute('aria-label', `${t.name} panels`);
  }
  for (const k of Object.keys(WORKSPACES) as Array<keyof typeof WORKSPACES>) {
    const b = doc.getElementById(WORKSPACES[k].menu);
    if (!b) continue;
    const cur = !!t && t.menu === WORKSPACES[k].menu;
    if (cur) b.setAttribute('aria-current', 'true');
    else if (!t || WORKSPACES[ws as keyof typeof WORKSPACES].menu !== WORKSPACES[k].menu) b.removeAttribute('aria-current');
  }
}

/** Is a key's target inside a workspace panel (its own controls: Escape there never leaves the workspace)? */
export function inWorkspacePanel(t: EventTarget | null): boolean {
  const e = t as Element | null;
  return !!e && typeof e.closest === 'function' && !!e.closest('#sim-setup, #sim-actions, #sim-dock, #sim-paneltabs, #mode-banner, .modal');
}

/**
 * The task areas of the Analyze workspace, in the order of the Analyze menu:
 * an overview that starts a question, then the four kinds of question. Each
 * shares one interaction model: the question on the left, the answer and its
 * results at the bottom, the evidence of what is selected on the right.
 * Focus is not one of them: it is a view aid of the diagram (a tool window),
 * available from every task.
 */
export type AnalyzeTask = 'overview' | 'communication' | 'resilience' | 'review' | 'addressing';

export const ANALYZE_TASKS: ReadonlyArray<{ id: AnalyzeTask; label: string; command: string; answers: string }> = [
  { id: 'overview', label: 'Overview', command: 'analyze.overview', answers: 'Where to start: the questions Analyze answers, what is known about this model, recent and pinned results' },
  { id: 'communication', label: 'Communication', command: 'trace.open', answers: 'Can this application or service communicate? What the configured architecture establishes, what blocks it, and what a modeled exchange observed' },
  { id: 'resilience', label: 'Resilience', command: 'analyze.spof', answers: 'What stops working, what remains available and what becomes uncertain when components are unavailable, and whether the stated traffic still fits' },
  { id: 'review', label: 'Design review', command: 'analyze.checks', answers: 'Does the architecture satisfy its saved requirements? What do the consistency checks find?' },
  { id: 'addressing', label: 'Addressing', command: 'analyze.addressing', answers: 'Where are addressing conflicts, overlaps and addresses outside the declared networks; how is each network allocated?' },
];

/** The modes inside Resilience and Design review. */
export type ResilienceMode = 'single' | 'outage' | 'capacity';
export type ReviewMode = 'findings' | 'requirements';

export const RESILIENCE_MODES: ReadonlyArray<{ id: ResilienceMode; label: string; command: string; help: string }> = [
  { id: 'single', label: 'Single-component failures', command: 'analyze.spof', help: 'Each cable, device and LAG failing alone: what it disconnects and what becomes unavailable' },
  { id: 'outage', label: 'Outage impact', command: 'analyze.outage', help: 'The components you choose made unavailable together, compared with the same architecture without the outage' },
  { id: 'capacity', label: 'Capacity', command: 'analyze.capacity', help: 'The stated demands against the stated capacity, with or without a failure condition' },
];

export const REVIEW_MODES: ReadonlyArray<{ id: ReviewMode; label: string; command: string; help: string }> = [
  { id: 'findings', label: 'Findings', command: 'analyze.findings', help: 'What the consistency checks find in the model, by category, severity and object' },
  { id: 'requirements', label: 'Requirements', command: 'analyze.checks', help: 'The requirements saved with the model, evaluated when you ask' },
];

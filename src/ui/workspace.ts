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
  /** the narrow layout's tabs */
  tabs: { setup: string; actions: string };
  /** the menu button marked current */
  menu: string;
}

export const WORKSPACES: { [k in Exclude<Workspace, 'edit'>]: WorkspaceText } = {
  simulate: { name: 'Simulation', icon: '◈', left: 'Simulation setup', right: 'Actions', bottom: 'Simulation panel', tabs: { setup: 'Setup', actions: 'Actions' }, menu: 'simulate-btn' },
  experiments: { name: 'Experiments', icon: '⧗', left: 'Experiments', right: 'Step', bottom: 'Experiment run', tabs: { setup: 'Experiment', actions: 'Step' }, menu: 'simulate-btn' },
  analyze: { name: 'Analyze', icon: '⌕', left: 'Analyze', right: 'Details', bottom: 'Analysis results', tabs: { setup: 'Request', actions: 'Details' }, menu: 'analyze-btn' },
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

/** The tools of the Analyze workspace, in the order of the Analyze menu. */
export type AnalyzeTool = 'trace' | 'addressing' | 'spof' | 'checks' | 'focus';

export const ANALYZE_TOOLS: ReadonlyArray<{ id: AnalyzeTool; label: string; command: string; help: string }> = [
  { id: 'trace', label: 'Trace path', command: 'trace.open', help: 'Whether a source reaches a destination and can use its application or service' },
  { id: 'addressing', label: 'Addressing', command: 'analyze.addressing', help: 'The networks of each VRF, their members, allocation and conflicts' },
  { id: 'spof', label: 'Single points of failure', command: 'analyze.spof', help: 'What one failure cuts off or takes away; What if for several' },
  { id: 'checks', label: 'Design checks', command: 'analyze.checks', help: 'The saved expectations and the consistency findings' },
  { id: 'focus', label: 'Focus', command: 'focus.window', help: 'Only an object and its neighbourhood, or a context (VLAN, VRF, dependencies)' },
];

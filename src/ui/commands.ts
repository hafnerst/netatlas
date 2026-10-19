/**
 * The command registry: every action of the menus, the toolbar and the
 * keyboard, with its label, group, shortcut, availability (with the reason
 * when it is not available) and what it does. The menus take their labels,
 * shortcut hints, availability and tooltips from it (App.syncCommands, for
 * every element with data-command), the keyboard shortcuts are dispatched
 * through it (App's keydown handler), and the command palette lists it, so
 * the three can't drift apart.
 */
import type { App } from './app';
import { EXAMPLES } from '../generated/examples';
import { STRATEGIES, STRATEGY_HINT, STRATEGY_KEYWORDS, STRATEGY_LABEL } from '../layout/strategies';
import { FOCUS_MAX_HOPS, FOCUS_MIN_HOPS } from '../analysis/focus';

export type CommandGroup = 'File' | 'Example' | 'Export' | 'Find' | 'Analyze' | 'Simulate' | 'Window' | 'Help' | 'Edit' | 'View' | 'Auto-arrange' | 'Filters' | 'Zoom' | 'Panel' | 'Theme';

export interface CommandState {
  enabled: boolean;
  /** why it is not available (shown instead of the title) */
  reason?: string;
  /** the tooltip while available */
  title?: string;
  /** a switch: is it on? */
  checked?: boolean;
}

/** One key combination: `key` as KeyboardEvent.key; `mod` = Ctrl, or Cmd on macOS. */
export interface KeyCombo {
  key: string;
  mod?: boolean;
  shift?: boolean;
}

export interface KeySpec {
  combos: KeyCombo[];
  /** also while typing in a field (Save, the palette) */
  whileTyping?: boolean;
}

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  keys?: KeySpec;
  /** more words the palette finds it by */
  keywords?: string;
  /** an analysis mode or view (listed as such in the palette) */
  mode?: boolean;
  /** it edits the model: unavailable while editing is paused (a simulation is on), saying why */
  edits?: boolean;
  /** the label in a menu, where the menu says the rest ("PNG" under "Export view as…"); default: label */
  menuLabel?: string;
  /** what its shortcut does while the command itself is unavailable (Ctrl+S: Save as); returns whether it acted */
  keyFallback?: (app: App) => boolean;
  state(app: App): CommandState;
  run(app: App): void;
}

const NO_MODEL = 'Open or create a model first';

/** Is this a Mac (Cmd instead of Ctrl)? */
export function isMac(win: Window | null): boolean {
  const nav = win ? win.navigator : null;
  return !!nav && /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent || '');
}

/** How a shortcut is written: "Ctrl+S" ("Cmd+S" on a Mac), "Shift+F", "/", "P"; alternatives with " or ". */
export function keyLabel(k: KeySpec | undefined, mac = false): string {
  if (!k) return '';
  const one = (c: KeyCombo): string => {
    const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
    return (c.mod ? (mac ? 'Cmd+' : 'Ctrl+') : '') + (c.shift ? 'Shift+' : '') + key;
  };
  return one(k.combos[0]);
}

/** Does a key press match a shortcut? (Alt never does; letters with Ctrl/Cmd match either case, Shift is checked when the combination says.) */
export function matchesKey(k: KeySpec, e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  if (e.altKey) return false;
  const mod = e.ctrlKey || e.metaKey;
  return k.combos.some((c) => {
    if (!!c.mod !== mod) return false;
    if (c.shift !== undefined && c.shift !== e.shiftKey) return false;
    return c.mod ? e.key.toLowerCase() === c.key.toLowerCase() : e.key === c.key;
  });
}

const on = (title?: string): CommandState => ({ enabled: true, title });
const off = (reason: string): CommandState => ({ enabled: false, reason });

/** The commands of the application (examples included), in menu order. */
export function buildCommands(): Command[] {
  const needModel = (app: App, title?: string): CommandState => (app.mdoc ? on(title) : off(NO_MODEL));
  const needDiagram = (app: App, title?: string): CommandState => (app.session ? on(title) : off(NO_MODEL));
  const list: Command[] = [
    // ---------------------------------------------------------------- File
    { id: 'file.new', label: 'New model', group: 'File', keywords: 'create empty', state: () => on('Start a new, empty model'), run: (app) => void app.requestNew() },
    { id: 'file.open', label: 'Open model…', group: 'File', keywords: 'load yaml file', state: () => on('Open a model from a YAML file on this computer (nothing is uploaded)'), run: (app) => void app.requestOpen() },
    {
      id: 'file.save',
      label: 'Save model',
      group: 'File',
      keys: { combos: [{ key: 's', mod: true, shift: false }], whileTyping: true },
      keywords: 'write',
      state: (app) => {
        const d = app.mdoc;
        if (!d) return off(NO_MODEL);
        const name = app.linkedFileName;
        return name ? on(`Save the model to “${name}” (Ctrl+S)${d.dirty ? '; it has unsaved changes' : ''}`) : off('Not available: the model is not linked to a file this page may write. Use Save model as… to choose one.');
      },
      run: (app) => void app.save(),
      // Ctrl+S on a model that isn't linked to a file: Save model as…
      keyFallback: (app) => {
        if (!app.mdoc) return false;
        void app.save();
        return true;
      },
    },
    {
      id: 'file.saveAs',
      label: 'Save model as…',
      group: 'File',
      keys: { combos: [{ key: 's', mod: true, shift: true }], whileTyping: true },
      keywords: 'download copy',
      state: (app) =>
        needModel(
          app,
          app.fileAccess.saveFile
            ? 'Choose a file name and location, and save the model there as a YAML file; Save model then updates that file (Ctrl+Shift+S)'
            : 'Download a copy of the model as a YAML file: this browser can’t save to a file you choose (Ctrl+Shift+S)',
        ),
      run: (app) => void app.saveModelAs(),
    },
    { id: 'file.close', label: 'Close model', group: 'File', state: (app) => needModel(app, 'Close the current model and return to the start screen'), run: (app) => void app.closeModelDialog() },
    // -------------------------------------------------------------- Export
    { id: 'export.png', label: 'Export view as PNG', menuLabel: 'PNG', group: 'Export', keywords: 'picture image save', state: (app) => needDiagram(app, app.session ? `Save the ${app.session.state.view} view as a PNG image` : ''), run: (app) => void app.exportView('png') },
    { id: 'export.svg', label: 'Export view as SVG', menuLabel: 'SVG', group: 'Export', keywords: 'picture vector drawing save', state: (app) => needDiagram(app, app.session ? `Save the ${app.session.state.view} view as an SVG file` : ''), run: (app) => void app.exportView('svg') },
    // ---------------------------------------------------------------- Find
    {
      id: 'find.diagram',
      label: 'Find in diagram…',
      group: 'Find',
      keys: { combos: [{ key: '/' }] },
      keywords: 'search',
      state: (app) => needDiagram(app, 'Find a device, interface, network, relation … in the diagram by id, label, address or protocol, and select it (/)'),
      run: (app) => void app.openFind(),
    },
    {
      id: 'find.outline',
      label: 'Filter object list…',
      group: 'Find',
      keywords: 'outline search',
      state: (app) => needModel(app, 'Filter the object list (model outline) at the left: show only the entries whose name or id contains a text. The diagram is not changed.'),
      run: (app) => void app.openOutlineFilter(),
    },
    {
      id: 'palette.open',
      label: 'Command palette…',
      group: 'Find',
      keys: { combos: [{ key: 'k', mod: true }], whileTyping: true },
      keywords: 'commands actions run go to',
      state: () => on('Search every action and every object of the model, and run or select it (Ctrl+K)'),
      run: (app) => void app.openPalette(),
    },
    // ------------------------------------------------------------- Analyze
    {
      id: 'analyze.addressing',
      label: 'Addressing overview…',
      group: 'Analyze',
      mode: true,
      keys: { combos: [{ key: 'i' }] },
      keywords: 'ip addresses networks prefixes subnets ipam free vrf window',
      state: (app) => needDiagram(app, 'A window with the networks of each VRF: members, gateways, use and free addresses; duplicates, overlaps and addresses in no network (I)'),
      run: (app) => void app.openAddressing(),
    },
    {
      id: 'focus.window',
      label: 'Focus…',
      group: 'Analyze',
      mode: true,
      keys: { combos: [{ key: 'F', shift: true }] },
      keywords: 'focus on selection neighbourhood neighborhood hops isolate window',
      state: (app) => {
        const s = app.session;
        if (!s) return off(NO_MODEL);
        const sel = s.state.selected;
        return on(sel && app.canFocus(sel) ? `A window to show only ${app.refName(sel)} and what is within 1–3 hops of it; with a selection it focuses at once (Shift+F)` : 'A window to show only an object and its neighbourhood: select one, then Focus (Shift+F)');
      },
      run: (app) => app.openFocusWindow(true),
    },
    {
      id: 'focus.enter',
      label: 'Focus on selection',
      group: 'Analyze',
      mode: true,
      keywords: 'neighbourhood neighborhood hops isolate',
      state: (app) => {
        const s = app.session;
        if (!s) return off(NO_MODEL);
        const sel = s.state.selected;
        if (!sel) return off('Select an object first: its neighbourhood is shown');
        if (!app.canFocus(sel)) return off('The selection has no device to start from');
        const f = s.state.focus;
        if (f && f.ref === sel) return off('Focus mode already shows the selection');
        return on(`Show only ${app.refName(sel)} and what is within ${f ? f.hops : 1} hop${f && f.hops > 1 ? 's' : ''} of it`);
      },
      run: (app) => app.enterFocus(),
    },
    {
      id: 'focus.more',
      label: 'Focus: one hop more',
      group: 'Analyze',
      mode: true,
      keywords: 'neighbourhood neighborhood hops wider',
      state: (app) => {
        const f = app.session ? app.session.state.focus : null;
        if (!f) return off('Focus mode is off');
        if (f.context) return off('A contextual focus shows what the object takes part in: it has no hops');
        return f.hops >= FOCUS_MAX_HOPS ? off(`Focus mode shows ${FOCUS_MAX_HOPS} hops at most`) : on(`Show ${f.hops + 1} hops around the focused object`);
      },
      run: (app) => app.changeFocusHops(1),
    },
    {
      id: 'focus.fewer',
      label: 'Focus: one hop fewer',
      group: 'Analyze',
      mode: true,
      keywords: 'neighbourhood neighborhood hops narrower',
      state: (app) => {
        const f = app.session ? app.session.state.focus : null;
        if (!f) return off('Focus mode is off');
        if (f.context) return off('A contextual focus shows what the object takes part in: it has no hops');
        return f.hops <= FOCUS_MIN_HOPS ? off(`Focus mode shows ${FOCUS_MIN_HOPS} hop at least`) : on(`Show ${f.hops - 1} hop${f.hops - 1 > 1 ? 's' : ''} around the focused object`);
      },
      run: (app) => app.changeFocusHops(-1),
    },
    {
      id: 'focus.exit',
      label: 'Exit focus',
      group: 'Analyze',
      mode: true,
      keywords: 'leave end complete diagram',
      state: (app) => (app.session && app.session.state.focus ? on('Show the complete diagram again (Esc)') : off('Focus mode is off')),
      run: (app) => app.exitFocus(),
    },
    {
      id: 'trace.open',
      label: 'Trace path…',
      group: 'Analyze',
      mode: true,
      keys: { combos: [{ key: 't' }] },
      keywords: 'path route forwarding hops traceroute reachability ecmp return window',
      state: (app) => needDiagram(app, 'A window that traces the way traffic takes from a source to a destination, hop by hop, by the routes and adjacencies of the model (T)'),
      run: (app) => app.openTrace(),
    },
    {
      id: 'trace.copy',
      label: 'Copy path trace as text',
      group: 'Analyze',
      mode: true,
      keywords: 'hop list clipboard',
      state: (app) => (app.currentTrace() ? on('Copy the hop list of the path trace as plain text') : off('No path is traced')),
      run: (app) => void app.copyTrace(),
    },
    {
      id: 'trace.exit',
      label: 'Exit path trace',
      group: 'Analyze',
      mode: true,
      keywords: 'leave end clear remove path',
      state: (app) => (app.currentTrace() ? on('Remove the traced path from the diagram') : off('No path is traced')),
      run: (app) => app.exitTrace(),
    },
    {
      id: 'analyze.spof',
      label: 'Single points of failure…',
      group: 'Analyze',
      mode: true,
      keywords: 'spof redundancy partition resilience failure report n-1 window csv',
      state: (app) => needDiagram(app, 'A window with the cables, devices and LAGs whose failure alone cuts the network, brings relations down or makes configured services unavailable, and what-if checks of failure domains'),
      run: (app) => app.openSpof(),
    },
    {
      id: 'analyze.checks',
      label: 'Design checks…',
      group: 'Analyze',
      mode: true,
      keywords: 'expectations requirements policy blocked available consistency findings problems validation design review',
      state: (app) => needDiagram(app, 'A window with the saved expectations (evaluated statically, on demand) and the consistency findings, grouped, with their consequences and next steps'),
      run: (app) => app.openDesignChecks(),
    },
    // ---------------------------------------------------------- tool windows
    {
      id: 'window.focus',
      label: 'Move the focus to the next region',
      group: 'Window',
      keys: { combos: [{ key: 'F6', shift: false }], whileTyping: true },
      keywords: 'region panel switch focus keyboard f6 left right bottom diagram tool window',
      state: () => on('Move the keyboard focus to the next region: the left panel, the diagram, the right panel, the simulation panel, a tool window (F6; Shift+F6 back)'),
      run: (app) => app.focusRegion(1),
    },
    {
      id: 'window.focusBack',
      label: 'Move the focus to the previous region',
      group: 'Window',
      keys: { combos: [{ key: 'F6', shift: true }], whileTyping: true },
      keywords: 'region panel switch focus keyboard shift f6 back',
      state: () => on('Move the keyboard focus to the previous region (Shift+F6)'),
      run: (app) => app.focusRegion(-1),
    },
    {
      id: 'window.close',
      label: 'Close the tool window',
      group: 'Window',
      keywords: 'tool window close dismiss',
      state: (app) => (app.toolWindowOpen() ? on('Close the open tool window (Esc inside it)') : off('No tool window is open')),
      run: (app) => app.closeToolWindow(),
    },
    // ------------------------------------------------------------ Simulate
    {
      id: 'sim.start',
      label: 'Start simulation…',
      group: 'Simulate',
      mode: true,
      keywords: 'start protocol simulation ospf bgp arp hello packets messages simulate window layer 2',
      // the same three states in the menu and the palette: no model; a model, nothing running; a simulation running
      state: (app) => (!app.hasModel() ? off('Open or create a model first') : app.simulationOn() ? off('A simulation is already running') : on('Choose the protocols and start the protocol simulation: a freshly booted network, its messages as labelled dots')),
      run: (app) => void app.openStartDialog(),
    },
    {
      id: 'edit.bulk-ports',
      label: 'Bulk edit ports…',
      group: 'Find',
      keywords: 'bulk edit ports vlan many several access trunk native add remove batch',
      state: (app) => {
        if (!app.session) return off('Open or create a model first');
        if (app.editLock()) return off(app.editLock());
        return app.bulkTarget() ? on('One VLAN change on several ports of the selected device, previewed, as one undo step') : off('Select a device with ports');
      },
      run: (app) => void app.openBulkPorts(),
    },
    {
      id: 'find.browse',
      label: 'Applications, VLANs and VRFs…',
      group: 'Find',
      keywords: 'browse navigate application app vlan vrf list focus context large model',
      state: (app) => needDiagram(app, 'A window listing every application, VLAN and VRF, each with Focus on the devices it involves'),
      run: (app) => app.openBrowse(),
    },
    {
      id: 'view.collapse',
      label: 'Collapse group',
      group: 'Find',
      keywords: 'collapse group site room rack box fold hide members summarize large model',
      state: (app) => {
        const g = app.collapseTarget();
        if (!app.session) return off('Open or create a model first');
        if (g === null) return off('Select a group, or a device in one');
        return app.session.state.collapsed.has(g) ? off('This group is drawn as one box already') : on('Draw the group as one box; its connections out of it go to the box (display only)');
      },
      run: (app) => app.setGroupCollapsed(app.collapseTarget(), true),
    },
    {
      id: 'view.expand',
      label: 'Expand group',
      group: 'Find',
      keywords: 'expand group uncollapse unfold show members',
      state: (app) => {
        const g = app.collapseTarget();
        if (!app.session) return off('Open or create a model first');
        return g !== null && app.session.state.collapsed.has(g) ? on('Draw the group’s devices again') : off('Select a collapsed group');
      },
      run: (app) => app.setGroupCollapsed(app.collapseTarget(), false),
    },
    {
      id: 'view.expand-all',
      label: 'Expand all groups',
      group: 'Find',
      keywords: 'expand all groups uncollapse unfold',
      state: (app) => (app.session && app.session.state.collapsed.size ? on('Draw every collapsed group’s devices again') : off('No group is collapsed')),
      run: (app) => app.expandAllGroups(),
    },
    {
      id: 'view.saved',
      label: 'Saved views…',
      group: 'Find',
      keywords: 'view saved save named viewport focus filters bookmark layout display',
      state: (app) => needDiagram(app, 'A window with the model’s saved views: open one, or save the diagram, focus, filters and zoom on screen as one'),
      run: (app) => app.openSavedViews(),
    },
    {
      id: 'sim.experiments',
      label: 'Experiments…',
      group: 'Simulate',
      mode: true,
      keywords: 'experiment repeatable scenario run actions observations compare baseline failure test sequence',
      state: (app) => (app.workspace() === 'experiments' ? off('Experiments is open') : needDiagram(app, 'The Experiments workspace: build an experiment’s actions and observations, run it from its defined start, inspect and compare the results (nothing runs until Run)')),
      run: (app) => void app.enterExperiments(),
    },
    {
      id: 'ws.exit',
      label: 'Exit workspace',
      menuLabel: 'Exit workspace',
      group: 'Simulate',
      mode: true,
      keywords: 'exit leave close experiments analyze workspace back to editing',
      state: (app) => (app.workspace() === 'experiments' || app.workspace() === 'analyze' ? on(app.workspace() === 'experiments' ? 'Back to editing: Exit Experiments' : 'Back from Analyze') : off('No Experiments or Analyze workspace is open')),
      run: (app) => void app.exitWorkspace(),
    },
    {
      id: 'sim.exit',
      label: 'Exit simulation',
      group: 'Simulate',
      mode: true,
      keywords: 'simulation leave end normal edit',
      state: (app) => (app.simulationOn() ? on('End the simulation: the model’s own state, and editing again (Esc)') : off('No simulation is on')),
      run: (app) => app.exitSimulation(),
    },
    {
      id: 'protocol.enable',
      edits: true,
      label: 'Enable a protocol on the selected device…',
      group: 'Edit',
      keywords: 'routing service bgp ospf isis vrrp hsrp bfd static router id as number',
      state: (app) => {
        const why = app.protocolTargetBlocked();
        return why ? off(why) : on('Open the selected device’s Protocols section, at the list of protocols to enable');
      },
      run: (app) => app.openEnableProtocol(),
    },
    {
      id: 'helper.mac',
      edits: true,
      label: 'Generate a MAC address for the selected interface',
      group: 'Edit',
      keywords: 'mac address random locally administered',
      state: (app) => {
        const why = app.interfaceHelperBlocked('mac');
        return why ? off(why) : on('A random, locally administered unicast MAC address that no interface has, in the model’s style (one undo step)');
      },
      run: (app) => app.applyInterfaceHelper('mac'),
    },
    {
      id: 'helper.mtu',
      edits: true,
      label: 'Set the MTU of the selected interface to 1500',
      group: 'Edit',
      keywords: 'mtu ethernet standard 1500',
      state: (app) => {
        const why = app.interfaceHelperBlocked('mtu');
        return why ? off(why) : on('The standard Ethernet MTU (one undo step)');
      },
      run: (app) => app.applyInterfaceHelper('mtu'),
    },
    // ---------------------------------------------------------------- Help
    { id: 'help.manual', label: 'User Manual', group: 'Help', keywords: 'guide documentation', state: () => on('A short guide to NetAtlas’s basic tasks, with pictures'), run: (app) => void app.openHelp('manual') },
    { id: 'help.license', label: 'License', group: 'Help', keywords: 'apache', state: () => on('The license NetAtlas is distributed under (Apache License, Version 2.0)'), run: (app) => void app.openHelp('license') },
    // ---------------------------------------------------------------- Edit
    {
      id: 'edit.undo',
      label: 'Undo',
      group: 'Edit',
      keys: { combos: [{ key: 'z', mod: true, shift: false }] },
      state: (app) => {
        const u = app.mdoc ? app.mdoc.canUndo() : '';
        if (u && app.mdoc && app.mdoc.undoLocked()) return off(`Editing is paused during the simulation: “${u}” can be undone after it`);
        return u ? on(`Undo: ${u} (Ctrl+Z)`) : off(app.mdoc ? 'Nothing to undo' : NO_MODEL);
      },
      run: (app) => app.undo(),
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      group: 'Edit',
      keys: { combos: [{ key: 'y', mod: true }, { key: 'z', mod: true, shift: true }] },
      state: (app) => {
        const r = app.mdoc ? app.mdoc.canRedo() : '';
        if (r && app.mdoc && app.mdoc.undoLocked(true)) return off(`Editing is paused during the simulation: “${r}” can be redone after it`);
        return r ? on(`Redo: ${r} (Ctrl+Y)`) : off(app.mdoc ? 'Nothing to redo' : NO_MODEL);
      },
      run: (app) => app.redo(),
    },
    {
      id: 'edit.connect',
      edits: true,
      label: 'Connect the selected object',
      group: 'Edit',
      keys: { combos: [{ key: 'c' }] },
      keywords: 'link relation cable new',
      state: (app) => {
        const s = app.session;
        if (!s) return off(NO_MODEL);
        const sel = s.state.selected;
        return sel && /^(device|iface):/.test(sel) ? on('Start a new link or relation from the selected device or interface (C)') : off('Select a device or an interface first');
      },
      run: (app) => app.connectFromSelection(),
    },
    // ---------------------------------------------------------------- View
    ...(['physical', 'logical'] as const).map(
      (v): Command => ({
        id: 'view.' + v,
        label: v === 'physical' ? 'Physical view' : 'Logical view',
        group: 'View',
        keys: { combos: [{ key: v === 'physical' ? 'p' : 'l' }, { key: v === 'physical' ? '1' : '2' }] },
        keywords: v === 'physical' ? 'cables ports layer 1 2' : 'relations protocols tunnels networks layer 3',
        state: (app) => (!app.session ? off(NO_MODEL) : app.session.state.view === v ? off(`The ${v} view is shown`) : on(`Show the ${v} view (${v === 'physical' ? 'P' : 'L'})`)),
        run: (app) => app.setView(v),
      }),
    ),
    ...STRATEGIES.map(
      (st): Command => ({
        id: 'arrange.' + st,
        edits: true,
        label: 'Auto-arrange: ' + STRATEGY_LABEL[st],
        group: 'Auto-arrange',
        keys: st === 'default' ? { combos: [{ key: 'a' }] } : undefined,
        keywords: STRATEGY_KEYWORDS[st],
        state: (app) => {
          const why = app.arrangeBlocked(st);
          return why ? off(why) : on(`Arrange the view on screen: ${STRATEGY_LABEL[st]} — ${STRATEGY_HINT[st]}`);
        },
        run: (app) => void app.arrangeCurrentView(st),
      }),
    ),
    // ------------------------------------------------------------- Filters
    ...(
      [
        ['opt-labels', 'Labels', 'Cable, relation and address labels', false],
        ['opt-groups', 'Groups / Locations', 'The frames of groups and locations', false],
        ['opt-networks', 'Networks', 'Network nodes and their membership lines', true],
        ['opt-routes', 'Routes', 'Route tables and next-hop lines', true],

      ] as Array<[string, string, string, boolean]>
    ).map(
      ([el, name, what, logical]): Command => ({
        id: 'filter.' + el.replace(/^opt-/, ''),
        label: `Show ${name}`,
        group: 'Filters',
        keywords: 'filter hide toggle ' + what.toLowerCase(),
        state: (app) => {
          if (!app.session) return off(NO_MODEL);
          if (logical && app.session.state.view !== 'logical') return off(`${name} is a filter of the logical view`);
          const checked = app.optionChecked(el);
          return { enabled: true, checked, title: `${what}: ${checked ? 'shown — switch off' : 'hidden — switch on'}` };
        },
        run: (app) => app.toggleOption(el),
      }),
    ),
    {
      id: 'filter.devices',
      label: 'Choose devices…',
      group: 'Filters',
      keywords: 'filter subset devices select',
      state: (app) => needDiagram(app, 'Choose the devices the diagram shows'),
      run: (app) => app.openDevicesFilter(),
    },
    {
      id: 'filter.types',
      label: 'Choose device types…',
      group: 'Filters',
      keywords: 'filter device types endpoints servers switches routers hide',
      state: (app) => needDiagram(app, 'Choose the device types the diagram shows'),
      run: (app) => app.openTypesFilter(),
    },
    // ---------------------------------------------------------------- Zoom
    { id: 'zoom.in', label: 'Zoom in', group: 'Zoom', keys: { combos: [{ key: '+' }, { key: '=' }] }, state: (app) => needDiagram(app, 'Zoom in (+)'), run: (app) => app.zoomBy(1.25) },
    { id: 'zoom.out', label: 'Zoom out', group: 'Zoom', keys: { combos: [{ key: '-' }] }, state: (app) => needDiagram(app, 'Zoom out (−)'), run: (app) => app.zoomBy(0.8) },
    { id: 'zoom.fit', label: 'Fit to screen', group: 'Zoom', keys: { combos: [{ key: '0' }, { key: 'f' }] }, keywords: 'zoom whole all', state: (app) => needDiagram(app, 'Fit to screen (0)'), run: (app) => app.fit() },
    // --------------------------------------------------------------- Panel
    ...(
      [
        ['edit', 'Edit', 'e'],
        ['details', 'Details', ''],
        ['legend', 'Legend', ''],
        ['relations', 'Relations', ''],
        ['problems', 'Problems', ''],
        ['yaml', 'YAML', ''],
      ] as Array<['edit' | 'details' | 'legend' | 'relations' | 'problems' | 'yaml', string, string]>
    ).map(
      ([tab, name, key]): Command => ({
        id: 'panel.' + tab,
        label: `${name} tab`,
        group: 'Panel',
        keys: key ? { combos: [{ key }] } : undefined,
        keywords: tab === 'problems' ? 'errors warnings checks findings' : tab === 'yaml' ? 'source text' : '',
        state: () => on(`Open the ${name} tab of the side panel`),
        run: (app) => app.showTab(tab),
      }),
    ),
    // --------------------------------------------------------------- Theme
    {
      id: 'theme.toggle',
      label: 'Switch theme (light / dark)',
      group: 'Theme',
      keywords: 'dark light colour color mode',
      state: (app) => on(`The theme is ${app.theme.theme === 'dark' ? 'Dark' : 'Light'}: switch to the ${app.theme.theme === 'dark' ? 'light' : 'dark'} theme`),
      run: (app) => app.theme.toggle(),
    },
    // ------------------------------------------------------------- Examples
    ...EXAMPLES.map(
      (ex, n): Command => ({
        id: 'example.' + n,
        label: 'Open example: ' + ex.name,
        group: 'Example',
        keywords: (/^title:\s*(.+)$/m.exec(ex.text) || ['', ''])[1] + ' sample demo',
        state: () => on(`Open the example ${ex.name}`),
        run: (app) => void app.requestExample(n),
      }),
    ),
  ];
  // a command that edits the model is unavailable while editing is paused, and says why
  for (const c of list) {
    if (!c.edits) continue;
    const inner = c.state;
    c.state = (app) => (app.editLock() ? off('Editing is paused during the simulation: exit it first (Esc)') : inner(app));
  }
  return list;
}

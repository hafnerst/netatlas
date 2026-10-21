/**
 * Browser UI shell: one page that is both the visualizer and the editor.
 *
 * Everything is local: files are read with the File API after an explicit
 * user action (file picker or drag-and-drop), edited in memory, and saved by
 * letting the browser download a new copy. Nothing is transmitted.
 */
import { IPV6_PLACEHOLDER, LEASE_PLACEHOLDER } from '../model/addresses';
import { ENTITY_KINDS, EditLocked, EntityKind, ModelDoc, Origin, ifaceSchemaKind } from '../editor/document';
import type { Path } from '../editor/document';
import { FileAccess, PngPicture, WritableFile, detectFileAccess, downloadBlob, downloadText, exportFileName, isCancel, isWritable, pictureBaseName, readTextFile, safeYamlFileName, svgToPng, writeFile } from './files';
import { Pt } from '../layout/geometry';
import { ArrangeStrategy, STRATEGIES, STRATEGY_LABEL, STRATEGY_ROUTING } from '../layout/strategies';
import { compatibleEndpoints, connectionKind, endpointName, endpointOfRef, endpointProblem, endpointRef, pairProblem } from '../model/connect';
import { Device, Endpoint, Model } from '../model/types';
import { el, materialize, mount, setPaint } from './dom';
import { ThemeController, themeButtonText } from './theme';
import { inlineComputedStyles, resolvedPaint } from './export-style';
import { SURFACES, themedColor } from '../diagram/palette';
import { DialogOpts, closeDialogWith, showDialog, showToast } from './dialogs';
import { licenseBody, manualBody } from './help';
import { Editor, EditorSel, SelDetail } from './inspector';
import { LineRange, yamlBlock } from '../editor/yaml-block';
import { EXAMPLES } from '../generated/examples';
import { findExample } from './examples';
import { Rect } from '../layout/geometry';
import { IssueCount, detailsFor, headOf, legendFor, relationList, tooltipFor } from './panels';
import { exportBoxes } from '../diagram/networks-box';
import { Session, View } from '../diagram/session';
import { SelectionContext, attachedRefs, search, selectionContext, splitRef } from '../model/queries';
import { sortedByName } from '../model/order';
import { lookupProtocol, normalizeProtocol } from '../model/protocols';
import { hostOf, isGuest, machineOf } from '../model/virtual';
import { DEVICE_TYPES, deviceTypeInText, typeKey, typeKeyLabel, typeKeySubLabel, typeKeysOf } from '../model/device-types';
import { isLayer2Switch, capabilities, ROUTING_PROTOCOL_TYPES } from '../model/capabilities';
import { Issue } from '../validation/validate';
import { Finding, SEVERITIES, Severity, checkById } from '../analysis/checks';
import { AddressingOverview, addressingOverview } from '../analysis/addressing';
import { FocusContext, contextFocus, focusContexts, focusSeeds, navigationIndex } from '../analysis/focus';
import { Trace, TraceRequest, pathRefs, traceRefs } from '../analysis/trace';
import { TraceForm, TraceRun, formRequest, newTraceForm, traceExportText, traceSummary, traceVerdict, traceWindowBody } from './trace';
import { CommRequest, checkCommunication } from '../analysis/communication';
import { commIdentity, compareRun, expectationFields, handoffOf, planMatches, staleProblem } from '../analysis/comm-identity';
import { mtuTestSizes, pathMtu } from '../analysis/mtu';
import { portL2 } from '../model/derive';
import { ExecScope, communicationScope, dependencyScope, domainScope, entireScope, groupScope, vlanScope } from '../analysis/exec-scope';
import { scopeChooser } from './scope-ui';
import { bulkBody } from './bulk-ui';
import { planPortEdit } from '../model/bulk-ports';
import { browseBody } from './browse-ui';
import { collapsedGroup } from '../model/collapse';
import { viewsBody } from './views-ui';
import { SavedView, viewSummary } from '../model/views';
import { focusRef } from '../validation/views';
import { ExpRunResult, ExperimentRunner, RunCompare, compareRuns, experimentScope } from '../analysis/sim/experiment';
import { ExpSelection, ExpWsActions, ExpWsView, experimentRefs, experimentText, experimentsDock, experimentsLeft, experimentsRight, targetRefs } from './experiments';
import { ExpAction, ExpObservation, actionDef, durText, durationYaml, observeDef } from '../model/experiments';
import { resetDurationDrafts } from './duration-input';
import { ANALYZE_TOOLS, AnalyzeTool, WORKSPACES, Workspace, applyPanels, inWorkspacePanel } from './workspace';
import type { AnalysisSnapshot } from '../analysis/snapshot';
import { AnalysisContext, contextText, coverageText, resultInfo, simTimeText, verdictText } from '../analysis/result';
import { modelFingerprint } from '../model/fingerprint';
import { ContextBarState, contextBar } from './analysis-ui';
import { DesignView, ExpectForm, ShownFinding, designBody, designCsv, designText, formOf, newExpectForm } from './design-checks';
import { ExpectationRun, evaluateExpectations } from '../analysis/expectations';
import { classCounts, groupFindings } from '../analysis/findings';
import { FailureResult, ReachScope, Spof, SpofCandidate, failureRefs, simulate, singlePointsOfFailure, spofCandidates } from '../analysis/failure';
import { DepChange, DepState, ServiceDependency, compareDependencies, dependencyBaseline, serviceDependencies } from '../analysis/dependencies';
import { WhatIf, whatIf } from '../analysis/whatif';
import { DomainForm, SpofRow, SpofSort, SpofView, WhatIfForm, newSpofViewState, newWhatIfForm, progressLine, shownSpofRows, spofBody, spofCsv, spofRows, spofTable, spofText, whatIfText } from './spof';
import { focusWindowBody } from './focus-window';
import { ToolWindowOpts, ToolWindows } from './toolwindow';
import { SimulationMode } from './simulation-mode';
import { SPEEDS, SimController, SimStartOptions } from './sim-controller';
import { protocolPicker } from './sim-protocols-ui';
import { sendersPicker } from './sim-senders-ui';
import { paramEditor } from './sim-params-ui';
import { ParamValue, readStoredParams } from '../analysis/sim/params';
import { protocolEntriesOf } from '../analysis/sim/simulation';
import { Splitter } from './splitter';
import { TabOverflow } from './tab-overflow';
import { generateMac } from '../analysis/helpers';
import { Command, buildCommands, isMac, keyLabel, matchesKey } from './commands';
import { PaletteItem, commandItems, objectItems, paletteList, rankItems, resultsText } from './palette';
import { AddrSort, AddrViewState, addressingBody, addressingCsv, addressingTables, networkDetail, newAddrViewState, shownText } from './addressing';

/** How a severity is named in the Problems tab's filter. */
const SEV_NAME: { [s in Severity]: string } = { error: 'Errors', warning: 'Warnings', info: 'Info' };

type Tab = 'edit' | 'details' | 'legend' | 'relations' | 'problems' | 'yaml';

/** Why the model can't be edited while a simulation is on (the lock's reason). */
/** Where the simulation-wide parameters are remembered for the browser session. */
const SIM_PARAMS_KEY = 'netatlas.sim.params';
/** the simulation panel's height, chosen with its splitter (local storage) */
// (a new key: heights remembered with the earlier, taller default don't override the three-row default)
export const DOCK_KEY = 'netatlas.simPanelHeight3';
/** the senders chosen in Start simulation… or the Simulation setup, for the next start in this browser session (null: every device) */
const SIM_SENDERS_KEY = 'netatlas.sim.senders';
/** the rows of each of the simulation panel's tables (status, event log) its default height shows: also its minimum */
export const DOCK_ROWS = 3;
/** a margin that keeps the diagram taller than the panel (px) */
const DOCK_MARGIN = 6;
/** the protocols switched off in Start simulation… or the Simulation setup, for the next start in this browser session */
const SIM_HIDDEN_KEY = 'netatlas.sim.hidden';
const SIM_LOCK = 'Editing is paused during a simulation: the diagram shows a simulated state, not the model. Exit the simulation (Esc) to edit.';

export interface LoadOutcome {
  /** the document was opened (it may still have validation errors to fix) */
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** A run in progress: its runner, the experiment, the document it belongs to, and its playback in the diagram (null: none). */
interface ExpSlot {
  runner: ExperimentRunner;
  id: string;
  doc: ModelDoc | null;
  ctl: SimController | null;
}

export class App {
  session: Session | null = null;
  mdoc: ModelDoc | null = null;
  readonly editor: Editor;
  private doc: Document;
  private $: <T extends Element = HTMLElement>(id: string) => T;
  private svg: SVGSVGElement;
  private viewport: SVGGElement;
  private zoom = { k: 1, tx: 0, ty: 0 };
  private bounds: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private tab: Tab = 'legend';
  private sourceLines: string[] = [];
  /** errors of a file that could not be opened at all (YAML syntax etc.) */
  private loadErrors: Issue[] = [];
  private loadErrorName = '';
  private rafPending = false;
  private errorRefs = new Set<string>();
  /** the browser's file pickers, where it has them (replaceable, e.g. by the self-test) */
  fileAccess: FileAccess;
  /**
   * The file the model is linked to: Save model writes there. Set only when
   * the page obtained a handle it can write (Save model as…, or opening with
   * the browser's picker or by dropping a file where the browser hands one
   * over); null for new models, examples and files read through the file
   * input.
   */
  private handle: WritableFile | null = null;
  /** the built-in example the model was loaded from, until it is saved as a file of the user's */
  private example: number | null = null;
  /** the name of the copy last downloaded by Save model as… (the browser couldn't write a chosen file) */
  private copyName: string | null = null;
  /** a connection being drawn in the diagram: its first endpoint and where the pointer is */
  private conn: { view: View; first: Endpoint; ref: string; at: Pt | null } | null = null;
  /** Light or Dark (the default); switching repaints in place (state, selection, zoom and layout are kept) */
  readonly theme: ThemeController;

  constructor(doc: Document) {
    this.doc = doc;
    this.$ = <T extends Element = HTMLElement>(id: string): T => {
      const e = doc.getElementById(id);
      if (!e) throw new Error('missing element #' + id);
      return e as unknown as T;
    };
    this.svg = this.$<SVGSVGElement>('canvas');
    this.viewport = this.$<SVGGElement>('viewport');
    this.theme = new ThemeController(doc);
    setPaint((c) => themedColor(c, this.theme.theme));
    this.theme.onChange(() => this.themeChanged());
    this.fileAccess = detectFileAccess(doc.defaultView);
    this.editor = new Editor(doc, {
      changed: (note) => this.afterEdit(note),
      selected: (sel) => this.editorSelected(sel),
      dialog: (o) => this.dialog(o),
      toast: (m) => this.toast(m),
      fileState: () => this.fileState().text,
      simParams: () => (this.simCtl ? this.simCtl.sim.params.simValues() : this.storedSimParams()),
    }, () => this.mdoc);
    this.wire();
    this.fillExamples();
    this.updateThemeButton();
    this.updateChrome();
  }

  // ---------------------------------------------------------------- theme

  /** The theme in effect changed: the design tokens switched already; the diagram and legend are repainted in place. */
  private themeChanged(): void {
    this.updateThemeButton();
    this.render();
  }

  /** The theme button: its icon shows the theme in effect (moon: dark, sun: light), its name and tooltip that theme and what a press does. */
  private updateThemeButton(): void {
    const btn = this.$('theme-btn');
    const text = themeButtonText(this.theme.theme);
    btn.setAttribute('aria-label', text);
    btn.setAttribute('data-theme-now', this.theme.theme);
    this.$('theme-tip').textContent = text;
  }

  // ------------------------------------------------------------- loading

  /**
   * Read a user-chosen local file (size-checked, strict UTF-8). Does not ask
   * about unsaved changes. With `handle` (the browser's open picker, or a
   * dropped file the browser gave a handle for), the model is linked to the
   * file when the page may write to it; a file from the file input never is.
   */
  async loadFile(file: File, handle: WritableFile | null = null): Promise<LoadOutcome> {
    const r = await readTextFile(file);
    if ('error' in r) return this.fail(file.name, [{ severity: 'error', line: 0, path: '', message: r.error }], []);
    return this.loadText(r.text, file.name, 'file', { handle: isWritable(handle) ? handle : null });
  }

  /** Open YAML text as the current document (replaces it without asking). */
  loadText(text: string, name: string, origin: Origin = 'file', link: { handle?: WritableFile | null; example?: number } = {}): LoadOutcome {
    const lines = text.split(/\r\n|\r|\n/);
    const { doc, errors } = ModelDoc.fromText(text, name, origin);
    if (!doc) return this.fail(name, errors, lines);
    this.sourceLines = lines;
    this.openDoc(doc, link);
    return { ok: true, errors: doc.errors, warnings: doc.warnings };
  }

  /**
   * File → Open model…: the browser's open picker where there is one (the
   * model is then linked to the file, if the page may write it), else the
   * file input. Cancelling the picker changes nothing.
   */
  async openModel(): Promise<void> {
    const pick = this.fileAccess.openFile;
    if (!pick) {
      this.$<HTMLInputElement>('file').click();
      return;
    }
    let h: WritableFile;
    try {
      h = await pick();
    } catch (e) {
      // closed without choosing: nothing happens; a picker that can't be used here: the file input instead
      if (!isCancel(e)) this.$<HTMLInputElement>('file').click();
      return;
    }
    if (!h || typeof h.getFile !== 'function') return;
    let f: File;
    try {
      f = await h.getFile();
    } catch (e) {
      this.fail(h.name, [{ severity: 'error', line: 0, path: '', message: 'the file could not be read' }], []);
      return;
    }
    await this.loadFile(f, h);
  }

  /** Input that cannot be edited (YAML syntax error, not UTF-8 …): keep the current model, explain why. */
  private fail(name: string, errors: Issue[], lines: string[]): LoadOutcome {
    this.loadErrors = errors;
    this.loadErrorName = name;
    if (this.mdoc) {
      const body: Array<Node | string> = [
        `“${name}” was not opened because it is not valid netatlas YAML. Your current model is unchanged.`,
        this.issueList(errors, lines),
      ];
      void this.dialog({ title: 'Could not open the file', body, buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });
    } else {
      this.sourceLines = lines;
      this.showLoadErrors();
    }
    this.updateChrome();
    return { ok: false, errors, warnings: [] };
  }

  private openDoc(doc: ModelDoc, link: { handle?: WritableFile | null; example?: number } = {}): void {
    const prevView = this.session ? this.session.state.view : 'physical';
    this.cancelConnection();
    this.mdoc = doc;
    this.handle = link.handle || null;
    this.example = link.example !== undefined ? link.example : null;
    this.copyName = null;
    this.loadErrors = [];
    this.editor.sel = null;
    this.editor.draft = null;
    this.editor.foldSimSections();
    this.editor.sourceDraft = null;
    this.editor.sourceError = null;
    const model = doc.result.model;
    this.session = model ? new Session(model) : null;
    if (this.session) this.session.setView(prevView);
    this.traceRun = null;
    this.traceError = '';
    this.endForNewModel();
    this.tab = doc.errors.length || doc.warnings.length ? 'problems' : this.tab === 'yaml' ? 'yaml' : 'legend';
    this.computeErrorRefs();
    this.render();
    this.fit();
    this.renderOutline();
    // a workspace in front binds to the new model (Experiments: its first experiment; Analyze: the tool, nothing computed)
    if (this.ws === 'experiments' && model && model.experiments.length) this.expSel = { exp: model.experiments[0].id, list: null, index: -1 };
    if (this.ws === 'experiments' || this.ws === 'analyze') {
      if (!this.session) this.showWorkspace('edit');
      else {
        this.renderWorkspace();
        if (this.ws === 'analyze' && this.anTool === 'spof') {
          const j = this.spofJobNow();
          if (!j.running && j.next < j.cands.length && !j.cancelled) this.stepSpofJob();
        }
        this.applyHighlight();
      }
    }
    this.updateChrome();
  }

  newModel(): void {
    this.openDoc(ModelDoc.create());
    this.editModel();
  }

  /** Open the edit view of the whole model (title, description, format version). */
  private editModel(): void {
    if (!this.mdoc) return;
    this.editor.sel = { kind: 'document', index: 0 };
    this.editorSelected(this.editor.sel);
    this.tab = 'edit';
    this.renderOutline();
    this.renderSide();
    this.updateChrome();
  }

  /** Is the File menu open? */
  get menuOpen(): boolean {
    return !this.$('main-menu').hidden;
  }

  /**
   * Keep a drop-down that hangs under a toolbar control inside the window:
   * it is left-aligned with its control unless that would push it over the
   * right edge (a wrapped toolbar in a narrow window), then it is shifted left.
   */
  private keepInWindow(popup: HTMLElement): void {
    popup.style.left = '0px';
    const r = popup.getBoundingClientRect();
    const over = r.right - (this.doc.documentElement.clientWidth - 8);
    if (over > 0) popup.style.left = -Math.min(over, Math.max(0, r.left - 8)) + 'px';
  }

  /** The menus of the toolbar, in their order: [button id, menu id]. */
  private static readonly MENUS: Array<[string, string]> = [
    ['menu-btn', 'main-menu'],
    ['export-btn', 'export-menu'],
    ['find-btn', 'find-menu'],
    ['analyze-btn', 'analyze-menu'],
    ['simulate-btn', 'simulate-menu'],
    ['help-btn', 'help-menu'],
  ];

  /**
   * Open one toolbar menu (by the id of its list) or, with null, close them
   * all; at most one is open. Opening with `focus` moves the focus to its
   * first available entry (keyboard use).
   */
  openMenu(menuId: string | null, focus = false): void {
    for (const [btnId, id] of App.MENUS) {
      const menu = this.$(id);
      const btn = this.$(btnId);
      const open = id === menuId;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('active', open);
      // a menu always opens with its submenus closed
      const subs = menu.querySelectorAll('[aria-haspopup="menu"]');
      for (let i = 0; i < subs.length; i++) this.setSubmenu(subs[i] as HTMLElement, false);
      if (!open) continue;
      this.keepInWindow(menu);
      if (focus) {
        const first = menu.querySelector('button:not(:disabled)') as HTMLElement | null;
        (first || btn).focus();
      }
    }
  }

  /**
   * Open or close the submenu of a menu entry (the entry names it with
   * aria-controls). It opens in place, under its entry. `focus` moves the
   * focus to its first entry when it opens (keyboard use).
   */
  setSubmenu(entry: HTMLElement, open: boolean, focus = false): void {
    const sub = this.doc.getElementById(entry.getAttribute('aria-controls') || '');
    if (!sub) return;
    const show = open && !(entry as HTMLButtonElement).disabled;
    sub.hidden = !show;
    entry.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      const menu = entry.closest('.dropdown') as HTMLElement | null;
      if (menu) this.keepInWindow(menu);
      if (focus) {
        const first = sub.querySelector('button:not(:disabled)') as HTMLElement | null;
        if (first) first.focus();
      }
    }
  }

  /** Open or close the File menu. */
  setMenu(open: boolean, focus = false): void {
    this.openMenu(open ? 'main-menu' : null, focus);
  }

  /**
   * The toolbar menus (File, Export, Find, Help): a button that opens a list of entries.
   * A menu closes after an entry is chosen, on Escape, and when anything
   * outside it is pressed. Arrow up/down move between the entries, arrow
   * left/right to the neighbouring menu. An entry with a submenu opens it
   * when it is pressed (mouse, touch, Enter or Space) or with arrow right;
   * arrow left or Escape closes the submenu again. Nothing opens on hover.
   */
  private wireMenus(): void {
    App.MENUS.forEach(([btnId, menuId], at) => {
      const btn = this.$(btnId);
      const menu = this.$(menuId);
      const isOpen = (): boolean => !menu.hidden;
      // the entries that can be reached now: enabled, and not inside a closed submenu
      const items = (): HTMLElement[] => (Array.prototype.slice.call(menu.querySelectorAll('button:not(:disabled)')) as HTMLElement[]).filter((b) => !b.closest('[hidden]'));
      const parentEntry = (el: Element | null): HTMLElement | null => {
        const sub = el ? el.closest('.submenu') : null;
        return sub ? (menu.querySelector(`[aria-controls="${sub.id}"]`) as HTMLElement | null) : null;
      };
      const neighbour = (step: number): void => this.openMenu(App.MENUS[(at + step + App.MENUS.length) % App.MENUS.length][1], true);
      btn.addEventListener('click', () => this.openMenu(isOpen() ? null : menuId));
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openMenu(menuId, true);
        } else if (e.key === 'Escape' && isOpen()) {
          e.stopPropagation();
          this.openMenu(null);
        } else if (isOpen() && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          e.preventDefault();
          e.stopPropagation();
          neighbour(e.key === 'ArrowRight' ? 1 : -1);
        }
      });
      // an entry acts through its own handler; the menu then gets out of the way
      menu.addEventListener('click', (e) => {
        const b = (e.target as Element).closest('button') as HTMLElement | null;
        if (!b) return;
        if (b.getAttribute('aria-haspopup') === 'menu') {
          // an entry with a submenu: pressing it opens or closes the submenu, the menu stays
          // (a click made with the keyboard has no pointer position: the focus then follows into the submenu)
          const opening = b.getAttribute('aria-expanded') !== 'true';
          this.setSubmenu(b, opening, opening && (e as MouseEvent).detail === 0);
        } else this.openMenu(null);
      });
      menu.addEventListener('keydown', (e) => {
        const list = items();
        const pos = list.indexOf(this.doc.activeElement as HTMLElement);
        const active = this.doc.activeElement as HTMLElement | null;
        const owner = parentEntry(active);
        const opensSub = !!active && active.getAttribute('aria-haspopup') === 'menu' && menu.contains(active);
        if (owner && (e.key === 'Escape' || e.key === 'ArrowLeft')) {
          // inside a submenu: back to its entry
          e.preventDefault();
          e.stopPropagation();
          this.setSubmenu(owner, false);
          owner.focus();
        } else if (opensSub && e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          this.setSubmenu(active as HTMLElement, true, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.openMenu(null);
          btn.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          const next = list[(pos + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
          if (next) next.focus();
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          neighbour(e.key === 'ArrowRight' ? 1 : -1);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          const to = list[e.key === 'Home' ? 0 : list.length - 1];
          if (to) to.focus();
        } else if (e.key === 'Tab') this.openMenu(null);
      });
    });
    this.doc.addEventListener('pointerdown', (e) => {
      if (!(e.target as Element).closest('.menu-wrap')) this.openMenu(null);
    });
  }

  /**
   * Load an example by its file name: a public one as from the File menu, an internal one (registered
   * by the test build only) as a built-in example that is in no menu. Null when there is none.
   */
  loadExampleNamed(name: string): LoadOutcome | null {
    const f = findExample(name);
    if (!f) return null;
    return f.index >= 0 ? this.loadExample(f.index) : this.loadText(f.example.text, f.example.name, 'example');
  }

  /** Fold exactly these sections of the Objects list (the others open). */
  setOutlineFolded(kinds: string[]): void {
    this.editor.setFolded(kinds.filter((k): k is EntityKind => (ENTITY_KINDS as readonly string[]).indexOf(k) >= 0));
  }

  loadExample(i: number): LoadOutcome | null {
    const ex = EXAMPLES[i];
    return ex ? this.loadText(ex.text, ex.name, 'example', { example: i }) : null;
  }

  /** Ask before discarding unsaved edits. Resolves true when it is OK to continue. */
  async confirmDiscard(action: string): Promise<boolean> {
    const d = this.mdoc;
    if (!d || !d.dirty) return true;
    const a = await this.dialog({
      title: 'Unsaved changes',
      body: [`The current model “${d.fileName}” has changes that have not been saved. ${action} will replace it.`],
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: this.linked ? 'Save first' : 'Save as first…', value: 'save' },
        { label: 'Discard changes', value: 'discard', kind: 'danger' },
      ],
    });
    if (a === 'save') {
      const r = await this.save();
      return this.mdoc === d && (r === 'saved' || r === 'downloaded') && !d.dirty;
    }
    return a === 'discard';
  }

  // --------------------------------------------------------------- editing

  /** Called after every committed edit (and for pure UI refreshes). */
  private afterEdit(note?: string): void {
    const d = this.mdoc;
    // an entry was just created (render() below already gives it the focus)
    const made = this.editor.pendingCreate();
    if (d && note !== 'filter' && note !== 'select') {
      const model = d.result.model;
      if (model) {
        if (this.session) this.session.setModel(model);
        else this.session = new Session(model);
      } else this.session = null;
      this.computeErrorRefs();
      // a device's Simulation settings (the edit allowed during a simulation, or its undo) apply there at once
      if (this.simCtl && model) this.simCtl.modelChanged(model);
      // keep the diagram selection in step with the editor
      if (this.session) this.session.select(this.editor.selectedRef());
      this.render();
      // an open Analyze window shows its result as computed, marked outdated when the edit concerns it (Refresh computes it again)
      if (model) this.refreshWindow();
    }
    this.renderOutline();
    // a new entry opens in the Edit tab, with its outline row in view
    if (made) {
      this.tab = 'edit';
      const row = this.$('outline-body').querySelector('.ol-item.active') as HTMLElement | null;
      if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    }
    // selecting opens the object's form, except where the panel already follows the selection (its details, its place in the YAML)
    if (note === 'select' && this.tab !== 'edit' && this.tab !== 'details' && this.tab !== 'yaml') this.tab = 'edit';
    this.renderSide();
    this.updateChrome();
    // the entry just created gets the focus, once the panel is drawn for the last time
    if (made && this.tab === 'edit' && !(this.mdoc && this.mdoc.lock)) this.editor.focusCreated(this.$('side-body'));
    if (note && note !== 'filter' && note !== 'select') this.toast(note);
  }

  private editorSelected(sel: EditorSel): void {
    if (!this.session) return;
    this.session.select(sel ? this.editor.selectedRef() : null);
    this.applyHighlight();
  }

  undo(): void {
    const serial = this.mdoc ? this.mdoc.undoTop() : 0;
    if (this.mdoc && this.mdoc.undo()) {
      this.editor.beforeUndo(serial);
      this.afterEdit('Undone.');
      // a create taken back: the focus goes to what created it (its fields are gone)
      this.editor.focusAfterUndo(serial, this.$('side-body'), this.$('outline-body'));
    }
    this.syncLock();
  }
  redo(): void {
    if (this.mdoc && this.mdoc.redo()) this.afterEdit('Redone.');
    this.syncLock();
  }

  /**
   * Errors and warnings of the object a diagram ref names, as the Edit tab
   * counts them: everything reported inside its entry (for an interface,
   * inside the interface's entry of its device).
   */
  issueCount(ref: string): IssueCount {
    const c: IssueCount = { errors: 0, warnings: 0 };
    const d = this.mdoc;
    if (!d) return c;
    const [kind, id] = splitRef(ref);
    const colon = id.indexOf(':');
    const owner = kind === 'iface' ? id.slice(0, colon) : id;
    const ownerKind = kind === 'iface' ? 'device' : kind;
    for (const is of d.errors.concat(d.warnings, d.findings)) {
      if (is.severity === 'info') continue;
      const ent = d.issueEntity(is);
      if (!ent || ent.kind !== ownerKind) continue;
      const eid = d.entities(ent.kind)[ent.index]?.id;
      if (!eid || (ent.kind === 'protocol' ? normalizeProtocol(eid) !== owner : eid !== owner)) continue;
      if (kind === 'iface') {
        const entry = d.interfaceEntries(ent.index).find((x) => x.id === id.slice(colon + 1));
        const p = d.issuePath(is) || [];
        if (!entry || JSON.stringify(p.slice(0, entry.path.length)) !== JSON.stringify(entry.path)) continue;
      }
      if (is.severity === 'error') c.errors++;
      else c.warnings++;
    }
    return c;
  }

  private computeErrorRefs(): void {
    this.errorRefs.clear();
    const d = this.mdoc;
    if (!d) return;
    for (const is of d.errors) {
      const ent = d.issueEntity(is);
      if (!ent) continue;
      const e = d.entities(ent.kind)[ent.index];
      if (e && e.id) this.errorRefs.add(ent.kind + ':' + e.id);
    }
  }

  // ------------------------------------------------------------------ saving

  /** The current model as YAML text. */
  exportText(): string {
    return this.mdoc ? this.mdoc.exportText() : '';
  }

  /** Name offered for a downloaded copy (the fallback of Save model as…). */
  suggestedFileName(): string {
    return this.mdoc ? exportFileName(this.mdoc.fileName, this.mdoc.origin) : 'network.yaml';
  }

  /** Is the model linked to a file that Save model writes to? */
  get linked(): boolean {
    return !!this.mdoc && !!this.handle;
  }

  /** The built-in example the open model came from, while it is still that example (null otherwise). */
  get activeExample(): number | null {
    return this.mdoc ? this.example : null;
  }

  /** How the model's file is described in the status bar and the model settings. */
  fileState(): { kind: 'linked' | 'example' | 'copy' | 'unlinked' | 'new'; text: string } {
    const d = this.mdoc;
    if (!d) return { kind: 'new', text: '' };
    if (this.handle) return { kind: 'linked', text: 'saved to this file: Save model updates it' };
    if (this.copyName) return { kind: 'copy', text: `copy downloaded as “${this.copyName}”, not linked to a file` };
    if (this.example !== null) return { kind: 'example', text: 'built-in example, not saved as a file of yours' };
    if (d.origin === 'new') return { kind: 'new', text: 'new model, not saved yet' };
    return { kind: 'unlinked', text: 'opened read-only: Save model as… to save it' };
  }

  /**
   * File → Save model (Ctrl+S): write the model to the file it is linked to,
   * without asking for a name or confirming (the browser may still ask for
   * permission to write). Only available while the model is linked to a file
   * the page may write. A refused or failed write keeps every change and the
   * unsaved state, and says so.
   */
  async saveModel(): Promise<SaveResult> {
    const d = this.mdoc;
    const h = this.handle;
    if (!d || !h) return 'failed';
    const text = d.exportText();
    const r = await writeFile(h, text);
    if (this.mdoc !== d) return 'failed';
    if (!r.ok) {
      // a refused permission ends the link: Save model is no longer offered for this file
      if (r.reason === 'denied') this.handle = null;
      this.updateChrome();
      await this.saveFailed(h.name, r.message, r.reason === 'denied');
      return 'failed';
    }
    d.markSaved(text);
    this.updateChrome();
    this.toast(`Saved “${h.name}”.${this.errorNote(d)}`);
    return 'saved';
  }

  /**
   * File → Save model as… (Ctrl+Shift+S): choose a file name and place and
   * save the model there; the model is then linked to that file, so Save
   * model updates it. A browser without a save picker downloads a copy
   * instead, after saying so: the copy is not linked, Save model stays
   * unavailable. Cancelling changes nothing.
   */
  async saveModelAs(): Promise<SaveResult> {
    const d = this.mdoc;
    if (!d) return 'failed';
    const pick = this.fileAccess.saveFile;
    if (!pick) return this.downloadCopyDialog();
    let h: WritableFile;
    try {
      h = await pick(this.handle ? this.handle.name : this.example !== null ? d.fileName : this.suggestedPickName());
    } catch (e) {
      if (isCancel(e)) {
        this.toast('Save model as… was cancelled: nothing was saved.');
        return 'canceled';
      }
      // the picker exists but can't be used here: downloading still works
      return this.downloadCopyDialog('Your browser could not open its save dialog here.');
    }
    if (this.mdoc !== d) return 'failed';
    if (!isWritable(h)) return this.downloadCopyDialog('Your browser did not give this page a file it can write.');
    const text = d.exportText();
    const r = await writeFile(h, text);
    if (this.mdoc !== d) return 'failed';
    if (!r.ok) {
      // the earlier link (if any) stays as it was
      await this.saveFailed(h.name, r.message, false);
      return 'failed';
    }
    this.handle = h;
    this.example = null;
    this.copyName = null;
    d.fileName = h.name;
    d.origin = 'file';
    d.markSaved(text);
    this.updateChrome();
    this.renderSide();
    this.toast(`Saved as “${h.name}”. Save model now updates this file.${this.errorNote(d)}`);
    return 'saved';
  }

  /** Ctrl+S, and "Save" in the questions before a model is replaced or closed: Save model when linked, else Save model as…. */
  save(): Promise<SaveResult> {
    return this.linked ? this.saveModel() : this.saveModelAs();
  }

  /** The name the save picker suggests for a model that isn't linked to a file. */
  private suggestedPickName(): string {
    const d = this.mdoc as ModelDoc;
    return safeYamlFileName(d.fileName, 'network.yaml');
  }

  /** A short note for the confirmation of a save: the model was saved with validation errors. */
  private errorNote(d: ModelDoc): string {
    const n = d.errors.length;
    return n ? ` It has ${n} validation error${n > 1 ? 's' : ''}, which NetAtlas reports when it is opened again.` : '';
  }

  /** A save that did not happen: say why, and that nothing was lost. Offers Save model as… instead. */
  private async saveFailed(name: string, why: string, unlinked: boolean): Promise<void> {
    const a = await this.dialog({
      title: 'The model was not saved',
      body: [
        el(this.doc, 'p', {}, [`“${name}” was not saved: ${why}.`]),
        el(this.doc, 'p', {}, ['Your changes are still here, and the model is still marked as modified.' + (unlinked ? ' Save model is no longer available for this file; use Save model as… to choose a file or to download a copy.' : '')]),
      ],
      buttons: [
        { label: 'OK', value: 'ok' },
        { label: 'Save model as…', value: 'save-as', kind: 'primary' },
      ],
    });
    if (a === 'save-as') await this.saveModelAs();
  }

  /**
   * The fallback of Save model as…: explain that the browser can only
   * download a copy, let the user name it, warn about validation errors,
   * then download. The copy is not linked to the model.
   */
  async downloadCopyDialog(reason = 'Your browser can’t save to a file you choose.'): Promise<SaveResult> {
    const d = this.mdoc;
    if (!d) return 'failed';
    const nameInput = el(this.doc, 'input', { type: 'text', id: 'dl-name', spellcheck: 'false', 'aria-label': 'File name of the copy' }) as HTMLInputElement;
    nameInput.value = this.suggestedFileName();
    const body: Array<Node | string> = [
      el(this.doc, 'p', {}, [
        `${reason} NetAtlas can download a copy of the model as a YAML file into your browser’s downloads location. ` +
          (d.origin === 'file' ? `It is a new file: “${d.fileName}” on your disk is not changed. ` : '') +
          'The copy is not linked to this model, so Save model stays unavailable and later changes need another download.',
      ]),
      el(this.doc, 'label', { class: 'dl-label' }, ['File name ', nameInput]),
    ];
    const invalid = d.errors.length > 0;
    if (invalid) {
      body.push(
        el(this.doc, 'div', { class: 'dl-warn' }, [
          el(this.doc, 'b', {}, [`The model has ${d.errors.length} validation error${d.errors.length > 1 ? 's' : ''}.`]),
          ' The file will be saved exactly as it is, but NetAtlas will report these errors when it is opened again:',
          this.issueList(d.errors.slice(0, 6), []),
        ]),
      );
    }
    const a = await this.dialog({
      title: invalid ? 'Download a copy of a model that has errors?' : 'Download a copy of the model',
      body,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        invalid ? { label: 'Download anyway', value: 'download', kind: 'danger' } : { label: 'Download copy', value: 'download', kind: 'primary' },
      ],
    });
    if (a !== 'download' || this.mdoc !== d) {
      if (a !== 'download') this.toast('Nothing was downloaded.');
      return 'canceled';
    }
    const name = safeYamlFileName(nameInput.value, this.suggestedFileName());
    const text = d.exportText();
    downloadText(this.doc, text, name, 'application/yaml');
    d.markSaved(text);
    this.copyName = name;
    this.updateChrome();
    this.renderSide();
    this.toast(`Downloaded a copy, “${name}”. It is not linked to this model: Save model stays unavailable.`);
    return 'downloaded';
  }

  /**
   * File → Close model: leave the current model and show the start screen.
   * With unsaved changes it asks first: save and close, close without
   * saving, or stay. Resolves true when the model was closed.
   */
  async closeModelDialog(): Promise<boolean> {
    const d = this.mdoc;
    if (!d) return false;
    if (d.dirty) {
      const linked = this.linked;
      const saveLabel = linked ? 'Save and close' : 'Save as and close…';
      const where = linked
        ? `“${saveLabel}” writes the changes to “${d.fileName}” first.`
        : this.fileAccess.saveFile
          ? `“${saveLabel}” lets you choose a file to save the model to first.`
          : `“${saveLabel}” downloads a copy of the model first (this browser can’t save to a file you choose).`;
      const body: Array<Node | string> = [
        el(this.doc, 'p', {}, [`“${d.fileName}” has changes that have not been saved. They exist only in this page and are lost when the model is closed.`]),
        el(this.doc, 'p', {}, [where]),
      ];
      if (d.errors.length) {
        body.push(el(this.doc, 'div', { class: 'dl-warn' }, [el(this.doc, 'b', {}, [`The model has ${d.errors.length} validation error${d.errors.length > 1 ? 's' : ''}.`]), ' It is saved exactly as it is; NetAtlas will report the errors when it is opened again.']));
      }
      const a = await this.dialog({
        title: 'Close the model with unsaved changes?',
        body,
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Discard changes', value: 'discard', kind: 'danger' },
          { label: saveLabel, value: 'save', kind: 'primary' },
        ],
      });
      // the model may have been replaced while the dialog was open
      if (this.mdoc !== d) return false;
      if (a === 'save') {
        const r = await this.save();
        // a cancelled or failed save keeps the model open, with its changes
        if (this.mdoc !== d || (r !== 'saved' && r !== 'downloaded') || d.dirty) return false;
      } else if (a !== 'discard') return false;
    }
    this.closeModel();
    return true;
  }

  /**
   * Close the current model without asking and show the start screen.
   * Everything that belonged to it goes with it: selection, view, filters,
   * zoom, open cards, the YAML draft, the link to its file. The next model
   * starts clean.
   */
  closeModel(): void {
    this.cancelConnection();
    this.mdoc = null;
    this.session = null;
    this.handle = null;
    this.example = null;
    this.copyName = null;
    this.loadErrors = [];
    this.loadErrorName = '';
    this.sourceLines = [];
    this.errorRefs.clear();
    this.editor.reset();
    this.tab = 'legend';
    this.traceRun = null;
    this.traceError = '';
    this.endForNewModel();
    if (this.ws !== 'edit') this.showWorkspace('edit');
    this.zoom = { k: 1, tx: 0, ty: 0 };
    this.bounds = { x: 0, y: 0, w: 1, h: 1 };
    this.closeFind();
    this.openMoreFilters(false);
    this.$('tooltip').hidden = true;
    this.openMenu(null);
    this.svg.classList.remove('has-selection');
    this.render();
    this.applyZoom();
    this.renderOutline();
    this.updateChrome();
  }

  // ------------------------------------------------------------ rendering

  setView(v: View): void {
    if (!this.session) return;
    const changed = this.session.state.view !== v;
    if (changed) this.cancelConnection();
    this.session.setView(v);
    this.render();
    if (changed) this.fit();
    this.updateChrome();
  }

  render(): void {
    const s = this.session;
    if (!s) {
      while (this.viewport.firstChild) this.viewport.removeChild(this.viewport.firstChild);
      this.renderSide();
      return;
    }
    const scene = s.render();
    this.bounds = scene.bounds;
    mount(this.viewport, scene.root, true);
    if (this.simCtl) this.simCtl.sceneChanged();
    this.showConflicts(scene.conflicts);
    this.applyHighlight();
    this.applyConnection();
    this.applyZoom();
    this.renderSide();
  }

  /**
   * Overlaps a reader would see (after nodes were moved by hand: labels with
   * no free place, boxes on top of each other) are never left silent: a note
   * over the diagram says how many there are and how to remove them. It is
   * not part of the picture, so no export carries it.
   */
  private showConflicts(n: number): void {
    const hint = this.$('overlap-hint');
    this.svg.setAttribute('data-conflicts', String(n));
    hint.hidden = n === 0;
    this.$('overlap-hint-text').textContent = `${n} overlap${n === 1 ? '' : 's'} in the diagram. Auto-arrange places everything without overlaps.`;
  }

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    const raf = this.doc.defaultView && this.doc.defaultView.requestAnimationFrame;
    const run = (): void => {
      this.rafPending = false;
      this.render();
    };
    if (raf) raf.call(this.doc.defaultView, run);
    else run();
  }

  /** what the pointer is on (an interface, relation or link, in the diagram or the Objects list) */
  private pointed: string | null = null;

  /**
   * Mark what is attached to `ref` (model/queries.ts attachedRefs): its
   * interfaces' entries, ports and end labels, and its relations and cables.
   * The mark is an outline and a heavier line, not a colour alone.
   */
  markAttached(ref: string | null, force = false): void {
    if (!force && ref === this.pointed) return;
    this.pointed = ref;
    const s = this.session;
    const on = s && ref ? attachedRefs(s.viewModel(), ref) : null;
    const els = this.viewport.querySelectorAll('[data-ref]');
    for (let i = 0; i < els.length; i++) els[i].classList.toggle('hover-hl', !!on && on.has(els[i].getAttribute('data-ref') as string));
    this.svg.classList.toggle('has-pointed', !!on);
  }

  private applyHighlight(): void {
    const s = this.session;
    if (!s) return;
    if (this.pointed) this.markAttached(this.pointed, true);
    // a path trace takes the place of the selection's highlight: the path, its alternatives, the return path, where it stops
    const run = this.currentTrace();
    const tr = run && !run.trace.error ? traceRefs(run.trace) : null;
    const ret = run && run.back && !run.back.error && run.back.paths.length ? pathRefs(run.back.paths[0]) : null;
    const keep = tr ? null : s.highlight();
    const fr = this.simFailure();
    const failed = fr ? failureRefs(fr) : null;
    const dom = this.simulation && this.simulation.highlighted ? this.simulation.highlighted() : null;
    // a device's lifecycle (powered off, booting): the simulation's own state, apart from what is down for other reasons
    const power = this.simulation && this.simulation.powerMarks ? this.simulation.powerMarks() : null;
    // a workspace's marks: an experiment's targets and verdicts, an analysis's subjects
    const wsm = this.ws === 'experiments' ? this.expMarks() : this.ws === 'analyze' ? this.anMarks() : null;
    this.svg.classList.toggle('has-ws-marks', !!wsm && wsm.size > 0);
    this.svg.classList.toggle('has-selection', !!keep);
    this.svg.classList.toggle('has-trace', !!tr);
    this.svg.classList.toggle('has-sim', !!failed);
    this.svg.classList.toggle('has-bcdomain', !!dom);
    const els = this.viewport.querySelectorAll('[data-ref]');
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      const ref = e.getAttribute('data-ref') as string;
      const on = !!keep && keep.has(ref);
      e.classList.toggle('hl', on);
      e.classList.toggle('dim', !!keep && !on);
      e.classList.toggle('selected', !!s.state.selected && ref === s.state.selected);
      e.classList.toggle('has-error', this.errorRefs.has(ref));
      const main = !!tr && tr.main.has(ref);
      const alt = !!tr && !main && tr.alt.has(ref);
      const back = !!ret && !main && !alt && ret.has(ref);
      e.classList.toggle('trace-main', main);
      e.classList.toggle('trace-alt', alt);
      e.classList.toggle('trace-ret', back);
      e.classList.toggle('trace-stop', !!tr && tr.stop === ref);
      e.classList.toggle('trace-off', !!tr && !main && !alt && !back);
      const st = failed ? failed.get(ref) : undefined;
      e.classList.toggle('sim-down', st === 'down');
      e.classList.toggle('sim-degraded', st === 'degraded');
      const pw = power ? power.get(ref) : undefined;
      e.classList.toggle('sim-off', pw === 'off');
      e.classList.toggle('sim-booting', pw === 'booting');
      const wm = wsm ? wsm.get(ref) || '' : '';
      e.classList.toggle('ws-target', wm.indexOf('ws-target') >= 0);
      e.classList.toggle('ws-ok', wm.indexOf('ws-ok') >= 0);
      e.classList.toggle('ws-bad', wm.indexOf('ws-bad') >= 0);
      e.classList.toggle('ws-sel', wm.indexOf('ws-sel') >= 0);
      e.classList.toggle('ws-act', wm.indexOf('ws-act') >= 0);
      e.classList.toggle('bc-on', !!dom && dom.has(ref));
      e.classList.toggle('bc-off', !!dom && !dom.has(ref) && (ref.indexOf('device:') === 0 || ref.indexOf('link:') === 0 || ref.indexOf('relation:') === 0 || ref.indexOf('network:') === 0));
    }
    // a DHCP client's lease in a simulation, in its reserved line (the model is unchanged: without a simulation the line says so)
    const leases = this.simulation && this.simulation.leaseMarks ? this.simulation.leaseMarks() : null;
    const lines = this.viewport.querySelectorAll('[data-field="lease"]');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      const g = t.closest('[data-ref]');
      const mark = leases && g ? leases.get(g.getAttribute('data-ref') as string) : undefined;
      const text = mark || LEASE_PLACEHOLDER;
      if (t.textContent !== text) t.textContent = text;
      t.classList.toggle('lease-on', !!mark);
    }
    // automatic IPv6 in a simulation, in its reserved line
    const v6 = this.simulation && this.simulation.ipv6Marks ? this.simulation.ipv6Marks() : null;
    const v6lines = this.viewport.querySelectorAll('[data-field="ipv6"]');
    for (let i = 0; i < v6lines.length; i++) {
      const t = v6lines[i];
      const g = t.closest('[data-ref]');
      const mark = v6 && g ? v6.get(g.getAttribute('data-ref') as string) : undefined;
      const text = mark || IPV6_PLACEHOLDER;
      if (t.textContent !== text) t.textContent = text;
      t.classList.toggle('lease-on', !!mark);
    }
  }

  /** Select from the diagram, search or details links. */
  /**
   * `detail`: the line of the diagram the object was clicked on (an
   * address, VRF, VLAN …): the Edit tab highlights that field. It never
   * changes what is selected.
   */
  select(ref: string | null, reveal = false, detail: SelDetail | null = null): void {
    if (!this.session) return;
    // a collapsed group's box stands for its group
    const cg = ref && ref.indexOf('device:') === 0 ? collapsedGroup(ref.slice(7)) : null;
    if (cg !== null) ref = 'group:' + cg;
    this.session.select(ref);
    this.editor.selectRef(this.session.state.selected);
    this.editor.setDetail(this.session.state.selected ? detail : null);
    if (ref && this.session.state.selected && this.tab !== 'details' && this.tab !== 'yaml') this.tab = 'edit';
    this.applyHighlight();
    this.renderOutline();
    this.renderSide();
    this.updateChrome();
    if (reveal && ref) this.reveal(ref);
    if (this.simCtl) this.simCtl.selectionChanged();
  }

  private reveal(ref: string): void {
    const [kind, id] = splitRef(ref);
    const candidates = [ref, kind === 'relation' ? 'hub:' + id : ''];
    const els = this.viewport.querySelectorAll('[data-ref]');
    for (let i = 0; i < els.length; i++) {
      const e = els[i] as SVGGraphicsElement;
      if (candidates.indexOf(e.getAttribute('data-ref') as string) < 0 || typeof e.getBBox !== 'function') continue;
      let b: DOMRect;
      try {
        b = e.getBBox();
      } catch (err) {
        return;
      }
      const W = this.svg.clientWidth || 800;
      const H = this.svg.clientHeight || 600;
      this.zoom.k = Math.max(this.zoom.k, 0.8);
      this.zoom.tx = W / 2 - (b.x + b.width / 2) * this.zoom.k;
      this.zoom.ty = H / 2 - (b.y + b.height / 2) * this.zoom.k;
      this.applyZoom();
      return;
    }
  }

  // --------------------------------------------------------------- zooming

  private applyZoom(): void {
    const z = this.zoom;
    this.viewport.setAttribute('transform', `translate(${round(z.tx)} ${round(z.ty)}) scale(${Math.round(z.k * 10000) / 10000})`);
    const pct = this.doc.getElementById('zoom-level');
    if (pct) pct.textContent = Math.round(z.k * 100) + '%';
  }

  fit(): void {
    const W = this.svg.clientWidth || 1000;
    // the banner of an analysis mode covers the top of the diagram: fit below it
    const banner = this.doc.getElementById('mode-banner');
    const top = banner && !banner.hidden ? banner.getBoundingClientRect().height : 0;
    const H = Math.max(40, (this.svg.clientHeight || 700) - top);
    let b = this.bounds;
    // the simulation's indicators beside the boxes (statuses, querier marks, snooping badges) are in view too
    const marks = this.svg.querySelector('.layer-sim-power') as SVGGraphicsElement | null;
    if (marks && typeof marks.getBBox === 'function') {
      try {
        const e = marks.getBBox();
        if (e.width > 0 && e.height > 0) {
          const x0 = Math.min(b.x, e.x);
          const y0 = Math.min(b.y, e.y);
          b = { x: x0, y: y0, w: Math.max(b.x + b.w, e.x + e.width) - x0, h: Math.max(b.y + b.h, e.y + e.height) - y0 };
        }
      } catch (err) {
        /* not rendered */
      }
    }
    const k = Math.max(0.05, Math.min(1.5, Math.min(W / Math.max(1, b.w), H / Math.max(1, b.h)) * 0.96));
    this.zoom = { k, tx: W / 2 - (b.x + b.w / 2) * k, ty: top + H / 2 - (b.y + b.h / 2) * k };
    this.applyZoom();
  }

  /** Move the diagram by screen pixels (as the arrow keys do). */
  panBy(dx: number, dy: number): void {
    this.zoom.tx += dx;
    this.zoom.ty += dy;
    this.applyZoom();
  }

  zoomBy(f: number, cx?: number, cy?: number): void {
    const W = this.svg.clientWidth || 1000;
    const H = this.svg.clientHeight || 700;
    const px = cx === undefined ? W / 2 : cx;
    const py = cy === undefined ? H / 2 : cy;
    const k = Math.max(0.05, Math.min(6, this.zoom.k * f));
    const r = k / this.zoom.k;
    this.zoom = { k, tx: px - (px - this.zoom.tx) * r, ty: py - (py - this.zoom.ty) * r };
    this.applyZoom();
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect();
    return { x: (clientX - r.left - this.zoom.tx) / this.zoom.k, y: (clientY - r.top - this.zoom.ty) / this.zoom.k };
  }

  // ---------------------------------------------------------------- panels

  /** the splitter that sets the side panel's width */
  splitter: Splitter | null = null;
  /** the side panel's tabs that don't fit one row in a very short window (More ▾) */
  private tabOverflow: TabOverflow | null = null;

  /** The side panel's tab shown. */
  currentTab(): Tab {
    return this.tab;
  }

  showTab(t: Tab): void {
    this.tab = t;
    this.renderSide();
  }

  /** Selection context for the element lists, derived from the diagram selection (the single source). */
  selectionContext(): SelectionContext | null {
    const s = this.session;
    return s && s.state.selected ? selectionContext(s.model, s.state.selected) : null;
  }

  /**
   * Draw the model outline again. A keyboard user keeps their place: when an
   * entry or one of its quick actions had the focus, the focus goes back to
   * that entry (after Duplicate: to the copy, which is now selected).
   */
  private renderOutline(): void {
    const box = this.$('outline-body');
    const a = this.doc.activeElement as HTMLElement | null;
    const act = a && box.contains(a) ? a.getAttribute('data-act') : null;
    const kind = a ? a.getAttribute('data-kind') : null;
    const index = a ? a.getAttribute('data-index') : null;
    this.editor.renderOutline(box, this.selectionContext());
    if (this.editLock() && this.simulation) {
      const edits = box.querySelectorAll('[data-act="add-entity"], [data-act="dup-entity"], [data-act="del-entity"]');
      for (let i = 0; i < edits.length; i++) {
        (edits[i] as HTMLButtonElement).disabled = true;
        edits[i].setAttribute('title', 'Editing is paused during the simulation');
      }
    }
    if (act !== 'select' && act !== 'dup-entity' && act !== 'del-entity') return;
    const entry = (act === 'dup-entity' ? box.querySelector(`.ol-item.active[data-kind="${kind}"]`) : null) || box.querySelector(`.ol-item[data-kind="${kind}"][data-index="${index}"]`);
    if (entry) (entry as HTMLElement).focus();
  }

  private renderSide(): void {
    const s = this.session;
    const body = this.$('side-body');
    // the simulation layout shows Actions instead (with the device's Simulation section): nothing here meanwhile
    if (this.simCtl) {
      while (body.firstChild) body.removeChild(body.firstChild);
      return;
    }
    const tabs = this.doc.querySelectorAll('#side .tabs button');
    for (let i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === this.tab);
    if (this.tabOverflow) this.tabOverflow.layout(this.tab);
    const focus = captureFocus(this.doc);
    if (this.tab === 'problems' || !this.mdoc) this.renderProblems(body);
    // the notice and the read-only form only while a simulation runs
    else if (this.tab === 'edit' && this.mdoc.lock && this.simulation) this.renderLockedEdit(body);
    else if (this.tab === 'edit') this.editor.renderInspector(body);
    else if (this.tab === 'yaml') this.renderYaml(body);
    else if (!s) mount(body, { tag: 'p', attrs: { class: 'muted' }, children: [], text: 'Nothing to show: the model has too many errors to be drawn. See Problems.' });
    else if (this.tab === 'details') {
      if (s.state.selected) mount(body, detailsFor(s.model, s.state.selected, this.issueCount(s.state.selected)));
      else {
        mount(body, [
          {
            tag: 'div',
            attrs: { class: 'details' },
            children: [
              { tag: 'h3', attrs: {}, children: [], text: s.model.title },
              { tag: 'p', attrs: { class: 'muted' }, children: [], text: s.model.description || '' },
              { tag: 'p', attrs: { class: 'muted' }, children: [], text: 'Select an object in the diagram or a list to see its details.' },
            ],
          },
        ]);
      }
    } else if (this.tab === 'legend') mount(body, legendFor(s.viewModel(), s.state.view, s.state.hiddenProtocols, !!this.simulation));
    else mount(body, relationList(s.model, this.selectionContext()));
    restoreFocus(this.doc, focus);
  }

  /** A notice that editing is paused, with a way out, above the Edit tab's form (read-only: every control in it is disabled). */
  private lockNotice(what: string): HTMLElement {
    const exit = el(this.doc, 'button', { type: 'button', class: 'primary', 'data-command': 'sim.exit' }, ['Exit simulation']);
    exit.addEventListener('click', () => void this.exitSimulation());
    return el(this.doc, 'div', { class: 'lock-note', role: 'note' }, [
      el(this.doc, 'p', {}, [el(this.doc, 'span', { 'aria-hidden': 'true' }, ['◈ ']), el(this.doc, 'strong', {}, ['Editing is paused during the simulation.']), ` ${what}`]),
      exit,
    ]);
  }

  private renderLockedEdit(body: HTMLElement): void {
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(this.lockNotice('The diagram shows a simulated state, not the model. Exit the simulation to edit; the form below is read-only, except a device’s Simulation settings.'));
    // the documented exception: a device's Simulation section stays editable (its changes apply in the simulation at once)
    const sim = el(this.doc, 'div', { class: 'inspector sim-live' });
    if (this.editor.renderSimSection(sim)) body.appendChild(sim);
    const fs = el(this.doc, 'fieldset', { class: 'locked-form', disabled: '' });
    fs.appendChild(el(this.doc, 'legend', { class: 'sr-only' }, ['The selected object (read-only during the simulation)']));
    const box = el(this.doc, 'div');
    fs.appendChild(box);
    body.appendChild(fs);
    this.editor.renderInspector(box, { simOutside: true });
  }

  private renderYaml(body: HTMLElement): void {
    // a re-render (after a selection, an edit, undo …) keeps the reader's place in the text:
    // the scroll position always, and focus, caret and text selection while the text is unchanged
    const old = body.querySelector('#yaml-src') as HTMLTextAreaElement | null;
    const keep = old ? { top: old.scrollTop, left: old.scrollLeft, value: old.value, focus: this.doc.activeElement === old, start: old.selectionStart, end: old.selectionEnd, dir: old.selectionDirection } : null;
    while (body.firstChild) body.removeChild(body.firstChild);
    const d = this.mdoc as ModelDoc;
    const ta = el(this.doc, 'textarea', { id: 'yaml-src', spellcheck: 'false', 'aria-label': 'YAML source of the whole model', 'aria-describedby': 'yaml-sel', wrap: 'off' }) as HTMLTextAreaElement;
    ta.value = this.editor.sourceDraft !== null ? this.editor.sourceDraft : d.exportText();
    const locked = !!d.lock && !!this.simulation;
    if (locked) ta.readOnly = true;
    body.appendChild(
      el(this.doc, 'div', { class: 'yaml-tab' }, [
        locked ? this.lockNotice('The text is read-only until you exit the simulation.') : null,
        el(this.doc, 'p', { class: 'muted small' }, [
          'The whole model as exported. Edit it and press Apply; comments and key order are kept.',
        ]),
        this.editor.sourceDraft !== null ? el(this.doc, 'div', { class: 'field-warn' }, ['You have unapplied changes in this text.']) : null,
        this.editor.sourceError ? el(this.doc, 'div', { class: 'field-err' }, [this.editor.sourceError]) : null,
        el(this.doc, 'p', { id: 'yaml-sel', class: 'yaml-sel muted small' }),
        el(this.doc, 'div', { class: 'yaml-edit' }, [el(this.doc, 'div', { class: 'yaml-hl-clip', 'aria-hidden': 'true' }, [el(this.doc, 'div', { class: 'yaml-hl', hidden: '' })]), ta]),
        el(this.doc, 'div', { class: 'row-btns' }, [
          el(this.doc, 'button', { type: 'button', class: 'primary', 'data-yaml': 'apply' }, ['Apply']),
          el(this.doc, 'button', { type: 'button', 'data-yaml': 'revert' }, ['Revert to model']),
        ]),
      ]),
    );
    if (keep) {
      ta.scrollTop = keep.top;
      ta.scrollLeft = keep.left;
      if (keep.focus && keep.value === ta.value) {
        ta.focus();
        ta.setSelectionRange(keep.start, keep.end, keep.dir || undefined);
      }
    }
    ta.addEventListener('scroll', () => this.placeYamlMark());
    // a tab that has just been opened shows the selected entry, wherever it is
    if (!keep) this.yamlMarkKey = '';
    this.updateYamlMark(true);
  }

  // --------------------------------------------- the selection in the YAML text

  /** the lines marked in the YAML editor (null: nothing marked) */
  private yamlRange: LineRange | null = null;
  /** the object the YAML editor was last marked for: it scrolls only when the selection changes */
  private yamlMarkKey = '';
  private yamlTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Mark the selected object's entry in the full-file YAML editor. The entry
   * is found through the parsed text by the object's id (yamlBlock), so a
   * mention of the id elsewhere in the file is never marked; when the text
   * can't be parsed, or the entry is not there exactly once, nothing is
   * marked. The mark is a band drawn behind the text: the text, the caret,
   * the text selection and the scroll position are left alone, except that
   * with `reveal`, selecting another object scrolls its entry into view when
   * none of it is visible.
   */
  private updateYamlMark(reveal: boolean): void {
    const ta = this.doc.getElementById('yaml-src') as HTMLTextAreaElement | null;
    const note = this.doc.getElementById('yaml-sel');
    if (!ta || !note) return;
    const target = this.editor.selectedTarget();
    const range = target ? yamlBlock(ta.value, target) : null;
    this.yamlRange = range;
    const key = target ? JSON.stringify(target) : '';
    const changed = key !== this.yamlMarkKey;
    this.yamlMarkKey = key;
    if (range) ta.setAttribute('data-mark', range.first + '-' + range.last);
    else ta.removeAttribute('data-mark');
    const what = !target ? '' : target.iface !== undefined ? `Interface “${target.iface}” of device “${target.id}”` : `${target.kind.charAt(0).toUpperCase() + target.kind.slice(1)} “${target.id}”`;
    const lines = range ? (range.first === range.last ? 'line ' + range.first : `lines ${range.first}–${range.last}`) : '';
    note.textContent = !target ? '' : range ? `${what}: ${lines} (marked)` : `${what} is not marked: its entry can't be found reliably in the text as it is now.`;
    note.title = note.textContent;
    note.setAttribute('data-state', !target ? 'none' : range ? 'marked' : 'unmarked');
    if (reveal && changed && range) {
      const g = this.yamlGeometry(ta);
      const top = g.pad + (range.first - 1) * g.lh;
      const bottom = g.pad + range.last * g.lh;
      if (bottom <= ta.scrollTop || top >= ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, top - 2 * g.lh);
    }
    this.placeYamlMark();
  }

  private yamlGeometry(ta: HTMLTextAreaElement): { lh: number; pad: number } {
    const cs = (this.doc.defaultView as Window).getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 17;
    return { lh, pad: parseFloat(cs.paddingTop) || 0 };
  }

  /** Draw the band behind the marked lines, clipped to the inside of the text area. */
  private placeYamlMark(): void {
    const ta = this.doc.getElementById('yaml-src') as HTMLTextAreaElement | null;
    const clip = this.doc.querySelector('.yaml-hl-clip') as HTMLElement | null;
    const band = clip ? (clip.firstChild as HTMLElement) : null;
    if (!ta || !clip || !band) return;
    const r = this.yamlRange;
    band.hidden = !r;
    if (!r) return;
    clip.style.top = ta.offsetTop + ta.clientTop + 'px';
    clip.style.left = ta.offsetLeft + ta.clientLeft + 'px';
    clip.style.width = ta.clientWidth + 'px';
    clip.style.height = ta.clientHeight + 'px';
    const g = this.yamlGeometry(ta);
    band.style.top = g.pad + (r.first - 1) * g.lh - ta.scrollTop + 'px';
    band.style.height = (r.last - r.first + 1) * g.lh + 'px';
  }

  /** After typing in the YAML editor: find the entry again once typing pauses (never scrolls). */
  private scheduleYamlMark(): void {
    if (this.yamlTimer !== null) clearTimeout(this.yamlTimer);
    this.yamlTimer = setTimeout(() => {
      this.yamlTimer = null;
      this.updateYamlMark(false);
    }, 120);
  }

  private applyYaml(): void {
    const d = this.mdoc;
    const ta = this.doc.getElementById('yaml-src') as HTMLTextAreaElement | null;
    if (!d || !ta) return;
    const parsed = ModelDoc.fromText(ta.value, d.fileName, d.origin);
    if (!parsed.doc) {
      const e = parsed.errors[0];
      this.editor.sourceDraft = ta.value;
      this.editor.sourceError = `Not applied — ${e.line ? 'line ' + e.line + ': ' : ''}${e.message}`;
      this.renderSide();
      return;
    }
    this.editor.sourceDraft = null;
    this.editor.sourceError = null;
    d.replaceRoot(parsed.doc.root);
    this.afterEdit('YAML applied.');
  }

  /** which severities of check findings the Problems tab lists (a view setting; all by default) */
  private problemsShown: { [s in Severity]: boolean } = { error: true, warning: true, info: true };

  /**
   * The Problems tab: first what breaks the file's format (errors and
   * warnings with line numbers), then the findings of the consistency
   * checks, which describe the network and never make the file invalid.
   * Findings can be narrowed to errors, warnings and info; each names its
   * check and the objects it concerns, and a click goes to its place. The
   * checks this model switches off or changes (its `checks:` section) are
   * listed, with a way to the model settings where they are changed.
   */
  private renderProblems(body: HTMLElement): void {
    while (body.firstChild) body.removeChild(body.firstChild);
    const d = this.mdoc;
    if (!d) {
      body.appendChild(this.loadErrors.length ? this.issueList(this.loadErrors, this.sourceLines) : el(this.doc, 'p', { class: 'muted' }, ['No model open.']));
      return;
    }
    const format = d.errors.concat(d.warnings);
    const findings = d.findings;
    if (!format.length && !findings.length && !this.checkOverrides().length) {
      body.appendChild(el(this.doc, 'p', { class: 'muted' }, ['✓ No problems found.']));
      return;
    }
    if (d.edited && format.length) body.appendChild(el(this.doc, 'p', { class: 'muted small' }, ['Line numbers refer to the file as it was opened; the model has been edited since. Click a problem to jump to the object.']));
    // the format
    const fsec = el(this.doc, 'section', { class: 'problems-sec', 'data-problems': 'format', 'aria-labelledby': 'pr-format' }, [
      el(this.doc, 'h4', { id: 'pr-format', class: 'fgroup-title' }, [`The file (${format.length ? format.length : 'no problems'})`]),
    ]);
    fsec.appendChild(format.length ? this.issueList(format, d.edited ? [] : this.sourceLines, true) : el(this.doc, 'p', { class: 'muted small' }, ['✓ The file follows the format.']));
    body.appendChild(fsec);
    // the consistency checks
    const count = (s: Severity): number => findings.filter((f) => f.severity === s).length;
    const csec = el(this.doc, 'section', { class: 'problems-sec', 'data-problems': 'checks', 'aria-labelledby': 'pr-checks' }, [
      el(this.doc, 'h4', { id: 'pr-checks', class: 'fgroup-title' }, [`Consistency checks (${findings.length ? findings.length : d.errors.length ? 'not run' : 'nothing found'})`]),
    ]);
    if (d.errors.length) csec.appendChild(el(this.doc, 'p', { class: 'muted small' }, ['The checks run once the file has no format errors.']));
    if (findings.length) {
      const bar = el(this.doc, 'div', { class: 'pr-filter', role: 'group', 'aria-label': 'Show findings of these severities' });
      for (const s of SEVERITIES) {
        const on = this.problemsShown[s];
        bar.appendChild(el(this.doc, 'button', { type: 'button', class: 'mini pr-sev sev-' + s + (on ? ' active' : ''), 'aria-pressed': on ? 'true' : 'false', 'data-problems-filter': s, title: `${on ? 'Hide' : 'Show'} the ${s} findings` }, [`${on ? '☑' : '☐'} ${SEV_NAME[s]} (${count(s)})`]));
      }
      csec.appendChild(bar);
    }
    const overrides = this.checkOverrides();
    if (overrides.length) {
      csec.appendChild(
        el(this.doc, 'p', { class: 'pr-overrides small', 'data-overrides': overrides.map((o) => o.id + '=' + o.value).join(',') }, [
          'This model changes ' + (overrides.length === 1 ? 'one check' : overrides.length + ' checks') + ': ',
          overrides.map((o) => (o.value === 'off' ? `${o.id} switched off` : `${o.id} as ${o.value}`)).join(', ') + '. ',
          el(this.doc, 'button', { type: 'button', class: 'ref', 'data-problems-settings': '' }, ['Change in the model settings']),
        ]),
      );
    }
    const shown = findings.map((f, i) => ({ f, i: format.length + i })).filter((x) => this.problemsShown[x.f.severity]);
    if (findings.length && !shown.length) csec.appendChild(el(this.doc, 'p', { class: 'muted small' }, ['Every finding is hidden by the filter above.']));
    if (shown.length) {
      const ul = el(this.doc, 'ul', { class: 'issues' });
      const m = this.session ? this.session.model : null;
      for (const { f, i } of shown) {
        const def = f.check ? checkById(f.check) : undefined;
        const objects = (f.refs || []).filter((r, k, a) => a.indexOf(r) === k);
        ul.appendChild(
          el(this.doc, 'li', { class: 'issue clickable ' + f.severity, 'data-issue': String(i), 'data-check': f.check || '' }, [
            el(this.doc, 'div', { class: 'issue-head' }, [
              el(this.doc, 'span', { class: 'sev' }, [f.severity]),
              el(this.doc, 'code', { class: 'check-id', title: 'Consistency check' }, [f.check || '']),
              def ? el(this.doc, 'span', { class: 'check-title' }, [def.title]) : null,
            ]),
            el(this.doc, 'div', { class: 'msg' }, [f.message]),
            objects.length && m
              ? el(this.doc, 'div', { class: 'issue-objects small' }, [
                  'Concerns: ',
                  ...objects.map((r, k) => {
                    const h = headOf(m, r);
                    return el(this.doc, 'span', {}, [k ? ', ' : '', el(this.doc, 'button', { type: 'button', class: 'ref', 'data-goto': r }, [h ? h.title : r])]);
                  }),
                ])
              : null,
          ]),
        );
      }
      csec.appendChild(ul);
    }
    body.appendChild(csec);
  }

  /** The checks this model's `checks:` section switches off or gives another severity. */
  private checkOverrides(): Array<{ id: string; value: string }> {
    const m = this.mdoc ? this.mdoc.result.model : null;
    if (!m) return [];
    return Array.from(m.checks.entries()).map(([id, value]) => ({ id, value })).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  private issueList(issues: Issue[], lines: string[], clickable = false): HTMLElement {
    const ul = el(this.doc, 'ul', { class: 'issues' });
    issues.forEach((is, n) => {
      const loc = is.line > 0 ? `line ${is.line}` : '';
      const li = el(this.doc, 'li', { class: 'issue ' + is.severity + (clickable ? ' clickable' : ''), 'data-issue': String(n) }, [
        el(this.doc, 'div', { class: 'issue-head' }, [
          el(this.doc, 'span', { class: 'sev' }, [is.severity]),
          is.check ? el(this.doc, 'code', { class: 'check-id', title: 'Consistency check' }, [is.check]) : null,
          loc ? el(this.doc, 'span', { class: 'loc' }, [loc]) : null,
          is.path ? el(this.doc, 'code', { class: 'path' }, [is.path]) : null,
        ]),
        el(this.doc, 'div', { class: 'msg' }, [is.message]),
      ]);
      if (is.line > 0 && is.line <= lines.length) {
        const src = lines[is.line - 1];
        li.appendChild(el(this.doc, 'pre', { class: 'src' }, [`${is.line} | ${src.length > 160 ? src.slice(0, 160) + '…' : src}`]));
      }
      ul.appendChild(li);
    });
    return ul;
  }

  private gotoIssue(n: number): void {
    const d = this.mdoc;
    if (!d) return;
    const is = d.errors.concat(d.warnings, d.findings)[n];
    if (!is) return;
    const ent = d.issueEntity(is);
    if (!ent) this.editor.sel = { kind: 'document', index: 0 };
    else {
      this.editor.sel = { kind: ent.kind, index: ent.index };
      // open the interface or route the issue is in
      const p = d.issuePath(is) || [];
      const ip = [p.slice(0, 4)].find((x) => !!ifaceSchemaKind(x));
      if (ent.kind === 'device' && ip) {
        this.editor.sel.iface = ip;
        this.editor.openIface(ip);
      } else if (ent.kind === 'device' && p[2] === 'routes' && typeof p[3] === 'number') {
        this.editor.sel.route = p.slice(0, 4);
        this.editor.openIface(p.slice(0, 4));
      }
    }
    this.editorSelected(this.editor.sel);
    this.tab = 'edit';
    this.renderOutline();
    this.renderSide();
    const ref = this.editor.selectedRef();
    if (ref) this.reveal(ref);
    // the field the issue is about takes the focus (its message is shown at it), when it is an editable field
    const at = d.issuePath(is);
    if (at && at.length) {
      const field = this.$('side-body').querySelector(`[data-p='${JSON.stringify(at)}']`) as HTMLElement | null;
      if (field && /^(INPUT|SELECT|TEXTAREA)$/.test(field.tagName) && !(field as HTMLInputElement).disabled) {
        field.focus();
        if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private showLoadErrors(): void {
    const box = this.$('errors');
    while (box.firstChild) box.removeChild(box.firstChild);
    const n = this.loadErrors.length;
    box.appendChild(el(this.doc, 'h2', {}, [`Could not open ${this.loadErrorName || 'the file'}`]));
    box.appendChild(
      el(this.doc, 'p', { class: 'muted' }, [
        `${n} error${n === 1 ? '' : 's'} found. This file cannot be edited until it is valid YAML in the supported subset. Nothing was sent anywhere — the file was only read locally.`,
      ]),
    );
    box.appendChild(this.issueList(this.loadErrors, this.sourceLines));
    box.appendChild(
      el(this.doc, 'p', { class: 'error-actions' }, [
        el(this.doc, 'button', { type: 'button', class: 'primary', 'data-act-top': 'open' }, ['Open another model…']),
        el(this.doc, 'button', { type: 'button', 'data-act-top': 'new' }, ['New model']),
        el(this.doc, 'button', { type: 'button', 'data-act-top': 'start' }, ['Back to the start screen']),
      ]),
    );
  }

  /** Leave the "could not open" page and show the start screen again (only while no model is open). */
  showStart(): void {
    if (this.mdoc) return;
    this.loadErrors = [];
    this.loadErrorName = '';
    this.updateChrome();
  }

  /**
   * The File menu's state: Save model only while the model is linked to a
   * file the page may write (with a dot while there is something to save),
   * Save model as… whenever a model is open, and the loaded example marked
   * (and whether its model was modified) until it is saved as a file.
   */
  private updateFileMenu(): void {
    const d = this.mdoc;
    (this.$('btn-save') as HTMLElement).setAttribute('data-modified', d && this.linked && d.dirty ? 'true' : 'false');
    const active = this.activeExample;
    const items = this.$('menu-examples').querySelectorAll('[data-example]');
    for (let i = 0; i < items.length; i++) {
      const b = items[i] as HTMLElement;
      const n = Number(b.getAttribute('data-example'));
      const on = active === n;
      const modified = on && !!d && d.dirty;
      b.classList.toggle('active-example', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
      b.setAttribute('data-modified', modified ? 'true' : 'false');
      const hint = b.querySelector('.mi-state') as HTMLElement;
      hint.textContent = on ? (modified ? 'open · modified' : 'open') : '';
      b.title = on ? `The open model is this example${modified ? ', modified (not saved)' : ''}. Choosing it opens it again from the start.` : `Open the example ${EXAMPLES[n] ? EXAMPLES[n].name : ''}`;
    }
  }

  private updateChrome(): void {
    const s = this.session;
    const d = this.mdoc;
    const body = this.doc.body;
    body.setAttribute('data-state', d ? 'loaded' : this.loadErrors.length ? 'error' : 'empty');
    body.setAttribute('data-view', s ? s.state.view : 'none');
    body.setAttribute('data-dirty', d && d.dirty ? 'true' : 'false');
    const views = this.doc.querySelectorAll('[data-view-btn]');
    for (let i = 0; i < views.length; i++) {
      const b = views[i] as HTMLButtonElement;
      const active = !!s && b.getAttribute('data-view-btn') === s.state.view;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.disabled = !s;
    }
    const pb = this.doc.querySelector('[data-tab="problems"]');
    if (pb) {
      const e = d ? d.errors.length : this.loadErrors.length;
      const w = d ? d.warnings.length : 0;
      const f = d ? d.findings.length : 0;
      pb.textContent = e + w + f ? `Problems (${e + w + f})` : 'Problems';
      pb.classList.toggle('has-errors', e > 0 || (!!d && d.findings.some((x) => x.severity === 'error')));
    }
    (this.$('btn-undo') as HTMLButtonElement).disabled = !d || !d.canUndo() || d.undoLocked();
    (this.$('btn-redo') as HTMLButtonElement).disabled = !d || !d.canRedo() || d.undoLocked(true);
    this.updateFileMenu();
    // exporting needs a diagram: a model that could be drawn
    const ex = this.$('btn-export-as') as HTMLButtonElement;
    ex.disabled = !s;
    ex.title = s ? `Save the ${s.state.view} view as a picture: the whole diagram with its legend and networks overview` : 'Open or create a model first';
    if (!s) this.setSubmenu(ex, false);
    this.syncCommands();
    this.updateModeBanner();
    if (!s && this.findOpen) this.closeFind();
    this.$('btn-undo').title = d && d.canUndo() ? (d.undoLocked() ? 'Undo: paused during the simulation' : `Undo: ${d.canUndo()} (Ctrl+Z)`) : 'Undo (Ctrl+Z)';
    this.$('btn-redo').title = d && d.canRedo() ? (d.undoLocked(true) ? 'Redo: paused during the simulation' : `Redo: ${d.canRedo()} (Ctrl+Y)`) : 'Redo (Ctrl+Y)';
    const st = this.$('status');
    while (st.firstChild) st.removeChild(st.firstChild);
    if (d) {
      const m = s ? s.model : null;
      // The file name first, as a badge (shortened with "…" when long; the full name and where it is saved are its tooltip),
      // with a small dot while the model is modified; then what the name stands for, and the rest on one line.
      const fs = this.fileState();
      st.appendChild(
        el(this.doc, 'span', { class: 'fname', 'data-file': fs.kind, 'data-modified': d.dirty ? 'true' : 'false', title: `${d.fileName}: ${fs.text}${d.dirty ? ' · modified since it was opened or saved' : ''}` }, [
          el(this.doc, 'span', { class: 'fname-text' }, [d.fileName]),
          d.dirty ? el(this.doc, 'span', { class: 'mod-dot', 'aria-hidden': 'true' }, ['●']) : null,
          d.dirty ? el(this.doc, 'span', { class: 'sr-only' }, [' (modified)']) : null,
        ]),
      );
      const sim = this.simulation;
      if (sim) st.appendChild(el(this.doc, 'span', { class: 'sim-marker', title: 'A simulation is on: the diagram shows a simulated state; the model is unchanged' }, [el(this.doc, 'span', { 'aria-hidden': 'true' }, ['◈ ']), el(this.doc, 'span', { class: 'sim-marker-text' }, [sim.marker()])]));
      const rest = el(this.doc, 'span', { class: 'status-rest' });
      st.appendChild(rest);
      const parts: Array<HTMLElement | string> = [
        el(this.doc, 'span', { class: 'file-state', 'data-file': fs.kind }, [fs.text]),
        d.dirty ? el(this.doc, 'span', { class: 'dirty' }, ['unsaved changes']) : '',
        m ? `${m.title} · ${m.devices.length} devices · ${m.index.interfaces.size} interfaces · ${m.links.length} cables · ${m.networks.length} networks · ${m.relations.length} logical relations${m.interconnects.length ? ` · ${m.interconnects.length} non-IP interconnect${m.interconnects.length === 1 ? '' : 's'}` : ''}` : '',
        d.errors.length ? el(this.doc, 'span', { class: 'errcount' }, [`${d.errors.length} error${d.errors.length > 1 ? 's' : ''}`]) : '',
        d.warnings.length ? `${d.warnings.length} warning${d.warnings.length > 1 ? 's' : ''}` : '',
        d.findings.length ? `${d.findings.length} check finding${d.findings.length > 1 ? 's' : ''}` : '',
        s && s.isFiltered() ? el(this.doc, 'span', { class: 'filtered-note' }, [`showing ${s.shownDevices().size} of ${s.model.devices.length} devices`]) : '',
        s && !this.typesSummary().all ? el(this.doc, 'span', { class: 'filtered-note types-note' }, [`device types: ${this.typesSummary().text} (off: ${this.typesSummary().off.join(', ')})`]) : '',
      ].filter((p) => p !== '');
      parts.forEach((p, i) => {
        if (i) rest.appendChild(this.doc.createTextNode(' · '));
        rest.appendChild(typeof p === 'string' ? this.doc.createTextNode(p) : p);
      });
      rest.title = rest.textContent || '';
      this.doc.title = `${d.dirty ? '● ' : ''}${m ? m.title : d.fileName} — netatlas`;
    } else {
      st.textContent = this.loadErrors.length ? `${this.loadErrorName}: ${this.loadErrors.length} error(s)` : 'No model open · everything runs locally in this page';
      this.doc.title = 'netatlas';
    }
    // the diagram filters need a drawn model: on the start screen they are greyed out and show their defaults
    const opts: Array<[string, boolean]> = [
      ['opt-labels', s ? s.state.showLabels : true],
      ['opt-groups', s ? s.state.showGroups : true],
      ['opt-networks', s ? s.state.showNetworks : true],
      ['opt-routes', s ? s.state.showRoutes : true],
    ];
    for (const [id, v] of opts) {
      const cb = this.$(id) as HTMLInputElement;
      cb.checked = v;
      cb.disabled = !s;
    }
    // the physical view's connections: IP, non-IP, or both — offered when the model has non-IP interconnects
    const hasIc = !!s && s.model.interconnects.length > 0;
    for (const [id, on] of [['opt-ip', !s || s.state.connections !== 'nonip'], ['opt-nonip', !s || s.state.connections !== 'ip']] as Array<[string, boolean]>) {
      const cb = this.$(id) as HTMLInputElement;
      cb.checked = on;
      cb.disabled = !s;
      (cb.parentElement as HTMLElement).hidden = !hasIc;
    }
    this.updateTypesControl();
    this.updateDevicesControl();
    this.updateLayoutStatus();
    this.layoutFilters();
  }

  /**
   * The Auto-arrange buttons (Default, Compact, Structured) and the layout
   * status of the shown view. The strategy whose result the view shows is
   * marked as selected (aria-pressed) and disabled: there is nothing to do.
   * A strategy that gives exactly the same positions for this model is
   * disabled too and says so, instead of pretending to differ. When no
   * strategy matches (positions moved by hand, or edits since arranging),
   * all three are available. Always derived from the positions themselves
   * (document, or the session for a filtered view), never from the last
   * button pressed, so it is right after undo, reload and manual moves.
   */
  private updateLayoutStatus(): void {
    const d = this.mdoc;
    const s = this.session;
    const group = this.$('arrange-group');
    const desc = this.$('arrange-status');
    const buttons = STRATEGIES.map((st) => this.$('btn-arrange-' + st) as HTMLButtonElement);
    for (const v of ['physical', 'logical'] as View[]) {
      // a filtered view has its own, temporary layout status
      if (d && s) {
        group.setAttribute('data-status-' + v, s.isFiltered() ? s.filteredStatus(v) : d.layoutStatus(v));
        const m = s.isFiltered() ? s.filteredArrangedWith(v) : d.arrangedWith(v);
        group.setAttribute('data-strategy-' + v, m.length ? m[0] : '');
      } else {
        group.removeAttribute('data-status-' + v);
        group.removeAttribute('data-strategy-' + v);
      }
    }
    if (!d || !s) {
      group.removeAttribute('data-status');
      group.removeAttribute('data-view');
      group.removeAttribute('data-filtered');
      for (const b of buttons) {
        b.disabled = true;
        b.setAttribute('aria-pressed', 'false');
        b.classList.remove('current', 'same');
        b.title = 'Open or create a model first';
      }
      desc.textContent = '';
      return;
    }
    const view = s.state.view;
    const filtered = s.isFiltered();
    const matches = filtered ? s.filteredArrangedWith(view) : d.arrangedWith(view);
    const status = filtered ? s.filteredStatus(view) : d.layoutStatus(view);
    const current = matches.length ? matches[0] : null;
    group.setAttribute('data-status', status);
    group.setAttribute('data-view', view);
    if (filtered) group.setAttribute('data-filtered', 'true');
    else group.removeAttribute('data-filtered');
    STRATEGIES.forEach((st, i) => {
      const b = buttons[i];
      const isCurrent = st === current;
      const same = !isCurrent && matches.indexOf(st) >= 0;
      b.disabled = isCurrent || same;
      b.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      b.classList.toggle('current', isCurrent);
      b.classList.toggle('same', same);
      const what = STRATEGY_HELP[st];
      b.title = isCurrent
        ? `${STRATEGY_LABEL[st]}: the ${view} view is arranged this way.`
        : same
          ? `${STRATEGY_LABEL[st]}: gives exactly the same positions as ${STRATEGY_LABEL[current as ArrangeStrategy]} for this ${filtered ? 'filtered view' : 'model'}, so there is nothing to change.`
          : `${STRATEGY_LABEL[st]}: ${what} ${filtered ? 'Arranges the devices shown, temporarily; the saved layout is not changed.' : `Arranges the ${view} view; the other view is not changed.${st === 'default' ? ' (A)' : ''}`}`;
    });
    // after moves or edits, a view arranged with Structured keeps its right-angle lines: said, so it is no surprise
    const routed = s.routingFor(view) === 'orthogonal' ? ' Its lines keep the right angles of Structured.' : '';
    const msg = current
      ? `The ${filtered ? 'filtered ' : ''}${view} view is arranged with ${STRATEGY_LABEL[current]}${matches.length > 1 ? ` (${matches.slice(1).map((x) => STRATEGY_LABEL[x]).join(', ')} ${matches.length > 2 ? 'give' : 'gives'} the same positions)` : ''}.`
      : (filtered ? FILTERED_STATUS_MESSAGE.manual : LAYOUT_STATUS_MESSAGE[status as 'manual' | 'edited']) + routed;
    if (desc.textContent !== msg) desc.textContent = msg;
    group.title = msg;
  }

  // ------------------------------------------------------------ Find menu

  /** Is the Find bar open? */
  get findOpen(): boolean {
    return !this.$('find-bar').hidden;
  }

  /**
   * Find → Find in diagram… (or "/"): open the Find bar over the top right of the
   * diagram and put the cursor in it. Typing lists matching objects;
   * Enter or a click selects one. Needs a drawn model.
   */
  openFind(): boolean {
    if (!this.session) return false;
    this.openMenu(null);
    this.$('find-bar').hidden = false;
    const q = this.$<HTMLInputElement>('search');
    q.focus();
    q.select();
    return true;
  }

  /** Close the Find bar: its text and results go; with `refocus`, the focus returns to the diagram. */
  closeFind(refocus = false): void {
    const q = this.$<HTMLInputElement>('search');
    const hadFocus = this.doc.activeElement === q;
    q.value = '';
    const results = this.$('search-results');
    results.hidden = true;
    while (results.firstChild) results.removeChild(results.firstChild);
    this.$('find-bar').hidden = true;
    if (refocus && hadFocus) q.blur();
  }

  /**
   * Find → Filter object list…: show the filter box at the top of the model
   * outline and put the cursor in it. It stays while it holds text; × or
   * Esc clears and closes it.
   */
  openOutlineFilter(): boolean {
    if (!this.mdoc) return false;
    this.openMenu(null);
    this.editor.filterOpen = true;
    this.renderOutline();
    const f = this.$('outline-body').querySelector('[data-t="outline-filter"]') as HTMLInputElement | null;
    if (f) {
      f.focus();
      f.select();
    }
    return !!f;
  }

  // ------------------------------------------------------ toolbar filters

  /** width of each filter switch as last measured in the toolbar (a collapsed one keeps its last width) */
  private optWidth = new Map<HTMLElement, number>();
  private moreBtnWidth = 0;
  /** the width of the Filters button with its longest label (measured once): the room the filter group keeps for it */
  private moreBtnFull = 0;
  private relayingFilters = false;

  /** The filter switches of the toolbar, in page order (Labels … Servers). */
  private filterOpts(): HTMLElement[] {
    return Array.prototype.slice.call(this.doc.querySelectorAll('#view-filters label.opt')) as HTMLElement[];
  }

  /**
   * Keep the diagram filters on one toolbar row. Devices always stays; the
   * switches follow while they fit, by priority (Labels, Groups / Locations,
   * Networks, Routes, Endpoints, Servers). The ones that don't fit move into the
   * **Filters** drop-down beside them, whose button says how many of them
   * are switched off. Recomputed when the window, the view or a filter
   * changes. Only switches whose place changes are moved, so the one in use
   * keeps the focus.
   */
  layoutFilters(): void {
    const box = this.$('view-filters');
    const panel = this.$('more-filters');
    const btn = this.$('more-filters-btn') as HTMLButtonElement;
    const wrap = btn.parentElement as HTMLElement;
    const devices = box.querySelector('.devices-wrap') as HTMLElement;
    const win = this.doc.defaultView as Window;
    const opts = this.filterOpts();
    const gap = parseFloat(win.getComputedStyle(box).columnGap) || 8;
    for (const o of opts) if (o.parentElement === box && o.offsetWidth > 0) this.optWidth.set(o, o.getBoundingClientRect().width);
    if (!btn.hidden && btn.offsetWidth > 0) {
      this.moreBtnWidth = btn.getBoundingClientRect().width;
      // and once, its width with the longest label ("Filters · 9 off")
      if (!this.moreBtnFull) {
        const count = this.$('more-filters-count');
        const keep = count.textContent;
        count.textContent = ' · 9 off';
        this.moreBtnFull = Math.ceil(btn.getBoundingClientRect().width);
        count.textContent = keep;
      }
    }
    const logical = this.doc.body.getAttribute('data-view') === 'logical';
    const shown = (o: HTMLElement): boolean => (logical || !o.classList.contains('logical-only')) && !(logical && o.classList.contains('physical-only')) && !o.hidden;
    const width = (o: HTMLElement): number => this.optWidth.get(o) || 110;
    const btnW = this.moreBtnWidth || 96;
    // Devices and Device types always stay in the row
    const types = box.querySelector('.types-wrap') as HTMLElement;
    const devW = devices.getBoundingClientRect().width + gap + types.getBoundingClientRect().width;
    // The row sits in the framed Filters group, which sits at the right of a slot taking the rest of the
    // toolbar. The room for the row is the slot's width less the group's frame and padding.
    const slot = this.$('filters-slot');
    const frame = this.$('filters-group');
    const chrome = frame.offsetWidth - box.offsetWidth;
    // the group needs room for Devices and the Filters button at least; with less it moves to a row of its own, as one piece
    // (counted with the button's longest label, so switching a filter off never moves the group to another row)
    slot.style.minWidth = Math.ceil(devW + gap + Math.max(btnW, this.moreBtnFull) + chrome) + 'px';
    const avail = slot.clientWidth - chrome;
    const byPriority = opts.slice().sort((a, b) => Number(b.getAttribute('data-priority')) - Number(a.getAttribute('data-priority')));
    const inline = new Set<HTMLElement>();
    const all = byPriority.filter(shown).reduce((m, o) => m + gap + width(o), devW);
    if (all <= avail + 0.5) opts.forEach((o) => inline.add(o));
    else {
      let used = devW + gap + btnW;
      for (const o of byPriority) {
        if (!shown(o)) continue;
        if (used + gap + width(o) > avail + 0.5) break;
        inline.add(o);
        used += gap + width(o);
      }
    }
    // move only what changes place, in page order
    const active = this.doc.activeElement as HTMLElement | null;
    opts.forEach((o, i) => {
      const home = inline.has(o) ? box : panel;
      if (o.parentElement === home) return;
      const next = opts.slice(i + 1).find((x) => x.parentElement === home);
      home.insertBefore(o, next || (home === box ? wrap : null));
    });
    if (active && active !== this.doc.activeElement && this.doc.contains(active)) active.focus();
    const collapsed = opts.filter((o) => !inline.has(o) && shown(o));
    btn.hidden = collapsed.length === 0;
    // like the switches inside it, the drop-down needs a drawn model
    btn.disabled = !this.session;
    if (btn.hidden || btn.disabled) this.openMoreFilters(false);
    // (a switch is off when unchecked; the connections choice when it leaves something out)
    const off = collapsed.filter((o) => {
      const cb = o.querySelector('input') as HTMLInputElement | null;
      if (cb) return !cb.checked;
      const sel = o.querySelector('select') as HTMLSelectElement | null;
      return !!sel && sel.value !== 'all';
    });
    const name = (o: HTMLElement): string => (o.textContent || '').trim();
    this.$('more-filters-count').textContent = off.length ? ` · ${off.length} off` : '';
    btn.classList.toggle('filtered', off.length > 0);
    btn.setAttribute('data-off', String(off.length));
    btn.setAttribute('aria-label', `More diagram filters: ${collapsed.map(name).join(', ')}${off.length ? ` (${off.map(name).join(', ')} off)` : ''}`);
    btn.title = off.length ? `Switched off here: ${off.map(name).join(', ')}` : `More filters: ${collapsed.map(name).join(', ')}`;
    // the button just appeared, or its label changed its width: once more with the measured widths, so the row settles now
    if (!this.relayingFilters && !btn.hidden && btn.offsetWidth > 0 && (!this.moreBtnFull || Math.abs(btn.getBoundingClientRect().width - btnW) > 0.5)) {
      this.relayingFilters = true;
      try {
        this.layoutFilters();
      } finally {
        this.relayingFilters = false;
      }
    }
  }

  /** Open or close the Filters drop-down; `focus` moves the focus to its first switch (keyboard use). */
  openMoreFilters(open: boolean, focus = false): void {
    const panel = this.$('more-filters');
    const btn = this.$('more-filters-btn') as HTMLButtonElement;
    const show = open && !btn.hidden && !btn.disabled;
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    btn.classList.toggle('active', show);
    if (!show) return;
    this.openMenu(null);
    this.openDevices(false);
    this.openTypes(false);
    this.keepInWindow(panel);
    if (focus) {
      const first = panel.querySelector('input:not(:disabled)') as HTMLElement | null;
      if (first) first.focus();
    }
  }

  private wireMoreFilters(): void {
    const btn = this.$('more-filters-btn');
    const panel = this.$('more-filters');
    // a click made with the keyboard (Enter, Space) has no pointer position: the focus then goes into the drop-down
    btn.addEventListener('click', (e) => this.openMoreFilters(panel.hidden, (e as MouseEvent).detail === 0));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.openMoreFilters(true, true);
      }
    });
    panel.addEventListener('keydown', (e) => {
      const boxes = (Array.prototype.slice.call(panel.querySelectorAll('input')) as HTMLElement[]).filter((x) => x.offsetParent !== null);
      const at = boxes.indexOf(this.doc.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.openMoreFilters(false);
        btn.focus();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && boxes.length) {
        e.preventDefault();
        boxes[(at + (e.key === 'ArrowDown' ? 1 : boxes.length - 1)) % boxes.length].focus();
      }
    });
    this.doc.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !(e.target as Element).closest('.more-filters-wrap')) this.openMoreFilters(false);
    });
  }

  // ------------------------------------------------------------ device filter

  /** The Devices control: its count, its state and the temporary-positions hint. */
  private updateDevicesControl(): void {
    const s = this.session;
    const btn = this.$('devices-btn') as HTMLButtonElement;
    const count = this.$('devices-count');
    const hint = this.$('filter-hint');
    btn.disabled = !s;
    const filtered = !!s && s.isFiltered();
    btn.classList.toggle('filtered', filtered);
    btn.setAttribute('data-filtered', filtered ? 'true' : 'false');
    const byType = !!s && s.state.hiddenTypes.size > 0;
    count.textContent = !s ? 'all' : filtered ? `${s.shownDevices().size} of ${s.model.devices.length}` : `all (${s.model.devices.length})`;
    btn.title = filtered
      ? 'The diagram shows only the selected devices' + (byType ? ' that are not of a type switched off in the toolbar' : '') + '. Choose devices, or Select all for the complete diagram.'
      : 'Choose the devices the diagram shows';
    // (in focus mode the banner says it)
    hint.hidden = !filtered || !!(s && s.state.focus);
    const none = filtered && !!s && s.shownDevices().size === 0;
    // (the physical view draws a guest only inside its host)
    const orphans = s ? s.hiddenWithHost() : [];
    const orphanText = orphans.length
      ? `${orphans.length === 1 ? `${s ? (s.model.index.devices.get(orphans[0]) || { label: orphans[0] }).label : orphans[0]} is` : `${orphans.length} guests are`} not shown: ${orphans.length === 1 ? 'its host is' : 'their hosts are'} hidden, and a guest is drawn inside its host. `
      : '';
    this.$('filter-hint-text').textContent =
      (none ? (s && s.selectedDevices().size ? 'No devices shown: the selected ones are of types switched off. ' : 'No devices selected: choose devices, or Select all. ') : '') + orphanText + 'Filtered-view positions are temporary and are not saved in YAML.';
    if (!s) this.$('devices-panel').hidden = true;
    if (!this.$('devices-panel').hidden) this.syncDevicesList();
  }

  /**
   * Bring the open list in step with the selection without rebuilding it,
   * so the checkbox that has the focus keeps it. Rebuilt only when the
   * model's devices changed.
   */
  private syncDevicesList(): void {
    const s = this.session;
    if (!s) return;
    const boxes = this.$('devices-list').querySelectorAll('input[data-device]');
    const stale = (b: Element): boolean => {
      const d = s.model.index.devices.get(b.getAttribute('data-device') || '');
      return !d || (b.parentElement as Element).classList.contains('type-hidden') !== s.isDeviceTypeHidden(d);
    };
    if (boxes.length !== s.model.devices.length || Array.prototype.some.call(boxes, stale)) {
      this.renderDevicesList();
      return;
    }
    const sel = s.selectedDevices();
    for (let i = 0; i < boxes.length; i++) (boxes[i] as HTMLInputElement).checked = sel.has(boxes[i].getAttribute('data-device') || '');
  }

  /** The checkbox list of the Devices panel, alphabetically by name; the find box only hides rows. */
  private renderDevicesList(): void {
    const s = this.session;
    const list = this.$('devices-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!s) return;
    const sel = s.selectedDevices();
    const q = this.$<HTMLInputElement>('devices-find').value.trim().toLowerCase();
    for (const d of sortedByName(s.model.devices, (x) => x.label)) {
      const name = d.label !== d.id ? `${d.label} (${d.id})` : d.id;
      const cb = el(this.doc, 'input', { type: 'checkbox', 'data-device': d.id }) as HTMLInputElement;
      cb.checked = sel.has(d.id);
      // a device of a type switched off stays selectable here; it is shown again with its type
      const off = s.isDeviceTypeHidden(d);
      const row = el(this.doc, 'label', { 'data-device-row': d.id, class: off ? 'type-hidden' : '' }, [
        cb,
        el(this.doc, 'span', {}, [name]),
        off ? el(this.doc, 'span', { class: 'dp-off' }, [`hidden: type ${typeKeyLabel(typeKey(d))} off`]) : null,
      ]);
      if (q && name.toLowerCase().indexOf(q) < 0) row.hidden = true;
      list.appendChild(row);
    }
  }

  private openDevices(open: boolean, focus = false): void {
    const panel = this.$('devices-panel');
    const btn = this.$('devices-btn');
    if (open && !this.session) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
    if (open) {
      this.openMenu(null);
      this.openMoreFilters(false);
      this.openTypes(false);
      this.renderDevicesList();
      this.keepInWindow(panel);
      if (focus) this.$('devices-find').focus();
    }
  }

  /**
   * Show only these devices (all of them: the complete diagram). A new
   * subset is arranged for itself and fitted to the window; the saved layout
   * is never touched. Nothing happens when the selection is unchanged.
   */
  setDevices(ids: Iterable<string>): boolean {
    const s = this.session;
    if (!s || !s.setDevices(ids)) return false;
    this.render();
    this.fit();
    this.updateChrome();
    return true;
  }

  /**
   * Show or hide the devices of types (the toolbar's Device types filter;
   * keys as model/device-types.ts typeKey). Like the device selection it
   * only changes what the diagrams and their exports show; the model, the
   * YAML and the saved layout stay as they are. The other devices keep
   * their places, so the zoom is kept too.
   */
  setTypeVisible(type: string | string[], visible: boolean): boolean {
    const s = this.session;
    if (!s || !s.setTypesVisible(Array.isArray(type) ? type : [type], visible)) return false;
    this.render();
    this.renderOutline();
    this.updateChrome();
    return true;
  }

  // ------------------------------------------------------------ device types filter

  /**
   * The Device types filter's entries: the types the model uses (in the
   * order of the format's list), each with its keys and its number of
   * devices; a switch with both kinds lists Layer 2 and Layer 3 under it,
   * a server with more than one kind its Hypervisor, Container host and
   * Other servers.
   */
  typeEntries(): Array<{ type: string; label: string; keys: string[]; count: number; subs: Array<{ key: string; label: string; count: number }> }> {
    const s = this.session;
    if (!s) return [];
    const per = new Map<string, number>();
    for (const d of s.model.devices) per.set(typeKey(d), (per.get(typeKey(d)) || 0) + 1);
    const out: Array<{ type: string; label: string; keys: string[]; count: number; subs: Array<{ key: string; label: string; count: number }> }> = [];
    for (const t of DEVICE_TYPES) {
      const keys = typeKeysOf(t.id).filter((k) => per.has(k));
      if (!keys.length) continue;
      const count = keys.reduce((n, k) => n + (per.get(k) || 0), 0);
      const subs = keys.length > 1 ? keys.map((k) => ({ key: k, label: typeKeySubLabel(k), count: per.get(k) || 0 })) : [];
      out.push({ type: t.id, label: t.label, keys, count, subs });
    }
    // devices without a type (or of an unknown one)
    for (const [k, n] of Array.from(per).sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (!out.some((e) => e.keys.indexOf(k) >= 0)) out.push({ type: k, label: k ? typeKeyLabel(k) : 'No type', keys: [k], count: n, subs: [] });
    return out;
  }

  /** "All", or how many of the model's types are wholly shown ("3 of 8"), and which are off. */
  typesSummary(): { all: boolean; text: string; off: string[] } {
    const s = this.session;
    const es = this.typeEntries();
    if (!s) return { all: true, text: 'All', off: [] };
    const off: string[] = [];
    let shown = 0;
    for (const e of es) {
      const hiddenKeys = e.keys.filter((k) => s.isTypeHidden(k));
      if (!hiddenKeys.length) shown++;
      else if (hiddenKeys.length === e.keys.length) off.push(e.label);
      else for (const k of hiddenKeys) off.push(typeKeyLabel(k));
    }
    const all = shown === es.length;
    return { all, text: all ? 'All' : `${shown} of ${es.length}`, off };
  }

  private updateTypesControl(): void {
    const s = this.session;
    const btn = this.$('types-btn') as HTMLButtonElement;
    btn.disabled = !s;
    const sum = this.typesSummary();
    this.$('types-count').textContent = sum.text;
    btn.classList.toggle('filtered', !sum.all);
    btn.setAttribute('data-filtered', sum.all ? 'false' : 'true');
    btn.setAttribute('aria-label', `Device types: ${sum.all ? 'all shown' : `${sum.text} shown; off: ${sum.off.join(', ')}`}`);
    btn.title = sum.all ? 'Choose the device types the diagram shows' : `Switched off: ${sum.off.join(', ')}`;
    if (!s) this.$('types-panel').hidden = true;
    if (!this.$('types-panel').hidden) this.syncTypesList();
  }

  /** The checkbox list of the Device types panel. */
  private renderTypesList(): void {
    const list = this.$('types-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const e of this.typeEntries()) {
      const cb = el(this.doc, 'input', { type: 'checkbox', 'data-type-keys': e.keys.join(' ') }) as HTMLInputElement;
      list.appendChild(el(this.doc, 'label', { class: 'tp-row', 'data-type-row': e.type }, [cb, el(this.doc, 'span', {}, [e.label]), el(this.doc, 'span', { class: 'tp-count', 'aria-hidden': 'true' }, [String(e.count)]), el(this.doc, 'span', { class: 'sr-only' }, [`, ${e.count} device${e.count === 1 ? '' : 's'}`])]));
      for (const sub of e.subs) {
        const sc = el(this.doc, 'input', { type: 'checkbox', 'data-type-keys': sub.key }) as HTMLInputElement;
        const what = ' ' + deviceTypeInText(e.type, true);
        list.appendChild(el(this.doc, 'label', { class: 'tp-row tp-sub', 'data-type-row': sub.key }, [sc, el(this.doc, 'span', {}, [sub.label]), el(this.doc, 'span', { class: 'tp-count', 'aria-hidden': 'true' }, [String(sub.count)]), el(this.doc, 'span', { class: 'sr-only' }, [`${what}, ${sub.count} device${sub.count === 1 ? '' : 's'}`])]));
      }
    }
    this.syncTypesList();
  }

  /** The boxes in step with what is hidden (a switch with one kind off: mixed). */
  private syncTypesList(): void {
    const s = this.session;
    if (!s) return;
    const boxes = this.$('types-list').querySelectorAll('input[data-type-keys]');
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i] as HTMLInputElement;
      const keys = (b.getAttribute('data-type-keys') || '').split(' ');
      const off = keys.filter((k) => s.isTypeHidden(k)).length;
      b.checked = off === 0;
      b.indeterminate = off > 0 && off < keys.length;
    }
  }

  private openTypes(open: boolean, focus = false): void {
    const panel = this.$('types-panel');
    const btn = this.$('types-btn');
    if (open && !this.session) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
    if (open) {
      this.openMenu(null);
      this.openMoreFilters(false);
      this.openDevices(false);
      this.renderTypesList();
      this.keepInWindow(panel);
      if (focus) {
        const first = panel.querySelector('input[data-type-keys]') as HTMLElement | null;
        (first || (this.$('types-all') as HTMLElement)).focus();
      }
    }
  }

  /** Open the Device types filter, with the focus in it. */
  openTypesFilter(): void {
    if (this.session) this.openTypes(true, true);
  }

  private wireTypes(): void {
    const btn = this.$('types-btn');
    const panel = this.$('types-panel');
    btn.addEventListener('click', () => this.openTypes(panel.hidden));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.openTypes(true, true);
      }
    });
    panel.addEventListener('change', (e) => {
      const cb = e.target as HTMLInputElement;
      const keys = (cb.getAttribute('data-type-keys') || '').split(' ').filter((k) => k);
      if (!keys.length) return;
      this.setTypeVisible(keys, cb.checked);
      this.syncTypesList();
    });
    const allKeys = (): string[] => this.typeEntries().reduce((a: string[], e) => a.concat(e.keys), []);
    this.$('types-all').addEventListener('click', () => {
      this.setTypeVisible(allKeys(), true);
      this.syncTypesList();
    });
    this.$('types-none').addEventListener('click', () => {
      this.setTypeVisible(allKeys(), false);
      this.syncTypesList();
    });
    // Esc on the button or in the panel closes it
    (btn.parentElement as HTMLElement).addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.preventDefault();
        e.stopPropagation();
        this.openTypes(false);
        btn.focus();
      }
    });
    this.doc.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !(e.target as Element).closest('.types-wrap')) this.openTypes(false);
    });
  }

  private wireDevices(): void {
    const btn = this.$('devices-btn');
    const panel = this.$('devices-panel');
    btn.addEventListener('click', () => this.openDevices(panel.hidden));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.openDevices(true, true);
      }
    });
    panel.addEventListener('change', (e) => {
      const cb = e.target as HTMLInputElement;
      const id = cb.getAttribute('data-device');
      if (!id || !this.session) return;
      const ids = this.session.selectedDevices();
      if (cb.checked) ids.add(id);
      else ids.delete(id);
      this.setDevices(ids);
    });
    this.$('devices-find').addEventListener('input', () => this.renderDevicesList());
    this.$('devices-all').addEventListener('click', () => this.session && this.setDevices(this.session.model.devices.map((d) => d.id)));
    this.$('devices-none').addEventListener('click', () => this.setDevices([]));
    // Esc on the button or in the panel closes it
    (btn.parentElement as HTMLElement).addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.preventDefault();
        e.stopPropagation();
        this.openDevices(false);
        btn.focus();
      }
    });
    this.doc.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !(e.target as Element).closest('.devices-wrap')) this.openDevices(false);
    });
  }

  private fillExamples(): void {
    const menu = this.$('menu-examples');
    EXAMPLES.forEach((ex, i) =>
      menu.appendChild(el(this.doc, 'button', { type: 'button', role: 'menuitem', 'data-example': String(i), title: `Open the example ${ex.name}` }, [el(this.doc, 'span', { class: 'mi-label' }, [ex.name]), el(this.doc, 'span', { class: 'mi-hint mi-state' })])),
    );
    // the start screen's picker names each example by its title
    const pick = this.$('start-example');
    EXAMPLES.forEach((ex, i) => {
      const m = /^title:[ \t]*(.*)$/m.exec(ex.text);
      const title = m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
      pick.appendChild(el(this.doc, 'option', { value: String(i) }, [title || ex.name]));
    });
  }

  // ------------------------------------------------------ dialogs / toasts

  /**
   * Modal dialog (see dialogs.ts); resolves with the clicked button's value.
   * A quick action of the object list that asks (Delete, from the keyboard)
   * stays shown while its dialog is open, so the focus can return to it.
   */
  async dialog(opts: DialogOpts): Promise<string> {
    const opener = this.doc.activeElement as HTMLElement | null;
    const row = opener && opener.closest ? opener.closest('#outline .ol-row') : null;
    if (row) row.classList.add('acting');
    try {
      return await showDialog(this.doc, opts);
    } finally {
      if (row) row.classList.remove('acting');
    }
  }

  toast(msg: string): void {
    showToast(this.doc, msg);
  }

  // ------------------------------------------------------------ commands

  /** every action of the menus, toolbar, keyboard and palette (commands.ts) */
  readonly commands: Command[] = buildCommands();

  /** A command of the registry by id. */
  command(id: string): Command | undefined {
    return this.commands.find((c) => c.id === id);
  }

  /** Run a command if it is available now; returns whether it ran. */
  runCommand(id: string): boolean {
    const c = this.command(id);
    if (!c || !c.state(this).enabled) return false;
    this.openMenu(null);
    c.run(this);
    return true;
  }

  /**
   * Bring every element that names a command (data-command: the menus'
   * entries, the focus controls) in step with the registry: available or
   * not, its tooltip (or why it is not available), and in a menu its label
   * and shortcut.
   */
  syncCommands(): void {
    const mac = isMac(this.doc.defaultView);
    const els = this.doc.querySelectorAll('[data-command]');
    for (let i = 0; i < els.length; i++) {
      const b = els[i] as HTMLButtonElement;
      const c = this.command(b.getAttribute('data-command') as string);
      if (!c) continue;
      const st = c.state(this);
      b.disabled = !st.enabled;
      b.title = st.enabled ? st.title || c.label : st.reason || '';
      const label = b.querySelector('.mi-label');
      if (label) label.textContent = c.menuLabel || c.label;
      const hint = b.querySelector('.mi-hint');
      if (hint && c.keys) hint.textContent = keyLabel(c.keys, mac);
    }
  }

  /** The name of the model file this page may write (Save model), or null. */
  get linkedFileName(): string | null {
    return this.linked && this.handle ? this.handle.name : null;
  }

  /** File → New model (asks first when there are unsaved changes). */
  async requestNew(): Promise<void> {
    if (await this.confirmDiscard('Creating a new model')) this.newModel();
  }

  /** File → Open model… (asks first when there are unsaved changes). */
  async requestOpen(): Promise<void> {
    if (await this.confirmDiscard('Opening another model')) await this.openModel();
  }

  /** Open a built-in example (asks first when there are unsaved changes). */
  async requestExample(n: number): Promise<void> {
    if (await this.confirmDiscard('Loading an example')) this.loadExample(n);
  }

  /** Why an Auto-arrange option can't run now ('' = it can). */
  arrangeBlocked(strategy: ArrangeStrategy): string {
    const s = this.session;
    const d = this.mdoc;
    if (!s || !d) return 'Open or create a model first';
    const view = s.state.view;
    const matches = s.isFiltered() ? s.filteredArrangedWith(view) : d.arrangedWith(view);
    if (matches[0] === strategy) return `The ${view} view is arranged this way`;
    if (matches.indexOf(strategy) >= 0) return `The ${view} view already looks like ${STRATEGY_LABEL[strategy]}`;
    return '';
  }

  /** Is a toolbar filter switch on? */
  optionChecked(id: string): boolean {
    const i = this.doc.getElementById(id) as HTMLInputElement | null;
    return !!i && i.checked;
  }

  /** Flip a toolbar filter switch, as a click on it would. */
  toggleOption(id: string): void {
    const i = this.doc.getElementById(id) as HTMLInputElement | null;
    if (i && !i.disabled) i.click();
  }

  /** Open the Devices filter list, with the focus in it. */
  openDevicesFilter(): void {
    if (this.session) this.openDevices(true, true);
  }

  /** A short name for an object ("hq-rtr1", "GRE gre-muc", "Users (net-users)"). */
  refName(ref: string): string {
    const m = this.session ? this.session.model : null;
    const h = m ? headOf(m, ref) : null;
    return h ? h.title : ref;
  }

  // ------------------------------------------------------------ focus mode

  /** the zoom before focus mode began, restored when it ends */
  private zoomBeforeFocus: { k: number; tx: number; ty: number } | null = null;

  /** Can this object be focused on (does it stand for at least one device)? */
  canFocus(ref: string): boolean {
    return !!this.session && focusSeeds(this.session.model, ref).length > 0;
  }

  /**
   * Analyze → Focus on selection (Shift+F, or the Focus button under the
   * diagram): show only the selected object and its neighbourhood, 1 hop to
   * start with (or the hops of the focus mode already on). A banner over the
   * diagram names it, changes the hops (1–3) and exits (also Esc). Nothing
   * in the model changes; no undo step.
   */
  enterFocus(ref: string | null = this.session ? this.session.state.selected : null, hops?: number): boolean {
    const s = this.session;
    if (!s || !ref || !this.canFocus(ref)) return false;
    const was = s.state.focus;
    if (!was) this.zoomBeforeFocus = { k: this.zoom.k, tx: this.zoom.tx, ty: this.zoom.ty };
    if (!s.setFocus(ref, hops || (was ? was.hops : this.focusHops))) return false;
    if (this.ws === 'analyze') this.anFocus = true;
    this.focusHops = (s.state.focus as { hops: number }).hops;
    this.render();
    this.updateChrome();
    this.fit();
    this.renderFocusWindow();
    return true;
  }

  /** the hops the Focus window offers (kept while the page is open) */
  private focusHops = 1;

  /**
   * A contextual focus (the Focus window's actions for the selection): the
   * devices of a VLAN, of the dependencies of a device's applications and
   * services, of a multicast group, of a timing domain. Configured structure,
   * not proof of reachability; Exit focus (Esc) ends it like any focus.
   */
  enterContextFocus(c: FocusContext): boolean {
    const s = this.session;
    const ref = s ? s.state.selected : null;
    if (!s || !ref) return false;
    const was = s.state.focus;
    if (!was) this.zoomBeforeFocus = { k: this.zoom.k, tx: this.zoom.tx, ty: this.zoom.ty };
    if (!s.setFocus(ref, this.focusHops, c)) return false;
    if (this.ws === 'analyze') this.anFocus = true;
    this.render();
    this.updateChrome();
    this.fit();
    this.renderFocusWindow();
    return true;
  }

  /**
   * Analyze → Focus… (Shift+F): the Focus window, with the selection, its
   * 1–3 hops, Focus and Exit focus. `apply`: focus on the selection at once
   * (when it can be focused).
   */
  openFocusWindow(apply = false): void {
    const s = this.session;
    if (!s) return;
    const opened = this.analyzeTool() !== 'focus';
    if (opened) this.showAnalyze('focus');
    const sel = s.state.selected;
    if (apply && sel && this.canFocus(sel) && !(s.state.focus && s.state.focus.ref === sel)) this.enterFocus(sel, this.focusHops);
    else this.renderFocusWindow();
    // focused at once, Focus is unavailable now: the keyboard goes to the hops in effect, not lost on the page
    const win = this.doc.getElementById('ws-an-left');
    if (opened && win && !win.contains(this.doc.activeElement)) {
      const to = win.querySelector('[data-focus-hops][aria-checked="true"]') || win.querySelector('#focus-go:not([disabled])');
      if (to) (to as HTMLElement).focus();
    }
  }

  private renderFocusWindow(): void {
    if (this.analyzeTool() === 'focus' && this.session) this.renderAnalyzeWs();
  }

  private focusBody(): HTMLElement {
    const s = this.session as Session;
    const sel = s.state.selected;
    const f = s.state.focus;
    const blocked = !sel ? 'Select an object first: in the diagram or the object list' : !this.canFocus(sel) ? 'The selection has no device to start from' : f && f.ref === sel && f.hops === this.focusHops ? 'Focus mode shows this already' : '';
    const contexts = sel ? focusContexts(s.model, sel) : [];
    const active = f && f.context ? JSON.stringify(f.context) : '';
    const body = focusWindowBody(this.doc, { selected: sel ? this.refName(sel) : '', blocked, hops: this.focusHops, note: this.focusNote(), contexts: contexts.map((c) => ({ key: JSON.stringify(c.ctx), label: c.label, on: JSON.stringify(c.ctx) === active })) });
    const pick = (n: number): void => {
      this.focusHops = n;
      const cur = s.state.focus;
      if (cur && cur.hops !== n) this.changeFocusHops(n - cur.hops);
      else this.renderFocusWindow();
      const b = this.doc.querySelector(`[data-focus-hops="${n}"]`) as HTMLElement | null;
      if (b) b.focus();
    };
    this.onRoot(body, 'click', (e) => {
      const t = e.target as Element;
      const h = t.closest('[data-focus-hops]');
      if (h) pick(Number(h.getAttribute('data-focus-hops')));
      else if (t.closest('#focus-go')) this.enterFocus(s.state.selected, this.focusHops);
      else if (t.closest('[data-focus-ctx]')) {
        const key = (t.closest('[data-focus-ctx]') as Element).getAttribute('data-focus-ctx') as string;
        this.enterContextFocus(JSON.parse(key) as FocusContext);
        const b = this.doc.querySelector(`[data-focus-ctx='${key}']`) as HTMLElement | null;
        if (b) b.focus();
      }
      else if (t.closest('#focus-exit-w')) this.exitFocus();
    });
    // the hops are a radio group: the arrow keys move between them
    this.onRoot(body, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      const h = (e.target as Element).closest('[data-focus-hops]');
      if (!h || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      e.preventDefault();
      const n = Number(h.getAttribute('data-focus-hops')) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
      if (n >= 1 && n <= 3) pick(n);
    });
    return body;
  }

  /** One hop more or fewer around the focused object (1–3). */
  changeFocusHops(delta: number): boolean {
    const s = this.session;
    const f = s ? s.state.focus : null;
    if (!s || !f || !s.setFocus(f.ref, f.hops + delta)) return false;
    this.focusHops = (s.state.focus as { hops: number }).hops;
    this.renderFocusWindow();
    this.render();
    this.updateChrome();
    this.fit();
    return true;
  }

  /** Leave focus mode: the diagram as it was before, at the zoom it had. */
  exitFocus(): boolean {
    const s = this.session;
    if (!s || !s.endFocus()) return false;
    this.render();
    this.renderFocusWindow();
    const z = this.zoomBeforeFocus;
    this.zoomBeforeFocus = null;
    if (z) {
      this.zoom.k = z.k;
      this.zoom.tx = z.tx;
      this.zoom.ty = z.ty;
      this.applyZoom();
    } else this.fit();
    this.updateChrome();
    const back = this.doc.activeElement;
    if (!back || back === this.doc.body) (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    return true;
  }

  /** The text of focus mode in the banner and in exported pictures ('' = focus mode is off). */
  private focusNote(): string {
    const s = this.session;
    const f = s ? s.state.focus : null;
    if (!s || !f) return '';
    if (f.context) return `Focus: ${contextFocus(s.model, f.context).note} · ${s.shownDevices().size} of ${s.model.devices.length} devices`;
    const sense = s.state.view === 'physical' ? 'cables' : 'relations';
    return `Focus: ${this.refName(f.ref)} and what is within ${f.hops} hop${f.hops === 1 ? '' : 's'} (${sense}${this.simulation ? ' that are up in the simulated state' : ''}) · ${s.shownDevices().size} of ${s.model.devices.length} devices`;
  }

  /** The text of the path trace in the banner and in exported pictures ('' = no trace). */
  private traceNote(): string {
    const r = this.currentTrace();
    if (!r) return '';
    const run = this.traceRun;
    const where = run && run.snap ? ` on the simulation snapshot at ${simTimeText(run.snap.at)}` : '';
    // (the banner says the path; where the check's verdict differs (a policy, a listener), it says that too)
    const overall = run && run.check.verdict !== traceVerdict(r.trace) ? ` · overall: ${verdictText(run.check.verdict, 'reach')}` : '';
    let note = `Path trace${where}: ${r.req.from} → ${r.req.to}${r.req.vrf !== undefined ? ' (' + (r.req.vrf ? 'VRF ' + r.req.vrf : 'default table') + ')' : ''} · ${traceSummary(r.trace)}${overall}${this.traceOutdated() ? ' · outdated: the model changed' : ''}`;
    if (r.trace.paths.length > 1) note += ' (alternatives dashed)';
    if (r.back) note += ' · return path: ' + (r.back.error ? 'not traced' : traceSummary(r.back)) + ' (dotted)';
    return note;
  }

  /** The text of the simulation in the banner and in exported pictures ('' = no simulation). */
  private simNote(): string {
    return this.simulation ? this.simulation.note() : '';
  }

  /** The notes of the analysis modes that are on (simulation, focus, path trace), for the banner and for exported pictures. */
  modeNotes(): string[] {
    return [this.simNote(), this.focusNote(), this.traceNote()].filter((n) => n !== '');
  }

  /** All of them in one line ('' = no analysis mode is on). */
  modeNote(): string {
    return this.modeNotes().join('  |  ');
  }

  /** The banner over the diagram while an analysis mode is on: a row for focus mode, a row for the path trace. */
  private updateModeBanner(): void {
    const s = this.session;
    const f = s ? s.state.focus : null;
    const t = s ? this.currentTrace() : null;
    const v = s && this.ws === 'simulate' ? this.simulation : null;
    const w = s && (this.ws === 'experiments' || this.ws === 'analyze') ? WORKSPACES[this.ws] : null;
    const banner = this.$('mode-banner');
    banner.hidden = !f && !t && !v && !w;
    this.$('mb-ws').hidden = !w;
    if (w) {
      this.$('ws-icon').textContent = w.icon;
      this.$('ws-text').textContent = this.ws === 'experiments' ? this.expNoteLine() : this.anNoteLine();
      this.$('ws-short').textContent = w.name;
      this.$('ws-exit-banner').textContent = `Exit ${w.name}`;
    }
    this.$('mb-focus').hidden = !f;
    this.$('mb-trace').hidden = !t;
    this.$('mb-sim').hidden = !v;
    this.doc.body.setAttribute('data-mode', [v ? 'simulation' : '', w ? 'workspace' : '', f ? 'focus' : '', t ? 'trace' : ''].filter((x) => x).join(' ') || 'none');
    // the diagram says whose state it shows: the model's, a simulated one, or a workspace's marks
    this.$('sim-badge').hidden = !v && !w;
    this.$('sim-badge-mark').textContent = w ? w.icon : '◈';
    this.$('sim-badge-text').textContent = w ? w.name : 'Simulation running';
    this.svg.setAttribute('aria-label', v && s ? `Network diagram — simulated state: ${this.simNote().replace(/^Simulation: /, '')}` : 'Network diagram');
    if (!s || (!f && !t && !v && !w)) return;
    if (v) {
      this.$('sim-text').textContent = `${this.simNote()}. The model is unchanged; editing is paused.`;
      this.$('sim-short').textContent = `Simulation running · ${v.marker()}`;
    }
    if (f) {
      this.$('mode-text').textContent = this.focusNote() + '. Positions here are temporary and are not saved.';
      this.$('focus-hops').textContent = `${f.hops} hop${f.hops === 1 ? '' : 's'}`;
    }
    if (t) {
      const shown = s.shownDevices();
      const hidden = t.trace.paths.length ? Array.from(pathRefs(t.trace.paths[0])).filter((r) => r.indexOf('device:') === 0 && !shown.has(r.slice(7))).length : 0;
      this.$('trace-text').textContent = this.traceNote() + (hidden ? ` · ${hidden} device${hidden === 1 ? '' : 's'} of the path hidden by filters` : '') + '.';
    }
    // the overlays under the banner (Find bar, filter hint) start below it, however many lines it takes
    this.doc.documentElement.style.setProperty('--mode-banner-h', Math.ceil(banner.getBoundingClientRect().height) + 'px');
  }

  // ------------------------------------------------------------ routing services

  /** Why no protocol can be enabled on the selection now ('' = it can). */
  protocolTargetBlocked(): string {
    const s = this.session;
    if (!s || !this.mdoc) return 'Open or create a model first';
    const sel = s.state.selected;
    if (!sel || sel.indexOf('device:') !== 0) return 'Select a device first';
    const d = s.model.index.devices.get(sel.slice(7));
    if (!d) return 'Select a device first';
    if (isLayer2Switch(d)) return `Requires Layer 3: ${d.id} is a Layer 2 switch (tick Supports Layer 3 in its Edit tab first)`;
    if (!capabilities(d).routingProtocols) return `${d.id} is not a Layer 3+ device: only ${ROUTING_PROTOCOL_TYPES.map((t) => deviceTypeInText(t, true)).join(', ')}, Layer 3 switches and VMs, and Layer 3 forwarder Systems run routing protocols`;
    return '';
  }

  /** The selected device's Protocols section in the Edit tab, with the keyboard at "Enable a protocol". */
  openEnableProtocol(): void {
    if (this.protocolTargetBlocked()) return;
    this.tab = 'edit';
    this.renderSide();
    const sel = this.doc.querySelector('#side-body select[data-t="enable-service"]') as HTMLSelectElement | null;
    if (sel) {
      if (typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'center' });
      sel.focus();
    }
  }

  /** The selected interface's entry in the document (path and kind), or why there is none. */
  private selectedInterfacePath(): { path: (string | number)[]; loop: boolean } | string {
    const s = this.session;
    const d = this.mdoc;
    if (!s || !d) return 'Open or create a model first';
    const sel = s.state.selected;
    if (!sel || sel.indexOf('iface:') !== 0) return 'Select an interface first';
    const rest = sel.slice(6);
    const i = s.model.index.interfaces.get(rest);
    const dev = i ? d.findEntity('device', i.device) : null;
    const e = dev ? d.interfaceEntries(dev.index).find((x) => x.id === (i as { id: string }).id) : undefined;
    if (!i || !e) return 'Select an interface first';
    return { path: e.path, loop: i.type === 'loopback' };
  }

  /** Why an interface helper of the palette can't run now ('' = it can). */
  interfaceHelperBlocked(kind: 'mac' | 'mtu'): string {
    const t = this.selectedInterfacePath();
    if (typeof t === 'string') return t;
    if (t.loop) return 'A loopback has no ' + (kind === 'mac' ? 'MAC address' : 'MTU') + ' here';
    const cur = (this.mdoc as ModelDoc).text(t.path.concat(kind));
    if (kind === 'mtu' && cur === '1500') return 'Its MTU is 1500 already';
    if (kind === 'mac' && cur) return 'It has a MAC address already (' + cur + ')';
    return '';
  }

  /** Generate a MAC address for the selected interface, or set its MTU to 1500 (one undo step each). */
  applyInterfaceHelper(kind: 'mac' | 'mtu'): void {
    if (this.interfaceHelperBlocked(kind)) return;
    const t = this.selectedInterfacePath() as { path: (string | number)[] };
    const d = this.mdoc as ModelDoc;
    const model = d.result.model;
    const cr = this.doc.defaultView ? this.doc.defaultView.crypto : undefined;
    if (kind === 'mtu') d.setInteger(t.path.concat('mtu'), '1500');
    else if (model && cr) d.setText(t.path.concat('mac'), generateMac(model, (n) => cr.getRandomValues(new Uint8Array(n))));
    this.afterEdit(kind === 'mtu' ? 'MTU set to 1500.' : 'A MAC address was generated.');
  }

  // ------------------------------------------------------------ simulation mode

  /**
   * Simulation mode: a hypothetical state on screen (Simulate → Protocol
   * simulation). While it is on the whole window says so (the banner, the
   * thin border round the diagram with its "Simulation running" label, the status-bar marker) and
   * the model is locked for editing; Exit simulation (or Esc) ends it. null:
   * off.
   */
  private simulation: SimulationMode | null = null;

  /** Another model (opened, new, closed): its simulation ends, and the tool window (it showed the old model) closes. */
  private endForNewModel(): void {
    const sim = this.simulation;
    this.simulation = null;
    if (this.mdoc) this.mdoc.lock = '';
    if (sim) sim.stop();
    if (this.tw) this.tw.close();
    this.resetModelResults();
  }

  /**
   * Another model replaces the one shown (or none is shown): what belonged
   * to the old one goes — its analysis results, snapshots and selections,
   * its pending work (cancelled; a callback that still comes does nothing),
   * its experiment runs — and the workspaces bind to the new one. An open
   * workspace stays open and shows the new model's (Design checks: its
   * saved expectations, not evaluated yet; nothing runs on its own). An edit
   * of the same model is not this: its results stay, marked outdated.
   */
  private resetModelResults(): void {
    // the duration controls' units and unwritten drafts were the old model's
    resetDurationDrafts();
    // the report's background work and its result
    const j = this.spofJob;
    if (j) {
      j.cancelled = true;
      j.running = false;
      if (j.timer !== null && this.doc.defaultView) this.doc.defaultView.clearTimeout(j.timer);
      j.timer = null;
    }
    this.spofJob = null;
    this.wiRun = null;
    this.wiForm = newWhatIfForm();
    this.domForm = null;
    // the evaluations and what was selected in them
    this.dcRun = null;
    this.dcOpen.clear();
    this.dcForm = null;
    this.addrRun = null;
    this.addrState.open.clear();
    // the trace's ends named the old model's objects (its options, as the VRF choice, are kept)
    this.traceForm = { ...this.traceForm, from: '', to: '', service: '' };
    this.anSel = '';
    this.anSelRefs = [];
    this.anFocus = false;
    // the experiments: a run in progress is the old model's (its slot is let go: nothing of it is kept)
    if (this.expRunner) {
      // its playback goes with it (the old model's simulation)
      this.expRunner.runner.cancel();
      this.endPlayback(this.expRunner);
    }
    this.expRunner = null;
    this.expRuns.clear();
    this.expCompare.clear();
    this.expSel = { exp: null, list: null, index: -1 };
    this.expFocusRefs.clear();
    this.expDraft.clear();
    this.expNote = '';
    this.modelGen++;
  }

  /** a new model's number: results computed for an earlier one are never shown for it */
  private modelGen = 0;

  /** The current model's generation (tests). */
  modelGeneration(): number {
    return this.modelGen;
  }

  /** the protocol simulation, while it runs */
  private simCtl: SimController | null = null;

  /** Is a model open? */
  hasModel(): boolean {
    return !!this.session && !!this.mdoc;
  }

  /** The protocol simulation's controller (tests and the self-test read it). */
  simController(): SimController | null {
    return this.simCtl;
  }

  /** The simulation-wide parameters remembered for this browser session (Start simulation…, the Simulation window). */
  storedSimParams(): { [key: string]: ParamValue } {
    try {
      const w = this.doc.defaultView;
      return readStoredParams(w ? w.sessionStorage.getItem(SIM_PARAMS_KEY) : null);
    } catch (e) {
      return {};
    }
  }

  /** The protocols switched off for this browser session (Start simulation…, the Simulation setup); every other one is shown. */
  /** The senders remembered for this browser session that this model has (null: none remembered, or none of them here). */
  storedSimSenders(): string[] | null {
    try {
      const w = this.doc.defaultView;
      const v = JSON.parse((w ? w.sessionStorage.getItem(SIM_SENDERS_KEY) : null) || 'null');
      if (!Array.isArray(v) || !this.session) return null;
      const ids = v.filter((x) => typeof x === 'string' && this.session!.model.index.devices.has(x));
      return ids.length ? ids : null;
    } catch (e) {
      return null;
    }
  }

  private storeSimSenders(s: Set<string> | null): void {
    try {
      const w = this.doc.defaultView;
      if (!w) return;
      const all = !s || (!!this.session && s.size === this.session.model.devices.length);
      if (all) w.sessionStorage.removeItem(SIM_SENDERS_KEY);
      else w.sessionStorage.setItem(SIM_SENDERS_KEY, JSON.stringify(Array.from(s as Set<string>).sort()));
    } catch (e) {
      /* storage unavailable: the choice lasts for this simulation only */
    }
  }

  /** The devices the diagram's selection stands for (a device; a cable's two ends; a group's devices …). */
  diagramDevices(): Set<string> {
    const s = this.session;
    if (!s || !s.state.selected) return new Set();
    return new Set(focusSeeds(s.model, s.state.selected));
  }

  /** The senders a start begins with: the diagram's selection, else those remembered for the session, else every device. */
  startSenders(): string[] {
    const s = this.session as Session;
    const sel = this.diagramDevices();
    if (sel.size) return s.model.devices.filter((d) => sel.has(d.id)).map((d) => d.id);
    return this.storedSimSenders() || s.model.devices.map((d) => d.id);
  }

  storedSimHidden(): Set<string> {
    try {
      const w = this.doc.defaultView;
      const v = JSON.parse((w ? w.sessionStorage.getItem(SIM_HIDDEN_KEY) : null) || '[]');
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    } catch (e) {
      return new Set();
    }
  }

  /** Remember the protocols shown: those of the model left out are the ones switched off (the others' choice is kept). */
  private storeSimShown(entries: Array<{ id: string }>, shown: Set<string>): void {
    try {
      const w = this.doc.defaultView;
      if (!w) return;
      const hidden = this.storedSimHidden();
      for (const e of entries) {
        if (shown.has(e.id)) hidden.delete(e.id);
        else hidden.add(e.id);
      }
      w.sessionStorage.setItem(SIM_HIDDEN_KEY, JSON.stringify(Array.from(hidden).sort()));
    } catch (e) {
      /* storage unavailable: the choice lasts for this simulation only */
    }
  }

  private storeSimParams(values: { [key: string]: ParamValue }): void {
    try {
      const w = this.doc.defaultView;
      if (w) w.sessionStorage.setItem(SIM_PARAMS_KEY, JSON.stringify(values));
    } catch (e) {
      /* storage unavailable: the values last for this simulation only */
    }
  }

  /**
   * Simulate → Start simulation…: the dialog that sets up the simulation
   * before it starts. At the top, always open, the protocols the model uses
   * (grouped, with their counts, Select all and Clear; the keyboard focus
   * starts on the first one); below, the Layer 1–4 parameters, one
   * collapsed section per layer that says how many of its values are
   * modified. Start (Enter) and Cancel (Esc). Both choices are remembered
   * for the next start in this browser session and carry over into the
   * Simulation setup panel. Resolves true when it started.
   */
  async openStartDialog(): Promise<boolean> {
    if (!this.session || this.simulation) return false;
    const model = this.session.model;
    const entries = protocolEntriesOf(model);
    const hidden = this.storedSimHidden();
    let startBtn: HTMLButtonElement | null = null;
    const editor = paramEditor(this.doc, {
      id: 'sim-pd',
      values: this.storedSimParams(),
      onValidity: (ok) => {
        if (startBtn) startBtn.disabled = !ok;
      },
    });
    const color = (p: string): string => lookupProtocol(model.protocols, p.indexOf('custom:') === 0 ? p.slice(7) : p).color;
    const picker = protocolPicker(this.doc, { id: 'sim-pd-protos', entries, shown: new Set(entries.filter((e) => !hidden.has(e.id)).map((e) => e.id)), color });
    const senders = sendersPicker(this.doc, { id: 'sim-pd-senders', model, selected: new Set(this.startSenders()), open: true, diagram: () => this.diagramDevices() });
    const scopes = this.scopeChoices();
    const scopeBox = scopeChooser(this.doc, scopes);
    const v = await this.dialog({
      title: 'Start simulation',
      className: 'sim-start-dialog',
      closeButton: true,
      body: [el(this.doc, 'p', { class: 'muted small sim-pd-intro' }, ['A freshly booted network: every table empty, every adjacency down. Every protocol runs; the ones checked are drawn and logged, for the senders chosen.']), scopeBox.el, picker.el, senders.el, editor.el],
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Start', value: 'start', kind: 'primary' },
      ],
      ready: (dlg) => {
        startBtn = dlg.querySelector('.modal-btns [data-value="start"]') as HTMLButtonElement;
        startBtn.disabled = !editor.valid();
        // Enter starts (from anywhere but a button, which Enter presses, or a list box): a field being typed in is taken first
        dlg.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          const t = ke.target as HTMLElement;
          if (ke.key !== 'Enter' || ke.isComposing || ke.shiftKey || ke.ctrlKey || ke.altKey || ke.metaKey || t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
          ke.preventDefault();
          if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') t.dispatchEvent(new Event('change', { bubbles: true }));
          if (startBtn && !startBtn.disabled) startBtn.click();
        });
      },
      focus: '#sim-pd-protos-list input[data-sim-proto]',
    });
    // the dialog is gone, whatever was chosen: its senders list lets go of the document
    senders.dispose();
    if (v !== 'start' || !editor.valid()) return false;
    const picked = picker.selected();
    const chosen = senders.selected();
    this.storeSimSenders(chosen);
    this.storeSimParams(editor.values());
    this.storeSimShown(entries, picked);
    return this.startProtocolSimulation({ protocols: entries.filter((e) => picked.has(e.id)).map((e) => e.id), params: editor.values(), senders: model.devices.filter((d) => chosen.has(d.id)).map((d) => d.id), scope: scopeBox.selected() });
  }

  /**
   * The execution scopes that apply now (analysis/exec-scope.ts): the
   * entire model; the communication of the Trace path on screen; the
   * dependencies of the selected device; the selected group; the VLAN of
   * the selected VLAN interface or access port; each failure domain. Only
   * what applies is offered.
   */
  scopeChoices(): ExecScope[] {
    const s = this.session;
    if (!s) return [];
    const m = s.model;
    const out: ExecScope[] = [entireScope(m)];
    const r = this.traceRun;
    if (r && !r.check.error && !this.traceOutdated()) out.push(communicationScope(m, r.check));
    const sel = s.state.selected;
    const [kind, id] = sel ? splitRef(sel) : ['', ''];
    if (kind === 'device' && id) out.push(dependencyScope(m, id));
    if (kind === 'group' && id) out.push(groupScope(m, id));
    if (kind === 'iface' && id) {
      const i = m.index.interfaces.get(id);
      const pl = i ? portL2(m, i.device, i.id) : undefined;
      const vlan = i && i.type === 'virtual' && i.vlan !== undefined ? i.vlan : pl && pl.kind === 'access' ? pl.untagged : undefined;
      if (vlan !== undefined) out.push(vlanScope(m, vlan));
    }
    for (const d of m.failureDomains) out.push(domainScope(m, d.id));
    return out;
  }

  /**
   * Start the protocol simulation at once (the dialog's Start; tests): a
   * freshly booted network (every table empty, every adjacency down, the
   * interfaces up at t = 0), in simulation mode, in the simulation layout
   * (Simulation setup on the left, Actions on the right, the simulation
   * panel under the diagram). Without parameters or protocols it uses
   * those remembered for this session.
   */
  startProtocolSimulation(opts: SimStartOptions | string[] = {}): boolean {
    if (!this.session || this.simulation) return false;
    const o: SimStartOptions = Array.isArray(opts) ? { protocols: opts } : opts;
    if (!o.params) o.params = this.storedSimParams();
    if (!o.senders) o.senders = this.startSenders();
    if (!o.protocols) {
      const hidden = this.storedSimHidden();
      if (hidden.size) o.protocols = protocolEntriesOf((this.session as Session).model).filter((e) => !hidden.has(e.id)).map((e) => e.id);
    }
    const self = this;
    const ctl = new SimController(
      {
        doc: this.doc,
        model: () => (self.session as Session).model,
        scene: () => self.viewport.querySelector('.scene'),
        view: () => (self.session ? self.session.state.view : 'physical'),
        reduce: () => self.reducedMotion(),
        changed: () => self.simChanged(),
        rectOf: (ref) => {
          const n = self.viewport.querySelector(`.node[data-ref="${ref.replace(/["\\]/g, '\\$&')}"]`);
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        },
        toast: (t) => self.toast(t),
        tick: () => self.simTick(),
        paramsChanged: (values) => self.storeSimParams(values),
        shownChanged: (shown) => self.storeSimShown(ctl.protocolEntries(), shown),
        sendersChanged: (s) => self.storeSimSenders(s),
        diagramDevices: () => self.diagramDevices(),
        panelChanged: () => {
          // now (measuring lays the change out), and once more after the frame it is drawn in
          self.applyDockHeight();
          const w = self.doc.defaultView;
          if (w) w.requestAnimationFrame(() => self.applyDockHeight());
        },
        selected: () => (self.session ? self.session.state.selected : null),
        select: (ref) => self.select(ref, !!ref),
        setupBox: () => self.doc.getElementById('sim-setup-body'),
        actionsBox: () => self.doc.getElementById('sim-actions-body'),
        dockBox: () => self.doc.getElementById('sim-dock-body'),
        simSection: (box) => self.editor.renderSimSection(box),
        exit: () => void self.exitSimulation(),
      },
      o,
    );
    const stop = ctl.stop.bind(ctl);
    ctl.stop = (): void => {
      stop();
      if (self.simCtl === ctl) self.simCtl = null;
      // the VMs back where the model has them
      if (self.session && self.session.setPlacement(null)) self.render();
      // its panels' content goes with it
      for (const id of ['sim-setup-body', 'sim-actions-body', 'sim-dock-body']) {
        const b = self.doc.getElementById(id) as HTMLElement;
        while (b.firstChild) b.removeChild(b.firstChild);
      }
      if (self.analyzeFrom === 'simulate') self.analyzeFrom = 'edit';
      if (self.ws === 'simulate') self.showWorkspace('edit');
      else self.doc.body.removeAttribute('data-sim');
    };
    this.simCtl = ctl;
    this.showWorkspace('simulate');
    ctl.mount();
    // now that the panel has its contents: its minimum and default are measured
    this.applyDockHeight();
    this.startSimulation(ctl);
    const first = this.doc.getElementById('sim-play') as HTMLElement | null;
    if (first) first.focus();
    return true;
  }

  /**
   * The narrow layout's tabs above the simulation panel: Setup or Actions
   * under the diagram; in a narrow and short window Diagram, Setup or
   * Actions above the panel (one at a time).
   */
  private simPanelTab(which: 'diagram' | 'setup' | 'actions', focus = true): void {
    const d = this.doc;
    d.body.setAttribute('data-panel-tab', which);
    for (const k of ['diagram', 'setup', 'actions']) {
      const b = d.getElementById('spt-' + k) as HTMLElement;
      b.setAttribute('aria-selected', k === which ? 'true' : 'false');
      b.tabIndex = k === which ? 0 : -1;
      if (focus && k === which) b.focus();
    }
    // the diagram coming back into view: its dots on it again
    if (which === 'diagram' && this.simCtl) this.simCtl.sceneChanged();
  }

  /** The tabs shown now (Diagram only in a narrow and short window). */
  private simTabs(): Array<'diagram' | 'setup' | 'actions'> {
    const dg = this.doc.getElementById('spt-diagram') as HTMLElement;
    return dg.getClientRects().length ? ['diagram', 'setup', 'actions'] : ['setup', 'actions'];
  }

  // ------------------------------------------------------------ the simulation panel's height

  /** the simulation panel's height (px), chosen with its splitter; null: the default */
  private dockH: number | null = null;

  /**
   * The default and the bounds of the simulation panel's height in the space
   * under the toolbar. The default is also the minimum: its header (the
   * clock, the tables' headings and filters, as they wrap) and exactly three
   * rows of the status and three of the log, each with its column headings,
   * all measured (theme, font and zoom change them). Only a window too
   * short for that gives the diagram more: the panel is never taller than
   * the diagram (and never lower than its toolbar).
   */
  dockBounds(): { dflt: number; min: number; max: number } {
    const main = this.doc.querySelector('main') as HTMLElement;
    const h = main.clientHeight || 600;
    // Experiments and Analyze: their results take a fair share (no simulation tables to measure)
    if (this.ws === 'experiments' || this.ws === 'analyze') {
      const min = Math.min(120, Math.round(h * 0.3));
      return { dflt: Math.max(min, Math.round(h * 0.38)), min, max: Math.max(min, Math.round(h * 0.65)) };
    }
    const head = this.doc.querySelector('#sim-dock .sd-head') as HTMLElement | null;
    const need = this.dockNeed();
    // (the room the diagram and the panel share: the diagram's area and the panel, as they are now)
    const dock = this.doc.getElementById('sim-dock') as HTMLElement;
    const wrap = this.doc.getElementById('canvas-wrap') as HTMLElement | null;
    const shared = !dock.hidden && wrap && wrap.getClientRects().length ? wrap.getBoundingClientRect().height + dock.getBoundingClientRect().height : h;
    const min = Math.round(Math.min(need, Math.max((head ? head.offsetHeight : 44) + 4, Math.floor((shared - DOCK_MARGIN) / 2))));
    const max = Math.max(min, Math.round(h * 0.65));
    return { dflt: min, min, max };
  }

  /** What the panel needs for three rows of each table (px): measured, or an estimate while it is hidden. */
  private dockNeed(): number {
    const dock = this.doc.getElementById('sim-dock') as HTMLElement;
    const rowH = this.dockRowHeight();
    if (dock.hidden || dock.getBoundingClientRect().height <= 0) return 44 + 2 * (rowH + 30) + 2 * DOCK_ROWS * rowH;
    const body = this.doc.querySelector('#sim-dock .sd-body') as HTMLElement | null;
    const panes = ['sd-status', 'sd-log'].map((id) => this.doc.getElementById(id) as HTMLElement | null).filter((e): e is HTMLElement => !!e);
    if (!body || !panes.length) return Math.round(dock.getBoundingClientRect().height);
    const shown = panes.find((p) => p.getClientRects().length > 0);
    const width = shown ? shown.getBoundingClientRect().width : body.getBoundingClientRect().width;
    // each pane's own part (its heading, filters and note, as they wrap): the pane less its table's area; a pane behind its
    // tab (a narrow panel) is laid out unseen at the same width to measure it, so that either tab shows the three rows
    let chrome = 0;
    let theadH = rowH;
    for (const p of panes) {
      const area = p.querySelector('.sim-scroll') as HTMLElement | null;
      if (!area) continue;
      if (p.getClientRects().length) {
        chrome = Math.max(chrome, p.getBoundingClientRect().height - area.clientHeight);
        const th = area.querySelector('thead') as HTMLElement | null;
        if (th) theadH = th.getBoundingClientRect().height;
        continue;
      }
      const was = [p.style.cssText, area.style.cssText];
      p.style.cssText = `display: flex; position: absolute; visibility: hidden; left: 0; top: 0; width: ${width}px; height: auto`;
      area.style.cssText = 'flex: none; height: 0';
      chrome = Math.max(chrome, p.getBoundingClientRect().height);
      p.style.cssText = was[0];
      area.style.cssText = was[1];
    }
    // the rest of the panel (its toolbar, a note, the tabs) and three rows under the column headings
    const outside = dock.getBoundingClientRect().height - body.getBoundingClientRect().height;
    return Math.ceil(outside + chrome + theadH + DOCK_ROWS * rowH + 1);
  }

  /** The height of a row of the panel's tables (px), measured: the tallest of the rows shown (a log row with a message button), or a header row's. */
  dockRowHeight(): number {
    let hgt = 0;
    for (const id of ['sim-status-table', 'sim-log-table']) {
      const box = this.doc.getElementById(id);
      if (!box || !box.getClientRects().length) continue;
      const rows = Array.from(box.querySelectorAll('tbody tr')).slice(0, 40) as HTMLElement[];
      for (const r of rows) hgt = Math.max(hgt, r.getBoundingClientRect().height);
      if (!hgt) {
        const th = box.querySelector('thead tr') as HTMLElement | null;
        if (th) hgt = th.getBoundingClientRect().height;
      }
    }
    return hgt || 21;
  }

  /** Set (or reset, null) the simulation panel's height; kept in local storage. */
  setDockHeight(px: number | null): void {
    this.dockH = px === null ? null : Math.round(px);
    try {
      const w = this.doc.defaultView;
      if (w) {
        if (px === null) w.localStorage.removeItem(DOCK_KEY);
        else w.localStorage.setItem(DOCK_KEY, String(this.dockH));
      }
    } catch (e) {
      /* storage unavailable: the height lasts for this page */
    }
    this.applyDockHeight();
  }

  private applyDockHeight(): void {
    const main = this.doc.querySelector('main') as HTMLElement;
    const b = this.dockBounds();
    const h = Math.max(b.min, Math.min(b.max, this.dockH === null ? b.dflt : this.dockH));
    main.style.setProperty('--dock-h', h + 'px');
    const sp = this.doc.getElementById('dock-splitter') as HTMLElement;
    sp.setAttribute('aria-valuemin', String(b.min));
    sp.setAttribute('aria-valuemax', String(b.max));
    sp.setAttribute('aria-valuenow', String(h));
    sp.setAttribute('aria-valuetext', `${h} pixels high`);
  }

  private wireDock(): void {
    const sp = this.doc.getElementById('dock-splitter') as HTMLElement;
    try {
      const w = this.doc.defaultView;
      const v = w ? Number(w.localStorage.getItem(DOCK_KEY)) : NaN;
      if (v > 0 && isFinite(v)) this.dockH = v;
    } catch (e) {
      /* no stored height */
    }
    const now = (): number => (this.doc.getElementById('sim-dock') as HTMLElement).getBoundingClientRect().height;
    sp.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 80 : 20;
      if (e.key === 'ArrowUp') this.setDockHeight(now() + step);
      else if (e.key === 'ArrowDown') this.setDockHeight(now() - step);
      else if (e.key === 'Home') this.setDockHeight(this.dockBounds().max);
      else if (e.key === 'End') this.setDockHeight(this.dockBounds().min);
      else if (e.key === 'Enter') this.setDockHeight(null);
      else return;
      // (the arrow keys would pan the diagram too)
      e.preventDefault();
      e.stopPropagation();
    });
    sp.addEventListener('dblclick', () => this.setDockHeight(null));
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = now();
      sp.classList.add('dragging');
      const mv = (ev: PointerEvent): void => this.setDockHeight(h0 + (y0 - ev.clientY));
      const up = (): void => {
        sp.classList.remove('dragging');
        this.doc.removeEventListener('pointermove', mv);
        this.doc.removeEventListener('pointerup', up);
      };
      this.doc.addEventListener('pointermove', mv);
      this.doc.addEventListener('pointerup', up);
    });
    const w = this.doc.defaultView;
    if (w) w.addEventListener('resize', () => this.applyDockHeight());
    const tabs = this.doc.getElementById('sim-paneltabs') as HTMLElement;
    tabs.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('[role="tab"]');
      if (b) this.simPanelTab(b.id.slice(4) as 'diagram' | 'setup' | 'actions');
    });
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      e.stopPropagation();
      const all = this.simTabs();
      const cur = Math.max(0, all.indexOf(this.doc.body.getAttribute('data-panel-tab') as 'setup'));
      const i = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (cur + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length;
      this.simPanelTab(all[i]);
    });
  }

  // ------------------------------------------------------------ moving the focus between the regions (F6)

  /** the element last focused in each region, so that F6 returns there */
  private regionFocus = new Map<string, HTMLElement>();

  /** The regions F6 moves between, in order: the left panel, the diagram, the right panel, the simulation panel, a tool window. */
  private regions(): HTMLElement[] {
    const d = this.doc;
    const out: HTMLElement[] = [];
    const vis = (e: HTMLElement | null): e is HTMLElement => !!e && !e.hidden && e.getClientRects().length > 0;
    for (const id of ['outline', 'canvas-wrap', 'side', 'sim-paneltabs', 'sim-dock', 'toolwin']) {
      const e = d.getElementById(id) as HTMLElement | null;
      // (the narrow simulation layout shows some of them, as its tabs say: the others are not there)
      if (vis(e) && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden') out.push(e);
    }
    return out;
  }

  /** F6 / Shift+F6: the keyboard focus to the next (previous) region, where it last was in it. */
  focusRegion(dir: 1 | -1 = 1): boolean {
    const rs = this.regions();
    if (!rs.length) return false;
    const a = this.doc.activeElement as HTMLElement | null;
    let i = rs.findIndex((r) => !!a && r.contains(a));
    if (i < 0) i = rs.findIndex((r) => r.id === 'canvas-wrap');
    const next = rs[(i + dir + rs.length) % rs.length];
    if (next.id === 'toolwin') return this.toggleWindowFocus();
    const last = this.regionFocus.get(next.id);
    if (last && next.contains(last) && last.getClientRects().length && !(last as HTMLButtonElement).disabled) last.focus();
    else if (next.id === 'canvas-wrap') (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    else {
      // (its first control: not a splitter on its edge)
      const f = Array.from(next.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')).find((e) => !e.matches('.splitter, .dock-splitter') && e.getClientRects().length > 0) as HTMLElement | undefined;
      if (f) f.focus();
      else {
        next.tabIndex = -1;
        next.focus();
      }
    }
    return true;
  }

  private wireRegions(): void {
    this.doc.addEventListener('focusin', (e) => {
      const t = e.target as HTMLElement;
      for (const id of ['outline', 'side', 'sim-paneltabs', 'sim-dock', 'canvas-wrap']) {
        const r = this.doc.getElementById(id);
        if (r && r.contains(t)) this.regionFocus.set(id, t);
      }
    });
  }

  /** The simulated time moved on: the banner's and the status bar's texts (nothing else is drawn again). */
  private simTick(): void {
    const v = this.simulation;
    if (!v) return;
    const text = this.doc.getElementById('sim-text');
    if (text) text.textContent = `${this.simNote()}. The model is unchanged; editing is paused.`;
    const short = this.doc.getElementById('sim-short');
    if (short) short.textContent = `Simulation running · ${v.marker()}`;
    const m = this.doc.querySelector('#status .sim-marker-text');
    if (m) m.textContent = v.marker();
  }


  /** prefers-reduced-motion */
  reducedMotion(): boolean {
    const win = this.doc.defaultView;
    return !!win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Is simulation mode on? */
  simulationOn(): boolean {
    return !!this.simulation;
  }

  /** Start simulation mode with a simulation (it replaces one that is on). */
  startSimulation(sim: SimulationMode): void {
    if (this.simulation) this.exitSimulation();
    this.simulation = sim;
    this.simChanged();
  }

  /** The simulation's state changed (a failure, the time): the marks, the banner, the lock, the open window. */
  simChanged(): void {
    // a VM the simulation restarted on another host is drawn there
    if (this.session && this.session.setPlacement(this.simCtl ? this.simCtl.placement() : null)) this.render();
    this.syncLock();
    this.applyHighlight();
    this.updateChrome();
    this.refreshWindow();
  }

  /** What is failed in the simulated state (null: no simulation, or nothing failed). */
  private simFailure(): FailureResult | null {
    return this.simulation ? this.simulation.failure() : null;
  }

  /** Why the model can't be edited now ('' = it can). */
  editLock(): string {
    return this.mdoc ? this.mdoc.lock : '';
  }

  /** The editing core is locked while a simulation is on. */
  private syncLock(): void {
    const d = this.mdoc;
    if (d) d.lock = this.simulation && this.session ? SIM_LOCK : '';
    if (this.session) this.session.setSimulated(this.simFailure());
  }

  /** End simulation mode: the model's own state, and editing again. */
  exitSimulation(): boolean {
    const sim = this.simulation;
    if (!sim) return false;
    this.simulation = null;
    // editing again first: stopping brings the Objects list and the Inspector back, drawn as they are now
    // (with the lock still set they came back read-only, with the notice and a disabled Exit simulation)
    this.syncLock();
    sim.stop();
    this.simChanged();
    const back = this.doc.activeElement;
    if (!back || back === this.doc.body) (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    return true;
  }

  // ------------------------------------------------------------ tool windows

  /** the non-modal windows of Analyze and Simulate (one open at a time) */
  private tw: ToolWindows | null = null;

  /** Is a tool window open? */
  toolWindowOpen(): boolean {
    return !!this.tw && !!this.tw.current();
  }

  /** The open tool window's id ('' = none). */
  toolWindow(): string {
    return this.tw ? this.tw.current() : '';
  }

  /** The window manager (tests read its geometry). */
  windows(): ToolWindows | null {
    return this.tw;
  }

  /** Close the open tool window; with none open and Analyze in front: leave Analyze (its tool's UI is the workspace). */
  closeToolWindow(): boolean {
    if (!this.tw || !this.tw.current()) {
      if (this.ws !== 'analyze') return false;
      void this.exitAnalyze();
      return true;
    }
    this.tw.close();
    return true;
  }

  /** F6: the keyboard focus to the tool window, or back to the main window. */
  toggleWindowFocus(): boolean {
    return !!this.tw && this.tw.toggleFocus();
  }

  private openWindow(o: ToolWindowOpts): void {
    this.openMenu(null);
    (this.tw as ToolWindows).open(o);
  }

  /** After an edit, a new selection or a mode change: the open window shows the model as it is now. */
  private refreshWindow(): void {
    this.renderWorkspace();
    switch (this.toolWindow()) {
      case 'trace':
        this.renderTraceWindow();
        break;
      case 'spof':
        this.renderSpofWindow();
        break;
      case 'focus':
        this.renderFocusWindow();
        break;
      case 'addressing':
        this.renderAddressingWindow();
        break;
      case 'checks':
        this.renderDesignChecks();
        break;
      case 'views':
        this.renderViews();
        break;

    }
  }

  /** Replace the open window's body, keeping the keyboard focus on the same control (by id or data attribute) and the scroll. */
  private replaceWindowBody(body: HTMLElement): void {
    const tw = this.tw as ToolWindows;
    const cur = tw.body();
    if (!cur) return;
    const a = this.doc.activeElement as HTMLElement | null;
    const key = a && cur.contains(a) ? focusKey(a) : null;
    const scroll = cur.scrollTop;
    tw.setBody(body);
    cur.scrollTop = scroll;
    if (key) {
      const t = findFocusKey(cur, key);
      if (t) t.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------ single points of failure

  /** the Single points of failure table's sort and filter (kept while the page is open; never saved) */
  private spofState = newSpofViewState();
  /**
   * the report for one model: the structural single points at once, then the
   * service impact of every candidate, checked in steps (time-sliced, never
   * blocking the page; Stop ends it, the coverage says how far it got)
   */
  private spofJob: {
    model: Model;
    spofs: Spof[];
    cands: SpofCandidate[];
    deps: ServiceDependency[];
    baseline: Map<string, DepState> | null;
    service: Map<string, DepChange[]>;
    next: number;
    running: boolean;
    cancelled: boolean;
    timer: number | null;
    rows: SpofRow[] | null;
  } | null = null;
  private wiForm: WhatIfForm = newWhatIfForm();
  private wiRun: { model: Model; result: WhatIf } | null = null;
  private domForm: DomainForm | null = null;

  /** The job for the model on screen (a new one when the model changed). */
  private spofJobNow(): NonNullable<App['spofJob']> {
    const s = this.session as Session;
    const j = this.spofJob;
    // (an edit leaves the report as computed, marked outdated: Refresh, or another model, starts a new one)
    if (j && (j.model === s.model || !this.outdatedSince(j.model) || this.analyzeTool() === 'spof')) return j;
    if (j && j.timer !== null && this.doc.defaultView) this.doc.defaultView.clearTimeout(j.timer);
    const cands = spofCandidates(s.model);
    const spofs = singlePointsOfFailure(s.model);
    this.spofJob = { model: s.model, spofs, cands, deps: serviceDependencies(s.model), baseline: null, service: new Map(), next: 0, running: false, cancelled: false, timer: null, rows: null };
    return this.spofJob;
  }

  private spofRowsNow(): SpofRow[] {
    const j = this.spofJobNow();
    if (!j.rows) j.rows = spofRows(j.model, j.spofs, j.next > 0 ? j.service : null, j.cands);
    return j.rows;
  }

  /** Check the service impact of the candidates, a slice at a time (about 40 ms each), until done or stopped. */
  private stepSpofJob(): void {
    const j = this.spofJob;
    const win = this.doc.defaultView;
    if (!j || !this.session || j.cancelled) return;
    if (j.model !== this.session.model) {
      // the model changed: the report stays as far as it got, outdated
      j.running = false;
      j.cancelled = true;
      j.timer = null;
      j.rows = null;
      this.renderSpofTable();
      return;
    }
    j.running = true;
    if (!j.baseline) j.baseline = dependencyBaseline(j.model, j.deps);
    const t0 = Date.now();
    while (j.next < j.cands.length && Date.now() - t0 < 40) {
      const c = j.cands[j.next++];
      // (no configured dependency: nothing becomes unavailable, checked)
      if (!j.deps.length) {
        j.service.set(c.ref, []);
        continue;
      }
      const res = simulate(j.model, c.fail);
      const hit = new Set(Array.from(failureRefs(res).keys()));
      j.service.set(c.ref, compareDependencies(j.model, j.deps, j.baseline, res.ctx, hit, (d) => res.devices.get(d) === 'down'));
    }
    j.rows = null;
    if (j.next >= j.cands.length) {
      j.running = false;
      j.timer = null;
    } else if (win)
      j.timer = win.setTimeout(() => {
        // (a callback of a job that was replaced — another model, Refresh — does nothing: no stale or duplicate work)
        if (this.spofJob === j) this.stepSpofJob();
      }, 0);
    else {
      // (no window: finish at once)
      this.stepSpofJob();
      return;
    }
    this.renderSpofTable();
  }

  /** Stop the service check where it is (the coverage says how far it got). */
  stopSpofJob(): boolean {
    const j = this.spofJob;
    if (!j || !j.running) return false;
    j.cancelled = true;
    j.running = false;
    if (j.timer !== null && this.doc.defaultView) this.doc.defaultView.clearTimeout(j.timer);
    j.timer = null;
    j.rows = null;
    this.renderSpofTable();
    const f = this.doc.getElementById('spof-filter');
    if (f) f.focus();
    return true;
  }

  /** Is the service check done (for tests)? */
  spofServiceDone(): boolean {
    const j = this.spofJob;
    return !!j && !j.running && j.next >= j.cands.length;
  }

  /**
   * Analyze → Single points of failure…: a window with the table of the
   * model as written (sort, filter, Show in diagram, What if, CSV and text),
   * the service impact checked progressively, the what-if check and the
   * failure domains. Nothing changes mode.
   */
  openSpof(): void {
    if (!this.session) return;
    const j = this.spofJobNow();
    this.showAnalyze('spof');
    if (!j.running && j.next < j.cands.length && !j.cancelled) this.stepSpofJob();
    const f = this.doc.getElementById('spof-filter');
    if (f) f.focus();
  }

  private renderSpofWindow(): void {
    if (this.analyzeTool() !== 'spof' || !this.session) return;
    const j = this.spofJobNow();
    this.renderAnalyzeWs();
    if (!j.running && j.next < j.cands.length && !j.cancelled) this.stepSpofJob();
  }

  /** Only the progress line and the table again (the service check's steps): the form and the focus stay. */
  private renderSpofTable(): void {
    if (this.analyzeTool() !== 'spof' || !this.session) return;
    const body = this.doc.getElementById('ws-an-dock');
    const old = body ? (body.querySelector('.spof-tables') as HTMLElement | null) : null;
    const prog = body ? (body.querySelector('#spof-progress') as HTMLElement | null) : null;
    if (!old || !prog) return;
    const a = this.doc.activeElement as HTMLElement | null;
    const key = a && old.contains(a) ? focusKey(a) : null;
    const view = this.spofView();
    old.replaceWith(spofTable(this.doc, this.spofRowsNow(), this.spofState, view));
    prog.replaceWith(progressLine(this.doc, view.progress, { stop: () => void this.stopSpofJob() }));
    if (key && body) {
      const t = findFocusKey(body, key);
      if (t) t.focus({ preventScroll: true });
    }
  }

  private spofView(): SpofView {
    const j = this.spofJobNow();
    const indet = j.baseline ? Array.from(j.baseline.values()).filter((x) => x.verdict !== 'satisfied' && x.verdict !== 'violated').length : 0;
    const progress = j.next > 0 || j.running ? { checked: j.next, total: j.cands.length, running: j.running, cancelled: j.cancelled, deps: j.deps.length, indeterminate: indet } : null;
    const wi = this.wiRun;
    return {
      bar: this.barState('spof', { kind: 'model', scope: 'Every cable, device and LAG, each failing alone' }, j.model, 'Failure analysis evaluates the configured model: applied to a simulation snapshot it would blend the simulation’s state with a what-if.'),
      progress,
      cands: j.cands,
      // (the what-if and the failure domains are of the model as it is now; the table may be outdated)
      whatif: { model: (this.session as Session).model, form: this.wiForm, result: wi ? wi.result : null, outdated: !!wi && this.outdatedSince(wi.model), domain: this.domForm, locked: this.editLock() },
      info: resultInfo(
        { kind: 'model', scope: 'Every cable, device and LAG, each failing alone' },
        ['A failure propagates as the failure analysis models it (interfaces, aggregates, redundancy groups, relations over their underlay, static routes).', 'Service impact: the configured dependencies (application peers, MQTT brokers, DNS, DHCP, timing sources, syslog, AAA), each checked as the communication check does.'],
        ['Combinations of failures (What if).', 'Dependencies the model does not configure; business importance.', 'Convergence and recovery times; probabilities.'],
        progress ? { checked: progress.checked, eligible: progress.total, unit: 'candidates', cancelled: progress.cancelled } : undefined,
      ),
    };
  }

  private spofWindowBody(): HTMLElement {
    const s = this.session as Session;
    const rows = this.spofRowsNow();
    const st = this.spofState;
    const view = this.spofView();
    const body = spofBody(this.doc, rows, st, view, {
      refresh: () => {
        this.spofJob = null;
        this.renderSpofWindow();
      },
      source: (src) => this.setAnalysisSource(src),
      stop: () => void this.stopSpofJob(),
      whatIf: (entries) => this.runWhatIf(entries),
      wiInput: (k, v) => {
        (this.wiForm as unknown as { [key: string]: string })[k] = v;
        if (k === 'mode') {
          this.renderSpofWindow();
          const b = this.doc.querySelector(`[data-wi-mode="${v}"]`) as HTMLElement | null;
          if (b) b.focus();
        }
      },
      wiRun: () => {
        const f = this.wiForm;
        const entries = f.mode === 'domain' ? (f.domain ? [f.domain] : []) : f.components.split(/[\s,]+/).filter((x) => x);
        if (!entries.length) {
          this.toast(f.mode === 'domain' ? 'Choose a failure domain first.' : 'Name the components that fail.');
          return;
        }
        this.runWhatIf(entries);
      },
      wiOut: (kind) => {
        const w = this.wiRun;
        if (!w || !this.mdoc) return;
        const text = whatIfText({ title: s.model.title, version: this.appVersion(), outdated: this.outdatedSince(w.model) }, w.result);
        if (kind === 'copy') void this.copyText(text, 'The what-if result was copied as text.');
        else {
          const name = pictureBaseName(this.mdoc.fileName) + '-what-if.txt';
          downloadText(this.doc, text, name, 'text/plain');
          this.toast(`Exported “${name}”.`);
        }
      },
      domAdd: () => {
        this.domForm = { index: -1, label: '', kind: 'rack', members: '', error: '' };
        this.renderSpofWindow();
        const f = this.doc.getElementById('dom-f-label');
        if (f) f.focus();
      },
      domEdit: (id) => {
        const d = s.model.failureDomains.find((x) => x.id === id);
        const entry = (this.mdoc as ModelDoc).analysisEntries('failure_domains').find((x) => x.id === id);
        if (!d || !entry) return;
        this.domForm = { index: entry.index, label: d.label, kind: d.kind, members: d.members.join(', '), error: '' };
        this.renderSpofWindow();
        const f = this.doc.getElementById('dom-f-label');
        if (f) f.focus();
      },
      domRemove: (id) => void this.removeFailureDomain(id),
      domInput: (k, v) => {
        if (this.domForm) (this.domForm as unknown as { [key: string]: string | number })[k] = v;
      },
      domSave: () => this.saveDomainForm(),
      domCancel: () => {
        this.domForm = null;
        this.renderSpofWindow();
        const b = this.doc.getElementById('dom-add');
        if (b) b.focus();
      },
      goto: (ref) => this.select(ref, true),
    });
    // (laid out in the Analyze panels: the results drawn again there, the request's controls kept)
    const redraw = (): void => this.renderAnalyzeWs('results');
    this.onRoot(body, 'input', (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.hasAttribute('data-spof-filter')) return;
      st.filter = t.value;
      redraw();
    });
    this.onRoot(body, 'click', (e) => {
      const t = e.target as Element;
      const sort = t.closest('[data-spof-sort]');
      if (sort) {
        const k = sort.getAttribute('data-spof-sort') as SpofSort;
        st.desc = st.sort === k ? !st.desc : k === 'impact' || k === 'cuts' || k === 'relations' || k === 'service';
        st.sort = k;
        redraw();
        const again = this.doc.querySelector(`[data-spof-sort="${k}"]`) as HTMLElement | null;
        if (again) again.focus();
        return;
      }
      const show = t.closest('[data-spof-show]');
      if (show) {
        this.select(show.getAttribute('data-spof-show'), true);
        return;
      }
      const wi = t.closest('[data-spof-whatif]');
      if (wi) {
        const refs = (wi.getAttribute('data-spof-whatif') || '').split(' ').filter((x) => x);
        this.wiForm = { ...this.wiForm, mode: 'components', components: refs.map((r) => r.replace(/^(device|link|relation|iface):/, '')).join(', ') };
        this.runWhatIf(refs);
        return;
      }
      const out = t.closest('[data-spof-out]');
      if (!out || !this.mdoc) return;
      // what the table shows: filtered and sorted as on screen
      const shown = shownSpofRows(this.spofRowsNow(), st);
      const kind = out.getAttribute('data-spof-out') as string;
      const base = pictureBaseName(this.mdoc.fileName) + '-single-points-of-failure';
      const info = this.spofView().info;
      const ctx = contextText(info.context) + (info.coverage ? ' · ' + coverageText(info.coverage) : '');
      const text = (): string => spofText(s.model, shown, { info, version: this.appVersion(), outdated: false });
      if (kind === 'csv-copy') void this.copyText(spofCsv(shown, ctx), 'The single points of failure were copied as CSV.');
      else if (kind === 'text-copy') void this.copyText(text(), 'The single points of failure were copied as text.');
      else {
        const csv = kind === 'csv-save';
        downloadText(this.doc, csv ? spofCsv(shown, ctx) : text(), base + (csv ? '.csv' : '.txt'), csv ? 'text/csv' : 'text/plain');
        this.toast(`Exported “${base}${csv ? '.csv' : '.txt'}”.`);
      }
    });
    return body;
  }

  /** What if these fail (failure domains, devices, cables, relations, interfaces, or refs): the result in the window. */
  runWhatIf(entries: string[]): WhatIf | null {
    const s = this.session;
    if (!s) return null;
    // (the what-if is computed on the model as it is now; the report's baseline only when the report is of this model)
    const j0 = this.spofJobNow();
    const j = j0.model === s.model ? j0 : { deps: serviceDependencies(s.model), baseline: null as Map<string, DepState> | null, model: s.model };
    if (!j.baseline) j.baseline = dependencyBaseline(j.model, j.deps);
    const reach = this.wiForm.reach === 'entire' ? ({ kind: 'entire' } as ReachScope) : this.wiForm.reach.indexOf('group:') === 0 ? ({ kind: 'group', group: this.wiForm.reach.slice(6) } as ReachScope) : undefined;
    const result = whatIf(s.model, entries.map((e) => e.replace(/^(device|link|relation):/, '')), { deps: j.deps, baseline: j.baseline, reach });
    this.wiRun = { model: s.model, result };
    if (this.analyzeTool() !== 'spof') this.openSpof();
    else this.renderSpofWindow();
    const r = this.doc.getElementById('wi-summary') || this.doc.getElementById('wi-result');
    if (r) {
      r.setAttribute('tabindex', '-1');
      r.focus();
      if (typeof r.scrollIntoView === 'function') r.scrollIntoView({ block: 'nearest' });
    }
    return result;
  }

  /** Save the failure domain form (one undo step); the form says what is missing. */
  private saveDomainForm(): boolean {
    const f = this.domForm;
    const d = this.mdoc;
    if (!f || !d) return false;
    const members = f.members.split(/[\s,]+/).filter((x) => x);
    if (!f.label.trim() || !members.length) {
      f.error = !f.label.trim() ? 'Give the failure domain a name.' : 'Name its members: devices, cables, relations or groups.';
      this.renderSpofWindow();
      const bad = this.doc.getElementById(!f.label.trim() ? 'dom-f-label' : 'dom-f-members');
      if (bad) bad.focus();
      return false;
    }
    try {
      if (f.index < 0) d.addFailureDomain({ label: f.label.trim(), kind: f.kind, members });
      else d.updateFailureDomain(f.index, { label: f.label.trim(), kind: f.kind, members });
    } catch (e) {
      this.refusedEdit(e);
      return false;
    }
    this.domForm = null;
    this.afterEdit(f.index < 0 ? 'The failure domain was added.' : 'The failure domain was changed.');
    this.renderSpofWindow();
    const b = this.doc.getElementById('dom-add');
    if (b) b.focus();
    return true;
  }

  /** Delete a failure domain after a confirmation that names the expectations that use it. */
  private async removeFailureDomain(id: string): Promise<void> {
    const d = this.mdoc;
    if (!d) return;
    const entry = d.analysisEntries('failure_domains').find((x) => x.id === id);
    if (!entry) return;
    const users = d.failureDomainUsers(id);
    const a = await this.dialog({
      title: `Delete the failure domain “${id}”?`,
      body: users.length ? [`${users.length === 1 ? 'This expectation names it in its' : `These ${users.length} expectations name it in their`} failure condition; ${users.length === 1 ? 'it keeps' : 'they keep'} the name and can’t be evaluated until you change ${users.length === 1 ? 'it' : 'them'}:`, el(this.doc, 'ul', { class: 'removal-list' }, users.map((u) => el(this.doc, 'li', {}, [u]))) as unknown as string, 'You can undo this with Ctrl+Z.'] : ['Nothing names it. You can undo this with Ctrl+Z.'],
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'go', kind: 'danger' }],
    });
    if (a !== 'go') return;
    try {
      d.removeFailureDomain(entry.index);
    } catch (e) {
      this.refusedEdit(e);
      return;
    }
    this.afterEdit('The failure domain was deleted.');
    this.renderSpofWindow();
    const b = this.doc.getElementById('dom-add');
    if (b) b.focus();
  }

  /** An edit that the lock refused (a safety net: the controls that edit are disabled during a simulation). */
  private refusedEdit(e: unknown): void {
    if (!(e instanceof EditLocked)) throw e;
    this.toast(e.message);
    this.renderSide();
    this.renderOutline();
  }

  /** Run an editor action; an edit refused by the lock only says why. */
  private guarded(run: () => unknown): void {
    try {
      const r = run();
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((e) => this.refusedEdit(e));
    } catch (e) {
      this.refusedEdit(e);
    }
  }

  // ------------------------------------------------------------ analysis context and freshness

  /** What an analysis is computed on while a simulation runs: a snapshot of it (the default), or the configured model. */
  private anSource: 'model' | 'snapshot' = 'snapshot';

  /** The snapshot a new analysis uses (null: the configured model, when no simulation runs or the model is chosen). */
  private analysisSnapshot(): AnalysisSnapshot | null {
    const s = this.simulation;
    return s && s.snapshot && this.anSource === 'snapshot' ? s.snapshot() : null;
  }

  /** Has the model changed (anything an analysis reads) since a result was computed on `model`? */
  private outdatedSince(model: Model): boolean {
    return !!this.session && this.session.model !== model && modelFingerprint(this.session.model) !== modelFingerprint(model);
  }

  /** The context line's state of a window. */
  private barState(id: string, context: AnalysisContext | null, model: Model | null, noSnapshot = ''): ContextBarState {
    const s = this.session;
    const canSnap = !!this.simulation && !!this.simulation.snapshot && !noSnapshot;
    return {
      id,
      context,
      outdated: !!model && this.outdatedSince(model),
      simulation: !!this.simulation,
      source: canSnap && this.anSource === 'snapshot' ? 'snapshot' : 'model',
      noSnapshot: this.simulation && noSnapshot ? noSnapshot : '',
      filtered: !!s && s.isFiltered(),
    };
  }

  /** Choose what the next analysis is computed on (while a simulation runs), and compute the open window's result again on it. */
  setAnalysisSource(src: 'model' | 'snapshot'): void {
    this.anSource = src;
    const w = this.toolWindow();
    if (w === 'trace' && this.traceRun) this.runTrace();
    else if (w === 'addressing') this.refreshAddressing();
    else if (w === 'checks') this.refreshDesignChecks();
    else this.refreshWindow();
  }

  /** The application's version, as the page says it ("0.1.3"). */
  appVersion(): string {
    const m = this.doc.querySelector('meta[name="generator"]');
    const v = m ? (m.getAttribute('content') || '').replace(/^netatlas\s*/, '') : '';
    return /__VERSION__/.test(v) ? '' : v;
  }

  // ------------------------------------------------------------ path trace

  /** the Trace path form (kept while the page is open; never saved) */
  private traceForm: TraceForm = newTraceForm();
  /** why the form could not be traced ('' = it could) */
  private traceError = '';
  /** the check on screen, the model and snapshot it was computed on (computed again only by Trace or Refresh) */
  private traceRun: (TraceRun & { model: Model; snap: AnalysisSnapshot | null; request: CommRequest }) | null = null;

  /** The check on screen (it stays as computed: an edit marks it outdated, it is not computed again behind the user's back), or null. */
  currentTrace(): TraceRun | null {
    return this.session ? this.traceRun : null;
  }

  /** Is the check on screen outdated (the model changed since)? */
  traceOutdated(): boolean {
    return !!this.traceRun && this.outdatedSince(this.traceRun.model);
  }

  /** A check of the model, on a snapshot of the simulation when one is chosen. */
  private computeTrace(req: CommRequest, snap: AnalysisSnapshot | null): TraceRun {
    const model = (this.session as Session).model;
    const check = checkCommunication(model, req, snap);
    const treq: TraceRequest = { from: req.from, to: req.to || '' };
    if (req.vrf !== undefined) treq.vrf = req.vrf;
    if (req.service !== undefined) treq.service = req.service;
    const trace: Trace = check.trace || { request: treq, paths: [], truncated: false, error: check.error || check.headline };
    let back: Trace | null = null;
    if (req.back) back = check.reverse ? check.reverse.trace : { request: { from: treq.to, to: treq.from }, paths: [], truncated: false, error: check.error ? 'Not traced' : 'The destination is not a device of the model: there is no way back to trace' };
    // the communication's identity: the handoff, the comparison and a saved expectation carry it on (nothing chosen again)
    const identity = commIdentity(model, check);
    return { req: trace.request, check, trace, back, identity, handoff: identity ? handoffOf(model, identity) : null, compare: null, mtu: pathMtu(model, check) };
  }

  /** The text a reference gives in the Trace form: a device or an interface; other objects give nothing. */
  private traceEndOf(ref: string): string | null {
    const [kind, id] = splitRef(ref);
    return kind === 'device' || kind === 'iface' ? id : null;
  }

  /**
   * Analyze → Trace path… (T): the Trace path window with its form; a
   * selected device or interface fills an empty From (else an empty To), and
   * the keyboard goes to the first empty field. The path stays marked in the
   * diagram while the window is open; closing it removes the path.
   */
  openTrace(): void {
    if (!this.session) return;
    const sel = this.session.state.selected;
    const end = sel ? this.traceEndOf(sel) : null;
    if (end && !this.traceForm.from) this.traceForm.from = end;
    else if (end && !this.traceForm.to && this.traceForm.from !== end) this.traceForm.to = end;
    const id = !this.traceForm.from ? 'trace-from' : !this.traceForm.to ? 'trace-to' : 'trace-go';
    if (this.analyzeTool() === 'trace') this.renderTraceWindow();
    else this.showAnalyze('trace');
    const f = this.doc.getElementById(id) as HTMLElement | null;
    if (f) f.focus();
  }

  /** Fill the Trace form (from the page or a test) without tracing. */
  setTraceForm(f: Partial<TraceForm>): void {
    this.traceForm = { ...this.traceForm, ...f };
    this.renderTraceWindow();
  }

  /** Draw the Trace window again (the check stays as computed). */
  redrawTrace(): void {
    this.renderTraceWindow();
  }

  private renderTraceWindow(): void {
    if (this.analyzeTool() === 'trace' && this.session) this.renderAnalyzeWs();
  }

  private traceBody(): HTMLElement {
    const s = this.session as Session;
    const r = this.traceRun;
    const view = { formError: this.traceError, bar: this.barState('trace', r ? r.check.info.context : null, r ? r.model : null), handoffBlocked: this.traceHandoffBlocked(), compareBlocked: this.traceCompareBlocked(), locked: this.editLock() };
    return traceWindowBody(this.doc, s.model, this.traceForm, this.currentTrace(), view, {
      input: (field: 'from' | 'to' | 'vrf' | 'service' | 'family' | 'back', value: string | boolean) => {
        if (field === 'back') this.traceForm.back = !!value;
        else this.traceForm[field] = String(value);
        if (this.traceError && (field === 'from' || field === 'to')) {
          this.traceError = '';
          const err = this.doc.getElementById('trace-error');
          if (err) err.remove();
          const inp = this.doc.getElementById('trace-' + field);
          if (inp) inp.removeAttribute('aria-invalid');
        }
      },
      submit: () => void this.runTrace(),
      swap: () => {
        this.traceForm = { ...this.traceForm, from: this.traceForm.to, to: this.traceForm.from };
        this.renderTraceWindow();
      },
      exit: () => {
        this.exitTrace();
        const go = this.doc.getElementById('trace-go');
        if (go) go.focus();
      },
      copy: () => void this.copyTrace(),
      save: () => void this.saveTraceText(),
      refresh: () => void this.runTrace(true),
      source: (src) => this.setAnalysisSource(src),
      handoff: () => this.traceHandoff(),
      compare: () => void this.compareTrace(),
      saveExpectation: () => this.traceToExpectation(),
      mtuTest: () => void this.traceMtuTest(),
      experiment: () => void this.traceToExperiment(),
      pick: (field, value) => {
        this.traceForm[field] = value;
        this.runTrace();
        const f = this.doc.getElementById('trace-pick-' + field) || this.doc.getElementById('trace-go');
        if (f) f.focus();
      },
    });
  }

  /**
   * Trace the form's request: the communication check with its paths, marked
   * in both views, the result in the window, and a banner that says what is
   * traced. A request that can't be traced (an unknown end, no address) only
   * says why. Nothing in the model changes; no undo step; nothing is sent in
   * a running simulation (a snapshot is read). Opens the window when it isn't.
   * `again`: Refresh, the request on screen computed again.
   */
  runTrace(again = false): boolean {
    const s = this.session;
    if (!s) return false;
    if (this.analyzeTool() !== 'trace') this.openTrace();
    const req = again && this.traceRun ? this.traceRun.request : formRequest(this.traceForm);
    const snap = this.analysisSnapshot();
    const run = this.computeTrace(req, snap);
    if (run.check.error && /^(Source|Destination|Service): /.test(run.check.error)) {
      this.traceError = run.check.error;
      this.renderTraceWindow();
      const bad = this.doc.getElementById(/^Destination/.test(run.check.error) ? 'trace-to' : /^Service/.test(run.check.error) ? 'trace-service' : 'trace-from');
      if (bad) bad.focus();
      return false;
    }
    this.traceError = '';
    this.traceRun = { ...run, model: s.model, snap, request: req };
    this.applyHighlight();
    this.renderTraceWindow();
    this.updateChrome();
    return true;
  }

  /** Remove the path trace from the diagram (the form keeps what was typed; the window stays open). */
  exitTrace(): boolean {
    if (!this.traceRun) return false;
    this.traceRun = null;
    this.applyHighlight();
    this.renderTraceWindow();
    this.updateChrome();
    const back = this.doc.activeElement;
    if (!back || back === this.doc.body) (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    return true;
  }

  /** Why the check on screen can't be prepared in the simulation now ('' it can). */
  private traceHandoffBlocked(): string {
    const r = this.traceRun;
    if (!r || !r.handoff || !r.identity) return 'Nothing to prepare: the check names no source and destination it could resolve';
    if (!this.simCtl) return 'Start a simulation first (Simulate → Start simulation…)';
    if (this.traceOutdated()) return 'The model changed since this check: press Refresh first';
    return staleProblem(this.simCtl.sim.model, r.identity) || '';
  }

  /** Why there is nothing to compare the check with ('' there is). */
  private traceCompareBlocked(): string {
    const r = this.traceRun;
    if (!r || !r.identity || !r.handoff || r.handoff.kind !== 'send') return 'Only a send of the simulation can be compared';
    return this.simCtl ? '' : 'No simulation runs';
  }

  /** Prepare the same exchange in the running simulation: its Network events form, prefilled with the check's own choices; nothing is sent. */
  traceHandoff(): boolean {
    const r = this.traceRun;
    const h = r ? r.handoff : undefined;
    const blocked = this.traceHandoffBlocked();
    if (!this.simCtl || !h || blocked) {
      if (blocked) this.toast(blocked + '.');
      return false;
    }
    if (h.kind === 'app' && h.app) this.simCtl.appFrom(h.device);
    else if (h.prefill) this.simCtl.prefillSend(h.prefill);
    this.toast(`${h.text}: prefilled in Network events, not sent.`);
    return true;
  }

  /**
   * Prepare a path MTU test in the simulation: the same send, one byte over
   * the payload the static path MTU allows, with Don't fragment. Nothing is
   * sent; what to expect is said.
   */
  traceMtuTest(): boolean {
    const r = this.traceRun;
    const h = r ? r.handoff : undefined;
    const sizes = r && r.mtu ? mtuTestSizes(r.mtu) : null;
    if (!this.simCtl || !r || !h || !h.prefill || !sizes || this.traceHandoffBlocked()) return false;
    // (a TCP connection segments by the path MTU: the test is an ICMP echo of that payload, as large as a segment's data)
    const icmp = h.prefill.kind === 'tcp';
    const pre = { ...h.prefill, kind: icmp ? ('icmp' as const) : h.prefill.kind, port: icmp ? undefined : h.prefill.port, size: icmp && r.mtu ? r.mtu.mtu! - (r.mtu.family === 4 ? 28 : 48) + 1 : sizes.tooBig, df: true };
    this.simCtl.prefillSend(pre);
    this.toast(`A send of ${pre.size} bytes with Don’t fragment is prefilled, not sent: one byte over what the static path MTU (${r.mtu ? r.mtu.mtu : '?'}) lets through.`);
    return true;
  }

  /** The check beside the simulation's latest send that carries it, with what explains a difference. */
  compareTrace(): boolean {
    const r = this.traceRun;
    if (!r || !r.identity || !this.simCtl || this.traceCompareBlocked()) return false;
    const id = r.identity;
    // (the newest send that carries it: testRuns lists the newest first)
    const run = this.simCtl.sim.testRuns().find((x) => planMatches(id, x.plan));
    if (!run) {
      this.toast('Nothing to compare yet: prepare it in the simulation and send it first.');
      return false;
    }
    r.compare = compareRun(r.model, r.check, run, this.simCtl.snapshot());
    this.renderTraceWindow();
    const sec = this.doc.getElementById('trace-compare-res');
    if (sec) {
      sec.setAttribute('tabindex', '-1');
      sec.focus();
    }
    return true;
  }

  /** Keep the check on screen as a saved expectation: Design checks with its form prefilled (nothing entered again, nothing saved yet). */
  traceToExpectation(): boolean {
    const r = this.traceRun;
    if (!r || !r.identity || this.editLock()) return false;
    const f = expectationFields(r.identity);
    this.dcForm = { ...newExpectForm(), expect: f.expect, from: f.from, to: f.to || '', service: f.service || '', vrf: f.vrf !== undefined ? f.vrf : '', family: f.family ? String(f.family) : '' };
    this.openDesignChecks();
    const n = this.doc.getElementById('dc-f-name');
    if (n) n.focus();
    return true;
  }

  /** The check as text: its context, verdict and layers, the hops, the assumptions. */
  private traceExport(): string {
    const r = this.traceRun as NonNullable<App['traceRun']>;
    return traceExportText({ title: (this.session as Session).model.title, version: this.appVersion(), outdated: this.traceOutdated() }, r);
  }

  /** The check as text, on the clipboard (where the browser refuses: as a text file). */
  copyTrace(): boolean {
    if (!this.traceRun) return false;
    void this.copyText(this.traceExport(), 'The path trace was copied as text.', () => this.saveTraceText());
    return true;
  }

  /** The check as a text file. */
  saveTraceText(): boolean {
    if (!this.traceRun || !this.mdoc) return false;
    const name = `${pictureBaseName(this.mdoc.fileName)}-path-trace.txt`;
    downloadText(this.doc, this.traceExport(), name, 'text/plain');
    this.toast(`Saved the path trace as “${name}”.`);
    return true;
  }

  // ------------------------------------------------------------ the palette

  /** keys ("cmd:<id>", "ref:<ref>") of the palette entries used last, newest first */
  private recent: string[] = [];
  private static readonly RECENT_KEY = 'netatlas.palette.recent';
  private static readonly RECENT_MAX = 8;

  private loadRecent(): void {
    try {
      const win = this.doc.defaultView;
      const v = win && win.localStorage ? win.localStorage.getItem(App.RECENT_KEY) : null;
      const list = v ? JSON.parse(v) : [];
      this.recent = Array.isArray(list) ? list.filter((x: unknown) => typeof x === 'string').slice(0, App.RECENT_MAX) : [];
    } catch {
      this.recent = [];
    }
  }

  private rememberRecent(key: string): void {
    this.recent = [key].concat(this.recent.filter((k) => k !== key)).slice(0, App.RECENT_MAX);
    try {
      const win = this.doc.defaultView;
      if (win && win.localStorage) win.localStorage.setItem(App.RECENT_KEY, JSON.stringify(this.recent));
    } catch {
      /* no storage: the list lasts for this page */
    }
  }

  /** Is the command palette open? */
  get paletteOpen(): boolean {
    const dlg = this.doc.getElementById('modal') as HTMLDialogElement;
    return dlg.open && dlg.classList.contains('palette-dialog');
  }

  /**
   * The command palette (Ctrl+K, Cmd+K on macOS; Find → Command palette…):
   * a search field over every command (with its shortcut; an unavailable
   * one is shown disabled with the reason) and every object of the model.
   * Up / Down move through the results, Enter runs the command or selects
   * the object, Esc closes. The number of results is announced. The entries
   * used last come first (remembered in this browser).
   */
  async openPalette(): Promise<void> {
    if (this.paletteOpen) return;
    this.openMenu(null);
    if (!this.recent.length) this.loadRecent();
    const opener = this.doc.activeElement as HTMLElement | null;
    const mac = isMac(this.doc.defaultView);
    const objects = this.session ? objectItems(this.session.model) : [];
    const items = (): PaletteItem[] => commandItems(this.commands, (c) => c.state(this), mac).concat(objects);
    const known = new Set(items().map((x) => x.key));
    const recent = this.recent.filter((k) => known.has(k));
    const input = el(this.doc, 'input', {
      id: 'palette-input',
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'palette-list',
      'aria-autocomplete': 'list',
      'aria-describedby': 'palette-help',
      'aria-label': 'Command or object',
      placeholder: 'Type a command or the name of an object…',
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;
    const status = el(this.doc, 'p', { id: 'palette-status', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const help = el(this.doc, 'p', { id: 'palette-help', class: 'muted small palette-help' }, ['↑ ↓ choose · Enter run or select · Esc close']);
    const box = el(this.doc, 'div', { class: 'palette' }, [input, help, status]);
    let ranked = rankItems(items(), '', recent);
    let active = 0;
    const firstEnabled = (from: number, step: number): number => {
      const n = ranked.items.length;
      for (let k = 0; k < n; k++) {
        const i = (((from + k * step) % n) + n) % n;
        if (ranked.items[i].state.enabled) return i;
      }
      return Math.max(0, Math.min(from, n - 1));
    };
    const draw = (): void => {
      const old = box.querySelector('#palette-list');
      const list = paletteList(this.doc, ranked, active, input.value);
      if (old) box.replaceChild(list, old);
      else box.appendChild(list);
      if (ranked.items.length) input.setAttribute('aria-activedescendant', 'palette-opt-' + active);
      else input.removeAttribute('aria-activedescendant');
      const opt = list.querySelector('#palette-opt-' + active) as HTMLElement | null;
      if (opt && typeof opt.scrollIntoView === 'function') opt.scrollIntoView({ block: 'nearest' });
    };
    const refresh = (): void => {
      ranked = rankItems(items(), input.value, recent);
      active = ranked.items.length ? firstEnabled(0, 1) : 0;
      draw();
      status.textContent = resultsText(ranked.items.length, ranked.more, input.value);
    };
    const choose = (i: number): void => {
      const x = ranked.items[i];
      if (!x) return;
      if (!x.state.enabled) {
        status.textContent = `${x.label} is unavailable: ${x.state.reason || ''}`;
        return;
      }
      closeDialogWith(input, x.key);
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      const n = ranked.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!n) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        draw();
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        if (!n) return;
        active = Math.max(0, Math.min(n - 1, active + (e.key === 'PageDown' ? 8 : -8)));
        draw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(active);
      }
    });
    box.addEventListener('click', (e) => {
      const o = (e.target as Element).closest('[data-pal]');
      if (!o) return;
      active = Number(o.getAttribute('data-index'));
      draw();
      choose(active);
      input.focus();
    });
    box.addEventListener('pointermove', (e) => {
      const o = (e.target as Element).closest('[data-pal]');
      if (!o) return;
      const i = Number(o.getAttribute('data-index'));
      if (i === active) return;
      active = i;
      for (const x of Array.from(box.querySelectorAll('.pal-opt'))) {
        const on = x.getAttribute('data-index') === String(i);
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      input.setAttribute('aria-activedescendant', 'palette-opt-' + i);
    });
    refresh();
    const res = await this.dialog({ title: 'Command palette', body: [box], buttons: [], className: 'palette-dialog', focus: '#palette-input' });
    const dlg = this.doc.getElementById('modal') as HTMLElement;
    dlg.className = '';
    if (res.indexOf('cmd:') === 0) {
      this.rememberRecent(res);
      // back where the palette was opened from, then the command (it may move the focus itself)
      if (opener && this.doc.contains(opener) && !opener.closest('[role="menu"]')) opener.focus();
      this.runCommand(res.slice(4));
    } else if (res.indexOf('ref:') === 0) {
      this.rememberRecent(res);
      this.select(res.slice(4), true);
      (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    } else if (opener && this.doc.contains(opener) && !opener.closest('[role="menu"]')) opener.focus();
  }

  // ------------------------------------------------------------ Analyze menu

  /** what the Addressing overview shows (filter, sort, open member lists): kept while the page is open, never saved */
  private addrState: AddrViewState = newAddrViewState();

  /** Is the Addressing overview open? */
  get addressingOpen(): boolean {
    return this.analyzeTool() === 'addressing';
  }

  /**
   * Analyze → Addressing overview… (I): a window with the networks of every
   * VRF with their members, gateways, use and free space, and the
   * duplicate, overlapping and stray addresses. Filter, sort and the open
   * member lists are kept for the next opening. A click on an object selects
   * it in the diagram beside the window. It never changes the model.
   */
  openAddressing(): void {
    if (!this.session) return;
    this.computeAddressing();
    this.showAnalyze('addressing');
    const f = this.doc.getElementById('addr-filter');
    if (f) f.focus();
  }

  /** the overview on screen, and the model and snapshot it was computed on (computed again by opening the window or Refresh) */
  private addrRun: { model: Model; snap: AnalysisSnapshot | null; ov: AddressingOverview; context: AnalysisContext } | null = null;

  private computeAddressing(): void {
    const s = this.session as Session;
    const snap = this.analysisSnapshot();
    this.addrRun = { model: s.model, snap, ov: addressingOverview(s.model, snap), context: snap ? { kind: 'snapshot', at: snap.at, scope: 'Entire architecture' } : { kind: 'model', scope: 'Entire architecture' } };
  }

  /** Refresh: the overview computed again (on a snapshot taken now, when one is chosen). */
  refreshAddressing(): void {
    if (!this.session) return;
    this.computeAddressing();
    this.renderAddressingWindow();
    const f = this.doc.getElementById('addr-filter');
    if (f && this.doc.activeElement && this.doc.activeElement.hasAttribute('data-an-refresh')) f.focus();
  }

  private renderAddressingWindow(): void {
    if (this.analyzeTool() === 'addressing' && this.session) this.renderAnalyzeWs();
  }

  private addressingWindowBody(): HTMLElement {
    if (!this.addrRun) this.computeAddressing();
    const run = this.addrRun as NonNullable<App['addrRun']>;
    const ov = run.ov;
    const st = this.addrState;
    const inner = addressingBody(this.doc, ov, st);
    const body = el(this.doc, 'div', { class: 'addr-window' }, [contextBar(this.doc, this.barState('addr', run.context, run.model), { refresh: () => this.refreshAddressing(), source: (src) => this.setAnalysisSource(src) }), inner]);
    // (laid out in the Analyze panels: the results drawn again there, the request's controls kept)
    const redraw = (): void => this.renderAnalyzeWs('results');
    void addressingTables;
    void shownText;
    this.onRoot(body, 'input', (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.hasAttribute('data-addr-filter')) return;
      st.filter = t.value;
      redraw();
    });
    this.onRoot(body, 'click', (e) => {
      const t = e.target as Element;
      const go = t.closest('[data-addr-goto]');
      if (go) {
        this.select(go.getAttribute('data-addr-goto'), true);
        return;
      }
      const sort = t.closest('[data-addr-sort]');
      if (sort) {
        const k = sort.getAttribute('data-addr-sort') as AddrSort;
        st.desc = st.sort === k ? !st.desc : false;
        st.sort = k;
        redraw();
        const again = this.doc.querySelector(`[data-addr-sort="${k}"]`) as HTMLElement | null;
        if (again) again.focus();
        return;
      }
      const tog = t.closest('[data-addr-toggle]');
      if (tog) {
        const key = tog.getAttribute('data-addr-toggle') as string;
        const open = !st.open.has(key);
        if (open) st.open.add(key);
        else st.open.delete(key);
        tog.setAttribute('aria-expanded', open ? 'true' : 'false');
        tog.setAttribute('title', open ? 'Hide the members' : 'Show the members');
        tog.textContent = tog.textContent!.replace(/^[▸▾]/, open ? '▾' : '▸');
        const row = this.doc.getElementById(tog.getAttribute('aria-controls') as string);
        if (row) row.hidden = !open;
        const all = this.doc.querySelector('[data-addr-all]') as HTMLElement;
        all.setAttribute('data-addr-all', st.open.size ? 'close' : 'open');
        all.textContent = st.open.size ? 'Collapse all members' : 'Expand all members';
        return;
      }
      const all = t.closest('[data-addr-all]');
      if (all) {
        if (all.getAttribute('data-addr-all') === 'open') for (const g of ov.vrfs) for (const n of g.networks) st.open.add(g.vrf + '|' + n.id);
        else st.open.clear();
        redraw();
        (this.doc.querySelector('[data-addr-all]') as HTMLElement).focus();
        return;
      }
      const csvBtn = t.closest('[data-addr-csv]');
      if (csvBtn) {
        if (csvBtn.getAttribute('data-addr-csv') === 'save') this.saveAddressingCsv();
        else void this.copyText(addressingCsv(ov, this.addrContextText()), 'The network table was copied as CSV.');
      }
    });
    return body;
  }

  /** Save the Addressing overview's network table as "<model>-addressing.csv", downloaded like an exported picture (the overview's Save CSV). */
  saveAddressingCsv(): boolean {
    const s = this.session;
    if (!s || !this.mdoc) return false;
    const name = `${pictureBaseName(this.mdoc.fileName)}-addressing.csv`;
    if (!this.addrRun || this.addrRun.model !== s.model) this.computeAddressing();
    downloadText(this.doc, addressingCsv((this.addrRun as NonNullable<App['addrRun']>).ov, this.addrContextText()), name, 'text/csv');
    this.toast(`Exported “${name}”.`);
    return true;
  }

  /** The context of the overview on screen in words, for its CSV (and that it is outdated). */
  private addrContextText(): string {
    const r = this.addrRun;
    if (!r) return 'Configured model · Entire architecture';
    return contextText(r.context) + (this.outdatedSince(r.model) ? ' (outdated)' : '') + (this.appVersion() ? ' · NetAtlas ' + this.appVersion() : '');
  }

  /** Put text on the clipboard; where the browser refuses, say so (or save it as a file, when `orSave` is given). */
  private async copyText(text: string, done: string, orSave?: () => void): Promise<void> {
    const nav = this.doc.defaultView ? this.doc.defaultView.navigator : null;
    try {
      if (!nav || !nav.clipboard) throw new Error('no clipboard');
      await nav.clipboard.writeText(text);
      this.toast(done);
    } catch (e) {
      if (orSave) orSave();
      else this.toast('The browser did not allow copying to the clipboard here; use Save CSV instead.');
    }
  }

  // ------------------------------------------------------------ design checks

  /** the evaluation on screen (computed by Evaluate, never on its own), the model and snapshot it was computed on */
  private dcRun: { model: Model; snap: AnalysisSnapshot | null; run: ExpectationRun } | null = null;
  private dcOpen = new Set<string>();
  private dcForm: ExpectForm | null = null;

  /**
   * Analyze → Design checks…: the saved expectations (evaluated on demand,
   * statically: nothing is sent) and the consistency findings, grouped, with
   * their consequences and next steps.
   */
  openDesignChecks(): void {
    if (!this.session) return;
    this.showAnalyze('checks');
    const f = this.doc.getElementById('dc-evaluate');
    if (f) f.focus();
  }

  private renderDesignChecks(): void {
    if (this.analyzeTool() === 'checks' && this.session) this.renderAnalyzeWs();
  }

  /** Evaluate the saved expectations now (on a snapshot of a running simulation, when one is chosen). */
  refreshDesignChecks(): ExpectationRun | null {
    const s = this.session;
    if (!s) return null;
    const snap = this.analysisSnapshot();
    this.dcRun = { model: s.model, snap, run: evaluateExpectations(s.model, snap) };
    this.renderDesignChecks();
    return this.dcRun.run;
  }

  /** The findings of the consistency checks as the window shows them (with their index in the issue list, for Go to). */
  private designFindings(): DesignView['findings'] {
    const d = this.mdoc as ModelDoc;
    const base = d.errors.length + d.warnings.length;
    const asFinding = (is: Issue): Finding => ({ check: is.check || '', severity: is.severity, message: is.message, refs: is.refs || [], at: { ref: (is.refs && is.refs[0]) || is.path, field: is.path } });
    const fs = d.findings.map(asFinding);
    const { groups, singles } = groupFindings(fs);
    const index = (f: Finding): number => base + fs.indexOf(f);
    return {
      groups: groups.map((g) => ({ g, n: g.findings.map((p) => index(p.finding)) })),
      singles: singles.map((p) => ({ p, n: index(p.finding) })),
      counts: classCounts(fs),
    };
  }

  private designWindowBody(): HTMLElement {
    const s = this.session as Session;
    const r = this.dcRun;
    const findings = this.designFindings();
    // the findings at the place an expectation stops (its stop device and the cables and ports of that hop)
    const related = new Map<string, ShownFinding[]>();
    if (r) {
      const all = findings.singles.concat(...findings.groups.map((g) => g.g.findings.map((p, k) => ({ p, n: g.n[k] }))));
      for (const res of r.run.results) {
        if (res.verdict === 'satisfied' || !res.check || !res.check.trace) continue;
        const stopped = res.check.trace.paths.find((p) => p.end.kind === 'stopped');
        if (!stopped) continue;
        const last = stopped.hops[stopped.hops.length - 1];
        const at = new Set<string>(['device:' + last.device].concat(last.links.map((l) => 'link:' + l), last.l2.map((x) => 'device:' + x), last.egress ? [`iface:${last.device}:${last.egress}`] : [], last.ingress ? [`iface:${last.device}:${last.ingress}`] : []));
        const hit = all.filter((f) => f.p.finding.refs.some((x) => at.has(x)));
        if (hit.length) related.set(res.id, hit.slice(0, 6));
      }
    }
    const view: DesignView = {
      bar: this.barState('dc', r ? r.run.info.context : null, r ? r.model : null),
      run: r ? r.run : null,
      open: this.dcOpen,
      form: this.dcForm,
      locked: this.editLock(),
      findings,
      related,
    };
    return designBody(this.doc, s.model, view, {
      refresh: () => void this.refreshDesignChecks(),
      source: (src) => this.setAnalysisSource(src),
      evaluate: () => {
        this.refreshDesignChecks();
        const st = this.doc.getElementById('dc-status');
        if (st) st.setAttribute('tabindex', '-1');
        const b = this.doc.getElementById('dc-evaluate');
        if (b) b.focus();
      },
      add: () => {
        this.dcForm = newExpectForm();
        this.renderDesignChecks();
        const f = this.doc.getElementById('dc-f-name');
        if (f) f.focus();
      },
      edit: (id) => {
        const k = s.model.expectations.findIndex((e) => e.id === id);
        const entry = (this.mdoc as ModelDoc).analysisEntries('expectations').find((x) => x.id === id);
        if (k < 0 || !entry) return;
        this.dcForm = formOf(s.model.expectations[k], entry.index);
        this.renderDesignChecks();
        const f = this.doc.getElementById('dc-f-name');
        if (f) f.focus();
      },
      remove: (id) => void this.removeExpectation(id),
      toggle: (id) => {
        // in the Analyze workspace: the expectation selected, its evidence on the right
        if (this.ws === 'analyze') {
          this.selectAnalysisItem(this.anSel === 'exp:' + id ? '' : 'exp:' + id);
          return;
        }
        if (this.dcOpen.has(id)) this.dcOpen.delete(id);
        else this.dcOpen.add(id);
        this.renderDesignChecks();
      },
      trace: (id) => {
        const e = s.model.expectations.find((x) => x.id === id);
        if (!e) return;
        this.traceForm = { from: e.from, to: e.to || '', vrf: e.vrf !== undefined ? e.vrf : 'auto', service: e.service || '', family: e.family ? String(e.family) : '', back: false };
        this.openTrace();
        this.runTrace();
      },
      formInput: (k, v) => {
        if (!this.dcForm) return;
        (this.dcForm as unknown as { [key: string]: string | number })[k] = v;
        if (k === 'expect' || k === 'enforce' || k === 'method') {
          this.renderDesignChecks();
          const back = this.doc.getElementById('dc-f-' + k);
          if (back) back.focus();
        }
      },
      formSave: () => this.saveExpectationForm(),
      formCancel: () => {
        this.dcForm = null;
        this.renderDesignChecks();
        const b = this.doc.getElementById('dc-add');
        if (b) b.focus();
      },
      goto: (n) => this.gotoIssue(n),
      show: (ref) => this.select(ref, true),
      out: (kind) => {
        const run = this.dcRun;
        if (!run || !this.mdoc) return;
        const outdated = this.outdatedSince(run.model);
        const base = pictureBaseName(this.mdoc.fileName) + '-design-checks';
        const text = (): string => designText({ title: s.model.title, version: this.appVersion(), outdated }, s.model, run.run);
        const csv = (): string => designCsv(s.model, run.run, outdated);
        if (kind === 'text-copy') void this.copyText(text(), 'The design checks were copied as text.');
        else if (kind === 'csv-copy') void this.copyText(csv(), 'The design checks were copied as CSV.');
        else {
          const isCsv = kind === 'csv-save';
          downloadText(this.doc, isCsv ? csv() : text(), base + (isCsv ? '.csv' : '.txt'), isCsv ? 'text/csv' : 'text/plain');
          this.toast(`Exported “${base}${isCsv ? '.csv' : '.txt'}”.`);
        }
      },
    });
  }

  /** Save the expectation form: a new expectation, or the changed one (one undo step); the form says what is missing. */
  private saveExpectationForm(): boolean {
    const f = this.dcForm;
    const d = this.mdoc;
    const s = this.session;
    if (!f || !d || !s) return false;
    const need = !f.name.trim() ? 'Give the expectation a name.' : !f.from.trim() ? 'Give its source: a device, an interface, an address or an application.' : (f.expect === 'available' || f.expect === 'blocked') && !f.to.trim() && f.from.indexOf('/') < 0 ? 'Give its destination: a device, an address, an application or a service.' : f.expect === 'blocked' && f.enforce === 'boundary' && !f.boundary.trim() ? 'Give the boundary: the device that must deny it.' : f.expect === 'timing' && !f.method ? 'Choose the timing method it accepts: PTP, NTP, or either.' : '';
    if (need) {
      f.error = need;
      this.renderDesignChecks();
      const bad = this.doc.getElementById(!f.name.trim() ? 'dc-f-name' : !f.from.trim() ? 'dc-f-from' : /boundary/.test(need) ? 'dc-f-boundary' : /timing method/.test(need) ? 'dc-f-method' : 'dc-f-to');
      if (bad) bad.focus();
      return false;
    }
    // (an enforcement goes with a blocked expectation only, a boundary with enforce: boundary)
    const blocked = f.expect === 'blocked';
    const fields = { name: f.name, expect: f.expect, from: f.from, to: f.to, service: f.service, vrf: f.vrf, family: f.family, enforce: blocked ? f.enforce : '', boundary: blocked && f.enforce === 'boundary' ? f.boundary : '', method: f.expect === 'timing' ? f.method : '', failure: f.failure.split(/[\s,]+/).filter((x) => x), description: f.description };
    try {
      if (f.index < 0) d.addExpectation(fields);
      else d.updateExpectation(f.index, fields);
    } catch (e) {
      this.refusedEdit(e);
      return false;
    }
    this.dcForm = null;
    this.afterEdit(f.index < 0 ? 'The expectation was added.' : 'The expectation was changed.');
    // the change is evaluated at once (nothing is sent): the window shows it
    this.refreshDesignChecks();
    const b = this.doc.getElementById('dc-add');
    if (b) b.focus();
    return true;
  }

  // ------------------------------------------------------------ bulk port edits

  /** The device a bulk port edit works on: the selected device, or the device of the selected interface. */
  bulkTarget(): string | null {
    const s = this.session;
    const sel = s ? s.state.selected : null;
    if (!s || !sel) return null;
    const [kind, id] = splitRef(sel);
    const dev = kind === 'device' ? id : kind === 'iface' ? id.split(':')[0] : '';
    const d = dev ? s.model.index.devices.get(dev) : undefined;
    return d && d.interfaces.some((i) => !i.routed) ? d.id : null;
  }

  /** Bulk edit ports…: one VLAN change on several ports, previewed, applied as one undo step. */
  openBulkPorts(dev: string | null = this.bulkTarget()): boolean {
    const s = this.session;
    const d = this.mdoc;
    const device = dev && s ? s.model.index.devices.get(dev) : undefined;
    if (!s || !d || !device) return false;
    const devIndex = s.model.devices.indexOf(device);
    const body = bulkBody(this.doc, device, this.editLock(), {
      plan: (ports, op) => planPortEdit((this.session as Session).model.index.devices.get(device.id) as Device, ports, op),
      apply: (ports, op) => {
        const rows = planPortEdit((this.session as Session).model.index.devices.get(device.id) as Device, ports, op);
        const n = rows.filter((r) => r.write).length;
        try {
          d.applyPortPlan(devIndex, rows, `Edit ${n} port${n === 1 ? '' : 's'} of ${device.id}`);
        } catch (e) {
          this.refusedEdit(e);
          return;
        }
        this.afterEdit(`${n} port${n === 1 ? '' : 's'} of ${device.id} changed (Ctrl+Z undoes all of it).`);
        this.closeToolWindow();
      },
    });
    this.openWindow({ id: 'bulk', title: `Bulk edit ports of ${device.id}`, body, width: 640, height: 620, focus: '#bulk-op' });
    return true;
  }

  // ------------------------------------------------------------ navigation by context

  /** Find → Applications, VLANs and VRFs…: each with a contextual Focus (configured structure; nothing changes). */
  openBrowse(): void {
    const s = this.session;
    if (!s) return;
    const focusOn = (ref: string, c: FocusContext): void => {
      if (s.state.focus) this.exitFocus();
      this.select(ref, true);
      if (!this.enterContextFocus(c)) this.toast('That can’t be focused on now.');
    };
    const firstDevice = (c: FocusContext): string | null => {
      const ds = Array.from(contextFocus(s.model, c).devices).filter((x) => x[1] === 0).map((x) => x[0]).sort();
      return ds.length ? 'device:' + ds[0] : null;
    };
    const body = browseBody(this.doc, navigationIndex(s.model), {
      focusApp: (d) => focusOn('device:' + d, { kind: 'app', device: d }),
      selectApp: (d) => this.select('device:' + d, true),
      focusVlan: (v) => {
        const r = firstDevice({ kind: 'vlan', vlan: v });
        if (r) focusOn(r, { kind: 'vlan', vlan: v });
      },
      focusVrf: (v) => {
        const r = firstDevice({ kind: 'vrf', vrf: v });
        if (r) focusOn(r, { kind: 'vrf', vrf: v });
      },
    });
    this.openWindow({ id: 'browse', title: 'Applications, VLANs and VRFs', body, width: 640, height: 560, focus: '#nav-apps summary' });
  }

  // ------------------------------------------------------------ collapsed groups

  /** The group a collapse or expand acts on: the selected group, or the group of the selected device. */
  collapseTarget(): string | null {
    const s = this.session;
    const sel = s ? s.state.selected : null;
    if (!s || !sel) return null;
    const [kind, id] = splitRef(sel);
    if (kind === 'group') return id;
    const dev = kind === 'device' ? id : kind === 'iface' ? id.split(':')[0] : '';
    const d = dev ? s.model.index.devices.get(dev) : undefined;
    return d && d.group !== undefined ? d.group : null;
  }

  /**
   * Draw a group as one box (its connections out of it drawn to the box),
   * or its devices again: display state only, like a filter (no undo step,
   * the model and its layout are untouched).
   */
  setGroupCollapsed(group: string | null, on: boolean): boolean {
    const s = this.session;
    if (!s || group === null || !s.setCollapsed(group, on)) return false;
    this.render();
    this.fit();
    this.renderOutline();
    this.updateChrome();
    const g = s.model.index.groups.get(group);
    this.toast(on ? `${g ? g.label || g.id : group} is drawn as one box; its connections out of it go to the box. Expand group draws its devices again.` : `${g ? g.label || g.id : group} is drawn with its devices again.`);
    return true;
  }

  /** Expand every collapsed group. */
  expandAllGroups(): boolean {
    const s = this.session;
    if (!s || !s.state.collapsed.size) return false;
    for (const g of Array.from(s.state.collapsed)) s.setCollapsed(g, false);
    this.render();
    this.fit();
    this.renderOutline();
    this.updateChrome();
    return true;
  }

  // ------------------------------------------------------------ saved views

  /** Find → Saved views…: the model's saved views, Open and Delete, and Save current view. */
  openSavedViews(): void {
    if (!this.session) return;
    this.openWindow({ id: 'views', title: 'Saved views', body: this.viewsWindowBody(), width: 640, height: 480, focus: '#vw-name' });
  }

  private renderViews(): void {
    if (this.toolWindow() === 'views' && this.session) this.replaceWindowBody(this.viewsWindowBody());
  }

  private viewsWindowBody(): HTMLElement {
    const s = this.session as Session;
    const current = viewSummary({ id: '', name: '', line: 0, ...this.currentViewFields() });
    return viewsBody(this.doc, s.model.views, current, this.editLock(), {
      save: (name) => void this.saveCurrentView(name),
      open: (id) => void this.openSavedView(id),
      remove: (id) => void this.removeSavedView(id),
    });
  }

  /** The view on screen, as a saved view has it. */
  private currentViewFields(): Omit<SavedView, 'id' | 'name' | 'line'> {
    const s = this.session as Session;
    const st = s.state;
    const out: Omit<SavedView, 'id' | 'name' | 'line'> = { view: st.view === 'logical' ? 'logical' : 'physical', hideTypes: Array.from(st.hiddenTypes).sort(), hideProtocols: Array.from(st.hiddenProtocols).sort(), options: {} };
    if (st.devices) out.devices = s.model.devices.filter((d) => (st.devices as Set<string>).has(d.id)).map((d) => d.id);
    if (st.collapsed.size) out.collapse = s.model.groups.filter((g) => st.collapsed.has(g.id)).map((g) => g.id);
    if (st.focus) {
      const [kind, id] = splitRef(st.focus.ref);
      const target = kind === 'device' || kind === 'iface' ? id : `${kind}:${id}`;
      const c = st.focus.context;
      out.focus = c ? (c.kind === 'vlan' ? { target, context: 'vlan', vlan: c.vlan } : c.kind === 'multicast' ? { target, context: 'multicast', group: c.group } : c.kind === 'vrf' ? { target, context: 'vrf', vrf: c.vrf } : { target, context: c.kind === 'app' ? 'dependencies' : 'timing' }) : { target, hops: st.focus.hops };
    }
    if (!st.showLabels) out.options.labels = false;
    if (!st.showGroups) out.options.groups = false;
    if (!st.showNetworks) out.options.networks = false;
    if (!st.showRoutes) out.options.routes = false;
    const W = this.svg.clientWidth || 1000;
    const H = this.svg.clientHeight || 700;
    const k = this.zoom.k;
    out.viewport = { x: Math.round((W / 2 - this.zoom.tx) / k), y: Math.round((H / 2 - this.zoom.ty) / k), zoom: Math.round(k * 100) / 100 };
    return out;
  }

  /** Save the view on screen in the model (one undo step); a name is needed. */
  saveCurrentView(name: string): boolean {
    const d = this.mdoc;
    if (!this.session || !d || this.editLock()) return false;
    if (!name) {
      this.toast('Give the view a name first.');
      const n = this.doc.getElementById('vw-name') as HTMLElement | null;
      if (n) n.focus();
      return false;
    }
    const v = this.currentViewFields();
    try {
      d.addView(name, v);
    } catch (e) {
      this.refusedEdit(e);
      return false;
    }
    this.afterEdit(`The view “${name}” was saved.`);
    return true;
  }

  /**
   * Open a saved view: its diagram, filters, options, focus and zoom (fitted
   * when it has none). Display only: the model, an analysis and a running
   * simulation are not touched. What it names that is gone is left out.
   */
  openSavedView(id: string): boolean {
    const s = this.session;
    if (!s) return false;
    const v = s.model.views.find((x) => x.id === id);
    if (!v) return false;
    if (s.state.focus) this.exitFocus();
    s.setView(v.view);
    s.state.showLabels = v.options.labels !== false;
    s.state.showGroups = v.options.groups !== false;
    s.state.showNetworks = v.options.networks !== false;
    s.state.showRoutes = v.options.routes !== false;
    if (s.state.hiddenTypes.size) s.setTypesVisible(Array.from(s.state.hiddenTypes), true);
    if (v.hideTypes.length) s.setTypesVisible(v.hideTypes, false);
    for (const p of Array.from(s.state.hiddenProtocols)) s.toggleProtocol(p, true);
    for (const p of v.hideProtocols) s.toggleProtocol(p, false);
    s.setDevices(v.devices || s.model.devices.map((d) => d.id));
    for (const g of Array.from(s.state.collapsed)) s.setCollapsed(g, false);
    for (const g of v.collapse || []) s.setCollapsed(g, true);
    this.cancelConnection();
    this.render();
    this.renderOutline();
    this.layoutFilters();
    this.updateChrome();
    const ref = v.focus ? focusRef(s.model, v.focus.target) : null;
    if (v.focus && ref) {
      this.select(ref, true);
      const f = v.focus;
      const ok = f.context ? this.enterContextFocus(f.context === 'vlan' ? { kind: 'vlan', vlan: f.vlan as number } : f.context === 'multicast' ? { kind: 'multicast', group: f.group as string } : f.context === 'vrf' ? { kind: 'vrf', vrf: f.vrf as string } : f.context === 'dependencies' ? { kind: 'app', device: splitRef(ref)[1] } : { kind: 'timing', device: splitRef(ref)[1] }) : this.enterFocus(ref, f.hops || 1);
      if (!ok) this.toast(`The view’s focus on ${f.target} can’t be shown now; the rest of the view is.`);
    }
    if (v.viewport) {
      const W = this.svg.clientWidth || 1000;
      const H = this.svg.clientHeight || 700;
      const k = v.viewport.zoom;
      this.zoom = { k, tx: W / 2 - v.viewport.x * k, ty: H / 2 - v.viewport.y * k };
      this.applyZoom();
    } else this.fit();
    this.renderViews();
    this.toast(`Showing the view “${v.name}”.`);
    return true;
  }

  /** Delete a saved view (one undo step; no confirmation: it is display state, and Ctrl+Z brings it back). */
  removeSavedView(id: string): boolean {
    const d = this.mdoc;
    if (!d || this.editLock()) return false;
    const e = d.analysisEntries('views').find((x) => x.id === id);
    if (!e) return false;
    try {
      d.removeView(e.index);
    } catch (err) {
      this.refusedEdit(err);
      return false;
    }
    this.afterEdit('The view was deleted (Ctrl+Z brings it back).');
    return true;
  }

  // ------------------------------------------------------------ workspaces

  /** the panel workspace presented now (one at a time): editing, a simulation, Experiments or Analyze */
  private ws: Workspace = 'edit';
  /** Analyze entered from another workspace (a paused simulation, Experiments): where Exit Analyze returns */
  private analyzeFrom: Workspace = 'edit';

  /** The workspace presented now. */
  workspace(): Workspace {
    return this.ws;
  }

  /**
   * Present a workspace's panels (or the editing panels: 'edit'). Layout
   * only: what runs is started and stopped by the transitions, never here.
   */
  private showWorkspace(ws: Workspace): void {
    const d = this.doc;
    const was = this.ws;
    this.ws = ws;
    applyPanels(d, ws);
    if (this.simCtl) d.body.setAttribute('data-sim', 'on');
    else d.body.removeAttribute('data-sim');
    const on = ws !== 'edit';
    this.$('outline').setAttribute('aria-labelledby', on ? 'sim-setup-title' : 'outline-title');
    const side = this.$('side');
    if (on) {
      side.removeAttribute('aria-label');
      side.setAttribute('aria-labelledby', 'sim-actions-title');
    } else {
      side.removeAttribute('aria-labelledby');
      side.setAttribute('aria-label', 'Inspector');
    }
    this.applyDockHeight();
    // (a narrow and short window starts with the diagram, a narrow one with the right panel under it)
    if (on && was !== ws) this.simPanelTab((d.getElementById('spt-diagram') as HTMLElement).getClientRects().length ? 'diagram' : 'actions', false);
    // the Inspector comes back with its tab and the selection as they were
    if (!on) {
      this.renderOutline();
      this.renderSide();
    }
    this.layoutFilters();
    this.renderWorkspace();
    this.applyHighlight();
    this.updateChrome();
  }

  /** The panels of the workspace in front, drawn again from the model (after an edit, a selection, a run's progress). */
  private renderWorkspace(): void {
    if (this.ws === 'experiments') this.renderExperimentsWs();
    else if (this.ws === 'analyze') this.renderAnalyzeWs();
  }

  /** Ask before work in progress is ended by a transition (never silently); true: go on. */
  private async confirmEnd(what: string, title: string, body: string): Promise<boolean> {
    const a = await this.dialog({ title, body: [body], buttons: [{ label: 'Cancel', value: 'cancel' }, { label: what, value: 'go', kind: 'danger' }] });
    return a === 'go';
  }

  /**
   * Simulate → Experiments…: the Experiments workspace. A running simulation
   * ends first, after a confirmation (an experiment runs its own simulation
   * from its defined start); from Analyze, its overlays are cleared. Opening
   * it runs nothing.
   */
  async enterExperiments(): Promise<boolean> {
    if (!this.session) return false;
    if (this.ws === 'experiments') return true;
    if (this.simulation) {
      if (!(await this.confirmEnd('End simulation and open', 'Open Experiments?', 'The running simulation ends and its state is discarded. Experiments run their own simulation, from the start each experiment defines, only when you press Run.'))) return false;
      this.exitSimulation();
    }
    if (this.ws === 'analyze') this.leaveAnalyze();
    if (!this.expSel.exp || !this.session.model.experiments.some((x) => x.id === this.expSel.exp)) this.expSel = { exp: this.session.model.experiments.length ? this.session.model.experiments[0].id : null, list: null, index: -1 };
    this.showWorkspace('experiments');
    this.updateModeBanner();
    const first = this.doc.querySelector('#ws-exp-left .ex-item[aria-pressed="true"], #ex-new') as HTMLElement | null;
    if (first) first.focus();
    return true;
  }

  /** Leave Experiments (Exit, Esc): a running experiment is stopped after a confirmation; its results stay for this model. */
  async exitExperiments(): Promise<boolean> {
    if (this.ws !== 'experiments') return false;
    if (this.expRunner) {
      if (!(await this.confirmEnd('Stop and exit', 'Stop the running experiment?', 'The run stops where it is; what it observed so far is kept with this model.'))) return false;
      this.stopExperiment();
    }
    this.showWorkspace('edit');
    this.updateModeBanner();
    (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    return true;
  }

  /** The workspace's Exit (the banner's button, the command). */
  async exitWorkspace(): Promise<boolean> {
    if (this.ws === 'experiments') return this.exitExperiments();
    if (this.ws === 'analyze') return this.exitAnalyze();
    if (this.ws === 'simulate') return this.exitSimulation();
    return false;
  }

  // ------------------------------------------------------------ the Analyze workspace

  /** the tool in front in Analyze, and its selected result item ('' none: the tool's default) */
  private anTool: AnalyzeTool = 'trace';
  private anSel = '';
  /** a focus entered from Analyze (cleared when Analyze is left; a focus from elsewhere is not Analyze's) */
  private anFocus = false;
  /** the root listeners of the tool's body (delegated): forwarded from the panels it is laid out in */
  private anRoot: Array<{ type: string; fn: (e: Event) => void }> = [];

  /** The tool in front in Analyze ('' when Analyze is not). */
  analyzeTool(): AnalyzeTool | '' {
    return this.ws === 'analyze' ? this.anTool : '';
  }

  /** The selected result item of the tool in front (tests). */
  analyzeSelection(): string {
    return this.anSel;
  }

  /** A root listener of a tool's body: on the body, and forwarded from the Analyze panels when it is laid out there. */
  private onRoot(body: HTMLElement, type: string, fn: (e: Event) => void): void {
    body.addEventListener(type, fn);
    this.anRoot.push({ type, fn });
  }

  /**
   * Enter Analyze with a tool (or switch to it there). From a simulation, the
   * simulation pauses and stays: its snapshot is what Analyze can read; Exit
   * Analyze returns to it and resumes it. From Experiments, a running
   * experiment goes on. Entering changes nothing in the model.
   */
  private showAnalyze(tool: AnalyzeTool): void {
    if (!this.session) return;
    const switching = this.ws === 'analyze' && this.anTool !== tool;
    if (switching) this.leaveTool(this.anTool);
    if (this.ws !== 'analyze') {
      this.analyzeFrom = this.ws;
      if ((this.ws === 'simulate' || this.ws === 'experiments') && this.simCtl && this.simCtl.playState() === 'Playing') this.simCtl.setPlaying(false, 'analyze');
      this.closeToolWindow();
    }
    if (switching || this.anTool !== tool) this.anSel = '';
    this.anTool = tool;
    if (this.ws !== 'analyze') this.showWorkspace('analyze');
    else this.renderAnalyzeWs();
    this.updateModeBanner();
  }

  /** What a tool leaves when another takes its place: the trace's path, the report's background work. */
  private leaveTool(tool: AnalyzeTool): void {
    if (tool === 'trace' && this.traceRun) this.exitTrace();
    if (tool === 'spof') this.stopSpofJob();
  }

  /** Analyze's overlays and work are cleared (the trace's path, a focus entered here, the report's background work). */
  private leaveAnalyze(): void {
    this.leaveTool('trace');
    this.leaveTool('spof');
    if (this.anFocus && this.session && this.session.state.focus) this.exitFocus();
    this.anFocus = false;
    this.anSel = '';
  }

  /** Exit Analyze: its overlays cleared; back to where it was entered from (a paused simulation resumes). */
  async exitAnalyze(): Promise<boolean> {
    if (this.ws !== 'analyze') return false;
    this.leaveAnalyze();
    const back: Workspace = this.analyzeFrom === 'simulate' && this.simCtl && !this.simCtl.experiment ? 'simulate' : this.analyzeFrom === 'experiments' ? 'experiments' : 'edit';
    this.analyzeFrom = 'edit';
    this.showWorkspace(back);
    if ((back === 'simulate' || back === 'experiments') && this.simCtl && this.simCtl.pausedBy === 'analyze') this.simCtl.setPlaying(true);
    this.updateModeBanner();
    (this.doc.getElementById('canvas') as unknown as HTMLElement).focus();
    return true;
  }

  /** Escape in Analyze: a selected result item is let go first (true: it was). */
  private anEscape(): boolean {
    if (this.anSel) {
      this.anSel = '';
      this.renderAnalyzeWs();
      return true;
    }
    return false;
  }

  /** The Analyze banner's line: the tool, what it was computed on, that nothing is changed. */
  private anNoteLine(): string {
    const t = ANALYZE_TOOLS.find((x) => x.id === this.anTool) as { label: string };
    const snap = this.simulation && this.anSource === 'snapshot' ? 'a snapshot of the simulation (paused while Analyze is in front)' : 'the configured model';
    return `Analyze: ${t.label} — on ${snap}. The model is unchanged; nothing is sent.`;
  }

  /** The diagram's marks of Analyze: the selected item's objects (a layer's, a network's, a candidate's, an expectation's). */
  private anMarks(): Map<string, string> | null {
    if (this.ws !== 'analyze' || !this.anSelRefs.length) return null;
    const out = new Map<string, string>();
    for (const r of this.anSelRefs) out.set(r, 'ws-target ws-sel');
    return out;
  }

  /** the selected item's objects (set when the panels are drawn) */
  private anSelRefs: string[] = [];

  /** Select a result item of the tool in front: its evidence on the right, its objects marked. */
  selectAnalysisItem(key: string): void {
    this.anSel = key;
    this.renderAnalyzeWs();
    this.applyHighlight();
    const r = this.doc.getElementById('an-detail');
    if (r) r.focus({ preventScroll: true });
  }

  /** Draw the Analyze panels again (after an edit, a result, a selection): the tool's body laid out in them. */
  private renderAnalyzeWs(only?: 'results'): void {
    if (this.ws !== 'analyze' || !this.session || !this.mdoc) return;
    const doc = this.doc;
    this.anRoot = [];
    const parts = this.analyzeParts();
    // only the results changed (a filter typed, a column sorted): the request's controls stay as they are (the caret, the
    // focus); what they say of the results (a status line, a toggle's state) is taken over in place
    if (only === 'results') {
      const left = doc.getElementById('ws-an-left');
      for (const n of parts.left) {
        if (!(n instanceof Element)) continue;
        for (const e of [n].concat(Array.from(n.querySelectorAll('[id], [data-addr-all]')))) {
          const sel = e.id ? '#' + e.id : e.hasAttribute('data-addr-all') ? '[data-addr-all]' : '';
          const cur = sel && left ? (left.querySelector(sel) as HTMLElement | null) : null;
          if (!cur || e.children.length || cur === doc.activeElement) continue;
          if (cur.textContent !== e.textContent) cur.textContent = e.textContent;
          for (const a of ['data-addr-all']) if (e.hasAttribute(a)) cur.setAttribute(a, e.getAttribute(a) as string);
        }
      }
      const wrap = (kids: Node[], cls: string): HTMLElement => {
        const w = el(doc, 'div', { class: cls, 'data-an-root': this.anTool });
        for (const k of kids) w.appendChild(k);
        return w;
      };
      this.replacePanel('ws-an-dock', wrap(parts.bottom, 'an-dock'));
      this.replacePanel('ws-an-right', wrap(parts.right, 'an-right'));
      this.applyHighlight();
      return;
    }
    const nav = el(doc, 'div', { class: 'an-tools', role: 'radiogroup', 'aria-label': 'Analysis tool' });
    for (const t of ANALYZE_TOOLS) {
      const on = t.id === this.anTool;
      const b = el(doc, 'button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', 'data-an-tool': t.id, title: t.help }, [t.label]);
      b.addEventListener('click', () => this.runCommand(t.command));
      nav.appendChild(b);
    }
    nav.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].indexOf(k) < 0) return;
      e.preventDefault();
      const i = ANALYZE_TOOLS.findIndex((x) => x.id === this.anTool);
      const n = ANALYZE_TOOLS[(i + (k === 'ArrowDown' || k === 'ArrowRight' ? 1 : ANALYZE_TOOLS.length - 1)) % ANALYZE_TOOLS.length];
      this.runCommand(n.command);
      const b = this.doc.querySelector(`[data-an-tool="${n.id}"]`) as HTMLElement | null;
      if (b) b.focus();
    });
    const wrap = (kids: Node[], cls: string): HTMLElement => {
      const w = el(doc, 'div', { class: cls, 'data-an-root': this.anTool });
      for (const k of kids) w.appendChild(k);
      return w;
    };
    this.replacePanel('ws-an-left', wrap([nav as Node].concat(parts.left), 'an-left'));
    this.replacePanel('ws-an-dock', wrap(parts.bottom, 'an-dock'));
    this.replacePanel('ws-an-right', wrap(parts.right, 'an-right'));
    this.applyHighlight();
    this.updateModeBanner();
  }

  /**
   * The tool's body, laid out: its request (context, form, filters) on the
   * left, its results (verdict, tables, coverage, exports) at the bottom,
   * the selected item's evidence on the right.
   */
  private analyzeParts(): { left: Node[]; bottom: Node[]; right: Node[] } {
    const doc = this.doc;
    const kids = (e: Element): Element[] => Array.from(e.children);
    const hint = (text: string): HTMLElement => el(doc, 'p', { class: 'muted small', id: 'an-detail', tabindex: '-1' }, [text]);
    this.anSelRefs = [];
    switch (this.anTool) {
      case 'trace': {
        const body = this.traceBody();
        const result = body.querySelector('.trace-result');
        const left = kids(body).filter((x) => x !== result);
        if (!result) return { left, bottom: [el(doc, 'p', { class: 'muted' }, ['Trace a communication: its verdict, the layers it checked and its paths appear here.'])], right: [hint('The evidence of a layer appears here: select it in the results.')] };
        // the layers' evidence goes to the right, for the layer selected (the first that is not satisfied, else the first)
        const layers = Array.from(result.querySelectorAll('ul.comm-layers > li[data-layer]')) as HTMLElement[];
        const first = layers.find((l) => !l.classList.contains('v-satisfied')) || layers[0];
        const sel = this.anSel && this.anSel.indexOf('layer:') === 0 && layers.some((l) => 'layer:' + l.getAttribute('data-layer') === this.anSel) ? this.anSel : first ? 'layer:' + first.getAttribute('data-layer') : '';
        let right: Node[] = [hint('Select a layer to see its evidence.')];
        for (const l of layers) {
          const key = 'layer:' + l.getAttribute('data-layer');
          const ev = l.querySelector('details.layer-ev');
          if (ev) ev.remove();
          const b = el(doc, 'button', { type: 'button', class: 'mini an-pick', 'data-an-item': key, 'aria-pressed': key === sel ? 'true' : 'false', 'aria-controls': 'an-detail' }, ['Evidence']);
          b.addEventListener('click', () => this.selectAnalysisItem(key));
          l.appendChild(doc.createTextNode(' '));
          l.appendChild(b);
          if (key === sel) {
            l.classList.add('an-selected');
            const d = el(doc, 'section', { id: 'an-detail', tabindex: '-1', 'aria-label': 'Evidence' }, [el(doc, 'h3', {}, [(l.querySelector('strong') as Element).textContent || 'Layer']), el(doc, 'p', { class: 'small' }, [Array.from(l.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()])]);
            if (ev) for (const c of Array.from(ev.childNodes).slice(1)) d.appendChild(c);
            else d.appendChild(el(doc, 'p', { class: 'muted small' }, ['No further evidence for this layer.']));
            const refs = Array.from(d.querySelectorAll('[data-ref]')).map((x) => x.getAttribute('data-ref') as string);
            this.anSelRefs = refs;
            right = [d];
          }
        }
        return { left, bottom: [result], right };
      }
      case 'addressing': {
        const body = this.addressingWindowBody();
        const inner = body.querySelector('.addr') as HTMLElement;
        const tables = inner.querySelector('.addr-tables') as HTMLElement;
        const left = kids(body).filter((x) => x !== inner).concat(kids(inner).filter((x) => x !== tables));
        // a network (its row) selected: its members, allocation and free ranges on the right
        const run = this.addrRun as NonNullable<App['addrRun']>;
        let right: Node[] = [hint('Select a network (its row) to see its members, its allocation and the unallocated ranges.')];
        for (const row of Array.from(tables.querySelectorAll('tr.addr-row')) as HTMLElement[]) {
          const vrf = (row.closest('[data-addr-vrf]') as Element).getAttribute('data-addr-vrf') || '';
          const key = `net:${vrf}|${row.getAttribute('data-addr-net')}`;
          row.setAttribute('data-an-item', key);
          row.tabIndex = 0;
          if (key === this.anSel) {
            row.classList.add('an-selected');
            row.setAttribute('aria-current', 'true');
            const g = run.ov.vrfs.find((x) => x.vrf === vrf);
            const n = g ? g.networks.find((x) => x.id === row.getAttribute('data-addr-net')) : undefined;
            if (n) {
              right = [el(doc, 'section', { id: 'an-detail', tabindex: '-1', 'aria-label': `Network ${n.text}` }, [el(doc, 'h3', {}, [`${n.label} — ${n.text}`]), networkDetail(doc, n)])];
              this.anSelRefs = ['network:' + n.id].concat(n.members.map((m) => 'device:' + m.device));
            }
          }
        }
        this.anRoot.push({
          type: 'click',
          fn: (e) => {
            const t = e.target as Element;
            if (t.closest('button, a, input, [data-addr-goto]')) return;
            const row = t.closest('tr[data-an-item]');
            if (row) this.selectAnalysisItem(row.getAttribute('data-an-item') as string);
          },
        });
        this.anRoot.push({
          type: 'keydown',
          fn: (e) => {
            const ke = e as KeyboardEvent;
            const row = (ke.target as Element).closest('tr[data-an-item]');
            if (row && (ke.key === 'Enter' || ke.key === ' ') && ke.target === row) {
              ke.preventDefault();
              this.selectAnalysisItem(row.getAttribute('data-an-item') as string);
            }
          },
        });
        return { left, bottom: [tables], right };
      }
      case 'spof': {
        const body = this.spofWindowBody();
        const tables = body.querySelector('.spof-tables') as HTMLElement;
        const prog = body.querySelector('#spof-progress') as HTMLElement;
        const limits = Array.from(body.children).find((x) => x.classList.contains('an-limits')) || null;
        const wi = body.querySelector('.wi-section') as HTMLElement;
        const result = wi ? wi.querySelector('#wi-result') : null;
        if (result) result.remove();
        const left = kids(body).filter((x) => x !== tables && x !== prog && x !== limits);
        const right: Node[] = result ? [el(doc, 'section', { id: 'an-detail', tabindex: '-1', 'aria-label': 'What if' }, [el(doc, 'h3', {}, ['What if: the result']), result])] : [hint('What if a candidate fails: its What if button, or the What if form, shows the comparison here.')];
        if (this.wiRun) this.anSelRefs = this.wiRun.result.refs.slice();
        return { left, bottom: ([prog, tables, limits] as Array<Element | null>).filter((x): x is Element => !!x), right };
      }
      case 'checks': {
        const body = this.designWindowBody();
        const intro = body.firstElementChild as Element;
        const bar = body.querySelector('.an-ctx') || intro.nextElementSibling;
        const secs = Array.from(body.querySelectorAll(':scope > section.dc-section')) as HTMLElement[];
        const exp = secs[0];
        const form = exp ? exp.querySelector('form.dc-form, .dc-form') : null;
        const tools = exp ? exp.querySelector(':scope > .tf-actions') : null;
        const status = exp ? exp.querySelector('#dc-status') : null;
        const left: Node[] = [intro, bar].filter((x): x is Element => !!x);
        if (tools) left.push(tools);
        if (status) left.push(status);
        let right: Node[] = [hint('Select an expectation (Details) to see its evidence: its layers, the failure applied, the findings where it stops.')];
        if (form) {
          form.remove();
          right = [el(doc, 'section', { id: 'an-detail', tabindex: '-1', 'aria-label': 'Expectation' }, [form])];
        }
        // each expectation's details: the selected one's on the right; the others stay out of the table
        for (const row of Array.from(body.querySelectorAll('tr.dc-detail')) as HTMLElement[]) {
          const id = row.id.replace(/^dc-d-/, '');
          const key = 'exp:' + id;
          if (key === this.anSel && !form) {
            const cell = row.querySelector('td') as HTMLElement;
            right = [el(doc, 'section', { id: 'an-detail', tabindex: '-1', 'aria-label': 'Evidence' }, [el(doc, 'h3', {}, [(body.querySelector(`tr[data-exp="${id}"] .dc-name`) as Element || { textContent: id }).textContent || id])].concat(Array.from(cell.childNodes) as HTMLElement[]))];
            const r = this.dcRun ? this.dcRun.run.results.find((x) => x.id === id) : undefined;
            this.anSelRefs = r ? r.refs.slice() : [];
            const tr = body.querySelector(`tr[data-exp="${id}"]`);
            if (tr) tr.classList.add('an-selected');
          }
          row.remove();
        }
        for (const t of Array.from(body.querySelectorAll('[data-dc="toggle"]')) as HTMLElement[]) {
          const on = 'exp:' + t.getAttribute('data-id') === this.anSel;
          t.setAttribute('aria-expanded', on ? 'true' : 'false');
          t.setAttribute('aria-controls', 'an-detail');
          t.textContent = 'Details';
        }
        const bottom: Node[] = [];
        if (exp) for (const c of Array.from(exp.children)) if (c !== tools && c !== status) bottom.push(c);
        for (const s2 of secs.slice(1)) bottom.push(s2);
        return { left, bottom, right };
      }
      case 'focus': {
        const body = this.focusBody();
        const s = this.session as Session;
        const shown = s.state.focus ? Array.from(s.shownDevices()).sort() : [];
        const bottom: Node[] = [el(doc, 'p', { class: 'small', role: 'status', id: 'an-focus-shown' }, [s.state.focus ? `${this.focusNote()}: ${shown.length} device${shown.length === 1 ? '' : 's'} shown.` : 'Focus is off: the complete diagram is shown.'])];
        if (shown.length) bottom.push(el(doc, 'p', { class: 'small muted' }, [shown.slice(0, 60).join(', ') + (shown.length > 60 ? ' …' : '')]));
        const sel = s.state.selected;
        const right: Node[] = sel ? [el(doc, 'section', { id: 'an-detail', tabindex: '-1', 'aria-label': 'Selection' }, [el(doc, 'h3', {}, [this.refName(sel)]), el(doc, 'p', { class: 'small muted' }, [focusContexts(s.model, sel).length ? `Contextual focus: ${focusContexts(s.model, sel).map((c) => c.label).join(', ')}.` : 'No contextual focus for it.'])])] : [hint('Select an object in the diagram or the object list to focus on it.')];
        return { left: [body], bottom, right };
      }
    }
    return { left: [], bottom: [], right: [] };
  }

  // ------------------------------------------------------------ experiments

  /** the entry selected in the Experiments workspace: the only selection state of its panels */
  private expSel: ExpSelection = { exp: null, list: null, index: -1 };
  /** a step's device chosen before its interface or application (a draft: not in the model) */
  private expDraft = new Map<string, string>();
  private expNote = '';
  /** the runs and comparisons of this model's experiments (this session; never saved): cleared when another model is loaded */
  private expRuns = new Map<string, ExpRunResult[]>();
  private expCompare = new Map<string, RunCompare>();
  private expRunner: ExpSlot | null = null;
  /** the panels' last drawing of a run's progress (progress is drawn at most every 250 ms) */
  private expDrawn = 0;

  /** The runs of an experiment so far (the newest last). */
  experimentRuns(id: string): ExpRunResult[] {
    return this.expRuns.get(id) || [];
  }

  /** Is an experiment running? Its id, or null. */
  experimentRunning(): string | null {
    return this.expRunner ? this.expRunner.id : null;
  }

  /** The Experiments workspace's selection (tests). */
  experimentSelection(): ExpSelection {
    return { ...this.expSel };
  }

  /** Select an experiment and, optionally, one of its steps (the panels and the diagram follow). */
  selectExperimentStep(sel: ExpSelection): void {
    this.expSel = sel;
    this.expNote = '';
    // the step's target in the diagram
    const s = this.session;
    const e = s && sel.exp ? s.model.experiments.find((x) => x.id === sel.exp) : undefined;
    const step = e && sel.list ? (sel.list === 'actions' ? e.actions[sel.index] : e.observations[sel.index]) : undefined;
    const def = step ? (sel.list === 'actions' ? actionDef((step as ExpAction).do) : observeDef((step as ExpObservation).of)) : undefined;
    const refs = s && step && def ? targetRefs(s.model, def.target, step.target, e) : [];
    this.expFocusRefs = new Set(refs);
    this.renderExperimentsWs();
    this.applyHighlight();
  }

  /** the selected step's targets (marked in the diagram) */
  private expFocusRefs = new Set<string>();

  /**
   * Run the selected (or the given) experiment: a new runner from its
   * defined start, played through the diagram (the simulation's own pacing,
   * dots and inspector, only the experiment's traffic shown), or, without a
   * page to draw on or when asked (`headless`), advanced in slices of the
   * page's time. Both reach the same result: every step is an event of the
   * simulation's clock. Stop cancels it. A runner replaced, stopped or
   * belonging to a model that is no longer loaded is never advanced again
   * and its result is never kept (its slot, compared on every tick).
   */
  runExperiment(id: string | null = this.expSel.exp, opts: { headless?: boolean } = {}): boolean {
    const s = this.session;
    if (!s || !id) return false;
    const e = s.model.experiments.find((x) => x.id === id);
    if (!e || e.problems.length) return false;
    if (this.expRunner) this.stopExperiment();
    // a simulation of the user's ends first (the transitions ask before; one simulation at a time)
    if (this.simulation) this.exitSimulation();
    const runner = new ExperimentRunner(s.model, e, modelFingerprint(s.model));
    const slot: ExpSlot = { runner, id, doc: this.mdoc, ctl: null };
    this.expRunner = slot;
    this.expCompare.delete(id);
    runner.prepare();
    const win = this.doc.defaultView;
    if (!win || runner.over) {
      runner.runAll();
      this.finishExperiment(slot);
      return true;
    }
    if (!opts.headless) {
      this.playExperiment(slot);
      this.renderExperimentsWs();
      return true;
    }
    const tick = (): void => {
      if (this.expRunner !== slot) return;
      if (this.mdoc !== slot.doc) {
        // another model: this run is not its (nothing of it is kept)
        slot.runner.cancel();
        this.expRunner = null;
        return;
      }
      const done = runner.step(30);
      if (done) this.finishExperiment(slot);
      else {
        const now = Date.now();
        if (now - this.expDrawn > 250) {
          this.expDrawn = now;
          this.renderExperimentsDock();
        }
        win.setTimeout(tick, 0);
      }
    };
    this.renderExperimentsWs();
    win.setTimeout(tick, 0);
    return true;
  }

  /**
   * Play a prepared run in the diagram: the simulation controller of
   * Simulate with the experiment's simulation, only its traffic shown, its
   * clock stopping at the end; no panels of its own (the bottom panel shows
   * the run). Its ticks advance nothing themselves: they draw the progress
   * and end the run when its last event has happened.
   */
  private playExperiment(slot: ExpSlot): void {
    const self = this;
    const r = slot.runner;
    const ctl = new SimController(
      {
        doc: this.doc,
        model: () => (self.session as Session).model,
        scene: () => self.viewport.querySelector('.scene'),
        view: () => (self.session ? self.session.state.view : 'physical'),
        reduce: () => self.reducedMotion(),
        changed: () => self.simChanged(),
        rectOf: (ref) => {
          const n = self.viewport.querySelector(`.node[data-ref="${ref.replace(/["\\]/g, '\\$&')}"]`);
          if (!n) return null;
          const b = n.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        },
        toast: (t) => self.toast(t),
        tick: () => self.experimentTick(slot),
        selected: () => (self.session ? self.session.state.selected : null),
        select: (ref) => self.select(ref, !!ref),
      },
      { simulation: r.simulation, experiment: { relevant: (f) => r.relevance.classify(f) !== null, until: () => r.endTime, notable: (t) => r.notable(t) } },
    );
    const stop = ctl.stop.bind(ctl);
    ctl.stop = (): void => {
      stop();
      if (self.simCtl === ctl) self.simCtl = null;
      if (self.session && self.session.setPlacement(null)) self.render();
      self.doc.body.removeAttribute('data-sim');
    };
    slot.ctl = ctl;
    this.simCtl = ctl;
    this.doc.body.setAttribute('data-sim', 'on');
    this.startSimulation(ctl);
  }

  /** A playing run's tick (about four a second): its end, or its progress drawn. */
  private experimentTick(slot: ExpSlot): void {
    if (this.expRunner !== slot) return;
    if (this.mdoc !== slot.doc) {
      this.stopExperiment();
      return;
    }
    if (slot.runner.over) {
      this.finishExperiment(slot);
      return;
    }
    // the panel again when something it lists changed (a step, a verdict, what it waits for, play / pause); else the progress only
    const r = slot.runner.result();
    const c = slot.ctl;
    const key = `${r.actions.map((x) => x.state).join()}|${r.observations.length}|${slot.runner.status().join('|')}|${c ? c.playing : ''}|${c ? c.speed : ''}`;
    if (key !== this.expTickKey) {
      this.expTickKey = key;
      this.renderExperimentsDock();
      this.applyHighlight();
    } else {
      const p = this.doc.getElementById('ex-progress');
      const t = `${c ? (c.playing ? 'Playing' : 'Paused') : 'Running'} on scenario time: t = ${(Math.max(0, r.reached) / 1000).toFixed(1)} s of ${durText(r.duration)}`;
      if (p && p.textContent !== t) p.textContent = t;
      const bar = this.doc.getElementById('ex-progress-bar') as HTMLProgressElement | null;
      if (bar) bar.value = Math.max(0, Math.min(r.duration, r.reached));
      // (the action in progress is marked for a few seconds of scenario time)
      if (this.expActKey !== this.expActNow(r)) this.applyHighlight();
    }
    this.updateModeBanner();
  }

  /** what the panels last showed of a playing run (redrawn when it changes) */
  private expTickKey = '';
  private expActKey = '';

  /** The actions submitted in the last 3 s of scenario time (marked in the diagram as the action in progress). */
  private expActNow(r: ExpRunResult): string {
    return r.actions.filter((x) => (x.state === 'submitted' || x.state === 'undone' || x.state === 'waiting') && r.reached - x.at <= 3000 && r.reached >= x.at).map((x) => x.index).join(',');
  }

  /** Run an experiment to its end at once (the self-test, small models). */
  runExperimentNow(id: string | null = this.expSel.exp): ExpRunResult | null {
    if (!this.runExperiment(id, { headless: true }) || !this.expRunner) return null;
    const slot = this.expRunner;
    slot.runner.runAll();
    this.finishExperiment(slot);
    return slot.runner.result();
  }

  /** Skip to the result: the rest of a playing run at once (the same events, not shown). */
  skipExperiment(): boolean {
    const slot = this.expRunner;
    if (!slot) return false;
    slot.runner.runAll();
    this.finishExperiment(slot);
    return true;
  }

  /** Play or pause a playing run (its clock); false when none plays. */
  pauseExperiment(on: boolean): boolean {
    const slot = this.expRunner;
    if (!slot || !slot.ctl) return false;
    slot.ctl.setPlaying(!on, 'user');
    this.renderExperimentsDock();
    return true;
  }

  /** The runner of the run in progress (tests: its relevance and status). */
  experimentRunner(): ExperimentRunner | null {
    return this.expRunner ? this.expRunner.runner : null;
  }

  /** The playback's controller while a run plays (tests, the dock's speed). */
  experimentPlayback(): SimController | null {
    return this.expRunner ? this.expRunner.ctl : null;
  }

  /** The end of a playing run's display: its dots and states go, the model's state is shown again. */
  private endPlayback(slot: ExpSlot): void {
    if (slot.ctl && this.simulation === slot.ctl) this.exitSimulation();
    else if (slot.ctl) slot.ctl.stop();
    slot.ctl = null;
  }

  private finishExperiment(slot: ExpSlot): void {
    if (this.expRunner !== slot || this.mdoc !== slot.doc) return;
    this.expRunner = null;
    this.endPlayback(slot);
    const list = (this.expRuns.get(slot.id) || []).concat([slot.runner.result()]).slice(-5);
    this.expRuns.set(slot.id, list);
    this.renderExperimentsWs();
    this.applyHighlight();
    this.toast(`Experiment ${slot.id}: ${slot.runner.result().summary}.`);
  }

  /** Stop the running experiment: it keeps what it observed and says what was not reached; nothing of it runs on. */
  stopExperiment(): boolean {
    const slot = this.expRunner;
    if (!slot) return false;
    slot.runner.cancel();
    this.expRunner = null;
    this.endPlayback(slot);
    if (this.mdoc === slot.doc) {
      const list = (this.expRuns.get(slot.id) || []).concat([slot.runner.result()]).slice(-5);
      this.expRuns.set(slot.id, list);
    }
    this.renderExperimentsWs();
    this.applyHighlight();
    return true;
  }

  /** Reset an experiment's results (the runs of this session): the next Run starts the history again. */
  resetExperiment(id: string | null = this.expSel.exp): boolean {
    if (!id || (this.expRunner && this.expRunner.id === id)) return false;
    this.expRuns.delete(id);
    this.expCompare.delete(id);
    this.renderExperimentsWs();
    this.applyHighlight();
    return true;
  }

  /** Compare an experiment's last two runs. */
  compareExperiment(id: string | null = this.expSel.exp): boolean {
    const runs = id ? this.expRuns.get(id) || [] : [];
    if (!id || runs.length < 2) return false;
    this.expCompare.set(id, compareRuns(runs[runs.length - 2], runs[runs.length - 1]));
    this.renderExperimentsWs();
    return true;
  }

  /** Keep the traced communication as an experiment: a send and the observation of its delivery (one undo step; nothing runs). */
  async traceToExperiment(): Promise<boolean> {
    const r = this.traceRun;
    const d = this.mdoc;
    if (!r || !r.identity || !d || this.editLock() || !r.handoff || r.handoff.kind !== 'send') return false;
    const req = r.identity.request;
    const send: Array<[string, string]> = [['id', 'send'], ['at', '10s'], ['do', 'send'], ['target', req.from]];
    if (req.to) send.push(['to', req.to]);
    if (req.service) send.push(['service', req.service]);
    else if (r.identity.service && r.identity.service.proto !== 'icmp') send.push(['service', `${r.identity.service.proto}/${r.identity.service.port}`]);
    const expect = r.check.verdict === 'violated' ? 'failed' : 'delivered';
    const name = `${req.from} to ${req.to || 'its peer'}`;
    let k: number;
    try {
      k = d.addExperiment(name, '60s', { actions: [send], observe: [[['of', 'send'], ['target', 'send'], ['within', '10s'], ['expect', expect]]] });
    } catch (e) {
      this.refusedEdit(e);
      return false;
    }
    this.afterEdit('The experiment was added: press Run to run it.');
    const e = (this.session as Session).model.experiments[k];
    if (e) this.expSel = { exp: e.id, list: null, index: -1 };
    return this.enterExperiments();
  }

  private expView(): ExpWsView {
    const s = this.session as Session;
    const d = this.mdoc as ModelDoc;
    const run = this.expRunner;
    return {
      model: s.model,
      sel: this.expSel,
      index: new Map<string, number>(d.analysisEntries('experiments').map((x) => [x.id, x.index] as [string, number])),
      runs: this.expRuns,
      running: run ? { id: run.id, reached: run.runner.result().reached, duration: run.runner.result().duration, settle: run.runner.result().settle, playback: !!run.ctl, playing: !!run.ctl && run.ctl.playing, speed: run.ctl ? run.ctl.speed : 1, status: run.runner.status(), live: run.runner.result() } : null,
      speeds: SPEEDS,
      compare: this.expCompare,
      outdated: (r) => r.fingerprint !== modelFingerprint(s.model),
      locked: this.editLock(),
      scope: (e) => {
        const sc = experimentScope(s.model, e);
        return { run: sc.devices.size, total: s.model.devices.length, added: sc.included.map((x) => `${x.device}: ${x.why}`), boundary: sc.boundary.length, cannot: sc.cannot, caveats: sc.caveats };
      },
      draft: this.expDraft,
      note: this.expNote,
      selected: s.state.selected,
    };
  }

  private expActions(): ExpWsActions {
    const edit = (f: () => void, note?: string): boolean => {
      try {
        f();
      } catch (e) {
        this.refusedEdit(e);
        return false;
      }
      this.afterEdit(note);
      return true;
    };
    const d = (): ModelDoc => this.mdoc as ModelDoc;
    const k = (): number => {
      const e = this.expSel.exp ? d().analysisEntries('experiments').find((x) => x.id === this.expSel.exp) : undefined;
      return e ? e.index : -1;
    };
    return {
      newExperiment: () => {
        const n = (this.session as Session).model.experiments.length + 1;
        let idx = -1;
        if (!edit(() => (idx = d().addExperiment(`Experiment ${n}`, '60s')), 'An experiment was added: add its actions and observations.')) return;
        const e = (this.session as Session).model.experiments[idx];
        if (e) this.selectExperimentStep({ exp: e.id, list: null, index: -1 });
        const name = this.doc.getElementById('ex-name') as HTMLInputElement | null;
        if (name) name.focus();
      },
      select: (sel) => this.selectExperimentStep(sel),
      set: (path, kind, value) => {
        const p = JSON.parse(path) as Path;
        this.expNote = '';
        edit(() => (kind === 'int' ? d().setInteger(p, value) : d().setText(p, value)));
      },
      setDuration: (path, ms) => {
        // the model keeps one canonical value; the unit shown is the control's
        const p = JSON.parse(path) as Path;
        this.expNote = '';
        edit(() => d().setText(p, ms === null ? '' : durationYaml(ms)));
      },
      setStart: (start) => void edit(() => d().setExperimentStart(k(), start)),
      setKind: (list, n, kind) => {
        let cleared: string[] = [];
        if (!edit(() => (cleared = d().setStepKind(k(), list, n, kind)))) return;
        const def = list === 'actions' ? actionDef(kind) : observeDef(kind);
        this.expNote = cleared.length ? `Cleared: ${cleared.join(', ')} — ${def ? def.label : kind} takes ${cleared.length === 1 ? 'it' : 'them'} differently or not at all.` : '';
        this.renderExperimentsWs();
      },
      addStep: (list, kind, target) => {
        let n = -1;
        if (!edit(() => (n = d().addStep(k(), list, kind, target)))) return;
        this.selectExperimentStep({ exp: this.expSel.exp, list, index: n });
        const kindSel = this.doc.getElementById('ex-target') || this.doc.getElementById('ex-target-dev') || this.doc.getElementById('ex-kind');
        if (kindSel) (kindSel as HTMLElement).focus();
      },
      moveStep: (list, n, delta) => {
        if (edit(() => d().moveStep(k(), list, n, delta))) this.selectExperimentStep({ exp: this.expSel.exp, list, index: n + delta });
      },
      deleteStep: (list, n) => {
        if (!edit(() => d().remove(['experiments', k(), list, n], 'Delete step'))) return;
        const e = (this.session as Session).model.experiments.find((x) => x.id === this.expSel.exp);
        const left = e ? (list === 'actions' ? e.actions.length : e.observations.length) : 0;
        this.selectExperimentStep({ exp: this.expSel.exp, list: left ? list : null, index: left ? Math.min(n, left - 1) : -1 });
      },
      setAfter: (list, n, a) => void edit(() => d().setStepAfter(k(), list, n, a)),
      setScope: (kind, value) => void edit(() => d().setExperimentScope(k(), kind, value)),
      setDraft: (key, dev) => {
        // a device alone is a draft: the interface or application completes the target
        this.expDraft.set(key, dev);
        const [, list, n] = key.split('|');
        const p = ['experiments', k(), list, Number(n), 'target'];
        const cur = d().text(p) || '';
        if (cur && !cur.startsWith(dev + ':') && !cur.startsWith(dev + '/')) edit(() => d().setText(p, ''));
        else this.renderExperimentsWs();
        const own = this.doc.getElementById('ex-target-own') as HTMLElement | null;
        if (own) own.focus();
      },
      deleteExperiment: (id) => void this.removeExperiment(id),
      run: () => void this.runExperiment(),
      pause: (on) => void this.pauseExperiment(on),
      speed: (x) => {
        const c = this.experimentPlayback();
        if (c) c.setSpeed(x);
        this.renderExperimentsDock();
      },
      skip: () => void this.skipExperiment(),
      stop: () => void this.stopExperiment(),
      reset: () => void this.resetExperiment(),
      compare: () => void this.compareExperiment(),
      copy: () => {
        const s = this.session as Session;
        const id = this.expSel.exp;
        const e = s.model.experiments.find((x) => x.id === id);
        const runs = id ? this.expRuns.get(id) || [] : [];
        if (!e || !runs.length) return;
        void this.copyText(experimentText({ title: s.model.title, version: this.appVersion() }, e, runs[runs.length - 1], this.expCompare.get(e.id)), 'The experiment’s result was copied as text.');
      },
      showRef: (ref) => {
        this.select(ref, true);
        this.renderExperimentsWs();
      },
    };
  }

  /** Draw the Experiments panels again, keeping the keyboard focus on the same control and each panel's scroll. */
  private renderExperimentsWs(): void {
    if (this.ws !== 'experiments' || !this.session || !this.mdoc) return;
    const v = this.expView();
    const act = this.expActions();
    this.replacePanel('ws-exp-left', experimentsLeft(this.doc, v, act));
    this.replacePanel('ws-exp-right', experimentsRight(this.doc, v, act));
    this.replacePanel('ws-exp-dock', experimentsDock(this.doc, v, act));
    this.updateModeBanner();
  }

  private renderExperimentsDock(): void {
    if (this.ws !== 'experiments' || !this.session || !this.mdoc) return;
    this.replacePanel('ws-exp-dock', experimentsDock(this.doc, this.expView(), this.expActions()));
    this.updateModeBanner();
  }

  /** Replace a panel body's content, keeping the focus on the same control (by id or data attribute) and the scroll. */
  private replacePanel(id: string, content: HTMLElement): void {
    const box = this.doc.getElementById(id);
    if (!box) return;
    const a = this.doc.activeElement as HTMLElement | null;
    const key = a && box.contains(a) ? focusKey(a) : null;
    const scroller = box.closest('.sim-panel, .sim-dock') as HTMLElement | null;
    const scroll = scroller ? scroller.scrollTop : 0;
    const top = box.scrollTop;
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(content);
    box.scrollTop = top;
    if (scroller) scroller.scrollTop = scroll;
    if (key) {
      const t = findFocusKey(box, key);
      if (t) t.focus({ preventScroll: true });
    }
  }

  /** The diagram's marks of the Experiments workspace: the selected experiment's targets, the selected step's, and after a run each observation's verdict. */
  private expMarks(): Map<string, string> | null {
    const s = this.session;
    if (this.ws !== 'experiments' || !s || !this.expSel.exp) return null;
    const e = s.model.experiments.find((x) => x.id === this.expSel.exp);
    if (!e) return null;
    const out = new Map<string, string>();
    for (const r of experimentRefs(s.model, e)) out.set(r, 'ws-target');
    const runs = this.expRuns.get(e.id) || [];
    const playing = this.expRunner && this.expRunner.id === e.id ? this.expRunner.runner.result() : null;
    const last = playing || runs[runs.length - 1];
    if (playing) {
      // the action in progress (submitted or waiting in the last 3 s of scenario time)
      const now = this.expActNow(playing);
      this.expActKey = now;
      for (const k of now ? now.split(',').map(Number) : []) {
        const a = e.actions[k];
        const def = a ? actionDef(a.do) : undefined;
        for (const r of def ? targetRefs(s.model, def.target, a.target, e) : []) out.set(r, 'ws-act');
      }
    }
    if (last)
      for (const o of last.observations) {
        const def = observeDef(o.obs.of);
        for (const r of def ? targetRefs(s.model, def.target, o.obs.target, e) : []) out.set(r, o.outcome === 'satisfied' ? 'ws-ok' : o.outcome === 'violated' ? 'ws-bad' : out.get(r) || 'ws-target');
      }
    for (const r of this.expFocusRefs) out.set(r, (out.get(r) || 'ws-target') + ' ws-sel');
    return out;
  }

  /** The Experiments banner's line: the selected experiment and its state, said in words. */
  private expNoteLine(): string {
    const s = this.session;
    const e = s && this.expSel.exp ? s.model.experiments.find((x) => x.id === this.expSel.exp) : undefined;
    if (!e) return 'Experiments: nothing runs until Run; the model is edited as usual.';
    const runs = this.expRuns.get(e.id) || [];
    const run = this.expRunner && this.expRunner.id === e.id ? this.expRunner : null;
    const st = run ? `${run.ctl ? (run.ctl.playing ? 'playing' : 'paused') : 'running'} at t = ${(Math.max(0, run.runner.result().reached) / 1000).toFixed(1)} s, only its traffic shown` : e.problems.length ? 'not runnable yet' : runs.length ? 'run' : 'ready, not run';
    return `Experiments: ${e.name} — ${st}.${run ? "" : " Nothing runs until Run."}`;
  }

  /** Delete an experiment after a confirmation. */
  private async removeExperiment(id: string): Promise<void> {
    const d = this.mdoc;
    if (!d) return;
    const entry = d.analysisEntries('experiments').find((x) => x.id === id);
    if (!entry) return;
    const a = await this.dialog({ title: `Delete the experiment “${id}”?`, body: ['It is removed from the model with its actions and observations. You can undo this with Ctrl+Z.'], buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'go', kind: 'danger' }] });
    if (a !== 'go') return;
    if (this.expRunner && this.expRunner.id === id) this.stopExperiment();
    try {
      d.removeExperiment(entry.index);
    } catch (e) {
      this.refusedEdit(e);
      return;
    }
    this.expRuns.delete(id);
    this.expCompare.delete(id);
    const left = (this.session as Session).model.experiments;
    this.expSel = { exp: left.length ? left[Math.min(entry.index, left.length - 1)].id : null, list: null, index: -1 };
    this.afterEdit('The experiment was deleted.');
  }

  /** Delete an expectation after a confirmation. */
  private async removeExpectation(id: string): Promise<void> {
    const d = this.mdoc;
    if (!d) return;
    const entry = d.analysisEntries('expectations').find((x) => x.id === id);
    if (!entry) return;
    const a = await this.dialog({ title: `Delete the expectation “${id}”?`, body: ['The requirement is removed from the model. You can undo this with Ctrl+Z.'], buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'go', kind: 'danger' }] });
    if (a !== 'go') return;
    try {
      d.removeExpectation(entry.index);
    } catch (e) {
      this.refusedEdit(e);
      return;
    }
    this.dcOpen.delete(id);
    this.afterEdit('The expectation was deleted.');
    this.renderDesignChecks();
    const b = this.doc.getElementById('dc-add');
    if (b) b.focus();
  }

  // ------------------------------------------------------------ Help menu

  /** Is a Help dialog (User Manual or License) open? */
  get helpOpen(): string | null {
    const dlg = this.doc.getElementById('modal') as HTMLDialogElement;
    return dlg.open && dlg.classList.contains('help-dialog') ? dlg.getAttribute('data-help') : null;
  }

  /**
   * Help → User Manual and Help → License: a dialog with a × and a Close
   * button; Esc closes it too. The manual takes most of the window and
   * scrolls inside itself; it starts with the focus on its text, so the
   * keyboard scrolls it. Closing returns the focus to the Help menu button.
   * Neither needs a model, and neither changes one.
   */
  async openHelp(which: 'manual' | 'license'): Promise<void> {
    this.openMenu(null);
    const manual = which === 'manual';
    const done = this.dialog({
      title: manual ? 'NetAtlas User Manual' : 'License',
      body: [manual ? manualBody(this.doc) : licenseBody(this.doc)],
      buttons: [{ label: 'Close', value: 'close', kind: 'primary' }],
      className: 'help-dialog ' + (manual ? 'help-manual' : 'help-license'),
      closeButton: true,
      focus: manual ? '.manual' : undefined,
    });
    (this.doc.getElementById('modal') as HTMLElement).setAttribute('data-help', which);
    await done;
    const dlg = this.doc.getElementById('modal') as HTMLElement;
    dlg.removeAttribute('data-help');
    dlg.className = '';
    this.$('help-btn').focus();
  }

  // ---------------------------------------------------------------- events

  private wire(): void {
    const doc = this.doc;
    const fileInput = this.$<HTMLInputElement>('file');
    const open = async (): Promise<void> => {
      if (await this.confirmDiscard('Opening another model')) await this.openModel();
    };
    const newModel = async (): Promise<void> => {
      if (await this.confirmDiscard('Creating a new model')) this.newModel();
    };
    this.$('open-empty').addEventListener('click', () => void open());
    this.$('new-empty').addEventListener('click', () => void newModel());
    // every element naming a command (the menus' entries, the focus controls) runs it through the registry
    doc.addEventListener('click', (e) => {
      const b = (e.target as Element).closest ? (e.target as Element).closest('[data-command]') : null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      this.runCommand(b.getAttribute('data-command') as string);
    });
    this.$('btn-undo').addEventListener('click', () => this.undo());
    this.$('btn-redo').addEventListener('click', () => this.redo());
    this.$('errors').addEventListener('click', (e) => {
      const act = (e.target as Element).closest('[data-act-top]');
      const what = act ? act.getAttribute('data-act-top') : '';
      if (what === 'new') this.newModel();
      else if (what === 'open') void open();
      else if (what === 'start') this.showStart();
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) void this.loadFile(f);
      fileInput.value = '';
    });
    this.$('menu-examples').addEventListener('click', async (e) => {
      const t = (e.target as Element).closest('[data-example]');
      if (t && (await this.confirmDiscard('Loading an example'))) this.loadExample(Number(t.getAttribute('data-example')));
    });
    this.wireMenus();
    // start screen: choose an example, then load it (choosing alone loads nothing, so arrow keys can browse the list)
    const pick = this.$<HTMLSelectElement>('start-example');
    const loadBtn = this.$<HTMLButtonElement>('start-load');
    pick.addEventListener('change', () => {
      loadBtn.disabled = pick.value === '';
    });
    const loadPicked = async (): Promise<void> => {
      if (pick.value === '' || !(await this.confirmDiscard('Loading an example'))) return;
      const i = Number(pick.value);
      pick.value = '';
      loadBtn.disabled = true;
      this.loadExample(i);
    };
    loadBtn.addEventListener('click', () => void loadPicked());
    pick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void loadPicked();
      }
    });

    // drag & drop a file anywhere
    // Every drag over and drop on the page is taken over, whatever is dragged and wherever it lands:
    // the browser's own reaction to a dropped file is to navigate to it, away from the app.
    doc.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      doc.body.classList.add('dropping');
    });
    doc.addEventListener('dragleave', (e) => {
      if (!(e as DragEvent).relatedTarget) doc.body.classList.remove('dropping');
    });
    doc.addEventListener('drop', async (e) => {
      e.preventDefault();
      doc.body.classList.remove('dropping');
      const f = e.dataTransfer && e.dataTransfer.files[0];
      // some browsers hand over a file handle for a dropped file; it has to be asked for during the drop
      const item = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0];
      const getHandle = item && (item as unknown as { getAsFileSystemHandle?: () => Promise<unknown> }).getAsFileSystemHandle;
      const pending: Promise<unknown> | null = getHandle ? getHandle.call(item).catch(() => null) : null;
      if (!f) this.toast('Nothing was opened: drop a YAML file from this computer.');
      else if (await this.confirmDiscard('Opening the dropped file')) {
        const h = pending ? await pending : null;
        void this.loadFile(f, isWritable(h) ? h : null);
      }
    });

    // closing / reloading the tab with unsaved edits
    const win = doc.defaultView;
    if (win) {
      win.addEventListener('beforeunload', (e) => {
        if (this.mdoc && this.mdoc.dirty) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }

    const views = doc.querySelectorAll('[data-view-btn]');
    for (let i = 0; i < views.length; i++) {
      views[i].addEventListener('click', (e) => this.setView((e.currentTarget as Element).getAttribute('data-view-btn') as View));
    }
    this.$('zoom-in').addEventListener('click', () => this.zoomBy(1.25));
    this.$('zoom-out').addEventListener('click', () => this.zoomBy(0.8));
    this.$('zoom-fit').addEventListener('click', () => this.fit());
    for (const st of STRATEGIES) this.$('btn-arrange-' + st).addEventListener('click', () => void this.arrangeCurrentView(st));

    const opt = (id: string, fn: (v: boolean) => void): void => {
      this.$<HTMLInputElement>(id).addEventListener('change', (e) => {
        if (!this.session) return;
        fn((e.target as HTMLInputElement).checked);
        this.render();
        this.layoutFilters();
      });
    };
    opt('opt-labels', (v) => this.session && (this.session.state.showLabels = v));
    opt('opt-groups', (v) => this.session && (this.session.state.showGroups = v));
    opt('opt-networks', (v) => this.session && (this.session.state.showNetworks = v));
    opt('opt-routes', (v) => this.session && (this.session.state.showRoutes = v));
    // IP / non-IP: at least one stays on (switching the last one off switches the other one back on)
    for (const [id, other] of [['opt-ip', 'opt-nonip'], ['opt-nonip', 'opt-ip']]) {
      this.$<HTMLInputElement>(id).addEventListener('change', (e) => {
        if (!this.session) return;
        const me = e.target as HTMLInputElement;
        const them = this.$<HTMLInputElement>(other);
        if (!me.checked && !them.checked) them.checked = true;
        const ip = this.$<HTMLInputElement>('opt-ip').checked;
        const non = this.$<HTMLInputElement>('opt-nonip').checked;
        if (this.session.setConnections(ip && non ? 'all' : ip ? 'ip' : 'nonip')) {
          this.render();
          this.fit();
        }
        this.layoutFilters();
      });
    }
    this.wireDevices();
    this.wireTypes();
    this.wireDock();
    this.wireRegions();
    this.wireMoreFilters();

    // side panel: tabs, reference links, protocol filters, editor
    const side = this.$('side');
    side.addEventListener('click', (e) => {
      if (this.swallowClick(e)) return;
      const t = e.target as HTMLElement;
      const tab = t.closest('[data-tab]');
      if (tab) {
        this.tab = tab.getAttribute('data-tab') as Tab;
        this.renderSide();
        return;
      }
      const y = t.closest('[data-yaml]');
      if (y) {
        if (y.getAttribute('data-yaml') === 'apply') this.applyYaml();
        else {
          this.editor.sourceDraft = null;
          this.editor.sourceError = null;
          this.renderSide();
        }
        return;
      }
      // an object named in a problem goes to that object; the problem itself to its place
      const go = t.closest('[data-goto]');
      if (go) {
        this.select(go.getAttribute('data-goto'), true);
        return;
      }
      const filter = t.closest('[data-problems-filter]');
      if (filter) {
        const s = filter.getAttribute('data-problems-filter') as Severity;
        this.problemsShown[s] = !this.problemsShown[s];
        this.renderSide();
        const again = this.doc.querySelector(`[data-problems-filter="${s}"]`) as HTMLElement | null;
        if (again) again.focus();
        return;
      }
      if (t.closest('[data-problems-settings]')) {
        this.editModel();
        const g = this.doc.querySelector('#side-body [data-group="checks"]') as HTMLElement | null;
        if (g && typeof g.scrollIntoView === 'function') g.scrollIntoView({ block: 'start' });
        return;
      }
      const iss = t.closest('[data-issue]');
      if (iss && iss.classList.contains('clickable')) {
        this.gotoIssue(Number(iss.getAttribute('data-issue')));
        return;
      }
      this.guarded(() => this.editor.onClick(t));
    });
    side.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const p = t.getAttribute('data-proto');
      if (p && this.session) {
        this.session.toggleProtocol(p, t.checked);
        this.render();
        return;
      }
      this.guarded(() => this.editor.onChange(t));
    });
    side.addEventListener('input', (e) => {
      const t = e.target as HTMLElement;
      if (t.getAttribute('data-t') === 'draft') {
        this.editor.draftInput(t);
        return;
      }
      if (t.id === 'yaml-src') {
        this.editor.sourceDraft = (t as HTMLTextAreaElement).value;
        this.scheduleYamlMark();
      }
    });
    // the form of a new link or relation: Enter creates it (when complete), Esc discards it
    side.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.getAttribute('data-t') !== 'draft') return;
      if (e.key === 'Enter' && t.tagName === 'INPUT') {
        e.preventDefault();
        this.editor.createDraft();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.editor.cancelDraft();
      }
    });
    side.addEventListener(
      'toggle',
      (e) => {
        this.editor.onToggle(e.target as HTMLElement);
      },
      true,
    );
    const outline = this.$('outline');
    // pointing at a relation, a link (or a device) in the Objects list marks what it is attached to in the diagram
    outline.addEventListener('pointerover', (e) => {
      const item = (e.target as Element).closest('.ol-item[data-ref]');
      this.markAttached(item ? item.getAttribute('data-ref') : null);
    });
    outline.addEventListener('pointerleave', () => this.markAttached(null));
    // … and so does pointing at an end of the selected relation or link in the Edit tab
    side.addEventListener('pointerover', (e) => {
      const end = (e.target as Element).closest('.ep-bind[data-end]');
      this.markAttached(end ? end.getAttribute('data-end') : null);
    });
    side.addEventListener('pointerleave', () => this.markAttached(null));
    outline.addEventListener('click', (e) => {
      if (this.swallowClick(e)) return;
      this.guarded(() => this.editor.onClick(e.target as HTMLElement));
    });
    // Editor buttons act on pointerdown: first commit the field being typed in, then act.
    // (Acting on "click" would lose the click, because committing re-renders the panel.)
    for (const box of [side, outline]) {
      box.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // a press handled earlier whose click never came (the button moved away as the form re-rendered) must not swallow this one
        this.clickHandled = false;
        const btn = (e.target as Element).closest('[data-act]') as HTMLElement | null;
        if (!btn) return;
        // a checkbox acts on its click, when its new state is set (on pointerdown it would still read the old one);
        // but the field being typed in is committed first, and if that re-rendered the form, the click would hit
        // a removed box: then the new box with the same id is toggled here, and the click that follows is ignored
        if (btn instanceof HTMLInputElement && btn.type === 'checkbox') {
          const id = btn.id;
          e.preventDefault();
          this.commitActiveField();
          if (btn.isConnected || !id) return;
          const again = this.doc.getElementById(id) as HTMLInputElement | null;
          if (!again) return;
          again.checked = !again.checked;
          this.clickHandled = true;
          this.guarded(() => this.editor.onClick(again));
          return;
        }
        e.preventDefault();
        this.commitActiveField();
        this.clickHandled = true;
        this.guarded(() => this.editor.onClick(btn));
      });
    }
    outline.addEventListener('input', (e) => {
      const t = e.target as HTMLElement;
      if (t.getAttribute('data-t') === 'outline-filter') {
        const focus = captureFocus(this.doc);
        this.editor.onChange(t);
        restoreFocus(this.doc, focus);
      }
    });

    // search
    const q = this.$<HTMLInputElement>('search');
    const results = this.$('search-results');
    const closeResults = (): void => {
      results.hidden = true;
      while (results.firstChild) results.removeChild(results.firstChild);
    };
    q.addEventListener('input', () => {
      closeResults();
      if (!this.session || !q.value.trim()) return;
      const hits = search(this.session.model, q.value);
      if (!hits.length) results.appendChild(el(doc, 'div', { class: 'muted' }, ['No matches']));
      for (const hit of hits) {
        results.appendChild(el(doc, 'button', { type: 'button', 'data-goto': hit.ref }, [el(doc, 'span', { class: 'kind' }, [hit.kind]), hit.label]));
      }
      results.hidden = false;
      // the list hangs under the Find bar over the whole page (the diagram area may be too short for it), inside the window
      const bar = this.$('find-bar').getBoundingClientRect();
      const vw = this.doc.documentElement.clientWidth;
      const vh = this.doc.documentElement.clientHeight;
      results.style.top = Math.round(bar.bottom + 4) + 'px';
      results.style.width = Math.round(Math.min(bar.width, vw - 16)) + 'px';
      results.style.left = Math.round(Math.max(8, Math.min(bar.left, vw - 8 - bar.width))) + 'px';
      results.style.maxHeight = Math.max(24, Math.floor(vh - bar.bottom - 12)) + 'px';
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = results.querySelector('[data-goto]');
        if (first) this.select(first.getAttribute('data-goto'), true);
        closeResults();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeFind(true);
      }
    });
    this.$('find-close').addEventListener('click', () => this.closeFind(true));
    // Find menu
    // Analyze menu
    // Help menu
    this.$('theme-btn').addEventListener('click', () => this.theme.toggle());
    outline.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && t.getAttribute('data-t') === 'outline-filter') {
        e.preventDefault();
        e.stopPropagation();
        void this.editor.onClick(this.$('outline-body').querySelector('[data-act="filter-close"]') as HTMLElement);
      }
    });
    results.addEventListener('click', (e) => {
      const go = (e.target as Element).closest('[data-goto]');
      if (go) this.select(go.getAttribute('data-goto'), true);
      closeResults();
    });

    this.wireCanvas();
    this.wireConnect();
    // the Analyze panels pass their events to the tool's own (delegated) listeners, wherever its parts are laid out
    for (const id of ['ws-an-left', 'ws-an-dock', 'ws-an-right']) {
      const box = doc.getElementById(id);
      if (!box) continue;
      for (const type of ['click', 'input', 'keydown', 'change']) box.addEventListener(type, (e) => {
        if (this.ws !== 'analyze') return;
        for (const h of this.anRoot.slice()) if (h.type === type) h.fn(e);
      });
    }
    this.tw = new ToolWindows(doc, () => {
      if (this.splitter) this.splitter.sync();
    });
    this.splitter = new Splitter(doc, doc.querySelector('main') as HTMLElement, this.$('side-splitter'), this.$('side'), this.$('outline'));
    this.tabOverflow = new TabOverflow(doc, doc.querySelector('#side .tabs') as HTMLElement, (tab) => {
      this.tab = tab as Tab;
      this.renderSide();
      const b = doc.querySelector(`#side .tabs [data-tab="${tab}"]`) as HTMLElement | null;
      if (b) b.focus();
    });
    if (doc.defaultView) doc.defaultView.addEventListener('resize', () => this.tabOverflow && this.tabOverflow.layout(this.tab));

    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      // a modal dialog has the keyboard to itself: no shortcut acts on the page behind it
      if (t && t.closest && t.closest('dialog[open]')) return;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
      // in the first field of an entry just created, before anything is typed there, Ctrl+Z undoes the create (the field has no text to undo)
      if (typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && this.editor.untouchedNew(t)) {
        e.preventDefault();
        this.undo();
        return;
      }
      // the shortcuts of the command registry (the same the menus and the palette show)
      for (const c of this.commands) {
        if (!c.keys || (typing && !c.keys.whileTyping) || !matchesKey(c.keys, e)) continue;
        e.preventDefault();
        const st = c.state(this);
        if (st.enabled) this.runCommand(c.id);
        else if (!(c.keyFallback && c.keyFallback(this)) && st.reason && this.mdoc) this.toast(`${c.label}: ${st.reason}`);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (this.conn) this.cancelConnection(true);
        else if (this.ws === 'analyze' && this.anEscape()) return;
        else if (this.traceRun) this.exitTrace();
        // (layered: a focus in Analyze ends before Analyze does)
        else if (this.ws === 'analyze' && this.session && this.session.state.focus && !inWorkspacePanel(e.target)) this.exitFocus();
        else if ((this.ws === 'experiments' || this.ws === 'analyze') && !inWorkspacePanel(e.target)) void this.exitWorkspace();
        else if (this.ws === 'experiments' || this.ws === 'analyze') return;
        else if (this.simulation) this.exitSimulation();
        else if (this.session && this.session.state.focus) this.exitFocus();
        else this.select(null);
      }
      else if (e.key.indexOf('Arrow') === 0) {
        const d = 60;
        if (e.key === 'ArrowLeft') this.zoom.tx += d;
        if (e.key === 'ArrowRight') this.zoom.tx -= d;
        if (e.key === 'ArrowUp') this.zoom.ty += d;
        if (e.key === 'ArrowDown') this.zoom.ty -= d;
        this.applyZoom();
      }
    });
    if (win) {
      win.addEventListener('resize', () => {
        this.applyZoom();
        this.placeYamlMark();
        this.layoutFilters();
      });
      // a short window starts with the mouse and keyboard help folded (it stays one click away)
      const keys = doc.getElementById('keys') as HTMLDetailsElement | null;
      if (keys && win.innerHeight <= 560) keys.open = false;
    }
  }

  // ------------------------------------------------------------ connections

  /**
   * Connecting two endpoints in the diagram. A right-click on a device or an
   * interface (a port or a chip) starts a connection there and draws a line
   * from it to the pointer; a right-click on a second, compatible endpoint
   * opens a new physical link (physical view) or logical relation (logical
   * view) with both endpoints in the Edit tab. Nothing is added to the model
   * until it is completed there and created. Compatible endpoints are marked
   * while a connection is drawn; an incompatible one is refused with a short
   * message and the first endpoint is kept. Esc, switching views or models
   * cancels. Left clicks only ever select. The keyboard equivalent is C
   * (connect the selected device or interface) and the connect bar.
   */

  /** Is a connection being drawn? */
  get connecting(): boolean {
    return !!this.conn;
  }

  /** The endpoints drawn in the diagram on screen (their refs). */
  private drawnEndpoints(): Set<string> {
    const out = new Set<string>();
    const els = this.viewport.querySelectorAll('[data-endpoint]');
    for (let i = 0; i < els.length; i++) out.add(els[i].getAttribute('data-ref') as string);
    return out;
  }

  /** Start a connection at an endpoint of the diagram on screen. False (with a short message) when it can't take part in one. */
  startConnection(ref: string, focusBar = false): boolean {
    const s = this.session;
    if (!s || !this.mdoc) return false;
    const view = s.state.view;
    const model = s.viewModel();
    const e = endpointOfRef(ref);
    if (!e) {
      this.toast('Only devices and interfaces can be connected.');
      return false;
    }
    const why = endpointProblem(model, view, e) || (this.drawnEndpoints().has(ref) ? '' : `${endpointName(s.model, e)} is not shown in the ${view} view`);
    if (why) {
      this.toast(`No connection started: ${why}.`);
      return false;
    }
    this.cancelConnection();
    this.conn = { view, first: e, ref, at: null };
    this.applyConnection();
    this.fillConnectBar(focusBar);
    this.toast(`New ${connectionKind(view) === 'link' ? 'physical link' : 'logical relation'} from ${endpointName(model, e)}: right-click a highlighted endpoint. Esc cancels.`);
    return true;
  }

  /**
   * Choose the second endpoint. A compatible one ends the drawing and opens
   * the new link or relation in the Edit tab, its endpoints filled in and the
   * first required field focused. An incompatible or hidden one is refused
   * with the reason; the first endpoint stays chosen.
   */
  completeConnection(ref: string): boolean {
    const c = this.conn;
    const s = this.session;
    if (!c || !s) return false;
    const model = s.viewModel();
    const e = endpointOfRef(ref);
    if (ref === c.ref) {
      this.toast('That is the first endpoint. Choose a highlighted one, or press Esc to cancel.');
      return false;
    }
    const why = !e ? 'only devices and interfaces can be connected' : pairProblem(model, c.view, c.first, e) || (this.drawnEndpoints().has(ref) ? '' : 'that endpoint is not shown in this view');
    if (why || !e) {
      this.toast(`Not connected: ${why}. The first endpoint is kept; choose another, or press Esc.`);
      return false;
    }
    const first = c.first;
    this.cancelConnection();
    this.editor.openDraft(connectionKind(c.view), [first, e]);
    this.tab = 'edit';
    this.renderOutline();
    this.renderSide();
    this.updateChrome();
    this.editor.focusDraft();
    return true;
  }

  /** Stop drawing a connection (nothing was added). */
  cancelConnection(say = false): void {
    if (!this.conn) return;
    this.conn = null;
    const bar = this.doc.getElementById('connect-bar');
    if (bar) bar.hidden = true;
    this.applyConnection();
    if (say) this.toast('Connection cancelled; nothing was added.');
  }

  /** C: connect the selected device or interface (or, while connecting, go to the endpoint list). */
  connectFromSelection(): void {
    if (this.conn) {
      this.$('connect-pick').focus();
      return;
    }
    const s = this.session;
    const ref = s ? s.state.selected : null;
    if (!s || !ref || !endpointOfRef(ref)) {
      this.toast('Select a device or an interface first, then press C to connect it.');
      return;
    }
    this.startConnection(ref, true);
  }

  /** The connect bar: what is being connected, and the compatible endpoints shown, to pick from with the keyboard. */
  private fillConnectBar(focus: boolean): void {
    const c = this.conn;
    const s = this.session;
    const bar = this.$('connect-bar');
    if (!c || !s) {
      bar.hidden = true;
      return;
    }
    const model = s.viewModel();
    const drawn = this.drawnEndpoints();
    const pick = this.$<HTMLSelectElement>('connect-pick');
    while (pick.firstChild) pick.removeChild(pick.firstChild);
    const options = compatibleEndpoints(model, c.view, c.first).filter((e) => drawn.has(endpointRef(e)));
    for (const e of sortedByName(options, (x) => (x.iface ? `${x.device} ${x.iface}` : x.device))) {
      pick.appendChild(el(this.doc, 'option', { value: endpointRef(e) }, [e.iface ? `${e.device} · ${e.iface}` : `${model.index.devices.get(e.device)?.label || e.device} (whole device)`]));
    }
    if (!options.length) pick.appendChild(el(this.doc, 'option', { value: '', disabled: '' }, ['No compatible endpoint is shown']));
    (this.$('connect-go') as HTMLButtonElement).disabled = !options.length;
    this.$('connect-text').textContent = `New ${c.view === 'physical' ? 'physical link' : 'logical relation'} from ${endpointName(model, c.first)}: right-click a highlighted endpoint, or pick one:`;
    bar.hidden = false;
    if (focus) pick.focus();
  }

  /**
   * Mark the endpoints of the diagram for connecting (after every render):
   * where a connection can start (a hover cue), and while one is drawn its
   * first endpoint and which endpoints are compatible; then the line.
   */
  private applyConnection(): void {
    const c = this.conn;
    const s = this.session;
    if (c && (!s || s.state.view !== c.view || !this.viewport.querySelector(`[data-endpoint][data-ref="${cssEscape(c.ref)}"]`))) {
      // the first endpoint is gone (deleted, filtered out, another view): the connection ends
      this.conn = null;
      this.$('connect-bar').hidden = true;
      if (s) this.toast('Connection cancelled: its first endpoint is no longer shown.');
    }
    const cur = this.conn;
    const model = s ? s.viewModel() : null;
    const ok = new Set<string>();
    if (cur && model) for (const e of compatibleEndpoints(model, cur.view, cur.first)) ok.add(endpointRef(e));
    const els = this.viewport.querySelectorAll('[data-endpoint]');
    for (let i = 0; i < els.length; i++) {
      const x = els[i];
      const ref = x.getAttribute('data-ref') as string;
      const e = endpointOfRef(ref);
      x.classList.toggle('conn-source', !!cur && ref === cur.ref);
      x.classList.toggle('conn-ok', !!cur && ref !== cur.ref && ok.has(ref));
      x.classList.toggle('conn-no', !!cur && ref !== cur.ref && !ok.has(ref));
      x.classList.toggle('conn-start', !cur && !!s && !!e && !!model && !endpointProblem(model, s.state.view, e));
    }
    this.svg.classList.toggle('connecting', !!cur);
    this.drawConnLine();
  }

  /** The temporary line from the first endpoint to the pointer. */
  private drawConnLine(): void {
    let line = this.doc.getElementById('conn-line') as Element | null;
    const c = this.conn;
    if (!c || !c.at) {
      if (line) line.remove();
      return;
    }
    const src = this.viewport.querySelector(`[data-endpoint][data-ref="${cssEscape(c.ref)}"]`) as SVGGraphicsElement | null;
    if (!src || typeof src.getBBox !== 'function') return;
    let b: DOMRect;
    try {
      b = src.getBBox();
    } catch (err) {
      return;
    }
    if (!line || line.parentNode !== this.viewport) {
      if (line) line.remove();
      const fresh = this.doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      fresh.setAttribute('id', 'conn-line');
      fresh.setAttribute('class', 'conn-line');
      fresh.setAttribute('aria-hidden', 'true');
      this.viewport.appendChild(fresh);
      line = fresh;
    }
    line.setAttribute('x1', String(round(b.x + b.width / 2)));
    line.setAttribute('y1', String(round(b.y + b.height / 2)));
    line.setAttribute('x2', String(round(c.at.x)));
    line.setAttribute('y2', String(round(c.at.y)));
  }

  private wireConnect(): void {
    const bar = this.$('connect-bar');
    const pick = this.$<HTMLSelectElement>('connect-pick');
    const go = (): void => {
      if (pick.value) this.completeConnection(pick.value);
    };
    this.$('connect-go').addEventListener('click', go);
    this.$('connect-cancel').addEventListener('click', () => this.cancelConnection(true));
    pick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelConnection(true);
      }
    });
    // a right-click on a device or interface is ours; anywhere else the browser's menu stays
    this.svg.addEventListener('contextmenu', (e) => {
      if (!this.session) return;
      const t = (e.target as Element).closest('[data-endpoint]');
      if (!t) return;
      e.preventDefault();
      if (this.editLock()) {
        this.toast(this.editLock());
        return;
      }
      const ref = t.getAttribute('data-ref') as string;
      this.$('tooltip').hidden = true;
      if (this.conn) this.completeConnection(ref);
      else this.startConnection(ref);
    });
  }

  // ------------------------------------------------------------- layout

  /**
   * A node was dragged: store its new position in the document (one undo
   * step). In a filtered view the position is temporary: it stays in the
   * session and the document is not changed.
   */
  private commitDrag(ref: string): void {
    const s = this.session;
    const d = this.mdoc;
    if (!s || !d) return;
    if (s.isFiltered()) {
      s.commitTemporary(ref);
      this.render();
      this.updateChrome();
      return;
    }
    const view = s.state.view;
    const p = s.state.positions[view].get(ref);
    if (!p) return;
    const id = ref.slice(ref.indexOf(':') + 1);
    const hadLayout = d.hasStoredLayout(view);
    if (d.movePositions(view, new Map([[id, p]]), `Move ${id}`)) {
      this.afterEdit(hadLayout ? undefined : `Positions of the ${view} view are now saved in the model (layout section). Undo with Ctrl+Z.`);
    }
  }

  /**
   * Auto-arrange the view on screen with a strategy; the other view is never
   * touched. Positions that were set by hand are only replaced after a
   * confirmation that says what will change. A view that already shows this
   * strategy's layout is left alone (its button is disabled then).
   */
  async arrangeCurrentView(strategy: ArrangeStrategy = 'default'): Promise<void> {
    const d = this.mdoc;
    const s = this.session;
    if (!d || !s) return;
    const view = s.state.view;
    const how = strategy === 'default' ? '' : ` (${STRATEGY_LABEL[strategy]})`;
    // nothing to arrange: the button is disabled, and the A key does nothing either
    if ((s.isFiltered() ? s.filteredArrangedWith(view) : d.arrangedWith(view)).indexOf(strategy) >= 0) return;
    if (s.isFiltered()) {
      // only the devices shown, in this session only: the saved layout of the complete view is not changed
      const moved = s.arrangeFiltered(strategy);
      this.render();
      if (moved) this.fit();
      this.updateChrome();
      this.toast(moved ? `Auto-arranged the filtered ${view} view${how}: ${moved} object${moved > 1 ? 's' : ''} moved. Temporary; the saved layout is unchanged.` : `Arranged the filtered ${view} view${how}: nothing moved, ${STRATEGY_ROUTING[strategy] ? 'the lines now run at right angles' : 'the lines are routed as standard again'}. Temporary; the saved layout is unchanged.`);
      return;
    }
    const other: View = view === 'physical' ? 'logical' : 'physical';
    const impact = d.arrangeImpact(view, strategy);
    if (impact.manual.length) {
      const m = s.model;
      const name = (id: string): string => (m.index.devices.get(id) || m.index.networks.get(id) || { label: id }).label;
      const shown = impact.manual.slice(0, 6).map(name);
      const rest = impact.moved.length - impact.manual.length;
      const n = impact.manual.length;
      const a = await this.dialog({
        title: `Replace manual positions in the ${view} view?`,
        body: [
          el(this.doc, 'p', {}, [
            `${n} object${n > 1 ? 's were' : ' was'} positioned by hand in the ${view} view: ${shown.join(', ')}${n > shown.length ? ` and ${n - shown.length} more` : ''}. ` +
              `Auto-arrange moves ${n > 1 ? 'them' : 'it'} back to the calculated layout` +
              (rest > 0 ? `, together with ${rest} other object${rest > 1 ? 's' : ''} that no longer match${rest > 1 ? '' : 'es'} it.` : '.'),
          ]),
          el(this.doc, 'p', { class: 'muted' }, [`The ${other} view is not changed. You can undo this with Ctrl+Z.`]),
        ],
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: `Arrange ${view} view${how}`, value: 'arrange', kind: 'primary' },
        ],
      });
      if (a !== 'arrange') return;
      // the model or the view may have changed while the dialog was open
      if (this.mdoc !== d || this.session !== s || s.state.view !== view) return;
    }
    const routingBefore = d.routing(view);
    const res = d.arrange([view], strategy);
    const note = !res.changed
      ? 'Already arranged — nothing moved.'
      : res.moved === 0
        ? routingBefore !== STRATEGY_ROUTING[strategy]
          ? `Arranged the ${view} view${how}: nothing moved, ${STRATEGY_ROUTING[strategy] ? 'the lines now run at right angles' : 'the lines are routed as standard again'}. Undo with Ctrl+Z.`
          : 'Positions saved in the model; nothing moved.'
        : `Auto-arranged the ${view} view${how}: ${res.moved} object${res.moved > 1 ? 's' : ''} moved. Undo with Ctrl+Z.`;
    this.afterEdit(note);
    if (res.moved) this.fit();
  }

  /** set when a pointerdown already performed an editor action; the following mouse click is ignored */
  private clickHandled = false;

  private swallowClick(e: Event): boolean {
    const handled = this.clickHandled;
    this.clickHandled = false;
    const btn = (e.target as Element).closest('[data-act]');
    // keyboard activation (detail === 0) is never swallowed
    if (handled && btn && (e as MouseEvent).detail > 0) {
      e.preventDefault();
      return true;
    }
    return false;
  }

  /** Commit the editor field that has focus if its text was changed (same as pressing Enter). */
  commitActiveField(): void {
    const a = this.doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (!a || !a.getAttribute || !a.getAttribute('data-t')) return;
    if ((a.tagName === 'INPUT' && (a as HTMLInputElement).type === 'text') || a.tagName === 'TEXTAREA') {
      if (a.value !== a.defaultValue) this.editor.onChange(a as HTMLElement);
    }
  }

  private wireCanvas(): void {
    const svg = this.svg;
    const tip = this.$('tooltip');
    let drag: null | { mode: 'pan' | 'node'; ref: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean; id: number; detail: SelDetail | null; flight?: number | null } = null;

    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.session) return;
      // commit a field being edited before the diagram takes over
      const active = this.doc.activeElement as HTMLElement | null;
      if (active && active !== this.doc.body && typeof active.blur === 'function' && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.blur();
      const target = (e.target as Element).closest('[data-ref]');
      const node = (e.target as Element).closest('.node');
      const ref = target ? target.getAttribute('data-ref') : null;
      let nodeRef = node ? node.getAttribute('data-ref') : null;
      // a guest in the physical view is drawn inside its host: dragging it moves the machine it runs on (with everything in it)
      const guest = nodeRef && nodeRef.indexOf('device:') === 0 && this.session.state.view === 'physical' ? this.session.model.index.devices.get(nodeRef.slice(7)) : undefined;
      if (guest && isGuest(guest) && hostOf(this.session.model, guest)) nodeRef = 'device:' + machineOf(this.session.model, guest).id;
      // a line that shows one field of the object (an address, a VRF …): highlighted in the Edit tab (read here:
      // once the pointer is captured, the release is reported on the canvas, not on the line)
      const line = (e.target as Element).closest('[data-field]');
      const holder = line ? line.closest('[data-ref]') : null;
      const detail = line && holder ? { field: line.getAttribute('data-field') as string, value: line.getAttribute('data-value') || '' } : null;
      const detailRef = holder ? holder.getAttribute('data-ref') : null;
      // (a bus's bar is moved like a device, in the physical view)
      if (nodeRef && !this.simulation && (nodeRef.indexOf('device:') === 0 || nodeRef.indexOf('network:') === 0 || (nodeRef.indexOf('interconnect:') === 0 && this.session.state.view === 'physical'))) {
        const w = this.toWorld(e.clientX, e.clientY);
        const center = this.nodeCenter(nodeRef);
        drag = { mode: 'node', ref: nodeRef, sx: e.clientX, sy: e.clientY, ox: center.x - w.x, oy: center.y - w.y, moved: false, id: e.pointerId, detail: detailRef === nodeRef ? detail : null };
      } else {
        drag = { mode: 'pan', ref, sx: e.clientX, sy: e.clientY, ox: this.zoom.tx, oy: this.zoom.ty, moved: false, id: e.pointerId, detail: detailRef === ref ? detail : null };
      }
      // a packet of the protocol simulation: the dot nearest the pointer within its hit area (read here: once the
      // pointer is captured, the release is reported on the canvas)
      drag.flight = this.simCtl ? this.simCtl.flightAt(this.toWorld(e.clientX, e.clientY), this.zoom.k) : null;
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (this.conn) {
        this.conn.at = this.toWorld(e.clientX, e.clientY);
        this.drawConnLine();
      }
      if (drag && drag.id === e.pointerId) {
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        tip.hidden = true;
        svg.classList.add('dragging');
        if (drag.mode === 'pan') {
          this.zoom.tx = drag.ox + dx;
          this.zoom.ty = drag.oy + dy;
          this.applyZoom();
        } else if (this.session && drag.ref) {
          const w = this.toWorld(e.clientX, e.clientY);
          this.session.moveNode(drag.ref, { x: Math.round(w.x + drag.ox), y: Math.round(w.y + drag.oy) });
          this.scheduleRender();
        }
        return;
      }
      // a packet within reach of the pointer: outlined (the one a click opens), the pointer a hand
      if (this.simCtl) this.simCtl.pointerAt(this.toWorld(e.clientX, e.clientY), this.zoom.k);
      this.hover(e);
    });
    const end = (e: PointerEvent): void => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      svg.classList.remove('dragging');
      if (!d.moved) {
        // a dot of the protocol simulation: the packet inspector
        const fl = d.flight;
        if (fl !== null && fl !== undefined && this.simCtl) {
          const r = this.hitRect(fl, e);
          this.simCtl.inspectFlight(fl, r);
          return;
        }
        const target = (e.target as Element).closest('[data-ref]');
        const ref = target ? target.getAttribute('data-ref') : d.ref;
        this.select(ref && ref.indexOf('hub:') === 0 ? 'relation:' + ref.slice(4) : ref, false, ref === d.ref ? d.detail : null);
        // during the protocol simulation: Fail this link / Restore link, Show ARP table … at that spot
        if (this.simCtl) {
          const nodeEl = (e.target as Element).closest('.node, g.cable, g.rel, g.hub-rel');
          const r = nodeEl ? nodeEl.getAttribute('data-ref') : ref;
          this.simCtl.diagramClick(r, e.clientX, e.clientY);
        }
      } else if (d.mode === 'node' && d.ref) this.commitDrag(d.ref);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
      this.markAttached(null);
      if (this.simCtl) this.simCtl.pointerAt(null, this.zoom.k);
    });
  }

  /** Where a packet's dot is on screen (the inspector opens beside it); the pointer's spot when it is not drawn. */
  private hitRect(flight: number, e: PointerEvent): { x: number; y: number; w: number; h: number } {
    const p = this.simCtl ? this.simCtl.dotOf(flight) : null;
    const b = this.svg.getBoundingClientRect();
    const x = p ? b.left + p.x * this.zoom.k + this.zoom.tx : e.clientX;
    const y = p ? b.top + p.y * this.zoom.k + this.zoom.ty : e.clientY;
    return { x: x - 4, y: y - 4, w: 8, h: 8 };
  }

  private nodeCenter(ref: string): { x: number; y: number } {
    const s = this.session as Session;
    const [kind, id] = splitRef(ref);
    if (s.state.view === 'physical') {
      const o = s.state.positions.physical.get(ref);
      if (o) return o;
      const b = s.physicalLayout().boxes.get(id);
      return b ? { x: b.cx, y: b.cy } : { x: 0, y: 0 };
    }
    const o = s.state.positions.logical.get(ref);
    if (o) return o;
    const n = s.logicalLayout().nodes.get(kind + ':' + id);
    return n ? { x: n.cx, y: n.cy } : { x: 0, y: 0 };
  }

  private hover(e: PointerEvent): void {
    const tip = this.$('tooltip');
    const s = this.session;
    const target = (e.target as Element).closest('[data-ref]');
    if (!s || !target) {
      tip.hidden = true;
      this.markAttached(null);
      return;
    }
    let ref = target.getAttribute('data-ref') as string;
    if (ref.indexOf('hub:') === 0) ref = 'relation:' + ref.slice(4);
    this.markAttached(ref);
    const lines = tooltipFor(s.model, ref);
    if (this.errorRefs.has(ref)) lines.push('⚠ has validation errors — see the Edit tab');
    if (target.classList.contains('conn-ok')) lines.push('Right-click: connect here');
    else if (target.classList.contains('conn-no')) lines.push('Can’t be connected to the first endpoint');
    else if (target.classList.contains('conn-start')) lines.push('Right-click: start a connection (or select it and press C)');
    if (!lines.length) {
      tip.hidden = true;
      return;
    }
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    lines.forEach((l, i) => tip.appendChild(el(this.doc, 'div', { class: i === 0 ? 'tt-title' : 'tt-line' }, [l])));
    const wrap = this.$('canvas-wrap').getBoundingClientRect();
    tip.hidden = false;
    const x = e.clientX - wrap.left + 14;
    const y = e.clientY - wrap.top + 14;
    tip.style.left = Math.min(x, wrap.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.min(y, wrap.height - tip.offsetHeight - 8) + 'px';
  }

  /**
   * Serialize the current diagram as a standalone SVG string (Export → "Export current view as SVG").
   * The legend of the shown view and the overview of the networks relevant
   * to it are drawn into the file, beside the diagram, and the picture is
   * enlarged to contain all of it.
   */
  exportSvg(): string {
    return this.buildExport().text;
  }

  /**
   * The picture of the view on screen as a standalone SVG document, with
   * its size in diagram units. Its bounds are those of everything drawn
   * (they include a margin), not of the part that is scrolled or zoomed into
   * view; the legend and the networks overview are added beside the diagram
   * and the picture is enlarged to contain them. Both export formats are
   * made from this one document, so they show the same thing.
   */
  private buildExport(): { text: string; width: number; height: number; background: string } {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    let b = this.bounds;
    const vp = clone.querySelector('#viewport');
    if (vp) vp.removeAttribute('transform');
    // a connection being drawn is screen state, not part of the picture
    const line = clone.querySelector('#conn-line');
    if (line) line.remove();
    const marked = clone.querySelectorAll('.conn-start, .conn-source, .conn-ok, .conn-no, .hover-hl, .sim-tx, .sim-rx');
    for (let i = 0; i < marked.length; i++) marked[i].classList.remove('conn-start', 'conn-source', 'conn-ok', 'conn-no', 'hover-hl', 'sim-tx', 'sim-rx');
    // … and so is what the pointer is on
    clone.classList.remove('has-pointed');
    if (this.session) {
      const st = this.session.state;
      // what the picture shows decides what its legend and its networks overview list
      const scene = this.session.render();
      const boxes = exportBoxes(this.session.viewModel(), st.view, st, { root: scene.root, bounds: b, conflicts: scene.conflicts });
      clone.appendChild(materialize(boxes.legend.root, this.doc, true));
      clone.appendChild(materialize(boxes.networks.root, this.doc, true));
      b = boxes.viewBox;
    }
    // the protocol simulation: a static picture of what is in flight (labelled arrows), never moving dots
    const live = clone.querySelectorAll('.layer-sim, .layer-sim-labels');
    for (let i = 0; i < live.length; i++) live[i].parentNode && live[i].parentNode!.removeChild(live[i]);
    if (this.simCtl) {
      const layer = this.simCtl.anim.exportLayer();
      const scene = clone.querySelector('.scene');
      if (layer && scene) scene.appendChild(layer);
      // the indicators beside the boxes (statuses, querier marks, every snooping VLAN's badge) as on screen: all of them in the picture
      const marks = this.svg.querySelector('.layer-sim-power') as SVGGraphicsElement | null;
      if (marks && typeof marks.getBBox === 'function') {
        try {
          const e = marks.getBBox();
          if (e.width > 0 && e.height > 0) {
            const x0 = Math.min(b.x, e.x - 8);
            const y0 = Math.min(b.y, e.y - 8);
            b = { x: x0, y: y0, w: Math.max(b.x + b.w, e.x + e.width + 8) - x0, h: Math.max(b.y + b.h, e.y + e.height + 8) - y0 };
          }
        } catch (err) {
          /* not rendered */
        }
      }
    }
    // an analysis mode (focus, path trace) says so in the picture, above the diagram: a line each
    const notes = this.modeNotes();
    for (let i = notes.length - 1; i >= 0; i--) {
      const NOTE_H = 26;
      const t = this.doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'export-note');
      t.setAttribute('x', String(round(b.x + 14)));
      t.setAttribute('y', String(round(b.y - 9)));
      t.textContent = notes[i];
      clone.appendChild(t);
      b = { x: b.x, y: b.y - NOTE_H, w: b.w, h: b.h + NOTE_H };
    }
    clone.setAttribute('viewBox', `${round(b.x)} ${round(b.y)} ${round(b.w)} ${round(b.h)}`);
    clone.setAttribute('width', String(Math.round(b.w)));
    clone.setAttribute('height', String(Math.round(b.h)));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.removeAttribute('id');
    clone.removeAttribute('role');
    clone.removeAttribute('aria-label');
    clone.removeAttribute('data-conflicts');
    clone.setAttribute('class', ('export ' + (this.svg.getAttribute('class') || '')).replace(/\bconnecting\b|\bdragging\b/g, '').replace(/\s+/g, ' ').trim());
    // the picture is drawn in the theme in effect, with resolved colours and an explicit background
    const bg = this.exportBackground();
    clone.setAttribute('data-theme', this.theme.theme);
    const back = this.doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    back.setAttribute('class', 'export-background');
    back.setAttribute('x', String(round(b.x)));
    back.setAttribute('y', String(round(b.y)));
    back.setAttribute('width', String(round(b.w)));
    back.setAttribute('height', String(round(b.h)));
    clone.insertBefore(back, clone.firstChild);
    if (this.simulation) {
      const frame = this.doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      frame.setAttribute('class', 'export-sim-frame');
      frame.setAttribute('x', String(round(b.x + 3)));
      frame.setAttribute('y', String(round(b.y + 3)));
      frame.setAttribute('width', String(round(b.w - 6)));
      frame.setAttribute('height', String(round(b.h - 6)));
      clone.appendChild(frame);
    }
    this.withProbe(clone, () => inlineComputedStyles(clone, this.doc.defaultView as Window));
    back.setAttribute('fill', bg);
    back.removeAttribute('stroke');
    return { text: new XMLSerializer().serializeToString(clone), width: Math.round(b.w), height: Math.round(b.h), background: bg };
  }

  /** The diagram's background colour in the theme in effect, as #rrggbb (opaque). */
  private exportBackground(): string {
    const win = this.doc.defaultView;
    const v = win ? win.getComputedStyle(this.$('canvas-wrap')).backgroundColor : '';
    const p = resolvedPaint(v || '');
    return p.color.charAt(0) === '#' && p.alpha === 1 ? p.color : SURFACES[this.theme.theme][0];
  }

  /**
   * Run `fn` while `svg` is part of the document (off screen, at its natural
   * size), where the stylesheet applies to it as to the diagram on screen.
   */
  private withProbe(svg: SVGSVGElement, fn: () => void): void {
    const holder = this.doc.createElement('div');
    holder.className = 'export-probe';
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;pointer-events:none';
    holder.appendChild(svg);
    this.doc.body.appendChild(holder);
    try {
      fn();
    } finally {
      holder.removeChild(svg);
      this.doc.body.removeChild(holder);
    }
  }

  /** The view on screen as a PNG: the SVG export (same resolved colours) on its opaque background. */
  exportPng(): Promise<PngPicture> {
    const pic = this.buildExport();
    return svgToPng(this.doc, pic.text, pic.width, pic.height, pic.background);
  }

  /** Name of an exported picture: the model's file name and the view, e.g. "enterprise-wan-logical.png". */
  exportName(format: 'png' | 'svg'): string {
    const view = this.session ? this.session.state.view : 'view';
    return `${pictureBaseName(this.mdoc ? this.mdoc.fileName : '')}-${view}.${format}`;
  }

  /**
   * Export → Export view as… → PNG / SVG: save the view that is selected
   * (Physical or Logical) as a picture. A failure is reported in a dialog,
   * with what went wrong and what can be done instead.
   */
  async exportView(format: 'png' | 'svg'): Promise<boolean> {
    if (!this.session || !this.mdoc) return false;
    const name = this.exportName(format);
    try {
      if (format === 'svg') {
        downloadText(this.doc, this.exportSvg(), name, 'image/svg+xml');
        this.toast(`Exported “${name}”.`);
      } else {
        const png = await this.exportPng();
        downloadBlob(this.doc, png.blob, name);
        const reduced = png.scale < 1.999 ? `, drawn at ${Math.round(png.scale * 100)} % because of its size` : '';
        this.toast(`Exported “${name}” (${png.width} × ${png.height} pixels${reduced}).`);
      }
      return true;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      void this.dialog({
        title: `Could not export the view as ${format.toUpperCase()}`,
        body: [
          el(this.doc, 'p', {}, [`“${name}” was not created: ${why}.`]),
          el(this.doc, 'p', { class: 'muted' }, [format === 'png' ? 'Nothing was downloaded. Very large diagrams can exceed what a browser can draw as one image; the SVG export has no such limit.' : 'Nothing was downloaded.']),
        ],
        buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }],
      });
      return false;
    }
  }

  downloadSvg(): void {
    void this.exportView('svg');
  }
}

/** Outcome of a save: written to the linked or chosen file, downloaded as a copy, cancelled, or failed (changes kept). */
export type SaveResult = 'saved' | 'downloaded' | 'canceled' | 'failed';

/** What the Auto-arrange group says about a filtered view that matches no strategy (its positions are temporary). */
const FILTERED_STATUS_MESSAGE: { [k in 'manual']: string } = {
  manual: 'This filtered view has temporarily moved positions. Each Auto-arrange option re-arranges the devices shown.',
};

/** What the Auto-arrange group says when the view on screen matches no strategy (text, never colour alone). */
const LAYOUT_STATUS_MESSAGE = {
  manual: 'This view has manually adjusted positions. Each Auto-arrange option replaces them after a confirmation.',
  edited: 'This view no longer matches an Auto-arrange option: the model was edited after it was arranged.',
};

/** What each strategy is for (hover text of its button; the trade-offs are in the README). */
const STRATEGY_HELP: { [s in ArrangeStrategy]: string } = {
  default: 'the balanced standard layout: tiers and groups by cabling (physical), evenly spaced relations (logical); lines run straight or bend around boxes.',
  compact: 'packed tight: rows of leaf devices folded, groups and parts packed side by side, less empty space; the smallest picture without overlaps.',
  structured: 'rows and columns: devices in tiers on a grid, aligned with what they connect to; lines only horizontal and vertical with right-angle bends.',
};

/** A value for use inside a quoted CSS attribute selector. */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

interface FocusState {
  p: string | null;
  t: string | null;
  k: string | null;
  start: number | null;
  end: number | null;
}

/** Remember which editor field has focus, so re-rendering does not steal it. */
function captureFocus(doc: Document): FocusState | null {
  const a = doc.activeElement as HTMLInputElement | null;
  if (!a || !a.getAttribute || !a.getAttribute('data-t')) return null;
  let start: number | null = null;
  let end: number | null = null;
  try {
    start = a.selectionStart;
    end = a.selectionEnd;
  } catch (e) {
    /* not a text field */
  }
  return { p: a.getAttribute('data-p'), t: a.getAttribute('data-t'), k: a.getAttribute('data-k'), start, end };
}

function restoreFocus(doc: Document, f: FocusState | null): void {
  if (!f) return;
  const all = doc.querySelectorAll('[data-t]');
  for (let i = 0; i < all.length; i++) {
    const e = all[i] as HTMLInputElement;
    if (e.getAttribute('data-t') === f.t && e.getAttribute('data-p') === f.p && e.getAttribute('data-k') === f.k) {
      e.focus();
      try {
        if (f.start !== null && f.end !== null) e.setSelectionRange(f.start, f.end);
      } catch (err) {
        /* not a text field */
      }
      return;
    }
  }
}

/** What finds a control of a tool window again after its body is redrawn: its id, else its first data-* attribute and value. */
function focusKey(e: HTMLElement): { attr: string; value: string } | null {
  if (e.id) return { attr: 'id', value: e.id };
  for (let i = 0; i < e.attributes.length; i++) {
    const a = e.attributes[i];
    if (a.name.indexOf('data-') === 0) return { attr: a.name, value: a.value };
  }
  return null;
}

function findFocusKey(root: HTMLElement, k: { attr: string; value: string }): HTMLElement | null {
  const all = root.querySelectorAll(k.attr === 'id' ? '[id]' : `[${k.attr}]`);
  for (let i = 0; i < all.length; i++) if (all[i].getAttribute(k.attr) === k.value) return all[i] as HTMLElement;
  return null;
}

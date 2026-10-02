/**
 * Browser UI shell: one page that is both the visualizer and the editor.
 *
 * Everything is local: files are read with the File API after an explicit
 * user action (file picker or drag-and-drop), edited in memory, and saved by
 * letting the browser download a new copy. Nothing is transmitted.
 */
import { ModelDoc, Origin, ifaceSchemaKind } from '../editor/document';
import { PngPicture, downloadBlob, downloadText, exportFileName, pictureBaseName, readTextFile, safeYamlFileName, svgToPng } from './files';
import { el, materialize, mount } from './dom';
import { DialogOpts, showDialog, showToast } from './dialogs';
import { Editor, EditorSel } from './inspector';
import { LineRange, yamlBlock } from '../editor/yaml-block';
import { EXAMPLES } from '../generated/examples';
import { Rect } from '../layout/geometry';
import { IssueCount, detailsFor, legendFor, relationList, tooltipFor } from './panels';
import { exportBoxes } from '../diagram/networks-box';
import { Session, View } from '../diagram/session';
import { SelectionContext, search, selectionContext, splitRef } from '../model/queries';
import { sortedByName } from '../model/order';
import { normalizeProtocol } from '../model/protocols';
import { deviceTypeLabel } from '../model/device-types';
import { Issue } from '../validation/validate';

type Tab = 'edit' | 'details' | 'legend' | 'relations' | 'problems' | 'yaml';

export interface LoadOutcome {
  /** the document was opened (it may still have validation errors to fix) */
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
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

  constructor(doc: Document) {
    this.doc = doc;
    this.$ = <T extends Element = HTMLElement>(id: string): T => {
      const e = doc.getElementById(id);
      if (!e) throw new Error('missing element #' + id);
      return e as unknown as T;
    };
    this.svg = this.$<SVGSVGElement>('canvas');
    this.viewport = this.$<SVGGElement>('viewport');
    this.editor = new Editor(doc, {
      changed: (note) => this.afterEdit(note),
      selected: (sel) => this.editorSelected(sel),
      dialog: (o) => this.dialog(o),
      toast: (m) => this.toast(m),
    }, () => this.mdoc);
    this.wire();
    this.fillExamples();
    this.updateChrome();
  }

  // ------------------------------------------------------------- loading

  /** Read a user-chosen local file (size-checked, strict UTF-8). Does not ask about unsaved changes. */
  async loadFile(file: File): Promise<LoadOutcome> {
    const r = await readTextFile(file);
    if ('error' in r) return this.fail(file.name, [{ severity: 'error', line: 0, path: '', message: r.error }], []);
    return this.loadText(r.text, file.name, 'file');
  }

  /** Open YAML text as the current document (replaces it without asking). */
  loadText(text: string, name: string, origin: Origin = 'file'): LoadOutcome {
    const lines = text.split(/\r\n|\r|\n/);
    const { doc, errors } = ModelDoc.fromText(text, name, origin);
    if (!doc) return this.fail(name, errors, lines);
    this.sourceLines = lines;
    this.openDoc(doc);
    return { ok: true, errors: doc.errors, warnings: doc.warnings };
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

  private openDoc(doc: ModelDoc): void {
    const prevView = this.session ? this.session.state.view : 'physical';
    this.mdoc = doc;
    this.loadErrors = [];
    this.editor.sel = null;
    this.editor.sourceDraft = null;
    this.editor.sourceError = null;
    const model = doc.result.model;
    this.session = model ? new Session(model) : null;
    if (this.session) this.session.setView(prevView);
    this.tab = doc.errors.length || doc.warnings.length ? 'problems' : this.tab === 'yaml' ? 'yaml' : 'legend';
    this.computeErrorRefs();
    this.render();
    this.fit();
    this.renderOutline();
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
    ['view-btn', 'view-menu'],
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
   * The toolbar menus (File, Export): a button that opens a list of entries.
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

  loadExample(i: number): LoadOutcome | null {
    const ex = EXAMPLES[i];
    return ex ? this.loadText(ex.text, ex.name, 'example') : null;
  }

  /** Ask before discarding unsaved edits. Resolves true when it is OK to continue. */
  async confirmDiscard(action: string): Promise<boolean> {
    if (!this.mdoc || !this.mdoc.dirty) return true;
    const a = await this.dialog({
      title: 'Unsaved changes',
      body: [`The current model “${this.mdoc.fileName}” has changes that have not been downloaded. ${action} will replace it.`],
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Download first…', value: 'save' },
        { label: 'Discard changes', value: 'discard', kind: 'danger' },
      ],
    });
    if (a === 'save') {
      await this.downloadDialog();
      return !this.mdoc.dirty;
    }
    return a === 'discard';
  }

  // --------------------------------------------------------------- editing

  /** Called after every committed edit (and for pure UI refreshes). */
  private afterEdit(note?: string): void {
    const d = this.mdoc;
    if (d && note !== 'filter' && note !== 'select') {
      const model = d.result.model;
      if (model) {
        if (this.session) this.session.setModel(model);
        else this.session = new Session(model);
      } else this.session = null;
      this.computeErrorRefs();
      // keep the diagram selection in step with the editor
      if (this.session) this.session.select(this.editor.selectedRef());
      this.render();
    }
    this.renderOutline();
    // selecting opens the object's form, except where the panel already follows the selection (its details, its place in the YAML)
    if (note === 'select' && this.tab !== 'edit' && this.tab !== 'details' && this.tab !== 'yaml') this.tab = 'edit';
    this.renderSide();
    this.updateChrome();
    if (note && note !== 'filter' && note !== 'select') this.toast(note);
  }

  private editorSelected(sel: EditorSel): void {
    if (!this.session) return;
    this.session.select(sel ? this.editor.selectedRef() : null);
    this.applyHighlight();
  }

  undo(): void {
    if (this.mdoc && this.mdoc.undo()) this.afterEdit('Undone.');
  }
  redo(): void {
    if (this.mdoc && this.mdoc.redo()) this.afterEdit('Redone.');
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
    for (const is of d.errors.concat(d.warnings)) {
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

  // ---------------------------------------------------------------- export

  /** The current model as YAML text. */
  exportText(): string {
    return this.mdoc ? this.mdoc.exportText() : '';
  }

  suggestedFileName(): string {
    return this.mdoc ? exportFileName(this.mdoc.fileName, this.mdoc.origin) : 'network.yaml';
  }


  /**
   * Explain what will happen (a new copy is downloaded; the original file is
   * never overwritten), warn about validation errors, then download.
   */
  async downloadDialog(): Promise<boolean> {
    const d = this.mdoc;
    if (!d) return false;
    const nameInput = el(this.doc, 'input', { type: 'text', id: 'dl-name', spellcheck: 'false', 'aria-label': 'File name' }) as HTMLInputElement;
    nameInput.value = this.suggestedFileName();
    const body: Array<Node | string> = [
      el(this.doc, 'p', {}, [
        d.origin === 'file'
          ? `Your browser will save an updated copy of “${d.fileName}” into its downloads location. The original file on your disk is not modified — web pages cannot overwrite files they opened.`
          : 'Your browser will save the model as a YAML file into its downloads location.',
      ]),
      el(this.doc, 'label', { class: 'dl-label' }, ['File name ', nameInput]),
    ];
    const invalid = d.errors.length > 0;
    if (invalid) {
      body.push(
        el(this.doc, 'div', { class: 'dl-warn' }, [
          el(this.doc, 'b', {}, [`The model has ${d.errors.length} validation error${d.errors.length > 1 ? 's' : ''}.`]),
          ' The file will be saved exactly as it is, but netatlas will report these errors when it is opened again:',
          this.issueList(d.errors.slice(0, 6), []),
        ]),
      );
    }
    const a = await this.dialog({
      title: invalid ? 'Download a model that has errors?' : 'Download model',
      body,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        invalid ? { label: 'Download anyway', value: 'download', kind: 'danger' } : { label: 'Download', value: 'download', kind: 'primary' },
      ],
    });
    if (a !== 'download') return false;
    this.downloadNow(safeYamlFileName(nameInput.value, this.suggestedFileName()));
    return true;
  }

  /** Export the current model as YAML into a download with this name, and mark it as saved. */
  private downloadNow(name: string): void {
    const d = this.mdoc;
    if (!d) return;
    downloadText(this.doc, this.exportText(), name, 'application/yaml');
    d.markSaved();
    this.updateChrome();
    this.toast(`Downloaded “${name}”.`);
  }

  /**
   * File → Close model: leave the current model and show the start screen.
   * With unsaved changes it asks first: download the model and close, close
   * without downloading, or stay. Resolves true when the model was closed.
   */
  async closeModelDialog(): Promise<boolean> {
    const d = this.mdoc;
    if (!d) return false;
    if (d.dirty) {
      const name = this.suggestedFileName();
      const where =
        d.origin === 'file'
          ? `“Download and close” saves the current state as a new file, “${name}”, in your browser’s downloads location; the file you opened is not overwritten.`
          : `“Download and close” saves it as “${name}” in your browser’s downloads location.`;
      const body: Array<Node | string> = [
        el(this.doc, 'p', {}, [`“${d.fileName}” has changes that have not been downloaded. They exist only in this page and are lost when the model is closed.`]),
        el(this.doc, 'p', {}, [where]),
      ];
      if (d.errors.length) {
        body.push(el(this.doc, 'div', { class: 'dl-warn' }, [el(this.doc, 'b', {}, [`The model has ${d.errors.length} validation error${d.errors.length > 1 ? 's' : ''}.`]), ' The file is saved exactly as it is; netatlas will report the errors when it is opened again.']));
      }
      const a = await this.dialog({
        title: 'Close the model with unsaved changes?',
        body,
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Discard changes', value: 'discard', kind: 'danger' },
          { label: 'Download and close', value: 'download', kind: 'primary' },
        ],
      });
      // the model may have been replaced while the dialog was open
      if (this.mdoc !== d) return false;
      if (a === 'download') this.downloadNow(name);
      else if (a !== 'discard') return false;
    }
    this.closeModel();
    return true;
  }

  /**
   * Close the current model without asking and show the start screen.
   * Everything that belonged to it goes with it: selection, view, filters,
   * zoom, open cards, the YAML draft. The next model starts clean.
   */
  closeModel(): void {
    this.mdoc = null;
    this.session = null;
    this.loadErrors = [];
    this.loadErrorName = '';
    this.sourceLines = [];
    this.errorRefs.clear();
    this.editor.reset();
    this.tab = 'legend';
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
    this.applyHighlight();
    this.applyZoom();
    this.renderSide();
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

  private applyHighlight(): void {
    const s = this.session;
    if (!s) return;
    const keep = s.highlight();
    this.svg.classList.toggle('has-selection', !!keep);
    const els = this.viewport.querySelectorAll('[data-ref]');
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      const ref = e.getAttribute('data-ref') as string;
      const on = !!keep && keep.has(ref);
      e.classList.toggle('hl', on);
      e.classList.toggle('dim', !!keep && !on);
      e.classList.toggle('selected', !!s.state.selected && ref === s.state.selected);
      e.classList.toggle('has-error', this.errorRefs.has(ref));
    }
  }

  /** Select from the diagram, search or details links. */
  select(ref: string | null, reveal = false): void {
    if (!this.session) return;
    this.session.select(ref);
    this.editor.selectRef(this.session.state.selected);
    if (ref && this.session.state.selected && this.tab !== 'details' && this.tab !== 'yaml') this.tab = 'edit';
    this.applyHighlight();
    this.renderOutline();
    this.renderSide();
    this.updateChrome();
    if (reveal && ref) this.reveal(ref);
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
    const H = this.svg.clientHeight || 700;
    const b = this.bounds;
    const k = Math.max(0.05, Math.min(1.5, Math.min(W / Math.max(1, b.w), H / Math.max(1, b.h)) * 0.96));
    this.zoom = { k, tx: W / 2 - (b.x + b.w / 2) * k, ty: H / 2 - (b.y + b.h / 2) * k };
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

  showTab(t: Tab): void {
    this.tab = t;
    this.renderSide();
  }

  /** Selection context for the element lists, derived from the diagram selection (the single source). */
  selectionContext(): SelectionContext | null {
    const s = this.session;
    return s && s.state.selected ? selectionContext(s.model, s.state.selected) : null;
  }

  private renderOutline(): void {
    this.editor.renderOutline(this.$('outline-body'), this.selectionContext());
  }

  private renderSide(): void {
    const s = this.session;
    const body = this.$('side-body');
    const tabs = this.doc.querySelectorAll('#side .tabs button');
    for (let i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === this.tab);
    const focus = captureFocus(this.doc);
    if (this.tab === 'problems' || !this.mdoc) this.renderProblems(body);
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
    } else if (this.tab === 'legend') mount(body, legendFor(s.viewModel(), s.state.view, s.state.hiddenProtocols));
    else mount(body, relationList(s.model, this.selectionContext()));
    restoreFocus(this.doc, focus);
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
    body.appendChild(
      el(this.doc, 'div', { class: 'yaml-tab' }, [
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

  private renderProblems(body: HTMLElement): void {
    while (body.firstChild) body.removeChild(body.firstChild);
    const d = this.mdoc;
    const all = d ? d.errors.concat(d.warnings) : this.loadErrors;
    if (!all.length) {
      body.appendChild(el(this.doc, 'p', { class: 'muted' }, [d ? '✓ No problems found.' : 'No model open.']));
      return;
    }
    if (d && d.edited) body.appendChild(el(this.doc, 'p', { class: 'muted small' }, ['Line numbers refer to the file as it was opened; the model has been edited since. Click a problem to jump to the object.']));
    body.appendChild(this.issueList(all, d && !d.edited ? this.sourceLines : [], !!d));
  }

  private issueList(issues: Issue[], lines: string[], clickable = false): HTMLElement {
    const ul = el(this.doc, 'ul', { class: 'issues' });
    issues.forEach((is, n) => {
      const loc = is.line > 0 ? `line ${is.line}` : '';
      const li = el(this.doc, 'li', { class: 'issue ' + is.severity + (clickable ? ' clickable' : ''), 'data-issue': String(n) }, [
        el(this.doc, 'div', { class: 'issue-head' }, [
          el(this.doc, 'span', { class: 'sev' }, [is.severity]),
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
    const is = d.errors.concat(d.warnings)[n];
    if (!is) return;
    const ent = d.issueEntity(is);
    if (!ent) this.editor.sel = { kind: 'document', index: 0 };
    else {
      this.editor.sel = { kind: ent.kind, index: ent.index };
      // open the interface the issue is in
      const p = d.issuePath(is) || [];
      const ip = [p.slice(0, 4)].find((x) => !!ifaceSchemaKind(x));
      if (ent.kind === 'device' && ip) {
        this.editor.sel.iface = ip;
        this.editor.openIface(ip);
      }
    }
    this.editorSelected(this.editor.sel);
    this.tab = 'edit';
    this.renderOutline();
    this.renderSide();
    const ref = this.editor.selectedRef();
    if (ref) this.reveal(ref);
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
        el(this.doc, 'button', { type: 'button', class: 'primary', 'data-act-top': 'open' }, ['Open another YAML file…']),
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
      pb.textContent = e + w ? `Problems (${e + w})` : 'Problems';
      pb.classList.toggle('has-errors', e > 0);
    }
    (this.$('btn-undo') as HTMLButtonElement).disabled = !d || !d.canUndo();
    (this.$('btn-redo') as HTMLButtonElement).disabled = !d || !d.canRedo();
    (this.$('btn-download') as HTMLButtonElement).disabled = !d;
    (this.$('btn-close') as HTMLButtonElement).disabled = !d;
    // exporting needs a diagram: a model that could be drawn
    const ex = this.$('btn-export-as') as HTMLButtonElement;
    ex.disabled = !s;
    ex.title = s ? `Save the ${s.state.view} view as a picture: the whole diagram with its legend and networks overview` : 'Open or create a model first';
    if (!s) this.setSubmenu(ex, false);
    for (const fmt of ['png', 'svg']) {
      const b = this.$('btn-export-' + fmt) as HTMLButtonElement;
      b.disabled = !s;
      b.title = s ? `Save the ${s.state.view} view as ${fmt === 'png' ? 'a PNG image' : 'an SVG file'}` : 'Open or create a model first';
    }
    const find = this.$('btn-find') as HTMLButtonElement;
    find.disabled = !s;
    find.title = s ? 'Find a device, interface, network, relation … by id, label, address or protocol (/)' : 'Open or create a model first';
    const olf = this.$('btn-outline-filter') as HTMLButtonElement;
    olf.disabled = !d;
    olf.title = d ? 'Show only the outline entries whose name or id contains a text' : 'Open or create a model first';
    if (!s && this.findOpen) this.closeFind();
    this.$('btn-undo').title = d && d.canUndo() ? `Undo: ${d.canUndo()} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    this.$('btn-redo').title = d && d.canRedo() ? `Redo: ${d.canRedo()} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    const st = this.$('status');
    while (st.firstChild) st.removeChild(st.firstChild);
    if (d) {
      const m = s ? s.model : null;
      // the file name first, as a badge (shortened with "…" when long; the full name is its tooltip), then the rest on one line
      st.appendChild(el(this.doc, 'span', { class: 'fname', title: d.fileName }, [d.fileName]));
      const rest = el(this.doc, 'span', { class: 'status-rest' });
      st.appendChild(rest);
      const parts: Array<HTMLElement | string> = [
        d.dirty ? el(this.doc, 'span', { class: 'dirty' }, ['● unsaved changes']) : '',
        m ? `${m.title} · ${m.devices.length} devices · ${m.index.interfaces.size} interfaces · ${m.links.length} cables · ${m.networks.length} networks · ${m.relations.length} logical relations` : '',
        d.errors.length ? el(this.doc, 'span', { class: 'errcount' }, [`${d.errors.length} error${d.errors.length > 1 ? 's' : ''}`]) : '',
        d.warnings.length ? `${d.warnings.length} warning${d.warnings.length > 1 ? 's' : ''}` : '',
        s && s.isFiltered() ? el(this.doc, 'span', { class: 'filtered-note' }, [`showing ${s.shownDevices().size} of ${s.model.devices.length} devices`]) : '',
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
    const opts: Array<[string, boolean]> = s
      ? [
          ['opt-labels', s.state.showLabels],
          ['opt-groups', s.state.showGroups],
          ['opt-networks', s.state.showNetworks],
        ]
      : [];
    for (const [id, v] of opts) (this.$(id) as HTMLInputElement).checked = v;
    const types = this.doc.querySelectorAll('input[data-device-type]');
    for (let i = 0; i < types.length; i++) {
      const cb = types[i] as HTMLInputElement;
      cb.disabled = !s;
      // a new model starts with every type shown
      cb.checked = !s || !s.isTypeHidden(cb.getAttribute('data-device-type') || '');
    }
    (this.$('btn-arrange') as HTMLButtonElement).disabled = !d || !s;
    this.updateDevicesControl();
    this.updateLayoutStatus();
    this.layoutFilters();
  }

  /**
   * Layout status of the shown view, on the Auto-arrange button itself: an
   * icon, a colour and a message (hover text and accessible description).
   * Always derived from the document (current positions vs. the
   * deterministic Auto-arrange result), never from the last action, so it is
   * right after undo/reload. Both views are tracked independently; the
   * button shows the one on screen.
   */
  private updateLayoutStatus(): void {
    const d = this.mdoc;
    const s = this.session;
    const btn = this.$('btn-arrange') as HTMLButtonElement;
    const icon = btn.querySelector('.arrange-icon') as HTMLElement;
    const desc = this.$('arrange-status');
    const action = 'Auto-arrange recomputes the positions of every object in this view; the other view is not changed (A).';
    for (const v of ['physical', 'logical'] as View[]) {
      // a filtered view has its own, temporary layout status
      if (d && s) btn.setAttribute('data-status-' + v, s.isFiltered() ? s.filteredStatus(v) : d.layoutStatus(v));
      else btn.removeAttribute('data-status-' + v);
    }
    if (!d || !s) {
      btn.removeAttribute('data-status');
      btn.removeAttribute('data-view');
      icon.textContent = '';
      desc.textContent = '';
      btn.title = action;
      return;
    }
    if (s.isFiltered()) {
      // a filtered view: its own, temporary layout; the saved layout of the complete view is not involved
      const fst = s.filteredStatus(s.state.view);
      const msg = FILTERED_STATUS_MESSAGE[fst];
      btn.setAttribute('data-status', fst);
      btn.setAttribute('data-filtered', 'true');
      btn.setAttribute('data-view', s.state.view);
      icon.textContent = LAYOUT_STATUS_ICON[fst];
      if (desc.textContent !== msg) desc.textContent = msg;
      btn.title = msg + ' ' + FILTERED_ACTION;
      return;
    }
    btn.removeAttribute('data-filtered');
    const st = d.layoutStatus(s.state.view);
    btn.setAttribute('data-status', st);
    btn.setAttribute('data-view', s.state.view);
    icon.textContent = LAYOUT_STATUS_ICON[st];
    // the same message for hover and for assistive technology (aria-describedby)
    if (desc.textContent !== LAYOUT_STATUS_MESSAGE[st]) desc.textContent = LAYOUT_STATUS_MESSAGE[st];
    btn.title = LAYOUT_STATUS_MESSAGE[st] + ' ' + action;
  }

  // ------------------------------------------------------------- View menu

  /** Is the Find bar open? */
  get findOpen(): boolean {
    return !this.$('find-bar').hidden;
  }

  /**
   * View → Find… (or "/"): open the Find bar over the top right of the
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
   * View → Filter outline…: show the filter box at the top of the model
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

  /** The filter switches of the toolbar, in page order (Labels … Servers). */
  private filterOpts(): HTMLElement[] {
    return Array.prototype.slice.call(this.doc.querySelectorAll('#view-filters label.opt')) as HTMLElement[];
  }

  /**
   * Keep the diagram filters on one toolbar row. Devices always stays; the
   * switches follow while they fit, by priority (Labels, Groups / Locations,
   * Networks, Endpoints, Servers). The ones that don't fit move into the
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
    if (!btn.hidden && btn.offsetWidth > 0) this.moreBtnWidth = btn.getBoundingClientRect().width;
    const logical = this.doc.body.getAttribute('data-view') === 'logical';
    const shown = (o: HTMLElement): boolean => logical || !o.classList.contains('logical-only');
    const width = (o: HTMLElement): number => this.optWidth.get(o) || 110;
    const btnW = this.moreBtnWidth || 96;
    const devW = devices.getBoundingClientRect().width;
    // the group needs room for Devices and the Filters button at least; with less it moves to a row of its own, as one piece
    box.style.minWidth = Math.ceil(devW + gap + btnW) + 'px';
    const avail = box.clientWidth;
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
    if (btn.hidden) this.openMoreFilters(false);
    const off = collapsed.filter((o) => !(o.querySelector('input') as HTMLInputElement).checked);
    const name = (o: HTMLElement): string => (o.textContent || '').trim();
    this.$('more-filters-count').textContent = off.length ? ` · ${off.length} off` : '';
    btn.classList.toggle('filtered', off.length > 0);
    btn.setAttribute('data-off', String(off.length));
    btn.setAttribute('aria-label', `More diagram filters: ${collapsed.map(name).join(', ')}${off.length ? ` (${off.map(name).join(', ')} off)` : ''}`);
    btn.title = off.length ? `Switched off here: ${off.map(name).join(', ')}` : `More filters: ${collapsed.map(name).join(', ')}`;
  }

  /** Open or close the Filters drop-down; `focus` moves the focus to its first switch (keyboard use). */
  openMoreFilters(open: boolean, focus = false): void {
    const panel = this.$('more-filters');
    const btn = this.$('more-filters-btn') as HTMLButtonElement;
    const show = open && !btn.hidden;
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    btn.classList.toggle('active', show);
    if (!show) return;
    this.openMenu(null);
    this.openDevices(false);
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
    hint.hidden = !filtered;
    const none = filtered && !!s && s.shownDevices().size === 0;
    this.$('filter-hint-text').textContent =
      (none ? (s && s.selectedDevices().size ? 'No devices shown: the selected ones are of types switched off. ' : 'No devices selected: choose devices, or Select all. ') : '') + 'Filtered-view positions are temporary and are not saved in YAML.';
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
      return !d || (b.parentElement as Element).classList.contains('type-hidden') !== s.isTypeHidden(d.type);
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
      const off = s.isTypeHidden(d.type);
      const row = el(this.doc, 'label', { 'data-device-row': d.id, class: off ? 'type-hidden' : '' }, [
        cb,
        el(this.doc, 'span', {}, [name]),
        off ? el(this.doc, 'span', { class: 'dp-off' }, [`hidden: ${deviceTypeLabel(d.type)} off`]) : null,
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
   * Show or hide the devices of one type (the toolbar's Endpoints / Servers
   * controls). Like the device selection it only changes what the diagrams
   * and their exports show; the model, the YAML and the saved layout stay as
   * they are. The other devices keep their places, so the zoom is kept too.
   */
  setTypeVisible(type: string, visible: boolean): boolean {
    const s = this.session;
    if (!s || !s.setTypeVisible(type, visible)) return false;
    this.render();
    this.renderOutline();
    this.updateChrome();
    return true;
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
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
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
    EXAMPLES.forEach((ex, i) => menu.appendChild(el(this.doc, 'button', { type: 'button', role: 'menuitem', 'data-example': String(i), title: `Open the example ${ex.name}` }, [el(this.doc, 'span', { class: 'mi-label' }, [ex.name])])));
    // the start screen's picker names each example by its title
    const pick = this.$('start-example');
    EXAMPLES.forEach((ex, i) => {
      const m = /^title:[ \t]*(.*)$/m.exec(ex.text);
      const title = m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
      pick.appendChild(el(this.doc, 'option', { value: String(i) }, [title || ex.name]));
    });
  }

  // ------------------------------------------------------ dialogs / toasts

  /** Modal dialog (see dialogs.ts); resolves with the clicked button's value. */
  dialog(opts: DialogOpts): Promise<string> {
    return showDialog(this.doc, opts);
  }

  toast(msg: string): void {
    showToast(this.doc, msg);
  }

  // ---------------------------------------------------------------- events

  private wire(): void {
    const doc = this.doc;
    const fileInput = this.$<HTMLInputElement>('file');
    const open = async (): Promise<void> => {
      if (await this.confirmDiscard('Opening another file')) fileInput.click();
    };
    const newModel = async (): Promise<void> => {
      if (await this.confirmDiscard('Creating a new model')) this.newModel();
    };
    this.$('open').addEventListener('click', () => void open());
    this.$('open-empty').addEventListener('click', () => void open());
    this.$('btn-new').addEventListener('click', () => void newModel());
    this.$('new-empty').addEventListener('click', () => void newModel());
    this.$('btn-download').addEventListener('click', () => void this.downloadDialog());
    this.$('btn-close').addEventListener('click', () => void this.closeModelDialog());
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
      if (!f) this.toast('Nothing was opened: drop a YAML file from this computer.');
      else if (await this.confirmDiscard('Opening the dropped file')) void this.loadFile(f);
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
    this.$('btn-export-svg').addEventListener('click', () => void this.exportView('svg'));
    this.$('btn-export-png').addEventListener('click', () => void this.exportView('png'));
    this.$('btn-arrange').addEventListener('click', () => void this.arrangeCurrentView());

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
    const types = doc.querySelectorAll('input[data-device-type]');
    for (let i = 0; i < types.length; i++) {
      const cb = types[i] as HTMLInputElement;
      cb.addEventListener('change', () => this.setTypeVisible(cb.getAttribute('data-device-type') || '', cb.checked));
    }
    this.wireDevices();
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
      const iss = t.closest('[data-issue]');
      if (iss && iss.classList.contains('clickable')) {
        this.gotoIssue(Number(iss.getAttribute('data-issue')));
        return;
      }
      const go = t.closest('[data-goto]');
      if (go) {
        this.select(go.getAttribute('data-goto'), true);
        return;
      }
      void this.editor.onClick(t);
    });
    side.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const p = t.getAttribute('data-proto');
      if (p && this.session) {
        this.session.toggleProtocol(p, t.checked);
        this.render();
        return;
      }
      this.editor.onChange(t);
    });
    side.addEventListener('input', (e) => {
      const t = e.target as HTMLElement;
      if (t.id === 'yaml-src') {
        this.editor.sourceDraft = (t as HTMLTextAreaElement).value;
        this.scheduleYamlMark();
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
    outline.addEventListener('click', (e) => {
      if (this.swallowClick(e)) return;
      void this.editor.onClick(e.target as HTMLElement);
    });
    // Editor buttons act on pointerdown: first commit the field being typed in, then act.
    // (Acting on "click" would lose the click, because committing re-renders the panel.)
    for (const box of [side, outline]) {
      box.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const btn = (e.target as Element).closest('[data-act]') as HTMLElement | null;
        if (!btn) return;
        e.preventDefault();
        this.commitActiveField();
        this.clickHandled = true;
        void this.editor.onClick(btn);
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
    // View menu
    this.$('btn-find').addEventListener('click', () => this.openFind());
    this.$('btn-outline-filter').addEventListener('click', () => this.openOutlineFilter());
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

    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (this.mdoc) void this.downloadDialog();
        return;
      }
      if (typing) return;
      if (mod && !e.altKey) {
        if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
          e.preventDefault();
          this.undo();
        } else if (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey)) {
          e.preventDefault();
          this.redo();
        }
        return;
      }
      if (e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        this.openFind();
      } else if (e.key === 'p' || e.key === '1') this.setView('physical');
      else if (e.key === 'l' || e.key === '2') this.setView('logical');
      else if (e.key === 'e') this.showTab('edit');
      else if (e.key === 'a') void this.arrangeCurrentView();
      else if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-') this.zoomBy(0.8);
      else if (e.key === '0' || e.key === 'f') this.fit();
      else if (e.key === 'Escape') this.select(null);
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
   * Auto-arrange the view on screen; the other view is never touched.
   * Positions that were set by hand are only replaced after a confirmation
   * that says what will change. A view that already shows the auto-arranged
   * layout is left alone without asking.
   */
  async arrangeCurrentView(): Promise<void> {
    const d = this.mdoc;
    const s = this.session;
    if (!d || !s) return;
    const view = s.state.view;
    if (s.isFiltered()) {
      // only the devices shown, in this session only: the saved layout of the complete view is not changed
      const moved = s.arrangeFiltered();
      this.render();
      if (moved) this.fit();
      this.updateChrome();
      this.toast(moved ? `Auto-arranged the filtered ${view} view: ${moved} object${moved > 1 ? 's' : ''} moved. Temporary; the saved layout is unchanged.` : 'Already arranged — nothing moved.');
      return;
    }
    const other: View = view === 'physical' ? 'logical' : 'physical';
    const impact = d.arrangeImpact(view);
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
          { label: `Arrange ${view} view`, value: 'arrange', kind: 'primary' },
        ],
      });
      if (a !== 'arrange') return;
      // the model or the view may have changed while the dialog was open
      if (this.mdoc !== d || this.session !== s || s.state.view !== view) return;
    }
    const res = d.arrange([view]);
    const note = !res.changed
      ? 'Already arranged — nothing moved.'
      : res.moved === 0
        ? 'Positions saved in the model; nothing moved.'
        : `Auto-arranged the ${view} view: ${res.moved} object${res.moved > 1 ? 's' : ''} moved. Undo with Ctrl+Z.`;
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
    let drag: null | { mode: 'pan' | 'node'; ref: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean; id: number } = null;

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
      const nodeRef = node ? node.getAttribute('data-ref') : null;
      if (nodeRef && (nodeRef.indexOf('device:') === 0 || nodeRef.indexOf('network:') === 0)) {
        const w = this.toWorld(e.clientX, e.clientY);
        const center = this.nodeCenter(nodeRef);
        drag = { mode: 'node', ref: nodeRef, sx: e.clientX, sy: e.clientY, ox: center.x - w.x, oy: center.y - w.y, moved: false, id: e.pointerId };
      } else {
        drag = { mode: 'pan', ref, sx: e.clientX, sy: e.clientY, ox: this.zoom.tx, oy: this.zoom.ty, moved: false, id: e.pointerId };
      }
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    svg.addEventListener('pointermove', (e) => {
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
      this.hover(e);
    });
    const end = (e: PointerEvent): void => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      svg.classList.remove('dragging');
      if (!d.moved) {
        const target = (e.target as Element).closest('[data-ref]');
        const ref = target ? target.getAttribute('data-ref') : d.ref;
        this.select(ref && ref.indexOf('hub:') === 0 ? 'relation:' + ref.slice(4) : ref);
      } else if (d.mode === 'node' && d.ref) this.commitDrag(d.ref);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
    });
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
      return;
    }
    let ref = target.getAttribute('data-ref') as string;
    if (ref.indexOf('hub:') === 0) ref = 'relation:' + ref.slice(4);
    const lines = tooltipFor(s.model, ref);
    if (this.errorRefs.has(ref)) lines.push('⚠ has validation errors — see the Edit tab');
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
  private buildExport(): { text: string; width: number; height: number } {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    let b = this.bounds;
    const vp = clone.querySelector('#viewport');
    if (vp) vp.removeAttribute('transform');
    if (this.session) {
      const st = this.session.state;
      // what the picture shows decides what its legend and its networks overview list
      const scene = this.session.render();
      const boxes = exportBoxes(this.session.viewModel(), st.view, st, { root: scene.root, bounds: b });
      clone.appendChild(materialize(boxes.legend.root, this.doc, true));
      clone.appendChild(materialize(boxes.networks.root, this.doc, true));
      b = boxes.viewBox;
    }
    clone.setAttribute('viewBox', `${round(b.x)} ${round(b.y)} ${round(b.w)} ${round(b.h)}`);
    clone.setAttribute('width', String(Math.round(b.w)));
    clone.setAttribute('height', String(Math.round(b.h)));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const style = this.doc.getElementById('app-style');
    const st = this.doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = (style && style.textContent) || '';
    clone.insertBefore(st, clone.firstChild);
    clone.removeAttribute('class');
    clone.setAttribute('class', 'export ' + (this.svg.getAttribute('class') || ''));
    return { text: new XMLSerializer().serializeToString(clone), width: Math.round(b.w), height: Math.round(b.h) };
  }

  /** The view on screen as a PNG: the SVG export, drawn onto the diagram's background colour. */
  exportPng(): Promise<PngPicture> {
    const pic = this.buildExport();
    const win = this.doc.defaultView;
    const bg = win ? win.getComputedStyle(this.$('canvas-wrap')).backgroundColor : '';
    return svgToPng(this.doc, pic.text, pic.width, pic.height, bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff');
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

/** What the Auto-arrange button says about a filtered view (its positions are temporary). */
const FILTERED_STATUS_MESSAGE: { [k in 'auto' | 'manual']: string } = {
  auto: 'This filtered view matches the auto-arranged layout of the devices shown.',
  manual: 'This filtered view has temporarily moved positions. Auto-arrange re-arranges the devices shown.',
};
const FILTERED_ACTION = 'Auto-arrange arranges only the devices shown, for now; the saved layout of the complete view is not changed (A).';

/** What the Auto-arrange button says about the shown view (icon + message, never colour alone). */
const LAYOUT_STATUS_ICON = { auto: '\u2713', manual: '\u270E', edited: '\u25CF' };
const LAYOUT_STATUS_MESSAGE = {
  auto: 'This view matches the auto-arranged layout.',
  manual: 'This view has manually adjusted positions. Auto-arrange replaces them after a confirmation.',
  edited: 'This view no longer matches the auto-arranged layout: the model was edited after it was arranged. Auto-arrange will rearrange it.',
};

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

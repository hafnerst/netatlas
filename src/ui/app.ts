/**
 * Browser UI shell: one page that is both the visualizer and the editor.
 *
 * Everything is local: files are read with the File API after an explicit
 * user action (file picker or drag-and-drop), edited in memory, and saved by
 * letting the browser download a new copy. Nothing is transmitted.
 */
import { ModelDoc, Origin } from '../editor/document';
import { el, mount } from './dom';
import { DialogOpts, Editor, EditorSel } from './inspector';
import { EXAMPLES } from '../generated/examples';
import { Rect } from '../layout/geometry';
import { detailsFor, legendFor, relationList, tooltipFor } from './panels';
import { Session, View, search, splitRef } from '../diagram/session';
import { Issue } from '../validation/validate';
import { DEFAULT_YAML_LIMITS } from '../yaml/parse';

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
  private toastTimer = 0;

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
    if (file.size > DEFAULT_YAML_LIMITS.maxBytes) {
      return this.fail(file.name, [{ severity: 'error', line: 0, path: '', message: `The file is ${(file.size / 1048576).toFixed(1)} MiB; the limit is ${DEFAULT_YAML_LIMITS.maxBytes / 1048576} MiB.` }], []);
    }
    let text: string;
    try {
      const buf = await file.arrayBuffer();
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      return this.fail(file.name, [{ severity: 'error', line: 0, path: '', message: 'The file is not valid UTF-8 text. Save it as UTF-8 and try again.' }], []);
    }
    return this.loadText(text, file.name, 'file');
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
    this.editor.sel = { kind: 'device', index: 0 };
    this.editorSelected(this.editor.sel);
    this.tab = 'edit';
    this.renderSide();
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
    if (note === 'select' && this.tab !== 'edit' && this.tab !== 'details') this.tab = 'edit';
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
    const d = this.mdoc;
    if (!d) return 'network.yaml';
    const base = d.fileName.replace(/\.(ya?ml)$/i, '');
    if (d.origin === 'file') return /-edited$/.test(base) ? base + '.yaml' : base + '-edited.yaml';
    return base + '.yaml';
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
      title: invalid ? 'Download a model that has errors?' : 'Download YAML',
      body,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        invalid ? { label: 'Download anyway', value: 'download', kind: 'danger' } : { label: 'Download', value: 'download', kind: 'primary' },
      ],
    });
    if (a !== 'download') return false;
    let name = nameInput.value.trim() || this.suggestedFileName();
    if (!/\.ya?ml$/i.test(name)) name += '.yaml';
    name = name.replace(/[\\/:*?"<>|]+/g, '_');
    this.downloadText(this.exportText(), name, 'application/yaml');
    d.markSaved();
    this.updateChrome();
    this.toast(`Downloaded “${name}”.`);
    return true;
  }

  /** Offer text as a local download (Blob URL; nothing leaves the machine). */
  downloadText(text: string, name: string, type: string): void {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = this.doc.createElement('a');
    a.href = url;
    a.download = name;
    this.doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
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
    if (ref && this.session.state.selected && this.tab !== 'details') this.tab = 'edit';
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

  private renderOutline(): void {
    this.editor.renderOutline(this.$('outline-body'));
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
      if (s.state.selected) mount(body, detailsFor(s.model, s.state.selected));
      else {
        mount(body, [
          {
            tag: 'div',
            attrs: { class: 'details' },
            children: [
              { tag: 'h3', attrs: {}, children: [], text: s.model.title },
              { tag: 'p', attrs: { class: 'muted' }, children: [], text: s.model.description || '' },
              { tag: 'p', attrs: { class: 'muted' }, children: [], text: 'Click any device, port, cable, tunnel or network to see its details and highlight everything connected to it. Drag devices to rearrange them.' },
            ],
          },
        ]);
      }
    } else if (this.tab === 'legend') mount(body, legendFor(s.model, s.state.view, s.state.hiddenProtocols));
    else mount(body, relationList(s.model));
    restoreFocus(this.doc, focus);
  }

  private renderYaml(body: HTMLElement): void {
    while (body.firstChild) body.removeChild(body.firstChild);
    const d = this.mdoc as ModelDoc;
    const ta = el(this.doc, 'textarea', { id: 'yaml-src', spellcheck: 'false', 'aria-label': 'YAML source of the whole model', wrap: 'off' }) as HTMLTextAreaElement;
    ta.value = this.editor.sourceDraft !== null ? this.editor.sourceDraft : d.exportText();
    body.appendChild(
      el(this.doc, 'div', { class: 'yaml-tab' }, [
        el(this.doc, 'p', { class: 'muted small' }, [
          'The whole model as it will be exported. You can edit it here and press Apply; the forms remain the primary way to edit. Comments and key order are kept.',
        ]),
        this.editor.sourceDraft !== null ? el(this.doc, 'div', { class: 'field-warn' }, ['You have unapplied changes in this text.']) : null,
        this.editor.sourceError ? el(this.doc, 'div', { class: 'field-err' }, [this.editor.sourceError]) : null,
        ta,
        el(this.doc, 'div', { class: 'row-btns' }, [
          el(this.doc, 'button', { type: 'button', class: 'primary', 'data-yaml': 'apply' }, ['Apply']),
          el(this.doc, 'button', { type: 'button', 'data-yaml': 'revert' }, ['Revert to model']),
        ]),
      ]),
    );
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
      const p = d.issuePath(is);
      if (ent.kind === 'device' && p && p[2] === 'interfaces' && typeof p[3] === 'number') this.editor.sel.iface = p[3];
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
    box.appendChild(el(this.doc, 'p', {}, [el(this.doc, 'button', { type: 'button', 'data-act-top': 'new' }, ['Start a new model instead'])]));
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
    this.$('btn-undo').title = d && d.canUndo() ? `Undo: ${d.canUndo()} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    this.$('btn-redo').title = d && d.canRedo() ? `Redo: ${d.canRedo()} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    const st = this.$('status');
    while (st.firstChild) st.removeChild(st.firstChild);
    if (d) {
      const m = s ? s.model : null;
      const parts = [
        el(this.doc, 'span', { class: 'fname' }, [d.fileName]),
        d.dirty ? el(this.doc, 'span', { class: 'dirty' }, [' ● unsaved changes']) : el(this.doc, 'span', { class: 'saved' }, [d.origin === 'file' && !d.edited ? '' : '']),
        ' — ',
        m ? `${m.title} · ${m.devices.length} devices · ${m.index.interfaces.size} interfaces · ${m.links.length} cables · ${m.networks.length} networks · ${m.relations.length} logical relations` : '',
        d.errors.length ? el(this.doc, 'span', { class: 'errcount' }, [` · ${d.errors.length} error${d.errors.length > 1 ? 's' : ''}`]) : '',
        d.warnings.length ? ` · ${d.warnings.length} warning${d.warnings.length > 1 ? 's' : ''}` : '',
        ' · everything stays in this page',
      ];
      for (const p of parts) st.appendChild(typeof p === 'string' ? this.doc.createTextNode(p) : p);
      this.doc.title = `${d.dirty ? '● ' : ''}${m ? m.title : d.fileName} — netatlas`;
    } else {
      st.textContent = this.loadErrors.length ? `${this.loadErrorName}: ${this.loadErrors.length} error(s)` : 'No model open · everything runs locally in this page';
      this.doc.title = 'netatlas';
    }
    const opts: Array<[string, boolean]> = s
      ? [
          ['opt-labels', s.state.showLabels],
          ['opt-networks', s.state.showNetworks],
          ['opt-underlay', s.state.showUnderlay],
        ]
      : [];
    for (const [id, v] of opts) (this.$(id) as HTMLInputElement).checked = v;
    (this.$('btn-arrange') as HTMLButtonElement).disabled = !d || !s;
    this.updateLayoutStatus();
  }

  /**
   * Per-view layout status next to the Auto-arrange button. Always derived
   * from the document (current positions vs. the deterministic Auto-arrange
   * result), never from the last action, so it is right after undo/reload.
   */
  private updateLayoutStatus(): void {
    const d = this.mdoc;
    const s = this.session;
    const texts = { auto: 'Auto-arranged', manual: 'Manually adjusted', edited: 'Edited since arranged' };
    const tips = {
      auto: 'Every object is exactly where Auto-arrange puts it for the current model.',
      manual: 'Some objects were dragged away from their auto-arranged positions. Auto-arrange restores them (undoable).',
      edited:
        'The model changed after the layout was arranged. Existing objects kept their positions and new ones were placed next to their neighbors, so the diagram no longer matches a fresh Auto-arrange. No object was moved by hand.',
    };
    const views: View[] = ['physical', 'logical'];
    for (const v of views) {
      const badge = this.doc.querySelector(`[data-view-status="${v}"]`) as HTMLElement | null;
      if (!badge) continue;
      if (!d || !s) {
        badge.textContent = '';
        badge.className = 'lstat';
        continue;
      }
      const st = d.layoutStatus(v);
      const name = v === 'physical' ? 'Physical' : 'Logical';
      badge.textContent = `${name}: ${texts[st]}`;
      badge.className = `lstat st-${st}${s.state.view === v ? ' current' : ''}`;
      badge.setAttribute('data-status', st);
      badge.title = `${name} view${s.state.view === v ? ' (shown)' : ''}: ${tips[st]}` + (d.hasStoredLayout(v) ? ' Positions are stored in the model and exported with it.' : ' Positions are not stored yet; the file shows the auto-arranged layout.');
    }
  }

  private fillExamples(): void {
    const sel = this.$<HTMLSelectElement>('examples');
    EXAMPLES.forEach((ex, i) => sel.appendChild(el(this.doc, 'option', { value: String(i) }, [ex.name])));
    const list = this.$('example-buttons');
    EXAMPLES.forEach((ex, i) => list.appendChild(el(this.doc, 'button', { type: 'button', class: 'linkish', 'data-example': String(i) }, [ex.name])));
  }

  // ------------------------------------------------------ dialogs / toasts

  /** Modal dialog built from text nodes; resolves with the clicked button's value ("cancel" on Esc). */
  dialog(opts: DialogOpts): Promise<string> {
    const dlg = this.$('modal') as HTMLDialogElement;
    while (dlg.firstChild) dlg.removeChild(dlg.firstChild);
    const form = el(this.doc, 'div', { class: 'modal-inner' });
    form.appendChild(el(this.doc, 'h2', {}, [opts.title]));
    const bodyEl = el(this.doc, 'div', { class: 'modal-body' });
    for (const b of opts.body) bodyEl.appendChild(typeof b === 'string' ? this.doc.createTextNode(b) : b);
    form.appendChild(bodyEl);
    const btns = el(this.doc, 'div', { class: 'modal-btns' });
    form.appendChild(btns);
    dlg.appendChild(form);
    return new Promise((resolve) => {
      const done = (v: string): void => {
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(v);
      };
      const onCancel = (e: Event): void => {
        e.preventDefault();
        done('cancel');
      };
      dlg.addEventListener('cancel', onCancel);
      for (const b of opts.buttons) {
        const btn = el(this.doc, 'button', { type: 'button', class: b.kind || '', 'data-value': b.value }, [b.label]);
        btn.addEventListener('click', () => done(b.value));
        btns.appendChild(btn);
      }
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
      const primary = btns.querySelector('.primary, .danger') as HTMLElement | null;
      if (primary && !bodyEl.querySelector('input')) primary.focus();
      else {
        const inp = bodyEl.querySelector('input') as HTMLInputElement | null;
        if (inp) {
          inp.focus();
          inp.select();
        }
      }
    });
  }

  toast(msg: string): void {
    const t = this.$('toast');
    t.textContent = msg;
    t.hidden = false;
    const win = this.doc.defaultView;
    if (win) {
      win.clearTimeout(this.toastTimer);
      this.toastTimer = win.setTimeout(() => {
        t.hidden = true;
      }, 3500);
    }
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
    this.$('btn-undo').addEventListener('click', () => this.undo());
    this.$('btn-redo').addEventListener('click', () => this.redo());
    this.$('btn-outline').addEventListener('click', () => doc.body.classList.toggle('no-outline'));
    this.$('errors').addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-act-top="new"]')) this.newModel();
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) void this.loadFile(f);
      fileInput.value = '';
    });
    this.$<HTMLSelectElement>('examples').addEventListener('change', async (e) => {
      const sel = e.target as HTMLSelectElement;
      const v = sel.value;
      sel.value = '';
      if (v !== '' && (await this.confirmDiscard('Loading an example'))) this.loadExample(Number(v));
    });
    this.$('example-buttons').addEventListener('click', (e) => {
      const t = (e.target as Element).closest('[data-example]');
      if (t) this.loadExample(Number(t.getAttribute('data-example')));
    });

    // drag & drop a file anywhere
    doc.addEventListener('dragover', (e) => {
      e.preventDefault();
      doc.body.classList.add('dropping');
    });
    doc.addEventListener('dragleave', (e) => {
      if (!(e as DragEvent).relatedTarget) doc.body.classList.remove('dropping');
    });
    doc.addEventListener('drop', async (e) => {
      e.preventDefault();
      doc.body.classList.remove('dropping');
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f && (await this.confirmDiscard('Opening the dropped file'))) void this.loadFile(f);
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
    this.$('save-svg').addEventListener('click', () => this.downloadSvg());
    this.$('btn-arrange').addEventListener('click', () => void this.arrangeDialog());

    const opt = (id: string, fn: (v: boolean) => void): void => {
      this.$<HTMLInputElement>(id).addEventListener('change', (e) => {
        if (!this.session) return;
        fn((e.target as HTMLInputElement).checked);
        this.render();
      });
    };
    opt('opt-labels', (v) => this.session && (this.session.state.showLabels = v));
    opt('opt-networks', (v) => this.session && (this.session.state.showNetworks = v));
    opt('opt-underlay', (v) => this.session && (this.session.state.showUnderlay = v));

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
      if (t.id === 'yaml-src') this.editor.sourceDraft = (t as HTMLTextAreaElement).value;
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
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = results.querySelector('[data-goto]');
        if (first) this.select(first.getAttribute('data-goto'), true);
        closeResults();
      } else if (e.key === 'Escape') {
        q.value = '';
        closeResults();
        q.blur();
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
        q.focus();
      } else if (e.key === 'p' || e.key === '1') this.setView('physical');
      else if (e.key === 'l' || e.key === '2') this.setView('logical');
      else if (e.key === 'e') this.showTab('edit');
      else if (e.key === 'a') void this.arrangeDialog();
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
    if (win) win.addEventListener('resize', () => this.applyZoom());
  }

  // ------------------------------------------------------------- layout

  /** A node was dragged: store its new position in the document (one undo step). */
  private commitDrag(ref: string): void {
    const s = this.session;
    const d = this.mdoc;
    if (!s || !d) return;
    const view = s.state.view;
    const p = s.state.positions[view].get(ref);
    if (!p) return;
    const id = ref.slice(ref.indexOf(':') + 1);
    const hadLayout = d.hasStoredLayout(view);
    if (d.movePositions(view, new Map([[id, p]]), `Move ${id}`)) {
      this.afterEdit(hadLayout ? undefined : `Positions of the ${view} view are now saved in the model (layout section). Undo with Ctrl+Z.`);
    }
  }

  /** Explain the scope of Auto-arrange, let the user choose the view(s), then arrange. */
  async arrangeDialog(): Promise<void> {
    const d = this.mdoc;
    const s = this.session;
    if (!d || !s) return;
    const view = s.state.view;
    const other: View = view === 'physical' ? 'logical' : 'physical';
    const counts = { physical: d.displayedPositions('physical').size, logical: d.displayedPositions('logical').size };
    const body: Array<Node | string> = [
      el(this.doc, 'p', {}, [
        'Auto-arrange repositions every object of the whole model in the chosen view — including objects that are hidden by filters or outside the visible area. ' +
          'The layout is deterministic: the same model always gives the same positions, whatever you moved before.',
      ]),
      el(this.doc, 'ul', { class: 'arrange-scope' }, [
        el(this.doc, 'li', {}, [`Physical view: ${counts.physical} devices (group boxes follow their devices) — currently ${statusText(d.layoutStatus('physical'))}`]),
        el(this.doc, 'li', {}, [`Logical view: ${counts.logical} devices, networks and hubs — currently ${statusText(d.layoutStatus('logical'))}`]),
      ]),
      el(this.doc, 'p', { class: 'muted' }, ['The positions are stored in the model’s layout section and exported with the YAML. Undo with Ctrl+Z.']),
    ];
    const a = await this.dialog({
      title: 'Auto-arrange',
      body,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Arrange both views', value: 'both' },
        { label: `Arrange ${view} view only`, value: view, kind: 'primary' },
      ],
    });
    if (a === 'cancel') return;
    const views: View[] = a === 'both' ? [view, other] : [view];
    const res = d.arrange(views);
    const note = !res.changed
      ? 'Already arranged — nothing moved.'
      : res.moved === 0
        ? 'Positions saved in the model; nothing moved.'
        : `Auto-arranged: ${res.moved} object${res.moved > 1 ? 's' : ''} moved. Undo with Ctrl+Z.`;
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

  /** Serialize the current diagram as a standalone SVG string (for "Save SVG"). */
  exportSvg(): string {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    const b = this.bounds;
    const vp = clone.querySelector('#viewport');
    if (vp) vp.removeAttribute('transform');
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
    return new XMLSerializer().serializeToString(clone);
  }

  downloadSvg(): void {
    if (!this.session || !this.mdoc) return;
    const base = this.mdoc.fileName.replace(/\.[^.]*$/, '') || 'netatlas';
    this.downloadText(this.exportSvg(), base + '-' + this.session.state.view + '.svg', 'image/svg+xml');
  }
}

function statusText(st: 'auto' | 'manual' | 'edited'): string {
  return st === 'auto' ? '“Auto-arranged”' : st === 'manual' ? '“Manually adjusted”' : '“Edited since arranged”';
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

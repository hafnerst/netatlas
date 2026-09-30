/**
 * The editable document: the YAML tree itself is the single source of truth.
 *
 * Every edit changes the tree in place (so comments, key order and any key
 * the editor does not know about survive), is undoable, marks the document
 * dirty and re-validates. Export serializes the tree with yaml-write.ts.
 * This module has no DOM dependency and is fully testable in Node.
 */
import { Pt } from '../layout/geometry';
import { LAYOUT_VIEWS, LayoutView, autoPositions, resolvePositions, samePositions } from '../layout/positions';
import { layoutInput, layoutSignature } from '../layout/input';
import { parseAddress } from '../model/ip';
import { Model } from '../model/types';
import { IFACE_RE, Issue, LoadResult, loadModel, scalarText, validate } from '../validation/validate';
import { SCHEMA } from '../yaml/schema';
import { DEFAULT_YAML_LIMITS, YMap, YNode, YSeq, autoNode, boolNode, cloneNode, mapNode, nullNode, numNode, seqNode, strNode } from '../yaml/parse';
import { stringifyYaml } from '../yaml/write';
import { rawLayoutKeys, rawManualIds, writeLayout, writeManual } from './layout-section';
import { keepTrivia, sameSet, setKey } from './tree';

export { setKey };

/**
 * Read-only view of the document tree for the UI. The document IS the YAML
 * tree (that is what keeps comments, order and unknown keys intact), but the
 * UI only reads it through these aliases and changes it through ModelDoc's
 * editing operations; it never imports the YAML layer.
 */
export type DocNode = YNode;
export type DocMap = YMap;

/** Largest file the editor opens (checked before reading it). */
export const MAX_INPUT_BYTES = DEFAULT_YAML_LIMITS.maxBytes;

export type PathSeg = string | number;
export type Path = PathSeg[];

export type EntityKind = 'protocol' | 'group' | 'device' | 'link' | 'network' | 'relation';
export const ENTITY_KINDS: EntityKind[] = ['device', 'link', 'network', 'relation', 'group', 'protocol'];
export const SECTION: { [k in EntityKind]: string } = {
  protocol: 'protocols',
  group: 'groups',
  device: 'devices',
  link: 'links',
  network: 'networks',
  relation: 'relations',
};
export function kindOfSection(section: string): EntityKind | null {
  for (const k of ENTITY_KINDS) if (SECTION[k] === section) return k;
  return null;
}

/** Canonical key order used when the editor adds keys (existing order is never changed). */
export const KEY_ORDER: { [k: string]: string[] } = SCHEMA;

export type Origin = 'new' | 'file' | 'example';

/** "New" starts from an empty model: nothing is created that the user did not choose. */
export const NEW_MODEL_YAML = `netatlas: 1
title: New network
`;

const MAX_UNDO = 100;




export interface EntityRef {
  kind: EntityKind;
  index: number;
  id: string | null;
  node: YNode;
}

export class ModelDoc {
  root: YMap;
  fileName: string;
  origin: Origin;
  dirty = false;
  /** increments on every change; lets views know when to refresh */
  version = 0;
  result: LoadResult;
  private undoStack: Array<{ root: YMap; label: string }> = [];
  private redoStack: Array<{ root: YMap; label: string }> = [];
  private paths = new Map<YNode, Path>();
  /** true once the document differs structurally from the loaded file (line numbers become stale) */
  edited = false;
  /** id renames performed during the current change (old -> new), for layout maintenance */
  private renames = new Map<string, string>();

  constructor(root: YMap, fileName: string, origin: Origin) {
    this.root = root;
    this.fileName = fileName;
    this.origin = origin;
    this.result = this.revalidate();
  }

  /** A new, valid, minimal model. */
  static create(): ModelDoc {
    const d = ModelDoc.fromText(NEW_MODEL_YAML, 'new-network.yaml', 'new');
    return d.doc as ModelDoc;
  }

  /**
   * Parse text into a document. YAML syntax errors (or a document that is not
   * a mapping) are returned as `error`: such input cannot be edited safely.
   * Validation errors are fine: they are shown while editing.
   */
  static fromText(text: string, fileName: string, origin: Origin): { doc?: ModelDoc; errors: Issue[] } {
    const res = loadModel(text);
    if (!res.root) return { errors: res.errors };
    if (res.root.kind !== 'map') {
      return { errors: [{ severity: 'error', line: res.root.line || 1, path: '', message: 'the document must be a mapping starting with "netatlas: 1"' }] };
    }
    return { doc: new ModelDoc(res.root, fileName, origin), errors: [] };
  }

  // ------------------------------------------------------------ validation

  private revalidate(): LoadResult {
    this.result = validate(this.root);
    this.paths.clear();
    const walk = (n: YNode, p: Path): void => {
      this.paths.set(n, p);
      if (n.kind === 'seq') n.items.forEach((c, i) => walk(c, p.concat(i)));
      else if (n.kind === 'map') n.entries.forEach((e, k) => walk(e.value, p.concat(k)));
    };
    walk(this.root, []);
    return this.result;
  }

  get errors(): Issue[] {
    return this.result.errors;
  }
  get warnings(): Issue[] {
    return this.result.warnings;
  }
  get valid(): boolean {
    return this.result.errors.length === 0;
  }

  pathOf(n: YNode | undefined): Path | null {
    if (!n) return null;
    const p = this.paths.get(n);
    return p ? p : null;
  }

  /** Path an issue is about (for a missing/unknown key: the key's path). */
  issuePath(is: Issue): Path | null {
    const p = this.pathOf(is.node);
    if (!p) return null;
    return is.key !== undefined ? p.concat(is.key) : p;
  }

  /** Issues located at or below `path`. */
  issuesAt(path: Path, exact = false): Issue[] {
    const all = this.result.errors.concat(this.result.warnings);
    return all.filter((is) => {
      const p = this.issuePath(is);
      if (!p || p.length < path.length) return false;
      if (exact && p.length !== path.length) return false;
      for (let i = 0; i < path.length; i++) if (p[i] !== path[i]) return false;
      return true;
    });
  }

  /** Entity (section + index) an issue belongs to, if any. */
  issueEntity(is: Issue): { kind: EntityKind; index: number } | null {
    const p = this.issuePath(is);
    if (!p || p.length < 2) return null;
    const kind = kindOfSection(String(p[0]));
    return kind && typeof p[1] === 'number' ? { kind, index: p[1] } : null;
  }

  // ------------------------------------------------------------- tree access

  get(path: Path): YNode | undefined {
    let n: YNode | undefined = this.root;
    for (const seg of path) {
      if (!n) return undefined;
      if (typeof seg === 'number') n = n.kind === 'seq' ? n.items[seg] : undefined;
      else n = n.kind === 'map' ? (n.entries.get(seg) || { value: undefined }).value : undefined;
    }
    return n;
  }

  text(path: Path): string | undefined {
    const n = this.get(path);
    return n ? scalarText(n) : undefined;
  }

  // ------------------------------------------------------------ transactions

  /**
   * Run a mutation as one undoable step. Returns the callback's result.
   *
   * Unless `opts.layout` is false, positions are kept stable: if the edit
   * changes anything that affects the diagram geometry, the positions that
   * were displayed before the edit are written to the `layout` section (in
   * the same undo step), new nodes are placed next to their neighbors and
   * positions of removed nodes are dropped. Nothing ever re-arranges itself.
   */
  change<T>(label: string, fn: () => T, opts: { layout?: boolean } = {}): T {
    const snapshot = cloneNode(this.root);
    const pre = this.result.model;
    this.renames = new Map();
    const out = fn();
    this.undoStack.push({ root: snapshot, label });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.revalidate();
    if (opts.layout !== false && pre) this.maintainLayout(pre);
    this.markChanged();
    return out;
  }

  private markChanged(): void {
    this.dirty = true;
    this.edited = true;
    this.version++;
  }

  private touch(): void {
    this.revalidate();
    this.markChanged();
  }

  // ---------------------------------------------------------------- layout

  /** Positions that are displayed for a view (stored, else auto-arranged). */
  displayedPositions(view: LayoutView): Map<string, Pt> {
    const m = this.result.model;
    return m ? resolvePositions(view, layoutInput(m), m.layout[view]) : new Map();
  }

  /** Does the document store positions for this view? */
  hasStoredLayout(view: LayoutView): boolean {
    const m = this.result.model;
    return !!m && m.layout[view].size > 0;
  }

  private maintainLayout(pre: Model): void {
    const post = this.result.model;
    if (!post) return;
    const preIn = layoutInput(pre);
    const postIn = layoutInput(post);
    if (layoutSignature(preIn) === layoutSignature(postIn)) return;
    let changed = false;
    for (const view of LAYOUT_VIEWS) {
      const shown = resolvePositions(view, preIn, pre.layout[view]);
      const base = new Map<string, Pt>();
      shown.forEach((p, id) => base.set(this.renames.get(id) || id, p));
      const next = resolvePositions(view, postIn, base);
      // also rewrite when the file still holds entries for nodes that no longer exist
      const raw = rawLayoutKeys(this.root, view);
      const stale = raw.some((id) => !next.has(id));
      if (stale || !samePositions(next, post.layout[view])) {
        writeLayout(this.root, view, next);
        changed = true;
      }
      // the record of hand-placed nodes follows renames and forgets removed nodes
      const manual = new Set<string>();
      pre.layout.manual[view].forEach((id) => {
        const nid = this.renames.get(id) || id;
        if (next.has(nid)) manual.add(nid);
      });
      post.layout.manual[view].forEach((id) => {
        if (next.has(id)) manual.add(id);
      });
      if (!sameSet(manual, post.layout.manual[view]) || rawManualIds(this.root, view).some((id) => !next.has(id))) {
        writeManual(this.root, view, manual);
        changed = true;
      }
    }
    if (changed) this.revalidate();
  }

  // ------------------------------------------------------------ layout status

  private autoMemo = new Map<string, Map<string, Pt>>();

  /** Auto-arrange result for the current model (cached per layout signature). */
  autoLayout(view: LayoutView): Map<string, Pt> {
    const m = this.result.model;
    if (!m) return new Map();
    const input = layoutInput(m);
    const key = view + '\n' + layoutSignature(input);
    let r = this.autoMemo.get(key);
    if (!r) {
      r = autoPositions(view, input);
      // keep only the latest result per view
      Array.from(this.autoMemo.keys()).forEach((k) => {
        if (k.indexOf(view + '\n') === 0) this.autoMemo.delete(k);
      });
      this.autoMemo.set(key, r);
    }
    return r;
  }

  /**
   * Does the diagram of a view match Auto-arrange for the current model?
   *   'auto'    every node is exactly where Auto-arrange puts it;
   *   'manual'  at least one node that was placed by hand differs from it;
   *   'edited'  it differs only because the model changed after arranging
   *             (edits keep existing positions stable instead of re-arranging).
   * Derived from the document every time: it is correct after undo, reload,
   * or when nodes are back at their calculated positions.
   */
  layoutStatus(view: LayoutView): 'auto' | 'manual' | 'edited' {
    const m = this.result.model;
    if (!m || m.layout[view].size === 0) return 'auto';
    const auto = this.autoLayout(view);
    const shown = this.displayedPositions(view);
    const differing: string[] = [];
    shown.forEach((p, id) => {
      const q = auto.get(id);
      if (!q || q.x !== p.x || q.y !== p.y) differing.push(id);
    });
    if (!differing.length) return 'auto';
    return differing.some((id) => m.layout.manual[view].has(id)) ? 'manual' : 'edited';
  }





  /**
   * What Auto-arrange would do to one view, without doing it:
   *   moved   nodes whose displayed position would change;
   *   manual  of those, the nodes that were placed by hand (their positions would be overwritten).
   * Both are empty when the view already shows the auto-arranged layout.
   */
  arrangeImpact(view: LayoutView): { moved: string[]; manual: string[] } {
    const m = this.result.model;
    if (!m) return { moved: [], manual: [] };
    const auto = this.autoLayout(view);
    const shown = this.displayedPositions(view);
    const moved: string[] = [];
    auto.forEach((p, id) => {
      const q = shown.get(id);
      if (!q || q.x !== p.x || q.y !== p.y) moved.push(id);
    });
    moved.sort();
    return { moved, manual: moved.filter((id) => m.layout.manual[view].has(id)) };
  }

  /**
   * Auto-arrange: compute the deterministic layout of the whole model for the
   * given views and store it (one undo step). A view that is not listed is
   * not touched. Returns how many nodes moved on screen; nothing is changed
   * at all if the stored layout already equals the auto-arrange result.
   */
  arrange(views: LayoutView[]): { changed: boolean; moved: number } {
    const m = this.result.model;
    if (!m) return { changed: false, moved: 0 };
    const targets = new Map<LayoutView, Map<string, Pt>>();
    let moved = 0;
    for (const v of views) {
      const auto = this.autoLayout(v);
      moved += this.arrangeImpact(v).moved.length;
      if (!samePositions(auto, m.layout[v])) targets.set(v, auto);
    }
    if (!targets.size) return { changed: false, moved: 0 };
    const label = views.length > 1 ? 'Auto-arrange (both views)' : `Auto-arrange (${views[0]} view)`;
    this.change(
      label,
      () =>
        targets.forEach((pos, v) => {
          writeLayout(this.root, v, pos);
          writeManual(this.root, v, new Set());
        }),
      { layout: false },
    );
    return { changed: true, moved };
  }

  /** Store manual positions (a drag). The rest of the view keeps its displayed positions. */
  movePositions(view: LayoutView, updates: Map<string, Pt>, label = 'Move'): boolean {
    const m = this.result.model;
    if (!m) return false;
    const next = new Map(resolvePositions(view, layoutInput(m), m.layout[view]));
    updates.forEach((p, id) => {
      if (next.has(id)) next.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
    });
    if (samePositions(next, m.layout[view])) return false;
    const manual = new Set(m.layout.manual[view]);
    updates.forEach((_, id) => {
      if (next.has(id)) manual.add(id);
    });
    // a node put back exactly where Auto-arrange places it is no longer "placed by hand"
    const auto = this.autoLayout(view);
    Array.from(manual).forEach((id) => {
      const p = next.get(id);
      const q = auto.get(id);
      if (!p || (q && q.x === p.x && q.y === p.y)) manual.delete(id);
    });
    this.change(
      label,
      () => {
        writeLayout(this.root, view, next);
        writeManual(this.root, view, manual);
      },
      { layout: false },
    );
    return true;
  }

  /** Remove all stored positions (the diagram then shows the auto-arrange result). */
  clearLayout(): boolean {
    if (!this.root.entries.has('layout')) return false;
    this.change('Remove stored positions', () => this.root.entries.delete('layout'), { layout: false });
    return true;
  }

  canUndo(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
  }
  canRedo(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }
  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push({ root: this.root, label: s.label });
    this.root = s.root;
    this.touch();
    return true;
  }
  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push({ root: this.root, label: s.label });
    this.root = s.root;
    this.touch();
    return true;
  }

  markSaved(): void {
    this.dirty = false;
  }

  exportText(): string {
    return stringifyYaml(this.root);
  }

  /** Replace the whole document (used by the YAML source editor). */
  replaceRoot(root: YMap, label = 'Edit YAML source'): void {
    // the text is taken literally, including its layout section
    this.change(
      label,
      () => {
        this.root = root;
      },
      { layout: false },
    );
  }

  // -------------------------------------------------------- low-level edits

  /** The mapping at `path`, creating it (and converting "- eth0" shorthand) if needed. */
  ensureMap(path: Path, order?: string[]): YMap {
    if (!path.length) return this.root;
    const parentPath = path.slice(0, -1);
    const seg = path[path.length - 1];
    const cur = this.get(path);
    if (cur && cur.kind === 'map') return cur;
    let replacement: YMap;
    if (cur && cur.kind === 'scalar' && typeof seg === 'number' && String(parentPath[parentPath.length - 1]) === 'interfaces') {
      replacement = mapNode([['id', strNode(scalarText(cur) || '')]], true);
    } else if (cur && cur.kind === 'scalar' && scalarText(cur) !== undefined && (this.isLinkEnd(path) || (typeof seg === 'number' && parentPath[parentPath.length - 1] === 'endpoints'))) {
      // "dev:if" endpoint shorthand -> {device, interface}
      const t = scalarText(cur) as string;
      const i = t.indexOf(':');
      const e: Array<[string, YNode]> = [['device', strNode(i < 0 ? t : t.slice(0, i))]];
      if (i >= 0) e.push(['interface', strNode(t.slice(i + 1))]);
      replacement = mapNode(e, true);
    } else {
      replacement = mapNode();
    }
    keepTrivia(cur, replacement);
    this.put(parentPath, seg, replacement, order);
    return replacement;
  }

  /** The list at `path`, creating it if needed (a scalar becomes a one-element list). */
  ensureSeq(path: Path, flow = false, order?: string[]): YSeq {
    const cur = this.get(path);
    if (cur && cur.kind === 'seq') return cur;
    const s = seqNode([], flow);
    if (cur && cur.kind === 'scalar' && scalarText(cur) !== undefined) {
      const item = cloneNode(cur);
      delete item.comment;
      delete item.before;
      delete item.blank;
      s.items.push(item);
      s.flow = true;
    }
    keepTrivia(cur, s);
    this.put(path.slice(0, -1), path[path.length - 1], s, order);
    return s;
  }

  /** Put `value` at parent[seg]; parent must exist (maps are created for string segments). */
  private put(parentPath: Path, seg: PathSeg, value: YNode, order?: string[]): void {
    if (typeof seg === 'number') {
      const parent = this.get(parentPath);
      if (!parent || parent.kind !== 'seq') throw new Error('not a list: ' + parentPath.join('.'));
      value = keepTrivia(parent.items[seg], value);
      parent.items[seg] = value;
      return;
    }
    const parent = parentPath.length ? this.ensureMap(parentPath) : this.root;
    setKey(parent, seg, value, order || (parentPath.length === 0 ? KEY_ORDER.top : undefined));
  }

  /** Set the value at `path` (not undoable by itself: call inside change()). */
  setAt(path: Path, value: YNode, order?: string[]): void {
    this.put(path.slice(0, -1), path[path.length - 1], value, order);
  }

  /** Remove a key or list item. */
  removeAt(path: Path): void {
    const parent = this.get(path.slice(0, -1));
    const seg = path[path.length - 1];
    if (!parent) return;
    if (parent.kind === 'seq' && typeof seg === 'number') {
      const removed = parent.items.splice(seg, 1)[0];
      // keep a section comment that sat above the removed item
      if (removed && removed.before && parent.items[seg] && !parent.items[seg].before) parent.items[seg].before = removed.before;
    } else if (parent.kind === 'map' && typeof seg === 'string') {
      parent.entries.delete(seg);
    }
  }

  /** Rename a key in place (keeps order); fails if the new key exists. */
  renameKey(mapPath: Path, oldKey: string, newKey: string): boolean {
    const m = this.get(mapPath);
    if (!m || m.kind !== 'map' || !m.entries.has(oldKey) || (oldKey !== newKey && m.entries.has(newKey)) || newKey === '') return false;
    const rebuilt = new Map<string, { key: string; keyLine: number; value: YNode }>();
    m.entries.forEach((e, k) => {
      if (k === oldKey) rebuilt.set(newKey, { key: newKey, keyLine: e.keyLine, value: e.value });
      else rebuilt.set(k, e);
    });
    m.entries = rebuilt;
    return true;
  }

  moveItem(seqPath: Path, from: number, to: number): void {
    const s = this.get(seqPath);
    if (!s || s.kind !== 'seq' || to < 0 || to >= s.items.length) return;
    const [it] = s.items.splice(from, 1);
    s.items.splice(to, 0, it);
  }

  // ------------------------------------------------- editing operations (UI)
  // Named, undoable operations used by the editor UI. They take plain values
  // (text, flags, kinds) and decide how they are represented in YAML, so the
  // UI never builds YAML nodes. New keys go into the canonical schema order,
  // which is derived from the path.

  /** Is `path` one end of a physical link (links[i].a / links[i].b)? */
  private isLinkEnd(path: Path): boolean {
    return path.length === 3 && path[0] === 'links' && typeof path[1] === 'number' && (path[2] === 'a' || path[2] === 'b');
  }

  /** Schema kind of the mapping at `path` (for key order), if the format defines one. */
  schemaKindOf(path: Path): string | undefined {
    if (path.length === 0) return 'top';
    if (path.length === 2 && typeof path[1] === 'number') return kindOfSection(String(path[0])) || undefined;
    const ik = ifaceSchemaKind(path);
    if (ik) return ik;
    if (path.length === 4 && typeof path[3] === 'number' && path[0] === 'relations' && path[2] === 'endpoints') return 'endpoint';
    if (this.isLinkEnd(path)) return 'linkEnd';
    if (path.length === 1 && path[0] === 'layout') return 'layout';
    return undefined;
  }

  private orderFor(parentPath: Path): string[] | undefined {
    const k = this.schemaKindOf(parentPath);
    return k ? KEY_ORDER[k] : undefined;
  }

  private label(path: Path): string {
    const last = path[path.length - 1];
    return typeof last === 'number' ? String(path[path.length - 2]) : String(last);
  }

  /** Set a text field; empty text removes the key (or list item). */
  setText(path: Path, text: string): void {
    this.change('Edit ' + this.label(path), () => {
      if (text === '') this.removeAt(path);
      else this.setAt(path, strNode(text), this.orderFor(path.slice(0, -1)));
    });
  }

  /** Set an integer field (text that isn't an integer is kept as text and reported by validation). */
  setInteger(path: Path, text: string): void {
    this.change('Edit ' + this.label(path), () => {
      if (text === '') this.removeAt(path);
      else this.setAt(path, /^-?[0-9]+$/.test(text) ? numNode(Number(text)) : strNode(text), this.orderFor(path.slice(0, -1)));
    });
  }

  /** Set a boolean flag; false removes it (the format's default). */
  setFlag(path: Path, on: boolean): void {
    this.change('Edit ' + this.label(path), () => {
      if (on) this.setAt(path, boolNode(true), this.orderFor(path.slice(0, -1)));
      else this.removeAt(path);
    });
  }

  /** Set a free-form value typed like YAML would type it ("42" number, "true" boolean …); empty = null. */
  setValue(path: Path, text: string): void {
    this.change('Edit value', () => this.setAt(path, text === '' ? nullNode() : autoNode(text), this.orderFor(path.slice(0, -1))));
  }

  /** Append text to a list (created as [a, b] if missing; a single value becomes a list). */
  appendText(listPath: Path, text: string, label = 'Add ' + this.label(listPath)): void {
    this.change(label, () => {
      this.ensureSeq(listPath, true, this.orderFor(listPath.slice(0, -1))).items.push(strNode(text));
    });
  }

  /**
   * Point an endpoint (link end or relation endpoint) at a device and
   * optional interface. Short forms ("dev", "dev:if") stay short;
   * an endpoint written as a mapping keeps its other keys. An empty device
   * removes the endpoint.
   */
  setEndpoint(path: Path, device: string, iface: string): void {
    const node = this.get(path);
    this.change('Edit endpoint', () => {
      if (!device) {
        this.removeAt(path);
        return;
      }
      if (node && node.kind === 'map') {
        const m = this.ensureMap(path);
        const order = KEY_ORDER[this.schemaKindOf(path) || 'endpoint'];
        this.setAt(path.concat('device'), strNode(device), order);
        if (iface) this.setAt(path.concat('interface'), strNode(iface), order);
        else m.entries.delete('interface');
      } else {
        this.setAt(path, strNode(iface ? device + ':' + iface : device), this.orderFor(path.slice(0, -1)));
      }
    });
  }

  /** Set role / address of an endpoint (expands a short endpoint to a mapping); empty removes it. */
  setEndpointField(path: Path, text: string): void {
    const ep = path.slice(0, -1);
    this.change('Edit endpoint', () => {
      if (text === '') {
        const m = this.get(ep);
        if (m && m.kind === 'map') m.entries.delete(String(path[path.length - 1]));
      } else {
        this.ensureMap(ep);
        this.setAt(path, strNode(text), KEY_ORDER.endpoint);
      }
    });
  }

  /** VLAN IDs written on one end of a link, as text, in file order (invalid entries included). */
  endVlans(endPath: Path): string[] {
    const n = this.get(endPath.concat('vlans'));
    if (!n) return [];
    if (n.kind === 'seq') return n.items.map((i) => scalarText(i)).filter((x): x is string => x !== undefined);
    const t = scalarText(n);
    return t === undefined ? [] : [t];
  }

  /**
   * Permit more VLANs at one end of a link (`endPath` is links[i].a or .b).
   * Only that end is written: the other end is never adjusted to match. The
   * short "dev:if" form becomes a mapping; ids already listed are skipped.
   * Returns false if the end has no device yet.
   */
  addEndVlans(endPath: Path, ids: number[]): boolean {
    const cur = this.get(endPath);
    if (!cur || (cur.kind === 'scalar' && scalarText(cur) === undefined)) return false;
    const have = this.endVlans(endPath);
    const add = ids.filter((v, k) => have.indexOf(String(v)) < 0 && ids.indexOf(v) === k);
    if (!add.length) return true;
    this.change('Add VLAN', () => {
      this.ensureMap(endPath);
      const list = this.ensureSeq(endPath.concat('vlans'), true, KEY_ORDER.linkEnd);
      for (const v of add) list.items.push(numNode(v));
      // keep the list ascending when every entry is a number (nothing invalid is reordered or dropped)
      if (list.items.every((i) => i.kind === 'scalar' && typeof i.value === 'number')) {
        list.items.sort((p, q) => ((p as { value: number }).value) - ((q as { value: number }).value));
      }
    });
    return true;
  }

  /** Remove one VLAN (by its text) from one end of a link; the last one removes the `vlans` key. */
  removeEndVlan(endPath: Path, id: string): void {
    const vp = endPath.concat('vlans');
    const n = this.get(vp);
    if (!n) return;
    this.change('Remove VLAN', () => {
      if (n.kind === 'seq') {
        const k = n.items.findIndex((i) => scalarText(i) === id);
        if (k >= 0) n.items.splice(k, 1);
        if (n.items.length) return;
      } else if (scalarText(n) !== id) return;
      this.removeAt(vp);
      // an end with nothing but device/interface goes back to the short form
      const end = this.get(endPath);
      if (end && end.kind === 'map' && Array.from(end.entries.keys()).every((key) => key === 'device' || key === 'interface')) {
        const dev = this.text(endPath.concat('device'));
        const inf = this.text(endPath.concat('interface'));
        if (dev) this.setAt(endPath, strNode(inf ? dev + ':' + inf : dev), KEY_ORDER.link);
      }
    });
  }

  /** Add a key to a mapping (created if missing): an empty value, a group or a list. */
  addField(mapPath: Path, key: string, kind: 'value' | 'group' | 'list'): 'ok' | 'exists' | 'empty' {
    if (!key) return 'empty';
    const cur = this.get(mapPath);
    if (cur && cur.kind === 'map' && cur.entries.has(key)) return 'exists';
    this.change('Add attribute', () => {
      const m = this.get(mapPath);
      if (!m || m.kind !== 'map') this.setAt(mapPath, mapNode(), this.orderFor(mapPath.slice(0, -1)));
      this.setAt(mapPath.concat(key), kind === 'group' ? mapNode() : kind === 'list' ? seqNode() : nullNode());
    });
    return 'ok';
  }

  /** Rename a key of a mapping (keeps its position). */
  renameField(mapPath: Path, oldKey: string, newKey: string): 'ok' | 'exists' | 'empty' {
    if (!newKey) return 'empty';
    const m = this.get(mapPath);
    if (m && m.kind === 'map' && m.entries.has(newKey) && newKey !== oldKey) return 'exists';
    this.change('Rename key', () => this.renameKey(mapPath, oldKey, newKey));
    return 'ok';
  }

  /** Append an empty value, group or list to a list. */
  pushItem(listPath: Path, kind: 'value' | 'group' | 'list'): void {
    this.change('Add item', () => {
      this.ensureSeq(listPath).items.push(kind === 'group' ? mapNode() : kind === 'list' ? seqNode() : nullNode());
    });
  }

  /** Remove a key or list item (one undo step). */
  remove(path: Path, label = 'Remove'): void {
    this.change(label, () => this.removeAt(path));
  }

  /** Move a list item one position up. */
  moveUp(path: Path): void {
    const k = path[path.length - 1];
    if (typeof k !== 'number' || k <= 0) return;
    this.change('Reorder', () => this.moveItem(path.slice(0, -1), k, k - 1));
  }

  /** Move a key the format doesn't define into the object's `attrs` (kept as it is). */
  moveIntoAttrs(objPath: Path, key: string): 'ok' | 'exists' | 'missing' {
    const m = this.get(objPath);
    if (!m || m.kind !== 'map' || !m.entries.has(key)) return 'missing';
    const attrs = m.entries.get('attrs');
    if (attrs && attrs.value.kind === 'map' && attrs.value.entries.has(key)) return 'exists';
    this.change('Move into attrs', () => {
      const v = (m.entries.get(key) as { value: YNode }).value;
      m.entries.delete(key);
      const target = this.ensureMap(objPath.concat('attrs'), this.orderFor(objPath));
      target.entries.set(key, { key, keyLine: 0, value: v });
    });
    return 'ok';
  }

  // ---------------------------------------------------------------- entities

  section(kind: EntityKind): YSeq | null {
    const s = this.root.entries.get(SECTION[kind]);
    return s && s.value.kind === 'seq' ? s.value : null;
  }

  entities(kind: EntityKind): EntityRef[] {
    const s = this.section(kind);
    if (!s) return [];
    return s.items.map((node, index) => ({ kind, index, node, id: node.kind === 'map' && node.entries.has('id') ? scalarText((node.entries.get('id') as { value: YNode }).value) || null : null }));
  }

  entityPath(kind: EntityKind, index: number): Path {
    return [SECTION[kind], index];
  }

  findEntity(kind: EntityKind, id: string): EntityRef | null {
    return this.entities(kind).find((e) => e.id === id) || null;
  }

  /** All ids in the shared namespace (plus protocol ids). */
  allIds(): Set<string> {
    const s = new Set<string>();
    for (const k of ENTITY_KINDS) for (const e of this.entities(k)) if (e.id) s.add(e.id);
    return s;
  }

  uniqueId(base: string, taken: Set<string> = this.allIds()): string {
    const clean = base.replace(/[^A-Za-z0-9_.\-\/]/g, '-').replace(/^[^A-Za-z0-9_]+/, '') || 'item';
    if (!taken.has(clean)) return clean;
    const m = /^(.*?)(\d+)$/.exec(clean);
    const stem = m ? m[1] : clean;
    let n = m ? Number(m[2]) + 1 : 2;
    while (taken.has(stem + n)) n++;
    return stem + n;
  }

  /**
   * Add a new entity with a unique id; returns its index. Only the given
   * fields are set: no type, kind, protocol or category is chosen for the
   * user. A relation gets an empty endpoint list to fill in.
   */
  addEntity(kind: EntityKind, fields: Array<[string, YNode]> = []): number {
    return this.change(`Add ${kind}`, () => {
      const base: { [k in EntityKind]: string } = {
        device: 'device1',
        link: 'link1',
        network: 'net1',
        relation: 'rel1',
        group: 'site1',
        protocol: 'custom1',
      };
      const idNode = fields.find(([k]) => k === 'id');
      const id = idNode ? scalarText(idNode[1]) || base[kind] : this.uniqueId(base[kind]);
      const defaults: { [k in EntityKind]: Array<[string, YNode]> } = {
        device: [],
        link: [],
        network: [],
        relation: [['endpoints', seqNode([], true)]],
        group: [],
        protocol: [],
      };
      const entries: Array<[string, YNode]> = [['id', strNode(id)]];
      for (const [k, v] of defaults[kind]) if (!fields.some(([f]) => f === k)) entries.push([k, v]);
      for (const [k, v] of fields) if (k !== 'id') entries.push([k, v]);
      const node = mapNode(entries, kind === 'link' || kind === 'protocol');
      const seq = this.ensureSeq([SECTION[kind]]);
      seq.items.push(node);
      return seq.items.length - 1;
    });
  }

  duplicateEntity(kind: EntityKind, index: number): number {
    const src = this.section(kind)?.items[index];
    if (!src) return -1;
    return this.change(`Duplicate ${kind}`, () => {
      const copy = cloneNode(src);
      delete copy.before;
      delete copy.blank;
      if (copy.kind === 'map' && copy.entries.has('id')) {
        const old = scalarText((copy.entries.get('id') as { value: YNode }).value) || kind;
        setKey(copy, 'id', strNode(this.uniqueId(old)));
      }
      const seq = this.section(kind) as YSeq;
      seq.items.splice(index + 1, 0, copy);
      return index + 1;
    });
  }

  deleteEntity(kind: EntityKind, index: number): void {
    this.change(`Delete ${kind}`, () => this.removeAt([SECTION[kind], index]));
  }

  // ------------------------------------------------------ reference tracking

  /**
   * Every place that refers to an entity id (or to an interface when `iface`
   * is given): returns [path, kind of reference]. Used for rename and for the
   * delete confirmation.
   */
  references(kind: EntityKind, id: string, iface?: string, includeLayout = false): Path[] {
    const out: Path[] = [];
    if (includeLayout && iface === undefined && (kind === 'device' || kind === 'network' || kind === 'relation')) {
      const lay = this.root.entries.get('layout');
      if (lay && lay.value.kind === 'map') {
        for (const view of LAYOUT_VIEWS) {
          const vm = lay.value.entries.get(view);
          if (vm && vm.value.kind === 'map' && vm.value.entries.has(id)) out.push(['layout', view, id]);
        }
      }
    }
    const epRefs = (sectionKey: string, listKey: string): void => {
      const s = this.root.entries.get(sectionKey);
      if (!s || s.value.kind !== 'seq') return;
      s.value.items.forEach((ent, i) => {
        if (ent.kind !== 'map') return;
        const visit = (n: YNode | undefined, p: Path): void => {
          if (!n) return;
          if (n.kind === 'scalar') {
            const t = scalarText(n);
            if (t === undefined) return;
            const c = t.indexOf(':');
            const dev = c < 0 ? t : t.slice(0, c);
            const inf = c < 0 ? undefined : t.slice(c + 1);
            if (dev === id && (iface === undefined || inf === iface)) out.push(p);
          } else if (n.kind === 'map') {
            const d = n.entries.get('device');
            const f = n.entries.get('interface');
            if (d && scalarText(d.value) === id && (iface === undefined || (f && scalarText(f.value) === iface))) out.push(p);
          }
        };
        if (listKey === 'a/b') {
          visit(ent.entries.get('a')?.value, [sectionKey, i, 'a']);
          visit(ent.entries.get('b')?.value, [sectionKey, i, 'b']);
        } else {
          const l = ent.entries.get(listKey);
          if (l && l.value.kind === 'seq') l.value.items.forEach((it, k) => visit(it, [sectionKey, i, listKey, k]));
        }
      });
    };
    const scalarRefs = (sectionKey: string, key: string, match: (t: string) => boolean): void => {
      const s = this.root.entries.get(sectionKey);
      if (!s || s.value.kind !== 'seq') return;
      s.value.items.forEach((ent, i) => {
        if (ent.kind !== 'map') return;
        const v = ent.entries.get(key);
        if (!v) return;
        if (v.value.kind === 'seq') {
          v.value.items.forEach((it, k) => {
            const t = scalarText(it);
            if (t !== undefined && match(t)) out.push([sectionKey, i, key, k]);
          });
        } else {
          const t = scalarText(v.value);
          if (t !== undefined && match(t)) out.push([sectionKey, i, key]);
        }
      });
    };
    if (kind === 'device') {
      epRefs('links', 'a/b');
      epRefs('relations', 'endpoints');
      // associations of logical interfaces: member ports and tunnel sources (same device), tunnel destinations (any device)
      this.entities('device').forEach((dev) => {
        const lp: Path = ['devices', dev.index, 'logical_interfaces'];
        const list = this.get(lp);
        if (!list || list.kind !== 'seq') return;
        list.items.forEach((it, k) => {
          if (it.kind !== 'map') return;
          if (iface !== undefined && dev.id === id) {
            const mem = it.entries.get('members');
            if (mem && mem.value.kind === 'seq') mem.value.items.forEach((mn, j) => scalarText(mn) === iface && out.push(lp.concat(k, 'members', j)));
            else if (mem && scalarText(mem.value) === iface) out.push(lp.concat(k, 'members'));
            const src = it.entries.get('source');
            if (src && scalarText(src.value) === iface) out.push(lp.concat(k, 'source'));
          }
          const dst = it.entries.get('destination');
          const t = dst ? scalarText(dst.value) : undefined;
          if (t === undefined || parseAddress(t)) return;
          const c = t.indexOf(':');
          const d = c < 0 ? t : t.slice(0, c);
          const inf = c < 0 ? undefined : t.slice(c + 1);
          if (d === id && (iface === undefined || inf === iface)) out.push(lp.concat(k, 'destination'));
        });
      });
    } else if (kind === 'group') {
      scalarRefs('groups', 'parent', (t) => t === id);
      scalarRefs('devices', 'group', (t) => t === id);
    } else if (kind === 'link' || kind === 'relation' || kind === 'network') {
      scalarRefs('relations', 'over', (t) => t === id);
      if (kind === 'network') scalarRefs('relations', 'network', (t) => t === id);
    } else if (kind === 'protocol') {
      scalarRefs('relations', 'protocol', (t) => t.toLowerCase() === id.toLowerCase());
    }
    return out;
  }

  /** Rewrite one reference found by references() to point at the new id / interface. */
  private rewriteRef(p: Path, oldId: string, newId: string, oldIf?: string, newIf?: string): void {
    if (p[0] === 'layout' && p.length === 3) {
      this.renameKey(['layout', p[1]], oldId, newId);
      return;
    }
    const n = this.get(p);
    if (!n) return;
    if (n.kind === 'scalar') {
      const t = scalarText(n) as string;
      let nt = t;
      const last = p[p.length - 1];
      if (last === 'source' || last === 'members' || p[p.length - 2] === 'members') {
        // an interface of the same device, written as its bare id
        nt = newIf !== undefined ? newIf : t;
      } else if (/^(a|b|destination)$/.test(String(last)) || p[p.length - 2] === 'endpoints') {
        const c = t.indexOf(':');
        const dev = c < 0 ? t : t.slice(0, c);
        const inf = c < 0 ? undefined : t.slice(c + 1);
        nt = (dev === oldId ? newId : dev) + (inf !== undefined ? ':' + (oldIf !== undefined && inf === oldIf ? newIf : inf) : '');
      } else nt = newId;
      const repl = strNode(nt);
      if (n.style === 'double' || n.style === 'single') {
        repl.quoted = true;
        repl.style = n.style;
      }
      this.setAt(p, repl);
    } else if (n.kind === 'map') {
      if (oldIf !== undefined && newIf !== undefined) setKey(n, 'interface', strNode(newIf));
      else setKey(n, 'device', strNode(newId));
    }
  }

  /**
   * Change an entity's id and update every reference to it.
   * Returns the number of references updated.
   */
  renameEntity(kind: EntityKind, index: number, newId: string): number {
    const ent = this.entities(kind)[index];
    if (!ent || ent.node.kind !== 'map') return 0;
    const oldId = ent.id;
    return this.change(`Rename ${kind}`, () => {
      const refs = oldId ? this.references(kind, oldId, undefined, true) : [];
      setKey(ent.node as YMap, 'id', strNode(newId), KEY_ORDER[kind]);
      for (const p of refs) this.rewriteRef(p, oldId as string, newId);
      if (oldId) this.renames.set(oldId, newId);
      return refs.filter((p) => p[0] !== 'layout').length;
    });
  }

  /**
   * Rename a physical or logical interface (by its path) and update every reference to it: link ends and relation
   * endpoints ("dev:if", {interface}), member lists and tunnel sources on its device, tunnel destinations anywhere.
   */
  renameInterface(ipath: Path, newIf: string): number {
    const kind = ifaceSchemaKind(ipath);
    const dev = this.entities('device')[ipath[1] as number];
    if (!kind || !dev || !dev.id) return 0;
    const cur = this.get(ipath);
    const oldIf = cur ? (cur.kind === 'map' ? this.text(ipath.concat('id')) : scalarText(cur)) : undefined;
    return this.change('Rename interface', () => {
      const refs = oldIf ? this.references('device', dev.id as string, oldIf) : [];
      const m = this.ensureMap(ipath, KEY_ORDER[kind]);
      setKey(m, 'id', strNode(newIf), KEY_ORDER[kind]);
      for (const p of refs) this.rewriteRef(p, dev.id as string, dev.id as string, oldIf, newIf);
      return refs.length;
    });
  }

  // --------------------------------------------------------------- interfaces

  /**
   * Every interface entry of a device, in file order: the physical
   * interfaces, then the logical ones. The order of the lists in the file
   * is never changed by reading them.
   */
  interfaceEntries(devIndex: number): IfaceEntry[] {
    const out: IfaceEntry[] = [];
    const text = (n: YNode, key: string): string | undefined => (n.kind === 'map' && n.entries.get(key) ? scalarText((n.entries.get(key) as { value: YNode }).value) : undefined);
    const base: Path = ['devices', devIndex];
    const ifs = this.get(base.concat('interfaces'));
    if (ifs && ifs.kind === 'seq') ifs.items.forEach((it, k) => out.push({ path: base.concat('interfaces', k), id: it.kind === 'map' ? text(it, 'id') : scalarText(it), kind: 'interface' }));
    const logical = this.get(base.concat('logical_interfaces'));
    if (logical && logical.kind === 'seq') logical.items.forEach((it, k) => out.push({ path: base.concat('logical_interfaces', k), id: text(it, 'id'), kind: 'logical', type: text(it, 'type') }));
    return out;
  }

  /** Ids of all physical and logical interfaces of a device (one namespace per device). */
  interfaceIds(devIndex: number): string[] {
    return this.interfaceEntries(devIndex)
      .map((e) => e.id)
      .filter((x): x is string => !!x);
  }

  private newIface(devIndex: number, listKey: 'interfaces' | 'logical_interfaces', fields: Array<[string, YNode]>, base: string): number {
    const taken = new Set(this.interfaceIds(devIndex));
    const idGiven = fields.find(([k]) => k === 'id');
    const id = idGiven ? scalarText(idGiven[1]) || base : this.uniqueId(base, taken);
    const entries: Array<[string, YNode]> = [['id', strNode(id)]];
    for (const [k, v] of fields) if (k !== 'id') entries.push([k, v]);
    const list = this.ensureSeq(['devices', devIndex, listKey], false, KEY_ORDER.device);
    list.items.push(mapNode(entries, true));
    return list.items.length - 1;
  }

  /** Add a physical interface to a device; returns its index in the `interfaces` list. */
  addInterface(devIndex: number, fields: Array<[string, YNode]> = [], base = 'eth0'): number {
    return this.change('Add interface', () => this.newIface(devIndex, 'interfaces', fields, base));
  }

  /**
   * What "+ Port Range" would create on a device: the ports of the range,
   * checked against the device's existing interfaces. A name or id that is
   * already used on the device (as the id or the label of any interface,
   * physical or logical) makes the whole range invalid.
   */
  planPortRange(devIndex: number, from: string, to: string): PortRangePlan {
    const plan = portRange(from, to);
    if (!plan.ok) return plan;
    const entries = this.interfaceEntries(devIndex);
    const used = new Set<string>();
    for (const e of entries) {
      if (e.id) used.add(e.id);
      const label = this.text(e.path.concat('label'));
      if (label) used.add(label);
    }
    const taken = plan.ports.filter((p) => used.has(p.id) || used.has(p.name));
    if (taken.length) {
      const shown = taken.slice(0, 4).map((p) => p.name);
      return { ok: false, error: `Already on this device: ${shown.join(', ')}${taken.length > shown.length ? ` and ${taken.length - shown.length} more` : ''}. Nothing is created.` };
    }
    if (entries.length + plan.ports.length > MAX_DEVICE_INTERFACES) {
      return { ok: false, error: `The device would have ${entries.length + plan.ports.length} interfaces; the limit is ${MAX_DEVICE_INTERFACES}.` };
    }
    return plan;
  }

  /**
   * Add the physical interfaces of a range to a device, all in one undoable
   * step, or none if the range is not valid. Each port is only an id (and a
   * label, when its name as typed is not a valid id): no address, VLAN or
   * link is created.
   */
  addPortRange(devIndex: number, from: string, to: string): PortRangePlan {
    const plan = this.planPortRange(devIndex, from, to);
    if (!plan.ok) return plan;
    this.change(`Add ${plan.ports.length} ports`, () => {
      const list = this.ensureSeq(['devices', devIndex, 'interfaces'], false, KEY_ORDER.device);
      for (const p of plan.ports) {
        const entries: Array<[string, YNode]> = [['id', strNode(p.id)]];
        if (p.name !== p.id) entries.push(['label', strNode(p.name)]);
        list.items.push(mapNode(entries, true));
      }
    });
    return plan;
  }

  /**
   * Add a logical interface of the given type (loopback, virtual or tunnel);
   * returns its index in the device's `logical_interfaces` list. Only the id
   * and the type are set unless fields are given.
   */
  addLogical(devIndex: number, type: 'loopback' | 'virtual' | 'tunnel', fields: Array<[string, YNode]> = []): number {
    const f = fields.filter(([k]) => k !== 'type');
    f.splice(f.length && f[0][0] === 'id' ? 1 : 0, 0, ['type', strNode(type)]);
    return this.change(`Add ${type} interface`, () => this.newIface(devIndex, 'logical_interfaces', f, type === 'loopback' ? 'lo0' : type === 'tunnel' ? 'tun0' : 'virtual0'));
  }

  /** Add a loopback with a name and addresses; returns its index in the `logical_interfaces` list. */
  addLoopback(devIndex: number, addresses: string[] = [], name?: string, id?: string): number {
    const f: Array<[string, YNode]> = [];
    if (id) f.push(['id', strNode(id)]);
    if (name) f.push(['label', strNode(name)]);
    f.push(['ip', seqNode(addresses.map(strNode), true)]);
    return this.addLogical(devIndex, 'loopback', f);
  }
}

/** Largest number of ports one range may create. */
export const MAX_PORT_RANGE = 256;
/** Interfaces a device may have in total (the validator's limit). */
const MAX_DEVICE_INTERFACES = 512;

/** One port of a range: its name as typed, and the interface id made from it. */
export interface RangePort {
  name: string;
  id: string;
}

export type PortRangePlan = { ok: true; ports: RangePort[] } | { ok: false; error: string };

/** The interface id for a port name: characters an id can't contain (a space …) become "-". */
export function portIdFor(name: string): string {
  return name.replace(/[^A-Za-z0-9_.\-\/]+/g, '-');
}

/**
 * The ports of a range "from … to": the final number of each name is the
 * port number, and everything before it must be identical in both names.
 * "ge 1/1" to "ge 1/24" gives ge 1/1, ge 1/2 … ge 1/24. A number written
 * with leading zeros ("port01") keeps its width. Returns either the whole
 * list or the reason why there is none: never a part of a range.
 */
export function portRange(from: string, to: string): PortRangePlan {
  const a = from.trim();
  const b = to.trim();
  if (!a || !b) return { ok: false, error: 'Enter the first and the last port name, e.g. ge 1/1 and ge 1/24.' };
  const pa = /^(.*?)([0-9]+)$/.exec(a);
  const pb = /^(.*?)([0-9]+)$/.exec(b);
  if (!pa) return { ok: false, error: `“${a}” does not end in a port number (e.g. ge 1/1).` };
  if (!pb) return { ok: false, error: `“${b}” does not end in a port number (e.g. ge 1/24).` };
  if (pa[1] !== pb[1]) return { ok: false, error: `The part before the port number must be the same in both names: “${pa[1]}” and “${pb[1]}” differ.` };
  if (pa[2].length > 9 || pb[2].length > 9) return { ok: false, error: 'The port number is too large.' };
  const first = Number(pa[2]);
  const last = Number(pb[2]);
  if (first >= last) return { ok: false, error: `The first port number (${first}) must be lower than the last (${last}).` };
  const count = last - first + 1;
  if (count > MAX_PORT_RANGE) return { ok: false, error: `This range has ${count} ports; one range can create at most ${MAX_PORT_RANGE}.` };
  // leading zeros in the first number fix the width ("01" … "24")
  const width = pa[2].length > 1 && pa[2].charAt(0) === '0' ? pa[2].length : 0;
  const ports: RangePort[] = [];
  for (let n = first; n <= last; n++) {
    let num = String(n);
    while (num.length < width) num = '0' + num;
    const name = pa[1] + num;
    ports.push({ name, id: portIdFor(name) });
  }
  const bad = ports.filter((p) => !IFACE_RE.test(p.id))[0];
  if (bad) {
    return {
      ok: false,
      error: `“${bad.name}” cannot be used as an interface name: an id has 1–64 characters from A–Z a–z 0–9 _ . - / and starts with a letter or digit.`,
    };
  }
  return { ok: true, ports };
}

/** One interface entry of a device in the document tree. */
export interface IfaceEntry {
  path: Path;
  id: string | undefined;
  /** which list it is in: `interfaces` (physical) or `logical_interfaces` */
  kind: 'interface' | 'logical';
  /** logical only: its `type` as written */
  type?: string;
}

/** Schema kind of an interface path: devices[i].interfaces[k] or devices[i].logical_interfaces[k]. */
export function ifaceSchemaKind(path: Path): 'interface' | 'logical' | undefined {
  if (path.length !== 4 || path[0] !== 'devices' || typeof path[1] !== 'number' || typeof path[3] !== 'number') return undefined;
  return path[2] === 'interfaces' ? 'interface' : path[2] === 'logical_interfaces' ? 'logical' : undefined;
}

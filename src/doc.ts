/**
 * The editable document: the YAML tree itself is the single source of truth.
 *
 * Every edit changes the tree in place (so comments, key order and any key
 * the editor does not know about survive), is undoable, marks the document
 * dirty and re-validates. Export serializes the tree with yaml-write.ts.
 * This module has no DOM dependency and is fully testable in Node.
 */
import { Pt } from './geometry';
import { LAYOUT_VIEWS, LayoutView, autoPositions, resolvePositions, samePositions } from './layout-auto';
import { cmp, layoutInput, layoutSignature } from './layout-input';
import { Model } from './model';
import { Issue, LoadResult, TOP_KEYS, loadModel, scalarText, validate } from './validate';
import { YMap, YNode, YSeq, cloneNode, mapNode, numNode, seqNode, strNode } from './yaml';
import { stringifyYaml } from './yaml-write';

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
export const KEY_ORDER: { [k: string]: string[] } = {
  top: TOP_KEYS,
  protocol: ['id', 'label', 'category', 'color', 'style', 'description'],
  group: ['id', 'label', 'kind', 'parent', 'description', 'attrs'],
  device: ['id', 'label', 'type', 'group', 'vendor', 'model', 'role', 'mgmt', 'router_id', 'tier', 'description', 'attrs', 'interfaces'],
  interface: ['id', 'label', 'type', 'speed', 'media', 'ip', 'vlan', 'mac', 'description', 'attrs'],
  link: ['id', 'a', 'b', 'medium', 'speed', 'label', 'cable', 'description', 'attrs'],
  network: ['id', 'label', 'kind', 'cidr', 'vlan', 'vrf', 'members', 'description', 'attrs'],
  relation: ['id', 'protocol', 'category', 'label', 'endpoints', 'over', 'network', 'directed', 'description', 'attrs'],
  endpoint: ['device', 'interface', 'role', 'address', 'attrs'],
};

export type Origin = 'new' | 'file' | 'example';

export const NEW_MODEL_YAML = `netatlas: 1
title: New network
devices:
  - id: router1
    type: router
    router_id: lo0
    interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32]}
`;

const MAX_UNDO = 100;

/** Copy comments / blank-line markers from an old node onto its replacement. */
function keepTrivia(from: YNode | undefined, to: YNode): YNode {
  if (!from) return to;
  if (from.before && !to.before) to.before = from.before;
  if (from.blank && !to.blank) to.blank = true;
  if (from.comment !== undefined && to.comment === undefined && to.kind === 'scalar' && from.kind === 'scalar') to.comment = from.comment;
  if (from.comment !== undefined && to.comment === undefined && to.kind !== 'scalar' && from.kind !== 'scalar') to.comment = from.comment;
  return to;
}

/** Insert or replace `key` in `m`, placing new keys according to `order`. */
export function setKey(m: YMap, key: string, value: YNode, order?: string[]): void {
  const existing = m.entries.get(key);
  if (existing) {
    existing.value = keepTrivia(existing.value, value);
    return;
  }
  const entry = { key, keyLine: 0, value };
  const pos = order ? order.indexOf(key) : -1;
  if (pos < 0) {
    m.entries.set(key, entry);
    return;
  }
  // insert before the first existing key that comes later in the canonical order
  const next = Array.from(m.entries.keys()).find((k) => {
    const p = (order as string[]).indexOf(k);
    return p > pos;
  });
  if (next === undefined) {
    m.entries.set(key, entry);
    return;
  }
  const rebuilt = new Map<string, typeof entry>();
  m.entries.forEach((e, k) => {
    if (k === next) rebuilt.set(key, entry);
    rebuilt.set(k, e);
  });
  m.entries = rebuilt;
}

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
      const raw = this.rawLayoutKeys(view);
      const stale = raw.some((id) => !next.has(id));
      if (stale || !samePositions(next, post.layout[view])) {
        this.writeLayout(view, next);
        changed = true;
      }
    }
    if (changed) this.revalidate();
  }

  /** Keys present in the document's layout section for a view (valid or not). */
  private rawLayoutKeys(view: LayoutView): string[] {
    const lay = this.root.entries.get('layout');
    if (!lay || lay.value.kind !== 'map') return [];
    const vm = lay.value.entries.get(view);
    return vm && vm.value.kind === 'map' ? Array.from(vm.value.entries.keys()) : [];
  }

  /** Replace the stored positions of one view (entries sorted by id; comments kept). */
  private writeLayout(view: LayoutView, positions: Map<string, Pt>): void {
    let lay = this.root.entries.get('layout');
    if (!lay || lay.value.kind !== 'map') {
      const fresh = mapNode();
      fresh.blank = true;
      setKey(this.root, 'layout', fresh, KEY_ORDER.top);
      lay = this.root.entries.get('layout') as { key: string; keyLine: number; value: YNode };
    }
    const layMap = lay.value as YMap;
    const oldEntry = layMap.entries.get(view);
    const old = oldEntry && oldEntry.value.kind === 'map' ? oldEntry.value : null;
    const m = mapNode();
    for (const id of Array.from(positions.keys()).sort(cmp)) {
      const p = positions.get(id) as Pt;
      const v = seqNode([numNode(p.x), numNode(p.y)], true);
      const prev = old ? old.entries.get(id) : undefined;
      if (prev) keepTrivia(prev.value, v);
      m.entries.set(id, { key: id, keyLine: 0, value: v });
    }
    setKey(layMap, view, m, ['physical', 'logical']);
  }

  /**
   * Auto-arrange: compute the deterministic layout of the whole model for the
   * given views and store it (one undo step). Returns how many nodes moved on
   * screen; nothing is changed at all if the stored layout already equals the
   * auto-arrange result.
   */
  arrange(views: LayoutView[]): { changed: boolean; moved: number } {
    const m = this.result.model;
    if (!m) return { changed: false, moved: 0 };
    const input = layoutInput(m);
    const targets = new Map<LayoutView, Map<string, Pt>>();
    let moved = 0;
    for (const v of views) {
      const auto = autoPositions(v, input);
      const shown = resolvePositions(v, input, m.layout[v]);
      auto.forEach((p, id) => {
        const q = shown.get(id);
        if (!q || q.x !== p.x || q.y !== p.y) moved++;
      });
      if (!samePositions(auto, m.layout[v])) targets.set(v, auto);
    }
    if (!targets.size) return { changed: false, moved: 0 };
    const label = views.length > 1 ? 'Auto-arrange (both views)' : `Auto-arrange (${views[0]} view)`;
    this.change(label, () => targets.forEach((pos, v) => this.writeLayout(v, pos)), { layout: false });
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
    this.change(label, () => this.writeLayout(view, next), { layout: false });
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
    } else if (cur && cur.kind === 'scalar' && typeof seg === 'number' && scalarText(cur) !== undefined && /^(members|endpoints)$/.test(String(parentPath[parentPath.length - 1]))) {
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

  /** Add a new entity with a unique id; returns its index. */
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
        device: [['type', strNode('router')]],
        link: [],
        network: [['kind', strNode('subnet')]],
        relation: [['protocol', strNode('bgp')], ['endpoints', seqNode([], true)]],
        group: [['kind', strNode('site')]],
        protocol: [['category', strNode('other')]],
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
      epRefs('networks', 'members');
      epRefs('relations', 'endpoints');
      if (iface !== undefined) {
        const dev = this.findEntity('device', id);
        const rid = dev ? this.get(['devices', dev.index, 'router_id']) : undefined;
        if (dev && rid && scalarText(rid) === iface) out.push(['devices', dev.index, 'router_id']);
      }
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
      if (p[p.length - 1] === 'router_id') nt = newIf as string;
      else if (/^(a|b)$/.test(String(p[p.length - 1])) || /^(members|endpoints)$/.test(String(p[p.length - 2]))) {
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

  /** Rename an interface of a device and update references ("dev:if", {interface}, router_id). */
  renameInterface(devIndex: number, ifIndex: number, newIf: string): number {
    const dev = this.entities('device')[devIndex];
    if (!dev || !dev.id) return 0;
    const ipath: Path = ['devices', devIndex, 'interfaces', ifIndex];
    const cur = this.get(ipath);
    const oldIf = cur ? (cur.kind === 'map' ? this.text(ipath.concat('id')) : scalarText(cur)) : undefined;
    return this.change('Rename interface', () => {
      const refs = oldIf ? this.references('device', dev.id as string, oldIf) : [];
      const m = this.ensureMap(ipath, KEY_ORDER.interface);
      setKey(m, 'id', strNode(newIf), KEY_ORDER.interface);
      for (const p of refs) this.rewriteRef(p, dev.id as string, dev.id as string, oldIf, newIf);
      return refs.length;
    });
  }

  // --------------------------------------------------------------- interfaces

  interfaceIds(devIndex: number): string[] {
    const l = this.get(['devices', devIndex, 'interfaces']);
    if (!l || l.kind !== 'seq') return [];
    return l.items
      .map((it) => (it.kind === 'map' ? (it.entries.get('id') ? scalarText((it.entries.get('id') as { value: YNode }).value) : undefined) : scalarText(it)))
      .filter((x): x is string => !!x);
  }

  /** Add an interface to a device; returns its index in the interfaces list. */
  addInterface(devIndex: number, fields: Array<[string, YNode]> = [], base = 'eth0'): number {
    return this.change(fields.some(([k, v]) => k === 'type' && scalarText(v) === 'loopback') ? 'Add loopback' : 'Add interface', () => {
      const taken = new Set(this.interfaceIds(devIndex));
      const idGiven = fields.find(([k]) => k === 'id');
      const id = idGiven ? scalarText(idGiven[1]) || base : this.uniqueId(base, taken);
      const entries: Array<[string, YNode]> = [['id', strNode(id)]];
      for (const [k, v] of fields) if (k !== 'id') entries.push([k, v]);
      const list = this.ensureSeq(['devices', devIndex, 'interfaces'], false, KEY_ORDER.device);
      list.items.push(mapNode(entries, true));
      return list.items.length - 1;
    });
  }

  /** Add a loopback (type: loopback) with a name and addresses. */
  addLoopback(devIndex: number, addresses: string[] = [], name?: string, id?: string): number {
    const f: Array<[string, YNode]> = [];
    if (id) f.push(['id', strNode(id)]);
    f.push(['type', strNode('loopback')]);
    if (name) f.push(['label', strNode(name)]);
    f.push(['ip', seqNode(addresses.map(strNode), true)]);
    return this.addInterface(devIndex, f, 'lo0');
  }
}


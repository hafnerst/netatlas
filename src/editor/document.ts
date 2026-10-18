/**
 * The editable document: the YAML tree itself is the single source of truth.
 *
 * Every edit changes the tree in place (so comments, key order and any key
 * the editor does not know about survive), is undoable, marks the document
 * dirty and re-validates. Export serializes the tree with yaml-write.ts.
 * This module has no DOM dependency and is fully testable in Node.
 */
import { lookupProtocol, protocolBase } from '../model/protocols';
import { ROUTER_ID_KEY, ServiceRegistry, builtinServices, paramsAt } from '../model/services';
import { Pt } from '../layout/geometry';
import { LAYOUT_VIEWS, LayoutView, resolvePositions, samePositions } from '../layout/positions';
import { ArrangeStrategy, STRATEGIES, STRATEGY_LABEL, STRATEGY_ROUTING, strategyPositions } from '../layout/strategies';
import { layoutInput, layoutSignature } from '../layout/input';
import { dnsNameKey, dnsNameProblem } from '../model/dns';
import { parseAddress } from '../model/ip';
import { Model, VLAN_MAX, VLAN_MIN } from '../model/types';
import { vlanRangesText } from '../model/derive';
import { PARAMS } from '../analysis/sim/params';
import { APP_PARAMS } from '../model/applications';
import { IFACE_RE, Issue, LoadResult, loadModel, scalarText, validate } from '../validation/validate';
import { SCHEMA } from '../yaml/schema';
import { flowText } from '../yaml/write';
import { DEFAULT_YAML_LIMITS, YMap, YNode, YSeq, autoNode, boolNode, cloneNode, mapNode, nullNode, numNode, seqNode, strNode } from '../yaml/parse';
import { stringifyYaml } from '../yaml/write';
import { rawLayoutKeys, rawManualIds, writeLayout, writeManual, writeRouting } from './layout-section';
import { keepTrivia, sameSet, setKey } from './tree';
import { isGuest } from '../model/virtual';
import { DeviceLike, capabilities, layer3Option, deviceRoutingRole } from '../model/capabilities';
import { kindsOf, modesOf, purposeDef, deviceTypeLabel, hasPurpose } from '../model/device-types';

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

/** An edit was refused: the model is locked (a simulation is on). */
/** The fields of a saved expectation as the editor writes them (an empty value removes the key; KEY_ORDER puts them in order). */
export interface ExpectationFields {
  name?: string;
  expect?: string;
  from?: string;
  to?: string;
  service?: string;
  vrf?: string;
  /** "4" or "6" */
  family?: string;
  /** blocked: unreachable, policy or boundary */
  enforce?: string;
  boundary?: string;
  /** timing: ptp, ntp or either */
  method?: string;
  failure?: string[];
  description?: string;
}

export class EditLocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EditLocked';
  }
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
  /**
   * The YAML text the model had when it was opened or last saved. "Modified"
   * is a comparison with it, not a flag set by edits: undoing back to the
   * saved state makes the model unmodified again, and redoing modifies it.
   */
  private savedText = '';
  private dirtyMemo: { version: number; dirty: boolean } | null = null;
  /** increments on every change; lets views know when to refresh */
  version = 0;
  result: LoadResult;
  /** undo entries; `serial`: which edit it undoes (see undoTop) */
  private undoStack: Array<{ root: YMap; label: string; serial: number; exempt?: boolean }> = [];
  private redoStack: Array<{ root: YMap; label: string; serial: number; exempt?: boolean }> = [];
  /** the serial number of the last edit, of any document (counts up, never reused: a serial names one edit) */
  private static serial = 0;
  /**
   * While set, the model can't be edited (a simulation is on): the reason.
   * Any edit throws EditLocked and changes nothing; undo and redo wait.
   */
  lock = '';
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
    this.savedText = this.exportText();
  }

  /** Does the model differ from the text it was opened or last saved with? */
  get dirty(): boolean {
    const m = this.dirtyMemo;
    if (m && m.version === this.version) return m.dirty;
    const dirty = this.exportText() !== this.savedText;
    this.dirtyMemo = { version: this.version, dirty };
    return dirty;
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
  /** findings of the consistency checks (they never make the model invalid) */
  get findings(): Issue[] {
    return this.result.findings;
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

  /** Issues located at or below `path`: the format's errors and warnings, and the findings of the checks. */
  issuesAt(path: Path, exact = false): Issue[] {
    const all = this.result.errors.concat(this.result.warnings, this.result.findings);
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
  change<T>(label: string, fn: () => T, opts: { layout?: boolean; exempt?: boolean } = {}): T {
    if (this.lock && !opts.exempt) throw new EditLocked(this.lock);
    const snapshot = cloneNode(this.root);
    const pre = this.result.model;
    this.renames = new Map();
    const out = fn();
    this.undoStack.push({ root: snapshot, label, serial: ++ModelDoc.serial, exempt: opts.exempt });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.revalidate();
    if (opts.layout !== false && pre) this.maintainLayout(pre);
    this.markChanged();
    return out;
  }

  private markChanged(): void {
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

  private autoMemo = new Map<string, Map<ArrangeStrategy, Map<string, Pt>>>();

  /**
   * Auto-arrange result of a strategy for the current model (cached per layout signature; each strategy is
   * computed when it is first asked for, so arranging with Default never waits for the others).
   */
  autoLayout(view: LayoutView, strategy: ArrangeStrategy = 'default'): Map<string, Pt> {
    const m = this.result.model;
    if (!m) return new Map();
    const input = layoutInput(m);
    const key = view + '\n' + layoutSignature(input);
    let r = this.autoMemo.get(key);
    if (!r) {
      r = new Map();
      // keep only the latest results per view
      Array.from(this.autoMemo.keys()).forEach((k) => {
        if (k.indexOf(view + '\n') === 0) this.autoMemo.delete(k);
      });
      this.autoMemo.set(key, r);
    }
    let pos = r.get(strategy);
    if (!pos) r.set(strategy, (pos = strategyPositions(view, input, strategy)));
    return pos;
  }

  /**
   * The strategies whose result the view shows right now, in STRATEGIES
   * order (empty when none matches). Several strategies match when they
   * give identical positions for this model; the first is the one the
   * view counts as arranged with. Derived from the positions every time,
   * never from the last button pressed.
   */
  arrangedWith(view: LayoutView): ArrangeStrategy[] {
    const shown = this.displayedPositions(view);
    const routing = this.routing(view);
    // a strategy's result is its positions and its routing (Structured: orthogonal; the others: the standard routing)
    return STRATEGIES.filter((s) => STRATEGY_ROUTING[s] === routing && samePositions(shown, this.autoLayout(view, s)));
  }

  /** How the lines of a view are routed: 'orthogonal' (stored by Structured), else undefined (the standard routing). */
  routing(view: LayoutView): 'orthogonal' | undefined {
    const m = this.result.model;
    return m ? m.layout.routing[view] : undefined;
  }

  /**
   * Does the diagram of a view match an Auto-arrange strategy for the current model?
   *   'auto'    every node is exactly where one of the strategies puts it;
   *   'manual'  it matches none, and nodes were placed by hand;
   *   'edited'  it matches none only because the model changed after arranging
   *             (edits keep existing positions stable instead of re-arranging).
   * Derived from the document every time: it is correct after undo, reload,
   * or when nodes are back at their calculated positions.
   */
  layoutStatus(view: LayoutView): 'auto' | 'manual' | 'edited' {
    const m = this.result.model;
    if (!m || (m.layout[view].size === 0 && !m.layout.routing[view])) return 'auto';
    if (this.arrangedWith(view).length) return 'auto';
    const shown = this.displayedPositions(view);
    return Array.from(m.layout.manual[view]).some((id) => shown.has(id)) ? 'manual' : 'edited';
  }

  /**
   * What Auto-arrange with a strategy would do to one view, without doing it:
   *   moved   nodes whose displayed position would change;
   *   manual  of those, the nodes that were placed by hand (their positions would be overwritten).
   * Both are empty when the view already shows that strategy's layout.
   */
  arrangeImpact(view: LayoutView, strategy: ArrangeStrategy = 'default'): { moved: string[]; manual: string[] } {
    const m = this.result.model;
    if (!m) return { moved: [], manual: [] };
    const auto = this.autoLayout(view, strategy);
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
  arrange(views: LayoutView[], strategy: ArrangeStrategy = 'default'): { changed: boolean; moved: number } {
    const m = this.result.model;
    if (!m) return { changed: false, moved: 0 };
    const targets = new Map<LayoutView, Map<string, Pt>>();
    let moved = 0;
    const routing = STRATEGY_ROUTING[strategy];
    for (const v of views) {
      const auto = this.autoLayout(v, strategy);
      moved += this.arrangeImpact(v, strategy).moved.length;
      // (the same positions with another routing are still a change: Structured after Default on a single device)
      if (!samePositions(auto, m.layout[v]) || m.layout.routing[v] !== routing) targets.set(v, auto);
    }
    if (!targets.size) return { changed: false, moved: 0 };
    const how = strategy === 'default' ? '' : `, ${STRATEGY_LABEL[strategy]}`;
    const label = views.length > 1 ? `Auto-arrange (both views${how})` : `Auto-arrange (${views[0]} view${how})`;
    this.change(
      label,
      () =>
        targets.forEach((pos, v) => {
          writeLayout(this.root, v, pos);
          writeManual(this.root, v, new Set());
          // positions and routing in one undo step: Structured routes orthogonally, the others as standard
          writeRouting(this.root, v, routing || null);
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
    // a node put back exactly where an Auto-arrange strategy places it is no longer "placed by hand"
    const autos = STRATEGIES.map((s) => this.autoLayout(view, s));
    Array.from(manual).forEach((id) => {
      const p = next.get(id);
      if (!p || autos.some((auto) => { const q = auto.get(id); return !!q && q.x === p.x && q.y === p.y; })) manual.delete(id);
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
  /** The serial number of the edit the next undo takes back (0: nothing to undo); stays the same after a redo of it. */
  undoTop(): number {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].serial : 0;
  }
  canRedo(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }
  /** Is undoing (or redoing) refused by the lock (a simulation is on)? */
  undoLocked(redo = false): boolean {
    const st = redo ? this.redoStack : this.undoStack;
    // a device's Simulation settings stay editable during a simulation, and so does undoing them
    return !!this.lock && !!st.length && !st[st.length - 1].exempt;
  }
  undo(): boolean {
    if (this.undoLocked()) return false;
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push({ root: this.root, label: s.label, serial: s.serial, exempt: s.exempt });
    this.root = s.root;
    this.touch();
    return true;
  }
  redo(): boolean {
    if (this.undoLocked(true)) return false;
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push({ root: this.root, label: s.label, serial: s.serial, exempt: s.exempt });
    this.root = s.root;
    this.touch();
    return true;
  }

  /**
   * The model was written to a file or downloaded: `text` (by default the
   * current state) becomes the baseline for "modified". Passing the text that
   * was written keeps an edit made while it was being written unsaved.
   */
  markSaved(text: string = this.exportText()): void {
    this.savedText = text;
    this.dirtyMemo = null;
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
    const parent = parentPath.length ? this.ensureMap(parentPath, this.orderFor(parentPath.slice(0, -1))) : this.root;
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
    if (path.length === 5 && path[4] === 'ipv6_ra' && ifaceSchemaKind(path.slice(0, 4))) return 'ipv6Ra';
    if (path.length === 4 && typeof path[3] === 'number' && path[0] === 'relations' && path[2] === 'endpoints') return 'endpoint';
    if (path.length === 4 && typeof path[3] === 'number' && path[0] === 'devices' && path[2] === 'dns_names') return 'dnsName';
    if (path.length === 4 && typeof path[3] === 'number' && path[0] === 'devices' && path[2] === 'routes') return 'route';
    if (path.length === 4 && typeof path[3] === 'number' && path[0] === 'devices' && path[2] === 'port_pairs') return 'portPair';
    // a server's services: services, its dhcp and dns, a scope and its reservations, a zone and its records
    if (path[0] === 'devices' && path[2] === 'services') {
      const rest = path.slice(3).map((x) => (typeof x === 'number' ? '#' : x)).join('/');
      const kinds: { [k: string]: string } = {
        '': 'netServices',
        dhcp: 'dhcpService',
        'dhcp/scopes/#': 'dhcpScope',
        'dhcp/scopes/#/reservations/#': 'dhcpReservation',
        dns: 'dnsService',
        'dns/zones/#': 'dnsZone',
        'dns/zones/#/records/#': 'dnsRecord',
        hypervisor: 'hypervisor',
        'hypervisor/vswitches/#': 'vswitch',
        'hypervisor/vswitches/#/port_groups/#': 'portGroup',
        container_engine: 'containerEngine',
        'container_engine/networks/#': 'containerNetwork',
        vpn: 'vpn',
        separation: 'separation',
        wireless: 'wireless',
        'wireless/networks/#': 'wirelessNetwork',
        ntp: 'ntp',
        aaa: 'aaa',
        syslog: 'syslog',
        monitoring: 'monitoring',
        proxy: 'proxy',
        load_balancing: 'load_balancing',
        nat: 'nat',
        'nat/rules/#': 'natRule',
        wireless_controller: 'wireless_controller',
        storage: 'storage',
        'applications/#': 'application',
        mqtt_broker: 'mqtt_broker',
        ptp: 'ptp',
        inspection: 'inspection',
        'separation/domains/#': 'sepDomain',
        'separation/directions/#': 'sepDirection',
        'separation/rules/#': 'sepRule',
        'separation/profiles/#': 'transferProfile',
        'separation/profiles/#/listen': 'profileListen',
        'separation/profiles/#/forward': 'profileForward',
      };
      if (kinds[rest]) return kinds[rest];
    }
    // a container's published port: an entry of a veth's publish
    if (path.length === 6 && path[0] === 'devices' && path[2] === 'logical_interfaces' && path[4] === 'publish' && typeof path[5] === 'number') return 'published';
    if (this.isLinkEnd(path)) return 'linkEnd';
    if (path.length === 1 && path[0] === 'layout') return 'layout';
    return undefined;
  }

  private orderFor(parentPath: Path): string[] | undefined {
    const k = this.schemaKindOf(parentPath);
    if (k) return KEY_ORDER[k];
    return this.serviceOrder(parentPath);
  }

  /**
   * Key order inside `protocols:` blocks (from the service registry of the
   * model): the services by id; a service's parameters as the registry
   * lists them, its own router ID last.
   */
  private serviceOrder(p: Path): string[] | undefined {
    const reg = this.result.model ? this.result.model.services : builtinServices();
    const at = (n: number): boolean => p.length === n && p[0] === 'devices' && typeof p[1] === 'number';
    const devBlock = at(3) && p[2] === 'protocols';
    const ifBlock = p.length === 5 && p[0] === 'devices' && (p[2] === 'interfaces' || p[2] === 'logical_interfaces') && typeof p[3] === 'number' && p[4] === 'protocols';
    if (devBlock || ifBlock) return Array.from(reg.keys()).sort();
    const devSvc = at(4) && p[2] === 'protocols';
    const ifSvc = p.length === 6 && p[0] === 'devices' && (p[2] === 'interfaces' || p[2] === 'logical_interfaces') && p[4] === 'protocols';
    if (!devSvc && !ifSvc) return undefined;
    const def = reg.get(String(p[p.length - 1]));
    if (!def) return undefined;
    return paramsAt(def, devSvc ? 'device' : 'interface')
      .map((x) => x.key)
      .concat(devSvc ? [ROUTER_ID_KEY] : []);
  }

  // ------------------------------------------------------ routing services

  /** Enable a service on a device (an empty block: its parameters are the user's to fill in). One undo step. */
  enableService(devIndex: number, id: string): void {
    const label = (this.servicesRegistry().get(id) || { label: id }).label;
    this.change(`Enable ${label}`, () => {
      const dp: Path = ['devices', devIndex];
      const block = this.ensureMap(dp.concat('protocols'), KEY_ORDER.device);
      if (!block.entries.has(id)) setKey(block, id, mapNode([], true), this.serviceOrder(dp.concat('protocols')));
    });
  }

  /** The registry of the model's services (the built-ins while the model can't be read). */
  servicesRegistry(): ServiceRegistry {
    return this.result.model ? this.result.model.services : builtinServices();
  }

  /**
   * What disabling a service on a device removes, as lines for the
   * confirmation: its parameters, its settings on the device's interfaces,
   * and the device's router ID when no other enabled service uses one.
   * Empty: nothing but the service itself.
   */
  serviceRemoval(devIndex: number, id: string): string[] {
    const out: string[] = [];
    const dp: Path = ['devices', devIndex];
    const reg = this.servicesRegistry();
    const block = this.get(dp.concat('protocols', id));
    if (block && block.kind === 'map') block.entries.forEach((e, k) => out.push(`${k}: ${flowText(e.value) || scalarText(e.value) || ''}`.trim()));
    for (const list of ['interfaces', 'logical_interfaces']) {
      const s = this.get(dp.concat(list));
      if (!s || s.kind !== 'seq') continue;
      s.items.forEach((it, j) => {
        const b = this.get(dp.concat(list, j, 'protocols', id));
        if (!b) return;
        const iid = it.kind === 'map' ? this.text(dp.concat(list, j, 'id')) || '?' : scalarText(it) || '?';
        out.push(`${iid}: ${b.kind === 'map' ? flowText(b) || '{}' : scalarText(b) || ''}`);
      });
    }
    if (this.get(dp.concat('router_id')) && !this.otherRouterIdUser(devIndex, id, reg)) out.push(`router_id: ${this.text(dp.concat('router_id')) || ''} (no other enabled protocol uses a router ID)`);
    return out;
  }

  private otherRouterIdUser(devIndex: number, id: string, reg: ServiceRegistry): boolean {
    const b = this.get(['devices', devIndex, 'protocols']);
    if (!b || b.kind !== 'map') return false;
    let found = false;
    b.entries.forEach((_e, k) => {
      const def = reg.get(k);
      if (k !== id && def && def.routerId !== 'none') found = true;
    });
    return found;
  }

  /** Disable a service on a device: its block, its interface settings and an orphaned router ID go, in one undo step. */
  disableService(devIndex: number, id: string): void {
    const reg = this.servicesRegistry();
    const label = (reg.get(id) || { label: id }).label;
    const dp: Path = ['devices', devIndex];
    const dropRid = !this.otherRouterIdUser(devIndex, id, reg);
    this.change(`Disable ${label}`, () => {
      this.removeAt(dp.concat('protocols', id));
      const b = this.get(dp.concat('protocols'));
      if (b && b.kind === 'map' && b.entries.size === 0) this.removeAt(dp.concat('protocols'));
      for (const list of ['interfaces', 'logical_interfaces']) {
        const s = this.get(dp.concat(list));
        if (!s || s.kind !== 'seq') continue;
        s.items.forEach((_it, j) => {
          const ip = dp.concat(list, j, 'protocols');
          if (!this.get(ip.concat(id))) return;
          this.removeAt(ip.concat(id));
          const ib = this.get(ip);
          if (ib && ib.kind === 'map' && ib.entries.size === 0) this.removeAt(ip);
        });
      }
      if (dropRid) this.removeAt(dp.concat('router_id'));
    });
  }

  /**
   * What making a switch a Layer 2 switch takes away (the Layer 3
   * configuration validation would report on a Layer 2 switch): its
   * protocols and router ID, the groups on its interfaces, the addresses of
   * every interface but its management interface (the first VLAN
   * interface with addresses), its routed ports (they need VLANs then), the VRFs of the others, its tunnel interfaces and the routes
   * in other VRFs; as texts, in file order. `relations`: the relations at it
   * that need routing (OSPF, GRE …); they are not deleted (they belong to
   * other devices too) and are reported until they are changed.
   */
  layer2Removal(devIndex: number): { removed: string[]; relations: string[] } {
    const plan = this.layer2Plan(devIndex);
    return { removed: plan.map((x) => x.text), relations: this.layer3RelationsAt(devIndex) };
  }

  /** The relations at a device whose protocol needs a Layer 3 device (routing, FHRP, BFD, LDP, PIM, tunnels, overlays), by id. */
  private layer3RelationsAt(devIndex: number): string[] {
    const model = this.result.model;
    const id = this.text(['devices', devIndex, 'id']);
    if (!model || !id) return [];
    const L3 = ['bgp', 'ospf', 'isis', 'eigrp', 'rip', 'ldp', 'pim', 'bfd', 'vrrp', 'hsrp', 'glbp', 'carp'];
    return model.relations
      .filter((r) => r.endpoints.some((e) => e.device === id) && (r.category === 'tunnel' || r.category === 'overlay' || L3.indexOf(protocolBase(model.protocols, r.protocol)) >= 0))
      .map((r) => `${r.id} (${lookupProtocol(model.protocols, r.protocol).label})`);
  }

  /** The paths layer2Removal stands for, deepest and last first (so removing them in order keeps the others' indexes). */
  private layer2Plan(devIndex: number): Array<{ path: Path; text: string; order: number }> {
    const dp: Path = ['devices', devIndex];
    const out: Array<{ path: Path; text: string; order: number }> = [];
    let n = 0;
    const add = (path: Path, text: string): void => {
      out.push({ path, text, order: n++ });
    };
    const block = this.get(dp.concat('protocols'));
    if (block && block.kind === 'map') block.entries.forEach((_e, k) => add(dp.concat('protocols', k), `protocol ${(this.servicesRegistry().get(k) || { label: k }).label}`));
    if (this.get(dp.concat('router_id'))) add(dp.concat('router_id'), `router_id: ${this.text(dp.concat('router_id')) || ''}`);
    const entries = this.interfaceEntries(devIndex);
    const has = (p: Path, k: string): boolean => {
      const v = this.get(p.concat(k));
      return !!v && !(v.kind === 'seq' && !v.items.length);
    };
    // its management interface: a VLAN interface with an address (a Layer 2 switch's ports are switch ports, without addresses)
    const mgmt = entries.find((e) => e.kind === 'logical' && e.type === 'virtual' && !has(e.path, 'members') && (has(e.path, 'ip') || this.text(e.path.concat('ipv4')) === 'dhcp'));
    let mvrf: string | undefined;
    for (const e of entries) {
      const name = e.id || '?';
      if (e.type === 'tunnel') {
        add(e.path, `tunnel interface ${name}`);
        continue;
      }
      if (this.get(e.path.concat('protocols'))) add(e.path.concat('protocols'), `${name}: ${flowText(this.get(e.path.concat('protocols')) as YNode) || 'protocols'}`);
      if (e === mgmt) {
        mvrf = this.text(e.path.concat('vrf'));
        continue;
      }
      if (has(e.path, 'ip')) add(e.path.concat('ip'), `${name}: addresses ${this.listTexts(e.path.concat('ip')).join(', ')}`);
      // a routed port becomes a switch port: it needs its VLANs then (they are not chosen for it)
      if (this.text(e.path.concat('routed')) === 'true') add(e.path.concat('routed'), `${name}: routed port (give it its VLANs)`);
      if (this.text(e.path.concat('ipv4')) === 'dhcp') add(e.path.concat('ipv4'), `${name}: ipv4: dhcp`);
      if (this.get(e.path.concat('vrf'))) add(e.path.concat('vrf'), `${name}: vrf ${this.text(e.path.concat('vrf'))}`);
    }
    const routes = this.get(dp.concat('routes'));
    if (routes && routes.kind === 'seq') {
      routes.items.forEach((_r, k) => {
        const v = this.text(dp.concat('routes', k, 'vrf'));
        if (v !== undefined && v !== mvrf) add(dp.concat('routes', k), `route ${this.text(dp.concat('routes', k, 'prefix')) || '?'} in VRF ${v}`);
      });
    }
    return out;
  }

  /** The texts of a list's scalar items. */
  private listTexts(p: Path): string[] {
    const s = this.get(p);
    if (!s) return [];
    if (s.kind !== 'seq') return [scalarText(s) || ''];
    return s.items.map((x) => scalarText(x) || flowText(x) || '');
  }

  /**
   * A switch becomes a Layer 3 switch (`layer3: true`), or a Layer 2 switch
   * again: then everything layer2Removal lists goes with it. One undo step.
   */
  setLayer3(devIndex: number, on: boolean): void {
    const dp: Path = ['devices', devIndex];
    const id = this.text(dp.concat('id')) || 'the switch';
    if (on) {
      this.change(`Make ${id} a Layer 3 switch`, () => this.setAt(dp.concat('layer3'), boolNode(true), this.orderFor(dp)));
      return;
    }
    const plan = this.layer2Plan(devIndex);
    // the deepest paths first, and the later items of a list before the earlier ones
    const cmpPath = (a: Path, b: Path): number => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        if (typeof a[i] === 'number' && typeof b[i] === 'number') return (b[i] as number) - (a[i] as number);
        return 0;
      }
      return b.length - a.length;
    };
    plan.sort((a, b) => cmpPath(a.path, b.path) || b.order - a.order);
    this.change(`Make ${id} a Layer 2 switch`, () => {
      for (const x of plan) this.removeAt(x.path);
      for (const e of this.interfaceEntries(devIndex)) {
        const ib = this.get(e.path.concat('ip'));
        if (ib && ib.kind === 'seq' && !ib.items.length) this.removeAt(e.path.concat('ip'));
      }
      for (const k of ['protocols', 'routes', 'logical_interfaces']) {
        const b = this.get(dp.concat(k));
        if (b && ((b.kind === 'map' && b.entries.size === 0) || (b.kind === 'seq' && !b.items.length))) this.removeAt(dp.concat(k));
      }
      this.removeAt(dp.concat('layer3'));
    });
  }

  /** Add a service's settings to an interface (its device enables the service), or remove them. One undo step each. */
  setIfaceService(ifPath: Path, id: string, on: boolean): void {
    const label = (this.servicesRegistry().get(id) || { label: id }).label;
    this.change(`${on ? 'Add' : 'Remove'} ${label} on interface`, () => {
      const ip = ifPath.concat('protocols');
      if (on) {
        const b = this.ensureMap(ip, this.orderFor(ifPath));
        if (!b.entries.has(id)) setKey(b, id, mapNode([], true), this.serviceOrder(ip));
        return;
      }
      this.removeAt(ip.concat(id));
      const ib = this.get(ip);
      if (ib && ib.kind === 'map' && ib.entries.size === 0) this.removeAt(ip);
    });
  }

  private label(path: Path): string {
    const last = path[path.length - 1];
    return typeof last === 'number' ? String(path[path.length - 2]) : String(last);
  }

  /**
   * Set (or, with undefined, remove: the device inherits it again) one of a
   * device's simulation attributes, in its `simulation:` block (removed when
   * it is left empty). The documented exception to the simulation's edit
   * lock: one undo step, allowed while a simulation runs (it applies there
   * at once). `value` is written as typed: a number in the attribute's unit,
   * or text ("300ms", "fast").
   */
  setSimAttr(devIndex: number, yaml: string, value: string | undefined): void {
    this.setSimAttrAt(['devices', devIndex], yaml, value);
  }

  /**
   * Set (or, with undefined, remove: it inherits again) a simulation
   * attribute of a device, an interface, a network or a relation: its
   * `simulation:` block, created and removed with its first and last key
   * (an interface written as "- eth0" becomes a mapping). One undo step;
   * allowed while a simulation runs (the documented exception to its lock).
   */
  setSimAttrAt(owner: Path, yaml: string, value: string | undefined): void {
    const sp: Path = owner.concat('simulation');
    this.change(
      value === undefined ? `Inherit ${yaml.replace(/_/g, ' ')}` : `Set ${yaml.replace(/_/g, ' ')}`,
      () => {
        if (value === undefined) {
          this.removeAt(sp.concat(yaml));
          const b = this.get(sp);
          if (b && b.kind === 'map' && b.entries.size === 0) this.removeAt(sp);
          return;
        }
        const order = PARAMS.filter((p) => !!p.device || !!p.level).map((p) => p.yaml);
        this.ensureMap(owner, this.orderFor(owner.slice(0, -1)));
        this.ensureMap(sp, this.orderFor(owner));
        this.setAt(sp.concat(yaml), /^-?[0-9]+(\.[0-9]+)?$/.test(value) ? numNode(Number(value)) : strNode(value), order);
      },
      { exempt: true, layout: false },
    );
  }

  /** Set a text field; empty text removes the key (or list item). */
  setText(path: Path, text: string): void {
    this.change('Edit ' + this.label(path), () => {
      if (text === '') this.removeAt(path);
      else this.setAt(path, strNode(text), this.orderFor(path.slice(0, -1)));
    });
  }

  /**
   * A switch's IGMP / MLD snooping choice for a VLAN or range (its key in
   * igmp_mld_snooping): enabled, disabled, or '' to remove it (not
   * configured). One undo step; the mapping is written in flow style, its
   * entries by VLAN, and goes when its last entry does.
   */
  setSnooping(devIndex: number, key: string, value: '' | 'enabled' | 'disabled'): void {
    const p: Path = ['devices', devIndex, 'igmp_mld_snooping'];
    this.change(`${value ? 'Set' : 'Clear'} IGMP / MLD snooping of VLAN ${key}`, () => {
      const cur = this.get(p);
      const entries: Array<[string, YNode]> = cur && cur.kind === 'map' ? Array.from(cur.entries.values()).map((e) => [e.key, e.value] as [string, YNode]) : [];
      const kept = entries.filter(([k]) => k !== key);
      if (value) kept.push([key, strNode(value)]);
      if (!kept.length) {
        this.removeAt(p);
        return;
      }
      const first = (k: string): number => Number(k.split('-')[0]) || 0;
      kept.sort((a, b) => first(a[0]) - first(b[0]));
      this.setAt(p, mapNode(kept, true), this.orderFor(p.slice(0, -1)));
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

  /** A yes / no key: written as true or false; '' removes it (one undo step). */
  setYesNo(path: Path, value: '' | 'true' | 'false'): void {
    this.change(value ? 'Set ' + this.label(path) : 'Remove ' + this.label(path), () => {
      if (!value) {
        this.removeAt(path);
        return;
      }
      this.ensureMap(path.slice(0, -1), this.orderFor(path.slice(0, -2)));
      this.setAt(path, boolNode(value === 'true'), this.orderFor(path.slice(0, -1)));
    });
  }

  /** A port group's guest tagging on (its VLANs and native VLAN go in the same step: the guest tags) or off. */
  setGuestTagging(pgPath: Path, on: boolean): void {
    this.change(on ? 'Guest tagging on' : 'Guest tagging off', () => {
      if (!on) {
        this.removeAt(pgPath.concat('guest_tagging'));
        return;
      }
      this.removeAt(pgPath.concat('vlans'));
      this.removeAt(pgPath.concat('native'));
      this.ensureMap(pgPath, this.orderFor(pgPath.slice(0, -1)));
      this.setAt(pgPath.concat('guest_tagging'), boolNode(true), this.orderFor(pgPath));
    });
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

  // ------------------------------------------------------------ a port's VLANs

  /** A port's (or an aggregate's) VLANs as written: the IDs and ranges of its `vlans`. */
  portVlans(p: Path): string[] {
    const t = this.get(p.concat('vlans'));
    if (!t) return [];
    if (t.kind === 'seq') return t.items.map((i) => scalarText(i)).filter((x): x is string => x !== undefined);
    const one = scalarText(t);
    return one !== undefined ? [one] : [];
  }

  /**
   * Write a port's VLANs from text: IDs and ranges separated by commas or
   * spaces ("10, 20, 30-39"). Valid ones are merged and written in order as
   * the shortest ranges (one VLAN as a number, several as a flow list);
   * anything else is kept as written, for validation to report. Nothing
   * else changes, except that a port with VLANs is no routed port.
   */
  private writePortVlans(p: Path, text: string): void {
    const parts = text
      .split(/[,\s]+/)
      .map((x) => x.trim().replace(/[–—]/g, '-'))
      .filter((x) => !!x);
    if (!parts.length) {
      this.removeAt(p.concat('vlans'));
      return;
    }
    const ids = new Set<number>();
    const odd: string[] = [];
    for (const x of parts) {
      const m = /^([1-9][0-9]{0,3})(?:-([1-9][0-9]{0,3}))?$/.exec(x);
      const from = m ? Number(m[1]) : NaN;
      const to = m ? Number(m[2] !== undefined ? m[2] : m[1]) : NaN;
      if (m && from >= VLAN_MIN && to <= VLAN_MAX && from <= to && to - from < VLAN_MAX) for (let v = from; v <= to; v++) ids.add(v);
      else odd.push(x);
    }
    const runs = vlanRangesText(Array.from(ids)).split(',').filter((x: string) => !!x).concat(odd);
    const node = (x: string): YNode => (/^[0-9]+$/.test(x) ? numNode(Number(x)) : strNode(x));
    const order = this.orderFor(p);
    this.ensureMap(p, order);
    this.setAt(p.concat('vlans'), runs.length === 1 ? node(runs[0]) : seqNode(runs.map(node), true), order);
    this.removeAt(p.concat('routed'));
    // a native VLAN the port no longer has (or an access port's: one VLAN is untagged anyway) goes in the same step
    const native = Number(this.text(p.concat('native')));
    if (this.get(p.concat('native')) && (!odd.length && (ids.size < 2 || !ids.has(native)))) this.removeAt(p.concat('native'));
  }

  /** Set a port's VLANs (see writePortVlans); '' removes them. One undo step. */
  setPortVlans(p: Path, text: string): boolean {
    if (!this.get(p)) return false;
    this.change(text.trim() ? 'Set VLANs' : 'Remove VLANs', () => this.writePortVlans(p, text));
    return true;
  }

  /** Set a trunk's native (untagged) VLAN; '' removes it (every VLAN tagged). */
  setPortNative(p: Path, text: string): boolean {
    if (!this.get(p)) return false;
    this.change(text ? 'Set native VLAN' : 'Remove native VLAN', () => {
      if (!text) {
        this.removeAt(p.concat('native'));
        return;
      }
      const order = this.orderFor(p);
      this.ensureMap(p, order);
      this.setAt(p.concat('native'), /^[0-9]+$/.test(text) ? numNode(Number(text)) : strNode(text), order);
    });
    return true;
  }

  /** Make a Layer 3 switch's port a routed port (its VLANs and native VLAN go with it, in the same step), or a switch port again. */
  setPortRouted(p: Path, on: boolean): boolean {
    if (!this.get(p)) return false;
    this.change(on ? 'Make it a routed port' : 'Make it a switch port', () => {
      if (!on) {
        this.removeAt(p.concat('routed'));
        return;
      }
      const order = this.orderFor(p);
      this.ensureMap(p, order);
      this.removeAt(p.concat('vlans'));
      this.removeAt(p.concat('native'));
      this.setAt(p.concat('routed'), boolNode(true), order);
    });
    return true;
  }

  /**
   * Assign VLANs to ports… : write the same VLANs (and native VLAN, or none)
   * on several ports of a device at once, one undo step. `ports` are ids of
   * the device's interfaces; those it doesn't have are returned, and then
   * nothing is written.
   */
  assignPortVlans(devIndex: number, ports: string[], text: string, native: string): { missing: string[]; done: number } {
    const entries = this.interfaceEntries(devIndex);
    const paths: Path[] = [];
    const missing: string[] = [];
    for (const id of ports) {
      const e = entries.find((x) => x.id === id);
      if (e) paths.push(e.path);
      else missing.push(id);
    }
    if (missing.length || !paths.length) return { missing, done: 0 };
    this.change(`Assign VLANs to ${paths.length} port${paths.length === 1 ? '' : 's'}`, () => {
      for (const p of paths) {
        this.writePortVlans(p, text);
        if (native) {
          const order = this.orderFor(p);
          this.ensureMap(p, order);
          this.setAt(p.concat('native'), /^[0-9]+$/.test(native) ? numNode(Number(native)) : strNode(native), order);
        } else this.removeAt(p.concat('native'));
      }
    });
    return { missing, done: paths.length };
  }

  /** Set a text value of one link end (its port's `speed` or `duplex`); '' removes it, and an end left plain goes back to "dev:if". */
  setEndText(endPath: Path, key: 'speed' | 'duplex', text: string): boolean {
    const cur = this.get(endPath);
    if (!cur || (cur.kind === 'scalar' && scalarText(cur) === undefined)) return false;
    this.change('Set port ' + key, () => {
      if (text === '') {
        this.removeAt(endPath.concat(key));
        this.shortEnd(endPath);
        return;
      }
      this.ensureMap(endPath);
      this.setAt(endPath.concat(key), strNode(text), KEY_ORDER.linkEnd);
    });
    return true;
  }

  /** An end written as a mapping with nothing but device and interface goes back to "dev:if". */
  private shortEnd(endPath: Path): void {
    const e = this.get(endPath);
    if (e && e.kind === 'map' && Array.from(e.entries.keys()).every((key) => key === 'device' || key === 'interface')) {
      const dev = this.text(endPath.concat('device'));
      const inf = this.text(endPath.concat('interface'));
      if (dev) this.setAt(endPath, strNode(inf ? dev + ':' + inf : dev), KEY_ORDER.link);
    }
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

  /**
   * A server's DHCP or DNS server on (an empty one: what it still needs is
   * reported until filled in) or off (its scopes or zones go with it); one
   * undo step.
   */
  setNetService(devIndex: number, id: 'dhcp' | 'dns' | 'hypervisor' | 'container_engine', on: boolean): void {
    const sp: Path = ['devices', devIndex, 'services'];
    const name = id === 'hypervisor' ? 'the Hypervisor' : id === 'container_engine' ? 'the Container engine' : `the ${id.toUpperCase()} server`;
    this.change(on ? `Enable ${name}` : `Disable ${name}`, () => {
      if (on) {
        this.ensureMap(sp, KEY_ORDER.device);
        this.ensureMap(sp.concat(id), KEY_ORDER.netServices);
        return;
      }
      this.removeAt(sp.concat(id));
      const b = this.get(sp);
      if (b && b.kind === 'map' && b.entries.size === 0) this.removeAt(sp);
    });
  }

  /**
   * The guests whose `host` names a device (as written: also while the
   * model has errors), with their index and type; in file order.
   */
  guestsOfHost(hostId: string): Array<{ index: number; id: string; type: string }> {
    const out: Array<{ index: number; id: string; type: string }> = [];
    this.entities('device').forEach((d) => {
      const t = this.text(['devices', d.index, 'type']) || '';
      if (isGuest({ type: t }) && this.text(['devices', d.index, 'host']) === hostId) out.push({ index: d.index, id: d.id || '', type: t });
    });
    return out;
  }

  /**
   * Add a guest (a VM or a container) already assigned to its host, right
   * after the host and its other guests: an id, its type and its host (its
   * network interfaces are the user's to add). One undo step; returns its
   * index.
   */
  addGuest(hostIndex: number, guest: 'vm' | 'container'): number {
    const host = this.text(['devices', hostIndex, 'id']);
    if (!host) return -1;
    const vm = guest === 'vm';
    return this.change(vm ? 'Add VM' : 'Add container', () => {
      const id = this.uniqueId(vm ? 'vm1' : 'container1');
      const node = mapNode([
        ['id', strNode(id)],
        ['type', strNode(guest)],
        ['host', strNode(host)],
      ]);
      const seq = this.ensureSeq(['devices']);
      // after the host and the guests it already has
      let at = hostIndex + 1;
      for (const g of this.guestsOfHost(host)) if (g.index >= at) at = g.index + 1;
      seq.items.splice(at, 0, node);
      return at;
    });
  }

  /**
   * What a device is as written, with one change (its type, mode, purpose or
   * separation implementation): what the capability resolver reads.
   */
  deviceLike(devIndex: number, change?: { key: DeviceModelKey; value: string }): DeviceLike {
    const dp: Path = ['devices', devIndex];
    const v = (k: DeviceModelKey, path: Path): string | undefined => (change && change.key === k ? change.value || undefined : this.text(path) || undefined);
    return {
      type: v('type', dp.concat('type')) || '',
      layer3: this.text(dp.concat('layer3')) === 'true' ? true : undefined,
      mode: v('mode', dp.concat('mode')),
      purpose: v('purpose', dp.concat('purpose')),
      separation: { implementation: v('implementation', dp.concat('services', 'separation', 'implementation')) },
    };
  }

  /**
   * What changing a device's type, mode, purpose or separation
   * implementation takes away, before it is done: the values the device
   * could no longer have (removed with the change, listed for the
   * confirmation) and what stays but is then reported (its guests, the
   * relations that need routing). Nothing more permissive is put in their
   * place, and nothing new is chosen: a VPN gateway's VPN, a Separation
   * gateway's policy or a System's purpose are left to be filled in.
   */
  deviceModelPlan(devIndex: number, key: DeviceModelKey, value: string): { removed: Array<{ path: Path; text: string }>; kept: string[] } {
    const dp: Path = ['devices', devIndex];
    const next = this.deviceLike(devIndex, { key, value });
    const now = capabilities(this.deviceLike(devIndex));
    const c = capabilities(next);
    const removed: Array<{ path: Path; text: string }> = [];
    const has = (path: Path): boolean => !!this.get(path);
    const gone = (path: Path, text: string): void => {
      if (has(path)) removed.push({ path, text });
    };
    const shown = (path: Path): string => {
      const n = this.get(path);
      return n ? scalarText(n) || flowText(n) || '…' : '';
    };
    if (key === 'type') {
      const kind = this.text(dp.concat('kind'));
      if (kind && !kindsOf(next.type).some((k) => k.id === kind)) {
        gone(dp.concat('kind'), `kind: ${kind} (not a kind of ${deviceTypeLabel(next.type) || 'the new type'})`);
        gone(dp.concat('kind_label'), `kind_label: ${shown(dp.concat('kind_label'))}`);
      }
      const mode = this.text(dp.concat('mode'));
      if (mode && !modesOf(next.type).some((m) => m.id === mode)) gone(dp.concat('mode'), `mode: ${mode}`);
      if (!hasPurpose(next.type)) {
        gone(dp.concat('purpose'), `purpose: ${shown(dp.concat('purpose'))} (a System's)`);
        gone(dp.concat('icon'), `icon: ${shown(dp.concat('icon'))} (a System's)`);
      }
      if (!layer3Option(next.type)) gone(dp.concat('layer3'), 'Supports Layer 3');
    }
    if (key === 'purpose' && this.text(dp.concat('icon')) && !purposeDef(value)?.icons.some((x) => x.id === this.text(dp.concat('icon')))) gone(dp.concat('icon'), `icon: ${shown(dp.concat('icon'))} (not an icon of this purpose)`);
    // the built-in functions: a VPN gateway's VPN, a Security gateway's policy
    if (!c.vpnOnlyTransit) gone(dp.concat('services', 'vpn'), 'its VPN gateway configuration (services: vpn)');
    if (!c.securityGateway) gone(dp.concat('services', 'separation'), 'its Domain separation policy (services: separation)');
    else if (key === 'implementation') {
      // a protocol break's transfer profiles mean nothing to a filtering bridge or router (the rules stay: they permit no more than before)
      if (value !== 'protocol_break') {
        gone(dp.concat('services', 'separation', 'profiles'), 'the transfer profiles (a protocol break’s)');
        const rules = this.get(dp.concat('services', 'separation', 'rules'));
        if (rules && rules.kind === 'seq') rules.items.forEach((_r, j) => gone(dp.concat('services', 'separation', 'rules', j, 'profile'), `rule ${this.text(dp.concat('services', 'separation', 'rules', j, 'id')) || j + 1}: profile ${shown(dp.concat('services', 'separation', 'rules', j, 'profile'))}`));
      }
    }
    // the services it could no longer run
    if (!c.canHostGuests.vms) gone(dp.concat('services', 'hypervisor'), 'the Hypervisor service');
    if (!c.canHostGuests.containers) gone(dp.concat('services', 'container_engine'), 'the Container engine service');
    if (!c.networkServices) {
      gone(dp.concat('services', 'dhcp'), 'the DHCP server');
      gone(dp.concat('services', 'dns'), 'the DNS server');
    }
    // routing, pairs and management, by what it can do
    if (!c.routingProtocols) {
      const block = this.get(dp.concat('protocols'));
      if (block && block.kind === 'map') block.entries.forEach((_e, k) => gone(dp.concat('protocols', k), `protocol ${(this.servicesRegistry().get(k) || { label: k }).label}`));
      gone(dp.concat('router_id'), `router_id: ${shown(dp.concat('router_id'))}`);
    }
    if (deviceRoutingRole(next) === null) gone(dp.concat('routes'), 'its static routes');
    if (!c.needsPortPairs) gone(dp.concat('port_pairs'), 'its port pairs');
    if (!c.managementInterfaces) gone(dp.concat('management'), 'its management interfaces');
    // a guest's own fields
    if (c.canBeGuest === null) gone(dp.concat('host'), `host: ${shown(dp.concat('host'))}`);
    if (c.canBeGuest !== 'vm') for (const k of ['guest_os', 'vcpu', 'ram']) gone(dp.concat(k), `${k}: ${shown(dp.concat(k))}`);
    if (c.canBeGuest !== 'container') gone(dp.concat('image'), `image: ${shown(dp.concat('image'))}`);
    // what stays, and is reported until it is changed
    const kept: string[] = [];
    const id = this.text(dp.concat('id')) || '';
    if (now.canHostGuests.vms || now.canHostGuests.containers) for (const g of this.guestsOfHost(id)) if (!(capabilities({ type: g.type }).canBeGuest === 'vm' ? c.canHostGuests.vms : c.canHostGuests.containers)) kept.push(`guest ${g.id} (it runs on ${id})`);
    if (now.l3Forward && !c.l3Forward) for (const r of this.layer3RelationsAt(devIndex)) kept.push(`relation ${r}`);
    // (nested removals are covered by their parent)
    const out = removed.filter((x) => !removed.some((y) => y !== x && y.path.length < x.path.length && y.path.every((k, i) => x.path[i] === k)));
    return { removed: out, kept };
  }

  /** Change a device's type, mode, purpose or separation implementation, with what deviceModelPlan removes; one undo step. */
  applyDeviceModel(devIndex: number, key: DeviceModelKey, value: string): void {
    const dp: Path = ['devices', devIndex];
    const plan = this.deviceModelPlan(devIndex, key, value);
    const where: Path = key === 'implementation' ? dp.concat('services', 'separation', 'implementation') : dp.concat(key);
    const id = this.text(dp.concat('id')) || 'the device';
    const what = key === 'implementation' ? 'implementation' : key;
    this.change(`Change the ${what} of ${id}`, () => {
      // the deepest and the later list items first, so the others keep their places
      const paths = plan.removed.map((x) => x.path).sort((a, b) => {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          if (a[i] === b[i]) continue;
          if (typeof a[i] === 'number' && typeof b[i] === 'number') return (b[i] as number) - (a[i] as number);
          return 0;
        }
        return b.length - a.length;
      });
      for (const x of paths) this.removeAt(x);
      for (const k of ['protocols', 'services']) {
        const b = this.get(dp.concat(k));
        if (b && b.kind === 'map' && b.entries.size === 0) this.removeAt(dp.concat(k));
      }
      if (value === '') this.removeAt(where);
      else {
        if (key === 'implementation') this.ensureMap(dp.concat('services', 'separation'), this.orderFor(dp.concat('services')));
        this.setAt(where, strNode(value), this.orderFor(where.slice(0, -1)));
      }
    });
  }

  /** Add an empty block (a built-in function's configuration: a VPN gateway's VPN, a Security gateway's policy); its required fields are reported until filled in. One undo step. */
  addBlock(path: Path, what: string): void {
    this.change('Add ' + what, () => {
      if (path.length > 1) this.ensureMap(path.slice(0, -1), this.orderFor(path.slice(0, -2)));
      this.ensureMap(path, this.orderFor(path.slice(0, -1)));
    });
  }

  /**
   * What removing a service of a device takes with it, as lines for the
   * confirmation: its values (and, for Wireless access, the connections
   * that name its networks: they stay and are then reported).
   */
  appServiceRemoval(devIndex: number, id: string): { values: string[]; kept: string[] } {
    const sp: Path = ['devices', devIndex, 'services', id];
    const n = this.get(sp);
    const values: string[] = [];
    if (n && n.kind === 'map') n.entries.forEach((e, k) => values.push(`${k}: ${flowText(e.value) || scalarText(e.value) || '…'}`));
    const kept: string[] = [];
    const model = this.result.model;
    const dev = this.text(['devices', devIndex, 'id']);
    if (id === 'wireless' && model && dev) {
      const d = model.index.devices.get(dev);
      const nets = d && d.wireless ? d.wireless.networks.map((x) => x.id) : [];
      for (const l of model.links) if (l.wirelessNetwork !== undefined && nets.indexOf(l.wirelessNetwork) >= 0 && (l.a.device === dev || l.b.device === dev)) kept.push(`wireless connection ${l.id} (network ${l.wirelessNetwork})`);
    }
    return { values, kept };
  }

  /** Remove a service of a device (and an empty services block); one undo step. */
  removeService(devIndex: number, id: string, label: string): void {
    const dp: Path = ['devices', devIndex];
    this.change(`Remove ${label}`, () => {
      this.removeAt(dp.concat('services', id));
      const b = this.get(dp.concat('services'));
      if (b && b.kind === 'map' && b.entries.size === 0) this.removeAt(dp.concat('services'));
    });
  }

  // ------------------------------------------------------------ applications

  /** The path of a device's applications (`services.applications`). */
  appsPath(devIndex: number): Path {
    return ['devices', devIndex, 'services', 'applications'];
  }

  /** The ids of a device's applications as written, in file order. */
  appIds(devIndex: number): string[] {
    const n = this.get(this.appsPath(devIndex));
    if (!n || n.kind !== 'seq') return [];
    return n.items.map((_x, k) => this.text(this.appsPath(devIndex).concat(k, 'id')) || '');
  }

  private freeAppId(devIndex: number, base: string): string {
    const taken = new Set(this.appIds(devIndex));
    if (!taken.has(base)) return base;
    const m = /^(.*?)(\d+)$/.exec(base);
    const stem = m ? m[1] : base + '-';
    for (let n = m ? Number(m[2]) + 1 : 2; ; n++) if (!taken.has(stem + n)) return stem + n;
  }

  /**
   * Add an application to a device: an entry with a free id and a name
   * (the profile is the user's choice: the editor focuses it). Creates
   * the services block and the list when they are missing. One undo step;
   * returns the entry's index.
   */
  addApplication(devIndex: number): number {
    const lp = this.appsPath(devIndex);
    return this.change('Add application', () => {
      const id = this.freeAppId(devIndex, 'app1');
      this.ensureMap(lp.slice(0, -1), this.orderFor(lp.slice(0, -2)));
      const seq = this.ensureSeq(lp, false, this.orderFor(lp.slice(0, -1)));
      seq.items.push(mapNode([['id', strNode(id)], ['name', strNode('Application ' + id.replace(/^app/, ''))]]));
      return seq.items.length - 1;
    });
  }

  /** Duplicate an application (a free id, "(copy)" in its name), right after it. One undo step; returns the copy's index. */
  duplicateApplication(devIndex: number, k: number): number {
    const lp = this.appsPath(devIndex);
    const n = this.get(lp.concat(k));
    if (!n || n.kind !== 'map') return -1;
    return this.change('Duplicate application', () => {
      const copy = cloneNode(n) as YMap;
      const id = this.freeAppId(devIndex, (this.text(lp.concat(k, 'id')) || 'app') + '-2');
      setKey(copy, 'id', strNode(id), KEY_ORDER.application);
      const name = this.text(lp.concat(k, 'name'));
      if (name) setKey(copy, 'name', strNode(name + ' (copy)'), KEY_ORDER.application);
      const seq = this.get(lp) as YSeq;
      seq.items.splice(k + 1, 0, copy);
      return k + 1;
    });
  }

  /**
   * Where other applications name one ("device/app" as their peer), by
   * path. A rename rewrites them; a removal lists them first.
   */
  applicationRefs(device: string, app: string): Path[] {
    const out: Path[] = [];
    this.entities('device').forEach((d) => {
      const lp = this.appsPath(d.index);
      const n = this.get(lp);
      if (!n || n.kind !== 'seq') return;
      n.items.forEach((_x, j) => {
        if (this.text(lp.concat(j, 'peer')) === `${device}/${app}`) out.push(lp.concat(j, 'peer'));
      });
    });
    // a saved expectation's end that names it
    for (const e of this.analysisEntries('expectations')) for (const k of ['from', 'to']) if (this.text(['expectations', e.index, k]) === `${device}/${app}`) out.push(['expectations', e.index, k]);
    return out;
  }

  /** The references to an application as lines for a confirmation ("hmi/poll (peer)"). */
  applicationRefTexts(device: string, app: string): string[] {
    return this.applicationRefs(device, app).map((p) => (p[0] === 'expectations' ? `expectation ${this.text(['expectations', p[1], 'id']) || '?'} (its ${p[2] === 'from' ? 'source' : 'destination'}; it can’t be evaluated until you change it)` : `${this.text(['devices', p[1], 'id']) || '?'}/${this.text(p.slice(0, 5).concat('id')) || '?'} (its peer)`));
  }

  /**
   * Choose an application's profile: the fields that belong to no profile
   * of its kind any more are removed with it (one undo step); returns their
   * keys. Clearing the profile keeps everything (an error until it is chosen).
   */
  setAppProfile(appPath: Path, profile: string): string[] {
    const gone: string[] = [];
    this.change('Set application profile', () => {
      if (!profile) {
        this.removeAt(appPath.concat('profile'));
        return;
      }
      const m = this.ensureMap(appPath, KEY_ORDER.application);
      setKey(m, 'profile', strNode(profile), KEY_ORDER.application);
      const v: { [k: string]: unknown } = {};
      m.entries.forEach((e, k) => (v[k] = scalarText(e.value) !== undefined ? scalarText(e.value) : true));
      for (const prm of APP_PARAMS) {
        if (prm.when && m.entries.has(prm.key) && !prm.when(v)) {
          gone.push(prm.key);
          this.removeAt(appPath.concat(prm.key));
        }
      }
    });
    return gone;
  }

  /** Rename an application and every peer that names it. One undo step; returns the number of references updated. */
  renameApplication(devIndex: number, k: number, newId: string): number {
    const lp = this.appsPath(devIndex);
    const dev = this.text(['devices', devIndex, 'id']) || '';
    const old = this.text(lp.concat(k, 'id'));
    return this.change('Rename application', () => {
      const refs = old ? this.applicationRefs(dev, old) : [];
      setKey(this.ensureMap(lp.concat(k), KEY_ORDER.application), 'id', strNode(newId), KEY_ORDER.application);
      for (const p of refs) this.setAt(p, strNode(`${dev}/${newId}`));
      return refs.length;
    });
  }

  /**
   * Remove an application. The peers that name it lose their value (they
   * are reported as missing their peer until another is chosen); the list
   * and an empty services block go with the last one. One undo step.
   */
  removeApplication(devIndex: number, k: number): void {
    const lp = this.appsPath(devIndex);
    const dev = this.text(['devices', devIndex, 'id']) || '';
    const id = this.text(lp.concat(k, 'id'));
    this.change('Remove application', () => {
      // (the peers lose their value; a saved expectation keeps its text, and can't be evaluated until it is changed)
      const refs = id ? this.applicationRefs(dev, id).filter((p) => p[0] === 'devices') : [];
      // (from the end: removing a key never shifts another reference's path)
      for (const p of refs.reverse()) this.removeAt(p);
      this.removeAt(lp.concat(k));
      const left = this.get(lp);
      if (left && left.kind === 'seq' && !left.items.length) this.removeAt(lp);
      const b = this.get(['devices', devIndex, 'services']);
      if (b && b.kind === 'map' && b.entries.size === 0) this.removeAt(['devices', devIndex, 'services']);
    });
  }

  // ------------------------------------------------- failure domains and expectations

  /** The entries of an analysis section (`failure_domains`, `expectations`): index and id, in file order. */
  analysisEntries(section: 'failure_domains' | 'expectations'): Array<{ index: number; id: string }> {
    const s = this.get([section]);
    if (!s || s.kind !== 'seq') return [];
    return s.items.map((_n, i) => ({ index: i, id: this.text([section, i, 'id']) || '' }));
  }

  /** An id for a new entry of an analysis section, unique there (failure domains: also among the model's other ids). */
  private analysisId(section: 'failure_domains' | 'expectations', base: string): string {
    const taken = new Set(this.analysisEntries(section).map((e) => e.id));
    if (section === 'failure_domains') this.allIds().forEach((x) => taken.add(x));
    return this.uniqueId(base, taken);
  }

  /** Write the fields of an analysis entry (empty values remove the key; lists as flow lists). */
  private writeAnalysisFields(path: Path, kind: 'failureDomain' | 'expectation', fields: { [k: string]: string | string[] | undefined }): void {
    const m = this.ensureMap(path, KEY_ORDER[kind]);
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)) {
        if (m.entries.has(k)) this.removeAt(path.concat(k));
        continue;
      }
      setKey(m, k, Array.isArray(v) ? seqNode(v.map((x) => strNode(x)), true) : strNode(v.trim()), KEY_ORDER[kind]);
    }
  }

  /** Add a failure domain (name, kind, members); returns its index. One undo step. */
  addFailureDomain(fields: { label: string; kind: string; members: string[]; description?: string }): number {
    return this.change('Add failure domain', () => {
      const list = this.ensureSeq(['failure_domains']);
      const id = this.analysisId('failure_domains', (fields.label || 'domain').toLowerCase());
      list.items.push(mapNode([['id', strNode(id)]]));
      const i = list.items.length - 1;
      this.writeAnalysisFields(['failure_domains', i], 'failureDomain', { label: fields.label, kind: fields.kind, members: fields.members, description: fields.description });
      return i;
    }, { layout: false });
  }

  /** Change a failure domain's fields. One undo step. */
  updateFailureDomain(index: number, fields: { label?: string; kind?: string; members?: string[]; description?: string }): void {
    this.change('Edit failure domain', () => this.writeAnalysisFields(['failure_domains', index], 'failureDomain', fields), { layout: false });
  }

  /** The expectations whose failure condition names a failure domain (their ids). */
  failureDomainUsers(id: string): string[] {
    const out: string[] = [];
    for (const e of this.analysisEntries('expectations')) {
      const f = this.get(['expectations', e.index, 'failure']);
      const items = f && f.kind === 'seq' ? f.items.map((x) => scalarText(x)) : f ? [scalarText(f)] : [];
      if (items.indexOf(id) >= 0) out.push(e.id);
    }
    return out;
  }

  /** Rename a failure domain and every failure condition that names it. One undo step; returns the references updated. */
  renameFailureDomain(index: number, newId: string): number {
    const old = this.text(['failure_domains', index, 'id']);
    return this.change('Rename failure domain', () => {
      setKey(this.ensureMap(['failure_domains', index], KEY_ORDER.failureDomain), 'id', strNode(newId), KEY_ORDER.failureDomain);
      let n = 0;
      if (!old) return n;
      for (const e of this.analysisEntries('expectations')) {
        const f = this.get(['expectations', e.index, 'failure']);
        if (f && f.kind === 'seq')
          f.items.forEach((x, k) => {
            if (scalarText(x) === old) {
              this.setAt(['expectations', e.index, 'failure', k], strNode(newId));
              n++;
            }
          });
        else if (f && scalarText(f) === old) {
          this.setAt(['expectations', e.index, 'failure'], strNode(newId));
          n++;
        }
      }
      return n;
    }, { layout: false });
  }

  /** Remove a failure domain; the conditions that name it keep the name (they can't be evaluated until it is changed: the confirmation says so). One undo step. */
  removeFailureDomain(index: number): void {
    this.change('Delete failure domain', () => {
      this.removeAt(['failure_domains', index]);
      const s = this.get(['failure_domains']);
      if (s && s.kind === 'seq' && !s.items.length) this.removeAt(['failure_domains']);
    }, { layout: false });
  }

  /** Add an expectation; returns its index. One undo step. */
  addExpectation(fields: ExpectationFields & { name: string; expect: string; from: string }): number {
    return this.change('Add expectation', () => {
      const list = this.ensureSeq(['expectations']);
      const id = this.analysisId('expectations', (fields.name || 'expectation').toLowerCase());
      list.items.push(mapNode([['id', strNode(id)]]));
      const i = list.items.length - 1;
      this.writeAnalysisFields(['expectations', i], 'expectation', { ...fields });
      return i;
    }, { layout: false });
  }

  /** Change an expectation's fields (an empty value removes the key). One undo step. */
  updateExpectation(index: number, fields: ExpectationFields): void {
    this.change('Edit expectation', () => this.writeAnalysisFields(['expectations', index], 'expectation', { ...fields }), { layout: false });
  }

  /** Remove an expectation. One undo step. */
  removeExpectation(index: number): void {
    this.change('Delete expectation', () => {
      this.removeAt(['expectations', index]);
      const s = this.get(['expectations']);
      if (s && s.kind === 'seq' && !s.items.length) this.removeAt(['expectations']);
    }, { layout: false });
  }

  /** The analysis entries that name an object (for a delete confirmation): "expectation guest-no-mgmt", "failure domain rack-a". */
  analysisUsers(paths: Path[]): string[] {
    const out: string[] = [];
    for (const p of paths) {
      if (p[0] !== 'expectations' && p[0] !== 'failure_domains') continue;
      const id = this.text([p[0], p[1] as number, 'id']) || '?';
      const t = `${p[0] === 'expectations' ? 'expectation' : 'failure domain'} ${id}`;
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  /** The wireless connections that name a Wi-Fi network of a device ("link id"), in file order. */
  networkClients(device: string, network: string): string[] {
    const model = this.result.model;
    if (!model) return [];
    return model.links.filter((l) => l.wirelessNetwork === network && (l.a.device === device || l.b.device === device)).map((l) => l.id);
  }

  /** A Security gateway's permitted direction from one domain to the other, on or off (`directions:`); one undo step. */
  setSepDirection(sepPath: Path, from: string, to: string, on: boolean): void {
    const lp = sepPath.concat('directions');
    const cur = this.get(lp);
    const at = cur && cur.kind === 'seq' ? cur.items.findIndex((_x, j) => this.text(lp.concat(j, 'from')) === from && this.text(lp.concat(j, 'to')) === to) : -1;
    if (on === at >= 0) return;
    this.change(on ? `Permit ${from} → ${to}` : `No longer permit ${from} → ${to}`, () => {
      if (!on) {
        this.removeAt(lp.concat(at));
        const left = this.get(lp);
        if (left && left.kind === 'seq' && !left.items.length) this.removeAt(lp);
        return;
      }
      this.ensureMap(sepPath, this.orderFor(sepPath.slice(0, -1)));
      this.ensureSeq(lp, false, this.orderFor(sepPath)).items.push(mapNode([['from', strNode(from)], ['to', strNode(to)]], true));
    });
  }

  /** Add an empty entry (a scope, a zone, a reservation, a record) to a list of a server's services; one undo step. */
  addServiceItem(listPath: Path, what: string): void {
    this.change('Add ' + what, () => {
      this.ensureMap(listPath.slice(0, -1), this.orderFor(listPath.slice(0, -2)));
      this.ensureSeq(listPath, false, this.orderFor(listPath.slice(0, -1))).items.push(mapNode());
    });
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

  /**
   * Add a physical link or a logical relation between endpoints chosen in the
   * diagram, in one undo step. Endpoints are written as "device" or
   * "device:interface" (stable ids). `fields` are the other values entered
   * for it (empty values are left out); they are written in the format's key
   * order. Returns the new entry's index.
   */
  addConnection(kind: 'link' | 'relation', id: string, ends: string[], fields: Array<[string, string]> = []): number {
    const value = (k: string): string => (fields.find(([f]) => f === k) || ['', ''])[1].trim();
    // "device:interface" is written in double quotes, as in the format's examples
    const ref = (e: string): YNode => (e.indexOf(':') >= 0 ? { ...strNode(e), quoted: true, style: 'double' } : strNode(e));
    const entries: Array<[string, YNode]> = [];
    for (const key of SCHEMA[kind]) {
      if (key === 'id') entries.push(['id', strNode(id)]);
      else if (kind === 'link' && (key === 'a' || key === 'b')) entries.push([key, ref(ends[key === 'a' ? 0 : 1])]);
      else if (kind === 'relation' && key === 'endpoints') entries.push(['endpoints', seqNode(ends.map(ref), true)]);
      else if (value(key)) entries.push([key, strNode(value(key))]);
    }
    return this.change(`Add ${kind} ${id}`, () => {
      const node = mapNode(entries, kind === 'link');
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
      // DNS names of the same device that are associated with the interface
      if (iface !== undefined) {
        const dev = this.findEntity('device', id);
        if (dev) out.push(...this.dnsRefs(dev.index, iface));
      }
      epRefs('links', 'a/b');
      epRefs('relations', 'endpoints');
      // static routes of the same device that leave through the interface
      if (iface !== undefined) {
        const dev = this.findEntity('device', id);
        const rl = dev ? this.get(['devices', dev.index, 'routes']) : undefined;
        if (dev && rl && rl.kind === 'seq') {
          rl.items.forEach((it, k) => {
            const f = it.kind === 'map' ? it.entries.get('interface') : undefined;
            if (f && scalarText(f.value) === iface) out.push(['devices', dev.index, 'routes', k, 'interface']);
          });
        }
      }
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
      // applications: a peer that names the device (or one of its applications), an MQTT client's broker; a listener's bind interface
      this.entities('device').forEach((dev) => {
        const lp = this.appsPath(dev.index);
        const n = this.get(lp);
        if (!n || n.kind !== 'seq') return;
        n.items.forEach((_x, j) => {
          if (iface === undefined) {
            const peer = this.text(lp.concat(j, 'peer'));
            if (peer !== undefined && (peer === id || peer.indexOf(id + '/') === 0)) out.push(lp.concat(j, 'peer'));
            if (this.text(lp.concat(j, 'broker')) === id) out.push(lp.concat(j, 'broker'));
          } else if (dev.id === id && this.text(lp.concat(j, 'bind')) === iface) out.push(lp.concat(j, 'bind'));
        });
      });
      if (iface === undefined) {
        // a guest's host
        scalarRefs('devices', 'host', (t) => t === id);
        // an overlay network's other hosts
        this.entities('device').forEach((dev) => {
          const np: Path = ['devices', dev.index, 'services', 'container_engine', 'networks'];
          const nl = this.get(np);
          if (!nl || nl.kind !== 'seq') return;
          nl.items.forEach((it, k) => {
            const hl = it.kind === 'map' ? it.entries.get('hosts') : undefined;
            if (hl && hl.value.kind === 'seq') hl.value.items.forEach((h, j) => scalarText(h) === id && out.push(np.concat(k, 'hosts', j)));
          });
        });
      } else {
        const dev = this.findEntity('device', id);
        if (dev) {
          // a virtual switch's uplinks, a macvlan / ipvlan network's parent (on the same device)
          const vl = this.get(['devices', dev.index, 'services', 'hypervisor', 'vswitches']);
          if (vl && vl.kind === 'seq') {
            vl.items.forEach((vs, k) => {
              const ul = vs.kind === 'map' ? vs.entries.get('uplinks') : undefined;
              if (ul && ul.value.kind === 'seq') ul.value.items.forEach((u, j) => scalarText(u) === iface && out.push(['devices', dev.index, 'services', 'hypervisor', 'vswitches', k, 'uplinks', j]));
              else if (ul && scalarText(ul.value) === iface) out.push(['devices', dev.index, 'services', 'hypervisor', 'vswitches', k, 'uplinks']);
            });
          }
          const nl = this.get(['devices', dev.index, 'services', 'container_engine', 'networks']);
          if (nl && nl.kind === 'seq') {
            nl.items.forEach((n, k) => {
              const pn = n.kind === 'map' ? n.entries.get('parent') : undefined;
              if (pn && scalarText(pn.value) === iface) out.push(['devices', dev.index, 'services', 'container_engine', 'networks', k, 'parent']);
            });
          }
          // a guest's vnic bound to the port by passthrough
          for (const g of this.guestsOfHost(id)) {
            const gl = this.get(['devices', g.index, 'logical_interfaces']);
            if (!gl || gl.kind !== 'seq') continue;
            gl.items.forEach((it, k) => {
              const pt = it.kind === 'map' ? it.entries.get('passthrough') : undefined;
              if (pt && scalarText(pt.value) === iface) out.push(['devices', g.index, 'logical_interfaces', k, 'passthrough']);
            });
          }
        }
      }
    } else if (kind === 'group') {
      scalarRefs('groups', 'parent', (t) => t === id);
      scalarRefs('devices', 'group', (t) => t === id);
    } else if (kind === 'link' || kind === 'relation' || kind === 'network') {
      scalarRefs('relations', 'over', (t) => t === id);
    } else if (kind === 'protocol') {
      scalarRefs('relations', 'protocol', (t) => t.toLowerCase() === id.toLowerCase());
    }
    // the analysis sections: a failure domain's members (devices, cables, relations, groups); an expectation's ends and failure condition
    const ends = (t: string): boolean => {
      const head = t.split(/[:/]/)[0];
      if (kind !== 'device') return false;
      if (iface === undefined) return head === id;
      return t === `${id}:${iface}`;
    };
    if ((kind === 'device' || kind === 'link' || kind === 'relation' || kind === 'group') && iface === undefined) scalarRefs('failure_domains', 'members', (t) => t === id);
    if (kind === 'device') {
      scalarRefs('expectations', 'from', ends);
      scalarRefs('expectations', 'to', ends);
      if (iface === undefined) scalarRefs('expectations', 'boundary', (t) => t === id);
    }
    if (kind === 'device' || kind === 'link' || kind === 'relation') scalarRefs('expectations', 'failure', (t) => (kind === 'device' ? ends(t) : t === id));
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
      const inExpectation = p[0] === 'expectations' && (last === 'from' || last === 'to' || last === 'boundary' || p[p.length - 2] === 'failure' || last === 'failure');
      if (p[0] === 'failure_domains') {
        // a member: an id of a device, cable, relation or group
        nt = newId;
      } else if (inExpectation) {
        // an end or a failure entry: "device", "device:interface", "device/application", or a cable's, relation's or domain's id
        const m = /^([^:/]+)([:/])(.*)$/.exec(t);
        if (!m) nt = t === oldId ? newId : t;
        else if (m[2] === ':') nt = (m[1] === oldId ? newId : m[1]) + ':' + (oldIf !== undefined && m[3] === oldIf ? (newIf as string) : m[3]);
        else nt = (m[1] === oldId ? newId : m[1]) + '/' + m[3];
      } else if (last === 'source' || last === 'members' || p[p.length - 2] === 'members' || p[2] === 'dns_names' || (p[2] === 'routes' && last === 'interface') || last === 'passthrough' || (last === 'parent' && p[0] === 'devices') || p[p.length - 2] === 'uplinks' || last === 'uplinks' || last === 'bind') {
        // an interface of the same device, written as its bare id
        nt = newIf !== undefined ? newIf : t;
      } else if (last === 'peer') {
        // an application's peer: the device, or "device/application"
        const s = t.indexOf('/');
        nt = s > 0 ? newId + t.slice(s) : newId;
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
      // a router ID that names the loopback (the device's, or a protocol's own)
      let rids = 0;
      const dp = ipath.slice(0, 2);
      const ridPaths: Path[] = [dp.concat('router_id')];
      const block = this.get(dp.concat('protocols'));
      if (block && block.kind === 'map') block.entries.forEach((_e, k) => ridPaths.push(dp.concat('protocols', k, ROUTER_ID_KEY)));
      for (const rp of ridPaths) {
        if (oldIf === undefined || this.text(rp) !== oldIf) continue;
        this.setAt(rp, strNode(newIf));
        rids++;
      }
      return refs.length + rids;
    });
  }

  // ------------------------------------------------------------- checks

  /** The model's setting for a consistency check as written ('' when it has none: the check's default applies). */
  checkSetting(id: string): string {
    return this.text(['checks', id]) || '';
  }

  /**
   * Switch a check off or give it another severity in the model's `checks:`
   * section ('' removes the entry: the default applies again; the section
   * goes when it is empty). One undo step.
   */
  setCheck(id: string, value: string): void {
    this.change(value ? 'Set check ' + id : 'Reset check ' + id, () => {
      if (value) {
        this.ensureMap(['checks'], KEY_ORDER.top);
        this.setAt(['checks', id], strNode(value));
        return;
      }
      this.removeAt(['checks', id]);
      const c = this.get(['checks']);
      if (c && c.kind === 'map' && !c.entries.size) this.removeAt(['checks']);
    });
  }

  // ------------------------------------------------------------------ routes

  /** The static routes of a device as written, in file order: their path and their fields as text. */
  routeEntries(devIndex: number): RouteEntry[] {
    const base: Path = ['devices', devIndex, 'routes'];
    const list = this.get(base);
    if (!list || list.kind !== 'seq') return [];
    return list.items.map((it, k) => {
      const p = base.concat(k);
      const t = (key: string): string => (it.kind === 'map' ? this.text(p.concat(key)) || '' : '');
      const bh = it.kind === 'map' ? this.get(p.concat('blackhole')) : undefined;
      return { path: p, index: k, prefix: t('prefix'), via: t('via'), iface: t('interface'), blackhole: !!bh && bh.kind === 'scalar' && bh.value === true, distance: t('distance'), metric: t('metric'), vrf: t('vrf'), name: t('name') };
    });
  }

  /**
   * Add a static route to a device (one undo step); returns its index in the
   * device's `routes` list. Only the given fields are written, in the
   * format's key order: nothing is chosen for the user.
   */
  addRoute(devIndex: number, fields: Array<[string, string]>): number {
    const entries: Array<[string, YNode]> = [];
    for (const key of KEY_ORDER.route) {
      const f = fields.find(([k]) => k === key);
      const v = f ? f[1].trim() : '';
      if (!v) continue;
      if (key === 'blackhole') {
        if (v === 'true') entries.push([key, boolNode(true)]);
      } else if (key === 'distance' || key === 'metric') entries.push([key, /^[0-9]+$/.test(v) ? numNode(Number(v)) : strNode(v)]);
      else entries.push([key, strNode(v)]);
    }
    return this.change('Add route', () => {
      const list = this.ensureSeq(['devices', devIndex, 'routes'], false, KEY_ORDER.device);
      list.items.push(mapNode(entries, true));
      return list.items.length - 1;
    });
  }

  /** Duplicate a route of a device: the copy is inserted right after it (one undo step); returns its index. */
  duplicateRoute(devIndex: number, k: number): number {
    const list = this.get(['devices', devIndex, 'routes']);
    if (!list || list.kind !== 'seq' || !list.items[k]) return -1;
    return this.change('Duplicate route', () => {
      const copy = cloneNode(list.items[k]);
      delete copy.before;
      delete copy.blank;
      list.items.splice(k + 1, 0, copy);
      return k + 1;
    });
  }

  /** Delete a route of a device (one undo step); the last one removes the `routes` key. */
  deleteRoute(devIndex: number, k: number): void {
    const lp: Path = ['devices', devIndex, 'routes'];
    const list = this.get(lp);
    if (!list || list.kind !== 'seq' || !list.items[k]) return;
    this.change('Delete route', () => {
      list.items.splice(k, 1);
      if (!list.items.length) this.removeAt(lp);
    });
  }

  /** Switch the blackhole flag of a route: on removes its next hop (address and exit interface), off removes the flag. */
  setBlackhole(routePath: Path, on: boolean): void {
    this.change(on ? 'Make route a blackhole' : 'Route forwards again', () => {
      if (on) {
        this.removeAt(routePath.concat('via'));
        this.removeAt(routePath.concat('interface'));
        this.setAt(routePath.concat('blackhole'), boolNode(true), KEY_ORDER.route);
      } else this.removeAt(routePath.concat('blackhole'));
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
  addLogical(devIndex: number, type: 'loopback' | 'virtual' | 'tunnel' | 'vnic' | 'veth', fields: Array<[string, YNode]> = [], base?: string): number {
    const f = fields.filter(([k]) => k !== 'type');
    f.splice(f.length && f[0][0] === 'id' ? 1 : 0, 0, ['type', strNode(type)]);
    return this.change(`Add ${type} interface`, () => this.newIface(devIndex, 'logical_interfaces', f, base || (type === 'loopback' ? 'lo0' : type === 'tunnel' ? 'tun0' : 'virtual0')));
  }

  /** Add a loopback with a name and addresses; returns its index in the `logical_interfaces` list. */
  addLoopback(devIndex: number, addresses: string[] = [], name?: string, id?: string): number {
    const f: Array<[string, YNode]> = [];
    if (id) f.push(['id', strNode(id)]);
    if (name) f.push(['label', strNode(name)]);
    f.push(['ip', seqNode(addresses.map(strNode), true)]);
    return this.addLogical(devIndex, 'loopback', f);
  }

  /**
   * Delete a physical or logical interface. Its DNS-name associations are
   * removed in the same step (a DNS name left without any interface is
   * removed with them), so none of them can point at a missing interface.
   * Other references (links, relations, member lists, tunnels) are left as
   * they are and reported by validation.
   */
  deleteInterface(ipath: Path): void {
    const iface = this.ifaceIdAt(ipath);
    this.change('Delete interface', () => {
      if (iface) this.dropDnsRefs(ipath[1] as number, iface);
      this.removeAt(ipath);
    });
  }

  // --------------------------------------------------------------------- DHCP

  /** Does the interface at `ipath` obtain its IPv4 address by DHCP (`ipv4: dhcp`)? */
  dhcpOn(ipath: Path): boolean {
    return this.text(ipath.concat('ipv4')) === 'dhcp';
  }

  /** Can the interface at `ipath` use DHCP? Every physical and logical interface except a loopback. */
  dhcpAllowed(ipath: Path): boolean {
    return ifaceSchemaKind(ipath) === 'interface' || (ifaceSchemaKind(ipath) === 'logical' && this.text(ipath.concat('type')) !== 'loopback');
  }

  /** The addresses written at an interface, as text. */
  private ipTexts(ipath: Path): string[] {
    const n = this.get(ipath.concat('ip'));
    return !n ? [] : n.kind === 'seq' ? n.items.map((i) => scalarText(i) || '').filter((x) => x) : scalarText(n) !== undefined ? [scalarText(n) as string] : [];
  }

  /**
   * What turning DHCP on for an interface would remove: its manually
   * configured IPv4 addresses (its IPv6 ones stay) and its DNS-name
   * associations (`removed`: the name is associated with this interface
   * only, so it would be removed too).
   */
  dhcpImpact(ipath: Path): DhcpImpact {
    const addresses = this.ipTexts(ipath).filter((a) => a.indexOf(':') < 0);
    const iface = this.ifaceIdAt(ipath);
    return { addresses, dns: iface ? this.dnsAffected(ipath[1] as number, iface) : [] };
  }

  /**
   * Turn DHCP on or off for an interface's IPv4, as one undoable step. On:
   * its manual IPv4 addresses and the DNS-name associations of the
   * interface are removed (see dhcpImpact; the UI asks first) and
   * `ipv4: dhcp` is written. Off: the key is removed (static is the
   * format's default); nothing that was removed when it was turned on comes
   * back. A loopback can't use DHCP: turning it on is refused (turning it
   * off repairs a file that has it).
   */
  setDhcp(ipath: Path, on: boolean): void {
    const kind = ifaceSchemaKind(ipath);
    if (!kind || on === this.dhcpOn(ipath) || (on && !this.dhcpAllowed(ipath))) return;
    const iface = this.ifaceIdAt(ipath);
    this.change(on ? 'Turn DHCP on' : 'Turn DHCP off', () => {
      if (!on) {
        this.removeAt(ipath.concat('ipv4'));
        return;
      }
      if (iface) this.dropDnsRefs(ipath[1] as number, iface);
      const keep = this.ipTexts(ipath).filter((a) => a.indexOf(':') >= 0);
      this.removeAt(ipath.concat('ip'));
      if (keep.length) this.setAt(ipath.concat('ip'), keep.length === 1 ? strNode(keep[0]) : seqNode(keep.map((x) => strNode(x)), true), KEY_ORDER[kind]);
      this.setAt(ipath.concat('ipv4'), strNode('dhcp'), KEY_ORDER[kind]);
    });
  }

  // ---------------------------------------------------------------- DNS names

  /** Id of the interface at `ipath` (also for the "- eth0" short form). */
  private ifaceIdAt(ipath: Path): string | undefined {
    const n = this.get(ipath);
    if (!n) return undefined;
    return n.kind === 'map' ? this.text(ipath.concat('id')) : scalarText(n);
  }

  /** The `dns_names` entries of a device, as written. */
  dnsEntries(devIndex: number): DnsEntry[] {
    const list = this.get(['devices', devIndex, 'dns_names']);
    if (!list || list.kind !== 'seq') return [];
    return list.items.map((it, k) => {
      const path: Path = ['devices', devIndex, 'dns_names', k];
      const ifs = this.get(path.concat('interfaces'));
      const interfaces = !ifs ? [] : ifs.kind === 'seq' ? ifs.items.map((i) => scalarText(i) || '') : scalarText(ifs) !== undefined ? [scalarText(ifs) as string] : [];
      return { path, name: it.kind === 'map' ? this.text(path.concat('name')) : undefined, interfaces };
    });
  }

  /** Paths of the DNS-name associations of a device that name `iface` (list items, or the single value). */
  private dnsRefs(devIndex: number, iface: string): Path[] {
    const out: Path[] = [];
    for (const e of this.dnsEntries(devIndex)) {
      const ifs = this.get(e.path.concat('interfaces'));
      if (ifs && ifs.kind === 'seq') ifs.items.forEach((it, j) => scalarText(it) === iface && out.push(e.path.concat('interfaces', j)));
      else if (ifs && scalarText(ifs) === iface) out.push(e.path.concat('interfaces'));
    }
    return out;
  }

  /** DNS names associated with `iface`; `removed` when it is their only interface. */
  dnsAffected(devIndex: number, iface: string): Array<{ name: string; removed: boolean }> {
    return this.dnsEntries(devIndex)
      .filter((e) => e.interfaces.indexOf(iface) >= 0)
      .map((e) => ({ name: e.name || '(no name)', removed: e.interfaces.every((x) => x === iface) }));
  }

  /** Remove every association with `iface` (call inside change()); names left without an interface go, and so does an empty list. */
  private dropDnsRefs(devIndex: number, iface: string): void {
    const entries = this.dnsEntries(devIndex);
    for (let k = entries.length - 1; k >= 0; k--) {
      const e = entries[k];
      if (e.interfaces.indexOf(iface) < 0) continue;
      if (e.interfaces.every((x) => x === iface)) {
        this.removeAt(e.path);
        continue;
      }
      const ifs = this.get(e.path.concat('interfaces'));
      if (ifs && ifs.kind === 'seq') ifs.items = ifs.items.filter((it) => scalarText(it) !== iface);
    }
    const list = this.get(['devices', devIndex, 'dns_names']);
    if (list && list.kind === 'seq' && !list.items.length) this.removeAt(['devices', devIndex, 'dns_names']);
  }

  /**
   * Interfaces of a device a DNS name can be associated with: every
   * physical and logical interface with an id, except the ones with DHCP on.
   */
  dnsEligible(devIndex: number): IfaceEntry[] {
    return this.interfaceEntries(devIndex).filter((e) => !!e.id && !this.dhcpOn(e.path));
  }

  /**
   * Why a new DNS name can't be added to a device as given, or null if it
   * can: the name's syntax, a name the device already has, and at least one
   * eligible interface.
   */
  dnsNameError(devIndex: number, name: string, ifaces: string[]): string | null {
    const why = dnsNameProblem(name);
    if (why) return name ? `Not a valid DNS name: ${why}.` : 'Enter a DNS name, e.g. www.example.com.';
    const key = dnsNameKey(name);
    if (this.dnsEntries(devIndex).some((e) => e.name !== undefined && dnsNameKey(e.name) === key)) return `This device already has the DNS name “${name}”. Associate that entry with more interfaces instead.`;
    if (!ifaces.length) return 'Select at least one interface.';
    const ok = this.dnsEligible(devIndex).map((e) => e.id);
    const bad = ifaces.filter((x) => ok.indexOf(x) < 0);
    if (bad.length) return `Not an interface with manual addressing on this device: ${bad.join(', ')}.`;
    return null;
  }

  /** Add a DNS name associated with the given interfaces (one undoable step); returns its index, or -1 if it is not valid. */
  addDnsName(devIndex: number, name: string, ifaces: string[]): number {
    if (this.dnsNameError(devIndex, name, ifaces)) return -1;
    return this.change('Add DNS name', () => {
      const list = this.ensureSeq(['devices', devIndex, 'dns_names'], false, KEY_ORDER.device);
      list.items.push(mapNode([['name', strNode(name)], ['interfaces', seqNode(ifaces.map(strNode), true)]], true));
      return list.items.length - 1;
    });
  }

  /** Remove a DNS name of a device; the list goes when it is empty. */
  removeDnsName(devIndex: number, k: number): void {
    this.change('Remove DNS name', () => {
      this.removeAt(['devices', devIndex, 'dns_names', k]);
      const list = this.get(['devices', devIndex, 'dns_names']);
      if (list && list.kind === 'seq' && !list.items.length) this.removeAt(['devices', devIndex, 'dns_names']);
    });
  }
}

/** What turning DHCP on would remove (see ModelDoc.dhcpImpact). */
/** A static route of a device as written (fields as text, '' when not written). */
export interface RouteEntry {
  path: Path;
  index: number;
  prefix: string;
  via: string;
  iface: string;
  blackhole: boolean;
  distance: string;
  metric: string;
  vrf: string;
  name: string;
}

export interface DhcpImpact {
  addresses: string[];
  dns: Array<{ name: string; removed: boolean }>;
}

/** One entry of a device's `dns_names` in the document tree. */
export interface DnsEntry {
  path: Path;
  name: string | undefined;
  /** interface ids as written */
  interfaces: string[];
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

/** What deviceModelPlan changes. */
export type DeviceModelKey = 'type' | 'mode' | 'purpose' | 'implementation';

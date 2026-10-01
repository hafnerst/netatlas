/**
 * Editor UI: model outline + property inspector.
 *
 * All edits go through ModelDoc (undoable, validated). Inputs commit on
 * "change" (Enter / leaving the field), so nothing typed is lost when the
 * user clicks the diagram or another object: the browser fires "change"
 * before focus moves. Everything user-provided is rendered as text.
 *
 * Fields come in two kinds. Configured fields edit the one place in the YAML
 * file where a fact is stored. Derived fields (network members, the VLAN of
 * an interface, the trunk state of a link end) are computed from the current
 * model on every render, are read-only, and are never written to the file.
 */
import { DocMap, DocNode, ENTITY_KINDS, EntityKind, IfaceEntry, KEY_ORDER, ModelDoc, Path, SECTION, kindOfSection } from '../editor/document';
import { DialogOpts } from './dialogs';
import { el } from './dom';
import { sortedByName } from '../model/order';
import { CATEGORIES, InterfaceKind, LINE_STYLES, LOGICAL_IFACE_TYPES, VLAN_MAX, VLAN_MIN, ifaceKey, interfaceKindLabel } from '../model/types';
import { derivedVlanText, interfaceAddresses, interfaceVlanPorts, interfaceVlans, linkEndVlanText, networkMembers, vlanMismatch, vlanMismatchText } from '../model/derive';
import { builtinProtocols, normalizeProtocol } from '../model/protocols';
import { SelectionContext, contextState } from '../model/queries';
import { DEVICE_TYPES, isDeviceType } from '../model/device-types';
import { Issue, scalarText } from '../validation/validate';

/** `iface`: the document path of the selected physical or logical interface of a device. */
export type EditorSel = { kind: EntityKind | 'document'; index: number; iface?: Path } | null;

export interface EditorHost {
  /** called after every committed edit */
  changed(note?: string): void;
  /** the editor selected an entity: sync the diagram */
  selected(sel: EditorSel): void;
  dialog(opts: DialogOpts): Promise<string>;
  toast(msg: string): void;
}

const J = (p: Path): string => JSON.stringify(p);
/** Model ref of an outline entity (protocol ids are normalized in the model). */
const entityRef = (kind: EntityKind, id: string): string => kind + ':' + (kind === 'protocol' ? normalizeProtocol(id) : id);
const P = (s: string | null): Path => (s ? (JSON.parse(s) as Path) : []);

const MEDIA = ['fiber', 'copper', 'dac', 'aoc', 'wireless', 'lte', '5g', 'microwave', 'serial', 'virtual'];
const GROUP_KINDS = ['site', 'building', 'floor', 'room', 'rack', 'provider', 'cloud', 'zone', 'region'];

/** keys the format defines for a kind of mapping (single source: the format schema) */
const KNOWN: { [k: string]: string[] } = { ...KEY_ORDER, document: KEY_ORDER.top };

const KIND_TITLE: { [k in EntityKind]: string } = {
  device: 'Devices',
  link: 'Links (cables)',
  network: 'Networks',
  relation: 'Relations (logical)',
  group: 'Groups / locations',
  protocol: 'Protocols',
};

/** "10, 20 30-32" -> [10, 20, 30, 31, 32]; null if anything is not a VLAN ID or range. */
export function parseVlanList(text: string): number[] | null {
  const out: number[] = [];
  for (const part of text.split(/[\s,;]+/).filter((x) => x)) {
    const m = /^([0-9]{1,4})(?:-([0-9]{1,4}))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < VLAN_MIN || to > VLAN_MAX || to < from) return null;
    for (let v = from; v <= to; v++) if (out.indexOf(v) < 0) out.push(v);
  }
  return out.length ? out : null;
}

export class Editor {
  sel: EditorSel = null;
  /** open interface cards / collapsible sections, by path */
  private open = new Set<string>();
  private filter = '';
  /**
   * Sections of the model outline that are folded to their heading. Links
   * and protocols start folded: they are the longest lists and the ones
   * least often picked from here.
   */
  private collapsed = new Set<EntityKind>(['link', 'protocol']);
  /** unapplied text in the YAML source tab */
  sourceDraft: string | null = null;
  sourceError: string | null = null;

  constructor(private readonly d: Document, private readonly host: EditorHost, private readonly getDoc: () => ModelDoc | null) {}

  private get doc(): ModelDoc {
    return this.getDoc() as ModelDoc;
  }

  private e(tag: string, attrs: { [k: string]: string } = {}, children: Array<Node | string | null> = []): HTMLElement {
    return el(this.d, tag, attrs, children);
  }

  // ------------------------------------------------------------ selection

  /** Select by diagram ref ("device:x", "iface:dev:if", "relation:r" …). */
  selectRef(ref: string | null): void {
    if (!ref || !this.getDoc()) {
      this.sel = null;
      return;
    }
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i);
    const id = ref.slice(i + 1);
    if (kind === 'iface') {
      const c = id.indexOf(':');
      const dev = this.doc.findEntity('device', id.slice(0, c));
      if (!dev) return;
      const entry = this.doc.interfaceEntries(dev.index).find((e) => e.id === id.slice(c + 1));
      this.sel = { kind: 'device', index: dev.index, iface: entry ? entry.path : undefined };
      if (entry) this.openIface(entry.path);
      return;
    }
    const k = (kind === 'hub' ? 'relation' : kind) as EntityKind;
    if (!SECTION[k]) return;
    if (k === 'protocol') {
      // the model uses normalized protocol ids
      const i = this.doc.entities('protocol').findIndex((e) => !!e.id && normalizeProtocol(e.id) === id);
      if (i >= 0) this.sel = { kind: k, index: i };
      return;
    }
    const ent = this.doc.findEntity(k, id);
    if (ent) this.sel = { kind: k, index: ent.index };
  }

  /** Diagram ref for the current selection (null if the entity has no valid id). */
  selectedRef(): string | null {
    const s = this.sel;
    if (!s || s.kind === 'document' || !this.getDoc()) return null;
    const ent = this.doc.entities(s.kind)[s.index];
    if (!ent || !ent.id) return null;
    if (s.kind === 'device' && s.iface !== undefined) {
      const want = J(s.iface);
      const entry = this.doc.interfaceEntries(s.index).find((e) => J(e.path) === want);
      if (entry && entry.id) return `iface:${ent.id}:${entry.id}`;
    }
    return entityRef(s.kind, ent.id);
  }

  /** Open the card of an interface. */
  openIface(path: Path): void {
    this.open.add(J(path));
  }

  private selectEntity(kind: EntityKind | 'document', index: number): void {
    this.sel = { kind, index };
    this.host.selected(this.sel);
  }

  // -------------------------------------------------------------- outline

  /**
   * The model outline. With a selection context (from the diagram session),
   * entries are marked selected / directly related / not related; unrelated
   * entries stay visible and selectable.
   */
  renderOutline(box: HTMLElement, ctx: SelectionContext | null = null): void {
    while (box.firstChild) box.removeChild(box.firstChild);
    const doc = this.getDoc();
    if (!doc) {
      box.appendChild(this.e('p', { class: 'muted small' }, ['No model open. Use File → New model or Open model….']));
      return;
    }
    const f = this.e('input', { type: 'search', class: 'outline-filter', placeholder: 'Filter…', 'data-t': 'outline-filter', value: this.filter, 'aria-label': 'Filter the model outline' });
    (f as HTMLInputElement).value = this.filter;
    box.appendChild(f);
    const counts = this.issueCounts();
    const kinds: EntityKind[] = ['device', 'link', 'network', 'relation', 'group', 'protocol'];
    const allFolded = kinds.every((k) => this.collapsed.has(k));
    box.appendChild(
      this.e('div', { class: 'ol-tools' }, [
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'fold-all', 'data-kind': allFolded ? 'open' : 'close', title: allFolded ? 'Show the entries of every section' : 'Fold every section to its heading' }, [allFolded ? 'Expand all' : 'Collapse all']),
      ]),
    );
    if (ctx) {
      box.appendChild(
        this.e('p', { class: 'ol-ctx-hint small', 'data-related': String(ctx.related.size) }, [
          this.e('span', { class: 'ctx-mark sel', 'aria-hidden': 'true' }, ['▸']),
          ' selected · ',
          this.e('span', { class: 'ctx-mark rel', 'aria-hidden': 'true' }, ['•']),
          ` related (${ctx.related.size})`,
        ]),
      );
    }
    const q = this.filter.toLowerCase();
    for (const kind of kinds) {
      const ents = doc.entities(kind);
      const folded = this.collapsed.has(kind);
      // what a folded section still tells: problems inside it, and how many of its entries are related to the selection
      let errs = 0;
      let warns = 0;
      let related = 0;
      for (const ent of ents) {
        const c = counts.get(kind + '#' + ent.index);
        if (c) {
          errs += c.e;
          warns += c.w;
        }
        if (ctx && ent.id && contextState(ctx, entityRef(kind, ent.id)) === 'related') related++;
      }
      const sec = this.e('section', { class: 'ol-section' + (folded ? ' folded' : ''), 'data-section': kind, 'data-folded': folded ? 'true' : 'false' });
      const listId = 'ol-list-' + kind;
      sec.appendChild(
        this.e('div', { class: 'ol-head' }, [
          this.e('button', { type: 'button', class: 'ol-toggle', 'data-act': 'fold', 'data-kind': kind, 'aria-expanded': folded ? 'false' : 'true', 'aria-controls': listId, title: (folded ? 'Show' : 'Hide') + ' the entries of this section' }, [
            this.e('span', { class: 'ol-caret', 'aria-hidden': 'true' }, [folded ? '▸' : '▾']),
            this.e('span', { class: 'ol-title' }, [`${KIND_TITLE[kind]} (${ents.length})`]),
            folded && related ? this.e('span', { class: 'ol-related', title: `${related} related to the selection` }, [`• ${related}`]) : null,
            folded ? this.badge(errs, warns) : null,
          ]),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-entity', 'data-kind': kind, title: 'Add ' + kind }, ['+ Add']),
        ]),
      );
      const list = this.e('div', { class: 'ol-list', id: listId });
      sec.appendChild(list);
      for (const ent of ents) {
        const label = this.entityLabel(kind, ent.index);
        const active = !!this.sel && this.sel.kind === kind && this.sel.index === ent.index;
        const st = ent.id ? contextState(ctx, entityRef(kind, ent.id)) : ctx ? 'unrelated' : null;
        // A folded section shows its heading only, except for what would otherwise be lost from
        // view: the entry that is selected, and the matches of the filter.
        if (q ? (label + ' ' + (ent.id || '')).toLowerCase().indexOf(q) < 0 : folded && !active && st !== 'selected') continue;
        const c = counts.get(kind + '#' + ent.index) || { e: 0, w: 0 };
        const attrs: { [k: string]: string } = { type: 'button', class: 'ol-item' + (active ? ' active' : '') + (st ? ' ctx-' + st : ''), 'data-act': 'select', 'data-kind': kind, 'data-index': String(ent.index), title: ent.id || '(no id)' };
        if (ent.id) attrs['data-ref'] = entityRef(kind, ent.id);
        if (st) attrs['data-ctx'] = st;
        if (st === 'selected' || (!st && active)) attrs['aria-current'] = 'true';
        list.appendChild(
          this.e('button', attrs, [
            st === 'selected' || st === 'related' ? this.e('span', { class: 'ctx-mark ' + (st === 'selected' ? 'sel' : 'rel'), 'aria-hidden': 'true' }, [st === 'selected' ? '▸' : '•']) : null,
            this.e('span', { class: 'ol-label' }, [label]),
            st ? this.e('span', { class: 'sr-only' }, [st === 'selected' ? ' (selected)' : st === 'related' ? ' (directly related)' : ' (not related)']) : null,
            this.badge(c.e, c.w),
          ]),
        );
      }
      box.appendChild(sec);
    }
  }

  private badge(e: number, w: number): HTMLElement | null {
    if (!e && !w) return null;
    return this.e('span', { class: 'ol-badge ' + (e ? 'err' : 'warn'), title: `${e} error(s), ${w} warning(s)` }, [String(e || w)]);
  }

  private issueCounts(): Map<string, { e: number; w: number }> {
    const m = new Map<string, { e: number; w: number }>();
    const doc = this.doc;
    for (const is of doc.errors.concat(doc.warnings)) {
      const ent = doc.issueEntity(is);
      const key = ent ? ent.kind + '#' + ent.index : 'document';
      const c = m.get(key) || { e: 0, w: 0 };
      if (is.severity === 'error') c.e++;
      else c.w++;
      m.set(key, c);
    }
    return m;
  }

  entityLabel(kind: EntityKind, index: number): string {
    const doc = this.doc;
    const base: Path = [SECTION[kind], index];
    const id = doc.text(base.concat('id'));
    const label = doc.text(base.concat('label'));
    if (kind === 'relation') {
      const proto = doc.text(base.concat('protocol')) || '?';
      return `${proto.toUpperCase()} · ${label || id || '(no id)'}`;
    }
    if (kind === 'link') {
      const a = this.epText(base.concat('a'));
      const b = this.epText(base.concat('b'));
      return `${id || '(no id)'}: ${a || '?'} ⟷ ${b || '?'}`;
    }
    return label && label !== id ? `${label} (${id || 'no id'})` : id || '(no id)';
  }

  private epText(p: Path): string {
    const n = this.doc.get(p);
    if (!n) return '';
    if (n.kind === 'scalar') return scalarText(n) || '';
    if (n.kind === 'map') {
      const d = this.doc.text(p.concat('device')) || '?';
      const i = this.doc.text(p.concat('interface'));
      return i ? d + ':' + i : d;
    }
    return '';
  }

  // ------------------------------------------------------------ inspector

  renderInspector(box: HTMLElement): void {
    while (box.firstChild) box.removeChild(box.firstChild);
    const doc = this.getDoc();
    const wrap = this.e('div', { class: 'inspector' });
    box.appendChild(wrap);
    if (!doc) {
      wrap.appendChild(this.e('p', { class: 'muted' }, ['No model open.']));
      return;
    }
    const s = this.sel;
    if (!s || (s.kind !== 'document' && !doc.entities(s.kind)[s.index])) {
      this.sel = null;
      wrap.appendChild(this.e('h3', {}, ['Edit']));
      wrap.appendChild(
        this.e('p', { class: 'muted' }, [
          'Select an object in the diagram or in the Model outline to edit it, or add one with “+ Add”. Changes apply when you press Enter or leave a field, and can be undone (Ctrl+Z).',
        ]),
      );
      wrap.appendChild(this.e('button', { type: 'button', 'data-act': 'select', 'data-kind': 'document', 'data-index': '0' }, ['Edit model settings']));
      return;
    }
    if (s.kind === 'document') this.renderDocument(wrap);
    else this.renderEntity(wrap, s.kind, s.index);
  }

  private renderDocument(w: HTMLElement): void {
    w.appendChild(this.header('model', this.doc.text(['title']) || 'Untitled model', null));
    w.appendChild(this.issueBox([]));
    w.appendChild(this.field('Model format version', this.e('span', { class: 'ro' }, [this.doc.text(['netatlas']) || '(missing)']), ['netatlas'], 'The version of the NetAtlas YAML model format, not of the application. The only supported value is 1.'));
    if (ENTITY_KINDS.every((k) => this.doc.entities(k).length === 0)) {
      w.appendChild(this.e('p', { class: 'hint-empty' }, ['This model is empty. Add a device, link, network, relation, group or protocol with “+ Add” in the Model outline; nothing is filled in for you.']));
    }
    w.appendChild(this.textField(['title'], 'Title', 'top'));
    w.appendChild(this.textField(['description'], 'Description', 'top', 'textarea'));
    w.appendChild(this.otherProps([], 'document'));
    w.appendChild(
      this.e('p', { class: 'muted small' }, [
        `File: ${this.doc.fileName} (${this.doc.origin === 'file' ? 'imported — downloads are saved as a new copy' : this.doc.origin === 'new' ? 'new model' : 'built-in example'}).`,
      ]),
    );
  }

  private header(kind: string, title: string, actions: HTMLElement | null): HTMLElement {
    return this.e('div', { class: 'insp-head' }, [this.e('span', { class: 'badge' }, [kind]), this.e('h3', {}, [title]), actions]);
  }

  private entityActions(kind: EntityKind, index: number): HTMLElement {
    return this.e('div', { class: 'insp-actions' }, [
      this.e('button', { type: 'button', class: 'mini', 'data-act': 'dup-entity', 'data-kind': kind, 'data-index': String(index) }, ['Duplicate']),
      this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-entity', 'data-kind': kind, 'data-index': String(index) }, ['Delete']),
    ]);
  }

  /** All issues of the entity, summarized at the top. */
  private issueBox(issues: Issue[]): HTMLElement {
    const doc = this.doc;
    const list = issues.length || this.sel?.kind !== 'document' ? issues : doc.errors.concat(doc.warnings).filter((i) => !doc.issueEntity(i));
    if (!list.length) return this.e('div', { class: 'issue-ok' }, ['✓ No problems']);
    const ul = this.e('ul', { class: 'issue-list' });
    for (const is of list.slice(0, 30)) ul.appendChild(this.e('li', { class: is.severity }, [this.e('b', {}, [is.severity === 'error' ? 'Error: ' : 'Warning: ']), is.message]));
    if (list.length > 30) ul.appendChild(this.e('li', {}, [`… and ${list.length - 30} more`]));
    return ul;
  }

  private renderEntity(w: HTMLElement, kind: EntityKind, index: number): void {
    const doc = this.doc;
    const base: Path = [SECTION[kind], index];
    const node = doc.get(base);
    w.appendChild(this.header(kind, this.entityLabel(kind, index), this.entityActions(kind, index)));
    w.appendChild(this.issueBox(doc.issuesAt(base)));
    if (!node || node.kind !== 'map') {
      w.appendChild(this.e('p', { class: 'muted' }, ['This entry is not a mapping; edit it in the YAML tab or delete it.']));
      if (node) w.appendChild(this.generic(base, node, 0));
      return;
    }
    const o = kind;
    const add = (x: HTMLElement): void => {
      w.appendChild(x);
    };
    add(this.idField(base, kind));
    if (kind === 'device') {
      add(this.textField(base.concat('label'), 'Label', o, 'textarea', undefined, 'Shown in full in the diagram; long labels wrap. Line breaks typed here are kept.'));
      add(this.typeField(base.concat('type'), o));
      add(this.refField(base.concat('group'), 'Group / location', o, this.ids('group')));
      add(this.intField(base.concat('tier'), 'Tier (0–9)', o, 'Row in the physical view; 0 = top. Leave empty for automatic.'));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
      this.renderInterfaces(w, index);
    } else if (kind === 'link') {
      add(this.endpointField(base.concat('a'), 'End A', o, false));
      add(this.endVlansField(base.concat('a'), 'A'));
      add(this.endpointField(base.concat('b'), 'End B', o, false));
      add(this.endVlansField(base.concat('b'), 'B'));
      add(this.vlanMismatchNote(index));
      add(this.textField(base.concat('medium'), 'Medium', o, 'text', MEDIA, 'The medium of the physical connection. It is configured here only; ports have no medium of their own.'));
      add(this.textField(base.concat('speed'), 'Speed', o, 'text', ['100M', '1G', '10G', '25G', '40G', '100G', '400G'], 'The speed of the physical connection. It is configured here only; ports have no speed of their own.'));
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.textField(base.concat('cable'), 'Cable / circuit id', o));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'network') {
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.listField(base.concat('cidr'), 'Prefixes (CIDR)', o, '192.0.2.0/24 or 2001:db8::/64', 'An IP network is defined by its prefixes. Every device with an address inside one of them is a member.'));
      add(this.intField(base.concat('vlan'), `VLAN ID (${VLAN_MIN}–${VLAN_MAX})`, o, 'The VLAN this IP network lives in. Interfaces with an address in the network show it as their VLAN. (VLANs permitted on a cable are set on the link’s ends.)'));
      add(this.membersField(index));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'relation') {
      const protos = Array.from(builtinProtocols().keys()).concat(this.ids('protocol'));
      add(this.textField(base.concat('protocol'), 'Protocol', o, 'text', protos, 'Required. Any name. Built-in protocols get a default category and colour; define new ones under Protocols.', 'Select or type a protocol'));
      add(this.enumField(base.concat('category'), 'Category', o, CATEGORIES as unknown as string[], '(from protocol)'));
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.endpointList(base.concat('endpoints'), 'Endpoints', o));
      add(this.overField(base.concat('over'), 'Carried over (underlay)', o, index));
      add(this.refField(base.concat('network'), 'Network', o, this.ids('network')));
      add(this.boolField(base.concat('directed'), 'Directed (first → last endpoint)', o));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'group') {
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.textField(base.concat('kind'), 'Kind', o, 'text', GROUP_KINDS, undefined, 'Select or type a group kind'));
      const self = doc.text(base.concat('id'));
      add(this.refField(base.concat('parent'), 'Parent group', o, this.ids('group').filter((g) => g !== self)));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'protocol') {
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.enumField(base.concat('category'), 'Category', o, CATEGORIES as unknown as string[], 'Select category'));
      add(this.colorField(base.concat('color'), 'Colour', o));
      add(this.enumField(base.concat('style'), 'Line style', o, LINE_STYLES as unknown as string[], '(from category)'));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    }
    if (kind !== 'protocol') add(this.attrsField(base.concat('attrs'), kind === 'relation' ? 'Protocol-specific attributes (attrs)' : 'Attributes (attrs)', o));
    add(this.otherProps(base, kind));
  }

  private ids(kind: EntityKind): string[] {
    return this.doc
      .entities(kind)
      .map((e) => e.id)
      .filter((x): x is string => !!x);
  }

  // ------------------------------------------------------- interface cards

  /**
   * The interfaces of a device in their two categories: physical and
   * logical. Cards are shown in alphabetical order of their ids; identical
   * ids keep their file order. Only the display is sorted: every card still
   * edits its own entry, and the lists in the file stay in the order they have.
   */
  private renderInterfaces(w: HTMLElement, devIndex: number): void {
    const doc = this.doc;
    const entries = doc.interfaceEntries(devIndex);
    const sorted = (kind: IfaceEntry['kind']): IfaceEntry[] => sortedByName(entries.filter((e) => e.kind === kind), (e) => e.id || '');
    const notList = (key: string): HTMLElement | null => {
      const n = doc.get(['devices', devIndex, key]);
      return n && n.kind !== 'seq' && !(n.kind === 'scalar' && n.value === null) ? this.e('p', { class: 'field-err' }, [`"${key}" is not a list; fix it in the YAML tab.`]) : null;
    };

    const phys = sorted('interface');
    const is = this.e('section', { class: 'sub', 'data-list': 'interfaces' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`Physical interfaces (${phys.length})`]),
        this.e('span', { class: 'ctl row' }, [
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-iface', 'data-index': String(devIndex), title: 'Add one physical interface' }, ['+ Interface']),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-range', 'data-index': String(devIndex), title: 'Add a numbered range of physical interfaces, e.g. ge 1/1 to ge 1/24' }, ['+ Port Range']),
        ]),
      ]),
      phys.length ? null : this.e('p', { class: 'muted small' }, ['The ports of the device. Only they can be cabled.']),
      notList('interfaces'),
    ]);
    for (const e of phys) is.appendChild(this.ifaceCard(devIndex, e));
    w.appendChild(is);

    const logical = sorted('logical');
    const add = (type: string, label: string): HTMLElement => this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-logical', 'data-index': String(devIndex), 'data-kind': type }, [label]);
    const ls = this.e('section', { class: 'sub', 'data-list': 'logical' }, [
      this.e('div', { class: 'sub-head' }, [this.e('h4', {}, [`Logical interfaces (${logical.length})`]), this.e('span', { class: 'ctl row' }, [add('loopback', '+ Loopback'), add('virtual', '+ Virtual'), add('tunnel', '+ Tunnel')])]),
      logical.length ? null : this.e('p', { class: 'muted small' }, ['Loopbacks, virtual interfaces (a VLAN interface, a bond, a subinterface …) and tunnel interfaces. Not ports, never cabled; usable as relation endpoints.']),
      notList('logical_interfaces'),
    ]);
    for (const e of logical) ls.appendChild(this.ifaceCard(devIndex, e));
    w.appendChild(ls);
    w.appendChild(this.dnsSection(devIndex));
  }

  // ------------------------------------------------------------ DNS names

  /** How an interface is shown in DNS-name selectors: its name (label), with the id it is stored as. */
  private ifaceName(devIndex: number, id: string): string {
    const e = this.doc.interfaceEntries(devIndex).find((x) => x.id === id);
    const label = e ? this.doc.text(e.path.concat('label')) : undefined;
    return label && label !== id ? `${label} (${id})` : id;
  }

  /** Manually configured addresses of an interface of a device, as written. */
  private ifaceAddrs(devIndex: number, id: string): string[] {
    const e = this.doc.interfaceEntries(devIndex).find((x) => x.id === id);
    return e ? this.listTexts(e.path.concat('ip')) : [];
  }

  /** The note for interfaces with several addresses: the name belongs to the interface, not to one address. */
  private multiAddrNote(devIndex: number, ids: string[]): HTMLElement | null {
    const multi = ids.filter((id) => this.ifaceAddrs(devIndex, id).length > 1);
    if (!multi.length) return null;
    return this.e('div', { class: 'help dns-multi', 'data-dns-multi': multi.join(',') }, [
      `${multi.map((id) => `${id} has ${this.ifaceAddrs(devIndex, id).length} addresses`).join('; ')}: the name is associated with the interface, not with one particular address.`,
    ]);
  }

  /**
   * The DNS names of a device, after its interfaces. Each name is entered
   * once and associated with one or more interfaces of the device (stored by
   * interface id). Interfaces with DHCP on can't be selected. Only the
   * association is stored: no DNS record is created or derived.
   */
  private dnsSection(devIndex: number): HTMLElement {
    const doc = this.doc;
    const entries = sortedByName(doc.dnsEntries(devIndex), (e) => e.name || '');
    const listPath: Path = ['devices', devIndex, 'dns_names'];
    const n = doc.get(listPath);
    const sec = this.e('section', { class: 'sub', 'data-list': 'dns-names' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`DNS names (${entries.length})`]),
        this.e('span', { class: 'ctl row' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-dns', 'data-index': String(devIndex), title: 'Add a DNS name and associate it with interfaces of this device' }, ['+ DNS name'])]),
      ]),
      entries.length ? null : this.e('p', { class: 'muted small' }, ['Names of this device, each associated with one or more of its interfaces that have DHCP off. Only the name and its interfaces are stored; no DNS record is created.']),
      n && n.kind !== 'seq' && !(n.kind === 'scalar' && n.value === null) ? this.e('p', { class: 'field-err' }, ['"dns_names" is not a list; fix it in the YAML tab.']) : null,
    ]);
    const eligible = sortedByName(doc.dnsEligible(devIndex), (e) => e.id as string).map((e) => e.id as string);
    for (const e of entries) {
      const k = e.path[3] as number;
      const iss = doc.issuesAt(e.path);
      const box = this.e('div', { class: 'dns-entry' + (iss.some((i) => i.severity === 'error') ? ' invalid' : ''), 'data-dns': e.name || '' });
      const node = doc.get(e.path);
      if (!node || node.kind !== 'map') {
        box.appendChild(this.e('div', { class: 'field-err' }, ['This entry is not a mapping with "name:" and "interfaces:"; fix it in the YAML tab or delete it.']));
        box.appendChild(this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-dns', 'data-index': String(devIndex), 'data-k': String(k) }, ['Delete']));
        sec.appendChild(box);
        continue;
      }
      const nameInput = this.input(e.path.concat('name'), 'text', e.name || '', { 'data-o': 'dnsName', placeholder: 'www.example.com', 'aria-label': 'DNS name' });
      box.appendChild(
        this.e('div', { class: 'list-row dns-name-row' }, [
          nameInput,
          this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-dns', 'data-index': String(devIndex), 'data-k': String(k), title: `Delete the DNS name ${e.name || ''}` }, ['×']),
        ]),
      );
      for (const is of doc.issuesAt(e.path.concat('name'))) box.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      const ip = e.path.concat('interfaces');
      const ifn = doc.get(ip);
      const chips = this.e('div', { class: 'vlan-chips dns-ifaces' });
      e.interfaces.forEach((id, j) => {
        const at = ifn && ifn.kind === 'seq' ? ip.concat(j) : ip;
        const last = e.interfaces.length === 1;
        chips.appendChild(
          this.e('span', { class: 'ref-chip' + (eligible.indexOf(id) < 0 ? ' invalid' : ''), 'data-dns-iface': id }, [
            this.ifaceName(devIndex, id),
            last
              ? null
              : this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(at), title: `Remove the association with ${id}` }, ['×']),
          ]),
        );
      });
      box.appendChild(chips);
      const pick = this.e('select', { 'data-p': J(ip), 'data-t': 'dns-iface-append', 'aria-label': `Associate ${e.name || 'this name'} with another interface` }) as HTMLSelectElement;
      const more = eligible.filter((id) => e.interfaces.indexOf(id) < 0);
      pick.appendChild(this.e('option', { value: '' }, [more.length ? '+ associate an interface…' : '(no other interface with manual addressing)']));
      for (const id of more) pick.appendChild(this.e('option', { value: id }, [this.ifaceName(devIndex, id)]));
      box.appendChild(pick);
      for (const is of doc.issuesAt(ip)) box.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      const note = this.multiAddrNote(devIndex, e.interfaces);
      if (note) box.appendChild(note);
      sec.appendChild(box);
    }
    if (entries.length) {
      sec.appendChild(
        this.e('p', { class: 'muted small' }, [
          'A name is associated with whole interfaces (physical or logical), not with one of their addresses, and only names what is configured: no A or AAAA record is created. The last interface of a name can’t be removed: delete the name instead. Interfaces with DHCP on are not offered.',
        ]),
      );
    }
    return sec;
  }

  /**
   * "+ DNS name": ask for the name and the interfaces it belongs to, and
   * create the entry only when both are valid. Cancel changes nothing.
   */
  private async addDnsName(devIndex: number): Promise<void> {
    const doc = this.doc;
    const nameIn = this.e('input', { type: 'text', id: 'dns-name', spellcheck: 'false', autocomplete: 'off', placeholder: 'www.example.com' }) as HTMLInputElement;
    const eligible = sortedByName(doc.dnsEligible(devIndex), (e) => e.id as string).map((e) => e.id as string);
    const dhcp = sortedByName(doc.interfaceEntries(devIndex).filter((e) => !!e.id && doc.dhcpOn(e.path)), (e) => e.id as string).map((e) => e.id as string);
    const boxes = eligible.map((id) => this.e('input', { type: 'checkbox', value: id }) as HTMLInputElement);
    const list = this.e('div', { id: 'dns-ifaces', class: 'dns-pick' }, eligible.length ? eligible.map((id, k) => this.e('label', { class: 'dns-pick-row' }, [boxes[k], ' ' + this.ifaceName(devIndex, id)])) : [this.e('span', { class: 'muted' }, ['This device has no interface with manual addressing.'])]);
    const preview = this.e('div', { id: 'dns-preview', class: 'range-preview', role: 'status', 'aria-live': 'polite' });
    let create: HTMLButtonElement | null = null;
    const chosen = (): string[] => boxes.filter((b) => b.checked).map((b) => b.value);
    const refresh = (): void => {
      while (preview.firstChild) preview.removeChild(preview.firstChild);
      const err = doc.dnsNameError(devIndex, nameIn.value.trim(), chosen());
      const untouched = !nameIn.value.trim() && !chosen().length;
      preview.setAttribute('data-state', err ? (untouched ? 'empty' : 'error') : 'ok');
      if (err) preview.appendChild(this.e('div', { class: untouched ? 'muted' : 'field-err' }, [untouched ? 'Enter the name once and select every interface it belongs to.' : err]));
      else preview.appendChild(this.e('div', {}, [`“${nameIn.value.trim()}” will be associated with ${chosen().map((id) => this.ifaceName(devIndex, id)).join(', ')}.`]));
      const note = this.multiAddrNote(devIndex, chosen());
      if (note) preview.appendChild(note);
      if (create) create.disabled = !!err;
    };
    const answer = await this.host.dialog({
      title: 'Add a DNS name',
      body: [
        this.e('div', { class: 'range-form' }, [this.e('label', { class: 'dl-label' }, ['Name ', nameIn])]),
        this.e('div', { class: 'dl-label' }, ['Interfaces']),
        list,
        dhcp.length ? this.e('p', { class: 'muted small', 'data-dns-excluded': dhcp.join(',') }, [`Not offered because DHCP is on: ${dhcp.join(', ')}.`]) : null,
        preview,
        this.e('p', { class: 'muted small' }, ['Only the name and its interfaces are stored: no DNS record is created. You can undo this with Ctrl+Z.']),
      ].filter((x): x is HTMLElement => !!x),
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Add DNS name', value: 'create', kind: 'primary' },
      ],
      ready: (dialog) => {
        create = dialog.querySelector('[data-value="create"]') as HTMLButtonElement | null;
        nameIn.addEventListener('input', refresh);
        for (const b of boxes) b.addEventListener('change', refresh);
        nameIn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && create && !create.disabled) {
            e.preventDefault();
            create.click();
          }
        });
        refresh();
      },
    });
    if (answer !== 'create') return;
    const name = nameIn.value.trim();
    if (doc.addDnsName(devIndex, name, chosen()) < 0) {
      this.host.toast(doc.dnsNameError(devIndex, name, chosen()) || 'The DNS name was not added.');
      return;
    }
    this.host.changed(`DNS name “${name}” added.`);
  }

  /**
   * The DHCP switch of an interface. Turning it on removes the manual
   * addresses and the DNS-name associations of the interface, so when there
   * are any, it asks first and lists them; Cancel changes nothing.
   */
  private async toggleDhcp(p: Path): Promise<void> {
    const doc = this.doc;
    const on = !doc.dhcpOn(p);
    const ifid = doc.text(p.concat('id')) || scalarText(doc.get(p) as DocNode) || '?';
    if (on) {
      const imp = doc.dhcpImpact(p);
      if (imp.addresses.length || imp.dns.length) {
        const body: Array<Node | string> = [];
        if (imp.addresses.length) {
          body.push(this.e('p', {}, [`An interface that obtains its address by DHCP has no manually configured addresses. ${imp.addresses.length === 1 ? 'This address is' : `These ${imp.addresses.length} addresses are`} deleted:`]));
          body.push(this.e('ul', { class: 'dhcp-loss', 'data-loss': 'addresses' }, imp.addresses.map((a) => this.e('li', { class: 'ro' }, [a]))));
        }
        if (imp.dns.length) {
          body.push(this.e('p', {}, ['A DNS name can only be associated with an interface whose addresses are configured. These associations are removed:']));
          body.push(
            this.e(
              'ul',
              { class: 'dhcp-loss', 'data-loss': 'dns' },
              imp.dns.map((x) => this.e('li', {}, [this.e('span', { class: 'ro' }, [x.name]), x.removed ? ' — it has no other interface, so the name is deleted too' : ''])),
            ),
          );
        }
        body.push(this.e('p', { class: 'muted small' }, ['Turning DHCP off later does not bring them back. You can undo this with Ctrl+Z.']));
        const a = await this.host.dialog({
          title: `Turn DHCP on for “${ifid}”?`,
          body,
          buttons: [
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete and turn DHCP on', value: 'dhcp', kind: 'danger' },
          ],
        });
        if (a !== 'dhcp') return;
      }
    }
    doc.setDhcp(p, on);
    this.host.changed(on ? `DHCP on for ${ifid}: it has no manually configured addresses.` : `DHCP off for ${ifid}: addresses can be entered again.`);
  }

  /**
   * "+ Port Range": ask for the first and the last port name, show what
   * would be created while typing, and create the ports only when the whole
   * range is valid. Cancel, or an invalid range, changes nothing.
   */
  private async addPortRange(devIndex: number): Promise<void> {
    const doc = this.doc;
    const from = this.e('input', { type: 'text', id: 'range-from', spellcheck: 'false', autocomplete: 'off', placeholder: 'ge 1/1' }) as HTMLInputElement;
    const to = this.e('input', { type: 'text', id: 'range-to', spellcheck: 'false', autocomplete: 'off', placeholder: 'ge 1/24' }) as HTMLInputElement;
    const preview = this.e('div', { id: 'range-preview', class: 'range-preview', role: 'status', 'aria-live': 'polite' });
    let create: HTMLButtonElement | null = null;
    const refresh = (): void => {
      while (preview.firstChild) preview.removeChild(preview.firstChild);
      const untouched = !from.value.trim() && !to.value.trim();
      const plan = doc.planPortRange(devIndex, from.value, to.value);
      preview.setAttribute('data-state', plan.ok ? 'ok' : untouched ? 'empty' : 'error');
      if (plan.ok) {
        const ports = plan.ports;
        preview.appendChild(this.e('div', { class: 'range-count' }, [`${ports.length} physical interfaces will be created:`]));
        preview.appendChild(this.e('div', { class: 'range-list ro' }, [ports.map((p) => p.name).join(', ')]));
        if (ports.some((p) => p.id !== p.name)) {
          preview.appendChild(this.e('div', { class: 'help' }, [`An interface id cannot contain spaces: the ids are ${ports[0].id} … ${ports[ports.length - 1].id}, and the names as typed become the labels.`]));
        }
      } else {
        preview.appendChild(this.e('div', { class: untouched ? 'muted' : 'field-err' }, [untouched ? 'The last number of each name is the port number; everything before it must be the same.' : plan.error]));
      }
      if (create) {
        create.disabled = !plan.ok;
        create.textContent = plan.ok ? `Create ${plan.ports.length} ports` : 'Create ports';
      }
    };
    const answer = await this.host.dialog({
      title: 'Add a range of physical interfaces',
      body: [
        this.e('div', { class: 'range-form' }, [
          this.e('label', { class: 'dl-label' }, ['From ', from]),
          this.e('label', { class: 'dl-label' }, ['To ', to]),
        ]),
        preview,
        this.e('p', { class: 'muted small' }, ['Only the interfaces are created: no addresses, VLANs or links. You can undo this with Ctrl+Z.']),
      ],
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Create ports', value: 'create', kind: 'primary' },
      ],
      ready: (dialog) => {
        create = dialog.querySelector('[data-value="create"]') as HTMLButtonElement | null;
        for (const input of [from, to]) {
          input.addEventListener('input', refresh);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && create && !create.disabled) {
              e.preventDefault();
              create.click();
            }
          });
        }
        refresh();
      },
    });
    if (answer !== 'create') return;
    // checked again at the moment of creating: all ports, or none
    const done = doc.addPortRange(devIndex, from.value, to.value);
    if (!done.ok) {
      this.host.toast(done.error);
      return;
    }
    this.host.changed(`${done.ports.length} ports added (${done.ports[0].name} … ${done.ports[done.ports.length - 1].name}).`);
  }

  /** Forget everything that belonged to the model that was open: selection, open cards, filter, folded sections, YAML draft. */
  reset(): void {
    this.sel = null;
    this.open.clear();
    this.filter = '';
    this.collapsed = new Set<EntityKind>(['link', 'protocol']);
    this.sourceDraft = null;
    this.sourceError = null;
  }

  /** The kind of an interface entry: physical by its list, else the type written on it (virtual while it has none). */
  private entryKind(e: IfaceEntry): InterfaceKind {
    if (e.kind === 'interface') return 'physical';
    return (LOGICAL_IFACE_TYPES as readonly string[]).indexOf(e.type || '') >= 0 ? (e.type as InterfaceKind) : 'virtual';
  }

  private ifaceCard(devIndex: number, entry: IfaceEntry): HTMLElement {
    const doc = this.doc;
    const p = entry.path;
    const o = entry.kind;
    const kind = this.entryKind(entry);
    const loop = kind === 'loopback';
    const id = entry.id;
    const iss = doc.issuesAt(p);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const addrs = this.listTexts(p.concat('ip'));
    const dhcp = doc.dhcpOn(p);
    const summary = [id || '(no id)', o === 'logical' && !entry.type ? '(no type)' : interfaceKindLabel(kind), doc.text(p.concat('label')), dhcp && !addrs.length ? 'DHCP' : addrs.slice(0, 2).join(', ') + (addrs.length > 2 ? ' …' : '')].filter((x) => !!x).join(' · ');
    const card = this.e('details', { class: 'card' + (errs ? ' has-err' : ''), 'data-card': J(p), 'data-iface': id || '', 'data-kind': kind });
    const selected = !!this.sel && !!this.sel.iface && J(this.sel.iface) === J(p);
    if (this.open.has(J(p)) || selected) card.setAttribute('open', '');
    card.appendChild(
      this.e('summary', {}, [
        this.e('span', { class: 'card-title' }, [summary]),
        iss.length ? this.badge(errs, iss.length - errs) : null,
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-iface', 'data-p': J(p), title: 'Delete this interface' }, ['×']),
      ]),
    );
    card.appendChild(this.ifIdField(p, loop ? 'lo0' : kind === 'tunnel' ? 'tun0' : kind === 'virtual' ? 'Vlan10, bond0' : 'ge-0/0/1'));
    card.appendChild(this.ifTypeField(p, entry));
    card.appendChild(this.textField(p.concat('label'), loop ? 'Name' : 'Label', o, 'text', undefined, loop ? 'Descriptive name, e.g. “Router ID” or “BGP source”.' : undefined));
    card.appendChild(this.addressField(p, loop, o));
    card.appendChild(this.ifaceDerivedField(devIndex, p));
    if (o === 'logical') {
      // Each association belongs to one type. A field of another type is only shown while the file still has it, so it can be removed.
      const has = (k: string): boolean => !!doc.get(p.concat(k));
      // A virtual interface is not assumed to be a bond or a VLAN interface: once it is one of them, only
      // that association is shown; while it is neither, both are offered.
      const vlans = this.cardVlans(devIndex, p);
      if (has('members') || (kind === 'virtual' && !has('vlan') && !vlans.length)) card.appendChild(this.membersPortsField(devIndex, p));
      if (has('vlan') || (kind === 'virtual' && (!has('members') || vlans.length > 0))) {
        card.appendChild(this.intField(p.concat('vlan'), `VLAN ID (${VLAN_MIN}–${VLAN_MAX})`, o, 'Only for a VLAN interface: the VLAN it belongs to. Leave it empty when an address above lies in a network that defines the VLAN; it is then taken from there.'));
        if (vlans.length) card.appendChild(this.vlanPortsField(devIndex, p));
      }
      if (kind === 'tunnel' || has('source')) {
        const others = sortedByName(doc.interfaceEntries(devIndex).filter((e) => !!e.id && e.id !== id), (e) => e.id as string).map((e) => e.id as string);
        card.appendChild(this.textField(p.concat('source'), 'Tunnel source', o, 'text', others, 'Where the tunnel is sourced from: an interface of this device (physical or logical, e.g. a loopback) or an IP address.', 'Interface or address'));
      }
      if (kind === 'tunnel' || has('destination')) {
        card.appendChild(this.textField(p.concat('destination'), 'Tunnel destination', o, 'text', this.deviceIds().filter((x) => x !== doc.text(['devices', devIndex, 'id'])), 'The remote end: an IP address, or a device or device:interface of this model.', 'Address, device or device:interface'));
      }
    }
    card.appendChild(this.textField(p.concat('vrf'), 'VRF', o, 'text', undefined, 'The VRF this interface is assigned to, if any.'));
    if (!loop || doc.get(p.concat('mac'))) card.appendChild(this.textField(p.concat('mac'), 'MAC', o));
    card.appendChild(this.textField(p.concat('description'), 'Description', o, 'textarea'));
    if (id) {
      const dev = doc.text(['devices', devIndex, 'id']);
      const refs = dev ? doc.references('device', dev, id) : [];
      if (refs.length) {
        const names: string[] = [];
        for (const r of refs) {
          // a logical interface (member port, tunnel source or destination) is named as device:interface
          const sk = kindOfSection(String(r[0]));
          const name = r[0] === 'devices' && r[2] === 'dns_names' ? `DNS name ${doc.text(r.slice(0, 4).concat('name')) || '?'}` : r[0] === 'devices' ? `${doc.text([r[0], r[1], 'id']) || '?'}:${doc.text(r.slice(0, 4).concat('id')) || '?'}` : sk ? doc.text([r[0], r[1], 'id']) || sk : '?';
          if (names.indexOf(name) < 0) names.push(name);
        }
        card.appendChild(this.e('div', { class: 'used-by muted small' }, ['Used by: ' + names.join(', ')]));
      }
    }
    card.appendChild(this.attrsField(p.concat('attrs'), 'Attributes (attrs)', o));
    card.appendChild(this.otherProps(p, o));
    return card;
  }

  /**
   * The addresses of an interface, with the DHCP switch next to them. While
   * DHCP is on, manual addresses can't be entered (a file that has both shows
   * them, with the error, so they can be removed). A loopback can't use
   * DHCP, so it has no switch, unless its file says "dhcp: true": then the
   * switch is shown so that it can be turned off.
   */
  private addressField(p: Path, loop: boolean, o: string): HTMLElement {
    const doc = this.doc;
    const on = doc.dhcpOn(p);
    const label = loop ? 'Addresses (IPv4 / IPv6 with prefix)' : 'Addresses';
    const example = loop ? '10.255.0.1/32 or 2001:db8::1/128' : '192.0.2.1/24';
    if (!on && !doc.dhcpAllowed(p)) return this.listField(p.concat('ip'), label, o, example);
    const addrs = this.listTexts(p.concat('ip'));
    const locked = on && !addrs.length;
    const sw = this.e(
      'button',
      {
        type: 'button',
        class: 'mini dhcp-switch' + (on ? ' on' : ''),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'data-act': 'dhcp',
        'data-p': J(p),
        title: on ? 'Turn DHCP off: addresses can then be configured manually' : 'Turn DHCP on: the interface obtains its address by DHCP (its manual addresses are deleted after a confirmation)',
      },
      ['DHCP ', this.e('span', { class: 'dhcp-state' }, [on ? 'on' : 'off'])],
    );
    const help = !on
      ? undefined
      : loop
        ? 'A loopback cannot obtain its address by DHCP. Turn DHCP off and enter its address.'
        : 'Obtained by DHCP. The address is not known to NetAtlas, so this interface is in no network and has no derived VLAN until an address is configured.';
    const f = this.listField(p.concat('ip'), label, o, example, help, locked);
    f.setAttribute('data-dhcp', on ? 'on' : 'off');
    // the switch sits beside the label (see .field[data-dhcp] in the styles)
    f.insertBefore(sw, f.firstChild ? f.firstChild.nextSibling : null);
    for (const is of doc.issuesAt(p.concat('dhcp'))) f.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return f;
  }

  /**
   * The type of an interface. A physical interface has none to choose
   * (read-only text); a logical interface is a loopback, virtual or tunnel.
   */
  private ifTypeField(p: Path, entry: IfaceEntry): HTMLElement {
    if (entry.kind === 'interface') {
      return this.e('div', { class: 'field', 'data-iface-type': 'physical' }, [
        this.e('label', {}, ['Type']),
        this.e('span', { class: 'ro' }, ['Physical']),
        this.e('div', { class: 'help' }, ['A port of the device. Only physical interfaces can be cabled.']),
      ]);
    }
    const tp = p.concat('type');
    const cur = this.doc.text(tp) || '';
    const valid = (LOGICAL_IFACE_TYPES as readonly string[]).indexOf(cur) >= 0;
    const s = this.e('select', { 'data-p': J(tp), 'data-t': 'logical-type', 'data-o': 'logical' }) as HTMLSelectElement;
    if (!cur) {
      s.appendChild(this.e('option', { value: '' }, ['Select type']));
      s.classList.add('unset');
    } else if (!valid) s.appendChild(this.e('option', { value: cur }, [cur + ' (not a valid type)']));
    for (const t of LOGICAL_IFACE_TYPES) s.appendChild(this.e('option', { value: t }, [interfaceKindLabel(t)]));
    s.value = cur;
    return this.field('Type', s, tp, 'Loopback: an address of the device itself. Virtual: any other interface without a port of its own (VLAN interface, bond, subinterface, VTEP …). Tunnel: a tunnel endpoint.');
  }

  /** Member ports of an aggregate (bond, LAG): physical interfaces of this device, picked from a list. */
  private membersPortsField(devIndex: number, p: Path): HTMLElement {
    const doc = this.doc;
    const mp = p.concat('members');
    const n = doc.get(mp);
    const cur = this.listTexts(mp);
    const ports = sortedByName(doc.interfaceEntries(devIndex).filter((e) => e.kind === 'interface' && !!e.id), (e) => e.id as string).map((e) => e.id as string);
    const box = this.e('div', { class: 'list-ed', 'data-members': String(cur.length) });
    if (cur.length) {
      const chips = this.e('div', { class: 'vlan-chips' });
      cur.forEach((id, k) => {
        const ip = n && n.kind === 'seq' ? mp.concat(k) : mp;
        chips.appendChild(
          this.e('span', { class: 'ref-chip' + (ports.indexOf(id) < 0 ? ' invalid' : ''), 'data-member': id }, [id, this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: `Remove member port ${id}` }, ['×'])]),
        );
      });
      box.appendChild(chips);
    }
    const s = this.e('select', { 'data-p': J(mp), 'data-t': 'member-append', 'data-o': 'logical', 'aria-label': 'Add a member port' }) as HTMLSelectElement;
    s.appendChild(this.e('option', { value: '' }, [ports.length ? '+ add a physical interface…' : '(the device has no physical interfaces)']));
    for (const id of ports.filter((x) => cur.indexOf(x) < 0)) s.appendChild(this.e('option', { value: id }, [id]));
    box.appendChild(s);
    return this.field('Member ports', box, mp, 'Only for a bond or aggregate: the physical interfaces of this device that belong to it. Leave empty for any other virtual interface.');
  }

  /** The VLANs of the interface at `p` in the current model (written on it or derived from its addresses); none while it has errors. */
  private cardVlans(devIndex: number, p: Path): number[] {
    const model = this.doc.result.model;
    const dev = this.doc.text(['devices', devIndex, 'id']);
    const id = this.doc.text(p.concat('id'));
    const inf = model && dev && id ? model.index.interfaces.get(ifaceKey(dev, id)) : undefined;
    return model && inf ? interfaceVlans(model, inf) : [];
  }

  /** The ports carrying the VLAN of a VLAN interface: derived from the link ends, never entered. */
  private vlanPortsField(devIndex: number, p: Path): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']);
    const id = doc.text(p.concat('id'));
    const help = 'The physical interfaces of this device whose link permits the VLAN at their end. To change it, edit the VLANs on the link ends.';
    const label = 'Ports carrying VLAN';
    const inf = model && dev && id ? model.index.interfaces.get(ifaceKey(dev, id)) : undefined;
    if (!model || !inf) return this.derivedField(label, 'vlan-ports', [this.e('span', { class: 'muted' }, ['Not available while this interface has errors.'])], help);
    const vlans = interfaceVlans(model, inf);
    const ports = sortedByName(interfaceVlanPorts(model, inf), (x) => x.iface);
    const from = inf.vlan === undefined ? ' (from the network of its address)' : '';
    const rows = ports.map((x) =>
      this.e('li', { 'data-port': x.iface }, [
        this.e('button', { type: 'button', class: 'ref', 'data-goto': `iface:${inf.device}:${x.iface}` }, [x.iface]),
        this.e('span', { class: 'ro small' }, [` VLAN ${x.vlan} on `]),
        this.e('button', { type: 'button', class: 'ref', 'data-goto': 'link:' + x.link }, [x.link]),
      ]),
    );
    const body = rows.length ? [this.e('ul', { class: 'derived-list' }, rows)] : [this.e('span', { class: 'muted' }, [`No link end of this device permits VLAN ${vlans.join(', ')}.`])];
    return this.derivedField(`${label} ${vlans.join(', ')}${from}`, 'vlan-ports', body, help);
  }

  private listTexts(p: Path): string[] {
    const n = this.doc.get(p);
    if (!n) return [];
    if (n.kind === 'scalar') {
      const t = scalarText(n);
      return t ? [t] : [];
    }
    if (n.kind === 'seq') return n.items.map((i) => scalarText(i) || '').filter((x) => x);
    return [];
  }

  // ---------------------------------------------------------------- fields

  private fieldIssues(p: Path): Issue[] {
    return this.doc.issuesAt(p);
  }

  private field(label: string, control: HTMLElement, p: Path | string[], help?: string): HTMLElement {
    const path = p as Path;
    const iss = path.length && typeof path[0] === 'string' && path.length > 1 ? this.fieldIssues(path) : [];
    const f = this.e('div', { class: 'field' + (iss.some((i) => i.severity === 'error') ? ' invalid' : '') }, [
      this.e('label', {}, [label]),
      control,
      help ? this.e('div', { class: 'help' }, [help]) : null,
    ]);
    for (const is of iss) f.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return f;
  }

  private input(p: Path, t: string, value: string, extra: { [k: string]: string } = {}): HTMLInputElement {
    const i = this.e('input', { type: 'text', 'data-p': J(p), 'data-t': t, spellcheck: 'false', autocomplete: 'off', ...extra }) as HTMLInputElement;
    i.value = value;
    i.defaultValue = value;
    return i;
  }

  private datalist(values: string[]): { id: string; node: HTMLElement } {
    const id = 'dl-' + Math.random().toString(36).slice(2, 9);
    const dl = this.e('datalist', { id });
    for (const v of values) dl.appendChild(this.e('option', { value: v }));
    return { id, node: dl };
  }

  private textField(p: Path, label: string, order: string, kind: 'text' | 'textarea' = 'text', suggestions?: string[], help?: string, placeholder?: string): HTMLElement {
    const n = this.doc.get(p);
    const val = n ? (n.kind === 'scalar' ? scalarText(n) || '' : '') : '';
    if (n && n.kind !== 'scalar') return this.field(label, this.generic(p, n, 0), p, 'Not a single value — shown as a structure.');
    let ctl: HTMLElement;
    if (kind === 'textarea') {
      const ta = this.e('textarea', { 'data-p': J(p), 'data-t': 'text', 'data-o': order, rows: String(Math.min(8, Math.max(2, val.split('\n').length))) }) as HTMLTextAreaElement;
      ta.value = val;
      ta.defaultValue = val;
      ctl = ta;
    } else {
      const extra: { [k: string]: string } = { 'data-o': order };
      if (placeholder) extra.placeholder = placeholder;
      let dl: { id: string; node: HTMLElement } | null = null;
      if (suggestions) {
        dl = this.datalist(suggestions);
        extra.list = dl.id;
      }
      const inp = this.input(p, 'text', val, extra);
      ctl = dl ? this.e('span', { class: 'ctl' }, [inp, dl.node]) : inp;
    }
    return this.field(label, ctl, p, help);
  }

  private idField(base: Path, kind: EntityKind): HTMLElement {
    const val = this.doc.text(base.concat('id')) || '';
    return this.field('ID', this.input(base.concat('id'), 'id', val, { 'data-kind': kind, required: '' }), base.concat('id'), 'Stable identifier. Renaming updates every reference to it.');
  }

  private ifIdField(p: Path, example: string): HTMLElement {
    const n = this.doc.get(p) as DocNode;
    const val = n.kind === 'map' ? this.doc.text(p.concat('id')) || '' : scalarText(n) || '';
    return this.field('ID', this.input(p.concat('id'), 'ifid', val), p.concat('id'), `Unique on this device across physical and logical interfaces (e.g. ${example}). Renaming updates references.`);
  }

  private intField(p: Path, label: string, order: string, help?: string): HTMLElement {
    const val = this.doc.text(p) || '';
    return this.field(label, this.input(p, 'int', val, { 'data-o': order, inputmode: 'numeric' }), p, help);
  }

  private boolField(p: Path, label: string, order: string): HTMLElement {
    const n = this.doc.get(p);
    const cb = this.e('input', { type: 'checkbox', 'data-p': J(p), 'data-t': 'bool', 'data-o': order }) as HTMLInputElement;
    cb.checked = !!n && n.kind === 'scalar' && n.value === true;
    const bad = n && !(n.kind === 'scalar' && typeof n.value === 'boolean') && !(n.kind === 'scalar' && n.value === null);
    return this.field(label, this.e('span', { class: 'ctl' }, [cb, bad ? this.e('span', { class: 'field-err' }, [` current value "${this.doc.text(p) || '?'}" is not true/false`]) : null]), p);
  }

  private selectEl(p: Path, t: string, order: string, options: string[], current: string, emptyLabel: string, extra: { [k: string]: string } = {}): HTMLSelectElement {
    const s = this.e('select', { 'data-p': J(p), 'data-t': t, 'data-o': order, ...extra }) as HTMLSelectElement;
    s.appendChild(this.e('option', { value: '' }, [emptyLabel]));
    const opts = options.slice();
    if (current && opts.indexOf(current) < 0) s.appendChild(this.e('option', { value: current }, [current + ' (missing!)']));
    for (const o of opts) s.appendChild(this.e('option', { value: o }, [o]));
    s.value = current;
    if (!current) s.classList.add('unset');
    return s;
  }

  /** Device type: the format's types by display name; a disallowed current value stays visible. */
  private typeField(p: Path, order: string): HTMLElement {
    const n = this.doc.get(p);
    if (n && n.kind !== 'scalar') return this.field('Type', this.generic(p, n, 0), p, 'Not a single value — shown as a structure.');
    const current = this.doc.text(p) || '';
    const s = this.e('select', { 'data-p': J(p), 'data-t': 'text', 'data-o': order }) as HTMLSelectElement;
    s.appendChild(this.e('option', { value: '' }, ['Select device type']));
    if (!current) s.classList.add('unset');
    if (current && !isDeviceType(current)) s.appendChild(this.e('option', { value: current }, [current + ' (not a valid type)']));
    for (const t of DEVICE_TYPES) s.appendChild(this.e('option', { value: t.id }, [t.label]));
    s.value = current;
    return this.field('Type', s, p, 'Chooses the icon and the default row in the physical view.');
  }

  private enumField(p: Path, label: string, order: string, options: string[], emptyLabel: string): HTMLElement {
    return this.field(label, this.selectEl(p, 'text', order, options, this.doc.text(p) || '', emptyLabel), p);
  }

  private refField(p: Path, label: string, order: string, options: string[], help?: string): HTMLElement {
    return this.field(label, this.selectEl(p, 'text', order, options, this.doc.text(p) || '', '(none)'), p, help);
  }

  private colorField(p: Path, label: string, order: string): HTMLElement {
    const val = this.doc.text(p) || '';
    const picker = this.e('input', { type: 'color', 'data-p': J(p), 'data-t': 'text', 'data-o': order, title: 'Pick a colour' }) as HTMLInputElement;
    if (/^#[0-9a-fA-F]{6}$/.test(val)) picker.value = val;
    return this.field(label, this.e('span', { class: 'ctl row' }, [picker, this.input(p, 'text', val, { 'data-o': order, placeholder: '#rrggbb' })]), p);
  }

  /** Editable list of scalars (addresses, prefixes). Also handles a single scalar value. */
  private listField(p: Path, label: string, order: string, placeholder: string, help?: string, disabled = false): HTMLElement {
    const n = this.doc.get(p);
    const box = this.e('div', { class: 'list-ed' + (disabled ? ' disabled' : '') });
    if (disabled) {
      const i = this.input(p, 'list-append', '', { placeholder: 'Obtained by DHCP — no manual address', class: 'append', disabled: '', 'aria-disabled': 'true' });
      box.appendChild(i);
      return this.field(label, box, p, help);
    }
    const row = (ip: Path, val: string, t: string): HTMLElement =>
      this.e('div', { class: 'list-row' + (this.doc.issuesAt(ip).some((i) => i.severity === 'error') ? ' invalid' : '') }, [
        this.input(ip, t, val),
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove' }, ['×']),
      ]);
    if (n && n.kind === 'scalar' && scalarText(n) !== undefined) box.appendChild(row(p, scalarText(n) as string, 'list-scalar'));
    else if (n && n.kind === 'seq') n.items.forEach((it, k) => box.appendChild(row(p.concat(k), scalarText(it) || '', 'list-item')));
    box.appendChild(this.input(p, 'list-append', '', { placeholder: '+ add: ' + placeholder, 'data-o': order, class: 'append' }));
    return this.field(label, box, p, help);
  }

  // ------------------------------------------------- derived (read-only) fields

  /** A computed value: shown, never edited, never written to the file. */
  private derivedField(label: string, name: string, body: Array<Node | string | null>, help: string): HTMLElement {
    return this.e('div', { class: 'field derived', 'data-derived': name }, [
      this.e('label', {}, [label, ' ', this.e('span', { class: 'derived-tag', title: 'Computed from the model; not stored in the YAML file' }, ['derived'])]),
      this.e('div', { class: 'derived-body' }, body),
      this.e('div', { class: 'help' }, [help]),
    ]);
  }

  /** Members of a network: the devices with an address inside its prefixes. */
  private membersField(netIndex: number): HTMLElement {
    const model = this.doc.result.model;
    const id = this.doc.text(['networks', netIndex, 'id']);
    const net = model && id ? model.index.networks.get(id) : undefined;
    const help = 'Devices with an interface or loopback address inside the prefixes above. To add a member, give one of its interfaces an address in the network.';
    if (!model || !net) return this.derivedField('Members', 'members', [this.e('span', { class: 'muted' }, ['Not available while this network has errors.'])], help);
    const members = networkMembers(model, net.id);
    const rows = members.map((m) => {
      const dev = model.index.devices.get(m.device);
      return this.e('li', { 'data-member': m.device }, [
        this.e('button', { type: 'button', class: 'ref', 'data-goto': 'device:' + m.device }, [dev ? dev.label : m.device]),
        this.e('span', { class: 'ro small' }, [' ' + m.matches.map((x) => `${x.iface}${x.loopback ? ' (loopback)' : ''} ${x.address}`).join(', ')]),
      ]);
    });
    const body = rows.length
      ? [this.e('ul', { class: 'derived-list' }, rows)]
      : [this.e('span', { class: 'muted' }, [net.cidr.length ? 'No device has an address in this network.' : 'No prefix yet, so there are no members.'])];
    return this.derivedField(`Members (${members.length})`, 'members', body, help);
  }

  /** Network and VLAN of each address of an interface, from the networks containing it. */
  private ifaceDerivedField(devIndex: number, p: Path): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']);
    const n = doc.get(p) as DocNode;
    const id = n.kind === 'map' ? doc.text(p.concat('id')) : scalarText(n);
    const help = 'From the network whose prefix contains the address and that network’s VLAN. Change the address or the network to change it.';
    const label = 'Network / VLAN';
    const inf = model && dev && id ? model.index.interfaces.get(ifaceKey(dev, id)) : undefined;
    if (!model || !inf) return this.derivedField(label, 'iface-vlan', [this.e('span', { class: 'muted' }, ['Not available while this interface has errors.'])], help);
    const assocs = interfaceAddresses(model, inf.device, inf.id);
    if (!assocs.length && inf.dhcp) return this.derivedField(label, 'iface-vlan', [this.e('span', { class: 'muted' }, ['Address obtained by DHCP and not known here, so no network and no VLAN can be derived.'])], help);
    if (!assocs.length) return this.derivedField(label, 'iface-vlan', [this.e('span', { class: 'muted' }, ['No address, so no network and no VLAN.'])], help);
    const rows = assocs.map((a) => {
      let text: string;
      let cls = '';
      if (!a.valid) text = 'not an IP address — no network';
      else if (!a.networks.length) text = 'no network contains it — no VLAN';
      else {
        const nets = a.networks.map((nid) => model.index.networks.get(nid)).filter((x): x is NonNullable<typeof x> => !!x);
        if (a.vlan.state === 'ambiguous') {
          cls = 'field-warn';
          text = 'VLAN ambiguous: ' + nets.filter((x) => x.vlan !== undefined).map((x) => `VLAN ${x.vlan} (${x.label})`).join(' or ') + ' — none is chosen';
        } else {
          text = nets.map((x) => x.label).join(', ') + ' · ' + (a.vlan.state === 'vlan' ? derivedVlanText(a.vlan) : 'no VLAN defined');
        }
      }
      return this.e('li', { class: cls, 'data-vlan': a.vlan.state === 'vlan' ? String(a.vlan.vlan) : a.vlan.state }, [this.e('span', { class: 'ro' }, [a.address]), ' → ' + text]);
    });
    return this.derivedField(label, 'iface-vlan', [this.e('ul', { class: 'derived-list' }, rows)], help);
  }

  // --------------------------------------------------------- link-end VLANs

  /** VLAN IDs that networks define, with the network labels (for the picker and the chips). */
  private knownVlans(): Map<number, string[]> {
    const out = new Map<number, string[]>();
    const model = this.doc.result.model;
    if (model) {
      for (const n of model.networks) {
        if (n.vlan === undefined) continue;
        out.set(n.vlan, (out.get(n.vlan) || []).concat(n.label));
      }
    }
    return out;
  }

  /**
   * VLANs permitted at one end of a link: any number, chosen per end and
   * stored on that end. The other end is never changed to match.
   */
  private endVlansField(endPath: Path, side: string): HTMLElement {
    const doc = this.doc;
    const cur = doc.endVlans(endPath);
    const known = this.knownVlans();
    const hasEnd = !!this.epParts(endPath).device;
    const valid = cur.map(Number).filter((v) => Number.isInteger(v) && v >= VLAN_MIN && v <= VLAN_MAX);
    const state = cur.length === 0 ? 'none' : cur.length === 1 ? 'single' : 'trunk';
    const box = this.e('div', { class: 'vlan-ed', 'data-vlan-end': side, 'data-vlan-state': state });
    box.appendChild(this.e('div', { class: 'vlan-state' + (state === 'trunk' ? ' trunk' : state === 'none' ? ' muted' : '') }, [cur.length === valid.length ? linkEndVlanText(valid) : `${cur.length} entries`]));
    if (cur.length) {
      const chips = this.e('div', { class: 'vlan-chips' });
      for (const id of cur) {
        const names = known.get(Number(id));
        chips.appendChild(
          this.e('span', { class: 'ref-chip vlan-chip', title: names ? 'VLAN of ' + names.join(', ') : '' }, [
            id,
            this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-vlan', 'data-p': J(endPath), 'data-k': id, title: `Remove VLAN ${id} from end ${side}` }, ['×']),
          ]),
        );
      }
      box.appendChild(chips);
    }
    if (hasEnd) {
      const pick = this.e('select', { 'data-p': J(endPath), 'data-t': 'vlan-pick', 'aria-label': `Add a VLAN to end ${side}` }) as HTMLSelectElement;
      pick.appendChild(this.e('option', { value: '' }, ['+ network VLAN…']));
      Array.from(known.keys())
        .sort((p, q) => p - q)
        .filter((v) => cur.indexOf(String(v)) < 0)
        .forEach((v) => pick.appendChild(this.e('option', { value: String(v) }, [`${v} · ${(known.get(v) as string[]).join(', ')}`])));
      box.appendChild(this.e('div', { class: 'list-row' }, [pick, this.input(endPath, 'vlan-add', '', { placeholder: '+ add IDs: 10, 20, 30-32', class: 'append', inputmode: 'numeric' })]));
    } else {
      box.appendChild(this.e('span', { class: 'muted small' }, ['Choose the device of this end first.']));
    }
    const help =
      state === 'none'
        ? 'No VLAN is configured for this end, and none is assumed.'
        : state === 'single'
          ? 'One VLAN is permitted at this end.'
          : 'Several VLANs are permitted at this end: a trunk.';
    return this.field(`End ${side} VLANs`, box, endPath.concat('vlans'), help + ' Stored on this end only.');
  }

  /** The difference between the two ends' VLANs, shown but never repaired. */
  private vlanMismatchNote(linkIndex: number): HTMLElement {
    const num = (side: string): number[] =>
      this.doc
        .endVlans(['links', linkIndex, side])
        .map(Number)
        .filter((v) => Number.isInteger(v));
    const mm = vlanMismatch(num('a'), num('b'));
    if (!mm) return this.e('div', { class: 'vlan-match', 'data-vlan-mismatch': 'no' });
    return this.e('div', { class: 'vlan-mismatch-note field-warn', 'data-vlan-mismatch': 'yes', role: 'status' }, ['⚠ The two ends permit different VLANs (' + vlanMismatchText(mm) + '). Nothing is changed automatically.']);
  }

  // -------------------------------------------------------------- endpoints

  private deviceIds(): string[] {
    return this.ids('device');
  }

  /**
   * Interface ids of a device id, alphabetically, with a marker for the ones
   * that are not physical. A link end (`physicalOnly`) can only name a
   * physical interface.
   */
  private ifaceOptions(devId: string, physicalOnly: boolean): Array<{ id: string; label: string }> {
    const ent = this.doc.findEntity('device', devId);
    if (!ent) return [];
    const entries = this.doc.interfaceEntries(ent.index).filter((e) => !!e.id && (!physicalOnly || e.kind === 'interface'));
    return sortedByName(entries, (e) => e.id as string).map((e) => {
      const id = e.id as string;
      return { id, label: e.kind === 'interface' ? id : `${id} (${interfaceKindLabel(this.entryKind(e)).toLowerCase()})` };
    });
  }

  private epParts(p: Path): { device: string; iface: string } {
    const t = this.epText(p);
    const c = t.indexOf(':');
    return { device: c < 0 ? t : t.slice(0, c), iface: c < 0 ? '' : t.slice(c + 1) };
  }

  private epControls(p: Path, order: string): HTMLElement {
    const { device, iface } = this.epParts(p);
    const devSel = this.selectEl(p, 'ep-dev', order, this.deviceIds(), device, '(device)');
    const ifSel = this.e('select', { 'data-p': J(p), 'data-t': 'ep-if', 'data-o': order }) as HTMLSelectElement;
    ifSel.appendChild(this.e('option', { value: '' }, ['(whole device)']));
    const opts = this.ifaceOptions(device, order === 'link');
    if (iface && !opts.some((o) => o.id === iface)) ifSel.appendChild(this.e('option', { value: iface }, [iface + ' (missing!)']));
    for (const o of opts) ifSel.appendChild(this.e('option', { value: o.id }, [o.label]));
    ifSel.value = iface;
    return this.e('span', { class: 'ctl row' }, [devSel, ifSel]);
  }

  private endpointField(p: Path, label: string, order: string, _ext: boolean): HTMLElement {
    return this.field(label, this.epControls(p, order), p, undefined);
  }

  private endpointList(p: Path, label: string, order: string): HTMLElement {
    const doc = this.doc;
    const n = doc.get(p);
    const box = this.e('div', { class: 'ep-list' });
    const items = n && n.kind === 'seq' ? n.items : [];
    items.forEach((it, k) => {
      const ip = p.concat(k);
      const iss = doc.issuesAt(ip);
      const rowEl = this.e('div', { class: 'ep-row' + (iss.some((i) => i.severity === 'error') ? ' invalid' : '') }, [
        this.e('div', { class: 'ep-main' }, [
          this.epControls(ip, 'endpoint'),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'move-up', 'data-p': J(ip), title: 'Move up' }, ['↑']),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove endpoint' }, ['×']),
        ]),
      ]);
      const more = this.e('details', { class: 'ep-more', 'data-card': J(ip) });
      if (this.open.has(J(ip))) more.setAttribute('open', '');
      const role = it.kind === 'map' ? doc.text(ip.concat('role')) : undefined;
      const addr = it.kind === 'map' ? doc.text(ip.concat('address')) : undefined;
      more.appendChild(this.e('summary', {}, [[role ? 'role ' + role : '', addr || ''].filter((x) => x).join(' · ') || 'role, address, attrs…']));
      more.appendChild(this.field('Role', this.input(ip.concat('role'), 'ep-attr', role || '', { 'data-o': 'endpoint' }), ip.concat('role')));
      more.appendChild(this.field('Address', this.input(ip.concat('address'), 'ep-attr', addr || '', { 'data-o': 'endpoint' }), ip.concat('address')));
      more.appendChild(this.attrsField(ip.concat('attrs'), 'Endpoint attributes', 'endpoint'));
      if (it.kind === 'map') more.appendChild(this.otherProps(ip, 'endpoint'));
      rowEl.appendChild(more);
      for (const is of iss) rowEl.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      box.appendChild(rowEl);
    });
    if (n && n.kind !== 'seq' && !(n.kind === 'scalar' && n.value === null)) box.appendChild(this.e('div', { class: 'field-err' }, ['Not a list; fix it in the YAML tab.']));
    box.appendChild(this.selectEl(p, 'ep-append', order, this.deviceIds(), '', '+ add endpoint (device)…'));
    return this.field(label, box, p.length ? [] : p);
  }

  private overField(p: Path, label: string, order: string, selfIndex: number): HTMLElement {
    const doc = this.doc;
    const self = doc.text(['relations', selfIndex, 'id']);
    const cur = this.listTexts(p);
    const box = this.e('div', { class: 'list-ed' });
    const n = doc.get(p);
    const kinds = new Map<string, string>();
    for (const k of ['link', 'relation', 'network'] as EntityKind[]) for (const id of this.ids(k)) kinds.set(id, k);
    cur.forEach((id, k) => {
      const ip = n && n.kind === 'seq' ? p.concat(k) : p;
      box.appendChild(
        this.e('div', { class: 'list-row' + (kinds.has(id) ? '' : ' invalid') }, [
          this.e('span', { class: 'ref-chip' }, [`${kinds.get(id) || 'missing'}: ${id}`]),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove' }, ['×']),
        ]),
      );
    });
    const opts = Array.from(kinds.keys()).filter((id) => id !== self && cur.indexOf(id) < 0);
    const s = this.e('select', { 'data-p': J(p), 'data-t': 'over-append', 'data-o': order }) as HTMLSelectElement;
    s.appendChild(this.e('option', { value: '' }, ['+ add link / relation / network…']));
    for (const id of opts) s.appendChild(this.e('option', { value: id }, [`${kinds.get(id)}: ${id}`]));
    box.appendChild(s);
    return this.field(label, box, p, 'What this relation rides on: cables, networks, or another relation (e.g. GRE over IPsec).');
  }

  // --------------------------------------------------- generic / attributes

  private attrsField(p: Path, label: string, order: string): HTMLElement {
    const n = this.doc.get(p);
    const key = J(p);
    const det = this.e('details', { class: 'attrs', 'data-card': key });
    const count = n && n.kind === 'map' ? n.entries.size : 0;
    if (this.open.has(key) || this.doc.issuesAt(p).length) det.setAttribute('open', '');
    det.appendChild(this.e('summary', {}, [`${label}${count ? ' (' + count + ')' : ''}`]));
    if (n && n.kind !== 'map') {
      det.appendChild(this.e('div', { class: 'field-err' }, ['"attrs" must be a mapping of key: value pairs.']));
      det.appendChild(this.generic(p, n, 0));
    } else det.appendChild(this.genericMap(p, n && n.kind === 'map' ? n : null, 0, order));
    for (const is of this.doc.issuesAt(p, true)) det.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return det;
  }

  /** Keys of the entity that the format does not define: shown and editable, never dropped. */
  private otherProps(base: Path, kind: string, shownElsewhere: string[] = []): HTMLElement {
    const n = base.length ? this.doc.get(base) : this.doc.root;
    const known = (KNOWN[kind] || []).concat(shownElsewhere);
    const box = this.e('div', { class: 'other' });
    if (!n || n.kind !== 'map') return box;
    const extra = Array.from(n.entries.keys()).filter((k) => known.indexOf(k) < 0);
    if (!extra.length) return box;
    box.appendChild(this.e('h4', {}, ['Other properties (not part of the format)']));
    box.appendChild(this.e('p', { class: 'muted small' }, ['Kept exactly as they are and exported unchanged, but reported as errors. Move them into attrs, rename or delete them.']));
    for (const k of extra) {
      const vp = base.concat(k);
      box.appendChild(
        this.e('div', { class: 'g-row' }, [
          this.input(base, 'g-key', k, { 'data-k': k, class: 'g-key' }),
          this.generic(vp, (n.entries.get(k) as { value: DocNode }).value, 1),
          kind !== 'document' ? this.e('button', { type: 'button', class: 'mini', 'data-act': 'to-attrs', 'data-p': J(base), 'data-k': k, title: 'Move into attrs' }, ['→ attrs']) : null,
          this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(vp), title: 'Delete property' }, ['×']),
        ]),
      );
      for (const is of this.doc.issuesAt(vp)) box.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    }
    return box;
  }

  /** Recursive editor for any value. */
  generic(p: Path, n: DocNode, depth: number): HTMLElement {
    if (n.kind === 'map') return this.genericMap(p, n, depth, undefined);
    if (n.kind === 'seq') {
      const box = this.e('div', { class: 'g-seq' });
      if (depth > 8) {
        box.appendChild(this.e('span', { class: 'muted small' }, ['(deeply nested — edit in the YAML tab)']));
        return box;
      }
      n.items.forEach((it, k) =>
        box.appendChild(
          this.e('div', { class: 'g-row' }, [
            this.e('span', { class: 'g-idx' }, ['–']),
            this.generic(p.concat(k), it, depth + 1),
            this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(p.concat(k)), title: 'Remove item' }, ['×']),
          ]),
        ),
      );
      box.appendChild(
        this.e('div', { class: 'g-add' }, [
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'g-push', 'data-p': J(p), 'data-kind': 'scalar' }, ['+ value']),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'g-push', 'data-p': J(p), 'data-kind': 'map' }, ['+ group']),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'g-push', 'data-p': J(p), 'data-kind': 'seq' }, ['+ list']),
        ]),
      );
      return box;
    }
    const val = scalarText(n);
    const typeTag = n.value === null ? 'null' : typeof n.value === 'string' ? '' : typeof n.value;
    return this.e('span', { class: 'ctl g-val' }, [
      this.input(p, 'auto', val === undefined ? '' : val, { placeholder: n.value === null ? '(empty)' : '' }),
      typeTag ? this.e('span', { class: 'g-type', title: 'YAML type of this value' }, [typeTag]) : null,
    ]);
  }

  private genericMap(p: Path, n: DocMap | null, depth: number, order: string | undefined): HTMLElement {
    const box = this.e('div', { class: 'g-map' });
    if (n && depth > 8) {
      box.appendChild(this.e('span', { class: 'muted small' }, ['(deeply nested — edit in the YAML tab)']));
      return box;
    }
    if (n) {
      n.entries.forEach((e, k) => {
        box.appendChild(
          this.e('div', { class: 'g-row' }, [
            this.input(p, 'g-key', k, { 'data-k': k, class: 'g-key' }),
            this.generic(p.concat(k), e.value, depth + 1),
            this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(p.concat(k)), title: 'Remove' }, ['×']),
          ]),
        );
      });
    }
    const typeSel = this.e('select', { class: 'g-newtype', title: 'Type of the new entry' }) as HTMLSelectElement;
    for (const [v, l] of [['scalar', 'value'], ['map', 'group'], ['seq', 'list']]) typeSel.appendChild(this.e('option', { value: v }, [l]));
    box.appendChild(
      this.e('div', { class: 'g-add' }, [
        this.input(p, 'g-newkey', '', { placeholder: '+ new key', class: 'g-key', 'data-o': order || '' }),
        typeSel,
      ]),
    );
    return box;
  }

  // ------------------------------------------------------------- events

  /** Delegated "change" handling for inspector and outline inputs. Returns true if handled. */
  onChange(target: HTMLElement): boolean {
    const t = target.getAttribute('data-t');
    if (!t) return false;
    if (t === 'outline-filter') {
      this.filter = (target as HTMLInputElement).value;
      this.host.changed('filter');
      return true;
    }
    const doc = this.getDoc();
    if (!doc) return true;
    const p = P(target.getAttribute('data-p'));
    const val = (target as HTMLInputElement).value;
    const trimmed = typeof val === 'string' ? val.trim() : '';
    let note: string | undefined;
    switch (t) {
      case 'text':
        doc.setText(p, target.tagName === 'TEXTAREA' ? val.replace(/\s+$/, '') : trimmed);
        break;
      case 'int':
        doc.setInteger(p, trimmed);
        break;
      case 'bool':
        doc.setFlag(p, (target as HTMLInputElement).checked);
        break;
      case 'auto':
        doc.setValue(p, trimmed);
        break;
      case 'id': {
        const kind = target.getAttribute('data-kind') as EntityKind;
        if (trimmed === '') {
          this.host.toast('The ID cannot be empty.');
          break;
        }
        const n = doc.renameEntity(kind, p[1] as number, trimmed);
        note = n ? `Renamed; ${n} reference${n > 1 ? 's' : ''} updated.` : undefined;
        break;
      }
      case 'ifid': {
        if (trimmed === '') {
          this.host.toast('The interface ID cannot be empty.');
          break;
        }
        const n = doc.renameInterface(p.slice(0, -1), trimmed);
        note = n ? `Renamed; ${n} reference${n > 1 ? 's' : ''} updated.` : undefined;
        break;
      }
      case 'logical-type':
        if (!val) return true;
        doc.setText(p, val);
        break;
      case 'member-append':
        if (!val) return true;
        doc.appendText(p, val, 'Add member port');
        break;
      case 'dns-iface-append':
        if (!val) return true;
        doc.appendText(p, val, 'Associate interface with DNS name');
        break;
      case 'list-item':
      case 'list-scalar':
        doc.setText(p, trimmed);
        break;
      case 'list-append':
        if (trimmed === '') return true;
        doc.appendText(p, trimmed);
        break;
      case 'vlan-pick':
        if (!val) return true;
        doc.addEndVlans(p, [Number(val)]);
        break;
      case 'vlan-add': {
        if (trimmed === '') return true;
        const ids = parseVlanList(trimmed);
        if (!ids) {
          this.host.toast(`VLAN IDs are whole numbers from ${VLAN_MIN} to ${VLAN_MAX}, e.g. “10, 20, 30-32”.`);
          this.host.changed();
          return true;
        }
        doc.addEndVlans(p, ids);
        break;
      }
      case 'over-append':
        if (!val) return true;
        doc.appendText(p, val, 'Add underlay');
        break;
      case 'ep-append':
        if (!val) return true;
        doc.appendText(p, val, 'Add endpoint');
        break;
      case 'ep-dev':
      case 'ep-if': {
        const cur = this.epParts(p);
        doc.setEndpoint(p, t === 'ep-dev' ? val : cur.device, t === 'ep-dev' ? '' : val);
        break;
      }
      case 'ep-attr':
        doc.setEndpointField(p, trimmed);
        break;
      case 'g-key': {
        const oldKey = target.getAttribute('data-k') as string;
        if (trimmed === oldKey) return true;
        const r = doc.renameField(p, oldKey, trimmed);
        if (r !== 'ok') {
          this.host.toast(r === 'exists' ? `Key "${trimmed}" already exists here.` : 'A key cannot be empty.');
          this.host.changed();
          return true;
        }
        break;
      }
      case 'g-newkey': {
        if (!trimmed) return true;
        const typeSel = target.parentElement ? (target.parentElement.querySelector('.g-newtype') as HTMLSelectElement | null) : null;
        const ty = typeSel ? typeSel.value : 'scalar';
        const r = doc.addField(p, trimmed, ty === 'map' ? 'group' : ty === 'seq' ? 'list' : 'value');
        if (r === 'exists') {
          this.host.toast(`Key "${trimmed}" already exists here.`);
          return true;
        }
        this.open.add(J(p));
        break;
      }
      default:
        return false;
    }
    this.host.changed(note);
    return true;
  }

  /** Delegated click handling. Returns true if handled. */
  async onClick(target: HTMLElement): Promise<boolean> {
    const btn = target.closest('[data-act]') as HTMLElement | null;
    if (!btn) return false;
    const act = btn.getAttribute('data-act') as string;
    const doc = this.getDoc();
    if (!doc) return true;
    const kind = btn.getAttribute('data-kind') as EntityKind;
    const index = Number(btn.getAttribute('data-index'));
    const p = P(btn.getAttribute('data-p'));
    switch (act) {
      case 'select':
        this.selectEntity(kind, index);
        this.host.changed('select');
        return true;
      case 'fold':
        // fold or unfold one section of the outline (a view state: nothing in the model changes)
        if (this.collapsed.has(kind)) this.collapsed.delete(kind);
        else this.collapsed.add(kind);
        this.host.changed('filter');
        return true;
      case 'fold-all':
        this.collapsed = new Set(kind === ('close' as string) ? ENTITY_KINDS : []);
        this.host.changed('filter');
        return true;
      case 'add-entity': {
        this.collapsed.delete(kind);
        const i = doc.addEntity(kind);
        this.selectEntity(kind, i);
        this.host.changed(`Added ${kind} “${doc.entities(kind)[i].id}”. Fill in the highlighted fields.`);
        return true;
      }
      case 'dup-entity': {
        const i = doc.duplicateEntity(kind, index);
        if (i >= 0) this.selectEntity(kind, i);
        this.host.changed('Duplicated.');
        return true;
      }
      case 'del-entity': {
        const ent = doc.entities(kind)[index];
        const refs = ent && ent.id ? doc.references(kind, ent.id) : [];
        const answer = await this.host.dialog({
          title: `Delete ${kind} “${ent && ent.id ? ent.id : '(no id)'}”?`,
          body: [
            refs.length
              ? `${refs.length} reference${refs.length > 1 ? 's' : ''} to it will become invalid and will be listed as errors so you can fix or remove them.`
              : 'Nothing refers to it.',
            ' You can undo this with Ctrl+Z.',
          ],
          buttons: [
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete', value: 'delete', kind: 'danger' },
          ],
        });
        if (answer !== 'delete') return true;
        doc.deleteEntity(kind, index);
        this.sel = null;
        this.host.selected(null);
        this.host.changed('Deleted.');
        return true;
      }
      case 'add-iface': {
        const k = doc.addInterface(index);
        this.open.add(J(['devices', index, 'interfaces', k]));
        this.host.changed('Physical interface added.');
        return true;
      }
      case 'add-range':
        await this.addPortRange(index);
        return true;
      case 'add-logical': {
        const type = (btn.getAttribute('data-kind') || 'virtual') as 'loopback' | 'virtual' | 'tunnel';
        const k = type === 'loopback' ? doc.addLoopback(index, []) : doc.addLogical(index, type);
        this.open.add(J(['devices', index, 'logical_interfaces', k]));
        this.host.changed(type === 'loopback' ? 'Loopback added — enter its addresses.' : type === 'tunnel' ? 'Tunnel interface added — set its source and destination.' : 'Virtual interface added.');
        return true;
      }
      case 'del-iface': {
        const dev = doc.text(['devices', p[1], 'id']);
        const ifid = doc.text(p.concat('id')) || scalarText(doc.get(p) as DocNode);
        // DNS-name associations go with the interface; every other reference becomes an error to fix
        const refs = (dev && ifid ? doc.references('device', dev, ifid) : []).filter((r) => r[2] !== 'dns_names');
        const dns = ifid ? doc.dnsAffected(p[1] as number, ifid) : [];
        if (refs.length || dns.length) {
          const body: string[] = [];
          if (refs.length) body.push(`${refs.length} reference${refs.length > 1 ? 's' : ''} to ${dev}:${ifid} (links, relations, member lists, tunnel sources or destinations) will become invalid and will be listed as errors. `);
          if (dns.length) {
            const gone = dns.filter((x) => x.removed).map((x) => x.name);
            body.push(
              `Its association with the DNS name${dns.length > 1 ? 's' : ''} ${dns.map((x) => x.name).join(', ')} is removed` +
                (gone.length ? `; ${gone.join(', ')} ${gone.length > 1 ? 'have' : 'has'} no other interface and ${gone.length > 1 ? 'are' : 'is'} deleted too. ` : '. '),
            );
          }
          body.push('You can undo this with Ctrl+Z.');
          const a = await this.host.dialog({
            title: `Delete interface “${ifid}”?`,
            body,
            buttons: [
              { label: 'Cancel', value: 'cancel' },
              { label: 'Delete', value: 'delete', kind: 'danger' },
            ],
          });
          if (a !== 'delete') return true;
        }
        doc.deleteInterface(p);
        this.host.changed('Interface deleted.');
        return true;
      }
      case 'dhcp':
        await this.toggleDhcp(p);
        return true;
      case 'add-dns':
        await this.addDnsName(index);
        return true;
      case 'del-dns':
        doc.removeDnsName(index, Number(btn.getAttribute('data-k')));
        this.host.changed('DNS name deleted.');
        return true;
      case 'del-item':
        doc.remove(p);
        this.host.changed();
        return true;
      case 'del-vlan':
        doc.removeEndVlan(p, btn.getAttribute('data-k') as string);
        this.host.changed();
        return true;
      case 'move-up': {
        doc.moveUp(p);
        this.host.changed();
        return true;
      }
      case 'to-attrs': {
        const k = btn.getAttribute('data-k') as string;
        const r = doc.moveIntoAttrs(p, k);
        if (r === 'exists') {
          this.host.toast(`attrs already has a key "${k}".`);
          return true;
        }
        if (r === 'missing') return true;
        this.open.add(J(p.concat('attrs')));
        this.host.changed(`Moved “${k}” into attrs.`);
        return true;
      }
      case 'g-push': {
        const what = btn.getAttribute('data-kind');
        doc.pushItem(p, what === 'map' ? 'group' : what === 'seq' ? 'list' : 'value');
        this.host.changed();
        return true;
      }
    }
    return false;
  }

  onToggle(target: HTMLElement): void {
    const key = target.getAttribute('data-card');
    if (!key) return;
    if ((target as HTMLDetailsElement).open) this.open.add(key);
    else this.open.delete(key);
  }
}

/**
 * Editor UI: model outline + property inspector.
 *
 * All edits go through ModelDoc (undoable, validated). Inputs commit on
 * "change" (Enter / leaving the field), so nothing typed is lost when the
 * user clicks the diagram or another object: the browser fires "change"
 * before focus moves. Everything user-provided is rendered as text.
 */
import { DocMap, DocNode, EntityKind, KEY_ORDER, ModelDoc, Path, SECTION, kindOfSection } from '../editor/document';
import { DialogOpts } from './dialogs';
import { el } from './dom';
import { CATEGORIES, LINE_STYLES, LOGICAL_IFACE_TYPES } from '../model/types';
import { builtinProtocols } from '../model/protocols';
import { Issue, scalarText } from '../validation/validate';

export type EditorSel = { kind: EntityKind | 'document'; index: number; iface?: number } | null;

export interface EditorHost {
  /** called after every committed edit */
  changed(note?: string): void;
  /** the editor selected an entity: sync the diagram */
  selected(sel: EditorSel): void;
  dialog(opts: DialogOpts): Promise<string>;
  toast(msg: string): void;
}

const J = (p: Path): string => JSON.stringify(p);
const P = (s: string | null): Path => (s ? (JSON.parse(s) as Path) : []);

const DEVICE_TYPES = ['router', 'switch', 'l3switch', 'firewall', 'server', 'hypervisor', 'cloud', 'ap', 'storage', 'loadbalancer', 'host', 'leaf', 'spine', 'vm', 'internet'];
const IFACE_TYPES = ['physical'].concat(LOGICAL_IFACE_TYPES);
const MEDIA = ['fiber', 'copper', 'dac', 'aoc', 'wireless', 'lte', '5g', 'microwave', 'serial', 'virtual'];
const NET_KINDS = ['subnet', 'vlan', 'vni', 'vrf', 'zone', 'segment'];
const GROUP_KINDS = ['site', 'building', 'room', 'row', 'rack', 'provider', 'cloud', 'zone', 'region'];

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

export class Editor {
  sel: EditorSel = null;
  /** open interface cards / collapsible sections, by path */
  private open = new Set<string>();
  private filter = '';
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
      const ifIdx = this.doc.interfaceIds(dev.index).indexOf(id.slice(c + 1));
      this.sel = { kind: 'device', index: dev.index, iface: ifIdx >= 0 ? ifIdx : undefined };
      if (ifIdx >= 0) this.open.add(J(['devices', dev.index, 'interfaces', ifIdx]));
      return;
    }
    const k = (kind === 'hub' ? 'relation' : kind) as EntityKind;
    if (!SECTION[k]) return;
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
      const ifs = this.doc.interfaceIds(s.index);
      if (ifs[s.iface]) return `iface:${ent.id}:${ifs[s.iface]}`;
    }
    return s.kind === 'protocol' ? null : s.kind + ':' + ent.id;
  }

  private selectEntity(kind: EntityKind | 'document', index: number): void {
    this.sel = { kind, index };
    this.host.selected(this.sel);
  }

  // -------------------------------------------------------------- outline

  renderOutline(box: HTMLElement): void {
    while (box.firstChild) box.removeChild(box.firstChild);
    const doc = this.getDoc();
    if (!doc) {
      box.appendChild(this.e('p', { class: 'muted small' }, ['No model open. Use New or Open YAML.']));
      return;
    }
    const f = this.e('input', { type: 'search', class: 'outline-filter', placeholder: 'Filter…', 'data-t': 'outline-filter', value: this.filter, 'aria-label': 'Filter the model outline' });
    (f as HTMLInputElement).value = this.filter;
    box.appendChild(f);
    const counts = this.issueCounts();
    const docIss = counts.get('document') || { e: 0, w: 0 };
    box.appendChild(
      this.e('button', { type: 'button', class: 'ol-item ol-doc' + (this.sel && this.sel.kind === 'document' ? ' active' : ''), 'data-act': 'select', 'data-kind': 'document', 'data-index': '0' }, [
        this.e('span', { class: 'ol-label' }, ['Document: ' + (doc.text(['title']) || 'Untitled')]),
        this.badge(docIss.e, docIss.w),
      ]),
    );
    const q = this.filter.toLowerCase();
    for (const kind of ['device', 'link', 'network', 'relation', 'group', 'protocol'] as EntityKind[]) {
      const ents = doc.entities(kind);
      const sec = this.e('section', { class: 'ol-section' });
      sec.appendChild(
        this.e('div', { class: 'ol-head' }, [
          this.e('span', {}, [`${KIND_TITLE[kind]} (${ents.length})`]),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-entity', 'data-kind': kind, title: 'Add ' + kind }, ['+ Add']),
        ]),
      );
      for (const ent of ents) {
        const label = this.entityLabel(kind, ent.index);
        if (q && (label + ' ' + (ent.id || '')).toLowerCase().indexOf(q) < 0) continue;
        const c = counts.get(kind + '#' + ent.index) || { e: 0, w: 0 };
        const active = this.sel && this.sel.kind === kind && this.sel.index === ent.index;
        sec.appendChild(
          this.e('button', { type: 'button', class: 'ol-item' + (active ? ' active' : ''), 'data-act': 'select', 'data-kind': kind, 'data-index': String(ent.index), title: ent.id || '(no id)' }, [
            this.e('span', { class: 'ol-label' }, [label]),
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
      wrap.appendChild(this.e('button', { type: 'button', 'data-act': 'select', 'data-kind': 'document', 'data-index': '0' }, ['Edit document settings']));
      return;
    }
    if (s.kind === 'document') this.renderDocument(wrap);
    else this.renderEntity(wrap, s.kind, s.index);
  }

  private renderDocument(w: HTMLElement): void {
    w.appendChild(this.header('document', 'Document', null));
    w.appendChild(this.issueBox([]));
    w.appendChild(this.field('Format version', this.e('span', { class: 'ro' }, [this.doc.text(['netatlas']) || '(missing)']), ['netatlas'], 'Always 1 for this version of netatlas.'));
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
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.textField(base.concat('type'), 'Type', o, 'text', DEVICE_TYPES, 'Chooses the icon and the default row in the physical view.'));
      add(this.refField(base.concat('group'), 'Group / location', o, this.ids('group')));
      add(this.textField(base.concat('vendor'), 'Vendor', o));
      add(this.textField(base.concat('model'), 'Model', o));
      add(this.textField(base.concat('role'), 'Role', o));
      add(this.textField(base.concat('mgmt'), 'Management address', o));
      const loops = this.loopbackIds(index);
      add(this.refField(base.concat('router_id'), 'Router ID (loopback)', o, loops, 'The loopback whose IPv4 address is this device’s router ID.'));
      add(this.intField(base.concat('tier'), 'Tier (0–9)', o, 'Row in the physical view; 0 = top. Leave empty for automatic.'));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
      this.renderInterfaces(w, index);
    } else if (kind === 'link') {
      add(this.endpointField(base.concat('a'), 'End A', o, false));
      add(this.endpointField(base.concat('b'), 'End B', o, false));
      add(this.textField(base.concat('medium'), 'Medium', o, 'text', MEDIA));
      add(this.textField(base.concat('speed'), 'Speed', o, 'text', ['100M', '1G', '10G', '25G', '40G', '100G', '400G']));
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.textField(base.concat('cable'), 'Cable / circuit id', o));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'network') {
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.textField(base.concat('kind'), 'Kind', o, 'text', NET_KINDS));
      add(this.listField(base.concat('cidr'), 'Prefixes (CIDR)', o, '192.0.2.0/24 or 2001:db8::/64'));
      add(this.textField(base.concat('vlan'), 'VLAN', o));
      add(this.textField(base.concat('vrf'), 'VRF', o));
      add(this.endpointList(base.concat('members'), 'Members', o));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'relation') {
      const protos = Array.from(builtinProtocols().keys()).concat(this.ids('protocol'));
      add(this.textField(base.concat('protocol'), 'Protocol', o, 'text', protos, 'Any name. Built-in protocols get a default category and colour; define new ones under Protocols.'));
      add(this.enumField(base.concat('category'), 'Category', o, CATEGORIES as unknown as string[], '(from protocol)'));
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.endpointList(base.concat('endpoints'), 'Endpoints', o));
      add(this.overField(base.concat('over'), 'Carried over (underlay)', o, index));
      add(this.refField(base.concat('network'), 'Network', o, this.ids('network')));
      add(this.boolField(base.concat('directed'), 'Directed (first → last endpoint)', o));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'group') {
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.textField(base.concat('kind'), 'Kind', o, 'text', GROUP_KINDS));
      const self = doc.text(base.concat('id'));
      add(this.refField(base.concat('parent'), 'Parent group', o, this.ids('group').filter((g) => g !== self)));
      add(this.textField(base.concat('description'), 'Description', o, 'textarea'));
    } else if (kind === 'protocol') {
      add(this.textField(base.concat('label'), 'Label', o));
      add(this.enumField(base.concat('category'), 'Category', o, CATEGORIES as unknown as string[], '(other)'));
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

  private loopbackIds(devIndex: number): string[] {
    const l = this.doc.get(['devices', devIndex, 'interfaces']);
    if (!l || l.kind !== 'seq') return [];
    const out: string[] = [];
    l.items.forEach((it, k) => {
      if (it.kind === 'map' && this.doc.text(['devices', devIndex, 'interfaces', k, 'type']) === 'loopback') {
        const id = this.doc.text(['devices', devIndex, 'interfaces', k, 'id']);
        if (id) out.push(id);
      }
    });
    return out;
  }

  // ------------------------------------------------------- interface cards

  private renderInterfaces(w: HTMLElement, devIndex: number): void {
    const doc = this.doc;
    const lp: Path = ['devices', devIndex, 'interfaces'];
    const list = doc.get(lp);
    const items = list && list.kind === 'seq' ? list.items : [];
    const isLoop = (k: number): boolean => items[k].kind === 'map' && doc.text(lp.concat(k, 'type')) === 'loopback';
    const loopIdx = items.map((_, k) => k).filter(isLoop);
    const otherIdx = items.map((_, k) => k).filter((k) => !isLoop(k));

    const ls = this.e('section', { class: 'sub' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`Loopbacks (${loopIdx.length})`]),
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-loop', 'data-index': String(devIndex) }, ['+ Loopback']),
      ]),
      loopIdx.length ? null : this.e('p', { class: 'muted small' }, ['Logical interfaces with one or more IPv4/IPv6 addresses. Not cabled; usable as router ID or as a relation endpoint.']),
    ]);
    for (const k of loopIdx) ls.appendChild(this.ifaceCard(devIndex, k, true));
    w.appendChild(ls);

    const is = this.e('section', { class: 'sub' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`Interfaces (${otherIdx.length})`]),
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-iface', 'data-index': String(devIndex) }, ['+ Interface']),
      ]),
    ]);
    for (const k of otherIdx) is.appendChild(this.ifaceCard(devIndex, k, false));
    if (list && list.kind !== 'seq') is.appendChild(this.e('p', { class: 'field-err' }, ['"interfaces" is not a list; fix it in the YAML tab.']));
    w.appendChild(is);
  }

  private ifaceCard(devIndex: number, k: number, loop: boolean): HTMLElement {
    const doc = this.doc;
    const p: Path = ['devices', devIndex, 'interfaces', k];
    const n = doc.get(p) as DocNode;
    const id = n.kind === 'map' ? doc.text(p.concat('id')) : scalarText(n);
    const iss = doc.issuesAt(p);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const addrs = this.listTexts(p.concat('ip'));
    const summary = [id || '(no id)', loop ? doc.text(p.concat('label')) : doc.text(p.concat('type')) || '', addrs.slice(0, 2).join(', ') + (addrs.length > 2 ? ' …' : '')]
      .filter((x) => !!x)
      .join(' · ');
    const card = this.e('details', { class: 'card' + (errs ? ' has-err' : ''), 'data-card': J(p) });
    if (this.open.has(J(p)) || (this.sel && this.sel.iface === k)) card.setAttribute('open', '');
    card.appendChild(
      this.e('summary', {}, [
        this.e('span', { class: 'card-title' }, [summary]),
        iss.length ? this.badge(errs, iss.length - errs) : null,
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-iface', 'data-p': J(p), title: 'Delete this ' + (loop ? 'loopback' : 'interface') }, ['×']),
      ]),
    );
    const o = 'interface';
    card.appendChild(this.ifIdField(p, devIndex, k));
    card.appendChild(this.textField(p.concat('label'), loop ? 'Name' : 'Label', o, 'text', undefined, loop ? 'Descriptive name, e.g. “Router ID” or “BGP source”.' : undefined));
    card.appendChild(this.listField(p.concat('ip'), loop ? 'Addresses (IPv4 / IPv6 with prefix)' : 'Addresses', o, loop ? '10.255.0.1/32 or 2001:db8::1/128' : '192.0.2.1/24'));
    card.appendChild(this.textField(p.concat('type'), 'Type', o, 'text', IFACE_TYPES, loop ? undefined : 'Logical types (loopback, tunnel, svi, lag …) cannot be cabled.'));
    if (!loop || doc.get(p.concat('speed')) || doc.get(p.concat('media'))) {
      card.appendChild(this.textField(p.concat('speed'), 'Speed', o, 'text', ['1G', '10G', '25G', '100G']));
      card.appendChild(this.textField(p.concat('media'), 'Media', o, 'text', MEDIA));
    }
    card.appendChild(this.textField(p.concat('vlan'), 'VLAN', o));
    if (!loop || doc.get(p.concat('mac'))) card.appendChild(this.textField(p.concat('mac'), 'MAC', o));
    card.appendChild(this.textField(p.concat('description'), 'Description', o, 'textarea'));
    if (id) {
      const dev = doc.text(['devices', devIndex, 'id']);
      const refs = dev ? doc.references('device', dev, id).filter((r) => r[r.length - 1] !== 'router_id') : [];
      if (refs.length) {
        card.appendChild(
          this.e('div', { class: 'used-by muted small' }, [
            'Used by: ' +
              refs
                .map((r) => {
                  const kind = kindOfSection(String(r[0]));
                  return kind ? doc.text([r[0], r[1], 'id']) || kind : '?';
                })
                .join(', '),
          ]),
        );
      }
    }
    card.appendChild(this.attrsField(p.concat('attrs'), 'Attributes (attrs)', o));
    card.appendChild(this.otherProps(p, 'interface'));
    return card;
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

  private textField(p: Path, label: string, order: string, kind: 'text' | 'textarea' = 'text', suggestions?: string[], help?: string): HTMLElement {
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

  private ifIdField(p: Path, devIndex: number, k: number): HTMLElement {
    const n = this.doc.get(p) as DocNode;
    const val = n.kind === 'map' ? this.doc.text(p.concat('id')) || '' : scalarText(n) || '';
    return this.field('ID', this.input(p.concat('id'), 'ifid', val, { 'data-dev': String(devIndex), 'data-if': String(k) }), p.concat('id'), 'Unique on this device (e.g. lo0, ge-0/0/1). Renaming updates references.');
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
    return s;
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
  private listField(p: Path, label: string, order: string, placeholder: string): HTMLElement {
    const n = this.doc.get(p);
    const box = this.e('div', { class: 'list-ed' });
    const row = (ip: Path, val: string, t: string): HTMLElement =>
      this.e('div', { class: 'list-row' + (this.doc.issuesAt(ip).some((i) => i.severity === 'error') ? ' invalid' : '') }, [
        this.input(ip, t, val),
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove' }, ['×']),
      ]);
    if (n && n.kind === 'scalar' && scalarText(n) !== undefined) box.appendChild(row(p, scalarText(n) as string, 'list-scalar'));
    else if (n && n.kind === 'seq') n.items.forEach((it, k) => box.appendChild(row(p.concat(k), scalarText(it) || '', 'list-item')));
    box.appendChild(this.input(p, 'list-append', '', { placeholder: '+ add: ' + placeholder, 'data-o': order, class: 'append' }));
    return this.field(label, box, p);
  }

  // -------------------------------------------------------------- endpoints

  private deviceIds(): string[] {
    return this.ids('device');
  }

  /** interface ids (with a marker for logical ones) of a device id */
  private ifaceOptions(devId: string): Array<{ id: string; label: string }> {
    const ent = this.doc.findEntity('device', devId);
    if (!ent) return [];
    const lp: Path = ['devices', ent.index, 'interfaces'];
    const l = this.doc.get(lp);
    if (!l || l.kind !== 'seq') return [];
    return l.items
      .map((it, k) => {
        const id = it.kind === 'map' ? this.doc.text(lp.concat(k, 'id')) : scalarText(it);
        const type = it.kind === 'map' ? this.doc.text(lp.concat(k, 'type')) : undefined;
        return id ? { id, label: type && type !== 'physical' ? `${id} (${type})` : id } : null;
      })
      .filter((x): x is { id: string; label: string } => !!x);
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
    const opts = this.ifaceOptions(device);
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
  private otherProps(base: Path, kind: string): HTMLElement {
    const n = base.length ? this.doc.get(base) : this.doc.root;
    const known = KNOWN[kind] || [];
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
        const n = doc.renameInterface(Number(target.getAttribute('data-dev')), Number(target.getAttribute('data-if')), trimmed);
        note = n ? `Renamed; ${n} reference${n > 1 ? 's' : ''} updated.` : undefined;
        break;
      }
      case 'list-item':
      case 'list-scalar':
        doc.setText(p, trimmed);
        break;
      case 'list-append':
        if (trimmed === '') return true;
        doc.appendText(p, trimmed);
        break;
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
      case 'add-entity': {
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
      case 'add-loop': {
        const k = doc.addLoopback(index, []);
        this.open.add(J(['devices', index, 'interfaces', k]));
        this.host.changed('Loopback added — enter its addresses.');
        return true;
      }
      case 'add-iface': {
        const k = doc.addInterface(index);
        this.open.add(J(['devices', index, 'interfaces', k]));
        this.host.changed('Interface added.');
        return true;
      }
      case 'del-iface': {
        const dev = doc.text(['devices', p[1], 'id']);
        const ifid = doc.text(p.concat('id')) || scalarText(doc.get(p) as DocNode);
        const refs = dev && ifid ? doc.references('device', dev, ifid) : [];
        if (refs.length) {
          const a = await this.host.dialog({
            title: `Delete interface “${ifid}”?`,
            body: [`${refs.length} reference${refs.length > 1 ? 's' : ''} to ${dev}:${ifid} will become invalid.`],
            buttons: [
              { label: 'Cancel', value: 'cancel' },
              { label: 'Delete', value: 'delete', kind: 'danger' },
            ],
          });
          if (a !== 'delete') return true;
        }
        doc.remove(p, 'Delete interface');
        this.host.changed('Interface deleted.');
        return true;
      }
      case 'del-item':
        doc.remove(p);
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

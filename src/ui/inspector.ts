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
 * an interface, the ports carrying a VLAN interface's networks) are computed from the current
 * model on every render, are read-only, and are never written to the file.
 */
import { DocMap, DocNode, ENTITY_KINDS, EntityKind, IfaceEntry, KEY_ORDER, ModelDoc, Path, RouteEntry, SECTION, kindOfSection, portIdFor, portRange, DeviceModelKey } from '../editor/document';
import { BlockTarget } from '../editor/yaml-block';
import { DialogOpts } from './dialogs';
import { el, icon, materialize } from './dom';
import { headOf, objectHead } from './panels';
import { compareNames, sortedByName } from '../model/order';
import { CATEGORIES, DIRECTIONS, DUPLEXES, Direction, InterfaceKind, LINE_STYLES, LOGICAL_IFACE_TYPES, VLAN_MAX, VLAN_MIN, ifaceKey, interfaceKindLabel, routeKey, CLOUD_GROUP_KINDS, CLOUD_PROVIDERS, VPN_OPERATIONS, VPN_TECHNOLOGIES, SEPARATION_IMPLEMENTATIONS, TRANSFER_PROFILES, WIFI_SECURITY } from '../model/types';
import { PortL2, containingNetworks, derivedVlanText, endL2, endNetworks, endTagText, interfaceAddresses, interfaceVlans, isBridgePort, lagOf, networkMembers, portBadgeText, portL2, portRuns, subinterfaceParent, tagMismatch, tagMismatchText, vlanPortsByMode, vlanRangesText } from '../model/derive';
import { SNOOPING_KEY, hasSnooping, unsetSnoopingVlans } from '../model/snooping';
import { Capabilities, ROUTE_DEVICE_TYPES, capabilities, deviceRoutingRole, isLayer2Switch, relationNeedsLayer3, layer3Option, DeviceLike, ROUTING_PROTOCOL_TYPES } from '../model/capabilities';
import { nextHopCandidates, vrfKey } from '../analysis/routing';
import { CHECKS } from '../analysis/checks';
import { nextFreeChoices } from '../analysis/addressing';
import { builtinProtocols, lookupProtocol, normalizeProtocol, protocolBase } from '../model/protocols';
import { SelectionContext, contextState } from '../model/queries';
import { DEVICE_TYPES, isDeviceType, deviceTypeInText, kindsOf, modesOf, purposeDef, hasPurpose, ROLES, SYSTEM_PURPOSES } from '../model/device-types';
import { ID_RE, Issue, PROTO_RE, scalarText } from '../validation/validate';
import { duplicateRelation, endpointName, pairProblem } from '../model/connect';
import { Endpoint, endpointText } from '../model/types';
import { BUILTIN_SERVICES, ParamDef, ROUTER_ID_KEY, ServiceDef, paramsAt } from '../model/services';
import { parsePrefix } from '../model/ip';
import { suggestedServices } from '../analysis/identity';
import { Suggestion, netSuggestions, peerAsSuggestions, asnSuggestions, distanceSuggestions, generateMac, nextFreeContainerAddr, platformOui, groupSuggestions, mtuSuggestions, nextInterfaceName, routePrefixSuggestions, routerIdSuggestions, virtualIpSuggestions, vlanChoices, vlanSuggestions, vrfCaseVariants, vrfChoices } from '../analysis/helpers';
import { Model, relationDevices } from '../model/types';
import { deviceAttributes, interfaceAttributes, relationAttributes, vlanAttributes } from '../analysis/sim/attrs';
import { ParamDef as SimParamDef, ParamValue, SimParams, ceRef, deviceParamByYaml, fieldText, fieldUnit, formatValue, hvRef, ifaceRef, parseValue, relRef, scopeRef, serviceParams, vlanRef, vswRef, zoneRef } from '../analysis/sim/params';
import { derivedRecords } from '../model/netservices';
import { CONTAINER_DRIVERS, CONTAINER_ENGINES, HOST_IFACE_ROLES, HV_PLATFORMS, IPVLAN_MODES, MACVLAN_MODES, TEAMINGS, VSWITCH_TYPES } from '../model/types';
import { containerNetworks, hostOf, portGroupAttachments, portGroupL2, portGroupText, vethNetwork, isGuest, isVm, isContainer, mayHostVms, mayHostContainers } from '../model/virtual';
import { scopeSuggestions } from '../analysis/helpers';
import { purposeIcons } from '../diagram/icons';
import { SERVICES, SvcDef, SvcParam, serviceDef, serviceEligibility, isBuiltIn, builtInServices } from '../model/service-registry';
import { APP_PARAMS, APP_PROFILES, appProfile, appSummary } from '../model/applications';
import { CUSTOM_SUPPORT, simProfile } from '../model/sim-profiles';
import { supportNote } from './support-note';

/** `iface`: the document path of the selected physical or logical interface of a device; `route`: of the selected static route. */
/**
 * What the Edit tab shows and marks: an object, and within it optionally an
 * interface or a route (their cards), or `entry`, a part just created (an
 * address, a DNS name, an attribute, an endpoint …), which is marked as the
 * selection until something else is selected.
 */
export type EditorSel = { kind: EntityKind | 'document'; index: number; iface?: Path; route?: Path; entry?: Path } | null;

/** Where the focus goes when a create is undone: the control that created the entry (found again by its attributes), else its card. */
interface FocusBack {
  attrs: Array<[string, string]>;
  card: string | null;
  /** the selection before the create (undoing it selects that again: the index of the new entry is gone or another entry's) */
  sel: EditorSel;
}

/** The attributes that find a control of the Edit tab or the outline again after a render. */
const BACK_ATTRS = ['data-act', 'data-t', 'data-kind', 'data-index', 'data-p', 'data-svc'];

/** A field of the selected object that the selection was made on in the diagram (see model/addresses.ts LineField). */
export interface SelDetail {
  field: string;
  value: string;
}

export interface EditorHost {
  /** called after every committed edit */
  changed(note?: string): void;
  /** the editor selected an entity: sync the diagram */
  selected(sel: EditorSel): void;
  dialog(opts: DialogOpts): Promise<string>;
  toast(msg: string): void;
  /** how the model's file is saved, in words (for the model settings) */
  fileState(): string;
  /** the simulation-wide parameters in effect (the running simulation's, else those remembered for the next start) */
  simParams?(): { [key: string]: ParamValue };
}

/**
 * A new physical link or logical relation whose endpoints were chosen in the
 * diagram. It lives only in the Edit tab until it is created: nothing is in
 * the model before the required fields are filled in and Create is pressed.
 */
export interface ConnectionDraft {
  kind: 'link' | 'relation';
  ends: Endpoint[];
  /** the values typed so far, by field: id, protocol, label, direction, medium, speed */
  values: { [k: string]: string };
}

const J = (p: Path): string => JSON.stringify(p);

/** Can the user type into or change this control now (enabled, writable, shown)? */
function editable(f: HTMLInputElement): boolean {
  if (f.disabled || f.readOnly || f.type === 'hidden' || f.closest('fieldset[disabled]')) return false;
  if (f.getAttribute('data-t') === 'draft') return false;
  return f.getClientRects().length > 0;
}
/** Model ref of an outline entity (protocol ids are normalized in the model). */
const entityRef = (kind: EntityKind, id: string): string => kind + ':' + (kind === 'protocol' ? normalizeProtocol(id) : id);
const P = (s: string | null): Path => (s ? (JSON.parse(s) as Path) : []);

const MEDIA = ['fiber', 'copper', 'dac', 'aoc', 'wireless', 'lte', '5g', 'microwave', 'serial', 'virtual'];
const GROUP_KINDS = ['site', 'building', 'floor', 'room', 'rack', 'provider', 'cloud', 'zone', 'region', ...CLOUD_GROUP_KINDS.map((k) => k.id)];

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
  /** the outline's filter box is shown (opened with Find → Filter object list…; it stays while a filter is set) */
  filterOpen = false;
  /**
   * Sections of the model outline that are folded to their heading. Links
   * and protocols start folded: they are the longest lists and the ones
   * least often picked from here.
   */
  private collapsed = new Set<EntityKind>(['link', 'protocol']);
  /** a new link or relation being completed in the Edit tab (not in the model yet) */
  draft: ConnectionDraft | null = null;
  /**
   * The field the selection was made on (an address line, a VRF …), with
   * where it was found last: an address that is edited keeps its mark while
   * its list keeps its length.
   */
  private detail: (SelDetail & { path: string | null; count: number }) | null = null;
  /** what the Edit tab marked last: it is scrolled into view only when that changes */
  private markedKey = '';
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
    this.leaveDraft(ref);
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
    if (kind === 'route') {
      // "route:<device>:<index>": the index is the route's place in the device's list
      const c = id.lastIndexOf(':');
      const dev = this.doc.findEntity('device', id.slice(0, c));
      if (!dev) return;
      const entry = this.doc.routeEntries(dev.index)[Number(id.slice(c + 1))];
      this.sel = { kind: 'device', index: dev.index, route: entry ? entry.path : undefined };
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
    if (s.kind === 'device' && s.route !== undefined) {
      const k = s.route[3];
      if (typeof k === 'number' && this.doc.routeEntries(s.index)[k]) return 'route:' + routeKey(ent.id, k);
    }
    return entityRef(s.kind, ent.id);
  }

  /**
   * The selected object as a YAML location target: its kind and stable id
   * (and the interface, when one is selected). Null for the model settings,
   * or an entry without an id.
   */
  selectedTarget(): BlockTarget | null {
    const s = this.sel;
    if (!s || s.kind === 'document' || !this.getDoc()) return null;
    const ent = this.doc.entities(s.kind)[s.index];
    if (!ent || !ent.id) return null;
    if (s.kind === 'device' && s.iface !== undefined) {
      const want = J(s.iface);
      const entry = this.doc.interfaceEntries(s.index).find((e) => J(e.path) === want);
      return entry && entry.id ? { kind: s.kind, id: ent.id, iface: entry.id } : null;
    }
    return { kind: s.kind, id: ent.id };
  }

  /** Selecting something else (or nothing) leaves an open draft: it is discarded, and the user is told. */
  private leaveDraft(to: string | null): void {
    if (!this.draft) return;
    const kind = this.draft.kind;
    this.draft = null;
    this.host.toast(`The new ${kind === 'link' ? 'physical link' : 'relation'} was discarded (nothing was added)${to ? ': another object was selected' : ''}.`);
  }

  /**
   * The entry just created (a path in the document). After the next render
   * of the Edit tab it is marked as the selection, its card is opened and
   * scrolled into view, and its first editable field gets the keyboard focus
   * with its text selected (focusCreated). `focus: false`: the user had left
   * the control that created it (a typed value committed on Tab), so the
   * focus stays where they put it.
   */
  private created: { path: Path; focus: boolean } | null = null;
  /** per create (by the serial of its edit): where the focus goes when it is undone */
  private undoBack = new Map<number, FocusBack>();
  /** the field focusCreated put the cursor in, with its value then: while it is unchanged, Ctrl+Z undoes the create */
  private fresh: { t: string | null; p: string | null; value: string } | null = null;

  /** Is `t` the field of an entry just created, still as it was (nothing typed)? Then Ctrl+Z takes the create back, not the text. */
  untouchedNew(t: Element | null): boolean {
    const f = this.fresh;
    // (a render replaces the element; the field is the same while its data-t and data-p are)
    return !!f && !!t && t.getAttribute('data-t') === f.t && t.getAttribute('data-p') === f.p && (t as HTMLInputElement).value === f.value;
  }

  /**
   * An entry was created (one undo step, already done): select and mark it,
   * open the cards around it, give it the focus after the render, remember
   * where an undo puts the focus, and announce it (the note is the toast, a
   * polite live region).
   */
  private didCreate(path: Path, note: string, from: Element | null, opts: { sel?: EditorSel; focus?: boolean } = {}): void {
    const doc = this.doc;
    const before = this.sel ? { ...this.sel } : null;
    if (opts.sel !== undefined) this.sel = opts.sel;
    else if (this.sel && this.sel.kind !== 'document') this.sel = { kind: this.sel.kind, index: this.sel.index, iface: this.sel.iface, route: this.sel.route, entry: path };
    this.detail = null;
    for (let k = 2; k <= path.length; k++) this.open.add(J(path.slice(0, k)));
    this.created = { path, focus: opts.focus !== false };
    const card = from ? from.closest('[data-card]') : null;
    this.undoBack.set(doc.undoTop(), { attrs: from ? BACK_ATTRS.filter((a) => from.hasAttribute(a)).map((a) => [a, from.getAttribute(a) as string] as [string, string]) : [], card: card ? card.getAttribute('data-card') : null, sel: before });
    this.host.selected(this.sel);
    this.host.changed(note);
  }

  /** Is an entry waiting for the focus (it was just created)? */
  pendingCreate(): boolean {
    return !!this.created;
  }

  /** Is the creating control still focused (Enter, a click, a choice), or did the user move on (Tab)? */
  private stillFocused(t: Element): boolean {
    return this.d.activeElement === t;
  }

  /** The device of an entry, by its index ("hq-rtr1"). */
  private devName(i: number): string {
    return this.doc.text(['devices', i, 'id']) || 'the device';
  }

  /** The path of the last item of a list (after something was appended to it). */
  private lastItem(list: Path): Path {
    const n = this.doc.get(list);
    return n && n.kind === 'seq' ? list.concat(n.items.length - 1) : list;
  }

  /**
   * After a render: the entry just created gets the focus (see didCreate):
   * its first editable field in visual (document) order, with its text
   * selected so that typing replaces it; without one, its card's summary.
   * Folded sections around it open, and it is scrolled into view (smoothly
   * unless reduced motion is preferred). Returns whether there was one.
   */
  focusCreated(box: HTMLElement): boolean {
    const c = this.created;
    this.created = null;
    if (!c) return false;
    const key = J(c.path);
    const pre = key.slice(0, -1) + ',';
    const inside = (v: string | null): boolean => !!v && (v === key || v.indexOf(pre) === 0);
    let field: HTMLElement | null = null;
    const all = box.querySelectorAll('input, select, textarea');
    const unfold = (e: Element): void => {
      for (let p = e.parentElement; p && p !== box; p = p.parentElement) {
        if (p.tagName === 'DETAILS' && !p.hasAttribute('open')) {
          p.setAttribute('open', '');
          const k = p.getAttribute('data-card');
          if (k) this.open.add(k);
        }
      }
    };
    for (let i = 0; i < all.length && !field; i++) {
      const f = all[i] as HTMLInputElement;
      if (!inside(f.getAttribute('data-p'))) continue;
      // a folded section around it (the attributes) opens first, so the field can be seen
      unfold(f);
      if (editable(f)) field = f;
    }
    const card = this.byPath(box, '[data-card]', 'data-card', key);
    // an entry with nothing to type in (an underlay chip with its Remove): its row, never its Remove button
    const holder = card || (field ? (field.closest('details.card, .list-row, .g-row, .ep-row, .field') as HTMLElement | null) : this.entryElement(box, c.path));
    const anchor = field || holder;
    if (!anchor) return false;
    unfold(anchor);
    this.reveal(holder || anchor);
    if (!c.focus) return true;
    const target = field || ((holder && holder.tagName === 'DETAILS' ? holder.querySelector('summary') : holder) as HTMLElement | null);
    if (!target) return true;
    if (!field && target.tabIndex < 0 && target.tagName !== 'SUMMARY') target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    this.fresh = field ? { t: field.getAttribute('data-t'), p: field.getAttribute('data-p'), value: (field as HTMLInputElement).value } : null;
    if (field && (field.tagName === 'TEXTAREA' || /^(text|search|url|email|tel|number)?$/.test((field as HTMLInputElement).type || ''))) {
      try {
        (field as HTMLInputElement).select();
      } catch (e) {
        /* not a text field */
      }
    }
    return true;
  }

  /**
   * Before an undo is shown (`serial`: the edit it takes back): when it is a
   * create, the selection goes back to what was selected before it. Returns
   * whether it was a create.
   */
  beforeUndo(serial: number): boolean {
    const b = this.undoBack.get(serial);
    if (!b) return false;
    this.fresh = null;
    this.created = null;
    this.sel = b.sel ? { ...b.sel } : null;
    this.detail = null;
    this.host.selected(this.sel);
    return true;
  }

  /**
   * After an undo of a create (`serial`) and the render: the focus goes to
   * the control that created the entry, else to the card it was in, else to
   * the object's heading (the entry and its fields are gone). Returns
   * whether it moved the focus.
   */
  focusAfterUndo(serial: number, side: HTMLElement, outline: HTMLElement): boolean {
    const b = this.undoBack.get(serial);
    if (!b) return false;
    const match = (e: Element): boolean => b.attrs.every(([k, v]) => e.getAttribute(k) === v);
    // candidates in order; the first that really takes the focus wins (a quick action is hidden until its row has the focus)
    const cands: HTMLElement[] = [];
    if (b.attrs.length)
      for (const root of [side, outline]) {
        const all = root.querySelectorAll('[' + b.attrs[0][0] + ']');
        for (let i = 0; i < all.length; i++) {
          if (!match(all[i]) || (all[i] as HTMLButtonElement).disabled) continue;
          cands.push(all[i] as HTMLElement);
          // … then its row's entry in the outline
          const row = all[i].closest('.ol-row');
          const item = row ? (row.querySelector('.ol-item') as HTMLElement | null) : null;
          if (item) cands.push(item);
        }
      }
    if (b.card) {
      const card = this.byPath(side, '[data-card]', 'data-card', b.card);
      const sum = card ? (card.querySelector('summary') as HTMLElement | null) : null;
      if (sum) cands.push(sum);
    }
    const h = side.querySelector('.insp-head h3, h3') as HTMLElement | null;
    if (h) {
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      cands.push(h);
    }
    for (const c of cands) {
      c.focus({ preventScroll: true });
      if (this.d.activeElement !== c) continue;
      this.reveal(c);
      return true;
    }
    return false;
  }

  /** Open the card of an interface. */
  openIface(path: Path): void {
    this.open.add(J(path));
  }

  /** The field of the selected object that the selection was made on (null: the object as a whole). */
  setDetail(d: SelDetail | null): void {
    this.detail = d ? { ...d, path: null, count: -1 } : null;
  }

  private selectEntity(kind: EntityKind | 'document', index: number): void {
    this.leaveDraft(kind);
    this.detail = null;
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
    if (this.filterOpen || this.filter) {
      const f = this.e('input', { type: 'search', class: 'outline-filter', placeholder: 'Filter the object list…', 'data-t': 'outline-filter', value: this.filter, 'aria-label': 'Filter the object list (model outline)' });
      (f as HTMLInputElement).value = this.filter;
      box.appendChild(
        this.e('div', { class: 'ol-filter' + (this.filter ? ' active' : ''), role: 'search' }, [
          f,
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'filter-close', 'aria-label': 'Clear and close the outline filter', title: 'Clear and close (Esc)' }, ['×']),
        ]),
      );
    }
    const counts = this.issueCounts();
    const kinds: EntityKind[] = ['device', 'link', 'network', 'relation', 'group', 'protocol'];
    const allFolded = kinds.every((k) => this.collapsed.has(k));
    // The selection hint shares the row of "Collapse all", which is always there: selecting,
    // switching and clearing change its text only, never the position of anything below it.
    box.appendChild(
      this.e('div', { class: 'ol-tools' }, [
        this.e(
          'span',
          ctx ? { class: 'ol-ctx-hint small', 'data-related': String(ctx.related.size), title: `▸ selected · • ${ctx.related.size} directly related` } : { class: 'ol-ctx-hint small', 'data-related': '' },
          ctx
            ? [
                this.e('span', { class: 'ctx-mark sel', 'aria-hidden': 'true' }, ['▸']),
                ' selected · ',
                this.e('span', { class: 'ctx-mark rel', 'aria-hidden': 'true' }, ['•']),
                ` related (${ctx.related.size})`,
              ]
            : [],
        ),
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'fold-all', 'data-kind': allFolded ? 'open' : 'close', title: allFolded ? 'Show the entries of every section' : 'Fold every section to its heading' }, [allFolded ? 'Expand all' : 'Collapse all']),
      ]),
    );
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
            this.e('span', { class: 'ol-caret', 'aria-hidden': 'true' }, ['▾']),
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
        // a row: the entry (selects) and its quick actions, shown on the row under the pointer, the row
        // with the keyboard focus and, on a touch screen, the selected row (styles.css)
        list.appendChild(
          this.e('div', { class: 'ol-row' + (active || st === 'selected' ? ' current' : '') }, [
            this.e('button', attrs, [
              // every entry keeps the slot of the mark, so its label never moves when a selection starts or ends
              this.e('span', { class: 'ctx-mark' + (st === 'selected' ? ' sel' : st === 'related' ? ' rel' : ''), 'aria-hidden': 'true' }, [st === 'selected' ? '▸' : st === 'related' ? '•' : '']),
              this.e('span', { class: 'ol-label' }, [label]),
              kind === 'device' ? this.layerTag(ent.index) : kind === 'link' ? this.linkVlanTag(ent.id) : null,
              st ? this.e('span', { class: 'sr-only' }, [st === 'selected' ? ' (selected)' : st === 'related' ? ' (directly related)' : ' (not related)']) : null,
              this.badge(c.e, c.w),
            ]),
            this.entityActions(kind, ent.index, 'ol-quick'),
          ]),
        );
      }
      box.appendChild(sec);
    }
  }

  /** Fold exactly these sections of the outline (a view state; tests and the self-test). */
  setFolded(kinds: EntityKind[]): void {
    this.collapsed = new Set(kinds);
    this.host.changed('filter');
  }

  /**
   * Re-render the outline and give the keyboard focus back to the control it was on (the
   * rendering replaces the buttons; a press with the mouse never focused them, so nothing moves then).
   */
  private refocusOutline(sel: string, render: () => void): void {
    const a = this.d.activeElement;
    const had = !!a && !!a.closest && !!a.closest('#outline') && a.matches(sel);
    render();
    if (!had) return;
    const b = this.d.querySelector('#outline ' + sel) as HTMLElement | null;
    if (b) b.focus({ preventScroll: true });
  }

  private badge(e: number, w: number): HTMLElement | null {
    if (!e && !w) return null;
    return this.e('span', { class: 'ol-badge ' + (e ? 'err' : 'warn'), title: `${e} error(s), ${w} warning(s)` }, [String(e || w)]);
  }

  private issueCounts(): Map<string, { e: number; w: number }> {
    const m = new Map<string, { e: number; w: number }>();
    const doc = this.doc;
    for (const is of doc.errors.concat(doc.warnings, doc.findings)) {
      if (is.severity === 'info') continue;
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
  // (SimOwner: below)

  /** a simulation is running: the device's Simulation section is drawn by renderSimSection (editable), not in the read-only form */
  private simOutside = false;

  renderInspector(box: HTMLElement, opts: { simOutside?: boolean } = {}): void {
    this.simOutside = !!opts.simOutside;
    while (box.firstChild) box.removeChild(box.firstChild);
    const doc = this.getDoc();
    const wrap = this.e('div', { class: 'inspector' });
    box.appendChild(wrap);
    if (!doc) {
      wrap.appendChild(this.e('p', { class: 'muted' }, ['No model open.']));
      return;
    }
    if (this.draft) {
      this.renderDraft(wrap, this.draft);
      return;
    }
    const s = this.sel;
    if (!s || (s.kind !== 'document' && !doc.entities(s.kind)[s.index])) {
      this.sel = null;
      this.markedKey = '';
      wrap.appendChild(this.e('h3', {}, ['Edit']));
      wrap.appendChild(
        this.e('p', { class: 'muted' }, [
          'Select an object in the diagram or in the Objects list to edit it, or add one with “+ Add”. Changes apply when you press Enter or leave a field, and can be undone (Ctrl+Z).',
        ]),
      );
      wrap.appendChild(this.e('button', { type: 'button', 'data-act': 'select', 'data-kind': 'document', 'data-index': '0' }, ['Edit model settings']));
      return;
    }
    if (s.kind === 'document') this.renderDocument(wrap);
    else {
      this.renderEntity(wrap, s.kind, s.index);
      this.markSelection(wrap);
    }
  }

  // ------------------------------------------------ the selection in the Edit tab

  /**
   * Mark the part of the Edit tab that belongs to what is selected, at the
   * most specific level there is: the field of the line it was clicked on
   * (an address, VRF, VLAN, tunnel end, attribute …), else the selected
   * interface's card, else the object's header. The mark is a tinted
   * background with an accent bar and a "Selected" tag (not colour alone),
   * and aria-current for assistive technology. When it moves to another
   * section, that section is scrolled into view if it is off screen
   * (smoothly, unless reduced motion is preferred); the keyboard focus is
   * never moved.
   */
  private markSelection(wrap: HTMLElement): void {
    const s = this.sel;
    if (!s || s.kind === 'document') return;
    // the ends of a selected relation or link: the interfaces (or devices) it is attached to in the diagram
    if (s.kind === 'relation' || s.kind === 'link') {
      const ends = wrap.querySelectorAll('.ep-bind');
      for (let i = 0; i < ends.length; i++) {
        const row = (ends[i].closest('.ep-row') || ends[i].closest('.field')) as HTMLElement | null;
        if (row) row.classList.add('end-mark');
      }
    }
    const base: Path = [SECTION[s.kind], s.index];
    const scope = s.iface || base;
    let target = this.detail ? this.detailElement(wrap, scope, this.detail) : null;
    if (!target && s.entry) target = this.entryElement(wrap, s.entry);
    if (!target && s.iface) target = this.byPath(wrap, 'details.card', 'data-card', J(s.iface));
    if (!target && s.route) target = this.byPath(wrap, 'details.card', 'data-card', J(s.route));
    if (!target) target = wrap.querySelector('.insp-head');
    if (!target) return;
    target.classList.add('sel-mark');
    target.setAttribute('aria-current', 'true');
    const tag = this.e('span', { class: 'sel-tag' }, [this.e('span', { 'aria-hidden': 'true' }, ['▸ ']), 'Selected']);
    if (target.tagName === 'DETAILS') {
      const sum = target.querySelector('summary') as HTMLElement;
      const title = sum.querySelector('.card-title');
      sum.insertBefore(tag, title ? title.nextSibling : sum.firstChild);
    } else if (target.classList.contains('insp-head')) {
      // after the name (the first row has no room to spare); the heading's accessible name stays the name, aria-current says it
      const h3 = target.querySelector('h3');
      tag.setAttribute('aria-hidden', 'true');
      if (h3) h3.appendChild(tag);
      else target.appendChild(tag);
    } else if (target.classList.contains('field')) {
      const label = target.querySelector('label');
      if (label) label.appendChild(tag);
      else target.insertBefore(tag, target.firstChild);
    } else {
      // before the row's own button (a created entry's row may hold its buttons deeper: then at its end)
      const btn = target.querySelector('button');
      if (btn && btn.parentElement === target) target.insertBefore(tag, btn);
      else target.appendChild(tag);
    }
    // a mark inside a folded section (the attributes) opens it
    for (let p = target.parentElement; p && p !== wrap; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.hasAttribute('open')) {
        p.setAttribute('open', '');
        const key = p.getAttribute('data-card');
        if (key) this.open.add(key);
      }
    }
    const key = (this.selectedRef() || '') + '|' + (this.detail ? this.detail.field + '=' + this.detail.value : '') + '|' + (target.getAttribute('data-card') || '');
    if (key === this.markedKey) return;
    this.markedKey = key;
    this.reveal(target);
  }

  /** The card or row of an entry (a path): its own card, else the row of its first field. */
  private entryElement(wrap: HTMLElement, path: Path): HTMLElement | null {
    const key = J(path);
    const card = this.byPath(wrap, '[data-card]', 'data-card', key);
    if (card) return card;
    const pre = key.slice(0, -1) + ',';
    const all = wrap.querySelectorAll('[data-p]');
    for (let i = 0; i < all.length; i++) {
      const v = all[i].getAttribute('data-p') as string;
      if (v === key || v.indexOf(pre) === 0) return all[i].closest('.list-row, .g-row, .ep-row, .svc-card, .field') as HTMLElement | null;
    }
    return null;
  }

  /** Scroll a marked section into view when it is not (wholly) visible in its scrolling panel. */
  private reveal(el: HTMLElement): void {
    let box: HTMLElement | null = el.parentElement;
    while (box && box !== this.d.body) {
      const st = this.d.defaultView ? this.d.defaultView.getComputedStyle(box) : null;
      if (st && /auto|scroll/.test(st.overflowY) && box.scrollHeight > box.clientHeight) break;
      box = box.parentElement;
    }
    if (!box || box === this.d.body || typeof el.scrollIntoView !== 'function') return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top >= b.top && r.bottom <= b.bottom) return;
    const win = this.d.defaultView;
    const reduce = !!win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: r.height > b.height ? 'start' : 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }

  /** The first element matching `sel` whose attribute `attr` is `value` (paths contain quotes: no attribute selector). */
  private byPath(wrap: HTMLElement, sel: string, attr: string, value: string, more?: (e: Element) => boolean): HTMLElement | null {
    const all = wrap.querySelectorAll(sel);
    for (let i = 0; i < all.length; i++) if (all[i].getAttribute(attr) === value && (!more || more(all[i]))) return all[i] as HTMLElement;
    return null;
  }

  /** The row or field of `detail` in the section of `scope` (the selected interface, or the object). */
  private detailElement(wrap: HTMLElement, scope: Path, d: SelDetail & { path: string | null; count: number }): HTMLElement | null {
    const near = (e: Element | null, cls: string): HTMLElement | null => (e ? (e.closest(cls) as HTMLElement | null) : null);
    if (d.field === 'ip') {
      const lp = scope.concat('ip');
      const n = this.doc.get(lp);
      const items = n && n.kind === 'seq' ? n.items.map((it) => scalarText(it) || '') : n && n.kind === 'scalar' ? [scalarText(n) || ''] : [];
      if (!d.value) return near(this.byPath(wrap, 'input', 'data-p', J(lp)), '.field');
      const k = items.indexOf(d.value);
      let path: string | null = k < 0 ? null : J(n && n.kind === 'seq' ? lp.concat(k) : lp);
      // the address was edited since: the same place, while the list has as many addresses
      if (!path && d.path && d.count === items.length) path = d.path;
      if (!path) return null;
      d.path = path;
      d.count = items.length;
      return near(this.byPath(wrap, 'input', 'data-p', path), '.list-row');
    }
    if (d.field === 'attr') return near(this.byPath(wrap, 'input.g-key', 'data-p', J(scope.concat('attrs')), (e) => e.getAttribute('data-k') === d.value), '.g-row');
    if (d.field === 'dhcp') return near(this.byPath(wrap, 'button.dhcp-switch', 'data-p', J(scope)), '.field');
    // a field inside a block ("protocols.bgp.asn")
    return near(this.byPath(wrap, '[data-p]', 'data-p', J(scope.concat(d.field.split('.')))), '.field');
  }

  // ------------------------------------------------- a new link or relation

  /** Open a new link or relation between two endpoints chosen in the diagram (not in the model yet). */
  openDraft(kind: 'link' | 'relation', ends: Endpoint[]): void {
    const taken = this.doc.allIds();
    const base = (kind === 'relation' ? 'rel-' : '') + ends.map((e) => e.device).join('-');
    this.draft = { kind, ends, values: { id: this.doc.uniqueId(base, taken), label: '', protocol: '', direction: 'bidirectional', medium: '', speed: '' } };
  }

  /** Put the cursor in the draft's first required field (its ID), with the suggestion selected. */
  focusDraft(): void {
    const i = this.d.getElementById('draft-id') as HTMLInputElement | null;
    if (!i) return;
    i.focus();
    i.select();
  }

  /** Discard the draft (nothing was added to the model). */
  cancelDraft(say = true): void {
    if (!this.draft) return;
    const kind = this.draft.kind;
    this.draft = null;
    if (say) this.host.toast(`The new ${kind === 'link' ? 'physical link' : 'relation'} was discarded; nothing was added.`);
    this.host.changed('filter');
  }

  /** What still keeps the draft from being created, by field ('' fields are fine). */
  draftProblems(): { [k: string]: string } {
    const dr = this.draft;
    if (!dr) return {};
    const v = dr.values;
    const out: { [k: string]: string } = {};
    const id = v.id.trim();
    const what = dr.kind === 'link' ? 'physical link' : 'relation';
    if (!id) out.id = `Required: the new ${what} needs an ID.`;
    else if (!ID_RE.test(id)) out.id = 'An ID uses letters, digits and _ . - (up to 64 characters), and starts with a letter, a digit or _.';
    else if (this.doc.allIds().has(id)) out.id = `“${id}” is already used; IDs are unique across the model.`;
    const model = this.doc.result.model;
    if (dr.kind === 'relation') {
      const p = v.protocol.trim();
      if (!p) out.protocol = 'Required: choose or type the protocol.';
      else if (!PROTO_RE.test(normalizeProtocol(p))) out.protocol = `“${p}” is not a protocol name: use letters, digits and _ . + -`;
      else if (model && dr.ends.some((e) => this.isL2Switch(e.device)) && relationNeedsLayer3(protocolBase(model.protocols, normalizeProtocol(p)), lookupProtocol(model.protocols, p).category)) {
        const l2 = dr.ends.filter((e) => this.isL2Switch(e.device)).map((e) => e.device);
        out.protocol = `${p} requires Layer 3: ${l2.join(' and ')} ${l2.length === 1 ? 'is a Layer 2 switch' : 'are Layer 2 switches'} (tick Supports Layer 3 in ${l2.length === 1 ? 'its' : 'their'} Edit tab first).`;
      } else if (model) {
        const dup = duplicateRelation(model, dr.ends, { protocol: p, label: v.label, direction: v.direction === 'unidirectional' ? 'unidirectional' : 'bidirectional' });
        if (dup) out.ends = `The same relation already exists (“${dup.id}”: same endpoints, protocol, label and direction). Give this one another label or direction, or cancel.`;
      }
    }
    if (!out.ends && model) {
      const why = pairProblem(model, dr.kind === 'link' ? 'physical' : 'logical', dr.ends[0], dr.ends[1]);
      if (why) out.ends = `These endpoints can no longer be connected: ${why}.`;
    }
    return out;
  }

  /** The form of a draft: its endpoints, its values, what is still missing, Create and Cancel. */
  private renderDraft(w: HTMLElement, dr: ConnectionDraft): void {
    const link = dr.kind === 'link';
    const what = link ? 'physical link' : 'relation';
    const model = this.doc.result.model;
    w.appendChild(materialize(objectHead(link ? 'new physical link' : 'new relation', link ? 'New physical link' : 'New logical relation', undefined, null), this.d));
    w.appendChild(this.e('p', { class: 'draft-note' }, [`Not in the model yet. Fill in the required fields (marked *) and press Create ${what}; Cancel discards it.`]));
    const input = (k: string, label: string, required: boolean, suggestions?: string[], placeholder?: string): HTMLElement => {
      const attrs: { [k: string]: string } = { type: 'text', id: 'draft-' + k, 'data-t': 'draft', 'data-k': k, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'draft-err-' + k };
      if (required) {
        attrs.required = '';
        attrs['aria-required'] = 'true';
      }
      if (placeholder) attrs.placeholder = placeholder;
      let dl: { id: string; node: HTMLElement } | null = null;
      if (suggestions) {
        dl = this.datalist(suggestions);
        attrs.list = dl.id;
      }
      const i = this.e('input', attrs) as HTMLInputElement;
      i.value = dr.values[k] || '';
      return this.e('div', { class: 'field' }, [this.e('label', { for: 'draft-' + k }, [label + (required ? ' *' : '')]), dl ? this.e('span', { class: 'ctl' }, [i, dl.node]) : i, this.e('div', { class: 'field-err', id: 'draft-err-' + k, role: 'status' })]);
    };
    w.appendChild(this.group('Identity', [input('id', 'ID', true), input('label', 'Label', false)], 'identity'));
    const endRow = (e: Endpoint, side: string): HTMLElement =>
      this.e('div', { class: 'field draft-end', 'data-end': side }, [
        this.e('span', { class: 'draft-end-side' }, [link ? `End ${side}` : `Endpoint ${side === 'A' ? 1 : 2}`]),
        this.e('span', { class: 'ro' }, [model ? endpointName(model, e) : endpointText(e)]),
        this.e('code', { class: 'ih-id' }, [endpointText(e)]),
      ]);
    w.appendChild(this.group(link ? 'Ends' : 'Endpoints', [endRow(dr.ends[0], 'A'), endRow(dr.ends[1], 'B'), this.e('div', { class: 'field-err', id: 'draft-err-ends', role: 'status' })], 'ends'));
    if (link) {
      w.appendChild(this.group('Cable', [input('medium', 'Medium', false, MEDIA), input('speed', 'Speed', false, ['100M', '1G', '10G', '25G', '40G', '100G', '400G'])], 'cable'));
    } else {
      const l2ends = dr.ends.filter((e) => this.isL2Switch(e.device)).map((e) => e.device);
      const protos = Array.from(builtinProtocols().keys())
        .concat(this.ids('protocol'))
        .filter((x) => !l2ends.length || !relationNeedsLayer3(model ? protocolBase(model.protocols, x) : x, (builtinProtocols().get(x) || { category: '' }).category));
      const dir = this.e('select', { id: 'draft-direction', 'data-t': 'draft', 'data-k': 'direction' }, [
        this.e('option', { value: 'bidirectional' }, ['Bidirectional']),
        this.e('option', { value: 'unidirectional' }, ['Unidirectional (endpoint 1 → endpoint 2)']),
      ]) as HTMLSelectElement;
      dir.value = dr.values.direction === 'unidirectional' ? 'unidirectional' : 'bidirectional';
      w.appendChild(this.group('Protocol', [input('protocol', 'Protocol', true, protos, 'Select or type a protocol'), this.e('div', { class: 'field' }, [this.e('label', { for: 'draft-direction' }, ['Direction']), dir])], 'protocol'));
    }
    w.appendChild(
      this.e('div', { class: 'row-btns draft-actions' }, [
        this.e('button', { type: 'button', class: 'primary', id: 'draft-create', 'data-act': 'draft-create' }, [`Create ${what}`]),
        this.e('button', { type: 'button', 'data-act': 'draft-cancel' }, ['Cancel']),
      ]),
    );
    this.updateDraftUi();
  }

  /** A value of the draft was typed or chosen: keep it, and update its messages and the Create button. */
  draftInput(t: HTMLElement): void {
    const k = t.getAttribute('data-k');
    if (!this.draft || !k) return;
    this.draft.values[k] = (t as HTMLInputElement).value;
    this.updateDraftUi();
  }

  /** Messages of the draft form and whether Create is possible, without re-rendering it (the cursor stays). */
  private updateDraftUi(): void {
    const p = this.draftProblems();
    for (const k of ['id', 'protocol', 'ends']) {
      const m = this.d.getElementById('draft-err-' + k);
      if (m) m.textContent = p[k] || '';
      const i = this.d.getElementById('draft-' + k);
      if (i) i.setAttribute('aria-invalid', p[k] ? 'true' : 'false');
    }
    const b = this.d.getElementById('draft-create') as HTMLButtonElement | null;
    if (b) {
      b.disabled = Object.keys(p).length > 0;
      b.title = b.disabled ? 'Complete the required fields first' : `Add it to the model (one undo step)`;
    }
  }

  /** Create the drafted link or relation (one undo step) and select it; refused while something is missing. */
  createDraft(): boolean {
    const dr = this.draft;
    if (!dr) return false;
    const p = this.draftProblems();
    const first = ['id', 'protocol'].find((k) => p[k]);
    if (Object.keys(p).length) {
      this.updateDraftUi();
      const f = first ? (this.d.getElementById('draft-' + first) as HTMLElement | null) : null;
      if (f) f.focus();
      return false;
    }
    const v = dr.values;
    const id = v.id.trim();
    const fields: Array<[string, string]> =
      dr.kind === 'link'
        ? [['medium', v.medium], ['speed', v.speed], ['label', v.label]]
        : [['protocol', v.protocol], ['label', v.label], ['direction', v.direction === 'unidirectional' ? 'unidirectional' : '']];
    const index = this.doc.addConnection(dr.kind, id, dr.ends.map(endpointText), fields);
    this.draft = null;
    this.didCreate([dr.kind === 'link' ? 'links' : 'relations', index], `Added ${dr.kind === 'link' ? 'physical link' : 'relation'} “${id}”. Undo with Ctrl+Z.`, null, { sel: { kind: dr.kind, index } });
    return true;
  }

  private renderDocument(w: HTMLElement): void {
    const docIssues = this.doc.errors.concat(this.doc.warnings).filter((i) => !this.doc.issueEntity(i));
    w.appendChild(this.header('model', this.doc.text(['title']) || 'Untitled model', null, docIssues));
    if (docIssues.length) w.appendChild(this.issueBox(docIssues));
    if (ENTITY_KINDS.every((k) => this.doc.entities(k).length === 0)) {
      w.appendChild(this.e('p', { class: 'hint-empty' }, ['This model is empty. Add a device, link, network, relation, group or protocol with “+ Add” in the Objects list; nothing is filled in for you.']));
    }
    w.appendChild(this.group('Model', [this.textField(['title'], 'Title', 'top'), this.textField(['description'], 'Description', 'top', 'textarea')], 'model'));
    w.appendChild(
      this.group('File', [
        this.field('Model format version', this.e('span', { class: 'ro' }, [this.doc.text(['netatlas']) || '(missing)']), ['netatlas'], 'The YAML format version (not the app version). Only 1 is supported.'),
        this.e('p', { class: 'muted small file-note' }, [`File: ${this.doc.fileName} (${this.host.fileState()}).`]),
      ], 'file'),
    );
    w.appendChild(this.group('Consistency checks', [this.checksField()], 'checks'));
    const other = this.otherProps([], 'document');
    if (other.firstChild) w.appendChild(this.group('More', [other], 'more'));
  }

  /**
   * Every consistency check with its default severity, and what this model
   * makes of it: the default, another severity, or off (written to the
   * model's `checks:` section; the default writes nothing).
   */
  private checksField(): HTMLElement {
    const box = this.e('div', { class: 'checks-ed' });
    box.appendChild(this.e('p', { class: 'muted small' }, ['A check runs only on data the model has. Set one off or to another severity for this model.']));
    const table = this.e('table', { class: 'ports checks-table' }, [this.e('tr', {}, [this.e('th', {}, ['check']), this.e('th', {}, ['in this model'])])]);
    for (const c of CHECKS) {
      const cur = this.doc.checkSetting(c.id);
      const s = this.e('select', { 'data-t': 'check-setting', 'data-k': c.id, 'aria-label': `${c.title} (${c.id})` }) as HTMLSelectElement;
      s.appendChild(this.e('option', { value: '' }, [`Default (${c.severity})`]));
      for (const v of ['error', 'warning', 'info', 'off']) if (v !== c.severity) s.appendChild(this.e('option', { value: v }, [v === 'off' ? 'Off' : v.charAt(0).toUpperCase() + v.slice(1)]));
      if (cur && ['error', 'warning', 'info', 'off'].indexOf(cur) < 0) s.appendChild(this.e('option', { value: cur }, [cur + ' (not a setting)']));
      s.value = cur === c.severity ? '' : cur;
      table.appendChild(
        this.e('tr', { 'data-check': c.id, class: cur ? 'changed' : '' }, [
          this.e('td', { title: 'Reads: ' + c.reads }, [this.e('span', {}, [c.title]), this.e('code', { class: 'check-id' }, [c.id])]),
          this.e('td', {}, [s]),
        ]),
      );
    }
    box.appendChild(table);
    for (const is of this.doc.issuesAt(['checks'])) box.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return box;
  }

  /**
   * The header of the edit panel: one row with the object's type, its
   * validation state and its actions, and the object's name below it at full
   * width (long names wrap; nothing is cut off). The row wraps in a narrow
   * panel, and the action buttons drop their text, keeping icon, accessible
   * name and tooltip.
   */
  private header(kind: string, title: string, actions: HTMLElement | null, issues: Issue[], id?: string): HTMLElement {
    const errors = issues.filter((i) => i.severity === 'error').length;
    // the same header as in Details (panels.ts), with the actions added to its first row
    const head = materialize(objectHead(kind, title, id, { errors, warnings: issues.length - errors }), this.d) as HTMLElement;
    if (actions) (head.querySelector('.ih-row') as HTMLElement).appendChild(actions);
    return head;
  }

  /** How the header names an entity: as Details does when the model has it, else from the file. */
  private entityHead(kind: EntityKind, index: number): { kind: string; title: string; id?: string } {
    const id = this.doc.entities(kind)[index]?.id;
    const model = this.doc.result.model;
    const fromModel = model && id ? headOf(model, entityRef(kind, id)) : null;
    return fromModel || { kind, title: this.entityLabel(kind, index) };
  }

  /**
   * Duplicate and Delete for one entity: in the Edit tab's header and, as
   * quick actions, on its row of the model outline. Both are the same
   * buttons ("dup-entity", "del-entity") and act through onClick, so the
   * confirmation, undo, selection and modified state are the same too.
   */
  private entityActions(kind: EntityKind, index: number, cls = 'insp-actions'): HTMLElement {
    const id = this.doc.entities(kind)[index]?.id || '(no id)';
    const btn = (act: string, name: string, label: string, tip: string, extra: string): HTMLElement =>
      this.e('button', { type: 'button', class: 'icon-btn' + extra, 'data-act': act, 'data-kind': kind, 'data-index': String(index), 'aria-label': `${label} ${kind} ${id}`, title: tip }, [
        icon(this.d, name) as unknown as Node,
        this.e('span', { class: 'ib-label', 'aria-hidden': 'true' }, [label]),
      ]);
    return this.e('div', { class: cls, role: 'group', 'aria-label': `Actions for ${kind} ${id}` }, [
      btn('dup-entity', 'duplicate', 'Duplicate', `Duplicate this ${kind}: add a copy with a new id`, ''),
      btn('del-entity', 'delete', 'Delete', `Delete this ${kind} (asks first; can be undone)`, ' danger'),
    ]);
  }

  /** The issues of the object, listed under the header (which counts them). */
  private issueBox(list: Issue[]): HTMLElement {
    const ul = this.e('ul', { class: 'issue-list' });
    for (const is of list.slice(0, 30)) {
      ul.appendChild(
        this.e('li', { class: is.severity, 'data-check': is.check || '' }, [
          this.e('b', {}, [is.severity === 'error' ? 'Error: ' : is.severity === 'warning' ? 'Warning: ' : 'Info: ']),
          is.message,
          is.check ? this.e('code', { class: 'check-id', title: 'Consistency check' }, [' ' + is.check]) : null,
        ]),
      );
    }
    if (list.length > 30) ul.appendChild(this.e('li', {}, [`… and ${list.length - 30} more`]));
    return ul;
  }

  private renderEntity(w: HTMLElement, kind: EntityKind, index: number): void {
    const doc = this.doc;
    const base: Path = [SECTION[kind], index];
    const node = doc.get(base);
    const issues = doc.issuesAt(base);
    const head = this.entityHead(kind, index);
    w.appendChild(this.header(head.kind, head.title, this.entityActions(kind, index), issues, head.id));
    if (issues.length) w.appendChild(this.issueBox(issues));
    if (!node || node.kind !== 'map') {
      w.appendChild(this.e('p', { class: 'muted' }, ['This entry is not a mapping; edit it in the YAML tab or delete it.']));
      if (node) w.appendChild(this.generic(base, node, 0));
      return;
    }
    const o = kind;
    const g = (title: string, kids: Array<HTMLElement | null>, key: string): void => {
      w.appendChild(this.group(title, kids, key));
    };
    const notes = (): void => g('Notes', [this.textField(base.concat('description'), 'Description', o, 'textarea')], 'notes');
    if (kind === 'device') {
      // a guest (a VM, a container): its host is its first field, its location is the host's
      const dtype = doc.text(base.concat('type')) || '';
      const guest = isGuest({ type: dtype });
      g('Identity', [guest ? this.hostField(base, index) : null, this.idField(base, kind), this.textField(base.concat('label'), 'Label', o, 'textarea', undefined, 'Line breaks are kept.'), this.typeField(base.concat('type'), o), ...this.modelFields(base, index), this.layer3Field(base, index)], 'identity');
      g('Placement', [guest && !doc.get(base.concat('group')) ? this.guestLocationField(base) : this.refField(base.concat('group'), 'Group / location', o, this.ids('group')), this.intField(base.concat('tier'), 'Tier (0–9)', o, 'Row in the physical view (0 = top). Empty: automatic.')], 'placement');
      if (guest) g(isVm({ type: dtype }) ? 'Virtual machine' : 'Container', isVm({ type: dtype }) ? [this.textField(base.concat('guest_os'), 'Guest OS', o, 'text', undefined, 'Informational.', 'Ubuntu 24.04'), this.intField(base.concat('vcpu'), 'vCPUs', o, 'Informational (compared with its host’s CPU cores when both are given).'), this.textField(base.concat('ram'), 'Memory', o, 'text', undefined, 'A size, e.g. 16G (compared with its host’s memory when both are given).', '16G')] : [this.textField(base.concat('image'), 'Image', o, 'text', undefined, 'Informational.', 'nginx:1.27')], 'guest');
      // the built-in functions (a VPN gateway's VPN, a Security gateway's Domain separation), its pairs and management interfaces
      for (const x of this.applianceGroups(base, index)) w.appendChild(x);
      const protos = this.protocolsGroup(base, index);
      if (protos) w.appendChild(protos);
      const snoop = this.snoopingGroup(base, index);
      if (snoop) w.appendChild(snoop);
      const svcs = this.netServicesGroup(base, index);
      if (svcs) w.appendChild(svcs);
      const dnsc = this.dnsClientGroup(base);
      if (dnsc) w.appendChild(dnsc);
      if (!this.simOutside) {
        const sim = this.simulationSection(index);
        if (sim) w.appendChild(sim);
      }
      notes();
      this.renderInterfaces(w, index);
      this.renderRoutes(w, index);
    } else if (kind === 'link') {
      g('Identity', [this.idField(base, kind), this.textField(base.concat('label'), 'Label', o)], 'identity');
      g('Ends', [this.endpointField(base.concat('a'), 'End A', o, false), this.endPortField(base.concat('a'), 'A'), this.endpointField(base.concat('b'), 'End B', o, false), this.endPortField(base.concat('b'), 'B'), this.tagMismatchNote(index)], 'ends');
      g('Cable', [
        this.textField(base.concat('medium'), 'Medium', o, 'text', MEDIA, 'Set on the link only, not on ports.'),
        this.textField(base.concat('speed'), 'Speed', o, 'text', ['100M', '1G', '10G', '25G', '40G', '100G', '400G'], 'Set on the link only, not on ports.'),
        this.textField(base.concat('cable'), 'Cable / circuit id', o),
        this.directionField(base.concat('direction'), true),
        this.wifiNetworkField(base),
      ], 'cable');
      notes();
    } else if (kind === 'network') {
      g('Identity', [this.idField(base, kind), this.textField(base.concat('label'), 'Label', o)], 'identity');
      const nm = doc.result.model;
      const nv = Number(doc.text(base.concat('vlan')));
      g('Addressing', [this.cidrField(base.concat('cidr'), o), this.withHelpers(this.intField(base.concat('vlan'), `VLAN ID (${VLAN_MIN}–${VLAN_MAX})`, o, 'Interfaces addressed in this network show it as their VLAN.'), base.concat('vlan'), 'int', nm ? vlanSuggestions(nm, nv).filter((s) => / \(next free\)$/.test(s.label)) : [], 'VLAN ID', 'network ' + (doc.text(base.concat('id')) || ''))], 'addressing');
      g('Members', [this.membersField(index)], 'members');
      if (!this.simOutside) {
        const sim = this.vlanSimSection(index);
        if (sim) w.appendChild(sim);
      }
      notes();
    } else if (kind === 'relation') {
      // a Layer 3 protocol is not proposed while an endpoint is a Layer 2 switch
      const epDevs = this.listTexts(base.concat('endpoints')).map((t) => t.split(':')[0]);
      const rm = doc.result.model;
      const l2 = epDevs.some((d) => this.isL2Switch(d));
      const protos = Array.from(builtinProtocols().keys())
        .concat(this.ids('protocol'))
        .filter((x) => !l2 || !relationNeedsLayer3(rm ? protocolBase(rm.protocols, x) : x, (builtinProtocols().get(x) || { category: '' }).category));
      g('Identity', [this.idField(base, kind), this.textField(base.concat('label'), 'Label', o)], 'identity');
      const pname = doc.text(base.concat('protocol'));
      const pprof = pname && rm ? simProfile(protocolBase(rm.protocols, pname)) : undefined;
      g('Protocol', [
        this.textField(base.concat('protocol'), 'Protocol', o, 'text', protos, 'Required. Built-in names get a default style; define others under Protocols.', 'Select or type a protocol'),
        pname ? supportNote(this.d, pprof && pprof.support ? pprof.support : CUSTOM_SUPPORT, pprof ? pprof.label : pname) : null,
        this.enumField(base.concat('category'), 'Category', o, CATEGORIES as unknown as string[], '(from protocol)'),
        this.directionField(base.concat('direction')),
      ], 'protocol');
      g('Endpoints', [this.endpointList(base.concat('endpoints'), 'Endpoints', o)], 'endpoints');
      g('Underlay', [this.overField(base.concat('over'), 'Carried over (underlay)', o, index)], 'underlay');
      const params = this.endpointParamsGroup(base);
      if (params) w.appendChild(params);
      if (!this.simOutside) {
        const sim = this.relationSimSection(index);
        if (sim) w.appendChild(sim);
      }
      notes();
    } else if (kind === 'group') {
      const self = doc.text(base.concat('id'));
      // a public cloud's group (a region, a VPC, a VNet) names its provider
      const cloudKind = CLOUD_GROUP_KINDS.some((k) => k.id === (doc.text(base.concat('kind')) || '').toLowerCase());
      const provider = cloudKind || doc.get(base.concat('provider')) ? this.textField(base.concat('provider'), 'Provider', o, 'text', CLOUD_PROVIDERS.map((x) => x.id), cloudKind ? 'The cloud this region or virtual network is in (aws, azure, gcp, oci, or any other).' : 'Only a cloud group (cloud_region, vpc, vnet) has a provider.', 'aws') : null;
      g('Identity', [this.idField(base, kind), this.textField(base.concat('label'), 'Label', o), this.textField(base.concat('kind'), 'Kind', o, 'text', GROUP_KINDS, undefined, 'Select or type a group kind'), provider], 'identity');
      g('Placement', [this.refField(base.concat('parent'), 'Parent group', o, this.ids('group').filter((x) => x !== self))], 'placement');
      notes();
    } else if (kind === 'protocol') {
      g('Identity', [this.idField(base, kind), this.textField(base.concat('label'), 'Label', o)], 'identity');
      const own = simProfile(normalizeProtocol(doc.text(base.concat('id')) || ''));
      g('Drawing', [this.enumField(base.concat('category'), 'Category', o, CATEGORIES as unknown as string[], 'Select category'), this.colorField(base.concat('color'), 'Colour', o), this.enumField(base.concat('style'), 'Line style', o, LINE_STYLES as unknown as string[], '(from category)'), supportNote(this.d, own && own.support ? own.support : CUSTOM_SUPPORT, doc.text(base.concat('label')) || doc.text(base.concat('id')) || 'this protocol')], 'drawing');
      // a protocol of the model as a routing service devices can enable
      const pm = doc.result.model;
      const pid = doc.text(base.concat('id')) || '';
      const svc = pm ? pm.services.get(pid) : undefined;
      const declared = svc && !svc.builtin ? svc.params.map((x) => `${x.key} (${x.type}, ${x.scope}${x.required ? ', required' : ''})`) : [];
      if (!(svc && svc.builtin) && !BUILTIN_SERVICES.some((b) => b.id === pid)) g('Routing service', [
        this.field('Uses a router ID', this.selectEl(base.concat('router_id'), 'text', o, ['required', 'optional', 'none'], doc.text(base.concat('router_id')) || '', '(not a routing service)'), base.concat('router_id'), 'With a choice here (or parameters), devices can enable this protocol in their Protocols card.'),
        this.e('p', { class: 'muted small' }, [declared.length ? `Parameters: ${declared.join('; ')}. Edit them in the YAML tab (params:).` : 'Parameters are declared in the YAML tab (params:).']),
      ], 'service');
      notes();
    }
    const extra: HTMLElement[] = [];
    if (kind !== 'protocol') extra.push(this.attrsField(base.concat('attrs'), kind === 'relation' ? 'Protocol-specific attributes (attrs)' : 'Attributes (attrs)', o));
    const other = this.otherProps(base, kind);
    if (other.firstChild) extra.push(other);
    if (extra.length) g('More', extra, 'more');
  }

  // ------------------------------------------------------ input helpers

  /**
   * Suggestion chips under a field: each is a button that writes its value
   * (one undo step; normal validation follows). The row is a labelled group
   * placed right after the field's control; without suggestions, the field
   * is returned as it is. `kind`: how the value is written (text, an integer,
   * a link end's untagged VLAN).
   */
  private withHelpers(field: HTMLElement, path: Path, kind: 'text' | 'int' | 'end-untagged' | 'ifid', items: Suggestion[], what: string, owner: string): HTMLElement {
    if (!items.length) return field;
    const row = this.e('div', { class: 'helpers', role: 'group', 'aria-label': `Suggestions for the ${what}${owner ? ' of ' + owner : ''}` });
    for (const s of items) {
      row.appendChild(
        this.e('button', { type: 'button', class: 'chip helper', 'data-act': 'set-value', 'data-p': J(path), 'data-kind': kind, 'data-v': s.value, title: s.title, 'aria-label': `Set the ${what}${owner ? ' of ' + owner : ''} to ${s.label}` }, [s.label]),
      );
    }
    const ctl = field.querySelector(':scope > label') ? field.children[1] : null;
    field.insertBefore(row, ctl ? ctl.nextSibling : field.firstChild);
    return field;
  }

  /** What the device being edited can do (model/capabilities.ts), from the document as it is now. */
  private capsAt(devIndex: number): Capabilities {
    return capabilities(this.likeAt(['devices', devIndex]));
  }

  /** What the device at a path is, as written: its type, Supports Layer 3, mode, purpose and separation implementation. */
  private likeAt(b: Path): DeviceLike {
    const doc = this.doc;
    return {
      type: doc.text(b.concat('type')) || '',
      layer3: doc.text(b.concat('layer3')) === 'true' ? true : undefined,
      mode: doc.text(b.concat('mode')) || undefined,
      purpose: doc.text(b.concat('purpose')) || undefined,
      separation: { implementation: doc.text(b.concat('services', 'separation', 'implementation')) || undefined },
    };
  }

  /** The MAC field with a Generate button: a random, locally administered unicast address no interface has, in the model's style. */
  private macField(p: Path, owner: string, order: string, oui?: { oui: number[]; name: string }): HTMLElement {
    const f = this.textField(p.concat('mac'), 'MAC', order);
    const btn = this.e('button', { type: 'button', class: 'chip helper', 'data-act': 'gen-mac', 'data-p': J(p.concat('mac')), 'aria-label': `Generate MAC address for ${owner}`, title: 'A random, locally administered unicast address that no interface of the model has, written like the model’s other MAC addresses' }, ['Generate']);
    // a guest's NIC: one with its platform's prefix too
    const pbtn = oui
      ? this.e('button', { type: 'button', class: 'chip helper', 'data-act': 'gen-mac', 'data-oui': oui.oui.join(','), 'data-p': J(p.concat('mac')), 'aria-label': `Generate a MAC address with the prefix ${oui.name} for ${owner}`, title: `A free address with the platform’s prefix ${oui.name}` }, [`Generate (${oui.name})`])
      : null;
    const row = this.e('div', { class: 'helpers', role: 'group', 'aria-label': `MAC address helpers for ${owner}` }, [btn, pbtn]);
    const ctl = f.children[1];
    f.insertBefore(row, ctl ? ctl.nextSibling : null);
    return f;
  }

  /**
   * A VRF field as an ARIA combobox: it offers the VRFs the model uses
   * (sorted, with how often each is used) and takes a new name as typed.
   * Arrow keys move through the list, Enter picks, Esc closes it. A name
   * that differs from one in use only in case is flagged as a probable typo.
   */
  private vrfField(path: Path, owner: string, help: string): HTMLElement {
    const model = this.doc.result.model;
    const choices = model ? vrfChoices(model) : [];
    const val = this.doc.text(path) || '';
    const uid = 'vrf-' + Math.random().toString(36).slice(2, 9);
    const input = this.input(path, 'text', val, {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': uid + '-list',
      'aria-label': `VRF of ${owner}`,
      placeholder: '(default table)',
    });
    const list = this.e('ul', { id: uid + '-list', role: 'listbox', class: 'combo-list', 'aria-label': 'VRFs of the model' }) as HTMLUListElement;
    list.hidden = true;
    const note = this.e('div', { class: 'field-warn combo-note', 'aria-live': 'polite' });
    const variants = (name: string): string[] => (model ? vrfCaseVariants(model, name) : []);
    const showNote = (): void => {
      const v = variants(input.value);
      note.textContent = v.length ? `“${input.value.trim()}” differs from ${v.map((x) => `“${x}”`).join(', ')} only in case: probably a typo.` : '';
      note.hidden = !v.length;
    };
    let active = -1;
    const options = (): HTMLElement[] => Array.from(list.querySelectorAll('[role="option"]')) as HTMLElement[];
    const render = (): void => {
      while (list.firstChild) list.removeChild(list.firstChild);
      const q = input.value.trim().toLowerCase();
      const shown = choices.filter((c) => !q || c.name.toLowerCase().indexOf(q) >= 0);
      shown.forEach((c, k) => {
        const li = this.e('li', { role: 'option', id: `${uid}-o${k}`, 'data-value': c.name, 'aria-selected': 'false', class: 'combo-opt' }, [this.e('span', {}, [c.name]), this.e('span', { class: 'combo-count' }, [` ${c.count} use${c.count === 1 ? '' : 's'}`])]);
        li.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          pick(c.name);
        });
        list.appendChild(li);
      });
      if (!shown.length) list.appendChild(this.e('li', { class: 'combo-empty', role: 'presentation' }, [input.value.trim() ? 'A new VRF: press Enter to use it' : 'No VRF is used yet: type a name']));
      active = -1;
      input.removeAttribute('aria-activedescendant');
    };
    const open = (on: boolean): void => {
      list.hidden = !on;
      input.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) render();
    };
    const move = (d: number): void => {
      const os = options();
      if (!os.length) return;
      active = (active + d + os.length) % os.length;
      os.forEach((o, k) => o.setAttribute('aria-selected', k === active ? 'true' : 'false'));
      input.setAttribute('aria-activedescendant', os[active].id);
      if (typeof os[active].scrollIntoView === 'function') os[active].scrollIntoView({ block: 'nearest' });
    };
    const pick = (name: string): void => {
      input.value = name;
      open(false);
      showNote();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('input', () => {
      open(true);
      showNote();
    });
    input.addEventListener('focus', () => showNote());
    input.addEventListener('blur', () => open(false));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (list.hidden) open(true);
        move(ev.key === 'ArrowDown' ? 1 : -1);
      } else if (ev.key === 'Enter' && !list.hidden && active >= 0) {
        ev.preventDefault();
        pick(options()[active].getAttribute('data-value') as string);
      } else if (ev.key === 'Escape' && !list.hidden) {
        ev.preventDefault();
        ev.stopPropagation();
        open(false);
      }
    });
    const ctl = this.e('span', { class: 'ctl combo' }, [input, list]);
    const f = this.field('VRF', ctl, path, help);
    f.appendChild(note);
    showNote();
    return f;
  }

  // ------------------------------------------------------ routing services

  /** The loopbacks of a device that have an IPv4 address (they can be the router ID), as "id" and "id — address". */
  private ridLoopbacks(devIndex: number): Array<{ id: string; text: string }> {
    const model = this.doc.result.model;
    const devId = this.doc.text(['devices', devIndex, 'id']);
    const d = model && devId ? model.index.devices.get(devId) : undefined;
    if (!d) return [];
    return d.logical
      .filter((i) => i.type === 'loopback')
      .map((i) => ({ i, a: i.addresses.map((x) => parsePrefix(x, true)).find((x) => !!x && x.version === 4) }))
      .filter((x) => !!x.a)
      .map((x) => ({ id: x.i.id, text: `${x.i.id} — ${(x.a as NonNullable<typeof x.a>).bytes.join('.')}` }));
  }

  /**
   * A switch's IGMP / MLD snooping (`igmp_mld_snooping`), its own
   * configuration: one choice per VLAN its ports carry — Not configured (an
   * error until chosen), Enabled or Disabled — beside what each means. A
   * range written in the file is one row; VLANs without a choice are listed
   * as runs. Another device that has the key gets it listed to remove.
   */
  private snoopingGroup(base: Path, devIndex: number): HTMLElement | null {
    const doc = this.doc;
    const type = doc.text(base.concat('type')) || '';
    const node = doc.get(base.concat(SNOOPING_KEY));
    const model = doc.result.model;
    const devId = doc.text(base.concat('id')) || '';
    const dev = model && devId ? model.index.devices.get(devId) : undefined;
    if (!hasSnooping({ type, layer3: doc.text(base.concat('layer3')) === 'true' })) {
      if (!node) return null;
      return this.group('IGMP / MLD snooping', [this.e('p', { class: 'field-err' }, ['Only switches snoop IGMP / MLD: remove igmp_mld_snooping here (in the YAML tab), or change what the device is.'])], 'snooping');
    }
    const rows: Array<{ key: string; value: string }> = [];
    if (node && node.kind === 'map') node.entries.forEach((e, k) => rows.push({ key: k, value: e.value.kind === 'scalar' ? String(e.value.value) : '' }));
    // the VLANs of its ports without a choice, as runs (a choice on a run writes the run)
    const unset = dev ? unsetSnoopingVlans(dev) : [];
    for (const run of vlanRangesText(unset).split(',').filter((x) => x)) rows.push({ key: run, value: '' });
    const first = (k: string): number => Number(k.split('-')[0]) || 0;
    rows.sort((a, b) => first(a.key) - first(b.key));
    const kids: HTMLElement[] = [];
    kids.push(this.e('p', { class: 'help', id: `snoop-help-${devIndex}` }, ['Per VLAN its ports carry, for IGMP (IPv4) and MLD (IPv6) together. Enabled: a group goes only to ports where a member reported it, and to multicast router ports — never flooded when nobody did. Disabled: multicast is flooded in the VLAN. Not configured is an error until you choose.']));
    if (!rows.length) kids.push(this.e('p', { class: 'muted small' }, ['Its ports carry no VLAN yet: give them their VLANs first.']));
    for (const r of rows) {
      const shown = r.key.replace('-', '–');
      const sel = this.e('select', { id: `snoop-${devIndex}-${r.key}`, 'data-t': 'snooping', 'data-index': String(devIndex), 'data-key': r.key, 'data-p': J(base.concat(SNOOPING_KEY, r.key)), 'aria-describedby': `snoop-help-${devIndex}` }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, ['Not configured — choose']));
      sel.appendChild(this.e('option', { value: 'enabled' }, ['Enabled']));
      sel.appendChild(this.e('option', { value: 'disabled' }, ['Disabled']));
      if (r.value && r.value !== 'enabled' && r.value !== 'disabled') sel.appendChild(this.e('option', { value: r.value }, [r.value + ' (invalid)']));
      sel.value = r.value;
      if (!r.value) sel.classList.add('unset', 'invalid');
      const f = this.e('div', { class: 'field snoop-row', 'data-p': J(base.concat(SNOOPING_KEY, r.key)) }, [this.e('label', { for: `snoop-${devIndex}-${r.key}` }, [`VLAN ${shown}`]), sel]);
      if (!r.value) f.appendChild(this.e('div', { class: 'field-err' }, [`VLAN ${shown}: no IGMP / MLD snooping choice — choose Enabled or Disabled.`]));
      for (const is of doc.issuesAt(base.concat(SNOOPING_KEY, r.key))) f.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      kids.push(f);
    }
    return this.group('IGMP / MLD snooping', kids, 'snooping');
  }

  /**
   * A device's routing services (its `protocols:`). Only Layer 3+ devices
   * have the section; on another device enabled protocols are listed so
   * they can be removed. Each enabled protocol shows its parameters at the
   * device; the router ID its protocols share is shown while one of them
   * uses it. Protocols the device's relations (or its static routes) use
   * but that are not enabled are offered with one click.
   */
  private protocolsGroup(base: Path, devIndex: number): HTMLElement | null {
    const doc = this.doc;
    const reg = doc.servicesRegistry();
    const type = doc.text(base.concat('type')) || '';
    const devId = doc.text(base.concat('id')) || '';
    const block = doc.get(base.concat('protocols'));
    const enabled = block && block.kind === 'map' ? Array.from(block.entries.keys()).sort() : [];
    const kids: Array<HTMLElement | null> = [];
    const label = (id: string): string => (reg.get(id) || { label: id }).label;
    if (capabilities({ type: type }).switchFeatures && doc.text(base.concat('layer3')) !== 'true') {
      // a Layer 2 switch: the routing protocols are listed, but can't be chosen (they require Layer 3)
      for (const id of enabled) kids.push(this.e('div', { class: 'svc-row' }, [this.e('span', {}, [label(id)]), this.disableButton(devIndex, devId, id, label(id))]));
      if (doc.get(base.concat('router_id'))) kids.push(this.textField(base.concat('router_id'), 'Router ID', 'device'));
      const sel = this.e('select', { 'data-t': 'enable-service', 'data-index': String(devIndex), 'aria-label': `Enable a protocol on ${devId}`, 'aria-describedby': `l3-why-${devIndex}` }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, ['Enable a protocol…']));
      const og = this.e('optgroup', { label: 'Requires Layer 3' });
      for (const s of Array.from(reg.values()).sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1))) og.appendChild(this.e('option', { value: s.id, disabled: '' }, [`${s.label} — requires Layer 3`]));
      sel.appendChild(og);
      sel.classList.add('unset');
      const f = this.field('Enable a protocol', sel, []);
      f.appendChild(this.e('p', { class: 'help', id: `l3-why-${devIndex}` }, [`Routing protocols, multicast routing and VRRP / HSRP require Layer 3: tick Supports Layer 3 above. Its Layer 2 protocols (STP, LACP, LLDP) and management routes need nothing more; IGMP / MLD snooping is its own section.`]));
      kids.push(f);
      return this.group('Protocols (routing services)', kids, 'protocols');
    }
    if (!this.capsAt(devIndex).routingProtocols) {
      if (!enabled.length && !doc.get(base.concat('router_id'))) return null;
      kids.push(this.e('p', { class: 'field-err' }, [`Only Layer 3+ devices (${ROUTING_PROTOCOL_TYPES.map((t) => deviceTypeInText(t)).join(', ')}; a switch or VM with Supports Layer 3; a System that is a Layer 3 forwarder) run routing protocols. Remove ${enabled.length ? 'them' : 'the router ID'}, or change what the device is.`]));
      for (const id of enabled) kids.push(this.e('div', { class: 'svc-row' }, [this.e('span', {}, [label(id)]), this.disableButton(devIndex, devId, id, label(id))]));
      if (doc.get(base.concat('router_id'))) kids.push(this.textField(base.concat('router_id'), 'Router ID', 'device'));
      return this.group('Protocols (routing services)', kids, 'protocols');
    }
    // what the device's relations and routes use, offered with one click
    const model = doc.result.model;
    const sugg = model && devId ? suggestedServices(model, devId) : [];
    if (sugg.length) {
      const chips = this.e('div', { class: 'svc-suggest', role: 'group', 'aria-label': `Protocols ${devId} uses but does not enable` });
      for (const s of sugg) {
        const why = `used by ${s.relations.join(', ')}`;
        chips.appendChild(
          this.e('button', { type: 'button', class: 'chip', 'data-act': 'enable-service', 'data-index': String(devIndex), 'data-svc': s.service, 'aria-label': `Enable ${label(s.service)} on ${devId} (${why})`, title: `Enable ${label(s.service)}: ${why}` }, [
            this.e('span', { 'aria-hidden': 'true' }, ['+ ']),
            `Enable ${label(s.service)}`,
            this.e('span', { class: 'chip-why' }, [' · ' + why]),
          ]),
        );
      }
      kids.push(this.field('Suggested', chips, [], 'Used by its relations, not enabled.'));
    }
    // the router ID the enabled protocols share
    const users = enabled.filter((id) => {
      const d = reg.get(id);
      return !!d && d.routerId !== 'none';
    });
    if (users.length || doc.get(base.concat('router_id'))) {
      const req = users.filter((id) => (reg.get(id) as ServiceDef).routerId === 'required').map(label);
      const loops = this.ridLoopbacks(devIndex);
      const help = users.length
        ? `Shared by ${users.map(label).join(', ')}: a loopback (its IPv4 address) or an IPv4 address${req.length ? '; required' : ''}.`
        : 'Not applicable: no enabled protocol uses a router ID.';
      const rmodel = doc.result.model;
      kids.push(this.withHelpers(this.textField(base.concat('router_id'), 'Router ID', 'device', 'text', undefined, help, loops.length ? loops[0].id + ' or 10.255.0.1' : '10.255.0.1'), base.concat('router_id'), 'text', rmodel && devId ? routerIdSuggestions(rmodel, devId, doc.text(base.concat('router_id'))) : [], 'router ID', devId));
    }
    for (const id of enabled) kids.push(this.serviceCard(base, devIndex, devId, id));
    // enable another
    const avail = Array.from(reg.values())
      .filter((s) => enabled.indexOf(s.id) < 0)
      .sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
    const sel = this.e('select', { 'data-t': 'enable-service', 'data-index': String(devIndex), 'aria-label': `Enable a protocol on ${devId}` }) as HTMLSelectElement;
    sel.appendChild(this.e('option', { value: '' }, ['Enable a protocol…']));
    for (const s of avail) sel.appendChild(this.e('option', { value: s.id }, [s.label + (s.builtin ? '' : ' (defined in this model)')]));
    sel.classList.add('unset');
    kids.push(this.field('Enable a protocol', sel, [], 'Required parameters show as errors until filled in.'));
    return this.group('Protocols (routing services)', kids, 'protocols');
  }

  private disableButton(devIndex: number, devId: string, id: string, name: string): HTMLElement {
    return this.e('button', { type: 'button', class: 'mini', 'data-act': 'disable-service', 'data-index': String(devIndex), 'data-svc': id, 'aria-label': `Disable ${name} on ${devId}`, title: `Disable ${name} (asks first when it has values)` }, ['Disable']);
  }

  /** One enabled protocol: its device parameters, its own router ID, and where its other parameters are set. */
  private serviceCard(base: Path, devIndex: number, devId: string, id: string): HTMLElement {
    const def = this.doc.servicesRegistry().get(id);
    const name = def ? def.label : id;
    const sp = base.concat('protocols', id);
    const card = this.e('div', { class: 'svc-card', 'data-svc': id, role: 'group', 'aria-label': `${name} on ${devId}` }, [this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, [name]), this.disableButton(devIndex, devId, id, name)])]);
    if (!def) return card;
    const m = this.doc.result.model;
    for (const p of paramsAt(def, 'device')) {
      const extra = !m ? undefined : p.key === 'asn' && id === 'bgp' ? asnSuggestions(m, devId) : p.type === 'net' ? netSuggestions(m, devId, this.doc.text(sp.concat(p.key))) : undefined;
      card.appendChild(this.paramField(sp.concat(p.key), p, '', `${name} on ${devId}`, extra));
    }
    if (def.routerId !== 'none') {
      // an own router ID is rare: behind a disclosure, open while one is written
      const own = this.e('details', { class: 'svc-own-rid' }, [
        this.e('summary', {}, [`Own router ID for ${name}`]),
        this.withHelpers(this.textField(sp.concat(ROUTER_ID_KEY), `Own router ID for ${name}`, '', 'text', undefined, `Only when ${name} uses another router ID than the device’s; empty: the device’s.`), sp.concat(ROUTER_ID_KEY), 'text', this.doc.result.model ? routerIdSuggestions(this.doc.result.model, devId, this.doc.text(sp.concat(ROUTER_ID_KEY))) : [], `${name} router ID`, devId),
      ]);
      if (this.doc.get(sp.concat(ROUTER_ID_KEY)) || this.fieldIssues(sp.concat(ROUTER_ID_KEY)).length) own.setAttribute('open', '');
      card.appendChild(own);
    }
    const atIf = paramsAt(def, 'interface');
    if (atIf.length) {
      const where = this.doc.interfaceEntries(devIndex).filter((e) => !!this.doc.get(e.path.concat('protocols', id))).map((e) => e.id as string);
      card.appendChild(this.e('p', { class: 'muted small' }, [where.length ? `Groups per interface: ${where.join(', ')}.` : 'Groups are set per interface: none yet.']));
    }
    const atEp = paramsAt(def, 'endpoint');
    if (atEp.length) card.appendChild(this.e('p', { class: 'muted small' }, [`${atEp[0].label}${atEp.length > 1 ? ' and more' : ''}: per ${name} relation.`]));
    return card;
  }

  /** A protocol parameter's field, by its type: a choice for an enum, a number field for an int, else text; suggestions offered. */
  private paramField(path: Path, p: ParamDef, labelPrefix = '', owner = '', extra?: Suggestion[]): HTMLElement {
    const cur = this.doc.text(path);
    const sugg = (extra || []).concat((p.suggest || []).filter((v) => v !== cur && !(extra || []).some((x) => x.value === v)).map((v) => ({ value: v, label: v, title: `A common value for ${p.label}` })));
    return this.withHelpers(this.paramControl(path, p, labelPrefix), path, p.type === 'int' ? 'int' : 'text', sugg, p.label, owner || labelPrefix.replace(/: $/, ''));
  }

  private paramControl(path: Path, p: ParamDef, labelPrefix = ''): HTMLElement {
    const label = `${labelPrefix}${p.label}${p.required ? ' (required)' : ''}`;
    const range = p.type === 'int' && p.min !== undefined && (p.help || '').indexOf(`${p.min}–${p.max}`) < 0 ? ` ${p.min}–${p.max}.` : '';
    const help = ((p.help || '') + range).trim() || undefined;
    if (p.type === 'enum') return this.field(label, this.selectEl(path, 'text', '', p.values || [], this.doc.text(path) || '', '(not set)'), path, help);
    if (p.type === 'int') {
      const val = this.doc.text(path) || '';
      const extra: { [k: string]: string } = { inputmode: 'numeric' };
      if (p.required) extra['aria-required'] = 'true';
      return this.field(label, this.input(path, 'int', val, extra), path, help);
    }
    return this.textField(path, label, '', 'text', undefined, help);
  }

  /** The settings of the device's services on one interface (a VRRP group …): offered for the services the device enables. */
  private ifaceServiceCards(devIndex: number, p: Path, ifId: string): HTMLElement[] {
    const doc = this.doc;
    const reg = doc.servicesRegistry();
    const block = doc.get(['devices', devIndex, 'protocols']);
    const enabled = block && block.kind === 'map' ? Array.from(block.entries.keys()) : [];
    const ib = doc.get(p.concat('protocols'));
    const here = ib && ib.kind === 'map' ? Array.from(ib.entries.keys()) : [];
    const ids = Array.from(new Set(enabled.concat(here))).sort();
    const out: HTMLElement[] = [];
    for (const id of ids) {
      const def = reg.get(id);
      const atIf = def ? paramsAt(def, 'interface') : [];
      if (def && !atIf.length && here.indexOf(id) < 0) continue;
      const name = def ? def.label : id;
      if (here.indexOf(id) < 0) {
        out.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'iface-svc-on', 'data-p': J(p), 'data-svc': id, 'aria-label': `Add a ${name} group on ${ifId}` }, [`+ ${name} group`])]));
        continue;
      }
      const sp = p.concat('protocols', id);
      const card = this.e('div', { class: 'svc-card', 'data-svc': id, role: 'group', 'aria-label': `${name} on ${ifId}` }, [
        this.e('div', { class: 'svc-head' }, [
          this.e('span', { class: 'svc-name' }, [name]),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'iface-svc-off', 'data-p': J(p), 'data-svc': id, 'aria-label': `Remove the ${name} group from ${ifId}` }, ['Remove']),
        ]),
      ]);
      const gm = doc.result.model;
      const dn = doc.text(['devices', devIndex, 'id']) || '';
      const li = gm ? gm.index.interfaces.get(dn + ':' + ifId) : undefined;
      for (const prm of atIf) {
        const extra = gm && li && def ? (prm.key === 'group' ? groupSuggestions(gm, li, def) : prm.key === 'virtual_ip' ? virtualIpSuggestions(gm, li, def) : undefined) : undefined;
        card.appendChild(this.paramField(sp.concat(prm.key), prm, '', `${name} on ${dn} ${ifId}`, extra));
      }
      for (const is of this.fieldIssues(sp)) if (is.path && !atIf.some((x) => (is.message || '').indexOf(x.label) >= 0)) card.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      out.push(card);
    }
    return out;
  }

  /** A relation of a protocol with parameters per endpoint (OSPF area, cost …): a field per endpoint device, or one for both ends when one value is written. */
  private endpointParamsGroup(base: Path): HTMLElement | null {
    const doc = this.doc;
    const model = doc.result.model;
    const proto = doc.text(base.concat('protocol'));
    if (!model || !proto) return null;
    const def = model.services.get(protocolBase(model.protocols, proto));
    const params = def ? paramsAt(def, 'endpoint') : [];
    if (!def || !params.length) return null;
    const id = doc.text(base.concat('id')) || '';
    const r = model.index.relations.get(id);
    const devs = r ? relationDevices(r) : [];
    const kids: HTMLElement[] = [];
    for (const p of params) {
      const ap = base.concat('attrs', p.key);
      const n = doc.get(ap);
      if (n && n.kind === 'scalar') {
        kids.push(this.paramField(ap, p, '', `relation ${id}`));
        continue;
      }
      const row = this.e('div', { class: 'ep-params', role: 'group', 'aria-label': p.label });
      row.appendChild(this.e('div', { class: 'ep-params-label' }, [p.label]));
      for (const dv of devs) {
        // a BGP end expects the other device's AS
        const other = devs.length === 2 ? devs[devs[0] === dv ? 1 : 0] : '';
        const extra = p.key === 'peer-as' && other ? peerAsSuggestions(model, other, doc.text(ap.concat(dv))) : undefined;
        row.appendChild(this.paramField(ap.concat(dv), p, `${dv}: `, `${dv} in ${id}`, extra));
      }
      kids.push(row);
    }
    kids.push(this.e('p', { class: 'muted small' }, ['Per endpoint device, in the relation’s attrs; the checks compare the ends.']));
    return this.group(`${def.label} parameters`, kids, 'endpoint-params');
  }

  /**
   * A titled group of fields in the Edit tab (a card). The same look as the
   * sections of the Details tab, so both tabs read alike; every field keeps
   * its own label, help and messages.
   */
  private group(title: string, kids: Array<HTMLElement | null>, key: string): HTMLElement {
    const id = 'fg-' + key;
    return this.e('section', { class: 'fgroup', 'data-group': key, 'aria-labelledby': id }, [this.e('h4', { class: 'fgroup-title', id }, [title]), ...kids]);
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
    const dtype = doc.text(['devices', devIndex, 'type']) || '';
    const guest = isGuest({ type: dtype });
    // a guest has no ports: only while its file still lists some (an error to fix) is the section shown
    if (guest && !phys.length) {
      w.appendChild(
        this.e('section', { class: 'sub', 'data-list': 'interfaces' }, [
          this.e('div', { class: 'sub-head' }, [this.e('h4', {}, ['Physical interfaces (0)'])]),
          this.e('p', { class: 'muted small' }, [isVm({ type: dtype }) ? 'A VM has no ports or cables: its virtual NICs are on its host’s port groups (or bound to a host port).' : 'A container has no ports or cables: it is attached to its host’s container networks.']),
        ]),
      );
    }
    const is = this.e('section', { class: 'sub', 'data-list': 'interfaces' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`Physical interfaces (${phys.length})`]),
        this.e('span', { class: 'ctl row' }, [
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-iface', 'data-index': String(devIndex), title: 'Add one physical interface' }, ['+ Interface']),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-range', 'data-index': String(devIndex), title: 'Add a numbered range of physical interfaces, e.g. ge 1/1 to ge 1/24' }, ['+ Port Range']),
          phys.length ? this.e('button', { type: 'button', class: 'mini', 'data-act': 'assign-vlans', 'data-index': String(devIndex), title: 'Give a range of ports the same VLANs, in one step' }, ['Assign VLANs to ports…']) : null,
        ]),
      ]),
      phys.length ? null : this.e('p', { class: 'muted small' }, ['Ports: the only interfaces that can be cabled.']),
      notList('interfaces'),
    ]);
    for (const e of phys) is.appendChild(this.ifaceCard(devIndex, e));
    if (!guest || phys.length) w.appendChild(is);

    const logical = sorted('logical');
    const add = (type: string, label: string): HTMLElement => this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-logical', 'data-index': String(devIndex), 'data-kind': type }, [label]);
    const ls = this.e('section', { class: 'sub', 'data-list': 'logical' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`Logical interfaces (${logical.length})`]),
        this.e(
          'span',
          { class: 'ctl row' },
          isVm({ type: dtype })
            ? [add('vnic', '+ Virtual NIC'), add('virtual', '+ Virtual'), add('loopback', '+ Loopback'), add('tunnel', '+ Tunnel')]
            : isContainer({ type: dtype })
              ? [add('veth', '+ Network attachment'), add('loopback', '+ Loopback')]
              : [doc.get(['devices', devIndex, 'services', 'hypervisor']) ? add('vnic', '+ Host interface') : null, add('loopback', '+ Loopback'), add('virtual', '+ Virtual'), add('tunnel', '+ Tunnel')],
        ),
      ]),
      logical.length ? null : this.e('p', { class: 'muted small' }, ['Loopbacks, VLAN interfaces, bonds, subinterfaces, tunnels. Never cabled.']),
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
      `${multi.map((id) => `${id} has ${this.ifaceAddrs(devIndex, id).length} addresses`).join('; ')}: the name belongs to the interface, not to one address.`,
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
      entries.length ? null : this.e('p', { class: 'muted small' }, ['Names of this device, tied to its interfaces; a DNS server’s zone that holds one answers it.']),
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
        this.e('p', { class: 'muted small' }, ['Tied to whole interfaces; a DNS server’s zone that holds it answers it.']),
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
        this.e('p', { class: 'muted small' }, ['A DNS server’s zone that holds it answers it. Undo with Ctrl+Z.']),
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
    const k = doc.addDnsName(devIndex, name, chosen());
    if (k < 0) {
      this.host.toast(doc.dnsNameError(devIndex, name, chosen()) || 'The DNS name was not added.');
      return;
    }
    this.didCreate(['devices', devIndex, 'dns_names', k], `DNS name “${name}” added to ${this.devName(devIndex)}.`, this.d.querySelector('[data-act="add-dns"]'));
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
    const before = doc.interfaceEntries(devIndex).filter((e) => e.path[2] === 'interfaces').length;
    const done = doc.addPortRange(devIndex, from.value, to.value);
    if (!done.ok) {
      this.host.toast(done.error);
      return;
    }
    // the first new port is the one to fill in
    const first: Path = ['devices', devIndex, 'interfaces', before];
    this.didCreate(first, `${done.ports.length} ports added to ${this.devName(devIndex)} (${done.ports[0].name} … ${done.ports[done.ports.length - 1].name}).`, this.d.querySelector('[data-act="add-range"]'), { sel: { kind: 'device', index: devIndex, iface: first } });
  }

  /** A model was opened: every device's Simulation section starts collapsed again. */
  foldSimSections(): void {
    for (const k of Array.from(this.open)) if (k.indexOf('sim-section|') === 0) this.open.delete(k);
  }

  /** Forget everything that belonged to the model that was open: selection, open cards, filter, folded sections, YAML draft. */
  reset(): void {
    this.sel = null;
    this.undoBack.clear();
    this.created = null;
    this.fresh = null;
    this.draft = null;
    this.open.clear();
    this.filter = '';
    this.filterOpen = false;
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
        o === 'interface' || doc.get(p.concat('members')) ? this.modeBadge(this.cardL2(devIndex, p)) : null,
        iss.length ? this.badge(errs, iss.length - errs) : null,
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-iface', 'data-p': J(p), title: 'Delete this interface' }, ['×']),
      ]),
    );
    card.appendChild(this.ifIdField(p, loop ? 'lo0' : kind === 'tunnel' ? 'tun0' : kind === 'virtual' ? 'Vlan10, bond0' : 'ge-0/0/1'));
    card.appendChild(this.ifTypeField(p, entry));
    // a guest's virtual NIC and a container's network attachment: what they are attached to, right after what they are
    if (kind === 'vnic') for (const f of this.vnicFields(devIndex, p, id || '')) card.appendChild(f);
    if (kind === 'veth') for (const f of this.vethFields(devIndex, p, id || '')) card.appendChild(f);
    // a port's (or an aggregate's) VLANs, right after what it is
    const isLagCard = o === 'logical' && !!doc.get(p.concat('members'));
    if (o === 'interface' || isLagCard || doc.get(p.concat('vlans')) || doc.get(p.concat('native')) || doc.get(p.concat('routed'))) card.appendChild(this.portVlanField(devIndex, p, entry));
    card.appendChild(this.textField(p.concat('label'), loop ? 'Name' : 'Label', o, 'text', undefined, loop ? 'Descriptive name, e.g. “Router ID” or “BGP source”.' : undefined));
    card.appendChild(this.addressField(p, loop, o));
    if (!loop && !dhcp && id) {
      const nf = this.nextFreeField(devIndex, p, id);
      if (nf) card.appendChild(nf);
    }
    card.appendChild(this.ifaceDerivedField(devIndex, p));
    if (o === 'logical') {
      // Each association belongs to one type. A field of another type is only shown while the file still has it, so it can be removed.
      const has = (k: string): boolean => !!doc.get(p.concat(k));
      // A virtual interface is not assumed to be a bond or a VLAN interface: once it is one of them, only
      // that association is shown; while it is neither, both are offered.
      const vlans = this.cardVlans(devIndex, p);
      if (has('members') || (kind === 'virtual' && !has('vlan') && !vlans.length)) card.appendChild(this.membersPortsField(devIndex, p));
      if (has('min_links') || has('members')) card.appendChild(this.intField(p.concat('min_links'), 'Minimum links', o, 'How many member links must be up for the aggregate to be up.'));
      if (has('vlan') || (kind === 'virtual' && (!has('members') || vlans.length > 0))) {
        const model = doc.result.model;
        const cur = Number(doc.text(p.concat('vlan')));
        card.appendChild(this.withHelpers(this.intField(p.concat('vlan'), `VLAN ID (${VLAN_MIN}–${VLAN_MAX})`, o, 'VLAN interfaces only. Empty: taken from the network of an address above.'), p.concat('vlan'), 'int', model ? vlanSuggestions(model, cur) : [], 'VLAN ID', `${doc.text(['devices', devIndex, 'id']) || ''} ${id || ''}`.trim()));
      }
      if (kind === 'virtual' && vlans.length && !has('members')) card.appendChild(this.bridgePortsField(devIndex, p));
      if (kind === 'tunnel' || has('source')) {
        const others = sortedByName(doc.interfaceEntries(devIndex).filter((e) => !!e.id && e.id !== id), (e) => e.id as string).map((e) => e.id as string);
        card.appendChild(this.textField(p.concat('source'), 'Tunnel source', o, 'text', others, 'An interface of this device (e.g. a loopback) or an IP address.', 'Interface or address'));
      }
      if (kind === 'tunnel' || has('destination')) {
        card.appendChild(this.textField(p.concat('destination'), 'Tunnel destination', o, 'text', this.deviceIds().filter((x) => x !== doc.text(['devices', devIndex, 'id'])), 'An IP address, a device, or device:interface.', 'Address, device or device:interface'));
      }
    }
    const devName = doc.text(['devices', devIndex, 'id']) || '';
    const owner = `${devName} ${id || ''}`.trim();
    card.appendChild(this.vrfField(p.concat('vrf'), owner, 'The VRF this interface is assigned to, if any.'));
    const model = doc.result.model;
    const live = model && devName && id ? model.index.interfaces.get(devName + ':' + id) : undefined;
    if (!loop || doc.get(p.concat('mtu'))) {
      card.appendChild(this.withHelpers(this.intField(p.concat('mtu'), 'MTU (bytes)', o, 'Empty: not modelled (no MTU is assumed).'), p.concat('mtu'), 'int', model && live ? mtuSuggestions(model, live) : [], 'MTU', owner));
    }
    if (!loop || doc.get(p.concat('mac'))) card.appendChild(this.macField(p, owner, o, this.platformOuiOf(devIndex, kind)));
    for (const sc of this.ifaceServiceCards(devIndex, p, id || '')) card.appendChild(sc);
    // a routed interface with an address: its DHCP relay (helper addresses)
    const routes = this.capsAt(devIndex).l3Forward;
    if ((routes && addrs.length) || doc.get(p.concat('dhcp_relay'))) {
      const rf = this.listField(p.concat('dhcp_relay'), 'DHCP relay (helper addresses)', o, '10.0.0.10', 'Forwards its subnet’s DHCP broadcasts to these servers (unicast, its address as giaddr).');
      const srvs = this.serviceAddrs('dhcp');
      card.appendChild(this.withHelpers(rf, p.concat('dhcp_relay'), 'text', srvs.map((x) => ({ value: x.a, label: `${x.a} (${x.d})`, title: `The DHCP server ${x.d}` })), 'DHCP relay', `${doc.text(['devices', devIndex, 'id']) || ''} ${id || ''}`.trim()));
    }
    // its simulation attributes (drawn in the Actions panel while a simulation runs)
    if (id && !this.simOutside) {
      const sim = this.ifaceSimSection(devIndex, p, id);
      if (sim) card.appendChild(sim);
    }
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
   * DHCP, so it has no switch, unless its file says "ipv4: dhcp": then the
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
        : 'Obtained by DHCP: unknown here, so no network or VLAN.';
    const f = this.listField(p.concat('ip'), label, o, example, help, locked);
    f.setAttribute('data-dhcp', on ? 'on' : 'off');
    // the switch sits beside the label (see .field[data-dhcp] in the styles)
    f.insertBefore(sw, f.firstChild ? f.firstChild.nextSibling : null);
    for (const is of doc.issuesAt(p.concat('ipv4'))) f.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return f;
  }

  /**
   * Adding an address: the next free address of a network, chosen from the
   * networks of the interface's VRF that have one, those its cable carries
   * or its peer port is in first (see analysis/addressing.ts). Pressing
   * "Add" appends it with the network's prefix length (one undo step). Not
   * shown when the model has no such network.
   */
  private nextFreeField(devIndex: number, p: Path, ifaceId: string): HTMLElement | null {
    const model = this.doc.result.model;
    const dev = this.doc.text(['devices', devIndex, 'id']);
    if (!model || !dev) return null;
    const choices = nextFreeChoices(model, dev, ifaceId);
    if (!choices.length) return null;
    const sel = this.e('select', { 'data-next-free': '', 'aria-label': 'Network to take the next free address from' }) as HTMLSelectElement;
    for (const c of choices) sel.appendChild(this.e('option', { value: c.id }, [`${c.text} ${c.label}${c.suggested ? ' (on this cable)' : ''} → ${c.nextFree}`]));
    const btn = this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-next-free', 'data-p': J(p.concat('ip')), 'data-iface': ifaceId, 'data-dev': dev, title: 'Add the next free address of the chosen network to this interface' }, ['+ Add']);
    return this.e('div', { class: 'field next-free', 'data-next-free-field': '' }, [
      this.e('label', {}, ['Next free address']),
      this.e('span', { class: 'ctl row' }, [sel, btn]),
      this.e('div', { class: 'help' }, ['The lowest address no interface or VIP of the network uses.']),
    ]);
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
        this.e('div', { class: 'help' }, ['A port: the only kind of interface that can be cabled.']),
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
    // a virtual NIC on a VM (or a hypervisor's host interface), a network attachment on a container: offered where they apply
    const dp = p.slice(0, 2);
    const dtype = this.doc.text(dp.concat('type')) || '';
    const vnic = isVm({ type: dtype }) || !!this.doc.get(dp.concat('services', 'hypervisor'));
    const veth = isContainer({ type: dtype });
    for (const t of LOGICAL_IFACE_TYPES) if ((t !== 'vnic' || vnic || cur === t) && (t !== 'veth' || veth || cur === t)) s.appendChild(this.e('option', { value: t }, [interfaceKindLabel(t)]));
    s.value = cur;
    const hint = veth
      ? 'Container network attachment: on a network of its host. Also loopback, virtual, tunnel.'
      : vnic
        ? 'Virtual NIC: on a port group, or passthrough. Also loopback, virtual, tunnel.'
        : 'Loopback: own address. Virtual: VLAN interface, bond, subinterface … Tunnel: tunnel end.';
    return this.field('Type', s, tp, hint);
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
    return this.field('Member ports', box, mp, 'Bonds / aggregates only: their physical member ports.');
  }

  /** The VLANs of the interface at `p` in the current model (written on it or derived from its addresses); none while it has errors. */
  private cardVlans(devIndex: number, p: Path): number[] {
    const model = this.doc.result.model;
    const dev = this.doc.text(['devices', devIndex, 'id']);
    const id = this.doc.text(p.concat('id'));
    const inf = model && dev && id ? model.index.interfaces.get(ifaceKey(dev, id)) : undefined;
    return model && inf ? interfaceVlans(model, inf) : [];
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
    const f = this.field('ID', this.input(p.concat('id'), 'ifid', val), p.concat('id'), `Unique on this device, e.g. ${example}. Renaming updates references.`);
    // a name that follows the device's other names of this kind (ge-0/0/3 after ge-0/0/2), when this one doesn't
    const model = this.doc.result.model;
    const dev = this.doc.text(['devices', p[1] as number, 'id']) || '';
    const live = model && dev ? model.index.interfaces.get(dev + ':' + val) : undefined;
    if (model && live) {
      const next = nextInterfaceName(model, dev, live.type);
      const stem = (s: string): string => s.replace(/[0-9]+$/, '');
      if (stem(next) !== stem(val)) return this.withHelpers(f, p.concat('id'), 'ifid', [{ value: next, label: next, title: `Named like this device’s other ${live.type} interfaces; every reference follows the rename` }], 'name', `${dev} ${val}`);
    }
    return f;
  }

  private intField(p: Path, label: string, order: string, help?: string): HTMLElement {
    const val = this.doc.text(p) || '';
    return this.field(label, this.input(p, 'int', val, { 'data-o': order, inputmode: 'numeric' }), p, help);
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

  /** A switch's layer in the object list: "L2" / "L3" beside its name (its accessible text says it in full). */
  /**
   * What a cable's two ports carry, in the Objects list: their diagram tags
   * ("A 10", "T 10,20 · N 10"), once when both ends agree; ⚠ when they
   * disagree. The words are in the text (and spelled out for screen readers),
   * not in a colour.
   */
  private linkVlanTag(id: string | null | undefined): HTMLElement | null {
    const model = this.doc.result.model;
    const l = model && id ? model.index.links.get(id) : undefined;
    if (!model || !l) return null;
    const a = endTagText(model, l.a);
    const b = endTagText(model, l.b);
    if (!a && !b) return null;
    const mm = tagMismatch(model, l);
    const words = (e: typeof l.a): string => portBadgeText(endL2(model, e)) || 'no VLANs';
    const said = a === b ? `${words(l.a)} at both ends` : `${words(l.a)} at ${l.a.device}, ${words(l.b)} at ${l.b.device}`;
    return this.e('span', { class: 'ol-vlan' + (mm ? ' mismatch' : ''), 'data-vlans': a === b ? a : `${a}|${b}`, title: (mm ? '⚠ ' + tagMismatchText(mm) + ' — ' : '') + said }, [
      this.e('span', { 'aria-hidden': 'true' }, [(mm ? '⚠ ' : '') + (a === b ? a : `${a || '–'} ⟷ ${b || '–'}`)]),
      this.e('span', { class: 'sr-only' }, [` (VLANs: ${said}${mm ? '; they disagree' : ''})`]),
    ]);
  }

  private layerTag(devIndex: number): HTMLElement | null {
    const doc = this.doc;
    if (!this.capsAt(devIndex).switchFeatures) return null;
    const l3 = doc.text(['devices', devIndex, 'layer3']) === 'true';
    return this.e('span', { class: 'ol-layer' + (l3 ? ' l3' : ''), title: l3 ? 'Layer 3 switch' : 'Layer 2 switch' }, [
      this.e('span', { 'aria-hidden': 'true' }, [l3 ? 'L3' : 'L2']),
      this.e('span', { class: 'sr-only' }, [l3 ? ' (Layer 3 switch)' : ' (Layer 2 switch)']),
    ]);
  }

  /**
   * A switch's layer: Layer 3 (`layer3: true`, routes between its VLANs and
   * subnets) or Layer 2 (the default: switches frames only). Shown for
   * switches, and wherever `layer3` is written (to remove it from another type).
   */
  private layer3Field(base: Path, devIndex: number): HTMLElement | null {
    const doc = this.doc;
    const type = doc.text(base.concat('type')) || '';
    const on = doc.text(base.concat('layer3')) === 'true';
    if (!layer3Option(type) && !doc.get(base.concat('layer3'))) return null;
    const id = doc.text(base.concat('id')) || '';
    void id;
    // one short question; what it means is the tooltip (the badge in the diagram says which kind it is)
    const box = this.e('input', { type: 'checkbox', id: `layer3-${devIndex}`, 'data-act': 'layer3', 'data-index': String(devIndex), title: 'Routing, routing protocols, and gateways' }) as HTMLInputElement;
    box.checked = on;
    const f = this.e('div', { class: 'field layer3-field', 'data-p': J(base.concat('layer3')) }, [
      this.e('label', { class: 'check', for: `layer3-${devIndex}`, title: 'Routing, routing protocols, and gateways' }, [box, ' Supports Layer 3']),
      isVm({ type: type }) ? this.e('div', { class: 'help' }, ['A virtual router or firewall: the rules of a Layer 3 switch.']) : !capabilities({ type: type }).switchFeatures ? this.e('div', { class: 'help' }, ['Only switches and VMs have it; untick to remove it.']) : null,
    ]);
    for (const is of doc.issuesAt(base.concat('layer3'))) f.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return f;
  }

  /**
   * A server's network services (`services:`): two checkboxes, DHCP server
   * and DNS server, both off by default. An enabled one shows what it still
   * needs as errors (nothing is chosen for the user): a DHCP server its
   * scopes (network, range, gateway, DNS servers; lease time, exclusions,
   * reservations, domain), a DNS server its zones (the records the model's
   * DNS names give, read-only with their source, and its own A, AAAA and
   * CNAME records), its listening address, forwarders and reverse zones.
   * Each scope and zone has its collapsed Simulation subsection.
   */
  private netServicesGroup(base: Path, devIndex: number): HTMLElement | null {
    const doc = this.doc;
    const type = doc.text(base.concat('type')) || '';
    const sp = base.concat('services');
    const node = doc.get(sp);
    const like = { ...this.likeAt(base), wireless: doc.get(sp.concat('wireless')) ? true : undefined };
    const may = (id: string): boolean => serviceEligibility(serviceDef(id) as SvcDef, like) === null;
    if (!SERVICES.some((x) => x.id !== 'separation' && serviceEligibility(x, like) === null) && !node) return null;
    const dev = doc.text(base.concat('id')) || '';
    const model = doc.result.model;
    const kids: Array<HTMLElement | null> = [];
    const note = (path: Path): void => {
      for (const is of doc.issuesAt(path, true)) kids.push(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    };
    note(sp);
    const box = (id: 'dhcp' | 'dns' | 'hypervisor' | 'container_engine', label: string, title: string): HTMLElement => {
      const on = !!doc.get(sp.concat(id));
      const cb = this.e('input', { type: 'checkbox', id: `svc-${id}-${devIndex}`, 'data-act': 'netsvc', 'data-svc': id, 'data-index': String(devIndex), title }) as HTMLInputElement;
      cb.checked = on;
      return this.e('div', { class: 'field' }, [this.e('label', { class: 'check', for: `svc-${id}-${devIndex}`, title }, [cb, ' ' + label]), on ? supportNote(this.d, (serviceDef(id) as SvcDef).support, label) : null]);
    };
    if (may('dhcp') || doc.get(sp.concat('dhcp'))) kids.push(box('dhcp', 'DHCP server', 'Leases addresses to the DHCP clients of its scopes’ networks'));
    const dhcp = doc.get(sp.concat('dhcp'));
    if (dhcp) {
      const lp = sp.concat('dhcp', 'scopes');
      note(sp.concat('dhcp'));
      note(lp);
      const n = doc.get(lp);
      const items = n && n.kind === 'seq' ? n.items : [];
      items.forEach((_it, k) => kids.push(this.scopeCard(lp.concat(k), dev, k, model)));
      kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(lp), 'data-what': 'scope' }, ['+ Add scope'])]));
    }
    if (may('dns') || doc.get(sp.concat('dns'))) kids.push(box('dns', 'DNS server', 'Answers DNS queries for its zones (the model’s DNS names in them, and its own records)'));
    const dns = doc.get(sp.concat('dns'));
    if (dns) {
      const dp = sp.concat('dns');
      note(dp);
      note(dp.concat('zones'));
      const own = this.serviceAddrs(null, dev).map((x) => x.a);
      kids.push(this.withHelpers(this.textField(dp.concat('listen'), 'Listening address', 'dnsService', 'text', undefined, 'One of its addresses; empty: all of them.', 'all its addresses'), dp.concat('listen'), 'text', own.map((a) => ({ value: a, label: a, title: `Listen on ${a} only` })), 'listening address', dev));
      const zp = dp.concat('zones');
      const zn = doc.get(zp);
      const zitems = zn && zn.kind === 'seq' ? zn.items : [];
      zitems.forEach((_it, k) => kids.push(this.zoneCard(zp.concat(k), dev, model)));
      kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(zp), 'data-what': 'zone' }, ['+ Add zone'])]));
      kids.push(this.listField(dp.concat('forwarders'), 'Forwarders', 'dnsService', '9.9.9.9', 'Asked for names outside its zones (a DNS server of the model; else SERVFAIL).'));
      kids.push(this.listField(dp.concat('reverse_zones'), 'Reverse zones (PTR)', 'dnsService', '10.10.0.0/16', 'Networks it answers PTR queries for.'));
    }
    // the Hypervisor (a server) and the Container engine (a server or a VM), each with its configuration
    if (mayHostVms({ type: type }) || doc.get(sp.concat('hypervisor'))) {
      kids.push(box('hypervisor', 'Hypervisor', 'Runs VMs: its virtual switches, port groups and host interfaces'));
      // its configuration collapsible; its guests (with + VM) always in view
      if (doc.get(sp.concat('hypervisor'))) kids.push(this.hypervisorCard(sp.concat('hypervisor'), dev, devIndex), this.guestsField(dev, devIndex, 'vm'));
    }
    if (mayHostContainers({ type: type }) || doc.get(sp.concat('container_engine'))) {
      kids.push(box('container_engine', 'Container engine', 'Runs containers: its container networks'));
      if (doc.get(sp.concat('container_engine'))) kids.push(this.engineCard(sp.concat('container_engine'), dev, devIndex), this.guestsField(dev, devIndex, 'container'));
    }
    // its applications: each a collapsed entry, with Add application
    if (doc.get(sp.concat('applications'))) kids.push(this.applicationsCard(devIndex));
    // the other services of the registry it runs (a router's Wireless access among them), then Add service…
    const builtIn = builtInServices(like).map((x) => x.id);
    for (const def of SERVICES) {
      if (OWN_UI.indexOf(def.id) >= 0 || builtIn.indexOf(def.id) >= 0 || !doc.get(sp.concat(def.id))) continue;
      kids.push(def.id === 'wireless' ? this.wirelessCard(sp.concat('wireless'), devIndex, false) : this.serviceCardGeneric(sp.concat(def.id), def, devIndex, false));
    }
    kids.push(this.addServiceField(sp, devIndex, like));
    return this.group(isContainer({ type: type }) ? 'Services (DHCP, DNS)' : 'Services', kids, 'netservices');
  }

  /**
   * Applications (`services.applications`): each a collapsed entry with its
   * one-line summary ("Management · TCP listener · 443"); opened: its id,
   * name and profile, the profile's basic fields, and its other fields in
   * a collapsed Advanced section; Duplicate and Remove. Add application
   * appends one and focuses its profile (nothing is chosen for it).
   */
  private applicationsCard(devIndex: number): HTMLElement {
    const doc = this.doc;
    const lp = doc.appsPath(devIndex);
    const n = doc.get(lp);
    const items = n && n.kind === 'seq' ? n.items : [];
    const card = this.e('div', { class: 'svc-card', 'data-svc-card': 'applications', role: 'group', 'aria-label': 'Applications' }, [
      this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, [`Applications (${items.length})`])]),
      this.e('p', { class: 'help' }, ['Generic TCP and UDP behaviour and MQTT clients. A name such as “Modbus TCP” labels an application: it does not simulate that protocol.']),
    ]);
    for (const is of doc.issuesAt(lp, true)) card.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    items.forEach((_it, k) => card.appendChild(this.appEntry(devIndex, k)));
    card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-app', 'data-index': String(devIndex) }, ['+ Add application'])]));
    return card;
  }

  /** One application: its summary; opened, its fields (basic, then Advanced), Duplicate and Remove. */
  private appEntry(devIndex: number, k: number): HTMLElement {
    const doc = this.doc;
    const p = doc.appsPath(devIndex).concat(k);
    const dev = doc.text(['devices', devIndex, 'id']) || '';
    const v = this.valuesAt(p);
    const id = doc.text(p.concat('id')) || '';
    const portText = doc.text(p.concat('port'));
    const summary = appSummary({ id, name: doc.text(p.concat('name')), profile: doc.text(p.concat('profile')), port: portText !== undefined && /^[0-9]+$/.test(portText) ? Number(portText) : undefined, peer: doc.text(p.concat('peer')), broker: doc.text(p.concat('broker')), publish: this.listTexts(p.concat('publish')), subscribe: this.listTexts(p.concat('subscribe')) });
    const iss = doc.issuesAt(p);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const card = this.e('details', { class: 'card app-card' + (errs ? ' has-err' : ''), 'data-card': J(p), 'data-app': id });
    if (this.open.has(J(p))) card.setAttribute('open', '');
    card.appendChild(this.e('summary', {}, [this.e('span', { class: 'card-title' }, [summary]), iss.length ? this.badge(errs, iss.length - errs) : null]));
    const o = 'application';
    card.appendChild(this.field('Id *', this.input(p.concat('id'), 'app-id', id, { required: '' }), p.concat('id'), `Unique on ${dev || 'the device'}; others name it ${dev || 'device'}/${id || 'id'}. Renaming updates them.`));
    const shown = APP_PARAMS.filter((x) => x.key !== 'id' && (!x.when || x.when(v)));
    for (const prm of shown.filter((x) => !x.advanced)) card.appendChild(this.appParamField(p, prm, devIndex, o));
    const adv = shown.filter((x) => x.advanced);
    if (adv.length && v.profile) {
      const ap = p.concat('#advanced');
      const set = adv.filter((x) => doc.get(p.concat(x.key)) !== undefined).length;
      const advErr = adv.some((x) => doc.issuesAt(p.concat(x.key)).some((i) => i.severity === 'error'));
      const box = this.e('details', { class: 'adv-section', 'data-card': J(ap) });
      if (this.open.has(J(ap)) || advErr) box.setAttribute('open', '');
      box.appendChild(this.e('summary', {}, [`Advanced${set ? ` (${set} set)` : ''}`]));
      box.appendChild(this.e('p', { class: 'help' }, ['Sizes, timers and retries: empty fields take the profile’s modelling defaults (shown as their placeholders).']));
      for (const prm of adv) box.appendChild(this.appParamField(p, prm, devIndex, o));
      card.appendChild(box);
    }
    for (const is of iss.filter((x) => !x.key && doc.pathOf(x.node) !== null && J(doc.pathOf(x.node) as Path) === J(p))) card.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    card.appendChild(
      this.e('div', { class: 'app-actions' }, [
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'dup-app', 'data-index': String(devIndex), 'data-k': String(k), title: `Duplicate ${id}` }, ['Duplicate']),
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-app', 'data-index': String(devIndex), 'data-k': String(k), title: `Remove ${id}`, 'aria-label': `Remove the application ${id}` }, ['Remove']),
      ]),
    );
    return card;
  }

  /** A field of an application: its peer and broker with what the model offers, its topic lists; the others as a service's. */
  private appParamField(p: Path, prm: SvcParam, devIndex: number, o: string): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']) || '';
    const fp = p.concat(prm.key);
    const req = typeof prm.required === 'function' ? prm.required(this.valuesAt(p)) : !!prm.required;
    const label = prm.label + (req ? ' *' : '');
    if (prm.key === 'profile') {
      const sel = this.labelledSelect(fp, o, APP_PROFILES.map((x) => [x.id, x.label] as [string, string]), 'Select a profile');
      sel.setAttribute('data-t', 'app-profile');
      const prof = appProfile(doc.text(fp));
      const f = this.field(label, sel, fp, (prof || { help: prm.help }).help);
      if (prof) f.appendChild(supportNote(this.d, prof.support, prof.label));
      return f;
    }
    if (prm.key === 'peer') {
      // the listeners of the other devices this profile can talk to, then the devices
      const prof = appProfile(doc.text(p.concat('profile')));
      const apps: string[] = [];
      for (const d of model ? model.devices : []) for (const a of d.applications || []) if (d.id !== dev && prof && prof.peerProfiles.indexOf(a.profile) >= 0) apps.push(`${d.id}/${a.id}`);
      return this.textField(fp, label, o, 'text', apps.concat(this.ids('device').filter((x) => x !== dev)), prm.help, apps[0] || prm.placeholder);
    }
    if (prm.key === 'broker') {
      const brokers = model ? model.devices.filter((d) => !!d.appServices && d.appServices.has('mqtt_broker')).map((d) => d.id) : [];
      return this.field(label, this.selectEl(fp, 'text', o, brokers, doc.text(fp) || '', brokers.length ? 'Select the broker' : 'No device runs an MQTT broker'), fp, prm.help);
    }
    if (prm.key === 'client_id') return this.textField(fp, label, o, 'text', undefined, prm.help, `${dev}-${doc.text(p.concat('id')) || 'app'}`);
    if (prm.type === 'topics') return this.listField(fp, label, o, prm.placeholder || 'a/topic', prm.help);
    if (prm.key === 'description') return this.textField(fp, label, o, 'textarea', undefined, prm.help);
    return this.svcParamField(p, prm, o, devIndex);
  }

  /**
   * Add service…: every service of the registry not yet there; the ones the
   * device may run are offered, the others listed disabled with the reason
   * (nothing is enabled implicitly, nothing on a Security gateway).
   */
  private addServiceField(sp: Path, devIndex: number, like: DeviceLike): HTMLElement {
    const doc = this.doc;
    const sel = this.e('select', { 'data-t': 'add-service', 'data-p': J(sp), 'data-index': String(devIndex), 'aria-label': 'Add a service', 'aria-describedby': `svc-why-${devIndex}` }) as HTMLSelectElement;
    sel.appendChild(this.e('option', { value: '' }, ['Add service…']));
    const off = this.e('optgroup', { label: 'Not available here' });
    for (const def of SERVICES) {
      if (def.id === 'separation' || doc.get(sp.concat(def.id)) || isBuiltIn(def, like)) continue;
      const why = serviceEligibility(def, like);
      if (why) off.appendChild(this.e('option', { value: def.id, disabled: '' }, [`${def.label} — ${why}`]));
      else sel.appendChild(this.e('option', { value: def.id }, [`${def.label} — ${def.help.replace(/\.$/, '')}`]));
    }
    if (off.childNodes.length) sel.appendChild(off);
    sel.classList.add('unset');
    const f = this.field('Add service', sel, sp, 'Required fields are errors until you fill them in.');
    f.appendChild(this.e('p', { class: 'muted small', id: `svc-why-${devIndex}` }, ['Services it can’t run are listed with the reason.']));
    return f;
  }

  /**
   * A service's card from its parameters' definitions (model/service-registry.ts):
   * a field per parameter by its type, its lists as cards; a remove button
   * unless it is built in.
   */
  private serviceCardGeneric(p: Path, def: SvcDef, devIndex: number, builtIn: boolean): HTMLElement {
    const doc = this.doc;
    const order = def.id;
    const head = this.e('div', { class: 'svc-head' }, [
      this.e('span', { class: 'svc-name' }, [def.label + (builtIn ? ' (built in)' : '')]),
      builtIn ? null : this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'remove-service', 'data-svc': def.id, 'data-index': String(devIndex), title: `Remove ${def.label}`, 'aria-label': `Remove ${def.label}` }, ['×']),
    ]);
    const card = this.e('div', { class: 'svc-card', 'data-svc-card': def.id, role: 'group', 'aria-label': def.label }, [head, this.e('p', { class: 'help' }, [def.help]), supportNote(this.d, def.support, def.label)]);
    if (!doc.get(p)) {
      card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-block', 'data-p': J(p), 'data-what': def.label + ' configuration' }, [`+ Configure ${def.label}`])]));
      return card;
    }
    for (const prm of def.params.filter((x) => !x.advanced)) card.appendChild(this.svcParamField(p, prm, order, devIndex));
    // what is seldom changed (modelling defaults, timers): collapsed until opened, open while one of them has an error
    const adv = def.params.filter((x) => x.advanced && (!x.when || x.when(this.valuesAt(p))));
    if (adv.length) {
      const ap = p.concat('#advanced');
      const set = adv.filter((x) => doc.get(p.concat(x.key)) !== undefined).length;
      const box = this.e('details', { class: 'adv-section', 'data-card': J(ap) });
      if (this.open.has(J(ap)) || adv.some((x) => doc.issuesAt(p.concat(x.key)).some((i) => i.severity === 'error'))) box.setAttribute('open', '');
      box.appendChild(this.e('summary', {}, [`Advanced${set ? ` (${set} set)` : ''}`]));
      for (const prm of adv) box.appendChild(this.svcParamField(p, prm, order, devIndex));
      card.appendChild(box);
    }
    for (const l of def.lists || []) {
      const lp = p.concat(l.key);
      const ln = doc.get(lp);
      const n = ln && ln.kind === 'seq' ? ln.items.length : 0;
      for (let j = 0; j < n; j++) {
        const ip = lp.concat(j);
        const sub = this.e('div', { class: 'svc-card', role: 'group', 'aria-label': `${l.item} ${j + 1}` }, [
          this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, [`${l.item.charAt(0).toUpperCase() + l.item.slice(1)} ${j + 1}`]), this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(ip), title: `Delete this ${l.item}`, 'aria-label': `Delete ${l.item} ${j + 1}` }, ['×'])]),
        ]);
        for (const prm of l.params) sub.appendChild(this.svcParamField(ip, prm, l.key === 'rules' ? 'natRule' : order, devIndex));
        card.appendChild(sub);
      }
      card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(lp), 'data-what': l.item }, [`+ Add ${l.item}`])]));
    }
    return card;
  }

  /** A field for one parameter of a service, by its type. */
  private svcParamField(base: Path, prm: SvcParam, order: string, devIndex: number): HTMLElement {
    const doc = this.doc;
    const p = base.concat(prm.key);
    const req = typeof prm.required === 'function' ? prm.required(this.valuesAt(base)) : !!prm.required;
    const label = prm.label + (req ? ' *' : '');
    const ifaces = doc.interfaceEntries(devIndex).filter((e) => e.id).map((e) => e.id as string);
    switch (prm.type) {
      case 'int':
      case 'port':
        return this.intField(p, label, order, prm.help);
      case 'enum':
        return this.field(label, this.labelledSelect(p, order, (prm.options || []).map((o) => [o.id, o.label]), 'Select'), p, prm.help);
      case 'bool':
        return this.field(label, this.selectEl(p, 'yesno', order, ['true', 'false'], doc.text(p) || '', 'not set'), p, prm.help);
      case 'addresses':
        return this.listField(p, label, order, prm.placeholder || 'an address', prm.help);
      case 'devices':
        return this.chipsField(p, label, this.ids('device').filter((x) => x !== doc.text(['devices', devIndex, 'id'])), prm.help, 'Add a device');
      case 'interfaces':
        return this.chipsField(p, label, ifaces, prm.help, 'Add an interface');
      case 'interface':
        return this.field(label, this.selectEl(p, 'text', order, ifaces, doc.text(p) || '', 'Select interface'), p, prm.help);
      case 'portlist':
        return prm.options ? this.chipsField(p, label, prm.options.map((o) => o.id), prm.help, 'Add') : this.listField(p, label, order, prm.placeholder || 'tcp/443', prm.help);
      default:
        return this.textField(p, label, order, 'text', prm.suggestions ? (prm.suggestions as string[]) : undefined, prm.help, prm.placeholder);
    }
  }

  /** The written scalar values of a map, for the parameters whose need depends on the others. */
  private valuesAt(p: Path): { [k: string]: unknown } {
    const n = this.doc.get(p);
    const out: { [k: string]: unknown } = {};
    if (n && n.kind === 'map') n.entries.forEach((e, k) => (out[k] = scalarText(e.value) !== undefined ? scalarText(e.value) : true));
    return out;
  }

  /**
   * Wireless access: its Wi-Fi networks (SSID, the VLAN it is bridged to or
   * untagged, its radio, its security and a placeholder passphrase), each
   * with its clients; a controller-managed access point's controller. What a
   * network still needs is an error at its field; nothing is chosen for it.
   */
  private wirelessCard(p: Path, devIndex: number, builtIn: boolean): HTMLElement {
    const doc = this.doc;
    const dev = doc.text(['devices', devIndex, 'id']) || '';
    const card = this.e('div', { class: 'svc-card', 'data-svc-card': 'wireless', role: 'group', 'aria-label': 'Wireless access' }, [
      this.e('div', { class: 'svc-head' }, [
        this.e('span', { class: 'svc-name' }, ['Wireless access' + (builtIn ? ' (built in)' : '')]),
        builtIn ? null : this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'remove-service', 'data-svc': 'wireless', 'data-index': String(devIndex), title: 'Remove Wireless access', 'aria-label': 'Remove Wireless access' }, ['×']),
      ]),
      this.e('p', { class: 'help' }, ['Each Wi-Fi network is bridged to its own VLAN; they share the radio and the uplink.']),
      supportNote(this.d, (serviceDef('wireless') as SvcDef).support, 'Wireless access'),
    ]);
    if (!doc.get(p)) {
      card.appendChild(this.e('p', { class: 'field-err' }, ['It needs its Wi-Fi networks: none is chosen for it.']));
      card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-block', 'data-p': J(p), 'data-what': 'Wireless access' }, ['+ Configure Wireless access'])]));
      return card;
    }
    if (doc.text(['devices', devIndex, 'mode']) === 'controller' || doc.get(p.concat('controller'))) {
      const ctls = this.doc.entities('device').filter((d) => !!d.id && !!doc.get(['devices', d.index, 'services', 'wireless_controller'])).map((d) => d.id as string);
      card.appendChild(this.field('Controller *', this.selectEl(p.concat('controller'), 'text', 'wireless', ctls, doc.text(p.concat('controller')) || '', 'Select controller'), p.concat('controller'), 'A device with the Wireless controller service.'));
    }
    const radios = doc.interfaceEntries(devIndex).filter((e) => e.kind === 'interface' && e.id).map((e) => e.id as string);
    const lp = p.concat('networks');
    const ln = doc.get(lp);
    const n = ln && ln.kind === 'seq' ? ln.items.length : 0;
    for (let j = 0; j < n; j++) {
      const np = lp.concat(j);
      const id = doc.text(np.concat('id')) || '';
      const ssid = doc.text(np.concat('ssid')) || '';
      const clients = id ? doc.networkClients(dev, id) : [];
      const sec = doc.text(np.concat('security')) || '';
      const secret = (WIFI_SECURITY.find((x) => x.id === sec) || { secret: false }).secret;
      const sub = this.e('div', { class: 'svc-card wifi-card', role: 'group', 'aria-label': `Wi-Fi network ${ssid || id || j + 1}` }, [
        this.e('div', { class: 'svc-head' }, [
          this.e('span', { class: 'svc-name' }, [`Wi-Fi network ${ssid ? `“${ssid}”` : id || j + 1}`]),
          this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-wifi', 'data-p': J(np), 'data-index': String(devIndex), title: 'Delete this Wi-Fi network', 'aria-label': `Delete Wi-Fi network ${ssid || id || j + 1}` }, ['×']),
        ]),
        this.textField(np.concat('id'), 'Id *', 'wirelessNetwork', 'text', undefined, 'Its connections name it (SSIDs need not be unique).', 'staff'),
        this.textField(np.concat('ssid'), 'SSID *', 'wirelessNetwork', 'text', undefined, 'The name clients see (at most 32 characters).', 'Staff'),
        this.intField(np.concat('vlan'), doc.get(np.concat('untagged')) ? 'VLAN' : 'VLAN *', 'wirelessNetwork', 'The VLAN it is bridged to; never chosen for you.'),
        this.field('Untagged', this.selectEl(np.concat('untagged'), 'yesno', 'wirelessNetwork', ['true'], doc.text(np.concat('untagged')) || '', 'no'), np.concat('untagged'), 'Bridged to the uplink’s untagged VLAN instead.'),
        this.field('Radio *', this.selectEl(np.concat('radio'), 'text', 'wirelessNetwork', radios, doc.text(np.concat('radio')) || '', 'Select radio'), np.concat('radio'), 'A physical interface of the device.'),
        this.field('Security *', this.labelledSelect(np.concat('security'), 'wirelessNetwork', WIFI_SECURITY.map((x) => [x.id, x.label]), 'Select security'), np.concat('security'), 'Not chosen for you.'),
        secret || doc.get(np.concat('passphrase')) ? this.textField(np.concat('passphrase'), 'Passphrase *', 'wirelessNetwork', 'text', undefined, 'A placeholder, never the passphrase itself.', '<guest-psk>') : null,
        doc.text(['devices', devIndex, 'mode']) === 'controller' || doc.get(np.concat('forwarding')) ? this.field('Forwarding', this.selectEl(np.concat('forwarding'), 'text', 'wirelessNetwork', ['local', 'tunneled'], doc.text(np.concat('forwarding')) || '', 'local (not written)'), np.concat('forwarding'), 'Tunneled to the controller is not simulated.') : null,
        this.derivedField('Clients', 'wifi-clients', clients.length ? clients.map((x) => this.e('button', { type: 'button', class: 'ref', 'data-goto': 'link:' + x }, [x])).reduce((acc: Array<HTMLElement | string>, b, k) => acc.concat(k ? [', ', b] : [b]), []) : [this.e('span', { class: 'muted' }, ['none yet'])], 'Its wireless connections (each names this network).'),
      ]);
      card.appendChild(sub);
    }
    card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(lp), 'data-what': 'Wi-Fi network' }, ['+ Add Wi-Fi network'])]));
    return card;
  }

  // ------------------------------------------------- virtualization: guests, Hypervisor, Container engine

  /** A select of id / label pairs (the label shown, the id written), '' first; a value not offered is kept and marked. */
  private pairSelect(p: Path, order: string, opts: ReadonlyArray<{ id: string; label: string }>, empty: string, aria: string, t = 'text'): HTMLSelectElement {
    const cur = this.doc.text(p) || '';
    const sel = this.e('select', { 'data-p': J(p), 'data-t': t, 'data-o': order, 'aria-label': aria }) as HTMLSelectElement;
    sel.appendChild(this.e('option', { value: '' }, [empty]));
    if (cur && !opts.some((x) => x.id === cur)) sel.appendChild(this.e('option', { value: cur }, [cur + ' (not offered)']));
    for (const x of opts) sel.appendChild(this.e('option', { value: x.id }, [x.label]));
    sel.value = cur;
    if (!cur) sel.classList.add('unset');
    return sel;
  }

  /**
   * A guest's host: a picker that offers only the devices that can run it
   * (a VM: servers with the Hypervisor service; a container: servers and
   * VMs with the Container engine service). Required: nothing is chosen.
   */
  private hostField(base: Path, devIndex: number): HTMLElement {
    const doc = this.doc;
    const type = doc.text(base.concat('type')) || '';
    const self = doc.text(base.concat('id')) || '';
    // a cloud instance: in a cloud region, VPC or VNet, on the provider's hosts (not modelled)
    const md = doc.result.model ? doc.result.model.index.devices.get(self) : undefined;
    if (md && md.cloudInstance && !doc.get(base.concat('host'))) return this.derivedField('Host', 'cloud-instance', [this.e('span', { class: 'muted' }, ['none: a cloud instance'])], 'In a cloud group, on the provider’s hosts (not modelled).');
    const opts: Array<{ id: string; label: string }> = [];
    doc.entities('device').forEach((d) => {
      if (!d.id || d.id === self) return;
      const t = doc.text(['devices', d.index, 'type']) || '';
      const ok = isVm({ type: type }) ? mayHostVms({ type: t }) && !!doc.get(['devices', d.index, 'services', 'hypervisor']) : mayHostContainers({ type: t }) && !!doc.get(['devices', d.index, 'services', 'container_engine']);
      const label = doc.text(['devices', d.index, 'label']);
      if (ok) opts.push({ id: d.id, label: label && label !== d.id ? `${label} (${d.id})` : d.id });
    });
    const what = isVm({ type: type }) ? 'a server with the Hypervisor service' : 'a server or a VM with the Container engine service';
    const f = this.field('Host *', this.pairSelect(base.concat('host'), 'device', opts, 'Select its host', `Host of ${self}`), base.concat('host'), `What it runs on: ${what}. Its network goes through the host; its location is the host’s.${opts.length ? '' : ' No device has that service yet: enable it on a server first.'}`);
    void devIndex;
    return f;
  }

  /** A guest's location: its host's (derived). */
  private guestLocationField(base: Path): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const self = doc.text(base.concat('id')) || '';
    const d = model ? model.index.devices.get(self) : undefined;
    const h = model && d ? hostOf(model, d) : undefined;
    const g = d && d.group && model ? model.index.groups.get(d.group) : undefined;
    return this.derivedField(
      'Group / location',
      'guest-location',
      [h ? (g ? this.e('button', { type: 'button', class: 'ref', 'data-goto': 'group:' + g.id }, [g.label]) : this.e('span', { class: 'muted' }, ['none'])) : this.e('span', { class: 'muted' }, ['(its host’s, once it has one)']), h ? this.e('span', { class: 'muted' }, [' — from its host ']) : null, h ? this.e('button', { type: 'button', class: 'ref', 'data-goto': 'device:' + h.id }, [h.label]) : null],
      'A guest is where its host is: set the host’s location.',
    );
  }

  /** The guests a host runs (VMs or containers), each a link, and the button that adds one already assigned to it. */
  private guestsField(hostId: string, devIndex: number, type: 'vm' | 'container'): HTMLElement {
    const doc = this.doc;
    const guests = doc.guestsOfHost(hostId).filter((x) => x.type === type);
    const what = isVm({ type: type }) ? 'VMs' : 'Containers';
    const list = guests.length
      ? this.e('ul', { class: 'derived-list guests' }, guests.map((x) => this.e('li', {}, [this.e('button', { type: 'button', class: 'ref', 'data-goto': 'device:' + x.id }, [x.id])])))
      : this.e('span', { class: 'muted' }, [`No ${what.toLowerCase()} run on it yet.`]);
    const addText = `Add a ${isVm({ type: type }) ? 'VM' : 'container'} that runs on ${hostId}`;
    const add = this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-guest', 'data-type': type, 'data-index': String(devIndex), title: addText, 'aria-label': addText }, [isVm({ type: type }) ? '+ VM' : '+ Container']);
    return this.e('div', { class: 'field derived', 'data-derived': `guests-${type}` }, [
      this.e('label', {}, [`${what} on this host (${guests.length}) `, this.e('span', { class: 'derived-tag', title: 'The guests whose host is this device' }, ['derived'])]),
      this.e('div', { class: 'derived-body' }, [list]),
      this.e('div', { class: 'guest-add' }, [add]),
    ]);
  }

  /**
   * The Hypervisor service: its platform, HA cluster and inventory, the
   * VMs it runs, its virtual switches (each with uplinks, teaming, MTU and
   * port groups) and its Simulation subsection; a collapsible card.
   */
  private hypervisorCard(hp: Path, dev: string, devIndex: number): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const o = 'hypervisor';
    const iss = doc.issuesAt(hp);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const plat = HV_PLATFORMS.find((x) => x.id === doc.text(hp.concat('platform')));
    const card = this.e('details', { class: 'card svc-card', 'data-card': J(hp), 'data-svc-card': 'hypervisor' });
    if (this.open.has(J(hp)) || errs) card.setAttribute('open', '');
    const vsN = doc.get(hp.concat('vswitches'));
    const vsItems = vsN && vsN.kind === 'seq' ? vsN.items : [];
    card.appendChild(this.e('summary', {}, [this.e('span', { class: 'card-title' }, [['Hypervisor', plat ? plat.label : '(no platform)', doc.text(hp.concat('cluster')) ? `cluster ${doc.text(hp.concat('cluster'))}` : '', `${vsItems.length} virtual switch${vsItems.length === 1 ? '' : 'es'}`].filter((x) => x).join(' · ')]), iss.length ? this.badge(errs, iss.length - errs) : null]));
    for (const is of doc.issuesAt(hp, false).filter((x) => !x.key)) card.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    card.appendChild(this.field('Platform *', this.pairSelect(hp.concat('platform'), o, HV_PLATFORMS, 'Select the platform', `Hypervisor platform of ${dev}`), hp.concat('platform')));
    const clusters = model ? Array.from(new Set(model.devices.filter((d) => d.hypervisor && d.hypervisor.cluster).map((d) => (d.hypervisor as { cluster: string }).cluster))).sort() : [];
    card.appendChild(this.textField(hp.concat('cluster'), 'HA cluster', o, 'text', clusters, 'Hypervisors with the same cluster name restart each other’s VMs.', 'none'));
    card.appendChild(this.intField(hp.concat('cpu'), 'CPU cores', o, 'Inventory; compared with its VMs’ vCPUs when both are given (info).'));
    card.appendChild(this.textField(hp.concat('ram'), 'Memory', o, 'text', undefined, 'Inventory, e.g. 512G.', '512G'));
    const vp = hp.concat('vswitches');
    vsItems.forEach((_it, k) => card.appendChild(this.vswitchCard(vp.concat(k), dev, devIndex, k)));
    card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(vp), 'data-what': 'virtual switch' }, ['+ Add virtual switch'])]));
    const sim = this.simSection({ path: hp, device: dev, at: hvRef(dev), idBase: `hv-${dev}`, what: 'the Hypervisor', name: `${dev} Hypervisor` }, serviceParams('hypervisor'));
    if (sim) card.appendChild(sim);
    return card;
  }

  /** A virtual switch: name, type, uplinks (the host's ports and bonds), teaming, MTU, its port groups; its Simulation subsection. */
  private vswitchCard(vp: Path, dev: string, devIndex: number, k: number): HTMLElement {
    const doc = this.doc;
    const o = 'vswitch';
    const name = doc.text(vp.concat('name')) || '';
    const iss = doc.issuesAt(vp);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const card = this.e('details', { class: 'card' + (errs ? ' has-err' : ''), 'data-card': J(vp), 'data-vswitch': name });
    if (this.open.has(J(vp)) || errs) card.setAttribute('open', '');
    const ups = this.listTexts(vp.concat('uplinks'));
    card.appendChild(
      this.e('summary', {}, [
        this.e('span', { class: 'card-title' }, [[name || `Virtual switch ${k + 1}`, (VSWITCH_TYPES.find((x) => x.id === doc.text(vp.concat('type'))) || { label: '' }).label, ups.length ? `uplinks ${ups.join(', ')}` : 'internal'].filter((x) => x).join(' · ')]),
        iss.length ? this.badge(errs, iss.length - errs) : null,
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(vp), title: 'Delete this virtual switch' }, ['×']),
      ]),
    );
    card.appendChild(this.textField(vp.concat('name'), 'Name *', o, 'text', undefined, 'Unique on this host, e.g. vSwitch0 or br0.', 'vSwitch0'));
    card.appendChild(this.field('Type *', this.pairSelect(vp.concat('type'), o, VSWITCH_TYPES, 'Select the type', `Type of virtual switch ${name || k + 1}`), vp.concat('type')));
    // uplinks: the host's ports and bonds, in order (active / standby: the first is active)
    const ports = doc.interfaceEntries(devIndex).filter((e) => !!e.id && (e.kind === 'interface' || !!doc.get(e.path.concat('members')))).map((e) => e.id as string);
    const used = new Set<string>();
    const vsl = doc.get(vp.slice(0, -1));
    if (vsl && vsl.kind === 'seq') vsl.items.forEach((_x, j) => this.listTexts(vp.slice(0, -1).concat(j, 'uplinks')).forEach((u) => used.add(u)));
    const ubox = this.e('div', { class: 'list-ed uplinks' });
    ups.forEach((u, j) =>
      ubox.appendChild(
        this.e('div', { class: 'list-row' }, [
          this.e('span', { class: 'uplink-order muted' }, [`${j + 1}.`]),
          this.e('span', {}, [u]),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(this.doc.get(vp.concat('uplinks'))?.kind === 'seq' ? vp.concat('uplinks', j) : vp.concat('uplinks')), 'aria-label': `Remove uplink ${u} from ${name || 'the virtual switch'}`, title: 'Remove this uplink' }, ['×']),
        ]),
      ),
    );
    const addSel = this.e('select', { 'data-p': J(vp.concat('uplinks')), 'data-t': 'list-append', 'data-o': o, 'aria-label': `Add an uplink to ${name || 'the virtual switch'}` }) as HTMLSelectElement;
    addSel.appendChild(this.e('option', { value: '' }, ['+ add an uplink (a port or bond)']));
    for (const x of ports) if (!used.has(x)) addSel.appendChild(this.e('option', { value: x }, [x]));
    ubox.appendChild(addSel);
    card.appendChild(this.field('Uplinks', ubox, vp.concat('uplinks'), 'The host’s ports or bonds that carry its port groups; none: an internal switch. Active / standby: in this order.'));
    if (ups.length || doc.get(vp.concat('teaming'))) card.appendChild(this.field('Teaming *', this.pairSelect(vp.concat('teaming'), o, TEAMINGS, 'Select the teaming', `Teaming of ${name || 'the virtual switch'}`), vp.concat('teaming'), 'LACP needs one bond as its uplink.'));
    card.appendChild(this.intField(vp.concat('mtu'), 'MTU (bytes)', o, 'Empty: not modelled.'));
    // its port groups
    const pp = vp.concat('port_groups');
    const pn = doc.get(pp);
    const pbox = this.e('div', { class: 'list-ed port-groups' });
    (pn && pn.kind === 'seq' ? pn.items : []).forEach((_it, j) => pbox.appendChild(this.portGroupRow(pp.concat(j), dev, j)));
    pbox.appendChild(this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(pp), 'data-what': 'port group' }, ['+ Add port group']));
    card.appendChild(this.field('Port groups *', pbox, pp, 'Each with its VLAN mode, as on a port: one VLAN (access), several (a trunk, with a native VLAN), or guest tagging.'));
    const sim = name ? this.simSection({ path: vp, device: dev, at: vswRef(dev, name), idBase: `vsw-${dev}-${name}`, what: `virtual switch ${name}`, name: `${dev} ${name}` }, serviceParams('vswitch')) : null;
    if (sim) card.appendChild(sim);
    return card;
  }

  /** A port group: its name, VLANs (or guest tagging), native VLAN; the vnics on it (derived). */
  private portGroupRow(pp: Path, dev: string, j: number): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const name = doc.text(pp.concat('name')) || '';
    const gt = doc.text(pp.concat('guest_tagging')) === 'true';
    const vl = doc.portVlans(pp);
    const label = name || `port group ${j + 1}`;
    const uid = `pg-${dev}-${j}-${Math.random().toString(36).slice(2, 7)}`;
    const box = this.e('input', { type: 'checkbox', id: uid, 'data-act': 'pg-guest', 'data-p': J(pp) }) as HTMLInputElement;
    box.checked = gt;
    const nat = vl.length > 1 || doc.get(pp.concat('native'));
    const host = model ? model.index.devices.get(dev) : undefined;
    const pg = host && host.hypervisor ? host.hypervisor.vswitches.reduce((a: unknown, v) => a || v.portGroups.find((x) => x.name === name), undefined as unknown) : undefined;
    const on = model && host && name ? portGroupAttachments(model, host, name) : [];
    const row = this.e('div', { class: 'pg-row' + (doc.issuesAt(pp).some((i) => i.severity === 'error') ? ' invalid' : ''), 'data-pg': name }, [
      this.e('div', { class: 'list-row' }, [
        this.input(pp.concat('name'), 'text', name, { placeholder: 'name (Servers)', 'aria-label': `Port group ${j + 1}: name`, 'data-o': 'portGroup' }),
        this.input(pp.concat('vlans'), 'pg-vlans', vl.join(', '), gt ? { placeholder: '(the guests tag)', disabled: '', 'aria-label': `${label}: VLANs` } : { placeholder: 'VLANs: 10 or 10, 20', 'aria-label': `${label}: VLANs (one: access; several: a trunk)` }),
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(pp), 'aria-label': `Delete ${label}`, title: 'Delete this port group' }, ['×']),
      ]),
      this.e('div', { class: 'list-row' }, [
        this.e('label', { class: 'check', for: uid }, [box, ' Guest tagging (VGT)']),
        nat
          ? this.pairSelect(pp.concat('native'), 'portGroup', [{ id: '', label: '' }].slice(1).concat(vl.filter((x) => /^[0-9]+$/.test(x)).map((x) => ({ id: x, label: `native VLAN ${x}` }))), 'no native VLAN (all tagged)', `${label}: native VLAN`, 'vlan-native')
          : null,
        pg ? this.e('span', { class: 'mode-badge mode-' + (gt ? 'trunk' : vl.length > 1 ? 'trunk' : 'access') }, [portGroupText(pg as never)]) : null,
      ]),
      on.length ? this.e('div', { class: 'muted small' }, [`On it: ${on.map((i) => `${i.device}:${i.id}`).join(', ')}`]) : null,
    ]);
    for (const is of doc.issuesAt(pp)) row.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return row;
  }

  /** The Container engine service: its engine, the containers it runs, its networks; its Simulation subsection. */
  private engineCard(ep: Path, dev: string, devIndex: number): HTMLElement {
    const doc = this.doc;
    const o = 'containerEngine';
    const iss = doc.issuesAt(ep);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const eng = CONTAINER_ENGINES.find((x) => x.id === doc.text(ep.concat('engine')));
    const card = this.e('details', { class: 'card svc-card', 'data-card': J(ep), 'data-svc-card': 'container_engine' });
    if (this.open.has(J(ep)) || errs) card.setAttribute('open', '');
    const nN = doc.get(ep.concat('networks'));
    const nItems = nN && nN.kind === 'seq' ? nN.items : [];
    card.appendChild(this.e('summary', {}, [this.e('span', { class: 'card-title' }, [['Container engine', eng ? eng.label : '(no engine)', `${nItems.length} network${nItems.length === 1 ? '' : 's'}`].join(' · ')]), iss.length ? this.badge(errs, iss.length - errs) : null]));
    for (const is of doc.issuesAt(ep, false).filter((x) => !x.key)) card.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    card.appendChild(this.field('Engine *', this.pairSelect(ep.concat('engine'), o, CONTAINER_ENGINES, 'Select the engine', `Container engine of ${dev}`), ep.concat('engine'), 'Kubernetes pods, services and CNI plugins are not modelled.'));
    const np = ep.concat('networks');
    nItems.forEach((_it, k) => card.appendChild(this.cnetCard(np.concat(k), dev, devIndex, k)));
    card.appendChild(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(np), 'data-what': 'container network' }, ['+ Add container network'])]));
    const sim = this.simSection({ path: ep, device: dev, at: ceRef(dev), idBase: `ce-${dev}`, what: 'the Container engine', name: `${dev} Container engine` }, serviceParams('container_engine'));
    if (sim) card.appendChild(sim);
    return card;
  }

  /** A container network: name, driver, and what the driver needs (bridge interface, subnet, gateway, NAT, parent, mode, hosts, range). */
  private cnetCard(np: Path, dev: string, devIndex: number, k: number): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const o = 'containerNetwork';
    const name = doc.text(np.concat('name')) || '';
    const driver = doc.text(np.concat('driver')) || '';
    const iss = doc.issuesAt(np);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const card = this.e('details', { class: 'card' + (errs ? ' has-err' : ''), 'data-card': J(np), 'data-cnet': name });
    if (this.open.has(J(np)) || errs) card.setAttribute('open', '');
    card.appendChild(
      this.e('summary', {}, [
        this.e('span', { class: 'card-title' }, [[name || `Network ${k + 1}`, driver, doc.text(np.concat('subnet')) || ''].filter((x) => x).join(' · ')]),
        iss.length ? this.badge(errs, iss.length - errs) : null,
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(np), title: 'Delete this container network' }, ['×']),
      ]),
    );
    card.appendChild(this.textField(np.concat('name'), 'Name *', o, 'text', undefined, 'Unique on this host; its containers name it.', 'bridge'));
    card.appendChild(this.field('Driver *', this.pairSelect(np.concat('driver'), o, CONTAINER_DRIVERS, 'Select the driver', `Driver of container network ${name || k + 1}`), np.concat('driver')));
    const has = (key: string): boolean => !!doc.get(np.concat(key));
    if (driver === 'bridge' || has('interface')) card.appendChild(this.withHelpers(this.textField(np.concat('interface'), 'Bridge interface *', o, 'text', undefined, 'The interface it creates on the host, with the gateway address.', 'docker0'), np.concat('interface'), 'text', has('interface') ? [] : [{ value: 'docker0', label: 'docker0', title: 'Docker’s default bridge' }, { value: `br-${name || 'net'}`.slice(0, 15), label: `br-${name || 'net'}`.slice(0, 15), title: 'A user-defined bridge' }], 'bridge interface', `${dev} ${name}`.trim()));
    if (['bridge', 'macvlan', 'ipvlan', 'overlay'].indexOf(driver) >= 0 || has('subnet')) card.appendChild(this.textField(np.concat('subnet'), 'Subnet *', o, 'text', undefined, undefined, driver === 'bridge' ? '172.17.0.0/16' : '10.10.0.0/24'));
    if (['bridge', 'macvlan', 'ipvlan', 'overlay'].indexOf(driver) >= 0 || has('gateway')) card.appendChild(this.textField(np.concat('gateway'), driver === 'overlay' ? 'Gateway' : 'Gateway *', o, 'text', undefined, driver === 'bridge' ? 'The bridge interface’s address on the host.' : 'The router’s address in the subnet.', driver === 'bridge' ? '172.17.0.1' : '10.10.0.1'));
    if (driver === 'bridge' || has('nat')) {
      const nsel = this.e('select', { 'data-p': J(np.concat('nat')), 'data-t': 'yesno', 'data-o': o, 'aria-label': `NAT of container network ${name}` }) as HTMLSelectElement;
      for (const [v, l] of [['', 'Select'], ['true', 'On: masquerade to the host’s address'], ['false', 'Off: routed']]) nsel.appendChild(this.e('option', { value: v }, [l]));
      nsel.value = doc.text(np.concat('nat')) || '';
      if (!nsel.value) nsel.classList.add('unset');
      card.appendChild(this.field('NAT *', nsel, np.concat('nat'), 'Published ports are forwarded to its containers (DNAT).'));
    }
    if (driver === 'macvlan' || driver === 'ipvlan' || has('parent')) {
      const parents = doc.interfaceEntries(devIndex).filter((e) => !!e.id).map((e) => ({ id: e.id as string, label: e.id as string }));
      card.appendChild(this.field('Parent interface *', this.pairSelect(np.concat('parent'), o, parents, 'Select the parent', `Parent interface of container network ${name}`), np.concat('parent'), 'The host interface it sits on: a port, a bond, a VLAN subinterface (on a VM: its vNIC).'));
      const modes = (driver === 'ipvlan' ? IPVLAN_MODES : MACVLAN_MODES).map((m) => ({ id: m, label: m }));
      card.appendChild(this.field('Mode *', this.pairSelect(np.concat('mode'), o, modes, 'Select the mode', `Mode of container network ${name}`), np.concat('mode')));
    }
    if (driver === 'overlay' || has('hosts')) card.appendChild(this.listField(np.concat('hosts'), 'Other hosts', o, 'docker-02', 'The other container engines that take part; their containers can attach to it too.'));
    if (['bridge', 'macvlan', 'ipvlan', 'overlay'].indexOf(driver) >= 0 || has('range')) card.appendChild(this.textField(np.concat('range'), 'Address range (IPAM)', o, 'text', undefined, 'start-end: where the next free address of a container is taken from; empty: the subnet.', '172.17.0.100-172.17.0.199'));
    // derived: the bridge interface it creates, the containers on it
    const owner = model ? model.index.devices.get(dev) : undefined;
    const net = owner && owner.containerEngine ? owner.containerEngine.networks.find((x) => x.name === name) : undefined;
    if (net && net.driver === 'bridge' && net.iface && net.gateway && net.subnet) card.appendChild(this.derivedField('Creates on the host', 'bridge-iface', [`${net.iface} with ${net.gateway}/${net.subnet.split('/')[1]}${net.nat ? ' (NAT)' : ''}`], 'Never written: it follows from the network.'));
    if (net && model && owner) {
      const on = model.devices.filter((d) => isContainer(d)).reduce((a: string[], d) => a.concat(d.logical.filter((i) => i.type === 'veth' && (vethNetwork(model, i) || { net: null }).net === net).map((i) => `${d.id}:${i.id}`)), []);
      card.appendChild(this.derivedField('Containers on it', 'cnet-containers', [on.length ? on.join(', ') : this.e('span', { class: 'muted' }, ['none yet'])], 'Their network attachments name it.'));
    }
    return card;
  }

  /** A vnic: its port group on the host (or a host port by passthrough, with an SR-IOV virtual function), a host interface's role. */
  private vnicFields(devIndex: number, p: Path, id: string): HTMLElement[] {
    const doc = this.doc;
    const model = doc.result.model;
    const out: HTMLElement[] = [];
    const dtype = doc.text(['devices', devIndex, 'type']) || '';
    const devId = doc.text(['devices', devIndex, 'id']) || '';
    const hostId = isVm({ type: dtype }) ? doc.text(['devices', devIndex, 'host']) || '' : devId;
    const hi = doc.entities('device').find((d) => d.id === hostId);
    const hp: Path | null = hi ? ['devices', hi.index, 'services', 'hypervisor', 'vswitches'] : null;
    // the port groups the host provides
    const pgs: Array<{ id: string; label: string }> = [];
    const hm = model && hostId ? model.index.devices.get(hostId) : undefined;
    if (hm && hm.hypervisor) {
      for (const vs of hm.hypervisor.vswitches) for (const pg of vs.portGroups) if (pg.name) pgs.push({ id: pg.name, label: `${pg.name} (${vs.name} · ${portGroupText(pg)})` });
    } else if (hp) {
      const vl = doc.get(hp);
      if (vl && vl.kind === 'seq') vl.items.forEach((_v, k) => {
        const pl = doc.get(hp.concat(k, 'port_groups'));
        if (pl && pl.kind === 'seq') pl.items.forEach((_x, j) => {
          const nm = doc.text(hp.concat(k, 'port_groups', j, 'name'));
          if (nm) pgs.push({ id: nm, label: nm });
        });
      });
    }
    const pt = !!doc.get(p.concat('passthrough'));
    // suggestions: the port groups of the VLAN its address is in (untagged on the port group)
    const iface = model ? model.index.interfaces.get(devId + ':' + id) : undefined;
    const vlans = new Set<number>();
    if (model && iface) for (const a of iface.addresses) for (const n of containingNetworks(a, model.networks)) if (n.vlan !== undefined) vlans.add(n.vlan);
    const fits: Suggestion[] = [];
    if (hm && hm.hypervisor && vlans.size) {
      for (const vs of hm.hypervisor.vswitches) {
        for (const pg of vs.portGroups) {
          const u = portGroupL2(pg).untagged;
          if (pg.name && u !== undefined && vlans.has(u) && pg.name !== (iface ? iface.portGroup : undefined)) fits.push({ value: pg.name, label: pg.name, title: `${pg.name} on ${vs.name} carries VLAN ${u} untagged: the VLAN of its address` });
        }
      }
    }
    if (!pt) out.push(this.withHelpers(this.field('Port group *', this.pairSelect(p.concat('port_group'), 'logical', pgs, hostId ? 'Select its port group' : 'Choose the host first', `Port group of ${devId} ${id}`), p.concat('port_group'), hostId ? `On ${hostId}’s virtual switches; its VLAN comes from the port group.` : 'The host’s port groups are offered once the host is set.'), p.concat('port_group'), 'text', fits, 'port group', `${devId} ${id}`));
    if (isVm({ type: dtype })) {
      // passthrough: one of the host's ports that no virtual switch uses
      const uplinks = new Set<string>();
      if (hm && hm.hypervisor) for (const vs of hm.hypervisor.vswitches) for (const u of vs.uplinks) uplinks.add(u);
      const ports = hm ? hm.interfaces.filter((i) => !uplinks.has(i.id)).map((i) => ({ id: i.id, label: i.id })) : [];
      if (pt || ports.length) {
        out.push(this.field('Passthrough port', this.pairSelect(p.concat('passthrough'), 'logical', ports, pt ? '(none)' : 'none: on a port group', `Passthrough port of ${devId} ${id}`), p.concat('passthrough'), 'Bound directly to this host port (exclusive; no port group).'));
        if (pt || doc.get(p.concat('vf'))) out.push(this.intField(p.concat('vf'), 'SR-IOV virtual function', 'logical', 'Empty: the whole port.'));
      }
    } else if (mayHostVms({ type: dtype })) {
      out.push(this.field('Role', this.pairSelect(p.concat('role'), 'logical', HOST_IFACE_ROLES.map((r) => ({ id: r, label: r })), 'none', `Role of host interface ${id}`), p.concat('role'), 'What the host uses it for (management, migration, storage).'));
    }
    return out;
  }

  /** A veth: its container network on the host (or an overlay that lists the host), the next free address, aliases, published ports. */
  private vethFields(devIndex: number, p: Path, id: string): HTMLElement[] {
    const doc = this.doc;
    const model = doc.result.model;
    const out: HTMLElement[] = [];
    const devId = doc.text(['devices', devIndex, 'id']) || '';
    const hostId = doc.text(['devices', devIndex, 'host']) || '';
    const nets = model && hostId ? containerNetworks(model, hostId) : [];
    const opts = nets.map((x) => ({ id: x.net.name, label: `${x.net.name} (${x.net.driver || '?'}${x.net.subnet ? ' · ' + x.net.subnet : ''}${x.owner.id !== hostId ? ` · overlay of ${x.owner.id}` : ''})` }));
    out.push(this.field('Container network *', this.pairSelect(p.concat('network'), 'logical', opts, hostId ? 'Select its network' : 'Choose the host first', `Container network of ${devId} ${id}`), p.concat('network'), hostId ? `A network of ${hostId}’s container engine.` : 'The host’s networks are offered once the host is set.'));
    // the next free address of its network (from its IPAM range)
    const cur = doc.text(p.concat('network'));
    const net = nets.find((x) => x.net.name === cur);
    if (net && model && !this.listTexts(p.concat('ip')).length && ['bridge', 'macvlan', 'ipvlan', 'overlay'].indexOf(net.net.driver || '') >= 0) {
      const next = nextFreeContainerAddr(model, net.net);
      if (next) {
        out.push(
          this.e('div', { class: 'field' }, [
            this.e('div', { class: 'helpers', role: 'group', 'aria-label': `Suggestions for the address of ${devId} ${id}` }, [
              this.e('button', { type: 'button', class: 'chip helper', 'data-act': 'set-value', 'data-p': J(p.concat('ip')), 'data-kind': 'text', 'data-v': next, title: `The next free address of ${net.net.name}${net.net.range ? ` (range ${net.net.range})` : ''}`, 'aria-label': `Set the address of ${devId} ${id} to the next free one, ${next}` }, [`Next free: ${next}`]),
            ]),
          ]),
        );
      }
    }
    out.push(this.listField(p.concat('aliases'), 'Aliases', 'logical', 'db', 'Further names of the container on its network.'));
    // published ports (a bridge network's)
    const pp = p.concat('publish');
    const pn = doc.get(pp);
    if ((net && net.net.driver === 'bridge') || pn) {
      const box = this.e('div', { class: 'list-ed publish' });
      (pn && pn.kind === 'seq' ? pn.items : []).forEach((_it, j) => {
        const ip = pp.concat(j);
        const proto = this.e('select', { 'data-p': J(ip.concat('protocol')), 'data-t': 'text', 'data-o': 'published', 'aria-label': `Published port ${j + 1}: protocol` }) as HTMLSelectElement;
        for (const x of ['', 'tcp', 'udp']) proto.appendChild(this.e('option', { value: x }, [x || 'protocol']));
        proto.value = doc.text(ip.concat('protocol')) || '';
        box.appendChild(
          this.e('div', { class: 'list-row pub-row' + (doc.issuesAt(ip).some((i) => i.severity === 'error') ? ' invalid' : '') }, [
            this.input(ip.concat('host_ip'), 'text', doc.text(ip.concat('host_ip')) || '', { placeholder: 'host address (all)', 'aria-label': `Published port ${j + 1}: host address`, 'data-o': 'published' }),
            this.input(ip.concat('host_port'), 'int', doc.text(ip.concat('host_port')) || '', { placeholder: 'host port', inputmode: 'numeric', 'aria-label': `Published port ${j + 1}: host port`, 'data-o': 'published' }),
            this.e('span', { 'aria-hidden': 'true' }, [' → ']),
            this.input(ip.concat('port'), 'int', doc.text(ip.concat('port')) || '', { placeholder: 'container port', inputmode: 'numeric', 'aria-label': `Published port ${j + 1}: container port`, 'data-o': 'published' }),
            proto,
            this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove this published port' }, ['×']),
          ]),
        );
        for (const is of doc.issuesAt(ip)) box.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      });
      box.appendChild(this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(pp), 'data-what': 'published port' }, ['+ Publish a port']));
      out.push(this.field('Published ports', box, pp, 'Accepted on the host’s address and forwarded to the container (DNAT); a bridge network’s.'));
    }
    return out;
  }

  /** The MAC prefix of a guest's platform, for the Generate helper (a VM: its host's hypervisor; a container: Docker's). */
  private platformOuiOf(devIndex: number, kind: string): { oui: number[]; name: string } | undefined {
    const doc = this.doc;
    if (kind === 'veth') return platformOui('docker');
    if (kind !== 'vnic') return undefined;
    const t = doc.text(['devices', devIndex, 'type']);
    const hostId = isVm({ type: t || '' }) ? doc.text(['devices', devIndex, 'host']) : doc.text(['devices', devIndex, 'id']);
    const hi = doc.entities('device').find((d) => d.id === hostId);
    return hi ? platformOui(doc.text(['devices', hi.index, 'services', 'hypervisor', 'platform'])) : undefined;
  }

  /** A DHCP scope: its network, range, gateway, DNS servers, lease time, exclusions, reservations, domain; its Simulation subsection. */
  private scopeCard(p: Path, dev: string, k: number, model: Model | null): HTMLElement {
    const doc = this.doc;
    const o = 'dhcpScope';
    const net = doc.text(p.concat('network')) || '';
    const range = doc.text(p.concat('range')) || '';
    const iss = doc.issuesAt(p);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const card = this.e('details', { class: 'card' + (errs ? ' has-err' : ''), 'data-card': J(p) });
    if (this.open.has(J(p)) || errs) card.setAttribute('open', '');
    card.appendChild(this.e('summary', {}, [this.e('span', { class: 'card-title' }, [[`Scope ${k + 1}`, net || '(no network)', range].filter((x) => x).join(' · ')]), iss.length ? this.badge(errs, iss.length - errs) : null, this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(p), title: 'Delete this scope' }, ['×'])]));
    const v4nets = model ? model.networks.filter((x) => !!x.cidr && x.cidr.indexOf(':') < 0).map((x) => x.id) : [];
    card.appendChild(this.refField(p.concat('network'), 'Network *', o, v4nets, 'The network it leases addresses in (an IPv4 network of the model).'));
    const sug = model && net ? scopeSuggestions(model, net) : { range: [], gateway: [], dns: [] };
    const owner = `${dev} scope ${k + 1}`;
    card.appendChild(this.withHelpers(this.textField(p.concat('range'), 'Address range *', o, 'text', undefined, 'start-end, inside the network; not the gateway or a static address.', '10.1.1.100-10.1.1.199'), p.concat('range'), 'text', sug.range, 'range', owner));
    card.appendChild(this.withHelpers(this.textField(p.concat('gateway'), 'Default gateway *', o, 'text', undefined, 'The router’s address (or virtual address) in the network.', '10.1.1.1'), p.concat('gateway'), 'text', sug.gateway, 'default gateway', owner));
    card.appendChild(this.withHelpers(this.listField(p.concat('dns'), 'DNS servers *', o, '10.1.1.10', 'The DNS servers it gives its clients.'), p.concat('dns'), 'text', sug.dns, 'DNS servers', owner));
    card.appendChild(this.textField(p.concat('lease'), 'Lease time', o, 'text', undefined, 'How long a lease lasts (renewed at half of it); empty: 1 day.', '1 day (default)'));
    card.appendChild(this.listField(p.concat('exclude'), 'Excluded addresses', o, '10.1.1.150', 'Addresses of the range it never leases.'));
    // reservations: a MAC address and its address
    const rp = p.concat('reservations');
    const rn = doc.get(rp);
    const rbox = this.e('div', { class: 'list-ed' });
    (rn && rn.kind === 'seq' ? rn.items : []).forEach((_it, j) => {
      const ip = rp.concat(j);
      rbox.appendChild(
        this.e('div', { class: 'list-row res-row' + (doc.issuesAt(ip).some((i) => i.severity === 'error') ? ' invalid' : '') }, [
          this.input(ip.concat('mac'), 'text', doc.text(ip.concat('mac')) || '', { placeholder: 'MAC 02:00:00:00:00:01', 'aria-label': `Reservation ${j + 1}: MAC address`, 'data-o': 'dhcpReservation' }),
          this.e('span', { 'aria-hidden': 'true' }, [' → ']),
          this.input(ip.concat('ip'), 'text', doc.text(ip.concat('ip')) || '', { placeholder: '10.1.1.21', 'aria-label': `Reservation ${j + 1}: address`, 'data-o': 'dhcpReservation' }),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove this reservation' }, ['×']),
        ]),
      );
    });
    rbox.appendChild(this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(rp), 'data-what': 'reservation' }, ['+ Add reservation']));
    card.appendChild(this.field('Reservations', rbox, rp, 'A client (its MAC address) always gets this address.'));
    card.appendChild(this.textField(p.concat('domain'), 'Domain name', o, 'text', undefined, 'The domain its clients get (option 15).', 'hq.example'));
    const sim = this.simSection({ path: p, device: dev, at: scopeRef(dev, k), idBase: `scope-${dev}-${k}`, what: `scope ${k + 1}`, name: owner }, serviceParams('dhcp'));
    if (sim) card.appendChild(sim);
    for (const is of iss.filter((x) => !x.key)) card.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    return card;
  }

  /** A DNS zone: its name, the records the model's DNS names give (read-only, with their source), its own records; its Simulation subsection. */
  private zoneCard(p: Path, dev: string, model: Model | null): HTMLElement {
    const doc = this.doc;
    const o = 'dnsZone';
    const name = (doc.text(p.concat('name')) || '').toLowerCase().replace(/\.$/, '');
    const iss = doc.issuesAt(p);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const card = this.e('details', { class: 'card' + (errs ? ' has-err' : ''), 'data-card': J(p) });
    if (this.open.has(J(p)) || errs) card.setAttribute('open', '');
    card.appendChild(this.e('summary', {}, [this.e('span', { class: 'card-title' }, [`Zone ${name || '(no name)'}`]), iss.length ? this.badge(errs, iss.length - errs) : null, this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(p), title: 'Delete this zone' }, ['×'])]));
    card.appendChild(this.textField(p.concat('name'), 'Zone name *', o, 'text', undefined, 'A domain, e.g. hq.example: the model’s DNS names in it are its A / AAAA records.', 'hq.example'));
    // the derived records: read-only, with their source
    const derived = model && name ? derivedRecords(model, name) : [];
    const t = this.e('table', { class: 'mini-table' });
    t.appendChild(this.e('caption', { class: 'sr-only' }, [`Records of ${name} from the model’s DNS names`]));
    t.appendChild(this.e('thead', {}, [this.e('tr', {}, ['Name', 'Type', 'Value', 'Source'].map((h) => this.e('th', { scope: 'col' }, [h])))]));
    const tb = this.e('tbody');
    for (const r of derived) tb.appendChild(this.e('tr', {}, [r.fqdn, r.type, r.value, r.source].map((x) => this.e('td', {}, [x]))));
    if (!derived.length) tb.appendChild(this.e('tr', {}, [this.e('td', { colspan: '4', class: 'muted' }, [name ? 'No DNS name of the model is in this zone yet.' : 'Name the zone first.'])]));
    t.appendChild(tb);
    card.appendChild(this.derivedField('From the model’s DNS names', 'records', [t], 'Read-only: change a device’s DNS names to change them.'));
    // its own records
    const rp = p.concat('records');
    const rn = doc.get(rp);
    const rbox = this.e('div', { class: 'list-ed' });
    (rn && rn.kind === 'seq' ? rn.items : []).forEach((_it, j) => {
      const ip = rp.concat(j);
      const ty = this.e('select', { 'data-p': J(ip.concat('type')), 'data-t': 'text', 'data-o': 'dnsRecord', 'aria-label': `Record ${j + 1}: type` }) as HTMLSelectElement;
      for (const x of ['', 'A', 'AAAA', 'CNAME']) ty.appendChild(this.e('option', { value: x }, [x || 'Type']));
      ty.value = (doc.text(ip.concat('type')) || '').toUpperCase();
      rbox.appendChild(
        this.e('div', { class: 'list-row rec-row' + (doc.issuesAt(ip).some((i) => i.severity === 'error') ? ' invalid' : '') }, [
          this.input(ip.concat('name'), 'text', doc.text(ip.concat('name')) || '', { placeholder: 'name (www)', 'aria-label': `Record ${j + 1}: name`, 'data-o': 'dnsRecord' }),
          ty,
          this.input(ip.concat('value'), 'text', doc.text(ip.concat('value')) || '', { placeholder: 'address or name', 'aria-label': `Record ${j + 1}: value`, 'data-o': 'dnsRecord' }),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(ip), title: 'Remove this record' }, ['×']),
        ]),
      );
      for (const is of doc.issuesAt(ip)) rbox.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
    });
    rbox.appendChild(this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(rp), 'data-what': 'record' }, ['+ Add record']));
    card.appendChild(this.field('Its own records (A, AAAA, CNAME)', rbox, rp));
    const sim = name ? this.simSection({ path: p, device: dev, at: zoneRef(dev, name), idBase: `zone-${dev}-${name}`, what: `zone ${name}`, name: `${dev} zone ${name}` }, serviceParams('dns')) : null;
    if (sim) card.appendChild(sim);
    return card;
  }

  /** The IPv4 addresses of the model's DHCP or DNS servers (or of one device: kind null). */
  private serviceAddrs(kind: 'dhcp' | 'dns' | null, dev?: string): Array<{ a: string; d: string }> {
    const m = this.doc.result.model;
    const out: Array<{ a: string; d: string }> = [];
    if (!m) return out;
    for (const x of m.devices) {
      if (dev !== undefined ? x.id !== dev : !x.netServices || !x.netServices[kind as 'dhcp' | 'dns']) continue;
      for (const i of x.interfaces.concat(x.logical)) for (const a of i.addresses) if (a.indexOf(':') < 0) out.push({ a: a.split('/')[0], d: x.id });
    }
    return out;
  }

  /** A host's DNS servers (`dns_servers:`, static): what it asks unless a DHCP lease gives others. */
  private dnsClientGroup(base: Path): HTMLElement | null {
    const doc = this.doc;
    const type = doc.text(base.concat('type')) || '';
    const role = deviceRoutingRole(this.likeAt(base));
    if ((role === 'router' && !(capabilities({ type: type }).switchFeatures && doc.text(base.concat('layer3')) !== 'true')) && !doc.get(base.concat('dns_servers'))) return null;
    if ((capabilities({ type: type }).externalTransit || capabilities({ type: type }).switchFeatures)) {
      if (!doc.get(base.concat('dns_servers'))) return null;
    }
    const srvs = this.serviceAddrs('dns');
    const f = this.withHelpers(this.listField(base.concat('dns_servers'), 'DNS servers', 'device', '10.0.0.53', 'The DNS servers it asks (a DHCP client gets them from its lease as well).'), base.concat('dns_servers'), 'text', srvs.map((x) => ({ value: x.a, label: `${x.a} (${x.d})`, title: `The DNS server ${x.d}` })), 'DNS servers', doc.text(base.concat('id')) || '');
    return this.group('Name resolution (DNS client)', [f], 'dnsclient');
  }

  /**
   * A device's Simulation section: its device-wide simulation attributes
   * (the protocol simulation's values, analysis/sim/params.ts), and the
   * device-wide defaults of what its interfaces or relations set
   * themselves; collapsed until opened with its disclosure button.
   */
  simulationSection(devIndex: number): HTMLElement | null {
    const doc = this.getDoc();
    const model = doc ? doc.result.model : null;
    if (!doc || !model) return null;
    const id = doc.text(['devices', devIndex, 'id']) || '';
    const live = model.index.devices.get(id);
    if (!live) return null;
    const path: Path = ['devices', devIndex];
    const defs = deviceAttributes(model, live, this.writtenSim(path));
    return this.simSection({ path, device: id, at: null, idBase: 'dev', what: 'this device', name: id, top: true }, defs);
  }

  /** An interface's Simulation subsection (a port's spanning tree settings, an interface's ARP timeout …), collapsed. */
  ifaceSimSection(devIndex: number, p: Path, ifId: string): HTMLElement | null {
    const doc = this.getDoc();
    const model = doc ? doc.result.model : null;
    const dev = doc ? doc.text(['devices', devIndex, 'id']) || '' : '';
    const d = model ? model.index.devices.get(dev) : undefined;
    const i = model && d ? model.index.interfaces.get(dev + ':' + ifId) : undefined;
    if (!model || !d || !i) return null;
    const defs = interfaceAttributes(model, d, i, this.writtenSim(p));
    return this.simSection({ path: p, device: dev, at: ifaceRef(dev, ifId), idBase: 'if-' + dev + '-' + ifId, what: 'this interface', name: `${dev}:${ifId}` }, defs);
  }

  /** A network's Simulation subsection: its VLAN's (the snooping querier, fast leave), for every switch carrying it (snooping itself is each switch's own configuration). */
  vlanSimSection(netIndex: number): HTMLElement | null {
    const doc = this.getDoc();
    if (!doc) return null;
    const p: Path = ['networks', netIndex];
    const vlan = Number(doc.text(p.concat('vlan')));
    if (!vlan) return null;
    const defs = vlanAttributes(this.writtenSim(p));
    return this.simSection({ path: p, device: undefined, at: vlanRef(vlan), idBase: 'net-' + netIndex, what: `VLAN ${vlan}`, name: `VLAN ${vlan}`, note: `For every switch carrying VLAN ${vlan}. IGMP / MLD snooping itself is each switch's configuration (its IGMP / MLD snooping section).` }, defs);
  }

  /** A relation's Simulation subsection: a session's, a tunnel's, a redundancy group's or a service's (its pool) attributes. */
  relationSimSection(relIndex: number): HTMLElement | null {
    const doc = this.getDoc();
    const model = doc ? doc.result.model : null;
    if (!doc || !model) return null;
    const id = doc.text(['relations', relIndex, 'id']) || '';
    const r = model.index.relations.get(id);
    if (!r) return null;
    const p: Path = ['relations', relIndex];
    const defs = relationAttributes(model, r, this.writtenSim(p));
    const first = relationDevices(r)[0];
    return this.simSection({ path: p, device: first, at: relRef(id), idBase: 'rel-' + id, what: 'this relation', name: id, note: defs.some((x) => x.devDefault) ? 'Each end inherits its own device’s default where it has one (shown: the first end’s).' : undefined }, defs);
  }

  /** The keys an object's `simulation:` block has written. */
  private writtenSim(path: Path): string[] {
    const block = this.doc.get(path.concat('simulation'));
    return block && block.kind === 'map' ? Array.from(block.entries.keys()) : [];
  }

  /**
   * A Simulation section of an object: every field shows the value in
   * effect: the object's own (written in its `simulation:` block), else the
   * inherited one and where it comes from (Inherited: device, simulation,
   * or the default and its source). Only overrides are written; Reset makes
   * it inherit again. The documented exception to the simulation's edit
   * lock: it stays editable, and undoable, while a simulation runs.
   */
  private simSection(o: SimOwner, defs: SimParamDef[]): HTMLElement | null {
    const doc = this.getDoc();
    const model = doc ? doc.result.model : null;
    if (!doc || !model || !defs.length) return null;
    const written = this.writtenSim(o.path);
    const devs = new Map<string, { type: string; values: Map<string, ParamValue> }>();
    const dl = o.device ? model.index.devices.get(o.device) : undefined;
    if (o.device && dl) devs.set(o.device, { type: dl.type, values: dl.simulation || new Map() });
    const params = new SimParams(this.host.simParams ? this.host.simParams() : {}, devs);
    if (o.at) {
      const own = new Map<string, ParamValue>();
      for (const y of written) {
        const def = deviceParamByYaml(y);
        const t = doc.text(o.path.concat('simulation', y));
        if (!def || t === undefined) continue;
        const v = parseValue(def, t);
        if (!('error' in v)) own.set(def.key, v.value);
      }
      params.setObject(o.at, o.device, own);
    }
    const key = 'sim-section|' + J(o.path);
    const open = this.open.has(key);
    const bodyId = `fg-sim-body-${o.idBase}`;
    const btnId = o.top ? 'fg-simulation' : `fg-sim-${o.idBase}`;
    const set = defs.filter((d) => written.indexOf(d.yaml) >= 0).length;
    const btn = this.e('button', { type: 'button', class: 'fgroup-toggle', id: btnId, 'data-act': 'sim-toggle', 'data-key': key, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId }, [`Simulation (${defs.length})`]);
    const body = this.e('div', { class: 'sim-attrs', id: bodyId }, [
      this.e('p', { class: 'muted small' }, [`For Simulate ▾. Empty fields inherit; only values set here are saved.${o.note ? ' ' + o.note : ''}`]),
    ]);
    if (!open) body.hidden = true;
    for (const def of defs) body.appendChild(this.simAttrRow(o, def, params, doc.text(o.path.concat('simulation', def.yaml))));
    return this.e('section', { class: 'fgroup sim-section' + (o.top ? '' : ' sim-sub'), 'data-group': o.top ? 'simulation' : 'simulation-' + o.idBase, 'aria-labelledby': btnId }, [
      this.e(o.top ? 'h4' : 'h5', { class: 'fgroup-title fgroup-disclosure' }, [btn, set ? this.e('span', { class: 'small muted' }, [` ${set} set on ${o.what}`]) : null]),
      body,
    ]);
  }

  private simAttrRow(o: SimOwner, def: SimParamDef, params: SimParams, written: string | undefined): HTMLElement {
    const fid = `sim-attr-${o.top ? '' : o.idBase + '-'}${def.yaml}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const own = o.at ? params.objectValue(o.at, def.key) : o.device ? params.deviceValue(o.device, def.key) : undefined;
    const inh = o.at ? params.inheritedAt(def.key, o.device) : params.inherited(def.key, o.device as string);
    const inhText = `${formatValue(def, inh.value)} (${inh.source === 'device' ? 'device' : inh.source === 'simulation' ? 'simulation' : 'default — ' + def.source})`;
    const unit = fieldUnit(def);
    const describe = `${fid}-state ${fid}-help ${fid}-err`;
    const data = { 'data-t': 'sim-attr', 'data-p': J(o.path), 'data-k': def.yaml, 'data-name': o.name };
    let ctl: HTMLElement;
    if (def.kind === 'enum') {
      const sel = this.e('select', { id: fid, ...data, 'aria-describedby': describe }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, [`Inherited${inh.source === 'device' ? ' (device)' : ''}: ${formatValue(def, inh.value)}`]));
      for (const x of def.options || []) sel.appendChild(this.e('option', { value: x.value }, [x.label]));
      sel.value = own !== undefined ? String(own) : '';
      ctl = sel;
    } else {
      ctl = this.e('input', { type: 'text', id: fid, ...data, inputmode: def.kind === 'list' ? 'text' : 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: fieldText(def, inh.value) || formatValue(def, inh.value), value: written !== undefined ? written : own !== undefined ? fieldText(def, own) : '', 'aria-describedby': describe });
    }
    const state = own !== undefined ? `Set on ${o.what}: ${formatValue(def, own)}. It would inherit ${inhText}.` : written !== undefined ? `“${written}” is not valid (see Problems); inherited meanwhile: ${inhText}.` : `Inherited: ${inhText}.`;
    return this.e('div', { class: 'field sim-attr' + (own !== undefined ? ' overridden' : ''), 'data-sim-attr': def.yaml }, [
      this.e('label', { for: fid }, [def.label]),
      this.e('span', { class: 'pinput' }, [ctl, unit ? this.e('span', { class: 'punit', 'aria-hidden': 'true' }, [unit]) : null]),
      this.e('p', { class: 'small sim-attr-state', id: fid + '-state' }, [state]),
      this.e('p', { class: 'help', id: fid + '-help' }, [def.help]),
      this.e('p', { class: 'field-err', id: fid + '-err', hidden: '' }, ['']),
      own !== undefined || written !== undefined ? this.e('button', { type: 'button', class: 'mini', 'data-act': 'sim-reset', 'data-p': J(o.path), 'data-k': def.yaml, 'data-name': o.name, 'aria-label': `Reset ${def.label} of ${o.name} to inherited` }, ['Reset to inherited']) : null,
    ]);
  }

  /** A Simulation field was changed: checked first (range and unit), then written as one undo step (or removed when emptied). */
  private simAttrChange(target: HTMLElement, doc: ModelDoc, text: string): boolean {
    const path = P(target.getAttribute('data-p'));
    const k = target.getAttribute('data-k') as string;
    const name = target.getAttribute('data-name') || '';
    const def = deviceParamByYaml(k);
    if (!def) return true;
    const err = this.d.getElementById(target.id + '-err');
    if (text === '') {
      if (doc.get(path.concat('simulation', k))) {
        doc.setSimAttrAt(path, k, undefined);
        this.host.changed(`${name}: ${def.label} is inherited again.`);
      }
      return true;
    }
    const p = parseValue(def, text);
    if ('error' in p) {
      if (err) {
        err.textContent = `${def.label} ${p.error}.`;
        err.hidden = false;
      }
      target.setAttribute('aria-invalid', 'true');
      return true;
    }
    doc.setSimAttrAt(path, k, fieldText(def, p.value));
    this.host.changed(`${name}: ${def.label} set to ${formatValue(def, p.value)}.`);
    return true;
  }

  /** A device's Hypervisor, virtual switch and Container engine Simulation subsections (the simulation's Actions panel). */
  private serviceSimSections(devIndex: number): HTMLElement[] {
    const doc = this.getDoc();
    if (!doc) return [];
    const dev = doc.text(['devices', devIndex, 'id']) || '';
    const sp: Path = ['devices', devIndex, 'services'];
    const out: HTMLElement[] = [];
    const titled = (sec: HTMLElement | null, title: string): void => {
      if (!sec) return;
      const t = sec.querySelector('.fgroup-toggle');
      if (t) t.textContent = `${title}: ${t.textContent || ''}`;
      out.push(sec);
    };
    if (doc.get(sp.concat('hypervisor'))) {
      const hp = sp.concat('hypervisor');
      titled(this.simSection({ path: hp, device: dev, at: hvRef(dev), idBase: `hv-${dev}`, what: 'the Hypervisor', name: `${dev} Hypervisor` }, serviceParams('hypervisor')), 'Hypervisor');
      const n = doc.get(hp.concat('vswitches'));
      const count = n && n.kind === 'seq' ? n.items.length : 0;
      for (let k = 0; k < count; k++) {
        const vp = hp.concat('vswitches', k);
        const name = doc.text(vp.concat('name')) || '';
        if (name) titled(this.simSection({ path: vp, device: dev, at: vswRef(dev, name), idBase: `vsw-${dev}-${name}`, what: `virtual switch ${name}`, name: `${dev} ${name}` }, serviceParams('vswitch')), name);
      }
    }
    if (doc.get(sp.concat('container_engine'))) {
      titled(this.simSection({ path: sp.concat('container_engine'), device: dev, at: ceRef(dev), idBase: `ce-${dev}`, what: 'the Container engine', name: `${dev} Container engine` }, serviceParams('container_engine')), 'Container engine');
    }
    return out;
  }

  /** The selected device's Simulation section, editable (drawn above the read-only form while a simulation runs); false: no device selected. */
  renderSimSection(box: HTMLElement): boolean {
    const s = this.sel;
    if (!s) return false;
    const secs: Array<HTMLElement | null> = [];
    if (s.kind === 'device') {
      secs.push(this.simulationSection(s.index));
      // its Hypervisor (and each virtual switch) and its Container engine (each collapsed, under its name)
      secs.push(...this.serviceSimSections(s.index));
      // and its interfaces' (each collapsed, under its name)
      for (const entry of this.doc.interfaceEntries(s.index)) {
        if (!entry.id) continue;
        const sec = this.ifaceSimSection(s.index, entry.path, entry.id);
        if (!sec) continue;
        const title = sec.querySelector('.fgroup-toggle');
        if (title) title.textContent = `${entry.id}: Simulation (${title.textContent ? title.textContent.replace(/^Simulation \((\d+)\)$/, '$1') : ''})`;
        secs.push(sec);
      }
    } else if (s.kind === 'network') secs.push(this.vlanSimSection(s.index));
    else if (s.kind === 'relation') secs.push(this.relationSimSection(s.index));
    const shown = secs.filter((x): x is HTMLElement => !!x);
    for (const x of shown) box.appendChild(x);
    return shown.length > 0;
  }

  /** Device type: the format's types by display name; a disallowed current value stays visible. */
  private typeField(p: Path, order: string): HTMLElement {
    const n = this.doc.get(p);
    if (n && n.kind !== 'scalar') return this.field('Type', this.generic(p, n, 0), p, 'Not a single value — shown as a structure.');
    const current = this.doc.text(p) || '';
    const s = this.e('select', { 'data-p': J(p), 'data-t': 'dev-model', 'data-key': 'type', 'data-index': String(p[1]), 'data-o': order }) as HTMLSelectElement;
    s.appendChild(this.e('option', { value: '' }, ['Select device type']));
    if (!current) s.classList.add('unset');
    if (current && !isDeviceType(current)) s.appendChild(this.e('option', { value: current }, [current + ' (not a valid type)']));
    for (const t of DEVICE_TYPES) s.appendChild(this.e('option', { value: t.id }, [t.label]));
    s.value = current;
    return this.field('Type', s, p, 'Chooses the icon and the default row in the physical view.');
  }

  /**
   * What the device is, after its type: its kind (optional; Other with a
   * name), its role (suggested or its own), its mode (a firewall, an
   * IDS/IPS, an access point) or a System's purpose and icon. Nothing is
   * chosen for it; a mode not written is the type's first.
   */
  private modelFields(base: Path, devIndex: number): Array<HTMLElement | null> {
    const doc = this.doc;
    const o = 'device';
    const type = doc.text(base.concat('type')) || '';
    const out: Array<HTMLElement | null> = [];
    const kinds = kindsOf(type);
    const kp = base.concat('kind');
    if (kinds.length || doc.get(kp)) {
      const cur = doc.text(kp) || '';
      const sel = this.e('select', { 'data-p': J(kp), 'data-t': 'text', 'data-o': o }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, ['No kind']));
      if (cur && !kinds.some((k) => k.id === cur)) sel.appendChild(this.e('option', { value: cur }, [cur + ' (not a kind of this type)']));
      for (const k of kinds) sel.appendChild(this.e('option', { value: k.id }, [k.label]));
      sel.value = cur;
      if (!cur) sel.classList.add('unset');
      out.push(this.field('Kind', sel, kp, 'Optional: what kind it is (some kinds have their own icon). Other: name it below.'));
      if (cur === 'other' || doc.get(base.concat('kind_label'))) out.push(this.textField(base.concat('kind_label'), cur === 'other' ? 'Kind name *' : 'Kind name', o, 'text', undefined, 'The name of its kind (with Other).', 'e.g. Console server'));
    }
    out.push(this.textField(base.concat('role'), 'Role', o, 'text', ROLES.map((r) => r.id), 'Optional: suggested or your own. Auto-arrange and Find use it.', 'core, access, spine …'));
    const modes = modesOf(type);
    const mp = base.concat('mode');
    if (modes.length > 1 || doc.get(mp)) {
      const cur = doc.text(mp) || '';
      const sel = this.e('select', { 'data-p': J(mp), 'data-t': 'dev-model', 'data-key': 'mode', 'data-index': String(devIndex), 'data-o': o }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, [modes.length ? `${modes[0].label} (not written: the first)` : '(none)']));
      if (cur && !modes.some((m) => m.id === cur)) sel.appendChild(this.e('option', { value: cur }, [cur + ' (not a mode of this type)']));
      for (const m of modes) sel.appendChild(this.e('option', { value: m.id }, [m.label]));
      sel.value = cur;
      const m = modes.find((x) => x.id === (cur || (modes[0] && modes[0].id)));
      out.push(this.field('Mode', sel, mp, m && m.help ? m.help : 'How it works in the network.'));
    }
    const pp = base.concat('purpose');
    if (hasPurpose(type) || doc.get(pp)) {
      const cur = doc.text(pp) || '';
      const sel = this.e('select', { 'data-p': J(pp), 'data-t': 'dev-model', 'data-key': 'purpose', 'data-index': String(devIndex), 'data-o': o, 'aria-required': 'true' }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, ['Select what it does']));
      if (cur && !purposeDef(cur)) sel.appendChild(this.e('option', { value: cur }, [cur + ' (not a purpose)']));
      for (const x of SYSTEM_PURPOSES) sel.appendChild(this.e('option', { value: x.id }, [x.label]));
      sel.value = cur;
      if (!cur) sel.classList.add('unset');
      const def = purposeDef(cur);
      out.push(this.field('Purpose *', sel, pp, def ? def.help : 'Required: what the System does. A security boundary is a Security gateway, not a System.'));
      const icons = purposeIcons(cur);
      if (icons.length > 1 || doc.get(base.concat('icon'))) {
        const ip = base.concat('icon');
        const ic = doc.text(ip) || '';
        const isel = this.e('select', { 'data-p': J(ip), 'data-t': 'text', 'data-o': o }) as HTMLSelectElement;
        isel.appendChild(this.e('option', { value: '' }, [icons.length ? `${icons[0].label} (the purpose’s)` : '(the type’s)']));
        if (ic && !icons.some((x) => x.id === ic)) isel.appendChild(this.e('option', { value: ic }, [ic + ' (not an icon of this purpose)']));
        for (const x of icons.slice(1)) isel.appendChild(this.e('option', { value: x.id }, [x.label]));
        isel.value = ic;
        out.push(this.field('Icon', isel, ip, 'Its icon in the diagram, among those of its purpose.'));
      }
    }
    return out;
  }

  /** A change of type, mode, purpose or implementation: a confirmation when something has to go (what, and what stays but is reported); one undo step. */
  private async changeDeviceModel(devIndex: number, key: DeviceModelKey, value: string): Promise<void> {
    const doc = this.doc;
    const dev = doc.text(['devices', devIndex, 'id']) || 'the device';
    const plan = doc.deviceModelPlan(devIndex, key, value);
    const what = key === 'implementation' ? 'implementation' : key;
    if (plan.removed.length || plan.kept.length) {
      const body: Array<string | HTMLElement> = [];
      if (plan.removed.length) body.push(`These values no longer fit ${dev} and are removed with the change (nothing is kept hidden in the model):`, this.e('ul', { class: 'removal-list' }, plan.removed.map((x) => this.e('li', {}, [x.text]))));
      if (plan.kept.length) body.push('These stay and are reported until you change them:', this.e('ul', { class: 'removal-list' }, plan.kept.map((x) => this.e('li', {}, [x]))));
      body.push('Nothing new is chosen for it. You can undo this with Ctrl+Z.');
      const a = await this.host.dialog({
        title: `Change the ${what} of ${dev}?`,
        body: body as unknown as string[],
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: `Change the ${what}`, value: 'go', kind: 'danger' },
        ],
      });
      if (a !== 'go') {
        this.host.changed();
        return;
      }
    }
    doc.applyDeviceModel(devIndex, key, value);
    this.host.changed(`${dev}: ${what} ${value || 'removed'}${plan.removed.length ? `; ${plan.removed.length} value${plan.removed.length === 1 ? '' : 's'} that no longer fit removed` : ''}.`);
  }

  /** A list of ids as chips (each removable) and a select to add one of `options`. */
  private chipsField(p: Path, label: string, options: string[], help: string, addLabel: string): HTMLElement {
    const doc = this.doc;
    const n = doc.get(p);
    const items: Array<{ id: string; path: Path }> = [];
    if (n && n.kind === 'seq') n.items.forEach((it, j) => items.push({ id: scalarText(it) || '', path: p.concat(j) }));
    else if (n && n.kind === 'scalar') items.push({ id: scalarText(n) || '', path: p });
    const box = this.e('div', { class: 'chips-ed' });
    for (const x of items) {
      box.appendChild(this.e('span', { class: 'ref-chip' + (options.indexOf(x.id) < 0 ? ' invalid' : ''), 'data-member': x.id }, [x.id, this.e('button', { type: 'button', class: 'mini', 'data-act': 'del-item', 'data-p': J(x.path), title: `Remove ${x.id}`, 'aria-label': `Remove ${x.id}` }, ['×'])]));
    }
    const sel = this.e('select', { 'data-p': J(p), 'data-t': 'member-append', 'data-o': 'device', 'aria-label': addLabel }) as HTMLSelectElement;
    const left = options.filter((x) => !items.some((y) => y.id === x));
    sel.appendChild(this.e('option', { value: '' }, [left.length ? '+ ' + addLabel.toLowerCase() + '…' : '(none left to add)']));
    for (const x of left) sel.appendChild(this.e('option', { value: x }, [x]));
    sel.classList.add('unset');
    box.appendChild(sel);
    return this.field(label, box, p, help);
  }

  /**
   * A device's appliance settings, each where it applies: its port pairs (an
   * inline or pass-through device), its management interfaces, a VPN
   * Gateway's VPN gateway configuration and a Security gateway's Domain
   * separation. The built-in functions can't be removed; their required
   * fields are reported until filled in.
   */
  private applianceGroups(base: Path, devIndex: number): HTMLElement[] {
    const doc = this.doc;
    const caps = this.capsAt(devIndex);
    const out: HTMLElement[] = [];
    const ports = doc.interfaceEntries(devIndex).filter((e) => e.kind === 'interface' && e.id).map((e) => e.id as string);
    const logical = doc.interfaceEntries(devIndex).filter((e) => e.kind !== 'interface' && e.id);
    // the VPN gateway function
    const vp = base.concat('services', 'vpn');
    if (caps.vpnOnlyTransit || doc.get(vp)) {
      const kids: Array<HTMLElement | null> = [];
      if (!doc.get(vp)) {
        kids.push(this.e('p', { class: 'field-err' }, [`A ${deviceTypeInText('vpn_gateway')} needs the configuration of its VPN: its operation, technology and tunnels or listener. Nothing is chosen for it.`]));
        kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-block', 'data-p': J(vp), 'data-what': 'VPN gateway configuration' }, ['+ Configure the VPN gateway'])]));
      } else {
        const op = doc.text(vp.concat('operation')) || '';
        kids.push(this.field('Operation *', this.labelledSelect(vp.concat('operation'), 'vpn', VPN_OPERATIONS.map((x) => [x.id, x.label]), 'Select operation'), vp.concat('operation'), 'Site to site: tunnels to fixed peers. Remote access: clients connect to it.'));
        kids.push(this.field('Technology *', this.labelledSelect(vp.concat('technology'), 'vpn', VPN_TECHNOLOGIES.map((x) => [x.id, x.label]), 'Select technology'), vp.concat('technology'), 'Not chosen for you.'));
        if (op === 'site_to_site' || doc.get(vp.concat('tunnels'))) kids.push(this.chipsField(vp.concat('tunnels'), 'Tunnels *', logical.filter((e) => e.type === 'tunnel').map((e) => e.id as string), 'Its tunnel interfaces, each with its source (local end) and destination (peer).', 'Add a tunnel interface'));
        if (op === 'remote_access' || doc.get(vp.concat('listener'))) kids.push(this.field('Listener *', this.selectEl(vp.concat('listener'), 'text', 'vpn', ports.concat(logical.map((e) => e.id as string)), doc.text(vp.concat('listener')) || '', 'Select interface'), vp.concat('listener'), 'The interface its clients connect to (it needs an address).'));
        if (op === 'remote_access' || doc.get(vp.concat('pool'))) kids.push(this.textField(vp.concat('pool'), 'Client pool *', 'vpn', 'text', undefined, 'The clients’ addresses: a prefix.', '10.250.0.0/24'));
        kids.push(this.listField(vp.concat('protected'), 'Protected networks *', 'vpn', 'a network id or a prefix', 'The networks behind it that its VPN reaches.'));
        kids.push(this.e('p', { class: 'help' }, ['It forwards only to and from its VPN: traffic between its other interfaces is refused.']));
      }
      const vpnBuiltIn = isBuiltIn(serviceDef('vpn') as SvcDef, this.likeAt(base));
      if (!vpnBuiltIn) kids.unshift(this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, ['A service of this device']), this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'remove-service', 'data-svc': 'vpn', 'data-index': String(devIndex), title: 'Remove the VPN gateway', 'aria-label': 'Remove the VPN gateway' }, ['×'])]));
      kids.push(supportNote(this.d, (serviceDef('vpn') as SvcDef).support, 'VPN gateway'));
      out.push(this.group(vpnBuiltIn ? 'VPN gateway (built in)' : 'VPN gateway', kids, 'vpn'));
    }
    // the other built-in functions: an access point's Wireless access, a load balancer's Load balancing, an IDS/IPS's Inspection
    const like = this.likeAt(base);
    for (const def of builtInServices(like)) {
      if (def.id === 'vpn' || def.id === 'separation') continue;
      const p = base.concat('services', def.id);
      out.push(this.group(`${def.label} (built in)`, [def.id === 'wireless' ? this.wirelessCard(p, devIndex, true) : this.serviceCardGeneric(p, def, devIndex, true)], 'svc-' + def.id));
    }
    // the Domain separation function
    const sp = base.concat('services', 'separation');
    if (caps.securityGateway || doc.get(sp)) out.push(this.separationGroup(sp, devIndex, ports, logical.map((e) => e.id as string)));
    // port pairs
    const ppath = base.concat('port_pairs');
    if (caps.needsPortPairs || doc.get(ppath)) {
      const kids: Array<HTMLElement | null> = [this.e('p', { class: 'help' }, [caps.passThrough ? 'Joins each pair physically (no IP stack); a copy port gets what passes.' : 'Passes traffic only within a pair (one way if set); a copy port gets a copy.'])];
      const pn = doc.get(ppath);
      const n = pn && pn.kind === 'seq' ? pn.items.length : 0;
      for (let j = 0; j < n; j++) {
        const ip = ppath.concat(j);
        const pick = (k: 'a' | 'b'): HTMLSelectElement => this.selectEl(ip.concat(k), 'text', 'portPair', ports, doc.text(ip.concat(k)) || '', k === 'a' ? 'Port a' : 'Port b', { 'aria-label': `Pair ${j + 1}: port ${k}` });
        const dir = this.selectEl(ip.concat('direction'), 'text', 'portPair', ['a_to_b'], doc.text(ip.concat('direction')) || '', 'both ways', { 'aria-label': `Pair ${j + 1}: direction` });
        const card = this.e('div', { class: 'svc-card pair-card', role: 'group', 'aria-label': `Pair ${j + 1}` }, [
          this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, [`Pair ${j + 1}`]), this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(ip), title: 'Delete this pair', 'aria-label': `Delete pair ${j + 1}` }, ['×'])]),
          this.field('Ports', this.e('span', { class: 'ctl row' }, [pick('a'), this.e('span', { 'aria-hidden': 'true' }, [' ↔ ']), pick('b')]), ip, undefined),
          this.field('Direction', dir, ip.concat('direction'), 'Both ways, or only from port a to port b (a one-way device).'),
          this.chipsField(ip.concat('copy'), 'Copy to', ports, 'Monitor ports: they get a copy and send nothing back.', 'Add a copy port'),
        ]);
        kids.push(card);
      }
      kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(ppath), 'data-what': 'port pair' }, ['+ Add port pair'])]));
      out.push(this.group('Port pairs', kids, 'port-pairs'));
    }
    // management interfaces
    const mpath = base.concat('management');
    if (caps.managementInterfaces || doc.get(mpath)) {
      out.push(this.group('Management', [this.chipsField(mpath, 'Management interfaces', ports, 'Its interfaces for managing it: never forwarded, in no domain.', 'Add a management interface')], 'management'));
    }
    return out;
  }

  /**
   * A wireless connection's Wi-Fi network: at a radio of a Wireless access, the
   * networks on that radio by SSID (their ids are what is stored: an SSID need
   * not be unique). Null for any other cable.
   */
  private wifiNetworkField(base: Path): HTMLElement | null {
    const doc = this.doc;
    const model = doc.result.model;
    const p = base.concat('wireless_network');
    if (!model) return null;
    const ends = ['a', 'b'].map((k) => {
      const t = doc.text(base.concat(k)) || '';
      const i = t.indexOf(':');
      return i < 0 ? { device: t, iface: undefined as string | undefined } : { device: t.slice(0, i), iface: t.slice(i + 1) };
    });
    const medium = (doc.text(base.concat('medium')) || '').toLowerCase();
    let nets: Array<[string, string]> = [];
    let where = '';
    for (const e of ends) {
      const d = model.index.devices.get(e.device);
      if (!d || !d.wireless || e.iface === undefined) continue;
      const on = d.wireless.networks.filter((x) => x.radio === e.iface);
      if (on.length) {
        nets = on.map((x) => [x.id, `${x.ssid || x.id} (${x.id}) · ${x.vlan !== undefined ? 'VLAN ' + x.vlan : 'untagged'}`]);
        where = `${d.id}:${e.iface}`;
      }
    }
    if (medium !== 'wireless' && !doc.get(p)) return null;
    if (!nets.length && !doc.get(p)) return null;
    const req = medium === 'wireless' && nets.length > 0;
    return this.field(req ? 'Wi-Fi network *' : 'Wi-Fi network', this.labelledSelect(p, 'link', nets, 'Select network'), p, where ? `The network it is associated with on ${where}; it takes that network’s VLAN.` : 'Only a wireless connection at a radio with Wi-Fi networks has one.');
  }

  /** A select of [value, label] pairs at a path (a value that is not one of them is kept and marked). */
  private labelledSelect(p: Path, order: string, options: Array<[string, string]>, emptyLabel: string): HTMLSelectElement {
    const cur = this.doc.text(p) || '';
    const sel = this.e('select', { 'data-p': J(p), 'data-t': 'text', 'data-o': order }) as HTMLSelectElement;
    sel.appendChild(this.e('option', { value: '' }, [emptyLabel]));
    if (cur && !options.some((x) => x[0] === cur)) sel.appendChild(this.e('option', { value: cur }, [cur + ' (not supported)']));
    for (const [v, l] of options) sel.appendChild(this.e('option', { value: v }, [l]));
    sel.value = cur;
    if (!cur) sel.classList.add('unset');
    return sel;
  }

  /**
   * A Security gateway's Domain separation: its implementation (none
   * chosen for it), its two domains with their interfaces, the permitted
   * directions, its rules in order and a protocol break's transfer
   * profiles. Everything not permitted is denied, both ways.
   */
  private separationGroup(sp: Path, devIndex: number, ports: string[], logical: string[]): HTMLElement {
    const doc = this.doc;
    const kids: Array<HTMLElement | null> = [];
    const impl = doc.text(sp.concat('implementation')) || '';
    const isel = this.e('select', { 'data-p': J(sp.concat('implementation')), 'data-t': 'dev-model', 'data-key': 'implementation', 'data-index': String(devIndex), 'data-o': 'separation', 'aria-required': 'true' }) as HTMLSelectElement;
    isel.appendChild(this.e('option', { value: '' }, ['Select how it separates']));
    for (const x of SEPARATION_IMPLEMENTATIONS) isel.appendChild(this.e('option', { value: x.id }, [x.label]));
    isel.value = impl;
    if (!impl) isel.classList.add('unset');
    const def = SEPARATION_IMPLEMENTATIONS.find((x) => x.id === impl);
    kids.push(this.field('Implementation *', isel, sp.concat('implementation'), def ? def.help : SEPARATION_IMPLEMENTATIONS.map((x) => `${x.label}: ${x.help}`).join(' ')));
    kids.push(supportNote(this.d, (serviceDef('separation') as SvcDef).support, 'Domain separation'));
    // the two domains
    const dl = doc.get(sp.concat('domains'));
    const nd = dl && dl.kind === 'seq' ? dl.items.length : 0;
    const names: string[] = [];
    for (let j = 0; j < nd; j++) {
      const dp = sp.concat('domains', j);
      const name = doc.text(dp.concat('name')) || '';
      if (name) names.push(name);
      kids.push(
        this.e('div', { class: 'svc-card domain-card', role: 'group', 'aria-label': `Domain ${j + 1}` }, [
          this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, [`Domain ${j + 1}${name ? ': ' + name : ''}`]), this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(dp), title: 'Delete this domain', 'aria-label': `Delete domain ${j + 1}` }, ['×'])]),
          this.textField(dp.concat('name'), 'Name *', 'sepDomain', 'text', j === 0 ? ['Red', 'HIGH', 'IT'] : ['Black', 'LOW', 'OT'], 'Any name: NetAtlas reads no classification, trust or direction from it.', j === 0 ? 'Red' : 'Black'),
          this.chipsField(dp.concat('interfaces'), 'Interfaces *', ports.concat(logical), 'Its data interfaces on this side (not a management interface).', 'Add an interface'),
        ]),
      );
    }
    if (nd < 2) kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(sp.concat('domains')), 'data-what': 'domain' }, [`+ Add domain (${2 - nd} more)`])]));
    // the permitted directions
    if (names.length === 2) {
      const box = this.e('div', { class: 'sep-dirs', role: 'group', 'aria-label': 'Permitted directions' });
      for (const [a, b] of [
        [names[0], names[1]],
        [names[1], names[0]],
      ]) {
        const on = this.hasDirection(sp, a, b);
        const id = `sepdir-${devIndex}-${a}-${b}`.replace(/[^A-Za-z0-9_-]/g, '_');
        const cb = this.e('input', { type: 'checkbox', id, 'data-t': 'sep-direction', 'data-p': J(sp), 'data-from': a, 'data-to': b }) as HTMLInputElement;
        cb.checked = on;
        box.appendChild(this.e('label', { class: 'check', for: id }, [cb, ` ${a} → ${b}`]));
      }
      kids.push(this.field('Permitted directions *', box, sp.concat('directions'), 'Who may start a transfer. Replies come back; the other way needs its own rule.'));
    }
    // the profiles of a protocol break
    const pl = doc.get(sp.concat('profiles'));
    const np = pl && pl.kind === 'seq' ? pl.items.length : 0;
    const profIds: string[] = [];
    if (impl === 'protocol_break' || np) {
      for (let j = 0; j < np; j++) {
        const pp = sp.concat('profiles', j);
        const pid = doc.text(pp.concat('id')) || '';
        if (pid) profIds.push(pid);
        const tp = TRANSFER_PROFILES.find((x) => x.id === doc.text(pp.concat('type')));
        kids.push(
          this.e('div', { class: 'svc-card profile-card', role: 'group', 'aria-label': `Transfer profile ${pid || j + 1}` }, [
            this.e('div', { class: 'svc-head' }, [this.e('span', { class: 'svc-name' }, [`Transfer profile ${pid || j + 1}`]), this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(pp), title: 'Delete this profile', 'aria-label': `Delete transfer profile ${pid || j + 1}` }, ['×'])]),
            this.textField(pp.concat('id'), 'Id *', 'transferProfile', 'text', undefined, 'Its rules name it.', 'web'),
            this.field('Transfer *', this.labelledSelect(pp.concat('type'), 'transferProfile', TRANSFER_PROFILES.map((x) => [x.id, `${x.label} (${x.transport.toUpperCase()} ${x.port})`]), 'Select what it transfers'), pp.concat('type'), tp ? tp.help : 'What the gateway terminates and starts again. Only these transfers can be modelled.'),
            this.field('Listens on *', this.selectEl(pp.concat('listen', 'interface'), 'text', 'profileListen', ports.concat(logical), doc.text(pp.concat('listen', 'interface')) || '', 'Select interface'), pp.concat('listen', 'interface'), 'An interface of the domain the transfer comes from.'),
            this.intField(pp.concat('listen', 'port'), 'Listening port *', 'profileListen', tp ? `Usually ${tp.port}.` : undefined),
            this.textField(pp.concat('forward', 'address'), 'Sends to (address) *', 'profileForward', 'text', undefined, 'Where the gateway starts its new transfer, in the other domain.', '10.20.0.80'),
            this.intField(pp.concat('forward', 'port'), 'Sends to (port) *', 'profileForward', tp ? `Usually ${tp.port}.` : undefined),
          ]),
        );
      }
      kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(sp.concat('profiles')), 'data-what': 'transfer profile' }, ['+ Add transfer profile'])]));
    }
    // the rules, in order
    const rl = doc.get(sp.concat('rules'));
    const nr = rl && rl.kind === 'seq' ? rl.items.length : 0;
    kids.push(this.e('p', { class: 'help' }, [nr ? 'Checked in order: the first match permits. Everything else is denied, both ways.' : 'No rules: an empty policy permits nothing. Everything not permitted is denied, both ways.']));
    for (let j = 0; j < nr; j++) {
      const rp = sp.concat('rules', j);
      const rid = doc.text(rp.concat('id')) || '';
      const proto = doc.text(rp.concat('protocol')) || '';
      kids.push(
        this.e('div', { class: 'svc-card rule-card', role: 'group', 'aria-label': `Rule ${j + 1}${rid ? ' ' + rid : ''}` }, [
          this.e('div', { class: 'svc-head' }, [
            this.e('span', { class: 'svc-name' }, [`${j + 1}. Rule ${rid}`]),
            this.e('span', { class: 'svc-btns' }, [
              j > 0 ? this.e('button', { type: 'button', class: 'mini', 'data-act': 'move-up', 'data-p': J(rp), title: 'Check it one earlier', 'aria-label': `Move rule ${rid || j + 1} up` }, ['↑']) : null,
              this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-item', 'data-p': J(rp), title: 'Delete this rule', 'aria-label': `Delete rule ${rid || j + 1}` }, ['×']),
            ]),
          ]),
          this.textField(rp.concat('id'), 'Id *', 'sepRule', 'text', undefined, 'Stays the same when the rules are reordered.', 'web'),
          this.textField(rp.concat('description'), 'Description', 'sepRule'),
          this.field('From *', this.selectEl(rp.concat('from'), 'text', 'sepRule', names, doc.text(rp.concat('from')) || '', 'Select domain'), rp.concat('from'), undefined),
          this.field('To *', this.selectEl(rp.concat('to'), 'text', 'sepRule', names, doc.text(rp.concat('to')) || '', 'Select domain'), rp.concat('to'), undefined),
          this.textField(rp.concat('source'), 'Source *', 'sepRule', 'text', ['any'], 'An address, a prefix, or any (written: an empty field is never any).', '10.10.0.0/24'),
          this.textField(rp.concat('destination'), 'Destination *', 'sepRule', 'text', ['any'], impl === 'protocol_break' ? 'The new transfer’s destination (its profile’s address), or any.' : 'An address, a prefix, or any.', '10.20.0.80'),
          this.field('Protocol *', this.selectEl(rp.concat('protocol'), 'text', 'sepRule', ['tcp', 'udp', 'icmp', 'any'], proto, 'Select protocol'), rp.concat('protocol'), undefined),
          proto === 'tcp' || proto === 'udp' || doc.get(rp.concat('ports')) ? this.textField(rp.concat('ports'), 'Destination ports *', 'sepRule', 'text', ['any'], 'Ports and ranges ("443", "80, 443", "8000-8080") or any.', '443') : null,
          impl === 'protocol_break' || doc.get(rp.concat('profile')) ? this.field('Transfer profile *', this.selectEl(rp.concat('profile'), 'text', 'sepRule', profIds, doc.text(rp.concat('profile')) || '', 'Select profile'), rp.concat('profile'), 'In a protocol break, each permitted transfer is one of its profiles.') : null,
        ]),
      );
    }
    kids.push(this.e('div', { class: 'field' }, [this.e('button', { type: 'button', class: 'mini', 'data-act': 'add-svc-item', 'data-p': J(sp.concat('rules')), 'data-what': 'rule' }, ['+ Add rule'])]));
    kids.push(this.e('p', { class: 'muted small' }, ['A model of how such a boundary behaves: no product, no assurance of real separation.']));
    return this.group('Domain separation (built in)', kids, 'separation');
  }

  /** Is a direction from one domain to the other permitted (written in `directions:`)? */
  private hasDirection(sp: Path, from: string, to: string): boolean {
    const lp = sp.concat('directions');
    const n = this.doc.get(lp);
    if (!n || n.kind !== 'seq') return false;
    return n.items.some((_x, j) => this.doc.text(lp.concat(j, 'from')) === from && this.doc.text(lp.concat(j, 'to')) === to);
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
    const help = 'Devices with an address in this prefix.';
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
      : [this.e('span', { class: 'muted' }, [net.cidr ? 'No device has a configured address in this network.' : 'No valid prefix yet, so there are no members.'])];
    return this.derivedField(`Members (${members.length})`, 'members', body, help);
  }

  /** Network and VLAN of each address of an interface, from the networks containing it. */
  private ifaceDerivedField(devIndex: number, p: Path): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']);
    const n = doc.get(p) as DocNode;
    const id = n.kind === 'map' ? doc.text(p.concat('id')) : scalarText(n);
    const help = 'From the network that contains the address.';
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

  // ------------------------------------------------------ a port's VLANs

  /** The port (or aggregate) an interface card edits, at layer 2, in the current model (none while it has errors). */
  private cardL2(devIndex: number, p: Path): PortL2 | undefined {
    const model = this.doc.result.model;
    const dev = this.doc.text(['devices', devIndex, 'id']);
    const id = this.doc.text(p.concat('id'));
    return model && dev && id ? portL2(model, dev, id) : undefined;
  }

  /** A port's mode as a badge: its words carry it (Access · VLAN 10, Trunk · 10, 20 (native 10), Routed, No VLANs), the frame style only adds to them. */
  private modeBadge(l: PortL2 | undefined): HTMLElement | null {
    const t = portBadgeText(l);
    if (!l || !t) return null;
    return this.e('span', { class: 'mode-badge mode-' + l.kind, 'data-mode': l.kind, title: l.kind === 'unset' ? 'A switch port says what it carries: give it its VLANs' : t }, [t]);
  }

  /**
   * A port's VLANs (`vlans`), as a multi-select combobox: the VLANs it has
   * are chips (each removable), the field offers the model's VLANs with
   * their names as you type and takes new IDs and ranges ("100-199"),
   * Enter or a comma adds them; Backspace in the empty field removes the
   * last one. One VLAN makes it an access port, several a trunk: then a
   * Native VLAN picker appears. On a Layer 3 switch a port may instead be
   * set to routed. A member of an aggregate shows its aggregate's VLANs,
   * read-only. Suggestions copy a neighbouring port's or the connected
   * port's VLANs (one undo step each).
   */
  private portVlanField(devIndex: number, p: Path, entry: IfaceEntry): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const devId = doc.text(['devices', devIndex, 'id']) || '';
    const type = doc.text(['devices', devIndex, 'type']) || '';
    const l3switch = capabilities({ type: type }).switchFeatures && doc.text(['devices', devIndex, 'layer3']) === 'true';
    const id = entry.id || '';
    const vp = p.concat('vlans');
    const own = doc.portVlans(p);
    const routed = doc.text(p.concat('routed')) === 'true';
    const l2 = this.cardL2(devIndex, p);
    const lag = model && entry.kind === 'interface' && id ? lagOf(model, devId, id) : undefined;
    const box = this.e('div', { class: 'port-l2', 'data-port-l2': l2 ? l2.kind : 'unknown' });
    // a member port takes its aggregate's VLANs
    if (lag !== undefined && !own.length && !doc.get(p.concat('native')) && !routed) {
      box.appendChild(
        this.derivedField(
          'VLANs',
          'port-vlans',
          [this.modeBadge(l2), this.e('span', { class: 'muted' }, [' from its aggregate ']), this.e('button', { type: 'button', class: 'ref', 'data-goto': `iface:${devId}:${lag}` }, [lag])],
          `A member of ${lag}: it carries the aggregate's VLANs (set them there).`,
        ),
      );
      return box;
    }
    const uid = 'vl-' + Math.random().toString(36).slice(2, 9);
    const chips = this.e('span', { class: 'vlan-chips', role: 'list', 'aria-label': `VLANs of ${id}` });
    for (const v of own) {
      chips.appendChild(
        this.e('span', { class: 'ref-chip vlan-chip', role: 'listitem', 'data-vlan': v }, [
          v.replace('-', '–'),
          this.e('button', { type: 'button', class: 'mini', 'data-act': 'vlan-remove', 'data-p': J(p), 'data-v': v, 'aria-label': `Remove VLAN ${v} from ${id}`, title: `Remove VLAN ${v}` }, ['×']),
        ]),
      );
    }
    const input = this.e('input', {
      type: 'text',
      id: uid,
      'data-p': J(vp),
      'data-t': 'vlan-combo',
      'data-o': entry.kind,
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': uid + '-list',
      'aria-label': `Add VLANs to ${id}`,
      'aria-describedby': uid + '-help',
      autocomplete: 'off',
      spellcheck: 'false',
      inputmode: 'text',
      placeholder: own.length ? 'add a VLAN or range' : routed ? '(routed)' : '10, or 10, 20, 30-39',
    }) as HTMLInputElement;
    if (routed) input.disabled = true;
    const list = this.e('ul', { id: uid + '-list', role: 'listbox', class: 'combo-list', 'aria-label': 'VLANs of the model' }) as HTMLUListElement;
    list.hidden = true;
    const ownIds = l2 ? l2.vlans : [];
    const choices = model
      ? vlanChoices(model)
          .filter((c) => ownIds.indexOf(c.id) < 0)
          .map((c) => {
            const nets = model.networks.filter((n) => n.vlan === c.id).map((n) => n.label || n.id);
            return { id: c.id, name: nets.length ? nets.join(', ') : c.names.length ? `on ${c.names.length} port${c.names.length === 1 ? '' : 's'} or interface${c.names.length === 1 ? '' : 's'}` : '' };
          })
      : [];
    let active = -1;
    const options = (): HTMLElement[] => Array.from(list.querySelectorAll('[role="option"]')) as HTMLElement[];
    const render = (): void => {
      while (list.firstChild) list.removeChild(list.firstChild);
      const q = input.value.trim().toLowerCase();
      const shown = choices.filter((c) => !q || String(c.id).indexOf(q) === 0 || c.name.toLowerCase().indexOf(q) >= 0).slice(0, 50);
      shown.forEach((c, k) => {
        const li = this.e('li', { role: 'option', id: `${uid}-o${k}`, 'data-value': String(c.id), 'aria-selected': 'false', class: 'combo-opt' }, [this.e('span', {}, [`VLAN ${c.id}`]), c.name ? this.e('span', { class: 'combo-count' }, [` ${c.name}`]) : null]);
        li.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          pick(String(c.id));
        });
        list.appendChild(li);
      });
      if (!shown.length) list.appendChild(this.e('li', { class: 'combo-empty', role: 'presentation' }, [input.value.trim() ? 'A VLAN ID or range: press Enter to add it' : 'Type a VLAN ID (1–4094) or a range such as 100-199']));
      active = -1;
      input.removeAttribute('aria-activedescendant');
    };
    const open = (on: boolean): void => {
      list.hidden = !on;
      input.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) render();
    };
    const move = (d: number): void => {
      const os = options();
      if (!os.length) return;
      active = (active + d + os.length) % os.length;
      os.forEach((o, k) => o.setAttribute('aria-selected', k === active ? 'true' : 'false'));
      input.setAttribute('aria-activedescendant', os[active].id);
      if (typeof os[active].scrollIntoView === 'function') os[active].scrollIntoView({ block: 'nearest' });
    };
    // a pick (or what is typed) is added through the change handler: one undo step, the field keeps the focus
    const pick = (value: string): void => {
      input.value = value;
      open(false);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('input', () => {
      if (/[,;]\s*$/.test(input.value)) {
        pick(input.value.replace(/[,;]\s*$/, ''));
        return;
      }
      open(true);
    });
    input.addEventListener('blur', () => open(false));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (list.hidden) open(true);
        move(ev.key === 'ArrowDown' ? 1 : -1);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!list.hidden && active >= 0) pick(options()[active].getAttribute('data-value') as string);
        else if (input.value.trim()) pick(input.value);
      } else if (ev.key === 'Escape' && !list.hidden) {
        ev.preventDefault();
        ev.stopPropagation();
        open(false);
      } else if (ev.key === 'Backspace' && !input.value && own.length) {
        // the last VLAN goes (one undo step)
        ev.preventDefault();
        const last = chips.querySelector('.vlan-chip:last-child [data-act="vlan-remove"]') as HTMLElement | null;
        if (last) last.click();
      }
    });
    const switchPort = capabilities({ type: type }).switchFeatures && !routed;
    const label = `VLANs${switchPort ? ' *' : ''}`;
    const help = routed ? 'A routed port has no VLANs.' : 'One VLAN: access (untagged). Several: a trunk, tagged except its native VLAN.';
    const ctl = this.e('span', { class: 'ctl combo vlan-combo' }, [chips, input, list]);
    const f = this.field(label, ctl, vp, help);
    const helpEl = f.querySelector('.help');
    if (helpEl) helpEl.id = uid + '-help';
    // the mode badge beside the label (its words say it)
    const badge = this.modeBadge(l2);
    if (badge) f.insertBefore(badge, f.children[1] || null);
    box.appendChild(f);
    // a trunk's native VLAN
    if (ownIds.length > 1 || doc.get(p.concat('native'))) {
      const cur = doc.text(p.concat('native')) || '';
      const sel = this.e('select', { 'data-p': J(p.concat('native')), 'data-t': 'vlan-native', 'data-o': entry.kind, 'aria-label': `Native VLAN of ${id}` }) as HTMLSelectElement;
      sel.appendChild(this.e('option', { value: '' }, ['None: every VLAN tagged']));
      if (cur && ownIds.indexOf(Number(cur)) < 0) sel.appendChild(this.e('option', { value: cur }, [`${cur} (not one of its VLANs)`]));
      if (ownIds.length <= 400) for (const v of ownIds) sel.appendChild(this.e('option', { value: String(v) }, [`VLAN ${v}`]));
      sel.value = cur;
      box.appendChild(this.field('Native VLAN', sel, p.concat('native'), 'Untagged on the trunk; every other VLAN is tagged.'));
    }
    // a Layer 3 switch's routed port
    if (l3switch || routed) {
      const cb = this.e('input', { type: 'checkbox', id: uid + '-routed', 'data-act': 'port-routed', 'data-p': J(p) }) as HTMLInputElement;
      cb.checked = routed;
      const why = own.length && !routed ? 'Setting it to routed removes its VLANs (one undo step).' : 'A Layer 3 interface: no VLANs, it may have addresses.';
      box.appendChild(this.e('div', { class: 'field' }, [this.e('label', { class: 'check', for: uid + '-routed', title: why }, [cb, ' Routed port']), this.e('div', { class: 'help' }, [why])]));
    }
    // suggestions: the same as a neighbouring port, or as the connected port
    const sugg = this.vlanSuggestions(devIndex, p, id);
    if (sugg.length && !routed) {
      const row = this.e('div', { class: 'helpers', role: 'group', 'aria-label': `Suggestions for the VLANs of ${id}` });
      for (const s of sugg) row.appendChild(this.e('button', { type: 'button', class: 'chip', 'data-act': 'vlan-copy', 'data-index': String(devIndex), 'data-id': id, 'data-v': s.vlans, 'data-n': s.native, title: s.title }, [s.label]));
      box.appendChild(row);
    }
    return box;
  }

  /** "Same as <the port before it>" and "Like the connected port", when they would change something. */
  private vlanSuggestions(devIndex: number, p: Path, id: string): Array<{ label: string; title: string; vlans: string; native: string }> {
    const model = this.doc.result.model;
    const devId = this.doc.text(['devices', devIndex, 'id']) || '';
    const d = model ? model.index.devices.get(devId) : undefined;
    if (!model || !d || !id) return [];
    const mine = portL2(model, devId, id);
    const same = (l: PortL2): boolean => !!mine && mine.vlans.join(',') === l.vlans.join(',') && mine.native === l.native;
    const out: Array<{ label: string; title: string; vlans: string; native: string }> = [];
    // the nearest port before it (by name) that has VLANs of its own
    const ports = sortedByName(d.interfaces.filter((x) => x.id !== id && x.vlans.length > 0 && lagOf(model, devId, x.id) === undefined), (x) => x.id);
    const before = ports.filter((x) => compareNames(x.id, id) < 0);
    const near = before.length ? before[before.length - 1] : ports[0];
    if (near) {
      const l = portL2(model, devId, near.id) as PortL2;
      if (!same(l)) out.push({ label: `Same as ${near.id}`, title: `${portBadgeText(l)}, like ${near.id}`, vlans: vlanRangesText(l.vlans), native: l.native !== undefined ? String(l.native) : '' });
    }
    // the port at the other end of its cable
    const lid = model.index.ifaceLink.get(ifaceKey(devId, id));
    const lk = lid !== undefined ? model.index.links.get(lid) : undefined;
    if (lk) {
      const far = lk.a.device === devId && lk.a.iface === id ? lk.b : lk.a;
      const fl = endL2(model, far);
      if (fl && isBridgePort(fl) && !same(fl)) out.push({ label: `VLANs of the connected port`, title: `${far.device}:${far.iface}: ${portBadgeText(fl)}`, vlans: vlanRangesText(fl.vlans), native: fl.native !== undefined ? String(fl.native) : '' });
    }
    return out;
  }

  /** A VLAN interface's bridge ports, read-only, by mode; each a link to its port. Replaces "Ports carrying its VLAN". */
  private bridgePortsField(devIndex: number, p: Path): HTMLElement {
    const doc = this.doc;
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']);
    const id = doc.text(p.concat('id'));
    const help = 'Every port of this device whose VLANs include its VLAN (set on the ports).';
    const inf = model && dev && id ? model.index.interfaces.get(ifaceKey(dev, id)) : undefined;
    if (!model || !inf) return this.derivedField('Bridge ports', 'bridge-ports', [this.e('span', { class: 'muted' }, ['Not available while this interface has errors.'])], help);
    const vlans = interfaceVlans(model, inf);
    const parent = subinterfaceParent(model, inf);
    if (parent !== undefined) {
      return this.derivedField(`Subinterface of`, 'bridge-ports', [this.e('button', { type: 'button', class: 'ref', 'data-goto': `iface:${inf.device}:${parent}` }, [parent]), this.e('span', { class: 'ro small' }, [` VLAN ${vlans.join(', ')} tagged`])], 'Its name says its port (port.number): its VLAN is 802.1Q-tagged there.');
    }
    const g = vlanPortsByMode(model, inf);
    const groups: HTMLElement[] = [];
    for (const [label, ids] of [['Access', g.access], ['Trunk', g.trunk]] as Array<[string, string[]]>) {
      if (!ids.length) continue;
      const row = this.e('li', { 'data-mode': label.toLowerCase() }, [this.e('span', { class: 'ro' }, [label + ': '])]);
      portRuns(ids).forEach((r, k) => {
        if (k) row.appendChild(this.e('span', {}, [', ']));
        row.appendChild(this.e('button', { type: 'button', class: 'ref', 'data-goto': `iface:${inf.device}:${r.first}`, 'data-port': r.first }, [r.last !== undefined ? r.first : r.text]));
        if (r.last !== undefined) {
          row.appendChild(this.e('span', {}, ['–']));
          row.appendChild(this.e('button', { type: 'button', class: 'ref', 'data-goto': `iface:${inf.device}:${r.last}`, 'data-port': r.last, 'aria-label': r.last }, [r.text.slice(r.text.indexOf('–') + 1)]));
        }
      });
      groups.push(row);
    }
    const body = groups.length ? [this.e('ul', { class: 'derived-list bridge-ports' }, groups)] : [this.e('span', { class: 'muted' }, [`No port of this device has VLAN ${vlans.join(', ')}.`])];
    return this.derivedField(`Bridge ports (VLAN ${vlans.join(', ')})`, 'bridge-ports', body, help);
  }

  /**
   * Assign VLANs to ports…: a range of ports (written as for "+ Port
   * Range": first and last name; one name for one port), the VLANs and the
   * native VLAN; a preview says which ports change. Applied as one undo
   * step; Cancel, or a range with a port the device doesn't have, changes
   * nothing.
   */
  private async assignVlans(devIndex: number): Promise<void> {
    const doc = this.doc;
    const ports = doc.interfaceEntries(devIndex).filter((e) => e.kind === 'interface' && !!e.id).map((e) => e.id as string);
    const from = this.e('input', { type: 'text', id: 'assign-from', spellcheck: 'false', autocomplete: 'off', placeholder: ports[0] || 'Gi1/0/1' }) as HTMLInputElement;
    const to = this.e('input', { type: 'text', id: 'assign-to', spellcheck: 'false', autocomplete: 'off', placeholder: '(one port: leave empty)' }) as HTMLInputElement;
    const vl = this.e('input', { type: 'text', id: 'assign-vlans', spellcheck: 'false', autocomplete: 'off', placeholder: '10, or 10, 20, 30-39' }) as HTMLInputElement;
    const nat = this.e('input', { type: 'text', id: 'assign-native', spellcheck: 'false', autocomplete: 'off', inputmode: 'numeric', placeholder: '(none: every VLAN tagged)' }) as HTMLInputElement;
    const preview = this.e('div', { id: 'assign-preview', class: 'range-preview', role: 'status', 'aria-live': 'polite' });
    let apply: HTMLButtonElement | null = null;
    const plan = (): { ok: true; ids: string[] } | { ok: false; error: string } => {
      const a = from.value.trim();
      const b = to.value.trim();
      if (!a) return { ok: false, error: 'Enter the first port (and the last one for a range).' };
      let ids: string[];
      if (!b || b === a) ids = [portIdFor(a)];
      else {
        const r = portRange(a, b);
        if (!r.ok) return r;
        ids = r.ports.map((x) => x.id);
      }
      const missing = ids.filter((x) => ports.indexOf(x) < 0);
      if (missing.length) return { ok: false, error: `Not a port of this device: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}. Nothing is changed.` };
      if (!vl.value.trim()) return { ok: false, error: 'Enter the VLANs: one (access ports) or several (trunks).' };
      return { ok: true, ids };
    };
    const refresh = (): void => {
      while (preview.firstChild) preview.removeChild(preview.firstChild);
      const pl = plan();
      preview.setAttribute('data-state', pl.ok ? 'ok' : 'error');
      if (pl.ok) {
        const n = vl.value.split(/[,\s]+/).filter((x) => !!x);
        const kind = n.length === 1 && !/-/.test(n[0]) ? `access ports in VLAN ${n[0]}` : `trunks of ${vl.value.trim()}${nat.value.trim() ? ` (native ${nat.value.trim()})` : ''}`;
        preview.appendChild(this.e('div', { class: 'range-count' }, [`${pl.ids.length} port${pl.ids.length === 1 ? '' : 's'} become ${kind}:`]));
        preview.appendChild(this.e('div', { class: 'range-list ro' }, [portRuns(pl.ids).map((r) => r.text).join(', ')]));
      } else preview.appendChild(this.e('div', { class: 'field-err' }, [pl.error]));
      if (apply) apply.disabled = !pl.ok;
    };
    const answer = await this.host.dialog({
      title: `Assign VLANs to ports of ${this.devName(devIndex)}`,
      body: [
        this.e('div', { class: 'range-form' }, [this.e('label', { class: 'dl-label' }, ['From ', from]), this.e('label', { class: 'dl-label' }, ['To ', to])]),
        this.e('div', { class: 'range-form' }, [this.e('label', { class: 'dl-label' }, ['VLANs ', vl]), this.e('label', { class: 'dl-label' }, ['Native VLAN ', nat])]),
        preview,
        this.e('p', { class: 'muted small' }, ['Their VLANs are replaced; one VLAN makes access ports, several make trunks. You can undo this with Ctrl+Z.']),
      ],
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Assign', value: 'assign', kind: 'primary' },
      ],
      ready: (dialog) => {
        apply = dialog.querySelector('[data-value="assign"]') as HTMLButtonElement | null;
        for (const input of [from, to, vl, nat]) {
          input.addEventListener('input', refresh);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && apply && !apply.disabled) {
              e.preventDefault();
              apply.click();
            }
          });
        }
        refresh();
        from.focus();
      },
    });
    if (answer !== 'assign') return;
    const pl = plan();
    if (!pl.ok) {
      this.host.toast(pl.error);
      return;
    }
    const r = doc.assignPortVlans(devIndex, pl.ids, vl.value, nat.value.trim());
    if (!r.done) {
      this.host.toast(`Not a port of this device: ${r.missing.join(', ')}. Nothing is changed.`);
      return;
    }
    this.host.changed(`VLANs ${vl.value.trim()} assigned to ${r.done} port${r.done === 1 ? '' : 's'} of ${this.devName(devIndex)}.`);
  }

  /**
   * One end of a link: the port it plugs into and what that port is set to
   * (speed, duplex). Its VLANs are the port's (set on the port's card):
   * shown here read-only, with the networks of those VLANs.
   */
  private endPortField(endPath: Path, side: string): HTMLElement {
    const doc = this.doc;
    const hasEnd = !!this.epParts(endPath).device;
    const box = this.e('div', { class: 'tag-ed', 'data-tag-end': side });
    if (!hasEnd) {
      box.appendChild(this.e('span', { class: 'muted small' }, ['Choose the device of this end first.']));
      return this.field(`End ${side}: port`, box, endPath.concat('speed'));
    }
    const speed = this.input(endPath.concat('speed'), 'end-text', doc.text(endPath.concat('speed')) || '', { 'data-k': 'speed', placeholder: 'e.g. 1G (the cable’s speed: on the link)', 'aria-label': `Port speed at end ${side}` });
    box.appendChild(this.field('Port speed', speed, endPath.concat('speed')));
    const dpx = this.e('select', { 'data-p': J(endPath), 'data-t': 'end-duplex', 'aria-label': `Duplex at end ${side}` }) as HTMLSelectElement;
    const curDpx = doc.text(endPath.concat('duplex')) || '';
    dpx.appendChild(this.e('option', { value: '' }, ['Not modelled']));
    if (curDpx && (DUPLEXES as readonly string[]).indexOf(curDpx) < 0) dpx.appendChild(this.e('option', { value: curDpx }, [curDpx + ' (not a duplex)']));
    for (const x of DUPLEXES) dpx.appendChild(this.e('option', { value: x }, [x === 'auto' ? 'Auto' : x === 'full' ? 'Full' : 'Half']));
    dpx.value = curDpx;
    box.appendChild(this.field('Duplex', dpx, endPath.concat('duplex')));
    const model = doc.result.model;
    const l = model ? model.index.links.get(doc.text([endPath[0], endPath[1], 'id']) || '') : undefined;
    const end = l ? (endPath[2] === 'a' ? l.a : l.b) : undefined;
    if (model && end && end.iface !== undefined) {
      const l2 = endL2(model, end);
      const nets = endNetworks(model, end);
      const src = l2 && l2.lag !== undefined ? l2.lag : end.iface;
      box.appendChild(
        this.derivedField(
          'VLANs (of the port)',
          'end-vlans',
          [
            this.modeBadge(l2) || this.e('span', { class: 'muted' }, ['No VLANs (untagged)']),
            this.e('span', {}, [' ']),
            this.e('button', { type: 'button', class: 'ref', 'data-goto': `iface:${end.device}:${src}` }, [`set on ${end.device}:${src}`]),
            nets.length ? this.e('div', { class: 'ro small' }, ['Networks: ' + nets.map((n) => (model.index.networks.get(n) as { label: string }).label).join(', ')]) : null,
          ],
          'What the cable carries here follows from the port’s VLANs.',
        ),
      );
    }
    const node = doc.get(endPath);
    if (node && node.kind === 'map') box.appendChild(this.otherProps(endPath, 'linkEnd'));
    return this.e('div', { class: 'field tag-field', 'data-tagging': side }, [this.e('label', {}, [`End ${side}: port`]), box]);
  }

  /** How the two ports of a cable disagree, shown but never repaired. */
  private tagMismatchNote(linkIndex: number): HTMLElement {
    const model = this.doc.result.model;
    const l = model ? model.index.links.get(this.doc.text(['links', linkIndex, 'id']) || '') : undefined;
    const mm = l && model ? tagMismatch(model, l) : null;
    if (!mm) return this.e('div', { class: 'net-match', 'data-tag-mismatch': 'no' });
    return this.e('div', { class: 'net-mismatch-note field-warn', 'data-tag-mismatch': 'yes', role: 'status' }, ['⚠ The two ports disagree (' + tagMismatchText(mm) + '). Nothing is changed automatically.']);
  }

  // ------------------------------------------------------------ static routes

  /**
   * The static routes of a device, after its interfaces and DNS names: a
   * card per route, in display order (VRF, destination, distance; the file
   * keeps its order). A device whose type has no routing table offers none.
   */
  private renderRoutes(w: HTMLElement, devIndex: number): void {
    const doc = this.doc;
    const entries = doc.routeEntries(devIndex);
    const allowed = deviceRoutingRole(this.likeAt(['devices', devIndex])) !== null;
    if (!allowed && !entries.length) {
      w.appendChild(
        this.e('section', { class: 'sub', 'data-list': 'routes' }, [
          this.e('div', { class: 'sub-head' }, [this.e('h4', {}, ['Static routes'])]),
          this.e('p', { class: 'muted small', title: `Static routes are for ${ROUTE_DEVICE_TYPES.join(', ')} devices.` }, ['This device type has no routing table.']),
        ]),
      );
      return;
    }
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']) || '';
    const md = model ? model.index.devices.get(dev) : undefined;
    const order = (e: RouteEntry): string => {
      const r = md ? md.routes.find((x) => x.index === e.index) : undefined;
      return [e.vrf, r ? '0' : '1', e.prefix, e.distance.padStart(3, '0'), e.metric.padStart(10, '0'), e.via, e.iface, String(e.index).padStart(4, '0')].join('|');
    };
    const sorted = entries.slice().sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    const sec = this.e('section', { class: 'sub', 'data-list': 'routes' }, [
      this.e('div', { class: 'sub-head' }, [
        this.e('h4', {}, [`Static routes (${entries.length})`]),
        this.e('span', { class: 'ctl row' }, [this.e('button', allowed ? { type: 'button', class: 'mini', 'data-act': 'add-route', 'data-index': String(devIndex), title: 'Add a static route to this device' } : { type: 'button', class: 'mini', disabled: '', title: 'This device type has no routing table' }, ['+ Route'])]),
      ]),
      entries.length ? null : this.e('p', { class: 'muted small' }, ['Prefix and next hop. A default gateway is a route to 0.0.0.0/0 or ::/0.']),
    ]);
    const n = doc.get(['devices', devIndex, 'routes']);
    if (n && n.kind !== 'seq' && !(n.kind === 'scalar' && n.value === null)) sec.appendChild(this.e('p', { class: 'field-err' }, ['"routes" is not a list; fix it in the YAML tab.']));
    for (const e of sorted) sec.appendChild(this.routeCard(devIndex, e));
    w.appendChild(sec);
  }

  private routeCard(devIndex: number, e: RouteEntry): HTMLElement {
    const doc = this.doc;
    const p = e.path;
    const iss = doc.issuesAt(p);
    const errs = iss.filter((i) => i.severity === 'error').length;
    const nextHop = e.blackhole ? 'blackhole' : [e.via ? 'via ' + e.via : '', e.iface ? 'dev ' + e.iface : ''].filter((x) => x).join(' ') || '(no next hop)';
    const summary = [e.prefix || '(no prefix)', nextHop, e.distance ? 'AD ' + e.distance : '', e.vrf ? 'VRF ' + e.vrf : '', e.name].filter((x) => !!x).join(' · ');
    const card = this.e('details', { class: 'card route-card' + (errs ? ' has-err' : ''), 'data-card': J(p), 'data-route': String(e.index) });
    const selected = !!this.sel && !!this.sel.route && J(this.sel.route) === J(p);
    if (this.open.has(J(p)) || selected) card.setAttribute('open', '');
    card.appendChild(
      this.e('summary', {}, [
        this.e('span', { class: 'card-title' }, [summary]),
        iss.length ? this.badge(errs, iss.length - errs) : null,
        this.e('button', { type: 'button', class: 'mini', 'data-act': 'dup-route', 'data-index': String(devIndex), 'data-k': String(e.index), title: 'Duplicate this route (e.g. for a backup with another distance)', 'aria-label': `Duplicate route ${e.prefix}` }, ['⧉']),
        this.e('button', { type: 'button', class: 'mini danger', 'data-act': 'del-route', 'data-index': String(devIndex), 'data-k': String(e.index), title: 'Delete this route', 'aria-label': `Delete route ${e.prefix}` }, ['×']),
      ]),
    );
    const node = doc.get(p);
    if (!node || node.kind !== 'map') {
      card.appendChild(this.e('div', { class: 'field-err' }, ['This entry is not a mapping with "prefix:" and a next hop; fix it in the YAML tab or delete it.']));
      return card;
    }
    const o = 'route';
    const rm = doc.result.model;
    const rdev = doc.text(['devices', devIndex, 'id']) || '';
    const rname = `route ${e.prefix || '(new)'} of ${rdev}`;
    card.appendChild(this.withHelpers(this.textField(p.concat('prefix'), 'Destination prefix', o, 'text', undefined, 'IPv4 or IPv6 prefix; 0.0.0.0/0 or ::/0 for a default route.', '10.0.0.0/8'), p.concat('prefix'), 'text', rm ? routePrefixSuggestions(rm, rdev, e.prefix) : [], 'destination prefix', rname));
    // the blackhole switch: a route either has a next hop or drops the traffic
    const sw = this.e(
      'button',
      { type: 'button', class: 'mini dhcp-switch' + (e.blackhole ? ' on' : ''), role: 'switch', 'aria-checked': e.blackhole ? 'true' : 'false', 'data-act': 'blackhole', 'data-p': J(p), title: e.blackhole ? 'Make the route forward again (then enter its next hop)' : 'Make this a blackhole (null) route: its next hop is removed' },
      ['Blackhole ', this.e('span', { class: 'dhcp-state' }, [e.blackhole ? 'on' : 'off'])],
    );
    card.appendChild(this.field('Blackhole (null route)', sw, p.concat('blackhole'), e.blackhole ? 'Traffic to the prefix is dropped.' : undefined));
    if (!e.blackhole) {
      const model = doc.result.model;
      const dev = doc.text(['devices', devIndex, 'id']) || '';
      const cands = model ? nextHopCandidates(model, dev, vrfKey(e.vrf)) : [];
      card.appendChild(this.textField(p.concat('via'), 'Next-hop address', o, 'text', cands.map((c) => c.address), cands.length ? 'Suggestions: neighbours in this device’s networks.' : 'An address in a network of this device, or one a route resolves.', 'Address'));
      const ifs = sortedByName(doc.interfaceEntries(devIndex).filter((x) => !!x.id), (x) => x.id as string).map((x) => x.id as string);
      card.appendChild(this.refField(p.concat('interface'), 'Exit interface', o, ifs, 'Optional with an address; alone for a point-to-point or tunnel interface.'));
    }
    card.appendChild(this.withHelpers(this.intField(p.concat('distance'), 'Administrative distance (1–255)', o, 'Empty: route selection takes 1. A higher distance makes a floating (backup) route.'), p.concat('distance'), 'int', distanceSuggestions(e.distance), 'administrative distance', rname));
    card.appendChild(this.intField(p.concat('metric'), 'Metric', o, 'Optional: among routes with the same distance, the lower metric is used.'));
    const model = doc.result.model;
    const dev = doc.text(['devices', devIndex, 'id']) || '';
    card.appendChild(this.vrfField(p.concat('vrf'), model && dev ? rname : 'route', 'Empty: the default table.'));
    card.appendChild(this.textField(p.concat('name'), 'Name', o));
    card.appendChild(this.textField(p.concat('description'), 'Description', o, 'textarea'));
    card.appendChild(this.attrsField(p.concat('attrs'), 'Attributes (attrs)', o));
    card.appendChild(this.otherProps(p, o));
    return card;
  }

  /**
   * "+ Route": a new, empty route (one undo step), selected with its card
   * open. Nothing is filled in for the user: the card shows what is still
   * missing (the destination prefix and the next hop).
   */
  private addRoute(devIndex: number): void {
    const k = this.doc.addRoute(devIndex, [['prefix', '']]);
    const path: Path = ['devices', devIndex, 'routes', k];
    this.didCreate(path, `Route added to ${this.devName(devIndex)} — enter its destination prefix and next hop.`, this.d.querySelector('[data-act="add-route"]'), { sel: { kind: 'device', index: devIndex, route: path } });
  }

  /**
   * A relation's direction as a two-way switch.  /**
   * A relation's direction as a two-way switch. Bidirectional is the default
   * and is not written; unidirectional runs from the first endpoint to the
   * last, so the endpoint order matters (↑ reorders).
   */
  /** A relation's direction, or a link's (`link`: from end A to end B). */
  private directionField(p: Path, link = false): HTMLElement {
    const cur = this.doc.text(p);
    const on = cur === undefined ? 'bidirectional' : cur;
    const valid = (DIRECTIONS as readonly string[]).indexOf(on) >= 0;
    const label: { [k in Direction]: string } = { bidirectional: 'Bidirectional', unidirectional: 'Unidirectional' };
    const sw = this.e(
      'div',
      { class: 'seg dir-switch', role: 'radiogroup', 'aria-label': 'Direction', 'data-direction': valid ? on : 'invalid' },
      DIRECTIONS.map((d) =>
        this.e('button', { type: 'button', class: 'mini' + (d === on ? ' active' : ''), role: 'radio', 'aria-checked': d === on ? 'true' : 'false', 'data-act': 'direction', 'data-p': J(p), 'data-k': d }, [label[d]]),
      ),
    );
    const help = link
      ? on === 'unidirectional'
        ? 'End A → End B only (simplex fibre, a data diode, a TAP or SPAN feed), with an arrow; traffic is never traced the other way. Swap the ends to turn it.'
        : 'The default. Unidirectional: End A → End B only (simplex fibre, a data diode, a TAP or SPAN feed).'
      : on === 'unidirectional'
        ? 'First endpoint → last, with an arrow. Reorder with ↑ to turn it.'
        : 'The default. Unidirectional: first endpoint → last (e.g. syslog).';
    return this.field('Direction', sw, p, valid ? help : `"${on}" is not a direction: choose one.`);
  }

  /** The network's one prefix. */
  private cidrField(p: Path, order: string): HTMLElement {
    const n = this.doc.get(p);
    if (n && n.kind !== 'scalar') {
      // a list from a file: shown, with the error, so it can be fixed in the YAML tab
      return this.field('IP network (CIDR)', this.generic(p, n, 0), p, 'A network has exactly one prefix. Keep one here and make a network for each other prefix.');
    }
    return this.field(
      'IP network (CIDR)',
      this.input(p, 'text', this.doc.text(p) || '', { 'data-o': order, placeholder: '192.0.2.0/24 or 2001:db8::/64' }),
      p,
      'Required: exactly one IPv4 or IPv6 prefix. Every device with a configured address inside it is a member.',
    );
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
    const devSel = this.selectEl(p, 'ep-dev', order, this.endpointDevices(p, device), device, '(device)');
    const ifSel = this.e('select', { 'data-p': J(p), 'data-t': 'ep-if', 'data-o': order }) as HTMLSelectElement;
    ifSel.appendChild(this.e('option', { value: '' }, ['(whole device)']));
    const opts = this.ifaceOptions(device, order === 'link');
    if (iface && !opts.some((o) => o.id === iface)) ifSel.appendChild(this.e('option', { value: iface }, [iface + ' (missing!)']));
    for (const o of opts) ifSel.appendChild(this.e('option', { value: o.id }, [o.label]));
    ifSel.value = iface;
    return this.e('span', { class: 'ctl row' }, [devSel, ifSel]);
  }

  private endpointField(p: Path, label: string, order: string, _ext: boolean): HTMLElement {
    const f = this.field(label, this.epControls(p, order), p, undefined);
    f.appendChild(this.bindingNote(p, order === 'link'));
    return f;
  }

  /**
   * Where the diagram attaches an endpoint: the port of the interface it
   * names, or the device-level port (a relation) / the device itself (a
   * cable). Marked as an end of the selection in the Edit tab (markSelection).
   */
  private bindingNote(p: Path, cable: boolean): HTMLElement {
    const { device, iface } = this.epParts(p);
    const text = !device
      ? ''
      : iface
        ? cable
          ? `Plugged into the port ${iface} of ${device}.`
          : `Drawn from the port of ${iface} on ${device} (beside its row; its name is the end label).`
        : cable
          ? `Plugged into ${device} as a whole (no port named): a hollow end in the diagram.`
          : `Bound to ${device} as a whole: drawn from its device-level port, beside its name.`;
    return this.e('div', { class: 'ep-bind small muted', 'data-end': iface ? `iface:${device}:${iface}` : 'device:' + device }, [this.e('span', { 'aria-hidden': 'true' }, ['↔ ']), text]);
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
        this.bindingNote(ip, false),
      ]);
      // an endpoint is a device and, optionally, one of its interfaces; keys a file adds beyond that are shown so they can be removed
      if (it.kind === 'map') rowEl.appendChild(this.otherProps(ip, 'endpoint'));
      for (const is of iss) rowEl.appendChild(this.e('div', { class: is.severity === 'error' ? 'field-err' : 'field-warn' }, [is.message]));
      box.appendChild(rowEl);
    });
    if (n && n.kind !== 'seq' && !(n.kind === 'scalar' && n.value === null)) box.appendChild(this.e('div', { class: 'field-err' }, ['Not a list; fix it in the YAML tab.']));
    box.appendChild(this.selectEl(p, 'ep-append', order, this.endpointDevices(p.concat(0), ''), '', '+ add endpoint (device)…'));
    const why = this.layer3Note(p.concat(0));
    if (why) box.appendChild(this.e('p', { class: 'muted small' }, [why]));
    return this.field(label, box, p.length ? [] : p);
  }

  /** The relation an endpoint path belongs to needs Layer 3 at every end (OSPF, BGP, VRRP, a tunnel …)? */
  private endpointNeedsLayer3(p: Path): boolean {
    if (p[0] !== 'relations' || typeof p[1] !== 'number') return false;
    const proto = this.doc.text(['relations', p[1], 'protocol']) || '';
    const model = this.doc.result.model;
    const base = model ? protocolBase(model.protocols, normalizeProtocol(proto)) : normalizeProtocol(proto);
    const cat = this.doc.text(['relations', p[1], 'category']) || (model && proto ? lookupProtocol(model.protocols, proto).category : '');
    return relationNeedsLayer3(base, cat);
  }

  /** The devices an endpoint may name: every device, but no Layer 2 switch for a relation that needs Layer 3 (the current one stays). */
  private endpointDevices(p: Path, current: string): string[] {
    if (!this.endpointNeedsLayer3(p)) return this.deviceIds();
    return this.deviceIds().filter((id) => id === current || !this.isL2Switch(id));
  }

  private isL2Switch(id: string): boolean {
    const model = this.doc.result.model;
    const d = model ? model.index.devices.get(id) : undefined;
    return !!d && isLayer2Switch(d);
  }

  /** Why Layer 2 switches are not offered as endpoints ('' when they are, or there are none). */
  private layer3Note(p: Path): string {
    if (!this.endpointNeedsLayer3(p)) return '';
    const l2 = this.deviceIds().filter((id) => this.isL2Switch(id));
    if (!l2.length) return '';
    return `Not offered: ${l2.join(', ')} (Layer 2 switch${l2.length === 1 ? '' : 'es'}; this protocol requires Layer 3 — tick Supports Layer 3 on the switch first).`;
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
    return this.field(label, box, p, 'What it rides on: cables, networks or relations (e.g. GRE over IPsec).');
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
    box.appendChild(this.e('p', { class: 'muted small' }, ['Kept and exported as they are, but reported as errors: move them into attrs, rename or delete them.']));
    for (const k of extra) {
      const vp = base.concat(k);
      box.appendChild(
        this.e('div', { class: 'g-row' }, [
          this.input(base, 'g-key', k, { 'data-k': k, class: 'g-key' }),
          this.generic(vp, (n.entries.get(k) as { value: DocNode }).value, 1),
          kind !== 'document' && kind !== 'endpoint' && kind !== 'linkEnd' ? this.e('button', { type: 'button', class: 'mini', 'data-act': 'to-attrs', 'data-p': J(base), 'data-k': k, title: 'Move into attrs' }, ['→ attrs']) : null,
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
    // a draft's values stay in the draft until it is created
    if (t === 'draft') {
      this.draftInput(target);
      return true;
    }
    const doc = this.getDoc();
    if (!doc) return true;
    const p = P(target.getAttribute('data-p'));
    const val = (target as HTMLInputElement).value;
    const trimmed = typeof val === 'string' ? val.trim() : '';
    let note: string | undefined;
    /** an entry this change created (it is marked, revealed and, while the control still has the focus, focused) */
    let made: Path | null = null;
    switch (t) {
      case 'sim-attr':
        return this.simAttrChange(target, doc, trimmed);
      case 'add-service': {
        if (!val) return true;
        const di = Number(target.getAttribute('data-index'));
        const def = serviceDef(val);
        if (!def) return true;
        if (val === 'applications') {
          const k = doc.addApplication(di);
          made = doc.appsPath(di).concat(k, 'profile');
          note = `Application ${doc.text(doc.appsPath(di).concat(k, 'id')) || ''} added to ${this.devName(di)}: choose its profile.`;
          break;
        }
        if (val === 'dhcp' || val === 'dns' || val === 'hypervisor' || val === 'container_engine') doc.setNetService(di, val, true);
        else doc.addBlock(p.concat(val), def.label);
        made = p.concat(val);
        note = `${def.label} added: fill in what it needs (nothing is chosen for you).`;
        break;
      }
      case 'dev-model': {
        // a type, mode, purpose or implementation: what the device could no longer have is listed first
        void this.changeDeviceModel(Number(target.getAttribute('data-index')), target.getAttribute('data-key') as DeviceModelKey, val);
        return true;
      }
      case 'sep-direction': {
        const box = target as HTMLInputElement;
        doc.setSepDirection(p, target.getAttribute('data-from') as string, target.getAttribute('data-to') as string, box.checked);
        note = box.checked ? `${target.getAttribute('data-from')} → ${target.getAttribute('data-to')} is a permitted direction now (its rules say what may pass).` : `${target.getAttribute('data-from')} → ${target.getAttribute('data-to')} is no longer permitted: nothing passes that way.`;
        break;
      }
      case 'snooping': {
        const key = target.getAttribute('data-key') as string;
        doc.setSnooping(Number(target.getAttribute('data-index')), key, val as '' | 'enabled' | 'disabled');
        note = `IGMP / MLD snooping of VLAN ${key.replace('-', '–')}: ${val || 'not configured (an error until chosen)'}.`;
        break;
      }
      case 'text':
        doc.setText(p, target.tagName === 'TEXTAREA' ? val.replace(/\s+$/, '') : trimmed);
        break;
      case 'int':
        doc.setInteger(p, trimmed);
        break;
      case 'pg-vlans':
        // a port group's VLANs, written as a port's (merged ranges; a native VLAN that no longer fits goes)
        doc.setPortVlans(p.slice(0, -1), trimmed);
        break;
      case 'yesno':
        doc.setYesNo(p, trimmed as '' | 'true' | 'false');
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
      case 'app-profile': {
        const gone = doc.setAppProfile(p.slice(0, -1), val);
        note = val ? `Profile: ${(appProfile(val) || { label: val }).label}${gone.length ? ` (${gone.join(', ')} removed: not part of it)` : ''}.` : undefined;
        break;
      }
      case 'app-id': {
        const di = p[1] as number;
        const k = p[4] as number;
        const cur = doc.text(p) || '';
        if (trimmed === cur) return true;
        if (!ID_RE.test(trimmed)) {
          this.host.toast('An application id is letters, digits, “_”, “.” and “-”.');
          this.host.changed();
          return true;
        }
        if (doc.appIds(di).some((x, j) => j !== k && x === trimmed)) {
          this.host.toast(`${this.devName(di)} already has an application “${trimmed}”.`);
          this.host.changed();
          return true;
        }
        const n = doc.renameApplication(di, k, trimmed);
        note = n ? `Renamed; ${n} peer${n > 1 ? 's' : ''} updated.` : undefined;
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
        made = this.lastItem(p);
        note = `Member port ${val} added.`;
        break;
      case 'dns-iface-append':
        if (!val) return true;
        doc.appendText(p, val, 'Associate interface with DNS name');
        made = this.lastItem(p);
        note = `Interface ${val} associated with the DNS name.`;
        break;
      case 'list-item':
      case 'list-scalar':
        doc.setText(p, trimmed);
        break;
      case 'list-append':
        if (trimmed === '') return true;
        doc.appendText(p, trimmed);
        made = this.lastItem(p);
        note = `${p[p.length - 1] === 'ip' ? 'Address' : 'Entry'} ${trimmed} added.`;
        break;
      case 'vlan-combo': {
        // a VLAN, a range or a list typed or picked: added to the port's VLANs
        if (!trimmed) return true;
        const port = p.slice(0, -1);
        doc.setPortVlans(port, doc.portVlans(port).concat([trimmed]).join(','));
        note = `VLAN ${trimmed} added to ${doc.text(port.concat('id')) || 'the port'}.`;
        break;
      }
      case 'vlan-native':
        doc.setPortNative(p.slice(0, -1), val);
        note = val ? `Native VLAN ${val}.` : 'No native VLAN: every VLAN is tagged.';
        break;
      case 'end-duplex':
        doc.setEndText(p, 'duplex', val);
        break;
      case 'end-text':
        doc.setEndText(p.slice(0, -1), target.getAttribute('data-k') === 'duplex' ? 'duplex' : 'speed', trimmed);
        break;
      case 'check-setting':
        doc.setCheck(target.getAttribute('data-k') as string, val);
        break;
      case 'enable-service': {
        if (!val) return true;
        const di = Number(target.getAttribute('data-index'));
        // a Layer 2 switch offers its protocols disabled only: a value that still arrives (a script, a stale form) changes nothing
        if (this.isL2Switch(doc.text(['devices', di, 'id']) || '')) {
          this.host.changed(`Requires Layer 3: ${this.devName(di)} is a Layer 2 switch (tick Supports Layer 3 first).`);
          return true;
        }
        doc.enableService(di, val);
        const def = doc.servicesRegistry().get(val);
        note = `${def ? def.label : val} enabled on ${this.devName(di)}${def && def.params.some((x) => x.required && x.scope === 'device') ? ' — fill in its required parameters' : ''}.`;
        made = ['devices', di, 'protocols', val];
        break;
      }
      case 'over-append':
        if (!val) return true;
        doc.appendText(p, val, 'Add underlay');
        made = this.lastItem(p);
        note = `Underlay ${val} added.`;
        break;
      case 'ep-append':
        if (!val) return true;
        doc.appendText(p, val, 'Add endpoint');
        made = this.lastItem(p);
        note = `Endpoint ${val} added.`;
        break;
      case 'ep-dev':
      case 'ep-if': {
        const cur = this.epParts(p);
        doc.setEndpoint(p, t === 'ep-dev' ? val : cur.device, t === 'ep-dev' ? '' : val);
        break;
      }
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
        made = p.concat(trimmed);
        note = `Attribute “${trimmed}” added — enter its value.`;
        break;
      }
      default:
        return false;
    }
    if (made) this.didCreate(made, note || 'Added.', target, { focus: this.stillFocused(target) });
    else this.host.changed(note);
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
      case 'netsvc': {
        const box = btn as unknown as HTMLInputElement;
        const id = btn.getAttribute('data-svc') as 'dhcp' | 'dns' | 'hypervisor' | 'container_engine';
        const name = id === 'hypervisor' ? 'Hypervisor' : id === 'container_engine' ? 'Container engine' : id === 'dhcp' ? 'DHCP server' : 'DNS server';
        // disabling the service its guests run on: asks first, and lists them (their host references then break and are reported)
        if (!box.checked && (id === 'hypervisor' || id === 'container_engine')) {
          const hostId = doc.text(['devices', index, 'id']) || '';
          const guests = doc.guestsOfHost(hostId).filter((x) => (id === 'hypervisor' ? isVm(x) : isContainer(x)));
          if (guests.length) {
            const answer = await this.host.dialog({
              title: `Disable the ${name} of “${hostId}”?`,
              body: [
                `${guests.length === 1 ? 'This guest runs' : `These ${guests.length} guests run`} on it; ${guests.length === 1 ? 'its host reference' : 'their host references'} will become invalid and will be listed as errors so you can move or delete ${guests.length === 1 ? 'it' : 'them'}:`,
                this.e('ul', { class: 'removal-list' }, guests.map((x) => this.e('li', {}, [`${x.id} (${isVm(x) ? 'VM' : 'container'})`]))),
                ' You can undo this with Ctrl+Z.',
              ],
              buttons: [
                { label: 'Cancel', value: 'cancel' },
                { label: 'Disable', value: 'disable', kind: 'danger' },
              ],
            });
            if (answer !== 'disable') {
              this.host.changed();
              return true;
            }
          }
        }
        doc.setNetService(index, id, box.checked);
        if (box.checked) this.open.add(J(['devices', index, 'services', id]));
        this.host.changed(`${this.devName(index)}: ${name} ${box.checked ? 'on: fill in what it still needs' : 'off'}.`);
        return true;
      }
      case 'add-guest': {
        const t = (btn.getAttribute('data-type') || 'vm') as 'vm' | 'container';
        const i = doc.addGuest(index, t);
        if (i < 0) return true;
        this.didCreate(['devices', i], `Added ${isVm({ type: t }) ? 'VM' : 'container'} “${doc.text(['devices', i, 'id']) || ''}” on ${this.devName(index)}: add its ${isVm({ type: t }) ? 'virtual NICs' : 'network attachments'}.`, btn, { sel: { kind: 'device', index: i } });
        return true;
      }
      case 'pg-guest': {
        const box = btn as unknown as HTMLInputElement;
        doc.setGuestTagging(p, box.checked);
        this.host.changed(box.checked ? 'Guest tagging on: the guests tag their VLANs.' : 'Guest tagging off: give the port group its VLANs.');
        return true;
      }
      case 'remove-service': {
        const id = btn.getAttribute('data-svc') as string;
        const def = serviceDef(id);
        const label = def ? def.label : id;
        const plan = doc.appServiceRemoval(index, id);
        if (plan.values.length || plan.kept.length) {
          const body: Array<string | HTMLElement> = [];
          if (plan.values.length) body.push('Its configuration goes with it:', this.e('ul', { class: 'removal-list' }, plan.values.map((x) => this.e('li', {}, [x]))));
          if (plan.kept.length) body.push('These stay and are reported until you change them:', this.e('ul', { class: 'removal-list' }, plan.kept.map((x) => this.e('li', {}, [x]))));
          body.push('You can undo this with Ctrl+Z.');
          const a = await this.host.dialog({ title: `Remove ${label}?`, body: body as unknown as string[], buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Remove', value: 'go', kind: 'danger' }] });
          if (a !== 'go') return true;
        }
        doc.removeService(index, id, label);
        this.host.changed(`${label} removed.`);
        return true;
      }
      case 'del-wifi': {
        const dev = doc.text(['devices', index, 'id']) || '';
        const net = doc.text(p.concat('id')) || '';
        const clients = net ? doc.networkClients(dev, net) : [];
        if (clients.length) {
          const a = await this.host.dialog({
            title: `Delete the Wi-Fi network ${net}?`,
            body: ['These wireless connections name it; they stay and are reported until you move or delete them:', this.e('ul', { class: 'removal-list' }, clients.map((x) => this.e('li', {}, [x]))) as unknown as string, 'You can undo this with Ctrl+Z.'],
            buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'go', kind: 'danger' }],
          });
          if (a !== 'go') return true;
        }
        doc.remove(p, 'Delete Wi-Fi network');
        this.host.changed(`The Wi-Fi network ${net} was deleted${clients.length ? `; ${clients.length} connection${clients.length === 1 ? '' : 's'} now name${clients.length === 1 ? 's' : ''} a missing network` : ''}.`);
        return true;
      }
      case 'add-app': {
        const k = doc.addApplication(index);
        this.didCreate(doc.appsPath(index).concat(k, 'profile'), `Application ${doc.text(doc.appsPath(index).concat(k, 'id')) || ''} added to ${this.devName(index)}: choose its profile.`, btn);
        return true;
      }
      case 'dup-app': {
        const k = Number(btn.getAttribute('data-k'));
        const j = doc.duplicateApplication(index, k);
        if (j < 0) return true;
        this.didCreate(doc.appsPath(index).concat(j, 'id'), `Duplicated as ${doc.text(doc.appsPath(index).concat(j, 'id')) || ''}: give it its own port or peer where it needs one.`, btn);
        return true;
      }
      case 'del-app': {
        const k = Number(btn.getAttribute('data-k'));
        const dev = doc.text(['devices', index, 'id']) || '';
        const id = doc.text(doc.appsPath(index).concat(k, 'id')) || '';
        const refs = doc.applicationRefTexts(dev, id);
        if (refs.length) {
          const a = await this.host.dialog({
            title: `Remove the application ${dev}/${id}?`,
            body: [`${refs.length === 1 ? 'This application names it as its peer' : `These ${refs.length} applications name it as their peer`}; ${refs.length === 1 ? 'its peer is' : 'their peers are'} removed with it and reported as missing until you choose another:`, this.e('ul', { class: 'removal-list' }, refs.map((x) => this.e('li', {}, [x]))) as unknown as string, 'You can undo this with Ctrl+Z.'],
            buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Remove', value: 'go', kind: 'danger' }],
          });
          if (a !== 'go') return true;
        }
        doc.removeApplication(index, k);
        this.host.changed(`The application ${id} was removed${refs.length ? `; ${refs.length} peer${refs.length === 1 ? '' : 's'} now missing` : ''}.`);
        return true;
      }
      case 'add-block': {
        const what = btn.getAttribute('data-what') || 'configuration';
        doc.addBlock(p, what);
        this.host.changed(`The ${what} was added: fill in what it needs (nothing is chosen for you).`);
        return true;
      }
      case 'add-svc-item': {
        const what = btn.getAttribute('data-what') || 'item';
        doc.addServiceItem(p, what);
        this.open.add(J(p.concat(Math.max(0, ((doc.get(p) as { items?: unknown[] }) || {}).items ? ((doc.get(p) as { items: unknown[] }).items.length - 1) : 0))));
        this.host.changed(`A ${what} was added: fill in what it needs.`);
        return true;
      }
      case 'sim-toggle': {
        const key = btn.getAttribute('data-key') as string;
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        const body = this.d.getElementById(btn.getAttribute('aria-controls') as string);
        if (body) body.hidden = !open;
        if (open) this.open.add(key);
        else this.open.delete(key);
        return true;
      }
      case 'sim-reset': {
        const k = btn.getAttribute('data-k') as string;
        const def = deviceParamByYaml(k);
        doc.setSimAttrAt(p, k, undefined);
        this.host.changed(`${btn.getAttribute('data-name') || ''}: ${def ? def.label : k} is inherited again.`);
        return true;
      }
      case 'draft-create':
        this.createDraft();
        return true;
      case 'draft-cancel':
        this.cancelDraft();
        return true;
      case 'select':
        this.selectEntity(kind, index);
        this.host.changed('select');
        return true;
      case 'fold':
        // fold or unfold one section of the outline (a view state: nothing in the model changes)
        if (this.collapsed.has(kind)) this.collapsed.delete(kind);
        else this.collapsed.add(kind);
        this.refocusOutline(`[data-act="fold"][data-kind="${kind}"]`, () => this.host.changed('filter'));
        return true;
      case 'filter-close':
        this.filter = '';
        this.filterOpen = false;
        this.host.changed('filter');
        return true;
      case 'fold-all':
        this.collapsed = new Set(kind === ('close' as string) ? ENTITY_KINDS : []);
        this.refocusOutline('[data-act="fold-all"]', () => this.host.changed('filter'));
        return true;
      case 'add-entity': {
        this.collapsed.delete(kind);
        const i = doc.addEntity(kind);
        this.leaveDraft(kind);
        this.didCreate([SECTION[kind], i], `Added ${kind} “${doc.entities(kind)[i].id}”. Fill in the highlighted fields.`, btn, { sel: { kind, index: i } });
        return true;
      }
      case 'dup-entity': {
        const i = doc.duplicateEntity(kind, index);
        if (i < 0) {
          this.host.changed();
          return true;
        }
        this.leaveDraft(kind);
        this.didCreate([SECTION[kind], i], `Duplicated as ${kind} “${doc.entities(kind)[i].id}”.`, btn, { sel: { kind, index: i } });
        return true;
      }
      case 'del-entity': {
        const ent = doc.entities(kind)[index];
        const refs = ent && ent.id ? doc.references(kind, ent.id) : [];
        // a host: the guests that run on it are named
        const guests = kind === 'device' && ent && ent.id ? doc.guestsOfHost(ent.id) : [];
        const answer = await this.host.dialog({
          title: `Delete ${kind} “${ent && ent.id ? ent.id : '(no id)'}”?`,
          body: [
            refs.length
              ? `${refs.length} reference${refs.length > 1 ? 's' : ''} to it will become invalid and will be listed as errors so you can fix or remove them.`
              : 'Nothing refers to it.',
            ...(guests.length
              ? [` ${guests.length === 1 ? 'This guest runs' : `These ${guests.length} guests run`} on it (${guests.length === 1 ? 'its host reference breaks' : 'their host references break'}):`, this.e('ul', { class: 'removal-list' }, guests.map((x) => this.e('li', {}, [`${x.id} (${isVm(x) ? 'VM' : 'container'})`])))]
              : []),
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
        const path: Path = ['devices', index, 'interfaces', k];
        this.didCreate(path, `Interface ${doc.text(path.concat('id')) || ''} added to ${this.devName(index)}.`, btn, { sel: { kind: 'device', index, iface: path } });
        return true;
      }
      case 'vlan-remove': {
        const v = btn.getAttribute('data-v') || '';
        doc.setPortVlans(p, doc.portVlans(p).filter((x) => x !== v).join(','));
        this.host.changed(`VLAN ${v} removed from ${doc.text(p.concat('id')) || 'the port'}.`);
        return true;
      }
      case 'vlan-copy': {
        const id = btn.getAttribute('data-id') || '';
        const r = doc.assignPortVlans(index, [id], btn.getAttribute('data-v') || '', btn.getAttribute('data-n') || '');
        this.host.changed(r.done ? `${id}: ${btn.getAttribute('title') || 'VLANs copied'}.` : `Not a port of this device: ${id}.`);
        return true;
      }
      case 'port-routed': {
        const box = btn as unknown as HTMLInputElement;
        doc.setPortRouted(p, box.checked);
        this.host.changed(`${doc.text(p.concat('id')) || 'The port'} is ${box.checked ? 'a routed port (no VLANs)' : 'a switch port again: give it its VLANs'}.`);
        return true;
      }
      case 'assign-vlans':
        void this.assignVlans(index);
        return true;
      case 'add-range':
        await this.addPortRange(index);
        return true;
      case 'add-logical': {
        const type = (btn.getAttribute('data-kind') || 'virtual') as 'loopback' | 'virtual' | 'tunnel' | 'vnic' | 'veth';
        const k = type === 'loopback' ? doc.addLoopback(index, []) : doc.addLogical(index, type, [], type === 'vnic' && mayHostVms({ type: doc.text(['devices', index, 'type']) || '' }) ? 'vmk0' : type === 'vnic' || type === 'veth' ? 'eth0' : undefined);
        const path: Path = ['devices', index, 'logical_interfaces', k];
        const name = `${doc.text(path.concat('id')) || ''} added to ${this.devName(index)}`;
        this.didCreate(path, type === 'loopback' ? `Loopback ${name} — enter its addresses.` : type === 'tunnel' ? `Tunnel interface ${name} — set its source and destination.` : type === 'vnic' ? `Virtual NIC ${name} — choose its port group.` : type === 'veth' ? `Network attachment ${name} — choose its container network.` : `Virtual interface ${name}.`, btn, { sel: { kind: 'device', index, iface: path } });
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
      case 'set-value': {
        // a suggestion chip: one undo step; validation follows as for typing
        const v = btn.getAttribute('data-v') as string;
        const k = btn.getAttribute('data-kind');
        if (k === 'int') doc.setInteger(p, v);
        else if (k === 'ifid') {
          const n = doc.renameInterface(p.slice(0, -1), v);
          this.host.changed(n ? `Renamed; ${n} reference${n > 1 ? 's' : ''} updated.` : undefined);
          return true;
        }
        else doc.setText(p, v);
        this.host.changed();
        return true;
      }
      case 'gen-mac': {
        const model = doc.result.model;
        const cr = this.d.defaultView ? this.d.defaultView.crypto : undefined;
        if (!model || !cr) return true;
        const oui = btn.getAttribute('data-oui');
        doc.setText(p, generateMac(model, (n) => cr.getRandomValues(new Uint8Array(n)), undefined, oui ? oui.split(',').map((x) => Number(x)) : undefined));
        this.host.changed('A MAC address was generated.');
        return true;
      }
      case 'enable-service': {
        const svc = btn.getAttribute('data-svc') as string;
        doc.enableService(index, svc);
        const def = doc.servicesRegistry().get(svc);
        this.didCreate(['devices', index, 'protocols', svc], `${def ? def.label : svc} enabled on ${this.devName(index)}${def && def.params.some((x) => x.required && x.scope === 'device') ? ' — fill in its required parameters' : ''}.`, btn);
        return true;
      }
      case 'layer3': {
        const box = btn as unknown as HTMLInputElement;
        const dev = doc.text(['devices', index, 'id']) || '';
        if (box.checked) {
          doc.setLayer3(index, true);
          this.host.changed(`${dev} is a Layer 3 switch now.`);
          return true;
        }
        const plan = doc.layer2Removal(index);
        if (plan.removed.length || plan.relations.length) {
          const list = this.e('ul', { class: 'removal-list' });
          for (const l of plan.removed) list.appendChild(this.e('li', {}, [l]));
          const rels = this.e('ul', { class: 'removal-list' });
          for (const l of plan.relations) rels.appendChild(this.e('li', {}, [l]));
          const body: string[] = [];
          if (plan.removed.length) body.push('A Layer 2 switch routes nothing. These values are removed with its Layer 3 role (nothing is kept hidden in the model):', list as unknown as string);
          if (plan.relations.length) body.push(`These relations need routing at ${dev}; they stay and are reported until you change them:`, rels as unknown as string);
          body.push('You can undo this with Ctrl+Z.');
          const a = await this.host.dialog({
            title: `Make ${dev} a Layer 2 switch?`,
            body,
            buttons: [
              { label: 'Cancel', value: 'cancel' },
              { label: 'Make it Layer 2', value: 'l2', kind: 'danger' },
            ],
          });
          if (a !== 'l2') {
            box.checked = true;
            return true;
          }
        }
        doc.setLayer3(index, false);
        this.host.changed(`${dev} is a Layer 2 switch now${plan.removed.length ? '; its Layer 3 values were removed' : ''}.`);
        return true;
      }
      case 'disable-service': {
        const svc = btn.getAttribute('data-svc') as string;
        const def = doc.servicesRegistry().get(svc);
        const name = def ? def.label : svc;
        const dev = doc.text(['devices', index, 'id']) || '';
        const lost = doc.serviceRemoval(index, svc);
        if (lost.length) {
          const list = this.e('ul', { class: 'removal-list' });
          for (const l of lost) list.appendChild(this.e('li', {}, [l]));
          const a = await this.host.dialog({
            title: `Disable ${name} on ${dev}?`,
            body: [`These values are removed with it (nothing is kept hidden in the model):`, list as unknown as string, 'You can undo this with Ctrl+Z.'],
            buttons: [
              { label: 'Cancel', value: 'cancel' },
              { label: `Disable ${name}`, value: 'disable', kind: 'danger' },
            ],
          });
          if (a !== 'disable') return true;
        }
        doc.disableService(index, svc);
        this.host.changed(`${name} disabled${lost.length ? '; its values were removed' : ''}.`);
        return true;
      }
      case 'iface-svc-on':
      case 'iface-svc-off': {
        const svc = btn.getAttribute('data-svc') as string;
        doc.setIfaceService(p, svc, act === 'iface-svc-on');
        const def = doc.servicesRegistry().get(svc);
        if (act === 'iface-svc-on') this.didCreate(p.concat('protocols', svc), `${def ? def.label : svc} added on the interface — fill in its group.`, btn);
        else this.host.changed();
        return true;
      }
      case 'add-next-free': {
        // the address is looked up now, from the model as it is
        const model = doc.result.model;
        const field = btn.closest('[data-next-free-field]');
        const sel = field ? (field.querySelector('select[data-next-free]') as HTMLSelectElement | null) : null;
        const pick = model && sel ? nextFreeChoices(model, btn.getAttribute('data-dev') as string, btn.getAttribute('data-iface') as string).find((c) => c.id === sel.value) : undefined;
        if (!pick) return true;
        doc.appendText(p, pick.nextFree);
        this.didCreate(this.lastItem(p), `Address ${pick.nextFree} from ${pick.text} added.`, btn);
        return true;
      }
      case 'direction': {
        const k = btn.getAttribute('data-k');
        // bidirectional is the default: the key is removed
        doc.setText(p, k === 'unidirectional' ? 'unidirectional' : '');
        this.host.changed();
        return true;
      }
      case 'add-route':
        this.addRoute(index);
        return true;
      case 'dup-route': {
        const k = doc.duplicateRoute(index, Number(btn.getAttribute('data-k')));
        if (k < 0) {
          this.host.changed();
          return true;
        }
        const path: Path = ['devices', index, 'routes', k];
        this.didCreate(path, 'Route duplicated: change its next hop or distance.', btn, { sel: { kind: 'device', index, route: path } });
        return true;
      }
      case 'del-route': {
        const k = Number(btn.getAttribute('data-k'));
        doc.deleteRoute(index, k);
        if (this.sel && this.sel.route) this.sel = { kind: 'device', index };
        this.host.selected(this.sel);
        this.host.changed('Route deleted.');
        return true;
      }
      case 'blackhole':
        doc.setBlackhole(p, !(doc.routeEntries(p[1] as number)[p[3] as number] || { blackhole: false }).blackhole);
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
        this.didCreate(this.lastItem(p), 'Item added.', btn);
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

/** Whose Simulation section: a device, an interface, a network (its VLAN) or a relation. */
interface SimOwner {
  /** the entry in the model file */
  path: Path;
  /** the device it inherits from (a VLAN: none) */
  device: string | undefined;
  /** its object reference (a device: none) */
  at: string | null;
  /** for ids */
  idBase: string;
  /** "this device", "this interface", "VLAN 10", "this relation" */
  what: string;
  /** for messages */
  name: string;
  /** a device's own section (its heading level, its id) */
  top?: boolean;
  note?: string;
}

/** The services whose fields this file draws in their own cards (not from their parameters' definitions). */
const OWN_UI = ['dhcp', 'dns', 'hypervisor', 'container_engine', 'vpn', 'separation', 'applications'];

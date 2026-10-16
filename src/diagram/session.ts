/**
 * DOM-free application session: owns the model, cached layouts and view
 * state, and produces render scenes. The browser UI is a thin shell around
 * this, which is what makes view switching testable in Node.
 *
 * Device filter. `state.devices` is the set of devices the diagrams show;
 * null means all of them (the default). While it selects every device, the
 * diagrams show the complete model with its stored positions, exactly as
 * without a filter. While it selects a proper subset, each view shows the
 * part of the model relevant to those devices (model/filter.ts), arranged
 * by Auto-arrange for that subset alone. Those positions, and any node moved
 * by hand in a filtered view, are temporary session state, separate per
 * view: they are never written to the document, so the YAML file keeps only
 * the positions of the complete diagrams.
 *
 * Device-type visibility. `state.hiddenTypes` holds the device types
 * switched off in the toolbar's Device types filter (by typeKey: a type, and
 * for switches "switch:l2" / "switch:l3"). It narrows the
 * device selection further without changing it: the diagrams show the
 * selected devices (all of them without a filter) that are not of a hidden
 * type. When that is every device, nothing is filtered. Switching a type
 * off or on keeps the other devices where they are (only the hidden ones
 * leave, and returning ones are placed next to their neighbours), and
 * switching it on again restores the device selection as it was.
 *
 * Focus mode. `state.focus` names an object and a number of hops (1–3):
 * the diagrams then show only the devices within that many hops of it, in
 * each view's sense (cables in the physical view, relations in the logical
 * view; analysis/focus.ts), within whatever the other filters show. It is
 * a filtered view like any other: arranged for its subset, with temporary
 * positions; leaving focus brings back the views exactly as they were
 * before (the complete diagrams with their stored positions, or the
 * filtered views with their temporary ones). It never changes the model.
 */
import { Pt } from '../layout/geometry';
import { LayoutView, autoPositions, resolvePositions, samePositions } from '../layout/positions';
import { ArrangeStrategy, STRATEGIES, strategyPositions } from '../layout/strategies';
import { LayoutInput, layoutInput } from '../layout/input';
import { LogicalLayout, logicalLayoutFrom, logicalSpecs } from '../layout/logical';
import { PhysicalLayout, physicalBoxes } from '../layout/physical';
import { filterModel, selectsAll } from '../model/filter';
import { FOCUS_MAX_HOPS, FOCUS_MIN_HOPS, FocusUp, focusNeighbourhood, focusSeeds } from '../analysis/focus';
import type { FailureResult } from '../analysis/failure';
import { refExists, relatedRefs } from '../model/queries';
import { typeKey } from '../model/device-types';
import { Device, Model } from '../model/types';
import { hostOf, isGuest, machineOf, withPlacement, withVirtualNetworks } from '../model/virtual';
import { renderLogical } from './logical';
import { SceneResult, renderPhysical } from './physical';

export type View = 'physical' | 'logical';

export interface ViewState {
  view: View;
  selected: string | null;
  showLabels: boolean;
  showNetworks: boolean;
  /** route tables in the device boxes and next-hop lines (logical view); hiding them never moves anything */
  showRoutes: boolean;
  /** frames of groups / locations, in both views (hiding them never moves a device) */
  showGroups: boolean;
  hiddenProtocols: Set<string>;
  /** devices the diagrams show; null = every device (no filter) */
  devices: Set<string> | null;
  /** device type keys (model/device-types.ts typeKey: "server", "switch:l2") whose devices the diagrams leave out */
  hiddenTypes: Set<string>;
  /** focus mode: the object and the number of hops shown around it; null = off */
  focus: { ref: string; hops: number } | null;
  /**
   * Temporary positions while a node is being dragged, keyed by ref
   * ("device:x", "network:y"). The editor commits them to the document's
   * layout when the drag ends (in a filtered view: to the session's
   * temporary positions); a new model clears them.
   */
  positions: { physical: Map<string, Pt>; logical: Map<string, Pt> };
}

export function createViewState(): ViewState {
  return {
    view: 'physical',
    selected: null,
    showLabels: true,
    showNetworks: true,
    showRoutes: true,
    showGroups: true,
    hiddenProtocols: new Set(),
    devices: null,
    hiddenTypes: new Set(),
      focus: null,
    positions: { physical: new Map(), logical: new Map() },
  };
}

interface ViewCache {
  model: Model;
  input: LayoutInput;
}

export class Session {
  readonly state: ViewState = createViewState();
  /** canonical layout input of the current (complete) model */
  input: LayoutInput;
  /** displayed positions per view (stored layout, else auto-arrange; new nodes placed incrementally) */
  private resolved: { physical: Map<string, Pt> | null; logical: Map<string, Pt> | null } = { physical: null, logical: null };
  /** the filtered model and its layout input, per view (only while a subset is selected) */
  private filtered: { physical: ViewCache | null; logical: ViewCache | null } = { physical: null, logical: null };
  /** temporary positions of the filtered views, keyed by entity id; null = not arranged yet */
  private temp: { physical: Map<string, Pt> | null; logical: Map<string, Pt> | null } = { physical: null, logical: null };
  /**
   * Places of the filtered views' nodes as they were when a device type was
   * switched off, so that switching it on again brings its devices back
   * where they were (until the subset is chosen or arranged anew).
   */
  private parked: { physical: Map<string, Pt> | null; logical: Map<string, Pt> | null } = { physical: null, logical: null };

  /** VMs on another host than their own (the protocol simulation's HA restarts): the physical view draws them there */
  private placement: Map<string, string> | null = null;
  private placementKey = '';

  /**
   * Where the protocol simulation runs its VMs now (null or empty: where
   * the model puts them). Only the physical view's drawing changes; returns
   * whether it did.
   */
  setPlacement(moved: Map<string, string> | null): boolean {
    const key = moved ? Array.from(moved).sort().join(' ') : '';
    if (key === this.placementKey) return false;
    this.placementKey = key;
    this.placement = moved && moved.size ? new Map(moved) : null;
    this.filtered.physical = null;
    return true;
  }

  /** what is up in the simulated state (null: no simulation); focus mode counts hops over it */
  private simUp: FocusUp | null = null;
  private simUpKey = '';

  constructor(public model: Model) {
    this.input = layoutInput(model);
  }

  /**
   * The simulated state on screen (null: none). Focus mode then shows what
   * is within its hops over what is up; a change of the state keeps the
   * positions of what stays shown, like a change of the hops.
   */
  setSimulated(res: FailureResult | null): void {
    const key = res ? res.failed.join(' ') : '';
    if (key === this.simUpKey && !!res === !!this.simUp) return;
    this.simUpKey = key;
    this.simUp = res
      ? {
          device: (id) => res.devices.get(id) !== 'down',
          link: (id) => res.links.get(id) !== 'down',
          relation: (id) => res.relations.get(id) !== 'down',
        }
      : null;
    if (!this.state.focus) return;
    const views: LayoutView[] = ['physical', 'logical'];
    const seeds = views.map((v) => new Map(this.positionsFor(v)));
    this.filtered = { physical: null, logical: null };
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
    views.forEach((v, i) => {
      this.temp[v] = this.isFiltered(v) ? resolvePositions(v, this.viewInput(v), seeds[i]) : null;
    });
  }

  /**
   * Swap in an updated model (after an edit) while keeping the view state:
   * view, options, filters and the selection (if it still exists). Positions
   * come from the model's layout, so temporary drag positions are dropped.
   * A filtered view keeps its temporary positions; objects the edit added
   * are placed next to their neighbours, nothing else moves.
   */
  setModel(model: Model): void {
    this.model = model;
    this.input = layoutInput(model);
    this.resolved = { physical: null, logical: null };
    if (this.state.selected && !refExists(model, this.state.selected)) this.state.selected = null;
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
    const ids = this.state.devices;
    if (ids) {
      // deleted devices leave the selection; a renamed one is no longer selected
      ids.forEach((id) => {
        if (!model.index.devices.has(id)) ids.delete(id);
      });
      if (selectsAll(model, ids)) this.state.devices = null;
    }
    this.filtered = { physical: null, logical: null };
    // focus on an object the edit removed ends, and the views before it come back
    if (this.state.focus && !focusSeeds(model, this.state.focus.ref).length) this.endFocus();
    for (const v of ['physical', 'logical'] as LayoutView[]) {
      if (!this.isFiltered(v)) {
        this.temp[v] = null;
        this.parked[v] = null;
      } else {
        const old = this.temp[v];
        this.temp[v] = old ? resolvePositions(v, this.viewInput(v), old) : null;
      }
    }
  }

  // ------------------------------------------------------------- the filter

  /** Does a view (the one on screen by default) show a proper subset of the devices (by selection, by type or by focus)? */
  isFiltered(view: View = this.state.view): boolean {
    return this.shownSet(view) !== null;
  }

  /** The selected device ids (every device when there is no filter); device types switched off do not change it. */
  selectedDevices(): Set<string> {
    return this.state.devices ? new Set(this.state.devices) : new Set(this.model.devices.map((d) => d.id));
  }

  /** The device ids a view shows: the selected ones that are not of a hidden type (and, in focus, near the focused object). */
  shownDevices(view: View = this.state.view): Set<string> {
    return this.shownSet(view) || new Set(this.model.devices.map((d) => d.id));
  }

  /** Is this device type key switched off ("server", "switch:l2")? */
  isTypeHidden(key: string): boolean {
    return this.state.hiddenTypes.has(key);
  }

  /** Is a device hidden by its type? */
  isDeviceTypeHidden(d: { type: string; layer3?: boolean }): boolean {
    return this.state.hiddenTypes.has(typeKey(d));
  }

  /** The devices a view shows, or null when that is every device (no filter). */
  private shownSet(view: View = this.state.view): Set<string> | null {
    const sel = this.state.devices;
    const hidden = this.state.hiddenTypes;
    const focus = this.state.focus;
    if (!sel && !hidden.size && !focus) return null;
    const near = focus ? focusNeighbourhood(this.model, focus.ref, focus.hops, view, this.simUp || undefined) : null;
    const out = new Set<string>();
    // (a guest has no cables: in the physical view's focus it goes with the machine it runs on)
    const nearHas = (d: Device): boolean => !near || near.has(d.id) || (view === 'physical' && isGuest(d) && near.has(machineOf(this.model, d).id));
    for (const d of this.model.devices) if ((!sel || sel.has(d.id)) && !hidden.has(typeKey(d)) && nearHas(d)) out.add(d.id);
    if (view === 'physical') for (const id of this.guestsWithoutHost(out)) out.delete(id);
    return out.size === this.model.devices.length ? null : out;
  }

  /**
   * The guests of a set of shown devices whose host is not in it (or is
   * itself such a guest): the physical view draws a guest only inside its
   * host's box, so it leaves these out (and says so).
   */
  private guestsWithoutHost(shown: Set<string>): string[] {
    const out: string[] = [];
    const ok = (d: Device, depth: number): boolean => {
      const h = hostOf(this.model, d);
      if (!isGuest(d) || d.host === undefined) return true;
      return !!h && depth < 4 && shown.has(h.id) && ok(h, depth + 1);
    };
    for (const d of this.model.devices) if (shown.has(d.id) && !ok(d, 0)) out.push(d.id);
    return out;
  }

  /**
   * The guests the physical view leaves out although the filters select
   * them, because their host is not shown (by the device selection, a type
   * switched off, or focus). Empty in the logical view.
   */
  hiddenWithHost(view: View = this.state.view): string[] {
    if (view !== 'physical') return [];
    const shown = this.shownSet(view);
    if (!shown) return [];
    const sel = this.state.devices;
    const hidden = this.state.hiddenTypes;
    return this.model.devices.filter((d) => isGuest(d) && d.host !== undefined && !shown.has(d.id) && (!sel || sel.has(d.id)) && !hidden.has(typeKey(d)) && this.wouldFocus(d)).map((d) => d.id);
  }

  /** Is a device within the focus (or is there none)? */
  private wouldFocus(d: Device): boolean {
    const focus = this.state.focus;
    if (!focus) return true;
    const near = focusNeighbourhood(this.model, focus.ref, focus.hops, 'physical', this.simUp || undefined);
    return near.has(d.id) || near.has(machineOf(this.model, d).id);
  }

  // ------------------------------------------------------------- focus mode

  /** the temporary positions of the views as they were before focus mode began (restored when it ends) */
  private beforeFocus: { temp: { physical: Map<string, Pt> | null; logical: Map<string, Pt> | null }; parked: { physical: Map<string, Pt> | null; logical: Map<string, Pt> | null } } | null = null;

  /**
   * Show only the neighbourhood of an object: the devices within `hops`
   * (1–3) of it. Starting focus arranges the shown part afresh; changing
   * the hops keeps the devices that stay where they are and places the new
   * ones next to their neighbours. Returns false when the object has no
   * device to start from (nothing changes then).
   */
  setFocus(ref: string, hops: number): boolean {
    if (!focusSeeds(this.model, ref).length) return false;
    const n = Math.max(FOCUS_MIN_HOPS, Math.min(FOCUS_MAX_HOPS, Math.round(hops)));
    const cur = this.state.focus;
    if (cur && cur.ref === ref && cur.hops === n) return false;
    const views: LayoutView[] = ['physical', 'logical'];
    const same = !!cur && cur.ref === ref;
    const seeds = same ? views.map((v) => new Map(this.positionsFor(v))) : null;
    if (!cur) this.beforeFocus = { temp: { ...this.temp }, parked: { ...this.parked } };
    this.state.focus = { ref, hops: n };
    this.filtered = { physical: null, logical: null };
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
    this.parked = { physical: null, logical: null };
    views.forEach((v, i) => {
      this.temp[v] = seeds && this.isFiltered(v) ? resolvePositions(v, this.viewInput(v), seeds[i]) : null;
    });
    return true;
  }

  /** Leave focus mode: the views come back as they were before it (the model was never changed). Returns whether it was on. */
  endFocus(): boolean {
    if (!this.state.focus) return false;
    this.state.focus = null;
    this.filtered = { physical: null, logical: null };
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
    const back = this.beforeFocus;
    this.beforeFocus = null;
    for (const v of ['physical', 'logical'] as LayoutView[]) {
      const t = back ? back.temp[v] : null;
      this.temp[v] = t && this.isFiltered(v) ? resolvePositions(v, this.viewInput(v), t) : null;
      this.parked[v] = back && this.isFiltered(v) ? back.parked[v] : null;
    }
    return true;
  }

  /**
   * Show or hide the devices of one type. The device selection is not
   * changed, so showing the type again brings back exactly what was
   * selected. The devices that stay keep their places on screen; when the
   * result is the complete model, its stored positions apply unchanged.
   * Returns whether anything changed.
   */
  setTypeVisible(type: string, visible: boolean): boolean {
    return this.setTypesVisible([type], visible);
  }

  /** Show or hide several type keys at once (Select all, Clear, a switch's two kinds), as one change. */
  setTypesVisible(types: string[], visible: boolean): boolean {
    const hidden = this.state.hiddenTypes;
    if (types.every((t) => hidden.has(t) === !visible)) return false;
    const views: LayoutView[] = ['physical', 'logical'];
    // where everything is now, plus where hidden nodes were when they left: the start for the new subset
    const seeds = views.map((v) => {
      const seed = new Map(this.parked[v] || []);
      this.positionsFor(v).forEach((p, id) => seed.set(id, p));
      return seed;
    });
    for (const t of types) {
      if (visible) hidden.delete(t);
      else hidden.add(t);
    }
    // (what focus mode would restore is no longer what was shown before it)
    this.beforeFocus = null;
    this.filtered = { physical: null, logical: null };
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
    if (!this.isFiltered()) {
      this.temp = { physical: null, logical: null };
      this.parked = { physical: null, logical: null };
      return true;
    }
    views.forEach((v, i) => {
      this.parked[v] = seeds[i];
      this.temp[v] = resolvePositions(v, this.viewInput(v), seeds[i]);
    });
    return true;
  }

  /** Positions of the complete diagram of a view (stored layout, else auto-arrange). */
  private resolvedPositions(view: LayoutView): Map<string, Pt> {
    let p = this.resolved[view];
    if (!p) p = this.resolved[view] = resolvePositions(view, this.input, this.model.layout[view]);
    return p;
  }

  /**
   * Choose the devices to show. Selecting every device removes the filter
   * (the complete diagrams with their stored positions come back unchanged).
   * A different subset is arranged afresh; the same subset changes nothing.
   * Returns whether the selection changed.
   */
  setDevices(ids: Iterable<string>): boolean {
    const next = new Set<string>();
    for (const id of ids) if (this.model.index.devices.has(id)) next.add(id);
    const norm = selectsAll(this.model, next) ? null : next;
    const cur = this.state.devices;
    if (norm === null ? cur === null : cur !== null && cur.size === norm.size && Array.from(norm).every((id) => cur.has(id))) return false;
    this.state.devices = norm;
    this.beforeFocus = null;
    this.filtered = { physical: null, logical: null };
    this.temp = { physical: null, logical: null };
    this.parked = { physical: null, logical: null };
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
    return true;
  }

  /** The model a view draws: the complete model, or its filtered part. */
  viewModel(view: View = this.state.view): Model {
    return this.cache(view).model;
  }

  /** Layout input of what a view draws. */
  viewInput(view: View = this.state.view): LayoutInput {
    return this.cache(view).input;
  }

  private cache(view: View): ViewCache {
    const c = this.filtered[view];
    if (c) return c;
    const shown = this.shownSet(view);
    // VMs the simulation restarted elsewhere: drawn in their new host
    if (view === 'physical' && this.placement) {
      const moved = withPlacement(shown ? filterModel(this.model, shown, view) : this.model, this.placement);
      return (this.filtered.physical = { model: moved, input: layoutInput(moved) });
    }
    // the logical view draws container networks as networks (model/virtual.ts withVirtualNetworks)
    if (!shown) return { model: view === 'logical' ? withVirtualNetworks(this.model) : this.model, input: this.input };
    const part = filterModel(this.model, shown, view);
    const model = view === 'logical' ? withVirtualNetworks(part) : part;
    return (this.filtered[view] = { model, input: layoutInput(model) });
  }

  // -------------------------------------------------------------- positions

  /** Displayed node centers of a view, keyed by entity id (without temporary drags). */
  positionsFor(view: LayoutView): Map<string, Pt> {
    if (this.isFiltered(view)) {
      let t = this.temp[view];
      // a filtered view is arranged once, when it is first shown; afterwards it only changes when the user moves or arranges it
      if (!t) t = this.temp[view] = autoPositions(view, this.viewInput(view));
      return t;
    }
    return this.resolvedPositions(view);
  }

  /**
   * End a drag in a filtered view: the node keeps its new place for this
   * session only (never in the document). Returns false when not filtered.
   */
  commitTemporary(ref: string): boolean {
    if (!this.isFiltered()) return false;
    const view = this.state.view;
    const p = this.state.positions[view].get(ref);
    if (!p) return false;
    const next = new Map(this.positionsFor(view));
    const id = ref.slice(ref.indexOf(':') + 1);
    if (!next.has(id)) return false;
    next.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
    this.temp[view] = next;
    this.state.positions[view].delete(ref);
    return true;
  }

  /**
   * Layout status of a filtered view: 'auto' while it shows Auto-arrange of
   * its subset, 'manual' after a node was moved. (The complete views get
   * theirs from the document.)
   */
  filteredStatus(view: LayoutView): 'auto' | 'manual' {
    return this.filteredArrangedWith(view).length ? 'auto' : 'manual';
  }

  /** The strategies whose result a filtered view shows now, in STRATEGIES order (see ModelDoc.arrangedWith). */
  filteredArrangedWith(view: LayoutView): ArrangeStrategy[] {
    const cur = this.positionsFor(view);
    const input = this.viewInput(view);
    return STRATEGIES.filter((st) => samePositions(cur, strategyPositions(view, input, st)));
  }

  /**
   * Auto-arrange the filtered view on screen: the shown subset only, in
   * this session only. Returns how many nodes moved.
   */
  arrangeFiltered(strategy: ArrangeStrategy = 'default'): number {
    const view = this.state.view;
    const auto = strategyPositions(view, this.viewInput(view), strategy);
    const cur = this.positionsFor(view);
    let moved = 0;
    auto.forEach((p, id) => {
      const q = cur.get(id);
      if (!q || q.x !== p.x || q.y !== p.y) moved++;
    });
    this.temp[view] = auto;
    this.parked[view] = null;
    this.state.positions[view].clear();
    return moved;
  }

  setView(v: View): void {
    this.state.view = v;
  }

  select(ref: string | null): void {
    // a container network drawn as a network is selected as the container network
    if (ref && ref.indexOf('network:') === 0 && !this.model.index.networks.has(ref.slice(8))) {
      const n = withVirtualNetworks(this.model).index.networks.get(ref.slice(8));
      if (n && n.cnet) ref = n.cnet;
    }
    this.state.selected = ref && refExists(this.model, ref) ? ref : null;
  }

  toggleProtocol(proto: string, visible: boolean): void {
    if (visible) this.state.hiddenProtocols.delete(proto);
    else this.state.hiddenProtocols.add(proto);
  }

  moveNode(ref: string, p: Pt): void {
    this.state.positions[this.state.view].set(ref, p);
  }

  resetPositions(): void {
    this.state.positions[this.state.view].clear();
  }

  logicalLayout(): LogicalLayout {
    const pos = this.positionsFor('logical');
    const input = this.viewInput('logical');
    const byRef = new Map<string, Pt>();
    for (const sp of logicalSpecs(input)) {
      const p = pos.get(sp.id);
      if (p) byRef.set(sp.ref, p);
    }
    return logicalLayoutFrom(input, byRef);
  }

  physicalLayout(): PhysicalLayout {
    const pos = new Map(this.positionsFor('physical'));
    this.state.positions.physical.forEach((p, ref) => {
      if (ref.indexOf('device:') === 0) pos.set(ref.slice(7), p);
    });
    if (this.placement) this.makeRoom(pos);
    return { boxes: physicalBoxes(this.viewInput('physical'), pos) };
  }

  /**
   * VMs restarted on another host (the simulation, drawn there): a host
   * that holds more grows from its top-left corner, and what lies below it
   * (or right of it) moves on by as much, so nothing overlaps; a host that
   * holds fewer keeps its place. Never stored: the simulation's drawing only.
   */
  private makeRoom(pos: Map<string, Pt>): void {
    const shown = this.shownSet('physical');
    const before = physicalBoxes(shown ? layoutInput(filterModel(this.model, shown, 'physical')) : this.input, pos);
    const after = physicalBoxes(this.viewInput('physical'), pos);
    const grown = Array.from(after)
      .filter(([id, b]) => {
        const o = before.get(id);
        return !!o && (b.h > o.h + 0.5 || b.w > o.w + 0.5);
      })
      .sort((p, q) => {
        const a = before.get(p[0]) as { cy: number; h: number };
        const b = before.get(q[0]) as { cy: number; h: number };
        return a.cy - a.h / 2 - (b.cy - b.h / 2) || (p[0] < q[0] ? -1 : 1);
      });
    for (const [id, b] of grown) {
      const o = before.get(id) as { cx: number; cy: number; w: number; h: number };
      const dh = Math.max(0, b.h - o.h);
      const dw = Math.max(0, b.w - o.w);
      const left = o.cx - o.w / 2;
      const top = o.cy - o.h / 2;
      const p = pos.get(id) as Pt;
      pos.set(id, { x: p.x + dw / 2, y: p.y + dh / 2 });
      before.forEach((x, other) => {
        if (other === id) return;
        const q = pos.get(other);
        if (!q) return;
        const xl = x.cx - x.w / 2;
        const xt = x.cy - x.h / 2;
        const below = dh > 0 && xt >= top + o.h - 1 && xl < left + b.w && xl + x.w > left;
        const right = dw > 0 && xl >= left + o.w - 1 && xt < top + b.h && xt + x.h > top;
        if (below || right) pos.set(other, { x: q.x + (right ? dw : 0), y: q.y + (below ? dh : 0) });
      });
    }
  }

  render(): SceneResult {
    const s = this.state;
    if (s.view === 'physical') {
      return renderPhysical(this.viewModel('physical'), this.physicalLayout(), { showLabels: s.showLabels, showGroups: s.showGroups, positions: new Map() });
    }
    return renderLogical(this.viewModel('logical'), this.logicalLayout(), {
      showLabels: s.showLabels,
      showNetworks: s.showNetworks,
      showRoutes: s.showRoutes,
      showGroups: s.showGroups,
      hiddenProtocols: s.hiddenProtocols,
      positions: s.positions.logical,
    });
  }

  /**
   * Refs to keep highlighted for the current selection (null = nothing
   * selected, or the selection is not part of the filtered view).
   */
  highlight(): Set<string> | null {
    const sel = this.state.selected;
    if (!sel) return null;
    const m = this.viewModel();
    return refExists(m, sel) ? relatedRefs(m, sel) : null;
  }
}

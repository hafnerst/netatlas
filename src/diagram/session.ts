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
 */
import { Pt } from '../layout/geometry';
import { LayoutView, autoPositions, resolvePositions, samePositions } from '../layout/positions';
import { LayoutInput, layoutInput } from '../layout/input';
import { LogicalLayout, logicalLayoutFrom, logicalSpecs } from '../layout/logical';
import { PhysicalLayout, physicalBoxes } from '../layout/physical';
import { filterModel, selectsAll } from '../model/filter';
import { refExists, relatedRefs } from '../model/queries';
import { Model } from '../model/types';
import { renderLogical } from './logical';
import { SceneResult, renderPhysical } from './physical';

export type View = 'physical' | 'logical';

export interface ViewState {
  view: View;
  selected: string | null;
  showLabels: boolean;
  showNetworks: boolean;
  /** frames of groups / locations, in both views (hiding them never moves a device) */
  showGroups: boolean;
  hiddenProtocols: Set<string>;
  /** devices the diagrams show; null = every device (no filter) */
  devices: Set<string> | null;
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
    showGroups: true,
    hiddenProtocols: new Set(),
    devices: null,
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

  constructor(public model: Model) {
    this.input = layoutInput(model);
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
    if (!this.isFiltered()) this.temp = { physical: null, logical: null };
    else {
      for (const v of ['physical', 'logical'] as LayoutView[]) {
        const old = this.temp[v];
        this.temp[v] = old ? resolvePositions(v, this.viewInput(v), old) : null;
      }
    }
  }

  // ------------------------------------------------------------- the filter

  /** Is a proper subset of the devices selected? */
  isFiltered(): boolean {
    return this.state.devices !== null;
  }

  /** The selected device ids (every device when there is no filter). */
  selectedDevices(): Set<string> {
    return this.state.devices ? new Set(this.state.devices) : new Set(this.model.devices.map((d) => d.id));
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
    this.filtered = { physical: null, logical: null };
    this.temp = { physical: null, logical: null };
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
    if (!this.state.devices) return { model: this.model, input: this.input };
    let c = this.filtered[view];
    if (!c) {
      const model = filterModel(this.model, this.state.devices, view);
      c = this.filtered[view] = { model, input: layoutInput(model) };
    }
    return c;
  }

  // -------------------------------------------------------------- positions

  /** Displayed node centers of a view, keyed by entity id (without temporary drags). */
  positionsFor(view: LayoutView): Map<string, Pt> {
    if (this.isFiltered()) {
      let t = this.temp[view];
      // a filtered view is arranged once, when it is first shown; afterwards it only changes when the user moves or arranges it
      if (!t) t = this.temp[view] = autoPositions(view, this.viewInput(view));
      return t;
    }
    let p = this.resolved[view];
    if (!p) p = this.resolved[view] = resolvePositions(view, this.input, this.model.layout[view]);
    return p;
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
    return samePositions(this.positionsFor(view), autoPositions(view, this.viewInput(view))) ? 'auto' : 'manual';
  }

  /**
   * Auto-arrange the filtered view on screen: the shown subset only, in
   * this session only. Returns how many nodes moved.
   */
  arrangeFiltered(): number {
    const view = this.state.view;
    const auto = autoPositions(view, this.viewInput(view));
    const cur = this.positionsFor(view);
    let moved = 0;
    auto.forEach((p, id) => {
      const q = cur.get(id);
      if (!q || q.x !== p.x || q.y !== p.y) moved++;
    });
    this.temp[view] = auto;
    this.state.positions[view].clear();
    return moved;
  }

  setView(v: View): void {
    this.state.view = v;
  }

  select(ref: string | null): void {
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
    return { boxes: physicalBoxes(this.viewInput('physical'), pos) };
  }

  render(): SceneResult {
    const s = this.state;
    if (s.view === 'physical') {
      return renderPhysical(this.viewModel('physical'), this.physicalLayout(), { showLabels: s.showLabels, showGroups: s.showGroups, positions: new Map() });
    }
    return renderLogical(this.viewModel('logical'), this.logicalLayout(), {
      showLabels: s.showLabels,
      showNetworks: s.showNetworks,
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

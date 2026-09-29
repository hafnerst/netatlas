/**
 * DOM-free application session: owns the model, cached layouts and view
 * state, and produces render scenes. The browser UI is a thin shell around
 * this, which is what makes view switching testable in Node.
 */
import { Pt } from '../layout/geometry';
import { LayoutView, resolvePositions } from '../layout/positions';
import { LayoutInput, layoutInput } from '../layout/input';
import { LogicalLayout, logicalLayoutFrom, logicalSpecs } from '../layout/logical';
import { PhysicalLayout, physicalBoxes } from '../layout/physical';
import { refExists, relatedRefs } from '../model/queries';
import { Model } from '../model/types';
import { renderLogical } from './logical';
import { SceneResult, renderPhysical } from './physical';

export type View = 'physical' | 'logical';

export interface ViewState {
  view: View;
  selected: string | null;
  showLabels: boolean;
  showUnderlay: boolean;
  showNetworks: boolean;
  hiddenProtocols: Set<string>;
  /**
   * Temporary positions while a node is being dragged, keyed by ref
   * ("device:x", "network:y"). The editor commits them to the document's
   * layout when the drag ends; a new model clears them.
   */
  positions: { physical: Map<string, Pt>; logical: Map<string, Pt> };
}

export function createViewState(): ViewState {
  return {
    view: 'physical',
    selected: null,
    showLabels: true,
    showUnderlay: false,
    showNetworks: true,
    hiddenProtocols: new Set(),
    positions: { physical: new Map(), logical: new Map() },
  };
}

export class Session {
  readonly state: ViewState = createViewState();
  /** canonical layout input of the current model */
  input: LayoutInput;
  /** displayed positions per view (stored layout, else auto-arrange; new nodes placed incrementally) */
  private resolved: { physical: Map<string, Pt> | null; logical: Map<string, Pt> | null } = { physical: null, logical: null };

  constructor(public model: Model) {
    this.input = layoutInput(model);
  }

  /**
   * Swap in an updated model (after an edit) while keeping the view state:
   * view, options, filters and the selection (if it still exists). Positions
   * come from the model's layout, so temporary drag positions are dropped.
   */
  setModel(model: Model): void {
    this.model = model;
    this.input = layoutInput(model);
    this.resolved = { physical: null, logical: null };
    if (this.state.selected && !refExists(model, this.state.selected)) this.state.selected = null;
    this.state.positions.physical.clear();
    this.state.positions.logical.clear();
  }

  /** Displayed node centers of a view, keyed by entity id (without temporary drags). */
  positionsFor(view: LayoutView): Map<string, Pt> {
    let p = this.resolved[view];
    if (!p) p = this.resolved[view] = resolvePositions(view, this.input, this.model.layout[view]);
    return p;
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
    const byRef = new Map<string, Pt>();
    for (const sp of logicalSpecs(this.input)) {
      const p = pos.get(sp.id);
      if (p) byRef.set(sp.ref, p);
    }
    return logicalLayoutFrom(this.input, byRef);
  }

  physicalLayout(): PhysicalLayout {
    const pos = new Map(this.positionsFor('physical'));
    this.state.positions.physical.forEach((p, ref) => {
      if (ref.indexOf('device:') === 0) pos.set(ref.slice(7), p);
    });
    return { boxes: physicalBoxes(this.input, pos) };
  }

  render(): SceneResult {
    const s = this.state;
    if (s.view === 'physical') {
      return renderPhysical(this.model, this.physicalLayout(), { showLabels: s.showLabels, positions: new Map() });
    }
    return renderLogical(this.model, this.logicalLayout(), {
      showLabels: s.showLabels,
      showUnderlay: s.showUnderlay,
      showNetworks: s.showNetworks,
      hiddenProtocols: s.hiddenProtocols,
      positions: s.positions.logical,
    });
  }

  /** Refs to keep highlighted for the current selection (null = nothing selected). */
  highlight(): Set<string> | null {
    return this.state.selected ? relatedRefs(this.model, this.state.selected) : null;
  }
}

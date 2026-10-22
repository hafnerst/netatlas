/**
 * Saved views (`views:`): a named way of looking at the model — the
 * diagram (physical or logical), a focus, the filters, the display options
 * and where the diagram is. Display state only: opening one changes what is
 * drawn, never the network, an analysis or a simulation.
 */

/** A focus as written: the object and its hops, or a contextual focus on it. */
export interface SavedFocus {
  /** a device, device:interface, or kind:id (network:…, group:…, link:…) */
  target: string;
  /** 1–3 (a plain focus) */
  hops?: number;
  /** a contextual focus: the devices of a VLAN, of the target's dependencies, of a multicast group, of its timing domain */
  context?: 'vlan' | 'dependencies' | 'multicast' | 'timing' | 'vrf';
  vlan?: number;
  vrf?: string;
  group?: string;
}

export interface SavedView {
  id: string;
  name: string;
  view: 'physical' | 'logical';
  focus?: SavedFocus;
  /** the devices shown (left out: every device) */
  devices?: string[];
  /** groups drawn as one box each */
  collapse?: string[];
  /** device types left out (model/device-types.ts typeKey: "server", "switch:l2") */
  hideTypes: string[];
  /** protocols left out of the diagram */
  hideProtocols: string[];
  options: { labels?: boolean; groups?: boolean; networks?: boolean; routes?: boolean };
  /** the diagram's centre (diagram units) and zoom; left out: fitted */
  viewport?: { x: number; y: number; zoom: number };
  description?: string;
  line: number;
}

export const VIEW_KEYS = ['id', 'name', 'view', 'focus', 'devices', 'collapse', 'hide_types', 'hide_protocols', 'options', 'viewport', 'description'];
export const VIEW_FOCUS_KEYS = ['target', 'hops', 'context', 'vlan', 'vrf', 'group'];
export const VIEW_OPTION_KEYS = ['labels', 'groups', 'networks', 'routes'];
export const VIEW_VIEWPORT_KEYS = ['x', 'y', 'zoom'];
export const VIEW_CONTEXTS: Array<SavedFocus['context']> = ['vlan', 'dependencies', 'multicast', 'timing', 'vrf'];
export const MAX_VIEWS = 100;

/** "Logical view · focus sw (2 hops) · 3 types hidden" */
export function viewSummary(v: SavedView): string {
  const out = [v.view === 'logical' ? 'Logical view' : 'Physical view'];
  if (v.focus) out.push(`focus ${v.focus.target}${v.focus.context ? ` (${v.focus.context === 'vlan' ? 'VLAN ' + v.focus.vlan : v.focus.context === 'multicast' ? 'group ' + v.focus.group : v.focus.context === 'vrf' ? 'VRF ' + v.focus.vrf : v.focus.context})` : ` (${v.focus.hops || 1} hop${(v.focus.hops || 1) === 1 ? '' : 's'})`}`);
  if (v.devices) out.push(`${v.devices.length} device${v.devices.length === 1 ? '' : 's'}`);
  if (v.collapse && v.collapse.length) out.push(`${v.collapse.length} group${v.collapse.length === 1 ? '' : 's'} collapsed`);
  if (v.hideTypes.length) out.push(`${v.hideTypes.length} type${v.hideTypes.length === 1 ? '' : 's'} hidden`);
  if (v.hideProtocols.length) out.push(`${v.hideProtocols.length} protocol${v.hideProtocols.length === 1 ? '' : 's'} hidden`);
  if (v.viewport) out.push(`zoom ${Math.round(v.viewport.zoom * 100)} %`);
  return out.join(' · ');
}

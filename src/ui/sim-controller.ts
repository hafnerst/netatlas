/**
 * Simulate → Start simulation: the protocol simulation on screen. It owns
 * the simulation (analysis/sim) and its pacing (analysis/sim/pacing.ts),
 * runs the display clock (requestAnimationFrame, paused while the page is
 * hidden), draws the messages in the diagram (sim-anim.ts) and fills the
 * simulation layout's three panels:
 *
 *   - Simulation setup (left, in place of the Objects list): the protocols
 *     shown, grouped, with Select all and Clear (changing them never
 *     restarts anything), and the Layer 1–4 parameters, one collapsed
 *     section per layer, applied at once; the table timers' scale;
 *   - Actions (right, in place of the Inspector's tabs): Network events,
 *     four actions with their own forms (Send network packets, Join
 *     multicast group, Start multicast stream, Interface actions; each
 *     chooses its device and interface itself), then Active events: the
 *     events they started (analysis/sim/actions.ts: state, progress,
 *     outcome, Stop / No shut / Leave group, details) and the other state
 *     changes in effect with their way back; then the selected device's
 *     Simulation settings (collapsed; the documented exception to the edit
 *     lock);
 *   - the simulation panel (docked under the diagram, always there while
 *     the simulation runs): Play or Pause, Step, the speed and the pacing,
 *     skipping idle time, the simulated time and Exit simulation; the
 *     protocols' status and the selected device's tables on the left, the
 *     event log with its filters on the right (a message opens the packet
 *     inspector).
 *
 * The in-diagram menus (a click on a cable, relation, device or interface)
 * offer the events of that object (also Fail link, Power off, its tables
 * and its broadcast domain, which have no form in the Actions panel); a
 * device's Send network packets…, Join multicast group… and Start
 * multicast stream… open that form with the device filled in. A dot, or a message of the
 * log, opens the packet inspector (a dot pauses first), with Follow
 * message. It is the app's simulation mode (simulation-mode.ts): the
 * banner's text (with a broadcast storm's warning), what is down, a
 * highlighted broadcast domain, and Exit.
 *
 * The checkboxes only choose what is shown (dots and event log): the
 * simulation always computes every protocol, so changing them never
 * restarts it or changes its time, and the tables keep filling. Parameters
 * changed in the setup apply at once, at the current simulated time. The
 * pacing, the speed and skipping only change how it is shown, never what
 * happens. Nothing here changes the model or adds an undo step (a device's
 * Simulation settings are edited in the Actions panel, see modelChanged).
 */
import { virtBridgeId } from '../model/virtual';
import { leaseText } from '../model/addresses';
import { FailureResult, refLabel, simulate } from '../analysis/failure';
import { fmtSec } from '../analysis/sim/engine';
import { CONV_LIMIT, FRAME_MAX, PACE_SCALES, PACE_SPEEDS, PaceMode, Pacer, conversationKey, scaleText } from '../analysis/sim/pacing';
import { ParamValue, Resolved, formatValue, sourceText } from '../analysis/sim/params';
import { DeviceStateView, SimProtocolEntry, Simulation, hasLifecycle } from '../analysis/sim/simulation';
import { StatusPlacer } from './status-place';
import { TestPlan } from '../analysis/sim/test-plan';
import { TestForm } from './sim-test-form';
import { IfaceForm, JoinForm, StreamForm } from './sim-event-forms';
import { listKey, renderEvents } from './sim-event-list';
import { TestKind } from '../analysis/sim/transport';
import { Flight, Headers, NetEvent, SessionStatus, SimEvent, TableTimer, Track } from '../analysis/sim/types';
import { lookupProtocol } from '../model/protocols';
import { Model, deviceInterfaces } from '../model/types';
import { el } from './dom';
import { DrawItem, MAX_DOTS, SimAnimator, dot, findTrack } from './sim-anim';
import { SendersPicker, sendersPicker } from './sim-senders-ui';
import { ParamEditor, paramEditor } from './sim-params-ui';
import { ProtocolPicker, protocolPicker } from './sim-protocols-ui';
import { TableKind, TablePanels } from './sim-tables';
import { SimulationMode } from './simulation-mode';
import { capabilities } from '../model/capabilities';

export const SPEEDS = PACE_SPEEDS;
export const TIMER_SCALES: readonly number[] = [1, 60, 240, 3600];
/** The event log shows at most this many of its newest matching events. */
const LOG_SHOWN = 250;

/** What the controller needs of the app. */
export interface SimHost {
  doc: Document;
  model(): Model;
  scene(): Element | null;
  view(): 'physical' | 'logical';
  reduce(): boolean;
  /** the simulation's state changed (what is down): the marks, the banner */
  changed(): void;
  /** the screen rectangle of an object in the diagram */
  rectOf(ref: string): { x: number; y: number; w: number; h: number } | null;
  toast(text: string): void;
  /** the time moved on (the banner's and the status bar's texts) */
  tick(): void;
  /** the simulation-wide parameters changed (remembered for the next start in this browser session) */
  paramsChanged?(values: { [key: string]: ParamValue }): void;
  /** the protocols shown changed (remembered for the next start in this browser session) */
  shownChanged?(shown: Set<string>): void;
  /** the selected object ("device:x", "link:y" …; null: none) */
  selected?(): string | null;
  /** select an object (the Actions panel's object list), as a click in the diagram would */
  select?(ref: string | null): void;
  /** the panels' boxes (null: not on the page) */
  setupBox?(): HTMLElement | null;
  actionsBox?(): HTMLElement | null;
  dockBox?(): HTMLElement | null;
  /** the selected device's Simulation section, editable, into a box (false: none) */
  simSection?(box: HTMLElement): boolean;
  /** Exit simulation */
  exit?(): void;
  /** the senders changed (remembered for the next start in this browser session) */
  sendersChanged?(senders: Set<string>): void;
  /** the devices the diagram's selection stands for (Selected in diagram) */
  diagramDevices?(): Set<string>;
  /** what the simulation panel holds besides its tables changed (a warning, its tabs): its minimum height again */
  panelChanged?(): void;
}

/** Why the simulation is paused: by the user (Pause, Step), or while the packet inspector is in use. */
export type PauseReason = 'user' | 'inspector' | null;

export interface SimStartOptions {
  /** the protocols shown at the start (all when left out) */
  protocols?: string[];
  /** the senders at the start (every device when left out) */
  senders?: string[];
  /** the simulation-wide parameters that differ from their defaults */
  params?: { [key: string]: ParamValue };
}

const FIXED_COLORS: { [k: string]: string } = { arp: '#f08c00', ndp: '#e67700', garp: '#c92a2a', demand: '#1c7ed6', link: '#868e96', icmp: '#d6336c', tcp: '#2b8a3e', udp: '#7048e8', mcast: '#0b7a5c' };

/** The protocols of Layer 2 (the event log's layer filter); the link events are Layer 1, tests and services Layer 4. */
const LAYER2 = ['arp', 'ndp', 'garp', 'stp', 'lacp', 'lldp', 'cdp'];

/** The layer of an event (the log's filter): its frame's top header when it has one, else its protocol's. */
export function eventLayer(e: SimEvent, group?: string): number {
  if (e.protocol === 'link') return 1;
  if (e.hdr) return e.hdr.l4 && (e.hdr.l4.proto === 'tcp' || e.hdr.l4.proto === 'udp') ? 4 : e.hdr.l3.length ? 3 : 2;
  if (LAYER2.indexOf(e.protocol) >= 0) return 2;
  if (e.protocol === 'tcp' || e.protocol === 'udp' || e.protocol === 'demand' || group === 'Services') return 4;
  return 3;
}

export type MenuItem = { label: string; act: () => void };

/** The tables of a device the simulation panel can show (the status side's tabs). */
type DevTable = Exclude<TableKind, 'packet'>;
const DEV_TABLE_LABEL: { [k in DevTable]: string } = { arp: 'ARP', mac: 'MAC', conn: 'Connections', fw: 'Sessions', igmp: 'IGMP / MLD', snoop: 'Snooping', members: 'Memberships', mroute: 'Multicast routes', dhcp: 'DHCP leases', dnscache: 'DNS cache', dnszone: 'DNS zone' };

/** An interval in seconds as the form has it: "1 s", "0.25 s". */
function secText(sec: number): string {
  return `${Math.round(sec * 1000) / 1000} s`;
}

export class SimController implements SimulationMode {
  readonly sim: Simulation;
  readonly anim: SimAnimator;
  readonly tables: TablePanels;
  readonly pacer: Pacer;
  playing = true;
  /** the protocols shown (all at the start, or those Start simulation preselects) */
  readonly shown = new Set<string>();
  private raf = 0;
  private last = 0;
  private uiAt = 0;
  private failRes: { key: string; res: FailureResult } | null = null;
  private logFilter = '';
  private logKey = '';
  private logFilterKey = '';
  private statusKey = '';
  private eventsKey = '';
  private actionsKey = '';
  private menuBox: HTMLElement | null = null;
  private stopped = false;
  private stateSeen = -1;
  private editor: ParamEditor | null = null;
  private picker: ProtocolPicker | null = null;
  /** dots of shown protocols not drawn now (the limit, or no place for their label) */
  notDrawn = 0;
  /** the broadcast domain highlighted (Highlight broadcast domain), and what it is of */
  private domain: { refs: Set<string>; what: string; from: { dev: string; iface: string } | { link: string; vlan: number } } | null = null;
  private logLayer = 0;
  private logCast = '';
  private logProto = '';
  private testForm: TestForm | null = null;
  private joinForm: JoinForm | null = null;
  private streamForm: StreamForm | null = null;
  private ifaceForm: IfaceForm | null = null;
  private domainKey = '';
  /** the status side shows the protocols' status, or a table of the selected device */
  private statusView: { kind: DevTable; dev: string } | null = null;
  private readonly entries: SimProtocolEntry[];
  /** a typical hop's simulated time per view (the readable pacing's reference) */
  private typicalHop = { physical: 0 };
  private onVis = (): void => this.schedule();

  constructor(
    private host: SimHost,
    opts: SimStartOptions | string[] = {},
  ) {
    const o: SimStartOptions = Array.isArray(opts) ? { protocols: opts } : opts;
    // the real-time schedule (a stream's interval) counts the page's own clock
    const win = host.doc.defaultView;
    this.sim = new Simulation(host.model(), { params: o.params, realClock: () => (win && win.performance ? win.performance.now() : Date.now()) });
    this.anim = new SimAnimator(host.doc, (t) => this.trackEnds(t));
    this.tables = new TablePanels(host.doc);
    // closing the packet inspector ends the pause it caused
    this.tables.onClose = (k) => {
      if (k === 'packet') this.resumeFromInspector();
    };
    this.entries = this.sim.protocolEntries();
    for (const e of this.entries) if (!o.protocols || o.protocols.indexOf(e.id) >= 0) this.shown.add(e.id);
    // the senders: those chosen, else every device (the engine is told when they are not every device)
    const devs = host.model().devices;
    for (const d of devs) if (!o.senders || o.senders.indexOf(d.id) >= 0) this.senders.add(d.id);
    if (this.senders.size !== devs.length) this.sim.engine.setSenders(this.senders, devs.filter((d) => this.senders.has(d.id)).map((d) => d.id).sort().join(', ') || 'none');
    this.stateSeen = this.sim.engine.stateVersion;
    this.typicalHop.physical = this.physicalTypical();
    this.pacer = new Pacer(
      {
        engine: this.sim.engine,
        shown: (f) => f.view === this.host.view() && this.flightShown(f),
        typical: (v) => this.typical(v),
        headers: (f) => f.hdr,
        length: (f) => this.trackLength(f),
        testRunning: () => this.testRunning(),
        foreground: () => this.sim.foregroundActive(),
        realtime: () => this.sim.realtimeActive(),
      },
      MAX_DOTS,
    );
    host.doc.addEventListener('visibilitychange', this.onVis);
    this.schedule();
  }

  // ------------------------------------------------------------ simulation mode

  get t(): number {
    return this.sim.now;
  }

  note(): string {
    const n = this.sim.netEvents().length;
    const storms = this.sim.storms();
    // the devices out of operation (the diagram's indicators say it for every device)
    const names = (st: string): string => {
      const ids = Array.from(this.deviceStates()).filter((x) => x[1].state === st).map((x) => x[0]).sort();
      return ids.length ? `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}` : '';
    };
    const off = names('off');
    const boot = names('booting');
    return `Protocol simulation, t = ${fmtSec(this.t)}${n ? ` · ${n} network event${n === 1 ? '' : 's'}` : ''}${off ? ` · powered off: ${off}` : ''}${boot ? ` · booting: ${boot}` : ''}${storms.length ? ` · ⚠ broadcast storm in ${storms.map((s) => (s.vlan ? 'VLAN ' + s.vlan : 'the untagged frames')).join(', ')}` : ''}${this.domain ? ` · broadcast domain of ${this.domain.what} highlighted` : ''}`;
  }

  /** The broadcast domain highlighted in the diagram (null: none). */
  highlighted(): Set<string> | null {
    if (!this.domain) return null;
    // what a broadcast reaches changes with what is up: computed again on every change
    const k = this.sim.engine.stateVersion + '|' + this.sim.downRefs().join(',');
    if (k !== this.domainKey) {
      this.domainKey = k;
      this.domain.refs = new Set(this.sim.broadcastDomain(this.domain.from).refs);
    }
    return this.domain.refs;
  }

  /** Highlight what a broadcast reaches from a device's interface, or in a cable's VLAN. */
  highlightDomain(from: { dev: string; iface: string } | { link: string; vlan: number }): boolean {
    const d = this.sim.broadcastDomain(from);
    if (!d.refs.length) return false;
    const what = 'link' in from ? `cable ${from.link}${from.vlan ? ' in VLAN ' + from.vlan : ''}` : `${from.dev}:${from.iface}`;
    this.domain = { refs: new Set(d.refs), what, from };
    this.domainKey = this.sim.engine.stateVersion + '|' + this.sim.downRefs().join(',');
    this.host.changed();
    this.host.toast(`Broadcast domain of ${what}${d.vlan ? ' (VLAN ' + d.vlan + ')' : ''}: ${d.devices.length} device${d.devices.length === 1 ? '' : 's'}, ${d.links.length} cable${d.links.length === 1 ? '' : 's'} highlighted.`);
    this.actionsKey = '';
    this.refresh(true);
    return true;
  }

  clearDomain(): void {
    if (!this.domain) return;
    this.domain = null;
    this.host.changed();
    this.actionsKey = '';
    this.refresh(true);
  }

  marker(): string {
    return `Simulation · t = ${fmtSec(this.t)}`;
  }

  key(): string {
    return this.sim.downRefs().join('|');
  }

  failure(): FailureResult | null {
    const refs = this.sim.downRefs();
    if (!refs.length) return null;
    const k = refs.join('|');
    if (!this.failRes || this.failRes.key !== k) this.failRes = { key: k, res: simulate(this.host.model(), refs) };
    return this.failRes.res;
  }

  stop(): void {
    this.stopped = true;
    this.playing = false;
    this.schedule();
    this.watchInspector(false);
    this.tables.closeAll();
    this.anim.clear();
    if (this.badges && this.badges.parentNode) this.badges.parentNode.removeChild(this.badges);
    this.badges = null;
    if (this.power && this.power.parentNode) this.power.parentNode.removeChild(this.power);
    this.power = null;
    // nothing scheduled sends again
    this.sim.close();
    this.closeMenu();
    this.host.doc.removeEventListener('visibilitychange', this.onVis);
  }

  // ------------------------------------------------------------ the clock and the pacing

  private running(): boolean {
    return !this.stopped && this.playing && this.host.doc.visibilityState !== 'hidden';
  }

  /** The typical hop of the physical view: the median of the cables' latency with a small frame's serialization. */
  private physicalTypical(): number {
    const e = this.sim.engine;
    const ls = this.host.model().links.map((l) => {
      try {
        return Number(e.latency(l.id).value) + (64 * 8 * 1000) / Number(e.speed(l.id).value);
      } catch (err) {
        return NaN;
      }
    });
    const ok = ls.filter((x) => x > 0 && isFinite(x)).sort((a, b) => a - b);
    return ok.length ? ok[Math.floor(ok.length / 2)] : e.hopTime();
  }

  /**
   * The typical hop of a view: the cables' median; a relation or network
   * line of the logical view spans about two of them. Fixed from the start
   * (it changes only with a latency parameter), so that a hop's screen time
   * never depends on which messages came first.
   */
  private typical(view: Flight['view']): number {
    return view === 'physical' ? this.typicalHop.physical : 2 * this.typicalHop.physical;
  }

  /** Start or stop the clock as the state says (one frame per screen refresh; under reduced motion the same, with static arrows). */
  schedule(): void {
    // the real-time schedule runs while the simulation does (paused, hidden or closed: it stands)
    this.sim.setRealTimeRunning(this.running());
    const w = this.host.doc.defaultView;
    if (!w) return;
    if (this.raf) w.cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.running()) {
      this.refresh(true);
      return;
    }
    // the clock starts with the first frame drawn: the time before it (the setup, a hidden tab, a pause) never counts
    let first = true;
    const frame = (now: number): void => {
      this.raf = 0;
      if (!this.running()) return;
      // a long frame counts at most FRAME_MAX: a stall slows the dots for a moment, never makes them jump
      const dt = first ? 0 : Math.min(FRAME_MAX, Math.max(0, now - this.last));
      first = false;
      this.last = now;
      this.advance(dt);
      this.refresh(now - this.uiAt > 250);
      if (now - this.uiAt > 250) this.uiAt = now;
      this.raf = w.requestAnimationFrame(frame);
    };
    this.raf = w.requestAnimationFrame(frame);
  }

  /** Real time passed: the pacing moves the display and the simulation on (the self-test drives it too). */
  advance(wallMs: number): void {
    // the streams of Network events first: what is due now goes at the current simulated time
    if (this.sim.pumpRealTime()) this.actionsKey = '';
    this.pacer.frame(wallMs);
  }

  /** Why it is paused (null: playing, or paused with no reason left). */
  pausedBy: PauseReason = null;
  private stateSaid = '';
  private inspectorTimer: number | null = null;

  /** Play or pause (the user's Play / Pause, and the tests). A pause by the user is never resumed by anything else. */
  setPlaying(on: boolean, reason: PauseReason = 'user'): void {
    this.playing = on;
    this.pausedBy = on ? null : reason;
    if (reason !== 'inspector') this.watchInspector(false);
    this.schedule();
    this.sayState();
  }

  /** "Playing", "Paused", "Paused: inspecting packet". */
  playState(): string {
    if (this.playing) return 'Playing';
    return this.pausedBy === 'inspector' ? 'Paused: inspecting packet' : 'Paused';
  }

  /** The playback state in the panel and, politely, to screen readers when it changed. */
  private sayState(): void {
    const d = this.host.doc;
    const s = this.playState();
    const vis = d.getElementById('sim-state');
    if (vis && vis.textContent !== s) vis.textContent = s;
    // Send and play only while paused
    const sp = d.getElementById('sim-t-sendplay');
    if (sp) sp.hidden = this.playing;
    if (s === this.stateSaid) return;
    this.stateSaid = s;
    const live = d.getElementById('sim-state-live');
    if (live) live.textContent = s;
  }

  /** The packet inspector was opened from a dot or the log: a running simulation pauses until it is no longer in use. */
  private inspectorPause(): void {
    if (!this.playing) return;
    this.setPlaying(false, 'inspector');
    this.watchInspector(true);
  }

  /** The inspector is no longer in use (closed, left, hidden): resume, if it was what paused the simulation. */
  resumeFromInspector(): boolean {
    if (this.stopped || this.playing || this.pausedBy !== 'inspector') return false;
    this.setPlaying(true);
    return true;
  }

  /** Is the packet inspector shown (in the page, with a size, inside the window and not covered)? */
  inspectorVisible(): boolean {
    const box = this.tables.panelOf('packet');
    if (!box || !box.isConnected || box.hidden) return false;
    const r = box.getBoundingClientRect();
    const w = this.host.doc.defaultView;
    if (r.width < 1 || r.height < 1 || !w) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= w.innerWidth || r.top >= w.innerHeight) return false;
    const cs = w.getComputedStyle(box);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    // covered: what is at its title bar is not the inspector
    const x = Math.max(1, Math.min(w.innerWidth - 2, r.left + r.width / 2));
    const y = Math.max(1, Math.min(w.innerHeight - 2, r.top + 8));
    const at = this.host.doc.elementFromPoint(x, y);
    return !!at && box.contains(at);
  }

  private onInspectorFocusOut = (e: FocusEvent): void => {
    const box = this.tables.panelOf('packet');
    const to = e.relatedTarget as Node | null;
    // the focus went somewhere else on the page (not just out of the window); Play / Pause and Step decide for themselves
    if (box && to && !box.contains(to) && !(to instanceof Element && to.closest('#sim-play, #sim-step, #sim-step-x'))) this.resumeFromInspector();
  };

  private onPointerElsewhere = (e: Event): void => {
    const box = this.tables.panelOf('packet');
    const t = e.target as Element;
    if (!box || box.contains(t)) return;
    // Play / Pause and Step decide for themselves
    if (t.closest && t.closest('#sim-play, #sim-step, #sim-step-x')) return;
    this.resumeFromInspector();
  };

  /** Watch the inspector while it holds the simulation: its focus, a click elsewhere, its visibility. */
  private watchInspector(on: boolean): void {
    const doc = this.host.doc;
    const w = doc.defaultView;
    doc.removeEventListener('focusout', this.onInspectorFocusOut, true);
    doc.removeEventListener('pointerdown', this.onPointerElsewhere, true);
    if (this.inspectorTimer !== null && w) w.clearInterval(this.inspectorTimer);
    this.inspectorTimer = null;
    if (!on || !w) return;
    doc.addEventListener('focusout', this.onInspectorFocusOut, true);
    doc.addEventListener('pointerdown', this.onPointerElsewhere, true);
    this.inspectorTimer = w.setInterval(() => {
      if (this.pausedBy !== 'inspector') return this.watchInspector(false);
      if (!this.inspectorVisible()) this.resumeFromInspector();
    }, 300);
  }

  /** Next exchange: on to the end of the exchange first on screen (or the next one to start), paused. */
  stepExchange(): number {
    this.playing = false;
    this.pausedBy = 'user';
    this.watchInspector(false);
    this.sayState();
    this.schedule();
    this.pacer.stepExchange();
    this.refresh(true);
    return this.t;
  }

  /** Step: to the next message event (a message arrives, or the next one starts at its sender), paused. */
  step(): number {
    this.playing = false;
    this.pausedBy = 'user';
    this.watchInspector(false);
    this.sayState();
    this.schedule();
    this.pacer.step();
    this.refresh(true);
    return this.t;
  }

  setSpeed(s: number): void {
    if (SPEEDS.indexOf(s) < 0) return;
    this.pacer.speed = s;
    this.refresh(true);
  }

  get speed(): number {
    return this.pacer.speed;
  }

  setPacing(mode: PaceMode, scale?: number): void {
    this.pacer.mode = mode;
    if (scale !== undefined && PACE_SCALES.indexOf(scale) >= 0) this.pacer.scale = scale;
    this.refresh(true);
  }

  setSkipIdle(on: boolean): void {
    this.pacer.skipIdle = on;
    this.refresh(true);
  }

  /** "Readable · 1 s per hop · 1×". */
  pacingText(): string {
    return this.pacer.describe();
  }

  /** Run to a time at once (tests; the self-test): what arrived meanwhile is not drawn. */
  runTo(t: number): void {
    this.sim.runTo(t);
    this.pacer.resync();
    this.refresh(true);
  }

  // ------------------------------------------------------------ what is shown

  setShown(id: string, on: boolean): void {
    if (on) this.shown.add(id);
    else this.shown.delete(id);
    this.shownChanged();
  }

  setAllShown(on: boolean): void {
    for (const e of this.entries) if (on) this.shown.add(e.id);
    else this.shown.delete(e.id);
    this.shownChanged();
  }

  /** Show exactly these protocols (the setup's list). */
  setShownSet(ids: Set<string>): void {
    this.shown.clear();
    for (const e of this.entries) if (ids.has(e.id)) this.shown.add(e.id);
    this.shownChanged();
  }

  private shownChanged(): void {
    this.logKey = '';
    if (this.picker) this.picker.set(this.shown);
    if (this.host.shownChanged) this.host.shownChanged(new Set(this.shown));
    this.refresh(true);
  }

  protocolEntries(): SimProtocolEntry[] {
    return this.entries;
  }

  private visible(protocol: string): boolean {
    if (protocol === 'link' || protocol === '') return true;
    return this.shown.has(protocol);
  }

  /** A Send test's messages are always shown (whatever the protocols ticked and the senders); others when their protocol is shown and their sender is chosen. */
  private flightShown = (f: Flight): boolean => f.test !== undefined || ((this.visible(f.protocol) || (!!f.encapProtocols && f.encapProtocols.some((p) => this.visible(p)))) && this.senderOk(f));

  // ------------------------------------------------------------ senders

  /** the devices chosen as senders */
  readonly senders = new Set<string>();
  /** the event log lists the messages of every device (Show all senders) */
  showAllSenders = false;

  /** Every device a sender? */
  allSenders(): boolean {
    return this.senders.size === this.host.model().devices.length;
  }

  /** Is a message one to show: sent by a sender, or part of an exchange a sender started (a reply, a forwarded copy)? */
  senderOk(x: { sender?: string; origin?: string }): boolean {
    if (this.allSenders() || x.sender === undefined) return true;
    return this.senders.has(x.sender) || (x.origin !== undefined && this.senders.has(x.origin));
  }

  /** Choose the senders: they apply at once (logged); what is shown follows; nothing restarts. */
  setSenders(ids: Iterable<string>): void {
    const m = this.host.model();
    const next = new Set<string>();
    for (const id of ids) if (m.index.devices.has(id)) next.add(id);
    const same = next.size === this.senders.size && Array.from(next).every((id) => this.senders.has(id));
    if (same) return;
    this.senders.clear();
    next.forEach((id) => this.senders.add(id));
    const all = this.allSenders();
    const names = m.devices.filter((d) => next.has(d.id)).map((d) => d.id).sort();
    this.sim.engine.setSenders(all ? null : next, all ? 'every device' : names.length ? names.join(', ') : 'none');
    if (this.sendersUi) this.sendersUi.set(this.senders);
    if (this.host.sendersChanged) this.host.sendersChanged(new Set(this.senders));
    this.logKey = '';
    this.actionsKey = '';
    this.badgesKey = '';
    this.refresh(true);
  }

  /** Use a device as a sender, or stop (the device menu, the Actions panel). */
  setSender(dev: string, on: boolean): boolean {
    if (this.senders.has(dev) === on) return false;
    const s = new Set(this.senders);
    if (on) s.add(dev);
    else s.delete(dev);
    this.setSenders(s);
    this.host.toast(`${dev} ${on ? 'is a sender now' : 'is no longer a sender'} (t = ${fmtSec(this.t)}).`);
    return true;
  }

  private sendersUi: SendersPicker | null = null;
  private badgesKey = '';
  private badges: SVGGElement | null = null;

  /** The senders' badges in the diagram (only while not every device is one): a small framed ▶ at a box's top left corner. */
  private drawBadges(): void {
    const scene = this.host.scene();
    const all = this.allSenders();
    const key = `${all ? 'all' : Array.from(this.senders).sort().join(',')}|${this.host.view()}`;
    if (this.badges && this.badges.isConnected && this.badges.parentNode === scene && key === this.badgesKey) return;
    if (this.badges && this.badges.parentNode) this.badges.parentNode.removeChild(this.badges);
    this.badges = null;
    this.badgesKey = key;
    if (!scene || all) return;
    const doc = this.host.doc;
    const NS = 'http://www.w3.org/2000/svg';
    const g = doc.createElementNS(NS, 'g') as SVGGElement;
    g.setAttribute('class', 'layer-sim-senders');
    for (const dev of Array.from(this.senders).sort()) {
      const box = scene.querySelector(`.node[data-ref="device:${dev.replace(/["\\]/g, '\\$&')}"] .dev-box`) as SVGGraphicsElement | null;
      if (!box || typeof box.getBBox !== 'function') continue;
      let b: DOMRect;
      try {
        b = box.getBBox();
      } catch (e) {
        continue;
      }
      const x = b.x;
      const y = b.y;
      const s = doc.createElementNS(NS, 'g');
      s.setAttribute('class', 'sim-sender');
      s.setAttribute('data-sender', dev);
      const t = doc.createElementNS(NS, 'title');
      t.textContent = `${dev}: a sender`;
      const c = doc.createElementNS(NS, 'circle');
      c.setAttribute('cx', x.toFixed(1));
      c.setAttribute('cy', y.toFixed(1));
      c.setAttribute('r', '7');
      const p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', `M${(x - 2.2).toFixed(1)} ${(y - 3.6).toFixed(1)}l5.6 3.6l-5.6 3.6z`);
      s.appendChild(t);
      s.appendChild(c);
      s.appendChild(p);
      g.appendChild(s);
    }
    // above the boxes, below the dots' labels
    const labels = scene.querySelector(':scope > .layer-sim-labels');
    if (labels) scene.insertBefore(g, labels);
    else scene.appendChild(g);
    this.badges = g;
  }

  private powerKey = '';
  private power: SVGGElement | null = null;
  /** the devices' lifecycle, as of a state version of the simulation (every power change counts one) */
  private powerStates: { ver: number; states: Map<string, DeviceStateView> } | null = null;

  /** The devices' lifecycle now (computed again only when the simulation's state changed). */
  private deviceStates(): Map<string, DeviceStateView> {
    const ver = this.sim.engine.stateVersion;
    if (!this.powerStates || this.powerStates.ver !== ver) this.powerStates = { ver, states: this.sim.deviceStates() };
    return this.powerStates.states;
  }

  /**
   * Every device's status in the diagram while the simulation runs, as the
   * simulation has it now (the state packet processing uses): a small pill
   * with an LED and a word — green Operational, red Powered off, blue
   * Booting, a hollow grey LED for Passive, External or Unknown — with the
   * state's line as its tooltip and accessible name. It straddles the box's
   * top edge (else its bottom edge) where nothing else is drawn: no port,
   * cable, relation, label or other indicator under it; the box never moves
   * or resizes. Redrawn when a device's state, the view or the drawing
   * changes; gone when the simulation ends.
   */
  private drawPower(): void {
    const scene = this.host.scene();
    const states = this.deviceStates();
    const all = Array.from(states).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const key = `${all.map((x) => x[0] + '=' + x[1].state + ':' + x[1].detail).join('|')}|${this.host.view()}`;
    if (this.power && this.power.isConnected && this.power.parentNode === scene && key === this.powerKey) return;
    if (this.power && this.power.parentNode) this.power.parentNode.removeChild(this.power);
    this.power = null;
    this.powerKey = key;
    if (!scene || !all.length) return;
    const doc = this.host.doc;
    const NS = 'http://www.w3.org/2000/svg';
    const g = doc.createElementNS(NS, 'g') as SVGGElement;
    g.setAttribute('class', 'layer-sim-power');
    // above the boxes, below the dots' labels
    const labels = scene.querySelector(':scope > .layer-sim-labels');
    if (labels) scene.insertBefore(g, labels);
    else scene.appendChild(g);
    this.power = g;
    const place = new StatusPlacer(scene);
    const H = 14;
    for (const [dev, st] of all) {
      const box = scene.querySelector(`.node[data-ref="device:${dev.replace(/["\\]/g, '\\$&')}"] .dev-box`) as SVGGraphicsElement | null;
      if (!box || typeof box.getBBox !== 'function') continue;
      let b: DOMRect;
      try {
        b = box.getBBox();
      } catch (e) {
        continue;
      }
      const s = doc.createElementNS(NS, 'g');
      s.setAttribute('class', 'sim-power');
      s.setAttribute('data-power', st.state);
      s.setAttribute('data-device', dev);
      s.setAttribute('role', 'img');
      s.setAttribute('aria-label', `${dev}: ${st.detail}`);
      const t = doc.createElementNS(NS, 'title');
      t.textContent = `${dev}: ${st.detail}`;
      const r = doc.createElementNS(NS, 'rect');
      const led = doc.createElementNS(NS, 'circle');
      led.setAttribute('class', 'sim-led');
      led.setAttribute('r', '3.5');
      const tx = doc.createElementNS(NS, 'text');
      tx.textContent = st.label;
      s.appendChild(t);
      s.appendChild(r);
      s.appendChild(led);
      s.appendChild(tx);
      g.appendChild(s);
      // its width from its word, then a free place on the box's edge
      let tw = st.label.length * 5.6;
      try {
        tw = (tx as SVGTextContentElement).getComputedTextLength() || tw;
      } catch (e) {
        /* not laid out: the estimate */
      }
      const w = Math.ceil(tw + 22);
      const at = place.find(b, w, H);
      r.setAttribute('x', at.x.toFixed(1));
      r.setAttribute('y', at.y.toFixed(1));
      r.setAttribute('width', String(w));
      r.setAttribute('height', String(H));
      r.setAttribute('rx', String(H / 2));
      led.setAttribute('cx', (at.x + 9).toFixed(1));
      led.setAttribute('cy', (at.y + H / 2).toFixed(1));
      tx.setAttribute('x', (at.x + 16).toFixed(1));
      tx.setAttribute('y', (at.y + H / 2 + 3.5).toFixed(1));
      s.setAttribute('data-edge', at.edge);
    }
  }

  /** The devices' lifecycle for the diagram's marks, by ref (those powered off or booting). */
  powerMarks(): Map<string, 'off' | 'booting'> {
    const out = new Map<string, 'off' | 'booting'>();
    for (const [id, st] of this.deviceStates()) if (st.state === 'off' || st.state === 'booting') out.set('device:' + id, st.state);
    return out;
  }

  /** The on-screen length of a flight's line (diagram units), in the view on screen; null elsewhere. */
  private lengths = new Map<string, number | null>();
  private trackLength(f: Flight): number | null {
    if (f.view !== this.host.view()) return null;
    const k = `${f.view}|${f.track.ref}|${f.track.from}|${f.track.to}`;
    if (this.lengths.has(k)) return this.lengths.get(k) as number | null;
    const scene = this.host.scene();
    const g = scene ? findTrack(scene, f.track) : null;
    const len = g ? g.len : null;
    this.lengths.set(k, len);
    return len;
  }

  color(protocol: string): string {
    if (FIXED_COLORS[protocol]) return FIXED_COLORS[protocol];
    const id = protocol.indexOf('custom:') === 0 ? protocol.slice(7) : protocol;
    return lookupProtocol(this.host.model().protocols, id).color;
  }

  /** A track's two devices, where it has them (the sender and receiver marks). */
  private trackEnds(t: Track): { from: string | null; to: string | null } {
    const m = this.host.model();
    if (t.ref.indexOf('link:') === 0) {
      const l = m.index.links.get(t.ref.slice(5));
      if (!l) return { from: null, to: null };
      return t.from === 'a' ? { from: l.a.device, to: l.b.device } : { from: l.b.device, to: l.a.device };
    }
    const dev = (x: string): string | null => (m.index.devices.has(x) ? x : null);
    return { from: dev(t.from), to: dev(t.to) };
  }

  /** What the diagram draws now: the hops the pacing has on screen, of shown protocols, in this view. */
  drawItems(): DrawItem[] {
    const view = this.host.view();
    const follow = this.pacer.follow;
    const out: DrawItem[] = [];
    for (const it of this.pacer.items) {
      if (!it.drawn || it.f.view !== view || it.f.hidden || !this.flightShown(it.f)) continue;
      const st = this.pacer.state(it);
      // a Send test's hops: never faded, with their trail (as a message followed)
      const test = it.f.test !== undefined;
      out.push({ f: it.f, st, prev: it.parent && it.transit ? it.parent.f.track : undefined, faded: !!follow && it.key !== follow.key && !test, followed: (!!follow && it.key === follow.key) || test, test });
    }
    return out;
  }

  /** The hops of shown protocols beyond the dot limit that would be on screen now. */
  private queued(): number {
    const view = this.host.view();
    return this.pacer.items.filter((it) => !it.drawn && it.f.view === view && !it.f.hidden && this.flightShown(it.f) && this.pacer.state(it).phase !== 'gone' && this.pacer.state(it).phase !== 'waiting').length;
  }

  /** The VMs on another host than their own now (restarted by their HA cluster). */
  placement(): Map<string, string> {
    return new Map(this.sim.engine.vmHost);
  }

  /** Draw the dots now, and (when `ui`) the panels and the tables; what is down changed: the marks. */
  refresh(ui: boolean): void {
    if (this.stopped) return;
    if (this.sim.engine.stateVersion !== this.stateSeen) {
      this.stateSeen = this.sim.engine.stateVersion;
      this.actionsKey = '';
      this.host.changed();
    }
    this.anim.setScene(this.host.scene());
    this.drawBadges();
    this.drawPower();
    const view = this.host.view();
    const r = this.anim.draw(this.drawItems(), { view, reduce: this.host.reduce(), color: (p) => this.color(p), activity: this.pacer.activity(view), name: (p) => this.protocolName(p) });
    this.notDrawn = r.left + this.queued();
    this.updateClock();
    if (!ui) return;
    this.host.tick();
    this.tables.update();
    this.updatePanels();
  }

  /** The diagram was drawn again: the dots on the new scene. */
  sceneChanged(): void {
    this.lengths.clear();
    this.badgesKey = '';
    this.powerKey = '';
    this.refresh(false);
  }

  // ------------------------------------------------------------ network events

  private did(ok: boolean, text: string): boolean {
    if (!ok) return false;
    this.actionsKey = '';
    this.refresh(true);
    this.host.toast(`${text} at t = ${fmtSec(this.t)}.`);
    return true;
  }

  /** A protocol's short name for the cable activity ("OSPF", "ARP"): its setup entry's label, else its id. */
  private protocolName(p: string): string {
    const e = this.entries.find((x) => x.id === p);
    if (!e) return p === 'mcast' ? 'Multicast' : p.toUpperCase();
    // "ICMP / ICMPv6" → "ICMP", "TCP (tests)" → "TCP"
    return e.label.replace(/ \(.*\)$/, '').replace(/ \/ .*$/, '');
  }

  private label(ref: string): string {
    return refLabel(this.host.model(), ref);
  }

  /** Fail a cable or relation (several may be down at once). */
  failLink(ref: string): boolean {
    return this.did(this.sim.fail(ref), `${this.cap(this.label(ref))} failed`);
  }

  restoreLink(ref: string): boolean {
    return this.did(this.sim.restore(ref), `${this.cap(this.label(ref))} restored`);
  }

  /** Start flapping (a cable's or a port's menu, Interface actions): an event of the list. */
  startFlap(ref: string): boolean {
    const a = this.sim.actFlap(ref);
    return this.did(!a.error, `${this.cap(this.label(ref))} starts flapping`);
  }

  stopFlap(ref: string): boolean {
    return this.did(this.sim.stopFlap(ref), `${this.cap(this.label(ref))} stops flapping`);
  }

  /** Shut interface (an interface's menu, Interface actions): an event of the list. */
  shut(dev: string, iface: string): boolean {
    const a = this.sim.actShut(dev, iface);
    return this.did(!a.error, `${dev}:${iface} shut`);
  }

  noShut(dev: string, iface: string): boolean {
    return this.did(this.sim.noShut(dev, iface), `${dev}:${iface} no shut`);
  }

  powerOff(dev: string): boolean {
    return this.did(this.sim.powerOff(dev), `${dev} powered off`);
  }

  powerOn(dev: string): boolean {
    return this.did(this.sim.powerOn(dev), `${dev} powered on (booting)`);
  }

  /** End an event of the list. */
  endEvent(ev: NetEvent): boolean {
    return this.did(this.sim.end(ev), `${this.cap(this.label(ev.ref))}: ${this.endLabel(ev).toLowerCase()}`);
  }

  private endLabel(ev: NetEvent): string {
    const m: { [k: string]: string } = { fail: 'Restore', flap: 'Stop flapping', shut: 'No shut', power: 'Power on', engine: 'Start engine', join: 'Leave group', leave: 'Join again', stream: 'Stop stream', stopped: 'Start stream' };
    return m[ev.kind];
  }

  // ------------------------------------------------------------ multicast: joins and streams

  /** Join multicast group… / Start multicast stream… from a device's menu: that form of Network events, open, with the device. */
  multicastFrom(dev: string, what: 'join' | 'stream'): void {
    const f = what === 'join' ? this.joinForm : this.streamForm;
    if (!f) return;
    this.openSection(what === 'join' ? 'sim-ne-join' : 'sim-ne-stream');
    f.setDevice(dev);
    f.focus();
  }

  /** Interface actions from an interface's menu: the form, open, with the interface. */
  interfaceFrom(dev: string, iface?: string): void {
    if (!this.ifaceForm) return;
    this.openSection('sim-ne-iface');
    this.ifaceForm.setTarget(dev, iface);
    this.ifaceForm.focus();
  }

  /** Open a section of Network events (its heading's button), and show it. */
  private openSection(id: string): void {
    const box = this.host.actionsBox ? this.host.actionsBox() : null;
    const t = box ? (box.querySelector('#' + id + '-toggle') as HTMLButtonElement | null) : null;
    if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
    if (t) t.scrollIntoView({ block: 'nearest' });
  }

  /** Join multicast group: an event of the list (done when a multicast router records it, or its reports are sent). */
  joinGroup(dev: string, iface: string, group: string, sources: string[]): string {
    const a = this.sim.actJoin(dev, iface, group, sources);
    // its first reports or datagrams are on screen now (paused too: there they wait for Play)
    this.pacer.take();
    this.logKey = '';
    this.actionsKey = '';
    this.refresh(true);
    if (a.error) return a.error;
    return `${a.target}: joining at t = ${fmtSec(this.t)}; see Active events.`;
  }

  leaveGroup(dev: string, iface: string, group: string): boolean {
    return this.did(this.sim.leaveGroup(dev, iface, group), `${dev}:${iface} leaves ${group}`);
  }

  /** Start multicast stream: an event of the list, running until Stop stream. */
  startStream(dev: string, iface: string, group: string, port: number, interval: number, size: number): string {
    const a = this.sim.actStream(dev, iface, group, port, interval, size);
    // its first reports or datagrams are on screen now (paused too: there they wait for Play)
    this.pacer.take();
    this.logKey = '';
    this.actionsKey = '';
    this.refresh(true);
    if (a.error) return a.error;
    return `${a.target}: streaming from t = ${fmtSec(this.t)}, one datagram every ${interval / 1000} s of real time; see Active events.`;
  }

  stopStream(dev: string, iface: string, group: string): boolean {
    return this.did(this.sim.stopStream(dev, iface, group), `${dev}:${iface} stops its stream to ${group}`);
  }

  private cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private eventOf(ref: string, kind?: NetEvent['kind']): NetEvent | undefined {
    return this.sim.netEvents().find((e) => e.ref === ref && (!kind || e.kind === kind));
  }

  /** The cables and relations that can fail. */
  links(): Array<{ ref: string; label: string }> {
    const m = this.host.model();
    const out: Array<{ ref: string; label: string }> = [];
    for (const l of m.links.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) out.push({ ref: 'link:' + l.id, label: `Cable ${l.id} (${l.a.device} – ${l.b.device})` });
    for (const r of m.relations.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) out.push({ ref: 'relation:' + r.id, label: `${lookupProtocol(m.protocols, r.protocol, r.category).label} ${r.id}` });
    return out;
  }

  /** Every interface ("dev:iface"), for shutting and flapping. */
  interfaces(): string[] {
    const out: string[] = [];
    for (const d of this.host.model().devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) for (const i of deviceInterfaces(d).slice().sort((a, b) => (a.id < b.id ? -1 : 1))) out.push(d.id + ':' + i.id);
    return out;
  }

  private cabled(dev: string, iface: string): boolean {
    // (a host's uplink: its cable ends at its virtual switch in the simulation)
    const p = this.sim.engine.simPort(dev, iface);
    return this.sim.engine.net.ends.has(p.device + '|' + p.port);
  }

  // ------------------------------------------------------------ the tables

  /** The tables a device has (the Actions panel's Show … and the status side's tabs). */
  deviceTables(dev: string): DevTable[] {
    const d = this.sim.tableDevices().find((x) => x.id === dev);
    if (!d) return [];
    const out: DevTable[] = [];
    if (d.arp) out.push('arp');
    if (d.mac) out.push('mac');
    if (d.arp) out.push('conn');
    if (this.isFirewall(dev)) out.push('fw');
    if (this.sim.multicast.igmpDevice(dev)) out.push('igmp');
    if (this.sim.multicast.mcRouter(dev)) out.push('mroute');
    if (this.sim.multicast.snoopDevice(dev)) out.push('snoop');
    if (this.sim.multicast.memberDevice(dev)) out.push('members');
    // DHCP and DNS: a server's leases and zones, a host's resolver cache
    if (this.sim.netsvc.hasLeases(dev)) out.push('dhcp');
    if (this.sim.netsvc.hasZones(dev)) out.push('dnszone');
    if (this.sim.netsvc.resolves(dev)) out.push('dnscache');
    return out;
  }

  /** The leases the diagram writes into the clients' reserved lines (the model is unchanged). */
  leaseMarks(): Map<string, string> {
    const out = new Map<string, string>();
    for (const l of this.sim.leases()) out.set(`iface:${l.dev}:${l.iface}`, leaseText(l.text, l.kind));
    return out;
  }

  /** Show a device's table in the simulation panel's status side (the device becomes the selected one). */
  showTable(kind: DevTable, dev: string): boolean {
    if (this.deviceTables(dev).indexOf(kind) < 0) return false;
    if (this.host.select && (!this.host.selected || this.host.selected() !== 'device:' + dev)) this.host.select('device:' + dev);
    this.statusView = { kind, dev };
    this.statusKey = '';
    this.actionsKey = '';
    this.updatePanels();
    return true;
  }

  /** The protocols' status again on the status side. */
  showStatus(): void {
    this.statusView = null;
    this.statusKey = '';
    this.updatePanels();
  }

  private tableData(kind: DevTable, dev: string): () => ReturnType<Parameters<TablePanels['inline']>[3]> {
    if (kind === 'igmp') return () => this.sim.igmpTable(dev);
    if (kind === 'snoop') return () => this.sim.snoopTable(dev);
    if (kind === 'members') return () => this.sim.memberTable(dev);
    if (kind === 'mroute') return () => this.sim.mrouteTable(dev);
    if (kind === 'dhcp') return () => this.sim.leaseGrid(dev);
    if (kind === 'dnscache') return () => this.sim.dnsCacheGrid(dev);
    if (kind === 'dnszone') return () => this.sim.dnsZoneGrid(dev);
    if (kind === 'arp') return () => ({ v4: this.sim.arpTable(dev), v6: this.sim.ndTable(dev), timers: this.sim.arpTimers(dev), scale: this.sim.timerScale });
    if (kind === 'mac') return () => ({ rows: this.sim.macTable(dev), timers: this.sim.macTimers(dev), scale: this.sim.timerScale });
    if (kind === 'conn') return () => ({ rows: this.sim.connTable(dev), listening: this.sim.transport.listening(dev).text });
    return () => ({ rows: this.sim.sessionTable(dev), timers: this.sim.sessionTimers(dev).map(timerOf) });
  }

  private isFirewall(dev: string): boolean {
    const d = this.host.model().index.devices.get(dev);
    return !!d && capabilities(d).firewallPolicy;
  }

  /** The pointer over the diagram (diagram coordinates, the zoom), or off it (null): the packet within its reach is outlined. */
  pointerAt(p: { x: number; y: number } | null, k: number): number | null {
    return this.anim.pointerAt(p ? { x: p.x, y: p.y, k } : null);
  }

  /** The packet a click at a point opens (the nearest dot within its hit area, as outlined), null none. */
  flightAt(p: { x: number; y: number }, k: number): number | null {
    return this.anim.flightAt(p.x, p.y, k);
  }

  /** Where a packet's dot is drawn now (diagram coordinates). */
  dotOf(id: number): { x: number; y: number } | null {
    return this.anim.dotOf(id);
  }

  /** The packet inspector for a dot (a flight): the simulation pauses first. */
  inspectFlight(id: number, near?: { x: number; y: number; w: number; h: number } | null): boolean {
    const it = this.pacer.find(id);
    const f = it ? it.f : this.sim.engine.flights.find((x) => x.id === id);
    if (!f || !f.hdr) return false;
    this.inspectorPause();
    const m = this.host.model();
    let where = `t = ${fmtSec(f.t0)}`;
    if (f.track.ref.indexOf('link:') === 0) {
      const l = m.index.links.get(f.track.ref.slice(5));
      if (l) where += `, on cable ${l.id} (${f.track.from === 'a' ? l.a.device + ' → ' + l.b.device : l.b.device + ' → ' + l.a.device})`;
    }
    const key = it ? it.key : conversationKey(f.protocol, f.hdr, f.label);
    this.inspect(f.hdr, where, near, key, f.label);
    return true;
  }

  /** The packet inspector for a message of the event log (its frame as sent). */
  inspectEvent(seq: number): boolean {
    const e = this.sim.events().find((x) => x.seq === seq);
    if (!e || !e.hdr) return false;
    this.inspectorPause();
    this.inspect(e.hdr, `as ${e.device || 'it'} sent it at t = ${fmtSec(e.t)}`, null, conversationKey(e.protocol, e.hdr, e.hdr.label), e.hdr.label);
    return true;
  }

  private inspect(h: Headers, where: string, near: { x: number; y: number; w: number; h: number } | null | undefined, key: string, label: string): void {
    const data = (): { hdr: Headers; where: string; follow: { on: boolean; act: () => void } } => ({
      hdr: h,
      where,
      follow: {
        on: !!this.pacer.follow && this.pacer.follow.key === key,
        act: () => {
          if (this.pacer.follow && this.pacer.follow.key === key) this.follow(null);
          else {
            this.follow({ key, label });
            // following: the inspector stays open beside the running simulation
            this.resumeFromInspector();
          }
          this.inspect(h, where, null, key, label);
        },
      },
    });
    this.tables.show('packet', 'inspector', near || null, data);
  }

  /** Follow a message's conversation (null: stop following). */
  follow(f: { key: string; label: string } | null): void {
    this.pacer.follow = f;
    this.refresh(true);
    this.host.toast(f ? `Following ${f.label} and its replies: they alone set the pace now.` : 'Not following a message any more.');
  }

  /** Follow the conversation of a dot (tests). */
  followFlight(id: number | null): boolean {
    const ok = this.pacer.followFlight(id);
    this.refresh(true);
    return ok;
  }

  setTimerScale(n: number): void {
    if (TIMER_SCALES.indexOf(n) < 0) return;
    this.sim.setTimerScale(n);
    this.refresh(true);
  }

  // ------------------------------------------------------------ parameters

  /** A simulation-wide parameter changed in the setup: it applies now. */
  setParam(key: string, v: ParamValue | undefined): void {
    this.sim.setParam(key, v);
    if (this.host.paramsChanged) this.host.paramsChanged(this.sim.params.simValues());
    this.logKey = '';
    this.typicalHop.physical = this.physicalTypical();
    this.refresh(true);
  }

  /** The model changed during the simulation (a device's Simulation settings, or their undo): they apply now. */
  modelChanged(model: Model): number {
    const n = this.sim.deviceParamsFrom(model).length;
    if (n) {
      this.logKey = '';
      this.actionsKey = '';
      this.refresh(true);
    }
    return n;
  }

  // ------------------------------------------------------------ the events of an object (menus and the Actions panel)

  /** What can happen to an object: the in-diagram menu's entries and the Actions panel's buttons. `x`, `y`: where a second menu opens. */
  itemsFor(ref: string | null, x = 0, y = 0): MenuItem[] {
    if (!ref) return [];
    const r = ref.indexOf('hub:') === 0 ? 'relation:' + ref.slice(4) : ref;
    const items: MenuItem[] = [];
    if (r.indexOf('link:') === 0 || r.indexOf('relation:') === 0) {
      if (this.eventOf(r, 'fail')) items.push({ label: 'Restore link', act: () => this.restoreLink(r) });
      else items.push({ label: 'Fail link', act: () => this.failLink(r) });
      if (r.indexOf('link:') === 0) {
        if (this.eventOf(r, 'flap')) items.push({ label: 'Stop flapping', act: () => this.stopFlap(r) });
        else items.push({ label: 'Start flapping', act: () => this.startFlap(r) });
        this.linkDomainItems(r.slice(5), items, x, y);
      }
    } else if (r.indexOf('device:') === 0) {
      const dev = r.slice(7);
      const d = this.sim.tableDevices().find((q) => q.id === dev);
      const tabs = this.deviceTables(dev);
      const show: { [k in DevTable]: string } = { arp: 'Show ARP table', mac: 'Show MAC table', conn: 'Show connections', fw: 'Show sessions', igmp: 'Show IGMP / MLD groups', mroute: 'Show multicast routes', snoop: 'Show snooping table', members: 'Show group memberships', dhcp: 'Show DHCP leases', dnscache: 'Show DNS cache', dnszone: 'Show DNS zone' };
      for (const k of ['arp', 'mac', 'conn', 'fw'] as DevTable[]) if (tabs.indexOf(k) >= 0) items.push({ label: show[k], act: () => void this.showTable(k, dev) });
      items.push({ label: 'Send network packets…', act: () => this.sendTestFrom(dev) });
      // multicast: a host's memberships, a router's IGMP / MLD groups and multicast routes, a switch's snooping table
      for (const k of ['members', 'igmp', 'mroute', 'snoop'] as DevTable[]) if (tabs.indexOf(k) >= 0) items.push({ label: show[k], act: () => void this.showTable(k, dev) });
      // DHCP and DNS
      for (const k of ['dhcp', 'dnszone', 'dnscache'] as DevTable[]) if (tabs.indexOf(k) >= 0) items.push({ label: show[k], act: () => void this.showTable(k, dev) });
      if (this.senders.has(dev)) items.push({ label: 'Stop as sender', act: () => void this.setSender(dev, false) });
      else items.push({ label: 'Use as sender', act: () => void this.setSender(dev, true) });
      const sdv = this.sim.engine.net.devices.get(dev);
      if (d && d.arp && sdv && !sdv.routes) {
        items.push({ label: 'Join multicast group…', act: () => this.multicastFrom(dev, 'join') });
        for (const j of this.sim.multicast.joined(dev)) items.push({ label: `Leave group ${j.group}`, act: () => void this.leaveGroup(dev, j.iface, j.group) });
        items.push({ label: 'Start multicast stream…', act: () => this.multicastFrom(dev, 'stream') });
        for (const st of this.sim.multicast.streamsOf(dev)) {
          if (st.running) items.push({ label: `Stop stream ${st.group}`, act: () => void this.stopStream(dev, st.iface, st.group) });
          else items.push({ label: `Start stream ${st.group} again`, act: () => void this.did(this.sim.multicast.restartStream(dev, st.iface, st.group), `${dev} streams to ${st.group} again`) });
        }
      }
      this.domainItems(dev, items, x, y);
      // (an external network, a patch panel or TAP has no power of its own: no Power off)
      const lifecycle = hasLifecycle(this.sim.deviceState(dev));
      if (lifecycle && this.sim.engine.off.has(dev)) items.push({ label: this.sim.engine.booting.has(dev) ? 'Power off (stop booting)' : 'Power on', act: () => (this.sim.engine.booting.has(dev) ? this.powerOff(dev) : this.powerOn(dev)) });
      else if (lifecycle) items.push({ label: 'Power off', act: () => this.powerOff(dev) });
      // a container host: its engine
      const md = this.sim.model.index.devices.get(dev);
      if (md && md.containerEngine && !this.sim.engine.off.has(dev)) {
        if (this.sim.engine.enginesOff.has(dev)) items.push({ label: 'Start container engine', act: () => this.did(this.sim.startEngine(dev), `${dev}: container engine started`) });
        else items.push({ label: 'Stop container engine', act: () => this.did(this.sim.stopEngine(dev), `${dev}: container engine stopped`) });
      }
      const ifs = this.interfaces().filter((k) => k.indexOf(dev + ':') === 0);
      if (ifs.length) items.push({ label: 'Shut an interface…', act: () => this.interfaceMenu(dev, x, y) });
    } else if (r.indexOf('iface:') === 0) {
      const rest = r.slice(6);
      const i = rest.indexOf(':');
      this.ifaceItems(rest.slice(0, i), rest.slice(i + 1), items);
    } else if (r.indexOf('vswitch:') === 0 || r.indexOf('cnet:') === 0) {
      // a virtual switch or a container network: the bridge the simulation runs it as
      const parts = r.split(':');
      const id = virtBridgeId(parts[1], parts.slice(2).join(':'));
      if (this.sim.engine.net.devices.has(id)) items.push({ label: 'Show MAC table', act: () => void this.showTable('mac', id) });
    }
    return items;
  }

  /** A click in the diagram during the simulation: a short menu at that spot for a cable, a relation, a device or an interface. */
  diagramClick(ref: string | null, x: number, y: number): boolean {
    if (!ref) return false;
    const items = this.itemsFor(ref, x, y);
    if (!items.length) return false;
    const r = ref.indexOf('hub:') === 0 ? 'relation:' + ref.slice(4) : ref;
    // a device's menu says its state first ("Operational", "Booting: …", "Powered off at …", "Passive: …"), as its indicator in the diagram does
    const st = r.indexOf('device:') === 0 ? this.sim.deviceState(r.slice(7)) : null;
    this.openMenu(this.label(r), items, x, y, st);
    return true;
  }

  private ifaceItems(dev: string, iface: string, items: MenuItem[]): void {
    const ref = `iface:${dev}:${iface}`;
    if (this.eventOf(ref, 'shut')) items.push({ label: 'No shut', act: () => this.noShut(dev, iface) });
    else items.push({ label: 'Shut interface', act: () => this.shut(dev, iface) });
    if (this.cabled(dev, iface)) {
      if (this.eventOf(ref, 'flap')) items.push({ label: 'Stop flapping', act: () => this.stopFlap(ref) });
      else items.push({ label: 'Start flapping', act: () => this.startFlap(ref) });
    }
  }

  /** Highlight broadcast domain (of its one interface, or a choice of them), or clear the highlight. */
  private domainItems(dev: string, items: MenuItem[], x: number, y: number): void {
    if (this.domain) items.push({ label: 'Clear broadcast domain highlight', act: () => this.clearDomain() });
    const ifs = this.sim.engine.broadcastIfaces(dev);
    if (ifs.length === 1) items.push({ label: 'Highlight broadcast domain', act: () => this.highlightDomain({ dev, iface: ifs[0] }) });
    else if (ifs.length > 1) items.push({ label: 'Highlight broadcast domain…', act: () => this.openMenu(`${dev}: broadcast domain of`, ifs.map((i) => ({ label: i, act: () => void this.highlightDomain({ dev, iface: i }) })), x, y) });
  }

  private linkDomainItems(link: string, items: MenuItem[], x: number, y: number): void {
    if (this.domain) items.push({ label: 'Clear broadcast domain highlight', act: () => this.clearDomain() });
    const vlans = this.sim.engine.linkVlans(link);
    if (vlans.length === 1) items.push({ label: 'Highlight broadcast domain', act: () => this.highlightDomain({ link, vlan: vlans[0] }) });
    else if (vlans.length > 1) items.push({ label: 'Highlight broadcast domain…', act: () => this.openMenu(`Cable ${link}: broadcast domain of`, vlans.map((v) => ({ label: v ? `VLAN ${v}` : 'untagged', act: () => void this.highlightDomain({ link, vlan: v }) })), x, y) });
  }

  /** The device menu's second level: its interfaces, each shut or no shut. */
  private interfaceMenu(dev: string, x: number, y: number): void {
    const items: MenuItem[] = [];
    for (const k of this.interfaces().filter((q) => q.indexOf(dev + ':') === 0)) {
      const iface = k.slice(dev.length + 1);
      const shut = !!this.eventOf('iface:' + k, 'shut');
      items.push({ label: `${shut ? 'No shut' : 'Shut'} ${iface}`, act: () => (shut ? this.noShut(dev, iface) : this.shut(dev, iface)) });
    }
    this.openMenu(`${dev}: interfaces`, items, x, y);
  }

  private openMenu(title: string, items: MenuItem[], x: number, y: number, state: { state: string; detail: string } | null = null): void {
    this.closeMenu();
    const doc = this.host.doc;
    const back = doc.activeElement as HTMLElement | null;
    const buttons = items.map((it) => {
      const b = el(doc, 'button', { type: 'button', role: 'menuitem', class: 'sim-menu-item' }, [it.label]);
      b.addEventListener('click', () => {
        this.closeMenu();
        it.act();
      });
      return b;
    });
    const head = [el(doc, 'div', { class: 'sim-menu-title', 'aria-hidden': 'true' }, [title])];
    if (state) head.push(el(doc, 'div', { class: 'sim-menu-state', 'data-power': state.state, 'aria-hidden': 'true' }, [state.detail]));
    const box = el(doc, 'div', { class: 'sim-menu', role: 'menu', 'aria-label': `Simulation: ${title}${state ? '. ' + state.detail : ''}` }, [...head, ...buttons]);
    doc.body.appendChild(box);
    const w = doc.defaultView;
    const vw = w ? w.innerWidth : 1000;
    const vh = w ? w.innerHeight : 800;
    const r = box.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(vw - r.width - 8, x + 6)) + 'px';
    box.style.top = Math.max(8, Math.min(vh - r.height - 8, y + 6)) + 'px';
    box.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(doc.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu();
        if (back && typeof back.focus === 'function') back.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
      } else if (e.key === 'Tab') this.closeMenu();
    });
    const outside = (e: Event): void => {
      if (!box.contains(e.target as Node)) this.closeMenu();
    };
    w && w.setTimeout(() => doc.addEventListener('pointerdown', outside, true), 0);
    (box as unknown as { _outside: (e: Event) => void })._outside = outside;
    this.menuBox = box;
    buttons[0].focus();
  }

  closeMenu(): void {
    const b = this.menuBox;
    if (!b) return;
    this.menuBox = null;
    this.host.doc.removeEventListener('pointerdown', (b as unknown as { _outside: (e: Event) => void })._outside, true);
    if (b.parentNode) b.parentNode.removeChild(b);
  }

  menuOpen(): boolean {
    return !!this.menuBox;
  }

  // ------------------------------------------------------------ Send test

  /** Send network packets… from a device's menu: that form of Network events, open, with the device as the source. */
  sendTestFrom(dev: string): void {
    if (!this.testForm) return;
    this.openSection('sim-ne-send');
    this.testForm.setSource(dev);
  }

  /**
   * Send a test now, at the current simulated time (the Send test form;
   * tests): it starts at once, in parallel with the traffic, only after
   * what it really needs (ARP or NDP, a DNS answer, a DHCP lease). Paused,
   * it is sent at the current time and moves when the simulation plays
   * (`play`: Send and play).
   */
  sendTest(o: { from: string; via?: string; to: string; kind: TestKind; port?: number; size?: number; df?: boolean; keep?: boolean }, play = false): string {
    const t = this.sim.sendTest(o);
    this.logKey = '';
    // its first hops are on screen now (paused too: there they wait for Play)
    this.pacer.take();
    if (typeof t !== 'string' && play && !this.playing) this.setPlaying(true);
    this.refresh(true);
    if (typeof t === 'string') return t;
    return this.playing ? `Test sent at t = ${fmtSec(this.t)}: ${t.series}.` : `Sent at t = ${fmtSec(this.t)}: ${t.series}. It starts when the simulation plays.`;
  }

  /**
   * Send a test as the form describes it (a delivery type, its destination, a protocol, the messages):
   * the first message now, at the current simulated time; the others on the simulation's timeline
   * (paused, they wait for Play; Stop in the list ends the series).
   */
  sendPlan(p: TestPlan, play = false): string {
    const a = this.sim.actSend(p);
    const r = a.run || (a.error as string);
    this.logKey = '';
    this.pacer.take();
    if (typeof r !== 'string' && play && !this.playing) this.setPlaying(true);
    this.refresh(true);
    if (typeof r === 'string') return r;
    const more = r.count > 1 ? `Message 1 of ${r.count} sent at t = ${fmtSec(r.t0)}, then one every ${secText(r.interval)}: ${r.series}; see Active events.` : `Sent at t = ${fmtSec(r.t0)}: ${r.series}; see Active events.`;
    return this.playing ? (r.count > 1 ? more : `Test sent at t = ${fmtSec(r.t0)}: ${r.series}.`) : `${more} It starts when the simulation plays.`;
  }

  /** An event's control in Active events: Stop, No shut, Leave group. */
  actionControl(id: number, op: 'stop' | 'noshut' | 'leave'): boolean {
    if (!this.sim.actionControl(id, op)) return false;
    this.eventsKey = '';
    this.logKey = '';
    this.refresh(true);
    return true;
  }

  /** Open a message of a send in the packet inspector: its first message of the event log. */
  inspectTest(testId: number): boolean {
    const e = this.sim.events().find((x) => x.test === testId && x.kind === 'message' && !!x.hdr);
    return e ? this.inspectEvent(e.seq) : false;
  }

  /** Is a Send test on its way (sent, not answered or failed yet, not waiting for a DHCP lease)? While it is, it alone sets the pace. */
  testRunning(): boolean {
    return this.sim.tests().some((t) => !t.done && t.result.indexOf('waiting for a DHCP lease') !== 0);
  }


  // ------------------------------------------------------------ the panels

  /** Build the three panels into their boxes (the simulation starts). */
  mount(): void {
    const s = this.host.setupBox ? this.host.setupBox() : null;
    const a = this.host.actionsBox ? this.host.actionsBox() : null;
    const d = this.host.dockBox ? this.host.dockBox() : null;
    if (s) this.buildSetup(s);
    if (a) this.buildActions(a);
    if (d) this.buildDock(d);
    this.logKey = this.statusKey = this.eventsKey = this.actionsKey = '';
    this.updatePanels();
  }

  /** The selection changed: the Actions panel's object, and the status side's device tables. */
  selectionChanged(): void {
    const sel = this.host.selected ? this.host.selected() : null;
    if (this.statusView && sel !== 'device:' + this.statusView.dev) this.statusView = null;
    this.actionsKey = '';
    this.statusKey = '';
    this.updatePanels();
  }

  private sec(doc: Document, id: string, title: string, kids: Array<Node | null>): HTMLElement {
    return el(doc, 'section', { class: 'sp-sec', id, 'aria-labelledby': id + '-h' }, [el(doc, 'h3', { class: 'sp-h', id: id + '-h' }, [title]), ...kids]);
  }

  /** A disclosure: a button with aria-expanded and the body it opens. */
  private disclosure(doc: Document, id: string, title: string, body: HTMLElement, open = false): HTMLElement {
    const btn = el(doc, 'button', { type: 'button', class: 'sp-toggle', id: id + '-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id }, [el(doc, 'span', { class: 'psec-caret', 'aria-hidden': 'true' }, ['▸']), el(doc, 'span', {}, [title])]);
    body.id = id;
    body.hidden = !open;
    btn.addEventListener('click', () => {
      const o = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', o ? 'true' : 'false');
      body.hidden = !o;
    });
    return el(doc, 'div', { class: 'sp-disc' }, [btn, body]);
  }

  /** Simulation setup: the protocols (open), the Layer 1–4 parameters (collapsed), the table timers. */
  private buildSetup(box: HTMLElement): void {
    const doc = this.host.doc;
    while (box.firstChild) box.removeChild(box.firstChild);
    this.picker = protocolPicker(doc, { id: 'sim-setup-protos', entries: this.entries, shown: this.shown, color: (p) => this.color(p), onChange: (ids) => this.setShownSet(ids) });
    box.appendChild(this.picker.el);
    box.appendChild(el(doc, 'p', { class: 'muted small sp-note' }, ['Every protocol runs; unchecked ones are not drawn or logged.']));
    this.sendersUi = sendersPicker(doc, { id: 'sim-setup-senders', model: this.host.model(), selected: this.senders, open: false, diagram: () => (this.host.diagramDevices ? this.host.diagramDevices() : new Set()), onChange: (s) => this.setSenders(s) });
    box.appendChild(this.sendersUi.el);
    this.editor = paramEditor(doc, { id: 'sim-pw', values: this.sim.params.simValues(), onChange: (k, v) => this.setParam(k, v) });
    box.appendChild(this.editor.el);
    const scale = el(doc, 'select', { id: 'sim-scale' }) as HTMLSelectElement;
    for (const n of TIMER_SCALES) scale.appendChild(el(doc, 'option', { value: String(n) }, [n === 1 ? 'Real time (1:1)' : `1:${n} (${n}× faster)`]));
    scale.value = String(this.sim.timerScale);
    scale.addEventListener('change', () => this.setTimerScale(Number(scale.value)));
    box.appendChild(
      el(doc, 'div', { class: 'sp-field' }, [
        el(doc, 'label', { for: 'sim-scale' }, ['Table timers']),
        scale,
        el(doc, 'p', { class: 'muted small', id: 'sim-scale-help' }, ['Shortens the ARP, neighbour and MAC timers’ timeline only (the ARP timeout is 4 h).']),
      ]),
    );
    scale.setAttribute('aria-describedby', 'sim-scale-help');
  }

  /** Actions: Network events (four actions, each with its form), Active events, the selected device's Simulation settings. */
  private buildActions(box: HTMLElement): void {
    const doc = this.host.doc;
    while (box.firstChild) box.removeChild(box.firstChild);
    // Network events: four actions, each with its own form (its device and interface chosen in it), then the events
    const fh = {
      sim: () => this.sim,
      join: (d: string, i: string, g: string, src: string[]) => this.joinGroup(d, i, g, src),
      stream: (d: string, i: string, g: string, port: number, iv: number, size: number) => this.startStream(d, i, g, port, iv, size),
      shut: (d: string, i: string) => (this.shut(d, i) ? `${d}:${i} shut at t = ${fmtSec(this.t)}; see Active events.` : `${d}:${i} could not be shut.`),
      flap: (d: string, i: string) => (this.startFlap(`iface:${d}:${i}`) ? `${d}:${i} flapping from t = ${fmtSec(this.t)}; see Active events.` : `${d}:${i} could not start flapping.`),
      noShut: (d: string, i: string) => (this.noShut(d, i) ? `${d}:${i} brought up at t = ${fmtSec(this.t)} (no shut).` : `${d}:${i} is not shut.`),
      stopFlap: (d: string, i: string) => (this.stopFlap(`iface:${d}:${i}`) ? `${d}:${i} stops flapping at t = ${fmtSec(this.t)}.` : `${d}:${i} is not flapping.`),
      interfacesOf: (d: string) => this.interfaceChoices(d),
      flapTimes: () => this.flapTimes(),
    };
    this.testForm = new TestForm(doc, { sim: () => this.sim, send: (p, play) => this.sendPlan(p, play), playing: () => this.playing }, (d, id, title, body) => this.disclosure(d, id, title, body));
    this.joinForm = new JoinForm(doc, fh);
    this.streamForm = new StreamForm(doc, fh);
    this.ifaceForm = new IfaceForm(doc, fh);
    const net = this.sec(doc, 'sim-act-net', 'Network events', [
      this.action(doc, 'sim-ne-send', 'Send network packets', this.testForm.el, true),
      this.action(doc, 'sim-ne-join', 'Join multicast group', this.joinForm.el),
      this.action(doc, 'sim-ne-stream', 'Start multicast stream', this.streamForm.el),
      this.action(doc, 'sim-ne-iface', 'Interface actions', this.ifaceForm.el),
    ]);
    this.bulkControls(doc, net);
    box.appendChild(net);
    this.syncBulk();
    // Active events: everything the actions started (kept when done, up to a limit), and the other state changes in effect
    const clear = el(doc, 'button', { type: 'button', id: 'sim-ev-clear', class: 'mini' }, ['Clear finished']) as HTMLButtonElement;
    clear.addEventListener('click', () => {
      const n = this.sim.clearFinished();
      this.eventsKey = '';
      this.updatePanels();
      (doc.getElementById('sim-act-events-h') as HTMLElement).focus();
      this.host.toast(`${n} finished event${n === 1 ? '' : 's'} cleared.`);
    });
    const evSec = this.sec(doc, 'sim-act-events', 'Active events', [el(doc, 'div', { class: 'sim-ev-bar-top' }, [el(doc, 'p', { id: 'sim-failed', class: 'small muted' }, ['None.']), clear]), el(doc, 'ul', { id: 'sim-events', class: 'sim-events' })]);
    (evSec.querySelector('#sim-act-events-h') as HTMLElement).setAttribute('tabindex', '-1');
    box.appendChild(evSec);
    // the selected device's Simulation settings (collapsed until opened)
    box.appendChild(el(doc, 'div', { id: 'sim-act-attrs', class: 'inspector sim-live' }));
    this.eventsKey = '';
  }

  /**
   * Expand all and Collapse all beside the Network events heading: they open
   * or close the four actions' forms (their headings' buttons) — not the
   * panel, not Active events (its own section, with its own Details), not a
   * form's own More options. Only hidden: the forms keep their values, what
   * runs keeps running. Each is disabled (in its place: the heading never
   * moves) when it would change nothing.
   */
  private bulkControls(doc: Document, sec: HTMLElement): void {
    const h = sec.querySelector('#sim-act-net-h') as HTMLElement;
    const icon = (up: boolean): SVGSVGElement => {
      const NS = 'http://www.w3.org/2000/svg';
      const s = doc.createElementNS(NS, 'svg') as SVGSVGElement;
      s.setAttribute('width', '14');
      s.setAttribute('height', '14');
      s.setAttribute('viewBox', '0 0 14 14');
      s.setAttribute('aria-hidden', 'true');
      s.setAttribute('focusable', 'false');
      const p = doc.createElementNS(NS, 'path');
      // two chevrons: down (expand) or up (collapse)
      p.setAttribute('d', up ? 'M3 7.5 7 3.5l4 4M3 11.5l4-4 4 4' : 'M3 2.5l4 4 4-4M3 6.5l4 4 4-4');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
      return s;
    };
    const btn = (id: string, label: string, up: boolean): HTMLButtonElement => {
      const b = el(doc, 'button', { type: 'button', id, class: 'icon-btn sp-bulk', 'aria-label': label, title: label, 'aria-controls': 'sim-ne-send sim-ne-join sim-ne-stream sim-ne-iface' }) as HTMLButtonElement;
      b.appendChild(icon(up));
      b.addEventListener('click', () => this.setAllActions(!up));
      return b;
    };
    const row = el(doc, 'div', { class: 'sp-h-row' });
    h.parentNode!.insertBefore(row, h);
    row.appendChild(h);
    row.appendChild(el(doc, 'span', { class: 'sp-bulk-group', role: 'group', 'aria-label': 'Network events sections' }, [btn('sim-ne-expand', 'Expand all Network events sections', false), btn('sim-ne-collapse', 'Collapse all Network events sections', true)]));
  }

  /** The actions' heading buttons of Network events (the scope of Expand all and Collapse all). */
  private actionToggles(): HTMLButtonElement[] {
    const box = this.host.actionsBox ? this.host.actionsBox() : null;
    return box ? (Array.from(box.querySelectorAll('#sim-act-net .sim-ne > .sim-ne-h > .sp-toggle')) as HTMLButtonElement[]) : [];
  }

  /** Open (or close) every action of Network events; nothing else changes (their forms keep their values, nothing starts or stops). */
  setAllActions(open: boolean): void {
    const all = this.actionToggles();
    for (const t of all) {
      const body = this.host.doc.getElementById(t.getAttribute('aria-controls') as string);
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (body) body.hidden = !open;
    }
    this.syncBulk(open ? 'sim-ne-collapse' : 'sim-ne-expand');
    if (this.host.panelChanged) this.host.panelChanged();
  }

  /**
   * Expand all only while one is closed, Collapse all only while one is open
   * (disabled otherwise; none at all: both). A button that just disabled
   * itself hands the focus to the other one.
   */
  private syncBulk(focusTo?: string): void {
    const box = this.host.actionsBox ? this.host.actionsBox() : null;
    if (!box) return;
    const all = this.actionToggles();
    const open = all.filter((t) => t.getAttribute('aria-expanded') === 'true').length;
    const ex = box.querySelector('#sim-ne-expand') as HTMLButtonElement | null;
    const co = box.querySelector('#sim-ne-collapse') as HTMLButtonElement | null;
    if (!ex || !co) return;
    const had = this.host.doc.activeElement;
    ex.disabled = !all.length || open === all.length;
    co.disabled = !all.length || open === 0;
    if (focusTo && (had === ex || had === co) && (had as HTMLButtonElement).disabled) {
      const to = box.querySelector('#' + focusTo) as HTMLButtonElement | null;
      if (to && !to.disabled) to.focus();
    }
  }

  /** An action of Network events: a heading whose button opens its form (all four always listed). */
  private action(doc: Document, id: string, title: string, body: HTMLElement, open = false): HTMLElement {
    const btn = el(doc, 'button', { type: 'button', class: 'sp-toggle', id: id + '-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': id }, [el(doc, 'span', { class: 'psec-caret', 'aria-hidden': 'true' }, ['▸']), el(doc, 'span', {}, [title])]);
    body.id = id;
    body.hidden = !open;
    btn.addEventListener('click', () => {
      const o = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', o ? 'true' : 'false');
      body.hidden = !o;
      this.syncBulk();
      if (this.host.panelChanged) this.host.panelChanged();
    });
    return el(doc, 'div', { class: 'sp-disc sim-ne', 'data-action': id.slice(7) }, [el(doc, 'h4', { class: 'sim-ne-h' }, [btn]), body]);
  }

  /** A device's interfaces for Interface actions: "eth0 - 10.0.0.1" (one with an address), "p1" (a port), cabled or not. */
  private interfaceChoices(dev: string): Array<{ id: string; label: string; cabled: boolean }> {
    const sd = this.sim.engine.net.devices.get(dev);
    return this.interfaces()
      .filter((k) => k.indexOf(dev + ':') === 0)
      .map((k) => {
        const id = k.slice(dev.length + 1);
        const l3 = sd ? sd.l3.get(id) : undefined;
        const addrs = l3 ? l3.addrs.map((a) => a.text.replace(/\/\d+$/, '')) : [];
        return { id, label: addrs.length ? `${id} - ${addrs.join(', ')}` : id, cabled: this.cabled(dev, id) };
      });
  }

  /** The flapping cycle in effect: "down 5 s, up 10 s, 3 cycles" (Layer 1 parameters). */
  private flapTimes(): string {
    const p = (k: string): string => {
      const r = this.sim.engine.params.get(k);
      return formatValue(r.def, r.value);
    };
    const n = this.sim.engine.params.num('flap-cycles');
    return `down ${p('flap-down')}, up ${p('flap-up')}, ${n ? n + ' cycle' + (n === 1 ? '' : 's') : 'until stopped'}`;
  }


  /** The simulation panel: the clock and the pacing on top; the status and the event log side by side. */
  private buildDock(box: HTMLElement): void {
    const doc = this.host.doc;
    while (box.firstChild) box.removeChild(box.firstChild);
    const play = el(doc, 'button', { type: 'button', id: 'sim-play', class: 'primary sd-play', 'aria-pressed': 'true' }, ['Pause']);
    const step = el(doc, 'button', { type: 'button', id: 'sim-step', class: 'sd-btn', title: 'To the next message event: a message arrives, or the next one starts' }, ['Step']);
    const stepX = el(doc, 'button', { type: 'button', id: 'sim-step-x', class: 'sd-btn', title: 'On to the end of the exchange on screen (a request and its reply, a hello …), or of the next one', 'aria-label': 'Next exchange' }, ['Next', el(doc, 'span', { class: 'sd-long' }, [' exchange'])]);
    const speed = el(doc, 'select', { id: 'sim-speed' }) as HTMLSelectElement;
    for (const s of SPEEDS) speed.appendChild(el(doc, 'option', { value: String(s) }, [`${s}×`]));
    speed.value = String(this.pacer.speed);
    const mode = el(doc, 'select', { id: 'sim-pace' }) as HTMLSelectElement;
    for (const [v, l] of [['readable', 'Readable'], ['proportional', 'Proportional to latency'], ['realtime', 'Real time (1 s = 1 s)']]) mode.appendChild(el(doc, 'option', { value: v }, [l]));
    mode.value = this.pacer.mode;
    const scale = el(doc, 'select', { id: 'sim-pace-scale' }) as HTMLSelectElement;
    for (const n of PACE_SCALES) scale.appendChild(el(doc, 'option', { value: String(n) }, [scaleText(n)]));
    scale.value = String(this.pacer.scale);
    const skip = el(doc, 'input', { type: 'checkbox', id: 'sim-skip' }) as HTMLInputElement;
    skip.checked = this.pacer.skipIdle;
    const exit = el(doc, 'button', { type: 'button', id: 'sim-exit', class: 'sd-exit', 'data-command': 'sim.exit', 'aria-label': 'Exit simulation' }, ['Exit', el(doc, 'span', { class: 'sd-long' }, [' simulation'])]);
    const head = el(doc, 'div', { class: 'sd-head', role: 'toolbar', 'aria-label': 'Simulation clock' }, [
      el(doc, 'span', { class: 'sd-group' }, [play, step, stepX, el(doc, 'span', { id: 'sim-state', class: 'sd-state small' }, [this.playState()]), el(doc, 'span', { id: 'sim-state-live', class: 'sr-only', role: 'status', 'aria-live': 'polite' }, [''])]),
      el(doc, 'span', { class: 'sd-group' }, [el(doc, 'label', { for: 'sim-speed' }, ['Speed']), speed]),
      el(doc, 'span', { class: 'sd-group' }, [el(doc, 'label', { for: 'sim-pace' }, ['Pacing']), mode, el(doc, 'span', { id: 'sim-pace-scale-wrap', class: 'sd-scale' }, [el(doc, 'label', { for: 'sim-pace-scale', class: 'sr-only' }, ['Scale']), scale])]),
      el(doc, 'label', { class: 'check sd-group', for: 'sim-skip' }, [skip, ' Skip idle', el(doc, 'span', { class: 'sd-long' }, [' time'])]),
      el(doc, 'span', { id: 'sim-pace-text', class: 'sd-pace muted small', 'aria-live': 'off' }, ['']),
      el(doc, 'span', { id: 'sim-skipped', class: 'sd-skipped small', role: 'status' }, ['']),
      el(doc, 'span', { class: 'sd-spacer' }),
      el(doc, 'span', { id: 'sim-time', class: 'sim-time sd-time' }, ['t = 0 s']),
      exit,
    ]);
    play.addEventListener('click', () => this.setPlaying(!this.playing));
    step.addEventListener('click', () => this.step());
    stepX.addEventListener('click', () => this.stepExchange());
    speed.addEventListener('change', () => this.setSpeed(Number(speed.value)));
    mode.addEventListener('change', () => this.setPacing(mode.value as PaceMode));
    scale.addEventListener('change', () => this.setPacing(this.pacer.mode, Number(scale.value)));
    skip.addEventListener('change', () => this.setSkipIdle(skip.checked));
    exit.addEventListener('click', () => {
      if (this.host.exit) this.host.exit();
    });
    box.appendChild(head);
    // the dots' shapes, the follow note, a storm's warning, what is not drawn
    const shape = (cast: string): SVGSVGElement => {
      const s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
      s.setAttribute('width', '12');
      s.setAttribute('height', '12');
      s.setAttribute('viewBox', '0 0 14 14');
      s.setAttribute('aria-hidden', 'true');
      s.appendChild(dot(doc, 7, 7, 'currentColor', cast));
      return s;
    };
    const stopFollow = el(doc, 'button', { type: 'button', class: 'mini', id: 'sim-follow-stop' }, ['Stop following']);
    stopFollow.addEventListener('click', () => this.follow(null));
    box.appendChild(
      el(doc, 'div', { class: 'sd-notes' }, [
        el(doc, 'span', { id: 'sim-follow', class: 'sd-follow small', hidden: '' }, [el(doc, 'span', { id: 'sim-follow-text' }, ['']), ' ', stopFollow]),
      ]),
    );
    // the dots' shapes: explained in the setup, beside the protocols' colours
    const setup = this.host.setupBox ? this.host.setupBox() : null;
    const note = setup ? setup.querySelector('.sp-note') : null;
    if (note && note.parentNode && !setup!.querySelector('#sim-shapes'))
      note.parentNode.insertBefore(el(doc, 'p', { class: 'sim-shapes small', id: 'sim-shapes' }, [el(doc, 'span', {}, [shape('unicast'), ' unicast']), el(doc, 'span', {}, [shape('broadcast'), ' broadcast']), el(doc, 'span', {}, [shape('multicast'), ' multicast']), el(doc, 'span', { class: 'muted' }, ['A dot opens the packet inspector.'])]), note.nextSibling);
    box.appendChild(el(doc, 'p', { id: 'sim-storm', class: 'sim-storm', role: 'alert', hidden: '' }, ['']));
    // the narrow layout shows one side at a time: tabs
    const tabS = el(doc, 'button', { type: 'button', role: 'tab', id: 'sd-tab-status', 'aria-controls': 'sd-status', 'aria-selected': 'true' }, ['Status']);
    const tabL = el(doc, 'button', { type: 'button', role: 'tab', id: 'sd-tab-log', 'aria-controls': 'sd-log', 'aria-selected': 'false', tabindex: '-1' }, ['Event log']);
    const tabs = el(doc, 'div', { class: 'sd-tabs', role: 'tablist', 'aria-label': 'Simulation panel' }, [tabS, tabL]);
    const pick = (which: 'status' | 'log'): void => {
      box.setAttribute('data-pane', which);
      tabS.setAttribute('aria-selected', which === 'status' ? 'true' : 'false');
      tabL.setAttribute('aria-selected', which === 'log' ? 'true' : 'false');
      tabS.tabIndex = which === 'status' ? 0 : -1;
      tabL.tabIndex = which === 'log' ? 0 : -1;
    };
    tabS.addEventListener('click', () => pick('status'));
    tabL.addEventListener('click', () => pick('log'));
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const to = box.getAttribute('data-pane') === 'log' ? 'status' : 'log';
      pick(to);
      (to === 'log' ? tabL : tabS).focus();
    });
    pick('status');
    box.appendChild(tabs);
    // status: the protocols, or a table of the selected device
    const stTabs = el(doc, 'div', { class: 'sd-sttabs', id: 'sd-sttabs', role: 'group', 'aria-label': 'Show' });
    const status = el(doc, 'section', { class: 'sd-pane sd-status', id: 'sd-status', role: 'tabpanel', 'aria-labelledby': 'sd-status-h' }, [
      el(doc, 'div', { class: 'sd-panehead' }, [el(doc, 'h3', { id: 'sd-status-h', class: 'sd-h' }, ['Status']), stTabs]),
      // (one line, as the log's: both tables start at the same height and show as many rows)
      el(doc, 'p', { class: 'muted small sd-lognote', id: 'sim-status-note' }, ['']),
      el(doc, 'div', { id: 'sim-status-table', class: 'sim-scroll' }),
    ]);
    stTabs.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('[data-st]') as HTMLElement | null;
      if (!b) return;
      const k = b.getAttribute('data-st') as string;
      if (k === 'status') this.showStatus();
      else this.showTable(k as DevTable, b.getAttribute('data-dev') as string);
      const again = box.querySelector(`#sd-sttabs [data-st="${k}"]`) as HTMLElement | null;
      if (again) again.focus();
    });
    // the event log
    const filter = el(doc, 'input', { type: 'search', id: 'sim-log-filter', placeholder: 'Filter: device, message, address', 'aria-label': 'Filter the event log', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    filter.value = this.logFilter;
    filter.addEventListener('input', () => {
      this.logFilter = filter.value;
      this.logKey = '';
      this.updatePanels();
    });
    const layer = el(doc, 'select', { id: 'sim-log-layer', 'aria-label': 'Layer' }) as HTMLSelectElement;
    for (const [v, l] of [['0', 'All layers'], ['1', 'Layer 1'], ['2', 'Layer 2'], ['3', 'Layer 3'], ['4', 'Layer 4 and up']]) layer.appendChild(el(doc, 'option', { value: v }, [l]));
    layer.value = String(this.logLayer);
    const cast = el(doc, 'select', { id: 'sim-log-cast', 'aria-label': 'Cast' }) as HTMLSelectElement;
    for (const [v, l] of [['', 'Any cast'], ['unicast', 'Unicast'], ['broadcast', 'Broadcast'], ['multicast', 'Multicast']]) cast.appendChild(el(doc, 'option', { value: v }, [l]));
    cast.value = this.logCast;
    const proto = el(doc, 'select', { id: 'sim-log-proto', 'aria-label': 'Protocol' }) as HTMLSelectElement;
    proto.appendChild(el(doc, 'option', { value: '' }, ['Any protocol']));
    proto.appendChild(el(doc, 'option', { value: 'link' }, ['Link']));
    for (const e of this.entries) proto.appendChild(el(doc, 'option', { value: e.id }, [e.label]));
    proto.value = this.logProto;
    const onSel = (s: HTMLSelectElement, set: (v: string) => void): void => {
      s.addEventListener('change', () => {
        set(s.value);
        this.logKey = '';
        this.updatePanels();
      });
    };
    onSel(layer, (v) => (this.logLayer = Number(v)));
    onSel(cast, (v) => (this.logCast = v));
    onSel(proto, (v) => (this.logProto = v));
    const allSnd = el(doc, 'input', { type: 'checkbox', id: 'sim-log-allsenders' }) as HTMLInputElement;
    allSnd.checked = this.showAllSenders;
    allSnd.addEventListener('change', () => {
      this.showAllSenders = allSnd.checked;
      this.logKey = '';
      this.updatePanels();
    });
    const table = el(doc, 'div', { id: 'sim-log-table', class: 'sim-scroll sim-log' });
    // at its end it stays there when the panel's height changes (the newest rows whole, not cut)
    table.addEventListener('scroll', () => {
      if (!this.logResizing) this.logAtEnd = table.scrollHeight - table.scrollTop - table.clientHeight < 24;
    });
    const RO = (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
    if (RO)
      new RO(() => {
        if (!this.logAtEnd) return;
        this.logResizing = true;
        table.scrollTop = table.scrollHeight;
        this.logResizing = false;
      }).observe(table);
    table.addEventListener('click', (ev) => {
      const b = (ev.target as Element).closest('[data-seq]');
      if (b) this.inspectEvent(Number(b.getAttribute('data-seq')));
    });
    const log = el(doc, 'section', { class: 'sd-pane sd-log', id: 'sd-log', role: 'tabpanel', 'aria-labelledby': 'sd-log-h' }, [
      el(doc, 'div', { class: 'sd-panehead' }, [el(doc, 'h3', { id: 'sd-log-h', class: 'sd-h' }, ['Event log']), el(doc, 'span', { class: 'sim-log-filters' }, [filter, layer, cast, proto, el(doc, 'label', { class: 'check sd-allsnd', for: 'sim-log-allsenders' }, [allSnd, ' Show all senders'])])]),
      el(doc, 'p', { class: 'muted small sd-lognote' }, [el(doc, 'span', { id: 'sim-log-note' }, ['']), ' ', el(doc, 'span', { id: 'sim-drawn', 'aria-live': 'off' }, ['']), ' ', el(doc, 'span', { id: 'sim-log-held' }, [''])]),
      table,
    ]);
    box.appendChild(el(doc, 'div', { class: 'sd-body' }, [status, log]));
  }

  /** The clock's part of the simulation panel: the time, Play or Pause, the pacing, a skip, the follow note. */
  private updateClock(): void {
    const d = this.host.doc;
    const time = d.getElementById('sim-time');
    if (!time) return;
    const tt = `t = ${timeText(this.t)}`;
    if (time.textContent !== tt) time.textContent = tt;
    const play = d.getElementById('sim-play') as HTMLElement;
    this.sayState();
    const pt = this.playing ? 'Pause' : 'Play';
    if (play.textContent !== pt) {
      play.textContent = pt;
      play.setAttribute('aria-pressed', this.playing ? 'true' : 'false');
    }
    const pace = d.getElementById('sim-pace-text') as HTMLElement;
    const desc = this.pacingText() + (this.host.reduce() ? ' · arrows (reduced motion)' : '');
    if (pace.textContent !== desc) pace.textContent = desc;
    (d.getElementById('sim-pace-scale-wrap') as HTMLElement).hidden = this.pacer.mode !== 'proportional';
    const sk = d.getElementById('sim-skipped') as HTMLElement;
    const s = this.pacer.skipped;
    const st = s && this.pacer.clock - s.at < 1500 * this.pacer.speed ? `⏩ ${fmtSec(s.ms)} skipped` : '';
    if (sk.textContent !== st) sk.textContent = st;
    const fw = d.getElementById('sim-follow') as HTMLElement;
    const f = this.pacer.follow;
    if (fw.hidden !== !f) fw.hidden = !f;
    const ft = f ? `Following ${f.label} and its replies` : '';
    const ftx = d.getElementById('sim-follow-text') as HTMLElement;
    if (ftx.textContent !== ft) ftx.textContent = ft;
  }

  /** The panels' live parts: the events, the object's actions, the status, the tests and the log. */
  updatePanels(): void {
    const d = this.host.doc;
    const q = (id: string): HTMLElement | null => d.getElementById(id);
    this.updateClock();
    const drawn = q('sim-drawn');
    if (drawn) drawn.textContent = this.notDrawn ? `${this.notDrawn} more on their way as cable activity (${this.pacer.fgNow ? 'the scenario, behind your Network events' : `at most ${CONV_LIMIT} exchanges as dots at once`}).` : '';
    // a broadcast storm: a warning
    const storm = q('sim-storm');
    if (storm) {
      const storms = this.sim.storms();
      const stormText = storms.length ? `⚠ Broadcast storm in ${storms.map((s) => `${s.vlan ? 'VLAN ' + s.vlan : 'the untagged frames'} (loop over ${s.links.join(', ')}, since t = ${fmtSec(s.since)})`).join('; ')}: a Layer 2 loop that no spanning tree blocks. Break it: fail one of its cables, or set the spanning tree back on.` : '';
      if (storm.textContent !== stormText) {
        storm.textContent = stormText;
        storm.title = stormText;
      }
      if (storm.hidden !== !stormText) {
        storm.hidden = !stormText;
        if (this.host.panelChanged) this.host.panelChanged();
      }
    }
    if (this.editor) this.editor.set(this.sim.params.simValues());
    // the Actions panel: the selected device's Simulation settings (rebuilt when the selection changed)
    const act = this.host.actionsBox ? this.host.actionsBox() : null;
    const sel = this.host.selected ? this.host.selected() : null;
    const ak = `${sel}`;
    if (act && act.querySelector('#sim-act-attrs') && ak !== this.actionsKey) {
      this.actionsKey = ak;
      const attrs = act.querySelector('#sim-act-attrs') as HTMLElement;
      if (!attrs.contains(d.activeElement)) {
        while (attrs.firstChild) attrs.removeChild(attrs.firstChild);
        if (this.host.simSection) this.host.simSection(attrs);
      }
    }
    // the forms of Network events (a lease bound or lost, a device powered off, an interface shut …)
    for (const f of [this.testForm, this.joinForm, this.streamForm, this.ifaceForm]) if (f && f.el.isConnected) f.sync();
    // Active events: the events of Network events (newest first) and the other state changes in effect
    const views = this.sim.actions();
    const others = this.sim.otherEvents();
    const ek = listKey(views, others);
    const ul = q('sim-events');
    if (ul && ek !== this.eventsKey) {
      this.eventsKey = ek;
      const going = views.filter((v) => v.status === 'queued' || v.status === 'running' || v.status === 'paused').length + others.length;
      const done = views.length - views.filter((v) => v.status === 'queued' || v.status === 'running' || v.status === 'paused').length;
      const sum = views.length + others.length ? `${going} in effect or in progress · ${done} finished` : 'None yet: start one above, or from the diagram’s menus.';
      const fe = q('sim-failed') as HTMLElement;
      if (fe.textContent !== sum) fe.textContent = sum;
      const clear = q('sim-ev-clear');
      if (clear) clear.hidden = done === 0;
      const h = q('sim-act-events-h');
      const ht = `Active events${views.length + others.length ? ` (${views.length + others.length})` : ''}`;
      if (h && h.textContent !== ht) h.textContent = ht;
      renderEvents(d, ul, { control: (id, op) => void this.actionControl(id, op), end: (e) => void this.endEvent(e), endLabel: (e) => this.endLabel(e), label: (r) => this.label(r), inspect: (id) => this.inspectTest(id) }, views, others);
    }
    // the status side: the protocols' status, or a device's table
    const box = q('sim-status-table');
    const stTabs = q('sd-sttabs');
    if (box && stTabs) {
      const dev = sel && sel.indexOf('device:') === 0 ? sel.slice(7) : null;
      const kinds = dev ? this.deviceTables(dev) : [];
      const tabKey = `${dev}|${kinds.join(',')}|${this.statusView ? this.statusView.kind : ''}`;
      if (stTabs.getAttribute('data-key') !== tabKey) {
        stTabs.setAttribute('data-key', tabKey);
        if (this.host.panelChanged) this.host.panelChanged();
        const keep = stTabs.contains(d.activeElement) ? (d.activeElement as HTMLElement).getAttribute('data-st') : null;
        while (stTabs.firstChild) stTabs.removeChild(stTabs.firstChild);
        const tab = (k: string, label: string): void => {
          const on = k === 'status' ? !this.statusView : !!this.statusView && this.statusView.kind === k;
          const b = el(d, 'button', { type: 'button', class: 'mini sd-st', 'data-st': k, 'aria-pressed': on ? 'true' : 'false' }, [label]);
          if (dev && k !== 'status') b.setAttribute('data-dev', dev);
          stTabs.appendChild(b);
        };
        tab('status', 'Protocols');
        for (const k of kinds) tab(k, DEV_TABLE_LABEL[k]);
        if (dev && kinds.length) stTabs.insertBefore(el(d, 'span', { class: 'muted small sd-dev' }, [`${dev}:`]), stTabs.children[1] || null);
        if (keep) {
          const again = stTabs.querySelector(`[data-st="${keep}"]`) as HTMLElement | null;
          if (again) again.focus();
        }
      }
      if (this.statusView) {
        const v = this.statusView;
        const sn = q('sim-status-note');
        const snText = `${DEV_TABLE_LABEL[v.kind]} of ${v.dev}.`;
        if (sn && sn.textContent !== snText) sn.textContent = snText;
        const sk = `table|${v.kind}|${v.dev}`;
        if (sk !== this.statusKey) {
          this.statusKey = sk;
          this.tables.inline(box, v.kind, v.dev, this.tableData(v.kind, v.dev));
        }
      } else {
        const st = this.sim.status().filter((s) => this.visible(s.protocol));
        const sn = q('sim-status-note');
        const snText = `${st.length} session${st.length === 1 ? '' : 's'} of the protocols shown, ${st.filter((x) => x.up).length} up.`;
        if (sn && sn.textContent !== snText) sn.textContent = snText;
        const sk = st.map((s) => s.name + s.state + s.detail.length).join('|') + '|' + Math.floor(this.t / 1000);
        if (sk !== this.statusKey) {
          this.statusKey = sk;
          this.tables.dropInline();
          while (box.firstChild) box.removeChild(box.firstChild);
          box.appendChild(this.statusTable(st));
        }
      }
    }
    // the log: rebuilt when it grew or a filter changed; while the pointer is on it or the keyboard in it, it waits for
    // new events (a row must not move away under a click), but not for a filter
    const lt = q('sim-log-table');
    const events = this.sim.events();
    const fk = `${Array.from(this.shown).join(',')}|${this.logFilter}|${this.logLayer}|${this.logCast}|${this.logProto}|${this.showAllSenders}|${Array.from(this.senders).length}`;
    const lk = `${events.length}|${this.sim.engine.logDropped}|${fk}`;
    const held = !!lt && (lt.matches(':hover') || lt.contains(d.activeElement));
    const waiting = q('sim-log-held');
    if (lt && lk !== this.logKey && (!held || fk !== this.logFilterKey || !this.logKey)) {
      this.logKey = lk;
      this.logFilterKey = fk;
      this.renderLog(lt, q('sim-log-note') as HTMLElement, events);
    }
    // the panel's three-row height follows what it is measured from: its toolbar, notes, tabs, the panes' headings and the
    // rows (the first rows, a wrap, a font or zoom change)
    const hOf = (sel: string): number => Array.from(d.querySelectorAll(sel)).reduce((n, e) => n * 31 + Math.round((e as HTMLElement).getBoundingClientRect().height * 10), 7);
    const rowH = hOf('#sim-dock .sd-head, #sim-dock .sd-notes, #sim-storm, #sim-dock .sd-tabs, #sim-dock .sd-panehead, #sim-dock .sd-lognote, #sim-dock thead tr, #sim-status-table tbody tr:first-child, #sim-log-table tbody tr:first-child');
    if (rowH !== this.rowH) {
      this.rowH = rowH;
      if (this.host.panelChanged) this.host.panelChanged();
    }
    const wt = held && lk !== this.logKey ? 'New events wait while you point at the log or use it.' : '';
    if (waiting && waiting.textContent !== wt) waiting.textContent = wt;
  }

  private statusTable(rows: SessionStatus[]): HTMLElement {
    const doc = this.host.doc;
    const head = ['Protocol', 'Session', 'State', 'Details'];
    const t = el(doc, 'table', { class: 'sim-table' });
    t.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Status of the protocols’ sessions']));
    t.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, head.map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
    const tb = el(doc, 'tbody');
    for (const s of rows) {
      tb.appendChild(el(doc, 'tr', { 'data-up': s.up ? 'true' : 'false', 'data-protocol': s.protocol }, [el(doc, 'td', {}, [this.protoLabel(s.protocol)]), el(doc, 'td', { title: s.name }, [s.name]), el(doc, 'td', { class: s.up ? 'st-up' : 'st-down' }, [(s.up ? '● ' : '○ ') + s.state]), el(doc, 'td', { class: 'small', title: s.detail }, [s.detail])]));
    }
    if (!rows.length) tb.appendChild(el(doc, 'tr', {}, [el(doc, 'td', { colspan: '4', class: 'muted' }, ['No session of the protocols shown.'])]));
    t.appendChild(tb);
    return t;
  }

  protoLabel(protocol: string): string {
    const e = this.entries.find((x) => x.id === protocol);
    return e ? e.label : protocol === 'link' ? 'Link' : protocol === 'stp' ? 'STP / MAC' : protocol;
  }

  /** The events the log lists: of shown protocols (and the links), matching the filters, up to now. */
  logEvents(events: SimEvent[] = this.sim.events()): { list: SimEvent[]; hidden: number; bySender: number } {
    const words = this.logFilter.toLowerCase().split(/\s+/).filter((w) => w);
    let hidden = 0;
    let bySender = 0;
    const list: SimEvent[] = [];
    for (const e of events) {
      if (e.t > this.t) break;
      // a Send test's events are always listed (the log's own filters below still apply)
      const test = e.test !== undefined;
      if (!test && !this.visible(e.protocol)) {
        hidden++;
        continue;
      }
      // messages of non-senders (a sender's exchanges stay): counted, listed only with Show all senders
      if (!test && e.kind === 'message' && !this.senderOk(e)) {
        bySender++;
        if (!this.showAllSenders) continue;
      }
      if (this.logProto && e.protocol !== this.logProto) continue;
      if (this.logLayer) {
        const ent = this.entries.find((x) => x.id === e.protocol);
        if (eventLayer(e, ent ? ent.group : undefined) !== this.logLayer) continue;
      }
      if (this.logCast && (!e.hdr || e.hdr.cast !== this.logCast)) continue;
      if (words.length) {
        const hay = `${e.device} ${e.peer} ${this.protoLabel(e.protocol)} ${e.what} ${e.state} ${e.detail}`.toLowerCase();
        if (!words.every((w) => hay.indexOf(w) >= 0)) continue;
      }
      list.push(e);
    }
    return { list, hidden, bySender };
  }

  /** the log is scrolled to its end (it follows the newest events) */
  private logAtEnd = true;
  private logResizing = false;

  /** what the panel's height is measured from (a key of heights), to measure it again when it changes */
  private rowH = -1;

  private renderLog(box: HTMLElement, note: HTMLElement, events: SimEvent[]): void {
    const doc = this.host.doc;
    const { list, hidden, bySender } = this.logEvents(events);
    const shown = list.slice(-LOG_SHOWN);
    note.textContent = `${list.length} event${list.length === 1 ? '' : 's'}${list.length > shown.length ? `, the newest ${shown.length} listed` : ''}${bySender ? (this.showAllSenders ? `; ${bySender} message${bySender === 1 ? '' : 's'} from non-senders included` : `; ${bySender} message${bySender === 1 ? '' : 's'} from non-senders hidden`) : ''}${hidden ? `; ${hidden} of hidden protocols not listed (they still run)` : ''}${this.sim.engine.logDropped ? `; the ${this.sim.engine.logDropped} oldest were dropped from the log` : ''}.`;
    // keep the reader's place unless they are at the end
    const atEnd = this.logAtEnd;
    const top = box.scrollTop;
    while (box.firstChild) box.removeChild(box.firstChild);
    const head = ['Time (s)', 'From', 'To', 'Protocol', 'Message', 'State', 'Details'];
    const t = el(doc, 'table', { class: 'sim-table' });
    t.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Event log']));
    t.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, head.map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
    const tb = el(doc, 'tbody');
    // what happens at the same moment is one group: its time on the first row, a ditto mark (and the time for a screen reader) on the others
    let prev = '';
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const tt = logTime(e.t);
      const same = tt === prev;
      const more = i + 1 < shown.length && logTime(shown[i + 1].t) === tt;
      const grouped = same || more;
      prev = tt;
      const time = same ? [el(doc, 'span', { 'aria-hidden': 'true', class: 'sim-ditto', title: `${tt} s (the same moment)` }, ['〃']), el(doc, 'span', { class: 'sr-only' }, [`${tt} (the same moment)`])] : [tt];
      tb.appendChild(
        el(doc, 'tr', { 'data-kind': e.kind, 'data-protocol': e.protocol, class: grouped ? (same ? 'sim-t-same' : 'sim-t-first') + (more ? '' : ' sim-t-end') : '' }, [
          el(doc, 'td', { class: 'mono' }, time),
          el(doc, 'td', {}, [e.device]),
          el(doc, 'td', {}, [e.peer]),
          el(doc, 'td', {}, [this.protoLabel(e.protocol)]),
          el(doc, 'td', {}, [
            e.test !== undefined ? el(doc, 'span', { class: 'sim-test-tag', title: 'Part of a Send test' }, ['Test']) : null,
            e.test !== undefined ? ' ' : null,
            e.hdr ? el(doc, 'button', { type: 'button', class: 'sim-msg-btn', 'data-seq': String(e.seq), 'aria-label': `${e.test !== undefined ? 'Test: ' : ''}${e.what}: open in the packet inspector` }, [e.what]) : e.what,
          ]),
          el(doc, 'td', {}, [e.state]),
          el(doc, 'td', { class: 'small', title: e.detail }, [e.detail]),
        ]),
      );
    }
    t.appendChild(tb);
    box.appendChild(t);
    box.scrollTop = atEnd ? box.scrollHeight : top;
  }
}

/** A parameter in effect as a table's timer row. */
function timerOf(r: Resolved): TableTimer {
  return { label: r.def.label, value: formatValue(r.def, r.value), source: r.source, origin: sourceText(r, true) };
}

/** The clock's time: to the millisecond ("12.345 s"). */
export function timeText(ms: number): string {
  return `${(Math.floor(ms) / 1000).toFixed(3)} s`;
}

/** An event's time in the log, in seconds to the microsecond ("12.000134"). */
export function logTime(ms: number): string {
  return (ms / 1000).toFixed(6);
}

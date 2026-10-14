/**
 * Simulate → Start simulation: the protocol simulation on screen. It owns
 * the simulation (analysis/sim), runs its clock (Play, Pause, Step, a speed
 * from 0.25× to 10×; requestAnimationFrame, paused while the page is
 * hidden; in slow motion while a message is on its way, so that a frame
 * that is on a cable for microseconds can still be followed; under reduced
 * motion it advances in steps), draws it in the diagram (sim-anim.ts),
 * fills the Simulation window (controls, the Layer 1–4 parameters, network
 * events, the protocols shown, the ARP and MAC tables, the status table,
 * the event log) and opens the in-diagram menus (on a cable: Fail link,
 * Start flapping; on a relation: Fail link; on a device: Power off, Shut an
 * interface…, its tables; on an interface: Shut interface, Start flapping;
 * each with its way back). It is the app's simulation mode
 * (simulation-mode.ts): the banner's text, what is down, and Exit.
 *
 * The checkboxes only choose what is shown (dots and event log): the
 * simulation always computes every protocol, so changing them never
 * restarts it or changes its time, and the tables keep filling. Parameters
 * changed in the window apply at once, at the current simulated time.
 * Nothing here changes the model or adds an undo step (a device's
 * Simulation settings are edited in the Edit tab, see modelChanged).
 */
import { FailureResult, refLabel, simulate } from '../analysis/failure';
import { fmtSec } from '../analysis/sim/engine';
import { ParamValue } from '../analysis/sim/params';
import { SimProtocolEntry, Simulation } from '../analysis/sim/simulation';
import { Flight, NetEvent, SessionStatus, SimEvent } from '../analysis/sim/types';
import { lookupProtocol } from '../model/protocols';
import { Model, deviceInterfaces } from '../model/types';
import { el } from './dom';
import { SimAnimator } from './sim-anim';
import { ParamEditor, paramEditor } from './sim-params-ui';
import { TablePanels } from './sim-tables';
import { SimulationMode } from './simulation-mode';

export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 5, 10];
export const TIMER_SCALES: readonly number[] = [1, 60, 240, 3600];
/** The event log shows at most this many of its newest matching events. */
const LOG_SHOWN = 250;
/** About how long a message is seen on its way at 1× (real ms), however short it is in simulated time. */
export const SLOW_MOTION = 300;

/** What the controller needs of the app. */
export interface SimHost {
  doc: Document;
  model(): Model;
  scene(): Element | null;
  view(): 'physical' | 'logical';
  reduce(): boolean;
  /** the simulation's state changed (what is down): the marks, the banner */
  changed(): void;
  /** the Simulation window's body, when it is open */
  windowBody(): HTMLElement | null;
  /** the screen rectangle of an object in the diagram */
  rectOf(ref: string): { x: number; y: number; w: number; h: number } | null;
  toast(text: string): void;
  /** the time moved on (the banner's and the status bar's texts) */
  tick(): void;
  /** the simulation-wide parameters changed (remembered for the next start in this browser session) */
  paramsChanged?(values: { [key: string]: ParamValue }): void;
}

export interface SimStartOptions {
  /** the protocols shown at the start (all when left out) */
  protocols?: string[];
  /** the simulation-wide parameters that differ from their defaults */
  params?: { [key: string]: ParamValue };
}

const FIXED_COLORS: { [k: string]: string } = { arp: '#f08c00', ndp: '#e67700', garp: '#c92a2a', demand: '#1c7ed6', link: '#868e96' };

type MenuItem = { label: string; act: () => void };

export class SimController implements SimulationMode {
  readonly sim: Simulation;
  readonly anim: SimAnimator;
  readonly tables: TablePanels;
  playing = true;
  speed = 1;
  /** the protocols shown (all at the start, or those Start simulation preselects) */
  readonly shown = new Set<string>();
  private raf = 0;
  private timer: number | null = null;
  private last = 0;
  private uiAt = 0;
  private failRes: { key: string; res: FailureResult } | null = null;
  private logFilter = '';
  private logKey = '';
  private statusKey = '';
  private eventsKey = '';
  private menuBox: HTMLElement | null = null;
  private stopped = false;
  private stateSeen = -1;
  /** reduced motion: the time of the last step (its messages are drawn as arrows) */
  private stepFrom: number | undefined;
  private editor: ParamEditor | null = null;
  /** dots of shown protocols not drawn at the last frame */
  notDrawn = 0;
  private readonly entries: SimProtocolEntry[];
  private onVis = (): void => this.schedule();

  constructor(
    private host: SimHost,
    opts: SimStartOptions | string[] = {},
  ) {
    const o: SimStartOptions = Array.isArray(opts) ? { protocols: opts } : opts;
    this.sim = new Simulation(host.model(), { params: o.params });
    this.anim = new SimAnimator(host.doc);
    this.tables = new TablePanels(host.doc);
    this.entries = this.sim.protocolEntries();
    for (const e of this.entries) if (!o.protocols || o.protocols.indexOf(e.id) >= 0) this.shown.add(e.id);
    this.stateSeen = this.sim.engine.stateVersion;
    host.doc.addEventListener('visibilitychange', this.onVis);
    this.schedule();
  }

  // ------------------------------------------------------------ simulation mode

  get t(): number {
    return this.sim.now;
  }

  note(): string {
    const n = this.sim.netEvents().length;
    return `Protocol simulation, t = ${fmtSec(this.t)}${n ? ` · ${n} network event${n === 1 ? '' : 's'}` : ''}`;
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
    this.tables.closeAll();
    this.anim.clear();
    this.closeMenu();
    this.host.doc.removeEventListener('visibilitychange', this.onVis);
  }

  // ------------------------------------------------------------ the clock

  private running(): boolean {
    return !this.stopped && this.playing && this.host.doc.visibilityState !== 'hidden';
  }

  /** Is a flight one whose dot is drawn now (its view, a protocol shown)? The playback slows down for these. */
  private drawable = (f: Flight): boolean => f.view === this.host.view() && this.flightShown(f);

  /** Start or stop the clock as the state says (rAF; under reduced motion a step every second). */
  schedule(): void {
    const w = this.host.doc.defaultView;
    if (!w) return;
    if (this.raf) w.cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer !== null) w.clearInterval(this.timer);
    this.timer = null;
    if (!this.running()) {
      this.refresh(true);
      return;
    }
    if (this.host.reduce()) {
      // reduced motion: no moving dots; the time advances in steps, each showing the messages of that step as arrows
      this.timer = w.setInterval(() => {
        if (!this.running()) return;
        this.stepFrom = this.t;
        this.sim.runTo(this.t + 1000 * this.speed);
        this.refresh(true);
      }, 1000);
      this.refresh(true);
      return;
    }
    this.stepFrom = undefined;
    this.last = w.performance.now();
    const frame = (now: number): void => {
      this.raf = 0;
      if (!this.running()) return;
      const dt = Math.min(250, now - this.last);
      this.last = now;
      this.sim.play(dt, this.speed, this.drawable, SLOW_MOTION);
      this.refresh(now - this.uiAt > 250);
      if (now - this.uiAt > 250) this.uiAt = now;
      this.raf = w.requestAnimationFrame(frame);
    };
    this.raf = w.requestAnimationFrame(frame);
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.schedule();
  }

  /** Step: to the next moment something happens, paused. */
  step(): number {
    this.playing = false;
    this.schedule();
    this.sim.step();
    this.refresh(true);
    return this.t;
  }

  setSpeed(s: number): void {
    if (SPEEDS.indexOf(s) < 0) return;
    this.speed = s;
    this.schedule();
  }

  /** Run to a time at once (tests; the self-test). */
  runTo(t: number): void {
    if (this.host.reduce()) this.stepFrom = this.t;
    this.sim.runTo(t);
    this.refresh(true);
  }

  // ------------------------------------------------------------ what is shown

  setShown(id: string, on: boolean): void {
    if (on) this.shown.add(id);
    else this.shown.delete(id);
    this.logKey = '';
    this.refresh(true);
  }

  setAllShown(on: boolean): void {
    for (const e of this.entries) if (on) this.shown.add(e.id);
    else this.shown.delete(e.id);
    this.logKey = '';
    this.refresh(true);
  }

  protocolEntries(): SimProtocolEntry[] {
    return this.entries;
  }

  private visible(protocol: string): boolean {
    if (protocol === 'link' || protocol === '') return true;
    return this.shown.has(protocol);
  }

  private flightShown = (f: Flight): boolean => this.visible(f.protocol) || (!!f.encapProtocols && f.encapProtocols.some((p) => this.visible(p)));

  color(protocol: string): string {
    if (FIXED_COLORS[protocol]) return FIXED_COLORS[protocol];
    const id = protocol.indexOf('custom:') === 0 ? protocol.slice(7) : protocol;
    return lookupProtocol(this.host.model().protocols, id).color;
  }

  /** Draw the dots now, and (when `ui`) the window and the tables; what is down changed: the marks. */
  refresh(ui: boolean): void {
    if (this.stopped) return;
    if (this.sim.engine.stateVersion !== this.stateSeen) {
      this.stateSeen = this.sim.engine.stateVersion;
      this.host.changed();
    }
    this.anim.setScene(this.host.scene());
    const view = this.host.view();
    const reduce = this.host.reduce();
    const since = reduce && this.stepFrom !== undefined ? this.stepFrom : undefined;
    const r = this.anim.draw(this.sim.flights(this.t, view, since !== undefined ? since : this.t), { view, t: this.t, shown: this.flightShown, reduce, since, color: (p) => this.color(p) });
    this.notDrawn = r.left;
    if (!ui) return;
    this.host.tick();
    this.tables.update();
    this.updateWindow();
  }

  /** The diagram was drawn again: the dots on the new scene. */
  sceneChanged(): void {
    this.refresh(false);
  }

  // ------------------------------------------------------------ network events

  private did(ok: boolean, text: string): boolean {
    if (!ok) return false;
    this.refresh(true);
    this.host.toast(`${text} at t = ${fmtSec(this.t)}.`);
    return true;
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

  startFlap(ref: string): boolean {
    return this.did(this.sim.startFlap(ref), `${this.cap(this.label(ref))} starts flapping`);
  }

  stopFlap(ref: string): boolean {
    return this.did(this.sim.stopFlap(ref), `${this.cap(this.label(ref))} stops flapping`);
  }

  shut(dev: string, iface: string): boolean {
    return this.did(this.sim.shut(dev, iface), `${dev}:${iface} shut`);
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

  /** End an event of the window's list. */
  endEvent(ev: NetEvent): boolean {
    return this.did(this.sim.end(ev), `${this.cap(this.label(ev.ref))}: ${this.endLabel(ev).toLowerCase()}`);
  }

  private endLabel(ev: NetEvent): string {
    return ev.kind === 'fail' ? 'Restore' : ev.kind === 'flap' ? 'Stop flapping' : ev.kind === 'shut' ? 'No shut' : 'Power on';
  }

  private cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private eventOf(ref: string, kind?: NetEvent['kind']): NetEvent | undefined {
    return this.sim.netEvents().find((e) => e.ref === ref && (!kind || e.kind === kind));
  }

  /** The cables and relations that can fail, as the window lists them. */
  links(): Array<{ ref: string; label: string }> {
    const m = this.host.model();
    const out: Array<{ ref: string; label: string }> = [];
    for (const l of m.links.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) out.push({ ref: 'link:' + l.id, label: `Cable ${l.id} (${l.a.device} – ${l.b.device})` });
    for (const r of m.relations.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) out.push({ ref: 'relation:' + r.id, label: `${lookupProtocol(m.protocols, r.protocol, r.category).label} ${r.id}` });
    return out;
  }

  /** Every interface ("dev:iface"), for shutting and flapping from the window. */
  interfaces(): string[] {
    const out: string[] = [];
    for (const d of this.host.model().devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) for (const i of deviceInterfaces(d).slice().sort((a, b) => (a.id < b.id ? -1 : 1))) out.push(d.id + ':' + i.id);
    return out;
  }

  private cabled(dev: string, iface: string): boolean {
    return this.sim.engine.net.ends.has(dev + '|' + iface);
  }

  // ------------------------------------------------------------ the tables

  showTable(kind: 'arp' | 'mac', dev: string, near?: { x: number; y: number; w: number; h: number } | null): boolean {
    const d = this.sim.tableDevices().find((x) => x.id === dev);
    if (!d || (kind === 'arp' ? !d.arp : !d.mac)) return false;
    const rect = near !== undefined ? near : this.host.rectOf('device:' + dev);
    if (kind === 'arp') this.tables.show('arp', dev, rect, () => ({ v4: this.sim.arpTable(dev), v6: this.sim.ndTable(dev), timers: this.sim.arpTimers(dev), scale: this.sim.timerScale }));
    else this.tables.show('mac', dev, rect, () => ({ rows: this.sim.macTable(dev), timers: this.sim.macTimers(dev), scale: this.sim.timerScale }));
    return true;
  }

  setTimerScale(n: number): void {
    if (TIMER_SCALES.indexOf(n) < 0) return;
    this.sim.setTimerScale(n);
    this.refresh(true);
  }

  // ------------------------------------------------------------ parameters

  /** A simulation-wide parameter changed in the window: it applies now. */
  setParam(key: string, v: ParamValue | undefined): void {
    this.sim.setParam(key, v);
    if (this.host.paramsChanged) this.host.paramsChanged(this.sim.params.simValues());
    this.logKey = '';
    this.refresh(true);
  }

  /** The model changed during the simulation (a device's Simulation settings, or their undo): they apply now. */
  modelChanged(model: Model): number {
    const n = this.sim.deviceParamsFrom(model).length;
    if (n) {
      this.logKey = '';
      this.refresh(true);
    }
    return n;
  }

  // ------------------------------------------------------------ the in-diagram menu

  /** A click in the diagram during the simulation: a short menu at that spot for a cable, a relation, a device or an interface. */
  diagramClick(ref: string | null, x: number, y: number): boolean {
    if (!ref) return false;
    const r = ref.indexOf('hub:') === 0 ? 'relation:' + ref.slice(4) : ref;
    const items: MenuItem[] = [];
    if (r.indexOf('link:') === 0 || r.indexOf('relation:') === 0) {
      if (this.eventOf(r, 'fail')) items.push({ label: 'Restore link', act: () => this.restoreLink(r) });
      else items.push({ label: 'Fail link', act: () => this.failLink(r) });
      if (r.indexOf('link:') === 0) {
        if (this.eventOf(r, 'flap')) items.push({ label: 'Stop flapping', act: () => this.stopFlap(r) });
        else items.push({ label: 'Start flapping', act: () => this.startFlap(r) });
      }
    } else if (r.indexOf('device:') === 0) {
      const dev = r.slice(7);
      const d = this.sim.tableDevices().find((q) => q.id === dev);
      if (d && d.arp) items.push({ label: 'Show ARP table', act: () => this.showTable('arp', dev) });
      if (d && d.mac) items.push({ label: 'Show MAC table', act: () => this.showTable('mac', dev) });
      if (this.sim.engine.off.has(dev)) items.push({ label: this.sim.engine.booting.has(dev) ? 'Power off (stop booting)' : 'Power on', act: () => (this.sim.engine.booting.has(dev) ? this.powerOff(dev) : this.powerOn(dev)) });
      else items.push({ label: 'Power off', act: () => this.powerOff(dev) });
      const ifs = this.interfaces().filter((k) => k.indexOf(dev + ':') === 0);
      if (ifs.length) items.push({ label: 'Shut an interface…', act: () => this.interfaceMenu(dev, x, y) });
    } else if (r.indexOf('iface:') === 0) {
      const rest = r.slice(6);
      const i = rest.indexOf(':');
      this.ifaceItems(rest.slice(0, i), rest.slice(i + 1), items);
    }
    if (!items.length) return false;
    this.openMenu(this.label(r), items, x, y);
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

  private openMenu(title: string, items: MenuItem[], x: number, y: number): void {
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
    const box = el(doc, 'div', { class: 'sim-menu', role: 'menu', 'aria-label': `Simulation: ${title}` }, [el(doc, 'div', { class: 'sim-menu-title', 'aria-hidden': 'true' }, [title]), ...buttons]);
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

  // ------------------------------------------------------------ the window

  /** The Simulation window's body (built once; updated in place). */
  windowBody(): HTMLElement {
    const doc = this.host.doc;
    const body = el(doc, 'div', { class: 'sim-win' });
    body.appendChild(
      el(doc, 'p', { class: 'sim-honest' }, [
        'A teaching and design-review simulation of protocol behaviour, not an exact protocol implementation. Latency, loss and the timers follow the parameters; the playback slows down while a message is on its way (about 0.3 s per cable at 1×) so that it can be followed.',
      ]),
    );
    // controls
    const play = el(doc, 'button', { type: 'button', id: 'sim-play', class: 'primary', 'aria-pressed': 'true' }, ['Pause']);
    const step = el(doc, 'button', { type: 'button', id: 'sim-step' }, ['Step']);
    const speed = el(doc, 'select', { id: 'sim-speed', 'aria-label': 'Speed of the simulated clock' }) as HTMLSelectElement;
    for (const s of SPEEDS) speed.appendChild(el(doc, 'option', { value: String(s) }, [`${s}×`]));
    speed.value = String(this.speed);
    const time = el(doc, 'span', { id: 'sim-time', class: 'sim-time' }, ['t = 0 s']);
    body.appendChild(el(doc, 'div', { class: 'sim-controls', role: 'group', 'aria-label': 'Simulation clock' }, [play, step, el(doc, 'label', { class: 'sim-speed' }, ['Speed ', speed]), time]));
    play.addEventListener('click', () => this.setPlaying(!this.playing));
    step.addEventListener('click', () => this.step());
    speed.addEventListener('change', () => this.setSpeed(Number(speed.value)));
    body.appendChild(el(doc, 'p', { id: 'sim-drawn', class: 'muted small', 'aria-live': 'off' }, ['']));
    // parameters: the same sections as the start dialog, applied at once
    const params = el(doc, 'details', { class: 'sim-sec', id: 'sim-params' });
    params.appendChild(el(doc, 'summary', {}, ['Parameters']));
    params.appendChild(el(doc, 'p', { class: 'muted small' }, ['A change applies at once, at the current simulated time, and is written to the event log.']));
    this.editor = paramEditor(doc, { id: 'sim-pw', values: this.sim.params.simValues(), onChange: (k, v) => this.setParam(k, v) });
    params.appendChild(this.editor.el);
    body.appendChild(params);
    // network events: the keyboard and screen-reader way of the in-diagram menus
    const evs = el(doc, 'details', { class: 'sim-sec', id: 'sim-links', open: '' });
    evs.appendChild(el(doc, 'summary', {}, ['Network events']));
    const sel = el(doc, 'select', { id: 'sim-link', 'aria-label': 'Cable or relation' }) as HTMLSelectElement;
    for (const l of this.links()) sel.appendChild(el(doc, 'option', { value: l.ref }, [l.label]));
    const failBtn = el(doc, 'button', { type: 'button', id: 'sim-fail' }, ['Fail link']);
    const flapBtn = el(doc, 'button', { type: 'button', id: 'sim-flap' }, ['Start flapping']);
    evs.appendChild(el(doc, 'div', { class: 'sim-row' }, [sel, failBtn, flapBtn]));
    failBtn.addEventListener('click', () => this.failLink(sel.value));
    flapBtn.addEventListener('click', () => {
      if (sel.value.indexOf('link:') === 0) this.startFlap(sel.value);
      else this.host.toast('Flapping is for cables: choose a cable.');
    });
    const dsel = el(doc, 'select', { id: 'sim-device', 'aria-label': 'Device' }) as HTMLSelectElement;
    for (const d of this.host.model().devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) dsel.appendChild(el(doc, 'option', { value: d.id }, [d.id]));
    const offBtn = el(doc, 'button', { type: 'button', id: 'sim-power' }, ['Power off']);
    evs.appendChild(el(doc, 'div', { class: 'sim-row' }, [dsel, offBtn]));
    offBtn.addEventListener('click', () => this.powerOff(dsel.value));
    const isel = el(doc, 'select', { id: 'sim-iface', 'aria-label': 'Interface' }) as HTMLSelectElement;
    for (const k of this.interfaces()) isel.appendChild(el(doc, 'option', { value: k }, [k]));
    const shutBtn = el(doc, 'button', { type: 'button', id: 'sim-shut' }, ['Shut interface']);
    const iflap = el(doc, 'button', { type: 'button', id: 'sim-iflap' }, ['Start flapping']);
    evs.appendChild(el(doc, 'div', { class: 'sim-row' }, [isel, shutBtn, iflap]));
    const split = (): [string, string] => {
      const i = isel.value.indexOf(':');
      return [isel.value.slice(0, i), isel.value.slice(i + 1)];
    };
    shutBtn.addEventListener('click', () => {
      const [d, i] = split();
      this.shut(d, i);
    });
    iflap.addEventListener('click', () => {
      const [d, i] = split();
      if (this.cabled(d, i)) this.startFlap(`iface:${d}:${i}`);
      else this.host.toast(`${d}:${i} has no cable to flap.`);
    });
    evs.appendChild(el(doc, 'p', { id: 'sim-failed', class: 'small', role: 'status' }, ['No network event. Several can be in effect at once; clicking a cable, relation, device or interface in the diagram offers the same.']));
    evs.appendChild(el(doc, 'ul', { id: 'sim-events', class: 'sim-events' }));
    body.appendChild(evs);
    // protocols shown
    const protos = el(doc, 'details', { class: 'sim-sec', id: 'sim-protos', open: '' });
    protos.appendChild(el(doc, 'summary', { id: 'sim-protos-sum' }, ['Protocols shown']));
    const all = el(doc, 'button', { type: 'button', class: 'mini', id: 'sim-all' }, ['Select all']);
    const none = el(doc, 'button', { type: 'button', class: 'mini', id: 'sim-none' }, ['Clear']);
    protos.appendChild(el(doc, 'div', { class: 'sim-proto-tools' }, [all, none, el(doc, 'span', { class: 'muted small' }, ['Hidden protocols still run (BGP still waits for ARP when ARP is hidden); only their dots and log lines are hidden.'])]));
    protos.appendChild(protocolChecks(doc, this.entries, this.shown, (p) => this.color(p), 'sim-p-'));
    protos.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      const id = t.getAttribute('data-sim-proto');
      if (id) this.setShown(id, t.checked);
    });
    all.addEventListener('click', () => {
      this.setAllShown(true);
      this.syncChecks(body);
    });
    none.addEventListener('click', () => {
      this.setAllShown(false);
      this.syncChecks(body);
    });
    body.appendChild(protos);
    // the tables
    const tabs = el(doc, 'details', { class: 'sim-sec', id: 'sim-tabs' });
    tabs.appendChild(el(doc, 'summary', {}, ['ARP, neighbour and MAC tables']));
    const scale = el(doc, 'select', { id: 'sim-scale', 'aria-label': 'Timer scale of the tables' }) as HTMLSelectElement;
    for (const n of TIMER_SCALES) scale.appendChild(el(doc, 'option', { value: String(n) }, [n === 1 ? 'Real time (1:1)' : `1:${n} (${n} times faster)`]));
    scale.value = String(this.sim.timerScale);
    scale.addEventListener('change', () => this.setTimerScale(Number(scale.value)));
    tabs.appendChild(el(doc, 'label', { class: 'sim-row' }, ['Table timers ', scale]));
    tabs.appendChild(el(doc, 'p', { class: 'muted small' }, ['The ARP timeout (4 h by default) would never run out in a demonstration: a faster scale shortens the simulated timeline of the ARP, neighbour and MAC timers only; the values shown in effect stay as they are.']));
    const list = el(doc, 'ul', { class: 'sim-devlist' });
    for (const d of this.sim.tableDevices()) {
      const btns: HTMLElement[] = [];
      if (d.arp) btns.push(el(doc, 'button', { type: 'button', class: 'mini', 'data-sim-table': 'arp', 'data-dev': d.id }, ['Show ARP table']));
      if (d.mac) btns.push(el(doc, 'button', { type: 'button', class: 'mini', 'data-sim-table': 'mac', 'data-dev': d.id }, ['Show MAC table']));
      if (btns.length) list.appendChild(el(doc, 'li', {}, [el(doc, 'span', { class: 'sim-dev' }, [d.id]), ...btns]));
    }
    list.addEventListener('click', (ev) => {
      const b = (ev.target as Element).closest('[data-sim-table]');
      if (b) this.showTable(b.getAttribute('data-sim-table') as 'arp' | 'mac', b.getAttribute('data-dev') as string);
    });
    tabs.appendChild(list);
    body.appendChild(tabs);
    // status
    const status = el(doc, 'details', { class: 'sim-sec', id: 'sim-status', open: '' });
    status.appendChild(el(doc, 'summary', {}, ['Status']));
    status.appendChild(el(doc, 'div', { id: 'sim-status-table', class: 'sim-scroll' }));
    body.appendChild(status);
    // event log
    const log = el(doc, 'details', { class: 'sim-sec', id: 'sim-log', open: '' });
    log.appendChild(el(doc, 'summary', {}, ['Event log']));
    const filter = el(doc, 'input', { type: 'search', id: 'sim-log-filter', placeholder: 'Filter: device, protocol, message, address', 'aria-label': 'Filter the event log', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    filter.value = this.logFilter;
    filter.addEventListener('input', () => {
      this.logFilter = filter.value;
      this.logKey = '';
      this.updateWindow();
    });
    log.appendChild(filter);
    log.appendChild(el(doc, 'p', { id: 'sim-log-note', class: 'muted small' }, ['']));
    log.appendChild(el(doc, 'div', { id: 'sim-log-table', class: 'sim-scroll sim-log' }));
    body.appendChild(log);
    this.logKey = '';
    this.statusKey = '';
    this.eventsKey = '';
    return body;
  }

  private syncChecks(body: HTMLElement): void {
    const boxes = body.querySelectorAll('input[data-sim-proto]');
    for (let i = 0; i < boxes.length; i++) (boxes[i] as HTMLInputElement).checked = this.shown.has(boxes[i].getAttribute('data-sim-proto') as string);
  }

  /** The window's live parts: the time, the play button, the events, the status and the log. */
  updateWindow(): void {
    const body = this.host.windowBody();
    if (!body || !body.querySelector('#sim-time')) return;
    const q = (id: string): HTMLElement => body.querySelector('#' + id) as HTMLElement;
    q('sim-time').textContent = `t = ${timeText(this.t)}${this.host.reduce() ? ' (steps: reduced motion)' : ''}`;
    const play = q('sim-play');
    play.textContent = this.playing ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', this.playing ? 'true' : 'false');
    q('sim-drawn').textContent = this.notDrawn ? `${this.notDrawn} message${this.notDrawn === 1 ? '' : 's'} in flight not drawn (at most a few dozen dots, each with room for its label); the event log lists every message.` : '';
    const shownN = this.entries.filter((e) => this.shown.has(e.id)).length;
    q('sim-protos-sum').textContent = `Protocols shown (${shownN} of ${this.entries.length})`;
    // the network events in effect, each with its way back
    const evs = this.sim.netEvents();
    const ek = evs.map((e) => e.ref + e.kind + e.state).join('|');
    if (ek !== this.eventsKey) {
      this.eventsKey = ek;
      q('sim-failed').textContent = evs.length ? `${evs.length} network event${evs.length === 1 ? '' : 's'} in effect.` : 'No network event. Several can be in effect at once; clicking a cable, relation, device or interface in the diagram offers the same.';
      const ul = q('sim-events');
      while (ul.firstChild) ul.removeChild(ul.firstChild);
      for (const e of evs) {
        const what = e.kind === 'fail' ? 'failed' : e.kind === 'flap' ? `flapping (${e.state})` : e.kind === 'shut' ? 'shut' : e.state;
        const li = el(this.host.doc, 'li', { 'data-event': e.kind, 'data-ref': e.ref }, [el(this.host.doc, 'span', {}, [`${this.cap(this.label(e.ref))}: ${what}, since t = ${fmtSec(e.since)}`])]);
        if (!e.hosted) {
          const b = el(this.host.doc, 'button', { type: 'button', class: 'mini', 'aria-label': `${this.endLabel(e)}: ${this.label(e.ref)}` }, [this.endLabel(e)]);
          b.addEventListener('click', () => this.endEvent(e));
          li.appendChild(b);
        }
        ul.appendChild(li);
      }
    }
    if (this.editor) this.editor.set(this.sim.params.simValues());
    // status table: rebuilt when it changed
    const st = this.sim.status().filter((s) => this.visible(s.protocol));
    const sk = st.map((s) => s.name + s.state + s.detail.length).join('|') + '|' + Math.floor(this.t / 1000);
    if (sk !== this.statusKey) {
      this.statusKey = sk;
      const box = q('sim-status-table');
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(this.statusTable(st));
    }
    // the log: rebuilt when it grew or the filter changed
    const events = this.sim.events();
    const lk = `${events.length}|${this.sim.engine.logDropped}|${Array.from(this.shown).join(',')}|${this.logFilter}`;
    if (lk !== this.logKey) {
      this.logKey = lk;
      this.renderLog(q('sim-log-table'), q('sim-log-note'), events);
    }
  }

  private statusTable(rows: SessionStatus[]): HTMLElement {
    const doc = this.host.doc;
    const head = ['Protocol', 'Session', 'State', 'Details'];
    const t = el(doc, 'table', { class: 'sim-table' });
    t.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Status of the protocols’ sessions']));
    t.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, head.map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
    const tb = el(doc, 'tbody');
    for (const s of rows) {
      tb.appendChild(el(doc, 'tr', { 'data-up': s.up ? 'true' : 'false', 'data-protocol': s.protocol }, [el(doc, 'td', {}, [this.protoLabel(s.protocol)]), el(doc, 'td', {}, [s.name]), el(doc, 'td', { class: s.up ? 'st-up' : 'st-down' }, [(s.up ? '● ' : '○ ') + s.state]), el(doc, 'td', { class: 'small' }, [s.detail])]));
    }
    if (!rows.length) tb.appendChild(el(doc, 'tr', {}, [el(doc, 'td', { colspan: '4', class: 'muted' }, ['No session of the protocols shown.'])]));
    t.appendChild(tb);
    return t;
  }

  protoLabel(protocol: string): string {
    const e = this.entries.find((x) => x.id === protocol);
    return e ? e.label : protocol === 'link' ? 'Link' : protocol === 'stp' ? 'STP / MAC' : protocol;
  }

  /** The events the log lists: of shown protocols (and the links), matching the filter, up to now. */
  logEvents(events: SimEvent[] = this.sim.events()): { list: SimEvent[]; hidden: number } {
    const words = this.logFilter.toLowerCase().split(/\s+/).filter((w) => w);
    let hidden = 0;
    const list: SimEvent[] = [];
    for (const e of events) {
      if (e.t > this.t) break;
      if (!this.visible(e.protocol)) {
        hidden++;
        continue;
      }
      if (words.length) {
        const hay = `${e.device} ${e.peer} ${this.protoLabel(e.protocol)} ${e.what} ${e.state} ${e.detail}`.toLowerCase();
        if (!words.every((w) => hay.indexOf(w) >= 0)) continue;
      }
      list.push(e);
    }
    return { list, hidden };
  }

  private renderLog(box: HTMLElement, note: HTMLElement, events: SimEvent[]): void {
    const doc = this.host.doc;
    const { list, hidden } = this.logEvents(events);
    const shown = list.slice(-LOG_SHOWN);
    note.textContent = `${list.length} event${list.length === 1 ? '' : 's'}${list.length > shown.length ? `, the newest ${shown.length} listed` : ''}${hidden ? `; ${hidden} of hidden protocols not listed (they still run)` : ''}${this.sim.engine.logDropped ? `; the ${this.sim.engine.logDropped} oldest were dropped from the log` : ''}.`;
    while (box.firstChild) box.removeChild(box.firstChild);
    const head = ['Time (s)', 'From', 'To', 'Protocol', 'Message', 'State', 'Details'];
    const t = el(doc, 'table', { class: 'sim-table' });
    t.appendChild(el(doc, 'caption', { class: 'sr-only' }, ['Event log']));
    t.appendChild(el(doc, 'thead', {}, [el(doc, 'tr', {}, head.map((h) => el(doc, 'th', { scope: 'col' }, [h])))]));
    const tb = el(doc, 'tbody');
    for (const e of shown) {
      tb.appendChild(
        el(doc, 'tr', { 'data-kind': e.kind, 'data-protocol': e.protocol }, [
          el(doc, 'td', { class: 'mono' }, [logTime(e.t)]),
          el(doc, 'td', {}, [e.device]),
          el(doc, 'td', {}, [e.peer]),
          el(doc, 'td', {}, [this.protoLabel(e.protocol)]),
          el(doc, 'td', {}, [e.what]),
          el(doc, 'td', {}, [e.state]),
          el(doc, 'td', { class: 'small' }, [e.detail]),
        ]),
      );
    }
    t.appendChild(tb);
    box.appendChild(t);
    box.scrollTop = box.scrollHeight;
  }
}

/** The protocol checkboxes, grouped (the window and the start dialog). */
export function protocolChecks(doc: Document, entries: SimProtocolEntry[], shown: Set<string>, color: (p: string) => string, idPrefix: string): HTMLElement {
  const box = el(doc, 'div', { class: 'sim-groups' });
  const groups = new Map<string, HTMLElement>();
  for (const e of entries) {
    let fs = groups.get(e.group);
    if (!fs) {
      fs = el(doc, 'fieldset', { class: 'sim-group' }, [el(doc, 'legend', {}, [e.group])]);
      groups.set(e.group, fs);
      box.appendChild(fs);
    }
    const cb = el(doc, 'input', { type: 'checkbox', 'data-sim-proto': e.id, id: idPrefix + e.id.replace(/[^a-z0-9-]/gi, '_') }) as HTMLInputElement;
    cb.checked = shown.has(e.id);
    fs.appendChild(el(doc, 'label', { class: 'check' }, [cb, ' ', el(doc, 'span', { class: 'sim-swatch', 'aria-hidden': 'true', style: `background:${color(e.id)}` }), e.label]));
  }
  return box;
}

/** The clock's time: to the millisecond ("12.345 s"). */
export function timeText(ms: number): string {
  return `${(Math.floor(ms) / 1000).toFixed(3)} s`;
}

/** An event's time in the log, in seconds to the microsecond ("12.000134"). */
export function logTime(ms: number): string {
  return (ms / 1000).toFixed(6);
}

/**
 * The forms of Network events besides Send network packets: Join multicast
 * group, Start multicast stream and Interface actions. Each chooses its own
 * device and interface (nothing is taken from the diagram's selection unless
 * asked: a device's menu fills in its device, nothing else), shows what
 * applies, and disables its button with a short reason until it can be
 * carried out. The checks are the simulation's own (`joinProblem`,
 * `streamProblem`, whether an interface is shut, cabled or flapping), so the
 * form can't promise what the operation then refuses.
 */
import { parseAddress } from '../model/ip';
import { isSsmGroup } from '../analysis/sim/mac';
import { Simulation, TestSource } from '../analysis/sim/simulation';
import { el } from './dom';

/** What the forms ask of the controller. */
export interface EventFormHost {
  sim(): Simulation;
  join(dev: string, iface: string, group: string, sources: string[]): string;
  stream(dev: string, iface: string, group: string, port: number, intervalMs: number, size: number): string;
  shut(dev: string, iface: string): string;
  flap(dev: string, iface: string): string;
  /** the reverse actions: No shut (Bring interface up), Stop flapping */
  noShut(dev: string, iface: string): string;
  stopFlap(dev: string, iface: string): string;
  /** a device's interfaces, labelled as Send network packets labels them, with whether each is cabled */
  interfacesOf(dev: string): Array<{ id: string; label: string; cabled: boolean }>;
  /** the flapping cycle as the Layer 1 parameters set it ("down 5 s, up 10 s, 3 cycles") */
  flapTimes(): string;
}

type Opt = { value: string; label: string; disabled?: boolean; title?: string };

/** Fill a select's options again when they changed, keeping what is chosen while it is offered. */
function fill(doc: Document, s: HTMLSelectElement, opts: Opt[]): void {
  const key = opts.map((o) => `${o.value}|${o.label}|${o.disabled ? 1 : 0}`).join('/');
  if (s.getAttribute('data-key') === key) return;
  s.setAttribute('data-key', key);
  const was = s.value;
  while (s.firstChild) s.removeChild(s.firstChild);
  for (const o of opts) {
    const e = el(doc, 'option', { value: o.value, title: o.title || null }, [o.label]) as HTMLOptionElement;
    if (o.disabled) e.disabled = true;
    s.appendChild(e);
  }
  s.value = opts.some((o) => o.value === was) ? was : '';
}

/** A grid of label and control rows, as Send network packets has. */
function grid(doc: Document, rows: Array<[string, string, HTMLElement]>): HTMLElement {
  const g = el(doc, 'div', { class: 'sim-test-form' });
  for (const [id, label, control] of rows) {
    const l = el(doc, 'label', { for: id, 'data-row': id }, [label]);
    control.setAttribute('data-row', id);
    g.appendChild(l);
    g.appendChild(control);
  }
  return g;
}

function show(root: HTMLElement, id: string, on: boolean): void {
  for (const e of Array.from(root.querySelectorAll(`[data-row="${id}"]`))) (e as HTMLElement).hidden = !on;
}

/** The hosts that can join a group or send a stream: an IP stack, an address, not a router (a router joins by PIM). */
function hostOptions(sim: Simulation): Opt[] {
  return [{ value: '', label: 'Select…' }].concat(
    sim.testSources().map((x: TestSource) => {
      const sd = sim.engine.net.devices.get(x.id);
      const why = !x.ok ? x.short : sd && sd.routes ? 'A router (joins by PIM)' : '';
      return { value: x.id, label: why ? `${x.id} — ${why}` : x.id, disabled: !!why, title: x.ok ? undefined : x.reason } as Opt;
    }),
  );
}

/** A host's interfaces with an address now (a DHCP client's without its lease: disabled). */
function hostIfaces(sim: Simulation, dev: string): Opt[] {
  const src = sim.testSources().find((x) => x.id === dev);
  if (!src) return [];
  return src.ifaces.map((i) => ({ value: i.id, label: i.label, disabled: !i.ready, title: i.status }));
}

/** A device and its interface: the device first, then one of its interfaces (one: chosen and shown). */
class Target {
  readonly dev: HTMLSelectElement;
  readonly iface: HTMLSelectElement;
  constructor(
    private doc: Document,
    id: string,
  ) {
    this.dev = el(doc, 'select', { id: id + '-dev' }) as HTMLSelectElement;
    this.iface = el(doc, 'select', { id: id + '-if' }) as HTMLSelectElement;
    this.dev.addEventListener('change', () => {
      this.iface.value = '';
      this.iface.removeAttribute('data-key');
    });
  }

  sync(devs: Opt[], ifaces: (dev: string) => Opt[]): void {
    fill(this.doc, this.dev, devs);
    const ifs = this.dev.value ? ifaces(this.dev.value) : [];
    const ok = ifs.filter((o) => !o.disabled);
    fill(this.doc, this.iface, (ok.length === 1 ? [] : [{ value: '', label: ifs.length ? 'Select…' : this.dev.value ? 'No interfaces' : 'Choose a device first' }]).concat(ifs));
    if (ok.length === 1 && this.iface.value !== ok[0].value) this.iface.value = ok[0].value;
    this.iface.disabled = !this.dev.value || !ifs.length;
  }

  /** A device chosen in the diagram's menu: it, and its interface chosen anew. */
  set(dev: string): void {
    if (this.dev.value === dev) return;
    this.dev.value = dev;
    this.iface.value = '';
    this.iface.removeAttribute('data-key');
  }
}

/** A button with what blocks it said under it (its accessible description) and the result of the last one. */
function footer(doc: Document, id: string, buttons: HTMLButtonElement[]): { el: HTMLElement; need: HTMLElement; msg: HTMLElement } {
  const need = el(doc, 'p', { id: id + '-need', class: 'small muted sim-t-note' });
  const msg = el(doc, 'p', { id: id + '-msg', class: 'small', role: 'status' });
  for (const b of buttons) b.setAttribute('aria-describedby', id + '-need');
  return { el: el(doc, 'div', {}, [el(doc, 'div', { class: 'sp-row' }, buttons), need, msg]), need, msg };
}

function setNeed(need: HTMLElement, buttons: HTMLButtonElement[], why: string | null): void {
  if (need.textContent !== (why || '')) need.textContent = why || '';
  for (const b of buttons) b.disabled = !!why;
}

/** Join multicast group: a host's interface joins a group (and, for a source-specific group, its sources). */
export class JoinForm {
  readonly el: HTMLElement;
  private t: Target;
  private group: HTMLInputElement;
  private sources: HTMLInputElement;
  private btn: HTMLButtonElement;
  private f: { el: HTMLElement; need: HTMLElement; msg: HTMLElement };

  constructor(
    doc: Document,
    private host: EventFormHost,
  ) {
    this.t = new Target(doc, 'sim-j');
    this.group = el(doc, 'input', { type: 'text', id: 'sim-j-group', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. 239.1.1.1 or ff15::1' }) as HTMLInputElement;
    this.sources = el(doc, 'input', { type: 'text', id: 'sim-j-src', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. 10.30.0.30' }) as HTMLInputElement;
    this.btn = el(doc, 'button', { type: 'button', id: 'sim-j-go', class: 'sp-primary' }, ['Join group']) as HTMLButtonElement;
    this.f = footer(doc, 'sim-j', [this.btn]);
    this.el = el(doc, 'div', { class: 'sim-ev-form' }, [grid(doc, [['sim-j-dev', 'Device', this.t.dev], ['sim-j-if', 'Interface', this.t.iface], ['sim-j-group', 'Group', this.group], ['sim-j-src', 'Sources', this.sources]]), this.f.el]);
    for (const e of [this.t.dev, this.t.iface]) e.addEventListener('change', () => this.sync());
    for (const e of [this.group, this.sources]) e.addEventListener('input', () => this.sync());
    this.group.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.btn.click();
    });
    this.btn.addEventListener('click', () => {
      this.sync();
      if (this.btn.disabled) return;
      this.f.msg.textContent = this.host.join(this.t.dev.value, this.t.iface.value, this.group.value.trim(), this.srcList());
      this.sync();
    });
    this.sync();
  }

  private ssm(): boolean {
    const g = parseAddress(this.group.value.trim());
    return !!g && isSsmGroup(g);
  }

  private srcList(): string[] {
    return this.ssm() ? this.sources.value.split(/[,\s]+/).filter((x) => x) : [];
  }

  sync(): void {
    const sim = this.host.sim();
    this.t.sync(hostOptions(sim), (d) => hostIfaces(sim, d));
    // sources only for a source-specific group (232.0.0.0/8, ff3x::/32); emptied otherwise
    const ssm = this.ssm();
    if (!ssm && this.sources.value) this.sources.value = '';
    show(this.el, 'sim-j-src', ssm);
    const why = !this.t.dev.value ? 'Choose a host.' : !this.t.iface.value ? 'Choose its interface.' : !this.group.value.trim() ? 'Enter the group.' : sim.joinProblem(this.t.dev.value, this.t.iface.value, this.group.value.trim(), this.srcList());
    setNeed(this.f.need, [this.btn], why ? why.replace(/\.?$/, '.') : null);
  }

  setDevice(dev: string): void {
    this.t.set(dev);
    this.sync();
  }

  focus(): void {
    (this.t.dev.value ? this.group : this.t.dev).focus();
  }
}

/** Start multicast stream: a host sends UDP datagrams to a group every interval until Stop stream. */
export class StreamForm {
  readonly el: HTMLElement;
  private t: Target;
  private group: HTMLInputElement;
  private port: HTMLInputElement;
  private interval: HTMLInputElement;
  private size: HTMLInputElement;
  private btn: HTMLButtonElement;
  private f: { el: HTMLElement; need: HTMLElement; msg: HTMLElement };

  constructor(
    doc: Document,
    private host: EventFormHost,
  ) {
    this.t = new Target(doc, 'sim-s');
    this.group = el(doc, 'input', { type: 'text', id: 'sim-s-group', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. 239.1.1.1' }) as HTMLInputElement;
    this.port = el(doc, 'input', { type: 'number', id: 'sim-s-port', min: '1', max: '65535', inputmode: 'numeric', placeholder: '1–65535' }) as HTMLInputElement;
    this.interval = el(doc, 'input', { type: 'number', id: 'sim-s-int', min: '0.1', max: '3600', step: '0.1', inputmode: 'decimal', value: '1' }) as HTMLInputElement;
    this.size = el(doc, 'input', { type: 'number', id: 'sim-s-size', min: '1', max: '65000', inputmode: 'numeric', value: '1316' }) as HTMLInputElement;
    this.btn = el(doc, 'button', { type: 'button', id: 'sim-s-go', class: 'sp-primary' }, ['Start stream']) as HTMLButtonElement;
    this.f = footer(doc, 'sim-s', [this.btn]);
    const unit = (i: HTMLElement, u: string): HTMLElement => el(doc, 'span', { class: 'pinput' }, [i, el(doc, 'span', { class: 'punit', 'aria-hidden': 'true' }, [u])]);
    this.interval.setAttribute('aria-label', 'Interval in seconds');
    this.size.setAttribute('aria-label', 'Datagram size in bytes');
    this.el = el(doc, 'div', { class: 'sim-ev-form' }, [
      grid(doc, [['sim-s-dev', 'Device', this.t.dev], ['sim-s-if', 'Interface', this.t.iface], ['sim-s-group', 'Group', this.group], ['sim-s-port', 'UDP port', this.port], ['sim-s-int', 'Interval', unit(this.interval, 's')], ['sim-s-size', 'Size', unit(this.size, 'bytes')]]),
      el(doc, 'p', { class: 'small muted sim-t-note' }, ['Sends datagrams until stopped; the members of the group receive them where multicast routing brings them.']),
      this.f.el,
    ]);
    for (const e of [this.t.dev, this.t.iface]) e.addEventListener('change', () => this.sync());
    for (const e of [this.group, this.port, this.interval, this.size]) e.addEventListener('input', () => this.sync());
    this.btn.addEventListener('click', () => {
      this.sync();
      if (this.btn.disabled) return;
      this.f.msg.textContent = this.host.stream(this.t.dev.value, this.t.iface.value, this.group.value.trim(), Number(this.port.value), Math.round(Number(this.interval.value) * 1000), Number(this.size.value));
      this.sync();
    });
    this.sync();
  }

  sync(): void {
    const sim = this.host.sim();
    this.t.sync(hostOptions(sim), (d) => hostIfaces(sim, d));
    const n = (e: HTMLInputElement): number => (e.value.trim() === '' ? NaN : Number(e.value));
    const port = n(this.port);
    const iv = n(this.interval);
    const size = n(this.size);
    const why = !this.t.dev.value
      ? 'Choose a host.'
      : !this.t.iface.value
        ? 'Choose its interface.'
        : !this.group.value.trim()
          ? 'Enter the group.'
          : sim.streamProblem(this.t.dev.value, this.t.iface.value, this.group.value.trim()) ||
            (this.port.value.trim() === '' ? 'Enter the UDP port.' : !(Number.isInteger(port) && port >= 1 && port <= 65535) ? 'The port is a whole number from 1 to 65535.' : !(iv >= 0.1 && iv <= 3600) ? 'The interval is 0.1 to 3600 s.' : !(Number.isInteger(size) && size >= 1 && size <= 65000) ? 'The size is a whole number from 1 to 65000 bytes.' : null);
    setNeed(this.f.need, [this.btn], why ? why.replace(/\.?$/, '.') : null);
  }

  setDevice(dev: string): void {
    this.t.set(dev);
    this.sync();
  }

  focus(): void {
    (this.t.dev.value ? this.group : this.t.dev).focus();
  }
}

/**
 * Interface actions: Shut interface and Start flapping for a device's interface. The form follows the
 * chosen interface's state in the simulation, whatever changed it (these buttons, the diagram's menus,
 * Active events, a flap's own cycles): shut, its first button is Bring interface up; flapping, its second
 * is Stop flapping; the state is said in words with an icon, and the form is marked. An explicit shut
 * stops the interface's flapping first; a shut interface can't start flapping. Stop flapping ends the
 * flapping where it is: the cable is up again unless something else holds it down, which is the state
 * it had before it flapped when nothing else changed it.
 */
export class IfaceForm {
  readonly el: HTMLElement;
  private t: Target;
  private shutBtn: HTMLButtonElement;
  private flapBtn: HTMLButtonElement;
  private state: HTMLElement;
  private times: HTMLElement;
  private f: { el: HTMLElement; need: HTMLElement; msg: HTMLElement };
  /** the last press of each button (a second press right after it is not taken as the reverse action) */
  private pressed = new Map<HTMLButtonElement, number>();

  constructor(
    doc: Document,
    private host: EventFormHost,
  ) {
    this.t = new Target(doc, 'sim-i');
    this.shutBtn = el(doc, 'button', { type: 'button', id: 'sim-i-shut', class: 'sp-primary' }, ['Shut interface']) as HTMLButtonElement;
    this.flapBtn = el(doc, 'button', { type: 'button', id: 'sim-i-flap', class: 'sp-primary' }, ['Start flapping']) as HTMLButtonElement;
    this.state = el(doc, 'p', { id: 'sim-i-state', class: 'small sim-i-state' });
    this.times = el(doc, 'p', { id: 'sim-i-times', class: 'small muted sim-t-note' });
    this.f = footer(doc, 'sim-i', [this.shutBtn, this.flapBtn]);
    this.t.iface.setAttribute('aria-describedby', 'sim-i-state');
    this.el = el(doc, 'div', { class: 'sim-ev-form sim-i-form' }, [grid(doc, [['sim-i-dev', 'Device', this.t.dev], ['sim-i-if', 'Interface', this.t.iface]]), this.state, this.times, this.f.el]);
    for (const e of [this.t.dev, this.t.iface]) e.addEventListener('change', () => this.sync());
    this.shutBtn.addEventListener('click', () => this.press(this.shutBtn, () => (this.isShut() ? this.host.noShut(this.dev(), this.iface()) : this.host.shut(this.dev(), this.iface()))));
    this.flapBtn.addEventListener('click', () => this.press(this.flapBtn, () => (this.isFlapping() ? this.host.stopFlap(this.dev(), this.iface()) : this.host.flap(this.dev(), this.iface()))));
    this.sync();
  }

  private dev(): string {
    return this.t.dev.value;
  }

  private iface(): string {
    return this.t.iface.value;
  }

  private isShut(): boolean {
    return !!this.dev() && !!this.iface() && this.host.sim().engine.isShut(this.dev(), this.iface());
  }

  private isFlapping(): boolean {
    return !!this.dev() && !!this.iface() && !!this.host.sim().engine.flapOf(`iface:${this.dev()}:${this.iface()}`);
  }

  /** A button pressed: its action once (a second press within half a second counts as the same press). */
  private press(b: HTMLButtonElement, act: () => string): void {
    const now = Date.now();
    const last = this.pressed.get(b);
    if (last !== undefined && now - last < 500) return;
    this.pressed.set(b, now);
    this.sync();
    if (b.disabled) return;
    this.f.msg.textContent = act();
    this.sync();
  }

  sync(): void {
    const sim = this.host.sim();
    const devs: Opt[] = [{ value: '', label: 'Select…' }].concat(sim.model.devices.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => ({ value: d.id, label: d.id })));
    const flapping = (dev: string, i: string): boolean => !!sim.engine.flapOf(`iface:${dev}:${i}`);
    this.t.sync(devs, (d) => this.host.interfacesOf(d).map((i) => ({ value: i.id, label: i.label + (sim.engine.isShut(d, i.id) ? ' (shut)' : i.cabled && flapping(d, i.id) ? ' (flapping)' : '') })));
    const dev = this.dev();
    const i = this.iface();
    const info = dev && i ? this.host.interfacesOf(dev).find((x) => x.id === i) : undefined;
    const t = `Flapping: ${this.host.flapTimes()} (the Layer 1 parameters of the setup).`;
    if (this.times.textContent !== t) this.times.textContent = t;
    const shut = this.isShut();
    const flap = this.isFlapping();
    // the buttons say what they will do to this interface now
    const sl = shut ? 'Bring interface up' : 'Shut interface';
    const fl = flap ? 'Stop flapping' : 'Start flapping';
    if (this.shutBtn.textContent !== sl) this.shutBtn.textContent = sl;
    if (this.flapBtn.textContent !== fl) this.flapBtn.textContent = fl;
    this.shutBtn.setAttribute('data-op', shut ? 'noshut' : 'shut');
    this.flapBtn.setAttribute('data-op', flap ? 'stop' : 'start');
    // its state, marked (an icon and words, not the colour alone): administrative and in operation apart
    let text = '';
    let mark = '';
    if (dev && i) {
      const st = sim.engine.portStatus(dev, i);
      const oper = st.oper === 'up' ? 'link up' : st.oper === 'no cable' ? 'no cable' : st.oper === 'negotiating' ? 'link coming up' : `link down${st.why && st.why !== 'shut' ? ` (${st.why})` : ''}`;
      if (shut) {
        mark = 'shut';
        text = `⏻ Shut: administratively down · ${oper}`;
      } else if (flap) {
        const fo = sim.engine.flapOf(`iface:${dev}:${i}`);
        const n = sim.engine.params.num('flap-cycles');
        mark = 'flapping';
        text = `↯ Flapping: ${fo && fo.down ? 'down' : 'up'} now, cycle ${fo ? fo.done + (fo.down ? 1 : 0) : 0}${n ? ' of ' + n : ''} · administratively up`;
      } else text = `Administratively up · ${oper}`;
    }
    if (this.state.textContent !== text) this.state.textContent = text;
    if (mark) this.el.setAttribute('data-state', mark);
    else this.el.removeAttribute('data-state');
    const base = !dev ? 'Choose a device.' : !i ? 'Choose its interface.' : null;
    const flapWhy = base || (flap ? null : shut ? `${dev}:${i} is shut: bring it up first.` : !info || !info.cabled ? `${dev}:${i} has no cable to flap.` : null);
    this.shutBtn.disabled = !!base;
    this.flapBtn.disabled = !!flapWhy;
    // the reason for what is disabled, or what a press will also do
    const why = base || flapWhy || (flap ? 'Shut interface stops the flapping first.' : null);
    if (this.f.need.textContent !== (why || '')) this.f.need.textContent = why || '';
  }

  setTarget(dev: string, iface?: string): void {
    this.t.set(dev);
    this.sync();
    if (iface) {
      this.t.iface.value = iface;
      this.sync();
    }
  }

  focus(): void {
    (this.t.dev.value ? this.t.iface : this.t.dev).focus();
  }
}

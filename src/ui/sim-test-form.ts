/**
 * The Send network packets form of the simulation's Actions panel (Network
 * events; called Send test before). The delivery type
 * comes first (nothing is chosen for you): until it is chosen, From and To
 * are disabled and say why. Then only what that type uses is shown:
 *
 * - **Unicast**: To (a device, or an address or host name written in) and
 *   the destination interface ("eth0 - 10.0.0.1"; one of several must be
 *   chosen).
 * - **Multicast**: the group.
 * - **Local broadcast**: the scope (limited, or the source interface's
 *   subnet).
 * - **Directed broadcast**: the target subnet, written in.
 *
 * The source's interfaces are options ("Vlan10 - 192.168.10.1"; a DHCP
 * client's with its lease now). One interface is shown as text, none as
 * "No interfaces". The protocols offered, the port (TCP and UDP only), the
 * message count and interval, and what blocks Send come from the
 * simulation's shared plan rules (`test-plan.ts`, `Simulation.planCheck`),
 * so the form never offers what the packet generator refuses. A field that
 * stops applying is cleared, never kept hidden.
 */
import { TestKind } from '../analysis/sim/transport';
import { DELIVERIES, DELIVERY_LABEL, Delivery, KIND_LABEL, MAX_INTERVAL, MAX_MESSAGES, MIN_INTERVAL, TestPlan, kindsFor, needsInterface, usesPorts } from '../analysis/sim/test-plan';
import { Simulation, TestDestination, TestSource } from '../analysis/sim/simulation';
import { el } from './dom';

export interface TestFormHost {
  sim(): Simulation;
  /** send the plan (Send; Send and play: `play`), the message to show */
  send(plan: TestPlan, play: boolean): string;
  playing(): boolean;
}

/** The value of "Address or host name…" under To, and of "Chosen by routing" under Interface. */
const OTHER = '*';
const ROUTED = '*';

export class TestForm {
  readonly el: HTMLElement;
  private type: HTMLSelectElement;
  private typeHelp: HTMLElement;
  private from: HTMLSelectElement;
  private via: HTMLSelectElement;
  private viaOne: HTMLElement;
  private to: HTMLSelectElement;
  private addr: HTMLInputElement;
  private toif: HTMLSelectElement;
  private toifOne: HTMLElement;
  private group: HTMLInputElement;
  private scope: HTMLSelectElement;
  private subnet: HTMLInputElement;
  private kind: HTMLSelectElement;
  private port: HTMLInputElement;
  private count: HTMLInputElement;
  private interval: HTMLInputElement;
  private size: HTMLInputElement;
  private df: HTMLInputElement;
  private keep: HTMLInputElement;
  private keepRow: HTMLElement;
  private need: HTMLElement;
  private msg: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private sendPlay: HTMLButtonElement;
  /** the rows of the grid by name: [label, control] */
  private rows = new Map<string, HTMLElement[]>();

  constructor(
    private doc: Document,
    private host: TestFormHost,
    more: (doc: Document, id: string, title: string, body: HTMLElement) => HTMLElement,
  ) {
    const d = doc;
    const sel = (id: string, attrs: { [k: string]: string } = {}): HTMLSelectElement => el(d, 'select', { id, ...attrs }) as HTMLSelectElement;
    const txt = (id: string, ph: string): HTMLInputElement => el(d, 'input', { type: 'text', id, autocomplete: 'off', spellcheck: 'false', placeholder: ph }) as HTMLInputElement;
    const num = (id: string, attrs: { [k: string]: string }): HTMLInputElement => el(d, 'input', { type: 'number', id, ...attrs }) as HTMLInputElement;
    const opt = (s: HTMLSelectElement, v: string, t: string): void => {
      s.appendChild(el(d, 'option', { value: v }, [t]));
    };
    this.type = sel('sim-t-type', { 'aria-describedby': 'sim-t-type-help' });
    opt(this.type, '', 'Select…');
    for (const x of DELIVERIES) opt(this.type, x, DELIVERY_LABEL[x]);
    this.typeHelp = el(d, 'p', { id: 'sim-t-type-help', class: 'small muted sim-t-note' }, ['Choose a delivery type first.']);
    this.from = sel('sim-t-from', { 'aria-describedby': 'sim-t-type-help' });
    this.via = sel('sim-t-via');
    this.viaOne = el(d, 'span', { id: 'sim-t-via-one', class: 'sim-t-one', role: 'status' });
    this.to = sel('sim-t-to', { 'aria-describedby': 'sim-t-type-help' });
    this.addr = txt('sim-t-addr', 'address or host name');
    this.toif = sel('sim-t-toif');
    this.toifOne = el(d, 'span', { id: 'sim-t-toif-one', class: 'sim-t-one', role: 'status' });
    this.group = txt('sim-t-group', 'e.g. 239.1.1.1 or ff15::1');
    this.scope = sel('sim-t-scope');
    this.subnet = txt('sim-t-subnet', 'e.g. 10.1.2.0/24');
    this.kind = sel('sim-t-kind');
    this.port = num('sim-t-port', { min: '1', max: '65535', inputmode: 'numeric', placeholder: '1–65535' });
    this.count = num('sim-t-count', { min: '1', max: String(MAX_MESSAGES), inputmode: 'numeric', value: '1' });
    this.interval = num('sim-t-interval', { min: String(MIN_INTERVAL), max: String(MAX_INTERVAL), step: 'any', inputmode: 'decimal', value: '1' });
    this.size = num('sim-t-size', { min: '0', max: '65000', inputmode: 'numeric', placeholder: 'default' });
    this.df = el(d, 'input', { type: 'checkbox', id: 'sim-t-df' }) as HTMLInputElement;
    this.keep = el(d, 'input', { type: 'checkbox', id: 'sim-t-keep' }) as HTMLInputElement;
    this.need = el(d, 'p', { id: 'sim-t-need', class: 'small muted sim-t-note' });
    this.msg = el(d, 'p', { id: 'sim-t-msg', class: 'small', role: 'status' }, ['']);
    this.sendBtn = el(d, 'button', { type: 'button', id: 'sim-t-send', class: 'primary sp-primary', 'aria-describedby': 'sim-t-need' }, ['Send']) as HTMLButtonElement;
    // paused: the test is sent at the current time and waits for Play; Send and play sends it and plays
    this.sendPlay = el(d, 'button', { type: 'button', id: 'sim-t-sendplay', class: 'sp-primary', 'aria-describedby': 'sim-t-need' }, ['Send and play']) as HTMLButtonElement;
    const lab = (f: string, t: Array<Node | string>, id?: string): HTMLElement => el(d, 'label', { for: f, id: id || null }, t);
    const sr = (t: string): HTMLElement => el(d, 'span', { class: 'sr-only' }, [t]);
    const cell = (kids: HTMLElement[]): HTMLElement => el(d, 'div', { class: 'sim-t-cell' }, kids);
    const grid = el(d, 'div', { class: 'sim-test-form' });
    const row = (name: string, label: HTMLElement, control: HTMLElement): void => {
      label.setAttribute('data-row', name);
      control.setAttribute('data-row', name);
      grid.appendChild(label);
      grid.appendChild(control);
      this.rows.set(name, [label, control]);
    };
    row('type', lab('sim-t-type', ['Delivery']), this.type);
    grid.appendChild(this.typeHelp);
    row('from', lab('sim-t-from', ['From']), this.from);
    row('via', lab('sim-t-via', [sr('From '), 'Interface'], 'sim-t-via-l'), cell([this.via, this.viaOne]));
    row('to', lab('sim-t-to', ['To']), this.to);
    row('addr', lab('sim-t-addr', [sr('To '), 'Address']), this.addr);
    row('toif', lab('sim-t-toif', [sr('To '), 'Interface'], 'sim-t-toif-l'), cell([this.toif, this.toifOne]));
    row('group', lab('sim-t-group', ['Group']), this.group);
    row('scope', lab('sim-t-scope', ['Scope']), this.scope);
    row('subnet', lab('sim-t-subnet', ['Subnet']), this.subnet);
    row('kind', lab('sim-t-kind', ['Protocol']), this.kind);
    row('port', lab('sim-t-port', ['Port']), this.port);
    row('count', lab('sim-t-count', ['Messages']), this.count);
    row('interval', lab('sim-t-interval', ['Interval']), el(d, 'span', { class: 'pinput' }, [this.interval, el(d, 'span', { class: 'punit', 'aria-hidden': 'true' }, ['s'])]));
    // the single interface shown as text is named by its row's label
    this.viaOne.setAttribute('aria-labelledby', 'sim-t-via-l');
    this.toifOne.setAttribute('aria-labelledby', 'sim-t-toif-l');
    this.interval.setAttribute('aria-label', 'Interval in seconds');
    this.keepRow = el(d, 'label', { class: 'check' }, [this.keep, ' TCP: keep open (keepalive)']);
    const moreBody = el(d, 'div', { class: 'sim-test-form' }, [lab('sim-t-size', ['Data']), el(d, 'span', { class: 'pinput' }, [this.size, el(d, 'span', { class: 'punit' }, ['bytes'])]), el(d, 'span'), el(d, 'label', { class: 'check' }, [this.df, ' Don’t fragment (IPv4)']), el(d, 'span'), this.keepRow]);
    this.el = el(d, 'div', { class: 'sim-test' }, [grid, more(d, 'sim-t-more', 'More options', moreBody), el(d, 'div', { class: 'sp-row' }, [this.sendBtn, this.sendPlay]), this.need, this.msg]);
    // what stops applying is cleared (never kept hidden); what still fits stays
    this.type.addEventListener('change', () => {
      const t = this.type.value as Delivery | '';
      this.clearDestination();
      if (this.via.value === ROUTED && t && needsInterface(t)) this.via.value = '';
      if (this.kind.value && (!t || kindsFor(t).indexOf(this.kind.value as TestKind) < 0)) this.kind.value = '';
      this.kindChanged();
      this.sync();
    });
    this.from.addEventListener('change', () => {
      this.via.value = '';
      this.via.removeAttribute('data-key');
      if (this.to.value === this.from.value) this.clearDestination();
      this.sync();
    });
    this.to.addEventListener('change', () => {
      this.toif.value = '';
      this.toif.removeAttribute('data-key');
      if (this.to.value !== OTHER) this.addr.value = '';
      this.sync();
    });
    this.kind.addEventListener('change', () => {
      this.kindChanged();
      this.sync();
    });
    for (const e of [this.via, this.toif, this.scope]) e.addEventListener('change', () => this.sync());
    for (const e of [this.addr, this.group, this.subnet, this.port, this.count, this.interval, this.size]) e.addEventListener('input', () => this.sync());
    for (const e of [this.addr, this.group, this.subnet, this.port, this.count, this.interval])
      e.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key !== 'Enter') return;
        ev.preventDefault();
        this.sendBtn.click();
      });
    this.sendBtn.addEventListener('click', () => this.submit(false));
    this.sendPlay.addEventListener('click', () => this.submit(true));
    this.sync();
  }

  /** The protocol changed: a port only where it has one, keep open only for TCP. */
  private kindChanged(): void {
    const k = this.kind.value as TestKind | '';
    if (!k || !usesPorts(k)) this.port.value = '';
    if (k !== 'tcp') this.keep.checked = false;
  }

  /** Clear what the destination of every delivery type holds. */
  private clearDestination(): void {
    this.to.value = '';
    this.addr.value = '';
    this.toif.value = '';
    this.toif.removeAttribute('data-key');
    this.group.value = '';
    this.scope.value = '';
    this.subnet.value = '';
  }

  /** Send test… from a device's menu: it becomes the source (the delivery type is still the user's choice). */
  setSource(dev: string): void {
    this.sync();
    if (this.from.value !== dev) {
      this.from.value = dev;
      this.via.value = '';
      this.via.removeAttribute('data-key');
      if (this.to.value === dev) this.clearDestination();
    }
    this.sync();
    const next = !this.type.value ? this.type : this.rowShown('to') ? this.to : this.rowShown('group') ? this.group : this.rowShown('scope') ? this.scope : this.subnet;
    next.scrollIntoView({ block: 'nearest' });
    next.focus();
  }

  private rowShown(name: string): boolean {
    const r = this.rows.get(name);
    return !!r && !r[0].hidden;
  }

  private show(name: string, on: boolean): void {
    for (const e of this.rows.get(name) || []) e.hidden = !on;
  }

  /** Fill a select's options again when they changed (by a key), keeping what is chosen while it is offered. */
  private options(s: HTMLSelectElement, opts: Array<{ value: string; label: string; disabled?: boolean; title?: string }>): void {
    const key = opts.map((o) => `${o.value}|${o.label}|${o.disabled ? 1 : 0}`).join('/');
    if (s.getAttribute('data-key') === key) return;
    s.setAttribute('data-key', key);
    const was = s.value;
    while (s.firstChild) s.removeChild(s.firstChild);
    for (const o of opts) {
      const e = el(this.doc, 'option', { value: o.value, title: o.title || null }, [o.label]) as HTMLOptionElement;
      if (o.disabled) e.disabled = true;
      s.appendChild(e);
    }
    s.value = opts.some((o) => o.value === was) ? was : '';
  }

  /** Bring the form up to date: the options from the simulation's state now, what is shown, what blocks Send. */
  sync(): void {
    const sim = this.host.sim();
    const t = this.type.value as Delivery | '';
    const on = !!t;
    this.typeHelp.hidden = on;
    // From: every device (one that can't send: disabled, with the reason in a few words)
    const sources = sim.testSources();
    this.options(this.from, [{ value: '', label: 'Select…' }, ...sources.map((x) => ({ value: x.id, label: x.ok ? x.id : `${x.id} — ${x.short}`, disabled: !x.ok, title: x.ok ? undefined : x.reason }))]);
    this.from.disabled = !on;
    this.to.disabled = !on;
    if (on) this.from.removeAttribute('aria-describedby');
    else this.from.setAttribute('aria-describedby', 'sim-t-type-help');
    if (on) this.to.removeAttribute('aria-describedby');
    else this.to.setAttribute('aria-describedby', 'sim-t-type-help');
    const src = sources.find((x) => x.id === this.from.value);
    this.syncVia(t, src);
    // the destination the delivery type asks for
    this.show('to', !on || t === 'unicast');
    this.show('group', t === 'multicast');
    this.show('scope', t === 'broadcast');
    this.show('subnet', t === 'directed');
    const dests = t === 'unicast' || !on ? sim.testDestinations(this.from.value) : [];
    this.options(this.to, [{ value: '', label: 'Select…' }, ...dests.map((x) => ({ value: x.id, label: x.ok ? x.id : `${x.id} — ${x.short}`, disabled: !x.ok })), { value: OTHER, label: 'Address or host name…' }]);
    this.show('addr', t === 'unicast' && this.to.value === OTHER);
    const dest = dests.find((x) => x.id === this.to.value);
    this.syncToIface(t === 'unicast' ? dest : undefined);
    if (t === 'broadcast') {
      const i = src ? src.ifaces.find((x) => x.id === this.viaId(t, src)) : undefined;
      this.options(this.scope, [{ value: '', label: 'Select…' }, { value: 'limited', label: 'Limited (255.255.255.255)' }, { value: 'subnet', label: `Subnet (${i && i.bcast ? i.bcast : i ? 'not known yet' : 'of the interface'})` }]);
    }
    // the protocols the delivery type offers; a port only where the protocol has one
    this.options(this.kind, [{ value: '', label: 'Select…' }, ...(on ? kindsFor(t as Delivery) : []).map((k) => ({ value: k, label: KIND_LABEL[k] }))]);
    this.kind.disabled = !on;
    const k = this.kind.value as TestKind | '';
    this.show('kind', on);
    this.show('port', on && !!k && usesPorts(k));
    this.show('count', on);
    this.show('interval', on);
    const n = Number(this.count.value);
    this.interval.disabled = !(this.count.value.trim() !== '' && n > 1);
    this.keepRow.hidden = k !== 'tcp';
    this.sendPlay.hidden = this.host.playing();
    // what blocks Send: the first thing missing, in the form's order
    // (before the delivery type, its own hint says what comes first)
    const why = on && this.from.value ? sim.planCheck(this.plan()) : on ? 'Choose the device to send from.' : 'Choose a delivery type.';
    const shown = on ? why || '' : '';
    if (this.need.textContent !== shown) this.need.textContent = shown;
    for (const b of [this.sendBtn, this.sendPlay]) {
      b.disabled = !!why;
      b.setAttribute('aria-describedby', on ? 'sim-t-need' : 'sim-t-type-help');
    }
  }

  /** The source's interfaces: options when it has several, else its one interface (or none) as text. */
  private syncVia(t: Delivery | '', src: TestSource | undefined): void {
    const show = !!t && !!src && src.ok;
    this.show('via', show);
    if (!show || !src) return;
    const usable = src.ifaces.filter((i) => i.usable);
    const many = src.ifaces.length > 1;
    this.via.hidden = !many;
    this.viaOne.hidden = many;
    const routed = !needsInterface(t as Delivery);
    const opts: Array<{ value: string; label: string; disabled?: boolean; title?: string }> = [];
    if (usable.length > 1) opts.push({ value: '', label: 'Select…' });
    if (routed && usable.length > 1) opts.push({ value: ROUTED, label: 'Chosen by routing' });
    for (const i of src.ifaces) opts.push({ value: i.id, label: i.label, disabled: !i.usable, title: i.status });
    this.options(this.via, opts);
    if (usable.length === 1 && this.via.value !== usable[0].id) this.via.value = usable[0].id;
    const one = src.ifaces.length === 1 ? src.ifaces[0].label : src.ifaces.length ? '' : 'No interfaces';
    if (this.viaOne.textContent !== one) this.viaOne.textContent = one;
    this.viaOne.title = src.ifaces.length === 1 ? src.ifaces[0].status : '';
  }

  /** The destination's interfaces (unicast to a device): options when it has several, else its one as text. */
  private syncToIface(dest: TestDestination | undefined): void {
    this.show('toif', !!dest);
    if (!dest) return;
    const many = dest.options.length > 1;
    this.toif.hidden = !many;
    this.toifOne.hidden = many;
    const ok = dest.options.filter((o) => o.ok);
    this.options(this.toif, [...(ok.length === 1 ? [] : [{ value: '', label: 'Select…' }]), ...dest.options.map((o) => ({ value: o.value, label: o.label, disabled: !o.ok }))]);
    // one address to choose: it is the one (and shown); several: the user chooses
    if (ok.length === 1 && this.toif.value !== ok[0].value) this.toif.value = ok[0].value;
    const one = dest.options.length === 1 ? dest.options[0].label : '';
    if (this.toifOne.textContent !== one) this.toifOne.textContent = one;
  }

  /** The source interface the plan names: the one chosen, the only one, or none (as its routes choose). */
  private viaId(t: Delivery | '', src: TestSource | undefined): string | undefined {
    if (!src) return undefined;
    if (src.ifaces.length > 1) return this.via.value === ROUTED ? undefined : this.via.value;
    // one interface: a routed type lets the route choose it (the same interface), a broadcast or a group names it
    return src.ifaces.length === 1 && t && needsInterface(t) ? src.ifaces[0].id : undefined;
  }

  /** The plan as the form has it: only the fields that apply (missing or invalid values as they are, for the checks to name). */
  plan(): TestPlan {
    const t = this.type.value as Delivery;
    const src = this.host.sim().testSources().find((x) => x.id === this.from.value);
    const k = this.kind.value as TestKind;
    const numOf = (e: HTMLInputElement): number => (e.value.trim() === '' ? NaN : Number(e.value));
    const p: TestPlan = { delivery: t, from: this.from.value, kind: k };
    const via = this.viaId(t, src);
    if (src && src.ifaces.length > 1) p.via = via;
    else if (via !== undefined) p.via = via;
    if (t === 'unicast') {
      if (this.to.value === OTHER) p.target = this.addr.value.trim() || undefined;
      else if (this.to.value) {
        p.to = this.to.value;
        const i = this.toif.value.indexOf('|');
        if (i > 0) {
          p.toIface = this.toif.value.slice(0, i);
          p.toAddr = this.toif.value.slice(i + 1);
        }
      }
      if (this.to.value === OTHER && !p.target) p.target = '';
    } else if (t === 'multicast') p.group = this.group.value.trim();
    else if (t === 'broadcast') p.scope = (this.scope.value || undefined) as TestPlan['scope'];
    else if (t === 'directed') p.subnet = this.subnet.value.trim();
    if (k && usesPorts(k)) p.port = this.port.value.trim() === '' ? undefined : Number(this.port.value);
    p.count = numOf(this.count);
    if (p.count > 1) p.interval = numOf(this.interval);
    if (this.size.value.trim() !== '') p.size = Number(this.size.value);
    if (this.df.checked) p.df = true;
    if (k === 'tcp' && this.keep.checked) p.keep = true;
    return p;
  }

  private submit(play: boolean): void {
    this.sync();
    if (this.sendBtn.disabled) {
      this.msg.textContent = this.need.textContent || '';
      return;
    }
    this.msg.textContent = this.host.send(this.plan(), play);
    this.sync();
  }
}

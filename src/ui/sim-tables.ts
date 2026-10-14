/**
 * The ARP, neighbour and MAC tables of the protocol simulation, shown on
 * request (Show ARP table / Show MAC table): each a small non-modal panel
 * titled with the device ("ARP table · hq-rtr1"), several at once, each
 * movable by its title bar (or its move button and the arrow keys), with
 * a close button, closed by Esc. The timers in effect head the table
 * (configured or default, and the timer scale); the rows update with the
 * simulated time. Proper table markup; changes are announced politely,
 * at most every few seconds. Opening a table changes nothing in the
 * simulation; the panels close when it ends.
 */
import { ArpRow, MacRow, TableTimer } from '../analysis/sim/types';
import { el } from './dom';

export type TableKind = 'arp' | 'mac';

export interface ArpData {
  v4: ArpRow[];
  v6: ArpRow[];
  timers: TableTimer[];
  scale: number;
}

export interface MacData {
  rows: MacRow[];
  timers: TableTimer[];
  scale: number;
}

interface Panel {
  kind: TableKind;
  dev: string;
  box: HTMLElement;
  body: HTMLElement;
  live: HTMLElement;
  lastCount: number;
  lastSaid: number;
  data: () => ArpData | MacData;
  back: Element | null;
}

const STEP = 16;

/** Milliseconds as "4 s", "3 min 4 s", "4 h". */
export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ' ' + (s % 60) + ' s' : ''}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h${m ? ' ' + m + ' min' : ''}`;
}

function timerText(t: TableTimer): string {
  return `${t.value} (${t.origin})`;
}

export class TablePanels {
  private panels: Panel[] = [];

  constructor(private doc: Document) {}

  /** The open tables (for tests and the window). */
  open(): Array<{ kind: TableKind; dev: string }> {
    return this.panels.map((p) => ({ kind: p.kind, dev: p.dev }));
  }

  /** Open a device's table beside a point (a device's box on screen), or bring it forward when it is open. */
  show(kind: TableKind, dev: string, near: { x: number; y: number; w: number; h: number } | null, data: () => ArpData | MacData): HTMLElement {
    const known = this.panels.find((p) => p.kind === kind && p.dev === dev);
    if (known) {
      (known.box.querySelector('.st-close') as HTMLElement).focus();
      return known.box;
    }
    const id = `st-${kind}-${this.panels.length}-${Math.floor(Math.random() * 1e6)}`;
    const title = `${kind === 'arp' ? 'ARP table' : 'MAC table'} · ${dev}`;
    const close = el(this.doc, 'button', { type: 'button', class: 'st-close', 'aria-label': `Close the ${title}`, title: 'Close (Esc)' }, ['×']);
    const move = el(this.doc, 'button', { type: 'button', class: 'st-move', 'aria-label': `Move the ${title} (arrow keys)`, title: 'Move: drag the title, or the arrow keys here (Shift: faster)' }, ['⠿']);
    const head = el(this.doc, 'div', { class: 'st-head' }, [move, el(this.doc, 'h3', { id: id + '-t', class: 'st-title' }, [title]), close]);
    const body = el(this.doc, 'div', { class: 'st-body' });
    const live = el(this.doc, 'p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const box = el(this.doc, 'section', { class: 'sim-table-panel', role: 'dialog', 'aria-labelledby': id + '-t', 'data-table': kind, 'data-device': dev }, [head, body, live]);
    this.doc.body.appendChild(box);
    const p: Panel = { kind, dev, box, body, live, lastCount: -1, lastSaid: 0, data, back: this.doc.activeElement };
    this.panels.push(p);
    this.render(p);
    this.place(p, near);
    close.addEventListener('click', () => this.close(p));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close(p);
      }
    });
    move.addEventListener('keydown', (e) => {
      const d: { [k: string]: [number, number] } = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const v = d[e.key];
      if (!v) return;
      e.preventDefault();
      const s = e.shiftKey ? 4 * STEP : STEP;
      this.moveBy(p, v[0] * s, v[1] * s);
    });
    // drag by the title bar
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button')) return;
      const r = box.getBoundingClientRect();
      const ox = e.clientX - r.left;
      const oy = e.clientY - r.top;
      const mv = (ev: PointerEvent): void => this.moveTo(p, ev.clientX - ox, ev.clientY - oy);
      const up = (): void => {
        this.doc.removeEventListener('pointermove', mv);
        this.doc.removeEventListener('pointerup', up);
      };
      this.doc.addEventListener('pointermove', mv);
      this.doc.addEventListener('pointerup', up);
      e.preventDefault();
    });
    close.focus();
    return box;
  }

  private place(p: Panel, near: { x: number; y: number; w: number; h: number } | null): void {
    const win = this.doc.defaultView;
    const vw = win ? win.innerWidth : 1200;
    const w = Math.min(560, vw - 32);
    p.box.style.width = w + 'px';
    const n = this.panels.length - 1;
    let x: number;
    let y: number;
    if (near) {
      // beside the device, never on it: right of it, else left of it
      x = near.x + near.w + 12 <= vw - w - 8 ? near.x + near.w + 12 : Math.max(8, near.x - w - 12);
      y = near.y + n * 24;
    } else {
      x = vw - w - 24 - n * 24;
      y = 80 + n * 24;
    }
    this.moveTo(p, x, y);
  }

  private moveTo(p: Panel, x: number, y: number): void {
    const win = this.doc.defaultView;
    const vw = win ? win.innerWidth : 1200;
    const vh = win ? win.innerHeight : 800;
    const r = p.box.getBoundingClientRect();
    const w = r.width || 400;
    const h = Math.min(r.height || 200, vh - 16);
    // always wholly inside the browser window (it can be moved aside, never out)
    p.box.style.left = Math.round(Math.max(8, Math.min(vw - w - 8, x))) + 'px';
    p.box.style.top = Math.round(Math.max(8, Math.min(vh - h - 8, y))) + 'px';
  }

  private moveBy(p: Panel, dx: number, dy: number): void {
    const r = p.box.getBoundingClientRect();
    this.moveTo(p, r.left + dx, r.top + dy);
  }

  close(p: Panel): void {
    const i = this.panels.indexOf(p);
    if (i < 0) return;
    this.panels.splice(i, 1);
    if (p.box.parentNode) p.box.parentNode.removeChild(p.box);
    const back = p.back as HTMLElement | null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  closeKind(kind: TableKind, dev: string): boolean {
    const p = this.panels.find((x) => x.kind === kind && x.dev === dev);
    if (!p) return false;
    this.close(p);
    return true;
  }

  closeAll(): void {
    for (const p of this.panels.slice()) {
      this.panels.splice(this.panels.indexOf(p), 1);
      if (p.box.parentNode) p.box.parentNode.removeChild(p.box);
    }
  }

  /** The rows again (with the simulated time); each panel stays inside the window as it grows. */
  update(): void {
    for (const p of this.panels) {
      this.render(p);
      const r = p.box.getBoundingClientRect();
      this.moveTo(p, r.left, r.top);
    }
  }

  private render(p: Panel): void {
    const d = p.data();
    const body = p.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    const timers = el(this.doc, 'dl', { class: 'st-timers' });
    for (const t of d.timers) timers.appendChild(el(this.doc, 'div', {}, [el(this.doc, 'dt', {}, [t.label]), el(this.doc, 'dd', {}, [timerText(t)])]));
    timers.appendChild(el(this.doc, 'div', {}, [el(this.doc, 'dt', {}, ['Timer scale']), el(this.doc, 'dd', {}, [d.scale === 1 ? 'real time (1:1)' : `1:${d.scale} — the timers run ${d.scale} times faster in this simulation; the values above are unchanged`])]));
    body.appendChild(timers);
    let count = 0;
    if (p.kind === 'arp') {
      const a = d as ArpData;
      body.appendChild(this.arpTable(`ARP table (IPv4) of ${p.dev}`, a.v4, false));
      if (a.v6.length) body.appendChild(this.arpTable(`Neighbour table (IPv6) of ${p.dev}`, a.v6, true));
      count = a.v4.length + a.v6.length;
    } else {
      const m = d as MacData;
      body.appendChild(this.macTable(`MAC table of ${p.dev}`, m.rows));
      count = m.rows.length;
    }
    // announce changes politely, without flooding: the number of entries, at most every 5 s of real time
    const now = Date.now();
    if (count !== p.lastCount && now - p.lastSaid > 5000) {
      if (p.lastCount >= 0) p.live.textContent = `${p.kind === 'arp' ? 'ARP table' : 'MAC table'} of ${p.dev}: ${count} entr${count === 1 ? 'y' : 'ies'}`;
      p.lastCount = count;
      p.lastSaid = now;
    }
  }

  private arpTable(caption: string, rows: ArpRow[], v6: boolean): HTMLElement {
    const head = ['IP address', 'MAC address', 'Interface', 'VLAN', 'Type', 'State', 'Age', 'Expires in'];
    const t = el(this.doc, 'table', { class: 'st-table' });
    t.appendChild(el(this.doc, 'caption', {}, [caption]));
    t.appendChild(el(this.doc, 'thead', {}, [el(this.doc, 'tr', {}, head.map((h) => el(this.doc, 'th', { scope: 'col' }, [h])))]));
    const tb = el(this.doc, 'tbody');
    if (!rows.length) tb.appendChild(el(this.doc, 'tr', {}, [el(this.doc, 'td', { colspan: String(head.length), class: 'muted' }, [v6 ? 'No neighbours yet.' : 'Empty: nothing resolved yet.'])]));
    for (const r of rows) {
      tb.appendChild(
        el(this.doc, 'tr', { 'data-ip': r.ip, 'data-type': r.type }, [
          el(this.doc, 'td', { class: 'mono' }, [r.ip]),
          el(this.doc, 'td', { class: 'mono' }, [r.mac ? r.mac + (r.macSimulated ? ' (simulated)' : '') : '(incomplete)']),
          el(this.doc, 'td', {}, [r.iface]),
          el(this.doc, 'td', {}, [r.vlan ? String(r.vlan) : '—']),
          el(this.doc, 'td', {}, [r.type === 'virtual' ? 'virtual (VRRP …)' : r.type]),
          el(this.doc, 'td', {}, [r.state || '—']),
          el(this.doc, 'td', {}, [duration(r.age)]),
          el(this.doc, 'td', {}, [duration(r.remaining)]),
        ]),
      );
    }
    t.appendChild(tb);
    return el(this.doc, 'div', { class: 'st-scroll' }, [t]);
  }

  private macTable(caption: string, rows: MacRow[]): HTMLElement {
    const head = ['MAC address', 'VLAN', 'Port', 'Type', 'Age', 'Expires in'];
    const t = el(this.doc, 'table', { class: 'st-table' });
    t.appendChild(el(this.doc, 'caption', {}, [caption]));
    t.appendChild(el(this.doc, 'thead', {}, [el(this.doc, 'tr', {}, head.map((h) => el(this.doc, 'th', { scope: 'col' }, [h])))]));
    const tb = el(this.doc, 'tbody');
    if (!rows.length) tb.appendChild(el(this.doc, 'tr', {}, [el(this.doc, 'td', { colspan: String(head.length), class: 'muted' }, ['Empty: nothing learned yet.'])]));
    for (const r of rows) {
      tb.appendChild(
        el(this.doc, 'tr', { 'data-mac': r.mac, 'data-port': r.port, 'data-type': r.type }, [
          el(this.doc, 'td', { class: 'mono' }, [r.mac + (r.macSimulated ? ' (simulated)' : '')]),
          el(this.doc, 'td', {}, [r.vlan ? String(r.vlan) : 'untagged']),
          el(this.doc, 'td', {}, [r.port]),
          el(this.doc, 'td', {}, [r.type]),
          el(this.doc, 'td', {}, [r.type === 'static' ? '—' : duration(r.age)]),
          el(this.doc, 'td', {}, [duration(r.remaining)]),
        ]),
      );
    }
    t.appendChild(tb);
    return el(this.doc, 'div', { class: 'st-scroll' }, [t]);
  }
}

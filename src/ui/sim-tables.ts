/**
 * The tables of the protocol simulation, shown on request: a device's ARP
 * and neighbour table, a switch's MAC table, a device's connections (its
 * open ports, TCP connections and tests waiting), a firewall's session
 * table, and the packet inspector (one frame, layer by layer). Each is a
 * small non-modal panel titled with what it shows ("ARP table ·
 * hq-rtr1"), several at once, each movable by its title bar (or its move
 * button and the arrow keys), with a close button, closed by Esc. The
 * timers in effect head a table (configured or default, and the timer
 * scale); the rows update with the simulated time. Proper table markup;
 * changes are announced politely, at most every few seconds. Opening a
 * table changes nothing in the simulation; the panels close when it ends.
 */
import { ArpRow, ConnRow, Headers, MacRow, SessionRow, TableTimer } from '../analysis/sim/types';
import { el } from './dom';

export type TableKind = 'arp' | 'mac' | 'conn' | 'fw' | 'packet';

export interface ConnData {
  rows: ConnRow[];
  /** what it listens on, and why ("listening tcp/443 (device)") */
  listening: string;
}

export interface FwData {
  rows: SessionRow[];
  timers: TableTimer[];
}

export interface PacketData {
  hdr: Headers;
  /** when it was on its way, and where ("t = 3.4 s, on cable l2 (r1 → fw1)") */
  where: string;
}

type AnyData = ArpData | MacData | ConnData | FwData | PacketData;

const TITLES: { [k in TableKind]: string } = { arp: 'ARP table', mac: 'MAC table', conn: 'Connections', fw: 'Sessions', packet: 'Packet' };

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
  data: () => AnyData;
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
  show(kind: TableKind, dev: string, near: { x: number; y: number; w: number; h: number } | null, data: () => AnyData): HTMLElement {
    const known = this.panels.find((p) => p.kind === kind && p.dev === dev);
    if (known) {
      if (kind === 'packet') known.data = data;
      this.render(known);
      (known.box.querySelector('.st-close') as HTMLElement).focus();
      return known.box;
    }
    const id = `st-${kind}-${this.panels.length}-${Math.floor(Math.random() * 1e6)}`;
    const title = `${TITLES[kind]} · ${dev}`;
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
      if (p.kind !== 'packet') this.render(p);
      const r = p.box.getBoundingClientRect();
      this.moveTo(p, r.left, r.top);
    }
  }

  private render(p: Panel): void {
    const body = p.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (p.kind === 'packet') {
      body.appendChild(this.packet(p.data() as PacketData));
      return;
    }
    if (p.kind === 'conn' || p.kind === 'fw') {
      const n = p.kind === 'conn' ? this.connPanel(p) : this.fwPanel(p);
      this.announce(p, n);
      return;
    }
    const d = p.data() as ArpData | MacData;
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
    this.announce(p, count);
  }

  /** Announce changes politely, without flooding: the number of entries, at most every 5 s of real time. */
  private announce(p: Panel, count: number): void {
    const now = Date.now();
    if (count !== p.lastCount && now - p.lastSaid > 5000) {
      if (p.lastCount >= 0) p.live.textContent = `${TITLES[p.kind]} of ${p.dev}: ${count} entr${count === 1 ? 'y' : 'ies'}`;
      p.lastCount = count;
      p.lastSaid = now;
    }
  }

  private head(cols: string[]): HTMLElement {
    return el(this.doc, 'thead', {}, [el(this.doc, 'tr', {}, cols.map((h) => el(this.doc, 'th', { scope: 'col' }, [h])))]);
  }

  /** A device's connections: open ports, TCP connections with their state, tests waiting for an answer. */
  private connPanel(p: Panel): number {
    const d = p.data() as ConnData;
    p.body.appendChild(el(this.doc, 'p', { class: 'small' }, [d.listening]));
    const cols = ['Protocol', 'Local', 'Remote', 'State', 'For', 'Age', 'Timer'];
    const t = el(this.doc, 'table', { class: 'st-table' });
    t.appendChild(el(this.doc, 'caption', {}, [`Connections of ${p.dev}`]));
    t.appendChild(this.head(cols));
    const tb = el(this.doc, 'tbody');
    if (!d.rows.length) tb.appendChild(el(this.doc, 'tr', {}, [el(this.doc, 'td', { colspan: String(cols.length), class: 'muted' }, ['No open port and no connection.'])]));
    for (const r of d.rows) {
      tb.appendChild(
        el(this.doc, 'tr', { 'data-state': r.state, 'data-proto': r.proto }, [
          el(this.doc, 'td', {}, [r.proto.toUpperCase()]),
          el(this.doc, 'td', { class: 'mono' }, [r.local || '—']),
          el(this.doc, 'td', { class: 'mono' }, [r.remote]),
          el(this.doc, 'td', {}, [r.state]),
          el(this.doc, 'td', { class: 'small' }, [r.what]),
          el(this.doc, 'td', {}, [r.state === 'LISTEN' || r.state === 'open' ? '—' : duration(r.age)]),
          el(this.doc, 'td', {}, [duration(r.remaining)]),
        ]),
      );
    }
    t.appendChild(tb);
    p.body.appendChild(el(this.doc, 'div', { class: 'st-scroll' }, [t]));
    return d.rows.length;
  }

  /** A firewall's sessions, with its policy and timeouts in effect at the top. */
  private fwPanel(p: Panel): number {
    const d = p.data() as FwData;
    const timers = el(this.doc, 'dl', { class: 'st-timers' });
    for (const x of d.timers) timers.appendChild(el(this.doc, 'div', {}, [el(this.doc, 'dt', {}, [x.label]), el(this.doc, 'dd', {}, [timerText(x)])]));
    p.body.appendChild(timers);
    const cols = ['Protocol', 'Flow', 'State', 'Permitted by', 'Age', 'Expires in'];
    const t = el(this.doc, 'table', { class: 'st-table' });
    t.appendChild(el(this.doc, 'caption', {}, [`Session table of ${p.dev}`]));
    t.appendChild(this.head(cols));
    const tb = el(this.doc, 'tbody');
    if (!d.rows.length) tb.appendChild(el(this.doc, 'tr', {}, [el(this.doc, 'td', { colspan: String(cols.length), class: 'muted' }, ['No session: the model’s relations pass without one; traffic its allow list permits opens one.'])]));
    for (const r of d.rows) {
      tb.appendChild(
        el(this.doc, 'tr', { 'data-state': r.state }, [
          el(this.doc, 'td', {}, [r.proto.toUpperCase()]),
          el(this.doc, 'td', { class: 'mono' }, [r.flow]),
          el(this.doc, 'td', {}, [r.state]),
          el(this.doc, 'td', {}, [r.rule]),
          el(this.doc, 'td', {}, [duration(r.age)]),
          el(this.doc, 'td', {}, [duration(r.remaining)]),
        ]),
      );
    }
    t.appendChild(tb);
    p.body.appendChild(el(this.doc, 'div', { class: 'st-scroll' }, [t]));
    return d.rows.length;
  }

  /** The packet inspector: a frame's headers, layer by layer. */
  private packet(d: PacketData): HTMLElement {
    const h = d.hdr;
    const box = el(this.doc, 'div', { class: 'pi' });
    box.appendChild(el(this.doc, 'p', { class: 'small' }, [`${h.label} — ${h.cast}; ${d.where}`]));
    const layer = (title: string, rows: Array<[string, string]>): void => {
      const dl = el(this.doc, 'dl');
      for (const [k, v] of rows) dl.appendChild(el(this.doc, 'div', { style: 'display:contents' }, [el(this.doc, 'dt', {}, [k]), el(this.doc, 'dd', { class: /MAC|address|Sender|Target|Source|Destination/.test(k) ? 'mono' : '' }, [v])]));
      box.appendChild(el(this.doc, 'section', { class: 'pi-layer' }, [el(this.doc, 'h4', {}, [title]), dl]));
    };
    layer('Layer 2 – Ethernet', [
      ['Source MAC', h.l2.src],
      ['Destination MAC', `${h.l2.dst} (${h.l2.dstNote})`],
      ['VLAN tag', h.l2.vlan === null ? 'none (untagged on this cable)' : `802.1Q, VLAN ${h.l2.vlan}`],
      ['EtherType', h.l2.ethertype],
      ['Frame size', `${h.l2.bytes} bytes`],
    ]);
    if (h.arp) layer('ARP', [['Operation', h.arp.op], ['Sender MAC', h.arp.senderMac], ['Sender IP address', h.arp.senderIp], ['Target MAC', h.arp.targetMac], ['Target IP address', h.arp.targetIp]]);
    h.l3.forEach((ip, i) => {
      const rows: Array<[string, string]> = [
        ['Source address', ip.src],
        ['Destination address', ip.dst],
        [ip.version === 4 ? 'TTL' : 'Hop limit', String(ip.ttl)],
        ['Protocol', ip.proto],
        ['Length', `${ip.len} bytes`],
      ];
      if (ip.version === 4) rows.splice(3, 0, ['Don’t Fragment', ip.df ? 'set' : 'not set']);
      if (ip.frag) rows.push(['Fragment', ip.frag]);
      if (ip.encap) rows.push(['Carries', `${ip.encap}, with the packet below inside`]);
      layer(`Layer 3 – IPv${ip.version}${h.l3.length > 1 ? (i === 0 ? ' (outer)' : i === h.l3.length - 1 ? ' (inner)' : ` (${i + 1})`) : ''}`, rows);
    });
    const l4 = h.l4;
    if (l4) {
      const rows: Array<[string, string]> = [];
      if (l4.proto === 'icmp') {
        rows.push(['Type and code', `${l4.icmpType} / ${l4.icmpCode}${l4.icmpName ? ' — ' + l4.icmpName : ''}`]);
        if (l4.echoId !== undefined) rows.push(['Identifier, sequence', `${l4.echoId}, ${l4.echoSeq}`]);
        if (l4.mtu) rows.push(['Next-hop MTU', String(l4.mtu)]);
        if (l4.quote) rows.push(['Quoted header', `${l4.quote.src} → ${l4.quote.dst} ${l4.quote.proto.toUpperCase()}${l4.quote.sport !== undefined ? ' ' + l4.quote.sport + ' → ' + l4.quote.dport : ''}, TTL ${l4.quote.ttl}`]);
      } else if (l4.proto === 'other') rows.push(['IP protocol', String(l4.num)]);
      else {
        rows.push(['Source port', String(l4.sport)], ['Destination port', String(l4.dport)]);
        if (l4.flags) rows.push(['Flags', l4.flags.join(', ')]);
        if (l4.seq !== undefined && l4.proto === 'tcp') rows.push(['Sequence, acknowledgement', `${l4.seq}${l4.ack !== undefined ? ', ' + l4.ack : ''}`]);
      }
      layer(`Layer 4 – ${l4.proto === 'icmp' ? (h.l3.length && h.l3[h.l3.length - 1].version === 6 ? 'ICMPv6' : 'ICMP') : l4.proto === 'other' ? 'protocol' : l4.proto.toUpperCase()}`, rows);
    }
    layer('Payload', [['Carries', h.payload]]);
    return box;
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

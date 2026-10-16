/**
 * The inside of a host's box in the physical view: its virtual switches
 * and container networks, the guests on them, and the wires between them.
 * Pure geometry from the model, relative to the interior's top left corner,
 * so the layout (which reserves the room) and the renderer (which draws it)
 * agree, and the result is deterministic.
 *
 * The interior is a stack of lanes, one per virtual switch and per
 * container network (bridge, macvlan, ipvlan, overlay), then one for the
 * VMs bound to a host port by passthrough and one for guests without a
 * network of their own (a container on the host or a none network):
 *
 *   ┌ bar: "vSwitch0 · Standard vSwitch · active / standby"   (its title)
 *   │  [Mgmt · VLAN 99] [Servers · VLAN 10] [VGT · guest tagging] …  (port group pills)
 *   ├ band: the horizontal tracks of the wires to the pills
 *   └ row: the guests (VM / container boxes, a host's own vNICs as entries),
 *          each followed by its channel: the vertical tracks of its wires
 *
 * A wire leaves its vNIC's (or veth's) entry at the entry's right edge, runs
 * in the guest's channel up to its track in the band, along the band to its
 * pill (a container: to its bar) and up into it. A wire to another lane
 * (a VM with NICs on two virtual switches) runs through the gutter on the
 * right. The gutters on both sides also carry the wires from the host's
 * ports (uplinks to their bar, passthrough ports to their vNIC, a macvlan
 * network's parent port to its bar); which side follows from where the
 * port is (renderer). A VM that runs containers holds the same kind of
 * interior inside its own box.
 */
import { DeviceBody, ENTRY_GAP, ENTRY_MARGIN, EntryText, deviceBody, entriesSize, entryBox } from './sizes';
import { textWidth } from './text';
import { interfaceEntry, IfaceEntry } from '../model/addresses';
import { deviceSubtitle } from '../model/device-types';
import { Device, Interface, Model, ifaceKey } from '../model/types';
import { cnetRef, guestsOf, portGroupL2, portGroupRef, vnicPortGroup, vethNetwork, vswitchRef } from '../model/virtual';
import { TEAMINGS, VSWITCH_TYPES } from '../model/types';

export const BAR_FONT = 10;
export const PILL_FONT = 9.5;
const PILL_H = 16;
const PILL_PAD = 6;
const PILL_GAP = 5;
const BAR_PAD = 5;
const BAR_TITLE_H = 13;
const TRACK = 4;
const BAND_PAD = 5;
const ROW_GAP = 10;
const LANE_GAP = 10;
const GUTTER_PAD = 6;
const CHANNEL_PAD = 6;
const LANE_TITLE_H = 14;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** A port group in its bar (or, for a container network's bar, none: the bar is the target). */
export interface VPill extends Rect {
  ref: string;
  name: string;
  /** its VLAN mode in words: "VLAN 10", "VLANs 10, 20 · native 10", "guest tagging" */
  sub: string;
}

/** A virtual switch's or a container network's bar. */
export interface VBar extends Rect {
  ref: string;
  /** what selecting its title selects (the bridge interface of a bridge network; the switch itself) */
  titleRef: string;
  title: string;
  pills: VPill[];
}

/** A guest's (or a host vNIC's) entry: what a wire attaches to. */
export interface VEntry extends Rect {
  /** the interface's ref */
  ref: string;
  item: IfaceEntry;
  /** the pill or bar it is attached to (none: no wire inside the host) */
  target?: string;
  /** the passthrough port of the host it is bound to */
  passthrough?: string;
}

/** A guest's box in the interior, or a host's own vNIC (an entry without a box). */
export interface VGuest extends Rect {
  id: string;
  ref: string;
  kind: 'vm' | 'container' | 'hostif';
  body?: DeviceBody;
  sub: string;
  type: string;
  label: string;
  layer3?: boolean;
  entries: VEntry[];
  /** a VM that runs containers: its own interior, at (x + innerX, y + innerY) */
  inner?: VInterior;
  innerX: number;
  innerY: number;
  /** the right end of its channel (where the next guest starts) */
  channelW: number;
}

export interface VLane extends Rect {
  kind: 'vswitch' | 'cnet' | 'pass' | 'plain';
  /** the bar of a virtual switch or container network */
  bar?: VBar;
  /** the title of a lane without a bar ("Passthrough", "Host network") */
  title?: string;
  band: Rect;
  guests: VGuest[];
}

/** A wire inside the interior (relative points), from an entry to a pill or bar. */
export interface VWire {
  from: string;
  to: string;
  pts: Pt[];
}

/**
 * A wire from a host port to the interior, finished by the renderer (it
 * knows where the port is): to a bar's end, or to a passthrough vNIC's
 * entry. `track` is its track in a gutter (the same index on both sides);
 * `anchor` the point it ends at; `via` the points after the gutter.
 */
export interface VExternal {
  kind: 'uplink' | 'passthrough' | 'parent';
  port: string;
  to: string;
  track: number;
  anchor: Pt;
  /** for a passthrough: from the gutter to the entry (the band track, the channel, the entry) */
  via: (side: 'left' | 'right') => Pt[];
  /** the bar is the interior's first lane's (a port above it can drop straight in) */
  top: boolean;
}

export interface VInterior {
  w: number;
  h: number;
  /** each gutter's width (the content starts at x = gutter) */
  gutter: number;
  lanes: VLane[];
  wires: VWire[];
  external: VExternal[];
}

function pillText(name: string, sub: string): number {
  return Math.max(textWidth(name, PILL_FONT), textWidth(sub, PILL_FONT));
}

/** The facts a guest's entry adds: what the vNIC is attached to (written, not only drawn). */
function attachLine(model: Model, i: Interface): string {
  if (i.type === 'vnic') {
    if (i.passthrough !== undefined) return `passthrough ${i.passthrough}${i.vf !== undefined ? ` vf ${i.vf}` : ''}`;
    const x = vnicPortGroup(model, i);
    return x ? `on ${x.pg.name}` : i.portGroup !== undefined ? `on ${i.portGroup}` : '';
  }
  if (i.type === 'veth') {
    const x = vethNetwork(model, i);
    if (x && x.net.driver === 'host') return 'host network';
    if (x && x.net.driver === 'none') return 'no network';
    return i.network !== undefined ? `on ${i.network}` : '';
  }
  return '';
}

/** A guest's entries in the physical view: its vNICs or veths (always: they are what it is attached by) and their VLAN subinterfaces. */
function guestEntries(model: Model, d: Device): IfaceEntry[] {
  const out: IfaceEntry[] = [];
  const ifs = d.logical.filter((i) => i.type === 'vnic' || i.type === 'veth' || (i.type === 'virtual' && i.id.indexOf('.') > 0));
  ifs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const i of ifs) {
    const e = interfaceEntry(model, i);
    const al = attachLine(model, i);
    if (al) {
      e.lines = [al].concat(e.lines);
      e.fields = [{ field: i.type === 'vnic' ? (i.passthrough !== undefined ? 'passthrough' : 'port_group') : 'network', value: '' }].concat(e.fields);
    }
    out.push(e);
  }
  return out;
}

const cache = new WeakMap<Model, Map<string, VInterior | null>>();

/** The interior of a host (a hypervisor, a container host, a VM that runs containers); null when it has none. */
export function hostInterior(model: Model, hostId: string): VInterior | null {
  let c = cache.get(model);
  if (!c) cache.set(model, (c = new Map()));
  if (c.has(hostId)) return c.get(hostId) as VInterior | null;
  const host = model.index.devices.get(hostId);
  const r = host ? build(model, host, 0) : null;
  c.set(hostId, r);
  return r;
}

/** Does a host's box hold anything (virtual switches, container networks, guests)? */
export function hasInterior(d: Device): boolean {
  return !!(d.hypervisor && d.hypervisor.vswitches.length) || !!(d.containerEngine && d.containerEngine.networks.length);
}

function build(model: Model, host: Device, depth: number): VInterior | null {
  if (!hasInterior(host) || depth > 3) return null;
  // ---- the lanes: virtual switches, container networks with a segment of their own
  type LaneSpec = { kind: VLane['kind']; ref: string; titleRef: string; title: string; pills: Array<{ ref: string; name: string; sub: string }>; guests: VGuest[] };
  const lanes: LaneSpec[] = [];
  const laneOf = new Map<string, number>();
  if (host.hypervisor) {
    for (const vs of host.hypervisor.vswitches) {
      if (!vs.name) continue;
      const type = (VSWITCH_TYPES.find((x) => x.id === vs.type) || { label: '' }).label;
      const team = vs.uplinks.length ? (TEAMINGS.find((x) => x.id === vs.teaming) || { label: '' }).label.replace(/ \(.*\)$/, '').toLowerCase() : 'internal';
      const pills = vs.portGroups
        .filter((pg) => !!pg.name)
        .map((pg) => {
          const l = portGroupL2(pg);
          const sub = l.kind === 'guest' ? 'guest tagging' : l.kind === 'access' ? `VLAN ${l.vlans[0]}` : `VLANs ${l.vlans.join(',')}${l.native !== undefined ? ` · N ${l.native}` : ''}`;
          return { ref: portGroupRef(host.id, pg.name), name: pg.name, sub };
        });
      const ref = vswitchRef(host.id, vs.name);
      laneOf.set(ref, lanes.length);
      for (const p of pills) laneOf.set(p.ref, lanes.length);
      lanes.push({ kind: 'vswitch', ref, titleRef: ref, title: [vs.name, type, team].filter((x) => x).join(' · '), pills, guests: [] });
    }
  }
  if (host.containerEngine) {
    for (const n of host.containerEngine.networks) {
      if (!n.name || !n.driver || n.driver === 'host' || n.driver === 'none') continue;
      const ref = cnetRef(host.id, n.name);
      const what = n.driver === 'bridge' ? `${n.iface || n.name} · bridge${n.subnet ? ' ' + n.subnet : ''}${n.nat ? ' · NAT' : n.nat === false ? ' · routed' : ''}` : `${n.name} · ${n.driver}${n.parent ? ' on ' + n.parent : ''}${n.subnet ? ' ' + n.subnet : ''}`;
      laneOf.set(ref, lanes.length);
      lanes.push({ kind: 'cnet', ref, titleRef: n.driver === 'bridge' && n.iface ? `iface:${host.id}:${n.iface}` : ref, title: what, pills: [], guests: [] });
    }
  }
  const pass: VGuest[] = [];
  const plain: VGuest[] = [];
  // ---- the guests, each in the lane of its first attachment
  const guestBox = (d: Device): VGuest => {
    const sub = deviceSubtitle(d.type, d.layer3);
    const body = deviceBody(d.label, sub, 0, 0);
    const items = guestEntries(model, d);
    const [ew, eh] = entriesSize(items);
    const inner = d.type === 'vm' && d.containerEngine ? build(model, d, depth + 1) : null;
    const w = Math.max(body.w, ew ? ew + 2 * ENTRY_MARGIN : 0, inner ? inner.w + 2 * ENTRY_MARGIN : 0);
    const innerY = body.h + (eh ? eh + ENTRY_MARGIN : 0);
    const h = innerY + (inner ? inner.h + ENTRY_MARGIN : 0) + (eh || inner ? ENTRY_MARGIN : 0);
    let ey = body.h;
    const entries: VEntry[] = items.map((it) => {
      const b = entryBox(it);
      const e: VEntry = { ref: it.ref, item: it, x: ENTRY_MARGIN, y: ey, w: w - 2 * ENTRY_MARGIN, h: b.h };
      ey += b.h + ENTRY_GAP;
      const i = model.index.interfaces.get(ifaceKey(d.id, it.id));
      if (i && i.type === 'vnic') {
        const x = vnicPortGroup(model, i);
        if (x && x.host === host) e.target = portGroupRef(host.id, x.pg.name);
        else if (i.passthrough !== undefined) e.passthrough = i.passthrough;
      }
      if (i && i.type === 'veth') {
        const x = vethNetwork(model, i);
        if (x && x.owner === host && x.net.driver !== 'host' && x.net.driver !== 'none') e.target = cnetRef(host.id, x.net.name);
      }
      return e;
    });
    return { id: d.id, ref: 'device:' + d.id, kind: d.type === 'vm' ? 'vm' : 'container', body, sub, type: d.type, label: d.label, layer3: d.layer3, entries, inner: inner || undefined, innerX: ENTRY_MARGIN, innerY, x: 0, y: 0, w, h, channelW: 0 };
  };
  // the host's own vNICs (host interfaces): an entry each, in the lane of its port group
  const hostIfs = host.hypervisor ? host.logical.filter((i) => i.type === 'vnic').sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
  for (const i of hostIfs) {
    const it = interfaceEntry(model, i);
    const al = attachLine(model, i);
    if (al) it.lines = [al].concat(it.lines);
    if (al) it.fields = [{ field: 'port_group', value: '' }].concat(it.fields);
    if (i.role) {
      it.lines.splice(1, 0, i.role);
      it.fields.splice(1, 0, { field: 'role', value: '' });
    }
    const b = entryBox(it);
    const x = vnicPortGroup(model, i);
    const target = x ? portGroupRef(host.id, x.pg.name) : undefined;
    const g: VGuest = { id: i.id, ref: it.ref, kind: 'hostif', sub: '', type: '', label: i.id, entries: [{ ref: it.ref, item: it, target, x: 0, y: 0, w: b.w, h: b.h }], innerX: 0, innerY: 0, x: 0, y: 0, w: b.w, h: b.h, channelW: 0 };
    const li = target !== undefined ? laneOf.get(target) : undefined;
    if (li !== undefined) lanes[li].guests.push(g);
    else plain.push(g);
  }
  for (const d of guestsOf(model, host.id)) {
    const g = guestBox(d);
    const first = g.entries.find((e) => e.target !== undefined);
    const li = first ? laneOf.get(first.target as string) : undefined;
    if (li !== undefined) lanes[li].guests.push(g);
    else if (g.entries.some((e) => e.passthrough !== undefined)) pass.push(g);
    else plain.push(g);
  }
  const specs: LaneSpec[] = lanes.slice();
  if (pass.length) specs.push({ kind: 'pass', ref: '', titleRef: '', title: 'Passthrough (bound to a host port)', pills: [], guests: pass });
  if (plain.length) specs.push({ kind: 'plain', ref: '', titleRef: '', title: host.containerEngine && !host.hypervisor ? 'Host network / no network' : 'Not attached here', pills: [], guests: plain });

  // ---- the wires: count them first (they need tracks in bands, channels and gutters)
  const targetLane = (t: string): number => (laneOf.has(t) ? (laneOf.get(t) as number) : -1);
  let crossTracks = 0;
  for (let li = 0; li < specs.length; li++) for (const g of specs[li].guests) for (const e of g.entries) if (e.target !== undefined && targetLane(e.target) !== li) crossTracks++;
  const externals: Array<{ kind: VExternal['kind']; port: string; to: string; lane: number; guest?: VGuest; entry?: VEntry }> = [];
  if (host.hypervisor) {
    for (const vs of host.hypervisor.vswitches) {
      if (!vs.name) continue;
      for (const u of vs.uplinks) {
        const i = model.index.interfaces.get(ifaceKey(host.id, u));
        if (!i) continue;
        for (const p of i.members.length ? i.members : [u]) externals.push({ kind: 'uplink', port: p, to: vswitchRef(host.id, vs.name), lane: targetLane(vswitchRef(host.id, vs.name)) });
      }
    }
  }
  if (host.containerEngine) {
    for (const n of host.containerEngine.networks) {
      if (!n.parent || (n.driver !== 'macvlan' && n.driver !== 'ipvlan')) continue;
      const p = model.index.interfaces.get(ifaceKey(host.id, n.parent));
      if (!p || p.type !== 'physical') continue;
      externals.push({ kind: 'parent', port: n.parent, to: cnetRef(host.id, n.name), lane: targetLane(cnetRef(host.id, n.name)) });
    }
  }
  const passLane = specs.findIndex((s) => s.kind === 'pass');
  for (const g of pass) for (const e of g.entries) if (e.passthrough !== undefined && model.index.interfaces.has(ifaceKey(host.id, e.passthrough))) externals.push({ kind: 'passthrough', port: e.passthrough, to: e.ref, lane: passLane, guest: g, entry: e });
  const gutter = GUTTER_PAD + TRACK * (externals.length + crossTracks);

  // ---- sizes: each lane's bar, band and row
  const laneTitleW = (s: LaneSpec): number => Math.ceil(textWidth(s.title, BAR_FONT)) + 2 * BAR_PAD;
  // a guest's channel: a track per wire leaving it (in its own lane or to another one; a passthrough arriving)
  const wiresOf = (g: VGuest): number => g.entries.filter((e) => e.target !== undefined || e.passthrough !== undefined).length;
  for (const s of specs) for (const g of s.guests) g.channelW = CHANNEL_PAD + TRACK * wiresOf(g);
  const rowW = (s: LaneSpec): number => s.guests.reduce((a, g, k) => a + (k ? ROW_GAP : 0) + g.w + g.channelW, 0);
  const pillsMinW = (s: LaneSpec): number => s.pills.reduce((m, p) => Math.max(m, pillText(p.name, p.sub) + 2 * PILL_PAD), 0) + 2 * BAR_PAD;
  const contentW = Math.max(120, ...specs.map((s) => Math.max(laneTitleW(s), rowW(s), pillsMinW(s))));
  // pills flow in their bar, wrapping at the content width
  const outLanes: VLane[] = [];
  const wires: VWire[] = [];
  let y = 0;
  /** band tracks used per lane, in order of assignment */
  const bandUse: number[] = specs.map(() => 0);
  const bandNeed: number[] = specs.map(() => 0);
  for (let li = 0; li < specs.length; li++) for (const g of specs[li].guests) for (const e of g.entries) {
    if (e.target === undefined) continue;
    bandNeed[li]++;
    const tl = targetLane(e.target);
    if (tl >= 0 && tl !== li) bandNeed[tl]++;
  }
  if (passLane >= 0) bandNeed[passLane] += externals.filter((x) => x.kind === 'passthrough').length;
  specs.forEach((s, li) => {
    const x0 = gutter;
    let bar: VBar | undefined;
    let barH = 0;
    if (s.kind === 'vswitch' || s.kind === 'cnet') {
      const pills: VPill[] = [];
      let px = BAR_PAD;
      let py = BAR_PAD + BAR_TITLE_H;
      for (const p of s.pills) {
        const w = Math.ceil(pillText(p.name, p.sub)) + 2 * PILL_PAD;
        if (px > BAR_PAD && px + w > contentW - BAR_PAD) {
          px = BAR_PAD;
          py += PILL_H * 2 + PILL_GAP;
        }
        pills.push({ ref: p.ref, name: p.name, sub: p.sub, x: x0 + px, y: y + py, w, h: PILL_H * 2 });
        px += w + PILL_GAP;
      }
      barH = s.pills.length ? py + PILL_H * 2 + BAR_PAD : BAR_PAD * 2 + BAR_TITLE_H;
      bar = { ref: s.ref, titleRef: s.titleRef, title: s.title, pills, x: x0, y, w: contentW, h: barH };
    } else barH = LANE_TITLE_H;
    const bandH = bandNeed[li] ? BAND_PAD * 2 + TRACK * (bandNeed[li] - 1) : BAND_PAD;
    const band: Rect = { x: x0, y: y + barH, w: contentW, h: bandH };
    // the row of guests
    let gx = x0;
    const rowY = y + barH + bandH;
    let rowH = 0;
    for (const g of s.guests) {
      g.x = gx;
      g.y = rowY;
      gx += g.w + g.channelW + ROW_GAP;
      rowH = Math.max(rowH, g.h);
    }
    const lane: VLane = { kind: s.kind, bar, title: bar ? undefined : s.title, band, guests: s.guests, x: x0, y, w: contentW, h: barH + bandH + rowH };
    outLanes.push(lane);
    y += lane.h + LANE_GAP;
  });
  const h = Math.max(0, y - LANE_GAP);
  const w = contentW + 2 * gutter;
  // ---- the wires inside (entry → channel → band → pill or bar)
  const targetPt = (t: string): Pt | undefined => {
    for (const l of outLanes) {
      if (!l.bar) continue;
      if (l.bar.ref === t) return { x: l.bar.x + l.bar.w / 2, y: l.bar.y + l.bar.h };
      const p = l.bar.pills.find((x) => x.ref === t);
      if (p) return { x: p.x + p.w / 2, y: p.y + p.h };
    }
    return undefined;
  };
  let crossK = 0;
  outLanes.forEach((l, li) => {
    for (const g of l.guests) {
      let ck = 0;
      for (const e of g.entries) {
        if (e.target === undefined && e.passthrough === undefined) continue;
        const cx = g.x + g.w + CHANNEL_PAD / 2 + TRACK * ck++;
        if (e.target === undefined) {
          // a passthrough: the external wire finishes it (it needs this channel track)
          (e as VEntry & { channelX?: number }).channelX = cx;
          continue;
        }
        const ey = g.y + e.y + e.h / 2;
        const ex = g.x + e.x + e.w;
        const bandY = l.band.y + BAND_PAD + TRACK * bandUse[li]++;
        const tp = targetPt(e.target);
        if (!tp) continue;
        const tl = targetLane(e.target);
        if (tl === li || tl < 0) {
          // straight up into its own lane's bar, unless the target sits to the right of the channel: then along the band
          wires.push({ from: e.ref, to: e.target, pts: [{ x: ex, y: ey }, { x: cx, y: ey }, { x: cx, y: bandY }, { x: tp.x, y: bandY }, { x: tp.x, y: tp.y }] });
        } else {
          // to another lane: through the right gutter
          const gx = w - gutter + GUTTER_PAD / 2 + TRACK * (externals.length + crossK++);
          const tbY = outLanes[tl].band.y + BAND_PAD + TRACK * bandUse[tl]++;
          wires.push({ from: e.ref, to: e.target, pts: [{ x: ex, y: ey }, { x: cx, y: ey }, { x: cx, y: bandY }, { x: gx, y: bandY }, { x: gx, y: tbY }, { x: tp.x, y: tbY }, { x: tp.x, y: tp.y }] });
        }
      }
    }
  });
  // ---- the external wires' ends (the renderer adds the port and the gutter)
  const external: VExternal[] = externals.map((x, k) => {
    if (x.kind === 'passthrough' && x.guest && x.entry) {
      const l = outLanes[x.lane];
      const g = x.guest;
      const e = x.entry;
      const bandY = l.band.y + BAND_PAD + TRACK * bandUse[x.lane]++;
      const cx = (e as VEntry & { channelX?: number }).channelX as number;
      const ey = g.y + e.y + e.h / 2;
      const anchor = { x: g.x + e.x + e.w, y: ey };
      return { kind: x.kind, port: x.port, to: x.to, track: k, anchor, top: false, via: () => [{ x: cx, y: bandY }, { x: cx, y: ey }, anchor] };
    }
    const l = x.lane >= 0 ? outLanes[x.lane] : undefined;
    const b = l && l.bar ? l.bar : { x: gutter, y: 0, w: contentW, h: 20 };
    const anchorL = { x: b.x, y: b.y + Math.min(b.h - 4, BAR_PAD + BAR_TITLE_H / 2 + 2 * (k % 3)) };
    const anchorR = { x: b.x + b.w, y: anchorL.y };
    return { kind: x.kind, port: x.port, to: x.to, track: k, anchor: anchorL, top: x.lane === 0, via: (side) => [side === 'left' ? anchorL : anchorR] };
  });
  return { w, h, gutter, lanes: outLanes, wires, external };
}

/** Every guest box of an interior and its nested ones, with their absolute offsets added (for hit tests and lists). */
export function interiorGuests(v: VInterior, ox = 0, oy = 0): Array<{ g: VGuest; x: number; y: number }> {
  const out: Array<{ g: VGuest; x: number; y: number }> = [];
  for (const l of v.lanes) {
    for (const g of l.guests) {
      out.push({ g, x: ox + g.x, y: oy + g.y });
      if (g.inner) out.push(...interiorGuests(g.inner, ox + g.x + g.innerX, oy + g.y + g.innerY));
    }
  }
  return out;
}

/** The size an interior adds to its host's box, [w, h] ([0, 0]: none). */
export function interiorSize(model: Model, hostId: string): [number, number] {
  const v = hostInterior(model, hostId);
  return v ? [v.w, v.h + ENTRY_MARGIN] : [0, 0];
}

export type { EntryText };

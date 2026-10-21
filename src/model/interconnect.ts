/**
 * Non-IP physical interconnects (`interconnects:`) and opaque ports
 * (`stack: opaque`): USB, serial lines, buses, backplanes and fabrics.
 *
 * NetAtlas models them physically only: which ports are connected, by what
 * technology (a name and a version as text, a suggestion list being only a
 * help), carrying what protocol if any, the participants' roles and which
 * way data may go. No protocol of them is simulated — no enumeration,
 * addressing, arbitration, framing, acknowledgment or electrical
 * behaviour; the simulation's "Send illustrative data" moves abstract data
 * along the modelled connections (analysis/sim/opaque.ts).
 *
 *   An opaque port is never an Interface (model/types.ts OpaquePort): the
 *   IP side — addressing, Layer 2, routing, policy, the protocol
 *   simulation's network — cannot take one. A device may have both kinds.
 *   Point to point: exactly two ports. Shared: one medium with several
 *   attachments (a bus is one interconnect, never a mesh of cables).
 *   Roles belong to an attachment, never to the device: Controller, Target,
 *   Controller and target, Peer, Monitor (receive only). Data direction is
 *   each attachment's (send, receive, both); the order of the endpoints
 *   means nothing. "Both" is not full duplex and makes no replies.
 *   A System may pass data between explicitly grouped opaque ports
 *   (`opaque_transit:`), of one technology; nothing else joins two
 *   interconnects (not a chassis, not a device, not a technology name).
 *
 * DOM-free.
 */
import { Device, IcAccess, IcAttachment, IcData, IcRole, IcTopology, Interconnect, OpaquePort } from './types';
import { Support } from './support';

export const IC_TOPOLOGIES: readonly IcTopology[] = ['point_to_point', 'shared'];
export const IC_ACCESS: readonly IcAccess[] = ['peer', 'controller_target'];
export const IC_ROLES: readonly IcRole[] = ['controller', 'target', 'controller_target', 'peer', 'monitor'];
export const IC_DATA: readonly IcData[] = ['both', 'send', 'receive'];

export const TOPOLOGY_TEXT: { [k in IcTopology]: string } = { point_to_point: 'Point to point', shared: 'Shared medium (bus)' };
export const ACCESS_TEXT: { [k in IcAccess]: string } = { peer: 'Peers', controller_target: 'Controller / Target (Master / Slave)' };
export const ROLE_TEXT: { [k in IcRole]: string } = { controller: 'Controller (Master)', target: 'Target (Slave)', controller_target: 'Controller and target', peer: 'Peer', monitor: 'Monitor (receives only)' };
/** compact role badges for the diagram */
export const ROLE_BADGE: { [k in IcRole]: string } = { controller: 'C', target: 'T', controller_target: 'C/T', peer: 'P', monitor: 'M' };
export const DATA_TEXT: { [k in IcData]: string } = { both: 'Sends and receives', send: 'Sends only', receive: 'Receives only' };

/**
 * Suggestions for the editor — configuration helpers only, never a protocol
 * engine or a compatibility statement: a technology, its usual topology and
 * access model, and common versions. Anything else may be written.
 */
export const TECHNOLOGY_SUGGESTIONS: ReadonlyArray<{ name: string; topology: IcTopology; access: IcAccess; versions: string[] }> = [
  { name: 'USB', topology: 'point_to_point', access: 'controller_target', versions: ['2.0', '3.2', '4'] },
  { name: 'RS-232', topology: 'point_to_point', access: 'peer', versions: [] },
  { name: 'RS-422', topology: 'point_to_point', access: 'peer', versions: [] },
  { name: 'RS-485', topology: 'shared', access: 'controller_target', versions: [] },
  { name: 'CAN', topology: 'shared', access: 'peer', versions: ['2.0B', 'FD', 'XL'] },
  { name: 'I²C', topology: 'shared', access: 'controller_target', versions: ['Standard', 'Fast', 'Fast-mode Plus'] },
  { name: 'SPI', topology: 'shared', access: 'controller_target', versions: [] },
  { name: 'VME', topology: 'shared', access: 'controller_target', versions: ['VME64', 'VME64x'] },
  { name: 'PCIe', topology: 'point_to_point', access: 'controller_target', versions: ['3.0', '4.0', '5.0'] },
  { name: 'SRIO', topology: 'point_to_point', access: 'peer', versions: ['2.1', '3.1'] },
  { name: 'MIL-STD-1553', topology: 'shared', access: 'controller_target', versions: ['B'] },
  { name: 'ARINC 429', topology: 'shared', access: 'peer', versions: [] },
];
export const PROTOCOL_SUGGESTIONS: readonly string[] = ['Modbus RTU', 'CANopen', 'J1939', 'SCPI', 'PROFIBUS DP', 'NMEA 0183'];

/** The technology as one text: "USB 2.0", "CAN FD", "Custom revision B". */
export function technologyText(ic: Pick<Interconnect, 'technology'>): string {
  return ic.technology.version ? `${ic.technology.name} ${ic.technology.version}` : ic.technology.name;
}

/** Can an attachment send / receive data on its interconnect? (A monitor only receives.) */
export function sends(a: IcAttachment): boolean {
  return a.role !== 'monitor' && a.data !== 'receive';
}
export function receives(a: IcAttachment): boolean {
  return a.data !== 'send';
}
/** Can an attachment initiate transfers on an interconnect of its access model? */
export function initiates(ic: Interconnect, a: IcAttachment): boolean {
  return a.role !== 'monitor' && (ic.access === 'peer' || a.role === 'controller' || a.role === 'controller_target');
}

/**
 * The data direction of a point-to-point interconnect as an arrow from its
 * first endpoint's side ("→" a to b, "←" b to a, "↔" both, "" none), from
 * the attachments' own directions — never from their order alone.
 */
export function p2pArrow(ic: Interconnect): string {
  if (ic.endpoints.length !== 2) return '';
  const [a, b] = ic.endpoints;
  const ab = sends(a) && receives(b);
  const ba = sends(b) && receives(a);
  return ab && ba ? '↔' : ab ? '→' : ba ? '←' : '';
}

/** The compact label on the diagram: "USB 2.0 ↔", "RS-232 →", "CAN FD" (a bus). */
export function interconnectLabel(ic: Interconnect): string {
  const arrow = ic.topology === 'point_to_point' ? p2pArrow(ic) : '';
  return (ic.label ? ic.label : technologyText(ic)) + (arrow ? ' ' + arrow : '');
}

/** The group a bus's bar is drawn in: its participants' group when they all share one, else none. */
export function busGroup(index: { devices: Map<string, Device> }, ic: Interconnect): string | null {
  const gs = Array.from(new Set(ic.endpoints.map((e) => (index.devices.get(e.device) || { group: undefined }).group || '')));
  return gs.length === 1 && gs[0] ? gs[0] : null;
}

export function portKeyOf(device: string, port: string): string {
  return device + ':' + port;
}

/** The index of a model's opaque side: its interconnects, its opaque ports, and which interconnect each port is attached to. */
export function opaqueIndex(devices: Device[], interconnects: Interconnect[]): { interconnects: Map<string, Interconnect>; opaquePorts: Map<string, OpaquePort>; portInterconnect: Map<string, string> } {
  const opaquePorts = new Map<string, OpaquePort>();
  for (const d of devices) for (const p of d.opaquePorts) opaquePorts.set(portKeyOf(d.id, p.id), p);
  const portInterconnect = new Map<string, string>();
  for (const ic of interconnects) for (const e of ic.endpoints) if (!portInterconnect.has(portKeyOf(e.device, e.port))) portInterconnect.set(portKeyOf(e.device, e.port), ic.id);
  return { interconnects: new Map(interconnects.map((ic) => [ic.id, ic] as [string, Interconnect])), opaquePorts, portInterconnect };
}

/**
 * The interconnects of a part of a model (a filter, an execution scope, a
 * collapsed view): each with its attachments on the devices kept; one with
 * fewer than two left is left out (a point-to-point one needs both).
 */
export function keptInterconnects(interconnects: Interconnect[], keep: (device: string) => boolean): Interconnect[] {
  const out: Interconnect[] = [];
  for (const ic of interconnects) {
    const eps = ic.endpoints.filter((e) => keep(e.device));
    if (eps.length < 2 || (ic.topology === 'point_to_point' && eps.length !== ic.endpoints.length)) continue;
    if (eps.length === ic.endpoints.length) {
      out.push(ic);
      continue;
    }
    // its traffic: what starts and comes from the part kept, to the recipients kept
    const dev = (k: string): string => k.slice(0, k.indexOf(':'));
    const traffic = ic.traffic
      .filter((x) => keep(dev(x.initiator)) && keep(dev(x.from)))
      .map((x) => ({ ...x, to: x.to.filter((k) => keep(dev(k))) }))
      .filter((x) => x.to.length > 0);
    out.push({ ...ic, endpoints: eps, traffic });
  }
  return out;
}

/**
 * Whether a participant may move data to another on one interconnect, with
 * an initiator (the attachment that starts the transfer): null, or why not.
 * The sender must send and the recipient receive; with Controller / Target
 * access the initiator must be a controller and one end of the data its
 * own (a write: from it; a read: to it, from a target) — a target is not
 * receive-only, and several controllers are allowed (no arbitration is
 * simulated); between peers the sender initiates its own data.
 */
export function hopRule(ic: Interconnect, from: IcAttachment, to: IcAttachment, initiator: IcAttachment): string | null {
  const name = (a: IcAttachment): string => `${a.device}:${a.port}`;
  if (from === to) return `${name(from)} is both the source and the recipient`;
  if (from.role === 'monitor') return `${name(from)} is a monitor on ${ic.id}: it only receives`;
  if (!sends(from)) return `${name(from)} only receives on ${ic.id}`;
  if (!receives(to)) return `${name(to)} only sends on ${ic.id}`;
  if (ic.access === 'peer') return initiator === from ? null : `between peers the sender starts its own transfer (${name(initiator)} is not ${name(from)})`;
  if (!initiates(ic, initiator)) return `${name(initiator)} is ${ROLE_TEXT[initiator.role].toLowerCase()} on ${ic.id}: only a controller initiates a transfer`;
  if (initiator !== from && initiator !== to) return `the controller ${name(initiator)} is neither the source nor the recipient: a transfer between two other participants needs one of them to be its initiator`;
  return null;
}

/** What NetAtlas does for the non-IP interconnects (the support catalog, docs/SUPPORT.md). */
export const IC_SUPPORT: Support = {
  level: 'configured',
  does: 'Opaque ports and point-to-point or shared interconnects validated (endpoints, roles against the access, data directions, transit groups of one technology on Systems), drawn in the physical view, edited and found; illustrative data moves along them one way, hop by hop under their roles, directions, explicit transit and failures (an interconnect, an attachment, a port, a device), and says why it stops.',
  not: 'any technology or application protocol (enumeration, addressing, arbitration, collisions, framing, timing, bandwidth, acknowledgment, replies); conversion between technologies; electrical faults; the IP side and Analyze never use them.',
};

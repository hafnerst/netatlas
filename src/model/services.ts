/**
 * The routing services a Layer 3+ device can enable (its `protocols:`), as
 * data: for each protocol the parameters it has, of what type, whether they
 * are mandatory, where they are written, how they are validated and what is
 * suggested; which shared identity it uses (the router ID); and that its
 * relations are its sessions. Validation, the Inspector, the consistency
 * checks, the path tracer and the failure analysis read this registry and
 * never name a protocol's parameters themselves.
 *
 * Where a parameter is written (its scope):
 *   device     in the device's block: `protocols: {bgp: {asn: 65010}}`;
 *   interface  in an interface's block, for what applies per interface
 *              (a VRRP group): `protocols: {vrrp: {group: 10, …}}` on the
 *              interface; the device must enable the protocol;
 *   endpoint   in the `attrs` of the protocol's relations, per endpoint
 *              device (`area: {r1: 0, r2: 0}`) or one value for all
 *              (`area: 0`).
 *
 * Built-in services come from BUILTIN_SERVICES. A protocol defined in the
 * model's `protocols:` section becomes a service when it declares `params`
 * (a list, possibly empty) or `router_id`; its parameters are read the same
 * way (see serviceFromDefinition).
 */
import { IpAddr, parseAddress, parsePrefix } from './ip';
import type { Device, Interface, Model, RouterIdValue, ServiceConfig } from './types';

export type ParamType = 'int' | 'text' | 'ipv4' | 'address' | 'enum' | 'area' | 'net';
export const PARAM_TYPES: readonly ParamType[] = ['int', 'text', 'ipv4', 'address', 'enum', 'area', 'net'];
export type ParamScope = 'device' | 'interface' | 'endpoint';
export const PARAM_SCOPES: readonly ParamScope[] = ['device', 'interface', 'endpoint'];

export interface ParamDef {
  /** the YAML key (device and interface: snake_case; endpoint: the relation attribute, e.g. "network-type") */
  key: string;
  label: string;
  type: ParamType;
  scope: ParamScope;
  required?: boolean;
  /** int: the range */
  min?: number;
  max?: number;
  /** enum: the allowed values */
  values?: string[];
  /** values offered with one click (never filled in by themselves) */
  suggest?: string[];
  help?: string;
}

/** Does a service use a router ID: it must have one, it may have one, or it has none. */
export type RouterIdUse = 'required' | 'optional' | 'none';

export interface ServiceDef {
  /** the protocol id (its relations' base protocol) */
  id: string;
  label: string;
  routerId: RouterIdUse;
  params: ParamDef[];
  /** do relations of this protocol are its sessions (endpoints should enable it)? */
  sessions: boolean;
  builtin: boolean;
  description?: string;
}

const int = (key: string, label: string, scope: ParamScope, min: number, max: number, extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, type: 'int', scope, min, max, ...extra });

/** Routing-protocol endpoint parameters the path tracer reads (per adjacency). */
const COST = (max: number): ParamDef => int('cost', 'Cost', 'endpoint', 1, max, { help: 'Added to a route’s metric over this adjacency (without it: a hop).' });
const DISTANCE: ParamDef = int('distance', 'Administrative distance', 'endpoint', 1, 255, { help: 'Of the routes learned over it (without it: the default).' });

/** The groups of first-hop redundancy protocols: written at the interface. */
const fhrp = (id: string, label: string, groupMax: number, groupMin: number, prioMax: number): ServiceDef => ({
  id,
  label,
  routerId: 'none',
  sessions: true,
  builtin: true,
  params: [
    int('group', 'Group', 'interface', groupMin, groupMax, { required: true, help: `The ${label} group number on this segment (${groupMin}–${groupMax}).` }),
    { key: 'virtual_ip', label: 'Virtual IP', type: 'address', scope: 'interface', required: true, help: 'The gateway address the group shares, in the interface’s subnet.' },
    { key: 'virtual_ipv6', label: 'Virtual IPv6', type: 'address', scope: 'interface', help: 'A second virtual address, for a dual-stack group (VRRPv3).' },
    int('priority', 'Priority', 'interface', 0, prioMax, { suggest: ['100'], help: 'The member with the highest priority is active.' }),
  ],
});

export const BUILTIN_SERVICES: readonly ServiceDef[] = [
  {
    id: 'bgp',
    label: 'BGP',
    routerId: 'optional',
    sessions: true,
    builtin: true,
    params: [
      int('asn', 'Local AS number', 'device', 1, 4294967295, { required: true, help: 'The device’s own AS (1–4294967295); iBGP or eBGP follows from both ends.' }),
      int('peer-as', 'Peer AS expected', 'endpoint', 1, 4294967295, { help: 'The AS this device expects the other end to be in.' }),
      int('hold', 'Hold time (s)', 'endpoint', 0, 65535, { suggest: ['90'], help: 'The hold time this device proposes in its OPEN; the session uses the smaller of both. 0: no keepalives and no hold timer; 1 and 2 are refused by the peer.' }),
      int('keepalive', 'Keepalive (s)', 'endpoint', 1, 21845, { suggest: ['30'], help: 'At most a third of the negotiated hold time is used.' }),
      DISTANCE,
    ],
  },
  {
    id: 'ospf',
    label: 'OSPF',
    routerId: 'required',
    sessions: true,
    builtin: true,
    params: [
      int('process', 'Process ID', 'device', 1, 65535, { suggest: ['1'], help: 'Only where the platform numbers its OSPF processes.' }),
      { key: 'area', label: 'Area', type: 'area', scope: 'endpoint', suggest: ['0.0.0.0'], help: 'A number or a dotted area id (0 and 0.0.0.0 are the backbone).' },
      { key: 'network-type', label: 'Network type', type: 'enum', scope: 'endpoint', values: ['broadcast', 'point-to-point', 'non-broadcast', 'point-to-multipoint'], help: 'Broadcast unless written (a tunnel: point-to-point); broadcast and non-broadcast elect a DR and BDR.' },
      int('priority', 'Router priority', 'endpoint', 0, 255, { suggest: ['1'], help: 'DR / BDR election on broadcast and non-broadcast networks (default 1); 0: never DR or BDR.' }),
      int('hello', 'Hello interval (s)', 'endpoint', 1, 65535, { suggest: ['10'] }),
      int('dead', 'Dead interval (s)', 'endpoint', 1, 65535, { suggest: ['40'] }),
      COST(65535),
      DISTANCE,
    ],
  },
  {
    id: 'isis',
    label: 'IS-IS',
    routerId: 'none',
    sessions: true,
    builtin: true,
    params: [
      { key: 'net', label: 'NET (system ID)', type: 'net', scope: 'device', required: true, help: 'e.g. 49.0001.1921.6800.1001.00: area, system ID, selector 00.' },
      { key: 'level', label: 'Level', type: 'enum', scope: 'device', values: ['level-1', 'level-2', 'level-1-2'], suggest: ['level-2'] },
      COST(16777215),
      DISTANCE,
    ],
  },
  {
    id: 'eigrp',
    label: 'EIGRP',
    routerId: 'optional',
    sessions: true,
    builtin: true,
    params: [int('asn', 'EIGRP AS number', 'device', 1, 65535, { required: true, help: 'The autonomous system of the EIGRP process (1–65535).' }), COST(4294967295), DISTANCE],
  },
  {
    id: 'rip',
    label: 'RIP',
    routerId: 'none',
    sessions: true,
    builtin: true,
    params: [{ key: 'version', label: 'Version', type: 'enum', scope: 'device', values: ['1', '2', 'ng'], suggest: ['2'] }, DISTANCE],
  },
  { id: 'ldp', label: 'LDP', routerId: 'optional', sessions: true, builtin: true, params: [] },
  {
    id: 'pim',
    label: 'PIM',
    routerId: 'none',
    sessions: true,
    builtin: true,
    params: [
      { key: 'mode', label: 'Mode', type: 'enum', scope: 'device', values: ['sparse', 'dense', 'ssm'], suggest: ['sparse'] },
      { key: 'rp', label: 'Rendezvous point', type: 'address', scope: 'device', help: 'The static RP of the sparse-mode groups (an address of a router of the model).' },
      { key: 'candidate_rp', label: 'Candidate RP', type: 'enum', scope: 'device', values: ['yes', 'no'], help: 'It offers itself as RP (bootstrap router mechanism, RFC 5059).' },
      { key: 'candidate_bsr', label: 'Candidate BSR', type: 'enum', scope: 'device', values: ['yes', 'no'], help: 'It may become the bootstrap router that announces the RP.' },
    ],
  },
  {
    id: 'bfd',
    label: 'BFD',
    routerId: 'none',
    sessions: true,
    builtin: true,
    params: [{ key: 'interval', label: 'Interval', type: 'text', scope: 'endpoint', suggest: ['300ms'] }, int('multiplier', 'Multiplier', 'endpoint', 1, 255, { suggest: ['3'] })],
  },
  fhrp('vrrp', 'VRRP', 255, 1, 254),
  fhrp('hsrp', 'HSRP', 4095, 0, 255),
  fhrp('glbp', 'GLBP', 1023, 0, 255),
  fhrp('carp', 'CARP', 255, 1, 254),
];

/** The services of a model: the built-in ones and those its `protocols:` section defines (by id). */
export type ServiceRegistry = Map<string, ServiceDef>;

export function builtinServices(): ServiceRegistry {
  const m: ServiceRegistry = new Map();
  for (const s of BUILTIN_SERVICES) m.set(s.id, s);
  return m;
}

/** The parameters of a service written at one scope. */
export function paramsAt(s: ServiceDef, scope: ParamScope): ParamDef[] {
  return s.params.filter((p) => p.scope === scope);
}

/** A device-scope parameter key that a service also accepts: its own router ID (overriding the device's). */
export const ROUTER_ID_KEY = 'router_id';

/**
 * Check a parameter value; '' when it is valid, else what is wrong.
 * `text` is the value as written (numbers as their text).
 */
export function paramProblem(p: ParamDef, text: string): string {
  const t = text.trim();
  if (t === '') return `${p.label} is empty`;
  switch (p.type) {
    case 'int': {
      if (!/^[0-9]+$/.test(t)) return `${p.label} must be a whole number${p.min !== undefined ? ` from ${p.min} to ${p.max}` : ''}`;
      const n = Number(t);
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) return `${p.label} must be from ${p.min} to ${p.max}`;
      return '';
    }
    case 'ipv4': {
      const a = parsePrefix(t, false);
      return a && a.version === 4 && t.indexOf('/') < 0 ? '' : `${p.label} must be an IPv4 address, e.g. 10.255.0.1`;
    }
    case 'address': {
      return parseAddress(t) ? '' : `${p.label} must be an IP address without a prefix length`;
    }
    case 'enum':
      return (p.values || []).indexOf(t) >= 0 ? '' : `${p.label} must be one of ${(p.values || []).join(', ')}`;
    case 'area':
      return /^[0-9]+$/.test(t) || (/^[0-9]+(\.[0-9]+){3}$/.test(t) && !!parseAddress(t)) ? '' : `${p.label} must be a number or a dotted area id such as 0.0.0.1`;
    case 'net':
      return NET_RE.test(t) ? '' : `${p.label} must be a NET such as 49.0001.1921.6800.1001.00 (area, a 6-byte system ID in three groups of four hex digits, selector 00)`;
    default:
      return '';
  }
}

/** A NET: AFI and area (1–13 bytes in dot groups), a 6-byte system ID as xxxx.xxxx.xxxx, the selector 00. */
const NET_RE = /^[0-9a-fA-F]{2}(\.[0-9a-fA-F]{4}){0,6}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.00$/;

/** The system ID of a NET ("1921.6800.1001"). */
export function netSystemId(net: string): string {
  const g = net.split('.');
  return g.slice(-4, -1).join('.').toLowerCase();
}

/** An IPv4 address as written for a router ID (no prefix length), or null. */
export function routerIdAddress(text: string): IpAddr | null {
  const a = parsePrefix(text.trim(), false);
  return a && a.version === 4 && text.indexOf('/') < 0 ? { version: 4, bytes: a.bytes } : null;
}

/** The services that use a router ID. */
export function usesRouterId(s: ServiceDef): boolean {
  return s.routerId !== 'none';
}

// ------------------------------------------------------------ reading a model

/** The settings of a service a device enables (none: it is not enabled). */
export function serviceOf(d: Device | undefined, id: string): ServiceConfig | undefined {
  return d ? d.services.find((s) => s.id === id) : undefined;
}

/** Does the device enable the service? */
export function hasService(model: Model, device: string, id: string): boolean {
  return !!serviceOf(model.index.devices.get(device), id);
}

/** The settings of a service on one interface. */
export function ifaceServiceOf(i: Interface | undefined, id: string): ServiceConfig | undefined {
  return i ? i.services.find((s) => s.id === id) : undefined;
}

/** The router ID a service of the device uses: its own, else the device's (an IPv4 address), when it has one. */
export function routerIdFor(d: Device | undefined, id: string): RouterIdValue | undefined {
  const s = serviceOf(d, id);
  if (!s || !d) return undefined;
  return s.routerId || d.routerId;
}

/** A device's local BGP AS number (only with BGP enabled). */
export function bgpAsn(d: Device | undefined): number | undefined {
  const s = serviceOf(d, 'bgp');
  const v = s ? s.values.get('asn') : undefined;
  return v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : undefined;
}

/** The service a relation's protocol is (by its base protocol), when it is one. */
export function serviceOfProtocol(model: Model, base: string): ServiceDef | undefined {
  return model.services.get(base);
}

/** The services of the device that use a router ID (enabled ones only), by id. */
export function routerIdServices(model: Model, d: Device): string[] {
  return d.services.filter((s) => {
    const def = model.services.get(s.id);
    return !!def && usesRouterId(def);
  }).map((s) => s.id);
}

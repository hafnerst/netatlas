/**
 * The protocol simulation's parameters: the simulation-wide Layer 1–3
 * parameters of Start simulation (and the Simulation window), and the
 * per-device simulation attributes (a device's optional `simulation:`
 * block). One registry, one order of precedence, used by the engine, the
 * window, the Inspector, the tables and validation alike:
 *
 *   1. configured  explicit configuration on the object in the model
 *                  (a relation's OSPF timers, a cable's `simulation:`
 *                  latency, a link's speed);
 *   2. device      the device's simulation attribute (`simulation:`);
 *   3. simulation  the simulation-wide value (Start simulation…, the
 *                  Simulation window; remembered for the browser session);
 *   4. default     the built-in common default, with its source.
 *
 * Pure: no DOM, no storage. Durations are kept in milliseconds; a value
 * written in the model without a unit is in the parameter's `base` unit.
 */
import { DEVICE_TYPE_IDS } from '../../model/device-types';
import { parseSpeed } from '../../model/speed';

export type ParamKind = 'duration' | 'count' | 'percent' | 'speed' | 'enum';
export type ParamValue = number | string;
export type Source = 'configured' | 'device' | 'simulation' | 'default';

/** Which devices a simulation attribute applies to (see deviceParams). */
export type Applies = 'all' | 'ip' | 'router' | 'switch' | 'aggregate' | 'firewall' | 'ids' | 'vpn' | 'host' | 'hypervisor' | 'monitor' | 'cloud' | 'ap';

export interface ParamDef {
  /** the registry key ("arp-timeout") */
  key: string;
  /** the key in a device's (or a cable's) `simulation:` block */
  yaml: string;
  label: string;
  /** the section of the start dialog and the window (0: a device attribute only) */
  layer: 0 | 1 | 2 | 3 | 4;
  kind: ParamKind;
  /** a duration's unit for a bare number in the model and in the fields ("s", "ms") */
  base?: 's' | 'ms';
  /** the built-in common default (durations in ms) */
  dflt: ParamValue;
  /** per device type, where the default differs */
  dfltByType?: { [type: string]: ParamValue };
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  /** where the default comes from */
  source: string;
  /** a short help text (the default and its source are added where shown) */
  help: string;
  /** what 0 means ("continuous") */
  zero?: string;
  /** shown in one row with this parameter in the dialog (BFD interval × multiplier); not counted on its own */
  pairOf?: string;
  /** also a device attribute, for these devices */
  device?: Applies[];
  /** a value configured on the object in the model can override it (shown in the help) */
  configured?: string;
}

const S = 1000;

const P = (d: ParamDef): ParamDef => d;

/** Every parameter, in the order the dialog and the Inspector list them. */
export const PARAMS: readonly ParamDef[] = [
  // ------------------------------------------------------------ Layer 1 – Physical
  P({ key: 'link-latency', yaml: 'latency', label: 'Link latency', layer: 1, kind: 'duration', base: 'ms', dflt: 0.1, min: 0, max: 10 * S, source: 'about 20 km of fibre (5 µs per km); a cable in one building is far shorter', help: 'Propagation delay of a cable; serialization (frame size ÷ speed) is added.', device: ['cloud'], configured: 'a cable’s simulation: latency' }),
  P({ key: 'loss', yaml: 'loss', label: 'Packet loss', layer: 1, kind: 'percent', dflt: 0, min: 0, max: 100, source: 'a healthy link loses nothing', help: 'Share of frames lost on each cable, from a fixed seed.', device: ['cloud'], configured: 'a cable’s simulation: loss' }),
  P({ key: 'los-detect', yaml: 'los_detection', label: 'Loss-of-signal detection', layer: 1, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 60 * S, source: 'Junos hold-time down 0 ms (Cisco carrier-delay is the same idea)', help: 'How long a port takes to report that its cable went dark; frames are lost meanwhile.' }),
  P({ key: 'link-up-delay', yaml: 'link_up_delay', label: 'Link-up delay', layer: 1, kind: 'duration', base: 's', dflt: 2 * S, min: 0, max: 300 * S, source: '1000BASE-T autonegotiation and link training (IEEE 802.3 clauses 28 and 40) take about 2 s', help: 'After a restore or power-on: the time until the port is up again.' }),
  P({ key: 'default-speed', yaml: 'speed', label: 'Default speed', layer: 1, kind: 'speed', dflt: 1e9, min: 1e3, max: 1.6e12, source: '1000BASE-T, the usual access port', help: 'For cables without a speed: serialization time of each frame.', configured: 'a cable’s speed' }),
  P({ key: 'flap-down', yaml: 'flap_down', label: 'Flapping: down time', layer: 1, kind: 'duration', base: 's', dflt: 5 * S, min: 100, max: 3600 * S, source: 'a demonstration value', help: 'Start flapping: how long the cable stays down in each cycle.' }),
  P({ key: 'flap-up', yaml: 'flap_up', label: 'Flapping: up time', layer: 1, kind: 'duration', base: 's', dflt: 10 * S, min: 100, max: 3600 * S, source: 'a demonstration value', help: 'Start flapping: how long the cable stays up between two losses.' }),
  P({ key: 'flap-cycles', yaml: 'flap_cycles', label: 'Flapping: cycles', layer: 1, kind: 'count', dflt: 3, min: 0, max: 1000, zero: 'continuous', source: 'a demonstration value', help: 'How many times it goes down and up again; 0: until Stop flapping.' }),
  // ------------------------------------------------------------ Layer 2 – Data link
  P({ key: 'arp-timeout', yaml: 'arp_timeout', label: 'ARP timeout', layer: 2, kind: 'duration', base: 's', dflt: 14400 * S, min: S, max: 2147483 * S, source: 'Cisco IOS (4 h); RFC 826 sets none', help: 'How long an ARP entry stays valid.', device: ['ip'] }),
  P({ key: 'arp-retransmit', yaml: 'arp_retransmit', label: 'ARP retransmit interval', layer: 2, kind: 'duration', base: 's', dflt: S, min: 100, max: 60 * S, source: 'RFC 4861 RETRANS_TIMER (used for ARP as well)', help: 'Time between two ARP Requests or Neighbor Solicitations for one address.', device: ['ip'] }),
  P({ key: 'arp-retries', yaml: 'arp_retries', label: 'ARP retries', layer: 2, kind: 'count', dflt: 3, min: 1, max: 10, source: 'RFC 4861 MAX_MULTICAST_SOLICIT (used for ARP as well)', help: 'Requests before an unanswered entry is dropped with its waiting packets.', device: ['ip'] }),
  P({ key: 'ndp-reachable', yaml: 'ndp_reachable_time', label: 'NDP reachable time', layer: 2, kind: 'duration', base: 's', dflt: 30 * S, min: S, max: 3600 * S, source: 'RFC 4861 REACHABLE_TIME', help: 'How long an IPv6 neighbour counts as reachable after it was confirmed.', device: ['ip'] }),
  P({ key: 'mac-aging', yaml: 'mac_aging', label: 'MAC aging time', layer: 2, kind: 'duration', base: 's', dflt: 300 * S, min: 10 * S, max: 1000000 * S, source: 'IEEE 802.1D-2004 recommended ageing time', help: 'How long a switch keeps a MAC address it no longer hears.', device: ['switch'] }),
  P({
    key: 'stp-mode',
    yaml: 'stp_mode',
    label: 'Spanning tree',
    layer: 2,
    kind: 'enum',
    dflt: 'rstp',
    options: [
      { value: 'rstp', label: 'RSTP (802.1w)' },
      { value: 'stp', label: 'STP (802.1D)' },
    ],
    source: 'IEEE 802.1D-2004 (RSTP, the default of current switches)',
    help: 'Convergence: RSTP at once (6 s further away); STP 30 s (50 s further away).',
    device: ['switch'],
  }),
  // ------------------------------------------------------------ Layer 3 – Network
  P({ key: 'ttl', yaml: 'ttl', label: 'Default TTL / hop limit', layer: 3, kind: 'count', dflt: 64, min: 1, max: 255, source: 'RFC 1700 (IANA); Linux, macOS and most routers', help: 'The TTL (IPv4) and hop limit (IPv6) of the packets a device sends.', device: ['ip'] }),
  P({ key: 'ospf-hello', yaml: 'ospf_hello', label: 'OSPF hello interval', layer: 3, kind: 'duration', base: 's', dflt: 10 * S, min: S, max: 65535 * S, source: 'RFC 2328 Appendix C.3', help: 'The dead interval is 4 × hello.', configured: 'an OSPF relation’s hello and dead' }),
  P({ key: 'bgp-keepalive', yaml: 'bgp_keepalive', label: 'BGP keepalive', layer: 3, kind: 'duration', base: 's', dflt: 60 * S, min: S, max: 21845 * S, source: 'Cisco IOS: keepalive 60 s, hold 180 s; RFC 4271 §10 suggests 30 s and 90 s', help: 'The hold time is 3 × keepalive.', configured: 'a BGP relation’s keepalive and hold' }),
  P({ key: 'bfd-interval', yaml: 'bfd_interval', label: 'BFD interval', layer: 3, kind: 'duration', base: 'ms', dflt: 300, min: 3, max: 10 * S, source: 'a common configuration (RFC 5880 sets none)', help: 'Detection time: interval × multiplier.', configured: 'a BFD relation’s interval and multiplier' }),
  P({ key: 'bfd-multiplier', yaml: 'bfd_multiplier', label: 'BFD multiplier', layer: 3, kind: 'count', dflt: 3, min: 1, max: 255, source: 'a common configuration (RFC 5880 sets none)', help: 'Missed packets before the session goes down.', pairOf: 'bfd-interval', configured: 'a BFD relation’s multiplier' }),
  P({ key: 'vrrp-advert', yaml: 'vrrp_advert', label: 'VRRP advertisement interval', layer: 3, kind: 'duration', base: 's', dflt: S, min: 10, max: 40950, source: 'RFC 5798 §5.2.7 (100 centiseconds)', help: 'The master-down interval is 3 × interval + skew. CARP uses it as well.' }),
  P({ key: 'spf-delay', yaml: 'spf_delay', label: 'Route recomputation delay', layer: 3, kind: 'duration', base: 'ms', dflt: 200, min: 0, max: 60 * S, source: 'Junos spf-options delay (200 ms)', help: 'SPF and FIB update after a change: the old routes are used meanwhile.', device: ['router'] }),
  // ------------------------------------------------------------ device attributes only
  P({ key: 'boot-time', yaml: 'boot_time', label: 'Boot time', layer: 0, kind: 'duration', base: 's', dflt: 30 * S, dfltByType: { container: 2 * S, vm: 20 * S, router: 60 * S, firewall: 60 * S, gateway: 60 * S, load_balancer: 60 * S }, min: 0, max: 3600 * S, source: 'a demonstration value (containers start in seconds, chassis routers in minutes)', help: 'Power on: the time until its interfaces come up.', device: ['all'] }),
  P({ key: 'ecmp-max', yaml: 'max_paths', label: 'Maximum ECMP paths', layer: 0, kind: 'count', dflt: 4, min: 1, max: 64, source: 'Cisco IOS maximum-paths (4)', help: 'Equal-cost next hops it spreads flows over.', device: ['router'] }),
  P({ key: 'mac-table-size', yaml: 'mac_table_size', label: 'MAC table size', layer: 0, kind: 'count', dflt: 8192, min: 1, max: 1000000, source: 'a small access switch (data sheets: 8 K–16 K entries)', help: 'When it is full, new addresses are not learned and their frames are flooded.', device: ['switch'] }),
  P({ key: 'stp-hello', yaml: 'stp_hello', label: 'STP hello time', layer: 0, kind: 'duration', base: 's', dflt: 2 * S, min: S, max: 10 * S, source: 'IEEE 802.1D-2004 Table 17-1', help: 'RSTP: a switch further from a failure takes over after 3 hellos.', device: ['switch'] }),
  P({ key: 'stp-forward-delay', yaml: 'stp_forward_delay', label: 'STP forward delay', layer: 0, kind: 'duration', base: 's', dflt: 15 * S, min: 4 * S, max: 30 * S, source: 'IEEE 802.1D-2004 Table 17-1', help: 'STP: listening and learning each take this long.', device: ['switch'] }),
  P({ key: 'stp-max-age', yaml: 'stp_max_age', label: 'STP max age', layer: 0, kind: 'duration', base: 's', dflt: 20 * S, min: 6 * S, max: 40 * S, source: 'IEEE 802.1D-2004 Table 17-1', help: 'STP: how long a switch further from a failure keeps the old information.', device: ['switch'] }),
  P({
    key: 'lacp-rate',
    yaml: 'lacp_rate',
    label: 'LACP rate',
    layer: 0,
    kind: 'enum',
    dflt: 'slow',
    options: [
      { value: 'slow', label: 'Slow (every 30 s, timeout 90 s)' },
      { value: 'fast', label: 'Fast (every 1 s, timeout 3 s)' },
    ],
    source: 'IEEE 802.1AX (slow periodic time)',
    help: 'How often LACPDUs go out on the members of its aggregates.',
    device: ['aggregate'],
  }),
  P({ key: 'ha-failover', yaml: 'ha_failover', label: 'HA failover detection', layer: 0, kind: 'duration', base: 's', dflt: 3 * S, min: 100, max: 300 * S, source: 'a common setting (3 missed heartbeats of 1 s)', help: 'Its HA sync relation is down after this long without a heartbeat.', device: ['firewall'], configured: 'an HA sync relation’s dead' }),
  P({
    key: 'ips-fail',
    yaml: 'fail_mode',
    label: 'When it fails',
    layer: 0,
    kind: 'enum',
    dflt: 'open',
    options: [
      { value: 'open', label: 'Fail open (frames pass unchecked)' },
      { value: 'closed', label: 'Fail closed (nothing passes)' },
    ],
    source: 'the hardware bypass of most inline appliances',
    help: 'Power off: does traffic still pass through it?',
    device: ['ids'],
  }),
  P({ key: 'ips-latency', yaml: 'inspection_latency', label: 'Inspection latency', layer: 0, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 10 * S, source: 'none unless set (see the appliance’s data sheet)', help: 'Added to every frame it passes on.', device: ['ids'] }),
  P({ key: 'ike-lifetime', yaml: 'ike_lifetime', label: 'IKE SA lifetime', layer: 0, kind: 'duration', base: 's', dflt: 86400 * S, min: 60 * S, max: 31536000 * S, source: 'Cisco IKEv2 (86 400 s)', help: 'The IKE SA is rekeyed this long after it was set up, less the rekey margin.', device: ['vpn'] }),
  P({ key: 'child-lifetime', yaml: 'child_lifetime', label: 'Child SA lifetime', layer: 0, kind: 'duration', base: 's', dflt: 3600 * S, min: 60 * S, max: 31536000 * S, source: 'Cisco IOS and strongSwan (1 h)', help: 'The Child SA (the tunnel’s ESP keys) is rekeyed before it ends.', device: ['vpn'], configured: 'an IPsec relation’s child-lifetime' }),
  P({ key: 'rekey-margin', yaml: 'rekey_margin', label: 'Rekey margin', layer: 0, kind: 'duration', base: 's', dflt: 540 * S, min: 0, max: 86400 * S, source: 'strongSwan margintime (9 min)', help: 'How long before a lifetime ends the SA is rekeyed.', device: ['vpn'] }),
  P({ key: 'dpd-interval', yaml: 'dpd_interval', label: 'DPD interval', layer: 0, kind: 'duration', base: 's', dflt: 10 * S, min: S, max: 3600 * S, source: 'a common setting (RFC 7296 sets none)', help: 'Dead Peer Detection: an empty INFORMATIONAL request this often.', device: ['vpn'], configured: 'an IPsec relation’s dpd' }),
  P({ key: 'dpd-retries', yaml: 'dpd_retries', label: 'DPD retries', layer: 0, kind: 'count', dflt: 3, min: 1, max: 20, source: 'a common setting', help: 'Unanswered requests before the SAs are deleted.', device: ['vpn'] }),
  P({ key: 'service-response', yaml: 'response_time', label: 'Service response time', layer: 0, kind: 'duration', base: 'ms', dflt: 0, min: 0, max: 60 * S, source: 'none unless set', help: 'How long its services take to answer a request.', device: ['host'] }),
  P({ key: 'vm-restart', yaml: 'vm_restart', label: 'VM restart time', layer: 0, kind: 'duration', base: 's', dflt: 60 * S, min: 0, max: 3600 * S, source: 'a demonstration value (HA failure detection plus the restart)', help: 'Power off: its VMs restart this long after, on another server cabled to them.', device: ['hypervisor'] }),
  P({ key: 'snmp-interval', yaml: 'snmp_interval', label: 'SNMP polling interval', layer: 0, kind: 'duration', base: 's', dflt: 60 * S, min: S, max: 86400 * S, source: 'a demonstration value (300 s is common in production)', help: 'How often it polls each SNMP agent.', device: ['monitor'] }),
  P({ key: 'snmp-timeout', yaml: 'snmp_timeout', label: 'SNMP timeout', layer: 0, kind: 'duration', base: 's', dflt: S, min: 100, max: 60 * S, source: 'net-snmp (1 s)', help: 'An agent that does not answer within it is reported as not responding.', device: ['monitor'] }),
  P({ key: 'ap-association', yaml: 'association_time', label: 'Client association time', layer: 0, kind: 'duration', base: 's', dflt: S, min: 0, max: 60 * S, source: 'a demonstration value (WPA2-PSK takes well under a second, 802.1X longer)', help: 'Its wireless links come up this long after the radio is back.', device: ['ap'] }),
];

const BY_KEY = new Map<string, ParamDef>(PARAMS.map((p) => [p.key, p]));
const BY_YAML = new Map<string, ParamDef>(PARAMS.filter((p) => p.device).map((p) => [p.yaml, p]));

export function paramDef(key: string): ParamDef {
  const d = BY_KEY.get(key);
  if (!d) throw new Error('unknown simulation parameter ' + key);
  return d;
}

/** The device attribute of a `simulation:` key (undefined: none). */
export function deviceParamByYaml(yaml: string): ParamDef | undefined {
  return BY_YAML.get(yaml);
}

/** The cable attributes (a link's `simulation:` block): latency, loss, flapping from the start. */
export const LINK_KEYS: readonly string[] = ['latency', 'loss', 'flapping'];

export const LAYER_TITLES: { [n: number]: string } = { 1: 'Layer 1 – Physical', 2: 'Layer 2 – Data link', 3: 'Layer 3 – Network', 4: 'Layer 4 – Transport' };

/** The simulation-wide parameters of a layer, in order (a pair's second half follows its first). */
export function layerParams(layer: number): ParamDef[] {
  return PARAMS.filter((p) => p.layer === layer);
}

/** The rows of a layer's section: a parameter with the one shown beside it (BFD interval × multiplier). */
export function layerRows(layer: number): ParamDef[][] {
  const out: ParamDef[][] = [];
  for (const p of layerParams(layer)) {
    if (p.pairOf) {
      const row = out.find((r) => r[0].key === p.pairOf);
      if (row) {
        row.push(p);
        continue;
      }
    }
    out.push([p]);
  }
  return out;
}

/** The layers that have simulation-wide parameters, ascending. */
export function paramLayers(): number[] {
  return [1, 2, 3, 4].filter((l) => layerParams(l).length > 0);
}

// ------------------------------------------------------------ which devices an attribute applies to

/** What the applicability rules need to know about a device. */
export interface DeviceFacts {
  id: string;
  type: string;
  layer3?: boolean;
  /** has an address (an IP stack) */
  ip: boolean;
  /** forwards IP for others */
  routes: boolean;
  /** has an aggregate (LACP) */
  aggregate: boolean;
  /** an endpoint of an IPsec relation */
  ipsec: boolean;
  /** polls SNMP agents (the manager of an SNMP relation) */
  snmpManager: boolean;
  /** hosts VMs or containers (one is cabled to it) */
  hosts: boolean;
}

const HOST_TYPES = ['server', 'vm', 'container', 'storage'];

function applies(a: Applies, f: DeviceFacts): boolean {
  switch (a) {
    case 'all':
      return true;
    case 'ip':
      return f.ip;
    case 'router':
      return f.routes;
    case 'switch':
      return f.type === 'switch';
    case 'aggregate':
      return f.aggregate;
    case 'firewall':
      return f.type === 'firewall';
    case 'ids':
      return f.type === 'ids_ips';
    case 'vpn':
      return f.type === 'gateway' || f.ipsec;
    case 'host':
      return HOST_TYPES.indexOf(f.type) >= 0;
    case 'hypervisor':
      return f.type === 'server' && f.hosts;
    case 'monitor':
      return f.type === 'system' || f.snmpManager;
    case 'cloud':
      return f.type === 'cloud';
    case 'ap':
      return f.type === 'ap';
  }
  return false;
}

/** The simulation attributes a device can have, in order. */
export function deviceParams(f: DeviceFacts): ParamDef[] {
  return PARAMS.filter((p) => !!p.device && p.device.some((a) => applies(a, f)));
}

/** Every device type has some attribute (boot time at least): for the docs and the tests. */
export function attributesByType(): Array<{ type: string; keys: string[] }> {
  return DEVICE_TYPE_IDS.map((type) => {
    const f: DeviceFacts = { id: '', type, layer3: type === 'switch', ip: type !== 'cloud' && type !== 'ids_ips', routes: ['router', 'firewall', 'gateway', 'load_balancer', 'proxy'].indexOf(type) >= 0 || type === 'switch', aggregate: type === 'switch' || type === 'server' || type === 'router', ipsec: false, snmpManager: false, hosts: type === 'server' };
    return { type, keys: deviceParams(f).map((p) => p.key) };
  });
}

// ------------------------------------------------------------ values: parse, check, format

/** Parse a value as written in the model or typed in a field; an error text when it isn't one. */
export function parseValue(def: ParamDef, raw: unknown): { value: ParamValue } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { error: 'is empty' };
  if (def.kind === 'enum') {
    const v = String(raw).trim().toLowerCase();
    const ok = (def.options || []).some((o) => o.value === v);
    return ok ? { value: v } : { error: `must be one of ${(def.options || []).map((o) => o.value).join(', ')}` };
  }
  let n: number | null = null;
  if (def.kind === 'speed') {
    n = typeof raw === 'number' ? raw : parseSpeed(String(raw));
    if (n === null) return { error: 'is not a speed (e.g. 1G, 100M)' };
  } else if (def.kind === 'duration') {
    if (typeof raw === 'number') n = def.base === 's' ? raw * S : raw;
    else {
      const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(µs|us|ms|s|sec|min|m|h|d)?\s*$/i.exec(String(raw));
      if (!m) return { error: `is not a duration (e.g. ${def.base === 'ms' ? '300ms' : '30s'}, 5min, 4h)` };
      const v = Number(m[1]);
      const u = (m[2] || def.base || 's').toLowerCase();
      n = u === 'µs' || u === 'us' ? v / 1000 : u === 'ms' ? v : u === 'min' || u === 'm' ? v * 60 * S : u === 'h' ? v * 3600 * S : u === 'd' ? v * 86400 * S : v * S;
    }
  } else if (def.kind === 'percent') {
    const t = typeof raw === 'number' ? String(raw) : String(raw).trim().replace(/\s*%$/, '');
    if (!/^[0-9]+(\.[0-9]+)?$/.test(t)) return { error: 'is not a percentage (e.g. 0.5, 2%)' };
    n = Number(t);
  } else {
    const t = String(raw).trim();
    if (!/^[0-9]+$/.test(t)) return { error: 'must be a whole number' };
    n = Number(t);
  }
  const min = def.min !== undefined ? def.min : -Infinity;
  const max = def.max !== undefined ? def.max : Infinity;
  if (n < min || n > max) return { error: `must be from ${formatValue(def, min)} to ${formatValue(def, max)}` };
  return { value: n };
}

/** A value as the UI writes it: "4 h", "300 ms", "1 Gbit/s", "0.5 %", "3" ("continuous" for a 0 that means it). */
export function formatValue(def: ParamDef, v: ParamValue): string {
  if (def.kind === 'enum') {
    const o = (def.options || []).find((x) => x.value === v);
    return o ? o.label.replace(/ \(.*\)$/, '') : String(v);
  }
  const n = Number(v);
  if (def.kind === 'count') return n === 0 && def.zero ? def.zero : String(n);
  if (def.kind === 'percent') return `${n} %`;
  if (def.kind === 'speed') return speedText(n);
  return durationText(n);
}

/** A duration in ms as text: "4 h", "5 min", "30 s", "1.5 s", "300 ms", "0.1 ms". */
export function durationText(ms: number): string {
  if (ms === 0) return '0 s';
  const s = ms / S;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  if (ms >= S) return `${round(s, 3)} s`;
  if (ms >= 1) return `${round(ms, 3)} ms`;
  return `${round(ms * 1000, 3)} µs`;
}

function speedText(bps: number): string {
  if (bps >= 1e12 && bps % 1e12 === 0) return `${bps / 1e12} Tbit/s`;
  if (bps >= 1e9) return `${round(bps / 1e9, 3)} Gbit/s`;
  if (bps >= 1e6) return `${round(bps / 1e6, 3)} Mbit/s`;
  if (bps >= 1e3) return `${round(bps / 1e3, 3)} kbit/s`;
  return `${bps} bit/s`;
}

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

/** A value as a field (and the model, without a unit) holds it: a duration in its base unit, a speed like "1G". */
export function fieldText(def: ParamDef, v: ParamValue): string {
  if (def.kind === 'enum') return String(v);
  const n = Number(v);
  if (def.kind === 'duration') return String(round(def.base === 's' ? n / S : n, 6));
  if (def.kind === 'speed') {
    if (n % 1e12 === 0) return `${n / 1e12}T`;
    if (n % 1e9 === 0) return `${n / 1e9}G`;
    if (n % 1e6 === 0) return `${n / 1e6}M`;
    if (n % 1e3 === 0) return `${n / 1e3}k`;
    return String(n);
  }
  return String(n);
}

/** The unit a field shows beside it. */
export function fieldUnit(def: ParamDef): string {
  if (def.kind === 'duration') return def.base === 'ms' ? 'ms' : 's';
  if (def.kind === 'percent') return '%';
  if (def.kind === 'speed') return 'bit/s (1G, 100M)';
  return '';
}

/** The default of a parameter for a device type. */
export function defaultFor(def: ParamDef, type?: string): ParamValue {
  if (type && def.dfltByType && def.dfltByType[type] !== undefined) return def.dfltByType[type];
  return def.dflt;
}

/** The help line under a field: what it does, its default and the source of that. */
export function helpText(def: ParamDef, type?: string): string {
  const d = defaultFor(def, type);
  return `${def.help} Default ${formatValue(def, d)}: ${def.source}.${def.configured ? ` Overridden by ${def.configured}.` : ''}`;
}

// ------------------------------------------------------------ resolution

export interface Resolved {
  value: ParamValue;
  source: Source;
  /** where a configured value is written ("relation ospf-r1-r2") */
  where?: string;
  def: ParamDef;
}

/** A configured value, from the object in the model (the caller reads it). */
export interface Configured {
  value: ParamValue;
  where: string;
}

/** "(configured on …)", "(device)", "(simulation)", "(default, RFC …)" */
export function sourceText(r: Resolved, long = false): string {
  if (r.source === 'configured') return r.where ? `configured on ${r.where}` : 'configured';
  if (r.source === 'device') return 'device';
  if (r.source === 'simulation') return 'simulation';
  return long ? `default — ${r.def.source}` : 'default';
}

export function resolvedText(r: Resolved): string {
  return `${formatValue(r.def, r.value)} (${sourceText(r)})`;
}

/** A parameter change, as the event log writes it. */
export interface ParamChange {
  key: string;
  device?: string;
  from: ParamValue;
  to: ParamValue;
  source: Source;
}

/**
 * The parameters in effect: simulation-wide values (only those that differ
 * from the default are kept) and each device's attributes. The resolver of
 * the order of precedence above.
 */
export class SimParams {
  private sim = new Map<string, ParamValue>();
  private dev = new Map<string, Map<string, ParamValue>>();
  private types = new Map<string, string>();
  /** bumped on every change (readers cache by it) */
  version = 0;

  constructor(sim?: { [key: string]: ParamValue }, devices?: Map<string, { type: string; values: Map<string, ParamValue> }>) {
    if (sim) for (const k of Object.keys(sim)) if (BY_KEY.has(k)) this.setSim(k, sim[k]);
    if (devices) for (const [id, d] of devices) this.setDevice(id, d.type, d.values);
  }

  /** The simulation-wide value (an explicit one, or the default). */
  simValue(key: string): ParamValue {
    const v = this.sim.get(key);
    return v !== undefined ? v : paramDef(key).dflt;
  }

  /** The simulation-wide values that differ from their defaults. */
  simValues(): { [key: string]: ParamValue } {
    const out: { [key: string]: ParamValue } = {};
    for (const [k, v] of this.sim) out[k] = v;
    return out;
  }

  /** Set a simulation-wide value (undefined, or the default: back to the default). Returns the change, or null. */
  setSim(key: string, v: ParamValue | undefined): ParamChange | null {
    const def = paramDef(key);
    const from = this.simValue(key);
    if (v === undefined || v === def.dflt) this.sim.delete(key);
    else this.sim.set(key, v);
    const to = this.simValue(key);
    if (to === from) return null;
    this.version++;
    return { key, from, to, source: 'simulation' };
  }

  /** A device's own value of an attribute (undefined: it inherits). */
  deviceValue(device: string, key: string): ParamValue | undefined {
    const m = this.dev.get(device);
    return m ? m.get(key) : undefined;
  }

  /** Replace a device's attributes (from its `simulation:` block); the changes of their values in effect. */
  setDevice(device: string, type: string, values: Map<string, ParamValue>): ParamChange[] {
    const before = new Map<string, ParamValue>();
    const keys = new Set<string>(Array.from(values.keys()).concat(Array.from((this.dev.get(device) || new Map()).keys())));
    for (const k of keys) before.set(k, this.get(k, device).value);
    this.types.set(device, type);
    this.dev.set(device, new Map(values));
    const out: ParamChange[] = [];
    for (const k of Array.from(keys).sort()) {
      const r = this.get(k, device);
      if (r.value !== before.get(k)) out.push({ key: k, device, from: before.get(k) as ParamValue, to: r.value, source: r.source });
    }
    if (out.length) this.version++;
    return out;
  }

  /** The value in effect, and where it comes from. */
  get(key: string, device?: string, configured?: Configured | null): Resolved {
    const def = paramDef(key);
    if (configured) return { value: configured.value, source: 'configured', where: configured.where, def };
    if (device !== undefined) {
      const v = this.deviceValue(device, key);
      if (v !== undefined) return { value: v, source: 'device', def };
    }
    const s = this.sim.get(key);
    if (s !== undefined) return { value: s, source: 'simulation', def };
    return { value: defaultFor(def, device !== undefined ? this.types.get(device) : undefined), source: 'default', def };
  }

  /** A number in effect (durations in ms). */
  num(key: string, device?: string, configured?: Configured | null): number {
    return Number(this.get(key, device, configured).value);
  }

  str(key: string, device?: string): string {
    return String(this.get(key, device).value);
  }

  /** What a device inherits for an attribute (its own value left out): the simulation's value or the default. */
  inherited(key: string, device: string): Resolved {
    const def = paramDef(key);
    const s = this.sim.get(key);
    if (s !== undefined) return { value: s, source: 'simulation', def };
    return { value: defaultFor(def, this.types.get(device)), source: 'default', def };
  }
}

/** A change as the event log writes it: "Parameter changed: ARP timeout 4 h → 60 s (simulation)". */
export function changeText(c: ParamChange): string {
  const def = paramDef(c.key);
  return `Parameter changed: ${def.label}${c.device ? ' on ' + c.device : ''} ${formatValue(def, c.from)} → ${formatValue(def, c.to)} (${c.source})`;
}

/** The simulation-wide values as stored for the browser session (JSON): only known keys with valid values. */
export function readStoredParams(json: string | null): { [key: string]: ParamValue } {
  const out: { [key: string]: ParamValue } = {};
  if (!json) return out;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch (e) {
    return out;
  }
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(o as object)) {
    const def = BY_KEY.get(k);
    if (!def || def.layer === 0) continue;
    const v = (o as { [k: string]: unknown })[k];
    if (typeof v !== 'number' && typeof v !== 'string') continue;
    const p = def.kind === 'enum' ? parseValue(def, v) : typeof v === 'number' && Number.isFinite(v) && (def.min === undefined || v >= def.min) && (def.max === undefined || v <= def.max) ? { value: v } : { error: 'bad' };
    if ('value' in p) out[k] = p.value;
  }
  return out;
}

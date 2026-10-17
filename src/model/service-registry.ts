/**
 * The service registry: every service a device may run (`services:`), the
 * built-in functions of the appliances among them, and for each what it
 * needs. It is data, like the device types' registry: who may run a
 * service is a list of types with the capability conditions on top (a
 * routed firewall, a Layer 3 switch, a System that is a host), and a
 * reason when a device may not. Validation, the editor's Services card,
 * the badges, the simulation and docs/FORMAT.md's service matrix read it.
 *
 * Kinds of entries:
 *   built in   the appliance's own function: always there and not
 *              removable (a VPN gateway's VPN gateway, a Security
 *              gateway's Domain separation, an access point's Wireless
 *              access, a load balancer's Load balancing, an IDS/IPS's
 *              Inspection); `required` when its configuration must be
 *              written;
 *   optional   enabled on a device that may run it, with its parameters
 *              (none chosen for the user: a required one is an error until
 *              it is written).
 * A Security gateway runs nothing but its Domain separation: nothing is
 * allowed on it implicitly.
 */
import { Capabilities, DeviceLike, capabilities } from './capabilities';
import { DEVICE_TYPE_IDS, deviceTypeLabel } from './device-types';

/** What a parameter holds, as written. */
export type SvcParamType =
  | 'text'
  | 'int'
  | 'port'
  | 'address'
  | 'prefix'
  | 'enum'
  | 'bool'
  | 'addresses'
  | 'devices'
  | 'interface'
  | 'interfaces'
  | 'secret'
  | 'portlist'
  | 'duration'
  | 'topics';

export interface SvcParam {
  key: string;
  label: string;
  type: SvcParamType;
  /** required always, or when the other values say so (a reverse proxy's upstream) */
  required?: boolean | ((v: SvcValues) => boolean);
  /** only when the other values say so (written otherwise: an error) */
  when?: (v: SvcValues) => boolean;
  options?: ReadonlyArray<{ id: string; label: string }>;
  suggestions?: readonly string[];
  min?: number;
  max?: number;
  help: string;
  placeholder?: string;
  /** shown in the collapsed Advanced section of its card (an infrequently changed setting, a modelling default) */
  advanced?: boolean;
}

/** A list of entries of a service (a NAT's rules, a Wireless access's networks), each with its parameters. */
export interface SvcList {
  key: string;
  label: string;
  /** what one entry is called ("rule", "network") */
  item: string;
  required?: boolean;
  params: SvcParam[];
}

/** The values of a service (or of one entry), by key, as read. */
export type SvcValues = { [key: string]: unknown };

export interface SvcDef {
  /** its key under `services:` */
  id: string;
  label: string;
  /** its badge in the diagram (at most 5 characters) */
  badge: string;
  help: string;
  /** the types that may run it (before the capability conditions) */
  types: readonly string[];
  /** a capability condition on top: its reason when it is not met */
  needs?: (c: Capabilities, d: DeviceLike) => string | null;
  /** the types it is built into (always there, not removable) */
  builtIn?: readonly string[];
  /** a built-in function whose configuration must be written */
  required?: boolean;
  params: SvcParam[];
  lists?: SvcList[];
  /** read and edited by its own code (DHCP, DNS, the Hypervisor, the Container engine, the VPN gateway, Domain separation, Wireless access) */
  custom?: boolean;
}

const SERVERS = ['server', 'vm', 'container'];
const PORT = { min: 1, max: 65535 };
const routedFirewall = (c: Capabilities): string | null => (c.firewallPolicy && !c.l3Forward ? 'a transparent firewall forwards no IP of its own: make it routed' : null);
const l3Switch = (c: Capabilities): string | null => (c.switchFeatures && !c.l3Forward ? 'a Layer 2 switch routes nothing: tick Supports Layer 3 first' : routedFirewall(c));
const systemHost = (c: Capabilities, d: DeviceLike): string | null => (d.type === 'system' && !c.host ? 'only a System whose purpose is Host runs services' : null);
/** an application runs on a device with an IP stack of its own that is an end system (a host): never on a passive or forwarding-only one */
const hostOnly = (c: Capabilities, d: DeviceLike): string | null => (d.type === 'system' ? systemHost(c, d) : !c.host && !c.serviceHost ? 'it has no host IP stack of its own for applications' : null);

export const SERVICES: ReadonlyArray<SvcDef> = [
  {
    id: 'dhcp',
    label: 'DHCP server',
    badge: 'DHCP',
    help: 'Leases addresses to the clients of its scopes.',
    types: ['router', 'switch', 'firewall', ...SERVERS],
    needs: l3Switch,
    params: [],
    custom: true,
  },
  {
    id: 'dns',
    label: 'DNS server',
    badge: 'DNS',
    help: 'Answers queries for its zones; a router or firewall as a forwarder.',
    types: ['router', 'firewall', ...SERVERS],
    needs: routedFirewall,
    params: [],
    custom: true,
  },
  {
    id: 'ntp',
    label: 'NTP',
    badge: 'NTP',
    help: 'Serves time: its own stratum, or what it takes from its upstreams.',
    types: ['router', 'switch', 'firewall', 'server', 'vm', 'system'],
    needs: systemHost,
    params: [
      { key: 'stratum', label: 'Stratum', type: 'int', min: 1, max: 15, required: (v) => v.upstreams === undefined, help: 'Its own stratum (1: a reference clock), when it has no upstreams.' },
      { key: 'upstreams', label: 'Upstream servers', type: 'addresses', required: (v) => v.stratum === undefined, help: 'The NTP servers it asks (addresses).' },
    ],
  },
  {
    id: 'aaa',
    label: 'AAA',
    badge: 'AAA',
    help: 'Authenticates its clients by RADIUS or TACACS+.',
    types: SERVERS,
    params: [
      { key: 'protocol', label: 'Protocol', type: 'enum', required: true, options: [{ id: 'radius', label: 'RADIUS' }, { id: 'tacacs', label: 'TACACS+' }], help: 'RADIUS (UDP 1812) or TACACS+ (TCP 49).' },
      { key: 'secret', label: 'Shared secret', type: 'secret', required: true, help: 'A placeholder, never the secret itself.', placeholder: '<radius-secret>' },
      { key: 'clients', label: 'Clients', type: 'devices', required: true, help: 'The devices that authenticate against it.' },
    ],
  },
  {
    id: 'syslog',
    label: 'Syslog collector',
    badge: 'LOG',
    help: 'Collects log messages from its senders.',
    types: [...SERVERS, 'system'],
    needs: systemHost,
    params: [
      { key: 'port', label: 'Port', type: 'port', ...PORT, help: 'The port it listens on (514 if empty).', placeholder: '514' },
      { key: 'transport', label: 'Transport', type: 'enum', options: [{ id: 'udp', label: 'UDP' }, { id: 'tcp', label: 'TCP' }], help: 'UDP if empty.' },
      { key: 'senders', label: 'Senders', type: 'devices', help: 'The devices that log to it (besides its syslog relations).' },
    ],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    badge: 'MON',
    help: 'Probes its targets by ICMP and polls them by SNMP.',
    types: [...SERVERS, 'system'],
    needs: systemHost,
    params: [
      { key: 'targets', label: 'Targets', type: 'devices', required: true, help: 'The devices it watches.' },
      { key: 'icmp_interval', label: 'ICMP probe interval', type: 'duration', help: 'How often it pings each target (the device attribute if empty).', placeholder: '10s' },
      { key: 'snmp_interval', label: 'SNMP polling interval', type: 'duration', help: 'How often it polls each target (the device attribute if empty).', placeholder: '1min' },
    ],
  },
  {
    id: 'proxy',
    label: 'Proxy',
    badge: 'PRX',
    help: 'Ends client connections and opens its own to the upstream.',
    types: [...SERVERS, 'firewall'],
    needs: routedFirewall,
    params: [
      { key: 'mode', label: 'Mode', type: 'enum', required: true, options: [{ id: 'forward', label: 'Forward proxy' }, { id: 'reverse', label: 'Reverse proxy' }], help: 'Forward: clients reach out through it. Reverse: it fronts a server.' },
      { key: 'listener', label: 'Listener port', type: 'port', ...PORT, required: true, help: 'The port its clients connect to.', placeholder: '3128' },
      { key: 'upstream', label: 'Upstream address', type: 'address', required: (v) => v.mode === 'reverse', help: 'Where it sends requests (a reverse proxy’s server, a forward proxy’s parent).' },
      { key: 'upstream_port', label: 'Upstream port', type: 'port', ...PORT, required: (v) => v.upstream !== undefined, when: (v) => v.upstream !== undefined, help: 'The upstream’s port.', placeholder: '443' },
    ],
  },
  {
    id: 'load_balancing',
    label: 'Load balancing',
    badge: 'LB',
    help: 'Spreads a virtual service over its healthy backends.',
    types: ['load_balancer', ...SERVERS],
    builtIn: ['load_balancer'],
    params: [
      { key: 'virtual_address', label: 'Virtual address', type: 'address', help: 'The address clients connect to (its own if empty).' },
      { key: 'port', label: 'Service port', type: 'port', ...PORT, help: 'The service’s port (its relations’ if empty).', placeholder: '443' },
      { key: 'backends', label: 'Backends', type: 'devices', help: 'Its pool (its service relations’ servers if empty).' },
      { key: 'algorithm', label: 'Algorithm', type: 'enum', options: [{ id: 'round-robin', label: 'Round robin' }, { id: 'least-connections', label: 'Least connections' }, { id: 'source-hash', label: 'Source hash' }], help: 'The simulation attribute’s if empty.' },
      { key: 'snat', label: 'Source NAT', type: 'bool', help: 'Backends see its address, not the client’s.' },
    ],
  },
  {
    id: 'vpn',
    label: 'VPN gateway',
    badge: 'VPN',
    help: 'Ends site-to-site tunnels or remote-access clients.',
    types: ['vpn_gateway', 'router', 'firewall', 'server', 'vm'],
    needs: routedFirewall,
    builtIn: ['vpn_gateway'],
    required: true,
    params: [],
    custom: true,
  },
  {
    id: 'nat',
    label: 'NAT',
    badge: 'NAT',
    help: 'Translates addresses between its inside and outside interfaces.',
    types: ['router', 'switch', 'firewall', 'load_balancer', 'vpn_gateway', 'vm', 'system'],
    needs: (c) => (!c.l3Forward ? 'NAT is a Layer 3 forwarder’s: it routes nothing' : null),
    params: [
      { key: 'inside', label: 'Inside interfaces', type: 'interfaces', required: true, help: 'The interfaces of the private side.' },
      { key: 'outside', label: 'Outside interfaces', type: 'interfaces', required: true, help: 'The interfaces of the public side.' },
    ],
    lists: [
      {
        key: 'rules',
        label: 'Rules',
        item: 'rule',
        required: true,
        params: [
          { key: 'type', label: 'Type', type: 'enum', required: true, options: [{ id: 'pat', label: 'PAT (source, many to one)' }, { id: 'snat', label: 'Source NAT' }, { id: 'dnat', label: 'Destination NAT (port forward)' }], help: 'What it translates.' },
          { key: 'source', label: 'Source', type: 'prefix', required: (v) => v.type !== 'dnat', when: (v) => v.type !== 'dnat', help: 'The inside addresses it translates (a prefix or any).', placeholder: '192.168.1.0/24' },
          { key: 'to', label: 'Translated to', type: 'address', required: (v) => v.type === 'snat' || v.type === 'dnat', help: 'The new address (PAT: the outside interface’s if empty).' },
          { key: 'port', label: 'Port', type: 'port', ...PORT, required: (v) => v.type === 'dnat', when: (v) => v.type === 'dnat', help: 'The outside port it forwards (destination NAT).' },
          { key: 'to_port', label: 'To port', type: 'port', ...PORT, when: (v) => v.type === 'dnat', help: 'The inside port (the same if empty).' },
          { key: 'protocol', label: 'Protocol', type: 'enum', required: (v) => v.type === 'dnat', when: (v) => v.type === 'dnat', options: [{ id: 'tcp', label: 'TCP' }, { id: 'udp', label: 'UDP' }], help: 'TCP or UDP.' },
        ],
      },
    ],
  },
  {
    id: 'wireless',
    label: 'Wireless access',
    badge: 'WIFI',
    help: 'Its Wi-Fi networks, each bridged to its VLAN.',
    types: ['ap', 'router'],
    builtIn: ['ap'],
    required: true,
    params: [],
    custom: true,
  },
  {
    id: 'wireless_controller',
    label: 'Wireless controller',
    badge: 'WLC',
    help: 'Manages access points (CAPWAP control).',
    types: ['server', 'vm', 'system'],
    needs: systemHost,
    params: [{ key: 'aps', label: 'Managed access points', type: 'devices', required: true, help: 'The access points it manages (each in Controller-managed mode).' }],
  },
  {
    id: 'hypervisor',
    label: 'Hypervisor',
    badge: 'HV',
    help: 'Runs VMs on its virtual switches.',
    types: ['server'],
    params: [],
    custom: true,
  },
  {
    id: 'container_engine',
    label: 'Container engine',
    badge: 'CTR',
    help: 'Runs containers on its container networks.',
    types: ['server', 'vm'],
    params: [],
    custom: true,
  },
  {
    id: 'storage',
    label: 'Storage service',
    badge: 'STOR',
    help: 'Serves storage by NFS, SMB or iSCSI.',
    types: ['storage', 'server', 'vm'],
    params: [
      {
        key: 'protocols',
        label: 'Protocols',
        type: 'portlist',
        required: true,
        options: [{ id: 'nfs', label: 'NFS (TCP 2049)' }, { id: 'smb', label: 'SMB (TCP 445)' }, { id: 'iscsi', label: 'iSCSI (TCP 3260)' }],
        help: 'What it serves: nfs, smb, iscsi.',
        placeholder: 'nfs, iscsi',
      },
    ],
  },
  {
    id: 'applications',
    label: 'Applications',
    badge: 'APP',
    help: 'Its applications: listeners, clients, periodic messages, MQTT clients.',
    types: [...SERVERS, 'storage', 'system', 'endpoint'],
    needs: hostOnly,
    params: [],
    custom: true,
  },
  {
    id: 'inspection',
    label: 'Inspection',
    badge: 'IPS',
    help: 'Inspects what passes: blocks inline, alerts passively.',
    types: ['ids_ips'],
    builtIn: ['ids_ips'],
    params: [{ key: 'block', label: 'Block / alert on', type: 'portlist', help: 'Traffic it acts on (tcp/23, udp/69, icmp): inline it drops it, passive it alerts.', placeholder: 'tcp/23' }],
  },
  {
    id: 'separation',
    label: 'Domain separation',
    badge: 'SEP',
    help: 'Transfers between its two domains only what its policy permits.',
    types: ['security_gateway'],
    builtIn: ['security_gateway'],
    required: true,
    params: [],
    custom: true,
  },
];

/** The service of a key. */
export function serviceDef(id: string): SvcDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

/** Is a service built into a device (its appliance's function: always there, not removable)? */
export function isBuiltIn(s: SvcDef, d: DeviceLike): boolean {
  return !!s.builtIn && s.builtIn.indexOf(d.type) >= 0;
}

/** May a device run a service? Null when it may; else the reason, for the error and the disabled entry in the editor. */
export function serviceEligibility(s: SvcDef, d: DeviceLike): string | null {
  const c = capabilities(d);
  // a Security gateway runs nothing but its Domain separation: nothing passes its boundary by a service
  if (c.securityGateway && s.id !== 'separation') return 'a Security gateway runs no services: nothing may bypass its Domain separation';
  if (s.types.indexOf(d.type) < 0) {
    const who = s.types.map((t) => deviceTypeLabel(t)).filter((x) => !!x);
    return `${s.label} runs on ${listText(who)}${s.builtIn && s.builtIn.length ? ` (built into ${listText(s.builtIn.map((t) => deviceTypeLabel(t)))})` : ''}`;
  }
  return s.needs ? s.needs(c, d) : null;
}

/** The services a device may run, in the registry's order. */
export function eligibleServices(d: DeviceLike): SvcDef[] {
  return SERVICES.filter((s) => serviceEligibility(s, d) === null);
}

/** The built-in functions of a device. */
export function builtInServices(d: DeviceLike): SvcDef[] {
  return SERVICES.filter((s) => isBuiltIn(s, d));
}

/** The service matrix of docs/FORMAT.md: for each type, its built-in functions and the services it may run (with its default mode and purpose). */
export function serviceMatrix(): Array<{ type: string; builtIn: string[]; optional: string[] }> {
  return DEVICE_TYPE_IDS.map((type) => {
    const d: DeviceLike = { type, purpose: type === 'system' ? 'host' : undefined, layer3: true };
    return { type, builtIn: builtInServices(d).map((s) => s.id), optional: eligibleServices(d).filter((s) => !isBuiltIn(s, d)).map((s) => s.id) };
  });
}

function listText(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join('');
  return xs.slice(0, -1).join(', ') + ' or ' + xs[xs.length - 1];
}

/** What a device has of a service: configured (or, a built-in function, there in any case). */
interface HasServices {
  type: string;
  netServices?: { dhcp?: unknown; dns?: unknown };
  vpn?: unknown;
  separation?: unknown;
  wireless?: unknown;
  hypervisor?: unknown;
  containerEngine?: unknown;
  appServices?: Map<string, unknown>;
  /** its application instances (services.applications) */
  applications?: unknown[];
}

/** The services a device runs, in the registry's order (its built-in functions among them). */
export function deviceServices(d: HasServices): SvcDef[] {
  const on = (s: SvcDef): boolean => {
    switch (s.id) {
      case 'dhcp':
        return !!d.netServices && !!d.netServices.dhcp;
      case 'dns':
        return !!d.netServices && !!d.netServices.dns;
      case 'vpn':
        return !!d.vpn;
      case 'separation':
        return !!d.separation;
      case 'wireless':
        return !!d.wireless;
      case 'hypervisor':
        return !!d.hypervisor;
      case 'container_engine':
        return !!d.containerEngine;
      case 'applications':
        return !!d.applications && d.applications.length > 0;
    }
    return (!!d.appServices && d.appServices.has(s.id)) || (!!s.builtIn && s.builtIn.indexOf(d.type) >= 0 && !s.required);
  };
  return SERVICES.filter(on);
}

/** At most this many service badges are written under a device; the rest are counted ("+2"). */
export const MAX_BADGES = 3;

/** A device's service badges as its line in the diagram: "DHCP · DNS · VPN +2" ('' without services). */
export function serviceBadgesText(d: HasServices): string {
  const all = deviceServices(d);
  if (!all.length) return '';
  const n = d.applications ? d.applications.length : 0;
  // the applications are one badge, with their number ("APP×3"): never one per application
  const badge = (s: SvcDef): string => (s.id === 'applications' && n > 1 ? `APP×${n}` : s.badge);
  const shown = all.slice(0, MAX_BADGES).map(badge).join(' · ');
  return all.length > MAX_BADGES ? `${shown} +${all.length - MAX_BADGES}` : shown;
}

/** Every service of a device in words (the badges' tooltip, the details). */
export function serviceListText(d: HasServices): string {
  const n = d.applications ? d.applications.length : 0;
  return deviceServices(d).map((s) => (s.id === 'applications' ? `${n} application${n === 1 ? '' : 's'} (APP)` : `${s.label} (${s.badge})`)).join(', ');
}

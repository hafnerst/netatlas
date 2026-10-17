/**
 * Application instances (`services.applications`): the applications a
 * device runs, each an entry of its own with a stable id (unique on the
 * device), a readable name and a profile. The profile says what the
 * application does on the network and which fields it has:
 *
 *   tcp_server    TCP listener: accepts connections on its port and answers
 *                 each request;
 *   tcp_client    TCP client: opens a connection to its peer, sends a
 *                 request and waits for the answer;
 *   udp_server    UDP listener: answers each datagram on its port;
 *   udp_client    UDP client: sends a request datagram, waits for the answer;
 *   udp_receiver  UDP receiver: takes datagrams on its port, answers none;
 *   udp_sender    periodic one-way UDP messages to its peer;
 *   mqtt_client   an MQTT 3.1.1 client of a broker: publishes to its topics,
 *                 receives what matches its subscriptions.
 *
 * These are generic transport behaviours: a label such as "Modbus TCP"
 * names the application, it never makes NetAtlas simulate that protocol's
 * semantics. A listener is reached by its port (and its bind interface,
 * when written); a client names its peer, either an application of another
 * device ("plc/registers": device id, slash, application id, whose port it
 * takes), or a device, address or host name together with a port.
 *
 * The fields are the registry's parameter definitions (service-registry.ts
 * SvcParam), each with the profiles it applies to: validation reads them,
 * the editor's Services card shows the basic ones of the selected profile
 * and the others in a collapsed Advanced section. Nothing runs because an
 * application exists: a client sends only when Network events start it, or
 * at the simulation's start when its `start` says so.
 */
import type { SvcParam, SvcValues } from './service-registry';
import type { Support } from './support';

export type AppProfileId = 'tcp_server' | 'tcp_client' | 'udp_server' | 'udp_client' | 'udp_receiver' | 'udp_sender' | 'mqtt_client';

/** What an application does, in its profile's terms. */
export interface AppProfile {
  id: AppProfileId;
  label: string;
  /** the summary's short word ("TCP listener", "MQTT publisher" is the role's) */
  short: string;
  help: string;
  transport: 'tcp' | 'udp';
  /** listens on a port (others reach it) */
  listener: boolean;
  /** sends to a peer (a client, a sender, an MQTT client) */
  client: boolean;
  /** a client that waits for an answer to each message */
  answered: boolean;
  /** the listener profiles a client of this profile may name as its peer */
  peerProfiles: AppProfileId[];
  /** the conventional port of the profile (a default after the profile is chosen, never a requirement) */
  port?: number;
  /** what the simulation does for it (model/support.ts) */
  support: Support;
}

const TCP_SUPPORT: Support = {
  level: 'modeled',
  does: 'Connections (the three-way handshake, retransmission, FIN) with a request and its answer of the sizes in effect cross the network: addressing, routing, firewall policy and closed ports apply.',
  not: 'payload contents and application semantics: a name such as Modbus TCP labels it, nothing of Modbus is simulated.',
};
const UDP_SUPPORT: Support = {
  level: 'modeled',
  does: 'Datagrams (and their answers, for request/response) of the sizes in effect cross the network: addressing, routing, firewall policy and closed ports (ICMP port unreachable) apply.',
  not: 'payload contents and application semantics: a label names the application, its protocol is not simulated.',
};
const MQTT_SUPPORT: Support = {
  level: 'modeled',
  does: 'MQTT 3.1.1 over TCP: CONNECT / CONNACK, SUBSCRIBE / SUBACK with + and # filters, PUBLISH through the broker to the matching subscribers, QoS 0 and QoS 1 (PUBACK, DUP retries), UNSUBSCRIBE, DISCONNECT, keep alive with PINGREQ and reconnection.',
  not: 'QoS 2, persistent sessions (every session is clean), retained messages, wills, authentication, TLS and payload contents.',
};

export const APP_PROFILES: readonly AppProfile[] = [
  { id: 'tcp_server', label: 'TCP listener (request/response)', short: 'TCP listener', help: 'Accepts TCP connections on its port and answers each request.', transport: 'tcp', listener: true, client: false, answered: false, peerProfiles: [], support: TCP_SUPPORT },
  { id: 'tcp_client', label: 'TCP client (request/response)', short: 'TCP request/response', help: 'Connects to its peer, sends a request and waits for the answer.', transport: 'tcp', listener: false, client: true, answered: true, peerProfiles: ['tcp_server'], support: TCP_SUPPORT },
  { id: 'udp_server', label: 'UDP listener (request/response)', short: 'UDP listener', help: 'Answers each datagram that arrives on its port.', transport: 'udp', listener: true, client: false, answered: false, peerProfiles: [], support: UDP_SUPPORT },
  { id: 'udp_client', label: 'UDP client (request/response)', short: 'UDP request/response', help: 'Sends a request datagram to its peer and waits for the answer.', transport: 'udp', listener: false, client: true, answered: true, peerProfiles: ['udp_server'], support: UDP_SUPPORT },
  { id: 'udp_receiver', label: 'UDP receiver (one-way)', short: 'UDP receiver', help: 'Takes datagrams on its port and answers none.', transport: 'udp', listener: true, client: false, answered: false, peerProfiles: [], support: UDP_SUPPORT },
  { id: 'udp_sender', label: 'Periodic UDP messages (one-way)', short: 'UDP messages', help: 'Sends a datagram to its peer every interval; nothing comes back.', transport: 'udp', listener: false, client: true, answered: false, peerProfiles: ['udp_receiver', 'udp_server'], support: UDP_SUPPORT },
  { id: 'mqtt_client', label: 'MQTT client (publish / subscribe)', short: 'MQTT', help: 'An MQTT 3.1.1 client: publishes to its topics, receives what matches its filters.', transport: 'tcp', listener: false, client: true, answered: false, peerProfiles: [], port: 1883, support: MQTT_SUPPORT },
];

export function appProfile(id: string | undefined): AppProfile | undefined {
  return APP_PROFILES.find((p) => p.id === id);
}

const PORT = { min: 1, max: 65535 };
const is = (...ids: AppProfileId[]) => (v: SvcValues): boolean => ids.indexOf(v.profile as AppProfileId) >= 0;
const LISTENERS: AppProfileId[] = ['tcp_server', 'udp_server', 'udp_receiver'];
const PEERED: AppProfileId[] = ['tcp_client', 'udp_client', 'udp_sender'];
const SENDING: AppProfileId[] = ['tcp_client', 'udp_client', 'udp_sender', 'mqtt_client'];
const ANSWERING: AppProfileId[] = ['tcp_server', 'udp_server'];
const ASKING: AppProfileId[] = ['tcp_client', 'udp_client'];

/** Does the peer as written name another device's application ("device/app")? Then the port is that application's. */
export function peerIsApp(v: SvcValues): boolean {
  return typeof v.peer === 'string' && v.peer.indexOf('/') > 0;
}

/**
 * The fields of an application, in their order (the editor shows them in
 * it): the profile's basic fields first, the advanced ones (`advanced`)
 * collapsed. `when` says which profiles a field belongs to; written for
 * another profile, it is an error.
 */
export const APP_PARAMS: SvcParam[] = [
  { key: 'id', label: 'Id', type: 'text', required: true, help: 'Its id, unique on the device; other applications name it by it ("device/id").', placeholder: 'app1' },
  { key: 'name', label: 'Name', type: 'text', required: true, help: 'What it is called (a label: "Modbus TCP" names it, it does not simulate Modbus).', placeholder: 'Management' },
  { key: 'profile', label: 'Profile', type: 'enum', required: true, options: APP_PROFILES.map((p) => ({ id: p.id, label: p.label })), help: 'What it does on the network: its transport, listening or sending, and its fields.' },
  // listeners
  { key: 'port', label: 'Port', type: 'port', ...PORT, required: (v) => LISTENERS.indexOf(v.profile as AppProfileId) >= 0 || (PEERED.indexOf(v.profile as AppProfileId) >= 0 && !peerIsApp(v)), when: (v) => LISTENERS.indexOf(v.profile as AppProfileId) >= 0 || (PEERED.indexOf(v.profile as AppProfileId) >= 0 && !peerIsApp(v)), help: 'A listener: its port. A client: the peer’s port (an application peer has its own).', placeholder: '443' },
  // clients
  { key: 'peer', label: 'Peer', type: 'text', required: is(...PEERED), when: is(...PEERED), help: 'An application (device/application), or a device, address or host name with a port.', placeholder: 'plc/registers' },
  { key: 'broker', label: 'Broker', type: 'text', required: is('mqtt_client'), when: is('mqtt_client'), help: 'The device whose MQTT broker service it connects to.', placeholder: 'broker' },
  { key: 'client_id', label: 'Client identifier', type: 'text', when: is('mqtt_client'), help: 'Unique at its broker (a second one takes the session over). Empty: device-application.', placeholder: 'device-app' },
  { key: 'publish', label: 'Publishes to', type: 'topics', when: is('mqtt_client'), help: 'The topics it publishes to (no wildcards), one message to each every interval.', placeholder: 'sensors/room1/temperature' },
  { key: 'subscribe', label: 'Subscribes to', type: 'topics', when: is('mqtt_client'), help: 'Its topic filters: + matches one level, # the rest (sensors/+/temperature, sensors/#).', placeholder: 'sensors/#' },
  { key: 'qos', label: 'QoS', type: 'enum', when: is('mqtt_client'), options: [{ id: '0', label: '0: at most once' }, { id: '1', label: '1: at least once (PUBACK)' }], help: 'Of its publications and subscriptions (QoS 2 is not modelled). Empty: 0.' },
  { key: 'interval', label: 'Interval', type: 'duration', when: is(...SENDING), help: 'Between two messages (MQTT: publications). Empty: one message each time it is started.', placeholder: '5s' },
  { key: 'count', label: 'Messages', type: 'int', min: 1, max: 10000, when: is(...SENDING), help: 'How many it sends each time it is started (with an interval; empty: until stopped).', placeholder: 'until stopped' },
  { key: 'start', label: 'Starts', type: 'enum', when: is(...SENDING), options: [{ id: 'manual', label: 'When started from Network events' }, { id: 'simulation_start', label: 'With the simulation' }], help: 'Empty: only when you start it from Network events (Start application).' },
  // advanced
  { key: 'payload_size', label: 'Payload size (bytes)', type: 'int', min: 0, max: 65000, advanced: true, when: is('mqtt_client'), help: 'Of each publication’s payload (a modelling default of 64 bytes if empty).', placeholder: '64' },
  { key: 'request_size', label: 'Request size (bytes)', type: 'int', min: 1, max: 65000, advanced: true, when: is(...PEERED), help: 'Of each request or message (a modelling default if empty: 120 bytes TCP, 40 UDP).', placeholder: '120' },
  { key: 'response_size', label: 'Response size (bytes)', type: 'int', min: 1, max: 65000, advanced: true, when: is(...ANSWERING), help: 'Of each answer (a modelling default if empty: 1460 bytes TCP, 200 UDP).', placeholder: '1460' },
  { key: 'response_delay', label: 'Response delay', type: 'duration', advanced: true, when: is(...ANSWERING), help: 'Its processing time before it answers (empty: the device’s service response time).', placeholder: '5ms' },
  { key: 'timeout', label: 'Timeout', type: 'duration', advanced: true, when: is(...ASKING), help: 'How long it waits for an answer (the device’s application response timeout if empty).', placeholder: '5s' },
  { key: 'retries', label: 'Retries', type: 'int', min: 0, max: 10, advanced: true, when: is(...ASKING), help: 'How often a request that timed out is sent again before it counts as failed. Empty: 0.', placeholder: '0' },
  { key: 'ip_version', label: 'IP version', type: 'enum', advanced: true, when: is(...SENDING), options: [{ id: '4', label: 'IPv4' }, { id: '6', label: 'IPv6' }], help: 'Its address family to the peer. Empty: IPv4 (an address peer: its own); no fallback.' },
  { key: 'keepalive', label: 'Keep alive', type: 'duration', advanced: true, when: is('mqtt_client'), help: 'PINGREQ after this much silence; the broker drops it after 1.5 × (empty: 60 s, a default).', placeholder: '60s' },
  { key: 'retry_interval', label: 'QoS 1 retry interval', type: 'duration', advanced: true, when: is('mqtt_client'), help: 'A QoS 1 PUBLISH without PUBACK goes again (DUP) after this (empty: 20 s, a default).', placeholder: '20s' },
  { key: 'bind', label: 'Bind interface', type: 'interface', advanced: true, when: is(...LISTENERS), help: 'Listen on this interface’s addresses only. Empty: on all of them.' },
  { key: 'description', label: 'Description', type: 'text', advanced: true, help: 'Free text.' },
];

/** The modelling defaults of the profiles (shown in the fields' placeholders and the event log, never written for the user). */
export const APP_DEFAULTS = {
  tcpRequest: 120,
  tcpResponse: 1460,
  udpRequest: 40,
  udpResponse: 200,
  mqttPayload: 64,
  mqttKeepalive: 60000,
  mqttRetry: 20000,
} as const;

/** An application as read (the model's). */
export interface AppInstance {
  id: string;
  name: string;
  profile: AppProfileId;
  port?: number;
  peer?: string;
  broker?: string;
  clientId?: string;
  publish: string[];
  subscribe: string[];
  qos?: 0 | 1;
  /** ms */
  interval?: number;
  count?: number;
  start: 'manual' | 'simulation_start';
  payloadSize?: number;
  requestSize?: number;
  responseSize?: number;
  /** ms */
  responseDelay?: number;
  timeout?: number;
  retries?: number;
  ipVersion?: 4 | 6;
  keepalive?: number;
  retryInterval?: number;
  bind?: string;
  description?: string;
  line: number;
}

/** A peer as written: another device's application, or a device, address or name with the port. */
export interface PeerRef {
  text: string;
  /** an application of a device ("plc/registers") */
  device?: string;
  app?: string;
}

export function parsePeer(text: string): PeerRef {
  const i = text.indexOf('/');
  if (i > 0 && text.indexOf(':') < 0) return { text, device: text.slice(0, i), app: text.slice(i + 1) };
  return { text };
}

/** The MQTT client's identifier in effect: its own, else device-application. */
export function mqttClientId(device: string, a: { id: string; clientId?: string }): string {
  return a.clientId || `${device}-${a.id}`;
}

/** The MQTT role a client has by its topics: publisher, subscriber, both, or none yet. */
export function mqttRole(a: { publish: string[]; subscribe: string[] }): 'publisher' | 'subscriber' | 'publisher and subscriber' | 'client' {
  const p = a.publish.length > 0;
  const s = a.subscribe.length > 0;
  return p && s ? 'publisher and subscriber' : p ? 'publisher' : s ? 'subscriber' : 'client';
}

/**
 * The one-line summary of an application (its collapsed entry in the
 * Services card, the badge's tooltip, the details):
 * "Management · TCP listener · 443", "Control · UDP request/response · controller/app",
 * "Telemetry · MQTT publisher · broker / sensors/room1".
 */
export function appSummary(a: { name?: string; id: string; profile?: string; port?: number; peer?: string; broker?: string; publish?: string[]; subscribe?: string[] }): string {
  const p = appProfile(a.profile);
  const name = a.name || a.id;
  if (!p) return `${name} · no profile yet`;
  if (p.id === 'mqtt_client') {
    const pub = a.publish || [];
    const sub = a.subscribe || [];
    const role = mqttRole({ publish: pub, subscribe: sub });
    const topics = pub.concat(sub);
    return `${name} · MQTT ${role} · ${a.broker || '(no broker)'}${topics.length ? ' / ' + topics[0] + (topics.length > 1 ? ` +${topics.length - 1}` : '') : ''}`;
  }
  if (p.listener) return `${name} · ${p.short} · ${a.port !== undefined ? a.port : '(no port)'}`;
  const to = a.peer ? (a.peer.indexOf('/') > 0 ? a.peer : `${a.peer}${a.port !== undefined ? ':' + a.port : ''}`) : '(no peer)';
  return `${name} · ${p.short} · ${to}`;
}

/** Has the topic filter valid MQTT 3.1.1 wildcards (+ a whole level, # last and a whole level)? Null when it has; else why not. */
export function topicFilterProblem(f: string): string | null {
  if (!f.length) return 'is empty';
  if (f.length > 200) return 'is longer than 200 characters';
  const levels = f.split('/');
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (l.indexOf('#') >= 0 && (l !== '#' || i !== levels.length - 1)) return 'has # elsewhere than as its whole last level';
    if (l.indexOf('+') >= 0 && l !== '+') return 'has + inside a level (it must be the whole level)';
  }
  return null;
}

/** Is it a valid topic name to publish to (no wildcards)? Null when it is. */
export function topicNameProblem(t: string): string | null {
  if (!t.length) return 'is empty';
  if (t.length > 200) return 'is longer than 200 characters';
  if (/[+#]/.test(t)) return 'has a wildcard (+ or #): a publication goes to one topic';
  return null;
}

/**
 * Does a topic name match a topic filter (MQTT 3.1.1 §4.7)? "+" matches
 * exactly one level, "#" any number of levels including the parent's
 * ("sport/#" matches "sport"); a filter starting with a wildcard never
 * matches a topic starting with "$".
 */
export function topicMatches(filter: string, topic: string): boolean {
  if (topic.charAt(0) === '$' && (filter.charAt(0) === '+' || filter.charAt(0) === '#')) return false;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

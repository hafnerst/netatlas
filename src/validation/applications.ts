/**
 * A device's application instances (`services.applications`,
 * model/applications.ts): read by their profile's fields, then checked with
 * the whole model.
 *
 * Per device: ids unique, the profile's required fields written and none of
 * another profile's, an interval for a message count, MQTT topics without
 * wildcards and filters with valid ones, and no two listeners claiming the
 * same transport, port and address (two on the same port are fine on two
 * explicit bind interfaces), nor one on a port a service of the device
 * already listens on.
 *
 * With the whole model: a peer names a device of the model and, written
 * "device/app", one of its applications whose profile answers this one's
 * (a TCP client a TCP listener …); an MQTT client's broker runs the MQTT
 * broker service; client identifiers are unique per broker; a bind
 * interface exists on the device.
 */
import { APP_PARAMS, AppInstance, AppProfileId, appProfile, mqttClientId, parsePeer, topicFilterProblem, topicNameProblem } from '../model/applications';
import { parseAddress } from '../model/ip';
import { Device, Model, deviceInterfaces } from '../model/types';
import { dnsNameProblem } from '../model/dns';
import { Listener, appListeners, listenersConflict, serviceListeners } from '../analysis/listeners';
import { YMap, YNode } from '../yaml/parse';
import { Ctx, ID_RE, Reader, get, isNull, suggest } from './reader';
import { ServiceNodes, readParams } from './services';

/** Where a device's applications were written. */
export interface AppNodes {
  device: string;
  list: YNode;
  path: string;
  items: Array<{ app: AppInstance; node: YMap; path: string }>;
}

/** Read `services.applications` of a device into `dev.applications`. */
export function readApplications(r: Reader, c: Ctx, n: YNode, path: string, dev: Device, nodes: ServiceNodes): AppNodes {
  const out: AppNodes = { device: dev.id, list: n, path, items: [] };
  dev.applications = [];
  const items = isNull(n) ? [] : r.list(n, path);
  items.forEach((it, k) => {
    const ip = `${path}[${k}]`;
    const m = r.map(it, ip);
    if (!m) return;
    r.keys(m, APP_PARAMS.map((p) => p.key), ip);
    const v = readParams(r, c, APP_PARAMS, m, it, ip, nodes, `application ${k + 1}`);
    const id = typeof v.id === 'string' ? v.id : undefined;
    if (id !== undefined && !ID_RE.test(id)) {
      c.error(get(m, 'id') as YNode, ip + '.id', `"${id}" is not an application id: letters, digits, "_", "." and "-" (other applications name it "${dev.id}/<id>")`);
      return;
    }
    if (id === undefined) return;
    if (dev.applications!.some((a) => a.id === id)) {
      c.error(get(m, 'id') as YNode, ip + '.id', `duplicate application "${id}" on "${dev.id}": each application of a device has its own id`);
      return;
    }
    const prof = appProfile(v.profile as string);
    const num = (key: string): number | undefined => (typeof v[key] === 'number' ? (v[key] as number) : undefined);
    const app: AppInstance = {
      id,
      name: typeof v.name === 'string' ? v.name : id,
      profile: (prof ? prof.id : 'tcp_server') as AppProfileId,
      port: num('port'),
      peer: typeof v.peer === 'string' ? (v.peer as string).trim() : undefined,
      broker: typeof v.broker === 'string' ? (v.broker as string).trim() : undefined,
      clientId: typeof v.client_id === 'string' ? (v.client_id as string) : undefined,
      publish: Array.isArray(v.publish) ? (v.publish as string[]) : [],
      subscribe: Array.isArray(v.subscribe) ? (v.subscribe as string[]) : [],
      qos: v.qos === '1' ? 1 : v.qos === '0' ? 0 : undefined,
      interval: num('interval'),
      count: num('count'),
      start: v.start === 'simulation_start' ? 'simulation_start' : 'manual',
      payloadSize: num('payload_size'),
      requestSize: num('request_size'),
      responseSize: num('response_size'),
      responseDelay: num('response_delay'),
      timeout: num('timeout'),
      retries: num('retries'),
      ipVersion: v.ip_version === '6' ? 6 : v.ip_version === '4' ? 4 : undefined,
      keepalive: num('keepalive'),
      retryInterval: num('retry_interval'),
      bind: typeof v.bind === 'string' ? (v.bind as string) : undefined,
      description: typeof v.description === 'string' ? (v.description as string) : undefined,
      line: m.line,
    };
    if (!prof) return;
    dev.applications!.push(app);
    out.items.push({ app, node: m, path: ip });
    // a count says how many messages each start sends: with an interval between them
    if (app.count !== undefined && app.count > 1 && app.interval === undefined) c.error(get(m, 'count') as YNode, ip + '.count', `"${id}" sends ${app.count} messages each time it is started: write the interval between them`, {});
    if (prof.id === 'mqtt_client') {
      if (!app.publish.length && !app.subscribe.length) c.error(m, ip + '.publish', `MQTT client "${id}" needs a topic to publish to or a topic filter to subscribe to`, { key: 'publish' });
      for (const t of app.publish) {
        const why = topicNameProblem(t);
        if (why) c.error(get(m, 'publish') as YNode, ip + '.publish', `the topic "${t}" ${why}`);
      }
      for (const f of app.subscribe) {
        const why = topicFilterProblem(f);
        if (why) c.error(get(m, 'subscribe') as YNode, ip + '.subscribe', `the topic filter "${f}" ${why}`);
      }
      if (app.interval !== undefined && !app.publish.length) c.error(get(m, 'interval') as YNode, ip + '.interval', `"${id}" publishes to no topic: its interval does not apply — delete it, or add a topic under "publish"`);
      if (app.clientId !== undefined && !/^[A-Za-z0-9_.\-]{1,64}$/.test(app.clientId)) c.error(get(m, 'client_id') as YNode, ip + '.client_id', `"${app.clientId}" is not a client identifier: letters, digits, "_", "." and "-" (up to 64; MQTT 3.1.1 servers must accept 1–23 of 0-9, a-z, A-Z)`);
    }
    if (app.peer !== undefined && prof.client && prof.id !== 'mqtt_client') {
      const pr = parsePeer(app.peer);
      if (!pr.device && !parseAddress(app.peer) && !ID_RE.test(app.peer) && dnsNameProblem(app.peer)) c.error(get(m, 'peer') as YNode, ip + '.peer', `"${app.peer}" is no application (device/application), device, IP address or host name`);
      const a = parseAddress(app.peer);
      if (a && app.ipVersion !== undefined && a.version !== app.ipVersion) c.error(get(m, 'ip_version') as YNode, ip + '.ip_version', `the peer ${app.peer} is an IPv${a.version} address: it is reached by IPv${a.version} — delete "ip_version"`);
    }
  });
  // listeners: no two on the same transport, port and address, none on a port a service listens on
  const mine = appListeners(dev);
  const svc = serviceListeners(dev);
  mine.forEach((x, k) => {
    const at = out.items.find((y) => y.app.id === x.app) as AppNodes['items'][number];
    const clash = mine.slice(0, k).find((y) => listenersConflict(x, y)) || svc.find((y) => listenersConflict(x, y));
    if (clash) c.error(get(at.node, 'port') as YNode, at.path + '.port', `"${x.app}" and ${clash.app ? `"${clash.app}"` : `the ${clash.owner}`} both listen on ${x.proto.toUpperCase()} ${x.port}${bindText(x, clash)}: give one another port, or bind each to its own interface`);
  });
  return out;
}

function bindText(a: Listener, b: Listener): string {
  if (a.bind === undefined && b.bind === undefined) return ' on all addresses';
  if (a.bind !== undefined && a.bind === b.bind) return ` on ${a.bind}`;
  return ` (${a.bind === undefined ? 'one on all addresses' : 'one on ' + a.bind}, ${b.bind === undefined ? 'the other on all' : 'the other on ' + b.bind})`;
}

/** The applications' references, with the whole model. */
export function checkApplications(c: Ctx, model: Model, all: AppNodes[]): void {
  const devs = model.index.devices;
  const clientIds = new Map<string, Map<string, string>>();
  for (const an of all) {
    const d = devs.get(an.device);
    if (!d) continue;
    const ifIds = deviceInterfaces(d).map((i) => i.id);
    for (const { app, node, path } of an.items) {
      const prof = appProfile(app.profile);
      if (!prof) continue;
      if (app.bind !== undefined && ifIds.indexOf(app.bind) < 0) c.error(get(node, 'bind') as YNode, path + '.bind', `"${d.id}" has no interface "${app.bind}"${suggest(app.bind, ifIds)}`);
      if (prof.id === 'mqtt_client' && app.broker !== undefined) {
        const b = devs.get(app.broker);
        if (!b) c.error(get(node, 'broker') as YNode, path + '.broker', `"${app.broker}" is not a device of the model${suggest(app.broker, Array.from(devs.keys()))}`);
        else if (!b.appServices || !b.appServices.has('mqtt_broker')) c.error(get(node, 'broker') as YNode, path + '.broker', `"${app.broker}" runs no MQTT broker service: add it there (Services → Add service → MQTT broker)`);
        else {
          const ids = clientIds.get(b.id) || new Map<string, string>();
          clientIds.set(b.id, ids);
          const cid = mqttClientId(d.id, app);
          const other = ids.get(cid);
          if (other) c.error((get(node, 'client_id') || node) as YNode, path + '.client_id', `the client identifier "${cid}" is already used at the broker ${b.id} by ${other}: each client of a broker needs its own (a second CONNECT with it takes over the first's session)`, get(node, 'client_id') ? {} : { key: 'client_id' });
          else ids.set(cid, `${d.id}/${app.id}`);
        }
      }
      if (app.peer === undefined || !prof.client || prof.id === 'mqtt_client') continue;
      const pr = parsePeer(app.peer);
      const peerNode = get(node, 'peer') as YNode;
      if (pr.device !== undefined) {
        const pd = devs.get(pr.device);
        if (!pd) {
          c.error(peerNode, path + '.peer', `"${pr.device}" is not a device of the model${suggest(pr.device, Array.from(devs.keys()))}`);
          continue;
        }
        const target = (pd.applications || []).find((x) => x.id === pr.app);
        if (!target) {
          const ids = (pd.applications || []).map((x) => x.id);
          c.error(peerNode, path + '.peer', `"${pd.id}" has no application "${pr.app}"${suggest(pr.app || '', ids)}${ids.length ? '' : ' (it has no applications)'}`);
          continue;
        }
        if (prof.peerProfiles.indexOf(target.profile) < 0) {
          const tp = appProfile(target.profile);
          c.error(peerNode, path + '.peer', `"${app.peer}" is a ${tp ? tp.label : target.profile}: a ${prof.label} needs a ${prof.peerProfiles.map((x) => (appProfile(x) as { label: string }).label).join(' or ')}`);
        }
        if (pd.id === d.id) c.warn(peerNode, path + '.peer', `"${app.id}" names an application of its own device: its messages never leave ${d.id}`);
      } else if (!parseAddress(app.peer) && devs.has(app.peer) === false && ID_RE.test(app.peer) && app.peer.indexOf('.') < 0) {
        c.error(peerNode, path + '.peer', `"${app.peer}" is not a device of the model${suggest(app.peer, Array.from(devs.keys()))} (an address or a host name with a dot are taken as such)`);
      }
    }
  }
}

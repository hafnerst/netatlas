/**
 * The `simulation:` blocks: a device's simulation attributes and a cable's
 * simulation settings (analysis/sim/params.ts has the registry). Only
 * overrides are written; every key is checked against the registry (an
 * unknown one is an error, with a suggestion), against the device's type
 * (an attribute that does not apply to it is an error) and for its range
 * and unit.
 */
import { Applies, ParamDef, ParamLevel, ParamValue, PARAMS, deviceParamByYaml, deviceWide, formatValue, interfaceParams, levelParams, levelText, paramDef, parseValue, relationParams } from '../analysis/sim/params';
import { ifaceFacts, deviceFacts, relFacts } from '../analysis/sim/attrs';
import { deviceTypeLabel, NO_DEVICE_TYPE } from '../model/device-types';
import { DeviceLike, capabilities } from '../model/capabilities';
import { LinkSimulation, Model } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { Ctx, Reader, get, isNull, kindOf, suggest } from './reader';

/** Could an attribute apply to a device like this (its type, layer, mode, purpose; the Inspector narrows it by what the device has)? */
export function typeAllows(a: Applies, d: DeviceLike): boolean {
  const c = capabilities(d);
  switch (a) {
    case 'all':
      return true;
    case 'ip':
    case 'aggregate':
      return !c.externalTransit && !c.passThrough;
    case 'dhcp':
      return c.networkServices;
    case 'router':
      return c.l3Forward;
    case 'vpn':
      return c.l3Forward || c.vpnTermination;
    case 'switch':
      return c.switchFeatures;
    case 'firewall':
      return c.firewallPolicy;
    case 'ids':
      return c.inspection;
    case 'host':
      return c.serviceHost;
    case 'hypervisor':
      return c.canHostGuests.vms;
    case 'engine':
      return c.canHostGuests.containers;
    case 'container':
      return c.canBeGuest === 'container';
    case 'monitor':
      return c.monitoring || c.host;
    case 'cloud':
      return c.externalTransit;
    case 'ap':
      return c.wirelessAccess;
    case 'endpoint':
      return c.testTraffic;
    case 'lb':
      return c.loadBalancing;
    case 'separation':
      return c.securityGateway;
  }
  return false;
}

/** The device attributes a device like this may have (device-wide ones, and the device-wide defaults of object attributes), in order. */
export function typeParams(d: DeviceLike): ParamDef[] {
  return PARAMS.filter((p) => !!p.device && deviceWide(p) && p.device.some((a) => typeAllows(a, d)));
}

function scalarValue(n: YNode): unknown {
  return n.kind === 'scalar' ? n.value : undefined;
}

/** A device's `simulation:` block: its attributes by registry key. */
export function readDeviceSimulation(r: Reader, c: Ctx, n: YNode | undefined, path: string, id: string, d: DeviceLike): Map<string, ParamValue> | undefined {
  const type = d.type;
  if (isNull(n)) return undefined;
  const m = r.map(n, path);
  const out = new Map<string, ParamValue>();
  if (!m) return out;
  const allowed = typeParams(d);
  const what = type === NO_DEVICE_TYPE ? 'a device without a type' : `a ${deviceTypeLabel(type) || type}`;
  m.entries.forEach((e, k) => {
    const def = deviceParamByYaml(k);
    const node = e.value;
    if (!def) {
      c.error(m, `${path}.${k}`, `unknown simulation attribute "${k}"${suggest(k, allowed.map((p) => p.yaml), 30)}`, { key: k, line: e.keyLine });
      return;
    }
    if (!deviceWide(def)) {
      // an attribute of a port, a VLAN or a relation: written there, never moved by itself
      c.error(m, `${path}.${k}`, `"${k}" (${def.label.toLowerCase()}) is set ${levelText(def)}, not for the whole device`, { key: k, line: e.keyLine });
      return;
    }
    if (allowed.indexOf(def) < 0) {
      c.error(m, `${path}.${k}`, `"${k}" (${def.label.toLowerCase()}) does not apply to "${id}", ${what}`, { key: k, line: e.keyLine });
      return;
    }
    // a list may be written as a YAML sequence of scalars as well
    const seq = def.kind === 'list' && node.kind === 'seq' && node.items.every((x) => x.kind === 'scalar' && !isNull(x));
    if (!seq && (node.kind !== 'scalar' || isNull(node))) {
      c.error(node, `${path}.${k}`, `expected a single value but found ${kindOf(node)}`);
      return;
    }
    const p = parseValue(def, seq && node.kind === 'seq' ? node.items.map((x) => scalarValue(x)) : scalarValue(node));
    if ('error' in p) {
      c.error(node, `${path}.${k}`, `${def.label} ${p.error}${def.kind === 'duration' ? ` (a bare number is in ${def.base === 'ms' ? 'milliseconds' : 'seconds'})` : ''}`);
      return;
    }
    out.set(def.key, p.value);
  });
  return out;
}

/** An object's `simulation:` block as read: its values, and where each was written (the applicability is checked with the whole model). */
export interface SimBlock {
  values: Map<string, ParamValue>;
  map: YMap;
  path: string;
  lines: Map<string, number>;
}

const LEVEL_NAME: { [l in ParamLevel]: string } = { device: 'a device', interface: 'an interface', vlan: 'a VLAN (a network)', relation: 'a relation', service: 'a DHCP scope or DNS zone' };

/**
 * An interface's, a network's (its VLAN's) or a relation's `simulation:`
 * block: every key must be an attribute of that level. One of another level
 * is an error that says where it belongs (it is not moved by itself).
 */
export function readSimBlock(r: Reader, c: Ctx, n: YNode | undefined, path: string, level: ParamLevel): SimBlock | undefined {
  if (isNull(n)) return undefined;
  const m = r.map(n, path);
  if (!m) return undefined;
  const out: SimBlock = { values: new Map(), map: m, path, lines: new Map() };
  const here = levelParams(level);
  m.entries.forEach((e, k) => {
    const def = deviceParamByYaml(k);
    const node = e.value;
    if (!def) {
      c.error(m, `${path}.${k}`, `unknown simulation attribute "${k}"${suggest(k, here.map((p) => p.yaml), 30)}`, { key: k, line: e.keyLine });
      return;
    }
    if ((def.level || 'device') !== level) {
      c.error(m, `${path}.${k}`, `"${k}" (${def.label.toLowerCase()}) is set ${levelText(def)}, not on ${LEVEL_NAME[level]}`, { key: k, line: e.keyLine });
      return;
    }
    const seq = def.kind === 'list' && node.kind === 'seq' && node.items.every((x) => x.kind === 'scalar' && !isNull(x));
    if (!seq && (node.kind !== 'scalar' || isNull(node))) {
      c.error(node, `${path}.${k}`, `expected a single value but found ${kindOf(node)}`);
      return;
    }
    const p = parseValue(def, seq && node.kind === 'seq' ? node.items.map((x) => scalarValue(x)) : scalarValue(node));
    if ('error' in p) {
      c.error(node, `${path}.${k}`, `${def.label} ${p.error}${def.kind === 'duration' ? ` (a bare number is in ${def.base === 'ms' ? 'milliseconds' : 'seconds'})` : ''}`);
      return;
    }
    out.values.set(def.key, p.value);
    out.lines.set(def.key, e.keyLine);
  });
  return out;
}

/**
 * With the whole model: does each attribute written on an object apply to
 * it (an edge port on a switch port, a LACP rate on an aggregate, an IKE
 * lifetime on an IPsec relation, a snooping setting on a VLAN)? One that
 * doesn't is an error and is left out.
 */
export function checkObjectBlocks(c: Ctx, model: Model, blocks: Array<{ kind: 'iface' | 'network' | 'relation'; ref: string; block: SimBlock }>): void {
  for (const b of blocks) {
    let allowed: ParamDef[] = [];
    let what = '';
    if (b.kind === 'iface') {
      const [dev, iid] = [b.ref.slice(0, b.ref.indexOf(':')), b.ref.slice(b.ref.indexOf(':') + 1)];
      const d = model.index.devices.get(dev);
      const i = model.index.interfaces.get(b.ref);
      if (!d || !i) continue;
      const f = ifaceFacts(model, d, i);
      allowed = interfaceParams(deviceFacts(model, d), f);
      what = `${dev}:${iid}, ${f.lag ? 'an aggregate' : f.radio ? 'a radio' : f.bridgePort ? 'a switch port' : f.port ? 'a port' : 'an interface'}${f.ip ? ' with an address' : ''}`;
    } else if (b.kind === 'network') {
      const n = model.networks.find((x) => x.id === b.ref);
      if (!n) continue;
      if (n.vlan === undefined) {
        c.error(b.block.map, b.block.path, `network "${n.id}" has simulation attributes of a VLAN but no VLAN: give it its "vlan:"`);
        if (n.simulation) n.simulation.clear();
        continue;
      }
      continue;
    } else {
      const rel = model.relations.find((x) => x.id === b.ref);
      if (!rel) continue;
      const f = relFacts(model, rel);
      allowed = relationParams(f);
      what = `relation "${rel.id}" (${f.base}${f.lbService ? ', a load balancer’s pool' : f.serverService ? ', a server’s service' : ''})`;
    }
    for (const key of Array.from(b.block.values.keys())) {
      const def = paramDef(key);
      if (allowed.indexOf(def) >= 0) continue;
      c.error(b.block.map, `${b.block.path}.${def.yaml}`, `"${def.yaml}" (${def.label.toLowerCase()}) does not apply to ${what}`, { key: def.yaml, line: b.block.lines.get(key) });
      b.block.values.delete(key);
    }
  }
}

/** A cable's `simulation:` block: latency, packet loss, and flapping from the start. */
export function readLinkSimulation(r: Reader, c: Ctx, n: YNode | undefined, path: string): LinkSimulation | undefined {
  if (isNull(n)) return undefined;
  const m = r.map(n, path);
  if (!m) return undefined;
  r.keys(m, ['latency', 'loss', 'flapping'], path);
  const out: LinkSimulation = {};
  const num = (key: string, def: ParamDef): number | undefined => {
    const node = get(m as YMap, key);
    if (isNull(node)) return undefined;
    const p = parseValue(def, scalarValue(node as YNode));
    if ('error' in p) {
      c.error(node as YNode, `${path}.${key}`, `${def.label} ${p.error}`);
      return undefined;
    }
    return Number(p.value);
  };
  const lat = num('latency', paramDef('link-latency'));
  if (lat !== undefined) out.latency = lat;
  const loss = num('loss', paramDef('loss'));
  if (loss !== undefined) out.loss = loss;
  const flap = r.bool(get(m, 'flapping'), path + '.flapping');
  if (flap !== undefined) out.flapping = flap;
  return out;
}

/** For messages: a value with its unit. */
export function valueText(key: string, v: ParamValue): string {
  return formatValue(paramDef(key), v);
}

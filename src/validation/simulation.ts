/**
 * The `simulation:` blocks: a device's simulation attributes and a cable's
 * simulation settings (analysis/sim/params.ts has the registry). Only
 * overrides are written; every key is checked against the registry (an
 * unknown one is an error, with a suggestion), against the device's type
 * (an attribute that does not apply to it is an error) and for its range
 * and unit.
 */
import { Applies, ParamDef, ParamValue, PARAMS, deviceParamByYaml, formatValue, paramDef, parseValue } from '../analysis/sim/params';
import { deviceRoutingRole, deviceTypeLabel, NO_DEVICE_TYPE } from '../model/device-types';
import { LinkSimulation } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { Ctx, Reader, get, isNull, kindOf, suggest } from './reader';

/** Could an attribute apply to a device of this type (the Inspector narrows it by what the device has)? */
export function typeAllows(a: Applies, type: string, layer3?: boolean): boolean {
  switch (a) {
    case 'all':
      return true;
    case 'ip':
    case 'aggregate':
      return type !== 'cloud';
    case 'router':
    case 'vpn':
      return deviceRoutingRole({ type, layer3 }) === 'router' || (a === 'vpn' && type === 'gateway');
    case 'switch':
      return type === 'switch';
    case 'firewall':
      return type === 'firewall';
    case 'ids':
      return type === 'ids_ips';
    case 'host':
      return ['server', 'vm', 'container', 'storage'].indexOf(type) >= 0;
    case 'hypervisor':
      return type === 'server';
    case 'monitor':
      return ['system', 'server', 'vm', 'container', 'endpoint'].indexOf(type) >= 0;
    case 'cloud':
      return type === 'cloud';
    case 'ap':
      return type === 'ap';
  }
  return false;
}

/** The device attributes a type may have, in order. */
export function typeParams(type: string, layer3?: boolean): ParamDef[] {
  return PARAMS.filter((p) => !!p.device && p.device.some((a) => typeAllows(a, type, layer3)));
}

function scalarValue(n: YNode): unknown {
  return n.kind === 'scalar' ? n.value : undefined;
}

/** A device's `simulation:` block: its attributes by registry key. */
export function readDeviceSimulation(r: Reader, c: Ctx, n: YNode | undefined, path: string, id: string, type: string, layer3?: boolean): Map<string, ParamValue> | undefined {
  if (isNull(n)) return undefined;
  const m = r.map(n, path);
  const out = new Map<string, ParamValue>();
  if (!m) return out;
  const allowed = typeParams(type, layer3);
  const what = type === NO_DEVICE_TYPE ? 'a device without a type' : `a ${deviceTypeLabel(type) || type}`;
  m.entries.forEach((e, k) => {
    const def = deviceParamByYaml(k);
    const node = e.value;
    if (!def) {
      c.error(m, `${path}.${k}`, `unknown simulation attribute "${k}"${suggest(k, allowed.map((p) => p.yaml), 30)}`, { key: k, line: e.keyLine });
      return;
    }
    if (allowed.indexOf(def) < 0) {
      c.error(m, `${path}.${k}`, `"${k}" (${def.label.toLowerCase()}) does not apply to "${id}", ${what}`, { key: k, line: e.keyLine });
      return;
    }
    if (node.kind !== 'scalar' || isNull(node)) {
      c.error(node, `${path}.${k}`, `expected a single value but found ${kindOf(node)}`);
      return;
    }
    const p = parseValue(def, scalarValue(node));
    if ('error' in p) {
      c.error(node, `${path}.${k}`, `${def.label} ${p.error}${def.kind === 'duration' ? ` (a bare number is in ${def.base === 'ms' ? 'milliseconds' : 'seconds'})` : ''}`);
      return;
    }
    out.set(def.key, p.value);
  });
  return out;
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

/**
 * A device's network policy (`policy:`, model/net-policy.ts): its syntax as
 * the device is read (readNetPolicy), its references once the model is
 * built (checkNetPolicies: the interfaces, zones and objects it names).
 * Only a device that forwards IP (a router, a Layer 3 switch, a routed
 * firewall) or a transparent firewall applies one; a Security gateway's
 * Domain separation is its own policy.
 */
import { capabilities, deviceRoutingRole } from '../model/capabilities';
import { parseAddress, parsePrefix } from '../model/ip';
import { NetPolicy, POLICY_PROTOS, PolicyRule, portSpecProblem } from '../model/net-policy';
import { Device, Model, ifaceKey } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, Reader, get, isNull, scalarText } from './reader';

export interface PolicyNodes {
  node: YMap;
  path: string;
  dev: Device;
}

/** A scalar or a list of scalars, as texts (empty values left out). */
function texts(r: Reader, n: YNode | undefined, path: string): Array<{ text: string; node: YNode }> {
  if (!n || isNull(n)) return [];
  if (n.kind === 'scalar') {
    const t = (scalarText(n) || '').trim();
    return t ? [{ text: t, node: n }] : [];
  }
  return r
    .list(n, path)
    .map((x) => ({ text: x.kind === 'scalar' ? (scalarText(x) || '').trim() : '', node: x }))
    .filter((x) => x.text);
}

/** Read a device's `policy:` (syntax only; null when none is written). */
export function readNetPolicy(r: Reader, c: Ctx, m: YMap, dpath: string, dev: Device, nodes: PolicyNodes[]): NetPolicy | undefined {
  const pn = get(m, 'policy');
  if (!pn || isNull(pn)) return undefined;
  const path = dpath + '.policy';
  const caps = capabilities(dev);
  if (caps.securityGateway) {
    c.error(pn, path, `"${dev.id}" is a Security gateway: its Domain separation is its policy (services.separation); delete "policy"`);
    return undefined;
  }
  if (deviceRoutingRole(dev) !== 'router' && !caps.firewallPolicy) {
    c.error(pn, path, `"${dev.id}" forwards no IP: a network policy applies on a router, a Layer 3 switch or a firewall; delete "policy"`);
    return undefined;
  }
  const pm = r.map(pn, path);
  if (!pm) return undefined;
  r.keys(pm, SCHEMA.netPolicy, path);
  const def = r.field(pm, 'default', path, 10);
  if (def !== 'permit' && def !== 'deny') {
    c.error(get(pm, 'default') || pm, path + '.default', def === undefined ? 'a policy needs its default action: permit or deny (what no rule matches gets)' : `"${def}" is no default action: use permit or deny`, get(pm, 'default') ? {} : { key: 'default' });
    return undefined;
  }
  const out: NetPolicy = { default: def, zones: [], rules: [], line: pm.line };
  const st = get(pm, 'stateful');
  if (st && !isNull(st)) {
    const t = st.kind === 'scalar' ? scalarText(st) : undefined;
    if (t !== 'true' && t !== 'false') c.error(st, path + '.stateful', 'stateful is true or false');
    else out.stateful = t === 'true';
  }
  r.list(get(pm, 'zones'), path + '.zones').forEach((zn, k) => {
    const zp = `${path}.zones[${k}]`;
    const zm = r.map(zn, zp);
    if (!zm) return;
    r.keys(zm, SCHEMA.policyZone, zp);
    const name = r.field(zm, 'name', zp, 64);
    if (!name || !name.trim()) {
      c.error(get(zm, 'name') || zm, zp + '.name', 'a zone needs its name', get(zm, 'name') ? {} : { key: 'name' });
      return;
    }
    if (out.zones.some((z) => z.name === name.trim())) c.error(get(zm, 'name') as YNode, zp + '.name', `zone "${name}" is defined twice`);
    out.zones.push({ name: name.trim(), interfaces: texts(r, get(zm, 'interfaces'), zp + '.interfaces').map((x) => x.text) });
  });
  r.list(get(pm, 'rules'), path + '.rules').forEach((rn, k) => {
    const rp = `${path}.rules[${k}]`;
    const rm = r.map(rn, rp);
    if (!rm) return;
    r.keys(rm, SCHEMA.policyRule, rp);
    const action = r.field(rm, 'action', rp, 10);
    if (action !== 'permit' && action !== 'deny') {
      c.error(get(rm, 'action') || rm, rp + '.action', action === undefined ? 'a rule needs its action: permit or deny' : `"${action}" is no action: use permit or deny`, get(rm, 'action') ? {} : { key: 'action' });
      return;
    }
    const proto = r.field(rm, 'proto', rp, 10) || 'any';
    if (POLICY_PROTOS.indexOf(proto) < 0) {
      c.error(get(rm, 'proto') as YNode, rp + '.proto', `"${proto}" is no protocol here: use ${POLICY_PROTOS.join(', ')}`);
      return;
    }
    const rule: PolicyRule = { action, source: texts(r, get(rm, 'source'), rp + '.source').map((x) => x.text), destination: texts(r, get(rm, 'destination'), rp + '.destination').map((x) => x.text), proto: proto as PolicyRule['proto'], in: texts(r, get(rm, 'in'), rp + '.in').map((x) => x.text), out: texts(r, get(rm, 'out'), rp + '.out').map((x) => x.text), line: rm.line };
    const name = r.field(rm, 'name', rp, 80);
    if (name) rule.name = name.trim();
    for (const pk of ['sport', 'dport'] as const) {
      const v = r.field(rm, pk, rp, 80);
      if (v === undefined) continue;
      if (proto !== 'tcp' && proto !== 'udp') c.error(get(rm, pk) as YNode, `${rp}.${pk}`, `${pk} goes with tcp or udp`);
      else {
        const why = portSpecProblem(v);
        if (why) c.error(get(rm, pk) as YNode, `${rp}.${pk}`, why);
        else rule[pk] = v.trim();
      }
    }
    const fz = r.field(rm, 'from_zone', rp, 64);
    if (fz) rule.fromZone = fz.trim();
    const tz = r.field(rm, 'to_zone', rp, 64);
    if (tz) rule.toZone = tz.trim();
    out.rules.push(rule);
  });
  nodes.push({ node: pm, path, dev });
  return out;
}

/** Does an address spec name something (a prefix or address, any, a device, a network, a device:interface)? */
function specKnown(model: Model, t: string): boolean {
  if (t === 'any') return true;
  if (parsePrefix(t, false) || parseAddress(t)) return true;
  if (model.index.devices.has(t) || model.index.networks.has(t)) return true;
  const c = t.indexOf(':');
  return c > 0 && model.index.interfaces.has(ifaceKey(t.slice(0, c), t.slice(c + 1)));
}

/** The references of each policy: interfaces of its device, zones it defines, objects of the model. */
export function checkNetPolicies(c: Ctx, model: Model, nodes: PolicyNodes[]): void {
  for (const { node, path, dev } of nodes) {
    const pol = dev.policy;
    if (!pol) continue;
    const hasIf = (i: string): boolean => model.index.interfaces.has(ifaceKey(dev.id, i));
    pol.zones.forEach((z, k) => {
      for (const i of z.interfaces) if (!hasIf(i)) c.error(node, `${path}.zones[${k}].interfaces`, `zone "${z.name}": "${dev.id}" has no interface "${i}"`);
    });
    pol.rules.forEach((r, k) => {
      const rp = `${path}.rules[${k}]`;
      for (const i of r.in.concat(r.out)) if (!hasIf(i)) c.error(node, rp, `rule ${k + 1}: "${dev.id}" has no interface "${i}"`);
      for (const z of [r.fromZone, r.toZone]) if (z !== undefined && !pol.zones.some((x) => x.name === z)) c.error(node, rp, `rule ${k + 1}: the policy defines no zone "${z}"`);
      for (const t of r.source.concat(r.destination)) if (!specKnown(model, t)) c.error(node, rp, `rule ${k + 1}: "${t}" is no prefix, address, device, network or device:interface of the model`);
    });
  }
}

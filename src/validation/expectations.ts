/**
 * The analysis sections of a model: `failure_domains:` (components that
 * fail together, by explicit membership) and `expectations:` (design
 * requirements that Analyze → Design checks evaluates). Their form is
 * checked like the rest of the model (unknown keys, missing or unreadable
 * values are errors). A failure domain's member must exist: it is the
 * domain's whole meaning. An expectation's end or failure condition that
 * names nothing of the model is a warning, never an error: the expectation
 * then evaluates as indeterminate, and the model stays valid.
 */
import { parseCommEnd } from '../analysis/communication';
import { parseService } from '../analysis/trace';
import { EXPECT_KINDS, ExpectKind, Expectation, FAILURE_DOMAIN_KINDS, FailureDomain, FailureDomainKind, Model } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, ID_RE, Reader, get } from './reader';

const MAX_DOMAINS = 500;
const MAX_EXPECTATIONS = 1000;
/** at most this many components fail together in one condition */
export const MAX_FAILURE_SET = 64;

/** What a member of a failure domain is (device, cable, relation, group), or null when it names nothing. */
export function domainMemberKind(model: Model, id: string): 'device' | 'link' | 'relation' | 'group' | null {
  if (model.index.devices.has(id)) return 'device';
  if (model.index.links.has(id)) return 'link';
  if (model.index.relations.has(id)) return 'relation';
  if (model.index.groups.has(id)) return 'group';
  return null;
}

/** A list of scalars (a single one is accepted as a list of one). */
function scalars(r: Reader, n: YNode | undefined, path: string, max: number): Array<{ value: string; node: YNode }> {
  const out: Array<{ value: string; node: YNode }> = [];
  r.list(n, path, true).forEach((it, k) => {
    const v = r.str(it, `${path}[${k}]`, max);
    if (v !== undefined && v.trim()) out.push({ value: v.trim(), node: it });
  });
  return out;
}

/** Read the failure domains (after the model is built: members are resolved against it). */
export function readFailureDomains(r: Reader, c: Ctx, top: YMap, model: Model): FailureDomain[] {
  const out: FailureDomain[] = [];
  const seen = new Map<string, number>();
  const items = r.list(get(top, 'failure_domains'), 'failure_domains');
  if (items.length > MAX_DOMAINS) c.error(items[MAX_DOMAINS], 'failure_domains', `too many failure domains: ${items.length} (limit ${MAX_DOMAINS})`);
  items.slice(0, MAX_DOMAINS).forEach((n, i) => {
    const path = `failure_domains[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, SCHEMA.failureDomain, path);
    const id = r.id(m, path, ID_RE, 'failure domain id');
    if (!id) return;
    const dpath = 'failure_domains.' + id;
    if (seen.has(id)) {
      c.error(get(m, 'id') as YNode, dpath + '.id', `duplicate failure domain id "${id}" (already used on line ${seen.get(id)})`);
      return;
    }
    const clash = domainMemberKind(model, id) || (model.index.networks.has(id) ? 'network' : null);
    if (clash) {
      c.error(get(m, 'id') as YNode, dpath + '.id', `"${id}" is already the id of a ${clash === 'link' ? 'cable' : clash}: a failure condition names both, so a failure domain needs an id of its own`);
      return;
    }
    seen.set(id, m.line);
    const kind = r.field(m, 'kind', dpath, 40);
    if (kind === undefined) {
      c.error(m, dpath + '.kind', `a failure domain needs its kind: ${FAILURE_DOMAIN_KINDS.map((k) => k.id).join(', ')}`, { key: 'kind' });
      return;
    }
    if (!FAILURE_DOMAIN_KINDS.some((k) => k.id === kind)) {
      c.error(get(m, 'kind') as YNode, dpath + '.kind', `"${kind}" is no failure domain kind: use ${FAILURE_DOMAIN_KINDS.map((k) => k.id).join(', ')}`);
      return;
    }
    const mem = scalars(r, get(m, 'members'), dpath + '.members', 200);
    if (!mem.length) {
      c.error(get(m, 'members') || m, dpath + '.members', 'a failure domain needs its members: devices, cables, relations or groups that fail together', get(m, 'members') ? {} : { key: 'members' });
      return;
    }
    const members: string[] = [];
    for (const x of mem) {
      if (!domainMemberKind(model, x.value)) {
        c.error(x.node, dpath + '.members', `"${x.value}" is no device, cable, relation or group of the model`);
        continue;
      }
      if (members.indexOf(x.value) < 0) members.push(x.value);
    }
    const label = r.field(m, 'label', dpath, 200);
    const fd: FailureDomain = { id, label: label || id, kind: kind as FailureDomainKind, members, line: m.line };
    const desc = r.field(m, 'description', dpath, 2000);
    if (desc !== undefined) fd.description = desc;
    out.push(fd);
  });
  return out;
}

/** What a failure condition's entry names: a failable object, a failure domain, or nothing (null). */
export function failureEntryKind(model: Model, domains: FailureDomain[], id: string): 'device' | 'link' | 'relation' | 'iface' | 'domain' | null {
  if (domains.some((d) => d.id === id)) return 'domain';
  if (model.index.devices.has(id)) return 'device';
  if (model.index.links.has(id)) return 'link';
  if (model.index.relations.has(id)) return 'relation';
  if (model.index.interfaces.has(id)) return 'iface';
  return null;
}

/** Read the expectations (after the model and its failure domains are built). */
export function readExpectations(r: Reader, c: Ctx, top: YMap, model: Model, domains: FailureDomain[]): Expectation[] {
  const out: Expectation[] = [];
  const seen = new Map<string, number>();
  const items = r.list(get(top, 'expectations'), 'expectations');
  if (items.length > MAX_EXPECTATIONS) c.error(items[MAX_EXPECTATIONS], 'expectations', `too many expectations: ${items.length} (limit ${MAX_EXPECTATIONS})`);
  items.slice(0, MAX_EXPECTATIONS).forEach((n, i) => {
    const path = `expectations[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, SCHEMA.expectation, path);
    const id = r.id(m, path, ID_RE, 'expectation id');
    if (!id) return;
    const epath = 'expectations.' + id;
    if (seen.has(id)) {
      c.error(get(m, 'id') as YNode, epath + '.id', `duplicate expectation id "${id}" (already used on line ${seen.get(id)})`);
      return;
    }
    seen.set(id, m.line);
    const name = r.field(m, 'name', epath, 200);
    if (name === undefined || !name.trim()) {
      c.error(get(m, 'name') || m, epath + '.name', 'an expectation needs a readable name', get(m, 'name') ? {} : { key: 'name' });
      return;
    }
    const expect = r.field(m, 'expect', epath, 40);
    if (expect === undefined || !EXPECT_KINDS.some((k) => k.id === expect)) {
      c.error(get(m, 'expect') || m, epath + '.expect', expect === undefined ? `an expectation needs its expected outcome: ${EXPECT_KINDS.map((k) => k.id).join(', ')}` : `"${expect}" is no expected outcome: use ${EXPECT_KINDS.map((k) => k.id).join(', ')}`, get(m, 'expect') ? {} : { key: 'expect' });
      return;
    }
    const from = r.field(m, 'from', epath, 200);
    if (from === undefined || !from.trim()) {
      c.error(get(m, 'from') || m, epath + '.from', 'an expectation needs its source: a device, an interface, an address or an application', get(m, 'from') ? {} : { key: 'from' });
      return;
    }
    const to = r.field(m, 'to', epath, 200);
    const kind = expect as ExpectKind;
    if ((kind === 'available' || kind === 'blocked') && (to === undefined || !to.trim())) {
      // an application client names its own peer: it may leave `to` out
      const f = parseCommEnd(model, from);
      if (typeof f === 'string' || f.kind !== 'app' || !f.profile.client) {
        c.error(get(m, 'to') || m, epath + '.to', 'this expectation needs its destination: a device, interface, address, application (device/application) or service (device/service)', get(m, 'to') ? {} : { key: 'to' });
        return;
      }
    }
    for (const [key, v] of [['from', from], ['to', to]] as Array<[string, string | undefined]>) {
      if (v === undefined) continue;
      const e = parseCommEnd(model, v);
      if (typeof e === 'string') c.warn(get(m, key) as YNode, epath + '.' + key, `this expectation can't be evaluated: ${e}`);
    }
    const service = r.field(m, 'service', epath, 40);
    if (service !== undefined) {
      const s = parseService(service);
      if (typeof s === 'string') {
        c.error(get(m, 'service') as YNode, epath + '.service', s);
        return;
      }
    }
    const fail = scalars(r, get(m, 'failure'), epath + '.failure', 200);
    if (fail.length > MAX_FAILURE_SET) c.error(fail[MAX_FAILURE_SET].node, epath + '.failure', `at most ${MAX_FAILURE_SET} components fail together in one condition`);
    const failure: string[] = [];
    for (const x of fail.slice(0, MAX_FAILURE_SET)) {
      if (!failureEntryKind(model, domains, x.value)) c.warn(x.node, epath + '.failure', `"${x.value}" is no device, cable, relation, interface or failure domain of the model: the expectation can't be evaluated`);
      if (failure.indexOf(x.value) < 0) failure.push(x.value);
    }
    const e: Expectation = { id, name: name.trim(), expect: kind, from: from.trim(), failure, line: m.line };
    if (to !== undefined && to.trim()) e.to = to.trim();
    if (service !== undefined && service.trim()) e.service = service.trim();
    const vrf = r.field(m, 'vrf', epath, 64);
    if (vrf !== undefined) e.vrf = vrf;
    const fam = r.field(m, 'family', epath, 8);
    if (fam !== undefined) {
      if (fam !== '4' && fam !== '6') c.error(get(m, 'family') as YNode, epath + '.family', `"${fam}" is no address family: use 4 (IPv4) or 6 (IPv6)`);
      else e.family = fam === '4' ? 4 : 6;
    }
    const desc = r.field(m, 'description', epath, 2000);
    if (desc !== undefined) e.description = desc;
    out.push(e);
  });
  return out;
}

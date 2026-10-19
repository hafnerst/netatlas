/**
 * The model's saved experiments (`experiments:`, model/experiments.ts): their
 * syntax, and what each step names.
 *
 * Two kinds of issue, kept apart so that an experiment can be built step by
 * step: what is written wrong (an unknown action, a time that is no
 * duration, a duplicate id) is an **error**; what is not configured yet (a
 * step without its target or group, an experiment without a duration) or
 * names nothing of the model is a **warning** — the step stays in the model
 * with what it misses, and the experiment lists why it can't run
 * (`problems`). Bounded: at most 200 actions and observations each, a
 * duration of at most an hour of scenario time.
 */
import { stepTimes } from '../model/experiments';
import { EXP_ACTIONS, EXP_MAX_DURATION, EXP_MAX_STEPS, EXP_OBSERVE, EXP_SCOPE_KEYS, FIELD_CHOICES, ExpAction, ExpActionKind, ExpObservation, ExpObserveKind, ExpScope, Experiment, StepField, TargetKind, actionDef, observeDef } from '../model/experiments';
import { FailureDomain, Model, ifaceKey } from '../model/types';
import { PARAMS, parseValue } from '../analysis/sim/params';
import { parseService } from '../analysis/trace';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, ID_RE, Reader, get, isNull, scalarText } from './reader';

const MAX_EXPERIMENTS = 200;

/** A duration as written: "30s", "500ms", "2min", "1h", or a number of seconds; null when it is none. */
export function expDuration(raw: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s|sec|min|m|h)?\s*$/i.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  const u = (m[2] || 's').toLowerCase();
  return Math.round(u === 'ms' ? v : u === 'min' || u === 'm' ? v * 60000 : u === 'h' ? v * 3600000 : v * 1000);
}

/** Does a target name what its kind needs, in this model? ('' when it does, else why not.) */
export function targetProblem(model: Model, domains: FailureDomain[], kind: TargetKind, t: string, e?: Experiment): string {
  const ix = model.index;
  const iface = (x: string): boolean => {
    const c = x.indexOf(':');
    return c > 0 && ix.interfaces.has(ifaceKey(x.slice(0, c), x.slice(c + 1)));
  };
  const app = (x: string): boolean => {
    const s = x.indexOf('/');
    const d = s > 0 ? ix.devices.get(x.slice(0, s)) : undefined;
    return !!d && (d.applications || []).some((a) => a.id === x.slice(s + 1));
  };
  switch (kind) {
    case 'source':
      return ix.devices.has(t) || iface(t) || app(t) || /^[0-9a-f:.]+$/i.test(t) ? '' : `"${t}" is no device, interface, application or address of the model`;
    case 'failable':
      return ix.devices.has(t) || ix.links.has(t) || ix.relations.has(t) || domains.some((d) => d.id === t) ? '' : `"${t}" is no device, cable, relation or failure domain of the model`;
    case 'iface':
    case 'host-iface':
      return iface(t) ? '' : `"${t}" is no device:interface of the model`;
    case 'device':
    case 'router':
      return ix.devices.has(t) ? '' : `"${t}" is no device of the model`;
    case 'app':
      return app(t) ? '' : `"${t}" is no device/application of the model`;
    case 'link':
      return ix.links.has(t) ? '' : `"${t}" is no cable of the model`;
    case 'step':
      return (e && e.actions.some((a) => a.id === t)) || app(t) ? '' : `no action of the experiment has the id "${t}"`;
    case 'expectations': {
      if (t === '*') return model.expectations.length ? '' : 'the model has no saved expectations';
      const bad = t.split(/[\s,]+/).filter((x) => x && !model.expectations.some((y) => y.id === x));
      return bad.length ? `no saved expectation ${bad.map((x) => `"${x}"`).join(', ')}` : '';
    }
  }
}

/** A scope's problem in this model ('' none). */
export function scopeProblem(model: Model, domains: FailureDomain[], s: ExpScope): string {
  if (s.kind === 'group') return model.index.groups.has(s.value) ? '' : `"${s.value}" is no group of the model`;
  if (s.kind === 'domain') return domains.some((d) => d.id === s.value) ? '' : `"${s.value}" is no failure domain of the model`;
  if (s.kind === 'device') return model.index.devices.has(s.value) ? '' : `"${s.value}" is no device of the model`;
  if (s.kind === 'vlan') return /^[0-9]+$/.test(s.value) && Number(s.value) >= 1 && Number(s.value) <= 4094 ? '' : `"${s.value}" is no VLAN ID`;
  return '';
}

export function readExperiments(r: Reader, c: Ctx, top: YMap, model: Model, domains: FailureDomain[]): Experiment[] {
  const out: Experiment[] = [];
  const seen = new Map<string, number>();
  const items = r.list(get(top, 'experiments'), 'experiments');
  if (items.length > MAX_EXPERIMENTS) c.error(items[MAX_EXPERIMENTS], 'experiments', `too many experiments: ${items.length} (limit ${MAX_EXPERIMENTS})`);
  items.slice(0, MAX_EXPERIMENTS).forEach((n, i) => {
    const path = `experiments[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, SCHEMA.experiment, path);
    const id = r.id(m, path, ID_RE, 'experiment id');
    if (!id) return;
    const epath = 'experiments.' + id;
    if (seen.has(id)) {
      c.error(get(m, 'id') as YNode, epath + '.id', `duplicate experiment id "${id}" (already used on line ${seen.get(id)})`);
      return;
    }
    seen.set(id, m.line);
    const problems: string[] = [];
    // not configured yet: a warning, and a reason it can't run
    const todo = (node: YNode, p: string, msg: string): void => {
      c.warn(node, p, msg);
      problems.push(msg);
    };
    const name = r.field(m, 'name', epath, 200);
    if (!name || !name.trim()) todo(get(m, 'name') || m, epath + '.name', 'the experiment needs a name');
    const dText = r.field(m, 'duration', epath, 20);
    let duration = dText === undefined ? null : expDuration(dText);
    if (dText !== undefined && (duration === null || duration <= 0 || duration > EXP_MAX_DURATION)) {
      c.error(get(m, 'duration') as YNode, epath + '.duration', `"${dText}" is no duration of up to an hour (e.g. 120s, 5min)`);
      problems.push('its duration is invalid');
      duration = null;
    } else if (dText === undefined) todo(m, epath + '.duration', 'the experiment needs its duration (e.g. 120s): it always ends');
    const e: Experiment = { id, name: (name || id).trim(), duration: duration || 0, settle: 0, start: 'booted', scope: { kind: 'entire', value: '' }, params: [], actions: [], observations: [], problems, line: m.line };
    const desc = r.field(m, 'description', epath, 2000);
    if (desc !== undefined) e.description = desc;
    // the starting state: booted (the default; settle: runs that long first), or cold (every device off, then booting)
    const start = r.field(m, 'start', epath, 20);
    if (start !== undefined) {
      if (start === 'cold' || start === 'booted') e.start = start;
      else c.error(get(m, 'start') as YNode, epath + '.start', `"${start}" is no start: booted (the default) or cold`);
    }
    const sText = r.field(m, 'settle', epath, 20);
    if (sText !== undefined) {
      const v = expDuration(sText);
      if (v === null || v > EXP_MAX_DURATION) c.error(get(m, 'settle') as YNode, epath + '.settle', `"${sText}" is no duration of up to an hour (e.g. 30s)`);
      else if (e.start === 'cold' && v > 0) c.error(get(m, 'settle') as YNode, epath + '.settle', 'a cold start boots at the start: it does not settle first (leave settle out, or start booted)');
      else e.settle = v;
    }
    // the execution scope: targets (the steps' targets and their dependencies), or one of group, vlan, domain, device (entire when left out)
    const sn = get(m, 'scope');
    const sScalar = sn && sn.kind === 'scalar' ? scalarText(sn) : undefined;
    if (sScalar !== undefined && !isNull(sn as YNode)) {
      if (sScalar === 'targets') e.scope = { kind: 'targets', value: '' };
      else if (sScalar !== 'entire') c.error(sn as YNode, epath + '.scope', `"${sScalar}" is no scope: targets, entire, or one of group, vlan, domain or device with its value`);
    } else if (sn && !isNull(sn)) {
      const sm = r.map(sn, epath + '.scope');
      if (sm) {
        r.keys(sm, SCHEMA.expScope, epath + '.scope');
        const set = EXP_SCOPE_KEYS.filter((k) => k !== 'targets' && get(sm, k) !== undefined);
        if (set.length !== 1) c.error(sm, epath + '.scope', 'a scope is one of group, vlan, domain or device');
        else {
          const v = r.field(sm, set[0], epath + '.scope', 64);
          e.scope = { kind: set[0] as ExpScope['kind'], value: (v || '').trim() };
          const why = scopeProblem(model, domains, e.scope);
          if (why) todo(get(sm, set[0]) as YNode, epath + '.scope', why);
        }
      }
    }
    // the simulation-wide parameters it sets (the keys of Start simulation)
    const pm = get(m, 'params');
    if (pm && !isNull(pm)) {
      const mm = r.map(pm, epath + '.params');
      if (mm)
        mm.entries.forEach((ent, key) => {
          const def = PARAMS.find((p) => p.yaml === key);
          if (!def) {
            c.error(mm, `${epath}.params.${key}`, `"${key}" is no simulation parameter (the parameters of Start simulation)`, { key, line: ent.keyLine });
            return;
          }
          const raw = ent.value.kind === 'scalar' ? scalarText(ent.value) : undefined;
          const v = parseValue(def, raw);
          if ('error' in v) c.error(ent.value, `${epath}.params.${key}`, `${def.label} ${v.error}`);
          else e.params.push({ key: def.key, value: v.value as number | string });
        });
    }
    const durationOf = (n2: YMap, key: string, p2: string): number | undefined | null => {
      const t = r.field(n2, key, p2, 20);
      if (t === undefined) return undefined;
      const v = expDuration(t);
      if (v === null) {
        c.error(get(n2, key) as YNode, `${p2}.${key}`, `"${t}" is no duration (e.g. 10s)`);
        return null;
      }
      return v;
    };
    const steps = (key: string): YNode[] => {
      const list = r.list(get(m, key), `${epath}.${key}`);
      if (list.length > EXP_MAX_STEPS) c.error(list[EXP_MAX_STEPS], `${epath}.${key}`, `at most ${EXP_MAX_STEPS} entries`);
      return list.slice(0, EXP_MAX_STEPS);
    };
    /** a step's other fields, by its kind's definition: what is written, and what is required but missing */
    const fields = (sm: YMap, p2: string, req: StepField[], opt: StepField[], step: ExpAction | ExpObservation, label: string): void => {
      const s = step as unknown as { [k: string]: unknown; missing: string[] };
      for (const key of ['to', 'service', 'group', 'topic'] as const) {
        const v = r.field(sm, key, p2, 200);
        if (v !== undefined && v.trim()) s[key] = v.trim();
      }
      for (const key of ['family', 'protocol'] as const) {
        const v = r.field(sm, key, p2, 20);
        if (v === undefined || !v.trim()) continue;
        const ok = (FIELD_CHOICES[key] as string[]).indexOf(v.trim().toLowerCase()) >= 0;
        if (!ok) c.error(get(sm, key) as YNode, `${p2}.${key}`, `"${v}" is no ${key === 'family' ? 'address family: ipv4 or ipv6' : 'protocol the simulation reports sessions of: ' + (FIELD_CHOICES.protocol as string[]).join(', ')}`);
        else s[key] = v.trim().toLowerCase();
      }
      for (const key of ['count', 'port', 'size', 'min'] as const) {
        const v = r.field(sm, key, p2, 8);
        if (v === undefined) continue;
        const max = key === 'count' ? 1000 : key === 'port' ? 65535 : key === 'min' ? 100000 : 9000;
        if (!/^[0-9]+$/.test(v) || Number(v) < 1 || Number(v) > max) c.error(get(sm, key) as YNode, `${p2}.${key}`, `${key} is a whole number, 1 to ${max}`);
        else s[key] = Number(v);
      }
      const iv = r.field(sm, 'interval', p2, 20);
      if (iv !== undefined) {
        const v = expDuration(iv);
        if (v === null || v < 10) c.error(get(sm, 'interval') as YNode, p2 + '.interval', `"${iv}" is no interval (10ms or more)`);
        else s.interval = v;
      }
      const fv = r.field(sm, 'for', p2, 20);
      if (fv !== undefined) {
        const v = expDuration(fv);
        if (v === null || v <= 0 || v > EXP_MAX_DURATION) c.error(get(sm, 'for') as YNode, p2 + '.for', `"${fv}" is no duration of up to an hour (e.g. 30s)`);
        else s.for = v;
      }
      const sv = s.service as string | undefined;
      if (sv !== undefined && typeof parseService(sv) === 'string') c.error(get(sm, 'service') as YNode, p2 + '.service', parseService(sv) as string);
      // what the kind does not take
      for (const key of ['to', 'service', 'group', 'count', 'interval', 'port', 'size', 'for', 'family', 'protocol', 'topic', 'min'] as StepField[]) if (s[key] !== undefined && req.indexOf(key) < 0 && opt.indexOf(key) < 0) c.warn(get(sm, key) as YNode, `${p2}.${key}`, `${label} has no ${key}: it is not used`);
      for (const key of req)
        if (s[key] === undefined) {
          s.missing.push(key);
          todo(sm, `${p2}.${key}`, `${label}: ${key} is not configured yet`);
        }
    };
    const amaps: YMap[] = [];
    const omaps: YMap[] = [];
    steps('actions').forEach((an, k) => {
      const ap = `${epath}.actions[${k}]`;
      const am = r.map(an, ap);
      if (!am) return;
      r.keys(am, SCHEMA.expAction, ap);
      const kind = r.field(am, 'do', ap, 20);
      const def = kind !== undefined ? actionDef(kind) : undefined;
      if (!def) {
        c.error(get(am, 'do') || am, ap + '.do', kind === undefined ? `an action needs what it does: ${EXP_ACTIONS.map((x) => x.id).join(', ')}` : `"${kind}" is no action: use ${EXP_ACTIONS.map((x) => x.id).join(', ')}`, get(am, 'do') ? {} : { key: 'do' });
        return;
      }
      amaps.push(am);
      const label = `action ${k + 1} (${def.label})`;
      const at = durationOf(am, 'at', ap);
      const a: ExpAction = { at: at || 0, do: kind as ExpActionKind, target: (r.field(am, 'target', ap, 200) || '').trim(), missing: [], line: am.line };
      if (at === null) a.missing.push('at');
      const aid = r.field(am, 'id', ap, 64);
      if (aid !== undefined && aid.trim()) {
        if (e.actions.some((x) => x.id === aid.trim())) c.error(get(am, 'id') as YNode, ap + '.id', `duplicate step id "${aid}"`);
        a.id = aid.trim();
      }
      const after = r.field(am, 'after', ap, 64);
      if (after !== undefined && after.trim()) a.after = after.trim();
      if (!a.target) {
        a.missing.push('target');
        todo(am, ap + '.target', `${label}: its target is not configured yet`);
      } else {
        const why = targetProblem(model, domains, def.target, a.target, e);
        if (why) todo(get(am, 'target') as YNode, ap + '.target', `${label}: ${why}`);
      }
      fields(am, ap, def.required, def.optional, a, label);
      if (a.to) {
        const why = targetProblem(model, domains, 'source', a.to, e);
        if (why && !/[a-z]\.[a-z]/i.test(a.to)) todo(get(am, 'to') as YNode, ap + '.to', `${label}: ${why}`);
      }
      e.actions.push(a);
    });
    steps('observe').forEach((on, k) => {
      const op = `${epath}.observe[${k}]`;
      const om = r.map(on, op);
      if (!om) return;
      r.keys(om, SCHEMA.expObserve, op);
      const of = r.field(om, 'of', op, 20);
      const def = of !== undefined ? observeDef(of) : undefined;
      if (!def) {
        c.error(get(om, 'of') || om, op + '.of', of === undefined ? `an observation needs what it reads: ${EXP_OBSERVE.map((x) => x.id).join(', ')}` : `"${of}" is nothing an experiment observes: use ${EXP_OBSERVE.map((x) => x.id).join(', ')}`, get(om, 'of') ? {} : { key: 'of' });
        return;
      }
      omaps.push(om);
      const label = `observation ${k + 1} (${def.label})`;
      const o: ExpObservation = { of: of as ExpObserveKind, target: (r.field(om, 'target', op, 400) || '').trim(), expect: (r.field(om, 'expect', op, 20) || '').trim(), missing: [], line: om.line };
      const oid = r.field(om, 'id', op, 64);
      if (oid !== undefined && oid.trim()) {
        if (e.observations.some((x) => x.id === oid.trim()) || e.actions.some((x) => x.id === oid.trim())) c.error(get(om, 'id') as YNode, op + '.id', `duplicate step id "${oid}"`);
        o.id = oid.trim();
      }
      const at = durationOf(om, 'at', op);
      if (at !== undefined && at !== null) o.at = at;
      const after = r.field(om, 'after', op, 64);
      if (after !== undefined && after.trim()) o.after = after.trim();
      const within = durationOf(om, 'within', op);
      if (within !== undefined && within !== null) o.within = within;
      if (!o.target) {
        o.missing.push('target');
        todo(om, op + '.target', `${label}: its target is not configured yet`);
      } else {
        const why = targetProblem(model, domains, def.target, o.target, e);
        if (why) todo(get(om, 'target') as YNode, op + '.target', `${label}: ${why}`);
      }
      if (!o.expect) {
        o.missing.push('expect');
        todo(om, op + '.expect', `${label}: its expected outcome is not configured yet (${def.expect.join(' or ')})`);
      } else if (def.expect.indexOf(o.expect) < 0) {
        c.error(get(om, 'expect') as YNode, op + '.expect', `${def.label} expects ${def.expect.join(' or ')}`);
        o.missing.push('expect');
      }
      fields(om, op, def.required, def.optional, o, label);
      if (o.to && (o.of === 'neighbor' || o.of === 'route' || o.of === 'session')) {
        const why = o.of === 'session' ? (model.index.devices.has(o.to) ? '' : `"${o.to}" is no device of the model`) : targetProblem(model, domains, 'source', o.to, e);
        if (why) todo(get(om, 'to') as YNode, op + '.to', `${label}: ${why}`);
      }
      if (o.of === 'timing' && o.protocol && o.protocol !== 'ptp' && o.protocol !== 'ntp') c.error(get(om, 'protocol') as YNode, op + '.protocol', 'a timing state is of ptp or ntp');
      e.observations.push(o);
    });
    // the times, with their "after" chains: within the duration, no cycle, no unknown action
    if (duration) {
      const t = stepTimes(e);
      t.actions.forEach((x, k) => {
        const am = amaps[k];
        if (typeof x === 'string') todo(get(am, 'after') || am, `${epath}.actions[${k}].after`, `action ${k + 1}: ${x}`);
        else if (x > duration) c.error(get(am, 'at') || am, `${epath}.actions[${k}].at`, `action ${k + 1} comes at ${x / 1000} s, after the end of the experiment (${dText})`);
        else if (e.actions[k].for && x + (e.actions[k].for as number) > duration) c.warn(get(am, 'for') || am, `${epath}.actions[${k}].for`, `action ${k + 1} would be undone at ${(x + (e.actions[k].for as number)) / 1000} s, after the end of the experiment: it is not undone in a run`);
      });
      t.observations.forEach((x, k) => {
        const o = e.observations[k];
        const om = omaps[k];
        if (typeof x === 'string') todo(get(om, 'after') || om, `${epath}.observe[${k}].after`, `observation ${k + 1}: ${x}`);
        else if (x + (o.within || 0) > duration) c.error(get(om, 'at') || get(om, 'within') || om, `${epath}.observe[${k}].at`, `observation ${k + 1} ends at ${(x + (o.within || 0)) / 1000} s, after the end of the experiment (${dText})`);
      });
    }
    if (!e.actions.length && !e.observations.length) problems.push('it has no actions or observations yet');
    else if (!e.observations.length) problems.push('it observes nothing: add an observation (what it should find)');
    out.push(e);
  });
  return out;
}

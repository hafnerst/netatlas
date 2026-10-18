/**
 * The model's saved experiments (`experiments:`, model/experiments.ts):
 * their syntax, and the references they make (an end, a cable, a failure
 * domain that names nothing is a warning: that step can't be run, the run
 * says so). Bounded: at most 200 actions and observations each, a duration
 * of at most an hour of scenario time.
 */
import { EXP_ACTIONS, EXP_MAX_DURATION, EXP_MAX_STEPS, EXP_OBSERVE, ExpAction, ExpActionKind, ExpObservation, ExpObserveKind, Experiment } from '../model/experiments';
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

/** Does a text name something of the model an experiment can act on or observe? */
function known(model: Model, domains: FailureDomain[], t: string): boolean {
  if (model.index.devices.has(t) || model.index.links.has(t) || model.index.relations.has(t) || model.index.networks.has(t) || domains.some((d) => d.id === t)) return true;
  const c = t.indexOf(':');
  if (c > 0 && model.index.interfaces.has(ifaceKey(t.slice(0, c), t.slice(c + 1)))) return true;
  const s = t.indexOf('/');
  if (s > 0) {
    const d = model.index.devices.get(t.slice(0, s));
    return !!d && (d.applications || []).some((a) => a.id === t.slice(s + 1));
  }
  return false;
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
    const name = r.field(m, 'name', epath, 200);
    if (!name || !name.trim()) {
      c.error(get(m, 'name') || m, epath + '.name', 'an experiment needs a readable name', get(m, 'name') ? {} : { key: 'name' });
      return;
    }
    const dText = r.field(m, 'duration', epath, 20);
    const duration = dText === undefined ? null : expDuration(dText);
    if (duration === null || duration <= 0 || duration > EXP_MAX_DURATION) {
      c.error(get(m, 'duration') || m, epath + '.duration', dText === undefined ? 'an experiment needs its duration (e.g. 120s): it always ends' : `"${dText}" is no duration of up to an hour (e.g. 120s, 5min)`, get(m, 'duration') ? {} : { key: 'duration' });
      return;
    }
    const e: Experiment = { id, name: name.trim(), duration, params: [], actions: [], observations: [], line: m.line };
    const desc = r.field(m, 'description', epath, 2000);
    if (desc !== undefined) e.description = desc;
    // the simulation-wide parameters it sets (the keys of Start simulation)
    const pm = get(m, 'params');
    if (pm && !isNull(pm)) {
      const mm = r.map(pm, epath + '.params');
      if (mm)
        mm.entries.forEach((ent, key) => {
          // (every parameter of Start simulation, as the simulation-wide default)
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
    const atOf = (n2: YMap, p2: string): number | undefined | null => {
      const t = r.field(n2, 'at', p2, 20);
      if (t === undefined) return undefined;
      const v = expDuration(t);
      if (v === null || v > duration) {
        c.error(get(n2, 'at') as YNode, p2 + '.at', v === null ? `"${t}" is no time after the start (e.g. 10s)` : `${t} is after the end of the experiment (${dText})`);
        return null;
      }
      return v;
    };
    const steps = (key: string): YNode[] => {
      const list = r.list(get(m, key), `${epath}.${key}`);
      if (list.length > EXP_MAX_STEPS) c.error(list[EXP_MAX_STEPS], `${epath}.${key}`, `at most ${EXP_MAX_STEPS} entries`);
      return list.slice(0, EXP_MAX_STEPS);
    };
    steps('actions').forEach((an, k) => {
      const ap = `${epath}.actions[${k}]`;
      const am = r.map(an, ap);
      if (!am) return;
      r.keys(am, SCHEMA.expAction, ap);
      const kind = r.field(am, 'do', ap, 20);
      if (!kind || !EXP_ACTIONS.some((x) => x.id === kind)) {
        c.error(get(am, 'do') || am, ap + '.do', kind === undefined ? `an action needs what it does: ${EXP_ACTIONS.map((x) => x.id).join(', ')}` : `"${kind}" is no action (a stream runs on real time and is no experiment action): use ${EXP_ACTIONS.map((x) => x.id).join(', ')}`, get(am, 'do') ? {} : { key: 'do' });
        return;
      }
      const at = atOf(am, ap);
      if (at === null) return;
      if (at === undefined) {
        c.error(am, ap + '.at', 'an action needs its time after the start (at: 10s)', { key: 'at' });
        return;
      }
      const target = r.field(am, 'target', ap, 200);
      if (!target || !target.trim()) {
        c.error(get(am, 'target') || am, ap + '.target', `an action needs its target: ${(EXP_ACTIONS.find((x) => x.id === kind) as { target: string }).target}`, get(am, 'target') ? {} : { key: 'target' });
        return;
      }
      const a: ExpAction = { at, do: kind as ExpActionKind, target: target.trim(), line: am.line };
      const aid = r.field(am, 'id', ap, 64);
      if (aid !== undefined) {
        if (e.actions.some((x) => x.id === aid.trim())) c.error(get(am, 'id') as YNode, ap + '.id', `duplicate action id "${aid}"`);
        a.id = aid.trim();
      }
      for (const key of ['to', 'service', 'group'] as const) {
        const v = r.field(am, key, ap, 200);
        if (v !== undefined && v.trim()) a[key] = v.trim();
      }
      if (a.service !== undefined && typeof parseService(a.service) === 'string') c.error(get(am, 'service') as YNode, ap + '.service', parseService(a.service) as string);
      if (kind === 'send' && !a.to) c.error(am, ap + '.to', 'a send needs its destination (to:)', { key: 'to' });
      if ((kind === 'join' || kind === 'leave') && !a.group) c.error(am, ap + '.group', 'a join or leave needs its group', { key: 'group' });
      const cnt = r.field(am, 'count', ap, 6);
      if (cnt !== undefined) {
        if (!/^[0-9]+$/.test(cnt) || Number(cnt) < 1 || Number(cnt) > 1000) c.error(get(am, 'count') as YNode, ap + '.count', 'count is a whole number of messages, 1 to 1000');
        else a.count = Number(cnt);
      }
      const iv = r.field(am, 'interval', ap, 20);
      if (iv !== undefined) {
        const v = expDuration(iv);
        if (v === null || v < 10) c.error(get(am, 'interval') as YNode, ap + '.interval', `"${iv}" is no interval (10ms or more)`);
        else a.interval = v;
      }
      for (const t of [a.target, a.to].filter((x): x is string => !!x)) if (!known(model, domains, t) && !/^[0-9a-f:.]+$/i.test(t)) c.warn(get(am, t === a.target ? 'target' : 'to') as YNode, ap, `"${t}" is nothing of the model: this action can't be run`);
      e.actions.push(a);
    });
    steps('observe').forEach((on, k) => {
      const op = `${epath}.observe[${k}]`;
      const om = r.map(on, op);
      if (!om) return;
      r.keys(om, SCHEMA.expObserve, op);
      const of = r.field(om, 'of', op, 20);
      const def = EXP_OBSERVE.find((x) => x.id === of);
      if (!def) {
        c.error(get(om, 'of') || om, op + '.of', of === undefined ? `an observation needs what it reads: ${EXP_OBSERVE.map((x) => x.id).join(', ')}` : `"${of}" is nothing an experiment observes: use ${EXP_OBSERVE.map((x) => x.id).join(', ')}`, get(om, 'of') ? {} : { key: 'of' });
        return;
      }
      const target = r.field(om, 'target', op, 200);
      const expect = r.field(om, 'expect', op, 20);
      if (!target || !target.trim()) {
        c.error(get(om, 'target') || om, op + '.target', `an observation needs its target: ${def.target}`, get(om, 'target') ? {} : { key: 'target' });
        return;
      }
      if (!expect || def.expect.indexOf(expect.trim()) < 0) {
        c.error(get(om, 'expect') || om, op + '.expect', `${def.label} expects ${def.expect.join(' or ')}`, get(om, 'expect') ? {} : { key: 'expect' });
        return;
      }
      const at = atOf(om, op);
      if (at === null) return;
      const o: ExpObservation = { of: of as ExpObserveKind, target: target.trim(), expect: expect.trim(), line: om.line };
      if (at !== undefined) o.at = at;
      for (const key of ['to', 'service', 'group'] as const) {
        const v = r.field(om, key, op, 200);
        if (v !== undefined && v.trim()) o[key] = v.trim();
      }
      if ((of === 'send' || of === 'app') && !e.actions.some((a) => a.id === o.target) && !(of === 'app' && known(model, domains, o.target))) c.warn(get(om, 'target') as YNode, op + '.target', `no action of the experiment has the id "${o.target}"`);
      if (of === 'member' && !o.group) c.error(om, op + '.group', 'a membership observation needs its group', { key: 'group' });
      if (of === 'reach' && !o.to) c.error(om, op + '.to', 'a communication observation needs its destination (to:)', { key: 'to' });
      e.observations.push(o);
    });
    out.push(e);
  });
  return out;
}

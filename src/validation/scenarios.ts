/**
 * The `scenarios:` section: saved simulation scenarios. Their form is
 * checked like the rest of the model (unknown keys, one action per step,
 * one target per action); a step whose object no longer exists (renamed
 * outside NetAtlas, deleted) is a warning, never an error: scenarios are
 * presentation and analysis data and don't make the model invalid.
 */
import { resolveTarget } from '../analysis/scenario';
import { Model, STEP_ACTIONS, Scenario, ScenarioStep, StepAction, TARGET_KINDS, TargetKind } from '../model/types';
import { YMap, YNode } from '../yaml/parse';
import { SCHEMA } from '../yaml/schema';
import { Ctx, ID_RE, Reader, get, isNull, kindOf } from './reader';

const MAX_SCENARIOS = 500;
const MAX_STEPS = 500;

/** Read the scenarios of the document (after the model is built: the targets are resolved against it). */
export function readScenarios(r: Reader, c: Ctx, top: YMap, model: Model): Scenario[] {
  const out: Scenario[] = [];
  const seen = new Map<string, number>();
  const items = r.list(get(top, 'scenarios'), 'scenarios');
  if (items.length > MAX_SCENARIOS) c.error(items[MAX_SCENARIOS], 'scenarios', `too many scenarios: ${items.length} (limit ${MAX_SCENARIOS})`);
  items.slice(0, MAX_SCENARIOS).forEach((n, i) => {
    const path = `scenarios[${i}]`;
    const m = r.map(n, path);
    if (!m) return;
    r.keys(m, SCHEMA.scenario, path);
    const id = r.id(m, path, ID_RE, 'scenario id');
    if (!id) return;
    const spath = 'scenarios.' + id;
    if (seen.has(id)) {
      c.error(get(m, 'id') as YNode, spath + '.id', `duplicate scenario id "${id}" (already used on line ${seen.get(id)})`);
      return;
    }
    seen.set(id, m.line);
    const steps: ScenarioStep[] = [];
    const list = r.list(get(m, 'steps'), spath + '.steps');
    if (list.length > MAX_STEPS) c.error(list[MAX_STEPS], spath + '.steps', `too many steps: ${list.length} (limit ${MAX_STEPS})`);
    list.slice(0, MAX_STEPS).forEach((sn, k) => {
      const st = readStep(r, c, sn, `${spath}.steps[${k}]`, model);
      if (st) steps.push(st);
    });
    out.push({ id, label: r.field(m, 'label', spath, 200) || id, description: r.field(m, 'description', spath, 2000), steps, line: m.line });
  });
  return out;
}

function readStep(r: Reader, c: Ctx, n: YNode, path: string, model: Model): ScenarioStep | null {
  const m = r.map(n, path);
  if (!m) return null;
  r.keys(m, SCHEMA.step, path);
  const actions = STEP_ACTIONS.filter((a) => m.entries.has(a));
  if (actions.length !== 1) {
    c.error(m, path, actions.length ? `a step does one thing: it has ${actions.map((a) => `"${a}"`).join(' and ')}; make each a step of its own` : `a step needs what it does: ${STEP_ACTIONS.map((a) => `"${a}:"`).join(' or ')}, e.g. fail: {device: core1}`);
    return null;
  }
  const action = actions[0] as StepAction;
  const tn = get(m, action);
  const apath = path + '.' + action;
  if (isNull(tn) || (tn as YNode).kind !== 'map') {
    c.error((tn as YNode) || m, apath, `"${action}" names the object it acts on as a mapping with one key (${TARGET_KINDS.join(', ')}), e.g. ${action}: {cable: l1}${tn ? `; found ${kindOf(tn as YNode)}` : ''}`, tn ? {} : { key: action });
    return null;
  }
  const tm = tn as YMap;
  r.keys(tm, SCHEMA.target, apath);
  const kinds = TARGET_KINDS.filter((k) => tm.entries.has(k));
  if (kinds.length !== 1) {
    if (!tm.entries.size || kinds.length > 1) c.error(tm, apath, kinds.length ? `a step acts on one object: it names ${kinds.join(' and ')}` : `"${action}" needs the object: one of ${TARGET_KINDS.join(', ')}`);
    return null;
  }
  const kind = kinds[0] as TargetKind;
  const vn = get(tm, kind);
  const id = r.str(vn, apath + '.' + kind, 200);
  if (!id) {
    if (id === '') c.error(vn as YNode, apath + '.' + kind, `the ${kind} is empty`);
    return null;
  }
  const step: ScenarioStep = { action, target: { kind, id }, note: r.field(m, 'note', path, 500), line: m.line };
  const res = resolveTarget(model, step.target);
  if ('problem' in res) c.warn(vn as YNode, apath + '.' + kind, `this step can't be played: ${res.problem} (the scenario skips it)`);
  return step;
}

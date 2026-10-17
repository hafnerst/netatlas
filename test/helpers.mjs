// Shared helpers: tests run against the tsc output in build/js (npm test builds first).
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const load = (m) => require(join(root, 'build', 'js', m));

export const yaml = load('yaml/parse.js');
export const validate = load('validation/validate.js');
export const state = load('diagram/session.js');
export const scene = load('diagram/scene.js');
export const panels = load('ui/panels.js');
export const queries = load('model/queries.js');
export const derive = load('model/derive.js');

/** Validate YAML and build a diagram session (null when there are errors), as the UI does. */
export function sessionFromYaml(text) {
  const result = validate.loadModel(text);
  return { session: result.model && !result.errors.length ? new state.Session(result.model) : null, result };
}

const yamls = (dir) => readdirSync(join(root, dir)).filter((f) => /\.ya?ml$/.test(f));
/** The public examples (examples/: the File menu, shipped in dist/netatlas.html). */
export const publicExampleNames = yamls('examples');
/** The internal examples (test/examples/: test scenarios, in the test build only, never shipped). */
export const internalExampleNames = yamls(join('test', 'examples'));
/** Every valid example, public and internal: what the tests run over. */
export const exampleNames = publicExampleNames.concat(internalExampleNames);

/** An example's text by its file name: public, else internal (or a path under either, such as broken/…). */
export function example(name) {
  const dir = publicExampleNames.indexOf(name) >= 0 ? 'examples' : join('test', 'examples');
  return readFileSync(join(root, dir, name), 'utf8');
}

/** Generated test data (scripts/make-fixtures.mjs); not offered as examples in the application. */
export function fixture(name) {
  return readFileSync(join(root, 'test', 'fixtures', name), 'utf8');
}
export const fixtureNames = readdirSync(join(root, 'test', 'fixtures')).filter((f) => /\.ya?ml$/.test(f));

/** Parse+validate, failing loudly with the error list. */
export function model(text) {
  const r = validate.loadModel(text);
  if (!r.model || r.errors.length) throw new Error('expected a valid model, got:\n' + r.errors.map((e) => `line ${e.line} ${e.path}: ${e.message}`).join('\n'));
  return r.model;
}

export function errorsOf(text) {
  return validate.loadModel(text).errors;
}

export function byClass(v, cls) {
  return scene.findAll(v, (n) => scene.hasClass(n, cls));
}
export function byRef(v, ref) {
  return scene.findAll(v, (n) => n.attrs['data-ref'] === ref);
}

/**
 * A fake real clock for a simulation's real-time schedule (the streams of
 * Network events send on it): `s.clock.t` is the real time (ms), and
 * `s.play(ms, frame)` moves real and simulated time on together, a frame at
 * a time, as the page's animation frames do at 1×. No test sleeps.
 */
export function withClock(s) {
  const clock = { t: 0 };
  s.realtime.clock = () => clock.t;
  s.clock = clock;
  s.play = (ms, frame = 50) => {
    for (let d = 0; d < ms - 1e-9; d += frame) {
      clock.t += frame;
      s.pumpRealTime();
      s.runTo(s.now + frame);
    }
  };
  return s;
}

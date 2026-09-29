// Shared helpers: tests run against the tsc output in build/js (npm test builds first).
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const load = (m) => require(join(root, 'build', 'js', m));

export const yaml = load('yaml.js');
export const validate = load('validate.js');
export const state = load('state.js');
export const scene = load('scene.js');
export const panels = load('panels.js');

export function example(name) {
  return readFileSync(join(root, 'examples', name), 'utf8');
}
export const exampleNames = readdirSync(join(root, 'examples')).filter((f) => /\.ya?ml$/.test(f));

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

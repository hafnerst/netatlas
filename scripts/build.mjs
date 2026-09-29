// Bundles the tsc output (CommonJS, build/js) into ONE inline <script> and
// writes the self-contained dist/netatlas.html. No third-party tools: this is
// a ~60-line module wrapper, and it refuses any non-relative require() so a
// runtime dependency can never slip into the artifact.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, 'build', 'js');
const modules = new Map();

function load(id) {
  if (modules.has(id)) return;
  const file = join(jsDir, id + '.js');
  if (!existsSync(file)) throw new Error(`module not found: ${id} (${file})`);
  let src = readFileSync(file, 'utf8');
  modules.set(id, null);
  const deps = [];
  src = src.replace(/require\((["'])([^"']+)\1\)/g, (_m, _q, spec) => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      throw new Error(`non-relative require("${spec}") in ${id}.js — runtime dependencies are not allowed`);
    }
    const target = posix.normalize(posix.join(posix.dirname(id), spec));
    deps.push(target);
    return `__req(${JSON.stringify(target)})`;
  });
  modules.set(id, src);
  deps.forEach(load);
}

load('app/main');

let bundle = '(function () {\n"use strict";\nvar __defs = {};\nvar __cache = {};\n' +
  'function __req(id) {\n  var c = __cache[id];\n  if (c) return c.exports;\n  var m = (__cache[id] = { exports: {} });\n' +
  '  __defs[id].call(m.exports, m, m.exports);\n  return m.exports;\n}\n';
for (const [id, src] of modules) {
  bundle += `__defs[${JSON.stringify(id)}] = function (module, exports) {\n${src.replace(/^\/\/# sourceMappingURL=.*$/m, '')}\n};\n`;
}
bundle += '__req("app/main");\n})();\n';

// Make the script safe to inline in HTML.
// "</script" would end the inline script and "<!--" can switch the HTML parser
// into an escaped state; inside JS strings, regexes and comments "\/" == "/"
// and "\!" == "!", so the escaped forms are equivalent.
bundle = bundle.replace(/<\/(script)/gi, (_m, s) => '<\\/' + s).replace(/<!--/g, () => '<\\!--');
if (/<\/script/i.test(bundle) || bundle.includes('<!--')) throw new Error('unsafe sequence left in bundle');

const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
let html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
if (!html.includes('/*__CSS__*/') || !html.includes('/*__JS__*/')) throw new Error('template markers missing');
html = html
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => bundle)
  .replace(/__VERSION__/g, pkg.version);

const sha = (t) => createHash('sha256').update(t).digest('hex');
const ti = process.argv.indexOf('--target');
const out = ti > 0 ? process.argv[ti + 1] : join(root, 'dist', 'netatlas.html');
if (process.argv.includes('--check')) {
  // verify only: the checked-in HTML must be byte-identical to a fresh build of the current source
  let cur = '';
  try {
    cur = readFileSync(out, 'utf8');
  } catch {
    /* missing */
  }
  if (cur !== html) {
    console.error(`${out} does NOT match the current source (checked-in sha256 ${sha(cur).slice(0, 16)}…, fresh build ${sha(html).slice(0, 16)}…).`);
    console.error('Run "npm run build" and commit dist/netatlas.html.');
    process.exit(1);
  }
  console.log(`${out} matches a fresh build of the current source (sha256 ${sha(html).slice(0, 16)}…, ${modules.size} modules)`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote dist/netatlas.html  ${(html.length / 1024).toFixed(1)} KiB  ${modules.size} modules  sha256 ${sha(html).slice(0, 16)}…`);
}

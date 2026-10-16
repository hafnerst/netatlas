// Bundles the tsc output (CommonJS, build/js) into ONE inline <script> and
// writes self-contained HTML pages. No third-party tools: this is a small
// module wrapper, and it refuses any non-relative require() so a runtime
// dependency can never slip into the artifact.
//
//   dist/netatlas.html         the released application (entry app/main): the
//                              public examples only. Checked in; "--check"
//                              verifies it.
//   build/netatlas-test.html   the test build (entry app/main-test): the same
//                              application with the internal examples and
//                              fixtures, the full self-test and the viewport
//                              check. Never committed or shipped.
//
// The release must not contain a test-only module (TEST_ONLY): the build fails if it would.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, 'build', 'js');

/** The modules only the test build may contain: the internal examples and fixtures, the full self-test, the viewport check. */
const TEST_ONLY = ['generated/test-examples', 'app/selftest', 'app/viewport-check', 'app/main-test'];

/** One self-contained HTML page from an entry module of the tsc output. */
function page(entry) {
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
  load(entry);

  let bundle = '(function () {\n"use strict";\nvar __defs = {};\nvar __cache = {};\n' +
    'function __req(id) {\n  var c = __cache[id];\n  if (c) return c.exports;\n  var m = (__cache[id] = { exports: {} });\n' +
    '  __defs[id].call(m.exports, m, m.exports);\n  return m.exports;\n}\n';
  for (const [id, src] of modules) {
    bundle += `__defs[${JSON.stringify(id)}] = function (module, exports) {\n${src.replace(/^\/\/# sourceMappingURL=.*$/m, '')}\n};\n`;
  }
  bundle += `__req(${JSON.stringify(entry)});\n})();\n`;

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
  return { html, modules: [...modules.keys()] };
}

// the released application: the public examples only (src/app/main.ts)
const release = page('app/main');
const leaked = release.modules.filter((m) => TEST_ONLY.indexOf(m) >= 0);
if (leaked.length) throw new Error(`dist/netatlas.html would contain test-only modules: ${leaked.join(', ')} — the release entry (src/app/main.ts) must not import them`);
const html = release.html;
const modules = release.modules;

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
  console.log(`${out} matches a fresh build of the current source (sha256 ${sha(html).slice(0, 16)}…, ${modules.length} modules)`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote dist/netatlas.html  ${(html.length / 1024).toFixed(1)} KiB  ${modules.length} modules  sha256 ${sha(html).slice(0, 16)}…`);
  // the test build: the same application with the internal examples, fixtures, the full self-test and the viewport check
  // (src/app/main-test.ts); in build/, never committed or shipped
  if (ti < 0) {
    const t = page('app/main-test');
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'netatlas-test.html'), t.html);
    console.log(`wrote build/netatlas-test.html  ${(t.html.length / 1024).toFixed(1)} KiB  ${t.modules.length} modules (the test build: not shipped)`);
  }
}

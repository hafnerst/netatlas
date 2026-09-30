// The toolbar (File menu, "Current model", direct controls) and the folding
// sections of the model outline, as far as they can be checked without a
// browser. How they behave is checked in the browser self-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, load } from './helpers.mjs';

const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(html)[1];
const menu = /<div id="main-menu"[^>]*>([\s\S]*?)\n    <\/div>/.exec(header)[1];
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

test('toolbar: logo and version, then File, Current model, undo/redo, views, Auto-arrange, Find', () => {
  const order = ['class="brand"', 'class="version"', 'id="menu-btn"', 'id="btn-model"', 'id="btn-undo"', 'id="btn-redo"', 'data-view-btn="physical"', 'data-view-btn="logical"', 'id="btn-arrange"', 'id="search"'];
  const at = order.map((x) => header.indexOf(x));
  assert.ok(at.every((p) => p >= 0), JSON.stringify(at));
  assert.deepEqual(at, at.slice().sort((p, q) => p - q), 'in this order');
  assert.match(header, /<span>netatlas<\/span><span class="version"[^>]*>v__VERSION__<\/span>/);
  // these stay direct controls: none of them is inside the menu
  for (const id of ['btn-model', 'btn-undo', 'btn-redo', 'btn-arrange', 'search']) assert.ok(!menu.includes(`id="${id}"`), id);
  assert.ok(!/data-view-btn/.test(menu));
  assert.match(header, /<button id="btn-model"[^>]*disabled[^>]*>.*Current model/);
});

test('File menu: New, Open, Download and the examples in one menu with plain names', () => {
  assert.match(header, /<button id="menu-btn"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="main-menu"[^>]*>File /);
  assert.match(header, /<div id="main-menu" class="dropdown menu" role="menu"[^>]*hidden>/);
  const entries = [...menu.matchAll(/<button id="([^"]+)"[^>]*role="menuitem"[^>]*><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(entries, [['btn-new', 'New model'], ['open', 'Open model…'], ['btn-download', 'Download model…']]);
  // one wording rule for all three: verb + "model", sentence case, and "…" (the character, not three dots)
  // exactly where the command needs further input (a file to pick, a file name to confirm)
  for (const [, label] of entries) assert.match(label, /^(New|Open|Download) model(…)?$/);
  assert.doesNotMatch(menu, /\.\.\./);
  // tooltips say what each command does, and only Download has a shortcut hint
  assert.match(menu, /id="btn-new"[^>]*title="Start a new, empty model"/);
  assert.match(menu, /id="open"[^>]*title="Open a model from a YAML file on this computer \(nothing is uploaded\)"/);
  assert.match(menu, /id="btn-download"[^>]*title="Download the current model as a YAML file \(Ctrl\+S\)"/);
  assert.deepEqual([...menu.matchAll(/class="mi-hint">([^<]*)</g)].map((m) => m[1]), ['Ctrl+S']);
  // the start page uses the same two labels
  assert.match(html, /<button id="new-empty"[^>]*>New model<\/button> <button id="open-empty"[^>]*>Open model…<\/button>/);
  assert.match(menu, /<div class="menu-title" id="menu-examples-title">Examples<\/div>\s*<div id="menu-examples" role="group" aria-labelledby="menu-examples-title"><\/div>/);
  // and nowhere else in the toolbar
  const outside = header.replace(menu, '');
  for (const gone of ['id="btn-new"', 'id="open"', 'id="btn-download"', 'id="examples"', '<select']) assert.ok(!outside.includes(gone), gone);
  // the examples are filled in from the embedded files, one entry each
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /const menu = this\.\$\('menu-examples'\);\s+EXAMPLES\.forEach/);
  // drop-downs open over the page: the toolbar must not clip or scroll them
  const topbar = /\n\.topbar \{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(topbar, /overflow|max-height/);
  assert.match(css, /\.dropdown\.menu \{[^}]*max-height: calc\(100dvh - 70px\);/);
});

test('"model", not "document": the outline has no Document entry and the inspector is titled by the model', () => {
  const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');
  const appSrc = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  // user-facing strings (quoted text containing the word), not identifiers or comments
  for (const [name, src] of [['inspector.ts', inspector], ['app.ts', appSrc], ['index.html', html]]) {
    const strings = [...src.matchAll(/'([^'\n]*)'|`([^`\n]*)`|>([^<>\n]+)</g)].map((m) => m[1] || m[2] || m[3] || '').filter((t) => /\b[Dd]ocuments?\b/.test(t) && /\s/.test(t));
    assert.deepEqual(strings, [], name);
  }
  assert.doesNotMatch(inspector, /ol-doc|'Document: '/);
  assert.match(inspector, /this\.header\('model', this\.doc\.text\(\['title'\]\) \|\| 'Untitled model', null\)/);
  assert.match(inspector, /\['Edit model settings'\]/);
  assert.match(appSrc, /this\.\$\('btn-model'\)\.addEventListener\('click', \(\) => this\.editModel\(\)\);/);
});

test('outline sections: folding is view state of the editor, with Links and Protocols folded at the start', () => {
  const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');
  assert.match(inspector, /private collapsed = new Set<EntityKind>\(\['link', 'protocol'\]\);/);
  // headings are real buttons that announce their state
  assert.match(inspector, /class: 'ol-toggle', 'data-act': 'fold', 'data-kind': kind, 'aria-expanded': folded \? 'false' : 'true', 'aria-controls': listId/);
  // folding goes through the refresh that neither edits nor validates the model
  const fold = /case 'fold':([\s\S]*?)case 'fold-all':/.exec(inspector)[1];
  assert.match(fold, /this\.host\.changed\('filter'\);/);
  assert.doesNotMatch(fold, /doc\./);
  // the editing core knows nothing about it
  assert.doesNotMatch(readFileSync(join(root, 'src', 'editor', 'document.ts'), 'utf8'), /collapsed|fold/);
  assert.ok(load('ui/inspector.js').Editor);
});

test('examples: the File menu offers the six hand-written examples; the generated fixtures are test data only', async () => {
  const { readdirSync } = await import('node:fs');
  const { EXAMPLES, FIXTURES } = load('generated/examples.js');
  assert.deepEqual(EXAMPLES.map((e) => e.name), ['enterprise-wan.yaml', 'datacenter-evpn.yaml', 'minimal.yaml', 'metro-ring.yaml', 'device-types.yaml', 'long-labels.yaml']);
  assert.deepEqual(FIXTURES.map((e) => e.name).sort(), ['editor-new-network.yaml', 'metro-ring-arranged.yaml', 'minimal-edited.yaml']);
  assert.deepEqual(readdirSync(join(root, 'examples')).filter((f) => /\.yaml$/.test(f)).sort(), EXAMPLES.map((e) => e.name).sort());
  // nothing the user sees builds its list from FIXTURES: only the self-test imports them
  const { readFileSync: read } = await import('node:fs');
  for (const f of ['ui/app.ts', 'ui/inspector.ts', 'ui/panels.ts', 'app/main.ts', 'index.html']) assert.doesNotMatch(read(join(root, 'src', f), 'utf8'), /FIXTURES|editor-new-network|minimal-edited|metro-ring-arranged/, f);
  assert.match(read(join(root, 'src', 'app', 'selftest.ts'), 'utf8'), /import \{ EXAMPLES, FIXTURES \} from/);
});

test('selection hint of the outline: "selected" and "related (n)", without a note about dimming', () => {
  const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');
  assert.doesNotMatch(inspector, /others dimmed/);
  const at = inspector.indexOf("class: 'ol-ctx-hint small'");
  const hint = inspector.slice(at, inspector.indexOf('      );', at));
  assert.match(hint, /' selected · ',/);
  // the text ends after the count: no trailing separator, no empty element after it
  assert.match(hint, /` related \(\$\{ctx\.related\.size\}\)`,\s*\]\),\s*$/);
});

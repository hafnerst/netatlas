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
  assert.deepEqual(entries, [['btn-new', 'New model'], ['open', 'Open model…'], ['btn-download', 'Download model…'], ['btn-close', 'Close model']]);
  // Close model comes immediately after Download model…, and is unavailable until a model is open
  assert.match(menu, /id="btn-download"[^\n]*\n\s*<button id="btn-close" type="button" role="menuitem" title="Close the current model and return to the start screen" disabled>/);
  // one wording rule for all three: verb + "model", sentence case, and "…" (the character, not three dots)
  // exactly where the command needs further input (a file to pick, a file name to confirm)
  for (const [, label] of entries) assert.match(label, /^(New|Open|Download|Close) model(…)?$/);
  assert.doesNotMatch(menu, /\.\.\./);
  // tooltips say what each command does, and only Download has a shortcut hint
  assert.match(menu, /id="btn-new"[^>]*title="Start a new, empty model"/);
  assert.match(menu, /id="open"[^>]*title="Open a model from a YAML file on this computer \(nothing is uploaded\)"/);
  assert.match(menu, /id="btn-download"[^>]*title="Download the current model as a YAML file \(Ctrl\+S\)"/);
  assert.deepEqual([...menu.matchAll(/class="mi-hint">([^<]*)</g)].map((m) => m[1]), ['Ctrl+S']);
  // the ellipsis rule holds on the start screen too: opening a file asks for one
  assert.match(html, /<button id="open-empty"[^>]*>\s*<span class="start-title">Open YAML file…<\/span>/);
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

test('Export menu: next to File, one entry, built like the File menu; the zoom bar has no Save SVG', () => {
  // order in the toolbar: File, Export, then the rest
  const at = ['id="menu-btn"', 'id="export-btn"', 'id="btn-model"'].map((x) => header.indexOf(x));
  assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], JSON.stringify(at));
  assert.match(header, /<button id="export-btn" type="button" class="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="export-menu"[^>]*>Export <span class="caret"/);
  const exp = /<div id="export-menu" class="dropdown menu" role="menu" aria-label="Export" hidden>([\s\S]*?)\n    <\/div>/.exec(header)[1];
  assert.deepEqual([...exp.matchAll(/<button id="([^"]+)"[^>]*role="menuitem"[^>]*disabled[^>]*><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]), [['btn-export-svg', 'Export current view as SVG']]);
  // the same markup pattern as the File menu, and the same code drives both
  const fileBtn = /<button id="menu-btn"[^>]*>/.exec(header)[0];
  for (const attr of ['class="menu-btn"', 'aria-haspopup="menu"', 'aria-expanded="false"']) assert.ok(fileBtn.includes(attr), attr);
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /\['menu-btn', 'main-menu'\],\s*\['export-btn', 'export-menu'\],/);
  assert.match(app, /this\.\$\('btn-export-svg'\)\.addEventListener\('click', \(\) => this\.downloadSvg\(\)\);/);
  // available only with a diagram
  assert.match(app, /const ex = this\.\$\('btn-export-svg'\) as HTMLButtonElement;\s*ex\.disabled = !s;/);
  // the old button is gone everywhere
  assert.doesNotMatch(html + app, /save-svg|Save SVG/);
  const zoom = /<div class="zoombar"[^>]*>([\s\S]*?)<\/div>/.exec(html)[1];
  assert.deepEqual([...zoom.matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]), ['zoom-in', 'zoom-out', 'zoom-fit']);
});

test('start screen: name, one sentence, three ways to begin; no link row, no long text', () => {
  const start = /<div id="empty" class="overlay">([\s\S]*?)\n    <\/div>\n    <div id="errors"/.exec(html)[1];
  assert.match(start, /<h1>NetAtlas<\/h1>/);
  assert.match(start, /<div class="start-brand">\s*<svg /, 'a logo next to the name');
  assert.match(start, /<p class="start-tagline">Create and explore network architecture diagrams, fully offline\.<\/p>/);
  const titles = [...start.matchAll(/class="start-title"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['New model', 'Open YAML file…', 'Load example']);
  assert.match(start, /<button id="open-empty" type="button" class="start-card start-drop">[\s\S]*?drop one here/);
  assert.match(start, /<label class="start-title" for="start-example">Load example<\/label>[\s\S]*?<select id="start-example"[^>]*><option value="">Choose an example…<\/option><\/select>\s*<button id="start-load" type="button" disabled>Load<\/button>/);
  // every action is a native, focusable control
  assert.equal((start.match(/<button /g) || []).length, 3);
  assert.doesNotMatch(start, /tabindex|<a |linkish|example-buttons|onclick/);
  // short: the visible text besides the example names
  const text = start.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(text.length < 260, `${text.length}: ${text}`);
  assert.doesNotMatch(text, /Content-Security-Policy|IPsec|physical|logical|\.yaml/i);
  assert.match(start, /<p class="start-note muted small">Your files stay on this computer\.<\/p>/);
  // the picker is filled from the user-facing examples only, by title
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /const pick = this\.\$\('start-example'\);\s*EXAMPLES\.forEach/);
  assert.doesNotMatch(app, /FIXTURES/);
  // drops are always taken over by the page, and replacing unsaved work is confirmed
  assert.match(app, /doc\.addEventListener\('dragover', \(e\) => \{\s*e\.preventDefault\(\);/);
  assert.match(app, /doc\.addEventListener\('drop', async \(e\) => \{\s*e\.preventDefault\(\);/);
  assert.match(app, /else if \(await this\.confirmDiscard\('Opening the dropped file'\)\) void this\.loadFile\(f\);/);
});

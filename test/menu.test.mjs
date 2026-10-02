// The toolbar (File and Export menus, direct controls) and the folding
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

test('toolbar: logo and version, then File, Export, View, undo/redo, views, Auto-arrange, the diagram filters; no Current model button', () => {
  const order = ['class="brand"', 'class="version"', 'id="menu-btn"', 'id="export-btn"', 'id="view-btn"', 'id="btn-undo"', 'id="btn-redo"', 'data-view-btn="physical"', 'data-view-btn="logical"', 'id="btn-arrange"', 'id="view-filters"'];
  const at = order.map((x) => header.indexOf(x));
  assert.ok(at.every((p) => p >= 0), JSON.stringify(at));
  assert.deepEqual(at, at.slice().sort((p, q) => p - q), 'in this order');
  assert.match(header, /<span>netatlas<\/span><span class="version"[^>]*>v__VERSION__<\/span>/);
  // these stay direct controls: none of them is inside the menu
  for (const id of ['btn-undo', 'btn-redo', 'btn-arrange']) assert.ok(!menu.includes(`id="${id}"`), id);
  // Find is not in the toolbar any more: it opens from View (or "/") as a bar over the diagram
  assert.ok(!header.includes('id="search"') && html.includes('id="find-bar"'));
  assert.ok(!/data-view-btn/.test(menu));
  // the "Current model" button is gone, with its styles, its handler and the state it showed
  const appSrc = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.doesNotMatch(html + css + appSrc, /btn-model|model-badge|model-btn|Current model/);
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
  assert.match(inspector, /this\.header\('model', this\.doc\.text\(\['title'\]\) \|\| 'Untitled model', null, docIssues\)/);
  assert.match(inspector, /\['Edit model settings'\]/);
  // the model settings are still opened from the Edit tab and for a new model
  assert.match(appSrc, /private editModel\(\): void \{/);
  assert.match(appSrc, /editModel: \(\) => this\.editModel\(\)|this\.editModel\(\);/);
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

test('selection hint of the outline: "selected" and "related (n)" in the always-present tools row, without a note about dimming', () => {
  const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');
  assert.doesNotMatch(inspector, /others dimmed/);
  const at = inspector.indexOf("class: 'ol-ctx-hint small'");
  const hint = inspector.slice(at, inspector.indexOf("'fold-all'", at));
  assert.match(hint, /' selected · ',/);
  // the text ends after the count: no trailing separator, no empty element after it
  assert.match(hint, /` related \(\$\{ctx\.related\.size\}\)`,\s*\]\s*: \[\],/);
  // it shares the row of "Collapse all", which is there with or without a selection: nothing below it moves
  const row = inspector.slice(inspector.lastIndexOf("this.e('div', { class: 'ol-tools' }", at), at);
  assert.ok(row.length > 0 && row.length < 200, String(row.length));
  assert.doesNotMatch(inspector, /if \(ctx\) \{\s*box\.appendChild/);
  // every entry keeps the slot of the selection mark, so its label never moves sideways
  assert.match(inspector, /this\.e\('span', \{ class: 'ctx-mark' \+ \(st === 'selected' \? ' sel' : st === 'related' \? ' rel' : ''\), 'aria-hidden': 'true' \}/);
});

test('View menu: next to Export, with Find… (/) and Filter outline…, each the one place of its action', () => {
  const at = ['id="export-btn"', 'id="view-btn"', 'id="btn-undo"'].map((x) => header.indexOf(x));
  assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], JSON.stringify(at));
  // the same markup as File and Export, driven by the same code
  assert.match(header, /<button id="view-btn" type="button" class="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="view-menu"[^>]*>View <span class="caret"/);
  const view = /<div id="view-menu" class="dropdown menu" role="menu" aria-label="View" hidden>([\s\S]*?)\n    <\/div>/.exec(header)[1];
  const entries = [...view.matchAll(/<button id="([^"]+)"[^>]*role="menuitem"[^>]*disabled><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(entries, [['btn-find', 'Find…'], ['btn-outline-filter', 'Filter outline…']], 'both disabled until a model is open');
  assert.deepEqual([...view.matchAll(/class="mi-hint">([^<]*)</g)].map((m) => m[1]), ['/']);
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /\['export-btn', 'export-menu'\],\s*\['view-btn', 'view-menu'\],/);
  assert.match(app, /if \(e\.key === '\/'\) \{\s*e\.preventDefault\(\);\s*this\.openFind\(\);/);
  // the old places are gone: no search box in the toolbar, no filter box always at the top of the outline
  assert.ok(!header.includes('class="search-wrap"'));
  const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');
  assert.match(inspector, /if \(this\.filterOpen \|\| this\.filter\) \{/);
});

test('diagram filters: one group at the right of the toolbar, with a Filters drop-down for what does not fit', () => {
  const group = /<div id="view-filters" class="view-filters" role="group" aria-label="Diagram filters">([\s\S]*?)\n  <\/div>\n<\/header>/.exec(html);
  assert.ok(group, 'the filters are one group, the last thing in the toolbar');
  const opts = [...group[1].matchAll(/<label class="opt[^"]*" data-priority="(\d)"[^>]*><input id="([^"]+)"/g)].map((m) => [m[2], Number(m[1])]);
  assert.deepEqual(opts, [['opt-labels', 5], ['opt-groups', 4], ['opt-networks', 3], ['opt-type-endpoint', 2], ['opt-type-server', 1]]);
  assert.match(group[1], /<button id="more-filters-btn" type="button" class="menu-btn" aria-haspopup="true" aria-expanded="false" aria-controls="more-filters" hidden>Filters/);
  assert.match(css, /\.view-filters \{[^}]*flex-wrap: nowrap;/);
});

test('Export menu: next to File, one entry "Export view as…" with a PNG / SVG submenu; the zoom bar has no Save SVG', () => {
  // order in the toolbar: File, Export, then the rest
  const at = ['id="menu-btn"', 'id="export-btn"', 'id="btn-undo"'].map((x) => header.indexOf(x));
  assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], JSON.stringify(at));
  assert.match(header, /<button id="export-btn" type="button" class="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="export-menu"[^>]*>Export <span class="caret"/);
  const exp = /<div id="export-menu" class="dropdown menu" role="menu" aria-label="Export" hidden>([\s\S]*?)\n    <\/div>/.exec(header)[1];
  const entries = (s) => [...s.matchAll(/<button id="([^"]+)"[^>]*role="menuitem"[^>]*><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]);
  const sub = /<div id="export-formats" class="submenu" role="menu" aria-label="Export view as" hidden>([\s\S]*?)\n      <\/div>/.exec(exp);
  assert.ok(sub, 'the submenu is part of the Export menu and closed at first');
  // one entry in the menu itself; it opens the submenu and is disabled until there is a diagram
  assert.deepEqual(entries(exp.replace(sub[0], '')), [['btn-export-as', 'Export view as…']]);
  assert.match(exp, /<button id="btn-export-as" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="export-formats"[^>]*disabled>/);
  // the formats: PNG and SVG, nothing else
  assert.deepEqual(entries(sub[1]), [['btn-export-png', 'PNG'], ['btn-export-svg', 'SVG']]);
  assert.doesNotMatch(exp, /pdf/i);
  // the same markup pattern as the File menu, and the same code drives both
  const fileBtn = /<button id="menu-btn"[^>]*>/.exec(header)[0];
  for (const attr of ['class="menu-btn"', 'aria-haspopup="menu"', 'aria-expanded="false"']) assert.ok(fileBtn.includes(attr), attr);
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /\['menu-btn', 'main-menu'\],\s*\['export-btn', 'export-menu'\],/);
  assert.match(app, /this\.\$\('btn-export-svg'\)\.addEventListener\('click', \(\) => void this\.exportView\('svg'\)\);/);
  assert.match(app, /this\.\$\('btn-export-png'\)\.addEventListener\('click', \(\) => void this\.exportView\('png'\)\);/);
  // the submenu opens on a press or a key, never on hover
  assert.doesNotMatch(app, /mouseenter|mouseover|pointerenter/);
  assert.doesNotMatch(css, /:hover[^{]*\.submenu|\.submenu[^{]*\{[^}]*display:\s*none/);
  // both formats are made from one picture, entirely in the page
  assert.match(app, /exportSvg\(\): string \{\s*return this\.buildExport\(\)\.text;/);
  assert.match(app, /const pic = this\.buildExport\(\);[\s\S]*?return svgToPng\(this\.doc, pic\.text, pic\.width, pic\.height,/);
  const files = readFileSync(join(root, 'src', 'ui', 'files.ts'), 'utf8');
  assert.match(files, /img\.src = 'data:image\/svg\+xml;charset=utf-8,' \+ encodeURIComponent\(svgText\);/);
  assert.doesNotMatch(files, /fetch\(|XMLHttpRequest|import\(/);
  // available only with a diagram
  assert.match(app, /const ex = this\.\$\('btn-export-as'\) as HTMLButtonElement;\s*ex\.disabled = !s;/);
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

test('PNG export: scale and file names', () => {
  const files = load('ui/files.js');
  // twice the diagram's size, as long as the picture stays within what a canvas can hold
  assert.equal(files.PNG_SCALE, 2);
  assert.equal(files.pngScale(1200, 800), 2);
  assert.equal(files.pngScale(3000, 3000), 2);
  assert.equal(files.pngScale(8000, 2000), 2);
  // too long on one side: reduced so the longest side is the limit
  assert.equal(files.pngScale(20000, 1000), files.PNG_MAX_SIDE / 20000);
  assert.ok(Math.round(20000 * files.pngScale(20000, 1000)) <= files.PNG_MAX_SIDE);
  // too many pixels: reduced so the area is the limit
  const s = files.pngScale(12000, 12000);
  assert.ok(s < 2 && s > 0 && 12000 * s * 12000 * s <= files.PNG_MAX_PIXELS * 1.0000001, String(s));
  // never enlarged beyond the preferred scale, never zero or NaN
  for (const [w, h] of [[1, 1], [0, 0], [NaN, 5], [1e7, 1e7]]) {
    const v = files.pngScale(w, h);
    assert.ok(v > 0 && v <= 2, `${w}x${h}: ${v}`);
  }
  // file names: the model's file name without its extension
  assert.equal(files.pictureBaseName('enterprise-wan.yaml'), 'enterprise-wan');
  assert.equal(files.pictureBaseName('my.network.v2.yml'), 'my.network.v2');
  assert.equal(files.pictureBaseName(''), 'netatlas');
  assert.equal(files.pictureBaseName('a/b:c.yaml'), 'a_b_c');
});

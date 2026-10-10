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

test('toolbar: logo and version, then File, Export, Find, Help, undo/redo, views, Auto-arrange, the diagram filters; no Current model button', () => {
  const order = ['class="brand"', 'class="version"', 'id="menu-btn"', 'id="export-btn"', 'id="find-btn"', 'id="help-btn"', 'id="btn-undo"', 'id="btn-redo"', 'data-view-btn="physical"', 'data-view-btn="logical"', 'id="arrange-group"', 'id="view-filters"'];
  const at = order.map((x) => header.indexOf(x));
  assert.ok(at.every((p) => p >= 0), JSON.stringify(at));
  assert.deepEqual(at, at.slice().sort((p, q) => p - q), 'in this order');
  assert.match(header, /<span>netatlas<\/span><span class="version"[^>]*>v__VERSION__<\/span>/);
  // these stay direct controls: none of them is inside the menu
  for (const id of ['btn-undo', 'btn-redo', 'arrange-group', 'btn-arrange-default', 'btn-arrange-compact', 'btn-arrange-spacious']) assert.ok(!menu.includes(`id="${id}"`), id);
  // Find is not in the toolbar any more: it opens from the Find menu (or "/") as a bar over the diagram
  assert.ok(!header.includes('id="search"') && html.includes('id="find-bar"'));
  assert.ok(!/data-view-btn/.test(menu));
  // the "Current model" button is gone, with its styles, its handler and the state it showed
  const appSrc = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.doesNotMatch(html + css + appSrc, /btn-model|model-badge|model-btn|Current model/);
});

test('File menu: New model, Open model…, Save model, Save model as…, Close model and the examples; "model" throughout, "…" only where input follows', () => {
  assert.match(header, /<button id="menu-btn"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="main-menu"[^>]*>File /);
  assert.match(header, /<div id="main-menu" class="dropdown menu" role="menu"[^>]*hidden>/);
  const entries = [...menu.matchAll(/<button id="([^"]+)"[^>]*role="menuitem"[^>]*><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(entries, [['btn-new', 'New model'], ['open', 'Open model…'], ['btn-save', 'Save model'], ['btn-save-as', 'Save model as…'], ['btn-close', 'Close model']]);
  // one wording rule for every entry: verb + "model", sentence case; "…" (the character, not three dots)
  // exactly where the command asks for something first (a file to open, a name and place to save to);
  // Save model and Close model act at once (Close asks only when there are unsaved changes)
  for (const [, label] of entries) assert.match(label, /^(New|Open|Save|Close) model( as)?(…)?$/);
  for (const [id, label] of entries) assert.equal(label.endsWith('…'), id === 'open' || id === 'btn-save-as', label);
  assert.doesNotMatch(menu + header, /\.\.\.|YAML file…|Download model/);
  // both save entries are always there; until a model is open, they (and Close) are unavailable
  for (const id of ['btn-save', 'btn-save-as', 'btn-close']) assert.match(menu, new RegExp(`<button id="${id}" type="button" role="menuitem" title="[^"]*" disabled>`), id);
  assert.match(menu, /id="btn-close"[^>]*title="Close the current model and return to the start screen"/);
  // tooltips say what each command does; the shortcuts are on the save entries
  assert.match(menu, /id="btn-new"[^>]*title="Start a new, empty model"/);
  assert.match(menu, /id="open"[^>]*title="Open a model from a YAML file on this computer \(nothing is uploaded\)"/);
  assert.deepEqual([...menu.matchAll(/class="mi-hint">([^<]*)</g)].map((m) => m[1]), ['Ctrl+S', 'Ctrl+Shift+S']);
  // the save entries' tooltips follow the state: linked or not, a browser that can save to a chosen file or only download
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /save\.disabled = !this\.linked;/);
  assert.match(app, /saveAs\.disabled = !d;/);
  assert.match(app, /`Save the model to “\$\{this\.handle\.name\}” \(Ctrl\+S\)/);
  assert.match(app, /'Not available: the model is not linked to a file this page may write\. Use Save model as… to choose one\.'/);
  assert.match(app, /'Download a copy of the model as a YAML file: this browser can’t save to a file you choose \(Ctrl\+Shift\+S\)'/);
  // the start screen and the error page use the same words
  assert.match(html, /<button id="open-empty"[^>]*>\s*<span class="start-title">Open model…<\/span>\s*<span class="start-sub">Choose a YAML file, or drop one here<\/span>/);
  assert.match(app, /\['Open another model…'\]/);
  assert.match(menu, /<div class="menu-title" id="menu-examples-title">Examples<\/div>\s*<div id="menu-examples" role="group" aria-labelledby="menu-examples-title"><\/div>/);
  // and nowhere else in the toolbar
  const outside = header.replace(menu, '');
  for (const gone of ['id="btn-new"', 'id="open"', 'id="btn-save"', 'id="btn-save-as"', 'id="btn-download"', 'id="examples"', '<select']) assert.ok(!outside.includes(gone), gone);
  // the examples are filled in from the embedded files, one entry each, with a place for the "open · modified" state
  assert.match(app, /const menu = this\.\$\('menu-examples'\);\s+EXAMPLES\.forEach/);
  assert.match(app, /el\(this\.doc, 'span', \{ class: 'mi-hint ex-state' \}\)/);
  // modified state is shown by a dot, never by a different border colour of a button
  assert.doesNotMatch(css, /data-dirty="true"\][^{]*\{[^}]*border-color/);
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

test('examples: the File menu offers the eight hand-written examples; the generated fixtures are test data only', async () => {
  const { readdirSync } = await import('node:fs');
  const { EXAMPLES, FIXTURES } = load('generated/examples.js');
  assert.deepEqual(EXAMPLES.map((e) => e.name), ['enterprise-wan.yaml', 'datacenter-evpn.yaml', 'minimal.yaml', 'metro-ring.yaml', 'device-types.yaml', 'long-labels.yaml', 'addressing.yaml', 'port-bindings.yaml']);
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

test('Find menu: next to Export, with Find in diagram… (/) and Filter object list…, each the one place of its action', () => {
  const at = ['id="export-btn"', 'id="find-btn"', 'id="btn-undo"'].map((x) => header.indexOf(x));
  assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], JSON.stringify(at));
  // the same markup as File and Export, driven by the same code; named "Find" (visible, tooltip and the menu's accessible name),
  // so it isn't mistaken for the View group of Physical / Logical, and takes little room
  assert.match(header, /<button id="find-btn" type="button" class="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="find-menu" title="Find: find in the diagram, filter the object list">Find <span class="caret"/);
  assert.doesNotMatch(html, /Find &amp; Filter|Find & Filter/, 'the old name is gone');
  assert.doesNotMatch(header, />View <span class="caret"|aria-label="View"|title="View:/);
  assert.match(header, /<span id="view-title" class="tool-group-title">View<\/span>/, 'the View group of Physical / Logical keeps its name');
  const view = /<div id="find-menu" class="dropdown menu" role="menu" aria-label="Find" hidden>([\s\S]*?)\n    <\/div>/.exec(header)[1];
  const entries = [...view.matchAll(/<button id="([^"]+)"[^>]*role="menuitem"[^>]*disabled><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(entries, [['btn-find', 'Find in diagram…'], ['btn-outline-filter', 'Filter object list…']], 'both disabled until a model is open');
  // the labels say what each one works on: Find searches the diagram, the filter narrows the object list (not the diagram)
  assert.ok(!/Filter outline…|>Find…</.test(html), 'the old labels are gone');
  assert.match(html, /<div id="find-bar" class="find-bar" role="search" aria-label="Find in diagram" hidden>/);
  assert.deepEqual([...view.matchAll(/class="mi-hint">([^<]*)</g)].map((m) => m[1]), ['/']);
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /\['export-btn', 'export-menu'\],\s*\['find-btn', 'find-menu'\],\s*\['help-btn', 'help-menu'\],/);
  assert.match(app, /if \(e\.key === '\/'\) \{\s*e\.preventDefault\(\);\s*this\.openFind\(\);/);
  // the old places are gone: no search box in the toolbar, no filter box always at the top of the outline
  assert.ok(!header.includes('class="search-wrap"'));
  const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');
  assert.match(inspector, /if \(this\.filterOpen \|\| this\.filter\) \{/);
});

test('diagram filters: one group at the right of the toolbar, with a Filters drop-down for what does not fit', () => {
  const group = /<div id="filters-slot" class="filters-slot">\s*<div id="filters-group" class="tool-group filters-group" role="group" aria-label="Diagram filters">\s*<span id="filters-title" class="tool-group-title">Filters<\/span>\s*<div id="view-filters" class="view-filters">([\s\S]*?)\n  <\/div>\n  <\/div>\n  <\/div>\n  <div class="theme-wrap">[\s\S]*?<\/div>\n<\/header>/.exec(html);
  assert.ok(group, 'the filters are one labelled group, the last thing in the toolbar before the theme switch');
  const opts = [...group[1].matchAll(/<label class="opt[^"]*" data-priority="(\d)"[^>]*><input id="([^"]+)"/g)].map((m) => [m[2], Number(m[1])]);
  assert.deepEqual(opts, [['opt-labels', 5], ['opt-groups', 4], ['opt-networks', 3], ['opt-type-endpoint', 2], ['opt-type-server', 1]]);
  assert.match(group[1], /<button id="more-filters-btn" type="button" class="menu-btn" aria-haspopup="true" aria-expanded="false" aria-controls="more-filters" hidden disabled>Filters/);
  // on the start screen every filter is disabled; the app enables them once a model is drawn
  const inputs = [...group[1].matchAll(/<input id="(opt-[^"]+)"[^>]*>/g)];
  assert.equal(inputs.length, 5);
  for (const m of inputs) assert.match(m[0], / disabled>$/, m[1]);
  assert.match(group[1], /<button id="devices-btn"[^>]* disabled>/);
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
  assert.deepEqual(titles, ['New model', 'Open model…', 'Load example']);
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
  assert.match(app, /else if \(await this\.confirmDiscard\('Opening the dropped file'\)\) \{/);
  // a dropped file is linked for saving only when the browser hands over a handle the page may write
  assert.match(app, /void this\.loadFile\(f, isWritable\(h\) \? h : null\);/);
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

test('Auto-arrange: three direct options (Default, Compact, Spacious) in one labelled group; the matching one is selected and disabled', () => {
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  const group = /<div id="arrange-group"[^>]*>([\s\S]*?)\n  <\/div>/.exec(header);
  assert.ok(group, 'the group is in the toolbar');
  assert.match(header, /<div id="arrange-group" class="tool-group arrange-group" role="group" aria-labelledby="arrange-title" aria-describedby="arrange-status">/);
  assert.match(group[1], /<span id="arrange-title" class="tool-group-title arrange-title">Auto-arrange<\/span>/);
  // three buttons, directly in the toolbar (no menu, no dialog to pick one), each named for assistive technology
  const buttons = [...group[1].matchAll(/<button id="btn-arrange-(\w+)" type="button" class="arrange-btn" data-strategy="(\w+)" aria-label="Auto-arrange: (\w+)" aria-pressed="false" disabled>(\w+)<\/button>/g)].map((m) => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(buttons, [['default', 'default', 'Default', 'Default'], ['compact', 'compact', 'Compact', 'Compact'], ['spacious', 'spacious', 'Spacious', 'Spacious']]);
  // no check mark or edit icon any more
  assert.doesNotMatch(html + app + css, /arrange-icon|LAYOUT_STATUS_ICON|\\u270E/);
  // the state comes from the positions (document or filtered session), never from the last button pressed
  assert.match(app, /const matches = filtered \? s\.filteredArrangedWith\(view\) : d\.arrangedWith\(view\);/);
  assert.match(app, /const isCurrent = st === current;\s+const same = !isCurrent && matches\.indexOf\(st\) >= 0;\s+b\.disabled = isCurrent \|\| same;\s+b\.setAttribute\('aria-pressed', isCurrent \? 'true' : 'false'\);/);
  // the A key and any other caller go through the same check, so a disabled option cannot be bypassed
  assert.match(app, /if \(\(s\.isFiltered\(\) \? s\.filteredArrangedWith\(view\) : d\.arrangedWith\(view\)\)\.indexOf\(strategy\) >= 0\) return;/);
  assert.match(app, /else if \(e\.key === 'a'\) void this\.arrangeCurrentView\('default'\);/);
  // identical results are never presented as different
  assert.match(app, /gives exactly the same positions as \$\{STRATEGY_LABEL\[current as ArrangeStrategy\]\}/);
  // the selected option looks like the active view switch; the CSS has no orange or dashed treatment
  assert.match(css, /\.arrange-btn\.current, \.arrange-btn\.current:disabled \{[^}]*background: var\(--accent-soft\);[^}]*border-color: var\(--accent\);/);
  assert.doesNotMatch(css, /\.arrange-btn\[data-status/);
  // presentation: the label above one row of the three buttons, the whole group in a dashed frame
  assert.match(group[1], /<span id="arrange-title"[^>]*>Auto-arrange<\/span>\s*<div class="arrange-btns">\s*<button id="btn-arrange-default"[\s\S]*?<button id="btn-arrange-spacious"[^>]*>Spacious<\/button>\s*<\/div>/);
  assert.match(css, /\.tool-group \{[^}]*flex-direction: column;[^}]*border: 1px dashed var\(--frame\);/);
  assert.match(css, /\.arrange-btns \{ display: flex; \}/);
  // the label takes no width above the buttons, so no narrow toolbar hides it
  for (const block of css.match(/@container[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g) || []) assert.doesNotMatch(block, /\.(arrange-title|tool-group-title)/);
});

test('toolbar groups: View, Auto-arrange and Filters each have a label above their controls, in the same dashed frame', () => {
  // the same classes, so one CSS definition gives all three the same frame, spacing and label
  assert.match(header, /<div id="view-group" class="tool-group view-group" role="group" aria-labelledby="view-title">\s*<span id="view-title" class="tool-group-title">View<\/span>\s*<div class="seg">\s*<button type="button" data-view-btn="physical" title="Physical view \(P\)">Physical<\/button>\s*<button type="button" data-view-btn="logical" title="Logical view \(L\)">Logical<\/button>\s*<\/div>\s*<\/div>/);
  assert.match(header, /<div id="arrange-group" class="tool-group arrange-group"[^>]*>\s*<span id="arrange-title" class="tool-group-title arrange-title">Auto-arrange<\/span>/);
  assert.match(header, /<div id="filters-group" class="tool-group filters-group" role="group" aria-label="Diagram filters">\s*<span id="filters-title" class="tool-group-title">Filters<\/span>/);
  assert.equal((header.match(/class="tool-group /g) || []).length, 3);
  assert.equal((header.match(/class="tool-group-title/g) || []).length, 3);
  // order unchanged: the views, then Auto-arrange, then the filters
  const at = ['id="view-group"', 'data-view-btn="physical"', 'data-view-btn="logical"', 'id="arrange-group"', 'id="filters-group"', 'id="devices-btn"', 'id="opt-labels"', 'id="opt-type-server"', 'id="more-filters-btn"'].map((x) => header.indexOf(x));
  assert.deepEqual(at, at.slice().sort((p, q) => p - q));
  // frame, label and padding are defined once, so the groups can't drift apart
  assert.doesNotMatch(css, /\.(view-group|arrange-group|filters-group) \{[^}]*(border|padding)/);
  assert.match(css, /\.tool-group-title \{[^}]*font-size: 10px;/);
  // the frame is clearly visible: its colour has at least 3:1 contrast against the toolbar, in the light and the dark theme,
  // and stays a hairline, dashed, so it does not outweigh the controls
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const light = /:root\[data-theme="light"\] \{([^}]*)\}/.exec(css)[1];
  const dark = /:root, :root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)[1];
  for (const [name, vars] of [['light', light], ['dark', dark]]) {
    const v = (k) => new RegExp('--' + k + ': (#[0-9a-f]{6});').exec(vars)[1];
    assert.ok(ratio(v('frame'), v('panel')) >= 3, `${name}: frame ${v('frame')} on ${v('panel')} = ${ratio(v('frame'), v('panel')).toFixed(2)}:1`);
    assert.ok(ratio(v('frame'), v('panel')) > ratio(v('border'), v('panel')) + 1, `${name}: clearly stronger than the old border colour`);
  }
  assert.match(css, /\.tool-group \{[^}]*padding: 2px 6px 4px; border: 1px dashed var\(--frame\); border-radius: 8px;/);
  // the filter row keeps its collapsing (App.layoutFilters); it now measures the slot that holds the group
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /const avail = slot\.clientWidth - chrome;/);
});

test('Help menu: right after Find, with User Manual and License (always available, each opening a dialog)', () => {
  const at = ['id="find-btn"', 'id="help-btn"', 'id="btn-undo"'].map((x) => header.indexOf(x));
  assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], JSON.stringify(at));
  // nothing else stands between the Find menu and the Help menu
  assert.match(header, /<div id="find-menu"[\s\S]*?\n    <\/div>\n  <\/div>\n  <div class="menu-wrap">\n    <button id="help-btn"/);
  assert.match(header, /<button id="help-btn" type="button" class="menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="help-menu" title="Help: user manual and license">Help <span class="caret"/);
  const help = /<div id="help-menu" class="dropdown menu" role="menu" aria-label="Help" hidden>([\s\S]*?)\n    <\/div>/.exec(header)[1];
  const entries = [...help.matchAll(/<button id="([^"]+)" type="button" role="menuitem" aria-haspopup="dialog"[^>]*><span class="mi-label">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(entries, [['btn-manual', 'User Manual'], ['btn-license', 'License']]);
  assert.doesNotMatch(help, /disabled/, 'Help needs no model');
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  assert.match(app, /this\.\$\('btn-manual'\)\.addEventListener\('click', \(\) => void this\.openHelp\('manual'\)\);/);
  assert.match(app, /this\.\$\('btn-license'\)\.addEventListener\('click', \(\) => void this\.openHelp\('license'\)\);/);
  // both dialogs: a × as well as Close, Esc, and the focus back on the Help button afterwards
  assert.match(app, /closeButton: true,/);
  assert.match(app, /await done;[\s\S]{0,200}this\.\$\('help-btn'\)\.focus\(\);/);
});

test('Help → License names the license of LICENSE and package.json, and embeds its full text', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'Apache-2.0');
  const license = readFileSync(join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(license, /^\s*Apache License\n\s*Version 2\.0, January 2004\n/);
  const help = load('ui/help.js');
  assert.equal(help.LICENSE_ID, pkg.license);
  assert.equal(help.LICENSE_NAME, 'Apache License, Version 2.0');
  const { LICENSE_TEXT, MANUAL_IMAGES } = load('generated/help-assets.js');
  assert.equal(LICENSE_TEXT, license, 'the embedded text is the LICENSE file');
  // every screenshot the manual refers to is embedded, as a data: URL (the page may load nothing else)
  const src = readFileSync(join(root, 'src', 'ui', 'help.ts'), 'utf8');
  const named = [...src.matchAll(/\['([a-z-]+)', '[^']+'\]/g)].map((m) => m[1]);
  assert.ok(named.length >= 8, named.join());
  for (const n of named) {
    assert.ok(MANUAL_IMAGES[n], 'missing screenshot ' + n);
    assert.match(MANUAL_IMAGES[n].src, /^data:image\/webp;base64,/);
    assert.ok(MANUAL_IMAGES[n].width > 100 && MANUAL_IMAGES[n].height > 50, n);
  }
});

// The command registry and the command palette: one registry that the menus,
// the keyboard and the palette all read (labels, shortcuts, availability),
// fuzzy matching, ranking with recent entries, and the objects it can select.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, validate, load, example } from './helpers.mjs';

const C = load('ui/commands.js');
const P = load('ui/palette.js');
const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
const commands = C.buildCommands();
const byId = new Map(commands.map((c) => [c.id, c]));

test('the registry: unique ids, every command with a label, a group, a state and an action; no shortcut used twice', () => {
  assert.equal(byId.size, commands.length);
  for (const c of commands) assert.ok(c.label && c.group && typeof c.state === 'function' && typeof c.run === 'function', c.id);
  const seen = new Map();
  for (const c of commands) {
    for (const k of c.keys ? c.keys.combos : []) {
      const sig = `${k.mod ? 'mod+' : ''}${k.shift === undefined ? '' : k.shift ? 'shift+' : 'noshift+'}${k.mod ? k.key.toLowerCase() : k.key}`;
      assert.ok(!seen.has(sig), `${sig}: ${seen.get(sig)} and ${c.id}`);
      seen.set(sig, c.id);
    }
  }
  // what the palette must offer
  for (const id of ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'export.png', 'export.svg', 'find.diagram', 'find.outline', 'palette.open', 'analyze.addressing', 'focus.enter', 'focus.exit', 'focus.more', 'focus.fewer', 'trace.open', 'trace.copy', 'trace.exit', 'analyze.spof', 'sim.exit', 'help.manual', 'help.license', 'edit.undo', 'edit.redo', 'view.physical', 'view.logical', 'arrange.default', 'arrange.compact', 'arrange.spacious', 'zoom.fit', 'theme.toggle', 'filter.labels', 'filter.types', 'filter.devices', 'panel.problems', 'example.0', 'focus.window', 'window.focus', 'window.focusBack', 'window.close', 'sim.start']) {
    assert.ok(byId.has(id), id);
  }
  assert.equal(commands.filter((c) => c.group === 'Example').length, load('generated/examples.js').EXAMPLES.length);
});

test('the menus are the registry: every entry names its command, with the same label and shortcut', () => {
  const entries = [...html.matchAll(/<button id="([^"]+)" type="button" role="menuitem"[^>]*data-command="([^"]+)"[^>]*>(.*?)<\/button>/g)];
  assert.ok(entries.length >= 15, String(entries.length));
  for (const [, id, cmd, inner] of entries) {
    const c = byId.get(cmd);
    assert.ok(c, `${id}: ${cmd}`);
    const label = /<span class="mi-label">([^<]*)<\/span>/.exec(inner)[1];
    assert.equal(label, c.menuLabel || c.label, id);
    const hint = /<span class="mi-hint">([^<]*)<\/span>/.exec(inner);
    if (c.keys) assert.equal(hint && hint[1], C.keyLabel(c.keys), `${id}: shortcut`);
  }
  // every menu entry that acts (not a submenu or an example) names a command
  const plain = [...html.matchAll(/<button id="([^"]+)" type="button" role="menuitem"(?![^>]*aria-haspopup="menu")(?![^>]*data-command)[^>]*>/g)].map((m) => m[1]);
  assert.deepEqual(plain, []);
  // no menu entry is wired by hand any more: one delegated listener runs the commands
  for (const id of ['btn-new', 'btn-save', 'btn-save-as', 'btn-close', 'btn-export-png', 'btn-export-svg', 'btn-find', 'btn-outline-filter', 'btn-addressing', 'btn-manual', 'btn-license']) {
    assert.doesNotMatch(app, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('click'`), id);
  }
  assert.match(app, /closest\('\[data-command\]'\)[\s\S]{0,200}this\.runCommand\(/);
  // the keyboard goes through the registry too
  assert.match(app, /for \(const c of this\.commands\) \{\s*if \(!c\.keys \|\| \(typing && !c\.keys\.whileTyping\) \|\| !matchesKey\(c\.keys, e\)\) continue;/);
});

test('shortcuts: labels (Ctrl or Cmd) and matching', () => {
  assert.equal(C.keyLabel(byId.get('file.save').keys), 'Ctrl+S');
  assert.equal(C.keyLabel(byId.get('file.save').keys, true), 'Cmd+S');
  assert.equal(C.keyLabel(byId.get('palette.open').keys), 'Ctrl+K');
  assert.equal(C.keyLabel(byId.get('focus.window').keys), 'Shift+F');
  assert.equal(C.keyLabel(byId.get('window.focus').keys), 'F6');
  assert.equal(C.keyLabel(byId.get('trace.open').keys), 'T');
  // no X, [ or ]: there are no scenarios and nothing fails outside a simulation
  assert.ok(!byId.has('sim.add') && !byId.has('sim.prev') && !byId.has('sim.next'));
  assert.ok(!commands.some((c) => c.keys && c.keys.combos.some((k) => ['x', 'X', '[', ']'].indexOf(k.key) >= 0 && !k.mod)));
  assert.equal(C.keyLabel(byId.get('find.diagram').keys), '/');
  assert.equal(C.keyLabel(byId.get('view.physical').keys), 'P');
  const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.ok(C.matchesKey(byId.get('palette.open').keys, ev('k', { ctrlKey: true })));
  assert.ok(C.matchesKey(byId.get('palette.open').keys, ev('k', { metaKey: true })), 'Cmd+K on a Mac');
  assert.ok(!C.matchesKey(byId.get('palette.open').keys, ev('k')));
  assert.ok(C.matchesKey(byId.get('file.saveAs').keys, ev('S', { ctrlKey: true, shiftKey: true })));
  assert.ok(!C.matchesKey(byId.get('file.save').keys, ev('S', { ctrlKey: true, shiftKey: true })));
  assert.ok(C.matchesKey(byId.get('edit.redo').keys, ev('Z', { ctrlKey: true, shiftKey: true })));
  assert.ok(C.matchesKey(byId.get('focus.window').keys, ev('F', { shiftKey: true })));
  assert.ok(!C.matchesKey(byId.get('focus.window').keys, ev('f')));
  assert.ok(C.matchesKey(byId.get('zoom.fit').keys, ev('f')));
  assert.ok(!C.matchesKey(byId.get('view.physical').keys, ev('p', { altKey: true })), 'never with Alt');
});

test('fuzzy matching: substrings at word starts first, then subsequences; every word must match', () => {
  const s = (q, t) => P.fuzzyScore(q, t);
  assert.equal(s('xyz', 'Save model'), null);
  assert.ok(s('save', 'Save model') > s('save', 'Save model as…'), 'the shorter text first among equals');
  assert.ok(s('mod', 'Save model') > s('odel', 'Save model'), 'a word start beats the middle of a word');
  assert.ok(s('svmd', 'Save model') !== null, 'a subsequence');
  assert.ok(s('save', 'Save model') > s('svmd', 'Save model'), 'a substring beats a subsequence');
  assert.ok(s('model save', 'Save model') !== null && s('model sve', 'Load example') === null);
  assert.equal(s('', 'anything'), 0);
});

test('ranking: without a query the recent entries, then every command; with one, the best matches (unavailable ones too, with the reason)', () => {
  const items = [
    { key: 'cmd:a', kind: 'command', label: 'Save model', sub: 'File', keys: 'Ctrl+S', words: '', state: { enabled: false, reason: 'Open or create a model first' }, mode: false },
    { key: 'cmd:b', kind: 'command', label: 'Open model…', sub: 'File', keys: '', words: 'load', state: { enabled: true }, mode: false },
    { key: 'ref:device:r1', kind: 'object', label: 'r1', sub: 'device', keys: '', words: 'router', state: { enabled: true }, mode: false },
  ];
  const empty = P.rankItems(items, '', ['ref:device:r1', 'cmd:gone']);
  assert.deepEqual(empty.items.map((x) => [x.key, x.recent]), [['ref:device:r1', true], ['cmd:a', false], ['cmd:b', false]]);
  const q = P.rankItems(items, 'model', []);
  assert.deepEqual(q.items.map((x) => x.key), ['cmd:a', 'cmd:b']);
  assert.equal(q.items[0].state.reason, 'Open or create a model first');
  assert.deepEqual(P.rankItems(items, 'load', []).items.map((x) => x.key), ['cmd:b'], 'keywords count');
  assert.deepEqual(P.rankItems(items, 'r1', []).items.map((x) => x.key), ['ref:device:r1']);
  assert.equal(P.resultsText(0, 0, 'zz'), 'No results.');
  assert.equal(P.resultsText(1, 0, 'a'), '1 result.');
  assert.equal(P.resultsText(60, 12, 'a'), '60+ results.');
});

test('objects: devices, interfaces, links, networks, relations, routes and groups of the model, each selectable by ref', () => {
  const m = validate.loadModel(example('branch-routing.yaml')).model;
  const items = P.objectItems(m);
  const wan = P.objectItems(validate.loadModel(example('enterprise-wan.yaml')).model);
  const kinds = new Set(items.concat(wan).map((x) => x.sub));
  for (const k of ['device', 'interface', 'link', 'network', 'relation', 'route', 'group']) assert.ok(kinds.has(k), k);
  const refs = items.map((x) => x.key.slice(4));
  assert.equal(new Set(refs).size, refs.length, 'each once');
  const q = load('model/queries.js');
  for (const r of refs) assert.ok(q.refExists(m, r), r);
  assert.ok(items.some((x) => x.key === 'ref:route:br-rtr:1' && /0\.0\.0\.0\/0 via 203\.0\.113\.5/.test(x.label)));
  // a route is found by its next hop, a network by its prefix
  assert.equal(P.rankItems(items, '203.0.113.5', []).items[0].sub, 'route');
  assert.equal(P.rankItems(items, '10.20.10.0', []).items.find((x) => x.sub === 'network').key, 'ref:network:br-users');
});

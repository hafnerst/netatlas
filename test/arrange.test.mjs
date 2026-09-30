// Auto-arrange works on one view: the one on screen. The other view is not
// touched, and positions set by hand are replaced only after a confirmation
// (the dialog itself is exercised in the browser self-test; these tests
// cover what it is built on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, example, fixture, yaml } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const posText = (m) => JSON.stringify(Array.from(m.entries()).sort((p, q) => (p[0] < q[0] ? -1 : 1)));
/** everything a view has in the document: displayed positions, stored positions, hand-placed nodes */
const viewState = (d, v) => JSON.stringify([posText(d.displayedPositions(v)), posText(d.result.model.layout[v]), Array.from(d.result.model.layout.manual[v])]);
/** the view's lines of the layout section, as written */
const yamlOf = (d, v) => {
  const t = d.exportText();
  const lay = t.indexOf('\nlayout:');
  if (lay < 0) return '';
  const m = new RegExp(`\\n  ${v}:\\n((?:    .*\\n)*)`).exec(t.slice(lay));
  const man = new RegExp(`\\n  manual:\\n(?:    .*\\n)*?    ${v}: (.*)\\n`).exec(t.slice(lay));
  return (m ? m[1] : '') + '|' + (man ? man[1] : '');
};

test('arranging one view leaves the other view exactly as it was', () => {
  const d = doc(example('enterprise-wan.yaml'));
  d.movePositions('physical', new Map([['hq-fw', { x: 3000, y: -500 }]]), 'Move');
  d.movePositions('logical', new Map([['hq-rtr1', { x: -2000, y: 900 }], ['net-users', { x: 50, y: 60 }]]), 'Move');
  assert.deepEqual([d.layoutStatus('physical'), d.layoutStatus('logical')], ['manual', 'manual']);
  const phys = viewState(d, 'physical');
  const physYaml = yamlOf(d, 'physical');
  assert.match(physYaml, /hq-fw: \[3000, -500\]/);
  assert.match(physYaml, /\|\[hq-fw\]$/);

  const res = d.arrange(['logical']);
  assert.deepEqual(res, { changed: true, moved: 2 });
  assert.equal(d.canUndo(), 'Auto-arrange (logical view)');
  assert.deepEqual([d.layoutStatus('physical'), d.layoutStatus('logical')], ['manual', 'auto']);
  // the physical view: same displayed positions, same stored positions, same hand-placed list, same YAML
  assert.equal(viewState(d, 'physical'), phys);
  assert.equal(yamlOf(d, 'physical'), physYaml);
  assert.deepEqual(d.displayedPositions('physical').get('hq-fw'), { x: 3000, y: -500 });
  // the logical view is the deterministic layout, and nothing in it is marked as placed by hand any more
  assert.equal(posText(d.displayedPositions('logical')), posText(d.autoLayout('logical')));
  assert.deepEqual(Array.from(d.result.model.layout.manual.logical), []);

  // … and the other way round
  const log = viewState(d, 'logical');
  const logYaml = yamlOf(d, 'logical');
  assert.deepEqual(d.arrange(['physical']), { changed: true, moved: 1 });
  assert.equal(viewState(d, 'logical'), log);
  assert.equal(yamlOf(d, 'logical'), logYaml);
  assert.deepEqual([d.layoutStatus('physical'), d.layoutStatus('logical')], ['auto', 'auto']);
  // one undo step per arrange, each restoring only its own view
  d.undo();
  assert.deepEqual([d.layoutStatus('physical'), d.layoutStatus('logical')], ['manual', 'auto']);
  assert.equal(viewState(d, 'logical'), log);
});

test('arranging a view that has no stored positions stores that view only', () => {
  const d = doc(example('metro-ring.yaml'));
  assert.ok(!d.hasStoredLayout('physical') && !d.hasStoredLayout('logical'));
  const before = { physical: posText(d.displayedPositions('physical')), logical: posText(d.displayedPositions('logical')) };
  assert.deepEqual(d.arrange(['physical']), { changed: true, moved: 0 });
  assert.ok(d.hasStoredLayout('physical') && !d.hasStoredLayout('logical'));
  assert.doesNotMatch(d.exportText(), /\n  logical:/);
  assert.equal(posText(d.displayedPositions('physical')), before.physical);
  assert.equal(posText(d.displayedPositions('logical')), before.logical);
  assert.deepEqual([d.layoutStatus('physical'), d.layoutStatus('logical')], ['auto', 'auto']);
});

test('what would be overwritten: only hand-placed nodes that differ from the auto layout ask for a confirmation', () => {
  const d = doc(example('enterprise-wan.yaml'));
  // a view that shows the auto-arranged layout: nothing to confirm, nothing to move
  assert.deepEqual(d.arrangeImpact('logical'), { moved: [], manual: [] });
  assert.deepEqual(d.arrangeImpact('physical'), { moved: [], manual: [] });
  d.arrange(['logical']);
  assert.deepEqual(d.arrangeImpact('logical'), { moved: [], manual: [] }, 'stored, and equal to the auto layout');

  // hand-placed nodes are named; the other view is unaffected
  d.movePositions('logical', new Map([['hq-fw', { x: 4321, y: 1234 }], ['net-users', { x: -900, y: -900 }]]), 'Move');
  assert.deepEqual(d.arrangeImpact('logical'), { moved: ['hq-fw', 'net-users'], manual: ['hq-fw', 'net-users'] });
  assert.deepEqual(d.arrangeImpact('physical'), { moved: [], manual: [] });
  assert.equal(d.layoutStatus('logical'), 'manual');

  // asking is read-only: no edit, no undo step, no change to either view (this is what Cancel relies on)
  const text = d.exportText();
  const undo = d.canUndo();
  const version = d.version;
  const views = [viewState(d, 'physical'), viewState(d, 'logical')];
  for (let i = 0; i < 3; i++) d.arrangeImpact('logical');
  assert.deepEqual([d.exportText(), d.canUndo(), d.version, viewState(d, 'physical'), viewState(d, 'logical')], [text, undo, version, ...views]);

  // a node moved back to its calculated position is not an adjustment any more
  d.movePositions('logical', new Map([['net-users', d.autoLayout('logical').get('net-users')]]), 'Move back');
  assert.deepEqual(d.arrangeImpact('logical'), { moved: ['hq-fw'], manual: ['hq-fw'] });
  d.movePositions('logical', new Map([['hq-fw', d.autoLayout('logical').get('hq-fw')]]), 'Move back');
  assert.deepEqual(d.arrangeImpact('logical'), { moved: [], manual: [] });
  assert.equal(d.layoutStatus('logical'), 'auto');
});

test('a view that only differs because the model was edited has nothing placed by hand to overwrite', () => {
  const d = doc(example('enterprise-wan.yaml'));
  d.arrange(['physical']);
  d.addEntity('device', [['id', yaml.strNode('hq-spare')], ['type', yaml.strNode('switch')], ['group', yaml.strNode('hq-core')]]);
  assert.equal(d.layoutStatus('physical'), 'edited');
  const impact = d.arrangeImpact('physical');
  assert.ok(impact.moved.length > 0);
  assert.deepEqual(impact.manual, []);
  // with one hand-placed node among them, only that one is a manual adjustment
  d.movePositions('physical', new Map([['hq-spare', { x: 7000, y: 7000 }]]), 'Move');
  assert.deepEqual(d.arrangeImpact('physical').manual, ['hq-spare']);
  assert.equal(d.layoutStatus('physical'), 'manual');
  d.arrange(['physical']);
  assert.equal(d.layoutStatus('physical'), 'auto');
  assert.deepEqual(d.arrangeImpact('physical'), { moved: [], manual: [] });
});

test('auto-arrange stays deterministic and idempotent, and the status follows', () => {
  for (const [f, text] of [['enterprise-wan.yaml', example('enterprise-wan.yaml')], ['metro-ring.yaml', example('metro-ring.yaml')], ['editor-new-network.yaml', fixture('editor-new-network.yaml')]]) {
    for (const view of ['physical', 'logical']) {
      const a = doc(text);
      a.clearLayout();
      const first = a.arrange([view]);
      const stored = yamlOf(a, view);
      const undo = a.canUndo();
      const version = a.version;
      // again: nothing at all happens
      assert.deepEqual(a.arrange([view]), { changed: false, moved: 0 }, `${f} ${view}`);
      assert.deepEqual([yamlOf(a, view), a.canUndo(), a.version], [stored, undo, version], `${f} ${view}`);
      assert.equal(a.layoutStatus(view), 'auto');
      assert.equal(first.changed, true);
      // whatever was dragged before, the result is the same
      const b = doc(text);
      b.clearLayout();
      const some = Array.from(b.displayedPositions(view).keys()).slice(0, 3);
      b.movePositions(view, new Map(some.map((id, i) => [id, { x: 5000 + i * 300, y: -4000 }])), 'Move');
      assert.equal(b.layoutStatus(view), 'manual');
      b.arrange([view]);
      assert.equal(yamlOf(b, view), stored, `${f} ${view}`);
      assert.equal(b.layoutStatus(view), 'auto');
    }
  }
});

test('the application has no "both views" choice: the button arranges the view on screen and asks only about manual positions', () => {
  const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');
  const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
  assert.doesNotMatch(app + html, /Arrange both views|value: 'both'|arrangeDialog|current view or both/);
  // the only arrange call in the UI passes exactly the current view
  assert.deepEqual(app.match(/\.arrange\([^)]*\)/g), ['.arrange([view])']);
  assert.match(app, /const impact = d\.arrangeImpact\(view\);\s+if \(impact\.manual\.length\) \{/);
  assert.match(app, /if \(a !== 'arrange'\) return;/);
  assert.match(html, /<span class="arrange-label">Auto-arrange<\/span>/);
  const dist = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
  assert.doesNotMatch(dist, /Arrange both views/);
  assert.match(dist, /Replace manual positions in the \$\{view\} view\?/);
});

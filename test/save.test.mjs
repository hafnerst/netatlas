// Saving: the File menu's words and the save capabilities, the outcomes of
// writing to a file (written, refused, failed — never a lost edit), and the
// modified state, which is a comparison with what was last saved. The
// interaction (pickers, dialogs, example marks) runs in the browser self-test
// with stand-ins for the browser's file handles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, example } from './helpers.mjs';

const F = load('ui/files.js');
const { ModelDoc } = load('editor/document.js');
const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
const app = readFileSync(join(root, 'src', 'ui', 'app.ts'), 'utf8');

/** a stand-in for a file handle of the File System Access API */
function handle({ perm = 'granted', request = perm, fail = null } = {}) {
  const h = {
    kind: 'file',
    name: 'net.yaml',
    text: '',
    asked: 0,
    queryPermission: async () => perm,
    requestPermission: async () => {
      h.asked++;
      return request;
    },
    createWritable: async () => {
      let buf = '';
      return {
        write: async (d) => {
          if (fail) throw fail;
          buf += d;
        },
        close: async () => {
          h.text = buf;
        },
      };
    },
  };
  return h;
}

test('File menu wording: "model" in every entry, "…" exactly where input follows, both save entries always present', () => {
  const menu = /<div id="main-menu"[^>]*>([\s\S]*?)\n    <\/div>/.exec(html)[1];
  const labels = [...menu.matchAll(/<span class="mi-label">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ['New model', 'Open model…', 'Save model', 'Save model as…', 'Close model']);
  assert.doesNotMatch(html + app, /Download model|Download first…|Download and close|btn-download/);
  // the error page, the start screen and the questions before replacing or closing use the same words
  assert.match(html, /<span class="start-title">Open model…<\/span>/);
  assert.match(app, /label: this\.linked \? 'Save first' : 'Save as first…'/);
  assert.match(app, /const saveLabel = linked \? 'Save and close' : 'Save as and close…';/);
});

test('the capabilities are detected, never assumed: no picker without the API or outside a secure context', () => {
  assert.deepEqual(F.detectFileAccess(null), { saveFile: null, openFile: null });
  assert.deepEqual(F.detectFileAccess({}), { saveFile: null, openFile: null }, 'Firefox, Safari: downloads only');
  assert.deepEqual(F.detectFileAccess({ isSecureContext: false, showSaveFilePicker() {}, showOpenFilePicker() {} }), { saveFile: null, openFile: null });
  let opts = null;
  const w = { isSecureContext: true, showSaveFilePicker: async (o) => ((opts = o), handle()), showOpenFilePicker: async () => [handle()] };
  const fa = F.detectFileAccess(w);
  assert.equal(typeof fa.saveFile, 'function');
  assert.equal(typeof fa.openFile, 'function');
  return fa.saveFile('x.yaml').then((h) => {
    assert.equal(opts.suggestedName, 'x.yaml');
    assert.deepEqual(opts.types[0].accept['text/yaml'], ['.yaml', '.yml']);
    assert.ok(F.isWritable(h));
  });
});

test('only a real, writable file handle links a model: never a plain File from the file input or a drop', () => {
  assert.ok(F.isWritable(handle()));
  assert.ok(!F.isWritable(new Blob(['x'])));
  assert.ok(!F.isWritable({ name: 'x.yaml' }));
  assert.ok(!F.isWritable({ kind: 'directory', name: 'd', createWritable() {} }));
  assert.ok(!F.isWritable(null));
  assert.ok(F.isCancel(Object.assign(new Error('x'), { name: 'AbortError' })));
  assert.ok(!F.isCancel(new Error('x')));
});

test('writing: granted → written; permission asked when needed; refused or failed → reported, nothing thrown', async () => {
  const ok = handle();
  assert.deepEqual(await F.writeFile(ok, 'netatlas: 1\n'), { ok: true });
  assert.equal(ok.text, 'netatlas: 1\n');
  const ask = handle({ perm: 'prompt', request: 'granted' });
  assert.deepEqual(await F.writeFile(ask, 'a'), { ok: true });
  assert.equal(ask.asked, 1, 'the browser was asked for permission once');
  const no = handle({ perm: 'prompt', request: 'denied' });
  const r1 = await F.writeFile(no, 'a');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'denied');
  assert.equal(no.text, '', 'nothing was written');
  const full = handle({ fail: new Error('the disk is full') });
  assert.deepEqual(await F.writeFile(full, 'a'), { ok: false, reason: 'failed', message: 'the disk is full' });
  const blocked = handle({ fail: Object.assign(new Error('blocked'), { name: 'NotAllowedError' }) });
  assert.equal((await F.writeFile(blocked, 'a')).reason, 'denied');
});

test('modified state: a comparison with what was last saved, so undo and redo keep it right', () => {
  const d = ModelDoc.fromText(example('minimal.yaml'), 'minimal.yaml', 'example').doc;
  assert.equal(d.dirty, false);
  d.setText(['title'], 'Changed');
  assert.equal(d.dirty, true);
  d.undo();
  assert.equal(d.dirty, false, 'undo back to the opened state');
  d.redo();
  assert.equal(d.dirty, true);
  // saved: the saved text is the new baseline
  d.markSaved();
  assert.equal(d.dirty, false);
  d.undo();
  assert.equal(d.dirty, true, 'undo away from what was saved');
  d.redo();
  assert.equal(d.dirty, false);
  // an edit made while a write was in progress stays unsaved: the baseline is the text that was written
  const written = d.exportText();
  d.setText(['title'], 'Edited during the write');
  d.markSaved(written);
  assert.equal(d.dirty, true);
  // a new model and an opened file start unmodified
  assert.equal(ModelDoc.create().dirty, false);
});

test('Save model never asks for a name or confirms; a failed or refused save keeps the unsaved state; a download is not a linked file', () => {
  const save = /async saveModel\(\): Promise<SaveResult> \{([\s\S]*?)\n  \}\n/.exec(app)[1];
  assert.doesNotMatch(save, /this\.dialog\(\{|nameInput|downloadText/, 'Save model: no dialog of its own, no download');
  assert.match(save, /if \(!r\.ok\) \{[\s\S]*?if \(r\.reason === 'denied'\) this\.handle = null;[\s\S]*?return 'failed';/);
  assert.match(save, /d\.markSaved\(text\);/);
  const saveAs = /async saveModelAs\(\): Promise<SaveResult> \{([\s\S]*?)\n  \}\n/.exec(app)[1];
  assert.match(saveAs, /if \(isCancel\(e\)\) \{[\s\S]*?return 'canceled';/);
  assert.match(saveAs, /if \(!pick\) return this\.downloadCopyDialog\(\);/);
  assert.match(saveAs, /this\.handle = h;\s+this\.example = null;\s+this\.copyName = null;/);
  // the download fallback: the copy is not linked, and the dialog says so
  const dl = /async downloadCopyDialog\([^)]*\): Promise<SaveResult> \{([\s\S]*?)\n  \}\n/.exec(app)[1];
  assert.match(dl, /The copy is not linked to this model, so Save model stays unavailable/);
  assert.doesNotMatch(dl, /this\.handle = /);
  assert.match(dl, /this\.copyName = name;/);
  // a closed or replaced model is not saved by a pending save, and closing waits for a successful save
  assert.match(app, /if \(this\.mdoc !== d \|\| \(r !== 'saved' && r !== 'downloaded'\) \|\| d\.dirty\) return false;/);
});

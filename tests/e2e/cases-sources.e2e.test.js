// tests/e2e/cases-sources.e2e.test.js
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases-sources.e2e.test.js
// Cases stage 7: a .txt dropped through case:ingestFiles is listed in the
// case panel's Sources section with its status; a file dropped on the drop
// zone goes up one call per file and each file's result is shown.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

describe('E2E: case sources', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;

  before(async () => {
    // Ruling M6: launchApp pins KL_CASES_ROOT per launch, so the temp root
    // goes through opts.env; the launch also gets its own --user-data-dir.
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-sources-'));
    ctx = await launchApp({ env: { KL_CASES_ROOT: casesRoot } });
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('lists a dropped text file with its status', async () => {
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-select')`);
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      document.getElementById('chat-case-new-title').value = 'E2E sources lot';
      document.getElementById('chat-case-create-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('case-sources-list')`);
    const result = await evaluate(ctx, `(async () => {
      const listed = await window.electron.cases.list();
      const c = listed.cases.find((x) => x.title === 'E2E sources lot');
      return window.electron.cases.ingestFiles({ caseId: c.id, files: [{ name: 'notes.txt', base64: btoa('Parcel 12-345-678 survey notes for the lot.') }] });
    })()`);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.results[0].duplicate, false);
    // Re-render the panel so the list reloads.
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `(document.getElementById('case-sources-list')?.textContent || '').includes('notes.txt')`);
    const text = await evaluate(ctx, `document.getElementById('case-sources-list').textContent`);
    assert.match(text, /notes\.txt — 1 page\(s\)/);
    assert.match(text, /(stored|extracting|proposing|checking|ready-for-review|failed)/);
    assert.ok(fs.readdirSync(casesRoot).includes('e2e-sources-lot'));
  });

  it('adds files dropped on the drop zone one by one and shows each result as plain text', async () => {
    await waitFor(ctx, `!!document.getElementById('case-sources-drop')`);
    await evaluate(ctx, `(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['Lakeside lot boundary survey, 2 acres.'], 'survey <b>x</b>.txt', { type: 'text/plain' }));
      dt.items.add(new File([], 'empty.txt', { type: 'text/plain' }));
      document.getElementById('case-sources-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(ctx, `(() => {
      const s = document.getElementById('case-sources-status')?.textContent || '';
      return s.includes('survey <b>x</b>.txt') && s.includes('it has no content');
    })()`, 30000);
    const status = await evaluate(ctx, `document.getElementById('case-sources-status').textContent`);
    assert.match(status, /survey <b>x<\/b>\.txt: Added sources\//);
    assert.match(status, /empty\.txt: Cannot ingest empty\.txt: it has no content\./);
    // The name is text, not markup.
    assert.strictEqual(await evaluate(ctx, `document.getElementById('case-sources-section').querySelectorAll('b').length`), 0);
    await waitFor(ctx, `(document.getElementById('case-sources-list')?.textContent || '').includes('survey <b>x</b>.txt')`);
    const rows = await evaluate(ctx, `Array.from(document.querySelectorAll('#case-sources-list [data-doc-id]')).map((r) => r.dataset.docId)`);
    assert.strictEqual(rows.length, 2);
    for (const id of rows) assert.match(id, /^doc-[0-9a-f]{12}$/);
  });

  it('refuses more than 10 files in one drop before reading any of them', async () => {
    const before = await evaluate(ctx, `document.querySelectorAll('#case-sources-list [data-doc-id]').length`);
    await evaluate(ctx, `(() => {
      const dt = new DataTransfer();
      for (let i = 0; i < 11; i++) dt.items.add(new File(['file number ' + i + ' of the lot'], 'many-' + i + '.txt', { type: 'text/plain' }));
      document.getElementById('case-sources-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(ctx, `(document.getElementById('case-sources-status')?.textContent || '').includes('At most 10 files')`);
    const after = await evaluate(ctx, `(async () => {
      const listed = await window.electron.cases.list();
      const c = listed.cases.find((x) => x.title === 'E2E sources lot');
      const s = await window.electron.cases.sources({ caseId: c.id });
      return s.documents.length;
    })()`);
    assert.strictEqual(after, before);
  });

  // Hand-made records (no model in e2e): an owner file and a tool file, each
  // with a proposal that conflicts with the owner's own statement and one
  // whose statement is markup.
  it('reviews proposals: accept-all only for owner files and behind a confirm, a user conflict never accepted plainly, text never parsed', async () => {
    const ingestDir = path.join(casesRoot, 'e2e-sources-lot', '.kl', 'ingest');
    const hostile = '<img src=x onerror="window.__klPwned=1">Lot is 2 acres';
    const proposal = (id, stmt, conflicts) => ({
      id, stmt, subject: 'lot', attr: 'area', value: '2 acres', unit: null, category: 'property', confidence: 0.9,
      anchor: { page: 1, quote: 'survey notes for the lot, 2 acres', ocr: false },
      checks: { anchor: 'ok', valueInQuote: true, conflicts, duplicateOf: null, verify: { agrees: true, note: '<b>ok</b>', sawImage: false } }
    });
    const record = (docId, kind) => ({
      docId, ref: `sources/2026-09/${docId}.txt`, name: `${kind}-file.txt`, mime: 'text/plain', status: 'ready-for-review', note: null,
      origin: { kind }, pageCount: 1, pages: [{ n: 1, method: 'text' }], usd: { ocr: 0, extract: 0.01, verify: 0 },
      proposals: [
        proposal('p-001', 'Lot area is 2 acres', [{ factId: 'f-0001', provenance: 'user' }]),
        proposal('p-002', hostile, [])
      ],
      refused: [{ stmt: '<script>window.__klPwned=2</script>', reason: 'no quote' }]
    });
    fs.mkdirSync(ingestDir, { recursive: true });
    fs.writeFileSync(path.join(ingestDir, 'doc-aaaaaaaaaaaa.json'), JSON.stringify(record('doc-aaaaaaaaaaaa', 'owner-drop')));
    fs.writeFileSync(path.join(ingestDir, 'doc-bbbbbbbbbbbb.json'), JSON.stringify(record('doc-bbbbbbbbbbbb', 'tool')));
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('#case-sources-list [data-doc-id="doc-bbbbbbbbbbbb"]')`);
    const openReview = (docId) => evaluate(ctx, `(() => {
      const row = document.querySelector('#case-sources-list [data-doc-id="${docId}"]');
      Array.from(row.querySelectorAll('button')).find((b) => b.textContent.startsWith('Review')).click();
      return true;
    })()`);
    const buttons = (docId, pid) => evaluate(ctx, `Array.from(document.querySelectorAll('#case-sources-list [data-doc-id="${docId}"] [data-proposal-id="${pid}"] button')).map((b) => b.textContent)`);

    await openReview('doc-bbbbbbbbbbbb');
    await waitFor(ctx, `!!document.querySelector('[data-doc-id="doc-bbbbbbbbbbbb"] [data-proposal-id="p-001"]')`);
    const toolRow = await evaluate(ctx, `document.querySelector('[data-doc-id="doc-bbbbbbbbbbbb"]').textContent`);
    assert.match(toolRow, /added by King Louie/);
    assert.doesNotMatch(toolRow, /Accept all verified/);

    await openReview('doc-aaaaaaaaaaaa');
    await waitFor(ctx, `!!document.querySelector('[data-doc-id="doc-aaaaaaaaaaaa"] [data-proposal-id="p-002"]')`);
    const ownerRow = await evaluate(ctx, `document.querySelector('[data-doc-id="doc-aaaaaaaaaaaa"]').textContent`);
    assert.match(ownerRow, /Accept all verified/);
    assert.match(ownerRow, /conflicts with f-0001 \(your statement\)/);
    assert.ok(ownerRow.includes(hostile), 'the statement is shown as text');
    assert.ok(ownerRow.includes('<script>window.__klPwned=2</script>'), 'the refused statement is shown as text');
    // A conflict with the owner's own statement: no plain Accept, no Keep both.
    assert.deepStrictEqual(await buttons('doc-aaaaaaaaaaaa', 'p-001'), ['Accept & supersede f-0001', 'Edit', 'Reject', 'Save edit']);
    assert.deepStrictEqual(await buttons('doc-aaaaaaaaaaaa', 'p-002'), ['Accept', 'Edit', 'Reject', 'Save edit']);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#case-sources-section img, #case-sources-section script, #case-sources-section b').length`), 0);
    assert.strictEqual(await evaluate(ctx, `window.__klPwned === undefined`), true);

    // Superseding the owner's statement asks first; Cancel changes nothing.
    await evaluate(ctx, `(() => {
      Array.from(document.querySelectorAll('[data-doc-id="doc-aaaaaaaaaaaa"] [data-proposal-id="p-001"] button')).find((b) => b.textContent.startsWith('Accept & supersede')).click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    const supersedeText = await evaluate(ctx, `document.querySelector('.rename-chat-modal p').textContent`);
    assert.match(supersedeText, /supersede f-0001, which is your own statement/);
    await evaluate(ctx, `Array.from(document.querySelectorAll('.rename-chat-modal button')).find((b) => b.textContent === 'Cancel').click(); true`);

    // Accept all verified asks first, listing what will happen; Cancel changes nothing.
    await evaluate(ctx, `(() => {
      Array.from(document.querySelectorAll('[data-doc-id="doc-aaaaaaaaaaaa"] button')).find((b) => b.textContent === 'Accept all verified').click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    const acceptAllText = await evaluate(ctx, `document.querySelector('.rename-chat-modal p').textContent`);
    assert.match(acceptAllText, /Of the 2 open proposals/);
    assert.ok(acceptAllText.includes(`p-002: ${hostile}`));
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('.rename-chat-modal img').length`), 0);
    await evaluate(ctx, `Array.from(document.querySelectorAll('.rename-chat-modal button')).find((b) => b.textContent === 'Cancel').click(); true`);

    const rec = JSON.parse(fs.readFileSync(path.join(ingestDir, 'doc-aaaaaaaaaaaa.json'), 'utf8'));
    assert.ok(rec.proposals.every((p) => !p.review), 'nothing was reviewed');
    assert.strictEqual(await evaluate(ctx, `window.__klPwned === undefined`), true);
  });
});

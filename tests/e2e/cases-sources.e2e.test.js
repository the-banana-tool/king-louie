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
      document.getElementById('chat-case-new-input').value = 'E2E sources lot';
      document.getElementById('chat-case-new-confirm').click();
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

  // ---- review helpers (the panel is driven by clicks, as the owner would) ----
  const sel = (docId, pid) => `#case-sources-list [data-doc-id="${docId}"]${pid ? ` [data-proposal-id="${pid}"]` : ''}`;
  const openReview = (docId) => evaluate(ctx, `(() => {
    const row = document.querySelector('${sel(docId)}');
    Array.from(row.querySelectorAll('button')).find((b) => b.textContent.startsWith('Review')).click();
    return true;
  })()`);
  const buttons = (docId, pid) => evaluate(ctx, `Array.from(document.querySelectorAll('${sel(docId, pid)} button')).map((b) => b.textContent)`);
  const click = (scope, label) => evaluate(ctx, `(() => {
    const b = Array.from(document.querySelectorAll('${scope} button')).find((x) => x.textContent === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  // Waits for the confirm dialog, returns its text and answers it.
  const answerConfirm = async (answer) => {
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    const text = await evaluate(ctx, `document.querySelector('.rename-chat-modal p').textContent`);
    await evaluate(ctx, `Array.from(document.querySelectorAll('.rename-chat-modal button')).find((b) => b.textContent === ${JSON.stringify(answer)}).click(); true`);
    return text;
  };
  const rerender = async () => {
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
  };
  const statusText = () => evaluate(ctx, `document.getElementById('case-sources-status').textContent`);

  // Hand-made records (no model in e2e): an owner file and a tool file, each
  // with a proposal that conflicts with the owner's own statement, one whose
  // statement is markup, and one that conflicts with a sourced fact; and a
  // third record that stays 'extracting' so the list keeps polling.
  it('reviews proposals: accept-all only for owner files, every supersede and keep-both behind a confirm, text never parsed, an open edit form survives the poll', async () => {
    const ingestDir = path.join(casesRoot, 'e2e-sources-lot', '.kl', 'ingest');
    const hostile = '<img src=x onerror="window.__klPwned=1">Lot is 2 acres';
    const proposal = (id, stmt, conflicts) => ({
      id, stmt, subject: 'lot', attr: 'area', value: '2 acres', unit: null, category: 'property', confidence: 0.9,
      anchor: { page: 1, quote: 'survey notes for the lot, 2 acres', ocr: false },
      checks: { anchor: 'ok', valueInQuote: true, conflicts, duplicateOf: null, verify: { agrees: true, note: '<b>ok</b>', sawImage: false } }
    });
    const record = (docId, kind, status = 'ready-for-review') => ({
      docId, ref: `sources/2026-09/${docId}.txt`, name: `${kind}-file.txt`, mime: 'text/plain', status, note: null,
      origin: { kind }, pageCount: 1, pages: [{ n: 1, method: 'text' }], usd: { ocr: 0, extract: 0.01, verify: 0 },
      proposals: status === 'extracting' ? [] : [
        proposal('p-001', 'Lot area is 2 acres', [{ factId: 'f-0001', provenance: 'user' }]),
        proposal('p-002', hostile, []),
        proposal('p-003', 'Lot area is 2 acres per the survey', [{ factId: 'f-0002', provenance: 'sourced' }])
      ],
      refused: status === 'extracting' ? [] : [{ stmt: '<script>window.__klPwned=2</script>', reason: 'no quote' }]
    });
    fs.mkdirSync(ingestDir, { recursive: true });
    fs.writeFileSync(path.join(ingestDir, 'doc-aaaaaaaaaaaa.json'), JSON.stringify(record('doc-aaaaaaaaaaaa', 'owner-drop')));
    fs.writeFileSync(path.join(ingestDir, 'doc-bbbbbbbbbbbb.json'), JSON.stringify(record('doc-bbbbbbbbbbbb', 'tool')));
    await rerender();
    await waitFor(ctx, `!!document.querySelector('${sel('doc-bbbbbbbbbbbb')}')`);

    await openReview('doc-bbbbbbbbbbbb');
    await waitFor(ctx, `!!document.querySelector('${sel('doc-bbbbbbbbbbbb', 'p-001')}')`);
    const toolRow = await evaluate(ctx, `document.querySelector('${sel('doc-bbbbbbbbbbbb')}').textContent`);
    assert.match(toolRow, /added by King Louie/);
    assert.doesNotMatch(toolRow, /Accept all verified/);

    await openReview('doc-aaaaaaaaaaaa');
    await waitFor(ctx, `!!document.querySelector('${sel('doc-aaaaaaaaaaaa', 'p-003')}')`);
    const ownerRow = await evaluate(ctx, `document.querySelector('${sel('doc-aaaaaaaaaaaa')}').textContent`);
    assert.match(ownerRow, /Accept all verified/);
    assert.match(ownerRow, /conflicts with f-0001 \(your statement\)/);
    assert.ok(ownerRow.includes(hostile), 'the statement is shown as text');
    assert.ok(ownerRow.includes('<script>window.__klPwned=2</script>'), 'the refused statement is shown as text');
    // A conflict with the owner's own statement: no plain Accept, no Keep both, in the card or the edit form.
    assert.deepStrictEqual(await buttons('doc-aaaaaaaaaaaa', 'p-001'), ['Accept & supersede f-0001', 'Edit', 'Reject', 'Save edit & supersede f-0001']);
    assert.deepStrictEqual(await buttons('doc-aaaaaaaaaaaa', 'p-002'), ['Accept', 'Edit', 'Reject', 'Save edit']);
    // A conflict with a sourced fact: supersede or keep both, plain or with an edit.
    assert.deepStrictEqual(await buttons('doc-aaaaaaaaaaaa', 'p-003'), ['Accept & supersede f-0002', 'Keep both', 'Edit', 'Reject', 'Save edit & supersede f-0002', 'Save edit & keep both']);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#case-sources-section img, #case-sources-section script, #case-sources-section b').length`), 0);
    assert.strictEqual(await evaluate(ctx, `window.__klPwned === undefined`), true);

    // Every supersede asks first, more strongly for the owner's own statement; Cancel changes nothing.
    assert.ok(await click(sel('doc-aaaaaaaaaaaa', 'p-001'), 'Accept & supersede f-0001'));
    assert.match(await answerConfirm('Cancel'), /replacing f-0001, which is your own statement\? f-0001 will no longer be an active fact/);
    assert.ok(await click(sel('doc-aaaaaaaaaaaa', 'p-003'), 'Accept & supersede f-0002'));
    const sourcedSupersede = await answerConfirm('Cancel');
    assert.match(sourcedSupersede, /Accept p-003 and supersede f-0002\? f-0002 stays in the ledger as superseded/);
    assert.doesNotMatch(sourcedSupersede, /your own statement/);
    // Keep both asks first.
    assert.ok(await click(sel('doc-aaaaaaaaaaaa', 'p-003'), 'Keep both'));
    assert.match(await answerConfirm('Cancel'), /Accept p-003 and keep f-0002 as well\? Both stay active facts/);
    // Saving an edit with keep-both asks first too, naming the edited statement.
    await evaluate(ctx, `(() => {
      const card = document.querySelector('${sel('doc-aaaaaaaaaaaa', 'p-003')}');
      Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Edit').click();
      card.querySelector('.case-proposal-edit input').value = 'Lot area is two acres';
      return true;
    })()`);
    assert.ok(await click(sel('doc-aaaaaaaaaaaa', 'p-003'), 'Save edit & keep both'));
    assert.match(await answerConfirm('Cancel'), /Save your edit of p-003 and accept it and keep f-0002 as well\?.*Lot area is two acres/);

    // Accept all verified asks first, listing what will happen; Cancel changes nothing.
    assert.ok(await click(sel('doc-aaaaaaaaaaaa'), 'Accept all verified'));
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('.rename-chat-modal img').length`), 0);
    const acceptAllText = await answerConfirm('Cancel');
    assert.match(acceptAllText, /Of the 3 open proposals/);
    assert.ok(acceptAllText.includes(`p-002: ${hostile}`));

    // The poll never rebuilds a row with an open edit form: a busy record
    // keeps the list polling every 3 s; the edit form of p-003 is still open
    // with the typed text after two ticks, while the busy row was rebuilt.
    fs.writeFileSync(path.join(ingestDir, 'doc-cccccccccccc.json'), JSON.stringify(record('doc-cccccccccccc', 'owner-drop', 'extracting')));
    await rerender();
    await waitFor(ctx, `!!document.querySelector('${sel('doc-cccccccccccc')}') && !!document.querySelector('${sel('doc-aaaaaaaaaaaa')}')`);
    await openReview('doc-aaaaaaaaaaaa');
    await waitFor(ctx, `!!document.querySelector('${sel('doc-aaaaaaaaaaaa', 'p-003')}')`);
    await evaluate(ctx, `(() => {
      const card = document.querySelector('${sel('doc-aaaaaaaaaaaa', 'p-003')}');
      Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Edit').click();
      const input = card.querySelector('.case-proposal-edit input');
      input.value = 'Owner is typing this';
      document.querySelector('${sel('doc-cccccccccccc')}').__klMark = true;
      return true;
    })()`);
    await waitFor(ctx, `!document.querySelector('${sel('doc-cccccccccccc')}').__klMark`, 10000);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const kept = await evaluate(ctx, `(() => {
      const form = document.querySelector('${sel('doc-aaaaaaaaaaaa', 'p-003')} .case-proposal-edit');
      return { hidden: form.hidden, value: form.querySelector('input').value };
    })()`);
    assert.deepStrictEqual(kept, { hidden: false, value: 'Owner is typing this' });
    fs.rmSync(path.join(ingestDir, 'doc-cccccccccccc.json'));
    await rerender();

    const rec = JSON.parse(fs.readFileSync(path.join(ingestDir, 'doc-aaaaaaaaaaaa.json'), 'utf8'));
    assert.ok(rec.proposals.every((p) => !p.review), 'nothing was reviewed');
    assert.strictEqual(await evaluate(ctx, `window.__klPwned === undefined`), true);
  });

  // A real accept, end to end: the proposals of the real survey record are
  // rewritten (no model in e2e); the owner accepts one, rejects one, accepts
  // all verified, and saves an edit that supersedes a fact.
  it('accepts, rejects, accepts all verified and saves an edit with supersede into the ledger', async () => {
    const caseDir = path.join(casesRoot, 'e2e-sources-lot');
    const ingestDir = path.join(caseDir, '.kl', 'ingest');
    const docId = await evaluate(ctx, `(async () => {
      const listed = await window.electron.cases.list();
      const c = listed.cases.find((x) => x.title === 'E2E sources lot');
      for (let i = 0; i < 60; i++) {
        const s = await window.electron.cases.sources({ caseId: c.id });
        const d = s.documents.find((x) => x.name === 'survey <b>x</b>.txt');
        if (d && !['extracting', 'proposing', 'checking'].includes(d.status)) return d.docId;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    })()`);
    assert.match(docId, /^doc-[0-9a-f]{12}$/);
    const recordFile = path.join(ingestDir, `${docId}.json`);
    const quote = 'Lakeside lot boundary survey, 2 acres';
    const prop = (id, stmt, attr, value, conflicts = []) => ({
      id, stmt, subject: 'Lakeside lot', attr, value, unit: null, category: 'property', confidence: 0.9,
      anchor: { page: 1, quote, ocr: false },
      checks: { anchor: 'ok', valueInQuote: true, conflicts, duplicateOf: null, verify: { agrees: true, note: null, sawImage: false } }
    });
    const rewrite = (proposals) => {
      const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      rec.status = 'ready-for-review';
      rec.proposals = proposals(rec.proposals || []);
      fs.writeFileSync(recordFile, JSON.stringify(rec));
    };
    const facts = () => fs.readFileSync(path.join(caseDir, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((f) => f.source?.docId === docId);
    rewrite(() => [
      prop('p-001', 'The Lakeside lot is 2 acres', 'area', '2 acres'),
      prop('p-002', 'The survey of the Lakeside lot is a boundary survey', 'survey kind', 'boundary'),
      prop('p-003', 'The Lakeside lot survey is recent', 'survey age', null)
    ]);
    await rerender();
    await waitFor(ctx, `!!document.querySelector('${sel(docId)}')`);
    await openReview(docId);
    await waitFor(ctx, `!!document.querySelector('${sel(docId, 'p-002')}')`);

    // Plain Accept.
    assert.ok(await click(sel(docId, 'p-002'), 'Accept'));
    await waitFor(ctx, `/p-002: accepted as f-\\d+\\./.test(document.getElementById('case-sources-status').textContent)`, 30000);
    // Reject.
    await waitFor(ctx, `!!document.querySelector('${sel(docId, 'p-003')} button')`);
    assert.ok(await click(sel(docId, 'p-003'), 'Reject'));
    await waitFor(ctx, `document.getElementById('case-sources-status').textContent === 'p-003: rejected.'`, 30000);
    // Accept all verified → Confirm.
    await waitFor(ctx, `Array.from(document.querySelectorAll('${sel(docId)} button')).some((b) => b.textContent === 'Accept all verified')`);
    assert.ok(await click(sel(docId), 'Accept all verified'));
    assert.match(await answerConfirm('Confirm'), /Of the 1 open proposals/);
    await waitFor(ctx, `document.getElementById('case-sources-status').textContent.startsWith('Accepted 1: p-001.')`, 30000);
    assert.strictEqual(await statusText(), 'Accepted 1: p-001.');

    let mine = facts();
    assert.strictEqual(mine.length, 2, JSON.stringify(mine));
    for (const f of mine) {
      assert.strictEqual(f.provenance, 'sourced');
      assert.strictEqual(f.disclosable, false);
      assert.strictEqual(f.source.kind, 'document');
    }
    assert.deepStrictEqual(mine.map((f) => f.source.proposalId).sort(), ['p-001', 'p-002']);
    let rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    assert.strictEqual(rec.proposals.find((p) => p.id === 'p-003').review.action, 'rejected');

    // An edit that supersedes a (sourced) fact: Save edit & supersede → Confirm.
    const boundary = mine.find((f) => f.source.proposalId === 'p-002');
    rewrite((kept) => [...kept, prop('p-004', 'The Lakeside lot survey is a boundary survey of 2 acres', 'survey kind', 'boundary survey', [{ factId: boundary.id, provenance: 'sourced' }])]);
    await rerender();
    await waitFor(ctx, `!!document.querySelector('${sel(docId)}')`);
    await openReview(docId);
    await waitFor(ctx, `!!document.querySelector('${sel(docId, 'p-004')}')`);
    await evaluate(ctx, `(() => {
      const card = document.querySelector('${sel(docId, 'p-004')}');
      Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Edit').click();
      card.querySelector('.case-proposal-edit input').value = 'The Lakeside lot has a boundary survey';
      return true;
    })()`);
    assert.ok(await click(sel(docId, 'p-004'), `Save edit & supersede ${boundary.id}`));
    assert.match(await answerConfirm('Confirm'), new RegExp(`Save your edit of p-004 and accept it and supersede ${boundary.id}\\?.*The Lakeside lot has a boundary survey`));
    await waitFor(ctx, `/p-004: edited and accepted, superseding f-\\d+ as f-\\d+\\./.test(document.getElementById('case-sources-status').textContent)`, 30000);
    mine = facts();
    const edited = mine.find((f) => f.source.proposalId === 'p-004');
    assert.ok(edited, JSON.stringify(mine));
    assert.strictEqual(edited.stmt, 'The Lakeside lot has a boundary survey');
    assert.strictEqual(edited.supersedes, boundary.id);
    assert.strictEqual(edited.disclosable, false);
    rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    assert.strictEqual(rec.proposals.find((p) => p.id === 'p-004').review.action, 'edited');
  });
});

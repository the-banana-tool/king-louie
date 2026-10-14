// tests/renderer-private.test.js
// Static checks on the private mark in the renderer (local inference spec
// 2026-10-13 §8.1, §8.6, §9.2, §9.3, §15; R-LI-9, R-LI-10, R-LI-28): the
// composer line names tools, the confirmation's fixed lines and its facts,
// the cost line for all-local, mixed and failover replies, the export
// helpers, the refused turn's words, the keep-local embedder's state, and
// that every new function sets text with textContent only.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

const NO_HTML = /innerHTML|insertAdjacentHTML|outerHTML/;
const H = () => new Function(`${block('function formatCompactUsd(', '/* --- end local inference L1 helpers --- */')}
  return { PRIVATE_COMPOSER_LINE, PRIVATE_TOOLS_LINE, PRIVATE_QUESTIONS_LINE, PRIVATE_CONFIRM_FIXED, privateConfirmLines, formatLocalCostLine, localFailoverNotes,
    privateRefusalSentence, exportChatData, markdownExportLines, PRIVATE_EXPORT_WARNING, keepLocalStatusText };`)();
const tok = (n) => n.toLocaleString();

describe('renderer: the private mark', () => {
  it('R-LI-9: the composer line names tools, and shows under the composer in a private chat only', () => {
    const { PRIVATE_COMPOSER_LINE } = H();
    assert.strictEqual(PRIVATE_COMPOSER_LINE, 'Private: model calls stay on your hardware. Tools still send what they send.');
    assert.ok(html.includes('id="private-composer-line"'));
    const paint = block('function paintPrivateChatState(', '\n// "Make private…"');
    assert.match(paint, /line\.textContent = isPrivate \? PRIVATE_COMPOSER_LINE : ''/);
    assert.match(paint, /line\.hidden = !isPrivate/);
    assert.match(src, /paintPrivateChatState\(activeChat\)/);
  });

  it('R-LI-10: the confirmation has its fixed lines, the tools line and the facts, in words', () => {
    const { privateConfirmLines, PRIVATE_CONFIRM_FIXED, PRIVATE_TOOLS_LINE } = H();
    assert.deepStrictEqual([...PRIVATE_CONFIRM_FIXED], ['What was already sent stays sent.', 'This cannot be undone for this chat.']);
    const lines = privateConfirmLines({
      alreadySent: { messages: 2, providers: ['anthropic', 'openai'] },
      hostedVectors: true,
      missing: [{ role: 'main', why: 'This chat is private and main has no local model. Nothing was sent to a hosted model.' }],
      recalledBy: [{ chatId: 'chat-9', title: 'Fence plans' }],
      chats: [{ id: 'chat-1', title: 'Fence' }]
    });
    assert.deepStrictEqual(lines, [
      '2 replies already sent text to a hosted model (anthropic, openai).',
      'A hosted embedding service holds vectors of it; they are deleted and made again on this computer.',
      'main: This chat is private and main has no local model. Nothing was sent to a hosted model.',
      'Read before by: Fence plans. They will not read it again.',
      PRIVATE_TOOLS_LINE,
      'What was already sent stays sent.',
      'This cannot be undone for this chat.'
    ]);
    const quiet = privateConfirmLines({ alreadySent: { messages: 0, providers: [] }, chats: [{ id: 'c', title: 'Fence' }] });
    assert.strictEqual(quiet[0], 'Nothing in it was sent to a hosted model.');
    const forCase = privateConfirmLines({ chats: [{ id: 'a', title: 'Lot A' }, { id: 'b', title: 'Lot B' }] }, { forCase: true });
    assert.ok(forCase.includes('Chats made private with it: Lot A, Lot B.'));
    assert.deepStrictEqual(privateConfirmLines(null).slice(-3), [PRIVATE_TOOLS_LINE, ...PRIVATE_CONFIRM_FIXED]);
  });

  it('review fix, item 9a: a case\'s confirmation says its questions still go out over the contact ladder', () => {
    const { privateConfirmLines, PRIVATE_QUESTIONS_LINE, PRIVATE_TOOLS_LINE } = H();
    assert.strictEqual(PRIVATE_QUESTIONS_LINE, 'Its questions to you still go out over your contact ladder (Telegram, Discord, email, SMS, voice, the phone app), as before: the mark keeps model calls on your hardware, not the questions.');
    const lines = privateConfirmLines({ chats: [{ id: 'a', title: 'Lot A' }], questionsLeave: true }, { forCase: true });
    assert.strictEqual(lines[lines.indexOf(PRIVATE_TOOLS_LINE) - 1], PRIVATE_QUESTIONS_LINE);
    assert.ok(!privateConfirmLines({ chats: [{ id: 'a', title: 'Fence' }] }).includes(PRIVATE_QUESTIONS_LINE));
  });

  it('the flow asks for the facts first and marks only on the owner\'s confirmation', () => {
    const flow = block('async function openPrivateMarkFlow(', '\n/* Settings → Models: local servers */');
    assert.doesNotMatch(flow, NO_HTML);
    const first = flow.indexOf('first = await ask({})');
    const confirm = flow.indexOf('showConfirmDialog(question, { before: lines })');
    const mark = flow.indexOf('ask({ confirm: true })');
    assert.ok(first > 0 && confirm > first && mark > confirm, 'facts, then the confirmation, then the mark');
    assert.match(preload, /'chat:markPrivate', \{ chatId: payload\.chatId, confirm: payload\.confirm === true \}/);
    assert.match(preload, /'case:markPrivate', \{ caseId: payload\.caseId, confirm: payload\.confirm === true \}/);
    assert.ok(html.includes('data-action="make-private">Make private…</button>'));
    assert.match(src, /if \(action === 'make-private'\) openPrivateMarkFlow\(\{ chatId \}\)/);
    assert.match(src, /openPrivateMarkFlow\(\{ caseId: chat\.caseId \}\)/);
  });

  it('the cost line: every call local', () => {
    const { formatLocalCostLine } = H();
    const llm = { totals: { totalTokens: 3104, costUsd: 0, localCalls: 3, localTokens: 3104 }, byRole: { main: { calls: 2, totalTokens: 3000, costUsd: 0, localCalls: 2, localTokens: 3000, localServerIds: ['workstation'] }, utility: { calls: 1, totalTokens: 104, costUsd: 0, localCalls: 1, localTokens: 104, localServerIds: ['workstation'] } } };
    assert.strictEqual(formatLocalCostLine(llm, new Map([['workstation', 'Workstation']])), `local · ${tok(3104)} tokens · $0.0000`);
  });

  it('the cost line: local and hosted roles, the server by name', () => {
    const { formatLocalCostLine } = H();
    const llm = { totals: { totalTokens: 2000, costUsd: 0.0412, localCalls: 1, localTokens: 826 }, byRole: { main: { calls: 1, totalTokens: 1174, costUsd: 0.0412 }, utility: { calls: 1, totalTokens: 826, costUsd: 0, localCalls: 1, localTokens: 826, localServerIds: ['workstation'] } } };
    assert.strictEqual(formatLocalCostLine(llm, new Map([['workstation', 'Workstation']])), `main $0.04 · utility: local (Workstation) ${tok(826)} tokens`);
    assert.strictEqual(formatLocalCostLine(llm, new Map()), `main $0.04 · utility: local (workstation) ${tok(826)} tokens`, 'an unknown server shows its id');
    const both = { totals: { totalTokens: 900, costUsd: 0.0006, localCalls: 1, localTokens: 500 }, byRole: { utility: { calls: 2, totalTokens: 900, costUsd: 0.0006, localCalls: 1, localTokens: 500, localServerIds: ['workstation'] } } };
    assert.strictEqual(formatLocalCostLine(both, new Map([['workstation', 'Workstation']])), `utility: local (Workstation) ${tok(500)} tokens + $0.0006`);
  });

  it('the cost line is the old one when no call was local', () => {
    const { formatLocalCostLine } = H();
    assert.strictEqual(formatLocalCostLine({ totals: { totalTokens: 10, costUsd: 0.01 }, byRole: { main: { calls: 1, costUsd: 0.01 } } }, new Map()), null);
    assert.strictEqual(formatLocalCostLine(null, new Map()), null);
  });

  it('R-LI-12: the failover note names the server that did not answer, and estimated tokens are said', () => {
    const { localFailoverNotes } = H();
    const llm = { calls: [
      { role: 'utility', provider: 'openai', model: 'gpt-5.4-mini', costUsd: 0.0006, failoverFrom: 'local/workstation/qwen3:8b' },
      { role: 'utility', provider: 'openai', model: 'gpt-5.4-mini', costUsd: 0.0006, failoverFrom: 'local/workstation/qwen3:8b' },
      { role: 'main', provider: 'local', model: 'workstation/qwen3:8b', usageEstimated: true }
    ] };
    assert.deepStrictEqual(localFailoverNotes(llm, new Map([['workstation', 'Workstation']])), {
      notes: ['utility: Workstation did not answer; ran on openai/gpt-5.4-mini $0.0006'],
      estimated: true
    });
    assert.deepStrictEqual(localFailoverNotes({ calls: [{ role: 'main', failoverFrom: 'groq/llama', provider: 'openai', model: 'gpt-5.5', costUsd: 0.02 }] }, new Map()).notes, ['main: groq/llama did not answer; ran on openai/gpt-5.5 $0.02']);
    assert.deepStrictEqual(localFailoverNotes(null, new Map()), { notes: [], estimated: false });
    assert.match(src, /const localLine = formatLocalCostLine\(metadata\.llm, appState\.localServerNames\)/);
  });

  it('a refused turn names its code in words, with a button to Settings → Models', () => {
    const { privateRefusalSentence } = H();
    for (const code of ['PRIVATE_NO_LOCAL_MODEL', 'LOCAL_ONLY_ROLE_NO_MODEL', 'LOCAL_MODEL_UNAVAILABLE']) assert.ok(privateRefusalSentence(code), code);
    assert.strictEqual(privateRefusalSentence('NO_USABLE_MODEL'), '');
    assert.strictEqual(privateRefusalSentence('toString'), '');
    const chatHandlers = read('src/ipc/chat-handlers.js');
    assert.match(chatHandlers, /OPEN_MODELS_CODES = Object\.freeze\(\['PRIVATE_NO_LOCAL_MODEL', 'LOCAL_ONLY_ROLE_NO_MODEL', 'LOCAL_MODEL_UNAVAILABLE'\]\)/);
    assert.match(chatHandlers, /OPEN_MODELS_CODES\.includes\(error\?\.code\) \? \{ code: error\.code, action: \{ kind: 'open-models' \} \}/);
  });

  it('R-LI-28: the export carries the flag and the Markdown line only for a private chat, after the warning', () => {
    const { exportChatData, markdownExportLines, PRIVATE_EXPORT_WARNING } = H();
    const msgs = [{ sender: 'user', text: 'hi' }];
    assert.deepStrictEqual(exportChatData({ id: 'c', title: 'Fence', private: true }, msgs), { id: 'c', title: 'Fence', private: true, messages: msgs });
    assert.deepStrictEqual(exportChatData({ id: 'c', title: 'Fence' }, msgs), { id: 'c', title: 'Fence', messages: msgs });
    assert.deepStrictEqual(exportChatData({ id: 'c', title: 'Fence', private: 'yes' }, msgs), { id: 'c', title: 'Fence', messages: msgs }, 'only an exact true is carried');
    assert.deepStrictEqual(markdownExportLines({ private: true }), ['This chat was private in King Louie.\n']);
    assert.deepStrictEqual(markdownExportLines({}), []);
    assert.strictEqual(PRIVATE_EXPORT_WARNING, 'This file is plain text outside King Louie.');
    assert.match(src, /const exportData = exportChatData\(chat, enrichedMessages\)/);
    assert.match(src, /const lines = \[\.\.\.markdownExportLines\(chat\), `# \$\{chat\.title\}\\n`\]/);
    assert.equal((src.match(/showConfirmDialog\('Export this private chat\?', \{ before: \[PRIVATE_EXPORT_WARNING\] \}\)/g) || []).length, 2);
  });

  it('the import dialog has "Import as private", sent only when ticked', () => {
    assert.ok(html.includes('id="import-chat-private"'));
    assert.match(html, /Import as private/);
    assert.match(src, /\.\.\.\(asPrivate \? \{ asPrivate: true \} : \{\}\)/);
    assert.match(preload, /asPrivate: payload\.asPrivate === true/);
  });

  it('the keep-local embedder\'s state, and a model that did not load, in words', () => {
    const { keepLocalStatusText } = H();
    assert.strictEqual(keepLocalStatusText({ key: null, state: 'off' }), '');
    assert.strictEqual(keepLocalStatusText(null), '');
    assert.strictEqual(keepLocalStatusText({ key: 'local:x', state: 'ready' }, { pending: 0 }), 'Private and imported chats are embedded on this computer.');
    assert.strictEqual(keepLocalStatusText({ key: 'local:x', state: 'ready' }, { pending: 12 }), 'Private and imported chats: embedding on this computer (12 chunks to go).');
    assert.strictEqual(keepLocalStatusText({ key: 'local:x', state: 'unavailable', error: 'model file missing' }),
      'Private and imported chats are not embedded for now: the local embedding model did not load (model file missing). Recall uses keyword search for them.');
    assert.ok(html.includes('id="history-keep-local-status"'));
    assert.match(src, /keepLocalStatusText\(out\.status\?\.keepLocal, out\.keepLocalProgress\)/);
  });

  it('the recall line and the link dialog say private in words', () => {
    const via = block('function recallVia(', '\n// The scope a reply');
    assert.match(via, /'BM25 only: this chat is private and the local embedder is not ready'/);
    assert.match(via, /not sent to Jev \(private chat\)/);
    assert.match(src, /'private-chat': 'A private chat is read only by private chats\.'/);
  });

  it('the chat list and header show the lock, and every new function uses textContent only', () => {
    assert.match(src, /lock\.className = 'chat-item-private'/);
    assert.match(src, /badge\.className = 'chat-private-badge'/);
    const helpers = block('/* --- Local inference L1: local servers and the private mark', '/* --- end local inference L1 helpers --- */');
    assert.doesNotMatch(helpers, NO_HTML);
    const ui = block('/* --- Local inference L1: the UI (spec 2026-10-13 §15) --- */', '\nfunction renderCatalogSettings() {');
    assert.doesNotMatch(ui, NO_HTML);
  });
});

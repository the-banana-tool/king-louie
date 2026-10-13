// tests/renderer-history-scope.test.js
// Static checks on the chat menu's "Recall from" items, the "Link chats…"
// dialog and the recall line's scope word (recall spec §6.3, stage H4):
// the wording, the markup, the channels in preload, and that chat titles
// and errors (untrusted) are set with textContent, never parsed as HTML.
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

// A top-level element of index.html's container, by id, up to its closing tag.
function element(id) {
  const i = html.indexOf(`id="${id}"`);
  const j = html.indexOf('\n    </div>\n', i);
  assert.ok(i >= 0 && j > i, `found #${id}`);
  return html.slice(i, j);
}

const NO_HTML = /innerHTML|insertAdjacentHTML|outerHTML/;

describe('renderer: the recall line names the scope', () => {
  const load = () => new Function(
    `${block('function formatCompactTokens(', '\nfunction renderRecallLine(')}; return { recallScopeWord, recallLineText };`
  )();
  const base = { recalledExcerpts: 3, estTokens: { recalled: 1850 }, fullHistoryEstTokens: 412000 };
  const H3 = 'recalled 3 excerpts · about 1.9K tokens · from 412K tokens of history · BM25';

  it('has a word for linked and all, none for this chat', () => {
    const { recallScopeWord } = load();
    assert.strictEqual(recallScopeWord({ scope: 'chat' }), '');
    assert.strictEqual(recallScopeWord({}), '');
    assert.strictEqual(recallScopeWord(null), '');
    assert.strictEqual(recallScopeWord(undefined), '');
    assert.strictEqual(recallScopeWord({ scope: 'linked' }), 'linked chats');
    assert.strictEqual(recallScopeWord({ scope: 'all' }), 'all chats');
    assert.strictEqual(recallScopeWord({ scope: 'everything' }), '');
    assert.strictEqual(recallScopeWord({ scope: { toString: () => 'all' } }), '');
  });

  it('is the H3 line for scope "chat" and for a context with no scope', () => {
    const { recallLineText } = load();
    assert.strictEqual(recallLineText(base), H3);
    assert.strictEqual(recallLineText({ ...base, scope: 'chat' }), H3);
    assert.strictEqual(recallLineText({ ...base, scope: 'everything' }), H3);
  });

  it('adds the word after the history size', () => {
    const { recallLineText } = load();
    assert.strictEqual(recallLineText({ ...base, scope: 'linked' }),
      'recalled 3 excerpts · about 1.9K tokens · from 412K tokens of history · linked chats · BM25');
    assert.strictEqual(recallLineText({ ...base, scope: 'all', embedder: 'local:Xenova/all-MiniLM-L6-v2', reranker: 'local' }),
      'recalled 3 excerpts · about 1.9K tokens · from 412K tokens of history · all chats · BM25 + vectors · reranked');
  });

  it('marks an excerpt from another chat, and still sets it as text', () => {
    const line = block('function renderRecallLine(', '\n}\n');
    assert.match(line, /header\.startsWith\('\[chat "'\)/);
    assert.match(line, /recall-excerpt-other-chat/);
    assert.doesNotMatch(line, NO_HTML);
  });
});

describe('renderer: an excerpt this chat may no longer read', () => {
  it('a hidden excerpt is one fixed sentence set as text, and none of its fields is read', () => {
    const text = block('const RECALL_EXCERPT_HIDDEN_TEXT', '\nfunction renderRecallLine(');
    const { RECALL_EXCERPT_HIDDEN_TEXT } = new Function(`${text}; return { RECALL_EXCERPT_HIDDEN_TEXT };`)();
    assert.strictEqual(RECALL_EXCERPT_HIDDEN_TEXT, 'An excerpt from another chat is no longer available.');
    const line = block('function renderRecallLine(', '\n}\n');
    const hidden = line.slice(line.indexOf('excerpt.hidden === true'), line.indexOf('continue;'));
    assert.ok(hidden.length > 0, 'the hidden branch comes before the header and text are read');
    assert.match(hidden, /item\.textContent = RECALL_EXCERPT_HIDDEN_TEXT;/);
    assert.match(hidden, /recall-excerpt-hidden/);
    assert.doesNotMatch(hidden, /excerpt\.(header|text|chatId|chatTitle)/);
    assert.ok(line.indexOf('continue;') < line.indexOf('excerpt.header'), 'before the header is read');
    assert.doesNotMatch(line, NO_HTML);
  });
});

describe('renderer: the chat menu sets what a chat recalls from', () => {
  const texts = () => block('const RECALL_PIN_TEXTS', '\nfunction placeContextMenu(');
  const load = () => new Function(`${texts()}; return { recallPinText, recallLinkRefusedText, recallScopeItemText };`)();

  it('says why a chat recalls only from itself, never the reason code', () => {
    const { recallPinText } = load();
    assert.strictEqual(recallPinText('case-chat'), 'A case chat recalls only from itself.');
    assert.strictEqual(recallPinText('bridge-chat'), 'A Telegram or Discord chat recalls only from itself.');
    assert.strictEqual(recallPinText('imported-case-chat'), 'A chat imported from a case recalls only from itself.');
    for (const other of ['no-policy', 'refused', '', 'toString', '__proto__', '<b>x</b>', null, undefined, 7]) {
      assert.strictEqual(recallPinText(other), 'This chat recalls only from itself.', String(other));
    }
  });

  it('says why a chat cannot be linked, never the reason code', () => {
    const { recallLinkRefusedText } = load();
    assert.strictEqual(recallLinkRefusedText('case-chat'), 'A case chat cannot be linked.');
    assert.strictEqual(recallLinkRefusedText('imported-case-chat'), 'A chat imported from a case cannot be linked.');
    for (const other of ['bridge-chat', 'no-policy', 'refused', '', 'constructor', '__proto__', null, undefined]) {
      assert.strictEqual(recallLinkRefusedText(other), 'This chat cannot be linked.', String(other));
    }
  });

  it('names the three choices, with the number of linked chats', () => {
    const { recallScopeItemText } = load();
    assert.strictEqual(recallScopeItemText('chat', 0), 'Recall from: this chat');
    assert.strictEqual(recallScopeItemText('linked', 3), 'Recall from: linked chats (3)');
    assert.strictEqual(recallScopeItemText('linked', 0), 'Recall from: linked chats (0)');
    assert.strictEqual(recallScopeItemText('linked'), 'Recall from: linked chats');
    assert.strictEqual(recallScopeItemText('all', 3), 'Recall from: all chats');
  });

  it('the menu has the three "Recall from" items and "Link chats…" above "Delete chat"', () => {
    const menu = element('chat-context-menu');
    const at = (text) => {
      const i = menu.indexOf(text);
      assert.ok(i >= 0, text);
      return i;
    };
    const order = [
      at('data-action="recall-scope" data-scope="chat"'),
      at('data-action="recall-scope" data-scope="linked"'),
      at('data-action="recall-scope" data-scope="all"'),
      at('id="chat-recall-pin-note"'),
      at('data-action="link-chats"'),
      at('data-action="delete"')
    ];
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
    assert.match(menu, />Recall from: this chat</);
    assert.match(menu, />Recall from: linked chats</);
    assert.match(menu, />Recall from: all chats</);
    assert.match(menu, />Link chats…</);
    assert.match(menu, />Delete chat</);
  });

  it('reads the scope when the menu opens, and offers nothing a pinned chat cannot have', () => {
    const refresh = block('async function refreshRecallMenu(', '\nasync function setChatRecallScope(');
    assert.match(refresh, /window\.electron\.history\.getLinks\(\{ chatId \}\)/);
    assert.match(refresh, /appState\.contextChatId !== chatId/, 'a reply for a menu that moved on is dropped');
    const paint = block('function paintRecallMenu(', '\nasync function refreshRecallMenu(');
    assert.match(paint, /view\.effectiveScope/, 'the choice marked is the effective scope');
    assert.match(paint, /recallPinText\(view\.pinned\)/);
    assert.match(paint, /c\.linked && c\.allowed/, 'the count is of links that take effect');
    assert.doesNotMatch(paint, /textContent = view\.pinned/, 'the reason code is never shown');
    assert.match(block('function openContextMenu(', '\nfunction showRenameDialog('), /refreshRecallMenu\(chatId\)/);
    assert.doesNotMatch(texts() + paint + refresh, NO_HTML);
  });

  it('a choice goes through history:scope.set, and a refusal is shown as text', () => {
    const set = block('async function setChatRecallScope(', '\nfunction closeLinkChatsDialog(');
    assert.match(set, /window\.electron\.history\.setScope\(\{ chatId, scope \}\)/);
    assert.match(set, /showNotice\(/);
    assert.match(set, /result\?\.error/);
    assert.doesNotMatch(set, NO_HTML);
    assert.doesNotMatch(block('function showNotice(', '\n}\n'), NO_HTML);
    const handler = block("dom.chatContextMenu.addEventListener('click'", '\n});');
    assert.match(handler, /setChatRecallScope\(/);
    assert.match(handler, /openLinkChatsDialog\(/);
    assert.match(handler, /handleDeleteChat\(/);
    assert.doesNotMatch(handler, NO_HTML);
  });
});

describe('renderer: the "Link chats…" dialog', () => {
  it('index.html has the dialog with both fixed lines', () => {
    const markup = element('link-chats-dialog');
    assert.match(markup, /id="link-chats-dialog"[^>]* hidden>/);
    assert.match(markup, />Links go one way: this chat can read the chats you tick\. They cannot read this chat\.</);
    assert.match(markup, />A chat that reads other chats cannot be attached to a case later\.</);
    for (const id of ['link-chats-list', 'link-chats-error', 'link-chats-cancel-btn', 'link-chats-save-btn']) {
      assert.match(markup, new RegExp(`id="${id}"`), id);
    }
  });

  it('lists the candidates as text, and a chat that cannot be linked is disabled with its sentence', () => {
    const dialog = block('function closeLinkChatsDialog(', '\nfunction showRenameDialog(');
    assert.match(dialog, /window\.electron\.history\.getLinks\(\{ chatId \}\)/);
    assert.match(dialog, /view\.candidates/);
    assert.match(dialog, /\.type = 'checkbox'/);
    assert.match(dialog, /\.disabled = !candidate\.allowed/);
    assert.match(dialog, /\.checked = candidate\.linked && candidate\.allowed/);
    assert.match(dialog, /recallLinkRefusedText\(candidate\.reason\)/);
    assert.match(dialog, /\.textContent = /);
    assert.doesNotMatch(dialog, NO_HTML);
    assert.doesNotMatch(dialog, /markdown/);
  });

  it('saves only chats that may be linked, then sets "linked" for a chat that recalled from itself', () => {
    const save = block('async function saveLinkChats(', '\nfunction showRenameDialog(');
    assert.match(save, /box\.checked && !box\.disabled/, 'a refused candidate is never sent back');
    assert.match(save, /window\.electron\.history\.setLinks\(\{ chatId, linkedChatIds \}\)/);
    assert.match(save, /saved\.scope === 'chat' && saved\.links\.length > 0/);
    assert.match(save, /window\.electron\.history\.setScope\(\{ chatId, scope: 'linked' \}\)/);
    assert.match(save, /This chat now recalls from its linked chats\./);
    assert.ok(save.indexOf('history.setLinks(') < save.indexOf('history.setScope('), 'links first, then the scope');
  });

  it('preload exposes setScope, getLinks and setLinks', () => {
    for (const [name, channel] of [['setScope', 'history:scope.set'], ['getLinks', 'history:links.get'], ['setLinks', 'history:links.set']]) {
      assert.match(preload, new RegExp(`${name}: \\(payload\\) => \\{`), name);
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace('.', '\\.')}'`), channel);
    }
  });
});

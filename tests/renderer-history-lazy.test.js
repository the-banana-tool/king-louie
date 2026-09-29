// tests/renderer-history-lazy.test.js
// The renderer holds only the active chat's messages (recall spec §4.4) and
// says when chat history is unavailable or partly migrated (§11.1, §15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// A Windows checkout may have CRLF line ends; the helpers below cut on '\n}\n'.
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `renderer.js defines ${name}`);
  const end = src.indexOf('\n}\n', start);
  return new Function(`${src.slice(start, end + 2)}\nreturn ${name};`)();
}
function body(name) {
  const start = src.indexOf(`function ${name}(`);
  return src.slice(start, src.indexOf('\n}\n', start));
}

describe('renderer: only the active chat keeps its messages', () => {
  const dropInactiveChatMessages = fn('dropInactiveChatMessages');

  it('drops an inactive chat\'s messages and keeps what the sidebar shows', () => {
    const chats = [
      { id: 'a', title: 'Active', messages: [{ id: 'm1', sender: 'user', text: 'hi' }] },
      {
        id: 'b', title: 'Left behind', messages: [
          { id: 'm2', sender: 'user', text: 'blue folder', timestamp: '2026-09-29T10:00:00.000Z' },
          { id: 'm3', sender: 'assistant', text: 'noted', timestamp: '2026-09-29T10:01:00.000Z' },
          { id: 'm4', sender: 'status', text: 'Main model switched', timestamp: '2026-09-29T10:02:00.000Z' }
        ]
      },
      { id: 'c', title: 'Never loaded', preview: 'from chat:load', messageCount: 9 }
    ];
    dropInactiveChatMessages(chats, 'a');
    assert.strictEqual(chats[0].messages.length, 1);
    assert.strictEqual(chats[1].messages, undefined);
    assert.deepStrictEqual(
      [chats[1].messageCount, chats[1].userMessageCount, chats[1].assistantMessageCount, chats[1].preview, chats[1].lastMessageText, chats[1].lastMessageAt],
      [3, 1, 1, 'noted', 'noted', '2026-09-29T10:01:00.000Z']
    );
    assert.deepStrictEqual(chats[2], { id: 'c', title: 'Never loaded', preview: 'from chat:load', messageCount: 9 });
  });

  it('runs on every refresh', () => {
    assert.match(body('refreshUI'), /dropInactiveChatMessages\(appState\.chats, appState\.activeChatId\)/);
  });
});

describe('renderer: local messages never fake a loaded chat (review focus 4)', () => {
  const pushLoadedMessage = fn('pushLoadedMessage');

  it('pushes into a loaded chat and leaves an unloaded one unloaded', () => {
    const loaded = { id: 'a', messages: [] };
    const unloaded = { id: 'b', messageCount: 40 };
    pushLoadedMessage(loaded, { id: 's1', sender: 'status', text: 'x' });
    pushLoadedMessage(unloaded, { id: 's2', sender: 'status', text: 'y' });
    pushLoadedMessage(null, { id: 's3' });
    assert.strictEqual(loaded.messages.length, 1);
    assert.strictEqual(unloaded.messages, undefined);
  });

  it('has no "x.messages = x.messages || []" left that would create a partial list', () => {
    assert.doesNotMatch(src, /\.messages = (\w+)\.messages \|\| \[\]/);
  });
});

describe('renderer: history notices', () => {
  const historyNoticeText = fn('historyNoticeText');

  it('names why chats are unavailable and how many chats did not migrate', () => {
    assert.strictEqual(historyNoticeText({ available: false, error: 'file is not a database' }), 'Chats are unavailable: file is not a database. See the log.');
    assert.strictEqual(historyNoticeText({ available: true, migrationFailed: 3 }), '3 chats could not be migrated; see log');
    assert.strictEqual(historyNoticeText({ available: true, migrationFailed: 1 }), '1 chat could not be migrated; see log');
    assert.strictEqual(historyNoticeText({ available: true, error: null, migrationFailed: 0 }), null);
    assert.strictEqual(historyNoticeText(null), null);
  });

  it('reads chat:load\'s history and shows the unavailable note in the chat list', () => {
    assert.match(body('loadChats'), /appState\.historyStatus = data\.history/);
    assert.match(body('renderChatList'), /chat-list-error/);
  });
});

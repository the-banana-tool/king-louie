// tests/renderer-task-badge.test.js
// The badge on a task's chat (attach stage 2 spec §6.7): `Task · <client>` from the
// chat's own fields, in the list and above the messages, set with textContent.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { taskBadge } = require('../renderer-helpers/task-badge');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('taskBadge', () => {
  it('names the client of a chat with a task', () => {
    assert.strictEqual(taskBadge({ taskId: 't', client: 'claude.ai' }), 'Task · claude.ai');
  });

  it('is null for a chat with no task', () => {
    assert.strictEqual(taskBadge({}), null);
    assert.strictEqual(taskBadge(null), null);
    assert.strictEqual(taskBadge(undefined), null);
    assert.strictEqual(taskBadge({ client: 'claude.ai' }), null);
    assert.strictEqual(taskBadge({ taskId: '', client: 'claude.ai' }), null);
    assert.strictEqual(taskBadge({ taskId: 7, client: 'claude.ai' }), null);
  });

  it('says Task when the client has no usable name', () => {
    assert.strictEqual(taskBadge({ taskId: 't' }), 'Task');
    assert.strictEqual(taskBadge({ taskId: 't', client: '' }), 'Task');
    assert.strictEqual(taskBadge({ taskId: 't', client: { name: 'x' } }), 'Task');
  });
});

describe('where the badge goes', () => {
  const src = read('renderer.js');
  const html = read('index.html');

  it('the helper loads before the renderer, as a script of the app\'s own', () => {
    const helper = html.indexOf('<script src="renderer-helpers/task-badge.js"></script>');
    assert.ok(helper > 0 && helper < html.indexOf('<script src="renderer.js"></script>'));
  });

  it('the list and the header draw it with textContent', () => {
    assert.match(src, /\.className = 'chat-item-task-badge'/);
    assert.match(html, /id="chat-header-task-badge"/);
    const paint = src.slice(src.indexOf('function paintTaskBadge('), src.indexOf('function renderChatMessages('));
    assert.match(paint, /textContent = /);
    assert.doesNotMatch(paint, /innerHTML/);
  });
});

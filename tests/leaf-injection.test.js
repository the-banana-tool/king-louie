const { describe, it } = require('node:test');
const assert = require('node:assert');
const UiToastChannel = require('../src/notifications/channels/ui-toast');
const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
const AnthropicOAuth = require('../src/auth/anthropic-oauth');

describe('UiToastChannel', () => {
  it('skips cleanly without an injected Notification', async () => {
    const r = await new UiToastChannel().send({ title: 't', body: 'b' });
    assert.deepStrictEqual(r, { ok: false, skipped: true, reason: 'Desktop notifications are not available in this host.' });
  });
  it('shows via the injected Notification class', async () => {
    const shown = [];
    class FakeNotification { constructor(o) { this.o = o; } static isSupported() { return true; } show() { shown.push(this.o); } }
    const r = await new UiToastChannel({ Notification: FakeNotification }).send({ title: 't', body: 'b' });
    assert.deepStrictEqual(r, { ok: true, channel: 'ui-toast' });
    assert.strictEqual(shown[0].title, 't');
  });
});

describe('DesktopChannelPlugin', () => {
  it('sends through the injected sendToUi', async () => {
    const sent = [];
    const plugin = new DesktopChannelPlugin({ sendToUi: (ch, p) => sent.push({ ch, p }) });
    assert.deepStrictEqual(await plugin.send('me', 'hello'), { status: 'sent' });
    assert.strictEqual(sent[0].ch, 'channel:message');
    assert.strictEqual(sent[0].p.message, 'hello');
  });
});

describe('AnthropicOAuth', () => {
  it('accepts an injected openExternal', () => {
    const opened = [];
    const oauth = new AnthropicOAuth({ clientId: 'c', encryptToken: (x) => x, decryptToken: (x) => x, store: { get: () => null, set() {}, delete() {} }, openExternal: (u) => opened.push(u) });
    assert.strictEqual(typeof oauth.openExternal, 'function');
    oauth.openExternal('https://example.com');
    assert.deepStrictEqual(opened, ['https://example.com']);
  });
});

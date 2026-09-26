// tests/contact-adapter-contract.test.js
// The contact adapter contract (cases stage 4 §3.1, §10): send → deliveryId;
// an owner reply → the handler with the correlation; a stranger →
// ownerProven: false; a failed send → ContactDeliveryError. Later tasks append
// one describe block per adapter.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  ChannelPlugin, DesktopChannelPlugin, ContactDeliveryError, ContactUnsupportedError, CONTACT_ERROR_CODES, GATE_PASSED
} = require('../src/channels/channel-plugin');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const ITEM = { n: 1, token: '7QD4KM', caseId: 'c-1', questionId: 'q-0001', caseTitle: 'Lakeside lot', kind: 'question', text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }], urgency: 'high', answerable: true };
const MESSAGE = { subject: 'King Louie: 1 question (1 high)', text: '1. [HIGH] Lakeside lot — Is seller financing ever acceptable?', items: [ITEM] };
const META = { expectsReply: true, options: ITEM.options, deliveryId: 'd-test-1', batchToken: 'K7QD4M', expiresAt: null, urgency: 'high' };

describe('ChannelPlugin contact defaults', () => {
  it('is inert: no capabilities, no owner target, not configured, sendContact refuses', async () => {
    const plugin = new ChannelPlugin({ id: 'plain' });
    assert.strictEqual(plugin.contactCapabilities(), null);
    assert.strictEqual(plugin.ownerTarget(), null);
    assert.strictEqual(plugin.presence(), null);
    assert.strictEqual(plugin.contactConfigured(), false);
    assert.doesNotThrow(() => plugin.onContactReply(() => {}));
    assert.doesNotThrow(() => plugin.onContactStatus(() => {}));
    await assert.rejects(plugin.sendContact(MESSAGE, META), (err) => err instanceof ContactUnsupportedError
      && err instanceof ContactDeliveryError && err.code === 'not-configured');
  });

  it('ContactDeliveryError keeps the five codes and maps anything else to unreachable', () => {
    assert.deepStrictEqual([...CONTACT_ERROR_CODES], ['not-configured', 'rejected', 'unreachable', 'too-large', 'rate-limited']);
    for (const code of CONTACT_ERROR_CODES) assert.strictEqual(new ContactDeliveryError(code, 'x').code, code);
    assert.strictEqual(new ContactDeliveryError('socket hang up').code, 'unreachable');
    assert.strictEqual(typeof GATE_PASSED, 'symbol');
  });
});

describe('contact adapter: in-app (DesktopChannelPlugin)', () => {
  it('re-surfaces each item as a banner and toasts only when the window is unfocused', async () => {
    const events = [];
    const toasts = [];
    let focused = false;
    const plugin = new DesktopChannelPlugin({
      sendToUi: (event, payload) => events.push([event, payload]),
      uiToast: { send: async (t) => { toasts.push(t); return { ok: true }; } },
      isFocused: () => focused
    });
    assert.strictEqual(plugin.contactCapabilities().authenticatedReplies, true);
    assert.strictEqual(plugin.contactCapabilities().interrupts, false);
    assert.strictEqual(plugin.ownerTarget(), 'window');
    const sent = await plugin.sendContact(MESSAGE, META);
    assert.deepStrictEqual(sent, { deliveryId: 'd-test-1', externalRef: null });
    assert.deepStrictEqual(events, [['case:changed', { caseId: 'c-1', what: 'questions', questionId: 'q-0001', attention: 'banner' }]]);
    assert.deepStrictEqual(toasts, [{ title: MESSAGE.subject, body: 'Open King Louie to answer' }]);
    focused = true;
    await plugin.sendContact(MESSAGE, META);
    assert.strictEqual(toasts.length, 1, 'no toast while the window has focus');
  });

  it('without an interactive window it is not a contact channel and refuses with not-configured', async () => {
    const plugin = new DesktopChannelPlugin({});
    assert.strictEqual(plugin.contactCapabilities(), null);
    assert.strictEqual(plugin.contactConfigured(), false);
    await assert.rejects(plugin.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'not-configured');
  });
});

describe('contact adapter: loopback (tests/helpers/loopback-channel.js)', () => {
  it('meets the contract', async () => {
    const ch = new LoopbackChannel({ id: 'telegram', owner: '111' });
    const sent = await ch.sendContact(MESSAGE, META);
    assert.strictEqual(sent.deliveryId, 'd-test-1');
    assert.strictEqual(ch.last().message.subject, MESSAGE.subject);

    const calls = [];
    ch.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' }; });
    await ch.reply('7QD4KM', { optionId: 'a' });
    assert.strictEqual(calls[0].correlationId, '7QD4KM');
    assert.strictEqual(calls[0].meta.ownerProven, true);
    assert.deepStrictEqual(ch.plain, [{ target: '111', text: 'Recorded for Lakeside lot.' }]);

    await ch.reply('7QD4KM', { text: 'no' }, { senderId: '999', ownerProven: false });
    assert.strictEqual(calls[1].meta.ownerProven, false);
    assert.strictEqual(ch.plain.length, 1, 'no ack for a stranger');

    ch.failNext('rate-limited');
    await assert.rejects(ch.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'rate-limited');
    await assert.rejects(ch.send('999', 'hello'), /refused/);
    await ch.send('999', 'hello', { [GATE_PASSED]: true });
  });
});

describe('contact adapter: sms and voice (fake relay)', () => {
  const { TelephonyChannel } = require('../src/channels/telephony-channel');
  const { ContactRelayClient } = require('../src/channels/relay-client');
  const { startFakeRelay } = require('./helpers/fake-contact-relay');

  it('meets the contract', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const sms = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({ owner: '+15550100' }) });
      const voice = new TelephonyChannel({ kind: 'voice', relay: client, getConfig: () => ({ owner: '+15550100' }) });
      assert.strictEqual(sms.contactCapabilities().authenticatedReplies, false);
      assert.strictEqual(sms.contactCapabilities().requiresToken, true);
      assert.strictEqual(voice.contactCapabilities().voice, true);
      assert.strictEqual((await sms.sendContact(MESSAGE, META)).deliveryId, 'd-test-1');
      assert.strictEqual((await voice.sendContact(MESSAGE, { ...META, deliveryId: 'd-test-2' })).deliveryId, 'd-test-2');

      const calls = [];
      sms.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: true, outcome: 'recorded', ackText: null }; });
      await sms.ingestRelayEvent({ id: 'e1', type: 'inbound', channel: 'sms', from: '+15550100', text: '#K7QD4M a' });
      assert.strictEqual(calls[0].correlationId, 'K7QD4M');
      assert.strictEqual(calls[0].meta.ownerProven, true);
      await sms.ingestRelayEvent({ id: 'e2', type: 'inbound', channel: 'sms', from: '+15550177', text: '#K7QD4M a' });
      assert.strictEqual(calls[1].meta.ownerProven, false);

      relay.failNext(413);
      await assert.rejects(sms.sendContact(MESSAGE, { ...META, deliveryId: 'd-test-3' }), (err) => err instanceof ContactDeliveryError && err.code === 'too-large');
      const unset = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({}) });
      assert.strictEqual(unset.contactConfigured(), false);
      await assert.rejects(unset.sendContact(MESSAGE, META), (err) => err.code === 'not-configured');
    } finally {
      await relay.close();
    }
  });
});

describe('contact adapter: email over the relay and over IMAP/SMTP', () => {
  const { EmailChannel } = require('../src/channels/email-channel');
  const { createRelayEmailTransport, createImapSmtpTransport } = require('../src/channels/email-transports');
  const { ContactRelayClient } = require('../src/channels/relay-client');
  const { startFakeRelay } = require('./helpers/fake-contact-relay');
  const { startFakeSmtp } = require('./helpers/fake-smtp');
  const config = () => ({ owner: 'owner@example.com', from: 'kl@example.com', trustedAuthServId: 'mx.example.com' });

  async function contract(email, fail) {
    assert.strictEqual(email.contactCapabilities().authenticatedReplies, false);
    const sent = await email.sendContact(MESSAGE, META);
    assert.strictEqual(sent.deliveryId, 'd-test-1');
    assert.strictEqual(sent.externalRef, '<kl-d-test-1@example.com>');
    const calls = [];
    email.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: true, outcome: 'recorded', ackText: null }; });
    await email.ingestRelayEvent({ id: 'e1', type: 'inbound', channel: 'email', from: 'owner@example.com', subject: 'Re: [KL-K7QD4M]', text: 'a', inReplyTo: sent.externalRef });
    assert.strictEqual(calls[0].correlationId, 'd-test-1');
    assert.strictEqual(calls[0].meta.ownerProven, true);
    await email.ingestRelayEvent({ id: 'e2', type: 'inbound', channel: 'email', from: 'someone@example.org', subject: 'Re: [KL-K7QD4M]', text: 'a', inReplyTo: sent.externalRef });
    assert.strictEqual(calls[1].meta.ownerProven, false);
    await fail();
    await assert.rejects(email.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError);
  }

  it('relay transport meets the contract', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: config });
      await contract(email, async () => relay.failNext(429));
    } finally {
      await relay.close();
    }
  });

  it('imap-smtp transport meets the contract (fake SMTP over net)', async () => {
    const smtp = await startFakeSmtp();
    let port = smtp.port;
    const email = new EmailChannel({
      transport: createImapSmtpTransport({ smtp: { get host() { return '127.0.0.1'; }, get port() { return port; }, secure: false, user: '' }, imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' } }),
      getConfig: config
    });
    try {
      await contract(email, async () => {
        await smtp.close();
        await email.transport.close();
        port = 9;
      });
    } finally {
      await email.shutdown();
    }
  });
});

describe('contact adapter: ntfy (delivery only)', () => {
  const { NtfyContact, NO_TEXT } = require('../src/channels/ntfy-contact');

  it('meets the contract: send only, never an owner target, text only when includeText', async () => {
    const published = [];
    const publisher = { send: async (p) => { published.push(p); return { ok: true, channel: 'ntfy', topic: p.topic }; } };
    let includeText = false;
    const ntfy = new NtfyContact({ getConfig: () => ({ topic: 'kl-owner-topic', includeText }), publisher });
    const caps = ntfy.contactCapabilities();
    assert.strictEqual(caps.expectsReplies, false);
    assert.strictEqual(caps.deliveryOnly, true);
    assert.strictEqual(ntfy.ownerTarget(), null);
    assert.strictEqual(ntfy.contactConfigured(), true);
    assert.strictEqual((await ntfy.sendContact(MESSAGE, META)).deliveryId, 'd-test-1');
    assert.deepStrictEqual(published[0], { topic: 'kl-owner-topic', title: MESSAGE.subject, body: NO_TEXT });
    includeText = true;
    await ntfy.sendContact(MESSAGE, META);
    assert.strictEqual(published[1].body, MESSAGE.text);
    await assert.rejects(ntfy.send('kl-owner-topic', 'hi'), /without the outbound gate/);

    const failing = new NtfyContact({ getConfig: () => ({ topic: 't' }), publisher: { send: async () => { throw new Error('ntfy publish failed: 500'); } } });
    await assert.rejects(failing.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'unreachable');
    const privateNet = new NtfyContact({ getConfig: () => ({ baseUrl: 'http://127.0.0.1:8080', topic: 't' }) });
    await assert.rejects(privateNet.sendContact(MESSAGE, META), /private network/, 'the NtfyChannel SSRF guard is kept');
    assert.strictEqual(new NtfyContact({ getConfig: () => ({}) }).contactCapabilities(), null);
  });
});

describe('contact adapter: Telegram (fake Bot API via apiBase)', () => {
  const http = require('http');
  const TelegramBridge = require('../src/channels/telegram-bridge');

  async function fakeBotApi() {
    const calls = [];
    let failStatus = null;
    let nextId = 4811;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const method = req.url.split('/').pop();
        calls.push({ path: req.url, method, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (failStatus) {
          res.statusCode = failStatus;
          failStatus = null;
          res.end(JSON.stringify({ ok: false, description: 'forced' }));
          return;
        }
        nextId += 1;
        res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: nextId } : true }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { apiBase: `http://127.0.0.1:${server.address().port}`, calls, failNext: (s) => { failStatus = s; }, close: () => new Promise((r) => server.close(r)) };
  }

  async function bridgeWith(api, { enabled = true, allowed = () => true } = {}) {
    const bridge = new TelegramBridge({
      token: 'TEST-TOKEN',
      apiBase: api.apiBase,
      allowlistManager: { isAllowed: (ch, sender, group) => allowed(sender, group), isAllowedUser: () => true },
      sessionManager: { buildSessionKey: () => 'agent:main:telegram:x' }
    });
    const routed = [];
    bridge.routeAgentMessage = async (chatId, text) => { routed.push({ chatId, text }); };
    bridge.handleCommand = async (chatId, text) => { routed.push({ chatId, text }); };
    bridge.getOrCreateLocalChat = () => null;
    const known = new Set(['K7QD4M', '7QD4KM']);
    const refs = new Set();
    // Like ContactRouter.knows: { ref: true } matches only message references.
    const knows = (channel, ref, opts = {}) => channel === 'telegram' && (opts.ref ? refs.has(String(ref)) : known.has(String(ref).toUpperCase()));
    bridge.setContactHost({ router: { knows }, getOwnerUserId: () => '111', isEnabled: () => enabled });
    const calls = [];
    bridge.onContactReply(async (correlationId, answer, meta) => {
      calls.push({ correlationId, answer, meta });
      return meta.ownerProven ? { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' } : { ok: false, outcome: 'refused: not-owner', ackText: null };
    });
    return { bridge, calls, routed, known, refs };
  }

  const privateChat = (id) => ({ id, type: 'private' });

  it('meets the contract', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, refs } = await bridgeWith(api);
      assert.strictEqual(bridge.apiBase, `${api.apiBase}/botTEST-TOKEN`);
      assert.strictEqual(bridge.ownerTarget(), '111');
      const sent = await bridge.sendContact(MESSAGE, META);
      assert.strictEqual(sent.deliveryId, 'd-test-1');
      assert.strictEqual(sent.externalRef, '4812');
      const req = api.calls.find((c) => c.method === 'sendMessage');
      assert.strictEqual(req.body.chat_id, 111);
      assert.deepStrictEqual(req.body.reply_markup.inline_keyboard, [[
        { text: '1. No', callback_data: 'kl_q_7QD4KM_0' }, { text: '1. Yes, up to 20 %', callback_data: 'kl_q_7QD4KM_1' }
      ]]);
      assert.ok(Buffer.byteLength('kl_q_7QD4KM_1') <= 17);
      for (const b of req.body.reply_markup.inline_keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 17, b.callback_data);

      await bridge.handleUpdate({ callback_query: { id: 'cb1', data: 'kl_q_7QD4KM_1', from: { id: 111 }, message: { chat: privateChat(111) } } });
      assert.deepStrictEqual([calls[0].correlationId, calls[0].answer, calls[0].meta.ownerProven], ['7QD4KM', { optionIndex: 1 }, true]);
      assert.strictEqual(api.calls.filter((c) => c.method === 'sendMessage').pop().body.text, 'Recorded for Lakeside lot.');

      refs.add('4812');
      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: 'yes', reply_to_message: { message_id: 4812 } } });
      assert.deepStrictEqual([calls[1].correlationId, calls[1].answer, calls[1].meta.ownerProven], ['4812', { text: 'yes' }, true]);

      await bridge.handleUpdate({ message: { chat: privateChat(999), from: { id: 999 }, text: '#K7QD4M a' } });
      assert.strictEqual(calls[2].meta.ownerProven, false, 'a stranger');

      api.failNext(429);
      await assert.rejects(bridge.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'rate-limited');
    } finally {
      await api.close();
    }
  });

  it('refuses a group member and a second allowlisted user, and never routes their #TOKEN to the agent', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, routed } = await bridgeWith(api);
      const before = api.calls.length;
      await bridge.handleUpdate({ message: { chat: { id: -100222, type: 'supergroup', title: 'Family' }, from: { id: 333 }, text: '#K7QD4M 1 a' } });
      await bridge.handleUpdate({ message: { chat: privateChat(444), from: { id: 444 }, text: '#K7QD4M 1 a' } });
      await bridge.handleUpdate({ callback_query: { id: 'cb2', data: 'kl_q_7QD4KM_0', from: { id: 111 }, message: { chat: { id: -100222, type: 'supergroup' } } } });
      assert.deepStrictEqual(calls.map((c) => c.meta.ownerProven), [false, false, false], 'the owner pressing in a group is not the private chat either');
      assert.deepStrictEqual(routed, []);
      assert.deepStrictEqual(api.calls.slice(before).filter((c) => c.method === 'sendMessage'), [], 'no acks to anyone');
      assert.strictEqual(api.calls.slice(before).find((c) => c.method === 'answerCallbackQuery').body.text, 'Not allowed');

      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: '#ZZZZZZ unrelated' } });
      assert.deepStrictEqual(routed, [{ chatId: '111', text: '#ZZZZZZ unrelated' }], 'an unknown token is an ordinary message');
    } finally {
      await api.close();
    }
  });

  it('with contact off it is not a contact channel', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge } = await bridgeWith(api, { enabled: false });
      assert.strictEqual(bridge.contactCapabilities(), null);
      assert.strictEqual(bridge.ownerTarget(), null);
      await assert.rejects(bridge.sendContact(MESSAGE, META), (err) => err.code === 'not-configured');
      assert.strictEqual(new TelegramBridge({ token: 'X' }).apiBase, 'https://api.telegram.org/botX');
    } finally {
      await api.close();
    }
  });

  // Preflight M17: Telegram message ids are small per-chat integers, so a
  // reply is a contact reply only in the owner's private chat.
  it('a reply to a colliding message id outside the owner chat takes the normal path', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, routed, refs } = await bridgeWith(api);
      refs.add('4812');
      await bridge.handleUpdate({ message: { chat: { id: -100222, type: 'supergroup', title: 'Family' }, from: { id: 333 }, text: 'see above', reply_to_message: { message_id: 4812 } } });
      await bridge.handleUpdate({ message: { chat: privateChat(999), from: { id: 999 }, text: 'what?', reply_to_message: { message_id: 4812 } } });
      await bridge.handleUpdate({ message: { chat: { id: -100222, type: 'supergroup', title: 'Family' }, from: { id: 111 }, text: 'owner in the group', reply_to_message: { message_id: 4812 } } });
      assert.deepStrictEqual(calls, [], 'no reply-id interception outside the owner private chat');
      assert.deepStrictEqual(routed.map((r) => r.text), ['see above', 'what?', 'owner in the group']);
    } finally {
      await api.close();
    }
  });

  // C2 channel tagging / M21: contact replies never enter a local chat (and so
  // never an ownerMessages quote); everything else reaches it tagged as before.
  it('an ordinary message reaches the local chat tagged telegram; a contact reply never does', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, routed } = await bridgeWith(api);
      const created = [];
      const added = [];
      delete bridge.getOrCreateLocalChat;
      bridge.createLocalChat = (title, opts) => { created.push({ title, opts }); return 'local-1'; };
      bridge.addMessageToLocalChat = (localChatId, sender, text, opts) => { added.push({ localChatId, sender, text, opts }); };

      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111, username: 'owner' }, text: '#K7QD4M 1 a' } });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual([created, added, routed], [[], [], []], 'the contact reply stays out of every chat');

      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111, username: 'owner' }, text: 'how is the lot going?' } });
      assert.strictEqual(calls.length, 1, 'not a contact reply');
      assert.deepStrictEqual(created.map((c) => c.opts), [{ origin: 'telegram' }]);
      assert.deepStrictEqual(added, [{ localChatId: 'local-1', sender: 'user', text: 'how is the lot going?', opts: { channel: 'telegram' } }]);
      assert.deepStrictEqual(routed, [{ chatId: '111', text: 'how is the lot going?' }]);
    } finally {
      await api.close();
    }
  });

  // Owner decision M22: approvals and app-only items are notices, never buttons.
  it('renders buttons only for answerable items', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge } = await bridgeWith(api);
      const notice = { ...ITEM, n: 2, token: 'M2P8RT', kind: 'approval', answerable: false, options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] };
      await bridge.sendContact({ ...MESSAGE, items: [notice] }, META);
      await bridge.sendContact({ ...MESSAGE, items: [ITEM, notice] }, META);
      const sends = api.calls.filter((c) => c.method === 'sendMessage');
      assert.strictEqual(sends[0].body.reply_markup, undefined, 'a notice-only batch has no keyboard');
      assert.deepStrictEqual(sends[1].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['kl_q_7QD4KM_0', 'kl_q_7QD4KM_1']);
    } finally {
      await api.close();
    }
  });

  it('malformed callback data is refused without reaching the router', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls } = await bridgeWith(api);
      const bad = ['kl_q_', 'kl_q_7QD4KM', 'kl_q_7QD4KM_', 'kl_q_7QD4KM_10', 'kl_q_7QD4K_1', 'kl_q_7QD4KMX_1', 'kl_q_7QD4KM_1 ', 'kl_q_7QD4KM_1\n', 'kl_q_7QD4KM_-1', 'kl_q_7QD4KM_١', `kl_q_7QD4KM_1${'x'.repeat(80)}`];
      for (const [i, data] of bad.entries()) {
        await bridge.handleUpdate({ callback_query: { id: `bad-${i}`, data, from: { id: 111 }, message: { chat: privateChat(111) } } });
      }
      assert.deepStrictEqual(calls, []);
      const answers = api.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text);
      assert.deepStrictEqual(answers, bad.map(() => 'Unknown action'));
    } finally {
      await api.close();
    }
  });

  it('a reply-to id is looked up as a message reference only, never as a token', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, routed, known } = await bridgeWith(api);
      known.add('123456');
      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: 'b', reply_to_message: { message_id: 123456 } } });
      assert.deepStrictEqual(calls, [], 'a token equal to the reply-to id does not make it a contact reply');
      assert.deepStrictEqual(routed, [{ chatId: '111', text: 'b' }]);
    } finally {
      await api.close();
    }
  });

  // Review T10 round 2: a leading #token names the question; the reply-to is
  // then not passed as deliveryRef (the router would resolve it first).
  it('a #token message that is also a reply carries no deliveryRef', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, refs } = await bridgeWith(api);
      refs.add('4812');
      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: '#K7QD4M 2', reply_to_message: { message_id: 4812 } } });
      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: '2', reply_to_message: { message_id: 4812 } } });
      assert.deepStrictEqual(calls.map((c) => [c.correlationId, c.meta.deliveryRef]), [['K7QD4M', null], ['4812', '4812']]);
    } finally {
      await api.close();
    }
  });

  // Review T10 M3: a forward carries someone else's words; it never proves the owner.
  it('a forwarded message is never owner-proven', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, calls, refs } = await bridgeWith(api);
      refs.add('4812');
      const fwd = [{ forward_origin: { type: 'user', sender_user: { id: 999 }, date: 1 } }, { forward_from: { id: 999 } }, { forward_date: 1 }, { forward_origin: { type: 'hidden_user', sender_user_name: 'x', date: 1 } }];
      for (const f of fwd) await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: '#K7QD4M 1 a', ...f } });
      await bridge.handleUpdate({ message: { chat: privateChat(111), from: { id: 111 }, text: 'a', reply_to_message: { message_id: 4812 }, forward_date: 1 } });
      assert.deepStrictEqual(calls.map((c) => c.meta.ownerProven), [false, false, false, false, false]);
      assert.deepStrictEqual(api.calls.filter((c) => c.method === 'sendMessage'), [], 'no ack');
    } finally {
      await api.close();
    }
  });

  // Review T10 M4: a live token must not change what a stranger sees.
  it('a stranger who is not allowlisted gets the same notice for a live and a made-up token', async () => {
    const api = await fakeBotApi();
    try {
      const { bridge, routed } = await bridgeWith(api, { allowed: (sender) => sender === '111' });
      await bridge.handleUpdate({ message: { chat: privateChat(501), from: { id: 501 }, text: '#K7QD4M 1 a' } });
      await bridge.handleUpdate({ message: { chat: privateChat(502), from: { id: 502 }, text: '#ZZZZZZ 1 a' } });
      const notices = api.calls.filter((c) => c.method === 'sendMessage').map((c) => ({ chat: c.body.chat_id, text: c.body.text.replace(/50[12]/g, 'N') }));
      assert.strictEqual(notices.length, 2);
      assert.deepStrictEqual(notices.map((n) => n.chat), [501, 502]);
      assert.strictEqual(notices[0].text, notices[1].text, 'identical notice either way');
      assert.deepStrictEqual(routed, []);
    } finally {
      await api.close();
    }
  });

  // Review T10 M2: the bridge's existing error logs never carry the bot token.
  it('the bridge error logs redact the bot token', async () => {
    const { addSink } = require('../src/logging');
    const lines = [];
    const remove = addSink((r) => { if (r.subsystem === 'telegram-bridge') lines.push(r.message); });
    try {
      const secret = 'SECRET-BOT-TOKEN';
      // polling failed (start's catch)
      const a = new TelegramBridge({ token: secret, apiBase: 'http://[bad', gatewayServer: { on() {} } });
      a.callTelegram = async () => ({ id: 1, username: 'kl_bot' });
      a.pollLoop = () => Promise.reject(new Error(`Failed to parse URL from http://[bad/bot${secret}/getUpdates`));
      await a.start();
      await new Promise((r) => setImmediate(r));
      // update handling error (the poll loop)
      const b = new TelegramBridge({ token: secret, apiBase: 'http://[bad' });
      b.running = true;
      const loop = b.pollLoop();
      while (!lines.some((l) => l.startsWith('update handling error'))) await new Promise((r) => setImmediate(r));
      b.running = false;
      await loop;
      // voice response
      const c = new TelegramBridge({
        token: secret, apiBase: 'http://[bad',
        getVoiceSettings: () => ({ enabled: true, telegramVoiceForLongResponses: true, telegramMinChars: 1 }),
        getTtsEngine: () => ({ speakSummary: async () => ({ audio: { buffer: Buffer.from('x') } }) })
      });
      c.sendMessage = async () => ({ message_id: 1 });
      c.pendingRuns.set('run-1', { chatId: '111', startedAt: Date.now() });
      await c.handleAgentResponse({ runId: 'run-1', content: 'hello' });

      const hits = ['polling failed', 'update handling error', 'Unable to send voice response'].map((p) => lines.find((l) => l.startsWith(p)));
      assert.ok(hits.every(Boolean), JSON.stringify(lines));
      for (const l of hits) {
        assert.ok(!l.includes(secret), l);
        assert.ok(l.includes('<bot-token>'), l);
      }
    } finally {
      remove();
    }
  });

  it('never puts the bot token in an error', async () => {
    const bridge = new TelegramBridge({ token: 'SECRET-BOT-TOKEN', apiBase: 'http://[bad' });
    bridge.setContactHost({ router: { knows: () => false }, getOwnerUserId: () => '111', isEnabled: () => true });
    await assert.rejects(bridge.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError
      && err.code === 'unreachable' && !err.message.includes('SECRET-BOT-TOKEN') && err.message.includes('<bot-token>'));
  });
});

describe('bridge-contact helpers', () => {
  const { contactOwnerProven, callbackData, parseCallback, leadingToken, buttonRows, telegramError, discordError } = require('../src/channels/bridge-contact');

  it('owner proof needs the private chat with the owner and the owner as sender', () => {
    const base = { isPrivate: true, chatId: '111', senderId: '111', target: '111', ownerUserId: '111' };
    assert.strictEqual(contactOwnerProven(base), true);
    assert.strictEqual(contactOwnerProven({ ...base, isPrivate: false }), false, 'a group');
    assert.strictEqual(contactOwnerProven({ ...base, senderId: '222' }), false, 'another sender');
    assert.strictEqual(contactOwnerProven({ ...base, chatId: '222' }), false, 'another chat');
    assert.strictEqual(contactOwnerProven({ ...base, target: null, ownerUserId: null, chatId: '', senderId: '' }), false, 'no owner configured');
  });

  it('callback data round-trips, stays within 17 bytes, and anything else parses to null', () => {
    assert.strictEqual(callbackData('7QD4KM', 7), 'kl_q_7QD4KM_7');
    assert.deepStrictEqual(parseCallback('kl_q_7qd4km_3'), { token: '7QD4KM', index: 3 });
    assert.throws(() => callbackData('7QD4K', 0), /callback/);
    assert.throws(() => callbackData('7QD4KM', 10), /callback/);
    for (const bad of [null, undefined, 42, {}, '', 'kl_a_abc_y', 'kl_q_7QD4KM_1_', 'xkl_q_7QD4KM_1', 'kl_q_7QD4KM_1'.repeat(5)]) {
      assert.strictEqual(parseCallback(bad), null, String(bad));
    }
  });

  it('leading token, button rows and error mapping', () => {
    assert.strictEqual(leadingToken('  #k7qd4m 1 a'), 'K7QD4M');
    assert.strictEqual(leadingToken('x #K7QD4M'), null);
    const rows = buttonRows([ITEM, { ...ITEM, token: 'bad', n: 2 }, { ...ITEM, n: 3, token: 'M2P8RT', answerable: false }], 8);
    assert.strictEqual(rows.length, 1, 'an item with a malformed token or no answer rights gets no buttons');
    assert.ok(rows.flat().every((b) => Buffer.byteLength(b.data) <= 17 && b.label.length <= 40));
    assert.strictEqual(telegramError(new Error('Telegram sendMessage failed: 403 Forbidden')).code, 'not-configured');
    assert.strictEqual(telegramError(new Error('Telegram sendMessage error: chat not found')).code, 'rejected');
    assert.strictEqual(telegramError(new Error('fetch failed')).code, 'unreachable');
    assert.strictEqual(telegramError(new Error('Failed to parse URL from http://x/botABC/sendMessage'), { secret: 'ABC' }).message, 'Failed to parse URL from http://x/bot<bot-token>/sendMessage');
    assert.strictEqual(discordError(Object.assign(new Error('x'), { status: 413 })).code, 'too-large');
  });

  it('shared bridge pieces: owner id, reply matching, the refused-sender path', () => {
    const { contactOwnerOf, bridgeCapabilities, matchContactReply, swallowRefusedContact } = require('../src/channels/bridge-contact');
    assert.strictEqual(contactOwnerOf({ isEnabled: () => true, getOwnerUserId: () => ' 111 ' }), '111');
    assert.strictEqual(contactOwnerOf({ isEnabled: () => 'yes', getOwnerUserId: () => '111' }), null, 'only === true enables');
    assert.strictEqual(contactOwnerOf({ isEnabled: () => true, getOwnerUserId: () => '' }), null);
    assert.strictEqual(contactOwnerOf(null), null);
    assert.deepStrictEqual([bridgeCapabilities({ maxOptions: 5, maxChars: 1900 }).maxOptions, bridgeCapabilities({ maxOptions: 5, maxChars: 1900 }).authenticatedReplies], [5, true]);
    const seen = [];
    const router = { knows: (ch, ref, opts = {}) => { seen.push([ch, ref, Boolean(opts.ref)]); return opts.ref ? ref === '123456' : ref === 'K7QD4M'; } };
    assert.deepStrictEqual(matchContactReply(router, 'discord', '#k7qd4m 2', '123456'), { correlationId: 'K7QD4M', deliveryRef: null }, 'an explicit token wins');
    assert.deepStrictEqual(matchContactReply(router, 'discord', '2', '123456'), { correlationId: '123456', deliveryRef: '123456' });
    assert.strictEqual(matchContactReply(router, 'discord', '#ZZZZZZ 2', null), null);
    seen.length = 0;
    assert.strictEqual(matchContactReply({ knows: (ch, ref, opts = {}) => { seen.push([ref, Boolean(opts.ref)]); return !opts.ref; } }, 'discord', 'b', 'K7QD4M'), null, 'a reply-to id is never asked about as a token');
    assert.deepStrictEqual(seen, [['K7QD4M', true]]);
    assert.strictEqual(swallowRefusedContact(null, 'discord', '1', null), false);
    assert.strictEqual(swallowRefusedContact({ isAllowed: () => true }, 'discord', '1', null), true);
    assert.strictEqual(swallowRefusedContact({ isAllowed: () => false }, 'discord', '1', null), false);
    assert.strictEqual(discordError(Object.assign(new Error('x TOKEN'), { status: 401 }), { secret: 'TOKEN' }).message, 'x <bot-token>');
  });
});

describe('contact adapter: Discord (fake client)', () => {
  const DiscordChannel = require('../src/channels/discord-bridge');

  function fakeDiscord({ enabled = true } = {}) {
    const dms = {};
    const makeUser = (id) => ({
      id,
      createDM: async () => {
        if (!dms[id]) {
          const sends = [];
          dms[id] = { id: `dm-${id}`, sends, fail: null, send: async (p) => { if (dms[id].fail) { const e = dms[id].fail; dms[id].fail = null; throw e; } sends.push(p); return { id: `m-${sends.length}` }; } };
        }
        return dms[id];
      }
    });
    const bridge = new DiscordChannel({ token: 'mock-token', allowlistManager: { isAllowed: () => true, isAllowedUser: () => true } });
    bridge.client = { users: { fetch: async (id) => makeUser(String(id)) }, channels: { fetch: async () => null } };
    const known = new Set(['K7QD4M', '7QD4KM']);
    bridge.setContactHost({ router: { knows: (channel, ref) => channel === 'discord' && known.has(String(ref).toUpperCase()) }, getOwnerUserId: () => '222', isEnabled: () => enabled });
    const calls = [];
    bridge.onContactReply(async (correlationId, answer, meta) => {
      calls.push({ correlationId, answer, meta });
      return meta.ownerProven ? { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' } : { ok: false, outcome: 'refused: not-owner', ackText: null };
    });
    const routed = [];
    bridge.routeAgentMessage = async (chatId, text) => { routed.push({ chatId, text }); };
    const msg = (fields) => ({ author: { id: '222', bot: false }, content: '', channelId: 'dm-222', guildId: null, reference: null, mentions: { has: () => false }, ...fields });
    const press = (fields) => {
      const replies = [];
      return { interaction: { isButton: () => true, customId: 'kl_q_7QD4KM_1', user: { id: '222' }, guildId: null, channelId: 'dm-222', reply: async (p) => { replies.push(p); }, ...fields }, replies };
    };
    return { bridge, dms, calls, routed, known, msg, press };
  }

  it('meets the contract', async () => {
    const d = fakeDiscord();
    const sent = await d.bridge.sendContact(MESSAGE, META);
    assert.deepStrictEqual(sent, { deliveryId: 'd-test-1', externalRef: 'm-1' });
    const payload = d.dms['222'].sends[0];
    assert.strictEqual(payload.content, MESSAGE.text);
    assert.deepStrictEqual(payload.components[0].toJSON().components.map((c) => [c.custom_id, c.label]), [['kl_q_7QD4KM_0', '1. No'], ['kl_q_7QD4KM_1', '1. Yes, up to 20 %']]);

    const p = d.press({});
    await d.bridge.handleInteractionCreate(p.interaction);
    assert.deepStrictEqual([d.calls[0].correlationId, d.calls[0].answer, d.calls[0].meta.ownerProven], ['7QD4KM', { optionIndex: 1 }, true]);
    assert.deepStrictEqual(p.replies, [{ content: 'Received', ephemeral: true }]);
    assert.deepStrictEqual(d.dms['222'].sends.pop(), { content: 'Recorded for Lakeside lot.' });

    d.known.add('M-1');
    await d.bridge.handleMessageCreate(d.msg({ content: 'yes', reference: { messageId: 'm-1' } }));
    assert.deepStrictEqual([d.calls[1].correlationId, d.calls[1].answer.text, d.calls[1].meta.ownerProven], ['m-1', 'yes', true]);

    await d.bridge.handleMessageCreate(d.msg({ author: { id: '999', bot: false }, channelId: 'dm-999', content: '#K7QD4M a' }));
    assert.strictEqual(d.calls[2].meta.ownerProven, false, 'a stranger');

    d.dms['222'].fail = Object.assign(new Error('You are being rate limited.'), { status: 429 });
    await assert.rejects(d.bridge.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'rate-limited');
  });

  it('M4: when the DM lookup fails, the owner in a DM channel is still the contact owner; nobody else is', async () => {
    const d = fakeDiscord();
    const { ChannelType } = require('discord.js');
    d.bridge.contactDm = null;
    d.bridge.client.users.fetch = async () => { throw new Error('Discord is having a moment'); };
    await d.bridge.handleMessageCreate(d.msg({ content: '#K7QD4M a', channel: { type: ChannelType.DM } }));
    assert.strictEqual(d.calls[0].meta.ownerProven, true, 'the owner, in a DM');
    assert.deepStrictEqual(d.routed, [], 'never sent down the agent path');
    d.known.add('M-7');
    await d.bridge.handleMessageCreate(d.msg({ content: 'b', reference: { messageId: 'm-7' }, channel: { type: ChannelType.DM } }));
    assert.deepStrictEqual([d.calls[1].correlationId, d.calls[1].meta.ownerProven], ['m-7', true], 'a threaded reply still matches');
    await d.bridge.handleMessageCreate(d.msg({ author: { id: '999', bot: false }, channelId: 'dm-999', content: '#K7QD4M a', channel: { type: ChannelType.DM } }));
    assert.strictEqual(d.calls[2].meta.ownerProven, false, 'another user\'s DM is never the owner');
    await d.bridge.handleMessageCreate(d.msg({ content: '#K7QD4M a', channelId: 'group-1', channel: { type: ChannelType.GroupDM } }));
    assert.strictEqual(d.calls[3].meta.ownerProven, false, 'a group DM is not the contact DM');
    const p = d.press({ channel: { type: ChannelType.DM } });
    await d.bridge.handleInteractionCreate(p.interaction);
    assert.strictEqual(d.calls[4].meta.ownerProven, true, 'a button in the owner DM');
  });

  it('refuses a guild member and a second allowlisted user, and never routes their #TOKEN to the agent', async () => {
    const d = fakeDiscord();
    await d.bridge.handleMessageCreate(d.msg({ author: { id: '333', bot: false }, channelId: 'guild-channel-1', guildId: 'guild-1', content: '#K7QD4M 1 a' }));
    await d.bridge.handleMessageCreate(d.msg({ author: { id: '444', bot: false }, channelId: 'dm-444', content: '#K7QD4M 1 a' }));
    const inGuild = d.press({ guildId: 'guild-1', channelId: 'guild-channel-1' });
    await d.bridge.handleInteractionCreate(inGuild.interaction);
    assert.deepStrictEqual(d.calls.map((c) => c.meta.ownerProven), [false, false, false]);
    assert.deepStrictEqual(inGuild.replies, [{ content: 'Not allowed', ephemeral: true }]);
    assert.deepStrictEqual(d.routed, []);
    assert.deepStrictEqual(d.dms['222'] ? d.dms['222'].sends : [], [], 'no acks');
  });

  it('with contact off it is not a contact channel', async () => {
    const d = fakeDiscord({ enabled: false });
    assert.strictEqual(d.bridge.contactCapabilities(), null);
    await assert.rejects(d.bridge.sendContact(MESSAGE, META), (err) => err.code === 'not-configured');
  });

  // Binding carries from Task 10 (progress.md), Discord side.
  // A router fake like ContactRouter.knows: { ref: true } matches only message references.
  function refAware(d, { enabled = true } = {}) {
    const refs = new Set();
    d.bridge.setContactHost({
      router: { knows: (channel, ref, opts = {}) => channel === 'discord' && (opts.ref ? refs.has(String(ref)) : d.known.has(String(ref).toUpperCase())) },
      getOwnerUserId: () => '222',
      isEnabled: () => enabled
    });
    return refs;
  }
  // A message complete enough for the normal (non-contact) path.
  const full = (d, fields) => d.msg({ mentions: { users: [], has: () => false }, attachments: [], ...fields, author: { username: 'someone', bot: false, ...(fields.author || { id: '222' }) } });

  it('a reply-to id is looked up as a message reference only, never as a token', async () => {
    const d = fakeDiscord();
    refAware(d);
    d.known.add('123456');
    await d.bridge.handleMessageCreate(full(d, { content: 'b', reference: { messageId: '123456', channelId: 'dm-222' } }));
    assert.deepStrictEqual(d.calls, [], 'a token equal to the reply-to id does not make it a contact reply');
    assert.deepStrictEqual(d.routed, [{ chatId: 'dm-222', text: 'b' }]);
  });

  // Review T10 round 2: an explicit #token that resolves wins; the reply-to
  // is then not passed as deliveryRef.
  it('a reply to X carrying the #token of Y answers Y and carries no deliveryRef', async () => {
    const d = fakeDiscord();
    const refs = refAware(d);
    refs.add('m-1');
    await d.bridge.handleMessageCreate(d.msg({ content: '#K7QD4M 2', reference: { messageId: 'm-1', channelId: 'dm-222' } }));
    await d.bridge.handleMessageCreate(d.msg({ content: '2', reference: { messageId: 'm-1', channelId: 'dm-222' } }));
    assert.deepStrictEqual(d.calls.map((c) => [c.correlationId, c.meta.deliveryRef, c.meta.ownerProven]), [['K7QD4M', null, true], ['m-1', 'm-1', true]]);
  });

  // Preflight M17: a reply is a contact reply only in the owner's DM.
  it('a reply to a contact message id outside the owner DM takes the normal path', async () => {
    const d = fakeDiscord();
    const refs = refAware(d);
    refs.add('m-1');
    const ref = { messageId: 'm-1', channelId: 'dm-222' };
    await d.bridge.handleMessageCreate(full(d, { author: { id: '333' }, channelId: 'guild-channel-1', guildId: 'guild-1', content: 'see above', reference: ref }));
    await d.bridge.handleMessageCreate(full(d, { author: { id: '999' }, channelId: 'dm-999', content: 'what?', reference: ref }));
    await d.bridge.handleMessageCreate(full(d, { channelId: 'guild-channel-1', guildId: 'guild-1', content: 'owner in the guild', reference: ref }));
    assert.deepStrictEqual(d.calls, [], 'no reply-id interception outside the owner DM');
    assert.deepStrictEqual(d.routed.map((r) => r.text), ['see above', 'what?', 'owner in the guild']);
  });

  // Review T10 M3, Discord: forwards (reference type Forward, message
  // snapshots, the HasSnapshot flag) and crossposts carry someone else's words.
  it('a forwarded or crossposted message is never owner-proven, and a forward is not a reply', async () => {
    const d = fakeDiscord();
    const refs = refAware(d);
    refs.add('m-1');
    const { Collection } = require('discord.js');
    const fwd = [
      { reference: { type: 1, messageId: 'x-1', channelId: 'other' } },
      { messageSnapshots: new Collection([['x-1', {}]]) },
      { flags: { bitfield: 1 << 14 } },
      { flags: 1 << 1 }
    ];
    for (const f of fwd) await d.bridge.handleMessageCreate(d.msg({ content: '#K7QD4M 1 a', ...f }));
    assert.deepStrictEqual(d.calls.map((c) => c.meta.ownerProven), [false, false, false, false]);
    d.bridge.sendMessage = async () => {};
    await d.bridge.handleMessageCreate(full(d, { content: '', reference: { type: 1, messageId: 'm-1', channelId: 'dm-222' } }));
    assert.strictEqual(d.calls.length, 4, 'forwarding the contact message itself is not a reply to it');
    assert.deepStrictEqual(d.dms['222'] ? d.dms['222'].sends : [], [], 'no ack');
  });

  // Review T10 M4: a live token must not change what a stranger sees.
  it('a stranger who is not allowlisted gets the same notice for a live and a made-up token', async () => {
    const d = fakeDiscord();
    d.bridge.allowlistManager = { isAllowed: (ch, sender) => sender === '222', isAllowedUser: () => false };
    const notices = [];
    d.bridge.sendMessage = async (chatId, text) => { notices.push({ chatId, text: text.replace(/50[12]/g, 'N') }); };
    await d.bridge.handleMessageCreate(full(d, { author: { id: '501' }, channelId: 'dm-501', content: '#K7QD4M 1 a' }));
    await d.bridge.handleMessageCreate(full(d, { author: { id: '502' }, channelId: 'dm-502', content: '#ZZZZZZ 1 a' }));
    assert.deepStrictEqual(notices.map((n) => n.chatId), ['dm-501', 'dm-502']);
    assert.strictEqual(notices[0].text, notices[1].text, 'identical notice either way');
    assert.deepStrictEqual(d.calls.map((c) => c.meta.ownerProven), [false]);
    assert.deepStrictEqual(d.routed, []);
  });

  // C2 channel tagging / M21: contact replies never enter a local chat (and so
  // never an ownerMessages quote); everything else reaches it tagged as before.
  it('an ordinary message reaches the local chat tagged discord; a contact reply never does', async () => {
    const d = fakeDiscord();
    const created = [];
    const added = [];
    d.bridge.createLocalChat = (title, opts) => { created.push({ title, opts }); return 'local-1'; };
    d.bridge.addMessageToLocalChat = (localChatId, sender, text, opts) => { added.push({ localChatId, sender, text, opts }); };

    await d.bridge.handleMessageCreate(full(d, { content: '#K7QD4M 1 a' }));
    assert.strictEqual(d.calls.length, 1);
    assert.deepStrictEqual([created, added, d.routed], [[], [], []], 'the contact reply stays out of every chat');

    await d.bridge.handleMessageCreate(full(d, { content: 'how is the lot going?' }));
    assert.strictEqual(d.calls.length, 1, 'not a contact reply');
    assert.deepStrictEqual(created.map((c) => c.opts), [{ origin: 'discord' }]);
    assert.deepStrictEqual(added, [{ localChatId: 'local-1', sender: 'user', text: 'how is the lot going?', opts: { channel: 'discord' } }]);
    assert.deepStrictEqual(d.routed, [{ chatId: 'dm-222', text: 'how is the lot going?' }]);

    await d.bridge.handleMessageCreate(full(d, { content: '#ZZZZZZ unrelated' }));
    assert.deepStrictEqual(d.routed.map((r) => r.text), ['how is the lot going?', '#ZZZZZZ unrelated'], 'an unknown token is an ordinary message');
  });

  // Owner decision M22: approvals and app-only items are notices, never buttons.
  it('renders buttons only for answerable items', async () => {
    const d = fakeDiscord();
    const notice = { ...ITEM, n: 2, token: 'M2P8RT', kind: 'approval', answerable: false, options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] };
    await d.bridge.sendContact({ ...MESSAGE, items: [notice] }, META);
    await d.bridge.sendContact({ ...MESSAGE, items: [ITEM, notice] }, META);
    const [a, b] = d.dms['222'].sends;
    assert.deepStrictEqual(a.components, [], 'a notice-only batch has no buttons');
    assert.deepStrictEqual(b.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id)), ['kl_q_7QD4KM_0', 'kl_q_7QD4KM_1']);
  });

  it('a button press needs the owner inside the owner DM', async () => {
    const d = fakeDiscord();
    const other = d.press({ user: { id: '444' }, channelId: 'dm-222' });
    await d.bridge.handleInteractionCreate(other.interaction);
    const elsewhere = d.press({ channelId: 'dm-444' });
    await d.bridge.handleInteractionCreate(elsewhere.interaction);
    const bad = d.press({ customId: 'kl_q_7QD4KM_10' });
    await d.bridge.handleInteractionCreate(bad.interaction);
    assert.deepStrictEqual(d.calls.map((c) => c.meta.ownerProven), [false, false]);
    assert.deepStrictEqual([other.replies, elsewhere.replies, bad.replies].map((r) => r[0].content), ['Not allowed', 'Not allowed', 'Unknown action']);
    assert.deepStrictEqual(d.dms['222'].sends, [], 'no acks');
  });

  it('never puts the bot token in an error or a contact log line', async () => {
    const { addSink } = require('../src/logging');
    const lines = [];
    const remove = addSink((r) => { if (r.subsystem === 'discord-bridge') lines.push(r.message); });
    try {
      const d = fakeDiscord();
      d.bridge.token = 'SECRET-BOT-TOKEN';
      await d.bridge.sendContact(MESSAGE, META);
      d.dms['222'].fail = new Error('bad auth SECRET-BOT-TOKEN');
      await assert.rejects(d.bridge.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && !err.message.includes('SECRET-BOT-TOKEN'));
      d.dms['222'].fail = new Error('ack failed for SECRET-BOT-TOKEN');
      await d.bridge.handleInteractionCreate(d.press({}).interaction);
      const line = lines.find((l) => l.startsWith('contact ack failed'));
      assert.ok(line && !line.includes('SECRET-BOT-TOKEN') && line.includes('<bot-token>'), JSON.stringify(lines));
    } finally {
      remove();
    }
  });
});

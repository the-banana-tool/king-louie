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

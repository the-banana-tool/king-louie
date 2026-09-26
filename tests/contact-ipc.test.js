// tests/contact-ipc.test.js — cases stage 4 §5.2 (the five IPC handlers).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../src/ipc/constants');
const { registerContactHandlers } = require('../src/ipc/contact-handlers');
const { CaseRuntime } = require('../src/cases');
const { createContactHost } = require('../src/cases/contact-host');
const { mergeSettings } = require('../src/core/settings');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function setup() {
  let stored = mergeSettings({});
  const runtime = new CaseRuntime({ root: path.join(tmp('kl-contact-ipc-'), 'cases'), host: { interactive: () => true, notify: () => {} } });
  const host = createContactHost({
    getSettings: () => stored, setSettings: (s) => { stored = mergeSettings(s); }, caseRuntime: runtime, dataDir: tmp('kl-contact-ipc-data-'), features: { channels: false }
  });
  const webContents = { id: 1 };
  const handlers = new Map();
  registerContactHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, {
    getContact: () => host.context(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents })
  });
  const main = { sender: webContents };
  return { host, handlers, runtime, settings: () => stored, call: (channel, payload, event = main) => handlers.get(channel)(event, payload) };
}

describe('contact IPC', () => {
  it('registers the five channels', () => {
    const { handlers } = setup();
    const channels = [IPC.CONTACT_LADDER_STATE, IPC.CONTACT_POLICY_GET, IPC.CONTACT_POLICY_SET, IPC.PRESENCE_HEARTBEAT, IPC.PRESENCE_STATUS];
    assert.deepStrictEqual(channels, ['contact:ladderState', 'contactPolicy:get', 'contactPolicy:set', 'presence:heartbeat', 'presence:status']);
    for (const ch of channels) assert.ok(handlers.has(ch), ch);
  });

  it('contactPolicy:get returns the policy and per-channel status; :set validates and saves', async () => {
    const t = setup();
    const got = await t.call(IPC.CONTACT_POLICY_GET);
    assert.strictEqual(got.ok, true);
    assert.strictEqual(got.policy.batchDelaySec, 60);
    assert.deepStrictEqual(Object.keys(got.channels), ['in-app', 'telegram', 'discord', 'email', 'sms', 'voice', 'ntfy', 'mobile']);
    assert.deepStrictEqual(await t.call(IPC.CONTACT_POLICY_SET, { ladders: { high: [{ channel: 'slack' }] } }), { ok: false, error: 'slack is not a contact channel: it has no sender allowlist' });
    assert.deepStrictEqual(await t.call(IPC.CONTACT_POLICY_SET, { quietHours: { start: '22:00', end: '25:00' } }), { ok: false, error: 'quietHours.start and end must be HH:MM' });
    assert.deepStrictEqual(await t.call(IPC.CONTACT_POLICY_SET, 'nope'), { ok: false, error: 'the contact policy must be an object' });
    const saved = await t.call(IPC.CONTACT_POLICY_SET, { quietHours: { start: '22:00', end: '07:00' } });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual(t.settings().contactPolicy.quietHours, { start: '22:00', end: '07:00', breakthrough: ['high'] });
  });

  it('presence:heartbeat is accepted only from the main window, with a checked payload', async () => {
    const t = setup();
    const refused = await t.call(IPC.PRESENCE_HEARTBEAT, { focused: true }, { sender: { id: 99 } });
    assert.deepStrictEqual(refused, { ok: false, error: 'presence:heartbeat is accepted only from the main window or an attached desktop.' });
    assert.deepStrictEqual(await t.call(IPC.PRESENCE_HEARTBEAT, { focused: 'yes' }), { ok: false, error: 'focused must be true or false.' });
    assert.deepStrictEqual(await t.call(IPC.PRESENCE_HEARTBEAT, { focused: true, lastInputAt: new Date().toISOString() }), { ok: true });
    const status = await t.call(IPC.PRESENCE_STATUS);
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.presentChannel, 'in-app');
    assert.strictEqual(status.signals.desktop.focused, true);
  });

  it('contact:ladderState returns the ladder entries', async () => {
    const t = setup();
    const state = await t.call(IPC.CONTACT_LADDER_STATE);
    assert.deepStrictEqual(state, { ok: true, state: {} });
  });

  it('without contact in the host every call fails cleanly', async () => {
    const handlers = new Map();
    registerContactHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getContact: () => null });
    assert.deepStrictEqual(await handlers.get(IPC.PRESENCE_STATUS)({}, {}), { ok: false, error: 'Contact is not available in this host.' });
  });
});

// tests/attached-host-import.test.js — history stage H4, owner ruling R-H4-3:
// attached, the desktop opens and parses the file its owner picked and sends
// the parsed chat to the service in batches. No Electron: a fake ipcMain,
// window, dialog and bridge client.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { startAttachedHost } = require('../src/ipc/attached-host');
const { createPickImportFile } = require('../src/ipc/import-picks');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-attached-import-')); dirs.push(d); return d; };

const BATCH = ['history:import.lookup', 'history:import.begin', 'history:import.append', 'history:import.finish'];

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.service = null;
    this.port = 18796;
    this.invoked = [];
    this.answers = new Map();
    this.total = 0;
  }
  async connect() { return this.service; }
  retryNow() { return Promise.resolve(this.service); }
  close() { this.connected = false; }
  async invoke(channel, args) {
    this.invoked.push([channel, args]);
    if (this.answers.has(channel)) return this.answers.get(channel)(args);
    const payload = args[0] || {};
    if (channel === 'history:import.lookup') return { ok: true, existingChatId: null };
    if (channel === 'history:import.begin') { this.total = 0; return { ok: true, importId: 'import-1', chatId: 'md-lot' }; }
    if (channel === 'history:import.append') { this.total += payload.messages.length; return { ok: true, done: this.total }; }
    if (channel === 'history:import.finish') return { ok: true, chatId: 'md-lot', messages: this.total };
    return { ok: true };
  }
  send() { return true; }
  async call() { return this.service; }
  goLive(channels = BATCH) {
    this.service = { version: '26.9.0', protocol: 1, nodeId: 'kl-abcdefghijklmnop', account: 'LOCAL SERVICE', profile: 'agent', providersConfigured: true, channels };
    this.connected = true;
    this.emit('state', { status: 'connected', code: null, error: null, service: this.service, nextRetryAt: null });
  }
}

function setup({ env = {} } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const window = { isDestroyed: () => false, close: () => {}, webContents: { send: () => {} } };
  const asked = [];
  const dialogAnswers = [];
  const dialog = { showOpenDialog: async (...args) => { asked.push(args); return dialogAnswers.shift() || { canceled: true, filePaths: [] }; } };
  const userDataDir = tmp();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) });
  state.setMode('attached');
  state.setPairing({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service: { nodeId: 'kl-abcdefghijklmnop', publicKey: 'aa', port: 18796, pairedAt: '2026-09-23T14:02:11Z' } });
  const client = new FakeClient();
  const app = { getPath: () => userDataDir, relaunch() {}, exit() {}, quit() {} };
  const host = startAttachedHost({ app, ipcMain, safeStorage, dialog, getWindow: () => window, state, env, platform: 'linux', clientFactory: () => client });
  const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);
  const pick = async (file) => {
    dialogAnswers.push({ canceled: false, filePaths: [file] });
    return call('history:import.pick');
  };
  return { host, handlers, client, call, pick, asked, dialogAnswers };
}

// A Markdown transcript of `turns` user turns and their replies.
function transcript(dir, turns, { name = 'Lakeside lot notes.md', texts = {} } = {}) {
  const lines = ['# Lakeside lot planning', ''];
  for (let i = 0; i < turns; i += 1) {
    lines.push('## User', '', texts[i * 2] || `Question ${i + 1} about the Lakeside lot culvert.`, '');
    lines.push('## Assistant', '', texts[i * 2 + 1] || `Answer ${i + 1}: the culvert stays as it is.`, '');
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

const channelsOf = (client) => client.invoked.map(([ch]) => ch);
const appendsOf = (client) => client.invoked.filter(([ch]) => ch === 'history:import.append').map(([, args]) => args[0]);
const MB = 1024 * 1024;

describe('attached host: importing a conversation', () => {
  it('R-H4-3: a commit while attached sends the parsed chat in batches', async () => {
    const { client, call, pick, asked } = setup();
    client.goLive();
    const dir = tmp();
    const file = transcript(dir, 225);
    const picked = await pick(file);
    assert.strictEqual(picked.ok, true);
    assert.strictEqual(picked.name, 'Lakeside lot notes.md');
    assert.match(picked.token, /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(asked[0].at(-1).properties, ['openFile']);
    assert.deepStrictEqual(asked[0].at(-1).filters, [{ name: 'Conversations', extensions: ['jsonl', 'json', 'md', 'markdown'] }]);

    const preview = await call('history:import.preview', { token: picked.token, path: path.join(dir, 'other.md') });
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.untrustedText, true);
    assert.strictEqual(preview.kind, 'markdown-transcript');
    assert.strictEqual(preview.title, 'Lakeside lot planning');
    assert.strictEqual(preview.turns, 225);
    assert.strictEqual(preview.existingChatId, null);
    assert.strictEqual(preview.serviceUnreachable, undefined);
    assert.strictEqual(preview.sourceHash, undefined);
    assert.deepStrictEqual(channelsOf(client), ['history:import.lookup']);
    assert.match(client.invoked[0][1][0].sourceHash, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(Object.keys(client.invoked[0][1][0]), ['sourceHash']);

    client.invoked.length = 0;
    const out = await call('history:import.commit', { token: picked.token, filePath: path.join(dir, 'other.md') });
    assert.deepStrictEqual(out, { ok: true, chatId: 'md-lot', imported: true, messages: 450, kind: 'markdown-transcript' });
    assert.deepStrictEqual(channelsOf(client), [
      'history:import.begin', 'history:import.append', 'history:import.append', 'history:import.append', 'history:import.finish'
    ]);
    const begin = client.invoked[0][1][0];
    assert.deepStrictEqual(Object.keys(begin).sort(), ['chat', 'importerVersion', 'kind', 'sourceHash', 'sourceName', 'total']);
    assert.strictEqual(begin.kind, 'markdown-transcript');
    assert.strictEqual(begin.sourceName, 'Lakeside lot notes.md');
    assert.strictEqual(begin.total, 450);
    assert.strictEqual(begin.chat.title, 'Lakeside lot planning');
    assert.deepStrictEqual(appendsOf(client).map((a) => a.messages.length), [200, 200, 50]);
    assert.ok(appendsOf(client).every((a) => a.importId === 'import-1'));
    assert.deepStrictEqual(client.invoked.at(-1)[1], [{ importId: 'import-1' }]);
    // The desktop's path never crosses the bridge, in any form.
    const wire = JSON.stringify(client.invoked);
    for (const part of [dir, path.basename(dir), JSON.stringify(dir).slice(1, -1)]) {
      assert.ok(!wire.includes(part), `no call names ${part}`);
    }
    // Spent: the same token imports nothing again.
    assert.strictEqual((await call('history:import.commit', { token: picked.token })).code, 'IMPORT_NO_FILE');
  });

  it('a file the service already has is not sent again', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    client.answers.set('history:import.lookup', () => ({ ok: true, existingChatId: 'md-earlier' }));
    client.answers.set('history:import.begin', () => ({ ok: true, existingChatId: 'md-earlier' }));
    const picked = await pick(transcript(tmp(), 3));
    assert.strictEqual((await call('history:import.preview', { token: picked.token })).existingChatId, 'md-earlier');
    client.invoked.length = 0;
    const out = await call('history:import.commit', { token: picked.token });
    assert.deepStrictEqual(out, { ok: true, chatId: 'md-earlier', imported: false, kind: 'markdown-transcript' });
    assert.deepStrictEqual(channelsOf(client), ['history:import.begin']);
  });

  it('a message over 4 MB goes in a batch of its own, and one over 8 MB is refused before begin', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    const big = `Lakeside lot survey ${'x'.repeat(5 * MB)}`;
    const picked = await pick(transcript(tmp(), 3, { texts: { 3: big } }));
    const out = await call('history:import.commit', { token: picked.token });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(appendsOf(client).map((a) => a.messages.length), [3, 1, 2]);
    assert.strictEqual(appendsOf(client)[1].messages[0].text, big);
    for (const a of appendsOf(client)) assert.ok(JSON.stringify(a.messages).length <= 8 * MB);

    const second = setup();
    second.client.goLive();
    const huge = await second.pick(transcript(tmp(), 3, { texts: { 2: 'y'.repeat(9 * MB) } }));
    const refused = await second.call('history:import.commit', { token: huge.token });
    assert.deepStrictEqual(refused, {
      ok: false, code: 'IMPORT_MESSAGE_TOO_LARGE', error: 'One message of this conversation is too large to send to the service.'
    });
    assert.deepStrictEqual(channelsOf(second.client), []);
  });

  it('small messages are batched under 4 MB of JSON', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    const texts = {};
    for (let i = 0; i < 6; i += 1) texts[i] = `${i} ${'z'.repeat(MB + MB / 2)}`;
    const picked = await pick(transcript(tmp(), 3, { texts }));
    assert.strictEqual((await call('history:import.commit', { token: picked.token })).ok, true);
    assert.deepStrictEqual(appendsOf(client).map((a) => a.messages.length), [2, 2, 2]);
    for (const a of appendsOf(client)) assert.ok(JSON.stringify(a.messages).length <= 4 * MB);
  });

  it('a failed append ends the commit with its error and sends no finish', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    let appends = 0;
    client.answers.set('history:import.append', () => {
      appends += 1;
      return appends === 2 ? { ok: false, code: 'IMPORT_INVALID', error: 'An imported message has a sender this app does not store.' } : { ok: true, done: 200 };
    });
    const picked = await pick(transcript(tmp(), 225));
    const out = await call('history:import.commit', { token: picked.token });
    assert.deepStrictEqual(out, { ok: false, code: 'IMPORT_INVALID', error: 'An imported message has a sender this app does not store.' });
    assert.deepStrictEqual(channelsOf(client), ['history:import.begin', 'history:import.append', 'history:import.append']);
    // The token is kept: the owner can try again without choosing the file.
    client.answers.delete('history:import.append');
    assert.strictEqual((await call('history:import.commit', { token: picked.token })).ok, true);
  });

  it('a begin or finish the service refuses ends the commit with that reply', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    client.answers.set('history:import.begin', () => ({ ok: false, code: 'IMPORT_BUSY', error: 'Another import is running.' }));
    const picked = await pick(transcript(tmp(), 2));
    assert.deepStrictEqual(await call('history:import.commit', { token: picked.token }), { ok: false, code: 'IMPORT_BUSY', error: 'Another import is running.' });
    assert.deepStrictEqual(channelsOf(client), ['history:import.begin']);
    // A reply that is not a begin's is not taken for one.
    client.answers.set('history:import.begin', () => ({ ok: true }));
    const odd = await call('history:import.commit', { token: picked.token });
    assert.strictEqual(odd.ok, false);
    assert.strictEqual(odd.code, 'IMPORT_FAILED');
    assert.ok(!channelsOf(client).includes('history:import.append'));
    client.answers.delete('history:import.begin');
    client.answers.set('history:import.finish', () => ({ ok: false, code: 'IMPORT_INCOMPLETE', error: 'This import ended before all of its messages arrived.' }));
    assert.strictEqual((await call('history:import.commit', { token: picked.token })).code, 'IMPORT_INCOMPLETE');
  });

  it('with the service unreachable the preview is still shown, and a commit says so', async () => {
    const { client, call, pick } = setup();
    const picked = await pick(transcript(tmp(), 3));
    const preview = await call('history:import.preview', { token: picked.token });
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.title, 'Lakeside lot planning');
    assert.strictEqual(preview.existingChatId, null);
    assert.strictEqual(preview.serviceUnreachable, true);
    const out = await call('history:import.commit', { token: picked.token });
    assert.deepStrictEqual(out, { ok: false, code: 'SERVICE_UNREACHABLE', error: 'The local King Louie service is not reachable (127.0.0.1:18796).' });
    assert.deepStrictEqual(client.invoked, []);
    // The connection lost in the middle: the commit ends there.
    client.goLive();
    client.answers.set('history:import.append', () => { client.connected = false; return { ok: true, done: 200 }; });
    const cut = await call('history:import.commit', { token: (await pick(transcript(tmp(), 225))).token });
    assert.strictEqual(cut.code, 'SERVICE_UNREACHABLE');
    assert.ok(!channelsOf(client).includes('history:import.finish'));
  });

  it('a service older than the batch channels answers SERVICE_TOO_OLD', async () => {
    const { client, call, pick } = setup();
    client.goLive(['chat:load', 'history:search']);
    const picked = await pick(transcript(tmp(), 3));
    const out = await call('history:import.commit', { token: picked.token });
    assert.deepStrictEqual(out, {
      ok: false, code: 'SERVICE_TOO_OLD', error: 'The local service (version 26.9.0) does not support history:import.begin. Upgrade the service.'
    });
    assert.deepStrictEqual(client.invoked, []);
    const preview = await call('history:import.preview', { token: picked.token });
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.serviceUnreachable, true);
  });

  it('a made-up token is refused, and so is a second commit while one runs', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    for (const payload of [{ token: 'f'.repeat(32) }, {}, undefined, { token: 7 }, { path: transcript(tmp(), 2) }]) {
      for (const channel of ['history:import.preview', 'history:import.commit']) {
        assert.deepStrictEqual(await call(channel, payload), { ok: false, error: 'Choose the file again.', code: 'IMPORT_NO_FILE' });
      }
    }
    assert.deepStrictEqual(client.invoked, []);
    let release;
    client.answers.set('history:import.begin', () => new Promise((resolve) => { release = () => resolve({ ok: true, importId: 'import-1', chatId: 'md-lot' }); }));
    const first = await pick(transcript(tmp(), 2));
    const second = await pick(transcript(tmp(), 2, { name: 'Other notes.md' }));
    const running = call('history:import.commit', { token: first.token });
    while (!release) await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepStrictEqual(await call('history:import.commit', { token: second.token }), { ok: false, error: 'Another import is running.', code: 'IMPORT_BUSY' });
    release();
    assert.strictEqual((await running).ok, true);
    client.answers.delete('history:import.begin');
    assert.strictEqual((await call('history:import.commit', { token: second.token })).ok, true);
  });

  it('an importer refusal is the reply, and nothing is sent', async () => {
    const { client, call, pick } = setup();
    client.goLive();
    const dir = tmp();
    const file = path.join(dir, 'notes.md');
    fs.writeFileSync(file, '# Lakeside lot\n\nNo conversation here.\n');
    const picked = await pick(file);
    for (const channel of ['history:import.preview', 'history:import.commit']) {
      const out = await call(channel, { token: picked.token });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'IMPORT_UNKNOWN_FORMAT');
      assert.ok(!JSON.stringify(out).includes(path.basename(dir)));
    }
    assert.deepStrictEqual(client.invoked, []);
    assert.deepStrictEqual(await call('history:import.pick'), { ok: false, canceled: true });
  });
});

describe('the picked file under test', () => {
  const picked = path.join(os.tmpdir(), 'notes', 'picked.md');
  const named = path.join(os.tmpdir(), 'notes', 'named.md');
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [picked] }) };

  it('KL_TEST_IMPORT_FILE names the file only when KL_TEST_MODE is set', async () => {
    assert.strictEqual(await createPickImportFile({ dialog, env: { KL_TEST_MODE: '1', KL_TEST_IMPORT_FILE: named } })(), named);
    assert.strictEqual(await createPickImportFile({ dialog, env: { KL_TEST_IMPORT_FILE: named } })(), picked);
    assert.strictEqual(await createPickImportFile({ dialog, env: { KL_TEST_MODE: '', KL_TEST_IMPORT_FILE: named } })(), picked);
    assert.strictEqual(await createPickImportFile({ dialog, env: { KL_TEST_MODE: '1' } })(), picked);
    assert.strictEqual(await createPickImportFile({ dialog: null, env: {} })(), null);
  });

  it('the attached host ignores KL_TEST_IMPORT_FILE without KL_TEST_MODE', async () => {
    const file = transcript(tmp(), 2, { name: 'Named.md' });
    const plain = setup({ env: { KL_TEST_IMPORT_FILE: file } });
    assert.deepStrictEqual(await plain.call('history:import.pick'), { ok: false, canceled: true });
    assert.strictEqual(plain.asked.length, 1);
    const test = setup({ env: { KL_TEST_MODE: '1', KL_TEST_IMPORT_FILE: file } });
    const got = await test.call('history:import.pick');
    assert.strictEqual(got.name, 'Named.md');
    assert.strictEqual(test.asked.length, 0);
  });
});

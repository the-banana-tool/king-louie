// tests/service-cli-models.test.js
// `king-louie-service models` and `profiles` (models spec 2026-09-27 §12):
// the catalog and provider statuses, a refresh, and the profiles headless
// runs resolve through. The catalog fetch is off, so nothing touches the network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main } = require('../src/service/cli');

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdin: Readable.from(['']),
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) }
  };
}

const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });

const t = (provider, model, effort = null) => ({ provider, model, effort });
const SETTINGS = {
  models: {
    catalog: { fetch: false },
    profiles: [
      { id: 'p-a', name: 'Work', kind: 'user', roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } },
      { id: 'p-b', name: 'Cheap', kind: 'user', roles: { main: [t('openai', 'gpt-5.4-mini', 'low')], worker: [], utility: [] } }
    ],
    defaultProfileId: 'p-a'
  }
};

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-models-'));
  createdTempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'chat-data.json'), JSON.stringify({ settings: SETTINGS }));
  return dir;
}
const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8')).settings;
const running = (dir) => fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));

describe('service CLI — models', () => {
  it('status prints the catalog and each provider', async () => {
    const t1 = io();
    assert.strictEqual(await main(['models', 'status', '--data-dir', dataDir()], t1), 0);
    const text = t1.out.join('');
    assert.match(text, /^Catalog: (snapshot|cache|live), \d{4}-\d{2}-\d{2} \(\d+ models\)/m);
    assert.match(text, /Providers:/);
    assert.match(text, /openai\s+not tested/);
  });

  it('refresh refreshes and retests, and refuses while the service runs', async () => {
    const dir = dataDir();
    const ok = io();
    assert.strictEqual(await main(['models', 'refresh', '--data-dir', dir], ok), 0);
    assert.match(ok.out.join(''), /Tested 0 providers\./);
    assert.match(ok.out.join(''), /Catalog:/);
    running(dir);
    const refused = io();
    assert.strictEqual(await main(['models', 'refresh', '--data-dir', dir], refused), 1);
    assert.match(refused.err.join(''), /The service is running/);
  });

  it('refuses an unknown subcommand', async () => {
    const t1 = io();
    assert.strictEqual(await main(['models', 'nope', '--data-dir', dataDir()], t1), 2);
    assert.match(t1.err.join(''), /Usage: king-louie-service models status\|refresh/);
  });
});

describe('service CLI — profiles', () => {
  it('list marks the default and names each main', async () => {
    const t1 = io();
    assert.strictEqual(await main(['profiles', 'list', '--data-dir', dataDir()], t1), 0);
    const text = t1.out.join('');
    assert.match(text, /^\* p-a {2}Work {2}\(user\) {2}main: openai\/gpt-5\.5$/m);
    assert.match(text, /^ {2}p-b {2}Cheap {2}\(user\) {2}main: openai\/gpt-5\.4-mini$/m);
  });

  it('show prints each role\'s models with whether they can be used, by id or name', async () => {
    const t1 = io();
    assert.strictEqual(await main(['profiles', 'show', 'cheap', '--data-dir', dataDir()], t1), 0);
    const text = t1.out.join('');
    assert.match(text, /Cheap \(p-b, user\)/);
    assert.match(text, /openai\/gpt-5\.4-mini @low {2}not usable: No token saved for OpenAI/);
    assert.match(text, /worker: \(none\)/);
  });

  it('set-default writes the default, and refuses while the service runs', async () => {
    const dir = dataDir();
    const t1 = io();
    assert.strictEqual(await main(['profiles', 'set-default', 'p-b', '--data-dir', dir], t1), 0);
    assert.match(t1.out.join(''), /Cheap is now the default profile/);
    assert.strictEqual(readSettings(dir).models.defaultProfileId, 'p-b');
    running(dir);
    const refused = io();
    assert.strictEqual(await main(['profiles', 'set-default', 'p-a', '--data-dir', dir], refused), 1);
    assert.strictEqual(readSettings(dir).models.defaultProfileId, 'p-b');
  });

  it('says so for a missing argument or an unknown profile', async () => {
    const usage = io();
    assert.strictEqual(await main(['profiles', 'show', '--data-dir', dataDir()], usage), 2);
    assert.match(usage.err.join(''), /Usage: king-louie-service profiles/);
    const unknown = io();
    assert.strictEqual(await main(['profiles', 'show', 'Nope', '--data-dir', dataDir()], unknown), 1);
    assert.match(unknown.err.join(''), /No profile "Nope"/);
  });

  it('refuses a name two stored profiles share, and still takes the id', async () => {
    const dir = dataDir();
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));
    data.settings.models.profiles.push({ id: 'p-c', name: 'work', kind: 'user', roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } });
    fs.writeFileSync(path.join(dir, 'chat-data.json'), JSON.stringify(data));
    const ambiguous = io();
    assert.strictEqual(await main(['profiles', 'set-default', 'Work', '--data-dir', dir], ambiguous), 1);
    assert.match(ambiguous.err.join(''), /More than one profile is named "Work" \(p-a, p-c\)\. Use its id\./);
    assert.strictEqual(readSettings(dir).models.defaultProfileId, 'p-a');
    const byId = io();
    assert.strictEqual(await main(['profiles', 'set-default', 'p-c', '--data-dir', dir], byId), 0);
    assert.strictEqual(readSettings(dir).models.defaultProfileId, 'p-c');
  });

  it('is in the help', async () => {
    const t1 = io();
    await main(['help'], t1);
    assert.match(t1.out.join(''), /king-louie-service models status\|refresh/);
    assert.match(t1.out.join(''), /king-louie-service profiles list\|show <id-or-name>\|set-default <id-or-name>/);
  });
});

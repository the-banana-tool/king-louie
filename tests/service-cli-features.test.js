// tests/service-cli-features.test.js
// Remote window plan, task 6 (R-RW-20): `king-louie-service features set`.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { main } = require('../src/service/cli');
const { runFeaturesCommand } = require('../src/service/commands/features');
const { DEFAULT_FEATURES } = require('../src/service/config');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup(serviceJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-features-'));
  dirs.push(root);
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(configDir);
  fs.mkdirSync(dataDir);
  const file = path.join(configDir, 'service.json');
  if (serviceJson !== undefined) fs.writeFileSync(file, typeof serviceJson === 'string' ? serviceJson : `${JSON.stringify(serviceJson, null, 2)}\n`);
  return { configDir, dataDir, file };
}

function capture() {
  let out = '';
  let err = '';
  return {
    io: { stdin: new PassThrough(), stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } },
    out: () => out,
    err: () => err
  };
}

async function run(l, args, { running = null, deps = {} } = {}) {
  const c = capture();
  const [sub, arg, arg2] = args;
  const code = await runFeaturesCommand({ sub, arg, arg2, dataDir: l.dataDir, io: c.io, deps: { configDir: l.configDir, runningServicePid: () => running, ...deps } });
  return { code, out: c.out(), err: c.err() };
}

describe('features set', () => {
  it('rewrites the one key, keeps every other and prints the line changed', async () => {
    const before = {
      profile: 'agent',
      features: { gateway: true, desktopBridge: true, remoteWindow: false },
      ports: { desktopBridge: 18796 },
      contact: { owner: { name: 'Example Owner' } }
    };
    const l = setup(before);
    const { code, out } = await run(l, ['set', 'remoteWindow', 'on']);
    assert.strictEqual(code, 0);
    assert.match(out, /features\.remoteWindow: false -> true/);
    const written = JSON.parse(fs.readFileSync(l.file, 'utf8'));
    assert.deepStrictEqual(written, { ...before, features: { gateway: true, desktopBridge: true, remoteWindow: true } });
    assert.deepStrictEqual(Object.keys(written), Object.keys(before), 'keys keep their order');

    const off = await run(l, ['set', 'remoteWindow', 'off']);
    assert.strictEqual(off.code, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(l.file, 'utf8')).features.remoteWindow, false);
  });

  it('makes the file when a personal node has none yet, with the one key', async () => {
    const l = setup();
    const { code } = await run(l, ['set', 'remoteWindow', 'on']);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(l.file, 'utf8')), { features: { remoteWindow: true } });
  });

  it('writes nothing when the value is already so', async () => {
    const text = '{"features":{"remoteWindow":true}}';
    const l = setup(text);
    const { code, out } = await run(l, ['set', 'remoteWindow', 'on']);
    assert.strictEqual(code, 0);
    assert.match(out, /already true/);
    assert.strictEqual(fs.readFileSync(l.file, 'utf8'), text);
  });

  it('takes remoteWindow alone (R-RW-20): every other feature and an unknown name are refused', async () => {
    assert.ok(Object.hasOwn(DEFAULT_FEATURES, 'remoteWindow'));
    const l = setup({ features: {} });
    assert.strictEqual((await run(l, ['set', 'remoteWindow', 'off'])).code, 0);
    const others = Object.keys(DEFAULT_FEATURES).filter((name) => name !== 'remoteWindow');
    assert.ok(others.includes('gateway') && others.includes('desktopBridge'));
    for (const name of [...others, 'bogus', '__proto__', 'constructor', undefined]) {
      const before = fs.readFileSync(l.file, 'utf8');
      const { code, err } = await run(l, ['set', name, 'on']);
      assert.strictEqual(code, 2, String(name));
      assert.ok(err.length > 0);
      assert.strictEqual(fs.readFileSync(l.file, 'utf8'), before);
    }
  });

  it('refuses a value that is not on or off, and any other subcommand', async () => {
    const l = setup({ features: {} });
    assert.strictEqual((await run(l, ['set', 'remoteWindow', 'true'])).code, 2);
    assert.strictEqual((await run(l, ['set', 'remoteWindow'])).code, 2);
    assert.strictEqual((await run(l, ['list'])).code, 2);
  });

  it('refuses a running node, naming the stop command, and writes nothing', async () => {
    const text = '{"features":{}}';
    const l = setup(text);
    const { code, err } = await run(l, ['set', 'remoteWindow', 'on'], { running: 4242 });
    assert.strictEqual(code, 1);
    assert.match(err, /pid 4242/);
    assert.match(err, /king-louie-service stop/);
    assert.strictEqual(fs.readFileSync(l.file, 'utf8'), text);
  });

  it('refuses remoteWindow on where the profile is not agent; off is always allowed', async () => {
    for (const profile of ['runbook', 'frontdoor']) {
      const text = JSON.stringify({ profile, features: {} });
      const l = setup(text);
      const { code, err } = await run(l, ['set', 'remoteWindow', 'on']);
      assert.strictEqual(code, 1);
      assert.match(err, /remoteWindow needs profile: agent/);
      assert.strictEqual(fs.readFileSync(l.file, 'utf8'), text);
      assert.strictEqual((await run(l, ['set', 'remoteWindow', 'off'])).code, 0);
    }
  });

  it('refuses a service.json it cannot read as an object, and leaves it', async () => {
    for (const text of ['{not json', '[]', '{"features":[]}', '{"features":"on"}']) {
      const l = setup(text);
      const { code, err } = await run(l, ['set', 'remoteWindow', 'on']);
      assert.strictEqual(code, 1, text);
      assert.match(err, /service\.json/);
      assert.strictEqual(fs.readFileSync(l.file, 'utf8'), text);
    }
  });

  it('refuses an elevated prompt under personal hosting; a fleet node is not asked', async () => {
    const text = '{"features":{}}';
    const l = setup(text);
    const personal = { loadNodeConfig: () => ({ hosting: 'personal' }), isAdmin: async () => true };
    const refused = await run(l, ['set', 'remoteWindow', 'on'], { deps: personal });
    assert.strictEqual(refused.code, 1);
    assert.match(refused.err, /not elevated/);
    assert.strictEqual(fs.readFileSync(l.file, 'utf8'), text);
    const asOwner = await run(l, ['set', 'remoteWindow', 'on'], { deps: { ...personal, isAdmin: async () => false } });
    assert.strictEqual(asOwner.code, 0);
    const fleet = await run(l, ['set', 'remoteWindow', 'off'], { deps: { loadNodeConfig: () => ({ hosting: 'service' }), isAdmin: async () => true } });
    assert.strictEqual(fleet.code, 0);
  });

  it('does not make a missing config dir', async () => {
    const l = setup();
    fs.rmSync(l.configDir, { recursive: true });
    const { code, err } = await run(l, ['set', 'remoteWindow', 'on']);
    assert.strictEqual(code, 1);
    assert.match(err, /does not exist/);
    assert.strictEqual(fs.existsSync(l.configDir), false);
  });

  it('words a denied write without the temp path', async () => {
    const l = setup({ features: {} });
    const denied = () => { throw Object.assign(new Error(`EPERM: operation not permitted, open '${l.file}.tmp-abcd1234'`), { code: 'EPERM' }); };
    const { code, err } = await run(l, ['set', 'remoteWindow', 'on'], { deps: { write: denied } });
    assert.strictEqual(code, 1);
    assert.match(err, /EPERM/);
    assert.doesNotMatch(err, /\.tmp-/);
    assert.match(err, /service\.json/);
  });

  it('the CLI routes features and lists it in its help', async () => {
    const usage = capture();
    assert.strictEqual(await main(['features', 'set', 'bogus', 'on'], usage.io), 2);
    assert.match(usage.err(), /bogus/);
    const help = capture();
    await main(['help'], help.io);
    assert.match(help.out(), /features set remoteWindow on\|off/);
  });
});

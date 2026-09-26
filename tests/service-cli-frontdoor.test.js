// tests/service-cli-frontdoor.test.js — fleet stage 4 §3.11, Task 33: the
// admin CLI's own safeguards, against a scripted service on the courier
// (tests/frontdoor-bootstrap.test.js runs the same commands against a real
// front door). Console records land only in the admin config dir, only for
// the pairing the administrator compared, and never rename an enrolled key.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { runFrontDoorCommand, readFrontDoorLink } = require('../src/service/commands/frontdoor');
const { runPair } = require('../src/service/commands/pair');
const { main } = require('../src/service/cli');
const { NodeRegistry } = require('../src/frontdoor/router/node-registry');
const { rawEd25519, nodeFingerprint } = require('../src/frontdoor/protocol/messages');
const { testNodeIdentity } = require('./helpers/fake-phone');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function layout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-frontdoor-'));
  dirs.push(base);
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { base, dataDir, configDir };
}

function streamIo() {
  const text = { out: '', err: '' };
  return { stdin: new PassThrough(), stdout: { write: (s) => { text.out += String(s); return true; } }, stderr: { write: (s) => { text.err += String(s); return true; } }, text };
}

const FD = testNodeIdentity({ nodeName: 'frontdoor' });
const CODE = 'abandon ability able about above absent';

function pendingFor(identity, name, extra = {}) {
  return {
    pairing_id: `pr_${'A'.repeat(22)}`, node_id: identity.nodeId, node_name: name, profile: 'agent',
    public_key: rawEd25519(identity.publicKey), tls_fingerprint: 'c'.repeat(64), replaces: null, ...extra
  };
}

// A scripted service: `replies` maps a method to a value or a function of
// params; every call is recorded.
function fakeCourier(replies) {
  const calls = [];
  return {
    calls,
    stopped: false,
    async call(method, params = {}) {
      calls.push([method, params]);
      const r = replies[method];
      if (r === undefined) throw Object.assign(new Error(`${method} is not scripted`), { code: 'unknown_method' });
      return typeof r === 'function' ? r(params) : r;
    },
    stop() { this.stopped = true; }
  };
}

function service(pending, extra = {}) {
  return fakeCourier({
    'frontdoor.status': { frontdoor_id: FD.nodeId, domain: 'kl.example.com' },
    'frontdoor.code': { code: CODE, expires_at: '2026-09-26T12:10:00.000Z' },
    'frontdoor.pairing': pending,
    'frontdoor.nodes': [],
    'frontdoor.declined': { ok: true },
    'frontdoor.confirmed': { state: 'enrolled' },
    'frontdoor.reload': { nodes: 0 },
    ...extra
  });
}

function consoleFiles(configDir) {
  const dir = NodeRegistry.consoleDir(configDir);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function writeRecord(configDir, identity, name) {
  NodeRegistry.writeConsoleRecord(configDir, {
    node_id: identity.nodeId, node_name: name, profile: 'agent', public_key: rawEd25519(identity.publicKey), tls_fingerprint: 'd'.repeat(64),
    source: 'console', accepted_at: new Date().toISOString(), signed: null, confirmed_by: 'console'
  });
}

// Runs `frontdoor code <name> --confirm`, answering the prompt with `answer`.
async function confirmRun(t, name, courier, answer = 'y') {
  const io = streamIo();
  const running = runFrontDoorCommand({ sub: 'code', arg: name, flags: { confirm: true }, dataDir: t.dataDir, configDir: t.configDir, io, deps: { courier, waitPollMs: 5 } });
  for (let i = 0; i < 400 && !/\[y\/N\] $/.test(io.text.out) && !io.text.err; i += 1) await new Promise((r) => setTimeout(r, 5));
  io.stdin.write(`${answer}\n`);
  return { code: await running, io };
}

describe('frontdoor code --confirm', () => {
  it('writes the console record with the front door id reserved, and confirms', async () => {
    const t = layout();
    const node = testNodeIdentity({ nodeName: 'web-01' });
    const courier = service(pendingFor(node, 'web-01'));
    const { code, io } = await confirmRun(t, 'web-01', courier);
    assert.equal(code, 0, io.text.err);
    assert.match(io.text.out, new RegExp(`^Node web-01 \\(agent\\) fingerprint: ${nodeFingerprint(node.nodeId)}$`, 'm'));
    assert.deepEqual(consoleFiles(t.configDir), [`${node.nodeId}.json`]);
    assert.deepEqual(courier.calls.map(([m]) => m), ['frontdoor.status', 'frontdoor.code', 'frontdoor.pairing', 'frontdoor.nodes', 'frontdoor.confirmed']);
    assert.equal(courier.stopped, true);
  });

  it('refuses a pairing for the front door\'s own key (writeConsoleRecord gets frontdoorId)', async () => {
    const t = layout();
    const courier = service(pendingFor(FD, 'web-01'));
    const { code, io } = await confirmRun(t, 'web-01', courier);
    assert.equal(code, 1);
    assert.match(io.text.err, /reserved_node_id/);
    assert.deepEqual(consoleFiles(t.configDir), []);
    assert.ok(courier.calls.some(([m]) => m === 'frontdoor.declined'));
  });

  it('refuses a key a console record on disk holds under another name (T28-rename), and writes nothing', async () => {
    const t = layout();
    const node = testNodeIdentity({ nodeName: 'web-01' });
    writeRecord(t.configDir, node, 'gpu-box');
    const before = fs.readFileSync(path.join(NodeRegistry.consoleDir(t.configDir), `${node.nodeId}.json`), 'utf8');
    const courier = service(pendingFor(node, 'web-01'));
    const { code, io } = await confirmRun(t, 'web-01', courier);
    assert.equal(code, 1);
    assert.match(io.text.err, /key_enrolled_as_other_name: this node key is already enrolled as "gpu-box"/);
    assert.equal(fs.readFileSync(path.join(NodeRegistry.consoleDir(t.configDir), `${node.nodeId}.json`), 'utf8'), before, 'the gpu-box record is untouched');
    assert.ok(courier.calls.some(([m]) => m === 'frontdoor.declined'));
    assert.ok(!courier.calls.some(([m]) => m === 'frontdoor.confirmed'));
  });

  it('refuses a key the running front door trusts under another name (a phone-enrolled node)', async () => {
    const t = layout();
    const node = testNodeIdentity({ nodeName: 'web-01' });
    const courier = service(pendingFor(node, 'web-01'), { 'frontdoor.nodes': [{ node_id: node.nodeId, node_name: 'gpu-box', source: 'phone' }] });
    const { code, io } = await confirmRun(t, 'web-01', courier);
    assert.equal(code, 1);
    assert.match(io.text.err, /key_enrolled_as_other_name: .*"gpu-box"/);
    assert.deepEqual(consoleFiles(t.configDir), []);
  });

  it('refuses an answer for another name or whose id does not derive from its key', async () => {
    for (const pending of [
      pendingFor(testNodeIdentity(), 'gpu-box'),
      { ...pendingFor(testNodeIdentity(), 'web-01'), node_id: testNodeIdentity().nodeId }
    ]) {
      const t = layout();
      const io = streamIo();
      const code = await runFrontDoorCommand({ sub: 'code', arg: 'web-01', flags: { confirm: true }, dataDir: t.dataDir, configDir: t.configDir, io, deps: { courier: service(pending), waitPollMs: 5 } });
      assert.equal(code, 1);
      assert.match(io.text.err, /malformed pairing/);
      assert.doesNotMatch(io.text.out, /\[y\/N\]/);
      assert.deepEqual(consoleFiles(t.configDir), []);
    }
  });

  it('a replacement removes the older record of the name only after writing, and puts it back when the front door refuses', async () => {
    const t = layout();
    const old = testNodeIdentity({ nodeName: 'web-01' });
    const fresh = testNodeIdentity({ nodeName: 'web-01' });
    writeRecord(t.configDir, old, 'web-01');
    const oldFile = path.join(NodeRegistry.consoleDir(t.configDir), `${old.nodeId}.json`);
    const oldText = fs.readFileSync(oldFile, 'utf8');
    const refusing = service(pendingFor(fresh, 'web-01', { replaces: old.nodeId }), {
      'frontdoor.confirmed': () => {
        // At this point the new record is written and the old one is gone.
        assert.deepEqual(consoleFiles(t.configDir), [`${fresh.nodeId}.json`]);
        throw Object.assign(new Error('the console record does not match'), { code: 'console_record_mismatch' });
      }
    });
    const refused = await confirmRun(t, 'web-01', refusing);
    assert.equal(refused.code, 1);
    assert.match(refused.io.text.out, new RegExp(`This replaces ${nodeFingerprint(old.nodeId)}\\.`));
    assert.match(refused.io.text.err, /refused the enrollment \(console_record_mismatch/);
    assert.deepEqual(consoleFiles(t.configDir), [`${old.nodeId}.json`]);
    assert.equal(fs.readFileSync(oldFile, 'utf8'), oldText);
    assert.ok(refusing.calls.some(([m]) => m === 'frontdoor.reload'));

    const accepting = service(pendingFor(fresh, 'web-01', { replaces: old.nodeId }));
    assert.equal((await confirmRun(t, 'web-01', accepting)).code, 0);
    assert.deepEqual(consoleFiles(t.configDir), [`${fresh.nodeId}.json`]);
  });

  it('a "no" declines the pairing and writes nothing', async () => {
    const t = layout();
    const courier = service(pendingFor(testNodeIdentity(), 'web-01'));
    const { code, io } = await confirmRun(t, 'web-01', courier, 'n');
    assert.equal(code, 1);
    assert.match(io.text.out, /Not enrolled\. Nothing was written\./);
    assert.deepEqual(consoleFiles(t.configDir), []);
    assert.deepEqual(courier.calls.at(-1), ['frontdoor.declined', { pairing_id: `pr_${'A'.repeat(22)}` }]);
  });
});

describe('frontdoor admin commands: arguments and secrets', () => {
  it('names are checked before anything is sent or removed', async () => {
    const t = layout();
    for (const [sub, arg] of [['code', '../evil'], ['code', 'a b'], ['code', 'x'.repeat(65)], ['code', undefined], ['remove-node', '../../etc'], ['remove-node', '']]) {
      const io = streamIo();
      const courier = service(null);
      assert.equal(await runFrontDoorCommand({ sub, arg, dataDir: t.dataDir, configDir: t.configDir, io, deps: { courier } }), 2, `${sub} ${arg}`);
      assert.equal(courier.calls.length, 0);
    }
  });

  it('the pairing code goes to stdout only: never stderr, never a log line', async () => {
    const t = layout();
    const io = streamIo();
    const logged = [];
    const saved = {};
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
      saved[m] = console[m];
      console[m] = (...a) => { logged.push(a.join(' ')); };
    }
    let code;
    try {
      code = await runFrontDoorCommand({ sub: 'code', arg: 'web-01', dataDir: t.dataDir, configDir: t.configDir, io, deps: { courier: service(null) } });
    } finally {
      Object.assign(console, saved);
    }
    assert.equal(code, 0, io.text.err);
    assert.match(io.text.out, new RegExp(`^Pairing code for web-01: ${CODE}$`, 'm'));
    assert.match(io.text.out, /^ {2}king-louie-service pair https:\/\/mcp\.kl\.example\.com$/m);
    assert.doesNotMatch(io.text.err, /abandon/);
    assert.ok(!logged.some((l) => l.includes('abandon')), logged.join('\n'));
  });

  it('a service answer that is not a pairing code is refused, not printed', async () => {
    const t = layout();
    const io = streamIo();
    const courier = service(null, { 'frontdoor.code': { code: '\u001b]0;evil\u0007', expires_at: '2026-09-26T12:10:00.000Z' } });
    assert.equal(await runFrontDoorCommand({ sub: 'code', arg: 'web-01', dataDir: t.dataDir, configDir: t.configDir, io, deps: { courier } }), 1);
    assert.doesNotMatch(io.text.out + io.text.err, /evil/);
  });

  it('without a running service, a courier command says so', async () => {
    const t = layout();
    const io = streamIo();
    assert.equal(await runFrontDoorCommand({ sub: 'nodes', dataDir: t.dataDir, configDir: t.configDir, io, deps: { pollMs: 10 } }), 1);
    assert.match(io.text.err, /The front door service is not running/);
  });

  it('the CLI refuses the front-door flags on other commands', async () => {
    for (const argv of [['doctor', '--confirm'], ['frontdoor', 'nodes', '--confirm'], ['status', '--code', 'x'], ['frontdoor', 'code', 'web-01', '--yes-fingerprint', 'x'], ['relay', 'qr', '--ca-file', 'x']]) {
      const io = streamIo();
      assert.equal(await main(argv, io), 2, argv.join(' '));
      assert.match(io.text.err, /is only valid for/);
    }
  });

  it('link.json is read only as a small regular file with a valid front-door URL and pin', () => {
    const t = layout();
    const dir = path.join(t.dataDir, 'approvals');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'link.json');
    const spki = `sha256/${'A'.repeat(43)}`;
    fs.writeFileSync(file, JSON.stringify({ connected: true, relay_public_url: 'https://mcp.kl.example.com', relay_spki: spki }));
    assert.deepEqual(readFrontDoorLink(t.dataDir), { relay: 'https://mcp.kl.example.com', spki });
    for (const bad of [
      { relay_public_url: 'https://evil.example.com', relay_spki: spki },
      { relay_public_url: 'https://mcp.kl.example.com/x', relay_spki: spki },
      { relay_public_url: 'https://mcp.kl.example.com', relay_spki: null },
      { relay_public_url: 'https://mcp.kl.example.com', relay_spki: spki, pad: 'x'.repeat(70000) }
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.equal(readFrontDoorLink(t.dataDir), null, JSON.stringify(bad).slice(0, 80));
    }
    if (process.platform !== 'win32') {
      const target = path.join(t.base, 'elsewhere.json');
      fs.writeFileSync(target, JSON.stringify({ relay_public_url: 'https://mcp.kl.example.com', relay_spki: spki }));
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      assert.equal(readFrontDoorLink(t.dataDir), null, 'a link is not followed');
    }
  });
});

describe('pair https:// checks its arguments before sending anything', () => {
  it('refuses URLs that are not exactly https://mcp.<domain>[:port], and codes that are not six list words', async () => {
    const t = layout();
    let dialled = 0;
    const lookup = () => { dialled += 1; throw new Error('must not dial'); };
    for (const url of ['https://user@mcp.kl.example.com', 'https://mcp.kl.example.com/pair', 'https://mcp.kl.example.com/?x=1', 'https://mcp.localhost', 'https://mcp', 'https://kl.example.com']) {
      const io = streamIo();
      assert.equal(await runPair({ url, dataDir: t.dataDir, io, flags: { code: CODE }, deps: { lookup, configDir: t.configDir } }), 2, url);
      assert.match(io.text.err, /A front door is reached at https:\/\/mcp\.<domain>/);
    }
    for (const code of ['one two three four five six', 'abandon ability able about above', CODE.split(' ').join(' '.repeat(60)), 'abandon; rm -rf / ability able about above absent']) {
      const io = streamIo();
      assert.equal(await runPair({ url: 'https://mcp.kl.example.com', dataDir: t.dataDir, io, flags: { code }, deps: { lookup, configDir: t.configDir } }), 2, code);
      assert.match(io.text.err, /not a pairing code/);
    }
    assert.equal(dialled, 0);
  });
});

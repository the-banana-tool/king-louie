// `pair wss://…` under `hosting: personal` (personal node spec §6, §8 step 5):
// it writes approvers.relay into node.yaml itself, by text, and starts the
// logon task. Under `hosting: service` it still prints the Next line and
// writes nothing.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { runRelayCommand } = require('../src/service/commands/relay');
const { runPair } = require('../src/service/commands/pair');
const { setNodeYamlRelay } = require('../src/service/node-yaml-edit');
const { startRelay } = require('../src/frontdoor/relay');
const { NodeIdentity } = require('../src/mesh/node-identity');

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

function streamIo() {
  const text = { out: '', err: '' };
  return {
    stdin: new PassThrough(),
    stdout: { write: (s) => { text.out += String(s); return true; } },
    stderr: { write: (s) => { text.err += String(s); return true; } },
    text
  };
}

function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-pair-personal-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { base, dataDir, configDir, yaml: path.join(configDir, 'node.yaml') };
}

const relayConfig = () => ({
  phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 },
  tls: { certFile: 'unused', keyFile: 'unused' }, publicUrl: 'https://kl.example.com:8443', push: {}
});

async function relayWithCode(nodeName) {
  const relayDirs = dirs();
  const relay = await startRelay({ dataDir: relayDirs.dataDir, identity: new NodeIdentity({ nodeName: 'relay' }), useTls: false, config: relayConfig() });
  cleanups.push(() => relay.stop());
  const codeIo = streamIo();
  await runRelayCommand({ sub: 'code', arg: nodeName, dataDir: relayDirs.dataDir, io: codeIo });
  const code = new RegExp(`Pairing code for ${nodeName}: (.+)$`, 'm').exec(codeIo.text.out)[1];
  for (let i = 0; i < 300 && fs.readdirSync(path.join(relayDirs.dataDir, 'relay', 'codes')).length; i += 1) await new Promise((r) => setTimeout(r, 10));
  return { url: `ws://127.0.0.1:${relay.address().mesh.port}`, code };
}

const PERSONAL_HEAD = [
  '# King Louie personal node',
  'name: laptop-node',
  'profile: agent',
  'hosting: personal',
  ''
].join('\n');
const GUI_TAIL = [
  '# the GUI block stays where it is',
  'gui:',
  '  enabled: true',
  ''
].join('\n');

describe('pair under hosting: personal', () => {
  it('personal: writes approvers.relay, keeps the rest of node.yaml byte for byte, starts the task once', async () => {
    const d = dirs();
    const before = `${PERSONAL_HEAD}${GUI_TAIL}`;
    fs.writeFileSync(d.yaml, before);
    const { url, code } = await relayWithCode('laptop-node');
    let starts = 0;
    const io = streamIo();
    const exit = await runPair({ url, dataDir: d.dataDir, io, deps: { useTls: false, code, startNode: () => { starts += 1; return true; } } });
    assert.equal(exit, 0, io.text.err);
    const after = fs.readFileSync(d.yaml, 'utf8');
    assert.equal(after, `${before}approvers:\n  relay: ${url}\n`);
    assert.equal(starts, 1);
    assert.match(io.text.out, new RegExp(`approvers\\.relay set to ${url.replace(/[.]/g, '\\.')} in ${d.yaml.replace(/[\\.]/g, '\\$&')}\\n`));
    assert.doesNotMatch(io.text.out, /\(was /);
    assert.match(io.text.out, /Started KingLouie Node\n/);
    assert.doesNotMatch(io.text.out, /Next: set/);
    assert.equal(fs.existsSync(`${d.yaml}.new`), false);
  });

  it('Review Focus 5: a different relay already set is replaced and the old one printed', async () => {
    const d = dirs();
    const old = 'wss://10.0.0.9:18795';
    const head = `${PERSONAL_HEAD}approvers:\n  # the relay this node pairs with\n`;
    const tail = `\n  request_ttl_s: 120\n${GUI_TAIL}`;
    fs.writeFileSync(d.yaml, `${head}  relay: ${old}${tail}`);
    const { url, code } = await relayWithCode('laptop-node');
    const io = streamIo();
    const exit = await runPair({ url, dataDir: d.dataDir, io, deps: { useTls: false, code, startNode: () => false } });
    assert.equal(exit, 0, io.text.err);
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), `${head}  relay: ${url}${tail}`);
    assert.ok(io.text.out.includes(`approvers.relay set to ${url} in ${d.yaml} (was ${old})\n`), io.text.out);
    assert.match(io.text.out, /The logon task is not registered; run install --personal\n/);
  });

  it('personal: the "running, stop it first" refusal names the schtasks command; a fleet node does not', async () => {
    for (const [yaml, named] of [[PERSONAL_HEAD, true], ['name: fleet-node\nprofile: agent\n', false]]) {
      const d = dirs();
      fs.writeFileSync(d.yaml, yaml);
      // This test process is a live pid.
      fs.writeFileSync(path.join(d.dataDir, 'service.pid'), String(process.pid));
      const io = streamIo();
      const exit = await runPair({ url: 'ws://127.0.0.1:1', dataDir: d.dataDir, io, deps: { useTls: false, code: 'x' } });
      assert.equal(exit, 1);
      assert.match(io.text.err, /The service is running/);
      if (named) assert.ok(io.text.err.includes('schtasks /End /TN "KingLouie Node"'), io.text.err);
      else assert.doesNotMatch(io.text.err, /schtasks/);
    }
  });

  it('service: prints the Next line and writes nothing (unchanged)', async () => {
    const d = dirs();
    const before = '# fleet node\nname: fleet-node\nprofile: agent\n';
    fs.writeFileSync(d.yaml, before);
    const { url, code } = await relayWithCode('fleet-node');
    let starts = 0;
    const io = streamIo();
    const exit = await runPair({ url, dataDir: d.dataDir, io, deps: { useTls: false, code, startNode: () => { starts += 1; return true; } } });
    assert.equal(exit, 0, io.text.err);
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), before);
    assert.equal(starts, 0);
    assert.ok(io.text.out.includes(`Next: set "approvers: { relay: ${url} }" in the admin node.yaml, then start the service.\n`), io.text.out);
    assert.doesNotMatch(io.text.out, /approvers\.relay set to|Started KingLouie Node/);
  });
});

describe('setNodeYamlRelay', () => {
  it('setNodeYamlRelay refuses a url with a newline', () => {
    const d = dirs();
    const before = `${PERSONAL_HEAD}`;
    fs.writeFileSync(d.yaml, before);
    assert.throws(() => setNodeYamlRelay(d.yaml, 'wss://10.0.0.5:18795\nprofile: runbook'), /one plain line/);
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), before);
  });

  it('keeps CRLF line endings, a trailing comment-free file without a final newline, and quoted old values', () => {
    const d = dirs();
    fs.writeFileSync(d.yaml, 'name: n\r\napprovers:\r\n  relay: "wss://10.0.0.9:18795"   # old\r\n  request_ttl_s: 60');
    assert.deepEqual(setNodeYamlRelay(d.yaml, 'wss://10.0.0.5:18795'), { previous: 'wss://10.0.0.9:18795' });
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), 'name: n\r\napprovers:\r\n  relay: wss://10.0.0.5:18795\r\n  request_ttl_s: 60');

    fs.writeFileSync(d.yaml, 'name: n');
    assert.deepEqual(setNodeYamlRelay(d.yaml, 'wss://10.0.0.5:18795'), { previous: null });
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), 'name: n\napprovers:\n  relay: wss://10.0.0.5:18795\n');
  });

  it('adds relay inside an approvers block that has none, at its indentation', () => {
    const d = dirs();
    fs.writeFileSync(d.yaml, 'approvers:\n    request_ttl_s: 60\nname: n\n');
    assert.deepEqual(setNodeYamlRelay(d.yaml, 'wss://10.0.0.5:18795'), { previous: null });
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), 'approvers:\n    relay: wss://10.0.0.5:18795\n    request_ttl_s: 60\nname: n\n');
  });

  it('refuses a flow-style approvers mapping rather than rewrite it', () => {
    const d = dirs();
    const before = 'approvers: { request_ttl_s: 60 }\n';
    fs.writeFileSync(d.yaml, before);
    assert.throws(() => setNodeYamlRelay(d.yaml, 'wss://10.0.0.5:18795'), /block mapping/);
    assert.equal(fs.readFileSync(d.yaml, 'utf8'), before);
  });
});

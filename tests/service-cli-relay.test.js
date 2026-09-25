// tests/service-cli-relay.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { runRelayCommand } = require('../src/service/commands/relay');
const { runPair } = require('../src/service/commands/pair');
const { startRelay } = require('../src/frontdoor/relay');
const { relaySpkiPin } = require('../src/frontdoor/tls');
const { decodeQr } = require('../src/approvals/messages');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { derivePeerId } = require('../src/mesh/mesh-identity');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { JsonFileStore } = require('../src/platform/json-file-store');

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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-relay-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(base, 'config'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { base, dataDir };
}

const relayConfig = (meshHost, extra = {}) => ({
  phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: meshHost, port: 0 },
  tls: { certFile: 'unused', keyFile: 'unused' }, publicUrl: 'https://kl.example.com:8443', push: {}, ...extra
});

describe('relay run', () => {
  it('refuses a wildcard, a hostname and a public mesh host', async () => {
    for (const host of ['0.0.0.0', '::', 'relay.example.com', '8.8.8.8']) {
      const io = streamIo();
      const code = await runRelayCommand({ sub: 'run', dataDir: dirs().dataDir, io, deps: { loadConfig: () => ({ relay: relayConfig(host) }) } });
      assert.equal(code, 1, host);
      assert.match(io.text.err, /relay\.mesh_listen\.host must be a loopback or private IP address until the stage 4 mesh hardening lands/);
    }
  });

  it('says so when there is no relay block', async () => {
    const io = streamIo();
    assert.equal(await runRelayCommand({ sub: 'run', dataDir: dirs().dataDir, io, deps: { loadConfig: () => ({ relay: null }) } }), 1);
    assert.match(io.text.err, /no "relay" block/);
  });

  it('starts, prints a ready line with the fingerprint, and stops on abort', async () => {
    const { dataDir } = dirs();
    const io = streamIo();
    const listeners = () => ['SIGTERM', 'SIGINT', 'message'].map((e) => process.listenerCount(e));
    const before = listeners();
    const controller = new AbortController();
    const running = runRelayCommand({ sub: 'run', dataDir, io, deps: { useTls: false, signal: controller.signal, loadConfig: () => ({ relay: relayConfig('127.0.0.1') }) } });
    for (let i = 0; i < 500 && !io.text.out.includes('"event":"ready"'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const ready = JSON.parse(io.text.out.trim().split('\n').pop());
    assert.match(ready.relay_id, /^kl-[a-z2-7]{16}$/);
    assert.equal(ready.fingerprint, ready.relay_id.slice(3).match(/.{4}/g).join(' '));
    assert.ok(ready.mesh.port > 0 && ready.phone.port > 0);
    assert.notDeepEqual(listeners(), before);
    controller.abort();
    assert.equal(await running, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'service.pid')), false);
    // Stopping removes every stop listener it added.
    assert.deepEqual(listeners(), before);
  });
});

describe('relay code / nodes / remove-node / qr', () => {
  it('code hands what it wrote back to the data dir owner when run as root', async () => {
    const { dataDir } = dirs();
    // Pretend: running as root, on a data dir owned by uid 1000. Record the
    // paths restoreDataDirOwnership is asked to consider (lstat on anything
    // but the data dir fails, so nothing is actually chowned).
    const considered = [];
    const ownership = {
      getuid: () => 0,
      log: { warn: () => {} },
      fsImpl: {
        lstatSync: (p) => {
          if (path.resolve(p) === path.resolve(dataDir)) return { isDirectory: () => true, uid: 1000, gid: 1000 };
          considered.push(path.resolve(p));
          throw Object.assign(new Error('not here'), { code: 'ENOENT' });
        }
      }
    };
    const io = { ...streamIo(), ownership };
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir, io }), 0);
    const codesDir = path.join(dataDir, 'relay', 'codes');
    const file = path.join(codesDir, fs.readdirSync(codesDir)[0]);
    for (const p of [path.join(dataDir, 'relay'), codesDir, file]) assert.ok(considered.includes(path.resolve(p)), p);
  });

  it('code drops a one-time code for the running relay and refuses a taken or bad name', async () => {
    const { dataDir } = dirs();
    const io = streamIo();
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir, io }), 0);
    const code = /Pairing code for web-01: ((?:[a-z]+ ){5}[a-z]+)/.exec(io.text.out)[1];
    const files = fs.readdirSync(path.join(dataDir, 'relay', 'codes'));
    assert.equal(files.length, 1);
    const dropped = JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'codes', files[0]), 'utf8'));
    assert.equal(dropped.code, code);
    assert.equal(dropped.node_name, 'web-01');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dataDir, 'relay', 'codes', files[0])).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(dataDir, 'relay', 'codes')).mode & 0o777, 0o700);
    }
    // The hint says to type the code, never to echo it into shell history.
    assert.doesNotMatch(io.text.out, /echo/);
    assert.match(io.text.out, /type the code when it asks/);
    fs.writeFileSync(path.join(dataDir, 'relay', 'nodes.json'), JSON.stringify({ nodes: [{ node_id: 'kl-aaaaaaaaaaaaaaaa', node_name: 'web-01', public_key: 'x', peer_id: 'kl-x', paired_at: '2026-09-23T18:00:00.000Z' }] }));
    const taken = streamIo();
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir, io: taken }), 1);
    assert.match(taken.text.err, /name_taken/);
    assert.equal(await runRelayCommand({ sub: 'code', arg: 'bad name!', dataDir, io: streamIo() }), 2);

    const nodes = streamIo();
    await runRelayCommand({ sub: 'nodes', dataDir, io: nodes });
    assert.match(nodes.text.out, /^web-01  kl-aaaaaaaaaaaaaaaa  paired 2026-09-23T18:00:00\.000Z$/m);
    fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
    assert.equal(await runRelayCommand({ sub: 'remove-node', arg: 'web-01', dataDir, io: streamIo() }), 1, 'refused while the relay runs');
    fs.rmSync(path.join(dataDir, 'service.pid'));
    assert.equal(await runRelayCommand({ sub: 'remove-node', arg: 'web-01', dataDir, io: streamIo() }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'relay', 'nodes.json'), 'utf8')).nodes, []);
  });

  it('qr prints a kl.relay code with the certificate SPKI pin', async () => {
    const { base, dataDir } = dirs();
    const { cert, key } = MeshIdentity.generateTlsCertificate('relay-test');
    const certFile = path.join(base, 'relay.crt');
    fs.writeFileSync(certFile, cert);
    fs.writeFileSync(path.join(base, 'relay.key'), key);
    const io = streamIo();
    const config = relayConfig('127.0.0.1', { tls: { certFile, keyFile: path.join(base, 'relay.key') } });
    assert.equal(await runRelayCommand({ sub: 'qr', dataDir, io, deps: { loadConfig: () => ({ relay: config }), renderQr: async () => '[QR]' } }), 0);
    const payload = decodeQr(/kl1:\S+/.exec(io.text.out)[0]);
    assert.deepEqual(payload, { t: 'kl.relay', relay: 'https://kl.example.com:8443', relay_spki: relaySpkiPin(cert) });
    assert.match(payload.relay_spki, /^sha256\/[A-Za-z0-9_-]{43}$/);
  });
});

describe('pair against a test relay', () => {
  it('pins the relay with a code from `relay code`, and prints its fingerprint', async () => {
    const relayDirs = dirs();
    const relayIdentity = new NodeIdentity({ nodeName: 'relay' });
    const relay = await startRelay({ dataDir: relayDirs.dataDir, identity: relayIdentity, useTls: false, config: relayConfig('127.0.0.1') });
    cleanups.push(() => relay.stop());
    const codeIo = streamIo();
    await runRelayCommand({ sub: 'code', arg: 'unnamed-node', dataDir: relayDirs.dataDir, io: codeIo });
    const code = /Pairing code for unnamed-node: (.+)$/m.exec(codeIo.text.out)[1];
    for (let i = 0; i < 300 && fs.readdirSync(path.join(relayDirs.dataDir, 'relay', 'codes')).length; i += 1) await new Promise((r) => setTimeout(r, 10));

    const nodeDirs = dirs();
    const io = streamIo();
    const url = `ws://127.0.0.1:${relay.address().mesh.port}`;
    const exit = await runPair({ url, dataDir: nodeDirs.dataDir, io, deps: { useTls: false, code } });
    assert.equal(exit, 0, io.text.err);
    assert.match(io.text.out, new RegExp(`Relay fingerprint: ${relayIdentity.nodeId.slice(3).match(/.{4}/g).join(' ')}`));
    const pin = new JsonFileStore({ dir: nodeDirs.dataDir, name: 'chat-data' }).get('approvals.relay');
    assert.equal(pin.relay_id, relayIdentity.nodeId);
    assert.equal(pin.port, relay.address().mesh.port);
    // Task 22 carry: the pin's peerId must be exactly what the mesh itself
    // derives from the relay's public key, not merely whatever the wire
    // handshake claimed.
    assert.equal(pin.peerId, derivePeerId(pin.publicKey));
    assert.equal(pin.peerId, relayIdentity.peerId);
    assert.deepEqual(relay.nodeHub.nodes().map((n) => n.node_name), ['unnamed-node']);
  });

  it('refuses an unsupported scheme and an empty code', async () => {
    const io = streamIo();
    assert.equal(await runPair({ url: 'ftp://relay.example.com:1', dataDir: dirs().dataDir, io }), 2);
    assert.match(io.text.err, /Unsupported URL scheme/);
    const empty = streamIo();
    empty.stdin.end('');
    assert.equal(await runPair({ url: 'wss://10.0.0.5:18795', dataDir: dirs().dataDir, io: empty }), 2);
    assert.match(empty.text.err, /No pairing code on stdin/);
  });

  it('refuses a relay whose claimed peerId does not match its public key', async () => {
    const relayDirs = dirs();
    const relayIdentity = new NodeIdentity({ nodeName: 'relay' });
    const relay = await startRelay({ dataDir: relayDirs.dataDir, identity: relayIdentity, useTls: false, config: relayConfig('127.0.0.1') });
    cleanups.push(() => relay.stop());
    const codeIo = streamIo();
    // Named 'unnamed-node': the pairing node built by runPair below has no
    // node.yaml, so it identifies itself with the default node name, and a
    // code registered under any other name would be refused for that
    // unrelated reason (name_mismatch) before ever reaching the peerId check.
    await runRelayCommand({ sub: 'code', arg: 'unnamed-node', dataDir: relayDirs.dataDir, io: codeIo });
    const code = /Pairing code for unnamed-node: (.+)$/m.exec(codeIo.text.out)[1];
    for (let i = 0; i < 300 && fs.readdirSync(path.join(relayDirs.dataDir, 'relay', 'codes')).length; i += 1) await new Promise((r) => setTimeout(r, 10));

    // Forge the relay's own advertised peerId (as if a MITM or a bug on the
    // relay's side sent one that does not derive from its public key).
    const original = relayIdentity.getPublicIdentity.bind(relayIdentity);
    relayIdentity.getPublicIdentity = () => ({ ...original(), peerId: 'kl-0000000000000000' });

    const nodeDirs = dirs();
    const io = streamIo();
    const url = `ws://127.0.0.1:${relay.address().mesh.port}`;
    const exit = await runPair({ url, dataDir: nodeDirs.dataDir, io, deps: { useTls: false, code } });
    assert.equal(exit, 1);
    assert.match(io.text.err, /peer id does not match its public key/);
    const pin = new JsonFileStore({ dir: nodeDirs.dataDir, name: 'chat-data' }).get('approvals.relay');
    assert.equal(pin, undefined);
  });
});

describe('pair over TLS (the relay proves its certificate)', () => {
  // A TLS relay whose phone API serves the relay identity's own certificate,
  // with a fresh code for the default node name, and an optional change to
  // what it claims about itself during pairing.
  async function tlsRelay(claim = (id) => id) {
    const relayDirs = dirs();
    const relayIdentity = new NodeIdentity({ nodeName: 'relay' });
    const certFile = path.join(relayDirs.base, 'relay.crt');
    const keyFile = path.join(relayDirs.base, 'relay.key');
    fs.writeFileSync(certFile, relayIdentity.tlsCert);
    fs.writeFileSync(keyFile, relayIdentity.tlsKey);
    const relay = await startRelay({ dataDir: relayDirs.dataDir, identity: relayIdentity, useTls: true, config: relayConfig('127.0.0.1', { tls: { certFile, keyFile } }) });
    cleanups.push(() => relay.stop());
    const codeIo = streamIo();
    await runRelayCommand({ sub: 'code', arg: 'unnamed-node', dataDir: relayDirs.dataDir, io: codeIo });
    const code = /Pairing code for unnamed-node: (.+)$/m.exec(codeIo.text.out)[1];
    for (let i = 0; i < 300 && fs.readdirSync(path.join(relayDirs.dataDir, 'relay', 'codes')).length; i += 1) await new Promise((r) => setTimeout(r, 10));
    const original = relayIdentity.getPublicIdentity.bind(relayIdentity);
    relayIdentity.getPublicIdentity = () => claim(original());
    return { relay, relayIdentity, code, url: `wss://127.0.0.1:${relay.address().mesh.port}` };
  }

  const pinOf = (dataDir) => new JsonFileStore({ dir: dataDir, name: 'chat-data' }).get('approvals.relay');

  it('pins the served certificate, and asks for the code when stdin is a terminal', async () => {
    const { relayIdentity, code, url } = await tlsRelay();
    const nodeDirs = dirs();
    const io = streamIo();
    io.stdin.isTTY = true;
    const running = runPair({ url, dataDir: nodeDirs.dataDir, io });
    for (let i = 0; i < 300 && !/Pairing code/.test(io.text.out); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.match(io.text.out, /Pairing code \(from `relay code` on the relay host\): /);
    io.stdin.write(`${code}\n`);
    assert.equal(await running, 0, io.text.err);
    assert.equal(pinOf(nodeDirs.dataDir).tlsFingerprint, relayIdentity.tlsFingerprint);
  });

  it('refuses a relay that claims a certificate other than the one it serves', async () => {
    const { code, url } = await tlsRelay((id) => ({ ...id, tlsFingerprint: 'ab'.repeat(32) }));
    const nodeDirs = dirs();
    const io = streamIo();
    assert.equal(await runPair({ url, dataDir: nodeDirs.dataDir, io, deps: { code } }), 1);
    assert.match(io.text.err, /certificate the relay served does not match the fingerprint it claimed/);
    // The relay already recorded the node: the operator is told how to retry.
    assert.match(io.text.err, /relay remove-node unnamed-node` before trying again/);
    assert.equal(pinOf(nodeDirs.dataDir), undefined);
  });

  it('refuses, storing nothing, when the served certificate cannot be read', async () => {
    const { code, url } = await tlsRelay();
    const nodeDirs = dirs();
    const io = streamIo();
    // As if the socket exposed no peer certificate (no _socket, no
    // getPeerCertificate, or an empty raw): nothing to check the claim against.
    const original = MeshPairing.prototype.acceptCode;
    MeshPairing.prototype.acceptCode = async function stubbed(...args) {
      return { ...(await original.apply(this, args)), servedTlsFingerprint: null };
    };
    try {
      assert.equal(await runPair({ url, dataDir: nodeDirs.dataDir, io, deps: { code } }), 1);
    } finally {
      MeshPairing.prototype.acceptCode = original;
    }
    assert.match(io.text.err, /could not read the certificate the relay served/);
    assert.equal(pinOf(nodeDirs.dataDir), undefined);
  });

  it('refuses a relay that claims no TLS fingerprint at all', async () => {
    const { code, url } = await tlsRelay((id) => ({ ...id, tlsFingerprint: null }));
    const nodeDirs = dirs();
    const io = streamIo();
    assert.equal(await runPair({ url, dataDir: nodeDirs.dataDir, io, deps: { code } }), 1);
    assert.match(io.text.err, /did not present a TLS fingerprint/);
    assert.equal(pinOf(nodeDirs.dataDir), undefined);
  });
});

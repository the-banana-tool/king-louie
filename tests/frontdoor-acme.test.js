// tests/frontdoor-acme.test.js — fleet stage 4 §3.3, R21.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcmeManager, CHECK_EVERY_MS, createAcmeAdapter } = require('../src/frontdoor/tls/acme');
const { OperatorTls } = require('../src/frontdoor/tls/operator-tls');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { relaySpkiPin } = require('../src/frontdoor/tls');
const { createCa, issueCert, selfSigned } = require('./helpers/test-certs');
const { setLogLevel, getLogLevel, addSink } = require('../src/logging');

setLogLevel('fatal');
const DAY = 86400000;
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-acme-')); temps.push(d); return d; };
const ca = createCa();

function fakeAcme({ lifetimeDays = 90, fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    factory: () => ({
      async issue({ commonName, keyPem, onChallenge, onChallengeDone }) {
        calls.push({ commonName, keySpki: crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' }).toString('hex') });
        const challenge = selfSigned({ commonName });
        onChallenge(commonName, challenge);
        calls.at(-1).challengeServed = true;
        onChallengeDone(commonName);
        const failure = fail();
        if (failure) throw (failure instanceof Error ? failure : new Error('urn:ietf:params:acme:error:connection'));
        const t = clock.now;
        return issueCert(ca, { dnsNames: [commonName], keyPem, notBefore: t, notAfter: t + lifetimeDays * DAY }).cert + ca.cert;
      }
    })
  };
}
const clock = { now: Date.parse('2026-09-23T00:00:00.000Z') };
const alertsSink = () => ({ raised: [], raise(kind, opts) { this.raised.push([kind, opts]); return { id: String(this.raised.length) }; } });

function manager({ dir = tmp(), acme = fakeAcme(), alerts = alertsSink(), key = crypto.randomBytes(32), cipher = createAesGcmCipher(key) } = {}) {
  const m = new AcmeManager({
    domain: 'kl.example.com', email: null, directoryUrl: 'https://acme.example.com/directory', termsAgreed: true,
    dir, cipher, alerts, now: () => clock.now, adapterFactory: acme.factory
  });
  return { m, dir, acme, alerts, key };
}

const newKeyPem = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const pinOfKey = (pem) => `sha256/${crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('base64url')}`;
const storedKeyPin = (file, key) => pinOfKey(createAesGcmCipher(key).decryptString(JSON.parse(fs.readFileSync(file, 'utf8')).key));
const writeStoredKey = (file, key, pem) => fs.writeFileSync(file, JSON.stringify({ v: 1, key: createAesGcmCipher(key).encryptString(pem) }));
const writeStoredCert = (file, chain) => fs.writeFileSync(file, JSON.stringify({ v: 1, chain }));

// Captures every log record at trace level without printing it.
function captureLogs() {
  const records = [];
  const level = getLogLevel();
  const saved = {};
  for (const fn of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { saved[fn] = console[fn]; console[fn] = () => {}; }
  const remove = addSink((r) => records.push(r));
  setLogLevel('trace');
  return {
    records,
    text: () => records.map((r) => r.line).join('\n'),
    restore() { remove(); setLogLevel(level); Object.assign(console, saved); }
  };
}

describe('AcmeManager', () => {
  it('first start issues with a new P-256 key; mcp. has no context before that', async () => {
    const { m, acme, dir } = manager();
    assert.equal(m.currentContext(), null);
    await m.start();
    assert.ok(m.currentContext());
    assert.equal(acme.calls.length, 1);
    assert.equal(acme.calls[0].commonName, 'mcp.kl.example.com');
    assert.ok(acme.calls[0].challengeServed);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'cert-key.json'), 'utf8'));
    assert.ok(!stored.key.includes('PRIVATE KEY'), 'the key is stored encrypted');
    const account = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
    assert.ok(!account.key.includes('PRIVATE KEY'), 'the account key is stored encrypted');
    assert.equal(m.leafSpki(), relaySpkiPin(m.certificate().chain));
    m.stop();
  });

  it('writes its files owner-only where the platform has modes', { skip: process.platform === 'win32' && 'no POSIX modes on Windows' }, async () => {
    const { m, dir } = manager();
    await m.start();
    await m.rotateKey();
    m.stop();
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const f of ['account.json', 'cert-key.json', 'cert.json']) {
      assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    }
  });

  it('renews at a third of the lifetime left, with the same key, so every phone pin survives', async () => {
    const { m, acme, dir, key } = manager();
    await m.start();
    const spki = m.leafSpki();
    clock.now += 59 * DAY;
    await m.check();
    assert.equal(acme.calls.length, 1, 'not yet: more than a third left');
    clock.now += 2 * DAY;
    await m.check();
    assert.equal(acme.calls.length, 2);
    assert.equal(acme.calls[1].keySpki, acme.calls[0].keySpki);
    assert.equal(m.leafSpki(), spki);
    m.stop();
    const restarted = manager({ dir, acme, key }).m;
    await restarted.start();
    assert.equal(restarted.leafSpki(), spki, 'a restart keeps the key and the certificate');
    assert.equal(acme.calls.length, 2, 'a restart with a fresh certificate does not issue');
    restarted.stop();
  });

  it('a failing renewal keeps serving the old certificate and alerts at T-21 d', async () => {
    let failing = false;
    const acme = fakeAcme({ fail: () => failing });
    const { m, alerts } = manager({ acme });
    await m.start();
    const context = m.currentContext();
    failing = true;
    clock.now += 61 * DAY;
    await m.check();
    assert.equal(m.currentContext(), context);
    assert.equal(alerts.raised.length, 0, 'more than 21 days left: no alert yet');
    assert.equal(m.status().failures, 1);
    clock.now += 50 * DAY;
    await m.check({ ignoreBackoff: true });
    assert.equal(alerts.raised.at(-1)[0], 'acme_renewal_failing');
    assert.equal(alerts.raised.at(-1)[1].subject, 'mcp.kl.example.com');
    failing = false;
    await m.reload();
    assert.notEqual(m.currentContext(), context);
    assert.equal(m.status().failures, 0);
    m.stop();
  });

  it('backs off 1 h, 2 h, 4 h, then 12 h after failures; SIGHUP (reload) retries at once', async () => {
    const acme = fakeAcme({ fail: () => true });
    const { m } = manager({ acme });
    await m.start();
    const t0 = clock.now;
    const next = () => Date.parse(m.status().next_attempt_at) - clock.now;
    assert.equal(next(), 3600000);
    await m.check();
    assert.equal(acme.calls.length, 1, 'inside the backoff: no attempt');
    clock.now = t0 + 3600000;
    await m.check();
    assert.equal(next(), 7200000);
    clock.now += 7200000;
    await m.check();
    assert.equal(next(), 14400000);
    clock.now += 14400000;
    await m.check();
    assert.equal(next(), CHECK_EVERY_MS);
    const before = acme.calls.length;
    await m.reload();
    assert.equal(acme.calls.length, before + 1);
    m.stop();
  });

  it('an undecryptable certificate key refuses to start and is never regenerated (Review Focus 2)', async () => {
    const { m, dir } = manager();
    await m.start();
    m.stop();
    const keyFile = path.join(dir, 'cert-key.json');
    const before = fs.readFileSync(keyFile, 'utf8');
    const wrongKey = manager({ dir, key: crypto.randomBytes(32) }).m;
    await assert.rejects(wrongKey.start(), (err) => err.message.includes(keyFile) && /cannot be decrypted/.test(err.message) && /new key/.test(err.message));
    assert.equal(fs.readFileSync(keyFile, 'utf8'), before);
    fs.writeFileSync(keyFile, '{ not json');
    await assert.rejects(manager({ dir }).m.start(), (err) => err.message.includes(keyFile) && /cannot be decrypted/.test(err.message));
    assert.equal(fs.readFileSync(keyFile, 'utf8'), '{ not json');
    fs.rmSync(keyFile);
    await assert.rejects(manager({ dir }).m.start(), /cert\.json exists but cert-key\.json does not/);
    assert.ok(!fs.existsSync(keyFile));
  });

  it('a certificate for a key other than the stable key is never installed', async () => {
    const other = newKeyPem();
    const acme = { calls: [], factory: () => ({ async issue({ commonName }) { return issueCert(ca, { dnsNames: [commonName], keyPem: other }).cert; } }) };
    const { m, dir } = manager({ acme });
    await m.start();
    assert.equal(m.currentContext(), null);
    assert.equal(m.status().failures, 1);
    assert.match(m.status().last_error, /different key/);
    assert.ok(!fs.existsSync(path.join(dir, 'cert.json')));
    m.stop();
  });

  it('challenge contexts are served for mcp.<domain> only', async () => {
    let seen = null;
    const acme = {
      calls: [],
      factory: () => ({
        async issue({ commonName, keyPem, onChallenge, onChallengeDone }) {
          onChallenge('evil.example.com', selfSigned({ commonName: 'evil.example.com' }));
          onChallenge(commonName, selfSigned({ commonName }));
          seen = { mcp: m.challengeFor('mcp.kl.example.com'), evil: m.challengeFor('evil.example.com'), mesh: m.challengeFor('mesh.kl.example.com') };
          onChallengeDone(commonName);
          return issueCert(ca, { dnsNames: [commonName], keyPem, notBefore: clock.now, notAfter: clock.now + 90 * DAY }).cert;
        }
      })
    };
    const { m } = manager({ acme });
    await m.start();
    assert.ok(seen.mcp, 'the mcp. challenge is served while it is live');
    assert.equal(seen.evil, null);
    assert.equal(seen.mesh, null);
    assert.equal(m.challengeFor('mcp.kl.example.com'), null, 'gone once the challenge is done');
    m.stop();
  });

  it('rotateKey issues with a new key and reports both pins', async () => {
    const { m, acme, dir } = manager();
    await m.start();
    const events = [];
    m.on('rotated', (e) => events.push(e));
    const old = m.leafSpki();
    const r = await m.rotateKey();
    assert.equal(r.oldSpki, old);
    assert.notEqual(r.newSpki, old);
    assert.equal(m.leafSpki(), r.newSpki);
    assert.notEqual(acme.calls[1].keySpki, acme.calls[0].keySpki);
    assert.deepEqual(events, [r]);
    assert.ok(!fs.existsSync(path.join(dir, 'cert-key.next.json')));
    m.stop();
  });

  it('a rotation whose issuance fails keeps the old key and certificate', async () => {
    let failing = false;
    const { m, dir, key } = manager({ acme: fakeAcme({ fail: () => failing }) });
    await m.start();
    const old = m.leafSpki();
    failing = true;
    await assert.rejects(m.rotateKey(), /old key and certificate stay/);
    assert.equal(m.leafSpki(), old);
    assert.ok(!fs.existsSync(path.join(dir, 'cert-key.next.json')));
    assert.equal(storedKeyPin(path.join(dir, 'cert-key.json'), key), old);
    m.stop();
  });

  describe('a crash mid-rotation leaves the old key or the new key, never neither', () => {
    async function started() {
      const s = manager();
      await s.m.start();
      s.m.stop();
      s.files = { key: path.join(s.dir, 'cert-key.json'), next: path.join(s.dir, 'cert-key.next.json'), cert: path.join(s.dir, 'cert.json') };
      s.oldSpki = s.m.leafSpki();
      return s;
    }
    const restart = async (s) => { const r = manager({ dir: s.dir, key: s.key, acme: s.acme }).m; await r.start(); r.stop(); return r; };

    it('after the new key is written, before a certificate for it: the old key stays', async () => {
      const s = await started();
      writeStoredKey(s.files.next, s.key, newKeyPem());
      const r = await restart(s);
      assert.equal(r.leafSpki(), s.oldSpki);
      assert.equal(storedKeyPin(s.files.key, s.key), s.oldSpki);
      assert.ok(!fs.existsSync(s.files.next), 'the unfinished rotation is discarded');
      assert.equal(s.acme.calls.length, 1, 'no issuance: the old certificate is still good');
    });

    it('after cert.json is written for the new key: the rotation completes', async () => {
      const s = await started();
      const next = newKeyPem();
      writeStoredKey(s.files.next, s.key, next);
      writeStoredCert(s.files.cert, issueCert(ca, { dnsNames: ['mcp.kl.example.com'], keyPem: next, notBefore: clock.now, notAfter: clock.now + 90 * DAY }).cert);
      const r = await restart(s);
      assert.equal(r.leafSpki(), pinOfKey(next));
      assert.equal(storedKeyPin(s.files.key, s.key), pinOfKey(next));
      assert.ok(!fs.existsSync(s.files.next));
      assert.equal(s.acme.calls.length, 1);
    });

    it('after the new key is promoted, before the next file is removed: the new key stays', async () => {
      const s = await started();
      const next = newKeyPem();
      writeStoredKey(s.files.next, s.key, next);
      writeStoredKey(s.files.key, s.key, next);
      writeStoredCert(s.files.cert, issueCert(ca, { dnsNames: ['mcp.kl.example.com'], keyPem: next, notBefore: clock.now, notAfter: clock.now + 90 * DAY }).cert);
      const r = await restart(s);
      assert.equal(r.leafSpki(), pinOfKey(next));
      assert.ok(!fs.existsSync(s.files.next));
    });

    it('rotateKey writes cert.json before it replaces the key: a failure at the promotion recovers to the new key', async () => {
      const key = crypto.randomBytes(32);
      const real = createAesGcmCipher(key);
      let armed = 0;
      const cipher = { ...real, encryptString(p) { if (armed && (armed -= 1) === 0) throw new Error('simulated crash'); return real.encryptString(p); } };
      const s = manager({ key, cipher });
      await s.m.start();
      armed = 2; // the first encrypt writes cert-key.next.json; the second would replace cert-key.json
      await assert.rejects(s.m.rotateKey(), /simulated crash/);
      s.m.stop();
      const nextFile = path.join(s.dir, 'cert-key.next.json');
      assert.ok(fs.existsSync(nextFile), 'the new key is kept for recovery');
      const newSpki = storedKeyPin(nextFile, key);
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'cert.json'), 'utf8')).spki, newSpki);
      const r = manager({ dir: s.dir, key, acme: s.acme }).m;
      await r.start();
      assert.equal(r.leafSpki(), newSpki);
      assert.equal(storedKeyPin(path.join(s.dir, 'cert-key.json'), key), newSpki);
      r.stop();
    });

    it('an undecryptable next key refuses to start, naming the file, and changes nothing', async () => {
      const s = await started();
      writeStoredKey(s.files.next, crypto.randomBytes(32), newKeyPem());
      const before = [s.files.key, s.files.next, s.files.cert].map((f) => fs.readFileSync(f, 'utf8'));
      await assert.rejects(manager({ dir: s.dir, key: s.key }).m.start(), (err) => err.message.includes(s.files.next) && /cannot be decrypted/.test(err.message));
      assert.deepEqual([s.files.key, s.files.next, s.files.cert].map((f) => fs.readFileSync(f, 'utf8')), before);
    });
  });

  it('never logs key material, and CA errors reach neither logs, status() nor alerts with secrets in them', async () => {
    const leakedPem = newKeyPem();
    const token = crypto.randomBytes(32).toString('base64url');
    let failing = false;
    const acme = fakeAcme({ fail: () => failing && new Error(`order failed: ${leakedPem} keyAuthorization=${token}.${token}`) });
    const logs = captureLogs();
    try {
      const { m, dir, key, alerts } = manager({ acme });
      await m.start();
      await m.rotateKey();
      failing = true;
      clock.now += 80 * DAY;
      await m.check();
      const text = `${logs.text()}\n${JSON.stringify(m.status())}\n${JSON.stringify(alerts.raised)}`;
      const cipher = createAesGcmCipher(key);
      const certKey = cipher.decryptString(JSON.parse(fs.readFileSync(path.join(dir, 'cert-key.json'), 'utf8')).key);
      const accountKey = cipher.decryptString(JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8')).key);
      assert.ok(logs.records.length > 0);
      assert.equal(alerts.raised[0][0], 'acme_renewal_failing');
      assert.match(m.status().last_error, /order failed/);
      assert.doesNotMatch(text, /PRIVATE KEY/);
      for (const secret of [token, leakedPem, certKey, accountKey]) {
        const body = secret.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
        assert.ok(!text.includes(body.slice(0, 40)), 'no secret material');
      }
      m.stop();
    } finally {
      logs.restore();
    }
  });
});

describe('createAcmeAdapter', () => {
  const realAcme = require('acme-client');
  const authz = (type) => ({ identifier: { value: 'mcp.kl.example.com' }, challenges: [{ type }] });

  function fakeLib(challengeType, seen) {
    return {
      setLogger: realAcme.setLogger,
      crypto: realAcme.crypto,
      Client: class {
        constructor(opts) { seen.client = opts; }
        async auto(opts) {
          seen.auto = opts;
          const a = authz(challengeType);
          await opts.challengeCreateFn(a, a.challenges[0], 'token.thumbprint');
          await opts.challengeRemoveFn(a, a.challenges[0], 'token.thumbprint');
          return 'CHAIN';
        }
      }
    };
  }

  it('asks for tls-alpn-01 only, skips the self-check and serves the challenge certificate', async () => {
    const seen = {};
    const adapter = createAcmeAdapter({ directoryUrl: 'https://acme.example.com/directory', accountKeyPem: newKeyPem(), termsAgreed: true, acme: fakeLib('tls-alpn-01', seen) });
    const served = [];
    const chain = await adapter.issue({
      commonName: 'mcp.kl.example.com', keyPem: newKeyPem(),
      onChallenge: (name, c) => served.push(['on', name, c]), onChallengeDone: (name) => served.push(['done', name])
    });
    assert.equal(chain, 'CHAIN');
    assert.deepEqual(seen.auto.challengePriority, ['tls-alpn-01']);
    assert.equal(seen.auto.skipChallengeVerification, true);
    assert.equal(seen.auto.termsOfServiceAgreed, true);
    assert.equal(seen.auto.email, undefined);
    assert.equal(seen.client.directoryUrl, 'https://acme.example.com/directory');
    assert.equal(served[0][1], 'mcp.kl.example.com');
    assert.ok(new crypto.X509Certificate(served[0][2].cert));
    assert.deepEqual(served[1], ['done', 'mcp.kl.example.com']);
  });

  it('refuses any other challenge type', async () => {
    const adapter = createAcmeAdapter({ directoryUrl: 'https://acme.example.com/directory', accountKeyPem: newKeyPem(), acme: fakeLib('http-01', {}) });
    await assert.rejects(adapter.issue({ commonName: 'mcp.kl.example.com', keyPem: newKeyPem(), onChallenge() { assert.fail('served'); }, onChallengeDone() {} }), /only tls-alpn-01/);
  });

  it("routes acme-client's own log lines to debug with nonces and tokens redacted", () => {
    createAcmeAdapter({ directoryUrl: 'https://acme.example.com/directory', accountKeyPem: newKeyPem() });
    const logs = captureLogs();
    try {
      const nonce = crypto.randomBytes(32).toString('base64url');
      require('acme-client/src/logger').log(`Using nonce: ${nonce}`);
      const line = logs.records.find((r) => r.subsystem === 'frontdoor/acme');
      assert.equal(line.level, 'debug');
      assert.match(line.message, /Using nonce/);
      assert.ok(!line.message.includes(nonce));
    } finally {
      logs.restore();
    }
  });
});

describe('OperatorTls', () => {
  it('serves the operator files and raises tls_key_changed when the leaf SPKI changes', async () => {
    const dir = tmp();
    const write = (c) => { fs.writeFileSync(path.join(dir, 'mcp.pem'), c.cert); fs.writeFileSync(path.join(dir, 'mcp.key'), c.key); };
    const first = issueCert(ca, { dnsNames: ['mcp.kl.example.com'] });
    write(first);
    const alerts = alertsSink();
    const t = new OperatorTls({ host: 'mcp.kl.example.com', certFile: path.join(dir, 'mcp.pem'), keyFile: path.join(dir, 'mcp.key'), alerts });
    t.start();
    assert.ok(t.currentContext());
    assert.equal(t.challengeFor('mcp.kl.example.com'), null);
    assert.equal(t.leafSpki(), relaySpkiPin(first.cert));
    const renewedSameKey = issueCert(ca, { dnsNames: ['mcp.kl.example.com'], keyPem: first.key });
    write({ cert: renewedSameKey.cert, key: first.key });
    t.reload();
    assert.equal(alerts.raised.length, 0);
    const logs = captureLogs();
    try {
      write(issueCert(ca, { dnsNames: ['mcp.kl.example.com'] }));
      t.reload();
      assert.ok(logs.records.some((r) => r.level === 'error' && /re-pin/.test(r.message)), 'logged at error');
    } finally {
      logs.restore();
    }
    assert.equal(alerts.raised[0][0], 'tls_key_changed');
    assert.equal(alerts.raised[0][1].subject, 'mcp.kl.example.com');
    assert.equal(t.status().source, 'operator');
    await assert.rejects(t.rotateKey(), /frontdoor\.acme/);
    t.stop();
  });

  it('a reload that cannot read the files keeps the loaded certificate', () => {
    const dir = tmp();
    const first = issueCert(ca, { dnsNames: ['mcp.kl.example.com'] });
    fs.writeFileSync(path.join(dir, 'mcp.pem'), first.cert);
    fs.writeFileSync(path.join(dir, 'mcp.key'), first.key);
    const t = new OperatorTls({ host: 'mcp.kl.example.com', certFile: path.join(dir, 'mcp.pem'), keyFile: path.join(dir, 'mcp.key') });
    t.start();
    const context = t.currentContext();
    fs.rmSync(path.join(dir, 'mcp.key'));
    const logs = captureLogs();
    try { t.reload(); } finally { logs.restore(); }
    assert.equal(t.currentContext(), context);
    assert.equal(t.leafSpki(), relaySpkiPin(first.cert));
    t.stop();
  });
});

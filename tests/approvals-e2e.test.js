// tests/approvals-e2e.test.js
//
// The whole path with real processes and real TLS: `relay run`, a node's
// `run --profile runbook` paired with it, a console-enrolled fake phone, and
// an unsafe runbook asked for through `mcp` and approved on the phone.
//
// The admin config dirs must be root-owned on POSIX, which a test cannot
// arrange, so this runs on Windows or as root. Everything lives under one
// temp dir; no real config dir, data dir or profile is touched.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { runRelayCommand } = require('../src/service/commands/relay');
const { runPair } = require('../src/service/commands/pair');
const { runEnrollDevice } = require('../src/service/commands/devices');
const { decodeQr } = require('../src/approvals/messages');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { createFakePhone } = require('./helpers/fake-phone');

const BIN = path.join(__dirname, '..', 'bin', 'king-louie-service.js');
const CAN_RUN = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await sleep(100);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function spawnCli(children, args) {
  const env = { ...process.env, KING_LOUIE_LOG_LEVEL: 'info' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = fork(BIN, args, { silent: true, env });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return { child, output: () => out, errors: () => err };
}

// Asks each child to shut down, then kills whatever is still running.
async function stopChildren(children) {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill();
    } catch {
      child.kill();
    }
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(5000)]);
    }
  }));
}

// The service trusts the approver set only when it cannot write it. On
// Windows the test user is also the "service account", so once the phone is
// enrolled the test denies itself write access to approvers/ (a temp dir), as
// an installer's ACL would. The returned function lifts the deny again so the
// temp dir can be removed.
function lockApproversDir(dir) {
  if (process.platform !== 'win32') return () => {};
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  // Specific rights only: the generic W would also deny SYNCHRONIZE, and with
  // it every read.
  execFileSync('icacls', [dir, '/deny', `${who}:(OI)(CI)(WD,AD,WEA,WA,DC)`], { stdio: 'ignore' });
  return () => execFileSync('icacls', [dir, '/remove:d', who], { stdio: 'ignore' });
}

function streamIo(input = null) {
  const text = { out: '', err: '' };
  const stdin = new PassThrough();
  if (input !== null) stdin.end(input);
  return { stdin, stdout: { write: (s) => { text.out += String(s); return true; } }, stderr: { write: (s) => { text.err += String(s); return true; } }, text };
}

// The phone's HTTPS client: CA trust ignored, the leaf SPKI pinned.
function phoneHttps(baseUrl, spkiPin, phone) {
  return (method, p, body) => new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', ...(phone ? phone.signApi(method, p, text) : {}) };
    const req = https.request(`${baseUrl}${p}`, { method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    // Checked on the handshake, before the request is sent.
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const cert = socket.getPeerX509Certificate();
      const pin = `sha256/${crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')}`;
      if (pin !== spkiPin) req.destroy(new Error('Relay certificate changed — scan a new relay code'));
    }));
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : text);
  });
}

describe('phone approvals end to end', { skip: !CAN_RUN && 'needs root-owned admin config dirs on POSIX', timeout: 180000 }, () => {
  it('an unsafe runbook asked for through mcp runs after a phone approves it', async () => {
    const children = [];
    let unlock = null;
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-approvals-')));
    try {
      // ── Relay host ──────────────────────────────────────────────────────
      const relayData = path.join(base, 'relay', 'data');
      const relayConfig = path.join(base, 'relay', 'config');
      fs.mkdirSync(relayData, { recursive: true });
      fs.mkdirSync(relayConfig, { recursive: true });
      const { cert, key } = MeshIdentity.generateTlsCertificate('relay-e2e');
      fs.writeFileSync(path.join(relayConfig, 'relay.crt'), cert);
      fs.writeFileSync(path.join(relayConfig, 'relay.key'), key);
      const phonePort = await freePort();
      const meshPort = await freePort();
      fs.writeFileSync(path.join(relayConfig, 'service.json'), JSON.stringify({
        relay: {
          phone_listen: { host: '127.0.0.1', port: phonePort },
          mesh_listen: { host: '127.0.0.1', port: meshPort },
          tls: { cert_file: path.join(relayConfig, 'relay.crt'), key_file: path.join(relayConfig, 'relay.key') },
          public_url: `https://127.0.0.1:${phonePort}`
        }
      }));
      const relay = spawnCli(children, ['relay', 'run', '--data-dir', relayData]);
      const ready = await until(() => relay.output().split('\n').find((l) => l.includes('"event":"ready"')), () => `relay ready (${relay.errors()})`);
      const relayInfo = JSON.parse(ready);

      // ── Node: config, runbook, pairing ──────────────────────────────────
      const nodeData = path.join(base, 'node', 'data');
      const nodeConfig = path.join(base, 'node', 'config');
      const root = path.join(base, 'site');
      fs.mkdirSync(path.join(nodeConfig, 'runbooks'), { recursive: true });
      fs.mkdirSync(nodeData, { recursive: true });
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(nodeConfig, 'node.yaml'), [
        'name: web-01',
        'profile: runbook',
        'policy:',
        `  allowed_roots: [${JSON.stringify(root)}]`,
        'approvers:',
        `  relay: wss://127.0.0.1:${meshPort}`,
        ''
      ].join('\n'));
      fs.writeFileSync(path.join(nodeConfig, 'runbooks', 'site-touch.yaml'), JSON.stringify({
        name: 'site.touch',
        description: 'Write a marker file',
        tier: 'unsafe',
        params: { target: { type: 'path' } },
        steps: [{ run: [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1], 'ran')", '{{target}}/marker.txt'] }]
      }));

      const codeIo = streamIo();
      assert.equal(await runRelayCommand({ sub: 'code', arg: 'web-01', dataDir: relayData, io: codeIo }), 0, codeIo.text.err);
      const code = /Pairing code for web-01: (.+)$/m.exec(codeIo.text.out)[1];
      // The relay picks code files up on a 1 s poll and removes them. Pairing
      // waits for that and then tries once: a failed attempt after the relay
      // recorded the node needs `relay remove-node` before a retry, so a
      // retry loop would only hide the cause.
      const codesDir = path.join(relayData, 'relay', 'codes');
      await until(() => fs.readdirSync(codesDir).length === 0, () => `the relay to pick up the code (${relay.errors()})`);
      const pairIo = streamIo(`${code}\n`);
      assert.equal(await runPair({ url: `wss://127.0.0.1:${meshPort}`, dataDir: nodeData, io: pairIo }), 0, pairIo.text.err);

      const service = spawnCli(children, ['run', '--profile', 'runbook', '--data-dir', nodeData]);
      await until(() => service.output().includes('"event":"ready"'), () => `node ready (${service.errors()})`);
      const linkFile = path.join(nodeData, 'approvals', 'link.json');
      await until(() => fs.existsSync(linkFile) && JSON.parse(fs.readFileSync(linkFile, 'utf8')).connected, () => `the relay link (${service.errors()})`);

      // ── Console enrollment of the phone ─────────────────────────────────
      const phone = createFakePhone({ name: 'Owner phone', platform: 'ios' });
      const enrollIo = streamIo();
      const enrolling = runEnrollDevice({ dataDir: nodeData, io: enrollIo, deps: { renderQr: async () => '[QR]' } });
      const qrText = await until(() => /Or paste this into the app: (kl1:\S+)/.exec(enrollIo.text.out), () => `the pairing QR (${enrollIo.text.err})`);
      const qr = decodeQr(qrText[1]);
      assert.equal(qr.relay_spki, relayInfo.phone_spki);
      const api = phoneHttps(qr.relay, qr.relay_spki, phone);
      const anonymous = phoneHttps(qr.relay, qr.relay_spki, null);
      const claim = await anonymous('POST', `/v1/enroll/${qr.code_id}`, phone.enroll({ codeId: qr.code_id, code: qr.code }));
      assert.equal(claim.status, 202, JSON.stringify(claim.body));
      await until(() => /does the phone show the same\? \[y\/N\]/.test(enrollIo.text.out), 'the confirmation prompt');
      enrollIo.stdin.write('y\n');
      assert.equal(await enrolling, 0, enrollIo.text.err);
      await until(async () => (await anonymous('GET', `/v1/enroll/${qr.code_id}`)).body.state === 'done', 'enrollment done');
      unlock = lockApproversDir(path.join(nodeConfig, 'approvers'));

      // ── The unsafe runbook through mcp ──────────────────────────────────
      const mcp = spawnCli(children, ['mcp', '--data-dir', nodeData]);
      const rpc = (id, method, params) => {
        mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return until(() => mcp.output().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id), () => `mcp reply ${id} (${mcp.errors()})`);
      };
      await rpc(1, 'initialize', {});
      const started = await rpc(2, 'tools/call', { name: 'run_runbook', arguments: { machine: 'web-01', runbook: 'site.touch', params: { target: root } } });
      const job = JSON.parse(started.result.content[0].text);
      assert.equal(job.status, 'awaiting_approval', JSON.stringify(job));

      // The relay lists a request only to a device active on its node; the
      // service reports the newly applied device within its 5 s poll.
      const pending = await until(async () => {
        const res = await api('GET', '/v1/approvals?wait=5');
        return res.status === 200 && res.body.length ? res.body[0] : null;
      }, 'the request on the phone');
      assert.equal(verifyEd25519(pending.envelope, qr.node.key), true, 'the phone shows only what the pinned node signed');
      const request = open(pending.envelope).message;
      assert.equal(request.action.kind, 'runbook');
      assert.equal(request.origin.job_id, job.job_id);
      const answer = await api('POST', `/v1/approvals/${request.request_id}/response`, phone.respond(pending.envelope, 'approve'));
      assert.equal(answer.status, 202);
      // The request is mcp's, so the service drops the response in mcp's
      // courier inbox and cannot say yet whether it was accepted: `accepted`
      // is null, never true. The job's outcome below is the verdict.
      assert.deepEqual(answer.body, { delivered: true, accepted: null, reason: null });

      let finalJob = null;
      for (let id = 10; ; id += 1) {
        const res = await rpc(id, 'tools/call', { name: 'get_job', arguments: { job_id: job.job_id } });
        finalJob = JSON.parse(res.result.content[0].text);
        if (!['awaiting_approval', 'queued', 'running'].includes(finalJob.status)) break;
        await sleep(200);
      }
      assert.equal(finalJob.status, 'succeeded', JSON.stringify(finalJob));
      assert.equal(fs.readFileSync(path.join(root, 'marker.txt'), 'utf8'), 'ran');
    } finally {
      await stopChildren(children);
      // The deny must go before the temp dir can be removed.
      if (unlock) unlock();
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

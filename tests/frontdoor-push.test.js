// tests/frontdoor-push.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const http2 = require('http2');
const { createPusher } = require('../src/frontdoor/push');
const { createApnsSender } = require('../src/frontdoor/push/apns');
const { createFcmSender } = require('../src/frontdoor/push/fcm');
const { alertText, KINDS, FCM_ONLY_KINDS } = require('../src/frontdoor/push/text');
const { addSink } = require('../src/logging');

const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function verifyJwt(jwt, publicKey, alg) {
  const [h, c, s] = jwt.split('.');
  const data = Buffer.from(`${h}.${c}`);
  const sig = Buffer.from(s, 'base64url');
  const ok = alg === 'ES256'
    ? crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)
    : crypto.verify('sha256', data, publicKey, sig);
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

const device = (platform, token = 'tok-1', deviceId = 'd-aaaaaaaaaaaaaaaa') => ({ device_id: deviceId, push: { platform, token } });

describe('createPusher', () => {
  it("defaults to the 'none' sender and never throws", async () => {
    const pusher = createPusher({});
    assert.deepEqual(pusher.senders, ['none']);
    await pusher.notify(device('apns'), { id: 'r-1' });
    await pusher.notify({ device_id: 'd-x', push: null }, { id: 'r-1' });
  });

  it('picks the sender for the device platform, falls back to none, and drops rejected tokens', async () => {
    const seen = [];
    const dropped = [];
    const fake = { id: 'fake', platforms: ['fcm'], notify: async (d, p) => { seen.push(p); return { ok: false, dropToken: true, status: 404 }; } };
    const broken = { id: 'broken', platforms: ['apns'], notify: async () => { throw new Error('boom'); } };
    const pusher = createPusher({}, { senders: [fake, broken], onDropToken: (d) => dropped.push(d.device_id) });
    await pusher.notify(device('fcm'), { kind: 'lease', id: 'l-1', node_name: 'gpu-box' });
    await pusher.notify(device('apns'), { id: 'r-2' });
    assert.deepEqual(seen, [{ kind: 'lease', id: 'l-1', node_name: 'gpu-box', expires_at: null }]);
    assert.deepEqual(dropped, ['d-aaaaaaaaaaaaaaaa']);
  });

  it('alert text names the node and nothing about the action', () => {
    assert.equal(alertText({ kind: 'approval', node_name: 'web-01' }), 'Approval needed on web-01');
    assert.equal(alertText({ kind: 'question' }), 'Question waiting');
    assert.equal(alertText({ kind: 'nonsense' }), 'Approval needed');
  });

  it('alert text sanitises an operator-set node_name: strips control characters and caps its length', () => {
    assert.equal(alertText({ kind: 'approval', node_name: 'web-01\nrm -rf /' }), 'Approval needed on web-01rm -rf /');
    const long = 'x'.repeat(80);
    const text = alertText({ kind: 'approval', node_name: long });
    assert.ok(text.length < 'Approval needed on '.length + 41, `text too long: ${text.length}`);
    assert.ok(text.endsWith('…'));
    assert.equal(alertText({ kind: 'approval', node_name: '\u0000\u0001' }), 'Approval needed');
  });
});

describe('APNs sender', () => {
  it('posts an ES256-authenticated alert with k and rid, caches the token, and drops a 410 token', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests = [];
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => {
        requests.push({ headers, body: JSON.parse(body) });
        stream.respond({ ':status': headers[':path'].endsWith('/gone') ? 410 : 200 });
        stream.end();
      });
    });
    const port = await listen(server);
    const sender = createApnsSender({
      teamId: 'TEAM123456', keyId: 'KEY1234567', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      topic: 'com.example.kinglouie', origin: `http://127.0.0.1:${port}`
    });
    const expires = new Date(Date.now() + 120000).toISOString();
    assert.deepEqual(await sender.notify(device('apns', 'abc'), { kind: 'approval', id: 'r-1', node_name: 'web-01', expires_at: expires }), { ok: true, dropToken: false, status: 200 });
    assert.equal((await sender.notify(device('apns', 'gone'), { kind: 'question', id: 'q-1' })).dropToken, true);
    const [first, second] = requests;
    assert.equal(first.headers[':path'], '/3/device/abc');
    assert.equal(first.headers['apns-topic'], 'com.example.kinglouie');
    assert.equal(first.headers['apns-push-type'], 'alert');
    assert.equal(first.headers['apns-priority'], '10');
    assert.equal(first.headers['apns-collapse-id'], 'r-1');
    assert.equal(first.headers['apns-expiration'], String(Math.floor(Date.parse(expires) / 1000)));
    assert.deepEqual(first.body, { aps: { alert: { title: 'King Louie', body: 'Approval needed on web-01' }, sound: 'default' }, kl: { rid: 'r-1', k: 'approval' } });
    assert.equal(second.body.kl.k, 'question');
    const jwt = first.headers.authorization.replace(/^bearer /, '');
    const decoded = verifyJwt(jwt, publicKey, 'ES256');
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.header, { alg: 'ES256', kid: 'KEY1234567' });
    assert.equal(decoded.claims.iss, 'TEAM123456');
    assert.equal(second.headers.authorization, first.headers.authorization, 'the token is reused');
  });

  it('refreshes the JWT after 50 minutes and re-signs after a 401 clears the cache', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const statuses = [200, 200, 401, 200];
    const requests = [];
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => {
        requests.push({ auth: headers.authorization });
        stream.respond({ ':status': statuses.shift() });
        stream.end();
      });
    });
    const port = await listen(server);
    let now = Date.parse('2026-09-23T18:00:00.000Z');
    const sender = createApnsSender({
      teamId: 'TEAM123456', keyId: 'KEY1234567', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      topic: 'com.example.kinglouie', origin: `http://127.0.0.1:${port}`, now: () => now
    });
    await sender.notify(device('apns', 'a'), { kind: 'approval', id: 'r-1' });
    now += 51 * 60 * 1000;
    await sender.notify(device('apns', 'b'), { kind: 'approval', id: 'r-2' });
    assert.notEqual(requests[1].auth, requests[0].auth, 'the token was re-signed after its ttl');
    // Third call gets the 401 and must re-sign on the very next call.
    await sender.notify(device('apns', 'c'), { kind: 'approval', id: 'r-3' });
    await sender.notify(device('apns', 'd'), { kind: 'approval', id: 'r-4' });
    assert.notEqual(requests[3].auth, requests[2].auth, 'a 401 cleared the cached token');
  });

  it('resolves as a failure, never hanging or throwing, when APNs accepts the request but never responds', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const server = http2.createServer();
    // Accept the stream and simply never call stream.respond()/stream.end():
    // a connected-but-silent APNs.
    server.on('stream', () => {});
    const port = await listen(server);
    const sender = createApnsSender({
      teamId: 'TEAM123456', keyId: 'KEY1234567', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      topic: 'com.example.kinglouie', origin: `http://127.0.0.1:${port}`, timeoutMs: 50
    });
    const result = await sender.notify(device('apns', 'stuck'), { kind: 'approval', id: 'r-timeout' });
    assert.deepEqual(result, { ok: false, dropToken: false, status: null });
  });
});

describe('FCM sender', () => {
  it('exchanges an RS256 assertion once, sends a data-only high-priority message, and drops UNREGISTERED', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const sends = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/token') {
          tokenRequests += 1;
          const assertion = new URLSearchParams(body).get('assertion');
          const decoded = verifyJwt(assertion, publicKey, 'RS256');
          assert.equal(decoded.ok, true);
          assert.equal(decoded.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
          return;
        }
        const parsed = JSON.parse(body);
        sends.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        if (parsed.message.token === 'dead') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
          return;
        }
        res.writeHead(200);
        res.end('{}');
      });
    });
    const port = await listen(server);
    const sender = createFcmSender({
      serviceAccount: { client_email: 'relay@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'kl-example' },
      tokenUrl: `http://127.0.0.1:${port}/token`,
      fcmOrigin: `http://127.0.0.1:${port}`
    });
    const expires = new Date(Date.now() + 90000).toISOString();
    assert.equal((await sender.notify(device('fcm', 'live'), { kind: 'approval', id: 'r-1', node_name: 'web-01', expires_at: expires })).ok, true);
    assert.equal((await sender.notify(device('fcm', 'dead'), { kind: 'lease', id: 'l-1' })).dropToken, true);
    assert.equal(tokenRequests, 1);
    assert.equal(sends[0].url, '/v1/projects/kl-example/messages:send');
    assert.equal(sends[0].auth, 'Bearer ya29.test');
    assert.deepEqual(sends[0].body.message.data, { rid: 'r-1', n: 'web-01', k: 'approval' });
    assert.equal(sends[0].body.message.android.priority, 'HIGH');
    assert.match(sends[0].body.message.android.ttl, /^(89|90)s$/);
    assert.equal(sends[0].body.message.notification, undefined, 'data-only');
  });

  it('re-exchanges the OAuth token after it expires and after a 401/403 clears the cache', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const authSeen = [];
    let now = Date.parse('2026-09-23T18:00:00.000Z');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/token') {
          tokenRequests += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: `ya29.${tokenRequests}`, expires_in: 3600 }));
          return;
        }
        authSeen.push(req.headers.authorization);
        if (tokenRequests === 2) {
          res.writeHead(401);
          res.end('{}');
          return;
        }
        res.writeHead(200);
        res.end('{}');
      });
    });
    const port = await listen(server);
    const sender = createFcmSender({
      serviceAccount: { client_email: 'relay@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'kl-example' },
      tokenUrl: `http://127.0.0.1:${port}/token`,
      fcmOrigin: `http://127.0.0.1:${port}`,
      now: () => now
    });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-1' });
    assert.equal(tokenRequests, 1);
    now += 3600 * 1000 - 30 * 1000; // inside the 60s-early refresh margin
    await sender.notify(device('fcm', 'b'), { kind: 'approval', id: 'r-2' });
    assert.equal(tokenRequests, 2, 'the cached token was treated as expired ahead of its real expiry');
    // The second token gets a 401 from the send endpoint; the next call must
    // re-exchange rather than reuse the rejected token.
    await sender.notify(device('fcm', 'c'), { kind: 'approval', id: 'r-3' });
    assert.equal(tokenRequests, 3, 'a 401 from FCM cleared the cached OAuth token');
    assert.deepEqual(authSeen, ['Bearer ya29.1', 'Bearer ya29.2', 'Bearer ya29.3']);
  });

  it('sanitises and caps node_name in the data payload, same as the APNs alert text', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sends = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
          return;
        }
        sends.push(JSON.parse(body));
        res.writeHead(200);
        res.end('{}');
      });
    });
    const port = await listen(server);
    const sender = createFcmSender({
      serviceAccount: { client_email: 'relay@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'kl-example' },
      tokenUrl: `http://127.0.0.1:${port}/token`,
      fcmOrigin: `http://127.0.0.1:${port}`
    });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-1', node_name: 'web-01\nrm -rf /' });
    await sender.notify(device('fcm', 'b'), { kind: 'approval', id: 'r-2', node_name: 'x'.repeat(80) });
    await sender.notify(device('fcm', 'c'), { kind: 'approval', id: 'r-3', node_name: '\u0000\u0001' });
    assert.equal(sends[0].message.data.n, 'web-01rm -rf /');
    assert.ok(sends[1].message.data.n.length <= 40 && sends[1].message.data.n.endsWith('…'));
    assert.equal(sends[2].message.data.n, '');
  });
});

// A local FCM server (token exchange and send) on 127.0.0.1: `respond`
// decides each send's status and body from the parsed message.
async function fcmServer(respond = () => [200, '{}']) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sends = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.oauth-access', expires_in: 3600 }));
        return;
      }
      const parsed = JSON.parse(body);
      sends.push(parsed);
      const [status, text] = respond(parsed.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  const port = await listen(server);
  return {
    sends,
    options: {
      serviceAccount: { client_email: 'relay@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'kl-example' },
      tokenUrl: `http://127.0.0.1:${port}/token`,
      fcmOrigin: `http://127.0.0.1:${port}`
    }
  };
}

describe('push text', () => {
  it('KINDS holds the three fcm-only kinds with their titles', () => {
    assert.deepEqual(FCM_ONLY_KINDS, ['session_ended', 'session_paused', 'test']);
    for (const k of FCM_ONLY_KINDS) assert.ok(KINDS.includes(k));
    assert.equal(alertText({ kind: 'session_ended', node_name: 'gpu-box' }), 'Session ended on gpu-box');
    assert.equal(alertText({ kind: 'session_paused' }), 'Session paused');
    assert.equal(alertText({ kind: 'test' }), 'Test');
  });
});

describe('push kinds and the FCM payload (push spec §6.5, §7.1)', () => {
  it('carries the new kinds, and c for a count of 2 or more, capped at 999', async () => {
    const fcm = await fcmServer();
    const sender = createFcmSender(fcm.options);
    await sender.notify(device('fcm', 'a'), { kind: 'session_ended', id: 'lease-1', node_name: 'gpu-box' });
    await sender.notify(device('fcm', 'a'), { kind: 'session_paused', id: 'lease-2', node_name: 'gpu-box' });
    await sender.notify(device('fcm', 'a'), { kind: 'test', id: 't-1', node_name: 'relay-1' });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-1', node_name: 'gpu-box', count: 10 });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-2', count: 1 });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-3', count: 1000 });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-4', count: 2.5 });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-5', count: '7' });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-6', count: 999 });
    const data = fcm.sends.map((s) => s.message.data);
    assert.deepEqual(data[0], { rid: 'lease-1', n: 'gpu-box', k: 'session_ended' });
    assert.deepEqual(data[1], { rid: 'lease-2', n: 'gpu-box', k: 'session_paused' });
    assert.deepEqual(data[2], { rid: 't-1', n: 'relay-1', k: 'test' });
    assert.deepEqual(data[3], { rid: 'r-1', n: 'gpu-box', k: 'approval', c: '10' });
    assert.equal(data[4].c, undefined, 'a count of 1 is not sent');
    assert.equal(data[5].c, '999', 'a count above 999 is sent as 999');
    for (const d of data.slice(6, 8)) assert.equal(d.c, undefined);
    assert.equal(data[8].c, '999');
    for (const d of data) for (const v of Object.values(d)) assert.equal(typeof v, 'string');
  });

  it('sets ttl: seconds to expires_at, else 3600 for session_ended, else 300', async () => {
    const fcm = await fcmServer();
    const now = Date.parse('2026-10-29T12:00:00.000Z');
    const sender = createFcmSender({ ...fcm.options, now: () => now });
    const in90 = new Date(now + 90000).toISOString();
    await sender.notify(device('fcm', 'a'), { kind: 'session_paused', id: 'l-1', expires_at: in90 });
    await sender.notify(device('fcm', 'a'), { kind: 'session_ended', id: 'l-2' });
    await sender.notify(device('fcm', 'a'), { kind: 'session_paused', id: 'l-3' });
    await sender.notify(device('fcm', 'a'), { kind: 'approval', id: 'r-1' });
    await sender.notify(device('fcm', 'a'), { kind: 'test', id: 't-1' });
    assert.deepEqual(fcm.sends.map((s) => s.message.android.ttl), ['90s', '3600s', '300s', '300s', '300s']);
  });

  it('drops a token on 403 SENDER_ID_MISMATCH, never on a 400', async () => {
    const fcm = await fcmServer((m) => {
      if (m.token === 'other-project') return [403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }] } })];
      if (m.token === 'bad-request') return [400, JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } })];
      if (m.token === 'denied') return [403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } })];
      return [200, '{}'];
    });
    const sender = createFcmSender(fcm.options);
    assert.deepEqual(await sender.notify(device('fcm', 'other-project'), { kind: 'approval', id: 'r-1' }), { ok: false, dropToken: true, status: 403 });
    assert.deepEqual(await sender.notify(device('fcm', 'bad-request'), { kind: 'approval', id: 'r-2' }), { ok: false, dropToken: false, status: 400 });
    assert.deepEqual(await sender.notify(device('fcm', 'denied'), { kind: 'approval', id: 'r-3' }), { ok: false, dropToken: false, status: 403 });
  });
});

describe('the pusher and the fcm-only kinds (push spec C-2)', () => {
  it('passes a count to an fcm sender, sends the new kinds to fcm only, and keeps an apns payload as today', async () => {
    const seen = [];
    const fcm = { id: 'fcm', platforms: ['fcm'], notify: async (d, p) => { seen.push(['fcm', p]); return { ok: true }; } };
    const apns = { id: 'apns', platforms: ['apns'], notify: async (d, p) => { seen.push(['apns', p]); return { ok: true }; } };
    const pusher = createPusher({}, { senders: [fcm, apns] });
    await pusher.notify(device('fcm'), { kind: 'approval', id: 'r-1', node_name: 'gpu-box', count: 3 });
    await pusher.notify(device('fcm', 'tok-1', 'd-bbbbbbbbbbbbbbbb'), { kind: 'session_ended', id: 'l-1', node_name: 'gpu-box' });
    await pusher.notify(device('apns'), { kind: 'session_ended', id: 'l-1', node_name: 'gpu-box' });
    await pusher.notify(device('apns'), { kind: 'session_paused', id: 'l-2' });
    await pusher.notify(device('apns'), { kind: 'test', id: 't-1' });
    await pusher.notify(device('apns'), { kind: 'approval', id: 'r-2', node_name: 'gpu-box', count: 3 });
    assert.deepEqual(seen, [
      ['fcm', { kind: 'approval', id: 'r-1', node_name: 'gpu-box', expires_at: null, count: 3 }],
      ['fcm', { kind: 'session_ended', id: 'l-1', node_name: 'gpu-box', expires_at: null }],
      ['apns', { kind: 'approval', id: 'r-2', node_name: 'gpu-box', expires_at: null }]
    ]);
  });

  it("an apns device's push for today's kinds is byte for byte today's", async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests = [];
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => { requests.push({ headers, body }); stream.respond({ ':status': 200 }); stream.end(); });
    });
    const port = await listen(server);
    const apns = createApnsSender({
      teamId: 'TEAM123456', keyId: 'KEY1234567', keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      topic: 'com.example.kinglouie', origin: `http://127.0.0.1:${port}`
    });
    const pusher = createPusher({}, { senders: [apns] });
    const expires = '2030-01-01T00:00:00.000Z';
    for (const kind of ['approval', 'grant', 'pairing', 'alert', 'question', 'lease']) {
      await pusher.notify(device('apns', 'abc'), { kind, id: `id-${kind}`, node_name: 'web-01', expires_at: expires, count: 5 });
    }
    await pusher.notify(device('apns', 'abc'), { kind: 'session_ended', id: 'l-1', node_name: 'web-01' });
    assert.equal(requests.length, 6);
    const titles = { approval: 'Approval needed', grant: 'Access request', pairing: 'Pairing request', alert: 'Alert', question: 'Question waiting', lease: 'Session request' };
    for (const r of requests) {
      const kind = JSON.parse(r.body).kl.k;
      assert.equal(r.body, `{"aps":{"alert":{"title":"King Louie","body":"${titles[kind]} on web-01"},"sound":"default"},"kl":{"rid":"id-${kind}","k":"${kind}"}}`);
      assert.equal(r.headers['apns-expiration'], String(Date.parse(expires) / 1000));
      assert.equal(r.headers['apns-collapse-id'], `id-${kind}`);
      assert.equal(r.headers[':path'], '/3/device/abc');
    }
  });

  it('never logs a device token or an access token', async () => {
    const lines = [];
    const unsubscribe = addSink((record) => { lines.push(record.line); });
    try {
      const fcm = await fcmServer((m) => {
        if (m.token === 'devtok-unregistered') return [404, JSON.stringify({ error: { details: [{ errorCode: 'UNREGISTERED' }] } })];
        if (m.token === 'devtok-mismatch') return [403, JSON.stringify({ error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } })];
        return [500, '{"error":"devtok-500"}'];
      });
      const dropped = [];
      const pusher = createPusher({}, { senders: [createFcmSender(fcm.options)], onDropToken: (d) => dropped.push(d.device_id) });
      await pusher.notify(device('fcm', 'devtok-unregistered'), { kind: 'session_ended', id: 'l-1' });
      await pusher.notify(device('fcm', 'devtok-mismatch', 'd-bbbbbbbbbbbbbbbb'), { kind: 'approval', id: 'r-1' });
      await pusher.notify(device('fcm', 'devtok-500', 'd-cccccccccccccccc'), { kind: 'approval', id: 'r-2' });
      await pusher.notify(device('apns', 'devtok-apns'), { kind: 'test', id: 't-1' });
      assert.equal(dropped.length, 2);
    } finally {
      unsubscribe();
    }
    assert.ok(lines.length >= 3, 'the drops and the failure were logged');
    for (const line of lines) assert.doesNotMatch(line, /devtok|ya29|oauth-access/);
  });
});

// A fake clock for the pusher's gate (push spec §6.3, §6.4, §8): timers fire
// in order as the clock is advanced, and each firing is followed by a turn of
// the event loop so the async send it starts has run.
function fakeClock(start = Date.parse('2026-10-29T12:00:00.000Z')) {
  let t = start;
  const pending = [];
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const handle = { at: t + Math.max(0, ms), fn, unref() { return handle; } };
        pending.push(handle);
        return handle;
      },
      clearTimeout(handle) {
        const i = pending.indexOf(handle);
        if (i >= 0) pending.splice(i, 1);
      }
    },
    pending: () => pending.length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > end) break;
        pending.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    }
  };
}

function recordingPusher(clock) {
  const seen = [];
  const record = async (d, p) => { seen.push({ device: d.device_id, ...p }); return { ok: true, status: 200 }; };
  const fcm = { id: 'fcm', platforms: ['fcm'], notify: record };
  const apns = { id: 'apns', platforms: ['apns'], notify: record };
  const pusher = createPusher({}, { senders: [fcm, apns], now: clock.now, timers: clock.timers });
  return { pusher, seen };
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe('the pusher: dedupe per (node, kind, id) on fcm devices (push spec §6.3, C-5)', () => {
  it('keeps approvals 10 minutes, pauses 2 minutes and endings 24 hours, per device and per node', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    const phone = device('fcm');
    const other = device('fcm', 'tok-2', 'd-bbbbbbbbbbbbbbbb');
    const step = async (d, payload) => { await pusher.notify(d, payload); await clock.advance(11 * SEC); };
    const rids = () => seen.map((p) => `${p.device === phone.device_id ? 'A' : 'B'}:${p.node_name}:${p.id}`);

    await step(phone, { node_id: 'n-1', kind: 'approval', id: 'r-1', node_name: 'gpu-box' });
    await step(phone, { node_id: 'n-1', kind: 'approval', id: 'r-1', node_name: 'gpu-box' });
    await step(phone, { node_id: 'n-2', kind: 'approval', id: 'r-1', node_name: 'web-01' });
    await step(other, { node_id: 'n-1', kind: 'approval', id: 'r-1', node_name: 'gpu-box' });
    assert.deepEqual(rids(), ['A:gpu-box:r-1', 'A:web-01:r-1', 'B:gpu-box:r-1']);
    await clock.advance(10 * MIN);
    await step(phone, { node_id: 'n-1', kind: 'approval', id: 'r-1', node_name: 'gpu-box' });
    assert.equal(seen.length, 4, 'pushed again once the 10 minutes were over');

    const paused = { node_id: 'n-1', kind: 'session_paused', id: 'l-1', expires_at: '2026-10-29T14:00:00.000Z' };
    await step(phone, paused);
    await step(phone, paused);
    assert.equal(seen.length, 5);
    await clock.advance(2 * MIN);
    await step(phone, paused);
    assert.equal(seen.length, 6, 'a second pause after two minutes is pushed');

    await step(phone, { node_id: 'n-1', kind: 'session_ended', id: 'l-1' });
    await clock.advance(23 * HOUR);
    await step(phone, { node_id: 'n-1', kind: 'session_ended', id: 'l-1' });
    assert.equal(seen.length, 7, 'an ending is pushed once in 24 hours');
    await clock.advance(HOUR);
    await step(phone, { node_id: 'n-1', kind: 'session_ended', id: 'l-1' });
    assert.equal(seen.length, 8);
    for (const p of seen) assert.equal('node_id' in p, false, 'node_id is the relay key, never sent');
    pusher.stop();
  });

  it('holds at most 2,048 keys, the oldest out', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    const phones = Array.from({ length: 2049 }, (_, i) => device('fcm', `tok-${i}`, `d-${String(i).padStart(16, '0')}`));
    for (const [i, d] of phones.entries()) await pusher.notify(d, { node_id: 'n-1', kind: 'approval', id: `r-${i}` });
    assert.equal(seen.length, 2049);
    await clock.advance(11 * SEC);
    await pusher.notify(phones[0], { node_id: 'n-1', kind: 'approval', id: 'r-0' });
    await pusher.notify(phones[2], { node_id: 'n-1', kind: 'approval', id: 'r-2' });
    assert.deepEqual(seen.slice(2049).map((p) => p.id), ['r-0'], 'the oldest key was forgotten, a newer one was not');
    pusher.stop();
  });
});

describe('the pusher: 10-second coalescing per fcm device (push spec §6.4, C-6)', () => {
  it('sends the first at once and the rest as one with c and the newest item, then opens a new window', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    const phone = device('fcm');
    for (let i = 1; i <= 10; i += 1) {
      const last = i === 10;
      await pusher.notify(phone, { node_id: last ? 'n-2' : 'n-1', kind: 'approval', id: `r-${i}`, node_name: last ? 'web-01' : 'gpu-box', expires_at: `2026-10-29T12:0${i - 1}:00.000Z` });
      await clock.advance(200);
    }
    assert.deepEqual(seen, [{ device: phone.device_id, kind: 'approval', id: 'r-1', node_name: 'gpu-box', expires_at: '2026-10-29T12:00:00.000Z' }]);
    await clock.advance(8 * SEC);
    assert.deepEqual(seen[1], { device: phone.device_id, kind: 'approval', id: 'r-10', node_name: 'web-01', expires_at: '2026-10-29T12:09:00.000Z', count: 9 });

    // The coalesced push opened a new window: one item held there goes alone, without c.
    await pusher.notify(phone, { node_id: 'n-1', kind: 'session_ended', id: 'l-1', node_name: 'gpu-box' });
    assert.equal(seen.length, 2, 'held in the new window');
    await clock.advance(10 * SEC);
    assert.deepEqual(seen[2], { device: phone.device_id, kind: 'session_ended', id: 'l-1', node_name: 'gpu-box', expires_at: null });

    // A window that closes with nothing held ends; the next push goes at once.
    await clock.advance(10 * SEC);
    assert.equal(clock.pending(), 0);
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-1' });
    assert.equal(seen.length, 4);
    pusher.stop();
  });

  it('keeps each device in its own window', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    await pusher.notify(device('fcm'), { node_id: 'n-1', kind: 'approval', id: 'r-1' });
    await pusher.notify(device('fcm', 'tok-2', 'd-bbbbbbbbbbbbbbbb'), { node_id: 'n-1', kind: 'approval', id: 'r-1' });
    assert.equal(seen.length, 2);
    pusher.stop();
  });
});

describe('the pusher: at most 60 pushes per fcm device per hour (push spec §6.4)', () => {
  it('drops past 60, with one warn line per device per hour', async () => {
    const lines = [];
    const unsubscribe = addSink((record) => { lines.push(record); });
    let seen;
    try {
      const clock = fakeClock();
      const made = recordingPusher(clock);
      seen = made.seen;
      const phone = device('fcm', 'devtok-cap');
      for (let i = 0; i < 63; i += 1) {
        await made.pusher.notify(phone, { node_id: 'n-1', kind: 'approval', id: `r-${i}` });
        await clock.advance(11 * SEC);
      }
      assert.equal(seen.length, 60);
      assert.equal(lines.filter((r) => r.level === 'warn' && /hour/.test(r.line)).length, 1, 'one warn line');
      // An hour after the first push, sends resume as the oldest age out.
      await clock.advance(HOUR - 63 * 11 * SEC + SEC);
      await made.pusher.notify(phone, { node_id: 'n-1', kind: 'approval', id: 'r-new' });
      assert.equal(seen.length, 61);
      made.pusher.stop();
    } finally {
      unsubscribe();
    }
    for (const r of lines) assert.doesNotMatch(r.line, /devtok/);
  });

  it('remembers no (node, kind, id) the cap dropped, alone or coalesced, so it goes once the cap lifts', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    const phone = device('fcm');
    for (let i = 0; i < 60; i += 1) {
      await pusher.notify(phone, { node_id: 'n-1', kind: 'approval', id: `r-${i}` });
      await clock.advance(11 * SEC);
    }
    assert.equal(seen.length, 60);
    // Late in the hour, so a key wrongly remembered would still be live when the cap lifts.
    await clock.advance(2840 * SEC);
    // Dropped alone.
    await pusher.notify(phone, { node_id: 'n-1', kind: 'session_ended', id: 'l-1' });
    await clock.advance(11 * SEC);
    // Dropped coalesced: the first opens a window (dropped), the next two are held and dropped together.
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-0' });
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-1' });
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-2' });
    await clock.advance(11 * SEC);
    assert.equal(seen.length, 60, 'all dropped by the cap');

    await clock.advance(3 * MIN);
    await pusher.notify(phone, { node_id: 'n-1', kind: 'session_ended', id: 'l-1' });
    await clock.advance(11 * SEC);
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-1' });
    await clock.advance(11 * SEC);
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-2' });
    await clock.advance(11 * SEC);
    assert.deepEqual(seen.slice(60).map((p) => p.id), ['l-1', 'q-1', 'q-2']);

    // What went out, alone or carried by a coalesced push, is remembered.
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-3' });
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-4' });
    await pusher.notify(phone, { node_id: 'n-1', kind: 'question', id: 'q-5' });
    await clock.advance(11 * SEC);
    assert.deepEqual(seen.slice(63).map((p) => p.id), ['q-3', 'q-5']);
    await clock.advance(11 * SEC);
    for (const id of ['l-1', 'q-3', 'q-4', 'q-5']) {
      await pusher.notify(phone, { node_id: 'n-1', kind: id === 'l-1' ? 'session_ended' : 'question', id });
      await clock.advance(11 * SEC);
    }
    assert.equal(seen.length, 65, 'nothing that went out is pushed again inside its window');
    pusher.stop();
  });
});

describe('the pusher: apns devices as today (push spec C-2)', () => {
  it('never dedupes, coalesces or caps an apns device', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    const phone = device('apns');
    for (let i = 0; i < 70; i += 1) await pusher.notify(phone, { node_id: 'n-1', kind: 'approval', id: 'r-1' });
    assert.equal(seen.length, 70);
    assert.equal(clock.pending(), 0, 'no window opened');
    for (const p of seen) assert.deepEqual(Object.keys(p), ['device', 'kind', 'id', 'node_name', 'expires_at']);
    pusher.stop();
  });
});

describe('the pusher: stop() (push spec §17)', () => {
  it('drops what a window holds and leaves no timer behind', async () => {
    const clock = fakeClock();
    const { pusher, seen } = recordingPusher(clock);
    await pusher.notify(device('fcm'), { node_id: 'n-1', kind: 'approval', id: 'r-1' });
    await pusher.notify(device('fcm'), { node_id: 'n-1', kind: 'approval', id: 'r-2' });
    pusher.stop();
    assert.equal(clock.pending(), 0);
    await clock.advance(MIN);
    assert.equal(seen.length, 1, 'the held push was dropped');
    await pusher.notify(device('fcm'), { node_id: 'n-1', kind: 'approval', id: 'r-3' });
    assert.equal(seen.length, 1, 'a stopped pusher sends nothing');
  });

  it('arms unref-ed timers by default', async () => {
    const fcm = { id: 'fcm', platforms: ['fcm'], notify: async () => ({ ok: true, status: 200 }) };
    const pusher = createPusher({}, { senders: [fcm] });
    let unrefs = 0;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => {
      const h = realSetTimeout(fn, ms);
      const unref = h.unref.bind(h);
      h.unref = () => { unrefs += 1; return unref(); };
      return h;
    };
    try {
      await pusher.notify(device('fcm'), { node_id: 'n-1', kind: 'approval', id: 'r-1' });
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.ok(unrefs >= 1, 'the window timer is unref-ed');
    pusher.stop();
  });
});

describe('push-status.json (push spec §8, §17, C-14)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  it('records the last send and the last failure, no token or device id, at most once a minute, atomically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-push-status-'));
    try {
      const file = path.join(dir, 'relay', 'push-status.json');
      const clock = fakeClock();
      const statuses = [200, 500];
      const fcm = { id: 'fcm', platforms: ['fcm'], notify: async () => { const status = statuses.shift(); return { ok: status === 200, status }; } };
      const thrower = { id: 'apns', platforms: ['apns'], notify: async () => { throw new Error('connect ECONNREFUSED'); } };
      const pusher = createPusher({}, { senders: [fcm, thrower], now: clock.now, timers: clock.timers, statusFile: file });
      const t0 = clock.now();
      await pusher.notify(device('fcm', 'devtok-a', 'd-1111111111111111'), { node_id: 'n-1', kind: 'approval', id: 'r-1' });
      const first = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(first, { v: 1, last_send: { at: new Date(t0).toISOString(), sender: 'fcm', status: 200 }, last_failure: null });

      await clock.advance(20 * SEC);
      await pusher.notify(device('fcm', 'devtok-b', 'd-2222222222222222'), { node_id: 'n-1', kind: 'approval', id: 'r-2' });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), first, 'not rewritten within the minute');
      await clock.advance(40 * SEC);
      const failedAt = new Date(t0 + 20 * SEC).toISOString();
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        v: 1, last_send: { at: failedAt, sender: 'fcm', status: 500 }, last_failure: { at: failedAt, sender: 'fcm', status: 500 }
      });

      await clock.advance(5 * SEC);
      await pusher.notify(device('apns', 'devtok-c', 'd-3333333333333333'), { kind: 'approval', id: 'r-3' });
      pusher.stop();
      const thrownAt = new Date(t0 + 65 * SEC).toISOString();
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        v: 1, last_send: { at: thrownAt, sender: 'apns', status: null }, last_failure: { at: thrownAt, sender: 'apns', status: null }
      }, 'stop() writes what is pending');
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['push-status.json'], 'no temporary file left');
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /devtok|d-[0-9]{16}|ECONNREFUSED/);
      assert.equal(clock.pending(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the none sender records nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-push-status-'));
    try {
      const file = path.join(dir, 'push-status.json');
      const clock = fakeClock();
      const pusher = createPusher({}, { senders: [], now: clock.now, timers: clock.timers, statusFile: file });
      await pusher.notify(device('fcm'), { node_id: 'n-1', kind: 'approval', id: 'r-1' });
      pusher.stop();
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

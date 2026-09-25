// tests/frontdoor-push.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const http2 = require('http2');
const { createPusher } = require('../src/frontdoor/push');
const { createApnsSender } = require('../src/frontdoor/push/apns');
const { createFcmSender } = require('../src/frontdoor/push/fcm');
const { alertText } = require('../src/frontdoor/push/text');

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

const device = (platform, token = 'tok-1') => ({ device_id: 'd-aaaaaaaaaaaaaaaa', push: { platform, token } });

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
});

// tests/helpers/fake-contact-relay.js
// A local HTTP server speaking the contact relay contract (cases stage 4 §4.5)
// on port 0. Tests queue events, force an error status or a hung request,
// and read requests.
const http = require('http');

async function startFakeRelay({ token = 'relay-token' } = {}) {
  const requests = [];
  const messages = new Map();
  const byKey = new Map();
  const events = [];
  let forceStatus = null;
  let hang = false;
  let counter = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://relay.local');
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: parsed });
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      if (hang) {
        hang = false;
        return undefined; // never answer: the client's timeout must fire
      }
      if (forceStatus) {
        const s = forceStatus;
        forceStatus = null;
        return send(s, { error: `forced ${s}` });
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const key = req.headers['idempotency-key'];
        if (key && byKey.has(key)) return send(202, { id: byKey.get(key), status: 'queued' });
        counter += 1;
        const id = `msg-${counter}`;
        messages.set(id, { id, status: 'queued', body: parsed });
        if (key) byKey.set(key, id);
        return send(202, { id, status: 'queued' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/messages') {
        const id = byKey.get(url.searchParams.get('idempotencyKey'));
        return id ? send(200, { id, status: messages.get(id).status, at: new Date().toISOString() }) : send(404, { error: 'not found' });
      }
      const m = /^\/v1\/messages\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const msg = messages.get(decodeURIComponent(m[1]));
        return msg ? send(200, { id: msg.id, status: msg.status, at: new Date().toISOString() }) : send(404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        const after = Number(url.searchParams.get('after') || 0);
        const page = events.slice(after, after + 100);
        return send(200, { events: page, cursor: String(after + page.length) });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    token,
    requests,
    messages,
    sent: () => requests.filter((r) => r.method === 'POST' && r.path === '/v1/messages'),
    pushEvent: (ev) => events.push(ev),
    failNext: (status) => { forceStatus = status; },
    hangNext: () => { hang = true; },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
}

module.exports = { startFakeRelay };

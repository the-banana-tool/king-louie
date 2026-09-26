// tests/helpers/fake-errands-server.js
// An in-process errands API (examples/executors/phone-agent/openapi.yaml)
// for the cases stage 3 tests. Listens on 127.0.0.1 only.
const http = require('http');
const crypto = require('crypto');

async function startFakeErrandsServer({ token = 'tok-test', pageSize = 2 } = {}) {
  const state = { jobs: new Map(), records: new Map(), idempotency: new Map(), requests: [], seq: 0 };
  const knobs = { failNextStatus: null, normalizeAs: {}, latencyMs: 0, status429: null, status404: false, status422: false, status5xx: false, failAfterWrite: null, postStatus: null };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const fail = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers);
  const view = (j) => JSON.parse(JSON.stringify(j));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (knobs.latencyMs) await new Promise((r) => setTimeout(r, knobs.latencyMs));
      if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, 'auth', 'bad token');
      if (knobs.failNextStatus) {
        const status = knobs.failNextStatus;
        knobs.failNextStatus = null;
        return fail(res, status, 'forced', `forced ${status}`);
      }
      if (knobs.status429) return fail(res, 429, 'rate-limited', 'slow down', { 'retry-after': String(knobs.status429) });
      if (knobs.status5xx) return fail(res, 503, 'unavailable', 'maintenance');
      if (knobs.status404) return fail(res, 404, 'not-found', 'no such job');
      if (knobs.status422) return fail(res, 422, 'invalid', 'bad request body');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && url.pathname === '/jobs') {
        // A refusal of POST /jobs only (other routes answer as usual).
        if (knobs.postStatus) return fail(res, knobs.postStatus, 'invalid', `refused with ${knobs.postStatus}`);
        const key = req.headers['idempotency-key'];
        if (!key) return fail(res, 422, 'invalid', 'Idempotency-Key is required');
        if (!body || !body.externalRef || !Array.isArray(body.recipients) || !body.recipients.length) {
          return fail(res, 422, 'invalid', 'externalRef and recipients are required');
        }
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const seen = state.idempotency.get(key);
        if (seen) {
          if (seen.hash !== hash) return fail(res, 409, 'conflict', 'Idempotency-Key reused with a different body');
          return send(res, 200, view(state.jobs.get(seen.id)));
        }
        state.seq += 1;
        const id = `job_${state.seq}`;
        const at = new Date().toISOString();
        const job = {
          id, state: 'queued', externalRef: body.externalRef, createdAt: at, updatedAt: at, costUsd: 0,
          contacts: body.recipients.map((r, i) => ({
            id: `c${i + 1}`, address: r.address, normalizedAddress: knobs.normalizeAs[r.address] || r.address,
            state: 'pending', attempts: 0, lastAttemptAt: null
          }))
        };
        state.jobs.set(id, job);
        state.idempotency.set(key, { hash, id });
        // The job is written, but the answer is lost (a 5xx after the write).
        if (knobs.failAfterWrite) {
          const status = knobs.failAfterWrite;
          knobs.failAfterWrite = null;
          return fail(res, status, 'unavailable', 'failed after the write');
        }
        return send(res, 201, view(job));
      }
      if (req.method === 'GET' && url.pathname === '/jobs') {
        const ref = url.searchParams.get('externalRef');
        return send(res, 200, { jobs: [...state.jobs.values()].filter((j) => j.externalRef === ref).map(view) });
      }
      if (parts[0] === 'jobs' && parts[1]) {
        const job = state.jobs.get(parts[1]);
        if (!job) return fail(res, 404, 'not-found', `no job ${parts[1]}`);
        if (req.method === 'GET' && parts.length === 2) return send(res, 200, view(job));
        if (req.method === 'DELETE' && parts.length === 2) {
          job.state = 'cancelled';
          job.updatedAt = new Date().toISOString();
          return send(res, 200, view(job));
        }
        if (req.method === 'GET' && parts[2] === 'results') {
          const all = state.records.get(job.id) || [];
          const after = url.searchParams.get('after');
          const start = after ? all.findIndex((r) => r.id === after) + 1 : 0;
          const page = all.slice(start, start + pageSize);
          const next = start + pageSize < all.length ? page[page.length - 1].id : null;
          return send(res, 200, { records: page, next });
        }
      }
      return fail(res, 404, 'not-found', 'no such route');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    knobs,
    setJob(id, patch) {
      Object.assign(state.jobs.get(id), patch, { updatedAt: new Date().toISOString() });
    },
    addRecord(id, record) {
      const list = state.records.get(id) || [];
      list.push(record);
      state.records.set(id, list);
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startFakeErrandsServer };

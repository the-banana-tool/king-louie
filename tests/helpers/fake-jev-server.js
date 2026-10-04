// tests/helpers/fake-jev-server.js
// A loopback stand-in for typesafe.ai's POST /v1/systemone (Jev), ported
// from the exp/jev-rerank probe. Each noul question is answered with the
// share of the query's words its candidate holds (pointwise:
// state.candidate_passage against state.query_excerpt; batched: the
// state.candidates entry whose id the question names, against state.query).
// usage.input_tokens is the body's word count. Options: the first failFirst
// requests get failStatus with failBody (and a Retry-After header when
// retryAfter is set); every answer waits delayMs; a state over
// stateTokenLimit tokens (JSON characters / 3, Jev's 32K cap) gets 422;
// a question whose criteria is a string gets 422, as the real API refuses it
// (criteria is an object such as { yes, no }); every answer names `model`.
// aborted() counts clients that dropped the connection before the answer.
// 127.0.0.1 only; never the network.
const http = require('http');

const words = (t) => String(t || '').toLowerCase().match(/[a-z0-9]+/g) || [];

function overlap(query, text) {
  const q = new Set(words(query));
  if (!q.size) return 0;
  const t = new Set(words(text));
  let n = 0;
  for (const w of q) if (t.has(w)) n += 1;
  return n / q.size;
}

async function startFakeJevServer({
  failFirst = 0, failStatus = 429, failBody = { detail: 'rate limited' }, retryAfter = null, delayMs = 0,
  stateTokenLimit = 32000, model = 'jev-1.13.0'
} = {}) {
  const state = { requests: [], failures: failFirst, failStatus, failBody, retryAfter, delayMs, aborted: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    res.on('close', () => { if (!res.writableEnded) state.aborted += 1; });
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, obj, headers = {}) => {
        const go = () => {
          if (res.destroyed) return;
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(obj));
        };
        if (state.delayMs > 0) setTimeout(go, state.delayMs);
        else go();
      };
      let body = null;
      try { body = JSON.parse(raw); } catch { return send(422, { detail: 'not json' }); }
      state.requests.push({ path: req.url, auth: req.headers.authorization || null, contentType: req.headers['content-type'] || null, body, raw });
      if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { detail: 'no route' });
      if (state.failures > 0) {
        state.failures -= 1;
        return send(state.failStatus, state.failBody, state.retryAfter !== null ? { 'retry-after': String(state.retryAfter) } : {});
      }
      if (JSON.stringify(body.state ?? '').length / 3 > stateTokenLimit) return send(422, { detail: 'state over the token limit' });
      const s = body.state || {};
      const answers = {};
      for (const [id, q] of Object.entries(body.questions || {})) {
        if (q.type !== 'noul') return send(422, { detail: 'noul only here' });
        if (typeof q.criteria === 'string') return send(422, { detail: 'criteria must be an object' });
        const text = typeof s.candidate_passage === 'string' ? s.candidate_passage : (s.candidates || []).find((c) => c.id === id)?.text;
        if (text === undefined) return send(422, { detail: 'unknown candidate' });
        answers[id] = { type: 'noul', noul: overlap(s.query_excerpt ?? s.query, text) };
      }
      return send(200, { model, answers, usage: { input_tokens: words(raw).length, output_tokens: 0 } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    setFailure({ count = 1, status = 429, body = { detail: 'failed' }, retryAfter = null } = {}) {
      state.failures = count;
      state.failStatus = status;
      state.failBody = body;
      state.retryAfter = retryAfter;
    },
    setDelay(ms) { state.delayMs = ms; },
    aborted: () => state.aborted,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(resolve);
    })
  };
}

module.exports = { startFakeJevServer, overlap };

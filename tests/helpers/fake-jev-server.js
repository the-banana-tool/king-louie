// tests/helpers/fake-jev-server.js
// A local stand-in for typesafe.ai's POST /v1/systemone: every noul question
// is answered with the share of the query's words its candidate holds
// (pointwise: state.candidate_passage; batched: the state.candidates entry
// whose id the question names). usage.input_tokens = the body's words. It
// can answer the first `failFirst` requests with 429. Never the network.
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

async function startFakeJevServer({ failFirst = 0, failStatus = 429 } = {}) {
  const state = { requests: [], failures: failFirst };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let body = null;
      try { body = JSON.parse(raw); } catch { return send(422, { detail: 'not json' }); }
      state.requests.push({ path: req.url, auth: req.headers.authorization || null, contentType: req.headers['content-type'] || null, body });
      if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { detail: 'no route' });
      if (state.failures > 0) {
        state.failures -= 1;
        return send(failStatus, { detail: 'rate limited' });
      }
      const s = body.state || {};
      const answers = {};
      for (const [id, q] of Object.entries(body.questions || {})) {
        if (q.type !== 'noul') return send(422, { detail: 'noul only here' });
        let text;
        if (typeof s.candidate_passage === 'string') text = s.candidate_passage;
        else text = (s.candidates || []).find((c) => c.id === id)?.text;
        if (text === undefined) return send(422, { detail: 'unknown candidate' });
        answers[id] = { type: 'noul', noul: overlap(s.query_excerpt ?? s.query, text) };
      }
      return send(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: words(raw).length, output_tokens: 0 } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startFakeJevServer, overlap };

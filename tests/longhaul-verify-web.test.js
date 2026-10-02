// tests/longhaul-verify-web.test.js
// `longhaul verify --web`: the loopback review server, its guards (token,
// Host, CSP) and its API, which writes the same files the terminal flow does.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startVerifyWeb, openCommand } = require('../src/longhaul/verify-web');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { readQuestions, writeQuestions, questionsFile, rejectedFile } = require('../src/longhaul/questions');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const NOW = () => new Date('2026-09-29T12:00:00.000Z');
const WEB = path.join(__dirname, '..', 'src', 'longhaul', 'web');

function request(port, { method = 'GET', url = '/', token, host = `127.0.0.1:${port}`, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let data;
    if (body !== undefined) {
      data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      h['Content-Length'] = data.length;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fixture(mutate) {
  const gen = generateSynthetic(SYNTH_FIXTURES[0]);
  if (mutate) mutate(gen);
  const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
  const questions = gen.questions.map((q) => ({ ...q, verifiedBy: null }));
  return { session, questions };
}

const running = [];
async function start(opts = {}) {
  const { session, questions } = fixture(opts.mutate);
  const saves = [];
  const onSave = (current, rejected) => saves.push({ current: current.map((q) => ({ ...q })), rejected });
  const web = await startVerifyWeb({ session, questions, reviewer: 'TT', onSave, now: NOW, port: 0 });
  running.push(web);
  const api = (url, o = {}) => request(web.port, { url, token: web.token, ...o });
  return { web, api, saves, session, questions };
}
after(async () => { for (const w of running) await w.stop(); });

describe('verify web server', () => {
  it('binds 127.0.0.1 on an ephemeral port with a 64-hex token', async () => {
    const { web } = await start();
    assert.strictEqual(web.address, '127.0.0.1');
    assert.ok(web.port > 0);
    assert.match(web.token, /^[0-9a-f]{64}$/);
    assert.strictEqual(web.url, `http://127.0.0.1:${web.port}/#${web.token}`);
  });

  it('refuses the API without the token or with a wrong one', async () => {
    const { web } = await start();
    assert.strictEqual((await request(web.port, { url: '/api/state' })).status, 401);
    assert.strictEqual((await request(web.port, { url: '/api/state', token: 'f'.repeat(64) })).status, 401);
    assert.strictEqual((await request(web.port, { url: '/api/state', token: web.token })).status, 200);
  });

  it('refuses a Host that is not this loopback port (DNS rebinding)', async () => {
    const { web } = await start();
    for (const host of ['evil.example.com', `evil.example.com:${web.port}`, '127.0.0.1', `127.0.0.1:${web.port + 1}`]) {
      const res = await request(web.port, { url: '/api/state', token: web.token, host });
      assert.ok([421, 403].includes(res.status), `${host} -> ${res.status}`);
    }
    assert.strictEqual((await request(web.port, { url: '/', host: `localhost:${web.port}` })).status, 200);
  });

  it('serves the page with CSP, nosniff, no-referrer, no-store and no CORS', async () => {
    const { web, api } = await start();
    for (const url of ['/', '/verify.js', '/verify.css', '/api/state']) {
      const res = url.startsWith('/api') ? await api(url) : await request(web.port, { url });
      assert.strictEqual(res.status, 200, url);
      assert.strictEqual(res.headers['content-security-policy'],
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    }
    assert.strictEqual((await request(web.port, { url: '/../package.json' })).status, 404);
  });

  it('reports the state: session, counts, targets and the queue', async () => {
    const { api, questions } = await start();
    const { json } = await api('/api/state');
    assert.strictEqual(json.sessionId, 'synth-small');
    assert.strictEqual(json.title, 'Synthetic session synth-small');
    assert.strictEqual(json.queue.length, questions.length);
    assert.deepStrictEqual(Object.keys(json.queue[0]).sort(), ['askAtSeq', 'id', 'kind', 'status']);
    assert.deepStrictEqual(json.counts, { accepted: 0, edited: 0, rejected: 0, skipped: 0 });
    assert.deepStrictEqual(json.targets, { total: 40, abstain: 5, superseded: 5 });
    assert.strictEqual(json.verified.total, 0);
  });

  it('returns a question with distance, bucket, evidence and the askAt message', async () => {
    const { api, questions } = await start();
    const q = questions.find((x) => x.kind === 'tool-observed');
    const { status, json } = await api(`/api/question/${encodeURIComponent(q.id)}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(json.question.question, q.question);
    assert.strictEqual(json.distance.messages, q.askAtSeq - Math.max(...q.evidenceSeqs));
    assert.match(json.bucket, /K/);
    assert.strictEqual(json.evidence.length, q.evidenceSeqs.length);
    const ev = json.evidence[0];
    assert.deepStrictEqual(Object.keys(ev).sort(), ['chars', 'label', 'sender', 'seq', 'text', 'timestamp', 'truncated']);
    assert.strictEqual(ev.sender, 'toolResult');
    assert.strictEqual(json.askAt.seq, q.askAtSeq);
    assert.strictEqual((await api('/api/question/nope')).status, 404);
  });

  it('caps long message text and flags it truncated', async () => {
    let seq;
    const { api, questions } = await start({ mutate: (gen) => {
      seq = gen.questions.find((x) => x.kind === 'tool-observed').evidenceSeqs[0];
      gen.index.get(seq).result = 'y'.repeat(50000);
    } });
    const q = questions.find((x) => x.evidenceSeqs.includes(seq));
    const { json } = await api(`/api/question/${q.id}`);
    const ev = json.evidence.find((e) => e.seq === seq);
    assert.strictEqual(ev.chars, 50000);
    assert.strictEqual(ev.truncated, true);
    assert.strictEqual(ev.text.length, 20000);
  });

  it('returns surrounding messages, refusing a bad seq with 400', async () => {
    const { api, session } = await start();
    const { status, json } = await api('/api/context?around=50&before=5&after=2');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.messages.map((m) => m.seq), [45, 46, 47, 48, 49, 50, 51, 52]);
    assert.deepStrictEqual((await api('/api/context?around=1')).json.messages.map((m) => m.seq), [1, 2, 3]);
    for (const bad of ['abc', '1.5', '0', String(session.index.maxSeq + 1), '', '-3', '1e1']) {
      assert.strictEqual((await api(`/api/context?around=${bad}`)).status, 400, bad);
    }
    assert.strictEqual((await api('/api/context?around=5&before=x')).status, 400);
  });

  it('returns a <script> message as plain JSON text', async () => {
    let seq;
    const { api, questions } = await start({ mutate: (gen) => {
      seq = gen.questions.find((x) => x.kind === 'user-said').evidenceSeqs[0];
      gen.index.get(seq).text = '<script>alert(1)</script> & "quotes"';
    } });
    const q = questions.find((x) => x.evidenceSeqs.includes(seq));
    const res = await api(`/api/question/${q.id}`);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.strictEqual(res.json.evidence.find((e) => e.seq === seq).text, '<script>alert(1)</script> & "quotes"');
  });

  it('only accepts JSON POSTs for mutations', async () => {
    const { api, questions, saves } = await start();
    const id = questions[0].id;
    assert.strictEqual((await api('/api/accept')).status, 405);
    assert.strictEqual((await api('/api/accept', { method: 'POST', body: `id=${id}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.strictEqual((await api('/api/accept', { method: 'POST', body: '{not json' })).status, 400);
    assert.strictEqual((await api('/api/accept', { method: 'POST', body: { id: 'nope' } })).status, 404);
    assert.strictEqual(saves.length, 0);
  });

  it('accept refuses an invalid question with 422 and the errors', async () => {
    const { api, questions, saves } = await start({ mutate: (gen) => { gen.questions[0].evidenceSeqs = [gen.questions[0].askAtSeq]; } });
    const res = await api('/api/accept', { method: 'POST', body: { id: questions[0].id } });
    assert.strictEqual(res.status, 422);
    assert.match(res.json.errors.join('\n'), /evidence-after-ask/);
    assert.strictEqual(saves.length, 0);
  });

  it('edit validates, saves without accepting; accept then verifies', async () => {
    const { api, questions, saves } = await start();
    const q = questions[0];
    const bad = await api('/api/edit', { method: 'POST', body: { id: q.id, fields: { evidenceSeqs: [q.askAtSeq + 1] } } });
    assert.strictEqual(bad.status, 422);
    assert.ok(bad.json.errors.length);
    assert.strictEqual(saves.length, 0);
    const ok = await api('/api/edit', { method: 'POST', body: { id: q.id, fields: { answer: 'Edited answer' } } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.question.verifiedBy, null);
    assert.strictEqual(ok.json.state.queue.find((x) => x.id === q.id).status, 'edited');
    const acc = await api('/api/accept', { method: 'POST', body: { id: q.id } });
    assert.strictEqual(acc.status, 200);
    assert.strictEqual(saves.at(-1).current.find((x) => x.id === q.id).verifiedBy, 'human:TT');
    assert.strictEqual(saves.at(-1).current.find((x) => x.id === q.id).answer, 'Edited answer');
  });

  it('skip and reject; a rejected question cannot be decided again', async () => {
    const { api, questions, saves } = await start();
    const [a, b] = questions;
    assert.strictEqual((await api('/api/skip', { method: 'POST', body: { id: a.id } })).json.state.counts.skipped, 1);
    const rej = await api('/api/reject', { method: 'POST', body: { id: b.id, reason: 'duplicate' } });
    assert.strictEqual(rej.status, 200);
    assert.strictEqual(saves.at(-1).rejected.rejectReason, 'duplicate');
    assert.strictEqual((await api('/api/accept', { method: 'POST', body: { id: b.id } })).status, 409);
    const shown = await api(`/api/question/${b.id}`);
    assert.strictEqual(shown.json.status, 'rejected');
  });

  it('quit stops the server and resolves with the counts', async () => {
    const { web, api, questions } = await start();
    await api('/api/accept', { method: 'POST', body: { id: questions[0].id } });
    const res = await api('/api/quit', { method: 'POST', body: {} });
    assert.strictEqual(res.status, 200);
    const counts = await web.done;
    assert.deepStrictEqual(counts, { accepted: 1, edited: 0, rejected: 0, skipped: 0, stopped: true });
    await assert.rejects(request(web.port, { url: '/' }));
  });

  it('the page script renders with textContent, never innerHTML', () => {
    const js = fs.readFileSync(path.join(WEB, 'verify.js'), 'utf8');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    const html = fs.readFileSync(path.join(WEB, 'verify.html'), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline script');
    assert.doesNotMatch(html, /\bstyle=|<style/, 'no inline style');
    assert.doesNotMatch(html + js, /https?:\/\//, 'no external assets');
  });

  it('opens the browser with argument lists, never a shell string', () => {
    const url = 'http://127.0.0.1:1234/#ab';
    assert.deepStrictEqual(openCommand('darwin', url).slice(0, 2), ['open', [url]]);
    assert.deepStrictEqual(openCommand('linux', url).slice(0, 2), ['xdg-open', [url]]);
    const [cmd, args] = openCommand('win32', url);
    assert.strictEqual(cmd, 'cmd');
    assert.deepStrictEqual(args, ['/d', '/c', 'start', '""', url]);
  });
});

describe('longhaul verify --web', () => {
  it('--no-open starts, prints the URL with a 64-hex token, writes decisions and quits', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const file = questionsFile(root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map((q) => ({ ...q, verifiedBy: null })));
    const stdout = sink();
    const running = main(['verify', '--session', 'synth-small', '--reviewer', 'TT', '--web', '--no-open'], { stdout, stderr: sink(), env });
    let m;
    for (let i = 0; i < 200 && !(m = stdout.text.match(/Review at http:\/\/127\.0\.0\.1:(\d+)\/#([0-9a-f]{64})\n/)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(m, stdout.text);
    const port = Number(m[1]);
    const token = m[2];
    const state = (await request(port, { url: '/api/state', token })).json;
    const [first, second] = state.queue;
    assert.strictEqual((await request(port, { url: '/api/accept', method: 'POST', token, body: { id: first.id } })).status, 200);
    assert.strictEqual((await request(port, { url: '/api/reject', method: 'POST', token, body: { id: second.id, reason: 'duplicate' } })).status, 200);
    await request(port, { url: '/api/quit', method: 'POST', token, body: {} });
    assert.strictEqual(await running, 0);
    const after = await readQuestions(file);
    assert.strictEqual(after.length, state.queue.length - 1);
    assert.strictEqual(after.filter((q) => q.verifiedBy === 'human:TT').length, 1);
    const rejected = fs.readFileSync(rejectedFile(root, 'synth-small'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(rejected.map((r) => [r.id, r.rejectReason]), [[second.id, 'duplicate']]);
    assert.match(stdout.text, /1 accepted, 0 edited, 1 rejected, 0 skipped \(stopped\)\./);
    assert.match(stdout.text, /verified for synth-small: 1 /);
  });

  it('refuses a bad --port', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const file = questionsFile(root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map((q) => ({ ...q, verifiedBy: null })));
    for (const port of ['abc', '70000', '-1']) {
      assert.strictEqual(await main(['verify', '--session', 'synth-small', '--reviewer', 'TT', '--web', '--no-open', '--port', port], { stdout: sink(), stderr: sink(), env }), 2);
    }
  });
});

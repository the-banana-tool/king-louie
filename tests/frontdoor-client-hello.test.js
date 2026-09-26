// tests/frontdoor-client-hello.test.js — fleet stage 4 §3.2.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { parseClientHello, peekClientHello, ClientHelloError, MAX_HELLO_BYTES } = require('../src/frontdoor/tls/client-hello');

// The first flight a real Node TLS client sends.
async function captureHello({ servername = 'mcp.kl.example.com', alpn = ['acme-tls/1', 'http/1.1'] } = {}) {
  const chunks = [];
  const server = net.createServer((socket) => {
    socket.on('data', (d) => {
      chunks.push(d);
      const r = parseClientHello(Buffer.concat(chunks));
      if (!r.incomplete) socket.destroy();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, ALPNProtocols: alpn, rejectUnauthorized: false });
  client.on('error', () => {});
  await new Promise((r) => client.once('close', r));
  server.close();
  return Buffer.concat(chunks);
}

// The same handshake message re-framed across `parts` TLS records.
function reframe(hello, parts) {
  const handshake = [];
  for (let off = 0; off < hello.length;) {
    const len = hello.readUInt16BE(off + 3);
    handshake.push(hello.subarray(off + 5, off + 5 + len));
    off += 5 + len;
  }
  const body = Buffer.concat(handshake);
  const size = Math.ceil(body.length / parts);
  const out = [];
  for (let i = 0; i < body.length; i += size) {
    const frag = body.subarray(i, i + size);
    const header = Buffer.from([0x16, 0x03, 0x01, 0, 0]);
    header.writeUInt16BE(frag.length, 3);
    out.push(header, frag);
  }
  return Buffer.concat(out);
}

let hello;
before(async () => { hello = await captureHello(); });

describe('parseClientHello', () => {
  it('reads SNI and ALPN from a real hello', () => {
    assert.deepEqual(parseClientHello(hello), { serverName: 'mcp.kl.example.com', alpn: ['acme-tls/1', 'http/1.1'] });
  });

  it('a hello with no SNI parses with serverName null', async () => {
    const noSni = await captureHello({ servername: '' });
    assert.equal(parseClientHello(noSni).serverName, null);
  });

  it('reassembles a hello split across three records', () => {
    assert.deepEqual(parseClientHello(reframe(hello, 3)), { serverName: 'mcp.kl.example.com', alpn: ['acme-tls/1', 'http/1.1'] });
  });

  it('says incomplete for every proper prefix', () => {
    for (let n = 0; n < hello.length; n += 7) assert.deepEqual(parseClientHello(hello.subarray(0, n)), { incomplete: true }, `prefix ${n}`);
  });

  it('refuses a record that is not a handshake, bad lengths, and anything over 16 KiB', () => {
    const notHandshake = Buffer.from(hello);
    notHandshake[0] = 0x17;
    assert.throws(() => parseClientHello(notHandshake), ClientHelloError);
    const badSni = Buffer.from(hello);
    const idx = badSni.indexOf(Buffer.from('mcp.kl.example.com'));
    badSni.writeUInt16BE(0xffff, idx - 2);
    assert.throws(() => parseClientHello(badSni), ClientHelloError);
    const huge = Buffer.from([0x16, 0x03, 0x01, 0x40, 0x01, 0x01, 0x00, 0x40, 0x00]);
    assert.throws(() => parseClientHello(huge), ClientHelloError);
  });

  it('survives 10 000 mutations: a result, incomplete, or ClientHelloError — nothing else', () => {
    const rand = (n) => crypto.randomInt(n);
    for (let i = 0; i < 10000; i += 1) {
      let m = Buffer.from(i % 2 ? hello : reframe(hello, 1 + rand(4)));
      const ops = 1 + rand(4);
      for (let k = 0; k < ops; k += 1) {
        const op = rand(4);
        const at = rand(m.length || 1);
        if (op === 0 && m.length) m[at] = rand(256);
        else if (op === 1) m = m.subarray(0, at);
        else if (op === 2) m = Buffer.concat([m.subarray(0, at), crypto.randomBytes(1 + rand(8)), m.subarray(at)]);
        else if (m.length > 4) m.writeUInt16BE(rand(65536), Math.min(at, m.length - 2));
      }
      try {
        const r = parseClientHello(m);
        assert.ok(r.incomplete === true || Array.isArray(r.alpn));
      } catch (err) {
        assert.ok(err instanceof ClientHelloError, `mutation ${i}: ${err && err.stack}`);
      }
    }
  });

  // Beyond the brief: the dispatch's hardening rules.

  const withName = (name) => {
    const m = Buffer.from(hello);
    const idx = m.indexOf(Buffer.from('mcp.kl.example.com'));
    Buffer.from(name, 'latin1').copy(m, idx);
    return m;
  };

  it('lower-cases the server name', () => {
    assert.equal(parseClientHello(withName('MCP.KL.Example.COM')).serverName, 'mcp.kl.example.com');
  });

  it('refuses a server name with non-ASCII, control or space bytes, or an empty label', () => {
    for (const name of ['mcp.kl.exémple.com', 'mcp.kl.ex\u0001mple.com', 'mcp.kl.ex mple.com', 'mcp.kl.ex\u007fmple.com',
      '.cp.kl.example.com', 'mcp..l.example.com', 'mcp.kl.example.co.']) {
      assert.throws(() => parseClientHello(withName(name)), (err) => err instanceof ClientHelloError && err.code === 'malformed', JSON.stringify(name));
    }
  });

  it('ignores records after a complete hello (0-RTT early data), but not a bad record before it ends', () => {
    const early = Buffer.from([0x17, 0x03, 0x03, 0x00, 0x02, 0xaa, 0xbb]);
    assert.equal(parseClientHello(Buffer.concat([hello, early])).serverName, 'mcp.kl.example.com');
    const split = reframe(hello, 2);
    const firstLen = split.readUInt16BE(3);
    const cut = Buffer.concat([split.subarray(0, 5 + firstLen), early]);
    assert.throws(() => parseClientHello(cut), ClientHelloError);
  });

  it('refuses a non-buffer, an empty record, a non-TLS record version, and a handshake that is not a ClientHello', () => {
    assert.throws(() => parseClientHello('hello'), ClientHelloError);
    assert.throws(() => parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00])), ClientHelloError);
    const v = Buffer.from(hello);
    v[1] = 0x02;
    assert.throws(() => parseClientHello(v), ClientHelloError);
    const t = Buffer.from(hello);
    t[5] = 0x02;
    assert.throws(() => parseClientHello(t), ClientHelloError);
  });

  it('refuses a hello over 16 KiB spread across many records', () => {
    const first = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x3f, 0xff]);
    const filler = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x40, 0x00]), Buffer.alloc(0x4000)]);
    assert.throws(() => parseClientHello(Buffer.concat([first, filler])), ClientHelloError);
  });

  it('accepts a hello in 64 records and refuses one in more (Ruling T15-records)', () => {
    const byRecords = (n) => {
      const body = reframe(hello, 1).subarray(5);
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const frag = body.subarray(Math.floor((i * body.length) / n), Math.floor(((i + 1) * body.length) / n));
        out.push(Buffer.from([0x16, 0x03, 0x01, frag.length >> 8, frag.length & 0xff]), frag);
      }
      assert.equal(out.length / 2, n, 'the hello divides into exactly n records');
      return Buffer.concat(out);
    };
    assert.equal(parseClientHello(byRecords(64)).serverName, 'mcp.kl.example.com');
    assert.throws(() => parseClientHello(byRecords(65)), /more than 64 records/);
    const oneByte = Buffer.concat([...hello.subarray(5, 75)].map((b) => Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01, b])));
    assert.throws(() => parseClientHello(oneByte), ClientHelloError);
  });

  it('skips non-printable ALPN entries such as GREASE and keeps the rest (Ruling T15-alpn)', async () => {
    const h = await captureHello({ alpn: ['zz', 'h2'] });
    const m = Buffer.from(h);
    const at = m.indexOf(Buffer.from([0x02, 0x7a, 0x7a, 0x02, 0x68, 0x32]));
    assert.ok(at > 0);
    m[at + 1] = 0x0a;
    m[at + 2] = 0x0a;
    assert.deepEqual(parseClientHello(m).alpn, ['h2']);
  });

  it('survives 5 000 random buffers behind a handshake record header', () => {
    for (let i = 0; i < 5000; i += 1) {
      const m = Buffer.concat([Buffer.from([0x16, 0x03, crypto.randomInt(4)]), crypto.randomBytes(crypto.randomInt(600))]);
      try {
        parseClientHello(m);
      } catch (err) {
        assert.ok(err instanceof ClientHelloError, `buffer ${m.toString('hex')}: ${err && err.stack}`);
      }
    }
  });
});

describe('peekClientHello', () => {
  async function pair() {
    let serverSide;
    const server = net.createServer((s) => { serverSide = s; });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = net.connect(server.address().port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    while (!serverSide) await new Promise((r) => setImmediate(r));
    return { server, client, serverSide };
  }

  it('reads a hello that arrives in many TCP chunks and puts every byte back', async () => {
    const { server, client, serverSide } = await pair();
    const peeked = peekClientHello(serverSide, { timeoutMs: 2000 });
    for (let i = 0; i < hello.length; i += 50) {
      client.write(hello.subarray(i, i + 50));
      await new Promise((r) => setTimeout(r, 2));
    }
    const { hello: parsed, buffer } = await peeked;
    assert.equal(parsed.serverName, 'mcp.kl.example.com');
    assert.deepEqual(buffer, hello);
    const again = [];
    serverSide.on('data', (d) => again.push(d));
    serverSide.resume();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(Buffer.concat(again), hello, 'unshift gives the next reader the same bytes');
    client.destroy();
    server.close();
  });

  it('gives up after the timeout and past 16 KiB', async () => {
    const a = await pair();
    await assert.rejects(peekClientHello(a.serverSide, { timeoutMs: 50 }), /timed out/);
    a.client.destroy();
    a.server.close();
    const b = await pair();
    const p = peekClientHello(b.serverSide, { timeoutMs: 2000 });
    const endless = Buffer.from([0x16, 0x03, 0x01, 0x3f, 0xff, 0x01, 0x00, 0x3f, 0xfb]);
    b.client.write(Buffer.concat([endless, Buffer.alloc(MAX_HELLO_BYTES)]));
    await assert.rejects(p, /16384|malformed/);
    b.client.destroy();
    b.server.close();
  });

  // Beyond the brief: no listener or timer outlives the peek, on any path.

  class FakeSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.paused = false; this.unshifted = null; }
    pause() { this.paused = true; return this; }
    unshift(b) { this.unshifted = b; }
  }
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const assertClean = (s, timersBefore, label) => {
    for (const ev of ['data', 'close', 'error', 'end']) assert.equal(s.listenerCount(ev), 0, `${label}: ${ev} listener left`);
    assert.equal(timers(), timersBefore, `${label}: timer left`);
  };

  it('leaves no listener or timer behind on resolve, parse error, over-size, close, error and timeout', async () => {
    const cases = [
      ['resolve', (s) => { s.emit('data', hello.subarray(0, 10)); s.emit('data', hello.subarray(10)); }, null],
      ['parse error', (s) => s.emit('data', Buffer.from([0x17, 0x03, 0x03, 0x00, 0x01, 0x00])), ClientHelloError],
      ['over size', (s) => s.emit('data', Buffer.alloc(200, 0x16)), /over 100 bytes/],
      ['close', (s) => s.emit('close'), /closed before/],
      ['error', (s) => s.emit('error', new Error('ECONNRESET')), /ECONNRESET/],
      ['timeout', () => {}, /timed out/]
    ];
    for (const [label, drive, expected] of cases) {
      const s = new FakeSocket();
      const before = timers();
      const p = peekClientHello(s, { maxBytes: label === 'over size' ? 100 : MAX_HELLO_BYTES, timeoutMs: label === 'timeout' ? 20 : 60000 });
      drive(s);
      if (expected) await assert.rejects(p, expected, label);
      else {
        const { hello: parsed, buffer } = await p;
        assert.equal(parsed.serverName, 'mcp.kl.example.com');
        assert.ok(s.paused, 'paused before the hand-over');
        assert.deepEqual(s.unshifted, buffer);
      }
      assertClean(s, before, label);
      s.emit('data', hello); // late bytes reach nobody and throw nothing
    }
  });

  it('rejects at once for a socket that is already destroyed, leaving nothing behind', async () => {
    const s = new FakeSocket();
    s.destroyed = true;
    const before = timers();
    await assert.rejects(peekClientHello(s), /closed before/);
    assertClean(s, before, 'destroyed');
  });

  it('a hello sent as 1-byte records is refused by the 65th record (Ruling T15-records)', async () => {
    const s = new FakeSocket();
    const p = peekClientHello(s, { timeoutMs: 60000 });
    let sent = 0;
    for (const b of hello.subarray(5)) {
      s.emit('data', Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01, b]));
      sent += 1;
      if (s.listenerCount('data') === 0) break; // the peek has finished
    }
    await assert.rejects(p, /more than 64 records/);
    assert.equal(sent, 65, 'refused as soon as the 65th record header is in');
  });

  it('a large one-record hello fed one byte at a time is parsed a bounded number of times', async () => {
    // One 16 000-byte record: a padding extension (21) carries the bulk.
    const pad = 16000 - 4 - 2 - 32 - 1 - 4 - 2 - 2 - 4;
    const body = Buffer.concat([
      Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00, 0x00, 0x02, 0x13, 0x01, 0x01, 0x00]),
      Buffer.from([(pad + 4) >> 8, (pad + 4) & 0xff, 0x00, 0x15, pad >> 8, pad & 0xff]), Buffer.alloc(pad)
    ]);
    const hs = Buffer.concat([Buffer.from([0x01, 0x00, body.length >> 8, body.length & 0xff]), body]);
    const rec = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, hs.length >> 8, hs.length & 0xff]), hs]);
    assert.deepEqual(parseClientHello(rec), { serverName: null, alpn: [] });
    const s = new FakeSocket();
    const p = peekClientHello(s, { timeoutMs: 60000 });
    const started = process.hrtime.bigint();
    for (let i = 0; i < rec.length; i += 1) s.emit('data', rec.subarray(i, i + 1));
    const { buffer } = await p;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(buffer, rec);
    // Re-parsing every chunk costs whole seconds here; parsing only when a
    // record header or a whole record arrives costs a few milliseconds.
    assert.ok(ms < 500, `took ${ms} ms`);
  });

  it('never destroys the socket itself', async () => {
    const { server, client, serverSide } = await pair();
    const p = peekClientHello(serverSide, { timeoutMs: 2000 });
    client.write(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]));
    await assert.rejects(p, ClientHelloError);
    assert.equal(serverSide.destroyed, false);
    serverSide.destroy();
    client.destroy();
    server.close();
  });
});

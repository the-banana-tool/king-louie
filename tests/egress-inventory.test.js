// tests/egress-inventory.test.js
// Every file under src/ (outside src/longhaul/) that can send something off
// this process is listed, with a label a person chose (spec
// 2026-10-13-local-inference-design.md §7.6):
//
//   gated         asks the egress policy itself before it sends (and so says
//                 "egress")
//   behind-gate   sends only for a caller that asked; `gate` names the file
//                 that holds it, which must itself name the egress policy
//   no-chat-text  sends no chat's or case's text off this machine
//                 (credentials, model lists, health checks, a local pipe)
//   tool          a tool the model calls; tools behave as now (R-LI-9)
//   transport     carries text to the owner's own channel, device, node or an
//                 executor by design; not a model call, and not covered by
//                 the private mark (spec §16.2)
//
// A file that matches and is not in tests/fixtures/egress-inventory.json
// fails this test, so a new caller of fetch, a socket, a provider or an
// embedder cannot appear without someone deciding which it is.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'egress-inventory.json');
const LABELS = ['gated', 'behind-gate', 'no-chat-text', 'tool', 'transport'];

// What "can send" looks like in this codebase.
const SENDS = Object.freeze({
  fetch: /\bfetch\(|globalThis\.fetch|[=:?|(,]\s*fetch\s*[;,)|\r\n]|typeof fetch\b/,
  request: /\bhttps?\.(request|get)\(|\bhttp2\.connect\(/,
  socket: /\b(net|tls)\.(connect|createConnection)\(|new (net\.)?Socket\(/,
  websocket: /new WebSocket\(/,
  factory: /ProviderFactory\.(create|createProvider|fromEnv)\(/,
  provider: /new [A-Z][A-Za-z]*Provider\(/,
  embed: /\.embed(Query|Documents|Texts|Batch)?\(/,
  capture: /\.capture(Success|Failure|Preference)?\(/,
  package: /require\(['"](ws|nodemailer|imapflow|discord\.js|@slack\/bolt|acme-client|playwright|@huggingface\/transformers|bonjour-service)['"]\)/
});

// Code only: a line that is all comment says nothing about what a file does.
const code = (text) => text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

function jsFiles(dir, skip = () => false) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (skip(rel)) continue;
    if (entry.isDirectory()) out.push(...jsFiles(full, skip));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function senders() {
  const found = new Map();
  for (const rel of jsFiles(path.join(ROOT, 'src'), (r) => r === 'src/longhaul')) {
    const text = code(read(rel));
    const how = Object.entries(SENDS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    if (how.length) found.set(rel, how);
  }
  return found;
}

describe('the egress inventory', () => {
  const inventory = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const found = senders();

  it('every file that can send is listed', () => {
    const missing = [...found.keys()].filter((rel) => !Object.prototype.hasOwnProperty.call(inventory, rel));
    assert.deepStrictEqual(missing.map((rel) => `${rel} (${found.get(rel).join(', ')})`), [],
      'these files can send and are not in tests/fixtures/egress-inventory.json: give each a label and a reason');
    assert.ok(found.size > 40, 'the walk found the senders');
  });

  it('the list names no file that cannot send any more', () => {
    assert.deepStrictEqual(Object.keys(inventory).filter((rel) => !found.has(rel)), []);
  });

  it('every entry has one of the five labels and a one-line reason', () => {
    for (const [rel, entry] of Object.entries(inventory)) {
      const keys = ['label', 'why', ...(entry.label === 'behind-gate' ? ['gate'] : [])];
      assert.deepStrictEqual(Object.keys(entry).sort(), keys.sort(), rel);
      assert.ok(LABELS.includes(entry.label), `${rel}: ${entry.label}`);
      assert.ok(typeof entry.why === 'string' && entry.why.trim().length >= 20 && !/[\r\n]/.test(entry.why), rel);
    }
    assert.deepStrictEqual(Object.keys(inventory), [...Object.keys(inventory)].sort(), 'the list is kept sorted');
  });

  it('a gated file names the egress policy', () => {
    const silent = Object.entries(inventory)
      .filter(([rel, entry]) => entry.label === 'gated' && !/egress/.test(read(rel)))
      .map(([rel]) => rel);
    assert.deepStrictEqual(silent, []);
  });

  it('a file behind a gate names a gate that exists and names the egress policy', () => {
    const loose = [];
    for (const [rel, entry] of Object.entries(inventory)) {
      if (entry.label !== 'behind-gate') continue;
      const gate = String(entry.gate || '');
      if (!/^src\/[\w./-]+\.js$/.test(gate) || gate === rel || !fs.existsSync(path.join(ROOT, gate)) || !/egress/.test(read(gate))) loose.push(`${rel} → ${gate}`);
    }
    assert.deepStrictEqual(loose, []);
  });

  it('the patterns catch each way of sending this codebase uses', () => {
    const hit = (text) => Object.entries(SENDS).filter(([, pattern]) => pattern.test(code(text))).map(([name]) => name);
    assert.deepStrictEqual(hit('const res = await fetch(url);'), ['fetch']);
    assert.deepStrictEqual(hit('const send = globalThis.fetch;'), ['fetch']);
    assert.deepStrictEqual(hit('this.fetchImpl = typeof options.fetchImpl === \'function\' ? options.fetchImpl : fetch;'), ['fetch']);
    assert.deepStrictEqual(hit('await this._deps.fetch(url, {});'), ['fetch']);
    assert.deepStrictEqual(hit('const req = https.request(options);'), ['request']);
    assert.deepStrictEqual(hit('const socket = tls.connect({ host });'), ['socket']);
    assert.deepStrictEqual(hit('const ws = new WebSocket(url);'), ['websocket']);
    assert.deepStrictEqual(hit('ProviderFactory.create(name, key)'), ['factory']);
    assert.deepStrictEqual(hit('new OpenAIEmbeddingProvider({ apiKey })'), ['provider']);
    assert.deepStrictEqual(hit('await this.embeddingProvider.embed(texts)'), ['embed']);
    assert.deepStrictEqual(hit('memory.captureSuccess(text)'), ['capture']);
    assert.deepStrictEqual(hit('const WebSocket = require(\'ws\');'), ['package']);
    assert.deepStrictEqual(hit('// fetch(url) is how it used to be done'), []);
    assert.deepStrictEqual(hit('const fetched = fetchAll();'), []);
  });
});

describe('what the inventory leans on', () => {
  it('R-LI-32: nothing under a chat turn calls capture', () => {
    const files = ['src/ipc/chat-handlers.js', ...['src/execution', 'src/cases', 'src/tools'].flatMap((dir) => jsFiles(path.join(ROOT, dir)))];
    assert.ok(files.length > 100);
    assert.deepStrictEqual(files.filter((rel) => SENDS.capture.test(code(read(rel)))), []);
  });

  it('the core gives memory no embedding provider', () => {
    // src/memory/ sends only when it is handed one (spec §7.5: "Stays off
    // for a private chat if one is ever wired").
    const core = read('src/core/create-core.js');
    const built = core.match(/new MemoryManager\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(built.length >= 1);
    for (const call of built) assert.ok(!/embeddingProvider/.test(call), call);
    assert.ok(!/embeddingProvider/.test(read('src/ipc/memory-handlers.js')));
  });

  it('R-LI-28: the new modules log no message text', () => {
    const files = [
      ...jsFiles(path.join(ROOT, 'src', 'models')).filter((rel) => /\/local-[a-z-]+\.js$/.test(rel)),
      'src/models/egress.js',
      'src/providers/local-server-provider.js',
      'src/tools/private-refusals.js'
    ];
    assert.ok(files.length >= 7, files.join(', '));
    const offending = [];
    for (const rel of files) {
      const text = read(rel);
      // Each log call, to the end of its statement.
      for (const match of text.matchAll(/\blog\.(trace|debug|info|warn|error|fatal)\(([\s\S]*?)\);/g)) {
        if (/\b(messages?|content|prompt|text|body)\b/.test(match[2].replace(/\.message\b/g, ''))) offending.push(`${rel}: ${match[0].slice(0, 120)}`);
      }
    }
    assert.deepStrictEqual(offending, []);
  });
});

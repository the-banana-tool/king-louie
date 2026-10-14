// tests/egress-inventory.test.js
// Every file under src/ (outside src/longhaul/) that can send something off
// this process is listed, with a label a person chose (spec
// 2026-10-13-local-inference-design.md §7.6):
//
//   gated         asks the egress policy itself before it sends; `check` is
//                 the exact code of that check, which must be in the file's
//                 code (comments do not count) and name the policy or the
//                 private mark
//   behind-gate   sends only for a caller that asked; `gate` names the file
//                 that holds the check and `check` is its exact code there,
//                 held to the same rule
//   no-chat-text  sends no chat's or case's text off this machine
//                 (credentials, model lists, health checks, a local pipe)
//   tool          a tool the model calls; tools behave as now (R-LI-9)
//   transport     carries text to the owner's own channel, device, node or an
//                 executor by design; not a model call, and not covered by
//                 the private mark (spec §16.2)
//
// A file whose sends are not all of one kind is listed by `sites` instead:
// each site names a piece of code (`match`) and has its own label, reason,
// and `gate`/`check` as above. Every line of that file that can send must
// hold one site's `match`, and every `match` must still be in the file
// (src/core/create-core.js is listed this way).
//
// A file that matches and is not in tests/fixtures/egress-inventory.json
// fails this test, so a new caller of fetch, a socket, a provider or an
// embedder cannot appear without someone deciding which it is.
//
// What "can send" means here is SENDS below: a network call, a provider or
// embedder being built, a provider class's own request, and a call by name
// on a provider-shaped object (sendMessage, sendMessageWithTools,
// streamMessage, streamMessageWithTools, rerank, embed, provider.ask).
// Out of scope, so not found by this walk: a provider method reached any
// other way (held in a variable, called through a wrapper of another name
// such as oneShot(provider, ...) in src/execution/advisor.js or a case
// role's routedProvider, through Reflect or a computed property). Those
// callers are covered only where the provider they use is built or
// wrapped (the router, CaseRuntime#routedProvider, the files above), not
// file by file.
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
  package: /require\(['"](ws|nodemailer|imapflow|discord\.js|@slack\/bolt|acme-client|playwright|@huggingface\/transformers|bonjour-service)['"]\)/,
  // Review fix, item 4b: calls on a provider instance someone else built,
  // and a provider class's own request.
  call: /\.(sendMessage|sendMessageWithTools|streamMessage|streamMessageWithTools|rerank)\(|\b(provider|client)\.ask\(/,
  method: /\bthis\.request\(/
});

// A check must name the policy or the private mark in code.
const POLICY = /egress|keepLocal|keptLocal|localOnly|private|targetAllowed/i;

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

// The lines of a file's code that can send.
function sendingLines(text) {
  return code(text).split('\n').filter((line) => Object.values(SENDS).some((pattern) => pattern.test(`${line}\n`)));
}

// An entry's labelled parts: the entry itself, or each of its sites.
const partsOf = (rel, entry) => (entry.sites ? Object.entries(entry.sites).map(([name, site]) => [`${rel} [${name}]`, site]) : [[rel, entry]]);

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
      if (entry.sites) {
        assert.deepStrictEqual(Object.keys(entry), ['sites'], rel);
        assert.ok(Object.keys(entry.sites).length >= 2, `${rel}: sites are for a file with more than one kind of send`);
      }
      for (const [where, part] of partsOf(rel, entry)) {
        const keys = [...(entry.sites ? ['match'] : []), 'label', 'why', ...(part.label === 'behind-gate' ? ['gate', 'check'] : []), ...(part.label === 'gated' ? ['check'] : [])];
        assert.deepStrictEqual(Object.keys(part).sort(), keys.sort(), where);
        assert.ok(LABELS.includes(part.label), `${where}: ${part.label}`);
        assert.ok(typeof part.why === 'string' && part.why.trim().length >= 20 && !/[\r\n]/.test(part.why), where);
      }
    }
    assert.deepStrictEqual(Object.keys(inventory), [...Object.keys(inventory)].sort(), 'the list is kept sorted');
  });

  it('a file listed by sites has a site for every line that can send, and every site is still there', () => {
    const loose = [];
    for (const [rel, entry] of Object.entries(inventory)) {
      if (!entry.sites) continue;
      const text = code(read(rel));
      const sites = Object.entries(entry.sites);
      for (const [name, site] of sites) {
        if (typeof site.match !== 'string' || site.match.length < 12 || !text.includes(site.match)) loose.push(`${rel} [${name}] is not in the code`);
      }
      for (const line of sendingLines(read(rel))) {
        if (!sites.some(([, site]) => line.includes(site.match))) loose.push(`${rel}: no site for ${line.trim().slice(0, 100)}`);
      }
    }
    assert.deepStrictEqual(loose, []);
  });

  it('a gated file names the egress policy', () => {
    const silent = Object.entries(inventory)
      .flatMap(([rel, entry]) => partsOf(rel, entry).map(([where, part]) => [rel, where, part]))
      .filter(([rel, , part]) => part.label === 'gated' && !/egress/.test(read(rel)))
      .map(([, where]) => where);
    assert.deepStrictEqual(silent, []);
  });

  it('a gated file holds its check in code, and the check names the policy or the private mark', () => {
    const loose = [];
    for (const [rel, entry] of Object.entries(inventory)) {
      for (const [where, part] of partsOf(rel, entry)) {
        if (part.label !== 'gated') continue;
        if (typeof part.check !== 'string' || !POLICY.test(part.check) || !code(read(rel)).includes(part.check)) loose.push(where);
      }
    }
    assert.deepStrictEqual(loose, []);
  });

  it('a file behind a gate names a gate that exists and holds the named check in its code', () => {
    const loose = [];
    for (const [rel, entry] of Object.entries(inventory)) {
      for (const [where, part] of partsOf(rel, entry)) {
        if (part.label !== 'behind-gate') continue;
        const gate = String(part.gate || '');
        const ok = /^src\/[\w./-]+\.js$/.test(gate) && gate !== rel && fs.existsSync(path.join(ROOT, gate))
          && typeof part.check === 'string' && POLICY.test(part.check) && code(read(gate)).includes(part.check);
        if (!ok) loose.push(`${where} → ${gate}`);
      }
    }
    assert.deepStrictEqual(loose, []);
  });

  it('a comment that names the policy is not a check', () => {
    // What the old rule accepted: the word in a comment.
    assert.ok(!code('// checks the egress policy\nreturn send(text);').includes('egress'));
  });

  it('Jev is listed, behind its real gate', () => {
    for (const rel of ['src/history/jev-reranker.js', 'src/providers/typesafe-provider.js']) {
      assert.strictEqual(inventory[rel]?.label, 'behind-gate', rel);
      assert.strictEqual(inventory[rel].gate, 'src/history/reranker.js', rel);
      assert.match(inventory[rel].check, /keepLocal/);
    }
  });

  it('src/core/create-core.js is labelled by what each construction does', () => {
    const sites = inventory['src/core/create-core.js'].sites;
    assert.ok(sites, 'listed by sites');
    const byMatch = (needle) => Object.values(sites).find((site) => site.match.includes(needle));
    assert.strictEqual(byMatch('new TypesafeProvider(')?.label, 'behind-gate');
    assert.strictEqual(byMatch('new TypesafeProvider(').gate, 'src/history/reranker.js');
    assert.strictEqual(byMatch("createProviderInstance('openai'")?.label, 'behind-gate', 'the embedder host\'s hosted embedder');
    assert.strictEqual(byMatch('createSkillModels(')?.label, 'behind-gate', 'the skills llmProvider');
    assert.strictEqual(byMatch('createSkillModels(').gate, 'src/skills/skill-models.js');
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
    assert.deepStrictEqual(hit('const reply = await provider.sendMessage(messages, {});'), ['call']);
    assert.deepStrictEqual(hit('await routed.streamMessageWithTools(h, tools, opts, onChunk);'), ['call']);
    assert.deepStrictEqual(hit('return jev.rerank(query, texts, options);'), ['call']);
    assert.deepStrictEqual(hit('ask: (body, options) => provider.ask(body, options),'), ['call']);
    assert.deepStrictEqual(hit('const response = await this.request(url, init, options);'), ['method']);
    assert.deepStrictEqual(hit('const answer = await prompter.ask(question);'), []);
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

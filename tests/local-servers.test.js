// tests/local-servers.test.js
// The local server registry (spec 2026-10-13-local-inference-design.md §5.1,
// §5.3, §5.5; R-LI-4, R-LI-30, R-LI-31): which entries are usable, which may
// carry the guarantee, and how a target's model id names its server. No
// socket is opened here: transports are built, never used.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { LocalServers, SERVER_ID_RE, SERVER_KINDS, LOCAL_PROVIDER } = require('../src/models/local-servers');
const { createLocalTransport } = require('../src/models/local-transport');
const { setLogLevel, addSink } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const FINGERPRINT = 'ab'.repeat(32);

const entry = (over = {}) => ({
  id: 'workstation',
  name: 'Workstation',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  tlsFingerprint: null,
  allowCgnat: false,
  maxConcurrent: 2,
  timeoutMs: null,
  pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT },
  markedLocalAt: AT,
  ...over
});

const lanHttp = () => entry({
  id: 'lan-http', name: 'LAN box', kind: 'vllm', baseUrl: 'http://192.168.1.20:8000',
  pinned: { addresses: ['192.168.1.20'], class: 'lan', at: AT }
});
const lanHttps = () => entry({
  id: 'lan-https', name: 'GPU box', kind: 'vllm', baseUrl: 'https://gpu-box.example.com:8443', tlsFingerprint: FINGERPRINT,
  pinned: { addresses: ['192.168.1.21'], class: 'lan', at: AT }
});

function registry(entries, extra = {}) {
  const built = [];
  const servers = new LocalServers({
    getEntries: typeof entries === 'function' ? entries : () => entries,
    createTransport: (options) => { built.push(options); return createLocalTransport(options); },
    ...extra
  });
  return { servers, built };
}

describe('LocalServers#list', () => {
  it('exports the id pattern, the kinds and the provider key', () => {
    assert.strictEqual(LOCAL_PROVIDER, 'local');
    assert.ok(SERVER_ID_RE.test('workstation'));
    assert.ok(!SERVER_ID_RE.test('Work/station'));
    assert.deepStrictEqual([...SERVER_KINDS], ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'openai-compatible']);
  });

  it('a loopback entry is usable and guarantee-grade', () => {
    const { servers } = registry([entry()]);
    const [row] = servers.list();
    assert.strictEqual(row.id, 'workstation');
    assert.strictEqual(row.usable, true);
    assert.strictEqual(row.problem, null);
    assert.strictEqual(row.grade, 'guarantee');
    assert.deepStrictEqual(row.pinned.addresses, ['127.0.0.1']);
    servers.close();
  });

  it('a LAN http entry is usable for cost only', () => {
    const { servers } = registry([lanHttp()]);
    const [row] = servers.list();
    assert.strictEqual(row.usable, true);
    assert.strictEqual(row.grade, 'cost-only');
    servers.close();
  });

  it('a LAN https entry with a pinned certificate is guarantee-grade', () => {
    const { servers } = registry([lanHttps()]);
    const [row] = servers.list();
    assert.strictEqual(row.usable, true);
    assert.strictEqual(row.grade, 'guarantee');
    servers.close();
  });

  it('a LAN https entry with no fingerprint is cost only', () => {
    const { servers } = registry([{ ...lanHttps(), tlsFingerprint: null }]);
    assert.strictEqual(servers.list()[0].grade, 'cost-only');
    servers.close();
  });

  it('an entry pinned to a public address is unusable and never gets a transport', () => {
    const { servers, built } = registry([entry({
      id: 'elsewhere', baseUrl: 'http://203.0.113.9:8000', pinned: { addresses: ['203.0.113.9'], class: 'lan', at: AT }
    })]);
    const [row] = servers.list();
    assert.strictEqual(row.usable, false);
    assert.match(row.problem, /203\.0\.113\.9/);
    assert.notStrictEqual(row.grade, 'guarantee');
    assert.throws(() => servers.transportFor('elsewhere'), (err) => err.code === 'LOCAL_SERVER_UNUSABLE');
    assert.throws(() => servers.providerFor('elsewhere'), (err) => err.code === 'LOCAL_SERVER_UNUSABLE');
    assert.strictEqual(built.length, 0, 'no transport was built for it');
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'elsewhere/m' }), true);
    servers.close();
  });

  it('an entry with a bad id is unusable', () => {
    const { servers, built } = registry([entry({ id: 'Work Station' })]);
    const [row] = servers.list();
    assert.strictEqual(row.usable, false);
    assert.match(row.problem, /id/);
    assert.strictEqual(built.length, 0);
    servers.close();
  });

  it('refuses a wrong shape field by field, and never builds a transport for it', () => {
    const bad = [
      entry({ id: 'a1', kind: 'cloud' }),
      entry({ id: 'a2', baseUrl: 'ftp://127.0.0.1' }),
      entry({ id: 'a3', pinned: undefined }),
      entry({ id: 'a4', pinned: { addresses: ['127.0.0.1'], class: 'lan', at: AT } }),
      entry({ id: 'a5', markedLocalAt: null }),
      entry({ id: 'a6', tlsFingerprint: 'abc' }),
      entry({ id: 'a7', maxConcurrent: 0 }),
      entry({ id: 'a8', timeoutMs: -5 }),
      entry({ id: 'a9', name: 'two\nlines' }),
      // An IP literal in the URL is the address: a pin that names another is not this server's.
      entry({ id: 'b1', baseUrl: 'http://127.0.0.1:11434', pinned: { addresses: ['192.168.1.9'], class: 'lan', at: AT } }),
      // 100.64.0.0/10 only with the entry's own opt-in (R-LI-29).
      entry({ id: 'b2', baseUrl: 'http://100.64.0.5:8000', pinned: { addresses: ['100.64.0.5'], class: 'cgnat', at: AT } }),
      'not an object',
      null
    ];
    const { servers, built } = registry(bad);
    const rows = servers.list();
    assert.strictEqual(rows.length, bad.length);
    for (const row of rows) {
      assert.strictEqual(row.usable, false, JSON.stringify(row));
      assert.ok(typeof row.problem === 'string' && row.problem, 'a problem sentence');
      assert.notStrictEqual(row.grade, 'guarantee');
    }
    assert.strictEqual(built.length, 0);
    servers.close();
  });

  it('R-LI-29: a 100.64.0.0/10 entry with allowCgnat is usable, and cost only over http', () => {
    const { servers } = registry([entry({
      id: 'overlay', kind: 'llamacpp', baseUrl: 'http://100.64.0.5:8000', allowCgnat: true,
      pinned: { addresses: ['100.64.0.5'], class: 'cgnat', at: AT }
    })]);
    const [row] = servers.list();
    assert.strictEqual(row.usable, true);
    assert.strictEqual(row.grade, 'cost-only');
    servers.close();
  });

  it('two entries with one id are both unusable', () => {
    const { servers } = registry([entry(), entry({ baseUrl: 'http://127.0.0.1:8080' })]);
    const rows = servers.list();
    assert.deepStrictEqual(rows.map((r) => r.usable), [false, false]);
    assert.strictEqual(servers.get('workstation').usable, false);
    servers.close();
  });

  it('getEntries throwing gives an empty list and one warning', () => {
    const warnings = [];
    setLogLevel('warn');
    const remove = addSink((record) => { if (record.level === 'warn') warnings.push(record.message); });
    try {
      const { servers } = registry(() => { throw new Error('settings unreadable'); });
      assert.deepStrictEqual(servers.list(), []);
      assert.deepStrictEqual(servers.list(), []);
      assert.strictEqual(servers.get('workstation'), null);
      assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'workstation/m' }), true);
      assert.strictEqual(warnings.length, 1);
      servers.close();
    } finally {
      remove();
      setLogLevel('fatal');
    }
  });

  it('getEntries answering something that is not a list gives an empty list', () => {
    const { servers } = registry(() => ({ workstation: entry() }));
    assert.deepStrictEqual(servers.list(), []);
    servers.close();
  });
});

describe('LocalServers#splitModel', () => {
  const { servers } = registry([entry()]);
  it('splits at the first slash', () => {
    assert.deepStrictEqual(servers.splitModel('workstation/qwen3:8b'), { serverId: 'workstation', model: 'qwen3:8b' });
    assert.deepStrictEqual(servers.splitModel('workstation/hf.co/org/name:tag'), { serverId: 'workstation', model: 'hf.co/org/name:tag' });
  });
  it('is null with no slash, an empty model or an id that is not a server id', () => {
    for (const id of ['qwen3:8b', 'workstation/', '/qwen3:8b', 'Work Station/m', '', null, undefined, 7]) {
      assert.strictEqual(servers.splitModel(id), null, String(id));
    }
  });
});

describe('LocalServers#isGuaranteeTarget (R-LI-30, R-LI-31)', () => {
  it('a model on a loopback server is a guarantee target', () => {
    const { servers } = registry([entry()]);
    assert.strictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'workstation/qwen3:8b' }), true);
    servers.close();
  });

  it('R-LI-30: a LAN http server is not a guarantee target', () => {
    const { servers } = registry([lanHttp(), lanHttps()]);
    const verdict = servers.isGuaranteeTarget({ provider: 'local', model: 'lan-http/qwen3:8b' });
    assert.strictEqual(typeof verdict, 'string');
    assert.match(verdict, /plain http/);
    assert.strictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'lan-https/qwen3:8b' }), true);
    servers.close();
  });

  it('R-LI-31: no other provider is ever a guarantee target, whatever its model is called', () => {
    const { servers } = registry([entry()]);
    for (const provider of ['ollama', 'openai', 'LOCAL', 'local ', '', null, undefined]) {
      assert.notStrictEqual(servers.isGuaranteeTarget({ provider, model: 'workstation/qwen3:8b' }), true, String(provider));
    }
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'unknown-box/qwen3:8b' }), true);
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'qwen3:8b' }), true);
    assert.notStrictEqual(servers.isGuaranteeTarget(null), true);
    assert.notStrictEqual(servers.isGuaranteeTarget('local/workstation/qwen3:8b'), true);
    servers.close();
  });

  it('a cloud id on an ollama server is not a guarantee target, and explain says LOCAL_CLOUD_MODEL', () => {
    const { servers } = registry([entry()]);
    for (const model of ['workstation/gpt-oss:120b-cloud', 'workstation/qwen3:cloud']) {
      const verdict = servers.isGuaranteeTarget({ provider: 'local', model });
      assert.strictEqual(typeof verdict, 'string');
      const explained = servers.explain(model);
      assert.strictEqual(explained.usable, false);
      assert.strictEqual(explained.code, 'LOCAL_CLOUD_MODEL');
      assert.match(explained.reasons[0], /Ollama's cloud/);
    }
    servers.close();
  });

  it('the grade is the transport\'s own, not the entry\'s say-so', () => {
    const { servers } = registry([{ ...lanHttp(), grade: 'guarantee', usable: true, pinned: { addresses: ['192.168.1.20'], class: 'lan', at: AT, grade: 'guarantee' } }]);
    assert.strictEqual(servers.list()[0].grade, 'cost-only');
    assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'lan-http/m', grade: 'guarantee', local: true }), true);
    servers.close();
  });

  it('a transport that says something other than "guarantee" is not one', () => {
    for (const grade of [undefined, true, 'GUARANTEE', 'cost-only']) {
      const servers = new LocalServers({
        getEntries: () => [entry()],
        createTransport: (options) => ({ ...createLocalTransport(options), grade })
      });
      assert.notStrictEqual(servers.isGuaranteeTarget({ provider: 'local', model: 'workstation/m' }), true, String(grade));
      assert.notStrictEqual(servers.list()[0].grade, 'guarantee');
      servers.close();
    }
  });
});

describe('LocalServers#explain', () => {
  it('a model on a usable server is usable, with the note "not probed"', () => {
    const { servers } = registry([entry()]);
    const verdict = servers.explain('workstation/qwen3:8b', { needs: { toolCall: true } });
    assert.strictEqual(verdict.usable, true);
    assert.deepStrictEqual(verdict.reasons, []);
    assert.ok(verdict.notes.some((n) => /not probed/.test(n)));
    assert.strictEqual(verdict.entry, null);
    servers.close();
  });

  it('an unknown server is LOCAL_SERVER_UNKNOWN', () => {
    const { servers } = registry([entry()]);
    for (const model of ['other/qwen3:8b', 'qwen3:8b', '']) {
      const verdict = servers.explain(model);
      assert.strictEqual(verdict.usable, false, model);
      assert.strictEqual(verdict.code, 'LOCAL_SERVER_UNKNOWN', model);
      assert.strictEqual(verdict.reasons.length, 1);
    }
    servers.close();
  });

  it('an unusable server gives its problem', () => {
    const { servers } = registry([entry({ pinned: { addresses: ['203.0.113.9'], class: 'lan', at: AT }, baseUrl: 'http://gpu-box.example.com:8000' })]);
    const verdict = servers.explain('workstation/qwen3:8b');
    assert.strictEqual(verdict.usable, false);
    assert.strictEqual(verdict.code, 'LOCAL_SERVER_UNUSABLE');
    assert.strictEqual(verdict.reasons[0], servers.get('workstation').problem);
    servers.close();
  });
});

describe('LocalServers transports and providers', () => {
  it('apiBase is <baseUrl>/v1', () => {
    const { servers } = registry([entry(), entry({ id: 'other', baseUrl: 'http://127.0.0.1:8080/api/' })]);
    assert.strictEqual(servers.apiBase(servers.get('workstation')), 'http://127.0.0.1:11434/v1');
    assert.strictEqual(servers.apiBase(servers.get('other')), 'http://127.0.0.1:8080/api/v1');
    servers.close();
  });

  it('keeps one transport and one provider per server, and builds them from the pin', () => {
    const { servers, built } = registry([entry(), lanHttps()]);
    const a = servers.transportFor('workstation');
    assert.strictEqual(servers.transportFor('workstation'), a);
    assert.notStrictEqual(servers.transportFor('lan-https'), a);
    assert.strictEqual(built.length, 2);
    assert.deepStrictEqual(built.find((b) => b.baseUrl.startsWith('https')).addresses, ['192.168.1.21']);
    assert.strictEqual(built.find((b) => b.baseUrl.startsWith('https')).tlsFingerprint, FINGERPRINT);
    const p = servers.providerFor('workstation');
    assert.strictEqual(servers.providerFor('workstation'), p);
    assert.strictEqual(p.getProviderName(), 'local');
    assert.strictEqual(p.transport, a);
    assert.strictEqual(p.baseUrl, 'http://127.0.0.1:11434/v1');
    servers.close();
  });

  it('rebuilds the transport and the provider when the entry changes, closing the old one', async () => {
    let current = [entry()];
    const { servers, built } = registry(() => current);
    const first = servers.transportFor('workstation');
    const firstProvider = servers.providerFor('workstation');
    current = [entry({ baseUrl: 'http://127.0.0.1:8080' })];
    const second = servers.transportFor('workstation');
    assert.notStrictEqual(second, first);
    assert.notStrictEqual(servers.providerFor('workstation'), firstProvider);
    assert.strictEqual(built.length, 2);
    await assert.rejects(first.fetch('http://127.0.0.1:11434/v1/models'), (err) => err.code === 'LOCAL_TRANSPORT_CLOSED');
    // A server that is no longer configured loses its transport.
    current = [];
    assert.throws(() => servers.transportFor('workstation'), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
    await assert.rejects(second.fetch('http://127.0.0.1:8080/v1/models'), (err) => err.code === 'LOCAL_TRANSPORT_CLOSED');
    servers.close();
  });

  it('a new key rebuilds the provider, not the transport', () => {
    let key = null;
    const asked = [];
    const { servers } = registry([entry()], { getToken: (id) => { asked.push(id); return key; } });
    const transport = servers.transportFor('workstation');
    const p1 = servers.providerFor('workstation');
    assert.strictEqual('Authorization' in p1.getHeaders(), false);
    key = 'key-for-workstation';
    const p2 = servers.providerFor('workstation');
    assert.notStrictEqual(p2, p1);
    assert.strictEqual(p2.getHeaders().Authorization, 'Bearer key-for-workstation');
    assert.strictEqual(servers.transportFor('workstation'), transport);
    assert.ok(asked.every((id) => id === 'workstation'));
    servers.close();
  });

  it('close() closes every transport', async () => {
    const { servers } = registry([entry()]);
    const transport = servers.transportFor('workstation');
    servers.close();
    await assert.rejects(transport.fetch('http://127.0.0.1:11434/v1/models'), (err) => err.code === 'LOCAL_TRANSPORT_CLOSED');
  });
});

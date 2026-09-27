// tests/models-snapshot.test.js
// The bundled catalog (spec 2026-09-27 §4.1): the script that builds it, and
// the committed snapshot a fresh install works from, fully offline.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildSnapshot } = require('../scripts/models-snapshot');
const { Catalog, DEFAULT_SNAPSHOT_DIR } = require('../src/models/catalog');
const { KL_PROVIDERS } = require('../src/models/provider-ids');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('buildSnapshot', () => {
  it('trims models.dev to King Louie\'s providers and keeps only the Artificial Analysis scores', async () => {
    const fetch = async (url) => (url.includes('models.dev')
      ? json({ openai: { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }, 'not-ours': { id: 'not-ours', models: {} } })
      : json({ data: [{ id: 'openai/gpt-5.5', benchmarks: { artificial_analysis: { intelligence_index: 60, coding_index: null, agentic_index: 50 } } }] }));
    const snap = await buildSnapshot({ fetch, now: () => new Date('2026-09-27T00:00:00Z') });
    assert.deepStrictEqual(Object.keys(snap.modelsDev.data), ['openai']);
    assert.strictEqual(snap.modelsDev.fetchedAt, '2026-09-27T00:00:00.000Z');
    assert.strictEqual(snap.modelsDev.source, 'models.dev');
    assert.deepStrictEqual(snap.scores.scores, { 'openai/gpt-5.5': { intelligence: 60, coding: null, agentic: 50 } });
  });

  it('refuses a document that is not a catalog, or a failed fetch', async () => {
    await assert.rejects(buildSnapshot({ fetch: async () => json({ nope: true }) }), /did not return a models\.dev catalog/);
    await assert.rejects(buildSnapshot({ fetch: async () => json({}, 500) }), /returned 500/);
  });
});

describe('the bundled snapshot', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(DEFAULT_SNAPSHOT_DIR, name), 'utf8'));

  it('is small and carries its date', () => {
    for (const name of ['models-dev.json', 'scores.json']) {
      const size = fs.statSync(path.join(DEFAULT_SNAPSHOT_DIR, name)).size;
      assert.ok(size < 1024 * 1024, `${name} is ${size} bytes`);
    }
    assert.ok(!Number.isNaN(Date.parse(read('models-dev.json').fetchedAt)));
    assert.ok(!Number.isNaN(Date.parse(read('scores.json').fetchedAt)));
  });

  it('covers every King Louie provider and loads without the network', () => {
    const catalog = new Catalog().load({ fetch: async () => { throw new Error('no network'); } });
    for (const provider of KL_PROVIDERS) assert.ok(catalog.list(provider).length > 0, `${provider} has models`);
    assert.ok(catalog.list().length >= 500, `${catalog.list().length} models`);
    assert.strictEqual(catalog.status().source, 'snapshot');
    assert.ok(Object.keys(read('scores.json').scores).length >= 100);
  });
});

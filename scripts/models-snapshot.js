#!/usr/bin/env node
// scripts/models-snapshot.js
// Regenerates the bundled model catalog (spec 2026-09-27 §4.1): models.dev
// trimmed to King Louie's 14 providers, and Artificial Analysis scores from
// OpenRouter's model list. Run before each release: npm run models:snapshot
const fs = require('fs');
const path = require('path');
const { trimModelsDev, validateModelsDev, normalizeScores, validateScores } = require('../src/models/normalize');
const { CATALOG_DEFAULTS, DEFAULT_SNAPSHOT_DIR } = require('../src/models/catalog');

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function buildSnapshot({
  fetch: fetchImpl = globalThis.fetch,
  modelsDevUrl = CATALOG_DEFAULTS.modelsDevUrl,
  scoresUrl = CATALOG_DEFAULTS.scoresUrl,
  now = () => new Date()
} = {}) {
  const [modelsDev, scores] = await Promise.all([getJson(fetchImpl, modelsDevUrl), getJson(fetchImpl, scoresUrl)]);
  if (!validateModelsDev(modelsDev)) throw new Error(`${modelsDevUrl} did not return a models.dev catalog.`);
  if (!validateScores(scores)) throw new Error(`${scoresUrl} did not return an OpenRouter model list.`);
  const fetchedAt = now().toISOString();
  return {
    modelsDev: { fetchedAt, source: 'models.dev', data: trimModelsDev(modelsDev) },
    scores: { fetchedAt, source: 'artificial-analysis', scores: normalizeScores(scores) }
  };
}

async function main() {
  const snap = await buildSnapshot();
  fs.mkdirSync(DEFAULT_SNAPSHOT_DIR, { recursive: true });
  const write = (name, doc) => {
    const file = path.join(DEFAULT_SNAPSHOT_DIR, name);
    fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
    return fs.statSync(file).size;
  };
  const modelBytes = write('models-dev.json', snap.modelsDev);
  const scoreBytes = write('scores.json', snap.scores);
  const providers = Object.keys(snap.modelsDev.data).length;
  const models = Object.values(snap.modelsDev.data).reduce((n, block) => n + Object.keys(block.models || {}).length, 0);
  process.stdout.write(`models-dev.json: ${providers} providers, ${models} models, ${Math.round(modelBytes / 1024)} KB\n`);
  process.stdout.write(`scores.json: ${Object.keys(snap.scores.scores).length} scored models, ${Math.round(scoreBytes / 1024)} KB\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`models:snapshot failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildSnapshot };

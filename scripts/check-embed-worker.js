#!/usr/bin/env node
// scripts/check-embed-worker.js
// Manual check for recall stage H3 (not part of npm test; needs the network
// once): runs the embed worker the way King Louie does, loads the default
// local embedding model and the cross-encoder into a temp models folder,
// embeds and reranks one example, then loads the model again with downloads
// off (the offline path) and prints the model folder's files.
//   node scripts/check-embed-worker.js
//   node scripts/check-embed-worker.js --app "<King Louie binary>" --resources "<its resources folder>"
// With --app, the worker is <resources>/app.asar/src/history/embed-worker.js
// run by the app binary with ELECTRON_RUN_AS_NODE=1: the packaged path.
// --keep leaves the temp models folder in place.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('node:util');
const { EmbedRunner } = require('../src/history/embed-runner');
const { HISTORY_DEFAULTS } = require('../src/history/settings');
const { COMPLETE_MARKER } = require('../src/history/embedders/local-backend');

async function main() {
  const { values } = parseArgs({ options: { app: { type: 'string' }, resources: { type: 'string' }, keep: { type: 'boolean' } } });
  if (values.app && !values.resources) throw new Error('--app needs --resources');
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-check-models-'));
  const runnerOpts = values.app
    ? { execPath: values.app, workerPath: path.join(values.resources, 'app.asar', 'src', 'history', 'embed-worker.js') }
    : {};
  const model = HISTORY_DEFAULTS.embedder.model;
  const reranker = HISTORY_DEFAULTS.recall.rerank.model;
  const runner = new EmbedRunner(runnerOpts);
  runner.on('progress', (p) => {
    if (p.total) process.stdout.write(`  ${p.model} ${p.file} ${Math.floor((p.loaded / p.total) * 100)}%   \r`);
  });
  let code = 0;
  try {
    let t0 = Date.now();
    const { dim } = await runner.load('embedder', model, { modelsDir });
    process.stdout.write(`\nloaded ${model} (dim ${dim}) in ${Date.now() - t0} ms\n`);
    t0 = Date.now();
    const [v] = await runner.embed(model, ['The side gate code at the Lakeside lot is 4417.']);
    process.stdout.write(`embedded one sentence in ${Date.now() - t0} ms: ${v.length} dims\n`);
    await runner.load('reranker', reranker, { modelsDir });
    const scores = await runner.rerank(reranker, 'gate code', ['The side gate code is 4417.', 'The fence is forty meters.']);
    process.stdout.write(`rerank scores ${scores.map((s) => s.toFixed(2)).join(', ')} (the first should be higher)\n`);
    const dir = path.join(modelsDir, ...model.split('/'));
    process.stdout.write(`completion marker: ${fs.existsSync(path.join(dir, COMPLETE_MARKER)) ? 'present' : 'MISSING'}\n`);
    process.stdout.write(`files: ${fs.readdirSync(dir, { recursive: true }).join(', ')}\n`);
    await runner.stop();
    const offline = new EmbedRunner(runnerOpts);
    try {
      await offline.load('embedder', model, { modelsDir, allowDownload: false });
      await offline.embed(model, ['offline check']);
      process.stdout.write('offline load from the models folder: ok\n');
    } finally {
      await offline.stop();
    }
  } catch (err) {
    process.stderr.write(`FAILED: ${err.code || ''} ${err.message}\n`);
    code = 1;
  } finally {
    await runner.stop();
    if (!values.keep) fs.rmSync(modelsDir, { recursive: true, force: true });
  }
  return code;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
});

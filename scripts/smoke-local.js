#!/usr/bin/env node
// scripts/smoke-local.js
// Opt-in live check of a real local server (local inference spec 2026-10-13
// §19, plan Task 20), modelled on smoke-providers.js. It adds the server to a
// LocalServers registry on a temporary data dir (the real address check and
// a real DNS lookup), probes one model, then streams a short reply and makes
// one tool call through LocalServerProvider over the pinned transport. It
// prints the pin, the address class, the grade and the probe record, and of
// a reply only the probe's `sample`. Not part of npm test; costs nothing.
//   KL_SMOKE_LOCAL_URL=http://127.0.0.1:11434 KL_SMOKE_LOCAL_MODEL=<model> npm run smoke:local
// KL_SMOKE_LOCAL_KIND is the server kind (default ollama): ollama, lmstudio,
// llamacpp, vllm or openai-compatible.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalServers, SERVER_KINDS } = require('../src/models/local-servers');
const { runProviderChecks } = require('./lib/provider-checks');

const SERVER_ID = 'smoke';

// What to check, from the environment. Pure, for a test. Null when unset.
function selectLocalTarget(env = process.env) {
  const url = env.KL_SMOKE_LOCAL_URL || '';
  const model = env.KL_SMOKE_LOCAL_MODEL || '';
  if (!url || !model) return null;
  const kind = env.KL_SMOKE_LOCAL_KIND || 'ollama';
  if (!SERVER_KINDS.includes(kind)) throw new Error(`KL_SMOKE_LOCAL_KIND must be one of ${SERVER_KINDS.join(', ')}.`);
  return { url, model, kind };
}

const print = (line) => process.stdout.write(`${line}\n`);

async function main() {
  const target = selectLocalTarget();
  if (!target) {
    print('Set KL_SMOKE_LOCAL_URL (the server\'s address) and KL_SMOKE_LOCAL_MODEL (a model it lists);');
    print('KL_SMOKE_LOCAL_KIND is the kind (default ollama). Nothing to check.');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-smoke-local-'));
  let entries = [];
  const servers = new LocalServers({
    getEntries: () => entries,
    writeEntries: (next) => { entries = next; },
    probeFile: path.join(dir, 'local-probes.json')
  });
  let failed = false;
  try {
    const added = await servers.add({ id: SERVER_ID, name: 'Smoke', kind: target.kind, baseUrl: target.url }, { refresh: false });
    const row = added.server;
    print(`pin: ${row.pinned.addresses.join(', ')} (${row.pinned.class}), grade: ${row.grade}`);
    const record = await servers.probe(SERVER_ID, target.model);
    const shown = {
      context: record.context ?? null,
      contextSource: record.contextSource ?? null,
      toolCall: record.toolCall ?? null,
      imageInput: record.imageInput ?? null,
      stream: record.stream ?? null,
      firstTokenMs: record.firstTokenMs ?? null,
      tokensPerSecond: record.tokensPerSecond ?? null,
      digest: record.digest ?? null,
      error: record.error ?? null,
      sample: record.sample ?? ''
    };
    print(`probe: ${JSON.stringify(shown)}`);
    const provider = servers.providerFor(SERVER_ID);
    const result = await runProviderChecks(provider, { model: `${SERVER_ID}/${target.model}` });
    failed = !result.ok;
    print(`${result.ok ? 'ok  ' : 'FAIL'} ${target.kind} ${target.model}: stream ${result.text.trim() ? 'yes' : 'no'}, tool call ${result.toolName || 'none'}${result.ok ? '' : ` (${result.errors.map((e) => e.split(':')[0]).join(', ')})`}`);
  } catch (err) {
    failed = true;
    process.stderr.write(`smoke:local failed: ${err.code ? `${err.code}: ` : ''}${err.message}\n`);
  } finally {
    servers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`smoke:local failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { selectLocalTarget };

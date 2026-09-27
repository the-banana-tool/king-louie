// tests/helpers/ingest-harness.js
// A real CaseRuntime on a temp root with an IngestService whose model is a
// test double. Roles are pinned so no provider settings are needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { capabilitiesOf } = require('../../src/models/capabilities');
const { fixtureCatalog } = require('./models-fixture');
const { CaseRuntime } = require('../../src/cases');
const { IngestService } = require('../../src/cases/ingest');
const { shutdownPdfSandbox } = require('../../src/cases/ingest/pdf-sandbox');
const git = require('../../src/cases/git');

// Cases are git repositories: suites skip without git on PATH.
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const NEEDS_GIT = HAS_GIT ? false : 'git is not on PATH';

const catalog = fixtureCatalog();
const ROLES = {
  draft: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  judge: { provider: 'anthropic', model: 'claude-opus-4-1' },
  verify: { provider: 'gemini', model: 'gemini-2.5-pro' }
};

const usage = (cost, totalTokens = 1000) => ({ provider: 'test', model: 'test-model', inputTokens: totalTokens - 100, outputTokens: 100, totalTokens, cost });

// The default model: OCR returns a fixed transcript, extract proposes the
// payoff fact when its quote is in the chunk, verify agrees.
function defaultModel(req) {
  if (req.purpose === 'ocr') {
    const n = Number(/page (\d+)/.exec(req.text)?.[1] || 1);
    return { text: `Lakeside lot, 2.120 acres, Parcel 12-345-678 (page ${n})`, usage: usage(0.01) };
  }
  if (req.purpose === 'extract') {
    const proposals = [];
    const m = /\f\[page (\d+)\]\n[^\f]*Total payoff amount: \$182,340\.17/.exec(req.text);
    if (m) {
      proposals.push({
        stmt: 'Payoff amount for loan 0042-7781 is $182,340.17',
        subject: 'loan-0042-7781',
        attr: 'payoff-amount',
        value: '182340.17',
        unit: 'usd',
        category: 'general',
        confidence: 0.9,
        anchor: { page: Number(m[1]), quote: 'Total payoff amount: $182,340.17' },
        entities: [{ type: 'org', text: 'Example Bank' }, { type: 'id', text: 'Loan No. 0042-7781' }]
      });
    }
    return { text: JSON.stringify({ proposals }), usage: usage(0.002) };
  }
  return { text: '{"agrees": true, "note": "matches the page"}', usage: usage(0.003) };
}

const roots = [];
const services = [];
async function cleanup() {
  for (const svc of services.splice(0)) svc.stop();
  await shutdownPdfSandbox();
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}

async function ingestHarness({ ingest = {}, budgets = {}, roles = {}, model = defaultModel, title = 'Lakeside lot', status = 'active', retryMs = 60000, root = null, openPdf = undefined } = {}) {
  const dir = root || fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ingest-'));
  if (!root) roots.push(dir);
  const settings = { cases: { timeZone: 'UTC', budgets: { usd: 20, questionsPerDay: 6, ...budgets }, ingest } };
  const runtime = new CaseRuntime({ root: dir, getSettings: () => settings });
  const pinned = { ...ROLES, ...roles };
  runtime.roleModel = (_id, role) => ({ ...pinned[role], tier: 'standard' });
  const calls = [];
  const svc = new IngestService({
    runtime,
    callModel: async (req) => {
      calls.push(req);
      return model(req, calls);
    },
    getCapabilities: (p, m) => capabilitiesOf(catalog, p, m),
    getSettings: () => settings,
    retryMs,
    ...(openPdf ? { openPdf } : {})
  });
  services.push(svc);
  const meta = await runtime.createCase({ title });
  if (status !== 'draft') runtime.store.updateMeta(meta.id, { status });
  return { root: dir, runtime, svc, calls, settings, caseId: meta.id, dir: meta.dir };
}

const commits = async (dir) => (await git.git(dir, ['log', '--format=%s'])).trim().split('\n');
const journals = (dir, kind = 'ingest') => fs.readdirSync(path.join(dir, 'journal'))
  .filter((n) => n.endsWith(`-${kind}.md`) || new RegExp(`-${kind}-\\d+\\.md$`).test(n))
  .map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8'));

module.exports = { ingestHarness, defaultModel, usage, cleanup, commits, journals, ROLES, HAS_GIT, NEEDS_GIT };

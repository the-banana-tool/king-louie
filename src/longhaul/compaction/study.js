'use strict';
// The compaction-loss study (benchmark spec §9): for every real compaction of
// each session, sample facts in the condensed window, author one per anchor,
// judge whether the summary kept it and whether a later message needed it.
// Priced before the first call, capped by a spend guard, every reply cached.
// runs/<id>/ holds ids, seqs, verdicts and numbers only; facts, quotes and
// reasons go under LONGHAUL_HOME/private/.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadSession, sessionDir, validateSessionId, messageText } = require('../session-format');
const { compactionWindows, summaryText } = require('./windows');
const { planWindowFacts } = require('./sample');
const { authorFact, judgePreserved, judgeNeeded, SPAN_MESSAGE_CHARS } = require('./steps');
const { openMatcher, factQueryText, factQueryId, MATCHER_CHUNK } = require('./matches');
const { EmbeddingCache, cacheDir, embedHint, embedText, batches, priceTokens } = require('../embeddings');
const { loadPrompt } = require('../prompts');
const { ModelCache } = require('../model-cache');
const { estimateCalls, checkBudget, SpendGuard, DEFAULT_MAX_USD } = require('../cost');
const { stopErrorFor } = require('../retry');
const { writeFileAtomic, byCodeUnit } = require('../files');
const { spotCheckFile, writeSpotCheckSample } = require('../answer-stage');
const { gitCommit, removeStaleTmp } = require('../run');
const { UsageError } = require('../errors');
const { round8, fixed } = require('../format');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/compaction-study');

const AUTHOR_MAX_TOKENS = 800;
const JUDGE_MAX_TOKENS = 200;
// A fact and its quote are not known before authoring; this bounds them for the estimate.
const FACT_EST_CHARS = 400;
const CANDIDATE_EST_CHARS = 2000;
const HEADER_EST_CHARS = 40;
const EMBED_BATCH = 100;
const TMP_PREFIX = 'kl-compaction-';
const SPOT_ADAPTER = 'compaction-loss';

// run.js's run id (RUN_ID_RE), which it does not export.
function newRunId(date) {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${crypto.randomBytes(2).toString('hex')}`;
}

// A private session goes to a remote model only with --send-private;
// checked before any client is built. Returns the private sessions that will be sent.
function assertMaySend({ manifests, remote, sendPrivate, dryRun }) {
  const privateIds = manifests.filter((m) => m.private).map((m) => m.sessionId);
  if (!privateIds.length || !remote.length || dryRun) return [];
  if (sendPrivate) return privateIds;
  const one = privateIds.length === 1;
  throw new UsageError(`Session${one ? '' : 's'} ${privateIds.join(', ')} ${one ? 'is' : 'are'} private: the compaction-loss study sends `
    + `spans, summaries and later messages of ${one ? 'it' : 'them'} to ${[...new Set(remote)].sort().join(', ')}. Pass --send-private to allow that.`, 'PRIVATE_SESSION');
}

function readManifest(root, id) {
  validateSessionId(id);
  const file = path.join(sessionDir(root, id), 'manifest.json');
  if (!fs.existsSync(file)) throw new UsageError(`No session "${id}"; import it first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A chunk cache `longhaul embed` filled for this model with the matcher's chunking.
function assertChunkVectors(home, sessionId, embed) {
  const cache = EmbeddingCache.open(cacheDir(home.private, sessionId, embed.model));
  const complete = cache.exists && JSON.stringify(cache.meta.chunk) === JSON.stringify(MATCHER_CHUNK)
    && Number.isInteger(cache.meta.chunksTotal) && cache.rows.length >= cache.meta.chunksTotal;
  if (!complete) {
    throw new UsageError(`compaction-loss: session ${sessionId} has no complete embedding cache for ${embed.model}, so matching cannot be semantic; `
      + `nothing was sent. ${embedHint(sessionId, embed.model, embed.provider)}`, 'EMBEDDINGS_MISSING');
  }
}

const clippedChars = (m) => Math.min(messageText(m).length, SPAN_MESSAGE_CHARS) + HEADER_EST_CHARS;

function planCalls(plan, { author, judge, embed, candidates }) {
  const t = { fact: loadPrompt('compactionFact').text.length, preserved: loadPrompt('compactionPreserved').text.length, needed: loadPrompt('compactionNeeded').text.length };
  const as = (client, role, adapter) => ({ role, adapter, provider: client.provider, model: client.model, local: Boolean(client.local) });
  const calls = [];
  for (const p of plan) {
    const summaryChars = summaryText(p.session, p.window).length;
    for (const item of p.items) {
      let spanChars = 0;
      for (let s = item.spanFrom; s <= item.spanTo; s++) {
        const m = p.session.index.get(s);
        if (m) spanChars += clippedChars(m);
      }
      calls.push({ ...as(author, 'author', 'compaction-fact'), inputChars: t.fact + spanChars, maxTokens: AUTHOR_MAX_TOKENS });
      calls.push({ ...as(judge, 'judge', 'compaction-preserved'), inputChars: t.preserved + FACT_EST_CHARS + summaryChars, maxTokens: JUDGE_MAX_TOKENS });
      calls.push({ ...as(judge, 'judge', 'compaction-needed'), inputChars: t.needed + FACT_EST_CHARS + candidates * CANDIDATE_EST_CHARS, maxTokens: JUDGE_MAX_TOKENS });
      if (embed) calls.push({ ...as(embed, 'embed', 'fact-query'), inputChars: FACT_EST_CHARS, maxTokens: 0 });
    }
  }
  return calls;
}

function addCost(total, call) {
  if (!call) return total;
  if (total === null || typeof call.costUsd !== 'number') return null;
  return round8(total + call.costUsd);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rates(records, windows) {
  const judged = records.filter((r) => r.status === 'judged');
  const rate = (pred) => (judged.length ? judged.filter(pred).length / judged.length : null);
  const ratios = windows.map((w) => w.ratio).filter((x) => Number.isFinite(x));
  return {
    windows: windows.length,
    facts: records.length,
    judged: judged.length,
    rejected: records.filter((r) => r.status === 'rejected').length,
    errors: records.filter((r) => r.status === 'error').length,
    preservedRate: rate((r) => r.preserved === 'preserved'),
    partialRate: rate((r) => r.preserved === 'partial'),
    lostRate: rate((r) => r.preserved === 'lost'),
    neededRate: rate((r) => r.needed === 'needed'),
    lostAndNeededRate: rate((r) => r.preserved === 'lost' && r.needed === 'needed'),
    ratio: { median: median(ratios), min: ratios.length ? Math.min(...ratios) : null, max: ratios.length ? Math.max(...ratios) : null }
  };
}

function summaryMarkdown(config, summary) {
  const f = (x) => fixed(x, 3, '—');
  const row = (name, s) => `| ${name} | ${s.windows} | ${s.facts} | ${s.judged} | ${s.rejected} | ${s.errors} | ${f(s.preservedRate)} | ${f(s.partialRate)} `
    + `| ${f(s.lostRate)} | ${f(s.neededRate)} | ${f(s.lostAndNeededRate)} | ${fixed(s.ratio.median, 1, '—')} |`;
  return [
    `# Compaction-loss study ${summary.runId}`,
    '',
    `Author ${config.author.provider}/${config.author.model}; judge ${config.judge.provider}/${config.judge.model}; `
      + `${config.factsPerWindow} facts a window; ${config.candidates} candidates; seed ${config.seed}; `
      + `matching ${config.embed ? `lexical and semantic (${config.embed.provider}/${config.embed.model})` : 'lexical only'}.`,
    '',
    '| session | windows | facts | judged | rejected | errors | preserved | partial | lost | needed | lost and needed | median ratio |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(summary.sessions).map(([id, s]) => row(id, s)),
    row('all', summary.all),
    '',
    'Rates are over judged facts. "Needed" sees only later messages that match the fact, so lost-and-needed is a lower bound.',
    ''
  ].join('\n');
}

// Each fact's query vector, written to the session's embedding cache under
// factQueryId so the matcher's semantic side finds it. Charged to the guard.
async function embedQueries({ home, sessionId, embed, facts, hooks, catalog }) {
  const cache = EmbeddingCache.open(cacheDir(home.private, sessionId, embed.model));
  const seen = new Set();
  const todo = [];
  for (const f of facts) {
    const text = factQueryText(f.value.fact, f.value.quote);
    const id = factQueryId(text);
    if (seen.has(id) || cache.question(id, text)) continue;
    seen.add(id);
    todo.push({ id, query: text, text: embedText(text).text });
  }
  let failed = 0;
  for (const group of batches(todo, EMBED_BATCH)) {
    let ticket = null;
    let res;
    try {
      ticket = hooks.beforeCall({ stage: 'embed', client: embed, promptChars: group.reduce((n, g) => n + g.text.length, 0), maxTokens: 0 });
      res = await embed.embed(group.map((g) => g.text), { kind: 'query' });
    } catch (err) {
      if (ticket) hooks.cancel(ticket);
      const stop = stopErrorFor(err, embed.provider, 'the embedder');
      if (stop) throw stop;
      failed += group.length;
      continue;
    }
    const used = Number.isFinite(res.usage?.input) ? res.usage.input : 0;
    hooks.afterCall(ticket, { inputTokens: used, outputTokens: 0, costUsd: embed.local ? 0 : priceTokens(embed.provider, embed.model, used, catalog) });
    group.forEach((g, j) => cache.addQuestion(g.id, g.query, res.vectors[j], { tokens: j === 0 ? used : 0 }));
  }
  if (failed) log.warn('fact queries not embedded; those facts are matched lexically', { sessionId, failed });
}

async function runCompactionStudy({ home, sessionIds, clients, options = {}, deps = {} }) {
  const o = {
    factsPerWindow: 10, candidates: 8, seed: 1, maxUsd: DEFAULT_MAX_USD, allowUnpriced: false, dryRun: false, sendPrivate: false,
    onPlan: () => {}, ...options
  };
  const { author, judge, embed = null } = clients;
  const now = deps.now || (() => new Date());
  const signals = deps.signals || process;
  const exit = deps.exit || ((code) => process.exit(code));
  const catalog = deps.catalog || require('../../models').getActiveCatalog();
  const retry = deps.retry || {};
  if (!sessionIds?.length) throw new UsageError('--sessions names at least one session.');

  const manifests = sessionIds.map((id) => readManifest(home.root, id));
  assertMaySend({ manifests, remote: [author, judge, embed].filter((c) => c && !c.local).map((c) => `${c.provider}/${c.model}`), sendPrivate: o.sendPrivate, dryRun: o.dryRun });

  const sessions = [];
  const skipped = [];
  const plan = [];
  for (const id of sessionIds) {
    const session = await loadSession(sessionDir(home.root, id));
    const { windows, skipped: empty } = compactionWindows(session);
    for (const e of empty) skipped.push({ sessionId: id, ...e });
    if (!windows.length) {
      if (!empty.length) skipped.push({ sessionId: id, reason: 'no-compactions' });
      continue;
    }
    if (embed) assertChunkVectors(home, id, embed);
    sessions.push({ id, session, windows });
    for (const window of windows) {
      const { items } = planWindowFacts(session.index, window, { count: o.factsPerWindow, seed: o.seed });
      plan.push({ sessionId: id, session, window, items });
    }
  }

  const estimate = estimateCalls(planCalls(plan, { author, judge, embed, candidates: o.candidates }), catalog);
  const counts = { windows: plan.length, facts: plan.reduce((n, p) => n + p.items.length, 0) };
  o.onPlan({ estimate, counts, maxUsd: o.maxUsd });
  if (o.dryRun) return { dryRun: true, estimate, counts };
  checkBudget(estimate, o);

  removeStaleTmp(home.tmp, TMP_PREFIX);
  const runId = newRunId(now());
  const dir = path.join(home.runs, runId);
  fs.mkdirSync(dir, { recursive: true });
  const prompts = Object.fromEntries(['compactionFact', 'compactionPreserved', 'compactionNeeded'].map((n) => [n, loadPrompt(n).sha256]));
  const config = {
    kind: 'compaction-loss', stage: 'B4', runId, commit: deps.commit ?? gitCommit(), seed: o.seed, factsPerWindow: o.factsPerWindow, candidates: o.candidates,
    author: { provider: author.provider, model: author.model }, judge: { provider: judge.provider, model: judge.model },
    embed: embed ? { provider: embed.provider, model: embed.model } : null,
    maxUsd: o.maxUsd, prompts,
    sessions: sessions.map(({ id, session, windows }) => ({
      sessionId: id, source: session.manifest.source ?? null, private: session.manifest.private === true, license: session.manifest.license, windows: windows.length
    })),
    skipped
  };
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const recordsPath = path.join(dir, 'records.jsonl');
  fs.writeFileSync(recordsPath, '');

  const cache = deps.cache || ModelCache.forHome(home);
  const guard = new SpendGuard({ maxUsd: o.maxUsd, catalog });
  const hooks = guard.hooks();
  let spend = null;
  const writeSpend = (stoppedBy = null, extra = {}) => {
    spend = { estimateUsd: estimate.totalUsd, estimateKnownUsd: estimate.knownUsd, ...guard.totals(), stoppedBy, ...extra };
    writeFileAtomic(path.join(dir, 'spend.json'), `${JSON.stringify(spend, null, 2)}\n`);
  };
  writeSpend();
  let finished = false;
  const onSigint = () => {
    try {
      if (!finished) writeSpend('SIGINT', { reservedUsd: round8(guard.reservedUsd) });
    } catch (err) {
      log.warn('could not write spend.json on SIGINT', { code: err.code || 'error' });
    }
    exit(130);
  };
  signals.once('SIGINT', onSigint);

  const records = [];
  const facts = [];
  const spotRows = [];
  const step = { client: null, cache, hooks, retry };
  try {
    for (const { id, session, windows } of sessions) {
      const authored = [];
      for (const p of plan.filter((x) => x.sessionId === id)) {
        const { window } = p;
        const summary = summaryText(session, window);
        for (const item of p.items) {
          const record = {
            sessionId: id, window: window.index, factId: `${id}:${window.index}:${item.anchorSeq}`, kind: item.kind, anchorSeq: item.anchorSeq,
            status: 'judged', tokensToSummary: item.tokensToSummary, costUsd: 0
          };
          records.push(record);
          const a = await authorFact({ session, window, item, ...step, client: author, maxTokens: AUTHOR_MAX_TOKENS });
          record.costUsd = addCost(record.costUsd, a.call);
          if (!a.ok) {
            Object.assign(record, a.reason === 'model-error' ? { status: 'error', reason: a.detail } : { status: 'rejected', reason: a.reason });
            if (a.reason === 'evidence-outside-window') record.evidenceSeq = Number(a.detail);
            continue;
          }
          record.evidenceSeq = a.value.evidenceSeq;
          const pres = await judgePreserved({ fact: a.value.fact, summary, sessionId: id, ...step, client: judge, maxTokens: JUDGE_MAX_TOKENS });
          record.costUsd = addCost(record.costUsd, pres.call);
          if (!pres.ok) {
            Object.assign(record, { status: 'error', reason: pres.reason === 'model-error' ? pres.detail : `preserved-${pres.reason}` });
            continue;
          }
          record.preserved = pres.value.verdict;
          authored.push({ record, window, value: a.value, preserved: pres.value });
        }
        writeSpend();
      }

      if (embed && authored.length) await embedQueries({ home, sessionId: id, embed, facts: authored, hooks, catalog });
      const matcher = authored.length ? await openMatcher({ home, sessionId: id, session, embed: embed ? { provider: embed.provider, model: embed.model } : null }) : null;
      try {
        for (const f of authored) {
          const { record, window, value } = f;
          const later = await matcher.laterMatches(value.fact, value.quote, window.summarySeq, { k: o.candidates });
          let needed = { verdict: 'not-needed', seqs: [], reason: '' };
          if (!later.messages.length) {
            record.noCandidates = true;
          } else {
            const n = await judgeNeeded({ fact: value.fact, candidates: later.messages, sessionId: id, ...step, client: judge, maxTokens: JUDGE_MAX_TOKENS });
            record.costUsd = addCost(record.costUsd, n.call);
            if (!n.ok) {
              Object.assign(record, { status: 'error', reason: n.reason === 'model-error' ? n.detail : `needed-${n.reason}`, candidateCount: later.messages.length });
              continue;
            }
            needed = n.value;
          }
          Object.assign(record, { needed: needed.verdict, candidateCount: later.messages.length, neededSeqs: needed.seqs });
          f.needed = { ...needed, noCandidates: record.noCandidates === true };
        }
      } finally {
        if (matcher) await matcher.release();
      }
      for (const f of authored) {
        facts.push({
          factId: f.record.factId, sessionId: id, window: f.window.index, kind: f.value.kind, fact: f.value.fact, quote: f.value.quote,
          evidenceSeq: f.value.evidenceSeq, preservedReason: f.preserved.reason, neededReason: f.needed?.reason ?? null, neededSeqs: f.needed?.seqs ?? null
        });
        if (f.record.status === 'judged') {
          spotRows.push({
            runId, kind: SPOT_ADAPTER, sessionId: id, questionId: f.record.factId, adapter: SPOT_ADAPTER, factId: f.record.factId, window: f.window.index,
            factKind: f.value.kind, fact: f.value.fact, quote: f.value.quote, evidenceSeq: f.value.evidenceSeq, summarySeq: f.window.summarySeq,
            preserved: f.preserved, needed: f.needed, verdict: f.preserved.verdict
          });
        }
      }
      for (const r of records.filter((x) => x.sessionId === id)) fs.appendFileSync(recordsPath, `${JSON.stringify(r)}\n`);
      writeSpend();
    }
  } catch (err) {
    writeSpend(err.code || 'error');
    finished = true;
    throw err;
  } finally {
    signals.removeListener('SIGINT', onSigint);
  }

  const order = (x, y) => byCodeUnit(x.sessionId, y.sessionId) || x.window - y.window || x.anchorSeq - y.anchorSeq;
  records.sort(order);
  writeFileAtomic(recordsPath, (write) => { for (const r of records) write(`${JSON.stringify(r)}\n`); });
  const privateDir = path.join(home.private, 'compaction', runId);
  facts.sort((x, y) => byCodeUnit(x.factId, y.factId));
  writeFileAtomic(path.join(privateDir, 'facts.jsonl'), (write) => { for (const f of facts) write(`${JSON.stringify(f)}\n`); });
  const spotFile = spotCheckFile(home, runId);
  const spotN = writeSpotCheckSample(spotFile, spotRows, { seed: o.seed });

  const summary = {
    runId,
    sessions: Object.fromEntries(sessions.map(({ id, windows }) => [id, rates(records.filter((r) => r.sessionId === id), windows)])),
    all: rates(records, sessions.flatMap((s) => s.windows))
  };
  writeFileAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileAtomic(path.join(dir, 'summary.md'), summaryMarkdown(config, summary));
  writeSpend();
  finished = true;
  return { runId, dir, config, summary, spend, spotChecks: { file: spotFile, n: spotN } };
}

module.exports = { runCompactionStudy, assertMaySend, readManifest, AUTHOR_MAX_TOKENS, JUDGE_MAX_TOKENS };

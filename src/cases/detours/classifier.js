// src/cases/detours/classifier.js
// Does this work serve the case's objective? One `classify` role call per
// owner message, plan or new job (cases stage 5 spec §3.3). Strict parsing;
// every failure is treated as on-case, so the work proceeds exactly as it
// would have without the classifier.
const crypto = require('crypto');
const { DetourLog } = require('./log');
const { recordOneShotUsage, textOf } = require('../turn-runner');
const { createLogger } = require('../../logging');

const SOURCES = Object.freeze(['owner-message', 'plan', 'executor', 'detour-tool']);
const MIN_OWNER_MESSAGE = 12;
const CACHE_MS = 10 * 60 * 1000;
const FIELD_MAX = 2000;

const CLASSIFY_SYSTEM = [
  "You decide whether a piece of work serves a case's objective.",
  'A detour is work that does not advance the objective, success criteria or hard constraints,',
  'even if it is useful elsewhere (fixing a tool, a different errand, a different project).',
  'Work that the objective cannot proceed without is still a detour if it belongs to a different',
  'system or project; say so in the reason.',
  'If the text contains several requests and ANY of them is a detour, answer onCase: false and',
  'quote the off-case part in the reason.',
  'Reply with one JSON object and nothing else:',
  '{"onCase": true|false, "confidence": 0.0-1.0, "reason": "<one sentence, max 200 characters>"}'
].join('\n');

const clip = (s) => String(s ?? '').slice(0, FIELD_MAX);
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(clip) : []);

// { onCase, confidence, reason } or null (malformed). One surrounding code
// fence is stripped; the reply must then start with `{`; everything after
// the last `}` is ignored.
function parseClassification(raw) {
  let s = String(raw ?? '').trim();
  const fence = /^```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{')) return null;
  const end = s.lastIndexOf('}');
  if (end === -1) return null;
  let v;
  try {
    v = JSON.parse(s.slice(0, end + 1));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.onCase !== 'boolean') return null;
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return null;
  if (typeof v.reason !== 'string' || !v.reason.trim()) return null;
  return { onCase: v.onCase, confidence: v.confidence, reason: v.reason.trim().slice(0, 200) };
}

// The confined tool list a classify call is offered — none of them is ever
// run (this is a one-shot classification call with no executor attached,
// same as orient's), but a non-empty `tools` array is what routes the
// provider through sendMessageWithTools in production: inference-router.js
// execute() only calls a provider's sendMessageWithTools (which reports
// llmMetrics) when `tools.length > 0`, and falls back to plain sendMessage
// (bare text, no metrics) otherwise. Without this, classify calls would
// never charge the case's usd budget. Mirrors turn-runner.js's orient call.
// The list is fixed, not the wake-up list plus the case tools: every extra
// tool costs tokens and invites a tool-call reply, which parses as malformed
// and is silently treated as on-case (final review M3).
const CLASSIFY_TOOLS = Object.freeze(['Read']);

function confinedToolDefinitions(host) {
  const registry = host?.toolRegistry;
  if (!registry || typeof registry.get !== 'function') return [];
  return CLASSIFY_TOOLS.map((n) => registry.get(n)).filter(Boolean).map((t) => t.toFunctionDefinition());
}

class DetourClassifier {
  constructor({ runtime, getSettings = null, log = null, now = null } = {}) {
    if (!runtime) throw new Error('DetourClassifier needs the case runtime.');
    this.runtime = runtime;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => runtime.settings();
    this.log = log || createLogger('cases/detours/classifier');
    this.now = typeof now === 'function' ? now : () => runtime.now();
    this.cache = new Map();
    this.failedTurns = new Set();
  }

  _skip(reason) {
    return { onCase: true, confidence: 0, reason: '', detour: false, failed: null, skipped: reason };
  }

  _cacheKey(meta, objective, { source, serves, text }) {
    return crypto.createHash('sha256').update(JSON.stringify([meta.id, objective, source, serves, text])).digest('hex');
  }

  async classify(caseId, { source, text, serves = null, turn = null } = {}) {
    if (!SOURCES.includes(source)) throw new Error(`Unknown classification source "${source}". Sources: ${SOURCES.join(', ')}.`);
    const meta = this.runtime.getCase(caseId);
    const cfg = this.getSettings().detours;
    const body = String(text ?? '');
    if (source === 'owner-message') {
      if (cfg.classifyOwnerMessages === false) return this._skip('disabled');
      if (meta.status === 'draft') return this._skip('draft');
      if (body.trim().length < MIN_OWNER_MESSAGE) return this._skip('short');
    }
    let brief = {};
    try {
      brief = this.runtime.brief(meta.id).read().data || {};
    } catch {
      brief = {};
    }
    const objective = typeof brief.objective === 'string' ? brief.objective : '';
    const key = this._cacheKey(meta, objective, { source, serves, text: body });
    const nowMs = this.now().getTime();
    const hit = this.cache.get(key);
    if (hit && nowMs - hit.at < CACHE_MS) return { ...hit.result, cached: true };

    // A host without an inference router (some tests, tools-only hosts)
    // cannot classify: skip without a row or a journal line.
    if (typeof this.runtime.host?.inferenceRouter?.routeWithFallback !== 'function') return this._skip('no-router');
    const effectiveTurn = turn || this.runtime.turns?.get(meta.id) || { caseId: meta.id, turnId: null, signal: null };
    const started = Date.now();
    const outcome = await this._call(meta, effectiveTurn, cfg, {
      case: {
        title: clip(meta.title),
        type: clip(meta.type || 'general'),
        objective: clip(objective),
        successCriteria: listOf(brief.successCriteria),
        hardConstraints: listOf(brief.hardConstraints)
      },
      work: { source, serves: serves === null || serves === undefined ? null : clip(serves), text: clip(body) }
    });
    const ms = Date.now() - started;
    let result;
    if (outcome.failed) {
      result = { onCase: true, confidence: 0, reason: '', detour: false, failed: outcome.failed };
    } else {
      const detour = outcome.parsed.onCase === false && outcome.parsed.confidence >= cfg.minConfidence;
      if (outcome.parsed.onCase === false && !detour) {
        this.log.info(`low-confidence detour on case ${meta.slug} (${outcome.parsed.confidence}); treated as on-case`);
      }
      result = { ...outcome.parsed, detour, failed: null };
      this.cache.set(key, { at: nowMs, result });
    }
    await this._record(meta, effectiveTurn, { source, result, model: outcome.model, ms });
    return result;
  }

  async _call(meta, turn, cfg, payload) {
    let resolved;
    try {
      resolved = this.runtime.roleModel(meta.id, 'classify');
    } catch {
      return { failed: 'no-role', model: null };
    }
    const hasToken = this.runtime.host?.hasProviderToken;
    if (!resolved?.provider || (typeof hasToken === 'function' && hasToken(resolved.provider) === false)) {
      return { failed: 'no-role', model: null };
    }
    const model = `${resolved.provider}/${resolved.model || resolved.tier}`;
    const controller = new AbortController();
    let timer = null;
    // Always cleared in `finally` below, including on an awaited timeout —
    // an unref'd timer left pending is what got CI cancelled under Node 22
    // (controller ruling M8), so this one stays ref'd.
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('classify timeout'));
        resolve({ timedOut: true });
      }, cfg.classifyTimeoutMs);
    });
    let reply;
    try {
      const provider = this.runtime.routedProvider(turn, { role: 'classify' });
      const toolDefs = confinedToolDefinitions(this.runtime.host);
      const call = provider.sendMessageWithTools(
        [{ sender: 'user', text: JSON.stringify(payload) }],
        toolDefs,
        { systemPrompt: CLASSIFY_SYSTEM, temperature: 0, maxTokens: 200, abortSignal: controller.signal }
      ).then((value) => ({ value }), (error) => ({ error }));
      const settled = await Promise.race([call, timeout]);
      if (settled.timedOut || controller.signal.aborted) return { failed: 'timeout', model };
      if (settled.error) {
        this.log.warn(`Detour classifier call failed on case ${meta.slug}: ${settled.error.message}`);
        return { failed: 'error', model };
      }
      reply = settled.value;
    } catch (err) {
      this.log.warn(`Detour classifier call failed on case ${meta.slug}: ${err.message}`);
      return { failed: 'error', model };
    } finally {
      clearTimeout(timer);
    }
    // Charging is best-effort: a broken usage tracker must not turn a good
    // classification into a thrown error (general ruling: never throw into
    // the caller).
    try {
      recordOneShotUsage(this.runtime, turn, reply);
    } catch (err) {
      this.log.warn(`Charging the classify call failed: ${err.message}`);
    }
    // A tool-call reply (the model reached for one of the confined tools
    // instead of answering) has no string `content`; textOf then returns
    // '', which parseClassification rejects as malformed — the same
    // fail-open path orient takes for its own tool-call replies.
    const parsed = parseClassification(textOf(reply));
    return parsed ? { parsed, model } : { failed: 'malformed', model };
  }

  // Under the case lock through systemAction: inline inside a turn this
  // process holds; outside one (C3 calling detourGate with no turn) it takes
  // the lock and commits. When another process holds the case, the row is
  // skipped (logged) and the classification still fails open.
  async _record(meta, turn, { source, result, model, ms }) {
    try {
      await this.runtime.systemAction(meta.id, `classify ${source}`, () => this._write(meta, turn, { source, result, model, ms }));
    } catch (err) {
      this.log.warn(`Recording a classification on case ${meta.slug} failed: ${err.message}`);
    }
  }

  _write(meta, turn, { source, result, model, ms }) {
    new DetourLog(meta.dir).append({
      type: 'classification',
      at: this.now().toISOString(),
      turnId: turn?.turnId || null,
      source,
      onCase: result.onCase,
      confidence: result.confidence,
      reason: result.reason,
      model,
      ms,
      failed: result.failed
    });
    const turnKey = `${meta.id}:${turn?.turnId || 'no-turn'}`;
    if (result.failed && !this.failedTurns.has(turnKey)) {
      this.failedTurns.add(turnKey);
      this.runtime.records(meta.id).writeJournal('detour', `Detour classifier failed (${result.failed}) on ${source}; treated as on-case.`, this.now());
    }
  }
}

module.exports = { DetourClassifier, CLASSIFY_SYSTEM, parseClassification, SOURCES };

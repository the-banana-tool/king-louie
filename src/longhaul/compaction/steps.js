'use strict';
// The compaction-loss study's three model steps (benchmark spec §9): author
// one fact from a condensed window (checked mechanically: its evidence is
// inside the window and its quote is in that message), judge whether the
// real summary preserved it, and judge whether a later message needed it.
// Each call goes through the model cache, so a rerun pays only for misses.
// Each step returns { ok: true, value, call } or { ok: false, reason,
// detail, call }; a refused key or an exhausted quota throws, and stops the
// run. Nothing here logs text: facts, quotes and reasons are private.
const { loadPrompt, fillTemplate } = require('../prompts');
const { KIND_RULES, SPAN_MESSAGE_CHARS, clipRendered, parseReply } = require('../author');
const { ANCHOR_SENDERS } = require('../sampling');
const { cacheKey, cachedCall } = require('../model-cache');
const { messageText } = require('../session-format');
const { normalizeText, normalizeAnswer } = require('../scoring');
const { callErrorCode, stopErrorFor } = require('../retry');
const { sha256Text } = require('../files');

const REASON_MAX = 300;
const AUTHOR_MAX_TOKENS = 800;
const JUDGE_MAX_TOKENS = 200;
const PRESERVED_VERDICTS = Object.freeze(['preserved', 'partial', 'lost']);
const NEEDED_VERDICTS = Object.freeze(['needed', 'not-needed']);

const prompts = new Map();
function prompt(name) {
  if (!prompts.has(name)) prompts.set(name, loadPrompt(name));
  return prompts.get(name);
}

const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '');
const fail = (reason, call, detail = null) => ({ ok: false, reason, detail, call });

async function ask({ stage, promptName, values, sessionId, client, cache, hooks, maxTokens, retry }) {
  const p = prompt(promptName);
  const filled = fillTemplate(p.text, values);
  const key = cacheKey({
    stage, sessionId: sessionId ?? null, promptSha256: p.sha256,
    provider: client.provider, model: client.model, baseUrl: client.baseUrl, maxTokens, input: sha256Text(filled)
  });
  try {
    return { call: await cachedCall({ cache, stage, key, client, prompt: filled, maxTokens, hooks, retry }) };
  } catch (err) {
    const stop = stopErrorFor(err, client.provider);
    if (stop) throw stop;
    return { error: callErrorCode(stage, err) };
  }
}

async function authorFact({ session, window, item, client, cache, hooks, maxTokens = AUTHOR_MAX_TOKENS, retry }) {
  const span = [];
  for (let s = item.spanFrom; s <= item.spanTo; s++) {
    const m = session.index.get(s);
    if (m) span.push(clipRendered(m));
  }
  const { call, error } = await ask({
    stage: 'compaction-fact', promptName: 'compactionFact', sessionId: session.manifest?.sessionId,
    values: { kind: item.kind, kindRule: KIND_RULES[item.kind], span: span.join('\n\n') },
    client, cache, hooks, maxTokens, retry
  });
  if (error) return fail('model-error', null, error);
  const parsed = parseReply(call.text);
  if (!parsed) return fail('unparsed', call);
  if (parsed.skip !== undefined) return fail('model-skipped', call);
  const fact = typeof parsed.fact === 'string' ? parsed.fact.trim() : '';
  const quote = typeof parsed.quote === 'string' ? parsed.quote.trim() : '';
  const evidenceSeq = Number(parsed.evidenceSeq);
  const needle = normalizeAnswer(quote);
  if (!fact || !needle || !Number.isInteger(evidenceSeq)) return fail('unparsed', call);
  if (evidenceSeq < window.windowFromSeq || evidenceSeq > window.windowToSeq) {
    return fail('evidence-outside-window', call, String(evidenceSeq));
  }
  if (evidenceSeq < item.spanFrom || evidenceSeq > item.spanTo) return fail('evidence-outside-span', call, String(evidenceSeq));
  const evidence = session.index.get(evidenceSeq);
  if (!ANCHOR_SENDERS[item.kind]?.includes(evidence?.sender)) return fail('evidence-wrong-sender', call, String(evidence?.sender ?? null));
  if (!normalizeText(messageText(evidence)).includes(needle)) return fail('quote-not-found', call);
  return { ok: true, value: { kind: item.kind, fact, quote, evidenceSeq }, call };
}

async function judgePreserved({ fact, summary, sessionId, client, cache, hooks, maxTokens = JUDGE_MAX_TOKENS, retry }) {
  const { call, error } = await ask({
    stage: 'compaction-preserved', promptName: 'compactionPreserved', sessionId,
    values: { fact: String(fact ?? ''), summary: String(summary ?? '') },
    client, cache, hooks, maxTokens, retry
  });
  if (error) return fail('model-error', null, error);
  const parsed = parseReply(call.text);
  const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  if (!PRESERVED_VERDICTS.includes(verdict)) return fail('unparsed', call);
  return { ok: true, value: { verdict, reason: oneLine(parsed.reason) }, call };
}

async function judgeNeeded({ fact, candidates, sessionId, client, cache, hooks, maxTokens = JUDGE_MAX_TOKENS, retry }) {
  const { call, error } = await ask({
    stage: 'compaction-needed', promptName: 'compactionNeeded', sessionId,
    values: { fact: String(fact ?? ''), candidates: candidates.map(clipRendered).join('\n\n') },
    client, cache, hooks, maxTokens, retry
  });
  if (error) return fail('model-error', null, error);
  const parsed = parseReply(call.text);
  const verdict = typeof parsed?.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  if (!NEEDED_VERDICTS.includes(verdict)) return fail('unparsed', call);
  const raw = parsed.seqs === undefined ? [] : parsed.seqs;
  if (!Array.isArray(raw)) return fail('unparsed', call);
  const shown = new Set(candidates.map((m) => m.seq));
  const seqs = [...new Set(raw.map(Number))].sort((a, b) => a - b);
  if (seqs.some((s) => !shown.has(s))) return fail('unparsed', call, 'seq-not-shown');
  if ((verdict === 'needed') !== (seqs.length > 0)) return fail('unparsed', call);
  return { ok: true, value: { verdict, seqs, reason: oneLine(parsed.reason) }, call };
}

module.exports = { PRESERVED_VERDICTS, NEEDED_VERDICTS, authorFact, judgePreserved, judgeNeeded };

// src/cases/ingest/call-model.js
// The one model-call path ingest uses (cases stage 7 spec §3.4). createCore
// builds it from host services, so nothing under src/cases/ingest/ imports a
// provider. Plain sendMessage returns no usage, so calls go through
// sendMessageWithTools with no tools.
// This records usage with the host's usage tracker only. The case budget is
// charged by the caller (IngestService, Task 8): Budget.charge, then
// CaseRuntime.onCrossings, with the cost returned here.
// The reply is untrusted: it is returned as text, capped at MAX_REPLY_CHARS,
// and the caller caps and one-lines whatever it stores.
const { createLogger } = require('../../logging');
const { IngestError } = require('./errors');

const PURPOSES = Object.freeze(['ocr', 'extract', 'verify']);
// Far above any reply at the default 4096 output tokens.
const MAX_REPLY_CHARS = 200000;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
// A cost is a finite, non-negative number or null (nothing prices the model).
const costOf = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

function createCallModel({ resolveInference, getUsageTracker = () => null, log = createLogger('cases/ingest/model') }) {
  if (typeof resolveInference !== 'function') throw new Error('createCallModel needs resolveInference.');
  // → { text, usage: { provider, model, inputTokens, outputTokens, totalTokens, cost } }
  return async function callModel({ purpose, caseId, provider, model, system = '', text = '', attachment = null, maxTokens = 4096 }) {
    if (!PURPOSES.includes(purpose)) throw new Error(`Unknown ingest model purpose: ${purpose}`);
    const documents = Array.isArray(attachment?.documents) && attachment.documents.length ? attachment.documents : null;
    const images = Array.isArray(attachment?.images) && attachment.images.length ? attachment.images : null;
    // OCR with nothing attached would only invent a page.
    if (purpose === 'ocr' && !documents && !images) throw new IngestError('NO_ATTACHMENT', 'There is no page to send to the vision model.');
    const resolved = await resolveInference({ provider, model });
    const client = resolved.provider;
    const useModel = resolved.model || model;
    const message = {
      role: 'user',
      content: String(text),
      ...(documents ? { documents } : {}),
      ...(images ? { images } : {})
    };
    const started = Date.now();
    const res = await client.sendMessageWithTools([message], [], {
      model: useModel,
      systemPrompt: String(system),
      max_tokens: maxTokens,
      temperature: 0
    });
    let out = typeof res === 'string' ? res : String(res?.content ?? res?.messageContent ?? '');
    if (out.length > MAX_REPLY_CHARS) {
      log.warn(`Ingest ${purpose} reply for case ${caseId} was ${out.length} characters; kept the first ${MAX_REPLY_CHARS}.`);
      out = out.slice(0, MAX_REPLY_CHARS);
    }
    const m = res?.llmMetrics || {};
    const inputTokens = num(m.inputTokens);
    const outputTokens = num(m.outputTokens);
    const totalTokens = num(m.totalTokens) || inputTokens + outputTokens;
    let cost = costOf(m.costUsd);
    const usageProvider = m.provider || resolved.providerType || provider;
    const usageModel = m.model || useModel;
    const tracker = getUsageTracker();
    if (tracker && typeof tracker.record === 'function') {
      try {
        const recorded = tracker.record({
          provider: usageProvider,
          model: usageModel,
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd: cost,
          durationMs: Date.now() - started
        });
        if (recorded && Object.prototype.hasOwnProperty.call(recorded, 'cost')) cost = costOf(recorded.cost);
      } catch (err) {
        log.warn(`Recording ingest usage for case ${caseId} failed: ${err.message}`);
      }
    }
    return {
      text: out,
      usage: { provider: usageProvider, model: usageModel, inputTokens, outputTokens, totalTokens, cost }
    };
  };
}

module.exports = { createCallModel, PURPOSES, MAX_REPLY_CHARS };

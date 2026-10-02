'use strict';
// summarize-compact (benchmark spec §7, §16): the compaction baseline. It
// replays the session and, every compactEveryTokens estimated tokens, asks a
// summarizer model to fold the messages since the last checkpoint into a
// running summary (prompts/summarize-v1.md). The context at a question is
// the latest summary made before askAtSeq, then the messages after its
// checkpoint, cut newest first. Checkpoints depend on token counts alone, so
// they are the same for every summarizer and every answer model. The default
// cadence (10K) keeps the context near the budget the other adapters get
// (about 12K with the summary); the session's own compaction points are
// real-compaction's job. Summaries are cached (model-cache stage "summary"),
// so a second run, or the other tier with the same summarizer, pays nothing.
// Their calls are this adapter's setup cost (handle.setup). A message longer
// than SUMMARY_MESSAGE_CHARS goes to the summarizer clipped, with a note.
const { estimateTokens, messageText, renderMessage, CHARS_PER_TOKEN } = require('../session-format');
const { measured, newestFirst } = require('./common');
const { cacheKey, cachedCall } = require('../model-cache');
const { fillTemplate } = require('../prompts');
const { sha256Text } = require('../files');
const { UsageError } = require('../errors');

const DEFAULT_COMPACT_EVERY_TOKENS = 10000;
const DEFAULT_SUMMARY_MAX_TOKENS = 2000;
const SUMMARY_MESSAGE_CHARS = 8000;
// The messages after a checkpoint sum to under compactEveryTokens; their
// rendered headers add a little more.
const TAIL_SLACK = 1.2;
const NO_SUMMARY_YET = '(none yet: this is the start of the session)';

function checkpoints(index, { compactEveryTokens, upToSeq }) {
  const out = [];
  let used = 0;
  const last = Math.min(upToSeq - 1, index.maxSeq);
  for (let seq = 1; seq <= last; seq++) {
    used += estimateTokens(messageText(index.get(seq)));
    if (used >= compactEveryTokens) {
      out.push(seq);
      used = 0;
    }
  }
  return out;
}

function clipForSummary(m) {
  const text = renderMessage(m);
  if (text.length <= SUMMARY_MESSAGE_CHARS) return text;
  return `${text.slice(0, SUMMARY_MESSAGE_CHARS)}\n[... ${text.length - SUMMARY_MESSAGE_CHARS} more characters not shown to the summarizer]`;
}

function windowText(index, fromSeq, toSeq) {
  const parts = [];
  for (let s = fromSeq; s <= toSeq; s++) parts.push(clipForSummary(index.get(s)));
  return parts.join('\n\n');
}

function createSummarizeCompactAdapter({ compactEveryTokens = DEFAULT_COMPACT_EVERY_TOKENS, summarizer = null } = {}) {
  if (!Number.isInteger(compactEveryTokens) || compactEveryTokens <= 0) {
    throw new UsageError(`--compact-every-tokens must be a positive whole number, got ${JSON.stringify(compactEveryTokens)}`);
  }
  const maxTokens = summarizer?.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
  const need = () => {
    if (!summarizer?.client || !summarizer.cache || !summarizer.prompt) {
      throw new UsageError('summarize-compact needs a summarizer model: run it in the answer stage (--answer-model, or --summarizer-model).');
    }
    return summarizer;
  };
  const promptFor = (s, previous, messages) => fillTemplate(s.prompt.text, {
    previous: previous ?? NO_SUMMARY_YET, messages, maxWords: String(Math.floor(maxTokens * 0.6))
  });
  // baseUrl is set only for a --summarizer-base-url client (undefined drops
  // out of the key), so another endpoint serving the same model name never
  // reuses these summaries.
  const keyFor = (s, prompt) => cacheKey({
    stage: 'summary', provider: s.client.provider, model: s.client.model, baseUrl: s.client.baseUrl,
    promptSha256: s.prompt.sha256, maxTokens, inputSha256: sha256Text(prompt)
  });

  return {
    name: 'summarize-compact',
    usesModel: true,
    get modelClient() { return summarizer?.client ?? null; },
    describe() {
      return {
        name: 'summarize-compact', compactEveryTokens, summaryMaxTokens: maxTokens,
        summarizer: summarizer?.client ? `${summarizer.client.provider}/${summarizer.client.model}` : null,
        summarizePromptSha256: summarizer?.prompt?.sha256 ?? null
      };
    },

    // The summaries a prepare() would make now. The chain is walked through
    // the cache while its links are there; after the first missing link
    // every later summary is a call whose previous summary is not written
    // yet, counted at maxTokens.
    estimate(session, { upToSeq }) {
      const s = need();
      const { index } = session;
      const model = { provider: s.client.provider, model: s.client.model, local: Boolean(s.client.local) };
      const calls = [];
      let previous = null;
      let known = true;
      let cached = 0;
      let from = 1;
      for (const c of checkpoints(index, { compactEveryTokens, upToSeq })) {
        const messages = windowText(index, from, c);
        from = c + 1;
        if (known) {
          const prompt = promptFor(s, previous, messages);
          const hit = s.cache.get('summary', keyFor(s, prompt));
          if (hit) {
            previous = hit.text;
            cached += 1;
            continue;
          }
          known = false;
          calls.push({ ...model, inputChars: prompt.length, extraInputTokens: 0, maxTokens });
        } else {
          calls.push({ ...model, inputChars: s.prompt.text.length + messages.length, extraInputTokens: maxTokens, maxTokens });
        }
      }
      return { calls, cached, contextChars: (Math.ceil(compactEveryTokens * TAIL_SLACK) + maxTokens) * CHARS_PER_TOKEN + 64 };
    },

    async prepare(session, { upToSeq = Infinity, hooks } = {}) {
      const s = need();
      const { index } = session;
      const summaries = [];
      const setup = { calls: 0, cachedCalls: 0, costUsd: 0, unpricedCalls: 0 };
      let previous = null;
      let from = 1;
      for (const c of checkpoints(index, { compactEveryTokens, upToSeq })) {
        const prompt = promptFor(s, previous, windowText(index, from, c));
        const out = await cachedCall({
          cache: s.cache, stage: 'summary', key: keyFor(s, prompt), client: s.client, prompt, maxTokens, hooks,
          retry: s.retry || {}, meta: { sessionId: session.manifest.sessionId, throughSeq: c }
        });
        if (out.cached) setup.cachedCalls += 1;
        else setup.calls += 1;
        if (out.costUsd === null) setup.unpricedCalls += 1;
        else setup.costUsd += out.costUsd;
        summaries.push({ seq: c, text: out.text });
        previous = out.text;
        from = c + 1;
      }
      setup.costUsd = Number(setup.costUsd.toFixed(8));
      return { session, summaries, setup };
    },

    async context(handle, { askAtSeq }) {
      return measured(async () => {
        const { index } = handle.session;
        let latest = null;
        for (const s of handle.summaries) {
          if (s.seq < askAtSeq) latest = s;
          else break;
        }
        const header = latest ? `[summary of messages #1-#${latest.seq}]\n${latest.text}` : null;
        const tail = newestFirst(index, { fromSeq: latest ? latest.seq + 1 : 1, beforeSeq: askAtSeq, limit: Math.ceil(compactEveryTokens * TAIL_SLACK) });
        const text = [header, tail.text].filter(Boolean).join('\n\n');
        return {
          text, evidenceSeqsShown: tail.seqs, evidenceSeqsPartial: tail.partial,
          estTokens: estimateTokens(text), cost: 0, truncated: tail.truncated, compactionSeq: latest ? latest.seq : null
        };
      });
    },

    async release() {}
  };
}

module.exports = {
  DEFAULT_COMPACT_EVERY_TOKENS, DEFAULT_SUMMARY_MAX_TOKENS, SUMMARY_MESSAGE_CHARS, checkpoints, createSummarizeCompactAdapter
};

'use strict';
// kl-recall-digest (local inference spec 2026-10-13 §11.3; R-LI-14): a
// probe, not a candidate system. kl-recall, plus digests: in prepare, every
// digestEveryTokens estimated tokens of the session (the checkpoints
// summarize-compact uses) a local model writes a digest of that span
// (prompts/digest-v1.md). The digests compete with ordinary chunks for the
// recalled block. Compared against kl-recall and summarize-compact.
//
// How a digest enters the temporary store without becoming a message of the
// session: the session's chat holds its messages alone (seq for seq, as
// kl-recall's), and the digests are rows of a second chat in the same store,
// each a status message marked as a compaction summary, which the chunker
// indexes as kind "summary" (kindWeights already weights it 0.9). The
// builder reads both chats (its scope is the session's chat and the digest
// chat), and upToSeq still cuts the session's chat only.
//
// Rules that keep the numbers honest:
// - No leak: a digest covers only messages before upToSeq, and one whose
//   span reaches the question (toSeq >= askAtSeq) is never a search hit for
//   it (digestAllowed, applied to every search). The result's coveredSeqs
//   are the messages the shown digests cover, which LongHaul's leak check
//   counts.
// - A digest is not evidence (D-LI-4): the evidence accounting reads the
//   session's chat alone, so a message covered by a digest is neither whole
//   nor partial.
// The digests are this adapter's local calls, cached (model-cache stage
// "digest"); the answer stage and its dry run are cache-only
// (LOCAL_CALLS_MISSING, thrown from prepare).
const fs = require('fs');
const path = require('path');
const { HistoryStore } = require('../../history');
const { TokenEstimator } = require('../../history/token-estimator');
const { Retriever } = require('../../history/retriever');
const { ContextBuilder } = require('../../history/context-builder');
const { recallSettings, resultFromBuild, TMP_PREFIX, ESTIMATOR_MODEL } = require('./kl-recall');
const { checkpoints, SUMMARY_MESSAGE_CHARS } = require('./summarize-compact');
const { measured, uniqueSorted } = require('./common');
const { createLocalCaller, localModelLabel } = require('../local-client');
const { loadPrompt, fillTemplate } = require('../prompts');
const { renderMessage } = require('../session-format');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/kl-recall-digest');

const DEFAULT_DIGEST_EVERY_TOKENS = 10000;
const DEFAULT_DIGEST_MAX_TOKENS = 400;
const DIGEST_CHAT_TITLE = 'digests';

// The leak rule: a digest is shown only for a question asked after its span.
const digestBeforeQuestion = (digest, askAtSeq) => digest.toSeq < askAtSeq;

function windowText(index, fromSeq, toSeq) {
  const parts = [];
  for (let s = fromSeq; s <= toSeq; s++) {
    const text = renderMessage(index.get(s));
    parts.push(text.length <= SUMMARY_MESSAGE_CHARS
      ? text
      : `${text.slice(0, SUMMARY_MESSAGE_CHARS)}\n[... ${text.length - SUMMARY_MESSAGE_CHARS} more characters not shown to the digest model]`);
  }
  return parts.join('\n\n');
}

function positiveWhole(value, flag) {
  if (!Number.isInteger(value) || value <= 0) throw new UsageError(`--${flag} must be a positive whole number, got ${JSON.stringify(value)}`);
  return value;
}

function createKlRecallDigestAdapter({
  budgetTokens = 6000, recall = {}, chunk = {}, tmpRoot, local = null,
  digestEveryTokens = DEFAULT_DIGEST_EVERY_TOKENS, digestMaxTokens = DEFAULT_DIGEST_MAX_TOKENS,
  digestAllowed = digestBeforeQuestion
} = {}) {
  const name = 'kl-recall-digest';
  if (typeof tmpRoot !== 'string' || !tmpRoot) throw new Error('kl-recall-digest needs a tmpRoot (LONGHAUL_HOME/tmp)');
  positiveWhole(digestEveryTokens, 'digest-every-tokens');
  positiveWhole(digestMaxTokens, 'digest-max-tokens');
  const caller = createLocalCaller(local, name);
  const prompt = loadPrompt('digest');
  const settings = recallSettings(recall, budgetTokens, chunk);
  const counts = { digests: 0, empty: 0, shown: 0 };

  return {
    name,
    get modelClient() { return caller.client; },
    localUse: { client: caller.client, prompts: { digest: { file: prompt.file, sha256: prompt.sha256 } } },
    describe() {
      return {
        name, recall: settings.history.recall, chunk: settings.history.chunk ?? null, embedder: 'none (BM25 only)',
        digestEveryTokens, digestMaxTokens, localModel: localModelLabel(caller.client), localDigest: caller.client.digest ?? null,
        digestPromptSha256: prompt.sha256
      };
    },

    async prepare(session, { upToSeq = Infinity } = {}) {
      const { index } = session;
      // The digests first: nothing is written before every call has answered
      // (or, in the answer stage, is known to be cached).
      const spans = [];
      let from = 1;
      for (const to of checkpoints(index, { compactEveryTokens: digestEveryTokens, upToSeq })) {
        spans.push({ fromSeq: from, toSeq: to });
        from = to + 1;
      }
      const made = [];
      for (const span of spans) {
        const text = fillTemplate(prompt.text, {
          maxWords: String(Math.floor(digestMaxTokens * 0.6)), fromSeq: String(span.fromSeq), toSeq: String(span.toSeq),
          messages: windowText(index, span.fromSeq, span.toSeq)
        });
        const out = await caller.call({
          stage: 'digest', prompt: text, promptFile: prompt, maxTokens: digestMaxTokens,
          meta: { sessionId: session.manifest.sessionId, fromSeq: span.fromSeq, toSeq: span.toSeq }
        });
        if (!String(out.text).trim()) {
          counts.empty += 1;
          continue;
        }
        made.push({ ...span, text: String(out.text).trim() });
      }
      counts.digests += made.length;

      const dir = fs.mkdtempSync(path.join(tmpRoot, TMP_PREFIX));
      let store = null;
      try {
        store = HistoryStore.open(path.join(dir, 'history.sqlite'), { chunkOptions: settings.history.chunk });
        const chatId = `longhaul-${session.manifest.sessionId}`;
        const digestChatId = `${chatId}-digests`;
        const first = session.messages[0];
        store.createChat({ id: chatId, title: session.manifest.sessionId, createdAt: first?.timestamp, updatedAt: first?.timestamp, messages: [] });
        for (const m of session.messages) {
          if (m.seq >= upToSeq) break;
          const { seq, ...message } = m;
          const out = store.appendMessage(chatId, message);
          if (!out || out.seq !== seq) {
            throw new Error(`seq drift in ${session.manifest.sessionId}: message ${m.id} is #${seq} in the session but #${out?.seq} in the store`);
          }
        }
        store.createChat({ id: digestChatId, title: DIGEST_CHAT_TITLE, createdAt: first?.timestamp, updatedAt: first?.timestamp, messages: [] });
        // Each digest chunk id, mapped to the digest it belongs to.
        const byChunk = new Map();
        const digests = [];
        for (const d of made) {
          const at = index.get(d.toSeq)?.timestamp || first?.timestamp;
          const out = store.appendMessage(digestChatId, {
            id: `digest-${d.fromSeq}-${d.toSeq}`, sender: 'status', text: d.text, timestamp: at, meta: { compaction: true }
          });
          const digest = { fromSeq: d.fromSeq, toSeq: d.toSeq, messageId: out.message.id };
          digests.push(digest);
          for (const c of store.chunksOfMessage(out.message.id)) byChunk.set(c.id, digest);
        }
        // Every search the retriever makes goes through the leak rule.
        const handle = { dir, store, chatId, digestChatId, settings, session, digests, byChunk, askAtSeq: null };
        const searchable = Object.create(store);
        searchable.searchText = (query, options) => store.searchText(query, options).filter((hit) => {
          const d = byChunk.get(hit.chunkId);
          return !d || digestAllowed(d, handle.askAtSeq);
        });
        const estimator = new TokenEstimator({ store });
        const retriever = new Retriever({ store: searchable, estimator });
        const resolveScope = (id) => (id === chatId
          ? { effective: 'linked', chatIds: [chatId, digestChatId], titles: new Map([[digestChatId, DIGEST_CHAT_TITLE]]) }
          : null);
        handle.builder = new ContextBuilder({ store, retriever, estimator, getSettings: () => settings, resolveScope });
        log.debug('prepared', { sessionId: session.manifest.sessionId, digests: digests.length });
        return handle;
      } catch (err) {
        try { store?.close(); } catch { /* already failing */ }
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    },

    async context(handle, { question, askAtSeq }) {
      return measured(async () => {
        handle.askAtSeq = askAtSeq;
        try {
          const out = await handle.builder.build({
            chatId: handle.chatId, message: question.question, model: ESTIMATOR_MODEL, upToSeq: askAtSeq, crossChat: true
          });
          const result = resultFromBuild(handle, out);
          const ids = out.recalled?.chunkIds || [];
          const shown = [...new Set(ids.map((id) => handle.byChunk.get(id)).filter(Boolean))];
          counts.shown += shown.length;
          const coveredSeqs = uniqueSorted(shown.flatMap((d) => Array.from({ length: d.toSeq - d.fromSeq + 1 }, (_, i) => d.fromSeq + i)));
          return { ...result, coveredSeqs, digestsShown: shown.length };
        } finally {
          handle.askAtSeq = null;
        }
      });
    },

    async release(handle) {
      try {
        handle.store.close();
      } finally {
        fs.rmSync(handle.dir, { recursive: true, force: true });
      }
    },

    // Numbers only, for adapter-stats.json.
    runStats() {
      return { mode: `every ${digestEveryTokens} tokens`, ...caller.summary(), ...counts };
    }
  };
}

module.exports = { createKlRecallDigestAdapter, digestBeforeQuestion, DEFAULT_DIGEST_EVERY_TOKENS, DEFAULT_DIGEST_MAX_TOKENS };

'use strict';
// kl-recall (benchmark spec §7): recall's ContextBuilder over a temporary
// history store, one store per session. Each question is asked with
// upToSeq = askAtSeq (exclusive), in place of the user message there, so
// nothing at or after the question can be shown. BM25 only.
const fs = require('fs');
const path = require('path');
const { HistoryStore } = require('../../history');
const { TokenEstimator } = require('../../history/token-estimator');
const { Retriever } = require('../../history/retriever');
const { ContextBuilder } = require('../../history/context-builder');
const { chunkMessage } = require('../../history/chunker');
const { mergeSettings } = require('../../core/settings');
const { HISTORY_DEFAULTS, mergeHistorySettings } = require('../../history/settings');
const { estimateTokens, renderMessages } = require('../session-format');
const { measured, uniqueSorted } = require('./common');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/kl-recall');
const ESTIMATOR_MODEL = 'longhaul-estimate';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Whether the settings merge kept a --recall value as given (an object value,
// kindWeights, keeps each given entry; the rest come from the defaults).
function kept(given, merged) {
  if (isObject(given)) return isObject(merged) && Object.entries(given).every(([k, v]) => k in merged && Object.is(merged[k], v));
  return Object.is(given, merged);
}

// The effective settings: --recall values through mergeHistorySettings,
// recalledTokens from the budget. A value the merge would replace with its
// default (out of range, wrong type, not a whole number) is refused rather
// than silently changed.
function recallSettings(recall, budgetTokens) {
  const known = Object.keys(HISTORY_DEFAULTS.recall);
  for (const key of Object.keys(recall)) {
    if (!known.includes(key)) throw new UsageError(`Unknown recall setting "${key}". Known: ${[...known].sort().join(', ')}`);
    if (key === 'recalledTokens') throw new UsageError('--recall recalledTokens is not accepted: the recalled budget is set with --budget-tokens.');
  }
  const history = mergeHistorySettings({ recall: { ...recall, recalledTokens: budgetTokens } });
  for (const [key, value] of Object.entries(recall)) {
    if (!kept(value, history.recall[key])) {
      throw new UsageError(`--recall ${key}=${JSON.stringify(value)} is not a valid value; recall would use ${JSON.stringify(history.recall[key])} instead.`);
    }
  }
  return { ...mergeSettings({}), history };
}

// Which seqs a build put in front of the model, whole or in part (benchmark
// findings 5 and 6). Never the stats.tail fromSeq..toSeq range, which also
// spans the tool results the tail leaves out.
// - A tail message is shown whole unless ContextBuilder shortened it
//   (stats.tail.shortened: text or documents cut), then it is partial.
// - A tool call folded into the tail (in stats.tail.seqs but not a tail
//   message) is shown as a one-line summary, so it is partial.
// - A tool result folded into the tail (stats.tail.toolResultSeqs, with
//   tailIncludeToolResults) is whole unless shortened, then partial.
// - A recalled message is whole when all its chunks were recalled
//   (totalOf(seq), what chunkMessage cuts it into), else partial.
function shownFromBuild(out, chunkRows, chatId, totalOf = () => Infinity) {
  const tailMessageSeqs = uniqueSorted((out.tail || []).map((m) => m.seq).filter(Number.isInteger));
  const statsTail = out.stats?.tail || {};
  const tailSeqs = uniqueSorted([...tailMessageSeqs, ...(statsTail.seqs || []).filter(Number.isInteger)]);
  const shortened = new Set((statsTail.shortened || []).map((x) => x && x.seq).filter(Number.isInteger));
  const tailWholeSeqs = uniqueSorted([...tailMessageSeqs, ...(statsTail.toolResultSeqs || []).filter(Number.isInteger)])
    .filter((seq) => !shortened.has(seq));

  const shownBySeq = {};
  for (const c of chunkRows) {
    if (c.chatId !== chatId) continue;
    shownBySeq[c.seq] = (shownBySeq[c.seq] || 0) + 1;
  }
  const recalledSeqs = uniqueSorted(Object.keys(shownBySeq).map(Number));
  const totalBySeq = {};
  for (const seq of recalledSeqs) totalBySeq[seq] = totalOf(seq);

  const whole = new Set();
  for (const seq of tailWholeSeqs) whole.add(seq);
  for (const seq of recalledSeqs) if (shownBySeq[seq] >= totalBySeq[seq]) whole.add(seq);
  const partial = [...tailSeqs, ...recalledSeqs].filter((seq) => !whole.has(seq));
  return {
    tailSeqs,
    tailWholeSeqs,
    shortened: statsTail.shortened || [],
    recalledSeqs,
    shownBySeq,
    totalBySeq,
    evidenceSeqsShown: uniqueSorted([...whole]),
    evidenceSeqsPartial: uniqueSorted(partial)
  };
}

// Prefix of the temp store dirs under tmpRoot; `run` removes leftovers.
const TMP_PREFIX = 'kl-';

// tmpRoot is required (LONGHAUL_HOME/tmp from `run`): the store holds the
// session's full text, so it never goes to the system temp dir.
function createKlRecallAdapter({ budgetTokens = 6000, recall = {}, tmpRoot } = {}) {
  if (typeof tmpRoot !== 'string' || !tmpRoot) throw new Error('kl-recall needs a tmpRoot (LONGHAUL_HOME/tmp)');
  const settings = recallSettings(recall, budgetTokens);
  return {
    name: 'kl-recall',
    describe() {
      return { name: 'kl-recall', recall: settings.history.recall, chunk: settings.history.chunk ?? null, embedder: 'none (BM25 only)' };
    },

    async prepare(session, { upToSeq = Infinity } = {}) {
      const dir = fs.mkdtempSync(path.join(tmpRoot, TMP_PREFIX));
      let store = null;
      try {
        store = HistoryStore.open(path.join(dir, 'history.sqlite'), { chunkOptions: settings.history.chunk });
        const chatId = `longhaul-${session.manifest.sessionId}`;
        const first = session.messages[0];
        store.createChat({ id: chatId, title: session.manifest.sessionId, createdAt: first?.timestamp, updatedAt: first?.timestamp, messages: [] });
        let appended = 0;
        for (const m of session.messages) {
          if (m.seq >= upToSeq) break;
          const { seq, ...message } = m;
          const out = store.appendMessage(chatId, message);
          if (!out || out.seq !== seq) {
            throw new Error(`seq drift in ${session.manifest.sessionId}: message ${m.id} is #${seq} in the session but #${out?.seq} in the store`);
          }
          appended += 1;
        }
        log.debug('prepared', { sessionId: session.manifest.sessionId, appended });
        const estimator = new TokenEstimator({ store });
        const retriever = new Retriever({ store, estimator });
        const builder = new ContextBuilder({ store, retriever, estimator, getSettings: () => settings });
        return { dir, store, chatId, builder, settings, session };
      } catch (err) {
        try { store?.close(); } catch { /* already failing */ }
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    },

    async context(handle, { question, askAtSeq }) {
      return measured(async () => {
        // build() takes the new user message as a string; upToSeq is exclusive.
        const out = await handle.builder.build({ chatId: handle.chatId, message: question.question, model: ESTIMATOR_MODEL, upToSeq: askAtSeq });
        const chunkIds = out.recalled?.chunkIds || [];
        const rows = chunkIds.length ? handle.store.chunks(chunkIds) : [];
        const shown = shownFromBuild(out, rows, handle.chatId, (seq) => {
          const m = handle.session.index.get(seq);
          return m ? chunkMessage(m, handle.settings.history.chunk).length : 0;
        });
        // Chunk level: a whole tail message counts 1; a shortened one counts
        // the paragraphs ContextBuilder showed of its own.
        const shownBySeq = { ...shown.shownBySeq };
        const totalBySeq = { ...shown.totalBySeq };
        for (const x of shown.shortened) {
          if (Number.isInteger(x?.seq) && Number.isInteger(x.shown) && Number.isInteger(x.total) && !(x.seq in totalBySeq)) {
            shownBySeq[x.seq] = x.shown;
            totalBySeq[x.seq] = x.total;
          }
        }
        const text = [renderMessages(out.tail || []), out.recalled?.text || ''].filter(Boolean).join('\n\n');
        return {
          text,
          evidenceSeqsShown: shown.evidenceSeqsShown,
          evidenceSeqsPartial: shown.evidenceSeqsPartial,
          estTokens: estimateTokens(text),
          cost: 0,
          chunks: { tailSeqs: shown.tailWholeSeqs, shownBySeq, totalBySeq }
        };
      });
    },

    async release(handle) {
      try {
        handle.store.close();
      } finally {
        fs.rmSync(handle.dir, { recursive: true, force: true });
      }
    }
  };
}

module.exports = { createKlRecallAdapter, shownFromBuild, recallSettings, TMP_PREFIX };

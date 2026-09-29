'use strict';
// kl-recall (benchmark spec §7): recall's ContextBuilder over a temporary
// history store, one store per session. Each question is asked with
// upToSeq = askAtSeq (exclusive), in place of the user message there, so
// nothing at or after the question can be shown. BM25 only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../../history');
const { TokenEstimator } = require('../../history/token-estimator');
const { Retriever } = require('../../history/retriever');
const { ContextBuilder } = require('../../history/context-builder');
const { chunkMessage } = require('../../history/chunker');
const { mergeSettings } = require('../../core/settings');
const { estimateTokens, renderMessages } = require('../session-format');
const { measured, uniqueSorted } = require('./common');
const { UsageError } = require('../errors');
const { createLogger } = require('../../logging');

const log = createLogger('longhaul/kl-recall');
const ESTIMATOR_MODEL = 'longhaul-estimate';

function recallSettings(recall, budgetTokens) {
  const base = mergeSettings({});
  const history = base.history || {};
  const defaults = history.recall || {};
  for (const key of Object.keys(recall)) {
    if (!(key in defaults)) throw new UsageError(`Unknown recall setting "${key}". Known: ${Object.keys(defaults).sort().join(', ')}`);
  }
  return { ...base, history: { ...history, recall: { ...defaults, ...recall, recalledTokens: budgetTokens } } };
}

// Which seqs a build put in front of the model: the tail messages it
// returned (not the stats.tail range, which also spans the tool results the
// tail leaves out) and the messages of its recalled chunks in this chat.
function shownFromBuild(out, chunkRows, chatId) {
  const tailSeqs = uniqueSorted((out.tail || []).map((m) => m.seq).filter(Number.isInteger));
  const shownBySeq = {};
  for (const c of chunkRows) {
    if (c.chatId !== chatId) continue;
    shownBySeq[c.seq] = (shownBySeq[c.seq] || 0) + 1;
  }
  const recalledSeqs = uniqueSorted(Object.keys(shownBySeq).map(Number));
  return { tailSeqs, recalledSeqs, shownBySeq, evidenceSeqsShown: uniqueSorted([...tailSeqs, ...recalledSeqs]) };
}

function createKlRecallAdapter({ budgetTokens = 6000, recall = {}, tmpRoot = os.tmpdir() } = {}) {
  const settings = recallSettings(recall, budgetTokens);
  return {
    name: 'kl-recall',
    describe() {
      return { name: 'kl-recall', recall: settings.history.recall, chunk: settings.history.chunk ?? null, embedder: 'none (BM25 only)' };
    },

    async prepare(session, { upToSeq = Infinity } = {}) {
      const dir = fs.mkdtempSync(path.join(tmpRoot, 'longhaul-kl-'));
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
        const shown = shownFromBuild(out, rows, handle.chatId);
        const totalBySeq = {};
        for (const seq of shown.recalledSeqs) {
          const m = handle.session.index.get(seq);
          totalBySeq[seq] = m ? chunkMessage(m, handle.settings.history.chunk).length : 0;
        }
        const text = [renderMessages(out.tail || []), out.recalled?.text || ''].filter(Boolean).join('\n\n');
        return {
          text,
          evidenceSeqsShown: shown.evidenceSeqsShown,
          estTokens: estimateTokens(text),
          cost: 0,
          chunks: { tailSeqs: shown.tailSeqs, shownBySeq: shown.shownBySeq, totalBySeq }
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

module.exports = { createKlRecallAdapter, shownFromBuild, recallSettings };

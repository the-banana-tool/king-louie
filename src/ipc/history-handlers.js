// src/ipc/history-handlers.js
// The recall line's excerpt drawer and an owner-side search (history spec
// 2026-09-25 §7, §12), and the embedder's state, choice, rebuild and retry
// (§5.2, §14). Excerpt text is untrusted: the renderer sets it with
// textContent only.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { mergeHistorySettings } = require('../history/settings');
const { searchHistoryExcerpts, excerptsForMessage } = require('../history/search');

const view = (e) => ({ seq: e.seq, header: e.header, text: e.text });

function registerHistoryHandlers(ipcMain, context = {}) {
  const store = () => {
    const s = typeof context.getHistoryStore === 'function' ? context.getHistoryStore() : null;
    if (!s) throw new Error('Chat history is not available in this host.');
    return s;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => (
    fn(payload && typeof payload === 'object' ? payload : {})
  )));

  handle(IPC.HISTORY_EXCERPTS, async ({ chatId, seq }) => {
    if (typeof chatId !== 'string' || !chatId || !Number.isInteger(seq) || seq < 1) {
      return { ok: false, error: 'chatId and a message number are required.' };
    }
    return { ok: true, untrustedText: true, excerpts: excerptsForMessage({ store: store(), chatId, seq }).map(view) };
  });

  handle(IPC.HISTORY_SEARCH, async ({ chatId, query, limit }) => {
    if (typeof chatId !== 'string' || !chatId || typeof query !== 'string' || !query.trim()) {
      return { ok: false, error: 'chatId and a query are required.' };
    }
    const retriever = typeof context.getHistoryRetriever === 'function' ? context.getHistoryRetriever() : null;
    if (!retriever) throw new Error('History search is not available in this host.');
    const settings = mergeHistorySettings(((typeof context.getSettings === 'function' && context.getSettings()) || {}).history);
    const excerpts = await searchHistoryExcerpts({
      store: store(),
      retriever,
      chatId,
      query,
      limit: Math.min(50, Math.max(1, Math.floor(Number(limit) || 10))),
      settings: settings.recall
    });
    return { ok: true, untrustedText: true, excerpts: excerpts.map(view) };
  });

  // The embedder (recall spec §5.2, §14) and the reranker (§6.3 step 6).
  // Host strings (an error, a model id) are shown with textContent. The
  // typesafe.ai key goes in through history:jev.saveKey and never comes back.
  const OFF = Object.freeze({ kind: 'none', key: null, state: 'off', download: null, error: null, tokens: 0 });
  const JEV_OFF = Object.freeze({ kind: 'local', model: null, state: 'off', error: null, hasKey: false, tokens: 0, requests: 0 });
  const hostOf = () => (typeof context.getEmbedderHost === 'function' ? context.getEmbedderHost() : null);
  const jevOf = () => (typeof context.getJevReranker === 'function' ? context.getJevReranker() : null);
  const settingsNow = () => ((typeof context.getSettings === 'function' && context.getSettings()) || {});
  const pick = (o, keys) => {
    const out = {};
    if (o && typeof o === 'object') for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
    return out;
  };
  const embedderView = () => {
    const host = hostOf();
    const jev = jevOf();
    const indexer = typeof context.getEmbedIndexer === 'function' ? context.getEmbedIndexer() : null;
    const history = mergeHistorySettings(settingsNow().history);
    const rerank = history.recall.rerank;
    return {
      ok: true,
      untrustedText: true,
      status: host ? host.status() : { ...OFF },
      progress: indexer ? indexer.progress() : null,
      jev: jev ? jev.status() : { ...JEV_OFF, kind: rerank.kind },
      settings: { embedder: history.embedder, rerank: { enabled: rerank.enabled, search: rerank.search, kind: rerank.kind } }
    };
  };

  handle(IPC.HISTORY_EMBEDDER_STATUS, async () => embedderView());

  handle(IPC.HISTORY_EMBEDDER_SAVE, async ({ embedder, rerank, confirmJev }) => {
    if (typeof context.setSettings !== 'function') throw new Error('Settings are not available in this host.');
    const all = settingsNow();
    const current = mergeHistorySettings(all.history);
    const e = embedder && typeof embedder === 'object' ? embedder : {};
    const wanted = {
      ...current,
      embedder: {
        ...current.embedder,
        ...pick(e, ['kind', 'model']),
        ollama: { ...current.embedder.ollama, ...pick(e.ollama, ['baseUrl', 'model']) },
        openai: { ...current.embedder.openai, ...pick(e.openai, ['model']) }
      },
      recall: { ...current.recall, rerank: { ...current.recall.rerank, ...pick(rerank, ['enabled', 'search', 'kind']) } }
    };
    const next = mergeHistorySettings(wanted);
    // A value the merge would replace with its default is refused, never
    // saved as something the owner did not type.
    const trim = (v) => (typeof v === 'string' ? v.replace(/\/+$/, '') : v);
    const checks = [
      ['embedder kind', wanted.embedder.kind, next.embedder.kind],
      ['local model', wanted.embedder.model, next.embedder.model],
      ['Ollama address', trim(wanted.embedder.ollama.baseUrl), next.embedder.ollama.baseUrl],
      ['Ollama model', wanted.embedder.ollama.model, next.embedder.ollama.model],
      ['OpenAI model', wanted.embedder.openai.model, next.embedder.openai.model],
      ['per-turn rerank', wanted.recall.rerank.enabled, next.recall.rerank.enabled],
      ['SearchHistory rerank', wanted.recall.rerank.search, next.recall.rerank.search],
      ['reranker', wanted.recall.rerank.kind, next.recall.rerank.kind]
    ];
    const refused = checks.find(([, given, kept]) => given !== kept);
    if (refused) return { ok: false, error: `Not a valid ${refused[0]}: ${JSON.stringify(refused[1])}` };
    // Opt-in (spec §14): Jev sends chat excerpts to typesafe.ai, so every
    // save that keeps or chooses it carries the pane's ticked box; an owner
    // who unticks it and saves is refused, not left on Jev.
    if (next.recall.rerank.kind === 'jev' && confirmJev !== true) {
      return {
        ok: false,
        error: 'Jev sends excerpts of your chats to typesafe.ai: tick "Allow sending to typesafe.ai" to keep it, or choose "On this computer".'
      };
    }
    context.setSettings({ ...all, history: next });
    // A pause or warning from one Jev choice never carries into the next
    // (jev -> local -> jev, or another Jev model).
    const was = current.recall.rerank;
    const now = next.recall.rerank;
    const jev = jevOf();
    if (jev && (was.kind !== now.kind || was.jev.model !== now.jev.model)) jev.reset();
    return embedderView();
  });

  handle(IPC.HISTORY_EMBEDDER_REBUILD, async () => {
    const host = hostOf();
    const key = host ? host.status().key : null;
    if (!key) return { ok: false, error: 'Embeddings are off.' };
    const removed = store().deleteEmbeddings(key);
    return { ...embedderView(), removed };
  });

  handle(IPC.HISTORY_EMBEDDER_RETRY, async () => {
    const host = hostOf();
    const jev = jevOf();
    if (!host && !jev) return { ok: false, error: 'Embeddings are not available in this host.' };
    if (host) host.retry();
    if (jev) jev.reset();
    return embedderView();
  });

  handle(IPC.HISTORY_JEV_SAVE_KEY, async ({ key }) => {
    if (typeof context.saveTypesafeKey !== 'function') throw new Error('The typesafe.ai key cannot be saved in this host.');
    const k = typeof key === 'string' ? key.trim() : '';
    if (k.length < 8 || k.length > 512 || /\s/.test(k)) return { ok: false, error: 'That does not look like a typesafe.ai key.' };
    context.saveTypesafeKey(k);
    return embedderView();
  });

  handle(IPC.HISTORY_JEV_CLEAR_KEY, async () => {
    if (typeof context.clearTypesafeKey !== 'function') throw new Error('The typesafe.ai key cannot be removed in this host.');
    context.clearTypesafeKey();
    return embedderView();
  });
}

module.exports = { registerHistoryHandlers };

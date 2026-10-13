// src/ipc/history-handlers.js
// The recall line's excerpt drawer and an owner-side search (history spec
// 2026-09-25 §7, §12), and the embedder's state, choice, rebuild and retry
// (§5.2, §14). Excerpt text is untrusted: the renderer sets it with
// textContent only. Stage H4 adds the scope and link channels and the import
// channels (a file's name, title and sample are untrusted text too).
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { mergeHistorySettings } = require('../history/settings');
const { searchHistoryExcerpts, excerptsForMessage } = require('../history/search');
const { SCOPES, CLOSED_POLICY, resolveScope } = require('../history/scope');
const { chatHeaderTitle } = require('../history/excerpts');
const { previewImport, importChat, createImportGate, HASH_PATTERN } = require('../history/import-chats');
const { createImportPicks, importRequest, sourceBaseName, readingPickedFile, NO_FILE } = require('./import-picks');

const view = (e) => ({ seq: e.seq, header: e.header, text: e.text });

const MAX_LINKS = 200;
// What the owner is told when a chat's scope cannot be widened, by the
// policy's reason. The reason itself is a code, never shown.
const PIN_SENTENCES = Object.freeze({
  'case-chat': 'A case chat recalls only from itself.',
  'bridge-chat': 'A Telegram or Discord chat recalls only from itself.',
  'imported-case-chat': 'A chat imported from a case recalls only from itself.'
});
const PIN_SENTENCE = 'This chat recalls only from itself.';
const pinSentence = (reason) => (Object.hasOwn(PIN_SENTENCES, reason) ? PIN_SENTENCES[reason] : PIN_SENTENCE);
const REFUSED = 'refused';

function registerHistoryHandlers(ipcMain, context = {}) {
  const store = () => {
    const s = typeof context.getHistoryStore === 'function' ? context.getHistoryStore() : null;
    if (!s) throw new Error('Chat history is not available in this host.');
    return s;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (event, payload) => (
    fn(payload && typeof payload === 'object' ? payload : {}, event)
  )));

  // Stage H4 (spec §6.3). The scope of a chat is resolved on every call
  // from what the store holds now. A host that gives no policy or resolver
  // gets the closed one: every chat reads itself only.
  const scopePolicy = () => {
    const p = typeof context.getHistoryScopePolicy === 'function' ? context.getHistoryScopePolicy() : null;
    return p && typeof p.pinnedTo === 'function' && typeof p.canRead === 'function' ? p : CLOSED_POLICY;
  };
  const scopeOf = (chatId, requested = null) => {
    const r = typeof context.resolveHistoryScope === 'function'
      ? context.resolveHistoryScope(chatId, requested)
      : resolveScope({ store: store(), chatId, requested, policy: CLOSED_POLICY });
    // Anything but a list starting with this chat is this chat alone (the
    // rule the builder and the tools apply).
    if (!r || !Array.isArray(r.chatIds) || r.chatIds[0] !== chatId || !SCOPES.includes(r.effective)) {
      return { stored: 'chat', effective: 'chat', chatIds: [chatId], titles: new Map(), pinned: { scope: 'chat', reason: REFUSED } };
    }
    return r;
  };
  // Only an exact true allows (scope.js).
  const linkVerdict = (reader, source) => {
    const answer = scopePolicy().canRead(reader, source, { explicit: true });
    if (answer === true) return true;
    return typeof answer === 'string' && answer ? answer : REFUSED;
  };
  const NOT_FOUND = Object.freeze({ ok: false, error: 'Chat not found.' });
  const readerOf = (chatId) => (typeof chatId === 'string' && chatId ? store().chatRef(chatId) : null);
  // The reply of all three channels. Titles are untrusted text.
  const linksView = (reader) => {
    const s = store();
    const scope = scopeOf(reader.id);
    const linked = new Set(s.getLinks(reader.id));
    const candidates = s.chatRefs().filter((ref) => ref.id !== reader.id).map((ref) => {
      const verdict = linkVerdict(reader, ref);
      return { id: ref.id, title: ref.title, linked: linked.has(ref.id), allowed: verdict === true, reason: verdict === true ? null : verdict };
    });
    return {
      ok: true,
      untrustedText: true,
      scope: s.getHistoryScope(reader.id),
      effectiveScope: scope.effective,
      pinned: scope.pinned ? scope.pinned.reason : null,
      links: candidates.filter((c) => c.linked).map((c) => ({ id: c.id, title: c.title })),
      candidates
    };
  };
  // The renderer reloads its chat list itself (chat-handlers.js does the
  // same after a title change); attached, the sender is the bridge's.
  const chatUpdated = (event, chatId) => {
    const sender = event && event.sender;
    if (sender && typeof sender.send === 'function' && !(typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
      sender.send('chat:updated', { chatId });
    }
  };

  handle(IPC.HISTORY_LINKS_GET, async ({ chatId }) => {
    const reader = readerOf(chatId);
    return reader ? linksView(reader) : { ...NOT_FOUND };
  });

  handle(IPC.HISTORY_SCOPE_SET, async ({ chatId, scope }, event) => {
    if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
      return { ok: false, error: `A history scope is one of ${SCOPES.join(', ')}.` };
    }
    const reader = readerOf(chatId);
    if (!reader) return { ...NOT_FOUND };
    const { pinned } = scopeOf(reader.id);
    if (pinned && SCOPES.indexOf(scope) > SCOPES.indexOf(pinned.scope)) {
      return { ok: false, error: pinSentence(pinned.reason), code: 'SCOPE_PINNED', reason: pinned.reason };
    }
    if (!store().setHistoryScope(reader.id, scope)) return { ok: false, error: 'The history scope could not be saved.' };
    chatUpdated(event, reader.id);
    return linksView(reader);
  });

  handle(IPC.HISTORY_LINKS_SET, async ({ chatId, linkedChatIds }, event) => {
    if (!Array.isArray(linkedChatIds) || linkedChatIds.length > MAX_LINKS || !linkedChatIds.every((id) => typeof id === 'string' && id)) {
      return { ok: false, error: `linkedChatIds must be a list of at most ${MAX_LINKS} chat ids.` };
    }
    const reader = readerOf(chatId);
    if (!reader) return { ...NOT_FOUND };
    const s = store();
    // A chat that no longer exists is dropped by the store; one the policy
    // refuses fails the whole call, so nothing the owner did not see is saved.
    const refused = [];
    for (const id of new Set(linkedChatIds)) {
      const source = id === reader.id ? null : s.chatRef(id);
      if (!source) continue;
      const verdict = linkVerdict(reader, source);
      if (verdict !== true) refused.push({ id: source.id, reason: verdict });
    }
    if (refused.length) return { ok: false, error: 'That chat cannot be linked.', code: 'LINK_REFUSED', refused };
    s.setLinks(reader.id, linkedChatIds);
    chatUpdated(event, reader.id);
    return linksView(reader);
  });

  // Stage H4: importing a conversation (spec §10.2, §12; owner ruling
  // R-H4-3). The file is chosen in a dialog the main process opens and is
  // named to the renderer by a token: pick, preview and commit read `token`
  // and `pattern` from the payload and nothing else, so no channel opens a
  // path the renderer sent. lookup, begin, append and finish take a chat that
  // is already parsed (the attached desktop parses the file and the service
  // stores it): no path at all, fixed key lists and caps (import-chats.js).
  // One import at a time per core.
  const picks = createImportPicks({
    pickFile: async () => (typeof context.pickImportFile === 'function' ? context.pickImportFile() : null)
  });
  let ownGate = null;
  const importGate = () => {
    const given = typeof context.getHistoryImportGate === 'function' ? context.getHistoryImportGate() : null;
    if (given) return given;
    if (!ownGate) ownGate = createImportGate({ getStore: store });
    return ownGate;
  };
  const invalid = (message) => Object.assign(new Error(message), { code: 'IMPORT_INVALID' });
  // A file imported before, when its chat is still there.
  const importedAs = (sourceHash) => {
    const row = store().findImport(sourceHash);
    return row && row.state === 'done' && store().chatRef(row.chatId) ? row.chatId : null;
  };

  handle(IPC.HISTORY_IMPORT_PICK, async () => picks.pick());

  handle(IPC.HISTORY_IMPORT_PREVIEW, async (payload) => {
    const { token, pattern } = importRequest(payload);
    const filePath = picks.pathFor(token);
    if (!filePath) return { ...NO_FILE };
    const read = await readingPickedFile(() => previewImport(filePath, { pattern }));
    if (read.ok === false) return read;
    const { sourceHash, importerVersion: _version, ...preview } = read;
    return { ok: true, untrustedText: true, ...preview, existingChatId: importedAs(sourceHash) };
  });

  handle(IPC.HISTORY_IMPORT_COMMIT, async (payload, event) => {
    const { token, pattern } = importRequest(payload);
    const filePath = picks.pathFor(token);
    if (!filePath) return { ...NO_FILE };
    const out = await readingPickedFile(() => importGate().run(() => importChat({ store: store(), filePath, pattern })));
    if (out.ok === false) return out;
    picks.spend(token);
    chatUpdated(event, out.chatId);
    return { ok: true, chatId: out.chatId, imported: out.imported, messages: out.messages, kind: out.kind };
  });

  handle(IPC.HISTORY_IMPORT_LOOKUP, async ({ sourceHash }) => {
    if (typeof sourceHash !== 'string' || !HASH_PATTERN.test(sourceHash)) throw invalid('An import is looked up by the SHA-256 of its file.');
    return { ok: true, existingChatId: importedAs(sourceHash) };
  });

  handle(IPC.HISTORY_IMPORT_BEGIN, async ({ kind, importerVersion, sourceHash, sourceName, chat, total }) => {
    const begun = importGate().begin({
      kind, importerVersion, sourceHash, sourcePath: sourceBaseName(sourceName), chat, total
    });
    return begun.existingChatId
      ? { ok: true, existingChatId: begun.existingChatId }
      : { ok: true, importId: begun.importId, chatId: begun.chatId };
  });

  handle(IPC.HISTORY_IMPORT_APPEND, async ({ importId, messages }) => {
    const { done } = importGate().append({ importId, messages });
    return { ok: true, done };
  });

  handle(IPC.HISTORY_IMPORT_FINISH, async ({ importId }, event) => {
    const out = importGate().finish({ importId });
    chatUpdated(event, out.chatId);
    return { ok: true, chatId: out.chatId, messages: out.messages };
  });

  handle(IPC.HISTORY_EXCERPTS, async ({ chatId, seq }) => {
    if (typeof chatId !== 'string' || !chatId || !Number.isInteger(seq) || seq < 1) {
      return { ok: false, error: 'chatId and a message number are required.' };
    }
    // What the reply was given, but another chat's excerpt only while this
    // chat may still read that chat (the scope as it is now: the policy,
    // the links and the stored scope). One that has left the scope (it got
    // a case, it was unlinked) comes back as { hidden: true }, with no
    // text, header or chat id. Built the cautious way (stage H4 review,
    // finding 4); the owner may rule that a reply's own record still shows.
    const readable = new Set(scopeOf(chatId).chatIds);
    const excerpts = excerptsForMessage({ store: store(), chatId, seq })
      .map((e) => (e.chatId === chatId || readable.has(e.chatId) ? view(e) : { hidden: true }));
    return { ok: true, untrustedText: true, excerpts };
  });

  handle(IPC.HISTORY_SEARCH, async ({ chatId, query, limit }) => {
    if (typeof chatId !== 'string' || !chatId || typeof query !== 'string' || !query.trim()) {
      return { ok: false, error: 'chatId and a query are required.' };
    }
    const retriever = typeof context.getHistoryRetriever === 'function' ? context.getHistoryRetriever() : null;
    if (!retriever) throw new Error('History search is not available in this host.');
    const settings = mergeHistorySettings(((typeof context.getSettings === 'function' && context.getSettings()) || {}).history);
    // The owner's own search reads what the chat's turn may read (stage H4).
    const scope = scopeOf(chatId);
    const excerpts = await searchHistoryExcerpts({
      store: store(),
      retriever,
      chatId,
      chatIds: scope.chatIds,
      chatTitles: scope.titles,
      query,
      limit: Math.min(50, Math.max(1, Math.floor(Number(limit) || 10))),
      settings: settings.recall
    });
    return {
      ok: true,
      untrustedText: true,
      excerpts: excerpts.map((e) => ({
        ...view(e),
        ...(e.chatId && e.chatId !== chatId ? { chatId: e.chatId, chatTitle: chatHeaderTitle(scope.titles.get(e.chatId), e.chatId) } : {})
      }))
    };
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

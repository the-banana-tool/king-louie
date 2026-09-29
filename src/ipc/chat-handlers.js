const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const ImageHandler = require('../media/image-handler');
const Advisor = require('../execution/advisor');
const { createLogger } = require('../logging');
const { buildCaseSystemPrompt, shapeToolDefinitions, casePrompter } = require('../cases/chat-integration');
const { NO_RETRY } = require('../cases/roles');
const { roleTimeoutMs } = require('../models/resolver');
const { KL_PROVIDERS } = require('../models/provider-ids');
const { partialMetricsOf } = require('../providers/abort');
const { summarizeTurnLlm } = require('../tracking/llm-totals');
const UsageTracker = require('../tracking/usage-tracker');
const { oneShot } = require('../providers/one-shot');
const { targetLabel } = require('../models/roles');
const { DELEGATION_GUIDANCE } = require('../context/system-sections');
const { workerIsCheaper } = require('../models/delegation');
const { getActiveCatalog } = require('../models');

const log = createLogger('chat');
const advisorLog = createLogger('advisor');
const voiceLog = createLogger('voice');

function messageTimestamp(message = {}) {
  return message.timestamp || message.createdAt || message.updatedAt || null;
}

function visibleMessage(message = {}) {
  return message.sender === 'user' || message.sender === 'assistant';
}

function chatMetadata(chat = {}, { includeMessages = false } = {}) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const visibleMessages = messages.filter(visibleMessage);
  const lastMessage = visibleMessages[visibleMessages.length - 1] || messages[messages.length - 1] || null;
  const lastMessageAt = lastMessage ? messageTimestamp(lastMessage) : null;
  const metadata = {
    ...chat,
    messageCount: messages.length,
    userMessageCount: messages.filter((message) => message.sender === 'user').length,
    assistantMessageCount: messages.filter((message) => message.sender === 'assistant').length,
    preview: lastMessage?.text || '',
    lastMessageText: lastMessage?.text || '',
    lastMessageAt
  };

  if (!includeMessages) {
    delete metadata.messages;
  }

  return metadata;
}

// Before a send (spec 2026-09-27 §5.2): a never-tested provider is tested
// now and a stale non-auth failure retested once (Availability#refreshForUse;
// a host double with only ensureTested gets that).
async function refreshProvider(availability, provider) {
  if (typeof availability.refreshForUse === 'function') return availability.refreshForUse(provider);
  if (typeof availability.ensureTested === 'function') return availability.ensureTested(provider);
  return null;
}

function registerChatHandlers(ipcMain, context = {}) {
  const {
    createId,
    getChats,
    listChats,
    getChat,
    createChat,
    deleteChat,
    setChats,
    getActiveChatId,
    setActiveChatId,
    appendMessageToChat,
    getLastAssistantMessage,
    getVoiceSettings,
    runHookEvent,
    snapshotModels,
    routedProvider: createRoutedProvider,
    getRuntimeEnvironment,
    createToolExecutorWithApprovals,
    AgentLoop,
    toolRegistry,
    withNotificationTiming,
    buildRuntimeSystemPrompt,
    buildMemoryContextSection,
    speakSummaryText,
    getUsageTracker,
    createUsageRecordFromMetrics,
    getContextAssembler,
    getConversationCompactor,
    getToolResultsDir,
    prompter
  } = context;

  // chatId -> Set<AbortController>. More than one send can be in flight for
  // the same chat at once (a second send while the first is still running,
  // or one whose own setup fails); each keeps its own entry in the chat's
  // set, added right after beginTurn and removed only by its own `finally`
  // (targeted fix, after final review I2's fix wave). Stop aborts every
  // controller in the set and clears the whole entry.
  const activeRuns = new Map();

  const fullChats = () => getChats();

  const setFullChats = (chats) => setChats(chats);

  const findChat = (chatId, options = { messages: true }) => {
    const id = String(chatId || '').trim();
    if (!id) return null;
    if (typeof context.getChat === 'function') {
      const chat = context.getChat(id, options);
      if (chat && typeof chat === 'object') return chat;
    }
    return fullChats().find((item) => item.id === id) || null;
  };

  const patchChat = (chatId, patch = {}) => {
    const id = String(chatId || '').trim();
    if (!id) return null;
    if (typeof context.updateChat === 'function') {
      const updated = context.updateChat(id, patch);
      if (updated && typeof updated === 'object') return updated;
    }
    const updatedChats = fullChats().map((chat) => (chat.id === id ? { ...chat, ...(patch || {}) } : chat));
    setFullChats(updatedChats);
    return updatedChats.find((chat) => chat.id === id) || null;
  };

  const replaceChats = (chats) => {
    setFullChats(chats);
    return chats;
  };

  const prependChat = (chat) => {
    if (typeof context.createChat === 'function') {
      const created = context.createChat(chat, { position: 'front' });
      if (created && typeof created === 'object') return created;
    }
    replaceChats([chat, ...fullChats()]);
    return chat;
  };

  const removeChat = (chatId) => {
    if (typeof context.deleteChat === 'function') {
      const chats = context.deleteChat(chatId);
      if (Array.isArray(chats)) return chats;
    }
    return replaceChats(fullChats().filter((chat) => chat.id !== chatId));
  };

  /**
   * Title a new chat on the turn's utility role (spec 2026-09-27 §8): a
   * small job on a cheap model, its usage recorded like any other call. An
   * empty utility borrows from worker, then main; nothing usable means no
   * title, never a call on a model outside the role.
   */
  async function autoNameChat({ chatId, userMessage, assistantResponse, sender, turnModels }) {
    try {
      const availability = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
      if (availability) {
        const providers = [...new Set(turnModels.candidatesFor('utility').map((x) => x.provider))].filter((p) => KL_PROVIDERS.includes(p));
        await Promise.all(providers.map((p) => refreshProvider(availability, p)));
      }
      const utility = turnModels.resolve('utility');
      if (!utility.targets.length) {
        const why = utility.skipped.map((s) => `${targetLabel(s.target)} (${s.reasons.join(' ')})`).join('; ');
        log.info(`No usable utility model for a chat title${why ? `: ${why}` : ''}.`);
        return;
      }
      const provider = createRoutedProvider({
        targets: utility.targets,
        meta: { role: 'utility', profileId: turnModels.profileId || null, borrowedFrom: utility.borrowedFrom || null }
      });

      const titlePrompt = [
        {
          sender: 'user',
          text: `Generate a short, descriptive title (max 6 words) for a chat that starts with this exchange. Reply with ONLY the title text, no quotes or punctuation at the end.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantResponse.slice(0, 300)}`
        }
      ];

      const settings = typeof context.getSettings === 'function' ? context.getSettings() : {};
      const { text, llmMetrics } = await oneShot(provider, titlePrompt, { temperature: 0.3, max_tokens: 30, timeoutMs: roleTimeoutMs(settings, 'utility') });

      const tracker = typeof getUsageTracker === 'function' ? getUsageTracker() : null;
      if (tracker && llmMetrics && typeof tracker.record === 'function') tracker.record(UsageTracker.eventFromMetrics(llmMetrics));

      const cleaned = String(text || '').replace(/^["']|["'.!]$/g, '').trim();
      if (!cleaned) return;

      patchChat(chatId, { title: cleaned, updatedAt: new Date().toISOString() });
      const updated = fullChats();

      // Notify the renderer so the sidebar updates
      if (sender && !sender.isDestroyed()) {
        sender.send('chat:updated', { chats: updated });
      }
    } catch (err) {
      log.warn(`Failed to generate chat title: ${err.message}`);
    }
  }

  /** Safely send an IPC event — no-op if the sender (renderer) has been destroyed. */
  function safeSend(sender, channel, data) {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, data);
    }
  }

  const getMainWindow = () => (
    typeof context.getMainWindow === 'function' ? context.getMainWindow() : context.mainWindow
  );
  const getTtsEngine = () => (
    typeof context.getTtsEngine === 'function' ? context.getTtsEngine() : context.ttsEngine
  );

  ipcMain.handle(IPC.APP_QUIT_WINDOW, wrapHandler(IPC.APP_QUIT_WINDOW, async () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    return { ok: true };
  }));

  ipcMain.handle(IPC.CHAT_LOAD, wrapHandler(IPC.CHAT_LOAD, async () => {
    const activeChatId = getActiveChatId();
    const facadeChats = typeof listChats === 'function' ? listChats({ messages: false }) : null;
    const loadedChats = Array.isArray(facadeChats)
      ? facadeChats
      : getChats();
    const facadeActiveChat = activeChatId && typeof getChat === 'function' ? getChat(activeChatId, { messages: true }) : null;
    const activeChat = facadeActiveChat && typeof facadeActiveChat === 'object'
      ? facadeActiveChat
      : getChats().find((chat) => chat.id === activeChatId) || null;

    return {
      chats: loadedChats.map((chat) => (
        chat.id === activeChatId && activeChat
          ? chatMetadata(activeChat, { includeMessages: true })
          : chatMetadata(chat, { includeMessages: false })
      )),
      activeChatId
    };
  }));

  ipcMain.handle(IPC.CHAT_GET, wrapHandler(IPC.CHAT_GET, async (_event, { chatId } = {}) => {
    const id = String(chatId || '').trim();
    if (!id) {
      return { ok: false, error: 'Chat ID is required.' };
    }

    const facadeChat = typeof getChat === 'function' ? getChat(id, { messages: true }) : null;
    const chat = facadeChat && typeof facadeChat === 'object'
      ? facadeChat
      : getChats().find((item) => item.id === id) || null;
    if (!chat) {
      return { ok: false, error: 'Chat not found.' };
    }

    return { ok: true, chat };
  }));

  ipcMain.handle(IPC.CHAT_CREATE, wrapHandler(IPC.CHAT_CREATE, async (_event, title = 'New Chat') => {
    const now = new Date().toISOString();
    const settings = typeof context.getSettings === 'function' ? context.getSettings() : {};
    const defaults = settings.defaults || {};
    const newChat = {
      id: createId(),
      title,
      createdAt: now,
      updatedAt: now,
      agentMode: !!defaults.agentMode,
      sandboxMode: defaults.sandboxMode !== false,
      messages: [
        {
          id: createId(),
          sender: 'assistant',
          text: 'How can I help you?',
          timestamp: now
        }
      ]
    };
    prependChat(newChat);
    setActiveChatId(newChat.id);
    return newChat;
  }));

  ipcMain.handle(IPC.CHAT_SET_ACTIVE, wrapHandler(IPC.CHAT_SET_ACTIVE, async (_event, chatId) => {
    setActiveChatId(chatId);
    return { activeChatId: chatId };
  }));

  ipcMain.handle(IPC.CHAT_RENAME, wrapHandler(IPC.CHAT_RENAME, async (_event, { chatId, name }) => {
    return patchChat(chatId, { title: name, updatedAt: new Date().toISOString() });
  }));

  ipcMain.handle(IPC.CHAT_DELETE, wrapHandler(IPC.CHAT_DELETE, async (_event, chatId) => {
    const chats = removeChat(chatId);
    const activeChatId = getActiveChatId();
    if (activeChatId === chatId) {
      const nextChatId = chats[0]?.id || null;
      setActiveChatId(nextChatId);
    }
    return { chats, activeChatId: getActiveChatId() };
  }));

  ipcMain.handle(IPC.CHAT_SET_AGENT_MODE, wrapHandler(IPC.CHAT_SET_AGENT_MODE, async (_event, { chatId, agentMode }) => {
    return patchChat(chatId, { agentMode: !!agentMode, updatedAt: new Date().toISOString() });
  }));

  ipcMain.handle(IPC.CHAT_SET_SANDBOX_MODE, wrapHandler(IPC.CHAT_SET_SANDBOX_MODE, async (_event, { chatId, sandboxMode }) => {
    return patchChat(chatId, { sandboxMode: !!sandboxMode, updatedAt: new Date().toISOString() });
  }));

  ipcMain.handle(IPC.CHAT_SET_DISABLED_MCP, wrapHandler(IPC.CHAT_SET_DISABLED_MCP, async (_event, { chatId, disabledMcpServers } = {}) => {
    const list = Array.isArray(disabledMcpServers)
      ? disabledMcpServers.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
      : [];
    return patchChat(chatId, { disabledMcpServers: list, updatedAt: new Date().toISOString() });
  }));

  ipcMain.handle(IPC.CHAT_SET_WORKING_DIR, wrapHandler(IPC.CHAT_SET_WORKING_DIR, async (_event, { chatId, workingDirectory }) => {
    return patchChat(chatId, { workingDirectory: workingDirectory || null, updatedAt: new Date().toISOString() });
  }));

  ipcMain.handle(IPC.CHAT_PICK_WORKING_DIR, wrapHandler(IPC.CHAT_PICK_WORKING_DIR, async (_event, { chatId }) => {
    const { dialog } = require('electron');
    const getMainWindow = context.getMainWindow;
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Working Directory'
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const dir = result.filePaths[0];
    return { canceled: false, chat: patchChat(chatId, { workingDirectory: dir, updatedAt: new Date().toISOString() }) };
  }));

  ipcMain.handle(IPC.CHAT_ADD_MESSAGE, wrapHandler(IPC.CHAT_ADD_MESSAGE, async (_event, payload = {}) => {
    const { chatId, sender, text, ...metadata } = payload;
    return appendMessageToChat(chatId, sender, text, metadata);
  }));

  ipcMain.handle(IPC.CHAT_SPEAK_LAST, wrapHandler(IPC.CHAT_SPEAK_LAST, async (_event, { chatId, summary = false } = {}) => {
    const chat = findChat(chatId, { messages: true });
    if (!chat) {
      return { ok: false, error: 'Chat not found.' };
    }

    const lastAssistant = getLastAssistantMessage(chatId);
    if (!lastAssistant?.text) {
      return { ok: false, error: 'No assistant message found to speak.' };
    }

    const ttsEngine = getTtsEngine();
    if (!ttsEngine) {
      return { ok: false, error: 'TTS engine is not initialized.' };
    }

    const voiceSettings = getVoiceSettings();
    if (!voiceSettings.enabled) {
      return { ok: false, error: 'Voice output is disabled. Enable it in settings first.' };
    }

    const result = summary
      ? await ttsEngine.speakSummary(lastAssistant.text, voiceSettings)
      : await ttsEngine.speak(lastAssistant.text, voiceSettings);
    return { ok: true, result };
  }));

  const getSettings = context.getSettings;

  ipcMain.handle(IPC.CHAT_SEND_MESSAGE, wrapHandler(IPC.CHAT_SEND_MESSAGE, async (event, { chatId, message, images = [], documents = [], agentMode = false, sandboxMode = true }) => {
    let safeMessage = String(message || '');
    // The owner's words as sent, before any hook rewrites them: a browser
    // action that changes something may quote them instead of prompting.
    const ownerTurnText = safeMessage;
    const normalizedImages = ImageHandler.normalizeMessageImages(images);
    const normalizedDocuments = ImageHandler.normalizeMessageDocuments(documents);

    if (!safeMessage.trim() && normalizedImages.length === 0 && normalizedDocuments.length === 0) {
      throw new Error('Message text or at least one attachment is required.');
    }

    // Resolve working directory: per-chat > process.cwd()
    const chatForDir = findChat(chatId, { messages: true });
    const chatWorkingDirectory = chatForDir?.workingDirectory || process.cwd();
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    const allowedDirectories = Array.isArray(settings.allowedDirectories) ? settings.allowedDirectories : [];

    const responseId = createId();
    const runId = createId();

    // Case mode (spec §5): begin before the prompt hook fires or the user
    // message is persisted. A busy or missing case must run nothing — no
    // orphan user message, no hook/inference/provider call — so beginTurn is
    // the very first thing this handler awaits. There is no enclosing try
    // yet, so a thrown CaseBusyError or CaseNotFoundError propagates straight
    // out of this handler to wrapHandler, which turns it into
    // { ok: false, error }.
    const caseId = chatForDir?.caseId || null;
    const caseRuntime = caseId && typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    let caseTurn = caseRuntime
      ? await caseRuntime.beginTurn(caseId, { turnId: `turn-${runId}`, source: 'owner', ownerMessage: safeMessage, chatId })
      : null;
    const endCaseTurn = async (fields) => {
      if (!caseTurn) return;
      const turn = caseTurn;
      caseTurn = null;
      await caseRuntime.endTurn(turn, fields).catch((err) => log.warn(`Case turn commit failed: ${err.message}`));
    };

    // From here on, beginTurn has already locked the case and committed any
    // owner edits, so every exit — a hook block, a validation failure, a
    // thrown error, or an abort — must end the turn exactly once. endCaseTurn
    // is idempotent (it nulls caseTurn before awaiting endTurn), so wrapping
    // the rest of the handler in one try/catch is enough: nothing before a
    // `return` or a `throw` below needs its own endCaseTurn call.
    let fullResponse = '';
    let answerText = '';
    let turnModels = null;
    let main = null;
    // This turn's own model calls, and each sub-agent run's (spec §10): the
    // reply's llm record is built from both, stopped or not.
    let ownCalls = [];
    const subagentRuns = [];
    const summarize = () => summarizeTurnLlm({ calls: ownCalls, subagents: subagentRuns });
    let llmSummary = summarize();
    const abortController = new AbortController();
    // Registered right after beginTurn, before the prompt hook and the
    // usability gate: Stop was invisible to activeRuns for the whole gate
    // (a connection test can run 20s or more), so a Stop pressed there was
    // silently lost — the run kept going, billed, and streamed in full
    // (final review I2). Checked again after the gate and after conversation
    // compaction, below. Added to this chat's own Set, not written over any
    // other run's entry — the hook below can still deny the turn, and any
    // exit here must remove only this run's own controller (the `finally`
    // after the try/catch), never another run's (targeted fix).
    let runSet = activeRuns.get(chatId);
    if (!runSet) {
      runSet = new Set();
      activeRuns.set(chatId, runSet);
    }
    runSet.add(abortController);
    let stopped = false;
    let stopFinished = false;
    // A stopped run ends here, once: the streamed text as an assistant
    // message marked stopped, and nothing from the run after it (spec
    // 2026-09-27 §9). No advisor review, voice or title call follows.
    const finishStopped = async () => {
      if (stopFinished) return null;
      stopFinished = true;
      await endCaseTurn({ summary: `turn stopped by owner: ${safeMessage}`, journal: null });
      const stoppedChat = appendMessageToChat(chatId, 'assistant', fullResponse, { llm: llmSummary, stopped: true });
      safeSend(event.sender, 'chat:messageComplete', { chatId, responseId, message: fullResponse, llm: llmSummary, stopped: true });
      return stoppedChat;
    };

    // In a case chat, Stop also aborts the case turn itself, so its tools and
    // anything reading the turn's own signal stop too.
    if (caseTurn && typeof caseTurn.abort === 'function') {
      const turnToAbort = caseTurn;
      abortController.signal.addEventListener('abort', () => turnToAbort.abort('stopped by owner'), { once: true });
    }

    try {
      const hookResult = await runHookEvent('UserPromptSubmit', {
        source: 'ui',
        chatId,
        prompt: safeMessage,
        timestamp: new Date().toISOString(),
        workingDirectory: chatWorkingDirectory
      });
      const hookAction = String(hookResult?.action || 'allow').toLowerCase();
      if (hookAction === 'deny') {
        const reason = hookResult?.message || hookResult?.reason || 'Blocked by hook policy.';
        await endCaseTurn({ summary: `turn blocked: ${reason}`, journal: null });
        return { ok: false, error: reason };
      }

      // Owner-message hooks (C5's classification) run only once the prompt
      // hook has let the message through, and before the model sees it.
      if (caseTurn) await caseRuntime.runOwnerMessageHooks(caseTurn);

      const userMessage = appendMessageToChat(chatId, 'user', safeMessage, {
        ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
        ...(normalizedDocuments.length > 0 ? { documents: normalizedDocuments } : {})
      });
      if (!userMessage) {
        throw new Error('Chat not found');
      }

      // The turn's models, frozen now (spec 2026-09-27 §6.6): the profile
      // and main override as they stand at launch serve every model call of
      // this turn; a switch or a settings change applies to the next turn. A
      // case turn froze its own at beginTurn, from case.yaml's choice.
      turnModels = (caseTurn && caseTurn.models) || snapshotModels({ chatId, caseId });

      // Any usable model may answer (spec §5.5, §6.4): its provider's test
      // passed, it is in the account's list, and it can call tools (agent
      // mode, case turns) or read images when the owner attached some.
      const needs = {
        ...(agentMode || caseTurn ? { toolCall: true } : {}),
        ...(normalizedImages.length > 0 ? { imageInput: true } : {})
      };
      const availability = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
      if (availability) {
        const providers = [...new Set(turnModels.candidatesFor('main').map((x) => x.provider))].filter((p) => KL_PROVIDERS.includes(p));
        await Promise.all(providers.map((p) => refreshProvider(availability, p)));
      }
      // No usable main fails the turn before any call, listing every skipped
      // target with its reason; an unusable override fails with the reason
      // and a one-click "use the profile's main" (spec §15). Never a silent
      // switch to another model.
      main = turnModels.mustResolve('main', { needs });
      const mainTarget = main.targets[0];

      // The gate above can run a connection test (20s or more): a Stop
      // pressed during it must end the run here, with no model call, rather
      // than let the send continue once the test finally settles (final
      // review I2).
      if (abortController.signal.aborted) return finishStopped();

      // Every call of this turn walks main's resolved list (spec §6.7): any
      // provider on the first call, the same provider after it. A case
      // turn's calls go through the case runtime, which charges the case.
      const provider = caseTurn
        ? caseRuntime.routedProvider(caseTurn, { targets: main.targets, meta: { role: 'main', borrowedFrom: null } })
        : createRoutedProvider({
          targets: main.targets,
          signal: abortController.signal,
          meta: { role: 'main', profileId: turnModels.profileId || null, borrowedFrom: null }
        });

      const chatRaw = findChat(chatId, { messages: true });
      if (!chatRaw) {
        throw new Error('Chat not found');
      }
      // Filter out persisted tool events — only user/assistant messages go to the LLM.
      // A stopped reply with no text stays out: an empty assistant turn is
      // rejected by some providers.
      const allContentMessages = chatRaw.messages.filter((m) => (m.sender === 'user' || m.sender === 'assistant')
        && !(m.stopped && !String(m.text || '').trim()));

      // Semantic conversation compaction: for large conversations, chunk every
      // message into paragraphs, embed them, then retrieve only the chunks
      // relevant to the current query.  One cheap embedding call (~$0.002),
      // then pure local cosine similarity — no LLM call for the retrieval.
      const compactor = typeof getConversationCompactor === 'function' ? getConversationCompactor() : null;
      let chatMessages = allContentMessages;
      if (compactor && compactor.shouldCompact(allContentMessages)) {
        try {
          chatMessages = await compactor.retrieve(safeMessage, allContentMessages, {
            maxChunks: 20,
            alwaysKeepRecent: 4,
            minSimilarity: 0.25,
            maxTokens: 4000
          });
          const origTokens = Math.ceil(allContentMessages.reduce((s, m) => s + (m.text?.length || 0), 0) / 4);
          const compTokens = Math.ceil(chatMessages.reduce((s, m) => s + (m.text?.length || 0), 0) / 4);
          log.info(`Compacted ${allContentMessages.length} messages -> ${chatMessages.length} messages (~${origTokens} -> ~${compTokens} tokens, ${Math.round((1 - compTokens / origTokens) * 100)}% reduction)`);
        } catch (err) {
          log.warn(`Conversation compaction failed, using full history: ${err.message}`);
        }
      }

      // Compaction can also run long enough for a Stop to land while it was
      // in flight (final review I2).
      if (abortController.signal.aborted) return finishStopped();

      const chat = { ...chatRaw, messages: chatMessages };

      // The case tools accept provenance "user" only when the model's quote
      // matches something the owner actually said in this chat (Task 8 fix
      // round). Collect every user-sender message's text from the chat,
      // plus the message being sent this turn if it isn't already there —
      // it was persisted above, and may not be in chatRaw's copy yet.
      // ownerMessageTimes runs in step with ownerMessages; this turn's
      // message is stamped now (stage 2: a direction quote must be newer
      // than the failure report).
      let ownerMessageTimes = null;
      const ownerMessages = caseTurn
        ? (() => {
            // A message a Telegram/Discord bridge appended on a remote
            // sender's behalf is stamped sender: 'user' too, but it is not
            // the owner talking in this chat — a channel tag (F5) excludes
            // it from the quote-verified owner-message pool.
            const owned = chatRaw.messages.filter((m) => m.sender === 'user' && !m.channel && typeof m.text === 'string' && m.text);
            const messages = owned.map((m) => m.text);
            ownerMessageTimes = owned.map((m) => m.timestamp || null);
            const nowIso = new Date().toISOString();
            if (!messages.includes(safeMessage)) {
              messages.push(safeMessage);
              ownerMessageTimes.push(nowIso);
            } else {
              ownerMessageTimes[messages.lastIndexOf(safeMessage)] = nowIso;
            }
            return messages;
          })()
        : null;

      const options = {
        model: mainTarget.model,
        timeoutMs: roleTimeoutMs(settings, 'main'),
        runId
      };

      safeSend(event.sender, 'chat:messageStart', { chatId, responseId });

      const runtimeEnvironment = await getRuntimeEnvironment({
        workingDirectory: chatWorkingDirectory
      });

      options.runtimeEnvironment = runtimeEnvironment;

      // Dynamic context assembly: use ContextAssembler if available,
      // otherwise fall back to the original monolithic approach.
      const contextAssembler = typeof getContextAssembler === 'function' ? getContextAssembler() : null;
      const memoryContext = await buildMemoryContextSection(safeMessage, { limit: 4 });

      // Per-chat MCP server filter: drop tools from disabled servers.
      const disabledMcpServers = Array.isArray(chatForDir?.disabledMcpServers)
        ? chatForDir.disabledMcpServers
        : [];
      const isMcpToolDisabled = (toolName) => {
        if (!toolName || !toolName.startsWith('mcp__')) return false;
        const server = toolName.slice('mcp__'.length).split('__')[0];
        return disabledMcpServers.includes(server);
      };
      const filterMcpTools = (list) => list.filter((t) => !isMcpToolDisabled(t.name || t));

      let assembledTools = null;
      if (contextAssembler) {
        try {
          const assembled = await contextAssembler.assemble(safeMessage, {
            maxTools: 10,
            maxSections: 4,
            memoryContext
          });
          options.systemPrompt = assembled.systemPrompt;
          assembledTools = filterMcpTools(assembled.tools);

          // Tell the LLM which tools are available on-demand via RequestTools
          const availableNames = (assembled.availableToolNames || []).filter((n) => !isMcpToolDisabled(n));
          // RequestTools is blocked in case turns, so do not advertise it there.
          if (availableNames.length > 0 && !caseTurn) {
            options.systemPrompt += `\n\nAdditional tools available on request via the RequestTools tool: ${availableNames.join(', ')}`;
          }
        } catch (err) {
          log.warn(`Context assembly failed, falling back to full context: ${err.message}`);
        }
      }

      // Fallback: full system prompt + all tools
      if (!options.systemPrompt) {
        options.systemPrompt = [
          buildRuntimeSystemPrompt(runtimeEnvironment),
          memoryContext
        ].filter(Boolean).join('\n\n');
      }

      // Main's delegation guidance (spec §8.1), first so it sits in the
      // stable, cached part of the prompt. Only where SpawnAgent can run:
      // agent mode, and never a case turn (SpawnAgent is refused there). And
      // only when its promise holds (final review I1): worker has models of
      // its own and its first is cheaper than main's first. The check reads
      // only the frozen TurnModels and the catalog, so it is the same for
      // every turn of a profile and the cached prefix keeps.
      const catalog = (typeof context.getCatalog === 'function' && context.getCatalog()) || getActiveCatalog();
      if (agentMode && !caseTurn && workerIsCheaper(turnModels, catalog)) {
        options.systemPrompt = `${DELEGATION_GUIDANCE}\n\n${options.systemPrompt}`;
      }

      if (caseTurn) {
        options.systemPrompt = buildCaseSystemPrompt(caseTurn.orientation, options.systemPrompt);
      }

      const executor = await createToolExecutorWithApprovals(event, runtimeEnvironment, null, {
        workingDirectory: chatWorkingDirectory,
        allowedDirectories,
        useSandbox: sandboxMode,
        chatId,
        // SpawnAgent and BackgroundTask children of this turn resolve their
        // models from this turn's frozen TurnModels (spec §6.6).
        turnModels,
        // SpawnAgent children report their calls here (spec §10).
        onSubagentLlm: (run) => { subagentRuns.push(run); },
        ownerTurnText,
        caseContext: caseTurn ? caseRuntime.caseContext(caseTurn, { ownerMessages, ownerMessageTimes }) : null
      });

      executor.on('preExecute', ({ toolName, parameters }) => {
        if (abortController.signal.aborted) return;
        appendMessageToChat(chatId, 'toolUse', '', { toolName, parameters, runId });
        safeSend(event.sender, 'chat:toolUse', { chatId, runId, toolName, parameters });
      });

      executor.on('postExecute', ({ toolName, result }) => {
        if (abortController.signal.aborted) return;
        appendMessageToChat(chatId, 'toolResult', '', { toolName, result, runId });
        safeSend(event.sender, 'chat:toolResult', { chatId, runId, toolName, result });
      });

      executor.on('toolProgress', ({ toolName, progress }) => {
        if (abortController.signal.aborted) return;
        safeSend(event.sender, 'chat:toolProgress', { chatId, runId, toolName, progress });
      });

      const toolDefinitions = shapeToolDefinitions(
        filterMcpTools(assembledTools || toolRegistry.getFunctionDefinitions()),
        Boolean(caseTurn),
        toolRegistry
      );
      await withNotificationTiming('Chat response', async () => {
        // A case turn always runs the agent loop: the case tools are how it works.
        const canUseAgentMode = (agentMode || Boolean(caseTurn)) && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
        if (caseTurn && !canUseAgentMode) {
          const reason = typeof provider.sendMessageWithTools !== 'function'
            ? 'the provider has no sendMessageWithTools'
            : 'no tools were available to offer';
          log.warn(`Case tools could not be offered for case ${caseId}: ${reason}.`);
        }
        if (canUseAgentMode) {
          const embeddingProvider = contextAssembler?.embeddingProvider || null;
          const toolResultsDir = typeof getToolResultsDir === 'function' ? getToolResultsDir() : null;
          const loop = new AgentLoop(provider, executor, {
            maxIterations: 40,
            embeddingProvider,
            usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
            // The routed provider fails over itself (spec §6.7); the loop never retries.
            failoverPolicy: NO_RETRY,
            ...(caseTurn ? { onUsageRecorded: caseRuntime.usageHook(caseTurn) } : {}),
            abortSignal: abortController.signal,
            toolResultsDir,
            prompter: caseTurn ? casePrompter(prompter) : prompter,
            // Stream text deltas to the UI during agent loop iterations
            onChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              fullResponse += chunk;
              safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk });
            }
          });
          // No autoApproveTools here on purpose. Agent mode used to hard-code
          // ['Bash','Read','Edit','Write','Glob','Grep','Git'], which silently
          // overrode the user's own `ask` rules for the seven most dangerous
          // tools: evaluateRules said ask, the gate opened, and the approval
          // dialog the README advertises never appeared. What may run without
          // asking is now decided only by the user's permission rules and the
          // persisted "always approve" list — both of which they can see and
          // change.
          const result = await loop.run(chat.messages, toolDefinitions, {
            ...options,
            contextAssembler,
            disabledMcpServers
          });
          // Stopped: keep what streamed; the stopped message is appended once, below.
          if (result?.type === 'stopped' || abortController.signal.aborted) {
            stopped = true;
            ownCalls = result?.llm?.calls || [];
            llmSummary = summarize();
            return;
          }
          // If streaming didn't fire (non-streaming provider), send full response
          if (!fullResponse) {
            fullResponse = result.content || '(No response)';
            safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk: fullResponse });
          } else {
            // Streaming fired — use result.content as the canonical final answer
            // (fullResponse accumulated deltas but result.content is the clean final text)
            fullResponse = result.content || fullResponse;
          }
          // The case journal records the model's own answer, before any
          // advisor review text is appended below, and never the
          // '(No response)' placeholder (that isn't an answer to journal).
          answerText = fullResponse;
          ownCalls = result?.llm?.calls || [];
          llmSummary = summarize();

          // The advisor reviews on the turn's main model (spec §8; advisor.model is gone, §13).
          const advisorSettings = typeof getSettings === 'function' ? getSettings() : {};
          const advisorConfig = advisorSettings.advisor;
          if (advisorConfig?.enabled && !abortController.signal.aborted) {
            const advisorModel = mainTarget.model;
            try {
              safeSend(event.sender, 'chat:advisorStarted', { chatId });
              const advisor = new Advisor({
                provider,
                model: advisorModel,
                usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null
              });

              const reviewResult = await advisor.review(result, {
                userMessage: safeMessage
              });
              // The review is one more main-role call of this turn (spec §8, §10).
              if (reviewResult.llmMetrics) {
                ownCalls = [...ownCalls, reviewResult.llmMetrics];
                llmSummary = summarize();
              }

              if (reviewResult.review) {
                // The routed provider may have failed over mid-review; label
                // with whichever model actually answered, not just the one
                // first asked (fix round 1).
                const answeredModel = provider.current?.()?.model ?? mainTarget.model;
                // Append advisor review as a system note
                const reviewNote = `\n\n---\n**Advisor Review** (${answeredModel}):\n${reviewResult.review}`;
                fullResponse += reviewNote;
                safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk: reviewNote });
                safeSend(event.sender, 'chat:advisorCompleted', {
                  chatId,
                  verdict: reviewResult.verdict,
                  model: answeredModel
                });
              }
            } catch (err) {
              advisorLog.warn(`Review failed: ${err.message}`);
            }
          }
        } else {
          let streamResult = null;
          try {
            streamResult = await provider.streamMessage(chat.messages, { ...options, abortSignal: abortController.signal }, (chunk) => {
              if (abortController.signal.aborted) return;
              fullResponse += chunk;
              safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk });
            });
          } catch (err) {
            if (!abortController.signal.aborted) throw err;
            // Stopped mid-call: keep the usage the provider reported so far.
            const at = typeof provider.current === 'function' ? provider.current() : mainTarget;
            const tags = !err?.partialLlmMetrics && typeof provider.callTags === 'function' ? provider.callTags() : {};
            streamResult = { llmMetrics: { ...partialMetricsOf(err, { provider: at.provider, model: at.model }), ...tags } };
          }
          if (abortController.signal.aborted) stopped = true;

          // No advisor review runs on this path, so the model's answer is
          // just the accumulated response.
          answerText = fullResponse;

          const singleCall = streamResult?.llmMetrics || null;
          ownCalls = singleCall ? [singleCall] : [];
          llmSummary = summarize();

          const usageTracker = typeof getUsageTracker === 'function' ? getUsageTracker() : null;
          if (usageTracker && singleCall && typeof usageTracker.record === 'function') {
            const usageEvent = usageTracker.record(
              typeof createUsageRecordFromMetrics === 'function'
                ? createUsageRecordFromMetrics(singleCall, 0)
                : UsageTracker.eventFromMetrics(singleCall)
            );
            if (caseTurn && usageEvent) caseRuntime.usageHook(caseTurn)(usageEvent);
          }
        }
      });

      if (stopped || abortController.signal.aborted) {
        return finishStopped();
      }
      // Never journal the '(No response)' placeholder — it isn't an answer.
      const journal = answerText && answerText !== '(No response)' ? answerText : null;
      await endCaseTurn({ summary: safeMessage, journal });

      const updatedChat = appendMessageToChat(chatId, 'assistant', fullResponse || '(No response)', {
        llm: llmSummary
      });
      safeSend(event.sender, 'chat:messageComplete', {
        chatId,
        responseId,
        message: fullResponse || '(No response)',
        llm: llmSummary
      });

      const voiceSettings = getVoiceSettings();
      if (voiceSettings.enabled && voiceSettings.speakChatResponses) {
        speakSummaryText(fullResponse || '(No response)', voiceSettings).catch((error) => {
          voiceLog.warn(`Failed to speak chat response: ${error.message}`);
        });
      }

      // Auto-name chats that still have the default title, on the turn's
      // utility role (spec §8).
      if (chat.title === 'New Chat' && fullResponse) {
        autoNameChat({ chatId, userMessage: safeMessage, assistantResponse: fullResponse, sender: event.sender, turnModels }).catch(() => {});
      }

      return updatedChat;
    } catch (error) {
      if (abortController.signal.aborted) {
        return finishStopped();
      }
      await endCaseTurn({ summary: `turn failed: ${error?.message || error}`, journal: null });
      // The router already reported any auth failure against the provider
      // that actually failed (spec §5.3, §6.7); the send path never does.
      safeSend(event.sender, 'chat:messageError', {
        chatId,
        responseId,
        error: error.message,
        ...(error?.code === 'MAIN_OVERRIDE_UNUSABLE' ? { action: { kind: 'use-profile-main' } } : {}),
        ...(error?.code === 'NO_USABLE_MODEL' ? { action: { kind: 'open-models' } } : {})
      });
      throw error;
    } finally {
      // Only this run's own controller, from this chat's own Set — a Stop,
      // a newer or older run of the same chat, or the hook-deny return
      // above may have already added, aborted or removed others. Runs on
      // every exit: the hook denying the turn, the gate's own refusal, any
      // other error, a stop, or a normal completion (targeted fix, after
      // final review I2's fix wave left the hook-deny return with no
      // cleanup at all, and the wave's own rewrite of the "second send"
      // regression test papered over that this run's controller must never
      // take another run's entry down with it).
      const set = activeRuns.get(chatId);
      if (set) {
        set.delete(abortController);
        if (set.size === 0) activeRuns.delete(chatId);
      }
    }
  }));

  ipcMain.handle(IPC.CHAT_TRUNCATE_FROM, wrapHandler(IPC.CHAT_TRUNCATE_FROM, async (_event, { chatId, fromIndex }) => {
    const chat = findChat(chatId, { messages: true });
    if (!chat) throw new Error('Chat not found');
    if (typeof fromIndex !== 'number' || fromIndex < 0 || fromIndex >= chat.messages.length) {
      throw new Error('Invalid fromIndex');
    }
    const trimmed = chat.messages.slice(0, fromIndex);
    return patchChat(chatId, { messages: trimmed, updatedAt: new Date().toISOString() });
  }));

  ipcMain.handle(IPC.CHAT_STOP_RESPONSE, wrapHandler(IPC.CHAT_STOP_RESPONSE, async (_event, { chatId }) => {
    const runSet = activeRuns.get(chatId);
    if (runSet && runSet.size > 0) {
      // Every concurrent send for this chat stops together — Stop has no
      // way to target just one of them, and leaving the others running
      // would silently keep billing and streaming (targeted fix).
      for (const controller of runSet) controller.abort();
      activeRuns.delete(chatId);
      return { ok: true };
    }
    // No run of this chat: a case chat may be watching a wake-up turn on its
    // case, which the owner can stop from here (spec 2026-09-27 §9). An
    // owner turn is never stopped through this fallback: it belongs to some
    // chat's own run, and that chat's own Stop already covers it (fix round
    // 1) — two chats can be attached to the same case, and aborting an
    // owner turn from a chat that isn't running it would abort the turn's
    // signal without ever aborting the run's own abortController, so that
    // other chat keeps streaming into a turn that no longer exists.
    const chat = findChat(chatId, { messages: true });
    const caseRuntime = chat?.caseId && typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    const runningTurn = caseRuntime && typeof caseRuntime.runningTurn === 'function' ? caseRuntime.runningTurn(chat.caseId) : null;
    if (caseRuntime && runningTurn?.source !== 'owner' && typeof caseRuntime.abortTurn === 'function' && caseRuntime.abortTurn(chat.caseId, 'stopped by owner')) {
      return { ok: true, caseTurn: true };
    }
    return { ok: false, error: 'No active response for this chat.' };
  }));
}

module.exports = {
  registerChatHandlers
};

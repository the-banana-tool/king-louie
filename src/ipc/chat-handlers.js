const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const ImageHandler = require('../media/image-handler');
const Advisor = require('../execution/advisor');

function registerChatHandlers(ipcMain, context = {}) {
  const {
    createId,
    getChats,
    setChats,
    getActiveChatId,
    setActiveChatId,
    appendMessageToChat,
    getLastAssistantMessage,
    getVoiceSettings,
    runHookEvent,
    resolveInference,
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
    getToolResultsDir
  } = context;

  const activeRuns = new Map(); // chatId -> AbortController

  /**
   * Generate a contextual title for a chat using the LLM,
   * then persist it and notify the renderer.
   */
  async function autoNameChat(chatId, userMessage, assistantResponse, sender) {
    try {
      const inference = await resolveInference();
      const provider = inference.provider;
      if (typeof provider.sendMessage !== 'function') return;

      const titlePrompt = [
        {
          sender: 'user',
          text: `Generate a short, descriptive title (max 6 words) for a chat that starts with this exchange. Reply with ONLY the title text, no quotes or punctuation at the end.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantResponse.slice(0, 300)}`
        }
      ];

      const title = await provider.sendMessage(titlePrompt, {
        model: inference.model,
        temperature: 0.3,
        max_tokens: 30
      });

      const cleaned = title.replace(/^["']|["'.!]$/g, '').trim();
      if (!cleaned) return;

      const chats = getChats();
      const updated = chats.map((chat) =>
        chat.id === chatId
          ? { ...chat, title: cleaned, updatedAt: new Date().toISOString() }
          : chat
      );
      setChats(updated);

      // Notify the renderer so the sidebar updates
      if (sender && !sender.isDestroyed()) {
        sender.send('chat:updated', { chats: updated });
      }
    } catch (err) {
      console.warn('[auto-name] Failed to generate chat title:', err.message);
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
    return {
      chats: getChats(),
      activeChatId: getActiveChatId()
    };
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
    const chats = [newChat, ...getChats()];
    setChats(chats);
    setActiveChatId(newChat.id);
    return newChat;
  }));

  ipcMain.handle(IPC.CHAT_SET_ACTIVE, wrapHandler(IPC.CHAT_SET_ACTIVE, async (_event, chatId) => {
    setActiveChatId(chatId);
    return { activeChatId: chatId };
  }));

  ipcMain.handle(IPC.CHAT_RENAME, wrapHandler(IPC.CHAT_RENAME, async (_event, { chatId, name }) => {
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, title: name, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return updated.find((chat) => chat.id === chatId);
  }));

  ipcMain.handle(IPC.CHAT_DELETE, wrapHandler(IPC.CHAT_DELETE, async (_event, chatId) => {
    const chats = getChats().filter((chat) => chat.id !== chatId);
    setChats(chats);
    const activeChatId = getActiveChatId();
    if (activeChatId === chatId) {
      const nextChatId = chats[0]?.id || null;
      setActiveChatId(nextChatId);
    }
    return { chats, activeChatId: getActiveChatId() };
  }));

  ipcMain.handle(IPC.CHAT_SET_AGENT_MODE, wrapHandler(IPC.CHAT_SET_AGENT_MODE, async (_event, { chatId, agentMode }) => {
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, agentMode: !!agentMode, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return updated.find((chat) => chat.id === chatId);
  }));

  ipcMain.handle(IPC.CHAT_SET_SANDBOX_MODE, wrapHandler(IPC.CHAT_SET_SANDBOX_MODE, async (_event, { chatId, sandboxMode }) => {
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, sandboxMode: !!sandboxMode, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return updated.find((chat) => chat.id === chatId);
  }));

  ipcMain.handle(IPC.CHAT_SET_DISABLED_MCP, wrapHandler(IPC.CHAT_SET_DISABLED_MCP, async (_event, { chatId, disabledMcpServers } = {}) => {
    const list = Array.isArray(disabledMcpServers)
      ? disabledMcpServers.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
      : [];
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, disabledMcpServers: list, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return updated.find((chat) => chat.id === chatId);
  }));

  ipcMain.handle(IPC.CHAT_SET_WORKING_DIR, wrapHandler(IPC.CHAT_SET_WORKING_DIR, async (_event, { chatId, workingDirectory }) => {
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, workingDirectory: workingDirectory || null, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return updated.find((chat) => chat.id === chatId);
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
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === chatId
        ? { ...chat, workingDirectory: dir, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return { canceled: false, chat: updated.find((chat) => chat.id === chatId) };
  }));

  ipcMain.handle(IPC.CHAT_ADD_MESSAGE, wrapHandler(IPC.CHAT_ADD_MESSAGE, async (_event, payload = {}) => {
    const { chatId, sender, text, ...metadata } = payload;
    return appendMessageToChat(chatId, sender, text, metadata);
  }));

  ipcMain.handle(IPC.CHAT_SPEAK_LAST, wrapHandler(IPC.CHAT_SPEAK_LAST, async (_event, { chatId, summary = false } = {}) => {
    const chat = getChats().find((item) => item.id === chatId);
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

  /**
   * Pick a cheap model for agent-loop tool iterations (after the first).
   * Uses settings.inference.agentLoopModel if configured, otherwise
   * auto-selects the cheapest capable model for the same provider.
   * Returns null if the primary model is already cheap.
   */
  function resolveAgentLoopModel(providerType, primaryModel) {
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    const configured = settings?.inference?.agentLoopModel;
    if (configured) return configured;

    // Don't downgrade if already on a cheap model
    const lower = String(primaryModel || '').toLowerCase();
    const cheapPatterns = ['mini', 'haiku', 'flash', '8b-instant', 'small'];
    if (cheapPatterns.some(p => lower.includes(p))) return null;

    const cheapModels = {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-3-5-haiku-latest',
      gemini: 'gemini-2.0-flash',
      groq: 'llama-3.1-8b-instant',
      mistral: 'mistral-small-latest',
      deepseek: 'deepseek-chat'
    };

    return cheapModels[providerType] || null;
  }

  ipcMain.handle(IPC.CHAT_SEND_MESSAGE, wrapHandler(IPC.CHAT_SEND_MESSAGE, async (event, { chatId, message, images = [], documents = [], agentMode = false, sandboxMode = true }) => {
    let safeMessage = String(message || '');
    const normalizedImages = ImageHandler.normalizeMessageImages(images);
    const normalizedDocuments = ImageHandler.normalizeMessageDocuments(documents);

    if (!safeMessage.trim() && normalizedImages.length === 0 && normalizedDocuments.length === 0) {
      throw new Error('Message text or at least one attachment is required.');
    }

    // Resolve working directory: per-chat > process.cwd()
    const chatForDir = getChats().find((item) => item.id === chatId);
    const chatWorkingDirectory = chatForDir?.workingDirectory || process.cwd();
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    const allowedDirectories = Array.isArray(settings.allowedDirectories) ? settings.allowedDirectories : [];

    await runHookEvent('UserPromptSubmit', {
      source: 'ui',
      chatId,
      prompt: safeMessage,
      timestamp: new Date().toISOString(),
      workingDirectory: chatWorkingDirectory
    });

    const userMessage = appendMessageToChat(chatId, 'user', safeMessage, {
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
      ...(normalizedDocuments.length > 0 ? { documents: normalizedDocuments } : {})
    });
    if (!userMessage) {
      throw new Error('Chat not found');
    }

    const inference = await resolveInference({ message: safeMessage, agentMode });
    if (!['openai', 'anthropic', 'gemini'].includes(inference.providerType)) {
      throw new Error('Active provider does not support chat completions yet.');
    }

    // If a prefix-type smart routing rule matched, strip the prefix from the message
    if (inference.matchedPrefix) {
      const { stripPrefix } = require('../providers/smart-routing');
      safeMessage = stripPrefix(safeMessage, inference.matchedPrefix);
    }

    const provider = inference.provider;

    const chatRaw = getChats().find((item) => item.id === chatId);
    if (!chatRaw) {
      throw new Error('Chat not found');
    }
    // Filter out persisted tool events — only user/assistant messages go to the LLM
    const allContentMessages = chatRaw.messages.filter((m) => m.sender === 'user' || m.sender === 'assistant');

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
        console.log(`[chat] Compacted ${allContentMessages.length} messages → ${chatMessages.length} messages (~${origTokens} → ~${compTokens} tokens, ${Math.round((1 - compTokens / origTokens) * 100)}% reduction)`);
      } catch (err) {
        console.warn('[chat] Conversation compaction failed, using full history:', err.message);
      }
    }

    const chat = { ...chatRaw, messages: chatMessages };

    const responseId = createId();
    const runId = createId();
    const options = {
      model: inference.model,
      timeoutMs: inference.timeoutMs,
      tier: inference.tier,
      runId
    };

    const abortController = new AbortController();
    activeRuns.set(chatId, abortController);

    safeSend(event.sender, 'chat:messageStart', { chatId, responseId });

    try {
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
          if (availableNames.length > 0) {
            options.systemPrompt += `\n\nAdditional tools available on request via the RequestTools tool: ${availableNames.join(', ')}`;
          }
        } catch (err) {
          console.warn('[chat] Context assembly failed, falling back to full context:', err.message);
        }
      }

      // Fallback: full system prompt + all tools
      if (!options.systemPrompt) {
        options.systemPrompt = [
          buildRuntimeSystemPrompt(runtimeEnvironment),
          memoryContext
        ].filter(Boolean).join('\n\n');
      }

      const executor = await createToolExecutorWithApprovals(event, runtimeEnvironment, null, {
        workingDirectory: chatWorkingDirectory,
        allowedDirectories,
        useSandbox: sandboxMode
      });

      executor.on('preExecute', ({ toolName, parameters }) => {
        appendMessageToChat(chatId, 'toolUse', '', { toolName, parameters, runId });
        safeSend(event.sender, 'chat:toolUse', { chatId, runId, toolName, parameters });
      });

      executor.on('postExecute', ({ toolName, result }) => {
        appendMessageToChat(chatId, 'toolResult', '', { toolName, result, runId });
        safeSend(event.sender, 'chat:toolResult', { chatId, runId, toolName, result });
      });

      executor.on('toolProgress', ({ toolName, progress }) => {
        safeSend(event.sender, 'chat:toolProgress', { chatId, runId, toolName, progress });
      });

      let fullResponse = '';
      let llmSummary = {
        calls: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
      };
      const toolDefinitions = filterMcpTools(assembledTools || toolRegistry.getFunctionDefinitions());
      await withNotificationTiming('Chat response', async () => {
        const canUseAgentMode = agentMode && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
        if (canUseAgentMode) {
          const loopModel = resolveAgentLoopModel(inference.providerType, options.model);
          const embeddingProvider = contextAssembler?.embeddingProvider || null;
          const toolResultsDir = typeof getToolResultsDir === 'function' ? getToolResultsDir() : null;
          const loop = new AgentLoop(provider, executor, {
            maxIterations: 40,
            loopModel,
            embeddingProvider,
            usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
            abortSignal: abortController.signal,
            toolResultsDir,
            // Stream text deltas to the UI during agent loop iterations
            onChunk: (chunk) => {
              if (abortController.signal.aborted) return;
              fullResponse += chunk;
              safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk });
            }
          });
          const result = await loop.run(chat.messages, toolDefinitions, {
            ...options,
            contextAssembler,
            disabledMcpServers,
            autoApproveTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Git']
          });
          // If streaming didn't fire (non-streaming provider), send full response
          if (!fullResponse) {
            fullResponse = result.content || '(No response)';
            safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk: fullResponse });
          } else {
            // Streaming fired — use result.content as the canonical final answer
            // (fullResponse accumulated deltas but result.content is the clean final text)
            fullResponse = result.content || fullResponse;
          }
          llmSummary = {
            calls: result?.llm?.calls || [],
            totals: result?.llm?.totals || llmSummary.totals
          };

          // Run advisor review if enabled in settings
          const advisorSettings = typeof getSettings === 'function' ? getSettings() : {};
          const advisorConfig = advisorSettings.advisor;
          if (advisorConfig?.enabled && advisorConfig?.model && !abortController.signal.aborted) {
            try {
              safeSend(event.sender, 'chat:advisorStarted', { chatId });
              const advisorProvider = provider; // Use same provider by default
              const advisor = new Advisor({
                provider: advisorProvider,
                model: advisorConfig.model,
                usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null
              });

              const reviewResult = await advisor.review(result, {
                userMessage: safeMessage
              });

              if (reviewResult.review) {
                // Append advisor review as a system note
                const reviewNote = `\n\n---\n**Advisor Review** (${advisorConfig.model}):\n${reviewResult.review}`;
                fullResponse += reviewNote;
                safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk: reviewNote });
                safeSend(event.sender, 'chat:advisorCompleted', {
                  chatId,
                  verdict: reviewResult.verdict,
                  model: advisorConfig.model
                });
              }
            } catch (err) {
              console.warn('[advisor] Review failed:', err.message);
            }
          }
        } else {
          const streamResult = await provider.streamMessage(chat.messages, { ...options, abortSignal: abortController.signal }, (chunk) => {
            if (abortController.signal.aborted) return;
            fullResponse += chunk;
            safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk });
          });

          const singleCall = streamResult?.llmMetrics || null;
          const calls = singleCall ? [singleCall] : [];
          llmSummary = {
            calls,
            totals: calls.reduce(
              (acc, call) => ({
                inputTokens: acc.inputTokens + (Number(call?.inputTokens) || 0),
                outputTokens: acc.outputTokens + (Number(call?.outputTokens) || 0),
                totalTokens: acc.totalTokens + (Number(call?.totalTokens) || 0),
                costUsd: Number((acc.costUsd + (Number(call?.costUsd) || 0)).toFixed(8))
              }),
              { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
            )
          };

          const usageTracker = typeof getUsageTracker === 'function' ? getUsageTracker() : null;
          if (usageTracker && singleCall && typeof usageTracker.record === 'function') {
            usageTracker.record(
              typeof createUsageRecordFromMetrics === 'function'
                ? createUsageRecordFromMetrics(singleCall, 0)
                : {
                    provider: singleCall.provider,
                    model: singleCall.model,
                    inputTokens: singleCall.inputTokens,
                    outputTokens: singleCall.outputTokens,
                    totalTokens: singleCall.totalTokens,
                    costUsd: singleCall.costUsd
                  }
            );
          }
        }
      });

      activeRuns.delete(chatId);

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
          console.warn('[voice] Failed to speak chat response:', error.message);
        });
      }

      // Auto-name chats that still have the default title
      if (chat.title === 'New Chat' && fullResponse) {
        autoNameChat(chatId, safeMessage, fullResponse, event.sender).catch(() => {});
      }

      return updatedChat;
    } catch (error) {
      activeRuns.delete(chatId);
      if (abortController.signal.aborted) {
        safeSend(event.sender, 'chat:messageComplete', {
          chatId,
          responseId,
          message: fullResponse || '(Stopped by user)',
          llm: llmSummary
        });
        if (fullResponse) {
          appendMessageToChat(chatId, 'assistant', fullResponse, { llm: llmSummary });
        }
        return;
      }
      safeSend(event.sender, 'chat:messageError', {
        chatId,
        responseId,
        error: error.message
      });
      throw error;
    }
  }));

  ipcMain.handle(IPC.CHAT_TRUNCATE_FROM, wrapHandler(IPC.CHAT_TRUNCATE_FROM, async (_event, { chatId, fromIndex }) => {
    const chats = getChats();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) throw new Error('Chat not found');
    if (typeof fromIndex !== 'number' || fromIndex < 0 || fromIndex >= chat.messages.length) {
      throw new Error('Invalid fromIndex');
    }
    const updated = chats.map((c) => {
      if (c.id !== chatId) return c;
      const trimmed = c.messages.slice(0, fromIndex);
      return { ...c, messages: trimmed, updatedAt: new Date().toISOString() };
    });
    setChats(updated);
    return updated.find((c) => c.id === chatId);
  }));

  ipcMain.handle(IPC.CHAT_STOP_RESPONSE, wrapHandler(IPC.CHAT_STOP_RESPONSE, async (_event, { chatId }) => {
    const controller = activeRuns.get(chatId);
    if (controller) {
      controller.abort();
      activeRuns.delete(chatId);
      return { ok: true };
    }
    return { ok: false, error: 'No active response for this chat.' };
  }));
}

module.exports = {
  registerChatHandlers
};
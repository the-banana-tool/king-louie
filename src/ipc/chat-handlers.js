const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const ImageHandler = require('../media/image-handler');

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
    createUsageRecordFromMetrics
  } = context;

  const activeRuns = new Map(); // chatId -> AbortController

  /**
   * Generate a contextual title for a chat using the LLM,
   * then persist it and notify the renderer.
   */
  async function autoNameChat(chatId, userMessage, assistantResponse, sender) {
    try {
      const inference = resolveInference();
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
    const newChat = {
      id: createId(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: createId(),
          sender: 'assistant',
          text: 'New chat started! How can I help you today?',
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

  ipcMain.handle(IPC.CHAT_RENAME, wrapHandler(IPC.CHAT_RENAME, async (_event, { id, title }) => {
    const chats = getChats();
    const updated = chats.map((chat) =>
      chat.id === id
        ? { ...chat, title, updatedAt: new Date().toISOString() }
        : chat
    );
    setChats(updated);
    return updated.find((chat) => chat.id === id);
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

  ipcMain.handle(IPC.CHAT_SEND_MESSAGE, wrapHandler(IPC.CHAT_SEND_MESSAGE, async (event, { chatId, message, images = [], agentMode = false }) => {
    const safeMessage = String(message || '');
    const normalizedImages = ImageHandler.normalizeMessageImages(images);

    if (!safeMessage.trim() && normalizedImages.length === 0) {
      throw new Error('Message text or at least one image is required.');
    }

    await runHookEvent('UserPromptSubmit', {
      source: 'ui',
      chatId,
      prompt: safeMessage,
      timestamp: new Date().toISOString(),
      workingDirectory: process.cwd()
    });

    const userMessage = appendMessageToChat(chatId, 'user', safeMessage, {
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {})
    });
    if (!userMessage) {
      throw new Error('Chat not found');
    }

    const inference = resolveInference();
    if (!['openai', 'anthropic', 'gemini'].includes(inference.providerType)) {
      throw new Error('Active provider does not support chat completions yet.');
    }
    const provider = inference.provider;
    const chat = getChats().find((item) => item.id === chatId);
    if (!chat) {
      throw new Error('Chat not found');
    }

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

    event.sender.send('chat:messageStart', { chatId, responseId });

    try {
      const runtimeEnvironment = await getRuntimeEnvironment({
        workingDirectory: process.cwd()
      });

      options.runtimeEnvironment = runtimeEnvironment;
      options.systemPrompt = [
        buildRuntimeSystemPrompt(runtimeEnvironment),
        await buildMemoryContextSection(safeMessage, { limit: 4 })
      ].filter(Boolean).join('\n\n');

      const executor = await createToolExecutorWithApprovals(event, runtimeEnvironment);

      executor.on('preExecute', ({ toolName, parameters }) => {
        event.sender.send('chat:toolUse', { chatId, runId, toolName, parameters });
      });

      executor.on('postExecute', ({ toolName, result }) => {
        event.sender.send('chat:toolResult', { chatId, runId, toolName, result });
      });

      let fullResponse = '';
      let llmSummary = {
        calls: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
      };
      const toolDefinitions = toolRegistry.getFunctionDefinitions();
      await withNotificationTiming('Chat response', async () => {
        const canUseAgentMode = agentMode && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
        if (canUseAgentMode) {
          const loop = new AgentLoop(provider, executor, {
            maxIterations: 40,
            usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
            abortSignal: abortController.signal
          });
          const result = await loop.run(chat.messages, toolDefinitions, {
            ...options,
            autoApproveTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Git']
          });
          fullResponse = result.content || '(No response)';
          llmSummary = {
            calls: result?.llm?.calls || [],
            totals: result?.llm?.totals || llmSummary.totals
          };
          event.sender.send('chat:messageChunk', { chatId, responseId, chunk: fullResponse });
        } else {
          const streamResult = await provider.streamMessage(chat.messages, { ...options, abortSignal: abortController.signal }, (chunk) => {
            if (abortController.signal.aborted) return;
            fullResponse += chunk;
            event.sender.send('chat:messageChunk', { chatId, responseId, chunk });
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
      event.sender.send('chat:messageComplete', {
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
        event.sender.send('chat:messageComplete', {
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
      event.sender.send('chat:messageError', {
        chatId,
        responseId,
        error: error.message
      });
      throw error;
    }
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
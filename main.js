const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { default: Store } = require('electron-store');
const ProviderFactory = require('./src/providers/provider-factory');
const { initializeTools, toolRegistry } = require('./src/tools');
const ToolExecutor = require('./src/execution/tool-executor');
const AgentLoop = require('./src/execution/agent-loop');
const { getRuntimeEnvironment } = require('./src/execution/runtime-environment');

let mainWindow;
const pendingApprovalResolvers = new Map();

const store = new Store({
  name: 'chat-data',
  defaults: {
    chats: [],
    activeChatId: null,
    apiTokens: {},
    apiStatus: {},
    settings: {
      activeProvider: 'openai',
      providerModels: {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-5-sonnet-latest',
        copilot: ''
      }
    },
    toolApprovals: {
      alwaysApproveTools: {}
    }
  }
});

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getChats = () => store.get('chats', []);
const setChats = (chats) => store.set('chats', chats);
const getActiveChatId = () => store.get('activeChatId', null);
const setActiveChatId = (chatId) => store.set('activeChatId', chatId);
const getApiTokens = () => store.get('apiTokens', {});
const setApiTokens = (tokens) => store.set('apiTokens', tokens);
const getApiStatus = () => store.get('apiStatus', {});
const setApiStatus = (status) => store.set('apiStatus', status);
const getSettings = () => store.get('settings', {
  activeProvider: 'openai',
  providerModels: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-latest',
    copilot: ''
  }
});
const setSettings = (settings) => store.set('settings', settings);
const getToolApprovals = () => store.get('toolApprovals', { alwaysApproveTools: {} });
const setToolApprovals = (toolApprovals) => store.set('toolApprovals', toolApprovals);

const isToolAlwaysApproved = (toolName) => {
  const approvals = getToolApprovals();
  return Boolean(approvals?.alwaysApproveTools?.[toolName]);
};

const setToolAlwaysApprove = (toolName, approved = true) => {
  const approvals = getToolApprovals();
  const updated = {
    ...approvals,
    alwaysApproveTools: {
      ...(approvals?.alwaysApproveTools || {}),
      [toolName]: Boolean(approved)
    }
  };

  setToolApprovals(updated);
};

const providerLabels = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  copilot: 'GitHub Copilot'
};

const providerDefaults = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  copilot: ''
};

const providerTokenHints = {
  openai: 'sk-',
  anthropic: 'sk-ant-',
  copilot: 'ghp_'
};

const normalizeProvider = (value = '') => String(value || '').trim().toLowerCase();

const isSupportedProvider = (provider) => Boolean(providerLabels[provider]);

const validateProviderToken = (provider, token) => {
  if (!token || token.trim().length < 8) {
    return 'Token is required and must be at least 8 characters.';
  }

  const expectedPrefix = providerTokenHints[provider];
  if (expectedPrefix && !token.startsWith(expectedPrefix)) {
    return `${providerLabels[provider]} tokens typically start with "${expectedPrefix}".`;
  }

  return null;
};

const getProviderModel = (provider) => {
  const settings = getSettings();
  return settings.providerModels?.[provider] || providerDefaults[provider] || '';
};

const setProviderModel = (provider, model) => {
  const settings = getSettings();
  const updated = {
    ...settings,
    providerModels: {
      ...(settings.providerModels || {}),
      [provider]: (model || '').trim()
    }
  };
  setSettings(updated);
  return updated.providerModels[provider];
};

const setActiveProvider = (provider) => {
  const settings = getSettings();
  const updated = {
    ...settings,
    activeProvider: provider
  };
  setSettings(updated);
  return updated.activeProvider;
};

const encryptToken = (token) => {
  if (!token) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  return safeStorage.encryptString(token).toString('base64');
};

const decryptToken = (encrypted) => {
  if (!encrypted) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  return safeStorage.decryptString(buffer);
};

const updateStatus = (provider, status) => {
  const current = getApiStatus();
  const updated = {
    ...current,
    [provider]: {
      ...status,
      checkedAt: new Date().toISOString()
    }
  };
  setApiStatus(updated);
  return updated[provider];
};

const sumLlmCalls = (calls = []) =>
  (calls || []).reduce(
    (acc, call) => ({
      inputTokens: acc.inputTokens + (Number(call?.inputTokens) || 0),
      outputTokens: acc.outputTokens + (Number(call?.outputTokens) || 0),
      totalTokens: acc.totalTokens + (Number(call?.totalTokens) || 0),
      costUsd: Number((acc.costUsd + (Number(call?.costUsd) || 0)).toFixed(8))
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
  );

const buildRuntimeSystemPrompt = (runtimeEnvironment = {}) => {
  const platform = runtimeEnvironment.platform || process.platform;
  const shell = runtimeEnvironment.shell || 'unknown';
  const available = Array.isArray(runtimeEnvironment.available)
    ? runtimeEnvironment.available
    : [];
  const unavailable = Array.isArray(runtimeEnvironment.unavailable)
    ? runtimeEnvironment.unavailable
    : [];

  return [
    'Environment context (auto-detected):',
    `- Platform: ${platform}`,
    `- Shell: ${shell}`,
    `- Available CLI tools: ${available.length ? available.join(', ') : 'unknown'}`,
    `- Known missing CLI tools: ${unavailable.length ? unavailable.join(', ') : 'none detected'}`,
    'Use this context when proposing commands and selecting tools. Avoid commands for unavailable tools.'
  ].join('\n');
};

const getChatLlmTotals = (chat) => {
  const messages = chat?.messages || [];
  const totals = messages.reduce(
    (acc, message) => ({
      inputTokens: acc.inputTokens + (Number(message?.llm?.totals?.inputTokens) || 0),
      outputTokens: acc.outputTokens + (Number(message?.llm?.totals?.outputTokens) || 0),
      totalTokens: acc.totalTokens + (Number(message?.llm?.totals?.totalTokens) || 0),
      costUsd: Number((acc.costUsd + (Number(message?.llm?.totals?.costUsd) || 0)).toFixed(8))
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
  );

  return totals;
};

const appendMessageToChat = (chatId, sender, text, metadata = {}) => {
  const now = new Date().toISOString();
  const chats = getChats();
  const updated = chats.map((chat) => {
    if (chat.id !== chatId) {
      return chat;
    }

    return {
      ...chat,
      updatedAt: now,
      messages: [
        ...chat.messages,
        {
          id: createId(),
          sender,
          text,
          timestamp: now,
          ...(metadata || {})
        }
      ],
      llmTotals: getChatLlmTotals({
        ...chat,
        messages: [
          ...chat.messages,
          {
            sender,
            text,
            ...(metadata || {})
          }
        ]
      })
    };
  });

  setChats(updated);
  return updated.find((chat) => chat.id === chatId) || null;
};

const getDecryptedProviderToken = (provider) => {
  const tokens = getApiTokens();
  const encryptedToken = tokens[provider];
  if (!encryptedToken) {
    throw new Error(`No token saved for ${providerLabels[provider] || provider}.`);
  }
  return decryptToken(encryptedToken);
};

const saveProviderToken = (provider, token) => {
  const tokens = getApiTokens();
  tokens[provider] = encryptToken(token.trim());
  setApiTokens(tokens);
  return true;
};

const clearProviderToken = (provider) => {
  const tokens = getApiTokens();
  delete tokens[provider];
  setApiTokens(tokens);
  return false;
};

const getProviderSnapshot = () => {
  const tokens = getApiTokens();
  const status = getApiStatus();
  const settings = getSettings();

  const providers = Object.keys(providerLabels).reduce((acc, key) => {
    acc[key] = {
      label: providerLabels[key],
      hasToken: Boolean(tokens[key]),
      status: status[key] || null,
      model: settings.providerModels?.[key] || providerDefaults[key] || ''
    };
    return acc;
  }, {});

  return {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    providers,
    activeProvider: settings.activeProvider || 'openai'
  };
};

const testProviderConnection = async (provider) => {
  const tokens = getApiTokens();
  if (!tokens[provider]) {
    return { ok: false, error: 'No token saved for this provider.' };
  }

  const token = decryptToken(tokens[provider]);

  let response;
  if (provider === 'openai') {
    response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${token}` }
    });
  } else if (provider === 'anthropic') {
    response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01'
      }
    });
  } else if (provider === 'copilot') {
    response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'king-louie-app'
      }
    });
  }

  if (!response) {
    return { ok: false, error: 'Unable to reach provider.' };
  }

  if (!response.ok) {
    const errorText = await response.text();
    const status = updateStatus(provider, {
      ok: false,
      message: `${response.status} ${response.statusText}`
    });
    return {
      ok: false,
      error: `${response.status} ${response.statusText}`,
      details: errorText,
      status
    };
  }

  const status = updateStatus(provider, {
    ok: true,
    message: 'Connection successful'
  });
  return { ok: true, status };
};

const tokenizeCommand = (input = '') => {
  const regex = /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|`([^`\\]*(\\.[^`\\]*)*)`|(\S+)/g;
  const tokens = [];
  let match;

  while ((match = regex.exec(input)) !== null) {
    const token = match[1] ?? match[3] ?? match[5] ?? match[7] ?? '';
    tokens.push(token.replace(/\\(["'`\\])/g, '$1'));
  }

  return tokens;
};

const runLlmCommand = async (command = '') => {
  const trimmed = String(command || '').trim();
  const parts = tokenizeCommand(trimmed);
  const [namespace, actionRaw, ...rest] = parts;
  const action = (actionRaw || '').toLowerCase();

  if (namespace !== '/llm') {
    return {
      ok: false,
      error: 'Unknown local command. Use `/llm help` for usage.'
    };
  }

  if (!action || action === 'help') {
    return {
      ok: true,
      output: [
        '### Local LLM Connection Tool',
        '',
        '- `/llm list` — list configured providers and connection status',
        '- `/llm add <provider> <token>` — add/update provider API token',
        '- `/llm remove <provider>` — remove saved provider token',
        '- `/llm test <provider>` — test provider connection',
        '- `/llm use <provider>` — set active provider',
        '- `/llm model <provider> <model>` — set model for provider',
        '',
        'Providers: `openai`, `anthropic`, `copilot`'
      ].join('\n')
    };
  }

  if (action === 'list') {
    const snapshot = getProviderSnapshot();
    const rows = Object.entries(snapshot.providers).map(([key, provider]) => {
      const activeMarker = snapshot.activeProvider === key ? ' (active)' : '';
      const status = provider.status?.ok
        ? `connected (${provider.status.message || 'ok'})`
        : provider.status
          ? `error (${provider.status.message || 'failed'})`
          : 'not tested';
      return `- **${provider.label}** \`${key}\`${activeMarker}: token=${provider.hasToken ? 'saved' : 'missing'}, model=\`${provider.model || '(default)'}\`, status=${status}`;
    });

    return {
      ok: true,
      output: ['### LLM Providers & Connections', '', ...rows].join('\n')
    };
  }

  if (['add', 'save'].includes(action)) {
    const provider = normalizeProvider(rest[0]);
    const token = rest[1] || '';

    if (!isSupportedProvider(provider)) {
      return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
    }

    const validationError = validateProviderToken(provider, token);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Secure storage is not available on this system. Tokens cannot be saved.' };
    }

    saveProviderToken(provider, token);
    return {
      ok: true,
      output: `${providerLabels[provider]} token saved securely.`
    };
  }

  if (['remove', 'clear'].includes(action)) {
    const provider = normalizeProvider(rest[0]);
    if (!isSupportedProvider(provider)) {
      return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
    }

    clearProviderToken(provider);
    return {
      ok: true,
      output: `${providerLabels[provider]} token removed.`
    };
  }

  if (action === 'test') {
    const provider = normalizeProvider(rest[0]);
    if (!isSupportedProvider(provider)) {
      return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
    }

    const result = await testProviderConnection(provider);
    if (!result.ok) {
      return {
        ok: false,
        error: `Connection failed for ${providerLabels[provider]}: ${result.error}`,
        details: result.details,
        status: result.status
      };
    }

    return {
      ok: true,
      output: `${providerLabels[provider]} connection successful.`
    };
  }

  if (['use', 'active'].includes(action)) {
    const provider = normalizeProvider(rest[0]);
    if (!isSupportedProvider(provider)) {
      return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
    }

    setActiveProvider(provider);
    return {
      ok: true,
      output: `Active provider set to ${providerLabels[provider]}.`
    };
  }

  if (action === 'model') {
    const provider = normalizeProvider(rest[0]);
    const model = rest.slice(1).join(' ').trim();
    if (!isSupportedProvider(provider)) {
      return { ok: false, error: 'Unknown provider. Use openai, anthropic, or copilot.' };
    }

    setProviderModel(provider, model);
    return {
      ok: true,
      output: `${providerLabels[provider]} model set to ${model || '(default)'}.`
    };
  }

  return {
    ok: false,
    error: `Unknown action \`${action}\`. Use \`/llm help\` for usage.`
  };
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();

  mainWindow.loadFile('index.html');

  // Open DevTools in development mode
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

ipcMain.handle('app:quitWindow', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  return { ok: true };
});

ipcMain.handle('chat:load', () => {
  return {
    chats: getChats(),
    activeChatId: getActiveChatId()
  };
});

ipcMain.handle('chat:create', (_event, title = 'New Chat') => {
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
});

ipcMain.handle('chat:setActive', (_event, chatId) => {
  setActiveChatId(chatId);
  return { activeChatId: chatId };
});

ipcMain.handle('chat:rename', (_event, { id, title }) => {
  const chats = getChats();
  const updated = chats.map((chat) =>
    chat.id === id
      ? { ...chat, title, updatedAt: new Date().toISOString() }
      : chat
  );
  setChats(updated);
  return updated.find((chat) => chat.id === id);
});

ipcMain.handle('chat:delete', (_event, chatId) => {
  const chats = getChats().filter((chat) => chat.id !== chatId);
  setChats(chats);
  const activeChatId = getActiveChatId();
  if (activeChatId === chatId) {
    const nextChatId = chats[0]?.id || null;
    setActiveChatId(nextChatId);
  }
  return { chats, activeChatId: getActiveChatId() };
});

ipcMain.handle('chat:addMessage', (_event, { chatId, sender, text }) => {
  return appendMessageToChat(chatId, sender, text);
});

ipcMain.handle('chat:sendMessage', async (event, { chatId, message, agentMode = false }) => {
  const userMessage = appendMessageToChat(chatId, 'user', message);
  if (!userMessage) {
    throw new Error('Chat not found');
  }

  const settings = getSettings();
  const providerType = settings.activeProvider || 'openai';
  if (!['openai', 'anthropic'].includes(providerType)) {
    throw new Error('Active provider does not support chat completions yet.');
  }

  const token = getDecryptedProviderToken(providerType);
  const provider = ProviderFactory.createProvider(providerType, token);
  const chat = getChats().find((item) => item.id === chatId);
  if (!chat) {
    throw new Error('Chat not found');
  }

  const responseId = createId();
  const runId = createId();
  const options = {
    model: getProviderModel(providerType),
    runId
  };

  event.sender.send('chat:messageStart', { chatId, responseId });

  try {
    const runtimeEnvironment = await getRuntimeEnvironment({
      workingDirectory: process.cwd()
    });

    options.runtimeEnvironment = runtimeEnvironment;
    options.systemPrompt = buildRuntimeSystemPrompt(runtimeEnvironment);

    const executor = new ToolExecutor({
      workingDirectory: process.cwd(),
      requireApproval: true,
      runtimeEnvironment,
      shouldAutoApprove: async (toolName) => isToolAlwaysApproved(toolName)
    });

    executor.on('preExecute', ({ toolName, parameters }) => {
      event.sender.send('chat:toolUse', { chatId, runId, toolName, parameters });
    });

    executor.on('postExecute', ({ toolName, result }) => {
      event.sender.send('chat:toolResult', { chatId, runId, toolName, result });
    });

    executor.on('approvalRequired', ({ toolName, parameters, resolve }) => {
      const approvalId = createId();
      pendingApprovalResolvers.set(approvalId, { resolve, toolName });
      event.sender.send('tool:approvalRequired', { approvalId, toolName, parameters });
    });

    let fullResponse = '';
    let llmSummary = {
      calls: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
    };
    const toolDefinitions = toolRegistry.getFunctionDefinitions();
    const canUseAgentMode = agentMode && toolDefinitions.length > 0 && typeof provider.sendMessageWithTools === 'function';
    if (canUseAgentMode) {
      const loop = new AgentLoop(provider, executor, { maxIterations: 10 });
      const result = await loop.run(chat.messages, toolDefinitions, options);
      fullResponse = result.content || '(No response)';
      llmSummary = {
        calls: result?.llm?.calls || [],
        totals: result?.llm?.totals || llmSummary.totals
      };
      event.sender.send('chat:messageChunk', { chatId, responseId, chunk: fullResponse });
    } else {
      const streamResult = await provider.streamMessage(chat.messages, options, (chunk) => {
        fullResponse += chunk;
        event.sender.send('chat:messageChunk', { chatId, responseId, chunk });
      });

      const singleCall = streamResult?.llmMetrics || null;
      const calls = singleCall ? [singleCall] : [];
      llmSummary = {
        calls,
        totals: sumLlmCalls(calls)
      };
    }

    const updatedChat = appendMessageToChat(chatId, 'assistant', fullResponse || '(No response)', {
      llm: llmSummary
    });
    event.sender.send('chat:messageComplete', {
      chatId,
      responseId,
      message: fullResponse || '(No response)',
      llm: llmSummary
    });

    return updatedChat;
  } catch (error) {
    event.sender.send('chat:messageError', {
      chatId,
      responseId,
      error: error.message
    });
    throw error;
  }
});

ipcMain.handle('tool:execute', async (event, { toolName, parameters }) => {
  const executor = new ToolExecutor({
    workingDirectory: process.cwd(),
    requireApproval: true,
    shouldAutoApprove: async (requestedToolName) => isToolAlwaysApproved(requestedToolName)
  });

  executor.on('approvalRequired', ({ toolName: requestedToolName, parameters: requestedParameters, resolve }) => {
    const approvalId = createId();
    pendingApprovalResolvers.set(approvalId, { resolve, toolName: requestedToolName });
    event.sender.send('tool:approvalRequired', {
      approvalId,
      toolName: requestedToolName,
      parameters: requestedParameters
    });
  });

  return executor.execute(toolName, parameters);
});

ipcMain.handle('tool:list', async () => {
  return toolRegistry.getFunctionDefinitions();
});

ipcMain.on('tool:approvalResponse', (_event, { approvalId, approved, alwaysApprove }) => {
  const pendingApproval = pendingApprovalResolvers.get(approvalId);
  if (!pendingApproval) return;

  pendingApprovalResolvers.delete(approvalId);

  if (Boolean(approved) && Boolean(alwaysApprove) && pendingApproval.toolName) {
    setToolAlwaysApprove(pendingApproval.toolName, true);
  }

  pendingApproval.resolve(Boolean(approved));
});

ipcMain.handle('settings:load', () => {
  const tokens = getApiTokens();
  const status = getApiStatus();
  const settings = getSettings();

  const providers = Object.keys(providerLabels).reduce((acc, key) => {
    acc[key] = {
      label: providerLabels[key],
      hasToken: Boolean(tokens[key]),
      status: status[key] || null,
      model: settings.providerModels?.[key] || providerDefaults[key] || ''
    };
    return acc;
  }, {});

  return {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    providers,
    activeProvider: settings.activeProvider || 'openai'
  };
});

ipcMain.handle('settings:setActiveProvider', (_event, { provider }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  const settings = getSettings();
  const updated = {
    ...settings,
    activeProvider: provider
  };
  setSettings(updated);

  return { ok: true, activeProvider: provider };
});

ipcMain.handle('settings:setProviderModel', (_event, { provider, model }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  const settings = getSettings();
  const updated = {
    ...settings,
    providerModels: {
      ...(settings.providerModels || {}),
      [provider]: (model || '').trim()
    }
  };
  setSettings(updated);

  return { ok: true, model: updated.providerModels[provider] };
});

ipcMain.handle('settings:saveProvider', (_event, { provider, token, clear }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  try {
    const tokens = getApiTokens();
    if (clear) {
      delete tokens[provider];
      setApiTokens(tokens);
      return { ok: true, hasToken: false };
    }

    if (typeof token === 'string' && token.trim() !== '') {
      tokens[provider] = encryptToken(token.trim());
      setApiTokens(tokens);
      return { ok: true, hasToken: true };
    }

    return { ok: true, hasToken: Boolean(tokens[provider]) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('settings:testProvider', async (_event, { provider }) => {
  if (!providerLabels[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  try {
    const tokens = getApiTokens();
    if (!tokens[provider]) {
      return { ok: false, error: 'No token saved for this provider.' };
    }

    const token = decryptToken(tokens[provider]);

    let response;
    if (provider === 'openai') {
      response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${token}` }
      });
    } else if (provider === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01'
        }
      });
    } else if (provider === 'copilot') {
      response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'king-louie-app'
        }
      });
    }

    if (!response) {
      return { ok: false, error: 'Unable to reach provider.' };
    }

    if (!response.ok) {
      const errorText = await response.text();
      const status = updateStatus(provider, {
        ok: false,
        message: `${response.status} ${response.statusText}`
      });
      return {
        ok: false,
        error: `${response.status} ${response.statusText}`,
        details: errorText,
        status
      };
    }

    const status = updateStatus(provider, {
      ok: true,
      message: 'Connection successful'
    });
    return { ok: true, status };
  } catch (error) {
    const status = updateStatus(provider, {
      ok: false,
      message: error.message
    });
    return { ok: false, error: error.message, status };
  }
});

ipcMain.handle('settings:runLlmCommand', async (_event, { command }) => {
  try {
    return await runLlmCommand(command);
  } catch (error) {
    return { ok: false, error: error.message || 'Unable to run local LLM command.' };
  }
});

app.whenReady().then(() => {
  initializeTools();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

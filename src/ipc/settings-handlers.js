const { wrapHandler } = require('./wrap-handler');
const { createLogger } = require('../logging');

const log = createLogger('settings');

function registerSettingsHandlers(ipcMain, context = {}) {
  const {
    safeStorage,
    getApiTokens,
    getApiStatus,
    getSettings,
    providerLabels,
    hasStoredElevenLabsToken,
    hasStoredTelegramToken,
    listHookDefinitions,
    normalizeTemplateVariables,
    getUserProfile,
    getVoiceSettings,
    setTemplateVariables,
    updateUserProfile,
    setVoiceSettings,
    clearElevenLabsToken,
    saveElevenLabsToken,
    normalizeVoiceSettings,
    setSettings,
    resetRuntimeEnvironmentCache,
    setApiTokens,
    encryptToken,
    decryptToken,
    updateStatus,
    runLlmCommand,
    anthropicOAuth,
    setNotificationSettings,
    getMainWindow,
    testProviderConnection,
    onProviderKeyChanged,
    getProviderOptions
  } = context;

  const getTelegramBridge = () => (
    typeof context.getTelegramBridge === 'function'
      ? context.getTelegramBridge()
      : context.telegramBridge
  );

  const getTtsEngine = () => (
    typeof context.getTtsEngine === 'function'
      ? context.getTtsEngine()
      : context.ttsEngine
  );

  // A saved, cleared or connected key is retested in the background (spec
  // 2026-09-27 §5.2); the result reaches the UI as models:statusChanged.
  const notifyKeyChanged = (provider) => {
    if (typeof onProviderKeyChanged !== 'function') return;
    Promise.resolve()
      .then(() => onProviderKeyChanged(provider))
      .catch((err) => log.warn(`Retesting ${provider} after a key change failed: ${err.message}`));
  };

  ipcMain.handle('settings:load', wrapHandler('settings:load', async () => {
    const tokens = getApiTokens();
    const status = getApiStatus();
    const settings = getSettings();

    const providers = Object.keys(providerLabels).reduce((acc, key) => {
      acc[key] = {
        label: providerLabels[key],
        hasToken: Boolean(tokens[key]),
        status: status[key] || null
      };
      return acc;
    }, {});

    return {
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      providers,
      ollamaBaseUrl: settings.models?.ollama?.baseUrl || '',
      modelsSettings: {
        catalog: settings.models?.catalog || {},
        overrides: settings.models?.overrides || {}
      },
      notifications: settings.notifications,
      hooks: {
        enabled: settings?.hooks?.enabled !== false,
        loaded: listHookDefinitions()
      },
      templateVariables: normalizeTemplateVariables(settings.templateVariables || {}),
      userProfile: getUserProfile(),
      voice: {
        ...getVoiceSettings(),
        hasElevenLabsKey: hasStoredElevenLabsToken()
      },
      telegram: {
        hasToken: hasStoredTelegramToken(),
        bridgeActive: Boolean(getTelegramBridge()),
        status: status.telegram || null
      },
      webSearch: settings.webSearch,
      imageGeneration: settings.imageGeneration,
      allowedDirectories: settings.allowedDirectories || [],
      anthropicOAuth: anthropicOAuth ? anthropicOAuth.getStatus() : { connected: false }
    };
  }));

  ipcMain.handle('settings:saveWebSearchKey', wrapHandler('settings:saveWebSearchKey', async (_event, { provider, apiKey, clear } = {}) => {
    if (!['brave', 'tavily'].includes(provider)) {
      return { ok: false, error: 'Unknown web search provider.' };
    }

    const settings = getSettings();
    if (clear) {
      settings.webSearch[provider].apiKey = '';
      setSettings(settings);
      return { ok: true, hasKey: false };
    }

    const key = String(apiKey || '').trim();
    if (!key) {
      return { ok: false, error: `${provider} API key is required.` };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Secure storage is not available on this system.' };
    }

    settings.webSearch[provider].apiKey = encryptToken(key);
    setSettings(settings);
    return { ok: true, hasKey: true };
  }));

  ipcMain.handle('settings:testWebSearchKey', wrapHandler('settings:testWebSearchKey', async (_event, { provider } = {}) => {
    if (!['brave', 'tavily'].includes(provider)) {
      return { ok: false, error: 'Unknown web search provider.' };
    }

    const settings = getSettings();
    const encrypted = settings.webSearch?.[provider]?.apiKey;
    if (!encrypted) {
      return { ok: false, error: `No ${provider} API key configured.` };
    }

    const apiKey = decryptToken(encrypted);
    if (!apiKey) {
      return { ok: false, error: `Failed to decrypt ${provider} API key.` };
    }

    try {
      if (provider === 'brave') {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=test&count=1`, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': apiKey
          }
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Brave API error (${res.status}): ${text}`);
        }
        return { ok: true, message: 'Brave Search connection successful.' };
      } else {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1, search_depth: 'basic' })
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Tavily API error (${res.status}): ${text}`);
        }
        return { ok: true, message: 'Tavily connection successful.' };
      }
    } catch (err) {
      return { ok: false, error: err.message || `${provider} test failed.` };
    }
  }));

  ipcMain.handle('settings:saveImageGenKey', wrapHandler('settings:saveImageGenKey', async (_event, { provider, apiKey, clear } = {}) => {
    if (!['fal'].includes(provider)) {
      return { ok: false, error: 'Unknown image generation provider.' };
    }

    const settings = getSettings();
    if (!settings.imageGeneration) settings.imageGeneration = {};
    if (!settings.imageGeneration[provider]) settings.imageGeneration[provider] = {};

    if (clear) {
      settings.imageGeneration[provider].apiKey = '';
      setSettings(settings);
      return { ok: true, hasKey: false };
    }

    const key = String(apiKey || '').trim();
    if (!key) {
      return { ok: false, error: `${provider} API key is required.` };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Secure storage is not available on this system.' };
    }

    settings.imageGeneration[provider].apiKey = encryptToken(key);
    setSettings(settings);
    return { ok: true, hasKey: true };
  }));

  ipcMain.handle('settings:testImageGenKey', wrapHandler('settings:testImageGenKey', async (_event, { provider } = {}) => {
    if (!['fal'].includes(provider)) {
      return { ok: false, error: 'Unknown image generation provider.' };
    }

    const settings = getSettings();
    const encrypted = settings.imageGeneration?.[provider]?.apiKey;
    if (!encrypted) {
      return { ok: false, error: `No ${provider} API key configured.` };
    }

    const apiKey = decryptToken(encrypted);
    if (!apiKey) {
      return { ok: false, error: `Failed to decrypt ${provider} API key.` };
    }

    try {
      if (provider === 'fal') {
        const res = await fetch('https://fal.run/fal-ai/flux/dev', {
          method: 'POST',
          headers: {
            'Authorization': `Key ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ prompt: 'test', num_images: 1, image_size: { width: 64, height: 64 } })
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Fal API authentication failed (${res.status})`);
        }
        return { ok: true, message: 'Fal API key is valid.' };
      }
      return { ok: false, error: 'Unknown provider.' };
    } catch (err) {
      return { ok: false, error: err.message || `${provider} test failed.` };
    }
  }));

  ipcMain.handle('settings:setImageGenDefault', wrapHandler('settings:setImageGenDefault', async (_event, { provider } = {}) => {
    if (!['openai', 'fal'].includes(provider)) {
      return { ok: false, error: 'Unknown image generation provider.' };
    }
    const settings = getSettings();
    if (!settings.imageGeneration) settings.imageGeneration = {};
    settings.imageGeneration.defaultProvider = provider;
    setSettings(settings);
    return { ok: true, defaultProvider: provider };
  }));

  ipcMain.handle('settings:saveTemplateVariables', wrapHandler('settings:saveTemplateVariables', async (_event, { templateVariables } = {}) => {
    const saved = setTemplateVariables(templateVariables || {});
    return { ok: true, templateVariables: saved };
  }));

  ipcMain.handle('settings:saveUserProfile', wrapHandler('settings:saveUserProfile', async (_event, { profile } = {}) => {
    const saved = updateUserProfile(profile || {});
    return { ok: true, userProfile: saved };
  }));

  ipcMain.handle('settings:saveVoice', wrapHandler('settings:saveVoice', async (_event, { voice } = {}) => {
    const saved = setVoiceSettings(voice || {});
    return {
      ok: true,
      voice: {
        ...saved,
        hasElevenLabsKey: hasStoredElevenLabsToken()
      }
    };
  }));

  ipcMain.handle('settings:saveElevenLabsKey', wrapHandler('settings:saveElevenLabsKey', async (_event, { apiKey, clear } = {}) => {
    if (clear) {
      clearElevenLabsToken();
      return { ok: true, hasElevenLabsKey: false };
    }

    const key = String(apiKey || '').trim();
    if (!key) {
      return { ok: false, error: 'ElevenLabs API key is required.' };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'Secure storage is not available on this system.' };
    }

    saveElevenLabsToken(key);
    return { ok: true, hasElevenLabsKey: true };
  }));

  ipcMain.handle('settings:testVoice', wrapHandler('settings:testVoice', async (_event, { settings } = {}) => {
    const ttsEngine = getTtsEngine();
    if (!ttsEngine) {
      throw new Error('TTS engine is not initialized.');
    }

    const voiceSettings = normalizeVoiceSettings({
      ...getVoiceSettings(),
      ...(settings || {})
    });

    await ttsEngine.testConnection(voiceSettings);
    return { ok: true };
  }));

  ipcMain.handle('settings:saveProvider', wrapHandler('settings:saveProvider', async (_event, { provider, token, clear }) => {
    if (!providerLabels[provider]) {
      return { ok: false, error: 'Unknown provider.' };
    }

    const tokens = getApiTokens();
    if (clear) {
      delete tokens[provider];
      setApiTokens(tokens);
      notifyKeyChanged(provider);
      return { ok: true, hasToken: false };
    }

    if (typeof token === 'string' && token.trim() !== '') {
      tokens[provider] = encryptToken(token.trim());
      setApiTokens(tokens);
      notifyKeyChanged(provider);
      return { ok: true, hasToken: true };
    }

    return { ok: true, hasToken: Boolean(tokens[provider]) };
  }));

  ipcMain.handle('settings:testProvider', wrapHandler('settings:testProvider', async (_event, { provider }) => {
    if (!providerLabels[provider]) {
      return { ok: false, error: 'Unknown provider.' };
    }
    if (typeof testProviderConnection !== 'function') {
      return { ok: false, error: 'Connection tests are not available in this host.' };
    }
    // The one connection test (spec 2026-09-27 §5.2): the provider's
    // listModels(), stored under apiStatus with the account's models.
    return testProviderConnection(provider);
  }));

  ipcMain.handle('settings:runLlmCommand', wrapHandler('settings:runLlmCommand', async (_event, { command }) => {
    return runLlmCommand(command);
  }));

  ipcMain.handle('settings:saveNotifications', wrapHandler('settings:saveNotifications', async (_event, { notifications } = {}) => {
    const saved = setNotificationSettings(notifications || {});
    return { ok: true, notifications: saved };
  }));

  ipcMain.handle('settings:saveDefaults', wrapHandler('settings:saveDefaults', async (_event, { defaults } = {}) => {
    const settings = getSettings();
    const merged = {
      ...(settings.defaults || {}),
      ...(defaults || {})
    };
    // Only allow known keys
    const sanitized = {
      agentMode: !!merged.agentMode,
      sandboxMode: merged.sandboxMode !== false
    };
    setSettings({ ...settings, defaults: sanitized });
    return { ok: true, defaults: sanitized };
  }));

  ipcMain.handle('settings:addAllowedDirectory', wrapHandler('settings:addAllowedDirectory', async () => {
    const { dialog } = require('electron');
    const getMainWindow = context.getMainWindow;
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Add Allowed Directory'
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dir = result.filePaths[0];
    const settings = getSettings();
    const dirs = Array.isArray(settings.allowedDirectories) ? [...settings.allowedDirectories] : [];
    if (!dirs.includes(dir)) {
      dirs.push(dir);
    }
    settings.allowedDirectories = dirs;
    setSettings(settings);
    return { ok: true, allowedDirectories: dirs };
  }));

  ipcMain.handle('settings:removeAllowedDirectory', wrapHandler('settings:removeAllowedDirectory', async (_event, { directory } = {}) => {
    const settings = getSettings();
    const dirs = Array.isArray(settings.allowedDirectories) ? settings.allowedDirectories.filter((d) => d !== directory) : [];
    settings.allowedDirectories = dirs;
    setSettings(settings);
    return { ok: true, allowedDirectories: dirs };
  }));

  // --- Anthropic OAuth handlers ---

  ipcMain.handle('settings:anthropicOAuthStatus', wrapHandler('settings:anthropicOAuthStatus', async () => {
    if (!anthropicOAuth) {
      return { connected: false };
    }
    return anthropicOAuth.getStatus();
  }));

  ipcMain.handle('settings:anthropicOAuthStart', wrapHandler('settings:anthropicOAuthStart', async () => {
    if (!anthropicOAuth) {
      return { ok: false, error: 'OAuth handler not available.' };
    }

    if (!anthropicOAuth.clientId) {
      return { ok: false, error: 'Anthropic OAuth Client ID is not configured. Please set it first.' };
    }

    try {
      const result = await anthropicOAuth.startAuthFlow();
      const status = updateStatus('anthropic', {
        ok: true,
        message: 'Connected via OAuth (Max subscription)'
      });
      notifyKeyChanged('anthropic');
      return { ok: true, status, expiresAt: result.expiresAt };
    } catch (err) {
      return { ok: false, error: err.message || 'OAuth flow failed.' };
    }
  }));

  ipcMain.handle('settings:anthropicOAuthDisconnect', wrapHandler('settings:anthropicOAuthDisconnect', async () => {
    if (!anthropicOAuth) {
      return { ok: false, error: 'OAuth handler not available.' };
    }

    anthropicOAuth.clearStoredTokens();
    notifyKeyChanged('anthropic');
    return { ok: true };
  }));

  ipcMain.handle('settings:anthropicOAuthSaveClientId', wrapHandler('settings:anthropicOAuthSaveClientId', async (_event, { clientId } = {}) => {
    const id = String(clientId || '').trim();
    if (!id) {
      return { ok: false, error: 'Client ID is required.' };
    }

    const { store } = anthropicOAuth;
    store.set('anthropicOAuthClientId', id);
    anthropicOAuth.clientId = id;
    return { ok: true };
  }));

  ipcMain.handle('settings:anthropicOAuthGetClientId', wrapHandler('settings:anthropicOAuthGetClientId', async () => {
    if (!anthropicOAuth) {
      return { ok: true, clientId: '' };
    }
    return { ok: true, clientId: anthropicOAuth.clientId || '' };
  }));

  // ── Vault ────────────────────────────────────────────────
  const VAULT_PREFIX = '__vault_';
  let _vaultStore = context.vaultStore || null;
  const getVaultStore = () => {
    if (_vaultStore) return _vaultStore;
    const { default: Store } = require('electron-store');
    _vaultStore = new Store();
    return _vaultStore;
  };

  ipcMain.handle('settings:vaultList', wrapHandler('settings:vaultList', async () => {
    const allKeys = Object.keys(getVaultStore().store || {});
    const vaultKeys = allKeys
      .filter((k) => k.startsWith(VAULT_PREFIX))
      .map((k) => k.slice(VAULT_PREFIX.length));
    return { ok: true, keys: vaultKeys, count: vaultKeys.length };
  }));

  ipcMain.handle('settings:vaultStore', wrapHandler('settings:vaultStore', async (_event, { key, value } = {}) => {
    if (!key || typeof key !== 'string') return { ok: false, error: 'Key is required.' };
    if (!value || typeof value !== 'string') return { ok: false, error: 'Value is required.' };
    if (!encryptToken) return { ok: false, error: 'Encryption unavailable.' };
    const encrypted = encryptToken(value);
    getVaultStore().set(`${VAULT_PREFIX}${key.trim()}`, encrypted);
    return { ok: true, message: `Secret "${key.trim()}" saved.` };
  }));

  ipcMain.handle('settings:vaultDelete', wrapHandler('settings:vaultDelete', async (_event, { key } = {}) => {
    if (!key || typeof key !== 'string') return { ok: false, error: 'Key is required.' };
    const storeKey = `${VAULT_PREFIX}${key}`;
    if (!getVaultStore().has(storeKey)) return { ok: false, error: `No secret found for "${key}".` };
    getVaultStore().delete(storeKey);
    return { ok: true, message: `Secret "${key}" deleted.` };
  }));

  ipcMain.handle('settings:vaultUpdate', wrapHandler('settings:vaultUpdate', async (_event, { oldKey, newKey, value } = {}) => {
    if (!oldKey || typeof oldKey !== 'string') return { ok: false, error: 'Old key is required.' };
    if (!newKey || typeof newKey !== 'string') return { ok: false, error: 'New key is required.' };
    const oldStoreKey = `${VAULT_PREFIX}${oldKey}`;
    const newStoreKey = `${VAULT_PREFIX}${newKey.trim()}`;

    if (value && typeof value === 'string') {
      // Update both key name and value
      if (!encryptToken) return { ok: false, error: 'Encryption unavailable.' };
      if (oldStoreKey !== newStoreKey) getVaultStore().delete(oldStoreKey);
      getVaultStore().set(newStoreKey, encryptToken(value));
    } else if (oldStoreKey !== newStoreKey) {
      // Rename key only — move the encrypted blob
      const existing = getVaultStore().get(oldStoreKey);
      if (!existing) return { ok: false, error: `No secret found for "${oldKey}".` };
      getVaultStore().set(newStoreKey, existing);
      getVaultStore().delete(oldStoreKey);
    }

    return { ok: true, message: `Secret updated.` };
  }));

  // ── MCP Servers ──────────────────────────────────────────
  // Storage: settings.mcpServers = { [name]: { command, args, env, cwd } }
  // Env values may contain ${vault:key} references (expanded at connect time).

  const getMcpManager = typeof context.getMcpManager === 'function' ? context.getMcpManager : () => null;

  const sanitizeServer = (raw = {}) => ({
    command: String(raw.command || '').trim(),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: (raw.env && typeof raw.env === 'object') ? Object.fromEntries(
      Object.entries(raw.env).map(([k, v]) => [String(k), String(v)])
    ) : {},
    cwd: raw.cwd ? String(raw.cwd) : undefined
  });

  ipcMain.handle('settings:mcpList', wrapHandler('settings:mcpList', async () => {
    const settings = getSettings();
    const servers = settings.mcpServers || {};
    const mgr = getMcpManager();
    const status = mgr ? mgr.getStatus() : {};

    const list = Object.entries(servers).map(([name, cfg]) => ({
      name,
      command: cfg.command || '',
      args: cfg.args || [],
      env: cfg.env || {},
      cwd: cfg.cwd || '',
      connected: Boolean(status[name]?.connected),
      tools: status[name]?.tools || []
    }));

    return { ok: true, servers: list };
  }));

  ipcMain.handle('settings:mcpSave', wrapHandler('settings:mcpSave', async (_event, { name, server, oldName } = {}) => {
    if (!name || typeof name !== 'string') return { ok: false, error: 'Server name is required.' };
    const trimmedName = name.trim();
    if (!trimmedName) return { ok: false, error: 'Server name cannot be empty.' };

    const clean = sanitizeServer(server);
    if (!clean.command) return { ok: false, error: 'Command is required.' };

    const settings = getSettings();
    const servers = { ...(settings.mcpServers || {}) };

    // Rename: remove old entry if it differs
    if (oldName && oldName !== trimmedName) {
      delete servers[oldName];
    }
    servers[trimmedName] = clean;
    setSettings({ ...settings, mcpServers: servers });

    // Hot-reconnect the server
    const mgr = getMcpManager();
    if (mgr) {
      try {
        if (oldName && oldName !== trimmedName) {
          await mgr.disconnectServer(oldName);
        }
        await mgr.connectServer(trimmedName, clean);
      } catch (err) {
        return { ok: true, message: `Saved "${trimmedName}" but connection failed: ${err.message}`, connectError: err.message };
      }
    }

    return { ok: true, message: `MCP server "${trimmedName}" saved.` };
  }));

  ipcMain.handle('settings:mcpDelete', wrapHandler('settings:mcpDelete', async (_event, { name } = {}) => {
    if (!name || typeof name !== 'string') return { ok: false, error: 'Server name is required.' };

    const settings = getSettings();
    const servers = { ...(settings.mcpServers || {}) };
    if (!servers[name]) return { ok: false, error: `No MCP server named "${name}".` };
    delete servers[name];
    setSettings({ ...settings, mcpServers: servers });

    const mgr = getMcpManager();
    if (mgr) {
      await mgr.disconnectServer(name).catch(() => {});
    }

    return { ok: true, message: `MCP server "${name}" deleted.` };
  }));

  ipcMain.handle('settings:mcpReload', wrapHandler('settings:mcpReload', async (_event, { name } = {}) => {
    const mgr = getMcpManager();
    if (!mgr) return { ok: false, error: 'MCP manager is not initialized.' };

    const settings = getSettings();
    const servers = settings.mcpServers || {};

    if (name) {
      const cfg = servers[name];
      if (!cfg) return { ok: false, error: `No MCP server named "${name}".` };
      try {
        await mgr.connectServer(name, cfg);
        const status = mgr.getStatus()[name];
        return { ok: true, message: `Reconnected "${name}".`, tools: status?.tools || [] };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // Reload all
    await mgr.disconnectAll();
    const results = await mgr.connectAll(servers);
    return { ok: true, results };
  }));
}

module.exports = {
  registerSettingsHandlers
};
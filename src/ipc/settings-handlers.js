const { wrapHandler } = require('./wrap-handler');
const { applyActiveProviderUpdate } = require('./settings-provider');

function registerSettingsHandlers(ipcMain, context = {}) {
  const {
    safeStorage,
    getApiTokens,
    getApiStatus,
    getSettings,
    providerLabels,
    providerDefaults,
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
    setActiveInferenceTier,
    setNotificationSettings,
    getMainWindow
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

  const applyActiveProvider = context.applyActiveProviderUpdate || applyActiveProviderUpdate;

  ipcMain.handle('settings:load', wrapHandler('settings:load', async () => {
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
      activeProvider: settings.activeProvider || 'openai',
      inference: settings.inference,
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

  ipcMain.handle('settings:setActiveProvider', wrapHandler('settings:setActiveProvider', async (_event, { provider }) => {
    return applyActiveProvider({
      provider,
      providerLabels,
      getSettings,
      setSettings,
      resetRuntimeEnvironmentCache
    });
  }));

  ipcMain.handle('settings:setProviderModel', wrapHandler('settings:setProviderModel', async (_event, { provider, model }) => {
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
  }));

  ipcMain.handle('settings:saveProvider', wrapHandler('settings:saveProvider', async (_event, { provider, token, clear }) => {
    if (!providerLabels[provider]) {
      return { ok: false, error: 'Unknown provider.' };
    }

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
  }));

  ipcMain.handle('settings:testProvider', wrapHandler('settings:testProvider', async (_event, { provider }) => {
    if (!providerLabels[provider]) {
      return { ok: false, error: 'Unknown provider.' };
    }

    // For Anthropic, allow testing via OAuth even without a stored API key
    const isAnthropicOAuth = provider === 'anthropic' && anthropicOAuth && anthropicOAuth.isConnected();

    const tokens = getApiTokens();
    if (!tokens[provider] && !isAnthropicOAuth) {
      return { ok: false, error: 'No token saved for this provider.' };
    }

    const token = isAnthropicOAuth ? null : decryptToken(tokens[provider]);

    let response;
    if (provider === 'openai') {
      response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${token}` }
      });
    } else if (provider === 'anthropic' && isAnthropicOAuth) {
      const oauthToken = await anthropicOAuth.getValidAccessToken();
      response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${oauthToken}`,
          'anthropic-version': '2023-06-01'
        }
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
    } else if (provider === 'groq') {
      response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${token}` }
      });
    } else if (provider === 'mistral') {
      response = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${token}` }
      });
    } else if (provider === 'ollama') {
      response = await fetch('http://localhost:11434/api/tags');
    } else if (provider === 'gemini') {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${token}`);
    } else if (provider === 'openrouter') {
      response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${token}`,
          'HTTP-Referer': 'king-louie',
          'X-Title': 'King Louie'
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
  }));

  ipcMain.handle('settings:runLlmCommand', wrapHandler('settings:runLlmCommand', async (_event, { command }) => {
    return runLlmCommand(command);
  }));

  ipcMain.handle('settings:setInferenceTier', wrapHandler('settings:setInferenceTier', async (_event, { tier }) => {
    const inference = setActiveInferenceTier(tier);
    return { ok: true, inference };
  }));

  ipcMain.handle('settings:listModels', wrapHandler('settings:listModels', async (_event, { provider } = {}) => {
    if (!provider) {
      return { ok: false, error: 'Provider is required.' };
    }

    const ProviderFactory = require('../providers/provider-factory');
    const registeredProviders = ProviderFactory.listRegistered();
    if (!registeredProviders.includes(provider)) {
      return { ok: false, error: 'Unknown provider.' };
    }

    const tokens = getApiTokens();
    const encryptedToken = tokens[provider];
    let token = encryptedToken ? decryptToken(encryptedToken) : null;
    let authMode = 'api-key';

    // For Anthropic, use OAuth token if connected and no API key
    if (provider === 'anthropic' && !token && anthropicOAuth && anthropicOAuth.isConnected()) {
      try {
        token = await anthropicOAuth.getValidAccessToken();
        authMode = 'oauth';
      } catch { /* fall through to static list */ }
    }

    // Try API-based listing first (ollama needs no token)
    if (token || provider === 'ollama') {
      try {
        const instance = ProviderFactory.create(provider, token || 'ollama-local', { authMode });
        const models = await instance.listModels();
        return { ok: true, models, source: 'api' };
      } catch (err) { console.debug('[settings] listModels API failed, falling back to static:', err.message); }
    }

    // Fall back to static model list
    try {
      const instance = ProviderFactory.create(provider, 'static-fallback');
      const models = instance.getModels();
      return { ok: true, models, source: 'static' };
    } catch {
      return { ok: false, error: 'Unable to list models for this provider.' };
    }
  }));

  ipcMain.handle('settings:setTierProviderModel', wrapHandler('settings:setTierProviderModel', async (_event, { tier, provider, model } = {}) => {
    const normalizedTier = String(tier || '').toLowerCase();
    if (!['fast', 'standard', 'smart'].includes(normalizedTier)) {
      return { ok: false, error: 'Invalid tier.' };
    }

    const settings = getSettings();
    const tierMap = { ...(settings.inference?.tierMap || {}) };
    const current = tierMap[normalizedTier] || {};

    tierMap[normalizedTier] = {
      ...current,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {})
    };

    const updated = {
      ...settings,
      inference: {
        ...(settings.inference || {}),
        tierMap
      }
    };

    setSettings(updated);
    return { ok: true, inference: updated.inference };
  }));

  ipcMain.handle('settings:saveSmartRouting', wrapHandler('settings:saveSmartRouting', async (_event, { enabled } = {}) => {
    const settings = getSettings();
    const smartRouting = {
      ...(settings.inference?.smartRouting || {}),
      enabled: !!enabled
    };
    const updated = {
      ...settings,
      inference: { ...(settings.inference || {}), smartRouting }
    };
    setSettings(updated);
    return { ok: true, smartRouting };
  }));

  ipcMain.handle('settings:saveSmartRoutingRules', wrapHandler('settings:saveSmartRoutingRules', async (_event, { rules } = {}) => {
    const { validateRule } = require('../providers/smart-routing');
    if (!Array.isArray(rules)) {
      return { ok: false, error: 'Rules must be an array.' };
    }
    for (const rule of rules) {
      const check = validateRule(rule);
      if (!check.valid) {
        return { ok: false, error: `Rule "${rule.name || '?'}": ${check.errors.join(', ')}` };
      }
    }
    const settings = getSettings();
    const smartRouting = {
      ...(settings.inference?.smartRouting || {}),
      rules
    };
    const updated = {
      ...settings,
      inference: { ...(settings.inference || {}), smartRouting }
    };
    setSettings(updated);
    return { ok: true, smartRouting };
  }));

  ipcMain.handle('settings:saveLlmRouting', wrapHandler('settings:saveLlmRouting', async (_event, payload = {}) => {
    const allowedSensitivity = new Set(['low', 'medium', 'high']);
    const settings = getSettings();
    const current = settings.inference?.llmRouting || {};
    const llmRouting = {
      enabled: Boolean(payload.enabled),
      costSensitivity: allowedSensitivity.has(payload.costSensitivity) ? payload.costSensitivity : (current.costSensitivity || 'medium'),
      speedPriority: allowedSensitivity.has(payload.speedPriority) ? payload.speedPriority : (current.speedPriority || 'medium'),
      qualityPriority: allowedSensitivity.has(payload.qualityPriority) ? payload.qualityPriority : (current.qualityPriority || 'high')
    };
    const updated = {
      ...settings,
      inference: { ...(settings.inference || {}), llmRouting }
    };
    setSettings(updated);
    return { ok: true, llmRouting };
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
  const Store = require('electron-store');
  const vaultStore = new Store();

  ipcMain.handle('settings:vaultList', wrapHandler('settings:vaultList', async () => {
    const allKeys = Object.keys(vaultStore.store || {});
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
    vaultStore.set(`${VAULT_PREFIX}${key.trim()}`, encrypted);
    return { ok: true, message: `Secret "${key.trim()}" saved.` };
  }));

  ipcMain.handle('settings:vaultDelete', wrapHandler('settings:vaultDelete', async (_event, { key } = {}) => {
    if (!key || typeof key !== 'string') return { ok: false, error: 'Key is required.' };
    const storeKey = `${VAULT_PREFIX}${key}`;
    if (!vaultStore.has(storeKey)) return { ok: false, error: `No secret found for "${key}".` };
    vaultStore.delete(storeKey);
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
      if (oldStoreKey !== newStoreKey) vaultStore.delete(oldStoreKey);
      vaultStore.set(newStoreKey, encryptToken(value));
    } else if (oldStoreKey !== newStoreKey) {
      // Rename key only — move the encrypted blob
      const existing = vaultStore.get(oldStoreKey);
      if (!existing) return { ok: false, error: `No secret found for "${oldKey}".` };
      vaultStore.set(newStoreKey, existing);
      vaultStore.delete(oldStoreKey);
    }

    return { ok: true, message: `Secret updated.` };
  }));
}

module.exports = {
  registerSettingsHandlers
};
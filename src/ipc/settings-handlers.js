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
      allowedDirectories: settings.allowedDirectories || []
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
    const token = encryptedToken ? decryptToken(encryptedToken) : null;

    // Try API-based listing first (ollama needs no token)
    if (token || provider === 'ollama') {
      try {
        const instance = ProviderFactory.create(provider, token || 'ollama-local');
        const models = await instance.listModels();
        return { ok: true, models, source: 'api' };
      } catch { /* fall through to static */ }
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
}

module.exports = {
  registerSettingsHandlers
};
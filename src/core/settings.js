const {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings
} = require('../notifications/notification-router');
const { DEFAULT_VOICE_SETTINGS } = require('../voice/tts-engine');

const DEFAULT_SETTINGS = {
  defaults: {
    agentMode: false,
    sandboxMode: true
  },
  // Transparent per-turn filesystem snapshots so a turn's file edits can be
  // rolled back. Off by default until the UI affordance ships; the store is
  // never created while disabled.
  checkpoints: {
    enabled: false,
    maxAgeDays: 14
  },
  activeProvider: 'openai',
  templateVariables: {
    name: '',
    role: '',
    preferences: '',
    projectContext: ''
  },
  providerModels: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-20250514',
    copilot: 'gpt-4o',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
    ollama: '',
    gemini: 'gemini-2.0-flash',
    openrouter: 'openai/gpt-4o-mini',
    xai: 'grok-3-mini',
    deepseek: 'deepseek-chat',
    qwen: 'qwen-plus',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    cohere: 'command-r-plus'
  },
  inference: {
    activeTier: 'standard',
    tierMap: {
      fast: {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile'
      },
      standard: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514'
      },
      smart: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514'
      }
    },
    timeoutsMs: {
      fast: 15000,
      standard: 30000,
      smart: 90000
    },
    smartRouting: {
      enabled: false,
      rules: []
    },
    llmRouting: {
      enabled: false,
      costSensitivity: 'medium',
      speedPriority: 'medium',
      qualityPriority: 'high'
    }
  },
  notifications: {
    ...DEFAULT_NOTIFICATION_SETTINGS
  },
  voice: {
    ...DEFAULT_VOICE_SETTINGS
  },
  hooks: {
    enabled: true,
    hookStates: {}
  },
  allowedDirectories: [],
  webSearch: {
    brave: { apiKey: '' },
    tavily: { apiKey: '' }
  },
  imageGeneration: {
    defaultProvider: 'openai',
    fal: { apiKey: '' }
  },
  channels: {
    telegram: {
      requireMention: false
    },
    discord: {
      enabled: false,
      requireMention: false,
      allowedGuilds: [],
    },
    slack: {
      enabled: false,
      requireMention: true,
      allowedChannels: []
    }
  }
};

const mergeSettings = (settings = {}) => {
  const source = settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    defaults: {
      ...(DEFAULT_SETTINGS.defaults || {}),
      ...(source.defaults || {})
    },
    checkpoints: {
      ...(DEFAULT_SETTINGS.checkpoints || {}),
      ...(source.checkpoints || {})
    },
    templateVariables: {
      ...(DEFAULT_SETTINGS.templateVariables || {}),
      ...(source.templateVariables || {})
    },
    providerModels: {
      ...(DEFAULT_SETTINGS.providerModels || {}),
      ...(source.providerModels || {})
    },
    inference: {
      ...(DEFAULT_SETTINGS.inference || {}),
      ...(source.inference || {}),
      tierMap: {
        ...(DEFAULT_SETTINGS.inference?.tierMap || {}),
        ...(source.inference?.tierMap || {})
      },
      timeoutsMs: {
        ...(DEFAULT_SETTINGS.inference?.timeoutsMs || {}),
        ...(source.inference?.timeoutsMs || {})
      },
      smartRouting: {
        ...(DEFAULT_SETTINGS.inference?.smartRouting || {}),
        ...(source.inference?.smartRouting || {}),
        rules: Array.isArray(source.inference?.smartRouting?.rules)
          ? source.inference.smartRouting.rules
          : (DEFAULT_SETTINGS.inference?.smartRouting?.rules || [])
      }
    },
    notifications: normalizeNotificationSettings({
      ...(DEFAULT_SETTINGS.notifications || {}),
      ...(source.notifications || {})
    }),
    voice: {
      ...(DEFAULT_SETTINGS.voice || {}),
      ...(source.voice || {})
    },
    hooks: {
      ...(DEFAULT_SETTINGS.hooks || {}),
      ...(source.hooks || {}),
      hookStates: {
        ...(DEFAULT_SETTINGS.hooks?.hookStates || {}),
        ...(source.hooks?.hookStates || {})
      }
    },
    allowedDirectories: Array.isArray(source.allowedDirectories) ? source.allowedDirectories : (DEFAULT_SETTINGS.allowedDirectories || []),
    webSearch: {
      ...(DEFAULT_SETTINGS.webSearch || {}),
      ...(source.webSearch || {}),
      brave: {
        ...(DEFAULT_SETTINGS.webSearch?.brave || {}),
        ...(source.webSearch?.brave || {})
      },
      tavily: {
        ...(DEFAULT_SETTINGS.webSearch?.tavily || {}),
        ...(source.webSearch?.tavily || {})
      }
    },
    imageGeneration: {
      ...(DEFAULT_SETTINGS.imageGeneration || {}),
      ...(source.imageGeneration || {}),
      fal: {
        ...(DEFAULT_SETTINGS.imageGeneration?.fal || {}),
        ...(source.imageGeneration?.fal || {})
      }
    },
    channels: {
      ...(DEFAULT_SETTINGS.channels || {}),
      ...(source.channels || {}),
      telegram: {
        ...(DEFAULT_SETTINGS.channels?.telegram || {}),
        ...(source.channels?.telegram || {})
      },
      discord: {
        ...(DEFAULT_SETTINGS.channels?.discord || {}),
        ...(source.channels?.discord || {})
      },
      slack: {
        ...(DEFAULT_SETTINGS.channels?.slack || {}),
        ...(source.channels?.slack || {})
      }
    }
  };
};

module.exports = { DEFAULT_SETTINGS, mergeSettings };

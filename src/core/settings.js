const {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings
} = require('../notifications/notification-router');
const { DEFAULT_VOICE_SETTINGS } = require('../voice/tts-engine');
const { CATALOG_DEFAULTS } = require('../models/catalog');
const { DEFAULT_OLLAMA_BASE_URL } = require('../models/provider-ids');
const { DEFAULT_ROLE_TIMEOUTS_MS } = require('../models/roles');
const { mergeKingLouieSettings } = require('../models/suggester');
const { mergeHistorySettings } = require('../history/settings');

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
  // Case repositories (docs/superpowers/specs/2026-09-22-king-louie-cases-design.md).
  // Empty root means KL_CASES_ROOT, else <dataDir>/cases.
  cases: {
    root: ''
  },
  // Cases stage 6: allowed playbook sources (URL prefixes and path:<folder>
  // roots; example: is always allowed) and same-major auto-update.
  playbooks: { sources: [], autoUpdate: false },
  // Chat history and recall (spec 2026-09-25 §14, stage H2).
  history: mergeHistorySettings({}),
  templateVariables: {
    name: '',
    role: '',
    preferences: '',
    projectContext: ''
  },
  // Model catalog, availability and profiles (spec 2026-09-27 §14).
  models: {
    catalog: { ...CATALOG_DEFAULTS },
    overrides: {},
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL },
    availability: { retestHours: 24 },
    profiles: [],
    defaultProfileId: null,
    customRoles: [],
    roleTimeoutsMs: { ...DEFAULT_ROLE_TIMEOUTS_MS },
    // The explorer's summary cap (spec §8.1).
    explorer: { summaryMaxTokens: 2000 },
    // The King Louie profile's picking thresholds and state (spec §7, §14).
    kingLouie: mergeKingLouieSettings({})
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
    // Cases stage 2 keys (budgets, roles, wakeups…) merge key by key over
    // their defaults (src/cases/defaults.js).
    cases: require('../cases/defaults').mergeCaseSettings(DEFAULT_SETTINGS.cases, source.cases),
    // Cases stage 3: settings.executors, merged key by key over its defaults.
    executors: require('../cases/executors/defaults').mergeExecutorSettings(null, source.executors),
    // Recall stage H2: settings.history, type-checked key by key.
    history: mergeHistorySettings(source.history),
    templateVariables: {
      ...(DEFAULT_SETTINGS.templateVariables || {}),
      ...(source.templateVariables || {})
    },
    models: {
      ...(DEFAULT_SETTINGS.models || {}),
      ...(source.models || {}),
      catalog: {
        ...DEFAULT_SETTINGS.models.catalog,
        ...(source.models?.catalog || {})
      },
      overrides: source.models?.overrides && typeof source.models.overrides === 'object' && !Array.isArray(source.models.overrides)
        ? source.models.overrides
        : {},
      ollama: {
        ...DEFAULT_SETTINGS.models.ollama,
        ...(source.models?.ollama || {})
      },
      availability: {
        ...DEFAULT_SETTINGS.models.availability,
        ...(source.models?.availability || {})
      },
      profiles: Array.isArray(source.models?.profiles) ? source.models.profiles : [],
      defaultProfileId: typeof source.models?.defaultProfileId === 'string' && source.models.defaultProfileId
        ? source.models.defaultProfileId
        : null,
      customRoles: Array.isArray(source.models?.customRoles) ? source.models.customRoles : [],
      roleTimeoutsMs: {
        ...DEFAULT_SETTINGS.models.roleTimeoutsMs,
        ...(source.models?.roleTimeoutsMs && typeof source.models.roleTimeoutsMs === 'object' && !Array.isArray(source.models.roleTimeoutsMs)
          ? source.models.roleTimeoutsMs
          : {})
      },
      explorer: {
        ...DEFAULT_SETTINGS.models.explorer,
        ...(source.models?.explorer && typeof source.models.explorer === 'object' && !Array.isArray(source.models.explorer)
          ? source.models.explorer
          : {})
      },
      kingLouie: mergeKingLouieSettings(source.models?.kingLouie)
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
    },
    // Cases stage 4: contactPolicy, contact, and channels.* with the contact keys
    // (src/cases/contact-settings.js). Replaces `channels` with a superset.
    ...require('../cases/contact-settings').mergeContactSettings(source, DEFAULT_SETTINGS.channels)
  };
};

const CHAT_DATA_DEFAULTS = {
  chats: [],
  activeChatId: null,
  apiTokens: {},
  apiStatus: {},
  settings: {
    ...DEFAULT_SETTINGS
  },
  toolApprovals: {
    alwaysApproveTools: {}
  }
};

module.exports = { DEFAULT_SETTINGS, mergeSettings, CHAT_DATA_DEFAULTS };

const { contextBridge, ipcRenderer } = require('electron');

let domPurify = null;
try {
  const createDOMPurify = require('dompurify');
  if (typeof window !== 'undefined') {
    domPurify = createDOMPurify(window);
  }
} catch {
  domPurify = null;
}

let hljs = null;
try {
  hljs = require('highlight.js');
} catch {
  hljs = null;
}

let markdownParser = null;
try {
  const markedModule = require('marked');
  markdownParser = markedModule.marked || markedModule;

  if (markdownParser && hljs) {
    const renderer = {
      code({ text, lang }) {
        const validLang = lang && hljs.getLanguage(lang) ? lang : null;
        const highlighted = validLang
          ? hljs.highlight(text, { language: validLang }).value
          : hljs.highlightAuto(text).value;
        const langClass = validLang ? ` language-${validLang}` : '';
        return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
      }
    };
    markdownParser.use({ renderer });
  }
} catch {
  markdownParser = null;
}

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const formatInlineMarkdown = (text = '') =>
  String(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

const simpleMarkdownFallback = (text = '') => {
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  let listBuffer = [];

  const flushList = () => {
    if (!listBuffer.length) return;
    chunks.push(`<ul>${listBuffer.map((item) => `<li>${item}</li>`).join('')}</ul>`);
    listBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith('- ')) {
      listBuffer.push(formatInlineMarkdown(escapeHtml(line.slice(2))));
      continue;
    }

    flushList();

    if (line.startsWith('### ')) {
      chunks.push(`<h3>${formatInlineMarkdown(escapeHtml(line.slice(4)))}</h3>`);
      continue;
    }

    chunks.push(`<p>${formatInlineMarkdown(escapeHtml(line))}</p>`);
  }

  flushList();
  return chunks.join('');
};

const DOMPURIFY_CONFIG = {
  ADD_ATTR: ['class'],
  ADD_TAGS: ['span'],
};

const safeMarkdownParse = (text) => {
  const input = text || '';
  const sanitize = (html) => {
    if (!domPurify || typeof domPurify.sanitize !== 'function') {
      return String(html || '');
    }

    return domPurify.sanitize(String(html || ''), DOMPURIFY_CONFIG);
  };

  try {
    if (markdownParser?.parse && typeof markdownParser.parse === 'function') {
      return sanitize(markdownParser.parse(input));
    }

    if (typeof markdownParser === 'function') {
      return sanitize(markdownParser(input));
    }
  } catch {
    // Fall through to plain-text HTML
  }

  return sanitize(simpleMarkdownFallback(input));
};

const sanitizeHtml = (text) => {
  if (!domPurify || typeof domPurify.sanitize !== 'function') {
    return String(text || '');
  }

  return domPurify.sanitize(String(text || ''));
};

const validateString = (value, fieldName, { minLength = 0 } = {}) => {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected string`);
  }
  if (value.trim().length < minLength) {
    throw new Error(`Invalid ${fieldName}: must be at least ${minLength} character(s)`);
  }
};

const validateObject = (value, fieldName) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected object`);
  }
};

const VALID_SENDERS = new Set(['user', 'assistant', 'system', 'tool']);
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const knownProviders = new Set(['openai', 'anthropic', 'copilot']);

const validateSettingsSaveProviderPayload = (payload = {}) => {
  validateObject(payload, 'payload');
  const provider = String(payload.provider || '').trim().toLowerCase();
  if (!knownProviders.has(provider)) {
    throw new Error('Invalid provider');
  }
  if (!payload.clear) {
    validateString(payload.token, 'token');
  }
};

const validateSettingsRunLlmPayload = (payload = {}) => {
  validateObject(payload, 'payload');
  validateString(payload.command, 'command', { minLength: 1 });
};

const validateSkillExecutePayload = (payload = {}) => {
  validateObject(payload, 'payload');
  validateString(payload.command, 'command', { minLength: 1 });
};

const validateToolExecutePayload = (toolName, parameters) => {
  validateString(toolName, 'toolName', { minLength: 1 });
  validateObject(parameters || {}, 'parameters');
};

const validateImagesPayload = (images) => {
  if (images == null) return;
  if (!Array.isArray(images)) {
    throw new Error('Invalid images: expected array');
  }
  if (images.length > 5) {
    throw new Error('Invalid images: maximum 5 images per message');
  }

  for (const image of images) {
    validateObject(image, 'image');
    validateString(image.base64, 'image.base64', { minLength: 1 });
    validateString(image.mimeType, 'image.mimeType', { minLength: 1 });
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(String(image.mimeType).toLowerCase())) {
      throw new Error(`Invalid image.mimeType: unsupported type ${image.mimeType}`);
    }
  }
};

const lastCallByKey = new Map();
const throttleInvoke = (key, fn, delayMs = 1000) => {
  const now = Date.now();
  const last = Number(lastCallByKey.get(key) || 0);
  if (now - last < delayMs) {
    return Promise.resolve({ ok: false, error: 'Too many requests' });
  }
  lastCallByKey.set(key, now);
  if (typeof fn === 'function') {
    return fn();
  }
  return Promise.resolve({ ok: false, error: 'fn is not a function' });
};

const registeredListeners = new Map();
const registerOnce = (channel, callback, transform = (value) => value) => {
  if (typeof callback !== 'function') {
    return () => {};
  }

  const current = registeredListeners.get(channel);
  if (current?.original === callback) {
    return current.unsubscribe;
  }

  if (current?.wrapped) {
    ipcRenderer.removeListener(channel, current.wrapped);
  }

  const wrapped = (_event, data) => callback(transform(data));
  ipcRenderer.on(channel, wrapped);
  const unsubscribe = () => {
    const latest = registeredListeners.get(channel);
    if (latest?.wrapped) {
      ipcRenderer.removeListener(channel, latest.wrapped);
    }
    registeredListeners.delete(channel);
  };

  registeredListeners.set(channel, {
    original: callback,
    wrapped,
    unsubscribe
  });

  return unsubscribe;
};

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
  'electron',
  {
    chat: {
      load: () => ipcRenderer.invoke('chat:load'),
      create: (title) => ipcRenderer.invoke('chat:create', title),
      setActive: (chatId) => ipcRenderer.invoke('chat:setActive', chatId),
      setAgentMode: (chatId, agentMode) => {
        validateString(chatId, 'chatId');
        return ipcRenderer.invoke('chat:setAgentMode', { chatId, agentMode: !!agentMode });
      },
      rename: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId');
        validateString(payload.name, 'name', { minLength: 1 });
        if (payload.name.length > 200) {
          throw new Error('Invalid name: must be 200 characters or fewer');
        }
        return ipcRenderer.invoke('chat:rename', payload);
      },
      remove: (chatId) => {
        validateString(chatId, 'chatId');
        return ipcRenderer.invoke('chat:delete', chatId);
      },
      setWorkingDirectory: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId');
        return ipcRenderer.invoke('chat:setWorkingDirectory', payload);
      },
      pickWorkingDirectory: (chatId) => {
        validateString(chatId, 'chatId');
        return ipcRenderer.invoke('chat:pickWorkingDirectory', { chatId });
      },
      addMessage: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId');
        validateString(payload.text, 'text');
        if (!VALID_SENDERS.has(payload.sender)) {
          throw new Error('Invalid sender: must be one of user, assistant, system, tool');
        }
        return ipcRenderer.invoke('chat:addMessage', payload);
      },
      speakLast: (payload) => ipcRenderer.invoke('chat:speakLast', payload),
      sendMessage: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId');
        if (payload.message != null && typeof payload.message !== 'string') {
          throw new Error('Invalid message: expected string');
        }
        validateImagesPayload(payload.images);
        const hasText = typeof payload.message === 'string' && payload.message.trim().length > 0;
        const hasImages = Array.isArray(payload.images) && payload.images.length > 0;
        if (!hasText && !hasImages) {
          throw new Error('Invalid payload: expected non-empty message or at least one image');
        }
        return ipcRenderer.invoke('chat:sendMessage', payload);
      },
      stopResponse: (chatId) => {
        validateString(chatId, 'chatId');
        return ipcRenderer.invoke('chat:stopResponse', { chatId });
      },
      onMessageStart: (callback) => registerOnce('chat:messageStart', callback),
      onMessageChunk: (callback) => registerOnce('chat:messageChunk', callback),
      onMessageComplete: (callback) => registerOnce('chat:messageComplete', callback),
      onMessageError: (callback) => registerOnce('chat:messageError', callback),
      onToolUse: (callback) => registerOnce('chat:toolUse', callback),
      onToolResult: (callback) => registerOnce('chat:toolResult', callback),
      onChatUpdated: (callback) => registerOnce('chat:updated', callback)
    },
    tool: {
      list: () => ipcRenderer.invoke('tool:list'),
      execute: (toolName, parameters) => {
        validateToolExecutePayload(toolName, parameters);
        return throttleInvoke('tool:execute', () => ipcRenderer.invoke('tool:execute', { toolName, parameters }));
      },
      onApprovalRequired: (callback) => registerOnce('tool:approvalRequired', callback),
      respondToApproval: (approvalId, approved, options = {}) =>
        ipcRenderer.send('tool:approvalResponse', { approvalId, approved, ...options })
    },
    task: {
      create: (config) => ipcRenderer.invoke('task:create', config),
      list: () => ipcRenderer.invoke('task:list'),
      update: (payload) => ipcRenderer.invoke('task:update', payload),
      onCreated: (callback) => registerOnce('task:created', callback),
      onUpdated: (callback) => registerOnce('task:updated', callback),
      onUnblocked: (callback) => registerOnce('task:unblocked', callback)
    },
    agent: {
      list: () => ipcRenderer.invoke('agent:list'),
      execute: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.agentId, 'agentId');
        validateString(payload.message, 'message');
        return ipcRenderer.invoke('agent:execute', payload);
      },
      executeParallel: (payload) => ipcRenderer.invoke('agent:executeParallel', payload),
      executeSerial: (payload) => ipcRenderer.invoke('agent:executeSerial', payload),
      executeWithDeps: (payload) => {
        validateObject(payload, 'payload');
        const hasTasks = Array.isArray(payload.tasks) && payload.tasks.length > 0;
        const hasPlanFile = typeof payload.planFile === 'string' && payload.planFile.trim().length > 0;
        if (!hasTasks && !hasPlanFile) {
          throw new Error('Invalid payload: expected tasks array or planFile path');
        }
        return ipcRenderer.invoke('agent:executeWithDeps', payload);
      },
      onAskUser: (callback) => registerOnce('agent:askUser', callback),
      sendUserResponse: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.requestId, 'requestId');
        validateString(payload.response, 'response');
        ipcRenderer.send('agent:userResponse', payload);
      }
    },
    orchestration: {
      gatewayStatus: () => ipcRenderer.invoke('gateway:status'),
      listSessions: (filter) => ipcRenderer.invoke('sessions:list', filter),
      getSessionHistory: (payload) => ipcRenderer.invoke('sessions:history', payload)
    },
    settings: {
      load: () => ipcRenderer.invoke('settings:load'),
      saveTemplateVariables: (payload) => ipcRenderer.invoke('settings:saveTemplateVariables', payload),
      saveUserProfile: (payload) => ipcRenderer.invoke('settings:saveUserProfile', payload),
      saveVoice: (payload) => ipcRenderer.invoke('settings:saveVoice', payload),
      saveElevenLabsKey: (payload) => ipcRenderer.invoke('settings:saveElevenLabsKey', payload),
      testVoice: (payload) =>
        throttleInvoke('settings:testVoice', () => ipcRenderer.invoke('settings:testVoice', payload)),
      saveNotifications: (payload) => ipcRenderer.invoke('settings:saveNotifications', payload),
      addAllowedDirectory: () => ipcRenderer.invoke('settings:addAllowedDirectory'),
      removeAllowedDirectory: (directory) => {
        validateString(directory, 'directory');
        return ipcRenderer.invoke('settings:removeAllowedDirectory', { directory });
      },
      saveProvider: (payload) => {
        validateSettingsSaveProviderPayload(payload);
        return ipcRenderer.invoke('settings:saveProvider', payload);
      },
      testProvider: (payload) =>
        throttleInvoke('settings:testProvider', () => ipcRenderer.invoke('settings:testProvider', payload)),
      setActiveProvider: (payload) => ipcRenderer.invoke('settings:setActiveProvider', payload),
      setProviderModel: (payload) => ipcRenderer.invoke('settings:setProviderModel', payload),
      setInferenceTier: (payload) => ipcRenderer.invoke('settings:setInferenceTier', payload),
      runLlmCommand: (payload) => {
        validateSettingsRunLlmPayload(payload);
        return ipcRenderer.invoke('settings:runLlmCommand', payload);
      },
      saveWebSearchKey: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('settings:saveWebSearchKey', payload);
      }
    },
    hooks: {
      list: () => ipcRenderer.invoke('hooks:list'),
      reload: () => ipcRenderer.invoke('hooks:reload'),
      setEnabled: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.hookId, 'hookId');
        if (typeof payload.enabled !== 'boolean') {
          throw new Error('Invalid enabled: expected boolean');
        }
        return ipcRenderer.invoke('hooks:setEnabled', payload);
      },
      setGlobalEnabled: (payload) => ipcRenderer.invoke('hooks:setGlobalEnabled', payload)
    },
    memory: {
      capture: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.type, 'type');
        validateString(payload.content, 'content', { minLength: 1 });
        return ipcRenderer.invoke('memory:capture', payload);
      },
      recall: (payload) => ipcRenderer.invoke('memory:recall', payload),
      list: (payload) => ipcRenderer.invoke('memory:list', payload),
      delete: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('memory:delete', payload);
      },
      clear: () => ipcRenderer.invoke('memory:clear')
    },
    usage: {
      getSession: () => ipcRenderer.invoke('usage:getSession'),
      getDaily: (payload) => ipcRenderer.invoke('usage:getDaily', payload)
    },
    cron: {
      list: () => ipcRenderer.invoke('cron:list'),
      add: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('cron:add', payload);
      },
      update: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        validateObject(payload.patch, 'patch');
        return ipcRenderer.invoke('cron:update', payload);
      },
      remove: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('cron:remove', payload);
      },
      run: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('cron:run', payload);
      },
      status: () => ipcRenderer.invoke('cron:status')
    },
    skill: {
      list: () => ipcRenderer.invoke('skill:list'),
      customize: (payload) => ipcRenderer.invoke('skill:customize', payload),
      execute: (payload) => {
        validateSkillExecutePayload(payload);
        return ipcRenderer.invoke('skill:execute', payload);
      },
      pin: (payload) => ipcRenderer.invoke('skill:pin', payload),
      unpin: (payload) => ipcRenderer.invoke('skill:unpin', payload),
      getPinned: (payload) => ipcRenderer.invoke('skill:getPinned', payload),
      listPinnable: () => ipcRenderer.invoke('skill:listPinnable'),
      handleMessage: (payload) => ipcRenderer.invoke('skill:handleMessage', payload),
      listWithSettings: () => ipcRenderer.invoke('skill:listWithSettings'),
      getSettings: (payload) => ipcRenderer.invoke('skill:getSettings', payload),
      saveSettings: (payload) => ipcRenderer.invoke('skill:saveSettings', payload),
      setEnabled: (payload) => ipcRenderer.invoke('skill:setEnabled', payload),
      install: (payload) => ipcRenderer.invoke('skill:install', payload),
      remove: (payload) => ipcRenderer.invoke('skill:remove', payload)
    },
    webhook: {
      list: () => ipcRenderer.invoke('webhook:list'),
      create: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.name, 'name', { minLength: 1 });
        return ipcRenderer.invoke('webhook:create', payload);
      },
      update: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('webhook:update', payload);
      },
      delete: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('webhook:delete', payload);
      },
      get: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('webhook:get', payload);
      },
      regenerateSecret: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.id, 'id');
        return ipcRenderer.invoke('webhook:regenerateSecret', payload);
      }
    },
    wizard: {
      getStatus: () => ipcRenderer.invoke('wizard:getStatus'),
      complete: () => ipcRenderer.invoke('wizard:complete'),
      getSteps: () => ipcRenderer.invoke('wizard:getSteps'),
      onStart: (callback) => registerOnce('wizard:start', callback)
    },
    diagnostics: {
      run: () => ipcRenderer.invoke('diagnostics:run')
    },
    app: {
      quitWindow: () => ipcRenderer.invoke('app:quitWindow')
    },
    markdown: {
      parse: (text) => safeMarkdownParse(text),
      sanitize: (text) => sanitizeHtml(text)
    }
  }
);

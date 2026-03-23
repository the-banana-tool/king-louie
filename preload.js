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

let markdownParser = null;
try {
  const markedModule = require('marked');
  markdownParser = markedModule.marked || markedModule;
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

const safeMarkdownParse = (text) => {
  const input = text || '';
  const sanitize = (html) => {
    if (!domPurify || typeof domPurify.sanitize !== 'function') {
      return String(html || '');
    }

    return domPurify.sanitize(String(html || ''));
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

const lastCallByKey = new Map();
const throttleInvoke = (key, fn, delayMs = 1000) => {
  const now = Date.now();
  const last = Number(lastCallByKey.get(key) || 0);
  if (now - last < delayMs) {
    return Promise.resolve({ ok: false, error: 'Too many requests' });
  }
  lastCallByKey.set(key, now);
  return fn();
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
      rename: (payload) => ipcRenderer.invoke('chat:rename', payload),
      remove: (chatId) => ipcRenderer.invoke('chat:delete', chatId),
      addMessage: (payload) => ipcRenderer.invoke('chat:addMessage', payload),
      speakLast: (payload) => ipcRenderer.invoke('chat:speakLast', payload),
      sendMessage: (payload) => ipcRenderer.invoke('chat:sendMessage', payload),
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
      execute: (payload) => ipcRenderer.invoke('agent:execute', payload),
      executeParallel: (payload) => ipcRenderer.invoke('agent:executeParallel', payload),
      executeSerial: (payload) => ipcRenderer.invoke('agent:executeSerial', payload)
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
      }
    },
    hooks: {
      list: () => ipcRenderer.invoke('hooks:list'),
      reload: () => ipcRenderer.invoke('hooks:reload'),
      setEnabled: (payload) => ipcRenderer.invoke('hooks:setEnabled', payload),
      setGlobalEnabled: (payload) => ipcRenderer.invoke('hooks:setGlobalEnabled', payload)
    },
    memory: {
      capture: (payload) => ipcRenderer.invoke('memory:capture', payload),
      recall: (payload) => ipcRenderer.invoke('memory:recall', payload),
      list: (payload) => ipcRenderer.invoke('memory:list', payload),
      delete: (payload) => ipcRenderer.invoke('memory:delete', payload),
      clear: () => ipcRenderer.invoke('memory:clear')
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
      handleMessage: (payload) => ipcRenderer.invoke('skill:handleMessage', payload)
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

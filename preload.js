const { contextBridge, ipcRenderer } = require('electron');

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

const safeMarkdownParse = (text) => {
  const input = text || '';
  if (markdownParser?.parse) {
    try {
      return markdownParser.parse(input);
    } catch {
      // Fall through to plain-text HTML
    }
  }

  return `<p>${escapeHtml(input).replace(/\n/g, '<br>')}</p>`;
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
      sendMessage: (payload) => ipcRenderer.invoke('chat:sendMessage', payload),
      onMessageStart: (callback) => ipcRenderer.on('chat:messageStart', (_event, data) => callback(data)),
      onMessageChunk: (callback) => ipcRenderer.on('chat:messageChunk', (_event, data) => callback(data)),
      onMessageComplete: (callback) => ipcRenderer.on('chat:messageComplete', (_event, data) => callback(data)),
      onMessageError: (callback) => ipcRenderer.on('chat:messageError', (_event, data) => callback(data))
    },
    settings: {
      load: () => ipcRenderer.invoke('settings:load'),
      saveProvider: (payload) => ipcRenderer.invoke('settings:saveProvider', payload),
      testProvider: (payload) => ipcRenderer.invoke('settings:testProvider', payload),
      setActiveProvider: (payload) => ipcRenderer.invoke('settings:setActiveProvider', payload),
      setProviderModel: (payload) => ipcRenderer.invoke('settings:setProviderModel', payload)
    },
    markdown: {
      parse: (text) => safeMarkdownParse(text)
    }
  }
);

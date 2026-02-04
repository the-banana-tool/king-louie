const { contextBridge, ipcRenderer } = require('electron');

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
      addMessage: (payload) => ipcRenderer.invoke('chat:addMessage', payload)
    },
    settings: {
      load: () => ipcRenderer.invoke('settings:load'),
      saveProvider: (payload) => ipcRenderer.invoke('settings:saveProvider', payload),
      testProvider: (payload) => ipcRenderer.invoke('settings:testProvider', payload)
    }
  }
);

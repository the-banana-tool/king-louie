function cloneMessages(messages) {
  return Array.isArray(messages) ? [...messages] : [];
}

function withoutMessages(chat = {}) {
  const { messages: _messages, ...metadata } = chat;
  return metadata;
}

function applyPatch(chat = {}, patch = {}) {
  return { ...chat, ...(patch || {}) };
}

class JsonChatHistoryStore {
  constructor(options = {}) {
    if (!options.store || typeof options.store.get !== 'function' || typeof options.store.set !== 'function') {
      throw new Error('JsonChatHistoryStore requires an electron-store-like store.');
    }
    this.store = options.store;
  }

  getAllChats() {
    const chats = this.store.get('chats', []);
    return Array.isArray(chats) ? chats : [];
  }

  setChats(chats = []) {
    const normalized = Array.isArray(chats) ? chats : [];
    this.store.set('chats', normalized);
    return normalized;
  }

  listChats(options = {}) {
    const includeMessages = options.messages === true || options.includeMessages === true;
    return this.getAllChats().map((chat) => (includeMessages ? chat : withoutMessages(chat)));
  }

  getChat(chatId, options = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const chat = this.getAllChats().find((item) => item.id === id) || null;
    if (!chat) return null;
    const includeMessages = options.messages !== false && options.includeMessages !== false;
    return includeMessages ? chat : withoutMessages(chat);
  }

  createChat(chat = {}, options = {}) {
    if (!chat || typeof chat !== 'object' || !String(chat.id || '').trim()) return null;
    const id = String(chat.id).trim();
    const normalized = { ...chat, id, messages: Array.isArray(chat.messages) ? chat.messages : [] };
    const existing = this.getAllChats().filter((item) => item.id !== id);
    const position = options.position || 'front';
    const updated = position === 'back' ? [...existing, normalized] : [normalized, ...existing];
    this.setChats(updated);
    return normalized;
  }

  replaceChat(chatId, chat = {}) {
    const id = String(chatId || chat?.id || '').trim();
    if (!id || !chat || typeof chat !== 'object') return null;
    const normalized = { ...chat, id, messages: Array.isArray(chat.messages) ? chat.messages : [] };
    let replaced = false;
    const updated = this.getAllChats().map((item) => {
      if (item.id !== id) return item;
      replaced = true;
      return normalized;
    });
    if (!replaced) return null;
    this.setChats(updated);
    return normalized;
  }

  upsertChat(chat = {}, options = {}) {
    if (!chat || typeof chat !== 'object' || !String(chat.id || '').trim()) return null;
    const id = String(chat.id).trim();
    const existing = this.getChat(id, { messages: true });
    if (existing) return this.replaceChat(id, chat);
    return this.createChat({ ...chat, id }, options);
  }

  deleteChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return this.getAllChats();
    const updated = this.getAllChats().filter((chat) => chat.id !== id);
    this.setChats(updated);
    return updated;
  }

  updateChat(chatId, patch = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    let updatedChat = null;
    const updated = this.getAllChats().map((chat) => {
      if (chat.id !== id) return chat;
      updatedChat = applyPatch(chat, patch);
      return updatedChat;
    });
    if (!updatedChat) return null;
    this.setChats(updated);
    return updatedChat;
  }

  updateChatsWhere(predicate, patcher) {
    if (typeof predicate !== 'function' || typeof patcher !== 'function') return [];
    const changed = [];
    const updated = this.getAllChats().map((chat) => {
      if (!predicate(chat)) return chat;
      const patch = patcher(chat);
      if (!patch || typeof patch !== 'object') return chat;
      const next = applyPatch(chat, patch);
      changed.push(next);
      return next;
    });
    if (changed.length) this.setChats(updated);
    return changed;
  }

  appendMessage(chatId, message = {}, options = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const now = options.updatedAt || message.timestamp || new Date().toISOString();
    let updatedChat = null;
    const updated = this.getAllChats().map((chat) => {
      if (chat.id !== id) return chat;
      const messages = cloneMessages(chat.messages);
      updatedChat = {
        ...chat,
        updatedAt: now,
        messages: [...messages, message],
        ...(options.patch || {})
      };
      return updatedChat;
    });
    if (!updatedChat) return null;
    this.setChats(updated);
    return updatedChat;
  }
}

module.exports = {
  JsonChatHistoryStore
};
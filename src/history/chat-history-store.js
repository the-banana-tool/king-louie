function cloneMessages(messages) {
  return Array.isArray(messages) ? [...messages] : [];
}

function withoutMessages(chat = {}) {
  const { messages: _messages, ...metadata } = chat;
  return metadata;
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

  updateChat(chatId, patch = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    let updatedChat = null;
    const updated = this.getAllChats().map((chat) => {
      if (chat.id !== id) return chat;
      updatedChat = { ...chat, ...(patch || {}) };
      return updatedChat;
    });
    if (!updatedChat) return null;
    this.setChats(updated);
    return updatedChat;
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
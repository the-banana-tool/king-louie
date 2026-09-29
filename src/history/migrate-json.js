// src/history/migrate-json.js
// The one-way move of chat-data.json's `chats` array into history.sqlite
// (recall spec §11.1). The backup comes first; each chat moves in its own
// transaction; a chat that fails stays in the JSON array and is reported;
// the marker is set only when the array is empty, so a crash midway resumes
// on the next start. Only chat-data.json is read: an old chat-history.sqlite
// (the blob store) is never opened (owner decision 2026-09-29).
const fs = require('fs');
const path = require('path');

const MIGRATION_MARKER = 'migrated_from_json';

const backupName = (stamp) => `chat-data.backup-${String(stamp).replace(/[:.]/g, '-')}.json`;

function chatLabel(chat, index) {
  const id = chat && typeof chat === 'object' ? String(chat.id ?? '').trim() : '';
  return id || `#${index}`;
}

function moveChat(historyStore, chat, seen) {
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) throw new Error('it is not a chat object');
  const id = String(chat.id ?? '').trim();
  if (!id) throw new Error('it has no id');
  if (seen.has(id)) throw new Error('another chat earlier in chat-data.json has the same id');
  seen.add(id);
  if (chat.messages != null && !Array.isArray(chat.messages)) throw new Error('its messages are not a list');
  const expected = Array.isArray(chat.messages) ? chat.messages.length : 0;
  historyStore.transaction(() => {
    if (historyStore.getChat(id, { messages: false })) {
      const stored = historyStore.messageCount(id);
      // Committed by an earlier run that stopped before rewriting the JSON.
      if (stored === expected) return;
      throw new Error(`a chat with this id is already in history.sqlite with ${stored} messages, not ${expected}`);
    }
    historyStore.createChat({ ...chat, id }, { position: 'back' });
    const stored = historyStore.messageCount(id);
    if (stored !== expected) throw new Error(`stored ${stored} of its ${expected} messages`);
  });
}

function migrateFromJson({ historyStore, jsonStore, jsonPath = null, log, now = () => new Date().toISOString() }) {
  if (historyStore.getMeta(MIGRATION_MARKER)) return { migrated: 0, failed: [] };
  const chats = jsonStore.get('chats', []);
  if (!Array.isArray(chats)) {
    const error = 'chats in chat-data.json is not a list';
    log.error(`Chats could not be moved into history.sqlite: ${error}.`);
    return { migrated: 0, failed: [{ id: 'chats', error }] };
  }
  const stamp = now();
  if (chats.length === 0) {
    historyStore.setMeta(MIGRATION_MARKER, stamp);
    return { migrated: 0, failed: [] };
  }

  if (jsonPath && fs.existsSync(jsonPath)) {
    const target = path.join(path.dirname(jsonPath), backupName(stamp));
    try {
      fs.copyFileSync(jsonPath, target, fs.constants.COPYFILE_EXCL);
      log.info(`Backed up chat-data.json to ${target} before moving ${chats.length} chat(s) into history.sqlite.`);
    } catch (err) {
      const error = `backup failed: ${err.message}`;
      log.error(`chat-data.json could not be backed up (${err.message}); no chats were moved.`);
      return { migrated: 0, failed: chats.map((chat, index) => ({ id: chatLabel(chat, index), error })) };
    }
  } else {
    log.warn('chat-data.json is not on disk, so there is no file to back up; moving its chats anyway.');
  }

  const seen = new Set();
  const remaining = [];
  const failed = [];
  let migrated = 0;
  chats.forEach((chat, index) => {
    try {
      moveChat(historyStore, chat, seen);
      migrated += 1;
    } catch (err) {
      const id = chatLabel(chat, index);
      failed.push({ id, error: err.message });
      remaining.push(chat);
      log.error(`Chat ${id} could not be moved into history.sqlite and stays in chat-data.json: ${err.message}`);
    }
  });

  if (migrated > 0) jsonStore.set('chats', remaining);
  if (remaining.length === 0) historyStore.setMeta(MIGRATION_MARKER, stamp);
  log.info(`Moved ${migrated} chat(s) into history.sqlite${failed.length ? `; ${failed.length} stay in chat-data.json` : ''}.`);
  return { migrated, failed };
}

module.exports = { migrateFromJson, MIGRATION_MARKER };

// src/history/rows.js
// Today's in-memory chat and message shapes ↔ the history store's columns
// (recall spec §4.1, §4.2). A field with a column goes there when its type
// fits; every other field goes to meta_json, so what is written reads back
// equal (a message gains seq). Pure functions: no database here.

const DERIVED_CHAT_KEYS = Object.freeze([
  'messageCount', 'userMessageCount', 'assistantMessageCount', 'preview', 'lastMessageText', 'lastMessageAt'
]);
const CHAT_TEXT_COLUMNS = Object.freeze({
  title: 'title', createdAt: 'created_at', updatedAt: 'updated_at', caseId: 'case_id',
  workingDirectory: 'working_directory', source: 'source'
});
const CHAT_FLAG_COLUMNS = Object.freeze({ agentMode: 'agent_mode', sandboxMode: 'sandbox_mode' });
const MESSAGE_TEXT_COLUMNS = Object.freeze({ text: 'text', toolName: 'tool_name', runId: 'run_id' });
const MESSAGE_JSON_COLUMNS = Object.freeze({ parameters: 'params_json', result: 'result_json', llm: 'llm_json', context: 'context_json' });
const ATTACHMENT_KINDS = Object.freeze({ images: 'image', documents: 'document' });
const ATTACHMENT_KEYS = Object.freeze({ image: 'images', document: 'documents' });

class InvalidMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMessageError';
    this.code = 'HISTORY_INVALID_MESSAGE';
  }
}

const isString = (v) => typeof v === 'string';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const isCanonicalBase64 = (v) => isString(v) && v.length > 0 && Buffer.from(v, 'base64').toString('base64') === v;
const present = (v) => v !== null && v !== undefined;

function metaJson(meta) {
  const json = JSON.stringify(meta);
  return json === '{}' ? null : json;
}

function chatToRow(chat = {}) {
  const row = {
    title: '', created_at: null, updated_at: null, agent_mode: null, sandbox_mode: null,
    case_id: null, working_directory: null, source: null, meta_json: null
  };
  const meta = {};
  for (const [key, value] of Object.entries(chat || {})) {
    if (value === undefined || key === 'id' || key === 'messages' || DERIVED_CHAT_KEYS.includes(key)) continue;
    const textColumn = CHAT_TEXT_COLUMNS[key];
    if (textColumn && isString(value)) { row[textColumn] = value; continue; }
    const flagColumn = CHAT_FLAG_COLUMNS[key];
    if (flagColumn && typeof value === 'boolean') { row[flagColumn] = value ? 1 : 0; continue; }
    meta[key] = value;
  }
  row.meta_json = metaJson(meta);
  return row;
}

function rowToChat(row) {
  const chat = { id: row.id, title: row.title };
  for (const [key, column] of Object.entries(CHAT_TEXT_COLUMNS)) {
    if (key !== 'title' && present(row[column])) chat[key] = row[column];
  }
  for (const [key, column] of Object.entries(CHAT_FLAG_COLUMNS)) {
    if (present(row[column])) chat[key] = Number(row[column]) === 1;
  }
  if (row.meta_json) Object.assign(chat, JSON.parse(row.meta_json));
  return chat;
}

function attachmentToRow(kind, idx, item) {
  const row = { kind, idx, name: null, mime: null, bytes: null, text: null, meta_json: null };
  const meta = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    if (key === 'name' && isString(value)) row.name = value;
    else if (key === 'mimeType' && isString(value)) row.mime = value;
    else if (key === 'textContent' && isString(value)) row.text = value;
    else if (key === 'base64' && isCanonicalBase64(value)) row.bytes = Buffer.from(value, 'base64');
    else meta[key] = value;
  }
  row.meta_json = metaJson(meta);
  return row;
}

function rowToAttachment(row) {
  const item = {};
  if (present(row.name)) item.name = row.name;
  if (present(row.mime)) item.mimeType = row.mime;
  if (present(row.text)) item.textContent = row.text;
  if (present(row.bytes)) item.base64 = Buffer.from(row.bytes).toString('base64');
  if (row.meta_json) Object.assign(item, JSON.parse(row.meta_json));
  return item;
}

function messageToRow(message, { fallbackTimestamp } = {}) {
  if (!isPlainObject(message)) throw new InvalidMessageError('A message must be an object.');
  if (!isString(message.sender) || !message.sender.trim()) throw new InvalidMessageError('A message needs a sender.');
  const row = {
    sender: message.sender, text: null, timestamp: null, tool_name: null, params_json: null,
    result_json: null, run_id: null, llm_json: null, context_json: null, meta_json: null
  };
  const meta = {};
  const attachments = [];
  for (const [key, value] of Object.entries(message)) {
    if (value === undefined || key === 'id' || key === 'seq' || key === 'sender') continue;
    if (key === 'timestamp') {
      if (isString(value)) row.timestamp = value;
      else meta.timestamp = value;
      continue;
    }
    const textColumn = MESSAGE_TEXT_COLUMNS[key];
    if (textColumn) {
      if (isString(value)) row[textColumn] = value;
      else meta[key] = value;
      continue;
    }
    const jsonColumn = MESSAGE_JSON_COLUMNS[key];
    if (jsonColumn) {
      const json = JSON.stringify(value);
      if (json !== undefined) row[jsonColumn] = json;
      continue;
    }
    const kind = ATTACHMENT_KINDS[key];
    if (kind && Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
      value.forEach((item, idx) => attachments.push(attachmentToRow(kind, idx, item)));
      continue;
    }
    meta[key] = value;
  }
  if (row.timestamp === null) row.timestamp = fallbackTimestamp || new Date().toISOString();
  row.meta_json = metaJson(meta);
  return { row, attachments };
}

function rowToMessage(row, attachmentRows = []) {
  const message = { id: row.id, seq: Number(row.seq), sender: row.sender, timestamp: row.timestamp };
  for (const [key, column] of Object.entries(MESSAGE_TEXT_COLUMNS)) {
    if (present(row[column])) message[key] = row[column];
  }
  for (const [key, column] of Object.entries(MESSAGE_JSON_COLUMNS)) {
    if (present(row[column])) message[key] = JSON.parse(row[column]);
  }
  for (const attachment of attachmentRows) {
    const key = ATTACHMENT_KEYS[attachment.kind];
    if (!key) continue;
    if (!message[key]) message[key] = [];
    message[key].push(rowToAttachment(attachment));
  }
  if (row.meta_json) Object.assign(message, JSON.parse(row.meta_json));
  return message;
}

module.exports = {
  DERIVED_CHAT_KEYS,
  InvalidMessageError,
  chatToRow,
  rowToChat,
  messageToRow,
  rowToMessage
};

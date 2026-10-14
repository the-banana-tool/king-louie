// src/models/private-facts.js
// What the private mark's confirmation tells the owner (local inference spec
// 2026-10-13 §8.1, §8.2; R-LI-10), read from the host before anything is
// marked:
//
// - alreadySent: how many replies of the chat (every chat of the case) made
//   a call to a hosted model, and to which providers, from the replies'
//   stored `llm` records (their own calls and their sub-agents'). What was
//   sent stays sent.
// - hostedVectors: a hosted embedder has vectors of it; marking deletes them
//   and the embed worker makes them again on this machine.
// - missing: the roles that would have no local model under the mark, each
//   with the resolver's own sentence (what will be refused or skipped).
// - recalledBy: other chats whose replies say they recalled this one.
// - chats: the chats the mark covers (a case's, or the chat alone).
// - bridge: a Telegram or Discord chat, which cannot be marked.
// - questionsLeave: for a case, its questions to the owner still go out over
//   the contact ladder (Telegram, Discord, email, SMS, voice, the phone
//   app): the mark keeps model calls local, not the questions (review fix,
//   item 9a).
//
// Pure reads. Titles are stored text: the IPC reply carries untrustedText.
// Electron-free.
const { localServerOf } = require('../tracking/llm-totals');

// The roles every turn may use, and, for a case, the case roles that have
// needs of their own: orient and judge call tools (src/cases/roles.js).
const CHAT_CHECKS = Object.freeze([['main', 'main', {}], ['worker', 'worker', {}], ['utility', 'utility', {}]]);
const CASE_CHECKS = Object.freeze([['judge', 'main', { toolCall: true }], ['orient', 'utility', { toolCall: true }]]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every call a reply's llm record holds: its own and its sub-agents'.
function callsOf(llm) {
  if (!isObj(llm)) return [];
  const own = Array.isArray(llm.calls) ? llm.calls : [];
  const runs = Array.isArray(llm.subagents) ? llm.subagents.flatMap((r) => (isObj(r) && Array.isArray(r.calls) ? r.calls : [])) : [];
  return [...own, ...runs].filter(isObj);
}

function sentOf(store, chatIds) {
  let messages = 0;
  const providers = new Set();
  for (const id of chatIds) {
    let rows = [];
    try {
      rows = store.getMessages(id) || [];
    } catch {
      rows = [];
    }
    for (const m of rows) {
      if (!isObj(m) || m.sender !== 'assistant') continue;
      const hosted = callsOf(m.llm).filter((c) => !localServerOf(c));
      if (!hosted.length) continue;
      messages += 1;
      for (const c of hosted) if (typeof c.provider === 'string' && c.provider) providers.add(c.provider);
    }
  }
  return { messages, providers: [...providers].sort() };
}

function missingOf(turnModels, { forCase = false } = {}) {
  if (!turnModels || typeof turnModels.mustResolve !== 'function') return [];
  const out = [];
  for (const [label, role, needs] of [...CHAT_CHECKS, ...(forCase ? CASE_CHECKS : [])]) {
    if (out.some((m) => m.role === label)) continue;
    try {
      turnModels.mustResolve(role, { needs });
    } catch (err) {
      out.push({ role: label, why: err && err.message ? String(err.message) : 'No local model can take it.' });
    }
  }
  return out;
}

// { store, chatId, caseId, turnModels, voiceSettings, embedderStatus,
// bridgeOriginFor } → the facts above. `turnModels` is a snapshot taken
// under the policy the mark would set. With a caseId, every chat of the
// case is counted (and chatId, if given, with them).
function privateFacts({ store, chatId = null, caseId = null, turnModels = null, voiceSettings = null, embedderStatus = null, bridgeOriginFor = null } = {}) {
  if (!store || typeof store.chatRefs !== 'function') throw new TypeError('privateFacts needs the history store.');
  const refs = store.chatRefs().filter(isObj);
  const byId = new Map(refs.map((r) => [r.id, r]));
  const ids = caseId ? refs.filter((r) => r.caseId === caseId).map((r) => r.id) : [];
  if (chatId && !ids.includes(chatId)) ids.unshift(chatId);
  const chats = ids.map((id) => ({ id, title: typeof byId.get(id)?.title === 'string' ? byId.get(id).title : '' }));

  let hostedVectors = false;
  for (const id of ids) {
    const n = typeof store.hostedVectorCount === 'function' ? store.hostedVectorCount(id) : 0;
    // A count that could not be read is said as "there may be some".
    if (n === null || n > 0) hostedVectors = true;
  }

  const recalledBy = [];
  for (const id of ids) {
    const readers = typeof store.chatsRecalling === 'function' ? store.chatsRecalling(id) || [] : [];
    for (const reader of readers) {
      if (ids.includes(reader) || recalledBy.some((r) => r.chatId === reader)) continue;
      recalledBy.push({ chatId: reader, title: typeof byId.get(reader)?.title === 'string' ? byId.get(reader).title : '' });
    }
  }

  const bridge = typeof bridgeOriginFor === 'function' && ids.some((id) => Boolean(bridgeOriginFor(byId.get(id) || {})));
  const keepLocal = isObj(embedderStatus) && isObj(embedderStatus.keepLocal) ? embedderStatus.keepLocal.state || null : null;
  return {
    alreadySent: sentOf(store, ids),
    hostedVectors,
    missing: missingOf(turnModels, { forCase: Boolean(caseId) }),
    recalledBy,
    chats,
    bridge,
    // Read-aloud on ElevenLabs is switched to the system voice (R-LI-33).
    ...(isObj(voiceSettings) && voiceSettings.engine === 'elevenlabs' ? { readAloud: 'system' } : {}),
    ...(caseId ? { questionsLeave: true } : {}),
    ...(keepLocal ? { localVectors: keepLocal } : {})
  };
}

module.exports = { privateFacts, callsOf };

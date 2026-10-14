// src/skills/skill-models.js
// The model a user skill reaches through its context's `llmProvider` (local
// inference spec 2026-10-13 §7.2; review fix, item 4a). A skill's context is
// built once, at load, so the getter cannot know which chat is calling: the
// caller is carried in an AsyncLocalStorage that every way into a skill sets
// (SkillRegistry#executeCommand, a skill's handleMessage, a tool run by
// ToolExecutor), and the provider handed out looks at it again on every
// call, so an instance a skill keeps from an ordinary chat is still held to
// a private chat's policy when it is used there.
//
// Whose policy:
// - a run whose policy is known (a tool call: the turn's snapshot) uses it;
// - a Telegram or Discord chat has none: a bridge chat cannot be marked
//   private (spec D-LI-3, PRIVATE_BRIDGE_CHAT);
// - any other chat id is asked of the host (`egressFor`), where an unknown
//   chat is private;
// - a call with no caller at all (a skill's own timer, say) is unknown: it
//   is held to a policy whenever any chat could be under one
//   (`anyPrivate`, fail closed), else it has none.
// Under a policy the provider is the router's, which sends only to a
// guarantee-grade local model or refuses (PRIVATE_NO_LOCAL_MODEL). With none
// it is what it always was (`direct`).
const { AsyncLocalStorage } = require('node:async_hooks');
const { egressPolicy, normalizePolicy } = require('../models/egress');

const callers = new AsyncLocalStorage();
const BRIDGE_CHANNELS = new Set(['telegram', 'discord']);
// A tool run's context carries no other text a skill could pass along.
const NO_MODEL_MESSAGE = 'No model is available to skills here.';

/**
 * Run `fn` as the skill caller `info`: `{ chatId?, channel?, egress? }`.
 * `egress` given (null or a policy) is authoritative.
 */
function runAsSkillCaller(info, fn) {
  const caller = Object.freeze({
    chatId: typeof info?.chatId === 'string' && info.chatId ? info.chatId : null,
    channel: typeof info?.channel === 'string' ? info.channel : null,
    ...(info && info.egress !== undefined ? { egress: info.egress ?? null } : {})
  });
  return callers.run(caller, fn);
}

function currentSkillCaller() {
  return callers.getStore() || null;
}

/**
 * @param {object} deps
 * @param {Function} deps.egressFor - ({ chatId }) → policy or null
 * @param {Function} deps.anyPrivate - () → false only when no chat is private
 * @param {Function} deps.routed - (policy, caller) → the router's provider for main under it (may throw)
 * @param {Function} deps.direct - () → the hosted instance skills had before, or null
 * @param {object} [deps.log]
 */
function createSkillModels({ egressFor, anyPrivate, routed, direct, log = null }) {
  const policyOf = (caller) => {
    if (caller && caller.egress !== undefined) return normalizePolicy(caller.egress);
    if (caller && BRIDGE_CHANNELS.has(caller.channel)) return null;
    if (caller && caller.chatId) return egressFor({ chatId: caller.chatId });
    let some = true;
    try {
      some = anyPrivate() !== false;
    } catch {
      some = true;
    }
    return some ? egressPolicy({ reason: 'unknown-mark', chatId: null, caseId: null }) : null;
  };
  const resolveNow = () => {
    const caller = currentSkillCaller();
    const policy = policyOf(caller);
    return policy ? routed(policy, caller) : direct();
  };
  const facade = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      const now = resolveNow();
      if (!now) throw new Error(NO_MODEL_MESSAGE);
      const value = now[prop];
      if (typeof value !== 'function') return value;
      // Resolved again when called: a method kept from one caller is held
      // to the policy of the caller that uses it.
      return (...args) => {
        const at = resolveNow();
        if (!at || typeof at[prop] !== 'function') throw new Error(NO_MODEL_MESSAGE);
        return at[prop](...args);
      };
    }
  });
  return {
    // The getter: null when nothing would answer now (as before), else the
    // facade.
    provider() {
      try {
        return resolveNow() ? facade : null;
      } catch (err) {
        if (log) log.warn(`LLM provider not available: ${err.message}`);
        return null;
      }
    },
    policyOf
  };
}

module.exports = { runAsSkillCaller, currentSkillCaller, createSkillModels };

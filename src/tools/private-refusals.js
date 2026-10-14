// src/tools/private-refusals.js
// Tools that are refused in a private chat (spec
// 2026-10-13-local-inference-design.md §7.5, §7.7, §8.5). Tools behave as
// now under the private mark (R-LI-9): a web search sends its query, a
// fetch fetches, Bash runs. The ones here are not "tools" for that rule,
// because what they do is put the chat's text in front of a model somewhere
// else: another node's (R-LI-32), a run that belongs to no chat and so has
// no mark (the L1 plan's question N1, built fail closed), or a hosted image
// model (R-LI-33). ToolExecutor refuses them before any hook, permission
// rule or approval prompt, so nobody is asked to approve a call that could
// only be refused. SpawnAgent and BackgroundTask are not here: their runs
// inherit the turn's policy.

// Actions that start nothing and send nothing. Any other action, a missing
// one included, is refused: what cannot be decided does not run.
const CRON_ALLOWED = Object.freeze(['list', 'status', 'remove', 'run']);
const REMOTE_DISPATCH_ALLOWED = Object.freeze(['peers', 'status', 'cancel']);

const actionOutside = (allowed) => (params) => {
  const action = params && typeof params === 'object' ? params.action : undefined;
  return !(typeof action === 'string' && allowed.includes(action));
};

const DELEGATE = Object.freeze({
  code: 'PRIVATE_NO_DELEGATE',
  message: 'This chat is private, and this tool hands work to a session on another machine, which runs it on that machine\'s models. It is not available in a private chat.'
});

const detached = (what, when = null) => Object.freeze({
  code: 'PRIVATE_NO_DETACHED_RUN',
  message: `This chat is private, and ${what} starts a run that belongs to no chat, on models this chat's private mark does not cover. It is not available in a private chat.`,
  ...(when ? { when } : {})
});

/**
 * Tool name → `{ code, message, when? }`. `when(params)` narrows the
 * refusal to some calls of the tool; without it every call is refused.
 */
const PRIVATE_REFUSED_TOOLS = Object.freeze({
  // The acting fleet chat tools (src/tools/builtin/fleet-chat-tools.js: every
  // one that is not in FLEET_READ_TOOLS). A test holds the two lists equal.
  run_runbook: DELEGATE,
  delegate: DELEGATE,
  send_to_job: DELEGATE,
  cancel_job: DELEGATE,
  // Runs that belong to no chat (N1).
  Cron: detached('creating or changing a scheduled job', actionOutside(CRON_ALLOWED)),
  sessions_spawn: detached('spawning a session'),
  RemoteDispatch: detached('dispatching a task to another machine', actionOutside(REMOTE_DISPATCH_ALLOWED)),
  // A hosted image model (R-LI-33). The tool refuses too, for a caller that
  // reaches it another way.
  ImageGenerate: Object.freeze({
    code: 'PRIVATE_HOSTED_CALL',
    message: 'Image generation is not available in a private chat: it would send the prompt to a hosted model.'
  })
});

/**
 * @param {string} toolName
 * @param {object} [params] - the call's parameters, for a tool refused by action
 * @returns {{ code: string, message: string }|null} the refusal, or null when the tool is not refused
 */
function privateRefusal(toolName, params = {}) {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(PRIVATE_REFUSED_TOOLS, toolName)) return null;
  const entry = PRIVATE_REFUSED_TOOLS[toolName];
  if (typeof entry.when === 'function') {
    let applies = true;
    try {
      applies = entry.when(params) !== false;
    } catch {
      applies = true;
    }
    if (!applies) return null;
  }
  return { code: entry.code, message: entry.message };
}

module.exports = { PRIVATE_REFUSED_TOOLS, privateRefusal };

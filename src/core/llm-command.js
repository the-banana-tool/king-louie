// The local `/llm …` command line (Settings > Providers). Shared by the
// core, which runs it, and the desktop bridge, which refuses the channel
// actions before they reach the core (fleet stage 7 §8: channels are not
// proxied).

// Quoted tokens ("…", '…', `…`) keep their spaces; backslash escapes the
// quote character.
function tokenizeCommand(input = '') {
  const regex = /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|`([^`\\]*(\\.[^`\\]*)*)`|(\S+)/g;
  const tokens = [];
  let match;

  while ((match = regex.exec(input)) !== null) {
    const token = match[1] ?? match[3] ?? match[5] ?? match[7] ?? '';
    tokens.push(token.replace(/\\(["'`\\])/g, '$1'));
  }

  return tokens;
}

// The /llm actions that save channel tokens or start/stop a channel.
const LLM_CHANNEL_ACTIONS = Object.freeze(['discord', 'telegram', 'slack']);

// The lowercased action of an `/llm` command, parsed exactly as the core
// parses it; null for anything that is not an `/llm` command.
function llmCommandAction(command = '') {
  const [namespace, action] = tokenizeCommand(String(command || '').trim());
  if (namespace !== '/llm') return null;
  return String(action || '').toLowerCase();
}

module.exports = { tokenizeCommand, llmCommandAction, LLM_CHANNEL_ACTIONS };

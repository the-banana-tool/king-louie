'use strict';

// Field names follow the Claude Code importer so messageText renders both alike.

function asText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toParameters(args, stats) {
  if (args === undefined || args === null || args === '') return {};
  if (isPlainObject(args)) return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (isPlainObject(parsed)) return parsed;
    } catch { /* counted below */ }
    stats.badArguments += 1;
    return { raw: args };
  }
  stats.badArguments += 1;
  return { raw: asText(args) };
}

function mapOpenAiMessages(list, { pairBy = 'id' } = {}) {
  if (pairBy !== 'id' && pairBy !== 'order') throw new Error(`unknown pairBy ${JSON.stringify(pairBy)}`);
  const stats = { skipped: { system: 0 }, unmapped: 0, unpaired: 0, badArguments: 0, reasoningChars: 0 };
  const messages = [];
  const namesById = new Map();
  let pending = [];

  for (const entry of Array.isArray(list) ? list : []) {
    const role = entry?.role;
    if (role === 'system') { stats.skipped.system += 1; continue; }

    if (role === 'user') {
      messages.push({ sender: 'user', text: asText(entry.content) });
      continue;
    }

    if (role === 'assistant') {
      const reasoningChars = typeof entry.reasoning_content === 'string' ? entry.reasoning_content.length : 0;
      stats.reasoningChars += reasoningChars;
      const text = asText(entry.content);
      if (text.trim()) messages.push({ sender: 'assistant', text, meta: { reasoningChars } });
      pending = [];
      for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
        const toolName = String(call?.function?.name ?? 'unknown');
        const toolUseId = call?.id ?? null;
        if (toolUseId !== null) namesById.set(toolUseId, toolName);
        pending.push({ toolName, toolUseId });
        messages.push({
          sender: 'toolUse',
          toolName,
          parameters: toParameters(call?.function?.arguments, stats),
          meta: { toolUseId }
        });
      }
      continue;
    }

    if (role === 'tool') {
      let toolName = null;
      let toolUseId = null;
      if (pairBy === 'id') {
        toolUseId = entry.tool_call_id ?? null;
        toolName = (toolUseId !== null && namesById.get(toolUseId)) || (entry.name ? String(entry.name) : null);
      } else {
        const call = pending.shift();
        if (call) ({ toolName, toolUseId } = call);
      }
      if (!toolName) { toolName = 'unknown'; stats.unpaired += 1; }
      messages.push({ sender: 'toolResult', toolName, result: asText(entry.content), meta: { toolUseId } });
      continue;
    }

    stats.unmapped += 1;
    messages.push({ sender: 'status', text: asText(entry?.content), meta: { unmapped: String(role) } });
  }

  return { messages, stats };
}

module.exports = { mapOpenAiMessages };

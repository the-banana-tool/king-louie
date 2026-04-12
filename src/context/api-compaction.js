/**
 * API-native context compaction for Anthropic conversations.
 *
 * Instead of embedding-based semantic retrieval (which costs $0.002/cycle
 * and requires an OpenAI API key), this module uses a simpler and more
 * reliable approach: when the conversation approaches the token limit,
 * it clears the content of old tool_result blocks while preserving their
 * structure (so the API still sees valid tool_use/tool_result pairs).
 *
 * This mirrors Anthropic's own `clear_tool_uses_20250919` strategy from
 * claude-code, adapted for King Louie's message format.
 *
 * Strategy:
 *  - Track estimated input tokens from API usage responses
 *  - When input_tokens exceeds the trigger threshold, start clearing
 *    old tool results from the conversation history
 *  - Keep recent tool results intact (configurable)
 *  - Clear from oldest to newest until below target threshold
 *  - Preserve tool_result block structure (type, tool_use_id) so the API
 *    doesn't reject the message sequence
 *
 * Clearable tool results (safe to truncate — output-only, no semantic loss):
 *  - Bash, Read, Glob, Grep, WebFetch, WebSearch, Git, Browser
 *
 * Non-clearable (truncating loses edit intent or user interaction):
 *  - Edit, Write, AskUser, SpawnAgent
 */

const CLEARABLE_TOOLS = new Set([
  'Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Git', 'Browser', 'ToolSearch', 'RequestTools'
]);

// Default thresholds
const DEFAULT_TRIGGER_TOKENS = 150000;  // Start clearing at 150K input tokens
const DEFAULT_TARGET_TOKENS = 40000;    // Clear until we estimate ~40K tokens freed
const DEFAULT_KEEP_RECENT = 6;          // Keep last 6 tool results intact

class APICompaction {
  /**
   * @param {object} options
   * @param {number} [options.triggerTokens=150000]  - Input token count that triggers compaction
   * @param {number} [options.targetTokens=40000]    - Target tokens to free
   * @param {number} [options.keepRecent=6]          - Number of recent tool results to keep intact
   */
  constructor(options = {}) {
    this.triggerTokens = options.triggerTokens || DEFAULT_TRIGGER_TOKENS;
    this.targetTokens = options.targetTokens || DEFAULT_TARGET_TOKENS;
    this.keepRecent = options.keepRecent || DEFAULT_KEEP_RECENT;
    this._lastInputTokens = 0;
  }

  /**
   * Update the last observed input token count from an API response.
   * Call this after every LLM call with the usage data.
   */
  updateTokenCount(usage) {
    if (usage && typeof usage.inputTokens === 'number') {
      this._lastInputTokens = usage.inputTokens;
    } else if (usage && typeof usage.input_tokens === 'number') {
      this._lastInputTokens = usage.input_tokens;
    }
  }

  /**
   * Check if compaction should be triggered based on current token count.
   */
  shouldCompact() {
    return this._lastInputTokens >= this.triggerTokens;
  }

  /**
   * Compact old tool results in the conversation history (in-place mutation).
   *
   * Works with Anthropic message format:
   *  - Assistant messages with tool_use content blocks
   *  - User messages with tool_result content blocks
   *
   * @param {Array} history - conversation message array (mutated in place)
   * @returns {{ cleared: number, freedEstimate: number }} stats
   */
  compact(history) {
    if (!Array.isArray(history)) return { cleared: 0, freedEstimate: 0 };

    // Find all tool_result blocks with their positions
    const toolResults = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (!msg || !Array.isArray(msg.content)) continue;

      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          // Find the matching tool_use to determine the tool name
          const toolName = this._findToolName(history, block.tool_use_id, i);
          toolResults.push({
            msgIndex: i,
            blockIndex: j,
            toolName,
            contentLength: block.content.length,
            clearable: !toolName || CLEARABLE_TOOLS.has(toolName)
          });
        }
      }
    }

    if (toolResults.length <= this.keepRecent) {
      return { cleared: 0, freedEstimate: 0 };
    }

    // Skip the most recent N results
    const candidates = toolResults.slice(0, -this.keepRecent);
    let cleared = 0;
    let freedChars = 0;

    for (const entry of candidates) {
      if (!entry.clearable) continue;

      // Estimate: ~4 chars per token
      const estimatedTokens = Math.ceil(entry.contentLength / 4);
      if (freedChars / 4 >= this.targetTokens && cleared > 0) break;

      const msg = history[entry.msgIndex];
      const block = msg.content[entry.blockIndex];
      const originalLength = block.content.length;

      // Replace content with a compact summary
      block.content = JSON.stringify({
        _compacted: true,
        tool: entry.toolName || 'unknown',
        message: '(tool result cleared to save context — use the tool again if needed)'
      });

      freedChars += originalLength - block.content.length;
      cleared++;
    }

    return {
      cleared,
      freedEstimate: Math.ceil(freedChars / 4) // estimated tokens freed
    };
  }

  /**
   * Also compact OpenAI-format tool results (role='tool').
   * @param {Array} history
   * @returns {{ cleared: number, freedEstimate: number }}
   */
  compactOpenAIFormat(history) {
    if (!Array.isArray(history)) return { cleared: 0, freedEstimate: 0 };

    const toolMsgs = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg?.role === 'tool' && typeof msg.content === 'string') {
        // Look back for the tool name
        const toolName = this._findToolNameOpenAI(history, msg.tool_call_id, i);
        toolMsgs.push({
          index: i,
          toolName,
          contentLength: msg.content.length,
          clearable: !toolName || CLEARABLE_TOOLS.has(toolName)
        });
      }
    }

    if (toolMsgs.length <= this.keepRecent) {
      return { cleared: 0, freedEstimate: 0 };
    }

    const candidates = toolMsgs.slice(0, -this.keepRecent);
    let cleared = 0;
    let freedChars = 0;

    for (const entry of candidates) {
      if (!entry.clearable) continue;
      if (freedChars / 4 >= this.targetTokens && cleared > 0) break;

      const originalLength = history[entry.index].content.length;
      history[entry.index].content = JSON.stringify({
        _compacted: true,
        tool: entry.toolName || 'unknown',
        message: '(tool result cleared to save context)'
      });

      freedChars += originalLength - history[entry.index].content.length;
      cleared++;
    }

    return { cleared, freedEstimate: Math.ceil(freedChars / 4) };
  }

  /**
   * Find the tool name for a tool_use_id by searching backward in Anthropic format.
   */
  _findToolName(history, toolUseId, fromIndex) {
    if (!toolUseId) return null;
    for (let i = fromIndex - 1; i >= 0; i--) {
      const msg = history[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id === toolUseId) {
          return block.name;
        }
      }
    }
    return null;
  }

  /**
   * Find the tool name for a tool_call_id in OpenAI format.
   */
  _findToolNameOpenAI(history, toolCallId, fromIndex) {
    if (!toolCallId) return null;
    for (let i = fromIndex - 1; i >= 0; i--) {
      const msg = history[i];
      if (!msg?.tool_calls) continue;
      for (const tc of msg.tool_calls) {
        if (tc.id === toolCallId) {
          return tc.function?.name;
        }
      }
    }
    return null;
  }
}

module.exports = APICompaction;

const path = require('path');
const VectorStore = require('../memory/vector-store');

class AgentLoop {
  constructor(provider, executor, options = {}) {
    this.provider = provider;
    this.executor = executor;
    this.maxIterations = options.maxIterations || 10;
    this.usageTracker = options.usageTracker || null;
    this.onUsageRecorded = typeof options.onUsageRecorded === 'function'
      ? options.onUsageRecorded
      : null;
    this.abortSignal = options.abortSignal || null;

    // Model tiering: use a cheaper model for tool iterations after the first.
    // The first iteration uses the primary model (for planning/reasoning),
    // subsequent iterations switch to loopModel (for mechanical tool use).
    this.loopModel = options.loopModel || null;

    // Context compaction: truncate old tool results every N iterations
    // to prevent linear context growth. keepRecentResults controls how
    // many recent tool result messages are kept intact.
    this.compactEvery = options.compactEvery ?? 6;
    this.keepRecentResults = options.keepRecentResults ?? 4;

    // Semantic compaction: when an embeddingProvider is available, use
    // semantic search to preserve relevant old results and only compact
    // irrelevant ones. One cheap batch embedding call per compaction cycle.
    this.embeddingProvider = options.embeddingProvider || null;
    this._toolResultEntries = []; // { historyIndex, toolName, text, compacted }
    this._relevanceThreshold = options.relevanceThreshold ?? 0.3;
  }

  /**
   * Check if a tool result is an "access denied" error and, if so, prompt
   * the user to grant directory access for this session.  Returns the
   * retried tool result when access is granted, or the original result
   * (with a directive for the LLM) when denied / unavailable.
   */
  async _handleAccessDenied(toolResult, toolName, parameters, options) {
    const errMsg = toolResult?.error || '';
    if (typeof errMsg !== 'string' || !errMsg.toLowerCase().includes('access denied')) {
      return toolResult; // not an access-denied error
    }

    // Extract the path the tool tried to access from its parameters
    const targetPath = parameters?.file_path || parameters?.cwd || parameters?.path
      || parameters?.searchPath || null;

    if (!targetPath) {
      return {
        ...toolResult,
        _directive: 'The tool was denied access. Tell the user the path is outside the allowed directories.'
      };
    }

    const resolvedDir = path.resolve(
      path.isAbsolute(targetPath) ? targetPath : path.resolve(this.executor.workingDirectory || '.', targetPath)
    );
    // Use the parent directory for file paths (heuristic: if it looks like a file)
    const dirToAllow = path.extname(resolvedDir) ? path.dirname(resolvedDir) : resolvedDir;

    // Ask the user for permission via IPC (mirrors the AskUser pattern)
    const granted = await new Promise((resolve) => {
      const timeoutMs = 2 * 60 * 1000; // 2 minutes
      const timeoutId = setTimeout(() => resolve(false), timeoutMs);

      try {
        const { BrowserWindow } = require('electron');
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          const win = windows[0];
          const { pendingDirectoryAccessResolvers } = require('../../main');
          if (pendingDirectoryAccessResolvers) {
            const requestId = `diraccess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            pendingDirectoryAccessResolvers.set(requestId, {
              directory: dirToAllow,
              resolve: (approved) => {
                clearTimeout(timeoutId);
                resolve(approved);
              }
            });
            win.webContents.send('tool:directoryAccessRequired', {
              requestId,
              directory: dirToAllow,
              toolName
            });
          } else {
            clearTimeout(timeoutId);
            resolve(false);
          }
        } else {
          clearTimeout(timeoutId);
          resolve(false);
        }
      } catch {
        clearTimeout(timeoutId);
        resolve(false);
      }
    });

    if (granted) {
      // Add the directory to the executor's allowed list for this session
      if (!this.executor.allowedDirectories.includes(dirToAllow)) {
        this.executor.allowedDirectories.push(dirToAllow);
      }
      // Retry the tool call now that the directory is allowed
      return this.executor.execute(toolName, parameters, options);
    }

    // User denied — tell the LLM not to retry
    return {
      ...toolResult,
      _directive: 'The user denied access to this directory. Do NOT retry or attempt workarounds. Inform the user that you cannot access this path without permission.'
    };
  }

  async run(messages, tools, options = {}) {
    let iterations = 0;
    const conversationHistory = [...messages];
    const executedTools = [];
    const llmCalls = [];
    // Mutable copy so RequestTools can inject additional tools mid-run
    let activeTools = [...tools];

    while (iterations < this.maxIterations) {
      if (this.abortSignal?.aborted) {
        return {
          type: 'stopped',
          content: '(Session stopped by user)',
          iterations,
          tools: executedTools,
          llm: {
            calls: llmCalls,
            totals: llmCalls.reduce(
              (acc, call) => ({
                inputTokens: acc.inputTokens + (call.inputTokens || 0),
                outputTokens: acc.outputTokens + (call.outputTokens || 0),
                totalTokens: acc.totalTokens + (call.totalTokens || 0),
                costUsd: Number((acc.costUsd + (call.costUsd || 0)).toFixed(8))
              }),
              { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
            )
          }
        };
      }

      iterations += 1;

      // After the first iteration, switch to the cheaper loop model
      const effectiveOptions = (iterations > 1 && this.loopModel)
        ? { ...options, model: this.loopModel }
        : options;

      // Compact old tool results periodically to prevent context bloat
      if (iterations > 1 && this.compactEvery > 0 && (iterations - 1) % this.compactEvery === 0) {
        await this._compactToolResults(conversationHistory);
      }

      const response = await this.provider.sendMessageWithTools(
        conversationHistory,
        activeTools,
        effectiveOptions
      );

      if (response?.llmMetrics) {
        llmCalls.push(response.llmMetrics);

        if (this.usageTracker && typeof this.usageTracker.record === 'function') {
          const usageEvent = this.usageTracker.record({
            provider: response.llmMetrics.provider,
            model: response.llmMetrics.model,
            inputTokens: response.llmMetrics.inputTokens,
            outputTokens: response.llmMetrics.outputTokens,
            totalTokens: response.llmMetrics.totalTokens,
            costUsd: response.llmMetrics.costUsd
          });

          if (this.onUsageRecorded) {
            try {
              this.onUsageRecorded(usageEvent);
            } catch {
              // Non-fatal callback failure should never break the agent loop.
            }
          }
        }
      }

      if (response.type === 'text') {
        const llmTotals = llmCalls.reduce(
          (acc, call) => ({
            inputTokens: acc.inputTokens + (call.inputTokens || 0),
            outputTokens: acc.outputTokens + (call.outputTokens || 0),
            totalTokens: acc.totalTokens + (call.totalTokens || 0),
            costUsd: Number((acc.costUsd + (call.costUsd || 0)).toFixed(8))
          }),
          { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
        );

        return {
          type: 'complete',
          content: response.content,
          iterations,
          tools: executedTools,
          llm: {
            calls: llmCalls,
            totals: llmTotals
          }
        };
      }

      if (response.type === 'tool_use') {
        // Normalize to an array of tool calls (supports both single and multi)
        const calls = response.toolCalls || [{
          toolName: response.toolName,
          toolUseId: response.toolUseId,
          parameters: response.parameters
        }];

        // Execute a single tool call (AskUser or normal tool)
        const executeSingleCall = async (call) => {
          const toolCallId = call.toolUseId ||
            `toolcall-${Date.now()}-${Math.random().toString(16).slice(2)}`;

          let toolResult;

          if (call.toolName === 'AskUser') {
            const question = call.parameters?.question;
            toolResult = await new Promise((resolve) => {
              const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              const timeoutMs = 5 * 60 * 1000;
              const timeoutId = setTimeout(() => {
                resolve({ ok: false, error: 'User did not respond within 5 minutes.' });
              }, timeoutMs);

              try {
                const { BrowserWindow } = require('electron');
                const windows = BrowserWindow.getAllWindows();
                if (windows.length > 0) {
                  const win = windows[0];
                  const { pendingAskUserResolvers } = require('../../main');
                  if (pendingAskUserResolvers) {
                    pendingAskUserResolvers.set(requestId, {
                      resolve: (userResponse) => {
                        clearTimeout(timeoutId);
                        resolve({ ok: true, response: userResponse });
                      }
                    });
                    win.webContents.send('agent:askUser', { requestId, question });
                  } else {
                    clearTimeout(timeoutId);
                    resolve({ ok: false, error: 'pendingAskUserResolvers not available' });
                  }
                } else {
                  clearTimeout(timeoutId);
                  resolve({ ok: false, error: 'No UI available to ask user.' });
                }
              } catch (e) {
                clearTimeout(timeoutId);
                resolve({ ok: false, error: 'Cannot ask user outside of Electron main process.' });
              }
            });
          } else {
            toolResult = await this.executor.execute(
              call.toolName,
              call.parameters,
              options
            );
            toolResult = await this._handleAccessDenied(
              toolResult, call.toolName, call.parameters, options
            );
          }

          return { ...call, toolCallId, result: toolResult };
        };

        // Execute all tool calls in parallel
        const results = await Promise.all(calls.map(executeSingleCall));

        // Process results: merge injected tools and track executed tools
        for (const entry of results) {
          if (Array.isArray(entry.result?._injectedTools) && entry.result._injectedTools.length > 0) {
            const existingNames = new Set(activeTools.map(t => t.name));
            for (const injected of entry.result._injectedTools) {
              if (!existingNames.has(injected.name)) {
                activeTools.push(injected);
                existingNames.add(injected.name);
              }
            }
          }

          executedTools.push({
            name: entry.toolName,
            parameters: entry.parameters,
            result: entry.result
          });
        }

        // Build conversation history messages
        if (results.length > 1 && typeof this.provider.buildMultiToolMessages === 'function') {
          const providerMessages = this.provider.buildMultiToolMessages(response, results);
          conversationHistory.push(...providerMessages);
        } else if (results.length === 1 && typeof this.provider.buildToolMessages === 'function') {
          const entry = results[0];
          const providerMessages = this.provider.buildToolMessages(
            { toolName: entry.toolName, parameters: entry.parameters, messageContent: response.messageContent },
            entry.result,
            entry.toolCallId
          );
          conversationHistory.push(...providerMessages);
        } else if (typeof this.provider.buildMultiToolMessages === 'function') {
          const providerMessages = this.provider.buildMultiToolMessages(response, results);
          conversationHistory.push(...providerMessages);
        } else {
          // Generic fallback for providers without buildToolMessages
          for (const entry of results) {
            conversationHistory.push({
              role: 'assistant',
              content: response.messageContent || '',
              tool_calls: [{
                id: entry.toolCallId,
                type: 'function',
                function: {
                  name: entry.toolName,
                  arguments: JSON.stringify(entry.parameters || {})
                }
              }]
            });
            conversationHistory.push({
              role: 'tool',
              tool_call_id: entry.toolCallId,
              content: JSON.stringify(entry.result)
            });
          }
        }

        // Track tool results for semantic compaction
        for (const entry of results) {
          const resultSnippet = entry.result != null ? JSON.stringify(entry.result).substring(0, 400) : '';
          this._toolResultEntries.push({
            historyIndex: conversationHistory.length - 1,
            toolName: entry.toolName,
            text: `${entry.toolName}: ${resultSnippet}`,
            compacted: false
          });
        }

        continue;
      }

      return {
        type: 'error',
        content: 'Unsupported response type from provider',
        iterations,
        tools: executedTools,
        llm: {
          calls: llmCalls,
          totals: llmCalls.reduce(
            (acc, call) => ({
              inputTokens: acc.inputTokens + (call.inputTokens || 0),
              outputTokens: acc.outputTokens + (call.outputTokens || 0),
              totalTokens: acc.totalTokens + (call.totalTokens || 0),
              costUsd: Number((acc.costUsd + (call.costUsd || 0)).toFixed(8))
            }),
            { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
          )
        }
      };
    }

    return {
      type: 'max_iterations',
      content: 'Maximum tool iterations reached before final answer.',
      iterations,
      tools: executedTools,
      llm: {
        calls: llmCalls,
        totals: llmCalls.reduce(
          (acc, call) => ({
            inputTokens: acc.inputTokens + (call.inputTokens || 0),
            outputTokens: acc.outputTokens + (call.outputTokens || 0),
            totalTokens: acc.totalTokens + (call.totalTokens || 0),
            costUsd: Number((acc.costUsd + (call.costUsd || 0)).toFixed(8))
          }),
          { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
        )
      }
    };
  }

  /**
   * Compact old tool results to reduce context size.
   *
   * When an embeddingProvider is available, uses semantic search to
   * preserve relevant old results (one cheap batch embedding call)
   * and only compacts irrelevant ones. Falls back to recency-only
   * compaction when embeddings are unavailable.
   *
   * Works with both OpenAI format (role='tool') and Anthropic format
   * (role='user' with tool_result content blocks).
   */
  async _compactToolResults(history) {
    if (this._toolResultEntries.length <= this.keepRecentResults) return;

    const recentCutoff = this._toolResultEntries.length - this.keepRecentResults;
    const oldEntries = this._toolResultEntries.slice(0, recentCutoff).filter(e => !e.compacted);

    if (oldEntries.length === 0) return;

    // Try semantic compaction first
    if (this.embeddingProvider) {
      const userQuery = this._extractUserQuery(history);
      if (userQuery) {
        try {
          await this._semanticCompact(history, oldEntries, userQuery);
          return;
        } catch (err) {
          console.warn('[agent-loop] Semantic compaction failed, using recency:', err.message);
        }
      }
    }

    // Fallback: compact all old entries by recency only
    for (const entry of oldEntries) {
      this._truncateAtIndex(history, entry.historyIndex);
      entry.compacted = true;
    }
  }

  /**
   * Semantic compaction: batch-embed old tool results + user query in a
   * single API call, then use cosine similarity to decide what to keep.
   * Results above the relevance threshold are preserved intact; the rest
   * are truncated to status-only summaries.
   */
  async _semanticCompact(history, oldEntries, userQuery) {
    // Single batch embedding: [userQuery, ...toolResultTexts]
    const texts = [userQuery, ...oldEntries.map(e => e.text)];
    const embeddings = await this.embeddingProvider.embed(texts);

    if (!embeddings || embeddings.length < 2) return;

    const queryVector = embeddings[0];

    for (let i = 0; i < oldEntries.length; i++) {
      const resultVector = embeddings[i + 1];
      if (!resultVector) continue;

      const similarity = VectorStore.cosineSimilarity(queryVector, resultVector);
      if (similarity < this._relevanceThreshold) {
        this._truncateAtIndex(history, oldEntries[i].historyIndex);
        oldEntries[i].compacted = true;
      }
    }
  }

  /**
   * Extract the original user query from conversation history.
   * Skips tool_result user messages (Anthropic format).
   */
  _extractUserQuery(history) {
    for (const msg of history) {
      if (msg.sender === 'user' && typeof msg.text === 'string') return msg.text;
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') return msg.content;
        // Skip Anthropic tool_result messages
        if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) continue;
        if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find(b => b.type === 'text');
          if (textBlock?.text) return textBlock.text;
        }
      }
    }
    return '';
  }

  /**
   * Truncate a tool result message at a specific history index.
   * Handles both OpenAI and Anthropic message formats.
   */
  _truncateAtIndex(history, idx) {
    const msg = history[idx];
    if (!msg) return;

    // OpenAI format
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      history[idx] = { ...msg, content: this._truncateToolContent(msg.content) };
      return;
    }

    // Anthropic format
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      history[idx] = {
        ...msg,
        content: msg.content.map(block => {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            return { ...block, content: this._truncateToolContent(block.content) };
          }
          return block;
        })
      };
    }
  }

  /**
   * Reduce a JSON-stringified tool result to its essential fields.
   * Drops large payloads like page HTML, DOM snapshots, and complex
   * result objects while preserving status and error info.
   */
  _truncateToolContent(jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      const compact = { ok: parsed.ok };
      if (parsed.message) compact.message = String(parsed.message).substring(0, 150);
      if (parsed.error) compact.error = String(parsed.error).substring(0, 150);
      if (parsed.result !== undefined) {
        const r = parsed.result;
        if (r === null || typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean') {
          compact.result = typeof r === 'string' ? r.substring(0, 200) : r;
        } else {
          compact.result = '(compacted)';
        }
      }
      // Verbose properties (page, html, savedTo, etc.) are intentionally dropped
      return JSON.stringify(compact);
    } catch {
      return jsonStr.substring(0, 200) + (jsonStr.length > 200 ? '...' : '');
    }
  }
}

module.exports = AgentLoop;

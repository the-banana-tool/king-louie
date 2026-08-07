const path = require('path');
const VectorStore = require('../memory/vector-store');
const ResultPersistence = require('./result-persistence');
const APICompaction = require('../context/api-compaction');
const { FailoverPolicy } = require('../providers/failover-policy');
const { createLogger } = require('../logging');
const log = createLogger('agent-loop');

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

    // Shared with InferenceRouter so "what is worth retrying" has exactly
    // one definition in the codebase.
    this.failoverPolicy = options.failoverPolicy || new FailoverPolicy(options.failover || {});

    // Streaming callback: fires with text deltas during LLM inference.
    // Enables real-time UI updates during agent loop iterations instead
    // of waiting for the full response to complete.
    this.onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;

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

    // API-native compaction: clears old tool_result content blocks when
    // input tokens approach the limit. No embedding calls needed. Used
    // for Anthropic provider; falls back to semantic compaction for others.
    this.apiCompaction = options.apiCompaction || new APICompaction({
      triggerTokens: options.compactionTriggerTokens || 150000,
      targetTokens: options.compactionTargetTokens || 40000,
      keepRecent: options.keepRecentResults ?? 6
    });
    // Enable API compaction for Anthropic provider by default
    this.useAPICompaction = options.useAPICompaction
      ?? (provider?.getProviderName?.() === 'anthropic');

    // Deduplicate in-flight directory access prompts. When multiple parallel
    // tool calls hit the same denied directory in the same turn, they all
    // await the same promise instead of spamming the user with N prompts.
    // Key: normalized absolute directory path. Value: Promise<boolean>.
    this._pendingDirectoryAccess = new Map();

    // Persist oversized tool results to disk so the conversation history
    // stays compact without losing data. The model still sees a preview
    // and a [persisted: <path>] marker; it can Read the file if needed.
    this.resultPersistence = options.resultPersistence
      || new ResultPersistence({
        baseDir: options.toolResultsDir || null,
        thresholdChars: options.resultPersistenceThreshold || 50000
      });
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
    const dirKey = path.normalize(dirToAllow);

    // Fast-path: a concurrent sibling call may have already been granted
    // access to this directory before we got here. If so, retry immediately.
    if (this.executor.allowedDirectories.includes(dirToAllow)) {
      return this.executor.execute(toolName, parameters, options);
    }

    // Dedup: if another parallel tool call is already awaiting the user's
    // decision for this same directory, piggyback on its promise instead of
    // opening a second prompt.
    let grantedPromise = this._pendingDirectoryAccess.get(dirKey);
    if (!grantedPromise) {
      grantedPromise = new Promise((resolve) => {
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
      this._pendingDirectoryAccess.set(dirKey, grantedPromise);
      // Clean up the entry once resolved so a later denial of a different
      // directory doesn't get stuck on an old promise.
      grantedPromise.finally(() => {
        if (this._pendingDirectoryAccess.get(dirKey) === grantedPromise) {
          this._pendingDirectoryAccess.delete(dirKey);
        }
      });
    }

    const granted = await grantedPromise;

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
    // One run() is one turn: a single user message worked to completion,
    // however many tool iterations that takes. Checkpoints latch on this so
    // the whole turn is undone as a unit, not iteration by iteration.
    const turnId = options.turnId
      || `turn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

      // Compact old tool results to prevent context bloat.
      // API compaction (Anthropic): triggered by token count threshold.
      // Semantic compaction (fallback): triggered every N iterations.
      if (this.useAPICompaction && this.apiCompaction && this.apiCompaction.shouldCompact()) {
        const stats = this.apiCompaction.compact(conversationHistory);
        if (stats.cleared === 0) {
          // Try OpenAI format as fallback
          const openaiStats = this.apiCompaction.compactOpenAIFormat(conversationHistory);
          if (openaiStats.cleared > 0) {
            log.info(`API compaction: cleared ${openaiStats.cleared} tool results (~${openaiStats.freedEstimate} tokens freed)`);
          }
        } else {
          log.info(`API compaction: cleared ${stats.cleared} tool results (~${stats.freedEstimate} tokens freed)`);
        }
      } else if (iterations > 1 && this.compactEvery > 0 && (iterations - 1) % this.compactEvery === 0) {
        await this._compactToolResults(conversationHistory);
      }

      // Retry transient upstream failures so a mid-loop hiccup doesn't
      // discard the exploration so far. What counts as transient — and how
      // long to wait — comes from the shared failover policy rather than a
      // local substring check, so a provider's own `retry-after` is honored
      // and a permanent failure (bad auth, oversized context) stops
      // immediately instead of burning four attempts on a certainty.
      const maxAttempts = 4;
      const attemptsByReason = {};
      let response;
      let lastErr;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this.abortSignal?.aborted) break;
        try {
          // Use streaming when an onChunk callback is provided and the
          // provider supports it. This gives real-time text feedback in
          // the UI during agent loop iterations.
          const canStream = this.onChunk
            && typeof this.provider.streamMessageWithTools === 'function';
          if (canStream) {
            response = await this.provider.streamMessageWithTools(
              conversationHistory,
              activeTools,
              effectiveOptions,
              this.onChunk
            );
          } else {
            response = await this.provider.sendMessageWithTools(
              conversationHistory,
              activeTools,
              effectiveOptions
            );
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;

          const plan = this.failoverPolicy.plan(err, {
            totalAttempts: attempt,
            attemptsByReason,
            provider: this.provider?.getProviderName?.(),
            model: effectiveOptions.model || options.model,
            aborted: this.abortSignal?.aborted
          });
          attemptsByReason[plan.reason] = (attemptsByReason[plan.reason] || 0) + 1;

          const canRetry = plan.action === 'retry' && attempt < maxAttempts;
          if (!canRetry) {
            const usedModel = effectiveOptions.model || options.model || '(default)';
            const wrapped = new Error(
              `Provider call failed (iteration ${iterations}, model "${usedModel}"): ${err.message || err}`
            );
            wrapped.cause = err;
            wrapped.failoverReason = plan.reason;
            throw wrapped;
          }

          const waitMs = plan.waitMs || 1000 * Math.pow(2, attempt - 1);
          log.warn(
            `Transient provider error [${plan.reason}] (attempt ${attempt}/${maxAttempts}): `
            + `${err.message}. Retrying in ${waitMs}ms…`
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
      if (lastErr) throw lastErr;

      if (response?.llmMetrics) {
        llmCalls.push(response.llmMetrics);

        // Feed token count to API compaction tracker
        if (this.useAPICompaction && this.apiCompaction) {
          this.apiCompaction.updateTokenCount(response.llmMetrics);
        }

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

        // Per-turn options propagated to every tool call. The abort signal
        // is forwarded so cancelling the loop tears down in-flight tools
        // (Bash subprocess, WebFetch, etc.) instead of letting them run on.
        const callOptions = {
          ...options,
          turnId,
          signal: this.abortSignal || options.signal || null
        };

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
              callOptions
            );
            toolResult = await this._handleAccessDenied(
              toolResult, call.toolName, call.parameters, callOptions
            );
          }

          return { ...call, toolCallId, result: toolResult };
        };

        // Concurrency-safety partitioning. Read-only / idempotent tools
        // (Read, Glob, Grep, WebFetch, WebSearch) run in parallel; tools
        // with side effects (Edit, Write, Bash, Git, Browser, ...) run
        // serially after the safe batch so two parallel Edit calls on the
        // same file can't corrupt it. AskUser is always serial — only one
        // user prompt at a time.
        const isSafe = (call) => {
          if (call.toolName === 'AskUser') return false;
          const tool = this.executor && this.executor.toolRegistry
            ? this.executor.toolRegistry.get(call.toolName)
            : null;
          // Fall back to the global registry if executor doesn't expose one.
          const resolved = tool || require('../tools').toolRegistry.get(call.toolName);
          return Boolean(resolved && resolved.concurrencySafe);
        };

        const safeCalls = calls.filter(isSafe);
        const unsafeCalls = calls.filter((c) => !isSafe(c));

        const safeResults = await Promise.all(safeCalls.map(executeSingleCall));
        const unsafeResults = [];
        for (const call of unsafeCalls) {
          // Bail out of the unsafe queue on abort — no point starting a new
          // subprocess after the user has cancelled the turn.
          if (callOptions.signal?.aborted) {
            unsafeResults.push({
              ...call,
              toolCallId: call.toolUseId || `toolcall-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              result: { success: false, error: 'Cancelled before execution', cancelled: true }
            });
            continue;
          }
          unsafeResults.push(await executeSingleCall(call));
        }

        // Re-order results to match the model's original call order so the
        // tool_result blocks the provider sees line up with the tool_use
        // blocks the model emitted. Otherwise downstream message-builders
        // pair them up wrong.
        const byId = new Map();
        for (const r of [...safeResults, ...unsafeResults]) {
          byId.set(r.toolUseId || r.toolCallId, r);
        }
        const results = calls.map((call) => {
          const id = call.toolUseId;
          if (id && byId.has(id)) return byId.get(id);
          // Fall back to first match by toolName for providers that don't
          // emit toolUseId (rare).
          for (const r of byId.values()) {
            if (r.toolName === call.toolName) {
              byId.delete(r.toolUseId || r.toolCallId);
              return r;
            }
          }
          return null;
        }).filter(Boolean);

        // Persist oversized results to disk and replace inline payloads
        // with a [persisted: <path>] preview. The model still sees the
        // shape and a head excerpt and can Read the file if needed —
        // unlike the lossy regex-based compaction which dropped fields.
        const persistCtx = { sessionId: options.sessionId || options.chatId || null };
        for (const entry of results) {
          entry.result = this.resultPersistence.persistResultObject(entry.result, {
            ...persistCtx,
            toolName: entry.toolName
          });
        }

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
          log.warn(`Semantic compaction failed, using recency: ${err.message}`);
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

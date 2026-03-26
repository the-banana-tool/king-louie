const path = require('path');

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

      const response = await this.provider.sendMessageWithTools(
        conversationHistory,
        tools,
        options
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
        const toolCallId =
          response.toolUseId ||
          `toolcall-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        let toolResult;

        if (response.toolName === 'AskUser') {
          // Special handling for AskUser tool
          const question = response.parameters?.question;

          toolResult = await new Promise((resolve, reject) => {
            const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timeoutMs = 5 * 60 * 1000; // 5 minutes

            const timeoutId = setTimeout(() => {
              // Only cleanup if we actually emitted the event
              // Cleanup is handled by the main process IPC handler when it resolves
              resolve({ ok: false, error: 'User did not respond within 5 minutes.' });
            }, timeoutMs);

            // Send IPC message to the renderer to show the prompt
            // Check if we are running in the main process
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
              // Not in electron main process context (e.g. tests)
              clearTimeout(timeoutId);
              resolve({ ok: false, error: 'Cannot ask user outside of Electron main process.' });
            }
          });
        } else {
          toolResult = await this.executor.execute(
            response.toolName,
            response.parameters,
            options
          );

          // If access was denied, prompt user and optionally retry
          toolResult = await this._handleAccessDenied(
            toolResult, response.toolName, response.parameters, options
          );
        }

        executedTools.push({
          name: response.toolName,
          parameters: response.parameters,
          result: toolResult
        });

        if (typeof this.provider.buildToolMessages === 'function') {
          const providerMessages = this.provider.buildToolMessages(
            response,
            toolResult,
            toolCallId
          );
          conversationHistory.push(...providerMessages);
        } else {
          conversationHistory.push({
            role: 'assistant',
            content: response.messageContent || '',
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: response.toolName,
                  arguments: JSON.stringify(response.parameters || {})
                }
              }
            ]
          });

          conversationHistory.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(toolResult)
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
}

module.exports = AgentLoop;

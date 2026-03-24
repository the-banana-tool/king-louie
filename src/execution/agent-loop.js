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

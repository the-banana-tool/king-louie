class AgentLoop {
  constructor(provider, executor, options = {}) {
    this.provider = provider;
    this.executor = executor;
    this.maxIterations = options.maxIterations || 10;
    this.usageTracker = options.usageTracker || null;
    this.onUsageRecorded = typeof options.onUsageRecorded === 'function'
      ? options.onUsageRecorded
      : null;
  }

  async run(messages, tools, options = {}) {
    let iterations = 0;
    const conversationHistory = [...messages];
    const executedTools = [];
    const llmCalls = [];

    while (iterations < this.maxIterations) {
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

        const toolResult = await this.executor.execute(
          response.toolName,
          response.parameters,
          options
        );

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

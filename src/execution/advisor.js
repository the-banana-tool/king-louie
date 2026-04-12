/**
 * Advisor — optional second-model code review for agent output.
 *
 * After an agent loop completes, the advisor reviews the generated code
 * changes and provides feedback. This catches bugs, security issues, and
 * style violations before they land.
 *
 * The advisor runs as a single LLM call (no tools) with a focused review
 * prompt. Its cost is tracked separately from the main agent.
 *
 * Configuration:
 *   settings.advisor = {
 *     enabled: true,
 *     model: 'claude-sonnet-4-20250514',  // or any available model
 *     provider: 'anthropic'               // optional provider override
 *   }
 */

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer. Review the code changes described below and provide concise, actionable feedback.

Focus on:
1. **Bugs** — logic errors, off-by-one, null/undefined issues, race conditions
2. **Security** — injection vulnerabilities, exposed secrets, unsafe patterns
3. **Performance** — unnecessary allocations, O(n²) loops, missing caching
4. **Correctness** — does the implementation match the stated intent?

Format: Start with a one-line verdict (LGTM / ISSUES FOUND), then list issues as bullet points with file:line references when possible. Be specific and concise — no generic advice.

If the changes look good, say "LGTM" and optionally note what was done well.`;

class Advisor {
  /**
   * @param {object} options
   * @param {object} options.provider - LLM provider instance for the advisor
   * @param {string} [options.model] - model to use for review
   * @param {object} [options.usageTracker] - usage tracker for cost tracking
   */
  constructor(options = {}) {
    this.provider = options.provider;
    this.model = options.model || null;
    this.usageTracker = options.usageTracker || null;
  }

  /**
   * Review the output of an agent loop.
   *
   * @param {object} agentResult - the result from AgentLoop.run()
   * @param {object} [context] - additional context
   * @param {string} [context.userMessage] - the original user request
   * @param {string} [context.systemPrompt] - the system prompt used
   * @returns {{ review: string, verdict: string, llmMetrics: object|null }}
   */
  async review(agentResult, context = {}) {
    if (!this.provider || typeof this.provider.sendMessage !== 'function') {
      return { review: null, verdict: null, llmMetrics: null, error: 'No provider configured' };
    }

    // Build the review prompt from agent results
    const toolSummary = this._buildToolSummary(agentResult);
    const reviewPrompt = this._buildReviewPrompt(agentResult, toolSummary, context);

    try {
      const messages = [{ role: 'user', content: reviewPrompt }];
      const options = {
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        model: this.model,
        temperature: 0.3,
        max_tokens: 2048
      };

      // Use sendMessage (no tools needed for review)
      const reviewText = await this.provider.sendMessage(messages, options);

      // Extract verdict from first line
      const firstLine = (reviewText || '').split('\n')[0].trim().toUpperCase();
      const verdict = firstLine.includes('LGTM') ? 'LGTM' : 'ISSUES_FOUND';

      // Track cost separately
      let llmMetrics = null;
      if (this.usageTracker && typeof this.provider.buildLlmCallMetrics === 'function') {
        // Note: sendMessage doesn't return metrics directly in most providers
        // This is a best-effort cost annotation
        llmMetrics = { provider: this.provider.getProviderName?.() || 'unknown', model: this.model, advisor: true };
      }

      return {
        review: reviewText,
        verdict,
        llmMetrics
      };
    } catch (err) {
      return {
        review: null,
        verdict: null,
        llmMetrics: null,
        error: `Advisor review failed: ${err.message}`
      };
    }
  }

  /**
   * Build a summary of tool calls from the agent result.
   */
  _buildToolSummary(agentResult) {
    const tools = agentResult?.tools || [];
    if (tools.length === 0) return 'No tool calls were made.';

    const lines = [];
    for (const tool of tools) {
      if (tool.name === 'Edit' || tool.name === 'MultiEdit') {
        const diff = tool.result?.diff;
        if (diff) {
          lines.push(`**${tool.name}** on ${tool.result?.filePath || tool.parameters?.file_path}:`);
          lines.push('```diff');
          lines.push(diff.substring(0, 2000));
          lines.push('```');
        } else {
          lines.push(`**${tool.name}** on ${tool.parameters?.file_path}: ${tool.result?.success ? 'success' : 'failed'}`);
        }
      } else if (tool.name === 'Write') {
        const diff = tool.result?.diff;
        if (diff) {
          lines.push(`**Write** ${tool.result?.isNew ? 'created' : 'overwrote'} ${tool.parameters?.file_path}:`);
          lines.push('```diff');
          lines.push(diff.substring(0, 2000));
          lines.push('```');
        } else {
          lines.push(`**Write** ${tool.result?.isNew ? 'created' : 'overwrote'} ${tool.parameters?.file_path}`);
        }
      } else if (tool.name === 'Bash') {
        const cmd = tool.parameters?.command;
        if (cmd) lines.push(`**Bash**: \`${cmd.substring(0, 200)}\``);
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'Tool calls had no reviewable changes.';
  }

  /**
   * Build the full review prompt.
   */
  _buildReviewPrompt(agentResult, toolSummary, context) {
    const parts = [];

    if (context.userMessage) {
      parts.push(`## User Request\n${context.userMessage.substring(0, 500)}`);
    }

    parts.push(`## Agent Response\n${(agentResult.content || '').substring(0, 1000)}`);
    parts.push(`## Code Changes\n${toolSummary}`);
    parts.push(`## Review Instructions\nReview the code changes above. Focus on bugs, security, and correctness.`);

    return parts.join('\n\n');
  }
}

module.exports = Advisor;

const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');
const { getRuntimeEnvironment } = require('./runtime-environment');
const { evaluateRules, describeRule } = require('../tools/permission-rules');

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.allowedDirectories = options.allowedDirectories || [];
    this.requireApproval = options.requireApproval !== false;
    this.approvalRequester =
      typeof options.approvalRequester === 'function'
        ? options.approvalRequester
        : null;
    this.shouldAutoApprove =
      typeof options.shouldAutoApprove === 'function'
        ? options.shouldAutoApprove
        : async () => false;
    this.runtimeEnvironmentPromise =
      options.runtimeEnvironment
        ? Promise.resolve(options.runtimeEnvironment)
        : getRuntimeEnvironment({ workingDirectory: this.workingDirectory });
    this.hookExecutor = options.hookExecutor || null;
    this.useSandbox = options.useSandbox !== false;
    // Extra options passed to every tool execution (e.g., agentExecutorAdapter for SpawnAgent)
    this.extraToolOptions = options.extraToolOptions || {};
    // Pattern-based permission rules. First-match-wins; falls back to the
    // tool's `requiresApproval` flag when nothing matches. See
    // src/tools/permission-rules.js.
    this.permissionRules = Array.isArray(options.permissionRules)
      ? options.permissionRules
      : [];
  }

  setPermissionRules(rules) {
    this.permissionRules = Array.isArray(rules) ? rules : [];
  }

  addPermissionRule(rule) {
    if (!rule || !rule.tool) return;
    this.permissionRules.push(rule);
  }

  async getRuntimeEnvironment() {
    return this.runtimeEnvironmentPromise;
  }

  async execute(toolName, parameters = {}, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    let effectiveParameters = parameters;
    let preHookResult = null;

    if (this.hookExecutor && typeof this.hookExecutor.run === 'function') {
      preHookResult = await this.hookExecutor.run('PreToolUse', {
        toolName,
        parameters,
        options,
        workingDirectory: options.workingDirectory || this.workingDirectory
      });

      const action = String(preHookResult?.action || 'allow').toLowerCase();
      if (action === 'deny') {
        const denied = {
          success: false,
          error: preHookResult?.message || `Tool execution blocked by policy: ${toolName}`,
          blockedByHook: true,
          hookResults: preHookResult?.results || []
        };
        this.emit('postExecute', { toolName, parameters, result: denied });
        return denied;
      }

      if (action === 'confirm') {
        const approved = await this.requestApproval(toolName, parameters, {
          reason: preHookResult?.message || 'Hook policy requires explicit confirmation.'
        });

        if (!approved) {
          const denied = {
            success: false,
            error: 'User denied permission',
            blockedByHook: true,
            hookResults: preHookResult?.results || []
          };
          this.emit('postExecute', { toolName, parameters, result: denied });
          return denied;
        }
      }

      effectiveParameters = preHookResult?.context?.parameters || effectiveParameters;
    }

    this.emit('preExecute', { toolName, parameters: effectiveParameters });

    try {
      tool.validateParameters(effectiveParameters);
    } catch (validationError) {
      const errorResult = { success: false, error: validationError.message };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: errorResult });
      return errorResult;
    }

    if (tool.isDangerous(effectiveParameters) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${toolName}`);
    }

    // Pattern-based rules take precedence over the per-tool flag and the
    // global auto-approve list. A matched rule short-circuits the rest of
    // the approval pipeline. The rule's source travels with the decision
    // for telemetry / audit.
    const ruleMatch = evaluateRules(this.permissionRules, toolName, effectiveParameters);
    let approvalSource = null;

    if (ruleMatch.matched) {
      if (ruleMatch.action === 'deny') {
        const denied = {
          success: false,
          error: `Blocked by rule: ${describeRule(ruleMatch.rule)}`,
          deniedBy: 'rule',
          rule: { tool: ruleMatch.rule.tool, pattern: ruleMatch.rule.pattern, source: ruleMatch.rule.source }
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
        return denied;
      }
      if (ruleMatch.action === 'allow') {
        approvalSource = { type: 'rule', rule: describeRule(ruleMatch.rule) };
        this.emit('approvalAutoGranted', {
          toolName,
          parameters: effectiveParameters,
          source: approvalSource
        });
      }
      // 'ask' falls through to the regular approval flow below.
    }

    const ruleSaysAsk = ruleMatch.matched && ruleMatch.action === 'ask';
    const ruleSaysAllow = ruleMatch.matched && ruleMatch.action === 'allow';
    const needsApprovalGate = ruleSaysAsk || (!ruleMatch.matched && tool.requiresApproval && this.requireApproval);

    if (needsApprovalGate && !ruleSaysAllow) {
      const autoApproved = await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = Array.isArray(options.autoApproveTools)
        && options.autoApproveTools.includes(toolName);

      if (autoApproved || agentAutoApproved) {
        approvalSource = { type: agentAutoApproved ? 'agent-config' : 'global-auto-approve' };
        this.emit('approvalAutoGranted', {
          toolName,
          parameters: effectiveParameters,
          source: approvalSource
        });
      }

      if (!autoApproved && !agentAutoApproved) {
        const approved = await this.requestApproval(toolName, effectiveParameters, {
          ruleHint: ruleSaysAsk ? describeRule(ruleMatch.rule) : null
        });
        if (!approved) {
          const denied = { success: false, error: 'User denied permission', deniedBy: 'user' };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
        approvalSource = { type: 'user' };
      }
    }

    // Pre-execution abort check: a turn cancelled while we were awaiting
    // an approval prompt should not then run the tool.
    if (options.signal?.aborted) {
      const cancelled = { success: false, error: 'Cancelled before execution', cancelled: true };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: cancelled });
      return cancelled;
    }

    try {
      const runtimeEnvironment = await this.getRuntimeEnvironment();
      const result = await tool.execute(effectiveParameters, {
        ...this.extraToolOptions,
        ...options,
        workingDirectory: options.workingDirectory || this.workingDirectory,
        allowedDirectories: options.allowedDirectories || this.allowedDirectories,
        runtimeEnvironment,
        useSandbox: this.useSandbox,
        // Forward turn-level cancellation. Tools that respect this (Bash,
        // WebFetch) tear down their work on abort instead of running on.
        signal: options.signal || null
      });

      if (this.hookExecutor && typeof this.hookExecutor.run === 'function') {
        const postHookResult = await this.hookExecutor.run('PostToolUse', {
          toolName,
          parameters: effectiveParameters,
          result,
          options,
          workingDirectory: options.workingDirectory || this.workingDirectory,
          preHookResult
        });

        if (postHookResult?.context?.result) {
          this.emit('postExecute', {
            toolName,
            parameters: effectiveParameters,
            result: postHookResult.context.result
          });
          return postHookResult.context.result;
        }
      }

      this.emit('postExecute', { toolName, parameters: effectiveParameters, result });
      return result;
    } catch (error) {
      const errorResult = { success: false, error: error.message };
      if (this.listenerCount('toolError') > 0) {
        this.emit('toolError', { toolName, parameters: effectiveParameters, error });
      }
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: errorResult });
      return errorResult;
    }
  }

  async requestApproval(toolName, parameters, metadata = {}) {
    if (this.approvalRequester) {
      return this.approvalRequester(toolName, parameters, metadata);
    }

    if (this.listenerCount('approvalRequired') === 0) {
      return false;
    }

    return new Promise((resolve) => {
      this.emit('approvalRequired', { toolName, parameters, metadata, resolve });
    });
  }
}

module.exports = ToolExecutor;

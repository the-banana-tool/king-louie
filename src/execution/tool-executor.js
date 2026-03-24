const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');
const { getRuntimeEnvironment } = require('./runtime-environment');

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory || process.cwd();
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

    tool.validateParameters(effectiveParameters);

    if (tool.isDangerous(effectiveParameters) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${toolName}`);
    }

    if (tool.requiresApproval && this.requireApproval) {
      const autoApproved = await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = Array.isArray(options.autoApproveTools)
        && options.autoApproveTools.includes(toolName);

      if (autoApproved || agentAutoApproved) {
        this.emit('approvalAutoGranted', { toolName, parameters: effectiveParameters });
      }

      if (!autoApproved && !agentAutoApproved) {
        const approved = await this.requestApproval(toolName, effectiveParameters);
        if (!approved) {
          const denied = { success: false, error: 'User denied permission' };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
      }
    }

    try {
      const runtimeEnvironment = await this.getRuntimeEnvironment();
      const result = await tool.execute(effectiveParameters, {
        ...options,
        workingDirectory: options.workingDirectory || this.workingDirectory,
        runtimeEnvironment
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
      this.emit('error', { toolName, parameters: effectiveParameters, error });
      return { success: false, error: error.message };
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

const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.requireApproval = options.requireApproval !== false;
  }

  async execute(toolName, parameters = {}, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    this.emit('preExecute', { toolName, parameters });

    tool.validateParameters(parameters);

    if (tool.isDangerous(parameters) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${toolName}`);
    }

    if (tool.requiresApproval && this.requireApproval) {
      const approved = await this.requestApproval(toolName, parameters);
      if (!approved) {
        const denied = { success: false, error: 'User denied permission' };
        this.emit('postExecute', { toolName, parameters, result: denied });
        return denied;
      }
    }

    try {
      const result = await tool.execute(parameters, {
        ...options,
        workingDirectory: options.workingDirectory || this.workingDirectory
      });

      this.emit('postExecute', { toolName, parameters, result });
      return result;
    } catch (error) {
      this.emit('error', { toolName, parameters, error });
      return { success: false, error: error.message };
    }
  }

  async requestApproval(toolName, parameters) {
    return new Promise((resolve) => {
      this.emit('approvalRequired', { toolName, parameters, resolve });
    });
  }
}

module.exports = ToolExecutor;

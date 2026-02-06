const { Tool } = require('./tool-schema');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!(tool instanceof Tool)) {
      throw new Error('Must register Tool instance');
    }
    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }

  getFunctionDefinitions() {
    return this.list().map((tool) => tool.toFunctionDefinition());
  }

  async execute(name, parameters, options = {}) {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    tool.validateParameters(parameters || {});

    if (tool.isDangerous(parameters || {}) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${name}`);
    }

    return tool.execute(parameters || {}, options);
  }
}

const registry = new ToolRegistry();

module.exports = {
  ToolRegistry,
  registry
};

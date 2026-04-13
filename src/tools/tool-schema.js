class Tool {
  constructor(config = {}) {
    if (!config.name) throw new Error('Tool name is required');
    if (typeof config.execute !== 'function') throw new Error(`Tool execute handler is required for ${config.name}`);

    this.name = config.name;
    this.description = config.description || '';
    this.parameters = config.parameters || { type: 'object', properties: {} };
    this.execute = config.execute;
    this.requiresApproval = Boolean(config.requiresApproval);
    this.dangerousPatterns = Array.isArray(config.dangerousPatterns) ? config.dangerousPatterns : [];
    // Concurrency-safe tools (read-only, idempotent, no shared mutable
    // state) can run in parallel within a single LLM turn. Unsafe tools
    // (writes, subprocesses, stateful side effects) are serialized so two
    // parallel Edit calls on the same file can't corrupt it. Default false
    // — opt in explicitly. AgentLoop partitions accordingly.
    this.concurrencySafe = config.concurrencySafe === true;
  }

  toFunctionDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    };
  }

  validateParameters(params = {}) {
    const schema = this.parameters || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const field of required) {
      if (!(field in params)) {
        throw new Error(`Missing required parameter: ${field}`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, descriptor] of Object.entries(properties)) {
      if (!(key in params) || params[key] === undefined || params[key] === null) continue;

      const value = params[key];
      if (!descriptor.type) continue;

      const typeOk =
        (descriptor.type === 'string' && typeof value === 'string') ||
        (descriptor.type === 'number' && typeof value === 'number') ||
        (descriptor.type === 'boolean' && typeof value === 'boolean') ||
        (descriptor.type === 'array' && Array.isArray(value)) ||
        (descriptor.type === 'object' && typeof value === 'object' && !Array.isArray(value));

      if (!typeOk) {
        throw new Error(`Invalid type for parameter '${key}'. Expected ${descriptor.type}.`);
      }

      if (Array.isArray(descriptor.enum) && !descriptor.enum.includes(value)) {
        throw new Error(`Invalid value for parameter '${key}'. Expected one of: ${descriptor.enum.join(', ')}`);
      }

      if (descriptor.type === 'number') {
        if (typeof descriptor.minimum === 'number' && value < descriptor.minimum) {
          throw new Error(`Parameter '${key}' must be >= ${descriptor.minimum}`);
        }
        if (typeof descriptor.maximum === 'number' && value > descriptor.maximum) {
          throw new Error(`Parameter '${key}' must be <= ${descriptor.maximum}`);
        }
      }
    }
  }

  isDangerous(params = {}) {
    const value = JSON.stringify(params);
    return this.dangerousPatterns.some((pattern) => pattern.test(value));
  }
}

module.exports = { Tool };

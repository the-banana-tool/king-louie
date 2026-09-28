class Agent {
  constructor(config = {}) {
    if (!config.id) {
      throw new Error('Agent id is required');
    }

    this.id = config.id;
    this.name = config.name || config.id;
    this.description = config.description || '';
    // An agent never fixes a model: the profile's role decides (models spec
    // 2026-09-27 §8). A pre-M2 tier on a user-defined agent is read as the
    // mapped role when it names no role (§13 step 5).
    this.model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : null;
    this.inferenceTier = typeof config.inferenceTier === 'string' && config.inferenceTier.trim() ? config.inferenceTier.trim() : null;
    // The agent's model role (models spec 2026-09-27 §8). A user-defined
    // agent without one has its inferenceTier read as the mapped role (§13).
    this.role = typeof config.role === 'string' && config.role.trim() ? config.role.trim() : null;
    this.systemPromptTemplate = config.systemPromptTemplate || null;
    this.systemPrompt = config.systemPrompt || 'You are a helpful assistant.';
    this.allowedTools = Array.isArray(config.allowedTools) ? config.allowedTools : [];
    this.autoApproveTools = Array.isArray(config.autoApproveTools) ? config.autoApproveTools : [];
    // readOnly agents (e.g. the planner) must never be handed mutating tools.
    // AgentExecutor enforces this defensively even if a caller passes a tool
    // list that bypasses allowedTools — the planner is exploration-only and
    // any Write/Edit/Bash/Git slip-through is a bug.
    this.readOnly = config.readOnly === true;
    // An agent whose answer is a summary for another agent (the explorer,
    // models spec 2026-09-27 §8.1): SpawnAgent caps it at
    // models.explorer.summaryMaxTokens.
    this.returnsSummary = config.returnsSummary === true;
    this.temperature = typeof config.temperature === 'number' ? config.temperature : 0.7;
    this.maxIterations = Number.isInteger(config.maxIterations) ? config.maxIterations : 10;
    this.voice = Agent.normalizeVoiceConfig(config.voice);
  }

  static normalizeVoiceConfig(voiceConfig = {}) {
    const source = voiceConfig && typeof voiceConfig === 'object' ? voiceConfig : {};
    const engine = String(source.engine || '').trim().toLowerCase();
    const mode = String(source.mode || '').trim().toLowerCase();

    return {
      enabled: source.enabled === true,
      engine: ['system', 'elevenlabs'].includes(engine) ? engine : null,
      voiceId: String(source.voiceId || source.voice || '').trim() || null,
      mode: ['summary', 'full'].includes(mode) ? mode : 'summary',
      speed:
        typeof source.speed === 'number' && Number.isFinite(source.speed)
          ? source.speed
          : null,
      stability:
        typeof source.stability === 'number' && Number.isFinite(source.stability)
          ? source.stability
          : null,
      style:
        typeof source.style === 'number' && Number.isFinite(source.style)
          ? source.style
          : null
    };
  }

  canUseTool(toolName) {
    if (this.allowedTools.includes('*')) return true;
    return this.allowedTools.includes(toolName);
  }

  getSystemMessage() {
    return {
      role: 'system',
      content: this.systemPrompt
    };
  }
}

module.exports = Agent;
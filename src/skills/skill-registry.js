const { Skill } = require('./skill-interface');
const ResolutionChain = require('./resolution-chain');

/**
 * Registry for managing loaded skills
 */
class SkillRegistry {
  constructor() {
    this.skills = new Map(); // id -> skill instance
    this.commandMap = new Map(); // command -> skill id
    this.lastResolutionBySkill = new Map();
    this.resolutionChain = new ResolutionChain();
  }

  /**
   * Register a skill
   *
   * @param {Skill} skill - Skill instance
   * @throws {Error} if skill doesn't implement required interface
   */
  register(skill) {
    const metadata = skill.getMetadata();

    if (!metadata.id || !metadata.name || !metadata.commands) {
      throw new Error(`Invalid skill metadata: ${JSON.stringify(metadata)}`);
    }

    if (this.skills.has(metadata.id)) {
      throw new Error(`Skill ${metadata.id} is already registered`);
    }

    // Map commands to this skill
    for (const command of metadata.commands) {
      if (this.commandMap.has(command)) {
        throw new Error(
          `Command /${command} is already registered by skill: ${this.commandMap.get(command)}`
        );
      }
      this.commandMap.set(command, metadata.id);
    }

    this.skills.set(metadata.id, skill);
    console.log(`[skill-registry] Registered skill: ${metadata.id} (${metadata.name})`);
  }

  /**
   * Get skill by ID
   *
   * @param {string} skillId - Skill identifier
   * @returns {Skill|null}
   */
  getSkill(skillId) {
    return this.skills.get(skillId) || null;
  }

  /**
   * Get skill that handles a specific command
   *
   * @param {string} command - Command name (without /)
   * @returns {Skill|null}
   */
  getSkillForCommand(command) {
    const skillId = this.commandMap.get(command);
    return skillId ? this.skills.get(skillId) || null : null;
  }

  /**
   * List all registered skills
   *
   * @returns {Array<{id: string, name: string, description: string, commands: string[]}>}
   */
  listSkills() {
    return Array.from(this.skills.values()).map((skill) => {
      const meta = skill.getMetadata();
      return {
        id: meta.id,
        name: meta.name,
        description: meta.description,
        commands: meta.commands,
        version: meta.version,
        pinnable: meta.pinnable,
        resolvers: Array.isArray(meta.resolvers) && meta.resolvers.length ? meta.resolvers : ['skill'],
        lastResolutionMethod: this.lastResolutionBySkill.get(meta.id) || null
      };
    });
  }

  /**
   * Execute a command via a skill's configured resolver chain.
   *
   * @param {string} command
   * @param {string[]} args
   * @param {Object} context
   * @param {{ forcePrompt?: boolean }} options
   * @returns {Promise<Object>}
   */
  async executeCommand(command, args = [], context = {}, options = {}) {
    const skill = this.getSkillForCommand(command);
    if (!skill) {
      return {
        ok: false,
        error: `Unknown skill command: /${command}`
      };
    }

    if (skill._enabled === false) {
      return {
        ok: false,
        error: `Skill '${command}' is currently disabled. Enable it in Settings > Skills.`
      };
    }

    const metadata = skill.getMetadata();
    const defaultResolvers =
      Array.isArray(metadata?.resolvers) && metadata.resolvers.length
        ? metadata.resolvers
        : ['skill'];

    const requestedResolvers = options.forcePrompt
      ? ['prompt', 'skill']
      : defaultResolvers;

    const result = await this.resolutionChain.execute({
      skill,
      command,
      args,
      context,
      resolvers: requestedResolvers
    });

    const resolutionMethod = result?.resolution?.method || null;
    if (metadata?.id && resolutionMethod) {
      this.lastResolutionBySkill.set(metadata.id, resolutionMethod);
    }

    return result;
  }

  /**
   * List all skills that support pinning (pinnable: true in metadata)
   * @returns {Array<{id: string, name: string, description: string, commands: string[], version: string, pinnable: boolean}>}
   */
  getPinnableSkills() {
    return Array.from(this.skills.values())
      .filter((skill) => skill.getMetadata().pinnable === true)
      .map((skill) => {
        const meta = skill.getMetadata();
        return {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          commands: meta.commands,
          version: meta.version,
          pinnable: meta.pinnable
        };
      });
  }

  /**
   * Check if a command is handled by a skill
   *
   * @param {string} command - Command name (without /)
   * @returns {boolean}
   */
  hasCommand(command) {
    return this.commandMap.has(command);
  }

  /**
   * Unregister a skill
   *
   * @param {string} skillId - Skill identifier
   * @returns {Promise<boolean>}
   */
  async unregister(skillId) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return false;
    }

    // Cleanup
    if (typeof skill.cleanup === 'function') {
      await skill.cleanup();
    }

    // Remove command mappings
    const metadata = skill.getMetadata();
    for (const command of metadata.commands) {
      this.commandMap.delete(command);
    }

    this.skills.delete(skillId);
    this.lastResolutionBySkill.delete(skillId);
    console.log(`[skill-registry] Unregistered skill: ${skillId}`);
    return true;
  }

  /**
   * Cleanup all skills
   */
  async cleanupAll() {
    const cleanupPromises = [];
    for (const skill of this.skills.values()) {
      if (typeof skill.cleanup === 'function') {
        cleanupPromises.push(skill.cleanup());
      }
    }
    await Promise.all(cleanupPromises);
    this.skills.clear();
    this.commandMap.clear();
    this.lastResolutionBySkill.clear();
  }
}

const registry = new SkillRegistry();

module.exports = {
  SkillRegistry,
  registry
};

const { Skill } = require('./skill-interface');

/**
 * Registry for managing loaded skills
 */
class SkillRegistry {
  constructor() {
    this.skills = new Map(); // id -> skill instance
    this.commandMap = new Map(); // command -> skill id
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
        version: meta.version
      };
    });
  }

  /**
   * List all skills that support pinning
   *
   * @returns {Array<{id: string, name: string, description: string, commands: string[], version: string}>}
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
          version: meta.version
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
  }
}

const registry = new SkillRegistry();

module.exports = {
  SkillRegistry,
  registry
};

const fs = require('fs');
const path = require('path');
const { registry } = require('./skill-registry');

/**
 * Loads skills from the skills directory
 */
class SkillLoader {
  constructor(options = {}) {
    this.skillsDirectory = options.skillsDirectory || path.join(__dirname, '..', '..', 'skills');
    this.context = options.context || {};
  }

  /**
   * Discover all skill directories
   *
   * @returns {string[]} - Array of skill directory paths
   */
  discoverSkills() {
    if (!fs.existsSync(this.skillsDirectory)) {
      console.log(`[skill-loader] Skills directory not found: ${this.skillsDirectory}`);
      return [];
    }

    const entries = fs.readdirSync(this.skillsDirectory, { withFileTypes: true });
    const skillDirs = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(this.skillsDirectory, entry.name));

    console.log(`[skill-loader] Discovered ${skillDirs.length} potential skill(s)`);
    return skillDirs;
  }

  /**
   * Load a single skill from a directory
   *
   * @param {string} skillPath - Path to skill directory
   * @returns {Promise<Object|null>} - Skill instance or null if failed
   */
  async loadSkill(skillPath) {
    try {
      // Check for package.json
      const packageJsonPath = path.join(skillPath, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
        console.warn(`[skill-loader] No package.json found in ${skillPath}`);
        return null;
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const entryPoint = packageJson.main || 'index.js';
      const skillModulePath = path.join(skillPath, entryPoint);

      if (!fs.existsSync(skillModulePath)) {
        console.warn(`[skill-loader] Entry point not found: ${skillModulePath}`);
        return null;
      }

      // Load the skill module
      console.log(`[skill-loader] Loading skill from ${skillModulePath}`);
      const skillModule = require(skillModulePath);

      // Skills can export either a class or an instance
      let skillInstance;
      if (typeof skillModule === 'function') {
        // It's a class constructor
        skillInstance = new skillModule();
      } else if (skillModule.default && typeof skillModule.default === 'function') {
        // ES6 default export of a class
        skillInstance = new skillModule.default();
      } else {
        // It's an instance or object
        skillInstance = skillModule;
      }

      // Verify it implements required methods
      if (typeof skillInstance.getMetadata !== 'function') {
        console.warn(`[skill-loader] Skill in ${skillPath} missing getMetadata() method`);
        return null;
      }

      if (typeof skillInstance.handleCommand !== 'function') {
        console.warn(`[skill-loader] Skill in ${skillPath} missing handleCommand() method`);
        return null;
      }

      // Initialize the skill
      if (typeof skillInstance.initialize === 'function') {
        await skillInstance.initialize(this.context);
      }

      return skillInstance;
    } catch (error) {
      console.error(`[skill-loader] Error loading skill from ${skillPath}:`, error.message);
      return null;
    }
  }

  /**
   * Load all skills from the skills directory
   *
   * @returns {Promise<number>} - Number of skills loaded successfully
   */
  async loadAll() {
    const skillDirs = this.discoverSkills();
    let loadedCount = 0;

    for (const skillDir of skillDirs) {
      const skill = await this.loadSkill(skillDir);
      if (skill) {
        try {
          registry.register(skill);
          loadedCount++;
        } catch (error) {
          console.error(`[skill-loader] Failed to register skill from ${skillDir}:`, error.message);
        }
      }
    }

    console.log(`[skill-loader] Successfully loaded ${loadedCount}/${skillDirs.length} skill(s)`);
    return loadedCount;
  }

  /**
   * Reload all skills
   */
  async reloadAll() {
    await registry.cleanupAll();
    return this.loadAll();
  }
}

module.exports = SkillLoader;

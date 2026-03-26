const fs = require('fs');
const path = require('path');
const Module = require('module');
const { registry } = require('./skill-registry');
const { isCommandAvailable } = require('../execution/runtime-environment');

// Hook into Node's module resolution so that require('king-louie/...')
// resolves to actual files in this project, regardless of where the
// requiring skill lives on disk (symlinked, cloned, etc.).
const kingLouieModules = {
  'king-louie/skill-interface': path.join(__dirname, 'skill-interface.js'),
  'king-louie/bash-tool': path.join(__dirname, '..', 'tools', 'builtin', 'bash-tool.js')
};

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (kingLouieModules[request]) {
    return kingLouieModules[request];
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const isPlainObject = (value) => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const deepMergeWithArrayReplace = (baseValue, overrideValue) => {
  if (Array.isArray(overrideValue)) {
    return [...overrideValue];
  }

  if (!isPlainObject(overrideValue)) {
    return overrideValue;
  }

  const baseObject = isPlainObject(baseValue) ? baseValue : {};
  const result = { ...baseObject };

  for (const [key, value] of Object.entries(overrideValue)) {
    result[key] = deepMergeWithArrayReplace(baseObject[key], value);
  }

  return result;
};

/**
 * Loads skills from the skills directory
 */
class SkillLoader {
  constructor(options = {}) {
    this.skillsDirectory = options.skillsDirectory || path.join(__dirname, '..', '..', 'skills');
    this.builtinSkillsDirectory = options.builtinSkillsDirectory || null;
    this.context = options.context || {};
    const userDataPath = this.context?.userDataPath || options.userDataPath || process.cwd();
    this.customizationsDirectory =
      options.customizationsDirectory || path.join(userDataPath, 'skill-customizations');
  }

  ensureCustomizationDirectory() {
    if (!this.customizationsDirectory) {
      return null;
    }

    try {
      fs.mkdirSync(this.customizationsDirectory, { recursive: true });
      return this.customizationsDirectory;
    } catch (error) {
      console.warn('[skill-loader] Unable to create skill customizations directory:', error.message);
      return null;
    }
  }

  readSkillCustomization(skillPath, skillInstance) {
    if (!this.customizationsDirectory) {
      return null;
    }

    const skillDirectoryName = path.basename(skillPath);
    const metadata = typeof skillInstance?.getMetadata === 'function' ? skillInstance.getMetadata() : {};
    const identifiers = [
      metadata?.id,
      skillDirectoryName
    ].filter(Boolean);

    for (const identifier of identifiers) {
      const customizationFilePath = path.join(
        this.customizationsDirectory,
        identifier,
        'customization.json'
      );

      if (!fs.existsSync(customizationFilePath)) {
        continue;
      }

      try {
        const raw = fs.readFileSync(customizationFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
          console.warn(`[skill-loader] Ignoring invalid customization in ${customizationFilePath}`);
          continue;
        }

        return {
          identifier,
          path: customizationFilePath,
          data: parsed
        };
      } catch (error) {
        console.warn(`[skill-loader] Failed to parse customization at ${customizationFilePath}:`, error.message);
      }
    }

    return null;
  }

  applySkillCustomization(skillInstance, customizationRecord) {
    if (!customizationRecord?.data || !skillInstance || typeof skillInstance.getMetadata !== 'function') {
      return;
    }

    const originalGetMetadata = skillInstance.getMetadata.bind(skillInstance);
    const customization = customizationRecord.data;
    const metadataOverrides = isPlainObject(customization.metadata)
      ? customization.metadata
      : Object.fromEntries(
          Object.entries(customization).filter(([key]) => key !== 'settings' && key !== 'enabled')
        );

    if (customization.enabled === false) {
      skillInstance._enabled = false;
    }

    skillInstance.getMetadata = () => {
      const baseMetadata = originalGetMetadata();
      return deepMergeWithArrayReplace(baseMetadata, metadataOverrides);
    };

    if (isPlainObject(customization.settings)) {
      const baseSettings = isPlainObject(skillInstance.customSettings)
        ? skillInstance.customSettings
        : {};
      const mergedSettings = deepMergeWithArrayReplace(baseSettings, customization.settings);
      skillInstance.customSettings = mergedSettings;

      if (typeof skillInstance.applyCustomization === 'function') {
        skillInstance.applyCustomization(mergedSettings);
      }
    }

    skillInstance.customization = {
      id: customizationRecord.identifier,
      path: customizationRecord.path
    };

    console.log(`[skill-loader] Applied customization for skill '${customizationRecord.identifier}'`);
  }

  /**
   * Check system dependencies declared in a skill's metadata.
   * Sets skill._dependencyStatus with the results.
   * The skill still loads even if deps are missing — commands are gated at execution time.
   *
   * @param {Object} skillInstance
   * @returns {Promise<void>}
   */
  async checkDependencies(skillInstance) {
    const metadata = typeof skillInstance.getMetadata === 'function'
      ? skillInstance.getMetadata()
      : {};

    const deps = metadata.systemDependencies;
    if (!Array.isArray(deps) || deps.length === 0) {
      skillInstance._dependencyStatus = [];
      return;
    }

    const results = await Promise.all(
      deps.map(async (dep) => {
        const available = await isCommandAvailable(dep.command);
        const status = {
          command: dep.command,
          name: dep.name || dep.command,
          available,
          required: dep.required !== false, // default true
          installUrl: dep.installUrl || null,
          install: dep.install || null
        };

        if (!available) {
          const level = status.required ? 'WARN' : 'INFO';
          console.log(
            `[skill-loader] [${level}] Skill '${metadata.id}' dependency '${dep.command}' (${status.name}) not found on system`
          );
        }

        return status;
      })
    );

    skillInstance._dependencyStatus = results;
  }

  /**
   * Discover all skill directories
   *
   * @returns {string[]} - Array of skill directory paths
   */
  discoverSkills() {
    const skillDirs = [];
    const seen = new Set();

    // Scan both builtin and user skills directories
    const directories = [this.builtinSkillsDirectory, this.skillsDirectory].filter(Boolean);
    for (const dir of directories) {
      if (!fs.existsSync(dir)) {
        console.log(`[skill-loader] Skills directory not found: ${dir}`);
        continue;
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if ((entry.isDirectory() || entry.isSymbolicLink()) && !seen.has(entry.name)) {
          seen.add(entry.name);
          skillDirs.push(path.join(dir, entry.name));
        }
      }
    }

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

      // Track where this skill lives on disk
      skillInstance._skillPath = skillPath;
      skillInstance._isSymlink = fs.lstatSync(skillPath).isSymbolicLink();

      const customizationRecord = this.readSkillCustomization(skillPath, skillInstance);
      if (customizationRecord) {
        this.applySkillCustomization(skillInstance, customizationRecord);
      }

      // Check system dependencies before initialization
      await this.checkDependencies(skillInstance);

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
    this.ensureCustomizationDirectory();
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

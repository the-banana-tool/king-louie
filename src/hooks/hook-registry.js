const fs = require('fs');
const path = require('path');
const { HookDefinition } = require('./hook-schema');
const { createLogger } = require('../logging');
const log = createLogger('hooks');

class HookRegistry {
  constructor(options = {}) {
    this.hooksDirectory = options.hooksDirectory || path.join(process.cwd(), 'hooks');
    this.hooks = [];
    this.enabledOverrides = {};
  }

  discoverHookDirectories() {
    if (!fs.existsSync(this.hooksDirectory)) {
      return [];
    }

    const entries = fs.readdirSync(this.hooksDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.hooksDirectory, entry.name));
  }

  loadHookFromDirectory(hookDirectory) {
    const definitionPath = path.join(hookDirectory, 'hook.json');
    if (!fs.existsSync(definitionPath)) {
      return null;
    }

    const raw = fs.readFileSync(definitionPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const hook = new HookDefinition(parsed, { directory: hookDirectory });
    if (Object.prototype.hasOwnProperty.call(this.enabledOverrides, hook.name)) {
      hook.enabled = Boolean(this.enabledOverrides[hook.name]);
    }

    return hook;
  }

  loadAll() {
    this.hooks = [];
    const directories = this.discoverHookDirectories();

    for (const hookDirectory of directories) {
      try {
        const hook = this.loadHookFromDirectory(hookDirectory);
        if (hook) {
          this.hooks.push(hook);
        }
      } catch (error) {
        log.warn(`Failed loading hook from ${hookDirectory}: ${error.message}`);
      }
    }

    return this.hooks.length;
  }

  getByEvent(event) {
    return this.hooks.filter((hook) => hook.event === event && hook.enabled !== false);
  }

  setEnabledOverrides(overrides = {}) {
    this.enabledOverrides = {
      ...(overrides || {})
    };

    this.hooks = this.hooks.map((hook) => {
      if (Object.prototype.hasOwnProperty.call(this.enabledOverrides, hook.name)) {
        return {
          ...hook,
          enabled: Boolean(this.enabledOverrides[hook.name])
        };
      }

      return hook;
    });
  }

  setEnabled(name, enabled) {
    const hookName = String(name || '').trim();
    if (!hookName) {
      return null;
    }

    this.enabledOverrides = {
      ...(this.enabledOverrides || {}),
      [hookName]: Boolean(enabled)
    };

    this.hooks = this.hooks.map((hook) => {
      if (hook.name === hookName) {
        return {
          ...hook,
          enabled: Boolean(enabled)
        };
      }

      return hook;
    });

    return this.hooks.find((hook) => hook.name === hookName) || null;
  }

  list() {
    return [...this.hooks];
  }
}

module.exports = HookRegistry;

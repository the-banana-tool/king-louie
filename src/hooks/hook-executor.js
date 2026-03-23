const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

function escapeRegexSegment(value = '') {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern = '*') {
  const escaped = String(pattern || '*')
    .split('*')
    .map((part) => escapeRegexSegment(part))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesHook(hook, toolName) {
  const matcher = String(hook?.matcher || '*').trim() || '*';
  if (matcher === '*' || matcher === '**') {
    return true;
  }

  return globToRegex(matcher).test(String(toolName || ''));
}

class HookExecutor {
  constructor(options = {}) {
    this.registry = options.registry;
    this.workingDirectory = options.workingDirectory || process.cwd();
  }

  async run(event, context = {}) {
    if (!this.registry || typeof this.registry.getByEvent !== 'function') {
      return { action: 'allow', results: [] };
    }

    const hooks = this.registry
      .getByEvent(event)
      .filter((hook) => matchesHook(hook, context.toolName));

    const results = [];
    let action = 'allow';
    let message = '';

    for (const hook of hooks) {
      const hookResult = await this.executeHook(hook, { ...context, event });
      results.push({
        hook: hook.name,
        event,
        result: hookResult
      });

      if (event === 'PreToolUse' && hookResult && typeof hookResult === 'object') {
        const nextAction = String(hookResult.action || 'allow').toLowerCase();
        if (nextAction === 'deny') {
          action = 'deny';
          message = hookResult.message || hookResult.reason || 'Blocked by hook policy.';
          break;
        }

        if (nextAction === 'confirm' && action !== 'deny') {
          action = 'confirm';
          message = hookResult.message || hookResult.reason || message;
        }

        if (nextAction === 'modify' && hookResult.parameters && typeof hookResult.parameters === 'object') {
          context.parameters = {
            ...(context.parameters || {}),
            ...hookResult.parameters
          };
        }
      }
    }

    return {
      action,
      message,
      context,
      results
    };
  }

  resolveHandlerPath(hook) {
    if (!hook?.handler) {
      return null;
    }

    if (path.isAbsolute(hook.handler)) {
      return hook.handler;
    }

    if (hook.directory) {
      return path.join(hook.directory, hook.handler);
    }

    return path.join(this.workingDirectory, hook.handler);
  }

  async executeHook(hook, context) {
    if (!hook?.handler) {
      return { action: 'allow' };
    }

    if (hook.handler.startsWith('shell:')) {
      const command = hook.handler.slice('shell:'.length).trim();
      if (!command) {
        return { action: 'allow' };
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDirectory,
        shell: true,
        env: {
          ...process.env,
          HOOK_EVENT: context.event,
          HOOK_TOOL_NAME: context.toolName || ''
        }
      });

      return {
        action: 'allow',
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim()
      };
    }

    const handlerPath = this.resolveHandlerPath(hook);
    if (!handlerPath || !fs.existsSync(handlerPath)) {
      throw new Error(`Hook handler not found: ${handlerPath || hook.handler}`);
    }

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const handlerModule = require(handlerPath);
    const handlerFn = typeof handlerModule === 'function'
      ? handlerModule
      : typeof handlerModule?.run === 'function'
        ? handlerModule.run.bind(handlerModule)
        : null;

    if (!handlerFn) {
      throw new Error(`Hook handler '${hook.handler}' must export a function or { run() }.`);
    }

    const result = await handlerFn(context);
    return result && typeof result === 'object' ? result : { action: 'allow' };
  }
}

module.exports = HookExecutor;

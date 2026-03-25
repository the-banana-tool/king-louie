const { Skill } = require('../../src/skills/skill-interface');

class SandboxSkill extends Skill {
  constructor() {
    super();
    this.context = null;
  }

  getMetadata() {
    return {
      id: 'sandbox',
      name: 'Sandbox',
      version: '1.0.0',
      description: 'Docker sandbox settings for code execution',
      author: 'King Louie',
      commands: ['sandbox'],
      resolvers: ['code']
    };
  }

  getSettingsSchema() {
    return [
      {
        key: 'dockerImage',
        label: 'Docker Image',
        type: 'text',
        default: 'debian:bookworm-slim',
        description: 'Docker image used for sandboxed execution',
        placeholder: 'debian:bookworm-slim'
      },
      {
        key: 'memoryLimit',
        label: 'Memory Limit',
        type: 'text',
        default: '512m',
        description: 'Container memory limit (e.g. 256m, 1g)',
        placeholder: '512m'
      },
      {
        key: 'networkMode',
        label: 'Network Mode',
        type: 'select',
        default: 'bridge',
        description: 'Docker network mode for the sandbox container',
        options: [
          { label: 'Bridge (default)', value: 'bridge' },
          { label: 'None (no network)', value: 'none' },
          { label: 'Host', value: 'host' }
        ]
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        default: 120000,
        description: 'Maximum execution time per command in milliseconds',
        placeholder: '120000'
      }
    ];
  }

  applyCustomization(settings) {
    this._pushToExecutor(settings);
  }

  async initialize(context) {
    this.context = context;
    // Apply any previously saved settings on startup
    const settings = this.getSettings();
    this._pushToExecutor(settings);
  }

  _pushToExecutor(settings) {
    try {
      const BashTool = require('../../src/tools/builtin/bash-tool');
      const executor = BashTool.sandboxExecutor;
      if (!executor || typeof executor.updateConfig !== 'function') return;

      const mapped = {};
      if (settings.dockerImage) mapped.defaultImage = settings.dockerImage;
      if (settings.memoryLimit) mapped.memoryLimit = settings.memoryLimit;
      if (settings.networkMode) mapped.networkMode = settings.networkMode;
      if (settings.timeoutMs != null) mapped.timeoutMs = Number(settings.timeoutMs);

      executor.updateConfig(mapped);
    } catch (err) {
      console.warn('[sandbox-skill] Could not update executor config:', err.message);
    }
  }

  async resolveCode({ command, args }) {
    if (command !== 'sandbox') return null;

    const settings = this.getSettings();
    const lines = [
      '**Sandbox Configuration**',
      '',
      `- **Docker Image:** \`${settings.dockerImage}\``,
      `- **Memory Limit:** ${settings.memoryLimit}`,
      `- **Network Mode:** ${settings.networkMode}`,
      `- **Timeout:** ${settings.timeoutMs}ms`
    ];

    try {
      const BashTool = require('../../src/tools/builtin/bash-tool');
      const available = await BashTool.sandboxExecutor.isDockerAvailable();
      lines.push(`- **Docker Available:** ${available ? 'Yes' : 'No'}`);
    } catch { /* ignore */ }

    return { ok: true, message: lines.join('\n'), format: 'markdown' };
  }

  async handleCommand(command, args, context) {
    return this.resolveCode({ command, args, context });
  }

  async getHelp() {
    return [
      '## Sandbox Skill',
      '',
      'Configure the Docker sandbox used for code execution.',
      '',
      '| Command | Description |',
      '|---------|-------------|',
      '| `/sandbox` | Show current sandbox configuration |',
      '',
      'Change settings in **Settings > Sandbox**.'
    ].join('\n');
  }
}

module.exports = SandboxSkill;

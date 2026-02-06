const { exec } = require('child_process');
const { promisify } = require('util');
const { Tool } = require('../tool-schema');

const execAsync = promisify(exec);

const BashTool = new Tool({
  name: 'Bash',
  description: 'Execute shell commands for local development tasks.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what this command does'
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000)',
        minimum: 1,
        maximum: 600000
      }
    },
    required: ['command']
  },
  requiresApproval: true,
  dangerousPatterns: [
    /rm\s+-rf\s+\//i,
    /mkfs\./i,
    /dd\s+if=/i,
    /:(){\s*:|:&};:/,
    /del\s+\/s\s+\/q/i,
    /rmdir\s+\/s\s+\/q/i,
    /format\s+[a-z]:/i
  ],

  async execute(params, options = {}) {
    const { command, timeout = 120000 } = params;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: Math.min(timeout, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: options.workingDirectory || process.cwd(),
        shell: true
      });

      return {
        success: true,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0
      };
    } catch (error) {
      return {
        success: false,
        stdout: (error.stdout || '').trim(),
        stderr: (error.stderr || error.message || '').trim(),
        exitCode: typeof error.code === 'number' ? error.code : 1
      };
    }
  }
});

module.exports = BashTool;

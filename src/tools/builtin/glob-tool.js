const Tool = require('../tool-schema').Tool;
const fg = require('fast-glob');
const path = require('path');
const { isPathAllowed } = require('../utils');

const globTool = new Tool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths sorted by modification time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")' },
      cwd: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
      maxResults: { type: 'number', default: 100, description: 'Maximum number of results' }
    },
    required: ['pattern']
  },
  requiresApproval: false,
  execute: async (params, context) => {
    const { pattern, cwd, maxResults = 100 } = params;
    const workingDirectory = context?.workingDirectory || process.cwd();
    const allowedDirectories = context?.allowedDirectories || [];
    const baseDir = cwd || workingDirectory;

    const resolvedBase = path.resolve(baseDir);

    if (!isPathAllowed(resolvedBase, workingDirectory, allowedDirectories)) {
      return { ok: false, error: 'Access denied: Path outside working directory and allowed directories' };
    }

    try {
      const files = await fg(pattern, {
        cwd: resolvedBase,
        stats: true,
        absolute: false,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**']
      });

      // Sort by modification time (newest first)
      files.sort((a, b) => (b.stats?.mtimeMs || 0) - (a.stats?.mtimeMs || 0));

      const results = files.slice(0, maxResults).map(f => ({
        path: f.path || f,
        modified: f.stats?.mtime?.toISOString() || null
      }));

      return { ok: true, files: results, total: files.length, truncated: files.length > maxResults };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

module.exports = globTool;

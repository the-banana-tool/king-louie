const Tool = require('../tool-schema').Tool;
const fg = require('fast-glob');
const path = require('path');
const { isPathAllowed } = require('../utils');

const globTool = new Tool({
  name: 'Glob',
  description: 'Find files and/or directories matching a glob pattern. Returns paths sorted by modification time. Use type "directories" to list folders.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts", "*")' },
      cwd: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
      maxResults: { type: 'number', default: 100, description: 'Maximum number of results' },
      type: { type: 'string', enum: ['files', 'directories', 'all'], default: 'all', description: 'What to return: "files", "directories", or "all" (default)' }
    },
    required: ['pattern']
  },
  requiresApproval: false,
  concurrencySafe: true,
  execute: async (params, context) => {
    const { pattern, cwd, maxResults = 100, type: matchType = 'all' } = params;
    const workingDirectory = context?.workingDirectory || process.cwd();
    const allowedDirectories = context?.allowedDirectories || [];
    const baseDir = cwd || workingDirectory;

    const resolvedBase = path.resolve(baseDir);

    if (!isPathAllowed(resolvedBase, workingDirectory, allowedDirectories)) {
      return { ok: false, error: 'Access denied: Path outside working directory and allowed directories' };
    }

    try {
      const globOptions = {
        cwd: resolvedBase,
        stats: true,
        absolute: false,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**']
      };

      if (matchType === 'directories') {
        globOptions.onlyDirectories = true;
      } else if (matchType === 'files') {
        globOptions.onlyFiles = true;
      } else {
        // 'all' — include both files and directories
        globOptions.onlyFiles = false;
      }

      const files = await fg(pattern, globOptions);

      // Sort by modification time (newest first)
      files.sort((a, b) => (b.stats?.mtimeMs || 0) - (a.stats?.mtimeMs || 0));

      const results = files.slice(0, maxResults).map(f => ({
        path: f.path || f,
        type: f.dirent?.isDirectory() ? 'directory' : 'file',
        modified: f.stats?.mtime?.toISOString() || null
      }));

      return { ok: true, files: results, total: files.length, truncated: files.length > maxResults };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

module.exports = globTool;

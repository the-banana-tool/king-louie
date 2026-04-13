const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathAllowed } = require('../utils');
const { generateUnifiedDiff, countDiffStats } = require('./diff-utils');

const WriteTool = new Tool({
  name: 'Write',
  description: 'Create or overwrite a file with provided content.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write'
      }
    },
    required: ['file_path', 'content']
  },
  requiresApproval: true,

  async execute(params, options = {}) {
    const { file_path, content } = params;
    const workingDirectory = options.workingDirectory || process.cwd();
    const allowedDirectories = options.allowedDirectories || [];
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathAllowed(resolvedPath, workingDirectory, allowedDirectories)) {
      throw new Error('Access denied: Path outside working directory and allowed directories');
    }

    try {
      // Read existing content for diff generation (if file exists)
      let oldContent = '';
      let isNew = true;
      try {
        oldContent = await fs.readFile(resolvedPath, 'utf-8');
        isNew = false;
      } catch {
        // File doesn't exist yet — this is a new file
      }

      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf-8');

      const relativePath = path.relative(workingDirectory, resolvedPath);
      const diff = !isNew ? generateUnifiedDiff(oldContent, content, relativePath) : null;
      const stats = diff ? countDiffStats(diff) : null;

      return {
        success: true,
        message: isNew
          ? `Created new file (${Buffer.byteLength(content, 'utf-8')} bytes)`
          : `Overwrote file (${Buffer.byteLength(content, 'utf-8')} bytes)`,
        filePath: resolvedPath,
        isNew,
        diff: diff || undefined,
        linesAdded: stats?.added,
        linesRemoved: stats?.removed
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = WriteTool;

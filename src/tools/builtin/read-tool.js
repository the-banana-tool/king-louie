const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathWithin } = require('../utils');

const ReadTool = new Tool({
  name: 'Read',
  description: 'Read file contents with optional line ranges.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file to read'
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed)',
        minimum: 1
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read',
        minimum: 1
      }
    },
    required: ['file_path']
  },

  async execute(params, options = {}) {
    const { file_path, offset, limit } = params;
    const workingDirectory = options.workingDirectory || process.cwd();
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathWithin(workingDirectory, resolvedPath)) {
      throw new Error('Access denied: Path outside working directory');
    }

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      const startLine = offset ? Math.max(offset - 1, 0) : 0;
      const endLine = limit ? Math.min(startLine + limit, lines.length) : lines.length;

      const selectedLines = lines.slice(startLine, endLine);
      const formatted = selectedLines
        .map((line, idx) => `${startLine + idx + 1}\t${line}`)
        .join('\n');

      return {
        success: true,
        content: formatted,
        totalLines: lines.length,
        readLines: selectedLines.length,
        filePath: resolvedPath
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
});

module.exports = ReadTool;

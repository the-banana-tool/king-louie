const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathWithin } = require('../utils');

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
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathWithin(workingDirectory, resolvedPath)) {
      throw new Error('Access denied: Path outside working directory');
    }

    try {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf-8');

      return {
        success: true,
        message: `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes`,
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

module.exports = WriteTool;

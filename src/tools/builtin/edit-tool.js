const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathAllowed } = require('../utils');

const EditTool = new Tool({
  name: 'Edit',
  description: 'Perform exact string replacements in files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file to edit'
      },
      old_string: {
        type: 'string',
        description: 'The exact text to replace (must be unique unless replace_all=true)'
      },
      new_string: {
        type: 'string',
        description: 'The replacement text'
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences if true'
      }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  requiresApproval: true,

  async execute(params, options = {}) {
    const { file_path, old_string, new_string, replace_all = false } = params;
    const workingDirectory = options.workingDirectory || process.cwd();
    const allowedDirectories = options.allowedDirectories || [];
    const resolvedPath = path.isAbsolute(file_path)
      ? path.resolve(file_path)
      : path.resolve(workingDirectory, file_path);

    if (!isPathAllowed(resolvedPath, workingDirectory, allowedDirectories)) {
      throw new Error('Access denied: Path outside working directory and allowed directories');
    }

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const occurrences = content.split(old_string).length - 1;

      if (occurrences === 0) {
        throw new Error('old_string not found in file');
      }

      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string appears ${occurrences} times. Use replace_all=true or provide more context.`
        );
      }

      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);

      await fs.writeFile(resolvedPath, updated, 'utf-8');

      return {
        success: true,
        replacements: replace_all ? occurrences : 1,
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

module.exports = EditTool;

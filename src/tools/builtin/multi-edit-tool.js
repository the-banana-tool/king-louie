const fs = require('fs').promises;
const path = require('path');
const { Tool } = require('../tool-schema');
const { isPathAllowed } = require('../utils');

/**
 * MultiEdit — batch file editing in a single tool call.
 *
 * Accepts an array of edits, each targeting a file with an exact string
 * replacement. Applies edits sequentially, file by file. If an edit fails,
 * subsequent edits to the SAME file are skipped (to avoid cascading on
 * corrupted state), but edits to OTHER files continue.
 *
 * This reduces agent loop iterations for multi-file refactors from N
 * sequential Edit calls to a single MultiEdit call.
 */
const MultiEditTool = new Tool({
  name: 'MultiEdit',
  description:
    'Perform exact string replacements across multiple files in a single call. ' +
    'Each edit specifies a file path, the text to find, and the replacement. ' +
    'Edits are applied sequentially per file. Use this for multi-file refactors ' +
    'instead of calling Edit repeatedly.',
  parameters: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: 'Array of edit operations to apply',
        items: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute or workspace-relative path to the file'
            },
            old_string: {
              type: 'string',
              description: 'The exact text to replace (must be unique in the file unless replace_all=true)'
            },
            new_string: {
              type: 'string',
              description: 'The replacement text'
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences if true (default: false)'
            }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      }
    },
    required: ['edits']
  },
  requiresApproval: true,

  async execute(params, options = {}) {
    const edits = Array.isArray(params.edits) ? params.edits : [];
    if (edits.length === 0) {
      return { success: false, error: 'No edits provided' };
    }

    const workingDirectory = options.workingDirectory || process.cwd();
    const allowedDirectories = options.allowedDirectories || [];

    const results = [];
    // Track files that have failed so we skip subsequent edits to them
    const failedFiles = new Set();
    // Cache file contents to avoid re-reading between sequential edits to the same file
    const fileCache = new Map();

    for (const edit of edits) {
      const { file_path, old_string, new_string, replace_all = false } = edit;

      const resolvedPath = path.isAbsolute(file_path)
        ? path.resolve(file_path)
        : path.resolve(workingDirectory, file_path);

      // Skip edits to files that already failed
      if (failedFiles.has(resolvedPath)) {
        results.push({
          file: resolvedPath,
          success: false,
          error: 'Skipped: prior edit to this file failed'
        });
        continue;
      }

      if (!isPathAllowed(resolvedPath, workingDirectory, allowedDirectories)) {
        results.push({
          file: resolvedPath,
          success: false,
          error: 'Access denied: path outside allowed directories'
        });
        failedFiles.add(resolvedPath);
        continue;
      }

      try {
        // Read from cache or disk
        let content;
        if (fileCache.has(resolvedPath)) {
          content = fileCache.get(resolvedPath);
        } else {
          content = await fs.readFile(resolvedPath, 'utf-8');
        }

        const occurrences = content.split(old_string).length - 1;

        if (occurrences === 0) {
          results.push({
            file: resolvedPath,
            success: false,
            error: 'old_string not found in file'
          });
          failedFiles.add(resolvedPath);
          continue;
        }

        if (occurrences > 1 && !replace_all) {
          results.push({
            file: resolvedPath,
            success: false,
            error: `old_string appears ${occurrences} times. Use replace_all=true or provide more context.`
          });
          failedFiles.add(resolvedPath);
          continue;
        }

        const updated = replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);

        await fs.writeFile(resolvedPath, updated, 'utf-8');
        fileCache.set(resolvedPath, updated);

        results.push({
          file: resolvedPath,
          success: true,
          replacements: replace_all ? occurrences : 1
        });
      } catch (error) {
        results.push({
          file: resolvedPath,
          success: false,
          error: error.message
        });
        failedFiles.add(resolvedPath);
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      success: failed === 0,
      total: results.length,
      succeeded,
      failed,
      results
    };
  }
});

module.exports = MultiEditTool;

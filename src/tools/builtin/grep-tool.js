const { Tool } = require('../tool-schema');
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

function isBinary(filePath) {
  try {
    const buffer = Buffer.alloc(512);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
  } catch (err) {
    // If we can't read it, treat as non-binary or just ignore during grep
  }
  return false;
}

const grepTool = new Tool({
  name: 'Grep',
  description: 'Search file contents using regex. Returns matching lines with file path and line numbers.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for' },
      path: { type: 'string', description: 'File or directory to search. Defaults to working directory.' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js", "**/*.ts")' },
      caseSensitive: { type: 'boolean', default: true },
      maxResults: { type: 'number', default: 50 },
      contextLines: { type: 'number', default: 0, description: 'Number of lines of context around matches' }
    },
    required: ['pattern']
  },
  requiresApproval: false,
  execute: async (params, context) => {
    const {
      pattern,
      path: searchPath,
      glob: fileGlob = '**/*',
      caseSensitive = true,
      maxResults = 50,
      contextLines = 0
    } = params;

    const baseDir = searchPath || context?.workingDirectory || process.cwd();
    let regex;
    try {
      regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return { ok: false, error: `Invalid regular expression: ${err.message}` };
    }

    const matches = [];
    let files = [];

    let isDir = false;
    try {
      const stats = fs.statSync(baseDir);
      isDir = stats.isDirectory();
    } catch (e) {
      return { ok: false, error: `Path not found: ${baseDir}` };
    }

    if (!isDir) {
      files = [baseDir];
      // For single files, baseDir isn't an actual base directory for relativity, it's the file itself.
    } else {
      files = await fg(fileGlob, {
        cwd: baseDir,
        absolute: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**']
      });
    }

    for (const file of files) {
      if (matches.length >= maxResults) break;

      if (isBinary(file)) continue;

      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;

          regex.lastIndex = 0; // reset for global regex
          if (regex.test(lines[i])) {
            let contextResult = undefined;
            if (contextLines > 0) {
              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);
              contextResult = lines.slice(start, end + 1).join('\n');
            }

            matches.push({
              file: isDir ? path.relative(baseDir, file) : file,
              line: lines[i],
              lineNumber: i + 1,
              ...(contextResult !== undefined && { context: contextResult })
            });
          }
        }
      } catch (e) {
        // Skip files that can't be read
      }
    }

    return { ok: true, matches, total: matches.length, truncated: matches.length >= maxResults };
  }
});

module.exports = grepTool;

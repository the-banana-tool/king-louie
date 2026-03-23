const fs = require('fs');
const path = require('path');

const CONTEXT_DIR_NAME = '.king-louie';
const CONTEXT_FILE_NAME = 'context.md';

function resolveStartDirectory(workingDirectory) {
  const candidate = String(workingDirectory || '').trim();
  if (!candidate) return process.cwd();

  try {
    const stats = fs.statSync(candidate);
    if (stats.isDirectory()) return candidate;
    return path.dirname(candidate);
  } catch {
    return process.cwd();
  }
}

function findContextFile(startDirectory) {
  let current = path.resolve(resolveStartDirectory(startDirectory));

  while (true) {
    const candidate = path.join(current, CONTEXT_DIR_NAME, CONTEXT_FILE_NAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function loadProjectContext(options = {}) {
  const contextFile = findContextFile(options.workingDirectory);
  if (!contextFile) {
    return {
      content: '',
      path: null
    };
  }

  try {
    const content = fs.readFileSync(contextFile, 'utf-8').trim();
    return {
      content,
      path: contextFile
    };
  } catch (error) {
    return {
      content: '',
      path: contextFile,
      error: error.message
    };
  }
}

module.exports = {
  CONTEXT_DIR_NAME,
  CONTEXT_FILE_NAME,
  findContextFile,
  loadProjectContext
};
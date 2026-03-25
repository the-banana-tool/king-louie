const fs = require('fs');
const path = require('path');

const DEFAULT_DANGEROUS_COMMAND_PATTERNS = [
  {
    pattern: /\brm\s+-rf\s+(\/|\.\.|~|\$HOME)(\s|$)/i,
    reason: 'Recursive force-delete targeting a root or home path.',
    severity: 'deny'
  },
  {
    pattern: /\bmkfs(\.[a-z0-9]+)?\b/i,
    reason: 'Filesystem formatting command detected.',
    severity: 'deny'
  },
  {
    pattern: /\bdd\s+if=/i,
    reason: 'Raw disk write pattern (dd if=...) detected.',
    severity: 'deny'
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*;\s*\}/,
    reason: 'Fork bomb pattern detected.',
    severity: 'deny'
  },
  {
    pattern: /\bchmod\s+-R\s+777\s+(\/|\.\.|~|\$HOME)\b/i,
    reason: 'Recursive world-writable permission change on sensitive path.',
    severity: 'deny'
  },
  {
    pattern: />\s*\/dev\/(sda|disk\d+)/i,
    reason: 'Direct block device write redirection detected.',
    severity: 'deny'
  },
  {
    pattern: /\b(shutdown|reboot|halt)\b/i,
    reason: 'System power operation detected.',
    severity: 'confirm'
  },
  {
    pattern: /\b(del|erase)\b\s+\/s\s+\/q/i,
    reason: 'Recursive quiet delete command detected on Windows.',
    severity: 'confirm'
  }
];

const DEFAULT_PROTECTED_PATHS = process.platform === 'win32'
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users']
  : ['/etc', '/bin', '/usr', '/boot', '/dev', '/sys', '/proc'];

function normalizeForComparison(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function resolveRealPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // If the file doesn't exist yet, resolve the parent directory and append the basename
    const dir = path.dirname(filePath);
    try {
      return path.join(fs.realpathSync(dir), path.basename(filePath));
    } catch {
      return path.resolve(filePath);
    }
  }
}

function isPathWithin(basePath, targetPath) {
  const base = normalizeForComparison(resolveRealPath(basePath));
  const target = normalizeForComparison(resolveRealPath(targetPath));
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Check if a target path is allowed — either within the working directory
 * or within any of the global allowed directories.
 */
function isPathAllowed(targetPath, workingDirectory, allowedDirectories = []) {
  if (workingDirectory && isPathWithin(workingDirectory, targetPath)) {
    return true;
  }
  for (const dir of allowedDirectories) {
    if (dir && isPathWithin(dir, targetPath)) {
      return true;
    }
  }
  return false;
}

function evaluateDangerousCommand(command = '', patterns = DEFAULT_DANGEROUS_COMMAND_PATTERNS) {
  const text = String(command || '');
  for (const rule of patterns) {
    if (!rule?.pattern || typeof rule.pattern.test !== 'function') {
      continue;
    }

    if (rule.pattern.test(text)) {
      return {
        matched: true,
        severity: rule.severity || 'deny',
        reason: rule.reason || 'Command matches a restricted pattern.',
        pattern: String(rule.pattern)
      };
    }
  }

  return {
    matched: false
  };
}

module.exports = {
  isPathWithin,
  isPathAllowed,
  evaluateDangerousCommand,
  DEFAULT_DANGEROUS_COMMAND_PATTERNS,
  DEFAULT_PROTECTED_PATHS
};

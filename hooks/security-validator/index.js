const fs = require('fs');
const path = require('path');
const {
  evaluateDangerousCommand,
  DEFAULT_PROTECTED_PATHS,
  isPathWithin
} = require('../../src/tools/utils');

function tokenizeCommand(command = '') {
  const regex = /"([^"\\]*(\\.[^"\\]*)*)"|'([^'\\]*(\\.[^'\\]*)*)'|(\S+)/g;
  const tokens = [];
  let match;

  while ((match = regex.exec(String(command || ''))) !== null) {
    const token = match[1] ?? match[3] ?? match[5] ?? '';
    tokens.push(token.replace(/\\(["'\\])/g, '$1'));
  }

  return tokens;
}

function normalizeProtectedPaths() {
  const envValue = process.env.KING_LOUIE_PROTECTED_PATHS;
  if (!envValue) {
    return DEFAULT_PROTECTED_PATHS;
  }

  try {
    const parsed = JSON.parse(envValue);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // ignore and parse as CSV below
  }

  return String(envValue)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findProtectedPathWrite(command = '', workingDirectory = process.cwd()) {
  const tokens = tokenizeCommand(command);
  const protectedPaths = normalizeProtectedPaths();
  const writeFlags = new Set(['>', '>>', 'tee', '-o', '--output', '/out', '/p']);

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    const nextToken = tokens[idx + 1] || '';

    const candidate = token.startsWith('>')
      ? token.replace(/^>+/, '')
      : writeFlags.has(token)
        ? nextToken
        : '';

    if (!candidate) {
      continue;
    }

    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(workingDirectory, candidate);

    for (const protectedPath of protectedPaths) {
      if (isPathWithin(protectedPath, resolved) || isPathWithin(resolved, protectedPath)) {
        return {
          protectedPath,
          candidate: resolved
        };
      }
    }
  }

  return null;
}

function appendSecurityLog(entry = {}) {
  const logPath = path.join(process.cwd(), 'hooks', 'security.log');
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

module.exports = async function securityValidator(context = {}) {
  const command = String(context?.parameters?.command || '');
  if (!command) {
    return { action: 'allow' };
  }

  const commandRisk = evaluateDangerousCommand(command);
  if (commandRisk.matched) {
    appendSecurityLog({
      timestamp: new Date().toISOString(),
      tool: context.toolName || 'unknown',
      type: 'command-pattern',
      severity: commandRisk.severity,
      reason: commandRisk.reason,
      command
    });

    if (commandRisk.severity === 'confirm') {
      return {
        action: 'confirm',
        message: `Security warning: ${commandRisk.reason}`
      };
    }

    return {
      action: 'deny',
      message: `Security policy blocked command: ${commandRisk.reason}`
    };
  }

  const protectedPathWrite = findProtectedPathWrite(
    command,
    context?.workingDirectory || process.cwd()
  );

  if (protectedPathWrite) {
    appendSecurityLog({
      timestamp: new Date().toISOString(),
      tool: context.toolName || 'unknown',
      type: 'protected-path',
      severity: 'deny',
      reason: `Attempted write on protected path ${protectedPathWrite.protectedPath}`,
      command,
      target: protectedPathWrite.candidate
    });

    return {
      action: 'deny',
      message: `Security policy blocked write attempt on protected path: ${protectedPathWrite.protectedPath}`
    };
  }

  return { action: 'allow' };
};

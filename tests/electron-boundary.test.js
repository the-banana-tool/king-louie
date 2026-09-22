const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const ALLOWED_DIRS = [path.join(SRC, 'ipc') + path.sep];

const PATTERNS = [
  { name: 'electron', re: /require\(\s*['"]electron['"]\s*\)/ },
  { name: 'electron-store', re: /(require|import)\(\s*['"]electron-store['"]\s*\)/ },
  { name: 'main.js', re: /require\(\s*['"](\.\.\/)+main['"]\s*\)/ },
];

// Shrinks to [] as Tasks 2–4 land. Format: 'relative/path.js:pattern-name'.
const KNOWN_VIOLATIONS = [
  'auth/anthropic-oauth.js:electron',
  'channels/channel-plugin.js:electron',
  'mesh/index.js:electron',
  'notifications/channels/ui-toast.js:electron',
  'tools/builtin/browser-tool.js:electron-store',
  'tools/builtin/image-generate-tool.js:electron',
  'tools/builtin/image-generate-tool.js:electron-store',
  'tools/builtin/vault-tool.js:electron-store',
  'tools/builtin/web-search-tool.js:electron',
  'tools/builtin/web-search-tool.js:electron-store',
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function findViolations() {
  const found = [];
  for (const file of walk(SRC)) {
    if (ALLOWED_DIRS.some((d) => file.startsWith(d))) continue;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) found.push(`${rel}:${name}`);
    }
  }
  return found.sort();
}

describe('Electron import boundary', () => {
  it('only src/ipc/ may import electron, electron-store or main.js', () => {
    assert.deepStrictEqual(findViolations(), [...KNOWN_VIOLATIONS].sort(),
      'If you removed a violation, delete it from KNOWN_VIOLATIONS. If you added one, inject the dependency instead.');
  });
});

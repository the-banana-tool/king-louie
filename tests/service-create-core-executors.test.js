// tests/service-create-core-executors.test.js
// Every createCore call under src/service/ passes deps.adminExecutors, so the
// executor registry is in service mode (package roots from the admin
// service.json only) and never falls back to the desktop's data-dir root.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVICE_DIR = path.join(__dirname, '..', 'src', 'service');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

// The argument text of each `createCore(` call, balanced on parentheses.
function createCoreCalls(source) {
  const calls = [];
  const re = /\bcreateCore\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    calls.push({ line: source.slice(0, m.index).split('\n').length, args: source.slice(start, i - 1) });
  }
  return calls;
}

describe('service createCore callers', () => {
  it('every createCore call under src/service/ passes adminExecutors', () => {
    const found = [];
    const missing = [];
    for (const file of jsFiles(SERVICE_DIR)) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      for (const call of createCoreCalls(source)) {
        const where = `${path.relative(SERVICE_DIR, file)}:${call.line}`;
        found.push(where);
        if (!/\badminExecutors\s*:/.test(call.args)) missing.push(where);
      }
    }
    assert.ok(found.length >= 4, `expected the known createCore callers, found ${found.join(', ')}`);
    assert.deepStrictEqual(missing, [], `createCore without adminExecutors: ${missing.join(', ')}`);
  });
});

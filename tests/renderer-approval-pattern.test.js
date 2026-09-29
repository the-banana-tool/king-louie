// The approval dialog's "Always allow pattern" seeds a browser tool's rule
// with the action, so approving a click can save `allow Browser(click)`: the
// explicit grant that browser actions which change something still honour
// when the tool-wide "always approve" list no longer covers them.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: approval dialog pattern seed', () => {
  const suggestAllowPattern = new Function(`${block('function suggestAllowPattern(toolName, parameters = {})')}\nreturn suggestAllowPattern;`)();

  it('suggests the action for the browser tools', () => {
    assert.strictEqual(suggestAllowPattern('Browser', { action: 'click', selector: '#go' }), 'click');
    assert.strictEqual(suggestAllowPattern('BrowserPage', { action: 'fill' }), 'fill');
    assert.strictEqual(suggestAllowPattern('BrowserSession', {}), null);
  });

  it('leaves the other tools as they were', () => {
    assert.strictEqual(suggestAllowPattern('Bash', { command: 'git status' }), 'git *');
  });
});

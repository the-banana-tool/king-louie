// tests/renderer-models-m3.test.js
// Static checks on the renderer for models M3 (spec 2026-09-27 §10, §11):
// the per-role cost line; later tasks add the King Louie profile and custom
// roles. Model-derived text is set as text, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: the per-role cost line', () => {
  const formatRoleCosts = new Function(`${block('function formatCompactUsd(value = 0)')}\n${block('function formatRoleCosts(byRole)')}\nreturn formatRoleCosts;`)();

  it('splits a reply\'s cost by role, core roles first', () => {
    assert.strictEqual(formatRoleCosts({ utility: { costUsd: 0.01 }, main: { costUsd: 0.09 }, worker: { costUsd: 0.02 } }), ' · main $0.09 · worker $0.02 · utility $0.01');
    assert.strictEqual(formatRoleCosts({ 'legal-drafting': { costUsd: 0.5 }, main: { costUsd: 0.1, unpriced: true } }), ' · main $0.10+ · legal-drafting $0.50');
    assert.strictEqual(formatRoleCosts(undefined), '');
  });

  it('the reply\'s metrics line uses it', () => {
    assert.match(block('function addMessage(sender, text, metadata = {})'), /formatRoleCosts\(metadata\.llm\.byRole\)/);
    assert.ok(html.length > 0);
  });
});

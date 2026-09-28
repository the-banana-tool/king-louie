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

  it('names the role a borrowed role ran on (final review m3)', () => {
    assert.strictEqual(formatRoleCosts({ main: { costUsd: 0.5 }, worker: { costUsd: 0.2, borrowedFrom: 'main' } }), ' · main $0.50 · worker (main) $0.20');
  });

  it('the reply\'s metrics line uses it', () => {
    assert.match(block('function addMessage(sender, text, metadata = {})'), /formatRoleCosts\(metadata\.llm\.byRole\)/);
    assert.ok(html.length > 0);
  });
});

describe('renderer: the King Louie profile (spec §7, §11)', () => {
  it('has its card and controls in the Models tab', () => {
    for (const id of ['models-king-louie-card', 'models-kl-status', 'models-kl-picks', 'models-kl-proposal', 'models-kl-auto-accept', 'models-kl-prefer-local', 'models-kl-band', 'models-kl-worker-ratio', 'models-kl-utility-ratio', 'models-kl-save-btn', 'models-kl-duplicate-btn']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('draws the view from the channels, as text, with no native dialogs', () => {
    assert.match(block('async function loadKingLouie()'), /window\.electron\.models\.kingLouie\(\)/);
    const render = block('function renderKingLouie(view)');
    assert.match(render, /window\.electron\.models\.acceptProposal\(/);
    assert.match(render, /window\.electron\.models\.dismissProposal\(/);
    assert.match(render, /models-kl-change/);
    assert.doesNotMatch(render, /innerHTML\s*=\s*(?!'')/);
    assert.doesNotMatch(render, /\bconfirm\(|\balert\(|\bprompt\(/);
    assert.match(src, /window\.electron\.models\.onProposalChanged\(/);
    assert.match(src, /window\.electron\.models\.saveKingLouieSettings\(/);
    assert.match(src, /window\.electron\.models\.duplicateKingLouie\(/);
  });

  it('offers no Edit for the King Louie profile', () => {
    assert.match(block('function renderModelProfileList()'), /profile\.kind !== 'king-louie'/);
  });

  it('formats the cost effect and a role\'s models', () => {
    const f = new Function(`${block('function formatCostEffect(effect)')}\nreturn formatCostEffect;`)();
    assert.strictEqual(f({ usd: -0.35, note: '10 calls in the last 30 days, repriced.' }), '−$0.35 a month (10 calls in the last 30 days, repriced.)');
    assert.strictEqual(f({ usd: 1.2, note: 'n' }), '+$1.20 a month (n)');
    assert.strictEqual(f({ usd: null, note: 'No recorded calls in the last 30 days.' }), 'No recorded calls in the last 30 days.');
    const t = new Function(`${block('function targetsText(list)')}\nreturn targetsText;`)();
    assert.strictEqual(t([{ model: 'mini', name: 'Mini', effort: 'minimal' }, { model: 'big', name: 'Big' }]), 'Mini (minimal effort), Big');
    assert.strictEqual(t([]), '(none)');
  });
});

describe('renderer: custom roles (spec §6.2, §11)', () => {
  it('has the Advanced card with its warning and form', () => {
    for (const id of ['models-custom-roles-card', 'models-custom-roles-warning', 'models-custom-role-list', 'models-custom-role-id', 'models-custom-role-description', 'models-custom-role-fallback', 'models-custom-role-tools', 'models-custom-role-images', 'models-custom-role-min-context', 'models-save-custom-role-btn', 'models-custom-roles-status']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /Use only if you know what you're doing/);
  });

  it('lists and edits them as text through their channels', () => {
    const list = block('function renderCustomRoles()');
    assert.doesNotMatch(list, /innerHTML\s*=\s*(?!'')/);
    assert.doesNotMatch(list, /\bconfirm\(|\balert\(|\bprompt\(/);
    assert.match(src, /window\.electron\.models\.saveCustomRole\(/);
    assert.match(src, /window\.electron\.models\.removeCustomRole\(/);
  });

  it('shows every custom role in the profile editor and saves no empty custom list', () => {
    assert.match(block('function renderProfileEditor()'), /customRoles/);
    assert.match(block('async function saveProfileDraft()'), /!MODEL_ROLE_ORDER\.includes\(role\) && !\(entries \|\| \[\]\)\.length/);
    assert.match(block('async function openModelPicker(role, block)'), /customRoleOf\(role\)/);
  });
});

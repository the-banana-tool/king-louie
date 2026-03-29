const { describe, it } = require('node:test');
const assert = require('node:assert');
const { matchCondition, evaluateRules, stripPrefix, validateRule } = require('../src/providers/smart-routing');

describe('smart-routing', () => {
  describe('matchCondition — keyword', () => {
    it('matches case-insensitively', () => {
      const cond = { type: 'keyword', keywords: ['documentation'] };
      assert.strictEqual(matchCondition('Write Documentation for the API', cond), true);
    });

    it('matches multi-word phrases', () => {
      const cond = { type: 'keyword', keywords: ['write docs'] };
      assert.strictEqual(matchCondition('please write docs for this', cond), true);
    });

    it('returns false when no keyword matches', () => {
      const cond = { type: 'keyword', keywords: ['deploy', 'release'] };
      assert.strictEqual(matchCondition('refactor the login page', cond), false);
    });

    it('returns false for empty keywords array', () => {
      const cond = { type: 'keyword', keywords: [] };
      assert.strictEqual(matchCondition('anything', cond), false);
    });

    it('matches any keyword (OR logic)', () => {
      const cond = { type: 'keyword', keywords: ['design', 'architect'] };
      assert.strictEqual(matchCondition('architect a new service', cond), true);
    });
  });

  describe('matchCondition — regex', () => {
    it('matches a valid regex', () => {
      const cond = { type: 'regex', pattern: '\\b(refactor|redesign)\\b', flags: 'i' };
      assert.strictEqual(matchCondition('let us refactor the module', cond), true);
    });

    it('returns false when regex does not match', () => {
      const cond = { type: 'regex', pattern: '^deploy', flags: 'i' };
      assert.strictEqual(matchCondition('please help me code', cond), false);
    });

    it('handles invalid regex gracefully', () => {
      const cond = { type: 'regex', pattern: '[invalid(', flags: 'i' };
      assert.strictEqual(matchCondition('anything', cond), false);
    });

    it('defaults flags to "i" when not specified', () => {
      const cond = { type: 'regex', pattern: 'HELLO' };
      assert.strictEqual(matchCondition('hello world', cond), true);
    });
  });

  describe('matchCondition — prefix', () => {
    it('matches a prefix command', () => {
      const cond = { type: 'prefix', prefix: '/code' };
      assert.strictEqual(matchCondition('/code write a parser', cond), true);
    });

    it('matches with leading whitespace', () => {
      const cond = { type: 'prefix', prefix: '/docs' };
      assert.strictEqual(matchCondition('  /docs explain this', cond), true);
    });

    it('matches case-insensitively', () => {
      const cond = { type: 'prefix', prefix: '/Code' };
      assert.strictEqual(matchCondition('/code write stuff', cond), true);
    });

    it('returns false when prefix does not match', () => {
      const cond = { type: 'prefix', prefix: '/code' };
      assert.strictEqual(matchCondition('write some code', cond), false);
    });
  });

  describe('matchCondition — agentModeOnly', () => {
    it('skips rule when agentModeOnly is true and agentMode is false', () => {
      const cond = { type: 'keyword', keywords: ['design'], agentModeOnly: true };
      assert.strictEqual(matchCondition('design a feature', cond, { agentMode: false }), false);
    });

    it('matches when agentModeOnly is true and agentMode is true', () => {
      const cond = { type: 'keyword', keywords: ['design'], agentModeOnly: true };
      assert.strictEqual(matchCondition('design a feature', cond, { agentMode: true }), true);
    });

    it('matches when agentModeOnly is false regardless of agentMode', () => {
      const cond = { type: 'keyword', keywords: ['design'], agentModeOnly: false };
      assert.strictEqual(matchCondition('design a feature', cond, { agentMode: false }), true);
    });
  });

  describe('evaluateRules', () => {
    const rules = [
      {
        id: '1', name: 'Docs', enabled: true, priority: 20,
        condition: { type: 'keyword', keywords: ['documentation', 'write docs'] },
        target: { provider: 'openai', model: 'gpt-4o-mini' }
      },
      {
        id: '2', name: 'Architecture', enabled: true, priority: 10,
        condition: { type: 'keyword', keywords: ['design', 'architect'] },
        target: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' }
      },
      {
        id: '3', name: 'Disabled', enabled: false, priority: 1,
        condition: { type: 'keyword', keywords: ['anything'] },
        target: { provider: 'groq', model: 'llama' }
      }
    ];

    it('returns first matching rule by priority', () => {
      const result = evaluateRules('design the documentation system', rules);
      // priority 10 (Architecture) matches before priority 20 (Docs)
      assert.strictEqual(result.target.provider, 'anthropic');
      assert.strictEqual(result.matchedRule.id, '2');
    });

    it('falls through to lower-priority rules', () => {
      const result = evaluateRules('write documentation', rules);
      assert.strictEqual(result.target.provider, 'openai');
      assert.strictEqual(result.matchedRule.id, '1');
    });

    it('returns null when no rules match', () => {
      const result = evaluateRules('deploy to production', rules);
      assert.strictEqual(result, null);
    });

    it('skips disabled rules', () => {
      const result = evaluateRules('anything at all', rules);
      // Disabled rule has priority 1 but should be skipped
      assert.strictEqual(result, null);
    });

    it('returns null for empty rules array', () => {
      assert.strictEqual(evaluateRules('hello', []), null);
    });

    it('returns null for empty message', () => {
      assert.strictEqual(evaluateRules('', rules), null);
    });
  });

  describe('stripPrefix', () => {
    it('removes matched prefix and trims', () => {
      assert.strictEqual(stripPrefix('/code write a parser', '/code'), 'write a parser');
    });

    it('handles leading whitespace', () => {
      assert.strictEqual(stripPrefix('  /code write stuff', '/code'), 'write stuff');
    });

    it('returns original if prefix does not match', () => {
      assert.strictEqual(stripPrefix('hello world', '/code'), 'hello world');
    });

    it('returns message unchanged if prefix is empty', () => {
      assert.strictEqual(stripPrefix('hello', ''), 'hello');
    });
  });

  describe('validateRule', () => {
    it('accepts a valid keyword rule', () => {
      const result = validateRule({
        name: 'Test', priority: 10,
        condition: { type: 'keyword', keywords: ['test'] },
        target: { provider: 'openai', model: 'gpt-4o' }
      });
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('accepts a valid regex rule', () => {
      const result = validateRule({
        name: 'Regex', priority: 5,
        condition: { type: 'regex', pattern: '\\btest\\b', flags: 'i' },
        target: { provider: 'anthropic', model: 'claude' }
      });
      assert.strictEqual(result.valid, true);
    });

    it('accepts a valid prefix rule', () => {
      const result = validateRule({
        name: 'Prefix', priority: 1,
        condition: { type: 'prefix', prefix: '/code' },
        target: { provider: 'openai', model: 'gpt-4o' }
      });
      assert.strictEqual(result.valid, true);
    });

    it('rejects rule with missing name', () => {
      const result = validateRule({
        condition: { type: 'keyword', keywords: ['a'] },
        target: { provider: 'openai', model: 'gpt-4o' }
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('name')));
    });

    it('rejects rule with invalid condition type', () => {
      const result = validateRule({
        name: 'Bad',
        condition: { type: 'unknown' },
        target: { provider: 'openai', model: 'gpt-4o' }
      });
      assert.strictEqual(result.valid, false);
    });

    it('rejects keyword rule with empty keywords', () => {
      const result = validateRule({
        name: 'Bad',
        condition: { type: 'keyword', keywords: [] },
        target: { provider: 'openai', model: 'gpt-4o' }
      });
      assert.strictEqual(result.valid, false);
    });

    it('rejects regex rule with invalid pattern', () => {
      const result = validateRule({
        name: 'Bad',
        condition: { type: 'regex', pattern: '[invalid(' },
        target: { provider: 'openai', model: 'gpt-4o' }
      });
      assert.strictEqual(result.valid, false);
    });

    it('rejects rule with missing target', () => {
      const result = validateRule({
        name: 'No target',
        condition: { type: 'keyword', keywords: ['a'] }
      });
      assert.strictEqual(result.valid, false);
    });

    it('rejects non-object input', () => {
      const result = validateRule(null);
      assert.strictEqual(result.valid, false);
    });
  });
});

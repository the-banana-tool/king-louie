// Tool.validateParameters knows JSON Schema's `integer` and type lists. MCP
// servers declare both; without them every call to a tool with an integer
// parameter (Ella's limit, errand_id, min_gap_minutes) was refused with
// "Expected integer." whatever the model sent.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Tool } = require('../src/tools/tool-schema');

function toolWith(properties) {
  return new Tool({ name: 'T', execute: async () => ({}), parameters: { type: 'object', properties } });
}

describe('Tool.validateParameters: JSON Schema types', () => {
  it('accepts an integer for an integer parameter', () => {
    assert.doesNotThrow(() => toolWith({ limit: { type: 'integer' } }).validateParameters({ limit: 25 }));
  });

  it('refuses a fraction or a string for an integer parameter', () => {
    const tool = toolWith({ limit: { type: 'integer' } });
    assert.throws(() => tool.validateParameters({ limit: 2.5 }), /Expected integer/);
    assert.throws(() => tool.validateParameters({ limit: '25' }), /Expected integer/);
  });

  it('applies minimum and maximum to integers', () => {
    const tool = toolWith({ limit: { type: 'integer', minimum: 1, maximum: 50 } });
    assert.throws(() => tool.validateParameters({ limit: 0 }), /must be >= 1/);
    assert.throws(() => tool.validateParameters({ limit: 51 }), /must be <= 50/);
  });

  it('accepts any type in a type list', () => {
    const tool = toolWith({ id: { type: ['integer', 'string'] } });
    assert.doesNotThrow(() => tool.validateParameters({ id: 12 }));
    assert.doesNotThrow(() => tool.validateParameters({ id: 'e-12' }));
    assert.throws(() => tool.validateParameters({ id: true }), /Expected integer or string/);
  });
});

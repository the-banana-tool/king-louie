// tests/tool-schema-shape.test.js
// Gemini rejects function declarations whose properties have no "type" or
// whose objects declare no "properties". Keep the case tools inside that subset.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CASE_TOOL_NAMES } = require('../src/cases/chat-integration');

initializeTools();

function schemaProblems(schema, where) {
  const problems = [];
  if (!schema || typeof schema !== 'object') return [`${where}: not a schema`];
  if (!schema.type) problems.push(`${where}: no "type"`);
  if (schema.type === 'object') {
    const props = schema.properties || {};
    if (!Object.keys(props).length) problems.push(`${where}: object without "properties"`);
    for (const [key, sub] of Object.entries(props)) problems.push(...schemaProblems(sub, `${where}.${key}`));
  }
  if (schema.type === 'array') problems.push(...schemaProblems(schema.items, `${where}[]`));
  return problems;
}

describe('case tool schemas', () => {
  it('give every property a type and every object its properties', () => {
    for (const name of CASE_TOOL_NAMES) {
      const def = toolRegistry.get(name).toFunctionDefinition();
      assert.deepStrictEqual(schemaProblems(def.parameters, name), []);
    }
  });
});

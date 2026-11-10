'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { mapOpenAiMessages } = require('../src/longhaul/converters/openai-messages');
const { SENDERS, messageText } = require('../src/longhaul/session-format');

describe('mapOpenAiMessages', () => {
  it('maps a rebench-shaped trajectory, pairing results by tool_call_id', () => {
    const { messages, stats } = mapOpenAiMessages([
      { role: 'system', content: 'You are a coding agent in a sandbox.' },
      { role: 'user', content: 'Fix the off-by-one in widget-kit pagination.' },
      {
        role: 'assistant',
        content: 'Let me think about the pager first.',
        tool_calls: [{ id: 'call-w1', type: 'function', function: { name: 'think', arguments: '{"thought": "page index starts at 1"}' } }]
      },
      { role: 'tool', tool_call_id: 'call-w1', name: 'think', content: 'Your thought has been logged.' }
    ], { pairBy: 'id' });

    assert.deepEqual(messages.map((m) => m.sender), ['user', 'assistant', 'toolUse', 'toolResult']);
    assert.equal(messages[0].text, 'Fix the off-by-one in widget-kit pagination.');
    assert.equal(messages[1].text, 'Let me think about the pager first.');
    assert.deepEqual(messages[2].parameters, { thought: 'page index starts at 1' });
    assert.equal(messages[2].toolName, 'think');
    assert.equal(messages[2].meta.toolUseId, 'call-w1');
    assert.equal(messages[3].toolName, 'think');
    assert.equal(messages[3].result, 'Your thought has been logged.');
    assert.equal(messages[3].meta.toolUseId, 'call-w1');
    assert.equal(stats.skipped.system, 1);
    assert.equal(stats.unpaired, 0);
    for (const m of messages) assert.ok(SENDERS.includes(m.sender));
    assert.equal(messageText(messages[3]), 'Your thought has been logged.');
    assert.equal(messageText(messages[2]), 'think: {"thought":"page index starts at 1"}');
  });

  it('maps an Open-SWE-shaped trajectory, pairing results by order and keeping reasoning out of text', () => {
    const reasoning = 'SECRET-REASONING-widget-kit-zebra';
    const { messages, stats } = mapOpenAiMessages([
      { role: 'user', content: 'The widget-kit build fails on Windows.' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: reasoning,
        tool_calls: [
          { id: 'tc-a', type: 'function', function: { name: 'Bash', arguments: '{"command": "npm run build"}' } },
          { id: 'tc-b', type: 'function', function: { name: 'Read', arguments: '{"file_path": "src/build.js"}' } }
        ]
      },
      { role: 'tool', content: 'Error: path separator' },
      { role: 'tool', content: 'module.exports = build;' },
      { role: 'tool', content: 'stray output' }
    ], { pairBy: 'order' });

    assert.deepEqual(
      messages.map((m) => `${m.sender}${m.toolName ? ` ${m.toolName}` : ''}`),
      ['user', 'toolUse Bash', 'toolUse Read', 'toolResult Bash', 'toolResult Read', 'toolResult unknown']
    );
    assert.equal(messages[3].meta.toolUseId, 'tc-a');
    assert.equal(messages[4].meta.toolUseId, 'tc-b');
    assert.equal(messages[5].meta.toolUseId, null);
    assert.equal(stats.unpaired, 1);
    assert.ok(stats.reasoningChars > 0);
    assert.equal(stats.reasoningChars, reasoning.length);
    assert.ok(!JSON.stringify(messages).includes(reasoning));
  });

  it('records reasoningChars on an assistant text message', () => {
    const { messages } = mapOpenAiMessages([
      { role: 'assistant', content: 'Done.', reasoning_content: 'abcd' }
    ], { pairBy: 'order' });
    assert.deepEqual(messages, [{ sender: 'assistant', text: 'Done.', meta: { reasoningChars: 4 } }]);
  });

  it('keeps unparseable arguments raw and object arguments as they are', () => {
    const { messages, stats } = mapOpenAiMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', function: { name: 'Bash', arguments: '{"command": "ls' } },
          { id: 'c2', function: { name: 'Read', arguments: { file_path: 'README.md' } } }
        ]
      }
    ], { pairBy: 'id' });
    assert.deepEqual(messages[0].parameters, { raw: '{"command": "ls' });
    assert.deepEqual(messages[1].parameters, { file_path: 'README.md' });
    assert.equal(stats.badArguments, 1);
  });

  it('maps an unknown role to a status message', () => {
    const { messages, stats } = mapOpenAiMessages([
      { role: 'critic', content: 'The patch misses a test.' }
    ], { pairBy: 'id' });
    assert.deepEqual(messages, [{ sender: 'status', text: 'The patch misses a test.', meta: { unmapped: 'critic' } }]);
    assert.equal(stats.unmapped, 1);
  });

  it('turns null content into empty text and array content into text', () => {
    const { messages } = mapOpenAiMessages([
      { role: 'user', content: null },
      { role: 'user', content: [{ type: 'text', text: 'Run the widget-kit tests.' }] }
    ], { pairBy: 'id' });
    assert.equal(messages[0].text, '');
    assert.equal(typeof messages[1].text, 'string');
    assert.ok(messages[1].text.includes('Run the widget-kit tests.'));
  });

  it('falls back to the tool message name when the id is unknown', () => {
    const { messages, stats } = mapOpenAiMessages([
      { role: 'tool', tool_call_id: 'nope', name: 'str_replace_editor', content: 'ok' },
      { role: 'tool', content: 'lost' }
    ], { pairBy: 'id' });
    assert.equal(messages[0].toolName, 'str_replace_editor');
    assert.equal(messages[0].meta.toolUseId, 'nope');
    assert.equal(messages[1].toolName, 'unknown');
    assert.equal(stats.unpaired, 1);
  });
});

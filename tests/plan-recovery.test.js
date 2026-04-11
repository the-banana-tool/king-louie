const { describe, it } = require('node:test');
const assert = require('node:assert');
const { recoverPlanFromMessages } = require('../src/workflows/plan-recovery');

const validGraph = (id = 'a') => ({
  goal: 'g',
  tasks: [
    { id, title: 'T', description: 'D', dependsOn: [] }
  ]
});

describe('recoverPlanFromMessages()', () => {
  it('returns null when there are no messages', () => {
    const result = recoverPlanFromMessages([]);
    assert.strictEqual(result.taskGraph, null);
    assert.strictEqual(result.legacyCount, 0);
  });

  it('returns null when no messages have workflowScaffolding', () => {
    const result = recoverPlanFromMessages([
      { id: 'm1', sender: 'user', text: 'hi' },
      { id: 'm2', sender: 'assistant', text: 'hello' }
    ]);
    assert.strictEqual(result.taskGraph, null);
    assert.strictEqual(result.legacyCount, 0);
  });

  it('counts legacy `workflowScaffolding: true` messages but does not recover them', () => {
    const result = recoverPlanFromMessages([
      { id: 'm1', sender: 'assistant', text: 'old plan', workflowScaffolding: true },
      { id: 'm2', sender: 'assistant', text: 'older plan', workflowScaffolding: true }
    ]);
    assert.strictEqual(result.taskGraph, null);
    assert.strictEqual(result.legacyCount, 2);
  });

  it('recovers the most recent embedded task graph', () => {
    const older = validGraph('older');
    const newer = validGraph('newer');
    const result = recoverPlanFromMessages([
      { id: 'm1', sender: 'assistant', text: '...', workflowScaffolding: { kind: 'proposed', taskGraph: older } },
      { id: 'm2', sender: 'user', text: 'go' },
      { id: 'm3', sender: 'assistant', text: '...', workflowScaffolding: { kind: 'edited', taskGraph: newer } }
    ]);
    assert.strictEqual(result.taskGraph.tasks[0].id, 'newer');
    assert.strictEqual(result.kind, 'edited');
    assert.strictEqual(result.messageId, 'm3');
  });

  it('skips invalid embedded task graphs and finds the next valid one', () => {
    const valid = validGraph('valid');
    const invalid = { tasks: [{ id: 'a', dependsOn: ['ghost'] }] };
    const result = recoverPlanFromMessages([
      { id: 'm1', sender: 'assistant', text: '...', workflowScaffolding: { kind: 'proposed', taskGraph: valid } },
      { id: 'm2', sender: 'assistant', text: '...', workflowScaffolding: { kind: 'edited', taskGraph: invalid } }
    ]);
    assert.strictEqual(result.taskGraph.tasks[0].id, 'valid');
    assert.strictEqual(result.kind, 'proposed');
  });

  it('handles a mix of legacy and structured entries', () => {
    const result = recoverPlanFromMessages([
      { id: 'm1', sender: 'assistant', workflowScaffolding: true },
      { id: 'm2', sender: 'assistant', workflowScaffolding: { kind: 'proposed', taskGraph: validGraph('a') } },
      { id: 'm3', sender: 'assistant', workflowScaffolding: true }
    ]);
    assert.strictEqual(result.taskGraph.tasks[0].id, 'a');
    assert.strictEqual(result.legacyCount, 1, 'only legacies newer than the recovered graph are counted');
  });
});

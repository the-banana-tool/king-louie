const { describe, it } = require('node:test');
const assert = require('node:assert');
const PlannerAgent = require('../src/agents/builtin/planner');
const { getAgent, listAgents } = require('../src/agents');

describe('Planner Agent', () => {
  it('has required id and name', () => {
    assert.strictEqual(PlannerAgent.id, 'planner');
    assert.strictEqual(PlannerAgent.name, 'Planner');
  });

  it('uses smart inference tier', () => {
    assert.strictEqual(PlannerAgent.inferenceTier, 'smart');
  });

  it('has low temperature for structured output', () => {
    assert.ok(PlannerAgent.temperature <= 0.5, 'Planner should use low temperature for consistent JSON output');
  });

  it('has higher max iterations for research', () => {
    assert.ok(PlannerAgent.maxIterations >= 10, 'Planner should have enough iterations to research before planning');
  });

  it('has a system prompt template', () => {
    assert.ok(PlannerAgent.systemPromptTemplate);
    assert.ok(PlannerAgent.systemPromptTemplate.includes('planner'));
  });

  it('allows research tools but not destructive ones', () => {
    assert.ok(PlannerAgent.canUseTool('WebSearch'));
    assert.ok(PlannerAgent.canUseTool('WebFetch'));
    assert.ok(PlannerAgent.canUseTool('Read'));
    assert.ok(PlannerAgent.canUseTool('Glob'));
    assert.ok(PlannerAgent.canUseTool('Grep'));
    assert.ok(PlannerAgent.canUseTool('AskUser'));
    // Should NOT allow destructive tools
    assert.ok(!PlannerAgent.canUseTool('Bash'));
    assert.ok(!PlannerAgent.canUseTool('Write'));
    assert.ok(!PlannerAgent.canUseTool('Edit'));
    assert.ok(!PlannerAgent.canUseTool('Git'));
  });

  it('auto-approves read-only tools', () => {
    assert.ok(PlannerAgent.autoApproveTools.includes('WebSearch'));
    assert.ok(PlannerAgent.autoApproveTools.includes('Read'));
    assert.ok(PlannerAgent.autoApproveTools.includes('Glob'));
    assert.ok(PlannerAgent.autoApproveTools.includes('Grep'));
  });
});

describe('Agent registry includes planner', () => {
  it('getAgent returns planner by id', () => {
    const agent = getAgent('planner');
    assert.ok(agent);
    assert.strictEqual(agent.id, 'planner');
    assert.strictEqual(agent.name, 'Planner');
  });

  it('listAgents includes planner', () => {
    const agents = listAgents();
    const planner = agents.find(a => a.id === 'planner');
    assert.ok(planner, 'Planner should be in the agents list');
  });

  it('registry has 4 agents total', () => {
    const agents = listAgents();
    assert.strictEqual(agents.length, 4);
    const ids = agents.map(a => a.id);
    assert.ok(ids.includes('main'));
    assert.ok(ids.includes('code-explorer'));
    assert.ok(ids.includes('code-writer'));
    assert.ok(ids.includes('planner'));
  });
});

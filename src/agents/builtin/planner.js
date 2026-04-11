const Agent = require('../agent-schema');

const PlannerAgent = new Agent({
  id: 'planner',
  name: 'Planner',
  description: 'Decomposes high-level goals into executable task graphs with dependency ordering',
  model: 'claude-sonnet-4-20250514',
  inferenceTier: 'smart',
  systemPromptTemplate: 'templates/planner.md.template',
  allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'AskUser'],
  autoApproveTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
  temperature: 0.4,
  maxIterations: 40,
  systemPrompt: `You are a planning agent. You decompose complex goals into structured task graphs.
When given a goal, output a JSON task graph that other agents can execute.`
});

module.exports = PlannerAgent;

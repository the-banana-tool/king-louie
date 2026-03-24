const Agent = require('../agent-schema');

const MainAssistantAgent = new Agent({
  id: 'main',
  name: 'Main Assistant',
  description: 'General purpose orchestration assistant',
  model: 'claude-sonnet-4-20250514',
  inferenceTier: 'standard',
  voice: {
    enabled: false,
    engine: 'system',
    mode: 'summary',
    speed: 1
  },
  systemPromptTemplate: 'templates/main-assistant.md.template',
  allowedTools: ['*'],
  systemPrompt: `You are King Louie's primary orchestration assistant.
Coordinate tasks, delegate when needed, and provide clear final responses.
Use tools responsibly and prefer concise, actionable outputs.`
});

module.exports = MainAssistantAgent;
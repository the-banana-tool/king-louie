const Agent = require('../agent-schema');

const MainAssistantAgent = new Agent({
  id: 'main',
  name: 'Main Assistant',
  description: 'General purpose orchestration assistant',
  model: 'claude-3-5-sonnet-latest',
  allowedTools: ['*'],
  systemPrompt: `You are King Louie's primary orchestration assistant.
Coordinate tasks, delegate when needed, and provide clear final responses.
Use tools responsibly and prefer concise, actionable outputs.`
});

module.exports = MainAssistantAgent;
const MainAssistantAgent = require('./builtin/main-assistant');
const CodeExplorerAgent = require('./builtin/code-explorer');
const CodeWriterAgent = require('./builtin/code-writer');

const builtinAgents = [MainAssistantAgent, CodeExplorerAgent, CodeWriterAgent];
const agentMap = new Map(builtinAgents.map((agent) => [agent.id, agent]));

function listAgents() {
  return Array.from(agentMap.values());
}

function getAgent(agentId) {
  return agentMap.get(agentId);
}

module.exports = {
  listAgents,
  getAgent
};
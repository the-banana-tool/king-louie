function splitMessage(text = '', maxLength = 3800) {
  const content = String(text || '').trim();
  if (!content) return ['(No response)'];
  if (content.length <= maxLength) return [content];

  const chunks = [];
  let cursor = 0;

  while (cursor < content.length) {
    const window = content.slice(cursor, cursor + maxLength);
    let cut = window.lastIndexOf('\n\n');
    if (cut < maxLength * 0.4) cut = window.lastIndexOf('\n');
    if (cut < maxLength * 0.4) cut = window.lastIndexOf(' ');
    if (cut < maxLength * 0.25) cut = window.length;

    const segment = window.slice(0, cut).trim();
    chunks.push(segment || window);
    cursor += cut;
  }

  return chunks;
}

function formatHelp({ agents = [], currentAgent = 'main', skills = [] } = {}) {
  const agentRows = agents.length
    ? agents
        .map((agent) => {
          const marker = agent.id === currentAgent ? ' (active)' : '';
          return `- ${agent.id}${marker}`;
        })
        .join('\n')
    : '- main';

  const skillRows = skills.length
    ? skills
        .map((skill) => {
          const commands = skill.commands.map((cmd) => `/${cmd}`).join(', ');
          return `- ${commands} — ${skill.description}`;
        })
        .join('\n')
    : '';

  const parts = [
    '🤖 *King Louie Telegram Bridge*',
    '',
    'Commands:',
    '- /help — show this help',
    '- /status — show gateway + session stats',
    '- /clear — clear current chat session history',
    '- /agent <name> — switch active agent for this chat',
    '- /pin <skill-id> — pin a skill to this chat',
    '- /unpin — remove pinned skill from this chat',
    '- /pinned — show currently pinned skill',
    '',
    'Available agents:',
    agentRows
  ];

  if (skillRows) {
    parts.push('', 'Skills:', skillRows);
  }

  return parts.join('\n');
}

function formatStatus(status = {}) {
  const gateway = status.gateway || {};
  const sessions = status.sessions || {};

  return [
    '📡 *Gateway Status*',
    `- Host: ${gateway.host || 'unknown'}`,
    `- Port: ${gateway.port || 'unknown'}`,
    `- Connections: ${gateway.connections ?? 'unknown'}`,
    '',
    '🧠 *Sessions*',
    `- Total: ${sessions.total ?? 0}`
  ].join('\n');
}

function formatApprovalRequest({ toolName, parameters } = {}) {
  const preview = JSON.stringify(parameters || {}, null, 2);
  return [
    '⚠️ Tool approval required',
    `Tool: ${toolName || 'unknown'}`,
    '',
    'Parameters:',
    `\`\`\`json\n${preview}\n\`\`\``
  ].join('\n');
}

module.exports = {
  splitMessage,
  formatHelp,
  formatStatus,
  formatApprovalRequest
};
const Agent = require('../agent-schema');

const CodeWriterAgent = new Agent({
  id: 'code-writer',
  name: 'Code Writer',
  description: 'Writes and modifies code based on requirements',
  model: 'claude-sonnet-4-20250514',
  inferenceTier: 'smart',
  voice: {
    enabled: false,
    engine: 'system',
    mode: 'summary',
    speed: 0.95
  },
  systemPromptTemplate: 'templates/code-writer.md.template',
  allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Git'],
  autoApproveTools: ['Bash', 'Edit', 'Write', 'Git'],
  maxIterations: 40,
  systemPrompt: `You are a code implementation specialist. Your job is to:
1. Understand requirements and read relevant code first
2. Make minimal, targeted edits aligned with existing style
3. Validate behavior with focused checks
4. Report what changed and why

Always prefer safe, incremental edits with clear reasoning.`
});

module.exports = CodeWriterAgent;
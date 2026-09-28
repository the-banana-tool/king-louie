const Agent = require('../agent-schema');

// The explorer (models spec 2026-09-27 §8.1): reads and searches files and
// web pages on the worker role and returns a short summary naming the paths
// or URLs it used, so main never pays for the raw text. Read-only. The id
// stays code-explorer: workflows, templates and tests name it.
const CodeExplorerAgent = new Agent({
  id: 'code-explorer',
  name: 'Explorer',
  description: 'Reads and searches files and web pages, then returns a short summary naming the paths or URLs it used',
  role: 'worker',
  voice: {
    enabled: false,
    engine: 'system',
    mode: 'summary',
    speed: 1.05
  },
  systemPromptTemplate: 'templates/code-explorer.md.template',
  allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
  readOnly: true,
  returnsSummary: true,
  maxIterations: 20,
  systemPrompt: `You are an explorer. You read and search files and web pages for another agent and report what you found.
Use only Read, Glob, Grep, WebFetch and WebSearch. Never modify anything.
Answer with a short summary: the facts asked for, each with the file paths or URLs it came from.`
});

module.exports = CodeExplorerAgent;

const Agent = require('../agent-schema');

// Read-only research for a case (cases stage 3 spec §3.10). It sees only
// its gated task text, proposes facts in a ```facts block, and never writes
// the case: the parent turn asserts what it accepts.
const CaseResearcherAgent = new Agent({
  id: 'case-researcher',
  name: 'Case Researcher',
  description: 'Read-only web research for a case; proposes facts, never writes them',
  role: 'worker',
  voice: { enabled: false, engine: 'system', mode: 'summary' },
  systemPromptTemplate: 'templates/case-researcher.md.template',
  allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
  readOnly: true,
  maxIterations: 20,
  systemPrompt: `You are a read-only researcher working for a case. Your task text is all you know about it.
Use only WebSearch, WebFetch, Read, Glob and Grep. Search in general terms: a query or URL carrying private case data is refused.
Report only what a source says. End your answer with a fenced block tagged facts: a JSON array of
{ "stmt", "subject", "attr", "value", "unit", "source": { "kind": "url" | "document", "ref" }, "category" }, or [] when you found nothing.`
});

module.exports = CaseResearcherAgent;

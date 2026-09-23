// src/cases/chat-integration.js
// Glue between the chat send path and a case: prompt text, tool list
// shaping, and the protected-path check the tool executor uses.
const path = require('path');

const CASE_TOOL_NAMES = Object.freeze(['Ledger', 'Brief', 'Decide', 'Recommend']);

const CASE_MODE_PROMPT = [
  'Case mode. This chat is attached to a case. The orientation below was read from the case repository on disk at the start of this turn. It is the authoritative state and outranks anything earlier in the conversation.',
  '',
  'Rules for this case:',
  '- Record every fact you rely on with the Ledger tool: "assert" with a source for what you verified or what the owner told you (provenance "user"); "infer" with a basis for your own derivations; "unknown" for anything you do not know. Never state a guess as a fact.',
  '- Before saying something is missing, record it as an unknown; the Ledger tool reports matching facts in this case and in the owner\'s other cases.',
  '- Ask the owner only what they alone know: history, constraints, preferences, authorization. Decide everything else yourself and record it with the Decide tool.',
  '- Load-bearing unknowns come first. If one blocks the objective, say so and ask. Do not work around it with an assumption.',
  '- Recommendations go through the Recommend tool. If it refuses, fix the cited facts or present the unknowns. Do not restate a refused recommendation in prose.',
  '- When an approach fails, report what happened and stop, with at most one recommendation. Do not start a new plan unasked.',
  '- Never edit facts.jsonl or anything under .kl/ directly. The case tools are the only write path.'
].join('\n');

function shapeToolDefinitions(definitions, attached, registry) {
  const caseNames = new Set(CASE_TOOL_NAMES);
  const base = (definitions || []).filter((d) => !caseNames.has(d.name));
  if (!attached) return base;
  const caseDefs = CASE_TOOL_NAMES
    .map((name) => registry.get(name))
    .filter(Boolean)
    .map((tool) => tool.toFunctionDefinition());
  return [...base, ...caseDefs];
}

function buildCaseSystemPrompt(orientation, base) {
  return [CASE_MODE_PROMPT, orientation, base].filter(Boolean).join('\n\n');
}

function isProtectedCasePath(caseDir, absolutePath) {
  if (!caseDir || !absolutePath) return false;
  const rel = path.relative(path.resolve(caseDir), path.resolve(absolutePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return rel === 'facts.jsonl' || first === '.kl';
}

module.exports = {
  CASE_TOOL_NAMES,
  CASE_MODE_PROMPT,
  shapeToolDefinitions,
  buildCaseSystemPrompt,
  isProtectedCasePath
};

// src/cases/chat-integration.js
// Glue between the chat send path and a case: prompt text, tool list
// shaping, the protected-path check the tool executor uses, and the
// owner-quote check the case tools use for provenance "user".
const fs = require('fs');
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

// A Windows long-path prefix (`\\?\` or `\\.\`) opts a path out of the usual
// MAX_PATH / normalization rules. Strip it before doing anything else so the
// rest of this function sees an ordinary path.
const LONG_PATH_PREFIX = /^\\\\[?.]\\/;

function stripLongPathPrefix(p) {
  return p.replace(LONG_PATH_PREFIX, '');
}

// Resolve as much of `absPath` as already exists on disk to its real path
// (following symlinks and Windows junctions), then re-append whatever
// doesn't exist yet, unchanged. This defeats a link that points *into* the
// case directory from outside it, without requiring the whole path to
// already exist (the file being written usually doesn't, yet).
function realpathNearest(absPath) {
  let current = absPath;
  const remainder = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return remainder.length ? path.join(real, ...remainder) : real;
    } catch (err) {
      const parent = path.dirname(current);
      if (parent === current) return absPath; // hit the root; nothing left to resolve
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isProtectedCasePath(caseDir, absolutePath) {
  if (!caseDir || !absolutePath) return false;

  // NTFS and APFS/HFS+ are case-insensitive by default; comparing case-
  // sensitively there lets `FACTS.JSONL` or `.KL\x` name the same file the
  // guard is supposed to protect while missing the match.
  const foldCase = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (s) => (foldCase ? s.toLowerCase() : s);

  const resolvedCaseDir = realpathNearest(path.resolve(stripLongPathPrefix(String(caseDir))));
  const resolvedTarget = realpathNearest(path.resolve(stripLongPathPrefix(String(absolutePath))));

  const rel = path.relative(resolvedCaseDir, resolvedTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;

  // Per segment: drop an NTFS alternate-data-stream suffix (`name::$DATA`,
  // everything from the first ':') and trailing dots/spaces (both silently
  // stripped by the Win32 file APIs, so `facts.jsonl.` and `facts.jsonl `
  // resolve to the same file as `facts.jsonl`).
  const segments = rel.split(/[\\/]/).map((seg) => {
    const streamCut = seg.indexOf(':');
    const base = streamCut === -1 ? seg : seg.slice(0, streamCut);
    return fold(base.replace(/[. ]+$/, ''));
  });

  return segments[0] === '.kl' || segments.join('/') === fold('facts.jsonl');
}

const MIN_QUOTE_LENGTH = 3;
const QUOTE_INSTRUCTION = "Quote the owner's words verbatim, or ask the owner.";

function normalizeForQuote(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// provenance "user" means "the owner said it; the message is the source"
// (spec). The model's own paraphrase is not a source, so a fact or brief
// field recorded that way must carry a quote that actually appears in
// something the owner said in this chat. Fails closed: anything short of a
// verified match is refused.
function requireOwnerQuote({ quote, ownerMessages }) {
  const trimmed = typeof quote === 'string' ? quote.trim() : '';
  if (trimmed.length < MIN_QUOTE_LENGTH) {
    return {
      ok: false,
      error: `provenance "user" needs a "quote" of at least ${MIN_QUOTE_LENGTH} characters of the owner's own words. ${QUOTE_INSTRUCTION}`
    };
  }
  if (!Array.isArray(ownerMessages) || ownerMessages.length === 0) {
    return {
      ok: false,
      error: `No owner messages are available in this chat to check that quote against. ${QUOTE_INSTRUCTION}`
    };
  }
  const needle = normalizeForQuote(trimmed);
  const matched = ownerMessages.some((m) => normalizeForQuote(m).includes(needle));
  if (!matched) {
    return {
      ok: false,
      error: `That quote does not appear in anything the owner said in this chat. ${QUOTE_INSTRUCTION}`
    };
  }
  return { ok: true, quote: trimmed };
}

module.exports = {
  CASE_TOOL_NAMES,
  CASE_MODE_PROMPT,
  shapeToolDefinitions,
  buildCaseSystemPrompt,
  isProtectedCasePath,
  requireOwnerQuote
};

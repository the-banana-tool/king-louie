'use strict';
// Minimal authoring for stage B0 (benchmark spec §6): one prompt per planned
// item, candidates written with authoredBy "generated" and verifiedBy null.
// A candidate must cite only messages it was shown and pass the §5
// validator; anything else is rejected with a reason, and the run goes on.
const fs = require('fs');
const path = require('path');
const { messageText, senderLabel } = require('./session-format');
const { validateQuestion, normalizeQuestion } = require('./questions');
const { sha256Text } = require('./files');

const DEFAULT_PROMPT = path.join(__dirname, 'prompts', 'author-v1.md');
const SPAN_MESSAGE_CHARS = 2000;
const ABSTAIN_ANSWER = 'not in the session';
const KIND_RULES = Object.freeze({
  'user-said': 'The owner stated it in a user message; the answer is a quote or paraphrase. Evidence: user messages only.',
  'tool-observed': 'The fact appeared only in tool output (a port, a path, a count, an error string). Evidence: tool result messages only.',
  decision: 'What was decided and why; the answer includes the reason. Evidence: assistant or user messages.',
  superseded: 'A value changed; the answer is the latest value. Evidence: at least two messages, the earlier value and the later one.',
  'multi-hop': 'The answer needs two facts from two different messages. Evidence: at least two messages.',
  abstain: 'The fact is never stated in the session; the answer is "not in the session". Evidence: none.'
});

function clipRendered(m) {
  const text = messageText(m);
  const body = text.length > SPAN_MESSAGE_CHARS
    ? `${text.slice(0, SPAN_MESSAGE_CHARS)}\n[... ${text.length - SPAN_MESSAGE_CHARS} more characters]`
    : text;
  return `[#${m.seq} ${senderLabel(m)}]\n${body}`;
}

function fillPrompt(template, item, index) {
  const span = [];
  for (let s = item.spanFrom; s <= item.spanTo; s++) {
    const m = index.get(s);
    if (m) span.push(clipRendered(m));
  }
  // split/join rather than replace(): message text may contain "$&" and the like.
  return template
    .split('{{kind}}').join(item.kind)
    .split('{{kindRule}}').join(KIND_RULES[item.kind])
    .split('{{askAtSeq}}').join(String(item.askAtSeq))
    .split('{{span}}').join(span.join('\n\n'));
}

function parseReply(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(s.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function nextSerial(existing, sessionId) {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-g(\\d+)$`);
  let max = 0;
  for (const q of existing) {
    const m = re.exec(q.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function authorCandidates({ session, plan, client, sessionId, existing = [], promptPath = DEFAULT_PROMPT, maxTokens = 800 }) {
  const template = fs.readFileSync(promptPath, 'utf8');
  const promptSha256 = sha256Text(template);
  let serial = nextSerial(existing, sessionId);
  const candidates = [];
  const rejected = [];
  for (const item of plan.items) {
    let reply;
    try {
      reply = await client.complete(fillPrompt(template, item, session.index), { maxTokens });
    } catch (err) {
      rejected.push({ item, reason: 'model-error', detail: err.message });
      continue;
    }
    const parsed = parseReply(reply.text);
    if (!parsed) { rejected.push({ item, reason: 'unparsed' }); continue; }
    if (parsed.skip !== undefined) { rejected.push({ item, reason: 'model-skipped', detail: String(parsed.skip) }); continue; }
    const evidenceSeqs = item.kind === 'abstain' ? [] : (Array.isArray(parsed.evidenceSeqs) ? parsed.evidenceSeqs.map(Number) : []);
    const outside = evidenceSeqs.filter((s) => !(Number.isInteger(s) && s >= item.spanFrom && s <= item.spanTo));
    if (outside.length) { rejected.push({ item, reason: 'evidence-outside-span', detail: outside.join(',') }); continue; }
    const raw = {
      id: `${sessionId}-g${String(serial).padStart(4, '0')}`,
      sessionId,
      askAtSeq: item.askAtSeq,
      kind: item.kind,
      question: String(parsed.question ?? '').trim(),
      answer: item.kind === 'abstain' ? ABSTAIN_ANSWER : String(parsed.answer ?? '').trim(),
      acceptableAnswers: Array.isArray(parsed.acceptableAnswers) ? parsed.acceptableAnswers.filter((a) => typeof a === 'string' && a.trim()) : [],
      evidenceSeqs,
      supersededBy: null,
      authoredBy: 'generated',
      verifiedBy: null,
      notes: [`author-v1 ${item.bucket}`, typeof parsed.notes === 'string' ? parsed.notes.trim() : ''].filter(Boolean).join('; ')
    };
    const errors = validateQuestion(raw, { index: session.index, sessionId });
    if (errors.length) { rejected.push({ item, reason: 'invalid', detail: errors.join('; ') }); continue; }
    candidates.push(normalizeQuestion(raw, session.index));
    serial += 1;
  }
  return { candidates, rejected, promptSha256 };
}

module.exports = { DEFAULT_PROMPT, KIND_RULES, fillPrompt, parseReply, authorCandidates };

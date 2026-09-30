'use strict';
// The verify loop (benchmark spec §6): a reviewer accepts, edits or rejects
// each unverified candidate. Only a valid question can be accepted; an edit
// is saved only when valid and is never accepted by itself; progress is
// saved after every decision. The rules live in review.js, shared with the
// web reviewer (verify-web.js). The loop's own text is ASCII.
const readline = require('readline');
const { KINDS, validateQuestion, computeDistance, bucketFor } = require('./questions');
const { messageText, senderLabel } = require('./session-format');
const { createReview } = require('./review');

const SHOW_CHARS = 1500;
const FIELDS = Object.freeze([
  ['question', 'text'], ['answer', 'text'], ['acceptableAnswers', 'list'], ['evidenceSeqs', 'seqs'],
  ['askAtSeq', 'int'], ['kind', 'kind'], ['supersededBy', 'optint']
]);

function clip(text) {
  return text.length > SHOW_CHARS ? `${text.slice(0, SHOW_CHARS)}\n[... ${text.length - SHOW_CHARS} more characters]` : text;
}

function show(m) {
  return `  [#${m.seq} ${senderLabel(m)} ${m.timestamp}]\n${clip(messageText(m))}`;
}

function describeQuestion(q, index, position, total) {
  const seqs = Array.isArray(q.evidenceSeqs) ? q.evidenceSeqs : [];
  const d = seqs.length && seqs.every(Number.isInteger) ? computeDistance(index, q) : null;
  const where = d ? ` - ${d.messages} messages / ~${d.estTokens} tokens back (${bucketFor(d)})` : '';
  const lines = ['', `[${position}/${total}] ${q.id} - ${q.kind} - asked at #${q.askAtSeq}${where}`, `Q: ${q.question}`, `A: ${q.answer}`];
  if (q.acceptableAnswers?.length) lines.push(`Also accept: ${q.acceptableAnswers.join(' | ')}`);
  if (q.supersededBy) lines.push(`Superseded by #${q.supersededBy}`);
  if (q.notes) lines.push(`Notes: ${q.notes}`);
  lines.push('Evidence:');
  if (!seqs.length) lines.push('  (none)');
  for (const s of seqs) {
    const m = index.get(s);
    lines.push(m ? show(m) : `  #${s}: not in the session`);
  }
  const at = index.get(q.askAtSeq);
  lines.push(`At #${q.askAtSeq} (the question is asked in place of this message):`, at ? show(at) : '  (not in the session)');
  return `${lines.join('\n')}\n`;
}

function display(field, value) {
  if (field === 'acceptableAnswers') return (value || []).join(' | ');
  if (field === 'evidenceSeqs') return value && value.length ? value.join(',') : '-';
  return value === null || value === undefined ? '-' : String(value);
}

function parseField(type, raw) {
  switch (type) {
    case 'text': return { value: raw };
    case 'list': return { value: raw.split('|').map((s) => s.trim()).filter(Boolean) };
    case 'seqs': {
      if (raw === '-') return { value: [] };
      const parts = raw.split(/[\s,]+/).filter(Boolean).map(Number);
      return parts.every(Number.isInteger) ? { value: parts } : { error: 'whole numbers separated by commas, or - for none' };
    }
    case 'int': {
      const n = Number(raw);
      return Number.isInteger(n) ? { value: n } : { error: 'a whole number' };
    }
    case 'optint': {
      if (raw === '-') return { value: null };
      const n = Number(raw);
      return Number.isInteger(n) ? { value: n } : { error: 'a whole number, or - for none' };
    }
    case 'kind': return KINDS.includes(raw) ? { value: raw } : { error: `one of ${KINDS.join(', ')}` };
    default: return { error: 'a known field' };
  }
}

async function verifyLoop({ session, questions, reviewer, input, output, onSave, now = () => new Date() }) {
  const review = createReview({ session, questions, reviewer, onSave, now });
  const { index } = session;
  const sessionId = session.manifest.sessionId;
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };
  const pending = review.pending();
  let stopped = false;
  const result = () => ({ ...review.counts(), stopped });

  const edit = async (q) => {
    const next = { ...q };
    for (const [field, type] of FIELDS) {
      for (;;) {
        const raw = await ask(`${field} [${display(field, next[field])}]: `);
        if (raw === null) return null;
        if (raw === '') break;
        const parsed = parseField(type, raw);
        if (parsed.error) { output.write(`  ${field} must be ${parsed.error}\n`); continue; }
        next[field] = parsed.value;
        break;
      }
    }
    return next;
  };

  try {
    for (let i = 0; i < pending.length; i++) {
      const { id } = pending[i];
      // An edit that is not valid yet is kept here, unsaved, for the next
      // edit; while it exists the question cannot be accepted.
      let draft = null;
      output.write(describeQuestion(review.get(id), index, i + 1, pending.length));
      let decided = false;
      while (!decided) {
        const cmd = await ask('[a]ccept  [e]dit  [r]eject  [s]kip  [q]uit > ');
        if (cmd === null || cmd === 'q') { stopped = true; return result(); }
        if (cmd === 'a') {
          const res = draft ? { ok: false, errors: validateQuestion(draft, { index, sessionId }) } : review.accept(id);
          if (!res.ok) { output.write(`Cannot accept:\n  ${res.errors.join('\n  ')}\n`); continue; }
          decided = true;
        } else if (cmd === 'r') {
          const reason = await ask('Reason (optional): ');
          review.reject(id, reason || '');
          decided = true;
          if (reason === null) { stopped = true; return result(); }
        } else if (cmd === 's') {
          review.skip(id);
          decided = true;
        } else if (cmd === 'e') {
          const edited = await edit(draft || review.get(id));
          if (edited === null) { stopped = true; return result(); }
          const fields = Object.fromEntries(FIELDS.map(([f]) => [f, edited[f]]));
          const res = review.edit(id, fields);
          if (res.ok) {
            draft = null;
          } else {
            draft = edited;
            output.write(`Not valid yet (not saved):\n  ${res.errors.join('\n  ')}\n`);
          }
          output.write(describeQuestion(draft || review.get(id), index, i + 1, pending.length));
        } else {
          output.write('Type a, e, r, s or q.\n');
        }
      }
    }
    return result();
  } finally {
    rl.close();
  }
}

module.exports = { verifyLoop };

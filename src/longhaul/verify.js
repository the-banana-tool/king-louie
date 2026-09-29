'use strict';
// The verify loop (benchmark spec §6): a reviewer accepts, edits or rejects
// each unverified candidate. Only a valid question can be accepted; an edit
// is saved only when valid and is never accepted by itself; progress is
// saved after every decision. The loop's own text is ASCII.
const readline = require('readline');
const { KINDS, validateQuestion, normalizeQuestion, computeDistance, bucketFor } = require('./questions');
const { messageText, senderLabel } = require('./session-format');
const { UsageError } = require('./errors');

const SHOW_CHARS = 1500;
const REVIEWER_RE = /^[A-Za-z0-9._-]{1,32}$/;
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
  if (!REVIEWER_RE.test(reviewer || '')) throw new UsageError('--reviewer <initials> is required (letters, digits, . _ -)');
  const { index } = session;
  const sessionId = session.manifest.sessionId;
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value.trim();
  };

  let current = questions.slice();
  const replace = (q) => { current = current.map((x) => (x.id === q.id ? q : x)); };
  const pending = current.filter((q) => q.verifiedBy === null).sort((a, b) => a.askAtSeq - b.askAtSeq || a.id.localeCompare(b.id));
  const counts = { accepted: 0, edited: 0, rejected: 0, skipped: 0, stopped: false };

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
      let q = pending[i];
      output.write(describeQuestion(q, index, i + 1, pending.length));
      let decided = false;
      while (!decided) {
        const cmd = await ask('[a]ccept  [e]dit  [r]eject  [s]kip  [q]uit > ');
        if (cmd === null || cmd === 'q') { counts.stopped = true; return counts; }
        if (cmd === 'a') {
          const errors = validateQuestion(q, { index, sessionId });
          if (errors.length) { output.write(`Cannot accept:\n  ${errors.join('\n  ')}\n`); continue; }
          q = { ...normalizeQuestion(q, index), verifiedBy: `human:${reviewer}` };
          replace(q);
          onSave(current, null);
          counts.accepted += 1;
          decided = true;
        } else if (cmd === 'r') {
          const reason = await ask('Reason (optional): ');
          current = current.filter((x) => x.id !== q.id);
          onSave(current, { ...q, rejectedBy: `human:${reviewer}`, rejectReason: reason || '', rejectedAt: now().toISOString() });
          counts.rejected += 1;
          decided = true;
          if (reason === null) { counts.stopped = true; return counts; }
        } else if (cmd === 's') {
          counts.skipped += 1;
          decided = true;
        } else if (cmd === 'e') {
          const edited = await edit(q);
          if (edited === null) { counts.stopped = true; return counts; }
          q = edited;
          const errors = validateQuestion(q, { index, sessionId });
          if (errors.length) {
            output.write(`Not valid yet (not saved):\n  ${errors.join('\n  ')}\n`);
          } else {
            q = normalizeQuestion(q, index);
            replace(q);
            onSave(current, null);
            counts.edited += 1;
          }
          output.write(describeQuestion(q, index, i + 1, pending.length));
        } else {
          output.write('Type a, e, r, s or q.\n');
        }
      }
    }
    return counts;
  } finally {
    rl.close();
  }
}

module.exports = { verifyLoop };

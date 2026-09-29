// src/history/excerpts.js
// What the model is shown from one message (CONTEXT.md "Excerpt"): its
// selected chunks, adjacent ones merged, under a [#seq · sender · age]
// header; and the recalled block that holds a turn's excerpts (spec §6.4).
const RECALLED_PREAMBLE = [
  'Excerpts retrieved from earlier in this conversation. They are verbatim and may be',
  'incomplete. Use SearchHistory to look for more and ReadHistory to read a range of',
  'messages by number.'
].join('\n');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

function formatAge(ts, asOfMs) {
  const t = Date.parse(ts || '');
  if (!Number.isFinite(t) || !Number.isFinite(asOfMs)) return 'unknown time';
  const d = Math.max(0, asOfMs - t);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return ago(Math.floor(d / MINUTE), 'minute');
  if (d < DAY) return ago(Math.floor(d / HOUR), 'hour');
  if (d < 60 * DAY) return ago(Math.floor(d / DAY), 'day');
  if (d < 730 * DAY) return ago(Math.floor(d / (30 * DAY)), 'month');
  return ago(Math.floor(d / (365 * DAY)), 'year');
}

function senderLabel(chunk) {
  switch (chunk.sender) {
    case 'toolUse': return `${chunk.toolName || 'tool'} call`;
    case 'toolResult': return `${chunk.toolName || 'tool'} result`;
    // A chunk (kind 'summary') or a message (ReadHistory) can be labelled.
    case 'status': return chunk.kind === 'summary' || (chunk.meta && chunk.meta.compaction === true) ? 'compaction summary' : 'status';
    default: return chunk.sender || chunk.kind || 'message';
  }
}

// A chunk is data: it must not be able to end the block it sits in.
const neutralize = (text) => String(text).replace(/<\/?recalled_history>/gi, '[recalled_history tag]');

function formatExcerpts(chunks, { chatId = null, asOf = Date.now(), chunkCounts = new Map(), chatTitles = new Map(), order = 'seq' } = {}) {
  const groups = new Map();
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!c) continue;
    if (!groups.has(c.messageId)) groups.set(c.messageId, []);
    groups.get(c.messageId).push(c);
  }
  const list = [...groups.values()];
  if (order === 'seq') {
    const rank = (c) => (c.chatId === chatId ? 0 : 1);
    list.sort((a, b) => rank(a[0]) - rank(b[0]) || String(a[0].chatId).localeCompare(String(b[0].chatId)) || a[0].seq - b[0].seq);
  }
  return list.map((group) => {
    const sorted = [...group].sort((a, b) => a.idx - b.idx);
    const runs = [];
    for (const c of sorted) {
      const last = runs[runs.length - 1];
      if (last && c.idx === last.to + 1) {
        last.to = c.idx;
        last.chunks.push(c);
      } else {
        runs.push({ from: c.idx, to: c.idx, chunks: [c] });
      }
    }
    const first = sorted[0];
    const total = chunkCounts.get(first.messageId) || sorted.length;
    const parts = [];
    if (chatId && first.chatId !== chatId) parts.push(`chat "${chatTitles.get(first.chatId) || first.chatId}"`);
    parts.push(`#${first.seq}`, senderLabel(first));
    if (total > 1) {
      const positions = runs.map((r) => (r.from === r.to ? `${r.from + 1}` : `${r.from + 1}–${r.to + 1}`)).join(', ');
      parts.push(`${sorted.length === 1 ? 'excerpt' : 'excerpts'} ${positions} of ${total}`);
    }
    parts.push(formatAge(first.ts, asOf));
    return {
      chatId: first.chatId,
      messageId: first.messageId,
      seq: first.seq,
      header: `[${parts.join(' · ')}]`,
      text: runs.map((r) => r.chunks.map((c) => neutralize(c.text)).join('\n\n')).join('\n\n[…]\n\n'),
      chunkIds: sorted.map((c) => c.id)
    };
  });
}

function formatRecalledBlock(excerpts) {
  if (!Array.isArray(excerpts) || !excerpts.length) return '';
  return [
    '<recalled_history>',
    RECALLED_PREAMBLE,
    '',
    excerpts.map((e) => `${e.header}\n${e.text}`).join('\n\n'),
    '</recalled_history>'
  ].join('\n');
}

module.exports = { RECALLED_PREAMBLE, formatAge, senderLabel, formatExcerpts, formatRecalledBlock };

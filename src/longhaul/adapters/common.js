'use strict';
// Shared pieces for LongHaul adapters (benchmark spec §7).
const { performance } = require('node:perf_hooks');
const { estimateTokens, renderMessage, CHARS_PER_TOKEN } = require('../session-format');

// Recall spec §14 defaults for the tail, used by the oracle's tail.
const TAIL_DEFAULTS = Object.freeze({ tailMessages: 8, tailTokens: 6000 });

// Wall time and CPU time around one context() call.
async function measured(fn) {
  const t0 = performance.now();
  const c0 = process.cpuUsage();
  const value = await fn();
  const cpu = process.cpuUsage(c0);
  return { ...value, latencyMs: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000 };
}

// The newest user and assistant messages before askAtSeq: at most
// tailMessages, until tailTokens would be exceeded (the newest is always
// kept). Ascending by seq.
function tailBefore(index, askAtSeq, { tailMessages, tailTokens }) {
  const picked = [];
  let used = 0;
  for (let seq = Math.min(askAtSeq - 1, index.maxSeq); seq >= 1 && picked.length < tailMessages; seq--) {
    const m = index.get(seq);
    if (m.sender !== 'user' && m.sender !== 'assistant') continue;
    const t = estimateTokens(renderMessage(m));
    if (picked.length > 0 && used + t > tailTokens) break;
    picked.push(m);
    used += t;
  }
  return picked.reverse();
}

function uniqueSorted(seqs) {
  return [...new Set(seqs)].sort((a, b) => a - b);
}

const CUT_MARKER_MAX = 40;

// Messages fromSeq..beforeSeq-1, newest first, until `limit` estimated
// tokens: sliding-window, full-history, real-compaction and summarize-compact
// all cut this way. When the newest message alone is over the limit, its end
// is shown and it counts as partly shown; a limit too small for the cut
// marker leaves it out entirely (slice(-0) would be all of it). truncated
// says older messages in the range were left out.
function newestFirst(index, { fromSeq = 1, beforeSeq, limit }) {
  const parts = [];
  const seqs = [];
  const partial = [];
  let used = 0;
  let truncated = false;
  for (let seq = Math.min(beforeSeq - 1, index.maxSeq); seq >= fromSeq; seq--) {
    const text = renderMessage(index.get(seq));
    const t = estimateTokens(`${text}\n\n`);
    if (used + t > limit) {
      truncated = true;
      const keep = limit * CHARS_PER_TOKEN - CUT_MARKER_MAX;
      if (parts.length === 0 && keep > 0) {
        parts.push(`[... earlier part of #${seq} cut]\n${text.slice(-keep)}`);
        partial.push(seq);
      }
      break;
    }
    parts.push(text);
    seqs.push(seq);
    used += t;
  }
  return { text: parts.reverse().join('\n\n'), seqs: uniqueSorted(seqs), partial, truncated };
}

module.exports = { TAIL_DEFAULTS, measured, tailBefore, uniqueSorted, newestFirst };

'use strict';
// Shared pieces for LongHaul adapters (benchmark spec §7).
const { performance } = require('node:perf_hooks');
const { estimateTokens, renderMessage } = require('../session-format');

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

module.exports = { TAIL_DEFAULTS, measured, tailBefore, uniqueSorted };

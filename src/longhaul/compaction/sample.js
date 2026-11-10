'use strict';
// Fact anchors inside one compaction window (benchmark spec §9 step 1),
// drawn round-robin across kinds from a seeded RNG. A count the window
// cannot fill is reported as shortfall, never faked.
const { createRng } = require('../rng');
const { ANCHOR_SENDERS, SPAN_RADIUS, MIN_ANCHOR_CHARS } = require('../sampling');
const { messageText } = require('../session-format');
const { UsageError } = require('../errors');

const FACT_KINDS = Object.freeze(['user-said', 'tool-observed', 'decision']);

function planWindowFacts(index, window, { count, seed, kinds = FACT_KINDS }) {
  if (!Number.isInteger(count) || count <= 0) throw new UsageError('--facts-per-window must be a positive whole number');
  const rng = createRng(seed);
  const { windowFromSeq, windowToSeq, summarySeq } = window;
  const inWindow = index.messages.filter((m) => m.seq >= windowFromSeq && m.seq <= windowToSeq
    && messageText(m).trim().length >= MIN_ANCHOR_CHARS);
  const queues = kinds.map((kind) => rng.shuffle(
    inWindow.filter((m) => ANCHOR_SENDERS[kind].includes(m.sender)).map((m) => m.seq)
  ));
  const used = new Set();
  const items = [];
  let took = true;
  while (items.length < count && took) {
    took = false;
    for (let k = 0; k < kinds.length && items.length < count; k++) {
      const queue = queues[k];
      while (queue.length && used.has(queue[0])) queue.shift();
      if (!queue.length) continue;
      const anchorSeq = queue.shift();
      used.add(anchorSeq);
      took = true;
      items.push({
        kind: kinds[k],
        anchorSeq,
        spanFrom: Math.max(windowFromSeq, anchorSeq - SPAN_RADIUS),
        spanTo: Math.min(windowToSeq, anchorSeq + SPAN_RADIUS),
        tokensToSummary: index.tokensBetween(anchorSeq, summarySeq)
      });
    }
  }
  return { items, shortfall: count - items.length };
}

module.exports = { FACT_KINDS, planWindowFacts };

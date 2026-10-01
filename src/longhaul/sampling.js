'use strict';
// Stratified sampling for authoring (benchmark spec §6): evidence anchors and
// question points by kind and by distance bucket, from a seeded RNG, so the
// set is not dominated by recent prose. A cell the session cannot fill is
// reported as shortfall, never faked.
const { createRng } = require('./rng');
const { KINDS, BUCKETS, NO_BUCKET } = require('./questions');
const { messageText } = require('./session-format');
const { UsageError } = require('./errors');
const { byCodeUnit } = require('./files');

const ANCHOR_SENDERS = Object.freeze({
  'user-said': ['user'],
  'tool-observed': ['toolResult'],
  decision: ['assistant', 'user'],
  superseded: ['user', 'assistant'],
  'multi-hop': ['user', 'assistant']
});
const SPAN_RADIUS = 10;
const MIN_ANCHOR_CHARS = 40;
const PAIR_TRIES = 25;

function splitEvenly(total, parts, rng) {
  const base = Math.floor(total / parts);
  const out = new Array(parts).fill(base);
  const order = rng.shuffle([...out.keys()]);
  for (let i = 0; i < total - base * parts; i++) out[order[i]] += 1;
  return out;
}

// First position in a sorted array where a monotone predicate turns true.
function lowerBound(arr, pred) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(arr[mid])) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// User messages after the anchor whose distance from it falls in the bucket.
function askCandidates(index, anchorSeq, bucket) {
  const users = index.userSeqs;
  const from = lowerBound(users, (u) => u > anchorSeq && index.tokensBetween(anchorSeq, u) >= bucket.min);
  const to = lowerBound(users, (u) => u > anchorSeq && index.tokensBetween(anchorSeq, u) >= bucket.max);
  return users.slice(from, to);
}

function planAuthoring(index, { count, seed, kinds = KINDS, excludeSeqs = [] }) {
  if (!Number.isInteger(count) || count <= 0) throw new UsageError('--count must be a positive whole number');
  const rng = createRng(seed);
  const exclude = new Set(excludeSeqs);
  const perKind = splitEvenly(count, kinds.length, rng);
  const items = [];
  const shortfall = [];
  const usedPairs = new Set();
  const usedAbstain = new Set();

  kinds.forEach((kind, k) => {
    if (kind === 'abstain') {
      for (let i = 0; i < perKind[k]; i++) {
        const free = index.userSeqs.filter((u) => u > 2 * SPAN_RADIUS && !usedAbstain.has(u));
        if (!free.length) { shortfall.push({ kind, bucket: NO_BUCKET }); continue; }
        const askAtSeq = rng.pick(free);
        usedAbstain.add(askAtSeq);
        items.push({ kind, bucket: NO_BUCKET, anchorSeq: null, askAtSeq, spanFrom: askAtSeq - 2 * SPAN_RADIUS, spanTo: askAtSeq - 1 });
      }
      return;
    }
    const anchors = index.messages
      .filter((m) => ANCHOR_SENDERS[kind].includes(m.sender) && messageText(m).trim().length >= MIN_ANCHOR_CHARS && !exclude.has(m.seq))
      .map((m) => m.seq);
    const perBucket = splitEvenly(perKind[k], BUCKETS.length, rng);
    BUCKETS.forEach((bucket, b) => {
      if (perBucket[b] === 0) return;
      const eligible = anchors.filter((a) => askCandidates(index, a, bucket).length > 0);
      for (let i = 0; i < perBucket[b]; i++) {
        let placed = null;
        for (let t = 0; t < PAIR_TRIES && eligible.length && !placed; t++) {
          const anchorSeq = rng.pick(eligible);
          const askAtSeq = rng.pick(askCandidates(index, anchorSeq, bucket));
          const key = `${anchorSeq}:${askAtSeq}`;
          if (usedPairs.has(key)) continue;
          usedPairs.add(key);
          placed = {
            kind, bucket: bucket.id, anchorSeq, askAtSeq,
            spanFrom: Math.max(1, anchorSeq - SPAN_RADIUS),
            spanTo: Math.min(askAtSeq - 1, anchorSeq + SPAN_RADIUS)
          };
        }
        if (placed) items.push(placed);
        else shortfall.push({ kind, bucket: bucket.id });
      }
    });
  });
  return { items, shortfall };
}

// The frontier tier's stratified sample (benchmark spec §8.1): questions
// grouped by stratum (kind x distance bucket), each stratum shuffled by a
// seeded RNG, then taken one per stratum in turn, the strata in a seeded
// order. Every prefix of the result is as even across strata as the set
// allows. The first `size` are the sample, and --long-context-sample N gives
// the long-context adapters the first N of the same order. items:
// [{ question, bucket }]; the result is in sample order.
function sampleQuestions(items, { size = items.length, seed = 1 } = {}) {
  if (!Number.isInteger(size) || size <= 0) throw new UsageError('--sample must be a positive whole number');
  const rng = createRng(seed);
  const keyOf = (it) => `${it.question.sessionId}\u0000${it.question.id}`;
  const strata = new Map();
  for (const it of [...items].sort((a, b) => byCodeUnit(keyOf(a), keyOf(b)))) {
    const s = `${it.question.kind}|${it.bucket}`;
    if (!strata.has(s)) strata.set(s, []);
    strata.get(s).push(it);
  }
  const queues = rng.shuffle([...strata.keys()].sort()).map((s) => rng.shuffle(strata.get(s)));
  const out = [];
  for (let round = 0; out.length < size; round++) {
    let took = false;
    for (const queue of queues) {
      if (out.length >= size) break;
      if (round < queue.length) {
        out.push(queue[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

module.exports = { ANCHOR_SENDERS, SPAN_RADIUS, planAuthoring, sampleQuestions };

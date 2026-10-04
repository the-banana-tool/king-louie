// src/history/jev-rerank.js
// Scoring recall candidates with typesafe.ai's Jev (recall spec §6.3 step 6,
// rerank.kind 'jev'), shared by the app (jev-reranker.js) and LongHaul
// (src/longhaul/jev.js), so the request shapes exist once. Each candidate is
// asked a `noul` question ("does it establish what the query asks?"); the
// answer, a probability in [0, 1], is its score.
//   batched    one request per group of candidates, one question per
//              candidate (the app's mode: 0.24 s a turn at topM 100)
//   pointwise  one request per candidate (LongHaul only)
// Jev takes at most STATE_TOKEN_LIMIT tokens of state per request. Groups
// are planned on an estimate of 3 characters a token over the JSON-escaped
// text and kept under maxStateTokens (28K), so dense text still fits; a
// query longer than QUERY_MAX_TOKENS and a candidate too long for a group of
// its own are cut to fit. `ask` is the caller's transport
// (TypesafeProvider#ask, or LongHaul's retrying client); this module sends
// nothing itself. The question wording is the exp/jev-rerank probe's, word
// for word: LongHaul's score cache keys on the query and the chunk text only.
const EST_CHARS_PER_TOKEN = 3;
const STATE_TOKEN_LIMIT = 32000;
const MAX_STATE_TOKENS = 28000;
const MAX_PER_CALL = 60;
const QUERY_MAX_TOKENS = 2000;
// The state's own JSON around the query, and around each candidate.
const BASE_OVERHEAD = 200;
const PER_CANDIDATE_OVERHEAD = 80;
const MODES = Object.freeze(['batched', 'pointwise']);

const QUERY_FRAME = 'The query is a new message in a long chat between an owner and an assistant. '
  + 'Candidates are excerpts from earlier in the same chat.';
const CRITERIA = Object.freeze({
  true: 'The candidate states or establishes the specific fact, value, decision, event or result the query asks about, so it would help answer the query.',
  false: 'The candidate is merely on a similar topic, mentions the same words, or does not contain what the query asks about.'
});

const estTokens = (text) => Math.ceil(JSON.stringify(String(text ?? '')).length / EST_CHARS_PER_TOKEN);

// The text cut so its estimate is at most maxTokens.
function clip(text, maxTokens) {
  const s = String(text ?? '');
  if (estTokens(s) <= maxTokens) return s;
  let out = s.slice(0, Math.max(0, maxTokens * EST_CHARS_PER_TOKEN - 2));
  while (out.length && estTokens(out) > maxTokens) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

function pointwiseQuestion() {
  return {
    type: 'noul',
    instructions: `${QUERY_FRAME} Does candidate_passage establish what query_excerpt asks about?`,
    criteria: { ...CRITERIA }
  };
}

function batchedQuestion(id) {
  return {
    type: 'noul',
    instructions: `${QUERY_FRAME} Does the candidate with id "${id}" establish what the query asks about? Judge only that candidate.`,
    criteria: { ...CRITERIA }
  };
}

// Groups of candidate indexes whose state stays under maxStateTokens and
// holds at most maxPerCall candidates, in order; the query and any
// candidate too long for a group of its own come back cut.
function planBatches(query, texts, { maxStateTokens = MAX_STATE_TOKENS, maxPerCall = MAX_PER_CALL } = {}) {
  const q = clip(query, Math.min(QUERY_MAX_TOKENS, Math.floor(maxStateTokens / 4)));
  const base = estTokens(q) + BASE_OVERHEAD;
  const room = Math.max(1, maxStateTokens - base - PER_CANDIDATE_OVERHEAD);
  const items = texts.map((t) => clip(t, room));
  const groups = [];
  let cur = [];
  let used = base;
  items.forEach((text, i) => {
    const t = estTokens(text) + PER_CANDIDATE_OVERHEAD;
    if (cur.length && (used + t > maxStateTokens || cur.length >= maxPerCall)) {
      groups.push(cur);
      cur = [];
      used = base;
    }
    cur.push(i);
    used += t;
  });
  if (cur.length) groups.push(cur);
  return { query: q, texts: items, groups };
}

// The estimated state tokens of one planned group.
function groupStateTokens(plan, group) {
  return estTokens(plan.query) + BASE_OVERHEAD + group.reduce((n, i) => n + estTokens(plan.texts[i]) + PER_CANDIDATE_OVERHEAD, 0);
}

// At most `limit` calls of fn run at once.
function limiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function noulOf(answers, id) {
  const v = answers && answers[id] ? answers[id].noul : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw Object.assign(new Error(`typesafe.ai returned no score for candidate ${id}`), { code: 'JEV_NO_ANSWER' });
  }
  return v;
}

function abortError(signal) {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  e.cause = signal.reason;
  return e;
}

async function jevScores({
  ask, model, query, texts, mode = 'batched', maxStateTokens = MAX_STATE_TOKENS, maxPerCall = MAX_PER_CALL, concurrency = 4, abortSignal = null
}) {
  if (!MODES.includes(mode)) throw new Error(`Jev mode must be ${MODES.join(' or ')}, got ${JSON.stringify(mode)}`);
  const tally = { inputTokens: 0, outputTokens: 0, requests: 0, model: null };
  if (!texts.length) return { scores: [], ...tally };
  // One signal for every request of this call: the caller's abort, or the
  // first failure (a failed rerank keeps the fused order anyway, so the
  // other groups would be paid for nothing).
  const inner = new AbortController();
  const onAbort = () => inner.abort(abortSignal.reason);
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const limit = limiter(Math.max(1, concurrency));
  const call = (body) => limit(async () => {
    if (inner.signal.aborted) throw abortError(inner.signal);
    tally.requests += 1;
    let r;
    try {
      r = await ask(body, { abortSignal: inner.signal });
    } catch (err) {
      // Abort here, in the failing call's own continuation, so a queued
      // group sees the abort before the limiter starts it.
      inner.abort(err);
      throw err;
    }
    tally.inputTokens += Number(r?.usage?.inputTokens) || 0;
    tally.outputTokens += Number(r?.usage?.outputTokens) || 0;
    if (r?.model) tally.model = r.model;
    return r;
  });
  const scores = new Array(texts.length);
  try {
    if (mode === 'pointwise') {
      const q = clip(query, QUERY_MAX_TOKENS);
      const room = Math.max(1, maxStateTokens - estTokens(q) - BASE_OVERHEAD);
      await Promise.all(texts.map(async (text, i) => {
        const r = await call({ model, state: { query_excerpt: q, candidate_passage: clip(text, room) }, questions: { establishes: pointwiseQuestion() } });
        scores[i] = noulOf(r.answers, 'establishes');
      }));
    } else {
      const plan = planBatches(query, texts, { maxStateTokens, maxPerCall });
      await Promise.all(plan.groups.map(async (group) => {
        const ids = group.map((_, k) => `c${k + 1}`);
        const questions = {};
        for (const id of ids) questions[id] = batchedQuestion(id);
        const r = await call({ model, state: { query: plan.query, candidates: group.map((i, k) => ({ id: ids[k], text: plan.texts[i] })) }, questions });
        group.forEach((i, k) => { scores[i] = noulOf(r.answers, ids[k]); });
      }));
    }
  } catch (err) {
    inner.abort(err);
    if (err && typeof err === 'object') err.jevUsage = { ...tally };
    throw err;
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
  }
  return { scores, ...tally };
}

module.exports = {
  EST_CHARS_PER_TOKEN, STATE_TOKEN_LIMIT, MAX_STATE_TOKENS, MAX_PER_CALL, QUERY_MAX_TOKENS, MODES,
  estTokens, clip, pointwiseQuestion, batchedQuestion, planBatches, groupStateTokens, limiter, noulOf, jevScores
};

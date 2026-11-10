'use strict';
// --fake-models (benchmark spec §14's CI smoke): built-in local models, no
// network and no key. The answer model always declines; the judge reads the
// reply (a decline is "abstained", anything else "incorrect"); the
// summarizer returns a fixed line. They are local (client.local), so they
// cost $0 and need no --send-private: a smoke run exercises the whole answer
// stage and scores it at accuracy 0 and abstain accuracy 1. The local model
// (the local adapters', local inference spec §11.5) says "yes" to a check,
// turns a question into itself as the search query, scores every rerank
// candidate alike and writes a fixed digest. For the compaction-loss study
// the author quotes the first words of the first message it is shown, and
// the judge calls a fact preserved when the summary holds it word for word
// and needed when it is shown any later message.
const { estimateTokens } = require('./session-format');

const between = (text, open, close) => {
  const start = text.indexOf(open);
  return start < 0 ? '' : text.slice(start + open.length, text.indexOf(close, start)).trim();
};

function fakeFact(prompt) {
  const m = /^\[#(\d+) [^\]\n]*\]\n(.+)$/m.exec(prompt.split('\nMessages:\n')[1] || '');
  const quote = m ? m[2].trim().split(/\s+/).slice(0, 6).join(' ') : '';
  return JSON.stringify(quote ? { fact: quote, quote, evidenceSeq: Number(m[1]) } : { skip: true });
}

function fakeCompactionJudge(prompt) {
  const fact = between(prompt, '<fact>', '</fact>').toLowerCase();
  if (prompt.startsWith('You grade one summary')) {
    const kept = fact && between(prompt, '<summary>', '</summary>').toLowerCase().includes(fact);
    return JSON.stringify({ verdict: kept ? 'preserved' : 'lost', reason: 'fake judge' });
  }
  const first = /^\[#(\d+) /m.exec(prompt.split('Later messages:')[1] || '');
  return JSON.stringify(first ? { verdict: 'needed', seqs: [Number(first[1])], reason: 'fake judge' } : { verdict: 'not-needed', seqs: [], reason: 'fake judge' });
}

function fake(model, reply) {
  return {
    provider: 'fake',
    model,
    local: true,
    async complete(prompt) {
      const text = reply(String(prompt));
      return { text, llmMetrics: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text), costUsd: 0 } };
    }
  };
}

function createFakeModels() {
  return {
    answer: fake('fake-answer', () => "I don't know"),
    author: fake('fake-author', fakeFact),
    judge: fake('fake-judge', (prompt) => {
      if (/^You (grade one summary|judge one fact) in a study/.test(prompt)) return fakeCompactionJudge(prompt);
      const start = prompt.indexOf('<reply>');
      const reply = start < 0 ? '' : prompt.slice(start + '<reply>'.length, prompt.indexOf('</reply>', start));
      return JSON.stringify({ verdict: /i don't know/i.test(reply) ? 'abstained' : 'incorrect', reason: 'fake judge' });
    }),
    summarizer: fake('fake-summarizer', () => 'Summary: the session so far.'),
    local: fake('fake-local', (prompt) => {
      if (/Answer yes or no/.test(prompt)) return 'yes';
      // A rerank: every passage alike (pointwise), none named (listwise),
      // so the fused order holds.
      if (/Reply with the number only/.test(prompt)) return '5';
      if (/Reply with the numbers only/.test(prompt)) return '';
      if (/write a short digest/.test(prompt)) return 'Digest: this stretch of the session.';
      const q = /<question>\n([\s\S]*?)\n<\/question>/.exec(prompt);
      return q ? q[1] : '';
    })
  };
}

module.exports = { createFakeModels };

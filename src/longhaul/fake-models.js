'use strict';
// --fake-models (benchmark spec §14's CI smoke): built-in local models, no
// network and no key. The answer model always declines; the judge reads the
// reply (a decline is "abstained", anything else "incorrect"); the
// summarizer returns a fixed line. They are local (client.local), so they
// cost $0 and need no --send-private: a smoke run exercises the whole answer
// stage and scores it at accuracy 0 and abstain accuracy 1. The local model
// (the local adapters', local inference spec §11.5) says "yes" to a check
// and turns a question into itself as the search query.
const { estimateTokens } = require('./session-format');

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
    judge: fake('fake-judge', (prompt) => {
      const start = prompt.indexOf('<reply>');
      const reply = start < 0 ? '' : prompt.slice(start + '<reply>'.length, prompt.indexOf('</reply>', start));
      return JSON.stringify({ verdict: /i don't know/i.test(reply) ? 'abstained' : 'incorrect', reason: 'fake judge' });
    }),
    summarizer: fake('fake-summarizer', () => 'Summary: the session so far.'),
    local: fake('fake-local', (prompt) => {
      if (/Answer yes or no/.test(prompt)) return 'yes';
      const q = /<question>\n([\s\S]*?)\n<\/question>/.exec(prompt);
      return q ? q[1] : '';
    })
  };
}

module.exports = { createFakeModels };

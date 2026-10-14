'use strict';
// kl-recall-rewrite (local inference spec 2026-10-13 §11.3; R-LI-14): a
// probe, not a candidate system. kl-recall, with a local model turning the
// question into the search query (prompts/rewrite-v1.md) that is passed as
// the message to ContextBuilder#build: in place of the question
// (--rewrite-mode replace, the default) or after it (append). Compared
// against kl-recall with the same settings.
//
// One local call per question, cached (model-cache stage "rewrite"). The
// evidence-only run makes the calls; the answer stage and its dry run are
// cache-only (LOCAL_CALLS_MISSING). It sets no usesModel: its calls are $0
// and outside the answer stage's plan. An empty reply falls back to the
// question and is counted.
const { createKlRecallAdapter } = require('./kl-recall');
const { createLocalCaller, localModelLabel } = require('../local-client');
const { loadPrompt, fillTemplate } = require('../prompts');
const { UsageError } = require('../errors');

const REWRITE_MODES = Object.freeze(['replace', 'append']);
const REWRITE_MAX_TOKENS = 64;
// A query longer than the reply could hold is cut there (a server that does
// not honour max_tokens).
const QUERY_MAX_CHARS = REWRITE_MAX_TOKENS * 4;

// The reply's first non-empty line, without surrounding quotes. '' when there is none.
function queryFromReply(text) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, QUERY_MAX_CHARS);
}

function createKlRecallRewriteAdapter({ local = null, rewriteMode = 'replace', rewritePrompt = null, ...rest } = {}) {
  const name = 'kl-recall-rewrite';
  if (!REWRITE_MODES.includes(rewriteMode)) throw new UsageError(`--rewrite-mode must be ${REWRITE_MODES.join(' or ')}, got ${JSON.stringify(rewriteMode)}`);
  const caller = createLocalCaller(local, name);
  const prompt = rewritePrompt || loadPrompt('rewrite');
  let fallbacks = 0;

  const queryFor = async (handle, question) => {
    const text = fillTemplate(prompt.text, { question: question.question });
    const out = await caller.call({
      stage: 'rewrite', prompt: text, promptFile: prompt, maxTokens: REWRITE_MAX_TOKENS,
      meta: { sessionId: handle.session.manifest.sessionId, questionId: question.id }
    });
    const query = queryFromReply(out.text);
    if (!query) {
      fallbacks += 1;
      return question.question;
    }
    return rewriteMode === 'append' ? `${question.question}\n${query}` : query;
  };
  const base = createKlRecallAdapter({ ...rest, name, queryFor });

  return {
    name,
    get modelClient() { return caller.client; },
    localUse: { client: caller.client, prompts: { rewrite: { file: prompt.file, sha256: prompt.sha256 } } },
    describe() {
      return {
        ...base.describe(), name, localModel: localModelLabel(caller.client), localDigest: caller.client.digest ?? null,
        rewriteMode, rewritePromptSha256: prompt.sha256, rewriteMaxTokens: REWRITE_MAX_TOKENS
      };
    },
    prepare: (session, options) => base.prepare(session, options),
    context: (handle, args) => base.context(handle, args),
    release: (handle) => base.release(handle),
    // Numbers only, for adapter-stats.json.
    runStats() {
      return { mode: rewriteMode, ...caller.summary(), fallbacks };
    }
  };
}

module.exports = { createKlRecallRewriteAdapter, queryFromReply, REWRITE_MODES, REWRITE_MAX_TOKENS };

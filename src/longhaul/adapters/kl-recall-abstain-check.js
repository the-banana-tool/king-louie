'use strict';
// kl-recall-abstain-check (local inference spec 2026-10-13 §11.3; R-LI-14):
// a probe, not a candidate system. kl-recall builds the context, then one
// local call (prompts/abstain-check-v1.md) answers whether it holds what is
// needed to answer the question. On "no": --abstain-mode note (the default)
// puts one host line above the context and changes no evidence accounting;
// withhold shows nothing, so its evidence recall is 0 for that question.
// The reply is read strictly (yes or no, any case, one trailing period);
// anything else counts as yes and as unparsed. Compared against kl-recall
// on abstain accuracy, the false-answer rate and answer accuracy together.
//
// One local call per question, cached (model-cache stage "abstain-check");
// cache-only in the answer stage (LOCAL_CALLS_MISSING), as kl-recall-rewrite.
const { createKlRecallAdapter } = require('./kl-recall');
const { createLocalCaller, localModelLabel } = require('../local-client');
const { loadPrompt, fillTemplate } = require('../prompts');
const { estimateTokens } = require('../session-format');
const { UsageError } = require('../errors');

const ABSTAIN_MODES = Object.freeze(['note', 'withhold']);
const ABSTAIN_MAX_TOKENS = 16;
const ABSTAIN_NOTE = '[check] The context below likely does not contain the answer.';

// 'yes', 'no', or null when the reply is neither.
function parseVerdict(text) {
  const m = /^(yes|no)\.?$/i.exec(String(text ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

function createKlRecallAbstainCheckAdapter({ local = null, abstainMode = 'note', abstainPrompt = null, ...rest } = {}) {
  const name = 'kl-recall-abstain-check';
  if (!ABSTAIN_MODES.includes(abstainMode)) throw new UsageError(`--abstain-mode must be ${ABSTAIN_MODES.join(' or ')}, got ${JSON.stringify(abstainMode)}`);
  const caller = createLocalCaller(local, name);
  const prompt = abstainPrompt || loadPrompt('abstainCheck');
  const base = createKlRecallAdapter({ ...rest, name });
  const counts = { yes: 0, no: 0, unparsed: 0, withheld: 0 };

  return {
    name,
    get modelClient() { return caller.client; },
    localUse: { client: caller.client, prompts: { abstainCheck: { file: prompt.file, sha256: prompt.sha256 } } },
    describe() {
      return {
        ...base.describe(), name, localModel: localModelLabel(caller.client), localDigest: caller.client.digest ?? null,
        abstainMode, abstainPromptSha256: prompt.sha256, abstainMaxTokens: ABSTAIN_MAX_TOKENS
      };
    },
    prepare: (session, options) => base.prepare(session, options),

    async context(handle, args) {
      const r = await base.context(handle, args);
      const t0 = Date.now();
      const out = await caller.call({
        stage: 'abstain-check', prompt: fillTemplate(prompt.text, { question: args.question.question, context: r.text }),
        promptFile: prompt, maxTokens: ABSTAIN_MAX_TOKENS,
        meta: { sessionId: handle.session.manifest.sessionId, questionId: args.question.id }
      });
      const latencyMs = r.latencyMs + (Date.now() - t0);
      const verdict = parseVerdict(out.text);
      if (verdict === null) counts.unparsed += 1;
      if (verdict !== 'no') {
        counts.yes += 1;
        return { ...r, latencyMs };
      }
      counts.no += 1;
      if (abstainMode === 'withhold') {
        counts.withheld += 1;
        return { text: '', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 0, cost: 0, latencyMs, cpuMs: r.cpuMs, withheld: true };
      }
      const text = `${ABSTAIN_NOTE}\n\n${r.text}`;
      return { ...r, text, estTokens: estimateTokens(text), latencyMs };
    },

    release: (handle) => base.release(handle),
    // Numbers only, for adapter-stats.json.
    runStats() {
      return { mode: abstainMode, ...caller.summary(), ...counts };
    }
  };
}

module.exports = { createKlRecallAbstainCheckAdapter, parseVerdict, ABSTAIN_MODES, ABSTAIN_NOTE, ABSTAIN_MAX_TOKENS };

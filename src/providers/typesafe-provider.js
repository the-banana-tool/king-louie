// src/providers/typesafe-provider.js
// typesafe.ai's System One API (Jev), used only to rerank recall candidates
// (recall spec §6.3 step 6, history.recall.rerank.kind 'jev'). A decide-only
// provider: it answers noul/choice/score questions about a state and never
// holds a chat, so it is not registered with ProviderFactory, is not one of
// the 14 catalog providers, has no catalog entry (every call is unpriced:
// costUsd null, never $0) and is never offered as a chat model.
//
// POST <baseUrl>/v1/systemone, Bearer key, { model, state, questions } ->
// { model, answers: { <id>: { type, noul } }, usage: { input_tokens,
// output_tokens } }. A noul question is { type: 'noul', instructions,
// criteria: { yes, no } } (an object; a string criteria is refused with
// 422). Errors 401, 422, 429, 529. The request goes through
// BaseProvider.request with options.abortSignal. An error never carries the
// response body's text (a 422 can echo the state, which is chat text): the
// message is "typesafe.ai answered HTTP <status>", and only a short error
// type and code from the body are kept, for the quota check.
const BaseLLMProvider = require('./base-provider');
const { buildProviderError } = require('./provider-error');

const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
const JEV_LATEST = 'jev-latest';
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeId = (v) => (typeof v === 'string' && SAFE_ID.test(v) ? v : '');

class TypesafeProvider extends BaseLLMProvider {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, TYPESAFE_BASE_URL);
  }

  getProviderName() {
    return 'typesafe';
  }

  getDefaultModel() {
    return JEV_LATEST;
  }

  // Never offered as a chat model.
  getModels() {
    return [];
  }

  async listModels(options = {}) {
    void options;
    return [];
  }

  async sendMessage() {
    throw new Error('typesafe.ai Jev answers questions about a state; it is not a chat model.');
  }

  async ask({ model = JEV_LATEST, state, questions } = {}, options = {}) {
    if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
      throw new Error('ask needs at least one question');
    }
    const response = await this.request(`${this.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ model, state, questions })
    }, { ...options, model });
    if (!response.ok) throw await this.buildError(response, { model });
    let json;
    try {
      json = await response.json();
    } catch {
      throw Object.assign(new Error('typesafe.ai answered with a body that is not JSON'), { status: response.status, code: 'JEV_BAD_BODY' });
    }
    const served = typeof json?.model === 'string' && json.model ? json.model : model;
    return {
      answers: json && json.answers && typeof json.answers === 'object' ? json.answers : {},
      usage: { inputTokens: Number(json?.usage?.input_tokens) || 0, outputTokens: Number(json?.usage?.output_tokens) || 0 },
      model: served,
      llmMetrics: this.buildLlmCallMetrics({ model: served, usage: json?.usage || {} })
    };
  }

  async buildError(response, details = {}) {
    let body = null;
    try {
      const text = typeof response?.text === 'function' ? await response.text() : '';
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const e = body && typeof body.error === 'object' && body.error ? body.error : (body && typeof body === 'object' ? body : {});
    return buildProviderError(response, `typesafe.ai answered HTTP ${response?.status ?? 'without a status'}`, {
      provider: this.getProviderName(),
      body: { error: { type: safeId(e.type), code: safeId(e.code) } },
      ...details
    });
  }
}

TypesafeProvider.TYPESAFE_BASE_URL = TYPESAFE_BASE_URL;
TypesafeProvider.JEV_LATEST = JEV_LATEST;

module.exports = TypesafeProvider;

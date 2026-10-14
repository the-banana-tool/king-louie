// src/models/local-probe.js
// Listing and probing a local server's models (spec
// 2026-10-13-local-inference-design.md §6.1; R-LI-7). A model is probed once:
// its context size, whether it calls a tool, and one short smoke call.
//
// Every request here goes through the `fetch` it is given, which is the
// server's pinned transport (src/models/local-transport.js), or through the
// server's provider, whose `request` uses that same transport. Each request
// has a timeout and each reply a size cap. A probe sends only the two fixed
// strings below.
//
// What comes back is an observation about a server the owner runs, not
// policy: it is validated field by field, a failure is "unknown" (never
// "yes"), and nothing here can make a model local or guarantee-grade.
// The reply's first characters are stored as `sample` and never logged.
const { isOllamaCloudModelId } = require('./provider-ids');

const PROBE_TOOL_PROMPT = 'Call the ok tool.';
const PROBE_SMOKE_PROMPT = 'Reply with the word ok.';
const PROBE_TOOL = Object.freeze({
  type: 'function',
  function: Object.freeze({ name: 'ok', description: 'Call this tool.', parameters: Object.freeze({ type: 'object', properties: Object.freeze({}) }) })
});

const MAX_MODELS = 500;
const MAX_ID_LENGTH = 200;
const MAX_CONTEXT = 100000000;
const SAMPLE_LENGTH = 40;
const LIST_CAP_BYTES = 4 * 1024 * 1024;
const REPLY_CAP_BYTES = 256 * 1024;
const LIST_TIMEOUT_MS = 20000;
const TRISTATE = Object.freeze(['yes', 'no', 'unknown']);
const CONTEXT_SOURCES = Object.freeze(['server', 'owner', 'unknown']);
// The fields of a /v1/models entry that hold a context size, by server kind
// (spec assumption A4: vLLM, an LM Studio or generic field, llama.cpp).
const CONTEXT_FIELDS = Object.freeze(['max_model_len', 'context_length', 'max_context_length', 'context_window']);

const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`);
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const root = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

function coded(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** A model id as a server lists it: one plain line of at most 200 characters. */
function plainModelId(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) return null;
  if (CONTROL.test(value) || value !== value.trim()) return null;
  return value;
}

function contextOf(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_CONTEXT ? value : null;
}

/** A timeout for one request, tied to the caller's signal. `done()` always. */
function deadline(parent, ms, label) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(coded('LOCAL_PROBE_TIMEOUT', `${label} timed out after ${ms} ms`));
  }, ms);
  const onAbort = () => controller.abort(parent.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abort: (reason) => controller.abort(reason),
    done: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    }
  };
}

/** A reply's body as text, refused past `cap` bytes (the rest is not read). */
async function readCapped(res, cap) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > cap) throw coded('LOCAL_PROBE_TOO_LARGE', `the reply is too large (over the ${cap} byte cap)`);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      try { await reader.cancel(); } catch { /* the request is ended by its deadline */ }
      throw coded('LOCAL_PROBE_TOO_LARGE', `the reply is too large (over the ${cap} byte cap)`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function getJson(fetchImpl, url, init, { signal = null, timeoutMs, cap, label }) {
  const limit = deadline(signal, timeoutMs, label);
  try {
    const res = await fetchImpl(url, { ...init, signal: limit.signal });
    if (!res.ok) {
      try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* nothing to read */ }
      throw coded('LOCAL_PROBE_STATUS', `${label} returned ${res.status}`, { status: res.status });
    }
    const text = await readCapped(res, cap);
    try {
      return JSON.parse(text);
    } catch {
      throw coded('LOCAL_PROBE_MALFORMED', `${label} did not return JSON`);
    }
  } finally {
    limit.done();
  }
}

/**
 * What a server lists (§6.1 step 1): `kind: 'ollama'` → `/api/tags`; any
 * other kind → `GET <baseUrl>/v1/models`. Ids that are not one plain line are
 * dropped, a repeated id is kept once, and at most 500 are listed. A cloud id
 * on an Ollama server is marked, never probed.
 * @returns {Promise<{ id: string, cloud: boolean, context: number|null, digest: string|null }[]>}
 * @throws with `status` when the server answers with an error; nothing is guessed
 */
async function discoverModels(server, { fetch: fetchImpl, signal = null, headers = {}, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Listing a local server needs its transport\'s fetch.');
  const base = root(server?.baseUrl);
  const ollama = server?.kind === 'ollama';
  const path = ollama ? '/api/tags' : '/v1/models';
  const body = await getJson(fetchImpl, `${base}${path}`, { method: 'GET', headers }, { signal, timeoutMs, cap: LIST_CAP_BYTES, label: `The model list (${path})` });
  const raw = ollama ? body?.models : body?.data;
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_MODELS) break;
    if (!isPlainObject(item)) continue;
    const id = plainModelId(ollama ? (item.name || item.model) : item.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    let context = null;
    let digest = null;
    if (ollama) {
      const hex = typeof item.digest === 'string' ? item.digest.replace(/^sha256:/, '').toLowerCase() : '';
      if (/^[0-9a-f]{64}$/.test(hex)) digest = `sha256:${hex}`;
    } else {
      for (const field of CONTEXT_FIELDS) context = context ?? contextOf(item[field]);
      if (isPlainObject(item.meta)) context = context ?? contextOf(item.meta.n_ctx_train) ?? contextOf(item.meta.n_ctx);
    }
    out.push({ id, cloud: ollama && isOllamaCloudModelId(id), context, digest });
  }
  return out;
}

/** The ids a server lists. @returns {Promise<string[]>} */
async function listModels(server, options = {}) {
  return (await discoverModels(server, options)).map((m) => m.id);
}

const oneLine = (text) => String(text).replace(CONTROL_ALL, ' ');
const sampleOf = (text) => Array.from(oneLine(text)).slice(0, SAMPLE_LENGTH).join('');

// A failed step, as it is stored: the step, and a code or a status. Never a
// server's own words.
function stepError(step, err, limit) {
  if (limit && limit.timedOut()) return `${step}: ${err && err.code === 'LOCAL_PROBE_TIMEOUT' ? err.message : 'timed out'}`;
  if (err && err.code === 'LOCAL_PROBE_STATUS') return `${step}: the server returned ${err.status}`;
  if (err && typeof err.code === 'string' && err.code.startsWith('LOCAL_PROBE_')) return `${step}: ${err.message}`;
  const code = err && (err.code || err.cause?.code || err.name);
  return `${step}: ${typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : 'failed'}`;
}

function emptyRecord() {
  return {
    probedAt: null,
    context: null,
    contextSource: 'unknown',
    toolCall: 'unknown',
    imageInput: 'unknown',
    stream: null,
    usageReported: null,
    firstTokenMs: null,
    tokensPerSecond: null,
    sample: '',
    digest: null,
    adapters: [],
    error: null
  };
}

/**
 * A stored record, read back field by field. A value that is not what the
 * field holds becomes "unknown" (or null); a key that is not a record's is
 * dropped. Returns null for something that is not a record at all.
 */
function readRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const record = emptyRecord();
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const flag = (v) => (typeof v === 'boolean' ? v : null);
  record.probedAt = typeof raw.probedAt === 'string' && !Number.isNaN(Date.parse(raw.probedAt)) ? raw.probedAt : null;
  record.context = contextOf(raw.context);
  record.contextSource = record.context !== null && CONTEXT_SOURCES.includes(raw.contextSource) ? raw.contextSource : 'unknown';
  if (record.contextSource === 'unknown') record.context = null;
  record.toolCall = TRISTATE.includes(raw.toolCall) ? raw.toolCall : 'unknown';
  record.imageInput = TRISTATE.includes(raw.imageInput) ? raw.imageInput : 'unknown';
  record.stream = flag(raw.stream);
  record.usageReported = flag(raw.usageReported);
  record.firstTokenMs = number(raw.firstTokenMs);
  record.tokensPerSecond = number(raw.tokensPerSecond);
  record.sample = typeof raw.sample === 'string' ? sampleOf(raw.sample) : '';
  record.digest = typeof raw.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(raw.digest) ? raw.digest : null;
  record.error = typeof raw.error === 'string' && raw.error ? oneLine(raw.error).slice(0, 200) : null;
  // The owner said so (LocalServers#setModelInfo): kept through a new probe.
  if (raw.imageInputSource === 'owner' && record.imageInput !== 'unknown') record.imageInputSource = 'owner';
  return record;
}

function wellFormedOkCall(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.some((call) => {
    if (!isPlainObject(call) || !isPlainObject(call.function) || call.function.name !== PROBE_TOOL.function.name) return false;
    if (call.type !== undefined && call.type !== 'function') return false;
    const args = call.function.arguments;
    if (args === undefined || args === null || args === '') return true;
    if (isPlainObject(args)) return true;
    if (typeof args !== 'string') return false;
    try {
      return isPlainObject(JSON.parse(args));
    } catch {
      return false;
    }
  });
}

const tokenCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const reportsUsage = (usage) => isPlainObject(usage)
  && tokenCount(usage.prompt_tokens) + tokenCount(usage.completion_tokens) + tokenCount(usage.total_tokens) > 0;

/**
 * Probe one model (§6.1 steps 2 to 5). Never throws: a step that fails
 * leaves its fields "unknown" (or null) and the first failure is recorded in
 * `error`.
 *
 * @param {{ id?: string, kind: string, baseUrl: string }} server
 * @param {string} model - the server's own id for the model (no `<serverId>/` prefix)
 * @param {object} options
 * @param {object} [options.provider] - the server's LocalServerProvider: requests go through its `request` with its headers
 * @param {Function} [options.fetch] - the server's transport `fetch`, used when there is no provider
 * @param {number} [options.timeoutMs] - per request
 * @param {{ context?: number|null, digest?: string|null }} [options.listed] - what the listing said about this model
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.now]
 * @returns {Promise<object>} the record of spec §6.1
 */
async function probeModel(server, model, { provider = null, fetch: fetchImpl = null, timeoutMs = 60000, listed = null, signal = null, now = () => new Date() } = {}) {
  const record = emptyRecord();
  const fail = (message) => { if (record.error === null) record.error = message; };
  try {
    const base = root(server?.baseUrl);
    const ownHeaders = provider && typeof provider.getHeaders === 'function' ? provider.getHeaders() : { 'Content-Type': 'application/json' };
    const send = (url, init, sig) => {
      const request = { ...init, headers: { ...ownHeaders, ...(init.headers || {}) } };
      if (provider && typeof provider.request === 'function') return provider.request(url, request, { abortSignal: sig, model: `${provider.serverId}/${model}` });
      if (typeof fetchImpl !== 'function') throw coded('LOCAL_PROBE_NO_TRANSPORT', 'no transport');
      return fetchImpl(url, { ...request, signal: sig });
    };
    const post = (url, body, sig) => send(url, { method: 'POST', body: JSON.stringify(body) }, sig);
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;

    if (isPlainObject(listed)) {
      const context = contextOf(listed.context);
      if (context !== null) { record.context = context; record.contextSource = 'server'; }
      if (typeof listed.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(listed.digest)) record.digest = listed.digest;
    }

    // Ollama says what a model is in /api/show: its context length, and
    // whether it sees images. Its word on tools is kept only to lower the
    // tool step's answer, never to raise it.
    let toolsReported = null;
    if (server?.kind === 'ollama') {
      const limit = deadline(signal, ms, 'The model details');
      try {
        const info = await getJson((url, init) => send(url, init, init.signal), `${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }) }, { signal: limit.signal, timeoutMs: ms, cap: LIST_CAP_BYTES, label: 'The model details' });
        const modelInfo = isPlainObject(info?.model_info) ? info.model_info : {};
        const contextKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
        const context = contextKey ? contextOf(modelInfo[contextKey]) : null;
        if (context !== null) { record.context = context; record.contextSource = 'server'; }
        if (Array.isArray(info?.capabilities)) {
          record.imageInput = info.capabilities.includes('vision') ? 'yes' : 'no';
          toolsReported = info.capabilities.includes('tools');
        }
      } catch (err) {
        fail(stepError('details', err, limit));
      } finally {
        limit.done();
      }
    }

    // Tool calling: one trivial tool, one fixed sentence.
    {
      const limit = deadline(signal, ms, 'The tool step');
      try {
        const res = await post(`${base}/v1/chat/completions`, {
          model,
          messages: [{ role: 'user', content: PROBE_TOOL_PROMPT }],
          tools: [PROBE_TOOL],
          tool_choice: 'auto',
          temperature: 0,
          max_tokens: 256,
          stream: false
        }, limit.signal);
        if (!res.ok) {
          try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* nothing to read */ }
          throw coded('LOCAL_PROBE_STATUS', 'the tool step failed', { status: res.status });
        }
        let data;
        try {
          data = JSON.parse(await readCapped(res, REPLY_CAP_BYTES));
        } catch (err) {
          throw err && err.code === 'LOCAL_PROBE_TOO_LARGE' ? err : coded('LOCAL_PROBE_MALFORMED', 'the reply was not JSON');
        }
        const message = data?.choices?.[0]?.message;
        if (!isPlainObject(message)) throw coded('LOCAL_PROBE_MALFORMED', 'the reply held no message');
        record.toolCall = wellFormedOkCall(message) ? 'yes' : 'no';
      } catch (err) {
        record.toolCall = toolsReported === false ? 'no' : 'unknown';
        fail(stepError('tool step', err, limit));
      } finally {
        limit.done();
      }
    }

    // The smoke call: time to the first token, a rate, whether usage is
    // reported, and the first characters of the reply.
    {
      const limit = deadline(signal, ms, 'The smoke step');
      const started = Date.now();
      try {
        const res = await post(`${base}/v1/chat/completions`, {
          model,
          messages: [{ role: 'user', content: PROBE_SMOKE_PROMPT }],
          temperature: 0,
          max_tokens: 8,
          stream: true
        }, limit.signal);
        if (!res.ok) {
          try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* nothing to read */ }
          throw coded('LOCAL_PROBE_STATUS', 'the smoke step failed', { status: res.status });
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let buffer = '';
        let whole = '';
        let text = '';
        let events = 0;
        let pieces = 0;
        let usage = null;
        let firstAt = null;
        let finished = false;
        const take = (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') { finished = true; return; }
          let parsed;
          try { parsed = JSON.parse(payload); } catch { return; }
          events += 1;
          if (isPlainObject(parsed?.usage)) usage = parsed.usage;
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content) {
            if (firstAt === null) firstAt = Date.now();
            pieces += 1;
            if (text.length < SAMPLE_LENGTH * 4) text += content;
          }
        };
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          const chunk = decoder.decode(value, { stream: true });
          if (whole.length < REPLY_CAP_BYTES) whole += chunk;
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) take(line);
          if (size > REPLY_CAP_BYTES) {
            fail(`smoke step: the reply is too large (over the ${REPLY_CAP_BYTES} byte cap)`);
            break;
          }
        }
        if (buffer) take(buffer);
        try { await reader.cancel(); } catch { /* already ended */ }
        const ended = Date.now();
        if (events === 0) {
          // Not a stream: the server answered the whole reply as one document.
          let data;
          try { data = JSON.parse(whole); } catch { throw coded('LOCAL_PROBE_MALFORMED', 'the reply was neither a stream nor JSON'); }
          const content = data?.choices?.[0]?.message?.content;
          record.stream = false;
          text = typeof content === 'string' ? content : '';
          usage = isPlainObject(data?.usage) ? data.usage : null;
          firstAt = ended;
          pieces = text ? 1 : 0;
        } else {
          record.stream = true;
        }
        record.usageReported = reportsUsage(usage);
        record.firstTokenMs = firstAt === null ? null : Math.max(0, firstAt - started);
        const tokens = tokenCount(usage?.completion_tokens) || pieces;
        const seconds = (ended - started) / 1000;
        record.tokensPerSecond = tokens > 0 && seconds > 0 ? Math.round((tokens / seconds) * 10) / 10 : null;
        record.sample = sampleOf(text);
      } catch (err) {
        record.stream = null;
        record.usageReported = null;
        record.firstTokenMs = null;
        record.tokensPerSecond = null;
        record.sample = '';
        fail(stepError('smoke step', err, limit));
      } finally {
        limit.abort(coded('LOCAL_PROBE_DONE', 'the probe is done with this reply'));
        limit.done();
      }
    }
  } catch (err) {
    fail(stepError('probe', err, null));
  }
  record.probedAt = now().toISOString();
  return record;
}

module.exports = {
  PROBE_TOOL_PROMPT,
  PROBE_SMOKE_PROMPT,
  MAX_CONTEXT,
  plainModelId,
  discoverModels,
  listModels,
  probeModel,
  readRecord,
  emptyRecord
};

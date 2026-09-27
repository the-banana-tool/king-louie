// tests/helpers/fake-llm-server.js
// One local HTTP server that answers in every provider dialect King Louie
// ships: OpenAI-compatible chat completions, Anthropic messages, Gemini
// generateContent, Cohere v2 chat, Copilot's token exchange, and Ollama's
// native /api/tags and /api/show. The first path segment names the provider:
// a provider built with baseUrl `${url}/groq/openai/v1` gets the OpenAI
// dialect. Listens on 127.0.0.1 only.
//
// Hold mode: a stream stops after its first text chunk and stays open until
// the client goes away — how the Stop tests catch an abort mid-stream.
const http = require('http');

const TOOL_ARGS = Object.freeze({ q: 'weather' });
const OLLAMA_MODELS = Object.freeze({
  'test-model': { model_info: { 'llama.context_length': 8192 }, capabilities: ['completion', 'tools'] },
  'vision-model': { model_info: {}, capabilities: ['completion', 'vision'] }
});

async function startFakeLlmServer() {
  const state = { requests: [], hold: false, closed: 0, waiters: [], open: new Set() };

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // A stream the client drops before it ends counts as an aborted stream.
  const startSse = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    state.open.add(res);
    res.on('close', () => {
      state.open.delete(res);
      if (!res.writableEnded) {
        state.closed += 1;
        for (const waiter of state.waiters.splice(0)) waiter();
      }
    });
  };
  const data = (res, payload) => res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  const hasTools = (body) => Array.isArray(body.tools) && body.tools.length > 0;

  const openaiChat = (res, body) => {
    const model = body.model || 'test-model';
    if (body.stream) {
      startSse(res);
      data(res, { model, choices: [{ delta: { content: 'Hello' } }] });
      if (state.hold) return;
      data(res, { model, choices: [{ delta: { content: ' there' } }] });
      data(res, { model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
      data(res, '[DONE]');
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, {
        model,
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Lookup', arguments: JSON.stringify(TOOL_ARGS) } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
      });
      return;
    }
    sendJson(res, 200, { model, choices: [{ message: { role: 'assistant', content: 'Hello there' } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
  };

  const anthropicMessages = (res, body) => {
    const model = body.model || 'test-model';
    if (body.stream) {
      startSse(res);
      data(res, { type: 'message_start', message: { model, usage: { input_tokens: 1200, output_tokens: 1 } } });
      if (hasTools(body) && !state.hold) {
        data(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Lookup' } });
        data(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } });
        data(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"weather"}' } });
        data(res, { type: 'content_block_stop', index: 0 });
        data(res, { type: 'message_delta', usage: { output_tokens: 5 } });
        data(res, { type: 'message_stop' });
        res.end();
        return;
      }
      data(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      data(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
      if (state.hold) return;
      data(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } });
      data(res, { type: 'content_block_stop', index: 0 });
      data(res, { type: 'message_delta', usage: { output_tokens: 2 } });
      data(res, { type: 'message_stop' });
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, { model, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Lookup', input: TOOL_ARGS }], usage: { input_tokens: 20, output_tokens: 5 } });
      return;
    }
    sendJson(res, 200, { model, content: [{ type: 'text', text: 'Hello there' }], usage: { input_tokens: 12, output_tokens: 2 } });
  };

  const gemini = (res, body, tail) => {
    const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 };
    if (tail.includes(':streamGenerateContent')) {
      startSse(res);
      data(res, { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] });
      if (state.hold) return;
      data(res, { candidates: [{ content: { parts: [{ text: ' there' }] } }], usageMetadata });
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, { candidates: [{ content: { parts: [{ functionCall: { name: 'Lookup', args: TOOL_ARGS } }] } }], usageMetadata });
      return;
    }
    sendJson(res, 200, { candidates: [{ content: { parts: [{ text: 'Hello there' }] } }], usageMetadata });
  };

  const cohere = (res, body) => {
    const model = body.model || 'test-model';
    if (body.stream) {
      startSse(res);
      data(res, { type: 'content-delta', delta: { message: { content: { text: 'Hello' } } } });
      if (state.hold) return;
      data(res, { type: 'content-delta', delta: { message: { content: { text: ' there' } } } });
      data(res, { type: 'message-end', delta: { usage: { billed_units: { input_tokens: 12, output_tokens: 2 } } } });
      res.end();
      return;
    }
    if (hasTools(body)) {
      sendJson(res, 200, {
        model,
        message: { role: 'assistant', content: [], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Lookup', arguments: JSON.stringify(TOOL_ARGS) } }] },
        usage: { billed_units: { input_tokens: 20, output_tokens: 5 } }
      });
      return;
    }
    sendJson(res, 200, { model, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] } });
  };

  const modelsList = (res, provider) => {
    if (provider === 'gemini') return sendJson(res, 200, { models: [{ name: 'models/test-model', supportedGenerationMethods: ['generateContent'] }] });
    if (provider === 'cohere') return sendJson(res, 200, { models: [{ name: 'test-model' }] });
    return sendJson(res, 200, { data: [{ id: 'test-model' }] });
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const [provider = '', ...rest] = url.pathname.split('/').filter(Boolean);
      const tail = `/${rest.join('/')}`;
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      state.requests.push({ provider, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (tail.endsWith('/copilot_internal/v2/token')) {
        sendJson(res, 200, { token: 'copilot-session', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        return;
      }
      if (provider === 'ollama' && tail === '/api/tags') {
        sendJson(res, 200, { models: Object.keys(OLLAMA_MODELS).map((name) => ({ name })) });
        return;
      }
      if (provider === 'ollama' && tail === '/api/show') {
        const info = OLLAMA_MODELS[body.model];
        if (info) sendJson(res, 200, info);
        else sendJson(res, 404, { error: 'model not found' });
        return;
      }
      if (req.method === 'GET' && tail.endsWith('/models')) { modelsList(res, provider); return; }
      if (provider === 'anthropic' && tail.endsWith('/messages')) { anthropicMessages(res, body); return; }
      if (provider === 'gemini' && tail.includes(':')) { gemini(res, body, tail); return; }
      if (provider === 'cohere' && tail.endsWith('/chat')) { cohere(res, body); return; }
      if (tail.endsWith('/chat/completions')) { openaiChat(res, body); return; }
      sendJson(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    setHold: (on) => { state.hold = Boolean(on); },
    closedCount: () => state.closed,
    waitForClosedStream: (count, timeoutMs = 3000) => new Promise((resolve, reject) => {
      if (state.closed >= count) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error(`no aborted stream within ${timeoutMs} ms (closed ${state.closed}, wanted ${count})`)), timeoutMs);
      const check = () => {
        if (state.closed >= count) {
          clearTimeout(timer);
          resolve();
        } else {
          state.waiters.push(check);
        }
      };
      state.waiters.push(check);
    }),
    close: () => new Promise((resolve) => {
      for (const res of state.open) res.destroy();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startFakeLlmServer };

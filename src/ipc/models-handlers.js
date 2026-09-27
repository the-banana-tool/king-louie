// src/ipc/models-handlers.js
// Catalog and availability channels (spec 2026-09-27 §4, §5; stage M1).
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

// What the renderer may ask for; anything else in `needs` is ignored.
function needsFrom(needs) {
  const n = needs && typeof needs === 'object' ? needs : {};
  return {
    ...(n.toolCall === true ? { toolCall: true } : {}),
    ...(n.imageInput === true ? { imageInput: true } : {}),
    ...(n.textOutput === true ? { textOutput: true } : {}),
    ...(Number.isFinite(n.minContext) && n.minContext > 0 ? { minContext: n.minContext } : {})
  };
}

const candidateView = (c) => ({
  provider: c.provider,
  model: c.model,
  name: c.name,
  known: c.known,
  priced: c.priced,
  cost: c.cost,
  context: c.context,
  toolCall: c.toolCall,
  imageInput: c.imageInput,
  local: c.local
});

function registerModelsHandlers(ipcMain, context = {}) {
  const catalog = () => {
    const c = typeof context.getCatalog === 'function' ? context.getCatalog() : null;
    if (!c) throw new Error('The model catalog is not available in this host.');
    return c;
  };
  const availability = () => {
    const a = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
    if (!a) throw new Error('Provider availability is not available in this host.');
    return a;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => (
    fn(payload && typeof payload === 'object' ? payload : {})
  )));

  handle(IPC.MODELS_STATUS, async () => ({ ok: true, catalog: catalog().status(), providers: availability().statusAll() }));

  handle(IPC.MODELS_REFRESH_CATALOG, async () => {
    await catalog().refresh({ force: true });
    return { ok: true, catalog: catalog().status() };
  });

  handle(IPC.MODELS_TEST_ALL, async () => ({ ok: true, providers: await availability().testAll() }));

  handle(IPC.MODELS_USABLE, async ({ needs }) => ({
    ok: true,
    models: availability().usable({ needs: needsFrom(needs) }).map(candidateView)
  }));

  handle(IPC.MODELS_EXPLAIN, async ({ provider, model, needs }) => {
    if (typeof provider !== 'string' || !provider) return { ok: false, error: 'provider is required.' };
    const verdict = availability().explain(provider, typeof model === 'string' ? model : '', { needs: needsFrom(needs) });
    return { ok: true, usable: verdict.usable, reasons: verdict.reasons, notes: verdict.notes };
  });

  handle(IPC.MODELS_SET_OLLAMA_URL, async ({ baseUrl }) => {
    let url;
    try {
      url = new URL(String(baseUrl || '').trim());
    } catch {
      return { ok: false, error: 'Enter a full address, such as http://127.0.0.1:11434.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'The Ollama address must start with http:// or https://.' };
    }
    const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    const settings = context.getSettings();
    context.setSettings({
      ...settings,
      models: { ...(settings.models || {}), ollama: { ...(settings.models?.ollama || {}), baseUrl: normalized } }
    });
    const status = await availability().test('ollama');
    return { ok: true, baseUrl: normalized, status };
  });
}

module.exports = { registerModelsHandlers };

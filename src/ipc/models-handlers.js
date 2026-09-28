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

  // ---- Profiles and the owner's model choices (stage M2) ----

  const choices = () => {
    const c = typeof context.getModelChoices === 'function' ? context.getModelChoices() : null;
    if (!c) throw new Error('Model profiles are not available in this host.');
    return c;
  };
  const targetFrom = (raw) => (raw && typeof raw === 'object'
    ? { provider: String(raw.provider || ''), model: String(raw.model || ''), effort: typeof raw.effort === 'string' && raw.effort ? raw.effort : null }
    : null);
  const text = (v) => (typeof v === 'string' ? v : '');

  handle(IPC.MODELS_PROFILES, async () => ({ ok: true, ...choices().profilesView() }));

  handle(IPC.MODELS_SAVE_PROFILE, async ({ id, name, roles }) => ({
    ok: true,
    profile: choices().saveProfile({ id: text(id) || null, name, roles })
  }));

  handle(IPC.MODELS_DUPLICATE_PROFILE, async ({ id }) => ({ ok: true, profile: choices().duplicateProfile(text(id)) }));

  handle(IPC.MODELS_REMOVE_PROFILE, async ({ id }) => ({ ok: true, ...(await choices().removeProfile(text(id))) }));

  handle(IPC.MODELS_SET_DEFAULT_PROFILE, async ({ id }) => ({ ok: true, defaultProfileId: choices().setDefaultProfile(text(id)) }));

  handle(IPC.MODELS_PICKER, async ({ needs }) => ({ ok: true, ...choices().pickerView({ needs: needsFrom(needs) }) }));

  handle(IPC.MODELS_CHAT_VIEW, async ({ chatId }) => ({ ok: true, view: choices().chatView(text(chatId)) }));

  handle(IPC.MODELS_SET_CHAT_PROFILE, async ({ chatId, profileId }) => ({
    ok: true,
    chat: await choices().setChatProfile(text(chatId), text(profileId) || null)
  }));

  handle(IPC.MODELS_SET_MAIN_OVERRIDE, async ({ chatId, target }) => ({
    ok: true,
    chat: await choices().setMainOverride(text(chatId), target ? targetFrom(target) : null)
  }));

  // The Models tab's catalog part (spec §11): fetch on or off, the refresh
  // interval, and the owner's overrides ("<provider>:<model>" → partial Entry).
  handle(IPC.MODELS_SAVE_CATALOG_SETTINGS, async ({ fetch, refreshHours, overrides }) => {
    const settings = context.getSettings();
    const models = settings.models || {};
    const catalogSettings = { ...(models.catalog || {}) };
    if (fetch !== undefined) catalogSettings.fetch = fetch === true;
    if (refreshHours !== undefined) {
      const hours = Number(refreshHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { ok: false, error: 'The refresh interval is a whole number of hours from 1 to 720.' };
      catalogSettings.refreshHours = hours;
    }
    let nextOverrides = models.overrides || {};
    if (overrides !== undefined) {
      const valid = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
        && Object.entries(overrides).every(([key, value]) => key.indexOf(':') > 0 && value && typeof value === 'object' && !Array.isArray(value));
      if (!valid) return { ok: false, error: 'Overrides must be an object of "<provider>:<model>" keys, each with an object of catalog fields.' };
      nextOverrides = overrides;
    }
    context.setSettings({ ...settings, models: { ...models, catalog: catalogSettings, overrides: nextOverrides } });
    return { ok: true, catalog: catalog().status() };
  });

  // ---- The King Louie profile (stage M3, spec §7, §11) ----

  const KING_LOUIE_SETTING_KEYS = ['autoAccept', 'preferLocalUtility', 'bandPoints', 'workerAgenticRatio', 'utilityIntelligenceRatio'];

  handle(IPC.MODELS_KING_LOUIE, async () => ({ ok: true, view: choices().kingLouieView() }));

  handle(IPC.MODELS_ACCEPT_PROPOSAL, async ({ proposalId }) => ({ ok: true, profile: choices().acceptProposal(text(proposalId)) }));

  handle(IPC.MODELS_DISMISS_PROPOSAL, async ({ proposalId }) => ({ ok: true, ...choices().dismissProposal(text(proposalId)) }));

  handle(IPC.MODELS_SAVE_KING_LOUIE_SETTINGS, async (payload) => {
    const patch = Object.fromEntries(KING_LOUIE_SETTING_KEYS.filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]]));
    return { ok: true, view: choices().saveKingLouieSettings(patch) };
  });

  handle(IPC.MODELS_DUPLICATE_KING_LOUIE, async ({ name }) => ({ ok: true, profile: choices().duplicateKingLouie({ name: text(name) || undefined }) }));
}

module.exports = { registerModelsHandlers };

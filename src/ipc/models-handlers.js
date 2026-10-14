// src/ipc/models-handlers.js
// Catalog and availability channels (spec 2026-09-27 §4, §5; stage M1).
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { isLocalDesktopEvent, localDesktopDeviceId } = require('../core/origin');

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
    // A model on a local server is the registry's to explain (the core's
    // explainTarget); every other provider is Availability's.
    const local = provider.trim().toLowerCase() === 'local' && typeof context.explainTarget === 'function';
    const verdict = local
      ? context.explainTarget('local', typeof model === 'string' ? model : '', { needs: needsFrom(needs) })
      : availability().explain(provider, typeof model === 'string' ? model : '', { needs: needsFrom(needs) });
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

  handle(IPC.MODELS_DUPLICATE_KING_LOUIE, async ({ name, proposalId }) => ({
    ok: true,
    profile: choices().duplicateKingLouie({ name: text(name) || undefined, proposalId: text(proposalId) || undefined })
  }));

  // ---- Local servers (local inference stage L1, spec 2026-10-13 §5.6, §13.2) ----
  //
  // Adding a server is the owner's mark that it runs on hardware they
  // control (R-LI-4), and a model on a marked server may run a private chat.
  // So the four channels that change the list act only on an event this
  // app's own window sent: marked by the standalone host's ipcMain wrapper,
  // with no device id (a paired desktop's bridge event carries one). In
  // service mode the list is the administrator's and they answer
  // LOCAL_SERVER_ADMIN_ONLY for every caller. Probing a model and saying
  // what a model can do change no trust, but they act for the owner: the
  // window or a paired desktop. No channel here marks a chat private or a
  // role local-only.
  //
  // Every reply carries server names, model ids and probe samples that came
  // from a server or a form: `untrustedText: true`, shown with textContent.
  const registry = () => {
    const r = typeof context.getLocalServers === 'function' ? context.getLocalServers() : null;
    if (!r) throw new Error('Local servers are not available in this host.');
    return r;
  };
  const handleEvent = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (event, payload) => (
    fn(event, payload && typeof payload === 'object' ? payload : {})
  )));
  const fromWindow = (event) => isLocalDesktopEvent(event) && localDesktopDeviceId(event) === null;
  const NOT_WINDOW = Object.freeze({ ok: false, code: 'NOT_LOCAL_WINDOW', error: 'Local servers are changed only in the King Louie window on this computer.' });
  const ADMIN_ONLY = Object.freeze({ ok: false, code: 'LOCAL_SERVER_ADMIN_ONLY', error: 'In service mode local servers come only from the administrator\'s service.json.' });
  // The refusal for a channel that changes the list, or null to go on.
  const refuseChange = (event) => {
    if (registry().adminOnly) return { ...ADMIN_ONLY };
    if (!fromWindow(event)) return { ...NOT_WINDOW };
    return null;
  };
  const serverView = (row) => ({ ...row, models: registry().models(row.id).models });
  const optional = (value) => (value === undefined || value === '' ? null : value);

  handleEvent(IPC.MODELS_LOCAL_LIST, async () => ({
    ok: true,
    untrustedText: true,
    adminOnly: registry().adminOnly,
    servers: registry().list().map(serverView)
  }));

  handleEvent(IPC.MODELS_LOCAL_ADD, async (event, payload) => {
    const refused = refuseChange(event);
    if (refused) return refused;
    // Exactly what the form holds. A pin and a mark are made by the registry.
    const input = { ...payload };
    for (const key of ['name', 'tlsFingerprint', 'maxConcurrent', 'timeoutMs']) {
      if (key in input) input[key] = optional(input[key]);
    }
    const added = await registry().add(input);
    return { ok: true, untrustedText: true, server: added.server, models: added.models, probeError: added.probeError };
  });

  handleEvent(IPC.MODELS_LOCAL_REMOVE, async (event, { id }) => {
    const refused = refuseChange(event);
    if (refused) return refused;
    try {
      return { ok: true, ...(await registry().remove(text(id))) };
    } catch (err) {
      if (err && err.code === 'LOCAL_SERVER_IN_USE') {
        return { ok: false, code: err.code, error: err.message, untrustedText: true, references: err.references || [] };
      }
      throw err;
    }
  });

  handleEvent(IPC.MODELS_LOCAL_RECHECK, async (event, { id, confirm, expected }) => {
    const refused = refuseChange(event);
    if (refused) return refused;
    const result = await registry().recheck(text(id), {
      confirm: confirm === true,
      expected: Array.isArray(expected) ? expected.filter((a) => typeof a === 'string') : null
    });
    return { ok: true, untrustedText: true, ...result };
  });

  handleEvent(IPC.MODELS_LOCAL_PROBE, async (event, { id, model }) => {
    if (!isLocalDesktopEvent(event)) return { ...NOT_WINDOW };
    if (typeof id !== 'string' || !id) return { ok: false, error: 'id is required.' };
    // With a model: probe that one again. Without: list the server's models
    // and probe the ones that never were.
    if (typeof model === 'string' && model) {
      return { ok: true, untrustedText: true, record: await registry().probe(id, model) };
    }
    return { ok: true, untrustedText: true, ...(await registry().refresh(id)) };
  });

  // Owner-entered context and image input, and on the desktop an adapter
  // (`adapter: { id, job, ref }`, spec §12.1): in service mode adapters come
  // only from the admin service.json, so declaring one there is refused.
  handleEvent(IPC.MODELS_LOCAL_SET_MODEL_INFO, async (event, { id, model, context: size, imageInput, adapter }) => {
    if (!isLocalDesktopEvent(event)) return { ...NOT_WINDOW };
    if (typeof id !== 'string' || !id || typeof model !== 'string' || !model) return { ok: false, error: 'id and model are required.' };
    if (adapter !== undefined && registry().adminOnly) {
      return { ok: false, code: 'LOCAL_SERVER_ADMIN_ONLY', error: 'In service mode adapters come only from the administrator\'s service.json.' };
    }
    let record = null;
    if (adapter === undefined || size !== undefined || imageInput !== undefined) record = registry().setModelInfo(id, model, { context: size, imageInput });
    if (adapter !== undefined) record = registry().declareAdapter(id, model, adapter);
    return { ok: true, untrustedText: true, record };
  });

  handleEvent(IPC.MODELS_LOCAL_FROM_OLLAMA, async (event, { id, rewrite }) => {
    const refused = refuseChange(event);
    if (refused) return refused;
    const result = await registry().fromOllama({ ...(typeof id === 'string' && id ? { id } : {}), rewrite: rewrite === true });
    return { ok: true, untrustedText: true, ...result };
  });

  // ---- Custom roles (stage M3, spec §6.2, §11) ----

  handle(IPC.MODELS_SAVE_CUSTOM_ROLE, async ({ id, description, fallback, needs }) => {
    const n = needs && typeof needs === 'object' ? needs : {};
    return {
      ok: true,
      role: choices().saveCustomRole({
        id: text(id),
        description: text(description),
        fallback: text(fallback),
        needs: {
          toolCall: n.toolCall === true,
          imageInput: n.imageInput === true,
          ...(n.minContext !== undefined && n.minContext !== null && n.minContext !== '' ? { minContext: n.minContext } : {})
        }
      })
    };
  });

  handle(IPC.MODELS_REMOVE_CUSTOM_ROLE, async ({ id }) => ({ ok: true, ...choices().removeCustomRole(text(id)) }));
}

module.exports = { registerModelsHandlers };

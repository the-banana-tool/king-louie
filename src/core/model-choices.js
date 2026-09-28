// src/core/model-choices.js
// The owner's model choices between turns (spec 2026-09-27 §6.5, §9, §11,
// §15): the chat and case header (profile picker, main switcher), Retry
// with…'s list, the profile editor's view and model picker, and what a
// deleted profile does to the chats and cases using it. Electron-free; the
// models:* IPC handlers are thin wrappers.
const { createLogger } = require('../logging');
const { normalizeTarget, targetLabel, targetKey } = require('../models/roles');
const { profileView } = require('../models/profile-view');
const { checkEffort, ProfileError } = require('../models/profiles');

const log = createLogger('model-choices');
const PICKER_UNUSABLE_CAP = 400;

function createModelChoices({
  profiles,
  catalog = null,
  availability = null,
  explainTarget,
  snapshotModels,
  getChats,
  setChats,
  appendMessageToChat,
  getCaseRuntime = () => null,
  kingLouie = null,
  getSettings = () => ({})
} = {}) {
  for (const [name, value] of Object.entries({ profiles, explainTarget, snapshotModels, getChats, setChats, appendMessageToChat })) {
    if (!value) throw new Error(`createModelChoices needs ${name}.`);
  }

  const findChat = (chatId) => {
    const chat = getChats().find((c) => c.id === chatId);
    if (!chat) throw new Error('Chat not found.');
    return chat;
  };
  const nameOf = (target) => {
    if (!target) return '(none)';
    const entry = catalog ? catalog.get(target.provider, target.model) : null;
    return entry?.name || target.model;
  };
  const status = (chatId, text) => appendMessageToChat(chatId, 'status', text);
  const updateChat = (chatId, patch) => {
    const now = new Date().toISOString();
    const next = getChats().map((c) => {
      if (c.id !== chatId) return c;
      const out = { ...c, updatedAt: now };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete out[key];
        else out[key] = value;
      }
      return out;
    });
    setChats(next);
    return next.find((c) => c.id === chatId);
  };
  const caseRuntimeFor = (chat) => {
    if (!chat.caseId) return null;
    const runtime = getCaseRuntime();
    if (!runtime) throw new Error('Cases are not available in this host.');
    return runtime;
  };
  const caseMetaOf = (chat) => {
    const runtime = chat.caseId ? getCaseRuntime() : null;
    if (!runtime) return null;
    try {
      return runtime.getCase(chat.caseId);
    } catch {
      return null;
    }
  };
  // A case chat and an agent-mode chat call tools; so must their main.
  const needsFor = (chat) => (chat.caseId || chat.agentMode ? { toolCall: true } : {});

  // The main model actually in use: the first usable target, else the first
  // configured one so there is still something to name (spec §6.5). Shared
  // by chatView (the header) and setMainOverride (its status message), so
  // the two never name different models for the same turn.
  const mainInUse = (models, needs) => {
    const resolved = models.resolve('main', { needs });
    const first = resolved.targets[0] || null;
    return { first, resolved, current: first || models.candidatesFor('main')[0] || null };
  };

  function chatView(chatId) {
    const chat = findChat(chatId);
    const needs = needsFor(chat);
    const models = snapshotModels({ chatId });
    const { first, resolved, current } = mainInUse(models, needs);
    const profileMain = models.configuredFor('main');
    const mainKeys = new Set(profileMain.map(targetKey));
    const fromMain = profileMain
      .filter((x) => explainTarget(x.provider, x.model, { needs }).usable)
      // The profile's own effort travels with its main entries, so picking
      // one sets an override that keeps it (final review m4).
      .map((x) => ({ provider: x.provider, model: x.model, effort: x.effort || null, name: nameOf(x), inMain: true }));
    const others = (availability && typeof availability.usable === 'function' ? availability.usable({ needs: { textOutput: true, ...needs } }) : [])
      .filter((c) => !mainKeys.has(targetKey(c)))
      .map((c) => ({ provider: c.provider, model: c.model, name: c.name || c.model, inMain: false }));
    return {
      chatId,
      caseId: chat.caseId || null,
      profile: { id: models.profileId, name: models.profileName },
      chosenProfileId: chat.caseId ? (caseMetaOf(chat)?.profile || null) : (chat.profileId || null),
      defaultProfileId: profiles.defaultId(),
      profiles: profiles.list().map((p) => ({ id: p.id, name: p.name })),
      main: current
        ? { provider: current.provider, model: current.model, name: nameOf(current), usable: Boolean(first), reasons: first ? [] : (resolved.skipped[0]?.reasons || []) }
        : null,
      overridden: Boolean(models.mainOverride),
      choices: [...fromMain, ...others]
    };
  }

  async function setChatProfile(chatId, profileId) {
    const chat = findChat(chatId);
    const id = profileId || null;
    if (id && !profiles.get(id)) throw new Error(`No profile with id ${id}.`);
    const runtime = caseRuntimeFor(chat);
    if (runtime) await runtime.setModelChoice(chat.caseId, { profile: id });
    else updateChat(chatId, { profileId: id });
    const after = snapshotModels({ chatId }).profileName;
    const where = runtime ? 'This case' : 'This chat';
    status(chatId, id ? `${where} now uses the profile ${after}.` : `${where} now uses the default profile (${after}).`);
    return findChat(chatId);
  }

  // Picking another usable model sets an override for main only (spec
  // §6.5); a running turn keeps what it launched with.
  async function setMainOverride(chatId, target) {
    const chat = findChat(chatId);
    const needs = needsFor(chat);
    const next = target ? normalizeTarget(target) : null;
    if (target && !next) throw new Error('Pick a model: a provider and a model id.');
    if (next) {
      const verdict = explainTarget(next.provider, next.model, { needs });
      if (!verdict.usable) throw new Error(`${targetLabel(next)} cannot be used: ${verdict.reasons.join(' ')}`);
      checkEffort(catalog, next, { role: 'main' });
    }
    const from = mainInUse(snapshotModels({ chatId }), needs).current;
    const runtime = caseRuntimeFor(chat);
    if (runtime) await runtime.setModelChoice(chat.caseId, { mainOverride: next });
    else updateChat(chatId, { mainOverride: next });
    const to = mainInUse(snapshotModels({ chatId }), needs).current;
    status(chatId, next ? `Main model switched from ${nameOf(from)} to ${nameOf(to)}` : `Main model reset to the profile's main (${nameOf(to)})`);
    return findChat(chatId);
  }

  // A profile in use is deleted (spec §15): its chats and cases move to the
  // default profile and each affected chat says so.
  async function removeProfile(id) {
    const victim = profiles.get(id);
    if (!victim) throw new Error(`No profile with id ${id}.`);
    const { defaultProfileId } = profiles.remove(id);
    const fallback = profiles.get(defaultProfileId)?.name || 'the default';
    const moved = { chats: [], cases: [] };
    for (const chat of getChats()) {
      if (chat.caseId || chat.profileId !== id) continue;
      updateChat(chat.id, { profileId: null });
      status(chat.id, `The profile ${victim.name} was deleted; this chat now uses the default profile (${fallback}).`);
      moved.chats.push(chat.id);
    }
    const runtime = getCaseRuntime();
    const cases = runtime && typeof runtime.listCases === 'function' ? runtime.listCases() : [];
    for (const meta of cases) {
      if (meta.profile !== id) continue;
      try {
        await runtime.setModelChoice(meta.id, { profile: null });
      } catch (err) {
        // A busy case keeps the stale id until its next write; the resolver
        // already falls back to the default for an unknown profile.
        log.warn(`Moving case ${meta.id} off the deleted profile failed: ${err.message}`);
        continue;
      }
      moved.cases.push(meta.id);
      for (const chat of getChats().filter((c) => c.caseId === meta.id)) {
        status(chat.id, `The profile ${victim.name} was deleted; this case now uses the default profile (${fallback}).`);
      }
    }
    return { removed: victim.id, defaultProfileId, moved };
  }

  function profilesView() {
    return {
      profiles: profiles.list().map((p) => profileView(p, { explain: explainTarget, catalog })),
      // Stored profiles that fail to parse: kept as stored, shown with the reason.
      broken: typeof profiles.broken === 'function' ? profiles.broken() : [],
      defaultProfileId: profiles.defaultId(),
      customRoles: profiles.customRoles()
    };
  }

  function saveProfile({ id = null, name, roles } = {}) {
    // The King Louie profile changes only by accepting a proposal (spec §7).
    if (id && profiles.get(id)?.kind === 'king-louie') {
      throw new ProfileError('KING_LOUIE_READ_ONLY', 'The King Louie profile changes only when you accept a proposal. Duplicate it to make your own.');
    }
    const saved = id ? profiles.update(id, { name, roles }) : profiles.create({ name, roles });
    return profileView(saved, { explain: explainTarget, catalog });
  }

  function duplicateProfile(id) {
    return profileView(profiles.duplicate(id), { explain: explainTarget, catalog });
  }

  function setDefaultProfile(id) {
    return profiles.setDefault(id);
  }

  // "Add model" (spec §11): usable models meeting the role's needs first,
  // then the catalog's text models that cannot be used, with the reasons.
  function pickerView({ needs = {} } = {}) {
    const usable = (availability && typeof availability.usable === 'function' ? availability.usable({ needs: { textOutput: true, ...needs } }) : [])
      .map((c) => ({ provider: c.provider, model: c.model, name: c.name || c.model, usable: true, reasons: [], priced: Boolean(c.priced), cost: c.cost ? { input: c.cost.input, output: c.cost.output } : null, context: c.context ?? null, local: Boolean(c.local) }));
    const seen = new Set(usable.map(targetKey));
    const unusable = [];
    for (const entry of catalog ? catalog.list() : []) {
      if (unusable.length >= PICKER_UNUSABLE_CAP) break;
      if (seen.has(`${entry.provider}:${entry.id}`) || !entry.output.includes('text')) continue;
      const verdict = explainTarget(entry.provider, entry.id, { needs });
      if (verdict.usable) continue;
      unusable.push({ provider: entry.provider, model: entry.id, name: entry.name || entry.id, usable: false, reasons: verdict.reasons || [], priced: Boolean(entry.cost), cost: entry.cost ? { input: entry.cost.input, output: entry.cost.output } : null, context: entry.limits?.context ?? null, local: Boolean(entry.local) });
    }
    return { usable, unusable };
  }

  // Custom roles (spec §6.2, §11 "Advanced: custom roles"). A role still
  // named by a case role — the case settings or any case's case.yaml — is
  // not removed; nor is one a profile still lists models for.
  function customRoleReferences(id) {
    const refs = [];
    const settings = getSettings() || {};
    for (const [caseRole, entry] of Object.entries(settings.cases?.roles || {})) {
      if (entry && entry.role === id) refs.push(`case role ${caseRole} in the case settings`);
    }
    let cases = [];
    try {
      const runtime = getCaseRuntime();
      cases = runtime && typeof runtime.listCases === 'function' ? runtime.listCases() : [];
    } catch (err) {
      log.warn(`Listing cases to check custom role ${id} failed: ${err.message}`);
    }
    for (const meta of cases) {
      for (const [caseRole, entry] of Object.entries(meta.roles || {})) {
        if (entry && entry.role === id) refs.push(`case role ${caseRole} in case "${meta.title || meta.id}"`);
      }
    }
    return refs;
  }

  function saveCustomRole(raw) {
    return profiles.saveCustomRole(raw);
  }

  function removeCustomRole(id) {
    return profiles.removeCustomRole(id, { references: customRoleReferences(id) });
  }

  // The King Louie profile (spec §7, §11).
  const kl = () => {
    if (!kingLouie) throw new Error('The King Louie profile is not available in this host.');
    return kingLouie;
  };

  function kingLouieView() {
    return kl().view();
  }

  function acceptProposal(proposalId) {
    return profileView(kl().accept(proposalId), { explain: explainTarget, catalog });
  }

  function dismissProposal(proposalId) {
    return kl().dismiss(proposalId);
  }

  function saveKingLouieSettings(patch = {}) {
    kl().saveSettings(patch);
    return kl().view();
  }

  function duplicateKingLouie({ name, proposalId } = {}) {
    return profileView(kl().duplicateAsProfile({ name, proposalId }), { explain: explainTarget, catalog });
  }

  return {
    chatView,
    setChatProfile,
    setMainOverride,
    removeProfile,
    profilesView,
    saveProfile,
    duplicateProfile,
    setDefaultProfile,
    pickerView,
    kingLouieView,
    acceptProposal,
    dismissProposal,
    saveKingLouieSettings,
    duplicateKingLouie,
    saveCustomRole,
    removeCustomRole
  };
}

module.exports = { createModelChoices };

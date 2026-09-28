// tests/helpers/profile-settings.js
// Settings with one model profile, made the default (spec 2026-09-27 §6.1):
// how a test says "these are the models" now that tiers are gone.

function profileSettings(settings = {}, roles = {}, { id = 'p-test', name = 'Test profile' } = {}) {
  const profile = { id, name, kind: 'user', roles: { main: [], worker: [], utility: [], ...roles } };
  return { ...settings, models: { ...(settings.models || {}), profiles: [profile], defaultProfileId: id } };
}

// The same target in all three core roles.
function everyRole(target) {
  const t = { effort: null, ...target };
  return { main: [{ ...t }], worker: [{ ...t }], utility: [{ ...t }] };
}

// The three core roles with the model names case tests tell apart: the
// judge loop runs on main, draft on worker, orient and classify on utility.
function caseRoles(provider = 'openai') {
  const t = (model) => ({ provider, model, effort: null });
  return { main: [t('judge-model')], worker: [t('draft-model')], utility: [t('orient-model')] };
}

function withCaseProfile(settings = {}, provider = 'openai') {
  return profileSettings(settings, caseRoles(provider));
}

module.exports = { profileSettings, everyRole, caseRoles, withCaseProfile };

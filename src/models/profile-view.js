// src/models/profile-view.js
// A profile as the Models tab shows it (spec 2026-09-27 §11): every entry
// with its catalog name, price, context and efforts, and whether it can be
// used now — unusable entries stay in the list, greyed, with the reasons.
const { ROLE_NEEDS } = require('./roles');

function entryView(target, role, { explain, catalog = null }) {
  const needs = ROLE_NEEDS[role] || {};
  const verdict = explain(target.provider, target.model, { needs }) || {};
  const entry = catalog ? catalog.get(target.provider, target.model) : null;
  return {
    provider: target.provider,
    model: target.model,
    effort: target.effort || null,
    name: entry?.name || target.model,
    usable: Boolean(verdict.usable),
    reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
    notes: Array.isArray(verdict.notes) ? verdict.notes : [],
    priced: Boolean(entry?.cost),
    cost: entry?.cost ? { input: entry.cost.input, output: entry.cost.output } : null,
    context: entry?.limits?.context ?? null,
    efforts: Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [],
    toolCall: entry ? entry.toolCall === true : null,
    imageInput: entry ? entry.input.includes('image') : null
  };
}

function profileView(profile, { explain, catalog = null } = {}) {
  const roles = {};
  for (const [role, list] of Object.entries(profile.roles || {})) {
    roles[role] = list.map((t) => entryView(t, role, { explain, catalog }));
  }
  return { id: profile.id, name: profile.name, kind: profile.kind, roles, migration: profile.migration || null };
}

module.exports = { profileView, entryView };

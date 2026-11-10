// Model chips and role status for the Models page (settings redesign, Task 7). A plain
// script of the renderer's, and a module for its test: the renderer has no require.
// Names are prefixed to stay clear of renderer.js globals. Every string returned from
// here that came from a node or a model goes on the page by textContent.
function providerDisplayName(provider, providerLabels, localServerNames, model) {
  if (provider === 'local') {
    const id = String(model || '').split('/')[0];
    return (localServerNames && localServerNames[id]) || id;
  }
  return (providerLabels && providerLabels[provider] && providerLabels[provider].label) || provider;
}

function isFree(entry) {
  return Boolean(entry) && entry.priced === true && Boolean(entry.cost) &&
    entry.cost.input === 0 && entry.cost.output === 0;
}

function modelChip(entry, providerLabels, localServerNames) {
  return {
    name: entry.name || entry.model,
    provider: providerDisplayName(entry.provider, providerLabels, localServerNames, entry.model),
    free: isFree(entry),
    usable: entry.usable !== false
  };
}

// Follows src/models/resolver.js candidatesUnder. A role's entries look like
// { provider, model, usable?, imageInput? } (usable !== false counts as usable;
// imageInput is true or 'yes').
function roleStatus(roles, role) {
  const own = (r) => (roles && Array.isArray(roles[r]) ? roles[r] : []);
  const usable = (list) => list.filter((e) => e && e.usable !== false);
  const sees = (e) => e.imageInput === true || e.imageInput === 'yes';
  const labels = { main: 'Main', worker: 'Worker', utility: 'Utility' };
  const mine = own(role);
  if (mine.length) {
    return usable(mine).length
      ? { state: 'ok', message: '' }
      : { state: 'warn', message: 'None of these can be used right now. Fix their keys under Providers & keys.' };
  }
  if (role === 'main') return { state: 'warn', message: 'Nothing can answer you until Main has a model.' };
  if (role === 'worker' || role === 'utility') {
    const chain = role === 'utility' ? ['worker', 'main'] : ['main'];
    // The resolver borrows from the first role with any entries, usable or not.
    const from = chain.find((r) => own(r).length);
    if (from && usable(own(from)).length) return { state: 'borrows', from, message: `Uses ${labels[from]}'s models.` };
    return {
      state: 'warn',
      message: role === 'worker' ? "Agents and tasks can't run." : "Chat titles and case wake-ups can't run."
    };
  }
  if (role === 'vision') {
    const from = ['utility', 'worker', 'main'].find((r) => usable(own(r)).some(sees));
    if (from) return { state: 'borrows', from, message: 'Uses an image-capable model from your other roles.' };
    return { state: 'off', message: 'Nothing in this profile can read images.' };
  }
  if (role === 'imageGeneration') {
    return { state: 'off', message: 'Uses the image provider set under Providers & keys.' };
  }
  return { state: 'borrows', message: 'Uses its fallback role.' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { providerDisplayName, isFree, modelChip, roleStatus };
}

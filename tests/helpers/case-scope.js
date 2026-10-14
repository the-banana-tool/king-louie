// tests/helpers/case-scope.js
// Cases stage 8: a fixture's criteria are the model's, so they are proposed
// and gating waits for the owner. `confirmAll` is the owner pressing
// "Confirm all": it writes the scope record and confirms every proposed
// criterion and the objective, as an owner action. Synchronous, for fixtures
// that build a case outside a turn.
function confirmAll(runtime, id, { by = 'owner-action', channel = 'in-app' } = {}) {
  const store = runtime.scope(id);
  const data = runtime.brief(id).read().data;
  const view = store.reconcile(data);
  const targets = view.criteria.filter((r) => r.state !== 'confirmed').map((r) => r.id);
  const hashes = Object.fromEntries(view.criteria.map((r) => [r.id, r.hash]));
  if (view.objective && view.objective.state !== 'confirmed') {
    targets.push('objective');
    hashes.objective = view.objective.hash;
  }
  if (targets.length) store.confirm(targets, { hashes, by, channel });
  return store.view(data);
}

module.exports = { confirmAll };

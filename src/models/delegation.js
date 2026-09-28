// src/models/delegation.js
// Whether a turn's worker is cheaper than its main (final review I1): main's
// delegation guidance promises the explorer "runs on a cheaper model", so a
// turn carries it only when that holds. The answer depends only on the frozen
// TurnModels and the catalog, never on provider availability, so it stays the
// same for every turn of a profile and the cached prompt prefix keeps.
const { KING_LOUIE_DEFAULTS } = require('./suggester');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The suggester's blended rate (src/models/suggester.js blendedRate: three
// parts input to one part output, USD per million tokens), taken through
// Catalog#price so a local Ollama model and a dated model id price exactly as
// a call would. Priced on a few thousand tokens, below every long-context
// tier. null when the catalog does not price the model.
function blendedRateOf(catalog, target) {
  if (!catalog || typeof catalog.price !== 'function' || !target) return null;
  const { input: inPart, output: outPart } = KING_LOUIE_DEFAULTS.blend;
  const unit = 1000;
  const priced = catalog.price(target.provider, target.model, { input: inPart * unit, output: outPart * unit });
  if (!priced || !isNum(priced.usd)) return null;
  return (priced.usd * 1e6) / ((inPart + outPart) * unit);
}

// True only when worker has models of its own (it does not borrow from
// main) and the first of them has a blended rate strictly below the first
// of main's (the main override when the chat has one). An unpriced model on
// either side means the saving cannot be shown, so the answer is false.
function workerIsCheaper(turnModels, catalog) {
  if (!turnModels || typeof turnModels.configuredFor !== 'function') return false;
  const worker = turnModels.configuredFor('worker');
  if (!worker.length) return false;
  const main = turnModels.candidatesFor('main');
  if (!main.length) return false;
  const workerRate = blendedRateOf(catalog, worker[0]);
  const mainRate = blendedRateOf(catalog, main[0]);
  if (!isNum(workerRate) || !isNum(mainRate)) return false;
  return workerRate < mainRate;
}

module.exports = { blendedRateOf, workerIsCheaper };

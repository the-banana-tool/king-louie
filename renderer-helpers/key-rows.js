// Providers & keys rows (settings redesign Task 10, spec §5.5, §8.5). A plain
// script of the renderer's, and a module for its test: the renderer has no require.
// Every reason returned here may hold a provider's own error text, so it goes on the
// page by textContent.

// A failure that never reached the provider (refused, timed out, no such host).
// A placeholder hint would mislead there: the key was never looked at.
const KEY_ROW_NETWORK_ERROR = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|fetch failed|timed out|timeout|aborted|socket hang up|network|unreachable/i;

function isNetworkFailure(status) {
  if (!status || status.ok) return false;
  if (Number.isFinite(status.httpStatus)) return false;
  return KEY_ROW_NETWORK_ERROR.test(String(status.error || status.message || ''));
}

// `tested` is a search or image key's result from this page visit; it is read like
// a status, and wins over one.
function keyRowState({ hasKey, status = null, tested = null } = {}) {
  if (!hasKey) return { state: 'no-key', reason: '', action: 'Add' };
  const s = tested || status;
  if (s && s.ok) {
    const when = s.checkedAt ? ` · tested ${new Date(s.checkedAt).toLocaleString()}` : '';
    return { state: 'working', reason: `${s.message || ''}${when}`, action: 'Edit' };
  }
  if (s) {
    const said = s.message || s.error || '';
    const reason = s.hint && !isNetworkFailure(s) ? `Looks like a placeholder: ${s.hint}` : said;
    return { state: 'failing', reason, action: 'Edit' };
  }
  return { state: 'not-tested', reason: 'Not tested yet', action: 'Edit' };
}

// Ollama needs no key: it counts as set up once it has an address test on record.
function providerHasKey(providerKey, provider) {
  if (!provider) return false;
  if (provider.hasToken) return true;
  return providerKey === 'ollama' && Boolean(provider.status);
}

// Model providers only (spec §8.5): only their models are skipped.
function failingCount(providers) {
  if (!providers || typeof providers !== 'object') return 0;
  return Object.entries(providers).filter(([key, p]) => (
    keyRowState({ hasKey: providerHasKey(key, p), status: p && p.status }).state === 'failing'
  )).length;
}

function failingBannerText(n) {
  return n === 1
    ? '1 key is failing. Models from that provider are skipped until you fix or remove the key.'
    : `${n} keys are failing. Models from those providers are skipped until you fix or remove the key.`;
}

const KEY_ROW_PILL = Object.freeze({
  working: { cls: 'is-working', text: 'Working' },
  failing: { cls: 'is-failing', text: 'Failing' },
  'no-key': { cls: 'is-none', text: 'No key' },
  'not-tested': { cls: 'is-untested', text: 'Not tested' }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { keyRowState, isNetworkFailure, providerHasKey, failingCount, failingBannerText, KEY_ROW_PILL };
}

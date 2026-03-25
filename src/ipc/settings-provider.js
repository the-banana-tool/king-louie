function applyActiveProviderUpdate({
  provider,
  providerLabels,
  getSettings,
  setSettings,
  resetRuntimeEnvironmentCache
}) {
  if (!providerLabels?.[provider]) {
    return { ok: false, error: 'Unknown provider.' };
  }

  const settings = getSettings();
  const updated = {
    ...settings,
    activeProvider: provider
  };

  setSettings(updated);

  if (typeof resetRuntimeEnvironmentCache === 'function') {
    resetRuntimeEnvironmentCache();
  }

  return { ok: true, activeProvider: provider };
}

module.exports = {
  applyActiveProviderUpdate
};
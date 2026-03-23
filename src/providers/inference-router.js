class InferenceRouter {
  constructor(options = {}) {
    this.getSettings = options.getSettings;
    this.getProviderModel = options.getProviderModel;
    this.getProviderToken = options.getProviderToken;
    this.createProvider = options.createProvider;
  }

  resolve(request = {}) {
    if (typeof this.getSettings !== 'function') {
      throw new Error('InferenceRouter requires getSettings()');
    }

    const settings = this.getSettings() || {};
    const inference = settings.inference || {};
    const tierMap = inference.tierMap || {};
    const timeoutsMs = inference.timeoutsMs || {};

    const requestedTier = String(request.tier || inference.activeTier || 'standard').toLowerCase();
    const tier = ['fast', 'standard', 'smart'].includes(requestedTier) ? requestedTier : 'standard';

    const tierConfig = tierMap[tier] || {};
    const providerType = String(
      request.provider || tierConfig.provider || settings.activeProvider || 'openai'
    ).toLowerCase();
    const model =
      request.model ||
      tierConfig.model ||
      (typeof this.getProviderModel === 'function' ? this.getProviderModel(providerType) : '');

    const configuredTimeout = request.timeoutMs ?? timeoutsMs[tier];
    const timeoutMs = Number(configuredTimeout);
    const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;

    if (typeof this.getProviderToken !== 'function') {
      throw new Error('InferenceRouter requires getProviderToken()');
    }

    if (typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires createProvider()');
    }

    const token = this.getProviderToken(providerType);
    const provider = this.createProvider(providerType, token);

    return {
      tier,
      providerType,
      model,
      timeoutMs: normalizedTimeoutMs,
      provider
    };
  }
}

module.exports = InferenceRouter;
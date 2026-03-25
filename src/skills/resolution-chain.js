const VALID_RESOLVERS = ['code', 'cli', 'prompt', 'skill'];

class ResolutionChain {
  normalizeResolvers(resolvers = []) {
    const source = Array.isArray(resolvers) ? resolvers : [];
    const normalized = source
      .map((resolver) => String(resolver || '').trim().toLowerCase())
      .filter((resolver) => VALID_RESOLVERS.includes(resolver));

    return normalized.length ? normalized : ['skill'];
  }

  async execute({ skill, command, args = [], context = {}, resolvers = [] }) {
    const chain = this.normalizeResolvers(resolvers);
    let lastFailure = null;

    for (const resolver of chain) {
      const result = await this.runResolver(resolver, { skill, command, args, context });
      if (!result) {
        continue;
      }

      const decorated = this.decorateResult(result, resolver, chain);
      if (decorated.ok) {
        return decorated;
      }

      lastFailure = decorated;
    }

    return (
      lastFailure || {
        ok: false,
        error: `No resolver could handle /${command}`,
        resolution: {
          method: null,
          attempted: chain
        }
      }
    );
  }

  async runResolver(resolver, payload) {
    const { skill } = payload;

    if (resolver === 'code' && typeof skill.resolveCode === 'function') {
      return skill.resolveCode(payload);
    }

    if (resolver === 'cli' && typeof skill.resolveCli === 'function') {
      return skill.resolveCli(payload);
    }

    if (resolver === 'prompt' && typeof skill.resolvePrompt === 'function') {
      return skill.resolvePrompt(payload);
    }

    if (resolver === 'skill' && typeof skill.handleCommand === 'function') {
      const { command, args, context } = payload;
      return skill.handleCommand(command, args, context);
    }

    return null;
  }

  decorateResult(result, method, attempted = []) {
    const current = result && typeof result === 'object' ? result : { ok: Boolean(result) };

    return {
      ...current,
      resolution: {
        method,
        attempted
      }
    };
  }
}

module.exports = ResolutionChain;
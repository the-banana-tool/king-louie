function tokenize(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function unique(values = []) {
  return Array.from(new Set(values));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function daysSince(timestamp) {
  const value = Date.parse(timestamp || '') || Date.now();
  return Math.max(0, (Date.now() - value) / (1000 * 60 * 60 * 24));
}

class MemoryRetrieval {
  scoreEntry(entry, queryTokens = []) {
    const contentTokens = unique(tokenize(entry?.content || ''));
    const overlapCount = queryTokens.reduce(
      (count, token) => count + (contentTokens.includes(token) ? 1 : 0),
      0
    );

    const keywordScore = queryTokens.length > 0
      ? overlapCount / queryTokens.length
      : 0;

    const ageDays = daysSince(entry?.lastAccessed || entry?.created);
    const recencyScore = clamp(1 - (ageDays / 90), 0, 1);

    let tierBoost = 0;
    if (entry?.tier === 'hot') tierBoost = 0.2;
    if (entry?.tier === 'warm') tierBoost = 0.1;

    const finalScore = (keywordScore * 0.65) + (recencyScore * 0.35) + tierBoost;

    return {
      keywordScore,
      recencyScore,
      tierBoost,
      finalScore
    };
  }

  findRelevant(entries = [], query = '', options = {}) {
    const queryTokens = unique(tokenize(query));
    const includeScores = options.includeScores === true;
    const limit = Number(options.limit || 8);

    const scored = (entries || [])
      .map((entry) => ({
        entry,
        score: this.scoreEntry(entry, queryTokens)
      }))
      .filter(({ score }) => {
        if (!queryTokens.length) {
          return true;
        }
        return score.keywordScore > 0;
      })
      .sort((a, b) => b.score.finalScore - a.score.finalScore)
      .slice(0, Math.max(1, limit));

    if (includeScores) {
      return scored.map(({ entry, score }) => ({
        ...entry,
        score
      }));
    }

    return scored.map(({ entry }) => entry);
  }
}

module.exports = MemoryRetrieval;
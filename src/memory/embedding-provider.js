class EmbeddingProvider {
  async embed(texts) { throw new Error('Not implemented'); }
  getDimensions() { throw new Error('Not implemented'); }
}

class OpenAIEmbeddingProvider extends EmbeddingProvider {
  constructor(config) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model || 'text-embedding-3-small';
  }

  getDimensions() { return 1536; }

  async embed(texts) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: texts, model: this.model })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error: ${res.status} ${res.statusText} ${err}`);
    }

    const data = await res.json();
    return data.data.map(d => d.embedding);
  }
}

module.exports = {
  EmbeddingProvider,
  OpenAIEmbeddingProvider
};

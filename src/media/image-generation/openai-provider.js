const { createLogger } = require('../../logging');

const log = createLogger('image-gen/openai');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-1';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_TIMEOUT_MS = 180_000;
const SUPPORTED_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
const SUPPORTED_QUALITIES = ['low', 'medium', 'high', 'auto'];
const MAX_IMAGES = 4;

class OpenAIImageProvider {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('OpenAI API key is required for image generation');
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  getName() { return 'openai'; }
  getDefaultModel() { return DEFAULT_MODEL; }
  getSupportedSizes() { return [...SUPPORTED_SIZES]; }
  getSupportedQualities() { return [...SUPPORTED_QUALITIES]; }
  getMaxImages() { return MAX_IMAGES; }

  async generate({ prompt, model, size, quality, count = 1, outputFormat } = {}) {
    const resolvedModel = model || DEFAULT_MODEL;
    const resolvedSize = SUPPORTED_SIZES.includes(size) ? size : DEFAULT_SIZE;
    const resolvedCount = Math.max(1, Math.min(MAX_IMAGES, Math.trunc(count)));

    const body = {
      model: resolvedModel,
      prompt,
      n: resolvedCount,
      size: resolvedSize,
      response_format: 'b64_json'
    };
    if (quality && SUPPORTED_QUALITIES.includes(quality)) {
      body.quality = quality;
    }
    if (outputFormat && ['png', 'jpeg', 'webp'].includes(outputFormat)) {
      body.output_format = outputFormat;
    }

    log.info(`generating ${resolvedCount} image(s) with ${resolvedModel} at ${resolvedSize}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`OpenAI image generation failed (${response.status}): ${errorBody}`);
      }

      const data = await response.json();
      if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        throw new Error('OpenAI image generation response missing image data');
      }

      return data.data.map((item, index) => ({
        base64: item.b64_json,
        mimeType: outputFormat === 'jpeg' ? 'image/jpeg' : outputFormat === 'webp' ? 'image/webp' : 'image/png',
        fileName: `image-${index + 1}.${outputFormat || 'png'}`,
        revisedPrompt: item.revised_prompt || undefined
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = OpenAIImageProvider;

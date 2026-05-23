const { createLogger } = require('../../logging');

const log = createLogger('image-gen/fal');

const DEFAULT_BASE_URL = 'https://fal.run';
const DEFAULT_MODEL = 'fal-ai/flux/dev';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_TIMEOUT_MS = 120_000;
const SUPPORTED_SIZES = ['1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024'];
const MAX_IMAGES = 4;

class FalImageProvider {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('Fal API key is required for image generation');
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  getName() { return 'fal'; }
  getDefaultModel() { return DEFAULT_MODEL; }
  getSupportedSizes() { return [...SUPPORTED_SIZES]; }
  getMaxImages() { return MAX_IMAGES; }

  async generate({ prompt, model, size, count = 1, outputFormat } = {}) {
    const resolvedModel = model || DEFAULT_MODEL;
    const resolvedCount = Math.max(1, Math.min(MAX_IMAGES, Math.trunc(count)));
    const resolvedFormat = outputFormat || 'png';

    const body = {
      prompt,
      num_images: resolvedCount,
      output_format: resolvedFormat
    };

    if (size && SUPPORTED_SIZES.includes(size)) {
      body.image_size = size;
    } else if (size) {
      const match = /^(\d{2,5})x(\d{2,5})$/i.exec(size);
      if (match) {
        body.image_size = { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
      } else {
        body.image_size = DEFAULT_SIZE;
      }
    }

    log.info(`generating ${resolvedCount} image(s) with ${resolvedModel}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/${resolvedModel}`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Fal image generation failed (${response.status}): ${errorBody}`);
      }

      const data = await response.json();
      if (!data.images || !Array.isArray(data.images) || data.images.length === 0) {
        throw new Error('Fal image generation response missing image data');
      }

      const results = [];
      for (let i = 0; i < data.images.length; i++) {
        const entry = data.images[i];
        const url = entry.url;
        if (!url) throw new Error('Fal image response missing image URL');

        const imgResponse = await fetch(url);
        if (!imgResponse.ok) {
          throw new Error(`Failed to download Fal image (${imgResponse.status})`);
        }

        const contentType = (imgResponse.headers.get('content-type') || '').split(';')[0].trim();
        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        const mimeType = contentType || (resolvedFormat === 'jpeg' ? 'image/jpeg' : 'image/png');
        const ext = mimeType === 'image/jpeg' ? 'jpeg' : 'png';

        results.push({
          base64: buffer.toString('base64'),
          mimeType,
          fileName: `image-${i + 1}.${ext}`
        });
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = FalImageProvider;

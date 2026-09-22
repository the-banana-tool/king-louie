const { Tool } = require('../tool-schema');
const { createLogger } = require('../../logging');
const fs = require('fs');
const path = require('path');
const os = require('os');

const log = createLogger('image-generate');

const OUTPUT_DIR = path.join(os.tmpdir(), 'king-louie-generated-images');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function decryptKey(encrypted, context) {
  if (!encrypted) return null;
  if (typeof context?.decryptToken === 'function') {
    try {
      return context.decryptToken(encrypted);
    } catch (e) {
      return encrypted; // Fallback
    }
  }
  return encrypted; // In tests where decryptToken isn't available, or keys are stored plain
}

async function resolveProvider(settings, providerOverride, context) {
  const imgSettings = settings?.imageGeneration || {};
  const chosen = providerOverride || imgSettings.defaultProvider || 'openai';

  if (chosen === 'fal') {
    const apiKey = decryptKey(imgSettings.fal?.apiKey, context);
    if (!apiKey) throw new Error('Fal API key not configured. Add it in Settings > Providers.');
    const FalImageProvider = require('../../media/image-generation/fal-provider');
    return new FalImageProvider(apiKey);
  }

  // Default: OpenAI — reuse the main OpenAI provider token (already decrypted).
  let apiKey;
  try {
    apiKey = context?.getProviderToken?.('openai');
  } catch (_) { /* no token saved / not available */ }

  if (!apiKey) {
    apiKey = decryptKey(imgSettings.openai?.apiKey, context);
  }
  if (!apiKey) throw new Error('OpenAI API key not configured. Add it in Settings > Providers.');

  const OpenAIImageProvider = require('../../media/image-generation/openai-provider');
  return new OpenAIImageProvider(apiKey);
}

const ImageGenerateTool = new Tool({
  name: 'ImageGenerate',
  description: 'Generate images from text prompts using DALL-E (OpenAI) or Fal (Flux). Returns file paths to the generated images. Use this when the user asks you to create, generate, draw, or design an image, diagram, illustration, or visual asset.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed text description of the image to generate.'
      },
      provider: {
        type: 'string',
        enum: ['openai', 'fal'],
        description: 'Which image generation provider to use. Defaults to the configured default (usually openai).'
      },
      model: {
        type: 'string',
        description: 'Model to use. OpenAI: gpt-image-1 (default). Fal: fal-ai/flux/dev (default).'
      },
      size: {
        type: 'string',
        description: 'Image dimensions, e.g. "1024x1024", "1536x1024", "1024x1536".'
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'auto'],
        description: 'Image quality (OpenAI only). Defaults to auto.'
      },
      count: {
        type: 'number',
        minimum: 1,
        maximum: 4,
        description: 'Number of images to generate (1-4). Defaults to 1.'
      }
    },
    required: ['prompt']
  },
  requiresApproval: true,
  concurrencySafe: false,

  async execute(params, context) {
    const { prompt, provider: providerOverride, model, size, quality, count } = params;

    const settings = typeof context?.getSettings === 'function' ? (context.getSettings() || {}) : {};

    let imageProvider;
    try {
      imageProvider = await resolveProvider(settings, providerOverride, context);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    try {
      const results = await imageProvider.generate({ prompt, model, size, quality, count });
      ensureOutputDir();

      const savedFiles = [];
      for (const img of results) {
        const filePath = path.join(OUTPUT_DIR, `${Date.now()}-${img.fileName}`);
        fs.writeFileSync(filePath, Buffer.from(img.base64, 'base64'));
        savedFiles.push({
          path: filePath,
          mimeType: img.mimeType,
          fileName: img.fileName,
          revisedPrompt: img.revisedPrompt
        });
      }

      const providerName = imageProvider.getName();
      const modelName = model || imageProvider.getDefaultModel();

      log.info(`generated ${savedFiles.length} image(s) with ${providerName}/${modelName}`);

      return {
        ok: true,
        provider: providerName,
        model: modelName,
        count: savedFiles.length,
        images: savedFiles,
        message: `Generated ${savedFiles.length} image(s) with ${providerName}/${modelName}.`
      };
    } catch (err) {
      log.error(`image generation failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
});

module.exports = ImageGenerateTool;

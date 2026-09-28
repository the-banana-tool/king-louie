const { Tool } = require('../tool-schema');
const { createLogger } = require('../../logging');
const { decryptSettingKey } = require('../utils');
const fs = require('fs');
const path = require('path');
const os = require('os');

const log = createLogger('image-generate');

const OUTPUT_DIR = path.join(os.tmpdir(), 'king-louie-generated-images');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Throws rather than falling back to the ciphertext; resolveProvider's caller
// turns that into an { ok: false, error } the user can act on.
async function resolveProvider(settings, providerOverride, context) {
  const imgSettings = settings?.imageGeneration || {};
  const chosen = providerOverride || imgSettings.defaultProvider || 'openai';

  if (chosen === 'fal') {
    const apiKey = decryptSettingKey(imgSettings.fal?.apiKey, context, 'Fal');
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
    apiKey = decryptSettingKey(imgSettings.openai?.apiKey, context, 'OpenAI');
  }
  if (!apiKey) throw new Error('OpenAI API key not configured. Add it in Settings > Providers.');

  const OpenAIImageProvider = require('../../media/image-generation/openai-provider');
  return new OpenAIImageProvider(apiKey);
}

// Image clients King Louie can generate through for a profile target
// (models spec 2026-09-27 §8). context.createImageClient overrides (tests).
const IMAGE_CLIENTS = Object.freeze({
  openai: (apiKey) => {
    const OpenAIImageProvider = require('../../media/image-generation/openai-provider');
    return new OpenAIImageProvider(apiKey);
  }
});

const targetName = (t) => `${t.provider}/${t.model}`;

// The profile's imageGeneration role (spec §8): when it lists models, the
// tool may use only those; empty, today's image settings apply. Returns
// { useSettings: true }, { target } or { error }.
async function roleTarget(params, context) {
  const models = context.turnModels
    || (typeof context.snapshotModels === 'function' ? context.snapshotModels({}) : null);
  if (!models) return { useSettings: true };
  if (typeof context.ensureTargetsTested === 'function') {
    try {
      await context.ensureTargetsTested(models.candidatesFor('imageGeneration'));
    } catch (err) {
      log.warn(`Testing the image generation providers failed: ${err.message}`);
    }
  }
  const resolved = models.resolve('imageGeneration');
  if (resolved.useSettings) return { useSettings: true };
  const listed = [...resolved.targets, ...resolved.skipped.map((s) => s.target)].map(targetName).join(', ');
  const skipped = [...resolved.skipped];
  const usable = [];
  for (const t of resolved.targets) {
    if (IMAGE_CLIENTS[t.provider]) usable.push(t);
    else skipped.push({ target: t, reasons: [`King Louie cannot generate images through ${t.provider} yet.`] });
  }
  const wantProvider = params.provider ? String(params.provider).trim().toLowerCase() : null;
  const wantModel = params.model ? String(params.model).trim() : null;
  if (wantProvider || wantModel) {
    const match = usable.find((t) => (!wantProvider || t.provider === wantProvider) && (!wantModel || t.model === wantModel));
    if (match) return { target: match };
    const asked = [wantProvider, wantModel].filter(Boolean).join('/');
    return { error: `${asked} is not a usable model in this profile's image generation role (${listed}). Use one of those, or leave provider and model out.` };
  }
  if (!usable.length) {
    const why = skipped.map((s) => `${targetName(s.target)} (${s.reasons.join(' ')})`).join('; ');
    return { error: `No usable image generation model in the profile "${models.profileName}": ${why}. Fix them in Settings → Models.` };
  }
  return { target: usable[0] };
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
        description: 'Model to use. When the profile\'s image generation role lists models, only those may be used; leave it out to use the first. Otherwise OpenAI: gpt-image-1 (default), Fal: fal-ai/flux/dev (default).'
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
    let modelToUse = model;
    try {
      const chosen = await roleTarget(params, context || {});
      if (chosen.error) return { ok: false, error: chosen.error };
      if (chosen.target) {
        let apiKey = null;
        try {
          apiKey = context?.getProviderToken?.(chosen.target.provider) || null;
        } catch (_) {
          apiKey = null;
        }
        if (!apiKey) return { ok: false, error: `No ${chosen.target.provider} key is saved. Add it under API keys.` };
        const create = typeof context?.createImageClient === 'function'
          ? context.createImageClient
          : (p, key) => IMAGE_CLIENTS[p](key);
        imageProvider = create(chosen.target.provider, apiKey);
        modelToUse = chosen.target.model;
      } else {
        imageProvider = await resolveProvider(settings, providerOverride, context);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }

    try {
      const results = await imageProvider.generate({ prompt, model: modelToUse, size, quality, count });
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
      const modelName = modelToUse || imageProvider.getDefaultModel();

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

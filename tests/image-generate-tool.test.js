// tests/image-generate-tool.test.js
// The image tool uses only models in the profile's imageGeneration role
// (models spec 2026-09-27 §8); with the role empty, the image settings apply.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const ImageGenerateTool = require('../src/tools/builtin/image-generate-tool');
const { createTurnModels } = require('../src/models/resolver');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model) => ({ provider, model, effort: null });
const usable = () => ({ usable: true, reasons: [], notes: [] });
const models = (imageGeneration, explain = usable) => createTurnModels({
  profile: { id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...(imageGeneration ? { imageGeneration } : {}) } },
  explain
});

function toolContext(turnModels, extra = {}) {
  const generated = [];
  return {
    generated,
    ctx: {
      turnModels,
      getSettings: () => ({}),
      getProviderToken: (p) => `${p}-key-123456`,
      createImageClient: (provider, apiKey) => ({
        getName: () => provider,
        getDefaultModel: () => 'default-image',
        generate: async (req) => {
          generated.push({ provider, apiKey, model: req.model });
          return [{ base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', fileName: 'a.png' }];
        }
      }),
      ...extra
    }
  };
}

describe('ImageGenerate on the imageGeneration role', () => {
  it('uses the role\'s first usable model', async () => {
    const { ctx, generated } = toolContext(models([t('openai', 'gpt-image-1')]));
    const out = await ImageGenerateTool.execute({ prompt: 'a lighthouse' }, ctx);
    assert.strictEqual(out.ok, true, out.error);
    assert.deepStrictEqual(generated, [{ provider: 'openai', apiKey: 'openai-key-123456', model: 'gpt-image-1' }]);
    assert.strictEqual(out.model, 'gpt-image-1');
  });

  it('refuses a model or provider outside the role', async () => {
    const { ctx, generated } = toolContext(models([t('openai', 'gpt-image-1')]));
    const other = await ImageGenerateTool.execute({ prompt: 'x', model: 'dall-e-3' }, ctx);
    const fal = await ImageGenerateTool.execute({ prompt: 'x', provider: 'fal' }, ctx);
    assert.match(other.error, /dall-e-3 is not a usable model in this profile's image generation role \(openai\/gpt-image-1\)/);
    assert.match(fal.error, /fal is not a usable model/);
    assert.deepStrictEqual(generated, []);
  });

  it('names why no model in the role can be used', async () => {
    const explain = () => ({ usable: false, reasons: ['No token saved for OpenAI.'], notes: [] });
    const { ctx } = toolContext(models([t('openai', 'gpt-image-1')], explain));
    const out = await ImageGenerateTool.execute({ prompt: 'x' }, ctx);
    assert.match(out.error, /No usable image generation model in the profile "Work": openai\/gpt-image-1 \(No token saved for OpenAI\.\)/);
  });

  it('skips a provider it cannot generate through, with the reason', async () => {
    const { ctx } = toolContext(models([t('google', 'imagen-4')]));
    const out = await ImageGenerateTool.execute({ prompt: 'x' }, ctx);
    assert.match(out.error, /google\/imagen-4 \(King Louie cannot generate images through google yet\.\)/);
  });

  it('keeps today\'s image settings when the role is empty', async () => {
    const { ctx } = toolContext(models(null), { getProviderToken: () => null });
    const out = await ImageGenerateTool.execute({ prompt: 'x' }, ctx);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /OpenAI API key not configured/);
  });
});

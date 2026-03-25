const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';

const PRIVATE_HOSTNAME_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;

function assertPublicUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (PRIVATE_HOSTNAME_PATTERN.test(parsed.hostname)) {
      throw new Error(`baseUrl must not point to a private network: ${parsed.hostname}`);
    }
  } catch (error) {
    if (error.message.includes('private network')) throw error;
    throw new Error(`Invalid baseUrl: ${urlString}`);
  }
}

class ElevenLabsEngine {
  constructor(options = {}) {
    this.getApiKey =
      typeof options.getApiKey === 'function'
        ? options.getApiKey
        : () => String(options.apiKey || '');
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (options.baseUrl) {
      assertPublicUrl(this.baseUrl);
    }
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  }

  resolveApiKey() {
    const key = String(this.getApiKey() || '').trim();
    if (!key) {
      throw new Error('ElevenLabs API key is not configured.');
    }

    return key;
  }

  buildVoiceSettings(options = {}) {
    const settings = {};

    if (typeof options.stability === 'number' && Number.isFinite(options.stability)) {
      settings.stability = Math.max(0, Math.min(1, options.stability));
    }

    if (typeof options.style === 'number' && Number.isFinite(options.style)) {
      settings.style = Math.max(0, Math.min(1, options.style));
    }

    if (typeof options.speed === 'number' && Number.isFinite(options.speed)) {
      settings.speed = Math.max(0.7, Math.min(1.2, options.speed));
    }

    settings.use_speaker_boost = true;
    return settings;
  }

  async synthesize(text, options = {}) {
    const apiKey = this.resolveApiKey();
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
      throw new Error('Text is required for ElevenLabs TTS.');
    }

    const voiceId = String(options.voiceId || options.voice || '').trim();
    if (!voiceId) {
      throw new Error('ElevenLabs voiceId is required.');
    }

    const modelId = String(options.modelId || 'eleven_multilingual_v2').trim();

    const response = await this.fetchImpl(
      `${this.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg'
        },
        body: JSON.stringify({
          text: normalizedText,
          model_id: modelId,
          voice_settings: this.buildVoiceSettings(options)
        })
      }
    );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${details || response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      ok: true,
      engine: 'elevenlabs',
      mimeType: 'audio/mpeg',
      extension: 'mp3',
      buffer: Buffer.from(arrayBuffer)
    };
  }

  async speak(text, options = {}) {
    // In desktop context we synthesize and return audio bytes; caller decides playback/transport.
    return this.synthesize(text, options);
  }

  async testConnection() {
    const apiKey = this.resolveApiKey();
    const response = await this.fetchImpl(`${this.baseUrl}/voices`, {
      headers: {
        'xi-api-key': apiKey,
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`ElevenLabs connection failed (${response.status}): ${details || response.statusText}`);
    }

    return { ok: true };
  }
}

module.exports = ElevenLabsEngine;

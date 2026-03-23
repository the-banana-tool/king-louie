const path = require('path');
const fs = require('fs');

const SystemTTSEngine = require('./engines/system-tts');
const ElevenLabsEngine = require('./engines/elevenlabs');

const DEFAULT_VOICE_SETTINGS = {
  enabled: false,
  engine: 'system',
  voiceId: '',
  speed: 1,
  stability: 0.5,
  style: 0.25,
  speakAgentSummary: true,
  speakChatResponses: false,
  telegramVoiceForLongResponses: false,
  telegramMinChars: 500,
  summaryMaxChars: 260
};

const sanitizeText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();

class TTSEngine {
  constructor(options = {}) {
    this.getSettings =
      typeof options.getSettings === 'function'
        ? options.getSettings
        : () => ({ ...DEFAULT_VOICE_SETTINGS });
    this.systemEngine = options.systemEngine || new SystemTTSEngine();
    this.elevenLabsEngine =
      options.elevenLabsEngine
      || new ElevenLabsEngine({
        getApiKey:
          typeof options.getElevenLabsApiKey === 'function'
            ? options.getElevenLabsApiKey
            : () => ''
      });
    this.audioOutputDirectory = options.audioOutputDirectory || null;
  }

  getSettingsSnapshot() {
    const settings = this.getSettings() || {};
    return {
      ...DEFAULT_VOICE_SETTINGS,
      ...(settings || {})
    };
  }

  isEnabled(overrides = {}) {
    const settings = this.getSettingsSnapshot();
    const effectiveEnabled =
      typeof overrides.enabled === 'boolean'
        ? overrides.enabled
        : settings.enabled;

    return effectiveEnabled === true;
  }

  resolveEngineName(overrides = {}) {
    const settings = this.getSettingsSnapshot();
    const candidate = String(overrides.engine || settings.engine || 'system').trim().toLowerCase();
    return candidate === 'elevenlabs' ? 'elevenlabs' : 'system';
  }

  buildEngineOptions(overrides = {}) {
    const settings = this.getSettingsSnapshot();
    return {
      voiceId: overrides.voiceId || settings.voiceId || '',
      speed:
        typeof overrides.speed === 'number' && Number.isFinite(overrides.speed)
          ? overrides.speed
          : Number(settings.speed),
      stability:
        typeof overrides.stability === 'number' && Number.isFinite(overrides.stability)
          ? overrides.stability
          : Number(settings.stability),
      style:
        typeof overrides.style === 'number' && Number.isFinite(overrides.style)
          ? overrides.style
          : Number(settings.style),
      modelId: overrides.modelId || settings.modelId || 'eleven_multilingual_v2'
    };
  }

  summarizeText(text = '', maxChars = 260) {
    const normalized = sanitizeText(text);
    if (!normalized) {
      return '';
    }

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(32, maxChars - 1)).trimEnd()}…`;
  }

  async speak(text, options = {}) {
    if (!this.isEnabled(options)) {
      return {
        ok: false,
        skipped: true,
        reason: 'Voice output is disabled.'
      };
    }

    const normalizedText = sanitizeText(text);
    if (!normalizedText) {
      return {
        ok: false,
        skipped: true,
        reason: 'No text supplied for speech.'
      };
    }

    const engineName = this.resolveEngineName(options);
    const engineOptions = this.buildEngineOptions(options);

    if (engineName === 'elevenlabs') {
      const audio = await this.elevenLabsEngine.speak(normalizedText, engineOptions);
      const output = {
        ok: true,
        engine: 'elevenlabs',
        text: normalizedText,
        audio
      };

      if (this.audioOutputDirectory && audio?.buffer) {
        const outputPath = path.join(
          this.audioOutputDirectory,
          `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.${audio.extension || 'mp3'}`
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, audio.buffer);
        output.audioFile = outputPath;
      }

      return output;
    }

    const result = await this.systemEngine.speak(normalizedText, engineOptions);
    return {
      ok: true,
      engine: 'system',
      text: normalizedText,
      result
    };
  }

  async speakSummary(text, options = {}) {
    const settings = this.getSettingsSnapshot();
    const maxChars = Number(options.summaryMaxChars || settings.summaryMaxChars || 260);
    const summary = this.summarizeText(text, Number.isFinite(maxChars) ? maxChars : 260);
    if (!summary) {
      return {
        ok: false,
        skipped: true,
        reason: 'No summary text available.'
      };
    }

    return this.speak(summary, options);
  }

  async testConnection(settings = {}) {
    const engineName = this.resolveEngineName(settings);
    if (engineName !== 'elevenlabs') {
      return { ok: true, engine: 'system' };
    }

    await this.elevenLabsEngine.testConnection();
    return { ok: true, engine: 'elevenlabs' };
  }
}

module.exports = {
  TTSEngine,
  DEFAULT_VOICE_SETTINGS
};

const assert = require('assert');

const { TTSEngine } = require('../src/voice/tts-engine');
const ElevenLabsEngine = require('../src/voice/engines/elevenlabs');
const SystemTTSEngine = require('../src/voice/engines/system-tts');

function run(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✔ ${name}`);
    })
    .catch((error) => {
      console.error(`✖ ${name}`);
      console.error(error.stack || error.message || error);
      process.exitCode = 1;
    });
}

run('TTSEngine.speakSummary skips when voice is disabled', async () => {
  const tts = new TTSEngine({
    getSettings: () => ({ enabled: false, engine: 'system', summaryMaxChars: 120 }),
    systemEngine: {
      speak: async () => ({ ok: true })
    }
  });

  const result = await tts.speakSummary('This should never be spoken.');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.skipped, true);
  assert.match(String(result.reason || ''), /disabled/i);
});

run('TTSEngine.speakSummary truncates long content before speaking', async () => {
  const spoken = [];
  const tts = new TTSEngine({
    getSettings: () => ({ enabled: true, engine: 'system', summaryMaxChars: 40 }),
    systemEngine: {
      speak: async (text) => {
        spoken.push(text);
        return { ok: true };
      }
    }
  });

  const longText = 'This is a very long assistant response that should be summarized to the configured maximum character length.';
  const result = await tts.speakSummary(longText);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.engine, 'system');
  assert.strictEqual(spoken.length, 1);
  assert.ok(spoken[0].length <= 40, `Expected summary length <= 40, got ${spoken[0].length}`);
  assert.ok(spoken[0].endsWith('…'), 'Expected summary to end with an ellipsis when truncated');
});

run('ElevenLabsEngine.buildVoiceSettings clamps ranges', () => {
  const engine = new ElevenLabsEngine({ apiKey: 'test' });
  const settings = engine.buildVoiceSettings({
    stability: 2,
    style: -1,
    speed: 9
  });

  assert.strictEqual(settings.stability, 1);
  assert.strictEqual(settings.style, 0);
  assert.strictEqual(settings.speed, 1.2);
  assert.strictEqual(settings.use_speaker_boost, true);
});

run('SystemTTSEngine.buildCommand returns expected platform-specific commands', () => {
  const windows = SystemTTSEngine.buildCommand('win32', 'Hello from Windows', {
    voiceId: 'Microsoft Zira Desktop',
    speed: 1.4
  });
  assert.strictEqual(windows.command, 'powershell.exe');
  assert.ok(windows.args.join(' ').includes('SpeechSynthesizer'));
  assert.ok(windows.args.join(' ').includes('SelectVoice'));

  const mac = SystemTTSEngine.buildCommand('darwin', 'Hello from macOS', {
    voiceId: 'Samantha',
    speed: 1.1
  });
  assert.strictEqual(mac.command, 'say');
  assert.ok(mac.args.includes('-v'));
  assert.ok(mac.args.includes('Samantha'));
  assert.ok(mac.args.includes('-r'));

  const linux = SystemTTSEngine.buildCommand('linux', 'Hello from Linux', {
    voiceId: 'en-us',
    speed: 0.9
  });
  assert.strictEqual(linux.command, 'espeak');
  assert.ok(linux.args.includes('-v'));
  assert.ok(linux.args.includes('en-us'));
  assert.ok(linux.args.includes('-s'));
});

setTimeout(() => {
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  console.log('Voice/TTS tests completed.');
}, 50);

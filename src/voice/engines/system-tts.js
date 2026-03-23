const { spawn } = require('child_process');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toWindowsRate = (speed) => {
  if (typeof speed !== 'number' || Number.isNaN(speed)) {
    return null;
  }

  // SAPI rate range is roughly -10..10, speed is expected around 0.5..2.0
  return clamp(Math.round((speed - 1) * 10), -10, 10);
};

const escapePowerShellSingleQuoted = (value = '') => String(value).replace(/'/g, "''");

class SystemTTSEngine {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  }

  static buildCommand(platform, text, options = {}) {
    const normalizedText = String(text || '').trim();
    const voice = String(options.voiceId || options.voice || '').trim();
    const speed = typeof options.speed === 'number' ? options.speed : null;

    if (!normalizedText) {
      throw new Error('Text is required for system TTS.');
    }

    if (platform === 'win32') {
      const escapedText = escapePowerShellSingleQuoted(normalizedText);
      const escapedVoice = escapePowerShellSingleQuoted(voice);
      const rate = toWindowsRate(speed);

      const scriptLines = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Speech',
        '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer'
      ];

      if (escapedVoice) {
        scriptLines.push(`$synth.SelectVoice('${escapedVoice}')`);
      }

      if (rate !== null) {
        scriptLines.push(`$synth.Rate = ${rate}`);
      }

      scriptLines.push(`$synth.Speak('${escapedText}')`);

      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', scriptLines.join('; ')],
        shell: false
      };
    }

    if (platform === 'darwin') {
      const args = [];
      if (voice) {
        args.push('-v', voice);
      }
      if (typeof speed === 'number' && Number.isFinite(speed)) {
        args.push('-r', String(clamp(Math.round(speed * 180), 80, 500)));
      }
      args.push(normalizedText);

      return {
        command: 'say',
        args,
        shell: false
      };
    }

    // Linux and other unix-like systems default to espeak
    const args = [];
    if (voice) {
      args.push('-v', voice);
    }
    if (typeof speed === 'number' && Number.isFinite(speed)) {
      args.push('-s', String(clamp(Math.round(speed * 175), 80, 450)));
    }
    args.push(normalizedText);

    return {
      command: 'espeak',
      args,
      shell: false
    };
  }

  async speak(text, options = {}) {
    const commandSpec = SystemTTSEngine.buildCommand(this.platform, text, options);

    await new Promise((resolve, reject) => {
      const child = this.spawnImpl(commandSpec.command, commandSpec.args, {
        shell: commandSpec.shell,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });

      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk || '');
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`System TTS exited with code ${code}: ${stderr.trim() || 'unknown error'}`));
      });
    });

    return {
      ok: true,
      engine: 'system',
      platform: this.platform
    };
  }
}

module.exports = SystemTTSEngine;

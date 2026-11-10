// The voices this computer's own speech engine can use (settings redesign spec
// §7.3): what the Voice page offers for "This computer's voice". One OS command
// per platform, its arguments as an array (no shell). It never rejects: any
// failure, a missing command included, gives [].
const childProcess = require('child_process');

const WINDOWS_SCRIPT = 'Add-Type -AssemblyName System.Speech; '
  + '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | '
  + 'ForEach-Object { $_.VoiceInfo.Name }';

function commandFor(platform) {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-Command', WINDOWS_SCRIPT], parse: parseLines };
  if (platform === 'darwin') return { file: 'say', args: ['-v', '?'], parse: parseSay };
  return { file: 'espeak', args: ['--voices'], parse: parseEspeak };
}

const lines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function parseLines(text) {
  return lines(text);
}

// `say -v ?`: "Alex   en_US  # Most people…"; a name may hold one space
// ("Bad News"), so the name is everything before the locale column.
function parseSay(text) {
  return lines(text).map((l) => {
    const m = l.match(/^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]+\s+#/);
    return m ? m[1].trim() : l.split(/\s+/)[0];
  }).filter(Boolean);
}

// `espeak --voices`: a header, then "Pty Language Age/Gender VoiceName File ...".
function parseEspeak(text) {
  return lines(text)
    .filter((l) => !/^Pty\b/.test(l))
    .map((l) => l.split(/\s+/)[3])
    .filter(Boolean);
}

function listSystemVoices({ platform = process.platform, execFile = childProcess.execFile, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    try {
      const { file, args, parse } = commandFor(platform);
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve([...new Set(parse(stdout))]);
        } catch {
          resolve([]);
        }
      });
    } catch {
      resolve([]);
    }
  });
}

module.exports = { listSystemVoices };

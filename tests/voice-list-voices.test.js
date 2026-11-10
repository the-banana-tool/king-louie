// tests/voice-list-voices.test.js
// The voices this computer can speak with (settings redesign spec §7.3, §8.4):
// one OS command per platform, arguments as an array, never a rejection.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { listSystemVoices } = require('../src/voice/list-voices');
const { voicesAreLocal } = require('../renderer-helpers/settings-banner');

function fakeExecFile(stdout, calls = []) {
  return (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    cb(null, stdout, '');
  };
}

describe('listSystemVoices', () => {
  it('win32: one name per line from System.Speech', async () => {
    const calls = [];
    const voices = await listSystemVoices({
      platform: 'win32', env: { SystemRoot: 'D:\\Win' }, execFile: fakeExecFile('Microsoft David\r\nMicrosoft Zira\r\n', calls)
    });
    assert.deepStrictEqual(voices, ['Microsoft David', 'Microsoft Zira']);
    // By its absolute path, never a bare name Windows would look up in the cwd first.
    assert.strictEqual(calls[0].file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.ok(Array.isArray(calls[0].args));
    assert.deepStrictEqual(calls[0].args.slice(0, 2), ['-NoProfile', '-Command']);
    assert.match(calls[0].args[2], /System\.Speech/);
    assert.ok(calls[0].opts.timeout > 0);
  });

  it('an error gives []', async () => {
    const failing = (file, args, opts, cb) => cb(new Error('not found'), '', '');
    assert.deepStrictEqual(await listSystemVoices({ platform: 'win32', execFile: failing }), []);
    const throwing = () => { throw new Error('spawn EPERM'); };
    assert.deepStrictEqual(await listSystemVoices({ platform: 'linux', execFile: throwing }), []);
  });

  it('darwin: the first column of say -v ?', async () => {
    const calls = [];
    const voices = await listSystemVoices({ platform: 'darwin', execFile: fakeExecFile('Alex   en_US  # Most people…\n', calls) });
    assert.deepStrictEqual(voices, ['Alex']);
    assert.deepStrictEqual([calls[0].file, calls[0].args], ['say', ['-v', '?']]);
  });

  it('other: the name column of espeak --voices', async () => {
    const out = 'Pty Language       Age/Gender VoiceName          File                 Other Languages\n'
      + ' 5  af              --/M      Afrikaans          gmw/af\n'
      + ' 5  en-us           --/M      English_(America)  gmw/en-US            (en 3)\n';
    const calls = [];
    assert.deepStrictEqual(await listSystemVoices({ platform: 'linux', execFile: fakeExecFile(out, calls) }), ['Afrikaans', 'English_(America)']);
    assert.deepStrictEqual([calls[0].file, calls[0].args], ['espeak', ['--voices']]);
  });
});

describe('voicesAreLocal (spec §8.4)', () => {
  it('standalone or a personal node: this computer; a fleet node or no status: not', () => {
    assert.strictEqual(voicesAreLocal({ mode: 'standalone' }), true);
    assert.strictEqual(voicesAreLocal({ mode: 'attached', service: { hosting: 'personal' } }), true);
    assert.strictEqual(voicesAreLocal({ mode: 'attached', pairing: { service: { hosting: 'personal' } } }), true);
    assert.strictEqual(voicesAreLocal({ mode: 'attached', service: { hosting: 'service' } }), false);
    assert.strictEqual(voicesAreLocal({ mode: 'attached' }), false);
    assert.strictEqual(voicesAreLocal(null), false);
  });
});

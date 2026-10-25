// tests/e2e/demo-take.test.js
//
// A take's two helper-side pieces on the real desktop (demo takes spec
// 2026-10-24 §8, §9, §14): the Windows backend launches Playwright's
// Chromium with a profile under a temporary LOCALAPPDATA, the test attaches
// over CDP, the backend records the screen with the ffmpeg the helper would
// find on PATH, and ffprobe checks the mp4. Windows only, in an interactive
// session, only with KL_E2E_TAKE=1. No helper child, no input, no lease,
// nothing from the real profile; it records whatever is on the screen for
// five seconds.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createWindowsBackend } = require('../../src/session/backends/windows');
const { createOpHandler } = require('../../src/session/connection');
const { findFfmpeg } = require('../../src/session/recorder');
const PlaywrightBrowser = require('../../src/browser/playwright-browser');

const RUN = process.platform === 'win32' && process.env.KL_E2E_TAKE === '1';
const RECORD_MS = 5000;

describe('demo take: browser and recorder end to end', { skip: !RUN && 'set KL_E2E_TAKE=1 on Windows, in an interactive session' }, () => {
  let base;
  let backend;
  let ffmpeg;
  let browserPid = null;
  let attached = null;

  before(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-take-')));
    const env = { ...process.env, LOCALAPPDATA: base };
    backend = createWindowsBackend({ env });
    // What the helper finds once at startup, from the user's own PATH.
    ffmpeg = findFfmpeg({ env });
  });

  after(async () => {
    if (attached) await attached.stop().catch(() => {});
    if (browserPid !== null) {
      try { process.kill(browserPid); } catch { /* gone */ }
    }
    if (backend) await Promise.resolve(backend.stop()).catch(() => {});
    // Chromium's children let go of the profile a moment after it ends.
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* best effort */ }
  });

  it('launches a browser, attaches, records five seconds and gets a playable mp4', async (t) => {
    if (!ffmpeg) {
      t.skip('no ffmpeg.exe on PATH (winget install Gyan.FFmpeg)');
      return;
    }
    const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');

    const launched = await backend.launchBrowser({ exe: chromium.executablePath(), profile: 'e2e' });
    browserPid = launched.pid;
    assert.ok(Number.isInteger(launched.pid));
    assert.ok(Number.isInteger(launched.cdp.port));
    assert.ok(fs.existsSync(path.join(base, 'KingLouie', 'browser-profiles', 'e2e')), 'the profile is under LOCALAPPDATA');

    attached = new PlaywrightBrowser();
    await attached.attach({ cdpUrl: `http://127.0.0.1:${launched.cdp.port}` });
    await attached.page.goto('about:blank');

    // Through the helper's own op handler: record_start names no ffmpeg, so
    // the one found on PATH is used.
    const ops = createOpHandler(backend, { recorder: { ffmpeg } });
    const takeId = `take-${crypto.randomBytes(6).toString('hex')}`;
    const started = await ops('record_start', { take_id: takeId, fps: 30 });
    assert.equal(fs.realpathSync.native(path.dirname(started.path)), fs.realpathSync.native(path.join(base, 'KingLouie', 'recordings', takeId)));

    // A ref'd timer holds the loop open across the recording.
    await new Promise((resolve) => setTimeout(resolve, RECORD_MS));
    const stopped = await backend.recordStop({ pid: started.pid });
    assert.equal(stopped.path, started.path);
    assert.equal(stopped.truncated, false);
    assert.ok(fs.existsSync(stopped.path), 'the mp4 exists');
    assert.ok(stopped.bytes > 0, 'the mp4 is not empty');

    assert.ok(fs.existsSync(ffprobe), 'ffprobe.exe is beside ffmpeg.exe');
    const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', stopped.path], { encoding: 'utf8' });
    const duration = Number(out.trim());
    assert.ok(duration >= 3, `ffprobe reports ${duration} s`);
  });
});

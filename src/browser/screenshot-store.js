// Where the browser tool saves a screenshot's file form, and the one way a window
// reads one back (remote window plan R-RW-19). A window names a file; it never
// gives a path: only the base name is read, and only one the tool would have written.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCREENSHOT_NAME = /^screenshot-\d{1,16}\.png$/;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const NOT_A_SCREENSHOT = Object.freeze({ ok: false, code: 'NOT_A_SCREENSHOT', error: 'That is not a screenshot on this node.' });

const screenshotDir = () => path.join(os.tmpdir(), 'king-louie-screenshots');

// Both separators, whatever the node runs on: the window may be on another OS.
const baseName = (requested) => (typeof requested === 'string' ? requested.split(/[\\/]/).pop() : '');

async function readScreenshot(requested) {
  const name = baseName(requested);
  if (!SCREENSHOT_NAME.test(name)) return NOT_A_SCREENSHOT;
  const dir = screenshotDir();
  const file = path.join(dir, name);
  try {
    // lstat, so a link with a screenshot's name is not followed out of the dir.
    const [dirStat, stat] = await Promise.all([fs.promises.lstat(dir), fs.promises.lstat(file)]);
    if (!dirStat.isDirectory() || !stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES) return NOT_A_SCREENSHOT;
    const bytes = await fs.promises.readFile(file);
    if (bytes.length > MAX_SCREENSHOT_BYTES) return NOT_A_SCREENSHOT;
    return { ok: true, bytes: bytes.toString('base64'), mime: 'image/png' };
  } catch {
    return NOT_A_SCREENSHOT;
  }
}

module.exports = { screenshotDir, readScreenshot, MAX_SCREENSHOT_BYTES };

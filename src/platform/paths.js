const fs = require('fs');
const path = require('path');

// On Windows and macOS the data dir is a `data` subdir of the KingLouie dir,
// leaving room beside it for stage 2's root/admin-owned, read-only config
// dir. Linux keeps that config under /etc/king-louie instead.
function defaultServiceDataDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'KingLouie', 'data');
  if (platform === 'darwin') return '/Library/Application Support/KingLouie/data';
  return '/var/lib/king-louie';
}

function ensureServicePaths(dataDir) {
  const paths = {
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(dataDir, 'cache')
  };
  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  }
  return paths;
}

module.exports = { defaultServiceDataDir, ensureServicePaths };

const { execSync } = require('child_process');
const path = require('path');

/**
 * Custom signing script for electron-builder.
 * Uses signtool.exe with a certificate thumbprint from the Windows cert store.
 *
 * Required env vars:
 *   WIN_CSC_THUMBPRINT - SHA1 thumbprint of the signing certificate
 *
 * For CI: the PFX must be imported into the cert store before this runs.
 */
exports.default = async function sign(configuration) {
  const filePath = configuration.path;
  if (!filePath) return;

  const thumbprint = process.env.WIN_CSC_THUMBPRINT;
  if (!thumbprint) {
    console.warn('[sign] WIN_CSC_THUMBPRINT not set, skipping signing');
    return;
  }

  const signtool = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x64\\signtool.exe';

  const cmd = [
    `"${signtool}"`,
    'sign',
    '/tr', 'http://timestamp.digicert.com',
    '/td', 'sha256',
    '/fd', 'sha256',
    '/sha1', `"${thumbprint}"`,
    `"${filePath}"`
  ].join(' ');

  console.log(`[sign] Signing ${path.basename(filePath)}`);
  execSync(cmd, { stdio: 'inherit' });
};

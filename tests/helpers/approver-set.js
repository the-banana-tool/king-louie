// tests/helpers/approver-set.js
//
// A real ApproverStore over a temp approvers dir holding `records`. The test
// process owns the files, so it plays the administrator (platform 'linux'
// selects the POSIX checks; on Windows assertAdminOwned is a no-op).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApproverStore } = require('../../src/approvals/approver-store');

async function approverStoreWith(records = [], { overlay = [], allowTestKeys = false, now = Date.now } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-approver-set-'));
  const config = path.join(base, 'config');
  const dir = path.join(config, 'approvers');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') {
    fs.chmodSync(base, 0o755);
    fs.chmodSync(config, 0o755);
  }
  for (const record of records) {
    fs.writeFileSync(path.join(dir, `${record.device_id}.json`), JSON.stringify(record), { mode: 0o644 });
  }
  const uid = process.platform !== 'win32' ? process.getuid() : 0;
  const store = new ApproverStore({
    dir,
    stagedDir: path.join(base, 'data', 'approvals', 'staged'),
    geteuid: () => uid,
    adminUid: uid,
    platform: 'linux',
    allowTestKeys,
    now
  });
  await store.ready();
  for (const id of overlay) store.addToOverlay(id);
  store.baseDir = base;
  store.cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  return store;
}

module.exports = { approverStoreWith };

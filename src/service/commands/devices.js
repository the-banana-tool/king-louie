// `enroll-device` and `device list|revoke|apply` (spec §3.10): the only
// commands that write the approver set, run by an administrator.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { adminConfigDir } = require('../../platform/paths');
const { buildServicePorts } = require('../ports');
const { loadNodeConfig } = require('../node-config');
const { restoreDataDirOwnership } = require('../ownership');
const { readLine, printable, runningServicePid, renderQr } = require('./io');

const ENROLL_TTL_MS = 10 * 60 * 1000;
const DEVICE_HELP = `Usage: king-louie-service device list [--data-dir DIR]
       king-louie-service device revoke <device-id> [--data-dir DIR]
       king-louie-service device apply [--yes] [--data-dir DIR]
`;

function layout(dataDir, configDir, deps) {
  const { ApproverAdmin } = require('../../approvals/approver-admin');
  const dir = path.join(configDir, 'approvers');
  const stagedDir = path.join(dataDir, 'approvals', 'staged');
  const storeOptions = deps.storeOptions || {};
  return { dir, stagedDir, storeOptions, admin: new ApproverAdmin({ dir, stagedDir, ...storeOptions, ...(deps.now ? { now: deps.now } : {}) }) };
}

function auditLedger(dataDir, identity, written) {
  const { AuditLedger } = require('../../audit/audit-ledger');
  return new AuditLedger({ dir: path.join(dataDir, 'audit'), identity, nodeId: identity.nodeId, writer: 'cli', onPathWritten: (p) => written.push(p) });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// listStaged()/applyStaged() throw ApproverAdminError when staged/ or
// staged/done/ is itself a symlink (I2/M1 of Task 7's review) — a directory
// the service account could have swapped root's admin CLI into following.
// That is a result to report, never an uncaught throw out of the command.
function isApproverAdminError(err) {
  return err && err.name === 'ApproverAdminError';
}

async function runEnrollDevice({ dataDir, configDir = adminConfigDir({ dataDir }), io, deps = {} }) {
  const { FileCourier } = require('../../approvals/courier');
  const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
  const { verifyConsoleEnrollment } = require('../../approvals/verify-device');
  const { buildEnrollOpen, buildEnrollDone, encodeQr } = require('../../approvals/messages');
  const { fingerprintGroups } = require('../../approvals/envelope');
  const now = deps.now || Date.now;
  const { admin } = layout(dataDir, configDir, deps);

  try {
    admin.assertWritable();
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (!runningServicePid(dataDir)) {
    io.stderr.write('The King Louie service is not running on this node. Start it, then run enroll-device again.\n');
    return 1;
  }
  const nodeCfg = loadNodeConfig({ dataDir, adminConfigDir: configDir, ...(deps.storeOptions || {}) });
  if (!nodeCfg.approvers.relay && !fs.existsSync(path.join(configDir, 'front-door.json'))) {
    io.stderr.write(`approvers.relay is not set in ${path.join(configDir, 'node.yaml')}.\n`);
    return 1;
  }
  const link = readJson(path.join(dataDir, 'approvals', 'link.json'));
  if (!link || link.connected !== true) {
    io.stderr.write(`The service is not linked to its relay yet (see ${path.join(dataDir, 'approvals', 'link.json')}). Check \`relay nodes\` on the relay host.\n`);
    return 1;
  }

  const written = [];
  const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
  const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeCfg.name);
  const courier = new FileCourier({ dataDir, identity, onPathWritten: (p) => written.push(p), ...(deps.pollMs ? { pollMs: deps.pollMs } : {}) }).start();
  const codeId = crypto.randomBytes(16).toString('base64url');
  const code = crypto.randomBytes(32).toString('base64url');
  const codeTtlMs = deps.codeTtlMs || ENROLL_TTL_MS;
  // The code dies codeTtlMs after it is opened; nothing is enrolled after
  // that, including on an answer to the [y/N] question that comes too late.
  // The CLI stops waiting a little before, so its `refused` still reaches
  // the service (which drops enroll.done for a code already expired).
  const deadlineMs = codeTtlMs - Math.min(5000, Math.floor(codeTtlMs / 10));
  const expired = new AbortController();
  const expiry = setTimeout(() => expired.abort(), deadlineMs);
  if (typeof expiry.unref === 'function') expiry.unref();
  const finish =(claim, refused) => courier.call('enroll.done', { envelope: buildEnrollDone({ identity, codeId, enroll: refused ? null : claim, refused }) })
    .catch((err) => io.stderr.write(`Could not tell the relay: ${err.message}\n`));
  try {
    const claimed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), Math.min(deps.timeoutMs || deadlineMs, deadlineMs));
      if (typeof timer.unref === 'function') timer.unref();
      courier.onMessage(async (method, params) => {
        if (method === 'enroll.claim' && params.code_id === codeId) {
          clearTimeout(timer);
          resolve(params.envelope);
        }
      });
    });
    await courier.call('enroll.open', { envelope: buildEnrollOpen({ identity, codeId, expiresAt: now() + codeTtlMs }) });
    const qr = encodeQr({
      t: 'kl.pair',
      relay: link.relay_public_url,
      relay_spki: link.relay_spki,
      code_id: codeId,
      code,
      node: { id: identity.nodeId, name: nodeCfg.name, key: Buffer.from(identity.publicKey).toString('hex') }
    });
    io.stdout.write(`${await (deps.renderQr || renderQr)(qr)}\n`);
    io.stdout.write(`Or paste this into the app: ${qr}\n`);
    io.stdout.write(`Relay fingerprint: ${fingerprintGroups(link.relay_id)}\n`);
    io.stdout.write('Scan the code with the King Louie app. Waiting up to 10 minutes...\n');

    const claim = await claimed;
    if (!claim) {
      await finish(null, true);
      io.stderr.write('No phone answered within 10 minutes. Nothing was enrolled.\n');
      return 1;
    }
    const check = verifyConsoleEnrollment(claim, { codeId, code, now: now(), allowTestKeys: deps.allowTestKeys === true });
    if (!check.ok) {
      await finish(null, true);
      io.stderr.write(`The phone's enrollment was refused (${check.reason}). Nothing was enrolled.\n`);
      return 1;
    }
    const { device } = check.message;
    // The name and platform come from the phone: printed without control or
    // bidi characters so they cannot rewrite what the administrator reads.
    io.stdout.write(`Device "${printable(device.name)}" (${printable(device.platform)}) ${device.device_id.slice(0, 2)}${fingerprintGroups(device.device_id)} — does the phone show the same? [y/N] `);
    const answer = await readLine(io.stdin, { signal: expired.signal });
    if (answer === null) {
      await finish(null, true);
      io.stderr.write('\nThe pairing code expired before you answered. Nothing was enrolled.\n');
      return 1;
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      await finish(null, true);
      io.stdout.write('Not enrolled.\n');
      return 1;
    }
    let wroteApprover = false;
    try {
      admin.writeApprover({
        v: 1,
        device_id: device.device_id,
        name: device.name,
        platform: device.platform,
        public_key: device.public_key,
        enrolled_at: new Date(now()).toISOString(),
        enrolled_by: 'console',
        revoked_at: null,
        revoked_by: null,
        enrollment: claim
      });
      wroteApprover = true;
      await auditLedger(dataDir, identity, written).append({ kind: 'device.enrolled', data: { device_id: device.device_id, by: 'console', envelope: claim } });
    } catch (err) {
      await finish(null, true);
      io.stderr.write(`Enrolling ${device.device_id} failed: ${err.message}\n`);
      if (wroteApprover) {
        io.stderr.write(`Its approver file was written but not audited; run "device revoke ${device.device_id}" unless you mean to keep it.\n`);
      }
      return 1;
    }
    await finish(claim, false);
    io.stdout.write(`Enrolled ${device.device_id}. It can approve unsafe actions on ${nodeCfg.name} now.\n`);
    return 0;
  } finally {
    clearTimeout(expiry);
    courier.stop();
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

function describeState(store, record) {
  if (record.revoked_at) return `revoked ${record.revoked_at} by ${record.revoked_by}`;
  if (record.platform === 'demo') return 'demo (never accepted)';
  if (store.overlay.has(record.device_id)) return 'revoked, pending `device apply`';
  return 'active';
}

// The label `device apply`'s confirmation prompt shows for one staged item.
// `type` may also be 'unsafe' (a symlink, hard link or misnamed file — Task
// 7's listStaged() reports these instead of reading them) or 'unreadable'
// (a name-shaped, readable file whose contents did not parse); both carry no
// deviceId/signer/message, so they are shown by file path instead.
function describeStagedItem(item, now) {
  if (item.type === 'unsafe' || item.type === 'unreadable') {
    return `${item.type}  ${item.file}  (${item.reason || item.error || 'unknown problem'})`;
  }
  const label = item.type === 'kl.device.revoke' ? 'revoke' : 'enroll';
  // Age is judged on the message's own signed created_at (never ageMs, and
  // never the data dir's received_at, which the service itself writes and so
  // does not get to use to set policy or displayed trust).
  return `${label}  ${item.deviceId}  signed by ${item.signer}  (${describeAge(item.message && item.message.created_at, now)})`;
}

// "N min ago" from a signed timestamp; a phone clock ahead of this one reads
// "just now", and anything unparseable "age unknown".
function describeAge(createdAt, now) {
  const at = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(at)) return 'age unknown';
  if (at >= now) return 'just now';
  return `${Math.round((now - at) / 60000)} min ago`;
}

async function runDevice({ sub, arg, flags = {}, dataDir, configDir = adminConfigDir({ dataDir }), io, deps = {} }) {
  const { ApproverStore } = require('../../approvals/approver-store');
  const { fingerprintGroups } = require('../../approvals/envelope');
  const { dir, stagedDir, storeOptions, admin } = layout(dataDir, configDir, deps);

  if (sub === 'list') {
    // serviceProbe: false — this store is built by the admin CLI, which on
    // Windows runs elevated and can always write approvers/; the service's
    // own (serviceProbe: true) store is the one that must fail closed if its
    // account can write there too.
    const store = new ApproverStore({ dir, stagedDir, ...storeOptions, serviceProbe: false });
    const ready = await store.ready();
    if (!ready.ok) io.stderr.write(`Warning: ${ready.problem}\n`);
    const records = store.list();
    if (records.length === 0) io.stdout.write('No approver devices on this node.\n');
    for (const r of records) {
      io.stdout.write(`${fingerprintGroups(r.device_id)}  ${r.device_id}  ${printable(r.name)} (${printable(r.platform)})  ${describeState(store, r)}  enrolled by ${r.enrolled_by}\n`);
    }
    try {
      const staged = admin.listStaged();
      if (staged.length) io.stdout.write(`${staged.length} staged change(s) wait for \`device apply\`.\n`);
    } catch (err) {
      if (!isApproverAdminError(err)) throw err;
      io.stderr.write(`Warning: ${err.message}\n`);
    }
    return 0;
  }

  if (sub !== 'revoke' && sub !== 'apply') {
    io.stderr.write(DEVICE_HELP);
    return 2;
  }
  try {
    admin.assertWritable();
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 1;
  }
  const written = [];
  try {
    const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
    const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
    const nodeCfg = loadNodeConfig({ dataDir, adminConfigDir: configDir, ...(deps.storeOptions || {}) });
    const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, nodeCfg.name);
    const ledger = auditLedger(dataDir, identity, written);

    if (sub === 'revoke') {
      if (!arg) {
        io.stderr.write(DEVICE_HELP);
        return 2;
      }
      try {
        admin.markRevoked(arg, 'console');
      } catch (err) {
        io.stderr.write(`${err.message}\n`);
        return 1;
      }
      await ledger.append({ kind: 'device.revoked', data: { device_id: arg, by: 'console', envelope: null } });
      io.stdout.write(`Revoked ${arg}. It can no longer approve anything on ${nodeCfg.name}.\n`);
      return 0;
    }

    let results;
    try {
      results = await admin.applyStaged({
        confirm: async (items) => {
          const nowMs = (deps.now || Date.now)();
          for (const i of items) io.stdout.write(`${describeStagedItem(i, nowMs)}\n`);
          if (flags.yes) return true;
          io.stdout.write('Apply these? [y/N] ');
          return /^y(es)?$/i.test((await readLine(io.stdin)).trim());
        }
      });
    } catch (err) {
      if (!isApproverAdminError(err)) throw err;
      io.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (results.length === 0) {
      io.stdout.write('Nothing applied.\n');
      return 0;
    }
    for (const r of results) {
      // `result` also covers Task 7's `deferred: unknown device` (a staged
      // revoke of a device with no record yet, left in place until either an
      // admin-applied record exists or its own signed window ages out) and
      // the various `rejected: …` reasons, including unsafe/unreadable
      // entries — all just displayed, since only enrolled/revoked write audit.
      // Unsafe and unreadable entries have no device id: name the file.
      io.stdout.write(`${r.deviceId || r.file}: ${r.result}\n`);
      if (r.result === 'enrolled') await ledger.append({ kind: 'device.enrolled', data: { device_id: r.deviceId, by: r.signer, envelope: null } });
      if (r.result === 'revoked') await ledger.append({ kind: 'device.revoked', data: { device_id: r.deviceId, by: r.signer, envelope: null } });
    }
    return 0;
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runEnrollDevice, runDevice, DEVICE_HELP, describeAge };

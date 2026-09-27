// Console node records removed while the front door was not watching
// (fleet stage 4 §3.11, Task 33 fix round). `frontdoor remove-node` audits a
// removal itself when the service is running; one made while it was stopped
// (or a record deleted by hand before a SIGHUP) is found here, by comparing
// the console records on disk with the set the front door last saw, and each
// one that disappeared is audited as frontdoor.node.removed.
//
// The last-known set lives in the service-writable data dir. It decides no
// policy, only which removals get an audit entry, and is read as untrusted
// input: size-capped, every entry checked, bounded in count.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');
const { NODE_ID_RE } = require('../approvals/messages');
const { NODE_NAME_RE } = require('./protocol/messages');
const { NodeRegistry } = require('./router/node-registry');
const { recordFrontDoorEvent } = require('./audit/own-ledger');

const log = createLogger('frontdoor/console-removals');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ENTRIES = 1000;

const validEntry = (id, name) => typeof id === 'string' && NODE_ID_RE.test(id) && typeof name === 'string' && NODE_NAME_RE.test(name);

// node_id → node_name for every console record file on disk that names both.
function consoleOnDisk(configDir) {
  const out = new Map();
  const dir = NodeRegistry.consoleDir(configDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) continue;
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (r && validEntry(r.node_id, r.node_name)) out.set(r.node_id, r.node_name);
    } catch {
      // not a record
    }
  }
  return out;
}

// The saved set, or null when there is none yet (or it is unusable: then
// nothing is audited this time and the set starts again from disk).
function readKnown(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.v !== 1 || !Array.isArray(data.nodes)) return null;
    const out = new Map();
    for (const e of data.nodes.slice(0, MAX_ENTRIES)) if (e && validEntry(e.node_id, e.node_name)) out.set(e.node_id, e.node_name);
    return out;
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`${file} is unreadable (${e.code || e.message}); starting its console record set again`);
    return null;
  }
}

// Audits each console record that was known and is gone (except the names
// in `alreadyAudited`), then saves the current set. → the removed entries.
async function auditConsoleRemovals({ configDir, file, ledger, noticed, alreadyAudited = [] }) {
  const current = consoleOnDisk(configDir);
  const known = readKnown(file);
  const removed = [];
  if (known) {
    for (const [nodeId, nodeName] of known) {
      if (current.has(nodeId) || alreadyAudited.includes(nodeName)) continue;
      removed.push({ node_id: nodeId, node_name: nodeName });
      // Audited before the set is saved: a crash in between audits again
      // rather than never.
      await recordFrontDoorEvent(ledger, 'frontdoor.node.removed', { node_name: nodeName, node_id: nodeId, by: 'console', noticed });
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const nodes = [...current].slice(0, MAX_ENTRIES).map(([nodeId, nodeName]) => ({ node_id: nodeId, node_name: nodeName }));
    writeFileAtomic(file, `${JSON.stringify({ v: 1, nodes }, null, 2)}\n`);
  } catch (e) {
    log.warn(`saving ${file} failed (${e.code || e.message}); the next start compares against the older set`);
  }
  return removed;
}

module.exports = { auditConsoleRemovals, consoleOnDisk };

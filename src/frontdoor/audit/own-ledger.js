// The front door's own ledger (§3.12): F3's AuditLedger in its data dir,
// with these kinds. It is served like a node's history (node_id =
// frontdoor_id) and is not mirrored anywhere (R54, deferred). This module
// adds no hash-chain or append-only logic of its own — the ledger passed in
// is a real AuditLedger, and its chain/append rules apply unchanged; this
// is only the kind allowlist and the "never throw" wrapper around it.
const { createLogger } = require('../../logging');

const log = createLogger('frontdoor/audit');

const FRONT_DOOR_AUDIT_KINDS = Object.freeze([
  'frontdoor.grant.approved', 'frontdoor.grant.denied', 'frontdoor.grant.revoked',
  'frontdoor.token.issued', 'frontdoor.refresh_reuse',
  'frontdoor.node.enrolled', 'frontdoor.node.removed', 'frontdoor.node.replaced',
  'frontdoor.pairing.code_issued', 'frontdoor.tls.repin', 'frontdoor.alert.ack'
]);

async function recordFrontDoorEvent(ledger, kind, data = {}) {
  if (!FRONT_DOOR_AUDIT_KINDS.includes(kind)) throw new Error(`unknown front-door audit kind ${kind}`);
  if (!ledger) return;
  try {
    await ledger.append({ kind, data });
  } catch (err) {
    log.warn(`audit ${kind} failed: ${err.message}`);
  }
}

module.exports = { FRONT_DOOR_AUDIT_KINDS, recordFrontDoorEvent };

// Console enrollment codes (opened by a node with a signed kl.enroll.open)
// and single-use invites from one phone to the next, ten minutes each. The
// ids are 16 random bytes: knowing one is the credential for its routes.
const crypto = require('crypto');
const { CODE_ID_RE, NODE_ID_RE, DEVICE_ID_RE } = require('../approvals/messages');

const TTL_MS = 10 * 60 * 1000;
const KEEP_MS = 10 * 60 * 1000;
// A backstop alongside the TTL sweep: named in the caller's own bounding
// checklist, so each map gets a hard ceiling as well.
const MAX_CODES = 2000;
const MAX_INVITES = 5000;
// 'waiting' and 'expired' are computed by getCode, never written directly.
const CLOSE_STATES = ['done', 'refused'];

const err = (code, message) => Object.assign(new Error(message || code), { code });

function boundMap(map, max) {
  if (map.size <= max) return;
  let excess = map.size - max;
  for (const id of map.keys()) {
    if (excess-- <= 0) break;
    map.delete(id);
  }
}

function isPlainDevice(device) {
  return device !== null && typeof device === 'object' && DEVICE_ID_RE.test(device.device_id);
}

class Invites {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.codes = new Map();
    this.invites = new Map();
  }

  openCode(codeId, nodeId, expiresAt) {
    if (!CODE_ID_RE.test(codeId)) throw err('bad_code', 'code id is not well-formed');
    if (!NODE_ID_RE.test(nodeId)) throw err('bad_node', 'node id is not well-formed');
    this.codes.set(codeId, { code_id: codeId, node_id: nodeId, expires_at: expiresAt, state: 'waiting', claim: null, enroll: null });
    boundMap(this.codes, MAX_CODES);
  }

  // { code_id, node_id, expires_at, state: waiting|done|refused|expired, claim, enroll } or null.
  getCode(codeId) {
    if (!CODE_ID_RE.test(codeId)) return null;
    const code = this.codes.get(codeId);
    if (!code || this.now() > code.expires_at + KEEP_MS) return null;
    const expired = code.state === 'waiting' && this.now() > code.expires_at;
    return { ...code, state: expired ? 'expired' : code.state };
  }

  // The phone's self-signed enrollment for an open code.
  claimCode(codeId, envelope) {
    const code = this.getCode(codeId);
    if (!code || code.state !== 'waiting') throw err('unknown_code', 'no open enrollment code with that id');
    this.codes.get(codeId).claim = envelope;
    return code;
  }

  closeCode(codeId, state, enroll = null) {
    if (!CLOSE_STATES.includes(state)) throw new TypeError(`closeCode state must be one of ${CLOSE_STATES.join(', ')}`);
    const code = this.codes.get(codeId);
    if (!code) return false;
    code.state = state;
    code.enroll = enroll;
    return true;
  }

  createInvite(deviceId) {
    if (!DEVICE_ID_RE.test(deviceId)) throw err('bad_device', 'device id is not well-formed');
    const inviteId = crypto.randomBytes(16).toString('base64url');
    const expiresAt = this.now() + TTL_MS;
    this.invites.set(inviteId, { invite_id: inviteId, inviter: deviceId, expires_at: expiresAt, claim: null });
    boundMap(this.invites, MAX_INVITES);
    return { invite_id: inviteId, expires_at: new Date(expiresAt).toISOString() };
  }

  getInvite(inviteId) {
    const invite = this.invites.get(inviteId);
    if (!invite || this.now() > invite.expires_at) return null;
    return invite;
  }

  // Single use. The relay does not check `mac`; the inviting phone does.
  claim(inviteId, { device, mac }) {
    const invite = this.getInvite(inviteId);
    if (!invite) throw err('unknown_invite', 'no open invite with that id');
    if (invite.claim) throw err('already_claimed', 'this invite was already claimed');
    if (!isPlainDevice(device) || typeof mac !== 'string' || !mac) throw err('bad_claim', 'claim needs a well-formed device and mac');
    invite.claim = { device, mac, claimed_at: new Date(this.now()).toISOString() };
    return invite.claim;
  }

  getClaim(inviteId, deviceId) {
    const invite = this.getInvite(inviteId);
    if (!invite) throw err('unknown_invite', 'no open invite with that id');
    if (invite.inviter !== deviceId) throw err('forbidden', 'only the inviting device can read the claim');
    return invite.claim;
  }

  sweep() {
    const now = this.now();
    for (const [id, c] of this.codes) if (now > c.expires_at + KEEP_MS) this.codes.delete(id);
    for (const [id, i] of this.invites) if (now > i.expires_at) this.invites.delete(id);
  }
}

module.exports = { Invites, TTL_MS };

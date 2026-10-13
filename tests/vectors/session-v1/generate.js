#!/usr/bin/env node
// tests/vectors/session-v1/generate.js
//
// Rebuilds the kl-session-v1 vectors (fleet stage 5 spec §4.2).
//   node tests/vectors/session-v1/generate.js          write the files
//   node tests/vectors/session-v1/generate.js --check  exit 1 if any differ
// Everything is deterministic: fixed secret and nonces, and AES-GCM with a
// fixed key and IV.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../../../src/gui/helper-protocol');
const KEYS = require('../approval-v1/keys.json');

const DIR = __dirname;
const sha = (label) => crypto.createHash('sha256').update(label).digest();
const SECRET = sha('session-v1 vector secret');
const NODE_ID = KEYS.nodes['gpu-box'].id;
const NONCE_H = sha('session-v1 nonce_h').toString('base64url');
const NONCE_S = sha('session-v1 nonce_s').toString('base64url');

const PLAINTEXTS = {
  sh: [{ t: 'req', id: 1, op: 'foreground', job_id: 'job-1', lease_id: null, params: {} }, { t: 'ping' }],
  hs: [
    { t: 'probe_report', capabilities: ['gui.launch'], probes: [], displays: [], limits: [], locked: false },
    { t: 'res', id: 1, ok: true, result: null }
  ]
};

function buildVectors() {
  const { kSh, kHs } = P.deriveSessionKeys(SECRET, NODE_ID, NONCE_H, NONCE_S);
  const frames = (key, dir, list) => {
    const sealer = P.createSealer(key, dir);
    return list.map((obj) => ({ plaintext_json: JSON.stringify(obj), frame_hex: sealer.seal(obj).toString('hex') }));
  };
  const sh = frames(kSh, P.DIR_SH, PLAINTEXTS.sh);
  const hs = frames(kHs, P.DIR_HS, PLAINTEXTS.hs);
  const tampered = Buffer.from(sh[0].frame_hex, 'hex');
  tampered[tampered.length - 1] ^= 0x01;
  const keysHex = { k_sh_hex: kSh.toString('hex'), k_hs_hex: kHs.toString('hex') };
  return [
    {
      name: 'handshake',
      given: { secret_hex: SECRET.toString('hex'), node_id: NODE_ID, nonce_h: NONCE_H, nonce_s: NONCE_S },
      expect: {
        proof_s: P.serviceProof(SECRET, NODE_ID, NONCE_H, NONCE_S),
        proof_h: P.helperProof(SECRET, NODE_ID, NONCE_S, NONCE_H),
        ...keysHex
      }
    },
    { name: 'sealed-frames', given: keysHex, expect: { service_to_helper: sh, helper_to_service: hs } },
    // Each rejection: open `frames` in order with the named key/dir; the
    // frame at `rejected_at` fails with frame_rejected.
    { name: 'reject-seq-skip', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [sh[1].frame_hex] }, expect: { rejected_at: 0, reason: 'sequence' } },
    { name: 'reject-seq-replay', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [sh[0].frame_hex, sh[0].frame_hex] }, expect: { rejected_at: 1, reason: 'sequence' } },
    { name: 'reject-wrong-direction-key', given: { key_hex: keysHex.k_hs_hex, dir: P.DIR_HS, frames: [sh[0].frame_hex] }, expect: { rejected_at: 0, reason: 'authentication' } },
    { name: 'reject-tampered-tag', given: { key_hex: keysHex.k_sh_hex, dir: P.DIR_SH, frames: [tampered.toString('hex')] }, expect: { rejected_at: 0, reason: 'authentication' } }
  ];
}

const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

if (require.main === module) {
  const check = process.argv.includes('--check');
  let differ = 0;
  const vectors = buildVectors();
  for (const v of vectors) {
    const file = path.join(DIR, `${v.name}.json`);
    const text = serialize(v);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { differ += 1; process.stderr.write(`differs: ${v.name}.json\n`); }
    } else {
      fs.writeFileSync(file, text);
    }
  }
  process.stdout.write(`${vectors.length} vectors ${check ? (differ ? `checked, ${differ} differ` : 'match') : 'written'}\n`);
  process.exitCode = differ ? 1 : 0;
}

module.exports = { buildVectors, serialize };

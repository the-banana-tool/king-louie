// `king-louie-service pair https://mcp.<domain>` (fleet stage 4 §3.11, node
// side): prove the pairing code with a signed kl.node.pair, check the front
// door's signed answer and its fingerprint, wait for the owner, then pin the
// front door in <configDir>/front-door.json. Nothing is written unless the
// owner approved.
//
// Everything typed or passed in (the URL, the code, the fingerprint) and
// everything the front door answers is untrusted: each is checked before it
// is used, and the code is never printed or logged.
const fs = require('fs');
const https = require('https');
const tls = require('tls');
const { buildNodePair, nodeFingerprint, normalizePairingCode, isDnsName } = require('../../frontdoor/protocol/messages');
const { verifyPairAccept } = require('../../frontdoor/protocol/checks');
const { validatePin, writePin } = require('../../fleet/front-door-pin');
const { WORDLIST } = require('../../mesh/mesh-pairing');
const { open } = require('../../approvals/envelope');
const { readLine, printable } = require('./io');

const POLL_MS = 7000; // /pair/v1 allows 10 requests a minute per IP
const WAIT_MS = 10 * 60 * 1000;
const MAX_RETRY_AFTER_S = 60;
// A pairing answer is a small JSON object; anything larger is refused
// before it is parsed.
const MAX_RESPONSE_BYTES = 64 * 1024;
// Six words of at most 8 letters and their spaces; generous for typing slop.
const MAX_CODE_CHARS = 256;
const CODE_WORDS = 6;
const WORDS = new Set(WORDLIST);
const REFUSALS = {
  code_rejected: 'pairing code rejected',
  expired: 'pairing code expired',
  too_many_attempts: 'too many attempts',
  key_enrolled_as_other_name: 'this node is already enrolled on the front door under another name; remove it there first'
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const groups = (text) => String(text || '').toLowerCase().replace(/^kl-/, '').replace(/\s+/g, '');

// The pairing code as both ends hash it, or null when it is not six words
// from the word list.
function pairingCode(text) {
  if (typeof text !== 'string' || text.length > MAX_CODE_CHARS) return null;
  const code = normalizePairingCode(text);
  const words = code.split(' ');
  return words.length === CODE_WORDS && words.every((w) => WORDS.has(w)) ? code : null;
}

// The front door's URL, or why it is refused: https://mcp.<domain>[:port]
// and nothing else (no user info, path, query or fragment).
function frontDoorTarget(target) {
  const host = target.hostname.toLowerCase();
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
    || (target.pathname !== '/' && target.pathname !== '') || !host.startsWith('mcp.') || !isDnsName(host) || !isDnsName(host.slice(4))) {
    return null;
  }
  return { host, domain: host.slice(4) };
}

function httpsJson(url, { method = 'GET', body = null, ca = null, lookup = null, timeoutMs = 15000 } = {}) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method, agent: false, timeout: timeoutMs,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      ...(ca ? { ca } : {}), ...(lookup ? { lookup } : {})
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`the answer is larger than ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// stdin up to `max` characters; more than that is not a pairing code.
async function readAll(stdin, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function pairWithFrontDoor({ target, configDir, nodeCfg, identity, io, flags = {}, deps = {} }) {
  io.stdout.write(`Node Name: ${nodeCfg.name}\n`);
  io.stdout.write(`Node ID: ${identity.nodeId}\n`);
  io.stdout.write(`Node fingerprint: ${nodeFingerprint(identity.nodeId)}\n`);
  const where = frontDoorTarget(target);
  if (!where) {
    io.stderr.write(`A front door is reached at https://mcp.<domain>, not ${printable(target.origin)}. Nothing was sent.\n`);
    return 2;
  }
  const { host, domain } = where;
  try {
    fs.accessSync(configDir, fs.constants.W_OK);
  } catch {
    io.stderr.write(`${configDir} is not writable: run pair as an administrator. Nothing was sent.\n`);
    return 1;
  }
  let ca = deps.ca || null;
  if (flags.caFile) {
    try {
      ca = [...tls.rootCertificates, fs.readFileSync(flags.caFile, 'utf8')];
    } catch (err) {
      io.stderr.write(`Cannot read --ca-file ${printable(flags.caFile)}: ${err.message}\n`);
      return 2;
    }
  }
  const lookup = deps.lookup || null;

  let typed = flags.code;
  if (typed !== undefined && io.stdin && io.stdin.isTTY) {
    io.stderr.write('Warning: a code given with --code is visible in ps and your shell history; leave it out to type it at the prompt.\n');
  }
  if (typed === undefined) {
    if (io.stdin && io.stdin.isTTY) {
      io.stdout.write('Pairing code (from the phone app, or `frontdoor code` on the front door): ');
      typed = await readLine(io.stdin);
    } else {
      typed = await readAll(io.stdin, MAX_CODE_CHARS);
    }
  }
  if (typed !== null && String(typed || '').trim() === '') {
    io.stderr.write('No pairing code. Get one in the phone app (Nodes) or with `king-louie-service frontdoor code <node-name>` on the front door.\n');
    return 2;
  }
  const code = pairingCode(typed === null ? null : String(typed));
  if (!code) {
    io.stderr.write(`That is not a pairing code: a code is ${CODE_WORDS} words from the pairing word list. Nothing was sent.\n`);
    return 2;
  }

  const envelope = buildNodePair({ identity, frontdoorHost: host, code, profile: nodeCfg.profile, capabilities: nodeCfg.capabilities || [], tlsCertPem: identity.tlsCert });
  const nonce = open(envelope).message.nonce;
  let res;
  try {
    res = await httpsJson(`${target.origin}/pair/v1`, { method: 'POST', body: envelope, ca, lookup });
  } catch (err) {
    io.stderr.write(`Could not reach ${target.origin}: ${err.message}. Nothing was written.\n`);
    return 1;
  }
  if (res.status !== 200) {
    const reason = res.json && typeof res.json.error === 'string' ? res.json.error : null;
    io.stderr.write(`Pairing failed: ${Object.hasOwn(REFUSALS, reason || '') ? REFUSALS[reason] : printable(reason || `HTTP ${res.status}`).slice(0, 64)}. Nothing was written.\n`);
    return 1;
  }
  const accept = verifyPairAccept(res.json, { nodeId: identity.nodeId, nonce });
  if (!accept.ok) {
    io.stderr.write(`Pairing failed: the front door's answer does not verify (${accept.reason}). Nothing was written.\n`);
    return 1;
  }
  const m = accept.message;
  // The pin is checked now, before anyone is asked or waited on: a mesh URL
  // or fingerprint the pin refuses would only fail after the owner approved.
  const pinFor = () => ({
    v: 1,
    frontdoor_id: accept.frontdoorId,
    frontdoor_public_key: m.frontdoor_public_key,
    domain,
    mesh_url: m.mesh_url,
    mesh_cert_fingerprint: m.mesh_cert_fingerprint,
    paired_at: new Date().toISOString()
  });
  try {
    validatePin(pinFor());
  } catch (err) {
    io.stderr.write(`Pairing failed: the front door's answer cannot be pinned (${err.message}). Nothing was written.\n`);
    return 1;
  }
  const shown = nodeFingerprint(accept.frontdoorId);
  io.stdout.write(`Front door fingerprint: ${shown}  (compare with the phone app)\n`);
  let confirmed;
  if (flags.yesFingerprint !== undefined) {
    confirmed = groups(flags.yesFingerprint) === groups(shown);
  } else if (io.stdin && io.stdin.isTTY) {
    io.stdout.write('Does the phone app show the same? [y/N] ');
    confirmed = /^y(es)?$/i.test(String((await readLine(io.stdin)) || '').trim());
  } else {
    io.stderr.write('Not a terminal: pass --yes-fingerprint "<the groups the phone app shows>" to confirm. Nothing was written.\n');
    return 2;
  }
  if (!confirmed) {
    io.stdout.write('Not paired. Nothing was written.\n');
    return 1;
  }

  io.stdout.write('Waiting for the owner to approve this node (up to 10 minutes)...\n');
  const pollMs = deps.pollMs || POLL_MS;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      io.stderr.write('Nobody approved this node within 10 minutes. Nothing was written.\n');
      return 1;
    }
    let status;
    try {
      status = await httpsJson(`${target.origin}/pair/v1/${m.pairing_id}`, { ca, lookup });
    } catch {
      status = null;
    }
    const state = status && status.status === 200 && status.json ? status.json.state : null;
    if (state === 'enrolled') break;
    if (state === 'denied') {
      io.stderr.write('The owner denied this node. Nothing was written.\n');
      return 1;
    }
    if (state === 'expired') {
      io.stderr.write('The pairing expired before anyone approved it. Nothing was written.\n');
      return 1;
    }
    if (status && status.status === 404) {
      io.stderr.write('The front door no longer knows this pairing. Nothing was written; pair again with a new code.\n');
      return 1;
    }
    const retry = status && status.status === 429 && status.json ? Number(status.json.retry_after) : NaN;
    const wait = Number.isFinite(retry) && retry > 0 ? Math.min(retry, MAX_RETRY_AFTER_S) * 1000 : pollMs;
    await sleep(Math.min(wait, Math.max(0, deadline - Date.now()) + 1));
  }

  try {
    writePin(configDir, pinFor());
  } catch (err) {
    io.stderr.write(`The front door approved this node, but its pin was refused: ${err.message}\n`);
    return 1;
  }
  io.stdout.write(`Paired ${nodeCfg.name} (${identity.nodeId}) with front door ${accept.frontdoorId}. Start the service: it links to ${m.mesh_url}.\n`);
  if (nodeCfg.approvers && nodeCfg.approvers.relay) io.stdout.write('approvers.relay in node.yaml is superseded by front-door.json; remove it.\n');
  return 0;
}

module.exports = { pairWithFrontDoor, pairingCode, frontDoorTarget, REFUSALS };

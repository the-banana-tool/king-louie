// tests/vectors/approval-v1/phone-reference.js
//
// The phone-side rules of docs/protocol/approval-v1.md written in JavaScript:
// whether a request may be shown (node pin and signature) and exactly what the
// approval screen displays. generate.js uses it to write the expectations of
// the phone vectors; the iOS and Android apps implement the same rules and
// must produce the same `display`.
const { open, verifyEd25519, EnvelopeError } = require('../../../src/approvals/envelope');
const { validateMessage } = require('../../../src/approvals/messages');
const { canonicalize } = require('../../../src/platform/jcs');

const COMMAND_KEYS = new Set(['command', 'script', 'argv']);
const COLLAPSE_OVER = 2000;
const HEAD = 1200;
const TAIL = 400;
const OPEN_MARK = String.fromCodePoint(0x2039);
const CLOSE_MARK = String.fromCodePoint(0x203a);

// C0, DEL and C1 controls, zero-width and directional marks, bidi embeddings
// and isolates, and the BOM are shown as ‹U+XXXX› so nothing can hide or
// reorder text on the approval screen.
function isHidden(cp) {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;
}

function escapeText(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    out += isHidden(cp) ? `${OPEN_MARK}U+${cp.toString(16).toUpperCase().padStart(4, '0')}${CLOSE_MARK}` : ch;
  }
  return out;
}

function stringItem(path, value, commandLike) {
  const chars = Array.from(value);
  if (commandLike && chars.length > COLLAPSE_OVER) {
    return {
      path,
      text: escapeText(chars.slice(0, HEAD).join('')),
      tail: escapeText(chars.slice(chars.length - TAIL).join('')),
      hidden: chars.length - HEAD - TAIL
    };
  }
  return { path, text: escapeText(value), tail: null, hidden: 0 };
}

function flatten(value, path, commandLike, out) {
  if (typeof value === 'string') {
    out.push(stringItem(path, value, commandLike));
  } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    // Numbers as their JSON text: the payload is JCS, so this is the lexeme sent.
    out.push({ path, text: JSON.stringify(value), tail: null, hidden: 0 });
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push({ path, text: '[]', tail: null, hidden: 0 });
    else if (commandLike && value.every((v) => typeof v === 'string')) out.push(stringItem(path, value.join(' '), true));
    else value.forEach((v, i) => flatten(v, `${path}[${i}]`, commandLike, out));
  } else {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) out.push({ path, text: '{}', tail: null, hidden: 0 });
    for (const k of keys) flatten(value[k], `${path}.${k}`, commandLike || COMMAND_KEYS.has(k), out);
  }
}

function buildDisplay(message) {
  const { action } = message;
  const items = [];
  flatten(action.params, 'params', false, items);
  if (Array.isArray(action.steps)) {
    action.steps.forEach((step, i) => {
      if (Array.isArray(step)) items.push(stringItem(`steps[${i}]`, step.join(' '), true));
      else items.push({ path: `steps[${i}]`, text: escapeText(canonicalize(step)), tail: null, hidden: 0 });
    });
  }
  const origin = {};
  for (const k of Object.keys(message.origin).sort()) origin[k] = message.origin[k] === null ? null : escapeText(message.origin[k]);
  return {
    node: { id: message.node_id, name: escapeText(message.node_name) },
    kind: action.kind,
    name: escapeText(action.name),
    summary: escapeText(action.summary),
    cwd: action.cwd === undefined || action.cwd === null ? null : escapeText(action.cwd),
    origin,
    items
  };
}

// pinned: [{ id, key }] from pairing and invite QR codes only.
function phoneView(envelope, pinned) {
  const hide = (reason) => ({ shown: false, reason, display: null });
  let message;
  try {
    ({ message } = open(envelope));
  } catch (err) {
    if (err instanceof EnvelopeError) return hide('malformed');
    throw err;
  }
  if (validateMessage('kl.approval.request', message)) return hide('malformed');
  const pin = pinned.find((n) => n.id === message.node_id);
  if (!pin || envelope.kid !== message.node_id) return hide('unpinned_node');
  if (!verifyEd25519(envelope, pin.key)) return hide('bad_node_signature');
  return { shown: true, reason: null, display: buildDisplay(message) };
}

module.exports = { phoneView, buildDisplay, escapeText, isHidden, COLLAPSE_OVER, HEAD, TAIL };

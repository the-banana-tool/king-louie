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
// A key that needs bracket-quoting to stay unambiguous in a display path.
const KEY_NEEDS_QUOTING = /["[\].]/;

// The EXACT code-point ranges docs/protocol/approval-v1.md §5 lists, not a
// live Unicode-property lookup (those drift across platform Unicode
// versions; nodes, iOS and Android must all draw from the same frozen list):
// Cc (C0, DEL, C1), Zl/Zp (U+2028-2029), Bidi_Control, and
// Default_Ignorable_Code_Point as of Unicode 15.1.
function isHidden(cp) {
  return (
    cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) // Cc
  ) || (
    cp === 0x2028 || cp === 0x2029 // Zl, Zp
  ) || (
    cp === 0x061c || (cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) // Bidi_Control
  ) || (
    cp === 0x00ad || cp === 0x034f || (cp >= 0x115f && cp <= 0x1160) || (cp >= 0x17b4 && cp <= 0x17b5)
    || (cp >= 0x180b && cp <= 0x180f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x206f)
    || cp === 0x3164 || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || cp === 0xffa0
    || (cp >= 0xfff0 && cp <= 0xfff8) || (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a)
    || (cp >= 0xe0000 && cp <= 0xe0fff) // Default_Ignorable_Code_Point (Unicode 15.1)
  );
}

function escapeText(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    out += isHidden(cp) ? `${OPEN_MARK}U+${cp.toString(16).toUpperCase().padStart(4, '0')}${CLOSE_MARK}` : ch;
  }
  return out;
}

// Whether the raw (unescaped) key must be shown as a bracket-quoted segment
// (`["…"]`) instead of a dot segment (`.…`): it contains a character that
// would itself look like path syntax ('.', '[', ']', '"'), or a hidden
// character that could otherwise sit invisibly inside what looks like an
// ordinary dotted path. escapeText already turns any hidden character into
// visible ‹U+XXXX› text; quoting on top of that keeps two different
// structures (an object key "a.b" vs. nested a → b) from ever producing the
// same path string.
function keyNeedsQuoting(key) {
  if (KEY_NEEDS_QUOTING.test(key)) return true;
  for (const ch of key) if (isHidden(ch.codePointAt(0))) return true;
  return false;
}

// Escapes hidden characters, then backslash-escapes '\' and '"' so the
// bracket-quoted form is unambiguous even when the raw key itself contained
// a literal quote.
function quotedKey(key) {
  return escapeText(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pathSegment(parentPath, key) {
  return keyNeedsQuoting(key) ? `${parentPath}["${quotedKey(key)}"]` : `${parentPath}.${escapeText(key)}`;
}

// Quotes an argv item that would otherwise be unreadable or ambiguous when
// several items are joined with plain spaces: empty, or containing
// whitespace or a quote character. Only '"' inside the item is escaped —
// this is a display convenience, not a shell-quoting implementation, and the
// unquoted items around it are never reinterpreted as shell syntax.
function quoteArgvItem(item) {
  if (item !== '' && !/[\s"]/.test(item)) return item;
  return `"${item.replace(/"/g, '\\"')}"`;
}

function joinArgv(items) {
  return items.map(quoteArgvItem).join(' ');
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
    else if (commandLike && value.every((v) => typeof v === 'string')) out.push(stringItem(path, joinArgv(value), true));
    else value.forEach((v, i) => flatten(v, `${path}[${i}]`, commandLike, out));
  } else {
    // Object.keys().sort() compares UTF-16 code units — the same order JCS
    // uses — so an astral key never sorts where its code-point value would
    // put it.
    const keys = Object.keys(value).sort();
    if (keys.length === 0) out.push({ path, text: '{}', tail: null, hidden: 0 });
    for (const k of keys) flatten(value[k], pathSegment(path, k), commandLike || COMMAND_KEYS.has(k), out);
  }
}

function buildDisplay(message) {
  const { action } = message;
  const items = [];
  flatten(action.params, 'params', false, items);
  if (Array.isArray(action.steps)) {
    action.steps.forEach((step, i) => {
      if (Array.isArray(step)) items.push(stringItem(`steps[${i}]`, joinArgv(step), true));
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
  // Shape first: whether the message is even a well-formed kl.approval.request
  // is checked before anything about pinning or signatures, so a malformed
  // message is always refused for that reason, never mistaken for (or used to
  // probe) a pinning or signature outcome.
  if (validateMessage('kl.approval.request', message)) return hide('malformed');
  const pin = pinned.find((n) => n.id === message.node_id);
  if (!pin || envelope.kid !== message.node_id) return hide('unpinned_node');
  if (!verifyEd25519(envelope, pin.key)) return hide('bad_node_signature');
  return { shown: true, reason: null, display: buildDisplay(message) };
}

module.exports = { phoneView, buildDisplay, escapeText, isHidden, joinArgv, pathSegment, COLLAPSE_OVER, HEAD, TAIL };

// What a phone card holds in place of a value it must not carry (remote window plan
// R-RW-30). A card is sealed, but it still reaches the phone's screen and the audit
// envelope, and a stored value has no business on either. The mark is keyed with a
// random key used once and then dropped: such a value can be short, and a plain hash
// of a short value is that value to anyone with a dictionary. It is the card's
// statement that bytes it does not show are what runs; nothing verifies it later.
const crypto = require('crypto');
const { canonicalize } = require('../platform/jcs');

function hiddenMark(text) {
  return {
    args_sha256: crypto.createHmac('sha256', crypto.randomBytes(32)).update(text).digest('base64url'),
    bytes: Buffer.byteLength(text)
  };
}

// A tool's parameters as a phone card shows them. The tool still runs with its own:
// the executor keeps those, and the card is the approver's alone.
function toolCardParams(toolName, parameters) {
  if (toolName !== 'Vault' || !parameters || typeof parameters !== 'object') return parameters;
  let text;
  try {
    text = canonicalize(parameters);
  } catch {
    return parameters; // the approver refuses what has no canonical form
  }
  return { action: parameters.action ?? null, key: parameters.key ?? null, ...hiddenMark(text) };
}

module.exports = { hiddenMark, toolCardParams };

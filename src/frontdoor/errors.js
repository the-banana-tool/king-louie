// A coded Error for the frontdoor stores' input refusals: `err('bad_node', …)`
// gives callers a stable `.code` to assert on instead of parsing message text.
function err(code, message) {
  return Object.assign(new Error(message || code), { code });
}

module.exports = { err };

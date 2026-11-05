// The OAuth scope of the remote window (R-RW-10). It takes `;machines=` like any
// other and is advertised only when frontdoor.oauth.scopes_enabled lists it.
// `attach_window` is not a routed tool: it names what the scope allows for
// `allows()`, here and in the splice.
const WINDOW_SCOPE = 'window:attach';
const WINDOW_TOOL = 'attach_window';
// Shown on the consent page and carried in the phone's view of a window's request.
const WINDOW_SCOPE_TEXT = 'A King Louie window may attach to every node this grant covers, and each node still needs its own phone approval.';

function registerWindowScope(scopeRegistry) {
  scopeRegistry.register(WINDOW_SCOPE, { tools: [WINDOW_TOOL], description: WINDOW_SCOPE_TEXT });
}

module.exports = { registerWindowScope, WINDOW_SCOPE, WINDOW_TOOL, WINDOW_SCOPE_TEXT };

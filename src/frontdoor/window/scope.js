// The OAuth scope of the remote window (R-RW-10). It takes `;machines=` like any
// other and is advertised only when frontdoor.oauth.scopes_enabled lists it.
// `attach_window` is not a routed tool: it names what the scope allows for
// `allows()`, here and in the splice.
const WINDOW_SCOPE = 'window:attach';
const WINDOW_TOOL = 'attach_window';

function registerWindowScope(scopeRegistry) {
  scopeRegistry.register(WINDOW_SCOPE, { tools: [WINDOW_TOOL], description: 'Attach a King Louie window to a machine' });
}

module.exports = { registerWindowScope, WINDOW_SCOPE, WINDOW_TOOL };

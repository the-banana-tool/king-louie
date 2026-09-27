// Front-door tool extensions (program §4.19): one line per consumer stage.
// Each entry is ({ scopeRegistry, router }) => void and registers scopes
// (scopeRegistry.register) and routed tools (router.registerTool). They run
// before frontdoor.oauth.scopes_enabled is checked against the registered
// scopes. C7 adds registerFrontDoorCaseTools here.
module.exports = [];

// Front-door tool extensions (program §4.19): one line per consumer stage.
// Each entry is ({ scopeRegistry, router }) => void and registers scopes
// (scopeRegistry.register) and routed tools (router.registerTool). They run
// before frontdoor.oauth.scopes_enabled is checked against the registered
// scopes.
module.exports = [];

// Cases stage 7 (spec §3.8): cases:read and the read-only case tools.
module.exports.push(require('../cases/mcp-tool-definitions').registerFrontDoorCaseTools);

// src/tools/builtin/management-tools.js
// The management tools in King Louie's own chat (management surfaces spec
// §3.1): the case tools MCP clients get, under the same names, served by the
// same handler (src/mcp/case-tools.js) on the in-app channel. Always loaded,
// in every chat, case chat or not; never in a wake-up turn, whose
// allowedToolNames name only the case tools and WAKEUP_BASE_TOOLS.
//
// The handler comes from the executor's extraToolOptions (`caseManagement`,
// built once per core). Only the read tools are here for now; the spoken
// ones join with the owner's quote (part 1, Task 2).
const { Tool } = require('../tool-schema');
const { CASE_MCP_TOOLS } = require('../../cases/mcp-tool-definitions');

const UNAVAILABLE = 'Cases are not available here.';

// The chat's copy of an MCP input schema: the keywords every provider
// accepts (Gemini refuses additionalProperties and the string limits). The
// handler still checks the full MCP schema, unknown keys included.
function chatSchema(schema) {
  const properties = {};
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    properties[key] = { type: rule.type, ...(rule.description ? { description: rule.description } : {}), ...(rule.enum ? { enum: [...rule.enum] } : {}) };
  }
  return { type: 'object', properties, ...(schema.required && schema.required.length ? { required: [...schema.required] } : {}) };
}

function managementTool(def) {
  return new Tool({
    name: def.name,
    description: def.description,
    parameters: chatSchema(def.inputSchema),
    requiresApproval: false,
    concurrencySafe: true,
    execute: async (params, context) => {
      const handler = context && context.caseManagement;
      if (!handler || !handler.available()) return { ok: false, error: UNAVAILABLE };
      try {
        return { ok: true, result: await handler.call(def.name, params || {}) };
      } catch (err) {
        // The handler's refusals are fixed sentences; anything else it
        // already turned into `internal`.
        if (err && err.isCaseToolError) return { ok: false, error: err.message, code: err.code };
        throw err;
      }
    }
  });
}

const MANAGEMENT_TOOLS = Object.freeze(CASE_MCP_TOOLS.filter((t) => t.tier === 'read').map(managementTool));
const MANAGEMENT_TOOL_NAMES = Object.freeze(MANAGEMENT_TOOLS.map((t) => t.name));

function registerManagementTools(registry) {
  for (const tool of MANAGEMENT_TOOLS) registry.register(tool);
}

module.exports = { registerManagementTools, MANAGEMENT_TOOLS, MANAGEMENT_TOOL_NAMES, chatSchema, UNAVAILABLE };

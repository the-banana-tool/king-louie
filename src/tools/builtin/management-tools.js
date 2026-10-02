// src/tools/builtin/management-tools.js
// The management tools in King Louie's own chat (management surfaces spec
// §3.1): the case tools MCP clients get, under the same names, served by the
// same handler (src/mcp/case-tools.js) on the in-app-chat channel (not
// 'in-app', which is the card's button press). Always loaded,
// in every chat, case chat or not; never in a wake-up turn, whose
// allowedToolNames name only the case tools and WAKEUP_BASE_TOOLS. In a case
// chat the tools that act on a case act on that chat's case alone (owner
// decision Q27, 2026-10-01; the handler's CASE_SCOPED_TOOLS).
//
// The handler comes from the executor's extraToolOptions (`caseManagement`,
// built once per core). answer_question checks its quote against the
// owner's own message for this turn, `ownerTurnText` in the execute context,
// which ToolExecutor sets from its own field only (never from a parameter):
// a turn with no owner message (a wake-up, a channel, a child run) cannot
// answer.
const { Tool } = require('../tool-schema');
const { CASE_MCP_TOOLS } = require('../../cases/mcp-tool-definitions');

const UNAVAILABLE = 'Cases are not available here.';
const DELEGATE_REFUSED = 'A delegate session reaches the cases through its own client, not through these tools.';

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
    concurrencySafe: def.tier === 'read',
    execute: async (params, context) => {
      const handler = context && context.caseManagement;
      if (!handler || !handler.available()) return { ok: false, error: UNAVAILABLE };
      // A delegate turn's run origin names its job; it (and its children)
      // never act on the cases as the owner's chat. Delegate turns do not
      // get these tools at all (DELEGATE_EXCLUDED_TOOLS); this is the
      // second line should one ever reach them.
      if (context.origin && context.origin.job_id) return { ok: false, error: DELEGATE_REFUSED };
      // In a case chat (or a child run guarded for a case) the case-scoped
      // tools act on that case alone (owner decision Q27): the scope is the
      // host's case context, never a parameter. One without a case id fails
      // closed.
      const scoped = context.caseContext || context.guardContext || null;
      const caseScope = scoped ? (typeof scoped.caseId === 'string' && scoped.caseId ? scoped.caseId : false) : null;
      if (caseScope === false) return { ok: false, error: UNAVAILABLE };
      try {
        const ownerTurnText = typeof context.ownerTurnText === 'string' ? context.ownerTurnText : null;
        return { ok: true, result: await handler.call(def.name, params || {}, { ownerTurnText, caseScope }) };
      } catch (err) {
        // The handler's refusals are fixed sentences; anything else it
        // already turned into `internal`.
        if (err && err.isCaseToolError) {
          const data = err.data && typeof err.data === 'object' && Object.keys(err.data).length ? { data: err.data } : {};
          return { ok: false, error: err.message, code: err.code, ...data };
        }
        throw err;
      }
    }
  });
}

const MANAGEMENT_TOOLS = Object.freeze(CASE_MCP_TOOLS.map(managementTool));
const MANAGEMENT_TOOL_NAMES = Object.freeze(MANAGEMENT_TOOLS.map((t) => t.name));

function registerManagementTools(registry) {
  for (const tool of MANAGEMENT_TOOLS) registry.register(tool);
}

module.exports = { registerManagementTools, MANAGEMENT_TOOLS, MANAGEMENT_TOOL_NAMES, chatSchema, UNAVAILABLE, DELEGATE_REFUSED };

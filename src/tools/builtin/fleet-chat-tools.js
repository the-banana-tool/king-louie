// src/tools/builtin/fleet-chat-tools.js
// The fleet tools in a chat that runs in the King Louie service (management
// surfaces spec §3.6): the tools MCP clients get (src/fleet/tool-definitions.js),
// under the same names, served by the service's own FleetToolHandler.
//
// Present only while the core has a fleet handler: startFleetNode hands its
// handler to core.context.setFleetToolHandler, which registers these tools,
// and takes it back on stop. A standalone desktop never registers them.
// Absent from wake-up turns (their allowedToolNames name only the case
// tools and WAKEUP_BASE_TOOLS) and from delegate turns
// (DELEGATE_EXCLUDED_TOOLS: a delegate's client reaches the fleet through
// its own scopes, never through the node's chat).
//
// The origin is built here from the executor's context, never from the
// tool's parameters: kind SERVICE_CHAT_ORIGIN_KIND, which shouldRefuseUnsafe
// treats like stdio (a session the node started itself). An unsafe runbook
// still waits for a signed phone approval; the usual tool approval comes
// first (the acting tools require approval).
const { Tool } = require('../tool-schema');
const { MCP_TOOLS, ToolError } = require('../../fleet/tool-definitions');
const { chatSchema } = require('./management-tools');

const SERVICE_CHAT_ORIGIN_KIND = 'service-chat';
const FLEET_READ_TOOLS = Object.freeze(['list_machines', 'describe_machine', 'get_state', 'get_job', 'get_job_logs']);
const UNAVAILABLE = 'The fleet is not available here: only a chat that runs in the King Louie service reaches it.';
const DELEGATE_REFUSED = 'A delegate session reaches the fleet through its own client, not through these tools.';

function serviceChatOrigin(session) {
  return Object.freeze({
    kind: SERVICE_CHAT_ORIGIN_KIND,
    client: 'king-louie',
    session: typeof session === 'string' && session ? session : null
  });
}

// Gemini refuses a nested object schema with no properties, and the tools
// are always loaded, so one such property would break every turn there.
// run_runbook's free-form `params` is taken as a JSON object in a string
// instead, and decoded before the handler sees it.
function fleetChatSchema(inputSchema) {
  const schema = chatSchema(inputSchema);
  const jsonKeys = [];
  for (const [key, rule] of Object.entries(schema.properties)) {
    const source = inputSchema.properties[key];
    if (rule.type === 'object' && !(source.properties && Object.keys(source.properties).length)) {
      schema.properties[key] = { type: 'string', description: `A JSON object, as text${rule.description ? `: ${rule.description}` : ''}.` };
      jsonKeys.push(key);
    }
  }
  return { schema, jsonKeys };
}

function decodeJsonKeys(params, jsonKeys) {
  const out = { ...params };
  for (const key of jsonKeys) {
    if (out[key] === undefined || out[key] === null) continue;
    let value;
    try {
      value = JSON.parse(out[key]);
    } catch {
      value = undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ToolError('invalid_params', `invalid_params: "${key}" must be a JSON object`);
    }
    out[key] = value;
  }
  return out;
}

function fleetChatTool(def) {
  const read = FLEET_READ_TOOLS.includes(def.name);
  const { schema, jsonKeys } = fleetChatSchema(def.inputSchema);
  return new Tool({
    name: def.name,
    description: def.description,
    parameters: schema,
    requiresApproval: !read,
    concurrencySafe: read,
    execute: async (params, context) => {
      const fleet = context && context.fleetChat;
      if (!fleet || !fleet.handler) return { ok: false, error: UNAVAILABLE };
      // A delegate turn's run origin names its job; it (and its children)
      // never act on the fleet as the node's own chat.
      if (context.origin && context.origin.job_id) return { ok: false, error: DELEGATE_REFUSED };
      try {
        const args = decodeJsonKeys(params || {}, jsonKeys);
        return { ok: true, result: await fleet.handler.call(def.name, args, { origin: serviceChatOrigin(fleet.session) }) };
      } catch (err) {
        if (err instanceof ToolError) {
          const data = err.data && typeof err.data === 'object' && Object.keys(err.data).length ? { data: err.data } : {};
          return { ok: false, error: err.message, code: err.code, ...data };
        }
        throw err;
      }
    }
  });
}

const FLEET_CHAT_TOOLS = Object.freeze(MCP_TOOLS.map(fleetChatTool));
const FLEET_CHAT_TOOL_NAMES = Object.freeze(FLEET_CHAT_TOOLS.map((t) => t.name));

function registerFleetChatTools(registry) {
  for (const tool of FLEET_CHAT_TOOLS) registry.register(tool);
}

// Only this module's own Tool objects are removed, so a same-named tool
// someone else registered stays.
function unregisterFleetChatTools(registry) {
  for (const tool of FLEET_CHAT_TOOLS) {
    if (registry.get(tool.name) === tool) registry.unregister(tool.name);
  }
}

module.exports = {
  registerFleetChatTools,
  unregisterFleetChatTools,
  serviceChatOrigin,
  FLEET_CHAT_TOOLS,
  FLEET_CHAT_TOOL_NAMES,
  FLEET_READ_TOOLS,
  SERVICE_CHAT_ORIGIN_KIND,
  UNAVAILABLE,
  DELEGATE_REFUSED
};

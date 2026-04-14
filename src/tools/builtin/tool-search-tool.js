const { Tool } = require('../tool-schema');

/**
 * ToolSearch — deferred tool loading meta-tool.
 *
 * Instead of sending all tool schemas on every turn (which bloats the prompt
 * and prevents prompt caching), most tools are "deferred" — the LLM knows
 * their names but not their schemas. When it needs a deferred tool, it calls
 * ToolSearch to load the full schema and make it available.
 *
 * Supports three query modes:
 *  - "select:Read,Edit,Grep" — fetch exact tools by name
 *  - keyword search — fuzzy match against tool names and descriptions
 *  - "+prefix keyword" — require prefix in tool name, rank by keyword
 *
 * The actual tool injection is handled by the agent loop — it reads
 * _injectedTools from the result and merges them into the active set.
 */
const ToolSearchTool = new Tool({
  name: 'ToolSearch',
  description:
    'Search for and load tool schemas that are not currently available. ' +
    'Deferred tools appear by name in the system prompt but cannot be called ' +
    'until their schemas are loaded via this tool.\n\n' +
    'Query forms:\n' +
    '- "select:Read,Edit,Grep" — fetch these exact tools by name\n' +
    '- "notebook jupyter" — keyword search, returns best matches\n' +
    '- "+browser click" — require "browser" in tool name, rank by remaining terms',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Use "select:<name>,<name>" for exact tools, or keywords to search.'
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)'
      }
    },
    required: ['query']
  },
  execute: async (params, options = {}) => {
    const query = String(params.query || '').trim();
    const maxResults = Math.min(Math.max(Number(params.max_results) || 5, 1), 20);
    const contextAssembler = options.contextAssembler;

    if (!contextAssembler) {
      return {
        ok: false,
        error: 'Tool registry not available. All tools should already be loaded.'
      };
    }

    // Per-chat filter: exclude MCP tools from servers disabled for this chat.
    const disabledMcpServers = Array.isArray(options.disabledMcpServers) ? options.disabledMcpServers : [];
    const isDisabled = (toolName) => {
      if (!toolName || !toolName.startsWith('mcp__')) return false;
      const server = toolName.slice('mcp__'.length).split('__')[0];
      return disabledMcpServers.includes(server);
    };

    let matchedTools = [];

    if (query.startsWith('select:')) {
      // Exact selection mode: "select:Read,Edit,Grep"
      const names = query.slice(7).split(',').map(n => n.trim()).filter(Boolean);
      matchedTools = contextAssembler.getToolsByName(names).filter((t) => !isDisabled(t.name));
    } else {
      // Keyword search mode
      let requiredPrefix = null;
      let keywords = query.toLowerCase();

      // "+prefix keyword" mode
      if (query.startsWith('+')) {
        const parts = query.slice(1).split(/\s+/);
        requiredPrefix = parts[0]?.toLowerCase();
        keywords = parts.slice(1).join(' ').toLowerCase();
      }

      const allTools = (contextAssembler.getAllDeferredTools ? contextAssembler.getAllDeferredTools() : [])
        .filter((t) => !isDisabled(t.name));
      const scored = [];

      for (const tool of allTools) {
        const name = (tool.name || '').toLowerCase();
        const desc = (tool.description || '').toLowerCase();

        if (requiredPrefix && !name.includes(requiredPrefix)) continue;

        let score = 0;
        const queryWords = keywords.split(/\s+/).filter(Boolean);

        for (const word of queryWords) {
          if (name.includes(word)) score += 3;
          if (name === word) score += 5;
          if (desc.includes(word)) score += 1;
        }

        // Boost exact name matches
        if (name === query.toLowerCase()) score += 10;

        if (score > 0 || queryWords.length === 0) {
          scored.push({ tool, score: score || 0.1 });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      matchedTools = scored.slice(0, maxResults).map(s => s.tool);
    }

    const foundNames = matchedTools.map(t => t.name);

    if (matchedTools.length === 0) {
      // List available deferred tools to help the LLM
      const deferred = (contextAssembler.getAllDeferredTools ? contextAssembler.getAllDeferredTools() : [])
        .filter((t) => !isDisabled(t.name));
      const names = deferred.map(t => t.name);
      return {
        ok: false,
        error: `No tools matched query "${query}".`,
        availableTools: names.length > 0 ? names : undefined,
        message: names.length > 0
          ? `Available deferred tools: ${names.join(', ')}`
          : 'No deferred tools available.'
      };
    }

    return {
      ok: true,
      tools: foundNames,
      message: `Loaded tool schemas: ${foundNames.join(', ')}. You can now call these tools.`,
      // The agent loop reads _injectedTools to merge into the active set
      _injectedTools: matchedTools
    };
  }
});

module.exports = ToolSearchTool;

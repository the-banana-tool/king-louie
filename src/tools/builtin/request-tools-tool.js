const { Tool } = require('../tool-schema');

/**
 * Escape-hatch tool that lets the LLM request additional tools that were
 * not included in the current turn's dynamic tool selection.
 *
 * The actual tool injection is handled by the agent loop — it reads the
 * result and merges the requested tools into the active tool set for
 * subsequent iterations.
 */
const RequestToolsTool = new Tool({
  name: 'RequestTools',
  description:
    'Request additional tools that are not currently available. ' +
    'Use this when you need a tool that was not provided in this turn. ' +
    'Pass the tool names you need and they will be made available for your next action.',
  parameters: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        description: 'Array of tool names to request (e.g. ["Browser", "Git", "WebSearch"])',
        items: { type: 'string' }
      },
      reason: {
        type: 'string',
        description: 'Brief reason why these tools are needed'
      }
    },
    required: ['tools']
  },
  execute: async (params, options = {}) => {
    const requested = Array.isArray(params.tools) ? params.tools : [];
    const contextAssembler = options.contextAssembler;

    if (!contextAssembler) {
      return {
        ok: false,
        error: 'Context assembler not available. All tools should already be loaded.'
      };
    }

    const available = contextAssembler.getToolsByName(requested);
    const foundNames = available.map(t => t.name);
    const notFound = requested.filter(n => !foundNames.includes(n));

    return {
      ok: true,
      added: foundNames,
      notFound: notFound.length > 0 ? notFound : undefined,
      message: foundNames.length > 0
        ? `Tools now available: ${foundNames.join(', ')}. You can use them in your next action.`
        : 'No matching tools found.',
      // The agent loop reads _injectedTools to merge into the active set
      _injectedTools: available
    };
  }
});

module.exports = RequestToolsTool;

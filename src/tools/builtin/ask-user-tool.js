const { Tool } = require('../tool-schema');

const askUserTool = new Tool({
  name: 'AskUser',
  description: 'Ask the user a question and wait for their response. Use when you need clarification or input.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' }
    },
    required: ['question']
  },
  requiresApproval: false,
  // This tool works differently — it emits the question to the UI and waits for a response
  // The execution is handled specially in the agent loop
  execute: async () => {
    return { ok: false, error: 'AskUser must be intercepted by the agent loop' };
  }
});

module.exports = askUserTool;

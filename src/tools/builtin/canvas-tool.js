const { Tool } = require('../tool-schema');

const CanvasTool = new Tool({
  name: 'Canvas',
  description:
    'Render HTML/SVG artifacts in a visual canvas panel. ' +
    'Use this to display charts, diagrams, interactive forms, data visualizations, ' +
    'planning boards, or any structured visual content. ' +
    'The canvas runs in a sandboxed iframe — scripts are allowed but network access is blocked. ' +
    'Include all CSS/JS inline. For interactivity, call execute_js to run code and read results.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['render', 'update', 'execute_js', 'close'],
        description:
          'render: display HTML/SVG content (opens panel). ' +
          'update: replace current content. ' +
          'execute_js: run JavaScript in the canvas and return the result. ' +
          'close: close the canvas panel.'
      },
      content: {
        type: 'string',
        description:
          'For render/update: the HTML/SVG content to display. ' +
          'For execute_js: the JavaScript code to evaluate in the canvas context.'
      },
      title: {
        type: 'string',
        description: 'Display title for the canvas panel header (optional).'
      }
    },
    required: ['action']
  },

  async execute(params, options = {}) {
    const { action, content, title } = params;

    if ((action === 'render' || action === 'update') && !content) {
      return { success: false, error: `Action '${action}' requires 'content' parameter.` };
    }

    if (action === 'execute_js' && !content) {
      return { success: false, error: "Action 'execute_js' requires 'content' parameter with JavaScript code." };
    }

    if (typeof options.canvasAction !== 'function') {
      return { success: false, error: 'Canvas is not available in this context.' };
    }

    try {
      const result = await options.canvasAction({ action, content, title });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
});

module.exports = CanvasTool;

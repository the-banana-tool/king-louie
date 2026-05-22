const { Tool } = require('../tool-schema');
const browserTool = require('./browser-tool');

/**
 * BrowserExtract — read data from the active page, drive iframes, intercept
 * network requests. Loaded only when the workflow needs to harvest content
 * or work across frames.
 *
 * Shares the singleton browser instance with BrowserSession and BrowserPage.
 */

const EXTRACT_ACTIONS = [
  'content', 'title',
  'get_text', 'get_attribute', 'get_value', 'is_visible', 'count', 'bounding_box',
  'console', 'frames',
  'fill_in_frame', 'click_in_frame', 'type_in_frame', 'evaluate_in_frame',
  'route_block', 'route_fulfill', 'unroute'
];

const browserExtractTool = new Tool({
  name: 'BrowserExtract',
  description: `Extract data from the active page, drive iframes, and intercept network requests.

Read actions: content (full HTML), title, get_text, get_attribute, get_value, is_visible, count, bounding_box.
Frame actions: list with "frames" then use *_in_frame variants targeting frame_name / frame_url / frame_index.
Network: route_block (drop matching requests), route_fulfill (mock responses), unroute.

Console: returns recent browser console output.`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: EXTRACT_ACTIONS, description: 'Extract action.' },

      // Element selectors
      selector: { type: 'string', description: 'Element selector for get_text/get_attribute/get_value/is_visible/count/bounding_box.' },
      attribute: { type: 'string', description: 'Attribute name for get_attribute.' },

      // Frame interaction
      frame_name: { type: 'string', description: 'Frame name for *_in_frame actions.' },
      frame_url: { type: 'string', description: 'Frame URL substring for *_in_frame actions.' },
      frame_index: { type: 'number', description: 'Frame index for *_in_frame actions.' },
      text: { type: 'string', description: 'Text for fill_in_frame / type_in_frame.' },
      expression: { type: 'string', description: 'JavaScript expression for evaluate_in_frame.' },

      // Network interception
      pattern: { type: 'string', description: 'URL glob pattern (e.g. "**/*.png") for route_block, route_fulfill, unroute.' },
      body: { type: 'string', description: 'Response body for route_fulfill.' },
      status: { type: 'number', description: 'HTTP status code for route_fulfill.' },
      content_type: { type: 'string', description: 'Content-Type header for route_fulfill.' },

      timeout: { type: 'number', description: 'Timeout in ms for waits inside extraction actions.' }
    },
    required: ['action']
  },
  requiresApproval: true,
  execute: async (params, context) => {
    if (!EXTRACT_ACTIONS.includes(params.action)) {
      return { ok: false, error: `BrowserExtract does not support action "${params.action}". Use BrowserSession or BrowserPage.` };
    }
    return browserTool.execute(params, context);
  }
});

module.exports = browserExtractTool;

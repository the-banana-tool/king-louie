const { Tool } = require('../tool-schema');
const { OWNER_QUOTE_PARAM } = require('../browser-acting');
const browserTool = require('./browser-tool');

/**
 * BrowserPage — the hot path. Navigation, element interaction, keyboard +
 * mouse, scrolling, screenshots, JS evaluate, and waits.
 *
 * For an automation loop driving repeated actions, this is the only tool
 * the agent typically needs after a session is established. Loading just
 * BrowserPage (without BrowserSession or BrowserExtract) keeps the
 * per-iteration tool schema small.
 */

const PAGE_ACTIONS = [
  'navigate', 'go_back', 'go_forward', 'reload',
  'click', 'dblclick', 'fill', 'type', 'press', 'clear',
  'select_option', 'check', 'uncheck', 'hover', 'focus',
  'drag_and_drop', 'set_input_files',
  'scroll', 'screenshot', 'snapshot', 'pdf', 'evaluate',
  'keyboard_type', 'keyboard_down', 'keyboard_up',
  'mouse_click', 'mouse_move', 'mouse_wheel',
  'wait_for', 'wait_for_url', 'wait_for_load_state', 'wait_for_response'
];

const browserPageTool = new Tool({
  name: 'BrowserPage',
  description: `Navigation + element interaction + waits on the active browser page. Shares one singleton with BrowserSession and BrowserExtract — start a session first.

Selector strategies (pass as "selector"):
  - CSS:         "div.class" or "#id" (default)
  - Text:        "text=Login"
  - Role:        "role=button[name='Submit']"
  - Label:       "label=Email"
  - Placeholder: "placeholder=Search..."
  - Test ID:     "testid=submit-btn"
  - XPath:       "xpath=//div[@id='app']"
  - Alt:         "alt=Company logo"
  - Title:       "title=Close dialog"
  - Ref:         "ref=e15" (from the last "snapshot" of the current page)

"snapshot" lists the page as text, one node a line with its role, name and a [ref=eN] on each element you can act on; pass "ref=eN" as the selector to click or fill exactly that element. interactive=true keeps only the lines with a ref; ref="eN" returns that node's subtree; max_chars (default 20000, at most 60000) cuts at a line end. A ref lasts until the page navigates: then take a new snapshot (ref_stale).

All element actions auto-wait for the element to be actionable. Avoid wait_for_load_state state="networkidle" on chatty sites (LinkedIn, modern dashboards) — they stream telemetry forever and you'll burn the timeout. Prefer wait_for on a specific element or wait_for_url.

"screenshot" returns the viewport as an image you see (JPEG, at most 1280 px wide) and writes no file; the result's image.scale is viewport pixels per image pixel, so multiply image coordinates by scale for mouse_click. to_file, full_page or selector save a PNG file instead (savedTo) and return no image.`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: PAGE_ACTIONS, description: 'Page action.' },
      ownerQuote: OWNER_QUOTE_PARAM,

      // Navigation
      url: { type: 'string', description: 'URL for navigate, wait_for_url.' },

      // Element selectors
      selector: { type: 'string', description: 'Element selector (CSS, text=, role=, label=, placeholder=, testid=, xpath=, alt=, title=, or ref=eN from a snapshot).' },
      target_selector: { type: 'string', description: 'Target element selector for drag_and_drop (ref=eN accepted).' },
      ref_label: browserTool.REF_LABEL_PARAM,
      target_ref_label: browserTool.TARGET_REF_LABEL_PARAM,

      // Snapshot
      interactive: { type: 'boolean', description: 'snapshot: keep only the lines with a ref.' },
      ref: { type: 'string', description: 'snapshot: return only this node (e.g. "e9") and its subtree.' },
      max_chars: { type: 'number', description: 'snapshot: cut the text at a line end past this many characters (default 20000, at most 60000).' },

      // Text input
      text: { type: 'string', description: 'Text for fill, type, keyboard_type.' },
      key: { type: 'string', description: 'Key for press, keyboard_down/up (e.g. "Enter", "Tab", "Control+a").' },

      // Select option
      value: { type: 'string', description: 'Option value for select_option.' },
      label: { type: 'string', description: 'Option label text for select_option.' },
      index: { type: 'number', description: 'Option index for select_option.' },

      // Mouse / scroll
      x: { type: 'number', description: 'X coordinate for mouse_click/mouse_move.' },
      y: { type: 'number', description: 'Y coordinate for mouse_click/mouse_move.' },
      button: { type: 'string', description: 'Mouse button: "left", "right", "middle".' },
      click_count: { type: 'number', description: 'Number of clicks (2 for double-click).' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Keyboard modifiers ["Shift","Control","Alt","Meta"].' },
      steps: { type: 'number', description: 'Steps for mouse_move interpolation.' },
      delta_x: { type: 'number', description: 'Horizontal scroll delta.' },
      delta_y: { type: 'number', description: 'Vertical scroll delta.' },

      // Files / JS
      files: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'File path(s) for set_input_files.' },
      expression: { type: 'string', description: 'JavaScript expression for evaluate.' },

      // Waits / timeouts
      state: { type: 'string', description: 'Wait state: "visible","hidden","attached","detached" (wait_for) or "load","domcontentloaded","networkidle" (wait_for_load_state).' },
      timeout: { type: 'number', description: 'Timeout in ms.' },
      delay: { type: 'number', description: 'Typing delay in ms for type (default 50).' },

      // Screenshot / PDF
      full_page: { type: 'boolean', description: 'Capture full scrollable page for screenshot (default false).' },
      to_file: { type: 'boolean', description: 'screenshot: save a PNG file (savedTo) instead of returning the image. Without it the viewport comes back as an image; multiply image coordinates by scale for mouse_click.' },
      format: { type: 'string', description: 'PDF paper format ("A4", "Letter", ...).' }
    },
    required: ['action']
  },
  requiresApproval: true,
  prepareParams: browserTool.prepareParams,
  emitsImages: true,
  execute: async (params, context) => {
    if (!PAGE_ACTIONS.includes(params.action)) {
      return { ok: false, error: `BrowserPage does not support action "${params.action}". Use BrowserSession or BrowserExtract.` };
    }
    return browserTool.execute(params, context);
  }
});

module.exports = browserPageTool;

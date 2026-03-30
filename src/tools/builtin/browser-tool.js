const { Tool } = require('../tool-schema');
const { validateUrl } = require('./web-fetch-utils');
const BrowserService = require('../../browser/browser-service');
const CdpClient = require('../../browser/cdp-client');

// Singleton instance for the tool to reuse the browser across calls
let browserService = null;
let cdpClient = null;

const browserTool = new Tool({
  name: 'Browser',
  description: 'Control a headless browser to interact with web pages. Start the browser first, then navigate and perform actions.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status', 'tabs', 'open_tab', 'close_tab', 'navigate', 'screenshot', 'pdf', 'evaluate', 'click', 'type', 'wait_for', 'console'],
        description: 'Action to perform.'
      },
      url: { type: 'string', description: 'URL to navigate to (required for navigate action)' },
      selector: { type: 'string', description: 'CSS selector for click, type, and wait_for actions' },
      text: { type: 'string', description: 'Text to type (required for type action)' },
      expression: { type: 'string', description: 'JavaScript expression to evaluate (required for evaluate action)' },
      timeout: { type: 'number', description: 'Timeout in ms for wait_for action (default 30000)' },
      targetId: { type: 'string', description: 'Target ID of the tab to close (required for close_tab action)' },
      userDataPath: { type: 'string', description: 'Path to Chrome user data directory (for start action). Use this to reuse an existing Chrome profile with saved logins/cookies.' },
      profileDirectory: { type: 'string', description: 'Chrome profile directory name e.g. "Default", "Profile 1" (for start action). Used with userDataPath to select a specific profile.' },
      headless: { type: 'boolean', description: 'Whether to run headless (default true). Set to false to see the browser window.' }
    },
    required: ['action']
  },
  requiresApproval: true,
  execute: async (params, context) => {
    const { action, url, selector, text, expression, timeout } = params;

    // Validate action first
    if (!browserTool.parameters.properties.action.enum.includes(action)) {
      return { ok: false, error: `Invalid action: ${action}` };
    }

    try {
      if (action === 'start') {
        if (browserService && browserService.process) {
          return { ok: true, message: 'Browser already running' };
        }
        const browserOptions = {};
        if (params.userDataPath) browserOptions.userDataPath = params.userDataPath;
        if (params.profileDirectory) browserOptions.profileDirectory = params.profileDirectory;
        if (params.headless !== undefined) browserOptions.headless = params.headless;
        browserService = new BrowserService(browserOptions);
        const wsUrl = await browserService.start();
        cdpClient = new CdpClient(wsUrl);
        await cdpClient.connect();
        return { ok: true, message: 'Browser started', wsUrl };
      }

      if (action === 'stop') {
        if (cdpClient) {
          cdpClient.disconnect();
          cdpClient = null;
        }
        if (browserService) {
          await browserService.stop();
          browserService = null;
        }
        return { ok: true, message: 'Browser stopped' };
      }

      if (action === 'status') {
        return {
          ok: true,
          running: !!(browserService && browserService.process),
          connected: !!(cdpClient && cdpClient.ws && cdpClient.ws.readyState === 1)
        };
      }

      // Actions below require an active browser/client
      if (!browserService || !cdpClient) {
        return { ok: false, error: 'Browser is not running. Call start first.' };
      }

      switch (action) {
        case 'navigate': {
          if (!url) return { ok: false, error: 'url parameter is required for navigate action' };
          await validateUrl(url); // SSRF protection
          const result = await cdpClient.navigate(url);
          return { ok: true, message: `Navigated to ${url}`, details: result };
        }

        case 'screenshot': {
          const data = await cdpClient.screenshot();
          return { ok: true, message: 'Screenshot captured', format: 'base64_png', data };
        }

        case 'pdf': {
          const data = await cdpClient.pdf();
          return { ok: true, message: 'PDF generated', format: 'base64_pdf', data };
        }

        case 'evaluate': {
          if (!expression) return { ok: false, error: 'expression parameter is required for evaluate action' };
          const result = await cdpClient.evaluate(expression);
          return { ok: true, result };
        }

        case 'click': {
          if (!selector) return { ok: false, error: 'selector parameter is required for click action' };
          await cdpClient.click(selector);
          return { ok: true, message: `Clicked on ${selector}` };
        }

        case 'type': {
          if (!selector || text === undefined) return { ok: false, error: 'selector and text parameters are required for type action' };
          await cdpClient.type(selector, text);
          return { ok: true, message: `Typed text into ${selector}` };
        }

        case 'wait_for': {
          if (!selector) return { ok: false, error: 'selector parameter is required for wait_for action' };
          await cdpClient.waitForSelector(selector, timeout);
          return { ok: true, message: `Found selector ${selector}` };
        }

        case 'tabs': {
          const { targetInfos } = await cdpClient.send('Target.getTargets');
          return { ok: true, tabs: targetInfos.filter(t => t.type === 'page') };
        }

        case 'open_tab': {
          if (!url) return { ok: false, error: 'url parameter is required' };
          await validateUrl(url);
          const { targetId } = await cdpClient.send('Target.createTarget', { url });
          // Attach to the new tab so subsequent commands target it
          await cdpClient.attachToTarget(targetId);
          return { ok: true, targetId, message: `Opened and switched to new tab` };
        }

        case 'close_tab': {
          if (!params.targetId) return { ok: false, error: 'targetId parameter is required for close_tab' };
          const result = await cdpClient.send('Target.closeTarget', { targetId: params.targetId });
          return { ok: true, message: `Closed tab ${params.targetId}`, success: result.success };
        }

        case 'console': {
          if (cdpClient.consoleMessages) {
            const logs = [...cdpClient.consoleMessages];
            cdpClient.consoleMessages = []; // clear after reading
            return { ok: true, logs };
          }
          return { ok: true, logs: [] };
        }

        default:
          return { ok: false, error: `Unhandled action: ${action}` };
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
});

// For testing purposes so we can clean up
browserTool._cleanup = async () => {
  if (cdpClient) cdpClient.disconnect();
  if (browserService) await browserService.stop();
  cdpClient = null;
  browserService = null;
};

module.exports = browserTool;

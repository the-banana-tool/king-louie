const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const BrowserService = require('../src/browser/browser-service');
const CdpClient = require('../src/browser/cdp-client');
const browserTool = require('../src/tools/builtin/browser-tool');

describe('BrowserService', () => {
  it('detects browser paths on current platform', () => {
    const service = new BrowserService();
    const paths = service.detectBrowserPaths();
    // Should return array of possible paths (may be empty if no browser installed)
    assert.ok(Array.isArray(paths));
  });

  it('generates correct launch arguments', () => {
    const service = new BrowserService({ headless: true, viewport: { width: 1280, height: 720 } });
    const args = service.getLaunchArgs();
    assert.ok(args.includes('--headless=new') || args.includes('--headless'));
    assert.ok(args.some(a => a.includes('1280')));
    assert.ok(args.includes('--remote-debugging-port=0'));
  });

  it('uses isolated profile directory', () => {
    const service = new BrowserService({ userDataPath: '/tmp/test' });
    const args = service.getLaunchArgs();
    assert.ok(args.some(a => a.includes('/tmp/test')));
  });
});

describe('CdpClient', () => {
  it('parses WebSocket URL from browser stderr', () => {
    const url = CdpClient.parseWsUrl('DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc');
    assert.strictEqual(url, 'ws://127.0.0.1:9222/devtools/browser/abc');
  });

  it('handles connection failure gracefully', async () => {
    // A valid URL but not connectable
    const client = new CdpClient('ws://127.0.0.1:65535');
    await assert.rejects(() => client.connect(), /ECONNREFUSED/i);
  });
});

describe('Browser Tool', () => {
  it('requires approval', () => {
    assert.strictEqual(browserTool.requiresApproval, true);
  });

  it('validates action parameter', async () => {
    const result = await browserTool.execute({ action: 'invalid_action' });
    assert.ok(!result.ok);
  });

  it('blocks private network URLs', async () => {
    const BrowserService = require('../src/browser/browser-service');
    const CdpClient = require('../src/browser/cdp-client');
    const { validateUrl } = require('../src/tools/builtin/web-fetch-utils');

    await assert.rejects(() => validateUrl('http://192.168.1.1'), /Blocked/i);
  });
});

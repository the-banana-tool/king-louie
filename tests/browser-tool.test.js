const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const browserTool = require('../src/tools/builtin/browser-tool');
const PlaywrightBrowser = require('../src/browser/playwright-browser');

// ─── Unit tests (no browser needed) ─────────────────────────────────────────

describe('PlaywrightBrowser', () => {
  it('reports not running before start', () => {
    const b = new PlaywrightBrowser();
    assert.strictEqual(b.isRunning, false);
  });

  it('drains console messages', () => {
    const b = new PlaywrightBrowser();
    b.consoleMessages.push({ type: 'log', text: 'hello', timestamp: 1 });
    const msgs = b.drainConsole();
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, 'hello');
    assert.strictEqual(b.consoleMessages.length, 0);
  });
});

describe('Browser Tool - unit', () => {
  it('requires approval', () => {
    assert.strictEqual(browserTool.requiresApproval, true);
  });

  it('rejects unknown actions', async () => {
    const result = await browserTool.execute({ action: 'nonexistent' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Unknown action'));
  });

  it('requires browser to be running for navigate', async () => {
    await browserTool._cleanup();
    const result = await browserTool.execute({ action: 'navigate', url: 'https://example.com' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('not running'));
  });

  it('requires browser to be running for click', async () => {
    await browserTool._cleanup();
    const result = await browserTool.execute({ action: 'click', selector: '#btn' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('not running'));
  });

  it('requires url param for navigate', async () => {
    await browserTool._cleanup();
    const result = await browserTool.execute({ action: 'navigate' });
    assert.strictEqual(result.ok, false);
  });

  it('blocks private network URLs via SSRF protection', async () => {
    const { validateUrl } = require('../src/tools/builtin/web-fetch-utils');
    await assert.rejects(() => validateUrl('http://192.168.1.1'), /Blocked/i);
    await assert.rejects(() => validateUrl('http://127.0.0.1'), /Blocked/i);
    await assert.rejects(() => validateUrl('http://localhost'), /Blocked/i);
  });

  it('exposes all expected actions in the enum', () => {
    const actionEnum = browserTool.parameters.properties.action.enum;
    const expectedActions = [
      'start', 'stop', 'status',
      'navigate', 'go_back', 'go_forward', 'reload',
      'click', 'dblclick', 'fill', 'type', 'press', 'clear',
      'select_option', 'check', 'uncheck', 'hover', 'focus',
      'drag_and_drop', 'set_input_files', 'scroll',
      'screenshot', 'pdf', 'evaluate', 'content', 'title',
      'get_text', 'get_attribute', 'get_value', 'is_visible', 'count', 'bounding_box',
      'wait_for', 'wait_for_url', 'wait_for_load_state', 'wait_for_response',
      'tabs', 'open_tab', 'close_tab', 'switch_tab',
      'route_block', 'route_fulfill', 'unroute', 'console',
      'login', 'save_storage_state', 'load_storage_state', 'get_cookies', 'clear_cookies',
      'handle_dialog', 'set_viewport',
      'keyboard_type', 'keyboard_down', 'keyboard_up',
      'mouse_click', 'mouse_move', 'mouse_wheel',
    ];
    for (const action of expectedActions) {
      assert.ok(actionEnum.includes(action), `Missing action: ${action}`);
    }
  });

  it('has a _cleanup method', () => {
    assert.strictEqual(typeof browserTool._cleanup, 'function');
  });
});

// ─── Integration tests (launches a real browser) ─────────────────────────────

// Helper: set page HTML via evaluate, then return the current page URL
async function setPageContent(html) {
  await browserTool.execute({
    action: 'evaluate',
    expression: `document.open(); document.write(${JSON.stringify(html)}); document.close();`,
  });
}

// Standard test page with various elements
const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1 id="heading">Hello World</h1>
  <p class="description" data-testid="desc">A test paragraph</p>

  <form id="login-form">
    <label for="user-email">Email</label>
    <input id="user-email" type="email" name="email" placeholder="Enter email" />

    <label for="user-pass">Password</label>
    <input id="user-pass" type="password" name="password" placeholder="Enter password" />

    <select id="role-select" name="role">
      <option value="">-- Choose role --</option>
      <option value="admin">Admin</option>
      <option value="user">User</option>
      <option value="guest">Guest</option>
    </select>

    <label><input type="checkbox" id="remember-me" name="remember" /> Remember me</label>

    <textarea id="notes" placeholder="Additional notes"></textarea>

    <button type="submit" id="submit-btn">Sign In</button>
  </form>

  <div id="output"></div>

  <ul id="item-list">
    <li class="list-item">Item 1</li>
    <li class="list-item">Item 2</li>
    <li class="list-item">Item 3</li>
  </ul>

  <a href="https://example.com" id="example-link" title="Example Site">Visit Example</a>
  <button id="action-btn" data-action="greet" aria-label="Say Hello">Click Me</button>
  <div id="hidden-div" style="display:none">Hidden content</div>
  <div id="hover-target">Hover over me</div>

  <script>
    document.getElementById('submit-btn').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('output').textContent = 'Form submitted!';
    });
    document.getElementById('action-btn').addEventListener('click', () => {
      document.getElementById('output').textContent = 'Button clicked!';
    });
    document.getElementById('hover-target').addEventListener('mouseenter', () => {
      document.getElementById('hover-target').textContent = 'Hovered!';
    });
  </script>
</body>
</html>`;

describe('Browser Tool - integration', () => {
  before(async () => {
    await browserTool._cleanup();
    const result = await browserTool.execute({ action: 'start', headless: true });
    assert.strictEqual(result.ok, true, `Browser failed to start: ${result.error || ''}`);
  });

  after(async () => {
    await browserTool._cleanup();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it('start reports browser already running on second call', async () => {
    const result = await browserTool.execute({ action: 'start' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.message.includes('already running'));
  });

  it('status shows browser is running', async () => {
    const result = await browserTool.execute({ action: 'status' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.running, true);
  });

  // ── Page content setup & evaluate ──────────────────────────────────────────

  it('evaluate can execute JavaScript and return values', async () => {
    const result = await browserTool.execute({ action: 'evaluate', expression: '2 + 2' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.result, 4);
  });

  it('evaluate can set and read DOM content', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({
      action: 'evaluate',
      expression: 'document.getElementById("heading").textContent',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.result, 'Hello World');
  });

  // ── Finding elements & reading content ─────────────────────────────────────

  it('get_text reads element text by CSS selector', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'get_text', selector: '#heading' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Hello World');
  });

  it('get_text reads element text by class', async () => {
    const result = await browserTool.execute({ action: 'get_text', selector: '.description' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'A test paragraph');
  });

  it('get_text with text= selector', async () => {
    const result = await browserTool.execute({ action: 'get_text', selector: 'text=Hello World' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.text.includes('Hello World'));
  });

  it('get_text with testid= selector', async () => {
    const result = await browserTool.execute({ action: 'get_text', selector: 'testid=desc' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'A test paragraph');
  });

  it('get_text with label= selector finds the input label target', async () => {
    // label= uses getByLabel which finds the associated input, not text
    // This tests the selector strategy wiring
    const result = await browserTool.execute({ action: 'get_value', selector: 'label=Email' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, ''); // empty input initially
  });

  it('get_text with placeholder= selector', async () => {
    const result = await browserTool.execute({ action: 'get_value', selector: 'placeholder=Enter email' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, '');
  });

  it('get_attribute reads element attributes', async () => {
    const result = await browserTool.execute({
      action: 'get_attribute',
      selector: '#action-btn',
      attribute: 'data-action',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, 'greet');
  });

  it('get_attribute reads href from link', async () => {
    const result = await browserTool.execute({
      action: 'get_attribute',
      selector: '#example-link',
      attribute: 'href',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, 'https://example.com');
  });

  it('get_value reads input value (empty initially)', async () => {
    const result = await browserTool.execute({ action: 'get_value', selector: '#user-email' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, '');
  });

  it('is_visible returns true for visible elements', async () => {
    const result = await browserTool.execute({ action: 'is_visible', selector: '#heading' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.visible, true);
  });

  it('is_visible returns false for hidden elements', async () => {
    const result = await browserTool.execute({ action: 'is_visible', selector: '#hidden-div' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.visible, false);
  });

  it('count returns the number of matching elements', async () => {
    const result = await browserTool.execute({ action: 'count', selector: '.list-item' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.count, 3);
  });

  it('count returns 0 for non-existent selector', async () => {
    const result = await browserTool.execute({ action: 'count', selector: '.does-not-exist' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.count, 0);
  });

  it('bounding_box returns position and size', async () => {
    const result = await browserTool.execute({ action: 'bounding_box', selector: '#heading' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.box !== null, 'bounding_box should not be null for visible element');
    assert.ok(typeof result.box.x === 'number');
    assert.ok(typeof result.box.y === 'number');
    assert.ok(result.box.width > 0);
    assert.ok(result.box.height > 0);
  });

  // ── Role-based selectors ───────────────────────────────────────────────────

  it('finds button by role=button', async () => {
    const result = await browserTool.execute({
      action: 'get_text',
      selector: "role=button[name='Sign In']",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Sign In');
  });

  it('finds link by role=link', async () => {
    const result = await browserTool.execute({
      action: 'get_text',
      selector: "role=link[name='Visit Example']",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Visit Example');
  });

  it('finds heading by role=heading', async () => {
    const result = await browserTool.execute({
      action: 'get_text',
      selector: 'role=heading',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Hello World');
  });

  it('finds element by title= selector', async () => {
    const result = await browserTool.execute({
      action: 'get_text',
      selector: 'title=Example Site',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Visit Example');
  });

  // ── Clicking ───────────────────────────────────────────────────────────────

  it('click triggers event handler', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const click = await browserTool.execute({ action: 'click', selector: '#action-btn' });
    assert.strictEqual(click.ok, true);

    const result = await browserTool.execute({ action: 'get_text', selector: '#output' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, 'Button clicked!');
  });

  it('click by role selector', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const click = await browserTool.execute({
      action: 'click',
      selector: "role=button[name='Say Hello']",
    });
    assert.strictEqual(click.ok, true);

    const result = await browserTool.execute({ action: 'get_text', selector: '#output' });
    assert.strictEqual(result.text, 'Button clicked!');
  });

  it('click on non-existent element fails gracefully', async () => {
    const result = await browserTool.execute({
      action: 'click',
      selector: '#does-not-exist',
      timeout: 1000,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  // ── Fill & type ────────────────────────────────────────────────────────────

  it('fill sets input value instantly', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const fill = await browserTool.execute({
      action: 'fill',
      selector: '#user-email',
      text: 'test@example.com',
    });
    assert.strictEqual(fill.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#user-email' });
    assert.strictEqual(result.value, 'test@example.com');
  });

  it('fill via label= selector', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const fill = await browserTool.execute({
      action: 'fill',
      selector: 'label=Email',
      text: 'label@test.com',
    });
    assert.strictEqual(fill.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#user-email' });
    assert.strictEqual(result.value, 'label@test.com');
  });

  it('fill via placeholder= selector', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const fill = await browserTool.execute({
      action: 'fill',
      selector: 'placeholder=Enter email',
      text: 'placeholder@test.com',
    });
    assert.strictEqual(fill.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#user-email' });
    assert.strictEqual(result.value, 'placeholder@test.com');
  });

  it('type enters text character by character', async () => {
    await setPageContent(TEST_PAGE_HTML);
    // First clear, then type
    await browserTool.execute({ action: 'clear', selector: '#user-email' });
    const type = await browserTool.execute({
      action: 'type',
      selector: '#user-email',
      text: 'slow@type.com',
      delay: 10,
    });
    assert.strictEqual(type.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#user-email' });
    assert.strictEqual(result.value, 'slow@type.com');
  });

  it('fill into textarea', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const fill = await browserTool.execute({
      action: 'fill',
      selector: '#notes',
      text: 'Some notes here',
    });
    assert.strictEqual(fill.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#notes' });
    assert.strictEqual(result.value, 'Some notes here');
  });

  it('clear empties an input', async () => {
    await setPageContent(TEST_PAGE_HTML);
    await browserTool.execute({ action: 'fill', selector: '#user-email', text: 'hello@world.com' });
    const clear = await browserTool.execute({ action: 'clear', selector: '#user-email' });
    assert.strictEqual(clear.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#user-email' });
    assert.strictEqual(result.value, '');
  });

  // ── Select, check, uncheck ────────────────────────────────────────────────

  it('select_option by value', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const sel = await browserTool.execute({
      action: 'select_option',
      selector: '#role-select',
      value: 'admin',
    });
    assert.strictEqual(sel.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#role-select' });
    assert.strictEqual(result.value, 'admin');
  });

  it('select_option by label', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const sel = await browserTool.execute({
      action: 'select_option',
      selector: '#role-select',
      label: 'Guest',
    });
    assert.strictEqual(sel.ok, true);

    const result = await browserTool.execute({ action: 'get_value', selector: '#role-select' });
    assert.strictEqual(result.value, 'guest');
  });

  it('check checks a checkbox', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const check = await browserTool.execute({ action: 'check', selector: '#remember-me' });
    assert.strictEqual(check.ok, true);

    const result = await browserTool.execute({
      action: 'evaluate',
      expression: 'document.getElementById("remember-me").checked',
    });
    assert.strictEqual(result.result, true);
  });

  it('uncheck unchecks a checkbox', async () => {
    // The checkbox was checked in the previous test, but we set fresh page content
    await setPageContent(TEST_PAGE_HTML);
    await browserTool.execute({ action: 'check', selector: '#remember-me' });
    const uncheck = await browserTool.execute({ action: 'uncheck', selector: '#remember-me' });
    assert.strictEqual(uncheck.ok, true);

    const result = await browserTool.execute({
      action: 'evaluate',
      expression: 'document.getElementById("remember-me").checked',
    });
    assert.strictEqual(result.result, false);
  });

  // ── Hover ──────────────────────────────────────────────────────────────────

  it('hover triggers mouseenter event', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const hover = await browserTool.execute({ action: 'hover', selector: '#hover-target' });
    assert.strictEqual(hover.ok, true);

    const result = await browserTool.execute({ action: 'get_text', selector: '#hover-target' });
    assert.strictEqual(result.text, 'Hovered!');
  });

  // ── Press (keyboard) ──────────────────────────────────────────────────────

  it('press Enter in form triggers submit handler', async () => {
    await setPageContent(TEST_PAGE_HTML);
    await browserTool.execute({ action: 'fill', selector: '#user-email', text: 'a@b.com' });
    const press = await browserTool.execute({
      action: 'press',
      selector: '#user-email',
      key: 'Enter',
    });
    assert.strictEqual(press.ok, true);

    const result = await browserTool.execute({ action: 'get_text', selector: '#output' });
    assert.strictEqual(result.text, 'Form submitted!');
  });

  it('press Tab moves focus', async () => {
    await setPageContent(TEST_PAGE_HTML);
    await browserTool.execute({ action: 'focus', selector: '#user-email' });
    await browserTool.execute({ action: 'press', selector: '#user-email', key: 'Tab' });

    const activeId = await browserTool.execute({
      action: 'evaluate',
      expression: 'document.activeElement.id',
    });
    assert.strictEqual(activeId.ok, true);
    assert.strictEqual(activeId.result, 'user-pass');
  });

  // ── Focus ──────────────────────────────────────────────────────────────────

  it('focus sets active element', async () => {
    await setPageContent(TEST_PAGE_HTML);
    await browserTool.execute({ action: 'focus', selector: '#notes' });

    const activeId = await browserTool.execute({
      action: 'evaluate',
      expression: 'document.activeElement.id',
    });
    assert.strictEqual(activeId.result, 'notes');
  });

  // ── Screenshot ─────────────────────────────────────────────────────────────

  it('screenshot saves a PNG file and returns page info', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'screenshot' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.savedTo.endsWith('.png'));
    assert.ok(fs.existsSync(result.savedTo));
    assert.ok(result.page.title === 'Test Page');
    assert.ok(result.page.bodyText.includes('Hello World'));
    assert.ok(result.page.buttons.length > 0);
    assert.ok(result.page.inputs.length > 0);
    // Clean up
    fs.unlinkSync(result.savedTo);
  });

  it('screenshot of a specific element', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'screenshot', selector: '#heading' });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(result.savedTo));
    // Element screenshot should be smaller than full page
    const stats = fs.statSync(result.savedTo);
    assert.ok(stats.size > 0);
    fs.unlinkSync(result.savedTo);
  });

  it('screenshot with full_page captures entire scrollable area', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'screenshot', full_page: true });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(result.savedTo));
    fs.unlinkSync(result.savedTo);
  });

  // ── Content & title ────────────────────────────────────────────────────────

  it('content returns page HTML', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'content' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.html.includes('Hello World'));
    assert.ok(result.html.includes('<form'));
  });

  it('title returns page title', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'title' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.title, 'Test Page');
  });

  // ── Wait actions ───────────────────────────────────────────────────────────

  it('wait_for finds an already-visible element', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({
      action: 'wait_for',
      selector: '#heading',
      timeout: 2000,
    });
    assert.strictEqual(result.ok, true);
  });

  it('wait_for with state=hidden succeeds for hidden element', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({
      action: 'wait_for',
      selector: '#hidden-div',
      state: 'hidden',
      timeout: 2000,
    });
    assert.strictEqual(result.ok, true);
  });

  it('wait_for times out on non-existent element', async () => {
    const result = await browserTool.execute({
      action: 'wait_for',
      selector: '#never-gonna-exist',
      timeout: 500,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  it('wait_for detects dynamically added element', async () => {
    await setPageContent(TEST_PAGE_HTML);
    // Schedule an element to appear after 200ms
    await browserTool.execute({
      action: 'evaluate',
      expression: `setTimeout(() => {
        const el = document.createElement('div');
        el.id = 'dynamic-el';
        el.textContent = 'I appeared!';
        document.body.appendChild(el);
      }, 200)`,
    });

    const result = await browserTool.execute({
      action: 'wait_for',
      selector: '#dynamic-el',
      timeout: 5000,
    });
    assert.strictEqual(result.ok, true);

    const text = await browserTool.execute({ action: 'get_text', selector: '#dynamic-el' });
    assert.strictEqual(text.text, 'I appeared!');
  });

  // ── Tab management ─────────────────────────────────────────────────────────

  it('tabs lists open tabs', async () => {
    const result = await browserTool.execute({ action: 'tabs' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.tabs.length >= 1);
    assert.ok(result.tabs.some(t => t.isCurrent));
  });

  it('open_tab creates a new tab and switch_tab switches back', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const open = await browserTool.execute({ action: 'open_tab' });
    assert.strictEqual(open.ok, true);

    const tabs = await browserTool.execute({ action: 'tabs' });
    assert.ok(tabs.tabs.length >= 2);

    // Switch back to first tab
    const sw = await browserTool.execute({ action: 'switch_tab', tab_index: 0 });
    assert.strictEqual(sw.ok, true);

    // First tab should still have our test page
    const title = await browserTool.execute({ action: 'title' });
    assert.strictEqual(title.title, 'Test Page');

    // Close the extra tab
    await browserTool.execute({ action: 'close_tab', tab_index: tabs.tabs.length - 1 });
  });

  // ── Console capture ────────────────────────────────────────────────────────

  it('console captures console.log messages', async () => {
    await setPageContent(TEST_PAGE_HTML);
    // Clear any existing console messages first
    await browserTool.execute({ action: 'console' });

    await browserTool.execute({
      action: 'evaluate',
      expression: 'console.log("test message"); console.warn("warning!");',
    });
    // Small delay to ensure messages are captured
    await new Promise(r => setTimeout(r, 100));

    const result = await browserTool.execute({ action: 'console' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.logs.length >= 2, `Expected >=2 console messages, got ${result.logs.length}`);
    assert.ok(result.logs.some(l => l.text.includes('test message')));
    assert.ok(result.logs.some(l => l.type === 'warning'));
  });

  it('console drains messages (second call is empty)', async () => {
    const result = await browserTool.execute({ action: 'console' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.logs.length, 0);
  });

  // ── Viewport ───────────────────────────────────────────────────────────────

  it('set_viewport changes page dimensions', async () => {
    const set = await browserTool.execute({ action: 'set_viewport', width: 800, height: 600 });
    assert.strictEqual(set.ok, true);

    const dims = await browserTool.execute({
      action: 'evaluate',
      expression: '({ w: window.innerWidth, h: window.innerHeight })',
    });
    assert.strictEqual(dims.result.w, 800);
    assert.strictEqual(dims.result.h, 600);

    // Restore default
    await browserTool.execute({ action: 'set_viewport', width: 1280, height: 720 });
  });

  // ── Keyboard direct ────────────────────────────────────────────────────────

  it('keyboard_type types text without a specific element', async () => {
    await setPageContent(TEST_PAGE_HTML);
    await browserTool.execute({ action: 'focus', selector: '#notes' });
    const result = await browserTool.execute({ action: 'keyboard_type', text: 'keyboard input' });
    assert.strictEqual(result.ok, true);

    const value = await browserTool.execute({ action: 'get_value', selector: '#notes' });
    assert.strictEqual(value.value, 'keyboard input');
  });

  // ── Mouse direct ───────────────────────────────────────────────────────────

  it('mouse_click clicks at coordinates', async () => {
    await setPageContent(TEST_PAGE_HTML);
    // Get the bounding box of the action button and click its center
    const box = await browserTool.execute({ action: 'bounding_box', selector: '#action-btn' });
    assert.ok(box.box);

    const cx = box.box.x + box.box.width / 2;
    const cy = box.box.y + box.box.height / 2;
    const click = await browserTool.execute({ action: 'mouse_click', x: cx, y: cy });
    assert.strictEqual(click.ok, true);

    const output = await browserTool.execute({ action: 'get_text', selector: '#output' });
    assert.strictEqual(output.text, 'Button clicked!');
  });

  // ── Handle dialog ──────────────────────────────────────────────────────────

  it('handle_dialog sets the dialog handler', async () => {
    const result = await browserTool.execute({ action: 'handle_dialog', response: 'accept' });
    assert.strictEqual(result.ok, true);

    // Trigger an alert and ensure it doesn't hang (auto-accepted)
    const evalResult = await browserTool.execute({
      action: 'evaluate',
      expression: '(() => { alert("test"); return "done"; })()',
    });
    assert.strictEqual(evalResult.ok, true);
    assert.strictEqual(evalResult.result, 'done');

    // Reset to dismiss
    await browserTool.execute({ action: 'handle_dialog', response: 'dismiss' });
  });

  // ── Cookies ────────────────────────────────────────────────────────────────

  it('get_cookies returns cookies array', async () => {
    const result = await browserTool.execute({ action: 'get_cookies' });
    assert.strictEqual(result.ok, true);
    assert.ok(Array.isArray(result.cookies));
  });

  it('clear_cookies empties cookies', async () => {
    const clear = await browserTool.execute({ action: 'clear_cookies' });
    assert.strictEqual(clear.ok, true);

    const result = await browserTool.execute({ action: 'get_cookies' });
    assert.strictEqual(result.cookies.length, 0);
  });

  // ── Storage state ──────────────────────────────────────────────────────────

  it('save_storage_state and load_storage_state round-trip', async () => {
    const tmpPath = path.join(require('os').tmpdir(), `kl-test-state-${Date.now()}.json`);
    const save = await browserTool.execute({ action: 'save_storage_state', path: tmpPath });
    assert.strictEqual(save.ok, true);
    assert.ok(fs.existsSync(tmpPath));

    const data = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    assert.ok(Array.isArray(data.cookies));

    const load = await browserTool.execute({ action: 'load_storage_state', path: tmpPath });
    assert.strictEqual(load.ok, true);

    // Clean up
    fs.unlinkSync(tmpPath);
  });

  // ── Scroll ─────────────────────────────────────────────────────────────────

  it('scroll scrolls element into view', async () => {
    await setPageContent(TEST_PAGE_HTML);
    const result = await browserTool.execute({ action: 'scroll', selector: '#item-list' });
    assert.strictEqual(result.ok, true);
  });

  it('scroll with delta scrolls the page', async () => {
    const result = await browserTool.execute({ action: 'scroll', delta_y: 200 });
    assert.strictEqual(result.ok, true);
  });

  // ── Parameter validation ───────────────────────────────────────────────────

  it('fill requires text param', async () => {
    const result = await browserTool.execute({ action: 'fill', selector: '#user-email' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('text'));
  });

  it('press requires key param', async () => {
    const result = await browserTool.execute({ action: 'press', selector: '#user-email' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('key'));
  });

  it('get_attribute requires attribute param', async () => {
    const result = await browserTool.execute({ action: 'get_attribute', selector: '#heading' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('attribute'));
  });

  it('select_option requires value, label, or index', async () => {
    const result = await browserTool.execute({ action: 'select_option', selector: '#role-select' });
    assert.strictEqual(result.ok, false);
  });

  it('mouse_click requires x and y', async () => {
    const result = await browserTool.execute({ action: 'mouse_click', x: 100 });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('y'));
  });

  it('set_viewport requires width and height', async () => {
    const result = await browserTool.execute({ action: 'set_viewport', width: 800 });
    assert.strictEqual(result.ok, false);
  });

  it('handle_dialog requires response param', async () => {
    const result = await browserTool.execute({ action: 'handle_dialog' });
    assert.strictEqual(result.ok, false);
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  hostAllowed,
  createTakePolicy,
  BROWSER_ACTIONS,
  CREDENTIAL_ACTIONS,
  NEVER_ACTIONS,
  TAKE_CODES,
  LOOK_ONLY_ACTIONS,
} = require('../src/gui/take-policy');

describe('hostAllowed', () => {
  it('exact and wildcard', () => {
    assert.ok(hostAllowed('chatgpt.com', ['chatgpt.com']));
    assert.ok(!hostAllowed('x.chatgpt.com', ['chatgpt.com']));
    assert.ok(hostAllowed('x.chatgpt.com', ['*.chatgpt.com']));
    assert.ok(hostAllowed('chatgpt.com', ['*.chatgpt.com']));
    assert.ok(!hostAllowed('notchatgpt.com', ['*.chatgpt.com']));
    assert.ok(hostAllowed('CHATGPT.COM.', ['chatgpt.com']));
  });
});

describe('tables', () => {
  it('the three columns of spec 7.1 do not overlap and are frozen', () => {
    const first = [...BROWSER_ACTIONS.page, ...BROWSER_ACTIONS.session, ...BROWSER_ACTIONS.extract];
    for (const a of CREDENTIAL_ACTIONS) assert.ok(!first.includes(a), a);
    for (const a of NEVER_ACTIONS) {
      assert.ok(!first.includes(a), a);
      assert.ok(!CREDENTIAL_ACTIONS.includes(a), a);
    }
    assert.ok(Object.isFrozen(BROWSER_ACTIONS));
    assert.ok(Object.isFrozen(BROWSER_ACTIONS.page));
    assert.ok(Object.isFrozen(TAKE_CODES));
  });
});

describe('decide', () => {
  const policy = (grant, url) => createTakePolicy(
    { sites: ['*.example.com'], browser: true, credentials: false, apps: ['notepad'], ...grant },
    { currentUrl: async () => url },
  );

  it('shell is refused', async () => {
    const d = await policy({}, null).decide('Bash', { command: 'dir' });
    assert.equal(d.allow, false);
    assert.equal(d.code, 'take_tool_not_allowed');
    assert.equal(d.error, 'Bash is not allowed in a take; to wait, use wait_for');
  });

  it('click on an allowed host runs without asking', async () => {
    assert.deepEqual(
      await policy({}, 'https://app.example.com/x').decide('BrowserPage', { action: 'click', selector: 'a' }),
      { allow: true },
    );
  });

  it('the page redirected to another host: click refuses, screenshot and navigate back run', async () => {
    const p = policy({}, 'https://accounts.example.net/login');
    const click = await p.decide('BrowserPage', { action: 'click', selector: 'a' });
    assert.equal(click.code, 'take_site_not_allowed');
    assert.equal(click.error, 'accounts.example.net is not one of this take\'s sites');
    assert.equal((await p.decide('BrowserPage', { action: 'screenshot' })).allow, true);
    assert.equal((await p.decide('BrowserPage', { action: 'navigate', url: 'https://example.com/' })).allow, true);
    assert.equal((await p.decide('BrowserPage', { action: 'navigate', url: 'https://evil.example.net/' })).code, 'take_site_not_allowed');
  });

  it('an acting action with no page refuses, and an unparsable target refuses', async () => {
    const p = policy({}, null);
    const d = await p.decide('BrowserPage', { action: 'type', selector: 'a', text: 'x' });
    assert.equal(d.code, 'take_site_not_allowed');
    assert.equal(d.error, '(no page) is not one of this take\'s sites');
    assert.equal((await p.decide('BrowserPage', { action: 'navigate', url: 'not a url' })).code, 'take_site_not_allowed');
  });

  it('currentUrl is asked only when the current host matters', async () => {
    let calls = 0;
    const p = createTakePolicy(
      { sites: ['example.com'], browser: true, credentials: false, apps: [] },
      { currentUrl: async () => { calls++; return 'https://example.com/'; } },
    );
    await p.decide('BrowserPage', { action: 'navigate', url: 'https://example.com/a' });
    await p.decide('BrowserPage', { action: 'screenshot' });
    await p.decide('Read', { path: 'x' });
    assert.equal(calls, 0);
    await p.decide('BrowserPage', { action: 'click', selector: 'a' });
    assert.equal(calls, 1);
  });

  it('evaluate, route_block, fill_payment, start are never inside', async () => {
    const p = policy({ credentials: true }, 'https://app.example.com/');
    const ev = await p.decide('BrowserPage', { action: 'evaluate', script: '1' });
    assert.equal(ev.code, 'take_action_not_allowed');
    assert.equal(ev.error, 'evaluate is outside what this take approved');
    assert.equal((await p.decide('BrowserExtract', { action: 'route_block', pattern: '*' })).code, 'take_action_not_allowed');
    assert.equal((await p.decide('BrowserSession', { action: 'fill_payment' })).code, 'take_action_not_allowed');
    const start = await p.decide('BrowserSession', { action: 'start' });
    assert.equal(start.code, 'take_browser_managed');
    assert.equal(start.error, 'the take owns its browser; use Take.start and Take.stop');
    assert.equal((await p.decide('BrowserSession', { action: 'profile_create' })).code, 'take_browser_managed');
    assert.equal((await p.decide('BrowserSession', { action: 'load_storage_state' })).code, 'take_browser_managed');
    assert.equal((await p.decide('Browser', { action: 'evaluate' })).code, 'take_action_not_allowed');
    assert.equal((await p.decide('Browser', { action: 'stop' })).code, 'take_browser_managed');
  });

  it('fill_credentials needs credentials: true', async () => {
    const without = await policy({}, 'https://app.example.com/').decide('BrowserSession', { action: 'fill_credentials' });
    assert.equal(without.code, 'take_action_not_allowed');
    assert.deepEqual(
      await policy({ credentials: true }, 'https://app.example.com/').decide('BrowserSession', { action: 'fill_credentials' }),
      { allow: true },
    );
    assert.equal(
      (await policy({ credentials: true }, 'https://other.test/').decide('BrowserSession', { action: 'fill_credentials' })).code,
      'take_site_not_allowed',
    );
  });

  it('login and signup check their target url as well as the page', async () => {
    const p = policy({ credentials: true }, 'https://app.example.com/');
    assert.equal((await p.decide('BrowserSession', { action: 'login', url: 'https://accounts.example.net/' })).code, 'take_site_not_allowed');
    assert.deepEqual(await p.decide('BrowserSession', { action: 'login', url: 'https://app.example.com/login' }), { allow: true });
    assert.equal((await p.decide('Browser', { action: 'signup', url: 'https://accounts.example.net/' })).code, 'take_site_not_allowed');
    const offPage = policy({ credentials: true }, 'https://accounts.example.net/');
    assert.equal((await offPage.decide('BrowserSession', { action: 'login', url: 'https://app.example.com/login' })).code, 'take_site_not_allowed');
  });

  it('credential actions check params.host against the sites', async () => {
    const onPage = policy({ credentials: true }, 'https://app.example.com/');
    assert.equal((await onPage.decide('BrowserSession', { action: 'fill_credentials', host: 'bank.example.net' })).code, 'take_site_not_allowed');
    assert.deepEqual(await onPage.decide('BrowserSession', { action: 'fill_credentials', host: 'app.example.com' }), { allow: true });
    // fill_credentials keeps the page check too.
    const offPage = policy({ credentials: true }, 'https://bank.example.net/');
    assert.equal((await offPage.decide('BrowserSession', { action: 'fill_credentials', host: 'app.example.com' })).code, 'take_site_not_allowed');
    // set_http_auth and save_credentials with a host act on it, not on the page.
    const blank = policy({ credentials: true }, null);
    assert.deepEqual(await blank.decide('BrowserSession', { action: 'set_http_auth', host: 'app.example.com' }), { allow: true });
    assert.equal((await blank.decide('BrowserSession', { action: 'set_http_auth', host: 'bank.example.net' })).code, 'take_site_not_allowed');
    assert.deepEqual(await blank.decide('Browser', { action: 'save_credentials', host: 'APP.example.com.' }), { allow: true });
    assert.equal((await blank.decide('Browser', { action: 'save_credentials', host: 'bank.example.net' })).code, 'take_site_not_allowed');
    // Without a host they fall back to the page, so the page check applies.
    assert.equal((await blank.decide('BrowserSession', { action: 'save_credentials' })).code, 'take_site_not_allowed');
  });

  it('the credentials flag alone governs the second column', async () => {
    const p = policy({ browser: ['navigate'], credentials: true }, 'https://app.example.com/');
    assert.deepEqual(await p.decide('BrowserSession', { action: 'fill_credentials', host: 'app.example.com' }), { allow: true });
  });

  it('wait_for_url is look-only and takes a pattern anywhere', async () => {
    assert.deepEqual(await policy({}, 'https://elsewhere.test/').decide('BrowserPage', { action: 'wait_for_url', url: '**/done' }), { allow: true });
    assert.deepEqual(await policy({}, null).decide('BrowserPage', { action: 'wait_for_url', url: '**/done' }), { allow: true });
  });

  it('open_tab with no url is a blank tab; with an off-list url it refuses', async () => {
    const p = policy({}, 'https://elsewhere.test/');
    assert.deepEqual(await p.decide('BrowserSession', { action: 'open_tab' }), { allow: true });
    assert.equal((await p.decide('BrowserSession', { action: 'open_tab', url: 'https://evil.example.net' })).code, 'take_site_not_allowed');
    assert.deepEqual(await p.decide('BrowserSession', { action: 'open_tab', url: 'https://app.example.com/' }), { allow: true });
  });

  it('a narrowed list refuses what it leaves out and lists what it allows', async () => {
    const p = policy({ browser: ['navigate', 'click'] }, 'https://app.example.com/');
    assert.deepEqual(await p.decide('BrowserPage', { action: 'type', selector: 'a', text: 'x' }), {
      allow: false,
      code: 'take_action_not_allowed',
      error: 'type is outside what this take approved',
      allowed: ['navigate', 'click'],
    });
    assert.deepEqual(await p.decide('BrowserPage', { action: 'click', selector: 'a' }), { allow: true });
  });

  it('snapshot is look-only: it runs on any host, under every split tool and Browser', async () => {
    // Spec 2026-10-28-browser-runner §7.5, C-12.
    assert.ok(BROWSER_ACTIONS.extract.includes('snapshot'));
    assert.ok(LOOK_ONLY_ACTIONS.includes('snapshot'));
    const off = policy({}, 'https://accounts.example.net/login');
    for (const tool of ['BrowserPage', 'BrowserExtract', 'Browser']) {
      assert.deepEqual(await off.decide(tool, { action: 'snapshot' }), { allow: true }, tool);
      assert.deepEqual(await off.decide(tool, { action: 'snapshot', interactive: true, ref: 'e3' }), { allow: true }, tool);
    }
    assert.deepEqual(await policy({}, null).decide('BrowserPage', { action: 'snapshot' }), { allow: true });
  });

  it('a click on a ref checks the current page like any click', async () => {
    const off = await policy({}, 'https://accounts.example.net/login').decide('BrowserPage', { action: 'click', selector: 'ref=e15' });
    assert.equal(off.code, 'take_site_not_allowed');
    assert.deepEqual(
      await policy({}, 'https://app.example.com/').decide('BrowserPage', { action: 'click', selector: 'ref=e15' }),
      { allow: true },
    );
  });

  it('a narrowed list without snapshot refuses it; one with it allows it', async () => {
    const without = await policy({ browser: ['navigate', 'click'] }, 'https://app.example.com/').decide('BrowserPage', { action: 'snapshot' });
    assert.deepEqual(without, {
      allow: false,
      code: 'take_action_not_allowed',
      error: 'snapshot is outside what this take approved',
      allowed: ['navigate', 'click'],
    });
    assert.deepEqual(
      await policy({ browser: ['navigate', 'snapshot'] }, 'https://accounts.example.net/').decide('BrowserExtract', { action: 'snapshot' }),
      { allow: true },
    );
  });

  it('a narrowed list cannot widen the first column', async () => {
    const p = policy({ browser: ['navigate', 'evaluate'] }, 'https://app.example.com/');
    assert.equal((await p.decide('BrowserPage', { action: 'evaluate' })).code, 'take_action_not_allowed');
  });

  it('LaunchApp outside the take apps is refused', async () => {
    const d = await policy({}, null).decide('LaunchApp', { app: 'calculator' });
    assert.equal(d.code, 'take_app_not_allowed');
    assert.equal(d.error, 'calculator is not one of this take\'s apps');
    assert.deepEqual(await policy({}, null).decide('LaunchApp', { app: 'notepad' }), { allow: true, passthrough: true });
  });

  it('other tools pass through', async () => {
    assert.deepEqual(await policy({}, null).decide('Read', { path: 'x' }), { allow: true, passthrough: true });
  });

  it('close_tab runs anywhere', async () => {
    assert.deepEqual(await policy({}, 'https://elsewhere.test/').decide('BrowserSession', { action: 'close_tab' }), { allow: true });
    assert.deepEqual(await policy({}, null).decide('Browser', { action: 'close_tab' }), { allow: true });
  });

  it('every refusal code is in TAKE_CODES', () => {
    for (const code of ['take_tool_not_allowed', 'take_app_not_allowed', 'take_action_not_allowed',
      'take_browser_managed', 'take_site_not_allowed', 'take_no_mid_take_approval',
      'take_requires_local_origin', 'take_busy', 'recorder_missing', 'recorder_failed', 'browser_launch_failed']) {
      assert.ok(TAKE_CODES.includes(code), code);
    }
  });
});

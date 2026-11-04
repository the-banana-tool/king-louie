'use strict';

// The task policy (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.6): a call
// inside the live grant is allowed, everything else passes through to the ordinary phone path,
// and only a task that is over refuses.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTaskPolicy } = require('../src/tasks/policy');

const ALLOW = { allow: true };
const LOOK = { allow: true, look: true };
const PASS = { passthrough: true };
const ON_SITE = 'https://maps.example.com/x';
const OFF_SITE = 'https://other.test/';
const SITES = ['*.example.com'];

let root;
let workDir;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-task-policy-'));
  workDir = path.join(root, 'work');
  fs.mkdirSync(workDir);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function policy({ allows = ['browser-act'], url = ON_SITE, state = {} } = {}) {
  return createTaskPolicy({
    getState: () => ({ ended: false, proposal: null, grant: { sites: SITES, allows }, awaiting: false, ...state }),
    currentUrl: async () => url,
    workDir,
    waitForGrant: async () => { throw new Error('must not wait'); },
  });
}

describe('createTaskPolicy, browser calls in a live grant', () => {
  const table = [
    ['click on a granted page', 'BrowserPage', { action: 'click', selector: 'a' }, {}, ALLOW],
    ['the legacy tool', 'Browser', { action: 'fill', selector: 'a', text: 'x' }, {}, ALLOW],
    ['handle_dialog on a granted page', 'BrowserSession', { action: 'handle_dialog' }, {}, ALLOW],
    ['navigate to a granted site', 'BrowserPage', { action: 'navigate', url: 'https://a.example.com/' }, {}, ALLOW],
    ['navigate checks the target, not the page', 'BrowserPage', { action: 'navigate', url: 'https://a.example.com/' }, { url: null }, ALLOW],
    ['navigate off-site', 'BrowserPage', { action: 'navigate', url: 'https://other.test/' }, {}, PASS],
    ['navigate to a userinfo trick', 'BrowserPage', { action: 'navigate', url: 'https://a.example.com@other.test/' }, {}, PASS],
    ['navigate to a suffix trick', 'BrowserPage', { action: 'navigate', url: 'https://notexample.com/' }, {}, PASS],
    ['navigate to a file URL', 'BrowserPage', { action: 'navigate', url: 'file:///C:/secret.txt' }, {}, PASS],
    ['navigate with no url', 'BrowserPage', { action: 'navigate' }, {}, PASS],
    ['navigate with a bad url', 'BrowserPage', { action: 'navigate', url: 'not a url' }, {}, PASS],
    ['navigate to a javascript URL', 'BrowserPage', { action: 'navigate', url: 'javascript:alert(1)' }, {}, PASS],
    ['navigate to a chrome URL', 'BrowserPage', { action: 'navigate', url: 'chrome://settings' }, {}, PASS],
    ['another scheme on a granted host', 'BrowserPage', { action: 'navigate', url: 'ftp://a.example.com/' }, {}, PASS],
    ['navigate without browser-act', 'BrowserPage', { action: 'navigate', url: 'https://a.example.com/' }, { allows: ['shell'] }, ALLOW],
    ['open_tab to a granted site', 'BrowserSession', { action: 'open_tab', url: 'https://a.example.com/' }, { url: null }, ALLOW],
    ['open_tab off-site', 'BrowserSession', { action: 'open_tab', url: 'https://other.test/' }, {}, PASS],
    ['open_tab blank', 'BrowserSession', { action: 'open_tab' }, { url: null }, LOOK],
    ['open_tab blank without browser-act', 'BrowserSession', { action: 'open_tab' }, { allows: ['logins'] }, LOOK],
    ['off-site after redirect asks', 'Browser', { action: 'fill', selector: 'a', text: 'x' }, { url: OFF_SITE }, PASS],
    ['no page', 'BrowserPage', { action: 'click', selector: 'a' }, { url: null }, PASS],
    ['a page with no host', 'BrowserPage', { action: 'click', selector: 'a' }, { url: 'about:blank' }, PASS],
    ['without browser-act', 'BrowserPage', { action: 'click', selector: 'a' }, { allows: ['logins'] }, PASS],
    ['with a profile', 'BrowserPage', { action: 'click', selector: 'a', profile: 'other' }, {}, PASS],
    ['ephemeral', 'BrowserSession', { action: 'navigate', url: 'https://a.example.com/', ephemeral: true }, {}, PASS],
    ['a look-only call with a profile', 'BrowserExtract', { action: 'snapshot', profile: 'other' }, {}, PASS],
    ['an acting action with an off-site url', 'BrowserPage', { action: 'click', selector: 'a', url: 'https://other.test/' }, {}, PASS],
    ['an acting action with an off-site host', 'BrowserPage', { action: 'click', selector: 'a', host: 'other.test' }, {}, PASS],
    ['an acting action with an on-site url', 'BrowserPage', { action: 'click', selector: 'a', url: 'https://a.example.com/' }, {}, ALLOW],
    ['an on-site url does not excuse the page', 'BrowserPage', { action: 'click', selector: 'a', url: 'https://a.example.com/' }, { url: OFF_SITE }, PASS],
    ['other session and profile actions', 'BrowserSession', { action: 'profile_list' }, {}, PASS],
    ['an unknown action', 'BrowserPage', { action: 'teleport' }, {}, PASS],
    ['no action', 'BrowserPage', {}, {}, PASS],
  ];
  for (const [name, tool, params, opts, want] of table) {
    it(name, async () => {
      assert.deepEqual(await policy(opts).decide(tool, params), want);
    });
  }

  // Outside "click and type": the card never says code, files or cards (spec §4.5).
  for (const action of ['evaluate', 'evaluate_in_frame', 'set_input_files', 'fill_payment']) {
    it(`${action} passes through whatever is granted`, async () => {
      const all = ['browser-act', 'logins', 'shell', 'files-write'];
      assert.deepEqual(await policy({ allows: all }).decide('Browser', { action, selector: 'a' }), PASS);
    });
  }

  for (const action of ['get_cookies', 'clear_cookies', 'route_block', 'pdf', 'save_storage_state', 'profile_create', 'profile_delete', 'profile_current']) {
    it(`${action} passes through`, async () => {
      assert.deepEqual(await policy().decide('Browser', { action }), PASS);
    });
  }

  it('a currentUrl that throws passes through', async () => {
    const p = createTaskPolicy({
      getState: () => ({ ended: false, proposal: null, grant: { sites: SITES, allows: ['browser-act'] }, awaiting: false }),
      currentUrl: async () => { throw new Error('no browser'); },
      workDir,
      waitForGrant: async () => {},
    });
    assert.deepEqual(await p.decide('BrowserPage', { action: 'click', selector: 'a' }), PASS);
  });
});

describe('createTaskPolicy, look class', () => {
  const STATES = {
    'a live grant': {},
    'no grant': { grant: null },
    'a card out': { grant: null, awaiting: true, proposal: { sites: SITES, allows: ['browser-act'] } },
  };
  const ACTIONS = [
    'snapshot', 'content', 'screenshot', 'status', 'tabs', 'get_text', 'wait_for_url',
    'hover', 'focus', 'scroll', 'mouse_move', 'mouse_wheel', 'set_viewport',
  ];
  for (const [name, state] of Object.entries(STATES)) {
    for (const action of ACTIONS) {
      it(`${action} with ${name}, on any page, no wait`, async () => {
        assert.deepEqual(await policy({ state, url: OFF_SITE }).decide('BrowserExtract', { action }), LOOK);
        assert.deepEqual(await policy({ state, url: null }).decide('BrowserExtract', { action }), LOOK);
      });
    }
  }
});

describe('createTaskPolicy, reload', () => {
  const reload = { action: 'reload' };
  it('is browser-act with the page check', async () => {
    assert.deepEqual(await policy().decide('BrowserPage', reload), ALLOW);
    assert.deepEqual(await policy({ url: OFF_SITE }).decide('BrowserPage', reload), PASS);
    assert.deepEqual(await policy({ url: null }).decide('BrowserPage', reload), PASS);
    assert.deepEqual(await policy({ allows: ['shell'] }).decide('BrowserPage', reload), PASS);
    assert.deepEqual(await policy({ state: { grant: null } }).decide('BrowserPage', reload), PASS);
  });
  for (const action of ['go_back', 'go_forward', 'close_tab', 'switch_tab']) {
    it(`${action} stays look class`, async () => {
      assert.deepEqual(await policy({ state: { grant: null }, url: OFF_SITE }).decide('BrowserPage', { action }), LOOK);
    });
  }
});

describe('createTaskPolicy, start and stop', () => {
  for (const tool of ['BrowserSession', 'Browser']) {
    it(`${tool}: a plain start and stop are look class`, async () => {
      assert.deepEqual(await policy({ state: { grant: null } }).decide(tool, { action: 'start' }), LOOK);
      assert.deepEqual(await policy().decide(tool, { action: 'start', headless: true }), LOOK);
      assert.deepEqual(await policy().decide(tool, { action: 'stop' }), LOOK);
    });
    it(`${tool}: a start that opens anything else passes through`, async () => {
      for (const extra of [{ profile: 'other' }, { ephemeral: true }, { ephemeral: false }, { userDataPath: 'C:/x' }, { ownerQuote: 'go' }]) {
        assert.deepEqual(await policy().decide(tool, { action: 'start', ...extra }), PASS, JSON.stringify(extra));
      }
    });
  }
  it('a stop naming a profile passes through', async () => {
    assert.deepEqual(await policy().decide('BrowserSession', { action: 'stop', profile: 'other' }), PASS);
  });
});

describe('createTaskPolicy, navigation', () => {
  const nav = (url) => ({ action: 'navigate', url });
  const tab = (url) => ({ action: 'open_tab', url });
  const lookOnly = { sites: SITES, allows: [], lookOnly: true };
  const card = { sites: SITES, allows: ['browser-act'] };

  for (const [name, state] of [
    ['a look-only proposal', { grant: null, proposal: lookOnly }],
    ['a proposal with nothing to act on', { grant: null, proposal: { sites: SITES, allows: [] } }],
    ['no proposal', { grant: null, proposal: null }],
  ]) {
    it(`${name}: nothing bounds it, any http(s) site is look class`, async () => {
      const p = policy({ state });
      assert.deepEqual(await p.decide('BrowserPage', nav('https://other.test/')), LOOK);
      assert.deepEqual(await p.decide('BrowserPage', nav('http://a.example.com/')), LOOK);
      assert.deepEqual(await p.decide('BrowserSession', tab('https://other.test/')), LOOK);
    });
    it(`${name}: another scheme still passes through`, async () => {
      const p = policy({ state });
      for (const url of ['file:///C:/secret.txt', 'javascript:alert(1)', 'chrome://settings', 'not a url']) {
        assert.deepEqual(await p.decide('BrowserPage', nav(url)), PASS, url);
      }
      assert.deepEqual(await p.decide('BrowserPage', { action: 'navigate' }), PASS);
    });
  }

  it('a card out: a proposal site is look class, off-list passes through, and neither waits', async () => {
    const p = policy({ state: { grant: null, awaiting: true, proposal: card } });
    assert.deepEqual(await p.decide('BrowserPage', nav('https://a.example.com/')), LOOK);
    assert.deepEqual(await p.decide('BrowserSession', tab('https://a.example.com/')), LOOK);
    assert.deepEqual(await p.decide('BrowserPage', nav('https://other.test/')), PASS);
    assert.deepEqual(await p.decide('BrowserPage', nav('file:///C:/secret.txt')), PASS);
  });
  it('a lapsed grant: a proposal that acts still bounds it', async () => {
    const p = policy({ state: { grant: null, awaiting: false, proposal: card } });
    assert.deepEqual(await p.decide('BrowserPage', nav('https://a.example.com/')), LOOK);
    assert.deepEqual(await p.decide('BrowserSession', tab('https://a.example.com/')), LOOK);
    assert.deepEqual(await p.decide('BrowserPage', nav('https://other.test/')), PASS);
    assert.deepEqual(await p.decide('BrowserSession', tab('https://other.test/')), PASS);
    assert.deepEqual(await p.decide('BrowserPage', nav('file:///C:/secret.txt')), PASS);
  });
  it('a card out with no proposal to read has no site to allow', async () => {
    const p = policy({ state: { grant: null, awaiting: true, proposal: null } });
    assert.deepEqual(await p.decide('BrowserPage', nav('https://a.example.com/')), PASS);
  });
  it('a live grant: its sites are the owner\'s allow, whatever the classes', async () => {
    const p = policy({ allows: [] });
    assert.deepEqual(await p.decide('BrowserPage', nav('https://a.example.com/')), ALLOW);
    assert.deepEqual(await p.decide('BrowserPage', nav('https://other.test/')), PASS);
  });
  it('a blank tab is look class in every state', async () => {
    for (const state of [{}, { grant: null }, { grant: null, awaiting: true, proposal: card }]) {
      assert.deepEqual(await policy({ state }).decide('BrowserSession', { action: 'open_tab' }), LOOK);
    }
  });
  it('ended is task_ended first', async () => {
    const d = await policy({ state: { ended: true } }).decide('BrowserPage', nav('https://a.example.com/'));
    assert.equal(d.code, 'task_ended');
  });
});

describe('createTaskPolicy, logins', () => {
  const logins = { allows: ['logins'] };
  it('passes through without logins', async () => {
    assert.deepEqual(await policy().decide('BrowserSession', { action: 'login', url: 'https://a.example.com/' }), PASS);
  });
  it('allows with logins on a granted page', async () => {
    assert.deepEqual(await policy(logins).decide('BrowserSession', { action: 'login', url: 'https://a.example.com/' }), ALLOW);
    assert.deepEqual(await policy(logins).decide('Browser', { action: 'fill_credentials', host: 'a.example.com' }), ALLOW);
  });
  it('passes through off a granted page, and with an off-site url or host', async () => {
    assert.deepEqual(await policy({ ...logins, url: OFF_SITE }).decide('BrowserSession', { action: 'login' }), PASS);
    assert.deepEqual(await policy(logins).decide('BrowserSession', { action: 'login', url: 'https://other.test/' }), PASS);
    assert.deepEqual(await policy(logins).decide('BrowserSession', { action: 'fill_credentials', host: 'other.test' }), PASS);
  });
  it('browser-act alone never reaches them, nor logins alone a click', async () => {
    assert.deepEqual(await policy(logins).decide('BrowserPage', { action: 'click', selector: 'a' }), PASS);
  });
});

describe('createTaskPolicy, shell and files', () => {
  for (const tool of ['Bash', 'PowerShell']) {
    it(`${tool} needs shell`, async () => {
      assert.deepEqual(await policy().decide(tool, { command: 'dir' }), PASS);
      assert.deepEqual(await policy({ allows: ['shell'] }).decide(tool, { command: 'dir' }), ALLOW);
    });
  }

  const files = { allows: ['files-write'] };
  it('a write under the work directory needs files-write', async () => {
    const inside = path.join(workDir, 'a.txt');
    assert.deepEqual(await policy().decide('Write', { file_path: inside, content: 'x' }), PASS);
    assert.deepEqual(await policy(files).decide('Write', { file_path: inside, content: 'x' }), ALLOW);
    assert.deepEqual(await policy(files).decide('Write', { file_path: 'sub/a.txt', content: 'x' }), ALLOW);
    assert.deepEqual(await policy(files).decide('Edit', { file_path: inside, old_string: 'a', new_string: 'b' }), ALLOW);
  });
  it('outside it, or escaping it, passes through', async () => {
    const out = path.join(root, 'other.txt');
    assert.deepEqual(await policy(files).decide('Write', { file_path: out, content: 'x' }), PASS);
    assert.deepEqual(await policy(files).decide('Write', { file_path: '../other.txt', content: 'x' }), PASS);
    assert.deepEqual(await policy(files).decide('Write', { file_path: path.join(workDir, '..', 'other.txt'), content: 'x' }), PASS);
    assert.deepEqual(await policy(files).decide('Write', { file_path: `${workDir}-sibling/a.txt`, content: 'x' }), PASS);
  });
  it('a relative path is placed where the call will run, not where the policy started', async () => {
    const p = policy(files);
    assert.deepEqual(await p.decide('Write', { file_path: 'a.txt', content: 'x' }, { cwd: root }), PASS);
    assert.deepEqual(await p.decide('Write', { file_path: 'a.txt', content: 'x' }, { cwd: workDir }), ALLOW);
  });
  it('a link out of the work directory passes through', async (t) => {
    const link = path.join(workDir, 'out');
    fs.symlinkSync(root, link, 'junction');
    t.after(() => fs.unlinkSync(link));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.deepEqual(await policy(files).decide('Write', { file_path: 'out/a.txt', content: 'x' }), PASS);
    assert.deepEqual(await policy(files).decide('Write', { file_path: path.join(link, 'a.txt'), content: 'x' }), PASS);
  });
  it('MultiEdit needs every path under the work directory', async () => {
    const edit = (file_path) => ({ file_path, old_string: 'a', new_string: 'b' });
    assert.deepEqual(await policy(files).decide('MultiEdit', { edits: [edit('a.txt'), edit('b.txt')] }), ALLOW);
    assert.deepEqual(await policy(files).decide('MultiEdit', { edits: [edit('a.txt'), edit('../b.txt')] }), PASS);
    assert.deepEqual(await policy(files).decide('MultiEdit', { edits: [] }), PASS);
    assert.deepEqual(await policy(files).decide('MultiEdit', {}), PASS);
  });
  it('a write with no path passes through', async () => {
    assert.deepEqual(await policy(files).decide('Write', { content: 'x' }), PASS);
  });
  it('with no work directory nothing is under it', async () => {
    const p = createTaskPolicy({
      getState: () => ({ ended: false, proposal: null, grant: { sites: [], allows: ['files-write'] }, awaiting: false }),
      currentUrl: async () => null,
      waitForGrant: async () => {},
    });
    assert.deepEqual(await p.decide('Write', { file_path: 'a.txt', content: 'x' }), PASS);
  });
  it('other tools pass through', async () => {
    const all = { allows: ['browser-act', 'logins', 'shell', 'files-write'] };
    for (const tool of ['Screenshot', 'Read', 'KlNoSuchTool', 'NotebookEdit']) {
      assert.deepEqual(await policy(all).decide(tool, {}), PASS, tool);
    }
  });
});

describe('createTaskPolicy, with no grant', () => {
  it('passes through at once, with or without a proposal', async () => {
    const states = [
      { grant: null },
      { grant: null, proposal: { sites: SITES, allows: ['browser-act'] } },
    ];
    for (const state of states) {
      assert.deepEqual(await policy({ state }).decide('BrowserPage', { action: 'click', selector: 'a' }), PASS);
    }
  });
});

describe('createTaskPolicy, over', () => {
  it('every call is task_ended', async () => {
    const p = policy({ state: { ended: true } });
    for (const [tool, params] of [
      ['BrowserPage', { action: 'click', selector: 'a' }],
      ['BrowserExtract', { action: 'snapshot' }],
      ['Bash', { command: 'dir' }],
      ['Read', { file_path: 'a' }],
      ['KlNoSuchTool', {}],
    ]) {
      const d = await p.decide(tool, params);
      assert.equal(d.allow, false, tool);
      assert.equal(d.code, 'task_ended');
      assert.equal(typeof d.error, 'string');
    }
  });
});

describe('createTaskPolicy, awaiting the card', () => {
  const click = { action: 'click', selector: 'a' };

  function awaiting({ allows = ['browser-act'], sites = SITES, url = ON_SITE, next }) {
    let waits = 0;
    let state = { ended: false, proposal: { sites, allows }, grant: null, awaiting: true };
    const p = createTaskPolicy({
      getState: () => state,
      currentUrl: async () => url,
      workDir,
      waitForGrant: async () => { waits += 1; state = next; },
    });
    return { p, waits: () => waits };
  }
  const granted = { ended: false, proposal: null, grant: { sites: SITES, allows: ['browser-act'] }, awaiting: false };

  it('the class in the proposal on a proposal site waits, then allows on the grant', async () => {
    const { p, waits } = awaiting({ next: granted });
    assert.deepEqual(await p.decide('BrowserPage', click), ALLOW);
    assert.equal(waits(), 1);
  });
  it('decides on the new state, whose sites may differ', async () => {
    const { p } = awaiting({ next: { ...granted, grant: { sites: ['elsewhere.test'], allows: ['browser-act'] } } });
    assert.deepEqual(await p.decide('BrowserPage', click), PASS);
  });
  it('a denied or expired card passes through, once', async () => {
    const { p, waits } = awaiting({ next: { ...granted, grant: null, awaiting: true } });
    assert.deepEqual(await p.decide('BrowserPage', click), PASS);
    assert.equal(waits(), 1);
  });
  it('ended by then is task_ended', async () => {
    const { p } = awaiting({ next: { ...granted, grant: null, ended: true } });
    const d = await p.decide('BrowserPage', click);
    assert.equal(d.allow, false);
    assert.equal(d.code, 'task_ended');
  });
  it('a wait that never settles ends with the call\'s signal, in a passthrough', async () => {
    const abort = new AbortController();
    const p = createTaskPolicy({
      getState: () => ({ ended: false, proposal: { sites: SITES, allows: ['browser-act'] }, grant: null, awaiting: true }),
      currentUrl: async () => ON_SITE,
      workDir,
      waitForGrant: () => new Promise(() => {}),
    });
    const pending = p.decide('BrowserPage', click, { signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    assert.deepEqual(await pending, PASS);
  });
  it('a signal already aborted does not start the wait', async () => {
    const abort = new AbortController();
    abort.abort();
    const { p, waits } = awaiting({ next: granted });
    assert.deepEqual(await p.decide('BrowserPage', click, { signal: abort.signal }), PASS);
    assert.equal(waits(), 0);
  });
  it('a press with a signal decides on the grant and drops its listener', async () => {
    const abort = new AbortController();
    const added = [];
    const removed = [];
    const { signal } = abort;
    const spy = {
      get aborted() { return signal.aborted; },
      addEventListener: (type, fn, o) => { added.push(fn); signal.addEventListener(type, fn, o); },
      removeEventListener: (type, fn) => { removed.push(fn); signal.removeEventListener(type, fn); },
    };
    const { p } = awaiting({ next: granted });
    assert.deepEqual(await p.decide('BrowserPage', click, { signal: spy }), ALLOW);
    assert.equal(added.length, 1);
    assert.deepEqual(removed, added);
  });
  it('the class not in the proposal passes through at once', async () => {
    const { p, waits } = awaiting({ allows: ['logins'], next: granted });
    assert.deepEqual(await p.decide('BrowserPage', click), PASS);
    assert.deepEqual(await p.decide('Bash', { command: 'dir' }), PASS);
    assert.equal(waits(), 0);
  });
  it('off a proposal site passes through at once', async () => {
    const { p, waits } = awaiting({ url: OFF_SITE, next: granted });
    assert.deepEqual(await p.decide('BrowserPage', click), PASS);
    assert.deepEqual(await p.decide('BrowserPage', { action: 'navigate', url: 'https://other.test/' }), PASS);
    assert.equal(waits(), 0);
  });
  it('a write outside the work directory passes through at once', async () => {
    const { p, waits } = awaiting({ allows: ['files-write'], next: granted });
    assert.deepEqual(await p.decide('Write', { file_path: '../a.txt', content: 'x' }), PASS);
    assert.equal(waits(), 0);
  });
  it('a live grant is not waited on, awaiting or not', async () => {
    const { p } = (() => {
      const state = { ended: false, proposal: { sites: SITES, allows: ['browser-act'] }, grant: { sites: SITES, allows: ['browser-act'] }, awaiting: true };
      return { p: createTaskPolicy({ getState: () => state, currentUrl: async () => ON_SITE, workDir, waitForGrant: async () => { throw new Error('must not wait'); } }) };
    })();
    assert.deepEqual(await p.decide('BrowserPage', click), ALLOW);
  });
});

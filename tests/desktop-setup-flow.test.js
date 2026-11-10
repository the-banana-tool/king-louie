// tests/desktop-setup-flow.test.js
// The setup flow's steps and words (attach stage 2 spec §6.3, §6.5, §6.8).
// Statuses are hand-built in the shape the controller's `status()` gives.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SETUP_STEPS, nextSetupStep, describeSetup, setupFacts } = require('../src/desktop-bridge/setup-flow');

const MARK = '[hidden or control characters removed]';
const ids = (m) => m.actions.map((a) => a.id);
const text = (m) => [...m.lines, m.pre || '', m.error ? m.error.message : ''].join('\n');
const personalService = { providersConfigured: true, hosting: 'personal' };
const connected = (extra = {}) => ({ paired: true, connected: true, service: personalService, setup: {}, ...extra });

describe('nextSetupStep', () => {
  it('the steps, in order', () => {
    assert.deepStrictEqual(SETUP_STEPS, ['install', 'pair', 'start', 'migrate', 'provider', 'profile', 'phone', 'done']);
  });

  const table = [
    ['fresh', { node: { fresh: true } }, 'install'],
    ['personal, task missing', { node: { personal: true, task: 'missing' } }, 'install'],
    ['no node to speak of', { node: null }, 'install'],
    ['personal, task disabled: nothing to pair with yet', { node: { personal: true, task: 'disabled' } }, 'install'],
    ['personal, another account\'s task', { node: { personal: true, task: 'other-account' } }, 'install'],
    ['personal, a task nobody could read', { node: { personal: true, task: 'unknown' } }, 'install'],
    ['task registered, not paired', { node: { personal: true, task: 'registered' }, paired: false }, 'pair'],
    ['a pairing under way, whatever the task says', { node: { personal: true, task: 'missing' }, pendingPair: true }, 'pair'],
    ['paired, not running, not connected', { paired: true, connected: false, node: { personal: true, task: 'registered', running: false }, service: { hosting: 'personal' } }, 'start'],
    ['paired, running, bridge not answering', { paired: true, connected: false, node: { personal: true, task: 'registered', running: true }, service: { hosting: 'personal' } }, 'start'],
    ['connected, an old profile, no migration', connected({ oldProfile: { found: true } }), 'migrate'],
    ['connected, no old profile, no key', connected({ oldProfile: { found: false }, service: { hosting: 'personal', providersConfigured: false } }), 'provider'],
    ['connected, migration set, no key', connected({ oldProfile: { found: true }, migration: { at: 'x' }, service: { hosting: 'personal', providersConfigured: false } }), 'provider'],
    ['a move skipped for now, no key', connected({ oldProfile: { found: true, schemaProblem: 'x' }, setup: { migrateSkipped: true }, service: { hosting: 'personal', providersConfigured: false } }), 'provider'],
    ['providers set, default user profile', connected({ userProfileDefault: true }), 'profile'],
    ['all set, phone not seen', connected({ userProfileDefault: false, setup: { phoneSeen: false } }), 'phone'],
    ['phone seen', connected({ setup: { phoneSeen: true } }), 'done']
  ];
  for (const [name, facts, step] of table) {
    it(`${name} → ${step}`, () => assert.strictEqual(nextSetupStep(facts), step));
  }

  it('setup.completedAt → done, whatever else holds', () => {
    const completed = { completedAt: '2026-11-03T00:00:00Z' };
    for (const facts of [
      { paired: true, connected: false, service: { hosting: 'personal' }, setup: completed, node: { personal: true, task: 'registered', running: false } },
      { paired: true, connected: true, service: { hosting: 'personal', providersConfigured: false }, oldProfile: { found: true }, setup: completed, userProfileDefault: true },
      { paired: true, connected: false, service: { hosting: 'personal' }, setup: completed, elevated: true }
    ]) assert.strictEqual(nextSetupStep(facts), 'done');
  });

  it('completedAt with no node to attach to is not done: the window never shows a chat with no node (§6.2, §6.5)', () => {
    const completed = { completedAt: '2026-11-03T00:00:00Z' };
    assert.strictEqual(nextSetupStep({ paired: false, setup: completed, node: { personal: true, task: 'registered' } }), 'pair');
    assert.strictEqual(nextSetupStep({ paired: false, setup: completed, node: { fresh: true } }), 'install');
    assert.strictEqual(nextSetupStep({ paired: true, attached: false, setup: completed, service: { hosting: 'personal' } }), 'pair');
  });

  it('elevated → install, ahead of anything an unfinished setup would do', () => {
    for (const facts of [
      { elevated: true },
      { elevated: true, node: { personal: true, task: 'registered' } },
      { elevated: true, paired: true, connected: false, service: { hosting: 'personal' } },
      { elevated: true, pendingPair: true }
    ]) assert.strictEqual(nextSetupStep(facts), 'install');
  });

  it('a window with no setup to do: a standalone launch, a fleet pairing', () => {
    assert.strictEqual(nextSetupStep({ launch: { host: 'standalone', why: 'dev' }, node: { fresh: true } }), 'done');
    assert.strictEqual(nextSetupStep({ launch: { host: 'standalone', why: 'platform' } }), 'done');
    assert.strictEqual(nextSetupStep({ paired: true, connected: false, service: { hosting: 'service', providersConfigured: false } }), 'done');
    assert.strictEqual(nextSetupStep({ paired: true, connected: true, service: { hosting: 'service', providersConfigured: false }, oldProfile: { found: true } }), 'done');
  });

  it('a pairing detached by the owner (Windows: back in needs-node) is not done and not start: Start refuses NOT_ATTACHED', () => {
    assert.strictEqual(nextSetupStep({ paired: true, attached: false, service: { hosting: 'service' } }), 'pair');
    assert.strictEqual(nextSetupStep({ paired: true, attached: false, service: { hosting: 'personal' } }), 'pair');
  });
});

describe('setupFacts', () => {
  it('status.service is null with no summary: the hosting comes from the pairing record', () => {
    const f = setupFacts({ mode: 'attached', service: null, pairing: { service: { hosting: 'personal' } }, connection: { status: 'disconnected' } });
    assert.strictEqual(f.service.hosting, 'personal');
    assert.strictEqual(f.paired, true);
    assert.strictEqual(f.connected, false);
    assert.strictEqual(nextSetupStep(f), 'start');
  });

  it('hosting is only personal or service; a pairing with no word is the fleet\'s', () => {
    assert.strictEqual(setupFacts({ service: { hosting: 'personal' }, pairing: { service: {} } }).service.hosting, 'personal');
    assert.strictEqual(setupFacts({ service: { hosting: { evil: 1 } }, pairing: { service: { hosting: 'personal' } } }).service.hosting, 'personal');
    assert.strictEqual(setupFacts({ service: { hosting: 'root' }, pairing: { service: {} } }).service.hosting, 'service');
    assert.strictEqual(setupFacts({ service: null, pairing: null }).service.hosting, null);
  });

  it('the pairing record comes ahead of what the node says', () => {
    assert.strictEqual(setupFacts({ service: { hosting: 'service' }, pairing: { service: { hosting: 'personal' } } }).service.hosting, 'personal');
    assert.strictEqual(setupFacts({ service: { hosting: 'personal' }, pairing: { service: { hosting: 'service' } } }).service.hosting, 'service');
  });

  it('the pane\'s node shape reads as personal; PAIR_ELEVATED anywhere is elevated', () => {
    assert.strictEqual(setupFacts({ node: { hosting: 'personal', task: 'registered' } }).node.personal, true);
    assert.strictEqual(setupFacts({ pendingPair: { personal: true, error: { code: 'PAIR_ELEVATED' } } }).elevated, true);
    assert.strictEqual(setupFacts({ installPreview: { ok: false, code: 'PAIR_ELEVATED' } }).elevated, true);
    assert.strictEqual(setupFacts({ installResult: { ok: false, code: 'PAIR_ELEVATED' } }).elevated, true);
    assert.strictEqual(setupFacts({ setupError: { code: 'PAIR_ELEVATED' } }).elevated, true);
    assert.strictEqual(setupFacts({ elevated: true }).elevated, true);
    assert.strictEqual(setupFacts({}).elevated, false);
  });
});

// A status in the §8 shape, on the product path.
const base = (extra = {}) => ({ platform: 'win32', launch: { host: 'attached', why: 'needs-node' }, mode: 'standalone', pairing: null, service: null, connection: { status: 'disconnected' }, setup: { completedAt: null }, ...extra });
const NODE = { hosting: 'personal', name: 'laptop-01', dataDir: 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\data', task: 'registered', running: false, pid: null, starting: false, startError: null };
const PAIRING = { service: { hosting: 'personal', dataDir: NODE.dataDir, fingerprint: 'wxyz', port: 18796, name: 'laptop-01' } };
const LAUNCH_ATTACHED = { host: 'attached', why: 'attached', degraded: false };
const attachedUp = (extra = {}) => base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-connected', pairing: PAIRING, service: { hosting: 'personal', providersConfigured: true, version: '1.0.0' }, connection: { status: 'connected' }, node: NODE, ...extra });
const OLD = { found: true, chats: 3, messages: 120, cases: 2, bytes: 5 * 1024 * 1024, schemaProblem: null, customCasesRoot: null, customCases: 0 };

describe('a custom root that is not there', () => {
  const at = (where) => ({
    platform: 'win32', launch: { host: 'attached', why: 'attached' }, mode: 'attached',
    pairing: { service: { hosting: 'personal', dataDir: 'C:\\d' } }, connection: { status: 'connected' }, service: { providersConfigured: true, hosting: 'personal' },
    node: { hosting: 'personal', task: 'registered', running: true }, setup: {}, profileDir: 'C:\\p',
    oldProfile: { found: true, chats: 1, messages: 1, cases: 0, bytes: 1, customCasesRoot: 'E:\\cases', customCases: null, customCasesMissing: true },
    ...where
  });

  it('says the folder is not there, and both ways on, with no move to press', () => {
    const found = describeSetup(at({}));
    assert.strictEqual(found.error.code, 'MIGRATION_SOURCE');
    assert.match(found.error.message, /E:\\cases is not there/);
    assert.match(found.error.message, /plug it in and press Check again/);
    assert.match(found.error.message, /make an empty folder at that path and press Check again/);
    assert.ok(found.actions.some((a) => a.id === 'retry'));

    const plan = describeSetup(at({ migrationPlan: { ok: true, backup: { dest: 'C:\\b', bytes: 1, files: 1, history: { chats: 1, messages: 1 }, customCasesRoot: 'E:\\cases', customCases: null, customCasesMissing: true }, plan: { items: [], counts: {} }, staysBehind: [] } }));
    assert.match(plan.error.message, /is not there/);
    assert.ok(!plan.actions.some((a) => a.id === 'migrationApply'));
  });
});

describe('finished for now', () => {
  const base = { launch: { host: 'attached', why: 'attached' }, attached: true, paired: true, connected: true, service: { hosting: 'personal', providersConfigured: true }, oldProfile: { found: true }, migration: null };
  it('is done while it lasts, with nothing to draw; without it the move comes back', () => {
    assert.strictEqual(nextSetupStep({ ...base, setup: { finishedForNow: true } }), 'done');
    assert.strictEqual(nextSetupStep({ ...base, setup: { phoneSeen: true } }), 'migrate');
    const answer = describeSetup({
      platform: 'win32', launch: base.launch, mode: 'attached', pairing: { service: { hosting: 'personal', dataDir: 'C:\\d' } }, connection: { status: 'connected' },
      service: base.service, oldProfile: base.oldProfile, node: { hosting: 'personal' }, setup: { finishedForNow: true }
    });
    assert.deepStrictEqual([answer.step, answer.lines, answer.actions], ['done', [], []]);
  });
});

describe('the custom-root instruction says what follows from it', () => {
  it('names the standalone mode, which still looks in the old folder', () => {
    const { error } = describeSetup({
      platform: 'win32', launch: { host: 'attached', why: 'attached' }, mode: 'attached',
      pairing: { service: { hosting: 'personal', dataDir: 'C:\\d' } }, connection: { status: 'connected' }, service: { providersConfigured: true, hosting: 'personal' },
      oldProfile: { found: true, chats: 1, messages: 1, cases: 0, bytes: 1, customCasesRoot: 'D:\\cases', customCases: 2 },
      node: { hosting: 'personal', task: 'registered', running: true }, setup: {}, profileDir: 'C:\\p'
    });
    assert.match(error.message, /C:\\p\\cases/);
    assert.match(error.message, /old standalone mode/);
  });
});

describe('the plan screen: what an item says', () => {
  const status = (items) => ({
    platform: 'win32', launch: { host: 'attached', why: 'attached' }, mode: 'attached',
    pairing: { service: { hosting: 'personal', dataDir: 'C:\\d' } }, connection: { status: 'connected' }, service: { providersConfigured: true, hosting: 'personal' },
    oldProfile: { found: true, chats: 1, messages: 1, cases: 0, bytes: 1 }, node: { hosting: 'personal', task: 'registered', running: true },
    setup: {}, migrationPlan: { ok: true, backup: { dest: 'C:\\b', bytes: 1, files: 1, history: { chats: 1, messages: 1 } }, plan: { items, counts: {} }, staysBehind: [] }
  });
  const item = (key, note, action = 'copy') => ({ category: 'chat', key, action, note });

  it('shows each different note once, says how many it holds, and shows it through shown', () => {
    const { lines } = describeSetup(status([item('a', 'comes as a copy named (from desktop)'), item('b', 'comes as a copy named (from desktop)'), item('c', 'odd \u202Eword')]));
    assert.strictEqual(lines.filter((l) => l.includes('comes as a copy named')).length, 1);
    assert.ok(lines.some((l) => l.includes('comes as a copy named') && l.includes('2 ')), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('\u202E'));
    assert.ok(lines.some((l) => l.includes('odd')));
  });

  it('leaves notes that are on screen another way, and cuts a long list saying so', () => {
    const { lines } = describeSetup(status([item('a', 'left behind', 'needs-attention'), item('b', 'stays', 'skip-excluded')]));
    assert.ok(!lines.some((l) => l.startsWith('Note:')));
    const many = describeSetup(status(Array.from({ length: 40 }, (_, i) => item(`c${i}`, `note ${i}`))));
    assert.ok(many.lines.filter((l) => l.startsWith('Note:')).length <= 21);
    assert.ok(many.lines.some((l) => /more/.test(l) && l.startsWith('Note:')));
  });
});

const planAnswer = (extra = {}) => ({
  ok: true,
  backup: { dest: 'C:\\Users\\owner\\AppData\\Roaming\\king-louie.backup-20261104T100000Z', bytes: 5 * 1024 * 1024, files: 40, history: { chats: 3, messages: 120 }, customCasesRoot: null, customCases: 0 },
  plan: {
    counts: { new: 5, update: 0, copy: 1, 'skip-present': 2, 'skip-excluded': 1, 'needs-attention': 1, 'needs-desktop': 0 },
    items: [
      { category: 'chat', key: 'c-1', action: 'new' },
      { category: 'chat', key: 'c-2', action: 'copy' },
      { category: 'case', key: 'lakeside-lot', action: 'new' },
      { category: 'case', key: 'other-lot', action: 'needs-attention', note: 'already on the node' },
      { category: 'skill', key: 'skills', action: 'skip-excluded', note: 'skills stay behind' }
    ],
    private: { chats: 0, cases: 0, note: null },
    dirtyCases: []
  },
  heldCases: [],
  refusedFiles: 0,
  attention: [],
  staysBehind: ['Browser profiles: log in again in the node\'s browser.', 'Local servers: add them to the node\'s service.json.', 'The typesafe.ai key: enter it again on the node.'],
  leftBehind: { needsAttention: [{ category: 'case', key: 'other-lot', note: 'already on the node' }], secrets: [] },
  ...extra
});

describe('describeSetup: every answer has the one shape', () => {
  it('keys, and an array of lines and actions, whatever comes in', () => {
    for (const s of [undefined, null, {}, base(), base({ node: { fresh: true } }), attachedUp(), attachedUp({ setup: { completedAt: 'x' } })]) {
      const m = describeSetup(s);
      assert.deepStrictEqual(Object.keys(m).sort(), ['actions', 'canPostpone', 'error', 'form', 'lines', 'pre', 'step']);
      assert.ok(Array.isArray(m.lines));
      assert.ok(Array.isArray(m.actions));
      assert.ok(SETUP_STEPS.includes(m.step));
    }
  });

  it('the module is pure: no electron, no fs, no child process', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-bridge', 'setup-flow.js'), 'utf8');
    assert.doesNotMatch(source, /require\(['"](electron|fs|child_process)['"]\)/);
  });
});

describe('describeSetup: elevated shows PAIR_ELEVATED and nothing else', () => {
  it('no action but retry, no lines, no postpone, on every route to it', () => {
    for (const s of [
      base({ elevated: true, node: { fresh: true } }),
      base({ elevated: true, oldProfile: OLD, node: NODE }),
      base({ view: 'pairing', node: NODE, oldProfile: OLD, pendingPair: { personal: true, request: 'r', stage: 'command', error: { code: 'PAIR_ELEVATED', error: 'refused' } } }),
      base({ node: { fresh: true }, installPreview: { ok: false, code: 'PAIR_ELEVATED', message: 'refused' } }),
      base({ node: { fresh: true }, installResult: { ok: false, code: 'PAIR_ELEVATED', message: 'refused' } })
    ]) {
      const m = describeSetup(s);
      assert.strictEqual(m.step, 'install');
      assert.strictEqual(m.error.code, 'PAIR_ELEVATED');
      assert.strictEqual(m.error.message, 'This app is running as administrator. Close it and open it normally.');
      assert.deepStrictEqual(ids(m), ['retry']);
      assert.deepStrictEqual(m.lines, []);
      assert.strictEqual(m.pre, null);
      assert.strictEqual(m.canPostpone, false);
    }
  });
});

describe('describeSetup: canPostpone', () => {
  it('true only for an old profile with no migration, and then Not now is on screen with its notice', () => {
    const m = describeSetup(base({ node: { fresh: true }, oldProfile: OLD }));
    assert.strictEqual(m.canPostpone, true);
    const later = m.actions.find((a) => a.id === 'setupLater');
    assert.strictEqual(later.label, 'Not now: use the old standalone mode this time');
    assert.match(text(m), /Standalone mode is going away/);
    assert.match(text(m), /cron/);
    assert.match(text(m), /channels/);
  });

  it('false otherwise, and no such button', () => {
    for (const s of [
      base({ node: { fresh: true } }),
      base({ node: { fresh: true }, oldProfile: { found: false } }),
      base({ node: { fresh: true }, oldProfile: OLD, migration: { at: '2026-11-04T10:00:00Z', backupDir: 'C:\\b' } }),
      attachedUp({ oldProfile: { ...OLD, schemaProblem: 'store refused' } })
    ]) {
      const m = describeSetup(s);
      assert.strictEqual(m.canPostpone, false);
      assert.ok(!ids(m).includes('setupLater'));
      assert.doesNotMatch(text(m), /going away/);
    }
  });
});

describe('describeSetup: install', () => {
  it('fresh: says what installing is, one press to the preview', () => {
    const m = describeSetup(base({ node: { fresh: true, personal: false } }));
    assert.strictEqual(m.step, 'install');
    assert.strictEqual(m.error, null);
    assert.deepStrictEqual(ids(m), ['nodeInstallPreview']);
    assert.match(text(m), /King Louie Node/);
  });

  it('the preview goes in pre, each line through shown, with one press Install', () => {
    const m = describeSetup(base({ node: { fresh: true }, installPreview: { ok: true, lines: ['Task: KingLouie Node', 'odd\u0007line'] } }));
    assert.deepStrictEqual(ids(m), ['nodeInstall']);
    assert.strictEqual(m.actions[0].label, 'Install');
    assert.match(m.pre, /^Task: KingLouie Node\n/);
    assert.ok(m.pre.includes(`oddline ${MARK}`));
    assert.doesNotMatch(m.pre, /\u0007/);
  });

  it('a preview or an install refused: the words, a marked line, and what can help', () => {
    const refused = describeSetup(base({ node: { fresh: true }, installPreview: { ok: false, code: 'NODE_INSTALL_FAILED', message: 'a fleet\u202e node is installed', lines: [] } }));
    assert.strictEqual(refused.error.code, 'NODE_INSTALL_FAILED');
    assert.ok(refused.error.message.includes(MARK));
    assert.deepStrictEqual(ids(refused), ['nodeInstallPreview']);
    assert.strictEqual(refused.actions[0].label, 'Check again');
    const failed = describeSetup(base({ node: { fresh: true }, installResult: { ok: false, code: 'NODE_INSTALL_FAILED', message: 'boom', lines: ['one', 'two'] } }));
    assert.strictEqual(failed.error.message, 'boom');
    assert.strictEqual(failed.pre, 'one\ntwo');
    assert.deepStrictEqual(ids(failed), ['nodeInstallPreview']);
  });

  it('a task with no way forward from here says what the owner can do, in plain words', () => {
    const disabled = describeSetup(base({ node: { ...NODE, task: 'disabled' } }));
    assert.strictEqual(disabled.step, 'install');
    assert.strictEqual(disabled.error.code, 'NODE_TASK_DISABLED');
    assert.match(text(disabled), /Task Scheduler/);
    assert.match(text(disabled), /Enable/);
    assert.deepStrictEqual(ids(disabled), ['retry']);

    const other = describeSetup(base({ node: { ...NODE, task: 'other-account' } }));
    assert.strictEqual(other.error.code, 'NODE_TASK_OTHER_ACCOUNT');
    assert.match(text(other), /[Ss]ign in/);
    assert.deepStrictEqual(ids(other), ['retry']);

    const unread = describeSetup(base({ node: { ...NODE, task: 'unknown' } }));
    assert.strictEqual(unread.error.code, 'NODE_TASK_UNREADABLE');
    assert.match(text(unread), /restart/i);
    assert.deepStrictEqual(ids(unread), ['retry']);
  });

  it('a fleet layout or a node that is not personal: NOT_PERSONAL, the way to the service pane, never an Install', () => {
    const m = describeSetup(base({ node: null, bridge: { ok: true } }));
    assert.strictEqual(m.step, 'install');
    assert.strictEqual(m.error.code, 'NOT_PERSONAL');
    assert.deepStrictEqual(ids(m), ['openServiceSettings', 'retry']);
    const refused = describeSetup(base({ node: null, bridge: { ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: 'C:\\x\u0007 is not owned by an administrator' } }));
    assert.ok(text(refused).includes(MARK));
    assert.ok(!ids(refused).includes('nodeInstall'));
    assert.ok(!ids(refused).includes('nodeInstallPreview'));
  });

  it('a refusal with an old profile can still be postponed by a press, and never by itself', () => {
    const m = describeSetup(base({ node: { ...NODE, task: 'other-account' }, oldProfile: OLD }));
    assert.deepStrictEqual(ids(m), ['retry', 'setupLater']);
    assert.strictEqual(m.canPostpone, true);
  });
});

describe('describeSetup: pair', () => {
  it('one press, the warning, and a node name with a control character shown marked', () => {
    const m = describeSetup(base({ node: { ...NODE, name: 'lap\u0007top' } }));
    assert.strictEqual(m.step, 'pair');
    assert.deepStrictEqual(ids(m), ['pairStart']);
    assert.ok(m.lines[0].includes(`laptop ${MARK}`), m.lines[0]);
    assert.doesNotMatch(m.lines[0], /\u0007/);
    assert.match(text(m), /Every paired desktop/);
  });

  it('a pairing under way: the pane\'s stages, each with its press or none', () => {
    const pending = (p) => base({ view: 'pairing', node: NODE, pendingPair: { personal: true, request: 'r', deviceFingerprint: 'abcd', stage: 'command', error: null, ...p } });
    assert.deepStrictEqual(ids(describeSetup(pending({ stage: 'starting' }))), []);
    assert.deepStrictEqual(ids(describeSetup(pending({ stage: 'confirming' }))), []);
    assert.deepStrictEqual(ids(describeSetup(pending({ stage: 'restart-needed' }))), ['pairRestartConfirm', 'pairCancel']);
    const failed = describeSetup(pending({ error: { code: 'PAIR_COMMAND_FAILED', error: 'nope\u0007' } }));
    assert.strictEqual(failed.error.code, 'PAIR_COMMAND_FAILED');
    assert.ok(failed.error.message.includes(MARK));
    assert.deepStrictEqual(ids(failed), ['pairStart', 'pairCancel']);
  });

  it('a fleet pairing started from the pane keeps the fleet\'s command and Confirm', () => {
    const m = describeSetup(base({ view: 'pairing', pendingPair: { request: 'r', command: 'king-louie-service desktop pair r', deviceFingerprint: 'abcd', service: null, error: null } }));
    assert.strictEqual(m.pre, 'king-louie-service desktop pair r');
    assert.deepStrictEqual(ids(m), ['pairConfirm', 'pairCancel']);
    assert.strictEqual(m.actions[0].disabled, true);
  });

  it('paired and detached: one press attaches again', () => {
    const m = describeSetup(base({ view: 'paired', mode: 'standalone', pairing: PAIRING, node: NODE }));
    assert.strictEqual(m.step, 'pair');
    assert.deepStrictEqual(ids(m), ['attach']);
  });
});

describe('describeSetup: start', () => {
  const down = (node, extra = {}) => base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-disconnected', pairing: PAIRING, node: { ...NODE, ...node }, ...extra });

  it('not running: one press starts it', () => {
    const m = describeSetup(down({ running: false }));
    assert.strictEqual(m.step, 'start');
    assert.strictEqual(m.error, null);
    assert.strictEqual(ids(m)[0], 'nodeStart');
    assert.ok(m.lines.includes('King Louie Node is not running.'));
  });

  it('starting: the line and no press', () => {
    const m = describeSetup(down({ starting: true }, { view: 'attached-starting' }));
    assert.deepStrictEqual(m.lines, ['Starting King Louie Node…']);
    assert.deepStrictEqual(ids(m), []);
  });

  it('running with no bridge: restart', () => {
    assert.strictEqual(ids(describeSetup(down({ running: true, pid: 4242 })))[0], 'nodeRestart');
  });

  it('a task gone: Install from here; refused and failed rows say so as an error', () => {
    assert.strictEqual(ids(describeSetup(down({ task: 'missing' })))[0], 'nodeInstallPreview');
    const other = describeSetup(down({ task: 'other-account' }));
    assert.strictEqual(other.error.code, 'NODE_TASK_OTHER_ACCOUNT');
    assert.match(text(other), /[Ss]ign in/);
    assert.ok(!ids(other).includes('nodeStart'));
    const failed = describeSetup(down({ startError: { code: 'NODE_START_FAILED', message: 'service failed to start\u0007' } }));
    assert.strictEqual(failed.error.code, 'NODE_START_FAILED');
    assert.ok(failed.error.message.includes(MARK));
    assert.strictEqual(ids(failed)[0], 'nodeStart');
  });

  it('a start refused for its task: the help while the task still says so, no Start it would refuse', () => {
    const m = describeSetup(down({ task: 'disabled', startError: { code: 'NODE_TASK_DISABLED', message: 'disabled' } }));
    assert.strictEqual(m.error.code, 'NODE_TASK_DISABLED');
    assert.deepStrictEqual(ids(m), ['retry']);
    assert.match(text(m), /Enable/);
  });

  it('a task-coded startError the task as read now disagrees with is over: Start, as told', () => {
    for (const code of ['NODE_TASK_DISABLED', 'NODE_TASK_OTHER_ACCOUNT', 'NODE_TASK_MISSING', 'NODE_TASK_UNREADABLE']) {
      const m = describeSetup(down({ task: 'registered', startError: { code, message: 'old' } }));
      assert.strictEqual(m.error, null, code);
      assert.strictEqual(ids(m)[0], 'nodeStart', code);
      assert.ok(!ids(m).includes('nodeInstallPreview'), code);
      assert.ok(m.lines.includes('King Louie Node is not running.'), code);
    }
  });

  it('the task as read now decides over a start failure that says otherwise', () => {
    const m = describeSetup(down({ task: 'disabled', startError: { code: 'NODE_START_FAILED', message: 'bad' } }));
    assert.strictEqual(m.error.code, 'NODE_TASK_DISABLED');
    assert.ok(!ids(m).includes('nodeStart'));
  });

  it('a timeout is not a dead end: a press to try again and the way to the pane', () => {
    const m = describeSetup(down({ startError: { code: 'NODE_START_TIMEOUT', message: 'King Louie Node did not answer within 60 seconds.' } }));
    assert.strictEqual(m.error.code, 'NODE_START_TIMEOUT');
    assert.deepStrictEqual(ids(m), ['nodeStart', 'retry', 'openServiceSettings']);
  });

  it('a bridge code waiting will not change names what helps, not a retry', () => {
    for (const [code, re] of [['DEVICE_UNPAIRED', /Unpair/], ['SERVICE_KEY_CHANGED', /Unpair/], ['PROTOCOL_MISMATCH', /[Rr]estart/], ['TOO_MANY_WINDOWS', /[Tt]oo many windows/]]) {
      const m = describeSetup(down({ running: true }, { connection: { status: 'disconnected', code, error: 'said\u0007' } }));
      assert.strictEqual(m.step, 'start');
      assert.strictEqual(m.error.code, code);
      assert.ok(m.error.message.includes(MARK));
      assert.match(text(m), re);
      assert.ok(ids(m).includes('openServiceSettings'));
    }
  });
});

describe('describeSetup: migrate', () => {
  const at = (extra = {}) => attachedUp({ oldProfile: OLD, ...extra });

  it('before the plan: what was found, one press to see the plan, Not now beside it', () => {
    const m = describeSetup(at());
    assert.strictEqual(m.step, 'migrate');
    assert.deepStrictEqual(ids(m), ['migrationPlan', 'setupLater']);
    assert.match(text(m), /3 chats/);
    assert.match(text(m), /120 messages/);
    assert.match(text(m), /2 cases/);
    assert.match(text(m), /5\.0 MB/);
    assert.strictEqual(m.canPostpone, true);
  });

  it('the plan: the backup path, the counts and every staysBehind line, through shown, and Move everything', () => {
    const odd = 'Browser\u0007 profiles stay';
    const answer = planAnswer({ staysBehind: [...planAnswer().staysBehind, odd] });
    answer.backup.dest = 'C:\\Users\\owner\\king\u202e-louie.backup-1';
    const m = describeSetup(at({ migrationPlan: answer }));
    assert.deepStrictEqual(ids(m), ['migrationApply', 'setupLater']);
    assert.strictEqual(m.actions[0].label, 'Move everything');
    const all = m.lines.join('\n');
    assert.ok(all.includes(`king-louie.backup-1 ${MARK}`), all);
    assert.doesNotMatch(all, /\u202e|\u0007/);
    assert.ok(all.includes('5.0 MB'));
    assert.match(all, /5 new/);
    assert.match(all, /2 already on the node/);
    assert.match(all, /Chats: 1 new, 1 copied/);
    assert.match(all, /Cases: 1 new, 1 needs attention/);
    for (const line of planAnswer().staysBehind) assert.ok(m.lines.some((l) => l.includes(line)), line);
    assert.ok(all.includes(`Browser profiles stay ${MARK}`));
    assert.match(all, /other-lot/);
    assert.match(all, /already on the node/);
    assert.match(all, /Stays on this computer/);
    assert.match(all, /[Nn]othing is removed/);
  });

  it('the private note, dirty cases, refused files, secrets: on screen with the plan', () => {
    const answer = planAnswer({
      refusedFiles: 2,
      leftBehind: { needsAttention: [{ category: 'case', key: 'lot/odd\u0007file', note: 'not read' }], secrets: [{ category: 'vault', key: 'site-login', note: null }] }
    });
    answer.plan.private = { chats: 2, cases: 1, note: '2 private chats and 1 private case stay private.' };
    answer.plan.dirtyCases = [{ key: 'busy-lot', note: 'it has changes not committed' }];
    const m = describeSetup(at({ migrationPlan: answer }));
    const all = m.lines.join('\n');
    assert.ok(all.includes('2 private chats and 1 private case stay private.'));
    assert.ok(all.includes('Case busy-lot: it has changes not committed'), all);
    assert.match(all, /2 files/);
    assert.ok(all.includes(MARK));
    assert.match(all, /Vault entry site-login/);
    assert.ok(ids(m).includes('migrationApply'));
  });

  it('a held case: the move cannot be pressed; the screen says what to do', () => {
    const m = describeSetup(at({ migrationPlan: planAnswer({ heldCases: [{ category: 'case', key: 'nested-lot', note: 'it holds another repository' }] }) }));
    assert.ok(!ids(m).includes('migrationApply'));
    assert.deepStrictEqual(ids(m), ['migrationPlan', 'setupLater']);
    assert.strictEqual(m.error.code, 'MIGRATION_SOURCE');
    assert.match(text(m), /nested-lot/);
    assert.match(text(m), /holds another repository/);
    assert.match(text(m), /Plan again/);
  });

  it('a custom cases root holding cases: no way to press the move, before or after the plan', () => {
    const custom = { ...OLD, customCasesRoot: 'D:\\kept\\ca\u0007ses', customCases: 4 };
    const before = describeSetup(at({ oldProfile: custom }));
    assert.deepStrictEqual(ids(before), ['retry', 'setupLater']);
    assert.strictEqual(before.error.code, 'MIGRATION_SOURCE');
    assert.ok(before.error.message.includes(MARK));
    assert.match(before.error.message, /4 cases/);
    const named = describeSetup(at({ oldProfile: custom, profileDir: 'C:\\Users\\owner\\AppData\\Roaming\\king-louie' }));
    assert.ok(named.error.message.includes('C:\\Users\\owner\\AppData\\Roaming\\king-louie\\cases'), named.error.message);
    const posix = describeSetup(at({ oldProfile: custom, profileDir: '/home/owner/.config/king-louie' }));
    assert.ok(posix.error.message.includes('/home/owner/.config/king-louie/cases'), posix.error.message);
    assert.match(text(before), /Check again/);

    const answer = planAnswer();
    answer.backup.customCasesRoot = 'D:\\kept\\cases';
    answer.backup.customCases = 4;
    const after = describeSetup(at({ migrationPlan: answer }));
    assert.ok(!ids(after).includes('migrationApply'));

    // The profile read after the plan was made still holds the press back.
    const later = describeSetup(at({ oldProfile: custom, migrationPlan: planAnswer() }));
    assert.ok(!ids(later).includes('migrationApply'));
    assert.strictEqual(later.error.code, 'MIGRATION_SOURCE');

    const unknown = describeSetup(at({ oldProfile: { ...OLD, customCasesRoot: 'D:\\kept', customCases: null } }));
    assert.ok(!ids(unknown).includes('migrationPlan'));
    assert.match(unknown.error.message, /could not be read/);

    const empty = describeSetup(at({ oldProfile: { ...OLD, customCasesRoot: 'D:\\kept', customCases: 0 } }));
    assert.deepStrictEqual(ids(empty), ['migrationPlan', 'setupLater']);
  });

  it('a store the reader refuses: shows it, Retry and Skip for now, nothing else', () => {
    const m = describeSetup(at({ oldProfile: { found: true, chats: 0, messages: 0, cases: 0, bytes: 0, schemaProblem: 'store\u0007 refused' } }));
    assert.strictEqual(m.step, 'migrate');
    assert.strictEqual(m.error.code, 'MIGRATION_SOURCE');
    assert.ok(m.error.message.includes(MARK));
    assert.deepStrictEqual(m.actions, [{ id: 'retry', label: 'Retry' }, { id: 'skip', label: 'Skip for now' }]);
  });

  const refusals = [
    ['MIGRATION_SOURCE', 'The old profile did not read whole, so nothing was moved: x', 'migrationPlan', 'Plan again'],
    ['BACKUP_FAILED', 'The backup failed.', 'migrationPlan', 'Try again'],
    ['PLAN_EXPIRED', 'The plan for this move expired; plan it again.', 'migrationPlan', 'Plan again'],
    ['IMPORT_FAILED', 'the node dropped', 'migrationPlan', 'Try again']
  ];
  for (const [code, error, id, label] of refusals) {
    it(`${code} from either press: its words and what can help`, () => {
      for (const key of ['migrationPlan', 'migrationResult']) {
        const m = describeSetup(at({ [key]: { ok: false, code, error } }));
        assert.strictEqual(m.step, 'migrate');
        assert.strictEqual(m.error.code, code);
        assert.strictEqual(m.error.message, error);
        assert.strictEqual(m.actions[0].id, id);
        assert.strictEqual(m.actions[0].label, label);
        assert.ok(!ids(m).includes('migrationApply'));
      }
    });
  }

  it('BACKUP_FAILED names the half-made folder', () => {
    const m = describeSetup(at({ migrationPlan: { ok: false, code: 'BACKUP_FAILED', error: 'copy failed', backupDir: 'C:\\b\\half' } }));
    assert.ok(m.lines.some((l) => l.includes('C:\\b\\half')));
  });

  it('MIGRATION_BUSY: wait; the one press only looks again', () => {
    const m = describeSetup(at({ migrationResult: { ok: false, code: 'MIGRATION_BUSY', error: 'The move of this profile is running; wait for it to finish.' } }));
    assert.deepStrictEqual(m.actions, [{ id: 'retry', label: 'Check again' }]);
    assert.strictEqual(m.canPostpone, false);
    assert.match(m.error.message, /wait/);
  });

  it('MIGRATION_UNVERIFIED: each item and why, the report, what is left behind; no claim that trying again fixes it', () => {
    const m = describeSetup(at({
      migrationResult: {
        ok: false,
        code: 'MIGRATION_UNVERIFIED',
        error: '1 item on the node does not match the desktop.',
        verified: { ok: false, missing: [{ category: 'chat', key: 'c-1', why: 'it is not on\u0007 the node' }] },
        report: { counts: { new: 4, failed: 1 }, failures: [{ category: 'chat', key: 'c-1', error: 'no' }], notes: ['Restart the node.'] },
        leftBehind: { needsAttention: [{ category: 'case', key: 'lot', note: 'look at it' }], secrets: [{ category: 'vault', key: 'k', note: null }] },
        refusedFiles: 0
      }
    }));
    assert.strictEqual(m.error.code, 'MIGRATION_UNVERIFIED');
    const all = m.lines.join('\n');
    assert.match(all, /Chat c-1/);
    assert.ok(all.includes(MARK));
    assert.match(all, /Restart the node\./);
    assert.match(all, /Case lot: look at it/);
    assert.match(all, /Vault entry k/);
    assert.deepStrictEqual(ids(m), ['migrationPlan', 'setupLater']);
    assert.strictEqual(m.actions[0].label, 'Plan the move again');
  });

  it('MIGRATION_MARK_FAILED: the move is on the node; try again is real', () => {
    const m = describeSetup(at({ migrationResult: { ok: false, code: 'MIGRATION_MARK_FAILED', error: 'The move is on the node, but this profile could not be marked as moved (disk). Try again.', report: { counts: { new: 1 } }, leftBehind: { needsAttention: [], secrets: [] } } }));
    assert.strictEqual(m.error.code, 'MIGRATION_MARK_FAILED');
    assert.strictEqual(m.actions[0].id, 'migrationPlan');
    assert.strictEqual(m.actions[0].label, 'Try again');
  });

  it('a step in progress: its line and no press', () => {
    const m = describeSetup(at({ setupProgress: 'Making the backup\u0007…' }));
    assert.deepStrictEqual(ids(m), []);
    assert.strictEqual(m.canPostpone, false);
    assert.ok(m.lines[0].includes(MARK));
  });
});

describe('describeSetup: after the move, what stayed is on screen up to Done', () => {
  const MARKER = {
    at: '2026-11-04T10:00:00.000Z',
    backupDir: 'C:\\Users\\owner\\king-louie.backup-1',
    nodeId: 'kl-abc',
    counts: { chats: 3, cases: 2, attention: 1 },
    leftBehind: { needsAttention: [{ category: 'case', key: 'other-lot', note: 'already on the node' }], secrets: [{ category: 'vault', key: 'site-login', note: null }] },
    private: { chats: 1, cases: 0, note: '1 private chat stays private.' },
    staysBehind: ['Browser profiles: log in again in the node\'s browser.'],
    notes: ['Cron jobs were imported disabled.']
  };
  const service = (providersConfigured) => ({ hosting: 'personal', providersConfigured });
  const stages = [
    ['provider', { service: service(false) }],
    ['profile', { userProfileDefault: true }],
    ['phone', { userProfileDefault: false }],
    ['done', { userProfileDefault: false, setup: { completedAt: null, phoneSeen: true } }]
  ];
  for (const [step, extra] of stages) {
    it(`${step}: the backup, what is left behind and the private note, not behind a click`, () => {
      const m = describeSetup(attachedUp({ oldProfile: OLD, migration: MARKER, ...extra }));
      assert.strictEqual(m.step, step);
      const all = m.lines.join('\n');
      assert.match(all, /2026-11-04/);
      assert.ok(all.includes(MARKER.backupDir));
      assert.match(all, /Case other-lot: already on the node/);
      assert.match(all, /Vault entry site-login/);
      assert.ok(all.includes('1 private chat stays private.'));
      assert.ok(all.includes('Browser profiles'));
      assert.ok(all.includes('Cron jobs were imported disabled.'), 'the notes outlast a relaunch');
      assert.strictEqual(m.canPostpone, false);
    });
  }

  it('a marker from before these fields still draws', () => {
    const m = describeSetup(attachedUp({ migration: { at: 'x', backupDir: 'C:\\b' }, userProfileDefault: false }));
    assert.strictEqual(m.step, 'phone');
  });
});

describe('describeSetup: provider, profile, phone, done', () => {
  it('provider and profile: the form is the next action; the words say what it is for', () => {
    const p = describeSetup(attachedUp({ service: { hosting: 'personal', providersConfigured: false } }));
    assert.strictEqual(p.step, 'provider');
    assert.match(text(p), /key/);
    const q = describeSetup(attachedUp({ userProfileDefault: true }));
    assert.strictEqual(q.step, 'profile');
    assert.match(text(q), /name/);
  });

  it('phone: the commands for a terminal, stop first, Skip, and nothing run', () => {
    const m = describeSetup(attachedUp({ userProfileDefault: false }));
    assert.strictEqual(m.step, 'phone');
    assert.deepStrictEqual(m.actions, [{ id: 'skip', label: 'Skip' }]);
    assert.match(m.pre, /^node bin\\king-louie-service\.js stop/m);
    assert.match(m.pre, /^node bin\\king-louie-service\.js pair wss:\/\/<relay>/m);
    assert.match(m.pre, /^node bin\\king-louie-service\.js pair https:\/\/mcp\.<domain>/m);
    assert.match(m.pre, /^node bin\\king-louie-service\.js enroll-device/m);
    assert.match(m.lines.join(' '), /in the folder King Louie Node was installed from/);
    assert.doesNotMatch(m.pre, /^king-louie-service/m, 'that name is on no PATH');
  });

  it('phone: a checkout install whose task was read names its script in full', () => {
    const entry = 'C:\\work\\my checkout\\bin\\king-louie-service.js';
    const m = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, taskEntry: entry, defaultDataDir: NODE.dataDir } }));
    assert.strictEqual(m.pre.split('\n')[0], `node "${entry}" stop`);
    assert.doesNotMatch(m.lines.join(' '), /installed from/);
  });

  it('a restart the move left owed is a press with Later, on the steps after the move', () => {
    const migration = { at: '2026-11-04T10:00:00.000Z', backupDir: 'C:\\b', restartDue: true };
    const m = describeSetup(attachedUp({ userProfileDefault: false, migration }));
    assert.deepStrictEqual(m.actions.slice(0, 2), [{ id: 'nodeRestart', label: 'Restart King Louie Node now' }, { id: 'restartLater', label: 'Later' }]);
    const none = describeSetup(attachedUp({ userProfileDefault: false, migration: { ...migration, restartDue: undefined } }));
    assert.ok(!none.actions.some((a) => a.id === 'restartLater'));
  });

  it('a task whose program is gone goes to install, unpaired, with the words and the press', () => {
    const m = describeSetup(base({ launch: { host: 'attached', why: 'needs-node', degraded: false }, node: { ...NODE, personal: true, programGone: 'C:\\gone\\node.exe' } }));
    assert.strictEqual(m.step, 'install');
    assert.ok(m.lines.join(' ').includes('C:\\gone\\node.exe'));
    assert.deepStrictEqual(m.actions.map((a) => a.id).filter((id) => id !== 'setupLater'), ['nodeInstallPreview']);
    assert.strictEqual(m.error.code, 'NODE_TASK_PROGRAM_GONE');
  });

  it('a profile found for its keys and settings says so', () => {
    const m = describeSetup(attachedUp({ oldProfile: { ...OLD, chats: 0, messages: 0, cases: 0, keysOrSettings: true } }));
    assert.match(m.lines[0], /and your keys and settings/);
  });

  it('phone: the launcher the install wrote, in full and quoted; with none, the plain name', () => {
    const cli = 'C:\\Users\\Al Smith\\AppData\\Local\\KingLouie\\node\\king-louie-service.cmd';
    const m = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, serviceCli: cli, defaultDataDir: NODE.dataDir } }));
    assert.deepStrictEqual(m.pre.split('\n'), [
      `"${cli}" stop`,
      `"${cli}" pair wss://<relay>`,
      `"${cli}" pair https://mcp.<domain>`,
      `"${cli}" enroll-device`
    ]);
    assert.match(text(m), /Command Prompt/);
    const flagged = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, serviceCli: cli } }));
    assert.ok(flagged.pre.startsWith(`"${cli}" stop --data-dir "${NODE.dataDir}"`), flagged.pre);
    const odd = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, serviceCli: 'C:\\od\u0007d.cmd' } }));
    assert.doesNotMatch(odd.pre, /\u0007/);
    assert.ok(odd.pre.includes(MARK));
  });

  it('phone stays on screen once offered: the stop it asks for does not take its commands away', () => {
    const stopped = base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-disconnected', pairing: PAIRING, service: { hosting: 'personal', providersConfigured: true }, connection: { status: 'disconnected' }, node: NODE, setup: { completedAt: null, phoneOffered: true } });
    const m = describeSetup(stopped);
    assert.strictEqual(m.step, 'phone');
    assert.match(m.pre, /pair wss/);
    assert.match(m.pre, /enroll-device/);
    assert.deepStrictEqual(ids(m), ['nodeStart', 'skip']);
    assert.match(text(m), /pair starts it again/);
    assert.strictEqual(nextSetupStep(setupFacts(stopped)), 'phone');
    assert.strictEqual(nextSetupStep(setupFacts({ ...stopped, setup: { phoneOffered: true, phoneSeen: true } })), 'start', 'skipped, the node still has to come up');
    assert.strictEqual(nextSetupStep(setupFacts({ ...stopped, setup: { phoneOffered: false } })), 'start', 'never offered: start as ever');
    assert.deepStrictEqual(ids(describeSetup({ ...stopped, node: { ...NODE, starting: true } })), ['skip']);
    assert.deepStrictEqual(ids(describeSetup({ ...stopped, node: { ...NODE, running: true, pid: 7 } })), ['skip']);
  });

  it('phone: Done once a phone is enrolled, Skip before', () => {
    const m = describeSetup(attachedUp({ userProfileDefault: false, approvals: { available: true, devices: [{ device_id: 'd', active: true }] } }));
    assert.deepStrictEqual(m.actions, [{ id: 'skip', label: 'Done' }]);
    const inactive = describeSetup(attachedUp({ userProfileDefault: false, approvals: { available: true, devices: [{ device_id: 'd', active: false }] } }));
    assert.deepStrictEqual(inactive.actions, [{ id: 'skip', label: 'Skip' }]);
  });

  it('phone: says what a Telegram or Discord bot does with no phone', () => {
    const m = describeSetup(attachedUp({ userProfileDefault: false }));
    assert.match(text(m), /Telegram or Discord/);
    assert.match(text(m), /refused/);
  });

  it('phone: --data-dir only when the data dir is not the default; an unknown default names it', () => {
    const dir = NODE.dataDir;
    const named = describeSetup(attachedUp({ userProfileDefault: false }));
    assert.ok(named.pre.split('\n').filter((l) => l.startsWith('king-louie-service')).every((l) => l.includes(`--data-dir "${dir}"`)), named.pre);
    const atDefault = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, defaultDataDir: `${dir.toUpperCase()}\\` } }));
    assert.doesNotMatch(atDefault.pre, /--data-dir/);
    const elsewhere = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, defaultDataDir: 'C:\\other' } }));
    assert.match(elsewhere.pre, /--data-dir/);
    const odd = describeSetup(attachedUp({ userProfileDefault: false, node: { ...NODE, dataDir: 'C:\\od\u0007d' }, pairing: { service: { ...PAIRING.service, dataDir: 'C:\\od\u0007d' } } }));
    assert.doesNotMatch(odd.pre, /\u0007/);
    assert.ok(odd.pre.includes(MARK));
  });

  it('done, not yet finished: one press; done and finished: nothing to draw', () => {
    const finish = describeSetup(attachedUp({ userProfileDefault: false, setup: { completedAt: null, phoneSeen: true } }));
    assert.strictEqual(finish.step, 'done');
    assert.deepStrictEqual(ids(finish), ['setupFinish']);
    const finished = describeSetup(attachedUp({ setup: { completedAt: '2026-11-03T00:00:00Z' } }));
    assert.strictEqual(finished.step, 'done');
    assert.deepStrictEqual(ids(finished), []);
    assert.deepStrictEqual(finished.lines, []);
    assert.strictEqual(finished.error, null);
  });

  it('a standalone launch and a fleet pairing draw nothing', () => {
    for (const s of [
      { launch: { host: 'standalone', why: 'dev' }, node: { fresh: true }, oldProfile: OLD },
      base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-connected', pairing: { service: { fingerprint: 'x' } }, service: { hosting: 'service', providersConfigured: false }, connection: { status: 'connected' } })
    ]) {
      const m = describeSetup(s);
      assert.strictEqual(m.step, 'done');
      assert.deepStrictEqual(ids(m), []);
      assert.deepStrictEqual(m.lines, []);
      assert.strictEqual(m.canPostpone, false);
    }
  });

  it('a refusal from another press shows on the step it happened on, through shown', () => {
    const m = describeSetup(attachedUp({ userProfileDefault: false, setupError: { code: 'NOT_POSTPONABLE', error: 'no\u0007' } }));
    assert.strictEqual(m.step, 'phone');
    assert.strictEqual(m.error.code, 'NOT_POSTPONABLE');
    assert.ok(m.error.message.includes(MARK));
    assert.deepStrictEqual(ids(m), ['skip']);
  });
});

describe('codes and words that are data', () => {
  it('a code or an action named after an Object.prototype key is only a word', () => {
    const c = describeSetup(base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-disconnected', pairing: PAIRING, node: NODE, connection: { status: 'disconnected', code: 'constructor', error: 'e' } }));
    assert.strictEqual(c.error, null);
    assert.strictEqual(ids(c)[0], 'nodeStart');
    const t = describeSetup(base({ node: { ...NODE, task: 'constructor' } }));
    assert.doesNotMatch(text(t), /function|native code/);
    const p = describeSetup(attachedUp({ oldProfile: OLD, migrationPlan: planAnswer({ plan: { counts: { constructor: 1, toString: 2 }, items: [{ category: 'constructor', action: 'hasOwnProperty' }, { category: 'chat', action: 'constructor' }] } }) }));
    const all = p.lines.join('\n');
    assert.doesNotMatch(all, /function|native code/);
    assert.match(all, /1 constructor/);
    assert.match(all, /constructor: 1 hasOwnProperty/);
    assert.match(all, /Chats: 1 constructor/);
    const r = describeSetup(attachedUp({ oldProfile: OLD, migrationResult: { ok: false, code: 'constructor', error: 'x' } }));
    assert.strictEqual(r.actions[0].label, 'Try again');
  });
});

describe('every state has a next action or says there is none', () => {
  it('no state with no press and no words', () => {
    const statuses = [
      base({ node: { fresh: true } }), base({ node: NODE }), base({ node: null }),
      ...['missing', 'disabled', 'other-account', 'unknown'].map((task) => base({ node: { ...NODE, task } })),
      ...['missing', 'disabled', 'other-account', 'unknown', 'registered'].map((task) => base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-disconnected', pairing: PAIRING, node: { ...NODE, task } })),
      base({ launch: LAUNCH_ATTACHED, mode: 'attached', view: 'attached-disconnected', pairing: PAIRING, node: null }),
      attachedUp({ oldProfile: OLD }),
      attachedUp({ service: { hosting: 'personal', providersConfigured: false } }),
      attachedUp({ userProfileDefault: true }),
      attachedUp({ userProfileDefault: false })
    ];
    for (const s of statuses) {
      const m = describeSetup(s);
      assert.ok(m.lines.length || m.error, JSON.stringify(s));
      // Provider and profile: the wizard's form on screen is the next action.
      if (!['provider', 'profile'].includes(m.step)) assert.ok(m.actions.length, `no press on ${m.step}: ${JSON.stringify(s)}`);
    }
  });
});

describe('describeSetup: what the window draws at the form steps', () => {
  const noKey = { service: { hosting: 'personal', providersConfigured: false } };

  it('provider and profile name their form, and a way past it', () => {
    const p = describeSetup(attachedUp(noKey));
    assert.strictEqual(p.step, 'provider');
    assert.strictEqual(p.form, 'provider');
    assert.deepStrictEqual(ids(p), ['setupFinish']);
    const q = describeSetup(attachedUp({ userProfileDefault: true }));
    assert.strictEqual(q.form, 'profile');
    assert.deepStrictEqual(ids(q), ['setupFinish']);
  });

  it('the provider line says where Ollama and local servers go', () => {
    const line = describeSetup(attachedUp(noKey)).lines.join(' ');
    assert.match(line, /Ollama.*Settings › Providers & keys/);
    assert.match(line, /Local servers .*service\.json/);
  });

  it('no form while a progress line is up, or on any other step', () => {
    assert.strictEqual(describeSetup(attachedUp({ ...noKey, setupProgress: 'Restarting…' })).form, null);
    assert.strictEqual(describeSetup(attachedUp()).form, null);
    assert.strictEqual(describeSetup({}).form, null);
  });

  it('a restart that failed after the move has a press, once', () => {
    const failed = { code: 'NODE_START_FAILED', error: 'King Louie Node did not restart after the move (no).', offerRestart: true };
    const m = describeSetup(attachedUp({ userProfileDefault: true, migration: { at: 'x', backupDir: 'C:\\b' }, setupError: failed }));
    assert.strictEqual(m.step, 'profile');
    assert.match(m.error.message, /did not restart/);
    assert.strictEqual(ids(m)[0], 'nodeRestart');
    const down = describeSetup(attachedUp({ connection: { status: 'disconnected' }, setupError: failed, node: { personal: true, task: 'registered', running: true } }));
    assert.strictEqual(down.step, 'start');
    assert.strictEqual(ids(down).filter((id) => id === 'nodeRestart' || id === 'nodeStart').length, 1);
  });

  it('another refusal brings no such press', () => {
    const m = describeSetup(attachedUp({ userProfileDefault: true, setupError: { code: 'X', error: 'no' } }));
    assert.deepStrictEqual(ids(m), ['setupFinish']);
  });
});

describe('every plan category has the owner\'s words', () => {
  const { CATEGORY_ORDER } = require('../src/migration/desktop-import');
  const { categoryWord } = require('../src/desktop-bridge/setup-flow');

  it('each one, both forms, and none is the code', () => {
    for (const category of CATEGORY_ORDER) {
      for (const many of [true, false]) {
        const word = categoryWord(category, many);
        assert.notStrictEqual(word, category, category);
        assert.match(word, /^[A-Z][a-z]/, `${category}: ${word}`);
      }
    }
  });

  it('the screen shows them in the counts and in what is left behind', () => {
    const items = CATEGORY_ORDER.map((category) => ({ category, key: `k-${category}`, action: 'new', note: null, targetKey: null }));
    const answer = planAnswer({ plan: { ...planAnswer().plan, items }, leftBehind: { needsAttention: [{ category: 'allowedDirectory', key: 'C:\\d', note: 'n' }], secrets: [{ category: 'providerToken', key: 'anthropic', note: 'n' }] } });
    const shownText = text(describeSetup(attachedUp({ oldProfile: OLD, migrationPlan: answer })));
    for (const raw of ['providerToken', 'alwaysApprove', 'allowedDirectory', 'userProfile', 'permissionRule', 'channelAllowlist', 'anthropicOAuth']) {
      assert.ok(!new RegExp(`${raw}:|${raw} `).test(shownText), `${raw} shows raw: ${shownText}`);
    }
    assert.match(shownText, /Provider key anthropic/);
    assert.match(shownText, /Provider keys: 1 new/);
  });

  it('something that is no category is plain text, never a table lookup', () => {
    assert.strictEqual(categoryWord('constructor', true), 'constructor');
  });
});

describe('the install step says boot (boot-node-tray spec 5.5)', () => {
  it('names the boot task, the one administrator prompt and that no password is stored', () => {
    const answer = describeSetup(base({ node: { ...NODE, task: 'missing' } }));
    const text = answer.lines.join(' ');
    assert.match(text, /starts it at boot, before you sign in/);
    assert.match(text, /one administrator prompt/);
    assert.match(text, /No password is stored/);
    assert.match(text, /signed in with King Louie in the tray/);
    assert.doesNotMatch(text, /logon task/);
  });

  it('a declined prompt is the CLI sentence', () => {
    const answer = describeSetup(base({ node: { ...NODE, task: 'missing' }, installResult: { ok: false, code: 'NODE_INSTALL_DECLINED', message: 'Windows did not register the task: the administrator prompt was declined. Nothing was registered or started.', lines: [] } }));
    assert.strictEqual(answer.error.code, 'NODE_INSTALL_DECLINED');
    assert.strictEqual(answer.error.message, 'Windows did not register the task: the administrator prompt was declined. Nothing was registered or started.');
  });
});

// tests/desktop-pane.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  describeServicePane, describeImportReport, decideDetachClick, paneShapeChanged,
  describeAttachedBanner, describeInstallPreview, describeInstallResult,
  DETACH_CONFIRM_DELAY_MS, UNAVAILABLE_TAB_NOTICE
} = require('../src/desktop-bridge/pane-model');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ids = (model) => model.actions.map((a) => a.id);

describe('describeServicePane', () => {
  it('unpaired: no service found, Pair still allowed', () => {
    const m = describeServicePane({ view: 'unpaired', bridgeFile: '/etc/king-louie/desktop-bridge.json', bridge: { ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at /etc/king-louie.' } });
    assert.strictEqual(m.lines[0], 'No local service found at /etc/king-louie.');
    assert.match(m.lines[1], /king-louie-service/);
    assert.deepStrictEqual(ids(m), ['pair']);
  });

  it('unpaired with an untrusted file shows the refusal', () => {
    const m = describeServicePane({ view: 'unpaired', bridge: { ok: false, code: 'BRIDGE_FILE_UNTRUSTED', error: 'C:\\x is not owned by an administrator; refusing to trust it.' } });
    assert.strictEqual(m.lines[0], 'C:\\x is not owned by an administrator; refusing to trust it.');
  });

  it('pairing: request, command, both fingerprints, Confirm only once the service is found', () => {
    const waiting = describeServicePane({ view: 'pairing', pendingPair: { request: 'klpair1.x', command: 'sudo king-louie-service desktop pair klpair1.x', deviceFingerprint: 'abcd efgh ijkl mnop', service: null, error: null } });
    assert.strictEqual(waiting.request, 'klpair1.x');
    assert.strictEqual(waiting.command, 'sudo king-louie-service desktop pair klpair1.x');
    assert.ok(waiting.lines.includes('This desktop: abcd efgh ijkl mnop'));
    assert.deepStrictEqual(waiting.actions, [{ id: 'pairConfirm', label: 'Confirm', disabled: true }, { id: 'pairCancel', label: 'Cancel' }]);
    const found = describeServicePane({ view: 'pairing', pendingPair: { request: 'r', command: 'c', deviceFingerprint: 'a', service: { fingerprint: 'wxyz 2345 6789 abcd', port: 18796 } } });
    assert.ok(found.lines.includes('Service: wxyz 2345 6789 abcd (port 18796)'));
    assert.strictEqual(found.actions[0].disabled, false);
  });

  it('paired standalone: account warning and Import, Attach, Unpair', () => {
    const m = describeServicePane({ view: 'paired', pairing: { service: { fingerprint: 'wxyz 2345 6789 abcd' } }, service: { version: '26.9.0', account: 'LOCAL SERVICE' } });
    assert.ok(m.lines.includes('Service: wxyz 2345 6789 abcd'));
    assert.ok(m.lines.includes('Version 26.9.0, running as LOCAL SERVICE.'));
    assert.ok(m.lines.includes('Tools will run as LOCAL SERVICE.'));
    assert.deepStrictEqual(ids(m), ['import', 'attach', 'unpair']);
  });

  it('attached and connected: the no-provider line and the approvals section', () => {
    const m = describeServicePane({
      view: 'attached-connected', detachWarning: 'W', pairing: { service: { fingerprint: 'f' } },
      service: { version: '26.9.0', account: 'LOCAL SERVICE', providersConfigured: false },
      approvals: { available: false }
    });
    assert.ok(m.lines.includes('The service has no provider key yet — import or add one in Providers.'));
    assert.deepStrictEqual(ids(m), ['import', 'detach', 'unpair']);
    assert.strictEqual(m.detachWarning, 'W');
    assert.deepStrictEqual(m.approvals.lines, ['Phone approvals are not set up on this service.']);
    const full = describeServicePane({
      view: 'attached-connected', pairing: { service: { fingerprint: 'f' } }, service: { version: '26.9.0', account: 'LOCAL SERVICE' },
      approvals: { available: true, relay: { configured: true, connected: true, since: '2026-09-23T10:00:00Z', relay_id: 'kl-relayrelayrelay1' }, devices: [{ device_id: 'd-1', name: 'Phone', platform: 'android', active: true }], pending: [{ request_id: 'r-1', summary: 'Bash: ls', expires_at: '2026-09-23T10:05:00Z' }], audit: { last_seq: 12, last_at: '2026-09-23T10:01:00Z' } }
    });
    assert.deepStrictEqual(full.approvals.lines, [
      'Relay kl-relayrelayrelay1: connected since 2026-09-23T10:00:00Z',
      'Phone (android)',
      'Waiting: Bash: ls (until 2026-09-23T10:05:00Z)',
      'Audit ledger: entry 12 at 2026-09-23T10:01:00Z'
    ]);
    assert.deepStrictEqual(full.approvals.commands, ['king-louie-service enroll-device', 'king-louie-service device revoke <device-id>']);
  });

  it('attached, not connected: the error, Retry now, Use standalone this time, Detach', () => {
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: 'The local King Louie service is not reachable (127.0.0.1:18796).', nextRetryAt: null } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18796).');
    assert.deepStrictEqual(m.actions.map((a) => a.label), ['Retry now', 'Use standalone this time', 'Detach']);
  });

  it('attached, not connected, no connection.error: falls back using the paired service\'s own port', () => {
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: null, nextRetryAt: null }, pairing: { service: { port: 18888 } } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18888).');
  });

  it('attached, not connected, no connection.error and no known port: falls back to the default port', () => {
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: null, nextRetryAt: null } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18796).');
  });

  it('summarizes an import report', () => {
    const lines = describeImportReport({ counts: { new: 3, 'skip-present': 1, failed: 1 }, failures: [{ category: 'vault', key: 'github', error: 'Encryption unavailable in the service.' }], secretsMissing: [{ category: 'vault', key: 'github' }], attention: [], notes: ['1 cron job(s) were imported disabled; enable them in Settings > Scheduler.'], skipped: [] });
    assert.deepStrictEqual(lines, [
      'new: 3, skip-present: 1, failed: 1',
      'Failed: vault github — Encryption unavailable in the service.',
      'Secrets that did not arrive: vault github',
      '1 cron job(s) were imported disabled; enable them in Settings > Scheduler.'
    ]);
    assert.strictEqual(UNAVAILABLE_TAB_NOTICE, 'Managed by the local service; not available while attached.');
  });

  it('carries a pending service command across views (survives an unpair that changes the view)', () => {
    const withCommand = describeServicePane({ view: 'paired', pendingServiceCommand: { command: 'king-louie-service desktop unpair kld-abc', at: '2026-09-23T10:00:00Z' } });
    assert.deepStrictEqual(withCommand.serviceCommand, {
      command: 'king-louie-service desktop unpair kld-abc',
      line: 'Run this on the service to finish removing this desktop: king-louie-service desktop unpair kld-abc'
    });
    const withoutCommand = describeServicePane({ view: 'unpaired' });
    assert.strictEqual(withoutCommand.serviceCommand, null);
  });
});

// Personal node views (desktop attached to the personal node, spec §6.2, §6.4,
// §7.4, §8, §11). The statuses are hand-built in the §11 shape.
const node = (extra = {}) => ({
  hosting: 'personal', name: 'laptop-01', dataDir: 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\data',
  task: 'registered', running: false, pid: null, starting: false, startError: null, ...extra
});
const personalPairing = { service: { fingerprint: 'wxyz 2345 6789 abcd', port: 18796, hosting: 'personal', dataDir: 'C:\\x\\data' } };
const pairingWith = (pendingPair, extra = {}) => ({
  view: 'pairing', ...extra, node: node(extra.node),
  pendingPair: { request: 'klpair1.x', command: 'sudo king-louie-service desktop pair klpair1.x', deviceFingerprint: 'abcd efgh ijkl mnop', service: null, personal: true, error: null, ...pendingPair }
});
const STANDARD_DISCONNECTED = ['retry', 'standaloneOnce', 'detach'];

describe('describeServicePane: personal node', () => {
  it('unpaired with a personal node here: the two lines and Pair, the name through shown', () => {
    const m = describeServicePane({ view: 'unpaired', bridge: { ok: false, code: 'BRIDGE_FILE_MISSING', error: 'No local service found at C:\\x.' }, node: node() });
    assert.deepStrictEqual(m.lines, [
      'King Louie Node "laptop-01" runs on this computer as you.',
      'Every paired desktop sees every chat, setting and secret name in the node.'
    ]);
    assert.deepStrictEqual(ids(m), ['pair']);
    const odd = describeServicePane({ view: 'unpaired', node: node({ name: 'laptop\u202e-01' }) });
    assert.strictEqual(odd.lines[0], 'King Louie Node "laptop-01 [hidden or control characters removed]" runs on this computer as you.');
  });

  it('unpaired with no logon task: Install… beside Pair', () => {
    const m = describeServicePane({ view: 'unpaired', node: node({ task: 'missing' }) });
    assert.deepStrictEqual(m.actions, [{ id: 'pair', label: 'Pair' }, { id: 'nodeInstallPreview', label: 'Install…' }]);
  });

  it('pairing, personal: no request or command to copy, no Confirm while the CLI runs', () => {
    const m = describeServicePane(pairingWith({ stage: 'command' }));
    assert.strictEqual(m.request, null);
    assert.strictEqual(m.command, null);
    assert.ok(m.lines.includes('Pairing with King Louie Node "laptop-01"…'));
    assert.deepStrictEqual(ids(m), []);
  });

  it('pairing, personal, starting and confirming: their lines, no buttons', () => {
    const starting = describeServicePane(pairingWith({ stage: 'starting' }));
    assert.ok(starting.lines.includes('Starting King Louie Node…'));
    assert.deepStrictEqual(ids(starting), []);
    const confirming = describeServicePane(pairingWith({ stage: 'confirming' }));
    assert.ok(confirming.lines.includes('Checking the node\'s desktop bridge…'));
    assert.deepStrictEqual(ids(confirming), []);
  });

  it('pairing, personal, restart-needed: §6.2 step 4 and Restart and pair / Cancel', () => {
    const m = describeServicePane(pairingWith({ stage: 'restart-needed' }, { node: { running: true, pid: 4242 } }));
    assert.ok(m.lines.includes('King Louie Node is running (pid 4242). Pairing restarts it: a turn or a take in progress stops.'));
    assert.deepStrictEqual(m.actions, [{ id: 'pairRestartConfirm', label: 'Restart and pair' }, { id: 'pairCancel', label: 'Cancel' }]);
  });

  it('pairing, personal, a refusal: the §6.4 line per code, Try again and Cancel', () => {
    const lineFor = (error) => {
      const m = describeServicePane(pairingWith({ stage: 'command', error }));
      assert.deepStrictEqual(m.actions, [{ id: 'pair', label: 'Try again' }, { id: 'pairCancel', label: 'Cancel' }]);
      return m.lines.filter((l) => !l.startsWith('This desktop:'));
    };
    assert.deepStrictEqual(lineFor({ code: 'PAIR_ELEVATED', message: 'desktop pair on a personal node runs as you, not elevated: open a normal prompt' }),
      ['This app is running as administrator. Close it and open it normally to pair.']);
    assert.deepStrictEqual(lineFor({ code: 'PERSONAL_NOT_OWNER', message: 'C:\\x\\data is owned by S-1-5-21-1000-2000-3000-1002, not by you.' }),
      ['C:\\x\\data is owned by S-1-5-21-1000-2000-3000-1002, not by you.']);
    assert.deepStrictEqual(lineFor({ code: 'PAIR_COMMAND_FAILED', message: 'Error: spawn failed' }), ['Pairing did not finish: Error: spawn failed']);
    assert.deepStrictEqual(lineFor({ code: 'PAIR_COMMAND_FAILED', message: 'Pairing did not finish: timed out' }), ['Pairing did not finish: timed out']);
    assert.deepStrictEqual(lineFor({ code: 'PAIR_SERVICE_CHANGED', error: 'The service changed since you started pairing.' }), ['The service changed since you started pairing.']);
    assert.deepStrictEqual(lineFor({ code: 'BRIDGE_FILE_UNTRUSTED', message: 'C:\\x\\config\\desktop-bridge.json is a junction or link' }), ['C:\\x\\config\\desktop-bridge.json is a junction or link']);
    assert.deepStrictEqual(lineFor({ code: 'NODE_TASK_MISSING' }), ['King Louie Node has no logon task on this computer, so this app cannot start it.']);
    assert.deepStrictEqual(lineFor({ code: 'NODE_TASK_DISABLED' }), ['The logon task "KingLouie Node" is disabled in Task Scheduler. Enable it there to let this app start the node.']);
    assert.deepStrictEqual(lineFor({ code: 'NODE_TASK_OTHER_ACCOUNT' }), ['The logon task "KingLouie Node" belongs to another account; this app does not run it.']);
    assert.deepStrictEqual(lineFor({ code: 'NODE_START_TIMEOUT' }), ['King Louie Node did not answer within 60 seconds.']);
    assert.deepStrictEqual(lineFor({ code: 'NODE_START_FAILED', message: 'service failed to start: port in use' }), ['King Louie Node stopped while starting: service failed to start: port in use']);
    assert.deepStrictEqual(lineFor({ code: 'SECURE_STORAGE_UNAVAILABLE', message: 'Secure storage is not available.' }), ['Secure storage is not available.']);
    assert.deepStrictEqual(lineFor({ code: 'PAIR_COMMAND_FAILED', message: 'bad\u001b[2Jline' }), ['Pairing did not finish: bad[2Jline [hidden or control characters removed]']);
  });

  it('paired, personal: Running as you in place of the service-account line', () => {
    const m = describeServicePane({ view: 'paired', pairing: personalPairing, service: { version: '26.10.0', account: 'LAPTOP-01\\owner' }, node: node({ running: true, pid: 4242 }) });
    assert.ok(m.lines.includes('Running as you (LAPTOP-01\\owner), in your session.'));
    assert.ok(!m.lines.some((l) => l.startsWith('Tools will run as')));
    assert.deepStrictEqual(ids(m), ['import', 'attach', 'unpair']);
    const noAccount = describeServicePane({ view: 'paired', pairing: personalPairing, node: node() });
    assert.ok(noAccount.lines.includes('Running as you, in your session.'));
    assert.ok(!noAccount.lines.includes('Tools will run as the service account, not as you.'));
  });

  it('paired and attached, personal, no task: Install… added', () => {
    const paired = describeServicePane({ view: 'paired', pairing: personalPairing, node: node({ task: 'missing' }) });
    assert.deepStrictEqual(ids(paired), ['import', 'attach', 'unpair', 'nodeInstallPreview']);
    const attached = describeServicePane({ view: 'attached-connected', pairing: personalPairing, service: { version: '26.10.0', account: 'LAPTOP-01\\owner' }, node: node({ task: 'missing', running: true, pid: 4242 }) });
    assert.ok(attached.lines.includes('Running as you (LAPTOP-01\\owner), in your session.'));
    assert.deepStrictEqual(ids(attached), ['import', 'detach', 'unpair', 'nodeInstallPreview']);
  });

  it('attached-starting: Starting King Louie Node…, no buttons', () => {
    const m = describeServicePane({ view: 'attached-starting', pairing: personalPairing, node: node({ starting: true }), connection: { status: 'starting' } });
    assert.strictEqual(m.view, 'attached-starting');
    assert.deepStrictEqual(m.lines, ['Starting King Louie Node…']);
    assert.deepStrictEqual(m.actions, []);
  });

  it('attached-disconnected, personal: §7.4\'s line and added button for what was found', () => {
    const at = (n) => describeServicePane({ view: 'attached-disconnected', pairing: personalPairing, connection: { status: 'disconnected', error: 'The local King Louie service is not reachable (127.0.0.1:18796).' }, node: node(n) });
    const notRunning = at({ task: 'registered', running: false });
    assert.strictEqual(notRunning.lines[0], 'King Louie Node is not running.');
    assert.deepStrictEqual(notRunning.actions.slice(3), [{ id: 'nodeStart', label: 'Start King Louie Node' }]);
    assert.deepStrictEqual(ids(notRunning).slice(0, 3), STANDARD_DISCONNECTED);
    const running = at({ task: 'registered', running: true, pid: 4242 });
    assert.strictEqual(running.lines[0], 'King Louie Node is running (pid 4242) but its desktop bridge is not open.');
    assert.deepStrictEqual(running.actions.slice(3), [{ id: 'nodeRestart', label: 'Restart King Louie Node' }]);
    const failed = at({ startError: { code: 'NODE_START_FAILED', message: 'service failed to start: the instance lock is held' } });
    assert.strictEqual(failed.lines[0], 'King Louie Node stopped while starting: service failed to start: the instance lock is held');
    assert.deepStrictEqual(failed.actions.slice(3), [{ id: 'nodeStart', label: 'Start King Louie Node' }]);
    const timeout = at({ startError: { code: 'NODE_START_TIMEOUT', message: 'x' } });
    assert.strictEqual(timeout.lines[0], 'King Louie Node did not answer within 60 seconds.');
    assert.deepStrictEqual(ids(timeout), STANDARD_DISCONNECTED);
    const missing = at({ task: 'missing' });
    assert.strictEqual(missing.lines[0], 'King Louie Node has no logon task on this computer, so this app cannot start it.');
    assert.deepStrictEqual(missing.actions.slice(3), [{ id: 'nodeInstallPreview', label: 'Install…' }]);
    const disabled = at({ task: 'disabled' });
    assert.strictEqual(disabled.lines[0], 'The logon task "KingLouie Node" is disabled in Task Scheduler. Enable it there to let this app start the node.');
    assert.deepStrictEqual(ids(disabled), STANDARD_DISCONNECTED);
    const other = at({ task: 'other-account' });
    assert.strictEqual(other.lines[0], 'The logon task "KingLouie Node" belongs to another account; this app does not run it.');
    assert.deepStrictEqual(ids(other), STANDARD_DISCONNECTED);
    const taskCode = at({ task: 'unknown', startError: { code: 'NODE_TASK_DISABLED' } });
    assert.strictEqual(taskCode.lines[0], disabled.lines[0]);
    const unknown = at({ task: 'unknown', running: false });
    assert.strictEqual(unknown.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18796).');
    assert.deepStrictEqual(ids(unknown), STANDARD_DISCONNECTED);
  });

  it('a fleet status renders exactly as before, whatever node says', () => {
    const fleetPaired = { view: 'paired', pairing: { service: { fingerprint: 'f' } }, service: { version: '26.9.0', account: 'LOCAL SERVICE' }, node: null };
    const m = describeServicePane(fleetPaired);
    assert.deepStrictEqual(m.lines, ['Service: f', 'Version 26.9.0, running as LOCAL SERVICE.', 'Tools will run as LOCAL SERVICE.']);
    assert.deepStrictEqual(ids(m), ['import', 'attach', 'unpair']);
    const disc = describeServicePane({ view: 'attached-disconnected', pairing: { service: { port: 18796 } }, connection: { error: 'E' }, node: null });
    assert.deepStrictEqual(disc.lines, ['E']);
    assert.deepStrictEqual(ids(disc), STANDARD_DISCONNECTED);
    const pairing = describeServicePane({ view: 'pairing', pendingPair: { request: 'r', command: 'c', deviceFingerprint: 'a', service: null, error: null } });
    assert.strictEqual(pairing.command, 'c');
    assert.deepStrictEqual(ids(pairing), ['pairConfirm', 'pairCancel']);
  });
});

describe('describeAttachedBanner', () => {
  const base = { pairing: personalPairing, connection: { status: 'disconnected', error: 'The local King Louie service is not reachable (127.0.0.1:18796).' } };
  const FLEET_IDS = ['retry', 'standaloneOnce', 'openServiceSettings'];

  it('no banner while connected, unpaired or standalone', () => {
    assert.strictEqual(describeAttachedBanner({ view: 'attached-connected' }), null);
    assert.strictEqual(describeAttachedBanner({ view: 'unpaired' }), null);
    assert.strictEqual(describeAttachedBanner(null), null);
  });

  it('attached-starting: the starting line and no buttons', () => {
    assert.deepStrictEqual(describeAttachedBanner({ ...base, view: 'attached-starting', node: node({ starting: true }) }), { line: 'Starting King Louie Node…', actions: [] });
  });

  it('fleet: today\'s line and three buttons', () => {
    const b = describeAttachedBanner({ view: 'attached-disconnected', connection: { error: 'E' }, node: null });
    assert.strictEqual(b.line, 'E');
    assert.deepStrictEqual(b.actions, [
      { id: 'retry', label: 'Retry now' }, { id: 'standaloneOnce', label: 'Use standalone this time' }, { id: 'openServiceSettings', label: 'Local service settings' }
    ]);
    assert.strictEqual(describeAttachedBanner({ view: 'attached-disconnected' }).line, 'The local King Louie service is not reachable.');
  });

  it('personal: the §7.4 rows, the three buttons kept and one added', () => {
    const b = (n) => describeAttachedBanner({ ...base, view: 'attached-disconnected', node: node(n) });
    const start = b({ task: 'registered', running: false });
    assert.strictEqual(start.line, 'King Louie Node is not running.');
    assert.deepStrictEqual(start.actions.map((a) => a.id), [...FLEET_IDS, 'nodeStart']);
    assert.strictEqual(start.actions[3].label, 'Start King Louie Node');
    assert.deepStrictEqual(b({ running: true, pid: 4242 }).actions[3], { id: 'nodeRestart', label: 'Restart King Louie Node' });
    assert.deepStrictEqual(b({ task: 'missing' }).actions[3], { id: 'openServiceSettings', label: 'Install…' });
    assert.deepStrictEqual(b({ task: 'disabled' }).actions.map((a) => a.id), FLEET_IDS);
    assert.deepStrictEqual(b({ task: 'other-account' }).actions.map((a) => a.id), FLEET_IDS);
    const timeout = b({ startError: { code: 'NODE_START_TIMEOUT' } });
    assert.strictEqual(timeout.line, 'King Louie Node did not answer within 60 seconds.');
    assert.deepStrictEqual(timeout.actions.map((a) => a.id), FLEET_IDS);
    assert.strictEqual(b({ startError: { code: 'NODE_START_FAILED', message: 'service failed to start: x' } }).line, 'King Louie Node stopped while starting: service failed to start: x');
  });
});

describe('describeInstallPreview / describeInstallResult', () => {
  it('the dry run\'s lines go in a <pre> text, each through shown, with Install and Cancel', () => {
    const m = describeInstallPreview({ ok: true, lines: ['Account: LAPTOP-01\\owner', 'Task: KingLouie Node', 'odd\u0007line'] });
    assert.deepStrictEqual(m.lines, ['Account: LAPTOP-01\\owner', 'Task: KingLouie Node', 'oddline [hidden or control characters removed]']);
    assert.strictEqual(m.pre, m.lines.join('\n'));
    assert.deepStrictEqual(m.actions, [{ id: 'nodeInstall', label: 'Install' }, { id: 'nodeInstallCancel', label: 'Cancel' }]);
    assert.strictEqual(m.error, null);
  });

  it('a refused preview shows the refusal and no Install', () => {
    const m = describeInstallPreview({ ok: false, code: 'INSTALL_REFUSED', error: 'A fleet node is installed on this computer.' });
    assert.strictEqual(m.error, 'A fleet node is installed on this computer.');
    assert.deepStrictEqual(m.actions, [{ id: 'nodeInstallCancel', label: 'Cancel' }]);
  });

  it('the install\'s result lines, or its refusal', () => {
    assert.deepStrictEqual(describeInstallResult({ ok: true, lines: ['Registered KingLouie Node.'] }), { lines: ['Registered KingLouie Node.'], pre: 'Registered KingLouie Node.', error: null, actions: [] });
    const refused = describeInstallResult({ ok: false, code: 'X', message: 'No Chrome found.', lines: ['partial'] });
    assert.strictEqual(refused.error, 'No Chrome found.');
    assert.deepStrictEqual(refused.lines, ['partial']);
  });
});

describe('decideDetachClick', () => {
  it('arms on a first click (not armed yet)', () => {
    assert.deepStrictEqual(decideDetachClick({ armed: false, armedAtToken: null, currentToken: 3, armedAt: null, now: 1000 }), { confirm: false, arm: true });
  });

  it('confirms a second click on the exact render that showed the warning, once enough time has passed', () => {
    const armedAt = 1_000_000;
    assert.deepStrictEqual(
      decideDetachClick({ armed: true, armedAtToken: 4, currentToken: 4, armedAt, now: armedAt + DETACH_CONFIRM_DELAY_MS }),
      { confirm: true, arm: false }
    );
  });

  it('re-arms instead of confirming when a render happened since arming (the race this closes)', () => {
    const armedAt = 1_000_000;
    assert.deepStrictEqual(
      decideDetachClick({ armed: true, armedAtToken: 4, currentToken: 5, armedAt, now: armedAt + DETACH_CONFIRM_DELAY_MS }),
      { confirm: false, arm: true }
    );
  });

  it('re-arms instead of confirming when the second click beats the confirm delay (a double-click)', () => {
    const armedAt = 1_000_000;
    assert.deepStrictEqual(
      decideDetachClick({ armed: true, armedAtToken: 4, currentToken: 4, armedAt, now: armedAt + DETACH_CONFIRM_DELAY_MS - 1 }),
      { confirm: false, arm: true }
    );
  });

  it('confirms right at the delay boundary (>=), not only strictly after it', () => {
    const armedAt = 1_000_000;
    assert.deepStrictEqual(
      decideDetachClick({ armed: true, armedAtToken: 4, currentToken: 4, armedAt, now: armedAt + DETACH_CONFIRM_DELAY_MS }),
      { confirm: true, arm: false }
    );
  });
});

describe('paneShapeChanged', () => {
  it('is true with no previous model (first paint)', () => {
    assert.strictEqual(paneShapeChanged(null, { view: 'paired', actions: [] }), true);
  });

  it('is false when the view and actions are the same (a background repaint with new lines only)', () => {
    const prev = { view: 'attached-disconnected', actions: [{ id: 'retry', label: 'Retry now' }], lines: ['old error'] };
    const next = { view: 'attached-disconnected', actions: [{ id: 'retry', label: 'Retry now' }], lines: ['new error'] };
    assert.strictEqual(paneShapeChanged(prev, next), false);
  });

  it('is true when the view changed', () => {
    const prev = { view: 'paired', actions: [] };
    const next = { view: 'attached-connected', actions: [] };
    assert.strictEqual(paneShapeChanged(prev, next), true);
  });

  it('is true when an action (e.g. disabled) changed even with the same view', () => {
    const prev = { view: 'pairing', actions: [{ id: 'pairConfirm', label: 'Confirm', disabled: true }] };
    const next = { view: 'pairing', actions: [{ id: 'pairConfirm', label: 'Confirm', disabled: false }] };
    assert.strictEqual(paneShapeChanged(prev, next), true);
  });
});

describe('pane wiring', () => {
  it('preload exposes window.electron.desktop over the desktop:* channels', () => {
    const preload = read('preload.js');
    for (const ch of ['status', 'pairStart', 'pairConfirm', 'pairCancel', 'attach', 'detach', 'standaloneOnce', 'unpair', 'retry', 'dismissServiceCommand', 'importPlan', 'importApply']) {
      assert.ok(preload.includes(`ipcRenderer.invoke('desktop:${ch}'`), `desktop:${ch}`);
    }
    assert.ok(preload.includes("registerOnce('desktop:statusChanged'"));
    assert.ok(preload.includes("registerOnce('desktop:importProgress'"));
    assert.ok(preload.includes('paneModel.decideDetachClick'), 'decideDetachClick is exposed alongside describe/describeImport');
    assert.ok(preload.includes('paneModel.paneShapeChanged'), 'paneShapeChanged is exposed alongside decideDetachClick');
  });

  it('the banner and the personal actions are drawn from the pane model, node strings by textContent', () => {
    const preload = read('preload.js');
    for (const fn of ['describeAttachedBanner', 'describeInstallPreview', 'describeInstallResult']) {
      assert.ok(preload.includes(`paneModel.${fn}(`), fn);
    }
    const renderer = read('renderer.js');
    const banner = renderer.slice(renderer.indexOf('function attachedBannerAction('), renderer.indexOf('async function refreshServiceStatus('));
    assert.match(banner, /desktop\.describeBanner\(status\)/);
    assert.match(banner, /text\.textContent = model\.line/);
    assert.doesNotMatch(banner, /'Retry now'|not reachable|attached-disconnected/, 'the banner holds no copy of the rules');
    assert.match(banner, /nodeStart\(\{ restart: false \}\)/);
    assert.match(banner, /nodeStart\(\{ restart: true \}\)/);
    const actions = renderer.slice(renderer.indexOf('async function runServiceAction('), renderer.indexOf('function markUnavailableTabs('));
    assert.match(actions, /desktop\.pairRestartConfirm\(\{ confirmed: true \}\)/);
    assert.match(actions, /desktop\.nodeInstallPreview\(\)/);
    assert.match(actions, /desktop\.nodeInstall\(\{ confirmed: true \}\)/);
    const box = renderer.slice(renderer.indexOf('function renderInstallBox('), renderer.indexOf('function hideServiceBox('));
    assert.match(box, /createElement\('pre'\)/);
    assert.match(box, /pre\.textContent = model\.pre/);
    assert.doesNotMatch(box, /innerHTML/);
  });

  it('index.html has the Local service tab and pane', () => {
    const html = read('index.html');
    assert.ok(html.includes('<option value="service">Local service</option>'));
    assert.ok(html.includes('class="settings-tab-content" data-tab="service"'));
    for (const id of ['service-pane-status', 'service-pane-request', 'service-pair-request', 'service-pair-command', 'service-pane-actions', 'service-pane-import', 'service-pane-approvals']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  it('renderer renders the pane from switchSettingsTab and subscribes once', () => {
    const renderer = read('renderer.js');
    assert.match(renderer, /async function renderServiceSection\(\)/);
    assert.match(renderer, /function markUnavailableTabs\(/);
    const switchBody = renderer.slice(renderer.indexOf('function switchSettingsTab('), renderer.indexOf('function sortSettingsNavOptions('));
    assert.match(switchBody, /tabName === 'service'/);
    assert.strictEqual((renderer.match(/desktop\.onStatusChanged\(/g) || []).length, 1);
  });
});

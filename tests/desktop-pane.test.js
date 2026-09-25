// tests/desktop-pane.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  describeServicePane, describeImportReport, decideDetachClick, paneShapeChanged,
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
    const found = describeServicePane({ view: 'pairing', pendingPair: { request: 'r', command: 'c', deviceFingerprint: 'a', service: { fingerprint: 'wxyz 2345 6789 abcd', port: 18795 } } });
    assert.ok(found.lines.includes('Service: wxyz 2345 6789 abcd (port 18795)'));
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
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: 'The local King Louie service is not reachable (127.0.0.1:18795).', nextRetryAt: null } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18795).');
    assert.deepStrictEqual(m.actions.map((a) => a.label), ['Retry now', 'Use standalone this time', 'Detach']);
  });

  it('attached, not connected, no connection.error: falls back using the paired service\'s own port', () => {
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: null, nextRetryAt: null }, pairing: { service: { port: 18888 } } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18888).');
  });

  it('attached, not connected, no connection.error and no known port: falls back to the default port', () => {
    const m = describeServicePane({ view: 'attached-disconnected', connection: { status: 'disconnected', error: null, nextRetryAt: null } });
    assert.strictEqual(m.lines[0], 'The local King Louie service is not reachable (127.0.0.1:18795).');
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

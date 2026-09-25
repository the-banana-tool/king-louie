// tests/ipc-tool-handlers.test.js
// Fleet stage 7 fix round 1, M6: approval requesters return
// `true | false | 'timeout' | 'unavailable'`; only the exact boolean `true`
// approves. tool:approvalResponse (shared between the Electron host and the
// desktop bridge) used to coerce with Boolean(approved), so a truthy string
// like 'true' or a stray 1 — either a buggy client or an attacker probing
// the wire protocol — would approve.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerToolHandlers } = require('../src/ipc/tool-handlers');

function harness() {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn)
  };
  const pendingApprovalResolvers = new Map();
  const pendingDirectoryAccessResolvers = new Map();
  const alwaysApproved = [];
  const rulesAdded = [];
  const context = {
    pendingApprovalResolvers,
    pendingDirectoryAccessResolvers,
    setToolAlwaysApprove: (toolName) => alwaysApproved.push(toolName),
    addPermissionRule: (rule) => rulesAdded.push(rule),
    getPermissionRules: () => [],
    removePermissionRule: () => {}
  };
  registerToolHandlers(ipcMain, context);
  return { handlers, listeners, pendingApprovalResolvers, alwaysApproved, rulesAdded };
}

function respond(approved, extra = {}) {
  const { listeners, pendingApprovalResolvers, alwaysApproved, rulesAdded } = harness();
  let resolved;
  pendingApprovalResolvers.set('a1', { toolName: 'Bash', resolve: (v) => { resolved = v; } });
  listeners.get('tool:approvalResponse')({}, { approvalId: 'a1', approved, ...extra });
  return { resolved, alwaysApproved, rulesAdded };
}

describe('tool:approvalResponse, strict approval (M6)', () => {
  it('approves only when approved is exactly the boolean true', () => {
    assert.strictEqual(respond(true).resolved, true);
  });

  for (const notApproved of ['true', 1, 'yes', {}, [], 'false', -1]) {
    it(`does not approve when approved is ${JSON.stringify(notApproved)}`, () => {
      assert.strictEqual(respond(notApproved).resolved, false);
    });
  }

  it('a truthy non-boolean approved does not flip on the always-approve checkbox', () => {
    const { alwaysApproved } = respond('true', { alwaysApprove: true });
    assert.deepStrictEqual(alwaysApproved, []);
  });

  it('the real boolean true does flip the always-approve checkbox', () => {
    const { alwaysApproved } = respond(true, { alwaysApprove: true });
    assert.deepStrictEqual(alwaysApproved, ['Bash']);
  });

  it('a truthy non-boolean approved does not persist an "allow" rule', () => {
    const { rulesAdded } = respond(1, { rulePattern: 'git *' });
    assert.deepStrictEqual(rulesAdded, []);
  });

  it('ruleAction "deny" still persists regardless of approved', () => {
    const { rulesAdded } = respond(false, { rulePattern: 'rm *', ruleAction: 'deny' });
    assert.deepStrictEqual(rulesAdded, [{ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'approval-dialog' }]);
  });
});

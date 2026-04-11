const { describe, it } = require('node:test');
const assert = require('node:assert');
const constants = require('../src/ipc/constants');

// ── tests ────────────────────────────────────────────────────────────────────

describe('Workflow IPC constants', () => {
  it('has all workflow constants defined', () => {
    assert.strictEqual(constants.WORKFLOW_PLAN, 'workflow:plan');
    assert.strictEqual(constants.WORKFLOW_PLAN_AND_EXECUTE, 'workflow:planAndExecute');
    assert.strictEqual(constants.WORKFLOW_RUN, 'workflow:run');
    assert.strictEqual(constants.WORKFLOW_PAUSE, 'workflow:pause');
    assert.strictEqual(constants.WORKFLOW_CANCEL, 'workflow:cancel');
    assert.strictEqual(constants.WORKFLOW_LIST, 'workflow:list');
    assert.strictEqual(constants.WORKFLOW_GET, 'workflow:get');
    assert.strictEqual(constants.WORKFLOW_PROGRESS, 'workflow:progress');
    assert.strictEqual(constants.WORKFLOW_DELETE, 'workflow:delete');
    assert.strictEqual(constants.WORKFLOW_RECOVER_PLAN, 'workflow:recoverPlan');
  });

  it('workflow constants have unique values', () => {
    const workflowConstants = Object.entries(constants)
      .filter(([key]) => key.startsWith('WORKFLOW_'))
      .map(([, value]) => value);

    const unique = new Set(workflowConstants);
    assert.strictEqual(unique.size, workflowConstants.length, 'All workflow constants must have unique values');
  });

  it('workflow constants do not collide with other constants', () => {
    const allValues = Object.values(constants);
    const uniqueValues = new Set(allValues);
    assert.strictEqual(uniqueValues.size, allValues.length, 'No constant value collisions');
  });
});

describe('Workflow handler module', () => {
  it('exports registerWorkflowHandlers function', () => {
    const { registerWorkflowHandlers } = require('../src/ipc/workflow-handlers');
    assert.strictEqual(typeof registerWorkflowHandlers, 'function');
  });

  it('registers all workflow IPC handlers', () => {
    const { registerWorkflowHandlers } = require('../src/ipc/workflow-handlers');
    const registered = [];

    const mockIpcMain = {
      handle: (channel, handler) => {
        registered.push(channel);
      }
    };

    const mockContext = {
      getPlannerExecutor: () => null,
      getWorkflowEngine: () => null
    };

    registerWorkflowHandlers(mockIpcMain, mockContext);

    assert.ok(registered.includes('workflow:plan'));
    assert.ok(registered.includes('workflow:planAndExecute'));
    assert.ok(registered.includes('workflow:create'));
    assert.ok(registered.includes('workflow:run'));
    assert.ok(registered.includes('workflow:pause'));
    assert.ok(registered.includes('workflow:cancel'));
    assert.ok(registered.includes('workflow:list'));
    assert.ok(registered.includes('workflow:get'));
    assert.ok(registered.includes('workflow:progress'));
    assert.ok(registered.includes('workflow:delete'));
    assert.ok(registered.includes('workflow:recoverPlan'));
    assert.strictEqual(registered.length, 11);
  });
});

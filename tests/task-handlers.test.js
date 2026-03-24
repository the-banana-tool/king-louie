const assert = require('assert');

const { registerTaskHandlers } = require('../src/ipc/task-handlers');

function run(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✔ ${name}`);
    })
    .catch((error) => {
      console.error(`✖ ${name}`);
      console.error(error.stack || error.message || error);
      process.exitCode = 1;
    });
}

function createIpcMainMock() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
}

run('registerTaskHandlers wires all task channels', async () => {
  const ipcMain = createIpcMainMock();
  registerTaskHandlers(ipcMain, { taskManager: {} });

  assert.ok(ipcMain.handlers.has('task:create'));
  assert.ok(ipcMain.handlers.has('task:list'));
  assert.ok(ipcMain.handlers.has('task:update'));
});

run('task:create uses getTaskManager and wraps successful payload', async () => {
  const ipcMain = createIpcMainMock();
  const calls = [];

  registerTaskHandlers(ipcMain, {
    getTaskManager: () => ({
      create(config) {
        calls.push(config);
        return { id: 'task-1', ...config };
      }
    })
  });

  const result = await ipcMain.handlers.get('task:create')({}, { title: 'Write tests' });
  assert.deepStrictEqual(calls, [{ title: 'Write tests' }]);
  assert.deepStrictEqual(result, { ok: true, data: { id: 'task-1', title: 'Write tests' } });
});

run('task:list wraps thrown errors as ok:false', async () => {
  const ipcMain = createIpcMainMock();

  registerTaskHandlers(ipcMain, {
    taskManager: {
      list() {
        throw new Error('db down');
      }
    }
  });

  const result = await ipcMain.handlers.get('task:list')({});
  assert.deepStrictEqual(result, { ok: false, error: 'db down' });
});

run('task:update passes updates and wraps result', async () => {
  const ipcMain = createIpcMainMock();

  registerTaskHandlers(ipcMain, {
    taskManager: {
      update(taskId, updates) {
        return { taskId, ...updates };
      }
    }
  });

  const result = await ipcMain.handlers
    .get('task:update')({}, { taskId: 't-9', updates: { status: 'done' } });
  assert.deepStrictEqual(result, { ok: true, data: { taskId: 't-9', status: 'done' } });
});

setTimeout(() => {
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  console.log('Task handler tests completed.');
}, 40);
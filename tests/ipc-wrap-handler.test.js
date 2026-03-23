const assert = require('assert');

const { wrapHandler } = require('../src/ipc/wrap-handler');

async function run(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✖ ${name}`);
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

run('wrapHandler passes through explicit ok payloads', async () => {
  const handler = wrapHandler('test:ok', async () => ({ ok: true, value: 123 }));
  const result = await handler({}, 'unused');
  assert.deepStrictEqual(result, { ok: true, value: 123 });
});

run('wrapHandler wraps non-ok payloads in {ok:true,data}', async () => {
  const handler = wrapHandler('test:data', async () => ({ value: 456 }));
  const result = await handler({});
  assert.deepStrictEqual(result, { ok: true, data: { value: 456 } });
});

run('wrapHandler catches thrown errors and returns ok:false', async () => {
  const handler = wrapHandler('test:error', async () => {
    throw new Error('boom');
  });

  const result = await handler({});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'boom');
});

setTimeout(() => {
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  console.log('IPC wrap-handler tests completed.');
}, 30);

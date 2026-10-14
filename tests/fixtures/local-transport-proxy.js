'use strict';

// Run as a child by tests/local-transport.test.js with HTTP_PROXY,
// HTTPS_PROXY, ALL_PROXY and NODE_USE_ENV_PROXY=1 in its environment.
// argv: <target port>. Prints one JSON line:
//   { transport: <status>, control: <status | error code> }
// `transport` is the local transport's call to the target; `control` is the
// same URL through node:http's global agent, which shows whether this Node
// honours the proxy variables at all (502 from the test's proxy when it does).

const http = require('node:http');
const path = require('node:path');
const { createLocalTransport } = require(path.join(__dirname, '..', '..', 'src', 'models', 'local-transport'));

async function main() {
  const port = Number(process.argv[2]);
  const baseUrl = `http://127.0.0.1:${port}`;
  const out = { transport: null, control: null };

  const transport = createLocalTransport({ baseUrl, addresses: ['127.0.0.1'] });
  try {
    const res = await transport.fetch(`${baseUrl}/v1/models`, { method: 'GET' });
    await res.text();
    out.transport = res.status;
  } catch (err) {
    out.transport = `error:${err.code || err.name}`;
  } finally {
    transport.close();
  }

  out.control = await new Promise((resolve) => {
    http.get(`${baseUrl}/v1/models`, (res) => { res.resume(); resolve(res.statusCode); })
      .on('error', (err) => resolve(`error:${err.code || err.name}`));
  });

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().then(() => process.exit(0), (err) => {
  process.stdout.write(`${JSON.stringify({ fatal: String(err && err.code ? err.code : err && err.name) })}\n`);
  process.exit(1);
});

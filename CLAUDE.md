# king-louie

Electron desktop chat app. Main process in `main.js`, renderer in `renderer.js`,
tools and providers under `src/`.

## Testing

Tests use **node's built-in test runner** (`node --test`), not Jest. Do not
invoke `jest` or `npx jest` — Jest will report "Test suite must contain at
least one test" because the files use `node:test`'s `describe`/`it` API and
no `test()`/`it()` calls jest can detect, and you'll miss real failures.

Run tests with:
- `npm test` — full suite (`node --test tests/*.test.js`)
- `node --test tests/<file>.test.js` — single file
- `npm run test:e2e` — sequential e2e suite

When iterating on a specific module, run just its test file directly with
`node --test`. Output uses TAP format; look for `# fail 0` / `# pass N` in the
summary block.

## Logging

Use `createLogger` from `src/logging.js` instead of bare `console.*` calls.
Loggers are scoped by subsystem name and support hierarchical children,
level filtering, and structured metadata.

```js
const { createLogger } = require('./logging');   // or '../logging' from subdirs
const log = createLogger('my-module');

log.info('something happened');
log.warn('degraded', { latencyMs: 430 });

const child = log.child('sub-part');             // → [my-module/sub-part]
const bound = log.withContext({ sessionId: 's-1' }); // metadata on every call
```

Levels (low → high): `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`.
Default is `info`. Override with `KING_LOUIE_LOG_LEVEL` or `LOG_LEVEL` env var.

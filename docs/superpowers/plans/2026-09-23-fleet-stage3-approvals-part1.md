# Fleet Stage 3: Signed approvals, relay and mobile app — Implementation Plan (Part 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the protocol core of signed phone approvals: canonical JSON, signed envelopes and device ids, the approval-v1 messages, the hash-chained audit ledger, the read-only approver store with its admin writer, device-envelope verification and the `PhoneApprover`.
**Architecture:** Part 1 adds pure, Electron-free modules under `src/platform/jcs.js`, `src/execution/tool-patterns.js`, `src/approvals/` and `src/audit/`, plus test helpers (`tests/helpers/fake-phone.js`, `tests/helpers/approver-set.js`) and the fixed test keys. Nothing here is wired into the service yet. Part 2 (`docs/superpowers/plans/2026-09-23-fleet-stage3-approvals-part2.md`) adds the protocol vectors, the ToolExecutor tiers and the `createCore` phone seam, the node → relay link, the courier and unsafe runbooks; Part 3 the relay, service wiring and CLI; Part 4 the mobile apps. Each part starts only after the previous one has merged.
**Tech Stack:** Node ≥ 22, CommonJS, `node:test`, Node `crypto` (Ed25519, ECDSA P-256 with `ieee-p1363`, SHA-256, HMAC). No new npm dependency in this part.
**Spec:** docs/superpowers/specs/2026-09-23-fleet-stage3-approvals.md. **Program:** docs/superpowers/specs/2026-09-23-stage-program.md.

## Global Constraints

Program §3, verbatim:


- Open source: nothing specific to one person, machine, domain, path, app or
  provider account in code, defaults, fixtures or docs. Examples use `example.com`,
  `kl.example.com`, `gpu-box`, `web-01`, `Lakeside lot`, `+15550100`.
- `src/` outside `src/ipc/` and the Electron host is Electron-free
  (`tests/electron-boundary.test.js`). New code under `src/` runs under
  `king-louie-service`.
- **No new native npm dependencies.** Pure-JS or WASM only, and each new dependency is
  named in the child spec with the reason. (Stage 1 ruled out native deps for the
  secrets backends; the rule holds for every stage.) A test in each stage that adds a
  dependency asserts the lockfile has no install scripts or native binaries for it.
- Tests: `node --test`, never Jest. Pass = `# fail 0`. E2E needs
  `unset ELECTRON_RUN_AS_NODE`.
- Logging through `createLogger` (`src/logging.js`); no bare `console.*`. Third-party
  libraries with their own loggers (pino via imapflow) are constructed with
  `logger: false`.
- Tool results are `{ ok: true, … }` / `{ ok: false, error }`. ToolExecutor-level
  refusals are `{ success: false, error }`. Gate refusals are results, never throws.
- Security-relevant configuration is read only from the root/admin-owned config dir
  (`<configDir>/node.yaml`, `service.json`); the data dir is service-writable and
  never decides policy. `service.json` and `node.yaml` reject unknown keys with the key
  path named (R11, R55).
- Trust principle 3 (fleet §3.1): remote-origin unsafe actions run only with a fresh,
  single-use phone signature over the exact action. No setting, token or "remember
  this" stands in for it. The one exception is the computer-use lease (F5).
- Approval requesters return `true | false | 'timeout' | 'unavailable'`; only `=== true`
  approves. Truthy strings never do.
- Cases principle 5: nothing inferred leaves. Every outbound payload passes the
  outbound gate (§4.9). Cross-case reads never return the text of a non-disclosable fact.
- Case facts are append-only; `facts.jsonl` is written only by `FactLedger`. Only
  `user` provenance is host-verified; `external-agent` provenance is written only by
  the executor results path (R40); `sourced` is model-declared.
- Journal files are `YYYY-MM-DD-HHMM-<kind>.md` (`src/cases/records.js` `stamp()`).
- Commit trailer for every commit in this program: whatever the executing session's
  attribution reminder says. Never substitute another model's line.

Fleet stage 3 spec constraints:

- Envelopes are exactly `{ alg, kid, payload, sig }`; `payload` and `sig` are base64url without padding; signatures cover the JCS bytes as sent; verifiers never re-canonicalize to verify, and nodes additionally require the bytes to be canonical (`malformed` otherwise).
- Node keys: Ed25519, DER SPKI hex. Device keys: P-256 JWK with exactly `kty: 'EC'`, `crv: 'P-256'`, `x`, `y`; ES256 signatures are raw `r||s` (IEEE P1363). Device id = `d-` + base32(sha256(0x04‖x‖y))[0..16] (lowercase RFC 4648, no padding); desktops use prefix `kld-` over the 32-byte Ed25519 key.
- Request TTL default 300 s, clamped to 30–300 s (`approvers.request_ttl_s`); in phone mode `approvalTimeoutMs` = TTL + 15000. Expiry is judged on the node clock only; `signed_at` is recorded, never judged.
- An action's JCS form is at most 262144 bytes (`action_too_large`); `summary` is at most 300 characters, cut with `…`.
- Requesters return `true | false | 'timeout' | 'unavailable'`; `mapApprovalResult` runs a tool only for `=== true`. `'timeout'` and `'unavailable'` never approve.
- The service only READS `<configDir>/approvers/`; only `src/approvals/approver-admin.js`, loaded by the admin CLI, writes it. Relayed enrollments are staged in `<dataDir>/approvals/staged/` and applied by `device apply`; a verified revoke acts at once through the in-memory overlay.
- The relay's mesh listener binds only a loopback or private IP literal (`relay.mesh_listen.host must be a loopback or private IP address until the stage 4 mesh hardening lands`). Relay ports default to 8443 (phone API) and 18795 (mesh).
- Phone API: body cap 262144 bytes; device timestamps within 120 s of the relay clock (`401 clock_skew` with `server_time`); replay window 5 minutes keyed on SHA-256 of the signed string plus the device id; 10 requests/min per IP unauthenticated, 120/min per device.
- Push is a pluggable `PushSender`; `none` is the default and the fallback. Push payloads carry only `{ kind, id }` (and the node name in the alert text).
- Audit ledger: monthly segments `<dataDir>/audit/ledger-YYYY-MM.jsonl`, `hash` = hex SHA-256 over JCS(entry without `hash`), retention default 365 days (`audit.retention_days` ≥ 30). `src/events/event-ledger.js` is unchanged.
- The one new npm dependency is `qrcode` (pure JS, CLI only); a test asserts its lockfile tree has no install scripts or native builds. No new environment variables.
- F3 makes no edits to `src/ipc/*`, `preload.js`, `renderer.js`, `styles.css`, `src/core/settings.js` or `src/tools/index.js`.
- Tests that create approver sets or config dirs use temp dirs and play the administrator through injected `geteuid`/`adminUid` (and `platform: 'linux'` for the POSIX checks); fixtures use invented data and the fixed test keys in `tests/vectors/approval-v1/keys.json`.
- Every commit in this plan ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Test runs report through the spec reporter in a terminal (`ℹ fail 0`) and TAP when piped (`# fail 0`); either counts as passing.

## Review Focus

The five conditions of spec §10 that ordinary task tests would not reach, and the test that pins each:

1. **Phone clock wrong by minutes.** Vector `response-accept-phone-clock-ahead` (Part 2, Task 10, `tests/approvals-protocol.test.js`) and "401 clock_skew then offset retry succeeds" (Part 3, Task 19, `tests/frontdoor-phone-api.test.js`).
2. **Two enrolled phones, one approves and one denies.** "first valid response decides; second gets already_decided; both audited" (Part 1, Task 9, `tests/approvals-phone-approver.test.js`).
3. **Approval arrives after the tool call was cancelled.** "abort → withdrawn; later approve → unknown_request; tool never runs" (Part 1, Task 9) and "cancel_job while awaiting withdraws the request and nothing runs" (Part 2, Task 16, `tests/mcp-stdio-approvals.test.js`).
4. **Relay down when the request is created.** "queued while down, submitted on connect, expires on node clock if the link never returns" (Part 1, Task 9).
5. **`mcp` asks for an unsafe runbook while the service is stopped.** "unavailable immediately with the service-not-running reason" (Part 2, Task 16).

## Interfaces from other stages

| Contract | What this plan uses | Until it merges |
|---|---|---|
| Program §4.21, F7 `src/core/origin.js` | `markLocalDesktopEvent(event, { deviceId })`, `isLocalDesktopEvent(event)`, `localDesktopDeviceId(event)`, `markLocalRequester(fn)`, `isLocalRequester(fn)` | Task 11 creates the module with exactly these five exports **only if the file does not exist**. If F7 merged first, Task 11 checks the five exports exist and creates nothing. |
| F6 R11 strict `node.yaml` loader (`NODE_YAML_KEYS`), `tests/examples.test.js` | `approvers` joins the allowed top-level keys | Task 20 adds `'approvers'` to `NODE_YAML_KEYS` and to `tests/examples.test.js` **only if** those exist on the branch; on `main` today neither exists and `loadNodeConfig` accepts any top-level key. |
| F6 R55 unknown-key rejection in `service.json` | the `relay` and `audit` blocks | Task 20's parsers reject unknown keys inside `relay` and `audit` themselves, naming the key path. |
| F6 `tests/helpers/stdio-mcp-client.js` (`connectStdioMcp`) | — | Not used: Task 16 drives `StdioMcpServer.executeToolCall`, the entry point the stdio transport calls, and the e2e test (Task 23) drives the real `mcp` process over stdio. |
| F4 `<configDir>/front-door.json` and `MeshTransport.connectPinned` (E7) | `RelayClient` dials through `connectPinned(frontDoor)` when both exist | Feature-detected: without either, the client dials the relay pinned by `pair`. Task 14's test supplies a transport with `connectPinned`. |
| F4 peer source for `NodeHub` (E3) | `peerSource = { list(), on('change') }` | Optional constructor argument; `null` means the registry file. |

Part 1 itself consumes only merged code: `base32Encode`, `deriveNodeId` (`src/mesh/node-identity.js`), `assertAdminOwned` (`src/service/config.js`), `substituteArgv` (`src/runbooks/runbook-engine.js`), `createLogger`.

## Deviations and resolved gaps (read before starting)

Names and shapes here extend the spec's §5.2 without changing any of them.

- **Demo and test keys.** `ApproverStore.get(id)` returns any well-formed record, including `platform: 'demo'` and published test keys, so `verifyDeviceEnvelope` can report `demo_device` / `test_key` (spec steps 3–4) instead of `unknown_device`. `list()` leaves test keys out and `isActive()` is false for both unless `allowTestKeys`. The store exposes `allowTestKeys`, `refresh()`, `addToOverlay(id)`, `overlay`, `problem`; `checkApproverDir()` is the sync trust probe `doctor` shares.
- **Vectors run with `given.allow_test_keys`.** Devices A, B, C in `keys.json` are the published test keys, so every node vector says whether they are allowed (`true` except `response-reject-test-key`). Stage vectors take `input` as an array of envelopes and `expect: { results, active }`.
- **PhoneApprover additions:** `unavailableReason()` (used by `isAvailable()` and by the stdio server's `denied_by_policy: <reason>`), `ttlMs`, `nonces`, and constructor options `setTimer`/`clearTimer` and `buildRequest` (the vectors inject a fixed request). `stop()` ends pending requests as `unavailable` with a `withdrawn` status.
- **Refusal plumbing.** The phone-mode requester sets `metadata.origin` on the metadata object it is given instead of passing `{ ...m, origin }`, so the `metadata.refusal` the approver writes reaches `mapApprovalResult`. At the hook `confirm` site the result is mapped the same way but, as today, never touches the denial tracker; only the gate site records a plain `false`.
- **Children of desktop runs** inherit the mark through the requester (spec §3.7); their audit `origin.deviceId` is `null`, since the requester carries no device id.
- **Pairing record.** `store.get('approvals.relay')` also keeps the relay's mesh `peerId`, which the transport needs to recognise it. `RelayClient` takes `dataDir` (for `link.json`) instead of `store`.
- **Relay API extras.** `POST /v1/approvals/{id}/response` answers `202 { delivered: true, accepted, reason }` so the app can show `refused: <reason>`. `GET /v1/approvals?wait=` long-polls against a per-device cursor: it returns at once when anything changed since that device's last call. `Invites.claimCode(codeId, envelope)` records the phone's claim. The relay replays its device log on `relay.hello`; the mailbox is relay memory and has nothing to replay to a node.
- **Message helpers** in `src/approvals/messages.js` beyond §5.2: `phoneAuthString`, `encodeQr`/`decodeQr`, `enrollMac`/`inviteMac` (HMAC keyed with the raw 32 bytes of the base64url `code`/`secret`), `buildEnrollOpen`/`buildEnrollDone`, `validateMessage`, `parseMessage`, `registerMessageValidator(type, fn)` for F5/C4 types. `verifyConsoleEnrollment` lives in `verify-device.js`.
- **Audit.** `entriesAfter(hash)` with a hash no longer retained starts from the oldest retained entry (the slice's `anchor` tells the mirror there was a gap). `verifyAuditSlice(envelope, spkiHex)` is exported for the relay, F4's mirror and tests.
- **`mcp` process.** `startMcpApprovals()` in `service-wiring.js` builds the `mcp` side: a `FileCourier` link, a PhoneApprover and an `AuditLedger` with writer `mcp`.
- **Device state to the relay.** The service polls the admin-applied set every 5 s (`trackDeviceStates`) and sends `device.state` when an admin applies or revokes a device; `device apply` itself never talks to the relay.
- **Runbooks.** `JobManager.transition(jobId, 'awaiting_approval', 'queued')` is the one new transition and enforces `max_concurrent_jobs`; `awaiting_approval` jobs get their `AbortController` at creation.
- **Relay configuration** is normalized to `{ phoneListen, tls: { certFile, keyFile }, meshListen, publicUrl, push: { apns?: { teamId, keyId, keyFile, topic, environment }, fcm?: { serviceAccountFile } } }`; `startRelay` takes that shape.
- **Windows e2e.** The service trusts `approvers/` only if it cannot write it. The e2e test runs as the same account as the service, so after enrolling the phone it denies itself write access to that directory with `icacls` (and lifts the deny before cleanup), as an installer's ACL would.
- **Plan size.** The stage is split into four plans (Node protocol core; approvals and the node link; relay, service and CLI; mobile apps), each ~4500 lines or less; each depends on the previous part's merged code.

---

### Task 1: RFC 8785 canonical JSON

**Files:**
- Create: `src/platform/jcs.js`
- Test: `tests/platform-jcs.test.js`

**Interfaces:**
- Consumes: Node `crypto` only.
- Produces: `canonicalize(value) → string` (throws `JcsError` with `code: 'non_canonical_value'`), `sha256b64url(stringOrBuffer) → string`, `class JcsError`. Every later task signs or hashes through these; C3, F4 and F5 import them from here (R17).

- [ ] **Step 1: Write the failing test**

Create `tests/platform-jcs.test.js`. Characters are built from code points so no editor can turn an escape into the character it names:

```js
// tests/platform-jcs.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize, sha256b64url, JcsError } = require('../src/platform/jcs');

// Characters are built from code points so no editor or tool can silently
// turn an escape into the character (or the other way round).
const cp = (...points) => String.fromCodePoint(...points);
const BS = cp(0x5c); // backslash
const DQ = cp(0x22); // double quote

describe('canonicalize (RFC 8785)', () => {
  it('matches the RFC 8785 §3.2.2 example', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: `${cp(0x20ac)}$${cp(0x0f)}${cp(0x0a)}A'B${DQ}${BS}${BS}${DQ}/`,
      literals: [null, true, false]
    };
    const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
      + `"string":"${cp(0x20ac)}$${BS}u000f${BS}nA'B${BS}${DQ}${BS}${BS}${BS}${BS}${BS}${DQ}/"}`;
    assert.equal(canonicalize(input), expected);
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const keys = [cp(0x20ac), cp(0x0d), cp(0xfb33), '1', cp(0x1f600), cp(0x80), cp(0xf6)];
    const input = {};
    for (const k of keys) input[k] = k.codePointAt(0);
    // Object.keys would list the integer-like key "1" first, so the expected
    // text is built by hand in RFC order.
    const order = [cp(0x0d), '1', cp(0x80), cp(0xf6), cp(0x20ac), cp(0x1f600), cp(0xfb33)];
    const expected = `{${order.map((k) => `${JSON.stringify(k)}:${k.codePointAt(0)}`).join(',')}}`;
    assert.equal(canonicalize(input), expected);
  });

  it('sorts nested objects and keeps array order', () => {
    assert.equal(canonicalize({ b: [3, { z: 1, a: 2 }], a: 'x' }), '{"a":"x","b":[3,{"a":2,"z":1}]}');
  });

  it('writes numbers the ECMAScript way', () => {
    const cases = [[1e21, '1e+21'], [1e-7, '1e-7'], [0.1 + 0.2, '0.30000000000000004'], [-0, '0'], [100, '100'], [-1.5, '-1.5'], [5e-324, '5e-324']];
    for (const [n, text] of cases) assert.equal(canonicalize(n), text, String(n));
  });

  it('emits no whitespace and escapes control characters in lowercase hex', () => {
    assert.equal(canonicalize({ a: cp(0x01, 0x09), b: [1, 2] }), `{"a":"${BS}u0001${BS}t","b":[1,2]}`);
  });

  it('refuses values JCS cannot represent', () => {
    const bad = [NaN, Infinity, -Infinity, undefined, () => 1, Symbol('s'), 10n, { a: undefined }, [1, undefined],
      new Date(0), String.fromCharCode(0xd800), { [String.fromCharCode(0xdc00)]: 1 }, `a${String.fromCharCode(0xd83d)}`];
    for (const value of bad) {
      assert.throws(() => canonicalize(value), (err) => err instanceof JcsError && err.code === 'non_canonical_value');
    }
    // A hole in an array is undefined, not a skipped element.
    const holey = [1];
    holey[2] = 3;
    assert.throws(() => canonicalize(holey), JcsError);
  });

  it('accepts a well-formed surrogate pair and a null-prototype object', () => {
    const obj = Object.create(null);
    obj.k = cp(0x1f600);
    assert.equal(canonicalize(obj), `{"k":"${cp(0x1f600)}"}`);
  });
});

describe('sha256b64url', () => {
  it('hashes the UTF-8 bytes and encodes base64url without padding', () => {
    assert.equal(sha256b64url(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    assert.equal(sha256b64url(Buffer.from('abc')), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    assert.equal(sha256b64url('abc'), sha256b64url(Buffer.from('abc')));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/platform-jcs.test.js`
Expected: FAIL with `Cannot find module '../src/platform/jcs'`.

- [ ] **Step 3: Implement**

Create `src/platform/jcs.js`:

```js
// RFC 8785 JSON Canonicalization Scheme. Every signed King Louie message is
// the JCS form of a JSON object, so this is the one place that decides which
// values can be signed at all.
const crypto = require('crypto');

class JcsError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'JcsError';
    this.code = code;
  }
}

// A high surrogate not followed by a low one, or a low one not preceded by a
// high one. Such a string has no UTF-8 encoding, so two implementations would
// sign different bytes for it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s) {
  if (LONE_SURROGATE.test(s)) throw new JcsError('non_canonical_value', 'lone surrogate');
  return JSON.stringify(s);
}

function serialize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non_canonical_value', 'non-finite number');
      // ECMAScript number serialization is exactly what RFC 8785 §3.2.2.3 specifies.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      // Array.from visits holes as undefined, which is refused below.
      if (Array.isArray(value)) return `[${Array.from(value, serialize).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new JcsError('non_canonical_value', 'not a plain object');
      }
      // Default sort compares UTF-16 code units, which is the RFC 8785 order.
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${serializeString(k)}:${serialize(value[k])}`).join(',')}}`;
    }
    default:
      throw new JcsError('non_canonical_value', `unsupported type ${typeof value}`);
  }
}

function canonicalize(value) {
  return serialize(value);
}

// base64url (no padding) of SHA-256 over the UTF-8 bytes of a string, or over a Buffer.
function sha256b64url(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

module.exports = { canonicalize, sha256b64url, JcsError };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/platform-jcs.test.js`
Expected: PASS, `fail 0` (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/jcs.js tests/platform-jcs.test.js
git commit -m "feat(platform): RFC 8785 canonical JSON for signed messages

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Dependency-free pattern helpers and `classifyToolCall(…, { cwd })`

**Files:**
- Create: `src/execution/tool-patterns.js`
- Modify: `src/execution/safety-policy.js:1-73` (requires and the helper block from `// Shell control operators…` through the end of `formatToolPattern`), `extractPathsFromParameters` (`:112-126`), `classifyToolCall` signature (`:140`) and its `extractPathsFromParameters` call (`:158`), `module.exports` (`:197-204`)
- Test: `tests/tool-patterns.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/execution/tool-patterns.js` exporting `SHELL_SEPARATORS`, `normalizeWhitespace(text)`, `splitShellSegments(command)`, `patternMatch(pattern, target)`, `formatToolPattern(toolName, parameters)` — moved byte for byte from `safety-policy.js`, which re-exports them. `classifyToolCall(toolName, parameters, policy, { cwd } = {})` and `extractPathsFromParameters(toolName, parameters, cwd = null)` (now exported) also read `file_path` and every `edits[].file_path`, resolving relative paths against `cwd`. Task 4's `toolAction` needs `formatToolPattern` without loading the tool registry (the runbook profile must not, `tests/service-profile-graph.test.js`).

- [ ] **Step 1: Write the failing test**

Create `tests/tool-patterns.test.js`:

```js
// tests/tool-patterns.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const patterns = require('../src/execution/tool-patterns');
const policy = require('../src/execution/safety-policy');

const ROOT = path.join(__dirname, '..');
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

describe('tool-patterns', () => {
  it('is dependency-free: loading it pulls in no other project module', () => {
    const script = `require('./src/execution/tool-patterns'); process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
    const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT }).toString())
      .map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
    assert.deepEqual(loaded, ['src/execution/tool-patterns.js']);
  });

  it('safety-policy re-exports the same functions', () => {
    for (const name of ['formatToolPattern', 'patternMatch', 'splitShellSegments', 'normalizeWhitespace', 'SHELL_SEPARATORS']) {
      assert.equal(policy[name], patterns[name], name);
    }
  });

  it('keeps the helpers behaving as before', () => {
    assert.equal(patterns.formatToolPattern('Bash', { command: 'git push' }), 'Bash(git push)');
    assert.deepEqual(patterns.splitShellSegments('cd x &&  git push ; ls'), ['cd x', 'git push', 'ls']);
    assert.equal(patterns.patternMatch('Bash(git push*)', 'Bash(git  push origin)'), true);
    assert.equal(patterns.normalizeWhitespace(' a \t b '), 'a b');
  });
});

describe('classifyToolCall with { cwd }', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tier-cwd-'));
  tmp.push(base);
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const rules = { allowed_roots: [root], remote_sessions: { always_confirm: [], deny: [] } };

  it('resolves a relative file_path against cwd, not process.cwd()', () => {
    assert.equal(policy.classifyToolCall('Read', { file_path: 'notes.txt' }, rules, { cwd: root }).tier, 'read');
    const outside = policy.classifyToolCall('Read', { file_path: '../secret.txt' }, rules, { cwd: root });
    assert.deepEqual(outside, { tier: 'unsafe', reason: 'path_outside_allowed_roots' });
  });

  it('checks every edits[].file_path', () => {
    const inside = { edits: [{ file_path: path.join(root, 'a.txt') }] };
    const mixed = { edits: [{ file_path: path.join(root, 'a.txt') }, { file_path: path.join(base, 'b.txt') }] };
    assert.notEqual(policy.classifyToolCall('KlNoSuchTool', inside, rules, { cwd: root }).tier, 'unsafe');
    assert.equal(policy.classifyToolCall('KlNoSuchTool', mixed, rules, { cwd: root }).reason, 'path_outside_allowed_roots');
  });

  it('extractPathsFromParameters leaves absolute paths alone and keeps the old behaviour without cwd', () => {
    const abs = path.join(root, 'x');
    assert.deepEqual(policy.extractPathsFromParameters('Read', { file_path: abs }, root), [abs]);
    assert.deepEqual(policy.extractPathsFromParameters('Read', { file_path: 'rel' }), ['rel']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tool-patterns.test.js`
Expected: FAIL with `Cannot find module '../src/execution/tool-patterns'`.

- [ ] **Step 3: Implement**

Create `src/execution/tool-patterns.js` (the five helpers exactly as they are in `safety-policy.js` today):

```js
// Pattern helpers shared by the safety policy, the approval messages and the
// runbook profile. Dependency-free on purpose: safety-policy.js requires the
// tool registry, which the runbook profile must never load
// (tests/service-profile-graph.test.js), and the approval summary needs
// formatToolPattern there too.

// Shell control operators that start a new command. `||` and `&&` come before
// `|` and `&` so the two-character forms are consumed whole. A lone `&` is
// included too: `echo hi & rm -rf /` runs both commands just as `;` would.
const SHELL_SEPARATORS = /\|\||&&|[;|&\r\n]/;

/**
 * Collapses every run of whitespace (spaces, tabs, newlines) to one space and
 * trims the ends, so `rm  -rf /` and `rm\t-rf /` compare equal to `rm -rf /`.
 */
function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Splits a shell command into the individual commands it would run, each
 * whitespace-normalised. Empty pieces (e.g. from a trailing `;`) are dropped.
 */
function splitShellSegments(command) {
  return String(command)
    .split(SHELL_SEPARATORS)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

/**
 * Checks if a wildcard pattern matches a target string.
 * Supports '*' (matches 0 or more chars) and '?' (matches 1 char); every other
 * regex metacharacter in the pattern is matched literally. Whitespace in both
 * pattern and target is normalised first so extra spaces can't dodge a match.
 */
function patternMatch(pattern, target) {
  pattern = normalizeWhitespace(pattern);
  target = normalizeWhitespace(target);
  if (pattern === '*' || pattern === target) return true;
  const regexStr = '^' + pattern
    .replace(/[-[\]{}()+.,\\^$|#\s]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$';
  const regex = new RegExp(regexStr, 'i');
  return regex.test(target);
}

/**
 * Formats a tool call into a string pattern for policy checking.
 * e.g., Bash(ssh user@server) or Vault(get_token)
 */
function formatToolPattern(toolName, parameters = {}) {
  let detail = '';
  if (typeof parameters === 'string') {
    detail = parameters;
  } else if (parameters && typeof parameters === 'object') {
    if (parameters.command) detail = String(parameters.command);
    else if (parameters.filePath) detail = String(parameters.filePath);
    else if (parameters.path) detail = String(parameters.path);
    else if (parameters.key) detail = String(parameters.key);
    else if (parameters.action) detail = String(parameters.action);
    else if (parameters.subcommand) detail = String(parameters.subcommand);
    else detail = JSON.stringify(parameters);
  }
  return `${toolName}(${detail})`;
}

module.exports = {
  SHELL_SEPARATORS,
  normalizeWhitespace,
  splitShellSegments,
  patternMatch,
  formatToolPattern
};
```

In `src/execution/safety-policy.js`, replace everything from line 1 (`const { toolRegistry } = require('../tools');`) through the closing `}` of `formatToolPattern` (line 73, just after `return \`${toolName}(${detail})\`;`) with:

```js
const { toolRegistry } = require('../tools');
const { isPathUnderRoots } = require('../platform/path-roots');
const path = require('path');
const {
  SHELL_SEPARATORS,
  normalizeWhitespace,
  splitShellSegments,
  patternMatch,
  formatToolPattern
} = require('./tool-patterns');

// Tools that only observe state. classifyToolCall gives any other tool that
// passes its checks the `routine` tier.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'status', 'get_state', 'list_machines', 'describe_machine', 'get_job', 'get_job_logs']);

// `$(...)`, backticks and process substitution (`<(...)`, `>(...)`) run a
// command whose text only exists at run time, so no pattern list can say what
// they will do.
const COMMAND_SUBSTITUTION = /\$\(|`|[<>]\(/;
```

(The block that follows, from `/**\n * Checks if a formatted tool call matches any pattern in a list.` onwards, is unchanged.)

Replace `extractPathsFromParameters` with:

```js
function extractPathsFromParameters(toolName, parameters = {}, cwd = null) {
  const paths = [];
  if (!parameters || typeof parameters !== 'object') return paths;

  if (parameters.filePath) paths.push(parameters.filePath);
  // Read, Write, Edit and MultiEdit name their target `file_path` (MultiEdit:
  // per edit). Without these a remote Read or Edit outside allowed_roots was
  // classified read/routine.
  if (typeof parameters.file_path === 'string') paths.push(parameters.file_path);
  if (Array.isArray(parameters.edits)) {
    for (const e of parameters.edits) if (e && typeof e.file_path === 'string') paths.push(e.file_path);
  }
  if (parameters.path) paths.push(parameters.path);
  if (parameters.cwd) paths.push(parameters.cwd);
  if (parameters.workingDirectory) paths.push(parameters.workingDirectory);
  if (parameters.destination) paths.push(parameters.destination);
  if (parameters.dest) paths.push(parameters.dest);
  if (Array.isArray(parameters.sources)) {
    for (const s of parameters.sources) if (typeof s === 'string') paths.push(s);
  }
  // A relative path means "relative to where the tool runs", not to wherever
  // this process happens to be.
  if (!cwd) return paths;
  return paths.map((p) => (typeof p === 'string' && p && !path.isAbsolute(p) ? path.resolve(cwd, p) : p));
}
```

Change the `classifyToolCall` signature line to:

```js
function classifyToolCall(toolName, parameters = {}, policy = {}, { cwd = null } = {}) {
```

and its path line (`const paths = extractPathsFromParameters(toolName, parameters);`) to:

```js
  const paths = extractPathsFromParameters(toolName, parameters, cwd);
```

Replace `module.exports` at the end of the file with:

```js
module.exports = {
  patternMatch,
  formatToolPattern,
  normalizeWhitespace,
  splitShellSegments,
  SHELL_SEPARATORS,
  extractPathsFromParameters,
  matchesPatternList,
  isPathUnderRoots,
  classifyToolCall,
  isRemoteToolExecutionUnsafe
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/tool-patterns.test.js tests/safety-policy.test.js`
Expected: PASS, `fail 0` (the existing safety-policy tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/execution/tool-patterns.js src/execution/safety-policy.js tests/tool-patterns.test.js
git commit -m "refactor(execution): dependency-free pattern helpers; tiers read file_path relative to cwd

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Signed envelopes and device ids

**Files:**
- Create: `src/approvals/envelope.js`
- Test: `tests/approvals-envelope.test.js`

**Interfaces:**
- Consumes: `canonicalize` (Task 1), `base32Encode` (`src/mesh/node-identity.js`).
- Produces (program P2): `seal(message, signer) → { alg, kid, payload, sig }` (`signer = { alg, kid, sign(bytes) → Buffer }`), `open(envelope) → { message, bytes }` (throws `EnvelopeError` with `reason: 'malformed'`), `verifyEd25519(envelope, spkiDerHex) → boolean`, `verifyEs256(envelope, jwk) → boolean`, `nodeSigner(identity) → signer`, `deriveDeviceId(raw, prefix = 'd-')`, `deviceIdFromJwk(jwk)`, `ed25519RawToSpki(raw32) → Buffer`, `fingerprintGroups(id) → 'abcd efgh ijkl mnop'`, `isDeviceJwk(jwk)`, `toB64url(bytes)`, `fromB64url(text)` (strict), `class EnvelopeError`.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-envelope.test.js`:

```js
// tests/approvals-envelope.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  EnvelopeError, seal, open, verifyEd25519, verifyEs256, nodeSigner, deriveDeviceId,
  deviceIdFromJwk, ed25519RawToSpki, fingerprintGroups, isDeviceJwk, toB64url, fromB64url
} = require('../src/approvals/envelope');

function ed25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { spkiHex: spki.toString('hex'), identity: { nodeId: 'kl-aaaaaaaaaaaaaaaa', sign: (b) => crypto.sign(null, b, privateKey) } };
}

function p256() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { kty, crv, x, y };
  const id = deviceIdFromJwk(jwk);
  return { jwk, id, signer: { alg: 'ES256', kid: id, sign: (b) => crypto.sign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }) } };
}

describe('seal / open', () => {
  it('round-trips a message and signs the JCS bytes', () => {
    const node = ed25519();
    const env = seal({ z: 1, a: 'x', v: 1 }, nodeSigner(node.identity));
    assert.deepEqual(Object.keys(env).sort(), ['alg', 'kid', 'payload', 'sig']);
    assert.equal(env.alg, 'Ed25519');
    assert.equal(env.kid, 'kl-aaaaaaaaaaaaaaaa');
    const { message, bytes } = open(env);
    assert.deepEqual(message, { a: 'x', v: 1, z: 1 });
    assert.equal(bytes.toString('utf8'), '{"a":"x","v":1,"z":1}');
    assert.equal(verifyEd25519(env, node.spkiHex), true);
  });

  it('refuses non-canonical, duplicate-key, non-object and extra-member envelopes as malformed', () => {
    const node = ed25519();
    const signer = nodeSigner(node.identity);
    const raw = (text) => ({ alg: 'Ed25519', kid: signer.kid, payload: toB64url(Buffer.from(text)), sig: toB64url(signer.sign(Buffer.from(text))) });
    const cases = [
      raw('{ "a": 1 }'),
      raw('{"a":1,"a":1}'),
      raw('[1]'),
      raw('not json'),
      { ...seal({ a: 1 }, signer), extra: 'x' },
      { alg: 'Ed25519', kid: signer.kid, payload: 'eyJhIjoxfQ==', sig: 'AA' },
      null
    ];
    for (const env of cases) {
      assert.throws(() => open(env), (err) => err instanceof EnvelopeError && err.reason === 'malformed');
    }
  });

  it('verifies over the bytes received: a changed payload fails', () => {
    const node = ed25519();
    const env = seal({ a: 1 }, nodeSigner(node.identity));
    const tampered = { ...env, payload: toB64url(Buffer.from('{"a":2}')) };
    assert.equal(verifyEd25519(tampered, node.spkiHex), false);
    assert.equal(verifyEd25519({ ...env, alg: 'ES256' }, node.spkiHex), false);
    assert.equal(verifyEd25519(env, ed25519().spkiHex), false);
  });
});

describe('ES256 device signatures', () => {
  it('verifies P1363 signatures against the JWK and rejects others', () => {
    const phone = p256();
    const env = seal({ v: 1, device_id: phone.id }, phone.signer);
    assert.equal(verifyEs256(env, phone.jwk), true);
    assert.equal(verifyEs256(env, p256().jwk), false);
    assert.equal(verifyEs256({ ...env, alg: 'Ed25519' }, phone.jwk), false);
    // A DER-encoded signature (what Android's Signature produces) is not P1363.
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const derSig = crypto.sign('sha256', fromB64url(env.payload), privateKey);
    assert.equal(verifyEs256({ ...env, sig: toB64url(derSig) }, phone.jwk), false);
  });

  it('accepts only a JWK with exactly kty, crv, x, y', () => {
    const { jwk } = p256();
    assert.equal(isDeviceJwk(jwk), true);
    assert.equal(isDeviceJwk({ ...jwk, d: 'secret' }), false);
    assert.equal(isDeviceJwk({ ...jwk, crv: 'P-384' }), false);
    assert.equal(isDeviceJwk({ kty: 'EC', crv: 'P-256', x: jwk.x }), false);
    assert.throws(() => deviceIdFromJwk({ ...jwk, d: 'secret' }), EnvelopeError);
  });
});

describe('identifiers', () => {
  it('derives device ids from the uncompressed point, and kld- ids from Ed25519 keys', () => {
    const raw = Buffer.alloc(65, 7);
    raw[0] = 4;
    const id = deriveDeviceId(raw);
    assert.match(id, /^d-[a-z2-7]{16}$/);
    assert.match(deriveDeviceId(Buffer.alloc(32, 1), 'kld-'), /^kld-[a-z2-7]{16}$/);
    const { jwk } = p256();
    const point = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]);
    assert.equal(deviceIdFromJwk(jwk), deriveDeviceId(point));
  });

  it('wraps a raw Ed25519 key in DER SPKI that Node accepts', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    assert.deepEqual(ed25519RawToSpki(spki.subarray(12)), spki);
    assert.throws(() => ed25519RawToSpki(Buffer.alloc(31)), EnvelopeError);
  });

  it('groups a fingerprint in fours after the prefix', () => {
    assert.equal(fingerprintGroups('d-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
    assert.equal(fingerprintGroups('kl-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
  });

  it('decodes base64url strictly', () => {
    assert.deepEqual(fromB64url('AQID'), Buffer.from([1, 2, 3]));
    for (const bad of ['AQID=', 'AQ+D', 'A', 'AR']) assert.throws(() => fromB64url(bad), EnvelopeError, bad);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-envelope.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/envelope'`.

- [ ] **Step 3: Implement**

Create `src/approvals/envelope.js`:

```js
// Signed envelopes: { alg, kid, payload, sig }. `payload` is the base64url
// JCS bytes of the message and `sig` is the signature over exactly those
// bytes. Verifiers check the bytes they received and never re-canonicalize to
// verify; `open` additionally insists the bytes are canonical, which rules out
// duplicate keys and parser differentials.
const crypto = require('crypto');
const { canonicalize } = require('../platform/jcs');
const { base32Encode } = require('../mesh/node-identity');

class EnvelopeError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'EnvelopeError';
    this.reason = reason;
  }
}

const B64URL = /^[A-Za-z0-9_-]*$/;
const ENVELOPE_KEYS = ['alg', 'kid', 'payload', 'sig'];
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// Strict: only the base64url alphabet, no padding, and the text must be the
// one canonical encoding of the bytes it decodes to.
function fromB64url(text) {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length % 4 === 1) {
    throw new EnvelopeError('malformed', 'not base64url');
  }
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new EnvelopeError('malformed', 'non-canonical base64url');
  return bytes;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function seal(message, signer) {
  if (!signer || typeof signer.sign !== 'function') throw new TypeError('seal needs a signer { alg, kid, sign(bytes) }');
  const bytes = Buffer.from(canonicalize(message), 'utf8');
  const sig = signer.sign(bytes);
  return { alg: signer.alg, kid: signer.kid, payload: toB64url(bytes), sig: toB64url(sig) };
}

function open(envelope) {
  if (!isPlainObject(envelope)) throw new EnvelopeError('malformed', 'envelope is not an object');
  const keys = Object.keys(envelope).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) {
    throw new EnvelopeError('malformed', 'envelope must have exactly alg, kid, payload, sig');
  }
  for (const k of ENVELOPE_KEYS) {
    if (typeof envelope[k] !== 'string' || envelope[k] === '') throw new EnvelopeError('malformed', `${k} must be a non-empty string`);
  }
  const bytes = fromB64url(envelope.payload);
  fromB64url(envelope.sig);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new EnvelopeError('malformed', 'payload is not UTF-8');
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new EnvelopeError('malformed', 'payload is not JSON');
  }
  if (!isPlainObject(message)) throw new EnvelopeError('malformed', 'payload is not an object');
  let canonical;
  try {
    canonical = canonicalize(message);
  } catch {
    throw new EnvelopeError('malformed', 'payload cannot be canonicalized');
  }
  if (!Buffer.from(canonical, 'utf8').equals(bytes)) throw new EnvelopeError('malformed', 'payload is not canonical');
  return { message, bytes };
}

function verifyEd25519(envelope, spkiDerHex) {
  try {
    if (!envelope || envelope.alg !== 'Ed25519') return false;
    const bytes = fromB64url(envelope.payload);
    const sig = fromB64url(envelope.sig);
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(spkiDerHex, 'hex'), format: 'der', type: 'spki' });
    return crypto.verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

function isDeviceJwk(jwk) {
  if (!isPlainObject(jwk)) return false;
  const keys = Object.keys(jwk).sort();
  if (keys.join(',') !== 'crv,kty,x,y') return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  try {
    return fromB64url(jwk.x).length === 32 && fromB64url(jwk.y).length === 32;
  } catch {
    return false;
  }
}

function verifyEs256(envelope, jwk) {
  try {
    if (!envelope || envelope.alg !== 'ES256' || !isDeviceJwk(jwk)) return false;
    const bytes = fromB64url(envelope.payload);
    const sig = fromB64url(envelope.sig);
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return crypto.verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

// The node's Ed25519 identity as an envelope signer. `identity` is a
// NodeIdentity or anything with nodeId and sign(bytes).
function nodeSigner(identity) {
  return { alg: 'Ed25519', kid: identity.nodeId, sign: (bytes) => identity.sign(bytes) };
}

// prefix + base32(sha256(raw))[0..16], lowercase RFC 4648 without padding.
// Phones: raw is the 65-byte uncompressed P-256 point. Desktops (F7): the
// 32-byte Ed25519 key with prefix `kld-`.
function deriveDeviceId(rawPublicKey, prefix = 'd-') {
  const raw = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey);
  return prefix + base32Encode(crypto.createHash('sha256').update(raw).digest()).slice(0, 16);
}

function deviceIdFromJwk(jwk) {
  if (!isDeviceJwk(jwk)) throw new EnvelopeError('malformed', 'not a P-256 device JWK');
  return deriveDeviceId(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]));
}

function ed25519RawToSpki(raw32) {
  const raw = Buffer.from(raw32);
  if (raw.length !== 32) throw new EnvelopeError('malformed', 'an Ed25519 key is 32 bytes');
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

// 'd-abcdefghijklmnop' → 'abcd efgh ijkl mnop': what the owner compares on two screens.
function fingerprintGroups(id) {
  const body = String(id).slice(String(id).indexOf('-') + 1);
  return (body.match(/.{1,4}/g) || []).join(' ');
}

module.exports = {
  EnvelopeError,
  seal,
  open,
  verifyEd25519,
  verifyEs256,
  nodeSigner,
  deriveDeviceId,
  deviceIdFromJwk,
  ed25519RawToSpki,
  fingerprintGroups,
  isDeviceJwk,
  toB64url,
  fromB64url
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-envelope.test.js`
Expected: PASS, `fail 0` (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/envelope.js tests/approvals-envelope.test.js
git commit -m "feat(approvals): signed envelopes over JCS bytes, device ids and fingerprints

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: approval-v1 messages

**Files:**
- Create: `src/approvals/messages.js`
- Test: `tests/approvals-messages.test.js`

**Interfaces:**
- Consumes: `canonicalize`, `sha256b64url` (Task 1); `formatToolPattern` (Task 2); `seal`, `open`, `nodeSigner`, `deviceIdFromJwk`, `isDeviceJwk`, `fromB64url`, `toB64url`, `EnvelopeError` (Task 3); `substituteArgv` (`src/runbooks/runbook-engine.js`, required lazily inside `runbookAction`).
- Produces (program P8 and helpers): `toolAction(toolName, params, cwd)`, `runbookAction(runbook, validatedParams, nodeName)`, `envelopeAction({ executorId, caseId, envelopeHash, summary })`, `actionHash(action)`, `normalizeOrigin(origin)`, `buildRequest({ identity, action, origin, ttlMs, now, requestId?, nonce? }) → { message, envelope, bytes }`, `buildStatus({ identity, requestId, state, deviceId, reason, now })`, `buildEnrollOpen({ identity, codeId, expiresAt })`, `buildEnrollDone({ identity, codeId, enroll, refused })`, `enrollMac(code, messageWithoutMac)`, `inviteMac(secret, device)`, `phoneAuthString(method, pathWithQuery, timestamp, body)`, `encodeQr(object)`, `decodeQr(text)`, `validateMessage(type, message) → null | 'malformed' | 'unsupported_version'`, `registerMessageValidator(type, fn)`, `parseMessage(envelope, type)`, `parseResponse`, `parseEnroll`, `parseRevoke`, `class MessageError` (`reason` ∈ `non_canonical`, `action_too_large`, `malformed`, `unsupported_version`), constants `TIMESTAMP_RE`, `NONCE_RE`, `CODE_ID_RE`, `DEVICE_ID_RE`, `NODE_ID_RE`, `MAX_ACTION_BYTES`, `TTL_MIN_MS`, `TTL_MAX_MS`, `PLATFORMS`, and `iso(ms)`, `randomNonce()`, `clampTtl(ms)`, `cutSummary(text)`.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-messages.test.js`:

```js
// tests/approvals-messages.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { deriveNodeId } = require('../src/mesh/node-identity');
const { open, verifyEd25519, seal, deviceIdFromJwk } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');

function testIdentity(nodeName = 'web-01') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName, publicKey: spki, sign: (b) => crypto.sign(null, b, privateKey) };
}

function testDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { kty, crv, x, y };
  const id = deviceIdFromJwk(jwk);
  return { jwk, id, signer: { alg: 'ES256', kid: id, sign: (b) => crypto.sign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }) } };
}

const NOW = Date.parse('2026-09-23T18:04:11.201Z');

describe('actions', () => {
  it('toolAction clones params through JCS and summarises with formatToolPattern', () => {
    const params = { command: 'git push origin main' };
    const action = m.toolAction('Bash', params, '/srv/site');
    assert.deepEqual(action, { kind: 'tool', name: 'Bash', params: { command: 'git push origin main' }, cwd: '/srv/site', summary: 'Bash(git push origin main)' });
    assert.notEqual(action.params, params);
    assert.equal(m.toolAction('Read', { file_path: 'a' }, undefined).cwd, null);
  });

  it('cuts the summary to 300 characters with an ellipsis', () => {
    const summary = m.toolAction('Bash', { command: 'x'.repeat(1000) }, null).summary;
    assert.equal(Array.from(summary).length, 300);
    assert.ok(summary.endsWith('…'));
  });

  it('refuses parameters that are not JSON', () => {
    for (const params of [{ a: undefined }, { n: NaN }, { d: new Date(0) }]) {
      assert.throws(() => m.toolAction('Bash', params, null), (err) => err.reason === 'non_canonical');
    }
  });

  it('runbookAction substitutes every run argv and keeps checks', () => {
    const runbook = {
      name: 'site.pull_and_restart',
      steps: [{ run: ['git', '-C', '{{dir}}', 'fetch', '--prune', 'origin'] }, { check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 } }]
    };
    const action = m.runbookAction(runbook, { dir: '/srv/site' }, 'web-01');
    assert.deepEqual(action, {
      kind: 'runbook',
      name: 'site.pull_and_restart',
      params: { dir: '/srv/site' },
      steps: [['git', '-C', '/srv/site', 'fetch', '--prune', 'origin'], { check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 } }],
      summary: 'Run runbook site.pull_and_restart on web-01'
    });
  });

  it('envelopeAction has the C3 shape', () => {
    assert.deepEqual(m.envelopeAction({ executorId: 'mail.send', caseId: 'lakeside-lot', envelopeHash: 'h', summary: 'Send one email' }), {
      kind: 'envelope', name: 'mail.send', params: { case_id: 'lakeside-lot', envelope_hash: 'h' }, summary: 'Send one email'
    });
  });

  it('actionHash is order-independent and changes with any value', () => {
    const a = m.actionHash({ kind: 'tool', params: { a: 1, b: 2 } });
    assert.equal(a, m.actionHash({ params: { b: 2, a: 1 }, kind: 'tool' }));
    assert.notEqual(a, m.actionHash({ kind: 'tool', params: { a: 1, b: 3 } }));
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('buildRequest', () => {
  it('signs a well-formed request with the node key', () => {
    const identity = testIdentity();
    const action = m.toolAction('Bash', { command: 'ls' }, '/tmp');
    const { message, envelope } = m.buildRequest({ identity, action, origin: { client: 'stdio-mcp', job_id: 'job-1' }, ttlMs: 300000, now: NOW });
    assert.equal(envelope.alg, 'Ed25519');
    assert.equal(envelope.kid, identity.nodeId);
    assert.equal(verifyEd25519(envelope, identity.publicKey.toString('hex')), true);
    assert.equal(m.validateMessage('kl.approval.request', open(envelope).message), null);
    assert.equal(message.expires_at, '2026-09-23T18:09:11.201Z');
    assert.deepEqual(message.origin, { client: 'stdio-mcp', session: null, job_id: 'job-1' });
    assert.equal(message.action_hash, m.actionHash(action));
  });

  it('clamps the TTL to 30–300 s', () => {
    const identity = testIdentity();
    const action = m.toolAction('Bash', { command: 'ls' }, null);
    const exp = (ttlMs) => Date.parse(m.buildRequest({ identity, action, ttlMs, now: NOW }).message.expires_at) - NOW;
    assert.equal(exp(5000), 30000);
    assert.equal(exp(900000), 300000);
    assert.equal(exp(120000), 120000);
  });

  it('refuses an action over 256 KiB', () => {
    const identity = testIdentity();
    const action = { kind: 'tool', name: 'Write', params: { content: 'x'.repeat(262144) }, cwd: null, summary: 'Write' };
    assert.throws(() => m.buildRequest({ identity, action, now: NOW }), (err) => err.reason === 'action_too_large');
  });

  it('adds deviceId to a desktop origin only', () => {
    assert.deepEqual(m.normalizeOrigin({ client: 'desktop', deviceId: 'kld-x', session: 's' }), { client: 'desktop', session: 's', job_id: null, deviceId: 'kld-x' });
    assert.deepEqual(m.normalizeOrigin(null), { client: 'king-louie', session: null, job_id: null });
  });
});

describe('validators', () => {
  const identity = testIdentity();
  const phone = testDevice();
  const response = () => ({
    v: 1, type: 'kl.approval.response', request_id: crypto.randomUUID(), node_id: identity.nodeId,
    action_hash: m.actionHash({ a: 1 }), nonce: m.randomNonce(), decision: 'approve',
    expires_at: '2026-09-23T18:09:11.201Z', device_id: phone.id, signed_at: '2026-09-23T18:05:00.000Z'
  });

  it('accepts a good response and names the fault otherwise', () => {
    assert.equal(m.validateMessage('kl.approval.response', response()), null);
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), v: 2 }), 'unsupported_version');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), v: '1' }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), decision: 'maybe' }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), extra: 1 }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.response', { ...response(), signed_at: '2026-09-23 18:05' }), 'malformed');
    assert.equal(m.validateMessage('kl.approval.status', response()), 'malformed');
  });

  it('parseResponse opens and validates', () => {
    const env = seal(response(), phone.signer);
    assert.equal(m.parseResponse(env).message.device_id, phone.id);
    assert.throws(() => m.parseResponse(seal({ ...response(), v: 2 }, phone.signer)), (err) => err.reason === 'unsupported_version');
  });

  it('checks enrollments: derived device id, 10-minute window, console fields', () => {
    const device = { device_id: phone.id, name: 'Pixel 9', platform: 'android', public_key: phone.jwk };
    const signed = { v: 1, type: 'kl.device.enroll', device, enrolled_by: testDevice().id, created_at: '2026-09-23T18:00:00.000Z', expires_at: '2026-09-23T18:10:00.000Z', nonce: m.randomNonce() };
    assert.equal(m.validateMessage('kl.device.enroll', signed), null);
    assert.equal(m.validateMessage('kl.device.enroll', { ...signed, expires_at: '2026-09-23T18:10:00.001Z' }), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', { ...signed, device: { ...device, device_id: testDevice().id } }), 'malformed');
    const consoleEnroll = { ...signed, enrolled_by: null, code_id: crypto.randomBytes(16).toString('base64url') };
    assert.equal(m.validateMessage('kl.device.enroll', consoleEnroll), 'malformed');
    const code = crypto.randomBytes(32).toString('base64url');
    const withMac = { ...consoleEnroll, code_mac: m.enrollMac(code, consoleEnroll) };
    assert.equal(m.validateMessage('kl.device.enroll', withMac), null);
  });

  it('checks revocations within 7 days', () => {
    const revoke = { v: 1, type: 'kl.device.revoke', device_id: phone.id, revoked_by: testDevice().id, reason: 'lost', created_at: '2026-09-23T18:00:00.000Z', expires_at: '2026-09-30T18:00:00.000Z', nonce: m.randomNonce() };
    assert.equal(m.validateMessage('kl.device.revoke', revoke), null);
    assert.equal(m.validateMessage('kl.device.revoke', { ...revoke, expires_at: '2026-09-30T18:00:00.001Z' }), 'malformed');
  });

  it('lets another stage register a type, once', () => {
    const type = `kl.test.${crypto.randomBytes(4).toString('hex')}`;
    m.registerMessageValidator(type, (msg) => msg.ok === true);
    assert.equal(m.validateMessage(type, { v: 1, type, ok: true }), null);
    assert.equal(m.validateMessage(type, { v: 1, type, ok: false }), 'malformed');
    assert.throws(() => m.registerMessageValidator(type, () => true));
  });
});

describe('control messages and QR codes', () => {
  it('builds node-signed status, enroll.open and enroll.done', () => {
    const identity = testIdentity();
    const status = open(m.buildStatus({ identity, requestId: crypto.randomUUID(), state: 'approved', deviceId: testDevice().id, now: NOW })).message;
    assert.equal(m.validateMessage('kl.approval.status', status), null);
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.equal(m.validateMessage('kl.enroll.open', open(m.buildEnrollOpen({ identity, codeId, expiresAt: NOW + 600000 })).message), null);
    assert.equal(m.validateMessage('kl.enroll.done', open(m.buildEnrollDone({ identity, codeId, refused: true })).message), null);
  });

  it('builds the phone API signing string', () => {
    const s = m.phoneAuthString('post', '/v1/approvals/x/response?a=1', '2026-09-23T18:05:00Z', '{"k":1}');
    const bodyHash = crypto.createHash('sha256').update('{"k":1}').digest('base64url');
    assert.equal(s, ['KL-PHONE-V1', 'POST', '/v1/approvals/x/response?a=1', '2026-09-23T18:05:00Z', bodyHash].join('\n'));
    assert.equal(m.phoneAuthString('GET', '/v1/time', 't', null).split('\n')[4], crypto.createHash('sha256').update('').digest('base64url'));
  });

  it('round-trips kl1: QR payloads', () => {
    const payload = { t: 'kl.relay', relay: 'https://kl.example.com:8443', relay_spki: 'sha256/abc' };
    const text = m.encodeQr(payload);
    assert.match(text, /^kl1:[A-Za-z0-9_-]+$/);
    assert.deepEqual(m.decodeQr(text), payload);
    assert.throws(() => m.decodeQr('kl2:xx'), (err) => err.reason === 'malformed');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-messages.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/messages'`.

- [ ] **Step 3: Implement**

Create `src/approvals/messages.js`:

```js
// approval-v1 message builders and validators (docs/protocol/approval-v1.md).
// Everything signed goes through here, so the shapes live in one place.
const crypto = require('crypto');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const { formatToolPattern } = require('../execution/tool-patterns');
const { seal, open, nodeSigner, deviceIdFromJwk, isDeviceJwk, fromB64url, toB64url, EnvelopeError } = require('./envelope');

class MessageError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'MessageError';
    this.reason = reason;
  }
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID_RE = /^d-[a-z2-7]{16}$/;
const NODE_ID_RE = /^kl-[a-z2-7]{16}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ACTION_BYTES = 262144;
const SUMMARY_MAX = 300;
const TTL_MIN_MS = 30000;
const TTL_MAX_MS = 300000;
const ENROLL_MAX_MS = 10 * 60 * 1000;
const REVOKE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const PLATFORMS = ['ios', 'android', 'demo'];
const STATUS_STATES = ['approved', 'denied', 'expired', 'withdrawn', 'refused'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
const isTimestamp = (v) => isString(v) && TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v));
const nullOr = (test) => (v) => v === null || test(v);
const iso = (ms) => new Date(ms).toISOString();
const randomNonce = () => crypto.randomBytes(32).toString('base64url');
const clampTtl = (ms) => Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Number.isFinite(ms) ? ms : TTL_MAX_MS));

function hasExactKeys(obj, keys) {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

// Code points, not UTF-16 units, so a cut never leaves a lone surrogate.
function cutSummary(text) {
  const chars = Array.from(String(text));
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : chars.join('');
}

function cloneJson(value) {
  try {
    return JSON.parse(canonicalize(value));
  } catch (err) {
    throw new MessageError('non_canonical', err.message);
  }
}

function toolAction(toolName, params, cwd) {
  const cloned = cloneJson(params === undefined || params === null ? {} : params);
  return {
    kind: 'tool',
    name: String(toolName),
    params: cloned,
    cwd: cwd === undefined || cwd === null ? null : String(cwd),
    summary: cutSummary(formatToolPattern(toolName, cloned))
  };
}

// `validatedParams` are the engine's validated values (defaults applied,
// paths realpath'd); `steps` are the argv each `run` step will execute with
// them substituted, and every `check` as written (parent §8.4).
function runbookAction(runbook, validatedParams, nodeName) {
  const { substituteArgv } = require('../runbooks/runbook-engine');
  const values = validatedParams || {};
  const steps = (runbook.steps || []).map((step) => (Array.isArray(step.run)
    ? substituteArgv(step.run, values)
    : { check: cloneJson(step.check) }));
  return {
    kind: 'runbook',
    name: String(runbook.name),
    params: cloneJson(values),
    steps: cloneJson(steps),
    summary: cutSummary(`Run runbook ${runbook.name} on ${nodeName}`)
  };
}

function envelopeAction({ executorId, caseId, envelopeHash, summary }) {
  return {
    kind: 'envelope',
    name: String(executorId),
    params: { case_id: String(caseId), envelope_hash: String(envelopeHash) },
    summary: cutSummary(summary || `Run ${executorId} for case ${caseId}`)
  };
}

function actionHash(action) {
  let text;
  try {
    text = canonicalize(action);
  } catch (err) {
    throw new MessageError('non_canonical', err.message);
  }
  return sha256b64url(text);
}

function normalizeOrigin(origin) {
  const o = origin || {};
  const out = {
    client: String(o.client || 'king-louie'),
    session: o.session === undefined || o.session === null ? null : String(o.session),
    job_id: o.job_id === undefined || o.job_id === null ? null : String(o.job_id)
  };
  if (out.client === 'desktop') out.deviceId = o.deviceId === undefined || o.deviceId === null ? null : String(o.deviceId);
  return out;
}

function buildRequest({ identity, action, origin, ttlMs = TTL_MAX_MS, now = Date.now(), requestId = null, nonce = null }) {
  let actionText;
  try {
    actionText = canonicalize(action);
  } catch (err) {
    throw new MessageError('non_canonical', err.message);
  }
  if (Buffer.byteLength(actionText, 'utf8') > MAX_ACTION_BYTES) {
    throw new MessageError('action_too_large', `the action is over ${MAX_ACTION_BYTES} bytes`);
  }
  const message = {
    v: 1,
    type: 'kl.approval.request',
    request_id: requestId || crypto.randomUUID(),
    node_id: identity.nodeId,
    node_name: String(identity.nodeName || 'unnamed-node'),
    action,
    action_hash: sha256b64url(actionText),
    origin: normalizeOrigin(origin),
    created_at: iso(now),
    expires_at: iso(now + clampTtl(ttlMs)),
    nonce: nonce || randomNonce()
  };
  const envelope = seal(message, nodeSigner(identity));
  return { message, envelope, bytes: fromB64url(envelope.payload) };
}

function buildStatus({ identity, requestId, state, deviceId = null, reason = null, now = Date.now() }) {
  return seal({
    v: 1,
    type: 'kl.approval.status',
    request_id: requestId,
    node_id: identity.nodeId,
    state,
    device_id: deviceId,
    reason,
    at: iso(now)
  }, nodeSigner(identity));
}

function buildEnrollOpen({ identity, codeId, expiresAt, nonce = null }) {
  return seal({ v: 1, type: 'kl.enroll.open', node_id: identity.nodeId, code_id: codeId, expires_at: iso(expiresAt), nonce: nonce || randomNonce() }, nodeSigner(identity));
}

function buildEnrollDone({ identity, codeId, enroll = null, refused = false, nonce = null }) {
  return seal({ v: 1, type: 'kl.enroll.done', node_id: identity.nodeId, code_id: codeId, enroll, refused: refused === true, nonce: nonce || randomNonce() }, nodeSigner(identity));
}

// HMAC-SHA256 keyed with the raw bytes of a base64url secret (the console
// `code`, or an invite `secret`) over the JCS text of `value`.
function hmacB64url(secretB64url, value) {
  return crypto.createHmac('sha256', fromB64url(secretB64url)).update(canonicalize(value)).digest('base64url');
}

function enrollMac(code, messageWithoutMac) {
  return hmacB64url(code, messageWithoutMac);
}

function inviteMac(secret, device) {
  return hmacB64url(secret, device);
}

// The string a phone signs for device-authenticated phone API calls (§4.5).
// The relay keys replay protection on SHA-256 of this string.
function phoneAuthString(method, pathWithQuery, timestamp, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined || body === null ? '' : String(body), 'utf8');
  const bodyHash = crypto.createHash('sha256').update(bytes).digest('base64url');
  return ['KL-PHONE-V1', String(method).toUpperCase(), pathWithQuery, timestamp, bodyHash].join('\n');
}

function encodeQr(object) {
  return `kl1:${toB64url(Buffer.from(canonicalize(object), 'utf8'))}`;
}

function decodeQr(text) {
  if (typeof text !== 'string' || !text.startsWith('kl1:')) throw new MessageError('malformed', 'not a kl1: code');
  const parsed = JSON.parse(fromB64url(text.slice(4)).toString('utf8'));
  if (!isPlainObject(parsed) || !isString(parsed.t)) throw new MessageError('malformed', 'QR payload has no type');
  return parsed;
}

// ── Validators ──────────────────────────────────────────────────────────────
// Each returns null when the message is well formed, else the reason.

function checkAction(action) {
  if (!isPlainObject(action) || !isString(action.summary) || !isString(action.name)) return false;
  if (action.kind === 'tool') return hasExactKeys(action, ['kind', 'name', 'params', 'cwd', 'summary']) && isPlainObject(action.params) && (action.cwd === null || isString(action.cwd));
  if (action.kind === 'runbook') return hasExactKeys(action, ['kind', 'name', 'params', 'steps', 'summary']) && isPlainObject(action.params) && Array.isArray(action.steps);
  if (action.kind === 'envelope') {
    return hasExactKeys(action, ['kind', 'name', 'params', 'summary']) && isPlainObject(action.params)
      && hasExactKeys(action.params, ['case_id', 'envelope_hash']) && isString(action.params.case_id) && isString(action.params.envelope_hash);
  }
  return false;
}

function checkOrigin(origin) {
  if (!isPlainObject(origin) || !isString(origin.client)) return false;
  const keys = origin.client === 'desktop' ? ['client', 'session', 'job_id', 'deviceId'] : ['client', 'session', 'job_id'];
  return hasExactKeys(origin, keys) && Object.values(origin).every((v) => v === null || isString(v));
}

function isDevice(device) {
  if (!isPlainObject(device) || !hasExactKeys(device, ['device_id', 'name', 'platform', 'public_key'])) return false;
  if (!isString(device.name) || device.name.length < 1 || device.name.length > 64) return false;
  if (!PLATFORMS.includes(device.platform) || !isDeviceJwk(device.public_key)) return false;
  return DEVICE_ID_RE.test(device.device_id) && deviceIdFromJwk(device.public_key) === device.device_id;
}

const VALIDATORS = {
  'kl.approval.request': (m) => hasExactKeys(m, ['v', 'type', 'request_id', 'node_id', 'node_name', 'action', 'action_hash', 'origin', 'created_at', 'expires_at', 'nonce'])
    && UUID_V4_RE.test(m.request_id) && NODE_ID_RE.test(m.node_id) && isString(m.node_name) && checkAction(m.action)
    && HASH_RE.test(m.action_hash) && checkOrigin(m.origin) && isTimestamp(m.created_at) && isTimestamp(m.expires_at) && NONCE_RE.test(m.nonce),
  'kl.approval.response': (m) => hasExactKeys(m, ['v', 'type', 'request_id', 'node_id', 'action_hash', 'nonce', 'decision', 'expires_at', 'device_id', 'signed_at'])
    && UUID_V4_RE.test(m.request_id) && NODE_ID_RE.test(m.node_id) && HASH_RE.test(m.action_hash) && NONCE_RE.test(m.nonce)
    && (m.decision === 'approve' || m.decision === 'deny') && isTimestamp(m.expires_at) && DEVICE_ID_RE.test(m.device_id) && isTimestamp(m.signed_at),
  'kl.approval.status': (m) => hasExactKeys(m, ['v', 'type', 'request_id', 'node_id', 'state', 'device_id', 'reason', 'at'])
    && UUID_V4_RE.test(m.request_id) && NODE_ID_RE.test(m.node_id) && STATUS_STATES.includes(m.state)
    && nullOr((v) => DEVICE_ID_RE.test(v))(m.device_id) && nullOr(isString)(m.reason) && isTimestamp(m.at),
  'kl.device.enroll': (m) => {
    const base = ['v', 'type', 'device', 'enrolled_by', 'created_at', 'expires_at', 'nonce'];
    const consoleEnroll = m.enrolled_by === null;
    if (!hasExactKeys(m, consoleEnroll ? [...base, 'code_id', 'code_mac'] : base)) return false;
    if (!consoleEnroll && !(isString(m.enrolled_by) && DEVICE_ID_RE.test(m.enrolled_by))) return false;
    if (consoleEnroll && !(CODE_ID_RE.test(m.code_id) && HASH_RE.test(m.code_mac))) return false;
    if (!isDevice(m.device) || !isTimestamp(m.created_at) || !isTimestamp(m.expires_at) || !NONCE_RE.test(m.nonce)) return false;
    const span = Date.parse(m.expires_at) - Date.parse(m.created_at);
    return span > 0 && span <= ENROLL_MAX_MS;
  },
  'kl.device.revoke': (m) => {
    if (!hasExactKeys(m, ['v', 'type', 'device_id', 'revoked_by', 'reason', 'created_at', 'expires_at', 'nonce'])) return false;
    if (!DEVICE_ID_RE.test(m.device_id) || !DEVICE_ID_RE.test(m.revoked_by) || !isString(m.reason) || m.reason.length > 200) return false;
    if (!isTimestamp(m.created_at) || !isTimestamp(m.expires_at) || !NONCE_RE.test(m.nonce)) return false;
    const span = Date.parse(m.expires_at) - Date.parse(m.created_at);
    return span > 0 && span <= REVOKE_MAX_MS;
  },
  'kl.enroll.open': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'code_id', 'expires_at', 'nonce'])
    && NODE_ID_RE.test(m.node_id) && CODE_ID_RE.test(m.code_id) && isTimestamp(m.expires_at) && NONCE_RE.test(m.nonce),
  'kl.enroll.done': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'code_id', 'enroll', 'refused', 'nonce'])
    && NODE_ID_RE.test(m.node_id) && CODE_ID_RE.test(m.code_id) && (m.enroll === null || isPlainObject(m.enroll))
    && typeof m.refused === 'boolean' && NONCE_RE.test(m.nonce),
  'kl.audit.slice': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'entries', 'head', 'anchor', 'created_at'])
    && NODE_ID_RE.test(m.node_id) && Array.isArray(m.entries) && isPlainObject(m.head) && isPlainObject(m.anchor)
    && Number.isInteger(m.head.seq) && nullOr(isString)(m.head.hash) && Number.isInteger(m.anchor.seq) && nullOr(isString)(m.anchor.prev)
    && isTimestamp(m.created_at),
  'kl.audit.slice.head': (m) => hasExactKeys(m, ['v', 'type', 'node_id', 'seq', 'hash', 'at'])
    && NODE_ID_RE.test(m.node_id) && Number.isInteger(m.seq) && nullOr(isString)(m.hash) && isTimestamp(m.at)
};

// F5 (`kl.lease.*`) and C4 (`kl.question.answer`) register their own types.
// An unregistered type gets the fields verifyDeviceEnvelope relies on.
function registerMessageValidator(type, validator) {
  if (VALIDATORS[type]) throw new Error(`message type ${type} already has a validator`);
  VALIDATORS[type] = validator;
}

function genericDeviceMessage(m) {
  return DEVICE_ID_RE.test(m.device_id) && NODE_ID_RE.test(m.node_id) && NONCE_RE.test(m.nonce);
}

function validateMessage(type, message) {
  if (!isPlainObject(message) || message.type !== type || !Number.isInteger(message.v)) return 'malformed';
  if (message.v !== 1) return 'unsupported_version';
  const check = VALIDATORS[type] || genericDeviceMessage;
  let ok = false;
  try {
    ok = check(message) === true;
  } catch {
    ok = false;
  }
  return ok ? null : 'malformed';
}

// Opens an envelope and validates it as `type`: { message, bytes } or a
// MessageError whose reason is malformed / unsupported_version.
function parseMessage(envelope, type) {
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    throw new MessageError('malformed', err instanceof EnvelopeError ? err.message : String(err));
  }
  const reason = validateMessage(type, opened.message);
  if (reason) throw new MessageError(reason, `not a valid ${type}`);
  return opened;
}

const parseResponse = (envelope) => parseMessage(envelope, 'kl.approval.response');
const parseEnroll = (envelope) => parseMessage(envelope, 'kl.device.enroll');
const parseRevoke = (envelope) => parseMessage(envelope, 'kl.device.revoke');

module.exports = {
  MessageError,
  TIMESTAMP_RE,
  NONCE_RE,
  CODE_ID_RE,
  DEVICE_ID_RE,
  NODE_ID_RE,
  MAX_ACTION_BYTES,
  TTL_MIN_MS,
  TTL_MAX_MS,
  PLATFORMS,
  iso,
  randomNonce,
  clampTtl,
  cutSummary,
  toolAction,
  runbookAction,
  envelopeAction,
  actionHash,
  normalizeOrigin,
  buildRequest,
  buildStatus,
  buildEnrollOpen,
  buildEnrollDone,
  enrollMac,
  inviteMac,
  phoneAuthString,
  encodeQr,
  decodeQr,
  validateMessage,
  registerMessageValidator,
  parseMessage,
  parseResponse,
  parseEnroll,
  parseRevoke
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-messages.test.js`
Expected: PASS, `fail 0` (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/messages.js tests/approvals-messages.test.js
git commit -m "feat(approvals): approval-v1 message builders and validators

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Hash-chained audit ledger

**Files:**
- Create: `src/audit/audit-ledger.js`
- Test: `tests/audit-ledger.test.js`

**Interfaces:**
- Consumes: `canonicalize` (Task 1); `seal`, `open`, `verifyEd25519`, `nodeSigner` (Task 3); `validateMessage` (Task 4).
- Produces (program P20, §4.16): `new AuditLedger({ dir, nodeId, identity = null, writer = 'service' | 'mcp' | 'cli', now, retentionDays = 365, lockTimeoutMs = 2000, staleLockMs = 10000, onPathWritten })` with `append({ kind, data }) → Promise<entry>` (rejects `audit_unavailable: …` when the lock cannot be taken), `verify() → { ok, entries, brokenAt?, reason? }`, `tail(n)`, `entriesAfter(hash | null, limit)`, `slice({ before_seq?, after?, limit = 200, max_bytes = 524288 }) → kl.audit.slice envelope`, `head() → kl.audit.slice.head envelope`, `prune(now) → { removedSegments }`; `verifyAuditSlice(envelope, spkiHex) → { ok, reason, message? }`; `entryHash(entryWithoutHash) → hex`.

- [ ] **Step 1: Write the failing test**

Create `tests/audit-ledger.test.js` (the contention test forks three processes that each append 15 entries):

```js
// tests/audit-ledger.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { deriveNodeId } = require('../src/mesh/node-identity');
const { open } = require('../src/approvals/envelope');
const { AuditLedger, verifyAuditSlice } = require('../src/audit/audit-ledger');

const ROOT = path.join(__dirname, '..');
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-audit-'));
  tmp.push(d);
  return d;
}

function testIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { nodeId: deriveNodeId(spki), nodeName: 'web-01', publicKey: spki, sign: (b) => crypto.sign(null, b, privateKey) };
}

function ledger(dir, extra = {}) {
  const identity = extra.identity || testIdentity();
  return new AuditLedger({ dir, identity, nodeId: identity.nodeId, ...extra });
}

async function fill(l, n) {
  for (let i = 0; i < n; i += 1) await l.append({ kind: 'tier.decision', data: { i } });
}

function segmentFile(dir) {
  return path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('ledger-')));
}

describe('AuditLedger chain', () => {
  it('appends seq-numbered, hash-chained entries into a monthly segment', async () => {
    const dir = tempDir();
    const l = ledger(dir, { now: () => Date.parse('2026-09-23T18:04:11.230Z') });
    const first = await l.append({ kind: 'approval.request', data: { job_id: null, envelope: { a: 1 } } });
    const second = await l.append({ kind: 'approval.outcome', data: { request_id: 'r', state: 'expired', reason: null } });
    assert.equal(first.seq, 1);
    assert.equal(first.prev, null);
    assert.equal(second.seq, 2);
    assert.equal(second.prev, first.hash);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(first.writer, 'service');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')), ['ledger-2026-09.jsonl']);
    assert.deepEqual(l.verify(), { ok: true, entries: 2 });
    assert.deepEqual(l.tail(1), [second]);
  });

  it('refuses data that is not JSON', async () => {
    const l = ledger(tempDir());
    await assert.rejects(l.append({ kind: 'x', data: { bad: undefined } }));
  });

  it('verify finds an edited, a deleted and a reordered line', async () => {
    for (const damage of ['edit', 'delete', 'reorder']) {
      const dir = tempDir();
      const l = ledger(dir);
      await fill(l, 5);
      const file = segmentFile(dir);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (damage === 'edit') lines[2] = lines[2].replace('"i":2', '"i":9');
      if (damage === 'delete') lines.splice(2, 1);
      if (damage === 'reorder') [lines[1], lines[2]] = [lines[2], lines[1]];
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      const result = l.verify();
      assert.equal(result.ok, false, damage);
      assert.equal(result.brokenAt, damage === 'reorder' ? 3 : (damage === 'delete' ? 4 : 3), damage);
    }
  });
});

describe('AuditLedger lock', () => {
  it('keeps one chain when several processes append at once', async () => {
    const dir = tempDir();
    const identity = testIdentity();
    const script = `
      const { AuditLedger } = require('./src/audit/audit-ledger');
      const l = new AuditLedger({ dir: process.env.KL_AUDIT_DIR, nodeId: '${identity.nodeId}', writer: 'mcp' });
      (async () => { for (let i = 0; i < 15; i += 1) await l.append({ kind: 'exec.start', data: { pid: process.pid, i } }); })()
        .catch((err) => { process.stderr.write(err.message); process.exit(1); });
    `;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, KL_AUDIT_DIR: dir, KING_LOUIE_LOG_LEVEL: 'silent' } });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([run(), run(), run()]);
    const l = ledger(dir, { identity });
    const result = l.verify();
    assert.deepEqual(result, { ok: true, entries: 45 });
    assert.deepEqual(l.tail(45).map((e) => e.seq), Array.from({ length: 45 }, (_, i) => i + 1));
  });

  it('breaks a lock left by a dead process', async () => {
    const dir = tempDir();
    const l = ledger(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledger.lock'), '999999999');
    const entry = await l.append({ kind: 'x', data: {} });
    assert.equal(entry.seq, 1);
    assert.equal(fs.existsSync(path.join(dir, 'ledger.lock')), false);
  });

  it('breaks a lock older than staleLockMs even when its pid is alive', async () => {
    const dir = tempDir();
    const l = ledger(dir, { staleLockMs: 50 });
    const lock = path.join(dir, 'ledger.lock');
    fs.writeFileSync(lock, String(process.pid));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    assert.equal((await l.append({ kind: 'x', data: {} })).seq, 1);
  });

  it('rejects with audit_unavailable when a live lock never clears', async () => {
    const dir = tempDir();
    const l = ledger(dir, { lockTimeoutMs: 100 });
    fs.writeFileSync(path.join(dir, 'ledger.lock'), String(process.pid));
    await assert.rejects(l.append({ kind: 'x', data: {} }), /audit_unavailable/);
  });
});

describe('AuditLedger reading and signing', () => {
  it('entriesAfter pages forward from a hash, or from the oldest entry', async () => {
    const l = ledger(tempDir());
    await fill(l, 5);
    const all = l.tail(5);
    assert.deepEqual(l.entriesAfter(null, 2).map((e) => e.seq), [1, 2]);
    assert.deepEqual(l.entriesAfter(all[1].hash, 10).map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual(l.entriesAfter('f'.repeat(64), 1).map((e) => e.seq), [1]);
  });

  it('slice pages backwards and forwards, respects max_bytes, and always returns one entry', async () => {
    const identity = testIdentity();
    const l = ledger(tempDir(), { identity });
    await fill(l, 10);
    const spki = identity.publicKey.toString('hex');
    const back = verifyAuditSlice(l.slice({ before_seq: 8, limit: 3 }), spki);
    assert.equal(back.ok, true);
    assert.deepEqual(back.message.entries.map((e) => e.seq), [5, 6, 7]);
    assert.deepEqual(back.message.head.seq, 10);
    assert.deepEqual(back.message.anchor, { seq: 1, prev: null });
    const all = l.tail(10);
    const fwd = open(l.slice({ after: all[6].hash, limit: 200 })).message;
    assert.deepEqual(fwd.entries.map((e) => e.seq), [8, 9, 10]);
    const tiny = open(l.slice({ max_bytes: 1 })).message;
    assert.deepEqual(tiny.entries.map((e) => e.seq), [10]);
    assert.equal(open(l.slice({ limit: 500 })).message.entries.length, 10);
  });

  it('verifyAuditSlice refuses a tampered entry and a foreign key', async () => {
    const identity = testIdentity();
    const l = ledger(tempDir(), { identity });
    await fill(l, 3);
    const env = l.slice({});
    assert.equal(verifyAuditSlice(env, testIdentity().publicKey.toString('hex')).reason, 'bad_signature');
  });

  it('head() is a signed kl.audit.slice.head', async () => {
    const identity = testIdentity();
    const l = ledger(tempDir(), { identity });
    await fill(l, 2);
    const env = l.head();
    const { message } = open(env);
    assert.equal(message.type, 'kl.audit.slice.head');
    assert.equal(message.seq, 2);
    assert.equal(message.hash, l.tail(1)[0].hash);
    assert.equal(env.kid, identity.nodeId);
  });
});

describe('AuditLedger retention', () => {
  it('prunes whole old segments, keeps the newest, and still verifies from the anchor', async () => {
    const dir = tempDir();
    let clock = Date.parse('2025-01-10T00:00:00.000Z');
    const l = ledger(dir, { now: () => clock, retentionDays: 30 });
    await fill(l, 2);
    clock = Date.parse('2025-03-10T00:00:00.000Z');
    await fill(l, 2);
    clock = Date.parse('2025-05-10T00:00:00.000Z');
    await fill(l, 1);
    assert.deepEqual(l.prune(clock), { removedSegments: 2 });
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')), ['ledger-2025-05.jsonl']);
    const result = l.verify();
    assert.deepEqual(result, { ok: true, entries: 1 });
    const anchor = open(l.slice({})).message.anchor;
    assert.equal(anchor.seq, 5);
    assert.match(anchor.prev, /^[0-9a-f]{64}$/);
    assert.equal((await l.append({ kind: 'x', data: {} })).seq, 6);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/audit-ledger.test.js`
Expected: FAIL with `Cannot find module '../src/audit/audit-ledger'`.

- [ ] **Step 3: Implement**

Create `src/audit/audit-ledger.js`:

```js
// Hash-chained, append-only audit ledger (program §4.16). One JSON entry per
// line in monthly segments <dir>/ledger-YYYY-MM.jsonl. `hash` is hex SHA-256
// over the JCS form of the entry without `hash`; `prev` is the previous
// entry's hash. The service, `mcp` and the admin CLI all append, so every
// append holds <dir>/ledger.lock. This is not src/events/event-ledger.js,
// which stays what it is (ruling 7).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../platform/jcs');
const { seal, open, verifyEd25519, nodeSigner } = require('../approvals/envelope');
const { validateMessage } = require('../approvals/messages');

const SEGMENT_RE = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const WRITERS = ['service', 'mcp', 'cli'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLICE = 200;
const DEFAULT_MAX_BYTES = 524288;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function entryHash(entryWithoutHash) {
  return crypto.createHash('sha256').update(canonicalize(entryWithoutHash), 'utf8').digest('hex');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

class AuditLedger {
  constructor({ dir, nodeId, identity = null, writer = 'service', now = () => Date.now(), retentionDays = 365,
    lockTimeoutMs = 2000, staleLockMs = 10000, onPathWritten = null } = {}) {
    if (!dir) throw new TypeError('AuditLedger needs a dir');
    if (!WRITERS.includes(writer)) throw new TypeError(`AuditLedger writer must be one of ${WRITERS.join(', ')}`);
    this.dir = dir;
    this.nodeId = nodeId || (identity && identity.nodeId);
    this.identity = identity;
    this.writer = writer;
    this.now = now;
    this.retentionDays = retentionDays;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.onPathWritten = onPathWritten || (() => {});
    this.lockFile = path.join(dir, 'ledger.lock');
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.onPathWritten(this.dir);
    }
  }

  _segments() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => SEGMENT_RE.test(f)).sort();
  }

  _readSegment(name) {
    const text = fs.readFileSync(path.join(this.dir, name), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '');
  }

  _allLines() {
    const lines = [];
    for (const seg of this._segments()) for (const line of this._readSegment(seg)) lines.push(line);
    return lines;
  }

  _entries() {
    return this._allLines().map((line) => JSON.parse(line));
  }

  _lastEntry() {
    const segs = this._segments();
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const lines = this._readSegment(segs[i]);
      if (lines.length) return JSON.parse(lines[lines.length - 1]);
    }
    return null;
  }

  async _lock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      this._breakStaleLock();
      if (Date.now() >= deadline) throw new Error(`audit_unavailable: could not take ${this.lockFile} within ${this.lockTimeoutMs} ms`);
      await sleep(10 + Math.floor(Math.random() * 15));
    }
  }

  // A lock whose pid is gone, or that is older than staleLockMs, is moved
  // aside with rename (atomic: only one breaker wins) and then deleted.
  _breakStaleLock() {
    let st;
    let pid = null;
    try {
      st = fs.statSync(this.lockFile);
      pid = Number(fs.readFileSync(this.lockFile, 'utf8').trim()) || null;
    } catch {
      return;
    }
    const tooOld = Date.now() - st.mtimeMs > this.staleLockMs;
    const dead = pid !== null && pid !== process.pid && !pidAlive(pid);
    if (!tooOld && !dead) return;
    const aside = `${this.lockFile}.stale-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this.lockFile, aside);
      fs.unlinkSync(aside);
    } catch {
      // Someone else broke it first.
    }
  }

  _unlock() {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // Already gone.
    }
  }

  async append({ kind, data = {} } = {}) {
    if (typeof kind !== 'string' || !kind) throw new TypeError('audit entry needs a kind');
    canonicalize(data);
    this._ensureDir();
    await this._lock();
    try {
      const last = this._lastEntry();
      const at = new Date(this.now()).toISOString();
      const entry = {
        v: 1,
        seq: last ? last.seq + 1 : 1,
        at,
        node_id: this.nodeId,
        writer: this.writer,
        kind,
        data,
        prev: last ? last.hash : null
      };
      entry.hash = entryHash(entry);
      const file = path.join(this.dir, `ledger-${at.slice(0, 7)}.jsonl`);
      const existed = fs.existsSync(file);
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (!existed) this.onPathWritten(file);
      return entry;
    } finally {
      this._unlock();
    }
  }

  // The oldest retained entry's `prev` is trusted as the anchor, so a pruned
  // ledger still verifies; slices carry the anchor so a mirror can tell a
  // prune gap from a fork.
  verify() {
    const lines = this._allLines();
    let previous = null;
    let count = 0;
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return { ok: false, entries: count, brokenAt: previous ? previous.seq + 1 : 1, reason: 'unparseable' };
      }
      const { hash, ...rest } = entry;
      if (previous) {
        if (entry.seq !== previous.seq + 1) return { ok: false, entries: count, brokenAt: entry.seq, reason: 'seq_gap' };
        if (entry.prev !== previous.hash) return { ok: false, entries: count, brokenAt: entry.seq, reason: 'prev_mismatch' };
      }
      if (entryHash(rest) !== hash) return { ok: false, entries: count, brokenAt: entry.seq, reason: 'hash_mismatch' };
      previous = entry;
      count += 1;
    }
    return { ok: true, entries: count };
  }

  tail(n) {
    const entries = this._entries();
    return n > 0 ? entries.slice(-n) : [];
  }

  // Entries after the one with `hash`, oldest first. null, or a hash no
  // longer retained, starts from the oldest retained entry.
  entriesAfter(hash, limit = MAX_SLICE) {
    const entries = this._entries();
    const i = hash === null || hash === undefined ? -1 : entries.findIndex((e) => e.hash === hash);
    return entries.slice(i + 1, i + 1 + Math.max(0, limit));
  }

  _headOf(entries) {
    const last = entries[entries.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: null };
  }

  _signer() {
    if (!this.identity) throw new Error('AuditLedger needs an identity to sign slices');
    return nodeSigner(this.identity);
  }

  // At most `limit` (≤ 200) entries whose JSON fits in max_bytes, but always
  // at least one when any match: before `before_seq` (phone history, newest
  // first when trimming) or after the `after` hash (mirror, oldest first).
  slice({ before_seq, after, limit = MAX_SLICE, max_bytes = DEFAULT_MAX_BYTES } = {}) {
    const all = this._entries();
    const cap = Math.min(MAX_SLICE, Math.max(1, Number.isInteger(limit) ? limit : MAX_SLICE));
    let picked;
    if (after !== undefined) {
      const candidates = this.entriesAfter(after, all.length);
      picked = [];
      let bytes = 0;
      for (const e of candidates) {
        const size = Buffer.byteLength(canonicalize(e));
        if (picked.length >= cap || (picked.length > 0 && bytes + size > max_bytes)) break;
        picked.push(e);
        bytes += size;
      }
    } else {
      const candidates = Number.isInteger(before_seq) ? all.filter((e) => e.seq < before_seq) : all;
      picked = [];
      let bytes = 0;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const size = Buffer.byteLength(canonicalize(candidates[i]));
        if (picked.length >= cap || (picked.length > 0 && bytes + size > max_bytes)) break;
        picked.unshift(candidates[i]);
        bytes += size;
      }
    }
    const oldest = all[0];
    return seal({
      v: 1,
      type: 'kl.audit.slice',
      node_id: this.nodeId,
      entries: picked,
      head: this._headOf(all),
      anchor: oldest ? { seq: oldest.seq, prev: oldest.prev } : { seq: 0, prev: null },
      created_at: new Date(this.now()).toISOString()
    }, this._signer());
  }

  head() {
    const { seq, hash } = this._headOf(this._entries());
    return seal({ v: 1, type: 'kl.audit.slice.head', node_id: this.nodeId, seq, hash, at: new Date(this.now()).toISOString() }, this._signer());
  }

  // Whole segments whose month ended more than retentionDays ago. The newest
  // segment is never removed, so the chain always has a head.
  prune(now = this.now()) {
    const cutoff = now - this.retentionDays * DAY_MS;
    const segs = this._segments();
    let removedSegments = 0;
    for (const seg of segs.slice(0, -1)) {
      const [, y, mo] = SEGMENT_RE.exec(seg);
      const monthEnd = Date.UTC(Number(y), Number(mo), 1);
      if (monthEnd < cutoff) {
        fs.unlinkSync(path.join(this.dir, seg));
        removedSegments += 1;
      }
    }
    return { removedSegments };
  }
}

// Verifies a node-signed kl.audit.slice: signature, shape, and that each
// entry's hash is right and chains to the one before it. Phones and F4's
// mirror do the same.
function verifyAuditSlice(envelope, nodeKeySpkiHex) {
  if (!verifyEd25519(envelope, nodeKeySpkiHex)) return { ok: false, reason: 'bad_signature' };
  let message;
  try {
    ({ message } = open(envelope));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const shape = validateMessage('kl.audit.slice', message);
  if (shape) return { ok: false, reason: shape };
  if (envelope.kid !== message.node_id) return { ok: false, reason: 'malformed' };
  let previous = null;
  for (const entry of message.entries) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'malformed' };
    const { hash, ...rest } = entry;
    if (entryHash(rest) !== hash) return { ok: false, reason: 'hash_mismatch' };
    if (previous && (entry.seq !== previous.seq + 1 || entry.prev !== previous.hash)) return { ok: false, reason: 'broken_chain' };
    previous = entry;
  }
  return { ok: true, reason: null, message };
}

module.exports = { AuditLedger, verifyAuditSlice, entryHash };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/audit-ledger.test.js`
Expected: PASS, `fail 0` (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/audit/audit-ledger.js tests/audit-ledger.test.js
git commit -m "feat(audit): hash-chained, lock-protected audit ledger with signed slices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Test keys and the fake phone

**Files:**
- Create: `tests/vectors/approval-v1/keys.json`, `src/approvals/test-keys.js`, `tests/helpers/fake-phone.js`
- Test: `tests/approvals-fake-phone.test.js`

**Interfaces:**
- Consumes: `seal`, `open`, `deviceIdFromJwk`, `nodeSigner` (Task 3); `enrollMac`, `phoneAuthString`, `randomNonce`, `iso` (Task 4); `deriveNodeId` (`src/mesh/node-identity.js`).
- Produces: `TEST_DEVICE_KEYS`, `TEST_NODE_KEYS`, `isTestDeviceKey(jwk)`, `isTestNodeKey(spkiHex)` (`src/approvals/test-keys.js`, production code; never reads `tests/`). Test helper `createFakePhone({ seed = null /* 'A'|'B'|'C' */, name, platform }) → { deviceId, jwk, name, platform, signer, sign(message), device(), approverRecord({ enrolledBy, enrolledAt, revokedAt, revokedBy, enrollment }), respond(requestEnvelope, decision, { signedAt, overrides }), enroll({ device, codeId, code, now, ttlMs, nonce }), revoke(targetDeviceId, { now, ttlMs, reason, nonce }), signApi(method, pathWithQuery, body, { timestamp }) → headers }`; `testNodeIdentity({ key = null /* 'web-01'|'gpu-box'|'relay' */, nodeName }) → { nodeId, nodeName, publicKey, sign, signer }`; `KEYS`.

The keys in `keys.json` are derived from fixed labels and are published: anyone can sign with them, which is why nodes refuse them unless built with `allowTestKeys: true` (only tests set it).

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-fake-phone.test.js`:

```js
// tests/approvals-fake-phone.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakePhone, testNodeIdentity, KEYS } = require('./helpers/fake-phone');
const { verifyEs256, verifyEd25519, open, deviceIdFromJwk, seal } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { TEST_DEVICE_KEYS, TEST_NODE_KEYS, isTestDeviceKey, isTestNodeKey } = require('../src/approvals/test-keys');

describe('test keys', () => {
  it('test-keys.js lists exactly the public halves of keys.json', () => {
    for (const k of TEST_DEVICE_KEYS) {
      const fixed = KEYS.devices[k.name];
      assert.equal(fixed.jwk.x, k.x);
      assert.equal(fixed.jwk.y, k.y);
      assert.equal(deviceIdFromJwk(fixed.jwk), k.device_id);
      assert.equal(fixed.id, k.device_id);
    }
    assert.deepEqual(Object.values(KEYS.nodes).map((n) => n.spki), [...TEST_NODE_KEYS]);
    assert.equal(isTestDeviceKey(KEYS.devices.B.jwk), true);
    assert.equal(isTestDeviceKey(createFakePhone().jwk), false);
    assert.equal(isTestNodeKey(KEYS.nodes['web-01'].spki), true);
  });

  it('fixed seeds give the keys and ids in keys.json', () => {
    assert.equal(createFakePhone({ seed: 'A' }).deviceId, KEYS.devices.A.id);
    const node = testNodeIdentity({ key: 'web-01' });
    assert.equal(node.nodeId, KEYS.nodes['web-01'].id);
    assert.equal(node.publicKey.toString('hex'), KEYS.nodes['web-01'].spki);
  });
});

describe('createFakePhone', () => {
  it('answers a request with a verifiable, well-formed response', () => {
    const node = testNodeIdentity({ key: 'web-01' });
    const phone = createFakePhone();
    const { envelope } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
    const response = phone.respond(envelope, 'approve');
    assert.equal(verifyEs256(response, phone.jwk), true);
    assert.equal(m.validateMessage('kl.approval.response', open(response).message), null);
    assert.equal(verifyEd25519(envelope, node.publicKey.toString('hex')), true);
  });

  it('enrolls itself at a console with a code_mac, and signs enrollments of others', () => {
    const a = createFakePhone();
    const b = createFakePhone({ name: 'Second phone', platform: 'ios' });
    const code = crypto.randomBytes(32).toString('base64url');
    const codeId = crypto.randomBytes(16).toString('base64url');
    const consoleEnv = a.enroll({ codeId, code });
    const consoleMsg = open(consoleEnv).message;
    assert.equal(m.validateMessage('kl.device.enroll', consoleMsg), null);
    const { code_mac: mac, ...withoutMac } = consoleMsg;
    assert.equal(mac, m.enrollMac(code, withoutMac));
    assert.equal(consoleEnv.kid, a.deviceId);

    const signedEnv = a.enroll({ device: b.device() });
    const signedMsg = open(signedEnv).message;
    assert.equal(m.validateMessage('kl.device.enroll', signedMsg), null);
    assert.equal(signedMsg.enrolled_by, a.deviceId);
    assert.equal(signedMsg.device.device_id, b.deviceId);
    assert.equal(verifyEs256(signedEnv, a.jwk), true);
  });

  it('revokes another device and signs API calls', () => {
    const a = createFakePhone();
    const b = createFakePhone();
    const revoke = open(a.revoke(b.deviceId)).message;
    assert.equal(m.validateMessage('kl.device.revoke', revoke), null);
    const headers = a.signApi('GET', '/v1/approvals?wait=0', '', { timestamp: '2026-09-23T18:05:00.000Z' });
    const s = m.phoneAuthString('GET', '/v1/approvals?wait=0', '2026-09-23T18:05:00.000Z', '');
    const env = { alg: 'ES256', kid: a.deviceId, payload: Buffer.from(s).toString('base64url'), sig: headers['X-KL-Signature'] };
    assert.equal(verifyEs256(env, a.jwk), true);
    assert.equal(headers['X-KL-Device'], a.deviceId);
  });

  it('approverRecord is an approver file for this phone', () => {
    const phone = createFakePhone({ name: 'Pixel 9' });
    const rec = phone.approverRecord();
    assert.equal(rec.device_id, phone.deviceId);
    assert.equal(rec.revoked_at, null);
    assert.equal(seal({ a: 1 }, phone.signer).kid, phone.deviceId);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-fake-phone.test.js`
Expected: FAIL with `Cannot find module './helpers/fake-phone'`.

- [ ] **Step 3: Implement**

Create `tests/vectors/approval-v1/keys.json`:

```json
{
  "note": "Fixed test keys for the approval-v1 vectors. Never use them for anything real: nodes refuse these device keys unless built with allowTestKeys (src/approvals/test-keys.js).",
  "nodes": {
    "web-01": {
      "seed": "00f47b1c993fe0506bf6e606dca8c01afaaafc14cf44ee38c70bf6fb2b166727",
      "spki": "302a300506032b65700321006f1962549a885918d3d8c5745499194f20289bda3e041e433e4fa15e16558423",
      "id": "kl-c2ubd6jjqumalzt5"
    },
    "gpu-box": {
      "seed": "25987fdeb838cd84203da80857dd70a62221c673e4ae8c7cea7b4190a2dd5aca",
      "spki": "302a300506032b65700321004a5a5267be058370e223de879faa852150a2dd0c4113aa634d6259167ec7b950",
      "id": "kl-hnef32472qzibi5r"
    },
    "relay": {
      "seed": "c0f1e6a9d5ccbe58b4601ee2df1ab1a64a0146cdbad9059c90ec520aa8afad23",
      "spki": "302a300506032b65700321007d85a245144905192e752ad2c1051643a6e966d934dcbc6baaaabffe1978a725",
      "id": "kl-nt4ritcfj5kepq3y"
    }
  },
  "devices": {
    "A": {
      "d": "hR06TbNHcAce7B80rS7Y4bgYu214JPpwmK7Or3Dh1Ts",
      "jwk": { "kty": "EC", "crv": "P-256", "x": "krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74", "y": "9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI" },
      "id": "d-3vmwrihhdbnit4oi"
    },
    "B": {
      "d": "4XCV8YsX9pCFNbCUU4rkaZ_GJgURsFxM6W7lbAgYRFQ",
      "jwk": { "kty": "EC", "crv": "P-256", "x": "GnDHGfxMVkv5iRyStQIsJbqWKUtPy6ijuA1UiWKlYDc", "y": "LLhIvQ_y0DmIXI_qxojWRICKfjPE_orjZBTwRhje91k" },
      "id": "d-6xdlbxglhnvfa3lw"
    },
    "C": {
      "d": "qOUXdbyjhl0jf43zlVAs6BXELTf23qVZsCf4uHUxoIk",
      "jwk": { "kty": "EC", "crv": "P-256", "x": "RscTaDzgRlaVqN4IrrtRgbBZw8hrp00xiIu7B_1AJ6w", "y": "gBam0DF3krccxYdWnKr6fRP4yHKNLKfByP76l8dEw78" },
      "id": "d-futyo75nn4w4reil"
    }
  }
}
```

Create `src/approvals/test-keys.js`:

```js
// The public halves of the fixed keys in tests/vectors/approval-v1/keys.json.
// Production code never reads tests/, so they are listed here: a node refuses
// an approver whose key is one of these (`test_key`) unless it was built with
// allowTestKeys: true, which only tests set. Anyone can sign with these keys;
// their private halves are published in the repository.
const TEST_DEVICE_KEYS = Object.freeze([
  { name: 'A', device_id: 'd-3vmwrihhdbnit4oi', x: 'krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74', y: '9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI' },
  { name: 'B', device_id: 'd-6xdlbxglhnvfa3lw', x: 'GnDHGfxMVkv5iRyStQIsJbqWKUtPy6ijuA1UiWKlYDc', y: 'LLhIvQ_y0DmIXI_qxojWRICKfjPE_orjZBTwRhje91k' },
  { name: 'C', device_id: 'd-futyo75nn4w4reil', x: 'RscTaDzgRlaVqN4IrrtRgbBZw8hrp00xiIu7B_1AJ6w', y: 'gBam0DF3krccxYdWnKr6fRP4yHKNLKfByP76l8dEw78' }
]);

const TEST_NODE_KEYS = Object.freeze([
  '302a300506032b65700321006f1962549a885918d3d8c5745499194f20289bda3e041e433e4fa15e16558423',
  '302a300506032b65700321004a5a5267be058370e223de879faa852150a2dd0c4113aa634d6259167ec7b950',
  '302a300506032b65700321007d85a245144905192e752ad2c1051643a6e966d934dcbc6baaaabffe1978a725'
]);

function isTestDeviceKey(jwk) {
  return Boolean(jwk) && TEST_DEVICE_KEYS.some((k) => k.x === jwk.x && k.y === jwk.y);
}

function isTestNodeKey(spkiHex) {
  return TEST_NODE_KEYS.includes(String(spkiHex).toLowerCase());
}

module.exports = { TEST_DEVICE_KEYS, TEST_NODE_KEYS, isTestDeviceKey, isTestNodeKey };
```

Create `tests/helpers/fake-phone.js`:

```js
// tests/helpers/fake-phone.js
//
// A phone in software: a P-256 key that signs approval-v1 messages the way
// the mobile apps do (ES256, IEEE P1363 r||s), plus a lightweight node
// identity for tests that must not spawn openssl to make a TLS certificate.
// Keys come from tests/vectors/approval-v1/keys.json when `seed` is 'A', 'B'
// or 'C' (these are test keys nodes refuse without allowTestKeys), else they
// are random.
const crypto = require('crypto');
const path = require('path');
const { seal, open, deviceIdFromJwk, nodeSigner } = require('../../src/approvals/envelope');
const { deriveNodeId } = require('../../src/mesh/node-identity');
const { enrollMac, phoneAuthString, randomNonce, iso } = require('../../src/approvals/messages');

const KEYS = require(path.join(__dirname, '..', 'vectors', 'approval-v1', 'keys.json'));
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function p256FromD(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return { jwk, privateKey: crypto.createPrivateKey({ key: { ...jwk, d }, format: 'jwk' }) };
}

function createFakePhone({ seed = null, name = 'Test phone', platform = 'android' } = {}) {
  let jwk;
  let privateKey;
  if (seed) {
    const fixed = KEYS.devices[seed];
    if (!fixed) throw new Error(`no test device key ${seed}`);
    ({ jwk, privateKey } = p256FromD(fixed.d));
  } else {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
    jwk = { kty, crv, x, y };
    privateKey = pair.privateKey;
  }
  const deviceId = deviceIdFromJwk(jwk);
  const signer = { alg: 'ES256', kid: deviceId, sign: (bytes) => crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };

  const phone = {
    deviceId,
    jwk,
    name,
    platform,
    signer,
    sign: (message) => seal(message, signer),

    device() {
      return { device_id: deviceId, name, platform, public_key: jwk };
    },

    approverRecord({ enrolledBy = 'console', enrolledAt = '2026-09-23T18:00:00.000Z', revokedAt = null, revokedBy = null, enrollment = null } = {}) {
      return {
        v: 1, device_id: deviceId, name, platform, public_key: jwk,
        enrolled_at: enrolledAt, enrolled_by: enrolledBy, revoked_at: revokedAt, revoked_by: revokedBy, enrollment
      };
    },

    // Answers a node-signed kl.approval.request exactly as the app does.
    respond(requestEnvelope, decision, { signedAt = new Date().toISOString(), overrides = {} } = {}) {
      const { message: req } = open(requestEnvelope);
      return seal({
        v: 1,
        type: 'kl.approval.response',
        request_id: req.request_id,
        node_id: req.node_id,
        action_hash: req.action_hash,
        nonce: req.nonce,
        decision,
        expires_at: req.expires_at,
        device_id: deviceId,
        signed_at: signedAt,
        ...overrides
      }, signer);
    },

    // Console enrollment (codeId + code: self-signed with code_mac) or a
    // signed enrollment of `device` by this phone.
    enroll({ device = null, codeId = null, code = null, now = Date.now(), ttlMs = 10 * 60 * 1000, nonce = null } = {}) {
      const base = {
        v: 1,
        type: 'kl.device.enroll',
        device: device || phone.device(),
        enrolled_by: codeId ? null : deviceId,
        created_at: iso(now),
        expires_at: iso(now + ttlMs),
        nonce: nonce || randomNonce()
      };
      if (!codeId) return seal(base, signer);
      const withCode = { ...base, code_id: codeId };
      return seal({ ...withCode, code_mac: enrollMac(code, withCode) }, signer);
    },

    revoke(targetDeviceId, { now = Date.now(), ttlMs = 60 * 60 * 1000, reason = 'lost', nonce = null } = {}) {
      return seal({
        v: 1,
        type: 'kl.device.revoke',
        device_id: targetDeviceId,
        revoked_by: deviceId,
        reason,
        created_at: iso(now),
        expires_at: iso(now + ttlMs),
        nonce: nonce || randomNonce()
      }, signer);
    },

    // Headers for a device-authenticated phone API call.
    signApi(method, pathWithQuery, body = '', { timestamp = new Date().toISOString() } = {}) {
      const s = phoneAuthString(method, pathWithQuery, timestamp, body);
      return {
        'X-KL-Device': deviceId,
        'X-KL-Timestamp': timestamp,
        'X-KL-Signature': signer.sign(Buffer.from(s, 'utf8')).toString('base64url')
      };
    }
  };
  return phone;
}

// A node identity without a TLS certificate: { nodeId, nodeName, publicKey
// (DER SPKI Buffer), sign(bytes) }. `key` names a node in keys.json.
function testNodeIdentity({ key = null, nodeName = null } = {}) {
  let privateKey;
  if (key) {
    const fixed = KEYS.nodes[key];
    if (!fixed) throw new Error(`no test node key ${key}`);
    privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(fixed.seed, 'hex')]), format: 'der', type: 'pkcs8' });
  } else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const identity = {
    nodeId: deriveNodeId(publicKey),
    nodeName: nodeName || key || 'web-01',
    publicKey,
    sign: (bytes) => crypto.sign(null, Buffer.from(bytes), privateKey)
  };
  identity.signer = nodeSigner(identity);
  return identity;
}

module.exports = { createFakePhone, testNodeIdentity, KEYS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-fake-phone.test.js`
Expected: PASS, `fail 0` (6 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/vectors/approval-v1/keys.json src/approvals/test-keys.js tests/helpers/fake-phone.js tests/approvals-fake-phone.test.js
git commit -m "test(approvals): fixed test keys, refused in production, and a software phone

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Read-only approver store and the admin writer

**Files:**
- Create: `src/approvals/approver-store.js`, `src/approvals/approver-admin.js`, `tests/helpers/approver-set.js`
- Test: `tests/approvals-approver-store.test.js`

**Interfaces:**
- Consumes: `assertAdminOwned(file, geteuid, adminUid, controls)` (`src/service/config.js`, a no-op on win32); `open`, `verifyEs256`, `isDeviceJwk`, `deviceIdFromJwk` (Task 3); `validateMessage`, `NONCE_RE`, `DEVICE_ID_RE`, `TIMESTAMP_RE`, `PLATFORMS`, `iso` (Task 4); `isTestDeviceKey` (Task 6).
- Produces (program P4): `new ApproverStore({ dir, stagedDir, geteuid, adminUid = 0, platform, now, allowTestKeys = false, fsImpl })` with `ready() → Promise<{ ok, problem? }>`, `list()`, `get(deviceId)`, `isActive(deviceId, { overlay = true })`, `isAdminApplied(deviceId)`, `activeCount()`, `stage(envelope) → { state: 'staged' | 'revoked-pending-apply' | 'duplicate' | 'rejected', reason? }`, `refresh()`, `isTestKey(id)`, `addToOverlay(id)`, properties `overlay`, `allowTestKeys`, `problem`. `checkApproverDir({ dir, platform, geteuid, adminUid, fsImpl }) → problem | null`, `checkApproverRecord(record, fileName)`, `writeFileAtomic(file, text, mode)`, `APPROVER_CONTROLS`. `new ApproverAdmin({ dir, stagedDir, now, allowTestKeys, geteuid, adminUid, platform })` with `assertWritable()`, `read(id)`, `writeApprover(record)`, `markRevoked(deviceId, by)`, `listStaged()`, `applyStaged({ now, confirm }) → [{ file, type, deviceId, signer, result }]`; `class ApproverAdminError` (message `Run this as root/Administrator: <dir> is not writable.`). Test helper `approverStoreWith(records, { overlay, allowTestKeys, now }) → ready ApproverStore` with `cleanup()` and `baseDir`.

`stage()` rejection reasons: `malformed`, `unsupported_version`, `expired`, `console_enrollment_is_not_relayed`, `signer_not_active`, `bad_signature`, `revoked_device`, `self_revoke`, `no_staging_dir`. `applyStaged` results: `enrolled`, `revoked`, `rejected: <why>`.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/approver-set.js`:

```js
// tests/helpers/approver-set.js
//
// A real ApproverStore over a temp approvers dir holding `records`. The test
// process owns the files, so it plays the administrator (platform 'linux'
// selects the POSIX checks; on Windows assertAdminOwned is a no-op).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApproverStore } = require('../../src/approvals/approver-store');

async function approverStoreWith(records = [], { overlay = [], allowTestKeys = false, now = Date.now } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-approver-set-'));
  const config = path.join(base, 'config');
  const dir = path.join(config, 'approvers');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') {
    fs.chmodSync(base, 0o755);
    fs.chmodSync(config, 0o755);
  }
  for (const record of records) {
    fs.writeFileSync(path.join(dir, `${record.device_id}.json`), JSON.stringify(record), { mode: 0o644 });
  }
  const uid = process.platform !== 'win32' ? process.getuid() : 0;
  const store = new ApproverStore({
    dir,
    stagedDir: path.join(base, 'data', 'approvals', 'staged'),
    geteuid: () => uid,
    adminUid: uid,
    platform: 'linux',
    allowTestKeys,
    now
  });
  await store.ready();
  for (const id of overlay) store.addToOverlay(id);
  store.baseDir = base;
  store.cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  return store;
}

module.exports = { approverStoreWith };
```

Create `tests/approvals-approver-store.test.js`:

```js
// tests/approvals-approver-store.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApproverStore } = require('../src/approvals/approver-store');
const { ApproverAdmin, ApproverAdminError } = require('../src/approvals/approver-admin');
const { seal } = require('../src/approvals/envelope');
const { createFakePhone } = require('./helpers/fake-phone');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const POSIX = process.platform !== 'win32';
const OWN_UID = POSIX ? process.getuid() : 0;
const NOW = Date.parse('2026-09-23T18:00:00.000Z');

function layout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-approvers-'));
  tmp.push(base);
  const config = path.join(base, 'config');
  const dir = path.join(config, 'approvers');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (POSIX) {
    fs.chmodSync(base, 0o755);
    fs.chmodSync(config, 0o755);
  }
  return { dir, stagedDir: path.join(base, 'data', 'approvals', 'staged') };
}

function write(dir, record, name = `${record.device_id}.json`) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(record), { mode: 0o644 });
}

// The test process owns everything it creates, so it plays the administrator.
// platform 'linux' selects the POSIX checks; on a Windows test machine
// assertAdminOwned is a no-op, and the Windows probe has its own test below.
function store(l, extra = {}) {
  return new ApproverStore({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, ...extra });
}

function admin(l, extra = {}) {
  return new ApproverAdmin({ ...l, geteuid: () => OWN_UID, adminUid: OWN_UID, platform: 'linux', now: () => NOW, ...extra });
}

describe('ApproverStore reading', () => {
  it('lists well-formed records and ignores misnamed, malformed, underived and test-key files', async () => {
    const l = layout();
    const good = createFakePhone({ name: 'Pixel 9' });
    const other = createFakePhone();
    write(l.dir, good.approverRecord());
    write(l.dir, other.approverRecord(), 'd-aaaaaaaaaaaaaaaa.json');
    fs.writeFileSync(path.join(l.dir, 'd-bbbbbbbbbbbbbbbb.json'), '{not json');
    write(l.dir, { ...createFakePhone().approverRecord(), device_id: createFakePhone().deviceId });
    write(l.dir, { ...createFakePhone().approverRecord(), public_key: { ...other.jwk, d: 'secret' } });
    write(l.dir, createFakePhone({ seed: 'A' }).approverRecord());
    const s = store(l);
    assert.deepEqual(await s.ready(), { ok: true });
    assert.deepEqual(s.list().map((r) => r.device_id), [good.deviceId]);
    assert.equal(s.activeCount(), 1);
    assert.equal(s.get(good.deviceId).public_key.x, good.jwk.x);
    // A test key is still found (so verification can say test_key) but never active.
    const a = createFakePhone({ seed: 'A' });
    assert.equal(s.get(a.deviceId).device_id, a.deviceId);
    assert.equal(s.isActive(a.deviceId), false);
    assert.equal(store(l, { allowTestKeys: true }).isActive(a.deviceId), true);
  });

  it('never counts demo or revoked devices as active', async () => {
    const l = layout();
    const demo = createFakePhone({ platform: 'demo' });
    const revoked = createFakePhone();
    write(l.dir, demo.approverRecord());
    write(l.dir, revoked.approverRecord({ revokedAt: '2026-09-23T17:00:00.000Z', revokedBy: 'console' }));
    const s = store(l);
    await s.ready();
    assert.equal(s.isActive(demo.deviceId), false);
    assert.equal(s.isActive(revoked.deviceId), false);
    assert.equal(s.activeCount(), 0);
  });

  it('re-reads a file that changes (after the one-second cache)', async () => {
    const l = layout();
    const phone = createFakePhone();
    const s = store(l);
    await s.ready();
    assert.equal(s.activeCount(), 0);
    write(l.dir, phone.approverRecord());
    s.refresh();
    assert.equal(s.activeCount(), 1);
  });

  it('POSIX: refuses a group-writable approver dir and a file the service account owns', { skip: !POSIX && 'ownership checks are POSIX-only' }, async () => {
    const l = layout();
    write(l.dir, createFakePhone().approverRecord());
    fs.chmodSync(l.dir, 0o775);
    const s = store(l);
    const result = await s.ready();
    assert.equal(result.ok, false);
    assert.match(result.problem, /group- or world-writable/);
    assert.equal(s.activeCount(), 0);
    fs.chmodSync(l.dir, 0o755);
    const strict = store(l, { adminUid: OWN_UID + 1 });
    assert.equal((await strict.ready()).ok, false);
    assert.equal(strict.activeCount(), 0);
  });

  it('Windows: a dir the service can write empties the set', async () => {
    const l = layout();
    write(l.dir, createFakePhone().approverRecord());
    const writable = store(l, { platform: 'win32', fsImpl: { ...fs, openSync: () => 42, closeSync: () => {}, unlinkSync: () => {} } });
    const result = await writable.ready();
    assert.equal(result.ok, false);
    assert.match(result.problem, /writable by the account running the service/);
    assert.equal(writable.activeCount(), 0);
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const locked = store(l, { platform: 'win32', fsImpl: { ...fs, openSync: () => { throw denied; } } });
    assert.deepEqual(await locked.ready(), { ok: true });
    assert.equal(locked.activeCount(), 1);
  });
});

describe('ApproverStore.stage', () => {
  async function fleet() {
    const l = layout();
    const a = createFakePhone({ name: 'Owner phone' });
    const b = createFakePhone({ name: 'Second phone' });
    write(l.dir, a.approverRecord());
    write(l.dir, b.approverRecord());
    const s = store(l);
    await s.ready();
    return { l, a, b, s };
  }

  it('stages a signed enrollment by an active device, once', async () => {
    const { s, a, l } = await fleet();
    const c = createFakePhone();
    const env = a.enroll({ device: c.device(), now: NOW });
    assert.deepEqual(s.stage(env), { state: 'staged' });
    assert.deepEqual(s.stage(env), { state: 'duplicate' });
    assert.equal(fs.readdirSync(l.stagedDir).length, 1);
    assert.equal(s.isActive(c.deviceId), false, 'staged is not trusted until an admin applies it');
  });

  it('rejects an expired, unsigned-by-an-approver or badly signed enrollment', async () => {
    const { s, a } = await fleet();
    const c = createFakePhone();
    assert.deepEqual(s.stage(a.enroll({ device: c.device(), now: NOW - 11 * 60 * 1000 })), { state: 'rejected', reason: 'expired' });
    assert.deepEqual(s.stage(createFakePhone().enroll({ device: c.device(), now: NOW })), { state: 'rejected', reason: 'signer_not_active' });
    const forged = { ...a.enroll({ device: c.device(), now: NOW }), sig: a.enroll({ device: createFakePhone().device(), now: NOW }).sig };
    assert.deepEqual(s.stage(forged), { state: 'rejected', reason: 'bad_signature' });
  });

  it('validates the nonce before using it as a file name', async () => {
    const { s, a } = await fleet();
    const env = seal({ v: 1, type: 'kl.device.revoke', device_id: createFakePhone().deviceId, revoked_by: a.deviceId, reason: 'x',
      created_at: '2026-09-23T18:00:00.000Z', expires_at: '2026-09-23T19:00:00.000Z', nonce: '../../../evil' }, a.signer);
    assert.deepEqual(s.stage(env), { state: 'rejected', reason: 'malformed' });
  });

  it('a revoke acts at once through the overlay and survives a restart', async () => {
    const { s, a, b, l } = await fleet();
    assert.deepEqual(s.stage(a.revoke(b.deviceId, { now: NOW })), { state: 'revoked-pending-apply' });
    assert.equal(s.isActive(b.deviceId), false);
    assert.equal(s.isAdminApplied(b.deviceId), true);
    const restarted = store(l);
    await restarted.ready();
    assert.equal(restarted.isActive(b.deviceId), false);
  });

  it('refuses a self-revoke, and lets mutual revokes remove both keys', async () => {
    const { s, a, b } = await fleet();
    assert.deepEqual(s.stage(a.revoke(a.deviceId, { now: NOW })), { state: 'rejected', reason: 'self_revoke' });
    assert.equal(s.stage(b.revoke(a.deviceId, { now: NOW })).state, 'revoked-pending-apply');
    // a is in the overlay, but revokers are judged on the admin-applied set.
    assert.equal(s.stage(a.revoke(b.deviceId, { now: NOW })).state, 'revoked-pending-apply');
    assert.equal(s.isActive(a.deviceId), false);
    assert.equal(s.isActive(b.deviceId), false);
  });

  it('an enrollment signed by an overlay-revoked device is refused', async () => {
    const { s, a, b } = await fleet();
    s.stage(b.revoke(a.deviceId, { now: NOW }));
    assert.deepEqual(s.stage(a.enroll({ device: createFakePhone().device(), now: NOW })), { state: 'rejected', reason: 'signer_not_active' });
  });
});

describe('ApproverAdmin', () => {
  it('refuses to write where it cannot', () => {
    const l = layout();
    const file = path.join(l.dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const blocked = new ApproverAdmin({ dir: path.join(file, 'approvers'), stagedDir: l.stagedDir });
    assert.throws(() => blocked.assertWritable(), (err) => err instanceof ApproverAdminError && /Run this as root\/Administrator: .* is not writable\./.test(err.message));
  });

  it('writes and revokes, and never re-activates a revoked device', () => {
    const l = layout();
    const phone = createFakePhone();
    const ad = admin(l);
    ad.writeApprover(phone.approverRecord());
    const revoked = ad.markRevoked(phone.deviceId, 'console');
    assert.equal(revoked.revoked_by, 'console');
    assert.equal(revoked.revoked_at, '2026-09-23T18:00:00.000Z');
    assert.throws(() => ad.writeApprover(phone.approverRecord()), /never re-activated/);
    assert.throws(() => ad.writeApprover({ ...createFakePhone().approverRecord(), device_id: phone.deviceId }), /does not derive/);
  });

  it('applyStaged lists, asks, applies revokes first, and moves everything to done/', async () => {
    const l = layout();
    const a = createFakePhone({ name: 'A' });
    const b = createFakePhone({ name: 'B' });
    const c = createFakePhone({ name: 'C' });
    write(l.dir, a.approverRecord());
    write(l.dir, b.approverRecord());
    const s = store(l);
    await s.ready();
    s.stage(b.enroll({ device: c.device(), now: NOW }));
    s.stage(a.revoke(b.deviceId, { now: NOW }));
    const ad = admin(l);

    let shown = null;
    assert.deepEqual(await ad.applyStaged({ confirm: async (items) => { shown = items; return false; } }), []);
    assert.deepEqual(shown.map((i) => i.type).sort(), ['kl.device.enroll', 'kl.device.revoke']);
    assert.equal(fs.readdirSync(l.stagedDir).filter((n) => n.endsWith('.json')).length, 2, 'declining changes nothing');

    const results = await ad.applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => [r.type, r.result]), [
      ['kl.device.revoke', 'revoked'],
      ['kl.device.enroll', 'rejected: signer is not an active approver']
    ]);
    assert.equal(ad.read(b.deviceId).revoked_by, a.deviceId);
    assert.equal(ad.read(c.deviceId), null);
    assert.equal(fs.readdirSync(path.join(l.stagedDir, 'done')).length, 2);
    // The nonce is remembered in done/, so a replayed envelope is a duplicate.
    const again = store(l);
    await again.ready();
    assert.equal(again.stage(a.revoke(b.deviceId, { now: NOW, nonce: shown.find((i) => i.type === 'kl.device.revoke').message.nonce })).state, 'duplicate');
  });

  it('applyStaged enrolls a device signed by an active approver and refuses items older than 7 days', async () => {
    const l = layout();
    const a = createFakePhone();
    const c = createFakePhone({ name: 'New phone', platform: 'ios' });
    write(l.dir, a.approverRecord());
    const s = store(l);
    await s.ready();
    s.stage(a.enroll({ device: c.device(), now: NOW }));
    const late = admin(l, { now: () => NOW + 8 * 24 * 60 * 60 * 1000 });
    assert.deepEqual((await late.applyStaged({ confirm: async () => true })).map((r) => r.result), ['rejected: older than 7 days']);

    const l2 = layout();
    write(l2.dir, a.approverRecord());
    const s2 = store(l2);
    await s2.ready();
    s2.stage(a.enroll({ device: c.device(), now: NOW }));
    const results = await admin(l2).applyStaged({ confirm: async () => true });
    assert.deepEqual(results.map((r) => r.result), ['enrolled']);
    const record = admin(l2).read(c.deviceId);
    assert.equal(record.enrolled_by, a.deviceId);
    assert.equal(record.platform, 'ios');
    const fresh = store(l2);
    await fresh.ready();
    assert.equal(fresh.isActive(c.deviceId), true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-approver-store.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/approver-store'`.

- [ ] **Step 3: Implement**

Create `src/approvals/approver-store.js`:

```js
// The set of phones allowed to approve unsafe actions on this node.
//
// The service only READS it: whoever can add a key approves anything, so the
// files live in the admin-owned <configDir>/approvers/ and only the admin CLI
// (approver-admin.js) writes them. A relayed enrollment or revocation is
// staged in the service-writable data dir and applied by an admin
// (`device apply`, R15); a verified revocation takes effect at once through
// an in-memory overlay that can only remove trust.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { assertAdminOwned } = require('../service/config');
const { open, verifyEs256, isDeviceJwk, deviceIdFromJwk } = require('./envelope');
const { validateMessage, NONCE_RE, DEVICE_ID_RE, TIMESTAMP_RE, PLATFORMS } = require('./messages');
const { isTestDeviceKey } = require('./test-keys');

const log = createLogger('approvals/approver-store');

const APPROVER_CONTROLS = {
  decides: 'which phones may approve unsafe actions on this node',
  selfGrant: 'add its own approver'
};
const CACHE_MS = 1000;
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

const nullOrTimestamp = (v) => v === null || (typeof v === 'string' && TIMESTAMP_RE.test(v));
const byWhom = (v) => v === 'console' || (typeof v === 'string' && DEVICE_ID_RE.test(v));

// null when `record` is a well-formed approver file named `fileName`, else why not.
function checkApproverRecord(record, fileName = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (record.v !== 1) return 'v must be 1';
  if (typeof record.device_id !== 'string' || !DEVICE_ID_RE.test(record.device_id)) return 'bad device_id';
  if (fileName !== null && fileName !== `${record.device_id}.json`) return 'file name does not match device_id';
  if (!isDeviceJwk(record.public_key)) return 'public_key must be a P-256 JWK with exactly kty, crv, x, y';
  if (deviceIdFromJwk(record.public_key) !== record.device_id) return 'device_id does not derive from public_key';
  if (typeof record.name !== 'string' || !record.name) return 'bad name';
  if (!PLATFORMS.includes(record.platform)) return 'bad platform';
  if (!(typeof record.enrolled_at === 'string' && TIMESTAMP_RE.test(record.enrolled_at))) return 'bad enrolled_at';
  if (!byWhom(record.enrolled_by)) return 'bad enrolled_by';
  if (!nullOrTimestamp(record.revoked_at)) return 'bad revoked_at';
  if (!(record.revoked_by === null || byWhom(record.revoked_by))) return 'bad revoked_by';
  if (!(record.enrollment === null || (typeof record.enrollment === 'object' && !Array.isArray(record.enrollment)))) return 'bad enrollment';
  return null;
}

// null when the approver dir may be trusted, else the problem. A missing dir
// is an empty set, not a problem. Sync so `doctor` can use it too.
function checkApproverDir({ dir, platform = process.platform, geteuid = defaultGeteuid, adminUid = 0, fsImpl = fs }) {
  if (!fsImpl.existsSync(dir)) return null;
  if (platform === 'win32') {
    const probe = path.join(dir, `.probe-${crypto.randomBytes(6).toString('hex')}`);
    let fd = null;
    try {
      fd = fsImpl.openSync(probe, 'wx');
    } catch {
      fd = null;
    }
    if (fd === null) return null;
    try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    try { fsImpl.unlinkSync(probe); } catch { /* ignore */ }
    return `${dir} is writable by the account running the service; no approver is trusted until an administrator fixes its ACL`;
  }
  try {
    assertAdminOwned(dir, geteuid, adminUid, APPROVER_CONTROLS);
    return null;
  } catch (err) {
    return err.message;
  }
}

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

class ApproverStore {
  constructor({ dir, stagedDir, geteuid = defaultGeteuid, adminUid = 0, platform = process.platform, now = Date.now,
    allowTestKeys = false, fsImpl = fs } = {}) {
    if (!dir) throw new TypeError('ApproverStore needs a dir');
    this.dir = dir;
    this.stagedDir = stagedDir || null;
    this.geteuid = geteuid;
    this.adminUid = adminUid;
    this.platform = platform;
    this.now = now;
    this.allowTestKeys = allowTestKeys === true;
    this.fs = fsImpl;
    this.problem = null;
    this.untrusted = false;
    this.overlay = new Set();
    this._files = new Map();
    this._scannedAt = -Infinity;
    this._logged = new Set();
  }

  // Startup probe. POSIX: the dir must be admin-owned and not writable by
  // anyone else. Windows (assertAdminOwned is a no-op there, R51): if this
  // process can create a file in the dir, the ACL is wrong, and the set is
  // treated as empty until an administrator fixes it.
  async ready() {
    this.problem = checkApproverDir({ dir: this.dir, platform: this.platform, geteuid: this.geteuid, adminUid: this.adminUid, fsImpl: this.fs });
    this.untrusted = this.problem !== null;
    if (this.problem) log.error(`approver set treated as empty: ${this.problem}`);
    this._scannedAt = -Infinity;
    this._rebuildOverlay();
    return this.problem ? { ok: false, problem: this.problem } : { ok: true };
  }

  _logOnce(key, message) {
    if (this._logged.has(key)) return;
    this._logged.add(key);
    log.error(message);
  }

  // Re-stats the dir at most once a second and re-reads files that changed.
  _scan() {
    const nowMs = Date.now();
    if (nowMs - this._scannedAt < CACHE_MS) return;
    this._scannedAt = nowMs;
    if (this.untrusted || !this.fs.existsSync(this.dir)) {
      this._files.clear();
      return;
    }
    const names = this.fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    const seen = new Set(names);
    for (const name of [...this._files.keys()]) if (!seen.has(name)) this._files.delete(name);
    for (const name of names) {
      const file = path.join(this.dir, name);
      let st;
      try {
        st = this.fs.statSync(file);
      } catch {
        continue;
      }
      const cached = this._files.get(name);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      let record = null;
      try {
        if (this.platform !== 'win32') assertAdminOwned(file, this.geteuid, this.adminUid, APPROVER_CONTROLS);
        const parsed = JSON.parse(this.fs.readFileSync(file, 'utf8'));
        const fault = checkApproverRecord(parsed, name);
        if (fault) throw new Error(fault);
        record = parsed;
      } catch (err) {
        this._logOnce(`${name}:${st.mtimeMs}`, `ignoring approver file ${file}: ${err.message}`);
      }
      this._files.set(name, { mtimeMs: st.mtimeMs, size: st.size, record });
    }
  }

  // Forget the one-second cache, so the next read sees files written just now.
  refresh() {
    this._scannedAt = -Infinity;
  }

  isTestKey(deviceId) {
    const record = this.get(deviceId);
    return Boolean(record) && isTestDeviceKey(record.public_key);
  }

  // Well-formed approver records, test keys left out unless allowTestKeys.
  list() {
    this._scan();
    const out = [];
    for (const [name, entry] of this._files) {
      if (!entry.record) continue;
      if (!this.allowTestKeys && isTestDeviceKey(entry.record.public_key)) {
        this._logOnce(`test:${name}`, `ignoring approver file ${name}: its key is a published test key`);
        continue;
      }
      out.push(entry.record);
    }
    return out;
  }

  // Any well-formed record, test key or demo included, so verification can
  // say why it refuses (demo_device, test_key) instead of unknown_device.
  get(deviceId) {
    this._scan();
    const entry = this._files.get(`${deviceId}.json`);
    return entry && entry.record ? entry.record : null;
  }

  isActive(deviceId, { overlay = true } = {}) {
    const record = this.get(deviceId);
    if (!record || record.platform === 'demo' || record.revoked_at !== null) return false;
    if (!this.allowTestKeys && isTestDeviceKey(record.public_key)) return false;
    return !(overlay && this.overlay.has(deviceId));
  }

  isAdminApplied(deviceId) {
    return this.isActive(deviceId, { overlay: false });
  }

  activeCount() {
    return this.list().filter((r) => this.isActive(r.device_id)).length;
  }

  addToOverlay(deviceId) {
    this.overlay.add(deviceId);
  }

  _stagedFile(nonce) {
    return path.join(this.stagedDir, `${nonce}.json`);
  }

  _isKnownNonce(nonce) {
    return this.fs.existsSync(this._stagedFile(nonce)) || this.fs.existsSync(path.join(this.stagedDir, 'done', `${nonce}.json`));
  }

  // Checks a relayed revoke against the admin-applied set (the overlay is
  // ignored, so a thief's revoke of the owner cannot stop the owner's
  // counter-revoke). Returns null or the reason.
  _checkRevoke(envelope, message) {
    if (envelope.alg !== 'ES256' || envelope.kid !== message.revoked_by) return 'malformed';
    if (message.revoked_by === message.device_id) return 'self_revoke';
    if (!this.isAdminApplied(message.revoked_by)) return 'signer_not_active';
    if (!verifyEs256(envelope, this.get(message.revoked_by).public_key)) return 'bad_signature';
    return null;
  }

  _rebuildOverlay() {
    this.overlay.clear();
    if (!this.stagedDir || !this.fs.existsSync(this.stagedDir)) return;
    for (const name of this.fs.readdirSync(this.stagedDir).filter((n) => n.endsWith('.json'))) {
      try {
        const { envelope } = JSON.parse(this.fs.readFileSync(path.join(this.stagedDir, name), 'utf8'));
        const { message } = open(envelope);
        if (message.type !== 'kl.device.revoke' || validateMessage('kl.device.revoke', message)) continue;
        if (this._checkRevoke(envelope, message) === null) this.overlay.add(message.device_id);
      } catch (err) {
        log.warn(`ignoring staged file ${name}: ${err.message}`);
      }
    }
  }

  stage(envelope) {
    const rejected = (reason) => ({ state: 'rejected', reason });
    if (!this.stagedDir) return rejected('no_staging_dir');
    let message;
    try {
      ({ message } = open(envelope));
    } catch {
      return rejected('malformed');
    }
    const type = message.type;
    if (type !== 'kl.device.enroll' && type !== 'kl.device.revoke') return rejected('malformed');
    // Validated before it is used as a file name.
    if (typeof message.nonce !== 'string' || !NONCE_RE.test(message.nonce)) return rejected('malformed');
    if (this._isKnownNonce(message.nonce)) return { state: 'duplicate' };
    const shape = validateMessage(type, message);
    if (shape) return rejected(shape);
    if (this.now() > Date.parse(message.expires_at)) return rejected('expired');

    if (type === 'kl.device.enroll') {
      if (message.enrolled_by === null) return rejected('console_enrollment_is_not_relayed');
      if (envelope.alg !== 'ES256' || envelope.kid !== message.enrolled_by) return rejected('malformed');
      // Enrolls are checked against the admin set AND the overlay.
      if (!this.isActive(message.enrolled_by)) return rejected('signer_not_active');
      if (!verifyEs256(envelope, this.get(message.enrolled_by).public_key)) return rejected('bad_signature');
      const existing = this.get(message.device.device_id);
      if (existing && existing.revoked_at !== null) return rejected('revoked_device');
      if (existing && this.isAdminApplied(existing.device_id)) return { state: 'duplicate' };
      this._writeStaged(message.nonce, envelope);
      return { state: 'staged' };
    }

    const fault = this._checkRevoke(envelope, message);
    if (fault) return rejected(fault);
    this._writeStaged(message.nonce, envelope);
    this.overlay.add(message.device_id);
    return { state: 'revoked-pending-apply' };
  }

  _writeStaged(nonce, envelope) {
    this.fs.mkdirSync(this.stagedDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this._stagedFile(nonce), `${JSON.stringify({ received_at: new Date(this.now()).toISOString(), envelope })}\n`);
  }
}

module.exports = { ApproverStore, checkApproverRecord, checkApproverDir, writeFileAtomic, APPROVER_CONTROLS };
```

Create `src/approvals/approver-admin.js`:

```js
// Writes the approver set. Only the admin-run CLI (`enroll-device`, `device
// revoke|apply`) loads this module; the service never does, because whoever
// can write <configDir>/approvers/ approves anything.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ApproverStore, checkApproverRecord, writeFileAtomic } = require('./approver-store');
const { open, verifyEs256 } = require('./envelope');
const { validateMessage, iso } = require('./messages');

const MAX_STAGED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

class ApproverAdminError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApproverAdminError';
  }
}

class ApproverAdmin {
  constructor({ dir, stagedDir, now = Date.now, allowTestKeys = false, geteuid, adminUid = 0, platform = process.platform } = {}) {
    this.dir = dir;
    this.stagedDir = stagedDir;
    this.now = now;
    this.storeOptions = { dir, stagedDir, allowTestKeys, adminUid, platform, now, ...(geteuid ? { geteuid } : {}) };
  }

  // Creating a file is the only reliable test on every platform: on Windows
  // the ACL decides, and access(W_OK) does not consult it.
  assertWritable() {
    const fail = () => new ApproverAdminError(`Run this as root/Administrator: ${this.dir} is not writable.`);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o755 });
    } catch {
      throw fail();
    }
    const probe = path.join(this.dir, `.probe-${crypto.randomBytes(6).toString('hex')}`);
    try {
      fs.closeSync(fs.openSync(probe, 'wx', 0o644));
      fs.unlinkSync(probe);
    } catch {
      throw fail();
    }
  }

  _file(deviceId) {
    return path.join(this.dir, `${deviceId}.json`);
  }

  read(deviceId) {
    try {
      return JSON.parse(fs.readFileSync(this._file(deviceId), 'utf8'));
    } catch {
      return null;
    }
  }

  writeApprover(record) {
    this.assertWritable();
    const fault = checkApproverRecord(record);
    if (fault) throw new ApproverAdminError(`Refusing to write approver ${record && record.device_id}: ${fault}`);
    const existing = this.read(record.device_id);
    if (existing && existing.revoked_at !== null && record.revoked_at === null) {
      throw new ApproverAdminError(`${record.device_id} was revoked and is never re-activated. Enroll the phone again with a new key.`);
    }
    writeFileAtomic(this._file(record.device_id), `${JSON.stringify(record, null, 2)}\n`, 0o644);
    return record;
  }

  markRevoked(deviceId, by) {
    this.assertWritable();
    const record = this.read(deviceId);
    if (!record) throw new ApproverAdminError(`No approver ${deviceId} on this node.`);
    if (record.revoked_at !== null) return record;
    const revoked = { ...record, revoked_at: iso(this.now()), revoked_by: by };
    writeFileAtomic(this._file(deviceId), `${JSON.stringify(revoked, null, 2)}\n`, 0o644);
    return revoked;
  }

  listStaged() {
    if (!this.stagedDir || !fs.existsSync(this.stagedDir)) return [];
    const items = [];
    for (const name of fs.readdirSync(this.stagedDir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(this.stagedDir, name);
      try {
        const { received_at: receivedAt, envelope } = JSON.parse(fs.readFileSync(file, 'utf8'));
        const { message } = open(envelope);
        const revoke = message.type === 'kl.device.revoke';
        items.push({
          file,
          type: message.type,
          deviceId: revoke ? message.device_id : message.device && message.device.device_id,
          signer: revoke ? message.revoked_by : message.enrolled_by,
          receivedAt,
          ageMs: this.now() - Date.parse(receivedAt),
          envelope,
          message
        });
      } catch (err) {
        items.push({ file, type: 'unreadable', deviceId: null, signer: null, receivedAt: null, ageMs: Infinity, envelope: null, message: null, error: err.message });
      }
    }
    return items;
  }

  _done(file) {
    const doneDir = path.join(this.stagedDir, 'done');
    fs.mkdirSync(doneDir, { recursive: true, mode: 0o700 });
    fs.renameSync(file, path.join(doneDir, path.basename(file)));
  }

  // `confirm(items) → Promise<boolean>` sees the batch before anything is
  // written. Every item is judged against the admin set as it stood before
  // the batch; revokes go first, and an enrollment signed by a device this
  // batch revokes is refused.
  async applyStaged({ now = this.now(), confirm }) {
    const items = this.listStaged();
    if (items.length === 0) return [];
    if (!(await confirm(items))) return [];
    this.assertWritable();

    const before = new ApproverStore(this.storeOptions);
    const applied = new Map(before.list().filter((r) => before.isAdminApplied(r.device_id)).map((r) => [r.device_id, r]));
    const revokedInBatch = new Set();
    const order = [...items.filter((i) => i.type === 'kl.device.revoke'), ...items.filter((i) => i.type !== 'kl.device.revoke')];
    const results = [];

    for (const item of order) {
      let result;
      if (!item.message) {
        result = `rejected: unreadable (${item.error})`;
      } else if (now - Date.parse(item.receivedAt) > MAX_STAGED_AGE_MS) {
        result = 'rejected: older than 7 days';
      } else if (validateMessage(item.type, item.message)) {
        result = 'rejected: malformed';
      } else {
        const signer = applied.get(item.signer);
        const signedOk = signer && item.envelope.kid === item.signer && verifyEs256(item.envelope, signer.public_key);
        if (item.type === 'kl.device.revoke') {
          if (item.signer === item.deviceId) result = 'rejected: a device cannot revoke itself';
          else if (!signedOk) result = 'rejected: signer is not an active approver';
          else if (!this.read(item.deviceId)) result = 'rejected: unknown device';
          else {
            this.markRevoked(item.deviceId, item.signer);
            revokedInBatch.add(item.deviceId);
            result = 'revoked';
          }
        } else if (!signedOk || revokedInBatch.has(item.signer)) {
          result = 'rejected: signer is not an active approver';
        } else {
          const existing = this.read(item.deviceId);
          if (existing && existing.revoked_at !== null) result = 'rejected: device was revoked';
          else if (existing) result = 'rejected: already enrolled';
          else {
            const { device } = item.message;
            this.writeApprover({
              v: 1,
              device_id: device.device_id,
              name: device.name,
              platform: device.platform,
              public_key: device.public_key,
              enrolled_at: iso(now),
              enrolled_by: item.signer,
              revoked_at: null,
              revoked_by: null,
              enrollment: item.envelope
            });
            result = 'enrolled';
          }
        }
      }
      this._done(item.file);
      results.push({ file: item.file, type: item.type, deviceId: item.deviceId, signer: item.signer, result });
    }
    return results;
  }
}

module.exports = { ApproverAdmin, ApproverAdminError, MAX_STAGED_AGE_MS };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-approver-store.test.js`
Expected: PASS, `fail 0` (15 tests; on Windows the POSIX ownership test is skipped).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/approver-store.js src/approvals/approver-admin.js tests/helpers/approver-set.js tests/approvals-approver-store.test.js
git commit -m "feat(approvals): read-only approver store with staging and overlay; admin-only writer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Device-envelope verification

**Files:**
- Create: `src/approvals/verify-device.js`
- Test: `tests/approvals-verify-device.test.js`

**Interfaces:**
- Consumes: `open`, `verifyEs256`, `EnvelopeError` (Task 3); `validateMessage`, `enrollMac` (Task 4); `isTestDeviceKey` (Task 6); an `ApproverStore` (Task 7): `get`, `isActive`, `allowTestKeys`.
- Produces (program P3): `verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces = null, overlay = true }) → { ok: true, message, bytes, deviceId } | { ok: false, reason }` with reasons, in order, `malformed` / `unsupported_version` (1), `malformed` (2), `unknown_device` (3), `demo_device` / `test_key` (4), `revoked_device` (5), `bad_signature` (6), `wrong_node` (7), `replay` / `already_decided` (8); `new NonceCache({ max = 10000, ttlMs = 600000, now })` with `get(nonce) → { sha256 } | null`, `add(nonce, sha256)`; `bytesSha256(bytes)`; `verifyConsoleEnrollment(envelope, { codeId, code, now, allowTestKeys }) → { ok: true, message, deviceId } | { ok: false, reason }` (`malformed`, `wrong_code`, `demo_device`, `test_key`, `bad_signature`, `bad_mac`, `expired`). F5 and C4 call `verifyDeviceEnvelope` for their own types (registered with `registerMessageValidator`).

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-verify-device.test.js`:

```js
// tests/approvals-verify-device.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyDeviceEnvelope, verifyConsoleEnrollment, NonceCache, bytesSha256 } = require('../src/approvals/verify-device');
const { seal, toB64url, fromB64url } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function setup({ overlay = [], extraRecords = [], allowTestKeys = false } = {}) {
  const node = testNodeIdentity();
  const phone = createFakePhone();
  const store = await approverStoreWith([phone.approverRecord(), ...extraRecords], { overlay, allowTestKeys });
  stores.push(store);
  const { envelope: request } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
  const verify = (env, extra = {}) => verifyDeviceEnvelope(env, { approverStore: store, type: 'kl.approval.response', nodeId: node.nodeId, ...extra });
  return { node, phone, store, request, verify };
}

describe('verifyDeviceEnvelope', () => {
  it('accepts a good response and returns the message, bytes and device', async () => {
    const { phone, request, verify } = await setup();
    const result = verify(phone.respond(request, 'approve'));
    assert.equal(result.ok, true);
    assert.equal(result.deviceId, phone.deviceId);
    assert.equal(result.message.decision, 'approve');
    assert.ok(Buffer.isBuffer(result.bytes));
  });

  it('step 1: malformed and unsupported_version', async () => {
    const { phone, request, verify } = await setup();
    const good = phone.respond(request, 'approve');
    const spaced = Buffer.from(fromB64url(good.payload).toString('utf8').replace('{', '{ '));
    assert.deepEqual(verify({ ...good, payload: toB64url(spaced), sig: toB64url(phone.signer.sign(spaced)) }), { ok: false, reason: 'malformed' });
    assert.deepEqual(verify(phone.respond(request, 'approve', { overrides: { v: 2 } })), { ok: false, reason: 'unsupported_version' });
    assert.deepEqual(verify(phone.respond(request, 'maybe')), { ok: false, reason: 'malformed' });
    assert.deepEqual(verify(good, { type: 'kl.approval.status' }), { ok: false, reason: 'malformed' });
  });

  it('step 2: alg must be ES256 and kid the device named inside', async () => {
    const { phone, request, verify } = await setup();
    const good = phone.respond(request, 'approve');
    assert.deepEqual(verify({ ...good, alg: 'Ed25519' }), { ok: false, reason: 'malformed' });
    const other = createFakePhone();
    assert.deepEqual(verify(phone.respond(request, 'approve', { overrides: { device_id: other.deviceId } })), { ok: false, reason: 'malformed' });
  });

  it('steps 3–5: unknown, demo, test-key and revoked devices', async () => {
    const demo = createFakePhone({ platform: 'demo' });
    const testKey = createFakePhone({ seed: 'B' });
    const revoked = createFakePhone();
    const { request, verify } = await setup({
      extraRecords: [demo.approverRecord(), testKey.approverRecord(), revoked.approverRecord({ revokedAt: '2026-09-23T17:00:00.000Z', revokedBy: 'console' })]
    });
    assert.deepEqual(verify(createFakePhone().respond(request, 'approve')), { ok: false, reason: 'unknown_device' });
    assert.deepEqual(verify(demo.respond(request, 'approve')), { ok: false, reason: 'demo_device' });
    assert.deepEqual(verify(testKey.respond(request, 'approve')), { ok: false, reason: 'test_key' });
    assert.deepEqual(verify(revoked.respond(request, 'approve')), { ok: false, reason: 'revoked_device' });
    const overlaid = await setup();
    overlaid.store.addToOverlay(overlaid.phone.deviceId);
    assert.deepEqual(overlaid.verify(overlaid.phone.respond(overlaid.request, 'approve')), { ok: false, reason: 'revoked_device' });
    assert.equal(overlaid.verify(overlaid.phone.respond(overlaid.request, 'approve'), { overlay: false }).ok, true);
  });

  it('a test key is accepted only with allowTestKeys', async () => {
    const b = createFakePhone({ seed: 'B' });
    const { request, verify } = await setup({ extraRecords: [b.approverRecord()], allowTestKeys: true });
    assert.equal(verify(b.respond(request, 'approve')).ok, true);
  });

  it('step 6: bad_signature', async () => {
    const { phone, request, verify } = await setup();
    const good = phone.respond(request, 'approve');
    const deny = phone.respond(request, 'deny');
    assert.deepEqual(verify({ ...good, sig: deny.sig }), { ok: false, reason: 'bad_signature' });
  });

  it('step 7: wrong_node', async () => {
    const { phone, verify } = await setup();
    const elsewhere = m.buildRequest({ identity: testNodeIdentity({ nodeName: 'gpu-box' }), action: m.toolAction('Bash', { command: 'ls' }, null) }).envelope;
    assert.deepEqual(verify(phone.respond(elsewhere, 'approve')), { ok: false, reason: 'wrong_node' });
  });

  it('step 8: replay (same bytes) and already_decided (different bytes, same nonce)', async () => {
    const { phone, request, verify } = await setup();
    const nonces = new NonceCache();
    const first = phone.respond(request, 'approve');
    const opened = verify(first, { nonces });
    nonces.add(opened.message.nonce, bytesSha256(opened.bytes));
    assert.deepEqual(verify(first, { nonces }), { ok: false, reason: 'replay' });
    const second = createFakePhone();
    const s2 = await approverStoreWith([phone.approverRecord(), second.approverRecord()]);
    stores.push(s2);
    assert.deepEqual(verifyDeviceEnvelope(second.respond(request, 'deny'), { approverStore: s2, type: 'kl.approval.response', nodeId: opened.message.node_id, nonces }), { ok: false, reason: 'already_decided' });
  });
});

describe('NonceCache', () => {
  it('forgets entries after ttlMs and keeps at most max', () => {
    let now = 0;
    const cache = new NonceCache({ max: 2, ttlMs: 1000, now: () => now });
    cache.add('a', 'x');
    cache.add('b', 'y');
    cache.add('c', 'z');
    assert.equal(cache.get('a'), null);
    assert.deepEqual(cache.get('c'), { sha256: 'z' });
    now = 2000;
    assert.equal(cache.get('b'), null);
  });
});

describe('verifyConsoleEnrollment', () => {
  const codeId = crypto.randomBytes(16).toString('base64url');
  const code = crypto.randomBytes(32).toString('base64url');

  it('accepts a self-signed enrollment with the right code_mac', () => {
    const phone = createFakePhone({ name: 'Pixel 9' });
    const result = verifyConsoleEnrollment(phone.enroll({ codeId, code }), { codeId, code });
    assert.equal(result.ok, true);
    assert.equal(result.deviceId, phone.deviceId);
  });

  it('refuses a wrong code, a wrong code_id, an expired one and a test key', () => {
    const phone = createFakePhone();
    assert.deepEqual(verifyConsoleEnrollment(phone.enroll({ codeId, code: crypto.randomBytes(32).toString('base64url') }), { codeId, code }), { ok: false, reason: 'bad_mac' });
    assert.deepEqual(verifyConsoleEnrollment(phone.enroll({ codeId, code }), { codeId: crypto.randomBytes(16).toString('base64url'), code }), { ok: false, reason: 'wrong_code' });
    assert.deepEqual(verifyConsoleEnrollment(phone.enroll({ codeId, code, now: Date.now() - 20 * 60 * 1000 }), { codeId, code }), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyConsoleEnrollment(createFakePhone({ seed: 'C' }).enroll({ codeId, code }), { codeId, code }), { ok: false, reason: 'test_key' });
    const other = createFakePhone();
    const signedByOther = seal({ ...JSON.parse(fromB64url(phone.enroll({ codeId, code }).payload)) }, { ...other.signer, kid: phone.deviceId });
    assert.deepEqual(verifyConsoleEnrollment(signedByOther, { codeId, code }), { ok: false, reason: 'bad_signature' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-verify-device.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/verify-device'`.

- [ ] **Step 3: Implement**

Create `src/approvals/verify-device.js`:

```js
// The one check every phone-signed envelope passes on a node: approval
// responses here, `kl.lease.*` in F5, `kl.question.answer` in C4. Steps run in
// the order of the spec's table and the first failure decides `reason`; the
// approval-v1 vectors pin that order.
const crypto = require('crypto');
const { open, verifyEs256, EnvelopeError } = require('./envelope');
const { validateMessage, enrollMac } = require('./messages');
const { isTestDeviceKey } = require('./test-keys');

// Nonces of decided messages, in memory. `get` → { sha256 } | null.
class NonceCache {
  constructor({ max = 10000, ttlMs = 600000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  _prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [nonce, entry] of this.entries) {
      if (entry.at >= cutoff && this.entries.size <= this.max) break;
      this.entries.delete(nonce);
    }
  }

  get(nonce) {
    this._prune();
    const entry = this.entries.get(nonce);
    return entry ? { sha256: entry.sha256 } : null;
  }

  add(nonce, sha256) {
    this.entries.delete(nonce);
    this.entries.set(nonce, { sha256, at: this.now() });
    this._prune();
  }
}

function bytesSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

function verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces = null, overlay = true } = {}) {
  const fail = (reason) => ({ ok: false, reason });

  // 1. Opens, canonical bytes, v === 1, the expected type, well-formed fields.
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return fail('malformed');
    throw err;
  }
  const { message, bytes } = opened;
  const shape = validateMessage(type, message);
  if (shape) return fail(shape);

  // 2. A phone signature, by the device the message names.
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device_id) return fail('malformed');

  // 3–5. A known, real, currently trusted approver.
  const record = approverStore.get(envelope.kid);
  if (!record) return fail('unknown_device');
  if (record.platform === 'demo') return fail('demo_device');
  if (!approverStore.allowTestKeys && isTestDeviceKey(record.public_key)) return fail('test_key');
  if (!approverStore.isActive(envelope.kid, { overlay })) return fail('revoked_device');

  // 6. Signature over the bytes received.
  if (!verifyEs256(envelope, record.public_key)) return fail('bad_signature');

  // 7. Meant for this node.
  if (message.node_id !== nodeId) return fail('wrong_node');

  // 8. Single use: the same bytes again is a replay; different bytes for a
  // decided nonce (a second phone) is already_decided.
  if (nonces) {
    const seen = nonces.get(message.nonce);
    if (seen) return fail(seen.sha256 === bytesSha256(bytes) ? 'replay' : 'already_decided');
  }
  return { ok: true, message, bytes, deviceId: envelope.kid };
}

// The console side of `enroll-device` (§3.10 step 4): the phone signed its own
// kl.device.enroll with the key it enrolls, and proved it scanned the QR with
// code_mac = HMAC-SHA256(code, JCS(message without code_mac)). The relay never
// sees `code`, so it cannot forge this.
function verifyConsoleEnrollment(envelope, { codeId, code, now = Date.now(), allowTestKeys = false } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return fail('malformed');
    throw err;
  }
  const { message } = opened;
  const shape = validateMessage('kl.device.enroll', message);
  if (shape) return fail(shape);
  if (message.enrolled_by !== null) return fail('malformed');
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device.device_id) return fail('malformed');
  if (message.code_id !== codeId) return fail('wrong_code');
  if (message.device.platform === 'demo') return fail('demo_device');
  if (!allowTestKeys && isTestDeviceKey(message.device.public_key)) return fail('test_key');
  if (!verifyEs256(envelope, message.device.public_key)) return fail('bad_signature');
  const { code_mac: mac, ...withoutMac } = message;
  const expected = Buffer.from(enrollMac(code, withoutMac));
  const given = Buffer.from(String(mac));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return fail('bad_mac');
  if (now > Date.parse(message.expires_at)) return fail('expired');
  return { ok: true, message, deviceId: message.device.device_id };
}

module.exports = { verifyDeviceEnvelope, verifyConsoleEnrollment, NonceCache, bytesSha256 };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-verify-device.test.js`
Expected: PASS, `fail 0` (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/approvals/verify-device.js tests/approvals-verify-device.test.js
git commit -m "feat(approvals): shared phone-envelope verification and console enrollment check

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Pending requests and the PhoneApprover

**Files:**
- Create: `src/approvals/pending-store.js`, `src/approvals/phone-approver.js`
- Test: `tests/approvals-phone-approver.test.js`

**Interfaces:**
- Consumes: `canonicalize`, `sha256b64url` (Task 1); `buildRequest`, `buildStatus`, `toolAction`, `actionHash`, `MessageError`, `TTL_MAX_MS`, `clampTtl` (Task 4); `verifyDeviceEnvelope`, `NonceCache`, `bytesSha256` (Task 8); an `ApproverStore` (Task 7); a link (`isConnected()`, `canDeliver()`, `submit(env)`, `status(env)`, `on('connected')`) and an audit ledger (`append({ kind, data })`).
- Produces (program P6, P7, §4.12): `new PendingRequests({ now, nonces })` with `add`, `get`, `take`, `expire(now)`, `list()`, `size`, `nonces`. `new PhoneApprover({ identity, nodeName, approverStore, link, auditLedger, ttlMs = 300000, now, setTimer, clearTimer, buildRequest })` with `isAvailable()`, `unavailableReason() → string | null`, `requestAction(action, { origin, signal, currentAction }) → Promise<{ decision, request_id, device_id, action_hash, reason }>` (`decision` ∈ `approve | deny | expired | withdrawn | unavailable | error`; throws `TypeError('currentAction required')`), `requestApproval(toolName, parameters, metadata) → true | false | 'timeout' | 'unavailable'` (sets `metadata.refusal = { deniedBy, error }` on refusals), `handleResponse(envelope) → Promise<{ accepted, reason }>` (checks 1–13), `pending() → [{ request_id, expires_at, summary }]`, `stop()`, properties `ttlMs`, `nonces`. `DEFAULT_UNAVAILABLE`.

Audit kinds written here: `approval.request { envelope, job_id }`, `approval.response { request_id, device_id, decision, envelope, job_id }` (awaited — step 13), `approval.rejected { request_id, device_id, reason, envelope_sha256 }` and `approval.outcome { request_id, state, reason, job_id }` (best effort).

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-phone-approver.test.js` (timers are fired by hand, so no test waits for a real TTL):

```js
// tests/approvals-phone-approver.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { toolAction, actionHash } = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

// The link a relay client would be: records what the approver sends.
function fakeLink({ connected = true, canDeliver = { ok: true } } = {}) {
  const link = new EventEmitter();
  link.connected = connected;
  link.submitted = [];
  link.statuses = [];
  link.isConnected = () => link.connected;
  link.canDeliver = () => canDeliver;
  link.submit = async (env) => { link.submitted.push(env); };
  link.status = async (env) => { link.statuses.push(open(env).message); };
  link.connect = () => { link.connected = true; link.emit('connected'); };
  return link;
}

function fakeLedger() {
  const ledger = { entries: [], failing: false };
  ledger.append = async (entry) => {
    if (ledger.failing) throw new Error('audit_unavailable: disk full');
    ledger.entries.push(entry);
    return entry;
  };
  ledger.kinds = () => ledger.entries.map((e) => e.kind);
  return ledger;
}

// Timers the test fires by hand, so expiry needs no waiting.
function manualTimers() {
  const timers = new Set();
  return {
    setTimer: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearTimer: (t) => { timers.delete(t); },
    fireAll: () => { for (const t of [...timers]) { timers.delete(t); t.fn(); } }
  };
}

async function setup({ phones = 1, link = fakeLink(), ttlMs = 300000, records = null } = {}) {
  const identity = testNodeIdentity();
  const devices = Array.from({ length: phones }, (_, i) => createFakePhone({ name: `Phone ${i + 1}` }));
  const store = await approverStoreWith(records || devices.map((d) => d.approverRecord()));
  stores.push(store);
  const ledger = fakeLedger();
  const timers = manualTimers();
  const approver = new PhoneApprover({ identity, approverStore: store, link, auditLedger: ledger, ttlMs, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { identity, devices, store, ledger, link, timers, approver };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitForSubmit(link, n = 1) {
  for (let i = 0; i < 100 && link.submitted.length < n; i += 1) await tick();
  return link.submitted[n - 1];
}

describe('PhoneApprover.requestAction', () => {
  it('signs, audits and submits the request, then resolves on an approval', async () => {
    const { approver, link, devices, ledger, identity } = await setup();
    const action = toolAction('Bash', { command: 'git push' }, '/srv/site');
    const pending = approver.requestAction(action, { origin: { client: 'gateway', session: 's-1' }, currentAction: () => toolAction('Bash', { command: 'git push' }, '/srv/site') });
    const request = await waitForSubmit(link);
    assert.equal(verifyEd25519(request, identity.publicKey.toString('hex')), true);
    const { message } = open(request);
    assert.equal(message.action_hash, actionHash(action));
    assert.deepEqual(message.origin, { client: 'gateway', session: 's-1', job_id: null });
    assert.deepEqual(approver.pending().map((p) => p.request_id), [message.request_id]);

    assert.deepEqual(await approver.handleResponse(devices[0].respond(request, 'approve')), { accepted: true, reason: null });
    const outcome = await pending;
    assert.deepEqual(outcome, { decision: 'approve', request_id: message.request_id, device_id: devices[0].deviceId, action_hash: message.action_hash, reason: null });
    assert.deepEqual(ledger.kinds(), ['approval.request', 'approval.response', 'approval.outcome']);
    assert.equal(link.statuses[0].state, 'approved');
    assert.deepEqual(approver.pending(), []);
  });

  it('requires currentAction', async () => {
    const { approver } = await setup();
    await assert.rejects(approver.requestAction(toolAction('Bash', { command: 'ls' }, null), {}), /currentAction required/);
  });

  it('clamps the TTL to 30–300 s', async () => {
    const short = await setup({ ttlMs: 1000 });
    short.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    const { message } = open(await waitForSubmit(short.link));
    assert.equal(Date.parse(message.expires_at) - Date.parse(message.created_at), 30000);
    short.approver.stop();
  });

  it('is unavailable at once with no enrolled device or no delivery', async () => {
    const none = await setup({ records: [] });
    const outcome = await none.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) });
    assert.deepEqual(outcome, { decision: 'unavailable', request_id: null, device_id: null, action_hash: null, reason: 'no enrolled device on this node' });
    const stopped = await setup({ link: fakeLink({ canDeliver: { ok: false, reason: 'the King Louie service is not running on this node' } }) });
    assert.equal(stopped.approver.isAvailable(), false);
    assert.equal((await stopped.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) })).reason, 'the King Louie service is not running on this node');
  });

  it('fails with error when the action cannot be built or audited', async () => {
    const big = await setup();
    const tooLarge = { kind: 'tool', name: 'Write', params: { content: 'x'.repeat(300000) }, cwd: null, summary: 'Write' };
    assert.equal((await big.approver.requestAction(tooLarge, { currentAction: () => tooLarge })).reason, 'action_too_large');
    big.ledger.failing = true;
    const outcome = await big.approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => ({}) });
    assert.equal(outcome.decision, 'error');
    assert.equal(outcome.reason, 'audit_unavailable');
    assert.equal(big.link.submitted.length, 0, 'an unaudited request is never sent');
  });

  it('expires on the node clock with an expired status', async () => {
    const { approver, link, timers, ledger } = await setup();
    const pending = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    await waitForSubmit(link);
    timers.fireAll();
    assert.equal((await pending).decision, 'expired');
    assert.equal(link.statuses[0].state, 'expired');
    await tick();
    assert.ok(ledger.kinds().includes('approval.outcome'));
  });

  it('queued while down, submitted on connect, expires on node clock if the link never returns', async () => {
    const link = fakeLink({ connected: false });
    const { approver, timers, devices } = await setup({ link });
    const first = approver.requestAction(toolAction('Bash', { command: 'ls' }, null), { currentAction: () => toolAction('Bash', { command: 'ls' }, null) });
    await tick();
    await tick();
    assert.equal(link.submitted.length, 0);
    link.connect();
    const request = await waitForSubmit(link);
    await approver.handleResponse(devices[0].respond(request, 'approve'));
    assert.equal((await first).decision, 'approve');

    link.connected = false;
    const second = approver.requestAction(toolAction('Bash', { command: 'pwd' }, null), { currentAction: () => toolAction('Bash', { command: 'pwd' }, null) });
    await tick();
    await tick();
    assert.equal(link.submitted.length, 1, 'nothing new was sent while down');
    timers.fireAll();
    assert.equal((await second).decision, 'expired');
  });
});

describe('PhoneApprover.handleResponse', () => {
  async function started(opts = {}) {
    const ctx = await setup(opts);
    let live = { command: 'git push' };
    ctx.setLive = (v) => { live = v; };
    ctx.pending = ctx.approver.requestAction(toolAction('Bash', live, null), { currentAction: () => toolAction('Bash', live, null) });
    ctx.request = await waitForSubmit(ctx.link);
    return ctx;
  }

  it('first valid response decides; second gets already_decided; both audited', async () => {
    const { approver, devices, request, pending, ledger } = await started({ phones: 2 });
    assert.deepEqual(await approver.handleResponse(devices[0].respond(request, 'approve')), { accepted: true, reason: null });
    assert.deepEqual(await approver.handleResponse(devices[1].respond(request, 'deny')), { accepted: false, reason: 'already_decided' });
    assert.equal((await pending).decision, 'approve');
    await tick();
    assert.deepEqual(ledger.kinds().filter((k) => k.startsWith('approval.re')), ['approval.request', 'approval.response', 'approval.rejected']);
  });

  it('the same response twice is a replay', async () => {
    const { approver, devices, request } = await started();
    const response = devices[0].respond(request, 'deny');
    assert.equal((await approver.handleResponse(response)).accepted, true);
    assert.deepEqual(await approver.handleResponse(response), { accepted: false, reason: 'replay' });
  });

  it('change the action after approval: action_changed consumes the request', async () => {
    const { approver, devices, request, pending, setLive, link } = await started();
    setLive({ command: 'git push --force' });
    assert.deepEqual(await approver.handleResponse(devices[0].respond(request, 'approve')), { accepted: false, reason: 'action_changed' });
    const outcome = await pending;
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.reason, 'action_changed');
    assert.equal(link.statuses[0].state, 'refused');
  });

  it('a response that fails its binding checks leaves the request pending', async () => {
    const { approver, devices, request } = await started();
    const other = devices[0].respond(request, 'approve', { overrides: { expires_at: '2030-01-01T00:00:00.000Z' } });
    assert.deepEqual(await approver.handleResponse(other), { accepted: false, reason: 'expires_mismatch' });
    assert.equal(approver.pending().length, 1);
    assert.equal((await approver.handleResponse(devices[0].respond(request, 'approve'))).accepted, true);
  });

  it('audit failure at step 13: not accepted, still pending, a retry succeeds', async () => {
    const { approver, devices, request, pending, ledger } = await started();
    ledger.failing = true;
    const response = devices[0].respond(request, 'approve');
    assert.deepEqual(await approver.handleResponse(response), { accepted: false, reason: 'audit_unavailable' });
    assert.equal(approver.pending().length, 1);
    ledger.failing = false;
    assert.deepEqual(await approver.handleResponse(response), { accepted: true, reason: null });
    assert.equal((await pending).decision, 'approve');
  });

  it('abort → withdrawn; later approve → unknown_request; tool never runs', async () => {
    const ctx = await setup();
    const controller = new AbortController();
    const metadata = { signal: controller.signal, workingDirectory: '/srv/site' };
    const result = ctx.approver.requestApproval('Bash', { command: 'rm -rf build' }, metadata);
    const request = await waitForSubmit(ctx.link);
    controller.abort();
    assert.equal(await result, false);
    assert.equal(ctx.link.statuses[0].state, 'withdrawn');
    assert.deepEqual(await ctx.approver.handleResponse(ctx.devices[0].respond(request, 'approve')), { accepted: false, reason: 'unknown_request' });
  });
});

describe('PhoneApprover.requestApproval', () => {
  it('maps outcomes to true | false | timeout | unavailable and sets metadata.refusal', async () => {
    const ctx = await setup();
    const approve = ctx.approver.requestApproval('Bash', { command: 'ls' }, { workingDirectory: '/tmp' });
    const request = await waitForSubmit(ctx.link);
    assert.equal(open(request).message.action.cwd, '/tmp');
    await ctx.approver.handleResponse(ctx.devices[0].respond(request, 'approve'));
    assert.equal(await approve, true);

    const deny = ctx.approver.requestApproval('Bash', { command: 'ls' }, {});
    await ctx.approver.handleResponse(ctx.devices[0].respond(await waitForSubmit(ctx.link, 2), 'deny'));
    assert.equal(await deny, false);

    const expire = ctx.approver.requestApproval('Bash', { command: 'ls' }, {});
    await waitForSubmit(ctx.link, 3);
    ctx.timers.fireAll();
    assert.equal(await expire, 'timeout');

    const bad = {};
    assert.equal(await ctx.approver.requestApproval('Bash', { n: NaN }, bad), 'unavailable');
    assert.deepEqual(bad.refusal, { deniedBy: 'unavailable', error: 'Action cannot be shown on the phone (non_canonical); nothing ran.' });

    ctx.ledger.failing = true;
    const audit = {};
    assert.equal(await ctx.approver.requestApproval('Bash', { command: 'ls' }, audit), 'unavailable');
    assert.deepEqual(audit.refusal, { deniedBy: 'audit', error: 'Audit ledger unavailable; nothing ran.' });

    const none = await setup({ records: [] });
    const meta = {};
    assert.equal(await none.approver.requestApproval('Bash', { command: 'ls' }, meta), 'unavailable');
    assert.equal(meta.refusal.deniedBy, 'unavailable');
    assert.match(meta.refusal.error, /^Phone approval unavailable: no enrolled device on this node\. Nothing ran\.$/);
  });

  it('stop() ends every pending request without approving it', async () => {
    const ctx = await setup();
    const pending = ctx.approver.requestApproval('Bash', { command: 'ls' }, {});
    await waitForSubmit(ctx.link);
    ctx.approver.stop();
    assert.equal(await pending, 'unavailable');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/approvals-phone-approver.test.js`
Expected: FAIL with `Cannot find module '../src/approvals/phone-approver'`.

- [ ] **Step 3: Implement**

Create `src/approvals/pending-store.js`:

```js
// Approval requests waiting for a phone, in memory only: a restart fails the
// job (parent §9), so a response replayed after a restart finds nothing here
// and gets unknown_request.
const { NonceCache } = require('./verify-device');

class PendingRequests {
  constructor({ now = Date.now, nonces = null } = {}) {
    this.now = now;
    this.items = new Map();
    this.nonces = nonces || new NonceCache({ now });
  }

  // entry = { request, bytes, envelope, currentAction, resolve, ... }
  add(entry) {
    this.items.set(entry.request.request_id, entry);
    return entry;
  }

  get(requestId) {
    return this.items.get(requestId) || null;
  }

  take(requestId) {
    const entry = this.items.get(requestId) || null;
    if (entry) this.items.delete(requestId);
    return entry;
  }

  // Removes and returns every entry whose expires_at has passed on this clock.
  expire(now = this.now()) {
    const removed = [];
    for (const [id, entry] of this.items) {
      if (now > Date.parse(entry.request.expires_at)) {
        this.items.delete(id);
        removed.push(entry);
      }
    }
    return removed;
  }

  list() {
    return [...this.items.values()];
  }

  get size() {
    return this.items.size;
  }
}

module.exports = { PendingRequests };
```

Create `src/approvals/phone-approver.js`:

```js
// PhoneApprover (program §4.12): signs a request over the exact action, hands
// it to the relay link, and accepts the first valid phone-signed response.
// Only a verified `approve` for the unchanged action ever resolves `approve`,
// and requestApproval maps only that to `true`.
const { createLogger } = require('../logging');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const {
  buildRequest, buildStatus, toolAction, actionHash, MessageError, TTL_MAX_MS, clampTtl
} = require('./messages');
const { verifyDeviceEnvelope, bytesSha256 } = require('./verify-device');
const { PendingRequests } = require('./pending-store');

const log = createLogger('approvals/phone-approver');

const DEFAULT_UNAVAILABLE = 'Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.';

class PhoneApprover {
  constructor({ identity, nodeName = null, approverStore, link, auditLedger, ttlMs = TTL_MAX_MS, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, buildRequest: build = buildRequest } = {}) {
    if (!identity || !approverStore || !auditLedger) throw new TypeError('PhoneApprover needs identity, approverStore and auditLedger');
    this.identity = identity;
    this.nodeName = nodeName || identity.nodeName;
    this.approverStore = approverStore;
    this.link = link || null;
    this.auditLedger = auditLedger;
    this.ttlMs = clampTtl(ttlMs);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.build = build;
    this.pendingRequests = new PendingRequests({ now });
    this._onConnected = () => this._resubmitAll();
    if (this.link && typeof this.link.on === 'function') this.link.on('connected', this._onConnected);
  }

  get nonces() {
    return this.pendingRequests.nonces;
  }

  // Why no request could reach a phone right now, or null.
  unavailableReason() {
    if (!this.link) return 'no relay link on this node';
    const delivery = this.link.canDeliver();
    if (!delivery || !delivery.ok) return (delivery && delivery.reason) || 'the relay link cannot deliver';
    if (this.approverStore.activeCount() === 0) return 'no enrolled device on this node';
    return null;
  }

  isAvailable() {
    return this.unavailableReason() === null;
  }

  _outcome(decision, { request_id = null, device_id = null, action_hash = null, reason = null } = {}) {
    return { decision, request_id, device_id, action_hash, reason };
  }

  _audit(kind, data) {
    return this.auditLedger.append({ kind, data });
  }

  _auditBestEffort(kind, data) {
    Promise.resolve()
      .then(() => this._audit(kind, data))
      .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
  }

  async requestAction(action, { origin = null, signal = null, currentAction } = {}) {
    if (typeof currentAction !== 'function') throw new TypeError('currentAction required');
    const unavailable = this.unavailableReason();
    if (unavailable) return this._outcome('unavailable', { reason: unavailable });

    let built;
    try {
      built = this.build({ identity: this.identity, action, origin, ttlMs: this.ttlMs, now: this.now() });
    } catch (err) {
      if (err instanceof MessageError) return this._outcome('error', { reason: err.reason });
      throw err;
    }
    const { message, envelope, bytes } = built;
    const ids = { request_id: message.request_id, action_hash: message.action_hash };
    try {
      await this._audit('approval.request', { job_id: message.origin.job_id, envelope });
    } catch (err) {
      log.error(`approval.request not audited, so not sent: ${err.message}`);
      return this._outcome('error', { ...ids, reason: 'audit_unavailable' });
    }
    if (signal && signal.aborted) {
      this._auditBestEffort('approval.outcome', { request_id: message.request_id, state: 'withdrawn', reason: null, job_id: message.origin.job_id });
      return this._outcome('withdrawn', ids);
    }

    return new Promise((resolve) => {
      const entry = { request: message, envelope, bytes, currentAction, resolve, signal, timer: null, onAbort: null, deciding: false };
      this.pendingRequests.add(entry);
      const delay = Math.max(0, Date.parse(message.expires_at) - this.now());
      entry.timer = this.setTimer(() => this._finish(message.request_id, 'expired', { statusState: 'expired' }), delay);
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
      if (signal) {
        entry.onAbort = () => this._finish(message.request_id, 'withdrawn', { statusState: 'withdrawn' });
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this._submit(entry);
    });
  }

  // While the link is down the request stays pending; `connected` resubmits
  // every unexpired one (R16), since a restarted relay has an empty cache.
  _submit(entry) {
    if (!this.link || !this.link.isConnected()) return;
    Promise.resolve()
      .then(() => this.link.submit(entry.envelope))
      .catch((err) => log.warn(`approval.submit failed; will resubmit on reconnect: ${err.message}`));
  }

  _resubmitAll() {
    for (const entry of this.pendingRequests.list()) {
      if (this.now() <= Date.parse(entry.request.expires_at)) this._submit(entry);
    }
  }

  _sendStatus(requestId, state, deviceId, reason) {
    if (!this.link || !this.link.isConnected()) return;
    let status;
    try {
      status = buildStatus({ identity: this.identity, requestId, state, deviceId, reason, now: this.now() });
    } catch (err) {
      log.warn(`could not build status: ${err.message}`);
      return;
    }
    Promise.resolve()
      .then(() => this.link.status(status))
      .catch((err) => log.warn(`approval.status failed: ${err.message}`));
  }

  _finish(requestId, decision, { deviceId = null, reason = null, statusState = null } = {}) {
    const entry = this.pendingRequests.take(requestId);
    if (!entry) return;
    this.clearTimer(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    this._auditBestEffort('approval.outcome', { request_id: requestId, state: statusState || decision, reason, job_id: entry.request.origin.job_id });
    if (statusState) this._sendStatus(requestId, statusState, deviceId, reason);
    entry.resolve(this._outcome(decision, { request_id: requestId, device_id: deviceId, action_hash: entry.request.action_hash, reason }));
  }

  _reject(envelope, requestId, deviceId, reason) {
    let envelopeSha = null;
    try {
      envelopeSha = sha256b64url(canonicalize(envelope));
    } catch {
      envelopeSha = null;
    }
    this._auditBestEffort('approval.rejected', { request_id: requestId, device_id: deviceId, reason, envelope_sha256: envelopeSha });
    return { accepted: false, reason };
  }

  async handleResponse(envelope) {
    // Checks 1–8.
    const verified = verifyDeviceEnvelope(envelope, {
      approverStore: this.approverStore,
      type: 'kl.approval.response',
      nodeId: this.identity.nodeId,
      nonces: this.pendingRequests.nonces
    });
    if (!verified.ok) return this._reject(envelope, null, null, verified.reason);
    const { message, bytes, deviceId } = verified;
    const requestId = message.request_id;

    // 9. Pending (and nobody else is mid-decision on it).
    const entry = this.pendingRequests.get(requestId);
    if (!entry) return this._reject(envelope, requestId, deviceId, 'unknown_request');
    if (entry.deciding) return this._reject(envelope, requestId, deviceId, 'already_decided');
    const req = entry.request;

    // 10. Bound to exactly this request.
    if (message.nonce !== req.nonce) return this._reject(envelope, requestId, deviceId, 'nonce_mismatch');
    if (message.action_hash !== req.action_hash) return this._reject(envelope, requestId, deviceId, 'action_hash_mismatch');
    if (message.expires_at !== req.expires_at) return this._reject(envelope, requestId, deviceId, 'expires_mismatch');

    // 11. Fresh on the node's clock; the phone's signed_at is recorded, never judged.
    if (this.now() > Date.parse(req.expires_at)) return this._reject(envelope, requestId, deviceId, 'expired');

    // 12. The action, rebuilt from live state, is still the one approved.
    let live = null;
    try {
      live = actionHash(entry.currentAction());
    } catch {
      live = null;
    }
    if (live !== message.action_hash) {
      this.pendingRequests.nonces.add(message.nonce, bytesSha256(bytes));
      this._reject(envelope, requestId, deviceId, 'action_changed');
      this._finish(requestId, 'deny', { deviceId, reason: 'action_changed', statusState: 'refused' });
      return { accepted: false, reason: 'action_changed' };
    }

    // 13. Audited before it counts; on failure nothing is consumed and the phone may retry.
    entry.deciding = true;
    try {
      await this._audit('approval.response', { request_id: requestId, device_id: deviceId, decision: message.decision, envelope, job_id: req.origin.job_id });
    } catch (err) {
      entry.deciding = false;
      log.error(`approval.response not audited, so not accepted: ${err.message}`);
      return { accepted: false, reason: 'audit_unavailable' };
    }
    if (!this.pendingRequests.get(requestId)) return { accepted: false, reason: 'expired' };
    this.pendingRequests.nonces.add(message.nonce, bytesSha256(bytes));
    const approved = message.decision === 'approve';
    this._finish(requestId, approved ? 'approve' : 'deny', { deviceId, statusState: approved ? 'approved' : 'denied' });
    return { accepted: true, reason: null };
  }

  // The ToolExecutor requester: returns only true | false | 'timeout' |
  // 'unavailable' (program §3), and on a refusal says why in metadata.refusal.
  async requestApproval(toolName, parameters, metadata = {}) {
    const cwd = metadata.workingDirectory || null;
    const refuse = (deniedBy, error) => {
      metadata.refusal = { deniedBy, error };
      return 'unavailable';
    };
    let action;
    try {
      action = toolAction(toolName, parameters, cwd);
    } catch (err) {
      if (err instanceof MessageError) return refuse('unavailable', `Action cannot be shown on the phone (${err.reason}); nothing ran.`);
      throw err;
    }
    const outcome = await this.requestAction(action, {
      origin: metadata.origin || null,
      signal: metadata.signal || null,
      currentAction: () => toolAction(toolName, parameters, cwd)
    });
    switch (outcome.decision) {
      case 'approve':
        return true;
      case 'deny':
      case 'withdrawn':
        return false;
      case 'expired':
        return 'timeout';
      case 'error':
        if (outcome.reason === 'audit_unavailable') return refuse('audit', 'Audit ledger unavailable; nothing ran.');
        return refuse('unavailable', `Action cannot be shown on the phone (${outcome.reason}); nothing ran.`);
      default:
        return refuse('unavailable', outcome.reason ? `Phone approval unavailable: ${outcome.reason}. Nothing ran.` : DEFAULT_UNAVAILABLE);
    }
  }

  pending() {
    return this.pendingRequests.list().map((e) => ({ request_id: e.request.request_id, expires_at: e.request.expires_at, summary: e.request.action.summary }));
  }

  stop() {
    if (this.link && typeof this.link.off === 'function') this.link.off('connected', this._onConnected);
    for (const entry of this.pendingRequests.list()) {
      this._finish(entry.request.request_id, 'unavailable', { reason: 'the service is stopping', statusState: 'withdrawn' });
    }
  }
}

module.exports = { PhoneApprover, DEFAULT_UNAVAILABLE };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/approvals-phone-approver.test.js`
Expected: PASS, `fail 0` (15 tests), including the Review Focus cases "first valid response decides; second gets already_decided; both audited", "abort → withdrawn; later approve → unknown_request; tool never runs" and "queued while down, submitted on connect, expires on node clock if the link never returns".

- [ ] **Step 5: Commit**

```bash
git add src/approvals/pending-store.js src/approvals/phone-approver.js tests/approvals-phone-approver.test.js
git commit -m "feat(approvals): PhoneApprover — signed requests, the 13 response checks, requester mapping

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Hand-off to Part 2

Before Part 2 starts, run `npm test` on the merged Part 1 and confirm `fail 0`. Part 2 relies on exactly these exports:

| Module | Exports |
|---|---|
| `src/platform/jcs.js` | `canonicalize`, `sha256b64url`, `JcsError` |
| `src/execution/tool-patterns.js` | `SHELL_SEPARATORS`, `normalizeWhitespace`, `splitShellSegments`, `patternMatch`, `formatToolPattern` |
| `src/execution/safety-policy.js` | adds `normalizeWhitespace`, `splitShellSegments`, `SHELL_SEPARATORS`, `extractPathsFromParameters`; `classifyToolCall(toolName, parameters, policy, { cwd })` |
| `src/approvals/envelope.js` | `EnvelopeError`, `seal`, `open`, `verifyEd25519`, `verifyEs256`, `nodeSigner`, `deriveDeviceId`, `deviceIdFromJwk`, `ed25519RawToSpki`, `fingerprintGroups`, `isDeviceJwk`, `toB64url`, `fromB64url` |
| `src/approvals/messages.js` | `MessageError`, `TIMESTAMP_RE`, `NONCE_RE`, `CODE_ID_RE`, `DEVICE_ID_RE`, `NODE_ID_RE`, `MAX_ACTION_BYTES`, `TTL_MIN_MS`, `TTL_MAX_MS`, `PLATFORMS`, `iso`, `randomNonce`, `clampTtl`, `cutSummary`, `toolAction`, `runbookAction`, `envelopeAction`, `actionHash`, `normalizeOrigin`, `buildRequest`, `buildStatus`, `buildEnrollOpen`, `buildEnrollDone`, `enrollMac`, `inviteMac`, `phoneAuthString`, `encodeQr`, `decodeQr`, `validateMessage`, `registerMessageValidator`, `parseMessage`, `parseResponse`, `parseEnroll`, `parseRevoke` |
| `src/audit/audit-ledger.js` | `AuditLedger`, `verifyAuditSlice`, `entryHash` |
| `src/approvals/test-keys.js` | `TEST_DEVICE_KEYS`, `TEST_NODE_KEYS`, `isTestDeviceKey`, `isTestNodeKey` |
| `src/approvals/approver-store.js` | `ApproverStore`, `checkApproverRecord`, `checkApproverDir`, `writeFileAtomic`, `APPROVER_CONTROLS` |
| `src/approvals/approver-admin.js` | `ApproverAdmin`, `ApproverAdminError`, `MAX_STAGED_AGE_MS` |
| `src/approvals/verify-device.js` | `verifyDeviceEnvelope`, `verifyConsoleEnrollment`, `NonceCache`, `bytesSha256` |
| `src/approvals/pending-store.js` | `PendingRequests` |
| `src/approvals/phone-approver.js` | `PhoneApprover`, `DEFAULT_UNAVAILABLE` |
| `tests/helpers/fake-phone.js` | `createFakePhone`, `testNodeIdentity`, `KEYS` |
| `tests/helpers/approver-set.js` | `approverStoreWith` |
| `tests/vectors/approval-v1/keys.json` | fixed test keys: nodes `web-01`, `gpu-box`, `relay` (Ed25519 `seed`, `spki`, `id`); devices `A`, `B`, `C` (P-256 `d`, `jwk`, `id`) |

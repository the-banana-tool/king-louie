# kl-session-v1 — the session helper channel

The local protocol between the King Louie service (a system service) and its
session helper (`king-louie-service session`, running as the logged-in user).
Fleet stage 5 spec §3.2 and §4.2 are the source; this document fixes the bytes.

## 1. Transport

- Windows: a named pipe `\\.\pipe\king-louie-session-<endpoint_id>`, created by
  the service with `readableAll` and `writableAll` (Node cannot put one SID in a
  pipe DACL). Any local account can open it, and can also open another server
  instance of the same name; the protocol below is the security boundary.
- POSIX: a Unix socket `<session_ipc_dir>/<endpoint_id>.sock`, mode `0666`, in a
  `0711` directory owned by the service account (`/var/lib/king-louie-session`
  on Linux, `/Library/Application Support/KingLouie/session` on macOS). Socket
  names are not secret.

## 2. Frames

Before and including `ready`: `len(4, big-endian) ‖ UTF-8 JSON object`, at most
16 KiB. After `ready`: sealed frames (§4), at most 8 MiB. A zero or oversize
length, unparseable JSON, a JSON value that is not an object, or a frame that is
not the next expected handshake message closes the connection.

## 3. Handshake

| # | From | Frame |
|---|---|---|
| 1 | helper | `{ "t": "hello", "v": 1, "node_id", "nonce_h": b64url(32 random bytes), "pid", "user", "platform", "helper_version" }` |
| 2 | service | `{ "t": "challenge", "v": 1, "nonce_s": b64url(32), "proof_s" }` |
| 3 | helper | `{ "t": "auth", "proof_h" }` — sent only after `proof_s` verifies |
| 4 | service | `{ "t": "ready", "session_id": uuid-v4 }` — or `{ "t": "error", "code": "helper_already_connected" }` and close |

- `proof_s = b64url(HMAC-SHA256(secret, "kl-session-v1\nservice\n" + node_id + "\n" + nonce_h + "\n" + nonce_s))`
- `proof_h = b64url(HMAC-SHA256(secret, "kl-session-v1\nhelper\n" + node_id + "\n" + nonce_s + "\n" + nonce_h))`
- `secret` is the raw 32 bytes. Proofs compare in constant time.
- The service closes when `hello.node_id` differs from its canonical file or
  `hello.user` differs from `session_user`. The whole handshake has 5 s.
- At most 4 unauthenticated connections at once. One authenticated helper: a
  newcomer is refused (`error` frame above) while the current helper answers a
  `ping` within 5 s, and replaces it otherwise. That ping is part of the
  newcomer's handshake, so it is given what is left of the newcomer's 5 s less
  half a second (revised 2026-10-12): the answer always comes before the
  newcomer's own handshake limit, and a helper that hangs is replaced on the
  first attempt.

## 4. Sealing

`keys = HKDF-SHA256(ikm = secret, salt = empty, info, 64 bytes)` with
`info = UTF-8("kl-session-v1 keys") ‖ UTF-8(node_id) ‖ raw(nonce_h) ‖ raw(nonce_s)`
(the raw 32 bytes of each nonce). `k_sh = keys[0..32]` seals service → helper,
`k_hs = keys[32..64]` helper → service.

Each sealed frame: `len(4, BE) ‖ seq(8, BE) ‖ AES-256-GCM ciphertext ‖ tag(16)`,
`len` counting everything after itself.
- `dir` = `0x01` service → helper, `0x02` helper → service.
- `iv = dir(1) ‖ 0x000000 ‖ seq(8, BE)`; `aad = UTF-8("kl-session-v1") ‖ dir(1) ‖ seq(8, BE)`.
- `seq` starts at 1 in each direction and increments by 1. A frame whose `seq`
  is not the last + 1, or that fails to open, closes the connection.

## 5. Messages after `ready`

The helper's first sealed frame is its `probe_report`. Then:

- `{ "t": "req", "id", "op", "job_id", "lease_id", "params" }` → `{ "t": "res", "id", "ok": true, "result" }`
  or `{ "t": "res", "id", "ok": false, "error": { "code", "message", "detail" } }`.
- `{ "t": "event", "kind": "locked" | "unlocked" | "displays_changed" | "probe_changed", "data" }` (helper → service).
- `{ "t": "ping" }` / `{ "t": "pong" }`, either direction; the service pings
  every 10 s and closes after 30 s without a frame.

Ops: `launch`, `processes`, `windows`, `foreground`, `focus`, `close`,
`screenshot`, `input`, `release_all`, `probe` (spec §3.3). Timeouts: 10 s,
`screenshot` 20 s, `launch` 30 s. There is no clipboard op.

## 6. Vectors

`tests/vectors/session-v1/`, rebuilt by `generate.js`: `handshake` (proofs and
keys), `sealed-frames` (both directions), and the rejections `reject-seq-skip`,
`reject-seq-replay`, `reject-wrong-direction-key`, `reject-tampered-tag`.

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

The helper's first sealed frame is its `probe_report` (with `recorder`
since 2026-10-24, below). Then:

- `{ "t": "req", "id", "op", "job_id", "lease_id", "params" }` → `{ "t": "res", "id", "ok": true, "result" }`
  or `{ "t": "res", "id", "ok": false, "error": { "code", "message", "detail" } }`.
- `{ "t": "event", "kind": "locked" | "unlocked" | "displays_changed" | "probe_changed", "data" }` (helper → service).
- `{ "t": "ping" }` / `{ "t": "pong" }`, either direction; the service pings
  every 10 s and closes after 30 s without a frame.

Ops: `launch`, `processes`, `windows`, `foreground`, `focus`, `close`,
`screenshot`, `input`, `release_all`, `probe` (spec §3.3), and
`launch_browser`, `record_start`, `record_stop`, `keep_awake` (revised
2026-10-24, below). Timeouts: 10 s, `screenshot` 20 s, `launch` 30 s,
`launch_browser` 15 s, `record_stop` 20 s. There is no clipboard op.

Revised 2026-10-13 (second security review; no frame, proof or sealing
changed, and the vectors are the same):

- `windows` lists every visible top-level window of the given processes,
  owned ones too (a dialog, a pop-up menu, a dropdown list), and marks each
  `owned: true | false` where the backend can tell (Windows; a backend that
  cannot leaves it out). The service drops a listed window whose `pid` it
  did not ask for.
- `input` with `action.kind: "type"` carries at most 40 code points: the
  service sends longer text as several `input` ops and checks the lease
  before each. `release_all` also stops typing that is still going on (X11).
- A `point_obscured` refusal may say what covers the point:
  `detail.covering = { handle, pid }`. The service uses it only to tell the
  model which window to look at next, never to let a click through.
- The helper answers a failed `input` with its code alone (`message` is the
  code): a backend's own error can quote the command it ran.

Revised 2026-10-24 (agent-driven demo takes, spec
`docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md` §8,
§9; no frame, proof or sealing changed, and the vectors are the same). Four
ops, on the Windows backend only; every other backend answers
`capability_unavailable` ("recording and browser launch are Windows only in
D1"):

The service runs as LOCAL SERVICE and cannot know the user's
`%LOCALAPPDATA%` or `PATH`, so the helper, which runs as the user, resolves
every user-side path itself. The service sends names; the helper places them.

- `probe_report` (and `probe_changed`'s `data`) carries
  `"recorder": { "ffmpeg": <absolute path> | null }`: the `ffmpeg.exe` the
  helper found once at startup by walking its own `PATH` in order (only
  when `PATHEXT` lists `.exe`; relative entries skipped; no shell). `null`
  when there is none, and on every backend but Windows. The service keeps
  an absolute path of 1 to 1024 characters with no control characters, and
  `null` otherwise.
- `launch_browser` `{ exe, profile, args? }` → `{ pid, cdp: { port, path } }`.
  `exe` is an `.exe`, re-resolved as `launch`'s is (`path_changed`).
  `profile` is a name matching `^[A-Za-z0-9_-]{1,64}$`; the helper creates
  `%LOCALAPPDATA%\KingLouie\browser-profiles\<profile>` (the user's) and
  uses it as the profile. `args` are strings, and none may name the switch
  `user-data-dir`, `profile-directory`, `remote-debugging-port`,
  `remote-debugging-address` or `remote-debugging-pipe` (one or two dashes,
  the name before any `=`, without case): Chromium keeps the last of a
  repeated switch. Any of these wrong is `invalid_params`, and nothing is
  started. The helper removes a stale `DevToolsActivePort` from the
  profile, starts `exe` detached with `--user-data-dir=<profile dir>
  --remote-debugging-port=0 --no-first-run --no-default-browser-check` and
  then `args`, and reads `DevToolsActivePort` every 200 ms for up to 10 s
  for an integer port and a `/devtools/browser/<id>` path. When none comes
  it kills the browser and answers `browser_launch_failed`. The service
  attaches over CDP at `http://127.0.0.1:<port>`; `close` with the pid ends
  it.
- `record_start` `{ ffmpeg?, take_id, path?, fps?, size? }` →
  `{ pid, startedAt, path }` (`startedAt` in ms on the helper's clock;
  `path` is the file being written). `take_id` matches
  `^take-[0-9a-f]{12}$`. Without `path` the helper writes
  `%LOCALAPPDATA%\KingLouie\recordings\<take_id>\take.mp4` (creating the
  directory); a given `path` must be absolute and is used as it is (the
  service has checked it against the session's working directory), and the
  helper creates its directory, since the service cannot create the user's
  directories. A directory that cannot be made is `recorder_failed`. Without
  `ffmpeg` the helper uses its `recorder.ffmpeg`; with neither the answer is
  `recorder_missing`. It runs ffmpeg (an `.exe`) as the user: `-y -f
  gdigrab -framerate <fps, 30> -i desktop`, then `-vf scale=<w>:<h>` when
  `size` (even integers) is given, `-c:v libx264 -preset veryfast -crf 23
  -pix_fmt yuv420p -an -movflags +faststart <path>`. A bad parameter is
  `invalid_params`; a failure to start is `recorder_failed`.
- `record_stop` `{ pid }` → `{ path, durationS, bytes, truncated }`. The
  helper writes `q` to ffmpeg's stdin and waits up to 15 s for it to exit,
  else kills it and says `truncated: true`. `bytes` is the file's size (0
  when there is none). An ffmpeg that had already exited answers
  `exited: true` and its `code` too (`truncated` unless the code was 0). An
  unknown pid is `unknown_recording`.
- `keep_awake` `{ on }` → `{ on }`: `SetThreadExecutionState` in the worker
  (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED` on,
  `ES_CONTINUOUS` off). It lasts while the worker runs.
- 30 s after the service connection closes, the helper stops every live
  recording as `record_stop` would; a reconnect within 30 s keeps them. A
  helper that stops (logout, exit) stops them first, and waits for any stop
  already under way. Nothing deletes a recording's file.
- These four, like `input`, are answered and logged by their code alone:
  their errors could quote the argv, a path or ffmpeg's output. ffmpeg's
  stderr is drained and never read or logged.

## 6. Vectors

`tests/vectors/session-v1/`, rebuilt by `generate.js`: `handshake` (proofs and
keys), `sealed-frames` (both directions), and the rejections `reject-seq-skip`,
`reject-seq-replay`, `reject-wrong-direction-key`, `reject-tampered-tag`.

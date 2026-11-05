# window-v1: the seal between a window and a node

A remote King Louie window reaches a node through a front door that splices
bytes between two WebSocket legs. This protocol runs inside that splice, so the
front door reads nothing past the clear first message and can change nothing
without one side closing. The local tab's loopback handshake
(`kl.desktop.hello.v1`) is a different protocol and is unchanged.

The Node implementation is `src/desktop-bridge/window-seal.js`. The vectors are
`tests/vectors/window-v1/`; `tests/window-vectors.test.js` runs them.

## 1. Canonical bytes

- Every message is one binary WebSocket message, and a handshake message has one
  exact length. A host calls `next` once per message, in the order they arrived.
- A seal owns the one ordered writer: `write(bytes)`, given when it is built. Every
  message it makes (handshake messages, frames' records, pings, pongs, a close
  record) reaches `write` in the tick it was made, so the counters' order is the
  wire's however a host awaits `next`. `next` returns only `{ frames, close, ready,
  peer }`. `write` returns a promise settled when the socket has taken the bytes.
- Integers are big-endian. `‖` is concatenation. Every field is fixed width, so
  no concatenation below can be read two ways.
- `session` is the session id's 32 bytes. The front door mints the id as 32 random
  bytes and gives it to each side in canonical base64url (43 characters); a seal
  refuses any other form when it is built.
- A device id is `kld-` and a node id `kl-`, each followed by the first 16
  characters of lowercase, unpadded RFC 4648 base32 of SHA-256 over the raw 32-byte
  Ed25519 key. So a device id is 20 ASCII bytes and a node id 19.

## 2. The handshake

One round trip, identities in clear so the front door's audit can name the device.

| Message | Bytes | Layout |
|---|---|---|
| `hello_w` (window to node) | 86 | `0x01 ‖ 0x01 (version) ‖ eW (32) ‖ device_id (20) ‖ pub_dev (32)` |
| `hello_n` (node to window) | 148 | `0x02 ‖ eN (32) ‖ node_id (19) ‖ pub_node (32) ‖ sig_node (64)` |
| `auth_w` (window to node) | 65 | `0x03 ‖ sig_dev (64)` |

`eW` and `eN` are X25519 public keys, generated fresh for every session.

```
sig_node = Ed25519(node_sk, "kl-window-v1\nnode\n"   ‖ session ‖ hello_w ‖ hello_n[0..83])
sig_dev  = Ed25519(dev_sk,  "kl-window-v1\nwindow\n" ‖ session ‖ hello_w ‖ hello_n)
```

`hello_n[0..83]` is the 84 bytes before `sig_node`.

**The window, on `hello_n`**, in this order: exact length and first byte;
`node_id` is `pub_node`'s id; `pub_node` equals the pin, if it holds one (else it
closes with the reason `node_key_changed`); `eN` is not its own `eW`; `sig_node`
verifies; X25519 gives a nonzero secret. Only then does it sign and send `auth_w`.
It is ready once `auth_w` is out. It holds its frames until the node's first record
arrives, which also keeps a node's raw-byte cut (section 5) from counting them.

A window with no pin takes the key the handshake proved and reports it as
`peer.publicKey`. Nothing here makes that key trusted; enrollment does, and a window
holds it unpersisted until then.

**The node, on `hello_w`**: exact length, first byte and version; `device_id` is
`pub_dev`'s id; X25519 gives a nonzero secret. It then answers `hello_n` whether it
knows the device or not, so the answer does not say who is enrolled.

**The node, on `auth_w`**: exact length and first byte; it looks up `device_id`,
synchronously, and requires the stored key to equal `pub_dev`; it verifies `sig_dev`
against the stored key, or against `pub_dev` for an unknown device, so an unknown
device costs the same. It sends no record until this has passed.

Each signature covers the session id, both ephemeral keys and both identities, and
the two domain strings differ. So a swapped key, a message reflected to its sender,
a handshake replayed into another session and a session moved to another id each
fail a signature or a check above, before any record.

A message that arrives while a signature is pending closes: the other side is
waiting for what is being signed, so nothing legitimate can arrive.

**Ed25519.** A signature is exactly 64 bytes and a key exactly 32. A verifier must
refuse S at or above the group order, so one signature has one encoding; OpenSSL's
does, and a test pins it. It does not refuse a small-order public key, for which a
crafted signature verifies over any message. Such a key is only ever its holder's own
(an id is derived from its key), so the handshake gains nothing from refusing it, but
enrollment must not store one.

## 3. Keys

```
ss    = X25519(eW, eN)
salt  = SHA-256(session ‖ hello_w ‖ hello_n)
k_w2n = HKDF-SHA256(ikm = ss, salt, info = "kl-window-v1 w2n", 32)
k_n2w = HKDF-SHA256(ikm = ss, salt, info = "kl-window-v1 n2w", 32)
```

Forward secrecy comes from the ephemeral keys: a seal drops its X25519 private key
once the secret is agreed, overwrites its copy of the secret once the keys are
derived, and overwrites its copies of the keys when it closes. These are the JS
buffers only; what the runtime or OpenSSL copied is out of its reach. There is no
rekey; a session is reconnected instead.

## 4. Records and padding

```
record    = 0x10 ‖ counter (8) ‖ ct ‖ tag (16)
ct ‖ tag  = ChaCha20-Poly1305(key_dir, nonce = 0x00000000 ‖ counter, plaintext, aad = 0x01 ‖ dir ‖ counter)
plaintext = kind (1) ‖ len (4) ‖ bytes ‖ zeros
```

`dir` is `0x00` window to node (`k_w2n`) and `0x01` node to window (`k_n2w`). Each
direction counts from 0, one per record, and every record must carry exactly the
next counter. A direction whose counter has reached 2^64 - 1 ends: it never wraps.
Keys are per session, so no nonce repeats across reconnects.

| kind | meaning | `len` | pads to |
|---|---|---|---|
| `0x00` | final (or only) piece of a bridge frame | 0 to `RECORD_MAX`; 1 or more when it ends a run | see below |
| `0x01` | a piece of a frame, more follow | exactly `RECORD_MAX` | 4096 |
| `0x20` | ping | 0 | 256 |
| `0x21` | pong | 0 | 256 |
| `0x30` | close; `bytes` is a 4-byte code a socket can send: 1000 to 1003, 1007 to 1014, 3000 to 4999 | 4 | 256 |

`RECORD_MAX` is 1048576 and bounds `bytes`, not the record. The longest record on
the wire is 1052697 bytes; the shortest is 281, and every length is 25 plus a
multiple of 256.

**Padding.** The zeros bring `len(plaintext)` to the smallest multiple of 256 when
the whole frame is under 65536 bytes, else of 4096. Every piece of a frame in more
than one record uses 4096, its last piece too. A receiver checks, under a good tag,
that the plaintext is exactly the length the rule gives for this kind and `len`,
and that every padding byte is zero. So each frame has one encoding.

Records are alike in length only up to a block: every frame of 0 to 251 bytes gives a
281-byte record, and a frame of 252 bytes gives a longer one.

**Large frames.** A frame over `RECORD_MAX` goes as a run of `0x01` records and one
`0x00`; a frame of exactly `RECORD_MAX` is one record. A frame may be at most 64 MiB
(`LIMITS.frameBytes`). Over that it is refused at the sender (`PAYLOAD_TOO_LARGE`)
before a counter moves, and closes `4400` at a receiver, on the run that would pass
it, before the piece is held. Pings, pongs and a close may fall between the pieces of a frame; another
frame may not.

**Backpressure.** `createFrameSender` is the only way a frame is sent. It encrypts a
record only when it may be written, and keeps at most `highWater` bytes of records
unconfirmed by the socket (default four of the longest). A `write` that returns no
promise ends it `SEND_NO_BACKPRESSURE`. It refuses `SEND_QUEUE_FULL` once more than
`maxQueuedBytes` (default 128 MiB) of frames wait behind that, and the caller closes
the session.

**Before opening.** A record's length, first byte and counter are checked before any
decryption, and `len` is read only after the tag holds.

## 5. Heartbeat and close

A side pings after 20 s (`PING_MS`) in which it sent nothing, and answers a ping with
a pong, keeping at most one pong the socket has not taken: further pings get none
until it has. After 60 s (`SILENCE_MS`) in which it received no record it closes
`1001`, reason `silence`, and the window reconnects. The timers are ref'd.

A seal not ready `LIMITS.handshakeMs` (10 s) after it was built closes `4408`, on both
roles, on a ref'd timer. A host must also cap the seals not yet ready, counted from
`window.open`: the seal cannot see the others.

A close that no `next` call is there to return (the deadline, a write that failed)
goes to `onClose(close)`, given when the seal is built. `destroy()` is for a socket
that has gone: it ends the seal and clears the timer, with nothing said.

Failures send nothing: the caller closes the socket with the code. A close record is
for a side that chooses to end a session in good order. After it, or after any
failure, that seal sends and opens nothing more.

**A socket close code is unauthenticated.** Only a close record is authenticated. Any
socket close, whatever its code, is a drop: a front door can forge `4401` or `4403`,
or cut a session short. A frame's tail can be dropped this way, and it looks like a
socket drop, never like a frame. No socket code may clear a pin or an enrollment.

**What a host sets on a sealed socket.** `SOCKET_OPTIONS`: `maxPayload` is
`RECORD_WIRE_MAX` (1052697) and `perMessageDeflate` is false, since a record does not
compress and inflating spends memory on a peer's say. Text frames are refused.
Before ready, the socket is cut after `PRE_READY_BYTES` (8192) raw bytes, counted as they
arrive, so an oversized message is never buffered to be refused.

## 6. What the front door sees

The clear `hello_w`, `hello_n` and `auth_w`: both ephemeral public keys, the device
and node ids and keys, and the signatures. After them, record lengths, their timing,
their direction and the counters. Not the plaintext, and not a key.

Padding hides small differences only: within one block, frames look alike, while a
long reply still looks long. Sizes and timing remain visible, and this protocol does
not try to hide them.

## 7. Codes

| Code | Reason | When |
|---|---|---|
| `4401` | `handshake` | Any failure before ready, on either side: a length, a first byte, a version, an id that is not its key, a key that gives no secret, a signature, a different session id, an unknown device, a device whose stored key differs. |
| `4401` | `node_key_changed` | The window only: `pub_node` differs from the pin. It tells the window's own tab, and says nothing the peer did not send. |
| `4400` | `record` | Any failure after ready: a length, a first byte, a counter, a tag, an unknown kind, a `len` or padding off the rule, a close code a socket cannot send, a run over the limit. |
| `4408` | `handshake` | Not ready in 10 s. |
| `1001` | `silence` | 60 s with no record. |
| `1001` | `write` | A write failed: the socket has gone. |
| the sender's | `peer` | The peer's close record. |
| the caller's | `local` | This side's own close record. |

A node gives one code and one reason for every failure before ready, so an
unauthenticated peer learns only that it failed.

Local errors, thrown to the caller and never sent: `SEAL_INVALID`, `SEAL_NOT_READY`,
`SEAL_CLOSED`, `SEAL_BUSY`, `PAYLOAD_TOO_LARGE`, and from the sender
`SEND_QUEUE_FULL`, `SEND_STOPPED` and `SEND_NO_BACKPRESSURE`.

## 8. Vectors

`tests/vectors/window-v1/`, built from `keys.json` by `generate.js` (`--check` says
`15 vectors match`), each `{ name, consumers, given, input, expect }`; byte fields are
base64url, and ephemerals are `sha('window epk ' + label)`. `generate.js` builds the
handshake and keys from this document, apart from the seal, and fails if the seal
differs.

| Vector | Pins |
|---|---|
| `handshake-ok` | The three messages, what each side signed, both signatures, the secret, the salt, both keys. |
| `handshake-wrong-session` | The node signed another session id; the window signed another: `4401` each. |
| `handshake-wrong-node-key` | The pin differs: `4401 node_key_changed`, and `auth_w` is never produced. |
| `handshake-unknown-device` | `hello_n` is answered anyway; `auth_w` is `4401`, also for a stored key that differs. |
| `handshake-reflected` | Each message back to its sender, and the window's own ephemeral under a real node signature: `4401`. |
| `handshake-truncated` | Short, long and empty messages: `4401`. |
| `record-roundtrip` | A 100-byte frame is one 256-padded record, 70000 bytes 4096-padded, 1.5 MiB two records, and one frame the other way. |
| `record-tampered` | One byte flipped: `4400`, and the next record does not open. |
| `record-replayed` | The same record twice: `4400`. |
| `record-reordered` | A later counter first: `4400`, and the right one no longer opens. |
| `record-wrong-key` | The other direction's key, the other direction's aad, another session's key: `4400`; the right key opens. |
| `record-unknown-kind` | A kind off the table, under a good tag: `4400`. |
| `record-oversized` | A `len` past the plaintext under a good tag, and a wire length over the longest: `4400`. |
| `record-bad-close-code` | 1004, 1005, 1006, 1015, 2000 and 2999 in a close record: `4400`; 4403 closes with that code. |
| `close-record` | The bytes of a close record; the code arrives, and nothing opens after it. |

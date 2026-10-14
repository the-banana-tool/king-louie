# Local Inference, Stage L1: Local Servers, the Private Mark and the Recall Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One implementer per task.

**Goal:** King Louie can run model calls on a server the owner runs (this machine or the LAN) and can promise it. The owner adds a local server, the app checks and pins its address and probes its models, and the owner places them in profile roles. A chat or a case marked private, and a role marked local-only, make no model call that leaves the owner's hardware: the call goes to a local model or is refused. Local calls cost $0 and are marked local. Four LongHaul adapters measure recall jobs on a local model and change no product default.

**Architecture:** One new provider key, `local`, with model ids `<serverId>/<model>`; a registry (`LocalServers`) that owns the entries, their pinned addresses and their probe results; a transport that dials only a pinned address. One value, the **egress policy**, says a call may not leave: it is read from the chat's or case's mark when a turn's models are snapshotted, frozen into `TurnModels`, and checked in four places (the resolver filters, the router refuses, a hosted provider refuses, the transport pins). Callers that never pass the router are changed one by one and listed in an inventory test that fails when a new one appears. **The order of the tasks keeps the guarantee from ever being half on:** the checks and every bypassing caller land first (Tasks 3, 8, 9, 10, 12, 13); the IPC that lets an owner set a mark lands after them (Task 14).

**Tech Stack:** Node 24 (`node:http`, `node:https`, `node:dns`, `node:net` `BlockList`, `node:sqlite`, `node:test`), Electron 41 (renderer). No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-13-local-inference-design.md` (e1d17ba), stage L1: §5 to §13 and §15 to §19, with the owner's decisions R-LI-1 to R-LI-33 (§2, §3). Stage L2 (§14) gets its own plan after L1; nothing here builds it, and Task 5 leaves its seam (spec §14.1).

**Another stage is being built at the same time.** Cases stage 8 (branch `feat/cases-c8`, spec `2026-10-13-cases-stage8-verified-progress.md` on `spec/cases-c8`) adds a verify pass at turn close that calls the `verify` role, a `Progress` case tool, new `.kl/` files, and case panel and MCP changes. Files both stages edit: `src/cases/case-runtime.js`, `src/cases/roles.js`, `src/cases/turn-runner.js`, `src/cases/case-store.js`, `src/ipc/chat-handlers.js`, `src/ipc/case-handlers.js`, `src/cases/mcp-tool-definitions.js`, `src/mcp/case-tools.js`, `renderer.js`, `index.html`, `preload.js`, `src/ipc/constants.js`, `src/core/create-core.js`, `CLAUDE.md`, `tests/cases-store-yaml.test.js`. **L1 is rebased on stage 8 before Task 12**, the first task that edits `src/cases/`. Tasks 1 to 8, 10, 11 and 16 to 18 touch none of the case files; Task 9 edits `src/ipc/chat-handlers.js` in three small places and is rebased like any other conflict. If stage 8 has not merged when Task 11 is done, L1 waits at Task 12 (Tasks 16 to 18 can go on). **Stage 8's verify pass is one more model call the private check must cover**; Task 12 has a test for it.

## Task order: what is sequential and what may run in parallel

"In parallel" means in separate worktrees with **no file in common**; the groups were made from each task's file list.

| Step | Tasks | Why |
|---|---|---|
| A | **1, 2, 3 and 4 in parallel** | 1: `src/models/local-address.js`. 2: `src/models/local-transport.js`, `src/providers/base-provider.js`. 3: `src/models/egress.js`, `src/models/resolver.js`. 4: `src/history/{schema,history-store,rows,link-index}.js`. No shared file, no dependency on each other |
| B | **5 → 6 → 7 → 8 → 9 → 10, one after another** | 5 needs 1 and 2; 8 needs 3, 4 and 5. All but 6 edit `src/core/create-core.js`; 5 and 8 edit `inference-router.js`; 5 and 6 edit `local-servers.js` |
| C | Beside B, **two streams**: (i) **17 → 18** as soon as 1 and 2 are merged into their base; (ii) **11**, once 8 is merged | (i) edits only `src/longhaul/`, `bin/longhaul.js` and their tests. (ii) edits `src/tracking/`, `inference-router.js` (after 8 is done with it) and `local-server-provider.js` |
| D | **Rebase on cases stage 8**, then **12 → 13 → 14 → 15, one after another**; **16** beside them once 11 is merged | 12 to 15 edit the case files, the handlers and the renderer in turn. 16 edits `src/models/{roles,resolver,local-servers}.js` and `local-server-provider.js`, none of which 12 to 15 touch |
| E | **19 → 20**, after everything above | 19 runs the whole e2e suite; 20 is the stage's close and the one full `npm test` |

**Nothing that lets an owner set a mark exists before Task 14.** Keep the branch unmerged until Task 14 is in, or merge steps A to D as one stage. Before Task 14 the only way to mark a chat is to call `HistoryStore#markPrivate` from a test.

## Deviations

Where the code as built differs from a task's text. Added by each task's implementer in the task's own commit.

**Task 1** (all stricter than the text, none looser):

- `gradeOf` does not trust `pinned.class`: it runs `checkPinned` on the whole `pinned` and grades from the class the stored **addresses** give. A pin with no `addresses`, with an address that is no longer allowed, or whose stored `class` is not the one its addresses give is `cost-only`. Callers pass the entry's full `pinned`, never `{ class }` alone. An unknown `protocol` is `cost-only` too.
- `checkPinned` returns `LOCAL_PIN_INVALID` (a new code) for a pin with no addresses or with a stored `class` that differs from the recomputed one; an address that is not allowed is `LOCAL_ADDRESS_PUBLIC` as written.
- `classifyAddress` answers `public` for an address with a zone id that is not link-local (`::1%lo0`, `fd12::1%eth0`): a zone belongs to link-local only, and what cannot be vouched for is not local. `fe80::1%eth0` is `link-local`.
- `parseBaseUrl` also refuses, as `LOCAL_URL_INVALID`: a space or control character anywhere (the URL parser would drop a tab or newline), a `\` (read as `/`), a `%` (decoded in a host; also refuses a zone id), a `.` or `..` path segment, any `@`, an empty query or fragment (`/?`, `/#`), and a value that is not a string. A path is allowed (`http://127.0.0.1:8080/api`). A number spelling of an IPv4 host (`2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`, `127.0.0.1.`) is not refused: the URL parser turns it into the dotted address, which is then what is classified, stored in `href` and dialled.
- `resolveAndPin` stores canonical addresses (`canonicalAddress`, also exported: an IPv4-mapped address as its IPv4 address, IPv6 lower case and compressed) and keeps a repeated answer once. A lookup answer that is not an IP literal is refused under `LOCAL_ADDRESS_PUBLIC` with `class: 'invalid'` in `refused`; a lookup that throws is `LOCAL_ADDRESS_UNRESOLVED` with the `cause`. `allowCgnat` counts only when it is exactly `true`.
- Extra exports: `canonicalAddress`, `isTlsFingerprint` (64 hex characters), used by the transport.

**Task 2:**

- **No `lookup` function; the socket is opened to the pinned IP literal.** Node never calls a `lookup` for a host that is already an IP literal, so with the text's design a base URL whose host is an IP literal would have been dialled as written, whatever was pinned. The transport's agent (one `http.Agent` subclass, for http and https both) makes its own connections in `createConnection`: `net.connect({ host: <pinned address> })`, then the remote-address check, then for https `tls.connect({ socket, servername, host: <the typed name> })` and the certificate check, and only then hands the socket to the request. A connection refused by either check has received no byte of the request (tested: the server sees no request at all, not only no body).
- The hidden test hook is therefore `_connect` (stands in for `net.connect`), not `_lookup`; a second hidden hook `_ca` gives the https tests a test CA for the no-fingerprint path. Neither is for callers.
- **What the later policy reads:** the returned object is frozen and carries `baseUrl`, `protocol`, `addresses` (canonical, frozen), `addressClass`, `tlsPinned` and `grade` (`gradeOf` over the transport's own address, protocol and fingerprint). Task 5's `isGuaranteeTarget` should read `transportFor(id).grade`, so the grade describes the thing that dials. A fingerprint on an `http:` URL pins nothing (`tlsPinned: false`, `cost-only` off loopback).
- `createLocalTransport` throws `LOCAL_TRANSPORT_INVALID` for a base URL `parseBaseUrl` refuses, an empty address list, an address that is not an IP literal or does not classify as loopback, LAN or CGNAT (the per-server CGNAT opt-in is the registry's check, Task 5), a fingerprint that is not 64 hex characters, or a bad `maxConcurrent` / `connectTimeoutMs`.
- More codes: `LOCAL_BODY_UNSUPPORTED` (a body that is not a string, `Buffer` or `Uint8Array`), `LOCAL_TRANSPORT_CLOSED` (after `close()`, also for calls that were waiting). `LOCAL_URL_OUTSIDE` also covers a URL with a user name or password and anything that is not an absolute URL. `LOCAL_REDIRECT` carries `status`; every 300 to 399 is refused, 304 included, and that connection is not reused.
- A connect timeout is `LOCAL_UNREACHABLE` with a `cause` whose code is `ETIMEDOUT`; the timeout covers TCP and TLS together. When several addresses are pinned the next is tried only after one of the unreachable codes; a mismatch or a TLS failure ends the call.
- The transport sets `Host`, `Content-Length` and `Accept-Encoding: identity` itself (it does not decompress) and drops a caller's `Host`, `Connection`, `Transfer-Encoding` and `Proxy-*` headers.
- A slot is free when the reply has **ended** (or failed, or was aborted), not when the caller has read it. A reply the server never ends holds its slot until the call's signal aborts, so every caller passes one.
- One retry, not in the text: a request that fails `ECONNRESET` on a kept-alive socket before any reply is sent once more on a new connection (the usual stale keep-alive race).
- `local-transport.js` requires `./local-address` (the two tasks are no longer independent of each other; they were built one after the other).
- **Proxy variables (spec assumption A1): holds** on Node 24.13.0. The test's control (the same URL through `node:http`'s global agent in the same child) goes to the test's proxy; the transport's call does not. On a Node older than 24 the control is reported but not required to hit the proxy.

**Task 3:**

- **Only `null` / `undefined` is "no policy".** `createTurnModels({ egress })` and `targetAllowed` read any other value that is not a policy object (`false`, `true`, `''`, `{}`, a string) as an unreadable mark and restrict under an `unknown-mark` policy (`normalizePolicy`, exported). A caller with no policy passes `null` or leaves the key out. Likewise a `localOnly` that is not an array (and not null) makes every role local-only.
- A `local-only-role` policy carries the role: `{ localOnly, reason, chatId, caseId, role }`. The `role` key is present only on that reason; the other three policies have exactly the four keys the text gives. `egressPolicy` takes `role` as a fourth, optional field.
- `targetAllowed` is asked for the `local` provider only: a registry that answers `true` for an `ollama` or hosted target is not believed. `isGuaranteeTarget` throwing, or answering anything that is neither `true` nor a non-empty string, refuses with "<target> is not a local model the guarantee accepts and this chat is private." Sentences for the other reasons: "… and this case is private.", "… and this chat's private mark could not be read, so it is treated as private."
- **`candidatesFor(role)` is filtered under the role's policy too**, with the same borrow rule (the text names `resolve` only). Its callers (`ensureTargetsTested` in the core and the case runtime, the default-provider previews) would otherwise send a connection test to a hosted provider for a private turn. `configuredFor` still returns the profile's list as written.
- A policy is the **asking** role's and is carried through a borrow and a custom role's fallback; the role that lends its list never changes it (a `utility` call that borrows a local-only `worker`'s list is not local-only; a local-only custom role stays local-only through its fallback).
- `imageGeneration` under a policy: an `explicit` target is refused too, a local one included (no local server generates images in L1), and `candidatesFor('imageGeneration')` is empty. The one skipped entry's `target` is the role's first configured target, or `{ provider: 'settings', model: 'imageGeneration', effort: null }` when the role is empty, so code that labels a skipped target has one. Under a local-only role the reason reads "Image generation is not available on a local model."
- Under a policy `mustResolve` always throws the policy's code, also when the role's local targets exist but `explain` says none is usable (a server that is down): the message lists them under "Skipped:" and ends "Nothing was sent to a hosted model."
- `egress.js` also exports `refusalSubject(policy, role)` (the opening of that message), for Task 8's wording.

**Task 4:**

- **`chatRefs()` / `chatRef()` on a store that is not `privacyAware` give `private: true` for every chat**, as `isPrivate` does there (the mark cannot be read). Such a store is only ever a read-only file opened with `allowOlderSchema` (a desktop import's source). A file below step 5 cannot hold a marked chat, so code that copies chats out of one (Task 14's import) checks `store.privacyAware` before it reads `private` as a mark.
- `isPrivate` is also `true` for an id that is not a string, for a stored value other than 0, and when the read throws (one warning, with the error's message and no chat id or text). `markPrivate` returns `{ marked: false, droppedVectors: 0 }` for such an id and throws on a store below schema 5 as it does on a read-only one.
- `createChat`'s `private` option counts only when it is exactly `true`. `{ private: false }` over the id of a private chat keeps the mark. `upsertChat(chat, { private: true })` marks only a chat it creates; over an existing chat it changes nothing. A chat that is **deleted** takes its mark with it: a later chat under the same id starts unmarked (`isPrivate` is `true` in between, the id being unknown).
- The hosted vectors are matched with `substr(model, 1, 6) <> 'local:'`, not `LIKE`: `LIKE` ignores case and `isLocalKey` does not. `vectorEpoch` moves after the transaction commits, and only when a row was deleted.
- The step's SQL (`SCHEMA_V5_SQL`) lives in `link-index.js` beside step 4's; the mark's methods are in `history-store.js`. The store's truncation method is `truncateFrom` (`truncateChatFrom` is the facade's).
- The "delete throws" test makes the database refuse the delete with a trigger instead of stubbing a statement, so the rollback tested is SQLite's own.
- **Tests changed outside the task's file list**, each because it pinned the latest version or rebuilt an older file by hand: `tests/history-embeddings-store.test.js` (asserts 5; its downgrade to version 2 drops the `private` column first, or step 5 fails on a duplicate column), `tests/history-index.test.js` (asserts 5), `tests/history-links-store.test.js` (asserts 5 in three places, two test titles reworded; the `chatRefs` / `chatRef` rows it compares gain `private: false`). No assertion was weakened or removed.

**Task 5:**

- **`local` is not registered in `ProviderFactory`**, and `provider-factory.js` is unchanged. Four tests on `main` say the factory holds exactly the 14 (`models-catalog`, `models-default-ids`, `models-provider-pricing`, `providers-fake-server`) and build every registered provider from a key alone; a `local` provider that can be built without a pinned transport is the thing this stage must not have. Only `LocalServers#providerFor` builds one, and the constructor throws `LOCAL_TRANSPORT_REQUIRED` without a transport (it never falls back to `fetch`). `explainTarget` has its own `local` branch before the "registered outside the 14" one. Consequence, fail closed: a `node.yaml` `delegate.provider: local` is refused as an unknown provider (`delegate-sessions.js` checks the factory's list).
- **`Catalog#price('local', id)` is $0 only for a server the registry holds and may use**, not for every id under the key: the registry gives the catalog a check (`Catalog#setLocalServerCheck`, set in `LocalServers`' constructor). An id with no `<server>/` prefix, a server nobody registered, a server that failed its checks, a catalog with no registry and a check that throws all price `null` (unpriced), like any unknown model. `LocalServerProvider` sets `costUsd: 0` on its own calls itself, as written.
- More reasons an entry is `usable: false` than the text lists: no `markedLocalAt`; two entries with one id (neither is used); a URL whose host is an IP literal with a pin that is not exactly that address; a name that is not one line of at most 80 characters; `maxConcurrent` outside 1 to 64. The listed entry holds the canonical URL (`parseBaseUrl`'s `href`) and canonical addresses. `getEntries` answering something that is not an array is an empty list.
- New code `LOCAL_SERVER_UNUSABLE`: what `transportFor` / `providerFor` throw, and what `explain` answers, for an entry that failed its checks (`LOCAL_SERVER_UNKNOWN` is kept for a server that is not there). `explain`'s result carries `code` beside Availability's four keys when it refuses.
- `list()` builds each usable entry's transport (no socket is opened by that), so `grade` is always the transport's own; an entry whose transport cannot be built is unusable. A transport is closed when its entry changes or goes, which ends the calls on it. After `close()` the registry lists nothing.
- `isGuaranteeTarget` answers `true` only for a target object whose `provider` is exactly `'local'` (no trimming, no case folding).
- `LocalServerProvider` also takes `kind` (the cloud-id check needs it); with no kind a cloud id is refused as on Ollama. A model that does not start with this server's `<serverId>/` is refused `LOCAL_SERVER_UNKNOWN` before any request. A call is recorded under the id the target named, not the name the server reports for itself. `costUsd` is 0 on a stopped call that reported nothing too (spec §9.1 rule 1: 0 exactly when `local` is present). `embed` strips the prefix as the chat calls do.
- Router: the "this provider's key was rejected, skip its other models" set is keyed like the instances (`local:<serverId>`), so a key one local server rejects does not skip another server. `prepareProvider` and `onProviderError` still get the provider key (`local`). The core hands the router `null` as the `local` token (`getDecryptedProviderToken('local')` would throw "No token saved"); a server's key is `__local_<id>` in `apiTokens`, read by the registry.
- `classifyError` reads `LOCAL_UNREACHABLE` straight after the cancellation rule, before the TLS and text rules (the text says "before rule 9").
- **Not done, and in no task's text:** spec §6.4's "an entry's `timeoutMs` replaces the role timeout when larger". The value is validated and listed; nothing applies it yet.
- The core's wiring is tested in `tests/inference-router-local.test.js` (`local servers in the core`).

**Task 6:**

- **An Ollama server is listed with one `/api/tags` call, and `/api/show` is asked per model only when that model is probed**, not through `discoverOllama` (which shows every model on every listing, drops the `digest` the record stores, and reads a missing capability list as "no images" where the record needs `unknown`). `local-probe.js` exports `discoverModels` (`[{ id, cloud, context, digest }]`) beside `listModels` (the ids).
- Limits the text does not give: a listing is at most 500 models, 4 MB and 20 s; a model id must be one plain line of at most 200 characters (others are dropped); a probe reply is read to at most 256 KB. A reply over the cap fails its step.
- `probeModel` sends through `provider.request` (the server's `LocalServerProvider`, so the transport and the server's key) when it is given a provider, else through `fetch`. The tool step also sends `temperature: 0` and `max_tokens: 256`; the smoke step sends no `stream_options`, the same request shape the provider's own stream sends, so `usageReported` says what a real call will see. **For Task 11:** a server that reports stream usage only when asked (`stream_options.include_usage`) reads `usageReported: false`, and its calls will be estimated.
- What an Ollama server says about tools (`/api/show` `capabilities`) is used one way only: when the tool step fails and the server said "no tools", the record says `no`; a server that says "tools" with a failed tool step stays `unknown`.
- **`ensureTargetsTested` calls `localServers.ensureProbed(targets)`**, which lists a server once and probes only the models the role names (`refresh(id, { only })`), not every model the server holds: a turn does not wait while models it will not use are loaded. A listing that fails is not asked for again on a turn's behalf for 60 s, and a model the server's list did not hold is not asked about again. Skipped under `KL_TEST_MODE`.
- **Nothing lists or probes at start.** The probe file is read when the core is built (no request); `startModelsBackgroundChecks` is unchanged. A model is probed when a server is added (Task 7), when a turn first uses it, or when the owner asks.
- A probe whose steps all failed is still a record (with `error` and `probedAt`) and is not retried by itself: `toolCall: 'unknown'`, never `yes`. A probe cut off by shutdown or by its entry changing is not stored.
- `probe(id, model)` lists the server first and refuses a model that is not in the list (`LOCAL_MODEL_NOT_LISTED`) or a cloud id (`LOCAL_CLOUD_MODEL`). `explain` says "not in the server's list" only for a list fetched in this process (the list is not stored; the records are), and answers `LOCAL_MODEL_UNFIT` for a capability the call needs. An owner override that says the model calls tools (`models.overrides`, spec §6.5) lifts a probed `no`.
- A record has one optional key more than the text: `imageInputSource: 'owner'`, so an owner-entered image input survives a new probe as the owner-entered context does. A stored record is read back field by field (`readRecord`): a value that is not what the field holds becomes `unknown` or null, and other keys are dropped.
- A record for a server that is not configured, or is unusable, stays in the file and out of the catalog.
- **`src/models/catalog.js` is edited (not in the task's file list):** an override for `local:<id>` loses its `cost` and `local` keys, and is ignored when the registry put no such entry in the catalog (an override makes no local model).
- **For later tasks:** the catalog entry's `toolCall` is true only for a probed `yes` (as written), so `capabilitiesOf(catalog, 'local', id).toolCalling` is false for a model whose probe was `unknown`, while `explain` does not refuse it a tool job.

## Owner rulings (2026-10-13)

Each row names the tasks that carry the ruling and the tests that pin it (file › test name; the tests are written by the task named). Rulings that belong to L2 only are listed so nobody looks for them here.

| Id | Ruling (short) | Carried by | Pinned by |
|---|---|---|---|
| R-LI-4 | A local server is any OpenAI-compatible server the owner adds and marks local | Tasks 5, 7 | `local-servers › R-LI-4: an entry of each kind is spoken to at <baseUrl>/v1/chat/completions`; `models-ipc-local › R-LI-4: adding is the mark` |
| R-LI-5 | Local is the mark plus an address check; the address is pinned; a public one is refused | Tasks 1, 2, 5 | `local-address › R-LI-5: every public spelling is refused`; `› R-LI-5: a name with one public answer is refused`; `local-transport › R-LI-5: only a pinned address is dialled`; `› R-LI-5: a socket on another address is destroyed`; `› R-LI-5: a 3xx is refused`; `› R-LI-5: a proxy in the environment is not used` |
| R-LI-6 | Service: only the admin `service.json`. Desktop: only the app's own UI, never a tool | Task 7 | `service-config-local › R-LI-6: localInference in the data-dir service.json is ignored with one warning`; `local-servers-config › R-LI-6: setSettings cannot add, change or remove a local server`; `models-ipc-local › R-LI-6: add is refused LOCAL_SERVER_ADMIN_ONLY in service mode`; `› R-LI-6: add is refused for an event that is not the local window's` |
| R-LI-7 | Probe once, place by hand | Task 6 | `local-probe › R-LI-7: context, tool calling and the smoke call are recorded`; `› R-LI-7: a probed model is not probed again` |
| R-LI-8 | The guarantee, fail closed, for a local-only role and a private chat or case, on every model call | Tasks 3, 8, 9, 10, 12 | `egress-resolver › R-LI-8: a hosted target is skipped under a policy`; `egress-router › R-LI-8: a hosted target under a policy never reaches fetch`; `egress-core › R-LI-8: a hosted provider refuses under a policy`; `egress-callers › R-LI-8:` one test per row of spec §7.5; `egress-inventory › every file that can send is listed`; `cases-private-models › R-LI-8:` orient, judge, classify, draft, verify, a wake-up, ingest |
| R-LI-9 | Tools behave as now | Tasks 9, 15 | `egress-callers › R-LI-9: WebSearch and WebFetch run in a private chat`; `renderer-private › R-LI-9: the composer line names tools` |
| R-LI-10 | One-way, at any time; what was sent stays sent; hosted vectors dropped and rebuilt locally | Tasks 4, 10, 14 | `history-private-store › R-LI-10: no method clears the mark`; `› R-LI-10: marking deletes every vector that is not local:, in the same transaction`; `private-mark-ipc › R-LI-10: the confirmation counts what was already sent`; `› R-LI-10: nothing unmarks` |
| R-LI-11 | A private chat is in no non-private chat's scope; a private chat may read another | Task 10 | `history-private-scope › R-LI-11: refused under linked and all`; `› R-LI-11: a private chat reads a private chat`; `› R-LI-11: SearchHistory and ReadHistory follow` |
| R-LI-12 | A local model that is down: failover and a note without the mark; a clear failure with it | Tasks 5, 8, 11 | `inference-router-local › R-LI-12: an unreachable local server fails over at once`; `egress-router › R-LI-12: under a policy the call fails LOCAL_MODEL_UNAVAILABLE and no hosted request is made`; `local-usage › R-LI-12: failoverFrom names the local target` |
| R-LI-13 | Tokens counted, $0, marked local; the case budget is not charged; nothing else becomes $0 | Tasks 5, 11, 12 | `local-usage › R-LI-13: local is set only by the local provider`; `› R-LI-13: an ollama call is $0 and not local`; `› R-LI-13: an unknown hosted model is still null`; `cases-private-models › R-LI-13: a local call charges usd nothing and counts no unpriced tokens` |
| R-LI-14 | Four LongHaul adapters; no default without a run | Tasks 17, 18 | `longhaul-local-client › …`; `longhaul-local-adapters › R-LI-14: …`; `history-settings` (the existing defaults test, unchanged) |
| R-LI-15 | Adapters: the seam only | Task 16 | `local-adapter-seam › R-LI-15: a target with an adapter sends the adapter's ref`; `› R-LI-15: a stale adapter makes the target unusable` |
| R-LI-21 | The three accepted residuals | Tasks 7, 15 (the dialogs' sentences), 20 (docs) | `renderer-local-servers › R-LI-21: the add dialog says a forwarding server cannot be detected` |
| R-LI-22 | No local model for a role: borrow among local models; skip an optional job; refuse a load-bearing one | Tasks 3, 8, 9, 12 | `egress-resolver › R-LI-22: utility borrows a local worker, never a hosted one`; `egress-callers › R-LI-22: a title is skipped`; `egress-core › R-LI-22: the turn is refused before any call`; `cases-private-models › R-LI-22: a wake-up with no local model is a failed wake-up` |
| R-LI-23 | One mark, on the case; its chats follow | Tasks 12, 14 | `cases-private-models › R-LI-23: a case chat is private exactly when its case is`; `private-mark-ipc › R-LI-23: marking a case chat marks the case and every chat of it`; `case-private-attach › R-LI-23:` three tests |
| R-LI-24 | Executors as now; the card adds the private line | Task 13 | `cases-private-surfaces › R-LI-24: the envelope card and the delta card carry the line`; `› R-LI-24: an executor submits in a private case` |
| R-LI-25 | Private chats embedded only by the embed worker, alongside a hosted embedder | Task 10 | `history-private-embeddings › R-LI-25: a hosted key is never given a private chat's chunks`; `› R-LI-25: the keep-local embedder fills them`; `› R-LI-25: the query is embedded locally or not at all` |
| R-LI-28 | Export with a warning and a carried flag; import adds the mark, never removes it; no chat text in new log lines | Tasks 14, 15, and every task's log lines | `history-import-private › R-LI-28: an export that says private is imported private`; `› R-LI-28: an export cannot clear a mark`; `egress-inventory › R-LI-28: the new modules log no message text` |
| R-LI-29 | `100.64.0.0/10` per server, by confirmation | Tasks 1, 7 | `local-address › R-LI-29: refused without allowCgnat, allowed with it`; `service-config-local › R-LI-29: allowCgnat is an admin key` |
| R-LI-30 | Plain `http` on a LAN is for cost only | Tasks 1, 3, 5 | `local-address › R-LI-30: gradeOf`; `local-servers › R-LI-30: a LAN http server is not a guarantee target`; `egress-resolver › R-LI-30: a cost-only local target is skipped under a policy` |
| R-LI-31 | The built-in Ollama provider stays and is never local; one action converts it | Tasks 5, 7 | `egress-resolver › R-LI-31: an ollama target is skipped under a policy`; `models-ipc-local › R-LI-31: fromOllama adds a server, and on the second call rewrites profile targets` |
| R-LI-32 | Memory read, never written; `delegate` refused; MCP gives id, title, status | Tasks 9, 13 | `egress-callers › R-LI-32: delegate is refused PRIVATE_NO_DELEGATE`; `egress-inventory › R-LI-32: nothing under a chat turn calls capture`; `cases-private-surfaces › R-LI-32: open_case and get_orientation on a private case` |
| R-LI-33 | Images refused; read-aloud on the system engine | Task 9 | `egress-callers › R-LI-33: ImageGenerate is refused PRIVATE_HOSTED_CALL`; `› R-LI-33: read-aloud uses the system engine` |
| R-LI-16 to 20, 26, 27 | L2 | The L2 plan | |

## New questions

Found while writing the tasks out. Each is built the fail-closed way until the owner rules.

- **N1. A run created from a private chat that belongs to no chat.** `Cron` (creating a job), `SessionsSpawn` and `RemoteDispatch` start a run on a session, on the default profile, with no chat (`CronExecutor`, the gateway's `agent:message`, `create-core.js`). A job created in a private chat would later run the prompt a local model wrote from private text on a hosted model. Options: (a) refuse these three tools in a private chat; (b) let the created job or session carry the mark, so its runs are local or refused (a new field on cron jobs and sessions, and the snapshot reading it); (c) treat them as tools under R-LI-9. **Built: (a)**, code `PRIVATE_NO_DETACHED_RUN` (Task 9). Recommendation: (a) for L1, (b) if the owner wants scheduled work in private chats.

## Global Constraints

- Tests run with node's built-in runner, never `jest`: `node --test tests/<file>.test.js`; look for `# fail 0`. Each task runs only the test files its steps list. **The full `npm test` runs once, in Task 20, by the controller.** The e2e suite runs once, in Task 19.
- **No task before Task 14 adds an IPC channel, a CLI command, a tool parameter, a settings key or an import field that sets a private mark or a `localOnly` role.** A test in Task 8 (`egress-core › nothing outside tests can mark yet`) greps for it until Task 14 removes that test.
- **Fail closed.** A mark that cannot be read is treated as private. A target that is not known to be a guarantee-grade local target is treated as hosted. A registry that cannot be read has no local server. No code path falls back to a hosted model under a policy.
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` covers every new file. `src/longhaul/` may require `src/models/`, `src/history/`, `src/providers/`; nothing else in `src/` requires it.
- Log through `createLogger` from `src/logging.js`. **New log lines carry ids, counts, model names, addresses and codes, never message, prompt or reply text** (R-LI-28). A probe's reply sample is stored, never logged.
- No network and no real model in unit tests. A local server in a test is `tests/helpers/fake-llm-server.js` or a `node:http` server on `127.0.0.1`; an address that must be refused is never dialled; DNS is an injected `lookup`. Models are configured with `tests/helpers/profile-settings.js`.
- Every provider request goes through `BaseLLMProvider#request`; never call `fetch` in a provider. `src/models/local-transport.js` is the only new module that opens a socket.
- Prices come only from `Catalog#price`. `costUsd: 0` is set only for provider `local` and, as today, for a non-cloud `ollama` id; an unknown hosted model stays `costUsd: null`.
- Schema changes are new `SCHEMA_STEPS` entries; steps 1 to 4 are released and never edited.
- No `history.recall` default changes (R-LI-14). Tests that check a mechanism pin their settings.
- Open source: invented values only (`workstation`, `gpu-box.example.com`, `127.0.0.1`, `qwen3:8b` as a model id, `Lakeside lot`); no personal names, machines, paths or domains. `examples/` may show only loopback, `0.0.0.0`, the documentation IP ranges and `example.com` hosts (`tests/helpers/example-denylist.js`); the documentation ranges are public, so they appear in tests only as addresses that are refused.
- Renderer: every server name, model id, address, probe sample, case or chat title is set with `textContent`, never `innerHTML` or markdown. IPC replies that carry one have `untrustedText: true`.
- Anchors in this plan are quoted names, not line numbers; find them with a search.
- Commit after each task with the message its last step gives, ending with the attribution line the session's instructions give.

## Review Focus

1. **A model call that never asks.** A new caller of `fetch`, a provider constructor or an embedder that takes no egress policy. Expected: `tests/egress-inventory.test.js` fails until the file is listed with a label, and a `gated` file must mention `egress`. Pinned: Task 9.
2. **A snapshot without its chat.** `snapshotModels({})` or `snapshotModels({ profileId })` for work that belongs to a chat. Expected: a child run takes its parent's policy; a run with a chat id and no parent takes the chat's; a profile switch for a child never drops the parent's policy. Pinned: Task 8.
3. **Failover to a hosted model.** A private chat whose local server is down, a role list with a hosted target after a local one, a main override, "Retry with…", a `SpawnAgent` model. Expected: no hosted request, ever; `LOCAL_MODEL_UNAVAILABLE` or `PRIVATE_NO_LOCAL_MODEL`. Pinned: Tasks 3, 8.
4. **The address.** A name that resolves differently later, a v4-mapped or NAT64 spelling, a redirect, a proxy variable, `169.254.169.254`. Expected: refused when added, never dialled later. Pinned: Tasks 1, 2.
5. **Who can configure.** A settings save from any path, `/llm`, a desktop import, a paired desktop in service mode. Expected: none adds or changes a local server or removes a `localOnly` role. Pinned: Tasks 7, 14.
6. **Hosted embedders and Jev.** A private chat's chunks and its query. Expected: only the `local:` key; Jev skipped with `private-chat`. Pinned: Task 10.
7. **Cases.** A private case's wake-up, ingest, the stage 8 verify pass, a detour's new case, the cross-case index, the MCP surfaces. Pinned: Tasks 12, 13.
8. **$0.** Expected: `local` only from `LocalServerProvider`; the case budget charges nothing for it and counts no unpriced tokens; an `ollama` call and an unknown hosted model are exactly as before. Pinned: Tasks 5, 11, 12.
9. **The half-on window.** Expected: before Task 14 no owner action reaches a mark. Pinned: Task 8's grep test, removed in Task 14.

---

## What exists on `main` (9ec78a3), read from the code

Nothing below is rebuilt by a task.

| Piece | Where | Note for the implementer |
|---|---|---|
| The provider request path | `BaseLLMProvider#request(url, init, options)` (`src/providers/base-provider.js`) | Calls `globalThis.fetch`, puts `options.abortSignal` on it, turns an abort into an `AbortError` with partial metrics |
| An OpenAI-compatible client | `OllamaProvider` (`src/providers/ollama-provider.js`) | `options.baseUrl` is the API base itself; `options.serverUrl` gets `/v1` added |
| Ollama discovery | `discoverOllama({ baseUrl, fetch, signal })` (`src/models/ollama.js`) | Takes an injected `fetch` |
| Local catalog rows | `Catalog#setLocalModels(provider, entries)`, `localEntry(provider, { id, name, context, toolCall, imageInput })` (`src/models/normalize.js`) | `local: true`, zero cost |
| Pricing | `Catalog#price(provider, modelId, usage)`; the `ollama` branch with `LOCAL_OLLAMA_COST`; `isOllamaCloudModelId` | An unknown model returns `null` |
| Targets | `normalizeTarget`, `targetKey`, `targetLabel` (`src/models/roles.js`): `{ provider, model, effort }` | Override keys split at the first colon |
| The resolver | `createTurnModels({ profile, mainOverride, customRoles, explain })` → `{ profileId, profileName, mainOverride, configuredFor, candidatesFor, resolve, mustResolve }`; `NoUsableModelError` (`code`), `borrowChain` | `resolve` returns `{ role, targets, skipped, borrowedFrom, override, explicit, useSettings }` |
| Profiles | `Profiles` (`src/models/profiles.js`): `normalizeProfile`, `update`, `snapshot({ profileId, mainOverride, explain })` | `normalizeProfile` keeps `id`, `name`, `kind`, `roles` |
| The core's model functions | `snapshotModels({ chatId, caseId, profileId })`, `resolveRole(role, { needs, explicit, chatId, caseId, profileId, turnModels })`, `explainTarget`, `createProviderInstance`, `createAgentRuntime(selection, event, approvalRequester, runtimeOptions)`, `agentExecutorAdapter.execute` (`src/core/create-core.js`) | A child gets `turnModels` from `options.approvalRequester.turnModels`; with none, `createAgentRuntime` calls `snapshotModels({ profileId })` with no chat |
| The router | `InferenceRouter#routeTargets(targets, messages, options, state)`, `routedProvider({ targets, signal, meta })`, `newRouteState(tags)`, `callTags`, `_instanceFor(provider, state)` | One instance per provider key per route state |
| Failure classes | `classifyError` (`src/providers/error-classifier.js`), `FailoverPolicy` | `econnrefused` and `enotfound` are `TIMEOUT`: three retries, then `FALLBACK_MODEL` |
| Case model calls | `CaseRuntime#routedProvider(turn, spec)`, `roleModel`, `usageHook(turn)` (`src/cases/case-runtime.js`); `CASE_ROLE_TO_MODEL_ROLE` (`src/cases/roles.js`) | `usageHook` reads `rawCost === 0 && totalTokens > 0` as unpriced |
| Ingest's model path | `createCallModel({ resolveInference, getUsageTracker })` (`src/cases/ingest/call-model.js`); the core passes `resolveInference: ({ provider, model }) => resolveRole('main', { explicit })` | Calls `resolved.provider` directly, not the routed one |
| The direct embedding client | `OpenAIEmbeddingProvider` (`src/memory/embedding-provider.js`), built in `ContextAssembler` when `openaiApiKey` is given; used by `_assembleSemantic` and by `AgentLoop#_semanticCompact` | A bare `fetch` to `api.openai.com`; `_fallbackAll` and the recency compaction exist |
| Images and voice | `ImageGenerate` (`src/tools/builtin/image-generate-tool.js`, reads `context.turnModels`), `src/media/image-generation/`; `TTSEngine` with `engines/elevenlabs.js` and `engines/system-tts.js` | |
| The tool executor | `ToolExecutor` (`src/execution/tool-executor.js`): `this.turnModels`, put on the rethreaded requester | Tools see `context.turnModels` |
| History scope | `resolveScope`, `createScopePolicy({ bridgeOriginFor })`, `HistoryStore#chatRefs`, `chatRef` (`src/history/`) | First matching rule wins |
| Keep-local for imports | `isLocalKey`, `pendingEmbeddings(db, model, { localOnly })`, `countPending`, `KEPT_LOCAL` (`embedding-index.js`); `keepLocalReason(store, chatIds)` (`reranker.js`) | `keepLocalReason` returns `'imported-chat'` or null |
| The embedder | `EmbedderHost` (`current()`, `status()`, `reason()`, `fail()`, `_switch`), `startEmbedIndexer`, `createVectorSearch({ host, index })` | One embedder at a time |
| A store-only chat field | `STORE_ONLY_CHAT_KEYS` (`rows.js`), `HistoryStore#setHistoryScope` | |
| Usage | `buildLlmCallMetrics`, `UsageTracker.eventFromMetrics`, `sumLlmCalls`, `costByRole`, `summarizeTurnLlm` (`src/tracking/`) | |
| Admin config | `ADMIN_ONLY_KEYS`, `parsePlaybooksConfig`, `rejectUnknownKeys`, `loadServiceConfig` (`src/service/config.js`) | |
| Local-window events | `markLocalDesktopEvent` (`src/core/origin.js`) | |
| Secret stores | `SECRET_FILE_PREFIXES` (`src/tools/utils.js`) | `chat-data.json` and `history.sqlite` are refused to every file tool |
| The cross-case index | `IndexStore#search({ …, forCaseId, includePrivate })` (`src/cases/index-store.js`): `redacted`, `text: null` | |
| Case tools | `createCaseToolHandler`, `openCase`, `listCases` (`src/mcp/case-tools.js`); `envelopeQuestionText`, `deltaQuestionText` (`src/cases/executors/envelope.js`) | |
| LongHaul | `FACTORIES` (`src/longhaul/adapters/index.js`), `createModelClient` (`model.js`), `ModelCache` and `STAGES` (`model-cache.js`), `RerankCache`, `createKlRecallRerankAdapter`, `priceCall`, `assertMaySend`, `PROMPTS` (`prompts.js`) | A client with `local: true` is free and exempt from `--send-private` |
| Test helpers | `startFakeLlmServer()` (`tests/helpers/fake-llm-server.js`); `profileSettings`, `everyRole`, `caseRoles`, `withCaseProfile` (`tests/helpers/profile-settings.js`); `tests/helpers/history-fixture.js`, `history-context.js`, `close-history-stores.js`, `fake-embed-runner.js`, `ingest-harness.js`, `test-certs.js`, `longhaul-helpers.js` | |

## File Structure

New, under `src/models/` (Electron-free): `local-address.js`, `local-transport.js`, `egress.js`, `local-servers.js`, `local-probe.js`. New elsewhere: `src/providers/local-server-provider.js`, `src/tools/private-refusals.js`, `src/models/private-facts.js`, `src/longhaul/adapters/{kl-recall-rewrite,kl-recall-abstain-check,kl-recall-llm-rerank,kl-recall-digest}.js`, `src/longhaul/prompts/{rewrite,abstain-check,rerank-llm,digest}-v1.md`, `scripts/smoke-local.js`, `tests/fixtures/egress-inventory.json`.

Modified: `src/providers/{base-provider,inference-router,error-classifier,failover-policy,provider-factory}.js`, `src/models/{resolver,roles,profiles,catalog,provider-ids}.js`, `src/core/create-core.js`, `src/history/{schema,history-store,rows,link-index,scope-policy,embedding-index,embed-indexer,embedder-host,vector-search,reranker,context-builder,search,import-chats}.js`, `src/tracking/{llm-totals,usage-tracker}.js`, `src/context/context-assembler.js`, `src/execution/tool-executor.js`, `src/tools/builtin/image-generate-tool.js`, `src/ipc/{models-handlers,chat-handlers,case-handlers,history-handlers,constants}.js`, `src/service/{config,run}.js`, `src/migration/desktop-import.js`, `src/longhaul/importing.js`, `src/cases/{case-store,case-runtime,turn-runner,index-store,chat-attach}.js`, `src/cases/ingest/call-model.js`, `src/cases/executors/envelope.js`, `src/mcp/case-tools.js`, `src/longhaul/{model,model-cache,prompts,run}.js`, `src/longhaul/commands/run.js`, `src/longhaul/adapters/index.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`, `tests/helpers/{fake-llm-server,profile-settings}.js`, `examples/fleet/gpu-box/service.json`, `package.json` (one script), `CLAUDE.md`, `docs/install-guide.md`.

---

## Task 1: Address classes, and resolve-and-pin

Parallel with Tasks 2, 3 and 4. Spec §5.2, §5.3.

**Files:**
- Create: `src/models/local-address.js`
- Test: `tests/local-address.test.js` (new)

**Interfaces (produces):**
- `classifyAddress(ip) → 'loopback' | 'lan' | 'cgnat' | 'link-local' | 'unspecified' | 'public'`. Throws `TypeError` for a string `net.isIP` rejects. Built on `net.BlockList`. An IPv4-mapped IPv6 address is unwrapped and classified as its IPv4 address. Ranges: loopback `127.0.0.0/8`, `::1`; lan `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`; cgnat `100.64.0.0/10`; link-local `169.254.0.0/16`, `fe80::/10`; unspecified `0.0.0.0`, `::`; everything else public (including `64:ff9b::/96`, `2002::/16`, multicast and the documentation ranges).
- `parseBaseUrl(raw) → { href, protocol, hostname, port, isIpLiteral }`. Throws `LocalAddressError` (`code: 'LOCAL_URL_INVALID'`) unless the protocol is `http:` or `https:`, there is no username, password, query or fragment, and the port is 1 to 65535 (the default port of the protocol when none is written). `href` has no trailing slash. A bracketed IPv6 host loses its brackets in `hostname`.
- `async resolveAndPin(baseUrl, { lookup = dns.promises.lookup, allowCgnat = false, now = () => new Date() } = {}) → { addresses: string[], class, at }`. An IP literal is its own answer; a name is resolved with `lookup(hostname, { all: true })`. **Every** address must classify as `loopback`, `lan`, or (`allowCgnat`) `cgnat`; otherwise it throws `LocalAddressError` with `code: 'LOCAL_ADDRESS_PUBLIC'`, `addresses` (all of them) and `refused` (the ones that failed, with their class). No answer at all is `LOCAL_ADDRESS_UNRESOLVED`. `class` is the widest class among the answers, in the order loopback < lan < cgnat.
- `checkPinned(pinned, { allowCgnat }) → true | LocalAddressError`: re-classifies stored addresses (for start-up).
- `gradeOf({ pinned, protocol, tlsFingerprint }) → 'guarantee' | 'cost-only'` (R-LI-30): `guarantee` when `pinned.class === 'loopback'`, or when the protocol is `https:` and `tlsFingerprint` is 64 hex characters; otherwise `cost-only`.
- `LocalAddressError`, `ADDRESS_CLASSES`.

- [ ] **Step 1: Write the failing tests.** `tests/local-address.test.js`:
  - `R-LI-5: every public spelling is refused`: `classifyAddress` of `198.51.100.7`, `203.0.113.9`, `2001:db8::1`, `64:ff9b::c633:6407`, `2002:c633:6407::1`, `::ffff:198.51.100.7`, `::ffff:c633:6407`, `224.0.0.1`, `ff02::1` is `public`;
  - loopback: `127.0.0.1`, `127.255.255.254`, `::1`, `::ffff:127.0.0.1`; lan: `10.1.2.3`, `172.16.0.1`, `172.31.255.255`, `192.168.1.50`, `fd12:3456::1`, `::ffff:192.168.1.50`; `172.32.0.1` and `192.169.0.1` are public;
  - link-local: `169.254.169.254`, `fe80::1`; unspecified: `0.0.0.0`, `::`; cgnat: `100.64.0.1`, `100.127.255.255`; `100.128.0.1` is public;
  - `classifyAddress('workstation')` throws `TypeError`;
  - `parseBaseUrl`: `http://127.0.0.1:11434/` → href without the slash, port 11434; `https://gpu-box.example.com` → port 443, `isIpLiteral` false; `http://[::1]:8080` → hostname `::1`; each of `ftp://…`, `http://user:pw@127.0.0.1`, `http://127.0.0.1/?a=1`, `http://127.0.0.1/#x`, `http://127.0.0.1:0`, `not a url` throws `LOCAL_URL_INVALID`;
  - `resolveAndPin('http://127.0.0.1:11434')` → `{ addresses: ['127.0.0.1'], class: 'loopback' }` with no `lookup` call (pass a `lookup` that throws);
  - `R-LI-5: a name with one public answer is refused`: a fake `lookup` returning `[{ address: '192.168.1.50' }, { address: '203.0.113.9' }]` → `LOCAL_ADDRESS_PUBLIC`, `refused` holds the second with class `public`;
  - a fake `lookup` returning `['127.0.0.1', '192.168.1.50']` → class `lan`, both addresses kept;
  - `R-LI-29: refused without allowCgnat, allowed with it`: `http://100.64.0.5:8000`;
  - link-local and unspecified literals are `LOCAL_ADDRESS_PUBLIC` with their class named; an empty answer is `LOCAL_ADDRESS_UNRESOLVED`;
  - `R-LI-30: gradeOf`: loopback over http → `guarantee`; lan over http → `cost-only`; lan over https with no fingerprint → `cost-only`; lan over https with 64 hex → `guarantee`; cgnat likewise.
- [ ] **Step 2: Run and see them fail.** `node --test tests/local-address.test.js` — expected: the module is missing.
- [ ] **Step 3: Implement.** No `require` outside `node:net`, `node:dns`. No logging.
- [ ] **Step 4: Run again;** also `node --test tests/electron-boundary.test.js` — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/local-address.js tests/local-address.test.js
git commit -m "feat(models): address classes for local servers, and resolve-and-pin"
```

---

## Task 2: The pinned transport, and `request` through it

Parallel with Tasks 1, 3 and 4. Spec §5.2 rules 4 to 8, §5.4, §9.3.

**Files:**
- Create: `src/models/local-transport.js`
- Modify: `src/providers/base-provider.js` (`request`)
- Test: `tests/local-transport.test.js` (new)

**Interfaces (produces):**
- `createLocalTransport({ baseUrl, addresses, tlsFingerprint = null, maxConcurrent = 2, connectTimeoutMs = 10000 }) → { fetch(url, init) → Promise<Response>, close() }`.
  - `fetch` accepts only a URL whose origin is `baseUrl`'s (else `LOCAL_URL_OUTSIDE`); `init` is `{ method, headers, body, signal }` (a string or `Buffer` body).
  - It uses `node:http` / `node:https` `request` with **its own** `new http.Agent({ keepAlive: true })` (never `globalAgent`) and a `lookup` function that answers from `addresses` only (round-robin on failure). The `Host` header and TLS `servername` are the URL's host.
  - On `socket` `connect` (or `secureConnect`), `socket.remoteAddress` (IPv4-mapped form unwrapped) must be in `addresses`, else the socket is destroyed and the call rejects `LOCAL_ADDRESS_MISMATCH`.
  - A status from 300 to 399 rejects `LOCAL_REDIRECT`; the body is not read.
  - With `tlsFingerprint`, `rejectUnauthorized` is false and the peer certificate's SHA-256 (`getPeerCertificate().fingerprint256`, colons removed, lower case) must equal it, else `LOCAL_TLS_MISMATCH`. Without one, normal verification.
  - `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN` and a connect timeout reject `LOCAL_UNREACHABLE` (`cause` kept).
  - It resolves a web `Response` whose body is `Readable.toWeb(res)`; an abort through `init.signal` destroys the request and rejects with the signal's reason, also while the call waits in the queue.
  - At most `maxConcurrent` requests are open; the rest wait in order.
  - Errors are `LocalTransportError` with `code`; no response or request text in the message.
- `BaseLLMProvider#request`: `const send = this.transport && typeof this.transport.fetch === 'function' ? this.transport.fetch : globalThis.fetch;` — nothing else in `request` changes (the abort handling wraps it as today).

- [ ] **Step 1: Write the failing tests.** `tests/local-transport.test.js`, with `node:http` servers on `127.0.0.1` port 0 (and `tests/helpers/test-certs.js` `selfSigned` for https):
  - a POST with a JSON body gets the server's JSON; a streamed reply (three writes) is read chunk by chunk from `response.body`;
  - `R-LI-5: only a pinned address is dialled`: `baseUrl: 'http://gpu-box.example.com:<port>'`, `addresses: ['127.0.0.1']` reaches the loopback server, and the server saw `Host: gpu-box.example.com:<port>`;
  - `R-LI-5: a socket on another address is destroyed`: `addresses: ['127.0.0.2']` with a `lookup` override test hook that answers `127.0.0.1` (the factory takes a hidden `_lookup` for this one test) → `LOCAL_ADDRESS_MISMATCH`, and the server received no request body;
  - `R-LI-5: a 3xx is refused`: a server answering 302 with `Location` to a second server → `LOCAL_REDIRECT`, and the second server got nothing;
  - `R-LI-5: a proxy in the environment is not used`: spawn `process.execPath` on a small fixture script (`tests/fixtures/local-transport-proxy.js`, new) with `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` pointing at a closed loopback port and `NODE_USE_ENV_PROXY=1`; the script calls the transport against a loopback server whose port it is given and prints the status; expected `200`. (This is spec assumption A1; if it fails on the Node under test, stop and report: do not work around it.)
  - a URL on another origin → `LOCAL_URL_OUTSIDE`;
  - https with the right fingerprint succeeds; with a wrong one → `LOCAL_TLS_MISMATCH`; with none against the self-signed server → a TLS error that is not `LOCAL_UNREACHABLE`;
  - a closed port → `LOCAL_UNREACHABLE`;
  - `maxConcurrent: 1`: the second call starts only after the first ends; aborting the queued call rejects it and the server never sees it; aborting mid-stream ends the server's socket;
  - `BaseLLMProvider#request`: an instance with `transport = { fetch: stub }` calls the stub and not `globalThis.fetch` (stub both); an instance without one calls `globalThis.fetch`; an aborted signal still yields an `AbortError` with `partialLlmMetrics`.
- [ ] **Step 2: Run and see them fail.** `node --test tests/local-transport.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/electron-boundary.test.js` and the existing provider request tests (search `tests/` for `abortSignal` in a file name containing `provider`; run those) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/local-transport.js src/providers/base-provider.js tests/local-transport.test.js tests/fixtures/local-transport-proxy.js
git commit -m "feat(models): a transport that dials only a local server's pinned address; providers send through it when they have one"
```

---

## Task 3: The egress policy in the resolver

Parallel with Tasks 1, 2 and 4. Spec §7.1, §7.2 item 1, §7.3; R-LI-8, R-LI-22, R-LI-30, R-LI-31.

**Files:**
- Create: `src/models/egress.js`
- Modify: `src/models/resolver.js`
- Test: `tests/egress-resolver.test.js` (new); run `tests/models-resolver*.test.js` unchanged

**Interfaces (produces):**
- `egress.js`:
  - `EGRESS_REASONS = ['private-chat', 'private-case', 'local-only-role', 'unknown-mark']`.
  - `egressPolicy({ reason, chatId = null, caseId = null }) → Object.freeze({ localOnly: true, reason, chatId, caseId })`; throws for an unknown reason.
  - `isLocalProvider(provider) → provider === 'local'`.
  - `targetAllowed(policy, target, isGuaranteeTarget) → true | string`: with no policy, `true`. Otherwise `true` only when `isLocalProvider(target.provider)` **and** `isGuaranteeTarget(target) === true`; any other answer is a reason string ("openai/gpt-5.4-mini is not a local model and this chat is private." / "… and <role> is local-only." / the string `isGuaranteeTarget` returned). A missing `isGuaranteeTarget` refuses every target.
  - `refusalCode(policy) → 'LOCAL_ONLY_ROLE_NO_MODEL' | 'PRIVATE_NO_LOCAL_MODEL'`.
- `createTurnModels({ profile, mainOverride, customRoles, explain, egress = null, localOnly = [], isGuaranteeTarget = null })`:
  - the returned object gains `egress` (the turn's policy or null) and `egressFor(role)` (the turn's policy, else a `local-only-role` policy when `localOnly` includes the role, else null);
  - under `egressFor(role)`, a role's candidates are **its own targets that pass `targetAllowed`**; when it has none (whether its own list was empty or all hosted) the borrow chain is walked over each stronger role's allowed targets (R-LI-22). `vision` and a custom role's fallback follow the same rule. Every target dropped goes into `skipped` with its reason, before `explain` is asked;
  - `resolve('imageGeneration')` under a policy never returns `useSettings: true`; it returns no targets and one skipped entry with the reason "Image generation is not available in a private chat.";
  - `mainOverride` and `explicit` are filtered the same way;
  - a resolution carries `egress` (the policy that applied, or null);
  - `mustResolve` under a policy with no targets throws `NoUsableModelError` whose `code` is `refusalCode(policy)` and whose message ends "Nothing was sent to a hosted model." `NoUsableModelError` takes the code as an optional third argument.
- Without `egress` and with an empty `localOnly`, every result is **deep-equal to today's** apart from the two new keys (`egress: null`).

- [ ] **Step 1: Write the failing tests.** `tests/egress-resolver.test.js`, with a fake `explain` that says every target is usable and a fake `isGuaranteeTarget` that accepts `local` targets whose model starts `workstation/` and answers "LAN box answers over plain http on your network." for `lan-box/`:
  - `no policy: every existing resolution is unchanged` (main, worker borrowing main, utility borrowing worker, vision, a custom role, the override, an explicit target);
  - `R-LI-8: a hosted target is skipped under a policy` with its reason; the order of the remaining local targets is kept;
  - `R-LI-31: an ollama target is skipped under a policy`;
  - `R-LI-30: a cost-only local target is skipped under a policy`, with the registry's sentence as the reason;
  - `R-LI-22: utility borrows a local worker, never a hosted one`: utility `[openai]`, worker `[local]`, main `[anthropic]` → utility resolves to worker's local target, `borrowedFrom: 'worker'`; with worker hosted and main `[anthropic, local]` → main's local target;
  - no local target anywhere: `resolve` returns no targets and `mustResolve` throws `PRIVATE_NO_LOCAL_MODEL`;
  - `localOnly: ['utility']` and no turn policy: utility is filtered and throws `LOCAL_ONLY_ROLE_NO_MODEL` when empty; main is untouched; `egressFor('utility').reason` is `local-only-role`, `egressFor('main')` is null;
  - a turn policy wins over `localOnly` for the code (`PRIVATE_NO_LOCAL_MODEL`);
  - the main override: a hosted override under a policy is skipped and `mustResolve('main')` throws the private code, not `MAIN_OVERRIDE_UNUSABLE`;
  - an explicit hosted target under a policy is skipped;
  - `imageGeneration` under a policy: no `useSettings`;
  - no `isGuaranteeTarget` given: every target is refused under a policy.
- [ ] **Step 2: Run and see them fail.** `node --test tests/egress-resolver.test.js`.
- [ ] **Step 3: Implement.** `Profiles#snapshot` is **not** changed here (Task 8 passes `egress`; Task 14 passes `localOnly`).
- [ ] **Step 4: Run again;** also every existing resolver and profile test (`node --test tests/models-resolver.test.js tests/models-profiles.test.js`, or the files a search for `createTurnModels` in `tests/` finds) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/egress.js src/models/resolver.js tests/egress-resolver.test.js
git commit -m "feat(models): an egress policy filters a role's targets to local models and borrows only among them"
```

---

## Task 4: The private column in the history store

Parallel with Tasks 1, 2 and 3. Spec §8.1, §8.4 ("Marking an existing chat"); R-LI-10.

**Files:**
- Modify: `src/history/schema.js` (append step 5), `src/history/history-store.js`, `src/history/rows.js`, `src/history/link-index.js` (`chatRefs`, `chatRef`)
- Test: `tests/history-private-store.test.js` (new), `tests/history-schema.test.js`, `tests/history-rows.test.js`, `tests/helpers/history-fixture.js` (its downgrade helper)

**Interfaces (produces):**
- Step 5: `ALTER TABLE chats ADD COLUMN private INTEGER NOT NULL DEFAULT 0;`
- `store.privacyAware` (schema ≥ 5).
- `store.isPrivate(chatId) → boolean`: the column for a known chat; **`true` for an unknown chat id, and `true` on a store that is not `privacyAware` or is closed** (an unknown mark is private).
- `store.markPrivate(chatId) → { marked: boolean, droppedVectors: number }`: in **one transaction**, sets `private = 1` and deletes from `embeddings` every row of that chat's chunks whose `model` does not start `local:`; then moves `vectorEpoch` when rows were deleted. `marked` is false for an unknown chat or one already private (then nothing is deleted). Throws on a read-only store.
- `store.createChat(chat, { private: true })` creates the chat private. `private` on the chat **object** is ignored.
- `rows.js`: `'private'` joins `STORE_ONLY_CHAT_KEYS`; `rowToChat` does not emit it and drops one found in `meta_json`.
- `chatRefs()` / `chatRef()` rows gain `private: boolean`.
- There is **no** method that sets the column to 0, and `updateChat`, `replaceChat`, the upsert path and `truncateChatFrom` never change it. `createChat` over an existing id (which deletes the old chat) keeps the old chat's mark: a private chat recreated under its id is private.

- [ ] **Step 1: Write the failing tests.** `tests/history-private-store.test.js` on `openTempStore()`:
  - a new store is at schema 5; a version-4 file opens at 5 with every chat `private: false`;
  - `isPrivate` false by default; true after `markPrivate`; `markPrivate` twice returns `marked: false` the second time;
  - `R-LI-10: no method clears the mark`: `updateChat(id, { private: false })`, `replaceChat` with `private: false`, `createChat({ id, private: false, … })` over the id, `truncateChatFrom` — `isPrivate` stays true; and the store's prototype has no method whose source sets `private = 0` (read `history-store.js` and `link-index.js` as text and assert the string is absent);
  - `R-LI-10: marking deletes every vector that is not local:, in the same transaction`: write vectors under `local:Xenova/all-MiniLM-L6-v2` and `openai:text-embedding-3-small` for two chats (use the store method `embed-indexer.js` writes vectors with), mark one: its `openai:` rows are gone, its `local:` rows stay, the other chat's rows stay, `vectorEpoch` moved, `droppedVectors` is the count; a `markPrivate` whose delete throws (stub the statement) leaves the chat unmarked;
  - `createChat(chat, { private: true })` is private from its first row; a `private: true` on the chat object alone is not;
  - `chatRefs()` carries `private`; `rowToChat` output has no `private` key;
  - `isPrivate('missing')` is true; on a read-only store opened with `allowOlderSchema: true` on a version-4 file `privacyAware` is false and `isPrivate` is true.
  Raise the expected latest version to 5 in `tests/history-schema.test.js`; in `tests/history-rows.test.js` add `chatToRow({ title: 't', private: true })` has `meta_json` null. In `tests/helpers/history-fixture.js`, make the downgrade helper drop the column (`ALTER TABLE chats DROP COLUMN private`) before it lowers the version.
- [ ] **Step 2: Run and see them fail.** `node --test tests/history-private-store.test.js tests/history-schema.test.js tests/history-rows.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/history-links-store.test.js tests/history-store-chats.test.js tests/history-embeddings-store.test.js tests/history-migrate-json.test.js tests/desktop-source-history.test.js` — expected `# fail 0`. Fix any test that rebuilt an older file by hand (the H4 plan's Task 1 deviation names the ones that did).
- [ ] **Step 5: Commit.**

```bash
git add src/history/schema.js src/history/history-store.js src/history/rows.js src/history/link-index.js tests/history-private-store.test.js tests/history-schema.test.js tests/history-rows.test.js tests/helpers/history-fixture.js
git commit -m "feat(history): schema step 5: a chat's private mark, one-way, with its hosted vectors dropped in the same transaction"
```

---

## Task 5: The registry, the `local` provider, and one instance per server

After Tasks 1 and 2. Spec §5.1, §5.3, §5.5, §9.1 rule 1, §9.3; R-LI-4, R-LI-12, R-LI-13, R-LI-30, R-LI-31. Carries spec §22 items 6, 7, 11 and 15.

**Files:**
- Create: `src/models/local-servers.js`, `src/providers/local-server-provider.js`
- Modify: `src/models/provider-ids.js` (`LOCAL_PROVIDER = 'local'`), `src/models/catalog.js` (`price`), `src/providers/provider-factory.js` (register `local`), `src/providers/inference-router.js` (`_instanceFor`), `src/providers/error-classifier.js`, `src/providers/failover-policy.js`, `src/core/create-core.js`
- Test: `tests/local-servers.test.js`, `tests/local-server-provider.test.js`, `tests/inference-router-local.test.js` (all new)

**Interfaces (produces):**
- A server entry (spec §5.1): `{ id, name, kind, baseUrl, tlsFingerprint, allowCgnat, maxConcurrent, timeoutMs, pinned: { addresses, class, at }, markedLocalAt }`. `SERVER_ID_RE = /^[a-z][a-z0-9-]{1,39}$/`; `SERVER_KINDS = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'openai-compatible']`.
- `new LocalServers({ getEntries, getToken = () => null, catalog = null, createTransport = createLocalTransport, now })`:
  - `list() → [{ ...entry, grade, usable, problem }]`: an entry whose shape is wrong, whose `pinned` is missing or whose pinned addresses fail `checkPinned` has `usable: false` and a `problem` sentence; it is never dialled. `getEntries` throwing means an empty list and one warning.
  - `get(id)`; `splitModel('workstation/qwen3:8b') → { serverId: 'workstation', model: 'qwen3:8b' }` (split at the **first** slash; null when there is none or the id is not a server id).
  - `isGuaranteeTarget({ provider, model }) → true | string` (R-LI-30): true only for a usable server with grade `guarantee` and a model id that is not `isOllamaCloudModelId` on a `kind: 'ollama'` server.
  - `explain(modelId, { needs }) → { usable, reasons, notes, entry }` in `Availability#explain`'s shape: unknown server (`LOCAL_SERVER_UNKNOWN`), unusable server (its problem), a cloud id (`LOCAL_CLOUD_MODEL`). Model listing and capability checks are Task 6; until then a model on a usable server is usable with the note "not probed".
  - `transportFor(id)` (one transport per server, rebuilt when the entry changes); `providerFor(id)` (one `LocalServerProvider` per server); `apiBase(entry)`: `<baseUrl>/v1`.
  - `close()` closes every transport.
- `LocalServerProvider extends OllamaProvider`: constructor `(apiKey, { baseUrl, transport, serverId, addressClass, catalog })`; `this.transport = transport`; `getProviderName() → 'local'`; `getHeaders()` adds `Authorization: Bearer <key>` only when a key was given; the model sent in a request body is the id **after** the `<serverId>/` prefix; `buildLlmCallMetrics` returns the parent's object with `provider: 'local'`, `model: '<serverId>/<model>'`, `costUsd: 0`, no `unpriced`, and `local: { server: serverId, class: addressClass }`. A cloud id on an Ollama server throws `LOCAL_CLOUD_MODEL` before any request.
- `Catalog#price('local', id, usage)` prices with the zero-cost table (rename `LOCAL_OLLAMA_COST` to `LOCAL_COST`); the `ollama` branch is untouched.
- `InferenceRouter`: `_instanceFor(target, state)` keys the instance map by `target.provider`, or `local:<serverId>` for a `local` target, and calls `this.createProvider(target.provider, this.getProviderToken(target.provider), target)`. Every caller of `_instanceFor` passes the target.
- `classifyError`: before rule 9, an error whose `code` (or whose `cause.code`) is `LOCAL_UNREACHABLE` is `FailoverReason.LOCAL_UNREACHABLE` with `RecoveryAction.FALLBACK_MODEL`; `FailoverPolicy`'s table gets an entry for it with **no retry** (read how `plan` treats a reason with `attempts: 0`, and make the first failure escalate).
- `create-core.js`: build one `LocalServers` with `getEntries: () => getSettings().models?.localServers || []` (Task 7 changes the source in service mode and seals the key); `createProviderInstance(providerType, token, target)` returns `localServers.providerFor(serverId)` for `local`; `explainTarget` asks `localServers.explain` for `local`; `hasProviderCredential('local')` is true; `resolveRole` passes its first target to `createProviderInstance`; the router's `createProvider` passes the target on; `shutdown()` calls `localServers.close()`. Expose `core.context.getLocalServers()`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/local-servers.test.js`: `list` with a good loopback entry (grade `guarantee`), a LAN `http` entry (`cost-only`), a LAN `https` entry with a fingerprint (`guarantee`), an entry whose pinned address is `203.0.113.9` (unusable, never dialled), an entry with a bad id (unusable); `splitModel` on `workstation/hf.co/org/name:tag`; `R-LI-30: a LAN http server is not a guarantee target`; a cloud id on an `ollama` server is not a guarantee target and `explain` says `LOCAL_CLOUD_MODEL`; `getEntries` throwing gives an empty list;
  - `tests/local-server-provider.test.js` against `startFakeLlmServer()` (read the helper for its base URL and dialect paths; use its Ollama `/v1` base): `R-LI-4: an entry of each kind is spoken to at <baseUrl>/v1/chat/completions`; the request body's `model` has no prefix; a streamed reply and a tool call work; `R-LI-13: local is set only by the local provider` (metrics have `local.server`, `costUsd: 0`, no `unpriced`; an `OllamaProvider` call against the same server has `costUsd: 0` and **no** `local`; an OpenAI provider with an unknown model has `costUsd: null`); a key is sent only when configured; Stop mid-stream yields `usagePartial`;
  - `tests/inference-router-local.test.js`: two `local` targets on two servers get two instances; a `local` then an `openai` target: `R-LI-12: an unreachable local server fails over at once` (a closed port; assert the router's injected `sleep` was never called and the hosted fake answered); after a first answer from a local server, failover to the second local server is allowed and to `openai` is `FAILOVER_BLOCKED`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/inference-router*.test.js tests/models-catalog*.test.js tests/error-classifier*.test.js tests/electron-boundary.test.js` (run the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/local-servers.js src/providers/local-server-provider.js src/models/provider-ids.js src/models/catalog.js src/providers/provider-factory.js src/providers/inference-router.js src/providers/error-classifier.js src/providers/failover-policy.js src/core/create-core.js tests/local-servers.test.js tests/local-server-provider.test.js tests/inference-router-local.test.js
git commit -m "feat(models): local servers as the provider \"local\", one instance per server, free and marked local; an unreachable one fails over at once"
```

---

## Task 6: The probe and the catalog

After Task 5. Spec §6; R-LI-7.

**Files:**
- Create: `src/models/local-probe.js`
- Modify: `src/models/local-servers.js`, `src/core/create-core.js` (probe file path, start-up load), `tests/helpers/fake-llm-server.js`
- Test: `tests/local-probe.test.js` (new)

**Interfaces (produces):**
- `listModels(server, { fetch, signal }) → string[]`: `kind: 'ollama'` → `discoverOllama({ baseUrl, fetch })` ids; other kinds → `GET <baseUrl>/v1/models`, `data[].id`. A failure throws with the status; nothing is guessed.
- `probeModel(server, model, { provider, fetch, timeoutMs = 60000 }) → record` (spec §6.1): `{ probedAt, context, contextSource: 'server' | 'owner' | 'unknown', toolCall: 'yes' | 'no' | 'unknown', imageInput: 'yes' | 'no' | 'unknown', stream, usageReported, firstTokenMs, tokensPerSecond, sample, digest, adapters: [], error }`. The tool step sends one tool named `ok` with no parameters and the text "Call the ok tool."; the smoke step sends "Reply with the word ok." with `max_tokens: 8`. `sample` is the first 40 characters of the smoke reply. Each step's failure sets its field to `unknown` and records `error`; the probe never throws.
- `LocalServers`: `probes` (read from and written to `<dataDir>/models/local-probes.json`, shape `{ version: 1, models: { '<serverId>/<model>': record } }`, atomic write); `async refresh(id)` lists the server's models and probes each one that has no record; `async probe(id, model)` probes again; `setModelInfo(id, model, { context, imageInput })` (owner-entered, `contextSource: 'owner'`); after each change `catalog.setLocalModels('local', entries)` with `localEntry('local', { id: '<serverId>/<model>', context, toolCall: record.toolCall === 'yes', imageInput: record.imageInput === 'yes' })`.
- `explain` now also says: the model is not in the server's list; `needs.toolCall` and `toolCall: 'no'`; `needs.imageInput` and not `'yes'`; `needs.minContext` above a known context. An unprobed model on a reachable server is probed by `resolveRole`'s existing "test before use" step: extend `ensureTargetsTested` in `create-core.js` to call `localServers.refresh(serverId)` for `local` targets that have no record.
- A cloud id is listed with `cloud: true`, is never probed and never enters the catalog.
- `fake-llm-server.js` gains (read its request router first and add beside the Ollama routes): `GET /v1/models`; a mode switch per model name for a tool-call reply, a text-only reply to a tool request, a reply without usage, and a delayed first token.

- [ ] **Step 1: Write the failing tests.** `tests/local-probe.test.js`: `R-LI-7: context, tool calling and the smoke call are recorded` for an Ollama-kind and an `openai-compatible` server; a model that answers a tool request in text is `toolCall: 'no'` and `explain({ needs: { toolCall: true } })` refuses it; a server that reports no usage → `usageReported: false`; `R-LI-7: a probed model is not probed again` (count the fake server's requests across two `refresh` calls); a cloud id is listed, not probed, not in `catalog.list('local')`; `setModelInfo` survives a restart (a second `LocalServers` on the same file) and is not overwritten by `refresh`; a probe file that is not JSON is read as empty with one warning; the probe record and the log hold no text beyond `sample` (capture the logger); `models.overrides` for `local:<id>` cannot change `cost` or `local` (assert through `catalog.get`).
- [ ] **Step 2: Run and see them fail.** `node --test tests/local-probe.test.js`.
- [ ] **Step 3: Implement.** A probe never runs under `KL_TEST_MODE` unless the test calls it.
- [ ] **Step 4: Run again;** also `node --test tests/local-servers.test.js` and every test file that requires `fake-llm-server` (search `tests/`) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/local-probe.js src/models/local-servers.js src/core/create-core.js tests/helpers/fake-llm-server.js tests/local-probe.test.js
git commit -m "feat(models): each local model is probed once for context, tool calling and a smoke call, and enters the catalog"
```

---

## Task 7: Who may configure a local server

After Task 6. Spec §5.6, §13.1 to §13.3; R-LI-6, R-LI-29, R-LI-31. Carries spec §22 item 10.

**Files:**
- Modify: `src/models/local-servers.js` (`add`, `remove`, `recheck`, `fromOllama`, `write`), `src/core/create-core.js` (the sealed key; the service source), `src/ipc/models-handlers.js`, `src/ipc/constants.js`, `preload.js`, `src/service/config.js`, `src/service/run.js`
- Test: `tests/local-servers-config.test.js`, `tests/models-ipc-local.test.js`, `tests/service-config-local.test.js` (all new)

**Interfaces (produces):**
- `LocalServers` takes `writeEntries` (absent in service mode). `async add({ id, name, kind, baseUrl, tlsFingerprint, allowCgnat, maxConcurrent, timeoutMs }, { lookup })` validates, runs `resolveAndPin`, stores the entry with `pinned` and `markedLocalAt`, then `refresh(id)`; `remove(id, { references })` refuses (`LOCAL_SERVER_IN_USE`, with the list) while a profile target names one of its models; `async recheck(id, { lookup, confirm = false })` returns `{ previous, resolved, changed }` and stores the new pin only with `confirm: true`; `async fromOllama({ id = 'ollama-local', rewrite = false })` adds a `kind: 'ollama'` server at `settings.models.ollama.baseUrl` and, with `rewrite: true`, returns the list of `{ profileId, role, from, to }` it applied through `Profiles#update` (`ollama/<m>` → `local/<id>/<m>`, cloud ids left alone). Without `writeEntries` each of these throws `LOCAL_SERVER_ADMIN_ONLY`.
- **The sealed key.** In `create-core.js`, the function every caller uses to save settings keeps the stored `models.localServers` whatever it was passed; `LocalServers`' `writeEntries` is the only code that replaces it (through an inner setter that is not on `core.context`). Write a comment at the seal naming this plan.
- IPC (`IPC.MODELS_LOCAL_*`): `models:local.list`, `.add`, `.remove`, `.recheck`, `.probe`, `.setModelInfo`, `.fromOllama`. The four that write act only on an event the local window's wrapper marked (find how `markLocalDesktopEvent`'s mark is read in `src/core/origin.js` and use that reader); any other event gets `{ ok: false, code: 'NOT_LOCAL_WINDOW' }`. Replies carry `untrustedText: true`. Errors are `{ ok: false, code, error }` with the codes of spec §13.6. `preload.js` exposes them under `window.electron.models.local`.
- `service.json`: `parseLocalInferenceConfig(raw, file)` → `{ servers: [...] }`; known server keys `id`, `name`, `kind`, `baseUrl`, `addresses`, `tlsFingerprint`, `allowCgnat`, `maxConcurrent`, `timeoutMs`, `key`, `adapters`; unknown keys rejected with `rejectUnknownKeys`; an IP literal in `baseUrl` or `addresses` is classified at load and a public one stops the load; a host name is **not** resolved at load. `'localInference'` joins `ADMIN_ONLY_KEYS`. `loadServiceConfig` returns it; `run.js` passes it to `createCore` as `deps.localInference`.
- In service mode (`deps.localInference` defined, even with no servers) the core's `getEntries` is the admin list, pinned at `start()` with `resolveAndPin` (or from `addresses`); an entry that fails is left out with one `error` log line naming the server id and the refused addresses. A `models.localServers` in the data-dir settings is ignored with **one** warning per start.

- [ ] **Step 1: Write the failing tests.**
  - `tests/local-servers-config.test.js`: `add` pins and stores; `add` of `http://203.0.113.9:8000` is `LOCAL_ADDRESS_PUBLIC` and stores nothing; `R-LI-6: setSettings cannot add, change or remove a local server` (a core from `tests/helpers/history-context.js` or the lightest core helper the models tests use; save settings with a changed `models.localServers` through `core.context.setSettings` and through the `settings:*` IPC handler the settings pane uses; read back the stored value); `remove` while a profile names a model is refused with the references; `recheck` with a `lookup` that now answers a different LAN address returns `changed: true` and keeps the old pin until `confirm`; `recheck` to a public answer is refused and keeps the pin; `R-LI-31` in `fromOllama`: first call adds, second with `rewrite` changes `ollama/llama3.2` to `local/ollama-local/llama3.2` in every profile and leaves `ollama/gpt-oss:120b-cloud`;
  - `tests/models-ipc-local.test.js`: `R-LI-4: adding is the mark` (`markedLocalAt` set, reply lists the probed models); `R-LI-6: add is refused for an event that is not the local window's`; `R-LI-6: add is refused LOCAL_SERVER_ADMIN_ONLY in service mode` (a core built with `deps.localInference`), while `.list` and `.probe` answer; the channels are classified `proxy` by `src/desktop-bridge/allowlist.js` (they ride the `models` domain);
  - `tests/service-config-local.test.js`: a valid block loads; an unknown key is the standard unknown-key error; `R-LI-6: localInference in the data-dir service.json is ignored with one warning`; `R-LI-29: allowCgnat is an admin key` (a `100.64.0.5` literal loads only with it); a public literal stops the load; a host name loads without a lookup; a core started with a host-name server and an injected `lookup` answering a public address starts, lists no local server, and logged one error.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** Add no `/llm` action. Make `src/migration/desktop-import.js` drop `models.localServers` from what it carries (search it for the settings keys it copies; add a line to its test if one lists them).
- [ ] **Step 4: Run again;** also `node --test tests/service-config*.test.js tests/models-ipc*.test.js tests/desktop-bridge-allowlist*.test.js tests/examples.test.js` (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/local-servers.js src/core/create-core.js src/ipc/models-handlers.js src/ipc/constants.js preload.js src/service/config.js src/service/run.js src/migration/desktop-import.js tests/local-servers-config.test.js tests/models-ipc-local.test.js tests/service-config-local.test.js
git commit -m "feat(models): only the app's own window adds a local server on the desktop, and only the admin service.json in service mode"
```

---

## Task 8: The policy through the core and the router

After Tasks 3, 4 and 7. Spec §7.1, §7.2 items 2 to 4, §7.3; R-LI-8, R-LI-12, R-LI-22. Carries spec §22 items 1, 2 and 16.

**Files:**
- Modify: `src/core/create-core.js`, `src/models/profiles.js` (`snapshot` passes `egress` and `isGuaranteeTarget` through), `src/providers/inference-router.js`, `src/providers/base-provider.js`
- Test: `tests/egress-router.test.js`, `tests/egress-core.test.js` (new)

**Interfaces (produces):**
- `create-core.js`:
  - `egressFor({ chatId = null, caseId = null }) → policy | null`: the chat's row (`historyStore.isPrivate(chatId)`, Task 4: unknown is private) gives `private-chat`; the chat's `caseId` or the given one is asked through `readCasePrivate(caseId)`, which is `() => false` until Task 12 wires the case runtime, and gives `private-case`. Any throw gives `egressPolicy({ reason: 'unknown-mark' })`. Exposed as `core.context.egressFor`.
  - `snapshotModels({ chatId, caseId, profileId, egress })`: the policy is the given `egress` (a parent's) or `egressFor({ chatId, caseId })`; passed to `profiles.snapshot` with `isGuaranteeTarget: (t) => localServers.isGuaranteeTarget(t)`.
  - `createAgentRuntime`: `runtimeOptions.turnModels` is used as today when there is no `sel.profileId`. Otherwise the new snapshot is `snapshotModels({ profileId: sel.profileId || null, chatId: runtimeOptions.chatId || null, egress: runtimeOptions.turnModels?.egress || null })`. A child can never have less policy than its parent.
  - `resolveRole` returns `egress: resolved.egress`, passes it to `inferenceRouter.routedProvider({ targets, meta, egress })`, and **when `egress` is set returns the routed provider as `provider`** (so a caller that uses `resolved.provider` directly is behind the router too). `createRoutedProvider` on the context takes `egress`.
- `InferenceRouter`: constructor option `isGuaranteeTarget`; `newRouteState(tags, egress = null)` keeps it; `routedProvider({ targets, signal, meta, egress })`. In `routeTargets`, before `_instanceFor`: when `state.egress`, a target that is not `local`, or for which `isGuaranteeTarget(target) !== true`, throws an error with `code: 'PRIVATE_HOSTED_TARGET'` — outside the retry and failover handling, so the loop never moves to another target. The call options handed to the provider carry `egress: state.egress`. When every local target failed under a policy, the error thrown is wrapped with `code: 'LOCAL_MODEL_UNAVAILABLE'` and a message that names the last server and ends "…so nothing was sent to a hosted model."; `cause` keeps the original.
- `BaseLLMProvider#request`: `if (options && options.egress && !this.transport)` throw an error with `code: 'PRIVATE_HOSTED_CALL'` before any `fetch`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/egress-router.test.js`, with a `globalThis.fetch` stub that fails the test if called and a fake local server: `R-LI-8: a hosted target under a policy never reaches fetch` (a list `[openai]` handed to `routeTargets` with a policy → `PRIVATE_HOSTED_TARGET`; a list `[local, openai]` whose local server is down → `LOCAL_MODEL_UNAVAILABLE`, no fetch); a cost-only local target under a policy → `PRIVATE_HOSTED_TARGET`; `R-LI-12: under a policy the call fails LOCAL_MODEL_UNAVAILABLE and no hosted request is made`; without a policy the same list fails over to the hosted fake; the provider receives `options.egress`; a hosted provider instance called with `options.egress` throws `PRIVATE_HOSTED_CALL` and the stub was not called;
  - `tests/egress-core.test.js`, on a real core with a temp data dir (close with `closeOpenHistoryStores()`), a fake local server added by writing the settings before the core is built, profiles from `profileSettings`, and chats marked through `core.context.getHistoryStore().markPrivate(id)`:
    - `snapshotModels({ chatId })` of a private chat has `egress.reason === 'private-chat'`; of an ordinary chat `null`; of a chat id the store does not know, a policy;
    - `R-LI-22: the turn is refused before any call`: `resolveRole('main', { chatId })` with only hosted models throws `PRIVATE_NO_LOCAL_MODEL`;
    - `resolveRole` under a policy returns `provider` that is the routed provider (`provider.routed === true`);
    - `a child of a private turn is private`: call `agentExecutorAdapter.execute` (through `core.context.getAgentExecutorAdapter()`) with an `approvalRequester` carrying the parent's `turnModels` and with `profileId` naming a hosted-only profile → refused, no fetch;
    - `a run with a chat id and no parent takes the chat's policy`: `createAgentRuntime({ role: 'worker' }, null, null, { chatId })` for a private chat with hosted-only models → refused (expose `createAgentRuntime` on the context if it is not there);
    - `a workflow started in a private chat`: run the real `WorkflowEngine` (as `tests/history-workflows.test.js` does) from a private chat with a hosted-only profile and assert no fetch. **If the engine does not carry the parent's requester to its tasks, do not patch the engine here: add its tool to Task 9's refusal list and write that in Deviations;**
    - `R-LI-8: a hosted provider refuses under a policy` through `resolveRole`'s result;
    - `nothing outside tests can mark yet`: read every file under `src/ipc/`, `src/tools/`, `src/mcp/`, `src/service/` and `preload.js` as text and assert none contains `markPrivate` or `localOnly`. (Task 14 deletes this test.)
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/egress-resolver.test.js tests/inference-router*.test.js tests/models-core*.test.js tests/history-core.test.js tests/history-workflows.test.js` (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/core/create-core.js src/models/profiles.js src/providers/inference-router.js src/providers/base-provider.js tests/egress-router.test.js tests/egress-core.test.js
git commit -m "feat(models): a turn's snapshot carries its chat's private mark; the router and every hosted provider refuse under it"
```

---

## Task 9: The callers that bypass the router, and the inventory test

After Task 8. Spec §7.5, §7.6, §7.7, §8.5; R-LI-8, R-LI-9, R-LI-22, R-LI-32, R-LI-33; new question N1. Carries spec §22 items 1 and 13.

**Files:**
- Create: `src/tools/private-refusals.js`, `tests/fixtures/egress-inventory.json`
- Modify: `src/ipc/chat-handlers.js`, `src/context/context-assembler.js`, `src/tools/builtin/image-generate-tool.js`, `src/execution/tool-executor.js`, `src/core/create-core.js` (the automatic read-aloud path; the advisor's provider)
- Test: `tests/egress-callers.test.js`, `tests/egress-inventory.test.js` (new)

**What changes, caller by caller** (each only when the turn's `turnModels.egress`, or `core.context.egressFor({ chatId })`, is set):

| Caller | Anchor | Change |
|---|---|---|
| Semantic context selection | `chat-handlers.js`, the `contextAssembler.assemble` call (search "Context assembly failed") | Pass `{ embed: false }`; `ContextAssembler` then takes `_fallbackAll` without touching `embeddingProvider` |
| Semantic compaction | `chat-handlers.js`, `const embeddingProvider = contextAssembler?.embeddingProvider` | `null` under a policy |
| Chat title | `chat-handlers.js`, the `oneShot(provider, titlePrompt, …)` block | Resolve `utility` from `snapshotModels({ chatId })` (check it does; fix if it snapshots without the chat). A `PRIVATE_NO_LOCAL_MODEL` or `LOCAL_MODEL_UNAVAILABLE` there is caught and the chat keeps its title: no warning toast, one `debug` line |
| Advisor | `src/execution/advisor.js` gets `this.provider` from its creator | Find the creator; the provider must be the turn's routed provider. Change only if it is not |
| Image generation | `image-generate-tool.js`, `roleTarget` and the settings path | `context.turnModels?.egress` (or, with no `turnModels`, `context.egressFor({ chatId: context.chatId })`) → `{ success: false, code: 'PRIVATE_HOSTED_CALL', error: 'Image generation is not available in a private chat: it would send the prompt to a hosted model.' }` before any client is built |
| Read-aloud | `chat-handlers.js` (the `ttsEngine.speak` / `speakSummary` handler) and the automatic `speakSummary` in `create-core.js` | For a private chat with `engine: 'elevenlabs'`, call with `{ ...voiceSettings, engine: 'system' }` |
| Tools that start a run elsewhere | `ToolExecutor`, before a tool's `execute` | `privateRefusal(toolName, params)` from `src/tools/private-refusals.js`: when `this.turnModels?.egress` is set and the tool is listed, the result is `{ success: false, code, error }` with no hook, rule or prompt run |

`src/tools/private-refusals.js` exports `PRIVATE_REFUSED_TOOLS`, a frozen map from tool name to `{ code, message, when? }`. Read each tool's `name` in `src/tools/builtin/` and list: the acting fleet chat tools (`fleet-chat-tools.js`: every tool there that is not a read; `delegate` among them) → `PRIVATE_NO_DELEGATE` (R-LI-32); the cron tool's creating and changing actions, `SessionsSpawn` and the remote dispatch tool → `PRIVATE_NO_DETACHED_RUN` (N1, fail closed); the workflow tool too **if** Task 8's workflow test showed the engine drops the snapshot. `WebSearch`, `WebFetch`, the browser tools, `Bash`, `Message` and the executor tools are **not** listed (R-LI-9).

**The inventory test.** `tests/egress-inventory.test.js` walks `src/**/*.js` except `src/longhaul/` and finds every file matching any of: `\bfetch\(`, `\bhttps?\.request\(`, `new WebSocket\(`, `ProviderFactory\.(create|createProvider|fromEnv)\(`, `new [A-Za-z]*EmbeddingProvider\(`, `\.capture(Success|Failure|Preference)?\(`. `tests/fixtures/egress-inventory.json` maps each such path to `{ "label": "gated" | "no-chat-text" | "tool", "why": "<one line>" }`. The test fails when a matching file is not in the fixture, when the fixture names a file that no longer matches, and when a `gated` file does not contain the word `egress`. Fill the fixture by running the walk once and deciding each file from spec §7.5; `src/memory/memory-manager.js` and `src/ipc/memory-handlers.js` are `no-chat-text` with the why "the Memory pane's own form; no chat turn calls capture".

- [ ] **Step 1: Write the failing tests.** `tests/egress-callers.test.js` on a real core (as `egress-core`), every case with **only hosted models and an OpenAI key configured**, a `globalThis.fetch` stub that records calls and fails the test for any URL that is not the fake local server, and a chat marked through the store:
  - `R-LI-8: the context assembler makes no embedding call` (drive the chat send handler for a private chat with a local main added; assert no call to `api.openai.com`); the same turn in an ordinary chat does call it (so the test would notice a dead path);
  - `R-LI-8: compaction gets no embedding provider` (assert the `AgentLoop` options through the handler's injected loop factory, or spy on `OpenAIEmbeddingProvider.prototype.embed`);
  - `R-LI-22: a title is skipped` with hosted-only `utility`, and made on the local model when `utility` has one;
  - `R-LI-33: ImageGenerate is refused PRIVATE_HOSTED_CALL`; `R-LI-33: read-aloud uses the system engine` (a fake `TTSEngine` records the engine it was asked for);
  - `R-LI-32: delegate is refused PRIVATE_NO_DELEGATE`; `N1: Cron create, SessionsSpawn and remote dispatch are refused PRIVATE_NO_DETACHED_RUN`; in an ordinary chat none is refused by this rule;
  - `R-LI-9: WebSearch and WebFetch run in a private chat` (their own fakes are called);
  - the advisor's provider is the routed one.
  `tests/egress-inventory.test.js` as described, plus `R-LI-32: nothing under a chat turn calls capture` (no file under `src/ipc/chat-handlers.js`, `src/execution/`, `src/cases/`, `src/tools/` matches the capture pattern) and `R-LI-28: the new modules log no message text` (in `local-*.js`, `egress.js`, `local-server-provider.js`, `private-refusals.js`: no `log.` call whose arguments name `messages`, `content`, `prompt`, `text` or `body`).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/egress-core.test.js tests/chat-handlers*.test.js tests/image-generate*.test.js tests/tool-executor*.test.js` (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/tools/private-refusals.js src/ipc/chat-handlers.js src/context/context-assembler.js src/tools/builtin/image-generate-tool.js src/execution/tool-executor.js src/core/create-core.js tests/egress-callers.test.js tests/egress-inventory.test.js tests/fixtures/egress-inventory.json
git commit -m "feat(models): every model call outside the router asks the egress policy, and a test lists every file that can send"
```

---

## Task 10: Recall: scope, embeddings, the query, Jev

After Task 9. Spec §8.3, §8.4; R-LI-10, R-LI-11, R-LI-25. Carries spec §22 items 8 and 9.

**Files:**
- Modify: `src/history/scope-policy.js`, `src/history/embedding-index.js`, `src/history/embed-indexer.js`, `src/history/embedder-host.js`, `src/history/vector-search.js`, `src/history/reranker.js`, `src/history/context-builder.js`, `src/history/search.js`, `src/core/create-core.js` (wiring only)
- Test: `tests/history-private-scope.test.js`, `tests/history-private-embeddings.test.js` (new)

**Interfaces (produces):**
- `createScopePolicy`: a fourth rule, after the three it has. `canRead(reader, source, { explicit })`: a `source.private === true` is refused with `'private-chat'` unless `reader.private === true`; `explicit` does not lift it. `pinnedTo` is unchanged (a private case chat is pinned by the case rule).
- `embedding-index.js`: the `KEPT_LOCAL` condition also keeps a chat whose `chats.private = 1` away from any key not given `localOnly: true`. New option `onlyKeptLocal: true` on `pendingEmbeddings` and `countPending`: only chunks of imported or private chats.
- `EmbedderHost`: `keepLocal() → embedder | null`. When the active embedder's key is `local:`, it is that embedder. Otherwise it is a second `local:` embedder with the default local model (`HISTORY_DEFAULTS.embedder.model`), created on the first `ensureKeepLocal()` call, on the same runner; `status()` gains `keepLocal: { key, state, download }`. It never starts under `KL_TEST_MODE` or before `start()`.
- `startEmbedIndexer`: after its pass for the active key, when that key is not `local:` and `store.countPending(keepKey, { onlyKeptLocal: true, localOnly: true }) > 0`, it calls `host.ensureKeepLocal()` and embeds those chunks under the keep-local key, with the same batch size and tombstone rules.
- `keepLocalReason(store, chatIds)` returns `'private-chat'` when any ref is private (checked before `'imported-chat'`).
- `vectorSearch({ …, keepLocal })`: when `keepLocal === 'private-chat'`, the query is embedded with `host.keepLocal()` and searched under that embedder's name; with none ready, it does not embed and notes `vectorsSkipped: 'private-chat'`. For `'imported-chat'` and null it behaves as today. `ContextBuilder#build` and `search.js` compute `keepLocalReason` once and pass it to both the vector search and the reranker (today only the reranker gets it, and `search.js` only when reranking).
- `create-core.js`: nothing new beyond passing what the builder and the tools already pass; the policy object is already built with `createScopePolicy`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/history-private-scope.test.js` (the fixture store, `resolveScope` with the shipped policy and a `bridgeOriginFor` that returns null): `R-LI-11: refused under linked and all` (an ordinary reader, a private source: excluded with reason `private-chat` under `linked`, absent under `all`); `R-LI-11: a private chat reads a private chat`; a private reader reads an ordinary source; a private case chat is still pinned to itself; marking the source after the link was stored removes it from the next resolve; `R-LI-11: SearchHistory and ReadHistory follow` (the real tools over the fixture, as `tests/history-tools-scope.test.js` does);
  - `tests/history-private-embeddings.test.js` with `FakeEmbedRunner` and a fake hosted embedder whose `embed` records its inputs: `R-LI-25: a hosted key is never given a private chat's chunks` (run the indexer to idle; the hosted fake saw only the ordinary chat's text); `R-LI-25: the keep-local embedder fills them` (rows exist under the `local:` key for the private and the imported chat, and only for them); with the active embedder already `local:`, no second embedder is created; `R-LI-25: the query is embedded locally or not at all` (a turn in a private chat with the hosted fake active: the fake never sees the query; with no keep-local embedder ready, `stats.vectorsSkipped === 'private-chat'` and BM25 still returns excerpts); a turn in an imported, non-private chat still sends the query to the hosted fake (today's behaviour, unchanged); Jev: a scope holding a private chat gives `rerankSkipped` starting `private-chat` and the fake Jev server (`tests/helpers/fake-jev-server.js`) got no request; marking a chat then running the indexer rebuilds its vectors under `local:` (Task 4 dropped the others).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** No `history.recall` or `history.embedder` default changes.
- [ ] **Step 4: Run again;** also `node --test tests/history-scope-policy.test.js tests/history-imports-local.test.js tests/history-embed-indexer.test.js tests/history-jev-reranker.test.js tests/history-cross-chat-recall.test.js tests/history-settings.test.js tests/egress-inventory.test.js` — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/history/scope-policy.js src/history/embedding-index.js src/history/embed-indexer.js src/history/embedder-host.js src/history/vector-search.js src/history/reranker.js src/history/context-builder.js src/history/search.js src/core/create-core.js tests/history-private-scope.test.js tests/history-private-embeddings.test.js
git commit -m "feat(history): a private chat is read only by private chats, embedded only by the embed worker, and never sent to Jev"
```

---

## Task 11: Usage: local calls in a reply's totals and in the tracker

Beside Tasks 9 and 10, once Task 8 is merged. Spec §9; R-LI-12, R-LI-13. Carries spec §22 item 6 (with Tasks 5 and 12).

**Files:**
- Modify: `src/tracking/llm-totals.js`, `src/tracking/usage-tracker.js`, `src/providers/inference-router.js` (`callTags`), `src/providers/local-server-provider.js` (`usageEstimated`)
- Test: `tests/local-usage.test.js` (new)

**Interfaces (produces):**
- `sumLlmCalls`: `localCalls` and `localTokens` on the totals, present only when above zero. A local call does not set `unpriced`.
- `costByRole`: each role entry gains `localCalls`, `localTokens` and `localServers` (the distinct `local.server` values) when it has any.
- `UsageTracker.eventFromMetrics`: carries `local: { server, class }` (and `node`, `nodeName` when present, for L2) and `usageEstimated`. `record` adds `localCalls` and `localTokens` to the provider, role and model totals and keeps a `byServer` table (`{ [server]: { calls, tokens } }`); a local call never increments `unpricedCalls`. A stored record from before this task reads with zeros.
- `InferenceRouter#callTags`: when a failover happened, `failoverFrom` is the label (`provider/model`) of the list's first target that failed; absent otherwise. `_stamp` puts it on the metrics.
- `LocalServerProvider#buildLlmCallMetrics`: when the server reported no usage (all counts zero) and the reply has text, input and output tokens are estimated at one token per four characters of the request body and of the reply, and `usageEstimated: true` is set. `costUsd` stays 0.

- [ ] **Step 1: Write the failing tests.** `tests/local-usage.test.js`: totals over `[local, hosted priced, hosted unknown]` calls (`costUsd` is the priced one's, `unpriced: true` because of the unknown one, `localCalls: 1`); over `[local, local]` → `costUsd: 0`, no `unpriced`, `localCalls: 2`; `R-LI-13: an ollama call is $0 and not local` in totals and tracker; `R-LI-13: an unknown hosted model is still null` and counts as unpriced; the tracker's `byServer`; a record file written before this task loads; `R-LI-12: failoverFrom names the local target` (router with `[local (down), openai fake]`); a server without usage → `usageEstimated`.
- [ ] **Step 2: Run and see them fail.** `node --test tests/local-usage.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/usage-tracker*.test.js tests/llm-totals*.test.js tests/inference-router*.test.js tests/local-server-provider.test.js` (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/tracking/llm-totals.js src/tracking/usage-tracker.js src/providers/inference-router.js src/providers/local-server-provider.js tests/local-usage.test.js
git commit -m "feat(usage): local calls are counted as local, free and never unpriced, and a failover away from a local model is named"
```

---

## Task 12: Cases: the mark on the case, and every case model call behind it

**Rebase the branch on cases stage 8 first.** After Tasks 10 and 11. Spec §7.3, §7.5 (the case rows), §8.1, §8.2, §9.2; R-LI-8, R-LI-13, R-LI-22, R-LI-23. Carries spec §22 items 1, 6 and 14.

**Files:**
- Modify: `src/cases/case-store.js` (`CASE_YAML_KEYS`), `src/cases/case-runtime.js`, `src/cases/turn-runner.js`, `src/cases/ingest/call-model.js`, `src/core/create-core.js` (`readCasePrivate`, ingest's `resolveInference`), the stage 8 verify pass's caller (find it: the module that calls `routedProvider(turn, { role: 'verify' })`)
- Test: `tests/cases-private-models.test.js` (new), `tests/cases-store-yaml.test.js`

**Interfaces (produces):**
- `case.yaml` key `private` (boolean), `CASE_YAML_KEYS.private = 'L1'`. Read strictly by `parseCaseYaml`: `true` is private; a missing key is not; **any other value makes the case private** (fail closed) and logs one warning.
- `CaseRuntime#isPrivate(caseId) → boolean` (true when the case cannot be read); `CaseRuntime#markPrivate(caseId)`: through `systemAction`, sets `private: true`, and calls `historyStore.markPrivate` for every chat with that `caseId` (the runtime's host gives it the store: add `host.markChatsPrivate(caseId)` implemented in `create-core.js`). No inverse. No tool calls it; no IPC yet (Task 14).
- `create-core.js`: `readCasePrivate = (caseId) => caseRuntime.isPrivate(caseId)`; the ingest wiring becomes `resolveInference: ({ provider, model, caseId }) => resolveRole('main', { explicit: { provider, model }, caseId })`.
- `CaseRuntime#routedProvider(turn, spec)`: `router.newRouteState(tags, turn.models?.egress || null)`, and its `routeTargets` options carry nothing new (the state does). `beginTurn` snapshots with the case id as today, so `turn.models.egress` is set for a private case.
- `createCallModel`: passes `caseId` to `resolveInference` and calls `resolved.provider` as today (under a policy that is the routed provider, Task 8).
- A wake-up turn of a private case with no usable local model ends as a **failed wake-up** (the existing backoff and third-strike briefing), with the refusal's code in the failure.
- A case created by a detour from a private case is created private (`DetourRouter`'s create path passes `private: true` to `CaseRuntime.createCase`, which writes the key at creation).
- `usageHook(turn)`: an event with `ev.local` charges `usd` 0, passes `unpricedTokens: 0` and `localTokens: totalTokens` to `charge`. The stale comment about real providers reporting `costUsd: 0` is replaced by one that says what the rule is now: zero with tokens is unpriced **unless** the event is local.

- [ ] **Step 1: Write the failing tests.** `tests/cases-private-models.test.js`, with a temp cases root, a real `CaseRuntime` and core, hosted-only profiles unless a test adds the fake local server, a `fetch` stub that fails on any hosted URL, and cases marked through `runtime.markPrivate`:
  - `R-LI-23: a case chat is private exactly when its case is` (`egressFor({ chatId })` for a chat of a private case; `markPrivate` marks both of the case's chats in the store);
  - `R-LI-8:` one test each for `orient`, `judge` (an owner turn), `classify`, `draft`, the stage 8 `verify` pass, a wake-up turn, ingest OCR, extract and verify (through `tests/helpers/ingest-harness.js` with the real `createCallModel`): no hosted request, and the documented outcome (turn refused; proposal pending with the reason; classifier fails open with no request);
  - with a local `main` and `utility` that call tools (the fake server's tool-call mode): an owner turn completes and every request went to the fake local server;
  - `R-LI-22: a wake-up with no local model is a failed wake-up`;
  - `R-LI-13: a local call charges usd nothing and counts no unpriced tokens` (`budget.json` after a turn); a hosted unknown model still records unpriced tokens;
  - a `case.yaml` with `private: maybe` is private; a detour's new case is private; `case.yaml` has no way back (`markPrivate` twice is a no-op; `updateMeta({ private: false })` through any runtime method is refused).
  In `tests/cases-store-yaml.test.js` add the key.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/cases-store-yaml.test.js tests/cases-turn*.test.js tests/cases-wakeup*.test.js tests/cases-ingest*.test.js tests/cases-budget*.test.js tests/egress-inventory.test.js` and stage 8's verify tests (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/case-store.js src/cases/case-runtime.js src/cases/turn-runner.js src/cases/ingest/call-model.js src/core/create-core.js tests/cases-private-models.test.js tests/cases-store-yaml.test.js
git commit -m "feat(cases): a private case makes every case model call local or refused, and a local call charges the budget nothing"
```

(Add the verify pass's file to the `git add` line if it changed.)

---

## Task 13: Cases: the index, the case tools, the approval card

After Task 12. Spec §8.2, §8.5; R-LI-24, R-LI-32. Carries spec §22 item 13.

**Files:**
- Modify: `src/cases/index-store.js`, `src/mcp/case-tools.js`, `src/cases/executors/envelope.js`
- Test: `tests/cases-private-surfaces.test.js` (new)

**Interfaces (produces):**
- `IndexStore#search`: takes `isPrivateCase(caseId)` (injected by the runtime). A hit from a private case, for a `forCaseId` that is not private (or with no `forCaseId`), is `text: null, redacted: true` whatever its `disclosable` flag and for brief `title` and `objective` too. Between two private cases, and for a case's own hits, today's rule. `includePrivate` stays inside `index-store.js`.
- `createCaseToolHandler`: `openCase`, `get_orientation`, `list_questions`, `list_envelopes`, `list_playbooks` on a private case return `{ id, title, status, private: true }` and none of the case's text **when the channel is `mcp-stdio` or `mcp-frontdoor`, or when it is `in-app-chat` and the asking chat is not private** (the handler gets `askerIsPrivate` from the chat tools, which read `context.turnModels?.egress`). `list_cases` adds `private: true` to such a row and keeps id, title and status. The write tools are unchanged (answering a question in a private case from MCP is still an answer; the quote is recorded as now).
- `envelopeQuestionText` and `deltaQuestionText`: for a private case, one host-built line after the caps and before the labelled wording: `This case is private. This send leaves your hardware.` (pass `private` in the options the callers already build). It counts toward the 2,000-character limit.

- [ ] **Step 1: Write the failing tests.** `tests/cases-private-surfaces.test.js`: the index (a disclosable fact and a brief title of a private case are redacted for an ordinary case, shown to another private case and to itself; a redacted hit still counts as a duplicate by the existing two-token rule); `R-LI-32: open_case and get_orientation on a private case` on each of the three channels and from a private asking chat; `list_cases` shape; `answer_question` on a private case over `mcp-stdio` still works; `R-LI-24: the envelope card and the delta card carry the line`, in the documented position, and an ordinary case's card is byte-identical to before; `R-LI-24: an executor submits in a private case` (the fake errands server from `tests/helpers/fake-errands-server.js` receives the gated payload).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** `src/cases/mcp-tool-definitions.js` is not changed (tool descriptions stay static).
- [ ] **Step 4: Run again;** also `node --test tests/cases-index*.test.js tests/mcp-case-tools*.test.js tests/management-tools*.test.js tests/cases-envelope*.test.js` (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/cases/index-store.js src/mcp/case-tools.js src/cases/executors/envelope.js tests/cases-private-surfaces.test.js
git commit -m "feat(cases): a private case's text stays out of other cases' searches and the MCP surfaces, and its approval card says the send leaves"
```

---

## Task 14: The owner's paths to the marks

After Task 13. **From this task on an owner can mark.** Spec §8.1, §8.2, §8.6, §8.7, §13.1, §13.2; R-LI-10, R-LI-23, R-LI-28.

**Files:**
- Create: `src/models/private-facts.js`
- Modify: `src/ipc/chat-handlers.js`, `src/ipc/case-handlers.js`, `src/ipc/history-handlers.js`, `src/ipc/models-handlers.js`, `src/ipc/constants.js`, `preload.js`, `src/models/profiles.js`, `src/cases/chat-attach.js`, `src/history/import-chats.js`, `src/history/importers/` (the King Louie JSON importer), `src/core/create-core.js` (the `localOnly` seal; `Profiles#snapshot` passing `localOnly`)
- Delete from `tests/egress-core.test.js`: the test `nothing outside tests can mark yet`
- Test: `tests/private-mark-ipc.test.js`, `tests/case-private-attach.test.js`, `tests/models-profiles-local-only.test.js`, `tests/history-import-private.test.js` (new)

**Interfaces (produces):**
- `privateFacts({ store, chatId, caseId, turnModels, voiceSettings, embedderStatus }) →` `{ alreadySent: { messages, providers: [..] }, hostedVectors: boolean, missing: [{ role, why }], recalledBy: [{ chatId, title }], chats: [{ id, title }], bridge: boolean }`: `alreadySent` from the stored replies' `llm` calls whose provider is not `local`; `missing` from `turnModels.resolve` under a trial policy for `main`, `worker`, `utility` (and `orient`'s needs for a case); `recalledBy` from other chats' reply provenance (`context.recalledChats`) naming this chat; `chats` the case's chats when a case is involved.
- `chat:markPrivate` `({ chatId, confirm })`: without `confirm: true` it returns `{ ok: true, confirm: false, facts, untrustedText: true }`. With it, in this order: refuse a bridge chat (`PRIVATE_BRIDGE_CHAT`, by `bridgeOriginFor`), refuse while a turn runs in the chat (`PRIVATE_CHAT_BUSY`, the same check `CHAT_BUSY` uses in `case-handlers.js`), then for a chat with a `caseId` call `caseRuntime.markPrivate(caseId)` (R-LI-23) and otherwise `store.markPrivate(chatId)`; send `chat:updated`. Accepted only from the local window's event or the bridge dispatcher's marked event (attached); a call from anything else is `NOT_LOCAL_WINDOW`.
- `case:markPrivate` `({ caseId, confirm })`: the same two steps on the case.
- `chat-attach.js`: after its existing refusals, `assertChatAttachable` gains: a private chat and a case that is not private → `PRIVATE_CASE_REQUIRED` unless the call carries `makeCasePrivate: true` (then `case:attach` marks the case in the same action); a chat that is not private attached to a private case is marked private in the same action. `case:create` with a private chat creates the case private.
- `Profiles`: `normalizeProfile` keeps `localOnly` (a list of role ids that exist in the profile or are core roles; anything else dropped). `update(id, patch)` may **add** roles to it; a patch that would remove one is refused (`LOCAL_ONLY_ONE_WAY_HERE`) unless `update` was called with `{ allowUnsetLocalOnly: true }`, which only the `models:local.unsetLocalOnly` handler passes, and only for a local-window event. `snapshot` passes the profile's `localOnly` to `createTurnModels`. The core's settings seal (Task 7) treats a `localOnly` entry the same way for a generic settings save.
- Import: the King Louie JSON importer reports `private: true` when the export's chat object has `private === true`; `importedChat` keeps it as an option, and `beginChatImport` creates the chat with `{ private: true }` before any message is appended. `history:import.commit` takes `asPrivate: true` (the dialog's checkbox) with the same effect for any importer. Nothing in an import can make an existing chat less private. `longhaul import` sets the session manifest's `private: true` for such an export (one line in `src/longhaul/importing.js`; this is the only LongHaul file this task touches).
- There is no channel, CLI command or tool that clears a mark; a request shaped like one gets `PRIVATE_ONE_WAY` (`chat:markPrivate` with `private: false`).

- [ ] **Step 1: Write the failing tests.**
  - `tests/private-mark-ipc.test.js`: `R-LI-10: the confirmation counts what was already sent` (seed replies with `llm.calls` on `openai` and on `local`; facts count only the hosted ones and name the provider); `hostedVectors`; `missing` for a hosted-only profile; the first call marks nothing; the second marks; `R-LI-10: nothing unmarks`; `PRIVATE_CHAT_BUSY`; `PRIVATE_BRIDGE_CHAT`; `NOT_LOCAL_WINDOW` for an unmarked event and for a tool-origin call; `R-LI-23: marking a case chat marks the case and every chat of it`; both channels classify as `proxy` in the allowlist; after marking, a turn with hosted-only models is refused with `PRIVATE_NO_LOCAL_MODEL` (the end-to-end check of the stage, at unit level);
  - `tests/case-private-attach.test.js`: `R-LI-23:` a private chat and an ordinary case is `PRIVATE_CASE_REQUIRED`; with `makeCasePrivate` both are private afterwards; an ordinary chat attached to a private case becomes private; the older refusals still win (`CHAT_SAW_OTHER_CASES`, `CHAT_RECALLED_OTHER_CHATS`, `IMPORTED_CHAT`);
  - `tests/models-profiles-local-only.test.js`: `localOnly` survives a save; a role is added by `update`; removal is refused without the option and through a generic settings save; `snapshot` under `localOnly: ['utility']` resolves utility to local targets only and throws `LOCAL_ONLY_ROLE_NO_MODEL` when there is none, while `main` is untouched; `models:local.unsetLocalOnly` works only for the local window;
  - `tests/history-import-private.test.js`: `R-LI-28: an export that says private is imported private` (the chat is private before its first chunk exists: a hosted fake embedder running during the import sees none of its text); `asPrivate`; `R-LI-28: an export cannot clear a mark` (an export saying `private: false` whose id matches an existing private chat imports as a second chat and changes nothing); a LongHaul import of the same file has `manifest.private === true`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** Delete the Task 8 grep test in the same commit.
- [ ] **Step 4: Run again;** also `node --test tests/egress-core.test.js tests/case-chat-attach.test.js tests/history-import-chats.test.js tests/history-ipc-import.test.js tests/models-profiles*.test.js tests/longhaul-import*.test.js tests/egress-inventory.test.js` (the files that exist) — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/private-facts.js src/ipc/chat-handlers.js src/ipc/case-handlers.js src/ipc/history-handlers.js src/ipc/models-handlers.js src/ipc/constants.js preload.js src/models/profiles.js src/cases/chat-attach.js src/history/import-chats.js src/history/importers src/longhaul/importing.js src/core/create-core.js tests/private-mark-ipc.test.js tests/case-private-attach.test.js tests/models-profiles-local-only.test.js tests/history-import-private.test.js tests/egress-core.test.js
git commit -m "feat(models): the owner can mark a chat or a case private and a role local-only, one way, after a confirmation that says what was already sent"
```

---

## Task 15: UI

After Task 14. Spec §15, §7.7, §16.2.

**Files:**
- Modify: `renderer.js`, `index.html`, `styles.css`
- Test: `tests/renderer-local-servers.test.js`, `tests/renderer-private.test.js` (new; written like `tests/renderer-history-scope.test.js`: they read the renderer's source and exercise its pure helpers)

**What is built** (every string from a server, a model, a probe, a chat or a case set with `textContent`):
- Settings → Models, a "Local servers" card: each server's name, address as typed, pinned addresses, class in words ("this machine", "your network", "your overlay network"), grade ("private chats can use it" / "for cost only: a private chat needs https with a pinned certificate"), problem, "Check again" (shows old and new addresses, then asks), "Remove". "Add a local server" dialog: name, kind, address, optional fingerprint and key, the overlay-network confirmation when the address is in `100.64.0.0/10` (R-LI-29), and two fixed sentences: "This server runs on hardware you control. King Louie will treat its models as local." and "King Louie cannot tell whether this server sends your text on. Mark it local only if it does not." (R-LI-21). "Use this Ollama as a local server" (R-LI-31), then the offer to rewrite profile targets, listing them. In service mode and attached the card is read-only with "Set by the administrator in service.json."
- Per model: context, tools (yes / no / not known), image input, first token and speed, "runs on Ollama's cloud", "Probe again", an editable context.
- Model pickers: a "local" badge and the server's name; in a private chat's pickers and "Retry with…", hosted models disabled with "not local".
- Profile cards: a local-only switch per role (turning it off calls `models:local.unsetLocalOnly` after a confirm); "fails over to a hosted model" where a list mixes; what will be refused where a local-only role has no local model.
- Chat header and chat list: the lock and "Private". "Make private…" in the chat menu and the new-chat menu; the case panel has the same entry for a case. The confirmation dialog renders the facts of Task 14 and the fixed lines "What was already sent stays sent.", "This cannot be undone for this chat.", and the tools line.
- Under the composer in a private chat, always: "Private: model calls stay on your hardware. Tools still send what they send."
- Cost line: "local (Workstation)" segments from `byRole[*].localServers`; "local · N tokens · $0.00" when every call was local; the failover note from `failoverFrom` ("utility: Workstation did not answer; ran on openai/gpt-5.4-mini $0.0006").
- Recall line and scope menu: `vectorsSkipped: 'private-chat'`, `rerankSkipped: 'private-chat'`, and a linked chat excluded with `private-chat`, in words.
- Settings → Recall: the keep-local embedder's state. Settings → Usage: local calls and tokens, by server.
- A refused turn: the sentence for its code and a button to Settings → Models for `PRIVATE_NO_LOCAL_MODEL`, `LOCAL_ONLY_ROLE_NO_MODEL` and `LOCAL_MODEL_UNAVAILABLE`.
- Export (`#export-chat-btn` and "Export as Markdown"): for a private chat, a confirm with "This file is plain text outside King Louie." first; the JSON gets `"private": true`; the Markdown starts with the line "This chat was private in King Louie." (R-LI-28). The import dialog gains "Import as private".

- [ ] **Step 1: Write the failing tests.** `renderer-local-servers`: the card's builder sets no `innerHTML` (grep the new functions); `R-LI-21: the add dialog says a forwarding server cannot be detected`; the grade and class wording for each case; read-only in service mode. `renderer-private`: `R-LI-9: the composer line names tools`; the confirmation's fixed lines; the cost-line formatter for all-local, mixed and failover inputs; the export helper adds the flag and the Markdown line only for a private chat; no `innerHTML` in the new functions.
- [ ] **Step 2: Run and see them fail.** `node --test tests/renderer-local-servers.test.js tests/renderer-private.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/renderer-*.test.js` — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add renderer.js index.html styles.css tests/renderer-local-servers.test.js tests/renderer-private.test.js
git commit -m "feat(ui): local servers in the Models tab, the private mark on a chat and a case, and cost lines that say local"
```

---

## Task 16: The adapter seam

Beside Tasks 12 to 15, once Task 11 is merged. Spec §12; R-LI-15. Nothing here trains, stores or evaluates an adapter.

**Files:**
- Modify: `src/models/roles.js` (`normalizeTarget`, `targetKey`, `targetLabel`), `src/models/resolver.js` (copying targets), `src/models/local-servers.js`, `src/providers/local-server-provider.js`
- Test: `tests/local-adapter-seam.test.js` (new)

**Interfaces (produces):**
- A probe record's `adapters: [{ id, job, ref, baseDigest, addedAt }]`; `ADAPTER_JOBS = ['title', 'classify', 'orient', 'rewrite', 'rerank', 'digest', 'abstain-check']`; `LocalServers#declareAdapter(serverId, model, { id, job, ref })` (desktop: called by `models:local.setModelInfo`; service: read from the admin block's `adapters`), which records the model's current `digest` as `baseDigest`.
- `normalizeTarget` keeps `adapter` (a slug) **only** when the provider is `local`; `targetKey` appends `@<adapter>`; `targetLabel` appends ` + <adapter>`. A target without one is byte-identical to today.
- `LocalServers#explain` for a target with an adapter: unknown adapter → unusable ("… has no adapter titles-1."); `baseDigest` differs from the model's current digest → unusable ("… was made for another version of qwen3:8b.").
- `LocalServerProvider#requestModelFor(target) → string`: the adapter's `ref` when the target names one, else the model id. The provider's request body uses it. Metrics carry `adapter`.

- [ ] **Step 1: Write the failing tests.** `R-LI-15: a target with an adapter sends the adapter's ref` (the fake server sees `model: 'qwen3-titles-1'`; metrics have `adapter: 'titles-1'` and the base model's id); the same model with and without an adapter are two entries in a role's list and resolve in order; `R-LI-15: a stale adapter makes the target unusable` and the next target is used; `adapter` on an `openai` target is dropped; every existing target test still passes unchanged.
- [ ] **Step 2: Run and see them fail.** `node --test tests/local-adapter-seam.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/egress-resolver.test.js tests/local-servers.test.js tests/local-server-provider.test.js tests/local-probe.test.js` and the existing roles and profiles tests — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/models/roles.js src/models/resolver.js src/models/local-servers.js src/providers/local-server-provider.js tests/local-adapter-seam.test.js
git commit -m "feat(models): a local target can name an adapter, sent as the server's own name for it"
```

---

## Task 17: LongHaul: the local client, query rewriting and the abstain check

May start as soon as Tasks 1 and 2 are merged into its base. Spec §11; R-LI-14. **No product file and no `history.recall` default changes.**

**Files:**
- Create: `src/longhaul/adapters/kl-recall-rewrite.js`, `src/longhaul/adapters/kl-recall-abstain-check.js`, `src/longhaul/prompts/rewrite-v1.md`, `src/longhaul/prompts/abstain-check-v1.md`, `src/longhaul/local-client.js`
- Modify: `src/longhaul/commands/run.js` (flags, `adapterConfig`), `src/longhaul/adapters/index.js` (`FACTORIES`), `src/longhaul/model-cache.js` (`STAGES`), `src/longhaul/prompts.js` (`PROMPTS`), `src/longhaul/run.js` (`config.json`'s `local` block)
- Test: `tests/longhaul-local-client.test.js`, `tests/longhaul-local-adapters.test.js` (new)

**Interfaces (produces):**
- Flags on `run`: `--local-provider ollama|openai-compatible`, `--local-model <id>`, `--local-base-url <url>` (default `http://127.0.0.1:11434` for `ollama`), `--local-context <tokens>`, `--rewrite-mode replace|append` (default `replace`), `--abstain-mode note|withhold` (default `note`).
- `createLocalClient({ provider, model, baseUrl, context, lookup }) → { provider: 'local', model, baseUrl, local: true, addressClass, context, digest, complete(prompt, { maxTokens }) }`: runs `resolveAndPin` (Task 1) and builds `createLocalTransport` (Task 2) with an `OllamaProvider`-shaped client over it at temperature 0. A base URL that fails the check, or an Ollama cloud model id, throws `LOCAL_REQUIRED` (a `UsageError`, exit 2) **before any request**. A LAN `http` address is accepted here: LongHaul measures, it does not carry the app's guarantee; `addressClass` is recorded.
- `STAGES` gains `'rewrite'` and `'abstain-check'` (Task 18 adds `'digest'`).
- Both adapters wrap `createKlRecallAdapter`; neither sets `usesModel`. Both take `local: { client, cache, retry, cachedOnly }`; `cachedOnly` is true in the answer stage and its dry run (set where `commands/run.js` sets the Jev adapters'), and a cache miss then throws `LOCAL_CALLS_MISSING` ("run the evidence-only run with the same settings first").
  - `kl-recall-rewrite`: in `context()`, one `cachedCall({ stage: 'rewrite', … })` with `rewrite-v1.md` (the question in, one search query out, at most 64 tokens); the result replaces, or is appended to, the `message` given to `builder.build`. An empty reply falls back to the question and counts in `runStats().fallbacks`.
  - `kl-recall-abstain-check`: builds the context as `kl-recall`, then one `cachedCall({ stage: 'abstain-check', … })` with `abstain-check-v1.md` (question and context in; `yes` or `no` out, parsed strictly; anything else counts as `yes` and in `runStats().unparsed`). On `no`: mode `note` puts the line `[check] The context below likely does not contain the answer.` above the text (evidence accounting unchanged); mode `withhold` returns `NOTHING_SHOWN` with no evidence shown.
  - Cache key parts: `stage`, `provider`, `model`, `baseUrl`, `digest`, `promptSha256`, `maxTokens`, `inputSha256`.
  - `describe()` carries the local model (`provider/model`), its digest, the mode and the prompt's hash, so each is in `cfg:`. `runStats()` reports calls, cache hits, latency, fallbacks.
- `config.json` gains `local: { provider, model, baseUrl, addressClass, context, digest, prompts: { rewrite, abstainCheck } }` when a local client was built.
- `assertMaySend` needs no change: it already drops clients with `.local`. The local client is added to the list it collects.

- [ ] **Step 1: Write the failing tests.** `tests/longhaul-local-client.test.js`: a loopback fake server gives a client with `local: true`; `http://203.0.113.9:8000` → `LOCAL_REQUIRED` and no socket; a name with an injected `lookup` answering a public address → `LOCAL_REQUIRED`; a cloud id → `LOCAL_REQUIRED`; `priceCall` of the client is 0; a private session with only this client and `--fake-models` for the rest runs without `--send-private`. `tests/longhaul-local-adapters.test.js` on `tests/fixtures/longhaul` with a fake client `{ provider: 'fake', model: 'm', local: true, complete() }` and a `ModelCache` on a temp dir: `R-LI-14: rewrite passes the rewritten query to the builder` (spy on the store's search); `append` mode; the second run makes no call (cache); `cachedOnly` with an empty cache → `LOCAL_CALLS_MISSING`; `R-LI-14: the abstain check in note mode adds the line and leaves evidence accounting alone`; `withhold` shows nothing and scores evidence recall 0 for that question; an unparsed reply counts as `yes`; no leak (the fixture's `askAtSeq` rule holds for both); `describe()` differs between modes; the registry lists both names; `R-LI-14: no history.recall default changed` (deep-equal `HISTORY_DEFAULTS` to a snapshot taken at the top of the test file from `main`'s values listed in `CLAUDE.md`: `tailUserTurns` 4, `bm25TopK` 200, `queryUserTurns` 0, `rerank.enabled` false, `dedupeCosine` 0.92).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/longhaul-boundary.test.js tests/longhaul-synthetic.test.js tests/longhaul-answer-cli.test.js tests/longhaul-rerank.test.js` and the smoke run `node bin/longhaul.js run --sessions tests/fixtures/longhaul --adapters sliding-window,oracle` with `LONGHAUL_HOME` set to a temp dir outside the repository — expected `# fail 0` and `oracle` at 1.000.
- [ ] **Step 5: Commit.**

```bash
git add src/longhaul/local-client.js src/longhaul/adapters/kl-recall-rewrite.js src/longhaul/adapters/kl-recall-abstain-check.js src/longhaul/prompts/rewrite-v1.md src/longhaul/prompts/abstain-check-v1.md src/longhaul/commands/run.js src/longhaul/adapters/index.js src/longhaul/model-cache.js src/longhaul/prompts.js src/longhaul/run.js tests/longhaul-local-client.test.js tests/longhaul-local-adapters.test.js
git commit -m "feat(longhaul): a local model client, and adapters that measure query rewriting and an answer-or-abstain check"
```

---

## Task 18: LongHaul: LLM rerank and digests

After Task 17. Spec §11.3; R-LI-14. **No product file and no default changes.**

**Files:**
- Create: `src/longhaul/adapters/kl-recall-llm-rerank.js`, `src/longhaul/adapters/kl-recall-digest.js`, `src/longhaul/prompts/rerank-llm-v1.md`, `src/longhaul/prompts/digest-v1.md`
- Modify: `src/longhaul/adapters/index.js`, `src/longhaul/commands/run.js`, `src/longhaul/model-cache.js` (`'digest'`), `src/longhaul/prompts.js`, `src/longhaul/run.js` (`local.prompts`)
- Test: `tests/longhaul-local-rerank.test.js`, `tests/longhaul-local-digest.test.js` (new)

**Interfaces (produces):**
- Flags: `--llm-rerank-mode pointwise|listwise` (default `pointwise`), `--digest-every-tokens <n>` (default 10000), `--digest-max-tokens <n>` (default 400).
- `kl-recall-llm-rerank` (and `kl-recall-vec-llm-rerank` over fused candidates): `createKlRecallRerankAdapter({ …, rerankModel: '<model>-llm-<mode>', scorer })` where `scorer.score(query, texts) → number[]` asks the local client. Pointwise: one call per text, a reply parsed as an integer 0 to 10 (anything else scores 0 and counts in `stats.unparsed`). Listwise: one call per batch of 20 numbered texts, a reply parsed as a list of numbers in best-first order; texts the reply leaves out keep their fused order after the ones it named. Scores are cached by `RerankCache` under `LONGHAUL_HOME/private/rerank/<session>/<model>-llm-<mode>/` (the existing layout); the answer stage is cache-only as for the Jev adapters, throwing `LOCAL_CALLS_MISSING`. `describe()` carries the prompt hash, the mode and the local model's digest.
- `kl-recall-digest`: in `prepare`, walks the session's messages before `upToSeq`, and every `digestEveryTokens` estimated tokens calls `cachedCall({ stage: 'digest', … })` with `digest-v1.md` over that span. Each digest is added to the temporary store as extra recall material covering `[fromSeq, toSeq]`. **Read `src/history/chunker.js` and `HistoryStore#appendMessage` first** to find which message shape produces a chunk of kind `summary` (the kind `kindWeights` already weights 0.9); if none does without changing `src/history/`, stop and report: this task must not edit `src/history/`. A digest row is never counted as a message of the session.
  - Leak rule: a digest whose `toSeq >= askAtSeq` is not shown for that question (filter in `context()`), and a digest never covers a message at or after `upToSeq`.
  - Evidence rule (spec D-LI-4): a digest covering an evidence message counts as neither whole nor partial.
  - `prepare`'s calls happen in the evidence-only run; the answer stage is cache-only (`LOCAL_CALLS_MISSING`). `runStats()` reports digests made, calls, cache hits.

- [ ] **Step 1: Write the failing tests.** `longhaul-local-rerank`: with a fake client that scores by a keyword, the reranked order differs from the fused one and is the keyword order; the cross-encoder adapter and this one given the same candidates (assert the candidate ids are equal); pointwise unparsed → 0; listwise leaves the unnamed in fused order; a second run reads the cache and makes no call; `cachedOnly` miss → `LOCAL_CALLS_MISSING`; a changed query (wrapping `kl-recall-rewrite`) is a cache miss. `longhaul-local-digest`: digests are made at the interval and cached; a digest appears in the context for a late question and not for one asked inside its span; `R-LI-14: a digest is not evidence` (a question whose evidence message is covered only by a digest has evidence recall 0, `partial` 0); the leak check passes on the fixtures and fails (exit 1) when the filter is removed (inject a broken filter); the session's message count is unchanged by digests.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again;** also `node --test tests/longhaul-local-adapters.test.js tests/longhaul-rerank.test.js tests/longhaul-boundary.test.js tests/longhaul-synthetic.test.js tests/history-settings.test.js` — expected `# fail 0`.
- [ ] **Step 5: Commit.**

```bash
git add src/longhaul/adapters/kl-recall-llm-rerank.js src/longhaul/adapters/kl-recall-digest.js src/longhaul/prompts/rerank-llm-v1.md src/longhaul/prompts/digest-v1.md src/longhaul/adapters/index.js src/longhaul/commands/run.js src/longhaul/model-cache.js src/longhaul/prompts.js src/longhaul/run.js tests/longhaul-local-rerank.test.js tests/longhaul-local-digest.test.js
git commit -m "feat(longhaul): adapters that measure an LLM rerank against the cross-encoder, and periodic digests as recall material"
```

---

## Task 19: The end-to-end check, and the whole e2e suite once

After Tasks 15, 16 and 18.

**Files:**
- Create: `tests/e2e/local-private.test.js`, `tests/e2e/_local-server.js` (a loopback OpenAI-compatible server for the launched app: reuse `startFakeLlmServer` if it can be started from the e2e process and its port passed in the seed; otherwise a 60-line server of its own)
- Modify: `tests/e2e/helpers.js` only if a seed needs a new file kind

**The test** (`launchApp({ seed })` with a profile whose `main` is a hosted fake at the same loopback server under the `openai` dialect, and no local server yet; click through `page.evaluate(() => document.getElementById(id).click())`; dismiss the wizard with `#wizard-skip-btn`):
1. Settings → Models → add a local server at the fake's address: the card shows "this machine" and the probed model with tools "yes".
2. A new chat, one turn: the reply's cost line names the hosted model. The fake recorded a hosted-dialect request.
3. "Make private…": the dialog shows one message already sent and names the provider; confirm. The header shows "Private"; the composer line is there.
4. Send again: the turn is refused with the `PRIVATE_NO_LOCAL_MODEL` sentence, and **the fake recorded no new hosted-dialect request**.
5. Put the local model in `main` and `utility`; send again: a reply arrives, the cost line reads "local", and every new request the fake saw was under the local server's path.
6. The chat's menu has no way to unmark. Relaunch on the same user data dir (the helper's option for that; if it has none, read the mark back through `page.evaluate` before closing): the chat is still private.
7. A second, ordinary chat set to recall from all chats does not list the private chat as readable.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: Run it alone.** `unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/local-private.test.js` (on Windows from Git Bash; in pwsh remove the variable with `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`).
- [ ] **Step 3: Run the whole e2e suite once**, because `renderer.js`, `index.html` and `preload.js` changed: `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` — expected every file to pass. A failure in a file this stage did not touch is investigated, not skipped.
- [ ] **Step 4: Commit.**

```bash
git add tests/e2e/local-private.test.js tests/e2e/_local-server.js tests/e2e/helpers.js
git commit -m "test(e2e): a chat marked private refuses a hosted model and answers from a local one"
```

---

## Task 20: The smoke script, the examples, CLAUDE.md, the spec, and the one full test run

After Task 19.

**Files:**
- Create: `scripts/smoke-local.js`
- Modify: `package.json` (`"smoke:local": "node scripts/smoke-local.js"`), `examples/fleet/gpu-box/service.json`, `tests/examples.test.js` (only if it lists keys), `CLAUDE.md`, `docs/install-guide.md`, `docs/superpowers/specs/2026-10-13-local-inference-design.md` (status line; §21 for anything this stage verified or found wrong)

**Steps:**
- [ ] **Step 1: `scripts/smoke-local.js`**, modelled on `scripts/smoke-providers.js`: reads `KL_SMOKE_LOCAL_URL`, `KL_SMOKE_LOCAL_KIND` (default `ollama`), `KL_SMOKE_LOCAL_MODEL`; with none set it prints how to set them and exits 0. It builds a `LocalServers` on a temp data dir, adds the server (the real address check and a real DNS lookup), probes the model, streams one reply and makes one tool call through `LocalServerProvider`, and prints the pin, the class, the grade and the probe record (the `sample` field, nothing else of the reply). It is not part of `npm test`. Run it once against a real local server if one is at hand and paste the output into the task's Deviations entry; if none is, say so there.
- [ ] **Step 2: The example.** `examples/fleet/gpu-box/service.json` gains `"localInference": { "servers": [{ "id": "workstation", "name": "Workstation", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434", "maxConcurrent": 2 }] }`. The other four example `service.json` files (`frontdoor`, `laptop`, `mac`, `web-01`) are **not** changed: the block is optional and no feature or port was added. `node --test tests/examples.test.js tests/examples-e2e.test.js` — expected `# fail 0`, including `scanForPersonalValues`.
- [ ] **Step 3: `CLAUDE.md`.** Add a section "## Local models" after "## Models", in the file's own style (short bullets, what to do and what never to do): the `local` provider key and `<serverId>/<model>` ids; `LocalServers` owns entries, pins and probes; only `local-transport.js` opens a socket to a local server, and it never follows a redirect or resolves at request time; the address classes and R-LI-29, R-LI-30; the sealed `models.localServers` key and that service mode reads only `localInference` in the admin `service.json`; the egress policy, its four checks, and that a mark that cannot be read is private; **"a new model call goes through the router or takes the policy, and `tests/egress-inventory.test.js` lists the file"**; the private mark is one-way and written only by `HistoryStore#markPrivate` and `CaseRuntime.markPrivate`; `costUsd: 0` only for `local` and non-cloud `ollama`; the keep-local embedder; the LongHaul local client and the four adapters, cache-only in the answer stage, no default changed; `npm run smoke:local`; tests use the fake server and an injected `lookup`. In the same commit correct two existing lines: "the four `examples/fleet/*/service.json` files" → five; and add `localInference` to the sentence that lists what joins `ADMIN_ONLY_KEYS` in the contact and playbooks sections' style. Do not edit `CONTEXT.md`.
- [ ] **Step 4: `docs/install-guide.md`.** A short section for the administrator: the `localInference` block, the address rules, the fingerprint for a LAN server, `allowCgnat`, and that the service ignores a data-dir setting for it. Invented values only; the file is scanned by `scanForPersonalValues`.
- [ ] **Step 5: The spec.** Set its status to "L1 built" with the stage's last commit, and move anything in §21 that this stage verified (A1 on the Node versions run; A3 and A4 for the server kinds the smoke script was run against) or found wrong.
- [ ] **Step 6: The full suite, once, by the controller.** `npm test` — expected `# fail 0`. Then `node --test tests/electron-boundary.test.js tests/longhaul-boundary.test.js tests/egress-inventory.test.js` by name, to see them in the output.
- [ ] **Step 7: Commit.**

```bash
git add scripts/smoke-local.js package.json examples/fleet/gpu-box/service.json CLAUDE.md docs/install-guide.md docs/superpowers/specs/2026-10-13-local-inference-design.md
git commit -m "docs(models): local models in CLAUDE.md and the install guide, the gpu-box example, and a smoke script for a real local server"
```

---

## Decisions

The planner's, not the owner's; each can be overturned in review.

1. **One provider key, `local`, with the server in the model id** (spec D-LI-1), not one provider per server: the catalog, overrides and target keys keep their `<provider>:<model>` shape.
2. **Under a policy `resolveRole` hands out the routed provider as `provider`** (Task 8), so a caller that takes the first target's instance directly, as ingest does, is behind the router without knowing. The provider-level refusal stays as the floor for any instance built another way.
3. **A local-only role borrows among local models like a private chat does** (Task 3). R-LI-22 is worded for private chats; applying it to a local-only role sends nothing to a hosted model either way.
4. **An unknown mark is private** (`isPrivate` of an unknown chat, a store that is closed or below schema 5, a `case.yaml` whose `private` is not a boolean). A turn in a chat the store cannot find is refused rather than run on a hosted model.
5. **The keep-local embedder serves imported chats too** (Task 10), since it exists for the same rule (R-H4-2); an imported chat's query keeps today's behaviour because the owner has not ruled on the open H4 item.
6. **The interim seal on `localOnly` is one-way for generic saves** (Tasks 7, 14): a settings save can make a role stricter, never looser.
7. **A digest is not evidence** (spec D-LI-4).
8. **LongHaul's local client accepts a LAN `http` address.** It measures; it does not carry the app's guarantee. The address class is recorded in `config.json`.
9. **A bridge chat cannot be marked** (spec D-LI-3).
10. **The inventory fixture is a file a reviewer reads**, not a generated one: each entry has a one-line reason.

## Not in this plan

- Stage L2 (spec §14): the protocol document, vectors, hub forwarding, the trust files and CLI, the serving and consuming sides. Its plan follows L1.
- Private memory entries, an embedder on a local server counting as local, a standalone desktop as an L2 client (R-LI-25, R-LI-27, R-LI-32: deferred).
- Promoting any of the four recall jobs to the product: a separate change with its own LongHaul run.
- A job log, adapter training, storage or evaluation (spec §12.4).
- Any change to `CONTEXT.md`.
- A ruling on N1; until then the three tools are refused in a private chat.

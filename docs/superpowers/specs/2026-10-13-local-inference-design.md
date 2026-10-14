# Local Inference — Design Spec

- **Status:** Draft. The outline was approved by the owner on 2026-10-13 (§2). Twelve questions are open
  (§3); the sections that depend on one say so. No implementation plan exists yet.
- **Date:** 2026-10-13
- **Builds on:** models (`2026-09-27-model-catalog-profiles-roles-design.md`: catalog, availability,
  profiles, roles, `TurnModels`, failover, cost records), recall
  (`2026-09-25-chat-history-recall-design.md`: embedders §5.2, scope §6.3, the H4 rulings §17), LongHaul
  (`2026-09-25-session-memory-benchmark-design.md`), the fleet design
  (`2026-09-21-king-louie-fleet-design.md`) and its stages 3, 4, 5 and 7, the cases specs (roles, wake-ups,
  executors, ingest).
- **Read on:** `main` at 9ec78a3. Every "the code says" below was read there unless §21 lists it as not
  verified.
- **Stages:** L1 (this machine and the owner's LAN), then L2 (a fleet node serves the owner's other
  nodes). L2 ships after L1; §14.1 shows the seam L1 leaves for it.
- **Words:** this spec uses two terms the owner is adding to `CONTEXT.md` (this change does not edit
  that file):
  - **Local model:** a model that runs on hardware the owner controls, with no request leaving it.
    Avoid: SLM, small model, offline model.
  - **Adapter:** weights trained from one owner's history that change how a local model does one job.
    Avoid: fine-tune (as a noun), custom model, LoRA (that is one way to make one).

  Two more words are used here and proposed for `CONTEXT.md`: a **local server** is an
  OpenAI-compatible server the owner added and marked local; **private** is the mark on a chat or a
  case that makes every model call in it local or refused.

## 1. Outcome

King Louie can run model calls on the owner's own hardware, and can promise it.

1. **A privacy guarantee the app enforces.** A chat or a case marked private makes no model call that
   leaves the owner's hardware: the call goes to a local model or it is refused. A role marked
   local-only never reaches a hosted model. Both fail closed.
2. **A base for adapters.** A local model entry can name adapters and a role can select one. Training
   them is a later step; this spec builds only the seam (§12).
3. **Lower cost.** Small jobs (chat titles, detour classify, case orient) run on a local model at $0.
4. **Working offline.** A profile whose roles hold local models answers with no network.

First jobs: the utility calls above, and four recall jobs measured on LongHaul before any of them is
used by the product (§11).

L2 lets one node with a GPU serve the owner's other nodes over the hub links the fleet already has,
with the prompts sealed end to end between the two nodes.

### 1.1 Not in this spec

| Item | Why or where |
|---|---|
| Main chat on a local model as a goal | It works when the owner puts a local model in `main`; nothing here tunes or promises its quality |
| Judging or verifying on a local model as a goal | Same. A private case does run its judge loop on a local `main` (§7.4); the spec promises it is local, not that it is good |
| A model runtime inside the app | The app talks to a server the owner runs |
| Model downloads | The owner installs models in their server |
| A suggester for local models | The King Louie profile never proposes a `local` target (§6.5) |
| Adapter training, data selection, evaluation | Step 6; §12.4 lists what it needs from this spec |
| Padding or cover traffic in L2 | Deferred (§20); the relay seeing size and timing is an accepted residual |
| Any change to `CONTEXT.md` | The owner's own edit |

## 2. Owner decisions (2026-10-13)

These were approved by the owner as the outline. They are decisions, not options; the rest of the spec
is designed to fit them and names them by id.

| Id | Decision |
|---|---|
| R-LI-1 | **Four purposes**, all of them: a privacy guarantee the app enforces, a base for adapters, lower cost, working offline |
| R-LI-2 | **First jobs:** small utility calls (chat titles, detour classify, case orient) and recall jobs |
| R-LI-3 | **Out:** main chat on a local model as a goal, judging or verifying on a local model, a model runtime inside the app, model downloads, a suggester for local models, adapter training |
| R-LI-4 | **A local server** is any OpenAI-compatible server the owner adds and marks local (Ollama, LM Studio, a llama.cpp server, vLLM) |
| R-LI-5 | **"Local" is the owner's mark plus an address check:** loopback, a private LAN address, or (L2) a paired fleet node. The app pins the address it resolved and refuses a public one |
| R-LI-6 | **Who may configure it.** In service mode only the admin `service.json` adds or marks a local server; data-dir settings for it are ignored with one warning. On the desktop only the app's own UI changes it, never a tool. `Bash` stays the documented residual |
| R-LI-7 | **Probe once, place by hand.** The app probes each model once (context size, tool calling, a small smoke call) and shows what it can do; the owner places models into profile roles as today |
| R-LI-8 | **The guarantee, enforced in the router, fail closed.** (a) A role can be marked local-only: its calls never reach a hosted model and never fail over to one. (b) A chat or a case can be marked private: every model call in it is local or refused: the chat itself, sub-agents, background and workflow tasks, titles, classify, orient, verify, wake-up turns, ingest OCR, extract and verify, embeddings (query and index), rerank (the cross-encoder is local; Jev never), and anything else that calls a model |
| R-LI-9 | **Tools behave as now, and the UI says so plainly.** A web search still sends its query to the web; cases keep their outbound gate |
| R-LI-10 | **Private is one-way and can be set at any time.** Marking an existing chat states that what was already sent stays sent; vectors a hosted embedder made for it are dropped and rebuilt locally |
| R-LI-11 | **Recall scope.** A private chat is in no non-private chat's recall scope; another private chat may recall from it |
| R-LI-12 | **A local model that is down.** A role that uses a local model without the local-only mark fails over along its normal list and the reply's cost line says so. A local-only role or a private chat fails with a clear message instead |
| R-LI-13 | **Usage.** Tokens counted, cost $0, marked "local" in the reply and the usage totals (and which node, in L2). A case's usd budget is not charged. Nothing else becomes $0 |
| R-LI-14 | **Recall jobs:** four LongHaul adapters measured with a local model: query rewriting, LLM rerank (against the current cross-encoder), digests, an answer-or-abstain check. None becomes a product default without a LongHaul run that shows it helps |
| R-LI-15 | **Adapters: the seam only.** How a local model entry names an adapter, how a role selects model plus adapter, which server kinds can load one |
| R-LI-16 | **L2: a serving node** offers the local models its administrator lists to the owner's other nodes |
| R-LI-17 | **L2 transport.** Prompts travel over the existing pinned hub links, sealed end to end between the two nodes, so the relay sees only sizes and timing |
| R-LI-18 | **L2 access.** The serving node's administrator keeps an allow list of node ids with per-node limits (requests, tokens per day). Off by default |
| R-LI-19 | **L2 and the guarantee.** A model on a paired node counts as local. Usage records which node ran it |
| R-LI-20 | **Order.** L2 ships after L1, and L1's design leaves the seam |
| R-LI-21 | **Accepted residuals:** a local server that itself forwards to the cloud cannot be detected; tool calls in a private chat can still send text out; in L2 the relay sees that inference happens and how much |

## 3. Open questions for the owner

Each gives what the code says, the options with their costs, and a recommendation. The spec is written
the recommended way; a section that would change is named.

**Q1. A private chat needs a role that has no local model. Refuse the turn, or run without it?**
The resolver lets an empty `utility` borrow `worker` then `main`, and `worker` borrow `main`
(`borrowChain`, `src/models/resolver.js`). A title is one `oneShot` on `utility`
(`src/ipc/chat-handlers.js`); case `orient` needs tool calling and `judge` runs on `main`
(`src/cases/roles.js`).
- (a) Refuse the whole turn whenever any role it will use has no local model. Simple; a missing
  `utility` blocks a chat that only needed a title.
- (b) Borrow as today but only among local models; when no local model fills a role, skip the call if
  the job is optional (a title, the case nudge, the detour classifier, which already fails open) and
  refuse the turn if it is load-bearing (`main`, a sub-agent, `orient`, `judge`, `draft`, `verify`,
  ingest, a wake-up). Cost: two classes of job to keep straight; an untitled chat keeps its first
  words as its title.
- (c) As (b), and also drop a capability the local model lacks (no tool calling: the turn runs without
  tools). Cost: a chat that silently cannot act.
- **Recommended: (b).** §7.3 is written this way.

**Q2. Does marking a case private mark its chats, and the other way round?**
A case turn snapshots models by case (`snapshotModels({ caseId, chatId })`, `create-core.js`); a wake-up
has a case and may have no chat. R-H4-1 already pins every case chat to itself.
- (a) The mark lives on the case (`case.yaml`), and a chat with a `caseId` is private exactly when its
  case is. Marking a case chat marks the case, after a dialog that names the case. Attaching a private
  chat needs a private case or makes it one in the same confirmation. Cost: one mark covers a whole
  case; the owner cannot keep one chat of a case private and another not.
- (b) Independent marks. Cost: a private chat's turn writes facts into a case whose wake-ups then send
  them to a hosted model; the guarantee would have a hole the UI cannot explain.
- **Recommended: (a).** §8.2.

**Q3. May a private case use an executor or an external agent at all?**
An executor sends `rendered`, the payload the outbound gate passed, under an owner-approved envelope
where authority needs one (`src/cases/executors/`, `gates.js`). R-LI-9 says tools behave as now.
- (a) As now. The model calls around the send (`draft`, `judge`) are local; the send itself leaves the
  machine as the owner approved it; the approval card adds one line saying the case is private and
  this leaves the machine. Cost: "private" does not mean "nothing leaves".
- (b) Refuse every executor with an outbound capability, and the browser, in a private case. Cost: a
  private case can only read and think.
- (c) Allow, but require a fresh press per send even inside an active envelope. Cost: more presses.
- **Recommended: (a).** §8.2, §16.2.

**Q4. With a hosted embedder configured, what do a private chat's vectors use?**
`EmbedderHost` holds one embedder (`settings.history.embedder.kind`: `local`, `ollama`, `openai`,
`none`). The default is `local`. An imported chat is already embedded only under a `local:` key
(`isLocalKey`, `src/history/embed-indexer.js`), and Ollama counts as hosted there because "its address
is a setting and need not be this machine". R-LI-10 says a private chat's vectors are rebuilt locally.
- (a) A private chat is embedded only by the embed worker (`local:`), whatever is configured. With
  `openai` or `ollama` configured the host runs the local embedder as well, for private chats only.
  Cost: `EmbedderHost` learns to hold two embedders; a first-time model download; a second set of
  vector matrices.
- (b) Only the `local:` key counts, and nothing runs alongside: with a hosted embedder configured a
  private chat is found by BM25 alone until the owner switches the embedder to `local`. Cost: R-LI-10's
  "rebuilt locally" is not met for that owner until they switch.
- (c) As (a), and an embedder on a marked local server (§5) also counts as local. Cost: a second kind
  of "local" in recall; gain: the owner's own embedding model on their GPU.
- **Recommended: (a) for L1, (c) as a follow-up** once local servers exist. §8.4.

**Q5. Does L2 inference need the admin-owned identity record on both nodes?**
A node's Ed25519 key lives in the data dir, encrypted, where the service account can replace it
(`mesh.identity`, `src/mesh/node-identity.js`). The identity record
(`<configDir>/identity/node.json`, R-F5-17) is the administrator's statement of which key is this
node's; with no record the service starts with a warning (`checkRecordedIdentity`,
`src/service/run.js`).
- (a) Both: a node serves, and a node uses another node's models, only while its record state is
  `match`. Cost: one more administrator step (`identity record`) on nodes that never needed one.
- (b) The serving node only. Cost: the serving node's allow list then names a key the consuming
  node's service account could have swapped.
- (c) Neither. Cost: the keys the administrators exchange by hand are not the administrator's own.
- **Recommended: (a).** §14.3.

**Q6. Can a standalone desktop use a fleet node's models in L2?**
A standalone desktop has no node identity, no hub link and no `RelayClient`
(`getOrGenerateNodeIdentity` is called only under `src/service`, `src/approvals`, `src/frontdoor` and
the desktop bridge's service wiring).
- (a) Service nodes only. An attached desktop gets it for free, because its turns run in the service.
- (b) Give the standalone desktop a node identity and a hub pairing. Cost: the desktop becomes a fleet
  node, with its own enrolment, key storage and removal; a stage of its own.
- (c) Let a serving node also open an HTTP listener on the LAN that a desktop adds as an L1 local
  server. Cost: a new listener on a service, with no node identity on the client side.
- **Recommended: (a).** §14.

**Q7. A private chat's text in exports, logs, the audit ledger and crash reports.**
Export is renderer code that writes the chat as JSON or Markdown (`renderer.js`,
`#export-chat-btn`). The store never takes a scope-like field from a chat object
(`STORE_ONLY_CHAT_KEYS`, `src/history/rows.js`). No crash reporter is wired (no `crashReporter` in
`main.js` or `src/`). The audit ledger takes any `kind` with free `data`.
- Export: (a) allowed, after a line saying the file is plain text outside the app's control; the JSON
  carries `"private": true`, and importing such a file marks the new chat private before anything is
  indexed (an import can add the mark, never remove it). (b) Refused. **Recommended: (a).**
- Logs: the rule "no chat text in a log line at `info` or above" is proposed for every chat; whether
  today's code keeps it was not audited (§21). **Recommended:** make it a rule, test it for the paths
  this spec adds, and list the rest as a residual.
- Audit ledger: inference entries carry ids, model names, token counts and sizes, never text (§14.9).
- Crash reports: nothing to do while none exists; a future one must not carry message text.
- §8.6.

**Q8. Is the carrier-NAT range (100.64.0.0/10) a "private LAN address"?**
Overlay networks hand out addresses in it. `src/frontdoor/net.js` treats it as private for the relay's
mesh listener. A carrier can also route it, so an address there need not be the owner's hardware.
- (a) Refuse it. Cost: an owner whose machines talk over an overlay network cannot add one in L1.
- (b) Allow it like RFC 1918. Cost: a weaker meaning of "private".
- (c) Allow it per server, only after the owner confirms "this address is on my own overlay network"
  (the admin sets `allowCgnat: true` in service mode).
- **Recommended: (c).** §5.2.

**Q9. Plain `http` to a LAN address: allow, or require proof of which server answers?**
A pinned LAN address says where the request goes, not who is there. On another network the same
address is somebody else's machine.
- (a) Allow `http` to a LAN address, with a warning at add time. Cost: on a foreign network a private
  prompt can reach a stranger's host that happens to hold the pinned address.
- (b) For anything but loopback require `https` with a pinned certificate fingerprint. Cost: most
  local servers need a TLS proxy in front (not verified per server kind, §21).
- (c) (a), plus the server is used only while the machine's default gateway is the one seen when the
  owner added it. Cost: a new platform probe on three operating systems; false refusals after a
  router change.
- **Recommended: (b) for a private chat or a local-only role, (a) otherwise.** A LAN server over plain
  `http` then lowers cost but does not carry the guarantee; the UI shows which it is. L2 is the
  answer for another machine with a proven identity. §5.3, §16.

**Q10. What happens to the built-in Ollama provider?**
`ollama` is one of the 14 providers; its address is `settings.models.ollama.baseUrl`, and any
`ollama` model whose id does not end `-cloud` or `:cloud` is already priced at $0 and flagged
`local: true` in the catalog whatever the address is (`Catalog#price`, `localEntry`).
- (a) It stays as it is and never counts as local for the guarantee. The Models tab offers "Use this
  Ollama as a local server", which adds a local server at the same address (if it passes the check)
  and, on a second confirmation, rewrites the owner's profile targets from `ollama/<m>` to
  `local/<id>/<m>`. Cost: one owner action after the upgrade.
- (b) Convert automatically at upgrade when the stored address is loopback. Cost: a mark the owner
  never made.
- (c) Make `ollama` itself markable. Cost: two kinds of local target in every check.
- **Recommended: (a).** §5.1, §9.

**Q11. Surfaces that hand a private chat's or case's text to another model without King Louie calling
one.**
- Memory: entries are written through `MemoryManager#capture*` and `memory:capture`, and the memory
  context is sent with every chat's prompt (`options.systemPromptDynamic`). Text from a private chat
  stored there would reach a hosted model in the next ordinary chat.
- The fleet `delegate` tool starts a turn on another node, on that node's own models
  (`src/fleet/delegate-sessions.js`).
- The case tools over MCP (`open_case`, `get_orientation`, …) return case text to whatever client
  holds the scope (`src/mcp/case-tools.js`), often a hosted assistant.
- Options: (a) treat all three as tools (R-LI-9) and say so; (b) in a private chat memory is read but
  never written, `delegate` is refused, and the MCP surfaces give a private case's id, title and
  status only; (c) tag memory entries private and show them only to private chats.
- **Recommended: (b) in L1; (c) deferred.** §8.5.

**Q12. The image and voice paths.** `ImageGenerate` calls OpenAI or fal directly
(`src/media/image-generation/`); read-aloud can use ElevenLabs (`src/voice/engines/elevenlabs.js`).
Both are hosted model calls, so R-LI-8 refuses them in a private chat. The question is only the
behaviour: (a) refuse with a message; (b) for voice, fall back to the system engine
(`system-tts.js`) without asking. **Recommended: (a) for images, (b) for voice.** §7.5.

## 4. What exists (so nothing is rebuilt)

| Piece | Where | Used for |
|---|---|---|
| The one provider request path | `BaseLLMProvider#request(url, init, options)` (`src/providers/base-provider.js`): calls `globalThis.fetch`, carries `options.abortSignal` | The local transport plugs in here (§5.4); Stop already cancels the request |
| An OpenAI-compatible chat client with tools and streaming | `OllamaProvider` (`src/providers/ollama-provider.js`): `/v1/chat/completions`; `options.baseUrl` is "the OpenAI-compatible API base itself" | The local server client is this code under a second provider key (§5.1) |
| Ollama discovery | `discoverOllama` (`src/models/ollama.js`): `/api/tags`, `/api/show` (context length, `tools`, `vision`) | The probe for `kind: ollama` (§6.1) |
| Local catalog entries | `Catalog#setLocalModels`, `localEntry` (`src/models/normalize.js`): `local: true`, zero cost | Local servers' models enter the catalog the same way |
| The Ollama cloud id rule | `isOllamaCloudModelId` (`src/models/provider-ids.js`) | A cloud id on an Ollama server is never local (§5.5) |
| Usable or not, with reasons | `Availability#explain`, `explainTarget` (`create-core.js`), `NoUsableModelError` | Local targets and the "not local" reason (§7.2) |
| Profiles, roles, the frozen snapshot | `createTurnModels`, `resolve`, `mustResolve`, `candidatesFor` (`src/models/resolver.js`); `snapshotModels`, `resolveRole` (`create-core.js`) | The egress policy rides the snapshot (§7.1) |
| Failover over a resolved list | `InferenceRouter#routeTargets`, `routedProvider`, `callTags` (`src/providers/inference-router.js`) | The fail-closed check (§7.2); the failover note (§9.3) |
| Case roles | `CASE_ROLE_TO_MODEL_ROLE` (`src/cases/roles.js`): orient and classify → utility, draft → worker, judge and verify → main; `CaseRuntime#routedProvider` | Titles, classify and orient become local by putting a local model in `utility` |
| Cost records | `buildLlmCallMetrics`, `UsageTracker.eventFromMetrics`, `summarizeTurnLlm`, `costByRole` (`src/tracking/llm-totals.js`) | The `local` mark (§9) |
| Case budget charging | `CaseRuntime#usageHook` | Must learn `local` (§9.2) |
| History scope | `resolveScope` (`src/history/scope.js`), `createScopePolicy` (`scope-policy.js`), `HistoryStore#chatRefs` | R-LI-11 is one more policy rule (§8.3) |
| "Keep this chat's chunks on this machine" | `isLocalKey` and the `localOnly` flag (`embed-indexer.js`, `embedding-index.js`); `keepLocalReason` (`reranker.js`), `rerankSkipped` | Private chats join both (§8.4) |
| A store-only chat field | `STORE_ONLY_CHAT_KEYS`, `HistoryStore#setHistoryScope` | The private mark is stored the same way (§8.1) |
| Admin-only service config | `ADMIN_ONLY_KEYS`, `parsePlaybooksConfig`, `rejectUnknownKeys` (`src/service/config.js`) | `localInference` (§13.3) |
| Secret stores no tool may touch | `SECRET_FILE_PREFIXES` (`src/tools/utils.js`): `chat-data.json`, `config.json`, …, for every file tool in every turn; `DATA_DIR_GUARDED` in case turns | R-LI-6 on the desktop (§5.6) |
| Address classes | `isPrivateV4`, `isPrivateV6` (`src/frontdoor/net.js`); the block lists in `src/frontdoor/probe.js`; "only 2000::/3 is global unicast" (`src/frontdoor/oauth/cimd.js`); `isPrivateIp` (`src/tools/builtin/web-fetch-utils.js`, which makes `WebFetch` refuse private addresses) | One classifier for local servers (§5.2); `WebFetch` cannot reach a local server |
| Node identity | `NodeIdentity`, `deriveNodeId` (`src/mesh/node-identity.js`): one Ed25519 pair; `node_id` = `kl-` + 16 base32 characters of SHA-256 of the raw key; the identity record (`src/service/identity-record.js`) | L2 authentication (§14.3) |
| Hub links | `RelayClient` (`src/approvals/relay-client.js`), `createLinkRpc` (`src/approvals/link-rpc.js`), `MeshTransport` (1 MiB frames, 200 inbound frames a second), `NodeHub` (`src/frontdoor/node-hub.js`) | L2 transport (§14.4) |
| An AEAD frame sealer | `createSealer`, `createOpener` (`src/gui/helper-protocol.js`): AES-256-GCM, direction byte, 8-byte sequence | The shape L2 frames copy (§14.5) |
| Signed envelopes and vectors | `approval-v1` envelopes (`{alg, kid, payload, sig}` over RFC 8785 bytes); `tests/vectors/<proto>/generate.js --check` | L2 handshake messages and their vectors |
| The audit ledger | `AuditLedger#append({ kind, data })` (`src/audit/audit-ledger.js`) | L2 entries (§14.9) |
| LongHaul adapters, caches, privacy gate | `FACTORIES` (`src/longhaul/adapters/index.js`), `ModelCache`, `RerankCache`, `SpendGuard`, `priceCall` (0 when `model.local`), `assertMaySend` (drops clients with `.local`) | The four recall adapters (§11) |

Things the outline assumes that the code does not have. Each is new work, and §22 repeats the ones
that make the approved design harder than it sounds.

- **`kl-session-v1` is not a channel between nodes.** It is the service's pipe to its session helper,
  keyed by a pre-shared 32-byte secret (`docs/protocol/session-v1.md`). No key agreement exists
  anywhere in `src/` (no X25519, no Diffie-Hellman). L2 needs a new protocol (§14).
- **A hub never forwards from one node to another.** Every hub-side handler for a node message
  (`src/frontdoor/node-methods.js`, the router's `fleet.*` notifications) ends at the hub, the phone
  mailbox or an OAuth client. The fleet design says "Other nodes don't trust peers; everything goes
  through the front door". L2 adds forwarding to the hub (§14.4).
- **Link RPC has no stream.** A call has one answer and a 10 s default timeout; the only streaming
  shape is the job-update notification.
- **The router does not know which chat a call belongs to.** It walks a list of targets. The
  guarantee therefore has to ride the frozen `TurnModels` and be re-checked in the router (§7).
- **Several model calls never pass the router or `BaseProvider.request`** (§7.5): ingest calls the
  first target's provider directly; the context assembler and the agent loop's semantic compaction
  embed through `OpenAIEmbeddingProvider`, a direct `fetch` to `api.openai.com` that exists whenever
  an OpenAI key is saved; image generation and ElevenLabs have their own clients.
- **A target is `{ provider, model, effort }` and the provider must be one of the 14** for
  availability; the router keeps one provider instance per provider key.
- **A $0 call with tokens is read as "unpriced" by the case budget** (`usageHook`:
  `rawCost === 0 && totalTokens > 0`).

## 5. Local servers (L1)

### 5.1 The entry and the provider key

A local server is an entry the owner (desktop) or the administrator (service) wrote:

```json
{
  "id": "workstation",
  "name": "Workstation",
  "kind": "ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "tlsFingerprint": null,
  "allowCgnat": false,
  "maxConcurrent": 2,
  "timeoutMs": null,
  "pinned": { "addresses": ["127.0.0.1"], "class": "loopback", "at": "2026-10-13T09:00:00.000Z" },
  "markedLocalAt": "2026-10-13T09:00:00.000Z"
}
```

- `id`: a slug, `^[a-z][a-z0-9-]{1,39}$`, unique, never reused for another address without a new
  mark. No slash, so the model id below splits at its first slash.
- `kind`: `ollama`, `lmstudio`, `llamacpp`, `vllm` or `openai-compatible`. It selects the probe
  (§6.1) and the adapter request shape (§12.3), nothing else. Every kind is spoken to as
  `<baseUrl>/v1/chat/completions`; for `ollama` the `baseUrl` is the server root and `/v1` is added,
  as `OllamaProvider` does today.
- `markedLocalAt`: the owner's mark (R-LI-5). There is no unmarked local server: adding one is the
  mark, behind a confirmation that reads "This server runs on hardware you control. King Louie will
  treat its models as local." An entry that fails the address check is not saved.
- A key, when the server wants one, is a provider token named `__local_<id>`, encrypted like any
  provider token; in service mode it is a `${vault:<key>}` reference in the admin block.

**Designer decision D-LI-1.** Local servers get one new provider key, `local`, and a model id of
`<serverId>/<model>`: the target is `{ provider: 'local', model: 'workstation/qwen3:8b' }`. The
catalog and override key `local:workstation/qwen3:8b` splits at its first colon as today. `local` is
not added to `KL_PROVIDERS` (which maps onto models.dev); `explainTarget` (`create-core.js`), which
already has a branch for a registered provider outside the 14, asks the local server registry
instead.

**Designer decision D-LI-2 (depends on Q10).** The built-in `ollama` provider is unchanged: same
address setting, same $0 price, same profiles. It is never local for the guarantee, because its
address is an ordinary setting with no mark and no check. The owner turns it into a local server
with one action (Q10 (a)).

`src/models/local-servers.js` (new, Electron-free) is the registry: `list()`, `get(id)`,
`explain(model, { needs })`, `transportFor(id)`, `providerFor(id)`, `probe(id, model)`, and on the
desktop only `add`, `remove`, `recheck`. `LocalServerProvider`
(`src/providers/local-server-provider.js`) is `OllamaProvider`'s OpenAI-compatible code with
`getProviderName() === 'local'`, one instance per server; it strips the `<serverId>/` prefix before
it puts the model in the request body.

Two router changes follow from one provider key covering many servers:
`InferenceRouter#_instanceFor` keys its instances by `provider` for the 14 and by
`local:<serverId>` for local targets, and `createProvider(provider, token, target)` receives the
target. `_nextTarget`'s "after the first answer only the same provider" rule needs no change: every
local server speaks the same message format.

### 5.2 The address check

`src/models/local-address.js` (new) classifies one IP literal. The classes and what L1 does:

| Class | Ranges | L1 |
|---|---|---|
| `loopback` | `127.0.0.0/8`, `::1` | allowed |
| `lan` | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` (ULA) | allowed |
| `cgnat` | `100.64.0.0/10` | refused unless the entry says `allowCgnat` (Q8) |
| `link-local` | `169.254.0.0/16`, `fe80::/10` | refused |
| `unspecified` | `0.0.0.0`, `::` | refused |
| `public` | everything else, including `64:ff9b::/96` (NAT64), `2002::/16` (6to4), the documentation ranges and multicast | refused |
| `node` | not an address: a paired fleet node | L2 (§14) |

Rules:

1. **An IPv4-mapped IPv6 address is unwrapped first** (`::ffff:a.b.c.d` is classified as `a.b.c.d`),
   in every spelling the platform parser accepts. The classifier takes the parsed bytes, never the
   string.
2. **Link-local is refused in both families.** `169.254.169.254` is where cloud machines serve
   instance credentials, and an IPv6 link-local address needs a zone that a URL cannot carry
   (assumption A2, §21).
3. **A host name is resolved once, when the entry is added or re-checked**, with the operating
   system's resolver (`dns.lookup`, `all: true`), so a hosts-file name works. Every address returned
   must be allowed, or the entry is refused; a name that answers with both a LAN and a public address
   is refused. The allowed addresses are stored in `pinned.addresses`.
4. **The app dials only a pinned address.** At request time nothing is resolved: the connection's
   `lookup` returns the pinned list, the `Host` header and TLS server name keep the name the owner
   typed. A name that later resolves somewhere else changes nothing (DNS rebinding has no window); the
   Models tab shows "resolves differently now" on the next re-check and the owner decides.
5. **The connected socket is checked.** After connect, `socket.remoteAddress` must be one of the
   pinned addresses, or the socket is destroyed and the call fails `LOCAL_ADDRESS_MISMATCH`. This
   catches anything that got between the request and the pin.
6. **No redirect is followed.** Any 3xx from a local server fails the call `LOCAL_REDIRECT`. A local
   server has no reason to redirect, and a redirect is the simplest way to send the body elsewhere.
7. **No proxy.** The local transport never uses the process's global agent or dispatcher, so
   `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and Node's `NODE_USE_ENV_PROXY` cannot route it
   (assumption A1, §21). Rule 5 is the check that holds if the assumption is wrong: through a proxy,
   the socket's remote address is the proxy's, and a proxy on a pinned address is the owner's own.
8. **`https` is allowed** to any allowed class, verified against the system roots, or against
   `tlsFingerprint` (SHA-256 of the certificate, hex) when the entry has one; with a fingerprint the
   chain is not consulted. `http` is allowed to `loopback`, and to `lan` subject to Q9.
9. **Only `http:` and `https:`**, no credentials in the URL, no query, no fragment, a port from 1 to
   65535.

The check runs when an entry is added, at every start, on "Check again", and before a probe. It does
not run per request: rule 4 makes the pinned address the only one a request can reach.

**What "pinned" does not prove** (Q9, §16): which machine holds a LAN address. The class recorded in
`pinned.class` is shown in the UI as "this machine", "your network" or (L2) a node name.

### 5.3 What carries the guarantee

An entry is **guarantee-grade** when a private chat or a local-only role may use it:

- `loopback`: always;
- `lan` or `cgnat`: with `https` and a `tlsFingerprint` (Q9 as recommended); otherwise the server is
  usable for cost and offline work but not in a private chat or a local-only role, and
  `explain` says "Workstation answers over plain http on your network; a private chat needs a pinned
  certificate";
- `node` (L2): always, since the node's key is pinned (§14.3).

If the owner rules Q9 the other way, every allowed class is guarantee-grade and this subsection is
one line shorter.

### 5.4 The transport

`BaseLLMProvider#request` keeps its signature. When the provider instance carries a `transport`
(only `LocalServerProvider` does), `request` calls `transport.fetch(url, init)` in place of
`globalThis.fetch`; the abort handling around it is unchanged, so Stop cancels a local call exactly
as it cancels a hosted one.

`src/models/local-transport.js` builds that `fetch` on `node:http` / `node:https` with its own agent
(never the global one), the pinned `lookup`, rule 5's socket check, rule 6's refusal, `maxConcurrent`
as a queue that an abort can leave, and a web `Response` whose body streams. It is the one module in
`src/` that opens a socket to a local server; the probe and discovery use it too
(`discoverOllama` already takes an injected `fetch`).

The transport is the L2 seam: a `node` entry gets a transport with the same `fetch` shape that
carries the request over `inference-v1` (§14.1).

### 5.5 A local server that is not local

- **Ollama cloud models.** An Ollama server lists cloud models beside installed ones; the code
  already tells them apart by id (`isOllamaCloudModelId`). On a `kind: ollama` server such an id is
  listed as "runs on Ollama's cloud", is not a local model, and a `local/<id>/<cloud id>` target is
  refused `LOCAL_CLOUD_MODEL` in the registry and again in the provider.
- **Anything else that forwards** (a proxy the owner pointed at a hosted API, a server with a remote
  backend) cannot be detected. This is R-LI-21, stated in the add dialog: "King Louie cannot tell
  whether this server sends your text on. Mark it local only if it does not."

### 5.6 Who may change it (R-LI-6)

**Desktop.** `settings.models.localServers` is written by one function, `LocalServers#write`, called
only from the `models:local.*` IPC handlers. Those handlers act only on an event the standalone
host's own `ipcMain` wrapper marked (`markLocalDesktopEvent`, `src/core/origin.js`).

What already keeps a tool away from it, outside case turns too:

- `chat-data.json` (the settings store) and `config.json` (the vault) are in `SECRET_FILE_PREFIXES`:
  `Read`, `Write`, `Edit`, `MultiEdit`, `Grep` and `Glob` refuse them in every turn, by name and by
  file identity. Case turns add `DATA_DIR_GUARDED`.
- No built-in tool, skill, MCP tool or gateway handler calls `setSettings` (none found under
  `src/tools`, `src/skills`, `src/mcp`, `src/gateway`).
- `WebFetch` refuses loopback and private addresses, so the model cannot talk to a local server with
  it.

What this spec adds:

1. **A sealed key.** The core's `setSettings` keeps the stored `models.localServers` whatever the
   caller passed; only `LocalServers#write` replaces it. A settings save from any other path (a
   settings pane, the `/llm` channel commands, an import, a profile CLI command) cannot add, change
   or remove a local server. The same seal covers each profile's `localOnly` list (§7.1) in one
   direction: a generic save can add a role to it and cannot remove one.
2. **No `/llm` action** for local servers, and the desktop import (`import --from`) does not carry
   `models.localServers`.
3. **Changing `models.ollama.baseUrl` does not touch a local server** made from it; the two are
   separate entries after Q10 (a).
4. A test that greps `src/` for writes to `models.localServers` outside `local-servers.js`.

Residual, as for `facts.jsonl` and the envelopes: `Bash` can rewrite `chat-data.json`.

**Service.** Local servers come only from the admin `service.json` block `localInference` (§13.3).
`localInference` joins `ADMIN_ONLY_KEYS`. A `models.localServers` in the data-dir settings is ignored
with one warning at start. `models:local.add`, `.remove` and `.recheck` over the desktop bridge
answer `LOCAL_SERVER_ADMIN_ONLY`; `.list` and `.probe` work. The pin is resolved at each start from
the admin's `baseUrl` (or taken from the admin's `addresses` when given) and logged; an entry that
fails the check is left out with an error in the log and in `models status`, and the service starts.

## 6. Probing and placing models (R-LI-7)

### 6.1 The probe

A model is probed once, when it is first listed, and again only when the owner asks. Steps, each
through the pinned transport, each bounded by a timeout:

1. **List.** `kind: ollama`: `discoverOllama` (`/api/tags`, `/api/show`). Other kinds:
   `GET <baseUrl>/v1/models` (assumption A3: each named kind serves it).
2. **Context size.** Ollama: `model_info.*.context_length`, as today. Other kinds: read from the
   listing when the server reports it (which field, per kind, is assumption A4) and otherwise
   `unknown`; the owner may type it, and the entry records who said so.
3. **Tool calling.** One call with a single trivial tool and `tool_choice: 'auto'`; `yes` when the
   reply holds a well-formed call to it, `no` when it answers in text, `unknown` on an error. For
   Ollama, `/api/show`'s `tools` capability is recorded beside it; the smoke result wins.
4. **Smoke call.** "Reply with the word ok.", `max_tokens: 8`, streaming: time to the first token,
   tokens a second, whether the server reported usage, and the first 40 characters of the reply.
5. **Image input.** Ollama: the `vision` capability. Other kinds: `unknown` until the owner says.

```json
{
  "workstation/qwen3:8b": {
    "probedAt": "2026-10-13T09:01:12.000Z",
    "context": 40960, "contextSource": "server",
    "toolCall": "yes", "imageInput": "no", "stream": true, "usageReported": true,
    "firstTokenMs": 420, "tokensPerSecond": 38.5,
    "digest": "sha256:<hex>", "adapters": []
  }
}
```

Probe results are observations, not policy: they live in `<dataDir>/models/local-probes.json` on
both hosts and never in the admin block. A forged probe can make a weak model look capable; it cannot
make a model local.

A probe sends only the fixed strings above. It is never run in a turn, and never under
`KL_TEST_MODE` unless a test asks.

### 6.2 The catalog and availability

After a probe the registry calls `Catalog#setLocalModels('local', entries)` with `localEntry` rows
(`local: true`, zero cost, the probed context, `toolCall` true only for `yes`). `Availability#usable`
and the Models tab list them with a "local" badge and the server's name. `explain` for a `local`
target answers from the registry: unknown server, server failed its address check, not listed, not
probed yet (probed now), a cloud id, a capability the call needs and the probe did not find.

`unknown` capabilities follow the existing rule for an unknown model
(`capabilitiesOf`: "never claim it sees images, and do not refuse it tools"), with one difference:
`toolCall: 'no'` from a smoke call refuses a `needs.toolCall` job.

### 6.3 Placing

Unchanged: the owner puts `local/<server>/<model>` targets into profile roles in Settings → Models.
A list may mix local and hosted targets in any order; that order is the failover order (R-LI-12).

### 6.4 Timeouts and load

`roleTimeoutMs` keeps deciding a call's timeout. A local model that is not loaded can take longer
than `utility`'s 15 s on its first call (assumption A5); an entry's `timeoutMs`, when set, replaces
the role timeout for calls to that server when it is larger. `maxConcurrent` (default 2) queues calls
per server; time in the queue counts against the timeout.

### 6.5 Three things that must not change by accident

- The King Louie profile's suggester (`src/models/suggester.js`) skips every `local` model
  (R-LI-3).
- `workerIsCheaper` (`src/models/delegation.js`) compares blended catalog rates; a local worker at
  $0 under a priced main turns the delegation guidance on, and two local models turn it off. That is
  what the rule says today and it is left alone.
- `models.overrides` can change a local entry's capabilities but not its cost, its `local` flag or
  which server it is on.

## 7. The guarantee (R-LI-8)

### 7.1 The egress policy

One value says whether a model call may leave the owner's hardware:

```js
// src/models/egress.js
{ localOnly: true, reason: 'private-chat' | 'private-case' | 'local-only-role', chatId, caseId }
// or null: no restriction
```

- **Private.** `snapshotModels({ chatId, caseId })` reads the chat's and the case's mark (§8.1) and
  passes `egress` to `createTurnModels`, which freezes it with the profile. Everything that takes the
  turn's `TurnModels` (sub-agents, background and workflow tasks, an agent-panel run, the case
  roles) inherits it without knowing.
- **Local-only role.** A profile gains `localOnly: ['utility', …]`, a list of role ids. `resolve`
  applies it to that role's call whatever the chat is.

A policy is only ever added on the way down: a child run's snapshot takes its parent's policy, and a
snapshot built without a chat (`snapshotModels({})`) for work that belongs to a chat is a bug the
inventory test (§7.6) is there to catch.

### 7.2 Where it is enforced

1. **The resolver explains.** Under a policy, `resolve` drops every target that is not a
   guarantee-grade local target (§5.3) into `skipped` with the reason "… is not a local model and
   this chat is private" (or "… and `<role>` is local-only"). Borrowing still happens (Q1 (b)), over
   the filtered lists: a private chat's empty `utility` borrows a local `worker` or `main`, never a
   hosted one. The main override and an explicit target (`delegate.model`, a `SpawnAgent` model, an
   ingest role's named model, "Retry with…") go through the same filter. `mustResolve` then throws
   `NoUsableModelError` with code `PRIVATE_NO_LOCAL_MODEL` or `LOCAL_ONLY_ROLE_NO_MODEL`.
2. **The router refuses.** `routedProvider` and `routeTargets` take the policy in the route's `meta`
   and check every target immediately before `_instanceFor`: a non-local target under a policy
   throws `PRIVATE_HOSTED_TARGET` and the loop does not go on to another target. This is the
   fail-closed line: it holds when a caller built its target list some other way.
   `CaseRuntime#routedProvider`, which calls `routeTargets` itself, passes `turn.models.egress`.
3. **The transport pins.** A local target can only be sent by `LocalServerProvider`, whose transport
   reaches only the pinned address (§5.2).

A provider instance for one of the 14, asked to send under a policy, also refuses: `request` checks
`options.egress` and throws `PRIVATE_HOSTED_CALL` before any `fetch`. The router passes the policy
in the call options, so this is a fourth check on the routed path and the only one on a path that
holds a provider instance directly (ingest, §7.5).

### 7.3 When no local model can take the call (Q1 as recommended)

| Job | Private chat or case, no local model for it |
|---|---|
| The chat's own turn (`main`) | The turn is refused before any call: "This chat is private and `main` has no local model in the profile `<name>`. Add one in Settings → Models." |
| A sub-agent, a background or workflow task | That run is refused with the same message; the parent sees a tool error |
| Case `orient`, `judge`, `draft`, `verify`; a wake-up | The turn is refused; a wake-up counts as a failed wake-up (backoff, then the third-strike briefing) |
| Ingest OCR, extract, verify | The document's proposal stays pending with the reason |
| A chat title | Skipped; the chat keeps its first words |
| The detour classifier | Skipped, as any classifier failure is today (fails open: on-case) |
| The case nudge and other optional helpers | Skipped |

Nothing in this table ever falls back to a hosted model.

### 7.4 What "private" asks of a profile

A private chat needs a guarantee-grade local model that can do what the turn does: tool calling for
agent mode, a context large enough for the tail and the recalled block. A private case needs that in
`main` (the judge loop) and a tool-calling model for `orient`. Marking a chat or a case private
checks this once and says what is missing before the owner confirms (§8.1); it does not block the
mark.

### 7.5 Every model call, and how it is held

Found by reading the callers of `routedProvider`, `routeTargets`, `oneShot`, `snapshotModels`,
`resolveRole`, `createCallModel`, `createProvider`, `EmbedderHost`, `JevReranker`, and every file
under `src/` that calls `fetch` or opens a socket.

| Call | Where | Path today | Under a policy |
|---|---|---|---|
| The chat turn's loop | `src/ipc/chat-handlers.js` (`snapshotModels`, `routedProvider`) | router | §7.2 |
| Chat title | `chat-handlers.js`, `oneShot` on `utility` | router | §7.2; skipped when none (§7.3) |
| Advisor review | `src/execution/advisor.js`, `oneShot(this.provider, …)` | the provider it was given | It must be given the routed provider of the turn; pinned by a test |
| Sub-agents, `SpawnAgent`, `BackgroundTask`, workflow tasks, agent-panel runs | `createAgentRuntime` (`create-core.js`), `runtimeOptions.turnModels` | router | Inherit the parent's snapshot; a run with no parent snapshot takes the chat's |
| Bridge and gateway turns | through `createAgentRuntime` (not traced one by one, §21) | router | A bridge chat cannot be private (§8.2) |
| Case `orient`, `judge` | `src/cases/turn-runner.js`, `runtime.routedProvider(turn, { role })` | router | §7.2 |
| Detour classify | `src/cases/detours/classifier.js` | router | §7.2; fails open |
| Executor result drafting | `src/cases/executors/results.js` (`draft`) | router | §7.2 |
| Case `verify` (stage 8, not on `main`) | planned on `routedProvider` | router | §7.2 |
| Wake-up turns | `turn-runner.js`, `host.snapshotModels({ caseId, chatId })` | router | The case's mark (§8.2) |
| Ingest OCR, extract, verify | `createCallModel` (`src/cases/ingest/call-model.js`): `resolveRole('main', { explicit })`, then `resolved.provider` directly | **not routed** | `createCallModel` passes the case's policy to `resolveRole` and in the call options; `request` refuses (§7.2). The plan may instead route ingest; either way a test sends a private case's document with only hosted models configured and sees no request |
| History embeddings, index | `startEmbedIndexer` → `EmbedderHost#current()` | embed worker, or the Ollama or OpenAI provider | §8.4: the store never hands a private chat's chunks to a key that is not `local:` |
| History embeddings, query | `createVectorSearch` (`src/history/vector-search.js`) | whatever embedder is active | §8.4: a private chat's query is embedded by the `local:` embedder or not at all |
| Rerank, local | the cross-encoder in the embed worker | local process | allowed |
| Rerank, Jev | `JevReranker` → `TypesafeProvider` | hosted | `keepLocalReason` returns `private-chat`; not sent, `rerankSkipped: 'private-chat'` |
| Semantic context selection | `ContextAssembler#_assembleSemantic` (`src/context/context-assembler.js`) embeds the owner's message through `OpenAIEmbeddingProvider` | **a direct `fetch` to `api.openai.com`**, whenever an OpenAI key is saved | Called with no embedding provider for a private chat; `_fallbackAll` already exists |
| Semantic compaction | `AgentLoop#_semanticCompact` embeds the user query and old tool results through the same provider (`chat-handlers.js` passes `contextAssembler.embeddingProvider`) | same direct `fetch` | The loop gets no `embeddingProvider`; the recency fallback already exists |
| Memory vectors | `MemoryManager` with an `embeddingProvider` | none is constructed today (`create-core.js`) | Stays off for a private chat if one is ever wired |
| Image generation | `ImageGenerate` → `src/media/image-generation/openai-provider.js`, `fal-provider.js` | direct `fetch` | Refused `PRIVATE_HOSTED_CALL` (Q12) |
| Read-aloud | `TTSEngine` → `engines/elevenlabs.js` or `system-tts.js` | hosted or the operating system | ElevenLabs refused; the system engine speaks (Q12) |
| Speech to text | none found in `src/` | | |
| Fleet `delegate` | `src/fleet/delegate-sessions.js` on another node | that node's models | Refused in a private chat (Q11) |
| Catalog refresh, connection tests, OAuth | `catalog.js`, `availability.js`, `anthropic-oauth.js` | hosted, no chat text | Not gated |

The paths in bold are why "enforced in the router" is not enough by itself: the router is one of
four gates, and every caller in this table that is not on the router needs a change of its own.

### 7.6 Keeping the inventory true

`tests/egress-inventory.test.js` (new) lists every file under `src/` (outside `src/longhaul/`) that
calls `fetch`, `http.request`, `https.request`, opens a WebSocket, or constructs a provider, with one
of three labels: `gated` (takes an egress policy), `no-chat-text` (never sends chat or case text),
`tool` (a tool the model calls, R-LI-9). A file not on the list fails the test, the way
`tests/electron-boundary.test.js` and `tests/history-no-legacy-chat-helpers.test.js` hold their
rules. A new model caller then cannot appear without someone deciding which it is.

### 7.7 Tools (R-LI-9)

Tools behave as now. In a private chat `WebSearch` sends its query, `WebFetch` fetches, the browser
tools browse, `Bash` runs, `Message` sends, an executor sends what its gate passed. Three tools are
not "tools" for this rule because what they do is run a model: `ImageGenerate`, `SpawnAgent` and
`BackgroundTask` (which inherit the policy), and `delegate` (Q11).

The UI says so in the same place as the mark (§15): "Private: King Louie's own model calls stay on
your hardware. Tools still do what they do: a web search sends its query to the web."

## 8. The private mark

### 8.1 Where it lives

- **A chat:** a new column `chats.private` (`SCHEMA_STEPS` step 5, `INTEGER NOT NULL DEFAULT 0`),
  written only by `HistoryStore#markPrivate(chatId)`, which sets it to 1 and has no inverse. It joins
  `STORE_ONLY_CHAT_KEYS`: it is never taken from a chat object (a patch, a replace, an upsert), and
  `chatRef` / `chatRefs` carry it. A new chat can be created private.
- **A case:** `case.yaml` `private: true` (a new key in `CASE_YAML_KEYS` and in
  `tests/cases-store-yaml.test.js`), written only by `CaseRuntime.markPrivate` through
  `systemAction`, never by a case tool. `case.yaml` is not write-guarded against `Bash`; the mark is
  read at every turn start, so a `Bash` edit that removes it is the stage 1 residual and is listed in
  §18.

One-way (R-LI-10): there is no IPC, CLI command or tool that clears either. The only way out is a
new chat.

Marking is an owner press: `chat:markPrivate` and `case:markPrivate` are accepted from the app
window's own event (and from an attached desktop, §8.7), never from a tool, a management tool, MCP or
a channel. It is refused while a turn runs in the chat (`PRIVATE_CHAT_BUSY`).

The confirmation, which is the same dialog for a new and an existing chat, reads from the host:

- how many of this chat's messages were already sent to a hosted model, and to which providers (from
  the replies' `llm` records), with the line "What was already sent stays sent.";
- whether vectors made by a hosted embedder exist for it and that they will be removed and rebuilt on
  this machine;
- which roles in the chat's profile have no local model the guarantee accepts, and what will
  therefore be refused or skipped (§7.3, §7.4);
- the tools line of §7.7;
- "This cannot be undone for this chat."

### 8.2 Kinds of chat

| Chat | Rule |
|---|---|
| An ordinary chat | May be marked at any time |
| A case chat (Q2 as recommended) | Private exactly when its case is. The chat's own column is set too, for the store's filters. Marking it marks the case and every chat of the case, in one confirmation that names them |
| Attaching a chat to a case | A private chat attaches only to a private case, or makes the case private in the same confirmation (`PRIVATE_CASE_REQUIRED` otherwise). A non-private chat attached to a private case becomes private. The existing attach refusals (`CHAT_SAW_OTHER_CASES`, `CHAT_RECALLED_OTHER_CHATS`, `IMPORTED_CHAT`) are unchanged and checked first |
| A case created by a detour from a private case | Created private |
| An imported chat | May be marked; the import dialog gains "Import as private", which sets the mark before the first chunk is written, so nothing is ever embedded elsewhere. An imported King Louie export that says `"private": true` is imported private (Q7) |
| A bridge chat (Telegram, Discord) | Cannot be marked (`PRIVATE_BRIDGE_CHAT`): its text passes through the bridge's servers, and a mark there would mislead. Designer decision D-LI-3 |
| A chat opened with `--kl-standalone-once` | Uses the desktop's own store and local servers; the mark behaves as on any standalone desktop |

In a private case (Q3 as recommended) executors, envelopes and the outbound gate work as now. The
envelope and delta cards get one host-built line, after the caps and before the wording: "This case
is private. This send leaves your hardware." A research child (`case-researcher`) inherits the
policy.

### 8.3 Recall scope (R-LI-11)

`createScopePolicy` gains one rule, checked after the three it has:

- `canRead(reader, source)`: a source with `private` set is refused with reason `private-chat`
  unless the reader is private too. `explicit` does not lift it: a link the owner made before
  marking stays stored and stops working, and the scope menu shows why (`excluded`).
- A private reader may read a non-private source under its stored scope: the text flows into the
  private chat and stays on the owner's hardware.
- A private case chat is first a case chat: it reads itself only (R-H4-1).

`ContextBuilder`, `SearchHistory`, `ReadHistory` and the history IPC all ask `resolveScope`, so they
follow without their own rule. The excerpt drawer of an older reply in a non-private chat stops
showing a now-private chat's excerpts, by the open H4 item's cautious reading.

Not solved by scope: text from a now-private chat that an ordinary chat recalled before the mark is
in that chat's stored replies and tool results. The confirmation counts those chats and names them.

### 8.4 Embeddings and rerank (Q4 as recommended)

- **Index.** `pendingEmbeddings` and `countPending` already take `localOnly` and leave an imported
  chat's chunks out for any key that is not `local:`. A private chat is treated the same way in the
  same query.
- **Marking an existing chat** deletes its rows from `embeddings` for every key that is not
  `local:`, in the transaction that sets the mark, and moves `vectorEpoch` so the in-memory matrices
  are rebuilt. The embed worker then fills the `local:` key.
- **A hosted embedder is configured.** The `EmbedderHost` keeps a second, `local:` embedder for
  private and imported chats ("the keep-local embedder"): started lazily when the first such chat has
  pending chunks, on the same worker, with the default local model. The Recall pane says so and shows
  its download and progress beside the main one.
- **Query.** `vectorSearch` is told when any chat in scope is private and then embeds the query with
  the `local:` embedder and searches only `local:` vectors; with no local embedder ready it does not
  embed (`vectorsSkipped: 'private-chat'`) and the turn is BM25 only. This also closes, for private
  chats, the open H4 item that an imported chat's new message still goes to a hosted embedder as the
  query. Imported chats that are not private keep today's behaviour.
- **Rerank.** `keepLocalReason` returns `private-chat` for a scope that holds one; the local
  cross-encoder runs, Jev does not.

### 8.5 Other stores a private chat touches (Q11 as recommended)

- **Memory.** A private chat's prompt gets the memory context as any chat does (it goes to a local
  model). Nothing is captured from a private chat: `capture*` calls that carry a private chat's id
  are dropped, and the memory pane's manual "remember this" is refused there.
- **Cron, background results, checkpoints.** A job or task created in a private chat stores the
  chat id and runs under that chat's snapshot. A result posted into another chat is refused unless
  that chat is private.
- **The cross-case index** (`<casesRoot>/.index/`, BM25, no model). A private case's hits to a case
  that is not private are always `text: null, redacted: true`, including a disclosable fact and the
  brief's title and objective, because that text would enter a hosted model's prompt there. Between
  two private cases the existing rule applies. The entity index is local and unchanged.
- **Management tools.** In King Louie's own chats (`in-app-chat`) they act as now; a private case's
  text reaches a hosted model only if the asking chat is not private, so `open_case` and
  `get_orientation` on a private case from a non-private chat return id, title and status with
  `private: true` and no text. The MCP surfaces (`mcp-stdio`, `mcp-frontdoor`) do the same.
- **`delegate`** and the other acting fleet chat tools are refused in a private chat
  (`PRIVATE_NO_DELEGATE`).

### 8.6 Exports, logs, LongHaul (Q7 as recommended)

- **Export.** Allowed after a one-line warning. The JSON export carries `"private": true`; the
  Markdown export starts with a line saying the chat was private. Import honours the JSON flag.
- **Logs.** New code logs ids, counts, model names and codes, never message text; a test greps the
  new modules' log calls. Existing log lines were not audited (§21).
- **LongHaul.** `longhaul import` of an export that says `"private": true` sets the session
  manifest's `private: true`, so the existing `--send-private` gates apply to it. LongHaul runs
  under `OPEN_POLICY` on its own temporary store and never reads the app's store.

### 8.7 Attached mode

The mark lives where the chat lives. Attached, the chat is in the service's store, the turn runs in
the service, and the service's local servers (its administrator's) are the ones that count. The two
`markPrivate` channels ride the proxied `chat` and `case` domains; the service accepts them from a
paired desktop's local event (`markLocalDesktopEvent` in the bridge dispatcher) and from nothing
else. The desktop's own local servers are not used while attached, because the desktop builds no
core. A desktop that detaches sees its own store again, with its own marks.

## 9. Usage and cost (R-LI-13)

### 9.1 What "known local" means

A call is **local** when `LocalServerProvider` sent it: its target is `local/<server>/<model>`, the
server passed its address check at start, and the request went through the pinned transport. Only
that provider sets it:

```js
llmMetrics = {
  provider: 'local', model: 'workstation/qwen3:8b',
  inputTokens: 812, outputTokens: 14, totalTokens: 826,
  costUsd: 0,
  local: { server: 'workstation', class: 'loopback' },   // L2 adds node: 'kl-…', nodeName: 'gpu-box'
  role: 'utility', profileId: 'p-…', failover: false
}
```

Rules:

1. `costUsd` is `0`, and `unpriced` is absent, exactly when `local` is present. `Catalog#price`
   answers `{ usd: 0 }` for provider `local` (the same zero-cost table `ollama` uses).
2. An `ollama` model with a non-cloud id stays $0 as it is today and does **not** get `local`: it is
   free and unverified. This is the one $0 that exists before this spec and it does not change.
3. An unknown hosted model is unpriced (`costUsd: null`), never $0, as today. Nothing else becomes
   $0: no path sets `costUsd: 0` without either rule 1 or rule 2.
4. A local server that reports no usage: tokens are estimated from the text at the token
   estimator's rate and the record says `usageEstimated: true`. The cost is still $0.
5. A call cut off by Stop is `usagePartial` as today.

### 9.2 Where it shows and what it charges

- **The reply.** `sumLlmCalls` and `costByRole` add `localCalls` and `localTokens`. The cost line
  reads, for example, "utility: local (Workstation) 826 tokens · main $0.0412". A reply whose calls
  were all local reads "local · 3,104 tokens · $0.00".
- **Usage totals.** `UsageTracker.eventFromMetrics` carries `local`; totals by provider, role and
  model gain `localCalls` and `localTokens`, and a by-server (L2: by-node) table. A local call is
  not an unpriced call.
- **The case budget.** `usageHook` today reads a $0 call with tokens as unpriced and records
  `unpricedTokens`. With `ev.local` it charges `usd` nothing, records `localTokens`, and counts no
  unpriced tokens. The comment there about real providers reporting `costUsd: 0` for an unknown
  model is stale (they report `null`) and goes.
- Per-day case categories that count actions, not dollars, are charged as now.

### 9.3 When a local model is down (R-LI-12)

A refused connection, a timeout or a 5xx from a local server is a failure like any other to
`FailoverPolicy`. What the router does next depends only on the list it was given:

- **No policy.** It fails over along the list. `callTags` gains `failoverFrom:
  'local/workstation/qwen3:8b'` beside the existing `failover: true`, and the cost line says
  "utility: Workstation did not answer; ran on openai/gpt-5.4-mini $0.0006".
- **A policy.** The list holds only local targets, so failover moves to another local server if the
  role has one. When none answers the call fails with `LOCAL_MODEL_UNAVAILABLE`: "Workstation did
  not answer (connection refused). This chat is private, so nothing was sent to a hosted model."

A local server that fails is retested by `Availability`'s existing staleness rule
(`refreshForUse`), so one dropped connection does not mark it down for a day.

## 10. Working offline (R-LI-1)

Nothing new is built for this; it follows from the parts above and from two things the code already
does: the catalog loads without the network (`catalog.js`: "Loading never touches the network"), and
the local embedder and cross-encoder run in the embed worker.

- A profile whose roles all hold local targets needs no network for a turn.
- A list with a hosted target first and a local one after it answers offline through failover, once
  the hosted call fails. How fast depends on how the failure is classified (a refused or unresolved
  connection should fail over at once; a timeout is retried first). The plan measures this on the
  fake server and, if needed, makes a name-resolution failure fail over without a retry.
- What still needs the network offline: the web tools, hosted embedders, the catalog refresh (which
  keeps its cached copy), and the first download of the embed worker's models.

## 11. Recall jobs on LongHaul (R-LI-14)

Four adapters, measured with a local model. None changes a `history.recall` default, and none is
wired into the product, until a LongHaul run shows it helps (the rule in `CLAUDE.md`, spec §6.7 of
the recall spec). This section fits LongHaul's conventions as they are in `src/longhaul/`.

### 11.1 The local client

A fifth client role beside answer, judge and summarizer:

```
--local-provider ollama|openai-compatible  --local-model <id>  --local-base-url <url>
--local-context <tokens>   (when the server does not report one)
```

`clientFor` builds it through `createModelClient` and sets `client.local = true` **only** when the
base URL passes §5.2's check (`src/models/local-address.js`; LongHaul may require `src/models`) and
the model is not an Ollama cloud id. The client uses §5.4's pinned transport. With `local` set, what
LongHaul already does applies unchanged:

- `assertMaySend` drops the client, so a private session needs no `--send-private` when every model
  client in the run is local, as with `--embed-provider local` today;
- `priceCall` returns 0 and `SpendGuard` adds nothing to spend;
- `contextCapTokens` returns null for a local client, so the cap comes from `--local-context` or the
  probe.

A base URL that fails the check is refused (`LOCAL_REQUIRED`, exit 2): these four adapters are
defined for a local model. Comparing them against a hosted model of the same size is deferred (§20).

Local calls are $0 and still cached, under `LONGHAUL_HOME/private/model-cache/` (it holds private
text). `STAGES` gains `rewrite`, `digest` and `abstain-check`; adding a stage changes no existing
key, because the stage is part of the key. Each key carries, as `keyFor` does today, the provider,
model, base URL, prompt hash, max tokens and input hash, plus the model's server-reported digest when
there is one (`config.json` records it; a local tag can be re-pulled under the same name).

`config.json` gains `local: { provider, model, baseUrl, addressClass, context, digest }`.

### 11.2 When the calls are made

Three of the four call the model once per question, inside `context()`. LongHaul's deferral
(`estimate` in pass 1, `prepare` in pass 2a, `usesModel`) is built for per-session setup calls, and
`runBenchmark` refuses a `usesModel` adapter outside the answer stage. The Jev adapters already
solve the same shape: they score in the evidence-only run, cache, and are cache-only in the answer
stage (`cachedOnly`, `JEV_SCORES_MISSING`).

The four adapters follow that convention:

- the **evidence-only run** makes the local calls and fills the cache;
- the **answer stage and its dry run are cache-only** for them: a missing entry stops the run with
  `LOCAL_CALLS_MISSING`, "run the evidence-only run with the same settings first";
- they do not set `usesModel`, so pass 1 plans no priced call for them; their cost is $0 by §11.1
  and their call counts and latency are reported in `runStats()`.

### 11.3 The adapters

| Adapter | What it does | Compared against | Cache |
|---|---|---|---|
| `kl-recall-rewrite` | Wraps `kl-recall`. The local model turns the question into a search query (and, as a variant, up to three), which is passed as `message` to `ContextBuilder#build`. `--rewrite-mode replace\|append` | `kl-recall` with the same settings | model cache, stage `rewrite` |
| `kl-recall-llm-rerank` | `createKlRecallRerankAdapter` with a `scorer` whose `score(query, texts)` asks the local model for a relevance score per chunk (`--llm-rerank-mode pointwise\|listwise`), over the same top `topM` candidates | `kl-recall-rerank` (the cross-encoder) with the same candidates; `kl-recall` | `private/rerank/<session>/<model>-llm-<mode>/scores.jsonl`, the layout `RerankCache` and the Jev adapters use |
| `kl-recall-digest` | In `prepare`, every `--digest-every-tokens` (default 10,000, `summarize-compact`'s interval) the local model writes a digest of that span; the digests are added to the temporary store as extra recall material and compete with ordinary chunks for the recalled block | `kl-recall`; `summarize-compact` | model cache, stage `digest` |
| `kl-recall-abstain-check` | After the context is built, one local call answers "does this context contain what is needed to answer the question: yes or no". `--abstain-mode note` puts one host line above the context saying it likely does not; `--abstain-mode withhold` shows nothing (`NOTHING_SHOWN`) | `kl-recall`, on abstain accuracy, the false-answer rate and answer accuracy together | model cache, stage `abstain-check` |

Rules that keep the numbers honest:

- **No leak.** A digest covers only messages before `upToSeq`, and one whose span reaches
  `askAtSeq` is never shown for that question. LongHaul's leak check counts a digest by the messages
  it covers.
- **A digest is not evidence.** A digest that covers an evidence message counts as neither `whole`
  nor `partial` for evidence recall. Whether digests help is read from the answer stage; evidence
  recall shows what they displaced. Designer decision D-LI-4; the alternative (count it `partial`)
  would let a digest score evidence it may not have kept.
- **A changed query is a changed rerank.** The rerank pair hash is over the fused query string, so
  `kl-recall-rewrite` combined with a reranker scores afresh. Combinations are separate adapter
  names, not flags on one adapter, so each has its own `cfg:`.
- **The abstain check only matters in the answer stage**, except in `withhold` mode, where it also
  lowers evidence recall for the questions it withholds. The summary prints both.
- How a digest row enters the temporary store (which message kind maps to the `summary` chunk kind
  that `kindWeights` already has) is settled in the plan, with a test that such a row never counts as
  a message of the session.

### 11.4 Prompts

New versioned files in `src/longhaul/prompts/`, registered in `PROMPTS`: `rewrite-v1.md`,
`rerank-llm-v1.md`, `digest-v1.md`, `abstain-check-v1.md`. Each adapter puts its prompt's hash in
`describe()` (so it is in `cfg:`, as the summarize and no-context prompts are, and never in
`setup:`), and `config.json` lists them under `answer.prompts` or a new `local.prompts` when there
is no answer stage. A change to a prompt is a new file.

### 11.5 Reading the result

`report` already forms a series from one adapter configuration at one tier, answer model, judge
model and commit; the local model and its digest are part of `describe()`, so two local models are
two series. A job is a candidate for the product when it beats its comparison on answer accuracy
without lowering abstain accuracy, on the private set, by more than the run-to-run noise the recall
spec's §6.7 reports. Promoting one is a separate change with its own LongHaul run in the PR.

Smoke run, no model and no network: the four adapters accept an injected fake client
(`{ provider: 'fake', model, local: true, complete() }`, the shape `tests/longhaul-summarize-compact.test.js`
uses) and `--fake-models` supplies one.

## 12. Adapters: the seam (R-LI-15)

Nothing here trains, stores or evaluates an adapter. It fixes three things so that step 6 does not
have to change what L1 built.

### 12.1 How a local model entry names an adapter

A probed model's record (§6.1) holds the adapters the owner or the administrator declared for it:

```json
"adapters": [
  { "id": "titles-1", "job": "title", "ref": "qwen3-titles-1", "baseDigest": "sha256:<hex>",
    "addedAt": "2026-11-02T10:00:00.000Z" }
]
```

- `id`: a slug, unique per model.
- `job`: one of the job ids in §12.4.
- `ref`: what the server calls it.
- `baseDigest`: the base model's digest when the adapter was declared. When the server's digest for
  the base model differs, the adapter is shown as "made for another version" and is not used.

On the desktop adapters are declared in the Models tab; in service mode in the admin block
(`localInference.servers[].adapters`). A declared adapter is probed like a model (the smoke call),
through its `ref`.

### 12.2 How a role selects model plus adapter

A target gains one optional field: `{ provider: 'local', model: 'workstation/qwen3:8b', adapter:
'titles-1' }`. `normalizeTarget` keeps it for `local` targets and drops it elsewhere; `targetKey`
includes it, so the same model with and without an adapter are two entries in a role's list. The
resolver treats it as part of the target: an unknown or stale adapter makes the target unusable with
a reason, and the next target in the list is tried. Usage records carry `adapter`.

### 12.3 Which server kinds can load one

What this repository shows: nothing. No file in `src/` or `tests/` speaks an adapter API of any
server. Everything in this subsection is therefore an **assumption to check** against each server's
own documentation before step 6 is planned (§21, A6):

- that on at least some kinds an adapter is reachable as a model name of its own (so `ref` is sent as
  the request's `model`), and
- that some kinds instead want a field in the request or a server start option.

The seam is one function, `LocalServerProvider#requestModelFor(target)`, which today returns the
adapter's `ref` when the target names one and the model id otherwise. If a kind needs a request
field, that function returns `{ model, extra }` and nothing else moves. A kind for which neither
works simply shows no "add adapter" control.

### 12.4 What step 6 will need from this spec

- **Stable job ids**: `title`, `classify`, `orient`, `rewrite`, `rerank`, `digest`, `abstain-check`.
  The first three exist as calls today; the last four exist only in LongHaul until measured.
- **The private mark on training data.** Any export of a job's inputs and outputs for training must
  carry the chat's or case's mark, and a private chat's text may train only on local hardware. Step
  6 decides the rest of data selection.
- **A job log.** Nothing records a utility call's input and output today beyond usage. Step 6 will
  need an opt-in record per job; this spec only reserves the name (`<dataDir>/models/jobs/`) and the
  rule that it is a secret store for every tool.
- **Evaluation.** LongHaul already compares adapter configurations; an adapter id in `describe()`
  makes a base model and a base model plus adapter two series. Titles, classify and orient have no
  benchmark yet.
- **L2.** A serving node's administrator lists adapters beside models (§14.7), and the usage record
  names the node.
- **Where adapter files live** is the server's business in this spec (no downloads, R-LI-3).

## 13. Interfaces

### 13.1 Settings (desktop)

```jsonc
"models": {
  "localServers": [ /* §5.1 entries; sealed, written only by LocalServers#write */ ],
  "profiles": [
    { "id": "p-…", "name": "Mixed", "kind": "user",
      "roles": {
        "main":    [{ "provider": "anthropic", "model": "claude-opus-5-5", "effort": null }],
        "utility": [{ "provider": "local", "model": "workstation/qwen3:8b", "effort": null },
                    { "provider": "openai", "model": "gpt-5.4-mini", "effort": "low" }]
      },
      "localOnly": [] }
  ]
}
```

`localOnly` lists role ids of that profile. `history.embedder` is unchanged; the keep-local embedder
(§8.4) has no setting of its own beyond `history.embedder.model`'s default.

### 13.2 IPC

| Channel | Does | Notes |
|---|---|---|
| `models:local.list` | Servers, their address class, pin, guarantee grade, models with probe results | |
| `models:local.add` | Checks the address, pins, saves, probes | Desktop window only; service: `LOCAL_SERVER_ADMIN_ONLY` |
| `models:local.remove` | Removes a server | Refused while a profile names one of its models (the reply lists them), as custom roles are |
| `models:local.recheck` | Resolves again, shows old and new addresses; the owner confirms a new pin | |
| `models:local.probe` | Probes one model again | |
| `models:local.setModelInfo` | Owner-entered context, image input, adapters | |
| `models:local.fromOllama` | Q10 (a): makes a local server from `models.ollama.baseUrl`; a second call rewrites profile targets | |
| `chat:markPrivate` | §8.1 | Returns the confirmation's facts first (`{ confirm: false }`), marks on `{ confirm: true }` |
| `case:markPrivate` | §8.1, §8.2 | Same two-step shape |
| `models:profiles.*` (existing) | Carries `localOnly` | A save may add a role to it; removing one needs `models:local.unsetLocalOnly`, a window-only channel |

`models`, `chat` and `case` are already in `PROXIED_DOMAINS`. Every reply that carries a server's
name, a model's name or a probe's reply text is marked `untrustedText: true` (§15).

### 13.3 The admin `service.json`

```json
{
  "profile": "agent",
  "features": { "gateway": false, "webhooks": false, "mesh": false, "channels": false, "appDiscovery": false, "desktopBridge": false },
  "ports": { "gateway": 18793, "webhook": 18794, "desktopBridge": 18796 },
  "localInference": {
    "servers": [
      { "id": "workstation", "name": "Workstation", "kind": "ollama",
        "baseUrl": "http://127.0.0.1:11434", "maxConcurrent": 2 },
      { "id": "lan-box", "name": "LAN box", "kind": "vllm",
        "baseUrl": "https://gpu-box.example.com:8443",
        "tlsFingerprint": "<64 hex characters>", "key": "${vault:local.lan-box}" }
    ]
  }
}
```

- `localInference` joins `ADMIN_ONLY_KEYS`; `parseLocalInferenceConfig` rejects unknown keys with
  the same message as `features` and `playbooks`. Known server keys: `id`, `name`, `kind`,
  `baseUrl`, `addresses`, `tlsFingerprint`, `allowCgnat`, `maxConcurrent`, `timeoutMs`, `key`,
  `adapters`.
- No block (the default) means no local server in service mode.
- No feature and no port is added: L1 opens no listener, so `DEFAULT_FEATURES` and `DEFAULT_PORTS`
  do not change and the example `service.json` files stay valid as they are. `examples/fleet/` holds
  five of them (`frontdoor`, `gpu-box`, `laptop`, `mac`, `web-01`), not the four `CLAUDE.md` says.
- An example is added to `examples/fleet/gpu-box/service.json` with a loopback server only.
  `tests/helpers/example-denylist.js` allows `127.0.0.1`, `0.0.0.0` and the documentation ranges and
  nothing else, and the documentation ranges are public addresses that §5.2 refuses, so an example
  cannot show a LAN IP literal. A LAN example uses an `example.com` host name with a fingerprint
  placeholder. `loadServiceConfig` checks the block's shape and any IP literal in it; a host name is
  resolved and pinned at service start, not at load, so `tests/examples.test.js` loads the example
  without a resolver.

### 13.4 `node.yaml` (L2)

A new top-level key, appended to `NODE_YAML_KEYS` in the same change that parses it:

```yaml
inference:
  serve:
    enabled: true
    models:
      - server: workstation        # an id from service.json localInference.servers
        model: qwen3:8b
      - server: workstation
        model: qwen3:8b
        adapter: titles-1
    max_concurrent: 2
  use:
    enabled: true
```

Both halves default to off. The allow list and the trusted servers are not in `node.yaml`; they are
admin-owned files the CLI writes (§14.3, §14.7).

### 13.5 CLI

| Command | Does |
|---|---|
| `king-louie-service models status` (existing) | Also lists local servers, their address class and grade, and which failed the check |
| `king-louie-service models probe <server> [<model>]` | Probes; the service may be running |
| `king-louie-service inference offer` (L2) | Prints this node's offer line: name, `node_id`, public key, from the identity record |
| `king-louie-service inference allow <offer> --requests-per-day <n> --tokens-per-day <n> [--models a,b] [--max-concurrent n]` (L2, serving node, as the administrator) | Shows the name and key fingerprint, asks `[y/N]`, writes `<configDir>/inference/clients/<node_id>.json` |
| `king-louie-service inference trust <offer> [--as <server-id>]` (L2, consuming node, as the administrator) | Same prompt, writes `<configDir>/inference/servers/<node_id>.json` |
| `king-louie-service inference list`, `inference remove <node-id>` (L2) | Both lists; removal takes effect at the next request |
| `npm run smoke:local` | §19.4 |

Off a TTY the two writing commands need `--yes`, as `desktop pair` does.

### 13.6 Refusal codes

L1 (errors carry `code`; the message is the owner-facing sentence):

| Code | When |
|---|---|
| `LOCAL_ADDRESS_PUBLIC` | A server's address, or one of the addresses its name resolves to, is not an allowed class |
| `LOCAL_ADDRESS_MISMATCH` | The connected socket's address is not a pinned one |
| `LOCAL_REDIRECT` | A local server answered 3xx |
| `LOCAL_TLS_MISMATCH` | The certificate does not match `tlsFingerprint` |
| `LOCAL_SERVER_UNKNOWN` | A target names a server that is not configured |
| `LOCAL_SERVER_ADMIN_ONLY` | A change to local servers was tried in service mode |
| `LOCAL_CLOUD_MODEL` | An Ollama cloud id on a local server |
| `LOCAL_MODEL_UNAVAILABLE` | Every local target for the call failed, under a policy |
| `PRIVATE_NO_LOCAL_MODEL` | A private chat's or case's role has no local model the guarantee accepts |
| `LOCAL_ONLY_ROLE_NO_MODEL` | A local-only role has none |
| `PRIVATE_HOSTED_TARGET` | The router was handed a hosted target under a policy |
| `PRIVATE_HOSTED_CALL` | A hosted client was asked to send under a policy (a provider, an embedder, the image or voice client) |
| `PRIVATE_CHAT_BUSY` | Marking while a turn runs |
| `PRIVATE_BRIDGE_CHAT` | Marking a bridge chat |
| `PRIVATE_CASE_REQUIRED` | Attaching a private chat to a case that is not private, without the confirmation |
| `PRIVATE_NO_DELEGATE` | A fleet acting tool in a private chat |
| `PRIVATE_ONE_WAY` | Anything that tries to clear a mark |

LongHaul: `LOCAL_REQUIRED`, `LOCAL_CALLS_MISSING`. L2 wire codes are in §14.8.

## 14. Stage L2: a node serves the owner's other nodes

One node (the **serving node**) offers local models its administrator listed. Another node (the
**consuming node**) uses them as a local server of kind `node`. Requests travel
consuming node → hub → serving node over the links both already hold to the same hub, sealed between
the two nodes. Off by default on every node and on the hub.

L2 is for service nodes (Q6 as recommended). An attached desktop gets it through its service; a
standalone desktop does not.

### 14.1 The seam L1 leaves

| L1 piece | What L2 adds without changing it |
|---|---|
| A local server entry has a `kind` and the registry hands out `transportFor(id)` (§5.1, §5.4) | `kind: 'node'`, with a transport of the same `fetch` shape that carries one HTTP exchange over `inference-v1` |
| `LocalServerProvider` only ever sees a `fetch` and a `Response` | Nothing: it parses the same OpenAI-compatible stream |
| The address classes include `node` (§5.2), guarantee-grade by §5.3 | The class a trusted node's entry gets |
| `llmMetrics.local` is an object (§9.1) | `node` and `nodeName` in it; the by-server usage table gains a node column |
| The probe goes through the transport (§6.1) | A node's models are listed and probed the same way |
| The target is `local/<serverId>/<model>` (D-LI-1) | The server id is the trusted node's `server_id` |
| `localInference` is an admin-only block (§13.3) | The serving node offers only models on servers named there |
| Refusal codes are a closed list (§13.6) | The wire codes of §14.8 map onto `LOCAL_MODEL_UNAVAILABLE` |

### 14.2 What each party knows today

- A node holds one Ed25519 signing key and pins exactly one other key: its hub's
  (`approvals.relay` after `pair`, or the admin-owned `front-door.json`). It knows no other node.
- A hub knows every node paired to it, with its public key (`<dataDir>/relay/nodes.json`; the front
  door's `NodeRegistry`).
- Nothing in `src/` agrees a key between two parties. Nothing on a hub forwards a node's message to
  another node.

So L2 needs three new things: a way for two nodes to learn and pin each other's key, forwarding on
the hub, and a sealed channel. The hub is not trusted for any of them beyond delivery.

### 14.3 Trust: an administrator step on each side

The hub could hand each node the other's public key, and a dishonest hub could hand out its own. So
the keys move by hand, once, administrator to administrator:

1. On each node the administrator has an identity record (Q5 as recommended): `king-louie-service
   identity record`. A node whose record state is not `match` neither serves nor uses L2
   (`identity_unrecorded`).
2. On each node, `king-louie-service inference offer` prints one line built from the record:

   ```
   kl-inference-offer:v1:gpu-box:kl-abcdefgh234567ij:<public key, 43 base64url characters>
   ```

3. On the **consuming** node the administrator runs `inference trust <the serving node's line>`. The
   command checks that the `node_id` derives from the key (`deriveNodeId`), shows the name and a
   fingerprint, asks `[y/N]`, and writes `<configDir>/inference/servers/<node_id>.json`:

   ```json
   { "v": 1, "node_id": "kl-abcdefgh234567ij", "public_key": "<43 characters>",
     "name": "gpu-box", "server_id": "gpu-box", "trusted_at": "2026-11-20T10:00:00.000Z" }
   ```

4. On the **serving** node the administrator runs `inference allow <the consuming node's line>` with
   the limits, and gets `<configDir>/inference/clients/<node_id>.json`:

   ```json
   { "v": 1, "node_id": "kl-klmnopqr234567st", "public_key": "<43 characters>", "name": "laptop",
     "models": ["workstation/qwen3:8b"],
     "limits": { "requests_per_day": 2000, "tokens_per_day": 2000000, "max_concurrent": 1,
                 "max_request_bytes": 8388608, "max_output_tokens": 4096 },
     "allowed_at": "2026-11-20T10:05:00.000Z" }
   ```

Both directories are admin-owned and read-only to the service, under the rules the `approvers/`
directory already has (the service cannot create a file there; the owner checks on Windows;
`src/service/ownership.js`). The service re-reads them when their change time moves. The hub's copy
of a key is never the source of one.

The trust statement is the administrator's: "this is a node I control". The app verifies that the
node on the other end holds the key the administrator pinned. It cannot verify who owns the machine,
exactly as L1 cannot verify who owns a marked server.

### 14.4 The hub forwards, and nothing more

Two new node messages, on both kinds of hub (the F3 relay and the front door):

| Message | Kind | Hub does |
|---|---|---|
| `inference.open` | call | Checks that forwarding is on, the sender is a paired, connected node, and `to` is another paired, connected node; calls `inference.open` on the target with `{ from: <the sender's node_id, as the hub authenticated it>, envelope }`; returns the target's answer |
| `inference.frame` | notification | Forwards `{ from, session, frame }` to `to` under the same checks |

- Forwarding is off unless the hub's administrator turns it on: `relay.inference.forward` in the
  relay host's admin `service.json`, `frontdoor.inference.forward` in the front door's `node.yaml`
  (a new key under `FRONTDOOR_KEYS`).
- The hub keeps no session. It counts forwarded bytes per sending node per minute against
  `inference.max_bytes_per_minute` and drops beyond it; the per-link frame rate and buffer limits
  `MeshTransport` already has (200 frames a second, 8 MiB buffered) apply unchanged.
- Frames are notifications because link RPC calls have one answer and a 10 s default timeout.
- No MCP tool, no scope and no `FleetRouter` route is added. An OAuth client of the front door has
  no path to a node's models.
- On the node, the two methods are registered on `RelayClient` by a new `NodeInferenceService`
  (`src/fleet/inference/`), not through `NodeFleetService.dispatch`, which exists for front-door
  origins with grant scopes.

### 14.5 `inference-v1`

To be written as `docs/protocol/inference-v1.md`, in the form of the other protocol documents. What
it fixes:

**Handshake.** Two signed messages in `approval-v1` envelopes (`{ alg: "Ed25519", kid: <node_id>,
payload, sig }`, the payload RFC 8785 bytes, the signature over exactly those bytes, never
re-canonicalised):

```json
{ "v": 1, "type": "kl.inference.open", "session": "<16 bytes>", "from": "kl-klmn…", "to": "kl-abcd…",
  "eph": "<X25519 public key, 32 bytes>", "nonce": "<32 bytes>", "signed_at": "2026-11-20T10:10:00Z" }

{ "v": 1, "type": "kl.inference.accept", "session": "<same>", "from": "kl-abcd…", "to": "kl-klmn…",
  "eph": "<32 bytes>", "nonce": "<32 bytes>", "open_hash": "<SHA-256 of the open payload bytes>",
  "max_frame": 262144, "credit": 32, "idle_s": 120, "signed_at": "2026-11-20T10:10:00Z" }
```

A refusal is `kl.inference.refuse` with `session`, `open_hash`, `code` and optional `retry_after`,
signed the same way, so the consuming node can tell "the serving node said no" from "the hub said
no".

Checks, each a refusal: the envelope's `kid` equals `from`; the signature verifies under the key
pinned for `from` (the allow list on the serving node, the trusted server file on the consuming
node); `to` is this node; the hub-stamped `from` equals the signed `from`; `v` is 1; the fields have
their exact lengths; `open_hash` matches. `signed_at` is recorded and never judged, as in
`approval-v1`.

**Keys.** Each side makes a fresh X25519 pair per session.

```
dh         = X25519(own ephemeral private, peer's ephemeral public)      # all-zero output refuses
transcript = SHA-256(open payload bytes ‖ accept payload bytes)
okm        = HKDF-SHA256(ikm = dh, salt = transcript, info = "kl-inference-v1 keys", 64 bytes)
k_cs = okm[0..32]    # consuming → serving
k_sc = okm[32..64]   # serving → consuming
```

The node ids, both ephemeral keys and both nonces are in the transcript and under the signatures, so
a hub that swaps a key breaks a signature, and a session cannot be re-bound to another node. The
long-term keys only sign; a session's keys are gone when it closes.

**Frames.** The `frame` field is base64url of `seq (8 bytes, big endian) ‖ ciphertext ‖ tag (16
bytes)`: AES-256-GCM, `iv = dir ‖ 00 00 00 ‖ seq`, `aad = "kl-inference-v1" ‖ session ‖ dir ‖ seq`,
`dir` 0x01 for consuming → serving and 0x02 for the other way. This is the construction
`createSealer` and `createOpener` already implement for `kl-session-v1`, with a session id in the
associated data; the code is shared in a small module with the label as a parameter, and
`kl-session-v1`'s bytes do not change (its vectors must still match).

- `seq` starts at 1 and must be the last one plus 1. Anything else closes the session
  (`seq_gap`): a dropped, repeated or reordered frame is detected, never repaired.
- Plaintext is at most `max_frame` bytes (256 KiB, which fits the 1 MiB link frame after base64 and
  the signed mesh envelope).
- A session ends after `idle_s` without a frame, after one hour, or at 2^32 frames in a direction.

**Inside a frame.** The first byte is a type: 0x01 a JSON control message, 0x02 a body chunk
(`id (16 bytes) ‖ index (4 bytes) ‖ bytes`).

| Control message | From | Fields |
|---|---|---|
| `list` | consuming | Asks for the models this client may use |
| `models` | serving | `[{ model, context, toolCall, imageInput, adapters }]`, filtered to the client's allow entry |
| `req` | consuming | `id`, `model`, `adapter`, `body_len`, `stream`; then the body as chunks |
| `ok` | serving | `id`, `status`; then the response body as chunks |
| `refuse` | serving | `id`, `code`, `retry_after` |
| `credit` | consuming | `id`, `n`: the serving node may send `n` more chunks |
| `cancel` | consuming | `id` |
| `end` | serving | `id`, `outcome`, `usage: { input, output, estimated }`, `ms` |
| `ping`, `pong`, `close` | both | `close` carries a code |

**One exchange.** The request body is the OpenAI-compatible chat completions JSON the consuming
node's `LocalServerProvider` built. The serving node does not proxy it: it parses it, keeps only a
fixed list of top-level keys (`messages`, `tools`, `tool_choice`, `temperature`, `max_tokens`,
`stream`, `stream_options`, `response_format`, `stop`, `seed`), clamps `max_tokens` to the client's
`max_output_tokens`, replaces `model` with its own id for the offered model (or the adapter's
`ref`), and sends it to its own local server at the fixed path `/v1/chat/completions` through its
own pinned transport. The response body comes back as chunks, and the consuming side's transport
turns `ok` plus chunks into a `Response`.

**Back-pressure.** Chunks are credit-based. `accept` grants the first `credit` (32); the consuming
side grants more as its reader consumes. With no credit the serving node stops reading from its
local server. It coalesces what the server streams into a chunk every 50 ms or 32 KiB, whichever
comes first, which also keeps a token-by-token stream well under the link's frame rate. A request
with no credit for 30 s ends `stalled`.

**Stop.** The consuming node's abort signal (the same `options.abortSignal` every provider call
carries) sends `cancel`. The serving node aborts its request to the local server and answers `end`
with `outcome: "cancelled"` and what usage it has. Two timers cover a hub that drops the `cancel`:
the consuming node pings every 10 s while a request is open, and the serving node aborts every open
request of a session that has sent it nothing for 30 s; the consuming node closes a session whose
`end` does not arrive within 5 s of a `cancel`. A link that drops closes every session on it and
aborts their requests. So Stop reaches the serving node at once when the hub delivers it, and within
30 s when it does not.

**Replay of `open`.** The serving node remembers each `(from, session, nonce)` for ten minutes and
refuses a repeat (`replay`). Older than that, a replayed `open` costs one handshake and produces
keys the sender cannot derive. Handshakes are limited per client per minute on their own counter, so
a hub that replays cannot spend a client's daily request limit; a request counts when its `req`
opens under the session keys.

### 14.6 What the hub can see and do

| | |
|---|---|
| **Sees** | Which two nodes talk, when, for how long; the number, size and timing of frames in each direction (so roughly how long a prompt and a reply were); the handshake's public values |
| **Does not see** | Prompts, replies, tool definitions, model names, adapter names, usage numbers, refusal codes inside a session |
| **Can do** | Drop, delay, repeat or reorder frames; refuse to forward; drop a `cancel`; replay an old `open` |
| **Detected** | A repeat, a reorder or a drop inside a session (`seq_gap`, the session closes and the call fails); a changed handshake (signature); a forged refusal (signature) |
| **Not preventable** | Delay and denial of service. A dropped `cancel` lets the serving node run up to 30 s longer |
| **Cannot do** | Read or change content undetected; pose as either node; make the serving node serve a node that is not on its allow list |

This is R-LI-21's third residual, with its bounds.

### 14.7 The serving node

- **What it offers:** the `inference.serve.models` list in `node.yaml` (§13.4), each naming a server
  from the admin `localInference` block and a model (and optionally an adapter) on it. It offers
  only a guarantee-grade server of its own (§5.3). It never offers a `node` server (no chaining) and
  has no way to offer a hosted model.
- **Who may use it:** a node with a file in `inference/clients/`, for the models that file lists.
- **Limits, per client:** `requests_per_day` and `tokens_per_day` (input plus output, as the local
  server reported them, or estimated and marked so), `max_concurrent`, `max_request_bytes`,
  `max_output_tokens`. Counters are in `<dataDir>/inference/usage.json`, per client and local day,
  under a mutex, and keep their day until it rolls over, as the executors' daily counter does. A
  request is counted before it is sent to the local server and its tokens when it ends; a request
  that would pass a limit is refused with `retry_after` seconds to the day's end.
- **What it keeps:** counters and audit entries. No prompt or reply text is written to disk or to a
  log by King Louie. What the local server itself logs is outside the app (§18).
- **Its own load:** `inference.serve.max_concurrent` bounds all clients together; beyond it, `busy`
  with `retry_after: 5`, the shape `delegate` uses.

### 14.8 Wire codes

Lower-case, as the fleet's are. From the hub: `forward_disabled`, `unknown_node`, `offline`,
`rate_limited`. From the serving node, in a signed refusal or inside a session:
`identity_unrecorded`, `not_allowed`, `serve_disabled`, `replay`, `version`, `model_not_offered`,
`rate_limited` (with `retry_after`), `token_limit` (with `retry_after`), `busy`, `too_large`,
`bad_request`, `upstream_failed`, `stalled`, `seq_gap`.

On the consuming node every one of them is a failed call to a local target: without a policy the
router fails over along the list and the cost line names the node and the code; under a policy the
call fails `LOCAL_MODEL_UNAVAILABLE` with the code in the message.

### 14.9 Audit entries

Appended with `AuditLedger#append` on both nodes, writer `service`. None carries prompt or reply
text.

| Kind | Node | Data |
|---|---|---|
| `inference.session` | both | `peer`, `session`, `event: opened \| closed`, `reason`, `frames`, `bytes` |
| `inference.request` | both | `peer`, `session`, `request` (the id), `model`, `adapter`, `input_tokens`, `output_tokens`, `estimated`, `ms`, `outcome` |
| `inference.refused` | both | `peer`, `code`; on the serving node also for a node that is not on the list |
| `inference.trust` | the node whose administrator ran the command, writer `cli` | `peer`, `action: trust \| allow \| remove`, the limits |

One entry per request is what makes the daily limits accountable. A front door that mirrors a
node's ledger receives these like any other entry, which tells it nothing §14.6 did not.

### 14.10 What "private" means with a second machine (R-LI-19)

A local model is one that runs on hardware the owner controls. In L2 the owner says so twice, as an
administrator on each node, and the app proves the rest: that the far end holds the pinned key and
that nothing in between can read. A private chat on the consuming node may therefore use a trusted
node's model. The serving node's administrator can read what that node is asked to run, because it
runs it; when that administrator is someone else, the owner's trust statement was wrong and no
protocol repairs it. The trust prompt says this in one line.

The usage record on the consuming node carries `local: { server, class: 'node', node, nodeName }`;
the reply's cost line reads "local (gpu-box)". The serving node's own usage totals count the request
under the client's name.

### 14.11 Vectors

`tests/vectors/inference-v1/` with `keys.json` (two fixed Ed25519 node keys, fixed ephemeral X25519
keys and nonces) and `generate.js`; `--check` prints `N vectors match`. They cover: a valid `open`,
`accept` and `refuse`; each handshake check failing (a `kid` that is not `from`, a wrong `to`, a
signature under another key, a changed byte, a wrong `open_hash`, a wrong version, a short field);
the key schedule's outputs; an all-zero shared secret; frames sealed and opened in both directions;
a frame opened under the wrong direction, session or sequence; the first-byte types; a body split
into chunks. The only consumer is the node, so there are no phone reference implementations.

## 15. UI

Every string that comes from a server, a model, a probe reply, a node's offer or a case is set with
`textContent`, never `innerHTML` or markdown; the IPC replies that carry one say
`untrustedText: true`, as the playbook replies do. A test fails on `innerHTML` in the new renderer
code for the local servers card, as `tests/longhaul-verify-web.test.js` does for its page.

| Place | What shows |
|---|---|
| Settings → Models, a "Local servers" card | Each server: name, address as typed, the pinned address, its class in words ("this machine", "your network", a node's name), whether a private chat may use it and why not, "Check again", "Remove". "Add a local server" opens the dialog with the mark's sentence and R-LI-21's sentence (§5.5). In service mode or attached the card is read-only and says the administrator sets it |
| The same card, per model | The probe's results in words: context, tools yes / no / not known, image input, first token and speed, "runs on Ollama's cloud" for a cloud id, "Probe again", an owner-entered context, adapters |
| Every model picker | A "local" badge beside a local model, with the server's name; in a private chat's pickers hosted models are listed disabled with "not local" |
| The profile cards | A role's local-only switch; a role whose list mixes local and hosted says "fails over to a hosted model"; a role that is local-only and empty says what will be refused |
| The chat header | A "Private" mark (a lock and the word) once set; before that, "Make private…" in the chat's menu and in the new-chat menu |
| The chat list | The lock on private chats |
| Under the composer, in a private chat | One line, always: "Private: model calls stay on your hardware. Tools still send what they send." |
| The confirmation dialog | The facts of §8.1, read from the host |
| The case panel | The same mark and menu entry for a case; envelope and delta cards carry the line of §8.2 |
| A reply's cost line | "local (Workstation)" segments, the failover note of §9.3, "local · 3,104 tokens · $0.00" |
| The recall line and the scope menu | `vectorsSkipped: 'private-chat'` and `rerankSkipped: 'private-chat'` in words; a private chat that an ordinary chat can no longer read is listed with the reason |
| Settings → Recall | The keep-local embedder's state when a hosted embedder is configured (§8.4) |
| Settings → Usage | Local calls and tokens beside cost; by server; in L2 by node |
| A refused turn | The sentence for its code (§13.6), with a button to Settings → Models when a model is missing |
| The import dialog | "Import as private" |
| Settings → Local service (attached) | Nothing new; the service's servers show in the Models card |

## 16. Security and trust

### 16.1 Threats

| # | Threat | Answer |
|---|---|---|
| T1 | DNS rebinding: a name that passed the check later answers with a public address | The app never resolves at request time; it dials the pinned address (§5.2 rule 4) and checks the socket (rule 5) |
| T2 | A name that answers with a LAN and a public address | Refused when added: every answer must be allowed (rule 3) |
| T3 | IPv6 spellings of a public or special address (v4-mapped, NAT64, 6to4, a zone id) | Classified from parsed bytes; mapped addresses unwrapped; NAT64 and 6to4 are public; link-local refused (rules 1, 2) |
| T4 | The cloud metadata address, or another link-local service, added as a "local server" | Link-local is refused in both families |
| T5 | A redirect that carries the request body to another host | No 3xx is followed (rule 6) |
| T6 | A proxy from the environment in the path | The local transport uses its own agent; the socket check holds if that fails (rule 7) |
| T7 | A hosts file or resolver changed by other software on the machine | Out of scope: it needs the rights the owner's own account has. The pin limits it to the moment of adding or re-checking, and the dialog shows the address |
| T8 | A prompt injection adds or re-points a local server, or unmarks a chat | No tool reaches the settings or history stores (`SECRET_FILE_PREFIXES`); the key is sealed (§5.6); marking is a window press with no inverse (§8.1). `Bash` is the residual |
| T9 | The model names a hosted model for a sub-agent or a retry in a private chat | `requireInProfile` already holds a named model to the profile; the resolver's filter and the router's check then refuse a hosted one (§7.2) |
| T10 | Failover reaches a hosted model after a local one fails | Under a policy the list holds no hosted target, and the router refuses one if it is handed one |
| T11 | A model call that never passes the router | The provider-level refusal, the per-caller changes of §7.5, and the inventory test (§7.6) |
| T12 | A hosted embedder or reranker receives a private chat's text | The store's `localOnly` filter, the query rule, `keepLocalReason` (§8.4) |
| T13 | Another chat recalls a private chat into a hosted model's prompt | The scope rule (§8.3). Text recalled before the mark stays where it was copied (§18) |
| T14 | A pinned LAN address is another machine on another network | Q9: a private chat needs a pinned certificate for anything but loopback |
| T15 | A hostile server on the LAN answers with tool calls or instructions | It is a model's output like any other: tool approvals, the outbound gate and the untrusted-text rules are unchanged. The owner marked it |
| T16 | The probe is used to make the app send requests into the LAN | Only the owner (desktop) or the administrator (service) can add a server; a probe sends fixed strings |
| T17 | A compromised renderer presses "Add" or "Make private" | It can press what the owner can press, as everywhere in the app; it cannot unmark, and it cannot add a server that fails the check |
| T18 | The mark is set while a turn is mid-flight | Refused while a turn runs (`PRIVATE_CHAT_BUSY`) |
| T19 | A `$0` hosted call hides spend | Only `local` (and the existing Ollama rule) is $0 (§9.1); an unknown hosted model stays unpriced |
| T20 | L2: the hub substitutes a key to read the traffic | The ephemeral keys are signed by keys the administrators pinned by hand (§14.3, §14.5) |
| T21 | L2: the hub replays, reorders, drops or repeats | Detected inside a session; a replayed `open` is refused or useless; delay and denial are not preventable (§14.6) |
| T22 | L2: the hub or a third node spends a client's daily limit | Requests count only under session keys; handshakes have their own per-minute limit |
| T23 | L2: a node that is not on the allow list, or an OAuth client, asks for inference | A signed refusal; no MCP route exists |
| T24 | L2: the serving node used as an open proxy into its LAN | A fixed path, a parsed body with a fixed key list, its own pinned transport, only offered models (§14.5) |
| T25 | L2: a serving node passes requests on to a hosted model or another node | It can offer only its own guarantee-grade local servers (§14.7); what those servers do is R-LI-21 |
| T26 | L2: the service account rewrites the allow list or the trusted servers | Admin-owned directories the service cannot write, with the `approvers/` rules; the identity record (Q5) |
| T27 | L2: a consuming node's service account is compromised | It can use that node's daily limit and read that node's own prompts; it cannot raise the limit or reach models not allowed to it |
| T28 | L2: one session's keys are used to pose as another node or in another session | Both node ids are signed and in the key derivation; the session id is in every frame's associated data |

### 16.2 What a mark does and does not promise

**The local mark on a server** promises that King Louie sends to the address it pinned and nowhere
else. It does not promise what that server does with the text.

**The private mark** promises that every model call King Louie itself makes for that chat or case
goes to a guarantee-grade local server or is refused. It does not cover:

- what a tool sends (a web search, a fetch, the browser, a message, an executor's gated payload,
  `Bash`);
- what was sent before the mark;
- text the owner copies out, exports, or that an earlier recall already copied into another chat;
- what the owner's local server does.

Both lists are in the dialogs, in these words or shorter ones.

## 17. Error handling

| Situation | Behaviour |
|---|---|
| A local server is unreachable at start | It stays configured; its models are unusable with the reason; retried by the existing staleness rule |
| A server fails its address check at start (a name now resolves to a public address) | On the desktop the stored pin is kept and used, and the card says the name "resolves differently now"; in service mode, where the pin is made at start, the server is left out with an error |
| A probe fails | The model is listed with the error and `unknown` capabilities; it can be placed, and `explain` says it was not probed |
| The registry cannot be read (a damaged settings entry) | No local server; private chats and local-only roles refuse; nothing falls back to a hosted model |
| The egress policy cannot be read for a chat (the store is closed or the row is missing) | The turn is refused: an unknown mark is treated as private |
| A case's `case.yaml` cannot be parsed | As today (the case does not load); no turn runs |
| The keep-local embedder cannot start | Private chats are BM25 only, with one warning per episode, as an embedder failure is reported today |
| `markPrivate` fails after deleting vectors but before setting the mark | It cannot: both are in one transaction |
| L2: the hub link is down | The node's models are unusable with `offline`; calls fail or fail over by §9.3 |
| L2: a session breaks mid-reply | The call fails with what was streamed marked partial; it is never resumed and, under a policy, never retried on a hosted model. A stream that already emitted a chunk is not retried at all, as today |
| L2: the allow list or a trusted file is unreadable or fails its ownership check | That peer is not served, or not used; one warning; `doctor` has a row for each directory |

A host with no local server configured behaves exactly as it does today: no new warning, no new
prompt, and a profile's empty `localOnly` list changes nothing.

## 18. Residuals

Accepted by the owner (R-LI-21):

- A local server that itself forwards to the cloud cannot be detected. Only the Ollama cloud id
  convention is caught.
- Tool calls in a private chat can still send text out.
- In L2 the relay sees that inference happens and how much.

Following from the design, stated so nobody is surprised:

- **`Bash`.** A shell command can rewrite the settings store, `history.sqlite`, `case.yaml`, the
  probe file and, on a desktop, a local server's entry or a chat's mark. This is the stage 1 gap,
  unchanged. In service mode the local servers, the allow list and the trusted nodes are admin-owned
  and out of the service account's reach.
- **Plain `http` on a LAN** (if Q9 is ruled (a)): the pinned address proves a place, not a machine.
- **What was sent stays sent**, and text an ordinary chat recalled from a chat before it was marked
  stays in that chat.
- **A hosted embedder's provider may keep what it was sent**; dropping the vectors removes the local
  copy only.
- **The local server's own logs** on any machine, and the serving node's administrator in L2, can
  hold the text.
- **Quality.** A private case runs its judge loop and its verify pass on whatever local model the
  owner placed in `main`. Nothing here measures that.
- **A private case's title** is shown in the app's lists and returned by the management tools; only
  its text is withheld.
- **Usage a server does not report** is estimated; a daily token limit in L2 is then approximate.
- **L2 delay.** A hub that drops a `cancel` keeps the serving node busy for up to 30 s.
- **Existing log lines** were not audited for message text (§21).
- **Only the Windows x64 package** has been checked for the embed worker; the keep-local embedder
  inherits that.

## 19. Testing

No unit test touches the network or a real model.

### 19.1 Helpers

- `tests/helpers/fake-llm-server.js` already speaks the OpenAI-compatible and Ollama dialects on
  loopback (`/api/tags`, `/api/show`, chat completions). It gains: a model list for `/v1/models`, a
  3xx answer, a reply with and without usage, a slow first token, a tool-call reply and a text-only
  reply to a tool request.
- `tests/helpers/profile-settings.js` gains `localTarget(server, model)` and `withLocalOnly(roles)`.
- A fake resolver (`lookup`) injected into the registry, so name tests never query DNS. Addresses
  that must be refused are never dialled; the ones that are dialled are loopback.
- `tests/helpers/test-certs.js` for the `https` and fingerprint cases.
- `tests/helpers/history-fixture.js` and `FakeEmbedRunner` for the embedding rules.
- `tests/helpers/fake-node.js`'s `createFakeHub`, extended with the two forwarding messages and with
  drop, repeat, reorder and delay switches, and two real `NodeInferenceService`s behind it.
- `tests/helpers/ingest-harness.js` with a scripted `callModel` for the ingest rows.

### 19.2 L1 tests (by file, one line each)

- `local-address.test.js`: every class, every spelling in T3, the documentation ranges as public.
- `local-servers.test.js`: add, pin, re-check, a name with mixed answers, the sealed key, service
  mode ignoring data-dir settings with one warning, `LOCAL_SERVER_ADMIN_ONLY` over the bridge.
- `local-transport.test.js`: the pinned lookup, the socket check, 3xx, a proxy variable set in the
  environment, the fingerprint, abort while queued and mid-stream.
- `local-probe.test.js`: each step, each failure, a cloud id.
- `egress-resolver.test.js`: the filter, borrowing among local targets only, the override, an
  explicit target, both error codes.
- `egress-router.test.js`: a hosted target under a policy never reaches `fetch`; failover with and
  without a policy; `failoverFrom`.
- `egress-callers.test.js`: one case per row of §7.5, each with only hosted models configured and a
  server that fails the test if it is called.
- `egress-inventory.test.js`: §7.6.
- `private-mark.test.js`: the store column, one-way, store-only, the confirmation's facts, the
  refusals of §8.2, case and chat together.
- `private-scope.test.js`: the policy rule against `resolveScope`, `SearchHistory`, `ReadHistory`.
- `private-embeddings.test.js`: vectors dropped in the marking transaction, the keep-local embedder,
  the query rule, Jev skipped.
- `local-usage.test.js`: `local` on metrics, $0, not unpriced, the case budget, the totals, an
  `ollama` call unchanged, an unknown hosted model still `null`.
- `service-config-local.test.js`, and `tests/examples.test.js` for the new example block.
- `longhaul-local-*.test.js`: the local client and its refusal, the four adapters with a fake
  client, cache-only in the answer stage, the leak rule for digests, no `--send-private` needed.
- e2e (`tests/e2e/local-private.test.js`): add a server (the fake one), place a model, mark a chat,
  send a turn with a hosted main configured and see the refusal, then with a local main and see the
  reply and its cost line.

### 19.3 L2 tests

- `inference-v1-vectors.test.js`: `generate.js --check`.
- `inference-handshake.test.js`, `inference-frames.test.js`: every check and every hub misbehaviour
  in T20 to T22.
- `inference-serving.test.js`: the allow list, each limit and its `retry_after`, the body key list,
  no chaining, no text in the ledger or the log.
- `inference-consuming.test.js`: a `node` server through the registry, streaming, credit, Stop with
  and without a delivered `cancel`, a broken session, failover with and without a policy.
- `inference-hub.test.js`: forwarding off by default, the checks, the byte limit, on both hub kinds.
- `service-cli-inference.test.js`: `offer`, `trust`, `allow`, `list`, `remove`, the prompts, `--yes`.
- `inference-e2e.test.js`: real processes, a hub and two nodes on loopback with test certificates,
  on Windows or as root, as `tests/approvals-e2e.test.js` runs.

### 19.4 The smoke script

`scripts/smoke-local.js`, run as `npm run smoke:local`, like `smoke:providers` and never part of
`npm test`: with `KL_SMOKE_LOCAL_URL`, `KL_SMOKE_LOCAL_KIND` and `KL_SMOKE_LOCAL_MODEL` set it adds
the server in a temporary data dir, runs the address check and the probe, streams one reply, makes
one tool call and prints what the probe found. It costs nothing and needs a real local server.

## 20. Build order

### 20.1 Stage L1

| # | Task | One line |
|---|---|---|
| L1-1 | Address classes | `local-address.js`: the classifier, the resolve-and-pin step, its tests |
| L1-2 | The pinned transport | `local-transport.js`, and `BaseLLMProvider#request` using an instance's transport |
| L1-3 | The registry and the provider | `local-servers.js`, `LocalServerProvider`, the `local` key in `explainTarget` and the router's instances |
| L1-4 | Config authority | The sealed settings key and IPC on the desktop; `localInference` in the admin `service.json`, `ADMIN_ONLY_KEYS`, the example |
| L1-5 | The probe and the catalog | Probe steps, `local-probes.json`, `setLocalModels('local', …)`, the cloud id rule |
| L1-6 | The egress policy in the resolver and the router | `egress.js`, `localOnly` on profiles, the filter, the fail-closed check, the provider-level refusal |
| L1-7 | The private mark | Schema step 5, `markPrivate`, `case.yaml` `private`, the two IPC channels, the refusals of §8.2 |
| L1-8 | The callers outside the router | Ingest, the context assembler, compaction, image generation, voice, `delegate`; the inventory test |
| L1-9 | Recall | The scope rule, the embedding rules, the keep-local embedder, Jev's reason |
| L1-10 | Usage | `local` on metrics and events, the reply's line, the totals, the case budget, `failoverFrom` |
| L1-11 | UI | The local servers card, badges, the mark and its dialog, the composer line, the refusal messages |
| L1-12 | LongHaul | The local client, the four adapters, their prompts and caches |
| L1-13 | The adapter seam | The `adapter` field on a target, the declared adapters, `requestModelFor` |
| L1-14 | Smoke, docs, the full suite | `smoke:local`, `CLAUDE.md`, the install guide, one `npm test` and `npm run test:e2e` |

L1-1 to L1-6 are in order; L1-7 to L1-13 can follow in any order after L1-6, with L1-8 and L1-9
before the stage is called done, because the guarantee is not true without them.

### 20.2 Stage L2

| # | Task | One line |
|---|---|---|
| L2-1 | The protocol document and vectors | `docs/protocol/inference-v1.md`, `tests/vectors/inference-v1/` |
| L2-2 | Handshake and key schedule | Signed `open`, `accept`, `refuse`; X25519; HKDF |
| L2-3 | Frames | The shared sealer with a label and a session id; sequence rules; the inner types |
| L2-4 | Hub forwarding | The two messages on the relay and the front door, their switches and the byte limit |
| L2-5 | Trust files and the CLI | `offer`, `trust`, `allow`, `list`, `remove`; the directory rules; the identity record check |
| L2-6 | `node.yaml` | The `inference` key in `NODE_YAML_KEYS`, the example on `gpu-box` |
| L2-7 | The serving node | `NodeInferenceService`: offers, the body rules, its transport to the local server |
| L2-8 | Limits | The counters, the refusals, `retry_after` |
| L2-9 | The consuming transport | `kind: 'node'` in the registry, sessions, `Response` from chunks |
| L2-10 | Flow control and Stop | Credit, coalescing, `cancel`, the two timers, link loss |
| L2-11 | Audit and usage | The four kinds, `node` in `local`, the by-node totals, `doctor` rows |
| L2-12 | UI, docs, end to end | The node's name in the card and the cost line, `docs/fleet/`, `inference-e2e` |

### 20.3 Deferred

- Padding or cover traffic in L2.
- Comparing the four recall jobs against a hosted model of the same size.
- Private memory entries (Q11 (c)); an embedder on a local server as "local" (Q4 (c)).
- A standalone desktop as an L2 client (Q6).
- A way to tell which machine holds a LAN address without TLS.
- Speech to text (none exists); a local image model.
- Adapter training, storage and evaluation (step 6).
- A benchmark for titles, classify and orient.

## 21. Assumptions and what was not verified

Assumptions about software outside this repository. Each is checked in the plan before the task
that leans on it; none is stated as fact above.

| # | Assumption | If it is wrong |
|---|---|---|
| A1 | A request made with an explicit `node:http` or `node:https` agent ignores `HTTP_PROXY`, `HTTPS_PROXY` and `NODE_USE_ENV_PROXY`, on Node 22, Node 24 and Electron 41's main process. (`src/frontdoor/oauth/cimd.js` already says it avoids those variables for its own fetch, and `embed-runner.js` passes them to its child on purpose.) | §5.2 rule 5 still refuses a connection whose remote address is not pinned; the transport would also have to clear the proxy for its agent |
| A2 | A WHATWG URL cannot carry an IPv6 zone id, so a link-local IPv6 server could not be typed anyway | Link-local stays refused by rule 2; nothing else changes |
| A3 | Ollama, LM Studio, a llama.cpp server and vLLM each answer `GET /v1/models` and `POST /v1/chat/completions` in the OpenAI shape. Only Ollama's use is in this repository (`OllamaProvider`, the fake server) | That kind's list comes from the owner typing model ids; the smoke call still tells whether chat works |
| A4 | Some of them report a context size in their model listing | Context is `unknown` and owner-entered for that kind |
| A5 | A local model's first call after idle can take longer than 15 s | `timeoutMs` is unused |
| A6 | How each server kind loads an adapter (§12.3) | The one function of §12.3 changes |
| A7 | The bundled Node's `crypto` has X25519 key agreement and HKDF (nothing in `src/` uses either today) | L2 would need a dependency; the protocol is unchanged |
| A8 | A streamed OpenAI-compatible reply can be asked to end with a usage record, and each kind honours it | Tokens are estimated (§9.1 rule 4) |
| A9 | An Ollama server reports a digest per model | The digest is absent and a re-pulled tag is not noticed |

Read in the code, but not all the way:

- That every bridge and gateway turn reaches `createAgentRuntime` with a snapshot that knows its
  chat. A bridge chat cannot be private, so this matters only for the inventory test.
- Which code calls `MemoryManager#capture*` during a chat turn.
- Whether an agent-panel run (`snapshotModels({})` in `src/ipc/agent-handlers.js`) can be started
  from a chat. If it can, it needs that chat's id.
- Whether the gateway exposes any call that saves settings. None was found by a search for
  `setSettings`; the sealed key covers it either way.
- Whether the F3 relay host and the front door build their hub through the same code.
  `registerNodeMethods` is called from one place (`src/frontdoor/relay.js`); whether both hosts go
  through it was not read. L2-4 treats them as two places until shown otherwise.
- How `FailoverPolicy` classifies a refused connection and a failed name lookup (§10).
- Whether existing log lines carry message text.
- The case `verify` role's caller: stage 8 is specified on `spec/cases-c8`, not on `main`.

Differences from `CLAUDE.md` found while reading: `examples/fleet/` has five `service.json` files;
the case budget's comment that real providers report `costUsd: 0` for an unknown model no longer
matches `buildLlmCallMetrics`, which reports `null`.

## 22. Where the approved design is harder than it sounds

1. **"Enforced in the router" covers most calls, not all.** Ingest holds a provider instance
   directly; the context assembler and the loop's compaction send the owner's message and old tool
   results to `api.openai.com` through a client that never passes `BaseProvider.request`; image
   generation and ElevenLabs have their own clients; the embedder is process-wide. §7.2 adds a
   provider-level refusal, §7.5 changes each caller, §7.6 keeps the list honest.
2. **The router has no idea what chat it serves.** The policy has to be frozen into `TurnModels`
   and carried by every child run; any snapshot built without its chat is a hole.
3. **"The sealed `kl-session-v1` channel" cannot carry this.** It is a local pipe protocol with a
   pre-shared secret. Two nodes share no secret and no code agrees one. L2 is a new protocol with its
   own key agreement (§14.5).
4. **"The existing pinned hub links" end at the hub.** No hub forwards between nodes and link RPC
   has no stream. L2 changes both hubs (§14.4).
5. **A node knows no other node.** Pinning needs an administrator step on each side (§14.3), and
   arguably the identity record on both (Q5).
6. **$0 already exists, and is not tied to "local".** Any non-cloud `ollama` id is $0 at any
   address, and the case budget reads a $0 call with tokens as unpriced. §9 separates "free" from
   "local" and teaches the budget the difference.
7. **A target's provider must be one of the 14, with one instance per provider.** Many local servers
   under one key need the model id to carry the server and the router to key instances by server
   (§5.1).
8. **"Rebuilt locally" needs two embedders at once** when the owner's configured embedder is hosted
   (Q4). `EmbedderHost` holds one.
9. **An imported chat's query still goes to a hosted embedder today.** A private chat must not do
   that, so the query path gains a rule the import rule never had (§8.4).
10. **The example rules and the address rules disagree.** The examples may show only loopback and
    the documentation ranges; the documentation ranges are public, which the check refuses. LAN
    examples have to be host names (§13.3).
11. **A pinned LAN address is not a machine** (Q9), and overlay-network addresses sit in a range
    that is not private in the usual sense (Q8).
12. **The three per-question recall jobs do not fit LongHaul's model-call plan**, which is built for
    per-session setup calls. They follow the Jev adapters' two-run convention instead (§11.2).
13. **A private chat can leak without any model call by King Louie**: through memory, a delegate
    session on another node, and the case tools over MCP (Q11).
14. **Private needs a capable local `main` in a case**, although judging on a local model is not a
    goal (§7.4).

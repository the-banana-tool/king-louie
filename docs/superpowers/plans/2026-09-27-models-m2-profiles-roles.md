# Models M2: Profiles and Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fast/standard/smart tiers, smart routing and the LLM router with named profiles of role assignments (main, worker, utility, plus specialist and custom role keys), a resolver that only picks usable models the owner placed in a role, a per-turn frozen snapshot, per-chat and per-case main overrides with a header switcher and "Retry with…", a one-time migration of the tier settings, and the API keys and Models settings tabs.

**Architecture:** Four new Electron-free modules under `src/models/`: `roles.js` (role names, tier→role map, target normalization), `profiles.js` (the `Profiles` store over `settings.models`, validation, `snapshot()`), `resolver.js` (`createTurnModels()` → a frozen `TurnModels` whose `resolve(role, { needs, explicit })` filters by usability and borrows or falls back per spec §6.4) and `migrate-tiers.js` (the §13 migration, stale model ids included). `InferenceRouter` becomes a thin consumer: `routeTargets()` walks a resolved target list with `FailoverPolicy` under the §6.7 same-provider rule, and `routedProvider()` wraps that as a provider object. `create-core.js` runs the migration at construction and exposes `snapshotModels()`, `resolveRole()` and `explainTarget()`; every model call site (chat, cases, headless agent runs, ingest) resolves through them. A new `src/core/model-choices.js` holds the between-turn choices (profile picker, main override, profile deletion) behind thin `models:*` IPC channels; the renderer gains the API keys and Models tabs, the header switcher and Retry with…. The tier code is deleted last, once nothing calls it.

**Tech Stack:** Node 22 (`structuredClone`, `AbortSignal`), `node:test`, Electron renderer (plain DOM), `js-yaml` for case.yaml, Playwright `_electron` for e2e.

**Spec:** `docs/superpowers/specs/2026-09-27-model-catalog-profiles-roles-design.md` (stage M2, §18). Sections in force: §3 (Profiles and `TurnModels`), §6 entirely, §9 "Retry with…", §11 (API keys tab; Models tab Profiles and Catalog parts; the chat and case header), §13 entirely, §14 (`models.profiles`, `models.defaultProfileId`, `models.customRoles` as data only, `models.roleTimeoutsMs`; per chat `profileId`/`mainOverride`; per case `profile`/`mainOverride`), §15 rows for profiles, overrides, unknown roles, cross-provider failover and migration, §16 resolver and migration tests, §17.1 rows as they concern M2. Stage M1 (`docs/superpowers/plans/2026-09-27-models-m1-catalog-availability.md`) has landed; this plan builds on the code as it is.

**Not in this plan (stage M3):** moving call sites to utility, worker and specialists beyond what is written here (chat titles, advisor, SpawnAgent `role`, image tool, per-agent roles in parallel agent runs), the explorer and delegation, per-role cost records and the per-role cost line, the King Louie profile and its suggester, the custom roles UI, and the `models`/`profiles` service commands.

## Global Constraints

- Tests run with node's built-in runner: `npm test` (`node --test --test-timeout=120000 tests/*.test.js`) or `node --test tests/<file>.test.js`. Never `jest`. Look for `# fail 0` in the TAP summary. The implementer runs only the test files a task names; the controller runs the full suite at stage end.
- `npm test` must pass at the end of every task. A task that changes a shared contract updates every existing test that exercises it, in the same task; each such file is listed under the task's **Files**.
- Everything under `src/` stays Electron-free except `src/ipc/`; `tests/electron-boundary.test.js` enforces it. `src/models/` and `src/core/model-choices.js` are covered.
- Log through `createLogger` from `src/logging.js`; never bare `console.*` in `src/`.
- Open source: no personal names, machine names, domains or home paths in code, tests, fixtures or docs. Shipped profile names are generic ("Migrated settings", "Default").
- Unit tests never touch the network: inject `fetch`, use `tests/helpers/fake-llm-server.js` and the fixture catalog (`tests/helpers/models-fixture.js`).
- Settings keys and defaults, verbatim from spec §14 (M2 subset): `models.profiles: []`, `models.defaultProfileId: null`, `models.customRoles: []` (data model only; its UI is M3), `models.roleTimeoutsMs: { main: 90000, worker: 30000, utility: 15000 }`. Every key merges through `mergeSettings`.
- Per chat (chat store): `profileId` (absent means the default profile) and `mainOverride` (a Target, or absent). Per case (`case.yaml`): `profile` and `mainOverride`, listed in `CASE_YAML_KEYS` as owned by `'M2'`.
- Profile shape (spec §6.1): `{ id: 'p-…', name, kind: 'user' | 'king-louie' | 'migrated', roles: { main: Target[], worker: Target[], utility: Target[], vision?: Target[], imageGeneration?: Target[], '<custom-slug>'?: Target[] } }`; a migrated profile also carries `migration: { at, notes: string[] }`. A `Target` is `{ provider, model, effort }`, `effort` being one of the catalog's reasoning efforts for that model, or `null`.
- Roles (spec §6.2): core `main`, `worker`, `utility` (every profile has them); specialist `vision`, `imageGeneration` (optional); custom roles are lowercase slugs matching `/^[a-z][a-z0-9-]{1,39}$/` that do not collide with a built-in role.
- Tier → role (spec §13 steps 3–5): `fast → utility`, `standard → worker`, `smart → main`. Case roles (spec §8, M-D6): `orient`, `classify → utility`; `draft → worker`; `judge`, `verify → main`, verify on another provider family than judge (`providerFamily` in `src/cases/roles.js`, kept).
- Precedence (spec §6.3): an explicit target on the call; else the case's profile with the case's main override; else the chat's profile with the chat's main override; else the default profile. An explicit target is still checked for usability.
- Nothing picks a model outside the resolved list (M-D2): no hardcoded fallback providers, no provider default as a silent substitute.
- Frozen at launch (spec §6.6): a `TurnModels` is built once per turn; a switch or settings change during a run applies to the next turn.
- Failover (spec §6.7): another target of the same provider on any call; another provider only before the routed provider's first successful call; otherwise the turn fails with the reason. `FailoverPolicy` and `error-classifier.js` are kept.
- Migration (spec §13): runs once at core construction when `models.profiles` is absent or empty; writes the new keys before removing the old ones; a failure leaves the old settings untouched, is logged, and is retried at the next start. It removes exactly `activeProvider`, `providerModels`, `inference.activeTier`, `inference.tierMap`, `inference.timeoutsMs`, `inference.smartRouting`, `inference.llmRouting`, `inference.agentLoopModel`, `advisor.model`, `cases.ingest.vision` (the whole `inference` object goes: every key in it is on that list).
- Status message on a main switch (spec §6.5), in this shape: `Main model switched from <name> to <name>`, a name being the catalog entry's `name`, else the model id.
- `/llm model <provider> <model>` becomes `/llm profile <name>` (spec §13).

## Review Focus

1. A chat or case names a profile id that no longer exists (deleted in another window, a hand-edited settings file, a desktop import): expected the default profile answers and a warning is logged, never a crash or an empty main (Task 2 test `an unknown profile id falls back to the default`; Task 5 test `snapshotModels falls back to the default for a stale chat profileId`).
2. The owner switches main (or edits the profile) while a turn runs: expected the running turn keeps the models it launched with and the next turn uses the new choice (Task 8 test `a main switch during a run applies to the next turn`).
3. The first start after upgrading dies between the migration's two writes, or the migration runs twice: expected exactly one migrated profile, legacy keys ignored or removed, never a second "Migrated settings" (Task 3 test `running the migration twice creates one profile`).
4. A case's `mainOverride` names a provider whose key was removed after the switch: expected the case turn fails before any call with the reason, never a silent fall back to the profile's main (Task 7 test `an unusable case main override fails the resolve with the reason`).
5. A profile entry arrives with odd case or spacing, repeats a model, or has an empty model: expected a lowercase provider, trimmed ids, duplicates dropped, an empty model refused with a clear message (Task 1 tests on `normalizeProfile`).

## Interpretations and deviations

Choices this plan makes where the spec is silent or M1's code differs from its description; each is a line a reviewer can overturn.

1. A fresh install (no `activeProvider`, `providerModels` or `inference` stored) gets a "Default" profile (`kind: 'user'`) whose `main` lists each provider's own default model in the app's provider order (Ollama's empty default skipped), with `worker` and `utility` empty so they borrow from main; the first provider the owner adds a key for answers.
2. The migration report is the migrated profile's `migration: { at, notes }`, shown on its card in the Models tab and logged; no new settings key, no chat status message.
3. A stale saved id is mapped only when it is in neither the catalog nor the account's stored model list, never for Ollama; the family is the one catalog `family` that is the longest prefix of the id, and the new id is that family's newest by `releaseDate` (the undated alias over its dated twin); a tie or missing dates keep the id, with a note.
4. An "empty" core role means no entries configured. A role whose entries are all unusable does not borrow; it fails with each reason.
5. A provider registered at runtime outside the 14 (a host extension, a test fake) is usable when it has a credential, since it has no connection test.
6. Headless and agent runs use the agent's `role` on the default profile. Built-in agents name theirs (main-assistant, planner, code-writer → main; code-explorer, case-researcher → worker); only a user-defined agent without a `role` has its `inferenceTier` mapped (fast → utility, standard → worker, smart → main). `agent:executeParallel`/`executeSerial` run on main with one shared routed provider; per-agent roles there are M3.
7. A caller naming a provider with no model gets that provider's model from the profile, else the run fails naming the provider; a model with no provider keeps the role's first provider.
8. The chat title and the advisor run on the turn's main list in M2 (the advisor has to: §13 removes `advisor.model`; titles move to utility in M3).
9. `effort` is stored, checked against the catalog's efforts and passed to providers as `options.effort`; no provider sends it to its API yet.
10. Retry with… sits on the last reply (stopped or not). It truncates first, then sets the override (so its status message lands before the re-sent message), then re-sends; if the switch fails, the user message is put back and nothing is sent.
11. Cross-provider failover is allowed until the routed provider's first successful call (one routed provider per conversation history: a chat turn's loop, a case role, a headless run); an auth failure skips that provider's remaining targets.
12. In a case chat the chat's own `mainOverride` is ignored; `case.yaml`'s applies (the header writes there). `case.yaml` `roles` entries may name a model role (`{ role: 'utility' }`) as well as a tier or an explicit target; the case defaults are now role names; an entry with a provider and no model warns and uses its role.
13. `cases.ingest.vision` goes (§13 step 6), so case ingest OCR reads the profile's vision role through `CaseRuntime#visionTarget` in this stage (the rest of §8's vision call sites are M3).
14. The send path no longer reports provider errors itself (the router reports each auth failure against the provider that failed), and `chat:messageError` carries an `action` (`use-profile-main`, `open-models`) for the one-click fixes.
15. Custom roles are data and resolution only here (`Profiles#customRoles()` reads them); their create/update/remove and editor are M3.
16. A desktop import stops copying `activeProvider`, `providerModels` and `inference` (reported `skip-excluded`); importing profiles is not added.
17. The Models tab's catalog part saves through a new `models:saveCatalogSettings` channel; the refresh interval is limited to 1–720 hours.
18. The migration keeps the old keys (`removeLegacy: false`) from Task 5 until Task 12, because the chat, case and agent paths read the tiers until Tasks 6–8 move them; Task 12 turns the removal on. An import dry run's core skips the migration (`skipModelMigration`), since a dry run must write nothing.

---

## File Structure

New, Electron-free:

| File | Responsibility |
|---|---|
| `src/models/roles.js` | Role names and kinds, `TIER_TO_ROLE`, `ROLE_NEEDS`, `DEFAULT_ROLE_TIMEOUTS_MS`, `roleForTier`, `roleForAgent`, `isCustomRoleId`, `normalizeTarget`, `targetKey`, `targetLabel` |
| `src/models/profiles.js` | `ProfileError`, `normalizeProfile`, `normalizeCustomRole`, `class Profiles` (CRUD over `settings.models`, effort checks, `snapshot()`), `snapshotFromSettings()` |
| `src/models/resolver.js` | `createTurnModels()` → frozen `TurnModels` (`resolve`, `mustResolve`, `candidatesFor`, `configuredFor`), `UnknownRoleError`, `NoUsableModelError`, `roleTimeoutMs()` |
| `src/models/migrate-tiers.js` | `LEGACY_DEFAULTS`, `needsMigration`, `mapStaleTarget`, `migrateTierSettings`, `stripLegacyKeys`, `runTierMigration` |
| `src/models/profile-view.js` | `profileView()`: a profile with each entry's name, usability, reasons, price, context and efforts, for the editor |
| `src/core/model-choices.js` | `createModelChoices()`: the chat header view, profile picker, main override, the model picker, profile deletion moving chats and cases |

Modified: `src/models/index.js`, `src/models/availability.js` (`refreshForUse`), `src/core/settings.js`, `src/providers/inference-router.js`, `src/providers/failover-policy.js` (`NO_RETRY`), `src/agents/agent-executor.js`, `src/core/create-core.js`, `src/ipc/agent-handlers.js`, `src/ipc/chat-handlers.js`, `src/ipc/models-handlers.js`, `src/ipc/settings-handlers.js`, `src/ipc/constants.js`, `src/cases/roles.js`, `src/cases/defaults.js`, `src/cases/case-runtime.js`, `src/cases/case-store.js`, `src/cases/detours/classifier.js`, `src/cases/ingest/index.js`, `src/cases/ingest/settings.js`, `src/cases/ingest/vision.js`, `src/execution/agent-loop.js`, `src/diagnostics/fixit.js`, `src/migration/desktop-import.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`.

Deleted: `src/providers/llm-router.js`, `src/providers/smart-routing.js`, `src/ipc/settings-provider.js`; tests `tests/inference-router.test.js`, `tests/smart-routing.test.js`, `tests/llm-router.test.js`, `tests/settings-provider.test.js`, `tests/e2e/inference-tiers.test.js`.

New tests: `tests/models-profiles.test.js`, `tests/models-resolver.test.js`, `tests/models-migrate.test.js`, `tests/inference-router-targets.test.js`, `tests/models-core-profiles.test.js`, `tests/models-headless.test.js`, `tests/chat-profiles.test.js`, `tests/model-choices.test.js`, `tests/models-profiles-ipc.test.js`, `tests/renderer-models-m2.test.js`, `tests/e2e/models-profiles.test.js`; helper `tests/helpers/profile-settings.js`.

Task order: the data model (1), resolver (2) and migration (3) are pure; the router (4) adds the target-list path beside the old tier path; the core (5) wires profiles and the migration in; headless callers (6), cases (7) and the chat send path (8) move onto the resolver one at a time; the model choices and IPC (9) back the two renderer tasks (10, 11); only then (12) is the tier code deleted, when nothing calls it.

---
## Task 1: Roles and the profile data model

**Files:**
- Create: `src/models/roles.js`, `src/models/profiles.js`
- Modify: `src/models/index.js` (exports), `src/core/settings.js:6-7` (requires) and `:84-90`, `:175-193` (the `models` default and merge)
- Test: `tests/models-profiles.test.js` (new), `tests/core-settings.test.js` (one test added)

**Interfaces:**
- Consumes: `createLogger` (`src/logging.js`); the fixture catalog (`tests/helpers/models-fixture.js`) in tests; `Catalog#get(provider, id) → Entry|null` with `entry.reasoning.efforts: string[]`.
- Produces:
  - `src/models/roles.js`: `CORE_ROLES = ['main','worker','utility']`, `SPECIALIST_ROLES = ['vision','imageGeneration']`, `BUILTIN_ROLES`, `TIER_TO_ROLE = { fast:'utility', standard:'worker', smart:'main' }`, `ROLE_NEEDS = { vision: { imageInput: true } }`, `DEFAULT_ROLE_TIMEOUTS_MS = { main: 90000, worker: 30000, utility: 15000 }`, `isCoreRole(r) → boolean`, `isBuiltinRole(r) → boolean`, `isCustomRoleId(id) → boolean`, `roleForTier(tier) → role|null`, `roleForAgent(agent) → role` (agent.role, else its `inferenceTier` mapped, else `'worker'`), `normalizeTarget(raw) → Target|null`, `targetKey(t) → 'provider:model'`, `targetLabel(t) → 'provider/model'`.
  - `src/models/profiles.js`: `ProfileError` (`code` one of `BAD_PROFILE`, `BAD_NAME`, `BAD_KIND`, `BAD_ID`, `BAD_ROLE`, `BAD_TARGET`, `BAD_EFFORT`, `DUPLICATE_NAME`, `NOT_FOUND`, `LAST_PROFILE`), `PROFILE_KINDS`, `normalizeProfile(raw, { requireId = true }) → Profile`, `normalizeCustomRole(raw) → CustomRole|null` (`{ id, description, needs: { toolCall?, imageInput?, minContext? }, fallback: core role }`), `class Profiles({ getSettings, setSettings, catalog = null, createId })` with `list() → Profile[]`, `get(id) → Profile|null`, `defaultId() → string|null`, `getDefault() → Profile|null`, `create({ name, kind = 'user', roles = {}, migration }) → Profile`, `update(id, { name?, roles? }) → Profile`, `duplicate(id, { name? }) → Profile`, `remove(id) → { removed: Profile, defaultProfileId }`, `setDefault(id) → id`, `customRoles() → CustomRole[]`. Task 2 adds `snapshot()` and `snapshotFromSettings()`.
  - `mergeSettings(x).models` gains `profiles: []`, `defaultProfileId: null`, `customRoles: []`, `roleTimeoutsMs: { main: 90000, worker: 30000, utility: 15000 }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-profiles.test.js`:

```js
// tests/models-profiles.test.js
// Profiles and roles (spec 2026-09-27 §6.1, §6.2): the data model, its
// validation and the store over settings.models.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { Profiles, normalizeProfile, normalizeCustomRole, ProfileError } = require('../src/models/profiles');
const { roleForTier, roleForAgent, normalizeTarget, isCustomRoleId, TIER_TO_ROLE, targetLabel } = require('../src/models/roles');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { mergeSettings } = require('../src/core/settings');

function memorySettings(initial = {}) {
  let settings = mergeSettings(initial);
  return { getSettings: () => settings, setSettings: (next) => { settings = mergeSettings(next); }, peek: () => settings };
}

function makeProfiles(initial = {}, extra = {}) {
  let n = 0;
  const mem = memorySettings(initial);
  const profiles = new Profiles({ getSettings: mem.getSettings, setSettings: mem.setSettings, createId: () => `id${++n}`, ...extra });
  return { profiles, mem };
}

const codeOf = (fn) => {
  try { fn(); } catch (err) { assert.ok(err instanceof ProfileError, `expected a ProfileError, got ${err}`); return err.code; }
  return null;
};

const target = (provider, model, effort = null) => ({ provider, model, effort });

describe('model roles', () => {
  it('maps tiers and agents onto roles', () => {
    assert.deepStrictEqual({ ...TIER_TO_ROLE }, { fast: 'utility', standard: 'worker', smart: 'main' });
    assert.strictEqual(roleForTier('Smart'), 'main');
    assert.strictEqual(roleForTier('bogus'), null);
    assert.strictEqual(roleForAgent({ inferenceTier: 'fast' }), 'utility');
    assert.strictEqual(roleForAgent({ role: 'main', inferenceTier: 'fast' }), 'main');
    assert.strictEqual(roleForAgent({ role: 'legal-drafting' }), 'legal-drafting');
    assert.strictEqual(roleForAgent({}), 'worker');
    assert.strictEqual(roleForAgent(null), 'worker');
  });

  it('normalizes a target', () => {
    assert.deepStrictEqual(normalizeTarget({ provider: ' OpenAI ', model: ' gpt-5.5 ', effort: 'low' }), target('openai', 'gpt-5.5', 'low'));
    assert.deepStrictEqual(normalizeTarget({ provider: 'openai', model: 'gpt-5.5', effort: '' }), target('openai', 'gpt-5.5'));
    assert.strictEqual(normalizeTarget({ provider: 'openai', model: '' }), null);
    assert.strictEqual(normalizeTarget({ model: 'gpt-5.5' }), null);
    assert.strictEqual(normalizeTarget(null), null);
    assert.strictEqual(targetLabel(target('openai', 'gpt-5.5')), 'openai/gpt-5.5');
  });

  it('accepts custom role ids that are lowercase slugs and not built-in', () => {
    assert.strictEqual(isCustomRoleId('legal-drafting'), true);
    assert.strictEqual(isCustomRoleId('main'), false);
    assert.strictEqual(isCustomRoleId('vision'), false);
    assert.strictEqual(isCustomRoleId('imagegeneration'), false);
    assert.strictEqual(isCustomRoleId('Legal'), false);
    assert.strictEqual(isCustomRoleId('x'), false);
    assert.strictEqual(isCustomRoleId(7), false);
  });
});

describe('normalizeProfile', () => {
  it('fills the core roles, keeps specialist and custom roles, dedupes and lowercases', () => {
    const p = normalizeProfile({
      id: 'p-1',
      name: '  Anthropic only ',
      roles: {
        main: [{ provider: 'Anthropic', model: 'claude-sonnet-4-5' }, { provider: 'anthropic', model: ' claude-sonnet-4-5 ' }],
        vision: [{ provider: 'openai', model: 'gpt-5.5' }],
        'legal-drafting': [{ provider: 'openai', model: 'gpt-5.4', effort: 'high' }]
      }
    });
    assert.deepStrictEqual(p, {
      id: 'p-1',
      name: 'Anthropic only',
      kind: 'user',
      roles: {
        main: [target('anthropic', 'claude-sonnet-4-5')],
        worker: [],
        utility: [],
        vision: [target('openai', 'gpt-5.5')],
        'legal-drafting': [target('openai', 'gpt-5.4', 'high')]
      }
    });
  });

  it('keeps a migration record', () => {
    const p = normalizeProfile({ id: 'p-1', name: 'Migrated settings', kind: 'migrated', roles: {}, migration: { at: '2026-09-27T00:00:00.000Z', notes: ['a note'] } });
    assert.deepStrictEqual(p.migration, { at: '2026-09-27T00:00:00.000Z', notes: ['a note'] });
    assert.strictEqual(p.kind, 'migrated');
  });

  it('refuses bad input with a code and a message', () => {
    assert.strictEqual(codeOf(() => normalizeProfile(null)), 'BAD_PROFILE');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: '   ' })), 'BAD_NAME');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x'.repeat(81) })), 'BAD_NAME');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', kind: 'boss' })), 'BAD_KIND');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', roles: { Main: [] } })), 'BAD_ROLE');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', roles: { main: {} } })), 'BAD_ROLE');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', roles: { main: [{ provider: 'openai' }] } })), 'BAD_TARGET');
    assert.strictEqual(codeOf(() => normalizeProfile({ name: 'x' })), 'BAD_ID');
    assert.strictEqual(normalizeProfile({ name: 'x' }, { requireId: false }).id, null);
    try {
      normalizeProfile({ id: 'p', name: 'x', roles: { main: [{ provider: 'openai', model: '' }] } });
    } catch (err) {
      assert.match(err.message, /Every model in role "main" needs a provider and a model/);
    }
  });

  it('normalizes a custom role, or drops it', () => {
    assert.deepStrictEqual(
      normalizeCustomRole({ id: 'legal-drafting', description: ' Contracts ', needs: { toolCall: true, minContext: 100000, other: 1 }, fallback: 'worker' }),
      { id: 'legal-drafting', description: 'Contracts', needs: { toolCall: true, minContext: 100000 }, fallback: 'worker' }
    );
    assert.strictEqual(normalizeCustomRole({ id: 'main', fallback: 'worker' }), null);
    assert.strictEqual(normalizeCustomRole({ id: 'legal-drafting', fallback: 'vision' }), null);
  });
});

describe('Profiles', () => {
  it('creates, lists and makes the first profile the default', () => {
    const { profiles, mem } = makeProfiles();
    assert.deepStrictEqual(profiles.list(), []);
    assert.strictEqual(profiles.defaultId(), null);
    const a = profiles.create({ name: 'Anthropic only', roles: { main: [target('anthropic', 'claude-sonnet-4-5')] } });
    assert.strictEqual(a.id, 'p-id1');
    assert.strictEqual(profiles.defaultId(), 'p-id1');
    const b = profiles.create({ name: 'Cheap' });
    assert.strictEqual(profiles.defaultId(), 'p-id1', 'a second profile does not take the default');
    assert.deepStrictEqual(profiles.list().map((p) => p.id), [a.id, b.id]);
    assert.deepStrictEqual(profiles.get(b.id).roles, { main: [], worker: [], utility: [] });
    assert.strictEqual(mem.peek().models.defaultProfileId, 'p-id1');
  });

  it('falls back to the first profile when the stored default names none', () => {
    const { profiles } = makeProfiles({ models: { profiles: [{ id: 'p-a', name: 'A', roles: {} }], defaultProfileId: 'p-gone' } });
    assert.strictEqual(profiles.defaultId(), 'p-a');
    assert.strictEqual(profiles.getDefault().name, 'A');
  });

  it('updates, refuses duplicate names, duplicates with a free name', () => {
    const { profiles } = makeProfiles();
    const a = profiles.create({ name: 'Work' });
    profiles.create({ name: 'Home' });
    const updated = profiles.update(a.id, { roles: { worker: [target('openai', 'gpt-5.4')] } });
    assert.deepStrictEqual(updated.roles.worker, [target('openai', 'gpt-5.4')]);
    assert.strictEqual(updated.name, 'Work');
    assert.strictEqual(codeOf(() => profiles.update(a.id, { name: 'home' })), 'DUPLICATE_NAME');
    assert.strictEqual(codeOf(() => profiles.create({ name: 'WORK' })), 'DUPLICATE_NAME');
    assert.strictEqual(codeOf(() => profiles.update('p-none', { name: 'x' })), 'NOT_FOUND');
    const copy = profiles.duplicate(a.id);
    assert.strictEqual(copy.name, 'Work copy');
    assert.strictEqual(copy.kind, 'user');
    assert.deepStrictEqual(copy.roles, updated.roles);
    assert.strictEqual(profiles.duplicate(a.id).name, 'Work copy 2');
  });

  it('removes a profile and moves the default; never the last one', () => {
    const { profiles } = makeProfiles();
    const a = profiles.create({ name: 'A' });
    const b = profiles.create({ name: 'B' });
    const r = profiles.remove(a.id);
    assert.strictEqual(r.removed.id, a.id);
    assert.strictEqual(r.defaultProfileId, b.id);
    assert.strictEqual(profiles.defaultId(), b.id);
    assert.strictEqual(codeOf(() => profiles.remove(b.id)), 'LAST_PROFILE');
    assert.strictEqual(codeOf(() => profiles.remove('p-none')), 'NOT_FOUND');
    assert.strictEqual(codeOf(() => profiles.setDefault('p-none')), 'NOT_FOUND');
  });

  it('checks an effort against the catalog', () => {
    const { profiles } = makeProfiles({}, { catalog: fixtureCatalog() });
    const ok = profiles.create({ name: 'Efforts', roles: { utility: [target('openai', 'gpt-5.5', 'low')] } });
    assert.strictEqual(ok.roles.utility[0].effort, 'low');
    assert.strictEqual(codeOf(() => profiles.update(ok.id, { roles: { utility: [target('openai', 'gpt-5.5', 'extreme')] } })), 'BAD_EFFORT');
    assert.strictEqual(codeOf(() => profiles.update(ok.id, { roles: { utility: [target('openai', 'gpt-4o', 'low')] } })), 'BAD_EFFORT');
    // A model the catalog does not know keeps whatever effort it was given.
    assert.strictEqual(profiles.update(ok.id, { roles: { utility: [target('openai', 'gpt-private', 'low')] } }).roles.utility[0].effort, 'low');
  });

  it('skips a malformed stored profile with a warning', () => {
    const lines = [];
    const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
    try {
      const { profiles } = makeProfiles({ models: { profiles: [{ id: 'p-bad', name: '' }, { id: 'p-ok', name: 'OK', roles: {} }] } });
      assert.deepStrictEqual(profiles.list().map((p) => p.id), ['p-ok']);
    } finally {
      remove();
    }
    assert.ok(lines.some((l) => l.includes('p-bad')), lines.join('\n'));
  });

  it('reads custom roles, dropping invalid ones', () => {
    const { profiles } = makeProfiles({ models: { customRoles: [{ id: 'legal-drafting', fallback: 'worker' }, { id: 'Bad', fallback: 'main' }] } });
    assert.deepStrictEqual(profiles.customRoles(), [{ id: 'legal-drafting', description: '', needs: {}, fallback: 'worker' }]);
  });
});
```

Append to `tests/core-settings.test.js`, inside the `describe('core settings', …)` block, after the last `it`:

```js
  it('carries the profile keys (spec §14, stage M2)', () => {
    const merged = mergeSettings({});
    assert.deepStrictEqual(merged.models.profiles, []);
    assert.strictEqual(merged.models.defaultProfileId, null);
    assert.deepStrictEqual(merged.models.customRoles, []);
    assert.deepStrictEqual(merged.models.roleTimeoutsMs, { main: 90000, worker: 30000, utility: 15000 });
    const kept = mergeSettings({ models: { profiles: [{ id: 'p-1' }], defaultProfileId: 'p-1', roleTimeoutsMs: { utility: 5000 } } });
    assert.deepStrictEqual(kept.models.profiles, [{ id: 'p-1' }]);
    assert.strictEqual(kept.models.defaultProfileId, 'p-1');
    assert.deepStrictEqual(kept.models.roleTimeoutsMs, { main: 90000, worker: 30000, utility: 5000 });
    const junk = mergeSettings({ models: { profiles: 'nope', customRoles: {}, defaultProfileId: 7 } });
    assert.deepStrictEqual(junk.models.profiles, []);
    assert.deepStrictEqual(junk.models.customRoles, []);
    assert.strictEqual(junk.models.defaultProfileId, null);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-profiles.test.js tests/core-settings.test.js`
Expected: FAIL with `Cannot find module '../src/models/profiles'` and the new core-settings test failing on `merged.models.profiles` being `undefined`.

- [ ] **Step 3: Write `src/models/roles.js`**

```js
// src/models/roles.js
// Model roles (spec 2026-09-27 §6.2): the three core roles every profile
// has, the two optional specialists, and custom roles (lowercase slugs).
// Tier names from before stage M2 read as the mapped role (§13).

const CORE_ROLES = Object.freeze(['main', 'worker', 'utility']);
const SPECIALIST_ROLES = Object.freeze(['vision', 'imageGeneration']);
const BUILTIN_ROLES = Object.freeze([...CORE_ROLES, ...SPECIALIST_ROLES]);
const TIER_TO_ROLE = Object.freeze({ fast: 'utility', standard: 'worker', smart: 'main' });
// What every model in a specialist role must be able to do.
const ROLE_NEEDS = Object.freeze({ vision: Object.freeze({ imageInput: true }) });
const DEFAULT_ROLE_TIMEOUTS_MS = Object.freeze({ main: 90000, worker: 30000, utility: 15000 });
const CUSTOM_ROLE_ID = /^[a-z][a-z0-9-]{1,39}$/;
const BUILTIN_LOWER = BUILTIN_ROLES.map((r) => r.toLowerCase());

const isCoreRole = (role) => CORE_ROLES.includes(role);
const isBuiltinRole = (role) => BUILTIN_ROLES.includes(role);

function isCustomRoleId(id) {
  return typeof id === 'string' && CUSTOM_ROLE_ID.test(id) && !BUILTIN_LOWER.includes(id);
}

function roleForTier(tier) {
  return TIER_TO_ROLE[String(tier || '').trim().toLowerCase()] || null;
}

// An agent's role: its own `role` when it names one, else its
// pre-M2 inferenceTier read as the mapped role (§13 step 5), else worker.
function roleForAgent(agent) {
  const own = typeof agent?.role === 'string' ? agent.role.trim() : '';
  if (own && (isBuiltinRole(own) || isCustomRoleId(own))) return own;
  return roleForTier(agent?.inferenceTier) || 'worker';
}

// { provider, model, effort } with a lowercase provider and trimmed ids, or
// null when either the provider or the model is missing.
function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = String(raw.provider || '').trim().toLowerCase();
  const model = String(raw.model || '').trim();
  if (!provider || !model) return null;
  const effort = typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : null;
  return { provider, model, effort };
}

const targetKey = (t) => `${t.provider}:${t.model}`;
const targetLabel = (t) => (t ? `${t.provider}/${t.model}` : '(none)');

module.exports = {
  CORE_ROLES,
  SPECIALIST_ROLES,
  BUILTIN_ROLES,
  TIER_TO_ROLE,
  ROLE_NEEDS,
  DEFAULT_ROLE_TIMEOUTS_MS,
  isCoreRole,
  isBuiltinRole,
  isCustomRoleId,
  roleForTier,
  roleForAgent,
  normalizeTarget,
  targetKey,
  targetLabel
};
```

- [ ] **Step 4: Write `src/models/profiles.js`**

```js
// src/models/profiles.js
// Profiles (spec 2026-09-27 §6.1): named sets of models assigned to roles,
// stored in settings.models.profiles with settings.models.defaultProfileId
// naming the default. A chat or case picks one; the resolver
// (./resolver.js) turns one into the models a turn may use.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const R = require('./roles');

const log = createLogger('models/profiles');

const PROFILE_KINDS = Object.freeze(['user', 'king-louie', 'migrated']);
const MAX_NAME = 80;
const MAX_TARGETS = 20;

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function normalizeRoleList(list, roleName) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ProfileError('BAD_ROLE', `Role "${roleName}" must be a list of models.`);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const target = R.normalizeTarget(raw);
    if (!target) throw new ProfileError('BAD_TARGET', `Every model in role "${roleName}" needs a provider and a model.`);
    const key = R.targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  if (out.length > MAX_TARGETS) throw new ProfileError('BAD_ROLE', `Role "${roleName}" holds ${out.length} models; the most is ${MAX_TARGETS}.`);
  return out;
}

function normalizeRoles(roles) {
  if (roles !== undefined && roles !== null && !isPlainObject(roles)) throw new ProfileError('BAD_ROLE', 'A profile\'s roles must be an object.');
  const source = roles || {};
  const out = {};
  for (const role of R.CORE_ROLES) out[role] = normalizeRoleList(source[role], role);
  for (const [key, list] of Object.entries(source)) {
    if (R.CORE_ROLES.includes(key)) continue;
    if (R.SPECIALIST_ROLES.includes(key) || R.isCustomRoleId(key)) {
      out[key] = normalizeRoleList(list, key);
      continue;
    }
    throw new ProfileError('BAD_ROLE', `"${key}" is not a model role. Roles are main, worker, utility, vision, imageGeneration, or a custom role id in lowercase letters, digits and dashes.`);
  }
  return out;
}

function normalizeProfile(raw, { requireId = true } = {}) {
  if (!isPlainObject(raw)) throw new ProfileError('BAD_PROFILE', 'A profile must be an object.');
  const name = String(raw.name || '').trim();
  if (!name) throw new ProfileError('BAD_NAME', 'A profile needs a name.');
  if (name.length > MAX_NAME) throw new ProfileError('BAD_NAME', `A profile name is at most ${MAX_NAME} characters.`);
  const kind = raw.kind === undefined || raw.kind === null ? 'user' : raw.kind;
  if (!PROFILE_KINDS.includes(kind)) throw new ProfileError('BAD_KIND', `A profile kind is one of ${PROFILE_KINDS.join(', ')}.`);
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (requireId && !id) throw new ProfileError('BAD_ID', 'A stored profile needs an id.');
  const profile = { id, name, kind, roles: normalizeRoles(raw.roles) };
  if (isPlainObject(raw.migration)) {
    profile.migration = {
      at: String(raw.migration.at || ''),
      notes: Array.isArray(raw.migration.notes) ? raw.migration.notes.map(String) : []
    };
  }
  return profile;
}

// A custom role (spec §6.2): data only in stage M2; its editor is M3.
function normalizeCustomRole(raw) {
  if (!isPlainObject(raw) || !R.isCustomRoleId(raw.id) || !R.isCoreRole(raw.fallback)) return null;
  const n = isPlainObject(raw.needs) ? raw.needs : {};
  const needs = {
    ...(n.toolCall === true ? { toolCall: true } : {}),
    ...(n.imageInput === true ? { imageInput: true } : {}),
    ...(Number.isFinite(n.minContext) && n.minContext > 0 ? { minContext: n.minContext } : {})
  };
  return { id: raw.id, description: String(raw.description || '').trim(), needs, fallback: raw.fallback };
}

class Profiles {
  constructor({ getSettings, setSettings, catalog = null, createId = () => crypto.randomBytes(4).toString('hex') } = {}) {
    if (typeof getSettings !== 'function' || typeof setSettings !== 'function') throw new Error('Profiles needs getSettings() and setSettings().');
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.catalog = catalog;
    this.createId = createId;
  }

  _models() {
    const models = (this.getSettings() || {}).models;
    return isPlainObject(models) ? models : {};
  }

  _write(profiles, defaultProfileId) {
    const settings = this.getSettings() || {};
    this.setSettings({ ...settings, models: { ...(settings.models || {}), profiles, defaultProfileId } });
  }

  list() {
    const stored = Array.isArray(this._models().profiles) ? this._models().profiles : [];
    const out = [];
    for (const raw of stored) {
      try {
        out.push(normalizeProfile(raw));
      } catch (err) {
        log.warn(`Ignoring stored profile ${raw?.id || '(no id)'}: ${err.message}`);
      }
    }
    return out;
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  defaultId() {
    const list = this.list();
    const wanted = this._models().defaultProfileId;
    if (wanted && list.some((p) => p.id === wanted)) return wanted;
    return list[0]?.id || null;
  }

  getDefault() {
    const id = this.defaultId();
    return id ? this.get(id) : null;
  }

  customRoles() {
    const raw = this._models().customRoles;
    return (Array.isArray(raw) ? raw : []).map(normalizeCustomRole).filter(Boolean);
  }

  _checkName(name, exceptId = null) {
    const lower = name.toLowerCase();
    if (this.list().some((p) => p.id !== exceptId && p.name.toLowerCase() === lower)) {
      throw new ProfileError('DUPLICATE_NAME', `A profile named "${name}" already exists.`);
    }
  }

  // An effort must be one the catalog lists for that model (spec §6.1). A
  // model the catalog does not know keeps whatever effort it was given.
  _checkEfforts(profile) {
    if (!this.catalog) return;
    for (const [role, list] of Object.entries(profile.roles)) {
      for (const t of list) {
        if (!t.effort) continue;
        const entry = this.catalog.get(t.provider, t.model);
        if (!entry) continue;
        const efforts = Array.isArray(entry.reasoning?.efforts) ? entry.reasoning.efforts : [];
        if (!efforts.includes(t.effort)) {
          throw new ProfileError('BAD_EFFORT', `${t.model} in role "${role}" does not offer the effort "${t.effort}"${efforts.length ? `; it offers ${efforts.join(', ')}` : '; it has no effort setting'}.`);
        }
      }
    }
  }

  create({ name, kind = 'user', roles = {}, migration } = {}) {
    const profile = normalizeProfile({ id: `p-${this.createId()}`, name, kind, roles, ...(migration ? { migration } : {}) });
    this._checkName(profile.name);
    this._checkEfforts(profile);
    const list = this.list();
    list.push(profile);
    this._write(list, this.defaultId() || profile.id);
    return profile;
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    const next = normalizeProfile({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      id: current.id,
      kind: current.kind
    });
    this._checkName(next.name, id);
    this._checkEfforts(next);
    this._write(this.list().map((p) => (p.id === id ? next : p)), this.defaultId());
    return next;
  }

  duplicate(id, { name } = {}) {
    const source = this.get(id);
    if (!source) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    const base = String(name || `${source.name} copy`).trim();
    const taken = new Set(this.list().map((p) => p.name.toLowerCase()));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} ${n}`;
    return this.create({ name: candidate, kind: 'user', roles: source.roles });
  }

  remove(id) {
    const list = this.list();
    const removed = list.find((p) => p.id === id);
    if (!removed) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    if (list.length === 1) throw new ProfileError('LAST_PROFILE', 'The last profile cannot be deleted.');
    const rest = list.filter((p) => p.id !== id);
    const current = this.defaultId();
    const defaultProfileId = current === id ? rest[0].id : current;
    this._write(rest, defaultProfileId);
    return { removed, defaultProfileId };
  }

  setDefault(id) {
    if (!this.get(id)) throw new ProfileError('NOT_FOUND', `No profile with id ${id}.`);
    this._write(this.list(), id);
    return id;
  }
}

module.exports = { Profiles, ProfileError, PROFILE_KINDS, normalizeProfile, normalizeCustomRole };
```

- [ ] **Step 5: Add the settings keys**

In `src/core/settings.js`, below the existing `const { DEFAULT_OLLAMA_BASE_URL } = require('../models/provider-ids');` add:

```js
const { DEFAULT_ROLE_TIMEOUTS_MS } = require('../models/roles');
```

Replace the `models:` block of `DEFAULT_SETTINGS` (the comment "Model catalog and availability (spec 2026-09-27 §14; the stage M1 keys)…" and the object after it) with:

```js
  // Model catalog, availability and profiles (spec 2026-09-27 §14). The
  // tiers above are read once by the stage M2 migration and then removed.
  models: {
    catalog: { ...CATALOG_DEFAULTS },
    overrides: {},
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL },
    availability: { retestHours: 24 },
    profiles: [],
    defaultProfileId: null,
    customRoles: [],
    roleTimeoutsMs: { ...DEFAULT_ROLE_TIMEOUTS_MS }
  },
```

In `mergeSettings`, inside the `models: { … }` merge, after the `availability: { … }` entry (add a comma after its closing brace) add:

```js
      profiles: Array.isArray(source.models?.profiles) ? source.models.profiles : [],
      defaultProfileId: typeof source.models?.defaultProfileId === 'string' && source.models.defaultProfileId
        ? source.models.defaultProfileId
        : null,
      customRoles: Array.isArray(source.models?.customRoles) ? source.models.customRoles : [],
      roleTimeoutsMs: {
        ...DEFAULT_SETTINGS.models.roleTimeoutsMs,
        ...(source.models?.roleTimeoutsMs && typeof source.models.roleTimeoutsMs === 'object' && !Array.isArray(source.models.roleTimeoutsMs)
          ? source.models.roleTimeoutsMs
          : {})
      }
```

- [ ] **Step 6: Export from the models index**

In `src/models/index.js` add, after `const { capabilitiesOf } = require('./capabilities');`:

```js
const roles = require('./roles');
const { Profiles, ProfileError, normalizeProfile } = require('./profiles');
```

and in `module.exports` add `Profiles, ProfileError, normalizeProfile, ...roles,` before `...providerIds`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/models-profiles.test.js tests/core-settings.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/models/roles.js src/models/profiles.js src/models/index.js src/core/settings.js tests/models-profiles.test.js tests/core-settings.test.js
git commit -m "feat(models): profiles and roles data model with the stage M2 settings keys"
```

---
## Task 2: The resolver and the frozen turn snapshot

**Files:**
- Create: `src/models/resolver.js`
- Modify: `src/models/profiles.js` (add `snapshot()` and `snapshotFromSettings()`), `src/models/index.js` (exports)
- Test: `tests/models-resolver.test.js` (new)

**Interfaces:**
- Consumes: from Task 1 `CORE_ROLES`, `ROLE_NEEDS`, `DEFAULT_ROLE_TIMEOUTS_MS`, `isCoreRole`, `normalizeTarget`, `targetLabel` (`src/models/roles.js`); `Profiles`, `normalizeProfile`, `normalizeCustomRole` (`src/models/profiles.js`).
- Produces (`src/models/resolver.js`):
  - `createTurnModels({ profile, mainOverride = null, customRoles = [], explain }) → TurnModels`. `explain(provider, model, { needs }) → { usable: boolean, reasons: string[], notes?: string[] }` (Availability#explain's shape).
  - `TurnModels` (frozen): `profileId`, `profileName`, `mainOverride` (Target|null), `configuredFor(role) → Target[]` (the profile's own list, ignoring the override), `candidatesFor(role) → Target[]` (what `resolve` would check: the override for main, the borrowed list for an empty core role, the fallback's for an empty custom role, the three core lists for an empty vision), `resolve(role, { needs = {}, explicit = null }) → Resolution`, `mustResolve(role, opts) → Resolution` (throws `NoUsableModelError` when `targets` is empty, unless `useSettings`).
  - `Resolution`: `{ role, targets: Target[], skipped: [{ target, reasons }], borrowedFrom: string|null, override: boolean, explicit: boolean, useSettings: boolean }`.
  - `UnknownRoleError` (`code: 'UNKNOWN_ROLE'`, `role`), `NoUsableModelError` (`code: 'NO_USABLE_MODEL'` or `'MAIN_OVERRIDE_UNUSABLE'`, `role`, `skipped`, `override`), `roleTimeoutMs(settings, role, customRoles = []) → number|undefined`, `EMPTY_PROFILE`.
- Produces (`src/models/profiles.js`): `Profiles#snapshot({ profileId = null, mainOverride = null, explain }) → TurnModels` (an unknown id falls back to the default, logged); `snapshotFromSettings(settings, { profileId, mainOverride, explain }) → TurnModels` for hosts without a `Profiles` instance.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-resolver.test.js`:

```js
// tests/models-resolver.test.js
// The resolver (spec 2026-09-27 §6.3–§6.6): usable targets in order with
// the reasons for every skipped one, needs filtering, borrowing and
// fallbacks, the main override, unknown roles, and a frozen snapshot.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { createTurnModels, UnknownRoleError, NoUsableModelError, roleTimeoutMs } = require('../src/models/resolver');
const { Profiles, snapshotFromSettings } = require('../src/models/profiles');
const { mergeSettings } = require('../src/core/settings');

const t = (provider, model, effort = null) => ({ provider, model, effort });

// Usable unless listed; a listed model gets that reason. `seen` records the
// needs each call was asked about.
function explainer(unusable = {}, { images = [], tools = null } = {}) {
  const seen = [];
  const explain = (provider, model, { needs = {} } = {}) => {
    seen.push({ provider, model, needs });
    const key = `${provider}/${model}`;
    const reasons = [];
    if (unusable[key]) reasons.push(unusable[key]);
    if (needs.imageInput && !images.includes(key)) reasons.push(`${model} takes no image input.`);
    if (needs.toolCall && tools && !tools.includes(key)) reasons.push(`${model} has no tool calling.`);
    return { usable: reasons.length === 0, reasons, notes: [] };
  };
  return { explain, seen };
}

const profile = (roles, extra = {}) => ({ id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...roles }, ...extra });

describe('TurnModels.resolve', () => {
  it('returns the usable targets in order and every skipped one with its reasons', () => {
    const { explain } = explainer({ 'groq/llama-3.3-70b': 'Groq connection test failed: Invalid API Key' });
    const m = createTurnModels({ profile: profile({ main: [t('groq', 'llama-3.3-70b'), t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')] }), explain });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')]);
    assert.deepStrictEqual(r.skipped, [{ target: t('groq', 'llama-3.3-70b'), reasons: ['Groq connection test failed: Invalid API Key'] }]);
    assert.strictEqual(r.borrowedFrom, null);
    assert.strictEqual(r.override, false);
    assert.strictEqual(m.profileId, 'p-1');
    assert.strictEqual(m.profileName, 'Work');
  });

  it('passes the call needs to every check', () => {
    const { explain, seen } = explainer({}, { tools: ['openai/gpt-5.5'] });
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-3.5-turbo'), t('openai', 'gpt-5.5')] }), explain });
    const r = m.resolve('main', { needs: { toolCall: true } });
    assert.deepStrictEqual(r.targets, [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(seen.map((s) => s.needs), [{ toolCall: true }, { toolCall: true }]);
  });

  it('uses only the main override when one is set, flagged, and never the profile list', () => {
    const { explain } = explainer({ 'openai/gpt-5.5': 'OpenAI connection test failed: timeout' });
    const m = createTurnModels({ profile: profile({ main: [t('anthropic', 'claude-sonnet-4-5')] }), mainOverride: { provider: 'OpenAI', model: 'gpt-5.5' }, explain });
    assert.deepStrictEqual(m.mainOverride, t('openai', 'gpt-5.5'));
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, []);
    assert.strictEqual(r.override, true);
    assert.deepStrictEqual(m.candidatesFor('main'), [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(m.configuredFor('main'), [t('anthropic', 'claude-sonnet-4-5')]);
    assert.throws(() => m.mustResolve('main'), (err) => err instanceof NoUsableModelError
      && err.code === 'MAIN_OVERRIDE_UNUSABLE'
      && /The main model override openai\/gpt-5\.5 is not usable: OpenAI connection test failed: timeout/.test(err.message));
  });

  it('fails an empty main without borrowing, and lists every skipped target when none is usable', () => {
    const { explain } = explainer({ 'groq/a': 'no key', 'openai/b': 'test failed' });
    const empty = createTurnModels({ profile: profile({ worker: [t('openai', 'gpt-5.4')] }), explain });
    assert.throws(() => empty.mustResolve('main'), (err) => err.code === 'NO_USABLE_MODEL' && /main has no models in the profile "Work"/.test(err.message));
    const none = createTurnModels({ profile: profile({ main: [t('groq', 'a'), t('openai', 'b')] }), explain });
    assert.throws(() => none.mustResolve('main'), (err) => err.code === 'NO_USABLE_MODEL'
      && err.skipped.length === 2
      && /Skipped: groq\/a \(no key\); openai\/b \(test failed\)/.test(err.message));
  });

  it('borrows an empty utility from worker, then main; an empty worker from main', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')], worker: [t('openai', 'gpt-5.4')] }), explain });
    assert.deepStrictEqual([m.resolve('utility').targets, m.resolve('utility').borrowedFrom], [[t('openai', 'gpt-5.4')], 'worker']);
    const onlyMain = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), explain });
    assert.deepStrictEqual([onlyMain.resolve('utility').borrowedFrom, onlyMain.resolve('worker').borrowedFrom], ['main', 'main']);
    assert.deepStrictEqual(onlyMain.candidatesFor('utility'), [t('openai', 'gpt-5.5')]);
  });

  it('does not borrow when the role has models but none is usable', () => {
    const { explain } = explainer({ 'groq/llama-3.3-70b': 'Groq connection test failed' });
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')], utility: [t('groq', 'llama-3.3-70b')] }), explain });
    const r = m.resolve('utility');
    assert.deepStrictEqual([r.targets, r.borrowedFrom, r.skipped.length], [[], null, 1]);
  });

  it('borrows the main list, not the main override, for an empty worker', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), mainOverride: t('anthropic', 'claude-sonnet-4-5'), explain });
    assert.deepStrictEqual(m.resolve('worker').targets, [t('openai', 'gpt-5.5')]);
  });

  it('checks vision entries for image input, and fills an empty vision from the first image-capable core model', () => {
    const { explain } = explainer({}, { images: ['openai/gpt-5.5', 'anthropic/claude-sonnet-4-5'] });
    const own = createTurnModels({ profile: profile({ vision: [t('groq', 'llama-3.3-70b'), t('openai', 'gpt-5.5')] }), explain });
    assert.deepStrictEqual(own.resolve('vision').targets, [t('openai', 'gpt-5.5')]);
    const borrowed = createTurnModels({ profile: profile({ utility: [t('groq', 'llama-3.3-70b')], worker: [t('anthropic', 'claude-sonnet-4-5')], main: [t('openai', 'gpt-5.5')] }), explain });
    const r = borrowed.resolve('vision');
    assert.deepStrictEqual([r.targets, r.borrowedFrom], [[t('anthropic', 'claude-sonnet-4-5')], 'worker']);
    const none = createTurnModels({ profile: profile({ main: [t('groq', 'llama-3.3-70b')] }), explain });
    assert.deepStrictEqual(none.resolve('vision').targets, []);
  });

  it('leaves an empty imageGeneration to its own settings', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({}), explain });
    const r = m.resolve('imageGeneration');
    assert.deepStrictEqual([r.targets, r.useSettings], [[], true]);
    assert.doesNotThrow(() => m.mustResolve('imageGeneration'));
  });

  it('resolves a custom role with its needs, and an empty one through its fallback', () => {
    const { explain, seen } = explainer({}, { tools: ['openai/gpt-5.5'] });
    const customRoles = [{ id: 'legal-drafting', description: '', needs: { toolCall: true }, fallback: 'worker' }];
    const filled = createTurnModels({ profile: profile({ 'legal-drafting': [t('openai', 'gpt-3.5-turbo'), t('openai', 'gpt-5.5')] }), customRoles, explain });
    assert.deepStrictEqual(filled.resolve('legal-drafting').targets, [t('openai', 'gpt-5.5')]);
    assert.ok(seen.every((s) => s.needs.toolCall === true));
    const empty = createTurnModels({ profile: profile({ worker: [t('openai', 'gpt-5.5')] }), customRoles, explain });
    const r = empty.resolve('legal-drafting');
    assert.deepStrictEqual([r.role, r.targets, r.borrowedFrom], ['legal-drafting', [t('openai', 'gpt-5.5')], 'worker']);
  });

  it('fails an unknown role, naming it', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), explain });
    assert.throws(() => m.resolve('legal-drafting'), (err) => err instanceof UnknownRoleError && err.code === 'UNKNOWN_ROLE' && /Unknown model role "legal-drafting"/.test(err.message));
  });

  it('checks an explicit target alone, still for usability', () => {
    const { explain } = explainer({ 'groq/llama-3.3-70b': 'no key' });
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), explain });
    const ok = m.resolve('main', { explicit: { provider: 'Anthropic', model: 'claude-sonnet-4-5' } });
    assert.deepStrictEqual([ok.targets, ok.explicit], [[t('anthropic', 'claude-sonnet-4-5')], true]);
    const refused = m.resolve('main', { explicit: t('groq', 'llama-3.3-70b') });
    assert.deepStrictEqual(refused.targets, []);
    assert.throws(() => m.resolve('main', { explicit: { provider: 'openai' } }), /needs both a provider and a model/);
  });

  it('is frozen: later edits to the profile or override change nothing', () => {
    const { explain } = explainer();
    const source = profile({ main: [t('openai', 'gpt-5.5')] });
    const override = t('anthropic', 'claude-sonnet-4-5');
    const m = createTurnModels({ profile: source, mainOverride: override, explain });
    source.roles.main.push(t('groq', 'x'));
    source.roles.worker = [t('groq', 'y')];
    override.model = 'changed';
    assert.deepStrictEqual(m.configuredFor('main'), [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(m.mainOverride, t('anthropic', 'claude-sonnet-4-5'));
    assert.deepStrictEqual(m.resolve('worker').borrowedFrom, 'main');
    assert.ok(Object.isFrozen(m));
  });

  it('works with no profile at all: main fails with a clear message', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: null, explain });
    assert.strictEqual(m.profileId, null);
    assert.throws(() => m.mustResolve('main'), /main has no models in the profile "\(no profile\)"/);
  });
});

describe('snapshots from profiles', () => {
  function store(models) {
    let settings = mergeSettings({ models });
    return new Profiles({ getSettings: () => settings, setSettings: (s) => { settings = mergeSettings(s); } });
  }
  const models = {
    profiles: [
      { id: 'p-a', name: 'A', roles: { main: [t('openai', 'gpt-5.5')] } },
      { id: 'p-b', name: 'B', roles: { main: [t('anthropic', 'claude-sonnet-4-5')] } }
    ],
    defaultProfileId: 'p-b'
  };

  it('picks the named profile, else the default', () => {
    const { explain } = explainer();
    const profiles = store(models);
    assert.strictEqual(profiles.snapshot({ profileId: 'p-a', explain }).profileId, 'p-a');
    assert.strictEqual(profiles.snapshot({ explain }).profileId, 'p-b');
  });

  it('an unknown profile id falls back to the default', () => {
    const { explain } = explainer();
    const lines = [];
    const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
    try {
      assert.strictEqual(store(models).snapshot({ profileId: 'p-gone', explain }).profileId, 'p-b');
    } finally {
      remove();
    }
    assert.ok(lines.some((l) => l.includes('p-gone')), lines.join('\n'));
  });

  it('snapshotFromSettings reads settings.models directly, with the override', () => {
    const { explain } = explainer();
    const m = snapshotFromSettings({ models }, { profileId: 'p-a', mainOverride: t('groq', 'x'), explain });
    assert.deepStrictEqual([m.profileId, m.mainOverride], ['p-a', t('groq', 'x')]);
    assert.strictEqual(snapshotFromSettings({}, { explain }).profileId, null);
  });

  it('carries the custom roles into the snapshot', () => {
    const { explain } = explainer();
    const m = store({ ...models, customRoles: [{ id: 'legal-drafting', fallback: 'main' }] }).snapshot({ explain });
    assert.strictEqual(m.resolve('legal-drafting').borrowedFrom, 'main');
  });
});

describe('roleTimeoutMs', () => {
  it('reads models.roleTimeoutsMs, mapping specialists and custom roles to a core role', () => {
    const settings = mergeSettings({ models: { roleTimeoutsMs: { utility: 5000 } } });
    assert.strictEqual(roleTimeoutMs(settings, 'main'), 90000);
    assert.strictEqual(roleTimeoutMs(settings, 'utility'), 5000);
    assert.strictEqual(roleTimeoutMs(settings, 'vision'), 30000);
    assert.strictEqual(roleTimeoutMs(settings, 'legal-drafting', [{ id: 'legal-drafting', fallback: 'utility' }]), 5000);
    assert.strictEqual(roleTimeoutMs({ models: { roleTimeoutsMs: { main: -1 } } }, 'main'), undefined);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-resolver.test.js`
Expected: FAIL with `Cannot find module '../src/models/resolver'`.

- [ ] **Step 3: Write `src/models/resolver.js`**

```js
// src/models/resolver.js
// The resolver (spec 2026-09-27 §6.3–§6.6). createTurnModels() freezes a
// profile and main override at turn launch; resolve() answers "which usable
// models, in order, fill this role for this call", with every skipped entry
// and its reasons. Usability itself is the injected explain() — the host's
// Availability#explain — so this module never touches a provider.
const R = require('./roles');

const EMPTY_PROFILE = Object.freeze({ id: null, name: '(no profile)', kind: 'user', roles: Object.freeze({ main: [], worker: [], utility: [] }) });

class UnknownRoleError extends Error {
  constructor(role) {
    super(`Unknown model role "${role}". Roles are main, worker, utility, vision, imageGeneration, or a custom role defined in Settings → Models → Advanced.`);
    this.name = 'UnknownRoleError';
    this.code = 'UNKNOWN_ROLE';
    this.role = role;
  }
}

const describeSkipped = (skipped) => skipped.map((s) => `${R.targetLabel(s.target)} (${s.reasons.join(' ')})`).join('; ');

class NoUsableModelError extends Error {
  constructor(resolution, profileName) {
    const { role, skipped, override } = resolution;
    let message;
    if (override && skipped.length) {
      message = `The main model override ${R.targetLabel(skipped[0].target)} is not usable: ${skipped[0].reasons.join(' ')} Use the profile's main instead, or pick another model.`;
    } else if (!skipped.length) {
      message = `${role} has no models in the profile "${profileName}". Add one in Settings → Models.`;
    } else {
      message = `No usable model for ${role} in the profile "${profileName}". Skipped: ${describeSkipped(skipped)}. Fix them in Settings → Models, or switch the model.`;
    }
    super(message);
    this.name = 'NoUsableModelError';
    this.code = override ? 'MAIN_OVERRIDE_UNUSABLE' : 'NO_USABLE_MODEL';
    this.role = role;
    this.skipped = skipped;
    this.override = Boolean(override);
  }
}

function mergeNeeds(a = {}, b = {}) {
  const out = { ...a, ...b };
  if (Number.isFinite(a.minContext) || Number.isFinite(b.minContext)) {
    out.minContext = Math.max(Number(a.minContext) || 0, Number(b.minContext) || 0);
  }
  return out;
}

function createTurnModels({ profile = null, mainOverride = null, customRoles = [], explain } = {}) {
  if (typeof explain !== 'function') throw new Error('createTurnModels needs explain().');
  const frozen = structuredClone(profile || EMPTY_PROFILE);
  const override = R.normalizeTarget(mainOverride);
  const custom = new Map((Array.isArray(customRoles) ? customRoles : []).map((r) => [r.id, structuredClone(r)]));
  const copy = (list) => list.map((x) => ({ ...x }));
  const own = (role) => (Array.isArray(frozen.roles?.[role]) ? frozen.roles[role] : []);

  const check = (list, needs) => {
    const targets = [];
    const skipped = [];
    for (const target of list) {
      const verdict = explain(target.provider, target.model, { needs }) || {};
      if (verdict.usable) {
        targets.push({ ...target });
      } else {
        const reasons = Array.isArray(verdict.reasons) && verdict.reasons.length ? [...verdict.reasons] : ['Not usable.'];
        skipped.push({ target: { ...target }, reasons });
      }
    }
    return { targets, skipped };
  };

  const result = (role, checked, extra = {}) => ({
    role,
    targets: checked.targets,
    skipped: checked.skipped,
    borrowedFrom: null,
    override: false,
    explicit: false,
    useSettings: false,
    ...extra
  });

  const borrowChain = (role) => (role === 'utility' ? ['worker', 'main'] : role === 'worker' ? ['main'] : []);

  function candidatesFor(role) {
    if (role === 'main') return override ? [{ ...override }] : copy(own('main'));
    if (role === 'worker' || role === 'utility') {
      if (own(role).length) return copy(own(role));
      const from = borrowChain(role).find((r) => own(r).length);
      return from ? copy(own(from)) : [];
    }
    if (role === 'vision') {
      if (own('vision').length) return copy(own('vision'));
      return [...own('utility'), ...own('worker'), ...own('main')].map((x) => ({ ...x }));
    }
    if (role === 'imageGeneration') return copy(own('imageGeneration'));
    const c = custom.get(role);
    if (c) return own(role).length ? copy(own(role)) : candidatesFor(c.fallback);
    throw new UnknownRoleError(role);
  }

  function resolve(role, { needs = {}, explicit = null } = {}) {
    if (explicit) {
      const target = R.normalizeTarget(explicit);
      if (!target) throw new Error(`A named model needs both a provider and a model id (got ${JSON.stringify(explicit)}).`);
      return result(role, check([target], needs), { explicit: true });
    }
    if (role === 'main') {
      if (override) return result('main', check([override], needs), { override: true });
      return result('main', check(own('main'), needs));
    }
    if (role === 'worker' || role === 'utility') {
      if (own(role).length) return result(role, check(own(role), needs));
      // An empty core role borrows from the next stronger one (§6.4); an
      // empty main never borrows from a weaker role.
      for (const from of borrowChain(role)) {
        if (own(from).length) return result(role, check(own(from), needs), { borrowedFrom: from });
      }
      return result(role, { targets: [], skipped: [] });
    }
    if (role === 'vision') {
      const need = mergeNeeds(R.ROLE_NEEDS.vision, needs);
      if (own('vision').length) return result('vision', check(own('vision'), need));
      // The first image-capable model in utility, then worker, then main.
      for (const from of ['utility', 'worker', 'main']) {
        const checked = check(own(from), need);
        if (checked.targets.length) return result('vision', { targets: [checked.targets[0]], skipped: [] }, { borrowedFrom: from });
      }
      return result('vision', { targets: [], skipped: [] });
    }
    if (role === 'imageGeneration') {
      if (own('imageGeneration').length) return result(role, check(own('imageGeneration'), needs));
      // Empty: today's imageGeneration settings keep applying (§6.4).
      return result(role, { targets: [], skipped: [] }, { useSettings: true });
    }
    const c = custom.get(role);
    if (c) {
      const need = mergeNeeds(c.needs, needs);
      if (own(role).length) return result(role, check(own(role), need));
      return { ...resolve(c.fallback, { needs: need }), role, borrowedFrom: c.fallback };
    }
    throw new UnknownRoleError(role);
  }

  function mustResolve(role, options = {}) {
    const r = resolve(role, options);
    if (!r.targets.length && !r.useSettings) throw new NoUsableModelError(r, frozen.name);
    return r;
  }

  return Object.freeze({
    profileId: frozen.id || null,
    profileName: frozen.name,
    mainOverride: override ? { ...override } : null,
    configuredFor: (role) => copy(own(role)),
    candidatesFor,
    resolve,
    mustResolve
  });
}

// The call timeout for a role: models.roleTimeoutsMs, a specialist using
// worker's and a custom role its fallback's.
function roleTimeoutMs(settings, role, customRoles = []) {
  const table = { ...R.DEFAULT_ROLE_TIMEOUTS_MS, ...(settings?.models?.roleTimeoutsMs || {}) };
  let key = role;
  if (!R.isCoreRole(role)) {
    const c = (customRoles || []).find((r) => r.id === role);
    key = c ? c.fallback : 'worker';
  }
  const value = Number(table[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

module.exports = { createTurnModels, UnknownRoleError, NoUsableModelError, roleTimeoutMs, EMPTY_PROFILE };
```

- [ ] **Step 4: Add the snapshots to `src/models/profiles.js`**

Below `const R = require('./roles');` add:

```js
const { createTurnModels } = require('./resolver');
```

Inside `class Profiles`, after `setDefault(id) { … }`, add:

```js
  // The frozen view one turn uses (spec §6.6). An unknown id falls back to
  // the default, logged: a chat or case can outlive the profile it named.
  snapshot({ profileId = null, mainOverride = null, explain } = {}) {
    let profile = profileId ? this.get(profileId) : null;
    if (profileId && !profile) log.warn(`Profile ${profileId} no longer exists; using the default profile.`);
    if (!profile) profile = this.getDefault();
    return createTurnModels({ profile, mainOverride, customRoles: this.customRoles(), explain });
  }
```

After the class, add:

```js
// A snapshot straight from a settings object, for a host with no Profiles
// instance (a case runtime built without a core). Read-only.
function snapshotFromSettings(settings, { profileId = null, mainOverride = null, explain } = {}) {
  const view = new Profiles({
    getSettings: () => settings || {},
    setSettings: () => { throw new Error('snapshotFromSettings is read-only.'); }
  });
  return view.snapshot({ profileId, mainOverride, explain });
}
```

and change the exports line to:

```js
module.exports = { Profiles, ProfileError, PROFILE_KINDS, normalizeProfile, normalizeCustomRole, snapshotFromSettings };
```

- [ ] **Step 5: Export from the models index**

In `src/models/index.js` change the profiles require to `const { Profiles, ProfileError, normalizeProfile, snapshotFromSettings } = require('./profiles');`, add `const { createTurnModels, UnknownRoleError, NoUsableModelError, roleTimeoutMs } = require('./resolver');`, and add `snapshotFromSettings, createTurnModels, UnknownRoleError, NoUsableModelError, roleTimeoutMs,` to `module.exports` before `...roles`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/models-resolver.test.js tests/models-profiles.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/models/resolver.js src/models/profiles.js src/models/index.js tests/models-resolver.test.js
git commit -m "feat(models): the resolver and a frozen per-turn snapshot of a profile"
```

---
## Task 3: The tier migration

**Files:**
- Create: `src/models/migrate-tiers.js`
- Modify: `src/models/index.js` (exports)
- Test: `tests/models-migrate.test.js` (new)

**Interfaces:**
- Consumes: `normalizeTarget`, `DEFAULT_ROLE_TIMEOUTS_MS` (Task 1); `createTurnModels` (Task 2, in tests); `stripDateSuffix` (`src/models/normalize.js`); `Catalog#get(provider, id)`, `Catalog#list(provider) → Entry[]` with `entry.family`, `entry.releaseDate`; `Availability` (M1) in tests.
- Produces (`src/models/migrate-tiers.js`):
  - `LEGACY_DEFAULTS` — what King Louie shipped before M2 (`activeProvider`, `providerModels`, `activeTier`, `tierMap`, `timeoutsMs`).
  - `hasLegacyModelSettings(raw) → boolean` (any of `activeProvider`, `providerModels`, `inference` present).
  - `needsMigration(raw) → boolean` (true when `raw.models.profiles` is not a non-empty array).
  - `mapStaleTarget(target, { catalog, accountModels }) → { target, note: string|null }`.
  - `migrateTierSettings(raw, { catalog = null, accountModels = {}, freshMain = [], now, createId }) → { fresh: boolean, profile, notes: string[], settings }` — pure; with no legacy keys (a fresh install) the profile is "Default" (`kind: 'user'`) whose `main` is `freshMain` (normalized, empty-model entries dropped) and whose `worker` and `utility` are empty, so they borrow from main; `settings` is `raw` plus `models.profiles = [profile]`, `models.defaultProfileId`, `models.roleTimeoutsMs` (legacy keys still present).
  - `stripLegacyKeys(raw) → raw` without the §13 step 6 keys.
  - `runTierMigration({ readRaw, writeRaw, removeLegacy = true, catalog, accountModels, freshMain, now, createId }) → { migrated: boolean, fresh?, profile?, notes?, error? }` — two writes (new keys, then removal); `removeLegacy: false` skips the removal (the core passes it while the tier code still exists, Tasks 5–11); never throws.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-migrate.test.js`:

```js
// tests/models-migrate.test.js
// The one-time tier migration (spec 2026-09-27 §13): the tiers become one
// "Migrated settings" profile, stale model ids map to the catalog's current
// model of the same family where that is unambiguous, tier timeouts become
// role timeouts, and the old keys go only after the new ones are written.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  migrateTierSettings, stripLegacyKeys, runTierMigration, needsMigration, mapStaleTarget, LEGACY_DEFAULTS
} = require('../src/models/migrate-tiers');
const { createTurnModels } = require('../src/models/resolver');
const { Availability } = require('../src/models/availability');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const now = () => new Date('2026-09-27T12:00:00.000Z');
const opts = (extra = {}) => ({ catalog: fixtureCatalog(), now, createId: () => 'abc', ...extra });

// Shaped like an owner profile from before M2 (spec §16): standard tier on
// gpt-5.5 and active, smart on a Sonnet id the catalog no longer lists, fast
// on Groq, smart routing and the LLM router switched on.
const ownerShaped = () => ({
  activeProvider: 'groq',
  providerModels: { openai: 'gpt-4o-mini', groq: 'llama-3.3-70b-versatile' },
  inference: {
    activeTier: 'standard',
    tierMap: {
      fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      standard: { provider: 'openai', model: 'gpt-5.5' },
      smart: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' }
    },
    timeoutsMs: { fast: 10000, standard: 40000, smart: 120000 },
    smartRouting: { enabled: true, rules: [] },
    llmRouting: { enabled: true, costSensitivity: 'medium' },
    agentLoopModel: 'gpt-4o-mini'
  },
  advisor: { enabled: false, model: 'gpt-4o' },
  cases: { timeZone: 'UTC', ingest: { maxPages: 100, vision: { provider: 'openai', model: 'gpt-5.5' } } },
  models: { ollama: { baseUrl: 'http://127.0.0.1:11434' } }
});

describe('migrateTierSettings', () => {
  it('builds main, worker, utility and vision from the tiers, with the notes the owner sees', () => {
    const r = migrateTierSettings(ownerShaped(), opts());
    assert.strictEqual(r.fresh, false);
    assert.deepStrictEqual(r.profile.roles, {
      main: [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')],
      worker: [t('openai', 'gpt-5.5')],
      utility: [t('groq', 'llama-3.3-70b-versatile')],
      vision: [t('openai', 'gpt-5.5')]
    });
    assert.deepStrictEqual([r.profile.id, r.profile.name, r.profile.kind], ['p-abc', 'Migrated settings', 'migrated']);
    assert.strictEqual(r.profile.migration.at, '2026-09-27T12:00:00.000Z');
    assert.ok(r.notes.some((n) => n === 'smart tier: anthropic/claude-sonnet-4-20250514 is not in the model catalog; mapped to anthropic/claude-sonnet-4-5, the newest claude-sonnet model.'), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => /^fast tier: groq\/llama-3\.3-70b-versatile is not in the model catalog; kept as is/.test(n)), r.notes.join('\n'));
    assert.deepStrictEqual(r.profile.migration.notes, r.notes);
    assert.deepStrictEqual(r.settings.models.profiles, [r.profile]);
    assert.strictEqual(r.settings.models.defaultProfileId, 'p-abc');
    assert.deepStrictEqual(r.settings.models.roleTimeoutsMs, { main: 120000, worker: 40000, utility: 10000 });
    assert.strictEqual(r.settings.models.ollama.baseUrl, 'http://127.0.0.1:11434', 'other models keys are kept');
    assert.ok(r.settings.inference, 'the legacy keys stay until the second write');
  });

  it('with a failing Groq key: gpt-5.5 answers main first, and utility shows Groq unusable with the reason', () => {
    const catalog = fixtureCatalog();
    const r = migrateTierSettings(ownerShaped(), opts({ catalog }));
    const statuses = {
      openai: { ok: true, checkedAt: '2026-09-27T11:00:00.000Z', models: [] },
      anthropic: { ok: true, checkedAt: '2026-09-27T11:00:00.000Z', models: [] },
      groq: { ok: false, error: 'Invalid API Key', message: 'Invalid API Key', checkedAt: '2026-09-27T11:00:00.000Z', models: [] }
    };
    const availability = new Availability({
      catalog,
      labels: { groq: 'Groq' },
      hasCredential: () => true,
      createProvider: async () => { throw new Error('no provider calls here'); },
      getStatuses: () => statuses,
      setStatuses: () => {}
    });
    const models = createTurnModels({ profile: r.profile, explain: (p, m, o) => availability.explain(p, m, o) });
    assert.deepStrictEqual(models.resolve('main').targets, [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')]);
    const utility = models.resolve('utility');
    assert.deepStrictEqual(utility.targets, []);
    assert.strictEqual(utility.skipped.length, 1);
    assert.deepStrictEqual(utility.skipped[0].target, t('groq', 'llama-3.3-70b-versatile'));
    assert.match(utility.skipped[0].reasons[0], /Groq connection test failed at 2026-09-27T11:00:00\.000Z: Invalid API Key/);
  });

  it('puts only the active tier in main when the active tier is smart', () => {
    const raw = ownerShaped();
    raw.inference.activeTier = 'smart';
    const r = migrateTierSettings(raw, opts());
    assert.deepStrictEqual(r.profile.roles.main, [t('anthropic', 'claude-sonnet-4-5')]);
    assert.strictEqual(r.notes.filter((n) => n.startsWith('smart tier:')).length, 1, 'one note per tier');
  });

  it('fills a missing tier, provider or model from what shipped before M2', () => {
    const r = migrateTierSettings({ inference: { activeTier: 'fast' } }, opts({ catalog: null }));
    assert.deepStrictEqual(r.profile.roles.main, [t('groq', 'llama-3.3-70b-versatile'), t('anthropic', 'claude-sonnet-5')]);
    assert.deepStrictEqual(r.profile.roles.worker, [t('anthropic', 'claude-sonnet-5')]);
    assert.deepStrictEqual(r.settings.models.roleTimeoutsMs, { main: 90000, worker: 30000, utility: 15000 });
    const byProvider = migrateTierSettings({ activeProvider: 'mistral', inference: { tierMap: { standard: { provider: 'openai' } } } }, opts({ catalog: null }));
    assert.deepStrictEqual(byProvider.profile.roles.worker, [t('openai', 'gpt-4o-mini')]);
  });

  it('leaves out a tier with no model, and says so', () => {
    const r = migrateTierSettings({ activeProvider: 'ollama', providerModels: { ollama: '' }, inference: { tierMap: { fast: { provider: 'ollama' } } } }, opts());
    assert.deepStrictEqual(r.profile.roles.utility, []);
    assert.ok(r.notes.includes('fast tier had no model for ollama; it was left out.'), r.notes.join('\n'));
  });

  it('keeps a stale id the account still lists, without a note', () => {
    const r = migrateTierSettings(ownerShaped(), opts({ accountModels: { anthropic: ['claude-sonnet-4-20250514'] } }));
    assert.deepStrictEqual(r.profile.roles.main[1], t('anthropic', 'claude-sonnet-4-20250514'));
    assert.ok(!r.notes.some((n) => n.startsWith('smart tier:')));
  });

  it('gives a fresh install a Default profile whose main lists each provider\'s default model', () => {
    const freshMain = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'Anthropic', model: 'claude-sonnet-5' }, { provider: 'ollama', model: '' }];
    const r = migrateTierSettings({ models: { catalog: { fetch: false } } }, opts({ freshMain }));
    assert.strictEqual(r.fresh, true);
    assert.deepStrictEqual(r.profile, {
      id: 'p-abc',
      name: 'Default',
      kind: 'user',
      roles: { main: [t('openai', 'gpt-4o-mini'), t('anthropic', 'claude-sonnet-5')], worker: [], utility: [] }
    });
    assert.deepStrictEqual(r.notes, []);
    assert.strictEqual(r.settings.models.catalog.fetch, false);
    assert.strictEqual(r.settings.models.defaultProfileId, 'p-abc');
  });
});

describe('mapStaleTarget', () => {
  it('maps only an unambiguous family, never a local Ollama model or a known id', () => {
    const catalog = fixtureCatalog();
    assert.deepStrictEqual(mapStaleTarget(t('openai', 'gpt-5.5'), { catalog }), { target: t('openai', 'gpt-5.5'), note: null });
    assert.deepStrictEqual(mapStaleTarget(t('ollama', 'llama3.2:latest'), { catalog }), { target: t('ollama', 'llama3.2:latest'), note: null });
    assert.deepStrictEqual(mapStaleTarget(t('anthropic', 'claude-haiku-3'), { catalog }).target, t('anthropic', 'claude-haiku-4-5'));
    const kept = mapStaleTarget(t('openai', 'davinci-002'), { catalog });
    assert.deepStrictEqual(kept.target, t('openai', 'davinci-002'));
    assert.match(kept.note, /kept as is/);
    assert.deepStrictEqual(mapStaleTarget(t('anthropic', 'claude-sonnet-4-20250514'), { catalog: null }).note, null);
  });
});

describe('stripLegacyKeys', () => {
  it('removes exactly the §13 step 6 keys', () => {
    const out = stripLegacyKeys(ownerShaped());
    assert.strictEqual('activeProvider' in out, false);
    assert.strictEqual('providerModels' in out, false);
    assert.strictEqual('inference' in out, false);
    assert.deepStrictEqual(out.advisor, { enabled: false });
    assert.deepStrictEqual(out.cases, { timeZone: 'UTC', ingest: { maxPages: 100 } });
    assert.deepStrictEqual(out.models, { ollama: { baseUrl: 'http://127.0.0.1:11434' } });
  });
});

describe('runTierMigration', () => {
  function memoryStore(initial, { failWrites = 0 } = {}) {
    let raw = initial;
    const writes = [];
    let failures = failWrites;
    return {
      writes,
      readRaw: () => raw,
      writeRaw: (next) => {
        if (failures > 0) { failures -= 1; throw new Error('disk full'); }
        writes.push(JSON.parse(JSON.stringify(next)));
        raw = next;
      },
      peek: () => raw
    };
  }

  it('writes the new keys first, then removes the old ones', () => {
    const store = memoryStore(ownerShaped());
    const r = runTierMigration({ ...store, ...opts() });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(store.writes.length, 2);
    assert.ok(store.writes[0].inference && store.writes[0].models.profiles.length === 1, 'first write: both');
    assert.ok(!('inference' in store.writes[1]) && store.writes[1].models.profiles.length === 1, 'second write: new only');
    assert.strictEqual(needsMigration(store.peek()), false);
  });

  it('keeps the old keys when asked to', () => {
    const store = memoryStore(ownerShaped());
    const r = runTierMigration({ ...store, ...opts(), removeLegacy: false });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(store.writes.length, 1);
    assert.ok(store.peek().inference && store.peek().models.profiles.length === 1);
  });

  it('running the migration twice creates one profile', () => {
    const store = memoryStore(ownerShaped());
    runTierMigration({ ...store, ...opts() });
    const again = runTierMigration({ ...store, ...opts({ createId: () => 'second' }) });
    assert.strictEqual(again.migrated, false);
    assert.deepStrictEqual(store.peek().models.profiles.map((p) => p.id), ['p-abc']);
  });

  it('a crash between the two writes leaves one profile and ignorable legacy keys', () => {
    const store = memoryStore(ownerShaped());
    const r = migrateTierSettings(store.readRaw(), opts());
    store.writeRaw(r.settings); // the first write happened, then the process died
    const again = runTierMigration({ ...store, ...opts({ createId: () => 'second' }) });
    assert.strictEqual(again.migrated, false);
    assert.deepStrictEqual(store.peek().models.profiles.map((p) => p.id), ['p-abc']);
  });

  it('a failed first write leaves the old settings untouched and reports the error', () => {
    const before = ownerShaped();
    const store = memoryStore(before, { failWrites: 1 });
    const r = runTierMigration({ ...store, ...opts() });
    assert.deepStrictEqual([r.migrated, r.error], [false, 'disk full']);
    assert.strictEqual(store.peek(), before);
    assert.deepStrictEqual(store.peek(), ownerShaped());
    assert.strictEqual(needsMigration(store.peek()), true, 'retried at the next start');
  });

  it('a failed second write keeps the profile and reports success', () => {
    const store = memoryStore(ownerShaped());
    let calls = 0;
    const writeRaw = (next) => { calls += 1; if (calls === 2) throw new Error('disk full'); store.writeRaw(next); };
    const r = runTierMigration({ readRaw: store.readRaw, writeRaw, ...opts() });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(store.peek().models.profiles.length, 1);
    assert.ok(store.peek().inference, 'the legacy keys are left behind, ignored');
  });

  it('treats an empty profile list as absent, and a null store as a fresh install', () => {
    assert.strictEqual(needsMigration({ models: { profiles: [] } }), true);
    assert.strictEqual(needsMigration(null), true);
    const store = memoryStore(null);
    assert.strictEqual(runTierMigration({ ...store, ...opts() }).fresh, true);
  });

  it('LEGACY_DEFAULTS holds what King Louie shipped before M2', () => {
    assert.strictEqual(LEGACY_DEFAULTS.activeProvider, 'openai');
    assert.deepStrictEqual(LEGACY_DEFAULTS.tierMap.fast, { provider: 'groq', model: 'llama-3.3-70b-versatile' });
    assert.deepStrictEqual({ ...LEGACY_DEFAULTS.timeoutsMs }, { fast: 15000, standard: 30000, smart: 90000 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-migrate.test.js`
Expected: FAIL with `Cannot find module '../src/models/migrate-tiers'`.

- [ ] **Step 3: Write `src/models/migrate-tiers.js`**

```js
// src/models/migrate-tiers.js
// The one-time move from tiers to profiles (spec 2026-09-27 §13). The fast,
// standard and smart tiers become one "Migrated settings" profile; a saved
// model id the catalog no longer lists maps to the catalog's current model
// of the same family when exactly one family and one newest model match,
// else it is kept and the profile editor shows it unusable with the reason.
// Every mapping and every kept stale id is a note on the profile.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const R = require('./roles');
const { stripDateSuffix } = require('./normalize');

const log = createLogger('models/migrate');

const TIERS = Object.freeze(['fast', 'standard', 'smart']);
const LEGACY_TOP_KEYS = Object.freeze(['activeProvider', 'providerModels', 'inference']);

// What King Louie shipped before stage M2. The old mergeSettings filled these
// in for anything a stored setting left out, so they are what actually ran.
const LEGACY_DEFAULTS = Object.freeze({
  activeProvider: 'openai',
  providerModels: Object.freeze({
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-5',
    copilot: 'gpt-5.4',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
    ollama: '',
    gemini: 'gemini-2.5-flash',
    openrouter: 'openai/gpt-4o-mini',
    xai: 'grok-4.3',
    deepseek: 'deepseek-flash',
    qwen: 'qwen-plus',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fireworks: 'accounts/fireworks/models/gpt-oss-120b',
    cohere: 'command-a-03-2025'
  }),
  activeTier: 'standard',
  tierMap: Object.freeze({
    fast: Object.freeze({ provider: 'groq', model: 'llama-3.3-70b-versatile' }),
    standard: Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-5' }),
    smart: Object.freeze({ provider: 'anthropic', model: 'claude-sonnet-5' })
  }),
  timeoutsMs: Object.freeze({ fast: 15000, standard: 30000, smart: 90000 })
});

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function hasLegacyModelSettings(raw) {
  return isPlainObject(raw) && LEGACY_TOP_KEYS.some((key) => raw[key] !== undefined);
}

function needsMigration(raw) {
  const profiles = isPlainObject(raw) && isPlainObject(raw.models) ? raw.models.profiles : null;
  return !(Array.isArray(profiles) && profiles.length > 0);
}

function legacyView(raw) {
  const inference = isPlainObject(raw.inference) ? raw.inference : {};
  const tier = String(inference.activeTier || '').toLowerCase();
  return {
    activeProvider: String(raw.activeProvider || LEGACY_DEFAULTS.activeProvider).toLowerCase(),
    providerModels: { ...LEGACY_DEFAULTS.providerModels, ...(isPlainObject(raw.providerModels) ? raw.providerModels : {}) },
    activeTier: TIERS.includes(tier) ? tier : LEGACY_DEFAULTS.activeTier,
    tierMap: { ...LEGACY_DEFAULTS.tierMap, ...(isPlainObject(inference.tierMap) ? inference.tierMap : {}) },
    timeoutsMs: { ...LEGACY_DEFAULTS.timeoutsMs, ...(isPlainObject(inference.timeoutsMs) ? inference.timeoutsMs : {}) }
  };
}

// The target a tier resolved to, exactly as InferenceRouter#resolve did.
function tierTarget(legacy, tier) {
  const cfg = isPlainObject(legacy.tierMap[tier]) ? legacy.tierMap[tier] : {};
  const provider = String(cfg.provider || legacy.activeProvider || 'openai').trim().toLowerCase();
  const model = String(cfg.model || legacy.providerModels[provider] || '').trim();
  return { provider, model };
}

function inAccount(list, id) {
  return list.includes(id) || list.some((m) => stripDateSuffix(m) === id || m === stripDateSuffix(id));
}

function mapStaleTarget(target, { catalog = null, accountModels = {} } = {}) {
  const keep = { target, note: null };
  if (!catalog || target.provider === 'ollama') return keep;
  if (catalog.get(target.provider, target.model)) return keep;
  const listed = Array.isArray(accountModels[target.provider]) ? accountModels[target.provider] : [];
  if (inAccount(listed, target.model)) return keep;
  const label = R.targetLabel(target);
  const entries = catalog.list(target.provider);
  const families = [...new Set(entries.map((e) => e.family).filter((f) => f && target.model.startsWith(`${f}-`)))];
  const longest = Math.max(0, ...families.map((f) => f.length));
  const best = families.filter((f) => f.length === longest);
  if (best.length !== 1) return { target, note: `${label} is not in the model catalog; kept as is (no single model family matches it).` };
  const family = best[0];
  // One entry per base id, preferring the undated alias over its dated twin.
  const byBase = new Map();
  for (const e of entries.filter((x) => x.family === family)) {
    const base = stripDateSuffix(e.id);
    if (!byBase.has(base) || e.id === base) byBase.set(base, e);
  }
  const ranked = [...byBase.values()].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
  const [top, next] = ranked;
  const unambiguous = Boolean(top) && (ranked.length === 1 || (Boolean(top.releaseDate) && top.releaseDate !== (next.releaseDate || '')));
  if (!unambiguous) return { target, note: `${label} is not in the model catalog; kept as is (no single newest ${family} model).` };
  const mapped = { ...target, model: top.id };
  return { target: mapped, note: `${label} is not in the model catalog; mapped to ${R.targetLabel(mapped)}, the newest ${family} model.` };
}

const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

function dedupe(list) {
  const seen = new Set();
  return list.filter((t) => {
    if (!t) return false;
    const key = R.targetKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function migrateTierSettings(raw, { catalog = null, accountModels = {}, freshMain = [], now = () => new Date(), createId = () => crypto.randomBytes(4).toString('hex') } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const models = isPlainObject(source.models) ? source.models : {};
  const id = `p-${createId()}`;
  if (!hasLegacyModelSettings(source)) {
    // A fresh install (spec §13 has nothing to migrate): main lists each
    // provider's own default model, in the app's provider order, so the
    // first provider the owner adds a key for answers at once; worker and
    // utility stay empty and borrow from main (§6.4).
    const main = dedupe((Array.isArray(freshMain) ? freshMain : []).map(R.normalizeTarget));
    const profile = { id, name: 'Default', kind: 'user', roles: { main, worker: [], utility: [] } };
    return { fresh: true, profile, notes: [], settings: { ...source, models: { ...models, profiles: [profile], defaultProfileId: id } } };
  }
  const legacy = legacyView(source);
  const notes = [];
  const byTier = {};
  for (const tier of TIERS) {
    const found = tierTarget(legacy, tier);
    if (!found.model) {
      notes.push(`${tier} tier had no model for ${found.provider}; it was left out.`);
      byTier[tier] = null;
      continue;
    }
    const { target, note } = mapStaleTarget({ provider: found.provider, model: found.model, effort: null }, { catalog, accountModels });
    if (note) notes.push(`${tier} tier: ${note}`);
    byTier[tier] = target;
  }
  const roles = {
    // Main: what chat used (the active tier), then the smart tier (§13 step 1).
    main: dedupe([byTier[legacy.activeTier], byTier.smart]),
    worker: dedupe([byTier.standard]),
    utility: dedupe([byTier.fast])
  };
  const vision = R.normalizeTarget(source.cases?.ingest?.vision);
  if (vision) roles.vision = [vision];
  const profile = { id, name: 'Migrated settings', kind: 'migrated', roles, migration: { at: now().toISOString(), notes } };
  const roleTimeoutsMs = {
    main: positive(legacy.timeoutsMs.smart, R.DEFAULT_ROLE_TIMEOUTS_MS.main),
    worker: positive(legacy.timeoutsMs.standard, R.DEFAULT_ROLE_TIMEOUTS_MS.worker),
    utility: positive(legacy.timeoutsMs.fast, R.DEFAULT_ROLE_TIMEOUTS_MS.utility)
  };
  return {
    fresh: false,
    profile,
    notes,
    settings: { ...source, models: { ...models, profiles: [profile], defaultProfileId: id, roleTimeoutsMs } }
  };
}

// §13 step 6. The whole `inference` object goes: every key in it is listed.
function stripLegacyKeys(raw) {
  const out = { ...(isPlainObject(raw) ? raw : {}) };
  for (const key of LEGACY_TOP_KEYS) delete out[key];
  if (isPlainObject(out.advisor) && 'model' in out.advisor) {
    const { model: _model, ...advisor } = out.advisor;
    out.advisor = advisor;
  }
  if (isPlainObject(out.cases) && isPlainObject(out.cases.ingest) && 'vision' in out.cases.ingest) {
    const { vision: _vision, ...ingest } = out.cases.ingest;
    out.cases = { ...out.cases, ingest };
  }
  return out;
}

// Never throws. A failed first write leaves the stored settings as they
// were and is retried at the next start (profiles are still absent); a
// failed second write leaves the old keys behind, which nothing reads.
function runTierMigration({ readRaw, writeRaw, removeLegacy = true, ...options } = {}) {
  let raw;
  try {
    raw = readRaw();
  } catch (err) {
    log.error(`Reading settings for the tier migration failed: ${err.message}`);
    return { migrated: false, error: err.message };
  }
  if (!needsMigration(raw)) return { migrated: false };
  let result;
  try {
    result = migrateTierSettings(raw, options);
    writeRaw(result.settings);
  } catch (err) {
    log.error(`Moving the tier settings to a profile failed; the old settings are untouched and the move is retried at the next start: ${err.message}`);
    return { migrated: false, error: err.message };
  }
  if (removeLegacy) {
    try {
      writeRaw(stripLegacyKeys(result.settings));
    } catch (err) {
      log.warn(`Removing the old tier settings failed; they are ignored from now on: ${err.message}`);
    }
  }
  if (result.fresh) log.info('No earlier model settings: created the Default profile from each provider\'s default model.');
  else log.info(`Moved the tier settings to the profile "${result.profile.name}".`);
  for (const note of result.notes) log.info(`Migration: ${note}`);
  return { migrated: true, fresh: result.fresh, profile: result.profile, notes: result.notes };
}

module.exports = {
  LEGACY_DEFAULTS,
  hasLegacyModelSettings,
  needsMigration,
  mapStaleTarget,
  migrateTierSettings,
  stripLegacyKeys,
  runTierMigration
};
```

- [ ] **Step 4: Export from the models index**

In `src/models/index.js` add `const { runTierMigration, needsMigration } = require('./migrate-tiers');` and `runTierMigration, needsMigration,` to `module.exports`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/models-migrate.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/models/migrate-tiers.js src/models/index.js tests/models-migrate.test.js
git commit -m "feat(models): migrate the tiers to a profile, mapping stale model ids with notes"
```

---
## Task 4: Failover over a resolved target list, and the routed provider

**Files:**
- Modify: `src/providers/inference-router.js` (constructor `:8-42`; add the new methods after `execute()`, before `_nextFallback`), `src/providers/failover-policy.js` (add `NO_RETRY`), `src/cases/roles.js:18-20` (re-export `NO_RETRY` from there), `src/agents/agent-executor.js:21-28`, `:97-106` (`failoverPolicy` option)
- Test: `tests/inference-router-targets.test.js` (new; it also covers `NO_RETRY` and `AgentExecutor`'s new option)

**Interfaces:**
- Consumes: `FailoverPolicy#plan(err, state) → { action, reason, waitMs }`, `RecoveryAction` (`src/providers/error-classifier.js`); a `Target` `{ provider, model, effort }` (Task 1).
- Produces:
  - `new InferenceRouter({ …existing, prepareProvider? })` — `prepareProvider(instance, provider) → Promise` runs once per provider per route state (the core uses it to refresh an Anthropic OAuth token).
  - `router.newRouteState() → { index, answered, instances: Map, lastInstance }`.
  - `router.executeTarget(instance, target, messages, options) → response` — `target.model` always wins over `options.model`; `target.effort` rides as `options.effort`; tools + `onChunk` → `streamMessageWithTools`, tools → `sendMessageWithTools`, `onChunk` alone → `streamMessage`, else `sendMessage`.
  - `router.routeTargets(targets, messages, options = {}, state = router.newRouteState()) → response` — walks the list per §6.7; mutates `state`. Throws the last error when the list is exhausted, or an `Error` with `code: 'FAILOVER_BLOCKED'` and `cause` when only another provider is left after the first successful call.
  - `router.routedProvider({ targets, signal = null }) → RoutedProvider` with `routed: true`, `targets()`, `current() → Target`, `getProviderName()`, `getDefaultModel()`, `sendMessage(m, o)`, `streamMessage(m, o, onChunk)`, `sendMessageWithTools(m, tools, o)`, `streamMessageWithTools(m, tools, o, onChunk)`, and getters `buildToolMessages` / `buildMultiToolMessages` delegating to the instance that last answered.
  - `NO_RETRY` from `src/providers/failover-policy.js` (`{ plan: () => ({ action: 'abort', reason: 'routed', waitMs: 0 }) }`); `src/cases/roles.js` keeps exporting it.
  - `new AgentExecutor(provider, toolExecutor, { …, failoverPolicy })` passes `failoverPolicy` to its `AgentLoop`.

- [ ] **Step 1: Write the failing tests**

Create `tests/inference-router-targets.test.js`:

```js
// tests/inference-router-targets.test.js
// Failover over a resolved target list (spec 2026-09-27 §6.7): another
// target of the same provider on any call, another provider only before
// the first successful call; the routed provider a turn's loop talks to.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const InferenceRouter = require('../src/providers/inference-router');
const { NO_RETRY } = require('../src/providers/failover-policy');
const AgentExecutor = require('../src/agents/agent-executor');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const unknownFailure = () => new Error('upstream exploded'); // unclassified → fall back at once
const authFailure = () => Object.assign(new Error('Invalid API Key'), { status: 401 });

// One scripted instance per provider: each call pops the next behaviour for
// that model ('ok', an Error, or a function).
function harness(script = {}, extra = {}) {
  const calls = [];
  const reported = [];
  const prepared = [];
  const instances = {};
  const make = (provider) => ({
    provider,
    getProviderName: () => provider,
    buildToolMessages: (...args) => [{ builtBy: provider, args }],
    buildMultiToolMessages: () => [{ builtBy: provider }],
    async sendMessage(messages, opts) { return this._run('sendMessage', messages, opts); },
    async streamMessage(messages, opts, onChunk) { onChunk('chunk'); return this._run('streamMessage', messages, opts); },
    async sendMessageWithTools(messages, tools, opts) { return this._run('sendMessageWithTools', messages, opts, tools); },
    async streamMessageWithTools(messages, tools, opts, onChunk) { onChunk('chunk'); return this._run('streamMessageWithTools', messages, opts, tools); },
    async _run(method, messages, opts, tools) {
      calls.push({ provider, model: opts.model, method, opts, tools });
      const queue = script[`${provider}/${opts.model}`] || [];
      const next = queue.length ? queue.shift() : 'ok';
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(opts);
      return { type: 'text', content: `${provider}/${opts.model}`, llmMetrics: { provider, model: opts.model } };
    }
  });
  const router = new InferenceRouter({
    getProviderToken: (p) => `token-${p}`,
    createProvider: (p) => { instances[p] = instances[p] || make(p); return instances[p]; },
    prepareProvider: async (_instance, p) => { prepared.push(p); },
    onProviderError: (p, err) => reported.push([p, err.message]),
    sleep: async () => {},
    ...extra
  });
  return { router, calls, reported, prepared };
}

describe('InferenceRouter#routeTargets', () => {
  it('fails over to another provider on the first call, reporting the auth failure against the provider that failed', async () => {
    const { router, calls, reported } = harness({ 'groq/llama': [authFailure()] });
    const res = await router.routeTargets([t('groq', 'llama'), t('openai', 'gpt-5.5')], [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(res.content, 'openai/gpt-5.5');
    assert.deepStrictEqual(calls.map((c) => `${c.provider}/${c.model}`), ['groq/llama', 'openai/gpt-5.5']);
    assert.deepStrictEqual(reported, [['groq', 'Invalid API Key']]);
  });

  it('skips the rest of a provider whose key was rejected', async () => {
    const { router, calls } = harness({ 'openai/a': [authFailure()] });
    await router.routeTargets([t('openai', 'a'), t('openai', 'b'), t('anthropic', 'c')], []);
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'c']);
  });

  it('after a successful call, fails over only to targets of the same provider', async () => {
    const { router, calls } = harness({ 'openai/a': ['ok', unknownFailure()] });
    const state = router.newRouteState();
    const list = [t('openai', 'a'), t('anthropic', 'b'), t('openai', 'c')];
    await router.routeTargets(list, [], {}, state);
    const second = await router.routeTargets(list, [], {}, state);
    assert.strictEqual(second.content, 'openai/c');
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'a', 'c']);
  });

  it('refuses to move to another provider mid-turn, saying why', async () => {
    const { router } = harness({ 'openai/a': ['ok', unknownFailure()] });
    const state = router.newRouteState();
    const list = [t('openai', 'a'), t('anthropic', 'b')];
    await router.routeTargets(list, [], {}, state);
    await assert.rejects(router.routeTargets(list, [], {}, state), (err) => err.code === 'FAILOVER_BLOCKED'
      && err.cause.message === 'upstream exploded'
      && /cannot move to anthropic\/b after its first model call/.test(err.message)
      && /Retry with/.test(err.message));
  });

  it('starts every later call at the target that last answered', async () => {
    const { router, calls } = harness({ 'openai/a': [unknownFailure()] });
    const state = router.newRouteState();
    const list = [t('openai', 'a'), t('openai', 'b')];
    await router.routeTargets(list, [], {}, state);
    await router.routeTargets(list, [], {}, state);
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'b', 'b']);
  });

  it('retries the same target on a transient error before failing over', async () => {
    const busy = () => Object.assign(new Error('bad gateway'), { status: 502 });
    const { router, calls } = harness({ 'openai/a': [busy(), 'ok'] });
    const res = await router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], []);
    assert.strictEqual(res.content, 'openai/a');
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'a']);
  });

  it('throws the last error when the list runs out', async () => {
    const { router } = harness({ 'openai/a': [unknownFailure()], 'anthropic/b': [new Error('also down')] });
    await assert.rejects(router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], []), /also down/);
  });

  it('never fails over once the run is aborted', async () => {
    const controller = new AbortController();
    const { router, calls } = harness({ 'openai/a': [() => { controller.abort(); throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }] });
    await assert.rejects(router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], [], { abortSignal: controller.signal }), /aborted/);
    assert.deepStrictEqual(calls.map((c) => c.model), ['a']);
  });

  it('refuses an empty list', async () => {
    const { router } = harness();
    await assert.rejects(router.routeTargets([], []), /resolved list is empty/);
  });

  it('prepares each provider once per route state', async () => {
    const { router, prepared } = harness();
    const state = router.newRouteState();
    await router.routeTargets([t('anthropic', 'a')], [], {}, state);
    await router.routeTargets([t('anthropic', 'a')], [], {}, state);
    assert.deepStrictEqual(prepared, ['anthropic']);
  });
});

describe('InferenceRouter#routedProvider', () => {
  it('routes each method, the target model and effort winning over options', async () => {
    const { router, calls } = harness();
    const p = router.routedProvider({ targets: [t('openai', 'gpt-5.5', 'low')] });
    const chunks = [];
    await p.streamMessage([], { model: 'ignored' }, (c) => chunks.push(c));
    await p.sendMessageWithTools([], [{ name: 'Read' }], {});
    await p.streamMessageWithTools([], [{ name: 'Read' }], {}, (c) => chunks.push(c));
    await p.sendMessage([], {});
    assert.deepStrictEqual(calls.map((c) => c.method), ['streamMessage', 'sendMessageWithTools', 'streamMessageWithTools', 'sendMessage']);
    assert.ok(calls.every((c) => c.model === 'gpt-5.5' && c.opts.effort === 'low'));
    assert.deepStrictEqual(calls[1].tools, [{ name: 'Read' }]);
    assert.deepStrictEqual(chunks, ['chunk', 'chunk']);
    assert.strictEqual(p.routed, true);
    assert.deepStrictEqual([p.getProviderName(), p.getDefaultModel()], ['openai', 'gpt-5.5']);
  });

  it('attaches its signal unless the call brings one', async () => {
    const { router, calls } = harness();
    const own = new AbortController();
    const theirs = new AbortController();
    const p = router.routedProvider({ targets: [t('openai', 'a')], signal: own.signal });
    await p.sendMessage([], {});
    await p.sendMessage([], { abortSignal: theirs.signal });
    assert.strictEqual(calls[0].opts.abortSignal, own.signal);
    assert.strictEqual(calls[1].opts.abortSignal, theirs.signal);
  });

  it('builds tool messages with the instance that answered, and reports where it is', async () => {
    const { router } = harness({ 'groq/a': [unknownFailure()] });
    const p = router.routedProvider({ targets: [t('groq', 'a'), t('openai', 'b')] });
    assert.strictEqual(p.buildToolMessages, undefined, 'nothing has answered yet');
    await p.sendMessageWithTools([], [{ name: 'Read' }], {});
    assert.deepStrictEqual(p.current(), t('openai', 'b'));
    assert.strictEqual(p.getProviderName(), 'openai');
    assert.deepStrictEqual(p.buildToolMessages('x')[0].builtBy, 'openai');
    assert.deepStrictEqual(p.buildMultiToolMessages()[0].builtBy, 'openai');
    assert.deepStrictEqual(p.targets(), [t('groq', 'a'), t('openai', 'b')]);
  });

  it('needs at least one target', () => {
    const { router } = harness();
    assert.throws(() => router.routedProvider({ targets: [] }), /at least one target/);
  });
});

describe('NO_RETRY and AgentExecutor', () => {
  it('NO_RETRY aborts every failure without waiting', () => {
    assert.deepStrictEqual(NO_RETRY.plan(new Error('503')), { action: 'abort', reason: 'routed', waitMs: 0 });
    assert.strictEqual(require('../src/cases/roles').NO_RETRY, NO_RETRY);
  });

  it('AgentExecutor hands its failover policy to the agent loop', async () => {
    // A 502 is one the loop's own default policy would retry, after a wait;
    // with NO_RETRY it gives up on the first failure.
    let calls = 0;
    const provider = { sendMessageWithTools: async () => { calls += 1; throw Object.assign(new Error('bad gateway'), { status: 502 }); } };
    const executor = new AgentExecutor(provider, { execute: async () => ({}) }, { failoverPolicy: NO_RETRY });
    const agent = { id: 'a', canUseTool: () => true, readOnly: false, maxIterations: 2 };
    const started = Date.now();
    await assert.rejects(executor.execute(agent, 'hi', { tools: [{ name: 'Read' }] }), /bad gateway/);
    assert.strictEqual(calls, 1, 'NO_RETRY: the loop never retries');
    assert.ok(Date.now() - started < 900, 'NO_RETRY: no backoff wait inside the loop');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/inference-router-targets.test.js`
Expected: FAIL — `router.routeTargets is not a function` and `NO_RETRY` undefined.

- [ ] **Step 3: Add `NO_RETRY` to the failover policy**

In `src/providers/failover-policy.js`, before `module.exports`, add:

```js
// For a loop whose provider already fails over (a routed provider): the
// loop itself never retries, so a failure is never retried twice over.
const NO_RETRY = Object.freeze({ plan: () => ({ action: 'abort', reason: 'routed', waitMs: 0 }) });
```

and add `NO_RETRY` to its `module.exports`.

In `src/cases/roles.js` replace

```js
// Case loops fail over through routeWithFallback, never by retrying the
// same target inside the agent loop.
const NO_RETRY = Object.freeze({ plan: () => ({ action: 'abort', reason: 'routed', waitMs: 0 }) });
```

with

```js
// Case loops fail over through the router, never by retrying the same
// target inside the agent loop.
const { NO_RETRY } = require('../providers/failover-policy');
```

- [ ] **Step 4: Let `AgentExecutor` pass a failover policy**

In `src/agents/agent-executor.js`, in the constructor after `this.prompter = options.prompter || null;` add:

```js
    // A routed provider fails over itself; its loop gets NO_RETRY so a
    // failure is never retried twice over (spec 2026-09-27 §6.7).
    this.failoverPolicy = options.failoverPolicy || null;
```

and in `execute()`, in the `new AgentLoop(this.provider, this.toolExecutor, { … })` options, after `prompter: this.prompter || undefined,` add:

```js
      ...(this.failoverPolicy ? { failoverPolicy: this.failoverPolicy } : {}),
```

- [ ] **Step 5: Add the target-list path to `InferenceRouter`**

In `src/providers/inference-router.js`, in the constructor after the `onProviderError` block, add:

```js
    // Runs once per provider per route state before its first call: the
    // core refreshes an Anthropic OAuth access token here.
    this.prepareProvider = typeof options.prepareProvider === 'function'
      ? options.prepareProvider
      : null;
```

After the `execute()` method add:

```js
  // ---- Resolved target lists (spec 2026-09-27 §6.7) ----

  newRouteState() {
    return { index: 0, answered: false, instances: new Map(), lastInstance: null };
  }

  async _instanceFor(provider, state) {
    if (state.instances.has(provider)) return state.instances.get(provider);
    if (typeof this.getProviderToken !== 'function' || typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires getProviderToken() and createProvider()');
    }
    const instance = this.createProvider(provider, this.getProviderToken(provider));
    if (this.prepareProvider) await this.prepareProvider(instance, provider);
    state.instances.set(provider, instance);
    return instance;
  }

  // One call to one target. The target decides the model; a caller's own
  // options.model never overrides it (the agent loop still passes one).
  async executeTarget(instance, target, messages, options = {}) {
    const { onChunk, tools, ...rest } = options || {};
    const opts = { ...rest, model: target.model, ...(target.effort ? { effort: target.effort } : {}) };
    if (Array.isArray(tools) && tools.length > 0) {
      if (typeof onChunk === 'function' && typeof instance.streamMessageWithTools === 'function') {
        return instance.streamMessageWithTools(messages, tools, opts, onChunk);
      }
      if (typeof instance.sendMessageWithTools !== 'function') {
        throw new Error(`Provider ${target.provider} does not support tool calling.`);
      }
      return instance.sendMessageWithTools(messages, tools, opts);
    }
    if (typeof onChunk === 'function' && typeof instance.streamMessage === 'function') {
      return instance.streamMessage(messages, opts, onChunk);
    }
    return instance.sendMessage(messages, opts);
  }

  _reportAuth(provider, err) {
    if (!this.onProviderError) return;
    try {
      this.onProviderError(provider, err);
    } catch (hookErr) {
      log.warn(`Reporting a ${provider} auth failure failed: ${hookErr.message}`);
    }
  }

  // The next target after a failure. Before the first answer any provider
  // may take over; after it, only the failed target's own provider, since
  // the history built so far is in that provider's format.
  _nextTarget(list, state, skipProviders, failed) {
    let crossProvider = null;
    for (let i = state.index + 1; i < list.length; i += 1) {
      const candidate = list[i];
      if (skipProviders.has(candidate.provider)) continue;
      if (!state.answered || candidate.provider === failed.provider) return { index: i, crossProvider: null };
      if (!crossProvider) crossProvider = candidate;
    }
    return { index: -1, crossProvider };
  }

  async routeTargets(targets, messages, options = {}, state = this.newRouteState()) {
    const list = (Array.isArray(targets) ? targets : []).filter((x) => x && x.provider && x.model);
    if (!list.length) throw new Error('No model to call: the resolved list is empty.');
    if (state.index >= list.length) state.index = 0;
    const label = (x) => `${x.provider}/${x.model}`;
    let payload = messages;
    const attemptsByReason = {};
    const flags = { totalAttempts: 0, credentialRefreshed: false, contextCompressed: false };
    const skipProviders = new Set();

    for (let guard = 0; guard <= this.policy.maxTotalAttempts; guard += 1) {
      const target = list[state.index];
      try {
        const instance = await this._instanceFor(target.provider, state);
        const response = await this.executeTarget(instance, target, payload, options);
        state.answered = true;
        state.lastInstance = instance;
        return response;
      } catch (err) {
        if (options.abortSignal?.aborted) throw err;
        flags.totalAttempts += 1;
        const plan = this.policy.plan(err, { ...flags, attemptsByReason, provider: target.provider, model: target.model, aborted: false });
        attemptsByReason[plan.reason] = (attemptsByReason[plan.reason] || 0) + 1;
        const authFailure = plan.reason === 'auth' || plan.reason === 'auth_permanent';
        if (authFailure) {
          this._reportAuth(target.provider, err);
          // The key is rejected: the provider's other models fail the same way.
          skipProviders.add(target.provider);
        }
        let action = plan.action;
        if (action === RecoveryAction.ROTATE_CREDENTIAL && !this.rotateCredential) action = RecoveryAction.FALLBACK_MODEL;
        if (action === RecoveryAction.COMPRESS_CONTEXT && !this.compressContext) action = RecoveryAction.FALLBACK_MODEL;
        if (action === RecoveryAction.ABORT && authFailure) action = RecoveryAction.FALLBACK_MODEL;
        if (action === RecoveryAction.ABORT) {
          log.warn(`${label(target)} failed permanently (${plan.reason}): ${plan.detail}`);
          throw err;
        }
        if (action === RecoveryAction.RETRY) {
          log.warn(`${label(target)} ${plan.reason}; retrying in ${plan.waitMs}ms (attempt ${flags.totalAttempts}/${this.policy.maxTotalAttempts})`);
          if (plan.waitMs > 0) await this.sleep(plan.waitMs);
          continue;
        }
        if (action === RecoveryAction.ROTATE_CREDENTIAL) {
          if (await this.rotateCredential(target.provider, err)) {
            flags.credentialRefreshed = true;
            continue;
          }
        }
        if (action === RecoveryAction.COMPRESS_CONTEXT) {
          const compressed = await this.compressContext(payload, { config: target, error: err });
          if (compressed) {
            payload = compressed;
            flags.contextCompressed = true;
            continue;
          }
        }
        const next = this._nextTarget(list, state, skipProviders, target);
        if (next.index === -1) {
          if (next.crossProvider) {
            const blocked = new Error(
              `${label(target)} failed (${plan.reason}: ${err.message}). The turn cannot move to ${label(next.crossProvider)} after its first model call; switch the main model or use Retry with… to try another model.`
            );
            blocked.code = 'FAILOVER_BLOCKED';
            blocked.cause = err;
            throw blocked;
          }
          log.warn(`${label(target)} failed (${plan.reason}) and the resolved list has nothing left.`);
          throw err;
        }
        log.warn(`${label(target)} failed (${plan.reason}); failing over to ${label(list[next.index])}.`);
        state.index = next.index;
        flags.credentialRefreshed = false;
        for (const key of Object.keys(attemptsByReason)) delete attemptsByReason[key];
      }
    }
    throw new Error('Failover loop exceeded its attempt ceiling without resolving.');
  }

  // A provider-shaped object over one resolved list, for an agent loop or a
  // single call. Its state (where it is in the list, whether anything has
  // answered) lives as long as the object: one per conversation history.
  routedProvider({ targets, signal = null } = {}) {
    const list = (Array.isArray(targets) ? targets : [])
      .filter((x) => x && x.provider && x.model)
      .map((x) => ({ provider: String(x.provider).toLowerCase(), model: String(x.model), effort: x.effort || null }));
    if (!list.length) throw new Error('A routed provider needs at least one target.');
    const state = this.newRouteState();
    const call = (messages, opts = {}, tools = null, onChunk = null) => this.routeTargets(list, messages, {
      ...(opts || {}),
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(typeof onChunk === 'function' ? { onChunk } : {}),
      ...(!opts?.abortSignal && signal ? { abortSignal: signal } : {})
    }, state);
    const current = () => ({ ...list[Math.min(state.index, list.length - 1)] });
    const answered = (name) => {
      const instance = state.lastInstance;
      return instance && typeof instance[name] === 'function' ? instance[name].bind(instance) : undefined;
    };
    const provider = {
      routed: true,
      targets: () => list.map((x) => ({ ...x })),
      current,
      getProviderName: () => current().provider,
      getDefaultModel: () => current().model,
      sendMessage: (messages, opts) => call(messages, opts),
      streamMessage: (messages, opts, onChunk) => call(messages, opts, null, onChunk),
      sendMessageWithTools: (messages, tools, opts) => call(messages, opts, tools),
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
    Object.defineProperty(provider, 'buildToolMessages', { enumerable: true, get: () => answered('buildToolMessages') });
    Object.defineProperty(provider, 'buildMultiToolMessages', { enumerable: true, get: () => answered('buildMultiToolMessages') });
    return provider;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/inference-router-targets.test.js tests/inference-router.test.js tests/cases-roles.test.js tests/agent-loop.test.js tests/agent-executor.test.js`
Expected: PASS, `# fail 0` (the old tier tests still pass: nothing old changed).

- [ ] **Step 7: Commit**

```bash
git add src/providers/inference-router.js src/providers/failover-policy.js src/cases/roles.js src/agents/agent-executor.js tests/inference-router-targets.test.js
git commit -m "feat(providers): fail over over a resolved target list, same provider only after the first answer"
```

---
## Task 5: Profiles, the migration and role resolution in the core

**Files:**
- Modify: `src/models/availability.js` (add `refreshForUse` after `ensureTested`, around `:160-165`)
- Modify: `src/core/create-core.js` — requires (`:65-66`); after `availability.on('changed', …)` (`:1053`) add the migration, `profiles` and `explainTarget`; the `new InferenceRouter({ … })` options (`:2230-2236`); after `resolveInference` (`:2250-2265`) add `snapshotModels`, `ensureTargetsTested`, `resolveRole`; `runLlmCommand` help and a `profile` action (`:1591-1620`, before the `list` action at `:1964`); the `context` object (`:3169-3176`) and the returned `models` (`:3271`)
- Modify: `src/service/commands/import-writer.js:68` (a dry run's core skips the migration)
- Create: `tests/helpers/profile-settings.js`
- Test: `tests/models-core-profiles.test.js` (new), `tests/models-availability.test.js` (one test added), `tests/models-core.test.js:204-232` (the OAuth chat-send test moves to `resolveRole`)

**Interfaces:**
- Consumes: `runTierMigration` (Task 3), `Profiles` (Tasks 1–2), `roleTimeoutMs` (Task 2), `InferenceRouter#routedProvider` and the `prepareProvider` option (Task 4), `KL_PROVIDERS` (`src/models/provider-ids.js`), `ProviderFactory.listRegistered()`.
- Produces:
  - `Availability#refreshForUse(provider, { staleFailureMs = 60000 }) → Promise<ProviderStatus>`: `ensureTested`, then one retest of a failed, non-auth status older than `staleFailureMs`.
  - A fresh install's "Default" profile has `main` = each provider's own `getDefaultModel()` in `PROVIDER_LABELS` order (the order the app lists providers), empty defaults (Ollama's) skipped; `worker`/`utility` empty.
  - `createCore({ …, skipModelMigration: true })` runs no migration and writes nothing (the import dry run's core); `getModelMigration()` then returns `{ migrated: false, skipped: true }`.
  - `core.context.getProfiles() → Profiles`, `core.context.getModelMigration() → runTierMigration's result`. The migration runs with `removeLegacy: false` until Task 12: the chat, case and agent paths still read the tiers until Tasks 6–8 move them, and tests seeding tier settings must keep working in between.
  - `core.context.explainTarget(provider, model, { needs }) → { usable, reasons, notes, entry }` — Availability's verdict, except a provider registered outside `KL_PROVIDERS` is usable when it has a credential.
  - `core.context.snapshotModels({ chatId = null, caseId = null, profileId = null }) → TurnModels` — precedence §6.3; a case chat's override comes from `case.yaml`.
  - `core.context.resolveRole(role = 'main', { needs = {}, explicit = null, chatId, caseId, profileId, turnModels }) → Promise<{ role, turnModels, targets, skipped, borrowedFrom, providerType, model, effort, provider, routed, timeoutMs }>` — `provider` is a prepared instance of the first target, `routed` a routed provider over all targets; throws `NoUsableModelError` / `UnknownRoleError`.
  - `core.models.profiles`.
  - `/llm profile` lists profiles; `/llm profile <name or id>` sets the default.
  - `tests/helpers/profile-settings.js`: `profileSettings(settings = {}, roles = {}, { id = 'p-test', name = 'Test profile' } = {}) → settings` (one profile, made the default) and `everyRole(target) → { main, worker, utility }` (the same target in all three).

- [ ] **Step 1: Write the test helper**

Create `tests/helpers/profile-settings.js`:

```js
// tests/helpers/profile-settings.js
// Settings with one model profile, made the default (spec 2026-09-27 §6.1):
// how a test says "these are the models" now that tiers are gone.

function profileSettings(settings = {}, roles = {}, { id = 'p-test', name = 'Test profile' } = {}) {
  const profile = { id, name, kind: 'user', roles: { main: [], worker: [], utility: [], ...roles } };
  return { ...settings, models: { ...(settings.models || {}), profiles: [profile], defaultProfileId: id } };
}

// The same target in all three core roles.
function everyRole(target) {
  const t = { effort: null, ...target };
  return { main: [{ ...t }], worker: [{ ...t }], utility: [{ ...t }] };
}

module.exports = { profileSettings, everyRole };
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/models-availability.test.js`, inside `describe('during use and over time', …)`, after the `ensureTested` test:

```js
  it('refreshForUse tests a never-tested provider, retests a stale non-auth failure once, and leaves an auth failure alone', async () => {
    const fresh = setup({ lists: { openai: ['gpt-5.5'] } });
    assert.strictEqual((await fresh.availability.refreshForUse('openai')).ok, true);
    assert.deepStrictEqual(fresh.created, ['openai']);

    const stale = setup({ lists: { openai: ['gpt-5.5'] }, statuses: { openai: { ok: false, error: 'timeout', checkedAt: hoursAgo(1), models: [] } } });
    assert.strictEqual((await stale.availability.refreshForUse('openai')).ok, true);
    assert.deepStrictEqual(stale.created, ['openai']);

    const recent = setup({ statuses: { openai: { ok: false, error: 'timeout', checkedAt: NOW.toISOString(), models: [] } } });
    assert.strictEqual((await recent.availability.refreshForUse('openai')).ok, false);
    assert.deepStrictEqual(recent.created, []);

    const auth = setup({ statuses: { openai: { ok: false, error: 'rejected', checkedAt: hoursAgo(1), models: [], authFailed: true } } });
    assert.strictEqual((await auth.availability.refreshForUse('openai')).authFailed, true);
    assert.deepStrictEqual(auth.created, []);
  });
```

Create `tests/models-core-profiles.test.js`:

```js
// tests/models-core-profiles.test.js
// Profiles in the core (spec 2026-09-27 §6, §13): the tier migration at
// construction, the snapshot precedence, usability for registered
// providers, role resolution and /llm profile.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore, PROVIDER_LABELS } = require('../src/core/create-core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const ProviderFactory = require('../src/providers/provider-factory');
const git = require('../src/cases/git');
const { profileSettings } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const tempDirs = [];
const realFetch = globalThis.fetch;
const savedCasesRoot = process.env.KL_CASES_ROOT;
afterEach(() => {
  globalThis.fetch = realFetch;
  setActiveCatalog(null);
  if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeCore({ settings, chats = [], apiStatus = {}, patchStore = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-core-profiles-'));
  tempDirs.push(dataDir);
  delete process.env.KL_CASES_ROOT;
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  if (settings) store.set('settings', settings);
  store.set('chats', chats);
  store.set('apiStatus', apiStatus);
  if (patchStore) patchStore(store);
  const core = createCore({
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: () => {} },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); }
  });
  return { core, store };
}

const legacySettings = () => ({
  activeProvider: 'openai',
  inference: {
    activeTier: 'standard',
    tierMap: { fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' }, standard: { provider: 'openai', model: 'gpt-5.5' }, smart: { provider: 'openai', model: 'gpt-5.5' } }
  }
});

const threeProfiles = () => ({
  models: {
    profiles: [
      { id: 'p-a', name: 'A', roles: { main: [t('openai', 'gpt-5.5')] } },
      { id: 'p-b', name: 'B', roles: { main: [t('anthropic', 'claude-sonnet-5')] } },
      { id: 'p-c', name: 'C', roles: { main: [t('gemini', 'gemini-2.5-pro')] } }
    ],
    defaultProfileId: 'p-a'
  }
});

describe('the tier migration at core construction', () => {
  it('moves stored tier settings into one migrated default profile', () => {
    const { core, store } = makeCore({ settings: legacySettings() });
    const migration = core.context.getModelMigration();
    assert.strictEqual(migration.migrated, true);
    const profile = core.context.getProfiles().getDefault();
    assert.strictEqual(profile.kind, 'migrated');
    assert.deepStrictEqual(profile.roles.main, [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(profile.roles.utility, [t('groq', 'llama-3.3-70b-versatile')]);
    assert.strictEqual(store.get('settings').models.profiles.length, 1);
    assert.strictEqual(core.models.profiles, core.context.getProfiles());
  });

  it('gives a fresh store a Default profile whose main lists each provider\'s default model', () => {
    const { core } = makeCore();
    assert.strictEqual(core.context.getModelMigration().fresh, true);
    const profile = core.context.getProfiles().getDefault();
    const expected = Object.keys(PROVIDER_LABELS)
      .map((provider) => ({ provider, model: ProviderFactory.create(provider, 'test-key-123456').getDefaultModel() || '', effort: null }))
      .filter((x) => x.model);
    assert.deepStrictEqual(profile.roles, { main: expected, worker: [], utility: [] });
    assert.ok(!profile.roles.main.some((x) => x.provider === 'ollama'), 'Ollama ships no default');
  });

  for (const [provider, key] of [['openai', 'sk-test-openai-123456'], ['anthropic', 'sk-ant-test-123456']]) {
    it(`a fresh install with only a ${provider} key resolves main to ${provider}'s default model`, async () => {
      const { core } = makeCore();
      core.saveProviderToken(provider, key);
      const model = ProviderFactory.create(provider, key).getDefaultModel();
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      const r = await core.context.resolveRole('main');
      assert.deepStrictEqual([r.providerType, r.model], [provider, model]);
      assert.strictEqual((await core.context.resolveRole('utility')).borrowedFrom, 'main');
    });
  }

  it('leaves the old settings untouched when the write fails, and still starts', () => {
    const before = legacySettings();
    const { core, store } = makeCore({
      settings: before,
      patchStore: (s) => {
        const set = s.set.bind(s);
        let failed = false;
        s.set = (key, value) => {
          if (key === 'settings' && !failed) { failed = true; throw new Error('disk full'); }
          return set(key, value);
        };
      }
    });
    assert.deepStrictEqual(core.context.getModelMigration(), { migrated: false, error: 'disk full' });
    assert.deepStrictEqual(store.get('settings'), before);
    assert.deepStrictEqual(core.context.getProfiles().list(), []);
  });
});

describe('snapshotModels', () => {
  it('uses the chat\'s profile and main override, else the default', () => {
    const { core } = makeCore({
      settings: threeProfiles(),
      chats: [{ id: 'c1', title: 'x', messages: [], profileId: 'p-b', mainOverride: t('openai', 'gpt-5.4') }, { id: 'c2', title: 'y', messages: [] }]
    });
    const one = core.context.snapshotModels({ chatId: 'c1' });
    assert.deepStrictEqual([one.profileId, one.mainOverride], ['p-b', t('openai', 'gpt-5.4')]);
    const two = core.context.snapshotModels({ chatId: 'c2' });
    assert.deepStrictEqual([two.profileId, two.mainOverride], ['p-a', null]);
    assert.strictEqual(core.context.snapshotModels({ chatId: 'c1', profileId: 'p-c' }).profileId, 'p-c');
    assert.strictEqual(core.context.snapshotModels().profileId, 'p-a');
  });

  it('snapshotModels falls back to the default for a stale chat profileId', () => {
    const { core } = makeCore({ settings: threeProfiles(), chats: [{ id: 'c1', title: 'x', messages: [], profileId: 'p-gone' }] });
    assert.strictEqual(core.context.snapshotModels({ chatId: 'c1' }).profileId, 'p-a');
  });

  it('in a case chat, case.yaml\'s profile and main override win over the chat\'s', async (ctx) => {
    if (!(await git.isGitAvailable())) return ctx.skip('git is not on PATH');
    const { core } = makeCore({ settings: threeProfiles() });
    const rt = core.context.getCaseRuntime();
    const info = await rt.createCase({ title: 'Lakeside lot' });
    core.context.setChats([{ id: 'c1', title: 'x', messages: [], caseId: info.id, profileId: 'p-b', mainOverride: t('openai', 'gpt-5.4') }]);
    const plain = core.context.snapshotModels({ chatId: 'c1' });
    assert.deepStrictEqual([plain.profileId, plain.mainOverride], ['p-b', null], 'the chat\'s own override does not apply in a case chat');
    rt.store.updateMeta(info.id, { profile: 'p-c', mainOverride: t('anthropic', 'claude-sonnet-5') });
    const chosen = core.context.snapshotModels({ chatId: 'c1' });
    assert.deepStrictEqual([chosen.profileId, chosen.mainOverride], ['p-c', t('anthropic', 'claude-sonnet-5')]);
    assert.strictEqual(core.context.snapshotModels({ caseId: info.id }).profileId, 'p-c', 'an unattended case turn follows case.yaml');
  });
});

describe('explainTarget', () => {
  it('lets a registered provider outside the fourteen answer when it has a key', () => {
    ProviderFactory.registerProvider('fake-core', class { getDefaultModel() { return 'fake'; } });
    try {
      const { core } = makeCore();
      assert.deepStrictEqual(core.context.explainTarget('fake-core', 'fake').reasons, ['No token saved for fake-core.']);
      core.saveProviderToken('fake-core', 'fake-token-123456');
      assert.strictEqual(core.context.explainTarget('fake-core', 'fake').usable, true);
      assert.match(core.context.explainTarget('openai', 'gpt-5.5').reasons[0], /No token saved for OpenAI/);
    } finally {
      ProviderFactory._registry.delete('fake-core');
    }
  });
});

describe('resolveRole', () => {
  it('tests an untested provider first, then returns the instance, a routed provider and the role timeout', async () => {
    const { core } = makeCore({ settings: profileSettings({}, { main: [t('openai', 'gpt-5.5')] }) });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const r = await core.context.resolveRole('main', { needs: { toolCall: true } });
    assert.ok(seen.some((u) => u.endsWith('/v1/models')), seen.join('\n'));
    assert.deepStrictEqual([r.providerType, r.model, r.targets], ['openai', 'gpt-5.5', [t('openai', 'gpt-5.5')]]);
    assert.strictEqual(r.provider.getProviderName(), 'openai');
    assert.strictEqual(r.routed.routed, true);
    assert.deepStrictEqual(r.routed.current(), t('openai', 'gpt-5.5'));
    assert.strictEqual(r.timeoutMs, 90000);
    const utility = await core.context.resolveRole('utility');
    assert.strictEqual(utility.borrowedFrom, 'main');
    assert.strictEqual(utility.timeoutMs, 15000);
  });

  it('fails with every skipped target and its reason when nothing is usable', async () => {
    const { core } = makeCore({ settings: profileSettings({}, { main: [t('groq', 'llama-3.3-70b-versatile')] }) });
    await assert.rejects(core.context.resolveRole('main'), (err) => err.code === 'NO_USABLE_MODEL' && /groq\/llama-3\.3-70b-versatile \(No token saved for Groq\.\)/.test(err.message));
  });

  it('checks an explicit target alone', async () => {
    ProviderFactory.registerProvider('fake-core', class { getDefaultModel() { return 'fake'; } getProviderName() { return 'fake-core'; } });
    try {
      const { core } = makeCore({ settings: profileSettings({}, { main: [t('groq', 'x')] }) });
      core.saveProviderToken('fake-core', 'fake-token-123456');
      const r = await core.context.resolveRole('main', { explicit: { provider: 'fake-core', model: 'fake' } });
      assert.deepStrictEqual(r.targets, [t('fake-core', 'fake')]);
    } finally {
      ProviderFactory._registry.delete('fake-core');
    }
  });
});

describe('/llm profile', () => {
  it('lists profiles and sets the default by name or id', async () => {
    const { core } = makeCore({ settings: threeProfiles() });
    const list = await core.context.runLlmCommand('/llm profile');
    assert.strictEqual(list.ok, true);
    assert.match(list.output, /\*\*A\*\* \(default\)/);
    const byName = await core.context.runLlmCommand('/llm profile b');
    assert.deepStrictEqual(byName, { ok: true, output: 'Default profile set to B.' });
    assert.strictEqual(core.context.getProfiles().defaultId(), 'p-b');
    assert.strictEqual((await core.context.runLlmCommand('/llm profile p-c')).ok, true);
    assert.strictEqual(core.context.getProfiles().defaultId(), 'p-c');
    const missing = await core.context.runLlmCommand('/llm profile Nope');
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /No profile named "Nope"/);
  });
});
```

In `tests/models-core.test.js`, in the test `'a chat send to Anthropic stays in OAuth mode once the token is cached'`:

- add at the top of the file, after the other requires: `const { profileSettings } = require('./helpers/profile-settings');`
- replace `core.context.setSettings({ ...core.getSettings(), activeProvider: 'anthropic' });` with:

```js
    core.context.setSettings(profileSettings(core.getSettings(), { main: [{ provider: 'anthropic', model: 'claude-sonnet-5', effort: null }] }));
    store.set('apiStatus', { anthropic: { ok: true, checkedAt: new Date().toISOString(), models: ['claude-sonnet-5'] } });
```

- replace both `await core.context.resolveInference({})` with `await core.context.resolveRole('main')`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/models-core-profiles.test.js tests/models-availability.test.js tests/models-core.test.js`
Expected: FAIL — `core.context.getModelMigration is not a function`, `availability.refreshForUse is not a function`, `core.context.resolveRole is not a function`.

- [ ] **Step 4: Add `refreshForUse` to Availability**

In `src/models/availability.js`, after `ensureTested(provider) { … }` add:

```js
  // Before a model call (spec §5.2): a provider never tested is tested now,
  // and a failed test that was not an auth failure and is older than
  // staleFailureMs is retested once, so a transient blip does not stick
  // until the next scheduled retest. An auth failure is only cleared by a
  // fixed key and its own test.
  async refreshForUse(provider, { staleFailureMs = 60 * 1000 } = {}) {
    const p = normalizeProvider(provider);
    const status = await this.ensureTested(p);
    if (status && status.ok === false && !status.authFailed && status.checkedAt
      && this.now().getTime() - Date.parse(status.checkedAt) > staleFailureMs) {
      return this.test(p);
    }
    return status;
  }
```

- [ ] **Step 5: Wire profiles and the migration into the core**

In `src/core/create-core.js`:

(a) Below `const { localEntry } = require('../models/normalize');` add:

```js
const { Profiles } = require('../models/profiles');
const { roleTimeoutMs } = require('../models/resolver');
const { runTierMigration } = require('../models/migrate-tiers');
const { KL_PROVIDERS } = require('../models/provider-ids');
```

(b) Directly after `availability.on('changed', (change) => ui.send('models:statusChanged', change));` add:

```js
  // Profiles and roles (spec 2026-09-27 §6). The tier settings move to a
  // profile once, here, before anything resolves a model (§13). The raw
  // stored settings are read, not the merged view: the migration must see
  // what the owner actually saved.
  // A caller that must write nothing (an import dry run) skips it.
  const modelMigration = deps.skipModelMigration === true ? { migrated: false, skipped: true } : runTierMigration({
    readRaw: () => store.get('settings', null),
    writeRaw: (raw) => store.set('settings', raw),
    // The old keys stay while code still reads them; they go with the tier code.
    removeLegacy: false,
    catalog,
    // A fresh install's Default main: each provider's own default model, in
    // the order the app lists providers; an empty default (Ollama) is skipped.
    freshMain: Object.keys(PROVIDER_LABELS).map((provider) => {
      try {
        return { provider, model: ProviderFactory.create(provider, 'model-probe-token').getDefaultModel() || '' };
      } catch {
        return { provider, model: '' };
      }
    }).filter((x) => x.model),
    accountModels: Object.fromEntries(Object.entries(getApiStatus() || {})
      .map(([provider, status]) => [provider, Array.isArray(status?.models) ? status.models : []]))
  });
  const profiles = new Profiles({ getSettings, setSettings, catalog });

  // A provider registered at runtime outside King Louie's fourteen (a host
  // extension, or a test's fake) has no connection test: it is usable when
  // it has a credential. Everything else is Availability's verdict (§5.1).
  const explainTarget = (provider, model, options = {}) => {
    const p = normalizeProvider(provider);
    if (!KL_PROVIDERS.includes(p) && ProviderFactory.listRegistered().includes(p)) {
      return hasProviderCredential(p)
        ? { usable: true, reasons: [], notes: [`${p} is a registered provider with no connection test.`], entry: null }
        : { usable: false, reasons: [`No token saved for ${providerLabels[p] || p}.`], notes: [], entry: null };
    }
    return availability.explain(p, model, options);
  };
```

(c) In `const inferenceRouter = new InferenceRouter({ … })`, after `onProviderError: reportProviderError` add (keep a comma after the previous line):

```js
    // Once per provider per turn: an Anthropic OAuth session needs a fresh
    // access token before its first call (the routed path's ensureOAuthToken).
    prepareProvider: async (instance, provider) => {
      if (provider === 'anthropic' && instance?.authMode === 'oauth') {
        instance.apiKey = await refreshAnthropicOAuthToken();
      }
    }
```

(d) Directly after the `const resolveInference = async (selection = {}) => { … };` block add:

```js
  // ---- Profiles and roles (spec 2026-09-27 §6) ----

  const readCaseModelChoice = (caseId) => {
    if (!caseId) return null;
    try {
      const meta = caseRuntime.getCase(caseId);
      return { profile: meta.profile || null, mainOverride: meta.mainOverride || null };
    } catch (err) {
      log.warn(`Reading the model choice of case ${caseId} failed: ${err.message}`);
      return null;
    }
  };

  // Precedence (§6.3): the case's profile and main override, else the
  // chat's profile and main override, else the default profile. In a case
  // chat the override lives in case.yaml, so unattended turns follow it.
  const snapshotModels = ({ chatId = null, caseId = null, profileId = null } = {}) => {
    const chat = chatId ? getChats().find((c) => c.id === chatId) || null : null;
    const theCaseId = caseId || chat?.caseId || null;
    const caseChoice = readCaseModelChoice(theCaseId);
    const chosen = profileId || caseChoice?.profile || chat?.profileId || null;
    const mainOverride = theCaseId ? (caseChoice?.mainOverride || null) : (chat?.mainOverride || null);
    return profiles.snapshot({ profileId: chosen, mainOverride, explain: explainTarget });
  };

  // Every provider a role could use is tested before the resolve, if it
  // never was (spec §5.2); a registered provider outside the fourteen has
  // no test to run.
  const ensureTargetsTested = async (targets) => {
    const providers = [...new Set((targets || []).map((x) => String(x?.provider || '').toLowerCase()))]
      .filter((p) => KL_PROVIDERS.includes(p) && hasProviderCredential(p));
    await Promise.all(providers.map((p) => availability.refreshForUse(p)));
  };

  // One role for one call (spec §6.3, §6.4): the usable targets in order, a
  // prepared instance of the first (for callers making one direct call) and
  // a routed provider that fails over across them all (§6.7).
  const resolveRole = async (role = 'main', { needs = {}, explicit = null, chatId = null, caseId = null, profileId = null, turnModels = null } = {}) => {
    const models = turnModels || snapshotModels({ chatId, caseId, profileId });
    await ensureTargetsTested(explicit ? [explicit] : models.candidatesFor(role));
    const resolved = models.mustResolve(role, { needs, explicit });
    const first = resolved.targets[0];
    if (!first) throw new Error(`${role} has no model of its own; its own settings apply.`);
    const instance = createProviderInstance(first.provider, getDecryptedProviderToken(first.provider));
    await ensureOAuthToken({ providerType: first.provider, provider: instance });
    return {
      role,
      turnModels: models,
      targets: resolved.targets,
      skipped: resolved.skipped,
      borrowedFrom: resolved.borrowedFrom,
      providerType: first.provider,
      model: first.model,
      effort: first.effort || null,
      provider: instance,
      routed: inferenceRouter.routedProvider({ targets: resolved.targets }),
      timeoutMs: roleTimeoutMs(getSettings(), role, profiles.customRoles())
    };
  };
```

(e) In `runLlmCommand`'s help list, after the line ``'- `/llm model <provider> <model>` — set model for provider',`` add:

```js
          '- `/llm profile` — list model profiles; `/llm profile <name>` — make one the default',
```

and directly before `if (action === 'list') {` add:

```js
    if (action === 'profile' || action === 'profiles') {
      const wanted = rest.join(' ').trim();
      const list = profiles.list();
      const defaultId = profiles.defaultId();
      if (!wanted) {
        if (!list.length) return { ok: true, output: 'No model profiles yet. Add one in Settings → Models.' };
        return {
          ok: true,
          output: [
            '### Model profiles',
            '',
            ...list.map((p) => `- **${p.name}**${p.id === defaultId ? ' (default)' : ''} | id: \`${p.id}\``),
            '',
            'Use `/llm profile <name>` to make one the default.'
          ].join('\n')
        };
      }
      const match = list.find((p) => p.id === wanted) || list.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (!match) return { ok: false, error: `No profile named "${wanted}". Use \`/llm profile\` to list them.` };
      profiles.setDefault(match.id);
      return { ok: true, output: `Default profile set to ${match.name}.` };
    }
```

(f) In the `context` object, after `getAvailability: () => availability,` add:

```js
    getProfiles: () => profiles,
    getModelMigration: () => modelMigration,
    explainTarget,
    snapshotModels,
    resolveRole,
```

(g0) In `src/service/commands/import-writer.js`, in `openCore`'s dry-run branch, add `skipModelMigration: true` to the `createCore({ … })` options (`…, adminExecutors: noAdminExecutors(), skipModelMigration: true }`): a dry run must write nothing under `--data-dir` (`tests/desktop-import-source.test.js`, `'dry run leaves a fresh data dir completely untouched'`), and the migration would write `chat-data.json`.

(g) In the returned object change `models: { catalog, availability, startBackgroundChecks: startModelsBackgroundChecks },` to:

```js
    models: { catalog, availability, profiles, startBackgroundChecks: startModelsBackgroundChecks },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/models-core-profiles.test.js tests/models-availability.test.js tests/models-core.test.js tests/core-create.test.js tests/models-default-ids.test.js tests/desktop-import-source.test.js tests/desktop-import.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/models/availability.js src/core/create-core.js src/service/commands/import-writer.js tests/helpers/profile-settings.js tests/models-core-profiles.test.js tests/models-availability.test.js tests/models-core.test.js
git commit -m "feat(core): migrate tiers to a profile at start; snapshotModels, resolveRole and /llm profile"
```

---
## Task 6: Headless and agent runs resolve through the default profile

**Files:**
- Modify: `src/core/create-core.js` — requires; `createAgentRuntime` (`:2267-2320`); `agentExecutorAdapter.execute` (`:2522-2580`); the skills `llmProvider` getter (`:2768-2780`); the ingest `createCallModel(…)` (`:3077`)
- Modify: `src/ipc/agent-handlers.js` (the four `createAgentRuntime` calls, the `tier:`/`model:` run options, `AgentExecutor` options)
- Modify: `src/agents/agent-schema.js:11` (a `role` field), `src/agents/builtin/main-assistant.js`, `planner.js`, `code-writer.js`, `code-explorer.js`, `case-researcher.js` (explicit roles)
- Test: `tests/models-headless.test.js` (new); existing tests that configured a provider through tiers now use `tests/helpers/profile-settings.js`: `tests/executor-adapter-provider.test.js`, `tests/core-remote-approvals.test.js` (three places), `tests/fleet-core-seams.test.js`, `tests/fleet-delegate.test.js`, `tests/cases-executor-core.test.js`, `tests/agent-handlers.test.js` (one test added). (`tests/desktop-bridge-dispatcher.test.js` and `tests/e2e/_attach-service.js` drive the chat send path, which still reads the tiers until Task 8; they move to profiles there.)

**Interfaces:**
- Consumes: `snapshotModels`, `resolveRole`, `explainTarget` (Task 5); `roleForAgent`, `roleForTier`, `CORE_ROLES` (Task 1); `NO_RETRY` and `AgentExecutor`'s `failoverPolicy` option (Task 4).
- Produces:
  - `core.context.createAgentRuntime(selection = {}, event, approvalRequester, runtimeOptions)` with `selection = { role = 'main', profileId?, provider?, model? }` → `{ role, providerType, model, timeoutMs, targets, turnModels, provider /* routed */, runtimeEnvironment, toolExecutor, toolDefinitions }`. Needs `toolCall`. No `tier` key any more.
  - `Agent#role` (`config.role` or `null`). Built-in agents name their role: main-assistant, planner, code-writer → `main`; code-explorer, case-researcher → `worker`. Only a user-defined agent without a `role` has its `inferenceTier` mapped (fast → utility, standard → worker, smart → main; §13 step 5).
  - `agentExecutorAdapter.execute(agent, message, options)` runs on `options.role`, else `roleForAgent(agent)`, on `options.profileId` or the default profile; `options.provider`/`options.model` are an explicit target. Its loop uses `NO_RETRY`.
  - A provider named with no model takes that provider's first model in the role, else anywhere in the profile's core roles, else the run fails naming the provider.
  - `agent:execute` accepts `{ agentId, message, role?, tier? }` (`tier` read through `roleForTier`); `agent:executeParallel` and `agent:executeSerial` run on `main`; `agent:executeWithDeps` on the agent's role.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-headless.test.js`:

```js
// tests/models-headless.test.js
// Headless and agent runs (spec 2026-09-27 §8, §12): each agent runs on its
// role from the default profile — its pre-M2 tier read as the mapped role —
// or on a target its caller names, and a failing first target fails over.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const { listAgents } = require('../src/agents');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { profileSettings } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const FAKE = 'kl-test-headless';
const t = (provider, model) => ({ provider, model, effort: null });
const tempDirs = [];
const savedCasesRoot = process.env.KL_CASES_ROOT;
afterEach(() => {
  ProviderFactory._registry.delete(FAKE);
  setActiveCatalog(null);
  if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// A registered fake provider: every call records the model it was asked
// for; a model named "down" fails the way an outage does.
function fakeProvider(used) {
  return class {
    constructor(apiKey) { this.apiKey = apiKey; }
    getProviderName() { return FAKE; }
    getDefaultModel() { return 'fake-default'; }
    async sendMessage() { return 'unused'; }
    async sendMessageWithTools(messages, tools, options) {
      used.push(options.model);
      if (options.model === 'down') throw new Error('upstream exploded');
      return { type: 'text', content: `answered by ${options.model}` };
    }
  };
}

async function startCore(roles) {
  const used = [];
  ProviderFactory.registerProvider(FAKE, fakeProvider(used));
  delete process.env.KL_CASES_ROOT;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-headless-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  store.set('settings', profileSettings({}, roles));
  const core = createCore({
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); }
  });
  await core.start();
  core.saveProviderToken(FAKE, 'fake-token-123456');
  return { core, used, adapter: core.context.getAgentExecutorAdapter() };
}

const agent = (id) => listAgents().find((a) => a.id === id);

describe('headless agent runs', () => {
  it('built-in agents run on their own roles', () => {
    const roles = Object.fromEntries(['main', 'planner', 'code-writer', 'code-explorer', 'case-researcher'].map((id) => [id, agent(id).role]));
    assert.deepStrictEqual(roles, { main: 'main', planner: 'main', 'code-writer': 'main', 'code-explorer': 'worker', 'case-researcher': 'worker' });
  });

  it('run on the agent\'s role; a user-defined agent\'s tier reads as the mapped role', async () => {
    const { core, used, adapter } = await startCore({ main: [t(FAKE, 'main-model')], worker: [t(FAKE, 'worker-model')], utility: [t(FAKE, 'utility-model')] });
    const Agent = require('../src/agents/agent-schema');
    const custom = (inferenceTier) => new Agent({ id: `custom-${inferenceTier}`, inferenceTier, allowedTools: ['Read'] });
    try {
      assert.strictEqual((await adapter.execute(agent('main'), 'hello')).content, 'answered by main-model');
      assert.strictEqual((await adapter.execute(agent('code-explorer'), 'hello')).content, 'answered by worker-model');
      assert.strictEqual((await adapter.execute(custom('fast'), 'hello')).content, 'answered by utility-model');
      assert.strictEqual((await adapter.execute(custom('standard'), 'hello')).content, 'answered by worker-model');
      assert.strictEqual((await adapter.execute(custom('smart'), 'hello')).content, 'answered by main-model');
      assert.strictEqual((await adapter.execute(agent('code-explorer'), 'hello', { role: 'main' })).content, 'answered by main-model');
      assert.deepStrictEqual(used, ['main-model', 'worker-model', 'utility-model', 'worker-model', 'main-model', 'main-model']);
    } finally {
      await core.shutdown();
    }
  });

  it('a named model is an explicit target; a provider with no model takes the profile\'s model of it', async () => {
    const { core, used, adapter } = await startCore({ main: [t(FAKE, 'main-model')], worker: [t(FAKE, 'worker-model')] });
    try {
      await adapter.execute(agent('code-explorer'), 'hello', { model: 'named-model' });
      await adapter.execute(agent('code-explorer'), 'hello', { provider: FAKE });
      assert.deepStrictEqual(used, ['named-model', 'worker-model']);
      await assert.rejects(adapter.execute(agent('main'), 'hello', { provider: 'groq' }), /No groq model is in the profile "Test profile"/);
    } finally {
      await core.shutdown();
    }
  });

  it('a failing first target fails over to the next one in the role', async () => {
    const { core, used, adapter } = await startCore({ worker: [t(FAKE, 'down'), t(FAKE, 'backup')], main: [t(FAKE, 'main-model')] });
    // code-explorer runs on worker.
    try {
      assert.strictEqual((await adapter.execute(agent('code-explorer'), 'hello')).content, 'answered by backup');
      assert.deepStrictEqual(used, ['down', 'backup']);
    } finally {
      await core.shutdown();
    }
  });

  it('createAgentRuntime returns the role, its first model and a routed provider', async () => {
    const { core } = await startCore({ main: [t(FAKE, 'main-model')] });
    try {
      const rt = await core.context.createAgentRuntime({ role: 'utility' });
      assert.deepStrictEqual([rt.role, rt.providerType, rt.model, rt.timeoutMs], ['utility', FAKE, 'main-model', 15000]);
      assert.strictEqual(rt.provider.routed, true);
      assert.strictEqual('tier' in rt, false);
    } finally {
      await core.shutdown();
    }
  });

  it('fails before any call when the role has no usable model, with the reasons', async () => {
    const { core, used, adapter } = await startCore({ main: [t('groq', 'llama-3.3-70b-versatile')] });
    try {
      await assert.rejects(adapter.execute(agent('planner'), 'hello'), /No usable model for main.*groq\/llama-3\.3-70b-versatile \(No token saved for Groq\.\)/);
      assert.deepStrictEqual(used, []);
    } finally {
      await core.shutdown();
    }
  });
});
```

Append to `tests/agent-handlers.test.js`, at the end of the file:

```js
describe('agent-handlers roles', () => {
  it('asks createAgentRuntime for a role, never a tier', async () => {
    const selections = [];
    const ipcMain = createIpcMainMock();
    const context = createContext({
      createAgentRuntime: async (selection) => {
        selections.push(selection);
        return { provider: {}, toolExecutor: {}, role: selection.role, model: 'test-model', timeoutMs: 1000, toolDefinitions: [], runtimeEnvironment: { workingDirectory: process.cwd() } };
      }
    });
    registerAgentHandlers(ipcMain, context);
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi', tier: 'fast' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi', role: 'main' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_PARALLEL)({}, { agentIds: ['writer'], message: 'hi' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_SERIAL)({}, { agentIds: ['writer'], message: 'hi' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_WITH_DEPS)({}, { agentId: 'writer', tasks: [{ id: 't1', subject: 'Do a thing' }] });
    assert.deepStrictEqual(selections, [{ role: 'worker' }, { role: 'utility' }, { role: 'main' }, { role: 'main' }, { role: 'main' }, { role: 'worker' }]);
    assert.ok(context.executorCalls.every((opts) => opts.failoverPolicy && opts.failoverPolicy.plan(new Error('x')).action === 'abort'));
  });
});
```

In `tests/executor-adapter-provider.test.js`:

- add `const { profileSettings, everyRole } = require('./helpers/profile-settings');` after the other requires;
- in the `stub` class add `async listModels() { return ['gpt-stub', 'groq-model']; }` after `getDefaultModel()`;
- replace `store.set('settings', { activeProvider: 'groq', inference: { activeTier: 'standard', tierMap: { standard: { provider: 'groq', model: 'groq-model' } } } });` with `store.set('settings', profileSettings({}, everyRole({ provider: 'groq', model: 'groq-model' })));`;
- rename the test to `'runs on options.provider and options.model while the default profile names another provider'`.

In each of these, replace the tier block (`const tiers = { provider: X, model: Y };`, `const settings = core.getSettings();` or `seed.getSettings()`, and the `setSettings({ ...settings, activeProvider: X, inference: { …tierMap… } })` call) with one line using the same `X` and `Y`, and add `const { profileSettings, everyRole } = require('<relative>/helpers/profile-settings');` to the file's requires:

| File | Where | Replacement line |
|---|---|---|
| `tests/core-remote-approvals.test.js` | `driveGatewayMessage` (`:80-86`) | `core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE_PROVIDER, model: 'fake' })));` |
| `tests/core-remote-approvals.test.js` | `configureFakeProvider` (`:216-222`) | same line |
| `tests/core-remote-approvals.test.js` | the test at `:331-337` | same line |
| `tests/fleet-core-seams.test.js` | `phoneCore` (`:66-68`) | `core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));` |
| `tests/fleet-delegate.test.js` | `:114-116` | `core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));` |
| `tests/cases-executor-core.test.js` | `:189-195` | `core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: FAKE, model: 'fake' })));` |

In `tests/cases-executor-core.test.js` also replace the three `createAgentRuntime({ tier: 'standard' }, …)` calls (`:222`, `:228`, `:268`) with `createAgentRuntime({ role: 'worker' }, …)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/models-headless.test.js tests/agent-handlers.test.js`
Expected: FAIL — the adapter still resolves through the tier (`answered by …` mismatches, a `tier` key on the runtime) and the agent handlers pass `{ tier }`.

- [ ] **Step 3: Give agents a role; built-in agents name theirs**

In `src/agents/agent-schema.js`, after `this.inferenceTier = config.inferenceTier || 'standard';` add:

```js
    // The agent's model role (models spec 2026-09-27 §8). A user-defined
    // agent without one has its inferenceTier read as the mapped role (§13).
    this.role = typeof config.role === 'string' && config.role.trim() ? config.role.trim() : null;
```

Add a `role` line directly above each built-in agent's `inferenceTier:` line: `role: 'main',` in `src/agents/builtin/main-assistant.js`, `planner.js` and `code-writer.js`; `role: 'worker',` in `src/agents/builtin/code-explorer.js` and `case-researcher.js`.

- [ ] **Step 3b: Rewrite `createAgentRuntime` and the adapter**

In `src/core/create-core.js`:

(a) Add to the requires, after the lines added in Task 5:

```js
const { roleForAgent, CORE_ROLES } = require('../models/roles');
const { NO_RETRY } = require('../providers/failover-policy');
```

(b) Replace the whole `const createAgentRuntime = async ( … ) => { … };` with:

```js
  // A caller naming a provider and/or model (a workflow task's
  // preferredModel, SpawnAgent's free-form model) gets an explicit target,
  // still checked for usability (spec §6.3). A model with no provider keeps
  // the role's first provider; a provider with no model takes that
  // provider's model from the profile, never a provider default (M-D2).
  const explicitTargetFor = (selection, turnModels, role) => {
    const provider = normalizeProvider(selection.provider || '');
    const model = String(selection.model || '').trim();
    if (!provider && !model) return null;
    if (!provider) return { provider: turnModels.candidatesFor(role)[0]?.provider || '', model, effort: null };
    if (model) return { provider, model, effort: null };
    const inProfile = [...turnModels.candidatesFor(role), ...CORE_ROLES.flatMap((r) => turnModels.configuredFor(r))]
      .find((x) => x.provider === provider);
    if (inProfile) return { ...inProfile };
    throw new Error(`No ${provider} model is in the profile "${turnModels.profileName}"; name the model to use.`);
  };

  // An agent or headless run's models (spec §8, §12): the role on the
  // default profile, or on the profile the caller names, fixed for the run.
  const createAgentRuntime = async (
    selection = {},
    event = null,
    approvalRequester = null,
    runtimeOptions = {}
  ) => {
    const sel = selection && typeof selection === 'object' ? selection : {};
    const role = typeof sel.role === 'string' && sel.role ? sel.role : 'main';
    const turnModels = snapshotModels({ profileId: sel.profileId || null });
    const explicit = explicitTargetFor(sel, turnModels, role);
    const resolution = await resolveRole(role, { needs: { toolCall: true }, explicit, turnModels });
    const workingDirectory = runtimeOptions.workingDirectory || hostWorkingDirectory;
    const runtimeEnvironment = await getRuntimeEnvironment({
      workingDirectory
    });
    // Pull the persisted allowlist so "Always Allow" decisions made in earlier
    // workflow/chat runs carry forward. Without this, each Plan & Execute
    // starts from an empty allowlist and re-prompts for the same directories.
    const settings = getSettings();
    const allowedDirectories = Array.isArray(settings.allowedDirectories)
      ? settings.allowedDirectories
      : [];
    const toolExecutor = await createToolExecutorWithApprovals(
      event,
      runtimeEnvironment,
      approvalRequester,
      // origin: forwarded from agentExecutorAdapter.execute (program §4.21) so
      // a child run's audit trail inherits the parent's deviceId/session
      // instead of recomputing a fresh, poorer origin from a null event and
      // an unmarked-for-origin-purposes requester.
      {
        workingDirectory,
        allowedDirectories,
        origin: runtimeOptions.origin || null,
        // Cases stage 3: isolated children run only their agent's tools, guarded.
        guardContext: runtimeOptions.guardContext || null,
        allowedToolNames: runtimeOptions.allowedToolNames || null,
        // Fleet stage 4 §3.8: a delegate turn's chat id and scope gate.
        ...(runtimeOptions.chatId ? { chatId: runtimeOptions.chatId } : {}),
        ...(runtimeOptions.refuseUnsafe === true ? { refuseUnsafe: true } : {}),
        ...(Array.isArray(runtimeOptions.allowedRoots) ? { allowedRoots: runtimeOptions.allowedRoots } : {}),
        ...(runtimeOptions.scopedBackgroundTasks ? { scopedBackgroundTasks: runtimeOptions.scopedBackgroundTasks } : {})
      }
    );

    return {
      role,
      providerType: resolution.providerType,
      model: resolution.model,
      timeoutMs: resolution.timeoutMs,
      targets: resolution.targets,
      turnModels,
      // Routed: a failing target fails over along the role's list (§6.7).
      provider: resolution.routed,
      runtimeEnvironment,
      toolExecutor,
      // Child and workflow runs never carry a caseContext, so they never see
      // the case tools.
      toolDefinitions: shapeToolDefinitions(toolRegistry.getFunctionDefinitions(), false)
    };
  };
```

(c) In `agentExecutorAdapter.execute`, replace

```js
        const settings = getSettings();
        const requestedTier = options.tier || agent?.inferenceTier || settings?.inference?.activeTier;
        const runtime = await createAgentRuntime(
          {
            tier: requestedTier,
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {})
          },
```

with

```js
        // The agent's role on the default profile (spec §12) — a
        // user-defined agent without one has its inferenceTier read as the
        // mapped role (§13 step 5) — or the provider/model a caller names.
        const role = typeof options.role === 'string' && options.role ? options.role : roleForAgent(agent);
        const runtime = await createAgentRuntime(
          {
            role,
            ...(options.profileId ? { profileId: options.profileId } : {}),
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {})
          },
```

then replace

```js
        const executor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
          usageTracker,
          prompter
        });

        return executor.execute(agent, message, {
          ...options,
          tier: runtime.tier,
          model: options.model || runtime.model || agent.model,
```

with

```js
        const executor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
          usageTracker,
          prompter,
          // The routed provider fails over itself (spec §6.7).
          failoverPolicy: NO_RETRY
        });

        return executor.execute(agent, message, {
          ...options,
          role: runtime.role,
          model: runtime.model,
```

(d) Replace the skills `get llmProvider() { … }` body with:

```js
        get llmProvider() {
          try {
            // The default profile's first usable main model, when it is one
            // of the two providers skills know how to talk to.
            const main = snapshotModels({}).resolve('main');
            const target = main.targets.find((x) => ['openai', 'anthropic'].includes(x.provider));
            if (!target) return null;
            return createProviderInstance(target.provider, getDecryptedProviderToken(target.provider));
          } catch (error) {
            skillsLog.warn(`LLM provider not available: ${error.message}`);
            return null;
          }
        }
```

(e) Replace `callModel: createCallModel({ resolveInference, getUsageTracker: () => usageTracker }),` with:

```js
      // An ingest call names its model (the case's draft, verify or vision
      // target): an explicit target, still checked (spec §6.3).
      callModel: createCallModel({
        resolveInference: ({ provider, model }) => resolveRole('main', { explicit: { provider, model } }),
        getUsageTracker: () => usageTracker
      }),
```

- [ ] **Step 4: Move the agent handlers to roles**

In `src/ipc/agent-handlers.js`:

(a) After `const IPC = require('./constants');` add:

```js
const { roleForAgent, roleForTier } = require('../models/roles');
const { NO_RETRY } = require('../providers/failover-policy');
```

(b) `AGENT_EXECUTE`: change the handler's parameters to `async (event, { agentId, message, tier, role })`, delete `const settings = getSettings();` in it, and replace its `createAgentRuntime(…)` call with:

```js
    const runtime = await createAgentRuntime(
      { role: (typeof role === 'string' && role) || roleForTier(tier) || roleForAgent(agent) },
      event
    );
```

(c) `AGENT_EXECUTE_PARALLEL` and `AGENT_EXECUTE_SERIAL`: delete `const settings = getSettings();` and replace `createAgentRuntime({ tier: settings?.inference?.activeTier }, event)` with `createAgentRuntime({ role: 'main' }, event)`.

(d) `AGENT_EXECUTE_WITH_DEPS`: delete `const settings = getSettings();` and replace `createAgentRuntime({ tier: agent.inferenceTier || settings?.inference?.activeTier }, event)` with `createAgentRuntime({ role: roleForAgent(agent) }, event)`.

(e) In all four handlers replace the run options `tier: runtime.tier,` with `role: runtime.role,` and `model: runtime.model || agent.model,` with `model: runtime.model,`.

(f) In all four `new AgentExecutor(runtime.provider, runtime.toolExecutor, { … })` option objects add `failoverPolicy: NO_RETRY,` after `usageTracker: …,`.

(g) Remove `getSettings` from the destructured `context` if nothing else in the file uses it.

- [ ] **Step 5: Update the tests that configured providers through tiers**

Apply the edits listed under Step 1 to `tests/executor-adapter-provider.test.js`, `tests/core-remote-approvals.test.js`, `tests/fleet-core-seams.test.js`, `tests/fleet-delegate.test.js` and `tests/cases-executor-core.test.js`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/models-headless.test.js tests/agent-handlers.test.js tests/executor-adapter-provider.test.js tests/core-remote-approvals.test.js tests/fleet-core-seams.test.js tests/fleet-delegate.test.js tests/desktop-bridge-dispatcher.test.js tests/cases-executor-core.test.js tests/spawn-agent-tool.test.js tests/cases-ingest-core.test.js tests/models-core-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/core/create-core.js src/ipc/agent-handlers.js src/agents/agent-schema.js src/agents/builtin/main-assistant.js src/agents/builtin/planner.js src/agents/builtin/code-writer.js src/agents/builtin/code-explorer.js src/agents/builtin/case-researcher.js tests/models-headless.test.js tests/agent-handlers.test.js tests/executor-adapter-provider.test.js tests/core-remote-approvals.test.js tests/fleet-core-seams.test.js tests/fleet-delegate.test.js tests/cases-executor-core.test.js
git commit -m "feat(core): headless and agent runs resolve their role through the default profile"
```

---
## Task 7: Case roles resolve through profiles; case.yaml `profile` and `mainOverride`

**Files:**
- Rewrite: `src/cases/roles.js`
- Modify: `src/cases/case-runtime.js` — requires (`:24`); `beginTurn` (`:994`, the turn object at `:1026-1043`); replace `roleModel` and `routedProvider` (`:1654-1729`) and add `modelsFor`, `visionTarget`, `setModelChoice`
- Modify: `src/cases/case-store.js:39-55` (`CASE_YAML_KEYS`), `src/cases/defaults.js:10-16` (default roles), `src/cases/detours/classifier.js:116`, `:156` (router check, model label), `src/cases/ingest/index.js:654-660` (`_ocrModel`), `src/cases/ingest/settings.js` (drop `vision`), `src/cases/ingest/vision.js:14`, `:40-41` (message, comment)
- Modify: `src/ipc/chat-handlers.js:322` (pass `chatId` to `beginTurn`)
- Modify: `tests/helpers/profile-settings.js` (add `caseRoles`, `withCaseProfile`), `tests/helpers/ingest-harness.js:64-70` (a `vision` option)
- Test: `tests/cases-roles.test.js` (rewritten), `tests/cases-store-yaml.test.js:20-50` (two samples), `tests/cases-core.test.js:47`, `tests/cases-detour-classifier.test.js:38-51`, `:97`, `tests/cases-detour-hooks.test.js:24-33`, `tests/cases-turn-runner.test.js:33-56`, `tests/cases-regressions.test.js:174-177`, `:331-334`, `tests/cases-service-wakeups.test.js:211-219`, `:262-265`, `tests/cases-ingest-vision.test.js:463`, `tests/ingest-deps.test.js:84-133`

**Interfaces:**
- Consumes: `TurnModels#mustResolve/resolve` (Task 2), `snapshotFromSettings` (Task 2), `roleForTier` (Task 1), `NO_RETRY` (Task 4), `router.routeTargets(targets, messages, options, state)` and `router.newRouteState()` (Task 4); the core's `snapshotModels({ caseId, chatId })` reaches the runtime as `host.snapshotModels` (added to the host in Step 5).
- Produces:
  - `src/cases/roles.js`: `ROLES`, `DEFAULT_ROLES` (`{ orient: { role: 'utility' }, classify: { role: 'utility' }, draft: { role: 'worker' }, judge: { role: 'main' }, verify: { role: 'main' } }`), `CASE_ROLE_TO_MODEL_ROLE`, `CASE_ROLE_NEEDS` (`orient`, `judge` need `toolCall`), `NO_RETRY`, `providerFamily(provider, model)` (unchanged), `caseRoleSpec(role, { settings, caseMeta }) → { modelRole, explicit: Target|null }` (entry `role` wins, else `tier` mapped, else the default; `provider`+`model` is explicit), `resolveCaseRole(role, { settings, caseMeta, turnModels, needs }) → { caseRole, modelRole, provider, model, effort, targets, skipped, borrowedFrom }` (throws `NoUsableModelError`/`UnknownRoleError`; verify prefers another family than judge's target, else judge's with a warning; an explicit verify is honoured with a warning). `resolveRole`, `tierTarget` and `TIERS` are gone.
  - `CaseRuntime#modelsFor(id, { chatId = null }) → TurnModels` (the host's `snapshotModels` when present, else one from settings with `case.yaml`'s `profile` and `mainOverride`; with no host `explain` a target is usable when `host.hasProviderToken` allows, or always when there is no such host function).
  - `CaseRuntime#beginTurn(id, { turnId, source, ownerMessage, chatId })` sets `turn.models` (a `TurnModels`, or `null` if building it failed, logged).
  - `CaseRuntime#roleModel(id, role, { turn = null, needs = {} })` → `resolveCaseRole`'s result, using `turn.models` when given.
  - `CaseRuntime#routedProvider(turn, { role } | { targets } | { target })` → a provider object (`getProviderName`, `getDefaultModel`, `current`, `sendMessage`, `streamMessage`, `sendMessageWithTools`, `streamMessageWithTools`) whose calls go through `host.inferenceRouter.routeTargets` with one route state per object; throws `Routed providers need a host with an inference router.` without one.
  - `CaseRuntime#visionTarget(id) → { provider, model } | null` (the resolved vision role's first target).
  - `CaseRuntime#setModelChoice(id, { profile?, mainOverride? }) → Promise<caseMeta>` — writes only those keys to `case.yaml` under the case lock and commits (`system: model choice`).
  - `CASE_YAML_KEYS.profile === 'M2'`, `CASE_YAML_KEYS.mainOverride === 'M2'`.
  - `tests/helpers/profile-settings.js`: `caseRoles(provider = 'openai') → { main: [judge-model], worker: [draft-model], utility: [orient-model] }` and `withCaseProfile(settings = {}, provider = 'openai')`.

- [ ] **Step 1: Add the test helpers**

Append to `tests/helpers/profile-settings.js`, before `module.exports`:

```js
// The three core roles with the model names case tests tell apart: the
// judge loop runs on main, draft on worker, orient and classify on utility.
function caseRoles(provider = 'openai') {
  const t = (model) => ({ provider, model, effort: null });
  return { main: [t('judge-model')], worker: [t('draft-model')], utility: [t('orient-model')] };
}

function withCaseProfile(settings = {}, provider = 'openai') {
  return profileSettings(settings, caseRoles(provider));
}
```

and change the export to `module.exports = { profileSettings, everyRole, caseRoles, withCaseProfile };`.

In `tests/helpers/ingest-harness.js`, add `vision = null` to the `ingestHarness({ … })` parameter list and, right after `runtime.roleModel = (_id, role) => ({ ...pinned[role], tier: 'standard' });`, add:

```js
  // The profile's vision role (models spec 2026-09-27 §8), pinned per test.
  runtime.visionTarget = () => (vision ? { ...vision } : null);
```

- [ ] **Step 2: Write the failing tests**

Replace `tests/cases-roles.test.js` with:

```js
// tests/cases-roles.test.js
// Case roles on model roles (spec 2026-09-27 §6.4, §8, §13 step 4): orient
// and classify on utility, draft on worker, judge and verify on main, verify
// on another provider family; tier names read as the mapped role.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addSink } = require('../src/logging');
const { resolveCaseRole, caseRoleSpec, providerFamily, NO_RETRY, ROLES, DEFAULT_ROLES, CASE_ROLE_TO_MODEL_ROLE } = require('../src/cases/roles');
const { createTurnModels } = require('../src/models/resolver');
const { CaseRuntime } = require('../src/cases');
const { profileSettings } = require('./helpers/profile-settings');

const t = (provider, model) => ({ provider, model, effort: null });
const usable = () => ({ usable: true, reasons: [], notes: [] });
const models = (roles, { explain = usable, mainOverride = null } = {}) => createTurnModels({
  profile: { id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...roles } },
  mainOverride,
  explain
});
const work = () => models({
  main: [t('anthropic', 'claude-sonnet-4-5'), t('openai', 'gpt-5.5')],
  worker: [t('openai', 'gpt-5.4')],
  utility: [t('groq', 'llama-3.3-70b')]
});

function captureWarnings(fn) {
  const lines = [];
  const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
  try { return { value: fn(), lines }; } finally { remove(); }
}

describe('case roles', () => {
  it('map onto model roles', () => {
    assert.deepStrictEqual([...ROLES], ['orient', 'classify', 'draft', 'judge', 'verify']);
    assert.deepStrictEqual({ ...CASE_ROLE_TO_MODEL_ROLE }, { orient: 'utility', classify: 'utility', draft: 'worker', judge: 'main', verify: 'main' });
    assert.deepStrictEqual(DEFAULT_ROLES.judge, { role: 'main' });
    const m = work();
    assert.strictEqual(resolveCaseRole('orient', { turnModels: m }).provider, 'groq');
    assert.strictEqual(resolveCaseRole('classify', { turnModels: m }).model, 'llama-3.3-70b');
    assert.strictEqual(resolveCaseRole('draft', { turnModels: m }).model, 'gpt-5.4');
    const judge = resolveCaseRole('judge', { turnModels: m });
    assert.deepStrictEqual([judge.caseRole, judge.modelRole, judge.provider, judge.model, judge.targets.length], ['judge', 'main', 'anthropic', 'claude-sonnet-4-5', 2]);
  });

  it('read tier names as the mapped role, with case.yaml over settings over the default', () => {
    assert.deepStrictEqual(caseRoleSpec('judge', { settings: { cases: { roles: { judge: { tier: 'standard' } } } } }), { modelRole: 'worker', explicit: null });
    assert.deepStrictEqual(
      caseRoleSpec('orient', { caseMeta: { roles: { orient: { tier: 'smart' } } }, settings: { cases: { roles: { orient: { tier: 'standard' } } } } }),
      { modelRole: 'main', explicit: null }
    );
    assert.deepStrictEqual(caseRoleSpec('draft', { caseMeta: { roles: { draft: { role: 'utility' } } } }), { modelRole: 'utility', explicit: null });
    const explicit = resolveCaseRole('judge', { turnModels: work(), caseMeta: { roles: { judge: { provider: 'OpenRouter', model: 'mistralai/mistral-large' } } } });
    assert.deepStrictEqual([explicit.provider, explicit.model, explicit.targets.length], ['openrouter', 'mistralai/mistral-large', 1]);
    const { value, lines } = captureWarnings(() => caseRoleSpec('draft', { caseMeta: { roles: { draft: { provider: 'openai', tier: 'fast' } } } }));
    assert.deepStrictEqual(value, { modelRole: 'utility', explicit: null });
    assert.ok(lines.some((l) => /names the provider openai with no model/.test(l)), lines.join('\n'));
    assert.throws(() => caseRoleSpec('boss', {}), /Unknown case role "boss"/);
  });

  it('ask for tool calling on orient and judge only', () => {
    const seen = [];
    const m = models({ main: [t('openai', 'gpt-5.5')], utility: [t('groq', 'x')] }, { explain: (_p, model, { needs }) => { seen.push([model, needs]); return usable(); } });
    resolveCaseRole('orient', { turnModels: m });
    resolveCaseRole('judge', { turnModels: m });
    resolveCaseRole('draft', { turnModels: m });
    assert.deepStrictEqual(seen, [['x', { toolCall: true }], ['gpt-5.5', { toolCall: true }], ['gpt-5.5', {}]]);
  });

  it('treat an openrouter model prefix as its provider family', () => {
    assert.strictEqual(providerFamily('openrouter', 'anthropic/claude-3.5-sonnet'), 'anthropic');
    assert.strictEqual(providerFamily('OpenAI', 'gpt-4o'), 'openai');
    assert.strictEqual(providerFamily('openrouter', 'auto'), 'openrouter');
  });

  it('verify takes the first main model of another provider family than judge', () => {
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: work() }));
    assert.deepStrictEqual([value.caseRole, value.provider, value.model, value.targets.length], ['verify', 'openai', 'gpt-5.5', 1]);
    assert.deepStrictEqual(lines, []);
  });

  it('verify falls back to the judge with a warning when main has one family only', () => {
    const m = models({ main: [t('anthropic', 'claude-sonnet-4-5'), t('anthropic', 'claude-opus-4-1')] });
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: m }));
    assert.deepStrictEqual([value.caseRole, value.provider, value.model], ['verify', 'anthropic', 'claude-sonnet-4-5']);
    assert.ok(lines.some((l) => l.includes("verify falls back to the judge's provider family (anthropic)")), lines.join('\n'));
  });

  it('honours an explicit case.yaml verify with a warning when it matches the judge family', () => {
    const caseMeta = { roles: { verify: { provider: 'anthropic', model: 'claude-haiku-4-5' } } };
    const { value, lines } = captureWarnings(() => resolveCaseRole('verify', { turnModels: work(), caseMeta }));
    assert.deepStrictEqual([value.provider, value.model], ['anthropic', 'claude-haiku-4-5']);
    assert.ok(lines.some((l) => /same provider family as judge/.test(l)), lines.join('\n'));
  });

  it('an unusable case main override fails the resolve with the reason', () => {
    const explain = (p) => (p === 'groq' ? { usable: false, reasons: ['No token saved for Groq.'], notes: [] } : usable());
    const m = models({ main: [t('openai', 'gpt-5.5')] }, { explain, mainOverride: t('groq', 'llama-3.3-70b') });
    assert.throws(() => resolveCaseRole('judge', { turnModels: m }), (err) => err.code === 'MAIN_OVERRIDE_UNUSABLE' && /No token saved for Groq/.test(err.message));
  });

  it('NO_RETRY aborts every failure without waiting', () => {
    assert.deepStrictEqual(NO_RETRY.plan(new Error('503')), { action: 'abort', reason: 'routed', waitMs: 0 });
  });
});

describe('CaseRuntime model roles', () => {
  const roots = [];
  after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
  const root = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-roles-')); roots.push(d); return d; };
  const settings = () => profileSettings({}, {
    main: [t('anthropic', 'claude-sonnet-4-5'), t('openai', 'gpt-5.5')],
    worker: [t('openai', 'gpt-5.4')],
    utility: [t('groq', 'llama-3.3-70b')],
    vision: [t('openai', 'gpt-5.5')]
  });

  it('roleModel resolves through the profile, case.yaml roles winning', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => ({ ...settings(), cases: { roles: { judge: { tier: 'standard' } } } }) });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const judge = rt.roleModel(info.id, 'judge');
    assert.deepStrictEqual([judge.provider, judge.model], ['openai', 'gpt-5.4']);
    rt.store.updateMeta(info.id, { roles: { judge: { provider: 'gemini', model: 'gemini-2.5-pro' } } });
    assert.strictEqual(rt.roleModel(info.id, 'judge').model, 'gemini-2.5-pro');
    assert.deepStrictEqual(rt.visionTarget(info.id), { provider: 'openai', model: 'gpt-5.5' });
  });

  it('follows case.yaml\'s profile and main override, and the host\'s snapshot when it has one', async () => {
    const other = { id: 'p-other', name: 'Other', kind: 'user', roles: { main: [t('xai', 'grok-4.3')], worker: [], utility: [] } };
    const s = settings();
    s.models.profiles.push(other);
    const rt = new CaseRuntime({ root: root(), getSettings: () => s });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    rt.store.updateMeta(info.id, { profile: 'p-other' });
    assert.strictEqual(rt.roleModel(info.id, 'judge').provider, 'xai');
    rt.store.updateMeta(info.id, { mainOverride: t('openai', 'gpt-5.4') });
    assert.strictEqual(rt.roleModel(info.id, 'judge').model, 'gpt-5.4');
    const asked = [];
    const hosted = new CaseRuntime({
      root: root(),
      getSettings: () => s,
      host: { snapshotModels: (req) => { asked.push(req); return createTurnModels({ profile: other, explain: usable }); } }
    });
    const b = await hosted.createCase({ title: 'Other lot' });
    assert.strictEqual(hosted.roleModel(b.id, 'draft').model, 'grok-4.3');
    assert.deepStrictEqual(asked, [{ caseId: b.id, chatId: null }]);
  });

  it('beginTurn freezes the models: a later case.yaml change applies to the next turn', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const turn = await rt.beginTurn(info.id, { turnId: 't1', source: 'owner', ownerMessage: 'x', chatId: 'chat-1' });
    try {
      rt.store.updateMeta(info.id, { mainOverride: t('xai', 'grok-4.3') });
      assert.strictEqual(rt.roleModel(info.id, 'judge', { turn }).provider, 'anthropic');
      assert.strictEqual(rt.roleModel(info.id, 'judge').provider, 'xai');
    } finally {
      await rt.endTurn(turn, { summary: 'done' });
    }
  });

  it('routedProvider sends every call through routeTargets with the role\'s list and the turn signal', async () => {
    const calls = [];
    const router = { routeTargets: async (targets, messages, opts) => { calls.push({ targets, opts }); return { type: 'text', content: 'ok' }; } };
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings(), host: { inferenceRouter: router } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const controller = new AbortController();
    const turn = { caseId: info.id, turnId: 't1', signal: controller.signal };
    const orient = rt.routedProvider(turn, { role: 'orient' });
    assert.deepStrictEqual([orient.getProviderName(), orient.getDefaultModel()], ['groq', 'llama-3.3-70b']);
    await orient.sendMessage([{ role: 'user', content: 'x' }], { systemPrompt: 'S' });
    await orient.streamMessageWithTools([], [{ name: 'Read' }], {}, () => {});
    assert.deepStrictEqual(calls[0].targets, [t('groq', 'llama-3.3-70b')]);
    assert.strictEqual(calls[0].opts.systemPrompt, 'S');
    assert.strictEqual(calls[0].opts.abortSignal, controller.signal);
    assert.deepStrictEqual(calls[1].opts.tools, [{ name: 'Read' }]);
    assert.strictEqual(typeof calls[1].opts.onChunk, 'function');
    await rt.routedProvider(turn, { role: 'judge' }).sendMessageWithTools([], [{ name: 'Ledger' }], {});
    assert.deepStrictEqual(calls.at(-1).targets, [t('anthropic', 'claude-sonnet-4-5'), t('openai', 'gpt-5.5')]);
    await rt.routedProvider(turn, { targets: [t('openai', 'gpt-5.4')] }).sendMessageWithTools([], [{ name: 'Ledger' }], {});
    assert.deepStrictEqual(calls.at(-1).targets, [t('openai', 'gpt-5.4')]);
    await rt.routedProvider(turn, { target: { provider: 'OpenAI', model: 'gpt-4o' } }).sendMessage([], {});
    assert.deepStrictEqual(calls.at(-1).targets, [t('openai', 'gpt-4o')]);
    assert.throws(() => new CaseRuntime({ root: root() }).routedProvider(turn, { role: 'judge' }), /inference router/);
  });

  it('setModelChoice writes profile and mainOverride to case.yaml and nothing else', async () => {
    const rt = new CaseRuntime({ root: root(), getSettings: () => settings() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const updated = await rt.setModelChoice(info.id, { mainOverride: t('openai', 'gpt-5.5') });
    assert.deepStrictEqual(updated.mainOverride, t('openai', 'gpt-5.5'));
    await rt.setModelChoice(info.id, { profile: 'p-test', mainOverride: null });
    assert.deepStrictEqual([rt.getCase(info.id).profile, rt.getCase(info.id).mainOverride], ['p-test', null]);
    await assert.rejects(rt.setModelChoice(info.id, { status: 'done' }), /needs profile or mainOverride/);
  });
});
```

In `tests/cases-store-yaml.test.js`, add to `SAMPLES` (after `channels: …`):

```js
  profile: 'p-3f9a1c2e',
  mainOverride: { provider: 'openai', model: 'gpt-5.5', effort: null },
```

and after `assert.strictEqual(CASE_YAML_KEYS.budget, 'C2');` add `assert.strictEqual(CASE_YAML_KEYS.mainOverride, 'M2');`.

In `tests/cases-core.test.js:47` replace `assert.deepStrictEqual(merged.roles.judge, { tier: 'smart' });` with `assert.deepStrictEqual(merged.roles.judge, { role: 'main' });`.

In `tests/cases-detour-classifier.test.js`: add `const { withCaseProfile } = require('./helpers/profile-settings');`; in `host()` replace the router stub with

```js
    inferenceRouter: {
      async routeTargets(targets, messages, opts) {
        calls.push({ targets, messages, opts });
        return reply(messages, opts, calls.length);
      }
    },
```

in `activeCase` replace `getSettings: () => ({ cases: settings })` with `getSettings: () => withCaseProfile({ cases: settings })`; and at `:97` replace `assert.strictEqual(call.tier, 'fast');` with `assert.deepStrictEqual(call.targets, [{ provider: 'openai', model: 'orient-model', effort: null }]);`.

In `tests/cases-detour-hooks.test.js`: add the same require; in `makeRuntime` replace `getSettings: () => ({ cases }),` with `getSettings: () => withCaseProfile({ cases }),` and the router stub with `inferenceRouter: { async routeTargets(targets, messages, opts) { calls.push({ targets, messages, opts }); return reply(messages, opts); } },`.

In `tests/cases-turn-runner.test.js`: add `const { withCaseProfile } = require('./helpers/profile-settings');`; replace the router's `async routeWithFallback(tier, messages, opts) {` and its comment and `if (tier === 'smart') {` with:

```js
    async routeTargets(targets, messages, opts) {
      // Orient (utility) and judge (main) both call sendMessageWithTools
      // with a non-empty tools array, so the resolved model — not tools'
      // presence — tells them apart, as it does for real through
      // CaseRuntime.routedProvider/roleModel.
      if (targets[0].model === 'judge-model') {
```

and replace `getSettings: () => ({ cases: { timeZone: 'UTC', ...settings } }),` with `getSettings: () => withCaseProfile({ cases: { timeZone: 'UTC', ...settings } }),`; delete the `resolveInference: async () => null,` host line.

In `tests/cases-regressions.test.js`: add `const { withCaseProfile } = require('./helpers/profile-settings');`; at `:176` replace `routeWithFallback: async () => { routed += 1; return '{"changed": true}'; }` with `routeTargets: async () => { routed += 1; return '{"changed": true}'; }`; at `:331-334` replace

```js
    const runtime = new CaseRuntime({
      root: tmp(),
      host: { inferenceRouter: { routeWithFallback: async () => MOCK }, interactive: () => true }
    });
```

with

```js
    const runtime = new CaseRuntime({
      root: tmp(),
      getSettings: () => withCaseProfile({}),
      host: { inferenceRouter: { routeTargets: async () => MOCK }, interactive: () => true }
    });
```

In `tests/cases-service-wakeups.test.js`: add `const { profileSettings } = require('./helpers/profile-settings');`; replace both `deps.store.set('settings', { inference: { tierMap: { fast: { provider: 'stub', model: 'stub-orient' }, smart: { provider: 'stub', model: 'stub-judge' } } } });` (the first spans `:212-219`) with:

```js
      deps.store.set('settings', profileSettings({}, {
        utility: [{ provider: 'stub', model: 'stub-orient', effort: null }],
        main: [{ provider: 'stub', model: 'stub-judge', effort: null }]
      }));
```

In `tests/cases-ingest-vision.test.js:463` replace `ingest: { vision: { provider: 'openai', model: 'gpt-4o' } },` with `vision: { provider: 'openai', model: 'gpt-4o' },`.

In `tests/ingest-deps.test.js` (a stored `cases.ingest.vision` is now dropped):

- in `'carries the defaults and merges key by key'` replace the expected array `[50, 52428800, { provider: 'gemini', model: '' }, true]` with `[50, 52428800, undefined, true]`;
- in `'repairs invalid values to the defaults'` keep the `resolveIngestSettings({ … vision: { provider: ' OpenAI ', model: ' m ' } })` call and replace `assert.deepStrictEqual(r.vision, { provider: 'openai', model: 'm' });` with `assert.strictEqual(r.vision, undefined, 'the OCR model is the profile\'s vision role now (models spec §13)');`;
- in `'treats a "__proto__" key in settings as inert (null-prototype merge)'` replace the two lines `assert.strictEqual(resolved.vision.provider, 'openai');` and `assert.deepStrictEqual(Object.keys(resolved.vision).includes('__proto__'), false);` with `assert.strictEqual(resolved.vision, undefined);`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/cases-roles.test.js tests/cases-store-yaml.test.js tests/cases-core.test.js tests/ingest-deps.test.js`
Expected: FAIL — `resolveCaseRole is not a function`, `CASE_YAML_KEYS.mainOverride` undefined, `merged.roles.judge` still a tier, `r.vision` still set.

- [ ] **Step 4: Rewrite `src/cases/roles.js`**

```js
// src/cases/roles.js
// Case model roles (cases stage 2 spec §3.8; model roles spec 2026-09-27
// §6, §8). A case role maps onto a model role — orient and classify onto
// utility, draft onto worker, judge and verify onto main — or names an
// explicit provider and model. Tier names from before stage M2 read as the
// mapped role (§13 step 4); case.yaml is not rewritten for that.
const { createLogger } = require('../logging');
const { NO_RETRY } = require('../providers/failover-policy');
const { roleForTier } = require('../models/roles');

const log = createLogger('cases/roles');

const ROLES = Object.freeze(['orient', 'classify', 'draft', 'judge', 'verify']);
const CASE_ROLE_TO_MODEL_ROLE = Object.freeze({ orient: 'utility', classify: 'utility', draft: 'worker', judge: 'main', verify: 'main' });
const DEFAULT_ROLES = Object.freeze({
  orient: Object.freeze({ role: 'utility' }),
  classify: Object.freeze({ role: 'utility' }),
  draft: Object.freeze({ role: 'worker' }),
  judge: Object.freeze({ role: 'main' }),
  verify: Object.freeze({ role: 'main' })
});
// Orient and the judge loop offer tools; their models must call them.
const CASE_ROLE_NEEDS = Object.freeze({ orient: Object.freeze({ toolCall: true }), judge: Object.freeze({ toolCall: true }) });

const lower = (s) => String(s || '').trim().toLowerCase();

function providerFamily(provider, model) {
  const p = lower(provider);
  if (p === 'openrouter') {
    const m = String(model || '');
    const slash = m.indexOf('/');
    return slash > 0 ? lower(m.slice(0, slash)) : 'openrouter';
  }
  return p;
}

// Which model role a case role uses, and any explicit target. case.yaml
// roles win over settings.cases.roles, which win over the defaults.
function caseRoleSpec(role, { settings = {}, caseMeta = null } = {}) {
  if (!ROLES.includes(role)) throw new Error(`Unknown case role "${role}". Roles: ${ROLES.join(', ')}.`);
  const entry = caseMeta?.roles?.[role] || settings?.cases?.roles?.[role] || DEFAULT_ROLES[role];
  const fallback = CASE_ROLE_TO_MODEL_ROLE[role];
  if (!entry || typeof entry !== 'object') return { modelRole: fallback, explicit: null };
  const named = typeof entry.role === 'string' && entry.role.trim() ? entry.role.trim() : null;
  const modelRole = named || roleForTier(entry.tier) || fallback;
  if (entry.provider && typeof entry.model === 'string' && entry.model.trim()) {
    return { modelRole, explicit: { provider: lower(entry.provider), model: entry.model.trim(), effort: null } };
  }
  if (entry.provider) log.warn(`Case role ${role} names the provider ${entry.provider} with no model; using the ${modelRole} role instead.`);
  return { modelRole, explicit: null };
}

function pick(caseRole, modelRole, resolved) {
  const [first] = resolved.targets;
  return {
    caseRole,
    modelRole,
    provider: first.provider,
    model: first.model,
    effort: first.effort || null,
    targets: resolved.targets.map((x) => ({ ...x })),
    skipped: resolved.skipped,
    borrowedFrom: resolved.borrowedFrom || null
  };
}

function resolveCaseRole(role, { settings = {}, caseMeta = null, turnModels, needs = {} } = {}) {
  if (!turnModels) throw new Error('Resolving a case role needs the turn\'s models.');
  const spec = caseRoleSpec(role, { settings, caseMeta });
  const need = { ...(CASE_ROLE_NEEDS[role] || {}), ...needs };
  if (role !== 'verify') {
    return pick(role, spec.modelRole, turnModels.mustResolve(spec.modelRole, { needs: need, explicit: spec.explicit }));
  }
  // verify: the first usable main model of a different provider family than
  // judge's (spec §6.4), else judge's with a warning, as before.
  const judge = resolveCaseRole('judge', { settings, caseMeta, turnModels });
  const judgeFamily = providerFamily(judge.provider, judge.model);
  if (spec.explicit) {
    const r = pick(role, spec.modelRole, turnModels.mustResolve(spec.modelRole, { needs: need, explicit: spec.explicit }));
    if (providerFamily(r.provider, r.model) === judgeFamily) {
      log.warn(`case.yaml roles.verify uses the same provider family as judge (${judgeFamily}); honouring it as written.`);
    }
    return r;
  }
  const resolved = turnModels.mustResolve(spec.modelRole, { needs: need });
  const other = resolved.targets.filter((x) => providerFamily(x.provider, x.model) !== judgeFamily);
  if (other.length) return pick(role, spec.modelRole, { ...resolved, targets: other });
  log.warn(`verify falls back to the judge's provider family (${judgeFamily})`);
  return { ...judge, caseRole: 'verify' };
}

module.exports = { ROLES, DEFAULT_ROLES, CASE_ROLE_TO_MODEL_ROLE, CASE_ROLE_NEEDS, NO_RETRY, providerFamily, caseRoleSpec, resolveCaseRole };
```

- [ ] **Step 5: Re-point the case runtime**

In `src/cases/case-runtime.js`:

(a) Replace `const { resolveRole } = require('./roles');` with:

```js
const { resolveCaseRole } = require('./roles');
const { snapshotFromSettings } = require('../models/profiles');
```

(b) Change `async beginTurn(id, { turnId, source = 'owner', ownerMessage = null } = {}) {` to `async beginTurn(id, { turnId, source = 'owner', ownerMessage = null, chatId = null } = {}) {`, and directly after `turn.orientation = this.orientation(fresh.id, { triggers, hookNotes: hook.notes });` add:

```js
        // The models this turn uses, frozen at launch (models spec
        // 2026-09-27 §6.6): a switch during the turn applies to the next one.
        turn.models = this._turnModels(fresh.id, chatId);
```

(c) Replace everything from `// ---- Model roles (spec §3.8) ----` through the end of `routedProvider(turn, spec = {}) { … }` with:

```js
  // ---- Model roles (spec §3.8; models spec 2026-09-27 §6, §8) ----

  _settingsSafe() {
    try {
      return this.getSettings() || {};
    } catch (err) {
      log.warn(`Reading settings for the model roles failed: ${err.message}`);
      return {};
    }
  }

  // The models for a case (models spec §6.3): the host's snapshot when it
  // has one (the core: case.yaml's profile and main override, else the
  // chat's, else the default), else one built from settings here, usable
  // when the host says the provider has a token.
  modelsFor(id, { chatId = null } = {}) {
    if (typeof this.host?.snapshotModels === 'function') return this.host.snapshotModels({ caseId: id, chatId });
    const meta = this.getCase(id);
    const hasToken = this.host?.hasProviderToken;
    const explain = (provider) => {
      if (typeof hasToken !== 'function') return { usable: true, reasons: [], notes: [] };
      let ok = false;
      try {
        ok = Boolean(hasToken(provider));
      } catch {
        ok = false;
      }
      return ok ? { usable: true, reasons: [], notes: [] } : { usable: false, reasons: [`No token saved for ${provider}.`], notes: [] };
    };
    return snapshotFromSettings(this._settingsSafe(), { profileId: meta.profile || null, mainOverride: meta.mainOverride || null, explain });
  }

  _turnModels(id, chatId) {
    try {
      return this.modelsFor(id, { chatId });
    } catch (err) {
      log.warn(`Building the models for a turn of case ${id} failed: ${err.message}`);
      return null;
    }
  }

  roleModel(id, role, { turn = null, needs = {} } = {}) {
    const meta = this.getCase(id);
    const turnModels = (turn && turn.models) || this.modelsFor(id);
    return resolveCaseRole(role, { settings: { ...this._settingsSafe(), cases: this.settings() }, caseMeta: meta, turnModels, needs });
  }

  // The profile's vision role for case ingest OCR (models spec §8), or null.
  visionTarget(id) {
    try {
      const [first] = this.modelsFor(id).resolve('vision').targets;
      return first ? { provider: first.provider, model: first.model } : null;
    } catch (err) {
      log.warn(`Resolving the vision role for case ${id} failed: ${err.message}`);
      return null;
    }
  }

  // The header's profile picker and main switcher write here (models spec
  // §6.5): only these two keys, under the case lock, committed.
  async setModelChoice(id, patch = {}) {
    const choice = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'profile')) choice.profile = patch.profile || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'mainOverride')) choice.mainOverride = patch.mainOverride || null;
    if (!Object.keys(choice).length) throw new Error('setModelChoice needs profile or mainOverride.');
    return this.systemAction(id, 'model choice', async (meta) => {
      this.store.updateMeta(meta.id, choice);
      return this.getCase(meta.id);
    });
  }

  // A provider-shaped object whose every call goes through the router's
  // routeTargets over a resolved list (a case role's, or the owner turn's
  // main targets), so case calls fail over like any other (models spec
  // §6.7). One route state per object. Charging happens in the caller's
  // onUsageRecorded hook (usageHook(turn)).
  routedProvider(turn, spec = {}) {
    const router = this.host?.inferenceRouter;
    if (!router || typeof router.routeTargets !== 'function') {
      throw new Error('Routed providers need a host with an inference router.');
    }
    let targets;
    if (Array.isArray(spec.targets) && spec.targets.length) targets = spec.targets;
    else if (spec.target && spec.target.provider) targets = [spec.target];
    else if (spec.role) targets = this.roleModel(turn.caseId, spec.role, { turn }).targets;
    else throw new Error('A routed provider needs a role or targets.');
    const list = targets.map((x) => ({ provider: String(x.provider).toLowerCase(), model: String(x.model || ''), effort: x.effort || null }));
    const state = typeof router.newRouteState === 'function' ? router.newRouteState() : undefined;
    const call = (messages, opts = {}, tools = null, onChunk = null) => router.routeTargets(list, messages, {
      ...(opts || {}),
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(typeof onChunk === 'function' ? { onChunk } : {}),
      ...(!opts?.abortSignal && turn.signal ? { abortSignal: turn.signal } : {})
    }, state);
    const current = () => ({ ...list[Math.min(state?.index || 0, list.length - 1)] });
    return {
      getProviderName: () => current().provider,
      getDefaultModel: () => current().model,
      current,
      sendMessage: (messages, opts) => call(messages, opts),
      streamMessage: (messages, opts, onChunk) => call(messages, opts, null, onChunk),
      sendMessageWithTools: (messages, tools, opts) => call(messages, opts, tools),
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
  }
```

(d) In the host comment near `:171` (`// Host services, all optional (spec §3.10): inferenceRouter,`), replace `resolveInference,` with `snapshotModels,`.

- [ ] **Step 6: The case.yaml keys, the defaults, the classifier label, ingest vision**

In `src/cases/case-store.js`, add to `CASE_YAML_KEYS` after `channels: 'C4'`:

```js
  channels: 'C4',
  // Models M2 (spec 2026-09-27 §6.5, §14): the case's profile and main override.
  profile: 'M2',
  mainOverride: 'M2'
```

(replacing the existing `channels: 'C4'` line).

In `src/cases/defaults.js` replace the `roles: Object.freeze({ … })` block with:

```js
  // Case roles on model roles (models spec 2026-09-27 §8); tier names in a
  // stored setting still read as the mapped role (src/cases/roles.js).
  roles: Object.freeze({
    orient: Object.freeze({ role: 'utility' }),
    classify: Object.freeze({ role: 'utility' }),
    draft: Object.freeze({ role: 'worker' }),
    judge: Object.freeze({ role: 'main' }),
    verify: Object.freeze({ role: 'main' })
  }),
```

In `src/cases/detours/classifier.js`: at `:116` replace `if (typeof this.runtime.host?.inferenceRouter?.routeWithFallback !== 'function') return this._skip('no-router');` with `if (typeof this.runtime.host?.inferenceRouter?.routeTargets !== 'function') return this._skip('no-router');`, and at `:156` replace ``const model = `${resolved.provider}/${resolved.model || resolved.tier}`;`` with ``const model = `${resolved.provider}/${resolved.model}`;``.

In `src/cases/ingest/index.js`, in `_ocrModel(caseId, cfg)`, replace `configured: cfg.vision,` with `configured: this.runtime.visionTarget(caseId),`.

In `src/cases/ingest/settings.js`: delete `vision: Object.freeze({ provider: '', model: '' }),` from `INGEST_DEFAULTS`; delete `vision: { provider: text(m.vision.provider).toLowerCase(), model: text(m.vision.model) },` from `resolveIngestSettings`; replace `mergeIngestSettings` with:

```js
function mergeIngestSettings(base = {}, source = {}) {
  const d = JSON.parse(JSON.stringify(INGEST_DEFAULTS));
  const b = obj(base);
  const s = obj(source);
  // cases.ingest.vision moved to the profile's vision role (models spec
  // 2026-09-27 §13 step 6): a stored copy is dropped, never read.
  const { vision: _baseVision, ...baseRest } = b;
  const { vision: _sourceVision, ...sourceRest } = s;
  return {
    ...d,
    ...baseRest,
    ...sourceRest,
    entities: { ...d.entities, ...obj(b.entities), ...obj(s.entities) }
  };
}
```

and remove the now-unused `const text = …` helper if nothing else in the file uses it.

In `src/cases/ingest/vision.js` replace the `NO_VISION_MESSAGE` value with `'No vision-capable model is configured. Add a vision model to the profile in Settings → Models, or an image-capable model to its worker or main role.'` and the comment above `pickOcrModel` with `// The profile's vision role when eligible, else the first eligible of the draft and judge roles, else NO_VISION_MODEL.`

- [ ] **Step 7: Pass the chat to the case turn, and give the runtime the core's snapshot**

In `src/ipc/chat-handlers.js`, in the `caseRuntime.beginTurn(caseId, { … })` call, add `chatId` to the options object (`{ turnId: \`turn-${runId}\`, source: 'owner', ownerMessage: safeMessage, chatId }`).

In `src/core/create-core.js`, in the `new CaseRuntime({ … host: { … } })` block, replace `resolveInference,` with `snapshotModels,` (the case runtime no longer refreshes OAuth tokens itself: the router's `prepareProvider` does).

- [ ] **Step 8: Update the case tests**

Apply the edits listed in Step 2 to `tests/cases-store-yaml.test.js`, `tests/cases-core.test.js`, `tests/cases-detour-classifier.test.js`, `tests/cases-detour-hooks.test.js`, `tests/cases-turn-runner.test.js`, `tests/cases-regressions.test.js`, `tests/cases-service-wakeups.test.js`, `tests/cases-ingest-vision.test.js`, `tests/ingest-deps.test.js`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/cases-roles.test.js tests/cases-store-yaml.test.js tests/cases-core.test.js tests/cases-detour-classifier.test.js tests/cases-detour-hooks.test.js tests/cases-turn-runner.test.js tests/cases-regressions.test.js tests/cases-service-wakeups.test.js tests/cases-ingest-vision.test.js tests/cases-ingest-core.test.js tests/cases-ingest-service.test.js tests/ingest-deps.test.js tests/cases-chat.test.js tests/cases-stop.test.js tests/models-core-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add src/cases/roles.js src/cases/case-runtime.js src/cases/case-store.js src/cases/defaults.js src/cases/detours/classifier.js src/cases/ingest/index.js src/cases/ingest/settings.js src/cases/ingest/vision.js src/ipc/chat-handlers.js src/core/create-core.js tests/helpers/profile-settings.js tests/helpers/ingest-harness.js tests/cases-roles.test.js tests/cases-store-yaml.test.js tests/cases-core.test.js tests/cases-detour-classifier.test.js tests/cases-detour-hooks.test.js tests/cases-turn-runner.test.js tests/cases-regressions.test.js tests/cases-service-wakeups.test.js tests/cases-ingest-vision.test.js tests/ingest-deps.test.js
git commit -m "feat(cases): case roles resolve through the profile; case.yaml profile and mainOverride"
```

---
## Task 8: The chat send path — turn snapshot, main gate and routed failover

**Files:**
- Modify: `src/ipc/chat-handlers.js` — requires (`:1-9`); the `STALE_TEST_RETEST_MS` constant (`:15-18`, removed); the context destructure (`:21-45`); `autoNameChat` (`:56-97`); `resolveAgentLoopModel` (`:284-294`, removed); the send handler from `let inference = null;` (`:335`) through the catch block (`:803-838`)
- Modify: `src/core/create-core.js` (context: `routedProvider`)
- Rewrite: `tests/helpers/chat-harness.js`
- Test: `tests/chat-profiles.test.js` (new), `tests/chat-usability.test.js` (two tests changed, one removed), `tests/cases-chat.test.js` (harness and three tests), `tests/cases-stop.test.js:64`, `tests/cases-detour-hooks.test.js:62`, `tests/desktop-bridge-dispatcher.test.js:68-74`, `tests/e2e/_attach-service.js:53-56`, `tests/chat-stop.test.js` (unchanged; run)

**Interfaces:**
- Consumes: `context.snapshotModels({ chatId, caseId }) → TurnModels` (Task 5), `turn.models` (Task 7), `TurnModels#mustResolve/candidatesFor` (Task 2), `NoUsableModelError` codes `NO_USABLE_MODEL` / `MAIN_OVERRIDE_UNUSABLE` (Task 2), `InferenceRouter#routedProvider` (Task 4), `caseRuntime.routedProvider(turn, { targets })` (Task 7), `Availability#refreshForUse` (Task 5), `roleTimeoutMs` (Task 2), `NO_RETRY` (Task 4).
- Produces:
  - `core.context.routedProvider({ targets, signal }) → RoutedProvider` (the core's router).
  - `chat:sendMessage` builds one `TurnModels` per turn (a case turn's own from `beginTurn`), resolves `main` with the turn's needs, fails before any call with the resolver's message, and routes every call of the turn (plain and agent mode, the advisor, the title) through main's resolved list. `chat:messageError` carries `action: { kind: 'use-profile-main' }` for `MAIN_OVERRIDE_UNUSABLE` and `action: { kind: 'open-models' }` for `NO_USABLE_MODEL`.
  - The advisor reviews on the turn's main target (no `advisor.model`); the chat title is written by main's list (utility is M3).
  - The send path no longer calls `reportProviderError` itself: the router reports auth failures against the provider that failed.
  - `tests/helpers/chat-harness.js`: `chatHarness({ provider, providerType = 'openai', model = 'test-model', providers = null, roles = null, chat = null, overrides = {} })` — the profile's main is `[{ providerType, model }]` unless `roles` is given; `providers` maps a provider name to its instance; `chat.mainOverride` is read at snapshot time.

- [ ] **Step 1: Rewrite the chat harness**

Replace `tests/helpers/chat-harness.js` with:

```js
// tests/helpers/chat-harness.js
// chat:sendMessage and chat:stopResponse against a minimal context, with the
// real AgentLoop, the real resolver and the real router. The profile's main
// is [{ providerType, model }] unless `roles` says otherwise; `providers`
// maps a provider name to the instance that answers for it, else `provider`
// answers for every one. Anything not given resolves to a function
// returning null, which the send path treats as "feature absent".
const EventEmitter = require('events');
const IPC = require('../../src/ipc/constants');
const { registerChatHandlers } = require('../../src/ipc/chat-handlers');
const { initializeTools, toolRegistry } = require('../../src/tools');
const AgentLoop = require('../../src/execution/agent-loop');
const InferenceRouter = require('../../src/providers/inference-router');
const { createTurnModels } = require('../../src/models/resolver');

initializeTools();

function chatHarness({ provider, providerType = 'openai', model = 'test-model', providers = null, roles = null, chat = null, overrides = {} } = {}) {
  const sent = [];
  const usage = [];
  const theChat = chat || { id: 'chat-1', title: 'Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const profile = {
    id: 'p-test',
    name: 'Test profile',
    kind: 'user',
    roles: roles
      ? { main: [], worker: [], utility: [], ...roles }
      : { main: [{ provider: providerType, model, effort: null }], worker: [], utility: [] }
  };
  let nextId = 0;
  let ctx = null;
  const context = {
    getChats: () => [theChat],
    setChats: () => {},
    appendMessageToChat: (_chatId, sender, text, metadata = {}) => {
      theChat.messages.push({ id: `m${theChat.messages.length}`, sender, text, ...metadata });
      return theChat;
    },
    runHookEvent: async () => ({}),
    // The turn's models: read at snapshot time, so a test can switch the
    // main override between turns (or during one).
    snapshotModels: () => createTurnModels({
      profile,
      mainOverride: theChat.mainOverride || null,
      explain: (p, m, o) => {
        const availability = ctx.getAvailability();
        return availability && typeof availability.explain === 'function'
          ? availability.explain(p, m, o)
          : { usable: true, reasons: [], notes: [] };
      }
    }),
    routedProvider: ({ targets, signal }) => new InferenceRouter({
      getProviderToken: () => 'test-token-123456',
      createProvider: (p) => (providers && providers[p]) || provider,
      sleep: async () => {},
      onProviderError: (p, err) => ctx.reportProviderError(p, err)
    }).routedProvider({ targets, signal }),
    getUsageTracker: () => ({ record: (event) => { usage.push(event); return { ...event, cost: event.costUsd ?? null }; } }),
    createUsageRecordFromMetrics: (m) => ({
      provider: m.provider,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      costUsd: typeof m.costUsd === 'number' ? m.costUsd : null,
      ...(m.usagePartial ? { usagePartial: true } : {})
    }),
    getConversationCompactor: () => null,
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async () => {
      const executor = new EventEmitter();
      executor.allowedDirectories = [];
      executor.execute = async () => ({ ok: true });
      return executor;
    },
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    createId: () => `id-${++nextId}`,
    ...overrides
  };
  ctx = new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, ctx);
  const event = {
    sender: {
      send: (channel, payload) => {
        sent.push({ channel, payload });
        if (typeof context.onSend === 'function') context.onSend(channel, payload);
      },
      isDestroyed: () => false
    }
  };
  const send = (payload = {}) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: theChat.id, message: 'Hello', ...payload });
  const stop = () => handlers.get(IPC.CHAT_STOP_RESPONSE)(event, { chatId: theChat.id });
  return { chat: theChat, sent, usage, send, stop, context };
}

module.exports = { chatHarness };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/chat-profiles.test.js`:

```js
// tests/chat-profiles.test.js
// The chat turn on profiles (spec 2026-09-27 §6.5–§6.7, §15): models frozen
// at launch, the main gate and its messages, an unusable override, and
// failover along main's list — any provider on the first call only.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { chatHarness } = require('./helpers/chat-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const t = (provider, model) => ({ provider, model, effort: null });
const errorEvent = (h) => h.sent.find((e) => e.channel === 'chat:messageError')?.payload;

function verdicts(unusable = {}) {
  return {
    ensureTested: async () => ({ ok: true }),
    explain: (p, m) => (unusable[`${p}/${m}`] ? { usable: false, reasons: [unusable[`${p}/${m}`]], notes: [] } : { usable: true, reasons: [], notes: [] })
  };
}

describe('chat turns on profiles', () => {
  it('a main switch during a run applies to the next turn', async () => {
    const seen = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const provider = {
      sendMessageWithTools: async (_messages, _tools, opts) => {
        seen.push(opts.model);
        if (seen.length === 1) await gate;
        return { type: 'text', content: `answered by ${opts.model}` };
      }
    };
    const h = chatHarness({ provider, model: 'model-a' });
    const first = h.send({ agentMode: true, message: 'first' });
    while (!seen.length) await tick();
    h.chat.mainOverride = t('openai', 'model-b');
    release();
    await first;
    await h.send({ agentMode: true, message: 'second' });
    assert.deepStrictEqual(seen, ['model-a', 'model-b']);
    const replies = h.chat.messages.filter((m) => m.sender === 'assistant').map((m) => m.text);
    assert.deepStrictEqual(replies.slice(-2), ['answered by model-a', 'answered by model-b']);
  });

  it('an unusable main override fails the turn with the reason and a one-click action, never a silent switch', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; } };
    const h = chatHarness({ provider, model: 'gpt-5.5', overrides: { getAvailability: () => verdicts({ 'groq/llama-3.3-70b': 'Groq connection test failed: Invalid API Key' }) } });
    h.chat.mainOverride = t('groq', 'llama-3.3-70b');
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /The main model override groq\/llama-3\.3-70b is not usable: Groq connection test failed: Invalid API Key/);
    assert.deepStrictEqual(errorEvent(h).action, { kind: 'use-profile-main' });
    assert.strictEqual(called, false);
  });

  it('no usable main fails before any call, listing every skipped target and its reason', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; } };
    const h = chatHarness({
      provider,
      roles: { main: [t('groq', 'a'), t('openai', 'b')] },
      overrides: { getAvailability: () => verdicts({ 'groq/a': 'No token saved for Groq.', 'openai/b': 'OpenAI connection test failed: timeout' }) }
    });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /No usable model for main in the profile "Test profile"\. Skipped: groq\/a \(No token saved for Groq\.\); openai\/b \(OpenAI connection test failed: timeout\)/);
    assert.deepStrictEqual(errorEvent(h).action, { kind: 'open-models' });
    assert.strictEqual(called, false);
  });

  it('an empty main points the owner to Models', async () => {
    const h = chatHarness({ provider: {}, roles: { main: [] } });
    const result = await h.send({ agentMode: false });
    assert.match(result.error, /main has no models in the profile "Test profile"\. Add one in Settings → Models/);
  });

  it('fails over along main on the turn\'s first call, to another provider', async () => {
    const providers = {
      groq: { streamMessage: async () => { throw new Error('upstream exploded'); } },
      openai: {
        streamMessage: async (_messages, opts, onChunk) => {
          onChunk('Hello');
          return { llmMetrics: { provider: 'openai', model: opts.model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 } };
        }
      }
    };
    const h = chatHarness({ providers, roles: { main: [t('groq', 'down'), t('openai', 'up')] } });
    const result = await h.send({ agentMode: false });
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.deepStrictEqual([reply.text, reply.llm.calls[0].model], ['Hello', 'up']);
  });

  it('a turn cannot move to another provider after its first call, and says to retry with another model', async () => {
    let openaiCalls = 0;
    let anthropicCalled = false;
    const providers = {
      openai: {
        sendMessageWithTools: async () => {
          openaiCalls += 1;
          if (openaiCalls === 1) return { type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } };
          throw new Error('upstream exploded');
        }
      },
      anthropic: { sendMessageWithTools: async () => { anthropicCalled = true; return { type: 'text', content: 'no' }; } }
    };
    const h = chatHarness({ providers, roles: { main: [t('openai', 'a'), t('anthropic', 'b')] } });
    const result = await h.send({ agentMode: true });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /cannot move to anthropic\/b after its first model call/);
    assert.match(result.error, /Retry with/);
    assert.strictEqual(anthropicCalled, false);
  });

  it('the advisor reviews on the turn\'s main model', async () => {
    const models = [];
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => { models.push(['loop', opts.model]); return { type: 'text', content: 'done' }; },
      sendMessage: async (_m, opts) => { models.push(['advisor', opts.model]); return 'VERDICT: approve\nLooks right.'; }
    };
    const h = chatHarness({ provider, model: 'gpt-5.5', overrides: { getSettings: () => ({ advisor: { enabled: true } }) } });
    await h.send({ agentMode: true });
    assert.ok(models.some(([who, m]) => who === 'advisor' && m === 'gpt-5.5'), JSON.stringify(models));
  });
});
```

In `tests/chat-usability.test.js`:

- in `'refuses an unusable model before any model call, with the reasons'` replace the `result.error` assertion with:

```js
    assert.match(result.error, /^No usable model for main in the profile "Test profile"\. Skipped: groq\/llama-3\.3-70b \(Groq connection test failed at 2026-09-27T11:00:00\.000Z: Invalid API Key\)/);
```

- delete the test `"an empty resolved model falls back to the provider's own default before the check (finding 4)"` and the comment block above it (an empty model can no longer reach the send path: profiles refuse it, and `tests/chat-profiles.test.js` covers an empty main).

In `tests/cases-chat.test.js`:

- add `const { createTurnModels } = require('../src/models/resolver');` to the requires;
- in `harness()`, rename `resolveInferenceCalls: 0` to `snapshots: 0` in `calls`; replace the runtime's `routedProvider` stub with

```js
    routedProvider: (turn, spec) => {
      calls.routed.push(spec);
      return {
        routed: true,
        getProviderName: () => spec.targets[0].provider,
        ...(providerHasTools ? { sendMessageWithTools: async () => ({}) } : {}),
        streamMessage: async () => streamMessageResult || {}
      };
    },
```

  and replace the `resolveInference: async () => { … },` override with

```js
    snapshotModels: () => {
      calls.snapshots += 1;
      if (calls.snapshots === inferenceErrorOnCall) throw new Error('no provider configured');
      return createTurnModels({
        profile: { id: 'p-test', name: 'Test profile', roles: { main: [{ provider: 'openai', model: 'test-model', effort: null }], worker: [], utility: [] } },
        explain: () => ({ usable: true, reasons: [], notes: [] })
      });
    },
    routedProvider: ({ targets }) => ({
      chatRouted: true,
      current: () => ({ ...targets[0] }),
      getProviderName: () => targets[0].provider,
      ...(providerHasTools ? { sendMessageWithTools: async () => ({}) } : {}),
      streamMessage: async () => streamMessageResult || {}
    }),
```

- replace both `assert.strictEqual(calls.resolveInferenceCalls, 0, 'no provider was ever resolved');` with `assert.strictEqual(calls.snapshots, 0, 'no model was ever resolved');`;
- replace `assert.deepStrictEqual(calls.routed, [{ target: { provider: 'openai', model: 'test-model' }, tier: 'standard' }]);` with `assert.deepStrictEqual(calls.routed, [{ targets: [{ provider: 'openai', model: 'test-model', effort: null }] }]);`;
- replace the test `'leaves chats without a case on the plain provider, failover and prompter'` with:

```js
  it('routes a chat without a case through the router, not the case runtime, with the plain prompter', async () => {
    const { calls, send } = harness({ caseId: null });
    await send({ agentMode: true });
    assert.deepStrictEqual(calls.routed, []);
    assert.strictEqual(calls.loopProvider.chatRouted, true);
    // The routed provider fails over itself; its loop never retries (§6.7).
    assert.strictEqual(calls.loopOptions.failoverPolicy.plan(new Error('x')).action, 'abort');
    assert.strictEqual(calls.loopOptions.onUsageRecorded, undefined);
    // Not casePrompter(prompter): that wraps into a plain { askUser, ... }
    // object, so a case turn's prompter is typeof 'object'; the plain
    // path's is whatever context.prompter itself is (a function here).
    assert.strictEqual(typeof calls.loopOptions.prompter, 'function');
  });
```

- replace the comment above `'does not report a case turn\'s failure itself …'` with `// A case turn's calls go through caseRuntime.routedProvider(), whose router reports each auth failure against the provider that actually failed; the send path never reports one itself (spec §6.7).`

In `tests/cases-stop.test.js:64` replace `routedProvider: (_turn, spec) => ({ getProviderName: () => spec.target.provider, sendMessageWithTools: async () => ({}) }),` with `routedProvider: (_turn, spec) => ({ getProviderName: () => spec.targets[0].provider, sendMessageWithTools: async () => ({}) }),`.

In `tests/cases-detour-hooks.test.js`: add `const { createTurnModels } = require('../src/models/resolver');` and replace the `resolveInference: async () => ({ … }),` override with:

```js
    snapshotModels: () => createTurnModels({
      profile: { id: 'p-test', name: 'Test profile', roles: { main: [{ provider: 'openai', model: 'test-model', effort: null }], worker: [], utility: [] } },
      explain: () => ({ usable: true, reasons: [], notes: [] })
    }),
    routedProvider: () => ({ sendMessageWithTools: async () => ({}), streamMessage: async () => ({}) }),
```

In `tests/desktop-bridge-dispatcher.test.js` add `const { profileSettings, everyRole } = require('./helpers/profile-settings');` to the requires and replace the tier block at `:68-74` (`const tiers = { provider: 'openai', model: 'fake' };`, `const settings = core.getSettings();` and the `setSettings({ …activeProvider… tierMap … })` call) with:

```js
  core.context.setSettings(profileSettings(core.getSettings(), everyRole({ provider: 'openai', model: 'fake' })));
```

In `tests/e2e/_attach-service.js` add `const { profileSettings, everyRole } = require('../helpers/profile-settings');` and replace its tier block at `:53-56` the same way:

```js
seed.context.setSettings(profileSettings(seed.getSettings(), everyRole({ provider: 'openai', model: 'stub' })));
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/chat-profiles.test.js tests/chat-usability.test.js tests/cases-chat.test.js`
Expected: FAIL — the send path still calls `resolveInference` (`resolveInference is not a function` from the proxy's null default), so every send is refused.

- [ ] **Step 4: Rewrite the send path**

In `src/ipc/chat-handlers.js`:

(a) Requires: after `const { NO_RETRY } = require('../cases/roles');` add

```js
const { roleTimeoutMs } = require('../models/resolver');
const { KL_PROVIDERS } = require('../models/provider-ids');
```

(b) Replace the `STALE_TEST_RETEST_MS` comment and constant with:

```js
// Before a send (spec 2026-09-27 §5.2): a never-tested provider is tested
// now and a stale non-auth failure retested once (Availability#refreshForUse;
// a host double with only ensureTested gets that).
async function refreshProvider(availability, provider) {
  if (typeof availability.refreshForUse === 'function') return availability.refreshForUse(provider);
  if (typeof availability.ensureTested === 'function') return availability.ensureTested(provider);
  return null;
}
```

(c) In the `context` destructure replace `resolveInference,` with `snapshotModels,` and add `routedProvider: createRoutedProvider,` after it.

(d) Replace `autoNameChat` with:

```js
  /**
   * Generate a contextual title for a chat with the turn's main models (the
   * utility role takes this over in stage M3), then persist it and notify
   * the renderer.
   */
  async function autoNameChat(chatId, userMessage, assistantResponse, sender, provider) {
    try {
      if (!provider || typeof provider.sendMessage !== 'function') return;

      const titlePrompt = [
        {
          sender: 'user',
          text: `Generate a short, descriptive title (max 6 words) for a chat that starts with this exchange. Reply with ONLY the title text, no quotes or punctuation at the end.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantResponse.slice(0, 300)}`
        }
      ];

      const title = await provider.sendMessage(titlePrompt, { temperature: 0.3, max_tokens: 30 });

      const cleaned = String(title || '').replace(/^["']|["'.!]$/g, '').trim();
      if (!cleaned) return;

      const chats = getChats();
      const updated = chats.map((chat) =>
        chat.id === chatId
          ? { ...chat, title: cleaned, updatedAt: new Date().toISOString() }
          : chat
      );
      setChats(updated);

      // Notify the renderer so the sidebar updates
      if (sender && !sender.isDestroyed()) {
        sender.send('chat:updated', { chats: updated });
      }
    } catch (err) {
      log.warn(`Failed to generate chat title: ${err.message}`);
    }
  }
```

(e) Delete the `resolveAgentLoopModel` function and its doc comment.

(f) In the send handler replace `let inference = null;` with:

```js
    let turnModels = null;
    let main = null;
```

(g) Replace everything from `inference = await resolveInference({ message: safeMessage, agentMode });` through `const provider = inference.provider;` (the M1 gate, the stop check after it, and the smart-routing prefix strip) with:

```js
      // The turn's models, frozen now (spec 2026-09-27 §6.6): the profile
      // and main override as they stand at launch serve every model call of
      // this turn; a switch or a settings change applies to the next turn. A
      // case turn froze its own at beginTurn, from case.yaml's choice.
      turnModels = (caseTurn && caseTurn.models) || snapshotModels({ chatId, caseId });

      // Any usable model may answer (spec §5.5, §6.4): its provider's test
      // passed, it is in the account's list, and it can call tools (agent
      // mode, case turns) or read images when the owner attached some.
      const needs = {
        ...(agentMode || caseTurn ? { toolCall: true } : {}),
        ...(normalizedImages.length > 0 ? { imageInput: true } : {})
      };
      const availability = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
      if (availability) {
        const providers = [...new Set(turnModels.candidatesFor('main').map((x) => x.provider))].filter((p) => KL_PROVIDERS.includes(p));
        for (const p of providers) await refreshProvider(availability, p);
      }
      // No usable main fails the turn before any call, listing every skipped
      // target with its reason; an unusable override fails with the reason
      // and a one-click "use the profile's main" (spec §15). Never a silent
      // switch to another model.
      main = turnModels.mustResolve('main', { needs });
      const mainTarget = main.targets[0];

      // The gate above can run a connection test (20s or more): a Stop
      // pressed during it must end the run here, with no model call, rather
      // than let the send continue once the test finally settles (final
      // review I2).
      if (abortController.signal.aborted) return finishStopped();

      // Every call of this turn walks main's resolved list (spec §6.7): any
      // provider on the first call, the same provider after it. A case
      // turn's calls go through the case runtime, which charges the case.
      const provider = caseTurn
        ? caseRuntime.routedProvider(caseTurn, { targets: main.targets })
        : createRoutedProvider({ targets: main.targets, signal: abortController.signal });
```

(h) Replace the comment line `// it was persisted (above) before smart-routing prefix stripping, so` / `// the post-strip safeMessage may not textually match that entry.` with `// it was persisted above, and may not be in chatRaw's copy yet.`

(i) Replace the `options` object with:

```js
      const options = {
        model: mainTarget.model,
        timeoutMs: roleTimeoutMs(settings, 'main'),
        runId
      };
```

(j) In the agent-mode branch, delete `const loopModel = resolveAgentLoopModel();` and the `loopProvider` block with its comment; construct the loop on `provider`, delete `loopModel,` from its options, and replace `...(caseTurn ? { onUsageRecorded: caseRuntime.usageHook(caseTurn), failoverPolicy: NO_RETRY } : {}),` with:

```js
            // The routed provider fails over itself (spec §6.7); the loop never retries.
            failoverPolicy: NO_RETRY,
            ...(caseTurn ? { onUsageRecorded: caseRuntime.usageHook(caseTurn) } : {}),
```

(k) Replace the advisor block's condition and model:

```js
          // The advisor reviews on the turn's main model (spec §8; advisor.model is gone, §13).
          const advisorSettings = typeof getSettings === 'function' ? getSettings() : {};
          const advisorConfig = advisorSettings.advisor;
          if (advisorConfig?.enabled && !abortController.signal.aborted) {
            const advisorModel = mainTarget.model;
            try {
              safeSend(event.sender, 'chat:advisorStarted', { chatId });
              const advisor = new Advisor({
                provider,
                model: advisorModel,
                usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null
              });

              const reviewResult = await advisor.review(result, {
                userMessage: safeMessage
              });

              if (reviewResult.review) {
                // Append advisor review as a system note
                const reviewNote = `\n\n---\n**Advisor Review** (${advisorModel}):\n${reviewResult.review}`;
                fullResponse += reviewNote;
                safeSend(event.sender, 'chat:messageChunk', { chatId, responseId, chunk: reviewNote });
                safeSend(event.sender, 'chat:advisorCompleted', {
                  chatId,
                  verdict: reviewResult.verdict,
                  model: advisorModel
                });
              }
            } catch (err) {
              advisorLog.warn(`Review failed: ${err.message}`);
            }
          }
```

(l) In the plain path replace `streamResult = { llmMetrics: partialMetricsOf(err, { provider: inference.providerType, model: inference.model }) };` with:

```js
            const at = typeof provider.current === 'function' ? provider.current() : mainTarget;
            streamResult = { llmMetrics: partialMetricsOf(err, { provider: at.provider, model: at.model }) };
```

(m) Replace `autoNameChat(chatId, safeMessage, fullResponse, event.sender).catch(() => {});` with `autoNameChat(chatId, safeMessage, fullResponse, event.sender, createRoutedProvider({ targets: main.targets })).catch(() => {});`.

(n) In the `catch (error)` block, delete the comment block and the `if (inference && !caseRuntime && error?.code !== 'MODEL_NOT_USABLE' && …) { context.reportProviderError(…); }` statement, and replace the `chat:messageError` send with:

```js
      // The router already reported any auth failure against the provider
      // that actually failed (spec §5.3, §6.7); the send path never does.
      safeSend(event.sender, 'chat:messageError', {
        chatId,
        responseId,
        error: error.message,
        ...(error?.code === 'MAIN_OVERRIDE_UNUSABLE' ? { action: { kind: 'use-profile-main' } } : {}),
        ...(error?.code === 'NO_USABLE_MODEL' ? { action: { kind: 'open-models' } } : {})
      });
```

- [ ] **Step 5: Give the core's context a routed provider**

In `src/core/create-core.js`, in the `context` object after `resolveRole,` (Task 5) add:

```js
    routedProvider: ({ targets, signal = null } = {}) => inferenceRouter.routedProvider({ targets, signal }),
```

- [ ] **Step 6: Update the other chat tests**

Apply the edits listed in Step 2 to `tests/chat-usability.test.js`, `tests/cases-chat.test.js`, `tests/cases-stop.test.js`, `tests/cases-detour-hooks.test.js`, `tests/desktop-bridge-dispatcher.test.js` and `tests/e2e/_attach-service.js`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/chat-profiles.test.js tests/chat-usability.test.js tests/chat-stop.test.js tests/cases-chat.test.js tests/cases-stop.test.js tests/cases-detour-hooks.test.js tests/desktop-bridge-dispatcher.test.js tests/models-core-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/ipc/chat-handlers.js src/core/create-core.js tests/helpers/chat-harness.js tests/chat-profiles.test.js tests/chat-usability.test.js tests/cases-chat.test.js tests/cases-stop.test.js tests/cases-detour-hooks.test.js tests/desktop-bridge-dispatcher.test.js tests/e2e/_attach-service.js
git commit -m "feat(chat): a turn freezes its models, gates on main and fails over along main's list"
```

---
## Task 9: Model choices between turns, and the `models:*` channels for profiles

**Files:**
- Create: `src/models/profile-view.js`, `src/core/model-choices.js`
- Modify: `src/core/create-core.js` (build the choices after `caseRuntime`; context `getModelChoices`), `src/ipc/constants.js:90-96` (ten constants), `src/ipc/models-handlers.js` (ten handlers), `preload.js:930-949` (`window.electron.models`)
- Test: `tests/model-choices.test.js` (new), `tests/models-profiles-ipc.test.js` (new), `tests/ipc-contract.test.js` (run), `tests/desktop-bridge-allowlist.test.js` (run)

**Interfaces:**
- Consumes: `Profiles` (Tasks 1–2), `ROLE_NEEDS`, `normalizeTarget`, `targetKey` (Task 1), `snapshotModels`, `explainTarget` (Task 5), `CaseRuntime#setModelChoice`, `#getCase`, `#listCases` (Task 7), `Availability#usable({ needs })`, `Catalog#get/list/status`.
- Produces:
  - `profileView(profile, { explain, catalog }) → { id, name, kind, roles: { [role]: EntryView[] }, migration }`, `EntryView = { provider, model, effort, name, usable, reasons, notes, priced, cost: { input, output } | null, context, efforts, toolCall, imageInput }`.
  - `createModelChoices({ profiles, catalog, availability, explainTarget, snapshotModels, getChats, setChats, appendMessageToChat, getCaseRuntime })` → `{ profilesView(), saveProfile({ id?, name, roles }), duplicateProfile(id), setDefaultProfile(id), removeProfile(id) → Promise<{ removed, defaultProfileId, moved: { chats, cases } }>, pickerView({ needs }) → { usable: Choice[], unusable: Choice[] }, chatView(chatId) → ChatModelsView, setChatProfile(chatId, profileId|null) → Promise<chat>, setMainOverride(chatId, target|null) → Promise<chat> }`.
  - `ChatModelsView = { chatId, caseId, profile: { id, name }, chosenProfileId, defaultProfileId, profiles: [{ id, name }], main: { provider, model, name, usable, reasons } | null, overridden, choices: [{ provider, model, name, inMain }] }` — `choices` are usable models, the profile's main models first (Retry with…, the switcher).
  - A main switch appends the status message `Main model switched from <name> to <name>`; clearing it appends `Main model reset to the profile's main (<name>)`; a profile pick appends `This chat now uses the profile <name>.` (or `This case …`, or `… the default profile (<name>).`); a deleted profile moves its chats and cases to the default and each affected chat gets `The profile <name> was deleted; this chat (or case) now uses the default profile (<name>).`
  - IPC (`src/ipc/constants.js`): `MODELS_PROFILES 'models:profiles'`, `MODELS_SAVE_PROFILE 'models:saveProfile'`, `MODELS_DUPLICATE_PROFILE 'models:duplicateProfile'`, `MODELS_REMOVE_PROFILE 'models:removeProfile'`, `MODELS_SET_DEFAULT_PROFILE 'models:setDefaultProfile'`, `MODELS_PICKER 'models:picker'`, `MODELS_CHAT_VIEW 'models:chatView'`, `MODELS_SET_CHAT_PROFILE 'models:setChatProfile'`, `MODELS_SET_MAIN_OVERRIDE 'models:setMainOverride'`, `MODELS_SAVE_CATALOG_SETTINGS 'models:saveCatalogSettings'`.
  - `window.electron.models.{ profiles(), saveProfile(p), duplicateProfile(id), removeProfile(id), setDefaultProfile(id), picker(payload), chatView(chatId), setChatProfile(payload), setMainOverride(payload), saveCatalogSettings(payload) }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/model-choices.test.js`:

```js
// tests/model-choices.test.js
// The owner's model choices between turns (spec 2026-09-27 §6.5, §9, §11,
// §15): the header view and Retry with…'s list, the profile picker, the main
// switch with its status message, and a deleted profile moving its chats
// and cases to the default.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createModelChoices } = require('../src/core/model-choices');
const { Profiles } = require('../src/models/profiles');
const { mergeSettings } = require('../src/core/settings');
const { fixtureCatalog } = require('./helpers/models-fixture');

const t = (provider, model, effort = null) => ({ provider, model, effort });

function setup({ chats = [], unusable = {}, cases = {} } = {}) {
  let settings = mergeSettings({
    models: {
      profiles: [
        { id: 'p-a', name: 'Work', roles: { main: [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')], worker: [t('openai', 'gpt-5.4')] } },
        { id: 'p-b', name: 'Cheap', roles: { main: [t('openai', 'gpt-5.4-mini')] } }
      ],
      defaultProfileId: 'p-a'
    }
  });
  let n = 0;
  const profiles = new Profiles({ getSettings: () => settings, setSettings: (s) => { settings = mergeSettings(s); }, createId: () => `id${++n}` });
  let store = chats.map((c) => ({ messages: [], ...c }));
  const explainTarget = (p, m) => (unusable[`${p}/${m}`] ? { usable: false, reasons: [unusable[`${p}/${m}`]], notes: [] } : { usable: true, reasons: [], notes: [] });
  const caseCalls = [];
  const caseMeta = { ...cases };
  const caseRuntime = {
    getCase: (id) => { if (!caseMeta[id]) throw new Error('Case not found'); return { id, ...caseMeta[id] }; },
    listCases: () => Object.keys(caseMeta).map((id) => ({ id, ...caseMeta[id] })),
    setModelChoice: async (id, patch) => { caseCalls.push([id, patch]); caseMeta[id] = { ...caseMeta[id], ...patch }; return { id, ...caseMeta[id] }; }
  };
  const snapshotModels = ({ chatId = null } = {}) => {
    const chat = chatId ? store.find((c) => c.id === chatId) : null;
    const meta = chat?.caseId ? caseMeta[chat.caseId] : null;
    const profileId = meta?.profile || chat?.profileId || null;
    const mainOverride = chat?.caseId ? (meta?.mainOverride || null) : (chat?.mainOverride || null);
    return profiles.snapshot({ profileId, mainOverride, explain: explainTarget });
  };
  const availability = {
    usable: () => [
      { provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5' },
      { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o' },
      { provider: 'groq', model: 'llama-3.3-70b', name: 'Llama 3.3 70B' }
    ]
  };
  const choices = createModelChoices({
    profiles,
    catalog: fixtureCatalog(),
    availability,
    explainTarget,
    snapshotModels,
    getChats: () => store,
    setChats: (next) => { store = next; },
    appendMessageToChat: (chatId, sender, text) => { store = store.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, { sender, text }] } : c)); return store.find((c) => c.id === chatId); },
    getCaseRuntime: () => caseRuntime
  });
  const chat = (id) => store.find((c) => c.id === id);
  const statuses = (id) => chat(id).messages.filter((m) => m.sender === 'status').map((m) => m.text);
  return { choices, profiles, chat, statuses, caseCalls, caseMeta };
}

describe('the chat header view', () => {
  it('shows the profile, the main model, and usable choices with main\'s first', () => {
    const { choices } = setup({ chats: [{ id: 'c1' }] });
    const v = choices.chatView('c1');
    assert.deepStrictEqual(v.profile, { id: 'p-a', name: 'Work' });
    assert.deepStrictEqual([v.chosenProfileId, v.defaultProfileId, v.overridden], [null, 'p-a', false]);
    assert.deepStrictEqual(v.main, { provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5', usable: true, reasons: [] });
    assert.deepStrictEqual(v.choices.map((c) => [`${c.provider}/${c.model}`, c.inMain]), [
      ['openai/gpt-5.5', true], ['anthropic/claude-sonnet-4-5', true], ['openai/gpt-4o', false], ['groq/llama-3.3-70b', false]
    ]);
    assert.deepStrictEqual(v.profiles.map((p) => p.name), ['Work', 'Cheap']);
  });

  it('shows an unusable override with its reason', () => {
    const { choices } = setup({ chats: [{ id: 'c1', mainOverride: t('groq', 'llama-3.3-70b') }], unusable: { 'groq/llama-3.3-70b': 'No token saved for Groq.' } });
    const v = choices.chatView('c1');
    assert.strictEqual(v.overridden, true);
    assert.deepStrictEqual([v.main.model, v.main.usable, v.main.reasons], ['llama-3.3-70b', false, ['No token saved for Groq.']]);
  });

  it('refuses an unknown chat', () => {
    assert.throws(() => setup().choices.chatView('nope'), /Chat not found/);
  });
});

describe('switching', () => {
  it('sets and clears a chat\'s main override, each with a status message', async () => {
    const { choices, chat, statuses } = setup({ chats: [{ id: 'c1' }] });
    await choices.setMainOverride('c1', { provider: 'OpenAI', model: 'gpt-4o' });
    assert.deepStrictEqual(chat('c1').mainOverride, t('openai', 'gpt-4o'));
    await choices.setMainOverride('c1', null);
    assert.strictEqual('mainOverride' in chat('c1'), false);
    assert.deepStrictEqual(statuses('c1'), ['Main model switched from GPT-5.5 to GPT-4o', 'Main model reset to the profile\'s main (GPT-5.5)']);
  });

  it('refuses to switch to a model that cannot be used', async () => {
    const { choices, chat } = setup({ chats: [{ id: 'c1' }], unusable: { 'groq/llama-3.3-70b': 'No token saved for Groq.' } });
    await assert.rejects(choices.setMainOverride('c1', t('groq', 'llama-3.3-70b')), /groq\/llama-3\.3-70b cannot be used: No token saved for Groq\./);
    await assert.rejects(choices.setMainOverride('c1', { provider: 'openai' }), /Pick a model/);
    assert.strictEqual('mainOverride' in chat('c1'), false);
  });

  it('in a case chat, writes case.yaml through the case runtime', async () => {
    const { choices, chat, statuses, caseCalls } = setup({ chats: [{ id: 'c1', caseId: 'case-1' }], cases: { 'case-1': {} } });
    await choices.setMainOverride('c1', t('openai', 'gpt-4o'));
    await choices.setChatProfile('c1', 'p-b');
    assert.deepStrictEqual(caseCalls, [['case-1', { mainOverride: t('openai', 'gpt-4o') }], ['case-1', { profile: 'p-b' }]]);
    assert.strictEqual('mainOverride' in chat('c1'), false, 'the chat itself is untouched');
    assert.deepStrictEqual(statuses('c1'), ['Main model switched from GPT-5.5 to GPT-4o', 'This case now uses the profile Cheap.']);
    assert.strictEqual(choices.chatView('c1').chosenProfileId, 'p-b');
  });

  it('picks and clears a chat profile', async () => {
    const { choices, chat, statuses } = setup({ chats: [{ id: 'c1' }] });
    await choices.setChatProfile('c1', 'p-b');
    assert.strictEqual(chat('c1').profileId, 'p-b');
    await choices.setChatProfile('c1', null);
    assert.strictEqual('profileId' in chat('c1'), false);
    assert.deepStrictEqual(statuses('c1'), ['This chat now uses the profile Cheap.', 'This chat now uses the default profile (Work).']);
    await assert.rejects(choices.setChatProfile('c1', 'p-gone'), /No profile with id p-gone/);
  });
});

describe('profiles', () => {
  it('a deleted profile moves its chats and cases to the default, saying so', async () => {
    const { choices, chat, statuses, caseCalls } = setup({
      chats: [{ id: 'c1', profileId: 'p-b' }, { id: 'c2', caseId: 'case-1' }, { id: 'c3' }],
      cases: { 'case-1': { profile: 'p-b' } }
    });
    const r = await choices.removeProfile('p-b');
    assert.deepStrictEqual(r, { removed: 'p-b', defaultProfileId: 'p-a', moved: { chats: ['c1'], cases: ['case-1'] } });
    assert.strictEqual('profileId' in chat('c1'), false);
    assert.deepStrictEqual(caseCalls, [['case-1', { profile: null }]]);
    assert.deepStrictEqual(statuses('c1'), ['The profile Cheap was deleted; this chat now uses the default profile (Work).']);
    assert.deepStrictEqual(statuses('c2'), ['The profile Cheap was deleted; this case now uses the default profile (Work).']);
    assert.deepStrictEqual(statuses('c3'), []);
  });

  it('views every profile entry with its usability, reasons and catalog facts', () => {
    const { choices } = setup({ unusable: { 'anthropic/claude-sonnet-4-5': 'Anthropic has not been tested yet.' } });
    const view = choices.profilesView();
    assert.strictEqual(view.defaultProfileId, 'p-a');
    const [a] = view.profiles;
    assert.deepStrictEqual(a.roles.main.map((e) => [e.name, e.usable, e.reasons]), [['GPT-5.5', true, []], ['Claude Sonnet 4.5', false, ['Anthropic has not been tested yet.']]]);
    assert.deepStrictEqual([a.roles.main[0].priced, a.roles.main[0].cost, a.roles.main[0].context], [true, { input: 5, output: 30 }, 1050000]);
    assert.deepStrictEqual(a.roles.main[0].efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  });

  it('saves, duplicates and sets the default', () => {
    const { choices, profiles } = setup();
    const created = choices.saveProfile({ name: 'Local', roles: { main: [t('ollama', 'llama3.2')] } });
    assert.strictEqual(created.name, 'Local');
    const renamed = choices.saveProfile({ id: created.id, name: 'Local only', roles: created.roles });
    assert.strictEqual(renamed.name, 'Local only');
    assert.strictEqual(choices.duplicateProfile('p-a').name, 'Work copy');
    assert.strictEqual(choices.setDefaultProfile(created.id), created.id);
    assert.strictEqual(profiles.defaultId(), created.id);
  });

  it('lists usable picker models, then the catalog\'s unusable ones with reasons', () => {
    const { choices } = setup({ unusable: { 'groq/llama-vision-preview': 'No token saved for Groq.' } });
    const picker = choices.pickerView({ needs: {} });
    assert.deepStrictEqual(picker.usable.map((c) => c.model), ['gpt-5.5', 'gpt-4o', 'llama-3.3-70b']);
    const vision = picker.unusable.find((c) => c.model === 'llama-vision-preview');
    assert.deepStrictEqual([vision.usable, vision.reasons], [false, ['No token saved for Groq.']]);
    assert.ok(!picker.unusable.some((c) => c.model === 'gpt-image-1'), 'no image-only models');
  });
});
```

Create `tests/models-profiles-ipc.test.js`:

```js
// tests/models-profiles-ipc.test.js
// The profile channels (spec 2026-09-27 §11): thin handlers over
// src/core/model-choices.js, errors returned as { ok: false, error }.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const IPC = require('../src/ipc/constants');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const { ProfileError } = require('../src/models/profiles');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

function setup() {
  const calls = [];
  let settings = { models: { catalog: { fetch: true, refreshHours: 24 }, overrides: {} } };
  const choices = {
    profilesView: () => ({ profiles: [{ id: 'p-a' }], defaultProfileId: 'p-a', customRoles: [] }),
    saveProfile: (p) => { calls.push(['save', p]); if (!p.name) throw new ProfileError('BAD_NAME', 'A profile needs a name.'); return { id: p.id || 'p-new', name: p.name }; },
    duplicateProfile: (id) => { calls.push(['duplicate', id]); return { id: 'p-copy' }; },
    removeProfile: async (id) => { calls.push(['remove', id]); return { removed: id, defaultProfileId: 'p-a', moved: { chats: [], cases: [] } }; },
    setDefaultProfile: (id) => { calls.push(['default', id]); return id; },
    pickerView: ({ needs }) => { calls.push(['picker', needs]); return { usable: [], unusable: [] }; },
    chatView: (chatId) => { calls.push(['view', chatId]); return { chatId }; },
    setChatProfile: async (chatId, profileId) => { calls.push(['chatProfile', chatId, profileId]); return { id: chatId }; },
    setMainOverride: async (chatId, target) => { calls.push(['override', chatId, target]); return { id: chatId }; }
  };
  const context = {
    getModelChoices: () => choices,
    getCatalog: () => ({ status: () => ({ source: 'snapshot' }) }),
    getAvailability: () => ({}),
    getSettings: () => settings,
    setSettings: (next) => { settings = next; }
  };
  const handlers = new Map();
  registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, context);
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { call, calls, settings: () => settings };
}

describe('profile channels', () => {
  it('pass through to the model choices', async () => {
    const { call, calls } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_PROFILES), { ok: true, profiles: [{ id: 'p-a' }], defaultProfileId: 'p-a', customRoles: [] });
    assert.deepStrictEqual(await call(IPC.MODELS_SAVE_PROFILE, { name: 'Local', roles: { main: [] } }), { ok: true, profile: { id: 'p-new', name: 'Local' } });
    assert.deepStrictEqual(await call(IPC.MODELS_DUPLICATE_PROFILE, { id: 'p-a' }), { ok: true, profile: { id: 'p-copy' } });
    assert.strictEqual((await call(IPC.MODELS_REMOVE_PROFILE, { id: 'p-b' })).removed, 'p-b');
    assert.deepStrictEqual(await call(IPC.MODELS_SET_DEFAULT_PROFILE, { id: 'p-b' }), { ok: true, defaultProfileId: 'p-b' });
    await call(IPC.MODELS_PICKER, { needs: { toolCall: true, junk: 1 } });
    assert.deepStrictEqual(await call(IPC.MODELS_CHAT_VIEW, { chatId: 'c1' }), { ok: true, view: { chatId: 'c1' } });
    await call(IPC.MODELS_SET_CHAT_PROFILE, { chatId: 'c1', profileId: '' });
    await call(IPC.MODELS_SET_MAIN_OVERRIDE, { chatId: 'c1', target: { provider: 'openai', model: 'gpt-5.5', extra: 1 } });
    await call(IPC.MODELS_SET_MAIN_OVERRIDE, { chatId: 'c1', target: null });
    assert.deepStrictEqual(calls.slice(-5), [
      ['picker', { toolCall: true }],
      ['view', 'c1'],
      ['chatProfile', 'c1', null],
      ['override', 'c1', { provider: 'openai', model: 'gpt-5.5', effort: null }],
      ['override', 'c1', null]
    ]);
  });

  it('return a profile error as { ok: false, error }', async () => {
    const { call } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_SAVE_PROFILE, { name: '' }), { ok: false, error: 'A profile needs a name.' });
  });

  it('save the catalog settings, refusing bad values', async () => {
    const { call, settings } = setup();
    const ok = await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { fetch: false, refreshHours: 12, overrides: { 'openai:gpt-5.5': { cost: { input: 4 } } } });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual([settings().models.catalog.fetch, settings().models.catalog.refreshHours], [false, 12]);
    assert.deepStrictEqual(settings().models.overrides, { 'openai:gpt-5.5': { cost: { input: 4 } } });
    assert.strictEqual((await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { refreshHours: 0 })).ok, false);
    assert.strictEqual((await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { overrides: ['x'] })).ok, false);
    assert.strictEqual((await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { overrides: { nocolon: {} } })).ok, false);
  });

  it('are exposed on window.electron.models in the preload bridge', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const ch of ['profiles', 'saveProfile', 'duplicateProfile', 'removeProfile', 'setDefaultProfile', 'picker', 'chatView', 'setChatProfile', 'setMainOverride', 'saveCatalogSettings']) {
      assert.ok(preload.includes(`ipcRenderer.invoke('models:${ch}'`), ch);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/model-choices.test.js tests/models-profiles-ipc.test.js`
Expected: FAIL — `Cannot find module '../src/core/model-choices'`, and the IPC constants are undefined.

- [ ] **Step 3: Write `src/models/profile-view.js`**

```js
// src/models/profile-view.js
// A profile as the Models tab shows it (spec 2026-09-27 §11): every entry
// with its catalog name, price, context and efforts, and whether it can be
// used now — unusable entries stay in the list, greyed, with the reasons.
const { ROLE_NEEDS } = require('./roles');

function entryView(target, role, { explain, catalog = null }) {
  const needs = ROLE_NEEDS[role] || {};
  const verdict = explain(target.provider, target.model, { needs }) || {};
  const entry = catalog ? catalog.get(target.provider, target.model) : null;
  return {
    provider: target.provider,
    model: target.model,
    effort: target.effort || null,
    name: entry?.name || target.model,
    usable: Boolean(verdict.usable),
    reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
    notes: Array.isArray(verdict.notes) ? verdict.notes : [],
    priced: Boolean(entry?.cost),
    cost: entry?.cost ? { input: entry.cost.input, output: entry.cost.output } : null,
    context: entry?.limits?.context ?? null,
    efforts: Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [],
    toolCall: entry ? entry.toolCall === true : null,
    imageInput: entry ? entry.input.includes('image') : null
  };
}

function profileView(profile, { explain, catalog = null } = {}) {
  const roles = {};
  for (const [role, list] of Object.entries(profile.roles || {})) {
    roles[role] = list.map((t) => entryView(t, role, { explain, catalog }));
  }
  return { id: profile.id, name: profile.name, kind: profile.kind, roles, migration: profile.migration || null };
}

module.exports = { profileView, entryView };
```

- [ ] **Step 4: Write `src/core/model-choices.js`**

```js
// src/core/model-choices.js
// The owner's model choices between turns (spec 2026-09-27 §6.5, §9, §11,
// §15): the chat and case header (profile picker, main switcher), Retry
// with…'s list, the profile editor's view and model picker, and what a
// deleted profile does to the chats and cases using it. Electron-free; the
// models:* IPC handlers are thin wrappers.
const { createLogger } = require('../logging');
const { normalizeTarget, targetLabel, targetKey } = require('../models/roles');
const { profileView } = require('../models/profile-view');

const log = createLogger('model-choices');
const PICKER_UNUSABLE_CAP = 400;

function createModelChoices({
  profiles,
  catalog = null,
  availability = null,
  explainTarget,
  snapshotModels,
  getChats,
  setChats,
  appendMessageToChat,
  getCaseRuntime = () => null
} = {}) {
  for (const [name, value] of Object.entries({ profiles, explainTarget, snapshotModels, getChats, setChats, appendMessageToChat })) {
    if (!value) throw new Error(`createModelChoices needs ${name}.`);
  }

  const findChat = (chatId) => {
    const chat = getChats().find((c) => c.id === chatId);
    if (!chat) throw new Error('Chat not found.');
    return chat;
  };
  const nameOf = (target) => {
    if (!target) return '(none)';
    const entry = catalog ? catalog.get(target.provider, target.model) : null;
    return entry?.name || target.model;
  };
  const status = (chatId, text) => appendMessageToChat(chatId, 'status', text);
  const updateChat = (chatId, patch) => {
    const now = new Date().toISOString();
    const next = getChats().map((c) => {
      if (c.id !== chatId) return c;
      const out = { ...c, updatedAt: now };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete out[key];
        else out[key] = value;
      }
      return out;
    });
    setChats(next);
    return next.find((c) => c.id === chatId);
  };
  const caseRuntimeFor = (chat) => {
    if (!chat.caseId) return null;
    const runtime = getCaseRuntime();
    if (!runtime) throw new Error('Cases are not available in this host.');
    return runtime;
  };
  const caseMetaOf = (chat) => {
    const runtime = chat.caseId ? getCaseRuntime() : null;
    if (!runtime) return null;
    try {
      return runtime.getCase(chat.caseId);
    } catch {
      return null;
    }
  };
  // A case chat and an agent-mode chat call tools; so must their main.
  const needsFor = (chat) => (chat.caseId || chat.agentMode ? { toolCall: true } : {});

  function chatView(chatId) {
    const chat = findChat(chatId);
    const needs = needsFor(chat);
    const models = snapshotModels({ chatId });
    const resolved = models.resolve('main', { needs });
    const first = resolved.targets[0] || null;
    const current = first || models.candidatesFor('main')[0] || null;
    const profileMain = models.configuredFor('main');
    const mainKeys = new Set(profileMain.map(targetKey));
    const fromMain = profileMain
      .filter((x) => explainTarget(x.provider, x.model, { needs }).usable)
      .map((x) => ({ provider: x.provider, model: x.model, name: nameOf(x), inMain: true }));
    const others = (availability && typeof availability.usable === 'function' ? availability.usable({ needs: { textOutput: true, ...needs } }) : [])
      .filter((c) => !mainKeys.has(targetKey(c)))
      .map((c) => ({ provider: c.provider, model: c.model, name: c.name || c.model, inMain: false }));
    return {
      chatId,
      caseId: chat.caseId || null,
      profile: { id: models.profileId, name: models.profileName },
      chosenProfileId: chat.caseId ? (caseMetaOf(chat)?.profile || null) : (chat.profileId || null),
      defaultProfileId: profiles.defaultId(),
      profiles: profiles.list().map((p) => ({ id: p.id, name: p.name })),
      main: current
        ? { provider: current.provider, model: current.model, name: nameOf(current), usable: Boolean(first), reasons: first ? [] : (resolved.skipped[0]?.reasons || []) }
        : null,
      overridden: Boolean(models.mainOverride),
      choices: [...fromMain, ...others]
    };
  }

  async function setChatProfile(chatId, profileId) {
    const chat = findChat(chatId);
    const id = profileId || null;
    if (id && !profiles.get(id)) throw new Error(`No profile with id ${id}.`);
    const runtime = caseRuntimeFor(chat);
    if (runtime) await runtime.setModelChoice(chat.caseId, { profile: id });
    else updateChat(chatId, { profileId: id });
    const after = snapshotModels({ chatId }).profileName;
    const where = runtime ? 'This case' : 'This chat';
    status(chatId, id ? `${where} now uses the profile ${after}.` : `${where} now uses the default profile (${after}).`);
    return findChat(chatId);
  }

  // Picking another usable model sets an override for main only (spec
  // §6.5); a running turn keeps what it launched with.
  async function setMainOverride(chatId, target) {
    const chat = findChat(chatId);
    const next = target ? normalizeTarget(target) : null;
    if (target && !next) throw new Error('Pick a model: a provider and a model id.');
    if (next) {
      const verdict = explainTarget(next.provider, next.model, { needs: needsFor(chat) });
      if (!verdict.usable) throw new Error(`${targetLabel(next)} cannot be used: ${verdict.reasons.join(' ')}`);
    }
    const before = snapshotModels({ chatId });
    const from = before.mainOverride || before.configuredFor('main')[0] || null;
    const runtime = caseRuntimeFor(chat);
    if (runtime) await runtime.setModelChoice(chat.caseId, { mainOverride: next });
    else updateChat(chatId, { mainOverride: next });
    const to = next || snapshotModels({ chatId }).configuredFor('main')[0] || null;
    status(chatId, next ? `Main model switched from ${nameOf(from)} to ${nameOf(to)}` : `Main model reset to the profile's main (${nameOf(to)})`);
    return findChat(chatId);
  }

  // A profile in use is deleted (spec §15): its chats and cases move to the
  // default profile and each affected chat says so.
  async function removeProfile(id) {
    const victim = profiles.get(id);
    if (!victim) throw new Error(`No profile with id ${id}.`);
    const { defaultProfileId } = profiles.remove(id);
    const fallback = profiles.get(defaultProfileId)?.name || 'the default';
    const moved = { chats: [], cases: [] };
    for (const chat of getChats()) {
      if (chat.caseId || chat.profileId !== id) continue;
      updateChat(chat.id, { profileId: null });
      status(chat.id, `The profile ${victim.name} was deleted; this chat now uses the default profile (${fallback}).`);
      moved.chats.push(chat.id);
    }
    const runtime = getCaseRuntime();
    const cases = runtime && typeof runtime.listCases === 'function' ? runtime.listCases() : [];
    for (const meta of cases) {
      if (meta.profile !== id) continue;
      try {
        await runtime.setModelChoice(meta.id, { profile: null });
      } catch (err) {
        // A busy case keeps the stale id until its next write; the resolver
        // already falls back to the default for an unknown profile.
        log.warn(`Moving case ${meta.id} off the deleted profile failed: ${err.message}`);
        continue;
      }
      moved.cases.push(meta.id);
      for (const chat of getChats().filter((c) => c.caseId === meta.id)) {
        status(chat.id, `The profile ${victim.name} was deleted; this case now uses the default profile (${fallback}).`);
      }
    }
    return { removed: victim.id, defaultProfileId, moved };
  }

  function profilesView() {
    return {
      profiles: profiles.list().map((p) => profileView(p, { explain: explainTarget, catalog })),
      defaultProfileId: profiles.defaultId(),
      customRoles: profiles.customRoles()
    };
  }

  function saveProfile({ id = null, name, roles } = {}) {
    const saved = id ? profiles.update(id, { name, roles }) : profiles.create({ name, roles });
    return profileView(saved, { explain: explainTarget, catalog });
  }

  function duplicateProfile(id) {
    return profileView(profiles.duplicate(id), { explain: explainTarget, catalog });
  }

  function setDefaultProfile(id) {
    return profiles.setDefault(id);
  }

  // "Add model" (spec §11): usable models meeting the role's needs first,
  // then the catalog's text models that cannot be used, with the reasons.
  function pickerView({ needs = {} } = {}) {
    const usable = (availability && typeof availability.usable === 'function' ? availability.usable({ needs: { textOutput: true, ...needs } }) : [])
      .map((c) => ({ provider: c.provider, model: c.model, name: c.name || c.model, usable: true, reasons: [], priced: Boolean(c.priced), cost: c.cost ? { input: c.cost.input, output: c.cost.output } : null, context: c.context ?? null, local: Boolean(c.local) }));
    const seen = new Set(usable.map(targetKey));
    const unusable = [];
    for (const entry of catalog ? catalog.list() : []) {
      if (unusable.length >= PICKER_UNUSABLE_CAP) break;
      if (seen.has(`${entry.provider}:${entry.id}`) || !entry.output.includes('text')) continue;
      const verdict = explainTarget(entry.provider, entry.id, { needs });
      if (verdict.usable) continue;
      unusable.push({ provider: entry.provider, model: entry.id, name: entry.name || entry.id, usable: false, reasons: verdict.reasons || [], priced: Boolean(entry.cost), cost: entry.cost ? { input: entry.cost.input, output: entry.cost.output } : null, context: entry.limits?.context ?? null, local: Boolean(entry.local) });
    }
    return { usable, unusable };
  }

  return { chatView, setChatProfile, setMainOverride, removeProfile, profilesView, saveProfile, duplicateProfile, setDefaultProfile, pickerView };
}

module.exports = { createModelChoices };
```

- [ ] **Step 5: Build the choices in the core**

In `src/core/create-core.js` add `const { createModelChoices } = require('./model-choices');` to the requires, and directly after the `const caseRuntime = new CaseRuntime({ … });` statement add:

```js
  // The owner's model choices between turns (spec §6.5, §11, §15).
  const modelChoices = createModelChoices({
    profiles,
    catalog,
    availability,
    explainTarget,
    snapshotModels,
    getChats,
    setChats,
    appendMessageToChat,
    getCaseRuntime: () => caseRuntime
  });
```

and in the `context` object after `routedProvider: …` (Task 8) add `getModelChoices: () => modelChoices,`.

- [ ] **Step 6: Add the constants, handlers and preload methods**

In `src/ipc/constants.js`, after `MODELS_SET_OLLAMA_URL: 'models:setOllamaBaseUrl',` add:

```js
  // Models stage M2: profiles and the owner's model choices.
  MODELS_PROFILES: 'models:profiles',
  MODELS_SAVE_PROFILE: 'models:saveProfile',
  MODELS_DUPLICATE_PROFILE: 'models:duplicateProfile',
  MODELS_REMOVE_PROFILE: 'models:removeProfile',
  MODELS_SET_DEFAULT_PROFILE: 'models:setDefaultProfile',
  MODELS_PICKER: 'models:picker',
  MODELS_CHAT_VIEW: 'models:chatView',
  MODELS_SET_CHAT_PROFILE: 'models:setChatProfile',
  MODELS_SET_MAIN_OVERRIDE: 'models:setMainOverride',
  MODELS_SAVE_CATALOG_SETTINGS: 'models:saveCatalogSettings',
```

In `src/ipc/models-handlers.js`, inside `registerModelsHandlers` after the `MODELS_SET_OLLAMA_URL` handler, add:

```js
  // ---- Profiles and the owner's model choices (stage M2) ----

  const choices = () => {
    const c = typeof context.getModelChoices === 'function' ? context.getModelChoices() : null;
    if (!c) throw new Error('Model profiles are not available in this host.');
    return c;
  };
  const targetFrom = (raw) => (raw && typeof raw === 'object'
    ? { provider: String(raw.provider || ''), model: String(raw.model || ''), effort: typeof raw.effort === 'string' && raw.effort ? raw.effort : null }
    : null);
  const text = (v) => (typeof v === 'string' ? v : '');

  handle(IPC.MODELS_PROFILES, async () => ({ ok: true, ...choices().profilesView() }));

  handle(IPC.MODELS_SAVE_PROFILE, async ({ id, name, roles }) => ({
    ok: true,
    profile: choices().saveProfile({ id: text(id) || null, name, roles })
  }));

  handle(IPC.MODELS_DUPLICATE_PROFILE, async ({ id }) => ({ ok: true, profile: choices().duplicateProfile(text(id)) }));

  handle(IPC.MODELS_REMOVE_PROFILE, async ({ id }) => ({ ok: true, ...(await choices().removeProfile(text(id))) }));

  handle(IPC.MODELS_SET_DEFAULT_PROFILE, async ({ id }) => ({ ok: true, defaultProfileId: choices().setDefaultProfile(text(id)) }));

  handle(IPC.MODELS_PICKER, async ({ needs }) => ({ ok: true, ...choices().pickerView({ needs: needsFrom(needs) }) }));

  handle(IPC.MODELS_CHAT_VIEW, async ({ chatId }) => ({ ok: true, view: choices().chatView(text(chatId)) }));

  handle(IPC.MODELS_SET_CHAT_PROFILE, async ({ chatId, profileId }) => ({
    ok: true,
    chat: await choices().setChatProfile(text(chatId), text(profileId) || null)
  }));

  handle(IPC.MODELS_SET_MAIN_OVERRIDE, async ({ chatId, target }) => ({
    ok: true,
    chat: await choices().setMainOverride(text(chatId), target ? targetFrom(target) : null)
  }));

  // The Models tab's catalog part (spec §11): fetch on or off, the refresh
  // interval, and the owner's overrides ("<provider>:<model>" → partial Entry).
  handle(IPC.MODELS_SAVE_CATALOG_SETTINGS, async ({ fetch, refreshHours, overrides }) => {
    const settings = context.getSettings();
    const models = settings.models || {};
    const catalogSettings = { ...(models.catalog || {}) };
    if (fetch !== undefined) catalogSettings.fetch = fetch === true;
    if (refreshHours !== undefined) {
      const hours = Number(refreshHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { ok: false, error: 'The refresh interval is a whole number of hours from 1 to 720.' };
      catalogSettings.refreshHours = hours;
    }
    let nextOverrides = models.overrides || {};
    if (overrides !== undefined) {
      const valid = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
        && Object.entries(overrides).every(([key, value]) => key.indexOf(':') > 0 && value && typeof value === 'object' && !Array.isArray(value));
      if (!valid) return { ok: false, error: 'Overrides must be an object of "<provider>:<model>" keys, each with an object of catalog fields.' };
      nextOverrides = overrides;
    }
    context.setSettings({ ...settings, models: { ...models, catalog: catalogSettings, overrides: nextOverrides } });
    return { ok: true, catalog: catalog().status() };
  });
```

In `preload.js`, inside `models: { … }` after `setOllamaBaseUrl: …,` add:

```js
      profiles: () => ipcRenderer.invoke('models:profiles'),
      saveProfile: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:saveProfile', payload);
      },
      duplicateProfile: (id) => {
        validateString(id, 'id', { minLength: 1 });
        return ipcRenderer.invoke('models:duplicateProfile', { id });
      },
      removeProfile: (id) => {
        validateString(id, 'id', { minLength: 1 });
        return ipcRenderer.invoke('models:removeProfile', { id });
      },
      setDefaultProfile: (id) => {
        validateString(id, 'id', { minLength: 1 });
        return ipcRenderer.invoke('models:setDefaultProfile', { id });
      },
      picker: (payload = {}) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:picker', payload);
      },
      chatView: (chatId) => {
        validateString(chatId, 'chatId', { minLength: 1 });
        return ipcRenderer.invoke('models:chatView', { chatId });
      },
      setChatProfile: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId', { minLength: 1 });
        return ipcRenderer.invoke('models:setChatProfile', payload);
      },
      setMainOverride: (payload) => {
        validateObject(payload, 'payload');
        validateString(payload.chatId, 'chatId', { minLength: 1 });
        return ipcRenderer.invoke('models:setMainOverride', payload);
      },
      saveCatalogSettings: (payload) => {
        validateObject(payload, 'payload');
        return ipcRenderer.invoke('models:saveCatalogSettings', payload);
      },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/model-choices.test.js tests/models-profiles-ipc.test.js tests/models-ipc.test.js tests/ipc-contract.test.js tests/ipc-constants.test.js tests/desktop-bridge-allowlist.test.js tests/electron-boundary.test.js tests/models-core-profiles.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/models/profile-view.js src/core/model-choices.js src/core/create-core.js src/ipc/constants.js src/ipc/models-handlers.js preload.js tests/model-choices.test.js tests/models-profiles-ipc.test.js
git commit -m "feat(models): profile, header and main-override channels over one model-choices module"
```

---
## Task 10: The API keys and Models settings tabs

**Files:**
- Modify: `index.html` — the settings nav options (`:161-185`); the Providers tab's catalog card (`:225-234`); replace the Inference and Smart Routing tabs (`:295-332`) with a Models tab; delete the "LLM-Powered Routing" section in the Workflows tab (`:877-911`)
- Modify: `renderer.js` — `dom` entries (`:122-124`, `:224-229`, `:267-274`); `renderProviderCard` (`:3778-3962`: active badge, model select, Set Active); `renderSettings` (`:4155-4156`); `loadSettings` (`:6873`); `switchSettingsTab` (`:3421-3434`); the provider click delegation (`:9828-9830`); the `/fast`, `/standard`, `/smart` block in `sendMessage` (`:7407-7433`); delete `renderInferenceTierDetails`, `generateRuleId`, `getProviderKeys`, `renderSmartRoutingRules`, `getSmartRoutingRulesFromState`, `recomputePriorities`, `collectSmartRoutingRules`, `saveSmartRoutingRulesToBackend`, `loadLLMRoutingSettings`, `handleSaveLLMRouting`, `handleSaveProviderModel`, `handleSetActiveProvider` and the listener blocks `if (dom.saveInferenceTierBtn)`, `if (dom.smartRoutingEnabled)`, `if (dom.addRoutingRuleBtn)`, `if (dom.smartRoutingRulesList)`, `if (dom.llmRoutingSaveBtn)`; add the Models tab code after `loadModelsCatalogStatus`
- Modify: `src/ipc/settings-handlers.js:84-86` (`settings:load` returns `modelsSettings`), `styles.css` (append)
- Test: `tests/renderer-models-m2.test.js` (new), `tests/e2e/settings-providers-save.test.js` (remove the Set Active and model dropdown tests: `:81-84`, `:299-351`), `tests/e2e/settings-tabs.test.js:29-32` (expected tab names), `tests/settings-handlers.test.js` (one assertion)

**Interfaces:**
- Consumes: `window.electron.models.{ profiles, saveProfile, duplicateProfile, removeProfile, setDefaultProfile, picker, saveCatalogSettings, refreshCatalog, testAll, status }` (Task 9, M1); the `profileView` shape (Task 9); `settings:load`.
- Produces:
  - Settings nav: `providers` labelled "API keys" (value kept, so existing selectors hold), a new `models` tab; no `inference` or `routing` tab.
  - DOM ids: `models-test-all-btn` (API keys tab), `models-profile-list`, `models-profile-editor`, `models-new-profile-btn`, `models-profiles-status`, `models-catalog-status`, `models-catalog-fetch`, `models-catalog-refresh-hours`, `models-catalog-overrides`, `models-refresh-catalog-btn`, `models-save-catalog-btn`; in the editor `models-profile-name`, `models-profile-save-btn`, `[data-add-role="<role>"]`, `.models-picker-item[data-provider][data-model]`; list buttons `[data-profile-action="edit|duplicate|default|delete"]`.
  - Renderer functions: `loadModelProfiles()`, `renderModelProfileList()`, `openProfileEditor(profile|null)`, `renderProfileEditor()`, `saveProfileDraft()`, `openModelPicker(role, block)`, `renderCatalogSettings()`, `formatModelPrice(cost)`, `formatContext(tokens)`.
  - `settings:load` data gains `modelsSettings: { catalog, overrides }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer-models-m2.test.js`:

```js
// tests/renderer-models-m2.test.js
// Static checks on the renderer for models M2 (spec 2026-09-27 §11): the API
// keys tab holds keys only, the Models tab replaces the Inference and Smart
// Routing tabs, and model-derived text is set as text, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: settings tabs for models M2', () => {
  it('has an API keys tab and a Models tab, and no Inference or Smart Routing tab', () => {
    assert.match(html, /<option value="providers">API keys<\/option>/);
    assert.match(html, /<option value="models">Models<\/option>/);
    assert.doesNotMatch(html, /value="inference"|value="routing"|data-tab="inference"|data-tab="routing"/);
    assert.doesNotMatch(html, /llm-routing|smart-routing|inference-tier/);
    assert.match(html, /data-tab="models"/);
    for (const id of ['models-profile-list', 'models-profile-editor', 'models-new-profile-btn', 'models-catalog-status', 'models-catalog-fetch', 'models-catalog-refresh-hours', 'models-catalog-overrides', 'models-save-catalog-btn', 'models-test-all-btn']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('keeps model choice off the API keys tab', () => {
    const card = block('function renderProviderCard(providerKey, provider)');
    assert.doesNotMatch(card, /set-active|modelProvider|listModels|active-provider-badge/);
    assert.doesNotMatch(src, /setActiveProvider|setProviderModel|saveSmartRouting|saveLlmRouting|renderSmartRoutingRules|renderInferenceTierDetails/);
    assert.doesNotMatch(src, /\['\/fast', '\/standard', '\/smart'\]/);
    assert.doesNotMatch(src, /switch inference tier/);
  });

  it('builds the profile list, editor and picker from the models channels, as text', () => {
    assert.match(block('async function loadModelProfiles()'), /window\.electron\.models\.profiles\(\)/);
    const list = block('function renderModelProfileList()');
    assert.match(list, /migration/);
    const entry = block('function renderRoleEntry(role, entry, index, count)');
    assert.match(entry, /is-unusable/);
    assert.match(entry, /reasons\.join/);
    const picker = block('async function openModelPicker(role, block)');
    assert.match(picker, /window\.electron\.models\.picker\(/);
    for (const fn of [list, entry, picker, block('function renderProfileEditor()')]) {
      assert.doesNotMatch(fn, /innerHTML\s*=\s*(?!'')/, 'model and profile text is never parsed as HTML');
      assert.doesNotMatch(fn, /\bconfirm\(|\balert\(|\bprompt\(/, 'no native dialogs');
    }
    assert.match(block('async function saveProfileDraft()'), /window\.electron\.models\.saveProfile\(/);
  });

  it('saves the catalog settings through their own channel', () => {
    assert.match(src, /window\.electron\.models\.saveCatalogSettings\(/);
  });
});
```

In `tests/settings-handlers.test.js`, in `'settings:load includes the Ollama address'`, change the `getSettings` stub to also return `models: { ollama: { baseUrl: 'http://127.0.0.1:11434' }, catalog: { fetch: false, refreshHours: 12 }, overrides: {} }` and add after the existing assertion:

```js
  assert.deepStrictEqual(result.data.modelsSettings, { catalog: { fetch: false, refreshHours: 12 }, overrides: {} });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/renderer-models-m2.test.js tests/settings-handlers.test.js`
Expected: FAIL — no `API keys` option, the Inference tab still exists, `modelsSettings` undefined.

- [ ] **Step 3: Rework `index.html`**

(a) In the settings nav `<select>`: change `<option value="providers">Providers</option>` to `<option value="providers">API keys</option>`, delete `<option value="inference">Inference</option>` and `<option value="routing">Smart Routing</option>`, and add `<option value="models">Models</option>` after the API keys option.

(b) In the `data-tab="providers"` pane, replace the whole `<section class="template-variables-card" id="models-catalog-card"> … </section>` with:

```html
          <section class="template-variables-card" id="api-keys-card">
            <h3>API keys</h3>
            <p>Keys, Anthropic sign-in and the Ollama address, with each provider's last connection test. Which models King Louie uses is set under Models.</p>
            <div class="provider-actions">
              <button type="button" class="btn" id="models-test-all-btn"><i class="fas fa-plug"></i> Test all</button>
            </div>
          </section>
```

(c) Replace the `<!-- Tab: Inference -->` and `<!-- Tab: Smart Routing -->` panes (both `<div class="settings-tab-content" …>` blocks) with:

```html
        <!-- Tab: Models (spec 2026-09-27 §11) -->
        <div class="settings-tab-content" data-tab="models">
          <section class="template-variables-card" id="models-profiles-card">
            <h3>Profiles</h3>
            <p>A profile assigns models to roles: main answers you, worker runs agents and delegated work, utility does small jobs. King Louie only uses models you place in a role, in the order you list them. A chat or case picks a profile; new chats use the default.</p>
            <div class="provider-actions">
              <button type="button" class="btn btn-primary" id="models-new-profile-btn"><i class="fas fa-plus"></i> New profile</button>
              <span class="provider-message" id="models-profiles-status"></span>
            </div>
            <div class="provider-list" id="models-profile-list"></div>
            <div class="models-profile-editor" id="models-profile-editor" hidden></div>
          </section>

          <section class="template-variables-card" id="models-catalog-card">
            <h3>Model catalog</h3>
            <p>Prices and capabilities for every model come from a catalog bundled with King Louie and refreshed daily from models.dev.</p>
            <div class="provider-message" id="models-catalog-status">Reading the catalog…</div>
            <div class="template-variables-grid">
              <label class="inline-toggle" for="models-catalog-fetch">
                <input id="models-catalog-fetch" type="checkbox">
                <span>Fetch the catalog from the network</span>
              </label>
              <label for="models-catalog-refresh-hours">Refresh every (hours)</label>
              <input id="models-catalog-refresh-hours" class="provider-input" type="number" min="1" max="720">
              <label for="models-catalog-overrides">Overrides (JSON, keys "provider:model")</label>
              <textarea id="models-catalog-overrides" class="provider-input" rows="4" spellcheck="false"></textarea>
            </div>
            <div class="provider-actions">
              <button type="button" class="btn" id="models-refresh-catalog-btn"><i class="fas fa-rotate"></i> Refresh now</button>
              <button type="button" class="btn btn-primary" id="models-save-catalog-btn">Save catalog settings</button>
            </div>
          </section>
        </div>
```

(d) In the Workflows pane delete the whole `<!-- LLM Routing Settings -->` section (from that comment through its closing `</section>`).

- [ ] **Step 4: Remove the tier, routing and per-provider model UI from `renderer.js`**

(a) In `dom`: delete `llmRoutingEnabled`, `llmRoutingCost`, `llmRoutingSpeed`, `llmRoutingQuality`, `llmRoutingSaveBtn`, `llmRoutingStatus`, `inferenceTierSelect`, `saveInferenceTierBtn`, `inferenceTierStatus`, `inferenceTierDetails`, `smartRoutingEnabled`, `smartRoutingRulesList`, `addRoutingRuleBtn`, `smartRoutingStatus`; after `modelsRefreshCatalogBtn: …` add:

```js
  modelsProfileList: document.getElementById('models-profile-list'),
  modelsProfileEditor: document.getElementById('models-profile-editor'),
  modelsNewProfileBtn: document.getElementById('models-new-profile-btn'),
  modelsProfilesStatus: document.getElementById('models-profiles-status'),
  modelsCatalogFetch: document.getElementById('models-catalog-fetch'),
  modelsCatalogRefreshHours: document.getElementById('models-catalog-refresh-hours'),
  modelsCatalogOverrides: document.getElementById('models-catalog-overrides'),
  modelsSaveCatalogBtn: document.getElementById('models-save-catalog-btn'),
```

(b) Delete these functions entirely (each from its `function`/`async function` line to the line before the next top-level declaration): `renderInferenceTierDetails`, `generateRuleId`, `getProviderKeys`, `renderSmartRoutingRules`, `getSmartRoutingRulesFromState`, `recomputePriorities`, `collectSmartRoutingRules`, `saveSmartRoutingRulesToBackend`, `loadLLMRoutingSettings`, `handleSaveLLMRouting`, `handleSaveProviderModel`, `handleSetActiveProvider`. Delete the top-level listener blocks `if (dom.saveInferenceTierBtn) { … }`, `if (dom.smartRoutingEnabled) { … }`, `if (dom.addRoutingRuleBtn) { … }`, `if (dom.smartRoutingRulesList) { … }`, `if (dom.llmRoutingSaveBtn) { … }`.

(c) In `renderProviderCard`: delete the `if (appState.settings.activeProvider === providerKey) { … activeBadge … }` block; delete everything from `const modelLabel = document.createElement('label');` through `controls.appendChild(modelSelect);` (the model select, its async fill and its change listener); delete the `activeBtn` block and `actions.appendChild(activeBtn);`.

(d) In `renderSettings` delete `renderInferenceTierDetails();` and `renderSmartRoutingRules();` and add `renderCatalogSettings();` in their place.

(e) In `loadSettings` replace `loadLLMRoutingSettings().catch(() => {});` with `loadModelProfiles().catch(() => {});`.

(f) In the provider list click delegation delete `if (action === 'set-active') { handleSetActiveProvider(provider); }`.

(g) In `sendMessage` delete the whole `if (['/fast', '/standard', '/smart'].includes(slashCommand?.name)) { … return; }` block, and in the local `/help` text (`helpLines`) delete the three lines for `/fast`, `/standard` and `/smart`.

(h) In `renderChatInfoPopover` delete the three lines `if (typeof renderInferenceTierDetails === 'function') renderInferenceTierDetails();` (the popover's tier controls themselves go in Task 11).

(i) In `switchSettingsTab`, after the `service` branch add:

```js
  // Usability changes with every key test; re-read it whenever the tab opens.
  if (tabName === 'models' && typeof loadModelProfiles === 'function') {
    loadModelProfiles().catch((err) => settingsLog.warn(`loading model profiles failed: ${err.message}`));
  }
```

- [ ] **Step 5: Add the Models tab code to `renderer.js`**

After the `loadModelsCatalogStatus` function add:

```js
/* --- Models tab: profiles and the catalog (spec 2026-09-27 §11) --- */

const MODEL_ROLE_LABELS = {
  main: 'Main: answers you in chats and cases',
  worker: 'Worker: agents and delegated work',
  utility: 'Utility: small jobs such as case orientation and classification',
  vision: 'Vision (optional): reading images and scanned pages',
  imageGeneration: 'Image generation (optional)'
};
const MODEL_ROLE_ORDER = ['main', 'worker', 'utility', 'vision', 'imageGeneration'];
const MODEL_ROLE_NEEDS = { vision: { imageInput: true } };
const modelsTabLog = createLogger('models-tab');
let profileDraft = null;

function formatModelPrice(cost) {
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return 'unpriced';
  return `$${cost.input} in / $${cost.output} out per M`;
}

function formatContext(tokens) {
  if (!Number.isFinite(tokens)) return '';
  return tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M context` : `${Math.round(tokens / 1000)}K context`;
}

function setModelsStatus(text, isError = false) {
  if (!dom.modelsProfilesStatus) return;
  dom.modelsProfilesStatus.textContent = text;
  dom.modelsProfilesStatus.classList.toggle('error', Boolean(isError));
}

async function loadModelProfiles() {
  if (!dom.modelsProfileList || !window.electron?.models?.profiles) return;
  try {
    const result = unwrapIpcResult(await window.electron.models.profiles(), 'Unable to load the model profiles.');
    appState.modelProfiles = { profiles: result.profiles || [], defaultProfileId: result.defaultProfileId || null };
    renderModelProfileList();
  } catch (err) {
    setModelsStatus(err.message, true);
  }
}

function renderModelProfileList() {
  const list = dom.modelsProfileList;
  if (!list) return;
  list.textContent = '';
  const { profiles = [], defaultProfileId = null } = appState.modelProfiles || {};
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = 'No profiles yet. Create one to choose the models King Louie uses.';
    list.appendChild(empty);
    return;
  }
  for (const profile of profiles) {
    const card = document.createElement('div');
    card.className = 'provider-card models-profile-card';
    card.dataset.profileId = profile.id;

    const header = document.createElement('div');
    header.className = 'provider-header';
    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = profile.name;
    header.appendChild(title);
    if (profile.id === defaultProfileId) {
      const badge = document.createElement('span');
      badge.className = 'active-provider-badge';
      badge.textContent = 'Default';
      header.appendChild(badge);
    }
    card.appendChild(header);

    const summary = document.createElement('div');
    summary.className = 'provider-message';
    const mainNames = (profile.roles?.main || []).map((e) => e.name);
    const unusable = Object.values(profile.roles || {}).flat().filter((e) => !e.usable).length;
    summary.textContent = `Main: ${mainNames.length ? mainNames.join(', ') : '(none)'}${unusable ? ` · ${unusable} model${unusable === 1 ? '' : 's'} not usable now` : ''}`;
    card.appendChild(summary);

    // The migration's notes (spec §13): which old model ids were mapped or kept.
    const notes = profile.migration && Array.isArray(profile.migration.notes) ? profile.migration.notes : [];
    if (notes.length) {
      const ul = document.createElement('ul');
      ul.className = 'models-migration-notes';
      for (const note of notes) {
        const li = document.createElement('li');
        li.textContent = note;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'provider-actions';
    const button = (label, action, cls = 'btn') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.dataset.profileAction = action;
      b.dataset.profileId = profile.id;
      return b;
    };
    actions.appendChild(button('Edit', 'edit', 'btn btn-primary'));
    actions.appendChild(button('Duplicate', 'duplicate'));
    if (profile.id !== defaultProfileId) actions.appendChild(button('Make default', 'default'));
    if (profiles.length > 1) actions.appendChild(button('Delete', 'delete', 'btn btn-danger'));
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function openProfileEditor(profile) {
  profileDraft = profile
    ? { id: profile.id, name: profile.name, roles: JSON.parse(JSON.stringify(profile.roles || {})) }
    : { id: null, name: '', roles: { main: [], worker: [], utility: [] } };
  renderProfileEditor();
}

function closeProfileEditor() {
  profileDraft = null;
  if (!dom.modelsProfileEditor) return;
  dom.modelsProfileEditor.hidden = true;
  dom.modelsProfileEditor.textContent = '';
}

function renderProfileEditor() {
  const editor = dom.modelsProfileEditor;
  if (!editor || !profileDraft) return;
  editor.hidden = false;
  editor.textContent = '';

  const heading = document.createElement('h4');
  heading.textContent = profileDraft.id ? `Edit ${profileDraft.name}` : 'New profile';
  editor.appendChild(heading);

  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'models-profile-name';
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.id = 'models-profile-name';
  nameInput.className = 'provider-input';
  nameInput.value = profileDraft.name;
  nameInput.addEventListener('input', () => { profileDraft.name = nameInput.value; });
  editor.appendChild(nameLabel);
  editor.appendChild(nameInput);

  const roles = [...MODEL_ROLE_ORDER, ...Object.keys(profileDraft.roles).filter((r) => !MODEL_ROLE_ORDER.includes(r))];
  for (const role of roles) editor.appendChild(renderRoleBlock(role));

  const actions = document.createElement('div');
  actions.className = 'provider-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary';
  save.id = 'models-profile-save-btn';
  save.textContent = 'Save profile';
  save.addEventListener('click', () => saveProfileDraft());
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeProfileEditor());
  actions.appendChild(save);
  actions.appendChild(cancel);
  editor.appendChild(actions);
}

function renderRoleBlock(role) {
  const block = document.createElement('div');
  block.className = 'models-role-block';
  block.dataset.role = role;
  const title = document.createElement('div');
  title.className = 'chat-info-section-title';
  title.textContent = MODEL_ROLE_LABELS[role] || `Custom role: ${role}`;
  block.appendChild(title);
  const entries = profileDraft.roles[role] || [];
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-message';
    empty.textContent = role === 'main'
      ? 'Empty: chats cannot run until main has a model.'
      : (role === 'worker' || role === 'utility' ? 'Empty: borrows from the next stronger role.' : 'Empty.');
    block.appendChild(empty);
  }
  entries.forEach((entry, index) => block.appendChild(renderRoleEntry(role, entry, index, entries.length)));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn';
  add.textContent = 'Add model';
  add.dataset.addRole = role;
  add.addEventListener('click', () => openModelPicker(role, block));
  block.appendChild(add);
  return block;
}

function renderRoleEntry(role, entry, index, count) {
  const row = document.createElement('div');
  row.className = `models-role-entry${entry.usable === false ? ' is-unusable' : ''}`;
  const label = document.createElement('span');
  label.className = 'models-role-entry-label';
  const facts = [entry.provider, formatModelPrice(entry.cost), formatContext(entry.context)].filter(Boolean).join(' · ');
  label.textContent = `${index + 1}. ${entry.name || entry.model} (${facts})`;
  row.appendChild(label);
  if (entry.usable === false && Array.isArray(entry.reasons) && entry.reasons.length) {
    const why = document.createElement('div');
    why.className = 'provider-message error';
    why.textContent = entry.reasons.join(' ');
    row.appendChild(why);
  }
  if (Array.isArray(entry.efforts) && entry.efforts.length) {
    const effort = document.createElement('select');
    effort.className = 'chat-info-select';
    effort.title = 'Reasoning effort';
    const standard = document.createElement('option');
    standard.value = '';
    standard.textContent = 'Default effort';
    effort.appendChild(standard);
    for (const value of entry.efforts) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      if (entry.effort === value) opt.selected = true;
      effort.appendChild(opt);
    }
    effort.addEventListener('change', () => { entry.effort = effort.value || null; });
    row.appendChild(effort);
  }
  const move = (delta) => {
    const list = profileDraft.roles[role];
    const other = index + delta;
    if (other < 0 || other >= list.length) return;
    [list[index], list[other]] = [list[other], list[index]];
    renderProfileEditor();
  };
  const small = (text, title, fn, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = text;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', fn);
    return b;
  };
  row.appendChild(small('↑', 'Move up', () => move(-1), index === 0));
  row.appendChild(small('↓', 'Move down', () => move(1), index === count - 1));
  row.appendChild(small('Remove', 'Remove from this role', () => { profileDraft.roles[role].splice(index, 1); renderProfileEditor(); }));
  return row;
}

async function openModelPicker(role, block) {
  const open = block.querySelector('.models-picker');
  if (open) { open.remove(); return; }
  const picker = document.createElement('div');
  picker.className = 'models-picker';
  picker.textContent = 'Loading models…';
  block.appendChild(picker);
  try {
    const result = unwrapIpcResult(await window.electron.models.picker({ needs: MODEL_ROLE_NEEDS[role] || {} }), 'Unable to list models.');
    picker.textContent = '';
    const taken = new Set((profileDraft.roles[role] || []).map((e) => `${e.provider}:${e.model}`));
    const usable = (result.usable || []).filter((c) => !taken.has(`${c.provider}:${c.model}`));
    if (!usable.length) {
      const none = document.createElement('div');
      none.className = 'provider-message';
      none.textContent = 'No usable model meets this role\'s needs. Add and test a key under API keys.';
      picker.appendChild(none);
    }
    for (const c of usable) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'models-picker-item';
      item.dataset.provider = c.provider;
      item.dataset.model = c.model;
      item.textContent = `${c.name} (${[c.provider, c.local ? 'local' : formatModelPrice(c.cost), formatContext(c.context)].filter(Boolean).join(' · ')})`;
      item.addEventListener('click', () => {
        profileDraft.roles[role] = [...(profileDraft.roles[role] || []), { provider: c.provider, model: c.model, effort: null, name: c.name, usable: true, reasons: [], cost: c.cost, context: c.context, efforts: [] }];
        renderProfileEditor();
      });
      picker.appendChild(item);
    }
    // Unusable models appear greyed out with their reasons (spec §11).
    for (const c of (result.unusable || []).slice(0, 100)) {
      const row = document.createElement('div');
      row.className = 'models-picker-item is-unusable';
      row.textContent = `${c.name} (${c.provider}): ${(c.reasons || []).join(' ')}`;
      picker.appendChild(row);
    }
  } catch (err) {
    picker.textContent = err.message;
  }
}

async function saveProfileDraft() {
  if (!profileDraft) return;
  const roles = {};
  for (const [role, entries] of Object.entries(profileDraft.roles)) {
    roles[role] = (entries || []).map((e) => ({ provider: e.provider, model: e.model, effort: e.effort || null }));
  }
  try {
    const result = unwrapIpcResult(
      await window.electron.models.saveProfile({ ...(profileDraft.id ? { id: profileDraft.id } : {}), name: profileDraft.name, roles }),
      'Unable to save the profile.'
    );
    setModelsStatus(`Saved ${result.profile.name}.`);
    closeProfileEditor();
    await loadModelProfiles();
  } catch (err) {
    setModelsStatus(err.message, true);
  }
}

function renderCatalogSettings() {
  const models = appState.settings?.modelsSettings || {};
  if (dom.modelsCatalogFetch) dom.modelsCatalogFetch.checked = models.catalog?.fetch !== false;
  if (dom.modelsCatalogRefreshHours) dom.modelsCatalogRefreshHours.value = String(models.catalog?.refreshHours ?? 24);
  if (dom.modelsCatalogOverrides) dom.modelsCatalogOverrides.value = JSON.stringify(models.overrides || {}, null, 2);
}

if (dom.modelsNewProfileBtn) {
  dom.modelsNewProfileBtn.addEventListener('click', () => openProfileEditor(null));
}

if (dom.modelsProfileList) {
  dom.modelsProfileList.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-profile-action]');
    if (!btn) return;
    const id = btn.dataset.profileId;
    const action = btn.dataset.profileAction;
    const profile = (appState.modelProfiles?.profiles || []).find((p) => p.id === id);
    try {
      if (action === 'edit' && profile) openProfileEditor(profile);
      if (action === 'duplicate') {
        const r = unwrapIpcResult(await window.electron.models.duplicateProfile(id), 'Unable to duplicate the profile.');
        setModelsStatus(`Created ${r.profile.name}.`);
        await loadModelProfiles();
      }
      if (action === 'default') {
        unwrapIpcResult(await window.electron.models.setDefaultProfile(id), 'Unable to set the default profile.');
        setModelsStatus(`${profile?.name || 'The profile'} is now the default for new chats.`);
        await loadModelProfiles();
      }
      if (action === 'delete') {
        // No native dialogs: a second click confirms.
        if (btn.dataset.confirming !== 'true') {
          btn.dataset.confirming = 'true';
          btn.textContent = 'Click again to delete';
          return;
        }
        const r = unwrapIpcResult(await window.electron.models.removeProfile(id), 'Unable to delete the profile.');
        const moved = (r.moved?.chats?.length || 0) + (r.moved?.cases?.length || 0);
        setModelsStatus(`Deleted ${profile?.name || 'the profile'}.${moved ? ` ${moved} chat(s) or case(s) now use the default profile.` : ''}`);
        await loadModelProfiles();
      }
    } catch (err) {
      setModelsStatus(err.message, true);
      modelsTabLog.warn(`profile ${action} failed: ${err.message}`);
    }
  });
}

if (dom.modelsSaveCatalogBtn) {
  dom.modelsSaveCatalogBtn.addEventListener('click', async () => {
    let overrides;
    try {
      overrides = JSON.parse(dom.modelsCatalogOverrides?.value || '{}');
    } catch {
      if (dom.modelsCatalogStatus) {
        dom.modelsCatalogStatus.textContent = 'Overrides must be valid JSON.';
        dom.modelsCatalogStatus.classList.add('error');
      }
      return;
    }
    const fetchOn = Boolean(dom.modelsCatalogFetch?.checked);
    const refreshHours = Number(dom.modelsCatalogRefreshHours?.value);
    try {
      const result = unwrapIpcResult(
        await window.electron.models.saveCatalogSettings({ fetch: fetchOn, refreshHours, overrides }),
        'Unable to save the catalog settings.'
      );
      appState.settings.modelsSettings = { catalog: { ...(appState.settings.modelsSettings?.catalog || {}), fetch: fetchOn, refreshHours }, overrides };
      showCatalogStatus(result.catalog);
    } catch (err) {
      if (dom.modelsCatalogStatus) {
        dom.modelsCatalogStatus.textContent = err.message;
        dom.modelsCatalogStatus.classList.add('error');
      }
    }
  });
}
```

- [ ] **Step 6: Return the catalog settings from `settings:load`**

In `src/ipc/settings-handlers.js`, in the `settings:load` return object, after `ollamaBaseUrl: …,` add:

```js
      modelsSettings: {
        catalog: settings.models?.catalog || {},
        overrides: settings.models?.overrides || {}
      },
```

- [ ] **Step 7: Styles**

Append to `styles.css`:

```css
/* Models tab (spec 2026-09-27 §11) */
.models-profile-editor { margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.models-role-block { margin: 12px 0; }
.models-role-entry { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 0; }
.models-role-entry-label { flex: 1 1 240px; }
.models-role-entry.is-unusable .models-role-entry-label,
.models-picker-item.is-unusable { opacity: 0.55; }
.models-picker { max-height: 260px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border); border-radius: 6px; padding: 4px; }
.models-picker-item { display: block; width: 100%; text-align: left; padding: 4px 6px; background: none; border: none; color: inherit; cursor: pointer; }
button.models-picker-item:hover { background: var(--hover, rgba(127, 127, 127, 0.15)); }
div.models-picker-item.is-unusable { cursor: default; }
.models-migration-notes { margin: 6px 0 0 18px; font-size: 0.9em; }
```

- [ ] **Step 8: Update the e2e settings tests**

In `tests/e2e/settings-providers-save.test.js` delete the per-provider test `${provider}: has Set Active button` and the tests `'set active button changes active provider'`, `'set active button is disabled for the active provider'`, `'gemini: model dropdown does not show [object Object]'` and `'groq: model dropdown does not show [object Object]'` with their section comments; in the file's header comment change "Save Token, Test Connection, Clear Token, and Set Active" to "Save Token, Test Connection and Clear Token".

In `tests/e2e/settings-tabs.test.js`, in `'lists all expected tabs'`, replace `'General', 'Provider', 'Inference', 'Profile', 'Voice',` with `'General', 'API keys', 'Models', 'Profile', 'Voice',`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/renderer-models-m2.test.js tests/renderer-models-text.test.js tests/settings-handlers.test.js tests/ipc-contract.test.js`
Expected: PASS, `# fail 0`. Then launch the app (`unset ELECTRON_RUN_AS_NODE && npm start`), open Settings → Models, create a profile, add a model, save, and check the API keys tab has no model dropdowns.

- [ ] **Step 10: Commit**

```bash
git add index.html renderer.js styles.css src/ipc/settings-handlers.js tests/renderer-models-m2.test.js tests/settings-handlers.test.js tests/e2e/settings-providers-save.test.js tests/e2e/settings-tabs.test.js
git commit -m "feat(ui): API keys tab and a Models tab with profiles and the catalog; tier and routing tabs gone"
```

---
## Task 11: The header switcher, Retry with…, and the popover without tiers

**Files:**
- Modify: `index.html:60-66` (the switcher in `.chat-header-actions`)
- Modify: `renderer.js` — loggers (`:14-17`); `appState` defaults (`:40-45`, `:389-390`); `dom` (after `chatInfoBtn`); `getActiveInferenceTier` and `formatInferenceTierLabel` (`:1674-1683`, deleted); `renderChatInfoPopover` (`:2968-2972`, `:3032-3234`); `renderChatMessages` (`:3325-3336` header meta, end of function `:3406`); `persistAgentMode` (`:8040`); `resendUserMessage` (`:7724-7834`, rewritten around a new `resendFromIndex`); the `onMessageError` listener (`:10245-10280`); the `onStatusChanged` listener (`:7035`); add the switcher and Retry code after `addMessage`
- Modify: `styles.css` (append)
- Test: `tests/renderer-models-m2.test.js` (a second `describe`), `tests/renderer-models-text.test.js` (the popover test), `tests/e2e/models-profiles.test.js` (new), `tests/e2e/models-stop.test.js:22-29` (seed a profile), `tests/e2e/inference-tiers.test.js` (deleted)

**Interfaces:**
- Consumes: `window.electron.models.{ chatView, setChatProfile, setMainOverride }` and `ChatModelsView` (Task 9); `chat:messageError`'s `action` (Task 8); `window.electron.chat.truncateFrom`, `addMessage`, `sendMessage`.
- Produces:
  - DOM: `#chat-models-switcher`, `#chat-profile-select` (value `''` = the default profile), `#chat-main-select` (option values: `'__current__'`, `'__none__'`, `'__reset__'`, or a JSON `{ provider, model }`), `#chat-main-override-marker`; on the last reply `#retry-with-btn` and `#retry-with-select`; in an error reply `button.message-error-action`.
  - Renderer functions: `refreshChatModels()`, `renderChatModels(view)`, `applyUpdatedChat(chat)`, `switchMainModel(target|null) → Promise<boolean>`, `renderRetryControl()`, `retryWith(target)`, `resendFromIndex(chatId, msgIndex, { beforeSend })`.
  - Retry with… (spec §9): truncates from the last user message (it and the reply), then sets the main override (its status message lands before the re-sent message), then re-sends the user message; if the switch fails, the user message is put back and nothing is sent.

- [ ] **Step 1: Write the failing tests**

Append to `tests/renderer-models-m2.test.js`:

```js
describe('renderer: the chat header and Retry with…', () => {
  it('has the profile picker and main switcher in the header', () => {
    for (const id of ['chat-models-switcher', 'chat-profile-select', 'chat-main-select', 'chat-main-override-marker']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
  });

  it('fills them from the chat\'s own view, as text', () => {
    assert.match(block('async function refreshChatModels()'), /window\.electron\.models\.chatView\(/);
    const render = block('function renderChatModels(view)');
    assert.match(render, /view\.choices/);
    assert.match(render, /__reset__/);
    assert.doesNotMatch(render, /innerHTML\s*=\s*(?!'')/);
    assert.match(block('async function switchMainModel(target)'), /window\.electron\.models\.setMainOverride\(/);
  });

  it('the popover keeps its cost information and loses its tier, provider and model controls', () => {
    const popover = block('function renderChatInfoPopover()');
    assert.match(popover, /Estimated cost/);
    assert.doesNotMatch(popover, /setInferenceTier|setTierProviderModel|tierSelect|chat-info-provider-select|chat-info-model-select/);
    assert.doesNotMatch(src, /getActiveInferenceTier|formatInferenceTierLabel/);
    assert.doesNotMatch(block('function renderChatMessages()'), /Tier/);
  });

  it('Retry with… truncates, then switches main, then re-sends', () => {
    const resend = block('async function resendFromIndex(chatId, msgIndex, { beforeSend = null } = {})');
    const truncate = resend.indexOf('window.electron.chat.truncateFrom(');
    const before = resend.indexOf('beforeSend()');
    const send = resend.indexOf('window.electron.chat.sendMessage(');
    assert.ok(truncate > 0 && before > truncate && send > before, 'truncate → switch → send');
    assert.match(block('async function retryWith(target)'), /switchMainModel\(target\)/);
    assert.match(block('function renderRetryControl()'), /retry-with-btn/);
  });

  it('an unusable override error offers the profile\'s main in one click', () => {
    const i = src.indexOf('window.electron.chat.onMessageError(');
    const handler = src.slice(i, src.indexOf('\n}));', i));
    assert.match(handler, /use-profile-main/);
    assert.match(handler, /switchMainModel\(null\)/);
    assert.match(handler, /open-models/);
  });
});
```

In `tests/renderer-models-text.test.js` replace the test `'the chat info popover lists usable models, not a hardcoded provider list'` with:

```js
  it('the header\'s main switcher lists usable models from the chat\'s view, not a hardcoded provider list', () => {
    const render = block('function renderChatModels(view)', '\nfunction ');
    assert.doesNotMatch(render, /providerDisplayNames/);
    assert.match(src, /window\.electron\.models\.chatView\(/);
    assert.doesNotMatch(block('function renderChatInfoPopover()', '\nfunction '), /window\.electron\.settings\.listModels\(/);
  });
```

Create `tests/e2e/models-profiles.test.js`:

```js
// tests/e2e/models-profiles.test.js
// Models M2 end to end (spec 2026-09-27 §16): the header shows the chat's
// profile and main model; switching main writes the override, says so in the
// chat, and the next send uses it; a new profile is made in the Models tab;
// Retry with… re-sends the last message on the chosen model. The provider is
// Ollama pointed at a local fake server; KL_TEST_MODE keeps fetches off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const readChat = (ctx) => {
  const data = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));
  return data.chats.find((c) => c.id === 'chat-1');
};

// Polls the profile's chat file from the test process (a status message is
// persisted by the main process; how the renderer draws it is not the point).
async function waitUntil(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fn()) return;
    } catch {
      // the file is being rewritten; read it again
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

describe('E2E: profiles, the main switcher and Retry with…', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    const now = new Date().toISOString();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-1',
          chats: [{ id: 'chat-1', title: 'Test chat', createdAt: now, updatedAt: now, messages: [] }],
          apiStatus: { ollama: { ok: true, message: 'Connected: 2 models.', checkedAt: now, models: ['test-model', 'vision-model'] } },
          settings: {
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              profiles: [{ id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-local'
            }
          }
        }
      }
    });
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('shows the chat\'s profile and main model in the header', async () => {
    await waitFor(ctx, `!document.getElementById('chat-models-switcher').hidden`);
    const text = await waitFor(ctx, `(() => { const s = document.getElementById('chat-main-select'); const t = s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : ''; return t.includes('test-model') ? t : null; })()`);
    assert.match(text, /^Main: test-model/);
    const profile = await evaluate(ctx, `document.getElementById('chat-profile-select').selectedOptions[0].textContent`);
    assert.strictEqual(profile, 'Default profile (Local)');
  });

  it('switching main writes the override, says so, and the next send uses it', async () => {
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-main-select');
      const opt = [...s.options].find((o) => o.value.includes('vision-model'));
      s.value = opt.value;
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-main-override-marker').hidden`);
    await waitUntil(() => readChat(ctx).messages.some((m) => m.sender === 'status' && m.text === 'Main model switched from test-model to vision-model'));
    assert.deepStrictEqual(readChat(ctx).mainOverride, { provider: 'ollama', model: 'vision-model', effort: null });

    const before = server.requests.length;
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Say hello';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('retry-with-btn')`, 30000);
    const chatCalls = server.requests.slice(before).filter((r) => r.provider === 'ollama' && r.method === 'POST');
    assert.ok(chatCalls.length > 0, 'the fake Ollama answered');
    assert.strictEqual(chatCalls[chatCalls.length - 1].body.model, 'vision-model');
  });

  it('Retry with… re-sends the last message on the chosen model', async () => {
    const before = server.requests.length;
    await evaluate(ctx, `document.getElementById('retry-with-btn').click(); true`);
    await waitFor(ctx, `(document.getElementById('retry-with-select')?.options.length || 0) > 1`);
    await evaluate(ctx, `(() => {
      const s = document.getElementById('retry-with-select');
      const opt = [...s.options].find((o) => o.value.includes('"test-model"'));
      s.value = opt.value;
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `(() => { const s = document.getElementById('chat-main-select'); return s && s.options[s.selectedIndex] && s.options[s.selectedIndex].textContent.startsWith('Main: test-model'); })()`, 30000);
    await waitFor(ctx, `!!document.getElementById('retry-with-btn')`, 30000);
    const chat = readChat(ctx);
    assert.strictEqual(chat.messages.filter((m) => m.sender === 'user' && m.text === 'Say hello').length, 1, 'the message was re-sent, not duplicated');
    const chatCalls = server.requests.slice(before).filter((r) => r.provider === 'ollama' && r.method === 'POST');
    assert.strictEqual(chatCalls[chatCalls.length - 1].body.model, 'test-model');
  });

  it('creates a profile in the Models tab', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `(() => { const s = document.getElementById('settings-nav-select'); s.value = 'models'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(ctx, `document.querySelectorAll('#models-profile-list .models-profile-card').length === 1`);
    await evaluate(ctx, `document.getElementById('models-new-profile-btn').click(); true`);
    await evaluate(ctx, `(() => { const i = document.getElementById('models-profile-name'); i.value = 'Second'; i.dispatchEvent(new Event('input')); return true; })()`);
    await evaluate(ctx, `document.querySelector('[data-add-role="main"]').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.models-picker-item[data-model="test-model"]')`);
    await evaluate(ctx, `document.querySelector('.models-picker-item[data-model="test-model"]').click(); true`);
    await evaluate(ctx, `document.getElementById('models-profile-save-btn').click(); true`);
    await waitFor(ctx, `document.querySelectorAll('#models-profile-list .models-profile-card').length === 2`);
    const data = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));
    const second = data.settings.models.profiles.find((p) => p.name === 'Second');
    assert.deepStrictEqual(second.roles.main, [{ provider: 'ollama', model: 'test-model', effort: null }]);
    await evaluate(ctx, `document.getElementById('close-settings-btn').click(); true`);
  });
});
```

In `tests/e2e/models-stop.test.js` replace the seeded settings

```js
          settings: {
            activeProvider: 'ollama',
            providerModels: { ollama: 'test-model' },
            inference: { activeTier: 'standard', tierMap: { standard: { provider: 'ollama', model: 'test-model' } } },
            models: { ollama: { baseUrl: `${server.url}/ollama` } }
          }
```

with

```js
          settings: {
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              profiles: [{ id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-local'
            }
          }
```

Delete `tests/e2e/inference-tiers.test.js` (its tier and popover provider checks are gone with the tiers; the usable-only list is now `tests/e2e/models-profiles.test.js`'s first test).

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `node --test tests/renderer-models-m2.test.js tests/renderer-models-text.test.js`
Expected: FAIL — no `chat-models-switcher`, `renderChatModels` not found, the popover still has `tierSelect`.

- [ ] **Step 3: Add the switcher to `index.html`**

In `.chat-header-actions`, directly before `<button id="chat-info-btn" …>`, add:

```html
          <div class="chat-models-switcher" id="chat-models-switcher" hidden>
            <select id="chat-profile-select" class="chat-info-select" title="Profile for this chat" aria-label="Profile for this chat"></select>
            <select id="chat-main-select" class="chat-info-select" title="Main model for this chat" aria-label="Main model for this chat"></select>
            <span id="chat-main-override-marker" class="chat-main-override-marker" title="The main model is switched for this chat; the profile's other roles still apply" hidden><i class="fas fa-thumbtack"></i></span>
          </div>
```

- [ ] **Step 4: Remove the tier leftovers from `renderer.js`**

(a) Delete the loggers `tierLog`, `providerLog` and `modelPopulateLog` (lines 14, 15, 17).

(b) In both `appState.settings` defaults (the initial state and the reset near line 389) delete `activeProvider: 'openai',` and the `inference: { activeTier: 'standard' }` entry.

(c) Delete the functions `getActiveInferenceTier` and `formatInferenceTierLabel`.

(d) In `renderChatInfoPopover`: delete `const tier = formatInferenceTierLabel(getActiveInferenceTier());`, `const tierMap = …;`, `const activeTierKey = …;` and `const tierInfo = …;`; replace everything from `/* --- Inference controls section --- */` through `loadUsable(tierInfo.provider || '', tierInfo.model || '');` with:

```js
  /* --- Mode section. The model controls live in the chat header now
     (spec 2026-09-27 §11): a profile picker and the main switcher. --- */
  appendRow({ divider: true });
  appendRow({ section: 'Mode' });
```

(e) In `renderChatMessages`: in the `if (!activeChat) { … }` branch change the meta line to `dom.chatHeaderMeta.textContent = 'Start a new conversation';` and add `if (dom.chatModelsSwitcher) dom.chatModelsSwitcher.hidden = true;`; in the active-chat meta line delete `` • Tier: ${formatInferenceTierLabel(getActiveInferenceTier())}``; at the very end of the function (after the final `flushToolGroup();`) add:

```js
  renderRetryControl();
  refreshChatModels();
```

(f) In `persistAgentMode`, after the `setAgentMode` call, add `refreshChatModels();` (agent mode changes what main needs).

(g) In the `window.electron.models.onStatusChanged` listener, after `updateProviderStatusBadge(provider);` add `refreshChatModels();`.

- [ ] **Step 5: Add the switcher, Retry with… and the helpers**

In `dom`, after `chatInfoBtn: …`, add:

```js
  chatModelsSwitcher: document.getElementById('chat-models-switcher'),
  chatProfileSelect: document.getElementById('chat-profile-select'),
  chatMainSelect: document.getElementById('chat-main-select'),
  chatMainOverrideMarker: document.getElementById('chat-main-override-marker'),
```

After the `addMessage` function add:

```js
/* --- The chat's models: profile picker, main switcher, Retry with…
   (spec 2026-09-27 §6.5, §9, §11). Every change is a between-turns choice:
   a running turn keeps the models it launched with. --- */

let chatModelsFetchId = 0;

function applyUpdatedChat(chat) {
  if (!chat || !chat.id) return;
  appState.chats = appState.chats.map((c) => (c.id === chat.id ? chat : c));
  refreshUI();
}

async function refreshChatModels() {
  const chatId = appState.activeChatId;
  if (!dom.chatModelsSwitcher) return;
  if (!chatId || !window.electron?.models?.chatView) {
    dom.chatModelsSwitcher.hidden = true;
    return;
  }
  const fetchId = ++chatModelsFetchId;
  try {
    const result = unwrapIpcResult(await window.electron.models.chatView(chatId), 'Unable to read this chat\'s models.');
    if (fetchId !== chatModelsFetchId || chatId !== appState.activeChatId) return;
    appState.chatModels = result.view;
    renderChatModels(result.view);
  } catch (err) {
    if (fetchId !== chatModelsFetchId) return;
    modelLog.warn(`chat models: ${err.message}`);
    dom.chatModelsSwitcher.hidden = true;
  }
}

function renderChatModels(view) {
  if (!dom.chatModelsSwitcher || !view) return;
  dom.chatModelsSwitcher.hidden = false;

  const profiles = dom.chatProfileSelect;
  profiles.textContent = '';
  const defaultName = (view.profiles.find((p) => p.id === view.defaultProfileId) || {}).name || 'none';
  const standard = document.createElement('option');
  standard.value = '';
  standard.textContent = `Default profile (${defaultName})`;
  profiles.appendChild(standard);
  for (const p of view.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    profiles.appendChild(opt);
  }
  profiles.value = view.chosenProfileId || '';

  const main = dom.chatMainSelect;
  main.textContent = '';
  const current = document.createElement('option');
  if (view.main) {
    current.value = '__current__';
    current.textContent = view.main.usable ? `Main: ${view.main.name}` : `Main: ${view.main.name} (not usable)`;
  } else {
    current.value = '__none__';
    current.textContent = 'Main: none. Add one in Settings → Models';
  }
  main.appendChild(current);
  for (const c of view.choices) {
    if (view.main && c.provider === view.main.provider && c.model === view.main.model) continue;
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ provider: c.provider, model: c.model });
    opt.textContent = c.inMain ? `${c.name} (profile's main)` : `${c.name} (${c.provider})`;
    main.appendChild(opt);
  }
  if (view.overridden) {
    const reset = document.createElement('option');
    reset.value = '__reset__';
    reset.textContent = 'Use the profile\'s main';
    main.appendChild(reset);
  }
  main.value = current.value;
  main.title = view.main && !view.main.usable ? view.main.reasons.join(' ') : 'Main model for this chat';
  dom.chatMainOverrideMarker.hidden = !view.overridden;
}

async function switchMainModel(target) {
  const chatId = appState.activeChatId;
  if (!chatId) return false;
  try {
    const result = unwrapIpcResult(await window.electron.models.setMainOverride({ chatId, target }), 'Unable to switch the main model.');
    applyUpdatedChat(result.chat);
    return true;
  } catch (err) {
    addMessage('assistant', `Error: ${err.message}`);
    return false;
  } finally {
    refreshChatModels();
  }
}

// On the last reply (stopped or not): the usable models, the profile's main
// first. Choosing one sets the main override and re-sends (spec §9).
function renderRetryControl() {
  const chat = getActiveChat();
  if (!chat || appState.activeResponses.has(chat.id) || !window.electron?.models?.chatView) return;
  const messages = chat.messages || [];
  const lastUser = messages.findLastIndex((m) => m.sender === 'user');
  const lastReply = messages.findLastIndex((m) => m.sender === 'assistant');
  if (lastUser < 0 || lastReply < lastUser) return;
  const replies = dom.chatMessages.querySelectorAll('.message.assistant');
  const reply = replies[replies.length - 1];
  if (!reply) return;
  const content = reply.querySelector('.message-content') || reply;
  const wrap = document.createElement('div');
  wrap.className = 'message-retry';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.id = 'retry-with-btn';
  button.appendChild(faIcon('fas fa-rotate-right'));
  button.appendChild(document.createTextNode(' Retry with…'));
  const select = document.createElement('select');
  select.className = 'chat-info-select';
  select.id = 'retry-with-select';
  select.hidden = true;
  button.addEventListener('click', async () => {
    button.hidden = true;
    select.hidden = false;
    select.textContent = '';
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Retry with…';
    select.appendChild(prompt);
    let view = appState.chatModels;
    try {
      view = unwrapIpcResult(await window.electron.models.chatView(chat.id), 'Unable to list models.').view;
    } catch (err) {
      modelLog.warn(`retry list: ${err.message}`);
    }
    for (const c of view?.choices || []) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ provider: c.provider, model: c.model });
      opt.textContent = c.inMain ? `${c.name} (profile's main)` : `${c.name} (${c.provider})`;
      select.appendChild(opt);
    }
  });
  select.addEventListener('change', () => {
    if (select.value) retryWith(JSON.parse(select.value));
  });
  wrap.appendChild(button);
  wrap.appendChild(select);
  content.appendChild(wrap);
}

async function retryWith(target) {
  const chatId = appState.activeChatId;
  const chat = getActiveChat();
  if (!chatId || !chat) return;
  const index = chat.messages.findLastIndex((m) => m.sender === 'user');
  if (index < 0) return;
  await resendFromIndex(chatId, index, { beforeSend: () => switchMainModel(target) });
}

if (dom.chatProfileSelect) {
  dom.chatProfileSelect.addEventListener('change', async () => {
    const chatId = appState.activeChatId;
    if (!chatId) return;
    try {
      const result = unwrapIpcResult(
        await window.electron.models.setChatProfile({ chatId, profileId: dom.chatProfileSelect.value || null }),
        'Unable to change the profile.'
      );
      applyUpdatedChat(result.chat);
    } catch (err) {
      addMessage('assistant', `Error: ${err.message}`);
    } finally {
      refreshChatModels();
    }
  });
}

if (dom.chatMainSelect) {
  dom.chatMainSelect.addEventListener('change', async () => {
    const value = dom.chatMainSelect.value;
    if (value === '__current__' || value === '__none__') return;
    await switchMainModel(value === '__reset__' ? null : JSON.parse(value));
  });
}
```

- [ ] **Step 6: Rewrite `resendUserMessage` around `resendFromIndex`**

Replace the whole `async function resendUserMessage(messageEl) { … }` with:

```js
async function resendUserMessage(messageEl) {
  const chatId = appState.activeChatId;
  if (!chatId) return;
  const chat = appState.chats.find((c) => c.id === chatId);
  if (!chat || !chat.messages.length) return;

  // Find which user message was right-clicked by matching DOM position
  const allMessageEls = Array.from(dom.chatMessages.querySelectorAll('.message'));
  const clickedIndex = allMessageEls.indexOf(messageEl);
  if (clickedIndex === -1) return;

  // Map DOM index back to the corresponding message in appState.
  // The DOM may contain extra elements (tool groups, streaming) so match by
  // walking user+assistant messages in order.
  let domUserIndex = 0;
  for (let i = 0; i < allMessageEls.length; i++) {
    if (allMessageEls[i].classList.contains('user')) {
      if (i === clickedIndex) break;
      domUserIndex++;
    }
  }

  // Find the nth user message in the chat data
  let userCount = 0;
  let msgIndex = -1;
  for (let i = 0; i < chat.messages.length; i++) {
    if (chat.messages[i].sender === 'user') {
      if (userCount === domUserIndex) { msgIndex = i; break; }
      userCount++;
    }
  }
  if (msgIndex === -1) return;
  await resendFromIndex(chatId, msgIndex);
}

// Remove the user message at msgIndex and everything after it with
// chat:truncateFrom, then send it again through the normal flow. When given,
// beforeSend runs in between (Retry with…: the main switch, so its status
// message lands before the re-sent message); if it returns false the user
// message is put back and nothing is sent.
async function resendFromIndex(chatId, msgIndex, { beforeSend = null } = {}) {
  const chat = appState.chats.find((c) => c.id === chatId);
  const userMsg = chat?.messages?.[msgIndex];
  if (!userMsg || userMsg.sender !== 'user') return;
  const message = userMsg.text || '';
  const images = userMsg.images || [];
  const documents = userMsg.documents || [];
  if (!message && images.length === 0 && documents.length === 0) return;

  // Truncate from this message onward (removes the user message + its response)
  try {
    const updatedChat = await window.electron.chat.truncateFrom({ chatId, fromIndex: msgIndex });
    if (updatedChat) {
      appState.chats = appState.chats.map((c) => (c.id === updatedChat.id ? updatedChat : c));
      refreshUI();
    }
  } catch (err) {
    addMessage('assistant', `Error: ${err.message || 'Unable to resend.'}`);
    return;
  }

  if (beforeSend && !(await beforeSend())) {
    try {
      const restored = unwrapIpcResult(await window.electron.chat.addMessage({
        chatId,
        sender: 'user',
        text: message,
        ...(images.length > 0 ? { images } : {}),
        ...(documents.length > 0 ? { documents } : {})
      }), 'Unable to restore the message.');
      applyUpdatedChat(restored);
    } catch (err) {
      chatLog.warn(`restoring the message failed: ${err.message}`);
    }
    return;
  }
  const latest = appState.chats.find((c) => c.id === chatId) || chat;

  // Re-send the message through the normal flow
  // Add user message to local state optimistically
  const now = new Date().toISOString();
  appState.chats = appState.chats.map((c) => {
    if (c.id !== chatId) return c;
    return {
      ...c,
      updatedAt: now,
      messages: [
        ...(c.id === latest.id ? latest.messages : c.messages),
        {
          id: `temp-${Date.now()}`,
          sender: 'user',
          text: message,
          timestamp: now,
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {})
        }
      ]
    };
  });
  refreshUI();

  try {
    setResponseActive(true, chatId);
    const rawResult = await window.electron.chat.sendMessage({
      chatId,
      message,
      images,
      documents,
      agentMode: appState.isAgentModeEnabled,
      sandboxMode: appState.isSandboxModeEnabled
    });
    const updatedChat = unwrapIpcResult(rawResult, 'Unable to send message.');
    if (updatedChat) {
      appState.chats = appState.chats.map((c) => (c.id === updatedChat.id ? updatedChat : c));
    } else {
      try {
        const data = unwrapIpcResult(await window.electron.chat.load(), 'reload');
        appState.chats = data.chats || [];
      } catch (err) { chatLog.warn(`best-effort reload failed: ${err.message}`); }
    }
    refreshUI();
  } catch (error) {
    try {
      const data = unwrapIpcResult(await window.electron.chat.load(), 'reload');
      appState.chats = data.chats || [];
    } catch { /* best-effort reload */ }
    const alreadyShown = dom.chatMessages.querySelector('.message.assistant:last-child .message-content p');
    if (!alreadyShown || !alreadyShown.textContent.startsWith('Error:')) {
      addMessage('assistant', `Error: ${error.message || 'Unable to send message.'}`);
    }
    refreshUI();
  } finally {
    setResponseActive(false, chatId);
    flushToolGroup();
  }
}
```

- [ ] **Step 7: One-click actions on a model error**

In the `window.electron.chat.onMessageError(({ chatId, responseId, error }) => { … })` listener, change the parameter to `({ chatId, responseId, error, action })` and, directly after `messageDiv.appendChild(p);`, add:

```js
  // An unusable main override offers the profile's main in one click; no
  // usable main at all offers the Models tab (spec 2026-09-27 §15).
  if (action && (action.kind === 'use-profile-main' || action.kind === 'open-models')) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'btn btn-sm message-error-action';
    fix.textContent = action.kind === 'use-profile-main' ? 'Use the profile\'s main' : 'Open Models';
    fix.addEventListener('click', async () => {
      if (action.kind === 'use-profile-main') {
        if (await switchMainModel(null)) fix.disabled = true;
      } else {
        openSettingsDrawer();
        switchSettingsTab('models');
      }
    });
    messageDiv.appendChild(fix);
  }
```

- [ ] **Step 8: Styles**

Append to `styles.css`:

```css
/* Chat header model switcher and Retry with… (spec 2026-09-27 §6.5, §9) */
.chat-models-switcher { display: flex; align-items: center; gap: 6px; }
.chat-models-switcher .chat-info-select { max-width: 220px; }
.chat-main-override-marker { color: var(--accent, #d9a441); }
.message-retry { margin-top: 6px; display: flex; gap: 6px; align-items: center; }
.message-error-action { margin-top: 6px; }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/renderer-models-m2.test.js tests/renderer-models-text.test.js`
Expected: PASS, `# fail 0`.

Run: `unset ELECTRON_RUN_AS_NODE && node --test --test-concurrency=1 tests/e2e/models-profiles.test.js tests/e2e/models-stop.test.js tests/e2e/settings-providers-save.test.js tests/e2e/settings-tabs.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add index.html renderer.js styles.css tests/renderer-models-m2.test.js tests/renderer-models-text.test.js tests/e2e/models-profiles.test.js tests/e2e/models-stop.test.js
git rm tests/e2e/inference-tiers.test.js
git commit -m "feat(ui): header profile picker and main switcher, Retry with…, one-click fixes; tiers gone from the popover"
```

---
## Task 12: Remove tiers, smart routing, the LLM router and the provider-model settings

**Files:**
- Delete: `src/providers/llm-router.js`, `src/providers/smart-routing.js`, `src/ipc/settings-provider.js`, `tests/llm-router.test.js`, `tests/smart-routing.test.js`, `tests/inference-router.test.js`, `tests/settings-provider.test.js`
- Modify: `src/providers/inference-router.js` (the tier path), `src/core/create-core.js` (LLM router, `providerDefaults`, `getProviderModel`, `setProviderModel`, `setActiveProvider`, `setActiveInferenceTier`, the old `resolveInference`, `getProviderSnapshot`, `/llm use|model|list`, context entries), `src/core/settings.js` (defaults and merges for `activeProvider`, `providerModels`, `inference`), `src/ipc/settings-handlers.js` (eight channels and the `settings:load` fields), `src/ipc/constants.js:104-109`, `preload.js:561-581`, `src/execution/agent-loop.js:53-56`, `:204-207` (`loopModel`), `src/diagnostics/fixit.js:13-55`, `src/migration/desktop-import.js:22`, `:54-70`, `renderer.js:470-471` (the `/help` lines for `/llm use` and `/llm model`), `CLAUDE.md` (Models section)
- Test: `tests/models-core-profiles.test.js` (one test added), `tests/core-settings.test.js:6-18`, `tests/settings-handlers.test.js` (rewritten parts), `tests/ollama-settings.test.js:14-22`, `:72-95`, `tests/ipc-constants.test.js:56-61`, `tests/core-create.test.js:42`, `tests/fixit.test.js`, `tests/desktop-import.test.js:77`, `:171`, `:213`, `tests/models-default-ids.test.js` (rewritten), `tests/models-migrate.test.js` (one test added)

**Interfaces:**
- Consumes: everything from Tasks 1–11; after this task no code reads a tier, `activeProvider`, `providerModels`, smart routing, the LLM router or `inference.agentLoopModel`, and only `src/models/migrate-tiers.js` names them.
- Produces:
  - `InferenceRouter` holds only the target-list path: constructor options `getProviderToken`, `createProvider`, `prepareProvider`, `policy`/`failover`, `sleep`, `rotateCredential`, `compressContext`, `onProviderError`; methods `newRouteState`, `executeTarget`, `routeTargets`, `routedProvider`.
  - `DEFAULT_SETTINGS` has no `activeProvider`, `providerModels` or `inference`; a fresh store migrates to an empty "Default" profile.
  - `settings:load` no longer returns `activeProvider`, `inference` or a per-provider `model`.
  - `core.context` loses `providerDefaults`, `setActiveInferenceTier`, `resolveInference`, `getLLMRouter`.
  - Fixit's provider check reads the default profile's first main provider.
  - A desktop import no longer copies `activeProvider`, `providerModels` or `inference` (they are `skip-excluded` with a reason).

- [ ] **Step 1: Write the failing tests**

Replace the first two tests of `tests/core-settings.test.js` (`'fills nested defaults without dropping user values'` and `'treats null as empty'`) with:

```js
  it('fills nested defaults without dropping user values', () => {
    const merged = mergeSettings({ checkpoints: { enabled: true } });
    assert.strictEqual(merged.checkpoints.enabled, true);
    assert.strictEqual(merged.checkpoints.maxAgeDays, 14);
    assert.deepStrictEqual(merged.allowedDirectories, []);
  });

  it('treats null as empty', () => {
    assert.deepStrictEqual(mergeSettings(null).models.profiles, []);
  });

  it('has no tier, active-provider or per-provider model defaults (stage M2)', () => {
    for (const key of ['activeProvider', 'providerModels', 'inference']) {
      assert.strictEqual(key in DEFAULT_SETTINGS, false, key);
      assert.strictEqual(key in mergeSettings({}), false, key);
    }
  });
```

In `tests/settings-handlers.test.js`:

- in `createDefaultContext` replace the `settings` object with `{ notifications: { enabled: true }, hooks: { enabled: true }, templateVariables: { name: '' }, models: {} }`, and delete `providerDefaults`, `setActiveInferenceTier` and `applyActiveProviderUpdate` from the returned context;
- in `'registerSettingsHandlers wires expected channels'` delete `'settings:setActiveProvider'`, `'settings:setProviderModel'` and `'settings:setInferenceTier'` from `channels`, and after the `forEach` add:

```js
  for (const gone of ['settings:setActiveProvider', 'settings:setProviderModel', 'settings:setInferenceTier', 'settings:setTierProviderModel', 'settings:listModels', 'settings:saveSmartRouting', 'settings:saveSmartRoutingRules', 'settings:saveLlmRouting']) {
    assert.strictEqual(ipcMain.handlers.has(gone), false, `${gone} is gone with the tiers`);
  }
```

- in `'settings:load returns wrapped payload with provider data'` replace `assert.strictEqual(result.data.activeProvider, 'openai');` with:

```js
  assert.strictEqual('activeProvider' in result.data, false);
  assert.strictEqual('inference' in result.data, false);
  assert.strictEqual('model' in result.data.providers.openai, false);
```

- delete the tests `'settings:setActiveProvider forwards known provider errors'` and `'settings:setInferenceTier wraps thrown errors'`;
- in `'settings:load includes the Ollama address'` drop `activeProvider: 'openai', inference: {}, providerModels: {},` from the `getSettings` stub.

In `tests/ollama-settings.test.js`: in `tokenlessContext` replace `getSettings: () => ({ activeProvider: 'ollama', inference: {}, providerModels: {} }),` with `getSettings: () => ({ models: {} }),` and delete `providerDefaults: { openai: 'gpt-4o-mini', ollama: '' },`; delete the whole `describe('settings:listModels', …)` block (listing a provider's models is Availability's connection test now, `tests/models-availability.test.js`).

In `tests/ipc-constants.test.js` delete `'SETTINGS_SET_ACTIVE_PROVIDER',`, `'SETTINGS_SET_PROVIDER_MODEL',` and `'SETTINGS_SET_INFERENCE_TIER',` from `settingsConstants`, and add a test:

```js
  it('has no tier or active-provider channels (models M2)', () => {
    for (const key of ['SETTINGS_SET_ACTIVE_PROVIDER', 'SETTINGS_SET_PROVIDER_MODEL', 'SETTINGS_SET_INFERENCE_TIER']) {
      assert.strictEqual(IPC[key], undefined, key);
    }
    assert.strictEqual(IPC.MODELS_SET_MAIN_OVERRIDE, 'models:setMainOverride');
  });
```

In `tests/core-create.test.js:42` replace `assert.strictEqual(typeof core.getSettings().activeProvider, 'string');` with `assert.strictEqual(core.getSettings().models.profiles.length, 1, 'a fresh core has its Default profile');`.

In `tests/fixit.test.js` add after `makeStore`:

```js
// The default profile with one main model on `provider` (models M2).
const mainOn = (provider) => ({ models: { profiles: [{ id: 'p-1', name: 'P', roles: { main: [{ provider, model: 'm' }] } }], defaultProfileId: 'p-1' } });
```

and replace every `settings: { activeProvider: 'openai' }` with `settings: mainOn('openai')` and `settings: { activeProvider: 'ollama' }` with `settings: mainOn('ollama')`; rename `'warns when active provider last connection failed'` to `'warns when the main provider\'s last connection failed'`.

In `tests/desktop-import.test.js`:

- `:77` replace `settings: { inference: { activeTier: 'smart' }, voice: { enabled: true }, hooks: { enabled: false } },` with `settings: { inference: { activeTier: 'smart' }, templateVariables: { name: 'Example Owner' }, voice: { enabled: true }, hooks: { enabled: false } },`;
- `:171` replace `assert.strictEqual(actionOf(plan, 'settings', 'inference'), 'new');` with:

```js
    assert.strictEqual(actionOf(plan, 'settings', 'templateVariables'), 'new');
    assert.strictEqual(actionOf(plan, 'settings', 'inference'), 'skip-excluded', 'tiers became profiles; nothing reads them');
```

- `:213` replace `assert.strictEqual(core.context.getSettings().inference.activeTier, 'smart');` with `assert.strictEqual(core.context.getSettings().templateVariables.name, 'Example Owner');`.

Replace `tests/models-default-ids.test.js` with:

```js
// tests/models-default-ids.test.js
// Every model id King Louie ships must resolve in the bundled snapshot
// catalog: each provider's own getDefaultModel(), and the pre-M2 defaults
// the tier migration fills in for a stored setting that left one out. A
// default not in the catalog prices as unpriced and loses its capabilities.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Catalog } = require('../src/models/catalog');
const { KL_PROVIDERS } = require('../src/models');
const { LEGACY_DEFAULTS } = require('../src/models/migrate-tiers');
const ProviderFactory = require('../src/providers/provider-factory');

const catalog = new Catalog().load({});

describe('every shipped default model id resolves in the bundled snapshot', () => {
  it('every provider\'s own getDefaultModel() is in the catalog', () => {
    for (const key of ProviderFactory.listRegistered()) {
      const id = ProviderFactory.create(key, 'test-key-123456').getDefaultModel();
      if (!id) continue; // Ollama's default is empty: no local server to assume.
      assert.ok(catalog.get(key, id), `${key}.getDefaultModel() = "${id}" is not in the bundled snapshot`);
    }
    assert.ok(KL_PROVIDERS.length >= ProviderFactory.listRegistered().length, 'sanity: KL_PROVIDERS covers every registered provider');
  });

  it('the migration\'s pre-M2 defaults are in the catalog', () => {
    for (const [provider, id] of Object.entries(LEGACY_DEFAULTS.providerModels)) {
      if (!id) continue;
      assert.ok(catalog.get(provider, id), `LEGACY_DEFAULTS.providerModels.${provider} = "${id}" is not in the bundled snapshot`);
    }
    for (const [tier, cfg] of Object.entries(LEGACY_DEFAULTS.tierMap)) {
      assert.ok(catalog.get(cfg.provider, cfg.model), `LEGACY_DEFAULTS.tierMap.${tier} = "${cfg.provider}:${cfg.model}" is not in the bundled snapshot`);
    }
  });
});
```

Append to `tests/models-core-profiles.test.js`, inside `describe('the tier migration at core construction', …)`:

```js
  it('removes the old tier keys from the stored settings once the profile is written', () => {
    const { store } = makeCore({ settings: { ...legacySettings(), advisor: { enabled: true, model: 'gpt-4o' } } });
    const raw = store.get('settings');
    for (const key of ['activeProvider', 'providerModels', 'inference']) assert.strictEqual(key in raw, false, key);
    assert.deepStrictEqual(raw.advisor, { enabled: true });
    assert.strictEqual(raw.models.profiles.length, 1);
  });
```

Append to `tests/models-migrate.test.js`, inside `describe('runTierMigration', …)`:

```js
  it('a fresh install after stage M2 (defaults carry no tier keys) gets the Default profile', () => {
    const { DEFAULT_SETTINGS } = require('../src/core/settings');
    const store = memoryStore(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const r = runTierMigration({ ...store, ...opts() });
    assert.deepStrictEqual([r.migrated, r.fresh, r.profile.name], [true, true, 'Default']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/core-settings.test.js tests/settings-handlers.test.js tests/ipc-constants.test.js tests/fixit.test.js tests/desktop-import.test.js tests/models-default-ids.test.js tests/models-migrate.test.js tests/models-core-profiles.test.js`
Expected: FAIL — the defaults still carry `activeProvider`, the tier channels are still registered, the fresh-install migration sees `activeProvider` in `DEFAULT_SETTINGS` and migrates legacy defaults, fixit still reads `activeProvider`, desktop import still copies `inference`.

- [ ] **Step 3: Delete the router and routing modules and their tests**

```bash
git rm src/providers/llm-router.js src/providers/smart-routing.js src/ipc/settings-provider.js tests/llm-router.test.js tests/smart-routing.test.js tests/inference-router.test.js tests/settings-provider.test.js
```

(`tests/inference-router-targets.test.js` from Task 4 covers the router that remains, auth reporting included.)

- [ ] **Step 4: Strip the tier path from `InferenceRouter`**

In `src/providers/inference-router.js`: delete `const { evaluateRules } = require('./smart-routing');`; in the constructor delete `this.getSettings = …`, `this.getProviderModel = …` and the `this.fallbacks = { … }` block; delete the methods `getTierConfig`, `execute`, `_nextFallback`, `routeWithFallback`, `resolve`, `setLLMRouter`, `resolveLLMRouting`, `resolveWithSmartRouting`. Add at the top of the file:

```js
// src/providers/inference-router.js
// Calls a resolved list of models (spec 2026-09-27 §6.7). The resolver
// (src/models/resolver.js) decides which models a role may use; this walks
// the list, recovering from each failure as FailoverPolicy says — retry the
// same target, rotate a credential, compress the context, or fail over to
// the next target: any provider before the first answer, only the same
// provider after it. Tiers, smart routing and the LLM router are gone (§13).
```

- [ ] **Step 5: Strip the core**

In `src/core/create-core.js`:

(a) Delete `const LLMRouter = require('../providers/llm-router');`, `let llmRouter;`, the `// Initialize LLM-powered router …` block (`llmRouter = new LLMRouter({ … }); inferenceRouter.setLLMRouter(llmRouter);`) and the context entry `getLLMRouter: () => llmRouter,`.

(b) Delete `const providerDefaults = { … };`, `getProviderModel`, `setProviderModel`, `setActiveProvider` and `setActiveInferenceTier`; delete `providerDefaults,` and `setActiveInferenceTier,` from the context.

(b2) In the `runTierMigration({ … })` call delete the comment `// The old keys stay while code still reads them; they go with the tier code.` and `removeLegacy: false,`: nothing reads the old keys any more, so the migration now removes them (§13 step 6).

(c) In `new InferenceRouter({ … })` delete `getSettings,` and `getProviderModel,`.

(d) Delete `const _originalResolve = …;`, `const _originalResolveWithSmart = …;` and the whole `const resolveInference = async (selection = {}) => { … };` (keep `ensureOAuthToken`, which `resolveRole` uses, and change its comment `// Wrap resolveInference to handle async OAuth token refresh` to `// An Anthropic OAuth instance needs a fresh access token before its first call.`); delete `resolveInference,` from the context.

(e) In `getProviderSnapshot` delete `model: settings.providerModels?.[key] || providerDefaults[key] || ''` from each provider entry (and the trailing comma before it), and `activeProvider: …` and `inference: settings.inference` from the returned object; drop the now-unused `const settings = getSettings();` there.

(f) In `runLlmCommand`: delete the help lines for `/llm use <provider>` and `/llm model <provider> <model>` (and in `renderer.js`'s local `/help` text replace the same two lines with ``'- `/llm profile [name]` — list model profiles, or make one the default',``); delete the `if (['use', 'active'].includes(action)) { … }` and `if (action === 'model') { … }` blocks; in the `list` action delete `const active = snapshot.activeProvider === key;`, the `+ (active ? ' (active)' : '')` suffix and the `` `model: \`${provider.model || '(default)'}\`` `` part.

- [ ] **Step 6: Strip the settings**

In `src/core/settings.js`: delete `activeProvider: 'openai',`, the `providerModels: { … }` block and the `inference: { … }` block from `DEFAULT_SETTINGS`; delete the `providerModels: { … }` and `inference: { … }` entries from `mergeSettings`; change the comment above `models:` to `// Model catalog, availability and profiles (spec 2026-09-27 §14).`

In `src/ipc/settings-handlers.js`: delete `const { applyActiveProviderUpdate } = require('./settings-provider');`, `providerDefaults,` and `setActiveInferenceTier,` from the destructure, and `const applyActiveProvider = …;`; in `settings:load` delete `model: settings.providerModels?.[key] || providerDefaults[key] || ''` (and the preceding comma), `activeProvider: …` and `inference: settings.inference,`; delete the handlers `settings:setActiveProvider`, `settings:setProviderModel`, `settings:setInferenceTier`, `settings:listModels`, `settings:setTierProviderModel`, `settings:saveSmartRouting`, `settings:saveSmartRoutingRules`, `settings:saveLlmRouting`.

In `src/ipc/constants.js` delete `SETTINGS_SET_ACTIVE_PROVIDER`, `SETTINGS_SET_PROVIDER_MODEL` and `SETTINGS_SET_INFERENCE_TIER`.

In `preload.js`, in `settings: { … }` delete `saveSmartRouting`, `saveSmartRoutingRules`, `saveLlmRouting`, `setActiveProvider`, `setProviderModel`, `setInferenceTier`, `listModels`, `setTierProviderModel`.

- [ ] **Step 7: Remove the loop-model switch**

In `src/execution/agent-loop.js` delete the `// Model tiering: …` comment and `this.loopModel = options.loopModel || null;`, and replace

```js
      // After the first iteration, switch to the cheaper loop model
      const baseOptions = (iterations > 1 && this.loopModel)
        ? { ...options, model: this.loopModel }
        : options;
```

with

```js
      const baseOptions = options;
```

- [ ] **Step 8: Fixit and desktop import**

In `src/diagnostics/fixit.js`, in `checkProvider`, replace

```js
  const settings = store.get('settings', {});
  const activeProvider = settings.activeProvider;
```

with

```js
  // The default profile's first main provider (models spec 2026-09-27 §6).
  const settings = store.get('settings', {});
  const models = settings.models || {};
  const profiles = Array.isArray(models.profiles) ? models.profiles : [];
  const profile = profiles.find((p) => p && p.id === models.defaultProfileId) || profiles[0] || null;
  const activeProvider = profile?.roles?.main?.[0]?.provider || null;
```

and change every `Settings → Providers` in the file's `fix` texts to `Settings → API keys`.

In `src/migration/desktop-import.js`: in `IMPORTED_SETTINGS_KEYS` delete `'activeProvider'`, `'providerModels'` and `'inference'`; add to `EXCLUDED`:

```js
  'settings.activeProvider': 'model choice moved to profiles; set the models up under Settings → Models on the service',
  'settings.providerModels': 'model choice moved to profiles; set the models up under Settings → Models on the service',
  'settings.inference': 'tiers became profiles; set the models up under Settings → Models on the service',
```

- [ ] **Step 9: CLAUDE.md**

In `CLAUDE.md`, in the `## Models` section, change "stage M1" to "stages M1 and M2" and append:

```markdown
- Model choice is profiles (`settings.models.profiles`, stage M2): named sets
  of models per role (main, worker, utility, vision, imageGeneration, custom).
  Tiers, `activeProvider`, `providerModels`, smart routing and the LLM router
  are gone; `src/models/migrate-tiers.js` reads them once at start. Every
  model call resolves through a `TurnModels` (`core.context.snapshotModels` /
  `resolveRole`) and fails over along the resolved list
  (`InferenceRouter#routeTargets`); a loop on a routed provider gets
  `failoverPolicy: NO_RETRY`.
- Tests configure models with `tests/helpers/profile-settings.js`
  (`profileSettings`, `everyRole`, `withCaseProfile`). A provider a test
  registers outside the 14 is usable when it has a saved token.
```

- [ ] **Step 10: Check nothing still names the old model controls**

Run: `git grep -nE "tierMap|activeTier|activeProvider|providerModels|smartRouting|llmRouting|agentLoopModel|loopModel|resolveInference|getTierConfig|routeWithFallback|setInferenceTier|setTierProviderModel|setActiveProvider|setProviderModel|settings:listModels|llm-router|smart-routing" -- src main.js preload.js renderer.js index.html bin`
Expected: matches only in `src/models/migrate-tiers.js` (the migration reads the old keys), `src/diagnostics/fixit.js` (the local variable `activeProvider`), `src/migration/desktop-import.js` (the three `EXCLUDED` reasons), and `src/cases/ingest/call-model.js` with the one `resolveInference:` argument `create-core.js` passes to it (the parameter keeps its name; `resolveRole` feeds it). Anything else is a leftover to remove.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `node --test tests/core-settings.test.js tests/settings-handlers.test.js tests/ollama-settings.test.js tests/ipc-constants.test.js tests/ipc-contract.test.js tests/core-create.test.js tests/fixit.test.js tests/desktop-import.test.js tests/desktop-import-source.test.js tests/models-default-ids.test.js tests/models-migrate.test.js tests/models-capabilities.test.js tests/inference-router-targets.test.js tests/agent-loop.test.js tests/models-core-profiles.test.js tests/models-headless.test.js tests/chat-profiles.test.js tests/electron-boundary.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 12: Commit**

```bash
git add -A src preload.js CLAUDE.md tests
git commit -m "refactor(models): remove tiers, smart routing, the LLM router and per-provider model settings"
```

---

## Stage end (controller)

- [ ] Run `npm test` and confirm `# fail 0`.
- [ ] Run `unset ELECTRON_RUN_AS_NODE && npm run test:e2e` and confirm `# fail 0`.
- [ ] Start the app on a copy of a pre-M2 profile (`--user-data-dir=<temp copy>`): Settings → Models shows one "Migrated settings" profile with its notes; a chat answers on the migrated main; switching main in the header adds the status message; Stop then Retry with… re-sends on the chosen model.

# Settings redesign

Date: 2026-11-09. Owner: Seth. Mockups (approved one by one in a brainstorming
session): navigation, Models page, Providers & keys with the model picker, Node &
connection, shared rules (Voice before/after). Screenshots of every current page,
taken on the owner's real profile, informed the findings in section 2.

## 1. Why

The owner calls the settings screen "scary". The evening this was written,
it cost him real time. He was finishing the move to his personal node, opened
Settings in the old standalone window, set his models to OpenRouter, and the
choices went into the desktop's old profile instead of the node, which went on
failing. Nothing on screen said which machine he was editing. On the way there
he also hit:

- the dropdown saying "General" while the API keys page was showing;
- a Models page whose padding and type sizes change from section to section;
- no way to tell which provider a model runs through (OpenRouter's DeepSeek and
  DeepSeek direct look the same);
- provider keys that are invalid placeholders looking the same as working ones;
- empty `worker`/`utility` roles that nothing warned about, though case wake-ups
  need utility.

Success: the owner can open Settings, see at once which machine he is editing,
find a setting without hunting, and trust that what he sees is current and
applies to him.

## 2. What is wrong today (found, not guessed)

Bugs:

1. **Opens on the wrong page.** `index.html` gives the `providers` pane the
   `active` class while the `<select>` shows its first option (`general`);
   `openSettingsDrawer()` (`renderer.js`) never calls `switchSettingsTab()`. The
   renderer also sorts the options A–Z at runtime, so nothing matches.
2. **The dropdown has no arrow.** Its arrow is a `data:image/svg+xml` URI that the
   page's CSP (`default-src 'self'`, no `img-src`) blocks; it is the one console
   error on opening Settings.
3. **Workflows' "Goal" box has no border or background.**
4. **Commands lists `/fast`, `/standard`, `/smart`**, which went away with tiers
   (models M2).
5. **Models, profile card** shows the migration notes from the profile's creation
   ("mapped to claude-sonnet-5", "smart routing was removed") long after the owner
   changed the profile.
6. **Models, King Louie's proposal** says "Main — Now: (none)" while main is set.
7. **Local service** shows "Pairing request" and "Run as an administrator"
   headings with nothing under them and a Copy button with nothing to copy.
8. **Profile** asks name and role twice ("Prompt template variables" and "User
   profile (TELOS)"); the owner's real profile holds "TestUser" / "Developer" in
   the first.

Across pages: three button looks (with icons, plain, miniature) and many names
for one action (Save Token, Save Key, Save Variables, Save Notification
Settings); help text in grey, blue (Channels), orange (Commands) and red (custom
roles); sub-headings larger than page titles (System Apps, Workflows, History,
Local service); every number a full-width text box, intervals in milliseconds;
fields shown that do not apply (ElevenLabs fields with System TTS); lists as tall
cards with full-size buttons (Memory: 34 notes over 8 screens; API keys: 15
providers × 3 buttons over 6 screens); 23 pages in an unsorted-by-purpose A–Z
dropdown, several of which are not settings.

## 3. Goals, non-goals, anti-goals

Goals:

- One navigation: a grouped sidebar with search, whose highlight always matches
  the page shown.
- Every page says which machine it edits.
- The Models and Providers & keys pages show what is used, through which
  provider, and whether it works.
- One look across all pages: the shared rules in section 6.
- Pages that are not settings leave Settings.

Non-goals:

- No change to what any setting means, where it is stored, or which IPC channel
  writes it. This is the window, not the core. (Exceptions: section 7.)
- No change to the attached/standalone rules, the proxied channel lists, or which
  pages a host may show (`unavailableTabsFor`).
- No new settings.
- The phone apps are untouched.
- Mesh networking itself is not removed; only its page leaves Settings.

Anti-goals (a failure even if it works):

- A page that looks tidy but hides that a role is empty or a key is failing.
- Auto-save that saves a half-typed value somewhere that acts on it (a key, a
  channel token, a webhook URL).
- Any setting that could be changed before and cannot be changed after, except
  the removed pages listed in 5.3.
- Renaming a setting so that docs, the install guide or `docs/driving-king-louie.md`
  no longer match, without updating them.

## 4. Constraints

- `src/` stays Electron-free; this work is in `index.html`, `renderer.js`,
  `styles.css` and, where noted, small IPC additions under `src/ipc/`.
- Attach stage 3: one window holds one tab per node, each tab a separate renderer
  running the same `index.html`, which does not know tabs exist. So "which
  machine" comes from what the renderer is attached to (`desktop:status`), never
  from the window.
- Pages a host does not offer stay hidden exactly as today: attached to a fleet
  node `ATTACHED_UNAVAILABLE_TABS`, attached to a personal node
  `PERSONAL_UNAVAILABLE_TABS` (`src/desktop-bridge/allowlist.js`). The sidebar
  hides those items; a group left empty is hidden too.
- The CSP stays as strict as it is. Icons come from Font Awesome (already
  bundled), CSS, or files under the app, never `data:` URIs.
- Every string from a node or a key test reaches the page through `textContent`,
  as today.
- About 20 e2e suites (`tests/e2e/settings-*.test.js`, `models-*.test.js`,
  `mesh-ui.test.js`, `attached-mode.test.js`, `local-private.test.js`, …) open
  pages through `#settings-nav-select` and `data-tab`. Keep each page's `data-tab`
  id stable and give the tests one helper to open a page by id.

## 5. Decisions (owner's)

### 5.1 Navigation

Settings opens in a wider window: a left sidebar listing every page in groups,
always visible, with a search box at its top that filters pages and settings by
name. The groups and their pages, in this order:

- **Models:** Model profiles, Providers & keys, Local servers
- **Chats:** New chats, About you, History & recall, Voice
- **Reaching you:** Notifications, Contact ladder, Telegram & Discord
- **Tools:** MCP servers, Skills, Permissions & hooks, Scheduled jobs, Webhooks,
  Apps on this computer
- **Security:** Vault
- **This computer:** Node & connection, Diagnostics

Settings reopens on the page last shown. The sidebar highlight and the page are
set by one function, so they cannot disagree (bug 1).

### 5.2 Which machine you are editing

A banner at the top of every settings page:

- Green when attached: "Editing King Louie Node on <computer>", with "(running as
  you)" for a personal node.
- Amber when the window runs on its own: "Editing this desktop only, not your
  node". (Standalone is going away; this mode exists while it does.)

### 5.3 Leaving Settings

- **Commands:** removed; `/help` in chat is the reference.
- **Workflows:** removed; Plan & Execute is the button beside Send.
- **Mesh Network:** removed from Settings (owner, 2026-11-09).
- **Memory:** moves out of Settings to a panel reached from the chat sidebar,
  with search and delete (where exactly: section 8).

Merged: the two name-and-role pages become **About you**; Permissions and Hooks
become one page; the search and image-generation keys join **Providers & keys**.

### 5.4 Model profiles

Each profile is a card listing every role in order (Main: answers you; Worker:
agents and tasks; Utility: titles and small jobs; Vision and Image generation,
optional). Each role shows its models as a row in failover order; every model
shows the provider it runs through (the profile entry's provider: OpenRouter,
OpenAI, a local server by name, …), and "free" where the catalog price is zero.

An empty required role shows an amber warning on the card saying what stops
working, with a link that opens that role for editing. An empty optional role
says what happens instead.

King Louie's suggestion is one line on the page with the estimated monthly
difference and **Review**; its detail opens on Review. Migration notes are not
shown on the card. The model catalog, custom roles and the suggestion-tuning
numbers sit under a collapsed **Advanced** section at the bottom of the page.

### 5.5 Providers & keys

Two lists: model providers, then search & images. One row per provider: name,
status (**Working**, **Failing**, **No key**), the reason (the model count and
when it was tested, or the provider's error in plain words), and one button:
**Edit** where a key exists, **Add** where none does (owner). The button opens
the row in place: the key field, **Save & test** (saving always tests) and
**Remove key**. **Test all** at the top. While any key fails, a banner says how
many and that their providers' models are skipped until the key is fixed or
removed.

A key that looks like a placeholder is said to (owner approved the mockup's
"the key looks like a placeholder"). See 7.2.

### 5.6 Choosing a model

Picking a model for a role opens a searchable list grouped by provider, each
group headed by its key's status. Every model shows its price. A provider whose
key fails is greyed out with "fix key to use"; local servers are a group.

### 5.7 Node & connection

Attached: "Connected to King Louie Node", then computer, runs as (and that it
starts at logon, for a personal node), version, data folder, phones paired;
**Restart node**, **Open data folder**; a line saying everything in Settings is
saved on the node and closing the window does not stop it; unpair, detach and
pairing details under a collapsed **Advanced**.

Standalone: why the window is on its own, that the node is not connected to it,
that changes stay in this desktop's old profile, and one main action, **Switch to
my node**.

### 5.8 Shared rules (every page)

1. Changes save as they are made; the page shows "Saved". No per-section Save
   buttons. Keys and tokens are the exception: they save through Save & test (or
   the page's own explicit save) so a half-typed secret is never stored.
2. On/off is a switch on the right of its label. Settings that depend on a switch
   are greyed out until it is on.
3. Numbers get small fields with their unit (×, s, min, h). Nothing in
   milliseconds; the stored value keeps its unit.
4. Only what applies: ElevenLabs fields only when ElevenLabs is chosen; the voice
   is picked from the voices this computer has (see 7.3).
5. One button look: one primary action per area, plain buttons for the rest, red
   only for what cannot be undone, which asks first.
6. One type scale (page title, section label, row text, help text) and one help
   colour.
7. Lists are compact rows with their actions on the row: vault entries, memory
   notes, scheduled jobs, MCP servers, skills, webhooks, providers.
8. Plain words, not internal names ("This computer's voice", not "System TTS";
   "Scheduled jobs", not "Cron Scheduler").

The eight bugs in section 2 are fixed as part of this.

## 6. Pages not mocked up

Every other page follows 5.8 and keeps its content. New chats (General), History
& recall, Voice, Notifications, Contact ladder, Telegram & Discord (Channels),
MCP servers, Skills, Permissions & hooks, Scheduled jobs, Webhooks, Apps on this
computer, Vault, Diagnostics and Local servers get the same treatment as Voice in
the shared-rules mockup.

## 7. New logic (small)

7.1 **Auto-save.** Each page's existing save call runs when a value changes
(debounced for text). A save that fails puts the field back to the stored value
and shows the error beside it. Anything today's page asks to confirm first still
asks (for example History's "Allow sending to typesafe.ai", private marks, local
server add/remove).

7.2 **Placeholder keys.** A hint only, never a block. The rule is the builder's:
it must be cheap, local, and say why it flagged a key.

7.3 **System voices.** The Voice page lists the voices the chosen engine can use
on this computer.

## 8. Calls made while writing this up (mine, not the owner's)

The builder check raised these; each follows from the owner's intent above. The
owner may overrule any of them.

8.1 **About you, two stores.** Today's Profile page writes two stores: the prompt
template variables (name, role, preferences, project context) and the TELOS
profile (name, role, goals, preferences as JSON, project context). Neither store
changes. About you shows one Name, one Role and one Project context field, each
writing both stores; where they disagree it shows the TELOS value (the one
`/profile` and standing context use), and the first save writes it to both. So
the owner's "TestUser"/"Developer" template values are replaced the first time
he saves. Preferences stays two fields with plain labels ("How you like replies"
for the template text, "Goals and preferences" for TELOS), since one is free text
and the other JSON.

8.2 **Node & connection covers every state the Local service pane covers
today** (`describeServicePane`, `src/desktop-bridge/pane-model.js`): paired
but not attached, pairing in progress (including Restart and pair), starting,
disconnected, no logon task (Install…), restart due. Each keeps today's actions,
laid out like the "connected" mockup. **Import…** (the move from the old profile)
becomes a "Move from this desktop's old profile" card, shown while the move is
not marked. The approvals and relay lines become a "Phones & approvals" section.
A remote node's tab (attach stage 3) shows that node's computer and version and
leaves out what does not apply (restart, data folder, runs as, unpair, detach).

The banner has a third state: grey when attached but the node cannot be reached,
"Can't reach <node>: changes won't be saved until it's back". Fields are
read-only meanwhile. A green banner over saves that cannot land is the failure
this redesign exists to prevent.

8.3 **"Switch to my node"** follows the launch rule (`resolveLaunchMode`):

- `--kl-standalone-once` (the owner's case): relaunch without the flag, which
  attaches, or opens the setup view if the move still needs finishing.
- Paired but not attached: attach.
- Never paired, on Windows: open the setup view.
- `--kl-standalone` (development): no button; the banner says "Development
  standalone".
- Off Windows: no button, since no personal node exists there yet.

8.4 **Voices.** On a standalone window or a personal node (the same computer),
the Voice page lists this computer's voices. On a fleet or remote node it keeps
today's free-text voice name, since the node's voices cannot be listed without a
new proxied call. Test stays as available as it is today.

8.5 **Search and image keys** get a fourth status, **Not tested**, and a Test
button per row; nothing tests on page open (some tests cost money). A test
result is shown until the page closes, not stored. The failing-keys banner
counts model providers only, since only their models are skipped.

## 9. Left to the builder

- Settings window size and whether it stays a modal or becomes a full-window view.
- Where the Memory panel opens from in the chat sidebar.
- The order of work and how to split it into reviewable changes.
- Whether the old dropdown is removed at once or kept until every test moves.
- How search finds a setting (labels only, or labels and help text).

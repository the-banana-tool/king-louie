# Fleet Stage 6: Reference runbooks, configs and the install guide — Design Spec

- **Status:** Draft (fix round 1: review findings accepted as R20)
- **Date:** 2026-09-23
- **Parent:** `docs/superpowers/specs/2026-09-21-king-louie-fleet-design.md` §1, §4.3, §5.2, §5.4, §5.6, §8.4, §11, §12 (row 6), §13
- **Program:** `docs/superpowers/specs/2026-09-23-stage-program.md`. This spec is F6. It owns R11 (a strict `loadNodeConfig` with `NODE_YAML_KEYS`) and carries R12, R13 and R20. It consumes §4.12 and §4.17 only in the wave-4 guide sections.
- **Depends on:** F2 (merged) for everything here. The guide's stage 3–5 sections and the phone path of the e2e test wait for F3/F4/F5 (program §2.1: this spec is wave 1, and the guide sections are wave 4).

## 1. Outcome

An owner can set up a node from `examples/` and one guide, `docs/install-guide.md`,
without reading source. That covers `gpu-box`, `laptop`, `mac` and `web-01`. The owner:

- installs the service;
- writes the admin-owned config dirs;
- grants the exact privileges each runbook needs (sudoers or Windows ACLs);
- checks it all with `doctor`;
- drives the node's runbooks from Claude Code or Claude Desktop over the local stdio MCP server.

A typo in `node.yaml` stops the node from loading, and the error names the key. Before
this stage the typo was silently ignored. Every example is loaded by the real loaders in
`npm test`, and every example runbook runs end to end on every OS with its commands
faked. An example that drifts from the engine fails CI rather than failing on the
owner's machine.

## 2. Scope

### 2.1 In

- `examples/` tree (§3.1): `node.yaml` + `service.json` for four roles; a `frontdoor`
  placeholder; six runbooks; one sudoers file; one Windows ACL script; MCP client
  configs; a training stub.
- R11: `loadNodeConfig` rejects unknown keys, and `NODE_YAML_KEYS` is exported from
  `src/service/node-config.js` (§3.4). README "Breaking Changes" entry.
- `src/service/doctor-runbooks.js` (§3.5). Parent §5.4 says `doctor` checks the sudoers
  entries, and F2 did not build that check.
- `docs/install-guide.md` (§3.6), with the stage 3–5 headings reserved.
- Tests (§10), README subsection, CLAUDE.md section, and `!examples/**` in
  `package.json` `build.files`.

### 2.2 Out

| Item | Owner |
|---|---|
| Phone approval of `site.pull_and_restart` / `server.reboot` | F3 |
| Guide §§10–12 content | F6 wave 4 |
| `run --profile runbook` hosting the engine; `get_job` `evidence`; `mcp` not loading the agent core on a runbook node; cross-node `call:` step; `frontdoor/node.yaml` | F4 (program amendment §4.18) |
| `gui` in `mac/node.yaml` | F5 |
| `delegate` on gpu-box (§8.4 step 4) | unscheduled; a stub in F2 (D5) |
| Gated Hugging Face repos | Deferred (§13) |

## 3. Design

### 3.1 The `examples/` tree

```
examples/
  README.md                        # role → files table (§3.1.1); "every value here is invented"
  fleet/
    gpu-box/  node.yaml  service.json
    laptop/   node.yaml  service.json
    mac/      node.yaml  service.json
    web-01/   node.yaml  service.json
    frontdoor/README.md            # "stage 4 placeholder": no node.yaml until F4
  runbooks/
    site.status.yaml               # web-01, read   (R12)
    site.pull_and_restart.yaml     # web-01, unsafe
    server.reboot.yaml             # web-01, unsafe
    models.hf_download.yaml        # gpu-box, routine
    train.run.yaml                 # gpu-box, routine
    laptop.build_then_deploy.yaml  # laptop, routine (+ commented stage-4 hook)
  sudoers/
    king-louie-web-01              # one line per exact privileged command
  windows/
    runbook-acls.ps1               # -Role base|gpu-box|laptop -Runner <name>
  mcp/
    claude-desktop.windows.json    # command + args that pin the working directory (§3.6)
    claude-desktop.macos.json
  scripts/
    train.py                       # stdlib-only stand-in for the owner's training script
```

#### 3.1.1 Role → files

| Role | Profile | OS | Runbooks in `…/mcp/config/runbooks/` | Privilege file |
|---|---|---|---|---|
| `gpu-box` | agent | Windows | `models.hf_download`, `train.run` | `runbook-acls.ps1 -Role base`, then `-Role gpu-box` |
| `laptop` | agent | Windows | `laptop.build_then_deploy` | `runbook-acls.ps1 -Role base`, then `-Role laptop` |
| `mac` | agent | macOS | none (it is here for the install walk-through and F5) | — |
| `web-01` | runbook | Linux | `site.status`, `site.pull_and_restart`, `server.reboot` | `sudoers/king-louie-web-01` |
| `frontdoor` | (stage 4) | Linux | — | — |

The same map is `ROLE_RUNBOOKS` in `tests/examples.test.js`. The test fails if a listed
file is missing, or if a runbook in `examples/runbooks/` belongs to no role.

#### 3.1.2 Invented values (the only ones examples may use)

| Kind | Values |
|---|---|
| Hosts / URLs | `example.com` and subdomains (`www.`, `kl.`, `mcp.kl.`), `http://127.0.0.1:8080` |
| Linux paths | `/srv/site`, `/opt/king-louie/…`, `/etc/king-louie`, `/var/lib/king-louie`, `/usr/bin/*`, `/usr/sbin/shutdown` |
| macOS paths | `/opt/work`, `/opt/king-louie/…`, `/Library/Application Support/KingLouie/…`, `/usr/local/bin/node` |
| Windows paths | `D:\models`, `D:\datasets`, `D:\train`, `D:\ML Data`, `C:\build`, `C:\KingLouie\…`, `C:\Program Files\nodejs\…`, `C:\Program Files\Git\cmd\git.exe` |
| Accounts | `king-louie` (the Linux installer's default), `_kinglouie` (macOS `install --user`), `site` (the web app's user), `LOCAL SERVICE` / `*S-1-5-19`, placeholder `<runner>` |
| Service | `site.service` |
| HF repo in docs | `example-org/example-model` |

### 3.2 Runbook rules and decisions

All six runbooks are written against `validateRunbookDefinition`
(`src/runbooks/runbook-engine.js`) as it is on main.

**How steps run** (engine facts the examples and the guide depend on):

- Every step is spawned with `shell: false` in the working directory of the process
  that hosts the engine. In stage 2 that is the `mcp` process, and the engine has no
  per-step cwd.
- `timeout_s` applies to each step separately, not to the whole runbook.
- Steps run in order and stop at the first failure.

The examples are therefore cwd-independent: every program and every file argument is
absolute, and a program that needs a directory gets it from an argument
(`git -C`, `npm --prefix`) or `cd`s itself (`/srv/site/bin/build`). The guide pins the MCP
process cwd to an admin-owned, runner-readable work dir holding no secrets (§3.6).

**Rules:**

| Rule | Why |
|---|---|
| Every `argv[0]` is an absolute path, on every OS | For a bare name on Windows, libuv searches the process cwd before PATH, so a planted `git.exe` in the Claude project dir would run. The repo made the same fix for `powershell.exe`/`schtasks.exe` in `src/platform/windows-paths.js`. On Linux it removes PATH planting too |
| Every `string` pattern is anchored `^…$` and cannot start with `-` | The engine tests `new RegExp(p)` unanchored. A leading `-` would be argument injection (an option to the program), which parent §5.6 does not list |
| A value that becomes a file or folder name is a folder-name `string` under a fixed admin-chosen prefix, never a `path` param | A `path` param is accepted under *any* `allowed_roots` entry, and agent sessions and routine downloads write into those (§8, row 1) |
| `FOLDER_NAME` = `^(?!(?:[Cc][Oo][Nn]\|[Pp][Rr][Nn]\|[Aa][Uu][Xx]\|[Nn][Uu][Ll]\|[Cc][Oo][Mm][0-9]\|[Ll][Pp][Tt][0-9])$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` | no separators, no dots, no Windows device names |
| `REF_PATTERN` = `^(main\|release/[A-Za-z0-9][A-Za-z0-9._-]{0,39}\|v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$` (ruling **R13**) | rejects `pull/123/head` (a stranger's PR) and refspecs such as `main:refs/heads/x` |
| An argv element YAML could read as a number (`'-1'`, `'+1'`) is quoted | the engine rejects non-string argv. Other elements may stay plain |
| No `path` param has a `default`; every runbook has `rate_limit` | loading never realpaths an owner-specific root; everything is throttled |

**Design decisions** (the two §12 items the controller moved here):

- The Hugging Face CLI comes from `huggingface_hub[cli]` installed in an admin-owned venv
  at `C:\KingLouie\tools\py`, so `hf.exe` and `python.exe` have fixed absolute paths the
  runner cannot replace. No npm dependency is involved. The alternative, per-file `curl`
  against the HF HTTP API, needs one step per file, and a runbook cannot know the file
  list in advance.
- Linux paths assume a merged-`/usr` layout: `/usr/bin/git`, `/usr/bin/sudo`,
  `/usr/bin/systemctl`, `/usr/sbin/shutdown`. The guide tells owners on older layouts to
  edit the runbooks and the sudoers file together. `doctor` flags a mismatch.

**R12:** `site.status` (read tier) is added so that web-01 has one runbook that runs
over stdio before F3. Both unsafe runbooks are denied outright in F2 (D1).

### 3.3 The runbooks

```yaml
# examples/runbooks/site.status.yaml
name: site.status
description: Deployed commit, /healthz, then whether site.service is active (exit 3 = inactive, job fails).
tier: read
params: {}
steps:
  - run: [/usr/bin/git, -C, /srv/site, log, '-1', '--format=%H %cI %s']
  - check: { http_get: 'http://127.0.0.1:8080/healthz', expect_status: 200, retries: 1 }
  - run: [/usr/bin/systemctl, is-active, site.service]
timeout_s: 30
rate_limit: { max: 60, per: 1h }
```

The health check comes before `systemctl is-active`, so its evidence is recorded even
when the unit is inactive. `is-active` exits 3 when the unit is inactive, so a failed job
here means "the service is not active". The guide says so.

```yaml
# examples/runbooks/site.pull_and_restart.yaml
name: site.pull_and_restart
description: Fetch a ref, check it out detached, rebuild, restart site.service, confirm /healthz.
tier: unsafe   # changes production (parent Q4)
params:
  ref:
    type: string
    pattern: '^(main|release/[A-Za-z0-9][A-Za-z0-9._-]{0,39}|v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$'
    default: main
steps:
  - run: [/usr/bin/git, -C, /srv/site, fetch, --prune, origin, '{{ref}}']
  - run: [/usr/bin/git, -C, /srv/site, checkout, --detach, FETCH_HEAD]
  - run: [/srv/site/bin/build]   # owner's script: must cd /srv/site itself; non-zero on failure
  - run: [/usr/bin/sudo, -n, /usr/bin/systemctl, restart, site.service]
  - check: { http_get: 'http://127.0.0.1:8080/healthz', expect_status: 200, retries: 10 }
timeout_s: 600
rate_limit: { max: 6, per: 1h }
```

`fetch origin <ref>` followed by `checkout --detach FETCH_HEAD` treats a branch and a tag
the same way and never merges. The cost is that a force-pushed `main` deploys without
complaint. The guide recommends protecting `main` on the remote.

```yaml
# examples/runbooks/server.reboot.yaml
name: server.reboot
description: Reboot this machine in one minute.
tier: unsafe
params: {}
steps:
  - run: [/usr/bin/sudo, -n, /usr/sbin/shutdown, -r, '+1']
timeout_s: 30
rate_limit: { max: 2, per: 1d }
```

```yaml
# examples/runbooks/models.hf_download.yaml
# Prerequisite (§3.2): admin-owned venv C:\KingLouie\tools\py with huggingface_hub[cli].
name: models.hf_download
description: Download a public Hugging Face repo into D:\models\<dest>.
tier: routine
params:
  repo:     { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$' }
  revision: { type: string, pattern: '^(main|[0-9a-f]{40}|v[0-9]{1,4}(\.[0-9]{1,4}){0,2})$', default: main }
  dest:     { type: string, pattern: '<FOLDER_NAME>' }
steps:
  - run: ['C:\KingLouie\tools\py\Scripts\hf.exe', download, '{{repo}}', --revision, '{{revision}}', --local-dir, 'D:\models\{{dest}}']
timeout_s: 21600
rate_limit: { max: 10, per: 1h }
```

(`<FOLDER_NAME>` stands for the literal pattern from §3.2. The shipped file has the regex written out in full.)

```yaml
# examples/runbooks/train.run.yaml
name: train.run
description: Run D:\train\train.py with D:\train\configs\<config>.json (admin-owned configs only).
tier: routine
params:
  config:    { type: string, pattern: '<FOLDER_NAME>' }
  epochs:    { type: integer, min: 1, max: 1000, default: 1 }
  precision: { type: enum, values: [fp32, fp16, bf16], default: bf16 }
  resume:    { type: boolean, default: false }
steps:
  - run: ['C:\KingLouie\tools\py\Scripts\python.exe', 'D:\train\train.py', --config, 'D:\train\configs\{{config}}.json', --epochs, '{{epochs}}', --precision, '{{precision}}', '--resume={{resume}}']
timeout_s: 43200
rate_limit: { max: 4, per: 1d }
```

`config` names one of the admin-written files in `D:\train\configs`, which is
admin-owned with RX for the runner (§3.7). A routine caller therefore cannot choose a
file that it or `models.hf_download` wrote (§8 row 1).

`examples/scripts/train.py` stands in for the owner's training script:

- stdlib only;
- `json.load`s the config;
- writes only under the absolute `D:\train\runs\<config>\`;
- never uses cwd;
- loads no weights.

The guide states the rule for a real script. When `train.run` is routine, the script must
not load pickled weights or `trust_remote_code` models from `D:\models` (or any other
runner-writable root). A script that does must be run by an `unsafe` runbook.

```yaml
# examples/runbooks/laptop.build_then_deploy.yaml
name: laptop.build_then_deploy
description: Build and test a ref on this laptop. Deploying is web-01's own runbook (stage-4 hook below).
tier: routine   # local build of a closed ref set (§8 row 3); the deploy is unsafe on web-01
params:
  ref: { type: string, pattern: '<REF_PATTERN>', default: main }
steps:
  - run: ['C:\Program Files\Git\cmd\git.exe', -C, 'C:\build\site', fetch, --prune, origin, '{{ref}}']
  - run: ['C:\Program Files\Git\cmd\git.exe', -C, 'C:\build\site', checkout, --detach, FETCH_HEAD]
  - run: ['C:\Program Files\nodejs\node.exe', 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js', --prefix, 'C:\build\site', ci]
  - run: ['C:\Program Files\nodejs\node.exe', 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js', --prefix, 'C:\build\site', run, build]
  - run: ['C:\Program Files\nodejs\node.exe', 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js', --prefix, 'C:\build\site', test]
  # ---- stage-4 hook (fleet stage 4 adds a cross-node step kind) ----
  # Until then, the client calls run_runbook(web-01, site.pull_and_restart, {ref}) itself
  # after this job succeeds. Servers manage themselves: no SSH, no remote-host target.
  # - call: { machine: web-01, runbook: site.pull_and_restart, params: { ref: '{{ref}}' } }
timeout_s: 1800
rate_limit: { max: 12, per: 1h }
```

npm is run as `node.exe npm-cli.js --prefix <dir>` for two reasons:

- `npm.cmd` cannot be spawned with `shell: false`;
- there is no per-step cwd.

The guide says to edit the Git path if Git is installed elsewhere. F4 replaces the
marker line and the comment block below it with a real step.

### 3.4 Strict `node.yaml` (R11)

`src/service/node-config.js` gains the following:

```js
const NODE_YAML_KEYS = Object.freeze({
  top: Object.freeze(['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir']),
  policy: Object.freeze(['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']),
  remote_sessions: Object.freeze(['always_confirm', 'deny'])
});
module.exports = { loadNodeConfig, assertAdminOwned, NODE_CONFIG_FILE, NODE_YAML_KEYS };
```

**When the check runs.** Right after the parsed document is confirmed to be a mapping,
and before any per-key validation, `loadNodeConfig` checks the three levels in order:
`top`, then `policy`, then `policy.remote_sessions`. The last two are checked only when
present and a mapping. Otherwise the existing type errors apply.

**The error.** The first unknown key found throws through the existing `invalid()` helper:

```
Invalid <file>: unknown key "<dotted.path>" (known: <comma-separated list for that level>)
```

For example: `Invalid /etc/king-louie/node.yaml: unknown key "policy.allowed_root" (known: allowed_roots, remote_sessions, max_concurrent_jobs)`.

**What does not change.** A missing `node.yaml` still yields the defaults.

**Extension rule (program §5):**

- Each later stage appends its top-level key to `NODE_YAML_KEYS.top` in the same PR that
  parses the key, and validates the key's own subtree itself.
- F3 adds `approvers`, F4 adds `frontdoor` (`front_door` is already parsed by F2), and F5 adds `gui`.
- **Merge order with F3** (both edit this file in wave 1): whichever of F3 and F6 merges
  second rebases, and that PR makes sure `approvers` is in `NODE_YAML_KEYS.top`. If F3
  merges second, F3 appends it. If F6 merges second, F6 appends it while rebasing.
- A rebase that drops the key makes F3's own tests fail, because an `approvers:` block
  would then be rejected.

`doctor` needs no change for this. A rejected file already shows as the FAIL row
`node config / runbooks health (<message>)`.

**README.** Add `### node.yaml rejects unknown keys` under `## Breaking Changes`:

- a node that loaded before with a stray or misspelled key now refuses to start;
- `doctor` names the key;
- fix it by removing or correcting the key;
- why: a misspelled `always_confirm` used to fall back silently to the defaults.

### 3.5 `doctor` runbook checks

Module `src/service/doctor-runbooks.js`, pure Node:

```js
/** @returns {{check: string, ok: boolean, detail: string}[]} */
function checkRunbookCommands(runbooks /* engine.runbooks */, { platform, env, cwd, geteuid, spawnSync }) {}
/** Mirrors libuv: win32 bare name → cwd first, then each PATH dir, trying '', '.com', '.exe'. */
function resolveCommand(argv0, { platform, env, cwd }) {} // → { path: string|null, via: 'absolute'|'cwd'|'path'|null, cmdShim?: string }
module.exports = { checkRunbookCommands, resolveCommand };
```

`runDoctor` calls the check right after the `runbooks loaded` row. It passes its own
`platform` argument (not `process.platform`), plus `process.env`, `process.cwd()`,
`process.geteuid` and `child_process.spawnSync`, and appends the returned rows. That is
the only edit to `doctor.js`.

For each `run` step, deduplicated by (argv[0], argv), one row per problem:

| Case | Row |
|---|---|
| `argv[0]` contains `{{` | FAIL `runbook <n> step <i>: the program must be fixed, not a parameter` |
| win32, bare `argv[0]` | FAIL `… "<argv0>" is not an absolute path; Windows looks in the current directory (<cwd>) before PATH, so a planted <argv0>.exe would run. Use the full path` (+ `resolves to <path> via <via>` when found) |
| POSIX, bare `argv[0]` not on PATH | FAIL `… <argv0> is not on PATH` |
| absolute `argv[0]` missing / not executable (POSIX `X_OK`) | FAIL `… <argv0> not found` |
| win32, `argv[0]` ends `.cmd`/`.bat`, or the bare-name lookup only finds a `.cmd`/`.bat` shim | FAIL `… runbook steps run without a shell and cannot start .cmd/.bat files; call the .exe (npm: node.exe npm-cli.js)` |
| basename `sudo` on win32 | FAIL `… sudo steps run only on Linux and macOS` |
| `sudo` without `argv[1] === '-n'` / target `argv[2]` not absolute | FAIL `… sudo without -n would wait for a password` / `… sudo target must be absolute to match sudoers` |
| `sudo -n` step with a param lacking a default | ok `not checked: uses parameters without defaults` |
| euid 0 and any sudo step | one FAIL `sudo rules: run doctor as the service account (sudo -u <account> …)` |
| otherwise | `spawnSync(argv[0], ['-n', '-l', ...argv.slice(2) with defaults substituted], { timeout: 5000 })`. Exit 0 → ok `permitted: <argv>`. Anything else, including a timeout → FAIL `… not permitted by sudoers: <first stderr line>` |

When nothing fails, the function returns one ok row: `runbook commands present (<k> checked)`.
`sudo -l <cmd>` only lists; it never runs the command.

### 3.6 `docs/install-guide.md`

Headings are fixed. Wave 4 fills §§10–12 without renumbering.

```
# King Louie fleet install guide
## 1. What you are setting up
## 2. Before you start
## 3. Get the code and lock the install directory
## 4. Install the service
## 5. Write the config directories
## 6. Grant exact privileges
## 7. Check with doctor
## 8. Your first runbook over stdio MCP
## 9. Troubleshooting
## 10. Stage 3: Approving unsafe runbooks from your phone
## 11. Stage 4: Reaching the fleet through the front door
## 12. Stage 5: Desktop apps on agent nodes
```

§§10–12 hold one line each in wave 1: `Not available yet. This section is written when fleet stage N merges.`

What each section must say (accuracy items from R20):

- **§1** gives the roles table and what works in stage 2. Only the separate `mcp`
  instance runs runbooks. The installed service's `run --profile runbook` on web-01 does
  nothing yet; F4 makes it host the engine (program amendment §4.18). `delegate` is not
  available.
- **§2** lists the prerequisites:
  - Node ≥ 22.
  - Git, installed at `C:\Program Files\Git` on Windows (or edit the runbooks).
  - gpu-box: the venv from §3.2.
  - web-01: sudo and Claude Code installed on the server itself, because stage 2 has no
    remote path to web-01.
- **§3** gets the code to a system path: `/opt/king-louie/app` or `C:\KingLouie\app`,
  never under a home dir. Run `npm ci --omit=dev`. On Windows, run
  `runbook-acls.ps1 -Role base -Runner <runner>` **immediately**, before installing the
  service, so `C:\KingLouie` is locked from the start.
- **§4** installs the service, running `--dry-run` first:
  - Linux: `sudo node … install --profile runbook` on web-01.
  - macOS: create the standard account `_kinglouie` first, then `install --user _kinglouie`.
  - Windows: from an elevated shell.
- **§5** covers the two config dirs per node and what goes in each:

  | Dir | Files | Read by |
  |---|---|---|
  | service config: `/etc/king-louie`, `/Library/Application Support/KingLouie/config`, `%ProgramData%\KingLouie\config` | `service.json`, `node.yaml` | the installed service, `pair`, and from F4 on the runbooks it hosts |
  | MCP config: `/opt/king-louie/mcp/config`, `C:\KingLouie\mcp\config` | `node.yaml`, `runbooks/*.yaml` | the stdio `mcp` instance (stage 2's only runbook host) |

  Both `node.yaml` copies come from the same example, and they can drift apart. The guide
  says to edit one and copy it over the other, and to `diff` them after every edit.
  Owners and modes are set per OS (root `0755`/`0644`, or the ACL script).
- **§6** grants privileges:
  - sudoers via `visudo -cf` and then `install -m 0440`.
  - `runbook-acls.ps1 -WhatIf`, then run it for real.
  - The runner on Windows is the signed-in user who runs Claude. The ACLs only protect
    the admin-owned files while Claude runs unelevated.
  - When F4 moves runbooks into the service, `LOCAL SERVICE` will need the same grants.
- **§7** runs `doctor` against the MCP instance:
  - `doctor --data-dir C:\KingLouie\mcp\data` on Windows (as the runner);
  - `sudo -u king-louie … doctor --data-dir /opt/king-louie/mcp/data` on web-01;
  - plus plain `doctor` for the installed service.

  The section also shows sample output and what each FAIL means.
- **§8** sets up the stdio MCP instance. The server always starts in the admin-owned,
  runner-readable, non-secret work dir `<base>/mcp/work`, never in the data dir or a
  project dir:

  | OS | data dir (runner-owned, private) | config dir (admin-owned) | how cwd is pinned | runs as |
  |---|---|---|---|---|
  | Windows | `C:\KingLouie\mcp\data` | `C:\KingLouie\mcp\config` | `C:\Windows\System32\cmd.exe /d /c "cd /d C:\KingLouie\mcp\work && "C:\Program Files\nodejs\node.exe" C:\KingLouie\app\bin\king-louie-service.js mcp --data-dir C:\KingLouie\mcp\data"` | signed-in user |
  | macOS | `/opt/king-louie/mcp/data` | `/opt/king-louie/mcp/config` | `/bin/sh -c 'cd /opt/king-louie/mcp/work && exec /usr/local/bin/node /opt/king-louie/app/bin/king-louie-service.js mcp --data-dir /opt/king-louie/mcp/data'` | signed-in user |
  | Linux (web-01) | `/opt/king-louie/mcp/data` | `/opt/king-louie/mcp/config` | `sudo -u king-louie env --chdir=/opt/king-louie/mcp/work /usr/bin/node …` | `king-louie` |

  The config dir is `dirname(dataDir)/config`, as `adminConfigDir` resolves it for any
  non-default data dir. The master key falls back into the MCP data dir with a warning.
  That is expected for this instance, and the guide says so. The two
  `examples/mcp/claude-desktop.*.json` files carry the Windows and macOS commands. For
  Claude Code, the guide shows the same pair (`claude mcp add king-louie -- <command> <args…>`).
  "Try it" walks through `describe_machine`, then `run_runbook` on
  `laptop.build_then_deploy` or `site.status`, then `get_job`. It shows the
  untrusted-output wrapper and states that jobs die with the MCP process.
- **§9** is §9 of this spec, worded for owners.

### 3.7 Privilege files

**Sudoers** (`examples/sudoers/king-louie-web-01`; the file name has no dot because sudo skips such files in `sudoers.d`):

```
# Exactly the privileged commands in site.pull_and_restart and server.reboot.
king-louie ALL=(root) NOPASSWD: /usr/bin/systemctl restart site.service
king-louie ALL=(root) NOPASSWD: /usr/sbin/shutdown -r +1
```

**`examples/windows/runbook-acls.ps1`** declares:

- `[CmdletBinding(SupportsShouldProcess)] param([Parameter(Mandatory)][ValidateSet('base','gpu-box','laptop')] $Role, [Parameter(Mandatory)] $Runner, $Base = 'C:\KingLouie')`.
- It calls `icacls.exe` only as `$env:SystemRoot\System32\icacls.exe`.
- It refuses to run unelevated.
- It refuses a `$Runner` that `NTAccount.Translate` cannot turn into a SID.
- It is idempotent (`/grant:r`).

Each block is commented with the runbook it serves.

| Role | Target | ACL | Why |
|---|---|---|---|
| base | `$Base` | `/inheritance:r`; `SYSTEM`, `Administrators` F; `$Runner` RX | the runner can read the install but not change it |
| base | `$Base\app` | `*S-1-5-19` (LOCAL SERVICE) RX (inherits the rest) | the installed service can still read its code once inheritance is cut |
| base | `$Base\mcp\config`, `$Base\mcp\work` | inherit from `$Base` (admin F, runner RX) | admin-owned policy and a work dir the runner cannot plant into |
| base | `$Base\mcp\data` | `$Runner` M | the MCP instance's own data dir |
| gpu-box | `$Base\tools` | `/inheritance:r`; admin F; `$Runner` RX | `hf.exe` / `python.exe` cannot be replaced |
| gpu-box | `D:\models` | `$Runner` M | `models.hf_download` writes here |
| gpu-box | `D:\train`, `D:\train\configs` | `/inheritance:r` on each; admin F; `$Runner` RX | removes the inherited Authenticated Users Modify ACE, so `train.py` and the configs stay admin-owned |
| gpu-box | `D:\train\runs` | `$Runner` M | training output |
| laptop | `C:\build\site` | `$Runner` M | fetch and build |

## 4. Data formats

### 4.1 `node.yaml` per role

| Key | gpu-box | laptop | mac | web-01 |
|---|---|---|---|---|
| `name` | `gpu-box` | `laptop` | `mac` | `web-01` |
| `profile` | agent | agent | agent | runbook |
| `capabilities` | `[gpu, cuda, large-disk]` | `[build]` | `[apple-silicon]` | `[site]` |
| `policy.allowed_roots` | `D:\models`, `D:\datasets`, `D:\train`, `D:\ML Data` | `C:\build`, `C:\src` | `/opt/work` | `/srv/site` |
| `policy.remote_sessions` | F2 defaults written out | same | same | omitted |
| `policy.max_concurrent_jobs` | 2 | 1 | 2 | 1 |
| `runbooks_dir` | `runbooks` | `runbooks` | `runbooks` | `runbooks` |
| `front_door` | `# front_door: https://kl.example.com   # used from stage 4` (commented out; F2 already parses the key) | same | same | same |

`D:\ML Data` is the example of a root containing a space (§10.3 #2). Only keys in
`NODE_YAML_KEYS` appear.

### 4.2 `service.json` per role

```json
{
  "profile": "agent",
  "features": { "gateway": false, "webhooks": false, "mesh": false, "channels": false, "appDiscovery": false },
  "ports": { "gateway": 18793, "webhook": 18794 }
}
```

`web-01` sets `"profile": "runbook"`. `loadServiceConfig` today merges unknown feature names
without complaint. Under R55 F6 makes it reject an unknown `features.*` or `ports.*` key
with the same `Invalid <file>: unknown key "<path>" (known: …)` error as `node.yaml`
(one validation hunk in `src/service/config.js`, one test in `tests/service-config.test.js`
or the existing config test file). The examples test checks the key sets against
`DEFAULT_FEATURES` and `DEFAULT_PORTS` as well.

### 4.3 MCP client configs

```json
// examples/mcp/claude-desktop.windows.json  (a fragment for claude_desktop_config.json)
{ "mcpServers": { "king-louie": {
    "command": "C:\\Windows\\System32\\cmd.exe",
    "args": ["/d", "/c", "cd /d C:\\KingLouie\\mcp\\work && \"C:\\Program Files\\nodejs\\node.exe\" C:\\KingLouie\\app\\bin\\king-louie-service.js mcp --data-dir C:\\KingLouie\\mcp\\data"] } } }
```

The macOS file has the same shape, with `command` set to `/bin/sh` and the §3.6 `-c` string.

### 4.4 Test-only: the parsed-argv rewrite

Runbook e2e tests never edit YAML text. `prepareRunbook(file, rewrite)` in
`tests/helpers/example-fixture.js` does the rewriting on the parsed runbook:

1. `parseYaml` the example.
2. For each `run` step, if `argv[0]` is a key of `rewrite.programs`, replace it with
   `[process.execPath, <tmp>/fakes/<fake>.js]`. The rest of argv stays unchanged, so the
   sudo target `/usr/bin/systemctl` is recorded exactly as written.
3. For every other argv element, replace a leading key of `rewrite.prefixes` with its
   temp value.
4. For each `check`, replace a leading key of `rewrite.urls`.
5. Write `JSON.stringify(runbook)`, which is valid YAML, to `<tmp>/config/runbooks/<name>.yaml`.
6. Load it through the real `RunbookEngine.loadRunbooks()`.

The helper returns the set of keys it hit. Each test asserts that every key was hit at
least once, so an edited example cannot silently fall through to a real binary.

| Map | web-01 | laptop | gpu-box |
|---|---|---|---|
| programs | `/usr/bin/git`→git, `/usr/bin/sudo`→sudo, `/usr/bin/systemctl`→systemctl, `/srv/site/bin/build`→build | `C:\Program Files\Git\cmd\git.exe`→git, `C:\Program Files\nodejs\node.exe`→node | `…\hf.exe`→hf, `…\python.exe`→python |
| prefixes | `/srv/site`→`<tmp>/srv/site` | `C:\build\site`→`<tmp>/build/site`, `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`→`<tmp>/fakes/npm-cli.js` | `D:\models`→`<tmp>/ML Data/models`, `D:\train`→`<tmp>/ML Data/train` |
| urls | `http://127.0.0.1:8080`→`http://127.0.0.1:<port>` | — | — |

Each fake is a small Node script:

- It appends `{ fake, argv }` to `<tmp>/calls.jsonl`.
- If `<tmp>/fail/<fake>` exists, it prints that file's text to stderr and exits with the
  code on the file's first line.
- The `node` fake records `argv[0]` (the rewritten `npm-cli.js` path) and the args that follow.

## 5. Interfaces

### 5.1 Consumed

| From | What |
|---|---|
| F2 `runbook-engine.js` | `RunbookEngine({ runbooksDir, allowedRoots, adminUid, evidenceLedger, killGraceMs })`, `.loadRunbooks()`, `.runbooks`, `.validateParameters()`, `.executeRunbook()` |
| F2 `node-config.js` / `config.js` | `loadNodeConfig({ dataDir, adminConfigDir, geteuid, adminUid })`; `loadServiceConfig(dataDir, {}, { adminConfigDir, geteuid, adminUid })`, `DEFAULT_FEATURES`, `DEFAULT_PORTS` |
| F2 `stdio-server.js` | `StdioMcpServer({ nodeConfig, runbookEngine, stdin, stdout })` |
| F2 `evidence-ledger.js` | in-memory `EvidenceLedger`, `.status(root).freshEvents` |
| F2 `mesh-identity.js` | `MeshIdentity.generateTlsCertificate(id)` (self-signed test server) |
| `src/platform/windows-paths.js` | `windowsPowerShellExe()` (ACL-script parse test) |
| F3 (when merged) | the fake-phone signer named in F3's spec, for the `todo` test in §10.2 |

### 5.2 Produced

| Name | Shape | Consumers |
|---|---|---|
| `NODE_YAML_KEYS` (export of `src/service/node-config.js`) | `{ top, policy, remote_sessions }`, frozen string arrays | F3 (`approvers`), F4 (`frontdoor`), F5 (`gui`); `tests/examples.test.js` |
| Unknown-key error text | `Invalid <file>: unknown key "<path>" (known: …)` | owners, `doctor`, F7 UI |
| `checkRunbookCommands(runbooks, { platform, env, cwd, geteuid, spawnSync })` | `{check, ok, detail}[]` | `runDoctor` |
| `resolveCommand(argv0, { platform, env, cwd })` | `{ path, via, cmdShim? }` | F7 |
| `tests/helpers/stdio-mcp-client.js` `connectStdioMcp(options)` | `{ server, request(id, method, params), callTool(name, args), waitForJob(id, statuses), close() }` | F3, F4 tests. `tests/mcp-stdio.test.js` keeps its own `connect` and is not migrated here |
| `tests/helpers/example-fixture.js` `prepareRunbook`, `makeFakes`, `readCalls` | §4.4 | F3 flips the `todo`; F4 reuses it for cross-node tests |
| `tests/helpers/example-denylist.js` `ALLOWED_HOSTS`, `scanForPersonalValues(text)` | §10.1 #6 | any stage that adds docs or examples |
| Guide headings `## 10.`–`## 12.`; the stage-4 marker line | exact text | F6 wave 4, F4 |

## 6. Configuration

No new settings keys, env vars, `node.yaml` keys or `service.json` keys. R11 narrows
what `node.yaml` accepts. Every security-relevant example file is meant for an
admin-owned config dir. The guide never puts `node.yaml`, runbooks or `service.json` in a
data dir or a work dir.

## 7. Host wiring

| File | Touch |
|---|---|
| `src/service/node-config.js` | `NODE_YAML_KEYS` const + export; one unknown-key check before per-key validation (§3.4) |
| `src/service/doctor.js` | one `require('./doctor-runbooks')` + one `results.push(...checkRunbookCommands(...))` after `runbooks loaded` |
| `README.md` | `### Fleet setup and examples` at the end of `## Running as a Service`; `### node.yaml rejects unknown keys` under `## Breaking Changes` |
| `CLAUDE.md` | append `## Examples`: everything in `examples/` is invented; the tests load it through the real loaders; new values must pass `tests/helpers/example-denylist.js` |
| `package.json` | `build.files` gains `"!examples/**"` |
| `create-core.js`, `settings.js`, IPC, `renderer.js`, `cli.js`, `tools/index.js` | none |

## 8. Security and trust

| Risk | What stops it |
|---|---|
| **Routine chain to code execution on gpu-box.** A compromised front door (stage 4) or an injected client runs `hf_download(attacker/repo, dest=x)` and then points training at `D:\models\x` (pickles, `trust_remote_code`), with no phone signature. This breaks parent §11's "routine stays harmless" | `train.run.config` is a folder name that resolves only inside admin-owned `D:\train\configs`, so a routine caller cannot supply a config. The guide's script rule (§3.3): a routine training script loads nothing executable from a runner-writable root. The test asserts `train.run`'s argv contains no parameter that resolves under `D:\models` |
| Parameter reaches a shell or becomes an option | argv only; anchored patterns with no leading `-`; folder names without separators. The test fuzzes every string param (§10.1 #3) |
| Stranger's PR ref built or deployed | `REF_PATTERN` (R13) |
| **`laptop.build_then_deploy` runs repository code** (`npm ci` lifecycle scripts, build, tests) at routine tier | acceptable only because the ref set is closed to the owner's own `main`, `release/*` and `vX.Y.Z` on the owner's remote. Whoever can push those already controls the code. The guide warns that widening the pattern makes the runbook `unsafe` |
| Program planted in the cwd or on PATH | absolute `argv[0]` everywhere (test + `doctor`); the MCP cwd pinned to an admin-owned work dir |
| Runner replaces `hf.exe`, `python.exe`, `train.py` or a config | `runbook-acls.ps1` (§3.7), with inheritance cut where Authenticated Users would inherit Modify. This holds only while Claude runs unelevated, and the guide says so |
| Sudo grants more than the runbooks use | the test asserts the sudoers lines are exactly the set of `sudo -n` argv tails |
| `hf_download` fills the disk | rate limit 10/h. This stays inside the routine ceiling and is documented |
| Owner "fixes" git's dubious-ownership refusal with `safe.directory=*` | the guide makes `/srv/site` owned by `king-louie`, with `site.service` running as `site` with read-only access, and forbids the wildcard |
| A misspelled policy key silently falls back to defaults | R11 strict loader |
| Examples leak an owner's details | denylist test (§10.1 #6) |

Trust principle 3 is unaffected. Both unsafe runbooks are denied over MCP until F3,
and the test asserts that.

## 9. Error handling

| Situation | Behaviour | Owner sees |
|---|---|---|
| Unknown or misspelled `node.yaml` key | the node refuses to load (`mcp` exits at startup, the service refuses to start) | `Invalid …: unknown key "policy.allowed_root" (known: …)`; `doctor` FAIL row |
| `sudo -n` rule missing | step exits 1, job `failed`, rest skipped | `sudo: a password is required` in output; `doctor`: `not permitted by sudoers` |
| git refuses the update (local changes in `/srv/site`, checkout blocked) | step 2 exits 128, no build, no restart | git's `error: … would be overwritten`; the guide says to run `git -C /srv/site status` as `king-louie` |
| `check` against a self-signed/untrusted HTTPS cert | TLS error swallowed; after `retries`, job `failed`; evidence `failed` | `Check step N result: FAILED` / `did not return 200` with no TLS reason (D7). The guide says to use loopback HTTP or a trusted cert |
| `hf.exe` missing | spawn `ENOENT`, job `failed` | `spawn C:\KingLouie\tools\py\Scripts\hf.exe ENOENT`; `doctor`: `not found` |
| MCP process cwd unreadable by the runner (e.g. `sudo -u king-louie` from an admin's home) | every step fails to spawn, or the engine throws on `process.cwd()` | job `failed` with an `EACCES`/`ENOENT` error naming the directory. The guide's §8 commands pin the work dir, and §9 names this symptom |
| `.cmd`/`.bat` or bare program on win32 | spawn `EINVAL`/`ENOENT`, or the planted binary runs | `doctor` FAIL naming the fix |
| `systemctl is-active` → 3 in `site.status` | job `failed` after the health check ran | output `inactive`; evidence from the check is present |
| Space in an allowed root or argv path | passed as one argument | nothing (pinned by a test) |
| Two `node.yaml` copies drift | the service and the MCP instance enforce different policy | the guide's `diff` step; `doctor` on both |
| MCP client disconnects mid-job | `mcp` exits; the child may be orphaned (Windows) or killed | the guide says long jobs need F4; keep the session open |

## 10. Testing

All tests use `node --test`, and every one runs on every OS unless marked otherwise. Pass = `# fail 0`.

### 10.1 `tests/examples.test.js`

1. **Load.** For each role with a `node.yaml`, copy `node.yaml`, `service.json` and the
   role's runbooks into `mkdtemp()/config`. Set `0755` dirs and `0644` files explicitly.
   Load them with `loadNodeConfig({ …, adminUid: euid })`, `loadServiceConfig` and
   `RunbookEngine(…).loadRunbooks()`. Assert that the name, the runbook count and the
   tiers match §3.1.1. Assert the key sets: `node.yaml` is covered by the strict loader
   itself, using the imported `NODE_YAML_KEYS`; `service.json` is checked against §4.2.
2. **Shape.**
   - Every step is exactly one of `run` or `check`.
   - Every `argv[0]` is absolute by `path.win32.isAbsolute || path.posix.isAbsolute` and
     contains no `{{`.
   - Every string pattern starts with `^` and ends with `$`.
   - No `path` params exist in the examples (D3). Every runbook has `rate_limit`.
   - No argv element of `train.run` starts with `D:\models`, `D:\datasets` or `D:\ML Data`.
3. **Injection.** For every string param, `validateParameters` rejects:
   `x;id`, `$(id)`, `` `id` ``, `../x`, `a∕b`, `a／b`, `a\u0000b`, `-oProxyCommand=x`,
   `main\n`, `a b`, `''`, a 200-character value, `ｍａｉｎ`, `CON`, `nul`, and `a.b`
   (folder names only). It accepts the default and one valid sample.
4. **Sudoers.**
   - The set of `king-louie ALL=(root) NOPASSWD: (.+)` lines equals the set of
     `argv.slice(2).join(' ')` over web-01's `sudo -n` steps.
   - `visudo -cf` exits 0. The test tries `/usr/sbin/visudo` and then PATH, and skips if
     neither exists.
5. **ACL script.** The script:
   - contains `SupportsShouldProcess`, a mandatory `$Runner`, `/inheritance:r` for
     `$Base`, `$Base\tools`, `D:\train` and `D:\train\configs`, and `*S-1-5-19` on
     `$Base\app`;
   - names no literal account other than `SYSTEM`, `Administrators` and `*S-1-5-19`.

   On win32 it must parse with zero errors through
   `windowsPowerShellExe()` running `[System.Management.Automation.Language.Parser]::ParseFile`.
6. **Denylist.** `scanForPersonalValues` runs over `examples/**` and `docs/install-guide.md`:
   - **Emails:** anything not ending `@example.com` or `.example.com`. `git@<allowed host>` is exempt.
   - **IPv4:** anything outside `127.0.0.0/8`, `0.0.0.0`, `192.0.2.0/24`, `198.51.100.0/24`
     and `203.0.113.0/24`.
   - **Home paths:** `/home/<x>/`, `/Users/<x>/` (except `Shared`), `C:\Users\<x>\`
     (except `Public`, `Default`) and `~<name>/`. Segments written as `<…>` placeholders
     are exempt.
   - **URL hosts:** anything not in `ALLOWED_HOSTS`, matched exactly or as a
     `.example.com` suffix. `ALLOWED_HOSTS` = `example.com`, `localhost`, `127.0.0.1`,
     `huggingface.co`, `nodejs.org`, `git-scm.com`, `www.python.org`, `python.org`,
     `claude.ai`, `code.claude.com`, `docs.anthropic.com`, `www.sudo.ws`,
     `learn.microsoft.com`, `github.com`.
   - **Phone-like `\+\d{8,}`:** anything outside `+15550100`–`+15550199`.

   Must-fail fixtures: `evil-example.com`, `example.com.evil.net`, `someone@mail.test`,
   `10.1.2.3`, `/home/alice/`, `C:\Users\bob\`, `+442071234567`.
   Must-pass fixtures: `example.com`, `kl.example.com`, `mcp.kl.example.com`,
   `192.0.2.10`, `+15550100`, `/home/<user>/`, `git@github.com`.
7. **Guide and hook.**
   - The §3.6 headings exist verbatim.
   - The stage-4 marker exists while no uncommented `call:` step does.
   - `examples/mcp/*.json` parse, and each sets the `…\mcp\work` / `/opt/king-louie/mcp/work` cwd.

### 10.2 `tests/examples-e2e.test.js` (every OS; parsed-argv rewrite, §4.4)

Setup:

- temp tree and fakes;
- a `/healthz` server on `127.0.0.1:0`;
- an in-memory `EvidenceLedger`, read at `status(process.cwd())`;
- `killGraceMs: 200`;
- `connectStdioMcp({ nodeConfig, runbookEngine })`.

| Test | Asserts |
|---|---|
| web-01 describe | `site.status` (read), `site.pull_and_restart` (unsafe), `server.reboot` (unsafe), with params |
| `site.status` via MCP | `queued` → `succeeded`. Calls are `git … log`, then `systemctl is-active site.service`. `output.untrusted_output === true`. Evidence `runbook:site.status` `passed` |
| pull / reboot via MCP (F2) | `status: 'denied'`, `reason` starts `denied_by_policy`, and `calls.jsonl` is empty (D1) |
| `todo` (F3) | `awaiting_approval` → the fake phone signs → `succeeded`, with the calls of the next row |
| pull, approved path | `engine.executeRunbook('site.pull_and_restart', {ref:'main'})` → success. Calls in order: `git -C <tmp>/srv/site fetch --prune origin main`, `git … checkout --detach FETCH_HEAD`, `build`, `sudo -n /usr/bin/systemctl restart site.service`. Evidence `passed` |
| reboot, approved path | `sudo -n /usr/sbin/shutdown -r +1` |
| laptop via MCP | `run_runbook(laptop, laptop.build_then_deploy, {ref:'release/2.1'})` → `succeeded`. Calls in order: git fetch (ref `release/2.1`), git checkout, then node calls with `--prefix <tmp>/build/site` and `ci`, `run build`, `test` |
| gpu-box via MCP | `models.hf_download {repo:'example-org/example-model', dest:'example'}` → argv ends `--local-dir <tmp>/ML Data/models\example` as **one** element. `train.run {config:'base'}` → one element `<tmp>/ML Data/train\configs\base.json`, then `--epochs 1 --precision bf16 --resume=false` |
| every map key hit | `prepareRunbook`'s returned set covers every key in §4.4 |

### 10.3 The five conditions the parent is silent on

| # | Condition | Pinned by |
|---|---|---|
| 1 | `sudo -n` not configured | e2e: `fail/sudo` holds `1` and `sudo: a password is required`. The job fails at step 4, there is no evidence entry, and stderr is in the logs. `doctor-runbooks`: fake `sudo -l` exits 1 → FAIL naming the command |
| 2 | Windows path with a space in `allowed_roots` | `examples`: gpu-box loads with `D:\ML Data`. On win32, a real `isPathUnderRoots('<tmp>\ML Data\x.json', ['<tmp>\ML Data'])` holds. The e2e's gpu-box row passes a spaced path as one argv element on every OS |
| 3 | `check` against a self-signed cert | e2e: an HTTPS server from `MeshIdentity.generateTlsCertificate`, with `site.status`'s url rewritten to it → `failed`, `Check step 2 result: FAILED`, evidence `failed` |
| 4 | `hf` CLI missing | `doctor-runbooks`: absolute `argv[0]` absent → FAIL `not found`. e2e: `hf.exe` rewritten to a missing `<tmp>` path → job `failed` with `ENOENT` |
| 5 | git refuses the update | e2e: `fail/git` on `checkout` (128, `error: Your local changes … would be overwritten`) → fails at step 2, and no `build`/`sudo` call is recorded |

**Also covered:**

- `tests/node-config-strict.test.js`: an unknown key at each of the three levels is
  rejected with the exact message; every example still loads; a typo'd file makes
  `runDoctor` return the FAIL row.
- `tests/doctor-runbooks.test.js`:
  - win32 bare name, simulated with `platform: 'win32'`, a temp cwd holding `git.exe` and
    a temp PATH. `resolveCommand` returns `via: 'cwd'`, and the row is a FAIL.
  - A `.cmd`-only shim.
  - `sudo` without `-n`, and a relative sudo target.
  - A placeholder `argv[0]`.
  - euid 0.
  - A `spawnSync` timeout.

## 11. Deviations from the parent

| # | Parent/dispatch says | Code/program requires | Resolution |
|---|---|---|---|
| D1 | unsafe runbook → `awaiting_approval` → phone | F2 creates the job as `denied` | the test asserts `denied`; F3 flips the `todo` |
| D3 | §8.4: `dest` "must be under `D:\models`"; §5.4 shows `path` params | `path` is checked against *all* `allowed_roots`, and there are no per-param roots | `dest` and `config` are folder names under fixed admin prefixes. No example uses `path`, because every example root is runner-writable and a `path` param would let a routine caller pick a file another routine job or agent session wrote. The guide explains when `path` is safe: only when the program treats the file as inert data |
| D4 | §5.5: the stdio server serves "this node" | `mcp` builds a full core on its `--data-dir`, runs as the invoking user, and reads the service key only as root | a separate MCP instance per node (§3.6); F4 moves runbooks into the service |
| D5 | §8.4 gpu-box step 4 uses `delegate` | `delegate` throws in F2 | documented; no example depends on it |
| D6 | §8.4: "the result includes that evidence" | `get_job` has no evidence field | tests read the injected ledger; F4 adds the field |
| D7 | §5.4 check URL `https://www.example.com/healthz` | the engine drops the TLS reason, and a public URL behind a CDN does not prove this box restarted | loopback HTTP |
| D8 | §5.4 reboot message `'king-louie: remote reboot'` | exact-command sudoers would need `:` escaped | message dropped |
| D9 | §5.4: `doctor` checks sudoers | not in F2 | §3.5 |
| D10 | §5.4 `ref` pattern `^[A-Za-z0-9._/-]{1,64}$` | R13 | `REF_PATTERN` |
| D11 | §8.4 `train.run(config: ...)` implies any config file | R20 (Critical 2) | admin-owned `D:\train\configs\<name>.json` |

## 12. Assumptions made without asking

- Each node gets its own MCP instance at `<base>/mcp/{data,config,work}`. *Alt:* on Windows and macOS, share the service's config dir via a sibling data dir.
- `laptop.build_then_deploy` is `routine`, and the deploy is web-01's `unsafe` runbook. *Alt:* make it `unsafe`, which would leave it unrunnable over MCP until F3.
- Pulls use `fetch <ref>` + `checkout --detach FETCH_HEAD`. *Alt:* `merge --ff-only` on a deploy branch, which refuses force-pushes but handles tags awkwardly.
- The MCP cwd is pinned through a `cmd.exe /d /c` or `/bin/sh -c` wrapper. *Alt:* a `cwd` key in the client config, which not every MCP client honours.
- macOS uses `/usr/local/bin/node` (the nodejs.org installer's location). *Alt:* Homebrew's `/opt/homebrew/bin/node`, which the guide mentions as the edit to make.

## 13. Deferred

| Item | Stage |
|---|---|
| Guide §§10–12; the MCP-path approval test | F6 wave 4 / F3 |
| `run --profile runbook` hosting jobs that survive the client; `get_job` evidence; `mcp` without the agent core on runbook nodes; the real `call:` step; `frontdoor/node.yaml` + `service.json` | F4 (§4.18) |
| `gui` in `mac/node.yaml` and a GUI example | F5 |
| TLS error reason in `check` results | small engine follow-up; not F6's file |
| Gated HF models (token from the node vault) | after F3 (`Vault(*)` is `always_confirm`) |
| Strict unknown-feature rejection in `service.json` | not covered by R11; a controller decision |
| `doctor` checking Windows config-dir ACLs (`assertAdminOwned` is a no-op on win32) | stage-1 follow-up |

## 14. Dependencies (npm)

None. The HF download uses the external `hf` CLI from `huggingface_hub`, a documented
prerequisite outside npm. An npm HF client was rejected because runbook steps are argv
only and the engine has no in-process step kind. Tests use `node:test`, `node:http`,
`node:https`, `node:child_process` and existing modules.

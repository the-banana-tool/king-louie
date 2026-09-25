# King Louie fleet examples

Every value in this directory is invented. Hosts are `example.com` and its
subdomains, the machines are `gpu-box`, `laptop`, `mac` and `web-01`, and the
paths are the ones [the install guide](../docs/install-guide.md) uses. Copy a
role's files, then change what differs on your machines.

`tests/examples.test.js` loads every file here through the real loaders, and
`tests/examples-e2e.test.js` runs every runbook here with its programs faked.
An example that drifts from the code fails the test suite instead of your
install.

## Roles

| Role | Profile | OS | Runbooks to install in `…/mcp/config/runbooks/` | Privilege file |
|---|---|---|---|---|
| `gpu-box` | agent | Windows | `models.hf_download`, `train.run` | `windows/runbook-acls.ps1 -Role base`, then `-Role gpu-box` |
| `laptop` | agent | Windows | `laptop.build_then_deploy` | `windows/runbook-acls.ps1 -Role base`, then `-Role laptop` |
| `mac` | agent | macOS | none (install walk-through; fleet stage 5 adds desktop apps) | — |
| `web-01` | runbook | Linux | `site.status`, `site.pull_and_restart`, `server.reboot` | `sudoers/king-louie-web-01` |
| `frontdoor` | (stage 4) | Linux | — | — |

## Layout

```
fleet/<role>/node.yaml       node name, profile, capabilities, policy
fleet/<role>/service.json    profile, listeners (all off), ports
fleet/frontdoor/README.md    stage 4 placeholder
runbooks/*.yaml              the six runbooks
sudoers/king-louie-web-01    the exact privileged commands web-01's runbooks run
windows/runbook-acls.ps1     the Windows ACLs gpu-box and laptop need
mcp/*.json                   Claude Desktop configs that start the stdio MCP server
scripts/train.py             a stand-in for your own training script
```

## Rules every runbook here follows

- Every program (`argv[0]`) is an absolute path. A step starts with no shell,
  in the working directory of the process that runs it. On Windows a bare
  name is looked up in that directory before `PATH`.
- Every `string` parameter has a pattern anchored with `^…$` that cannot
  start with `-`, so a value can never become an option.
- A value that ends up as a file or folder name is a plain folder name under
  a fixed, administrator-chosen folder, never a `path` parameter.
- Every runbook has a `rate_limit`.
- `unsafe` runbooks are denied over MCP until fleet stage 3 brings phone
  approval.

# The front door

The front door is the one machine the fleet is reached through from outside.
It runs King Louie with `profile: frontdoor` on a small Linux VPS and answers on
one port, 443, for two names:

- `mcp.kl.example.com`: MCP clients (OAuth 2.1, then Streamable HTTP at `/mcp`),
  the phone app, and nodes while they pair;
- `mesh.kl.example.com`: the nodes' own links, which only a pinned node
  certificate can open.

It runs no agent, no tools and no runbooks. Every node keeps its own policy,
and anything unsafe still needs a fresh signature from your phone.

## DNS

Create A (and AAAA, if the VPS has IPv6) records for both names:

```
mcp.kl.example.com.   300  IN  A     203.0.113.10
mesh.kl.example.com.  300  IN  A     203.0.113.10
```

With ACME (the default), an optional CAA record limits who may issue
certificates for the names, down to your ACME account:

```
kl.example.com.  300  IN  CAA  0 issue "letsencrypt.org; accounturi=<your ACME account URL>"
```

Use the account URL your ACME directory assigned to the front door's account.

## Firewall

- Allow 443/tcp from anywhere.
- Allow SSH only from the addresses you administer from (or use the
  provider's console and allow no SSH at all).
- Deny everything else. Port 80 is not needed: certificates are issued with
  TLS-ALPN-01 on 443.

## Upgrades and the clock

- Turn on unattended security upgrades (`unattended-upgrades` on Debian and
  Ubuntu).
- Run `chrony` (or another NTP client). Grants, pairings and challenges
  expire on the front door's clock, and certificates are only as good as it.

## Install

Linux only. As root, from a checkout or package of King Louie:

```sh
king-louie-service install --profile frontdoor
```

The unit runs as the `king-louie` service user with
`AmbientCapabilities=CAP_NET_BIND_SERVICE` (and nothing else), so it can bind
443 without root. Then write `/etc/king-louie/node.yaml`:

```yaml
name: frontdoor
profile: frontdoor
frontdoor:
  domain: kl.example.com
  listen: { host: 0.0.0.0, port: 443 }
  acme: { email: admin@example.com, terms_agreed: true }
  oauth:
    scopes_enabled: [fleet:read, fleet:run, fleet:unsafe, fleet:delegate]
```

and `/etc/king-louie/service.json` with `"profile": "frontdoor"` and every
feature off (see `examples/fleet/frontdoor/`). `terms_agreed: true` accepts the
ACME directory's subscriber agreement; Let's Encrypt production is the default
directory. With your own certificate instead, replace `acme` with
`tls: { cert_file: /etc/king-louie/tls/mcp.pem, key_file: /etc/king-louie/tls/mcp.key }`.

To let MCP clients read cases on agent machines, also list `cases:read` in
`scopes_enabled`. It shows case lists, briefs, open questions and
orientation, including private facts, through `list_cases`, `open_case` and
`get_orientation`. The front-door case tools are read-only for now: no
front-door client can answer a case question, and `cases:write` is not a
scope the front door knows, so listing it stops the front door at startup.

Start it and watch the first certificate arrive:

```sh
systemctl restart king-louie.service
king-louie-service doctor
```

`doctor` says `waiting for ACME` until the certificate is issued.

## Bootstrap

A fresh front door trusts no phone and no node. The order is:

1. **Your first phone, from the console.** On the front door, as root:

   ```sh
   king-louie-service frontdoor enroll-device
   ```

   It shows a QR code. Scan it in the King Louie app, compare the fingerprint
   the console prints with the one the app shows, and answer `y`. The app now
   pins the front door's key.

2. **Your first node, from both consoles.** On the front door:

   ```sh
   king-louie-service frontdoor code gpu-box --confirm
   ```

   On `gpu-box`, as its administrator, with its service stopped:

   ```sh
   king-louie-service pair https://mcp.kl.example.com
   ```

   Type the code. `pair` prints the front door's fingerprint (compare it with
   the phone app) and the front door's console prints the node's fingerprint:
   answer `y` on both when they match what the other side shows. Start the
   node's service; it links to `mesh.kl.example.com` with the pin it wrote to
   its `front-door.json`.

3. **Later nodes, from the phone.** In the app (Nodes), ask for a code for
   `web-01`, run `king-louie-service pair https://mcp.kl.example.com` on
   `web-01`, and approve it in the app.

`king-louie-service frontdoor nodes` lists the nodes, where each came from
(`console` or `phone`), whether it is online, and its fingerprint.
`king-louie-service frontdoor remove-node web-01` removes a console-confirmed
node; a phone-confirmed one is removed in the app.

## Connecting a client

Point the MCP client at `https://mcp.kl.example.com/mcp`. It registers, opens a
consent page with a six-character code, and waits (the wait page sets a
per-grant cookie, so opening the link for two different clients in the same
browser does not overwrite one flow with the other). Type that code in the app
(Connect a client), choose the scopes and machines, and approve with your
biometric. The app lists connected clients and revokes them.

## Re-pinning

The phone pins the `mcp.` key, so the key survives certificate renewals.

- With ACME, `king-louie-service frontdoor rotate-tls-key` issues a certificate
  for a new key and publishes a signed re-pin; phones pick it up the next
  time they open.
- With your own certificate, replace the files, restart (or `SIGHUP`) the
  service, then show phones the new pin with `king-louie-service relay qr`.

The front door keeps only the newest signed re-pin. A phone that missed two
rotations (it pins key A; A was rotated to B, then B to C) sees a re-pin from
B, not from A, and refuses it: it tells you to scan a new relay code
(`king-louie-service relay qr`). That is the safe failure; nothing is
trusted on the way.

`SIGHUP` also re-reads the admin approvers directory and the console node
records before the certificate, so an approver revoked, or a node record
removed by hand, while the service was stopped takes effect (and is audited)
without a full restart.

## doctor

On the front door, `doctor` checks the startup rules, that a phone is
enrolled, the last self-probe (DNS for both names, `mcp.` and `mesh.` both
reaching this machine), the certificate's days left (FAIL below 21), the unit's
`CAP_NET_BIND_SERVICE`, that no node or grant record failed verification,
that no audit break is unacknowledged, and the clock against the ACME
directory (FAIL above 30 s).

A node or grant record that fails verification, or a break in the audit
mirror (a fork, a truncation, a replayed page, and so on), stays flagged until
you acknowledge the alert on your phone; `doctor` keeps reporting it in the
meantime and the failure text names what to check.

Acknowledging a break clears `doctor`'s row, not the mirror: that node's
mirror stays `broken` (the phone's node list shows `audit: broken`), and
its recorded breaks are kept as evidence. If you know why the node's ledger
changed (for example, you reinstalled it with the same key, so its ledger
started again and the mirror saw a truncation), reset that node's mirror:
stop the service, move `<dataDir>/frontdoor/mirror/<node_id>/` somewhere
safe (it is the only copy of what the mirror held), and start the service.
The next sync takes a fresh anchor from the node.

On a node with a `front-door.json`, `doctor` checks that the pin file is
admin-owned and that the certificate `mesh.kl.example.com` serves is the one
pinned. If DNS for `mesh.` points somewhere else, the node refuses to send a
byte and says so in its log once an hour.

## Security notes

- **Runbook jobs vs. delegate jobs.** A runbook job is visible (readable,
  watchable) to any grant with `fleet:read` on the machine it ran on, and any
  grant with `fleet:run` there can cancel it. A delegate job (an agent session's turn) is visible only to the grant
  that started it — another client's `fleet:read` on the same machine will
  not show it or let it touch it.
- **Delegate sessions and unsafe calls.** A delegate session a node started on
  its own (not through the front door) sends its unsafe calls to the phone for
  approval, exactly like an unsafe runbook. A front-door client needs
  `fleet:unsafe` for that node before any of its delegate turns can request an
  unsafe call there, and the phone still decides each one; without it, the
  call is refused outright rather than forwarded to the phone.
- **The MCP client pins nothing beyond WebPKI.** Unlike the phone and the
  nodes, an MCP client does not pin the front door's key: it trusts whatever
  certificate authority your OS or client library trusts. Controlling DNS for
  `mcp.<domain>` plus a certificate from any CA a client trusts is enough to
  intercept a client that does not pin on its own. The self-probe only checks
  the front door's own view of itself (that `mcp.` and `mesh.` still resolve
  here and serve the certificates it expects); it cannot detect interception
  happening elsewhere on a client's path.
- **Bash still bypasses the case write guard.** A delegate session with
  `fleet:delegate` can run an agent turn with Bash, and Bash can rewrite a
  case's `facts.jsonl` directly — a stage-1 gap the write guard (which covers
  Write, Edit and MultiEdit) does not close. Grant `fleet:delegate` only to
  clients you would trust with a full agent session.

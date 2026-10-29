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
- Upgrade the front door and every node before the Android app. The app
  reads with its read key (`docs/protocol/approval-v1.md`, "Revised
  2026-10-28: the read key"), and a front door from before that answers
  `404` to it: the app then asks you to upgrade the relay and does not fall
  back to asking for a fingerprint on every read.
- A phone paired before the read key existed sends it once, after the
  upgrade (one row in its Approvals list, two fingerprints). The front door
  uses it at once; each node stages it, and the node's administrator applies
  it with `king-louie-service device apply`, which prints the device and the
  read key's fingerprint (`r-…`) and asks `[y/N]`. Until a node has applied
  it, keeping a computer-use lease on that node going needs a fingerprint
  (the app offers it), since the node does not accept the phone's read-key
  watches yet.

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

A `listen.port` other than 443 (another server already holds 443 on the host,
say) is carried in every URL the front door hands out: the phone's QR, `pair`
on the nodes and MCP clients all use `https://mcp.kl.example.com:<port>`, and
nodes link to `wss://mesh.kl.example.com:<port>`. Built-in ACME answers
TLS-ALPN-01, which the CA only tries on 443, so on another port use `tls:`
files instead of `acme`.

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

3. **Later nodes, from the phone.** In the app, ask for a code for
   `web-01` (on Android, the Scanner's Get a code tab; on iPhone, Nodes),
   run `king-louie-service pair https://mcp.kl.example.com` on `web-01`, and
   approve the node pairing in the app.

`king-louie-service frontdoor nodes` lists the nodes, where each came from
(`console` or `phone`), whether it is online, and its fingerprint.
`king-louie-service frontdoor remove-node web-01` removes a console-confirmed
node; a phone-confirmed one is removed in the app.

## Connecting a client

Point the MCP client at `https://mcp.kl.example.com/mcp`. It registers, opens a
consent page with a six-character code, and waits (the wait page sets a
per-grant cookie, so opening the link for two different clients in the same
browser does not overwrite one flow with the other). Type that code in the app
(on Android, "Or type a code" on the Scanner's Scan a code tab, which adds
the request to the Approvals list, where tapping it opens the scopes; on
iPhone, Connect a client), choose the scopes and machines, and approve with your
biometric. The app lists connected clients and revokes them (on Android,
under Settings).

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

## Push notifications

Optional. Without push the app checks the front door only while it is open.
With it, an Android phone (the `fcm` build) gets a notification when a node
asks for something, and when a computer-use session or take ends (unless
that phone stopped it) or pauses because no phone was watching. A push
carries a kind, an id, the node's name and at most a count; the phone
fetches the rest with its read key and shows only what a node signed. iPhone
push (APNs) is unchanged. The Firebase steps and the app build are in the
install guide's "Push to your phone" part (section 10); this is the front
door's half.

The credential is a Google service-account JSON key of your own Firebase
project, for a dedicated account with the single role "Firebase Cloud
Messaging API Admin" (never the project's default Admin SDK account). It
lives outside the data dir, so no import, backup or `doctor` output carries
it. Copy it to the host directly (`scp`), then, as root:

```sh
install -d -o root -g king-louie -m 0750 /etc/king-louie/push
install -o root -g king-louie -m 0640 kl-push.json /etc/king-louie/push/fcm-service-account.json
rm kl-push.json
```

On the front door the `relay` block of `/etc/king-louie/service.json` holds
only `push`:

```json
"relay": { "push": { "fcm": { "service_account_file": "/etc/king-louie/push/fcm-service-account.json" } } }
```

The path must be absolute. The file is read once, at start: the service
refuses to start when it is missing or unreadable, is not JSON, or lacks
`type: service_account` or a string `project_id`, `client_email` or
`private_key` (the refusal names the path and the field, never a value from
the file). `SIGHUP` does not re-read it; restart after changing it.

```sh
systemctl restart king-louie.service
king-louie-service doctor
king-louie-service relay push-test
```

`doctor`'s `push` row names the senders and, for FCM, the file, its
`project_id`, that it is owned `root` with the service's group (the data
dir's), mode `0640`, in a `0750` directory, and the last send and last
failure the running service recorded in `<dataDir>/relay/push-status.json`
(time, sender, HTTP status; never a token or a device id). A wrong owner or
mode, a file that does not parse or an unreadable status file fails the row;
a last send that was not a 2xx is a warning. With no push configured the row
says `none (the app checks only while open)`, which is not a failure.

`relay push-test [--device <device-id>]` runs as root, with the service
running or not. It reads the credential and the device list (changing
neither) and sends one test push to each phone with an `fcm` token, or to the
named one, printing each device's id and name with `sent` or the HTTP status
(never a token). It exits 0 only when every push went out, else 1. The phone
shows "Test notification from frontdoor" (the `name` in `node.yaml`). That
tells "no credential" (the command says so), "no token" (open the app on the
phone: it sends its token at every start) and "Android blocks
notifications" (the phone's gear screen says so) apart. A token FCM no
longer knows is dropped by the running service at its next push.

Rotating the key: add a new JSON key to the same service account, replace
the file as above, restart, check with `relay push-test`, then delete the old
key in the Cloud console. A new Firebase project means a new app build and
new tokens; the front door drops each old token at its first
`SENDER_ID_MISMATCH`.

## doctor

On the front door, `doctor` checks the startup rules, that a phone is
enrolled, the last self-probe (DNS for both names, `mcp.` and `mesh.` both
reaching this machine), the certificate's days left (FAIL below 21), the unit's
`CAP_NET_BIND_SERVICE`, that no node or grant record failed verification,
that no audit break is unacknowledged, push (see Push notifications), and
the clock against the ACME directory (FAIL above 30 s).

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

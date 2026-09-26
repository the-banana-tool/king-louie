# phone-agent executor

A King Louie executor for a phone agent behind a generic HTTP errands API
(`openapi.yaml`). King Louie hands it approved call jobs, polls their status
and saves each call record under the case's `sources/phone-agent/`.

## Install (desktop)

1. Copy this folder to `<data directory>/executors/phone-agent/`. The packaged
   app does not load executors from anywhere else.
2. Store the provider token in the vault under a key of your choice, for
   example `errands-token`.
3. Add the entry to `settings.executors.entries`:

   ```json
   {
     "phone-agent": {
       "kind": "external-agent",
       "package": "phone-agent",
       "packageSha256": "",
       "config": { "baseUrl": "https://errands.example.com", "token": "${vault:errands-token}" },
       "constraints": { "contactsPerDay": 20, "callingWindow": { "tz": "America/Chicago", "start": "09:00", "end": "17:00", "weekdays": [1, 2, 3, 4, 5] } },
       "cost": { "perJob": 0.5, "perContact": 0.25, "perAttempt": 0.4 },
       "latency": "async-hours"
     }
   }
   ```

4. Open the executor list (`executors:list`). It shows
   `pin required: set packageSha256 to <hash>`; copy that hash into
   `packageSha256`. Any later change to a file in this folder makes the
   executor unavailable until you pin the new hash.

## Install (service)

Put the folder under a directory listed in the admin `service.json`
`executors.packageRoots` (root-owned), and the entry under the admin
`service.json` `executors.entries`. Entries in the data directory are ignored.

## Trust

The adapter runs inside King Louie with full privileges; there is no sandbox.
It is given only its config (with the token resolved from the vault) and a
`fetch` limited to `baseUrl`'s origin, but code in this folder could still
reach the network or disk directly. The protections are the load root, the
required pin and that the `Skill` tool cannot reach executor packages. Read
the code before you pin it.

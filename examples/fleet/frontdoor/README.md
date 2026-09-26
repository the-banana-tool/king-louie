# frontdoor

The front door is the one machine the fleet can be reached through from
outside: `https://mcp.kl.example.com/mcp` for MCP clients and
`mesh.kl.example.com` for the nodes' pinned links. It runs
`king-louie-service` with `profile: frontdoor` on a small Linux VPS and
listens on 443 only.

`node.yaml` and `service.json` here are the admin files for that machine.
Setup, DNS, firewall and the bootstrap order (enroll a phone, then pair the
first node at the console) are in `docs/fleet/front-door.md`. Every listener
feature stays off in `service.json`: the front door's one listener is
configured in `node.yaml` under `frontdoor.listen`.

Nodes do not name the front door in their `node.yaml`; each pairs once with
`king-louie-service pair https://mcp.kl.example.com`, which writes
`<configDir>/front-door.json`.

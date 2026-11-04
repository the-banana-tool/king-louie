# The desktop window always attaches to a node; standalone mode is retired

King Louie's unit of deployment is the node: a service that runs as the owner on a desktop (personal
hosting, to come on macOS and Linux as it exists on Windows) or as a service account on a headless
server, holding the vault, the chats, the cases and the agent loop. The Electron app is a client of a
node and nothing more: on first run it installs and starts a local personal node, moves any standalone
profile it finds into it (one backed-up `import --from`), and attaches; through the front door it can
attach to any other node of the fleet as a phone-approved OAuth client, one node at a time, with the
whole window carried over the desktop-bridge protocol. The standalone core (`main.js` building a
`createCore` of its own) stays only as a development mode and is to be removed. The alternative kept
until now, a standalone app beside a service, left the owner with two King Louies on one machine (two
vaults, cases moved by hand, the Lot 69 move) and a window that could reach nothing but loopback; the
costs accepted are a first run that installs a logon service, a one-time migration, and that a window
with no node can show nothing (2026-11-03, grilling session Q7, Q8, Q14, Q16, Q22, Q23).

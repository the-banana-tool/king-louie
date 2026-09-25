# frontdoor (stage 4 placeholder)

The front door is the one machine the fleet can be reached through from
outside, at `https://kl.example.com`. It arrives with fleet stage 4, which adds
`node.yaml` and `service.json` here and fills section 11 of
[the install guide](../../../docs/install-guide.md).

Until then there is nothing to install for this role. The other nodes keep
`front_door` commented out in their `node.yaml`.

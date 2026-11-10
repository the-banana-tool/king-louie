'use strict';

// Tool results carry no tool_call_id, so they pair with the calls by order.
module.exports = Object.freeze({
  id: 'open-swe-traces',
  source: 'open-swe-traces',
  prefix: 'os-',
  datasetId: 'nvidia/Open-SWE-Traces',
  needsConfig: true,
  columns: { repo: 'repo', instanceId: 'instance_id', trajectoryId: 'trajectory_id', messages: 'messages', license: 'license' },
  pairBy: 'order'
});

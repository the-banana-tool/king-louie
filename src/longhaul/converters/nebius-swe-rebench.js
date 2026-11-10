'use strict';

// Tool results carry tool_call_id; the dataset has no per-row license.
module.exports = Object.freeze({
  id: 'nebius-swe-rebench',
  source: 'openhands',
  prefix: 'nr-',
  datasetId: 'nebius/SWE-rebench-openhands-trajectories',
  needsConfig: false,
  columns: { repo: 'repo', instanceId: 'instance_id', trajectoryId: 'trajectory_id', messages: 'trajectory', license: null },
  pairBy: 'id'
});

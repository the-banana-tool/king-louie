// src/cases/executors/duplicates.js
// The duplicate-job gate (R36) is owned by src/cases/gates.js (cases stage
// 5). This module keeps stage 3's import path and names.
const gates = require('../gates');

module.exports = {
  normIntent: gates.normIntent,
  jobSignature: gates.jobSignature,
  findDuplicateJob: gates.findDuplicateJob,
  localJobSignature: gates.jobSignature,
  localFindDuplicateJob: gates.findDuplicateJob
};

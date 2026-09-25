// src/cases/case-types/general.js
// The default case type: no extras, gating questions or material fields.
module.exports = {
  type: 'general',
  orientationExtras: () => '',
  gatingQuestions: () => [],
  materialFields: () => []
};

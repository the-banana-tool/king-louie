// src/cases/case-types/outreach.js
// Contacting people to get something (quotes, answers). No extras in stage 5;
// C4 and C6 add behaviour through contact policy and playbooks.
module.exports = {
  type: 'outreach',
  orientationExtras: () => '',
  gatingQuestions: () => [],
  materialFields: () => []
};
